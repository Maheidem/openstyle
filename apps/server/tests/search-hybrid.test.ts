/**
 * The BM25 channel, the hybrid retrieve() and the reranker step
 * (specs/meeting-chat-agent.md 7.4): the FTS5 table in the indexer
 * transaction, the filters by join, the query builder, RRF, and the paths of
 * the rerank (applied, unavailable, error). sqlite-vec of this platform plus a
 * fake embedding worker with bag-of-words vectors. Fictional meetings only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

vi.mock("../src/lib/mlx-asr/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/constants.js")>()),
  isAppleSiliconMac: () => true,
}));

// The reranker worker is not started here: rerankPairs is a stub.
const rerankStub = vi.fn();
vi.mock("../src/lib/mlx-rerank/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-rerank/client.js")>()),
  rerankPairs: (...args: unknown[]) => rerankStub(...args),
}));

const VEC_PATH = sqliteVecTestPath();

import { closeDb, getDb, writeSetting } from "../src/lib/db.js";
import { hfRepoCacheDir } from "../src/lib/mlx-asr/constants.js";
import { getMlxEmbedModel } from "../src/lib/mlx-embed/constants.js";
import { stopMlxEmbedWorker } from "../src/lib/mlx-embed/server.js";
import { RerankError } from "../src/lib/mlx-rerank/client.js";
import {
  ftsAvailable,
  ftsBackfillMeeting,
  ftsDeleteChunks,
  ftsQuery,
  ftsSearch,
  ftsUpsertChunks,
} from "../src/lib/search/fts.js";
import {
  drainSearchGc,
  indexMeeting,
  startSearchIndexer,
  stopSearchIndexer,
} from "../src/lib/search/indexer.js";
import { hitText, retrieve, rrf } from "../src/lib/search/retrieve.js";
import { writeFakeEmbedWorker } from "./helpers/fake-embed-worker.js";
import { insertSegment, resetMeetingTables } from "./helpers/meetings-db.js";

let scratch = "";

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

function meeting(
  id: string,
  folderId: string | null,
  sentences: string[],
  startedAt = Date.now(),
  title = `Title ${id}`,
): void {
  getDb()
    .prepare(
      `INSERT INTO meetings (id, title, status, started_at, folder_id, language)
       VALUES (?, ?, 'transcribed', ?, ?, 'en')`,
    )
    .run(id, title, startedAt, folderId);
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

function chunkIds(meetingId: string): number[] {
  return (
    getDb()
      .prepare(
        "SELECT id FROM meeting_chunks WHERE meeting_id = ? ORDER BY ordinal",
      )
      .all(meetingId) as { id: number }[]
  ).map((r) => r.id);
}

function inFts(id: number): boolean {
  return (
    getDb()
      .prepare("SELECT 1 FROM meeting_chunks_fts WHERE rowid = ?")
      .get(id) !== undefined
  );
}

const FTS_DDL = `CREATE VIRTUAL TABLE meeting_chunks_fts USING fts5(
  text, title, content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2')`;

describe("ftsQuery", () => {
  it("quotes each term, joins by OR and drops stop words", () => {
    expect(ftsQuery("What is the Zeppelin budget?")).toBe(
      '"zeppelin" OR "budget"',
    );
  });

  it("drops Portuguese stop words and folds accents for the stop test", () => {
    expect(ftsQuery("qual é o orçamento da reunião")).toBe(
      '"orçamento" OR "reunião"',
    );
    expect(ftsQuery("Você")).toBe("");
  });

  it("has no duplicates and no one-letter terms", () => {
    expect(ftsQuery("x budget budget BUDGET y 42")).toBe('"budget" OR "42"');
  });

  it("keeps FTS syntax out of the query", () => {
    const hostile = [
      'he said "hello" AND (bye) OR col:val NEAR/2 foo*',
      '"unterminated',
      "title:secret -negated ^start {a b}",
      "a'; DROP TABLE meetings; --",
      "***",
      "",
      "   ",
    ];
    const db = getDb();
    for (const text of hostile) {
      const q = ftsQuery(text);
      // Every term is one quoted word of letters and digits.
      if (q) expect(q).toMatch(/^"[\p{L}\p{N}]+"( OR "[\p{L}\p{N}]+")*$/u);
      // The FTS5 parser accepts it.
      if (q && ftsAvailable(db)) {
        expect(() =>
          db
            .prepare(
              "SELECT rowid FROM meeting_chunks_fts WHERE meeting_chunks_fts MATCH ?",
            )
            .all(q),
        ).not.toThrow();
      }
    }
    expect(ftsQuery("***")).toBe("");
  });

  it("limits the number of terms", () => {
    const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    expect(ftsQuery(text).split(" OR ")).toHaveLength(32);
  });
});

describe("rrf", () => {
  it("sums 1/(k+rank) over the lists", () => {
    // 1 is first in both lists. 2 and 3 each appear once.
    expect(
      rrf([
        [1, 2],
        [1, 3],
      ]),
    ).toEqual([1, 2, 3]);
    expect(
      rrf([
        [5, 6, 7],
        [7, 6],
      ]),
    ).toEqual([7, 6, 5]);
  });

  it("breaks ties by the id and handles empty lists", () => {
    expect(rrf([[9], [4]])).toEqual([4, 9]);
    expect(rrf([[], []])).toEqual([]);
    expect(rrf([])).toEqual([]);
  });
});

describe.skipIf(!VEC_PATH)("BM25 channel and hybrid retrieve, ON mode", () => {
  beforeAll(() => {
    vi.useRealTimers();
    scratch = mkdtempSync(join(tmpdir(), "openstyle-search-hybrid-"));
    process.env.HUGGINGFACE_HUB_CACHE = join(scratch, "hf");
    process.env.OPENSTYLE_MLX_EMBED_WORKER = writeFakeEmbedWorker(scratch);
    process.env.FAKE_EMBED_BOW = "1";
    process.env.OPENSTYLE_SQLITE_VEC_PATH = VEC_PATH as string;
    closeDb();
    getDb();
    seedModel(EG2);
  });

  beforeEach(() => {
    rerankStub.mockReset();
    writeSetting("search_embedding_model", EG2);
    folder("f-aurora", "Aurora");
    folder("f-atlas", "Atlas");
  });

  afterEach(async () => {
    resetMeetingTables();
    drainSearchGc();
    getDb().exec("DELETE FROM meeting_index_state");
    if (!ftsAvailable(getDb())) getDb().exec(FTS_DDL);
  });

  afterAll(async () => {
    await stopSearchIndexer();
    await stopMlxEmbedWorker();
    for (const k of [
      "HUGGINGFACE_HUB_CACHE",
      "OPENSTYLE_MLX_EMBED_WORKER",
      "FAKE_EMBED_BOW",
      "OPENSTYLE_SQLITE_VEC_PATH",
    ])
      delete process.env[k];
    closeDb();
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Three small meetings: two in Aurora, one unfiled; one number each. */
  async function seedThree(): Promise<void> {
    const day = 86_400_000;
    meeting(
      "m1",
      "f-aurora",
      [
        "The zeppelin hangar invoice number is 48213 and Ana pays it on Friday.",
        "Nobody objected to the plan for the hangar roof.",
      ],
      10 * day,
    );
    meeting(
      "m2",
      "f-aurora",
      [
        "The marmalade supplier sends invoice 77120 for the kitchen.",
        "Ben asks about the schedule of the next delivery.",
      ],
      20 * day,
    );
    meeting(
      "m3",
      null,
      ["The unfiled call talks about invoice 99001 and the zeppelin crew."],
      30 * day,
    );
    for (const id of ["m1", "m2", "m3"]) {
      expect(await indexMeeting(id)).toBe("indexed");
    }
  }

  it("writes the BM25 rows of every chunk in the indexer transaction", async () => {
    await seedThree();
    for (const id of ["m1", "m2", "m3"]) {
      const ids = chunkIds(id);
      expect(ids.length).toBeGreaterThanOrEqual(2); // transcript and meta
      for (const c of ids) expect(inFts(c)).toBe(true);
    }
    const hits = ftsSearch(getDb(), { text: "48213", k: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.meetingId).toBe("m1");
    expect(hits[0]?.kind).toBe("transcript");
  });

  it("finds a word of the meeting title in the meta chunk", async () => {
    meeting("m9", null, ["Plain words only."], Date.now(), "Quokka offsite");
    await indexMeeting("m9");
    const hits = ftsSearch(getDb(), { text: "quokka", k: 5 });
    expect(hits.map((h) => h.kind)).toContain("meta");
  });

  it("removes the rows of a replaced chunk and keeps the rows of a kept chunk", async () => {
    const sentences = Array.from(
      { length: 30 },
      (_, i) =>
        `We talked about the hardware budget item number ${i} and the plan for the next quarter with the whole team present today.`,
    );
    meeting("m1", "f-aurora", sentences);
    await indexMeeting("m1");
    const before = chunkIds("m1");
    getDb()
      .prepare(
        "UPDATE meeting_segments SET enhanced_text = ? WHERE id = 'm1:system:29'",
      )
      .run("The quokkas arrive on Friday.");
    expect(await indexMeeting("m1")).toBe("indexed");
    const after = chunkIds("m1");
    const gone = before.filter((id) => !after.includes(id));
    expect(gone.length).toBeGreaterThanOrEqual(1);
    for (const id of gone) expect(inFts(id)).toBe(false);
    for (const id of after) expect(inFts(id)).toBe(true);
    expect(ftsSearch(getDb(), { text: "quokkas", k: 5 })).toHaveLength(1);
  });

  it("drops the rows of a deleted meeting when the gc drains", async () => {
    await seedThree();
    const ids = chunkIds("m2");
    getDb().prepare("DELETE FROM meetings WHERE id = 'm2'").run();
    drainSearchGc();
    for (const id of ids) expect(inFts(id)).toBe(false);
    expect(ftsSearch(getDb(), { text: "77120", k: 5 })).toHaveLength(0);
  });

  it("deletes by rowid in a contentless table", () => {
    const db = getDb();
    ftsUpsertChunks(db, [
      { id: 900001, text: "alpha beta", title: "T1" },
      { id: 900002, text: "alpha gamma", title: "T2" },
    ]);
    expect(inFts(900001)).toBe(true);
    ftsDeleteChunks(db, [900001, 123456789]); // a missing id is fine
    expect(inFts(900001)).toBe(false);
    expect(inFts(900002)).toBe(true);
    // Upsert again: one row, not two.
    ftsUpsertChunks(db, [{ id: 900002, text: "delta", title: "T2" }]);
    const rows = db
      .prepare("SELECT rowid FROM meeting_chunks_fts WHERE rowid = 900002")
      .all();
    expect(rows).toHaveLength(1);
    ftsDeleteChunks(db, [900002]);
  });

  it("filters by meeting, folder, unfiled, exclude and an empty allow list", async () => {
    await seedThree();
    const db = getDb();
    const meetings = (input: Parameters<typeof ftsSearch>[1]) =>
      [...new Set(ftsSearch(db, input).map((h) => h.meetingId))].sort();
    expect(meetings({ text: "invoice", k: 20 })).toEqual(["m1", "m2", "m3"]);
    expect(
      meetings({ text: "invoice", k: 20, allowMeetingIds: ["m2"] }),
    ).toEqual(["m2"]);
    expect(meetings({ text: "invoice", k: 20, folderKey: "f-aurora" })).toEqual(
      ["m1", "m2"],
    );
    expect(meetings({ text: "invoice", k: 20, folderKey: "" })).toEqual(["m3"]);
    expect(
      meetings({ text: "invoice", k: 20, excludeMeetingIds: ["m1", "m3"] }),
    ).toEqual(["m2"]);
    expect(meetings({ text: "invoice", k: 20, allowMeetingIds: [] })).toEqual(
      [],
    );
    expect(
      meetings({ text: "invoice", k: 20, modelId: "other-model" }),
    ).toEqual([]);
    expect(ftsSearch(db, { text: "invoice", k: 1 })).toHaveLength(1);
  });

  it("orders by BM25: the chunk with more matches comes first", () => {
    const db = getDb();
    ftsUpsertChunks(db, [
      { id: 910001, text: "quokka", title: "" },
      { id: 910002, text: "quokka quokka quokka and one more word", title: "" },
    ]);
    // These ids have no meeting_chunks rows, so the join hides them. Add them.
    db.prepare(
      "INSERT INTO meetings (id, title, status, started_at) VALUES ('mb', 'B', 'transcribed', 1)",
    ).run();
    for (const id of [910001, 910002]) {
      db.prepare(
        `INSERT INTO meeting_chunks (id, meeting_id, ordinal, segment_ids, char_start, char_end,
           token_estimate, text_hash, model_id, created_at, kind)
         VALUES (?, 'mb', ?, '[]', 0, NULL, 1, ?, ?, 1, 'transcript')`,
      ).run(id, id - 910001, `h${id}`, EG2);
    }
    const ids = ftsSearch(db, { text: "quokka", k: 5 }).map((h) => h.chunkId);
    expect(new Set(ids)).toEqual(new Set([910001, 910002]));
    expect(ids[0]).toBe(910002);
    db.prepare("DELETE FROM meetings WHERE id = 'mb'").run();
    ftsDeleteChunks(db, [910001, 910002]);
  });

  it("rebuilds the missing rows of a meeting, and again does nothing", async () => {
    await seedThree();
    const db = getDb();
    const ids = chunkIds("m1");
    ftsDeleteChunks(db, ids);
    expect(ids.some(inFts)).toBe(false);
    expect(ftsBackfillMeeting(db, "m1", EG2)).toBe(ids.length);
    for (const id of ids) expect(inFts(id)).toBe(true);
    expect(ftsSearch(db, { text: "48213", k: 5 })).toHaveLength(1);
    expect(ftsBackfillMeeting(db, "m1", EG2)).toBe(0);
    expect(ftsBackfillMeeting(db, "no-such-meeting", EG2)).toBe(0);
  });

  it("rebuilds in the slow scan of the indexer loop", async () => {
    await seedThree();
    const all = ["m1", "m2", "m3"].flatMap(chunkIds);
    ftsDeleteChunks(getDb(), all);
    startSearchIndexer();
    const deadline = Date.now() + 15_000;
    while (!all.every(inFts) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await stopSearchIndexer();
    expect(all.every(inFts)).toBe(true);
  }, 20_000);

  it("dense mode is the old path: same hits as no mode, and no hybrid fields", async () => {
    await seedThree();
    const base = await retrieve({
      query: { kind: "text", text: "zeppelin hangar" },
      scope: { kind: "all" },
      k: 5,
    });
    const dense = await retrieve({
      query: { kind: "text", text: "zeppelin hangar" },
      scope: { kind: "all" },
      k: 5,
      mode: "dense",
      rerank: { candidates: 15 },
    });
    expect(dense).toEqual(base);
    expect(base.status).toBe("ok");
    if (base.status !== "ok") return;
    expect(base.rerank).toBeUndefined();
    expect(base.ms).toBeUndefined();
    expect(base.hits.every((h) => h.fusedRank === undefined)).toBe(true);
    expect(rerankStub).not.toHaveBeenCalled();
  });

  it("hybrid finds an exact number that the dense channel cannot", async () => {
    await seedThree();
    const res = await retrieve({
      query: { kind: "text", text: "48213" },
      scope: { kind: "all" },
      k: 3,
      mode: "hybrid",
    });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.rerank).toBe("off");
    const top = res.hits[0];
    expect(top?.meetingId).toBe("m1");
    expect(top?.kind).toBe("transcript");
    expect(top?.fusedRank).toBe(1);
    expect(top?.rerankScore).toBeUndefined();
    expect(typeof top?.score).toBe("number");
    expect(res.ms?.total).toBeGreaterThan(0);
    expect(res.ms?.rerank).toBe(0);
    expect(hitText(top as NonNullable<typeof top>, 500)).toContain("48213");
    expect(rerankStub).not.toHaveBeenCalled();
  });

  it("applies scope, tags, date range and exclude to both channels", async () => {
    await seedThree();
    const day = 86_400_000;
    const run = async (extra: Record<string, unknown>) => {
      const res = await retrieve({
        query: { kind: "text", text: "invoice zeppelin" },
        scope: { kind: "all" },
        k: 20,
        mode: "hybrid",
        ...extra,
      } as Parameters<typeof retrieve>[0]);
      if (res.status !== "ok") throw new Error(res.status);
      return [...new Set(res.hits.map((h) => h.meetingId))].sort();
    };
    expect(await run({})).toEqual(["m1", "m2", "m3"]);
    expect(
      await run({ scope: { kind: "folder", folderId: "f-aurora" } }),
    ).toEqual(["m1", "m2"]);
    expect(await run({ scope: { kind: "unfiled" } })).toEqual(["m3"]);
    expect(await run({ scope: { kind: "meeting", meetingId: "m2" } })).toEqual([
      "m2",
    ]);
    expect(await run({ excludeMeetingIds: ["m1"] })).toEqual(["m2", "m3"]);
    expect(
      await run({ dateRange: { fromMs: 15 * day, toMs: 25 * day } }),
    ).toEqual(["m2"]);
    expect(
      await run({ dateRange: { fromMs: 50 * day, toMs: 60 * day } }),
    ).toEqual([]);
  });

  it("hybrid on a meeting query stays dense", async () => {
    await seedThree();
    const res = await retrieve({
      query: { kind: "meeting", meetingId: "m1" },
      scope: { kind: "all" },
      k: 5,
      excludeMeetingIds: ["m1"],
      mode: "hybrid",
      rerank: { candidates: 15 },
    });
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.rerank).toBeUndefined();
    expect(rerankStub).not.toHaveBeenCalled();
  });

  it("falls back to dense only when the FTS table is missing", async () => {
    await seedThree();
    getDb().exec("DROP TABLE meeting_chunks_fts");
    expect(ftsAvailable(getDb())).toBe(false);
    expect(ftsSearch(getDb(), { text: "48213", k: 5 })).toEqual([]);
    ftsUpsertChunks(getDb(), [{ id: 1, text: "a", title: "b" }]);
    ftsDeleteChunks(getDb(), [1]);
    expect(ftsBackfillMeeting(getDb(), "m1", EG2)).toBe(0);
    // The indexer still writes meetings.
    meeting("m4", null, ["A late fictional meeting about the quokka fence."]);
    expect(await indexMeeting("m4")).toBe("indexed");
    getDb().prepare("DELETE FROM meetings WHERE id = 'm4'").run();
    expect(() => drainSearchGc()).not.toThrow();
    const res = await retrieve({
      query: { kind: "text", text: "zeppelin hangar" },
      scope: { kind: "all" },
      k: 3,
      mode: "hybrid",
    });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.ms?.fts).toBeGreaterThanOrEqual(0);
  });

  describe("rerank", () => {
    const hybrid = (candidates: number, k = 3) =>
      retrieve({
        query: { kind: "text", text: "invoice" },
        scope: { kind: "all" },
        k,
        mode: "hybrid",
        rerank: { candidates },
      });

    it("sorts the top candidates by the reranker score", async () => {
      await seedThree();
      rerankStub.mockImplementation(async (_q: string, docs: string[]) =>
        // The best score goes to the document with 77120.
        docs.map((d) => (d.includes("77120") ? 0.99 : 0.1)),
      );
      const res = await hybrid(6);
      expect(res.status).toBe("ok");
      if (res.status !== "ok") return;
      expect(res.rerank).toBe("applied");
      expect(res.hits[0]?.meetingId).toBe("m2");
      expect(res.hits[0]?.rerankScore).toBe(0.99);
      expect(res.ms?.rerank).toBeGreaterThanOrEqual(0);
      const [query, docs] = rerankStub.mock.calls[0] as [string, string[]];
      expect(query).toBe("invoice");
      expect(docs.length).toBeLessThanOrEqual(6);
      expect(docs.some((d) => d.includes("48213"))).toBe(true);
    });

    it("keeps the fused order for hits beyond the candidates", async () => {
      await seedThree();
      rerankStub.mockImplementation(async (_q: string, docs: string[]) =>
        docs.map((_d, i) => i / 10),
      );
      const res = await hybrid(2, 6);
      if (res.status !== "ok") throw new Error(res.status);
      expect(rerankStub.mock.calls[0]?.[1]).toHaveLength(2);
      // Candidates 1 and 2 swap, the others keep their fused ranks.
      expect(res.hits.slice(0, 2).map((h) => h.fusedRank)).toEqual([2, 1]);
      expect(res.hits.slice(2).map((h) => h.fusedRank)).toEqual(
        res.hits.slice(2).map((_h, i) => i + 3),
      );
      expect(res.hits[3]?.rerankScore).toBeUndefined();
    });

    it("returns the fused order and says unavailable when the model is missing", async () => {
      await seedThree();
      rerankStub.mockRejectedValue(new RerankError("no_model", "no model"));
      const res = await hybrid(6);
      if (res.status !== "ok") throw new Error(res.status);
      expect(res.rerank).toBe("unavailable");
      expect(res.hits.map((h) => h.fusedRank)).toEqual([1, 2, 3]);
      expect(res.hits.every((h) => h.rerankScore === undefined)).toBe(true);
    });

    it("returns the fused order and says error when the reranker fails", async () => {
      await seedThree();
      rerankStub.mockRejectedValue(new RerankError("rerank_failed", "boom"));
      const res = await hybrid(6);
      if (res.status !== "ok") throw new Error(res.status);
      expect(res.rerank).toBe("error");
      expect(res.hits.map((h) => h.fusedRank)).toEqual([1, 2, 3]);
      rerankStub.mockRejectedValue(new Error("anything else"));
      const again = await hybrid(6);
      expect(again.status === "ok" && again.rerank).toBe("error");
    });

    it("reports cancelled when the signal is aborted during the rerank", async () => {
      await seedThree();
      const controller = new AbortController();
      rerankStub.mockImplementation(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      });
      const res = await retrieve({
        query: { kind: "text", text: "invoice" },
        scope: { kind: "all" },
        k: 3,
        mode: "hybrid",
        rerank: { candidates: 6 },
        signal: controller.signal,
      });
      expect(res).toEqual({ status: "error", kind: "cancelled" });
    });

    it("does not call the reranker when nothing matched", async () => {
      const res = await hybrid(6);
      if (res.status !== "ok") throw new Error(res.status);
      expect(res.hits).toEqual([]);
      expect(res.rerank).toBe("off");
      expect(rerankStub).not.toHaveBeenCalled();
    });
  });
});
