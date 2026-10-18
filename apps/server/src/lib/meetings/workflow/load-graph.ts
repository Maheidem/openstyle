import { stripTracingEnv } from "../../llm/workflow/env-guard.js";
import type { WorkflowDeps } from "./context.js";
import type { CompiledWorkflow } from "./graph.js";

// Load the graph (specs/meeting-enhance-agentic.md 3.1 rule 2). It removes the
// four LangChain tracing variables first, then loads `graph.ts` with a dynamic
// `import()` on the first run. No static import path from `S/index.ts` reaches
// `@langchain/*`, so a bundling fault breaks Enhance only.
export async function loadGraph(deps: WorkflowDeps): Promise<CompiledWorkflow> {
  stripTracingEnv();
  const { buildGraph } = await import("./graph.js");
  return buildGraph(deps);
}
