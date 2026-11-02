// The shape of the Ask graph (specs/meeting-chat-agent.md 11.9.7 point 3):
// `cite_check` is the last node before the end. No edge skips it.
import { describe, expect, it } from "vitest";
import { buildResearchGraph } from "../src/lib/chat/research/graph.js";
import type { Turn } from "../src/lib/chat/turn.js";

function edges(): Map<string, Set<string>> {
  const turn = {
    input: { llm: { isLocal: true }, settings: { rounds: 3 } },
  } as unknown as Turn;
  const graph = buildResearchGraph(turn, false).getGraph();
  const out = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    const s = out.get(e.source) ?? new Set<string>();
    s.add(e.target);
    out.set(e.source, s);
  }
  return out;
}

const reach = (
  from: string,
  g: Map<string, Set<string>>,
  blocked: Set<string>,
): Set<string> => {
  const seen = new Set<string>();
  const todo = [from];
  while (todo.length > 0) {
    const n = todo.pop() as string;
    for (const m of g.get(n) ?? []) {
      if (seen.has(m) || blocked.has(m)) continue;
      seen.add(m);
      todo.push(m);
    }
  }
  return seen;
};

describe("the Ask graph", () => {
  const g = edges();

  it("has the nodes of 11.9.5", () => {
    const nodes = new Set([
      ...g.keys(),
      ...[...g.values()].flatMap((s) => [...s]),
    ]);
    for (const n of [
      "scope",
      "plan",
      "act",
      "observe",
      "reflect",
      "blocks",
      "synthesize",
      "cite_check",
      "not_found",
    ]) {
      expect(nodes.has(n), n).toBe(true);
    }
  });

  it("reaches the end from synthesize only through cite_check or not_found", () => {
    const blocked = new Set(["cite_check", "not_found"]);
    expect(reach("synthesize", g, blocked).has("__end__")).toBe(false);
  });

  it("leads into the end only from the nodes that build a result", () => {
    const into = [...g.entries()]
      .filter(([, to]) => to.has("__end__"))
      .map(([from]) => from)
      .sort();
    expect(into).toEqual([
      "blocks",
      "cite_check",
      "not_found",
      "plan",
      "scope",
    ]);
  });

  it("gives the only edge from synthesize to cite_check, itself and not_found", () => {
    expect([...(g.get("synthesize") ?? [])].sort()).toEqual([
      "cite_check",
      "not_found",
      "synthesize",
    ]);
  });
});
