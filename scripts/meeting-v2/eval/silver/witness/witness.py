"""Local ASR witnesses (H1, H2, H3) + app.json + context.json per meeting.

Usage: python3 -I witness.py <id8,...>   (meetings in the order given; pnpm meeting:silver:witness <id8,...>)
Reads the real DB read-only and the meeting wavs read-only (OPENSTYLE_PROFILE).
Writes $SILVER_CORPUS/<id8>/{app,context,h1,h2,h3}.json (mode 600). Temp wavs go to $SILVER_WORK/witness-tmp.
context.json owner_name: the app setting owner_name when the DB has it, else env SILVER_OWNER_NAME, else null.
Takes the GPU lock (runtime.mts convention). Prints counts, ids and seconds only.
"""
import json, os, re, selectors, shutil, sqlite3, subprocess, sys, time, wave
from datetime import datetime, timezone

import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

TMP = os.path.join(P.WORK, "witness-tmp")
CORPUS = P.CORPUS
PROFILE = P.PROFILE
DB = P.APP_DB
WORKER = P.WORKER
HF_HOME = P.HF_HOME
QWEN = "mlx-community/Qwen3-ASR-1.7B-8bit"
WHISPER = "mlx-community/whisper-large-v3-turbo"
CTX_TERMS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ctxterms.mts")
LOCK = P.GPU_LOCK
QUEUE = P.GPU_QUEUE

PROMPT_BUDGET = 900
MIN_BIAS_MS = 3000
CONTEXT_GAP_MAX_MS = 30000
CONTEXT_TAIL_CHARS = 200
QWEN_LANG = {"en": "English", "pt": "Portuguese", "es": "Spanish", "de": "German", "fr": "French", "it": "Italian"}
CHUNK_TIMEOUT_S = 600


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------- GPU lock (same convention as scripts/meeting-v2/eval/runtime.mts) ----------
HELD = None
QLINE = None


def take_lock():
    global HELD, QLINE
    QLINE = f"witness-corpus asr 240 {datetime.now(timezone.utc).isoformat()} pid={os.getpid()}"
    with open(QUEUE, "a") as f:
        f.write(QLINE + "\n")
    waited = 0
    while True:
        lines = [l for l in open(QUEUE).read().split("\n") if l.strip()]
        first_live = None
        for l in lines:
            m = re.search(r" (\d{4}-\d{2}-\d{2}T[^ ]+) ", l)
            if m:
                try:
                    t = datetime.fromisoformat(m.group(1).replace("Z", "+00:00"))
                    if (datetime.now(timezone.utc) - t).total_seconds() > 7200:
                        continue
                except ValueError:
                    pass
            first_live = l
            break
        if first_live == QLINE:
            try:
                os.mkdir(LOCK)
                break
            except FileExistsError:
                pass
        if waited >= 3600:
            raise SystemExit("GPU lock wait exceeded 60 min")
        log(f"GPU lock: waiting ({waited}s)")
        time.sleep(180)
        waited += 180
    HELD = f"witness-corpus asr {datetime.now().strftime('%H:%M')} pid={os.getpid()}"
    with open(os.path.join(LOCK, "owner"), "w") as f:
        f.write(HELD + "\n")
    unqueue()
    log(f"GPU lock taken (waited {waited}s)")
    return waited


def unqueue():
    global QLINE
    if QLINE and os.path.exists(QUEUE):
        kept = [l for l in open(QUEUE).read().split("\n") if l != QLINE]
        open(QUEUE, "w").write("\n".join(kept))
    QLINE = None


def release_lock():
    global HELD
    if HELD:
        try:
            owner = open(os.path.join(LOCK, "owner")).read().strip()
        except OSError:
            owner = ""
        if owner == HELD:
            shutil.rmtree(LOCK, ignore_errors=True)
            log("GPU lock released")
        HELD = None
    unqueue()


# ---------- worker ----------
class Worker:
    def __init__(self, model):
        self.model = model
        env = dict(os.environ, HF_HOME=HF_HOME, HF_HUB_OFFLINE="1")
        env.pop("OPENSTYLE_LOG_DIR", None)
        self.err = open(os.path.join(TMP, f"worker-{model.split('/')[-1]}.log"), "w")
        self.p = subprocess.Popen([WORKER, "--model", model], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=self.err, env=env, text=True, bufsize=1)
        self.sel = selectors.DefaultSelector()
        self.sel.register(self.p.stdout, selectors.EVENT_READ)
        self.next_id = 1

    def transcribe(self, path, language, context=None):
        rid = self.next_id
        self.next_id += 1
        msg = {"id": rid, "type": "transcribe", "audio_path": path, "audio_format": "wav"}
        if language:
            msg["language"] = language
        if context:
            msg["context"] = context
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        deadline = time.time() + CHUNK_TIMEOUT_S
        while True:
            left = deadline - time.time()
            if left <= 0:
                raise RuntimeError("chunk timeout")
            if not self.sel.select(timeout=left):
                continue
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError(f"worker exited rc={self.p.poll()}")
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("id") != rid:
                continue
            if "error" in r:
                raise RuntimeError(str(r["error"])[:200])
            return (r.get("text") or "").strip()

    def close(self):
        try:
            self.p.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
            self.p.stdin.flush()
            self.p.wait(timeout=30)
        except Exception:
            self.p.kill()
            self.p.wait()
        self.err.close()


# ---------- text helpers (ports of packages/stt/src/text.ts) ----------
def normalize(t):
    t = re.sub(r"[^\w\s]", "", t.lower())
    t = t.replace("_", "")
    return re.sub(r"\s+", " ", t).strip()


def similarity(a, b):
    ta = set(normalize(a).split())
    tb = set(normalize(b).split())
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def is_context_echo(text, context):
    nt = normalize(text)
    words = nt.split()
    if len(words) < 3:
        return False
    cw = normalize(context).split()
    if not cw:
        return False
    n = len(words)
    for i in range(0, len(cw) - n + 1):
        if cw[i:i + n] == words:
            return True
    for k in range(4, min(len(cw), n) + 1):
        ref = " ".join(cw[-k:])
        if nt == ref or nt.startswith(ref + " "):
            return True
    return similarity(text, context) >= 0.8


def context_tail(text):
    t = text.strip()
    if len(t) <= CONTEXT_TAIL_CHARS:
        return t
    cut = len(t) - CONTEXT_TAIL_CHARS
    s = t[cut:]
    if not t[cut - 1].isspace():
        m = re.search(r"\s", s)
        if m:
            return s[m.start() + 1:]
    return s


def combine_prompt(bias, ctx):
    ctx = ctx.strip()
    if not ctx:
        return bias
    part = context_tail(ctx)
    if not part:
        return bias
    if not bias:
        return part
    budget = PROMPT_BUDGET - len(part) - 1
    terms = bias
    if len(terms) > budget:
        s = terms[:budget]
        i = s.rfind(", ")
        terms = s[:i] if i >= 0 else s
    return f"{terms} {part}"


TERMS_MARKER = re.compile(r"\b(?:technical\s+)?terms:\s*", re.I)


# ---------- DB ----------
def db():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def merge_terms(ctx_terms, vocab):
    by = {}
    for v in vocab:
        k = v.strip().lower()
        if k and k not in by:
            by[k] = v.strip()
    out, used = [], set()
    for t in ctx_terms:
        t = t.strip()
        k = t.lower()
        if not t or k in used:
            continue
        used.add(k)
        out.append(by.get(k, t))
    for v in vocab:
        k = v.strip().lower()
        if not k or k in used:
            continue
        used.add(k)
        out.append(v.strip())
    return out


def derive_name(email):
    if not email or "@" not in email:
        return None
    parts = email.split("@")[0].split(".")
    if len(parts) == 2 and all(p.isalpha() and len(p) >= 2 for p in parts):
        return " ".join(p[:1].upper() + p[1:].lower() for p in parts)
    return None


def write_private(path, obj):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    json.load(open(path))  # read back


# ---------- audio ----------
FRAME = 320  # 20 ms at 16 kHz


def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def write_slice(pcm, start_ms, end_ms, path):
    a = pcm[int(start_ms * 16):int(end_ms * 16)]
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(a.tobytes())
    os.chmod(path, 0o600)


def gap_chunks(pcm, app):
    """Regions outside the app chunks with speech-like energy."""
    n = len(pcm) // FRAME
    if n == 0:
        return []
    fr = pcm[:n * FRAME].astype(np.float32).reshape(n, FRAME)
    db_ = 20 * np.log10(np.sqrt((fr ** 2).mean(axis=1)) / 32768 + 1e-9)
    floor = np.percentile(db_, 10)
    speech = db_ > max(floor + 15, -55)
    covered = np.zeros(n, bool)
    for c in app:
        a = max(0, int((c["startMs"] - 300) / 20))
        b = min(n, int((c["endMs"] + 300) / 20) + 1)
        covered[a:b] = True
    cand = speech & ~covered
    idx = np.flatnonzero(cand)
    if len(idx) == 0:
        return []
    runs, s, p = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - p > 50 or covered[p:i].any():
            runs.append((s, p))
            s = i
        p = i
    runs.append((s, p))
    out = []
    for s, e in runs:
        if cand[s:e + 1].sum() < 25:
            continue
        s2, e2 = max(0, s - 15), min(n - 1, e + 15)
        while s2 < s and covered[s2]:
            s2 += 1
        while e2 > e and covered[e2]:
            e2 -= 1
        a = s2
        while (e2 - a + 1) * 20 > 30000:
            win = db_[a + 1000:a + 1500]
            cut = a + 1000 + int(np.argmin(win))
            out.append((a * 20, cut * 20))
            a = cut
        out.append((a * 20, (e2 + 1) * 20))
    return [{"startMs": int(x), "endMs": int(y), "kind": "gap", "appIdx": None} for x, y in out if y - x >= 300]


# ---------- main ----------
def _sig(*_):
    raise SystemExit("signal")


def main():
    import signal
    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)
    if len(sys.argv) < 2:
        raise SystemExit("usage: witness.py <id8,...>")
    ids = sys.argv[1].split(",")
    os.makedirs(TMP, mode=0o700, exist_ok=True)
    os.chmod(TMP, 0o700)
    con = db()
    vocab_rows = con.execute(
        "SELECT term, notes FROM vocabulary ORDER BY length(term) DESC, created_at DESC").fetchall()
    vocab = [{"term": r["term"].strip(), "notes": (r["notes"] or "").strip() or None}
             for r in vocab_rows if r["term"].strip()]
    try:
        row = con.execute("SELECT value FROM settings WHERE key = 'owner_name'").fetchone()
    except sqlite3.Error:
        row = None
    owner_name = ((row["value"] if row else "") or os.environ.get("SILVER_OWNER_NAME", "")).strip() or None
    report = {"meetings": [], "lockWaitSec": 0, "errors": []}
    if os.path.exists(LOCK):
        log("GPU lock present at start")
    report["lockWaitSec"] = take_lock()
    qwen = whisper = None
    try:
        qwen = Worker(QWEN)
        whisper = Worker(WHISPER)
        for id8 in ids:
            t_meet = time.time()
            m = con.execute("SELECT * FROM meetings WHERE substr(id,1,8)=?", (id8,)).fetchone()
            mid = m["id"]
            lang = m["language"] or "en"
            out_dir = os.path.join(CORPUS, id8)
            os.makedirs(out_dir, mode=0o700, exist_ok=True)
            os.chmod(out_dir, 0o700)
            # context.json
            atts = []
            try:
                for a in json.loads(m["calendar_attendees"] or "[]"):
                    nm = (a.get("name") or "").strip()
                    if nm:
                        atts.append({"name": nm, "nameSource": "calendar", "isOrganizer": bool(a.get("isOrganizer"))})
                    else:
                        d = derive_name(a.get("email"))
                        atts.append({"name": d, "nameSource": "email" if d else None, "isOrganizer": bool(a.get("isOrganizer"))})
            except Exception as e:
                report["errors"].append(f"{id8}: attendees parse {type(e).__name__}")
            folder = None
            if m["folder_id"]:
                f = con.execute("SELECT name, description FROM meeting_folders WHERE id=?", (m["folder_id"],)).fetchone()
                if f:
                    folder = {"name": f["name"], "description": f["description"]}
            mctx = m["context"] or ""
            ctx_terms = []
            if mctx.strip():
                r = subprocess.run(P.node_ts(CTX_TERMS), input=mctx, capture_output=True, text=True, timeout=60)
                ctx_terms = json.loads(r.stdout) if r.returncode == 0 else []
                if r.returncode != 0:
                    report["errors"].append(f"{id8}: context terms rc={r.returncode}")
            terms = merge_terms(ctx_terms, [v["term"] for v in vocab])
            base_prompt = f"Technical terms: {', '.join(terms)}"[:PROMPT_BUDGET] if terms else ""
            write_private(os.path.join(out_dir, "context.json"), {
                "meeting": id8, "meetingId": mid, "language": lang,
                "calendarTitle": m["calendar_title"], "title": m["title"],
                "folder": folder, "attendees": atts,
                "vocabulary": vocab, "meetingContext": mctx or None,
                "contextTerms": ctx_terms, "h2BasePrompt": base_prompt or None,
                "owner_name": owner_name,
            })
            # app.json
            segs = con.execute(
                "SELECT source, idx, start_ms, end_ms, status, speaker_label, text, enhanced_text "
                "FROM meeting_segments WHERE meeting_id=? ORDER BY source, idx", (mid,)).fetchall()
            app = {"meeting": id8, "meetingId": mid, "sttModel": m["stt_model"], "language": lang,
                   "durationMs": m["duration_ms"], "channels": {"mic": [], "system": []}}
            for s in segs:
                app["channels"][s["source"]].append({
                    "idx": s["idx"], "startMs": s["start_ms"], "endMs": s["end_ms"], "status": s["status"],
                    "speakerLabel": s["speaker_label"], "text": s["text"], "enhancedText": s["enhanced_text"]})
            write_private(os.path.join(out_dir, "app.json"), app)
            # ASR
            qlang = QWEN_LANG.get(lang)
            hyp = {h: {"mic": [], "system": []} for h in ("h1", "h2", "h3")}
            secs = {"h1": 0.0, "h2": 0.0, "h3": 0.0}
            counts = {"chunks": 0, "gap": 0, "prompted": 0, "context": 0, "echoRetry": 0, "failed": 0}
            for ch in ("mic", "system"):
                pcm = read_wav(os.path.join(PROFILE, "meetings", mid, f"{ch}.wav"))
                appc = [{"startMs": s["startMs"], "endMs": s["endMs"], "kind": "app", "appIdx": s["idx"]}
                        for s in app["channels"][ch]]
                chunks = sorted(appc + gap_chunks(pcm, appc), key=lambda c: (c["startMs"], c["endMs"]))
                counts["chunks"] += len(chunks)
                counts["gap"] += sum(1 for c in chunks if c["kind"] == "gap")
                prev_text, prev_end = None, None  # H2 lane state (app chunks only)
                for i, c in enumerate(chunks):
                    path = os.path.join(TMP, f"{id8}-{ch}-{i}.wav")
                    write_slice(pcm, c["startMs"], c["endMs"], path)
                    dur = c["endMs"] - c["startMs"]
                    base = {"startMs": c["startMs"], "endMs": c["endMs"], "kind": c["kind"], "appIdx": c["appIdx"]}
                    # H1: no prompt at all
                    t0 = time.time()
                    try:
                        t1 = qwen.transcribe(path, qlang)
                        e1 = None
                    except Exception as e:
                        t1, e1 = "", str(e)[:120]
                        counts["failed"] += 1
                    secs["h1"] += time.time() - t0
                    hyp["h1"][ch].append({**base, "text": t1, **({"error": e1} if e1 else {})})
                    # H2: app prompt (terms + previous-chunk context, as transcriber.ts)
                    bias = base_prompt if dur >= MIN_BIAS_MS and base_prompt else ""
                    ctx = None
                    if c["kind"] == "app" and dur >= MIN_BIAS_MS and prev_text and prev_end is not None \
                            and c["startMs"] - prev_end <= CONTEXT_GAP_MAX_MS:
                        ctx = context_tail(prev_text) or None
                    prompt = combine_prompt(bias, ctx) if ctx else bias
                    t0 = time.time()
                    echo = False
                    try:
                        t2 = qwen.transcribe(path, qlang, prompt or None)
                        if ctx and is_context_echo(t2, TERMS_MARKER.sub("", prompt, count=1)):
                            echo = True
                            t2 = qwen.transcribe(path, qlang, bias or None)
                        e2 = None
                    except Exception as e:
                        t2, e2 = "", str(e)[:120]
                        counts["failed"] += 1
                    secs["h2"] += time.time() - t0
                    counts["prompted"] += 1 if prompt else 0
                    counts["context"] += 1 if ctx else 0
                    counts["echoRetry"] += 1 if echo else 0
                    hyp["h2"][ch].append({**base, "text": t2, "promptTerms": bool(bias), "promptContext": bool(ctx) and not echo,
                                          "echoRetry": echo, **({"error": e2} if e2 else {})})
                    if c["kind"] == "app":
                        ok = bool(t2) and not e2 and not (bias and is_context_echo(t2, TERMS_MARKER.sub("", bias, count=1)))
                        prev_text = t2 if ok else None
                        prev_end = c["endMs"]
                    # H3: whisper, no prompt
                    t0 = time.time()
                    try:
                        t3 = whisper.transcribe(path, lang)
                        e3 = None
                    except Exception as e:
                        t3, e3 = "", str(e)[:120]
                        counts["failed"] += 1
                    secs["h3"] += time.time() - t0
                    hyp["h3"][ch].append({**base, "text": t3, **({"error": e3} if e3 else {})})
                    os.remove(path)
                del pcm
            engines = {"h1": f"{QWEN} (no context)", "h2": f"{QWEN} (app vocabulary prompt + previous-chunk context)",
                       "h3": f"{WHISPER} (no context)"}
            for h in ("h1", "h2", "h3"):
                write_private(os.path.join(out_dir, f"{h}.json"),
                              {"engine": engines[h], "model": QWEN if h != "h3" else WHISPER,
                               "language": qlang if h != "h3" else lang, "meeting": id8, "channels": hyp[h]})
            rec = {"id8": id8, "asrSec": round(sum(secs.values()), 1), "secs": {k: round(v, 1) for k, v in secs.items()},
                   "wallSec": round(time.time() - t_meet, 1), **counts}
            report["meetings"].append(rec)
            log(f"done {id8}: {json.dumps(rec)}")
            write_private(os.path.join(TMP, "report.json"), report)
    finally:
        for w in (qwen, whisper):
            if w:
                w.close()
        release_lock()
    print("REPORT " + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
