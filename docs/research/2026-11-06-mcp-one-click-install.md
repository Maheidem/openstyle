# One-click MCP install: how the community does it, and a plan for Openstyle

Date: 2026-11-06. Status: research only. No app code changed.

Goal: the app detects the MCP clients on this Mac. It shows one "Add to <client>" button for each client. A click registers the Openstyle stdio launcher with that client:

- Stable: `/Applications/Openstyle.app/Contents/Resources/mcp/openstyle-mcp`
- Dev: `/Applications/Openstyle Dev.app/Contents/Resources/mcp/openstyle-mcp`

Each fact has a source tag like [S3]. The Sources section at the end has the URL and the quoted line. Tags [L1] to [L4] are local tests on this Mac (commands and real output are in the "Local tests" section).

## 1. Summary

- The community uses three mechanisms:
  1. The client's own CLI (`claude mcp add-json`, `codex mcp add`, `pi mcp add`, `code --add-mcp`, `gemini mcp add`).
  2. A direct edit of the client's config file (JSON, JSONC, TOML or YAML).
  3. A deep link that the client opens and confirms (Cursor, VS Code, LM Studio, Goose).
- The multi-client installers (`add-mcp`, `install-mcp`) edit config files directly, for all clients, including Claude Code. They do not call client CLIs. They do not write atomically and they do not make backups [S10][S11].
- Desktop apps that register themselves (JetBrains IDEs, Docker Desktop MCP Toolkit) show a client list with a button per client. They edit the client config file, and then they tell the user to restart the client [S14][S15].
- Figma desktop does not register itself. It shows copy-paste commands only [S16].
- The largest trap for Openstyle: a GUI app on macOS does not get the shell PATH [S12]. On this Mac, `claude` is not found with the GUI PATH. `codex` and `pi` are Node scripts, so they also need `node` on PATH. With the GUI PATH they fail with `env: node: No such file or directory` [L1][L2].
- Recommendation for v1: support Claude Code, pi and Codex through their CLIs, with an absolute CLI path and the login-shell PATH. Add Claude Desktop and Cursor through a careful JSON edit only if the owner wants them in v1. Do not use deep links in v1.

## 2. How existing tools do it

### 2.1 Deep links

| Client | URL format | Payload | User confirms | Fits Openstyle |
|---|---|---|---|---|
| Cursor | `cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_ENCODED_CONFIG` [S1] | `JSON.stringify(config)`, then base64 [S1] | Yes, "Cursor prompts to install the server" [S1] | Possible. The config can hold an absolute `command`. |
| VS Code | `vscode:mcp/install?{json-configuration}`; Insiders: `vscode-insiders:mcp/install?...` [S2] | URL-encoded JSON with `name` plus the server config [S2] | Yes, VS Code opens its install flow [S2] | Possible, but `code --add-mcp` is simpler [S2][L4]. |
| LM Studio | `lmstudio://add_mcp?name=...&config=...` [S3] | Base64 JSON [S3] | Not documented [S3] | Possible. LM Studio is not common for agents. |
| Goose | `goose://extension?cmd=...&arg=...&id=...&name=...` [S4] | URL-encoded query; one `arg` per argument [S4] | Yes, an approval prompt [S4] | **No.** `cmd` must be one of `jbang`, `npx`, `uvx`, `goosed`, `docker` [S4]. An absolute app path is not allowed. |
| Claude Desktop | `.mcpb` bundle (old name `.dxt`): a zip with `manifest.json`; double-click or drag to install [S5][S6] | `server.type` is `node`, `python`, `binary` or `uv` [S6] | Yes, an install dialog | Possible, but heavy. The bundle carries its own copy of the server. The spec does not say if `command` can point outside the bundle [S6]. |

Notes:

- A deep link gives the client the decision and the write. That is the safest write. But the app cannot read back the result, and the user must confirm in another window.
- GitHub markdown does not link `vscode:` URLs. Sites use a redirect such as `https://insiders.vscode.dev/redirect?url=` [S2b]. This does not matter for a desktop app: Electron `shell.openExternal()` opens the URL directly.

### 2.2 Installer CLIs

| Tool | Clients | How it writes | Safety |
|---|---|---|---|
| `add-mcp` (Neon) [S10] | 25 agents, including Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Goose, OpenCode, Pi, VS Code, Windsurf, Zed | Direct file edit with `jsonc-parser` `modify` + `applyEdits`; TOML and YAML formatters [S10][L3] | Keeps comments and indent. Plain `writeFileSync`: no temp file, no rename, no backup [L3]. |
| `install-mcp` (Supermemory) [S11] | claude-desktop, cline, roo-cline, windsurf, witsy, enconvo, cursor, vscode, gemini-cli, claude-code, goose, zed, opencode, warp, codex, droid, aider, aider-desk [S11] | Direct file edit. Even for `claude-code` it writes `~/.claude.json` key `mcpServers`; the `execFileSync` import is commented out [L3] | Same as above: `jsonc.modify`, then `fs.writeFileSync` [L3]. |
| Docker `docker mcp client connect <client>` [S15] | claude-code, claude-desktop, cline, codex, continue, crush, cursor, gemini, goose, gordon, kiro, lmstudio, opencode, sema4, vscode, zed [S15] | Writes one `MCP_DOCKER` entry that runs `docker mcp gateway run` [S15] | Tells the user to restart Claude Desktop [S15]. |
| Smithery CLI | The current README shows only skill installs with `--agent` [S17] | Not documented | Not documented |

Detection in `add-mcp` (global mode) is a folder check [L3]:

- Claude Code: `~/.claude` exists.
- Claude Desktop: `~/Library/Application Support/Claude` exists.
- Codex: `~/.codex` exists.
- Cursor: `~/.cursor` exists.
- OpenCode: `~/.config/opencode` exists.
- Pi: the pi agent dir (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`) exists.
- VS Code: `~/Library/Application Support/Code/User` exists.
- Windsurf: `~/.codeium/windsurf` exists.

A folder check is cheap, but it can be wrong. A folder stays after an uninstall. On this Mac `~/.gemini` exists, but the `gemini` CLI is not installed [L1].

### 2.3 Desktop apps that register their own server

- **JetBrains IDEs** (Settings > Tools > MCP Server): a "Clients Auto-Configuration" section. "Auto-Configure" updates the client config file. The doc says: "Restart your client for the configuration to take effect." Clients: Junie, VS Code, Claude Code, Codex, Air, GitHub Copilot CLI. Manual fallback: "Copy Stdio Config" [S14].
- **Docker Desktop MCP Toolkit**: a "Clients" tab with a "Connect" button per client, plus the CLI above. It tells the user to restart Claude Desktop [S15].
- **Figma desktop**: no auto-register. It documents `claude mcp add --transport http figma-desktop http://127.0.0.1:3845/mcp`, then "relaunch Claude Code" [S16].
- **Raycast**: it is itself an MCP client ("Install MCP Server" command). I found no source that it registers itself in other clients. I did not confirm 1Password, Things, Bear, Linear or Obsidian behavior. Treat these as unknown.

## 3. Per-client facts on macOS

| Client | Config file (user scope) | Shape | Own CLI | Restart |
|---|---|---|---|---|
| Claude Code | `~/.claude.json` (user and local scope) [S7] | `mcpServers.<name>` = `{type, command, args}` [L1] | `claude mcp add-json -s user`, `get`, `list`, `remove -s user` [S7][L1] | New session. A running session does not see the server (third-party, not in official docs) [S19]. |
| pi | `~/.pi/agent/mcp.json` (or `$PI_CODING_AGENT_DIR/mcp.json`) [S8][L2] | `mcpServers.<name>` = `{command, args, env, cwd}` [S8] | `pi mcp add <name> -- <cmd>`, `pi mcp remove`, `pi mcp list` [S8][L2] | "Run `/reload` after adding, removing, or changing a server outside the session." [S8] |
| Codex CLI / IDE / ChatGPT desktop | `~/.codex/config.toml` (or `$CODEX_HOME`) [S9][L2] | `[mcp_servers.<name>]` `command`, `args` [S9] | `codex mcp add <name> -- <cmd>`, `get --json`, `remove` [S9][L2] | Desktop: "Restart"; IDE: "Restart extension" [S9]. CLI: new session (assumption). |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` [S13] | `mcpServers.<name>` = `{command, args}` [S13] | None. JSON edit, or `.mcpb` [S5] | "completely quit Claude Desktop and restart it" [S13] |
| Cursor | `~/.cursor/mcp.json` [S18] | `mcpServers.<name>` = `{type:"stdio", command, args}` [S18] | Deep link [S1]. No documented CLI write. | Pickup is unreliable; forum says full quit and reopen [S20]. |
| VS Code | `~/Library/Application Support/Code/User/mcp.json` [S10] | `servers.<name>` = `{type:"stdio", command, args}` [S21] | `code --add-mcp '{"name":...,"command":...}'` writes the user profile [S21][L4]; deep link [S2] | Not documented. |
| Gemini CLI | `~/.gemini/settings.json` [S22] | `mcpServers` [S22] | `gemini mcp add -s user`, `list`, `remove` [S22] | Not checked. The doc says Gemini CLI "was replaced by Antigravity CLI on June 18th, 2026" [S22]. |
| OpenCode | `~/.config/opencode/opencode.json(c)` [S10] | `mcp.<name>` = `{type:"local", command:[...], enabled:true}` [S23] | `opencode mcp add` is interactive only (no flags) [L4] | Not checked. |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` [S10][S24] | `mcpServers` [S24] | None | Restart after save (third-party) [S24] |
| Zed | `~/Library/Application Support/Zed/settings.json` [S10] | `context_servers` [S10] | None | Not checked. Sources disagree on the `command` shape [S24b]. |
| Goose | `~/.config/goose/config.yaml` [S4] | `extensions.<id>` = `{cmd, args, type: stdio, enabled}` [S4] | `goose configure` (interactive) [S4] | Not checked. |
| LM Studio | `~/.lmstudio/mcp.json` (per add-mcp/Docker lists; not in LM Studio docs) | `mcpServers` | Deep link [S3] | Not checked. |

### 3.1 Claude Code details

- The native installer puts the launcher at `~/.local/bin/claude`, "as a symlink into `~/.local/share/claude/versions/`" [S25].
- Other install paths: Homebrew cask `claude-code` / `claude-code@latest` [S25] (binary in `/opt/homebrew/bin`), npm global `@anthropic-ai/claude-code` [S25] (binary in the npm prefix `bin`). The older `~/.claude/local/claude` path is from old installers; current docs do not mention it.
- `~/.claude.json` holds much more than MCP servers. On this Mac it is 512 KB. Claude Code keeps its own backups in `~/.claude/backups/` [L5].
- Many reports show `~/.claude.json` corruption from concurrent writes by several Claude Code instances (truncate-then-write, no atomic rename) [S26]. A third writer (Openstyle) adds to that race. **Use the CLI, not a direct file edit.** The CLI is the writer that Claude Code itself uses.
- Tested behavior of the CLI [L1]:
  - `add-json -s user` prints `Added stdio MCP server openstyle to user config`, exit 0.
  - A second `add-json` prints `MCP server openstyle already exists in user config`, exit 1. To replace, run `remove` first.
  - `get openstyle` exits 0 and runs a health check. With a missing launcher it prints `Status: ✘ Failed to connect` and `ENOENT`. So `get` both proves the entry and proves that the launcher starts.
  - `get nope` exits 1: `No MCP server named "nope"`.
  - `remove -s user openstyle` prints `Removed MCP server openstyle from user config`, exit 0.
- `CLAUDE_CONFIG_DIR` moves `.claude.json` to another folder [L1]. This is useful for tests.

### 3.2 pi details

- pi 1.4.0 (package `@earendil-works/pi-coding-agent`) has MCP built in [L2][S8].
- `pi mcp add` "Add or replace a server in mcp.json" [L2]. A second add prints `Replaced global MCP server "openstyle"`, exit 0. It is idempotent.
- `pi mcp remove openstyle` removes the entry, exit 0 [L2].
- `pi mcp list` connects to every enabled server; it "exits with status 1 when an entry is invalid or an enabled server is not connected" [S8]. This is slow when the user has many servers. For an "Added" badge, read `mcp.json` and check `mcpServers.openstyle.command`.
- Server names: "letters, digits, `_`, and `-`" [S8]. `openstyle` is valid.
- The launcher `~/.local/bin/pi` is a shell script that runs a Node binary. It needs `node` on PATH [L2].
- Warning: the third-party `pi-mcp-adapter` extension replaces pi's built-in MCP; then sessions stop reading `mcp.json` [S27]. pi docs list `pi mcp add` as the standard path [S8].

### 3.3 Codex details

- `codex mcp add openstyle -- "<path>"` writes `[mcp_servers.openstyle]` to `config.toml`. It keeps existing comments and keys [L2].
- A second add prints `Added global MCP server 'openstyle'.`, exit 0. It is idempotent [L2].
- `codex mcp get openstyle --json` returns the entry; a missing name exits 1 [L2].
- `codex mcp remove` exits 0, also when the entry is not there [L2].
- The CLI, the IDE extension and the ChatGPT desktop app share this config [S9]. One button covers all three.
- The Homebrew `codex` here is `#!/usr/bin/env node` [L2]. It needs `node` on PATH.

## 4. Safety patterns

1. **Prefer the client's CLI.** The client owns its file format, its locks and its migrations. Claude Code, pi and Codex all have one and all were tested [L1][L2].
2. **Find the CLI with the real PATH.** GUI apps on macOS "do not inherit the `$PATH` defined in your dotfiles" [S12]. The common fix is to read the login shell PATH once (`$SHELL -ilc 'echo $PATH'`), which `fix-path` and `shell-env` do [S12]. Then also check the known install folders (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, npm prefix `bin`). Pass the found PATH to the child process, because `codex` and `pi` need `node` [L2].
3. **For a JSON edit (only clients without a CLI):**
   - Read the file. If it does not parse, stop and show an error. Do not overwrite.
   - Change only `mcpServers.openstyle`. Keep all other keys. Use `jsonc-parser` `modify` to keep comments and indent, as `add-mcp` does [L3].
   - Write a backup copy first (for example `<file>.openstyle-backup`).
   - Write to a temp file in the same folder, then rename it over the original (atomic). The two community tools skip this step [L3].
   - Read the file back and check the entry.
4. **Idempotency.** Before add, read the current entry.
   - Same command path: show "Added". Do nothing.
   - Different command path (for example Dev vs Stable, or an old path): show "Update". On click, replace it.
   - Claude Code needs `remove` then `add-json`, because `add-json` refuses a duplicate [L1]. pi and Codex replace in place [L2].
5. **Name conflict.** The Stable and Dev apps both use the name `openstyle` today. A click from Dev would overwrite the Stable entry. Options: use `openstyle-dev` for the Dev app, or ask before replace. The owner must decide.
6. **Remove button.** Use the CLI `remove` (Claude Code, pi, Codex). For JSON clients, delete only the `openstyle` key, with the same backup and atomic write.
7. **Running client.**
   - Claude Desktop rewrites its own config file. Reports show it wiped `mcpServers` on start or login [S28]. Ask the user to quit Claude Desktop before the edit, or edit and then tell them to restart.
   - Show the restart hint per client: "Start a new Claude Code session", "Run /reload in pi", "Restart Claude Desktop", "Quit and reopen Cursor".
8. **Status.** JetBrains and Docker show a per-client state and a restart hint [S14][S15]. A simple set is enough: "Not installed" (hidden), "Add", "Added", "Update", plus the restart hint after a click.
9. **Consent.** A click on "Add" is the consent for that one client. Do not write any client config at app start or in the background. Show the exact change (client, file or command) in a small confirm text or a tooltip.

## 5. Recommendation for Openstyle v1

Keep it to the clients with a CLI. All three were tested end-to-end in a sandbox config folder on this Mac [L1][L2].

| Client | Detect | Install | Verify ("Added") | Remove | Restart |
|---|---|---|---|---|---|
| Claude Code | Find `claude`: login-shell PATH, then `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude` | `claude mcp add-json -s user openstyle '{"type":"stdio","command":"<path>","args":[]}'` (if a different entry exists: `remove -s user` first) | `claude mcp get openstyle` exit 0 and "Command: <path>" (also health-checks the launcher) | `claude mcp remove -s user openstyle` | New session |
| pi | Find `pi` the same way (`~/.local/bin/pi`); run it with the login-shell PATH (needs `node`) | `pi mcp add openstyle -- "<path>"` | Read `~/.pi/agent/mcp.json` key `mcpServers.openstyle.command` | `pi mcp remove openstyle` | `/reload` or new session |
| Codex | Find `codex` (Homebrew or npm); login-shell PATH (needs `node`) | `codex mcp add openstyle -- "<path>"` | `codex mcp get openstyle --json`, compare `transport.command` | `codex mcp remove openstyle` | New session; IDE "Restart extension"; desktop "Restart" |

Optional for v1 (owner choice), with the JSON edit rules in section 4:

| Client | Detect | Install | Verify | Remove | Restart |
|---|---|---|---|---|---|
| Claude Desktop | `/Applications/Claude.app` or `~/Library/Application Support/Claude` exists | JSON edit of `claude_desktop_config.json`, key `mcpServers.openstyle` = `{command, args: []}` | Read back the key | Delete the key | Quit and reopen Claude Desktop |
| Cursor | `/Applications/Cursor.app` or `~/.cursor` exists | Deep link `cursor://anysphere.cursor-deeplink/mcp/install?name=openstyle&config=<base64>` (Cursor writes and confirms), or JSON edit of `~/.cursor/mcp.json` | Read `~/.cursor/mcp.json` | Delete the key | Quit and reopen Cursor |

Not in v1: VS Code (Copilot agent use is low for this owner; `code --add-mcp` exists if needed), Gemini CLI (replaced by Antigravity CLI [S22]), Goose (deep link rejects an absolute command [S4]), OpenCode (CLI add is interactive only [L4]), Windsurf, Zed, LM Studio, `.mcpb`.

Keep the copy-paste commands as a fallback for every client. Show them when the CLI is not found or a command fails.

Things that need a decision or user consent:

- Stable vs Dev name (`openstyle` vs `openstyle-dev`). See section 4, item 5.
- A JSON edit of Claude Desktop or Cursor touches a file that the client also writes. Always make a backup and ask the user to quit the client first.
- Running a login shell to read PATH runs the user's dotfiles. It is the common method [S12], but it is a side effect. Run it once, with a timeout.

## 6. Local tests (evidence)

All tests used a sandbox config folder in the session scratchpad. No real client config was changed. The Openstyle launcher is not in the installed apps yet, so the path does not exist; the tests prove the registration, not the server.

GUI-like environment: `env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin`.

**[L1] Claude Code 2.1.319** (`CLAUDE_CONFIG_DIR=<sandbox>`):

```
## which claude in GUI PATH:
NOT_FOUND
## claude add-json
Added stdio MCP server openstyle to user config
exit=0
## again
MCP server openstyle already exists in user config
exit=1
{"openstyle":{"type":"stdio","command":"/Applications/Openstyle Dev.app/Contents/Resources/mcp/openstyle-mcp","args":[]}}
## claude get (launcher missing)
  Status: ✘ Failed to connect
  Issue: ENOENT: no such file or directory, posix_spawn '/Applications/Openstyle Dev.app/Contents/Resources/mcp/openstyle-mcp'
exit=0
## get missing
No MCP server named "nope". Configured servers: openstyle
exit=1
## remove
Removed MCP server openstyle from user config
exit=0
```

**[L2] Codex and pi 1.4.0** (`CODEX_HOME=<sandbox>`, `PI_CODING_AGENT_DIR=<sandbox>`):

```
## codex add (GUI PATH)
env: node: No such file or directory
exit=127
## pi add (GUI PATH)
env: node: No such file or directory
exit=127
-- with PATH=/opt/homebrew/bin:/usr/bin:/bin --
## codex add            -> Added global MCP server 'openstyle'.   exit=0
## codex add again      -> Added global MCP server 'openstyle'.   exit=0
config.toml keeps "# my comment" and model = "x", adds:
[mcp_servers.openstyle]
command = "/Applications/Openstyle Dev.app/Contents/Resources/mcp/openstyle-mcp"
## codex get missing    -> Error: No MCP server named 'nope' found.   exit=1
## codex remove         -> Removed global MCP server 'openstyle'.   exit=0
## codex remove again   -> No MCP server named 'openstyle' found.   exit=0
## pi add               -> Added global MCP server "openstyle" in <sandbox>/mcp.json.   exit=0
## pi add again         -> Replaced global MCP server "openstyle" ...   exit=0
## pi remove            -> Removed global MCP server "openstyle" ...   exit=0
```

`pi mcp --help` (1.4.0): `add <server>  Add or replace a server in mcp.json`, `Reads ~/.pi/agent/mcp.json and, in trusted projects, .pi/mcp.json.`

**[L3] Source read** of `neondatabase/add-mcp` (commit `5ae1d29`, 2026-11-01) and `supermemoryai/install-mcp` (commit `c2a97fb`, 2026-04-16):

- `add-mcp/src/formats/json.ts`: `jsonc.modify(...)`, `jsonc.applyEdits(...)`, `writeFileSync(filePath, updatedContent)`. No rename, no backup.
- `add-mcp/src/agents.ts`: `detectGlobalInstall: async () => { return existsSync(join(home, ".claude")); }` (same pattern for the other agents). VS Code `configKey: "servers"`, OpenCode `configKey: "mcp"`, Zed `configKey: "context_servers"`, Codex `configKey: "mcp_servers"`, `format: "toml"`.
- `install-mcp/src/client-config.ts`: `"claude-code": { type: "file", path: path.join(homeDir, ".claude.json"), ... configKey: "mcpServers" }`; `// import { execFileSync } from "node:child_process"`; `fs.writeFileSync(target.path, configContent)`.

**[L4] Help output on this Mac:**

- `code --help`: `--add-mcp <json> Adds a Model Context Protocol server definition to the user profile. Accepts JSON input in the form '{"name":"server-name","command":...}'`
- `opencode mcp add --help`: no options other than `--help`, `--version`, `--print-logs`, `--log-level`, `--pure`.

**[L5]** `ls -A ~/.claude/backups` shows `.claude.json.backup.<timestamp>` files; `~/.claude.json` is 512.6 KB.

## Sources

- [S1] https://cursor.com/docs/mcp/install-links — "cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_ENCODED_CONFIG"; "JSON.stringify the configuration then base64 encode it"; "Cursor prompts to install the server". Second source: https://dev.to/danywalls/how-to-create-one-click-mcp-installation-deep-links-for-cursor-and-vs-code-5g5k (Node `Buffer.from(...).toString('base64')` on the stringified config).
- [S2] https://code.visualstudio.com/docs/copilot/guides/mcp-developer-guide — "Install directly from the web: use a special MCP installation URL (`vscode:mcp/install`)"; "Use `vscode:mcp/install?{json-configuration}`"; "Insiders: `vscode-insiders:mcp/install?{json-configuration}`"; "Install MCP servers from the command line with the `--add-mcp` VS Code command-line option."
- [S2b] https://glama.ai/mcp/servers/@formulahendry/mcp-server-code-runner/blob/main/scripts/generateUrlForInstallation.js — community generator; builds the link with `encodeURIComponent(JSON.stringify(obj))` and uses `https://insiders.vscode.dev/redirect?url=` for GitHub markdown.
- [S3] https://lmstudio.ai/docs/app/mcp/deeplink — "`lmstudio://add_mcp?name=...&config=...`"; `config`: "Base64 encoded JSON configuration for the MCP server."
- [S4] https://raw.githubusercontent.com/aaif-goose/goose/main/documentation/docs/getting-started/using-extensions.md and https://block.github.io/goose/docs/getting-started/using-extensions — "`goose://extension?cmd=...&arg=...&id=...&name=...&description=...`"; allowed `cmd`: "`jbang`, `npx`, `uvx`, `goosed`, `docker`"; config "`~/.config/goose/config.yaml`"; "goose would like to enable the following extension, do you approve?"
- [S5] https://claude.com/docs/connectors/building/mcpb and https://www.anthropic.com/news/desktop-extensions — an `.mcpb` file is a zip with a local MCP server and `manifest.json` for one-click install in Claude Desktop; MCPB is a secondary path, remote servers are recommended. Install by drag or Developer > Extensions > Install Extension: https://support.claude.com/fr/articles/12922929-construire-des-extensions-de-bureau-avec-mcpb
- [S6] https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md — "Four server types are supported:" `node`, `python`, `binary`, `uv`; "`${__dirname}` ... is replaced with the absolute path to the extension's directory."
- [S7] https://code.claude.com/docs/en/mcp — "User-scoped servers are stored in `~/.claude.json` and provide cross-project accessibility."; `claude mcp add-json example '{"command":"npx","args":["-y","@example/mcp-server"]}'`; "claude mcp list", "claude mcp get notion", "claude mcp remove notion".
- [S8] https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md (same file bundled in pi 1.4.0) — "Pi reads user-level servers from `~/.pi/agent/mcp.json` and project servers from `.pi/mcp.json`."; "Run `/reload` after adding, removing, or changing a server outside the session."; "Server names may contain only letters, digits, `_`, and `-`."; `pi mcp list` "exits with status 1 when an entry is invalid or an enabled server is not connected." Second source: https://www.sitepoint.com/pi-1-0-coding-agent-setup-mcp/ ("By default the commands write user-level servers to ~/.pi/agent/mcp.json.")
- [S9] https://learn.chatgpt.com/docs/extend/mcp?surface=cli (redirect from https://developers.openai.com/codex/mcp) — "codex mcp add <server-name> --env VAR1=VALUE1 --env VAR2=VALUE2 -- <stdio server-command>"; `[mcp_servers.<server-name>]`; default `~/.codex/config.toml`; the ChatGPT desktop app, Codex CLI and IDE extension share this configuration; desktop "Restart", IDE "Restart extension".
- [S10] https://github.com/neondatabase/add-mcp — agent table: Claude Code `~/.claude.json`, Claude Desktop `~/Library/Application Support/Claude/claude_desktop_config.json`, Codex `~/.codex/config.toml`, Cursor `~/.cursor/mcp.json`, Pi `$PI_CODING_AGENT_DIR/mcp.json (default ~/.pi/agent/mcp.json)`, VS Code `~/Library/Application Support/Code/User/mcp.json`, Windsurf `~/.codeium/windsurf/mcp_config.json`, Zed `~/Library/Application Support/Zed/settings.json`, OpenCode `~/.config/opencode/opencode.jsonc`. Second source: https://neon.com/blog/add-mcp
- [S11] https://github.com/supermemoryai/install-mcp — "The `--client` flag specifies which MCP client you're installing for:" claude-desktop, cline, roo-cline, windsurf, witsy, enconvo, cursor, vscode, gemini-cli, claude-code, goose, zed, opencode, warp, codex, droid, aider, aider-desk.
- [S12] https://github.com/sindresorhus/fix-path — "GUI apps on macOS and Linux do not inherit the `$PATH` defined in your dotfiles". Second source: https://github.com/atom/electron/issues/550 ("if you start Atom normally by clicking its application icon, it doesn't inherit your user environment"). Also https://www.npmjs.com/package/shell-env.
- [S13] https://modelcontextprotocol.io/docs/develop/connect-local-servers — "**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`"; "completely quit Claude Desktop and restart it. The application needs to restart to load the new configuration".
- [S14] https://www.jetbrains.com/help/idea/mcp-server.html — "For detected external clients like Junie, VS Code, Claude Code, Codex, Air, and GitHub Copilot CLI" configuration is automatic with Auto-Configure; "Restart your client for the configuration to take effect."; "Copy SSE Config, Copy Stdio Config, or Copy HTTP Stream Config". Second source: https://mcp.harishgarg.com/clients/ide/jetbrains-ai-assistant
- [S15] https://docs.docker.com/reference/cli/docker/mcp/client/connect/ — supported clients claude-code, claude-desktop, cline, codex, continue, crush, cursor, gemini, goose, gordon, kiro, lmstudio, opencode, sema4, vscode, zed. https://docs.docker.com/ai/mcp-catalog-and-toolkit/toolkit/ — "From the Clients tab, select Connect next to Claude Desktop."; "Restart Claude Desktop if it's running".
- [S16] https://developers.figma.com/docs/figma-mcp-server/local-server-installation/ — "claude mcp add --transport http figma-desktop http://127.0.0.1:3845/mcp", then relaunch Claude Code; no auto-registration described.
- [S17] https://github.com/smithery-ai/cli — README shows `smithery skill add anthropics/frontend-design --agent claude-code`; no `--client` install documented.
- [S18] https://cursor.com/docs/mcp — "Create `~/.cursor/mcp.json` in your home directory for tools available everywhere."; STDIO fields `type` ("stdio"), `command`, `args`, `env`, `envFile`.
- [S19] https://claudify.tech/blog/claude-code-mcp-not-connecting — "if you edit .mcp.json or run claude mcp add while a session is already open, the running session does not see the change". Second source: https://claudeoverflow-site.pages.dev/q/mcp-server-tools-appearing-claude-code-after-adding-settings (full restart needed). Both third-party; no official statement found.
- [S20] https://forum.cursor.com/t/changes-in-mcp-server-not-detected-until-cursor-restart/173112 and https://forum.cursor.com/t/mcp-server-regression-does-not-reload-tools-disconnect-does-nothing-ignores-mcp-json-changes-etc/166216 — full restart is the reliable fix; Cursor staff: "tracking the issue".
- [S21] https://code.visualstudio.com/docs/agents/reference/mcp-configuration — **MCP: Open User Configuration** "Open the `mcp.json` file in your user profile"; top-level `"servers"`; `type` "stdio"; "Use `code --add-mcp` with a JSON object containing a unique `name` and the server configuration."
- [S22] https://geminicli.com/docs/tools/mcp-server/ — "`gemini mcp add [options] <name> <commandOrUrl> [args...]`"; "`-s, --scope`: Configuration scope (user or project). [default: “project”]"; user config `~/.gemini/settings.json`; Gemini CLI "was replaced by Antigravity CLI on June 18th, 2026."
- [S23] https://opencode.ai/docs/mcp-servers/ — `"mcp": { "my-local-mcp-server": { "type": "local", "command": ["npx", "-y", "my-mcp-command"], "enabled": true } }`.
- [S24] https://fast.io/resources/windsurf-mcp-setup-guide/ and https://pkg.go.dev/github.com/agentplexus/assistantkit/mcp/windsurf — `~/.codeium/windsurf/mcp_config.json`, `mcpServers`, restart after save (third-party).
- [S24b] https://grafana.com/docs/grafana/latest/ai-tools/mcp/clients/zed.md and https://you.com/docs/build-with-agents/agent-harnesses/zed.md — both use `context_servers`; they disagree on the `command` shape.
- [S25] https://code.claude.com/docs/en/setup — "the native installer manages the launcher at `~/.local/bin/claude` as a symlink into `~/.local/share/claude/versions/`"; "brew install --cask claude-code"; "npm install -g @anthropic-ai/claude-code".
- [S26] https://github.com/anthropics/claude-code/issues/29004 — concurrent instances leave `.claude.json` with "JSON Parse error: Unexpected EOF". Mirrors: https://claudeissues.com/issue/29051-claude-json-corrupted-by-concurrent-writes-no-atomic-write-file-locking ("no atomic write / file locking").
- [S27] https://www.sitepoint.com/pi-1-0-coding-agent-setup-mcp/ — the third-party pi-mcp-adapter replaces pi's built-in MCP on pi 0.99 and later. Repo: https://github.com/nicobailon/pi-mcp-adapter
- [S28] https://github.com/anthropics/claude-code/issues/32345 — "claude_desktop_config.json silently wiped and replaced with preferences stub". Second: https://github.com/anthropics/claude-code/issues/34359 (repeated wipes on Windows).
