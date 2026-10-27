import { AppUpdater } from "electron-updater";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyChannel,
  githubFeedOptions,
  isNewerVersion,
  isPrerelease,
  releasesUrl,
  resolveChannel,
  restartDecision,
  runningVersion,
  switchNeedsDowngrade,
} from "./update-channel";

// A real electron-updater AppUpdater with a fake app, so the tests run the
// real `channel` setter and the real version rule (isUpdateAvailable).
class TestUpdater extends AppUpdater {
  constructor(version: string) {
    super(null, {
      version,
      name: "Openstyle",
      isPackaged: true,
      appUpdateConfigPath: "/nonexistent/app-update.yml",
      userDataPath: "/nonexistent/user-data",
      baseCachePath: "/nonexistent/cache",
      whenReady: () => Promise.resolve(),
      quit: () => {},
      relaunch: () => {},
      onQuit: () => {},
    });
    this.logger = null;
  }
  protected doDownloadUpdate(): Promise<string[]> {
    return Promise.resolve([]);
  }
  quitAndInstall(): void {}
  protected doInstall(): boolean {
    return false;
  }
  /** The version rule that checkForUpdates() uses. */
  offers(version: string): Promise<boolean> {
    const info = {
      version,
      files: [],
      path: "",
      sha512: "",
      releaseDate: "",
    };
    return (
      this as unknown as {
        isUpdateAvailable: (i: typeof info) => Promise<boolean>;
      }
    ).isUpdateAvailable(info);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveChannel", () => {
  it("uses the saved channel", () => {
    expect(resolveChannel("dev", "2.24.0")).toBe("dev");
    expect(resolveChannel("stable", "2.24.0-alpha.1")).toBe("stable");
  });

  it("without a saved channel, uses the channel of the running version", () => {
    expect(resolveChannel(undefined, "2.24.0")).toBe("stable");
    expect(resolveChannel(undefined, "2.24.0-alpha.3")).toBe("dev");
  });

  it("ignores a saved value that is not a channel", () => {
    expect(resolveChannel("beta", "2.24.0")).toBe("stable");
    expect(resolveChannel(42, "2.24.0-alpha.1")).toBe("dev");
  });
});

describe("isNewerVersion", () => {
  it.each([
    ["2.24.0", "2.23.0", true],
    ["2.23.0", "2.24.0", false],
    ["2.24.0", "2.24.0", false],
    ["2.24.0-alpha.2", "2.24.0-alpha.1", true],
    ["2.24.0-alpha.1", "2.23.0", true],
    ["2.24.0", "2.24.0-alpha.5", true],
    ["2.24.0-alpha.5", "2.24.0", false],
    ["2.23.0", "2.24.0-alpha.1", false],
    ["2.24.0-alpha.10", "2.24.0-alpha.9", true],
    ["not-a-version", "2.24.0", false],
  ])("%s newer than %s: %s", (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected);
  });
});

describe("isPrerelease and switchNeedsDowngrade", () => {
  it("finds the alpha suffix", () => {
    expect(isPrerelease("2.24.0-alpha.1")).toBe(true);
    expect(isPrerelease("2.24.0")).toBe(false);
  });

  it("only the switch to Stable from an alpha build downgrades", () => {
    expect(switchNeedsDowngrade("stable", "2.24.0-alpha.1")).toBe(true);
    expect(switchNeedsDowngrade("stable", "2.24.0")).toBe(false);
    expect(switchNeedsDowngrade("dev", "2.24.0-alpha.1")).toBe(false);
    expect(switchNeedsDowngrade("dev", "2.24.0")).toBe(false);
  });
});

describe("applyChannel on a real electron-updater AppUpdater", () => {
  it("the channel setter of electron-updater turns on downgrade (the trap)", () => {
    const updater = new TestUpdater("2.24.0");
    expect(updater.allowDowngrade).toBe(false);
    updater.channel = "alpha";
    expect(updater.allowDowngrade).toBe(true);
  });

  it("dev: channel alpha, prereleases on, downgrade off", () => {
    const updater = new TestUpdater("2.24.0");
    applyChannel(updater, "dev");
    expect(updater.channel).toBe("alpha");
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("stable: prereleases off, downgrade off, also on an alpha build", () => {
    const updater = new TestUpdater("2.24.0-alpha.1");
    // electron-updater turns prereleases on for an alpha build by itself.
    expect(updater.allowPrerelease).toBe(true);
    applyChannel(updater, "stable");
    expect(updater.channel).toBe("latest");
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("a normal check on Stable never offers an older Stable to an alpha build", async () => {
    const updater = new TestUpdater("2.24.0-alpha.1");
    applyChannel(updater, "stable");
    expect(await updater.offers("2.23.0")).toBe(false);
    expect(await updater.offers("2.24.0")).toBe(true);
  });

  it("a normal check on Dev offers a newer alpha only", async () => {
    const updater = new TestUpdater("2.24.0-alpha.2");
    applyChannel(updater, "dev");
    expect(await updater.offers("2.24.0-alpha.3")).toBe(true);
    expect(await updater.offers("2.24.0-alpha.1")).toBe(false);
    expect(await updater.offers("2.23.0")).toBe(false);
  });

  it("the explicit switch to Stable offers the older Stable version", async () => {
    const updater = new TestUpdater("2.24.0-alpha.1");
    applyChannel(updater, "stable", { allowDowngrade: true });
    expect(updater.allowDowngrade).toBe(true);
    expect(await updater.offers("2.23.0")).toBe(true);
    // After the switch, the next normal check has downgrade off again.
    applyChannel(updater, "stable");
    expect(await updater.offers("2.23.0")).toBe(false);
  });

  it("a Stable build on Stable does not see an alpha", async () => {
    const updater = new TestUpdater("2.23.0");
    applyChannel(updater, "stable");
    expect(updater.allowPrerelease).toBe(false);
  });
});

describe("feed URL and E2E seams", () => {
  it("uses GitHub without the E2E flag", () => {
    vi.stubEnv("OPENSTYLE_E2E", "");
    vi.stubEnv("OPENSTYLE_E2E_RELEASES_URL", "http://127.0.0.1:1/a/b/releases");
    vi.stubEnv("OPENSTYLE_E2E_APP_VERSION", "9.9.9");
    expect(releasesUrl()).toBe(
      "https://github.com/Maheidem/openstyle/releases",
    );
    expect(runningVersion("2.24.0")).toBe("2.24.0");
  });

  it("uses the fake feed and version only with OPENSTYLE_E2E=1", () => {
    vi.stubEnv("OPENSTYLE_E2E", "1");
    vi.stubEnv(
      "OPENSTYLE_E2E_RELEASES_URL",
      "http://127.0.0.1:5123/Maheidem/openstyle/releases",
    );
    vi.stubEnv("OPENSTYLE_E2E_APP_VERSION", "2.25.0-alpha.1");
    expect(releasesUrl()).toBe(
      "http://127.0.0.1:5123/Maheidem/openstyle/releases",
    );
    expect(runningVersion("2.24.0")).toBe("2.25.0-alpha.1");
  });

  it("builds electron-updater GitHub options from a releases URL", () => {
    expect(
      githubFeedOptions("http://127.0.0.1:5123/Maheidem/openstyle/releases"),
    ).toEqual({
      provider: "github",
      protocol: "http",
      host: "127.0.0.1:5123",
      owner: "Maheidem",
      repo: "openstyle",
    });
    expect(githubFeedOptions("http://127.0.0.1:5123/feed")).toBeNull();
  });
});

describe("restartDecision (Restart & Update while a meeting records)", () => {
  it("installs at once when no meeting records", () => {
    expect(restartDecision("idle", false)).toBe("install");
    expect(restartDecision("finalizing", false)).toBe("install");
    expect(restartDecision("idle", true)).toBe("install");
  });

  it("asks first while a meeting records", () => {
    expect(restartDecision("recording", false)).toBe("ask");
  });

  it("stops the recording, then installs, after the user agreed", () => {
    expect(restartDecision("recording", true)).toBe("stop-then-install");
  });
});
