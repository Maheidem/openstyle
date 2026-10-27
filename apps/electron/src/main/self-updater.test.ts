import { beforeEach, describe, expect, it, vi } from "vitest";

// The self-updater must download the version that the check found, from the
// release tag of that version, never from releases/latest.

const RELEASES = "http://127.0.0.1:5999/Maheidem/openstyle/releases";
const running = { version: "2.24.0" };

vi.mock("@openstyle/utils", () => ({
  createAppLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => running.version,
    getPath: () => "/tmp/openstyle-self-updater-test",
    isPackaged: false,
    quit: () => {},
  },
}));

const manifestUrls: string[] = [];
const zipUrls: string[] = [];

vi.mock("./self-updater-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./self-updater-core")>();
  return {
    ...actual,
    fetchLatestManifest: async (url: string) => {
      manifestUrls.push(url);
      const version = /\/download\/([^/]+)\/latest-mac\.yml$/.exec(url)?.[1];
      return {
        version: version ?? "unknown",
        files: [{ url: `Openstyle-${version}-arm64.zip`, sha512: "abc" }],
      };
    },
    downloadAndVerify: async (url: string) => {
      zipUrls.push(url);
    },
  };
});

async function load() {
  vi.resetModules();
  vi.stubEnv("OPENSTYLE_E2E", "1");
  vi.stubEnv("OPENSTYLE_E2E_RELEASES_URL", RELEASES);
  vi.stubEnv("OPENSTYLE_E2E_APP_VERSION", "");
  return (await import("./self-updater")).selfUpdater;
}

beforeEach(() => {
  manifestUrls.length = 0;
  zipUrls.length = 0;
  running.version = "2.24.0";
});

describe("selfUpdater.downloadUpdate", () => {
  it("reads the feed file and the zip of the found version, by its tag", async () => {
    const updater = await load();
    const done = vi.fn();
    updater.on("downloaded", done);
    await updater.downloadUpdate("2.25.0-alpha.1");
    expect(manifestUrls).toEqual([
      `${RELEASES}/download/2.25.0-alpha.1/latest-mac.yml`,
    ]);
    expect(zipUrls[0]).toBe(
      `${RELEASES}/download/2.25.0-alpha.1/Openstyle-2.25.0-alpha.1-arm64.zip`,
    );
    expect(manifestUrls.concat(zipUrls).join(" ")).not.toContain("/latest/");
    expect(done).toHaveBeenCalledWith({ version: "2.25.0-alpha.1" });
  });

  it("refuses a version that is not newer", async () => {
    const updater = await load();
    await expect(updater.downloadUpdate("2.23.0")).rejects.toThrow(/not newer/);
    await expect(updater.downloadUpdate("2.24.0")).rejects.toThrow(
      /already installed/,
    );
    expect(zipUrls).toEqual([]);
  });

  it("downloads an older Stable version only with allowOlder (the switch to Stable)", async () => {
    running.version = "2.25.0-alpha.1";
    const updater = await load();
    await updater.downloadUpdate("2.24.0", { allowOlder: true });
    expect(zipUrls[0]).toBe(
      `${RELEASES}/download/2.24.0/Openstyle-2.24.0-arm64.zip`,
    );
    expect(updater.isReadyToInstall).toBe(true);
  });

  it("a discarded download ends without a downloaded event", async () => {
    const updater = await load();
    const done = vi.fn();
    updater.on("downloaded", done);
    const download = updater.downloadUpdate("2.25.0-alpha.1");
    updater.discardDownload();
    await download;
    expect(done).not.toHaveBeenCalled();
    expect(updater.isReadyToInstall).toBe(false);
  });
});
