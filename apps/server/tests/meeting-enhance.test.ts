import { afterEach, describe, expect, it } from "vitest";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import {
  chunkForEnhance,
  type EnhanceLlmCall,
  type EnhanceLlmRequest,
  type EnhanceLlmResponse,
  type EnhanceMeetingOptions,
  enhanceMeetingTranscript,
  extractJsonObject,
  getMeetingEnhanceAutoRunSetting,
} from "../src/lib/meetings/enhance.js";
import { buildEnhanceSystemPrompt } from "../src/lib/meetings/enhance-prompt.js";
import type { MergedSegment } from "../src/lib/meetings/merge.js";
import { insertSegment, resetMeetingTables } from "./helpers/meetings-db.js";

function seg(
  id: string,
  speaker: "Me" | "Them",
  text: string,
  startMs = 0,
  endMs = 1000,
  speakerLabel?: string,
): MergedSegment {
  return {
    speaker,
    startMs,
    endMs,
    text,
    id,
    ...(speakerLabel ? { speakerLabel } : {}),
  };
}

/** Insert a parent `meetings` row and one `meeting_segments` row per id (FK
 * requires the parent to exist first). Placeholder text/status only — the
 * enhance pass reads its input from the `segments` array, not the DB; this
 * just gives the UPDATE something real to write into. */
function insertMeetingAndSegments(meetingId: string, ids: string[]): void {
  getDb()
    .prepare(
      "INSERT INTO meetings (id, status, created_at) VALUES (?, 'transcribed', ?)",
    )
    .run(meetingId, Date.now());
  for (const id of ids) {
    insertSegment({
      id,
      meetingId,
      source: "mic",
      idx: 0,
      startMs: 0,
      endMs: 1000,
      text: "placeholder",
    });
  }
}

/** Seed meeting "m1" with one DB row per segment id, then run the enhance
 * pass on it. Do not use it when a test must write rows before the seed. */
function runEnhance(
  segments: MergedSegment[],
  opts: {
    llm: { call: EnhanceLlmCall };
    language?: string;
    title?: string;
    context?: string;
    options?: Omit<EnhanceMeetingOptions, "llmCall">;
  },
) {
  insertMeetingAndSegments(
    "m1",
    segments.flatMap((s) => (s.id ? [s.id] : [])),
  );
  return enhanceMeetingTranscript(
    "m1",
    segments,
    opts.language,
    [],
    opts.title,
    opts.context,
    { llmCall: opts.llm.call, ...opts.options },
  );
}

/** The `enhanced_text` of one segment row (NULL when nothing was written). */
function enhancedText(id: string): string | null {
  const row = getDb()
    .prepare("SELECT enhanced_text FROM meeting_segments WHERE id = ?")
    .get(id) as { enhanced_text: string | null };
  return row.enhanced_text;
}

/** One `meeting_speakers` row of meeting "m1", with the given columns. */
function speakerRow<T>(label: string, columns: string): T {
  return getDb()
    .prepare(
      `SELECT ${columns} FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = ?`,
    )
    .get(label) as T;
}

/** A fake LLM that records every request and returns a canned response. */
function fakeLlm(
  respond: (
    request: EnhanceLlmRequest,
    index: number,
  ) => Partial<EnhanceLlmResponse>,
) {
  const requests: EnhanceLlmRequest[] = [];
  const call = async (
    request: EnhanceLlmRequest,
  ): Promise<EnhanceLlmResponse> => {
    const index = requests.length;
    requests.push(request);
    return {
      text: "{}",
      inputTokens: 0,
      outputTokens: 0,
      ...respond(request, index),
    };
  };
  return { requests, call };
}

afterEach(() => {
  resetMeetingTables();
});

describe("extractJsonObject", () => {
  it("parses a plain JSON object", () => {
    expect(extractJsonObject('{"a":"b"}')).toEqual({ a: "b" });
  });

  it("strips a markdown code fence", () => {
    expect(extractJsonObject('```json\n{"a":"b"}\n```')).toEqual({ a: "b" });
  });

  it("strips leading and trailing prose around the object", () => {
    expect(
      extractJsonObject('Sure, here you go:\n{"a":"b"}\nHope that helps!'),
    ).toEqual({ a: "b" });
  });

  it("returns null for text with no object", () => {
    expect(extractJsonObject("no object here")).toBeNull();
  });

  it("returns null for a JSON array (not an object)", () => {
    expect(extractJsonObject("[1,2,3]")).toBeNull();
  });

  it("returns null for truncated/invalid JSON", () => {
    expect(extractJsonObject('{"a": "unterminated')).toBeNull();
  });
});

describe("chunkForEnhance", () => {
  it("keeps ids disjoint across chunks and covers every input segment", () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      speaker: "Me",
      text: "word ".repeat(20),
    }));
    const chunks = chunkForEnhance(segs, 50);
    expect(chunks.length).toBeGreaterThan(1);
    const allIds = chunks.flat().map((s) => s.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect([...allIds].sort()).toEqual(segs.map((s) => s.id).sort());
  });

  it("puts a single oversized segment in its own chunk instead of stalling", () => {
    const segs = [{ id: "s0", speaker: "Me", text: "x".repeat(2000) }];
    const chunks = chunkForEnhance(segs, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });

  it("returns no chunks for empty input", () => {
    expect(chunkForEnhance([], 100)).toEqual([]);
  });
});

describe("enhanceMeetingTranscript", () => {
  it("writes enhanced_text only for corrected ids; omitted ids stay NULL", async () => {
    const segments = [
      seg("m1:mic:0", "Me", "garbled txt"),
      seg("m1:mic:1", "Me", "already fine"),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({ "m1:mic:0": "corrected text" }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.correctedCount).toBe(1);
    const rows = getDb()
      .prepare(
        "SELECT id, enhanced_text FROM meeting_segments WHERE meeting_id = 'm1' ORDER BY id",
      )
      .all() as { id: string; enhanced_text: string | null }[];
    expect(rows.find((r) => r.id === "m1:mic:0")?.enhanced_text).toBe(
      "corrected text",
    );
    expect(rows.find((r) => r.id === "m1:mic:1")?.enhanced_text).toBeNull();
  });

  it("skips a chunk with malformed JSON without dropping other chunks' corrections", async () => {
    const segments = [
      seg("m1:mic:0", "Me", "a".repeat(200)),
      seg("m1:mic:1", "Me", "b".repeat(200)),
    ];
    const llm = fakeLlm((_request, index) =>
      index === 0
        ? { text: "not json at all, sorry" }
        : { text: JSON.stringify({ "m1:mic:1": "fixed" }) },
    );

    const result = await runEnhance(segments, {
      llm,
      options: { contextBudgetTokens: 20 },
    });

    // The tiny budget forces each oversized segment into its own chunk.
    expect(llm.requests.length).toBe(2);
    expect(result.correctedCount).toBe(1);
    expect(enhancedText("m1:mic:1")).toBe("fixed");
    expect(enhancedText("m1:mic:0")).toBeNull();
  });

  it("discards a returned id that isn't in the chunk's input segments", async () => {
    const segments = [seg("m1:mic:0", "Me", "hello")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        "m1:mic:0": "fixed",
        "hallucinated:id": "should never be applied",
      }),
    }));

    const result = await runEnhance(segments, { llm });

    expect(result.correctedCount).toBe(1);
    expect(enhancedText("m1:mic:0")).toBe("fixed");
  });

  it("strips a leaked '<Speaker>: ' line-format prefix from the corrected text", async () => {
    // Real local models sometimes echo the "[id] Speaker:" input line
    // format back into the corrected-text value — verified against a real
    // meeting transcript (specs/meeting-transcription-quality.md real
    // E2E), where "Them" leaked into several corrections for system-
    // channel segments.
    const segments = [seg("m1:system:0", "Them", "garbled txt here")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({ "m1:system:0": "Them: garbled text here" }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.correctedCount).toBe(1);
    expect(enhancedText("m1:system:0")).toBe("garbled text here");
  });

  it("drops a correction that is only the leaked '<Speaker>: ' prefix plus the unchanged original", async () => {
    // Stripping the leaked prefix can reveal that the "correction" was a
    // no-op after all — the no-op guard must apply after stripping, not
    // before.
    const segments = [seg("m1:system:0", "Them", "already correct text")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({ "m1:system:0": "Them: already correct text" }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.correctedCount).toBe(0);
    expect(enhancedText("m1:system:0")).toBeNull();
  });

  it("drops a returned correction that echoes the segment's original text unchanged", async () => {
    // Real local models don't always honor "omit unchanged segments" —
    // verified against a real meeting transcript (specs/meeting-
    // transcription-quality.md real E2E), where the model occasionally
    // echoes a segment's exact original text back as a "correction".
    const segments = [
      seg("m1:mic:0", "Me", "already correct text"),
      seg("m1:mic:1", "Me", "garbled txt"),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        "m1:mic:0": "already correct text",
        "m1:mic:1": "garbled text",
      }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.correctedCount).toBe(1);
    const rows = getDb()
      .prepare(
        "SELECT id, enhanced_text FROM meeting_segments WHERE meeting_id = 'm1' ORDER BY id",
      )
      .all() as { id: string; enhanced_text: string | null }[];
    expect(rows.find((r) => r.id === "m1:mic:0")?.enhanced_text).toBeNull();
    expect(rows.find((r) => r.id === "m1:mic:1")?.enhanced_text).toBe(
      "garbled text",
    );
  });

  it("makes no LLM call and returns correctedCount 0 when no segment has text", async () => {
    const llm = fakeLlm(() => ({ text: "{}" }));

    const result = await runEnhance([seg("m1:mic:0", "Me", "   ")], { llm });

    expect(result.correctedCount).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });

  it("skips segments with no id (nothing to map a correction back to)", async () => {
    const llm = fakeLlm(() => ({ text: "{}" }));

    const result = await runEnhance(
      [{ speaker: "Me", startMs: 0, endMs: 1000, text: "hello" }],
      { llm },
    );

    expect(result.correctedCount).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });
});

describe("enhanceMeetingTranscript speaker name suggestions (specs/meeting-speaker-naming.md §5.3)", () => {
  // Regression test (advisor-flagged, §5.3): speakerLabels must be derived
  // from the structured `speakerLabel` field, never by re-parsing the
  // formatted `withIds[].speaker` display string — once a speaker already
  // has a confirmed name, that string renders as e.g. "Ana", not "Them 3".
  // A `Them (\d+)` regex would silently drop this speaker from both the
  // prompt's label list and the phantom-label allowlist.
  it("keeps an already-named speaker's label in speakerLabels and the phantom-label allowlist (does not re-parse the formatted display string)", async () => {
    const segments: MergedSegment[] = [
      {
        speaker: "Them",
        startMs: 0,
        endMs: 1000,
        text: "hi there, this is Ana",
        id: "m1:system:0",
        speakerLabel: "3",
        speakerName: "Ana", // already confirmed — formatted display is "Ana", not "Them 3"
      },
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: { "3": { name: "Ana", evidence: "this is Ana" } },
      }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    // The formatted transcript line shows the confirmed name, not the
    // numbered label — proves §5.1's prerequisite fix is in effect.
    expect(llm.requests[0].prompt).toContain("Ana: hi there");
    expect(llm.requests[0].prompt).not.toContain("Them 3");
    // The system prompt's speaker block still lists "Them 3" as a label to
    // find evidence for — proves speakerLabels was derived from the
    // structured field, not from re-parsing the "Ana" display string (which
    // would have produced an empty label list and omitted this block
    // entirely).
    expect(llm.requests[0].system).toContain(
      "diarized speaker labels for the other participant(s): Them 3",
    );
    // Not dropped as a phantom label.
    expect(result.speakerSuggestions).toBe(1);
    const row = speakerRow<{ suggested_name: string }>("3", "suggested_name");
    expect(row.suggested_name).toBe("Ana");
  });

  it("persists a well-formed speakers block for a real label without disturbing independent text corrections", async () => {
    const segments = [
      seg("m1:system:0", "Them", "garbled txt, this is Ana", 0, 1000, "3"),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        "m1:system:0": "corrected text",
        speakers: {
          "3": { name: "Ana", evidence: "this is Ana" },
        },
      }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.correctedCount).toBe(1);
    expect(result.speakerSuggestions).toBe(1);
    const row = speakerRow<{
      suggested_name: string;
      suggested_evidence: string;
    }>("3", "suggested_name, suggested_evidence");
    expect(row.suggested_name).toBe("Ana");
    expect(row.suggested_evidence).toBe("this is Ana");
  });

  it('persists an explicit kind: "role" entry as a role guess, distinct from a confirmed name (real-E2E hardening)', async () => {
    const segments = [
      seg(
        "m1:system:0",
        "Them",
        "hi, I'll be leading the interview from our side",
        0,
        1000,
        "3",
      ),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: {
          "3": {
            name: "the hiring manager",
            kind: "role",
            evidence: "leading the interview from our side",
          },
        },
      }),
    }));

    await runEnhance(segments, { llm, language: "en" });

    const row = speakerRow<{ suggested_name: string; suggested_kind: string }>(
      "3",
      "suggested_name, suggested_kind",
    );
    expect(row.suggested_name).toBe("the hiring manager");
    expect(row.suggested_kind).toBe("role");
  });

  it('defaults suggested_kind to "name" when the entry omits kind (backward compatible with the pre-hardening contract) or sends an unrecognized value', async () => {
    const segments = [
      seg("m1:system:0", "Them", "hi, this is Ana", 0, 1000, "3"),
      seg("m1:system:1", "Them", "hi, this is Beto", 1000, 2000, "4"),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: {
          "3": { name: "Ana", evidence: "this is Ana" }, // no kind at all
          "4": { name: "Beto", kind: "guess", evidence: "this is Beto" },
        },
      }),
    }));

    await runEnhance(segments, { llm, language: "en" });

    const rows = getDb()
      .prepare(
        "SELECT speaker_label, suggested_kind FROM meeting_speakers WHERE meeting_id = 'm1' ORDER BY speaker_label",
      )
      .all() as { speaker_label: string; suggested_kind: string }[];
    expect(rows.find((r) => r.speaker_label === "3")?.suggested_kind).toBe(
      "name",
    );
    expect(rows.find((r) => r.speaker_label === "4")?.suggested_kind).toBe(
      "name",
    );
  });

  it("never sets confirmed_at on a suggestion upsert — only a human PATCH does (real-E2E fix: prevents Enhance from falsely marking a summary stale)", async () => {
    const segments = [
      seg("m1:system:0", "Them", "hi, this is Ana", 0, 1000, "3"),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: { "3": { name: "Ana", evidence: "this is Ana" } },
      }),
    }));

    await runEnhance(segments, { llm, language: "en" });

    const row = speakerRow<{ confirmed_at: number | null }>(
      "3",
      "confirmed_at",
    );
    expect(row.confirmed_at).toBeNull();
  });

  it('drops a suggestion whose evidence traces only to a "Me" segment, never any Them line (real-E2E regression: meeting 8e6aea86\'s "Them 5 = Aruna", cited evidence actually spoken by "Me")', async () => {
    const segments = [
      seg("m1:mic:0", "Me", "I'm gonna work on this alongside with Aruna"),
      seg("m1:system:0", "Them", "sounds good, thanks", 0, 1000, "5"),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: {
          "5": {
            name: "Aruna",
            evidence: "I'm gonna work on this alongside with Aruna",
          },
        },
      }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.speakerSuggestions).toBe(0);
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM meeting_speakers WHERE meeting_id = 'm1'",
      )
      .get() as { c: number };
    expect(row.c).toBe(0);
  });

  it('drops a "name" suggestion whose evidence is the label\'s own turn but reads as addressing someone else, not self-identifying (real-E2E regression: meeting 8e6aea86\'s "Them 3 = Marcos" from Them 3\'s own "Thank you, Marcos.")', async () => {
    const segments = [
      seg(
        "m1:system:0",
        "Them",
        "Thank you, Marcos. That looks great.",
        0,
        1000,
        "3",
      ),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: { "3": { name: "Marcos", evidence: "Thank you, Marcos." } },
      }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.speakerSuggestions).toBe(0);
  });

  it("accepts a \"name\" suggestion whose evidence is a DIFFERENT Them label's turn addressing this label by name (ADDRESSED-AS), even though it's not self-identifying", async () => {
    const segments = [
      seg("m1:system:0", "Them", "Ana, can you start us off?", 0, 1000, "2"),
      seg("m1:system:1", "Them", "Sure, happy to.", 1000, 2000, "3"),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: {
          "3": { name: "Ana", evidence: "Ana, can you start us off?" },
        },
      }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.speakerSuggestions).toBe(1);
    const row = speakerRow<{ suggested_name: string }>("3", "suggested_name");
    expect(row.suggested_name).toBe("Ana");
  });

  it("drops a suggestion whose cited evidence doesn't match any segment's actual text (hallucinated quote)", async () => {
    const segments = [seg("m1:system:0", "Them", "hi there", 0, 1000, "3")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: {
          "3": { name: "Ana", evidence: "this is Ana, nice to meet you" },
        },
      }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.speakerSuggestions).toBe(0);
  });

  it("drops a suggestion whose proposed name doesn't even appear in its own cited evidence", async () => {
    const segments = [
      seg("m1:system:0", "Them", "hi there, this is Ana", 0, 1000, "3"),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: { "3": { name: "Beatriz", evidence: "this is Ana" } },
      }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.speakerSuggestions).toBe(0);
  });

  it('accepts a "role" suggestion grounded in the label\'s own real text without requiring self-identify phrasing', async () => {
    const segments = [
      seg(
        "m1:system:0",
        "Them",
        "as the hiring manager for this role, I'll be leading the panel",
        0,
        1000,
        "3",
      ),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: {
          "3": {
            name: "the hiring manager",
            kind: "role",
            evidence: "as the hiring manager for this role",
          },
        },
      }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.speakerSuggestions).toBe(1);
  });

  it("drops a speakers entry naming a label not present in this meeting's speakerLabels, without throwing", async () => {
    const segments = [seg("m1:system:0", "Them", "hi", 0, 1000, "3")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: { "99": { name: "Ghost", evidence: "n/a" } },
      }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.speakerSuggestions).toBe(0);
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM meeting_speakers WHERE meeting_id = 'm1'",
      )
      .get() as { c: number };
    expect(row.c).toBe(0);
  });

  it("drops a malformed speakers value (string/array/wrong-shaped entry); segment-text corrections in the same chunk still commit", async () => {
    const segments = [seg("m1:system:0", "Them", "garbled", 0, 1000, "3")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        "m1:system:0": "fixed",
        speakers: ["not", "an", "object"],
      }),
    }));

    const result = await runEnhance(segments, { llm, language: "en" });

    expect(result.correctedCount).toBe(1);
    expect(result.speakerSuggestions).toBe(0);
  });

  it("keeps the first chunk's name on a cross-chunk conflict for the same label, logging the conflict, no throw", async () => {
    const segments = [
      seg(
        "m1:system:0",
        "Them",
        `${"a".repeat(200)} this is Ana`,
        0,
        1000,
        "3",
      ),
      seg(
        "m1:system:1",
        "Them",
        `${"b".repeat(200)} this is Beatriz`,
        1000,
        2000,
        "3",
      ),
    ];
    const llm = fakeLlm((_request, index) => ({
      text: JSON.stringify({
        speakers: {
          "3": {
            name: index === 0 ? "Ana" : "Beatriz",
            evidence: index === 0 ? "this is Ana" : "this is Beatriz",
          },
        },
      }),
    }));

    const result = await runEnhance(segments, {
      llm,
      language: "en",
      options: { contextBudgetTokens: 20 },
    });

    expect(llm.requests.length).toBe(2);
    expect(result.speakerSuggestions).toBe(1);
    const row = speakerRow<{ suggested_name: string }>("3", "suggested_name");
    expect(row.suggested_name).toBe("Ana");
  });

  it("records one row (no conflict) when two chunks propose the same name (case-insensitive) for the same label", async () => {
    const segments = [
      seg(
        "m1:system:0",
        "Them",
        `${"a".repeat(200)} this is Ana`,
        0,
        1000,
        "3",
      ),
      seg(
        "m1:system:1",
        "Them",
        `${"b".repeat(200)} this is ANA`,
        1000,
        2000,
        "3",
      ),
    ];
    const llm = fakeLlm((_request, index) => ({
      text: JSON.stringify({
        // Same name, different case, from each chunk — must not be treated
        // as a conflict.
        speakers: {
          "3": {
            name: index === 0 ? "Ana" : "ANA",
            evidence: index === 0 ? "this is Ana" : "this is ANA",
          },
        },
      }),
    }));

    const result = await runEnhance(segments, {
      llm,
      language: "en",
      options: { contextBudgetTokens: 20 },
    });

    expect(llm.requests.length).toBe(2);
    expect(result.speakerSuggestions).toBe(1);
    const count = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '3'",
      )
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("passes an empty speakerLabels array to buildEnhanceSystemPrompt for a meeting with no diarization labels, producing the exact pre-this-spec prompt", async () => {
    const segments = [seg("m1:mic:0", "Me", "hello")];
    const llm = fakeLlm(() => ({ text: "{}" }));

    await runEnhance(segments, { llm, language: "en" });

    expect(llm.requests[0].system).toBe(buildEnhanceSystemPrompt("en", []));
    expect(llm.requests[0].system).toBe(
      buildEnhanceSystemPrompt("en", [], [], undefined, undefined),
    );
  });

  it("never overwrites a confirmed display_name when a fresh suggestion for the same label arrives (ON CONFLICT DO UPDATE only ever writes suggested_name/suggested_evidence)", async () => {
    // The speaker row needs its parent meeting first, so this test seeds by
    // hand and calls the function directly.
    insertMeetingAndSegments("m1", ["m1:system:0"]);
    getDb()
      .prepare(
        `INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name, updated_at)
         VALUES ('m1', '3', 'Ana', ?)`,
      )
      .run(Date.now());
    const segments = [
      seg("m1:system:0", "Them", "hi, this is Beatriz", 0, 1000, "3"),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: { "3": { name: "Beatriz", evidence: "this is Beatriz" } },
      }),
    }));

    await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      { llmCall: llm.call },
    );

    const row = speakerRow<{ display_name: string; suggested_name: string }>(
      "3",
      "display_name, suggested_name",
    );
    expect(row.display_name).toBe("Ana");
    expect(row.suggested_name).toBe("Beatriz");
  });
});

describe("buildEnhanceSystemPrompt speaker/context block (specs/meeting-speaker-naming.md §5.2)", () => {
  it("includes the context sentence when meetingContext is non-empty and speakerLabels is non-empty", () => {
    const prompt = buildEnhanceSystemPrompt(
      "en",
      [],
      ["2"],
      undefined,
      "Call with Ana from Acme",
    );
    expect(prompt).toContain(
      'Additional context for this meeting, provided by the user: "Call with Ana from Acme"',
    );
  });

  it("omits the context sentence (pre-amendment block text) when meetingContext is empty/undefined", () => {
    const withUndefined = buildEnhanceSystemPrompt(
      "en",
      [],
      ["2"],
      undefined,
      undefined,
    );
    const withEmpty = buildEnhanceSystemPrompt(
      "en",
      [],
      ["2"],
      undefined,
      "   ",
    );
    expect(withUndefined).not.toContain("Additional context for this meeting");
    expect(withEmpty).not.toContain("Additional context for this meeting");
    expect(withEmpty).toBe(withUndefined);
  });

  it("omits the whole speaker block when speakerLabels is empty, even with a non-empty meetingContext", () => {
    const prompt = buildEnhanceSystemPrompt(
      "en",
      [],
      [],
      undefined,
      "Call with Ana from Acme",
    );
    expect(prompt).not.toContain("diarized speaker labels");
    expect(prompt).not.toContain("Additional context for this meeting");
    expect(prompt).toBe(buildEnhanceSystemPrompt("en", []));
  });
});

describe("enhanceMeetingTranscript speaker/context prompt wiring (specs/meeting-speaker-naming.md §5.2/§5.4)", () => {
  it("threads meetingTitle/meetingContext through to buildEnhanceSystemPrompt unchanged", async () => {
    const segments = [seg("m1:system:0", "Them", "hi", 0, 1000, "3")];
    const llm = fakeLlm(() => ({ text: "{}" }));

    await runEnhance(segments, {
      llm,
      language: "en",
      title: "Weekly sync",
      context: "Call with Ana from Acme",
    });

    expect(llm.requests[0].system).toBe(
      buildEnhanceSystemPrompt(
        "en",
        [],
        ["3"],
        "Weekly sync",
        "Call with Ana from Acme",
      ),
    );
  });
});

/**
 * Pass accounting — the fix for "every chunk timed out and the user was told
 * nothing needed correcting" (real log, meeting 9243bea0: three `TimeoutError`
 * chunks 60 s apart → `200 { correctedCount: 0 }` → "No segments needed
 * correction."). Fail-closed per chunk is deliberately UNCHANGED — one bad
 * chunk must never kill a meeting. What changed is that the pass now reports
 * how many chunks it attempted, how many succeeded, how many failed, and why
 * the first one did, so the route can refuse to call a wholly-failed pass a
 * success (`routes/meetings.ts`).
 */
describe("enhanceMeetingTranscript pass accounting (all-chunks-failed is not a success)", () => {
  /** An `llmCall` that records requests and fails every one. */
  function failingLlm(err: () => unknown) {
    const requests: EnhanceLlmRequest[] = [];
    return {
      requests,
      call: async (request: EnhanceLlmRequest): Promise<EnhanceLlmResponse> => {
        requests.push(request);
        throw err();
      },
    };
  }

  /** The exact shape `AbortSignal.timeout()` rejects with (DOMException,
   *  name "TimeoutError") — what the user's log actually shows. */
  const timeoutError = () =>
    Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });

  const twoSegments = [
    seg("m1:mic:0", "Me", "a".repeat(200)),
    seg("m1:mic:1", "Them", "b".repeat(200), 1000, 2000, "1"),
  ];

  it("reports every chunk failed, reason 'timeout', when the engine times out", async () => {
    const llm = failingLlm(timeoutError);

    const result = await runEnhance(twoSegments, {
      llm,
      options: { contextBudgetTokens: 20 },
    });

    // The tiny budget forces each oversized segment into its own chunk, so
    // this is the multi-chunk shape of the real failure.
    expect(llm.requests.length).toBe(2);
    expect(result).toMatchObject({
      correctedCount: 0,
      speakerSuggestions: 0,
      chunksAttempted: 2,
      chunksSucceeded: 0,
      chunksFailed: 2,
      stoppedEarly: false,
    });
    expect(result.firstFailure?.reason).toBe("timeout");
    expect(result.firstFailure?.detail).toMatch(
      /TimeoutError: The operation was aborted due to timeout/,
    );
  });

  it("writes NO enhanced_text when every chunk failed — a failed pass never persists partial or echoed text", async () => {
    const llm = failingLlm(timeoutError);

    await runEnhance(twoSegments, {
      llm,
      options: { contextBudgetTokens: 20 },
    });

    const rows = getDb()
      .prepare(
        "SELECT id, enhanced_text FROM meeting_segments WHERE meeting_id = 'm1'",
      )
      .all() as { id: string; enhanced_text: string | null }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.enhanced_text, row.id).toBeNull();
    }
    // And no speaker-suggestion rows either: nothing was parsed.
    const speakers = getDb()
      .prepare("SELECT COUNT(*) AS n FROM meeting_speakers")
      .get() as { n: number };
    expect(speakers.n).toBe(0);
  });

  it("classifies a non-timeout call failure as 'provider' and names the cause in detail", async () => {
    const llm = failingLlm(
      () => new Error("503 Service Unavailable: no worker on :4321"),
    );

    const result = await runEnhance([seg("m1:mic:0", "Me", "hello")], { llm });

    expect(result).toMatchObject({
      correctedCount: 0,
      chunksAttempted: 1,
      chunksSucceeded: 0,
      chunksFailed: 1,
    });
    expect(result.firstFailure?.reason).toBe("provider");
    expect(result.firstFailure?.detail).toMatch(/503 Service Unavailable/);
  });

  it('accepts a timeout-shaped message from a non-DOMException Error as "timeout" too', async () => {
    const llm = failingLlm(() => new Error("upstream request timed out"));

    const result = await runEnhance([seg("m1:mic:0", "Me", "hello")], { llm });

    expect(result.firstFailure?.reason).toBe("timeout");
  });

  it("reports a chunk whose response carries no JSON as reason 'parse', with the other chunks still counted", async () => {
    const llm = fakeLlm((_request, index) =>
      index === 0
        ? { text: "I cannot help with that." }
        : { text: JSON.stringify({ "m1:mic:1": "fixed b" }) },
    );

    const result = await runEnhance(twoSegments, {
      llm,
      options: { contextBudgetTokens: 20 },
    });

    expect(result).toMatchObject({
      correctedCount: 1,
      chunksAttempted: 2,
      chunksSucceeded: 1,
      chunksFailed: 1,
      stoppedEarly: false,
    });
    expect(result.firstFailure).toEqual({
      reason: "parse",
      detail: "model response contained no JSON object",
    });
  });

  it("reports a successful pass honestly: zero failures, no firstFailure, and no failure when there was no work at all", async () => {
    const llm = fakeLlm(() => ({
      text: JSON.stringify({ "m1:mic:0": "hello there" }),
    }));

    const result = await runEnhance([seg("m1:mic:0", "Me", "hello")], { llm });

    expect(result).toEqual({
      correctedCount: 1,
      speakerSuggestions: 0,
      chunksAttempted: 1,
      chunksSucceeded: 1,
      chunksFailed: 0,
      stoppedEarly: false,
    });
    expect(result.firstFailure).toBeUndefined();

    // A pass with nothing to do attempts nothing — which is NOT a failure,
    // and the route must not read `chunksAttempted: 0` as one.
    const empty = await enhanceMeetingTranscript(
      "m1",
      [],
      undefined,
      [],
      undefined,
      undefined,
      { llmCall: llm.call },
    );
    expect(empty).toEqual({
      correctedCount: 0,
      speakerSuggestions: 0,
      chunksAttempted: 0,
      chunksSucceeded: 0,
      chunksFailed: 0,
      stoppedEarly: false,
    });
  });

  it("flags stoppedEarly when shouldStop ends the pass before the last chunk (§5.7)", async () => {
    let calls = 0;
    const llm = fakeLlm((_request, index) => {
      calls = index + 1;
      return { text: "{}" };
    });

    const result = await runEnhance(twoSegments, {
      llm,
      options: {
        contextBudgetTokens: 20,
        // Stop once the first chunk has come back: the second never goes out.
        shouldStop: () => calls >= 1,
      },
    });

    expect(result).toMatchObject({
      chunksAttempted: 1,
      chunksSucceeded: 1,
      chunksFailed: 0,
      stoppedEarly: true,
    });
  });

  // I2 (specs/meeting-transcription-v2.md §3.2): the auto-run job renders
  // done/total from this seam.
  it("reports onProgress after each completed chunk, in order", async () => {
    const progress: Array<{ done: number; total: number }> = [];
    const llm = fakeLlm(() => ({ text: "{}" }));

    await runEnhance(twoSegments, {
      llm,
      options: {
        contextBudgetTokens: 20, // forces two chunks
        onProgress: (p) => progress.push(p),
      },
    });

    expect(progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  it("reports onProgress for a failed chunk too, but never for a chunk skipped by shouldStop", async () => {
    const progress: Array<{ done: number; total: number }> = [];
    const llm = fakeLlm((_request, index) => {
      if (index === 0) throw new Error("provider down");
      return { text: "{}" };
    });

    await runEnhance(twoSegments, {
      llm,
      options: {
        contextBudgetTokens: 20,
        onProgress: (p) => progress.push(p),
      },
    });
    // Chunk 0 failed (still reported), chunk 1 succeeded.
    expect(progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);

    progress.length = 0;
    let calls = 0;
    const stopping = fakeLlm(() => {
      calls++;
      return { text: "{}" };
    });
    // Direct call (not runEnhance) so the m1 seed insert is not repeated;
    // a stopped pass corrects nothing, so no DB rows are needed.
    await enhanceMeetingTranscript(
      "m2",
      twoSegments,
      undefined,
      [],
      undefined,
      undefined,
      {
        llmCall: stopping.call,
        contextBudgetTokens: 20,
        shouldStop: () => calls >= 1, // stop before chunk 2 runs
        onProgress: (p) => progress.push(p),
      },
    );
    // Only the first chunk completed; the skipped one is not reported.
    expect(progress).toEqual([{ done: 1, total: 2 }]);
  });
});

// I2 (specs/meeting-transcription-v2.md §3.2): the auto-run rule is
// unchanged — only "true" turns it on; a missing row means off.
describe("getMeetingEnhanceAutoRunSetting", () => {
  afterEach(() => {
    deleteSetting("meeting_enhance_auto_run");
  });

  it("is off when the row is missing", () => {
    expect(getMeetingEnhanceAutoRunSetting()).toBe(false);
  });

  it('is on only for the exact value "true"', () => {
    writeSetting("meeting_enhance_auto_run", "true");
    expect(getMeetingEnhanceAutoRunSetting()).toBe(true);
  });

  it.each([
    "false",
    "yes",
    "1",
    "",
  ])("is off for %j (the validator keeps other values out, but the rule stays strict)", (value) => {
    writeSetting("meeting_enhance_auto_run", value);
    expect(getMeetingEnhanceAutoRunSetting()).toBe(false);
  });
});
