import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Preload channel-drift guard (C3′, specs/lean-audit-2026-09.md §3 T1-6).
//
// The renderer type `Window.api` comes from the `api` object in
// `src/preload/index.ts` (see `OpenstyleApi`). The type checker keeps the two
// in sync. This guard covers the part that types cannot see: the IPC channel
// names. A removed mic listener once stayed in the preload long after its
// last consumer, and a stale comment in main/index.ts named a deleted hook.
//
// This test parses the source files with the TypeScript compiler API and
// asserts:
//
//   1. every `api` member that subscribes forwards exactly one channel;
//   2. every `webContents.send("<channel>")` (or WebContents-shaped
//      `.send(...)`) anywhere in src/main has a preload subscription
//      forwarding it. This is the class of drift the mic-listener removal
//      exercised.
//
// This is a vitest file that lives beside the Playwright e2e suites but must
// not run under Playwright (no Electron launch); playwright.config.ts ignores
// it by name and vitest.config.ts includes it explicitly.
// ---------------------------------------------------------------------------

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const PRELOAD_TS = join(TESTS_DIR, "../src/preload/index.ts");
const MAIN_DIR = join(TESTS_DIR, "../src/main");

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/**
 * All channel string literals under a node. A channel comes from either
 * `ipcRenderer.on("<channel>")` or `listen("<channel>")` (the helper in
 * preload/index.ts, with or without type arguments).
 */
function ipcOnChannels(source: ts.SourceFile, root: ts.Node): string[] {
  const channels: string[] = [];
  (function walk(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const callee = node.expression;
      const isOn =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "on" &&
        callee.expression.getText(source) === "ipcRenderer";
      const isListen = ts.isIdentifier(callee) && callee.text === "listen";
      if (isOn || isListen) channels.push(node.arguments[0].text);
    }
    ts.forEachChild(node, walk);
  })(root);
  return channels;
}

interface Subscription {
  /** The `api` property name (e.g. `onPillCancel`). */
  apiName: string;
  /** The channels it forwards (a well-formed member has exactly one). */
  channels: string[];
}

/** The `const api = { ... }` object literal from preload/index.ts. */
function preloadApiObject(source: ts.SourceFile): ts.ObjectLiteralExpression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === "api" &&
        decl.initializer &&
        ts.isObjectLiteralExpression(decl.initializer)
      ) {
        return decl.initializer;
      }
    }
  }
  throw new Error("const api = { ... } not found in src/preload/index.ts");
}

function preloadSubscriptions(): Subscription[] {
  const source = parse(PRELOAD_TS);
  const apiObject = preloadApiObject(source);
  const subs: Subscription[] = [];
  for (const prop of apiObject.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const channels = ipcOnChannels(source, prop.initializer);
    if (channels.length > 0) {
      subs.push({ apiName: prop.name.text, channels });
    }
  }
  return subs;
}

/**
 * Every `.send("<channel>", ...)` and `broadcastToWindows("<channel>", ...)`
 * call site in src/main, keyed by channel with file provenance. Receivers
 * are WebContents-shaped (`win.webContents.send`, `event.sender.send`, a
 * stored `target.send`) —
 * if a future non-IPC `.send` with a string first argument appears here as
 * a false positive, add it to IGNORED_MAIN_SENDS with a justification.
 */
function mainSendChannels(): Map<string, string[]> {
  const IGNORED_MAIN_SENDS: ReadonlySet<string> = new Set([]);
  const sends = new Map<string, string[]>();
  for (const file of readdirSync(MAIN_DIR).filter((f) => f.endsWith(".ts"))) {
    const source = parse(join(MAIN_DIR, file));
    (function walk(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ((ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "send") ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "broadcastToWindows")) &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const channel = node.arguments[0].text;
        if (!IGNORED_MAIN_SENDS.has(channel)) {
          const files = sends.get(channel) ?? [];
          files.push(file);
          sends.set(channel, files);
        }
      }
      ts.forEachChild(node, walk);
    })(source);
  }
  return sends;
}

describe("preload channel drift guard", () => {
  const subscriptions = preloadSubscriptions();
  const subscribedChannels = new Set(subscriptions.flatMap((s) => s.channels));

  it("every subscription forwards exactly one channel", () => {
    const multi = subscriptions.filter((s) => s.channels.length !== 1);
    expect(
      multi.map((s) => s.apiName),
      "api members whose ipcRenderer.on count is not exactly one",
    ).toEqual([]);
  });

  it("every main-process webContents.send channel has a preload subscription", () => {
    const orphaned = [...mainSendChannels().entries()]
      .filter(([channel]) => !subscribedChannels.has(channel))
      .map(([channel, files]) => `${channel} (sent from ${files.join(", ")})`);
    expect(
      orphaned,
      "channels sent from src/main that no preload api member forwards to the renderer",
    ).toEqual([]);
  });
});
