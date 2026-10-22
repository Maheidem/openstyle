// Tiny fake OpenAI-compatible server for the "Your own server" group of the
// Models page. It serves fictional model names only. The app finds the kind
// of each model from its name (whisper = speech, bge = embedding).
import { createServer } from "node:http";

const MODELS = [
  "whisper-large-v3-turbo",
  "whisper-large-v3",
  "gpt-oss-20b",
  "bge-m3",
];

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Start the fake server. Resolves with the http.Server once it listens. */
export function startFakeModelServer(port) {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "GET" && pathname === "/v1/models") {
      return json(res, 200, {
        object: "list",
        data: MODELS.map((id) => ({
          id,
          object: "model",
          created: 1750000000,
          owned_by: "local",
        })),
      });
    }
    return json(res, 404, { error: "not found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
