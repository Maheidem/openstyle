---
name: prototype-snapshot
description: Make high-fidelity prototype boards from a real DOM snapshot of the running Openstyle app (isolated, fictional data), prove the copy is pixel-equal to a real screenshot, and put it on a claude.ai Design canvas as static or click-through boards. Use for any "high fidelity prototype", "mock on the canvas", "prototype board", "hi-fi board", "click-through prototype of a fix", or when a canvas board must look like the real app.
---

# Prototype boards from a real DOM snapshot

Owner rule (2026-11-11): a high-fidelity board comes from a real DOM snapshot of the running app. Do not draw the app by hand. Hand-built boards "SI A..E" had the Summary and Transcript tabs in the wrong order and wrong folders. The owner rejected them.

Read `.claude/skills/live-testing/SKILL.md` first. Its isolation rules apply here.

## Run

Build first when app code changed (live-testing skill, section 1). Then run from the repo root:

```bash
scripts/test-runner/run.sh "$PWD" -- node scripts/prototype-snapshot/snapshot.mjs --out /tmp/proto-snap --name meeting
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `--out <dir>` | required | Output folder |
| `--name <n>` | `screen` | File name stem |
| `--theme dark\|light` | `dark` | App theme (`localStorage.theme`) |
| `--size WxH` | `1440x900` | Window content size. Min height 480 is lifted |
| `--route <path>` | `/meetings` | Client route (`history.pushState`). Meetings opens the newest meeting |
| `--click role:name` | none | Click `getByRole(role, {name, exact})`. Repeat for more steps, for example `--click "button:Summary instructions"` |
| `--setting key=value` | none | Seed a row in `settings` before launch. `key=@file` reads the value from a file |

Expected last line (2026-11-11 values):

```
DIFF meeting exact=0.007% over16=0.004% size=1440x900
```

`exact` is the share of pixels with any difference. `over16` is the share with a channel difference above 16. Accept `over16` below 0.05%. Look at `<name>.diff.png` (red = over 16). On 2026-11-11 the only red was anti-aliasing in the meeting date line.

Outputs in `--out`:

| File | Content |
|---|---|
| `<name>.html` | Standalone page: DOM, all CSS, fonts as `data:` URIs. Opens offline |
| `<name>.frag.html` | The same DOM as one wrapper `div.os-root`, assets as `assets/<hash>.<ext>` |
| `<name>.css` | The scoped CSS, asset urls relative |
| `assets/` | Fonts and images the copy uses |
| `<name>.real.png`, `<name>.snap.png`, `<name>.diff.png` | Real window shot, copy shot, diff |

## What the script does

1. It starts its own server on `127.0.0.1:8791` with a scratch HOME, HF cache and MLX worker stand-in (same as `scripts/site-captures/capture.mjs`). It seeds the site-captures demo data and more: colored folders (blue, orange, green, violet) with several meetings each, two unfiled meetings, and no speaker names in "Weekly product sync".
2. It launches the built app with `OPENSTYLE_E2E=1` (quiet mode), `--force-device-scale-factor=1` and `--force-color-profile=srgb`.
3. It sets the window content size, theme and route, and runs the `--click` steps.
4. It moves the mouse to a corner and blurs the focus, so no hover or focus state is in either shot. It adds a flat backdrop (`#0c0d0f` dark, `#e8e9ec` light) and stops animations, in a style tag marked `data-snap-helper`.
5. It takes the real shot, then serializes the page in the renderer:
   - All CSS rules from `document.styleSheets` (Tailwind output, CSS variables, `@layer`, `@property`, `@font-face` of loaded families). It skips `data-snap-helper` sheets.
   - `html` and `:root` become `.os-root`, `body` becomes `.os-body`. The copy then works inside any page.
   - Each `Nvh` becomes `calc(N * var(--os-vh, 1vh))`. The wrapper sets `--os-vh` to H/100, so a host can change the height.
   - The wrapper has `transform: translateZ(0)`, so `position: fixed` children (Radix popovers) stay inside it.
   - Live state goes into the markup: textarea text, input values, checked, selected, canvas as image.
   - Scripts, style and link tags are removed.
6. It renders `<name>.html` in an offscreen window of the same Electron and takes the copy shot. Then Pillow (`python3 -I`) makes the diff.

The script deletes its temp folder at exit. It never touches port 4649, the real profile or `~/.cache/huggingface`.

## Put the copy on a Design canvas

1. Read the canvas (`Artifact` read on `project/canvas.json`) and follow the type instructions. Keep all other boards.
2. Upload the font files in `assets/` as canvas assets (`asset: true`, `file_paths`). Each gets a `/_blob/<id>` url.
3. Replace `assets/<file>` in `<name>.css` with those urls. Upload the CSS as one asset. All snapshots of one app build share one CSS: check with `md5 -q <out>/*.css | sort -u`. Dark and light use the same CSS: the theme is only the `dark`/`light` class on `.os-root`.
4. Write the board file:

   ```html
   <!doctype html>
   <html lang="en">
   <head>
   <meta charset="utf-8">
   <title>...</title>
   <script src="./support.js"></script>
   <link rel="stylesheet" href="/_blob/<css id>">
   </head>
   <body>
   <x-dc>
   <helmet><style>body{margin:0;background:#0c0d0f}</style></helmet>
   <!-- the whole <name>.frag.html here -->
   </x-dc>
   <script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":1440,"height":900}}'>
   class Component extends DCLogic { renderVals() { return {}; } }
   </script>
   </body>
   </html>
   ```

   Make the board `w`×`h` equal to `--size`. Check that the fragment has no `{{` (`grep -c '{{'` prints 0).
5. A fix board edits only the changed element in the fragment, for example `style="max-height:calc(40 * var(--os-vh, 1vh));overflow-y:auto"` on the textarea. Do not recolor by hand. For another theme, take another snapshot with `--theme light`.
6. A click-through board uses the real fragment as the screen and wires only the part under test:
   - Root: `class="os-root glass {{ themeCls }}"` and `style="{{ rootStyle }}"` (height and `--os-vh` from state).
   - Trigger: the real button, plus `onClick`, `aria-expanded` and `data-state` holes.
   - Popover: the real Radix wrapper subtree from a snapshot with the popover open (from `data-radix-popper-content-wrapper` to the trailing focus guard), inside `<sc-if>`. Make the wrapper style a hole: `--radix-popper-available-height` is window height minus the popover top (254.5 px in the meeting header).
   - Outside click: a transparent `<button aria-label="Close ...">` with `position:fixed;inset:0;z-index:49` before the popover.
   - Copy the app's state rules from the source component, for example `settings-popovers.tsx`.
7. Publish the changed board files (and `project/canvas.json` only when a size changes). Read back the file list: the changed files have new sizes, all other files keep theirs.

## Verify on the canvas

The canvas needs the owner's claude.ai login. The built-in browser is not signed in. Use ego-browser (load its skill), task space on the default profile:

- Open the canvas url. Use the "Open artboard ... full window" view. Arrow keys move to the next or previous board.
- In Play, do each click as: `mouse.move`, wait 400 ms, `mouse.click`, wait 2 s, then screenshot. Clicks sent faster were lost on 2026-11-11 and looked like broken handlers.
- A click on a trigger button does not focus the textarea. Click into the textarea before you type.
- Close the task space with `task.finish({ keep: [] })`.

## Traps (found 2026-11-11)

- Without `--force-color-profile=srgb`, 20.7% of pixels differed: the real window draws Tailwind's oklch colors in Display P3, the offscreen copy in sRGB. With the flag: 0.005%.
- Style tags added for the shot leaked into the copy's CSS (`.os-root{background:...!important}`). Mark helper styles with `data-snap-helper`; the serializer skips them.
- The app never shows a bare "Them". A system segment with no label shows "Unidentified"; label "1" with no speaker name shows "Them 1".
- Folder colors are `red orange amber green teal blue violet pink` (`packages/validations/src/meeting-folders.ts`). "purple" shows no color.
- The canvas runtime parses `style` strings by splitting on `;`. Do not inline `data:` URIs in a style attribute of a board. Use `/_blob` urls.
- The runtime turns `disabled=""` into `true` and a `{{ hole }}` into the raw value, so boolean attributes work.
- The built-in browser pane shows a `file:` page outside the project as a static image. To measure a local copy, render it with Playwright from `apps/electron/node_modules/playwright`.
- A static board cannot keep a scroll position. The script prints a note for each scrolled element.

## Proving a built fix (found 2026-11-11, PR #437)

- Build first. Check that `apps/electron/out` is newer than the last commit under `apps/electron/src`. On 2026-11-11 `out/` was 5 days old.
- Prove the new build with a computed style in the renderer, not with the CSS file name. A class that already exists in the app (for example `overflow-x-hidden`) leaves the CSS file the same.
- For an overflow fix, measure BOTH axes: `scrollWidth` vs `clientWidth`, and `offsetHeight - clientHeight - border`. `overflow-y: auto` makes `overflow-x` compute to `auto`, and a 1 px rounding overflow then shows a horizontal scrollbar. A check of the vertical axis alone missed this. Look at the screenshots too.
- A driver that takes plain screenshots adds the same `data-snap-helper` flat backdrop as the snapshot script. Without it, the glass sidebar looks grey.
- The isolated app reads the real macOS mic and output device names. Hide them before a board leaves the owner's private canvas.

## Clean up

1. The script removes its temp folder and stops its server. Check: `lsof -iTCP:8791 -sTCP:LISTEN` prints nothing.
2. Delete `--out` when the boards are published, unless the task asks to keep the proof.
3. Count privacy prompts before and after: `/usr/bin/log show --last 30m --predicate 'subsystem == "com.apple.TCC"' --style compact | grep -c AUTHREQ_PROMPTING`. The count must not grow.
4. Compare `stat -f '%N %z %Sm' ~/Library/Logs/Openstyle/*` before and after. New lines must have 0 hits for `8791` and the demo titles.

## For pi children

pi children do not load skills. A brief must say: "Read `.claude/skills/prototype-snapshot/SKILL.md` and `.claude/skills/live-testing/SKILL.md` first."
