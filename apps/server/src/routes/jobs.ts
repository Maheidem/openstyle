import { Hono } from "hono";
import { readJobs } from "../lib/jobs.js";

// GET /api/jobs (issue #317): the meeting jobs that run or wait, and the
// state of the built-in MLX models. Read only. The tray popover polls it
// while it shows.
const jobs = new Hono().get("/", (c) => c.json(readJobs()));

export default jobs;
