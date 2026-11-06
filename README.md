# Openstyle

Openstyle is a local-first voice dictation app for macOS. Hold a hotkey, speak,
release, and the text appears at your cursor in whatever app you were already
typing in.

Transcription runs on your machine. There is no account, no cloud service, and
no telemetry.

## How it works

1. Hold the global hotkey.
2. Say what you want written.
3. Release.

The audio is transcribed on-device and pasted into the focused text field. It
works in any app that accepts text: editors, browsers, chat clients, terminals.

## About this fork

Openstyle is a fork of [freestyle-voice/freestyle](https://github.com/freestyle-voice/freestyle)
at tag `0.7.1`.

Removed from upstream:

- Freestyle Cloud (the hosted transcription and rewriting service)
- Accounts, sign-in, and the login gate
- PostHog telemetry

Kept from upstream:

- On-device transcription with local Whisper and local MLX speech models
- Bring-your-own-key access to third-party providers, configured by you
- Vocabulary and per-app tone settings

Thanks to the Freestyle authors and contributors for the original work.

## Features

- **Dictation** — hold the hotkey, speak, release, and the text lands at your
  cursor. Optional AI cleanup fixes grammar and punctuation and strips filler
  words.
- **On-device models** — local Whisper and local MLX speech models, downloaded
  once and run on your machine.
- **Translation** — speak one language, paste another.
- **Vocabulary** — teach it names and jargon it would otherwise get wrong.

## Use with your AI agent (MCP)

Openstyle has an MCP server. An AI agent on your Mac (Claude Code, pi or
Codex) can then work with your Openstyle data:

- Read meetings, transcripts, summaries, folders, Ask threads and dictations.
- Change meeting items: the title, notes, attendees, tags, speakers, the
  summary, the enhanced transcript, folders and open items.
- Help with the setup: vocabulary, settings and model downloads.

To connect an agent:

1. Open Openstyle.
2. Go to Settings > Agents (MCP). Agent access is on by default.
3. Click `Add to Claude Code`, `Add to pi` or `Add to Codex`. Openstyle runs
   the agent's own CLI to add itself.
4. Start a new agent session (in pi, run `/reload`).

If the one-click add does not work, run the command for your agent in
Terminal. The Stable app registers as `openstyle`. The Dev app registers as
`openstyle-dev`, so you can add both. The launcher is inside the app:

```sh
# Stable (Openstyle.app)
claude mcp add-json -s user openstyle '{"type":"stdio","command":"/Applications/Openstyle.app/Contents/Resources/mcp/openstyle-mcp","args":[]}'
pi mcp add openstyle -- "/Applications/Openstyle.app/Contents/Resources/mcp/openstyle-mcp"
codex mcp add openstyle -- "/Applications/Openstyle.app/Contents/Resources/mcp/openstyle-mcp"

# Dev (Openstyle Dev.app)
claude mcp add-json -s user openstyle-dev '{"type":"stdio","command":"/Applications/Openstyle Dev.app/Contents/Resources/mcp/openstyle-mcp","args":[]}'
pi mcp add openstyle-dev -- "/Applications/Openstyle Dev.app/Contents/Resources/mcp/openstyle-mcp"
codex mcp add openstyle-dev -- "/Applications/Openstyle Dev.app/Contents/Resources/mcp/openstyle-mcp"
```

Settings > Agents (MCP) shows the exact command with the path of your app.

Rules:

- The app must run. When it does not run, the agent gets "Openstyle is not
  running. Start the app, then try again."
- Every delete asks first. A delete tool does nothing until the agent calls it
  again with `confirm: true`, after you agree.
- API keys stay hidden. No tool reads or writes them.
- The server listens only on your Mac (127.0.0.1) and needs a token that the
  app makes at each start. The switch in Settings > Agents (MCP) turns agent
  access off.

The full tool list and the design are in [`specs/mcp.md`](specs/mcp.md).

## Requirements

- macOS 14 (Sonoma) or later. The published build is Apple Silicon (arm64) only.
- Node.js 22+ and pnpm 10+ to build.

Windows and Linux targets exist in the build config and are inherited from
upstream, but this fork is developed and tested on macOS.

## Install

Download the latest `.dmg` (Apple Silicon) from the
[Releases page](https://github.com/Maheidem/openstyle/releases) and drag it
to Applications.

The build is signed with a fixed self-signed certificate (since 2.15.1) and
is not notarized by Apple, so macOS warns on first launch. Right-click the app
and choose Open, or clear the quarantine flag:

```bash
xattr -cr /Applications/Openstyle.app
```

You do this once. Openstyle updates itself from inside the app and does not
show the warning again. A new `.dmg` that you download in a browser shows the
warning again.

## Build from source

To build it yourself instead:

```bash
git clone https://github.com/Maheidem/openstyle.git
cd openstyle
pnpm install
pnpm --filter @openstyle/electron build:mac
```

The signed app lands in `apps/electron/dist`.

To run it in development instead:

```bash
pnpm dev
```

On first launch macOS asks for Microphone access, and for Accessibility and
Input Monitoring access so the app can read the global hotkey and paste into
other applications.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and the PR workflow.

## License

[MIT](LICENSE). Originally developed as Freestyle by the
[freestyle-voice](https://github.com/freestyle-voice/freestyle) authors, and
still MIT-licensed here.
