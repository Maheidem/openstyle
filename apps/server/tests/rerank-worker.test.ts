/**
 * The local MLX reranker (specs/meeting-chat-agent.md 7.4.3): catalog, the
 * model check, the worker lifecycle with a fake worker binary, the client
 * and the idle unload. No model is downloaded.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The RAM of the Mac, set per test.
let fakeTotalMem = 32 * 1024 ** 3;
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  totalmem: () => fakeTotalMem,
}));

// CI runs on Linux. The platform gate is the only Mac-specific part here.
vi.mock("../src/lib/mlx-asr/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/constants.js")>()),
  isAppleSiliconMac: () => true,
}));

import { hfRepoCacheDir } from "../src/lib/mlx-asr/constants.js";
import { RerankError, rerankPairs } from "../src/lib/mlx-rerank/client.js";
import {
  getMlxRerankModel,
  MLX_RERANK_ALLOW_PATTERNS,
  MLX_RERANK_MODEL_ID,
  MLX_RERANK_MODELS,
  RERANK_CANDIDATES,
} from "../src/lib/mlx-rerank/constants.js";
import {
  deleteMlxRerankModel,
  isMlxRerankModelDownloaded,
} from "../src/lib/mlx-rerank/models.js";
import {
  ensureMlxRerankWorker,
  getMlxRerankWorkerState,
  mlxRerankIdleMinutes,
  stopMlxRerankWorker,
} from "../src/lib/mlx-rerank/server.js";

/**
 * A fake reranker worker as a Node script. It takes `--rerank --model <hfId>
 * --revision <sha> --port <port>`, prints the ready line and serves
 * `POST /v1/rerank`. The score of a document is its length / 100, so the test
 * knows the order. FAKE_RERANK_MODE=short returns one score too few;
 * =status500 answers 500. FAKE_RERANK_LOG appends one JSON line per request.
 */
const FAKE_WORKER = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(arg("--port"));
if (!args.includes("--rerank") || !port) {
  console.log(JSON.stringify({ type: "error", error: "usage: --rerank --port <port>" }));
  process.exit(1);
}
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && req.url === "/v1/rerank") {
      const parsed = JSON.parse(body);
      if (process.env.FAKE_RERANK_LOG) fs.appendFileSync(process.env.FAKE_RERANK_LOG, JSON.stringify({ ...parsed, args }) + "\\n");
      if (process.env.FAKE_RERANK_MODE === "status500") return send(500, { error: { message: "boom" } });
      const scores = parsed.documents.map((d) => d.length / 100);
      if (process.env.FAKE_RERANK_MODE === "short") scores.pop();
      return send(200, { scores, ms: 1 });
    }
    send(404, { error: { message: "not found" } });
  });
});
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ type: "ready", port, model: arg("--model") }));
});
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
`;

let scratch = "";
let workerLog = "";
const ORIGINAL_ENV = {
  hfCache: process.env.HUGGINGFACE_HUB_CACHE,
  worker: process.env.OPENSTYLE_MLX_RERANK_WORKER,
};

function def() {
  const d = getMlxRerankModel(MLX_RERANK_MODEL_ID);
  if (!d) throw new Error("no reranker in the catalog");
  return d;
}

function seedModel(): void {
  const snap = join(hfRepoCacheDir(def().hfId), "snapshots", def().revision);
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "config.json"), "{}");
  writeFileSync(join(snap, "model.safetensors"), "w");
}

function requests(): Array<Record<string, unknown>> {
  if (!existsSync(workerLog)) return [];
  return readFileSync(workerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeAll(() => {
  vi.useRealTimers();
  scratch = mkdtempSync(join(tmpdir(), "openstyle-mlx-rerank-"));
  workerLog = join(scratch, "worker.log");
  process.env.HUGGINGFACE_HUB_CACHE = join(scratch, "hf");
  const path = join(scratch, "fake-rerank-worker");
  writeFileSync(path, FAKE_WORKER);
  chmodSync(path, 0o755);
  process.env.OPENSTYLE_MLX_RERANK_WORKER = path;
  process.env.FAKE_RERANK_LOG = workerLog;
});

afterEach(async () => {
  vi.useRealTimers();
  await stopMlxRerankWorker();
  delete process.env.FAKE_RERANK_MODE;
  fakeTotalMem = 32 * 1024 ** 3;
  rmSync(hfRepoCacheDir(def().hfId), { recursive: true, force: true });
  rmSync(workerLog, { force: true });
});

afterAll(() => {
  if (ORIGINAL_ENV.hfCache === undefined)
    delete process.env.HUGGINGFACE_HUB_CACHE;
  else process.env.HUGGINGFACE_HUB_CACHE = ORIGINAL_ENV.hfCache;
  if (ORIGINAL_ENV.worker === undefined)
    delete process.env.OPENSTYLE_MLX_RERANK_WORKER;
  else process.env.OPENSTYLE_MLX_RERANK_WORKER = ORIGINAL_ENV.worker;
  delete process.env.FAKE_RERANK_LOG;
  rmSync(scratch, { recursive: true, force: true });
});

describe("catalog", () => {
  it("has one Qwen3 reranker at a pinned revision", () => {
    expect(MLX_RERANK_MODELS.map((m) => [m.id, m.hfId])).toEqual([
      ["qwen3-reranker-0.6b", "Qwen/Qwen3-Reranker-0.6B"],
    ]);
    expect(def().revision).toMatch(/^[0-9a-f]{40}$/);
    expect(MLX_RERANK_ALLOW_PATTERNS).toContain("model.safetensors");
    expect(getMlxRerankModel("nope")).toBeUndefined();
  });

  it("keeps the default number of candidates in one constant", () => {
    expect(RERANK_CANDIDATES).toBeGreaterThanOrEqual(15);
    expect(RERANK_CANDIDATES).toBeLessThanOrEqual(30);
  });
});

describe("model on disk", () => {
  it("is absent, then present at the pinned revision only", () => {
    expect(isMlxRerankModelDownloaded(def())).toBe(false);
    seedModel();
    expect(isMlxRerankModelDownloaded(def())).toBe(true);
    expect(deleteMlxRerankModel()).toBe(true);
    expect(isMlxRerankModelDownloaded(def())).toBe(false);
  });
});

describe("rerankPairs", () => {
  it("throws no_model and starts no worker when the model is not on disk", async () => {
    await expect(rerankPairs("q", ["a"])).rejects.toMatchObject({
      name: "RerankError",
      kind: "no_model",
    });
    expect(getMlxRerankWorkerState().state).toBe("stopped");
    expect(requests()).toHaveLength(0);
  });

  it("returns [] for no documents without a worker", async () => {
    expect(await rerankPairs("q", [])).toEqual([]);
    expect(getMlxRerankWorkerState().state).toBe("stopped");
  });

  it("returns one score per document, in order, from the worker", async () => {
    seedModel();
    const scores = await rerankPairs("what is the budget", [
      "aaaa",
      "a",
      "aaaaaaaa",
    ]);
    expect(scores).toEqual([0.04, 0.01, 0.08]);
    const [req] = requests();
    expect(req?.query).toBe("what is the budget");
    expect(req?.documents).toEqual(["aaaa", "a", "aaaaaaaa"]);
    expect((req?.args as string[]).slice(0, 2)).toEqual([
      "--rerank",
      "--model",
    ]);
    expect(getMlxRerankWorkerState().state).toBe("ready");
  });

  it("throws rerank_bad_response when the score count is wrong", async () => {
    seedModel();
    process.env.FAKE_RERANK_MODE = "short";
    await expect(rerankPairs("q", ["a", "b"])).rejects.toMatchObject({
      kind: "rerank_bad_response",
    });
  });

  it("throws rerank_failed when the worker answers 500", async () => {
    seedModel();
    process.env.FAKE_RERANK_MODE = "status500";
    const err = await rerankPairs("q", ["a"]).catch((e) => e);
    expect(err).toBeInstanceOf(RerankError);
    expect(err.kind).toBe("rerank_failed");
  });

  it("stops when the signal is aborted", async () => {
    seedModel();
    const controller = new AbortController();
    controller.abort();
    await expect(rerankPairs("q", ["a"], controller.signal)).rejects.toThrow();
  });
});

describe("idle unload", () => {
  it("uses 5 minutes, and 30 seconds on a Mac with 8 GiB or less", () => {
    expect(mlxRerankIdleMinutes()).toBe(5);
    fakeTotalMem = 8 * 1024 ** 3;
    expect(mlxRerankIdleMinutes()).toBe(0.5);
  });

  it("unloads the worker after the idle time and starts it again on demand", async () => {
    seedModel();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ensureMlxRerankWorker();
    expect(getMlxRerankWorkerState().state).toBe("ready");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(getMlxRerankWorkerState().state).toBe("ready");
    await vi.advanceTimersByTimeAsync(61_000);
    vi.useRealTimers();
    const deadline = Date.now() + 5_000;
    while (
      getMlxRerankWorkerState().state !== "stopped" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(getMlxRerankWorkerState().state).toBe("stopped");
    expect(await rerankPairs("q", ["abc"])).toEqual([0.03]);
    expect(getMlxRerankWorkerState().state).toBe("ready");
  });

  it("unloads after 30 seconds on a low RAM Mac", async () => {
    seedModel();
    fakeTotalMem = 8 * 1024 ** 3;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ensureMlxRerankWorker();
    await vi.advanceTimersByTimeAsync(31_000);
    vi.useRealTimers();
    const deadline = Date.now() + 5_000;
    while (
      getMlxRerankWorkerState().state !== "stopped" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(getMlxRerankWorkerState().state).toBe("stopped");
  });
});
