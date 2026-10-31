/**
 * The meeting search index in ON mode (specs/local-semantic-search.md 6, 7,
 * 8, 12.2): sqlite-vec 0.1.9 of this platform plus a fake embedding worker
 * with bag-of-words vectors. Fictional meetings only.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  searchMeetingsResponseSchema,
  searchStatusSchema,
} from "@openstyle/validations";
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
import { sqliteVecTestPath } from "./helpers/sqlite-vec.js";

const EG2 = "embeddinggemma-2-bf16-text";
const OTHER = "test-embed-other";

vi.mock("../src/lib/mlx-asr/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/constants.js")>()),
  isAppleSiliconMac: () => true,
}));

// A second catalog model, for the model-change test (D4).
vi.mock("../src/lib/mlx-embed/constants.js", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("../src/lib/mlx-embed/constants.js")>();
  const base = orig.MLX_EMBED_MODELS[0];
  if (!base) throw new Error("no catalog model");
  const models = [
    ...orig.MLX_EMBED_MODELS,
    {
      ...base,
      id: "test-embed-other",
      hfId: "test/other-embed",
      displayName: "Other",
    },
  ];
  return {
    ...orig,
    MLX_EMBED_MODELS: models,
    getMlxEmbedModel: (id: string) => models.find((m) => m.id === id),
  };
});

const VEC_PATH = sqliteVecTestPath();

import createApp from "../src/index.js";
import { closeDb, getDb, writeSetting } from "../src/lib/db.js";
import { addSuggestedTags } from "../src/lib/meetings/tags.js";
import { loadFolderMemory } from "../src/lib/meetings/workflow/folder-memory.js";
import { hfRepoCacheDir } from "../src/lib/mlx-asr/constants.js";
import { getMlxEmbedModel } from "../src/lib/mlx-embed/constants.js";
import { stopMlxEmbedWorker } from "../src/lib/mlx-embed/server.js";
import {
  drainSearchGc,
  indexMeeting,
  startSearchIndexer,
  stopSearchIndexer,
} from "../src/lib/search/indexer.js";
import {
  notifyMeetingChanged,
  takePendingMeetings,
} from "../src/lib/search/notify.js";
import { hitText, retrieve } from "../src/lib/search/retrieve.js";
import { readVecRow } from "../src/lib/search/vec-store.js";
import { writeFakeEmbedWorker } from "./helpers/fake-embed-worker.js";
import { jsonRequest } from "./helpers/http.js";
import { insertSegment, resetMeetingTables } from "./helpers/meetings-db.js";

let scratch = "";
let workerLog = "";
const app = createApp();

/** Inputs the fake worker embedded so far (all requests). */
function embeddedInputs(): string[] {
  if (!existsSync(workerLog)) return [];
  return readFileSync(workerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap(
      (l) => (JSON.parse(l) as { body: { input: string[] } }).body.input,
    );
}

function seedModel(id: string): void {
  const def = getMlxEmbedModel(id);
  if (!def) throw new Error(id);
  const snap = join(hfRepoCacheDir(def.hfId), "snapshots", def.revision);
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "config.json"), "{}");
  writeFileSync(join(snap, "model.safetensors"), "w");
}

function folder(id: string, name: string): void {
  getDb()
    .prepare(
      "INSERT INTO meeting_folders (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)",
    )
    .run(id, name);
}

/** A fictional meeting: one segment per sentence. */
function meeting(
  id: string,
  folderId: string | null,
  sentences: string[],
  language = "en",
): void {
  getDb()
    .prepare(
      `INSERT INTO meetings (id, title, status, started_at, folder_id, language)
       VALUES (?, ?, 'transcribed', ?, ?, ?)`,
    )
    .run(id, `Title ${id}`, Date.now(), folderId, language);
  sentences.forEach((text, i) => {
    insertSegment({
      id: `${id}:system:${i}`,
      meetingId: id,
      idx: i,
      startMs: i * 5000,
      endMs: i * 5000 + 4000,
      text,
    });
  });
}

const filler = (topic: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `We talked about the ${topic} budget item number ${i} and the plan for the next quarter with the whole team present today.`,
  );

function vecCount(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS n FROM meeting_chunk_vec").get() as {
      n: number;
    }
  ).n;
}

function chunkIds(meetingId: string): number[] {
  return (
    getDb()
      .prepare(
        "SELECT id FROM meeting_chunks WHERE meeting_id = ? ORDER BY ordinal",
      )
      .all(meetingId) as { id: number }[]
  ).map((r) => r.id);
}

async function search(body: Record<string, unknown>) {
  const res = await jsonRequest(app, "POST", "/api/search/meetings", body);
  expect(res.status).toBe(200);
  return searchMeetingsResponseSchema.parse(await res.json());
}

async function status() {
  const res = await app.request("/api/search/status");
  expect(res.status).toBe(200);
  return searchStatusSchema.parse(await res.json());
}

describe.skipIf(!VEC_PATH)("search index, ON mode", () => {
  beforeAll(() => {
    vi.useRealTimers();
    scratch = mkdtempSync(join(tmpdir(), "openstyle-search-"));
    workerLog = join(scratch, "worker.log");
    process.env.HUGGINGFACE_HUB_CACHE = join(scratch, "hf");
    process.env.OPENSTYLE_MLX_EMBED_WORKER = writeFakeEmbedWorker(scratch);
    process.env.FAKE_EMBED_LOG = workerLog;
    process.env.FAKE_EMBED_BOW = "1";
    process.env.OPENSTYLE_SQLITE_VEC_PATH = VEC_PATH as string;
    closeDb();
    getDb();
    seedModel(EG2);
    seedModel(OTHER);
  });

  beforeEach(() => {
    writeSetting("search_embedding_model", EG2);
    rmSync(workerLog, { force: true });
    folder("f-aurora", "Aurora");
    folder("f-atlas", "Atlas");
  });

  afterEach(async () => {
    resetMeetingTables();
    drainSearchGc();
    getDb().exec("DELETE FROM meeting_index_state");
  });

  afterAll(async () => {
    await stopSearchIndexer();
    await stopMlxEmbedWorker();
    for (const k of [
      "HUGGINGFACE_HUB_CACHE",
      "OPENSTYLE_MLX_EMBED_WORKER",
      "FAKE_EMBED_LOG",
      "FAKE_EMBED_BOW",
      "OPENSTYLE_SQLITE_VEC_PATH",
    ])
      delete process.env[k];
    closeDb();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("indexes a meeting, then skips it by hash, then embeds only changed chunks", async () => {
    meeting("m1", "f-aurora", filler("hardware", 40));
    expect(await indexMeeting("m1")).toBe("indexed");
    const ids = chunkIds("m1");
    expect(ids.length).toBeGreaterThan(3);
    expect(vecCount()).toBe(ids.length);
    expect(embeddedInputs()).toHaveLength(ids.length);
    for (const input of embeddedInputs()) {
      expect(input.startsWith("title: none | text: ")).toBe(true);
    }
    // Batches of 16 (5.4).
    const requests = readFileSync(workerLog, "utf8").trim().split("\n");
    expect(requests).toHaveLength(Math.ceil(ids.length / 16));

    // Second run: same hash, nothing embedded (D5).
    rmSync(workerLog, { force: true });
    expect(await indexMeeting("m1")).toBe("done");
    expect(embeddedInputs()).toHaveLength(0);

    // Enhance changes one segment: only the chunks that hold it re-embed.
    getDb()
      .prepare(
        "UPDATE meeting_segments SET enhanced_text = ? WHERE id = 'm1:system:39'",
      )
      .run("The Aurora launch now moves to Friday after the review.");
    expect(await indexMeeting("m1")).toBe("indexed");
    const changed = embeddedInputs();
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(changed.length).toBeLessThanOrEqual(2);
    expect(changed.every((t) => t.includes("Friday"))).toBe(true);
    expect(chunkIds("m1").slice(0, -2)).toEqual(ids.slice(0, -2));
    expect(vecCount()).toBe(chunkIds("m1").length);
  });

  it("moves a meeting without embedding: vector bytes equal, new partition", async () => {
    meeting("m1", "f-aurora", filler("travel", 12));
    await indexMeeting("m1");
    const [first] = chunkIds("m1");
    const before = readVecRow(getDb(), first as number);
    expect(before?.folderKey).toBe("f-aurora");
    rmSync(workerLog, { force: true });

    const res = await jsonRequest(app, "POST", "/api/meetings/move", {
      meeting_ids: ["m1"],
      folder_id: "f-atlas",
    });
    expect(res.status).toBe(200);
    const after = readVecRow(getDb(), first as number);
    expect(after?.folderKey).toBe("f-atlas");
    expect(Buffer.from(after?.vector ?? [])).toEqual(
      Buffer.from(before?.vector ?? []),
    );
    expect(embeddedInputs()).toHaveLength(0);
    expect(await indexMeeting("m1")).toBe("done");

    // Out of all folders: the partition is '' (S2).
    await jsonRequest(app, "POST", "/api/meetings/move", {
      meeting_ids: ["m1"],
      folder_id: null,
    });
    expect(readVecRow(getDb(), first as number)?.folderKey).toBe("");
    expect(embeddedInputs()).toHaveLength(0);
  });

  it("searches by folder, unfiled, tags and exclude", async () => {
    meeting("a1", "f-aurora", [
      "Ana said the Aurora launch will move to Friday because the vendor is late.",
      ...filler("hardware", 6),
    ]);
    meeting("a2", "f-aurora", filler("hiring", 6));
    meeting("t1", "f-atlas", [
      "The Atlas launch moves to Friday too, said Bruno.",
    ]);
    meeting("u1", null, ["An unfiled call about the launch on Friday."]);
    for (const id of ["a1", "a2", "t1", "u1"]) await indexMeeting(id);

    const q = "launch moves to Friday";
    const aurora = await search({ query: q, folder_id: "f-aurora" });
    expect(aurora.status).toBe("ok");
    if (aurora.status !== "ok") return;
    expect(aurora.hits[0]?.meeting_id).toBe("a1");
    expect(aurora.hits[0]?.snippet).toContain("Friday");
    expect(aurora.hits[0]?.meeting_title).toBe("Title a1");
    expect(new Set(aurora.hits.map((h) => h.folder_id))).toEqual(
      new Set(["f-aurora"]),
    );
    const scores = aurora.hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    const unfiled = await search({ query: q, folder_id: "none" });
    expect(
      unfiled.status === "ok" && [
        ...new Set(unfiled.hits.map((h) => h.meeting_id)),
      ],
    ).toEqual(["u1"]);
    const all = await search({ query: q, k: 3 });
    expect(all.status === "ok" && all.hits).toHaveLength(3);

    // Tags (S5): meeting_id IN (...) from meeting_tags.
    await jsonRequest(app, "PUT", "/api/meetings/t1/tags", {
      tags: ["Launch"],
    });
    const tagged = await search({ query: q, tags: ["launch"] });
    expect(
      tagged.status === "ok" && [
        ...new Set(tagged.hits.map((h) => h.meeting_id)),
      ],
    ).toEqual(["t1"]);
    const noTag = await search({ query: q, tags: ["nothing"] });
    expect(noTag.status === "ok" && noTag.hits).toEqual([]);

    // Exclude (Summary and Enhance pass their own meeting).
    const ex = await retrieve({
      query: { kind: "text", text: q },
      scope: { kind: "folder", folderId: "f-aurora" },
      k: 10,
      excludeMeetingIds: ["a1"],
    });
    expect(
      ex.status === "ok" && new Set(ex.hits.map((h) => h.meetingId)),
    ).toEqual(new Set(["a2"]));
    // More than 5 excludes: filtered after the KNN.
    const ex6 = await retrieve({
      query: { kind: "text", text: q },
      scope: { kind: "all" },
      k: 10,
      excludeMeetingIds: ["a1", "a2", "t1", "x1", "x2", "x3"],
    });
    expect(
      ex6.status === "ok" && [...new Set(ex6.hits.map((h) => h.meetingId))],
    ).toEqual(["u1"]);

    // A meeting query (Summary, #234): the meeting's own stored vectors.
    const own = await retrieve({
      query: { kind: "meeting", meetingId: "t1" },
      scope: { kind: "all" },
      k: 5,
      excludeMeetingIds: ["t1"],
    });
    expect(own.status).toBe("ok");
    if (own.status !== "ok") return;
    expect(own.hits.every((h) => h.meetingId !== "t1")).toBe(true);
    // The fixture titles share the word "Title", so meta hits come too.
    const ownTranscript = own.hits.find((h) => h.kind === "transcript");
    expect(hitText(ownTranscript as (typeof own.hits)[number], 400)).toContain(
      "Friday",
    );

    // An unknown folder gives ok with no hits.
    const unknown = await search({ query: q, folder_id: "f-none" });
    expect(unknown).toEqual({ status: "ok", hits: [] });
  });

  it("retrieve: meeting scope and date range (chat agent P0, spec 7.1)", async () => {
    const day = 86_400_000;
    const t0 = Date.UTC(2026, 8, 1);
    meeting("d1", "f-aurora", [
      "The Aurora launch moves to Friday because the vendor is late.",
    ]);
    meeting("d2", "f-aurora", [
      "The Aurora launch moves to Friday again, said Ana.",
    ]);
    meeting("d3", "f-atlas", ["The Atlas launch moves to Friday too."]);
    meeting("d4", null, ["An unfiled call about the launch on Friday."]);
    const setStart = getDb().prepare(
      "UPDATE meetings SET started_at = ? WHERE id = ?",
    );
    setStart.run(t0, "d1");
    setStart.run(t0 + 10 * day, "d2");
    setStart.run(t0 + 20 * day, "d3");
    // No start time: the creation time counts.
    getDb()
      .prepare(
        "UPDATE meetings SET started_at = NULL, created_at = ? WHERE id = 'd4'",
      )
      .run(t0 + 30 * day);
    for (const id of ["d1", "d2", "d3", "d4"]) await indexMeeting(id);

    const run = async (extra: Partial<Parameters<typeof retrieve>[0]>) => {
      const res = await retrieve({
        query: { kind: "text", text: "launch moves to Friday" },
        scope: { kind: "all" },
        k: 20,
        ...extra,
      });
      expect(res.status).toBe("ok");
      return res.status === "ok"
        ? [...new Set(res.hits.map((h) => h.meetingId))].sort()
        : [];
    };

    // Default: nothing changes without the new fields.
    expect(await run({})).toEqual(["d1", "d2", "d3", "d4"]);
    // One meeting.
    expect(await run({ scope: { kind: "meeting", meetingId: "d2" } })).toEqual([
      "d2",
    ]);
    expect(
      await run({ scope: { kind: "meeting", meetingId: "nope" } }),
    ).toEqual([]);
    // A date range is [from, to).
    expect(
      await run({ dateRange: { fromMs: t0, toMs: t0 + 11 * day } }),
    ).toEqual(["d1", "d2"]);
    expect(
      await run({ dateRange: { fromMs: t0 + 10 * day, toMs: t0 + 20 * day } }),
    ).toEqual(["d2"]);
    expect(
      await run({ dateRange: { fromMs: t0 + 25 * day, toMs: t0 + 40 * day } }),
    ).toEqual(["d4"]);
    expect(
      await run({
        dateRange: { fromMs: t0 + 100 * day, toMs: t0 + 101 * day },
      }),
    ).toEqual([]);
    // The filters AND with the folder scope and with the meeting scope.
    expect(
      await run({
        scope: { kind: "folder", folderId: "f-aurora" },
        dateRange: { fromMs: t0, toMs: t0 + 5 * day },
      }),
    ).toEqual(["d1"]);
    expect(
      await run({
        scope: { kind: "meeting", meetingId: "d1" },
        dateRange: { fromMs: t0 + 5 * day, toMs: t0 + 15 * day },
      }),
    ).toEqual([]);
  });

  it("deletes vectors through the gc table after a meeting delete", async () => {
    meeting("m1", "f-aurora", filler("office", 10));
    await indexMeeting("m1");
    const n = chunkIds("m1").length;
    expect(vecCount()).toBe(n);
    const res = await app.request("/api/meetings/m1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(
      (
        getDb().prepare("SELECT COUNT(*) AS n FROM meeting_chunk_gc").get() as {
          n: number;
        }
      ).n,
    ).toBe(n);
    expect(await indexMeeting("m1")).toBe("missing");
    expect(vecCount()).toBe(0);
  });

  it("re-indexes on a model change and never mixes model ids (D4)", async () => {
    meeting("m1", "f-aurora", filler("finance", 8));
    await indexMeeting("m1");
    writeSetting("search_embedding_model", OTHER);
    expect((await status()).meetings).toMatchObject({
      eligible: 1,
      indexed: 0,
    });
    const before = await search({ query: "finance budget" });
    expect(before).toEqual({ status: "ok", hits: [] });

    expect(await indexMeeting("m1")).toBe("indexed");
    const models = getDb()
      .prepare("SELECT DISTINCT model_id FROM meeting_chunks")
      .all();
    expect(models).toEqual([{ model_id: OTHER }]);
    const vecModels = getDb()
      .prepare("SELECT DISTINCT model_id FROM meeting_chunk_vec")
      .all();
    expect(vecModels).toEqual([{ model_id: OTHER }]);
    expect((await status()).meetings).toMatchObject({
      eligible: 1,
      indexed: 1,
    });
    await stopMlxEmbedWorker();
  });

  it("keeps the old state when the write fails inside the transaction", async () => {
    meeting("m1", "f-aurora", filler("legal", 8));
    await indexMeeting("m1");
    const ids = chunkIds("m1");
    const state = getDb()
      .prepare("SELECT * FROM meeting_index_state WHERE meeting_id = 'm1'")
      .get();
    getDb()
      .prepare("UPDATE meeting_segments SET text = ? WHERE id = 'm1:system:0'")
      .run("A new first sentence about the legal review.");
    getDb().exec(`CREATE TEMP TRIGGER fail_state BEFORE UPDATE ON meeting_index_state
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    try {
      await expect(indexMeeting("m1")).rejects.toThrow(/simulated crash/);
    } finally {
      getDb().exec("DROP TRIGGER fail_state");
    }
    expect(chunkIds("m1")).toEqual(ids);
    expect(vecCount()).toBe(ids.length);
    expect(
      getDb()
        .prepare("SELECT * FROM meeting_index_state WHERE meeting_id = 'm1'")
        .get(),
    ).toEqual(state);
  });

  it("reports status and runs the background loop on a change hint", async () => {
    meeting("m1", null, ["A short fictional note about the Atlas design."]);
    startSearchIndexer();
    notifyMeetingChanged("m1");
    const deadline = Date.now() + 8000;
    let s = await status();
    while (s.meetings.indexed < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      s = await status();
    }
    await stopSearchIndexer();
    expect(s).toMatchObject({
      state: "on",
      reason: null,
      model_id: EG2,
      vec_version: "v0.1.9",
      meetings: { eligible: 1, indexed: 1, failed: 0 },
    });
    expect(s.index.vector_chunks).toBeGreaterThan(0);
    expect(s.index.db_bytes).toBeGreaterThan(0);
    expect(s.index.embedded_chunks).toBeGreaterThan(0);
  });

  it("indexes the title, tags and summary as their own chunks; a change embeds only its chunks (4.6)", async () => {
    meeting("m1", "f-aurora", filler("hardware", 30));
    getDb()
      .prepare("UPDATE meetings SET title = ? WHERE id = 'm1'")
      .run("Zeppelin hangar walkthrough");
    await jsonRequest(app, "PUT", "/api/meetings/m1/tags", { tags: ["Ops"] });
    const summary =
      "## Decisions\n- The marmalade supplier stays for one more year.\n- Ana writes the contract note.";
    getDb()
      .prepare(
        "INSERT INTO meeting_summaries (meeting_id, markdown, created_at) VALUES ('m1', ?, 1)",
      )
      .run(summary);
    expect(await indexMeeting("m1")).toBe("indexed");
    const kinds = () =>
      getDb()
        .prepare(
          "SELECT kind, COUNT(*) AS n, MIN(start_ms) AS s FROM meeting_chunks WHERE meeting_id = 'm1' GROUP BY kind ORDER BY kind",
        )
        .all() as { kind: string; n: number; s: number | null }[];
    const first = kinds();
    expect(first.map((k) => [k.kind, k.n > 0])).toEqual([
      ["meta", true],
      ["summary", true],
      ["transcript", true],
    ]);
    expect(first.find((k) => k.kind === "meta")?.n).toBe(1);
    expect(first.find((k) => k.kind === "meta")?.s).toBeNull();
    // The document prompt stays "title: none" (D9); the title is in the text.
    expect(embeddedInputs()).toContain(
      "title: none | text: Zeppelin hangar walkthrough\nTags: ops",
    );

    // A word only in the title finds the meta chunk; a word only in the
    // summary finds a summary chunk. Neither has a time.
    const byTitle = await search({ query: "zeppelin hangar" });
    expect(byTitle.status === "ok" && byTitle.hits[0]).toMatchObject({
      meeting_id: "m1",
      kind: "meta",
      start_ms: null,
      snippet: "Zeppelin hangar walkthrough\nTags: ops",
    });
    const bySummary = await search({ query: "marmalade supplier" });
    expect(bySummary.status === "ok" && bySummary.hits[0]).toMatchObject({
      meeting_id: "m1",
      kind: "summary",
      start_ms: null,
    });
    expect(bySummary.status === "ok" && bySummary.hits[0]?.snippet).toContain(
      "marmalade supplier",
    );
    const transcriptIds = () =>
      (
        getDb()
          .prepare(
            "SELECT id FROM meeting_chunks WHERE meeting_id = 'm1' AND kind = 'transcript' ORDER BY ordinal",
          )
          .all() as { id: number }[]
      ).map((r) => r.id);
    const tIds = transcriptIds();
    const allIds = () => chunkIds("m1");

    // A tag change (PUT tags): only the meta chunk is embedded again.
    takePendingMeetings();
    await jsonRequest(app, "PUT", "/api/meetings/m1/tags", {
      tags: ["Ops", "Hangar"],
    });
    expect(takePendingMeetings()).toEqual(["m1"]);
    rmSync(workerLog, { force: true });
    expect(await indexMeeting("m1")).toBe("indexed");
    expect(embeddedInputs()).toEqual([
      "title: none | text: Zeppelin hangar walkthrough\nTags: hangar, ops",
    ]);
    expect(transcriptIds()).toEqual(tIds);

    // An Enhance tag step (addSuggestedTags): a hint, then only meta again.
    addSuggestedTags("m1", ["Budget"]);
    expect(takePendingMeetings()).toEqual(["m1"]);
    rmSync(workerLog, { force: true });
    expect(await indexMeeting("m1")).toBe("indexed");
    expect(embeddedInputs()).toEqual([
      "title: none | text: Zeppelin hangar walkthrough\nTags: budget, hangar, ops",
    ]);

    // A title rename (PATCH): a hint, then only the meta chunk.
    const renamed = await jsonRequest(app, "PATCH", "/api/meetings/m1", {
      title: "Zeppelin dock walkthrough",
    });
    expect(renamed.status).toBe(200);
    expect(takePendingMeetings()).toEqual(["m1"]);
    rmSync(workerLog, { force: true });
    expect(await indexMeeting("m1")).toBe("indexed");
    expect(embeddedInputs()).toHaveLength(1);
    expect(embeddedInputs()[0]).toContain("Zeppelin dock walkthrough");

    // A summary change: only the summary chunks.
    getDb()
      .prepare(
        "UPDATE meeting_summaries SET markdown = ? WHERE meeting_id = 'm1'",
      )
      .run(summary.replace("one more year", "two more years"));
    rmSync(workerLog, { force: true });
    const beforeSummary = allIds();
    expect(await indexMeeting("m1")).toBe("indexed");
    expect(embeddedInputs()).toHaveLength(
      kinds().find((k) => k.kind === "summary")?.n ?? -1,
    );
    expect(
      embeddedInputs().every(
        (t) => t.includes("Decisions") || t.includes("contract"),
      ),
    ).toBe(true);
    expect(transcriptIds()).toEqual(tIds);
    expect(allIds().length).toBe(beforeSummary.length);

    // A transcript change: no meta or summary chunk is embedded again.
    getDb()
      .prepare(
        "UPDATE meeting_segments SET enhanced_text = ? WHERE id = 'm1:system:29'",
      )
      .run("The hardware order now ships on Monday after the audit.");
    rmSync(workerLog, { force: true });
    expect(await indexMeeting("m1")).toBe("indexed");
    const changed = embeddedInputs();
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(changed.every((t) => t.includes("Monday"))).toBe(true);

    // Same text again: nothing is embedded (D5).
    rmSync(workerLog, { force: true });
    expect(await indexMeeting("m1")).toBe("done");
    expect(embeddedInputs()).toHaveLength(0);
    expect(vecCount()).toBe(allIds().length);
  });

  it("purges the rows of a deleted model and keeps other models (9.2)", async () => {
    meeting("m1", "f-aurora", filler("finance", 8));
    meeting("m2", "f-atlas", filler("travel", 8));
    expect(await indexMeeting("m1")).toBe("indexed");
    writeSetting("search_embedding_model", OTHER);
    expect(await indexMeeting("m2")).toBe("indexed");
    const otherChunks = chunkIds("m2").length;
    expect(chunkIds("m1").length).toBeGreaterThan(0);
    expect(vecCount()).toBe(chunkIds("m1").length + otherChunks);

    // EG2 is not the search model now: its rows go, the OTHER rows stay.
    const res = await app.request(`/api/mlx-embed/models/${EG2}`, {
      method: "DELETE",
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(chunkIds("m1")).toEqual([]);
    expect(chunkIds("m2")).toHaveLength(otherChunks);
    expect(vecCount()).toBe(otherChunks);
    expect(
      getDb()
        .prepare("SELECT meeting_id, model_id FROM meeting_index_state")
        .all(),
    ).toEqual([{ meeting_id: "m2", model_id: OTHER }]);

    // Delete the search model itself: every row goes, search is off.
    await app.request(`/api/mlx-embed/models/${OTHER}`, { method: "DELETE" });
    const count = (t: string) =>
      (getDb().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number })
        .n;
    expect(count("meeting_chunks")).toBe(0);
    expect(count("meeting_chunk_vec")).toBe(0);
    expect(count("meeting_index_state")).toBe(0);
    expect(count("meeting_chunk_gc")).toBe(0);
    expect(await status()).toMatchObject({ state: "off", reason: "no_model" });
    await stopMlxEmbedWorker();
    seedModel(EG2);
    seedModel(OTHER);
  });

  it("a model delete during an embed writes nothing and records no failure (9.2)", async () => {
    await stopMlxEmbedWorker();
    process.env.FAKE_EMBED_DELAY_MS = "1500";
    try {
      meeting("m1", null, filler("garden", 6));
      startSearchIndexer();
      notifyMeetingChanged("m1");
      const deadline = Date.now() + 8000;
      while (embeddedInputs().length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(embeddedInputs().length).toBeGreaterThan(0);
      const res = await app.request(`/api/mlx-embed/models/${EG2}`, {
        method: "DELETE",
      });
      expect(await res.json()).toEqual({ ok: true });
      // Longer than the reply delay: an aborted meeting would write now.
      await new Promise((r) => setTimeout(r, 2500));
      await stopSearchIndexer();
      expect(chunkIds("m1")).toEqual([]);
      expect(vecCount()).toBe(0);
      expect(
        getDb().prepare("SELECT * FROM meeting_index_state").all(),
      ).toEqual([]);
      expect((await status()).meetings.failed).toBe(0);
    } finally {
      delete process.env.FAKE_EMBED_DELAY_MS;
      await stopSearchIndexer();
      await stopMlxEmbedWorker();
      seedModel(EG2);
    }
  });

  it("project memory (#234): real retrieve, folder scope, own meeting and meta chunks left out", async () => {
    const friday = [
      "The launch of the beacon app moves to Friday because the audit is late.",
      ...filler("beacon launch", 12),
    ];
    meeting("m-old", "f-aurora", friday);
    getDb()
      .prepare("UPDATE meetings SET title = ? WHERE id = 'm-old'")
      .run("Beacon launch Friday sync");
    getDb()
      .prepare(
        "INSERT INTO meeting_summaries (meeting_id, markdown, created_at) VALUES ('m-old', ?, 1)",
      )
      .run("## Decisions\n- The beacon launch moves to Friday.");
    meeting("m-atlas", "f-atlas", friday);
    meeting("m-new", "f-aurora", [
      "We keep the beacon launch date that we agreed last week.",
      ...filler("beacon launch", 6),
    ]);
    for (const id of ["m-old", "m-atlas", "m-new"]) {
      expect(await indexMeeting(id)).toBe("indexed");
    }
    const memory = await loadFolderMemory(getDb(), {
      meetingId: "m-new",
      folderId: "f-aurora",
    });
    expect(memory).not.toBeNull();
    expect(memory?.modelId).toBe(EG2);
    expect(memory?.meetingIds).toEqual(["m-old"]);
    const kinds = getDb()
      .prepare(
        `SELECT DISTINCT kind, meeting_id FROM meeting_chunks WHERE id IN (${memory?.chunkIds.map(() => "?").join(", ")})`,
      )
      .all(...(memory?.chunkIds ?? [])) as {
      kind: string;
      meeting_id: string;
    }[];
    expect(kinds.every((k) => k.meeting_id === "m-old")).toBe(true);
    expect(kinds.some((k) => k.kind === "meta")).toBe(false);
    expect(memory?.summaryBlock).toContain("Friday");
    expect(memory?.summaryBlock).not.toContain("Beacon launch Friday sync");

    // An unknown folder or search off: no memory, no throw.
    expect(
      await loadFolderMemory(getDb(), {
        meetingId: "m-new",
        folderId: "f-none",
      }),
    ).toBeNull();
    writeSetting("search_embedding_model", "");
    expect(
      await loadFolderMemory(getDb(), {
        meetingId: "m-new",
        folderId: "f-aurora",
      }),
    ).toBeNull();
  });

  it("validates the search request", async () => {
    const res = await jsonRequest(app, "POST", "/api/search/meetings", {
      query: "   ",
    });
    expect(res.status).toBe(400);
    const big = await jsonRequest(app, "POST", "/api/search/meetings", {
      query: "x",
      k: 51,
    });
    expect(big.status).toBe(400);
  });
});
