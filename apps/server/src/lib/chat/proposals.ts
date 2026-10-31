import type { DatabaseSync } from "node:sqlite";
import { normalizeTagNames } from "@openstyle/validations";
import {
  proposeActionItemChangeArgs,
  proposeMergePeopleArgs,
  proposeMoveArgs,
  proposeRetagArgs,
  WRITE_TOOL_NAMES,
  type WriteToolName,
} from "./tool-schemas.js";
import { findActionItem, listPeopleInScope, meetingInScope } from "./tools.js";
import type { TurnResult, TurnScope } from "./types.js";

// The write proposals of the meeting chat agent (specs/meeting-chat-agent.md
// 3.3). P1 is read only. These builders only validate the arguments, check
// that every id exists and is in the scope, and return the proposal object.
// They write nothing to the database. Only the eval and the router
// validation use them. Production never applies a proposal.

export type Proposal = NonNullable<TurnResult["proposal"]>;

/** Meetings in one retag proposal, at most (spec 3.3 rule 3). */
const PROPOSAL_MEETINGS_MAX = 20;

const unique = (xs: readonly string[]) => [...new Set(xs)];

function actionItemChange(
  db: DatabaseSync,
  scope: TurnScope,
  raw: unknown,
): Proposal | null {
  const a = proposeActionItemChangeArgs.safeParse(raw);
  if (!a.success) return null;
  if (!findActionItem(db, scope, a.data.item_id)) return null;
  return { kind: "action_item", ids: [a.data.item_id], arg: a.data.done };
}

function retag(
  db: DatabaseSync,
  scope: TurnScope,
  raw: unknown,
): Proposal | null {
  const a = proposeRetagArgs.safeParse(raw);
  if (!a.success) return null;
  const ids = unique(a.data.meeting_ids);
  if (ids.length > PROPOSAL_MEETINGS_MAX) return null;
  if (!ids.every((id) => meetingInScope(db, scope, id))) return null;
  const tag = normalizeTagNames([a.data.tag])[0];
  if (!tag) return null;
  return { kind: "retag", ids, arg: [tag] };
}

function move(
  db: DatabaseSync,
  scope: TurnScope,
  raw: unknown,
): Proposal | null {
  const a = proposeMoveArgs.safeParse(raw);
  if (!a.success) return null;
  if (!meetingInScope(db, scope, a.data.meeting_id)) return null;
  // The target folder can be outside the scope. It must exist.
  const folder = db
    .prepare("SELECT 1 FROM meeting_folders WHERE id = ?")
    .get(a.data.folder_id);
  if (!folder) return null;
  return { kind: "move", ids: [a.data.meeting_id], arg: a.data.folder_id };
}

function mergePeople(
  db: DatabaseSync,
  scope: TurnScope,
  raw: unknown,
): Proposal | null {
  const a = proposeMergePeopleArgs.safeParse(raw);
  if (!a.success) return null;
  const known = new Set(listPeopleInScope(db, scope).map((p) => p.id));
  const ids = unique(a.data.person_ids);
  if (!ids.every((id) => known.has(id))) return null;
  return { kind: "merge_people", ids, arg: null };
}

/**
 * The proposal for a write tool call at the id level, or null when the tool
 * is not a write tool, the arguments are bad, or an id does not exist or is
 * outside the scope. It reads the database and never writes to it.
 */
export function proposalFor(
  db: DatabaseSync,
  scope: TurnScope,
  tool: string,
  rawArgs: unknown,
): Proposal | null {
  if (!(WRITE_TOOL_NAMES as readonly string[]).includes(tool)) return null;
  switch (tool as WriteToolName) {
    case "propose_action_item_change":
      return actionItemChange(db, scope, rawArgs);
    case "propose_retag":
      return retag(db, scope, rawArgs);
    case "propose_move":
      return move(db, scope, rawArgs);
    case "propose_merge_people":
      return mergePeople(db, scope, rawArgs);
  }
}
