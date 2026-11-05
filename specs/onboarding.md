# Technical Spec: The first run (onboarding)

**Status:** Built on branch `feat/onboarding-v3` (PR #422). Not released.
**Date:** 2026-11-05
**Scope:** `apps/electron/src/renderer/src/onboarding.tsx`, `pages/onboarding/`, `lib/onboarding.ts`, `components/setup-cards.tsx`, `apps/electron/src/shared/onboarding.ts`, `apps/electron/src/main` (saved step, permissions, tray), `apps/server/src/routes/system.ts`, `apps/server/src/lib/mlx-asr/{reconcile,language}.ts`.
**Source of the flow:** the approved interactive prototype (2026-11-05). This file describes the flow as built.

Writing rules: Simplified Technical English (ASD-STE100). One instruction per sentence. No em-dashes.

---

## 1. Goal and rules

The first run gets the user to a working app fast, without headaches. The product decides. A choice sits behind a small secondary control.

Owner rules (2026-11-05):

1. A user who does not care about models never opens the Models page.
2. Openstyle suggests the model that fits the Mac. The user chooses what to download.
3. The user can use an own server or a cloud provider instead, for the voice model and the text model, each on its own.
4. Openstyle never forces a Whisper download.
5. Enhance is on by default. A small switch turns it off.
6. Models is visible without advanced mode. Advanced mode keeps only developer settings.
7. Openstyle does not ask for the screen recording permission in the first run.
8. One app model setting for each task. No hidden model for one step.

Nothing is saved or downloaded when a page opens. The press of the button on the Model step is the consent.

## 2. The steps

Steps are numbered 0 to 7. Six steps are counted ("Step n of 6"). The counter reads "of 4" when the `meetings` flag is off (no Name and no Enhance). It reads one less when the user chose "Decide later" (Try it is skipped).

| # | Screen | What the user does | What is saved |
|---|---|---|---|
| 0 | Welcome | Reads what the app does. Presses "Start setup". | Nothing. A quit here shows onboarding again. |
| 1 | Language | Picks up to 5 languages, or Auto-detect. The OS language is pre-selected. | `languages` setting at Continue. |
| 2 | Model | Presses "Download X and continue" (the recommendation), or "Choose another", or "Decide later". | Default voice and text model, only at the press (section 3). |
| 3 | Permissions | Allows Microphone and Accessibility, or continues without. | Nothing. |
| 4 | Try it | Dictates once into a practice email. Skip is always on. | Nothing. The hotkey saves when the user records a new one. |
| 5 | Name | Types the name. Skip is on. | `owner_name`, only when it changed. |
| 6 | Enhance | Reads the headline. A small corner switch turns Enhance off. | `meeting_enhance_auto_run` ("true" or "false") and `meeting_enhance_prompt_seen`. |
| 7 | Ready | Presses "Open Openstyle". | `onboardingComplete` in the local settings file. |

The footer of steps 2 to 7 shows the downloads that the user started (section 5).

## 3. The Model step

### 3.1 Recommendation

Main view: title "Recommended for your Mac", one card with "Voice: X" and "Text: Y", a small "Choose another" button, a text button "Decide later", and the primary button "Download <total> and continue". The Mac data (chip, RAM, disk) is not shown. A warning line shows only when the free disk is below 1.5 times the download.

Voice rule (`recommendVoice` in `lib/onboarding.ts`):

1. Qwen3 Fast, when the Mac has Apple silicon, 8 GiB of RAM or more, MLX can run or the worker can be installed, and every picked language is in the Qwen3 set.
2. Whisper Balanced in every other case. This includes Auto-detect (no language picked).

The Qwen3 set comes from the server: `qwen3LanguageCodes()` in `apps/server/src/lib/mlx-asr/language.ts` (the set that the transcribe path already uses: 30 languages, of which 28 have a code in the app language table) is in `GET /api/mlx-asr/status`, field `languages` of each Qwen3 model. The design file named 11 languages. That number is the list of the forced-aligner model (`constants.ts`). The model card of Qwen3-ASR (checked 2026-11-05) says "30 languages and 22 Chinese dialects" for the ASR models, and "11 languages" for the aligner. The code list is the one that applies to the ASR model.

Text rule (`recommendText`): the catalog model that is marked `recommended` (Gemma 4 E2B), when the fit check does not say "Won't fit". Else the first model that fits. The fit check is `computeMlxLlmFit` (`apps/server/src/lib/mlx-llm/fit.ts`). The owner rule of that function keeps the recommended model out of "Won't fit". A Mac without Apple silicon shows "Text: Not set".

### 3.2 The size on the button

`planDownload` adds: the voice model (when on this Mac and not ready), the MLX worker (once, when a chosen model needs it and it is not installed), the text model (when on this Mac and not ready). A model on a server or a provider adds 0. The button reads "Continue" when the total is 0.

The worker size is 174,000,000 bytes (`MLX_WORKER_ARCHIVE_BYTES`). It was measured on the release asset `mlx_asr_worker-darwin-arm64.tar.gz` of release 3.0.0-alpha.1 (173,960,624 bytes). `GET /api/system/profile` returns 0 when the worker is already there.

### 3.3 Choose another

The view has two sections with the same pattern: "Voice model · needed to dictate" and "Text model · optional". Each has the sources "On this Mac", "My own server" and "Cloud provider". The two sections are independent.

- On this Mac, voice: Qwen3 Fast, Qwen3 Pro, Whisper Balanced, Whisper Pro. Each row shows size, speed, quality, the fit chip and the helper size. "Change voice model" shows all rows. Other catalog models stay on the Models page.
- On this Mac, text: the catalog models, the recommended one first, then "Not now" (no text model).
- My own server: address, optional key, "Test connection". The test is `useServers().addServer` of the Models page (`POST /api/servers`): the server probes the address and saves a server that answers. A good test lists the models that fit the role. The user picks one. A failed test blocks Continue, because the server saves nothing and there is no model to keep.
- Cloud provider: provider pills, key field, "Test key". The test is `POST /api/keys/validate` (the same call as the key dialog of the Models page). It saves nothing. A key that the provider refuses blocks Continue. A test that cannot reach the provider (no internet) does not block: the user can continue and the Ready screen shows the model as not tested. The key and the default model save at the press of the button (`POST /api/keys`, `POST /api/models/configured`).
- If the user left the main view with a server or a provider, the step opens in this view.

### 3.4 What the press does (`commit` in `use-onboarding-models.ts`)

1. Voice on this Mac: save the default voice model, then start the download (`POST /api/mlx-asr/models/:id/download` or the Whisper one). The server downloads the MLX worker first (phase `building_binary` in the status, with progress), then the weights.
2. Text on this Mac: save the default LLM, start the download (`POST /api/mlx-llm/models/:id/download`).
3. Server or provider: save the default model of that kind. A provider also saves the key.
4. Save the step and the draft. Go to step 3. The user does not wait for the download.

"Decide later" removes a saved default voice model, saves nothing, downloads nothing, and skips Try it. The home screen shows the card "Pick a voice model to start dictating." until a voice model is set.

The server reconcile step (`reconcileUnsupportedMlxVoiceDefault`) no longer flips MLX to Whisper on a Mac that can install the worker (`isMlxRuntimeInstallable()`). Before, a fresh install had no worker, so `canRunMlxAsr()` was false and the default went back to Whisper at the next read.

## 4. Permissions, Try it, Enhance, Ready

- Permissions: Microphone and Accessibility cards (macOS). The step checks again every second while it is open, when the window gets focus, and when the user presses "Check again". There is no stop after 30 seconds. A denied microphone shows why and how to open System Settings. "Continue without ..." leaves the step with the permission off. The home screen then shows a card ("Turn on your microphone" or "Turn on Accessibility"). Linux keeps its own cards.
- Try it: the practice email with the hotkey as keys and as words ("Control + Option"). Continue unlocks only on a finished dictation: the pill sends `transcription:done` after it delivered the text. Typing in the email does not unlock it. While the voice model downloads, the step shows its progress. If a permission is off, the step says so and has "Fix it". "Skip, I will try later" is always on.
- Enhance: headline "We will enhance your meetings." and one line. A card shows a raw line and the clean line that fades in, in a loop (no loop with reduced motion). The corner switch "Enhance" is on when a text model is set, and off when none is set. If the user turns it on with no text model, the line says that Openstyle downloads the recommended text model when the user continues, and Continue starts that download.
- Ready: "Everything is ready" and one line. Chips for what is set: voice model, text model (each names its source), Microphone, Accessibility, Enhance. A running download or an untested provider shows an amber chip. One button. It writes `onboardingComplete` and opens `/today`.

## 5. Downloads in the footer

`summarizeDownloads` makes one state from the default models: idle, running (with percent and "About N min left", from the real speed), done, or failed. A model that is not ready, not running, after the user pressed the button, counts as stopped (the app quit, or the connection dropped). The failed state offers "Try again", "Choose another model" and "Decide later". Complete files stay on disk. The Hugging Face client fetches a partial file again from the start (`downloadHfSnapshot`).

## 6. Quit and resume

The local settings file holds `onboardingStep` (0 to 7) and `onboardingDraft` (`apps/electron/src/shared/onboarding.ts`). The draft has the languages, the source and model picks, the typed server addresses, the provider names and the Enhance switch. It never holds a key (`sanitizeDraft` keeps only known fields).

- `isOnboardingActive` is true until `onboardingComplete` is true. A saved step keeps it active, also when a model is saved on the way. A profile with models and no saved step (an old install) counts as done.
- Every Continue writes the step. At start the page opens at the saved step. A saved step that is hidden now (Try it after "Decide later") moves on to the next visible step.
- A quit during a download stops it. The next launch opens the saved step and the footer shows "Download stopped" with "Try again".
- "Reset Onboarding" in the app menu clears the saved step and draft.
- The tray popover shows "Finish setup" until the first run is complete.

## 7. Models page and advanced mode

- Models is always in the sidebar and in the Help page. The banner "Advanced mode is off" is removed. A missing model still puts a badge on the item.
- Advanced mode keeps the developer settings: task profiles and parameter editors, and the LLM inspector on meetings. The text of the setting says so.

## 8. Test seams

- `OPENSTYLE_E2E_PERMISSIONS=granted|denied` (main process, E2E mode only) answers the permission checks without the OS.
- `tests/helpers/onboarding-fakes.ts` fakes, at the HTTP layer of the renderer, the model status, the download calls, the Mac profile, the cloud model list and the key test. Saves of defaults, keys and settings go to the real server and are read back.
- The `transcription:done` event is sent from the main process in the E2E spec (`ipcMain.emit`). A real dictation needs the microphone.

## 9. Differences from the prototype

1. A server that cannot be reached blocks Continue. The prototype let the user continue and mark the model "Not tested". The server saves nothing when the probe fails, so there is no model to keep.
2. The test of an own server saves a server that answers. The prototype saved it only at Continue. The model itself saves only at Continue.
3. The row text of a model has no "about N min on Wi-Fi". The time is not measured. The footer shows the time left from the real speed.
4. The text rows have one generic line ("Runs on this Mac. Private. 4.4 GB"), not one line for each model.
5. The voice list has four rows (Qwen3 Fast, Qwen3 Pro, Whisper Balanced, Whisper Pro). The catalog names are used ("Whisper Pro", not "Whisper Large").
6. After a quit the page opens at the saved step. The design text said step 2.
7. The counter counts the visible steps (6, 5 after "Decide later", 4 without the meetings flag).
8. The progress bar is coral (`--live`), the in-progress color of the design system. The prototype used blue.
9. "Decide later" also leaves the text model unset. The prototype kept a text pick that was never saved.

## 10. Not proven

- A real dictation in the Try it step, and a real permission grant. The E2E spec uses fakes (section 8). The macOS dialogs were not exercised.
- A real download of the MLX worker and the models. The spec fakes the status and the download calls. The worker size is measured from the release asset, not from a run.
- Whether the Accessibility toggle needs an app restart on macOS, and whether Input Monitoring is needed for the hotkey. The design file listed both as open checks.
- A change of the voice model after the first press does not cancel the first download.
- The fit constants are not measured (`fit.ts`). The voice fit uses the same formula and the same constants.
