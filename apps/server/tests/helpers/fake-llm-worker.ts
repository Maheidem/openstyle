import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fake local MLX LLM worker (specs/local-mlx-llm.md 2.1, 2.2) as a Node
 * script. It takes `--llm --model <hfId> --port <port>`, prints the ready
 * line and serves `GET /v1/models` and `POST /v1/chat/completions` on
 * 127.0.0.1. It exits when stdin closes or on SIGTERM.
 *
 * Env: FAKE_LLM_LOG appends one JSON line with the arguments at start and one
 * JSON line per request (with the prefix cache header). FAKE_LLM_CONTENT sets
 * the answer text. FAKE_LLM_FAIL=1 prints an error line before ready.
 * FAKE_LLM_DELAY_MS holds each chat answer for that time (a busy worker).
 */
export const FAKE_LLM_WORKER_SOURCE = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const model = arg("--model");
const port = Number(arg("--port"));
if (!args.includes("--llm") || !model || !port) {
  console.log(JSON.stringify({ type: "error", error: "usage: --llm --model <hfId> --port <port>" }));
  process.exit(1);
}
if (process.env.FAKE_LLM_FAIL === "1") {
  console.log(JSON.stringify({ type: "error", error: "fake load failure" }));
  process.exit(1);
}
const log = (entry) => {
  if (process.env.FAKE_LLM_LOG) fs.appendFileSync(process.env.FAKE_LLM_LOG, JSON.stringify(entry) + "\\n");
};
log({ start: true, args });
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "GET" && req.url === "/v1/models") {
      log({ method: "GET", url: req.url });
      return send(200, { object: "list", data: [{ id: model, object: "model" }] });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return send(400, { error: { message: "bad json", type: "invalid_request_error" } }); }
      log({ method: "POST", url: req.url, body: parsed, hf_hub_offline: process.env.HF_HUB_OFFLINE ?? null, prefix_cache: req.headers["x-openstyle-prefix-cache"] ?? null });
      if (parsed.stream === true) return send(400, { error: { message: "stream is not supported", type: "invalid_request_error" } });
      const content = process.env.FAKE_LLM_CONTENT ?? "Fake worker reply.";
      const delay = Number(process.env.FAKE_LLM_DELAY_MS ?? 0);
      return setTimeout(() => send(200, {
        id: "chatcmpl-fake", object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      }), delay);
    }
    send(404, { error: { message: "not found", type: "invalid_request_error" } });
  });
});
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({
    type: "ready",
    model,
    port,
    metal: { max_recommended_working_set_size: 107374182400, memory_size: 137438953472 },
  }));
});
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
`;

/** Write the fake worker into `dir` as an executable file and return its path. */
export function writeFakeLlmWorker(dir: string): string {
  const path = join(dir, "fake-llm-worker");
  writeFileSync(path, FAKE_LLM_WORKER_SOURCE);
  chmodSync(path, 0o755);
  return path;
}
