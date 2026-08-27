import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db.js";
import {
  chunkForEnhance,
  type EnhanceLlmRequest,
  type EnhanceLlmResponse,
  enhanceMeetingTranscript,
  extractJsonObject,
} from "../src/lib/meetings/enhance.js";
import { buildEnhanceSystemPrompt } from "../src/lib/meetings/enhance-prompt.js";
import type { MergedSegment } from "../src/lib/meetings/merge.js";

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
  const insert = getDb().prepare(
    `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
     VALUES (?, ?, 'mic', 0, 0, 1000, 'placeholder', 'ok')`,
  );
  for (const id of ids) insert.run(id, meetingId);
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
  getDb().exec("DELETE FROM meeting_segments");
  getDb().exec("DELETE FROM meetings");
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
    insertMeetingAndSegments("m1", ["m1:mic:0", "m1:mic:1"]);
    const segments = [
      seg("m1:mic:0", "Me", "garbled txt"),
      seg("m1:mic:1", "Me", "already fine"),
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({ "m1:mic:0": "corrected text" }),
    }));

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      {
        llmCall: llm.call,
      },
    );

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
    insertMeetingAndSegments("m1", ["m1:mic:0", "m1:mic:1"]);
    const segments = [
      seg("m1:mic:0", "Me", "a".repeat(200)),
      seg("m1:mic:1", "Me", "b".repeat(200)),
    ];
    const llm = fakeLlm((_request, index) =>
      index === 0
        ? { text: "not json at all, sorry" }
        : { text: JSON.stringify({ "m1:mic:1": "fixed" }) },
    );

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      undefined,
      [],
      undefined,
      undefined,
      { llmCall: llm.call, contextBudgetTokens: 20 },
    );

    // The tiny budget forces each oversized segment into its own chunk.
    expect(llm.requests.length).toBe(2);
    expect(result.correctedCount).toBe(1);
    const row = getDb()
      .prepare(
        "SELECT enhanced_text FROM meeting_segments WHERE id = 'm1:mic:1'",
      )
      .get() as { enhanced_text: string | null };
    expect(row.enhanced_text).toBe("fixed");
    const untouched = getDb()
      .prepare(
        "SELECT enhanced_text FROM meeting_segments WHERE id = 'm1:mic:0'",
      )
      .get() as { enhanced_text: string | null };
    expect(untouched.enhanced_text).toBeNull();
  });

  it("discards a returned id that isn't in the chunk's input segments", async () => {
    insertMeetingAndSegments("m1", ["m1:mic:0"]);
    const segments = [seg("m1:mic:0", "Me", "hello")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        "m1:mic:0": "fixed",
        "hallucinated:id": "should never be applied",
      }),
    }));

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      undefined,
      [],
      undefined,
      undefined,
      { llmCall: llm.call },
    );

    expect(result.correctedCount).toBe(1);
    const row = getDb()
      .prepare(
        "SELECT enhanced_text FROM meeting_segments WHERE id = 'm1:mic:0'",
      )
      .get() as { enhanced_text: string };
    expect(row.enhanced_text).toBe("fixed");
  });

  it("strips a leaked '<Speaker>: ' line-format prefix from the corrected text", async () => {
    // Real local models sometimes echo the "[id] Speaker:" input line
    // format back into the corrected-text value — verified against a real
    // meeting transcript (specs/meeting-transcription-quality.md real
    // E2E), where "Them" leaked into several corrections for system-
    // channel segments.
    insertMeetingAndSegments("m1", ["m1:system:0"]);
    const segments = [seg("m1:system:0", "Them", "garbled txt here")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({ "m1:system:0": "Them: garbled text here" }),
    }));

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      {
        llmCall: llm.call,
      },
    );

    expect(result.correctedCount).toBe(1);
    const row = getDb()
      .prepare(
        "SELECT enhanced_text FROM meeting_segments WHERE id = 'm1:system:0'",
      )
      .get() as { enhanced_text: string };
    expect(row.enhanced_text).toBe("garbled text here");
  });

  it("drops a correction that is only the leaked '<Speaker>: ' prefix plus the unchanged original", async () => {
    // Stripping the leaked prefix can reveal that the "correction" was a
    // no-op after all — the no-op guard must apply after stripping, not
    // before.
    insertMeetingAndSegments("m1", ["m1:system:0"]);
    const segments = [seg("m1:system:0", "Them", "already correct text")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({ "m1:system:0": "Them: already correct text" }),
    }));

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      {
        llmCall: llm.call,
      },
    );

    expect(result.correctedCount).toBe(0);
    const row = getDb()
      .prepare(
        "SELECT enhanced_text FROM meeting_segments WHERE id = 'm1:system:0'",
      )
      .get() as { enhanced_text: string | null };
    expect(row.enhanced_text).toBeNull();
  });

  it("drops a returned correction that echoes the segment's original text unchanged", async () => {
    // Real local models don't always honor "omit unchanged segments" —
    // verified against a real meeting transcript (specs/meeting-
    // transcription-quality.md real E2E), where the model occasionally
    // echoes a segment's exact original text back as a "correction".
    insertMeetingAndSegments("m1", ["m1:mic:0", "m1:mic:1"]);
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

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      {
        llmCall: llm.call,
      },
    );

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

    const result = await enhanceMeetingTranscript(
      "m1",
      [seg("m1:mic:0", "Me", "   ")],
      undefined,
      [],
      undefined,
      undefined,
      { llmCall: llm.call },
    );

    expect(result.correctedCount).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });

  it("skips segments with no id (nothing to map a correction back to)", async () => {
    const llm = fakeLlm(() => ({ text: "{}" }));

    const result = await enhanceMeetingTranscript(
      "m1",
      [{ speaker: "Me", startMs: 0, endMs: 1000, text: "hello" }],
      undefined,
      [],
      undefined,
      undefined,
      { llmCall: llm.call },
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
    insertMeetingAndSegments("m1", ["m1:system:0"]);
    const segments: MergedSegment[] = [
      {
        speaker: "Them",
        startMs: 0,
        endMs: 1000,
        text: "hi there",
        id: "m1:system:0",
        speakerLabel: "3",
        speakerName: "Ana", // already confirmed — formatted display is "Ana", not "Them 3"
      },
    ];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: { "3": { name: "Ana", evidence: "already known" } },
      }),
    }));

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      { llmCall: llm.call },
    );

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
    const row = getDb()
      .prepare(
        "SELECT suggested_name FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '3'",
      )
      .get() as { suggested_name: string };
    expect(row.suggested_name).toBe("Ana");
  });

  it("persists a well-formed speakers block for a real label without disturbing independent text corrections", async () => {
    insertMeetingAndSegments("m1", ["m1:system:0"]);
    const segments = [seg("m1:system:0", "Them", "garbled txt", 0, 1000, "3")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        "m1:system:0": "corrected text",
        speakers: {
          "3": { name: "Ana", evidence: "introduced herself as Ana" },
        },
      }),
    }));

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      { llmCall: llm.call },
    );

    expect(result.correctedCount).toBe(1);
    expect(result.speakerSuggestions).toBe(1);
    const row = getDb()
      .prepare(
        "SELECT suggested_name, suggested_evidence FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '3'",
      )
      .get() as { suggested_name: string; suggested_evidence: string };
    expect(row.suggested_name).toBe("Ana");
    expect(row.suggested_evidence).toBe("introduced herself as Ana");
  });

  it("drops a speakers entry naming a label not present in this meeting's speakerLabels, without throwing", async () => {
    insertMeetingAndSegments("m1", ["m1:system:0"]);
    const segments = [seg("m1:system:0", "Them", "hi", 0, 1000, "3")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: { "99": { name: "Ghost", evidence: "n/a" } },
      }),
    }));

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      { llmCall: llm.call },
    );

    expect(result.speakerSuggestions).toBe(0);
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM meeting_speakers WHERE meeting_id = 'm1'",
      )
      .get() as { c: number };
    expect(row.c).toBe(0);
  });

  it("drops a malformed speakers value (string/array/wrong-shaped entry); segment-text corrections in the same chunk still commit", async () => {
    insertMeetingAndSegments("m1", ["m1:system:0"]);
    const segments = [seg("m1:system:0", "Them", "garbled", 0, 1000, "3")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        "m1:system:0": "fixed",
        speakers: ["not", "an", "object"],
      }),
    }));

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      { llmCall: llm.call },
    );

    expect(result.correctedCount).toBe(1);
    expect(result.speakerSuggestions).toBe(0);
  });

  it("keeps the first chunk's name on a cross-chunk conflict for the same label, logging the conflict, no throw", async () => {
    insertMeetingAndSegments("m1", ["m1:system:0", "m1:system:1"]);
    const segments = [
      seg("m1:system:0", "Them", "a".repeat(200), 0, 1000, "3"),
      seg("m1:system:1", "Them", "b".repeat(200), 1000, 2000, "3"),
    ];
    const llm = fakeLlm((_request, index) => ({
      text: JSON.stringify({
        speakers: {
          "3": { name: index === 0 ? "Ana" : "Beatriz", evidence: "x" },
        },
      }),
    }));

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      { llmCall: llm.call, contextBudgetTokens: 20 },
    );

    expect(llm.requests.length).toBe(2);
    expect(result.speakerSuggestions).toBe(1);
    const row = getDb()
      .prepare(
        "SELECT suggested_name FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '3'",
      )
      .get() as { suggested_name: string };
    expect(row.suggested_name).toBe("Ana");
  });

  it("records one row (no conflict) when two chunks propose the same name (case-insensitive) for the same label", async () => {
    insertMeetingAndSegments("m1", ["m1:system:0", "m1:system:1"]);
    const segments = [
      seg("m1:system:0", "Them", "a".repeat(200), 0, 1000, "3"),
      seg("m1:system:1", "Them", "b".repeat(200), 1000, 2000, "3"),
    ];
    const llm = fakeLlm((_request, index) => ({
      text: JSON.stringify({
        // Same name, different case, from each chunk — must not be treated
        // as a conflict.
        speakers: { "3": { name: index === 0 ? "Ana" : "ANA", evidence: "x" } },
      }),
    }));

    const result = await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      { llmCall: llm.call, contextBudgetTokens: 20 },
    );

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
    insertMeetingAndSegments("m1", ["m1:mic:0"]);
    const segments = [seg("m1:mic:0", "Me", "hello")];
    const llm = fakeLlm(() => ({ text: "{}" }));

    await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      {
        llmCall: llm.call,
      },
    );

    expect(llm.requests[0].system).toBe(buildEnhanceSystemPrompt("en", []));
    expect(llm.requests[0].system).toBe(
      buildEnhanceSystemPrompt("en", [], [], undefined, undefined),
    );
  });

  it("never overwrites a confirmed display_name when a fresh suggestion for the same label arrives (ON CONFLICT DO UPDATE only ever writes suggested_name/suggested_evidence)", async () => {
    insertMeetingAndSegments("m1", ["m1:system:0"]);
    getDb()
      .prepare(
        `INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name, updated_at)
         VALUES ('m1', '3', 'Ana', ?)`,
      )
      .run(Date.now());
    const segments = [seg("m1:system:0", "Them", "hi", 0, 1000, "3")];
    const llm = fakeLlm(() => ({
      text: JSON.stringify({
        speakers: { "3": { name: "Beatriz", evidence: "different guess" } },
      }),
    }));

    await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      undefined,
      undefined,
      {
        llmCall: llm.call,
      },
    );

    const row = getDb()
      .prepare(
        "SELECT display_name, suggested_name FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '3'",
      )
      .get() as { display_name: string; suggested_name: string };
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
    insertMeetingAndSegments("m1", ["m1:system:0"]);
    const segments = [seg("m1:system:0", "Them", "hi", 0, 1000, "3")];
    const llm = fakeLlm(() => ({ text: "{}" }));

    await enhanceMeetingTranscript(
      "m1",
      segments,
      "en",
      [],
      "Weekly sync",
      "Call with Ana from Acme",
      { llmCall: llm.call },
    );

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
