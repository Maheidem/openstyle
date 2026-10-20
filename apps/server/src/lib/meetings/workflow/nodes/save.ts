import { createAppLogger } from "@openstyle/utils";
import { withTransaction } from "../../../db.js";
import type { NewLink } from "../../../llm/recorder.js";
import { writeTranscriptMarkdown } from "../../transcript-io.js";
import type { WorkflowDeps } from "../context.js";
import type { WorkflowStateType } from "../state.js";
import type {
  CorrectUnitResult,
  NodeFailure,
  SaveResult,
  WriteOutcome,
} from "../types.js";
import { guardNode, internalFailure } from "../unit.js";

// Node `save` (specs/meeting-enhance-agentic.md 4.6). Code only. The only node
// that writes meeting data. Each write is its own transaction; a failed write
// does not roll back the others. Every write uses a natural key, so a replay
// writes the same values (4.6.2).

const log = createAppLogger("meeting-workflow");

/** Wait before the one retry of a failed write (4.6.1). */
const RETRY_WAIT_MS = 200;

function emptySave(): SaveResult {
  return {
    sw1: "none",
    sw2: "none",
    sw3: "none",
    wroteAny: false,
    correctedCount: 0,
    droppedCount: 0,
    suggestionCount: 0,
    failures: [],
    meetingGone: false,
  };
}

function saveFailure(unitKey: string | null, message: string): NodeFailure {
  return {
    node: "save",
    unitKey,
    kind: "save_failed",
    finishReason: null,
    rawFinishReason: null,
    attempt: null,
    llmCallIds: [],
    message,
  };
}

function outcomeOf(r: SaveResult): {
  status: "ok" | "partial" | "failed";
  failure: NodeFailure | null;
} {
  if (r.failures.length === 0) return { status: "ok", failure: null };
  return {
    status: r.wroteAny ? "partial" : "failed",
    failure: r.failures[0] ?? null,
  };
}

/** Worse outcome wins: failed over ok over none. */
function mergeOutcome(cur: WriteOutcome, next: WriteOutcome): WriteOutcome {
  if (cur === "failed" || next === "failed") return "failed";
  if (cur === "ok" || next === "ok") return "ok";
  return "none";
}

export function makeSaveNode(deps: WorkflowDeps) {
  const meetingExists = (id: string): boolean =>
    deps.db.prepare("SELECT 1 FROM meetings WHERE id = ?").get(id) !==
    undefined;

  /**
   * One write in one transaction, retried once after 200 ms. Returns "ok",
   * "failed", or "gone" when the meeting row no longer exists.
   */
  async function attempt(
    meetingId: string,
    write: () => void,
  ): Promise<"ok" | "failed" | "gone"> {
    if (!meetingExists(meetingId)) return "gone";
    for (let i = 0; i < 2; i++) {
      try {
        withTransaction(deps.db, write);
        return "ok";
      } catch (err) {
        // A foreign key error after a delete is expected (3.4.8): test the row.
        if (!meetingExists(meetingId)) return "gone";
        if (i === 0) {
          log.warn(
            `meeting ${meetingId}: save write failed, retrying: ${String(err)}`,
          );
          try {
            await deps.sleep(RETRY_WAIT_MS, new AbortController().signal);
          } catch {
            return "failed";
          }
        }
      }
    }
    return "failed";
  }

  async function doSave(
    state: WorkflowStateType,
    r: SaveResult,
  ): Promise<void> {
    const meetingId = state.meetingId;

    // --- SW1: corrections, one transaction for each ok unit ---
    const units: CorrectUnitResult[] = state.corrections.flatMap(
      (c) => c.units,
    );
    for (const unit of units) {
      if (unit.status !== "ok") continue;
      let applied = 0;
      const outcome = await attempt(meetingId, () => {
        applied = 0;
        const byId = new Map(unit.corrections.map((c) => [c.id, c.text]));
        const update = deps.db.prepare(
          "UPDATE meeting_segments SET enhanced_text = ? WHERE id = ?",
        );
        for (const id of unit.segmentIds) {
          const text = byId.get(id) ?? null;
          update.run(text, id);
          if (text !== null) applied += 1;
        }
        for (const c of unit.corrections) {
          if (c.callId === null) continue;
          deps.recorder.linkCall(c.callId, [
            {
              targetType: "segment",
              targetId: c.id,
              seq: c.seq,
              outcome: "applied",
              reason: null,
              appliedText: c.text,
              verdict: null,
            },
          ]);
        }
        for (const d of unit.dropped) {
          if (d.callId === null) continue;
          deps.recorder.linkCall(d.callId, [
            {
              targetType: "segment",
              targetId: d.id,
              seq: d.seq,
              outcome: "dropped",
              reason: d.reason,
              appliedText: null,
              verdict: null,
            },
          ]);
        }
      });
      if (outcome === "gone") return gone(r);
      if (outcome === "ok") {
        r.sw1 = mergeOutcome(r.sw1, "ok");
        r.wroteAny = true;
        r.correctedCount += applied;
        r.droppedCount += unit.dropped.filter(
          (d) => d.reason !== "unchanged",
        ).length;
      } else {
        r.sw1 = "failed";
        r.failures.push(
          saveFailure(unit.unitKey, `SW1 failed twice (${unit.unitKey})`),
        );
      }
    }

    // --- SW2: speaker suggestions, one transaction for the whole result ---
    const verify = state.verify;
    if (verify && verify.verdicts.length > 0) {
      const now = deps.now();
      const outcome = await attempt(meetingId, () => {
        // Never writes display_name or confirmed_at: a suggestion is evidence,
        // not a user decision (4.6.1).
        const upsert = deps.db.prepare(
          `INSERT INTO meeting_speakers
             (meeting_id, speaker_label, suggested_name, suggested_evidence, suggested_kind, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(meeting_id, speaker_label) DO UPDATE SET
             suggested_name = excluded.suggested_name,
             suggested_evidence = excluded.suggested_evidence,
             suggested_kind = excluded.suggested_kind,
             updated_at = excluded.updated_at`,
        );
        for (const s of verify.suggestions) {
          upsert.run(meetingId, s.label, s.name, s.evidence, s.kind, now);
        }
        for (const v of verify.verdicts) {
          if (v.llmCallId === null) continue;
          const link: NewLink = {
            targetType: "speaker",
            targetId: v.label,
            seq: v.seq,
            outcome: v.status === "kept" ? "applied" : "dropped",
            reason: v.status === "kept" ? null : v.reason,
            appliedText: v.status === "kept" ? v.finalName : null,
            verdict: v,
          };
          deps.recorder.linkCall(v.llmCallId, [link]);
        }
      });
      if (outcome === "gone") return gone(r);
      if (outcome === "ok") {
        r.sw2 = "ok";
        r.wroteAny = true;
        r.suggestionCount = verify.suggestions.length;
      } else {
        r.sw2 = "failed";
        r.failures.push(saveFailure(null, "SW2 failed twice"));
      }
    }

    // --- SW3: the summary, one transaction ---
    const summary = state.summary;
    if (summary && summary.status === "ok" && summary.summary) {
      const createdAt = deps.now();
      const outcome = await attempt(meetingId, () => {
        deps.db
          .prepare(
            `INSERT OR REPLACE INTO meeting_summaries
               (meeting_id, markdown, summary_json, llm_provider, llm_model,
                input_tokens, output_tokens, cost_usd, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            meetingId,
            summary.markdown,
            JSON.stringify(summary.summary),
            summary.llmProvider,
            summary.llmModel,
            summary.inputTokens,
            summary.outputTokens,
            summary.costUsd,
            createdAt,
          );
        deps.db
          .prepare("UPDATE meetings SET status = 'summarized' WHERE id = ?")
          .run(meetingId);
        for (const callId of summary.llmCallIds) {
          if (callId === null) continue;
          deps.recorder.linkCall(callId, [
            {
              targetType: "summary",
              targetId: meetingId,
              seq: 0,
              outcome: "applied",
              reason: null,
              appliedText: String(createdAt),
              verdict: null,
            },
          ]);
        }
      });
      if (outcome === "gone") return gone(r);
      if (outcome === "ok") {
        r.sw3 = "ok";
        r.wroteAny = true;
      } else {
        r.sw3 = "failed";
        r.failures.push(saveFailure(null, "SW3 failed twice"));
      }
    }

    // --- 4.6.5: export files, best effort, never throwing ---
    if (meetingExists(meetingId)) {
      const row = deps.db
        .prepare("SELECT audio_dir FROM meetings WHERE id = ?")
        .get(meetingId) as { audio_dir: string | null } | undefined;
      if (row?.audio_dir)
        writeTranscriptMarkdown(meetingId, row.audio_dir, deps.db);
    } else {
      gone(r);
    }
  }

  function gone(r: SaveResult): void {
    if (!r.meetingGone) {
      log.info("save ended because the meeting was deleted");
    }
    r.meetingGone = true;
  }

  const guarded = guardNode<WorkflowStateType, SaveResult>(
    deps,
    {
      id: "save",
      stepKey: () => "save",
      failed: (_state, f) => ({ ...emptySave(), failures: [f] }),
      outcome: outcomeOf,
    },
    async (state) => {
      const r = emptySave();
      try {
        await doSave(state, r);
      } catch (err) {
        r.failures.push(internalFailure("save", null, err));
      }
      return r;
    },
  );
  return async (state: WorkflowStateType) => ({ saved: await guarded(state) });
}
