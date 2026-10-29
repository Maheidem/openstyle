"""Read back the cloud witness traces (Gemini and OpenAI) from MLflow. Counts only.

Run: <venv python> -I mlflow_check.py [--since <unix ms>]   (SILVER_MLFLOW_URI, SILVER_MLFLOW_EXPERIMENT)   (--since: only traces that start at or after it)
"""
import collections, os, sys
from mlflow import MlflowClient
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

c = MlflowClient(P.MLFLOW_URI)
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
spans, per_model, leak = collections.Counter(), collections.Counter(), 0
tok_sum = collections.Counter()
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
        out = s.outputs
        if isinstance(out, dict) and any(isinstance(v, str) and len(v.split()) > 3 for v in out.values()):
            leak += 1
print("experiment", exp.experiment_id, "traces", len(tr), "states", dict(states), "text-like outputs", leak)
print("spans", dict(spans))
for k, v in sorted(per_model.items(), key=str):
    print("chunk spans", k, v)
print("sums", {f"{m}|{k}": round(v, 4) for (m, k), v in sorted(tok_sum.items(), key=str) if v})
