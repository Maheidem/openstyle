// Tells the Electron main process that an agent changed data through MCP.
// The server runs as an Electron utility process (apps/electron/src/main/
// server-host.ts), so `process.parentPort` exists there. A standalone server
// has no parent: the call then does nothing.

/** One change that an MCP write tool made. */
export interface AgentChange {
  /** The kind of item, for example "meeting", "folder" or "setting". */
  kind: string;
  /** The ids of the changed items. Empty when the kind has no ids. */
  ids?: string[];
  /** The changed settings keys (kind "setting" only). */
  keys?: string[];
}

interface ParentPort {
  postMessage(message: unknown): void;
}

export function emitAgentChange(change: AgentChange): void {
  const port = (process as NodeJS.Process & { parentPort?: ParentPort })
    .parentPort;
  if (!port) return;
  try {
    port.postMessage({
      type: "agent-change",
      kind: change.kind,
      ids: change.ids ?? [],
      keys: change.keys ?? [],
    });
  } catch {
    // The parent is gone. Nothing to tell.
  }
}
