import { Hono } from "hono";
import agentRoute from "./agent.js";
import runsRoute from "./runs.js";
import threadRoute from "./thread.js";
import transformRoute from "./transform.js";

/**
 * Remix, mounted at /api/remix. Two lanes plus their local state:
 *   /transform: one-shot edit over a selection (preset or spoken)
 *   /agent: the chat agent loop (on the model of the user)
 *   /thread: the chat thread of the pill (local SQLite)
 *   /runs: one row for each write into the document of the user (for Revert)
 */
const remixRouter = new Hono()
  .route("/transform", transformRoute)
  .route("/agent", agentRoute)
  .route("/thread", threadRoute)
  .route("/runs", runsRoute);

export default remixRouter;
