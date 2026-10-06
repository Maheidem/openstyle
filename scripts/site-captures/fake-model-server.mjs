// Tiny fake oMLX-style OpenAI-compatible server for the "Your own server"
// group of the Models page. Serves fictional model names only.
import { createServer } from "node:http";

const MODELS = ["Qwen3-ASR", "Qwen3.8-27B", "Qwen3-Embedding"];

// oMLX status list: the model kind comes from model_type.
const STATUS = {
  models: [
    { id: "qwen3-asr", model_alias: "Qwen3-ASR", model_type: "audio_stt" },
    { id: "qwen3-8-27b", model_alias: "Qwen3.8-27B", model_type: "vlm" },
    {
      id: "qwen3-embedding",
      model_alias: "Qwen3-Embedding",
      model_type: "embedding",
    },
  ],
};

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
    if (req.method === "GET" && pathname === "/v1/models/status") {
      return json(res, 200, STATUS);
    }
    return json(res, 404, { error: "not found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
