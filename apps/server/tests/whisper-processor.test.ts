import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fillWhisperProcessor,
  tokenizerLength,
  whisperProcessorSource,
} from "../src/lib/mlx-asr/whisper-processor.js";
import {
  fakeTokenizer,
  TOKENIZER_FOR_N_VOCAB,
} from "./helpers/whisper-tokenizer.js";

const OLD_LAYOUT = ["config.json", "weights.npz"];

describe("whisperProcessorSource", () => {
  it.each([
    [51864, 80, "openai/whisper-tiny.en"],
    [51865, 80, "openai/whisper-tiny"],
    [51866, 128, "openai/whisper-large-v3-turbo"],
  ])("maps n_vocab %i with n_mels %i to %s", (n_vocab, n_mels, repo) => {
    const source = whisperProcessorSource({ n_vocab, n_mels }, OLD_LAYOUT);

    expect(source?.repo).toBe(repo);
    expect(source?.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(source?.files.map((f) => f.path)).toEqual([
      "preprocessor_config.json",
      "tokenizer.json",
      "tokenizer_config.json",
    ]);
  });

  it.each([
    ["an n_vocab outside the classes", { n_vocab: 51867, n_mels: 128 }],
    ["an n_mels that does not match the class", { n_vocab: 51866, n_mels: 80 }],
    [
      "an n_mels that does not match the class (80-mel vocab)",
      { n_vocab: 51865, n_mels: 128 },
    ],
    ["no n_vocab", { n_mels: 80 }],
    ["no n_mels", { n_vocab: 51865 }],
    ["an n_vocab that is a string", { n_vocab: "51865", n_mels: 80 }],
    [
      "the keys of a transformers config",
      { vocab_size: 51865, num_mel_bins: 80 },
    ],
  ])("returns null for %s", (_name, config) => {
    expect(whisperProcessorSource(config, OLD_LAYOUT)).toBeNull();
  });

  it.each([
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
  ])("returns null when the repo has %s", (name) => {
    expect(
      whisperProcessorSource({ n_vocab: 51865, n_mels: 80 }, [
        ...OLD_LAYOUT,
        name,
      ]),
    ).toBeNull();
  });
});

describe("tokenizerLength", () => {
  it.each([
    [50257, 1608, 1, 51864],
    [50258, 1608, 1, 51865],
    [50257, 1609, 0, 51866],
  ])("counts vocab %i, added %i and overlap %i as %i", (vocab, added, overlap, length) => {
    expect(
      tokenizerLength(JSON.parse(fakeTokenizer(vocab, added, overlap))),
    ).toBe(length);
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["no model", { added_tokens: [] }],
    ["no added_tokens", { model: { vocab: {} } }],
  ])("returns null for %s", (_name, value) => {
    expect(tokenizerLength(value)).toBeNull();
  });
});

describe("fillWhisperProcessor", () => {
  let dir = "";
  let urls: string[] = [];
  let tokenizer = "";

  function writeConfig(config: unknown): void {
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "whisper-fill-"));
    urls = [];
    tokenizer = TOKENIZER_FOR_N_VOCAB[51866]();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        return new Response(
          url.endsWith("/tokenizer.json") ? tokenizer : `{"file":"${url}"}`,
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the three files from the pinned revision", async () => {
    writeConfig({ n_vocab: 51866, n_mels: 128 });

    await fillWhisperProcessor(dir, new AbortController().signal);

    const revision = whisperProcessorSource(
      { n_vocab: 51866, n_mels: 128 },
      [],
    )?.revision;
    expect(urls.sort()).toEqual(
      [
        "preprocessor_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
      ].map(
        (file) =>
          `https://huggingface.co/openai/whisper-large-v3-turbo/resolve/${revision}/${file}`,
      ),
    );
    expect(readFileSync(join(dir, "tokenizer.json"), "utf8")).toBe(tokenizer);
    expect(readFileSync(join(dir, "tokenizer_config.json"), "utf8")).toContain(
      "tokenizer_config.json",
    );
    expect(lstatSync(join(dir, "preprocessor_config.json")).isFile()).toBe(
      true,
    );
  });

  it("refuses a tokenizer of the wrong class and writes nothing", async () => {
    // The turbo model needs 51866 tokens. The tiny tokenizer has 51865.
    writeConfig({ n_vocab: 51866, n_mels: 128 });
    tokenizer = TOKENIZER_FOR_N_VOCAB[51865]();

    await expect(
      fillWhisperProcessor(dir, new AbortController().signal),
    ).rejects.toThrow(/has 51865 tokens\. The model needs 51866/);

    expect(() => lstatSync(join(dir, "tokenizer.json"))).toThrow();
    expect(() => lstatSync(join(dir, "preprocessor_config.json"))).toThrow();
  });

  it("refuses a tokenizer file that is not a tokenizer", async () => {
    writeConfig({ n_vocab: 51865, n_mels: 80 });
    tokenizer = "not json";

    await expect(
      fillWhisperProcessor(dir, new AbortController().signal),
    ).rejects.toThrow(/an unknown number of tokens/);
  });

  it("refuses a model outside the classes without a request", async () => {
    writeConfig({ n_vocab: 51867, n_mels: 128 });

    await expect(
      fillWhisperProcessor(dir, new AbortController().signal),
    ).rejects.toThrow(/no standard tokenizer/);

    expect(urls).toEqual([]);
  });

  it("does nothing when the repo has its own processor file", async () => {
    // A symlink is a file of the repo. Config would not even match a class.
    writeConfig({ n_vocab: 1, n_mels: 1 });
    mkdirSync(join(dir, "blobs"));
    writeFileSync(join(dir, "blobs", "t"), "{}");
    symlinkSync(join(dir, "blobs", "t"), join(dir, "tokenizer.json"));

    await fillWhisperProcessor(dir, new AbortController().signal);

    expect(urls).toEqual([]);
  });

  it("fills again over plain files that an earlier run left", async () => {
    writeConfig({ n_vocab: 51866, n_mels: 128 });
    writeFileSync(join(dir, "tokenizer.json"), "old");

    await fillWhisperProcessor(dir, new AbortController().signal);

    expect(readFileSync(join(dir, "tokenizer.json"), "utf8")).toBe(tokenizer);
  });

  it("fails on an answer that is not 200", async () => {
    writeConfig({ n_vocab: 51866, n_mels: 128 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 })),
    );

    await expect(
      fillWhisperProcessor(dir, new AbortController().signal),
    ).rejects.toThrow(/answered 503/);
  });

  it("follows a redirect on huggingface.co and refuses another host", async () => {
    writeConfig({ n_vocab: 51866, n_mels: 128 });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/x" },
          }),
      ),
    );

    await expect(
      fillWhisperProcessor(dir, new AbortController().signal),
    ).rejects.toThrow(/Unexpected redirect/);
  });

  it("stops when the signal aborts", async () => {
    writeConfig({ n_vocab: 51866, n_mels: 128 });
    const ctrl = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        ctrl.abort();
        init?.signal?.throwIfAborted();
        return new Response("x");
      }),
    );

    await expect(fillWhisperProcessor(dir, ctrl.signal)).rejects.toThrow();

    expect(() => lstatSync(join(dir, "tokenizer.json"))).toThrow();
  });
});
