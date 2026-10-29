"""EmbeddingGemma 2 vectors for the OpenAI line alignment (same model and prompts as goldsilver/eg2_embed.py). Counts only.

Run with the eg2test venv: python -I openai_embed.py
Writes $SILVER_WORK/cloud/cache_oai/<id8>.npz (mode 600, vectors only): oai_<ch> (lines, "query"), h1_<ch>, h3_<ch> ("document"),
aud_<ch> + audstart_<ch> (22.5 s windows, hop 7.5 s, from the channel wav, read-only).
"""
import json, os, sys, time, wave
import numpy as np, torch
from sentence_transformers import SentenceTransformer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from openai_build import lines_of, IDS, CORP, J, P  # noqa: E402

MEET = P.MEET
OUT = P.work_dir("cloud", "cache_oai")
WIN, HOP, SR = 22.5, 7.5, 16000
os.makedirs(OUT, mode=0o700, exist_ok=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
dt = torch.bfloat16 if dev == "mps" else torch.float32
model = SentenceTransformer("google/embeddinggemma-2", device=dev, model_kwargs={"torch_dtype": dt}, config_kwargs={"vision_config": None})
print("device", dev, next(model.parameters()).dtype, flush=True)


def enc(texts, prompt):
    idx = [i for i, t in enumerate(texts) if t and t.strip()]
    out = np.zeros((len(texts), 768), dtype=np.float32)
    if idx:
        v = model.encode([texts[i] for i in idx], prompt_name=prompt, convert_to_numpy=True, batch_size=32, normalize_embeddings=True).astype(np.float32)
        if v.shape[1] != out.shape[1]:
            out = np.zeros((len(texts), v.shape[1]), dtype=np.float32)
        out[idx] = v
    return out


for m in IDS:
    p = f"{OUT}/{m}.npz"
    if os.path.exists(p):
        print(m, "cached", flush=True); continue
    t0 = time.time()
    lines, _, _ = lines_of(m)
    app = J(f"{CORP}/{m}/app.json")
    arr = {}
    for ch in ("mic", "system"):
        arr[f"oai_{ch}"] = enc([t["text"] for t in lines[ch]], "query")
    for h in ("h1", "h3"):
        H = J(f"{CORP}/{m}/{h}.json")
        for ch in ("mic", "system"):
            arr[f"{h}_{ch}"] = enc([s["text"] for s in H["channels"][ch]], "document")
    for ch in ("mic", "system"):
        w = wave.open(f"{MEET}/{app['meetingId']}/{ch}.wav")
        assert w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == SR
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        w.close()
        starts = np.arange(0, max(1, len(audio) / SR - 2), HOP)
        vecs = []
        for k in range(0, len(starts), 16):
            batch = [{"audio": {"array": audio[int(s * SR):int(min(s + WIN, len(audio) / SR) * SR)], "sampling_rate": SR}} for s in starts[k:k + 16]]
            vecs.append(model.encode(batch, convert_to_numpy=True, normalize_embeddings=True, batch_size=16).astype(np.float32))
        arr[f"aud_{ch}"] = np.concatenate(vecs)
        arr[f"audstart_{ch}"] = (starts * 1000).astype(np.int64)
        assert np.isfinite(arr[f"aud_{ch}"]).all()
        del audio
    np.savez(p, **arr)
    os.chmod(p, 0o600)
    print(m, "done", round(time.time() - t0, 1), "s", {k: v.shape[0] for k, v in arr.items() if not k.startswith("audstart")}, flush=True)
