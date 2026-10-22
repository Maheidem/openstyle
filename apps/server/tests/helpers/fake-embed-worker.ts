import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fake embedding worker (specs/local-semantic-search.md 5.2) as a Node
 * script. It takes `--embed --model <hfId> --revision <sha> --port <port>`,
 * prints the ready line with `dims` and serves `GET /v1/models` and
 * `POST /v1/embeddings` on 127.0.0.1. Vector i of a request has 1 at
 * position (length of input i) mod dims. It exits when stdin closes or on
 * SIGTERM.
 *
 * Env: FAKE_EMBED_LOG appends one JSON line per request (with the argv).
 * FAKE_EMBED_DIMS sets the reply dims (default 768). FAKE_EMBED_FAIL=1
 * prints an error line before ready. FAKE_EMBED_BOW=1 gives bag-of-words
 * vectors instead (each word, without the D9 prompt, hashed to one dim, then
 * L2-normalized), so texts that share words are near (search tests).
 * FAKE_EMBED_DELAY_MS waits that long before each embeddings reply.
 */
const FAKE_EMBED_WORKER_SOURCE = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const model = arg("--model");
const port = Number(arg("--port"));
if (!args.includes("--embed") || !model || !port) {
  console.log(JSON.stringify({ type: "error", error: "usage: --embed --model <hfId> --port <port>" }));
  process.exit(1);
}
if (process.env.FAKE_EMBED_FAIL === "1") {
  console.log(JSON.stringify({ type: "error", error: "fake load failure" }));
  process.exit(1);
}
const dims = Number(process.env.FAKE_EMBED_DIMS || 768);
const log = (entry) => {
  if (process.env.FAKE_EMBED_LOG) fs.appendFileSync(process.env.FAKE_EMBED_LOG, JSON.stringify({ ...entry, args }) + "\\n");
};
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "GET" && req.url === "/v1/models") {
      return send(200, { object: "list", data: [{ id: model, object: "model" }] });
    }
    if (req.method === "POST" && req.url === "/v1/embeddings") {
      const parsed = JSON.parse(body);
      log({ method: "POST", url: req.url, body: parsed, hf_hub_offline: process.env.HF_HUB_OFFLINE ?? null });
      const input = typeof parsed.input === "string" ? [parsed.input] : parsed.input;
      const bow = (text) => {
        const v = new Array(dims).fill(0);
        const body = text.replace(/^(title: none \\| text: |task: search result \\| query: )/, "");
        for (const w of body.toLowerCase().match(/\\p{L}+/gu) || []) {
          let h = 2166136261;
          for (const ch of w) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
          v[h % dims] += 1;
        }
        const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
        return v.map((x) => x / n);
      };
      const data = input.map((text, index) => {
        if (process.env.FAKE_EMBED_BOW === "1") {
          return { object: "embedding", index, embedding: bow(text) };
        }
        const embedding = new Array(dims).fill(0);
        embedding[text.length % dims] = 1;
        return { object: "embedding", index, embedding };
      });
      const tokens = input.map((text) => text.split(" ").length);
      const reply = () => send(200, {
        object: "list", model, data,
        usage: { prompt_tokens: 1, total_tokens: 1 },
        openstyle: { tokens, truncated: tokens.map(() => false) },
      });
      const delay = Number(process.env.FAKE_EMBED_DELAY_MS || 0);
      return delay > 0 ? setTimeout(reply, delay) : reply();
    }
    send(404, { error: { message: "not found", type: "invalid_request_error" } });
  });
});
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ type: "ready", port, model, dims: 768 }));
});
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
`;

/** Write the fake worker into `dir` as an executable file and return its path. */
export function writeFakeEmbedWorker(dir: string): string {
  const path = join(dir, "fake-embed-worker");
  writeFileSync(path, FAKE_EMBED_WORKER_SOURCE);
  chmodSync(path, 0o755);
  return path;
}
