// The Ask page settings (specs/meeting-chat-agent.md 2.9). Rule 1: each knob
// is read by the code at the moment of use. The tests write a value to the
// database and see the reader return it. Also the validators of the keys, and
// the env flag of the native tool calls that the LLM worker gets at start.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_SETTING_LIMITS, SETTINGS_KEYS } from "@openstyle/validations";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  FAKE_LLM_WORKER_SOURCE,
  writeFakeLlmWorker,
} from "./helpers/fake-llm-worker.js";
import { jsonRequest } from "./helpers/http.js";

vi.mock("../src/lib/mlx-asr/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/constants.js")>()),
  isAppleSiliconMac: () => true,
}));

import createApp from "../src/index.js";
import { readChatSettings } from "../src/lib/chat/settings.js";
import { deleteSetting, writeSetting } from "../src/lib/db.js";
import { hfRepoCacheDir } from "../src/lib/mlx-asr/constants.js";
import { getMlxLlmModel } from "../src/lib/mlx-llm/constants.js";
import {
  ensureMlxLlmWorker,
  stopMlxLlmWorker,
} from "../src/lib/mlx-llm/server.js";

const app = createApp();
const K = SETTINGS_KEYS;
const L = CHAT_SETTING_LIMITS;

const ALL_KEYS = [
  K.meetingChatEnabled,
  K.chatRounds,
  K.chatSourceBudget,
  K.chatRetrievalK,
  K.chatDeadlineSeconds,
  K.chatSearchWider,
  K.chatNativeTools,
];

afterEach(() => {
  for (const key of ALL_KEYS) deleteSetting(key);
});

describe("readChatSettings", () => {
  it("returns the defaults when no row exists", () => {
    expect(readChatSettings()).toEqual({
      rounds: L.rounds.default,
      sourceBudget: L.sourceBudget.default,
      k: L.k.default,
      deadlineMs: L.deadlineSeconds.default * 1000,
      searchWider: true,
      nativeTools: true,
      enabled: false,
    });
  });

  it("reads each knob fresh: a value in the database changes the result", () => {
    writeSetting(K.chatRounds, "5");
    expect(readChatSettings().rounds).toBe(5);
    writeSetting(K.chatRounds, "2");
    expect(readChatSettings().rounds).toBe(2);
    writeSetting(K.chatSourceBudget, "9000");
    expect(readChatSettings().sourceBudget).toBe(9000);
    writeSetting(K.chatRetrievalK, "12");
    expect(readChatSettings().k).toBe(12);
    writeSetting(K.chatDeadlineSeconds, "90");
    expect(readChatSettings().deadlineMs).toBe(90_000);
    writeSetting(K.chatSearchWider, "false");
    expect(readChatSettings().searchWider).toBe(false);
    writeSetting(K.chatNativeTools, "false");
    expect(readChatSettings().nativeTools).toBe(false);
    writeSetting(K.meetingChatEnabled, "true");
    expect(readChatSettings().enabled).toBe(true);
    // A removed row gives the default again.
    deleteSetting(K.chatRounds);
    expect(readChatSettings().rounds).toBe(L.rounds.default);
  });

  it("clamps values outside the range", () => {
    writeSetting(K.chatRounds, "99");
    writeSetting(K.chatSourceBudget, "10");
    writeSetting(K.chatRetrievalK, "-4");
    writeSetting(K.chatDeadlineSeconds, "100000");
    const s = readChatSettings();
    expect(s.rounds).toBe(L.rounds.max);
    expect(s.sourceBudget).toBe(L.sourceBudget.min);
    expect(s.k).toBe(L.k.min);
    expect(s.deadlineMs).toBe(L.deadlineSeconds.max * 1000);
  });

  it("falls back to the default for a bad string", () => {
    writeSetting(K.chatRounds, "many");
    writeSetting(K.chatSourceBudget, "");
    writeSetting(K.chatRetrievalK, "NaN");
    writeSetting(K.chatDeadlineSeconds, "Infinity");
    const s = readChatSettings();
    expect(s.rounds).toBe(L.rounds.default);
    expect(s.sourceBudget).toBe(L.sourceBudget.default);
    expect(s.k).toBe(L.k.default);
    expect(s.deadlineMs).toBe(L.deadlineSeconds.default * 1000);
  });

  it("only the exact values turn a flag", () => {
    writeSetting(K.meetingChatEnabled, "1");
    expect(readChatSettings().enabled).toBe(false);
    writeSetting(K.chatSearchWider, "no");
    expect(readChatSettings().searchWider).toBe(true);
  });
});

describe("validators of the Ask keys (PUT /api/settings/:key)", () => {
  const put = (key: string, value: string) =>
    jsonRequest(app, "PUT", `/api/settings/${key}`, { value });

  it("accepts a value in the range and an empty value", async () => {
    expect((await put(K.chatRounds, "4")).status).toBe(200);
    expect((await put(K.chatDeadlineSeconds, "180")).status).toBe(200);
    expect((await put(K.chatSourceBudget, "")).status).toBe(200);
    expect((await put(K.chatSearchWider, "false")).status).toBe(200);
    expect((await put(K.meetingChatEnabled, "true")).status).toBe(200);
  });

  it("rejects a value out of range with a message that names the range", async () => {
    for (const [key, value] of [
      [K.chatRounds, "6"],
      [K.chatRounds, "0"],
      [K.chatRetrievalK, "2"],
      [K.chatRetrievalK, "21"],
      [K.chatSourceBudget, "1999"],
      [K.chatDeadlineSeconds, "19"],
      [K.chatDeadlineSeconds, "181"],
      [K.chatRounds, "2.5"],
      [K.chatRounds, "abc"],
    ] as const) {
      const res = await put(key, value);
      expect(res.status, `${key}=${value}`).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/whole number from \d+ to \d+/);
    }
  });

  it("rejects a flag that is not true or false", async () => {
    for (const key of [
      K.meetingChatEnabled,
      K.chatSearchWider,
      K.chatNativeTools,
    ]) {
      expect((await put(key, "yes")).status).toBe(400);
    }
  });
});

describe("native tools flag of the LLM worker", () => {
  let scratch = "";
  let log = "";
  const saved = {
    hf: process.env.HUGGINGFACE_HUB_CACHE,
    worker: process.env.OPENSTYLE_MLX_LLM_WORKER,
    ram: process.env.OPENSTYLE_MLX_LLM_FIT_RAM_GIB,
  };

  beforeAll(() => {
    vi.useRealTimers();
    scratch = mkdtempSync(join(tmpdir(), "openstyle-chat-env-"));
    log = join(scratch, "worker.log");
    process.env.HUGGINGFACE_HUB_CACHE = join(scratch, "hf");
    // The fake worker of the other tests, plus the flag in its start line.
    const path = writeFakeLlmWorker(scratch);
    writeFileSync(
      path,
      FAKE_LLM_WORKER_SOURCE.replace(
        "log({ start: true, args });",
        "log({ start: true, args, native_tools: process.env.OPENSTYLE_MLX_LLM_NATIVE_TOOLS ?? null });",
      ),
      { mode: 0o755 },
    );
    process.env.OPENSTYLE_MLX_LLM_WORKER = path;
    process.env.FAKE_LLM_LOG = log;
    process.env.OPENSTYLE_MLX_LLM_FIT_RAM_GIB = "128";
    const def = getMlxLlmModel("gemma-4-e2b-qat-4bit");
    if (!def) throw new Error("catalog");
    const snap = join(hfRepoCacheDir(def.hfId), "snapshots", "abc123");
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(snap, "config.json"), "{}");
    writeFileSync(join(snap, "model.safetensors"), "w");
  });

  afterEach(async () => {
    await stopMlxLlmWorker();
    delete process.env.OPENSTYLE_MLX_LLM_NATIVE_TOOLS;
  });

  afterAll(() => {
    for (const [key, value] of [
      ["HUGGINGFACE_HUB_CACHE", saved.hf],
      ["OPENSTYLE_MLX_LLM_WORKER", saved.worker],
      ["OPENSTYLE_MLX_LLM_FIT_RAM_GIB", saved.ram],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.FAKE_LLM_LOG;
    rmSync(scratch, { recursive: true, force: true });
  });

  async function startedFlag(): Promise<string | null> {
    if (existsSync(log)) rmSync(log);
    await ensureMlxLlmWorker("gemma-4-e2b-qat-4bit");
    const starts = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as { start?: boolean; native_tools?: string | null },
      )
      .filter((e) => e.start);
    expect(starts).toHaveLength(1);
    return starts[0]?.native_tools ?? null;
  }

  it("passes the flag when the Ask tab is on and native tools are not off", async () => {
    writeSetting(K.meetingChatEnabled, "true");
    expect(await startedFlag()).toBe("1");
  });

  it("passes no flag when the Ask tab is off", async () => {
    expect(await startedFlag()).toBeNull();
  });

  it("passes no flag when native tools are off", async () => {
    writeSetting(K.meetingChatEnabled, "true");
    writeSetting(K.chatNativeTools, "false");
    expect(await startedFlag()).toBeNull();
  });

  it("a change while the worker runs applies at the next start", async () => {
    writeSetting(K.meetingChatEnabled, "true");
    expect(await startedFlag()).toBe("1");
    writeSetting(K.chatNativeTools, "false");
    await stopMlxLlmWorker();
    expect(await startedFlag()).toBeNull();
  });
});
