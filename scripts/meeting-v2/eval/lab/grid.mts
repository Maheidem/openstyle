// grid.mts: the grid file of the Eval Lab and its expansion into cells.
//
// A grid file is JSON:
//   {
//     "name": "owner-name",            // letters, digits, '.', '_', '-'
//     "stage": "asr",                  // phase 2 has the asr stage only
//     "corpus": "silver-14",
//     "meetings": ["ab518a0c"],        // optional subset of the corpus (id8)
//     "base": { "vocabulary": "corpus" },        // optional, for every cell
//     "grid": { "owner_name": ["unset", "env"] }, // optional cartesian product
//     "cells": [ { "asr_model": "qwen3-0.6b-8bit" } ] // optional explicit cells
//   }
// The cells are the cartesian product of "grid" plus the explicit "cells",
// each merged over "base" and then over the knob defaults. Two cells with
// the same knob values are one cell.

import { type KnobValues, resolveKnobs } from "./knobs.mts";

export interface Grid {
  name: string;
  stage: "asr";
  corpus: string;
  meetings?: string[];
  base?: Record<string, unknown>;
  grid?: Record<string, unknown[]>;
  cells?: Record<string, unknown>[];
}

export interface Cell {
  /** 1-based position in the expansion. */
  index: number;
  /** The knobs that the grid file sets (the others have their default). */
  set: Record<string, string>;
  knobs: KnobValues;
}

const KEYS = new Set([
  "name",
  "stage",
  "corpus",
  "meetings",
  "base",
  "grid",
  "cells",
  "description",
]);

export function parseGrid(text: string): Grid {
  const g = JSON.parse(text) as Grid;
  if (!g || typeof g !== "object" || Array.isArray(g))
    throw new Error("a grid file is a JSON object");
  for (const k of Object.keys(g))
    if (!KEYS.has(k)) throw new Error(`grid: unknown field ${k}`);
  if (typeof g.name !== "string" || !/^[A-Za-z0-9][\w.-]{0,60}$/.test(g.name))
    throw new Error("grid: name must be letters, digits, '.', '_' or '-'");
  if (g.stage !== "asr") throw new Error('grid: stage must be "asr"');
  if (typeof g.corpus !== "string" || g.corpus === "")
    throw new Error("grid: corpus is required");
  if (
    g.meetings !== undefined &&
    (!Array.isArray(g.meetings) ||
      g.meetings.some((m) => typeof m !== "string" || !/^[0-9a-f]{8}$/.test(m)))
  )
    throw new Error("grid: meetings must be a list of id8 values");
  if (g.grid !== undefined)
    for (const [k, v] of Object.entries(g.grid))
      if (!Array.isArray(v) || v.length === 0)
        throw new Error(`grid: grid.${k} must be a non-empty list`);
  if (g.cells !== undefined && !Array.isArray(g.cells))
    throw new Error("grid: cells must be a list of objects");
  return g;
}

/** The cartesian product of the grid lists, in key order then value order. */
function product(grid: Record<string, unknown[]>): Record<string, unknown>[] {
  let out: Record<string, unknown>[] = [{}];
  for (const [k, vs] of Object.entries(grid))
    out = out.flatMap((o) => vs.map((v) => ({ ...o, [k]: v })));
  return out;
}

export function expandGrid(g: Grid): Cell[] {
  const base = g.base ?? {};
  const raw = [
    ...(g.grid && Object.keys(g.grid).length > 0 ? product(g.grid) : []),
    ...(g.cells ?? []),
  ];
  if (raw.length === 0) raw.push({});
  const seen = new Set<string>();
  const cells: Cell[] = [];
  for (const r of raw) {
    const merged = { ...base, ...r };
    const knobs = resolveKnobs(merged);
    const key = JSON.stringify(knobs);
    if (seen.has(key)) continue;
    seen.add(key);
    const set = Object.fromEntries(
      Object.keys(merged).map((k) => [k, knobs[k] as string]),
    );
    cells.push({ index: cells.length + 1, set, knobs });
  }
  return cells;
}
