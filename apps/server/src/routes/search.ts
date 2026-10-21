import { zValidator } from "@hono/zod-validator";
import {
  type SearchHit,
  searchMeetingsRequestSchema,
  searchMeetingsResponseSchema,
  searchStatusSchema,
} from "@openstyle/validations";
import { Hono } from "hono";
import { getDb } from "../lib/db.js";
import { searchIndexStatus } from "../lib/search/indexer.js";
import {
  hitText,
  type RetrievalScope,
  retrieve,
} from "../lib/search/retrieve.js";

// Meeting search (specs/local-semantic-search.md 7.4). Search off answers 200
// with the reason, so the UI shows a state and not an error. No query text
// goes to a log (section 10).

/** Snippet length (7.3). */
const SNIPPET_CHARS = 400;

const search = new Hono()
  .get("/status", (c) => c.json(searchStatusSchema.parse(searchIndexStatus())))
  .post(
    "/meetings",
    zValidator("json", searchMeetingsRequestSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid request", code: "invalid_request" },
          400,
        );
      }
      return undefined;
    }),
    async (c) => {
      const { query, folder_id, tags, k } = c.req.valid("json");
      const scope: RetrievalScope =
        folder_id === undefined
          ? { kind: "all" }
          : folder_id === "none"
            ? { kind: "unfiled" }
            : { kind: "folder", folderId: folder_id };
      const res = await retrieve({
        query: { kind: "text", text: query },
        scope,
        tags,
        k: k ?? 10,
        signal: c.req.raw.signal,
      });
      if (res.status === "off") {
        return c.json(
          searchMeetingsResponseSchema.parse({
            status: "off",
            reason: res.reason,
          }),
        );
      }
      if (res.status === "error") {
        return c.json({ error: "Search failed", code: res.kind }, 503);
      }
      const meeting = getDb().prepare(
        "SELECT title, started_at, folder_id FROM meetings WHERE id = ?",
      );
      const hits: SearchHit[] = res.hits.map((h) => {
        const m = meeting.get(h.meetingId) as
          | {
              title: string | null;
              started_at: number | null;
              folder_id: string | null;
            }
          | undefined;
        return {
          chunk_id: h.chunkId,
          meeting_id: h.meetingId,
          meeting_title: m?.title ?? null,
          started_at: m?.started_at ?? null,
          folder_id: m?.folder_id ?? null,
          score: h.score,
          start_ms: h.startMs,
          end_ms: h.endMs,
          snippet: hitText(h, SNIPPET_CHARS),
        };
      });
      return c.json(searchMeetingsResponseSchema.parse({ status: "ok", hits }));
    },
  );

export default search;
