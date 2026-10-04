import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The real server module would start a process. Fake it and record the calls.
const stopServerIfLoaded = vi.hoisted(() => vi.fn());
const stopServer = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/whisper/server.js", () => ({
  startInBackground: vi.fn(),
  stopServer,
  stopServerIfLoaded,
}));

const ORIGINAL_HOME = process.env.HOME;
let homeDir = "";
let modelPath = "";

describe("DELETE /models/:model on the whisper routes", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openstyle-whisper-delete-"));
    process.env.HOME = homeDir;
    const dir = join(homeDir, ".cache", "freestyle", "whisper-models");
    mkdirSync(dir, { recursive: true });
    modelPath = join(dir, "ggml-base-q5_1.bin");
  });

  afterAll(() => {
    process.env.HOME = ORIGINAL_HOME;
    rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    stopServerIfLoaded.mockReset();
    stopServer.mockReset();
    writeFileSync(modelPath, "");
  });

  it("asks the server to stop only for this model, before the file is removed", async () => {
    let existedAtStop = false;
    stopServerIfLoaded.mockImplementation(async () => {
      existedAtStop = existsSync(modelPath);
    });

    const { default: whisper } = await import("../src/routes/whisper.js");
    const res = await whisper.request("/models/base-q5_1", {
      method: "DELETE",
    });

    expect(await res.json()).toEqual({ ok: true });
    expect(stopServerIfLoaded).toHaveBeenCalledWith("base-q5_1");
    expect(existedAtStop).toBe(true);
    expect(existsSync(modelPath)).toBe(false);
  });

  it("never stops the whole server when a model is deleted", async () => {
    const { default: whisper } = await import("../src/routes/whisper.js");
    await whisper.request("/models/base-q5_1", { method: "DELETE" });

    expect(stopServer).not.toHaveBeenCalled();
  });
});

describe("stopServerIfLoaded", () => {
  it("does nothing when no server is loaded", async () => {
    const actual = await vi.importActual<
      typeof import("../src/lib/whisper/server.js")
    >("../src/lib/whisper/server.js");
    await expect(
      actual.stopServerIfLoaded("base-q5_1"),
    ).resolves.toBeUndefined();
  });
});
