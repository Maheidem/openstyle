# EG2 vocabulary ranking test: audio query vs text queries.
# Reads Openstyle data read-only. Keeps transcript text in memory only.
# Writes: $SILVER_WORK/experiments/eg2rank/{vocab_notes_used.json, results.json} (numbers only;
# vocab_notes_used.json holds the vocabulary terms, so it stays outside the repo).
import json, os, re, sqlite3, sys, time, resource, wave
from collections import Counter
import numpy as np, torch
from sentence_transformers import SentenceTransformer
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import silver_paths as P  # noqa: E402

OUT = P.work_dir("experiments", "eg2rank")
BASE = P.PROFILE
DB = f"file:{BASE}/freestyle.db?mode=ro"
WIN_S, SR, MAX_MEET, KS = 22.5, 16000, 10, (10, 20)
LINE = re.compile(r"^\*\*\[(\d+(?::\d+){1,2})\]\s*([^*]+?):\*\*\s*(.*)$")

con = sqlite3.connect(DB, uri=True)
vocab = con.execute("select term, coalesce(notes,'') from vocabulary order by id").fetchall()
terms = [t for t, _ in vocab]
NT = len(terms)
pats = [re.compile(r"(?<!\w)" + re.escape(t) + r"(?!\w)", re.I) for t in terms]
notes_src = {t: ("db" if n.strip() else "claude") for t, n in vocab}
assert all(v == "db" for v in notes_src.values()), "empty notes found; script needs manual notes"
json.dump([{"term": t, "notes": n, "source": notes_src[t]} for t, n in vocab],
          open(f"{OUT}/vocab_notes_used.json", "w"), ensure_ascii=False, indent=1)

def ts(s):
    p = [int(x) for x in s.split(":")]
    return p[0] * 60 + p[1] if len(p) == 2 else p[0] * 3600 + p[1] * 60 + p[2]

def parse(path):
    out = []
    for ln in open(path, encoding="utf-8"):
        m = LINE.match(ln.strip())
        if m:
            out.append((ts(m.group(1)), "mic" if m.group(2).strip() == "Me" else "system", m.group(3)))
    return out

def term_ids(text):
    return {i for i, p in enumerate(pats) if p.search(text)}

# ---- pick meetings
cands = []
for mid in os.listdir(f"{BASE}/meetings"):
    d = f"{BASE}/meetings/{mid}"
    need = ["mic.wav", "system.wav", "transcript-enhanced.md"]
    if not all(os.path.exists(f"{d}/{f}") for f in need) or os.path.exists(f"{d}/system.squeezed.wav"):
        continue
    lines = parse(f"{d}/transcript-enhanced.md")
    occ = sum(len(p.findall(tx)) for _, _, tx in lines for p in pats)
    cands.append((occ, mid, lines))
cands.sort(reverse=True)
eligible = len(cands)
chosen = cands[:MAX_MEET]

# ---- model
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = SentenceTransformer("google/embeddinggemma-2", device=dev,
                            model_kwargs={"torch_dtype": torch.bfloat16},
                            config_kwargs={"vision_config": None})

def enc_text(xs, prompt):
    return model.encode(xs, prompt_name=prompt, convert_to_numpy=True, batch_size=16).astype(np.float32)

def norm(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)

D = {"bare": norm(enc_text(terms, "document")),
     "notes": norm(enc_text([f"{t} — {n}" for t, n in vocab], "document"))}

def read_wav(p):
    w = wave.open(p)
    assert w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == SR
    return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0

# ---- windows + audio embeddings (all windows; M7-M9 need them)
W = []          # one dict per window
lat, meet_info, title_q = [], [], {}
for occ, mid, lines in chosen:
    title, ctx = con.execute("select calendar_title, context from meetings where id=?", (mid,)).fetchone() or (None, None)
    if title and title.strip():
        title_q[mid] = norm(enc_text([title + ("\n" + ctx if ctx else "")], "query")[0])
    for ch in ("mic", "system"):
        audio = read_wav(f"{BASE}/meetings/{mid}/{ch}.wav")
        n = int(np.ceil(len(audio) / (WIN_S * SR)))
        for i in range(n):
            a, b = int(i * WIN_S * SR), int(min((i + 1) * WIN_S * SR, len(audio)))
            if b - a < 2 * SR:
                continue
            txt = " ".join(tx for t, c, tx in lines if c == ch and i * WIN_S <= t < (i + 1) * WIN_S)
            t0 = time.perf_counter()
            v = model.encode([{"audio": {"array": audio[a:b], "sampling_rate": SR}}], convert_to_numpy=True)[0]
            dt = time.perf_counter() - t0
            if b - a == int(WIN_S * SR):
                lat.append(dt)
            assert np.isfinite(v).all()
            W.append(dict(mid=mid, ch=ch, i=i, text=txt, ref=term_ids(txt), a=norm(v.astype(np.float32))))
        del audio
    meet_info.append(dict(mid=mid[:8], occurrences=occ, has_title=mid in title_q))

# ---- whole-meeting audio queries (M7 neighbor, M8 meeting, M9 segment)
by_mc = {}
for w in W:
    by_mc.setdefault((w["mid"], w["ch"]), []).append(w)
adj_stats, seg_counts = {}, {}
for mid in {w["mid"] for w in W}:
    mw = [w for w in W if w["mid"] == mid]
    mq = norm(np.mean([w["a"] for w in mw], axis=0))
    adj = []
    for ch in ("mic", "system"):
        seq = by_mc.get((mid, ch), [])
        adj += [float(seq[k]["a"] @ seq[k + 1]["a"]) for k in range(len(seq) - 1)]
    thr = np.percentile(adj, 25)
    adj_stats[mid[:8]] = dict(mean=round(float(np.mean(adj)), 4), std=round(float(np.std(adj)), 4),
                              p25=round(float(thr), 4), min=round(float(np.min(adj)), 4),
                              max=round(float(np.max(adj)), 4), n_pairs=len(adj))
    nseg = 0
    for ch in ("mic", "system"):
        seq = by_mc.get((mid, ch), [])
        segs, cur = [], [0]
        for k in range(len(seq) - 1):
            if float(seq[k]["a"] @ seq[k + 1]["a"]) < thr:
                segs.append(cur); cur = []
            cur.append(k + 1)
        segs.append(cur)
        nseg += len(segs)
        for s in segs:
            sq = norm(np.mean([seq[k]["a"] for k in s], axis=0))
            for k in s:
                seq[k]["seg"] = sq
        for k, w in enumerate(seq):
            w["nb"] = norm(np.mean([seq[j]["a"] for j in range(max(0, k - 1), min(len(seq), k + 2))], axis=0))
            w["meet"] = mq
            w["prev_text"] = seq[k - 1]["text"] if k > 0 and seq[k - 1]["i"] == w["i"] - 1 else None
    seg_counts[mid[:8]] = nseg

# ---- evaluation
E = [w for w in W if w["ref"]]
g_centroid = norm(np.mean([w["a"] for w in W], axis=0))
crng = np.random.default_rng(7)
for w in E:
    w["title"] = title_q.get(w["mid"])
    # control C1: audio of a far window (>=5 away) in the same meeting and channel
    far = [x for x in by_mc[(w["mid"], w["ch"])] if abs(x["i"] - w["i"]) >= 5]
    w["shuf"] = far[crng.integers(len(far))]["a"] if far else None
    w["glob"] = g_centroid
# text queries for evaluated windows
same = enc_text([w["text"] for w in E], "query")
prev_idx = [k for k, w in enumerate(E) if w["prev_text"]]
prev = enc_text([E[k]["prev_text"] for k in prev_idx], "query") if prev_idx else np.zeros((0, 768))
for k, w in enumerate(E):
    w["same"] = norm(same[k])
for j, k in enumerate(prev_idx):
    E[k]["prev"] = norm(prev[j])

def metrics(ranks_refs):
    r = {f"recall@{k}": [] for k in KS}; mrr = []
    for order, ref in ranks_refs:
        pos = {t: p for p, t in enumerate(order)}
        for k in KS:
            r[f"recall@{k}"].append(sum(pos[t] < k for t in ref) / len(ref))
        mrr.append(1.0 / (1 + min(pos[t] for t in ref)))
    out = {k: round(float(np.mean(v)), 4) for k, v in r.items()}
    out["MRR"] = round(float(np.mean(mrr)), 4); out["n_windows"] = len(mrr)
    return out

def query(w, m):
    if m == "M1_audio": return w["a"]
    if m == "M2_prev_text": return w.get("prev")
    if m == "M3_title": return w["title"]
    if m == "M4_same_text": return w["same"]
    if m == "M6_audio+title": return None if w["title"] is None else norm(w["a"] + w["title"])
    if m == "M7_neighbor": return w["nb"]
    if m == "M8_meeting": return w["meet"]
    if m == "M9_segment": return w["seg"]
    if m == "C1_shuffled_audio": return w["shuf"]
    if m == "C2_global_audio_centroid": return w["glob"]

METHODS = ["M1_audio", "M2_prev_text", "M3_title", "M4_same_text", "M6_audio+title",
           "M7_neighbor", "M8_meeting", "M9_segment", "C1_shuffled_audio", "C2_global_audio_centroid"]
freq = Counter(t for w in E for t in w["ref"])
top5 = {t for t, _ in freq.most_common(5)}
rng = np.random.default_rng(42)
res = {}
for var, Dm in D.items():
    for m in METHODS:
        rr, rr_ex = [], []
        for w in E:
            q = query(w, m)
            if q is None:
                continue
            order = list(np.argsort(-(Dm @ q)))
            rr.append((order, w["ref"]))
            if w["ref"] - top5:
                rr_ex.append((order, w["ref"] - top5))
        res[f"{m}|{var}"] = metrics(rr)
        res[f"{m}|{var}"]["recall@20_excl_top5"] = metrics(rr_ex)["recall@20"] if rr_ex else None
rr = [(list(rng.permutation(NT)), w["ref"]) for w in E]
rr_ex = [(o, ref - top5) for o, ref in rr if ref - top5]
res["M5_random|empirical"] = metrics(rr)
res["M5_random|empirical"]["recall@20_excl_top5"] = metrics(rr_ex)["recall@20"]
res["M5_random|expected"] = {f"recall@{k}": round(k / NT, 4) for k in KS}

# ---- precision parity check: MPS bf16 vs CPU fp32 on 3 real clips (in memory)
cpu = SentenceTransformer("google/embeddinggemma-2", device="cpu",
                          model_kwargs={"torch_dtype": torch.float32}, config_kwargs={"vision_config": None})
mid0 = chosen[0][1]; aud = read_wav(f"{BASE}/meetings/{mid0}/system.wav")
clips = [aud[int(s * SR):int((s + WIN_S) * SR)] for s in (60, 300, 600)]
v_mps = norm(model.encode([{"audio": {"array": c, "sampling_rate": SR}} for c in clips], convert_to_numpy=True, batch_size=1))
v_cpu = norm(cpu.encode([{"audio": {"array": c, "sampling_rate": SR}} for c in clips], convert_to_numpy=True, batch_size=1))
parity = [round(float(x), 5) for x in np.sum(v_mps * v_cpu, axis=1)]

summary = dict(
    env=dict(device=dev, dtype="bfloat16", torch=torch.__version__,
             transformers=__import__("transformers").__version__,
             sentence_transformers=__import__("sentence_transformers").__version__),
    eligible_meetings=eligible, meetings_used=len(chosen), meetings=meet_info,
    windows_total=len(W), windows_eval=len(E),
    windows_eval_by_channel=dict(Counter(w["ch"] for w in E)),
    m2_skipped=len(E) - len(prev_idx),
    m3_windows=sum(w["title"] is not None for w in E),
    top10_ref_terms=[(terms[t], c) for t, c in freq.most_common(10)],
    top5_excluded=[terms[t] for t in top5],
    distinct_ref_terms=len(freq), ref_terms_per_window=round(float(np.mean([len(w["ref"]) for w in E])), 3),
    notes_source=dict(Counter(notes_src.values())),
    audio_latency_s=dict(mean=round(float(np.mean(lat)), 4), median=round(float(np.median(lat)), 4),
                         p95=round(float(np.percentile(lat, 95)), 4), n=len(lat)),
    peak_rss_gb=round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9, 2),
    mps_driver_alloc_gb=round(torch.mps.driver_allocated_memory() / 1e9, 2) if dev == "mps" else None,
    adjacent_audio_cos=adj_stats, segments_per_meeting=seg_counts,
    mean_segments_per_meeting=round(float(np.mean(list(seg_counts.values()))), 2),
    parity_mps_bf16_vs_cpu_fp32=parity,
    results=res)
json.dump(summary, open(f"{OUT}/results.json", "w"), indent=1, ensure_ascii=False)
print(json.dumps({k: v for k, v in summary.items() if k != "results"}, indent=1, ensure_ascii=False))
print(f"{'method|variant':28s} r@10   r@20   MRR    n    r@20-ex5")
for k, v in res.items():
    print(f"{k:28s} " + " ".join(f"{v.get(x, ''):<6}" for x in ("recall@10", "recall@20", "MRR", "n_windows", "recall@20_excl_top5")))
