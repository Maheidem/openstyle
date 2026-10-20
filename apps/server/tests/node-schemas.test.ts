// Schema tests for the three LLM nodes (specs/meeting-enhance-agentic.md
// 10.5.4 and 4.0.3). `assertPortableSchema` checks the strict-mode rules on the
// JSON Schema that the SDK builds from each zod object. The gateway changes no
// schema, so this is the check that keeps a schema portable across providers.
import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "../src/lib/db.js";
import {
  buildCorrectSystemPrompt,
  FULL_SEGMENT_RULE,
} from "../src/lib/meetings/workflow/prompts.js";
import {
  CORRECT_CHUNK_STEP_SCHEMA,
  CorrectChunkSchema,
  correctChunkStepSchema,
  IDENTIFY_SPEAKERS_STEP_SCHEMA,
  IdentifySpeakersSchema,
  identifySpeakersStepSchema,
  MEETING_SUMMARY_STEP_SCHEMA,
  MeetingSummarySchema,
  normalizeId,
  normalizeLabel,
} from "../src/lib/meetings/workflow/schemas.js";
import {
  NAME_MAX_CHARS,
  QUOTE_MAX_CHARS,
} from "../src/lib/meetings/workflow/types.js";
import {
  buildMeetingFixture,
  writeMeetingFixture,
} from "./helpers/meeting-fixture.js";

/** One line for each rule that a JSON Schema node breaks (L5, 4.0.3). */
function strictViolations(node: unknown, path = "$"): string[] {
  if (typeof node !== "object" || node === null) return [];
  const n = node as Record<string, unknown>;
  const out: string[] = [];
  if (n.type === "object") {
    const required = (n.required ?? []) as string[];
    if (n.additionalProperties !== false) {
      out.push(`${path}: additionalProperties must be false`);
    }
    for (const k of Object.keys((n.properties ?? {}) as object)) {
      if (!required.includes(k)) out.push(`${path}.${k}: not required`);
    }
    if ("patternProperties" in n || "propertyNames" in n) {
      out.push(`${path}: dynamic keys`);
    }
  }
  for (const key of [
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "pattern",
    "$ref",
  ]) {
    if (key in n) out.push(`${path}: ${key}`);
  }
  for (const [k, v] of Object.entries(n)) {
    out.push(...strictViolations(v, `${path}.${k}`));
  }
  return out;
}

async function assertPortableSchema(schema: z.ZodType): Promise<void> {
  const violations = strictViolations(await asSchema(schema).jsonSchema);
  if (violations.length > 0) {
    throw new Error(`Schema is not portable:\n${violations.join("\n")}`);
  }
}

const STEPS: readonly { name: string; version: number; zod: z.ZodType }[] = [
  CORRECT_CHUNK_STEP_SCHEMA,
  IDENTIFY_SPEAKERS_STEP_SCHEMA,
  MEETING_SUMMARY_STEP_SCHEMA,
];

describe("assertPortableSchema", () => {
  it.each(
    STEPS.map((s) => [s.name, s.zod] as const),
  )("%s has no strict-mode violation", async (_name, zod) => {
    await expect(assertPortableSchema(zod)).resolves.toBeUndefined();
  });

  it("the check finds the violations it names (control)", async () => {
    const bad = z.object({ a: z.string().optional(), b: z.string().max(5) });
    await expect(assertPortableSchema(bad)).rejects.toThrow(
      /\$\.a: not required/,
    );
    await expect(assertPortableSchema(bad)).rejects.toThrow(/maxLength/);
    const record = z.object({ r: z.record(z.string(), z.string()) });
    await expect(assertPortableSchema(record)).rejects.toThrow(
      /dynamic keys|propertyNames/,
    );
  });

  it("no schema holds a $ref", async () => {
    for (const s of STEPS) {
      expect(JSON.stringify(await asSchema(s.zod).jsonSchema)).not.toContain(
        "$ref",
      );
    }
  });
});

describe("the per-call schemas (ids and labels enum)", () => {
  const ids = ["fict-1:mic:0", "fict-1:system:1"];

  it("correctChunk: corrections[].id is an enum of exactly the unit ids; version 3", async () => {
    const step = correctChunkStepSchema(ids);
    expect(step.name).toBe("correct_chunk");
    expect(step.version).toBe(3);
    await expect(assertPortableSchema(step.zod)).resolves.toBeUndefined();
    const json = (await asSchema(step.zod).jsonSchema) as {
      properties: {
        corrections: { items: { properties: { id: unknown; text: unknown } } };
      };
    };
    expect(json.properties.corrections.items.properties.id).toEqual({
      type: "string",
      enum: ids,
    });
    // WP7: the full-segment rule travels with the schema, for every provider.
    expect(json.properties.corrections.items.properties.text).toEqual({
      type: "string",
      description: FULL_SEGMENT_RULE,
    });
    // One id is a valid enum.
    const one = (await asSchema(correctChunkStepSchema(["s1"]).zod)
      .jsonSchema) as typeof json;
    expect(one.properties.corrections.items.properties.id).toEqual({
      type: "string",
      enum: ["s1"],
    });
  });

  it("correctChunk: the system prompt says text is the complete segment, with an example", () => {
    const prompt = buildCorrectSystemPrompt({ language: "en", vocabTerms: [] });
    expect(prompt).toContain(FULL_SEGMENT_RULE);
    expect(FULL_SEGMENT_RULE).toContain("COMPLETE corrected segment");
    expect(FULL_SEGMENT_RULE).toContain("Never return only the changed words");
    expect(prompt).toContain(
      'text "we moved the cluster to Kubernetes last week."',
    );
    expect(prompt).toContain('Wrong output: text "Kubernetes".');
  });

  it("correctChunk: the parse strips brackets and keeps an unknown id for the node check", () => {
    const step = correctChunkStepSchema(ids);
    const parsed = step.zod.parse({
      corrections: [
        { id: " [fict-1:mic:0] ", text: "a" },
        { id: "other", text: "b" },
      ],
    });
    expect(parsed.corrections.map((c) => c.id)).toEqual([
      "fict-1:mic:0",
      "other",
    ]);
  });

  it("identifySpeakers: segmentId is an enum of the shown ids, label an enum of the label numbers; field order stays; version 4", async () => {
    const step = identifySpeakersStepSchema(ids, ["1", "2"]);
    expect(step.name).toBe("identify_speakers");
    expect(step.version).toBe(4);
    await expect(assertPortableSchema(step.zod)).resolves.toBeUndefined();
    const json = (await asSchema(step.zod).jsonSchema) as {
      properties: {
        speakers: {
          items: { properties: Record<string, unknown>; required: string[] };
        };
      };
    };
    const row = json.properties.speakers.items;
    expect(row.properties.segmentId).toEqual({ type: "string", enum: ids });
    expect(row.properties.label).toEqual({ type: "string", enum: ["1", "2"] });
    expect(Object.keys(row.properties)).toEqual([
      "segmentId",
      "quote",
      "label",
      "kind",
      "name",
    ]);
    expect(row.required).toEqual(Object.keys(row.properties));
    const parsed = step.zod.parse({
      speakers: [
        {
          segmentId: "[fict-1:system:1]",
          quote: "q",
          label: "Them 1",
          kind: "name",
          name: "Ana",
        },
      ],
    });
    expect(parsed.speakers[0]).toMatchObject({
      segmentId: "fict-1:system:1",
      label: "1",
    });
  });

  it("identifySpeakers: the default schema has no size keyword (portable)", async () => {
    const step = identifySpeakersStepSchema(ids, ["1", "2"]);
    const text = JSON.stringify(await asSchema(step.zod).jsonSchema);
    for (const key of ["maxItems", "maxLength", "minItems", "minLength"]) {
      expect(text).not.toContain(key);
    }
  });

  it("identifySpeakers: sizeLimits sets maxItems to the label count and maxLength on quote and name only", async () => {
    const step = identifySpeakersStepSchema(ids, ["1", "2", "2"], {
      sizeLimits: true,
    });
    expect(step.version).toBe(4);
    const json = (await asSchema(step.zod).jsonSchema) as {
      properties: {
        speakers: {
          maxItems?: number;
          items: { properties: Record<string, unknown>; required: string[] };
        };
      };
    };
    const arr = json.properties.speakers;
    // Two different labels: at most one entry for each.
    expect(arr.maxItems).toBe(2);
    expect(arr.items.properties.quote).toEqual({
      type: "string",
      maxLength: QUOTE_MAX_CHARS,
    });
    expect(arr.items.properties.name).toEqual({
      type: "string",
      maxLength: NAME_MAX_CHARS,
    });
    expect(arr.items.properties.segmentId).toEqual({
      type: "string",
      enum: ids,
    });
    // Field order and required stay as in the default schema.
    expect(Object.keys(arr.items.properties)).toEqual([
      "segmentId",
      "quote",
      "label",
      "kind",
      "name",
    ]);
    expect(arr.items.required).toEqual(Object.keys(arr.items.properties));
    // The zod side accepts any size: verifyEvidence drops a long quote alone.
    const long = "a".repeat(QUOTE_MAX_CHARS + 50);
    const entry = {
      segmentId: ids[0],
      quote: long,
      label: "1",
      kind: "name",
      name: "Ana",
    };
    const parsed = step.zod.parse({ speakers: [entry, entry, entry] });
    expect(parsed.speakers).toHaveLength(3);
    expect(parsed.speakers[0]?.quote).toBe(long);
  });

  it("identifySpeakers: the schema of one call holds only that call's ids; an id of another call is not in it", async () => {
    const callA = identifySpeakersStepSchema(["fict-1:system:1"], ["1"]);
    const callB = identifySpeakersStepSchema(["fict-1:system:7"], ["1"]);
    const segmentIdOf = async (step: typeof callA) =>
      (
        (await asSchema(step.zod).jsonSchema) as {
          properties: {
            speakers: { items: { properties: { segmentId: unknown } } };
          };
        }
      ).properties.speakers.items.properties.segmentId;
    expect(await segmentIdOf(callA)).toEqual({
      type: "string",
      enum: ["fict-1:system:1"],
    });
    expect(await segmentIdOf(callB)).toEqual({
      type: "string",
      enum: ["fict-1:system:7"],
    });
    // The zod side normalizes and keeps any string: the verify node drops an
    // id that the call did not show as unknown_segment (workflow-identify).
    const row = (segmentId: string) => ({
      segmentId,
      quote: "q",
      label: "1",
      kind: "name" as const,
      name: "Ana",
    });
    const parsed = callA.zod.parse({
      speakers: [row(" [fict-1:system:1] "), row("[fict-1:system:7]")],
    });
    expect(parsed.speakers.map((s) => s.segmentId)).toEqual([
      "fict-1:system:1",
      "fict-1:system:7",
    ]);
  });

  it.each([
    ["Them 1", "1"],
    ["them 1", "1"],
    ["THEM 2", "2"],
    ["Speaker 3", "3"],
    ["[1]", "1"],
    ["[Them 1]", "1"],
    [" 1 ", "1"],
    ["Them1", "1"],
    ["1", "1"],
  ])("normalizeLabel(%j) is %j", (input, out) => {
    expect(normalizeLabel(input)).toBe(out);
  });

  it.each([
    ["[fict-1:mic:0]", "fict-1:mic:0"],
    [" [fict-1:mic:0] ", "fict-1:mic:0"],
    ["fict-1:mic:0", "fict-1:mic:0"],
    ["[ s1 ]", "s1"],
    ["[a]b]", "a]b"],
    ["[unclosed", "[unclosed"],
  ])("normalizeId(%j) is %j", (input, out) => {
    expect(normalizeId(input)).toBe(out);
  });
});

describe("the step schemas", () => {
  it("names are wire-safe and versions start at 1", () => {
    for (const s of STEPS) {
      expect(s.name).toMatch(/^[A-Za-z0-9_]+$/);
      expect(s.version).toBe(1);
    }
    expect(new Set(STEPS.map((s) => s.name)).size).toBe(3);
  });

  it("the JSON Schema of each step is a snapshot (a change needs a graph version bump)", async () => {
    for (const s of STEPS) {
      expect({
        name: s.name,
        version: s.version,
        json: await asSchema(s.zod).jsonSchema,
      }).toMatchSnapshot(s.name);
    }
  });

  it("two different fictional meetings put the same schema JSON on the wire (R8)", async () => {
    const a = buildMeetingFixture({ chunks: 2, speakers: 2, meetingId: "m-a" });
    const b = buildMeetingFixture({
      chunks: 7,
      speakers: 4,
      meetingId: "m-b",
      selfIntroduction: true,
    });
    expect(a.segments.map((x) => x.text)).not.toEqual(
      b.segments.map((x) => x.text),
    );
    for (const s of STEPS) {
      const first = JSON.stringify(await asSchema(s.zod).jsonSchema);
      const second = JSON.stringify(await asSchema(s.zod).jsonSchema);
      expect(second).toBe(first);
    }
  });

  it("field order is generation order: segmentId and quote come before the name", () => {
    const keys = Object.keys(
      IdentifySpeakersSchema.shape.speakers.element.shape,
    );
    expect(keys.slice(0, 2)).toEqual(["segmentId", "quote"]);
  });
});

describe("parse cases", () => {
  it("CorrectChunk", () => {
    const ok = { corrections: [{ id: "s1", text: "fixed" }] };
    expect(CorrectChunkSchema.safeParse(ok).success).toBe(true);
    expect(CorrectChunkSchema.safeParse({ corrections: [] }).success).toBe(
      true,
    ); // empty array
    expect(CorrectChunkSchema.safeParse({ ...ok, extra: 1 }).success).toBe(
      true,
    ); // extra key is stripped
    expect(CorrectChunkSchema.safeParse({}).success).toBe(false); // missing key
    expect(
      CorrectChunkSchema.safeParse({ corrections: [{ id: "s1", text: 42 }] })
        .success,
    ).toBe(false); // wrong type
    expect(
      CorrectChunkSchema.safeParse({ corrections: [{ id: "s1", text: null }] })
        .success,
    ).toBe(false); // null not allowed
  });

  it("IdentifySpeakers", () => {
    const row = {
      segmentId: "s4",
      quote: "I am Sam",
      label: "2",
      kind: "name",
      name: "Sam",
    };
    expect(IdentifySpeakersSchema.safeParse({ speakers: [row] }).success).toBe(
      true,
    );
    expect(IdentifySpeakersSchema.safeParse({ speakers: [] }).success).toBe(
      true,
    );
    expect(
      IdentifySpeakersSchema.safeParse({
        speakers: [{ ...row, kind: "title" }],
      }).success,
    ).toBe(false);
    expect(
      IdentifySpeakersSchema.safeParse({
        speakers: [{ ...row, quote: undefined }],
      }).success,
    ).toBe(false);
    expect(
      IdentifySpeakersSchema.safeParse({ speakers: [{ ...row, name: null }] })
        .success,
    ).toBe(false);
    expect(IdentifySpeakersSchema.safeParse({}).success).toBe(false);
  });

  it("MeetingSummary", () => {
    const ok = {
      overview: "A short call.",
      keyPoints: ["a"],
      decisions: [],
      actionItems: [{ task: "send notes", owner: null, due: "next Friday" }],
      openQuestions: [],
    };
    expect(MeetingSummarySchema.safeParse(ok).success).toBe(true); // null owner is allowed
    expect(
      MeetingSummarySchema.safeParse({
        ...ok,
        actionItems: [{ task: "x", owner: "Sam", due: null }],
      }).success,
    ).toBe(true);
    expect(
      MeetingSummarySchema.safeParse({
        ...ok,
        actionItems: [{ task: "x", owner: "Sam" }],
      }).success,
    ).toBe(false); // missing key `due`
    expect(
      MeetingSummarySchema.safeParse({ ...ok, overview: null }).success,
    ).toBe(false);
    expect(
      MeetingSummarySchema.safeParse({ ...ok, keyPoints: "a" }).success,
    ).toBe(false);
    const { openQuestions: _drop, ...missing } = ok;
    expect(MeetingSummarySchema.safeParse(missing).success).toBe(false);
  });
});

describe("MeetingSummary: placeholder owner and due", () => {
  const base = {
    overview: "A short call.",
    keyPoints: [],
    decisions: [],
    openQuestions: [],
  };
  const parseItem = (owner: string | null, due: string | null) =>
    MeetingSummarySchema.parse({
      ...base,
      actionItems: [{ task: "x", owner, due }],
    }).actionItems[0];

  it.each([
    "",
    "  ",
    "null",
    "NULL",
    " Null ",
    "none",
    "None",
    "n/a",
    "N/A",
    "unknown",
    "Unknown",
  ])("%j parses to null", (word) => {
    expect(parseItem(word, word)).toEqual({
      task: "x",
      owner: null,
      due: null,
    });
  });

  it("a real value stays as written; null stays null", () => {
    expect(parseItem("Sam", "next Friday")).toEqual({
      task: "x",
      owner: "Sam",
      due: "next Friday",
    });
    expect(parseItem(null, null)).toEqual({
      task: "x",
      owner: null,
      due: null,
    });
    // A word that only holds a placeholder is not changed.
    expect(parseItem("Nonez", "unknown date")?.owner).toBe("Nonez");
  });

  it("the JSON Schema still allows null for owner and due (no wire change)", async () => {
    const json = (await asSchema(MeetingSummarySchema).jsonSchema) as {
      properties: {
        actionItems: { items: { properties: Record<string, unknown> } };
      };
    };
    const props = json.properties.actionItems.items.properties;
    for (const key of ["owner", "due"]) {
      expect(JSON.stringify(props[key])).toContain('"null"');
      expect(JSON.stringify(props[key])).toContain('"string"');
    }
    await expect(
      assertPortableSchema(MeetingSummarySchema),
    ).resolves.toBeUndefined();
  });
});

describe("the fictional meeting fixture", () => {
  it("builds chunks, speakers and a self-introduction", () => {
    const f = buildMeetingFixture({
      chunks: 6,
      speakers: 3,
      selfIntroduction: true,
    });
    expect(f.segmentIdsByChunk).toHaveLength(6);
    expect(f.segmentIdsByChunk.every((c) => c.length === 4)).toBe(true);
    const labels = new Set(f.segments.map((s) => s.speakerLabel));
    expect(labels).toEqual(new Set([null, "2", "3"]));
    expect(f.introducedName).toBe("Morgan Ellis");
    expect(f.segments.some((s) => s.text.includes("Morgan Ellis"))).toBe(true);
    // The calendar attendees are never spoken in the transcript.
    const text = f.segments.map((s) => s.text).join(" ");
    for (const a of f.calendar.attendees) expect(text).not.toContain(a.name);
  });

  it("writes the rows to a database and reads them back", () => {
    const f = buildMeetingFixture({
      chunks: 3,
      speakers: 2,
      meetingId: "fx-1",
    });
    const db = getDb();
    writeMeetingFixture(db, f, { withCalendar: true });
    const rows = db
      .prepare(
        "SELECT id, speaker_label, text FROM meeting_segments WHERE meeting_id = ? ORDER BY idx",
      )
      .all("fx-1") as {
      id: string;
      speaker_label: string | null;
      text: string;
    }[];
    expect(rows).toHaveLength(12);
    expect(rows[0]?.id).toBe(f.segments[0]?.id);
    const meeting = db
      .prepare("SELECT status, calendar_attendees FROM meetings WHERE id = ?")
      .get("fx-1") as { status: string; calendar_attendees: string };
    expect(meeting.status).toBe("transcribed");
    expect(JSON.parse(meeting.calendar_attendees)).toHaveLength(3);
  });
});
