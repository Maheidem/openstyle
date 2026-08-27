# Meeting Speaker Naming — Implementation Spec

USER-APPROVED FEATURE, 2026-08-27. Implementation spec for turning diarized
`Them N` labels into real per-meeting names, with LLM-suggested candidates
and a user-invoked rename/merge UI. Grounded in the codebase as of `main` @
2026-08-27, `SCHEMA_VERSION = 32` (diarization Phase 1 + transcription-quality
Phases A–C all landed). Companion reading:
[`meeting-diarization.md`](meeting-diarization.md) (the `Them N` labels this
spec names), [`meeting-transcription-quality.md`](meeting-transcription-quality.md)
§6 (the Enhance pass this spec rides on), [`design-system.md`](design-system.md)
(accent-passive chip fence). File:line citations below are as read on
2026-08-27 — re-verify before implementing, and see the note on
`llm-task-profiles.md` in §12.

A concurrent workflow is implementing `specs/llm-task-profiles.md`, which
touches the same Enhance call sites this spec extends
(`enhance.ts`/`enhance-prompt.ts`/`llm-call.ts`). §12 spells out the exact
seam so the two land without fighting each other. This document only
specifies — no code in this repo was changed to produce it.

---

> **AMENDMENT — USER SIGN-OFF DECISIONS, 2026-08-27 14:05.** §13's three open
> questions are resolved below. This is a decisions-only pass: every section
> marked **[AMENDED 2026-08-27]** reflects the sign-off; everything else in
> this document is unchanged from the original spec. Summary of the three
> calls:
>
> 1. **Context field: build it.** Reverses §1/§13 point 1's "no new capture
>    field" reading. A new per-meeting free-text `meetings.context` column is
>    in scope for this feature — editable anytime, feeds both the naming
>    prompt (§5.2) and the summarize prompt (new, §9.3). See §3.4, §5.2, §9.3,
>    §7.6, §11, §14.
> 2. **Re-diarize reset: confirmed as specified.** §6.3/§13 point 2's
>    conservative reset (re-diarize or re-transcribe clears
>    `meeting_speakers`) stands as designed — no spec change beyond removing
>    it from the open-questions list.
> 3. **Unlabeled segments: explicit "Unidentified" label, not silent "Them."**
>    Narrows §3.3/§13 point 3: the NULL-label bucket stays non-nameable and
>    read-only as designed, but every rendering site that would otherwise show
>    bare `"Them"` for these segments must instead show a distinct, visually
>    muted "Unidentified" treatment — so it reads as "could not be
>    identified," never as an unnamed participant. See §3.3, §4, §7.2, §7.5,
>    §9.1, §11, §14. This closes the one place the original spec left
>    unlabeled segments indistinguishable from a plain-`"Them"` participant.

---

## 1. What exists today (research)

**Diarization** (`meeting-diarization.md`) already assigns `meeting_segments
.speaker_label` — a locale-neutral numeral ("1", "2", ...) per system-channel
row, first-appearance-ordered, NULL for undiarized rows. Renderer formats it
via i18n key `meetings.themNumbered` (`meetings.tsx:1259-1263`). A standalone
`POST /api/meetings/:id/diarize` (`routes/meetings.ts:723-818`) re-runs only
the diarization pass on demand ("Identify speakers" button,
`meetings.tsx:1076-1088`).

**Enhance** (`meeting-transcription-quality.md` §6) already runs an LLM
cleanup pass over the merged transcript and writes
`meeting_segments.enhanced_text` — never `text`. `enhanceMeetingTranscript`
(`apps/server/src/lib/meetings/enhance.ts:158-254`) chunks the transcript by
token budget (`chunkForEnhance`, disjoint segment ids per chunk, no
cross-chunk reduce step) and issues one LLM call per chunk
(`resolveDefaultChatCall`, `llm-call.ts:51-105`) via a strict-JSON contract
built in `enhance-prompt.ts`. `POST /api/meetings/:id/enhance`
(`routes/meetings.ts:869-904`) and an auto-run setting
(`meetingEnhanceAutoRun`, off by default) are the two call sites.

**One load-bearing gap this spec must close first**: the transcript the
Enhance prompt actually sees does **not** distinguish `Them 1` from `Them 2`.
`enhanceMeetingTranscript`'s `withIds` mapping
(`enhance.ts:169-171`) builds each `EnhanceSegment.speaker` from the bare
`MergedSegment.speaker` field (`"Me"` / `"Them"`), never touching
`speakerLabel`:

```ts
// enhance.ts:169-171, current
const withIds: EnhanceSegment[] = segments
  .filter((s) => Boolean(s.id) && s.text.trim().length > 0)
  .map((s) => ({ id: s.id as string, speaker: s.speaker, text: s.text }));
```

`formatEnhanceLine` (`enhance-prompt.ts:49-55`) then renders `[<id>] Them:
<text>` for every system-channel line regardless of speaker. `summarize.ts`'s
`formatSegment` (`summarize.ts:126-128`) has the identical simplification.
Without a fix, point 1 below is not just weak — it's impossible: the model
has no way to know which lines belong to which `Them N`. §5.1 fixes this at
the one call site this spec is responsible for (`enhance.ts`); `summarize.ts`
is addressed separately in §9 as a smaller, optional propagation.

**No meeting-context field exists (as of the original research pass).** The
task brief asks to cross-reference "the meeting context field" —
`meeting-transcription-quality.md` §6.2 already confirmed there is no
`context`/`app_context` column on `meetings` (`schema.ts:756-772`, unchanged
as of this spec's original writing). Two real per-meeting context inputs
existed instead: `meetings.title` (free text, e.g. this investigation's own
test meeting is titled "FTI / Symphony AGS Prototype Build" — genuinely
useful naming evidence) and the global `meeting_summary_instructions` setting
(considered, not used — it's tone guidance for Summarize, not identity
evidence, and folding it in would blur what the naming prompt is actually
allowed to infer from).

**[AMENDED 2026-08-27]** The 2026-08-27 14:05 sign-off overrides this: build
the context field. §3.4 adds `meetings.context`, a per-meeting free-text
column editable anytime from the meeting detail UI, feeding **both** the
naming prompt (§5.2) and the summarize prompt (§9.3) — not `meetings.title`
alone. §13 open question 1 is resolved by this amendment, not left open.

**`meeting_segments` schema** (`schema.ts:775-786`, plus migrations 30/32):
`id, meeting_id, source, idx, start_ms, end_ms, text, status, speaker_label,
enhanced_text`. No `meeting_speakers` table, no name/identity column. This
spec adds one.

**Rendering** (`meetings.tsx`): the `Them N` chip renders in three
independent places that must all be checked for this feature to actually
show up everywhere the task requires:
1. Transcript row label (`meetings.tsx:1257-1264`), styled
   `bg-[var(--accent-passive-tint)] text-[color:var(--accent-passive-ink)]`.
2. `transcriptText` — the plain-text string `CopyButton` copies
   (`meetings.tsx:1021-1032`), built independently of #1 from the same
   `transcript` array.
3. `formatTranscriptMarkdown` (`merge.ts:370-387`), which renders
   `transcript.md` / `transcript-enhanced.md` via `writeTranscriptMarkdown`
   (`routes/meetings.ts:256-270`).

A fourth, weaker site: `summarize.ts`'s `formatSegment` collapses every
system line to bare `"Them"` before it ever reaches the LLM (§9).

---

## 2. Ground rules (restated from the task, load-bearing for every design
choice below)

1. Suggestions are **evidence, never state**. An LLM-proposed name is never
   written to any column the app treats as "the name" — it lives in its own
   `suggested_name`/`suggested_evidence` columns and only ever pre-fills a
   form field a human must explicitly save.
2. Names and merges are **per-meeting**, not global. No people registry.
3. **Raw diarizer labels (`meeting_segments.speaker_label`) are never
   mutated or destroyed** by this feature. Naming and merging are a mapping
   layer on top, resolved at read time.
4. **Merge is reversible.** Unmerge = clear a mapping, not a data-losing
   operation.
5. **Works fully offline.** Naming rides the same LLM plumbing Enhance
   already uses (local or cloud, whatever the user's default model is) — no
   new network dependency.

---

## 3. Data model

### 3.1 New table: `meeting_speakers`

The mapping layer ground rules #3/#4 above fall out of one design choice:
this is a **mapping table**, keyed by the same `(meeting_id, speaker_label)`
pair `meeting_segments` already uses, not a rewrite of anything on the
segments themselves.

```sql
CREATE TABLE IF NOT EXISTS meeting_speakers (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_label TEXT NOT NULL,
  display_name TEXT,
  suggested_name TEXT,
  suggested_evidence TEXT,
  merged_into TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, speaker_label)
)
```

Migration 33 (next after Phase C's 32):

```ts
if (currentVersion < 33) {
  // Meeting speaker naming (specs/meeting-speaker-naming.md): per-meeting
  // name/merge mapping over diarization's speaker_label index. Never
  // touches meeting_segments.speaker_label — a row here is a *mapping*,
  // not a rewrite. display_name is the only column the app treats as "the
  // name"; suggested_name/suggested_evidence are LLM evidence, read only
  // by the naming dialog, never auto-applied. merged_into, when set, is
  // another speaker_label in the same meeting whose display_name/segments
  // this row's segments should be attributed to; NULL = not merged.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_speakers (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      speaker_label TEXT NOT NULL,
      display_name TEXT,
      suggested_name TEXT,
      suggested_evidence TEXT,
      merged_into TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (meeting_id, speaker_label)
    )
  `);
}
```

No index beyond the PK's implicit unique index: a meeting has at most a
handful of distinct speaker labels (§4's real example: 8), so `meeting_id`
as the PK's leading column is already a fully sufficient lookup path.

A row is created lazily — the first time either an LLM suggestion or a user
edit touches a given `(meeting_id, speaker_label)` pair (`INSERT ... ON
CONFLICT DO UPDATE`, §5.3/§6.2). A speaker with segments but no row yet
(never suggested, never touched) is not an error state — it just means
"unnamed, unmerged," identical in effect to a row that exists with every
column NULL except the PK and `updated_at`.

### 3.2 Merge semantics — depth is always ≤ 1, enforced by auto-flattening

`merged_into` points at another `speaker_label` in the **same meeting**.
Depth is capped at exactly one hop, enforced at write time rather than by
rejecting deeper requests (§6.2's `PATCH` handler):

- **Self-merge** (`mergedInto === label`) is rejected, 400.
- **Merging into an already-merged target**: resolved transparently — if the
  requested target `T` itself has `merged_into = R`, the write uses `R`
  (`T`'s own root) instead of `T`. No error, no manual "unmerge first" dance
  — the end state ("this label's segments render under `R`'s identity") is
  what the user meant either way.
- **Merging a label that already has other labels merged into it**:
  resolved by cascading — every row currently pointing `merged_into = label`
  is rewritten to point at the new target directly (`UPDATE meeting_speakers
  SET merged_into = ? WHERE meeting_id = ? AND merged_into = ?`), in the same
  transaction as the row's own update. This keeps the invariant "no chain
  longer than one hop" true for the whole table at all times, with no
  UI-visible error for what is, from the user's point of view, an entirely
  reasonable "actually these three are all the same person" sequence of
  clicks in any order.

`display_name` is **not** cleared when a row gains a `merged_into` — it's
independent, orthogonal state, kept so that unmerging later restores
whatever name (confirmed or suggested) this label had on its own, per ground
rule #4. A merged-away row's own `display_name` simply isn't consulted for
display while `merged_into` is set (§4 resolves through the merge before
reading a name).

### 3.3 The NULL-label bucket is not a nameable row

A meeting can have system segments with `speaker_label IS NULL` — either
diarization never ran, or specific segments fell through §7 of the
diarization spec's assignment algorithm (no overlapping/nearby diarizer
segment). These segments are **not** a coherent speaker identity: two NULL
segments are not guaranteed to be the same person, they're just noise the
diarizer couldn't attribute to anyone. Giving them a nameable row would
misrepresent scattered, unrelated fragments as one person.

**Decision**: NULL-label segments get **no row** in `meeting_speakers` and
are not offered a name/merge affordance. They remain visible, though — the
naming dialog (§7) shows an informational, non-interactive count ("N
segments couldn't be matched to a speaker") so the gap is never a silent
surprise, matching this codebase's house style everywhere else diarization
degrades (`meeting-diarization.md` §10's whole table is built on "never
silent"). This was flagged for sign-off in §13 rather than treated as an
oversight, because the alternative (fabricating a "Them (unlabeled)" bucket a
user could name) would let someone assign a real name to a collection of
unrelated interjections. That alternative is rejected; **v1 stays
non-nameable**, per the 2026-08-27 14:05 sign-off.

**[AMENDED 2026-08-27] Rendering: an explicit "Unidentified" label, not bare
"Them."** The sign-off narrows how these segments render everywhere they were
previously going to fall back to plain `"Them"` (with no numeral, since
there's no `speaker_label` to number). Rendering a NULL-label system segment
as indistinguishable bare `"Them"` reads as "an unnamed but real
participant" — exactly the ambiguity ground rule #1's spirit exists to avoid,
just applied to identity rather than to naming. The decision: every site that
renders a `"Them"` segment with `speakerLabel == null` must instead render a
distinct, visually muted **"Unidentified"** chip (i18n key
`meetings.speakerUnidentified`, §11) — so a reader can tell at a glance
"the diarizer couldn't attribute this line to anyone" apart from "this is a
real, still-unnamed speaker." This applies to the three-plus-one rendering
sites §1 already inventoried (transcript row, `transcriptText`,
`formatTranscriptMarkdown`, and `summarize.ts`'s `formatSegment`) — see §4
and §9.1 for the concrete change at each site, and §7.2/§7.5 for the chip's
visual treatment. The naming dialog's existing informational, read-only count
(above) is unchanged by this — "Unidentified" is a rendering label for the
segments themselves, the dialog's count is a separate summary of the same
bucket; both stay non-interactive/non-nameable in v1.

### 3.4 **[AMENDED 2026-08-27]** New column: `meetings.context`

Per the sign-off's point 1, a per-meeting free-text context field is in scope
for this feature. It is **not** part of `meeting_speakers` — it belongs on
`meetings` itself (one value per meeting, not per speaker), alongside the
existing `title` column (`schema.ts:759-772`):

```sql
ALTER TABLE meetings ADD COLUMN context TEXT;
```

Folded into the same migration 33 this spec already adds (§3.1) — one
migration, two independent additions, both gated on `currentVersion < 33`:

```ts
if (currentVersion < 33) {
  // ...existing meeting_speakers CREATE TABLE (§3.1)...

  // Meeting Speaker Naming (specs/meeting-speaker-naming.md §3.4, amended
  // 2026-08-27 sign-off point 1): free-text per-meeting context, editable
  // anytime from the meeting detail UI. Feeds both the name-suggestion
  // prompt (§5.2) and the summarize prompt (§9.3) as optional evidence —
  // never required, never validated against transcript content. NULL by
  // default; unset is the common case and must produce a byte-identical
  // prompt to a meeting with no context (§5.2, §9.3).
  db.exec(`ALTER TABLE meetings ADD COLUMN context TEXT`);
}
```

No length cap enforced at the schema layer (SQLite `TEXT` is unbounded); the
API layer caps it (§6.4 below) the same way `title`/`display_name` are
capped elsewhere in this spec, to keep it a "small unobtrusive field" per the
sign-off's own framing, not a second transcript.

---

## 4. Resolution — where a segment's effective name comes from

One function, `resolveSpeakerNames(meetingId, segments)`, called from
`loadMergedTranscript` (`routes/meetings.ts:176-197`, the one function every
consumer — transcript UI, Enhance input, Summarize input, markdown export —
already goes through) as a **post-process pass after** `mergeTranscript(...)`
returns, not a change to `mergeTranscript` itself. Keeping `merge.ts` pure
means every existing `meeting-merge.test.ts` assertion about
`mergeTranscript`'s own contract (drift, hallucination filter, repeat
collapse, dedup) stays untouched — this pass runs strictly after, on the
already-built `MergedSegment[]`.

```ts
// New: apps/server/src/lib/meetings/speaker-names.ts
export interface SpeakerMapRow {
  speakerLabel: string;
  displayName: string | null;
  mergedInto: string | null;
}

/**
 * Mutates `segments` in place: for each system-channel segment with a
 * speaker_label, resolves any merge (one hop — merged_into targets are
 * never themselves merged, §3.2) to an effective label, and — only when
 * that effective label has a confirmed display_name — attaches it as
 * `speakerName`. `suggested_name` is never read here: suggestions are
 * dialog-only data (ground rule #1), never fed into rendering.
 *
 * The merge target does NOT need its own `meeting_speakers` row to be a
 * valid target — §3.1's rows are lazy, and the common real case is exactly
 * "merge a singleton into a speaker nobody has named or suggested yet."
 * Resolving against `row.mergedInto` (a label string) rather than against
 * `byLabel.get(row.mergedInto)` (a row that may not exist) is what makes
 * that case work: a missing row means "this label exists, unnamed," never
 * "this merge doesn't apply."
 */
export function resolveSpeakerNames(
  segments: MergedSegment[],
  rows: SpeakerMapRow[],
): void {
  const byLabel = new Map(rows.map((r) => [r.speakerLabel, r]));
  for (const seg of segments) {
    if (seg.speaker !== "Them" || !seg.speakerLabel) continue;
    const row = byLabel.get(seg.speakerLabel);
    const effectiveLabel = row?.mergedInto ?? seg.speakerLabel;
    seg.speakerLabel = effectiveLabel; // collapses merged clusters to one
                                        // visible label, even when neither
                                        // side has ever been named
    const name = byLabel.get(effectiveLabel)?.displayName;
    if (name) seg.speakerName = name;
  }
}
```

`loadMergedTranscript` gains one query (`SELECT speaker_label, display_name,
merged_into FROM meeting_speakers WHERE meeting_id = ?`) and one call to
`resolveSpeakerNames` after `mergeTranscript(...)` returns, before the result
is returned to callers.

**Why remapping `speakerLabel` itself (not just adding `speakerName`) is
correct here, not a violation of §3's "never mutate" rule**: §3's ground rule
is about the persisted `meeting_segments.speaker_label` column, never touched
by this pass. `MergedSegment.speakerLabel` is an ephemeral, freshly-computed
read-time value — nothing persists it — so collapsing it to the merge target
here is exactly what makes "merge spurious singleton clusters into another
speaker" (task point 2) actually show up as one label in the transcript, the
copy-to-clipboard text, and the markdown export, all for free, since all
three already key off this same field (§1's inventory).

`MergedSegment`/`TranscriptSegment` (`merge.ts:14-53`) each gain one new
optional field, same extend-don't-widen precedent `speakerLabel` and
`enhancedText` already set:

```ts
/** Confirmed display name for this segment's resolved speaker identity
 *  (specs/meeting-speaker-naming.md), following any merge. Undefined when
 *  unnamed — renderer falls back to "Them {{speakerLabel}}" exactly as
 *  before. Never populated from a suggestion — ground rule: suggestions
 *  are never auto-applied. */
speakerName?: string;
```

(`TranscriptSegment` gets the field for interface symmetry with
`MergedSegment`, but nothing ever sets it there — `resolveSpeakerNames` runs
after `mergeTranscript`, only ever touching `MergedSegment`s.)

**`formatTranscriptMarkdown`** (`merge.ts:370-387`) gains one line — prefer
`speakerName` over the numbered fallback, same pattern already used for
`useEnhanced ? (s.enhancedText ?? s.text) : s.text`:

```ts
const label =
  s.speaker === "Them"
    ? (s.speakerName ?? (s.speakerLabel ? `Them ${s.speakerLabel}` : "Unidentified"))
    : s.speaker;
```

**[AMENDED 2026-08-27]** The fallback for a `"Them"` segment with no
`speakerLabel` changes from bare `"Them"` to `"Unidentified"` — the §3.3
sign-off amendment applied at this site. `transcript.md`/`transcript-
enhanced.md` are English-only literals regardless of app locale (§11), so
this is the literal string `"Unidentified"`, not an i18n lookup, matching how
`"Me"`/`"Them"` are already unlocalized in markdown exports.

This single change fixes markdown export, and — because `writeTranscriptMarkdown`
is the only writer of `transcript.md`/`transcript-enhanced.md` — every export
consumer downstream of it, with no separate touchpoint.

**Renderer** (`meetings.tsx`): both label sites (transcript row
`:1257-1264`, `transcriptText` builder `:1021-1032`) get the identical
one-line change, `seg.speakerName ?? (existing themNumbered/them ternary)`
— both read from the same `transcript` array element, so this is one pattern
applied twice, not two designs. **[AMENDED 2026-08-27]** As with the markdown
site above, the branch of that ternary that previously rendered plain `"Them"`
(no `speakerLabel`) now renders the i18n key `meetings.speakerUnidentified`
("Unidentified") instead, styled as a distinct, visually muted chip — see
§7.5 for the exact treatment and why it must not reuse the accent-passive
`"Them N"` chip style.

---

## 5. Enhance contract extension (name suggestions)

### 5.1 Prerequisite fix — thread the numbered label into the LLM's view

Before any naming instruction can work, the transcript the model actually
sees must distinguish `Them 1` from `Them 2` (§1's gap). `enhance.ts:169-171`
changes from a bare-`speaker` copy to the same numbered-label formatting the
renderer and markdown export already use:

```ts
const withIds: EnhanceSegment[] = segments
  .filter((s) => Boolean(s.id) && s.text.trim().length > 0)
  .map((s) => ({
    id: s.id as string,
    speaker:
      s.speaker === "Them"
        ? (s.speakerName ?? (s.speakerLabel ? `Them ${s.speakerLabel}` : "Them"))
        : s.speaker,
    text: s.text,
  }));
```

Two effects, both desired: (a) the model can now tell speakers apart at all
(prerequisite for §5.2), and (b) once a name is confirmed, later Enhance runs
show the model the real name instead of a number — free improvement to
Enhance's own correction quality for named meetings, not just an enabler for
naming. The existing `labelPrefix` strip logic
(`enhance.ts:219-222`, `${original.speaker}: `) needs no change — it already
strips whatever string `original.speaker` holds, numbered or named alike.

### 5.2 Prompt — new optional block in `buildEnhanceSystemPrompt`

`enhance-prompt.ts`'s `buildEnhanceSystemPrompt` gains **three** new
parameters **[AMENDED 2026-08-27: was two — `meetingContext` added by the
sign-off]**, appended (same "extend the signature, don't restructure the
call" precedent as `mergeTranscript`'s fourth `vocabTerms` param):

```ts
export function buildEnhanceSystemPrompt(
  language: string | undefined,
  vocabTerms: string[],
  speakerLabels: string[],     // NEW — distinct "Them N" numerals visible
                                //        in this chunk's transcript; [] when
                                //        the meeting has no diarization
  meetingTitle: string | undefined, // NEW — meetings.title, may name a person
  meetingContext: string | undefined, // NEW [AMENDED 2026-08-27] — meetings.context,
                                       // free-text set by the user (§3.4), may
                                       // name participants or give role/company
                                       // context the transcript alone doesn't
): string {
  // ...existing language/vocab blocks unchanged...
  const speakerBlock = buildSpeakerSuggestionBlock(speakerLabels, meetingTitle, meetingContext);
  return `${...existing intro...}${languageLine}${vocabBlock}${speakerBlock}

${OUTPUT_CONTRACT_BLOCK}`;
}
```

New block, only emitted when `speakerLabels.length > 0` (a meeting with no
diarization gets a byte-identical prompt to today — zero behavior change for
the common case where diarization is off). **[AMENDED 2026-08-27]** The
`meetingContext` line is independently gated on the field being non-empty,
so a meeting with diarization but no context text still gets the
pre-amendment prompt shape (title line only):

```ts
function buildSpeakerSuggestionBlock(
  speakerLabels: string[],
  meetingTitle: string | undefined,
  meetingContext: string | undefined, // NEW [AMENDED 2026-08-27]
): string {
  if (speakerLabels.length === 0) return "";
  const labelList = speakerLabels.map((n) => `Them ${n}`).join(", ");
  const titleLine = meetingTitle
    ? ` The meeting is titled "${meetingTitle}", which may itself name a participant.`
    : "";
  // [AMENDED 2026-08-27] — meetings.context, user-authored, may name
  // participants directly ("call with Ana from Acme") or give role/company
  // context that makes a transcript-only name guess safer. Same trust
  // level as the title line: evidence, not instruction — the "Do not guess
  // a name with no textual support" rule two lines down still governs.
  const contextLine = meetingContext?.trim()
    ? ` Additional context for this meeting, provided by the user: "${meetingContext.trim()}"`
    : "";
  return `

This transcript has diarized speaker labels for the other participant(s): ${labelList}. Alongside your text corrections, try to identify a real name for each label using ONLY evidence inside the transcript: how "Me" addresses them directly, how a speaker introduces or refers to themselves, a name mentioned near a label's lines.${titleLine}${contextLine} Do not guess a name with no textual support.

Add a top-level "speakers" object to your JSON response, alongside your text corrections (not nested inside them):

{"speakers": {"<label number, e.g. \\"2\\">": {"name": "<proposed name>", "evidence": "<one short phrase citing what supports this>"}}}

Rules:
- Only include a label if you found real textual evidence — never invent a plausible-sounding name with no support.
- Use exactly the label numbers listed above (e.g. "2" for "Them 2"); never a label not listed.
- Omit "speakers" entirely, or return {}, if you have no confident evidence for any label.
- This is a suggestion, never a correction: do not write a name into the segment-text corrections themselves.`;
}
```

The last rule is a deliberate defensive line against a specific failure
mode: without it, a model could "helpfully" rewrite `[id] Them 2: hey`
into `[id] Them 2: hey, this is Ana` as a "correction" — that would put an
unconfirmed name directly into `enhanced_text`, violating ground rule #1 by
a side door. §8's failure table calls this out explicitly.

### 5.3 Parse, validate, reconcile across chunks

`enhanceMeetingTranscript` (`enhance.ts:158-254`) gains a `meetingTitle:
string | undefined` parameter and, **[AMENDED 2026-08-27]** immediately after
it, a `meetingContext: string | undefined` parameter (both before `options`,
positional, matching `language`/`vocabTerms`'s existing style) and derives
the real label set
from the **structured** `speakerLabel` field on the input `segments` —
**not** by re-parsing `withIds[].speaker`'s formatted display string (§5.1
made that string `s.speakerName ?? "Them {{n}}"`, so a speaker who already
has a confirmed name renders as e.g. `"Ana"` there, not `"Them 3"` — parsing
it back with a `Them (\d+)` regex would silently drop that speaker from both
the prompt's label list and the phantom-label allowlist, and would falsely
match a user who happened to name someone literally "Them 5"):

```ts
const speakerLabels = [
  ...new Set(
    segments
      .filter((s) => s.speaker === "Them" && s.speakerLabel && s.id && s.text.trim())
      .map((s) => s.speakerLabel as string),
  ),
];
```

(Filtered the same way `withIds` is, so this is exactly "the labels actually
visible to the LLM in this call" — just read off the structured field
instead of the formatted one.)

`buildEnhanceSystemPrompt(language, vocabTerms, speakerLabels, meetingTitle,
meetingContext)` **[AMENDED 2026-08-27: fifth argument added]** replaces
today's three-argument call. Inside the existing per-chunk loop
(`enhance.ts:178-233`), after `extractJsonObject` succeeds — the existing
correction loop (`Object.entries(parsed)`, `enhance.ts:208-232`) is
**unaffected by construction**: a top-level `"speakers"` key's value is an
object, so `typeof text !== "string"` already skips it, no change needed
there. A new block, gated on `speakerLabels.length > 0`, reads
`parsed.speakers`:

```ts
if (speakerLabels.length > 0) {
  const block = parsed.speakers;
  if (block && typeof block === "object" && !Array.isArray(block)) {
    for (const [label, entry] of Object.entries(block as Record<string, unknown>)) {
      if (!speakerLabels.includes(label)) continue; // phantom label — §8
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as Record<string, unknown>).name;
      if (typeof name !== "string" || !name.trim()) continue;
      const cleanName = name.trim().slice(0, 80);
      const evidenceRaw = (entry as Record<string, unknown>).evidence;
      const cleanEvidence =
        typeof evidenceRaw === "string" ? evidenceRaw.trim().slice(0, 240) : "";
      const existing = nameProposals.get(label);
      if (!existing) {
        nameProposals.set(label, { name: cleanName, evidence: cleanEvidence, chunkIndex });
      } else if (existing.name.toLowerCase() !== cleanName.toLowerCase()) {
        // Cross-chunk conflict on the same label — earlier chunk wins,
        // deterministic, no scoring heuristic (same "stable, no randomness"
        // posture as meeting-diarization.md §7's tie-break rule).
        log.debug(
          `meeting ${meetingId}: chunk ${chunkIndex} suggested "${cleanName}" for Them ${label}, keeping chunk ${existing.chunkIndex}'s "${existing.name}"`,
        );
      }
      // Same name from a later chunk: no-op — already recorded.
    }
  } else if (block !== undefined) {
    log.debug(`meeting ${meetingId}: chunk ${chunkIndex}'s 'speakers' block was malformed, ignoring`);
  }
}
```

`nameProposals: Map<string, { name: string; evidence: string; chunkIndex:
number }>` is declared alongside the existing `corrections` map. **Why
first-chunk-wins is the whole reconcile rule, and why that's sufficient for
v1**: for the overwhelming majority of meetings, the full merged transcript
(mic + system, all segments) fits in one Enhance chunk — `chunkForEnhance`'s
`DEFAULT_ENHANCE_CONTEXT_BUDGET_TOKENS = 6000` only splits when a meeting is
long enough to exceed that, at which point no reconciliation ever triggers,
every label's suggestion comes from exactly one chunk. When a meeting
**does** split, this spec accepts a real, documented limitation: each
chunk's speaker-naming quality is bounded by what's visible in that chunk's
own token window; a speaker only identifiable by combining evidence spread
across chunks 1 and 4 may get no suggestion, or a weaker one, until a real
cross-chunk aggregation pass exists. That's out of scope here (§10) — this
spec rides Enhance's existing map-only architecture rather than building a
second map-reduce pipeline.

**Persist**, after the chunk loop, mirroring the existing corrections
transaction (`enhance.ts:235-251`) — a separate `BEGIN`/`COMMIT` block, since
a name-suggestion write failure must never roll back already-committed text
corrections or vice versa (independent failure domains):

```ts
if (nameProposals.size > 0) {
  const db = getDb();
  const now = Date.now();
  const upsert = db.prepare(`
    INSERT INTO meeting_speakers
      (meeting_id, speaker_label, suggested_name, suggested_evidence, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(meeting_id, speaker_label) DO UPDATE SET
      suggested_name = excluded.suggested_name,
      suggested_evidence = excluded.suggested_evidence,
      updated_at = excluded.updated_at
  `);
  db.exec("BEGIN");
  try {
    for (const [label, p] of nameProposals) {
      upsert.run(meetingId, label, p.name, p.evidence, now);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
```

The `ON CONFLICT DO UPDATE` clause only ever writes `suggested_name` /
`suggested_evidence` / `updated_at` — it never touches `display_name` or
`merged_into`, so **a confirmed name is never overwritten by a fresh
suggestion**; the UI's display-name-wins-over-suggestion rule (§4) makes the
suggestion columns inert for an already-named row regardless, but not
touching them at the SQL layer too means an unmerge/unname later still finds
the (now possibly stale, but harmless) suggestion sitting there — never a
correctness issue, since suggestions are never read for rendering.

`EnhanceMeetingResult` gains `speakerSuggestions: number` (`nameProposals
.size`) alongside the existing `correctedCount`.

### 5.4 Route + call-site wiring

`POST /:id/enhance` (`routes/meetings.ts:869-904`) passes `row.title ??
undefined` as the `meetingTitle` argument and, **[AMENDED 2026-08-27]**
`row.context ?? undefined` as the new `meetingContext` argument, and returns
`speakerSuggestions` in its JSON body. The auto-run call site inside
`runTranscribeJob` (`meeting-transcription-quality.md` §6.5,
`routes/meetings.ts:421-431`) does the same, using the `title`/`context`
already available on the meeting row loaded there. Both call sites already
have the meeting row loaded — this is a threading change, not a new query
(the row's `SELECT *` already returns the new `context` column once §3.4's
migration lands).

---

## 6. API routes for names/merges

### 6.1 `GET /api/meetings/:id/speakers`

One call powers the whole dialog (§7) — no per-row round-trip.

```ts
interface SpeakerRow {
  label: string;                  // "1".."N"
  segmentCount: number;
  quote: string | null;           // longest segment's text, ≤140 chars
  displayName: string | null;
  suggestedName: string | null;
  suggestedEvidence: string | null;
  mergedInto: string | null;      // another `label` in this same response
}
interface SpeakersResponse {
  speakers: SpeakerRow[];         // one per distinct non-null speaker_label
                                   // with ≥1 system segment
  unlabeledCount: number;         // system segments with speaker_label NULL
}
```

Handler: 404 if the meeting doesn't exist. Otherwise, one query per input:

```sql
SELECT speaker_label AS label, COUNT(*) AS segmentCount,
       -- longest segment's (enhanced-if-present) text as the characteristic
       -- quote — readable, no LLM call needed for this
       (SELECT COALESCE(enhanced_text, text) FROM meeting_segments s2
        WHERE s2.meeting_id = meeting_segments.meeting_id
          AND s2.source = 'system' AND s2.speaker_label = meeting_segments.speaker_label
        ORDER BY LENGTH(COALESCE(enhanced_text, text)) DESC LIMIT 1) AS quote
FROM meeting_segments
WHERE meeting_id = ? AND source = 'system' AND speaker_label IS NOT NULL
GROUP BY speaker_label;

SELECT COUNT(*) FROM meeting_segments
WHERE meeting_id = ? AND source = 'system' AND speaker_label IS NULL;

SELECT speaker_label, display_name, suggested_name, suggested_evidence, merged_into
FROM meeting_speakers WHERE meeting_id = ?;
```

merged in memory (label list left-joined against the `meeting_speakers` map,
same shape `resolveSpeakerNames` (§4) already builds). A label with system
segments but no `meeting_speakers` row renders with every optional field
`null` — the lazy-row design from §3.1.

### 6.2 `PATCH /api/meetings/:id/speakers/:label`

Same partial-update idiom as the existing `PATCH /api/meetings/:id`
(`meeting-transcription-quality.md` §3.2.5, `routes/meetings.ts`'s
`renameSchema`) — only the fields present in the body change.

```ts
const speakerPatchSchema = z.object({
  displayName: z.string().trim().min(1).max(80).nullable().optional(),
  mergedInto: z.string().trim().min(1).max(16).nullable().optional(),
});
```

1. 404 if the meeting doesn't exist.
2. 400 if the body has neither field (`z.object({}).strict()`-shaped
   emptiness check, or a `refine` requiring at least one key present).
3. 404 if `:label` is not one of the meeting's real, currently-existing
   `speaker_label` values (query the same distinct-label set §6.1 computes)
   — never allow creating a row for a label with zero segments.
4. If `mergedInto` is present and non-null:
   - 400 if `mergedInto === label` (self-merge).
   - 404 if `mergedInto` is not itself one of the meeting's real labels.
   - Resolve `mergedInto` through one hop if the target itself has
     `merged_into` set (§3.2) — use the root, not the literal requested
     target.
   - In one transaction: cascade any rows currently pointing `merged_into =
     label` to the new resolved target (§3.2), then upsert `:label`'s own row
     with the resolved `merged_into`.
5. If `mergedInto` is present and explicitly `null` — unmerge: upsert with
   `merged_into = NULL`. No cascade needed (nothing pointed at this row
   changes; only this row's own outgoing edge is cleared).
6. If `displayName` is present (string or `null`) — upsert `display_name`
   accordingly. `null` explicitly un-names (ground rule #4's reversibility
   applied to naming, not just merging).
7. On success: `UPDATE ... SET updated_at = ?` (or the `INSERT` path sets
   it), then — if the meeting has an `audio_dir` — call
   `writeTranscriptMarkdown(id, audioDir)` so `transcript.md`/
   `transcript-enhanced.md` never drift from the DB (same lesson
   `meeting-transcription-quality.md` §6.4 point 8 and
   `meeting-diarization.md` §14 step 9 already learned for their own routes
   — every route that changes what renders must call this). Response:
   `{ ok: true }`; the client re-fetches §6.1's `GET` rather than the server
   returning a partial row — the response set is small (≤10 rows), and this
   matches the `invalidate()`-after-every-action pattern already used
   throughout `meetings.tsx` (§7.3) instead of hand-rolling an optimistic
   merge of a partial response.

### 6.3 Interaction with re-diarize and re-transcribe

Both existing routes can invalidate a name/merge mapping that was built
against a specific diarization run's label assignment — this is the same
class of gap `meeting-diarization.md` §14 finding (a) already documented for
`speaker_label` itself, one layer up.

- **`POST /:id/transcribe`** (`routes/meetings.ts:610-634`) already
  `DELETE`s `meeting_segments` wholesale on every re-run. This spec adds one
  line right beside the existing delete:

  ```ts
  db.prepare("DELETE FROM meeting_segments WHERE meeting_id = ?").run(id);
  db.prepare("DELETE FROM meeting_speakers WHERE meeting_id = ?").run(id); // NEW
  ```

  A fresh transcription run means fresh segment ids and (if diarization runs
  again) a fresh clustering — label "3" from the old run has no guaranteed
  relationship to label "3" from the new one. Keeping the old mapping around
  would silently misattribute a confirmed name to a different, unrelated
  voice. This mirrors the already-accepted, already-documented loss of
  `speaker_label` itself on the same code path
  (`meeting-diarization.md` §14's "Non-goals" section keeps that gap
  deliberately) — this spec's addition is symmetric with that prior art, not
  a new kind of loss.

- **`POST /:id/diarize`** (standalone "Identify speakers" re-run,
  `routes/meetings.ts:723-818`) does **not** delete segments — it only
  `UPDATE`s `speaker_label` in place. Whether label "3" means the same real
  person before and after a second diarizer run depends on the underlying
  clustering being stable across runs, which nothing in
  `meeting-diarization.md` guarantees. **Decision: treat this the same as
  re-transcribe for the naming layer** — on a successful `runDiarizationPass`
  inside this route (after step "labels just committed," before the
  response), also `DELETE FROM meeting_speakers WHERE meeting_id = ?`. This
  is the conservative, fail-closed choice (never let a stale mapping silently
  misattribute a name) over betting on clustering stability that isn't
  measured or guaranteed anywhere in this codebase yet. This tradeoff was
  raised as an open question in §13 and **confirmed as specified** by the
  2026-08-27 14:05 sign-off (point 2) — build the reset exactly as designed
  here, §7.4's confirmation dialog is accepted as sufficient mitigation for
  v1. A cheaper v1.5 alternative (majority-overlap re-matching of old labels
  to new ones, the same technique the diarization assignment algorithm
  itself already uses) stays noted in §10's non-goals, not built now.

  The route's JSON response gains `mappingReset: boolean` — `true` whenever
  the meeting had at least one `meeting_speakers` row before this run (so the
  UI can show a specific, non-generic warning instead of silently discarding
  a user's naming work). `POST /:id/diarize` should also **warn before
  running**, not just report after: the "Identify speakers" button (§7.4) gets
  a confirmation step when the meeting already has any confirmed name/merge,
  same pattern as the existing delete-meeting `AlertDialog`
  (`meetings.tsx:1316-1334`).

### 6.4 **[AMENDED 2026-08-27]** Editing `meetings.context`

No new route — `meetings.context` is edited through the existing `PATCH
/api/meetings/:id` (`routes/meetings.ts:551`, `renameSchema`), the same
partial-update endpoint that already handles `title` and `language`. This
keeps "editable anytime" true with the least new surface, and matches the
sign-off's framing of context as a small field on the meeting, not a
speaker-naming-specific concept.

`renameSchema` gains a third optional field:

```ts
const renameSchema = z
  .object({
    title: z.string().trim().min(1).max(512).optional(),
    language: z.string().trim().min(2).max(8).nullable().optional(),
    // NEW (specs/meeting-speaker-naming.md §3.4/§6.4, 2026-08-27 sign-off
    // point 1): free-text context, feeds the naming prompt (§5.2) and the
    // summarize prompt (§9.3). Unlike title, empty string is meaningful
    // (explicitly clear the field) — trimmed but not `min(1)`-constrained.
    context: z.string().trim().max(2000).nullable().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined || v.language !== undefined || v.context !== undefined,
    { message: "Provide title, language, or context" },
  );
```

The handler's existing `sets`/`values` UPDATE-builder pattern
(`routes/meetings.ts:551-560`) gets one more `if (context !== undefined)`
branch, identical shape to the `title` branch, writing `NULL` when `context`
is `null` (explicit clear) and the trimmed string otherwise. No
`writeTranscriptMarkdown` call needed here — unlike a speaker `PATCH` (§6.2
point 7), `context` never appears in `transcript.md`/`transcript-
enhanced.md` (§9.1), so there's nothing on disk for this edit to desync.

2000-char cap chosen to keep this a "small unobtrusive field" (per the
sign-off's own framing) rather than a second transcript pasted in — generous
enough for a few sentences of pre-meeting notes or attendee context, not a
document.

### 6.5 Failure modes not yet covered above

See §8's full table.

---

## 7. UI

### 7.1 Placement and gating

New button, "Speakers," in the actions row next to "Identify speakers" and
"Enhance" (`meetings.tsx:1076-1103`), same `hasTranscript` gate, same
`disabled={busy !== null}` pattern. Uses a distinct icon from "Identify
speakers"'s `Users` — `UserCog` (lucide-react, already available in this
dependency) — so the two actions ("run diarization" vs. "manage names") read
as clearly different operations at a glance.

```tsx
{hasTranscript && (
  <Button
    variant="outline"
    size="sm"
    onClick={() => setSpeakersOpen(true)}
  >
    <UserCog data-icon="inline-start" />
    {t("meetings.speakers")}
  </Button>
)}
```

No extra fetch gates visibility — the dialog's own empty state (§7.2) handles
"no diarization has ever run for this meeting" gracefully, matching how
`hasTranscript` alone already gates "Identify speakers"/"Enhance" without a
pre-check.

### 7.2 Dialog anatomy

`Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`
from `components/ui/dialog.tsx` (already used elsewhere in this codebase,
e.g. the retired `CleanupSamplingDialog`) — richer, list-based content fits
`Dialog`'s larger surface better than the small `Popover` used for
`DiarizationSettingsPopover` (`meetings.tsx:756-832`).

```
┌──────────────────────────────────────────────────────────────┐
│  Speakers                                                  ×  │
│  Confirm names or merge duplicate clusters. Never applied     │
│  automatically — you choose what to save.                     │
├──────────────────────────────────────────────────────────────┤
│  Them 3                                    24 segments        │
│  "yeah so the sandbox rollout is basically…"                  │
│  ┌─────────────────────────────┐  ┌─────────────────────┐    │
│  │ Ana                  [Suggested]│  │ Merge into…      ▾│    │
│  └─────────────────────────────┘  └─────────────────────┘    │
├──────────────────────────────────────────────────────────────┤
│  Them 8                                     1 segment         │
│  "right right"                                                │
│  ┌─────────────────────────────┐  ┌─────────────────────┐    │
│  │ (unnamed)                       │  │ Not merged        ▾│    │
│  └─────────────────────────────┘  └─────────────────────┘    │
│  Also suggested "Ana" for Them 3 — merge these?     [Merge]   │
├──────────────────────────────────────────────────────────────┤
│  ⓘ 14 segments couldn't be matched to a speaker and stay      │
│    labeled Unidentified.                                       │
├──────────────────────────────────────────────────────────────┤
│                                                        [Done]  │
└──────────────────────────────────────────────────────────────┘
```

**[AMENDED 2026-08-27]** The footer's wording changes from "...stay labeled
\"Them\"" to "...stay labeled Unidentified," matching §3.3/§9.1's rendering
amendment — the dialog's own copy must not contradict what the transcript
view actually shows for this bucket.

Row anatomy, per non-merged-away label (rows already merged into another
label still get their own row, so unmerge is reachable — they render with a
"Merged into Them N" state instead of the merge `Select`, plus an "Unmerge"
action):

- Header: `Them {label}` + segment count (`meetings.speakerSegments`, `{{n}}
  segments`, no plural forms — matching `meetings.retryFailed`'s existing
  `{{n}}` convention, this codebase has no `_plural`/`_one` i18n keys
  anywhere).
- Characteristic quote, truncated, muted text.
- Name `Input`, pre-filled with `displayName ?? suggestedName ?? ""`.
  - **Suggested-but-unconfirmed state** (value equals `suggestedName`,
    `displayName` is still null): dashed border on the input
    (`border-dashed`) + a `Badge variant="secondary"` reading
    `meetings.speakerSuggested` ("Suggested") immediately after it, filled
    with `bg-[var(--accent-passive-tint)] text-[color:var(--accent-passive-ink)]`
    — the one place design-system.md's "accent-passive chips for suggested
    names" guidance actually applies (§7.5 explains why this is deliberately
    **not** the main transcript chip). Editing the field, or clicking Save
    while it still holds the suggested value, both count as an explicit user
    confirmation (ground rule #1 requires a human action, not that the human
    retype an unchanged value) — either path calls the same `PATCH` with
    `displayName` set.
  - A row with no suggestion and no name shows a plain placeholder,
    `meetings.speakerNamePlaceholder` ("Unnamed").
- Merge `Select`: `meetings.speakerMergeNone` ("Not merged") plus one option
  per **other** label in this meeting (rendered as `Them {label}` or its
  confirmed name if one exists) plus `meetings.speakerMergeInto` as the
  select's own label. Selecting a target immediately `PATCH`es
  `{ mergedInto: label }`; selecting "Not merged" on an already-merged row
  `PATCH`es `{ mergedInto: null }`.
- **Merge-hint banner** (task's "two labels suggested the same name" case,
  §8): computed client-side from the already-loaded `speakers` list — any
  two unmerged rows whose **effective** name (`displayName ?? suggestedName`)
  matches, case-insensitively, after trim. Comparing the effective name
  rather than `suggestedName` alone matters once one of a duplicate pair
  gets confirmed: without this, confirming "Ana" on `Them 3` would make the
  hint vanish for the still-unnamed `Them 8` that also suggested "Ana,"
  right when the hint is most actionable. Rendered as a one-line note under
  **both** rows,
  `meetings.speakerMergeHint` ("Also suggested \"{{name}}\" for Them {{other}}
  — merge these?") with an inline `[Merge]` button that fires the same
  `PATCH { mergedInto: other }` the `Select` would. Never automatic — this is
  the "handle explicitly" the task asked for, surfaced as an affordance, not
  a silent auto-merge (would violate ground rule #1's spirit even though it's
  about merging rather than naming — this codebase's whole feature-set
  treats "the LLM proposed it" as strictly advisory).
- Footer note for `unlabeledCount > 0`: `meetings.speakerUnlabeledNote`,
  informational only, no input (§3.3). **[AMENDED 2026-08-27]** Copy updated
  to name the rendering label directly: `"{{n}} segments couldn't be matched
  to a speaker and stay labeled Unidentified."` (was "...labeled \"Them\"" —
  §11).
- If the meeting has never been diarized (`speakers.length === 0 &&
  unlabeledCount === 0` — i.e. no system segments carry any label state at
  all because diarization never ran) — empty state pointing at "Identify
  speakers" instead of an empty list.

### 7.3 Save wiring

The `GET /speakers` query (a small dedicated `useQuery`, keyed
`queryKeys.meetings.speakers(id)` — new key alongside `detail`/`transcript`,
`query.ts:39-44`) lives at `MeetingDetailView` level, not inside the dialog
component — §7.4's re-diarize confirmation needs its data whether or not the
dialog is currently open, so the dialog is a **consumer** of this query, not
its owner.

Each field's `PATCH` reuses the existing `runAction`/`invalidate` pattern
(`meetings.tsx:906-938`) scoped to the dialog: on success, re-fetch §6.1's
`GET` **and** invalidate `queryKeys.meetings.transcript(id)` so
the main transcript view picks up the new `speakerName`/collapsed
`speakerLabel` the moment the dialog closes, without a manual page refresh —
same reasoning `identifySpeakers`'s explicit transcript-invalidate call
already documents (`meetings.tsx:978-984`).

### 7.4 Re-diarize confirmation

"Identify speakers" (`identifySpeakers`, `meetings.tsx:969-985`) gains a
guard: if the currently-loaded `speakers` data (§7.3's query, kept warm
whenever the detail view is open, not just while the dialog is) has any row
with a `displayName` or `mergedInto` set, clicking the button opens an
`AlertDialog` confirmation (`meetings.speakerResetOnRediarizeTitle`/`Desc`,
same component/pattern as the existing delete-meeting confirmation) before
firing the `POST /:id/diarize` call — because §6.3 makes that call
name-destructive. No guard when there's nothing to lose (the common case,
first-ever diarization run).

### 7.5 Why the main transcript chip is unchanged for suggestions — and the new "Unidentified" chip

The existing chip style (`bg-[var(--accent-passive-tint)]
text-[color:var(--accent-passive-ink)]`, `meetings.tsx:1250-1255`) is reused
as-is for a **confirmed** name — a real identity deserves the full
accent-passive treatment the design system already reserves for it. A
suggested-but-unconfirmed name never reaches the main transcript at all
(§4's `resolveSpeakerNames` only reads `displayName`), so there's no risk of
a suggestion visually reading as confirmed in the one place a user might
skim past it without opening the dialog — the exact collision the design
system's own "accent-passive chips for suggested names" phrasing could be
misread as licensing, and isn't.

**[AMENDED 2026-08-27]** A third, distinct chip state is added for the §3.3
Unidentified bucket, and it must **not** reuse either of the above: not the
confirmed-name accent-passive treatment (this isn't a name, confirmed or
otherwise), and not the same visual weight as a numbered-but-unnamed `Them N`
chip either (that chip still represents a real, distinguishable speaker
someone could later name; "Unidentified" represents the diarizer's inability
to attribute the line to anyone at all — a materially weaker claim that
should read as visually weaker too). Concretely: a muted/outline chip
variant — `border border-[var(--border-muted)] text-[color:var(--text-muted)]`
(no fill), distinct from both the accent-passive fill used for named/`Them N`
chips and the plain-text `"Me"` label — carrying the i18n text
`meetings.speakerUnidentified` ("Unidentified"). Applied at both renderer
sites (§4): the transcript row chip and the `transcriptText` plain-text
builder (which, having no chip styling to begin with, just emits the literal
string "Unidentified" in place of "Them").

### 7.6 **[AMENDED 2026-08-27]** Context field in the meeting detail UI

Per the sign-off, `meetings.context` is edited directly in the meeting
detail view — a small, unobtrusive field per the design system, not a modal
or a separate dialog. Placement: directly below the existing editable title
(the same inline-edit affordance `title` already has in `MeetingDetailView`,
per `meeting-transcription-quality.md` §3.2.5's language-chip precedent for
"small inline editable field next to the header"), collapsed to a single
muted line showing either the current context text (truncated) or a
placeholder, `meetings.contextPlaceholder` ("Add context for this
meeting…"), expanding to a `Textarea` on focus/click. Saves on blur (debounced
or immediate — same simplicity bar as the existing title-rename inline edit),
firing the §6.4 `PATCH` with `{ context: value.trim() || null }` (empty
string normalizes to `null`, an explicit clear).

This field is visible whenever the meeting detail view is open — unlike the
Speakers dialog, it is **not** gated on `hasTranscript`, since context is
useful to jot down before a meeting has even been transcribed (e.g.
immediately after recording stops) and directly feeds a later Enhance run
(§5.2) whenever it eventually happens. No character counter needed at the
2000-char cap (§6.4) — generous enough that a real user is very unlikely to
approach it; the `Textarea`'s own `maxLength` attribute is sufficient
guardrail.

---

## 8. Failure / degradation matrix

| Condition | Behavior |
|---|---|
| LLM's `speakers` block names a label that doesn't exist in this meeting | Dropped silently, `log.debug`, not persisted — §5.3's `speakerLabels.includes(label)` guard. |
| LLM's `speakers` block is malformed (not an object, wrong shape) | Whole block dropped, `log.debug`; segment-text corrections in the same response are unaffected — independent failure domains. |
| Two labels get the same suggested name | Never auto-merged. Both rows keep their own `suggested_name`; the dialog surfaces an inline "merge these?" hint on both (§7.2). |
| Two chunks propose different names for the same label | Earlier chunk wins, deterministic, `log.debug` on the conflict (§5.3). |
| Meeting has no diarization labels at all | Enhance's system prompt omits the speaker block entirely — byte-identical prompt to pre-this-spec behavior; `GET /speakers` returns `speakers: []`, `unlabeledCount` = all system segments. |
| `PATCH .../speakers/:label` — `:label` has zero segments in this meeting | 404. |
| `PATCH` — `mergedInto === label` | 400 (self-merge). |
| `PATCH` — `mergedInto` targets a nonexistent label | 404. |
| `PATCH` — `mergedInto` targets an already-merged label | Resolved to that label's own root, no error (§3.2/§6.2). |
| `PATCH` — target already has other labels merged into it | Those rows cascade-repoint to the new target, no error (§3.2/§6.2). |
| `PATCH` body has neither `displayName` nor `mergedInto` | 400. |
| `POST /:id/transcribe` re-run | `meeting_speakers` rows for the meeting deleted (§6.3) — same accepted-loss shape as `speaker_label` itself on this path. |
| `POST /:id/diarize` re-run | `meeting_speakers` rows deleted after a successful pass; response includes `mappingReset: true`; UI confirms before firing the request when there was something to lose (§6.3/§7.4). |
| Enhance's LLM tries to write a name into segment text instead of the `speakers` block | Prompt explicitly forbids this (§5.2's last rule); not otherwise detectable/blocked mechanically — a residual, documented risk, not solved by validation. |
| `writeTranscriptMarkdown` fails mid-`PATCH` (e.g. audio dir purged) | Best-effort, matches every other call site (`routes/meetings.ts:256-270`'s own doc comment) — never fails the `PATCH` itself. |

No path in this table throws past its route handler or leaves a meeting in
an inconsistent status because of this feature.

---

## 9. Propagation to Summarize (task requirement: "summary regeneration
hint")

`summarize.ts`'s `formatSegment` (`summarize.ts:126-128`) collapses every
system line to bare `"Them"` before it ever reaches the LLM — a pre-existing
simplification, not introduced by this spec, but one that would otherwise
make "propagate to summary" (task point 2) a no-op even after names/merges
are confirmed. Three changes now, not two — §9.3 is new with the 2026-08-27
sign-off:

### 9.1 `formatSegment` uses the resolved label/name, same expression already
   used at every other site in §4:
   ```ts
   function formatSegment(segment: MergedSegment): string {
     const label =
       segment.speaker === "Them"
         ? (segment.speakerName ??
           (segment.speakerLabel ? `Them ${segment.speakerLabel}` : "Unidentified"))
         : segment.speaker;
     return `${label}: ${segment.text}`;
   }
   ```
   **[AMENDED 2026-08-27]** The no-`speakerLabel` fallback changes from
   `"Them"` to `"Unidentified"` — the same §3.3 amendment applied at this
   site, the fourth (and originally "weaker") rendering site §1 flagged. A
   meeting with no names/merges and no diarization gaps gets a byte-identical
   LLM input to today (`segment.speakerName` and `segment.speakerLabel` both
   undefined only occurs for `"Me"` segments or truly unlabeled `"Them"`
   segments; the latter now reads "Unidentified: ..." in the LLM's input
   instead of "Them: ..." — a deliberate change, not a regression: it gives
   the summarizer the same signal the transcript UI now gives a human reader,
   that this line isn't attributable to a distinguishable speaker). Real
   names only appear once confirmed, exactly as before.

### 9.2 Staleness hint, UI-only, no auto-regeneration

Ground rule: names are never force-applied to anything the user hasn't asked
to redo — an already-generated `meeting_summaries.markdown` is a persisted
artifact, not live-computed, so confirming a name after summarizing does not
retroactively change existing summary text. The Summary tab
(`meetings.tsx`, near the existing `meeting.summary` render) shows a
small note, `meetings.summaryStaleNames` ("Speaker names changed since
this summary was generated — Resummarize to include them."), whenever
`meeting_summaries.created_at` for this meeting predates the most recent
`meeting_speakers.updated_at` row for the same meeting. Computed from
data already loaded by the detail view (§7.3's speakers query) plus
`meeting.summary` — no new endpoint.

### 9.3 **[AMENDED 2026-08-27]** `meetings.context` feeds the summarize prompt too

The sign-off's point 1 is explicit that the context field feeds **both** the
naming prompt (§5.2) and the summarize prompt — not Enhance alone. `summarize
.ts`'s `summarizeMeeting` (`summarize.ts:227-...`) gains a `meetingContext:
string | undefined` field on `SummarizeMeetingOptions`, alongside the
existing `summaryInstructions` option, with the identical "explicit option
wins, else read from the DB when omitted" fallback shape
`resolveSummaryInstructions` already establishes:

```ts
export interface SummarizeMeetingOptions {
  // ...existing fields unchanged...
  /**
   * Free-text per-meeting context (specs/meeting-speaker-naming.md §3.4).
   * Defaults to the meeting's own `context` column when readable, else ""
   * (no change to the default prompt).
   */
  meetingContext?: string;
}
```

Threaded into the system prompt via the same `withSummaryInstructions`-style
append (`summary-prompt.ts`), as its own clearly delimited block distinct
from `summaryInstructions` — the two are different kinds of input
(`summaryInstructions` is global tone/formatting guidance the user sets once
in Settings; `meetingContext` is per-meeting factual context) and must not be
merged into one string:

```ts
export function withMeetingContext(
  base: string,
  context: string | undefined | null,
): string {
  const trimmed = context?.trim();
  if (!trimmed) return base;
  return `${base}\n\nContext for this specific meeting, provided by the user:\n${trimmed}`;
}
```

Applied in `summarizeMeeting` right after the existing
`withSummaryInstructions(...)` call, on all three system prompt variants
(single/map/reduce — `MEETING_SUMMARY_SYSTEM_PROMPT`,
`MEETING_SUMMARY_MAP_SYSTEM_PROMPT`, `MEETING_SUMMARY_REDUCE_SYSTEM_PROMPT`),
same as `summaryInstructions` already is. A meeting with `context` unset (the
common case, and every meeting created before this migration) produces a
byte-identical prompt to today — `withMeetingContext` returns `base`
unchanged on empty/whitespace-only input, same no-op guarantee
`withSummaryInstructions` already gives.

**Route wiring**: `POST /:id/summarize` (`routes/meetings.ts:820-...`) passes
`row.context ?? undefined` as `meetingContext` in its call to `summarize(...)`
— the meeting row is already loaded there (§9.1's call site), so this is a
threading change only, the same shape as §5.4's Enhance wiring.

---

## 10. Non-goals

- **Voiceprints / cross-meeting identity.** `meeting_speakers.display_name`
  is per-meeting text, nothing more — the natural future consumer of
  confirmed names once a global people registry exists (`meeting-diarization
  .md` §1's own non-goals list this explicitly as future work; this spec
  produces exactly the confirmed-name data such a registry would eventually
  read, without building the registry).
- **Auto-apply of any kind.** No suggestion, however confident, is ever
  written to `display_name` without an explicit save.
- **Autocomplete-from-previous-meetings.** Noted in the task brief as "cheap
  v1.5" — not built here; `display_name` values aren't even queryable across
  meetings without a new index/query this spec doesn't add.
- **Cross-chunk speaker-evidence aggregation** (§5.3) — a real map-reduce
  pass over long, multi-chunk meetings that could combine evidence spread
  across chunks. First-chunk-wins is the whole v1 reconcile rule.
- **Re-matching labels across a re-diarize run** to preserve names instead
  of resetting them (§6.3's v1.5 alternative, majority-overlap re-matching)
  — not built; the conservative reset is v1's answer.
- **Changing `llm-task-profiles.md`'s per-task budget/model wiring.** §12
  states the coordination requirement instead of touching that code.

---

## 11. i18n

New keys under `meetings.*`, all 8 locale files (`en.json` source, 6
translated locales, `template.json`) — same location convention as every
other `meetings.*` key:

`speakers` ("Speakers", the button), `speakersDialogTitle` ("Speakers"),
`speakersDialogDesc` ("Confirm names or merge duplicate clusters. Never
applied automatically — you choose what to save."), `speakerSegments`
(`"{{n}} segments"`), `speakerNamePlaceholder` ("Unnamed"),
`speakerSuggested` ("Suggested"), `speakerMergeInto` ("Merge into…"),
`speakerMergeNone` ("Not merged"), `speakerMergedInto` ("Merged into {{name}}"),
`speakerUnmerge` ("Unmerge"), `speakerMergeHint` (`"Also suggested \"{{name}}\"
for Them {{label}} — merge these?"`), `speakerMerge` ("Merge"),
`speakerUnlabeledNote` **[AMENDED 2026-08-27, copy updated]**
(`"{{n}} segments couldn't be matched to a speaker and stay labeled
Unidentified."` — was `"...labeled \"Them.\""`), `speakerEmptyState` ("Run
"Identify speakers" first to detect voices in this meeting."),
`speakerResetOnRediarizeTitle` ("Re-run speaker identification?"),
`speakerResetOnRediarizeDesc` ("This meeting has confirmed names or merges.
Running identification again clears them, since a fresh pass isn't
guaranteed to number speakers the same way."), `summaryStaleNames` ("Speaker
names changed since this summary was generated — Resummarize to include
them."), `close` (dialog's `[Done]` button — reuse `meetings.cancel`'s
existing pattern if a generic "Close" already exists elsewhere in this
locale file; otherwise add).

**[AMENDED 2026-08-27, new keys]**:
`speakerUnidentified` ("Unidentified" — the §3.3/§7.5 chip/label text, used
at the transcript-row and `transcriptText` renderer sites; §9.1's
`summarize.ts` and §4's `formatTranscriptMarkdown` use the unlocalized
literal `"Unidentified"` instead, per the markdown-export rule below),
`contextPlaceholder` ("Add context for this meeting…" — §7.6's inline
context field).

All markdown export sites (`formatTranscriptMarkdown`, `formatSegment`)
remain **English-only literals** regardless of app locale, consistent with
`s.speaker` itself already being unlocalized there — same rule
`meeting-diarization.md` §9 already states for `transcript.md`. This
includes the new `"Unidentified"` fallback (§3.3/§4/§9.1) — it is the literal
string at those two sites, and the `meetings.speakerUnidentified` i18n key
at the two UI renderer sites (transcript row, `transcriptText`). A confirmed
`display_name`, though, is arbitrary user-entered text — it renders verbatim
in every locale, exactly as typed, never routed through `t()`, because it
isn't a translatable string, it's data. `meetings.context`, likewise, is
arbitrary user-entered text, never translated.

---

## 12. Coordination with `llm-task-profiles.md`

That spec (concurrent workflow, not yet landed as of this writing) rewrites
`llm-call.ts`'s `resolveDefaultChatCall` to require a `taskId` parameter and
wraps the model/param resolution `enhance.ts` calls into
(`llm-task-profiles.md` §8.5's table: `llm-call.ts:51-105`,
`enhance.ts:149-150`). This spec does **not** touch `llm-call.ts` at all —
only `enhance.ts` and `enhance-prompt.ts`, and only for prompt content and
parsing, not the call wiring itself. The one real overlap:

- **`enhance.ts:184`**, the per-chunk `maxOutputTokens` formula (`Math.ceil
  (chunkTokens * 1.3) + 200`). Speaker suggestions add a small amount to a
  chunk's expected output (a handful of `{name, evidence}` pairs, roughly
  30–60 tokens each). `llm-task-profiles.md` §8.2 lists this exact line as
  "unchanged" (it wraps the call, it doesn't change the arithmetic). This
  spec's requirement: bump the formula by a small additive term scaled to
  the chunk's distinct `Them N` label count, e.g. `+ 60 *
  speakerLabelsInChunk.length`, landed as a one-line change to the same
  formula regardless of which spec's PR merges first — a same-file arithmetic
  adjustment, not a design conflict. Sequence: whichever spec lands second
  re-reads the line as it exists after the first, adds its own term without
  reverting the other's.
- No other file this spec touches (`enhance-prompt.ts`, the new
  `speaker-names.ts`, `routes/meetings.ts`'s new routes, `merge.ts`,
  `meetings.tsx`) appears in `llm-task-profiles.md`'s file inventory at all.

---

## 13. Open questions (flag for sign-off — decisions made without a live
interactive check)

**[AMENDED 2026-08-27 14:05 — points 1–3 resolved by user sign-off.]** See
the amendment note at the top of this document for the summary; the
resolutions are recorded here for the historical record of what was asked
and decided, and are threaded into the sections named below.

1. ~~**"Meeting context field" in the task brief vs. what actually
   exists.**~~ **RESOLVED 2026-08-27: build it.** §1 originally resolved
   this as `meetings.title` + transcript content only, since no
   `context`/`app_context` column existed at the time of writing (confirmed
   against `schema.ts`), and flagged the alternative — a real `context`
   capture field — as new scope requiring sign-off. The sign-off confirms
   that scope: a per-meeting free-text `meetings.context` column, editable
   anytime in the meeting detail UI, feeding both the naming prompt and the
   summarize prompt. See §3.4 (schema/migration), §5.2/§5.3/§5.4 (naming
   prompt wiring), §9.3 (summarize prompt wiring), §6.4 (edit route), §7.6
   (UI), §11 (i18n).
2. ~~**Re-diarize resets the naming mapping (§6.3).**~~ **RESOLVED
   2026-08-27: confirmed as specified.** This is the safe, conservative
   choice given no determinism guarantee exists for the diarizer's
   clustering across runs — a real UX cost (running "Identify speakers"
   again after naming people throws the naming away), accepted for v1 with
   §7.4's confirmation dialog as the mitigation. No spec change beyond this
   resolution — §6.3 and §7.4 are built exactly as originally designed.
3. ~~**NULL-label segments get no nameable row (§3.3).**~~ **RESOLVED
   2026-08-27: read-only, non-nameable in v1 — confirmed — but rendered
   under an explicit "Unidentified" label, not bare "Them."** The
   alternative considered here (letting a user assign a name to individual
   undiarized segments one at a time) is rejected, same as originally
   proposed — that stays scope creep against a noise bucket. What changes:
   the original spec's rendering fallback for these segments was plain
   `"Them"`, indistinguishable from a real unnamed participant; the
   sign-off requires a visually distinct, muted label that clearly reads as
   "could not be identified." See §3.3, §4, §7.2, §7.5, §9.1, §11 for the
   concrete rendering-site changes.
4. **`+60 tokens per label` budget bump (§12)** is an estimate, not measured
   against a real model's actual `{name, evidence}` JSON output size. Revisit
   once the real-audio acceptance test (§14) produces real output, same
   "measure, then tighten" posture `meeting-diarization.md` §11 already uses
   for its own timeout formula. **Still open** — outside the scope of the
   2026-08-27 sign-off, which addressed points 1–3 only.

---

## 14. Test plan

**Unit — `resolveSpeakerNames` (new `meeting-speaker-names.test.ts`):**

- A segment with a `speakerLabel` matching a row with `displayName` set gets
  `speakerName` attached, `speakerLabel` unchanged.
- A segment whose `speakerLabel` row has `mergedInto` set gets remapped to
  the target's `speakerLabel` and (if the target has a `displayName`) the
  target's name — proves the one-hop resolution, not just a passthrough.
- A segment whose `speakerLabel` has no row at all is untouched (`speakerLabel`
  unchanged, `speakerName` stays undefined) — the lazy-row case.
- A `"Me"` segment, or a `"Them"` segment with no `speakerLabel`, is never
  touched regardless of what `rows` contains.
- **Merging into a target with no `meeting_speakers` row at all** (the lazy-
  row case, and the real shape of meeting `8e6aea86`'s labels `3`/`2`/`5`/`7`
  before any naming/suggestion has touched them): a row for the *source*
  label only (`{ speakerLabel: "8", mergedInto: "3" }`), no row for `"3"` in
  `rows` at all → asserts the segment's `speakerLabel` becomes `"3"` and
  `speakerName` stays undefined. This is the regression test for the bug
  where resolving through `byLabel.get(row.mergedInto)` instead of the raw
  label string silently drops the merge for exactly this case.

**Unit — merge write-path (extend or new, matching route-test conventions
for `PATCH`-style handlers elsewhere in `meetings-routes.test.ts`):**

- Self-merge (`mergedInto === label`) → 400, no row written.
- Merge into an already-merged target → the write uses that target's own
  root, not the literal requested id.
- Merge a label that has other labels already pointing at it → those rows
  cascade to the new target in the same transaction; assert both the
  cascaded rows and the new row's own `merged_into` in one query after.
- Unmerge (`mergedInto: null`) clears the edge without touching `display_name`.
- Un-name (`displayName: null`) clears the name without touching `merged_into`.
- `PATCH` on a label with zero segments in the meeting → 404.
- `PATCH` with an empty body → 400.

**Unit — `enhanceMeetingTranscript` speaker-suggestion parsing (extend
`meeting-enhance.test.ts`):**

- A well-formed `speakers` block with a real label → persisted to
  `meeting_speakers.suggested_name`/`suggested_evidence`; existing
  `corrections`-map assertions for the same response are unaffected (proves
  the two parse paths are independent).
- A `speakers` block naming a label not present in this meeting's
  `speakerLabels` → dropped, not persisted, no throw.
- A malformed `speakers` value (string, array, wrong-shaped entry) → dropped,
  segment-text corrections in the same chunk still commit.
- Two chunks, conflicting names for the same label → first chunk's name
  wins, `log.debug` called, no throw.
- Two chunks, same name (case-insensitive) for the same label → no
  conflict log, one row persisted.
- A meeting with `speakerLabels.length === 0` → `buildEnhanceSystemPrompt`
  called with an empty array, produces the exact pre-this-spec prompt string
  (regression check that the new block is truly a no-op when diarization
  never ran).
- `ON CONFLICT DO UPDATE` never touches `display_name`: pre-seed a row with
  `display_name = 'Ana'`, run a chunk whose `speakers` block proposes a
  different name for the same label, assert `display_name` is still `'Ana'`
  after.

**Unit — `formatSegment`/`formatTranscriptMarkdown` (extend
`meeting-merge.test.ts`/`meeting-summarize.test.ts`):**

- A segment with `speakerName` set renders the name, not `"Them N"`, in both
  functions.
- A segment with `speakerLabel` set but no `speakerName` renders `"Them N"`
  in both functions (regression check, unchanged from today).
- **[AMENDED 2026-08-27]** A `"Them"` segment with **no** `speakerLabel` and
  no `speakerName` renders the literal `"Unidentified"` (not `"Them"`) in
  both functions — the §3.3/§4/§9.1 amendment, replacing what was previously
  a "no speakerName → today's output" regression check with an explicit
  assertion of the new fallback string.

**[AMENDED 2026-08-27] Unit — `speaker-names.ts`/renderer Unidentified
fallback (extend `meeting-speaker-names.test.ts` and the `meetings.tsx`
component test suite):**

- The transcript-row renderer and `transcriptText` builder each render the
  `meetings.speakerUnidentified` ("Unidentified") chip/text for a system
  segment with `speaker_label IS NULL`, styled with the muted/outline
  variant (§7.5) — not the accent-passive fill used for named/`Them N`
  chips.
- A numbered-but-unnamed `Them N` segment (`speakerLabel` set, no
  `displayName`) is unaffected by this change — still renders `"Them N"`,
  proving the Unidentified fallback only fires for the true
  `speakerLabel === null` case, not "any unnamed speaker."

**Integration — schema migration (extend `schema-meetings.test.ts`):**

- Fresh DB at version 33 has `meeting_speakers` with the expected columns
  and PK.
- DB pre-seeded at version 32 migrates to 33 cleanly, no data loss on
  existing `meetings`/`meeting_segments` rows.
- **[AMENDED 2026-08-27]** Fresh DB at version 33 has `meetings.context`
  present and nullable; a pre-seeded version-32 DB with existing `meetings`
  rows migrates to 33 with every existing row's `context` reading `NULL`
  (added column default), no data loss on any other column.

**Integration — routes (extend `meetings-routes.test.ts`):**

- `GET /:id/speakers`: 404 unknown meeting; happy path returns one row per
  distinct labeled speaker plus `unlabeledCount`; a label with a
  `meeting_speakers` row shows its name/suggestion/merge state, a label
  without one shows all-null optional fields.
- `PATCH /:id/speakers/:label`: every case in the "merge write-path" unit
  list above, exercised through the actual route (not just the underlying
  helper) — confirming the 400/404 status codes and the
  `writeTranscriptMarkdown` side effect (assert the on-disk file changed).
- `POST /:id/transcribe`: pre-seed `meeting_speakers` rows, run transcribe,
  assert the rows are gone.
- `POST /:id/diarize`: pre-seed `meeting_speakers` rows with a confirmed
  name, run diarize, assert the rows are gone and the response has
  `mappingReset: true`; a meeting with no prior naming gets
  `mappingReset: false`.
- **[AMENDED 2026-08-27]** `PATCH /:id` (§6.4): setting `context` to a string
  persists it and is returned on the next `GET`; setting `context: null`
  clears a previously-set value; a body with only `context` (no `title`/
  `language`) is accepted (the `refine` no longer rejects it); a body with
  none of the three fields still 400s; `context` over 2000 chars 400s
  (`zValidator`'s own schema rejection).

**[AMENDED 2026-08-27] Unit — `enhanceMeetingTranscript`/`buildEnhanceSystemPrompt`
context wiring (extend `meeting-enhance.test.ts`/`enhance-prompt.test.ts`):**

- `buildEnhanceSystemPrompt` called with a non-empty `meetingContext` and
  `speakerLabels.length > 0` includes the context sentence in the speaker
  block; called with `meetingContext` empty/undefined produces the
  pre-context-amendment block text (regression check).
- `buildEnhanceSystemPrompt` called with `speakerLabels.length === 0` and a
  non-empty `meetingContext` still omits the whole speaker block (context
  alone never triggers the block — diarization labels are the gate).
- `enhanceMeetingTranscript` passes `row.context ?? undefined` through to
  `buildEnhanceSystemPrompt` unchanged (threading check at the call site).

**[AMENDED 2026-08-27] Unit — `summarizeMeeting`/`withMeetingContext`
(extend `meeting-summarize.test.ts`):**

- `withMeetingContext(base, undefined | null | "" | "   ")` returns `base`
  unchanged (no-op guarantee).
- `withMeetingContext(base, "some context")` appends the context block,
  distinct and separate from a `withSummaryInstructions` block also present
  on the same prompt (both survive independently — not merged into one
  string).
- `summarizeMeeting` with `options.meetingContext` set applies it to all
  three system-prompt variants (single/map/reduce) when the transcript is
  long enough to hit map-reduce.
- `POST /:id/summarize` passes `row.context ?? undefined` through unchanged
  (threading check, same pattern as the Enhance one above).

**Real-audio acceptance test (manual, reuses meeting `8e6aea86-ca4c-4aeb-
9c1c-19cc4416daec`, "FTI / Symphony AGS Prototype Build" — pre-verified
2026-08-27 state: 79 system segments across labels `3`=24, `2`=19,
NULL=14, `5`=12, `7`=5, `1`=2, `8`=1, `6`=1, `4`=1 — the exact "8 clusters,
~5 real speakers" case this feature exists for):**

Copy the production DB to a temp file first — never mutate the original.

- [ ] `GET /:id/speakers` on the unmodified copy returns 8 rows (labels 1–8)
      with the segment counts above, `unlabeledCount: 14`, every optional
      field null (no naming has ever run).
- [ ] **[AMENDED 2026-08-27]** In the transcript view, confirm the 14
      NULL-label segments render the muted "Unidentified" chip (§7.5), not
      plain "Them" — and that `transcript.md` for this meeting shows the
      literal `Unidentified:` prefix on those same lines.
- [ ] **[AMENDED 2026-08-27]** Set `meetings.context` on this meeting via the
      inline field (§7.6), e.g. noting a participant's name/role not
      otherwise obvious from the transcript. Confirm `GET`/`PATCH /:id`
      round-trips the value.
- [ ] Run `POST /:id/enhance`. Confirm the response's `speakerSuggestions`
      is > 0 and at least the two largest clusters (`3`, `2`) get a
      `suggested_name` with non-empty `suggested_evidence` grounded in
      actual transcript content (spot-check the evidence string against the
      real transcript, not just "is it non-empty"). **[AMENDED 2026-08-27]**
      If the context note above supplies a name the transcript itself
      doesn't spell out, confirm that name (or a plausible variant of it)
      shows up as a suggestion, or as more confident evidence, versus a run
      with `context` cleared — a rough signal the context wiring (§5.2) is
      actually reaching the prompt, not just being stored.
  - [ ] Re-fetch `GET /:id/speakers`: singleton labels `8`, `6`, `4` (the
        "interjection noise" clusters this feature exists to collapse) each
        show their real 1-segment quote — confirm by eye whether they read as
        real distinct people or noise, informing the merge step next.
- [ ] In the dialog (or directly via `PATCH`): merge `8`, `6`, and `4` into
      whichever of `3`/`2`/`5`/`7`/`1` they actually belong to by listening
      to/reading the audio context. Confirm each `PATCH` succeeds and the
      transcript view immediately shows the merged segments under the
      target's label/name.
  - [ ] **Negative assertion**: after every merge above, `SELECT
        speaker_label FROM meeting_segments WHERE meeting_id = '8e6aea86…'`
        for the merged rows is **unchanged** — still `8`, `6`, `4` — proving
        the merge is a mapping, not a rewrite (ground rule #3).
  - [ ] **Positive assertion**: at least one merge target above should be a
        label with no `meeting_speakers` row yet (unsuggested, unnamed) —
        confirm the merged singleton's segments render under that target's
        plain `Them N` label in the transcript view immediately, before any
        name is confirmed on either side. This is the case §4's resolution
        bugfix exists for; a regression here would look like "the merge
        button did nothing."
- [ ] Confirm a name for at least one merged-into speaker via the dialog.
      Confirm: the transcript view shows the real name on every segment that
      belongs to that speaker, including the ones that came from a merged
      label; `transcript.md`/`transcript-enhanced.md` on disk show the same
      name; `CopyButton`'s copied text shows the same name (all three sites
      from §1's inventory, checked independently).
- [ ] Re-summarize the meeting after naming. Confirm the new summary
      markdown uses the real name, not `"Them"`; confirm the pre-naming
      summary (if one exists from before this test) shows the
      `summaryStaleNames` hint until re-summarized.
- [ ] Click "Identify speakers" again with names/merges in place. Confirm the
      confirmation dialog appears (§7.4) before the request fires, and that
      accepting it clears `meeting_speakers` for this meeting (`GET
      /:id/speakers` afterward shows every row reset to unnamed/unmerged).
- [ ] Confirm the whole flow works with no network access (kill network,
      repeat the Enhance run against a local LLM if one is configured) — the
      offline ground rule (#5).
