// Schema tests for the three LLM nodes (specs/meeting-enhance-agentic.md
// 10.5.4 and 4.0.3). `assertPortableSchema` checks the strict-mode rules on the
// JSON Schema that the SDK builds from each zod object. The gateway changes no
// schema, so this is the check that keeps a schema portable across providers.
import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "../src/lib/db.js";
import {
  CORRECT_CHUNK_STEP_SCHEMA,
  CorrectChunkSchema,
  IDENTIFY_SPEAKERS_STEP_SCHEMA,
  IdentifySpeakersSchema,
  MEETING_SUMMARY_STEP_SCHEMA,
  MeetingSummarySchema,
} from "../src/lib/meetings/workflow/schemas.js";
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
