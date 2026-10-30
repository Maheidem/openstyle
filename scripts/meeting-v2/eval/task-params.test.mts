import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkTaskLinks,
  parseTaskParams,
  taskAssignmentsValue,
} from "./task-params.mts";

const P = { temperature: 0, top_p: 0.95, top_k: 64 };
const KEY = "local-mlx-llm::gemma-4-e2b-qat-4bit";

test("parseTaskParams accepts an object and refuses the rest", () => {
  assert.deepEqual(parseTaskParams('{"temperature":0}'), { temperature: 0 });
  for (const bad of ["", "x", "[]", "3", "null", "{}"])
    assert.throws(() => parseTaskParams(bad), /--task-params/);
});

test("taskAssignmentsValue sets the two meeting tasks only", () => {
  const v = JSON.parse(taskAssignmentsValue(P));
  assert.deepEqual(Object.keys(v).sort(), [
    "meetingEnhance",
    "meetingSummarize",
  ]);
  assert.deepEqual(v.meetingEnhance, { mode: "custom", params: P });
});

test("checkTaskLinks reads the stored links back", () => {
  const link = { mode: "custom", params: P };
  const ok = JSON.stringify({
    [KEY]: { meetingEnhance: link, meetingSummarize: link },
  });
  assert.equal(checkTaskLinks(ok, KEY, P), null);
  assert.match(checkTaskLinks(undefined, KEY, P) ?? "", /not stored/);
  assert.match(checkTaskLinks(ok, "other", P) ?? "", /no link/);
  assert.match(
    checkTaskLinks(ok, KEY, { ...P, temperature: 1 }) ?? "",
    /differs/,
  );
  const extra = JSON.stringify({
    [KEY]: { meetingEnhance: link, meetingSummarize: link, cleanup: link },
  });
  assert.match(checkTaskLinks(extra, KEY, P) ?? "", /unexpected/);
});
