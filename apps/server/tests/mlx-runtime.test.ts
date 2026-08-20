import { createHash } from "node:crypto";
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
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MLX_ASR_MODELS } from "../src/lib/mlx-asr/constants.js";

const ORIGINAL_ENV = { ...process.env };

let homeDir = "";
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function mlxCacheRoot(): string {
  return join(homeDir, ".cache", "freestyle", "mlx-asr");
}

function runtimeRoot(): string {
  return join(mlxCacheRoot(), "runtime", `${process.platform}-${process.arch}`);
}

function stagingRoot(releaseTag: string): string {
  return join(
    mlxCacheRoot(),
    "staging",
    `${process.platform}-${process.arch}`,
    releaseTag,
  );
}

function writeManagedRuntime(
  version?: string | null,
  options?: { workerContent?: string; syncedAppVersion?: string | null },
): void {
  const root = runtimeRoot();
  const workerDir = join(root, "mlx_asr_worker");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(
    join(workerDir, "mlx_asr_worker"),
    options?.workerContent ?? "worker",
  );

  if (version !== undefined) {
    writeFileSync(
      join(root, "metadata.json"),
      JSON.stringify(
        {
          downloadedAt: "2026-06-03T00:00:00.000Z",
          sourceUrl: "https://example.com/mlx_asr_worker-darwin-arm64.tar.gz",
          workerVersion: version,
          syncedAppVersion: options?.syncedAppVersion ?? null,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}

function seedMlxModelDownloaded(): void {
  const model = MLX_ASR_MODELS[0]!;
  const snapshotDir = join(
    homeDir,
    ".cache",
    "huggingface",
    "hub",
    `models--${model.hfId.replaceAll("/", "--")}`,
    "snapshots",
    "test-snapshot",
  );
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, "config.json"), "{}");
}

function writeStagedRuntime(
  releaseTag: string,
  workerContent = "staged-worker",
): void {
  const workerDir = join(stagingRoot(releaseTag), "mlx_asr_worker");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "mlx_asr_worker"), workerContent);
}

function deriveBundledVersion(): string {
  const script = readFileSync(
    join(TEST_DIR, "..", "..", "..", "scripts", "mlx_asr_server.py"),
    "utf8",
  );
  return createHash("sha256")
    .update(
      "pyinstaller=6.20.0;mlx-audio=0.4.3;huggingface_hub=1.17.0;transformers>=5.7,<5.13;bundle=onedir",
    )
    .update("\0")
    .update(script)
    .digest("hex")
    .slice(0, 16);
}

interface FakeLogger {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function fakeLogger(): FakeLogger {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

/**
 * Imports a fresh copy of runtime.ts with `isAppleSiliconMac` forced true,
 * `execFileSync` (used for the real `tar xzf` extraction) replaced by a spy
 * so tests can assert whether extraction ran without touching the real
 * filesystem beyond the archive, and `createAppLogger` replaced so
 * integrity-verification warnings/errors can be asserted on directly.
 */
async function importRuntime(): Promise<{
  runtime: typeof import("../src/lib/mlx-asr/runtime.js");
  execFileSyncSpy: ReturnType<typeof vi.fn>;
  log: FakeLogger;
}> {
  vi.doMock("../src/lib/mlx-asr/constants.js", async () => {
    const actual = await vi.importActual<
      typeof import("../src/lib/mlx-asr/constants.js")
    >("../src/lib/mlx-asr/constants.js");
    return {
      ...actual,
      isAppleSiliconMac: () => true,
    };
  });

  const execFileSyncSpy = vi.fn();
  vi.doMock("node:child_process", async () => {
    const actual =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    return { ...actual, execFileSync: execFileSyncSpy };
  });

  const log = fakeLogger();
  vi.doMock("@openstyle/utils", () => ({
    createAppLogger: () => log,
    enableFileLogging: vi.fn(),
    traceLog: vi.fn(),
  }));

  const runtime = await import("../src/lib/mlx-asr/runtime.js");
  return { runtime, execFileSyncSpy, log };
}

/** sha256 of `bytes`, formatted the way the GitHub Releases API reports it. */
function githubDigestOf(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A minimal `GET /repos/{owner}/{repo}/releases/(tags/<tag>|latest)` body. */
function releaseApiBody(tagName: string, workerDigest: string | null): string {
  return JSON.stringify({
    tag_name: tagName,
    assets:
      workerDigest === null
        ? []
        : [
            {
              name: "mlx_asr_worker-darwin-arm64.tar.gz",
              digest: workerDigest,
            },
          ],
  });
}

/**
 * Routes a mocked global `fetch` by URL prefix. An unmatched URL throws
 * immediately with the URL in the message, rather than resolving to
 * `undefined` and surfacing later as a confusing `res.ok` TypeError — a real
 * signal that the code under test hit a request this test didn't expect.
 */
function routedFetch(
  routes: [string, () => Response | Promise<Response>][],
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return handler();
    }
    throw new Error(`Unexpected fetch to unmocked URL: ${url}`);
  });
}

/** Makes `execFileSync("tar", ["xzf", archive, "-C", destDir], ...)` behave like a real extraction that produces a worker binary. */
function simulateSuccessfulExtraction(
  execFileSyncSpy: ReturnType<typeof vi.fn>,
  workerContent = "extracted-worker-binary",
): void {
  execFileSyncSpy.mockImplementation((_cmd: string, args: string[]) => {
    const destDir = args[3]!;
    const workerDir = join(destDir, "mlx_asr_worker");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "mlx_asr_worker"), workerContent);
    return Buffer.from("");
  });
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "openstyle-mlx-runtime-"));
  process.env.HOME = homeDir;
  delete process.env.OPENSTYLE_MLX_ASR_RELEASE_TAG;
  delete process.env.FREESTYLE_MLX_ASR_RELEASE_TAG;
  delete process.env.OPENSTYLE_MLX_ASR_WORKER_URL;
  delete process.env.FREESTYLE_MLX_ASR_WORKER_URL;
  delete process.env.OPENSTYLE_MLX_ASR_WORKER_VERSION;
  delete process.env.FREESTYLE_MLX_ASR_WORKER_VERSION;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("../src/lib/mlx-asr/constants.js");
  vi.doUnmock("node:child_process");
  vi.doUnmock("@openstyle/utils");
  restoreEnv();
  if (homeDir) {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

describe("MLX runtime versioning", () => {
  it("derives the runtime download URL from the current app release version", async () => {
    process.env.OPENSTYLE_MLX_ASR_RELEASE_TAG = "0.9.0";

    const { runtime } = await importRuntime();

    expect(runtime.getMlxRuntimeDownloadStatus().url).toBe(
      "https://github.com/Maheidem/openstyle/releases/download/0.9.0/mlx_asr_worker-darwin-arm64.tar.gz",
    );
  });

  it("skips re-downloading when the installed worker already matches the app release", async () => {
    process.env.OPENSTYLE_MLX_ASR_WORKER_VERSION = "0.9.0";
    writeManagedRuntime("0.9.0");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { runtime } = await importRuntime();

    expect(runtime.needsManagedMlxRuntimeUpdate()).toBe(false);
    await expect(runtime.ensureMlxRuntimeDownloaded()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes the managed worker when the app release version changes", async () => {
    process.env.OPENSTYLE_MLX_ASR_WORKER_VERSION = "0.9.1";
    writeManagedRuntime("0.9.0");
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(new Error("runtime download failed"));
    vi.stubGlobal("fetch", fetchSpy);

    const { runtime } = await importRuntime();

    expect(runtime.needsManagedMlxRuntimeUpdate()).toBe(true);
    await expect(runtime.ensureMlxRuntimeDownloaded()).rejects.toThrow(
      "runtime download failed",
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://github.com/Maheidem/openstyle/releases/download/0.9.1/mlx_asr_worker-darwin-arm64.tar.gz",
      expect.objectContaining({ redirect: "follow" }),
    );
  });

  it("does not attempt a managed-runtime update until a worker has been installed once", async () => {
    process.env.OPENSTYLE_MLX_ASR_WORKER_VERSION = "0.9.1";

    const { runtime } = await importRuntime();

    expect(runtime.needsManagedMlxRuntimeUpdate()).toBe(false);
    await expect(runtime.updateManagedMlxRuntimeIfNeeded()).resolves.toBe(
      false,
    );
  });

  it("does not re-download the managed runtime when the app release changes but the worker build is unchanged", async () => {
    process.env.OPENSTYLE_MLX_ASR_RELEASE_TAG = "0.9.2";
    writeManagedRuntime(deriveBundledVersion());
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { runtime } = await importRuntime();

    expect(runtime.needsManagedMlxRuntimeUpdate()).toBe(false);
    await expect(runtime.updateManagedMlxRuntimeIfNeeded()).resolves.toBe(
      false,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("promotes a staged worker into the active runtime on app version activation", async () => {
    seedMlxModelDownloaded();
    const bundledVersion = deriveBundledVersion();
    writeManagedRuntime(bundledVersion, {
      workerContent: "active-worker",
      syncedAppVersion: "0.9.0",
    });
    writeStagedRuntime("0.9.1", "promoted-worker");

    const { runtime } = await importRuntime();

    await expect(
      runtime.activateManagedMlxRuntimeForAppVersion("0.9.1"),
    ).resolves.toBe(true);
    expect(
      readFileSync(
        join(runtimeRoot(), "mlx_asr_worker", "mlx_asr_worker"),
        "utf8",
      ),
    ).toBe("promoted-worker");
    expect(
      JSON.parse(readFileSync(join(runtimeRoot(), "metadata.json"), "utf8"))
        .syncedAppVersion,
    ).toBe("0.9.1");
    expect(existsSync(stagingRoot("0.9.1"))).toBe(false);
  });

  it("does not prefetch or activate the runtime until an MLX model is downloaded", async () => {
    process.env.OPENSTYLE_MLX_ASR_RELEASE_TAG = "0.9.0";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { runtime } = await importRuntime();

    await expect(
      runtime.prefetchManagedMlxRuntimeForAppRelease("0.9.1"),
    ).resolves.toBe(false);
    await expect(
      runtime.activateManagedMlxRuntimeForAppVersion("0.9.1"),
    ).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a helpful error when the app release is missing the worker asset", async () => {
    process.env.OPENSTYLE_MLX_ASR_RELEASE_TAG = "0.9.1";
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      body: null,
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { runtime } = await importRuntime();

    await expect(runtime.ensureMlxRuntimeDownloaded()).rejects.toThrow(
      "this Openstyle release does not include the MLX worker asset yet",
    );
  });
});

describe("MLX runtime integrity verification", () => {
  it("rejects a corrupted archive without extracting it, and leaves the previously installed worker untouched", async () => {
    process.env.OPENSTYLE_MLX_ASR_WORKER_VERSION = "9.9.1";
    writeManagedRuntime("9.9.0", { workerContent: "original-worker-bytes" });

    // The API correctly reports the digest of the genuine archive; what we
    // "download" below is corrupted/tampered — a different set of bytes.
    const legitimateDigest = githubDigestOf("legitimate-archive-bytes");
    const corruptedBytes = Buffer.from("corrupted-in-transit-bytes");

    const fetchSpy = routedFetch([
      [
        "https://api.github.com/repos/Maheidem/openstyle/releases/tags/9.9.1",
        () =>
          new Response(releaseApiBody("9.9.1", legitimateDigest), {
            status: 200,
          }),
      ],
      [
        "https://github.com/Maheidem/openstyle/releases/download/9.9.1/mlx_asr_worker-darwin-arm64.tar.gz",
        () =>
          new Response(corruptedBytes, {
            status: 200,
            headers: { "content-length": String(corruptedBytes.length) },
          }),
      ],
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const { runtime, execFileSyncSpy } = await importRuntime();

    await expect(runtime.ensureMlxRuntimeDownloaded()).rejects.toThrow(
      /integrity verification.*checksum/i,
    );

    // Not extracted: tar never ran.
    expect(execFileSyncSpy).not.toHaveBeenCalled();
    // Cleaned up: no leftover partial download.
    expect(existsSync(`${runtimeRoot()}.downloading`)).toBe(false);
    // The previously installed worker was never touched — proves the
    // verify-before-swap ordering, not just that *something* got cleaned up.
    expect(
      readFileSync(
        join(runtimeRoot(), "mlx_asr_worker", "mlx_asr_worker"),
        "utf8",
      ),
    ).toBe("original-worker-bytes");
    expect(
      JSON.parse(readFileSync(join(runtimeRoot(), "metadata.json"), "utf8"))
        .workerVersion,
    ).toBe("9.9.0");
  });

  it("extracts the archive once its sha256 matches the digest published by the GitHub Releases API", async () => {
    process.env.OPENSTYLE_MLX_ASR_WORKER_VERSION = "9.9.2";

    const archiveBytes = Buffer.from("totally-legit-worker-archive-bytes");
    const digest = githubDigestOf(archiveBytes);

    const fetchSpy = routedFetch([
      [
        "https://api.github.com/repos/Maheidem/openstyle/releases/tags/9.9.2",
        () => new Response(releaseApiBody("9.9.2", digest), { status: 200 }),
      ],
      [
        "https://github.com/Maheidem/openstyle/releases/download/9.9.2/mlx_asr_worker-darwin-arm64.tar.gz",
        () =>
          new Response(archiveBytes, {
            status: 200,
            headers: { "content-length": String(archiveBytes.length) },
          }),
      ],
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const { runtime, execFileSyncSpy } = await importRuntime();
    simulateSuccessfulExtraction(execFileSyncSpy);

    await expect(runtime.ensureMlxRuntimeDownloaded()).resolves.toBeUndefined();

    // Proves the API digest path was actually exercised, not just that
    // nothing broke — this test passes even against unpatched code
    // otherwise, since an unverified download also "succeeds".
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/repos/Maheidem/openstyle/releases/tags/9.9.2",
      expect.anything(),
    );
    expect(execFileSyncSpy).toHaveBeenCalledWith(
      "tar",
      [
        "xzf",
        expect.stringContaining("mlx_asr_worker.tar.gz"),
        "-C",
        expect.any(String),
      ],
      expect.objectContaining({ timeout: 120_000 }),
    );
    expect(
      readFileSync(
        join(runtimeRoot(), "mlx_asr_worker", "mlx_asr_worker"),
        "utf8",
      ),
    ).toBe("extracted-worker-binary");
    expect(
      JSON.parse(readFileSync(join(runtimeRoot(), "metadata.json"), "utf8"))
        .workerVersion,
    ).toBe("9.9.2");
  });

  it("falls back to the pinned digest for a known release tag when the GitHub API is unreachable", async () => {
    // "1.0.0" is the one tag hardcoded in PINNED_WORKER_DIGESTS.
    process.env.OPENSTYLE_MLX_ASR_WORKER_VERSION = "1.0.0";

    const fetchSpy = routedFetch([
      [
        "https://api.github.com/repos/Maheidem/openstyle/releases/tags/1.0.0",
        () => {
          throw new Error("network unreachable");
        },
      ],
      [
        "https://github.com/Maheidem/openstyle/releases/download/1.0.0/mlx_asr_worker-darwin-arm64.tar.gz",
        () =>
          new Response(Buffer.from("arbitrary-bytes-not-the-pinned-hash"), {
            status: 200,
            headers: { "content-length": "36" },
          }),
      ],
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const { runtime, execFileSyncSpy } = await importRuntime();

    // A "does not match" (rather than "no trusted checksum") rejection is
    // the discriminator: it proves the pinned map *did* produce a digest to
    // compare against — the API lookup just couldn't confirm it.
    await expect(runtime.ensureMlxRuntimeDownloaded()).rejects.toThrow(
      /does not match the expected checksum/i,
    );
    expect(execFileSyncSpy).not.toHaveBeenCalled();
  });

  it("falls back to the pinned latest-tag digest when downloading via releases/latest and the GitHub API is unreachable", async () => {
    // No OPENSTYLE_MLX_ASR_RELEASE_TAG / OPENSTYLE_MLX_ASR_WORKER_VERSION —
    // this is the default "releases/latest" flow, so releaseTag is null.
    const fetchSpy = routedFetch([
      [
        "https://api.github.com/repos/Maheidem/openstyle/releases/latest",
        () => {
          throw new Error("network unreachable");
        },
      ],
      [
        "https://github.com/Maheidem/openstyle/releases/latest/download/mlx_asr_worker-darwin-arm64.tar.gz",
        () =>
          new Response(Buffer.from("arbitrary-bytes-not-the-pinned-hash"), {
            status: 200,
            headers: { "content-length": "36" },
          }),
      ],
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const { runtime, execFileSyncSpy } = await importRuntime();

    await expect(runtime.ensureMlxRuntimeDownloaded()).rejects.toThrow(
      /does not match the expected checksum/i,
    );
    expect(execFileSyncSpy).not.toHaveBeenCalled();
  });

  it("refuses to extract when no trusted digest can be resolved, even though the download itself succeeded", async () => {
    process.env.OPENSTYLE_MLX_ASR_WORKER_VERSION = "9.9.3";

    const archiveBytes = Buffer.from("some-worker-archive-bytes");

    const fetchSpy = routedFetch([
      [
        "https://api.github.com/repos/Maheidem/openstyle/releases/tags/9.9.3",
        // Release exists but doesn't list this asset — distinct from a
        // network failure, and still must not verify.
        () => new Response(releaseApiBody("9.9.3", null), { status: 200 }),
      ],
      [
        "https://github.com/Maheidem/openstyle/releases/download/9.9.3/mlx_asr_worker-darwin-arm64.tar.gz",
        () =>
          new Response(archiveBytes, {
            status: 200,
            headers: { "content-length": String(archiveBytes.length) },
          }),
      ],
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const { runtime, execFileSyncSpy } = await importRuntime();

    await expect(runtime.ensureMlxRuntimeDownloaded()).rejects.toThrow(
      /no trusted checksum/i,
    );

    expect(execFileSyncSpy).not.toHaveBeenCalled();
    expect(existsSync(runtimeRoot())).toBe(false);
  });

  it("skips integrity verification and logs a loud warning when OPENSTYLE_MLX_ASR_WORKER_URL overrides the download host", async () => {
    process.env.OPENSTYLE_MLX_ASR_WORKER_URL =
      "https://example.com/custom-worker.tar.gz";

    const archiveBytes = Buffer.from("developer-supplied-worker-bytes");

    const fetchSpy = routedFetch([
      [
        "https://example.com/custom-worker.tar.gz",
        () =>
          new Response(archiveBytes, {
            status: 200,
            headers: { "content-length": String(archiveBytes.length) },
          }),
      ],
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const { runtime, execFileSyncSpy, log } = await importRuntime();
    simulateSuccessfulExtraction(execFileSyncSpy);

    await expect(runtime.ensureMlxRuntimeDownloaded()).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("OPENSTYLE_MLX_ASR_WORKER_URL"),
    );
    // The override is not our own repo, so there is nothing to look up —
    // confirm no digest-lookup call was even attempted.
    expect(
      fetchSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("api.github.com"),
      ),
    ).toBe(false);
  });
});
