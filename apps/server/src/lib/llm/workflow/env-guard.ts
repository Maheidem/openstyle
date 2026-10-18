// LangChain turns tracing on when one of these variables equals "true", and
// LangGraph can then send run data to LangSmith. The app promises no telemetry
// (specs/meeting-enhance-agentic.md 3.1, "Privacy guard"). The names come from
// `@langchain/core` `utils/callbacks`; the WP5a acceptance step checks them
// against the installed version (U6, GR3).
const TRACING_VARIABLES = [
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING_V2",
  "LANGSMITH_TRACING",
  "LANGCHAIN_TRACING",
] as const;

/** Delete the four tracing variables. Call it before LangGraph loads. */
export function stripTracingEnv(): void {
  for (const name of TRACING_VARIABLES) delete process.env[name];
}
