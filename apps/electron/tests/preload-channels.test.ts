import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Preload channel-drift guard (C3′, specs/lean-audit-2026-09.md §3 T1-6).
//
// `src/preload/index.ts` (the runtime bridge) and `src/preload/index.d.ts`
// (the hand-written renderer-facing declaration) must be kept in sync by
// hand — a manual sync that has already drifted once (the removed mic
// listener's channel lived on in both long past its last consumer, and a
// stale main/index.ts comment referenced the deleted `beforeOutput` hook).
//
// This test parses both files with the TypeScript compiler API and asserts:
//
//   1. every `api` property in index.ts that subscribes via
//      `ipcRenderer.on("<channel>")` is declared in index.d.ts;
//   2. every `on*` member declared in index.d.ts's `api` has a matching
//      subscription in index.ts (no declarations for dead channels);
//   3. every `webContents.send("<channel>")` (or WebContents-shaped
//      `.send(...)`) anywhere in src/main has a preload subscription
//      forwarding it — the exact class of drift the mic-listener removal
//      exercised.
//
// This is a vitest file that lives beside the Playwright e2e suites but must
// not run under Playwright (no Electron launch); playwright.config.ts ignores
// it by name and vitest.config.ts includes it explicitly.
// ---------------------------------------------------------------------------

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const PRELOAD_TS = join(TESTS_DIR, "../src/preload/index.ts");
const PRELOAD_DTS = join(TESTS_DIR, "../src/preload/index.d.ts");
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

/** All `ipcRenderer.on("<channel>")` string literals under a node. */
function ipcOnChannels(source: ts.SourceFile, root: ts.Node): string[] {
  const channels: string[] = [];
  (function walk(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "on" &&
      node.expression.expression.getText(source) === "ipcRenderer" &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      channels.push(node.arguments[0].text);
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

/** The `api: { ... }` member's type literal from the Window interface. */
function declaredApiMembers(source: ts.SourceFile): string[] {
  const members: string[] = [];
  (function walk(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "Window") {
      for (const member of node.members) {
        if (
          ts.isPropertySignature(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === "api" &&
          member.type &&
          ts.isTypeLiteralNode(member.type)
        ) {
          for (const m of member.type.members) {
            if (
              (ts.isPropertySignature(m) || ts.isMethodSignature(m)) &&
              ts.isIdentifier(m.name)
            ) {
              members.push(m.name.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  })(source);
  if (members.length === 0) {
    throw new Error(
      "Window.api member not found in src/preload/index.d.ts — did the declaration shape change?",
    );
  }
  return members;
}

/**
 * Every `.send("<channel>", ...)` call site in src/main, keyed by channel
 * with file provenance. Receivers are WebContents-shaped
 * (`win.webContents.send`, `event.sender.send`, a stored `target.send`) —
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
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "send" &&
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
  const subscribedNames = new Set(subscriptions.map((s) => s.apiName));
  const subscribedChannels = new Set(subscriptions.flatMap((s) => s.channels));
  const declared = declaredApiMembers(parse(PRELOAD_DTS));
  const declaredOnNames = new Set(declared.filter((n) => n.startsWith("on")));

  it("every preload subscription is declared in index.d.ts", () => {
    const undeclared = subscriptions
      .map((s) => s.apiName)
      .filter((name) => !declared.includes(name));
    expect(
      undeclared,
      "api members in preload/index.ts that subscribe but have no declaration in preload/index.d.ts",
    ).toEqual([]);
  });

  it("every declared on* member has a live subscription in index.ts", () => {
    const dead = [...declaredOnNames].filter(
      (name) => !subscribedNames.has(name),
    );
    expect(
      dead,
      "on* members declared in preload/index.d.ts with no ipcRenderer.on subscription in preload/index.ts",
    ).toEqual([]);
  });

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
