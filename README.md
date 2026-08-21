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
- Remix, the in-place rewriting agent
- Vocabulary, dictionary, and per-app tone settings
- The plugin system and its SDK

Thanks to the Freestyle authors and contributors for the original work.

## Features

- **Dictation** — hold the hotkey, speak, release, and the text lands at your
  cursor. Optional AI cleanup fixes grammar and punctuation and strips filler
  words.
- **Remix** — highlight text and say what to change. It rewrites in place. With
  nothing highlighted it writes from scratch.
- **On-device models** — local Whisper and local MLX speech models, downloaded
  once and run on your machine.
- **Translation** — speak one language, paste another.
- **Vocabulary and dictionary** — teach it names, jargon, and shorthand it would
  otherwise get wrong.
- **Plugins** — extend the dictation pipeline. See `packages/sdk`.

## Requirements

- macOS. The published build is Apple Silicon (arm64) only.
- Node.js 22+ and pnpm 10+ to build.

Windows and Linux targets exist in the build config and are inherited from
upstream, but this fork is developed and tested on macOS.

## Install

Download the latest `.dmg` (Apple Silicon) from the
[Releases page](https://github.com/Maheidem/openstyle/releases) and drag it
to Applications.

The build is ad-hoc signed, not notarized, so macOS will warn on first
launch. Right-click the app and choose Open, or clear the quarantine flag:

```bash
xattr -cr /Applications/Openstyle.app
```

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
