// The MCP endpoint (specs/mcp.md): auth, both protocol eras, and one test for
// each tool through real JSON-RPC POSTs to /mcp. The last test fails when a
// registered tool has no test. Fictional data only.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTINGS_KEYS } from "@openstyle/validations";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import createApp from "../src/index.js";
import {
  APP_SETTINGS_WAIT_MS,
  type AppSettingsRequest,
  AppShellTimeoutError,
  handleAppSettingsResult,
  requestAppSettings,
  setAppSettingsSender,
} from "../src/lib/app-settings-bridge.js";
import { setAuthToken } from "../src/lib/auth.js";
import { appendMessage, createThread } from "../src/lib/chat/store.js";
import {
  deleteSetting,
  getDb,
  readSetting,
  writeSetting,
} from "../src/lib/db.js";
import { claimJob, releaseJob } from "../src/lib/meetings/job-registry.js";
import {
  addFinalLine,
  dropLive,
  openLive,
  setFinalText,
  setLiveStatus,
  setPartialLine,
} from "../src/lib/meetings/live/store.js";
import {
  SETTINGS_CATALOG,
  SETTINGS_EXCLUDED,
} from "../src/mcp/settings-catalog.js";
import { insertSegment, resetMeetingTables } from "./helpers/meetings-db.js";

const app = createApp();
const MCP_TOKEN = "mcp-test-token-fictional";
const SERVER_TOKEN = "server-test-token-fictional";
const URL_BASE = "http://127.0.0.1:45555";
const CONFIRM = "Ask the user, then call again with confirm: true";
const LIVE_OFF =
  "Live transcription is off. Turn it on with set_setting live_chat_enabled=true; it starts with the next recording.";

const covered = new Set<string>();
let scratch: string;
const savedHfCache = process.env.HUGGINGFACE_HUB_CACHE;

beforeAll(() => {
  // Model status reads the HF cache. Point it at an empty scratch folder.
  scratch = mkdtempSync(join(tmpdir(), "openstyle-mcp-test-"));
  process.env.HUGGINGFACE_HUB_CACHE = join(scratch, "hf");
});

afterAll(() => {
  if (savedHfCache === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
  else process.env.HUGGINGFACE_HUB_CACHE = savedHfCache;
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.OPENSTYLE_MCP_TOKEN = MCP_TOKEN;
  // The global auth is on: the in-process route calls must pass it.
  setAuthToken(SERVER_TOKEN);
});

afterEach(() => {
  delete process.env.OPENSTYLE_MCP_TOKEN;
  setAuthToken("");
  resetMeetingTables();
  const db = getDb();
  db.exec("DELETE FROM chat_messages");
  db.exec("DELETE FROM chat_threads");
  db.exec("DELETE FROM transcription_history");
  db.exec("DELETE FROM vocabulary");
  for (const key of [
    SETTINGS_KEYS.mcpEnabled,
    SETTINGS_KEYS.liveChatEnabled,
    SETTINGS_KEYS.theme,
  ]) {
    deleteSetting(key);
  }
});

interface PostOptions {
  token?: string | null;
  url?: string;
  headers?: Record<string, string>;
}

async function post(body: unknown, opts: PostOptions = {}): Promise<Response> {
  const token = opts.token === undefined ? MCP_TOKEN : opts.token;
  return app.request(opts.url ?? `${URL_BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      "X-Openstyle-Agent": "vitest",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...opts.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let nextId = 1;
async function rpc(method: string, params?: unknown) {
  const res = await post({ jsonrpc: "2.0", id: nextId++, method, params });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  return (await res.json()) as {
    result?: Record<string, unknown>;
    error?: { message: string };
  };
}

interface ToolOutcome {
  isError: boolean;
  text: string;
  data: any;
}

async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  covered.add(name);
  const body = await rpc("tools/call", { name, arguments: args });
  expect(body.error).toBeUndefined();
  const result = body.result as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = result.content[0]?.text ?? "";
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // An error text.
  }
  return { isError: result.isError === true, text, data };
}

async function ok(name: string, args: Record<string, unknown> = {}) {
  const outcome = await call(name, args);
  expect(outcome.isError, outcome.text).toBe(false);
  return outcome.data;
}

function insertMeeting(
  id: string,
  o: {
    title?: string;
    status?: string;
    folderId?: string | null;
    startedAt?: number;
  } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO meetings (id, title, status, started_at, created_at, folder_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      o.title ?? `Meeting ${id}`,
      o.status ?? "transcribed",
      o.startedAt ?? 1_780_000_000_000,
      o.startedAt ?? 1_780_000_000_000,
      o.folderId ?? null,
    );
}

function insertFolder(id: string, name: string): void {
  getDb()
    .prepare(
      `INSERT INTO meeting_folders (id, name, description, created_at, updated_at)
       VALUES (?, ?, 'Fictional harbor project', 1, 1)`,
    )
    .run(id, name);
}

function insertDictation(text: string): number {
  const result = getDb()
    .prepare(
      `INSERT INTO transcription_history (raw_text, cleaned_text, voice_provider, voice_model)
       VALUES (?, ?, 'local-mlx', 'fictional-asr')`,
    )
    .run(text, text);
  return Number(result.lastInsertRowid);
}

function meetingRow(id: string) {
  return getDb().prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
}

describe("/mcp access", () => {
  const listBody = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  it("gives 404 when OPENSTYLE_MCP_TOKEN is not set", async () => {
    delete process.env.OPENSTYLE_MCP_TOKEN;
    expect((await post(listBody)).status).toBe(404);
  });

  it("gives 401 for a missing or wrong token", async () => {
    expect((await post(listBody, { token: null })).status).toBe(401);
    expect((await post(listBody, { token: "wrong" })).status).toBe(401);
    // The server token of the REST API does not open /mcp.
    expect((await post(listBody, { token: SERVER_TOKEN })).status).toBe(401);
  });

  it("refuses a request with no Origin and no token, also with the trusted-origin fallback on", async () => {
    setAuthToken(SERVER_TOKEN, { allowTrustedOriginFallback: true });
    expect((await post(listBody, { token: null })).status).toBe(401);
  });

  it("accepts only a loopback host", async () => {
    const bad = await post(listBody, { url: "http://openstyle.example/mcp" });
    expect(bad.status).toBe(403);
    for (const host of ["127.0.0.1:45555", "localhost:3000", "[::1]:45555"]) {
      const res = await post(listBody, { url: `http://${host}/mcp` });
      expect(res.status, host).toBe(200);
    }
  });

  it("refuses a foreign Origin", async () => {
    const res = await post(listBody, {
      headers: { Origin: "https://attacker.example" },
    });
    expect(res.status).toBe(403);
  });

  it("gives 403 with a clear message when mcp_enabled is false", async () => {
    writeSetting(SETTINGS_KEYS.mcpEnabled, "false");
    const res = await post(listBody);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Agent access is off. Turn on Settings > Agents (MCP) in Openstyle.",
    );
    writeSetting(SETTINGS_KEYS.mcpEnabled, "true");
    expect((await post(listBody)).status).toBe(200);
  });

  it("answers GET and DELETE with 405 (stateless)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request(`${URL_BASE}/mcp`, {
        method,
        headers: { Authorization: `Bearer ${MCP_TOKEN}` },
      });
      expect(res.status, method).toBe(405);
    }
  });

  it("gives 400 for a body that is not JSON", async () => {
    expect((await post("{not json")).status).toBe(400);
  });

  it("serves the 2025 handshake (initialize) with JSON", async () => {
    const body = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1" },
    });
    expect(body.result?.serverInfo).toMatchObject({ name: "openstyle" });
  });

  it("serves a 2026-07-28 request with JSON", async () => {
    insertMeeting("m-modern");
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "get_meeting",
          arguments: { meeting_id: "m-modern" },
          _meta: meta,
        },
      },
      {
        headers: {
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "get_meeting",
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(body.result.content[0].text).id).toBe("m-modern");
  });

  it("sets the annotations on every tool", async () => {
    const body = await rpc("tools/list");
    const tools = body.result?.tools as {
      name: string;
      annotations: Record<string, boolean>;
      inputSchema: { properties?: Record<string, unknown> };
    }[];
    for (const tool of tools) {
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint, tool.name).toBe(
        "boolean",
      );
      expect(typeof tool.annotations.idempotentHint, tool.name).toBe("boolean");
      if (tool.name.startsWith("delete_")) {
        expect(tool.annotations.destructiveHint, tool.name).toBe(true);
        expect(tool.inputSchema.properties?.confirm, tool.name).toBeDefined();
      }
    }
  });
});

describe("change emitter", () => {
  it("posts an agent-change message to the parent after a write", async () => {
    const messages: unknown[] = [];
    const proc = process as NodeJS.Process & { parentPort?: unknown };
    proc.parentPort = { postMessage: (m: unknown) => messages.push(m) };
    try {
      insertMeeting("m-emit");
      await ok("update_meeting", { meeting_id: "m-emit", title: "Dock plan" });
      await ok("get_meeting", { meeting_id: "m-emit" });
    } finally {
      delete proc.parentPort;
    }
    expect(messages).toEqual([
      { type: "agent-change", kind: "meeting", ids: ["m-emit"], keys: [] },
    ]);
  });
});

describe("meeting tools", () => {
  it("list_meetings lists all meetings or one folder", async () => {
    insertFolder("f1", "Harbor");
    insertMeeting("m1", { folderId: "f1" });
    insertMeeting("m2");
    expect((await ok("list_meetings")).total).toBe(2);
    const inFolder = await ok("list_meetings", { folder_id: "f1" });
    expect(inFolder.items.map((m: { id: string }) => m.id)).toEqual(["m1"]);
  });

  it("list_meetings gives short rows, one page at a time (issue #431)", async () => {
    // 45 meetings with long notes: the full rows would not fit inline.
    for (let i = 0; i < 45; i++) {
      insertMeeting(`m${String(i).padStart(2, "0")}`, {
        startedAt: 1_780_000_000_000 + i * 1000,
      });
    }
    getDb()
      .prepare("UPDATE meetings SET context = ?")
      .run("Fictional notes about the harbor. ".repeat(40));
    await ok("set_meeting_tags", { meeting_id: "m44", tags: ["harbor"] });
    const page1 = await ok("list_meetings");
    expect(page1).toMatchObject({
      total: 45,
      offset: 0,
      limit: 20,
      next_offset: 20,
    });
    expect(page1.items).toHaveLength(20);
    // Newest first, and only the short fields: no notes, summary or text.
    expect(page1.items[0]).toEqual({
      id: "m44",
      title: "Meeting m44",
      started_at: 1_780_000_044_000,
      duration_ms: null,
      status: "transcribed",
      folder_id: null,
      tags: ["harbor"],
      job: null,
    });
    expect(JSON.stringify(page1)).not.toContain("Fictional notes");
    const last = await ok("list_meetings", { offset: 40, limit: 100 });
    expect(last).toMatchObject({ total: 45, offset: 40, next_offset: null });
    expect(last.items.map((m: { id: string }) => m.id)).toEqual([
      "m04",
      "m03",
      "m02",
      "m01",
      "m00",
    ]);
    const tooBig = await call("list_meetings", { limit: 101 });
    expect(tooBig.isError).toBe(true);
  });

  it("GET /api/meetings keeps its old answer for the app, and pages on request", async () => {
    for (let i = 0; i < 3; i++) insertMeeting(`m${i}`);
    const get = (q: string) =>
      app.request(`${URL_BASE}/api/meetings${q}`, {
        headers: { Authorization: `Bearer ${SERVER_TOKEN}` },
      });
    const full = (await (await get("")).json()) as {
      items: { id: string; context: unknown }[];
      total: number;
    };
    expect(full.total).toBe(3);
    expect(full.items).toHaveLength(3);
    expect(full.items[0]).toHaveProperty("context");
    const page = (await (await get("?limit=1&offset=1")).json()) as {
      items: unknown[];
      total: number;
    };
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
  });

  it("get_meeting gives the meeting, and an error for an unknown id", async () => {
    insertMeeting("m1", { title: "Tide chart review" });
    expect((await ok("get_meeting", { meeting_id: "m1" })).title).toBe(
      "Tide chart review",
    );
    const missing = await call("get_meeting", { meeting_id: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("Not found");
  });

  it("update_meeting changes the fields, and gives 409 while a job runs", async () => {
    insertMeeting("m1");
    await ok("update_meeting", {
      meeting_id: "m1",
      title: "Buoy budget",
      language: "pt",
      context: "Fictional context",
    });
    const row = meetingRow("m1");
    expect(row).toMatchObject({
      title: "Buoy budget",
      language: "pt",
      context: "Fictional context",
    });
    claimJob("m1", "summarize", { done: 0, total: 1, failed: 0 });
    try {
      const busy = await call("update_meeting", {
        meeting_id: "m1",
        title: "X",
      });
      expect(busy.isError).toBe(true);
      expect(busy.text).toContain("409");
    } finally {
      releaseJob("m1");
    }
    expect(meetingRow("m1")?.title).toBe("Buoy budget");
  });

  it("set_calendar_link links and unlinks an event", async () => {
    insertMeeting("m1", { title: "" });
    await ok("set_calendar_link", {
      meeting_id: "m1",
      event: {
        id: "evt-1",
        title: "Pier sync",
        start: 1_780_000_000_000,
        end: 1_780_000_900_000,
        url: null,
        attendees: [
          { name: "Ana Ribeiro", email: "ana@example.com", isOrganizer: true },
        ],
      },
    });
    expect(meetingRow("m1")).toMatchObject({
      calendar_event_id: "evt-1",
      title: "Pier sync",
    });
    await ok("set_calendar_link", { meeting_id: "m1", event: null });
    expect(meetingRow("m1")?.calendar_event_id).toBeNull();
  });

  it("set_meeting_tags and list_tags", async () => {
    insertMeeting("m1");
    expect(
      (
        await ok("set_meeting_tags", {
          meeting_id: "m1",
          tags: ["harbor", "budget"],
        })
      ).tags,
    ).toEqual(expect.arrayContaining(["harbor", "budget"]));
    const tags = await ok("list_tags");
    expect(tags.items.map((t: { name: string }) => t.name).sort()).toEqual([
      "budget",
      "harbor",
    ]);
  });

  it("move_meetings moves into a folder and out again", async () => {
    insertFolder("f1", "Harbor");
    insertMeeting("m1");
    await ok("move_meetings", { meeting_ids: ["m1"], folder_id: "f1" });
    expect(meetingRow("m1")?.folder_id).toBe("f1");
    await ok("move_meetings", { meeting_ids: ["m1"], folder_id: null });
    expect(meetingRow("m1")?.folder_id).toBeNull();
  });

  it("delete_meeting needs confirm: true", async () => {
    insertMeeting("m1");
    const refused = await call("delete_meeting", { meeting_id: "m1" });
    expect(refused).toMatchObject({ isError: true, text: CONFIRM });
    expect(meetingRow("m1")).toBeDefined();
    await ok("delete_meeting", { meeting_id: "m1", confirm: true });
    expect(meetingRow("m1")).toBeUndefined();
    const missing = await call("delete_meeting", {
      meeting_id: "m1",
      confirm: true,
    });
    expect(missing.isError).toBe(true);
  });

  it("get_meeting stored_asr_segments counts stored rows, get_transcript the merged segments (issue #433)", async () => {
    insertMeeting("m1");
    // Two lines with text, one empty chunk and one failed chunk.
    insertSegment({
      id: "s0",
      meetingId: "m1",
      idx: 0,
      startMs: 0,
      endMs: 900,
      text: "The pier opens at nine.",
    });
    insertSegment({
      id: "s1",
      meetingId: "m1",
      idx: 1,
      startMs: 1000,
      endMs: 1900,
      text: "",
    });
    insertSegment({
      id: "s2",
      meetingId: "m1",
      idx: 2,
      startMs: 2000,
      endMs: 2900,
      text: "We move the buoys.",
    });
    insertSegment({
      id: "s3",
      meetingId: "m1",
      idx: 3,
      startMs: 3000,
      endMs: 3900,
      text: null,
      status: "failed",
    });
    const meeting = await ok("get_meeting", { meeting_id: "m1" });
    expect(meeting.stored_asr_segments).toEqual({ total: 4, failed: 1 });
    expect(meeting).not.toHaveProperty("segment_counts");
    const transcript = await ok("get_transcript", { meeting_id: "m1" });
    expect(transcript.total).toBe(2);
  });

  it("search_meetings refuses more hits than the route allows", async () => {
    const big = await call("search_meetings", { query: "pier", k: 51 });
    expect(big.isError).toBe(true);
  });

  it("search_meetings answers, with the reason when search is off", async () => {
    insertMeeting("m1");
    const data = await ok("search_meetings", { query: "tide chart" });
    expect(["ok", "off"]).toContain(data.status);
  });

  it("get_live_transcript: live off, no recording, then lines with a cursor", async () => {
    const off = await call("get_live_transcript");
    expect(off).toMatchObject({ isError: true, text: LIVE_OFF });

    writeSetting(SETTINGS_KEYS.liveChatEnabled, "true");
    const none = await call("get_live_transcript");
    expect(none).toMatchObject({
      isError: true,
      text: "No recording is running",
    });

    insertMeeting("m-rec", { status: "recording" });
    openLive("m-rec");
    try {
      setLiveStatus("m-rec", "ready");
      addFinalLine("m-rec", {
        source: "mic",
        startMs: 0,
        endMs: 1200,
        text: "The pier opens at nine.",
        final: true,
      });
      addFinalLine("m-rec", {
        source: "system",
        startMs: 1300,
        endMs: 2500,
        text: "Then we move the buoys.",
        final: true,
      });
      setPartialLine("m-rec", "mic", {
        source: "mic",
        startMs: 2600,
        endMs: 3000,
        text: "And the",
      });
      const first = await ok("get_live_transcript");
      expect(first).toMatchObject({
        meeting_id: "m-rec",
        recording: true,
        paused: false,
        live_transcriber: "ready",
        live_transcriber_reason: null,
      });
      expect(first.lines.map((l: { text: string }) => l.text)).toEqual([
        "The pier opens at nine.",
        "Then we move the buoys.",
      ]);
      expect(first.partial).toHaveLength(1);
      expect(first.cursor).toBe(first.lines[1].seq);

      addFinalLine("m-rec", {
        source: "mic",
        startMs: 2600,
        endMs: 3400,
        text: "And the dock closes.",
        final: true,
      });
      const next = await ok("get_live_transcript", {
        meeting_id: "m-rec",
        since_seq: first.cursor,
      });
      expect(next.lines.map((l: { text: string }) => l.text)).toEqual([
        "And the dock closes.",
      ]);
      expect(next.cursor).toBeGreaterThan(first.cursor);
      const empty = await ok("get_live_transcript", {
        since_seq: next.cursor,
      });
      expect(empty.lines).toEqual([]);
      expect(empty.cursor).toBe(next.cursor);

      // The user pauses the recording: the meeting still records.
      await app.request(`${URL_BASE}/api/meetings/m-rec/paused`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${SERVER_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ paused: true }),
      });
      expect(await ok("get_live_transcript")).toMatchObject({
        recording: true,
        paused: true,
      });
    } finally {
      dropLive("m-rec");
    }
  });

  // issue #434, as seen on a real recording: poll 2 got a mic line that ends
  // at 69840 and a system line that ends at 66990. A system line that ends
  // between them became final after that poll.
  it("get_live_transcript: a late line of the other channel is not skipped (issue #434)", async () => {
    writeSetting(SETTINGS_KEYS.liveChatEnabled, "true");
    insertMeeting("m-rec", { status: "recording" });
    openLive("m-rec");
    try {
      setLiveStatus("m-rec", "ready");
      addFinalLine("m-rec", {
        source: "system",
        startMs: 65810,
        endMs: 66990,
        text: "The ferry is late today.",
        final: true,
      });
      addFinalLine("m-rec", {
        source: "mic",
        startMs: 62700,
        endMs: 69840,
        text: "Then we load the trucks first and the cars after them.",
        final: true,
      });
      const poll2 = await ok("get_live_transcript");
      expect(poll2.lines).toHaveLength(2);
      // The system channel finishes the line 67000-68500 after poll 2.
      addFinalLine("m-rec", {
        source: "system",
        startMs: 67000,
        endMs: 68500,
        text: "The north ramp stays closed.",
        final: true,
      });
      const late = "The north ramp stays closed.";
      // The old cursor (the latest end time, 69840) skips the late line.
      const byTime = await ok("get_live_transcript", { since_ms: 69840 });
      expect(byTime.lines.map((l: { text: string }) => l.text)).not.toContain(
        late,
      );
      // The seq cursor gives it.
      const poll3 = await ok("get_live_transcript", {
        since_seq: poll2.cursor,
      });
      expect(poll3.lines.map((l: { text: string }) => l.text)).toEqual([late]);
      // A text that the language lock reads again comes once more.
      setFinalText("m-rec", "system", 65810, "The ferry is late this morning.");
      const poll4 = await ok("get_live_transcript", {
        since_seq: poll3.cursor,
      });
      expect(poll4.lines).toMatchObject([
        {
          source: "system",
          startMs: 65810,
          text: "The ferry is late this morning.",
        },
      ]);
    } finally {
      dropLive("m-rec");
    }
  });

  it("get_transcript pages the segments and lists the speakers", async () => {
    insertMeeting("m1");
    for (let i = 0; i < 3; i++) {
      insertSegment({
        id: `s${i}`,
        meetingId: "m1",
        idx: i,
        startMs: i * 1000,
        endMs: i * 1000 + 900,
        text: `Line ${i} about the harbor`,
        speakerLabel: "S1",
      });
    }
    const page1 = await ok("get_transcript", { meeting_id: "m1", limit: 2 });
    expect(page1).toMatchObject({ total: 3, offset: 0, next_offset: 2 });
    expect(page1.segments).toHaveLength(2);
    expect(page1.speakers.speakers[0].label).toBe("S1");
    const page2 = await ok("get_transcript", {
      meeting_id: "m1",
      offset: page1.next_offset,
      limit: 2,
    });
    expect(page2).toMatchObject({ total: 3, offset: 2, next_offset: null });
    expect(page2.segments).toHaveLength(1);
  });

  it("update_speaker names a speaker", async () => {
    insertMeeting("m1");
    insertSegment({
      id: "s1",
      meetingId: "m1",
      idx: 0,
      startMs: 0,
      endMs: 900,
      speakerLabel: "S1",
    });
    await ok("update_speaker", {
      meeting_id: "m1",
      label: "S1",
      display_name: "Bruno Costa",
    });
    const row = getDb()
      .prepare(
        "SELECT display_name FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = 'S1'",
      )
      .get() as { display_name: string };
    expect(row.display_name).toBe("Bruno Costa");
  });

  it("get_summary_versions lists the older summaries", async () => {
    insertMeeting("m1");
    getDb()
      .prepare(
        `INSERT INTO meeting_summary_versions (meeting_id, markdown, created_at, replaced_at)
         VALUES ('m1', '# Old summary', 1, 2)`,
      )
      .run();
    const data = await ok("get_summary_versions", { meeting_id: "m1" });
    expect(data.items).toHaveLength(1);
    expect(data.items[0].markdown).toBe("# Old summary");
  });

  it("start_meeting_job passes the route refusal through", async () => {
    insertMeeting("m1", { status: "recorded" });
    const refused = await call("start_meeting_job", {
      meeting_id: "m1",
      kind: "diarize",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Meeting has no transcript to diarize");
    const missing = await call("start_meeting_job", {
      meeting_id: "nope",
      kind: "transcribe",
    });
    expect(missing.isError).toBe(true);
  });

  it("cancel_meeting_job stops a job, and gives 409 with no job", async () => {
    insertMeeting("m1");
    const none = await call("cancel_meeting_job", { meeting_id: "m1" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("409");
    claimJob("m1", "transcribe", { done: 0, total: 4, failed: 0 });
    try {
      expect((await ok("cancel_meeting_job", { meeting_id: "m1" })).ok).toBe(
        true,
      );
    } finally {
      releaseJob("m1");
    }
  });

  it("list_jobs lists the running meeting jobs", async () => {
    insertMeeting("m1", { title: "Crane rental" });
    claimJob("m1", "summarize", { done: 1, total: 3, failed: 0 });
    try {
      const data = await ok("list_jobs");
      expect(data.meetings).toEqual([
        expect.objectContaining({ meeting_id: "m1", kind: "summarize" }),
      ]);
    } finally {
      releaseJob("m1");
    }
  });
});

describe("folder tools", () => {
  it("create_folder, update_folder and list_folders", async () => {
    const created = await ok("create_folder", {
      name: "Lighthouse",
      description: "Fictional restoration",
      color: "teal",
    });
    const dup = await call("create_folder", { name: "Lighthouse" });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain("409");
    await ok("update_folder", { folder_id: created.id, name: "Lighthouse 2" });
    const list = await ok("list_folders");
    expect(list.items.map((f: { name: string }) => f.name)).toEqual([
      "Lighthouse 2",
    ]);
  });

  it("delete_folder needs confirm and an empty folder", async () => {
    insertFolder("f1", "Harbor");
    insertMeeting("m1", { folderId: "f1" });
    expect(await call("delete_folder", { folder_id: "f1" })).toMatchObject({
      isError: true,
      text: CONFIRM,
    });
    const full = await call("delete_folder", {
      folder_id: "f1",
      confirm: true,
    });
    expect(full.isError).toBe(true);
    expect(full.text).toContain("Move the meetings");
    getDb().prepare("DELETE FROM meetings WHERE id = 'm1'").run();
    await ok("delete_folder", { folder_id: "f1", confirm: true });
    expect(
      getDb().prepare("SELECT id FROM meeting_folders WHERE id = 'f1'").get(),
    ).toBeUndefined();
  });

  it("get_folder_overview and set_action_item_done", async () => {
    insertFolder("f1", "Harbor");
    insertMeeting("m1", { folderId: "f1", status: "summarized" });
    getDb()
      .prepare(
        `INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, created_at)
         VALUES ('m1', '# Summary', ?, 1)`,
      )
      .run(
        JSON.stringify({
          overview: "",
          keyPoints: [],
          decisions: [],
          actionItems: [{ task: "Paint the pier", owner: null, due: null }],
          openQuestions: [],
        }),
      );
    const overview = await ok("get_folder_overview", { folder_id: "f1" });
    expect(overview.action_items).toHaveLength(1);
    expect(overview.counts.with_summary).toBe(1);
    expect(overview.counts).not.toHaveProperty("summarized");
    expect(overview.counts).not.toHaveProperty("stage_counts");
    const key = overview.action_items[0].key as string;
    await ok("set_action_item_done", { folder_id: "f1", key, done: true });
    const state = getDb()
      .prepare(
        "SELECT done FROM folder_action_item_state WHERE folder_id = 'f1' AND item_key = ?",
      )
      .get(key) as { done: number };
    expect(state.done).toBe(1);
    getDb().exec("DELETE FROM folder_action_item_state");
  });

  it("with_summary and need_stage.summarize can both count a meeting (issue #433)", async () => {
    insertFolder("f1", "Harbor");
    // m1 was transcribed again after its summary: it has a summary, and the
    // status 'transcribed' says that the summary is for an older transcript.
    insertMeeting("m1", { folderId: "f1", status: "transcribed" });
    insertMeeting("m2", { folderId: "f1", status: "transcribed" });
    for (const id of ["m1", "m2"]) {
      insertSegment({
        id: `s-${id}`,
        meetingId: id,
        idx: 0,
        startMs: 0,
        endMs: 900,
        text: "The pier opens at nine.",
      });
    }
    getDb()
      .prepare(
        `INSERT INTO meeting_summaries (meeting_id, markdown, created_at)
         VALUES ('m1', '# Old summary', 1)`,
      )
      .run();
    const { counts } = await ok("get_folder_overview", { folder_id: "f1" });
    expect(counts.with_summary).toBe(1);
    const summarize = counts.need_stage.summarize;
    expect(summarize.ready + summarize.blocked).toBe(2);
    const folders = await ok("list_folders");
    expect(folders.items[0].need_stage).toEqual(counts.need_stage);
    expect(folders.items[0]).not.toHaveProperty("stage_counts");
  });

  it("get_folder_standing reads the saved text", async () => {
    insertFolder("f1", "Harbor");
    const data = await ok("get_folder_standing", { folder_id: "f1" });
    expect(data).toBeTypeOf("object");
    const missing = await call("get_folder_standing", { folder_id: "nope" });
    expect(missing.isError).toBe(true);
  });
});

describe("Ask and dictation tools", () => {
  it("list_ask_threads and get_ask_thread", async () => {
    const db = getDb();
    const thread = createThread(db, { kind: "all" });
    if (!thread) throw new Error("no thread");
    appendMessage(db, thread.id, {
      role: "user",
      content: "When does the pier open?",
    });
    const list = await ok("list_ask_threads");
    expect(list).toMatchObject({ total: 1, offset: 0, next_offset: null });
    expect(list.items.map((t: { id: string }) => t.id)).toEqual([thread.id]);
    const detail = await ok("get_ask_thread", { thread_id: thread.id });
    expect(detail.messages[0].content).toBe("When does the pier open?");
  });

  it("list_dictations, get_dictation and delete_dictation", async () => {
    const id = insertDictation("Order more rope for the dock");
    insertDictation("Call the harbor master");
    const list = await ok("list_dictations", { search: "rope" });
    expect(list.items.map((d: { id: number }) => d.id)).toEqual([id]);
    const page = await ok("list_dictations", { limit: 1 });
    expect(page).toMatchObject({ total: 2, limit: 1, next_offset: 1 });
    expect(page.items).toHaveLength(1);
    expect((await ok("get_dictation", { dictation_id: id })).raw_text).toBe(
      "Order more rope for the dock",
    );
    expect(await call("delete_dictation", { dictation_id: id })).toMatchObject({
      isError: true,
      text: CONFIRM,
    });
    await ok("delete_dictation", { dictation_id: id, confirm: true });
    expect((await call("get_dictation", { dictation_id: id })).isError).toBe(
      true,
    );
  });
});

describe("vocabulary tools", () => {
  it("add, list, update and delete", async () => {
    const added = await ok("add_vocabulary", {
      entries: [
        { term: "Ribeira Pier", notes: "A fictional place" },
        { term: "Bollard" },
      ],
    });
    expect(added.imported).toBe(2);
    const list = await ok("list_vocabulary", { search: "Ribeira" });
    expect(list.items).toHaveLength(1);
    const id = list.items[0].id as number;
    await ok("update_vocabulary", {
      vocabulary_id: id,
      notes: "Say ri-BAY-ra",
    });
    expect(
      (
        getDb()
          .prepare("SELECT notes FROM vocabulary WHERE id = ?")
          .get(id) as {
          notes: string;
        }
      ).notes,
    ).toBe("Say ri-BAY-ra");
    expect(
      await call("delete_vocabulary", { vocabulary_id: id }),
    ).toMatchObject({
      isError: true,
      text: CONFIRM,
    });
    await ok("delete_vocabulary", { vocabulary_id: id, confirm: true });
    const again = await call("delete_vocabulary", {
      vocabulary_id: id,
      confirm: true,
    });
    expect(again.isError).toBe(true);
  });
});

describe("settings and model tools", () => {
  it("list_settings shows only catalog keys, with no credentials", async () => {
    writeSetting(SETTINGS_KEYS.theme, "dark");
    const items = (await ok("list_settings")) as {
      key: string;
      value: string | null;
    }[];
    const keys = items.map((i) => i.key);
    expect(keys).toEqual(Object.keys(SETTINGS_CATALOG));
    expect(keys).not.toContain(SETTINGS_KEYS.mcpEnabled);
    expect(keys).not.toContain(SETTINGS_KEYS.networkProxyUrl);
    expect(items.find((i) => i.key === SETTINGS_KEYS.theme)?.value).toBe(
      "dark",
    );
  });

  it("set_setting writes a catalog key and refuses the others", async () => {
    await ok("set_setting", { key: SETTINGS_KEYS.theme, value: "dark" });
    expect(readSetting(SETTINGS_KEYS.theme)).toBe("dark");
    for (const [key, value] of [
      [SETTINGS_KEYS.mcpEnabled, "false"],
      ["groq_api_key", "x"],
      [SETTINGS_KEYS.theme, "purple"],
      [SETTINGS_KEYS.liveChatEnabled, "yes"],
      // The route validator also runs: 9 tool rounds is out of range.
      [SETTINGS_KEYS.chatRounds, "9"],
    ]) {
      const refused = await call("set_setting", { key, value });
      expect(refused.isError, key).toBe(true);
    }
    expect(readSetting(SETTINGS_KEYS.mcpEnabled)).toBeUndefined();
    expect(readSetting(SETTINGS_KEYS.theme)).toBe("dark");
  });

  it("list_models gives configured, builtin and task assignments", async () => {
    const data = await ok("list_models");
    expect(Array.isArray(data.configured)).toBe(true);
    expect(data.builtin).toHaveProperty("platformSupported");
    expect(data).toHaveProperty("task_assignments");
  });

  it("download_model passes the route refusal for an unknown model", async () => {
    const refused = await call("download_model", { model_id: "no-such-model" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Unknown MLX LLM model");
  });

  it("get_download_status gives the state of a catalog model", async () => {
    const unknown = await call("get_download_status", {
      model_id: "no-such-model",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("Unknown built-in model");
    const known = await call("get_download_status", {
      model_id: "gemma-4-e2b-qat-4bit",
    });
    if (process.platform === "darwin" && process.arch === "arm64") {
      expect(known.isError, known.text).toBe(false);
      expect(known.data.model).toBe("gemma-4-e2b-qat-4bit");
    } else {
      // CI runs on Linux: the platform reason comes back.
      expect(known.isError).toBe(true);
    }
  });
});

describe("settings catalog", () => {
  it("covers every key of SETTINGS_KEYS exactly once", () => {
    for (const key of Object.values(SETTINGS_KEYS)) {
      const inCatalog = Object.hasOwn(SETTINGS_CATALOG, key);
      const excluded = Object.hasOwn(SETTINGS_EXCLUDED, key);
      expect(
        inCatalog !== excluded,
        `${key}: add it to the catalog or to the exclusions`,
      ).toBe(true);
    }
    const known = new Set<string>(Object.values(SETTINGS_KEYS));
    for (const key of [
      ...Object.keys(SETTINGS_CATALOG),
      ...Object.keys(SETTINGS_EXCLUDED),
    ]) {
      expect(known.has(key), `${key} is not in SETTINGS_KEYS`).toBe(true);
    }
  });

  it("holds no credential-shaped key", () => {
    const credential = new Set([
      "key",
      "token",
      "secret",
      "password",
      "apikey",
    ]);
    for (const key of Object.keys(SETTINGS_CATALOG)) {
      expect(
        key.split("_").some((s) => credential.has(s)),
        key,
      ).toBe(false);
    }
  });
});

describe("PR 3 write tools", () => {
  afterEach(() => {
    const db = getDb();
    db.exec("DELETE FROM ledger_marks");
    db.exec("DELETE FROM ledger_items");
    db.exec("DELETE FROM folder_standing");
    setAppSettingsSender(null);
  });

  function summaryJson(task: string) {
    return {
      overview: "The crew planned the pier repair.",
      keyPoints: ["The pier needs new planks"],
      decisions: ["Use oak planks"],
      actionItems: [{ task, owner: "Ana Ribeiro", due: null }],
      openQuestions: ["Who pays for the paint?"],
    };
  }

  it("set_summary keeps the old summary as a version, provider agent", async () => {
    insertMeeting("m1", { status: "transcribed" });
    getDb()
      .prepare(
        `INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, llm_provider, llm_model, created_at)
         VALUES ('m1', '# Old', '{}', 'local-mlx', 'gemma-fictional', 1)`,
      )
      .run();
    await ok("set_summary", {
      meeting_id: "m1",
      markdown: "# Pier repair\n\nNew summary.",
      summary_json: summaryJson("Order oak planks"),
    });
    const row = getDb()
      .prepare("SELECT * FROM meeting_summaries WHERE meeting_id = 'm1'")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      markdown: "# Pier repair\n\nNew summary.",
      llm_provider: "agent",
      llm_model: "vitest",
    });
    expect(JSON.parse(row.summary_json as string).actionItems[0].task).toBe(
      "Order oak planks",
    );
    expect(meetingRow("m1")?.status).toBe("summarized");
    const versions = getDb()
      .prepare(
        "SELECT markdown, llm_provider FROM meeting_summary_versions WHERE meeting_id = 'm1'",
      )
      .all();
    expect(versions).toEqual([
      { markdown: "# Old", llm_provider: "local-mlx" },
    ]);

    claimJob("m1", "summarize", { done: 0, total: 1, failed: 0 });
    try {
      const busy = await call("set_summary", {
        meeting_id: "m1",
        markdown: "# Busy",
        summary_json: summaryJson("X"),
      });
      expect(busy.isError).toBe(true);
      expect(busy.text).toBe("Conflict (409): Summarize is already running");
    } finally {
      releaseJob("m1");
    }
    expect(
      (
        getDb()
          .prepare(
            "SELECT markdown FROM meeting_summaries WHERE meeting_id = 'm1'",
          )
          .get() as { markdown: string }
      ).markdown,
    ).toBe("# Pier repair\n\nNew summary.");
  });

  it("set_enhanced_segments writes enhanced_text only and the Markdown export", async () => {
    insertMeeting("m1");
    const audioDir = mkdtempSync(join(scratch, "meeting-"));
    getDb()
      .prepare("UPDATE meetings SET audio_dir = ? WHERE id = 'm1'")
      .run(audioDir);
    insertSegment({
      id: "s1",
      meetingId: "m1",
      idx: 0,
      startMs: 0,
      endMs: 900,
      text: "Ana ribera opens the peer",
    });
    insertSegment({
      id: "s2",
      meetingId: "m1",
      idx: 1,
      startMs: 1000,
      endMs: 1900,
    });
    const data = await ok("set_enhanced_segments", {
      meeting_id: "m1",
      segments: [{ id: "s1", enhanced_text: "Ana Ribeiro opens the pier" }],
    });
    expect(data).toMatchObject({ ok: true, updated: 1 });
    expect(data.markdown_path).toBe(join(audioDir, "transcript-enhanced.md"));
    expect(readFileSync(data.markdown_path, "utf8")).toContain(
      "Ana Ribeiro opens the pier",
    );
    const seg = (id: string) =>
      getDb()
        .prepare(
          "SELECT text, enhanced_text FROM meeting_segments WHERE id = ?",
        )
        .get(id) as { text: string; enhanced_text: string | null };
    expect(seg("s1")).toEqual({
      text: "Ana ribera opens the peer",
      enhanced_text: "Ana Ribeiro opens the pier",
    });
    expect(seg("s2").enhanced_text).toBeNull();

    // A segment of another meeting is refused.
    const foreign = await call("set_enhanced_segments", {
      meeting_id: "m1",
      segments: [{ id: "nope", enhanced_text: "x" }],
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain("is not in this meeting");
  });

  it("the raw ASR text stays read-only: a text field is refused", async () => {
    insertMeeting("m1");
    insertSegment({
      id: "s1",
      meetingId: "m1",
      idx: 0,
      startMs: 0,
      endMs: 900,
      text: "raw words",
    });
    // Through the tool: the input schema refuses the extra field.
    const viaTool = await call("set_enhanced_segments", {
      meeting_id: "m1",
      segments: [{ id: "s1", enhanced_text: "fixed", text: "changed raw" }],
    });
    expect(viaTool.isError).toBe(true);
    // Through REST: the route refuses it with 400.
    const res = await app.request(
      `${URL_BASE}/api/meetings/m1/enhanced-segments`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SERVER_TOKEN}`,
        },
        body: JSON.stringify({
          segments: [{ id: "s1", enhanced_text: "fixed", text: "changed raw" }],
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(
      getDb()
        .prepare(
          "SELECT text, enhanced_text FROM meeting_segments WHERE id = 's1'",
        )
        .get(),
    ).toEqual({ text: "raw words", enhanced_text: null });
  });

  it("set_attendees sets attendees with no calendar event", async () => {
    insertMeeting("m1");
    const data = await ok("set_attendees", {
      meeting_id: "m1",
      attendees: [
        { name: "Ana Ribeiro", email: "ana@example.com" },
        { name: "Bruno Costa" },
      ],
    });
    expect(data.attendees).toHaveLength(2);
    const row = meetingRow("m1");
    expect(row?.calendar_event_id).toBeNull();
    expect(JSON.parse(row?.calendar_attendees as string)).toEqual([
      { name: "Ana Ribeiro", email: "ana@example.com", isOrganizer: false },
      { name: "Bruno Costa", email: "", isOrganizer: false },
    ]);
    claimJob("m1", "enhance", { done: 0, total: 1, failed: 0 });
    try {
      const busy = await call("set_attendees", {
        meeting_id: "m1",
        attendees: [],
      });
      expect(busy.text).toBe("Conflict (409): Enhance is already running");
    } finally {
      releaseJob("m1");
    }
    await ok("set_attendees", { meeting_id: "m1", attendees: [] });
    expect(meetingRow("m1")?.calendar_attendees).toBeNull();
  });

  it("rename_ask_thread and delete_ask_thread", async () => {
    const db = getDb();
    const thread = createThread(db, { kind: "all" });
    if (!thread) throw new Error("no thread");
    appendMessage(db, thread.id, {
      role: "user",
      content: "When is the pier open?",
    });
    await ok("rename_ask_thread", {
      thread_id: thread.id,
      title: "Pier hours",
    });
    const title = () =>
      (
        db
          .prepare("SELECT title FROM chat_threads WHERE id = ?")
          .get(thread.id) as { title: string } | undefined
      )?.title;
    expect(title()).toBe("Pier hours");
    expect(
      await call("delete_ask_thread", { thread_id: thread.id }),
    ).toMatchObject({ isError: true, text: CONFIRM });
    expect(title()).toBe("Pier hours");
    await ok("delete_ask_thread", { thread_id: thread.id, confirm: true });
    expect(title()).toBeUndefined();
    const messages = db
      .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?")
      .get(thread.id) as { n: number };
    expect(messages.n).toBe(0);
    const again = await call("delete_ask_thread", {
      thread_id: thread.id,
      confirm: true,
    });
    expect(again.isError).toBe(true);
  });

  it("set_folder_standing saves the text as given, with no model", async () => {
    insertFolder("f1", "Harbor");
    const data = await ok("set_folder_standing", {
      folder_id: "f1",
      bullets: ["- The pier repair starts in May", "Paint is still open"],
    });
    expect(data.bullets).toEqual([
      "The pier repair starts in May",
      "Paint is still open",
    ]);
    const row = getDb()
      .prepare(
        "SELECT bullets_json FROM folder_standing WHERE folder_id = 'f1'",
      )
      .get() as { bullets_json: string };
    expect(JSON.parse(row.bullets_json)).toEqual(data.bullets);
    const read = await ok("get_folder_standing", { folder_id: "f1" });
    expect(read.standing.bullets).toEqual(data.bullets);
    const missing = await call("set_folder_standing", {
      folder_id: "nope",
      bullets: ["x"],
    });
    expect(missing.isError).toBe(true);
  });

  it("open items: list, create, mark, update and delete", async () => {
    insertFolder("f1", "Harbor");
    insertFolder("f2", "Lighthouse");
    insertMeeting("m1", { folderId: "f1", startedAt: 1_780_000_000_000 });
    insertMeeting("m2", { folderId: "f1", startedAt: 1_780_100_000_000 });
    insertMeeting("m3", { folderId: "f2" });
    insertSegment({
      id: "s1",
      meetingId: "m1",
      idx: 0,
      startMs: 4000,
      endMs: 6000,
      text: "Ana will order the oak planks this week.",
    });
    expect((await ok("list_open_items", { folder_id: "f1" })).items).toEqual(
      [],
    );

    const created = await ok("create_open_item", {
      meeting_id: "m1",
      kind: "action",
      text: "Order the oak planks",
      quote: "Ana will order the oak planks",
      owner: "Ana Ribeiro",
    });
    expect(created).toMatchObject({ folder_id: "f1", quote_ok: true });
    const item = getDb()
      .prepare("SELECT * FROM ledger_items WHERE id = ?")
      .get(created.id) as Record<string, unknown>;
    expect(item).toMatchObject({
      folder_id: "f1",
      kind: "action",
      first_meeting_id: "m1",
    });
    const raised = getDb()
      .prepare("SELECT * FROM ledger_marks WHERE item_id = ?")
      .get(created.id) as Record<string, unknown>;
    expect(raised).toMatchObject({
      status: "raised",
      quote_ok: 1,
      quote_start_ms: 4000,
      writer_model: "agent:vitest",
    });

    const mark = await ok("add_open_item_mark", {
      item_id: created.id,
      meeting_id: "m2",
      status: "done",
      quote: "The planks arrived on Monday",
      reason: "Delivered",
    });
    // The quote is not in the transcript of m2.
    expect(mark.quote_ok).toBe(false);
    const wrongFolder = await call("add_open_item_mark", {
      item_id: created.id,
      meeting_id: "m3",
      status: "open",
      quote: "Still waiting for planks",
    });
    expect(wrongFolder.isError).toBe(true);
    expect(wrongFolder.text).toContain("not in the folder");

    expect((await ok("list_open_items", { folder_id: "f1" })).items).toEqual(
      [],
    );
    const done = await ok("list_open_items", {
      folder_id: "f1",
      status: "done",
    });
    expect(done.items).toHaveLength(1);
    expect(done.items[0]).toMatchObject({ id: created.id, nowStatus: "done" });
    expect(done.items[0].marks).toHaveLength(2);
    expect(done).toMatchObject({ total: 1, offset: 0, next_offset: null });
    const past = await ok("list_open_items", {
      folder_id: "f1",
      status: "done",
      offset: 1,
    });
    expect(past).toMatchObject({ total: 1, offset: 1, items: [] });

    await ok("update_open_item", {
      item_id: created.id,
      text: "Order and store the oak planks",
    });
    expect(
      (
        getDb()
          .prepare("SELECT text FROM ledger_items WHERE id = ?")
          .get(created.id) as {
          text: string;
        }
      ).text,
    ).toBe("Order and store the oak planks");

    expect(
      await call("delete_open_item", { item_id: created.id }),
    ).toMatchObject({ isError: true, text: CONFIRM });
    expect(
      getDb()
        .prepare("SELECT id FROM ledger_items WHERE id = ?")
        .get(created.id),
    ).toBeDefined();
    await ok("delete_open_item", { item_id: created.id, confirm: true });
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM ledger_marks WHERE item_id = ?")
        .get(created.id),
    ).toEqual({ n: 0 });
    const missing = await call("update_open_item", {
      item_id: created.id,
      kind: "decision",
    });
    expect(missing.isError).toBe(true);
  });

  it("get_app_settings and set_app_settings give 503 with no main process", async () => {
    const read = await call("get_app_settings");
    expect(read.isError).toBe(true);
    expect(read.text).toBe(
      "Error (503): App settings need the Openstyle app. This server runs without it.",
    );
    const write = await call("set_app_settings", { auto_update: false });
    expect(write.isError).toBe(true);
    expect(write.text).toContain("503");
  });

  it("get_app_settings and set_app_settings ask main over the sender", async () => {
    const state: Record<string, unknown> = {
      pill_position: "bottom-center",
      auto_update: true,
      update_channel: "dev",
      launch_at_login: false,
    };
    const requests: AppSettingsRequest[] = [];
    setAppSettingsSender((request) => {
      requests.push(request);
      if (request.patch) Object.assign(state, request.patch);
      // The setup file fakes the timers: answer in a microtask.
      queueMicrotask(() =>
        handleAppSettingsResult({
          type: "app-settings-result",
          id: request.id,
          ok: true,
          settings: { ...state },
        }),
      );
    });
    expect(await ok("get_app_settings")).toEqual(state);
    const after = await ok("set_app_settings", {
      pill_position: "top-right",
      launch_at_login: true,
    });
    expect(after).toMatchObject({
      pill_position: "top-right",
      launch_at_login: true,
    });
    expect(requests.map((r) => r.patch)).toEqual([
      null,
      { pill_position: "top-right", launch_at_login: true },
    ]);
    const empty = await call("set_app_settings", {});
    expect(empty.isError).toBe(true);
    const bad = await call("set_app_settings", { pill_position: "custom" });
    expect(bad.isError).toBe(true);
  });

  it("an app-settings request ends after the wait with no answer", async () => {
    setAppSettingsSender(() => {});
    const pending = requestAppSettings(null);
    const check = expect(pending).rejects.toBeInstanceOf(AppShellTimeoutError);
    await vi.advanceTimersByTimeAsync(APP_SETTINGS_WAIT_MS);
    await check;
  });
});

// Keep this test last: it reads the names that the tests above called.
describe("tool coverage", () => {
  it("has a test for every registered tool", async () => {
    const body = await rpc("tools/list");
    const names = (body.result?.tools as { name: string }[]).map((t) => t.name);
    expect(names.length).toBeGreaterThan(30);
    const untested = names.filter((n) => !covered.has(n));
    expect(untested, "tools with no test").toEqual([]);
  });
});
