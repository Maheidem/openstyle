# LLM Task Profiles & Parameter Presets — Implementation Spec

Grounded in the codebase as of `main` @ 2026-08-27 (HEAD `5abf094`, the
Summarize truncation fix — see §3.3, this spec absorbs it rather than
fighting it). Companion reading: [`meeting-diarization.md`](meeting-diarization.md)
for the house style this spec follows (file:line citations, explicit failure
matrices, real-E2E checklists), [`design-system.md`](design-system.md) for
the tokens/components this spec's UI reuses.

USER-APPROVED DESIGN, 2026-08-27. This is the full spec for that approval —
registry shape, storage schema, precedence, provider mapping, UI, migration,
failure modes, i18n, tests.

---

## 1. Goal

Every LLM call site in this codebase currently builds its own ad-hoc
`temperature`/`maxOutputTokens`/reasoning params inline (§3), and exactly one
of those call sites (`local-llm` cleanup) has a user-facing way to override
sampling — a single **global** blob (`cleanup_sampling`) that, despite its
name, is silently applied to Remix and every meeting LLM call too, and only
reaches local OpenAI-compatible servers.

This spec replaces both with two layers:

1. **Task profiles** (internal, code-defined): every call site declares which
   of four named tasks it is — `cleanup`, `remix`, `meetingSummarize`,
   `meetingEnhance` — and gets that task's built-in defaults (reasoning
   on/off, temperature, output budget, timeout) instead of its own inline
   numbers.
2. **Parameter presets** (user-defined): named, raw-JSON parameter sets
   stored in settings, assignable per task, editable in a mono JSON textarea
   with no structured form. Two starter presets ship built-in. Presets pass
   through **verbatim** to OpenAI-compatible endpoints (`local-llm`) and as a
   **mapped safe subset** to every cloud/native-SDK provider — never an
   error, never silently corrupting a request cloud-side.

### Non-goals

- No per-task **prompt** editing — Tone (`cleanup_intensity`, tone settings)
  already owns that; this spec is sampling parameters only.
- No preset sync/export in v1 — presets live in this app's local settings
  table like everything else on this page.
- No test-call / dry-run button for presets (§9's failure-mode discussion
  covers why this is deferred, not solved).
- No change to which model each task uses **by default** — that stays the
  single app-wide default LLM (`model_configs` `is_default`). This spec adds
  an *optional* per-task override on top of that default (§6), it does not
  introduce per-task default routing.

---

## 2. Current state — every LLM call site, grounded

Four call sites build a chat model and call `generateText`/`streamText`
today, all through the same registry:

| # | File:line | Task | Params today |
|---|---|---|---|
| 1 | `apps/server/src/lib/post-process.ts:228-247` | Dictation cleanup | `temperature: 0` (hardcoded default inside `@openstyle/stt`), `maxOutputTokens` from `maxOutputTokensForCleanup()` (`packages/stt/src/tokens.ts:14-21`, scales 512–8192 off input length), `providerOptions` from `getLlmProvider(...).providerOptions?.()` (Groq-only reasoning hack, §2.1), no timeout. |
| 2 | `apps/server/src/lib/remix-transform.ts:97-107` | Remix (quick edit) | `temperature: 0` (inline literal), `maxOutputTokens` from the same `maxOutputTokensForCleanup()` heuristic applied to the *selection*, `providerOptions` same Groq hack, no timeout. |
| 3 | `apps/server/src/lib/remix-agent.ts:64-75` | Remix (agent loop, tool calling) | **No temperature, no maxOutputTokens at all** — `streamText` runs on whatever the provider/model defaults to. `providerOptions` same Groq hack. `abortSignal` is threaded from the HTTP request (`routes/remix/agent.ts:39`), no independent timeout. |
| 4 | `apps/server/src/lib/meetings/llm-call.ts:51-105` (`resolveDefaultChatCall`) | Meeting Summarize *and* Enhance — shared helper | **No temperature passed** → inherits `@openstyle/stt`'s hardcoded `0` (`packages/stt/src/post-process.ts:127`). `maxOutputTokens` is whatever the caller computes: Summarize passes a flat `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 4096` (§3.3) for every call in a run; Enhance passes `Math.ceil(chunkTokens * 1.3) + 200` per chunk (`enhance.ts:184`). Same Groq `providerOptions` hack. No timeout. |

All four resolve the model through the same two functions:

- `getDefaultModels()` (`apps/server/src/lib/providers.ts:33-55`) — reads the
  single `model_configs` row with `type='llm' AND is_default=1`. **Every
  task uses this same one model today** — there is no per-task model
  selection anywhere in the codebase.
- `createChatModel(providerId, modelId)` (`providers.ts:57-70`) → resolves an
  API key, delegates to `getLlmProvider(providerId).createModel(...)`
  (`llm/registry.ts:19-36`, the `PROVIDERS` array at `registry.ts:144-251`).

### 2.1 The existing reasoning hack this spec must subsume

`groqCleanupProviderOptions(modelId)` (`registry.ts:46-70`) is a hardcoded
switch on two specific Groq model ids/families that forces `reasoningFormat:
"hidden"` plus a **per-family** `reasoningEffort` — `"none"` for
`qwen/qwen3-32b`, but `"low"` for `openai/gpt-oss-{20b,120b}` (`registry.ts:59-66`,
these are not the same value; a rewrite that collapses both families to one
constant changes gpt-oss's behavior, see §7.3's correction) — a
cleanup-flavored default that every one of the four call sites above
inherits unconditionally via `getLlmProvider(...).providerOptions?.(modelId)`,
because none of them pass a task identity through to distinguish "this is
cleanup, keep reasoning off" from "this is Enhance, which might legitimately
want it on." §7.3 replaces this with a task-aware version.

### 2.2 The existing sampling feature this spec migrates (not duplicates)

`cleanup_sampling` (`settings-keys.ts:9`) is today's only user-facing
parameter override:

- **Schema**: `cleanupSamplingSchema` (`packages/validations/src/settings.ts:58-102`)
  — a **structured** Zod object (`temperature`, `top_p`, `top_k`, `min_p`,
  `repetition_penalty`, `presence_penalty`, `max_tokens`, `thinking_budget`,
  `reasoning_effort`, `chat_template_kwargs`), one JSON blob under a single
  settings key, validated server-side at `routes/settings.ts:205-215`.
- **Application**: read fresh from the DB inside the `local-llm` provider's
  `createModel` on *every call* (`registry.ts:236-239`), merged onto the
  outgoing chat-completions body by a custom `fetch` —
  `createSamplingFetch`/`mergeSamplingIntoBody` (`registry.ts:85-142`) —
  because `top_k`/`min_p`/`repetition_penalty`/`chat_template_kwargs` have no
  route through the AI SDK (`registry.ts:72-84`'s own comment says so).
  **Global and provider-scoped, not per-task**: it is the same blob for
  cleanup, Remix, and both meeting calls, and it does nothing at all for any
  provider other than `local-llm` — `openai`/`anthropic`/`google`/`mistral`/
  `openrouter`/`vercel` never see it (no custom `fetch` is installed on any
  of those `PROVIDERS` entries, `registry.ts:146-212`).
- **UI**: `CleanupSamplingDialog` (`apps/electron/src/renderer/src/pages/models/sampling-dialog.tsx`,
  440 lines) — a structured form (sliders, number inputs, switches, selects),
  not raw JSON. Opened from a link inside the cleanup side of `PairCard`
  (`pair-card.tsx:72-79` builds a `warmingAction`-shaped prop, `:115` types
  it, `:183-192` renders it as a `variant="link"` button) — **already inside
  the cleanup card**, not floating elsewhere; the prop is just named
  `warmingAction` for both the MLX-warming and sampling links, an artifact of
  copy-paste. Gated `advancedMode && m.defaultLlm?.provider === "local-llm"`
  (`models/index.tsx:185`) — hidden entirely for cloud-model users.
- **Precedent already worth keeping**: `mergeSamplingIntoBody`
  (`registry.ts:85-117`) already treats `max_tokens` as a **floor, not an
  override** — `Math.max(computed, sampling.max_tokens)` — specifically
  because Remix needs more headroom than cleanup and has no truncation
  fallback (comment at `registry.ts:100-104`). §6.2 generalizes this exact
  rule to every task.

§10 spells out the migration in full; the summary: `cleanup_sampling` and
`CleanupSamplingDialog` are retired, one-time-migrated into the new system,
not run in parallel with it.

---

## 3. Task profile registry

### 3.1 Shape

New file: `apps/server/src/lib/llm/task-profiles.ts`.

```ts
export type LlmTaskId =
  | "cleanup"
  | "remix"
  | "meetingSummarize"
  | "meetingEnhance";

export interface LlmTaskProfile {
  id: LlmTaskId;
  /** Whether reasoning/thinking is on by default for this task's nature. */
  reasoningEnabled: boolean;
  /** SDK-level default temperature when no preset/custom override wins. */
  temperature: number;
  /**
   * Output budget. A concrete number, or `"auto"` to keep the task's own
   * existing per-call heuristic (cleanup/Remix scale off input length,
   * Enhance scales off chunk size) instead of a fixed constant.
   */
  maxOutputTokens: number | "auto";
  /** Wall-clock timeout for one LLM call in this task (§8.4). */
  timeoutMs: number;
}
```

This is a **code constant**, not a settings row — task *identity* and its
*nature* (fast vs. long-output, reasoning on/off) are an engineering
decision, not something a preset assignment should be able to silently
redefine. What's user-configurable is layered on top (§6).

### 3.2 Built-in defaults, per task nature

| Task | reasoningEnabled | temperature | maxOutputTokens | timeoutMs | Why |
|---|---|---|---|---|---|
| `cleanup` | `false` | `0` | `"auto"` (§2 row 1's existing heuristic, unchanged: 512–8192, scaled off input) | `20_000` | Runs on the live dictation hot path (§2 row 1) — fast and deterministic. Matches today's actual behavior exactly; this profile formalizes it, doesn't change it. |
| `remix` | `false` | `0` | `"auto"` (existing heuristic for the transform call; §8.2 covers what "auto" means for the agent loop, which has none today) | `30_000` | Interactive: the user is watching a pill/canvas wait on this. Slightly more headroom than cleanup because Remix edits can legitimately be longer than the source dictation (list expansion, etc. — same reasoning as the existing `max_tokens`-floor comment, `registry.ts:100-104`). |
| `meetingSummarize` | `false` | `0` | `4096` | `60_000` | **Absorbs the truncation fix at `5abf094`** (§3.3) — the flat 4096 constant *is* `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` (`summarize.ts:60`), not a new number. Meetings can run long map/reduce chains; a generous per-call timeout avoids a slow local model failing a whole summarize run over one chunk. |
| `meetingEnhance` | `false` | `0` | `"auto"` (existing per-chunk heuristic, `enhance.ts:184`, unchanged) | `60_000` | "Strict" per the task brief: JSON-only output, no chain-of-thought pollution allowed to leak into `extractJsonObject`'s parse (`enhance.ts:132-146`) — reasoning off is a correctness requirement here, not just a speed preference. Same generous timeout as Summarize (same map-over-chunks shape, same local-model-latency risk). |

**None of these four rows changes runtime behavior on day one for a user
with no presets assigned** — every "auto" and every numeric default here is
copied from what the corresponding call site already does today (§2's
table), so shipping the registry alone (before anyone touches the new UI) is
a no-op. The only two behavior deltas at ship time are: (a) Remix's agent
loop gains a `maxOutputTokens`/timeout it never had (§8.2 — a safety net, not
previously present, flagged for sign-off in §12 open questions), and (b) a
timeout now exists everywhere (previously nowhere) — a hung local server on
any of the four call sites now fails after the table above's timeout instead
of hanging the request indefinitely.

### 3.3 The Summarize truncation fix, absorbed not fought

`5abf094` ("raise summary output budget so map/reduce calls aren't
truncated") already landed at HEAD, before this spec was written — the task
brief's "may land soon" is stale; it landed. `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS
= 4096` (`summarize.ts:60`, full rationale at `summarize.ts:33-59`: 1500 was
too tight once a reasoning model's hidden `<think>` output ate most of the
budget, one real meeting's map/reduce calls hit `finishReason: "length"` and
got discarded by `postProcess`'s untrustworthy-output guard,
`packages/stt/src/post-process.ts:145-157`).

This spec's `meetingSummarize` profile default (§3.2) **is** that 4096 —
same number, same constant, re-exported rather than duplicated (§8.3). If a
future patch changes `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` again, the task
profile changes with it automatically. Nothing here reverts or races that
fix; a user who assigns a preset with a smaller `max_tokens` cannot lower
Summarize below whatever `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` currently is —
§6.2 makes the task's own budget a **floor**, exactly like the existing
`max_tokens`-floor rule this spec generalizes.

---

## 4. Parameter preset storage

### 4.1 Schema

New setting key `llm_parameter_presets` (`SETTINGS_KEYS.llmParameterPresets`),
one JSON blob, shape:

```ts
export interface LlmParameterPreset {
  /** `user_<uuid>` for user-created presets. Built-ins use fixed `builtin:*`
   *  ids (§4.2) that never appear in this stored list. */
  id: string;
  /** Display name, 1-60 chars. Shown in the segmented control (§9.3) and
   *  the assignment chip. */
  name: string;
  /** Arbitrary JSON object, passed through per §7. No schema beyond
   *  "valid JSON, top-level object" (§4.3). */
  params: Record<string, unknown>;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface LlmParameterPresetsSetting {
  presets: LlmParameterPreset[];
}
```

```ts
// packages/validations/src/llm-task-profiles.ts (new file)
export const LLM_PRESET_NAME_MAX = 60;
/** Matches CLEANUP_CUSTOM_PROMPT_MAX's role (settings.ts:27) — a generous
 *  bound that stops an unbounded blob from being re-parsed on every request
 *  (registry.ts:236 re-reads settings per call; this generalizes to
 *  per-task resolution, §8.3, at the same frequency). */
export const LLM_PRESET_PARAMS_MAX_BYTES = 8192;
export const LLM_PRESET_COUNT_MAX = 50;

export const llmParameterPresetSchema = z.object({
  id: z.string().min(1).max(80).regex(/^user_/),
  name: z.string().min(1).max(LLM_PRESET_NAME_MAX),
  params: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const llmParameterPresetsSettingSchema = z.object({
  presets: z.array(llmParameterPresetSchema).max(LLM_PRESET_COUNT_MAX),
});
```

`id` is required to match `/^user_/` **at the validation boundary** — this
is what stops a client from writing a preset that collides with (or spoofs)
a `builtin:` id (§4.2), since built-ins are never stored, only merged in at
read time.

Byte-size validation on `params` (serialized JSON ≤ 8192 bytes) happens in
the route handler (`zod`'s `record(unknown())` can't express a byte bound on
the serialized form), same pattern as `cleanupCustomPromptSchema`'s
`.max(CLEANUP_CUSTOM_PROMPT_MAX)` for a string field — here checked
explicitly against `JSON.stringify(preset.params).length` per preset.

### 4.2 Built-in starter presets — code constants, not seeded rows

```ts
// packages/validations/src/llm-task-profiles.ts
export const BUILTIN_LLM_PRESETS: readonly LlmParameterPreset[] = [
  {
    id: "builtin:qwen-thinking",
    name: "Qwen thinking",
    params: {
      temperature: 1.0,
      max_tokens: 512,
      stream: false,
      top_p: 0.95,
      top_k: 20,
      min_p: 0.0,
      presence_penalty: 0.0,
      repetition_penalty: 1.0,
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: false,
        reasoning_effort: "xhigh",
      },
    },
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  },
  {
    id: "builtin:qwen-fast",
    name: "Qwen fast",
    params: {
      temperature: 0.7,
      max_tokens: 512,
      stream: false,
      top_p: 0.80,
      top_k: 20,
      min_p: 0.0,
      presence_penalty: 1.5,
      repetition_penalty: 1.0,
      chat_template_kwargs: { enable_thinking: false },
    },
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  },
] as const;
```

**Payloads copied verbatim from the approved spec, byte for byte — not
re-derived.** `stream: false` is kept even though it's on the resolver's
denylist (§7.4) and gets stripped at resolution time for every task; it's
shown in the raw editor exactly as approved and simply never reaches the
wire, same as any other denylisted key a user might type in Custom mode.

**Amendment, 2026-08-27 (resolves §12 item 6):** the field above is
`repetition_penalty`, not the `repeat_penalty` this section originally
specified. User-verified against oMLX's own `openapi.json` — the server
these two presets target on `local-llm` accepts `repetition_penalty` and
does not recognize `repeat_penalty`, so the original spelling silently
no-opped that knob for both starter presets. This also aligns both
built-ins with every other spelling of this knob already in the codebase
(`cleanupSamplingSchema.repetition_penalty`, `settings.ts:63`; the §12.7
legacy fallback, which resolves an existing `cleanup_sampling` blob using
that same field name). Values are unchanged (`1.0` for both presets); only
the key name moved. The code block above reflects the corrected spelling.

Never written to the `llm_parameter_presets` setting row. The resolver
(§8.3) and every UI list (§9.3) merge `BUILTIN_LLM_PRESETS` **ahead of** the
stored `presets` array, by concatenation, so they always exist, can't drift
from this spec via a stray `UPDATE`, and "Reset" has something fixed to fall
back to. A built-in is **not directly editable** — the editor (§9.4) opens
built-ins read-only with a **"Duplicate to edit"** action that copies the
payload into a new `user_<uuid>`-id preset the user can then modify. This
also means a rename can never orphan a `builtin:` assignment (§4.1's
"presets are stored by id, not name" — the id is a fixed literal for
built-ins, so it can't be renamed away at all).

### 4.3 Save-time validation (client + server, both — never trust the client alone)

1. Must parse as JSON (`JSON.parse` succeeds).
2. Parsed value must be a plain object (not array, not primitive, not
   `null`) — same shape check `mergeSamplingIntoBody` already does for the
   *request* body (`registry.ts:91-97`), applied here to the *preset*
   instead.
3. Serialized size ≤ `LLM_PRESET_PARAMS_MAX_BYTES` (8192 bytes).
4. Name 1–60 chars, non-empty after trim.
5. **No key-shape validation beyond "valid JSON object."** This is the
   explicit design ("validated-as-JSON only") — a preset can contain any
   key, including ones a given server will reject at call time (§11.3
   covers that failure mode; it is not caught here).

The renderer's `Textarea` (`components/ui/textarea.tsx`) already supports
`aria-invalid` styling; the preset editor (§9.4) sets it on any parse
failure and blocks Save, mirroring the existing pattern in
`NumberRow.onChange` (`sampling-dialog.tsx:363-375`, being deleted, §10) of
never persisting a value the server would 400 on.

---

## 5. Task assignment storage

### 5.1 Schema

New setting key `llm_task_assignments`
(`SETTINGS_KEYS.llmTaskAssignments`), one JSON blob keyed by task id:

```ts
export type LlmTaskAssignmentMode = "auto" | "preset" | "custom";

export interface LlmTaskAssignment {
  mode: LlmTaskAssignmentMode;
  /** Required when mode === "preset". A builtin:* or user_* id (§4). */
  presetId?: string;
  /** Required when mode === "custom". Same shape/validation as a preset's
   *  `params` (§4.1, §4.3) — this is this task's own unsaved-as-a-preset
   *  raw JSON. */
  params?: Record<string, unknown>;
  /** Optional per-task model override (§6.3). Absent = use the app-wide
   *  default LLM (`getDefaultModels().llm`). */
  modelOverride?: { provider: string; model_id: string };
}

export type LlmTaskAssignments = Partial<Record<LlmTaskId, LlmTaskAssignment>>;
```

A missing key for a given task id means `{ mode: "auto" }` with no
override — this is the zero-row, fresh-install state, and it is
byte-for-byte the same as today's behavior (§3.2's "no day-one behavior
change" claim depends on this).

```ts
// packages/validations/src/llm-task-profiles.ts
export const LLM_TASK_IDS = [
  "cleanup",
  "remix",
  "meetingSummarize",
  "meetingEnhance",
] as const;

export const llmTaskAssignmentSchema = z.object({
  mode: z.enum(["auto", "preset", "custom"]),
  presetId: z.string().min(1).max(80).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  modelOverride: z
    .object({ provider: z.string().min(1), model_id: z.string().min(1) })
    .optional(),
});

// Unknown task-id keys are stripped, not rejected — see reasoning below.
export function parseLlmTaskAssignments(
  value: string | null | undefined,
): LlmTaskAssignments {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const out: LlmTaskAssignments = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (!(LLM_TASK_IDS as readonly string[]).includes(key)) continue;
      const result = llmTaskAssignmentSchema.safeParse(entry);
      if (result.success) out[key as LlmTaskId] = result.data;
    }
    return out;
  } catch {
    return {};
  }
}
```

Unknown task-id keys are **silently dropped**, not a 400 — mirrors
`parseCleanupSampling`'s "never throws, degrade to no-overrides"
philosophy (`settings.ts:115-125`) at the per-key level: a future rename or
removal of a task id (or a downgrade to an older build that doesn't know a
newer task id) must not corrupt or reject the whole assignments blob over
one stale key.

### 5.2 Server-side route validation

`routes/settings.ts`'s `PUT /:key` handler (§2.2, `settings.ts:144-261`)
gets two new `else if` branches, same shape as the existing
`cleanup_sampling` branch (`settings.ts:205-215`) it replaces:

```ts
} else if (key === "llm_parameter_presets") {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body.value);
  } catch {
    return c.json({ error: "Invalid parameter presets setting" }, 400);
  }
  const parsed = llmParameterPresetsSettingSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return c.json({ error: "Invalid parameter presets setting" }, 400);
  }
  for (const preset of parsed.data.presets) {
    if (JSON.stringify(preset.params).length > LLM_PRESET_PARAMS_MAX_BYTES) {
      return c.json({ error: `Preset "${preset.name}" is too large` }, 400);
    }
  }
} else if (key === "llm_task_assignments") {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body.value);
  } catch {
    return c.json({ error: "Invalid task assignments setting" }, 400);
  }
  // Reuses parseLlmTaskAssignments's drop-unknown-keys behavior, but a PUT
  // must still reject a body that is not JSON-object-shaped at all, or
  // whose *known* keys fail their own schema outright — silently accepting
  // a malformed known-task entry would let the UI PUT something it then
  // can't read back.
  if (
    typeof parsedJson !== "object" ||
    parsedJson === null ||
    Array.isArray(parsedJson)
  ) {
    return c.json({ error: "Invalid task assignments setting" }, 400);
  }
  for (const [taskKey, entry] of Object.entries(
    parsedJson as Record<string, unknown>,
  )) {
    if (!(LLM_TASK_IDS as readonly string[]).includes(taskKey)) continue;
    if (!llmTaskAssignmentSchema.safeParse(entry).success) {
      return c.json({ error: `Invalid assignment for task "${taskKey}"` }, 400);
    }
  }
}
```

---

## 6. Precedence rules

Three things layer per task, resolved fresh on every call by
`resolveTaskCall` (§8.3) — never cached across requests, matching the
existing "read settings fresh on every call" comment at `registry.ts:234-235`.

### 6.1 Mode selection (mutually exclusive, not layered)

A task's assignment `mode` picks **one** source for its sampling params —
this is a segmented-control choice (§9.3), not a merge of multiple sources:

- **`auto`** — no user params at all. Only the task profile's own SDK-level
  defaults apply (§3.2's `temperature`/`reasoningEnabled`/`maxOutputTokens`).
  For `local-llm`, nothing extra goes on the wire beyond what those defaults
  already imply (§6.4 — reasoning still needs to reach the wire somehow;
  that's `chat_template_kwargs`, not a "preset").
- **`preset`** — the assigned preset's full `params` object (§4) is the
  resolved sampling params, verbatim tier / mapped subset per §7.
- **`custom`** — the task's own inline `params` (§5.1) plays the exact same
  role a preset would, minus a name and minus being reusable across tasks.
  Same validation (§4.3), same resolution path (§7) — "Custom" is not a
  second code path, it's an unnamed one-off preset scoped to this task.

### 6.2 `max_tokens` is always a floor, never a ceiling — generalized

This is the one place the task profile's default and the resolved sampling
params (preset or custom) **do** layer, regardless of mode, because it's the
exact rule that already ships (`registry.ts:105-111`, `max_tokens is a floor,
not a cap` describes the pattern this generalizes):

```
resolvedMaxOutputTokens = max(
  taskProfile.maxOutputTokens === "auto"
    ? callerComputedAutoBudget   // e.g. maxOutputTokensForCleanup(text)
    : taskProfile.maxOutputTokens,
  resolvedSamplingParams.max_tokens ?? 0,
)
```

**Consequence, stated explicitly (per the task brief's own ask): a user
cannot *lower* a task's output budget via a preset in v1.** Both starter
presets ship `max_tokens: 512` (§4.2) — for `cleanup`/`remix` (whose task
default is `"auto"`, already ≥512 per `MIN_CLEANUP_OUTPUT_TOKENS`,
`packages/stt/src/tokens.ts:6`) this floor is a no-op; for
`meetingSummarize` (task default `4096`) it's also a no-op, since 512 < 4096.
Both starter presets are therefore **provably harmless to every task's
output budget** — the number that ends up on the wire is never smaller than
what the task already used before this feature existed. A user who wants a
*smaller* budget than the task default sets `max_tokens` in Custom mode
higher than they want and accepts the task floor, or (v2 scope, not spec'd
here) the task profile's own default gets a settings override — out of
scope for v1.

This floor applies identically whether the resolved sampling params came
from `mode: "preset"` or `mode: "custom"` — both go through the same
`resolvedSamplingParams` value in the formula above.

### 6.3 Model override

`assignment.modelOverride` (§5.1), when present and valid, replaces
`getDefaultModels().llm` for **that task's** resolution only — every other
task keeps using the app-wide default. Validity check (§11's failure-mode
table): the override must still resolve through `getLlmProvider` (a known
provider id) and — for a cloud provider — the app must still have a stored
key for it (`getApiKeyForProvider`, reused from `providers.ts:65`); for
`local-llm` the endpoint URL must still be configured
(`providers.ts`/`registry.ts:219-226`'s existing check). An override that
fails either check falls back to the app-wide default with a `warn`-level
log, mirroring the diarization spec's "build/packaging gap degrades
silently" philosophy (`meeting-diarization.md` §10) — never a hard failure
of the dictation/remix/meeting pipeline over a stale model override.

### 6.4 Reasoning is a task-profile concern, layered underneath mode selection

`reasoningEnabled` (§3.2) is **not** part of `resolvedSamplingParams` — it's
a separate signal threaded alongside it, because it has to reach three
different destinations depending on provider (§7.3):

- `local-llm`: seeds `chat_template_kwargs.enable_thinking` **before** the
  mode-selected params (§6.1) are spread on top — so `mode: "auto"` still
  sends `{chat_template_kwargs: {enable_thinking: <task default>}}` (closing
  the gap noted in §2.2: previously "no preset" meant "send nothing," which
  let the server's *own* default (observed: thinking-on, per
  `sampling-dialog.tsx:36-39`'s comment) silently override a task like
  `cleanup` that wants reasoning off). A `preset`/`custom` mode's own
  `chat_template_kwargs.enable_thinking`, if present, overrides this seed —
  same "verbatim wins" rule as every other field once a mode is selected.
- Groq (native SDK): `groqCleanupProviderOptions` becomes task-aware (§7.3),
  reading `reasoningEnabled` directly — never sourced from a preset, since
  `chat_template_kwargs` isn't a Groq concept at all.
- Every other cloud provider: no reasoning knob exists in the AI SDK's
  common surface today, so `reasoningEnabled` is a no-op there — documented
  in §7.2's table, not silently dropped without a trace (`cloudPartial`
  flag, §7.5, still fires if a preset also tried to set a reasoning-shaped
  key that got denylisted).

---

## 7. Provider mapping

### 7.1 Transport tiers, not "cloud vs. local"

The advisor review surfaced the actual fault line: it's not which
providers are "cloud," it's **which providers this codebase already
installs a rewritable-body `fetch` on**. Today that's exactly one entry in
`PROVIDERS` (`registry.ts:144-251`): `local-llm` (`:213-250`). Every other
entry — including `openrouter` and `vercel`, which are *also*
OpenAI-compatible chat-completions endpoints under the hood
(`registry.ts:187-212`) — calls `createOpenAI({apiKey, baseURL})` with
**no** custom `fetch`, so verbatim passthrough was never reachable for them
and stays not reachable. This is not a regression this spec introduces; it's
the existing shape, now named explicitly instead of accidental.

| Tier | Providers | What a preset's `params` becomes |
|---|---|---|
| **Verbatim** | `local-llm` only | The full resolved sampling object (mode-selected, §6.1), minus denylisted keys (§7.4), merged onto the wire body by `createSamplingFetch` exactly as today (`registry.ts:129-142`), just now fed by the resolver (§8.3) instead of a raw settings read. |
| **Mapped subset** | `openai`, `anthropic`, `google`, `mistral`, `openrouter`, `vercel` | Only `temperature`, `max_tokens` → `maxOutputTokens`, `top_p` → `topP` are pulled out and passed as ordinary `generateText`/`streamText` arguments. Everything else in the preset is dropped with one `log.debug` line naming the dropped keys (§7.5) — **never an error**, per the task brief's explicit requirement. |
| **Mapped subset + reasoning** | `groq` | Same safe subset as above, plus `reasoningEnabled` (§6.4) mapped through the now-task-aware `groqCleanupProviderOptions` (§7.3). Preset-supplied `reasoning_effort`/`chat_template_kwargs` keys are still dropped like any other mapped-subset provider — Groq's reasoning knob is driven by the task profile, not by a preset field, since the preset schema has no Groq-specific vocabulary. |

### 7.2 Safe-subset mapping table

| Preset key | Mapped to | Applies to |
|---|---|---|
| `temperature` | `generateText`/`streamText`'s `temperature` | every mapped-subset provider |
| `max_tokens` | `maxOutputTokens` (after the floor, §6.2) | every mapped-subset provider |
| `top_p` | `topP` | every mapped-subset provider |
| everything else (`top_k`, `min_p`, `presence_penalty`, `repetition_penalty`, `chat_template_kwargs`, `stream`, arbitrary custom keys) | dropped, `log.debug`, `cloudPartial: true` | every mapped-subset provider |

`presence_penalty` is deliberately **not** mapped even though
`generateText` accepts a `presencePenalty` argument — the two starter
presets set it to meaningfully different values (`0.0` vs `1.5`, §4.2) as
part of a *local-server* sampling recipe; mapping it into every cloud call
would change cloud generation behavior in a way this spec's "never touch
cloud semantics beyond the three universally-safe keys" framing doesn't
license. Flagged in §12 as a narrow, deliberate under-mapping — easy to
widen later if it proves too conservative, hard to walk back if it turns out
too aggressive.

### 7.3 `groqCleanupProviderOptions` becomes task-aware

```ts
// registry.ts — signature change
export function groqCleanupProviderOptions(
  modelId: string,
  reasoningEnabled: boolean,
): { groq: GroqLanguageModelOptions } | undefined {
  const shortId = stripGroqPrefix(modelId);

  switch (shortId) {
    case "qwen/qwen3-32b":
      return {
        groq: {
          reasoningFormat: "hidden",
          reasoningEffort: reasoningEnabled ? "medium" : "none",
        },
      };
    case "openai/gpt-oss-20b":
    case "openai/gpt-oss-120b":
      return {
        groq: {
          reasoningFormat: "hidden",
          reasoningEffort: reasoningEnabled ? "medium" : "low",
        },
      };
    default:
      return undefined;
  }
}
```

**Correction (this spec originally collapsed both families to one
`reasoningEnabled ? "medium" : "none"` branch, contradicting §2.1's own
grounding):** the `false` branch must stay **per-family** —
`qwen/qwen3-32b` keeps `"none"`, `openai/gpt-oss-{20b,120b}` keeps `"low"` —
otherwise shipping this profile alone (§3.2's "no day-one behavior change"
claim) silently downgrades gpt-oss's reasoning effort from `"low"` to
`"none"` for every one of the four v1 tasks (all default
`reasoningEnabled: false`), for every existing gpt-oss user, with no UI
interaction and no changelog-worthy intent behind it — exactly the kind of
regression requirement 6 asks this review to catch. With the per-family
switch above, `reasoningEnabled: false` reproduces today's exact behavior
for both model families, byte for byte. The `true` branch (`"medium"` for
both) is new — reachable only if a future task profile, or a v2 per-task
override, sets `reasoningEnabled: true`; none of the four v1 built-ins do
(§3.2's table), so this branch is unreachable in the v1 shipped defaults and
exists for completeness / the case where a per-task `modelOverride` (§6.3)
points at one of these Groq models for a task whose custom JSON also wants
Groq-native reasoning tuning. `LlmProvider.providerOptions`
(`registry.ts:33`) gains the same second parameter:

```ts
providerOptions?(modelId: string, reasoningEnabled: boolean): CleanupProviderOptions | undefined;
```

Every call site (§8.3) now passes `resolved.reasoningEnabled` through this
call instead of the old zero-arg form.

### 7.4 Denylist — keys a preset can never put on the wire, any tier

```ts
// packages/validations/src/llm-task-profiles.ts
export const LLM_PRESET_DENYLIST_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "n",
]);

// §7.2's mapped-subset table, as a lookup — lives here rather than in
// `apps/server/src/lib/llm/task-profiles.ts` (where `resolveTaskCall`/
// `pickSafeSubset` are defined, §8.3) specifically so the renderer's
// client-side `cloudPartial` computation (§7.5) can import the exact same
// set the server resolver uses. `apps/electron/src/renderer` cannot import
// from `apps/server`; `packages/validations` is already a shared dependency
// of both (§4.1's schemas prove the path exists). Keeping this list
// server-side only, as an earlier draft of this spec did, would force §7.5's
// UI note to hand-duplicate the three key names — a second source of truth
// that drifts the moment §7.2's table changes.
export const SAFE_SUBSET_KEYS = new Set(["temperature", "max_tokens", "top_p"]);
```

Applied at **resolution time** (§8.3), not save time (§4.3 deliberately
validates only "is this valid JSON" — the denylist is a runtime safety net,
not a save-time restriction, so a preset can still be *authored* with
`"stream": false` visibly present, matching the approved payload verbatim,
§4.2). Stripped with one `log.debug` line before the params reach either
tier (§7.1) — this is what makes `stream: false` in both starter presets
harmless despite `remix-agent.ts` being a `streamText` call (§2 row 3):
without this denylist, a verbatim-tier preset assignment on the `remix` task
would force `stream: false` onto a `streamText` request, which the AI
SDK/oMLX would either reject or silently degrade — exactly the failure mode
the advisor review flagged. `response_format` is deliberately **not**
denylisted (§12 open question — Enhance's strict-JSON requirement is
currently enforced by prompt engineering + tolerant parsing,
`enhance.ts:132-146`, not by `response_format`, so no built-in preset needs
it and no shipped task profile is at risk from it; a user-authored preset
that sets it on a task expecting prose output is a residual, documented
risk, not solved here).

### 7.5 `cloudPartial` and the UI note

`ResolvedTaskCall.cloudPartial` (§8.3's return shape) is `true` when: the
resolved provider is mapped-subset tier (§7.1) **and** the resolved sampling
params (mode `preset` or `custom` only — `auto` never sets this, there's
nothing to drop) contain at least one key outside `SAFE_SUBSET_KEYS`
(`{temperature, max_tokens, top_p}`, §7.4). The task row (§9.2) shows a
small "cloud model: partial" note next to the assignment chip whenever the
*currently effective* model for that task (override or app default) is
mapped-subset tier and the assignment isn't `auto` — computed client-side
from the same rule (importing `SAFE_SUBSET_KEYS`/`LLM_PRESET_DENYLIST_KEYS`
from `packages/validations`, §7.4, the only place both the server resolver
and the renderer can share them from), not round-tripped from a server
call, so it updates the instant the user changes the assignment or the
model.

---

## 8. Resolver and call-site wiring

### 8.1 `createChatModel` gains task context

```ts
// providers.ts
export async function createChatModel(
  providerId: string,
  modelId: string,
  taskContext?: { task: LlmTaskId; sampling: Record<string, unknown> },
): Promise<LanguageModel> {
  const provider = getLlmProvider(providerId);
  if (!provider) throw new Error(`Unsupported provider: ${providerId}`);
  const isLocal = provider.local ?? LOCAL_PROVIDERS.has(providerId);
  const apiKey = isLocal ? "local" : getApiKeyForProvider(providerId);
  if (!apiKey) throw new Error(`No API key configured for provider: ${providerId}`);
  return provider.createModel(getChatModelId(providerId, modelId), apiKey, taskContext);
}
```

`LlmProvider.createModel` (`registry.ts:28-31`) gains the same optional
third parameter. **Only `local-llm`'s entry reads it** — every other
`PROVIDERS` entry's `createModel` signature is untouched except for the
added (ignored) parameter, so this is additive, not a rewrite of seven
provider descriptors.

```ts
// registry.ts — local-llm entry, replacing :234-248
createModel: async (modelId, apiKey, taskContext) => {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const db = getDb();
  const urlRow = db.prepare(
    "SELECT value FROM settings WHERE key = 'local_llm_url'",
  ).get() as { value: string } | undefined;
  if (!urlRow?.value) {
    throw new Error(
      "Local LLM endpoint URL not configured. Go to Settings > Models to set it up.",
    );
  }
  const keyRow = db.prepare(
    "SELECT value FROM settings WHERE key = 'local_llm_api_key'",
  ).get() as { value: string } | undefined;
  const baseURL = urlRow.value.replace(/\/v1\/?$/, "");
  const apiKey2 = keyRow?.value || "local";

  // No more direct cleanup_sampling read here — the caller already resolved
  // this task's sampling params (§8.3) and hands them in. A call site that
  // doesn't pass taskContext (there shouldn't be any left after this spec's
  // migration, §10) gets no sampling merge, same as an empty object.
  return createOpenAI({
    apiKey: apiKey2,
    baseURL: `${baseURL}/v1`,
    fetch: createSamplingFetch(taskContext?.sampling ?? {}),
  }).chat(modelId);
},
```

This deletes the `cleanup_sampling`/`parseCleanupSampling` read at the old
`registry.ts:236-239` — the resolver (§8.3) is now the only place that reads
task-scoped sampling settings, for every provider tier alike.

### 8.2 What "auto" `maxOutputTokens` means at each call site

`taskProfile.maxOutputTokens === "auto"` (§3.1) defers to a
**caller-computed** number, because only the caller knows the input:

| Call site | Auto budget computation |
|---|---|
| `cleanup` (`post-process.ts`) | `maxOutputTokensForCleanup(normalizedRawText)` — unchanged from today (`tokens.ts:14-21`). |
| `remix` transform (`remix-transform.ts`) | `maxOutputTokensForCleanup(options.text)` — unchanged. |
| `remix` agent (`remix-agent.ts`) | **New.** No prior budget existed (§2 row 3). Uses a flat, generous constant — `REMIX_AGENT_AUTO_MAX_OUTPUT_TOKENS = 4096` (new export, `remix-agent.ts`) — since a per-step tool-calling response has no single "input length" to scale off the way a one-shot rewrite does; sized to comfortably cover one step's worth of text plus a tool call, not the whole 16-step budget (`REMIX_MAX_STEPS`, `remix-agent.ts:23`). Flagged in §12 as a number worth revisiting once real agent-loop output sizes are observed, same posture as `meeting-diarization.md` §11's timeout formula. |
| `meetingEnhance` (`enhance.ts`) | `Math.ceil(chunkTokens * 1.3) + 200` — unchanged (`enhance.ts:184`). |

`meetingSummarize`'s profile isn't `"auto"` at all (§3.2 — flat `4096`), so
it has no entry here.

### 8.3 `resolveTaskCall`

```ts
// apps/server/src/lib/llm/task-profiles.ts
export interface ResolvedTaskCall {
  provider: string;
  modelId: string;
  temperature: number;
  maxOutputTokens: number;
  reasoningEnabled: boolean;
  samplingParams: Record<string, unknown>; // {} in "auto" mode
  timeoutMs: number;
  cloudPartial: boolean; // §7.5
}

export async function resolveTaskCall(
  taskId: LlmTaskId,
  opts: { autoMaxOutputTokens?: number } = {},
): Promise<ResolvedTaskCall> {
  const profile = LLM_TASK_PROFILES[taskId];
  // `readSetting` (`apps/server/src/lib/db.ts:67`), not the route-local
  // `readStoredSetting` in `routes/settings.ts` — that helper is unexported
  // and lives in the routes layer, which `lib/llm/task-profiles.ts` cannot
  // reach without an upward, routes-depending-on-lib-depending-on-routes
  // import. `readSetting` is the existing exported equivalent already used
  // by `post-process.ts` for the same kind of read.
  const assignments = parseLlmTaskAssignments(
    readSetting("llm_task_assignments"),
  );
  const assignment = assignments[taskId] ?? { mode: "auto" };

  const defaults = getDefaultModels();
  const fallback = defaults.llm;
  if (!fallback) {
    throw new Error("No AI model is set up yet. Pick one in Settings > Models.");
  }
  const { provider, modelId } = resolveEffectiveModel(assignment, fallback); // §6.3

  const rawParams = resolveModeParams(assignment); // §6.1 — {} for "auto"
  const strippedParams = stripDenylistedKeys(rawParams); // §7.4, logs drops

  const isLocal = getLlmProvider(provider)?.local ?? provider === "local-llm";
  // §6.4 — the reasoning seed and a mode-selected `chat_template_kwargs` are
  // merged key-by-key, not swapped wholesale: a plain `...strippedParams`
  // spread after the seed would let a preset/custom object that touches
  // `chat_template_kwargs` for an unrelated reason (e.g. only
  // `reasoning_effort`) silently replace the *entire* nested object and
  // drop `enable_thinking` — reopening the exact gap this profile is meant
  // to close (§2.2, §6.4's own stated goal). The task's `enable_thinking`
  // seed only yields when the mode-selected params set that key themselves.
  const { chat_template_kwargs: presetChatTemplateKwargs, ...restParams } =
    strippedParams;
  const samplingParams = isLocal
    ? {
        ...restParams,
        chat_template_kwargs: {
          enable_thinking: profile.reasoningEnabled,
          ...(typeof presetChatTemplateKwargs === "object" &&
          presetChatTemplateKwargs !== null
            ? presetChatTemplateKwargs
            : {}),
        },
      }
    : {}; // mapped-subset providers never get the verbatim object at all

  const safeSubset = isLocal ? {} : pickSafeSubset(strippedParams); // §7.2
  const cloudPartial =
    !isLocal &&
    Object.keys(strippedParams).some((k) => !SAFE_SUBSET_KEYS.has(k));

  // profile.maxOutputTokens === "auto" requires the caller to supply
  // `opts.autoMaxOutputTokens` (every §8.5 call site for an "auto"-profiled
  // task does) — fail loudly on a missing budget instead of falling through
  // to an unsafe cast that could put the literal string "auto" into the
  // Math.max below and silently resolve to NaN.
  const taskBudget =
    profile.maxOutputTokens === "auto"
      ? (opts.autoMaxOutputTokens ??
        (() => {
          throw new Error(
            `resolveTaskCall("${taskId}"): task profile is "auto" but no autoMaxOutputTokens was supplied`,
          );
        })())
      : profile.maxOutputTokens;
  const presetFloor = typeof strippedParams.max_tokens === "number"
    ? strippedParams.max_tokens
    : 0;

  return {
    provider,
    modelId,
    temperature:
      typeof safeSubset.temperature === "number"
        ? safeSubset.temperature
        : profile.temperature,
    maxOutputTokens: Math.max(taskBudget, presetFloor), // §6.2
    reasoningEnabled: profile.reasoningEnabled,
    samplingParams: isLocal ? samplingParams : {},
    timeoutMs: profile.timeoutMs,
    cloudPartial,
  };
}
```

(`resolveEffectiveModel`, `resolveModeParams`, `stripDenylistedKeys`,
`pickSafeSubset` are straightforward helpers implied by §6/§7 above —
omitted here for length, spec'd fully in code review, not duplicated in
prose. `SAFE_SUBSET_KEYS` is **not** one of those — it is defined in
`packages/validations/src/llm-task-profiles.ts` alongside
`LLM_PRESET_DENYLIST_KEYS`, §7.4, §15 — see the note there; it is imported
here, not declared here.)

### 8.4 Timeout — net-new plumbing at all four call sites

No call site passes an abort signal today (`grep -rn "AbortSignal" apps/server/src/lib/{post-process,remix-transform,remix-agent,meetings/llm-call}.ts` returns nothing — confirmed by inspection, §2's table). The established pattern elsewhere in this codebase for "combine a caller's signal with a timeout" is `AbortSignal.any([signal, AbortSignal.timeout(ms)])`
(`mlx-asr/runtime.ts:251`, `whisper/models.ts:335`) — reused verbatim:

- `post-process.ts`, `remix-transform.ts`, `llm-call.ts` — no caller signal
  exists today, so just `signal: AbortSignal.timeout(resolved.timeoutMs)`.
- `remix-agent.ts` — **does** already receive `abortSignal` from the HTTP
  request (`remix-agent.ts:58`, threaded from `routes/remix/agent.ts:39`'s
  `c.req.raw.signal`). Combine: `AbortSignal.any([abortSignal,
  AbortSignal.timeout(resolved.timeoutMs)].filter(Boolean))` so an explicit
  client cancel (tab closed, user hit stop) still wins immediately, and the
  task-profile timeout is a ceiling on top, not a replacement.

`postProcess` (`packages/stt/src/post-process.ts`) already accepts `signal`
(`:57-58`) and threads it into `generateText` (`:133`) — **no
`@openstyle/stt` package change is needed for cleanup/Summarize/Enhance**,
only the call sites need to start passing it. `remix-transform.ts`'s direct
`generateText` call (§2 row 2, not through `postProcess`) needs one new
`abortSignal: AbortSignal.timeout(resolved.timeoutMs)` line.

### 8.5 Per-call-site diff summary

| File | Change |
|---|---|
| `post-process.ts:228-247` | `resolveTaskCall("cleanup", {autoMaxOutputTokens: maxOutputTokensForCleanup(normalizedRawText)})` replaces the inline `createChatModel(llm.provider, llm.model_id)` + ad hoc `providerOptions` lookup. `temperature`/`maxOutputTokens`/`signal` now passed explicitly into `cleanupWithModel(...)` instead of relying on `@openstyle/stt`'s hardcoded default. |
| `remix-transform.ts:97-107` | Same pattern, task `"remix"`, `autoMaxOutputTokens: maxOutputTokensForCleanup(options.text)`. |
| `remix-agent.ts:64-75` | Task `"remix"`, `autoMaxOutputTokens: REMIX_AGENT_AUTO_MAX_OUTPUT_TOKENS` (§8.2). `maxOutputTokens`/`temperature`/combined `abortSignal` now passed into `streamText`, previously absent entirely. |
| `llm-call.ts:51-105` (`resolveDefaultChatCall`) | Gains a required `taskId: "meetingSummarize" \| "meetingEnhance"` parameter (its two current callers, `summarize.ts:183-184` and `enhance.ts:149-150`, each pass their own literal). Replaces its own `createChatModel`/`getLlmProvider(...).providerOptions?.()` calls with `resolveTaskCall`. `request.maxOutputTokens` (the caller-computed per-call-site number, §8.2) is passed through as `opts.autoMaxOutputTokens` unconditionally — for `meetingSummarize` this is a no-op against the flat `4096` (§3.2), it only matters for `meetingEnhance`'s per-chunk number. |
| `summarize.ts:183-184`, `enhance.ts:149-150` | One-line change each: `resolveDefaultChatCall({..., taskId: "meetingSummarize"})` / `{..., taskId: "meetingEnhance"}`. |
| `registry.ts:19-36, 46-70, 144-251` | §7.3, §8.1 above. |
| `providers.ts:57-70` | §8.1 above. |

---

## 9. UI — Models page

### 9.1 Placement

`apps/electron/src/renderer/src/pages/models/index.tsx` (`:200-238`): a new
`<TaskProfilesSection>` renders between `<PairCard>` and `<KeysSection>` —
"below the two hero cards" per the approved brief, where "the two hero
cards" is `PairCard`'s two `PairSide` panels (Voice / Cleanup,
`pair-card.tsx:42-83`), already rendered as one bordered `<section>`.

New file: `apps/electron/src/renderer/src/pages/models/task-profiles-section.tsx`.

Gate: `advancedMode` only — **not** `&& m.defaultLlm?.provider ===
"local-llm"` (unlike the old `showSampling`, `index.tsx:185`). Every task
row is meaningful regardless of the effective provider (§7's mapped-subset
tier still does something for cloud models); hiding the whole section for
cloud users would contradict requirement 4's own "cloud model: partial"
note, which has nothing to attach to if the section never renders.

### 9.2 Row anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│  WHERE YOUR MODELS WORK                                          │  ← Eyebrow (page-chrome.tsx:62-72)
├─────────────────────────────────────────────────────────────────┤
│  Cleanup                                    [Auto]            ⌄ │  ← collapsed
│  Fast rewrites while you dictate.                                │
├─────────────────────────────────────────────────────────────────┤
│  Remix                                      [Qwen fast]       ⌄ │
│  Quick edits and the canvas agent.                                │
├─────────────────────────────────────────────────────────────────┤
│  Meeting summary                            [Customized]      ⌃ │  ← expanded
│  Long-form summaries after a meeting ends.                       │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Params  [ Auto | Qwen thinking | Qwen fast | Custom… ]    │ │  ← SegmentedControl
│  │  Model    [ Use default (Qwen 3 32B via Groq) ▾ ]          │ │  ← optional override
│  │                                                    [Reset] │ │
│  └───────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Meeting enhance                            [Auto]            ⌄ │
│  Cleans up transcript text after a meeting.                      │
└─────────────────────────────────────────────────────────────────┘
```

Container: same `border-border bg-card overflow-hidden rounded-lg border`
shell as `KeysSection`'s list (`index.tsx:450`), rows divided by
`border-border border-t` like `KeyRow` (`index.tsx:487-491`) — this section
reuses the existing list-row idiom on this page rather than inventing a new
one.

Collapsed row (per task, always visible):
- Task display name (i18n, §11) + one-line description (i18n) — both static
  strings per task, not derived from the profile object.
- Assignment chip, right-aligned:
  - `mode: "auto"` → plain `text-muted-foreground` text, "Auto" (no chip
    background — this is the steady-state / no-op case, it shouldn't visually
    compete with an actual override).
  - `mode: "preset"` → `Badge variant="secondary"` (`badge.tsx:12-13`,
    existing neutral-fill variant) showing the preset's name.
  - `mode: "custom"` → a **new** `Badge` variant, `passive`, using
    `--accent-passive-tint`/`--accent-passive-ink` (`design-system.md`
    Token sheet) — background `var(--accent-passive-tint)`, text
    `var(--accent-passive-ink)`. **This is a new consumer of the
    accent-passive fence** (`design-system.md`'s Accent discipline section
    currently scopes it to "selected-nav state and identity/diarization-
    speaker chips" only) — approved as part of this spec's brief, but
    `design-system.md` should get a one-line addendum recording the third
    consumer, matching how that doc already tracks every fence exception
    explicitly rather than letting them accumulate silently.
  - Chevron (`⌄`/`⌃`) toggles expand, same disclosure idiom as any
    accordion row on this page.
- A "cloud model: partial" note (§7.5) — small `text-muted-foreground`
  text, next to the chip — appears only when `mode !== "auto"` and the
  currently effective model (override or default) is mapped-subset tier
  and at least one non-safe key would be dropped.

Expanded row (per task, on click):
- **`Params` segmented control** (`SegmentedControl`,
  `components/ui/segmented-control.tsx`): options `Auto`, one option per
  merged preset (`BUILTIN_LLM_PRESETS` then the user's stored presets, in
  that order, §4.2), `Custom…`. Selecting a preset option sets `mode:
  "preset", presetId`. Selecting `Custom…` sets `mode: "custom"` and opens
  the raw JSON editor (§9.4) inline, scoped to this task, seeded from the
  task's existing `params` (or `{}` for a first-time switch to Custom).
  `wrap` prop (`segmented-control.tsx:26,49-51`) enabled — task rows are
  narrower than the full page width and a 4+ option control (2 built-ins +
  N user presets + Custom) needs to wrap on a narrow window, same reasoning
  the existing `wrap` prop documents for 4-option controls.
- **Model override dropdown** (optional row): a `Select` populated from
  `m.configured.filter(c => c.type === "llm")` (reusing the existing
  `ConfiguredModel` list `use-models.ts` already loads, `use-models.ts:161-165`),
  plus a first "Use default (`<current default's display name>`)" option
  that clears `modelOverride`. Not a new models-list fetch — this is the
  same list `KeysSection`/`PairCard` already render from.
- **Reset**: `variant="ghost"`, same as `CleanupSamplingDialog`'s existing
  "Reset to defaults" (`sampling-dialog.tsx:263-265`, being deleted, §10) —
  sets the task's assignment back to `{ mode: "auto" }` (clears
  `presetId`/`params`/`modelOverride` in one write). Does **not** delete any
  named preset (a preset is a separate, reusable object, §4 — resetting one
  task's assignment to it never touches the preset itself or any other
  task's assignment to that same preset).

### 9.3 Preset management — separate from per-task assignment

A `Custom…` selection anywhere is scoped to that one task. **Naming and
saving a reusable preset** is a separate, smaller flow reached from the
`Params` segmented control's own affordance (a `+ New preset` trailing
option, or a "Save as preset…" action surfaced once a task is in Custom
mode with non-empty params — implementation detail left to the screen pass,
not load-bearing for this spec) that opens the same raw-JSON editor (§9.4)
with an added **Name** field, writes to `llm_parameter_presets` (§4), and
then (optionally) reassigns the current task to `mode: "preset"` pointing
at the newly saved id — a convenience so "I was tweaking Custom JSON and
now want to reuse it" doesn't require two trips.

Editing an **existing user preset** (not a built-in, §4.2) is reached the
same way, from any task currently assigned to it, or from a (deferred to
the screen pass, not blocking) standalone "Manage presets" list if one
proves necessary once real usage shows whether task-scoped access is
enough. Editing a preset that multiple tasks are assigned to changes it for
all of them at once — this is the expected, documented behavior of a named,
shared preset (not a per-task copy), same as any shared-config object
elsewhere in this app.

### 9.4 The raw JSON editor — replaces `CleanupSamplingDialog` entirely

New file: `apps/electron/src/renderer/src/pages/models/param-json-editor.tsx`,
one component (`ParamJsonEditor`) reused for both "edit a named preset"
(shows a Name `Input` above the textarea) and "edit this task's Custom JSON"
(no Name field):

```tsx
export function ParamJsonEditor({
  name,        // undefined when editing a task's inline Custom JSON
  onNameChange,
  value,       // Record<string, unknown>
  onChange,    // (next: Record<string, unknown>) => void — only called with valid JSON
  onClose,
  readOnly,    // true for a builtin:* preset (§4.2) — shows "Duplicate to edit" instead of Save
  onDuplicate,
}: { ... }): React.JSX.Element
```

- A single `Textarea` (`components/ui/textarea.tsx`), `className="mono"`,
  seeded with `JSON.stringify(value, null, 2)`.
- No structured controls of any kind — no sliders, no per-field number
  inputs, no switches. This is the deliberate simplification the approved
  brief calls for ("edited via a raw JSON editor... validated-as-JSON
  only"); `CleanupSamplingDialog`'s eleven structured rows (temperature
  slider through "Preserve thinking" switch, `sampling-dialog.tsx:144-259`)
  are not ported forward in any form — a user who wants the same knobs
  types the same keys the dialog used to build for them (§10 covers the
  one-time migration that seeds this for existing users automatically, so
  no one has to reconstruct their current setup by hand).
- On every keystroke: attempt `JSON.parse`. On failure, `aria-invalid` on
  the textarea (existing pattern, `textarea.tsx:9`'s
  `aria-invalid:border-destructive` styling) and Save disabled — never emit
  an invalid value, matching `NumberRow`'s existing clamp-before-emit
  discipline (`sampling-dialog.tsx:363-375`, being deleted but its
  discipline kept). On success, the parsed object must additionally be a
  plain object (§4.3 rule 2) or the same invalid state applies with a
  distinct message ("Must be a JSON object, not a list or a plain value").
- Save is disabled (not hidden) while invalid, plus a one-line inline error
  under the textarea — same visual slot `RowShell`'s hint text used
  (`sampling-dialog.tsx:275-302`, not ported as a component, but the
  "label / control / one-line hint" rhythm is kept for this one control).

### 9.5 The floating cleanup-card link — repointed, not relocated

Per the advisor review: the link is **already** inside the cleanup side of
`PairCard` (`pair-card.tsx:72-79,115,183-192`) — nothing moves. What
changes:

- The prop currently misnamed `warmingAction` on the cleanup `PairSide`
  call (`index.tsx:219-221`) is renamed to `paramsAction` (the MLX-warming
  call on the voice side, `index.tsx:216-218`, keeps `warmingAction` — that
  one really is about warming, unrelated to this spec).
- `onClick` no longer opens `CleanupSamplingDialog` (deleted, §10). It
  scrolls the new `<TaskProfilesSection>` into view and expands the
  `cleanup` row — a `ref` + `expandedTask` bit of state lifted to
  `ModelsPage` (`index.tsx`), passed down to both `PairCard` (to trigger)
  and `TaskProfilesSection` (to receive).
- Gate: `showParams = advancedMode` (drop the `m.defaultLlm?.provider ===
  "local-llm"` clause, §9.1) — the link is now "jump to this task's params,"
  meaningful for any provider, not "open the local-server-only sampling
  dialog."
- Label: i18n key kept as `models.pair.configureSampling`
  ("Sampling parameters") — the approved brief's own wording for this link
  — even though it now opens a different (task-profile) surface than
  before; the words are still accurate (it's still about sampling
  parameters), only the destination changed.

---

## 10. Migration — retiring `cleanup_sampling`, not running two systems

**No two competing param systems ship simultaneously.** On first load of the
Models page after this feature ships (`use-models.ts`'s existing settings
load, `use-models.ts:256` region), a one-time client-side migration runs:

1. Read `cleanup_sampling` (existing setting) via `parseCleanupSampling`
   (`settings.ts:115-125`, **kept** in `@openstyle/validations` purely for
   this one-time read — not used anywhere else post-migration).
2. If it parses to a non-empty object (`Object.keys(parsed).length > 0`):
   - Write it as the `cleanup` task's `mode: "custom"` assignment
     (`llm_task_assignments.cleanup = { mode: "custom", params: parsed }`) —
     preserves the exact prior behavior (§2.2 confirmed `cleanup_sampling`
     applied to every task, but only the `local-llm` provider ever read it,
     and only cleanup had a UI to set it, so "was this actually used for
     Remix/meetings too" is moot for any user who only ever touched the one
     dialog this app exposed).
   - Do **not** also apply it to `remix`/`meetingSummarize`/`meetingEnhance`
     — even though the old blob technically reached those calls too
     (§2.2), no user ever *intentionally* configured it for them (there was
     no UI naming those tasks), so silently carrying it into three more
     tasks the user never saw would be a bigger behavior change than
     leaving them at `Auto`, not a smaller one.
3. Write a sentinel, `llm_task_profiles_migrated_v1: "true"` (new setting
   key, not in `SETTINGS_KEYS` as a task-facing value — internal
   bookkeeping only), so step 1–2 never re-runs and can't clobber a user's
   subsequent edits to the `cleanup` task's assignment. **Correction: there
   is no existing precedent for this one-shot-flag pattern in this
   codebase** — a grep for `migrat` across `apps/server/src` and
   `apps/electron/src` finds no sentinel-flag migration anywhere; this
   spec's original "same pattern as any one-shot migration flag elsewhere in
   this codebase" claim doesn't hold. The codebase's actual convention for
   this exact shape of problem (an old setting key superseded by a new one,
   §5.1's own "new key wins, missing key falls back" precedent) is a
   stateless **read-time** fallback, not a write-once migration — see
   `getLanguagesSetting()` (`apps/server/src/lib/language.ts:43-55`): the
   `languages` row is authoritative when present, an absent row falls back
   to the legacy singular `language` key, computed fresh on every read, no
   flag, nothing to race. §12 open question 6 below expands on why that
   pattern is a better fit here than what steps 1–3 describe.
4. Leave the `cleanup_sampling` row in the settings table untouched (not
   deleted) — dead data, harmless, avoids a destructive `DELETE` in a
   migration path; `registry.ts`'s `local-llm` provider no longer reads it
   (§8.1), so its presence has zero runtime effect going forward.

`CleanupSamplingDialog` (`sampling-dialog.tsx`, 440 lines) is **deleted**
entirely, not kept behind a flag — its structured-form UX is superseded by
§9.4's raw editor per the approved brief, and its only two consumers
(`index.tsx:23,249-256`, the `showSampling` gate) are removed in the same
change that adds `<TaskProfilesSection>`.

`cleanupSamplingSchema`/`parseCleanupSampling`/`DEFAULT_CLEANUP_SAMPLING`/
`CLEANUP_SAMPLING_MAX_TOKENS_LIMIT` (`packages/validations/src/settings.ts:56-107`)
stay in the package (step 1 above depends on them), but the
`routes/settings.ts:205-215` validation branch for the `cleanup_sampling`
key is **removed** — post-migration nothing should be writing to that key
anymore (the UI that used to is deleted), so a stray write attempt should
fail validation the same way an unrecognized-but-unhandled key does today
(falls through to the generic `INSERT ... ON CONFLICT` at `settings.ts:263-266`
with no shape check) rather than being specially accepted.

---

## 11. Failure / degradation matrix

| Failure point | Behavior |
|---|---|
| Malformed JSON typed into the raw editor (§9.4) | Save disabled client-side; never reaches the server. |
| A syntactically-valid-but-malformed preset PUT bypassing the client (direct API call, or a future client bug) | Server rejects with 400 (§5.2) — `llmParameterPresetsSettingSchema`/`llmTaskAssignmentSchema` reject; the stored setting is unchanged (PUT fails atomically, no partial write). |
| A preset referencing a `presetId` that no longer exists (preset deleted after a task was assigned to it) | `resolveModeParams` (§8.3) treats an unresolvable `presetId` as `mode: "auto"` for that resolution only — logged at `warn` — never a thrown error on the hot dictation/remix/meeting path. The stored assignment itself is left as-is (still points at the missing id) so recreating a preset with the same id (not realistic — ids are uuids) or, more realistically, the user re-picking a real option in the UI (which shows the missing id as unresolvable, prompting a re-pick) fixes it going forward; nothing auto-repairs the stored assignment silently. |
| A task's `modelOverride` points at a provider/model the app can no longer serve (key deleted, local endpoint unconfigured) | Falls back to the app-wide default model (§6.3), `warn`-level log naming the task and the stale override. Task still runs. |
| oMLX (or any local-llm server) rejects a verbatim-tier key the denylist (§7.4) didn't catch | Not proactively detected (no test-call button, §1 non-goals). The existing per-call-site error handling takes over exactly as it does for any other model-call failure today: cleanup falls back to the raw transcript (`post-process.ts:259-262`, unchanged), Remix throws a `RemixTransformError` the pill surfaces (`remix-transform.ts:117-119`, unchanged), Summarize/Enhance throw through `resolveDefaultChatCall`'s existing error path (`llm-call.ts:83-87`, unchanged). `traceLlmFetch` (`trace.ts:257-277`, wrapped by `createSamplingFetch`) remains the debugging surface of record — it's "the only place that sees the body exactly as it goes on the wire" per its own existing comment (`registry.ts:124-127`), unchanged by this spec, and is what the real-E2E test plan (§13.3) asserts against. |
| A cloud/native-SDK provider would reject a mapped-subset key | Cannot happen by construction — only `{temperature, max_tokens, top_p}` (§7.2) ever reach a mapped-subset provider's SDK call, and all three are universally-accepted AI SDK arguments across every provider in `PROVIDERS`. |
| Preset count or size caps exceeded (§4.1, 50 presets / 8KB each) | 400 at save time (§5.2), same UX as any other save-validation failure on this page — inline error, no partial write. |
| Every task assignment missing/corrupt (fresh install, or a `llm_task_assignments` row that fails to parse) | `parseLlmTaskAssignments` returns `{}` (§5.1) — every task resolves as `mode: "auto"`, i.e. exactly today's pre-feature behavior. Never a crash, never a blocked dictation/remix/meeting pipeline. |
| Migration (§10) runs twice (race between two windows, or a bug in the sentinel check) | Idempotent by construction as written *if* the sentinel write (step 3) and the assignment write (step 2) aren't atomic — flagged in §12 as needing either a single settings-transaction write or a documented "last write wins, harmless either way since step 2's input (`cleanup_sampling`) is never mutated by this migration" acceptance. |
| **A user with existing `cleanup_sampling` overrides upgrades and dictates without ever opening Settings > Models** (missing from earlier drafts of this spec — genuine gap, not covered by any row above) | §8.1 deletes the server-side `cleanup_sampling` read inside `registry.ts`'s `local-llm.createModel` outright; the *only* thing that restores those params into a live request is §10's client-side migration, gated on a load of the Models page. Today, by contrast, `local-llm.createModel` re-reads `cleanup_sampling` from the DB on every call (`registry.ts:236-239`), regardless of which UI screens were ever opened. So for any user who upgrades and starts dictating before visiting Settings > Models — plausible for anyone who set sampling params once, months ago, and never revisits that page — every `cleanup`/`local-llm` call silently loses its tuned sampling params (falls back to the task profile's bare defaults) for as long as that page stays unvisited: an unbounded regression window, not a bounded one. This is exactly the "breaks current behavior for users who never touch the feature" class of risk and needs either the migration to run somewhere unconditional (a server-side one-time check, run on boot or on first post-upgrade settings read, rather than gated behind one specific renderer page mounting) or the read-time-fallback redesign in §12 open question 6, which removes the gap by construction. |

---

## 12. Open questions (flagged for sign-off, not blocking the spec)

1. **`remix` as one task across two call sites (transform + agent, §2 rows
   2–3) vs. two separate task ids.** This spec merges them because they're
   one user-facing feature with one model choice today (§2's table — both
   already call `getDefaultModels().llm` independently, no shared state).
   The cost: `remix`'s single `timeoutMs`/`maxOutputTokens` profile has to
   serve both a one-shot rewrite and a 16-step tool-calling loop
   (`REMIX_MAX_STEPS`, `remix-agent.ts:23`) reasonably. If real usage shows
   the agent loop needs materially different numbers, splitting into
   `remix` / `remixAgent` is a small, additive follow-up (new task id, new
   registry row, no schema change to presets themselves).
2. **`REMIX_AGENT_AUTO_MAX_OUTPUT_TOKENS = 4096` (§8.2)** and every
   `timeoutMs` in §3.2's table are this spec's proposed numbers, not
   measured ones — same posture as `meeting-diarization.md` §11's
   timeout formula, which explicitly says "tighten this... after a real
   observed [number] exists." Revisit after the real-E2E pass (§13.3)
   produces actual latencies.
3. **`presence_penalty` excluded from the cloud safe subset (§7.2)** while
   `temperature`/`max_tokens`/`top_p` are included — a narrower mapping
   than it could be. Confirm this is the right line, or widen it.
4. **`response_format` not denylisted (§7.4)** — no current built-in preset
   or task needs it, but a user-authored preset could still set it on a
   task expecting prose output. Confirm this residual risk is acceptable
   for v1, or add it to the denylist (cheap, one more entry in
   `LLM_PRESET_DENYLIST_KEYS`) preemptively.
5. **Preset-management entry point (§9.3)** — "+ New preset" inline in the
   segmented control vs. a standalone "Manage presets" list is left as a
   screen-pass call, not fully speccced here, matching how
   `meeting-diarization.md` left some UI wiring (e.g. exact popover
   placement) to its own screen pass. Needs a decision before
   implementation, not before this spec's approval.
6. **`repeat_penalty` (§4.2's built-in presets) vs. `repetition_penalty`
   (every other spelling of this knob in this codebase — the existing
   `cleanupSamplingSchema` field, `packages/validations/src/settings.ts:63`;
   `CleanupSamplingDialog`'s form field, `sampling-dialog.tsx:45,81-83,174-181`;
   the migration-source data any current user's `cleanup_sampling` blob
   already contains).** Both key names ultimately target the same local
   OpenAI-compatible endpoint (§10's migration carries a
   `repetition_penalty`-keyed blob into `cleanup`'s Custom JSON right next
   to `builtin:qwen-fast`/`builtin:qwen-thinking`'s `repeat_penalty`) — if
   the server only recognizes one spelling, the other preset silently
   no-ops that knob rather than erroring (§4.3 rule 5: no key-shape
   validation), so this isn't a save-time or resolution-time bug, but it is
   a real user-facing inconsistency: two presets sitting side-by-side in
   the same segmented control, one of which quietly doesn't do what its
   raw JSON says. This review cannot resolve which spelling oMLX's wire
   API actually accepts from outside this repo — §4.2 states the builtin
   payloads are "copied verbatim from the approved spec, byte for byte,"
   so this is flagged for the approver rather than silently changed to
   match the existing schema's spelling.

   **RESOLVED, 2026-08-27:** user-verified against oMLX's own
   `openapi.json` — the server accepts `repetition_penalty`, not
   `repeat_penalty`. §4.2's amendment note and both built-in presets
   (`packages/validations/src/llm-task-profiles.ts`) now use
   `repetition_penalty`, matching every other spelling of this knob in the
   codebase. Values unchanged.
7. **Migration atomicity, and whether write-once-with-a-sentinel is the
   right shape at all (§10, §11)** — the atomicity question (whether the
   sentinel and the assignment write need one transaction) is low-stakes
   either way, but a bigger question sits underneath it: §10's design
   introduces a real gap this review found (§11's new row) — a user with
   tuned `cleanup_sampling` who dictates before ever opening Settings >
   Models loses those params silently, for as long as that page stays
   unvisited, because §8.1 removes the only other place that read
   `cleanup_sampling`. **Recommendation, not adopted here without
   sign-off:** resolve `cleanup` the same way `getLanguagesSetting()`
   already resolves `languages`/legacy `language`
   (`apps/server/src/lib/language.ts:43-55`) — no sentinel, no one-time
   write. Inside `resolveTaskCall` (§8.3), when `assignments.cleanup` is
   absent, fall back to `parseCleanupSampling(readSetting("cleanup_sampling"))`
   and treat a non-empty result as `{mode: "custom", params: parsed}` for
   that resolution, computed fresh on every call, same as everything else
   §6's opening paragraph already promises. This dissolves the atomicity
   question outright (nothing to race — there's no sentinel and no write),
   closes the silent-loss gap regardless of which UI screens a user ever
   opens, and only costs one extra settings read on the `cleanup` task's
   resolution path (already paying for a settings read there, §8.3). The
   downside: `llm_task_assignments.cleanup` would then need to stay
   distinguishably absent (not written) for a user who hasn't touched the
   new UI, whereas step 2's write-based version can populate it explicitly
   — the UI's "Migrated from your old Sampling parameters" copy (§14,
   `migratedNote`) would need to trigger off "resolved via the
   `cleanup_sampling` fallback" rather than off a stored assignment, a
   real but small change to §9's rendering logic. This is a bigger
   architectural swap than the mechanical fixes elsewhere in this review,
   so it's listed here rather than applied — but §10 as currently written
   should not ship without an explicit answer to the gap in §11's new row,
   whichever fix is chosen.

---

## 13. Test plan

### 13.1 Unit — resolver (`apps/server/tests/llm-task-profiles.test.ts`, new)

- Each of the 4 built-in `LLM_TASK_PROFILES` rows matches §3.2's table
  exactly (regression-pins the "day-one no-op" claim, §3.2).
- `resolveTaskCall("cleanup")` with no assignment → `mode: "auto"` behavior:
  `local-llm` provider gets `{chat_template_kwargs: {enable_thinking:
  false}}` and nothing else; a mapped-subset provider gets `{}`.
- `resolveTaskCall` with `mode: "preset", presetId: "builtin:qwen-thinking"`
  on a `local-llm` model → resolved `samplingParams` contains every key from
  §4.2's payload except `stream` (denylisted, §7.4), plus the
  `enable_thinking` seed is **overridden** by the preset's own
  `chat_template_kwargs.enable_thinking: true` (§6.4's "verbatim wins"
  rule) — assert the final merged `chat_template_kwargs` object exactly.
- Same preset on a mapped-subset provider (e.g. `openai`) → resolved
  `temperature: 1.0`, `maxOutputTokens` reflects the floor (§6.2) against
  the task's own budget, every other key absent, `cloudPartial: true`.
- `max_tokens` floor (§6.2): a preset with `max_tokens: 512` never lowers
  `meetingSummarize`'s resolved budget below `4096`; a preset with
  `max_tokens: 8000` raises it above `4096`.
- Denylist (§7.4): a custom-mode task with `{"stream": true, "model":
  "x", "temperature": 0.5}` resolves with only `temperature` surviving into
  `samplingParams`/the safe subset; `log.debug` called once naming
  `stream`/`model`.
- `modelOverride` pointing at a provider with no stored key → falls back to
  the app default, `warn` logged (§6.3, §11).
- Missing `presetId` (deleted preset) → falls back to `auto` for that
  resolution, `warn` logged (§11).
- `groqCleanupProviderOptions(modelId, reasoningEnabled)` (§7.3): both
  branches for each of the 3 reasoning-capable model ids — critically, the
  `reasoningEnabled: false` branch must assert `"none"` for `qwen/qwen3-32b`
  and `"low"` (not `"none"`) for both `openai/gpt-oss-*` ids, pinning the
  per-family split so a future edit can't re-collapse it to one constant —
  and `undefined` for any other model id regardless of `reasoningEnabled`.

### 13.2 Unit — validation (`apps/server/tests/llm-parameter-presets.test.ts`, new)

- `llmParameterPresetsSettingSchema`: accepts a well-formed 2-preset list;
  rejects a `builtin:`-prefixed `id` (§4.1's regex guard); rejects >50
  presets; rejects a name >60 chars.
- `parseLlmTaskAssignments`: drops an unknown task-id key without rejecting
  the rest of the object (§5.1); returns `{}` on malformed JSON, non-object
  JSON, and missing/empty input (mirrors `parseCleanupSampling`'s existing
  test shape at `cleanup-sampling.test.ts:57-68`, same fallback
  philosophy).
- `PUT /api/settings/llm_parameter_presets` / `llm_task_assignments`: 200 on
  valid bodies, stored verbatim; 400 on malformed JSON, an oversized
  preset's `params`, an out-of-enum `mode` — same test shape as the
  existing `PUT /api/settings/cleanup_sampling` suite
  (`cleanup-sampling.test.ts:239-266`), which this spec's route branch
  (§5.2) directly parallels.

### 13.3 Integration — real oMLX + local LLM (manual, matching `meeting-diarization.md` §12's real-E2E checklist pattern)

Against the user's actual running oMLX server and a real local model:

- [ ] `cleanup` task, `Auto` assignment: dictate a sentence, confirm
      `traceLlmFetch`'s logged body shows `chat_template_kwargs:
      {enable_thinking: false}` and nothing else new, cleanup output
      unchanged from pre-feature behavior.
- [ ] `cleanup` task, assigned to `Qwen thinking`: confirm the logged wire
      body matches §4.2's payload minus `stream`, thinking visibly happens
      (longer latency / a `<think>` block if the server surfaces one), and
      the cleaned output is still correctly extracted (not truncated,
      not polluted with raw chain-of-thought — this is the exact failure
      mode `packages/stt/src/post-process.ts:145-157` already guards, confirm
      it still does under a real thinking-heavy config).
- [ ] `remix` task, assigned to `Qwen fast`: run a quick text remix,
      confirm the wire body carries `presence_penalty: 1.5` and
      `enable_thinking: false`.
- [ ] `remix` agent (canvas-style tool-calling run), same `Qwen fast`
      assignment: confirm `stream: false` from the preset does **not**
      appear on the wire (denylist, §7.4) and the agent loop still streams
      correctly end to end.
- [ ] `meetingSummarize` task, `Custom` JSON with a deliberately small
      `max_tokens` (e.g. `100`): confirm the resolved wire `max_tokens` is
      still `4096` (the floor, §6.2), not `100`.
- [ ] `meetingEnhance` task on a real multi-chunk transcript: confirm each
      chunk's `max_tokens` is still the per-chunk `chunkTokens * 1.3 + 200`
      value floor-raised against whatever preset is assigned, not a flat
      number.
- [ ] Assign a cloud provider (e.g. `groq` or `anthropic`) to any task with
      `Qwen thinking` selected: confirm the call succeeds (never a hard
      error), the UI shows the "cloud model: partial" note (§7.5), and
      (for `groq` specifically) `reasoningEffort` reflects the task's
      `reasoningEnabled`, not the preset's `chat_template_kwargs`.
- [ ] Migration (§10): seed a real pre-feature `cleanup_sampling` value with
      a few real overrides, load the Models page once, confirm the
      `cleanup` task shows `Customized` with those exact values in the raw
      editor, and confirm `remix`/`meetingSummarize`/`meetingEnhance` all
      show `Auto` (not migrated).

---

## 14. i18n keys

New keys, all 8 locale files (`de.json`, `en.json`, `es.json`, `fr.json`,
`it.json`, `ja.json`, `pt.json`, `template.json`), English source shown,
nested under the existing `models` namespace (`en.json:631`) alongside the
existing `models.pair.*` keys (`en.json` region around `:631-640` per the
grep in §research):

```json
"models": {
  "taskProfiles": {
    "eyebrow": "Where your models work",
    "cleanup": { "name": "Cleanup", "desc": "Fast rewrites while you dictate." },
    "remix": { "name": "Remix", "desc": "Quick edits and the canvas agent." },
    "meetingSummarize": { "name": "Meeting summary", "desc": "Long-form summaries after a meeting ends." },
    "meetingEnhance": { "name": "Meeting enhance", "desc": "Cleans up transcript text after a meeting." },
    "assignmentAuto": "Auto",
    "assignmentCustomized": "Customized",
    "cloudPartialNote": "Cloud model: partial",
    "paramsLabel": "Params",
    "customOption": "Custom…",
    "modelOverrideLabel": "Model",
    "modelOverrideDefault": "Use default ({{name}})",
    "reset": "Reset",
    "newPreset": "New preset",
    "savePreset": "Save as preset…",
    "presetNameLabel": "Name",
    "duplicateToEdit": "Duplicate to edit",
    "invalidJson": "Not valid JSON.",
    "notAnObject": "Must be a JSON object, not a list or a plain value.",
    "presetTooLarge": "This preset is too large.",
    "migratedNote": "Migrated from your old Sampling parameters."
  }
}
```

`models.pair.configureSampling` (existing key, `en.json`) is kept unchanged
— still "Sampling parameters" (§9.5).

---

## 15. File inventory

New files:
- `apps/server/src/lib/llm/task-profiles.ts` — `LLM_TASK_PROFILES`,
  `resolveTaskCall`, helpers (§3, §8.3).
- `packages/validations/src/llm-task-profiles.ts` — preset/assignment
  schemas, `BUILTIN_LLM_PRESETS`, denylist, `SAFE_SUBSET_KEYS`,
  id/count/size constants (§4, §5, §7.4). `SAFE_SUBSET_KEYS` lives here
  (not in the server-only `apps/server/src/lib/llm/task-profiles.ts`)
  specifically so the renderer's client-side `cloudPartial` computation
  (§7.5) and the server resolver (§8.3) import the same set instead of two
  independently-maintained copies. Re-exported from
  `packages/validations/src/index.ts`.
- `apps/electron/src/renderer/src/pages/models/task-profiles-section.tsx` —
  `TaskProfilesSection`, row components (§9.1–9.3).
- `apps/electron/src/renderer/src/pages/models/param-json-editor.tsx` —
  `ParamJsonEditor` (§9.4).
- `apps/server/tests/llm-task-profiles.test.ts` (§13.1).
- `apps/server/tests/llm-parameter-presets.test.ts` (§13.2).

Modified files:
- `apps/server/src/lib/llm/registry.ts` — `LlmProvider.createModel`/
  `providerOptions` signatures gain task context (§7.3, §8.1);
  `local-llm` entry stops reading `cleanup_sampling` directly (§8.1);
  `groqCleanupProviderOptions` gains `reasoningEnabled` (§7.3).
- `apps/server/src/lib/providers.ts` — `createChatModel` gains optional
  `taskContext` (§8.1).
- `apps/server/src/lib/post-process.ts:228-247`,
  `apps/server/src/lib/remix-transform.ts:97-107`,
  `apps/server/src/lib/remix-agent.ts:64-75`,
  `apps/server/src/lib/meetings/llm-call.ts:51-105` — call `resolveTaskCall`,
  pass `temperature`/`maxOutputTokens`/`signal`/`providerOptions` explicitly
  (§8.5).
- `apps/server/src/lib/meetings/summarize.ts:183-184`,
  `apps/server/src/lib/meetings/enhance.ts:149-150` — pass `taskId` into
  `resolveDefaultChatCall` (§8.5).
- `apps/server/src/routes/settings.ts` — new `llm_parameter_presets`/
  `llm_task_assignments` validation branches (§5.2); `cleanup_sampling`
  branch removed (§10).
- `apps/electron/src/shared/settings-keys.ts` — `llmParameterPresets:
  "llm_parameter_presets"`, `llmTaskAssignments: "llm_task_assignments"`
  added; `cleanupSampling` entry kept (migration read only, §10).
- `apps/electron/src/renderer/src/pages/models/index.tsx` — mounts
  `<TaskProfilesSection>`, drops `CleanupSamplingDialog`/`samplingOpen`,
  lifts `expandedTask` state for the cleanup-card link (§9.5).
- `apps/electron/src/renderer/src/pages/models/pair-card.tsx` — renames the
  cleanup side's `warmingAction`-shaped prop to `paramsAction` (§9.5).
- `apps/electron/src/renderer/src/pages/models/use-models.ts` — replaces
  `cleanupSampling`/`saveCleanupSampling`/`resetCleanupSampling`
  (`:1,74,114-115,232,256,607-622,684-686`) with task-assignment/preset
  reads+writes against the two new setting keys, plus the one-time
  migration (§10).
- `apps/electron/src/renderer/src/components/ui/badge.tsx` — new `passive`
  variant (§9.2).
- `specs/design-system.md` — one-line addendum recording the accent-passive
  fence's third consumer (§9.2).
- `apps/electron/src/renderer/src/locales/*.json` (7 locales +
  `template.json`) — `models.taskProfiles.*` (§14).
- `packages/stt/src/post-process.ts` — **no change** (already accepts
  `temperature`/`maxOutputTokens`/`providerOptions`/`signal`, §8.4);
  called out here explicitly so the file inventory doesn't imply a change
  that isn't needed.

Deleted files:
- `apps/electron/src/renderer/src/pages/models/sampling-dialog.tsx` (§10).
- `apps/server/tests/cleanup-sampling.test.ts` — superseded by
  `llm-task-profiles.test.ts`/`llm-parameter-presets.test.ts` (§13); the
  `mergeSamplingIntoBody`/`createSamplingFetch` unit coverage it contains
  (`cleanup-sampling.test.ts:128-237`) moves with those functions, which
  are **not** deleted (§8.1's `local-llm` entry still calls
  `createSamplingFetch`, just with resolver-provided params) — so this is a
  rename/split of the test file's contents, not a coverage loss.
