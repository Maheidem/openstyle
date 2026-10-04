import type {
  LlmParameterPreset,
  LlmTaskAssignments,
} from "@openstyle/validations";
import {
  LLM_PRESET_COUNT_MAX,
  LLM_PRESET_NAME_MAX,
  LLM_PRESET_PARAMS_MAX_BYTES,
  LLM_TASK_IDS,
} from "@openstyle/validations";
import { describe, expect, it } from "vitest";

import {
  checkPresetWrite,
  clampPresetName,
  duplicatePreset,
  isBuiltinPresetId,
  isDanglingAssignment,
  makePresetId,
  removePresetAndReassign,
  tasksUsingPreset,
  upsertPreset,
} from "./preset-ops";

// ---------------------------------------------------------------------------
// Pure preset/assignment algebra (specs/llm-task-profiles.md §4, §5, §11).
// The vitest config for this app is `environment: "node"` with no jsdom and
// no testing-library, which is deliberate: the risky part of this feature is
// not rendering, it's the array arithmetic behind "delete this preset and
// don't orphan a task". That arithmetic lives here and runs here.
// ---------------------------------------------------------------------------

const NOW = "2026-09-26T12:00:00.000Z";
const EARLIER = "2026-08-27T00:00:00.000Z";

function preset(
  id: string,
  name: string,
  params: Record<string, unknown> = { temperature: 0.7 },
  stamps: { createdAt?: string; updatedAt?: string } = {},
): LlmParameterPreset {
  return {
    id,
    name,
    params,
    createdAt: stamps.createdAt ?? EARLIER,
    updatedAt: stamps.updatedAt ?? EARLIER,
  };
}

const ALPHA = preset("user_alpha", "Alpha", {
  temperature: 0.3,
  chat_template_kwargs: { enable_thinking: true, nested: { deep: [1, 2] } },
});
const BETA = preset("user_beta", "Beta", { temperature: 1.0 });
const BUILTIN = preset("builtin:qwen-fast", "Qwen fast", {
  temperature: 0.7,
  chat_template_kwargs: { enable_thinking: false },
});

describe("makePresetId / isBuiltinPresetId", () => {
  it("always produces an id the storage schema accepts", () => {
    expect(makePresetId("abc-123")).toBe("user_abc-123");
    expect(makePresetId(crypto.randomUUID())).toMatch(/^user_/);
  });

  it("recognises the two built-ins and nothing else", () => {
    expect(isBuiltinPresetId("builtin:qwen-fast")).toBe(true);
    expect(isBuiltinPresetId("builtin:qwen-thinking")).toBe(true);
    expect(isBuiltinPresetId(ALPHA.id)).toBe(false);
    // A user id that merely mentions "builtin" is not a built-in.
    expect(isBuiltinPresetId("user_builtin-ish")).toBe(false);
  });
});

describe("upsertPreset", () => {
  const list = [ALPHA, BETA];

  it("replaces in place, preserving the order of everything else", () => {
    const edited = preset("user_alpha", "Alpha renames", { temperature: 0.9 });
    const next = upsertPreset(list, edited);
    expect(next.map((p) => p.id)).toEqual(["user_alpha", "user_beta"]);
    expect(next[0]).toEqual(edited);
    expect(next[1]).toBe(BETA);
  });

  it("appends an unseen id and never duplicates ids", () => {
    const gamma = preset("user_gamma", "Gamma");
    const next = upsertPreset(list, gamma);
    expect(next.map((p) => p.id)).toEqual([
      "user_alpha",
      "user_beta",
      "user_gamma",
    ]);
    expect(upsertPreset(next, gamma).map((p) => p.id)).toEqual(
      next.map((p) => p.id),
    );
    expect(upsertPreset(next, gamma)).toEqual(next);
  });

  it("does not mutate the input array", () => {
    const snapshot = [...list];
    upsertPreset(list, preset("user_alpha", "Mutant"));
    upsertPreset(list, preset("user_delta", "Delta"));
    expect(list).toEqual(snapshot);
    expect(list).toHaveLength(2);
  });

  it("works from an empty list", () => {
    expect(upsertPreset([], ALPHA)).toEqual([ALPHA]);
  });
});

describe("duplicatePreset", () => {
  const newId = makePresetId("0b6a6c00-deep-clone");

  it("deep-copies params — mutating the copy cannot touch the source", () => {
    const { presets, copy } = duplicatePreset([ALPHA], ALPHA, newId, {
      now: NOW,
      copyName: "Alpha copy",
    });
    expect(copy.params).toEqual(ALPHA.params);
    expect(copy.params).not.toBe(ALPHA.params);

    const nested = copy.params.chat_template_kwargs as Record<string, unknown>;
    const deep = nested.nested as { deep: number[] };
    deep.deep.push(3);
    nested.enable_thinking = false;
    copy.name = "Mutated";

    const original = presets.find(
      (p) => p.id === ALPHA.id,
    ) as LlmParameterPreset;
    expect(
      (original.params.chat_template_kwargs as Record<string, unknown>)
        .enable_thinking,
    ).toBe(true);
    expect(
      (
        (original.params.chat_template_kwargs as Record<string, unknown>)
          .nested as { deep: number[] }
      ).deep,
    ).toEqual([1, 2]);
    expect(original.name).toBe("Alpha");
  });

  it("names the copy, stamps both timestamps, and issues a storable id", () => {
    const { presets, copy } = duplicatePreset([BETA], BETA, newId, {
      now: NOW,
      copyName: `${BETA.name} copy`,
    });
    expect(copy.id).toMatch(/^user_/);
    expect(copy.name).toBe("Beta copy");
    expect(copy.createdAt).toBe(NOW);
    expect(copy.updatedAt).toBe(NOW);
    expect(copy.createdAt).toBe(copy.updatedAt);
    expect(presets.map((p) => p.id)).toEqual([BETA.id, copy.id]);
  });

  it("copies a built-in into a user-owned preset without touching the source", () => {
    const { presets, copy } = duplicatePreset([], BUILTIN, newId, {
      now: NOW,
      copyName: "Qwen fast copy",
    });
    expect(isBuiltinPresetId(copy.id)).toBe(false);
    expect(copy.params).toEqual(BUILTIN.params);
    expect(presets).toHaveLength(1);
    expect(BUILTIN.updatedAt).toBe(EARLIER);
  });

  it("clamps a copy name to the §4.1 bound", () => {
    const long = preset(`user_${"x".repeat(40)}`, "x".repeat(60));
    const { copy } = duplicatePreset([], long, newId, {
      now: NOW,
      copyName: `${long.name} copy`,
    });
    expect(copy.name.length).toBeLessThanOrEqual(LLM_PRESET_NAME_MAX);
    expect(clampPresetName("short")).toBe("short");
  });
});

describe("tasksUsingPreset", () => {
  it("finds every task pinned to the preset and ignores auto/custom modes", () => {
    const assignments: LlmTaskAssignments = {
      cleanup: { mode: "preset", presetId: ALPHA.id },
      remix: { mode: "preset", presetId: BETA.id },
      meetingSummarize: { mode: "preset", presetId: ALPHA.id },
      meetingEnhance: { mode: "custom", params: { temperature: 0.1 } },
    };
    expect(tasksUsingPreset(assignments, ALPHA.id)).toEqual([
      "cleanup",
      "meetingSummarize",
    ]);
    expect(tasksUsingPreset(assignments, BETA.id)).toEqual(["remix"]);
    expect(tasksUsingPreset({}, ALPHA.id)).toEqual([]);
    // A custom-mode assignment carrying the same id is not a preset use.
    expect(
      tasksUsingPreset(
        { cleanup: { mode: "auto", presetId: ALPHA.id } },
        ALPHA.id,
      ),
    ).toEqual([]);
  });
});

describe("removePresetAndReassign", () => {
  it("rewrites only the matching tasks to auto and reports them", () => {
    const assignments: LlmTaskAssignments = {
      cleanup: { mode: "preset", presetId: ALPHA.id },
      meetingEnhance: { mode: "preset", presetId: ALPHA.id },
      remix: { mode: "preset", presetId: BETA.id },
      meetingSummarize: { mode: "auto" },
    };
    const result = removePresetAndReassign(
      [ALPHA, BETA],
      assignments,
      ALPHA.id,
    );

    expect(result.reassignedTaskIds).toEqual(["cleanup", "meetingEnhance"]);
    expect(result.presets.map((p) => p.id)).toEqual([BETA.id]);
    expect(result.assignments.cleanup).toEqual({ mode: "auto" });
    expect(result.assignments.meetingEnhance).toEqual({ mode: "auto" });
    expect(result.assignments.cleanup?.presetId).toBeUndefined();
    expect(result.assignments.remix).toEqual({
      mode: "preset",
      presetId: BETA.id,
    });
    expect(JSON.stringify(result.assignments.meetingSummarize)).toBe(
      JSON.stringify(assignments.meetingSummarize),
    );
  });

  it("preserves each rewritten task's modelOverride and no other key", () => {
    const override = { provider: "local-llm", model_id: "qwen3.8-flash" };
    const result = removePresetAndReassign(
      [ALPHA],
      {
        cleanup: {
          mode: "preset",
          presetId: ALPHA.id,
          modelOverride: override,
        },
        // A custom-mode assignment for another task must survive verbatim.
        remix: {
          mode: "custom",
          params: { temperature: 0.1 },
          modelOverride: override,
        },
      },
      ALPHA.id,
    );
    expect(result.assignments.cleanup).toEqual({
      mode: "auto",
      modelOverride: override,
    });
    expect(result.assignments.cleanup?.modelOverride).toBe(override);
    expect(result.assignments.cleanup?.presetId).toBeUndefined();
    expect(result.assignments.remix).toEqual({
      mode: "custom",
      params: { temperature: 0.1 },
      modelOverride: override,
    });
  });

  it("leaves non-matching assignments byte-identical (same object identity)", () => {
    const assignments: LlmTaskAssignments = {
      cleanup: { mode: "preset", presetId: ALPHA.id },
      remix: { mode: "preset", presetId: BETA.id },
    };
    const result = removePresetAndReassign(
      [ALPHA, BETA],
      assignments,
      ALPHA.id,
    );
    expect(result.assignments.remix).toBe(assignments.remix);
    expect(JSON.stringify(result.assignments.remix)).toBe(
      JSON.stringify(assignments.remix),
    );
    expect(assignments.cleanup).toEqual({ mode: "preset", presetId: ALPHA.id });
  });

  it("is a no-op on presets and assignments when nothing uses the id", () => {
    const assignments: LlmTaskAssignments = {
      cleanup: { mode: "preset", presetId: ALPHA.id, modelOverride: undefined },
      remix: { mode: "auto" },
    };
    const result = removePresetAndReassign(
      [ALPHA],
      assignments,
      "user_does_not_exist",
    );
    expect(result.reassignedTaskIds).toEqual([]);
    expect(result.presets.map((p) => p.id)).toEqual([ALPHA.id]);
    expect(result.assignments).toEqual(assignments);
  });

  it("is idempotent when the preset id is absent", () => {
    const once = removePresetAndReassign(
      [ALPHA],
      { cleanup: { mode: "auto" } },
      ALPHA.id,
    );
    const twice = removePresetAndReassign(
      once.presets,
      once.assignments,
      ALPHA.id,
    );
    expect(twice.presets).toEqual(once.presets);
    expect(twice.assignments).toEqual(once.assignments);
    expect(twice.reassignedTaskIds).toEqual([]);
    expect(twice.presets).toEqual([]);
  });

  it("never leaves a dangling presetId behind (the §11 invariant)", () => {
    const assignments: LlmTaskAssignments = {
      cleanup: { mode: "preset", presetId: ALPHA.id },
      meetingSummarize: { mode: "preset", presetId: ALPHA.id },
      meetingEnhance: { mode: "preset", presetId: BUILTIN.id },
    };
    const presets = [ALPHA, BUILTIN];
    const result = removePresetAndReassign(presets, assignments, ALPHA.id);
    for (const taskId of LLM_TASK_IDS) {
      const assignment = result.assignments[taskId];
      if (assignment) {
        expect(isDanglingAssignment(assignment, result.presets)).toBe(false);
      }
    }
    expect(
      isDanglingAssignment(
        result.assignments.cleanup ?? { mode: "auto" },
        result.presets,
      ),
    ).toBe(false);
    // The untouched built-in assignment still resolves.
    expect(
      isDanglingAssignment(
        assignments.meetingEnhance ?? { mode: "auto" },
        presets,
      ),
    ).toBe(false);
  });
});

describe("isDanglingAssignment", () => {
  it("names the id of a preset that was deleted under a live assignment", () => {
    const assignments: LlmTaskAssignments = {
      cleanup: { mode: "preset", presetId: "user_ghost" },
      remix: { mode: "preset", presetId: ALPHA.id },
      meetingEnhance: { mode: "custom", params: {} },
    };
    expect(
      isDanglingAssignment(assignments.cleanup ?? { mode: "auto" }, [ALPHA]),
    ).toBe(true);
    expect(
      isDanglingAssignment(assignments.remix ?? { mode: "auto" }, [ALPHA]),
    ).toBe(false);
    // Built-ins resolve without ever being stored (§4.2).
    expect(
      isDanglingAssignment({ mode: "preset", presetId: BUILTIN.id }, [
        ALPHA,
        BUILTIN,
      ]),
    ).toBe(false);
    expect(isDanglingAssignment({ mode: "auto" }, [])).toBe(false);
  });
});

describe("checkPresetWrite — mirrors the route's §4.3 rules", () => {
  it("accepts an ordinary storable list", () => {
    expect(checkPresetWrite([ALPHA, BETA])).toBeNull();
    expect(checkPresetWrite([])).toBeNull();
  });

  it("refuses a list containing a built-in id — built-ins are never stored (§4.2)", () => {
    expect(checkPresetWrite([BUILTIN])).toEqual({
      kind: "invalidId",
      presetId: BUILTIN.id,
    });
  });

  it("rejects a list over the route's count cap and names it", () => {
    const many = Array.from({ length: LLM_PRESET_COUNT_MAX + 1 }, (_, i) =>
      preset(`user_${i}`, `Preset ${i}`),
    );
    expect(checkPresetWrite(many.slice(0, LLM_PRESET_COUNT_MAX))).toBeNull();
    expect(checkPresetWrite(many)).toEqual({
      kind: "countMax",
      max: LLM_PRESET_COUNT_MAX,
    });
  });

  it("rejects params over the byte cap, the way the route's loop does", () => {
    const fat = preset("user_fat", "Fat", {
      blob: "a".repeat(LLM_PRESET_PARAMS_MAX_BYTES),
    });
    expect(JSON.stringify(fat.params).length).toBeGreaterThan(
      LLM_PRESET_PARAMS_MAX_BYTES,
    );
    expect(checkPresetWrite([fat])).toEqual({
      kind: "tooLarge",
      presetId: "user_fat",
      name: "Fat",
      max: LLM_PRESET_PARAMS_MAX_BYTES,
    });
  });

  it("rejects an id the storage schema refuses (a spoofed built-in)", () => {
    expect(checkPresetWrite([preset("builtin:sneaky", "Sneaky")])).toEqual({
      kind: "invalidId",
      presetId: "builtin:sneaky",
    });
  });

  it("rejects a blank name (the §4.1 lower bound)", () => {
    expect(checkPresetWrite([preset("user_blank", "")])).toEqual({
      kind: "invalidName",
      presetId: "user_blank",
    });
  });
});

describe("schema guard over every produced shape", () => {
  const ids = [
    makePresetId(crypto.randomUUID()),
    duplicatePreset([], ALPHA, makePresetId(crypto.randomUUID()), {
      now: NOW,
      copyName: `${ALPHA.name} copy`,
    }).copy.id,
  ];

  const names = [
    ALPHA.name,
    duplicatePreset([], preset("user_long", "x".repeat(60)), ids[0] as string, {
      now: NOW,
      copyName: `${"x".repeat(60)} copy`,
    }).copy.name,
    clampPresetName("y".repeat(500)),
  ];

  it("never emits an id outside /^user_/ or a name over 60", () => {
    for (const id of ids) expect(id).toMatch(/^user_/);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(LLM_PRESET_NAME_MAX);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("produces a list the route would accept end to end", () => {
    const { copy } = duplicatePreset([ALPHA], ALPHA, ids[0] as string, {
      now: NOW,
      copyName: `${ALPHA.name} copy`,
    });
    expect(checkPresetWrite([ALPHA, copy])).toBeNull();
  });
});
