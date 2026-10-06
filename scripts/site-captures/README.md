# Site captures

Real screenshots and a short video of the Openstyle desktop app for the
landing page. Output goes to `site/assets/screens/`.

Each run is isolated. It starts its own server on `127.0.0.1:8790`, a fake
oMLX-style model server on `127.0.0.1:8787`, and a throwaway profile in a temp
folder. It deletes them at the end. All data is fictional (`seed-data.mjs`).
It never touches an installed Openstyle app or its profile. The only contact is
the one boot health probe that the app sends to `127.0.0.1:4649`.

## Run

```bash
pnpm turbo build --filter=@openstyle/server && pnpm --filter @openstyle/electron build && node scripts/site-captures/capture.mjs
```

The build steps are only needed when the code changed. The capture alone is
`node scripts/site-captures/capture.mjs` (Node 22+ for `node:sqlite`, on macOS).

## Output

| File | Shows |
|---|---|
| `transcriptions.png` | Transcriptions page with history |
| `meeting.png` | "Weekly product sync", transcript tab |
| `meeting-summary.png` | Same meeting, summary tab |
| `models-picker.png` | Transcription picker, three tiers |
| `models-builtin.png` | Built into Openstyle list |
| `models-server.png` | Your own server list |
| `pill-recording.png` | Pill while recording, transparent background |
| `pill-recording.webm` | 4 s of the pill recording on `#18202E` (webm has no alpha) |

Dashboard images are 1280x800 at 2x, dark theme.

## Files

- `capture.mjs`: starts the backend, seeds it, drives the app with Playwright.
- `seed-data.mjs`: fictional history rows and the demo meeting (SQLite).
- `fake-model-server.mjs`: fake OpenAI-compatible server for "Your own server".

The pill is driven with the app's own `e2e:trigger-hotkey-down` IPC and a
synthetic microphone stream, so no real microphone is used.
