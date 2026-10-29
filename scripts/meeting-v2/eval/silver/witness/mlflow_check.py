"""Read back the cloud witness traces (Gemini and OpenAI) from MLflow. Counts only.

Run: <venv python> -I mlflow_check.py [--since <unix ms>]   (SILVER_MLFLOW_URI, SILVER_MLFLOW_EXPERIMENT)   (--since: only traces that start at or after it)
Text check: a string value with more than 3 words is text-like. The check reads the span inputs, outputs,
attributes (not the mlflow.* keys, which copy the inputs and outputs) and event attributes. Every count must be 0.
It prints counts and key names only, never a value.
"""
import collections, os, sys
from mlflow import MlflowClient
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

c = MlflowClient(P.mlflow_uri())
exp = c.get_experiment_by_name(P.MLFLOW_EXPERIMENT)
SINCE = int(sys.argv[sys.argv.index("--since") + 1]) if "--since" in sys.argv else 0
tr, tok = [], None
while True:
    page = c.search_traces(locations=[exp.experiment_id], max_results=200, page_token=tok)
    tr += list(page)
    tok = page.token
    if not tok:
        break
tr = [t for t in tr if (t.info.request_time or 0) >= SINCE]
states = collections.Counter(str(t.info.state).split(".")[-1] for t in tr)
spans, per_model = collections.Counter(), collections.Counter()
tok_sum = collections.Counter()
# Constant attribute values of the runners that are not meeting text.
KNOWN = {("format", "mp3 16k mono 48 kbps")}
leak = collections.Counter()   # place -> text-like values
leak_keys = collections.Counter()   # (place, key) -> text-like values (key names only)


def text_like(place, obj, key=""):
    """Count the text-like strings in obj (nested dicts and lists too)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            text_like(place, v, str(k))
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            text_like(place, v, key)
    elif isinstance(obj, str) and len(obj.split()) > 3 and (key, obj) not in KNOWN:
        leak[place] += 1
        leak_keys[(place, key)] += 1


for t in tr:
    for s in t.data.spans:
        spans[s.name] += 1
        a = s.attributes or {}
        if s.name in ("gemini.chunk", "openai.chunk"):
            st = str(s.status.status_code).split(".")[-1]
            per_model[(s.name, a.get("model"), st)] += 1
            for k in ("prompt_tokens", "output_tokens", "thinking_tokens", "usage_seconds"):
                tok_sum[(a.get("model"), k)] += float(a.get(k) or 0)
            tok_sum[(a.get("model"), "usd")] += float(a.get("usd") or 0)
        text_like("outputs", s.outputs)
        text_like("inputs", s.inputs)
        text_like("attributes", {k: v for k, v in a.items() if not str(k).startswith("mlflow.")})
        for ev in s.events or []:
            text_like("events", {"name": ev.name, **(ev.attributes or {})})
print("experiment", exp.experiment_id, "traces", len(tr), "states", dict(states),
      "text-like outputs", leak["outputs"], "inputs", leak["inputs"], "attributes", leak["attributes"],
      "events", leak["events"])
if leak_keys:
    print("text-like keys", {f"{p}|{k}": n for (p, k), n in sorted(leak_keys.items())})
print("spans", dict(spans))
for k, v in sorted(per_model.items(), key=str):
    print("chunk spans", k, v)
print("sums", {f"{m}|{k}": round(v, 4) for (m, k), v in sorted(tok_sum.items(), key=str) if v})
