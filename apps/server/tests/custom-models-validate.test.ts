import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  download: vi.fn(async () => {}),
  disk: vi.fn(async () => {}),
}));

vi.mock("../src/lib/mlx-asr/models.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/mlx-asr/models.js")>();
  return { ...actual, downloadMlxModel: mocks.download };
});

vi.mock("../src/lib/disk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/disk.js")>();
  return { ...actual, assertEnoughDiskSpace: mocks.disk };
});

import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { InsufficientDiskSpaceError } from "../src/lib/disk.js";
import { insertCustomModel } from "../src/lib/mlx-asr/custom-models.js";
import {
  addCustomModel,
  CustomModelError,
  searchMlxModels,
  validateCustomModel,
} from "../src/lib/mlx-asr/custom-validate.js";
import { jsonRequest } from "./helpers/http.js";

const HF_ID = "mlx-community/whisper-tiny-asr-fp16";
const API_URL = `https://huggingface.co/api/models/${HF_ID}?blobs=true`;
const FILE_URL = (file: string, id = HF_ID) =>
  `https://huggingface.co/${id}/resolve/main/${file}`;

// A family that needs no files besides config.json and the weights.
const PARAKEET = { model_type: "parakeet" };

type Responder = () => Response | Promise<Response>;

let routes: Record<string, Responder> = {};
let calls: { url: string; init?: RequestInit }[] = [];

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    id: HF_ID,
    sha: "sha-1",
    gated: false,
    private: false,
    siblings: [
      { rfilename: "config.json", size: 262 },
      { rfilename: "model.safetensors", size: 1000 },
      { rfilename: "preprocessor_config.json", size: 30 },
      { rfilename: "tokenizer.json", size: 50 },
    ],
    ...overrides,
  };
}

/** Serve a repo that passes every step. Pass overrides to break one step. */
function serveRepo(
  meta: Record<string, unknown> = {},
  config: unknown = { model_type: "whisper" },
): void {
  routes[API_URL] = () => json(metadata(meta));
  routes[FILE_URL("config.json")] = () => json(config);
}

async function failure(input: string): Promise<CustomModelError> {
  const err = await validateCustomModel(input).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CustomModelError);
  return err as CustomModelError;
}

function customRowCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM custom_mlx_models")
    .get() as { n: number };
  return row.n;
}

beforeEach(() => {
  routes = {};
  calls = [];
  mocks.download.mockClear();
  mocks.disk.mockReset();
  mocks.disk.mockResolvedValue(undefined);
  getDb().exec("DELETE FROM custom_mlx_models");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      // Most repos list this file. It has no auto_map unless a test sets one.
      const responder =
        routes[url] ??
        (url.endsWith("/resolve/main/preprocessor_config.json")
          ? () => json({})
          : undefined);
      if (!responder) throw new Error(`unmocked fetch: ${url}`);
      return responder();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateCustomModel", () => {
  it("accepts a supported repo and returns family, size and revision", async () => {
    serveRepo();

    const result = await validateCustomModel(HF_ID);

    expect(result).toMatchObject({
      hfId: HF_ID,
      family: "whisper",
      modelType: "whisper",
      totalBytes: 1342,
      revision: "sha-1",
    });
    expect(result.files).toEqual([
      { path: "config.json", size: 262 },
      { path: "model.safetensors", size: 1000 },
      { path: "preprocessor_config.json", size: 30 },
      { path: "tokenizer.json", size: 50 },
    ]);
    // The disk check includes the download buffer.
    expect(mocks.disk).toHaveBeenCalledTimes(1);
    const [, required] = mocks.disk.mock.calls[0] as unknown as [
      string,
      number,
    ];
    expect(required).toBeGreaterThan(1342);
  });

  it("writes no row and starts no download", async () => {
    serveRepo();

    await validateCustomModel(HF_ID);

    expect(customRowCount()).toBe(0);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("sends no token and follows no redirect on its own", async () => {
    serveRepo();

    await validateCustomModel(HF_ID);

    for (const call of calls) {
      expect(call.init?.redirect).toBe("manual");
      expect(call.init?.headers).toBeUndefined();
    }
  });

  it("resolves the family from the repo name when config has no model_type", async () => {
    const id = "someone/parakeet-tdt-0.6b-v2";
    routes[`https://huggingface.co/api/models/${id}?blobs=true`] = () =>
      json(metadata({ id }));
    routes[FILE_URL("config.json", id)] = () => json({ target: {} });

    expect(await validateCustomModel(id)).toMatchObject({
      family: "parakeet",
      modelType: "parakeet",
    });
  });

  describe("step 1 and 2: input", () => {
    it.each([
      `https://huggingface.co/${HF_ID}`,
      `https://huggingface.co/${HF_ID}/`,
      `https://huggingface.co/${HF_ID}/tree/main`,
      `https://huggingface.co/${HF_ID}/blob/main/config.json`,
      `https://huggingface.co/${HF_ID}/resolve/main/model.safetensors`,
      `https://huggingface.co/${HF_ID}?x=1`,
      `https://huggingface.co/${HF_ID}#files`,
      `  ${HF_ID}  `,
    ])("accepts %s", async (input) => {
      serveRepo();

      expect((await validateCustomModel(input)).hfId).toBe(HF_ID);
    });

    it.each([
      "",
      "whisper",
      "https://evil.example/mlx-community/x",
      "http://huggingface.co/a/b",
      "https://user:pw@huggingface.co/a/b",
      "https://huggingface.co:8443/a/b",
      "https://huggingface.co/spaces/a/b",
      "https://huggingface.co/a",
      "huggingface.co/a/b",
      "../x/y",
      "a/b/c",
      "a/..",
      "../b",
      ".hidden/b",
      "a/.hidden",
      "a--b/c",
      "a/b--c",
      "a/b%2f..",
      "https://huggingface.co/a/%2e%2e",
      "ftp://huggingface.co/a/b",
    ])("rejects %j with invalid_input", async (input) => {
      const err = await failure(input);

      expect(err.code).toBe("invalid_input");
      expect(err.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });

  describe("step 3: already added", () => {
    it("rejects a curated repo in any letter case, with no network call", async () => {
      const err = await failure("MLX-Community/Qwen3-ASR-0.6B-8BIT");

      expect(err.code).toBe("already_added");
      expect(err.status).toBe(409);
      expect(err.extra).toEqual({ id: "qwen3-0.6b-8bit" });
      expect(calls).toHaveLength(0);
    });

    it("rejects a legacy repo", async () => {
      expect((await failure("mlx-community/Qwen3-ASR-0.6B-5bit")).code).toBe(
        "already_added",
      );
    });

    it("rejects a repo that differs from a custom row only in case", async () => {
      serveRepo();
      const { id } = await addCustomModel(HF_ID);

      const err = await failure(HF_ID.toUpperCase());

      expect(err.code).toBe("already_added");
      expect(err.extra).toEqual({ id });
    });
  });

  describe("step 4: metadata request", () => {
    it("maps 404 to not_found", async () => {
      routes[API_URL] = () => new Response("{}", { status: 404 });

      const err = await failure(HF_ID);
      expect(err.code).toBe("not_found");
      expect(err.status).toBe(404);
    });

    it("maps 401 to not_found, because HF answers 401 for a missing repo", async () => {
      routes[API_URL] = () => new Response("{}", { status: 401 });

      expect((await failure(HF_ID)).code).toBe("not_found");
    });

    it("maps 403 to gated", async () => {
      routes[API_URL] = () => new Response("{}", { status: 403 });

      expect((await failure(HF_ID)).code).toBe("gated");
    });

    it.each([401, 403])("maps %i on config.json to gated", async (status) => {
      serveRepo();
      routes[FILE_URL("config.json")] = () => new Response("{}", { status });

      expect((await failure(HF_ID)).code).toBe("gated");
    });

    it.each([429, 500, 503, 400])("maps %i to hf_error", async (status) => {
      routes[API_URL] = () => new Response("{}", { status });

      const err = await failure(HF_ID);
      expect(err.code).toBe("hf_error");
      expect(err.status).toBe(502);
    });

    it("maps a network failure to offline", async () => {
      routes[API_URL] = () => {
        throw new TypeError("fetch failed");
      };

      const err = await failure(HF_ID);
      expect(err.code).toBe("offline");
      expect(err.status).toBe(503);
    });

    it("maps a timeout to hf_error", async () => {
      routes[API_URL] = () => {
        throw new DOMException("timed out", "TimeoutError");
      };

      expect((await failure(HF_ID)).code).toBe("hf_error");
    });

    it("maps a body that is not JSON to hf_error", async () => {
      routes[API_URL] = () => new Response("<html>");

      expect((await failure(HF_ID)).code).toBe("hf_error");
    });

    it("maps a body that stalls to hf_error", async () => {
      routes[API_URL] = () =>
        new Response(
          new ReadableStream({
            pull() {
              throw new DOMException("timed out", "TimeoutError");
            },
          }),
        );

      expect((await failure(HF_ID)).code).toBe("hf_error");
    });

    it("maps a body that breaks to offline", async () => {
      routes[API_URL] = () =>
        new Response(
          new ReadableStream({
            pull() {
              throw new TypeError("terminated");
            },
          }),
        );

      expect((await failure(HF_ID)).code).toBe("offline");
    });

    it("maps a response above 1 MB to hf_error", async () => {
      routes[API_URL] = () => new Response("x".repeat(1024 * 1024 + 1));

      expect((await failure(HF_ID)).code).toBe("hf_error");
    });
  });

  describe("redirects", () => {
    it("follows a redirect on the same host", async () => {
      serveRepo();
      routes[FILE_URL("config.json")] = () =>
        new Response(null, {
          status: 307,
          headers: {
            location:
              "https://huggingface.co/api/resolve-cache/models/x/config.json",
          },
        });
      routes["https://huggingface.co/api/resolve-cache/models/x/config.json"] =
        () => json({ model_type: "whisper" });

      expect((await validateCustomModel(HF_ID)).family).toBe("whisper");
    });

    it("follows a relative location", async () => {
      serveRepo();
      routes[FILE_URL("config.json")] = () =>
        new Response(null, {
          status: 302,
          headers: { location: "/api/resolve-cache/c.json" },
        });
      routes["https://huggingface.co/api/resolve-cache/c.json"] = () =>
        json({ model_type: "whisper" });

      expect((await validateCustomModel(HF_ID)).family).toBe("whisper");
    });

    it("rejects a redirect to another host without calling it", async () => {
      serveRepo();
      routes[FILE_URL("config.json")] = () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://evil.example/config.json" },
        });

      expect((await failure(HF_ID)).code).toBe("hf_error");
      expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
    });

    it("rejects a redirect to http", async () => {
      serveRepo();
      routes[FILE_URL("config.json")] = () =>
        new Response(null, {
          status: 307,
          headers: { location: "http://huggingface.co/config.json" },
        });

      expect((await failure(HF_ID)).code).toBe("hf_error");
    });

    it("rejects a redirect with no location", async () => {
      serveRepo();
      routes[FILE_URL("config.json")] = () =>
        new Response(null, { status: 307 });

      expect((await failure(HF_ID)).code).toBe("hf_error");
    });

    it("allows 3 hops and rejects a 4th", async () => {
      serveRepo();
      const hop = (n: number) => `https://huggingface.co/api/hop/${n}`;
      const redirectTo = (url: string) => () =>
        new Response(null, { status: 307, headers: { location: url } });
      routes[FILE_URL("config.json")] = redirectTo(hop(1));
      routes[hop(1)] = redirectTo(hop(2));
      routes[hop(2)] = redirectTo(hop(3));
      routes[hop(3)] = () => json({ model_type: "whisper" });
      expect((await validateCustomModel(HF_ID)).family).toBe("whisper");

      routes[hop(3)] = redirectTo(hop(4));
      routes[hop(4)] = () => json({ model_type: "whisper" });
      expect((await failure(HF_ID)).code).toBe("hf_error");
    });
  });

  describe("step 5: gated or private", () => {
    it.each([
      ["gated auto", { gated: "auto" }],
      ["gated manual", { gated: "manual" }],
      ["gated missing", { gated: undefined }],
      ["private", { private: true }],
    ])("rejects a %s repo", async (_name, meta) => {
      serveRepo(meta);

      expect((await failure(HF_ID)).code).toBe("gated");
    });
  });

  describe("step 6: config.json", () => {
    it("fails with no_config when siblings lack config.json", async () => {
      serveRepo({
        siblings: [{ rfilename: "model.safetensors", size: 10 }],
      });

      const err = await failure(HF_ID);
      expect(err.code).toBe("no_config");
      expect(calls.some((c) => c.url === FILE_URL("config.json"))).toBe(false);
    });

    it("ignores a config.json in a subdirectory", async () => {
      serveRepo({
        siblings: [
          { rfilename: "sub/config.json", size: 10 },
          { rfilename: "model.safetensors", size: 10 },
        ],
      });

      expect((await failure(HF_ID)).code).toBe("no_config");
    });

    it("fails with no_config when config.json is not a JSON object", async () => {
      serveRepo({}, ["not", "an", "object"]);
      expect((await failure(HF_ID)).code).toBe("no_config");

      routes[FILE_URL("config.json")] = () => new Response("{oops");
      expect((await failure(HF_ID)).code).toBe("no_config");
    });

    it("fails with no_config when config.json answers 404", async () => {
      serveRepo();
      routes[FILE_URL("config.json")] = () => new Response("", { status: 404 });

      expect((await failure(HF_ID)).code).toBe("no_config");
    });
  });

  describe("step 7: remote code", () => {
    it.each([
      ["a .py file", [{ rfilename: "modeling_x.py", size: 10 }]],
      ["a nested .py file", [{ rfilename: "src/Model.PY", size: 10 }]],
    ])("rejects %s", async (_name, extra) => {
      serveRepo({ siblings: [...metadata().siblings, ...extra] });

      expect((await failure(HF_ID)).code).toBe("remote_code");
    });

    it("rejects auto_map in config.json", async () => {
      serveRepo({}, { model_type: "whisper", auto_map: {} });

      expect((await failure(HF_ID)).code).toBe("remote_code");
    });

    it.each([
      "tokenizer_config.json",
      "preprocessor_config.json",
    ])("rejects auto_map in %s", async (file) => {
      serveRepo({
        siblings: [...metadata().siblings, { rfilename: file, size: 5 }],
      });
      routes[FILE_URL(file)] = () =>
        json({ auto_map: { AutoTokenizer: ["other/repo--mod.Cls", null] } });

      expect((await failure(HF_ID)).code).toBe("remote_code");
    });

    it("accepts a tokenizer_config.json without auto_map", async () => {
      serveRepo({
        siblings: [
          ...metadata().siblings,
          { rfilename: "tokenizer_config.json", size: 5 },
        ],
      });
      routes[FILE_URL("tokenizer_config.json")] = () =>
        json({ tokenizer_class: "X" });

      expect((await validateCustomModel(HF_ID)).family).toBe("whisper");
    });

    it("fetches the optional files only when they are listed", async () => {
      serveRepo();

      await validateCustomModel(HF_ID);

      // tokenizer_config.json is not in the file list, so it is not fetched.
      expect(calls.map((c) => c.url)).toEqual([
        API_URL,
        FILE_URL("config.json"),
        FILE_URL("preprocessor_config.json"),
      ]);
    });
  });

  describe("step 8: family", () => {
    it("returns unsupported_family and the raw model_type", async () => {
      const id = "mlx-community/some-voice";
      routes[`https://huggingface.co/api/models/${id}?blobs=true`] = () =>
        json(metadata({ id }));
      routes[FILE_URL("config.json", id)] = () =>
        json({ model_type: "voxtral" });

      const err = await failure(id);
      expect(err.code).toBe("unsupported_family");
      expect(err.status).toBe(422);
      expect(err.extra).toEqual({ modelType: "voxtral" });
    });

    it("rejects a TTS repo with unsupported_family", async () => {
      const id = "mlx-community/Kokoro-82M-bf16";
      routes[`https://huggingface.co/api/models/${id}?blobs=true`] = () =>
        json(metadata({ id }));
      routes[FILE_URL("config.json", id)] = () => json({ istftnet: {} });

      const err = await failure(id);
      expect(err.code).toBe("unsupported_family");
      expect(err.extra).toEqual({ modelType: "kokoro" });
    });

    it("rejects a forced aligner with not_transcriber", async () => {
      const id = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit";
      routes[`https://huggingface.co/api/models/${id}?blobs=true`] = () =>
        json(metadata({ id }));
      routes[FILE_URL("config.json", id)] = () =>
        json({ model_type: "qwen3_asr", timestamp_token_id: 1 });

      expect((await failure(id)).code).toBe("not_transcriber");
    });

    it("rejects a forced aligner by name alone", async () => {
      const id = "someone/qwen3-aligner";
      routes[`https://huggingface.co/api/models/${id}?blobs=true`] = () =>
        json(metadata({ id }));
      routes[FILE_URL("config.json", id)] = () =>
        json({ model_type: "qwen3_asr" });

      expect((await failure(id)).code).toBe("not_transcriber");
    });

    it("rejects the moss_music family with not_transcriber", async () => {
      serveRepo({}, { model_type: "moss_music" });

      expect((await failure(HF_ID)).code).toBe("not_transcriber");
    });

    it("lets a name part override model_type", async () => {
      const id = "someone/whisper-x-canary";
      routes[`https://huggingface.co/api/models/${id}?blobs=true`] = () =>
        json(metadata({ id }));
      routes[FILE_URL("config.json", id)] = () =>
        json({ model_type: "whisper" });

      const err = await failure(id);
      expect(err.code).toBe("unsupported_family");
    });
  });

  describe("step 9: weights", () => {
    it("fails with no_weights when there is no safetensors or npz file", async () => {
      serveRepo({
        siblings: [
          { rfilename: "config.json", size: 10 },
          { rfilename: "pytorch_model.bin", size: 10 },
        ],
      });

      expect((await failure(HF_ID)).code).toBe("no_weights");
    });

    it("ignores weights in a subdirectory", async () => {
      serveRepo({
        siblings: [
          { rfilename: "config.json", size: 10 },
          { rfilename: "nested/model.safetensors", size: 10 },
        ],
      });

      expect((await failure(HF_ID)).code).toBe("no_weights");
    });

    it("accepts an npz file", async () => {
      serveRepo({
        siblings: [
          { rfilename: "config.json", size: 10 },
          { rfilename: "weights.npz", size: 10 },
          { rfilename: "preprocessor_config.json", size: 10 },
          { rfilename: "tokenizer.json", size: 10 },
        ],
      });

      expect((await validateCustomModel(HF_ID)).totalBytes).toBe(40);
    });
  });

  describe("step 9: family files", () => {
    const weights = { rfilename: "model.safetensors", size: 10 };
    const file = (rfilename: string) => ({ rfilename, size: 10 });
    const SENSEVOICE = { model_type: "sensevoice" };

    it("rejects a whisper repo that has no processor files", async () => {
      // The layout of mlx-community/whisper-tiny.en-8bit (checked 2026-10-04).
      serveRepo({
        siblings: [file("config.json"), file("gpt2.tiktoken"), weights],
      });

      const err = await failure(HF_ID);

      expect(err.code).toBe("missing_files");
      expect(err.status).toBe(422);
      expect(err.extra).toEqual({
        missing: ["preprocessor_config.json", "tokenizer.json"],
      });
    });

    it("rejects the mlx-whisper layout: config.json and weights.npz only", async () => {
      // mlx-community/whisper-small-mlx has this layout (checked 2026-10-04).
      serveRepo({
        siblings: [file("config.json"), file("weights.npz")],
      });

      expect((await failure(HF_ID)).code).toBe("missing_files");
    });

    it.each([
      ["preprocessor_config.json", ["tokenizer.json"]],
      ["tokenizer.json", ["preprocessor_config.json"]],
    ])("lists only the whisper file that is missing (has %s)", async (name, missing) => {
      serveRepo({
        siblings: [file("config.json"), weights, file(name)],
      });

      expect((await failure(HF_ID)).extra).toEqual({ missing });
    });

    it("does not count a file in a subdirectory", async () => {
      serveRepo({
        siblings: [
          file("config.json"),
          weights,
          file("preprocessor_config.json"),
          file("tokenizer/tokenizer.json"),
        ],
      });

      expect((await failure(HF_ID)).extra).toEqual({
        missing: ["tokenizer.json"],
      });
    });

    it("rejects a qwen3_asr repo without its tokenizer files", async () => {
      const id = "someone/Qwen3-ASR-0.6B-4bit";
      routes[`https://huggingface.co/api/models/${id}?blobs=true`] = () =>
        json(
          metadata({
            id,
            siblings: [
              file("config.json"),
              weights,
              file("tokenizer_config.json"),
            ],
          }),
        );
      routes[FILE_URL("config.json", id)] = () =>
        json({ model_type: "qwen3_asr" });
      routes[FILE_URL("tokenizer_config.json", id)] = () => json({});

      const err = await failure(id);

      expect(err.code).toBe("missing_files");
      expect(err.extra).toEqual({
        missing: ["preprocessor_config.json", "vocab.json", "merges.txt"],
      });
    });

    it("accepts a sensevoice repo with either tokenizer file", async () => {
      const id = "someone/SenseVoiceSmall-4bit";
      routes[FILE_URL("config.json", id)] = () => json(SENSEVOICE);
      for (const tokenizer of [
        "chn_jpn_yue_eng_ko_spectok.bpe.model",
        "tokens.json",
      ]) {
        routes[`https://huggingface.co/api/models/${id}?blobs=true`] = () =>
          json(
            metadata({
              id,
              siblings: [file("config.json"), weights, file(tokenizer)],
            }),
          );

        expect((await validateCustomModel(id)).family).toBe("sensevoice");
      }
    });

    it("rejects a sensevoice repo with no tokenizer file, and names both options", async () => {
      const id = "someone/SenseVoiceSmall-4bit";
      routes[`https://huggingface.co/api/models/${id}?blobs=true`] = () =>
        json(metadata({ id, siblings: [file("config.json"), weights] }));
      routes[FILE_URL("config.json", id)] = () => json(SENSEVOICE);

      expect((await failure(id)).extra).toEqual({
        missing: ["chn_jpn_yue_eng_ko_spectok.bpe.model or tokens.json"],
      });
    });

    it("accepts a parakeet repo with only config.json and weights", async () => {
      const id = "someone/parakeet-tdt-0.6b-v2";
      routes[`https://huggingface.co/api/models/${id}?blobs=true`] = () =>
        json(metadata({ id, siblings: [file("config.json"), weights] }));
      routes[FILE_URL("config.json", id)] = () => json({ target: {} });

      expect((await validateCustomModel(id)).family).toBe("parakeet");
    });

    it("checks weights before family files", async () => {
      serveRepo({ siblings: [file("config.json")] });

      expect((await failure(HF_ID)).code).toBe("no_weights");
    });
  });

  describe("step 10: size", () => {
    it("accepts exactly 8 GiB and rejects one byte more", async () => {
      const gib8 = 8 * 1024 ** 3;
      serveRepo(
        {
          siblings: [
            { rfilename: "config.json", size: 10 },
            { rfilename: "model.safetensors", size: gib8 - 10 },
          ],
        },
        PARAKEET,
      );
      expect((await validateCustomModel(HF_ID)).totalBytes).toBe(gib8);

      serveRepo(
        {
          siblings: [
            { rfilename: "config.json", size: 11 },
            { rfilename: "model.safetensors", size: gib8 - 10 },
          ],
        },
        PARAKEET,
      );
      const err = await failure(HF_ID);
      expect(err.code).toBe("too_large");
      expect(err.status).toBe(422);
    });

    it("fails with hf_error when a file has no size", async () => {
      serveRepo(
        {
          siblings: [
            { rfilename: "config.json" },
            { rfilename: "model.safetensors", size: 10 },
          ],
        },
        PARAKEET,
      );

      expect((await failure(HF_ID)).code).toBe("hf_error");
    });

    it.each([
      "../x.safetensors",
      "a/../../x",
      "/etc/passwd",
    ])("fails with hf_error for the file path %s", async (rfilename) => {
      serveRepo(
        {
          siblings: [
            { rfilename: "config.json", size: 10 },
            { rfilename: "model.safetensors", size: 10 },
            { rfilename, size: 10 },
          ],
        },
        PARAKEET,
      );

      expect((await failure(HF_ID)).code).toBe("hf_error");
    });

    it("fails with hf_error when the response has no revision", async () => {
      serveRepo({ sha: undefined });

      expect((await failure(HF_ID)).code).toBe("hf_error");
    });
  });

  describe("step 11: disk", () => {
    it("fails with no_disk and reports the need and the free bytes", async () => {
      mocks.disk.mockRejectedValue(
        new InsufficientDiskSpaceError(5_000_000_000, 1_000_000_000),
      );
      serveRepo();

      const err = await failure(HF_ID);
      expect(err.code).toBe("no_disk");
      expect(err.extra).toEqual({
        needBytes: 5_000_000_000,
        freeBytes: 1_000_000_000,
      });
    });
  });
});

describe("addCustomModel", () => {
  it("inserts the row and starts the download", async () => {
    serveRepo();

    const { id } = await addCustomModel(HF_ID);

    expect(id).toBe("custom--mlx-community--whisper-tiny-asr-fp16");
    expect(mocks.download).toHaveBeenCalledWith(id);
    const row = getDb()
      .prepare("SELECT * FROM custom_mlx_models WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row).toMatchObject({
      hf_id: HF_ID,
      display_name: "whisper-tiny-asr-fp16",
      family: "whisper",
      model_type: "whisper",
      total_bytes: 1342,
      revision: "sha-1",
    });
    expect(JSON.parse(row.files_json as string)).toHaveLength(4);
  });

  it("writes no row when validation fails", async () => {
    serveRepo({ private: true });

    await expect(addCustomModel(HF_ID)).rejects.toMatchObject({
      code: "gated",
    });

    expect(customRowCount()).toBe(0);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("rejects a second add of the same repo", async () => {
    serveRepo();
    await addCustomModel(HF_ID);

    await expect(addCustomModel(HF_ID)).rejects.toMatchObject({
      code: "already_added",
    });
    expect(customRowCount()).toBe(1);
  });
});

describe("searchMlxModels", () => {
  const SEARCH = "https://huggingface.co/api/models?";

  function serveSearch(tagged: unknown[], audio: unknown[]): void {
    routes[
      `${SEARCH}filter=mlx&pipeline_tag=automatic-speech-recognition&sort=downloads&limit=20`
    ] = () => json(tagged);
    routes[`${SEARCH}filter=mlx-audio&sort=downloads&limit=20`] = () =>
      json(audio);
  }

  it("merges both queries, dedupes by id and sorts by downloads", async () => {
    serveSearch(
      [
        {
          id: "mlx-community/parakeet-tdt-0.6b-v3",
          downloads: 2_149_552,
          pipeline_tag: "automatic-speech-recognition",
          likes: 5,
        },
        {
          id: "a/dup",
          downloads: 10,
          pipeline_tag: "automatic-speech-recognition",
        },
      ],
      [
        { id: "mlx-community/Qwen3-ASR-0.6B-8bit", downloads: 222_309 },
        {
          id: "a/dup",
          downloads: 10,
          pipeline_tag: "automatic-speech-recognition",
        },
        {
          id: "mlx-community/Qwen3-TTS-x",
          downloads: 999_999_999,
          pipeline_tag: "text-to-speech",
        },
      ],
    );

    expect(await searchMlxModels()).toEqual([
      {
        id: "mlx-community/parakeet-tdt-0.6b-v3",
        downloads: 2_149_552,
        pipeline_tag: "automatic-speech-recognition",
      },
      {
        id: "mlx-community/Qwen3-ASR-0.6B-8bit",
        downloads: 222_309,
        pipeline_tag: null,
      },
      {
        id: "a/dup",
        downloads: 10,
        pipeline_tag: "automatic-speech-recognition",
      },
    ]);
  });

  it("adds the search text to both queries", async () => {
    routes[
      `${SEARCH}filter=mlx&pipeline_tag=automatic-speech-recognition&sort=downloads&limit=20&search=qwen3`
    ] = () => json([]);
    routes[`${SEARCH}filter=mlx-audio&sort=downloads&limit=20&search=qwen3`] =
      () => json([{ id: "mlx-community/Qwen3-ASR-0.6B-8bit", downloads: 1 }]);

    const hits = await searchMlxModels("qwen3");

    expect(hits.map((h) => h.id)).toEqual([
      "mlx-community/Qwen3-ASR-0.6B-8bit",
    ]);
  });

  it("returns at most 20 hits", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `a/m${i}`,
      downloads: i,
      pipeline_tag: "automatic-speech-recognition",
    }));
    const more = Array.from({ length: 20 }, (_, i) => ({
      id: `b/m${i}`,
      downloads: 100 + i,
    }));
    serveSearch(many, more);

    expect(await searchMlxModels()).toHaveLength(20);
  });

  it("skips entries without an id", async () => {
    serveSearch([{ downloads: 3 }, "x", null], []);

    expect(await searchMlxModels()).toEqual([]);
  });

  it("maps a network failure to offline and a 5xx to hf_error", async () => {
    // No routes: the mock fetch rejects with a plain Error, which is a network failure.
    await expect(searchMlxModels()).rejects.toMatchObject({ code: "offline" });

    routes[
      `${SEARCH}filter=mlx&pipeline_tag=automatic-speech-recognition&sort=downloads&limit=20`
    ] = () => new Response("", { status: 503 });
    routes[`${SEARCH}filter=mlx-audio&sort=downloads&limit=20`] = () =>
      json([]);
    await expect(searchMlxModels()).rejects.toMatchObject({ code: "hf_error" });
  });
});

describe("custom model routes", () => {
  const app = createApp();

  it("POST /custom-models/validate answers with family and size, and writes nothing", async () => {
    serveRepo();

    const res = await jsonRequest(
      app,
      "POST",
      "/api/mlx-asr/custom-models/validate",
      { model: `https://huggingface.co/${HF_ID}/tree/main` },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      hfId: HF_ID,
      family: "whisper",
      totalBytes: 1342,
      revision: "sha-1",
    });
    expect(customRowCount()).toBe(0);
  });

  it("POST /custom-models answers 201 with the id", async () => {
    serveRepo();

    const res = await jsonRequest(app, "POST", "/api/mlx-asr/custom-models", {
      model: HF_ID,
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: "custom--mlx-community--whisper-tiny-asr-fp16",
    });
    expect(customRowCount()).toBe(1);
  });

  it("answers { error, code } with the code status and the extra fields", async () => {
    const id = "mlx-community/some-voice";
    routes[`https://huggingface.co/api/models/${id}?blobs=true`] = () =>
      json(metadata({ id }));
    routes[FILE_URL("config.json", id)] = () => json({ model_type: "voxtral" });

    const res = await jsonRequest(app, "POST", "/api/mlx-asr/custom-models", {
      model: id,
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: "unsupported_family",
      modelType: "voxtral",
    });
  });

  it("answers missing_files with the list of missing files", async () => {
    serveRepo({
      siblings: [
        { rfilename: "config.json", size: 10 },
        { rfilename: "weights.npz", size: 10 },
      ],
    });

    const res = await jsonRequest(app, "POST", "/api/mlx-asr/custom-models", {
      model: HF_ID,
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: "missing_files",
      missing: ["preprocessor_config.json", "tokenizer.json"],
    });
    expect(customRowCount()).toBe(0);
  });

  it("answers invalid_input for a body that fails the schema", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      "/api/mlx-asr/custom-models/validate",
      { model: "   " },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: "invalid_input",
    });
  });

  it("GET /status lists a custom model with its snapshot, curated ones without", async () => {
    insertCustomModel({
      hfId: HF_ID,
      family: "whisper",
      modelType: "whisper",
      totalBytes: 10,
      revision: "sha-1",
      files: [{ path: "config.json", size: 2 }],
    });

    const res = await app.request("/api/mlx-asr/status");
    const body = (await res.json()) as {
      modelDefinitions: { id: string; custom?: unknown }[];
    };

    // The route lists models only on Apple Silicon.
    if (process.platform === "darwin" && process.arch === "arm64") {
      const byId = new Map(body.modelDefinitions.map((d) => [d.id, d]));
      expect(
        byId.get("custom--mlx-community--whisper-tiny-asr-fp16")?.custom,
      ).toEqual({
        revision: "sha-1",
        files: [{ path: "config.json", size: 2 }],
      });
      expect(byId.get("sensevoice-small")).not.toHaveProperty("custom");
    } else {
      expect(body.modelDefinitions).toEqual([]);
    }
  });

  it("GET /search answers the merged hits", async () => {
    routes[
      "https://huggingface.co/api/models?filter=mlx&pipeline_tag=automatic-speech-recognition&sort=downloads&limit=20&search=whisper"
    ] = () =>
      json([
        {
          id: "a/b",
          downloads: 7,
          pipeline_tag: "automatic-speech-recognition",
        },
      ]);
    routes[
      "https://huggingface.co/api/models?filter=mlx-audio&sort=downloads&limit=20&search=whisper"
    ] = () => json([]);

    const res = await app.request("/api/mlx-asr/search?q=whisper");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "a/b", downloads: 7, pipeline_tag: "automatic-speech-recognition" },
    ]);
  });

  it("GET /search answers offline when Hugging Face is unreachable", async () => {
    const res = await app.request("/api/mlx-asr/search?q=x");

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "offline" });
  });
});
