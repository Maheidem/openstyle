import fs from "node:fs";
import path from "node:path";
import winston from "winston";

const isDev = process.env.NODE_ENV !== "production";

const LOG_FILE = "openstyle.log";
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB per file
const MAX_FILES = 5; // keep ~10 MB of history (size-rotated, tailable)

// The raw request/response trace lives in its own file so full bodies never
// drown the diagnostics log. Measured against a real oMLX setup: one dictation
// (STT request/response + cleanup request/response) writes ~8.6 KB, and one
// Remix agent turn ~31 KB — the system prompts dominate both. So 5 MB × 3 is
// roughly 1,800 dictations or 500 agent turns of history: days of real use to
// look back over, with a hard ~15 MB ceiling on the directory.
const TRACE_FILE = "openstyle-trace.log";
const TRACE_MAX_SIZE = 5 * 1024 * 1024; // 5 MB per file
const TRACE_MAX_FILES = 3; // keep ~15 MB of history (size-rotated, tailable)

// Every logger we hand out is tracked so file logging can be switched on
// *after* some loggers already exist. The Electron main process only learns
// the log directory once `app` is available, by which point server/main
// modules may have already created their namespaced loggers at import time.
const registry = new Set<winston.Logger>();

// One shared File transport for the whole process. Sharing a single instance
// (rather than one per logger) is important: the per-namespace formatting is
// already applied at the logger level, and a single write stream avoids the
// size-rotation races that independent transports to the same file would hit.
let fileTransport: winston.transport | null = null;

// Initialised from the env var so the standalone server (and tests) can opt in
// without code changes; the Electron app calls `enableFileLogging()` instead.
let logDir: string | undefined = process.env.FREESTYLE_LOG_DIR || undefined;

function getFileTransport(dir: string): winston.transport | null {
  if (fileTransport) return fileTransport;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fileTransport = new winston.transports.File({
      filename: path.join(dir, LOG_FILE),
      maxsize: MAX_SIZE,
      maxFiles: MAX_FILES,
      tailable: true,
    });
    // This single transport is intentionally shared across every namespaced
    // logger in the process, so the default 10-listener cap is exceeded by
    // design. Lift it (0 = unlimited) to avoid spurious MaxListeners warnings.
    fileTransport.setMaxListeners(0);
  } catch {
    // Logging must never crash the app; fall back to console-only.
    fileTransport = null;
  }
  return fileTransport;
}

function attachFileTransport(logger: winston.Logger, dir: string): void {
  const transport = getFileTransport(dir);
  if (!transport) return;
  if (logger.transports.includes(transport)) return;
  logger.add(transport);
}

export function createAppLogger(namespace: string): winston.Logger {
  const logger = winston.createLogger({
    level: isDev ? "debug" : "info",
    format: winston.format.combine(
      winston.format.timestamp({ format: "HH:mm:ss.SSS" }),
      winston.format.printf(({ timestamp, level, message }) => {
        return `${timestamp as string} ${level} [${namespace}] ${message as string}`;
      }),
    ),
    transports: [
      new winston.transports.Console({
        stderrLevels: ["error"],
      }),
    ],
  });

  if (logDir) attachFileTransport(logger, logDir);

  registry.add(logger);
  return logger;
}

/**
 * Persist logs to `<dir>/openstyle.log` (size-rotated, tailable). Attaches the
 * shared file transport to every logger created so far and every one created
 * afterwards, so the call is order-independent — it works whether loggers were
 * built before or after the log directory became known. Idempotent.
 *
 * The trace log shares the directory resolved here but is built lazily on its
 * first write (see {@link traceLog}), so it needs nothing extra from callers.
 */
export function enableFileLogging(dir: string): void {
  if (logDir === dir && fileTransport) return;
  logDir = dir;
  for (const logger of registry) attachFileTransport(logger, dir);
}

// Deliberately outside `registry` and without a Console transport: the trace
// logger must never receive the shared `openstyle.log` transport, and full
// request bodies have no business on stdout.
let traceLogger: winston.Logger | null = null;
let traceUnavailable = false;

function getTraceLogger(): winston.Logger | null {
  if (traceLogger || traceUnavailable) return traceLogger;
  if (!logDir) return null; // Log directory not resolved yet — try again later.
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const transport = new winston.transports.File({
      filename: path.join(logDir, TRACE_FILE),
      maxsize: TRACE_MAX_SIZE,
      maxFiles: TRACE_MAX_FILES,
      tailable: true,
    });
    // A winston logger is a stream: an unhandled `error` event (disk full, a
    // permissions change mid-run) would throw out of an unrelated dictation.
    // Swallow it — the trace log is diagnostics, never a reason to fail.
    transport.on("error", () => {});
    traceLogger = winston.createLogger({
      level: "info",
      format: winston.format.combine(
        winston.format.timestamp({ format: "HH:mm:ss.SSS" }),
        winston.format.printf(
          ({ timestamp, message }) =>
            `${timestamp as string} ${message as string}`,
        ),
      ),
      transports: [transport],
    });
    traceLogger.on("error", () => {});
  } catch {
    // Tracing must never crash the app; give up permanently rather than
    // retrying a failing mkdir on every dictation.
    traceLogger = null;
    traceUnavailable = true;
  }
  return traceLogger;
}

/**
 * Append one entry to `<dir>/openstyle-trace.log` — the raw request/response
 * trace, kept apart from `openstyle.log` so full bodies don't drown it.
 *
 * Always on, and silent when it cannot write: before the log directory is
 * known (standalone server without `FREESTYLE_LOG_DIR`, tests) the entry is
 * simply dropped. Winston's File transport is stream-backed, so the write does
 * not block the caller.
 */
export function traceLog(message: string): void {
  try {
    getTraceLogger()?.info(message);
  } catch {
    // A broken trace write must never surface to the caller.
  }
}
