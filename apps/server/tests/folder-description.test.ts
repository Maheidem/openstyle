// The folder description suggestion (issue #373). The real route, gateway and
// recorder run over a scripted model. All meeting text is fictional.
import {
  FOLDER_DESCRIPTION_SUGGEST_MAX_CHARS,
  folderDescriptionSuggestErrorSchema,
  folderDescriptionSuggestionSchema,
  meetingFolderSchema,
} from "@openstyle/validations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import {
  buildFolderDescriptionSystemPrompt,
  cleanDescription,
  dominantLanguage,
  FOLDER_DESCRIPTION_MAX_INPUT_TOKENS,
  FOLDER_DESCRIPTION_MAX_MEETINGS,
  FOLDER_NOTE_MAX_CHARS,
  groupLines,
  noteBudget,
  noteOfSummary,
} from "../src/lib/meetings/folder-description.js";
import { okReply, reply } from "./helpers/fake-model.js";
import { jsonRequest } from "./helpers/http.js";
import { resetMeetingTables } from "./helpers/meetings-db.js";
import {
  type RecordedRequest,
  responderModel,
  seedTestModel,
  TEST_MODEL,
} from "./helpers/workflow-harness.js";

const model = vi.hoisted(() => ({
  current: null as null | (() => Promise<unknown>),
}));

vi.mock("../src/lib/providers.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/providers.js")>();
  return {
    ...real,
    createChatModel: (...args: Parameters<typeof real.createChatModel>) =>
      model.current
        ? (model.current() as ReturnType<typeof real.createChatModel>)
        : real.createChatModel(...args),
  };
});

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const app = createApp();
const base = "/api/meetings/folders";

beforeEach(() => {
  resetMeetingTables();
  getDb().exec("DELETE FROM llm_runs WHERE scope = 'folder'");
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  model.current = null;
  seedTestModel();
});

async function createFolder(name: string, description?: string) {
  const res = await jsonRequest(app, "POST", base, { name, description });
  expect(res.status).toBe(201);
  return meetingFolderSchema.parse(await res.json());
}

function insertMeeting(o: {
  id: string;
  folderId: string;
  startedAt: number;
  title?: string;
  language?: string | null;
  summary?: unknown;
  markdown?: string | null;
}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO meetings (id, title, status, started_at, created_at, folder_id, language)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id,
    o.title ?? o.id,
    o.summary === undefined && o.markdown === undefined
      ? "transcribed"
      : "summarized",
    o.startedAt,
    o.startedAt,
    o.folderId,
    o.language ?? null,
  );
  if (o.summary !== undefined || o.markdown !== undefined) {
    db.prepare(
      `INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      o.id,
      o.markdown ?? null,
      o.summary === undefined ? null : JSON.stringify(o.summary),
      o.startedAt,
    );
  }
}

const summary = (overview: string, keyPoints: string[] = []) => ({
  overview,
  keyPoints,
  decisions: ["Ship the beta in May"],
  actionItems: [{ task: "Book the demo room", owner: null, due: null }],
  openQuestions: [],
});

/** The scripted model: every request gets `answer(req)`. */
function script(answer: (req: RecordedRequest) => string) {
  const made = responderModel(TEST_MODEL, (req) =>
    okReply(JSON.stringify({ description: answer(req) })),
  );
  model.current = async () => made.model;
  return made.requests;
}

function suggest(folderId: string) {
  return app.request(`${base}/${folderId}/suggest-description`, {
    method: "POST",
  });
}

describe("notes (code)", () => {
  it("builds one line from the overview, key points and decisions, without action items", () => {
    const note = noteOfSummary({
      id: "m1",
      title: "Harbor kickoff",
      language: "en",
      summary_json: JSON.stringify(
        summary("The team plans the Harbor app.", ["Pick a map vendor"]),
      ),
      markdown: "# ignored",
    });
    expect(note?.line).toBe(
      "- Harbor kickoff: The team plans the Harbor app.; Pick a map vendor; Ship the beta in May",
    );
  });

  it("reads the markdown of an older summary and skips a summary with no text", () => {
    expect(
      noteOfSummary({
        id: "m2",
        title: null,
        language: null,
        summary_json: null,
        markdown: "## Key points\n- **Tide** sensor test\n\n1. Buoy order",
      }),
    ).toMatchObject({ line: "- Key points; Tide sensor test; Buoy order" });
    expect(
      noteOfSummary({
        id: "m3",
        title: "Empty",
        language: null,
        summary_json: JSON.stringify(summary("")),
        markdown: null,
      }),
    ).toMatchObject({ line: "- Empty: Ship the beta in May" });
    expect(
      noteOfSummary({
        id: "m4",
        title: "Nothing",
        language: null,
        summary_json: null,
        markdown: "  \n",
      }),
    ).toBeNull();
  });

  it("cuts a long note at a word end", () => {
    const note = noteOfSummary({
      id: "m5",
      title: "Long",
      language: null,
      summary_json: JSON.stringify(summary("word ".repeat(400))),
      markdown: null,
    });
    expect(note?.line.length).toBeLessThanOrEqual(FOLDER_NOTE_MAX_CHARS + 2);
    expect(note?.line.endsWith("word…")).toBe(true);
  });

  it("picks the most common language; a tie goes to the newer meeting", () => {
    const n = (language: string | null) => ({
      meetingId: "x",
      language,
      line: "-",
    });
    expect(dominantLanguage([n("pt"), n("en"), n("en"), n(null)])).toBe("en");
    expect(dominantLanguage([n("de"), n("fr")])).toBe("de");
    expect(dominantLanguage([n(null)])).toBeNull();
  });

  it("packs lines into groups in order, each within the budget", () => {
    const line = "x".repeat(399); // 100 tokens + 1
    const groups = groupLines([line, line, line, line, line], 250);
    expect(groups.map((g) => g.length)).toEqual([2, 2, 1]);
    expect(groupLines([], 250)).toEqual([]);
  });

  it("keeps the budget under the cap and the window", () => {
    expect(noteBudget({ contextWindow: null }, 200, 300)).toBe(
      FOLDER_DESCRIPTION_MAX_INPUT_TOKENS,
    );
    expect(noteBudget({ contextWindow: 2000 }, 200, 300)).toBe(
      2000 - 200 - 300 - 256,
    );
    // A tiny window still holds one note.
    expect(noteBudget({ contextWindow: 500 }, 200, 300)).toBe(151);
  });

  it("cleans the answer: one line, no quotes, three sentences, the length cap", () => {
    expect(cleanDescription('  "One.  Two!\nThree? Four. Five."  ')).toBe(
      "One. Two! Three?",
    );
    expect(cleanDescription("会議の計画。二つ目。三つ目。四つ目。")).toBe(
      "会議の計画。 二つ目。 三つ目。",
    );
    const long = cleanDescription(`${"word ".repeat(300)}.`);
    expect(long.length).toBeLessThanOrEqual(
      FOLDER_DESCRIPTION_SUGGEST_MAX_CHARS,
    );
  });

  it("names the folder and the language in the system prompt", () => {
    const p = buildFolderDescriptionSystemPrompt({
      folderName: "Harbor",
      language: "pt",
    });
    expect(p).toContain('folder named "Harbor"');
    expect(p).toContain('ISO code "pt"');
    expect(
      buildFolderDescriptionSystemPrompt({ folderName: "H", language: null }),
    ).toContain("language of the notes");
  });
});

describe("POST /folders/:id/suggest-description", () => {
  it("answers 404 for an unknown folder", async () => {
    const res = await suggest("nope");
    expect(res.status).toBe(404);
    expect(
      folderDescriptionSuggestErrorSchema.parse(await res.json()).code,
    ).toBe("folder_not_found");
  });

  it("answers 409 no_summaries for an empty folder and a folder without summaries", async () => {
    const requests = script(() => "unused");
    const empty = await createFolder("Empty");
    const raw = await createFolder("Raw");
    insertMeeting({ id: "raw-1", folderId: raw.id, startedAt: 1 });
    for (const f of [empty, raw]) {
      const res = await suggest(f.id);
      expect(res.status).toBe(409);
      expect(
        folderDescriptionSuggestErrorSchema.parse(await res.json()).code,
      ).toBe("no_summaries");
    }
    expect(requests).toHaveLength(0);
  });

  it("answers 409 no_llm when no AI model is set up", async () => {
    getDb().exec("DELETE FROM model_configs WHERE type = 'llm'");
    const f = await createFolder("Harbor");
    insertMeeting({
      id: "h1",
      folderId: f.id,
      startedAt: 1,
      summary: summary("Plan the Harbor app."),
    });
    const res = await suggest(f.id);
    expect(res.status).toBe(409);
    expect(
      folderDescriptionSuggestErrorSchema.parse(await res.json()).code,
    ).toBe("no_llm");
  });

  it("small folder: one call over the notes, newest first; it saves nothing", async () => {
    const requests = script(
      () =>
        '"Harbor is a mobile app for tide alerts. The team builds the beta."',
    );
    const f = await createFolder("Harbor", "Old text");
    const other = await createFolder("Other");
    insertMeeting({
      id: "h1",
      folderId: f.id,
      startedAt: 1000,
      title: "Kickoff",
      language: "en",
      summary: summary("The team plans the Harbor app."),
    });
    insertMeeting({
      id: "h2",
      folderId: f.id,
      startedAt: 2000,
      title: "Sensor review",
      language: "en",
      summary: summary("The team tests the tide sensor."),
    });
    insertMeeting({
      id: "o1",
      folderId: other.id,
      startedAt: 3000,
      title: "Secret other folder",
      summary: summary("Not this folder."),
    });

    const res = await suggest(f.id);
    expect(res.status).toBe(200);
    expect(folderDescriptionSuggestionSchema.parse(await res.json())).toEqual({
      description:
        "Harbor is a mobile app for tide alerts. The team builds the beta.",
      meeting_count: 2,
    });
    expect(requests).toHaveLength(1);
    const user = requests[0]?.user ?? "";
    expect(user.indexOf("Sensor review")).toBeLessThan(user.indexOf("Kickoff"));
    expect(user).not.toContain("Secret other folder");
    expect(user).not.toContain("Book the demo room");
    expect(requests[0]?.system).toContain('folder named "Harbor"');
    expect(requests[0]?.system).toContain('ISO code "en"');

    // Nothing was saved.
    const folders = await (await app.request(base)).json();
    expect(
      (folders as { items: { id: string; description: string }[] }).items.find(
        (x) => x.id === f.id,
      )?.description,
    ).toBe("Old text");

    // The call is in the record, under the folder scope.
    const runs = getDb()
      .prepare(
        "SELECT scope, scope_id, kind, status, meeting_id FROM llm_runs WHERE scope = 'folder'",
      )
      .all();
    expect(runs).toEqual([
      {
        scope: "folder",
        scope_id: f.id,
        kind: "folderDescription",
        status: "succeeded",
        meeting_id: null,
      },
    ]);
    const calls = getDb()
      .prepare(
        "SELECT c.node FROM llm_calls c JOIN llm_runs r ON r.id = c.run_id WHERE r.scope = 'folder'",
      )
      .all();
    expect(calls).toEqual([{ node: "folderDescription" }]);
  });

  it("large folder: map over groups, then one reduce over the group answers", async () => {
    let map = 0;
    const requests = script((req) =>
      req.user.includes("- Group answer")
        ? "Harbor builds a tide alert app and its sensor network."
        : `Group answer ${++map}.`,
    );
    const f = await createFolder("Harbor");
    const longPoint = "tide sensor calibration and buoy firmware ".repeat(14);
    for (let i = 0; i < FOLDER_DESCRIPTION_MAX_MEETINGS + 5; i++) {
      insertMeeting({
        id: `m${String(i).padStart(2, "0")}`,
        folderId: f.id,
        startedAt: 1000 + i,
        title: `Weekly ${i}`,
        summary: summary(`Week ${i}.`, [longPoint]),
      });
    }
    const res = await suggest(f.id);
    expect(res.status).toBe(200);
    const body = folderDescriptionSuggestionSchema.parse(await res.json());
    expect(body).toEqual({
      description: "Harbor builds a tide alert app and its sensor network.",
      meeting_count: FOLDER_DESCRIPTION_MAX_MEETINGS,
    });
    expect(map).toBeGreaterThan(1);
    expect(requests).toHaveLength(map + 1);
    const reduce = requests[requests.length - 1]?.user ?? "";
    for (let i = 1; i <= map; i++)
      expect(reduce).toContain(`Group answer ${i}.`);
    // Only the newest meetings: the five oldest are out.
    const all = requests.map((r) => r.user).join("\n");
    expect(all).toContain("Weekly 44");
    expect(all).not.toContain("Weekly 4:");
    // Every map request fits the input cap.
    for (const r of requests.slice(0, -1)) {
      expect(Math.ceil(r.user.length / 4)).toBeLessThan(
        FOLDER_DESCRIPTION_MAX_INPUT_TOKENS + 100,
      );
    }
  });

  it("answers 502 llm_failed when the model fails twice, and records a failed run", async () => {
    const made = responderModel(TEST_MODEL, () =>
      reply("length", "length", '{"description":"cut'),
    );
    model.current = async () => made.model;
    const f = await createFolder("Harbor");
    insertMeeting({
      id: "h1",
      folderId: f.id,
      startedAt: 1,
      summary: summary("Plan the Harbor app."),
    });
    const res = await suggest(f.id);
    expect(res.status).toBe(502);
    expect(
      folderDescriptionSuggestErrorSchema.parse(await res.json()).code,
    ).toBe("llm_failed");
    expect(
      getDb()
        .prepare("SELECT status FROM llm_runs WHERE scope = 'folder'")
        .all(),
    ).toEqual([{ status: "failed" }]);
  });
});
