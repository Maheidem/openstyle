import { createAppLogger } from "@openstyle/utils";
import type { LlmRunKind } from "@openstyle/validations";
import {
  type Attributes,
  type AttributeValue,
  type Context,
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import type { TelemetryOptions } from "ai";

// Opt-in MLflow export of workflow runs (specs/meeting-enhance-agentic.md 9).
// Domain-agnostic (T9): no import of the meetings code. Two environment
// variables are the only gate (T1). With them unset, this module loads no
// export package and opens no socket. A tracing fault never changes a run (T7).

const log = createAppLogger("llm-tracing");

export const ENV_URI = "OPENSTYLE_MLFLOW_TRACKING_URI";
export const ENV_EXPERIMENT = "OPENSTYLE_MLFLOW_EXPERIMENT_ID";
/** `stopTracing` waits this long at most for the last export. */
export const SHUTDOWN_CAP_MS = 2000;
/** The exporter reports a failed send at most once in this time. */
export const EXPORT_WARN_EVERY_MS = 60_000;

export type Attrs = Record<string, AttributeValue | undefined>;

export interface Tracing {
  on: boolean;
  /** Off: a no-op tracer. */
  tracer: Tracer;
  /** Off: undefined. */
  integrations: TelemetryOptions["integrations"];
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * A tracer that does nothing, whatever the global provider is. (A global
 * provider is only registered when the export is on, but a no-op that does not
 * depend on it cannot leak a span.)
 */
const NOOP_TRACER = {
  startSpan: () => trace.wrapSpanContext(INVALID_SPAN_CONTEXT),
  startActiveSpan: (...args: unknown[]) => {
    const fn = args[args.length - 1] as (s: Span) => unknown;
    return fn(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
  },
} as unknown as Tracer;

const OFF: Tracing = {
  on: false,
  tracer: NOOP_TRACER,
  integrations: undefined,
  forceFlush: async () => {},
  shutdown: async () => {},
};

let current: Tracing = OFF;

/** The gateway reads it on each call. */
export const getTracing = (): Tracing => current;

/** The telemetry option of one gateway call (9.5.3, T2). */
export function telemetryFor(t: Tracing, step: string): TelemetryOptions {
  return t.on
    ? { functionId: `openstyle.${step}`, integrations: t.integrations }
    : { isEnabled: false };
}

function offAfterWarning(msg: string): Tracing {
  log.warn(msg);
  return OFF;
}

/**
 * Read the gate, load the export packages and register the provider. Call it
 * once, after `configureNetwork()`. It never throws.
 */
export async function startTracing(env: NodeJS.ProcessEnv): Promise<Tracing> {
  const base = (env[ENV_URI] ?? "").trim();
  const id = (env[ENV_EXPERIMENT] ?? "").trim();
  if (!base && !id) {
    log.info("MLflow tracing: off");
    return (current = OFF);
  }
  if (!base || !id) {
    current = offAfterWarning(
      `MLflow tracing: off. Set both ${ENV_URI} and ${ENV_EXPERIMENT}.`,
    );
    return current;
  }
  if (!/^https?:\/\//i.test(base)) {
    current = offAfterWarning(
      `MLflow tracing: off. ${ENV_URI} must start with http:// or https://.`,
    );
    return current;
  }
  try {
    const [nodeSdk, otlp, mlflow, otel] = await Promise.all([
      import("@opentelemetry/sdk-trace-node"),
      import("@opentelemetry/exporter-trace-otlp-proto"),
      import("@mlflow/vercel"),
      import("@ai-sdk/otel"),
    ]);
    const inner = new otlp.OTLPTraceExporter({
      url: `${base.replace(/\/+$/, "")}/v1/traces`,
      headers: { "x-mlflow-experiment-id": id },
    });
    let lastWarn = 0;
    const exporter = {
      export: (
        spans: Parameters<typeof inner.export>[0],
        done: Parameters<typeof inner.export>[1],
      ) => {
        inner.export(spans, (result) => {
          if (
            result.code !== 0 &&
            Date.now() - lastWarn > EXPORT_WARN_EVERY_MS
          ) {
            lastWarn = Date.now();
            // The error text holds the HTTP status and no span data.
            log.warn(
              `MLflow export failed: ${result.error?.message ?? "unknown error"}`,
            );
          }
          done(result);
        });
      },
      shutdown: () => inner.shutdown(),
      forceFlush: () => inner.forceFlush(),
    };
    const provider = new nodeSdk.NodeTracerProvider({
      spanProcessors: [new mlflow.MLflowSpanProcessor(exporter)],
    });
    provider.register();
    const tracer = provider.getTracer("openstyle");
    const host = new URL(base).host;
    log.info(`MLflow tracing: on host=${host} experiment=${id}`);
    current = {
      on: true,
      tracer,
      integrations: [new otel.LegacyOpenTelemetry({ tracer })],
      forceFlush: () => provider.forceFlush(),
      shutdown: () => provider.shutdown(),
    };
    return current;
  } catch (err) {
    current = offAfterWarning(
      `MLflow tracing: off. Start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return current;
  }
}

/** Flush and stop, with a cap. It never throws. */
export async function stopTracing(): Promise<void> {
  const t = current;
  current = OFF;
  if (!t.on) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      t.shutdown(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_CAP_MS);
      }),
    ]);
  } catch {
    // A tracing fault never changes anything (T7).
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Spans (9.6)
// ---------------------------------------------------------------------------

/** Contexts of the open run spans. State of the graph holds only the run id. */
const runContexts = new Map<string, Context>();

function prefixed(attrs: Attrs): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) out[`openstyle.${k}`] = v;
  }
  return out;
}

/** Set `openstyle.*` attributes on a span. */
export function setAttrs(s: Span, attrs: Attrs): void {
  try {
    s.setAttributes(prefixed(attrs));
  } catch {
    // T7
  }
}

/**
 * The error code of a failure: a typed `kind` or `code`, else "unknown".
 */
function codeOf(err: unknown): string {
  const e = err as { kind?: unknown; code?: unknown } | null;
  if (typeof e?.kind === "string") return e.kind;
  if (typeof e?.code === "string") return e.code;
  return "unknown";
}

/** ERROR with the code as message. No transcript text. */
export function markError(s: Span, err: unknown): void {
  try {
    const code = codeOf(err);
    s.setAttribute("openstyle.error_kind", code);
    if (err instanceof Error)
      s.recordException({ name: err.name, message: code });
    s.setStatus({ code: SpanStatusCode.ERROR, message: code });
  } catch {
    // T7
  }
}

/**
 * Open the root span of a run: `<scope>.<kind>`, WORKFLOW, in `ROOT_CONTEXT`.
 * It stores the context for `inNode`. Differs from `startRun` of the recorder.
 */
export function startRunSpan(
  t: Tracing,
  runId: string,
  attrs: Attrs & { scope: string; scopeId: string; kind: LlmRunKind },
): Span {
  const { scope, scopeId, kind, ...rest } = attrs;
  const span = t.tracer.startSpan(
    `${scope}.${kind}`,
    {
      attributes: {
        "mlflow.spanType": "WORKFLOW",
        ...prefixed({
          run_id: runId,
          scope,
          scope_id: scopeId,
          kind,
          ...rest,
        }),
      },
    },
    ROOT_CONTEXT,
  );
  runContexts.set(runId, trace.setSpan(ROOT_CONTEXT, span));
  return span;
}

/**
 * Run a node body inside a CHAIN span, a child of the run span. A throw ends
 * the span with ERROR and is rethrown.
 */
export function inNode<T>(
  t: Tracing,
  runId: string,
  node: string,
  attrs: Attrs,
  fn: (s: Span) => Promise<T>,
): Promise<T> {
  return t.tracer.startActiveSpan(
    `node.${node}`,
    {
      attributes: {
        "mlflow.spanType": "CHAIN",
        ...prefixed({ run_id: runId, node, ...attrs }),
      },
    },
    runContexts.get(runId) ?? ROOT_CONTEXT,
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        markError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * End the run span and forget its context. ERROR only for `partial` and
 * `failed`. At the end it starts a flush that nothing awaits (9.7).
 */
export function endRunSpan(
  s: Span,
  runId: string,
  outcome: "succeeded" | "partial" | "failed" | "cancelled",
  errorKind?: string | null,
): void {
  try {
    s.setAttribute("openstyle.outcome", outcome);
    if (outcome === "partial" || outcome === "failed") {
      s.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorKind ?? outcome,
      });
      if (errorKind) s.setAttribute("openstyle.error_kind", errorKind);
    }
    s.end();
  } catch {
    // T7
  } finally {
    runContexts.delete(runId);
  }
  void current.forceFlush().catch(() => {});
}

/** Forget a run context without ending its span (an interrupted run). */
export function dropRunSpan(runId: string): void {
  runContexts.delete(runId);
}

/** Test seam: install a tracing object, or `null` for off. */
export function __setTracingForTests(t: Tracing | null): void {
  current = t ?? OFF;
}
