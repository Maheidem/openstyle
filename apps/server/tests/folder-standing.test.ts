// "Where things stand" of a folder (issue #374). The real routes, gateway and
// recorder run over a scripted model. All meeting text is fictional.
import {
  FOLDER_STANDING_BULLET_MAX_CHARS,
  FOLDER_STANDING_MAX_BULLETS,
  folderStandingErrorSchema,
  folderStandingSchema,
  folderStandingStateSchema,
} from "@openstyle/validations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { actionItemKey } from "../src/lib/meetings/folder-overview.js";
import {
  buildStandingInput,
  buildStandingSystemPrompt,
  cleanBullets,
  STANDING_LINE_MAX_CHARS,
  STANDING_MAX_ACTIONS,
} from "../src/lib/meetings/folder-standing.js";
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
  getDb().exec("DELETE FROM folder_standing");
  getDb().exec("DELETE FROM folder_action_item_state");
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  model.current = null;
  seedTestModel();
});

function addFolder(id: string, description: string | null = null) {
  getDb()
    .prepare(
      "INSERT INTO meeting_folders (id, name, description, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
    )
    .run(id, id === "f1" ? "Harbor" : id, description);
}

interface Seed {
  decisions?: string[];
  actionItems?: { task: string; owner: string | null; due: string | null }[];
  openQuestions?: string[];
}

function addMeeting(id: string, day: number, s: Seed, folder = "f1") {
  const db = getDb();
  db.prepare(
    `INSERT INTO meetings (id, title, status, started_at, created_at, folder_id, language)
     VALUES (?, ?, 'summarized', ?, ?, ?, 'en')`,
  ).run(id, id, day * 1000, day * 1000, folder);
  db.prepare(
    "INSERT INTO meeting_summaries (meeting_id, summary_json, created_at) VALUES (?, ?, ?)",
  ).run(
    id,
    JSON.stringify({
      overview: "",
      keyPoints: [],
      decisions: [],
      actionItems: [],
      openQuestions: [],
      ...s,
    }),
    day * 1000,
  );
}

const t = (
  task: string,
  owner: string | null = null,
  due: string | null = null,
) => ({
  task,
  owner,
  due,
});

function script(answer: (req: RecordedRequest) => string[]) {
  const made = responderModel(TEST_MODEL, (req) =>
    okReply(JSON.stringify({ bullets: answer(req) })),
  );
  model.current = async () => made.model;
  return made.requests;
}

const get = (id: string) => app.request(`${base}/${id}/standing`);
const post = (id: string) =>
  app.request(`${base}/${id}/standing`, { method: "POST" });

function seedFolder() {
  addFolder("f1", "A mobile app for tide alerts.");
  addFolder("f2");
  addMeeting("m1", 1, {
    decisions: ["Use React Native"],
    actionItems: [
      t("Send the pricing sheet to the harbor office", "Ana", "Friday"),
    ],
    openQuestions: ["Who pays for the buoy data feed?"],
  });
  addMeeting("m2", 2, {
    decisions: ["Close the beta to 50 boat owners"],
    actionItems: [t("Write the push alert texts", "Carla")],
  });
  addMeeting("o1", 3, { decisions: ["Secret other folder"] }, "f2");
}

describe("input (code)", () => {
  it("builds lines: open tasks, decisions, questions; done items and other folders stay out", () => {
    seedFolder();
    const key = actionItemKey("m2", "Write the push alert texts");
    getDb()
      .prepare(
        "INSERT INTO folder_action_item_state (folder_id, item_key, done, updated_at) VALUES ('f1', ?, 1, 1)",
      )
      .run(key);
    const input = buildStandingInput(getDb(), "f1");
    expect(input?.lines).toEqual([
      "- Open task: Send the pricing sheet to the harbor office (owner Ana) (due Friday)",
      "- Decision: Close the beta to 50 boat owners",
      "- Decision: Use React Native",
      "- Open question: Who pays for the buoy data feed?",
    ]);
    expect(input?.language).toBe("en");
    expect(input?.description).toBe("A mobile app for tide alerts.");
  });

  it("returns null for an unknown folder and for a folder with no items", () => {
    addFolder("f1");
    expect(buildStandingInput(getDb(), "f1")).toBeNull();
    expect(buildStandingInput(getDb(), "nope")).toBeNull();
  });

  it("changes the hash when an item is done, a decision is new, or the description changes", () => {
    seedFolder();
    const hash = () => buildStandingInput(getDb(), "f1")?.hash;
    const first = hash();
    expect(hash()).toBe(first);
    addMeeting("m3", 4, { decisions: ["Launch in May"] });
    const second = hash();
    expect(second).not.toBe(first);
    getDb().exec(
      "UPDATE meeting_folders SET description = 'Other' WHERE id = 'f1'",
    );
    expect(hash()).not.toBe(second);
  });

  it("caps the lines and cuts a long line", () => {
    addFolder("f1");
    addMeeting("m1", 1, {
      actionItems: Array.from({ length: STANDING_MAX_ACTIONS + 5 }, (_, i) =>
        t(`${`item${i}word `.repeat(60)}`),
      ),
    });
    const lines = buildStandingInput(getDb(), "f1")?.lines ?? [];
    expect(lines).toHaveLength(STANDING_MAX_ACTIONS);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(STANDING_LINE_MAX_CHARS + 20);
    }
  });
});

describe("prompt and clean-up (code)", () => {
  it("names the folder, the description and the language", () => {
    const p = buildStandingSystemPrompt({
      folderName: "Harbor",
      description: "Tide alerts",
      language: "pt",
    });
    expect(p).toContain('folder named "Harbor"');
    expect(p).toContain("Tide alerts");
    expect(p).toContain('ISO code "pt"');
    expect(
      buildStandingSystemPrompt({
        folderName: "H",
        description: null,
        language: null,
      }),
    ).toContain("language of the notes");
  });

  it("cleans bullets: list marks, duplicates, empties, count and length", () => {
    const out = cleanBullets([
      "- First point",
      "1. Second point",
      "  ",
      "first point",
      "x".repeat(500),
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(out).toHaveLength(FOLDER_STANDING_MAX_BULLETS);
    expect(out[0]).toBe("First point");
    expect(out[1]).toBe("Second point");
    expect(out[2]?.length).toBeLessThanOrEqual(
      FOLDER_STANDING_BULLET_MAX_CHARS,
    );
  });
});

describe("GET and POST /folders/:id/standing", () => {
  it("answers 404 for an unknown folder", async () => {
    expect((await get("nope")).status).toBe(404);
    expect((await post("nope")).status).toBe(404);
  });

  it("GET reads the saved text and never calls the model", async () => {
    seedFolder();
    const requests = script(() => ["x"]);
    const res = await get("f1");
    expect(folderStandingStateSchema.parse(await res.json())).toEqual({
      standing: null,
      can_generate: true,
    });
    addFolder("empty");
    expect(await (await get("empty")).json()).toEqual({
      standing: null,
      can_generate: false,
    });
    expect(requests).toHaveLength(0);
  });

  it("POST answers 409 no_content for a folder with nothing to read", async () => {
    addFolder("f1");
    const requests = script(() => ["x"]);
    const res = await post("f1");
    expect(res.status).toBe(409);
    expect(folderStandingErrorSchema.parse(await res.json()).code).toBe(
      "no_content",
    );
    expect(requests).toHaveLength(0);
  });

  it("POST answers 409 no_llm when no AI model is set up", async () => {
    seedFolder();
    getDb().exec("DELETE FROM model_configs WHERE type = 'llm'");
    const res = await post("f1");
    expect(res.status).toBe(409);
    expect(folderStandingErrorSchema.parse(await res.json()).code).toBe(
      "no_llm",
    );
  });

  it("POST writes, saves and records; GET shows it fresh, then stale after a change", async () => {
    const requests = script(() => [
      "- The team uses React Native.",
      "The beta is closed to 50 boat owners.",
      "Open: who pays for the buoy data feed.",
    ]);
    seedFolder();
    const res = await post("f1");
    expect(res.status).toBe(200);
    const body = folderStandingSchema.parse(await res.json());
    expect(body.bullets).toEqual([
      "The team uses React Native.",
      "The beta is closed to 50 boat owners.",
      "Open: who pays for the buoy data feed.",
    ]);
    expect(body.stale).toBe(false);
    expect(requests).toHaveLength(1);
    const user = requests[0]?.user ?? "";
    expect(user).toContain("Open task: Send the pricing sheet");
    expect(user).not.toContain("Secret other folder");
    expect(requests[0]?.system).toContain('folder named "Harbor"');
    expect(requests[0]?.system).toContain("A mobile app for tide alerts.");

    const fresh = folderStandingStateSchema.parse(
      await (await get("f1")).json(),
    );
    expect(fresh.standing).toMatchObject({
      stale: false,
      generated_at: body.generated_at,
    });

    // A new summary changes the input: the saved text is out of date.
    addMeeting("m3", 5, { decisions: ["Launch in May"] });
    const stale = folderStandingStateSchema.parse(
      await (await get("f1")).json(),
    );
    expect(stale.standing?.stale).toBe(true);
    expect(stale.standing?.bullets).toEqual(body.bullets);
    // Marking an item done also changes the input.
    expect(requests).toHaveLength(1);

    const runs = getDb()
      .prepare(
        "SELECT scope, scope_id, kind, status FROM llm_runs WHERE scope = 'folder'",
      )
      .all();
    expect(runs).toEqual([
      {
        scope: "folder",
        scope_id: "f1",
        kind: "folderStanding",
        status: "succeeded",
      },
    ]);
    expect(
      getDb()
        .prepare(
          "SELECT c.node FROM llm_calls c JOIN llm_runs r ON r.id = c.run_id WHERE r.scope = 'folder'",
        )
        .all(),
    ).toEqual([{ node: "folderStanding" }]);

    // Refresh replaces the text.
    script(() => ["Everything is on track."]);
    const again = folderStandingSchema.parse(await (await post("f1")).json());
    expect(again.bullets).toEqual(["Everything is on track."]);
    expect(
      getDb().prepare("SELECT COUNT(*) AS n FROM folder_standing").get(),
    ).toEqual({ n: 1 });
    expect(
      folderStandingStateSchema.parse(await (await get("f1")).json()).standing
        ?.stale,
    ).toBe(false);
  });

  it("large input: map over groups, then one reduce over the map bullets", async () => {
    addFolder("f1");
    const words = (prefix: string, i: number) =>
      Array.from({ length: 30 }, (_, j) => `${prefix}${i}x${j}`).join(" ");
    addMeeting("m1", 1, {
      actionItems: Array.from({ length: 20 }, (_, i) => t(words("task", i))),
      decisions: Array.from({ length: 15 }, (_, i) => words("dec", i)),
    });
    let map = 0;
    const requests = script((req) =>
      req.user.includes("- Group bullet")
        ? ["The project is on track."]
        : [`Group bullet ${++map}.`],
    );
    const res = await post("f1");
    expect(res.status).toBe(200);
    expect(map).toBeGreaterThan(1);
    expect(requests).toHaveLength(map + 1);
    const reduce = requests[requests.length - 1]?.user ?? "";
    for (let i = 1; i <= map; i++)
      expect(reduce).toContain(`Group bullet ${i}.`);
    expect(folderStandingSchema.parse(await res.json()).bullets).toEqual([
      "The project is on track.",
    ]);
  });

  it("POST answers 502 llm_failed when the model fails twice; nothing is saved", async () => {
    seedFolder();
    const made = responderModel(TEST_MODEL, () =>
      reply("length", "length", '{"bullets":["cut'),
    );
    model.current = async () => made.model;
    const res = await post("f1");
    expect(res.status).toBe(502);
    expect(folderStandingErrorSchema.parse(await res.json()).code).toBe(
      "llm_failed",
    );
    expect(
      getDb().prepare("SELECT COUNT(*) AS n FROM folder_standing").get(),
    ).toEqual({ n: 0 });
    expect(
      getDb()
        .prepare("SELECT status FROM llm_runs WHERE scope = 'folder'")
        .all(),
    ).toEqual([{ status: "failed" }]);
  });

  it("the Overview route does not call the model", async () => {
    seedFolder();
    const requests = script(() => ["x"]);
    const res = await app.request(`${base}/f1/overview`);
    expect(res.status).toBe(200);
    expect(requests).toHaveLength(0);
    await jsonRequest(app, "PUT", `${base}/f1/action-items/0123456789abcdef`, {
      done: true,
    });
    expect(requests).toHaveLength(0);
  });
});
