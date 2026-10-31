"""rerank.py: scores (query, document) pairs with a Qwen3 reranker under MLX.

Arm R1 of the chat eval (specs/meeting-chat-agent.md 7.4.3). The model is a
causal LM. The score of a pair is the probability of the token "yes" against
"no" at the last position (https://huggingface.co/Qwen/Qwen3-Reranker-0.6B).

Usage: python rerank.py <model dir> <in.json> <out.json>
in.json:  {"queries": [{"id": "r001", "query": "...", "docs": [{"id": 12, "text": "..."}]}]}
out.json: {"load_ms": .., "rss_mb": .., "queries": [{"id": "r001", "ms": .., "scores": {"12": 0.93}}]}
"""

import json
import resource
import sys
import time

import mlx.core as mx
from mlx_lm import load

PREFIX = (
    "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query "
    'and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n'
    "<|im_start|>user\n"
)
SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
INSTRUCT = "Given a question about a meeting, retrieve the passages of meetings that answer it"
MAX_DOC_TOKENS = 700


def main() -> None:
    model_dir, src, dst = sys.argv[1:4]
    t0 = time.perf_counter()
    model, tok = load(model_dir)
    hf = getattr(tok, "_tokenizer", tok)
    yes_id = hf.convert_tokens_to_ids("yes")
    no_id = hf.convert_tokens_to_ids("no")
    load_ms = (time.perf_counter() - t0) * 1000
    data = json.load(open(src))
    out = []
    for q in data["queries"]:
        t1 = time.perf_counter()
        scores = {}
        for d in q["docs"]:
            doc = d["text"]
            ids_doc = tok.encode(doc)
            if len(ids_doc) > MAX_DOC_TOKENS:
                doc = tok.decode(ids_doc[:MAX_DOC_TOKENS])
            text = f"{PREFIX}<Instruct>: {INSTRUCT}\n<Query>: {q['query']}\n<Document>: {doc}{SUFFIX}"
            ids = tok.encode(text)
            logits = model(mx.array([ids]))[:, -1, :]
            pair = mx.stack([logits[:, no_id], logits[:, yes_id]], axis=1)
            p_yes = mx.softmax(pair, axis=1)[:, 1]
            mx.eval(p_yes)
            scores[str(d["id"])] = float(p_yes.item())
        out.append({"id": q["id"], "ms": (time.perf_counter() - t1) * 1000, "scores": scores})
    rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)
    json.dump({"load_ms": load_ms, "rss_mb": rss_mb, "queries": out}, open(dst, "w"))


if __name__ == "__main__":
    main()
