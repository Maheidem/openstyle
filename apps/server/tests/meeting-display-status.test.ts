import { afterEach, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { displayStatusOf } from "../src/lib/meetings/store.js";
import { insertSegment, resetMeetingTables } from "./helpers/meetings-db.js";

// The badge status of a meeting (PR #258): Enhance ok and Summary failed or
// partial shows "enhanced". Fictional rows only.

const app = createApp();

afterEach(() => resetMeetingTables());

function seed(
  id: string,
  status: string,
  o: { enhanced?: boolean; summary?: "none" | "complete" | "partial" } = {},
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO meetings (id, title, status, created_at) VALUES (?, 'Demo call', ?, 1)",
  ).run(id, status);
  insertSegment({
    id: `${id}-s0`,
    meetingId: id,
    idx: 0,
    startMs: 0,
    endMs: 1000,
    text: "we ship on friday",
  });
  if (o.enhanced) {
    db.prepare(
      "UPDATE meeting_segments SET enhanced_text = 'We ship on Friday.' WHERE id = ?",
    ).run(`${id}-s0`);
  }
  if (o.summary && o.summary !== "none") {
    db.prepare(
      "INSERT INTO meeting_summaries (meeting_id, markdown, created_at, partial) VALUES (?, '## Overview\nA demo.', 2, ?)",
    ).run(id, o.summary === "partial" ? 1 : 0);
  }
}

async function detail(id: string) {
  const res = await app.request(`/api/meetings/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    status: string;
    display_status: string;
    summary: { partial: boolean } | null;
  };
}

describe("displayStatusOf", () => {
  it("shows enhanced only for an enhanced transcript with no complete summary", () => {
    expect(displayStatusOf("transcribed", true, false)).toBe("enhanced");
    expect(displayStatusOf("summarized", true, true)).toBe("enhanced");
    expect(displayStatusOf("summarized", true, false)).toBe("summarized");
    expect(displayStatusOf("transcribed", false, false)).toBe("transcribed");
    expect(displayStatusOf("summarized", false, true)).toBe("summarized");
    expect(displayStatusOf("failed", true, false)).toBe("failed");
  });
});

describe("display_status in the meetings API", () => {
  it("Enhance ok + Summary failed: status transcribed, badge enhanced", async () => {
    seed("m-a", "transcribed", { enhanced: true });
    const body = await detail("m-a");
    expect(body.status).toBe("transcribed");
    expect(body.display_status).toBe("enhanced");
    expect(body.summary).toBeNull();
  });

  it("Enhance ok + partial summary: status summarized, badge enhanced, summary.partial true", async () => {
    seed("m-b", "summarized", { enhanced: true, summary: "partial" });
    const body = await detail("m-b");
    expect(body.status).toBe("summarized");
    expect(body.display_status).toBe("enhanced");
    expect(body.summary?.partial).toBe(true);
  });

  it("a complete summary keeps summarized; no Enhance keeps transcribed", async () => {
    seed("m-c", "summarized", { enhanced: true, summary: "complete" });
    seed("m-d", "transcribed");
    expect((await detail("m-c")).display_status).toBe("summarized");
    expect((await detail("m-c")).summary?.partial).toBe(false);
    expect((await detail("m-d")).display_status).toBe("transcribed");
  });

  it("the list rows carry the same display_status", async () => {
    seed("m-a", "transcribed", { enhanced: true });
    seed("m-c", "summarized", { enhanced: true, summary: "complete" });
    const res = await app.request("/api/meetings");
    const body = (await res.json()) as {
      items: { id: string; display_status: string }[];
    };
    const byId = Object.fromEntries(
      body.items.map((i) => [i.id, i.display_status]),
    );
    expect(byId).toEqual({ "m-a": "enhanced", "m-c": "summarized" });
  });
});
