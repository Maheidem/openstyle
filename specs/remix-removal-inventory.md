# Remix removal inventory (WP-R)

Date: 2026-10-17. Language: ASD-STE100 style. Source: owner decision "REMIX = REMOVE IT NOW" (round 2, 2026-10-17; the row is Q17 in `specs/meeting-enhance-agentic.md`, section 12.2). This file belongs to the spec PR (#186). The WP-R card (11.5) names it. The WP-R implementer reads this file and no other file outside the repo.

Terms used in this file:
- "delete" means remove the whole file.
- "edit" means change the file and keep it.
- "WP" means work package.
- Path prefixes: `S` = `apps/server/src`, `E` = `apps/electron/src`, `R` = `apps/electron/src/renderer/src`, `V` = `packages/validations/src`.

## 0. Method and limits

- I read the working tree `/Users/maheidem/Documents/dev/openstyle-spec-185`. I changed no file in it.
- I ran one read-only command `git rev-parse --short HEAD`. It printed `078a358c`, not `c47cd80d`. I used no other git command. Code line numbers come from this working tree. I did not check that they equal `c47cd80d`. Spec line numbers (`specs/*.md`) can differ from `c47cd80d` if the spec branch edited them.
- The author used `grep`, `sed` and two small Node scripts that build an import graph with regular expressions. This is STATIC analysis. It is not a knip run. The scripts are not in the repo. The numbers are UNVERIFIED until the WP-R PR runs `knip` and `tsc`.
- I did not run `tsc`, `knip`, tests, `pnpm`, a browser or any installer.
- Label rules: VERIFIED means I read the line. STATIC means the import-graph script found it. UNVERIFIED means a later run must prove it.
- Tray and app menu: VERIFIED none. `grep -i remix` finds nothing in `E/main/menus.ts`. Its menu labels are at `E/main/menus.ts:126-276`.

## 1. Totals

| Item | Count |
|---|---|
| Files to delete | 42 (list in section 15.1) |
| Files to edit (code, config, tests, docs, locales) | 94, plus 1 more if D1 adds a drop migration (lists in sections 15.2 and 15.3) |
| Locale keys to delete in each of 8 locale files | 139 (1112 keys in total) |
| IPC channels to remove | 16 invoke + 5 renderer send + 7 main send + 2 pill hot-rect + 1 E2E |
| HTTP routes to remove | 6 |
| npm dependencies to remove (apps/electron) | 4: `@ai-sdk/react`, `ai`, `motion`, `remark-gfm` |
| Database tables left behind | 3 (`remix_threads`, `remix_messages`, `remix_runs`) |
| `ai` SDK import sites (spec G9 grep) | 18 now, 15 after removal (STATIC) |

## 2. Server (`apps/server`)

### 2.1 Delete

| Item | Path:lines | Note |
|---|---|---|
| Transform lib | `S/lib/remix-transform.ts:1-160` | `RemixTransformError:16`, `resolveRemixCall:63`, `runRemixTransform:95`. Uses task id `"remix"` at `:77`, `:130`, `:134`. |
| Agent lib | `S/lib/remix-agent.ts:1-133` | `REMIX_MAX_STEPS:29`, `remixClientTools:46`, `runRemixAgentLocally:65`. Uses task id `"remix"` at `:99`, `:105`. |
| Store lib | `S/lib/remix-store.ts:1-210` | Reads and writes the 3 `remix_*` tables. `purgeExpiredRemixData:197`. |
| Prompts | `S/lib/editor/remix-prompts.ts:1-230` | `sanitizeEmbeddedContent:28`, `buildRemixSystem:77`, `buildRemixPrompt:86`, `buildRemixAgentSystem:198`. No other file imports it (STATIC). |
| Route index | `S/routes/remix/index.ts:1-20` | Mounts 4 sub-routes. |
| Route transform | `S/routes/remix/transform.ts:1-56` | `POST /api/remix/transform`. |
| Route agent | `S/routes/remix/agent.ts:1-25` | `POST /api/remix/agent`. |
| Route thread | `S/routes/remix/thread.ts:1-48` | `GET /api/remix/thread`, `POST /api/remix/thread/sync`, `POST /api/remix/thread/new`. |
| Route runs | `S/routes/remix/runs.ts:1-24` | `GET /api/remix/runs`. |
| Route error helper | `S/routes/remix/error-response.ts:1-28` | Only the remix routes use it. |

### 2.2 Edit

| Item | Path:lines | Change |
|---|---|---|
| Hono registration | `S/routes/index.ts:15` (import), `:53` (`.route("/remix", remixRoute)`) | Remove both lines. |
| Request timeout list | `S/index.ts:45-46` (`"/api/remix/thread"`, `"/api/remix/runs"`) | Remove both entries. |
| Trusted-origin read guard | `S/lib/trusted-origin.ts:31` (`PROTECTED_READ_PREFIXES = ["/api/remix"]`), `:36-41`, `:42` (`isProtectedRead`) | `/api/remix` is the only entry. Remove the list and the `isProtectedRead` branch. Keep the mutation and WebSocket checks. See decision D4. |
| History sweep | `S/lib/history-store.ts:5` (import), `:48-52` | Keep `purgeExpiredHistory()`. Remove the `getHistoryRetentionDays()` call and `purgeExpiredRemixData(days)` at `:51`. `getHistoryRetentionDays` stays: `purgeExpiredHistory` calls it at `:36`. |
| Task profile | `S/lib/llm/task-profiles.ts:89-95` (`remix:` object) | Delete the object. Edit the comments at `:47` and `:144-146`. |
| Lane lease helper | `S/lib/llm/lane.ts:521-575` (`releaseLeaseOnResponseBodyEnd`, doc `:521-534`, function `:535`) | The only caller is `remix-agent.ts:122`. No test calls it (VERIFIED: no match in `apps/server/tests`). It becomes dead code. See decision D5. |
| Sampling comment | `S/lib/llm/registry.ts:127-131` | The comment says Remix needs a bigger token budget. Rewrite the comment. Keep the `max_tokens` floor code. Other callers still use it. |
| Trace comment | `S/lib/trace.ts:7` | Remove "/Remix" from the comment. |
| Settings route comment | `S/routes/settings.ts:24` | Remove `remix_hotkey` from the example list. The credential redaction code does not change. |
| Schema | `S/lib/schema.ts:585-636` | Keep. This is migration 20 history. It creates the 3 tables and renames old settings. Do not edit it. See section 13. |

### 2.3 Shared helpers the server still needs (keep)

- `S/lib/language.ts:44` `getLanguagesSetting`. Cleanup, meetings and streaming use it.
- `S/lib/editor/prompts.ts:45` `buildLanguageBlock`. The cleanup prompt uses it (`:172`).
- `S/lib/model-registry.ts:134` `isCleanupModelSupported`. `S/lib/post-process.ts:187` uses it.
- `S/lib/llm/lane.ts` `withLlmLane`, `acquireLlmLane`, `llmLaneKeyForProvider`. Cleanup and meetings use them (`post-process.ts:223`, `meetings/llm-call.ts:126`).
- `S/lib/providers.ts:54` `createChatModel` and its `task:` option (`S/lib/llm/registry.ts:20`, type `string`). Cleanup and meetings use it.
- `@openstyle/stt` `maxOutputTokensForCleanup` and `stripWrappingQuotes`. Cleanup uses them.

## 3. Shared packages

| Item | Path:lines | Action | Note |
|---|---|---|---|
| Remix contracts | `V/remix.ts:1-271` | delete | Exports: `REMIX_PRESETS:34`, `findRemixPreset:55`, `remixTransformSchema:64`, `remixContextSchema:90`, `remixAgentRequestSchema:113`, `REMIX_WRITE_LIMIT:121`, `REMIX_CLIPBOARD_LIMIT:122`, `REMIX_CLIENT_TOOLS:135` (13 tools), `REMIX_CLIENT_TOOL_NAMES:265`, `isRemixClientTool:269`. The header (`:12-14`) says "mirrored into the cloud repo". The cloud was removed, so the rule is stale. |
| Barrel export | `V/index.ts:19` | edit | Remove `export * from "./remix.js";`. |
| Settings keys | `V/settings-keys.ts:17-18` (`remixHotkey`, `remixBarEnabled`) | edit | Remove both keys. `E/shared/settings-keys.ts` only re-exports this file. |
| LLM task id | `V/llm-task-profiles.ts:11` (`"remix"` in `LLM_TASK_IDS`), doc `:3-8` ("four call sites") | edit | Remove the id. Change "four" to "three". |
| Logger comment | `packages/utils/src/logger.ts:12-17` | edit | The size note names "Remix agent turn". Rewrite or remove. |
| Validators for Remix keys | none | none | VERIFIED: `V/settings.ts` and `S/lib/setting-validators.ts` have no Remix validator. |

Effect of the task-id removal (VERIFIED):
- `parseLlmTaskAssignments` drops unknown task keys on read (`V/llm-task-profiles.ts:179`). A stored `remix` assignment is ignored. The Models page writes the full parsed map on the next save (`R/pages/models/use-models.ts:583-600`). The stale `remix` key then disappears from the stored value. No data migration is needed for this.
- `checkTaskAssignments` ignores unknown task keys on write (`S/lib/setting-validators.ts:102`).
- `S/lib/own-servers-migration.ts:175-221` loops over all keys and does not name tasks. No change.

## 4. Electron main process (`apps/electron/src/main`)

### 4.1 Delete

| Item | Path:lines | Note |
|---|---|---|
| Remix bar window | `E/main/remix/bar-window.ts:1-197` | Bottom-edge sliver window. Loads `getRemixBarURL()` (`:88`). `updateRemixBar:127`. |
| Remix hotkey | `E/main/remix/hotkey.ts:1-248` | Native key listener, hold and tap logic, selection capture, `applyRemixSettings:239`, `handleRemixBarOpen:228`, `cancelRemixRetries:177`. |
| Remix IPC | `E/main/remix/ipc.ts:1-392` | `registerRemixIpc:41`. All `remix:*` handlers. See section 5. |
| Remix helpers | `E/main/remix/helpers.ts:1-120` | `clipboardPreviewFields:20`, `REMIX_PRESSABLE_KEYS:34`, `withFocusedAnchor:52`, `fetchRemixImage:95`. |
| Target check | `E/main/remix-target.ts:1-13` | `isRemixTargetAllowed`. |
| Accessibility wrapper | `E/main/mac-ax.ts:1-137` | Only `remix/hotkey.ts`, `remix/helpers.ts` and `remix/ipc.ts` import it (STATIC). Exports: `runMacAxRead:33`, `runMacAxSelect:44`, `runMacAxCaps:53`, `isSecureInputActive:66`, `runMacAxKey:70`, `sendSelectAllToFocusedApp:75`, `sendChordToFocusedApp:89`, `runKeystrokeScript:108`, `activateAnchorApp:125`. See decision D6. |
| Shared Remix types | `E/shared/remix.ts:1-113` | `getDefaultRemixHotkey:17` (Fn+Control on macOS, Control+Alt+E elsewhere), `REMIX_HOLD_THRESHOLD_MS:35`, payload types, `REMIX_CLIPBOARD_PREVIEW_LIMIT:113`. |

### 4.2 Edit

| Item | Path:lines | Change |
|---|---|---|
| Main entry | `E/main/index.ts:64-65` (imports), `:136-137` (seed `remixBarHeldForOnboarding`), `:262-263`, `:299` (`registerRemixIpc()`) | Remove these lines. Keep `isOnboardingActive()` and the permission warning at `:261-272`. |
| Main state | `E/main/main-state.ts:11` (comment), `:21-26` (`RemixAnchor`), `:41-42`, `:47-51`, `:62-68`, `:78` (types), `:92-112` (defaults) | Remove 11 fields: `remixKeyListener`, `remixPressed`, `currentRemixAccel`, `remixInitialized`, `remixPracticeTarget`, `remixAnchor`, `remixBarWindow`, `remixBarEnabled`, `remixBarHeldForOnboarding`, `remixBarFollowTimer`, `remixStuckTimer`. Remove `lastPillHideAt` (`:69`, `:107`) too. Only the Remix bar reads it (`remix/bar-window.ts:144`, `remix/hotkey.ts:231`). `pill-window.ts:548` writes it. |
| Core IPC | `E/main/ipc/core-ipc.ts:50-51` (imports), `:215` (`"remix-chat"` argument), `:221-238` (`pill:set-hot-rect`), `:269-271` (onboarding complete), `:284-290` (park remix listener) | Remove the Remix lines. `pill:set-expanded` stays and accepts only `"card"`. |
| Quit | `E/main/quit.ts:13` (import), `:45` (`cancelRemixRetries()`), `:51-54`, `:60-63` | Remove. |
| Resets | `E/main/resets.ts:17-18` (imports), `:32-33`, `:92` | Remove. |
| Settings window | `E/main/windows/settings-window.ts:101`, `:108` | Remove the two `remixPracticeTarget = false` lines. The `did-navigate` handler at `:107-109` then has an empty body. Remove it. |
| Renderer URLs | `E/main/renderer-urls.ts:15-17` (`getRemixBarURL`) | Remove the function. |
| Pill window | `E/main/windows/pill-window.ts:1`, `:4` (comments), `:13-14`, `:24` (imports), `:37-60` (`PILL_CHAT_*`, `PillExpansion`, `pillExpansionSize`), `:52-97` (hot-rect), `:128`, `:163-215` (`setPillExpanded`), `:410-430` (dev `[remix]` log mirror), `:442` (`remixBarWindow?.hide()`), `:475`, `:488`, `:528-530` (`chatLike`), `:548`, `:558-565` | See section 4.3. |
| Dictation hotkey | `E/main/hotkeys/dictation.ts:22-24` (imports), `:61` (`applyRemixSettings`), `:72-78` (`remix-hotkey:reload` handler), `:412-413` (re-resolve remix), `:559` (`remixAccel`) | Remove these lines. |
| Hotkey watchdog | `E/main/hotkeys/stuck-release.ts:1-3` (comments), `:19-24` (`clearRemixStuckWatchdog`), `:26-58` (`setRemixRouteKeys`, Control+1..3 route shortcuts) | Delete the Remix parts. Keep `HOTKEY_STUCK_TIMEOUT_MS:11` and `clearHotkeyStuckWatchdog:13`. |
| Hotkey utils | `E/main/hotkey-utils.ts:138-157` (`isLanguageHotkeyTaken:145`, `remixAccel:149`) | Remove the `remixAccel` option and the check at `:154`. Fix the doc comment. |
| Retry comment | `E/main/hotkeys/native-retry.ts:2` | Remove "Remix" from the comment. |
| Frontmost context | `E/main/active-window.ts:467-498` (`FrontmostContext`, `getFrontmostContext`) | Dead after removal (STATIC: only Remix files import it). Delete. Keep `getOpenstyleAppExclusions:30` and the `get*FrontmostApp` functions. Fix the comment at `:34`. |
| Paste module | `E/main/paste.ts:536-677` (`copySelectionFromFocusedApp`, `CopySelectionOptions`, `COPY_*`, `sendCopyToFocusedApp`, `attemptCopy`, `doCopySelection`), `:733-747` (`pasteClipboardIntoFocusedApp`, `doPasteClipboard`) | Dead after removal (STATIC). Delete. See decision D6. |

### 4.3 Pill window detail (`E/main/windows/pill-window.ts`)

- Remove the hot-rect code (`:52-97`) and the call at `:211`. Only the Remix room used it (STATIC: `setPillHotRect` has callers only in `R/pages/app.tsx:1017-1044` and `core-ipc.ts:221-238`).
- Keep the failure card size (`PILL_CARD_WIDTH:35`, `PILL_CARD_HEIGHT:36`) and `setPillExpanded` for `"card"`. The dictation failure card uses it (`R/pages/app.tsx:798`).
- `updatePillEscape` (`:527-543`): remove the `chatLike` test. Escape is then global whenever the pill is visible.
- `hidePill` (`:545-571`): remove `lastPillHideAt`, `remixPressed`, `clearRemixStuckWatchdog`, `setRemixRouteKeys(false)` and `updateRemixBar()`. The `setFocusable(false)` call at `:562-564` has the comment "Chat may have set focusable". It may stay as a safe reset (decision D7).
- `showPill` (`:442`, `:475`, `:488`): remove `remixBarWindow?.hide()` and both `updateRemixBar()` calls.

## 5. Preload and IPC (VERIFIED by `grep -o` over `main`, `preload`, `renderer`)

`E/preload/index.ts`: remove imports `:20-28`, `defaultRemixHotkey:48`, the `"remix-chat"` argument type `:63`, the comment `:65`, and the whole Remix block `:168-252`. Remove `setPillHotRect:67-69` and `onPillHotEnter:70`.

| Direction | Channels | Defined at |
|---|---|---|
| Renderer to main, `invoke` (16) | `remix:paste`, `remix:get-context`, `remix:read-document`, `remix:select-all`, `remix:collapse-selection`, `remix:copy`, `remix:set-clipboard`, `remix:set-clipboard-image`, `remix:paste-clipboard`, `remix:select-text`, `remix:undo`, `remix:redo`, `remix:press-key`, `remix:get-clipboard`, `remix:paste-text`, `remix:recapture` | handlers `E/main/remix/ipc.ts:43,69,106,123,132,144,159,172,181,200,244,253,262,287,297,316`; preload `E/preload/index.ts:171-225` |
| Renderer to main, `send` (5) | `remix-hotkey:reload`, `remix:set-practice-target`, `remix:set-route-keys`, `remix:bar-hover`, `remix:set-chat-focus` | handlers `E/main/hotkeys/dictation.ts:73`, `E/main/remix/ipc.ts:358,372,377,382`; preload `E/preload/index.ts:169,227-240` |
| Main to renderer (7) | `remix:down`, `remix:up`, `remix:selection`, `remix:supersede`, `remix:open-chat`, `remix:route`, `remix:practice-delivered` | senders `E/main/remix/hotkey.ts:59,77,84,86,96,97,235`, `E/main/hotkeys/stuck-release.ts:48`, `E/main/remix/ipc.ts:190,305`; listeners `E/preload/index.ts:173-252` |
| Pill hot-rect (2) | `pill:set-hot-rect`, `pill:hot-enter` | `E/main/ipc/core-ipc.ts:221`, `E/main/windows/pill-window.ts:95`, `E/preload/index.ts:67-70` |
| E2E only (1) | `e2e:remix-practice-target` | `E/main/remix/ipc.ts:365-369`; caller `apps/electron/tests/app.test.ts:186` |
| Argument value | `"remix-chat"` for `pill:set-expanded` | `E/main/ipc/core-ipc.ts:215`, `E/preload/index.ts:63` |

Guard: `apps/electron/tests/preload-channels.test.ts` fails if a preload member has no main handler, or a main `send` has no preload listener. Remove both sides together. Vitest runs this test (`apps/electron/vitest.config.ts:19`).

Global keyboard shortcuts that go away: Remix hotkey (default Fn+Control on macOS, Control+Alt+E elsewhere, `E/shared/remix.ts:17-26`) and route keys Control+1..3 on macOS or Control+Alt+1..3 elsewhere (`E/main/hotkeys/stuck-release.ts:28-58`).

## 6. Renderer (`apps/electron/src/renderer`)

### 6.1 Delete

| Item | Path:lines | Note |
|---|---|---|
| Remix page | `R/pages/remix.tsx:1-454` | Route `/remix` (`R/dashboard.tsx:32`, `:101`). Calls `api.remix.runs.$get` (`:75`). |
| Remix chat | `R/components/remix-chat.tsx:1-1183` | Uses `useChat` from `@ai-sdk/react` (`:1`), `ai` (`:12-19`), `apiFetch` to `/api/remix/*` (`:98`, `:264`, `:399`, `:611`, `:909`). |
| Chat styles | `R/components/remix-chat-styles.ts:1-382` | |
| Chat surface sizes | `R/components/remix-chat-surface.ts:1-11` | `REMIX_CHAT_STRIP`, `REMIX_CHAT_SURFACE`. |
| Remix bar entry | `R/components/remix-bar.tsx:1-92` | Entry of `bar.html`. Also a knip entry (`knip.jsonc`). |
| Bar HTML | `apps/electron/src/renderer/bar.html:1-14` | Title "Openstyle Remix". Script `/src/components/remix-bar.tsx`. |
| Pill Remix session hook | `R/pages/pill/use-remix-session.ts:1-648` | `useRemixSession`, `useRemixHotkeys`. Own `Streamer` (`:108-131`). |
| Onboarding Remix step | `R/pages/onboarding/remix-step.tsx:1-244` | |
| Agent UI kit | `R/components/agents/` (7 files: `README.md`, `agent-disclosure.tsx`, `message-scroller.tsx`, `loading-states/thinking-shimmer.tsx`, `agent-activity/index.tsx`, `agent-activity/activity-row.tsx`, `agent-activity/types.ts`) | Only `remix-chat.tsx` imports them (STATIC). See decision D2. |
| Motion easing constants | `R/lib/ease.ts:1-17` | Only `agents/*` imports it (STATIC). |
| Brand mark | `R/components/openstyle-mark.tsx` | After the edit of `pill-view.tsx:445` nothing imports it (STATIC). |
| Latch hook | `R/hooks/use-latched-value.ts` | Only `R/pages/app.tsx:956-970` uses it, for Remix views (STATIC). |

### 6.2 Edit: pill (the pill window is shared with dictation)

| Item | Path:lines | Change |
|---|---|---|
| Pill page | `R/pages/app.tsx` | Remove: imports `:1`, `:20`, `:39-40`, `:52`; state `:118-146`; `shared` fields `:256-257`, `:269-279`; hook call `:366-383`; `endRemix` calls `:459`, `:497`, `:545-547`, `:560`; `useRemixHotkeys` `:566-574`; error timer `:582-587`; unmount cleanup `:606-611`; render flags `:622-638`; `remixStatus` `:745-757`; `accessibleStatus` Remix branch `:759-760`; `setPillExpanded(..., "remix-chat")` `:798`, dependency `:817`; `showRemixCard` guard `:827-830`; Remix card content `:952-1005`; hot-rect effects `:1007-1054`; PillView props `:1059-1101`. Keep: capsule, failure card, `setPillExpanded(true, "card")`, `FAILURE_CARD_MS` timer `:589-592`. |
| Pill view | `R/pages/pill/pill-view.tsx` | Remove: imports `:2`, `:4-6`, `:17`; lazy `RemixChat` `:40-45`; props `:48`, `:73-90`; Remix card layer `:399-468`; chat layer `:470-535`; `showRemixCard` guards `:144`, `:234`, `:251`. Keep the capsule (up to `:374`) and the failure card (`:376-397`). |
| Pill shared type | `R/pages/pill/pill-shared.ts:5`, `:13`, `:28-29`, `:42-52` | Remove 11 Remix refs and 2 setters. |
| Pill constants | `R/pages/pill/constants.ts:111-116` (`REMIX_WARNING_MS`), `:177-215` (`RemixPhase`, `RemixSession`), `:217-228` (`Deferred`, `deferred`) | Delete. Check `VIEW_LATCH_MS:94` too: only the Remix latch uses it. |
| Pill dismiss | `R/pages/pill/use-pill-dismiss.ts:68-74` | `resetDictation` was split out for Remix. `hidePill` is its only other caller. Inline it, or fix the comment. |
| Waveform comment | `R/pages/pill/use-waveform.ts:98` | Comment names "the remix card". Fix. |
| Pill CSS | `R/pages/pill-styles.ts:63-75` (`.pill-rise*`), `:76-90` (`.pill-chat-morph`), `:91-145` (`.pill-remix-*`), `:320` (reduced-motion `.pill-rise`) | Delete. `.pill-rise` has no user except the Remix card (STATIC: `pill-view.tsx:442,450`). |
| Streamer comment | `R/lib/streamer.ts:35-36`, `:378-379` | `onPartial` has no user after removal. Remove the callback and the `partial` case, or fix the comment. See decision D8. |

### 6.3 Edit: dashboard, settings, help, onboarding

| Item | Path:lines | Change |
|---|---|---|
| Routes | `R/dashboard.tsx:32` (lazy import), `:101` (`/remix` route) | Remove. Old links to `/remix` then show the 404 page. No code links to `/remix` (VERIFIED by grep). |
| Sidebar | `R/shell.tsx:19` (`Wand2` import), `:61-65` (nav item) | Remove. Shortcut numbers are computed at runtime (`R/shell.tsx:195`), so no number edit. |
| Settings page | `R/pages/settings.tsx:103` (import), `:126` (`"remix"` section id), `:186-188` (state), `:455-470` (handlers), `:489-491` (load), `:943`, `:1067` (dictation and language `isBlocked` clauses), `:1146-1186` (Remix panel with hotkey row and bar switch) | Remove. `parseSettingsSection` (`:143-148`) falls back to `"recording"` for an old `#remix` hash. |
| Help page | `R/pages/help.tsx:16` (import), `:96-105` (quick-route constants and doc), `:122` (nav item), `:143-146` (hotkey value), `:180-184` (Remix row), `:187-198` (Quick routes row) | Remove. `KbdSep:64` has no user after this (local function): remove it. `IS_MAC` and `KeyBadge` stay. |
| Onboarding page | `R/onboarding.tsx:25`, `:31`, `:34` (`Step` type), `:40-42`, `:90-111`, `:136-137`, `:269`, `:280`, `:284-298`, `:304` | Remove the `remix` step. `DraftStep.onContinue` goes to `enhance` (or `finishSetup()` when Meeting Mode is off, as `:293-296` does today). `EnhanceStep.onBack` goes to `draft`. |
| Draft step | `R/pages/onboarding/draft-step.tsx:18`, `:30`, `:84-85` | Remove `remixHotkey` prop and the `conflictHotkey` and `conflictNotice` props. The button label may need `onboarding.tutorial.finish` when this step is last (decision D3). |
| Onboarding shared | `R/pages/onboarding/shared.tsx:23-24` (comment), `:34` (`target` union), `HotkeyRebindControl` `conflictHotkey` and `conflictNotice` props | Narrow to `"dictation"`. Remove the conflict props. |
| Email draft mock | `R/components/onboarding/email-draft.tsx:17`, `:28-36`, `:63`, `:81`, `:89` | Remove `stage: "remix"`, `scriptedBody`, `highlightBody`, `highlightSignal` and their effects. Keep the dictation mode. |
| Coach strip comment | `R/components/onboarding/coach-strip.tsx:10-11` | Fix comment. |
| Hotkey demo | `R/components/hotkey-demo.tsx:7`, `:20`, `:34-36` | Remove the `"remix"` source. `useCoachPress` then needs no `source` argument. `KeyGroup`, `StepWord`, `Wave` stay: `tutorial-demo.tsx:9` and `coach-strip.tsx:5` use them. |
| Recorder types | `R/components/hotkey-recorder-control.tsx:56`, `R/hooks/use-hotkey-recorder.ts:343-348`, `:480` | Change `target` union to `"dictation" \| "language"`. Fix comments. |
| Query keys | `R/lib/query.ts:83-84` (`remixRuns`) | Remove. |

### 6.4 Models page (LLM task id UI)

- The Models page lists rows from `LLM_TASK_IDS`: `R/pages/models/task-profiles-section.tsx:147`. No code names `remix` there (VERIFIED). Removing the id removes the row.
- Row title comes from locale key `models.taskProfiles.remix.name` and the description from `models.taskProfiles.remix.desc` ("Quick edits and the canvas agent."). The delete dialog text uses the same key pattern: `R/pages/models/index.tsx:372`.
- `R/pages/models/preset-ops.ts:110` and `use-models.ts:268` loop over `LLM_TASK_IDS`. No code edit.

## 7. Locale keys (all 8 files)

Files: `R/locales/template.json`, `en.json`, `de.json`, `es.json`, `fr.json`, `it.json`, `ja.json`, `pt.json`. VERIFIED by script: each file has the same 139 Remix keys. The count is leaf keys. `grep -c` shows fewer lines because some keys are nested.

| Key group | Keys | Used by |
|---|---|---|
| `remixPage.*` | 34 | `R/pages/remix.tsx` |
| `remixChat.*` | 59 | `R/components/remix-chat.tsx`, `use-remix-session.ts:598` |
| `remixBar.open` | 1 | `R/components/remix-bar.tsx:45` |
| `pill.remix.*` | 17 | `R/pages/app.tsx:750-756`, `:1003-1004`; `use-remix-session.ts` |
| `onboarding.remix.*` | 14 | `R/pages/onboarding/remix-step.tsx` |
| `settings.remix.*` | 5 | `R/pages/settings.tsx:1149-1176`; `remix-step.tsx:229` |
| `settings.sections.remix` | 1 | `R/pages/settings.tsx:797`, `:1546` (dynamic key) |
| `shell.nav.remix` | 1 | `R/shell.tsx:64`, `R/pages/help.tsx:122` |
| `models.taskProfiles.remix.{name,desc}` | 2 | Models page (dynamic key) |
| `help.hotkeys.remixLabel`, `remixDesc` | 2 | `R/pages/help.tsx:181-182` |
| `help.hotkeys.quickRoutesLabel`, `quickRoutesDesc` | 2 | `R/pages/help.tsx:188-189`. Hidden coupling: the key path has no word "remix". |
| `settings.recording.conflict` | 1 | Only `draft-step.tsx:85` uses it. The text says "Remix hotkey". Hidden coupling: no word "remix" in the path. |
| Total | 139 | |

Keep these keys (still used): `common.voiceWaveform` (`R/components/hotkey-demo.tsx:251`), `onboarding.tutorial.finish`, `settings.recording.languageHotkeyConflict`.

`R/locales/locales.test.ts` needs edits (it checks that every locale carries required keys):
- `:214-217` group `"remix-demo"`: remove `remixPage.demo.sentence`. Keep `common.voiceWaveform` in another group.
- `:243-249` group `"aria-title-i18n"`: remove `remixBar.open` and 6 `remixChat.*` entries.
- `:252` comment; `:322-384` group `"fixed-english-i18n"`: remove the `pill.remix.*` and `remixChat.*` entries.
- `:387-408` group `"pill-errors-remix-steps-i18n"`: remove `pill.remix.*` and `remixChat.*` entries. Keep the `pill.error.*` entries and `settings.sections.network`. Rename the group.
- `:487-502` `SENTENCE_KEYS`: remove `remixPage.demo.sentence`.

## 8. Tests

### 8.1 Delete

| Test | Path:lines |
|---|---|
| Remix prompt and tool tests | `apps/server/tests/remix-prompts.test.ts:1-196` |
| Remix model preflight test | `apps/server/tests/remix-model-preflight.test.ts:1-99` |
| Remix store test | `apps/server/tests/remix-store.test.ts:1-157` |
| E2E mini strip test | `apps/electron/tests/remix-mini-strip.test.ts` (fake server for `/api/remix/thread`, `:57`) |
| Remix target test | `apps/electron/tests/remix-target.test.ts:1-34` |

### 8.2 Edit

| Test | Path:lines | Change |
|---|---|---|
| Task profile test | `apps/server/tests/llm-task-profiles.test.ts:92-98` (expects `LLM_TASK_PROFILES.remix`), `:395-402` (`resolveTaskCall("remix", ...)`) | Delete the first block. Replace the second task with `meetingSummarize` or `meetingEnhance`. |
| Timeout test | `apps/server/tests/meeting-llm-timeouts.test.ts:425-428`, `:435-444` | Remove the `remix` lines and fix the comments. |
| Assignment parse test | `apps/server/tests/llm-parameter-presets.test.ts:120-126` | Use `meetingEnhance` as the valid key. |
| Setting validator test | `apps/server/tests/settings-validators.test.ts:136-141` | Use `meetingEnhance` in the bad-entry row. |
| Own-server migration test | `apps/server/tests/migration-servers.test.ts:282`, `:304` | Replace the `remix` key with `meetingEnhance`. |
| Trace test comment | `apps/server/tests/trace.test.ts:296-298` | Rewrite comment. The streaming test stays valid. |
| Outbox migration comment | `apps/server/tests/sync-outbox-migration.test.ts:32` | Fix the comment ("v19 Remix"). |
| v20 reconciliation test | `apps/server/tests/v20-merge-reconciliation.test.ts:52`, `:81`, `:107-109`, `:141` | Edit only if a drop migration is added (section 13). The test expects the 3 tables after `initSchema`. |
| Preset ops unit test | `R/pages/models/preset-ops.test.ts:186-194`, `:211-225`, `:248-262`, `:272-281`, `:289`, `:352-359` | Use `meetingEnhance` where the test uses `remix` as a task id. |
| Native retry test | `E/main/hotkeys/native-retry.test.ts:76` | Change the label string `"Remix"`. |
| Language hotkey test | `apps/electron/tests/language-hotkeys.test.ts:74`, `:80-104` | Remove `remixAccel` and the "clashes with the remix hotkey" case. |
| App E2E | `apps/electron/tests/app.test.ts:132` (title), `:151-154` (waits for "Remix needs an assistant model"), `:156` (clicks "Start using Openstyle"), `:182-188` (`e2e:remix-practice-target`) | The draft step becomes the last step before Enhance. Rewrite the flow. Remove the practice-target check. |
| E2E helper | `apps/electron/tests/helpers/e2e-app.ts:61-63`, `:76` | Remove the `bar.html` filter and fix the comment. |
| Preset CRUD E2E | `apps/electron/tests/preset-crud-evidence.test.ts:140` (preset name "Punchy remix"), `:368` (`bar.html` filter), `:459`, `:594` (`remix:` assignment), `:669-671`, `:680-686` (expects 4 rows, "Quick edits and the canvas agent"), `:701`, `:719`, `:798`, `:1058` | The Models page then has 3 rows. Move the second preset to `meetingEnhance`. Change the expected row count to 3. Rename the preset. |

Count of server vitest files that import the `ai` SDK and stay: `llm-task-profiles.test.ts`, `openai-cloud-provider.test.ts`, `server-provider.test.ts`, `trace.test.ts` (STATIC).

## 9. Build, config and scripts

| Item | Path:lines | Action |
|---|---|---|
| Vite entry | `apps/electron/electron.vite.config.ts:127` (`bar: resolve("src/renderer/bar.html")`) | edit: remove the line. Fix 2 comments: `:36` (route list names `/remix`) and `:56` (names `getRemixBarURL`). |
| Knip entry | `knip.jsonc:61` (entry `src/renderer/src/components/remix-bar.tsx` in the `apps/electron` workspace) | edit: remove the entry. |
| Native build list | `apps/electron/scripts/compile-native.js:129-133` (`macos-ax`) | edit: remove the entry. See decision D6. |
| Native source | `apps/electron/native/macos-ax.swift:1-` | delete (with D6). Header says "lets Remix see a whole document" (`:5`). |
| Fast-paste doc | `apps/electron/native/macos-fast-paste.swift:11-13` | optional edit. The binary still accepts `c`, `a`, `z` arguments. After removal only `v` (paste) is used (STATIC). Keep the code. Fix the "Commands pass c" comment. |
| Native verify list | `apps/electron/scripts/verify-native-binaries.mjs` | no change. VERIFIED: it does not list `macos-ax`. |
| Site capture filter | `scripts/site-captures/capture.mjs:125` (`!u.includes("bar.html")`) | edit: remove the clause. |
| shadcn registry | `apps/electron/components.json:21-22` (`@beui` registry) | optional edit. Only the deleted `agents/` folder used it. |
| Renderer asset check | `apps/electron/scripts/check-renderer-asset-urls.mjs` | no change. It reads all `out/renderer/*.html`. |
| Builder config | `apps/electron/electron-builder.yml` | no change. VERIFIED: no Remix item. `NSAppleEventsUsageDescription` talks about paste, so it stays. |
| macOS entitlements and Accessibility prompt | n/a | no change. Paste still needs Accessibility (`macos-fast-paste`). |

## 10. npm dependencies (STATIC, `deps.mjs`)

These `apps/electron/package.json` dependencies have no import left after the removal:

| Dependency | Line | Only importer today |
|---|---|---|
| `@ai-sdk/react` | `apps/electron/package.json:34` | `R/components/remix-chat.tsx:1` |
| `ai` | `apps/electron/package.json:42` | `R/components/remix-chat.tsx:12-19` |
| `motion` | `apps/electron/package.json:52` | `remix-chat.tsx:20` and the 4 `components/agents/*` files |
| `remark-gfm` | `apps/electron/package.json:60` | `remix-chat.tsx:33` |

Keep `react-markdown` (`R/components/markdown.tsx:1`, used by `R/pages/meetings/detail.tsx:3`) and `diff` (`R/lib/history-diff.ts:1`).

Server and packages: no dependency becomes unused (STATIC: `deps.mjs` found none).

Lock file `pnpm-lock.yaml` (UNVERIFIED, needs `pnpm install --lockfile-only`; I did not run it):
- Importer entries to remove: `@ai-sdk/react` (`:64`), `ai` in apps/electron (`:91`), `motion` (`:118`), `remark-gfm` (`:142`).
- Package entries that should drop: `@ai-sdk/react@3.0.242` (`:430`, `:5204`) and `ai@6.0.240` (`:2890`, `:7356`). Only `@ai-sdk/react` pulls `ai@6.0.240` (`:5207`). The lock then holds one `ai` version, 6.0.191. This helps spec goal G9 (`specs/meeting-enhance-agentic.md:254`).
- Check `motion@12.43.0` (`:4134`) and `framer-motion@12.43.0` (`:3474`) for other users before you remove them.

## 11. Docs, site and skills

| Item | Path:lines | Action |
|---|---|---|
| Remix spec | `specs/remix.md:1` ("Status: Stale"), 814 lines | edit: mark RETIRED 2026-10-17. Keep the file. Owner decision says "mark specs/remix.md as retired". Change the status block and the code links at `:3-10` (those files will not exist). |
| Project guide | `AGENTS.md:13` (route list names "remix"), `:21` (`macos-ax.swift ... Remix document access`), `:39` ("four task ids ... `remix`"), `:44` ("Remix primitives"), `:45` ("remix" data, `remix-chat.tsx` uses `apiFetch`), `:50` (`remix_threads/messages/runs` in persistence list), `:135` (`remix.md` in spec list) | edit: 7 places. |
| README | `README.md:34`, `:44-45` | edit: remove the 2 feature lines. |
| Long-term knowledge | `.lore.md` lines `36, 39, 48, 51, 54, 57, 60, 66, 72, 78, 81, 120, 123, 126, 129, 138, 156, 207, 213, 222, 231, 234, 237, 240, 243, 258, 267, 282, 285, 288, 291, 294, 297, 300, 306, 360, 363, 399, 428, 464, 482, 491, 494, 503, 506, 509, 575, 578, 581, 641, 707, 710, 713, 716, 770, 773, 779, 839, 857, 866, 914, 923, 947, 956, 1074, 1179` | edit: delete the entries that only describe Remix; fix the mixed entries. The file is tool-maintained, so ask the owner how to edit it (decision D9). |
| Changelog | `CHANGELOG.md` (9 mentions) | no edit. History. The release process writes the next entry. |
| Site | `site/index.html:492-495` (feature item "Remix: Rewrite text with a prompt") | edit: remove the item. No other site file mentions Remix (VERIFIED: `site/llms.txt`, `llms-full.txt`, `assets/screens` have none). |
| Skills | `.claude/skills/live-testing/SKILL.md:156` (bar.html), `.claude/skills/site-captures/SKILL.md:59` ("Do not show Remix") | edit: fix line 156; remove the bullet at line 59. |
| Other specs, live text | `specs/llm-task-profiles.md` (lines 33, 39, 73, 74, 118, 134, 153, 165, 184, 192, 487, 626, 655, 814, 815, 913, 914, 1037-1062, 1098, 1375-1469, 1662-1725, 1811-1812), `specs/dictation-language-hotkeys.md` (39 lines, e.g. 60, 80, 139-160, 405, 524-530, 840-889, 979-1014), `specs/meeting-llm-queue.md` (41, 42, 93, 155, 290, 291, 409, 411, 442, 443, 679, 680, 749, 753), `specs/under-the-hood.md` (441, 479, 506, 548-551, 565, 584), `specs/design-system.md` (99, 110, 113, 270, 278), `specs/roadmap-2026-08.md` (69, 143-145), `specs/model-picker-groups.md` (45, 309, 311), `specs/meeting-diarization.md` (548, 567) | edit: add one "Remix retired 2026-10-17" note at the top of each file. Leave the body as history. Rewrite only `specs/llm-task-profiles.md` task tables (the live source for task ids). |
| Other specs, history | `specs/openstyle-separation-audit.md` (17, 108, 114, 120, 129-130, 149, 168, 194, 206, 240-247, 523), `specs/design/reskin-mockups.html` (101 lines) | leave. They record past audits and mockups. |
| Spec being written | `specs/meeting-enhance-agentic.md` (31 mentions: 197, 254, 524, 1744, 2025, 2047, 2191, 2242, 2256-2258, 2323, 2352-2353, 2383, 2405-2417, 3014, 3119, 3316, 3439, 3479, 3788, 3979-3985, 4003, 4067, 4101, 4119) | owned by the spec author, not by the Remix WP. See section 14.3. |

## 12. Hidden couplings

### 12.1 Shared code that STAYS (do not delete)

| Shared item | Path | Why it stays |
|---|---|---|
| Pill window, capsule, waveform, failure card | `R/pages/app.tsx`, `pill-view.tsx`, `E/main/windows/pill-window.ts` | Dictation uses them. The Remix code lives inside the same files. Edit by region, do not delete. |
| `setPillExpanded` and the `"card"` size | `pill-window.ts:163`, `core-ipc.ts:211` | The dictation failure card needs the room (`app.tsx:798`). |
| Escape global shortcut | `pill-window.ts:526-543` | Dictation cancel uses it. |
| Native key listener class | `E/main/key-listener.ts` | Dictation and language hotkeys use it. |
| `startNativeRetry` | `E/main/hotkeys/native-retry.ts` | Dictation and language listeners use it. |
| `HOTKEY_STUCK_TIMEOUT_MS`, `clearHotkeyStuckWatchdog` | `E/main/hotkeys/stuck-release.ts:11-17` | Dictation uses them. |
| `getOpenstyleAppExclusions` | `E/main/active-window.ts:30` | `normalizeOpenAppCandidates:44` uses it. |
| `get{Mac,Windows,Linux}FrontmostApp`, `getFocusedWindowDisplay` | `E/main/active-window.ts` | `core-ipc.ts:332-348` and `pill-window.ts:506` use them. |
| `pasteIntoFocusedApp(text)` | `E/main/paste.ts:691` | `core-ipc.ts:88` uses it for dictation. Its `beforePaste` and `options.trailingSpace` parameters have no user after removal (optional cleanup). |
| `snapshotClipboard`, `restoreClipboard`, `injectPaste` | `E/main/paste.ts:487`, `:514`, `:455` | Paste uses them. |
| `macos-fast-paste` binary | `native/macos-fast-paste.swift`, `compile-native.js:97` | Paste uses it. |
| `Recorder` class incl. `generation()` and the `gen` guard | `R/lib/recorder.ts` | `use-dictation-session.ts:260` uses it. |
| `Streamer` class | `R/lib/streamer.ts` | Dictation uses it. |
| `AlertCardBody` | `R/components/alert-card-body.tsx` | The failure card uses it (`pill-view.tsx:387`). |
| `Wave`, `KeyGroup`, `StepWord`, `useCoachPress` | `R/components/hotkey-demo.tsx` | `tutorial-demo.tsx`, `coach-strip.tsx`, `draft-step.tsx` use them. |
| `HotkeyRebindControl`, `useHotkeyRecorder` | `R/pages/onboarding/shared.tsx`, `R/hooks/use-hotkey-recorder.ts` | Draft step and Settings use them. |
| `apiFetch` | `R/lib/api.ts` | `transcribe-client.ts:55` and `report-error.ts:17` use it. |
| `Markdown` component, `react-markdown` | `R/components/markdown.tsx` | Meeting detail uses it. |
| `formatNumber` | `R/lib/format.ts:25` | `history.tsx` uses it. |
| `llm_task_assignments` parsing, preset code | `V/llm-task-profiles.ts`, `R/pages/models/preset-ops.ts` | They are task-id generic. |
| `trustedOriginMiddleware` mutation and WebSocket checks | `S/lib/trusted-origin.ts:33-49` | All other routes use them. |
| `TIMEOUT_PREFIXES` and `history` sweep | `S/index.ts`, `S/lib/history-store.ts` | Only the 2 Remix lines change. |

### 12.2 Code that becomes dead and goes with the WP (STATIC)

- Files: `E/main/mac-ax.ts`, `R/components/agents/**`, `R/lib/ease.ts`, `R/components/openstyle-mark.tsx`, `R/hooks/use-latched-value.ts` (all in section 15.1).
- Functions: `getFrontmostContext` (`active-window.ts:473`), `copySelectionFromFocusedApp` and its helpers (`paste.ts:536-677`), `pasteClipboardIntoFocusedApp` (`paste.ts:739`), `releaseLeaseOnResponseBodyEnd` (`lane.ts:535`), `Deferred`/`deferred` (`pill/constants.ts:217-228`), `KbdSep` (`help.tsx:64`), `state.lastPillHideAt`.
- Knip rules: the repo gate checks unused files and dependencies (`knip.jsonc:3-9`). A dead file makes `pnpm run knip` fail. The `exports` rule is off, so dead functions do not fail it.

### 12.3 Couplings across work packages

1. Migration numbers: `S/lib/schema.ts:14` has `SCHEMA_VERSION = 39`. Owner decision Q12 adds migration 40 (`summary_json`). The platform layer adds `llm_runs`, `llm_calls`. A Remix cleanup migration needs a number too. See decision D1.
2. `V/llm-task-profiles.ts`: the Remix WP edits `LLM_TASK_IDS`. Spec WP3 adds `LLM_MEETING_DENYLIST_KEYS` to the same file (`specs/meeting-enhance-agentic.md` (5.5.3)). The edits are in different regions. Merge order matters only for rebase.
3. `S/lib/llm/task-profiles.ts` and `S/lib/llm/lane.ts`: WP3 and the platform layer edit them too.
4. `apps/electron/package.json` and `pnpm-lock.yaml`: WP1 bumps `ai` to v7. The Remix WP removes the electron `ai` and `@ai-sdk/react` lines. If WP1 merges first, it must also bump the electron `ai` and `@ai-sdk/react` lines, and the lock file keeps two `ai` versions. Land the Remix removal first to avoid that work.
5. Locale files (8) and `locales.test.ts`: every UI WP (inspector, onboarding changes) adds keys here. Expect rebase conflicts. Land the Remix removal early.
6. `AGENTS.md`: all WPs edit it.
7. `R/pages/models/*` and `tests/preset-crud-evidence.test.ts`: the inspector or Models changes may touch the same Models page tests.

## 13. Data left behind and migration

- Tables `remix_threads`, `remix_messages`, `remix_runs` (created at `S/lib/schema.ts:589-619`, migration 20). `remix_runs.before_text` and `after_text` hold text the user selected in other apps (`:612-613`). After the removal nothing reads, trims or deletes these rows, because `purgeExpiredRemixData` goes away. Old text stays on disk.
- Settings rows `remix_hotkey`, `remix_bar_enabled`, and legacy `remix_enabled` (`schema.ts:626-635`) stay as dead rows.
- Option A: add a new migration with `DROP TABLE` for the 3 tables and `DELETE FROM settings WHERE key IN ('remix_hotkey','remix_bar_enabled','remix_enabled')`. Keep migration 20 as written (history). Then edit `v20-merge-reconciliation.test.ts:107-109`, `:141`.
- Option B: leave the data. This keeps users' old text on disk with no owner. I do not recommend B.
- Rollback note: an older build opens a newer database file, because `S/lib/schema.ts:168` returns early when the stored version is higher. That older build has the Remix routes. They then fail with "no such table". Ask the owner (D1).

## 14. Effect on the spec and the other WPs

### 14.1 `ai` SDK sites (spec acceptance grep, STATIC)

The spec grep (`specs/meeting-enhance-agentic.md` (WP1 acceptance 1, 11.5)) finds 18 paths now. After the removal it finds 15. The three that go: `R/components/remix-chat.tsx`, `S/lib/remix-agent.ts`, `S/lib/remix-transform.ts`. The 15 that stay: `apps/server/scripts/benchmark-post-process.ts`, `apps/server/scripts/tone-benchmark.ts`, `S/lib/groq-http.ts`, `S/lib/llm/registry.ts`, `S/lib/providers.ts`, `S/lib/streaming/providers/{elevenlabs,groq,openai}.ts`, `S/lib/streaming/utils.ts`, `apps/server/tests/{llm-task-profiles,openai-cloud-provider,server-provider,trace}.test.ts`, `packages/stt/src/{post-process,transcribe}.ts`.

### 14.2 WP1 shrink (owner note)

- No `remix-transform`, `remix-agent`, `remix-chat` or `@ai-sdk/react` work remains in WP1.
- The spec already carries these edits (11.5 WP1 card, 6.4). The old spec line numbers in the first draft of this inventory are dropped, because they point to an earlier draft.
- The spec says in 11.8 row 8 that WP1 and WP2 ship in one release with everything else.

### 14.3 Owner of the spec edits

The spec PR owns all `specs/meeting-enhance-agentic.md` edits. The WP-R PR must not touch that file or this file. That avoids a second writer on a 4000-line spec.

## 15. Proposed file-ownership list for one WP ("WP-R: Remove Remix")

Order: land WP-R before WP1. WP-R owns every file below. No other WP may edit these paths, except the shared regions in 15.3.

### 15.1 Delete (42 files, exclusive to WP-R)

Server (13):
- `apps/server/src/lib/remix-agent.ts`
- `apps/server/src/lib/remix-store.ts`
- `apps/server/src/lib/remix-transform.ts`
- `apps/server/src/lib/editor/remix-prompts.ts`
- `apps/server/src/routes/remix/agent.ts`
- `apps/server/src/routes/remix/error-response.ts`
- `apps/server/src/routes/remix/index.ts`
- `apps/server/src/routes/remix/runs.ts`
- `apps/server/src/routes/remix/thread.ts`
- `apps/server/src/routes/remix/transform.ts`
- `apps/server/tests/remix-model-preflight.test.ts`
- `apps/server/tests/remix-prompts.test.ts`
- `apps/server/tests/remix-store.test.ts`

Package (1):
- `packages/validations/src/remix.ts`

Electron main, shared, native (8):
- `apps/electron/src/main/remix/bar-window.ts`
- `apps/electron/src/main/remix/helpers.ts`
- `apps/electron/src/main/remix/hotkey.ts`
- `apps/electron/src/main/remix/ipc.ts`
- `apps/electron/src/main/remix-target.ts`
- `apps/electron/src/main/mac-ax.ts`
- `apps/electron/src/shared/remix.ts`
- `apps/electron/native/macos-ax.swift`

Renderer (18):
- `apps/electron/src/renderer/bar.html`
- `apps/electron/src/renderer/src/components/remix-bar.tsx`
- `apps/electron/src/renderer/src/components/remix-chat.tsx`
- `apps/electron/src/renderer/src/components/remix-chat-styles.ts`
- `apps/electron/src/renderer/src/components/remix-chat-surface.ts`
- `apps/electron/src/renderer/src/components/openstyle-mark.tsx`
- `apps/electron/src/renderer/src/components/agents/README.md`
- `apps/electron/src/renderer/src/components/agents/agent-disclosure.tsx`
- `apps/electron/src/renderer/src/components/agents/message-scroller.tsx`
- `apps/electron/src/renderer/src/components/agents/loading-states/thinking-shimmer.tsx`
- `apps/electron/src/renderer/src/components/agents/agent-activity/index.tsx`
- `apps/electron/src/renderer/src/components/agents/agent-activity/activity-row.tsx`
- `apps/electron/src/renderer/src/components/agents/agent-activity/types.ts`
- `apps/electron/src/renderer/src/hooks/use-latched-value.ts`
- `apps/electron/src/renderer/src/lib/ease.ts`
- `apps/electron/src/renderer/src/pages/remix.tsx`
- `apps/electron/src/renderer/src/pages/onboarding/remix-step.tsx`
- `apps/electron/src/renderer/src/pages/pill/use-remix-session.ts`

Electron tests (2):
- `apps/electron/tests/remix-mini-strip.test.ts`
- `apps/electron/tests/remix-target.test.ts`

### 15.2 Edit (exclusive to WP-R unless listed in 15.3)

Shared-region files (counted in the 94, edited by region, see 15.3): `packages/validations/src/llm-task-profiles.ts`, `apps/server/src/lib/llm/task-profiles.ts`, `apps/server/src/lib/llm/lane.ts`.

Server and packages (10):
- `apps/server/src/index.ts`
- `apps/server/src/routes/index.ts`
- `apps/server/src/routes/settings.ts`
- `apps/server/src/lib/history-store.ts`
- `apps/server/src/lib/trusted-origin.ts`
- `apps/server/src/lib/trace.ts`
- `apps/server/src/lib/llm/registry.ts` (comment only)
- `packages/validations/src/index.ts`
- `packages/validations/src/settings-keys.ts`
- `packages/utils/src/logger.ts` (comment only)

Electron main and preload (16):
- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/main-state.ts`
- `apps/electron/src/main/quit.ts`
- `apps/electron/src/main/resets.ts`
- `apps/electron/src/main/renderer-urls.ts`
- `apps/electron/src/main/hotkey-utils.ts`
- `apps/electron/src/main/active-window.ts`
- `apps/electron/src/main/paste.ts`
- `apps/electron/src/main/ipc/core-ipc.ts`
- `apps/electron/src/main/windows/pill-window.ts`
- `apps/electron/src/main/windows/settings-window.ts`
- `apps/electron/src/main/hotkeys/dictation.ts`
- `apps/electron/src/main/hotkeys/stuck-release.ts`
- `apps/electron/src/main/hotkeys/native-retry.ts` (comment only)
- `apps/electron/src/main/hotkeys/native-retry.test.ts`
- `apps/electron/src/preload/index.ts`

Renderer (22):
- `apps/electron/src/renderer/src/dashboard.tsx`
- `apps/electron/src/renderer/src/onboarding.tsx`
- `apps/electron/src/renderer/src/shell.tsx`
- `apps/electron/src/renderer/src/pages/app.tsx`
- `apps/electron/src/renderer/src/pages/settings.tsx`
- `apps/electron/src/renderer/src/pages/help.tsx`
- `apps/electron/src/renderer/src/pages/pill-styles.ts`
- `apps/electron/src/renderer/src/pages/pill/pill-view.tsx`
- `apps/electron/src/renderer/src/pages/pill/pill-shared.ts`
- `apps/electron/src/renderer/src/pages/pill/constants.ts`
- `apps/electron/src/renderer/src/pages/pill/use-pill-dismiss.ts`
- `apps/electron/src/renderer/src/pages/pill/use-waveform.ts` (comment only)
- `apps/electron/src/renderer/src/pages/onboarding/draft-step.tsx`
- `apps/electron/src/renderer/src/pages/onboarding/shared.tsx`
- `apps/electron/src/renderer/src/pages/models/preset-ops.test.ts`
- `apps/electron/src/renderer/src/components/hotkey-demo.tsx`
- `apps/electron/src/renderer/src/components/hotkey-recorder-control.tsx`
- `apps/electron/src/renderer/src/components/onboarding/email-draft.tsx`
- `apps/electron/src/renderer/src/components/onboarding/coach-strip.tsx` (comment only)
- `apps/electron/src/renderer/src/hooks/use-hotkey-recorder.ts`
- `apps/electron/src/renderer/src/lib/query.ts`
- `apps/electron/src/renderer/src/lib/streamer.ts` (comment, or D8)

Tests (11, plus `apps/server/tests/v20-merge-reconciliation.test.ts` if D1 adds a drop migration):
- `apps/server/tests/llm-task-profiles.test.ts`
- `apps/server/tests/meeting-llm-timeouts.test.ts`
- `apps/server/tests/llm-parameter-presets.test.ts`
- `apps/server/tests/settings-validators.test.ts`
- `apps/server/tests/migration-servers.test.ts`
- `apps/server/tests/trace.test.ts` (comment only)
- `apps/server/tests/sync-outbox-migration.test.ts` (comment only)
- `apps/electron/tests/app.test.ts`
- `apps/electron/tests/helpers/e2e-app.ts`
- `apps/electron/tests/language-hotkeys.test.ts`
- `apps/electron/tests/preset-crud-evidence.test.ts`

Config, native, scripts (8):
- `apps/electron/electron.vite.config.ts`
- `apps/electron/package.json`
- `apps/electron/scripts/compile-native.js`
- `apps/electron/components.json` (optional)
- `apps/electron/native/macos-fast-paste.swift` (comment only)
- `knip.jsonc`
- `pnpm-lock.yaml`
- `scripts/site-captures/capture.mjs`

Locales (9 files, shared with other WPs, see 15.3):
- `apps/electron/src/renderer/src/locales/{template,en,de,es,fr,it,ja,pt}.json` and `apps/electron/src/renderer/src/locales/locales.test.ts`

Docs, site, skills (15):
- `AGENTS.md` (7 places listed in section 11)
- `README.md`
- `.lore.md` (after D9)
- `site/index.html`
- `specs/remix.md` (mark retired)
- `specs/llm-task-profiles.md` (task tables: remove the `remix` row, change "four" to "three")
- `.claude/skills/live-testing/SKILL.md`
- `.claude/skills/site-captures/SKILL.md`
- Retirement note at the top of 7 specs: `specs/dictation-language-hotkeys.md`, `specs/meeting-llm-queue.md`, `specs/under-the-hood.md`, `specs/design-system.md`, `specs/roadmap-2026-08.md`, `specs/model-picker-groups.md`, `specs/meeting-diarization.md`

### 15.3 Shared regions (WP-R edits only the named region)

| File | WP-R region | Other WP | Rule |
|---|---|---|---|
| `packages/validations/src/llm-task-profiles.ts` | `LLM_TASK_IDS` (`:9-14`) and doc `:3-8` | WP3 (denylist keys) | Different regions. Merge WP-R first. |
| `apps/server/src/lib/llm/task-profiles.ts` | `remix:` profile `:89-95`, comments `:47`, `:144-146` | WP3, platform layer | Same rule. |
| `apps/server/src/lib/llm/lane.ts` | `releaseLeaseOnResponseBodyEnd` `:521-575` only | platform layer | Same rule. |
| `apps/server/src/lib/schema.ts` | none, unless D1 picks option A | Q12 migration 40, `llm_runs` | Assign migration numbers first (D1). |
| `apps/electron/package.json`, `pnpm-lock.yaml` | 4 dependencies | WP1 | Land WP-R first. |
| 8 locale files and `locales.test.ts` | 139 keys per file and the listed test entries | every UI WP | Land WP-R early. Resolve conflicts by keeping the other WP's new keys. |
| `AGENTS.md` | the 7 Remix places | all WPs | Edit only those lines. |

### 15.4 Checks the WP must run (UNVERIFIED now, I ran none)

Run each and quote the output.
1. `grep -rIl -i remix apps packages scripts site .claude --exclude-dir=node_modules` must list only: `specs` notes, `.lore.md` (if D9 keeps history), and the comment-only files named in 15.2. Target for code and config: 0 files.
2. `pnpm turbo build --filter=@openstyle/server && pnpm --filter @openstyle/electron typecheck` must pass.
3. `pnpm test` must pass (it runs `preload-channels.test.ts`, `locales.test.ts`, server tests).
4. `pnpm run knip` must pass (no unused file or dependency).
5. `grep -E '^  ai@[0-9]' pnpm-lock.yaml` must show one version (6.0.191).
6. Live proof (use the `live-testing` skill): start the isolated app, run onboarding to the end, open Models and count 3 task rows, press the old Remix hotkey and see no pill, confirm no bar window, confirm dictation still pastes. A 200 from the server is not enough for these screen items.
7. Bundle size: record `du -sk apps/electron/out` before and after (owner Q6 asks for measured size in each PR). Expect a drop: `motion`, `remark-gfm`, `@ai-sdk/react` and the chat chunk leave the renderer bundle.

## 16. Decisions (closed 2026-10-17)

The owner asked the coordinator to decide with the owner's viewpoint. Each row is a decision, not a question. The WP-R card (11.5 of the spec) repeats D1 to D6.

| Id | Decision | Reason |
|---|---|---|
| D1 | Decided 2026-10-17 (owner viewpoint): migration 40 of WP2 drops the 3 `remix_*` tables and deletes the 3 settings rows (`remix_hotkey`, `remix_bar_enabled`, `remix_enabled`). The WP-R PR adds no migration. Migration 20 stays as written. | The release has one migration. The user text in `remix_runs` must not stay on disk with no owner. |
| D2 | Decided 2026-10-17 (owner viewpoint): delete `components/agents/` (7 files). | It is dead code, and knip fails on unused files. Git keeps the files. The owner redoes Remix later on the new platform. |
| D3 | Decided 2026-10-17 (owner viewpoint): the onboarding draft step takes the label `onboarding.tutorial.finish` when Meeting Mode is off, and "Continue" when the Enhance step follows. | It keeps the tutorial finish path working with one step less. |
| D4 | Decided 2026-10-17 (owner viewpoint): remove the `PROTECTED_READ_PREFIXES` mechanism in `S/lib/trusted-origin.ts`. | No route needs it. A later change adds it back. |
| D5 | Decided 2026-10-17 (owner viewpoint): delete `releaseLeaseOnResponseBodyEnd`. | It has no caller and no test. |
| D6 | Decided 2026-10-17 (owner viewpoint): delete `macos-ax.swift`, `mac-ax.ts`, the dead copy and paste helpers in `paste.ts`, and `getFrontmostContext`. | A later Remix will redesign document access on the new platform. |
| D7 | Decided 2026-10-17 (owner viewpoint): keep `setFocusable(false)` at `pill-window.ts:562-564`. | It costs nothing and is a safe reset. |
| D8 | Decided 2026-10-17 (owner viewpoint): keep the optional `StreamerCallbacks.onPartial` and fix its comment. | The server still sends partial frames. |
| D9 | Decided 2026-10-17 (owner viewpoint): no WP edits `.lore.md`. The lore tool owns it (`AGENTS.md:1-4`). The Remix entries stay until the owner says how to edit it. | The file is tool-maintained. |
