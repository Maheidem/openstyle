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
scripts/test-runner/run.sh "$PWD" -- node scripts/site-captures/capture.mjs --only dash   # Node 22+, macOS
```

Run the capture only through the Test Runner (live-testing skill). Set `OPENSTYLE_E2E_OMLX_URL=http://127.0.0.1:1` on the same line. Before and after each run, record the TCC count and `stat -f '%N %m %z' ~/Library/Logs/Openstyle/*`. The installed app also writes that folder: if a file changes, search the new lines for `8790`, `8787` and the demo titles. Zero hits means the installed app wrote them.

The script does the following:
- It starts its own server on `127.0.0.1:8790` and a fake OpenAI-compatible model server on `127.0.0.1:8787`.
- The server gets a scratch `HOME`, a scratch Hugging Face cache and an empty stand-in file as `OPENSTYLE_MLX_ASR_WORKER`. The server only checks that the worker file exists. So the built-in models show as on a normal Apple silicon Mac, but no model is on disk and no MLX worker can start.
- It uses a throwaway profile, and deletes the profile at the end.
- It writes to `site/assets/screens/`.
- In a git worktree, check `ls apps/electron/node_modules/electron/dist/Electron.app` first. On 2026-10-06 the worktree's pnpm Electron entry had no `dist/Electron.app` and no `path.txt`, so the launch failed. The fix: copy the same Electron version's folder from the main checkout's `node_modules/.pnpm`. A symlink fails with a macOS sandbox error.

The only contact with the installed app is the one boot health probe on 4649.

## Files

- `scripts/site-captures/capture.mjs`: starts the backend, seeds it, drives the app with Playwright, takes the shots.
- `scripts/site-captures/seed-data.mjs`: the history rows and the demo meeting. All data is fictional.
- `scripts/site-captures/fake-model-server.mjs`: the fake server for the "Your own server" group.
- `scripts/site-captures/og-image.mjs`: the 1200x630 social card `site/assets/og-image.png`. It puts `transcriptions.png` on the page color with the name and tagline. It uses Playwright Chromium from `apps/electron`.
- `scripts/site-captures/README.md`: the output table.

## Output

| File | Shows |
|---|---|
| `transcriptions.png` | Transcriptions page with history |
| `meeting.png` / `meeting-summary.png` | "Weekly product sync": transcript tab and summary tab |
| `models-picker.png` | The three groups: Built into Openstyle, Your own server, Cloud provider |
| `models-picker-dialog.png` | The picker dialog alone: its box plus 4 px left and right, 2 px top and bottom, 1360x660 at 2x. Check the size after a run |
| `*-1600.webp`, `models-picker-dialog-680.webp` | 1x variants for `index.html`, made with `cwebp -q 82 -resize` |
| `../og-image.png` | The social card (`og-image.mjs`) |
| `models-builtin.png` / `models-server.png` | The two model lists |
| `pill-recording.png` | The pill while recording, transparent background, 2x |
| `pill-recording.webm` | 4 s of the pill on `#18202E` (webm has no alpha) |
| `pill-recording-crop.webm` | The pill alone, cropped from the webm (VP9) |
| `pill-recording-poster.png` | Poster frame of the crop (1.5 s) |

Dashboard shots are 1280x800 at 2x, dark theme.

## How it works

- **The pill:** the script sends the app's own `e2e:trigger-hotkey-down` IPC (`apps/electron/src/main/index.ts:1788`). It also gives the pill a synthetic oscillator as the microphone, so the bars move. No real microphone is used.
- **The 2x pill PNG:** Playwright gives 1x for the pill window. The script uses CDP `Page.captureScreenshot` with `clip.scale: 2` and a transparent background.
- **The pill video:** `recordVideo` only captures CSS pixels (1x) into a padded canvas, so the script runs a CDP screenshot loop at 2x (clip scale 2, ~25 fps for 4 s) and assembles the VP9 webm with ffmpeg at the measured fps.
- **Dark backdrop:** the glass surfaces are translucent, and a page capture does not include the native vibrancy. Without a backdrop the PNG is half transparent and looks grey and unfocused. The script adds `html { background: #0c0d0f }` before each shot. A CDP `Emulation.setDefaultBackgroundColorOverride` did NOT work for this window (2026-10-22).
- **Meetings:** the page opens the newest meeting and expands its folder. The script clicks "Expand Product team" only when the folder is still closed.
- **Seeded settings:** `today.tutorial_hero` is dismissed, `meeting_enhance_prompt_seen`, `advanced_mode` (shows Models in the sidebar) and `llm_cleanup` are `true`.
- **Navigation:** a direct `goto` to the models route does not render, so the script uses `history.pushState`. The history page can load empty on the first try, so the script reloads up to 4 times until the rows show.

## Traps

- Without the MLX worker stand-in, the server switches the voice default to Whisper ("Whisper Whisper Fast") and AI cleanup shows "None selected" (2026-10-22).
- The pill run uses the voice default. The built-in model is not on disk in the scratch cache, so the pill can show "not downloaded". Check the pill shots before you commit them.
- `pnpm install` in a new worktree can leave `electron/dist` with only `LICENSES.chromium.html`. Unpack the cached zip after its SHA-256 matches `checksums.json` (live-testing skill).

## Rules for the content

- The data must look like a real team's day. Do not mention capture automation, fake data or this tooling in any visible text.
- Use the default setup of a new install for model labels: the built-in Qwen3-ASR (`local-mlx/qwen3-0.6b-8bit`, "Qwen3 Fast") for voice and the built-in Gemma 4 E2B (`local-mlx-llm/gemma-4-e2b-qat-4bit`) for the LLM. Do not show Qwen3.8-27B or an oMLX server as the main setup. At most one row shows a cloud LLM.
- The sidebar must not show Remix. The app removed it, so a shot with Remix comes from a stale build.
- Use only fictional people and companies. Folders and tags must look like a real team's work.
- Keep one Portuguese row in the history.

## After a run

1. Look at every image yourself. Check for empty states, spinners, error toasts and cut-off UI.
2. Check that the meeting transcript fits the 800 px window (13 lines fit).
3. Check that no image is grey or half transparent, and that no shot shows Remix or Qwen3.8-27B.
4. The dash run also rewrites `models-picker.png`, `models-builtin.png`, `models-server.png` and `pill-recording.png`. `index.html` does not use them. Restore them with `git checkout` unless the task asks for them.
5. Commit the images with the site change that uses them. Do not commit the throwaway profile.

## For pi children

pi children do not load skills. A pi brief must say: "Read `.claude/skills/site-captures/SKILL.md` and `.claude/skills/live-testing/SKILL.md` first."
