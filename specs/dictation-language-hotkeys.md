# Dictation Language Hotkeys — Implementation Spec

Implementation spec for optional, per-language dictation hotkeys, grounded in
the codebase as of `main` @ 2026-08-27. Companion reading:
[`language-setting-audit.md`](language-setting-audit.md) (the STT-provider
language-parameter survey this spec's server-side override sits on top of)
and [`meeting-diarization.md`](meeting-diarization.md) (house style this spec
follows: opt-in surface, grounded file:line citations, explicit failure
matrix).

---

## 1. Goal

Today, dictation has exactly one global hotkey (`hotkey` / `hotkey_mode`
settings, `apps/electron/src/main/index.ts:381-390`) that starts a recording
regardless of which language the user is about to speak. The language sent
to STT is resolved once per request, server-side, from the `languages`
setting (`getLanguagesSetting()`, `apps/server/src/lib/language.ts:44-57`):
when the list has one or more entries the **first** one is pinned
(`primaryLanguage = effectiveLanguages[0]`, `apps/server/src/routes/
transcribe.ts:113-114`); only an explicitly empty list is true auto-detect.
A user who dictates in two languages already lives with this pin — every
dictation is transcribed as whichever language is `languages[0]`, auto-detect
only kicks in once they clear the list entirely, and clearing it is worst
exactly where it's needed most: short utterances (dossier:
`specs/language-setting-audit.md`'s survey of provider auto-detect quality).

This feature adds **optional, per-language hotkeys**: for each language the
user has configured, a settings row lets them bind a second hotkey that
starts the identical dictation flow but pins the request to that one
language — skipping auto-detect and `languages[0]` guesswork alike, because
the user's key press *is* the language signal. The pin also fixes the LLM
cleanup prompt's language constraint (`buildLanguageBlock`,
`apps/server/src/lib/editor/prompts.ts:39-62`) to that single language,
avoiding the translate-drift bug class documented against `languages[0]` in
meeting contexts (2026-08-27) — the same shaped bug is latent here whenever
the spoken language isn't the pinned first entry.

The default hotkey's behavior is **unchanged**: press it, get today's
`languages[0]`-pinned-or-auto-detect resolution, exactly as now. Per-language
hotkeys are strictly additive — unset by default, and invisible in the
settings UI until the user has configured more than one language.

### Non-goals

- **Per-language vocabulary.** `resolveAsrVocabularyBias` (`apps/server/src/
  lib/vocabulary-bias.ts`, referenced `transcribe.ts:135`) is untouched —
  bias stays keyed off the configured model/provider, not the pinned
  language.
- **Per-language tone.** Cleanup tone settings (`cleanup_*`, `post-
  process.ts:70-115`) are global; a language hotkey changes only the
  language constraint block, not tone routing.
- **Meeting mode.** Meeting Mode resolves its own language independently
  (`apps/server/src/lib/meetings/language.ts`, `meeting-mode.md`) and has its
  own hotkey (record start/stop, not the dictation hotkey at all). Out of
  scope; no shared code path with this feature beyond `getLanguagesSetting()`
  itself.
- **Non-macOS parity beyond what already exists.** Per-language hotkeys reuse
  `NativeKeyListener` exactly as the remix hotkey does today — whatever
  platform support that already has (macOS native listener; Windows/Linux
  native listeners; Linux `globalShortcut` toggle fallback for the *default*
  hotkey only, `registerGlobalShortcutToggle`, `index.ts:4488-4521`) is what
  language hotkeys get too, no new platform work.

---

## 2. Architecture

```
Settings UI (per-language row, §7)
        │ record accelerator (useHotkeyRecorder, existing hook)
        ▼
settings PUT "language_hotkeys" = JSON {"pt":"Alt+P","en":"Alt+E"}  (electron-only
        │                                                            setting, like
        │ IPC: language-hotkeys:update / reload                     "hotkey" itself)
        ▼
apps/electron/src/main/index.ts
  registerLanguageHotkeys(map) — one NativeKeyListener per entry
  (mirrors registerHotkey / registerRemixHotkey, §5)
        │ onKeyDown(lang) / onKeyUp(lang)
        ▼
  handleDictationHotkeyDown(lang?) / handleDictationHotkeyUp(lang?)
  — same hotkeyPressed state machine the default hotkey already drives;
    lang is just tagged onto this press (§5)
        │ IPC "hotkey:down" { language?: string }
        ▼
Renderer (apps/electron/src/renderer/src/pages/app.tsx)
  onHotkeyDown(payload) → pinnedLanguageRef.current = payload?.language ?? null
        │ startRecording() captures the pinned language into a local, once,
        │ before any audio is captured (§6) — never re-read from the ref later
        ▼
  ┌─────────────────────────────┬─────────────────────────────────────────┐
  │ REST path (batch providers, │ Streaming session-transport path        │
  │ REST fallback)              │ (session-transport-capable providers)   │
  │ header "x-dictation-        │ WS "start" message gains a `language`   │
  │ language: pt" on POST       │ field (§4b) — Streamer.startCapture()   │
  │ /api/transcribe (§4a)       │ carries it in                           │
  └──────────────┬──────────────┴──────────────────┬────────────────────┘
                 ▼                                  ▼
  apps/server/src/routes/transcribe.ts    apps/server/src/routes/stream.ts
  override = header value                 languageOverride set on "start"
  effectiveLanguages = valid override      resolveStreamConfig() folds it into
    ? [override] : getLanguagesSetting()     both `languages` and the upstream
  primaryLanguage = effectiveLanguages[0]    `key` — a changed key already
    → STT provider                           forces the existing warm-session
  postProcess({ languages:                   rebuild (stream.ts:501-535)
    effectiveLanguages, … })                postProcess({ languages:
    → cleanup LLM prompt                      config.languages }) picks up
                 │                            the override for free
                 ▼                                  │
  buildLanguageBlock([override]) → single-language constraint, unchanged
  code path from today's single-configured-language case (editor/prompts.ts)
```

Key design point: both server-side changes are a **value substitution**, not
new branching. `effectiveLanguages` already exists in `transcribe.ts` today
(currently just an alias for `languages`, line 113); `resolveStreamConfig()`
already computes a `languages` value and a comparison `key` from it
(`stream.ts:81`, `93-99`) that the "start" handler already uses to decide
whether to rebuild the upstream session (`stream.ts:501-535`). This feature
makes each conditionally substitute `[override]` in place of the full list.
Every downstream consumer — `primaryLanguage`, `postProcess`,
`buildLanguageBlock`'s 0/1/many branches — is unchanged code, exercised with
a different input. This is deliberate: it's the same reason
`meeting-diarization.md` §6 chose an additive field over widening a type —
reuse the existing single-language code path exactly, don't invent a second
one.

---

## 3. Hotkey infrastructure (today) — what per-language hotkeys reuse

`NativeKeyListener` (`apps/electron/src/main/key-listener.ts:130-550`) wraps
one spawned native binary process per instance; the hotkey it matches is
baked into the spawn args (`args.push(formatHotkeyForBinary(this.options
.hotkey))`, `key-listener.ts:177`), not reconfigurable after `start()`. The
app already runs **two** independent instances side by side — the module-
level `keyListener` (default dictation hotkey) and `remixKeyListener` (remix
hotkey), each with its own `NativeKeyListener`, its own press-state
(`hotkeyPressed` / `remixPressed`), and its own registration function
(`registerHotkey` / `registerRemixHotkey`, `index.ts:4531` / `4325`). Adding a
third, fourth, fifth listener for per-language hotkeys is the same pattern
scaled to a **map** instead of a single instance — no change to
`NativeKeyListener` itself.

Settings storage is flat key→string (`SETTINGS_KEYS`, `apps/electron/src/
shared/settings-keys.ts`); the existing `hotkey` / `hotkey_mode` /
`remix_hotkey` keys are Electron-only concerns — read via `getServerSettings
()` (`index.ts:1682-1693`, an HTTP call to the local server's generic `/api/
settings` KV store) and never consulted server-side. Per-language hotkeys
follow the identical pattern: one new flat key, JSON-encoded (matching how
`languages` itself is already stored as a JSON array under one flat key,
`getLanguagesSetting()`, `language.ts:44-57`), read only by the Electron main
process.

Conflict precedent already exists: `registerRemixHotkey` checks the remix
accelerator against `currentHotkeyAccel` and **disables remix** (not the
default hotkey) on a clash, logging a warning (`index.ts:4340-4346`,
`"Remix hotkey \"${accel}\" is already the dictation hotkey; remix
disabled."`). Per-language hotkey conflicts follow the same shape (§8).

The default hotkey's press handling — `handleNativeHotkeyDown` /
`handleNativeHotkeyUp` (`index.ts:4406-4433`) — is the state machine every
language hotkey needs to drive too, honoring both activation modes exactly
as today:

```ts
// today
function handleNativeHotkeyDown(): void {
  if (hotkeyActivationMode === "toggle") {
    if (!hotkeyPressed) { hotkeyPressed = true; sendHotkeyDown(); }
    else { hotkeyPressed = false; sendHotkeyUp(); }
    return;
  }
  if (!hotkeyPressed) {
    hotkeyPressed = true;
    armHotkeyStuckWatchdog();
    sendHotkeyDown();
  }
}
```

`hotkeyActivationMode` (`"hold" | "toggle"`) is a single global setting
(`SETTINGS_KEYS.hotkeyMode`) applied uniformly to whichever hotkey is
pressed — §5 extends this exact function to take an optional language rather
than forking a parallel state machine per language.

---

## 4. Runtime: transcribe route + cleanup prompt

### 4a. REST path (`POST /api/transcribe`)

### Client → server: the override header

New request header on `POST /api/transcribe`, alongside the existing
`x-audio-duration-ms` / `x-app-context` / `x-skip-post-process` headers sent
from the same two call sites in `apps/electron/src/renderer/src/pages/
app.tsx` (`restFallbackTranscribe`, lines 744-779; the main commit path,
lines 1619-1643):

```
x-dictation-language: pt
```

Set only when the dictation was started by a language hotkey
(`pinnedLanguageRef.current` non-null at request-build time, §6); absent for
every default-hotkey dictation, identical to today's request shape.

### Server: `apps/server/src/routes/transcribe.ts:108-145`

```ts
// today
let rawText: string;
const languages = getLanguagesSetting();

const voiceProvider = defaults.voice.provider;
const voiceModel = defaults.voice.model_id;
const effectiveLanguages = languages;
const primaryLanguage = effectiveLanguages[0];
```

becomes:

```ts
const languages = getLanguagesSetting();

const voiceProvider = defaults.voice.provider;
const voiceModel = defaults.voice.model_id;

// A language-hotkey dictation pins the request to one language, overriding
// languages[0] and auto-detect alike. Only honored when the override is one
// of the user's currently-configured languages — defense in depth against a
// stale client (settings UI unsets a language's hotkey on removal, §8, but a
// request already in flight, or a client that hasn't reloaded its config
// yet, could still send a code no longer in `languages`).
const languageOverride = c.req
  .header("x-dictation-language")
  ?.trim()
  .toLowerCase();
// `languages` is already normalized lowercase (normalizeLanguageList,
// cloud-config.ts:28-42); match case here rather than assuming the header
// arrives pre-normalized.
const effectiveLanguages =
  languageOverride && languages.includes(languageOverride)
    ? [languageOverride]
    : languages;
const primaryLanguage = effectiveLanguages[0];
```

`primaryLanguage` still flows into `provider.transcribe({ ...
(primaryLanguage ? { language: primaryLanguage } : {}) })` unchanged
(`transcribe.ts:142`) — with the override applied, `effectiveLanguages` is a
one-element array, so `primaryLanguage` is exactly the pinned code. Add one
debug line so the override is visible per the manual test plan (§10):

```ts
log.debug(
  `languages=${JSON.stringify(languages)} override=${languageOverride ?? "none"} effective=${JSON.stringify(effectiveLanguages)}`,
);
```

placed alongside the existing `log.debug(\`bias=...\`)` at `transcribe.ts:136`.

An override that fails the membership check (removed language, corrupted
header, hand-crafted request) is **silently ignored** — `effectiveLanguages`
falls back to `languages`, i.e. exactly today's behavior. No error response;
this mirrors the fail-closed posture `meeting-diarization.md` uses throughout
(§10 there) rather than rejecting the dictation over a stale hint.

### Cleanup LLM prompt: `transcribe.ts:198-205`

Unchanged code, different input:

```ts
const pp = await postProcess(rawText, appContext, {
  languages: effectiveLanguages,
  source: "batch",
});
```

already passes `effectiveLanguages` through to `postProcess` →
`buildRewritePrompt` (`post-process.ts:213-214`) → `buildLanguageBlock`
(`apps/server/src/lib/editor/prompts.ts:39-62`), whose single-language branch
(`codes.length === 1`, line 56) already emits `"Language constraint: the
transcript language is ${descriptor}. ... Do not translate to English or
another language."` — this **is** the "the text is `<language>`" hint the
feature asks for; it already exists for the case of exactly one configured
language, and pinning `effectiveLanguages` to `[override]` routes a
multi-language user into that same branch for this one dictation. No new
prompt code.

**Caveat**: a queued subsequent dictation (`isSubsequent`, `transcribe.ts`'s
caller sets `x-skip-post-process: true` when `queueRef.current.length > 0 ||
drainingRef.current`, `app.tsx:754`/`1626`) skips `postProcess` entirely
(`transcribe.ts:176-196` returns early on that header) — the cleanup
language hint never runs for that request regardless of pinning. STT
(`primaryLanguage`) is still pinned correctly; only the cleanup-prompt half
of §4a is inert for a queued dictation, same as it already is for tone/bias
today.

### 4b. Streaming session-transport path (`WS /api/stream`)

Covers dictations that run over `Streamer`'s session-transport connection
(`recordingSessionUsesTransportRef.current`, `app.tsx:1515` —
session-transport-capable providers only; batch providers always use §4a).
The mechanism this reuses already exists: `apps/server/src/routes/
stream.ts`'s `"start"` message handler re-resolves config on **every**
recording (not just at connection-open) and rebuilds the upstream session
whenever the resolved config's `key` differs from the warm session's
(`stream.ts:499-535`, `sameConfig = upstreamConfigKey !== null && nextConfig
?.key === upstreamConfigKey`). A language override just needs to become part
of what `"start"` resolves.

**Client** (`apps/electron/src/renderer/src/lib/streamer.ts`): `startCapture`
gains an optional language, stored for the next `"start"` message —
symmetric with `currentContext`/`setContext()` but scoped to one recording
rather than persisted:

```ts
async startCapture(stream: MediaStream, language?: string | null): Promise<void> {
  this.pendingLanguage = language ?? null;
  // ...unchanged
}

private startPendingSession(): void {
  // ...unchanged guard
  this.ws.send(
    JSON.stringify({
      type: "start",
      context: this.currentContext,
      language: this.pendingLanguage,
    }),
  );
  this.sessionStartPending = false;
}
```

Call site (`app.tsx:1445`): `await getStreamer().startCapture(stream,
dictationLanguage)`, where `dictationLanguage` is the same locally-captured
value §6 threads through the REST path — captured once, at the top of
`startRecording`, never re-read from a ref later.

**Server** (`apps/server/src/routes/stream.ts`): one new closure variable
alongside `appContext` (`stream.ts:48`):

```ts
let languageOverride: string | null = null;
```

`resolveStreamConfig()` (`stream.ts:71-101`) applies the same
membership-guarded substitution as §4a, inline where `languages` is built:

```ts
const rawLanguages = getLanguagesSetting();
const languages =
  languageOverride && rawLanguages.includes(languageOverride)
    ? [languageOverride]
    : rawLanguages;
```

(`languageOverride` is normalized — trimmed, lowercased — at the point it's
set from `msg.language` below, same reasoning as §4a's header handling.)

— unchanged after that: `languages` still feeds both the upstream session
config and the comparison `key` (`stream.ts:93-99`), so a pinned-vs-
unpinned (or PT-vs-EN) language change between two recordings on the same
warm connection changes `key`, `sameConfig` evaluates `false`, and the
existing rebuild branch (`stream.ts:530-535`) runs — no new session-lifecycle
logic. `msg.language` is read in the `"start"` case, **before** `resolveStreamConfig()`
is called there (`stream.ts:487-501`):

```ts
case "start": {
  // ...unchanged
  languageOverride =
    typeof msg.language === "string" && msg.language.trim()
      ? msg.language.trim().toLowerCase()
      : null;
  const nextConfig = resolveStreamConfig();
  // ...unchanged from here
}
```

(`msg`'s type annotation, `stream.ts:467-471`, gains `language?: string`.)

Cleanup follows for free: `onFinal`'s `postProcess({ languages: config
.languages, ... })` (`stream.ts:288-289`) reads `config.languages` from the
`resolveStreamConfig()` result captured in `connectUpstream`'s closure at
rebuild time (`stream.ts:218-220`), which is the overridden list whenever a
rebuild just happened for that reason.

**Why this isn't a bigger lift**: the warm-session-reuse-vs-rebuild decision
this relies on already exists for provider/model/bias changes — pinning a
language is just one more input to a `key` comparison that was already being
made on every recording. No new WebSocket message type, no new client-server
handshake, no change to `onFinal`/`onPartial`/history-saving.

---

## 5. Main-process registration (`apps/electron/src/main/index.ts`)

New module-level state, alongside the existing `keyListener` /
`remixKeyListener` (`index.ts:376-390`):

```ts
const languageKeyListeners = new Map<string, NativeKeyListener>(); // lang code -> listener
const languageHotkeyAccels = new Map<string, string>();            // lang code -> normalized accel currently registered
let activeDictationLanguage: string | null = null; // which hotkey (if any) started the in-progress session
```

### Shared press state machine

`handleNativeHotkeyDown` / `handleNativeHotkeyUp` (§3) generalize to take an
optional language, and become the target for every dictation-starting
listener — default hotkey included:

```ts
function handleDictationHotkeyDown(language?: string): void {
  if (hotkeyActivationMode === "toggle") {
    if (!hotkeyPressed) {
      hotkeyPressed = true;
      activeDictationLanguage = language ?? null;
      sendHotkeyDown(activeDictationLanguage);
    } else {
      hotkeyPressed = false;
      activeDictationLanguage = null;
      sendHotkeyUp();
    }
    return;
  }
  if (!hotkeyPressed) {
    hotkeyPressed = true;
    activeDictationLanguage = language ?? null;
    armHotkeyStuckWatchdog();
    sendHotkeyDown(activeDictationLanguage);
  }
  // hotkeyPressed already true: a second hotkey (default or another
  // language) pressed mid-recording is a no-op in hold mode, same as today's
  // "press the same hotkey twice" case — only one dictation session at a
  // time, matching the single hotkeyPressed flag's existing semantics.
}

function handleDictationHotkeyUp(language?: string): void {
  if (hotkeyActivationMode === "toggle") return;
  // Only the hotkey that started the session ends it — a stray key-up from a
  // *different* language hotkey (e.g. the user's finger slipped) is ignored
  // rather than ending someone else's hold.
  if (hotkeyPressed && (language ?? null) === activeDictationLanguage) {
    hotkeyPressed = false;
    activeDictationLanguage = null;
    clearHotkeyStuckWatchdog();
    sendHotkeyUp();
  }
}
```

`activeDictationLanguage = null` also needs adding to the two other places
`hotkeyPressed` is force-reset outside this pair of functions, so a stale
language can't survive past the session that set it: the stuck-watchdog
timeout (`armHotkeyStuckWatchdog`'s callback, `index.ts:4393-4404`) and
`registerHotkey`'s teardown-before-rebuild (`index.ts:4538`, `hotkeyPressed =
false;`) — both already reset `hotkeyPressed` for the same reason.

The default hotkey's `NativeKeyListener` construction (`index.ts:4557-4586`)
changes only its callbacks: `onKeyDown: () => handleDictationHotkeyDown(),
onKeyUp: () => handleDictationHotkeyUp()` — behavior-identical to today for
every default-hotkey press (`language` is `undefined`, so
`activeDictationLanguage` is `null`, matching the toggle/hold logic exactly
as it runs today).

`sendHotkeyDown` (`index.ts:4145-4164`) gains a parameter, threaded into the
existing IPC send:

```ts
function sendHotkeyDown(language?: string | null): void {
  const missingPermission = getMissingDictationPermission();
  if (missingPermission) { /* unchanged */ }
  showPill();
  const payload = language ? { language } : undefined;
  if (pillReadyPromise) {
    void pillReadyPromise.then(() => {
      mainWindow?.webContents.send("hotkey:down", payload);
      settingsWindow?.webContents.send("hotkey:down", payload);
    });
    return;
  }
  mainWindow?.webContents.send("hotkey:down", payload);
  settingsWindow?.webContents.send("hotkey:down", payload);
}
```

`sendHotkeyUp` is unchanged — key-up never carries a language; the renderer
already knows which language a session was pinned to from the `hotkey:down`
payload it received (§6).

### Registration

```ts
async function registerLanguageHotkeys(
  map: Record<string, string> | undefined,
): Promise<void> {
  const desired = map ?? {};

  // Tear down listeners for languages no longer present or whose accelerator
  // changed — same "stop, then rebuild" shape as registerHotkey (index.ts:
  // 4531-4537), scoped to one map entry at a time instead of one global.
  for (const [lang, listener] of [...languageKeyListeners]) {
    if (desired[lang] === languageHotkeyAccels.get(lang)) continue;
    listener.stop();
    languageKeyListeners.delete(lang);
    languageHotkeyAccels.delete(lang);
  }

  for (const [lang, hotkey] of Object.entries(desired)) {
    if (languageKeyListeners.has(lang)) continue; // unchanged, still running

    const normalized = isValidAccelerator(hotkey)
      ? normalizeAccelerator(hotkey)
      : null;
    if (!normalized) continue; // invalid stored value; skip silently (§8)

    // Dictation and remix win on a clash; so does every other language
    // hotkey already claimed — same "first writer wins, log and skip" shape
    // registerRemixHotkey uses against the dictation hotkey (index.ts:
    // 4340-4346).
    const taken =
      normalized === currentHotkeyAccel ||
      normalized === currentRemixAccel ||
      [...languageHotkeyAccels.values()].includes(normalized);
    if (taken) {
      hotkeyLog.warn(
        `Language hotkey "${normalized}" for "${lang}" conflicts with an existing binding; disabled.`,
      );
      continue;
    }

    const listener = new NativeKeyListener({
      hotkey: normalized,
      onKeyDown: () => handleDictationHotkeyDown(lang),
      onKeyUp: () => handleDictationHotkeyUp(lang),
      onError: (error) =>
        hotkeyLog.error(`Language hotkey listener error (${lang}): ${error}`),
      onPermanentFailure: () => {
        if (languageKeyListeners.get(lang) !== listener) return;
        hotkeyLog.error(
          `Language hotkey listener for "${lang}" permanently failed; disabled.`,
        );
        listener.stop();
        languageKeyListeners.delete(lang);
        languageHotkeyAccels.delete(lang);
        if (activeDictationLanguage === lang) {
          activeDictationLanguage = null;
          if (hotkeyPressed) { hotkeyPressed = false; sendHotkeyUp(); }
        }
      },
    });
    languageKeyListeners.set(lang, listener);
    languageHotkeyAccels.set(lang, normalized);

    const started = await listener.start();
    if (languageKeyListeners.get(lang) !== listener) { listener.stop(); continue; }
    if (!started) {
      hotkeyLog.warn(`Language hotkey listener unavailable for "${lang}"; disabled.`);
      listener.stop();
      languageKeyListeners.delete(lang);
      languageHotkeyAccels.delete(lang);
    }
  }
}

function scheduleLanguageHotkeysRegistration(
  map: Record<string, string> | undefined,
): void {
  void registerLanguageHotkeys(map).catch((err) =>
    hotkeyLog.error(
      `Language hotkey registration failed: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
}
```

No `globalShortcut` fallback (matches remix, not the default hotkey) — a
language hotkey needs hold/tap distinction via the native listener the same
way remix does; degrading to a toggle-only `globalShortcut` binding per
language would multiply `registerGlobalShortcutToggle`'s already-adhoc
Linux-only fallback (`index.ts:4486-4521`) across up to five hotkeys for no
clear benefit — a language hotkey that can't get a native listener disables
itself with a log line (§8), same as remix does today on permanent native
failure (`index.ts:4360-4365`).

### Wiring: IPC + settings bootstrap

```ts
ipcMain.on(
  "language-hotkeys:update",
  (_event, map: Record<string, string>) => {
    scheduleLanguageHotkeysRegistration(map);
  },
);

ipcMain.on("language-hotkeys:reload", () => {
  void getServerSettings().then((settings) => {
    if (!settings) return;
    applyLanguageHotkeySettings(settings);
  });
});
```

`applyLanguageHotkeySettings(settings)`, mirroring `applyRemixSettings`
(`index.ts:4068-4077`):

```ts
function applyLanguageHotkeySettings(settings: Record<string, string>): void {
  const raw = settings[SETTINGS_KEYS.languageHotkeys];
  let map: Record<string, string> = {};
  try {
    if (raw) map = JSON.parse(raw);
  } catch {
    map = {};
  }
  scheduleLanguageHotkeysRegistration(map);
}
```

called from the same `waitForServerReady().then(...)` bootstrap block that
already calls `applyRemixSettings(settings)` (`index.ts:3187-3200`) — added
as one more line there, not a new bootstrap path.

---

## 6. Renderer (`apps/electron/src/renderer/src/pages/app.tsx`)

### Preload contract (`apps/electron/src/preload/index.ts` / `index.d.ts`)

`onHotkeyDown`'s callback signature (`preload/index.ts:136-139`) gains an
optional payload — additive, every existing call site that ignores its
argument keeps compiling and behaving identically:

```ts
onHotkeyDown: (
  callback: (payload?: { language?: string }) => void,
): (() => void) => {
  const handler = (_e: unknown, payload?: { language?: string }): void =>
    callback(payload);
  ipcRenderer.on("hotkey:down", handler);
  return () => ipcRenderer.removeListener("hotkey:down", handler);
},
updateLanguageHotkeys: (map: Record<string, string>): void =>
  ipcRenderer.send("language-hotkeys:update", map),
reloadLanguageHotkeys: (): void =>
  ipcRenderer.send("language-hotkeys:reload"),
```

### Session-scoped pinned language — captured once, at start, never re-read

```ts
const pinnedLanguageRef = useRef<string | null>(null);
```

set inside the existing hotkey-down handler (`app.tsx:2274-2308`), at the
very top, before the state-machine branching that decides whether to start a
new recording:

```ts
const removeDown = window.api.onHotkeyDown((payload) => {
  pinnedLanguageRef.current = payload?.language ?? null;
  // ...unchanged branching below (remix supersede, startRecording, etc.)
});
```

**This ref must not be read again at request-build time.** A dictation's
network request can complete long after the *next* dictation has already
started — `restFallbackTranscribe` fires up to 15s after commit on a
streaming timeout (`app.tsx:1560-1574`), and `app.tsx:2292-2306` explicitly
supports starting a new recording while a previous one's transcription is
still in flight (`startRecording(true)` from the "transcribing" state). If a
PT-hotkey dictation's REST fallback fired *after* an EN-hotkey dictation had
already begun and overwritten `pinnedLanguageRef`, reading the ref at that
late point would pin the older PT audio to English. The fix is to capture
the value once, early, into a plain local that travels with that one
recording's own request — the same discipline `startTimeRef`/
`recordingDuration` already follow within a single `commitRecording()` call,
just carried one step further out to survive a delayed fallback.

Capture at the top of `startRecording` (`app.tsx:1323`, alongside the other
per-recording resets like `lastRecordingDurationRef.current = 0`) into a new
ref that is *only* written here and *only* read once per recording, at
commit:

```ts
const recordingLanguageRef = useRef<string | null>(null);
// inside startRecording, before any await:
recordingLanguageRef.current = pinnedLanguageRef.current;
```

Then, at the top of `commitRecording` (`app.tsx:1473`), read it into a local
and thread that local — not the ref — through every path the request can
take, exactly like `recordingDuration` is already a local by that point:

```ts
const commitRecording = useCallback(async () => {
  const dictationLanguage = recordingLanguageRef.current;
  // ...unchanged body, with `dictationLanguage` closed over below
```

- Streaming path (§4b): `getStreamer().startCapture(stream,
  recordingLanguageRef.current)` is actually called back in `startRecording`
  (`app.tsx:1445`), not here — the value is already committed to the
  `Streamer` instance itself by commit time (`this.pendingLanguage`, §4b),
  so nothing further is needed on that path.
- `restFallbackTranscribe` (`app.tsx:744-779`) gains a `language: string |
  null` parameter and includes it as the header:

  ```ts
  const restFallbackTranscribe = useCallback(
    (errorMsg: string, language: string | null): Promise<TranscribeResult> | null => {
      // ...unchanged wavBlob lookup
      const headers: Record<string, string> = {
        "Content-Type": "audio/wav",
        "x-audio-duration-ms": String(lastRecordingDurationRef.current),
      };
      if (language) headers["x-dictation-language"] = language;
      if (appContextRef.current) headers["x-app-context"] = encodeAppContext(appContextRef.current);
      // ...unchanged from here
    },
    [],
  );
  ```

Every caller needs to supply that argument, and **not every caller has
`dictationLanguage` in scope** — this is the one place this section's
"capture once, thread as a value" rule needs its own carrier, because two of
`restFallbackTranscribe`'s three call sites live outside `commitRecording`
entirely:

- The synchronous `transportFailure` branch inside `commitRecording`
  (`app.tsx:1527-1537`) and the 15s `setTimeout` inside `commitRecording`
  (`app.tsx:1560-1574`) both close over `dictationLanguage` directly — no
  new plumbing, same as originally described.
- `onFinal`'s direct call (`app.tsx:855`, `restFallbackTranscribe("")`) and
  every call inside `resolveStreamingWithFallback` (`app.tsx:781-796`,
  reached from the `Streamer`'s `onConnectionState` and `onError`
  callbacks, `app.tsx:826`/`866`) do **not** run inside `commitRecording` —
  they're callbacks registered once at `getStreamer()` construction
  (`app.tsx:802`), a long-lived per-*connection* closure with no per-
  recording value in scope at all. `dictationLanguage` cannot reach them by
  closure.

  All three of these are gated on `streamResolverRef.current` being
  non-null — the ref `commitRecording` sets to the pending commit's
  `resolve` function (`app.tsx:1557`) and every one of these sites reads
  then immediately nulls before acting, i.e. each one only ever fires for
  *the* commit currently pending, never a subsequent one (a language hotkey
  pressed while a streaming commit is still pending doesn't start a new
  recording — it sets `pendingReRecordRef` and defers, `app.tsx:2298-2303`
  — so nothing can overwrite state meant for the pending commit while it's
  still outstanding). A second ref, written and nulled in lockstep with
  `streamResolverRef` rather than at the top of `commitRecording`, carries
  the language to exactly these three sites without reintroducing the
  original leak:

  ```ts
  const streamLanguageRef = useRef<string | null>(null);
  // wherever streamResolverRef.current = resolve; is set (app.tsx:1557):
  streamResolverRef.current = resolve;
  streamLanguageRef.current = dictationLanguage;
  ```

  and read (then nulled) at every point that currently reads-then-nulls
  `streamResolverRef.current`: `resolveStreamingWithFallback`
  (`app.tsx:783-785`), `onFinal` (`app.tsx:845-847`). `onError`
  (`app.tsx:863-868`) needs no separate handling — it only ever acts by
  calling `resolveStreamingWithFallback`, which already does the read/null
  itself.

No ref is read for this purpose anywhere else — the synchronous
pre-registration branch uses its own closure value, and every path that
runs after `streamResolverRef.current` is set reads the ref that's paired
with it, one-to-one, cleared the instant it's consumed.

### Pill UI: pinned-language badge (§7 answers "why show it")

The waveform element (`app.tsx:2672-2738`) is rendered as `{!showRemixCard &&
waveform}` at its one call site (`app.tsx:3330`) inside the capsule. Add a
sibling label, shown only while a session is pinned and visibly active:

```tsx
{!showRemixCard && pillLanguageLabel && (state === "recording" || state === "transcribing") && (
  <span
    style={{
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.02em",
      color: waveColor,
      opacity: 0.85,
      marginInlineStart: 4,
      flexShrink: 0,
    }}
  >
    {pillLanguageLabel}
  </span>
)}
{!showRemixCard && waveform}
```

`pillLanguageLabel` is derived, not new state: the ISO code the *current*
session was started with, uppercased (`"PT"`, `"EN"`) — locale-neutral like
the diarization spec's numbered-speaker labels (`meeting-diarization.md`
§6), no i18n key needed. Sourced from `recordingLanguageRef` (set at
`startRecording`, §6 above) rather than the shorter-lived
`pinnedLanguageRef`, so the badge reflects the recording actually in
progress even if a later hotkey press has already updated
`pinnedLanguageRef` for a *queued* next dictation. Latched the same way
`remixView`/`cardView` already latch their last-known content across a
state flip (`app.tsx:2781-2799`) so the label doesn't blink out the instant
the request completes — a small `pillLanguageRef`/state pair set at
`startRecording` alongside `recordingLanguageRef` and cleared on
`dismissPill`/session end, not on request-build.

---

## 7. Settings UI (`apps/electron/src/renderer/src/pages/settings.tsx`)

### Storage

New key, `apps/electron/src/shared/settings-keys.ts` (alphabetical among the
other keys):

```ts
languageHotkeys: "language_hotkeys",
```

Value: JSON object, language code → accelerator string, e.g. `{"pt":
"Alt+P"}`. Only languages with a *bound* hotkey appear as keys — unset is
"absent from the map", not an empty-string entry, matching how `languages`
itself omits rather than null-fills. No new server-side validation branch in
`apps/server/src/routes/settings.ts`'s `PUT /:key` (`settings.ts:144-262`) —
`hotkey` / `hotkey_mode` / `remix_hotkey` have none today either; this is an
Electron-only setting the generic `settingValueSchema` (a plain string)
already accepts, shape-checked only where it's consumed (`index.ts`'s
`JSON.parse` + `isValidAccelerator`, §5).

### Row rendering

One row per configured language, following the existing remix-hotkey row's
exact shape (`settings.tsx:1140-1194`: idle state = `Button` with
`KeyComboDisplay` + "Change"; recording state = draft chip + Cancel). Because
the row count is dynamic (up to `MAX_LANGUAGES = 5`, `packages/validations/
src/cloud-config.ts:4`) and each row needs its own `useHotkeyRecorder`
instance (a hook, so it can't be called in a loop body), extract a
`LanguageHotkeyRow` component — one per language, mapped over `languages`:

```tsx
{languages.length > 1 &&
  languages.map((code) => (
    <LanguageHotkeyRow
      key={code}
      code={code}
      label={languageOptions.find((o) => o.code === code)?.label ?? code}
      value={languageHotkeys[code]}
      isBlocked={(accel) =>
        acceleratorsEqual(accel, hotkey) ||
        acceleratorsEqual(accel, remixHotkey) ||
        languages.some(
          (other) =>
            other !== code &&
            languageHotkeys[other] &&
            acceleratorsEqual(accel, languageHotkeys[other]!),
        )
      }
      onRecorded={handleLanguageHotkeyRecorded}
      onClear={handleLanguageHotkeyClear}
    />
  ))}
```

Row visibility gate: `languages.length > 1` (item 1 of the feature
description) — a single-language user already gets that language pinned via
`languages[0]` on every dictation; a per-language hotkey would be a redundant
binding for the one language they have.

`LanguageHotkeyRow` internally calls `useHotkeyRecorder(onRecorded, {
isBlocked })` exactly as the top-level component does today for `hotkey` and
`remixHotkey` (`settings.tsx:445-463`), and renders the same idle/recording
JSX shape as the remix row, with the label `t("settings.recording
.languageHotkey", { language: label })` (unset state) and an added "Clear"
affordance next to "Change" (unlike the primary/remix hotkeys, which always
have *some* accelerator — a language hotkey's natural unset state must stay
reachable from the UI, not just from removing the language entirely).

### Persistence + prune-on-removal

```ts
const [languageHotkeys, setLanguageHotkeys] = useState<Record<string, string>>({});

const persistLanguageHotkeys = useCallback((next: Record<string, string>) => {
  setLanguageHotkeys(next);
  getClient()
    .api.settings[":key"].$put({
      param: { key: SETTINGS_KEYS.languageHotkeys },
      json: { value: JSON.stringify(next) },
    })
    .catch(() => {});
  window.api?.updateLanguageHotkeys(next);
}, []);

const handleLanguageHotkeyRecorded = useCallback(
  (code: string, accelerator: string) => {
    persistLanguageHotkeys({ ...languageHotkeysRef.current, [code]: accelerator });
  },
  [persistLanguageHotkeys],
);

const handleLanguageHotkeyClear = useCallback(
  (code: string) => {
    const { [code]: _removed, ...rest } = languageHotkeysRef.current;
    persistLanguageHotkeys(rest);
  },
  [persistLanguageHotkeys],
);
```

(`languageHotkeysRef` mirrors the existing `stateRef`-alongside-`useState`
pattern this file already uses elsewhere for callbacks that need the latest
value without becoming a dependency.)

Item 4's "removing a language unsets its hotkey" lives in
`handleLanguagesChange` (`settings.tsx:611-625`), the same function that
already disables translate mode as a removal side effect
(`settings.tsx:622`):

```ts
const handleLanguagesChange = useCallback(
  (next: string[]) => {
    const normalized = normalizeLanguageList(next);
    setLanguages(normalized);
    getClient().api.settings[":key"].$put({
      param: { key: SETTINGS_KEYS.languages },
      json: { value: JSON.stringify(normalized) },
    }).catch(() => {});
    if (normalized.length !== 1 && translateMode) persistTranslateMode(false);

    // Prune hotkeys bound to languages no longer configured — same
    // remove-implies-unset rule translate mode already follows above.
    const pruned = Object.fromEntries(
      Object.entries(languageHotkeysRef.current).filter(([code]) =>
        normalized.includes(code),
      ),
    );
    if (Object.keys(pruned).length !== Object.keys(languageHotkeysRef.current).length) {
      persistLanguageHotkeys(pruned);
    }
  },
  [translateMode, persistTranslateMode, persistLanguageHotkeys],
);
```

Bootstrap read, alongside the existing settings-load effect
(`settings.tsx:481-484`):

```ts
if (s[SETTINGS_KEYS.languageHotkeys]) {
  try {
    setLanguageHotkeys(JSON.parse(s[SETTINGS_KEYS.languageHotkeys]));
  } catch {
    setLanguageHotkeys({});
  }
}
```

---

## 8. Failure / conflict handling

| Case | Behavior |
|---|---|
| Language hotkey accelerator clashes with the default dictation hotkey, remix hotkey, or another language hotkey (recorded live in Settings) | `useHotkeyRecorder`'s `isBlocked` predicate (§7) refuses the capture immediately — same in-UI rejection the remix row already gives against the dictation hotkey (`settings.tsx:462`, `settings.recording.conflict` copy), never persisted. |
| Same clash, but reached via a stale/edited settings value (not through the recorder) | `registerLanguageHotkeys` (§5) skips that entry at registration time, logs a warning, leaves the listener unregistered — defense in depth, mirrors `registerRemixHotkey`'s existing dictation-vs-remix check (`index.ts:4340-4346`). |
| Stored accelerator is structurally invalid (`isValidAccelerator` fails — e.g. no modifier, corrupted JSON value) | Skipped silently at registration, no listener created, no crash. |
| Native listener process fails to start, or fails permanently after starting | That one language's listener is torn down and left unregistered; every other language hotkey, the default hotkey, and remix are unaffected — matches remix's existing `onPermanentFailure` isolation (`index.ts:4360-4365`), now per-language instead of per-feature. |
| A language is removed from the `languages` list while it has a bound hotkey | Settings UI prunes the map and pushes the update immediately (§7); the now-orphaned `NativeKeyListener` is torn down on the next `registerLanguageHotkeys` pass, which fires synchronously off that same settings write via `window.api.updateLanguageHotkeys`. |
| A dictation is mid-flight when its pinning language is removed (race) | The in-flight request already carries `x-dictation-language` in its headers (§6); server-side membership check (§4) is the actual backstop — if the header's code is no longer in `languages` by the time the request lands, it's ignored and the request falls back to `languages[0]`/auto-detect, never a 400. |
| Language hotkey pressed while a different dictation (default hotkey or another language hotkey) is already recording, hold mode | No-op — `hotkeyPressed` is already `true`; matches today's "press the same hotkey twice mid-recording" behavior (§5). |
| Language hotkey's key-up arrives after a *different* hotkey's key-up already ended the session (stuck-modifier edge case) | Ignored — `handleDictationHotkeyUp` checks `activeDictationLanguage` before acting (§5), so a stray release can't re-fire `sendHotkeyUp()`. |
| `x-dictation-language` header present but the provider doesn't accept the code, or the code is malformed | Same failure mode `languages[0]` already has today — passed straight to `provider.transcribe({ language })`; no new validation beyond the `languages`-membership check, since a value that passed that check came from the user's own configured, provider-validated language list. |

---

## 9. Migration / settings keys / i18n keys

**New settings key**: `SETTINGS_KEYS.languageHotkeys = "language_hotkeys"`
(`apps/electron/src/shared/settings-keys.ts`). No schema migration — this is
the flat `settings` KV table every other Electron-only setting already uses;
an absent row means "no language hotkeys bound," identical in shape to how
an absent `hotkey` row falls back to `DEFAULT_HOTKEY` today.

**New i18n keys** (`apps/electron/src/renderer/src/locales/en.json` +
template, mirroring the existing `settings.recording.*` / `settings.remix.*`
key locations):

- `settings.recording.languageHotkey` — row label, `{{language}}`
  interpolation, e.g. en: `"Dictate in {{language}}"`.
- `settings.recording.languageHotkeyDesc` — row description (unbound state),
  e.g. en: `"Optional — pins this dictation to {{language}}, skipping auto-
  detect."`.
- `settings.recording.languageHotkeyConflict` — new key, not a reuse of
  `settings.recording.conflict` (`"This is already your dictation hotkey.
  Pick a different combination."`, `en.json:296`) or `settings.remix
  .conflict` (`"This is already your Remix hotkey...`", `en.json:219`): both
  existing strings name one specific *other* binding, but a language
  hotkey's `isBlocked` predicate (§7) can't tell the row which of three kinds
  of binding it collided with (default, remix, or another language). Generic
  copy instead, e.g. en: `"This combination is already in use. Pick a
  different one."`

No new keys needed for the pill badge (§6 — locale-neutral ISO code, same
call as the diarization spec's numbered speaker labels) or for the server-
side debug log line (§4 — not user-facing).

**Not a migration for other locales in this PR's critical path**: per
`meeting-diarization.md`'s own precedent (§6 there), new keys should land in
all locale files + `template.json`, not English-only — call this out
explicitly in the PR so it isn't dropped the way an English-only key would
create a mixed-language settings screen for non-English users.

---

## 10. Test plan

**Unit — server override resolution (extend `apps/server/tests/transcribe-
bias.test.ts` or a new `apps/server/tests/transcribe-language-override
.test.ts`, matching that file's plain-function style):**

- `x-dictation-language` header present and its value is a member of
  `getLanguagesSetting()`'s current list → `effectiveLanguages` is a single-
  element array of that value; `primaryLanguage` matches.
- Header present but its value is **not** in the current `languages` list
  (stale binding) → falls back to the unmodified `languages` list, same as
  no header at all.
- Header absent → today's exact behavior, unmodified (`effectiveLanguages
  === languages`, `primaryLanguage === languages[0]`) — regression check
  that this change is additive.
- Header present, `languages` is empty (auto-detect configured) and the
  header value isn't in `[]` → falls back to `[]` (still auto-detect); a
  language hotkey cannot override a user who has explicitly chosen auto-
  detect and configured no languages at all — there's nothing in the
  configured list for the override to validate against, so it's inert by
  construction, not a special case to code around. Assert this explicitly
  rather than assuming it from the membership-check logic.
- `buildLanguageBlock([override])` (existing `editor/prompts.ts` function,
  no new test file needed — extend its existing test coverage if present, or
  add one case) produces the same single-language constraint string as
  calling it with a naturally single-configured-language list — proves the
  reuse claim in §4a rather than just asserting it in prose.

**Unit — streaming config override (extend `apps/server/tests`' existing
stream-route coverage if one exists, else a new `apps/server/tests/stream-
language-override.test.ts` exercising `resolveStreamConfig()`'s logic
directly rather than a live socket):**

- `languageOverride` set to a member of `getLanguagesSetting()`'s list →
  resolved `languages` is `[override]`, and the comparison `key` differs
  from the same call with `languageOverride` unset — proves a language
  change alone is sufficient to force the rebuild branch (§4b).
- `languageOverride` set to a value **not** in the current `languages` list
  → resolved `languages` falls back to the full list, `key` unchanged from
  the no-override case — same membership guard as §4a, exercised on this
  path too.
- Two successive `"start"` messages, second with a different
  `languageOverride` than the first (simulating PT-hotkey dictation followed
  by EN-hotkey dictation on the same warm connection) → `sameConfig`
  evaluates `false` on the second, the rebuild branch runs (assert via a
  spy/fake on `connectUpstream` or `closeUpstreamSession`, matching this
  file's existing mocking style for the upstream session).

**Unit — main-process registration (`apps/electron/tests/key-listener
.test.ts` or a new `apps/electron/tests/language-hotkeys.test.ts`, matching
the existing Playwright-based unit style in that directory):**

- `registerLanguageHotkeys` with a map containing an accelerator equal to
  `currentHotkeyAccel` → that entry is skipped, warning logged, no listener
  created (assert via a spy on the log or on `NativeKeyListener`
  construction — the pipeline-test style `meeting-diarize-pipeline.test.ts`
  uses for spy-based assertions is a reasonable model here too).
- Map with two entries sharing the same accelerator → the second is skipped
  (first-registered wins), not both silently active.
- Re-calling `registerLanguageHotkeys` with an unchanged map → no listener
  torn down and recreated (assert the same listener instance / no new
  `NativeKeyListener` construction) — this is the "unchanged, still running"
  branch in §5's diff loop.
- Removing an entry from the map between calls → that language's listener is
  stopped, no others are.
- `handleDictationHotkeyDown`/`Up` with a `language` argument, hold mode:
  press starts with that language tagged as `activeDictationLanguage`;
  key-up from a *different* language argument is a no-op; key-up from the
  *same* language argument (or `undefined` matching a `null`
  `activeDictationLanguage`) ends the session. Toggle mode: any hotkey's
  down-press while already pressed stops the session regardless of which
  language argument it carries (matches today's single-hotkey toggle
  semantics, §5).

**Real end-to-end (manual, matching `meeting-diarization.md` §12's
acceptance-checklist pattern):**

- [ ] Configure two languages (e.g. `en`, `pt`); confirm both per-language
      hotkey rows appear in Settings → Recording, both initially unset, and
      confirm they're absent entirely with only one language configured.
- [ ] Bind a hotkey to each language; confirm the recorder rejects an
      accelerator already used by the default hotkey, the remix hotkey, or
      the other language.
- [ ] Dictate one utterance in Portuguese via the PT hotkey and one in
      English via the EN hotkey (mixed-language speaker, e.g. reading a
      Portuguese sentence through the EN hotkey to isolate the pin from
      what's actually spoken). Confirm the server debug log's `override=`
      line (§4) shows the pressed hotkey's language for each request, and
      the transcript matches the pinned language's expected cleanup
      (script/punctuation), not `languages[0]`'s.
- [ ] Confirm the recording pill shows the small language badge (§6) only
      while a language-hotkey dictation is active, and shows nothing for a
      default-hotkey dictation.
- [ ] Remove one of the two configured languages; confirm its hotkey row
      disappears and a fresh press of its old accelerator does nothing (no
      dictation starts, no stale listener fires).
- [ ] With a session-transport-capable provider configured (e.g. a Soniox
      realtime setup), dictate PT then EN back-to-back via their hotkeys on
      the *same* warm connection (no app restart between). Confirm each
      transcript reflects its own pinned language — the second dictation
      must not silently inherit the first's upstream session (§4b's rebuild
      claim, verified live) — and confirm ordinary streaming latency for a
      default-hotkey dictation on the same connection is unaffected before
      and after.
- [ ] Toggle activation mode to "toggle" and repeat the PT/EN dictation
      check — confirm start/stop still works per hotkey and a second
      language hotkey pressed mid-recording stops the session (§5's no-op-
      then-toggle-stops-anything semantics).

---

## 11. File inventory (planned)

New files:
- `apps/server/tests/transcribe-language-override.test.ts` (or extend
  `transcribe-bias.test.ts`)
- `apps/server/tests/stream-language-override.test.ts` (or extend an
  existing stream-route test file, §10)
- `apps/electron/tests/language-hotkeys.test.ts` (or extend `key-listener
  .test.ts`)

Modified files:
- `apps/server/src/routes/transcribe.ts` — `x-dictation-language` header
  read, `effectiveLanguages` override + membership check, debug log line
  (§4a).
- `apps/server/src/routes/stream.ts` — `languageOverride` closure variable,
  `msg.language` read in the `"start"` case, `resolveStreamConfig()`'s
  membership-guarded substitution (§4b).
- `apps/electron/src/renderer/src/lib/streamer.ts` — `startCapture`'s new
  `language` parameter, `pendingLanguage` field, included in the `"start"`
  message (§4b).
- `apps/electron/src/shared/settings-keys.ts` — `languageHotkeys` key (§9).
- `apps/electron/src/main/index.ts` — `languageKeyListeners` /
  `languageHotkeyAccels` / `activeDictationLanguage` state;
  `handleDictationHotkeyDown`/`Up` generalized from `handleNativeHotkeyDown`/
  `Up` (clearing `activeDictationLanguage` on every `hotkeyPressed` reset,
  including the stuck-watchdog and `registerHotkey` teardown paths, §5);
  `sendHotkeyDown` gains a `language` param; `registerLanguageHotkeys` /
  `scheduleLanguageHotkeysRegistration` / `applyLanguageHotkeySettings`; new
  `ipcMain.on("language-hotkeys:update"/"language-hotkeys:reload")`
  handlers; bootstrap call added alongside `applyRemixSettings` (§5).
- `apps/electron/src/preload/index.ts` / `index.d.ts` — `onHotkeyDown`
  payload type, `updateLanguageHotkeys`, `reloadLanguageHotkeys` (§6).
- `apps/electron/src/renderer/src/pages/app.tsx` — `pinnedLanguageRef` +
  `recordingLanguageRef` (captured once at `startRecording`, §6) +
  `streamLanguageRef` (paired with `streamResolverRef`'s lifecycle) +
  latched pill-label state; `restFallbackTranscribe` gains a `language`
  parameter, supplied from `dictationLanguage` at its in-`commitRecording`
  call sites and from `streamLanguageRef` at its Streamer-callback call
  sites (`onFinal`, `resolveStreamingWithFallback`); `startCapture`'s new
  argument; waveform-sibling badge JSX (§6).
- `apps/electron/src/renderer/src/pages/settings.tsx` — `languageHotkeys`
  state, `LanguageHotkeyRow` component + row list, persistence + prune-on-
  removal wired into `handleLanguagesChange` (§7).
- `apps/electron/src/renderer/src/locales/*.json` (all locales + template)
  — `settings.recording.languageHotkey`, `languageHotkeyDesc`,
  `languageHotkeyConflict` (§9).

---

## Open questions

1. **Badge placement/styling (§6)** is specified functionally (locale-
   neutral code, shown only while active, latched across the same
   transition window the remix/error cards already use) but the exact
   inline-style values given are a starting point, not a locked design —
   this file's own house style (`app.tsx`'s extensive motion-design comments
   throughout) suggests the actual visual polish pass belongs with whoever
   implements this, not dictated in full here.
2. **Whether the "start" message's `language` field should be sticky across
   reconnects within one recording.** §4b sets `languageOverride` once, on
   each `"start"`; `stream.ts`'s existing `onClose` reconnect path
   (`stream.ts:381-394`) calls `connectUpstream(ws)` directly, not a fresh
   `"start"`, so a mid-recording reconnect keeps whatever `languageOverride`
   was already set — believed correct (nothing should change the pin
   mid-recording) but not exercised by this spec's test plan; worth an
   explicit test if reconnect-during-a-pinned-recording turns out to be
   reachable in practice.
