import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, type Page, test } from "@playwright/test";
import { boot, put } from "./helpers/ask-app";
import { MEETINGS, seedAskMeetings } from "./helpers/ask-fixture";
import { closeApp, embeddedServerUrl } from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// The Openstyle MCP server from the agent side (specs/mcp.md 9.3). An
// isolated app with the Ask fixture runs. The REAL launcher
// (resources/mcp/openstyle-mcp) and the REAL bridge (out/main/mcp-bridge.js)
// sit in a fake .app folder with a space in its name. The MCP SDK stdio
// client drives them. Then:
//   - tool calls go through the bridge to /mcp, and the window shows a new
//     meeting title with no reload (data:changed), in light and in dark;
//   - set_setting chat_hotkey changes the live chat hotkey;
//   - Settings > Agents (MCP) adds Openstyle to stub CLIs (claude, pi, codex);
//   - the Ready card of onboarding shows the found tools;
//   - after the quit, the bridge lists only openstyle_status, and a tool call
//     gives "Openstyle is not running" as a tool error.
// All data is fictional. Set OPENSTYLE_EVIDENCE_DIR for the screenshots.
// ---------------------------------------------------------------------------

const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;
const MEETING = MEETINGS[0];
const LAUNCHER = resolve(__dirname, "../resources/mcp/openstyle-mcp");
const BRIDGE = resolve(__dirname, "../out/main/mcp-bridge.js");
const ELECTRON_BINARY = createRequire(__filename)("electron") as string;

async function shoot(page: Page, name: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  await page.waitForTimeout(600);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: join(EVIDENCE_DIR, name) });
}

async function setTheme(page: Page, name: "Light" | "Dark"): Promise<void> {
  await page.goto("app://renderer/settings#display");
  await page.getByRole("radio", { name, exact: true }).click();
  if (name === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

/**
 * Stub CLIs. Each one records its argv (one arg per line, then "---") and
 * writes the file that the state check reads. The codex stub exits 0 on add
 * but writes nothing: the state check then fails.
 */
const RECORD = `{ for a in "$@"; do printf '%s\\n' "$a"; done; echo ---; } >> "$MCP_STUB_DIR/$(basename "$0").argv"\n`;
const CLAUDE_STUB = `${RECORD}d="$MCP_STUB_DIR"
case "$2" in
  get)
    if [ -f "$d/claude.cmd" ]; then
      printf '%s:\\n  Scope: User config\\n  Type: stdio\\n  Command: %s\\n' "$3" "$(cat "$d/claude.cmd")"
      exit 0
    fi
    echo "No MCP server named \\"$3\\" found." >&2; exit 1 ;;
  add-json)
    if [ -f "$d/claude.cmd" ]; then echo "MCP server $5 already exists" >&2; exit 1; fi
    printf '%s' "$6" | sed -E 's/.*"command":"([^"]*)".*/\\1/' > "$d/claude.cmd"
    echo "Added stdio MCP server $5 to user config" ;;
  remove) rm -f "$d/claude.cmd" ;;
esac
`;
const PI_STUB = `${RECORD}case "$2" in
  add) printf '{"mcpServers":{"%s":{"command":"%s"}}}\\n' "$3" "$5" > "$PI_CODING_AGENT_DIR/mcp.json" ;;
  remove) rm -f "$PI_CODING_AGENT_DIR/mcp.json" ;;
esac
`;
const CODEX_STUB = `${RECORD}case "$2" in
  get) echo "No MCP server named '$3' found." >&2; exit 1 ;;
  add) echo "Added global MCP server '$3'." ;;
esac
`;

/** A fake <App>.app with the real launcher and the real bridge. */
function fakeApp(root: string): string {
  const contents = join(root, "Fake Openstyle Dev.app", "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources", "mcp"), { recursive: true });
  mkdirSync(join(contents, "Resources", "app.asar", "out", "main"), {
    recursive: true,
  });
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Openstyle Dev</string>
<key>CFBundleName</key><string>Openstyle Dev</string>
</dict></plist>
`,
  );
  // The app executable: the Electron binary of the repo, which the launcher
  // starts in Node mode (ELECTRON_RUN_AS_NODE=1).
  writeScript(
    join(contents, "MacOS", "Openstyle Dev"),
    `exec "${ELECTRON_BINARY}" "$@"\n`,
  );
  const launcher = join(contents, "Resources", "mcp", "openstyle-mcp");
  copyFileSync(LAUNCHER, launcher);
  chmodSync(launcher, 0o755);
  copyFileSync(
    BRIDGE,
    join(contents, "Resources", "app.asar", "out", "main", "mcp-bridge.js"),
  );
  return launcher;
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })
    .content;
  return content?.map((c) => c.text ?? "").join("\n") ?? "";
}

function argvOf(stubDir: string, tool: string): string[][] {
  const file = join(stubDir, `${tool}.argv`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("---\n")
    .filter(Boolean)
    .map((block) => block.split("\n").filter((l) => l.length > 0));
}

test("agents work with Openstyle through the MCP bridge", async () => {
  test.setTimeout(150_000);
  const stubDir = join(tmpdir(), `mcp-e2e-${process.pid}`);
  const binDir = join(stubDir, "bin");
  const piDir = join(stubDir, "pi");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(piDir, { recursive: true });
  writeScript(join(binDir, "claude"), CLAUDE_STUB);
  writeScript(join(binDir, "pi"), PI_STUB);
  // No codex at the start: its row shows "Not found" and "Check again".

  const b = await boot("openstyle-mcp-e2e-", {
    OPENSTYLE_E2E_AGENT_BIN: binDir,
    MCP_STUB_DIR: stubDir,
    PI_CODING_AGENT_DIR: piDir,
    OPENSTYLE_E2E_OMLX_URL: "http://127.0.0.1:1",
  });
  let client: Client | null = null;
  try {
    seedAskMeetings(b.userDataDir);
    await put(b, "meeting_enhance_prompt_seen", "true");
    await put(b, "meeting_chat_enabled", "true");

    // mcp.json: the port of this app, mode 0600 (specs/mcp.md 3.3).
    const mcpJson = join(b.userDataDir, "mcp.json");
    const config = JSON.parse(readFileSync(mcpJson, "utf8"));
    expect(config.port).toBe(Number(new URL(embeddedServerUrl(b.app)).port));
    expect(config.token).toMatch(/^[0-9a-f]{64}$/);
    expect(config.name).toBe("openstyle-dev");
    expect(statSync(mcpJson).mode & 0o777).toBe(0o600);

    // --- The SDK client drives the real launcher and bridge ---------------
    const launcher = fakeApp(b.userDataDir);
    const transport = new StdioClientTransport({
      command: launcher,
      args: ["--user-data", b.userDataDir],
      stderr: "pipe",
    });
    client = new Client({ name: "openstyle-e2e", version: "1.0.0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "list_meetings",
      "get_meeting",
      "update_meeting",
      "set_setting",
      "list_settings",
    ]) {
      expect(tools).toContain(name);
    }

    const list = await client.callTool({
      name: "list_meetings",
      arguments: {},
    });
    expect(list.isError).toBeFalsy();
    expect(textOf(list)).toContain(MEETING.id);
    const got = await client.callTool({
      name: "get_meeting",
      arguments: { meeting_id: MEETING.id },
    });
    expect(textOf(got)).toContain(MEETING.title);
    const settingsList = await client.callTool({
      name: "list_settings",
      arguments: {},
    });
    expect(textOf(settingsList)).toContain("chat_hotkey");
    expect(textOf(settingsList)).not.toContain("network_proxy_url");

    // --- update_meeting: the open window shows the new title, light and dark
    let shownTitle = MEETING.title;
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(b.page, theme);
      await b.page.goto("app://renderer/meetings");
      await expect(b.page.getByText(shownTitle).first()).toBeVisible({
        timeout: 15_000,
      });
      const title = `Weekly sync with the vendor (${theme.toLowerCase()} check)`;
      const updated = await client.callTool({
        name: "update_meeting",
        arguments: { meeting_id: MEETING.id, title },
      });
      expect(updated.isError).toBeFalsy();
      // No reload: data:changed makes the page read the list again.
      await expect(b.page.getByText(title).first()).toBeVisible({
        timeout: 10_000,
      });
      await shoot(b.page, `mcp-meeting-title-${theme.toLowerCase()}.png`);
      shownTitle = title;
    }
    await setTheme(b.page, "Light");

    // --- set_setting chat_hotkey: the live hotkey changes ------------------
    const set = await client.callTool({
      name: "set_setting",
      arguments: { key: "chat_hotkey", value: "Control+Alt+J" },
    });
    expect(set.isError).toBeFalsy();
    await expect
      .poll(
        async () =>
          (
            (await b.page.evaluate(() =>
              window.electron.ipcRenderer.invoke("e2e:chat-hotkey-state"),
            )) as { registered: string | null }
          ).registered,
        { timeout: 10_000 },
      )
      .toMatch(/J$/);
    // A protected key is refused (specs/mcp.md 6.1).
    const refused = await client.callTool({
      name: "set_setting",
      arguments: { key: "network_proxy_url", value: "http://x" },
    });
    expect(refused.isError).toBe(true);

    // The server log names the agent (X-Openstyle-Agent header).
    const serverLog = readFileSync(
      join(b.userDataDir, "logs", "openstyle-server.log"),
      "utf8",
    );
    expect(serverLog).toMatch(
      /tool=update_meeting agent=openstyle-e2e\/1\.0\.0/,
    );

    // --- Settings > Agents (MCP): one-click install with stub CLIs ---------
    await b.page.goto("app://renderer/settings#agents");
    const row = (tool: string) => b.page.getByTestId(`settings-agent-${tool}`);
    await expect(b.page.getByTestId("settings-agents")).toBeVisible();
    await expect(b.page.getByTestId("settings-agents-status-chip")).toHaveText(
      /ready/i,
    );
    await expect(row("claude")).toHaveAttribute("data-state", "not-added");
    await expect(row("pi")).toHaveAttribute("data-state", "not-added");
    await expect(row("codex")).toHaveAttribute("data-state", "not-found");
    await expect(
      b.page.getByText("Not found on this Mac").first(),
    ).toBeVisible();
    await expect(
      b.page.getByTestId("settings-agent-codex-command"),
    ).toBeVisible();

    await b.page.getByTestId("settings-agent-claude-add").click();
    await expect(row("claude")).toHaveAttribute("data-state", "added", {
      timeout: 20_000,
    });
    await expect(
      b.page.getByText("Start a new Claude Code session to load it."),
    ).toBeVisible();
    const claudeCalls = argvOf(stubDir, "claude");
    const addJson = claudeCalls.find((argv) => argv[1] === "add-json");
    expect(addJson?.slice(0, 5)).toEqual([
      "mcp",
      "add-json",
      "-s",
      "user",
      "openstyle-dev",
    ]);
    expect(JSON.parse(addJson?.[5] ?? "{}")).toEqual({
      type: "stdio",
      command: LAUNCHER,
      args: ["--user-data", b.userDataDir],
    });

    // pi goes away, codex comes (it fails its add). "Check again" finds both.
    rmSync(join(binDir, "pi"));
    writeScript(join(binDir, "codex"), CODEX_STUB);
    await b.page.getByTestId("settings-agent-codex-rescan").click();
    await expect(row("pi")).toHaveAttribute("data-state", "not-found");
    await expect(row("codex")).toHaveAttribute("data-state", "not-added");
    await b.page.getByTestId("settings-agent-codex-add").click();
    await expect(row("codex")).toHaveAttribute("data-state", "failed", {
      timeout: 20_000,
    });
    await expect(
      b.page.getByText("Could not add it. Run this command in Terminal."),
    ).toBeVisible();
    await expect(
      b.page.getByTestId("settings-agent-codex-command"),
    ).toContainText(`codex mcp add openstyle-dev -- "${LAUNCHER}"`);
    await expect(
      b.page.getByTestId("settings-agent-codex-command-copy"),
    ).toBeVisible();
    await expect(b.page.getByTestId("settings-agent-codex-add")).toHaveText(
      "Try again",
    );
    expect(argvOf(stubDir, "codex").some((argv) => argv[1] === "add")).toBe(
      true,
    );
    await shoot(b.page, "mcp-settings-agents-light.png");
    await setTheme(b.page, "Dark");
    await b.page.goto("app://renderer/settings#agents");
    await expect(row("claude")).toHaveAttribute("data-state", "added");
    await shoot(b.page, "mcp-settings-agents-dark.png");

    // --- The Ready card of onboarding: only the found tools ----------------
    await b.page.evaluate(() =>
      window.electron.ipcRenderer.invoke("onboarding:set-state", {
        step: 7,
        draft: { voiceSource: "later", textSource: "none" },
      }),
    );
    for (const theme of ["Dark", "Light"] as const) {
      if (theme === "Light") await setTheme(b.page, "Light");
      await b.page.goto("app://renderer/onboarding");
      const card = b.page.getByTestId("onboarding-agent-card");
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(
        b.page.getByTestId("onboarding-agent-claude"),
      ).toHaveAttribute("data-state", "added");
      await expect(b.page.getByTestId("onboarding-agent-codex")).toBeVisible();
      await expect(b.page.getByTestId("onboarding-agent-pi")).toHaveCount(0);
      await expect(card).toContainText(
        "Found on this Mac: Claude Code, Codex.",
      );
      await expect(b.page.getByTestId("onboarding-finish")).toBeEnabled();
      await shoot(b.page, `mcp-ready-card-${theme.toLowerCase()}.png`);
    }
  } finally {
    await closeApp(b.app);
  }

  // --- After the quit: mcp.json is gone. The bridge gives openstyle_status,
  // and each tool call gives "not running" as a tool error (specs/mcp.md 5).
  expect(existsSync(join(b.userDataDir, "mcp.json"))).toBe(false);
  if (client) {
    for (let i = 0; i < 2; i++) {
      // The bridge stays alive: a second call gets the same answer.
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect(listed).toEqual(["openstyle_status"]);
      for (const name of ["openstyle_status", "list_meetings"]) {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(
          "Openstyle is not running. Start the app, then try again.",
        );
      }
    }
    await client.close();
  }
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(b.userDataDir, { recursive: true, force: true });
});
