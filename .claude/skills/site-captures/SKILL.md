---
name: site-captures
description: Refresh the real app screenshots and the pill video used on the Openstyle landing page (site/), with fictional demo data. Use when the app UI changed, before a release that changes visible screens, or when asked for new site or marketing captures.
---

# Landing page captures

The landing page (`site/`) shows real captures of the app. A script makes them in an isolated profile with fictional data. Read `.claude/skills/live-testing/SKILL.md` for the isolation rules. They apply here too.

## Run

```bash
pnpm turbo build --filter=@openstyle/server     # only when server code changed
pnpm --filter @openstyle/electron build         # only when app code changed
node scripts/site-captures/capture.mjs          # Node 22+, macOS
```

The script does the following:
- It starts its own server on `127.0.0.1:8790` and a fake oMLX-style model server on `127.0.0.1:8787`.
- It uses a throwaway profile, and deletes the profile at the end.
- It writes to `site/assets/screens/`.

The only contact with the installed app is the one boot health probe on 4649.

## Files

- `scripts/site-captures/capture.mjs`: starts the backend, seeds it, drives the app with Playwright, takes the shots.
- `scripts/site-captures/seed-data.mjs`: the history rows and the demo meeting. All data is fictional.
- `scripts/site-captures/fake-model-server.mjs`: the fake server for the "Your own server" group.
- `scripts/site-captures/README.md`: the output table.

## Output

| File | Shows |
|---|---|
| `transcriptions.png` | Transcriptions page with history |
| `meeting.png` / `meeting-summary.png` | "Weekly product sync": transcript tab and summary tab |
| `models-picker.png` | The three groups: Built into Openstyle, Your own server, Cloud provider |
| `models-builtin.png` / `models-server.png` | The two model lists |
| `pill-recording.png` | The pill while recording, transparent background, 2x |
| `pill-recording.webm` | 4 s of the pill on `#18202E` (webm has no alpha) |
| `pill-recording-crop.webm` | The pill alone, cropped from the webm (VP9) |
| `pill-recording-poster.png` | Poster frame of the crop (1.5 s) |

Dashboard shots are 1280x800 at 2x, dark theme.

## How it works

- **The pill:** the script sends the app's own `e2e:trigger-hotkey-down` IPC (`apps/electron/src/main/index.ts:1788`). It also gives the pill a synthetic oscillator as the microphone, so the bars move. No real microphone is used.
- **The 2x pill PNG:** Playwright gives 1x for the pill window. The script uses CDP `Page.captureScreenshot` with `clip.scale: 2` and a transparent background.
- **Navigation:** a direct `goto` to the models route does not render, so the script uses `history.pushState`. The history page can load empty on the first try, so the script reloads up to 4 times until the rows show.

## Rules for the content

- The data must look like a real team's day. Do not mention capture automation, fake data or this tooling in any visible text.
- Use the owner's real setup style for model labels: Parakeet or Qwen3-ASR for voice, and Qwen3.8-27B on an own server for the LLM. At most one row shows a cloud LLM.
- Do not show Remix (see the project memory note: Remix is not ready for the spotlight).
- Keep one Portuguese row in the history.

## After a run

1. Look at every image yourself. Check for empty states, spinners, error toasts and cut-off UI.
2. Check that the meeting transcript fits the 800 px window (13 lines fit).
3. Commit the images with the site change that uses them. Do not commit the throwaway profile.

## For pi children

pi children do not load skills. A pi brief must say: "Read `.claude/skills/site-captures/SKILL.md` and `.claude/skills/live-testing/SKILL.md` first."
