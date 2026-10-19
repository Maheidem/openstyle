import type { LlmCallFull, LlmLinkInfo } from "@openstyle/validations";
import { InlineNotice } from "@renderer/components/inline-notice";
import { Button } from "@renderer/components/ui/button";
import { llmCallsQueryOptions, llmRunsQueryOptions } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  errorTextKey,
  finishText,
  groupLedger,
  isModelMismatch,
  missingCalls,
  verdictTextKey,
} from "./llm-inspector-model";
import { CopyButton } from "./shared";

// The Call view of the LLM inspector (specs/meeting-enhance-agentic.md 8.7):
// one full call, the message sent and the answer received.

/** The segment whose edit opened the panel: the "Before" text of the Change block. */
export interface InspectedSegment {
  id: string;
  /** The raw text of the segment, before any correction. */
  text: string;
}

/** Shown while a query loads and when it fails: a neutral line, or the retry (8.7). */
export function QueryState({
  loading,
  failed,
  onRetry,
}: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (failed) {
    return (
      <div className="flex items-center gap-3 text-[12px]">
        <span className="text-destructive">
          {t("meetings.inspector.loadFailed")}
        </span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("meetings.inspector.retry")}
        </Button>
      </div>
    );
  }
  if (loading) {
    return (
      <p className="text-muted-foreground m-0 text-[12px]">
        {t("meetings.inspector.loading")}
      </p>
    );
  }
  return null;
}

/** A mono block: prompts, responses, JSON, ids. It scrolls in both directions. */
function MonoBlock({ children }: { children: string }): React.JSX.Element {
  return (
    <pre className="mono bg-muted/40 border-border m-0 max-h-56 overflow-auto rounded-md border p-2 text-[11px] leading-[1.5] whitespace-pre-wrap break-words">
      {children}
    </pre>
  );
}

function Section({
  title,
  open = true,
  children,
  testId,
}: {
  title: string;
  open?: boolean;
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <details open={open} className="group mb-3" data-testid={testId}>
      <summary className="text-muted-foreground mb-1.5 flex cursor-pointer items-center gap-2 text-[11px] font-medium">
        {title}
      </summary>
      {children}
    </details>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mono m-0 min-w-0 break-words tabular-nums">{children}</dd>
    </>
  );
}

function numberText(n: number | null): string {
  return n === null ? "-" : String(n);
}

function msText(n: number | null): string {
  return n === null ? "-" : `${n} ms`;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

/** Applied segment links of a call: the segments that this call changed. */
function appliedSegmentLinks(links: readonly LlmLinkInfo[]): LlmLinkInfo[] {
  return links.filter(
    (l) => l.targetType === "segment" && l.outcome === "applied",
  );
}

export function LlmCallView({
  meetingId,
  callId,
  segment,
  polling,
  onSelectCall,
}: {
  meetingId: string;
  callId: number;
  /** Set when the edit of a segment opened the panel (Change block). */
  segment?: InspectedSegment;
  polling: boolean;
  /** Attempts block: show another call of the same step. */
  onSelectCall: (callId: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const callQuery = useQuery(
    llmCallsQueryOptions(
      meetingId,
      { call_id: String(callId), detail: "full" },
      polling,
    ),
  );
  const call: LlmCallFull | undefined =
    callQuery.data?.detail === "full" ? callQuery.data.calls[0] : undefined;
  // The run row holds the step counts: the total of attempts and the gap.
  const runQuery = useQuery({
    ...llmRunsQueryOptions(meetingId, call?.runId, polling),
    enabled: call !== undefined,
  });

  if (!call) {
    if (callQuery.isSuccess) {
      return (
        <p className="text-muted-foreground m-0 text-[12px]">
          {t("meetings.inspector.noRecord")}
        </p>
      );
    }
    return (
      <QueryState
        loading={callQuery.isPending}
        failed={callQuery.isError}
        onRetry={() => void callQuery.refetch()}
      />
    );
  }

  const run = runQuery.data?.runs[0];
  const stepKey = call.stepKey.split("/")[0];
  const step = run?.steps.find((s) => s.key === stepKey);
  const missing = step ? missingCalls(step) : 0;
  const total = step?.attempts ?? call.attempts.length;
  const ledger = groupLedger(call.params);
  const finish = finishText(call);
  const segmentLink = segment
    ? call.links.find(
        (l) =>
          l.targetType === "segment" &&
          l.targetId === segment.id &&
          l.outcome === "applied",
      )
    : undefined;
  const dropped = call.links.filter(
    (l) => l.targetType === "segment" && l.outcome === "dropped",
  );
  const messagesText = call.messages
    .map((m) => `${m.role}:\n${m.content}`)
    .join("\n\n");

  return (
    <div data-testid="meetings-inspector-call" data-call-id={call.id}>
      <p className="mono text-muted-foreground m-0 mb-3 text-[11px]">
        {call.stepKey} · {call.node}
      </p>

      <Section title={t("meetings.inspector.block.attempts")}>
        {missing > 0 && (
          <p className="text-muted-foreground m-0 mb-1.5 text-[12px]">
            {t("meetings.inspector.recordedGap", { missing })}
          </p>
        )}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {call.attempts.map((a, i) => (
            <li key={a.callId}>
              <button
                type="button"
                data-testid="meetings-inspector-attempt"
                aria-current={a.callId === call.id ? "true" : undefined}
                onClick={() => onSelectCall(a.callId)}
                className={cn(
                  "border-border hover:bg-muted flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md border px-2 py-1 text-left text-[12px]",
                  a.callId === call.id && "bg-accent",
                )}
              >
                <span className="tabular-nums">
                  {t("meetings.inspector.attempt", {
                    n: a.attempt,
                    total: Math.max(total, i + 1),
                  })}
                </span>
                <span className="mono text-muted-foreground">
                  {a.finishUnified ?? "-"}
                </span>
                {a.errorKind && (
                  <span className="text-destructive">
                    {t(errorTextKey(a.errorKind))}
                  </span>
                )}
                <span className="mono text-muted-foreground ml-auto tabular-nums">
                  {msText(a.latencyMs)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t("meetings.inspector.block.overview")}>
        <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-[12px]">
          <Field label={t("meetings.inspector.field.provider")}>
            {call.provider ?? "-"}
          </Field>
          <Field label={t("meetings.inspector.field.requestedModel")}>
            {call.requestedModel ?? "-"}
          </Field>
          <Field label={t("meetings.inspector.field.servedModel")}>
            {call.servedModel ?? "-"}
          </Field>
          <Field label={t("meetings.inspector.field.finish")}>
            {finish ?? "-"}
          </Field>
          <Field label={t("meetings.inspector.field.inputTokens")}>
            {numberText(call.inputTokens)}
          </Field>
          <Field label={t("meetings.inspector.field.outputTokens")}>
            {numberText(call.outputTokens)}
          </Field>
          <Field label={t("meetings.inspector.field.reasoningTokens")}>
            {numberText(call.reasoningTokens)}
          </Field>
          <Field label={t("meetings.inspector.field.cachedTokens")}>
            {numberText(call.cachedTokens)}
          </Field>
          <Field label={t("meetings.inspector.field.queued")}>
            {msText(call.queuedMs)}
          </Field>
          <Field label={t("meetings.inspector.field.latency")}>
            {msText(call.latencyMs)}
          </Field>
        </dl>
        {isModelMismatch(call) && (
          <p className="text-destructive m-0 mt-1.5 text-[12px]">
            {t("meetings.inspector.modelMismatch")}
          </p>
        )}
      </Section>

      {call.errorKind && (
        <InlineNotice tone="destructive" icon={AlertTriangle} className="mb-3">
          <span
            className="flex min-w-0 flex-col gap-1"
            data-testid="meetings-inspector-error"
          >
            <span>{t(errorTextKey(call.errorKind))}</span>
            {call.errorDetail && (
              <span className="mono break-words text-[11px]">
                {call.errorDetail}
              </span>
            )}
          </span>
        </InlineNotice>
      )}

      {segment && segmentLink && (
        <Section title={t("meetings.inspector.block.change")}>
          <div className="grid gap-1.5 text-[12px]">
            <div>
              <span className="text-muted-foreground">
                {t("meetings.inspector.before")}
              </span>
              <MonoBlock>{segment.text}</MonoBlock>
            </div>
            <div>
              <span className="text-muted-foreground">
                {t("meetings.inspector.after")}
              </span>
              <MonoBlock>{segmentLink.appliedText ?? ""}</MonoBlock>
            </div>
            <p className="text-muted-foreground m-0">
              {t("meetings.inspector.changedCount", {
                n: appliedSegmentLinks(call.links).length,
              })}
            </p>
          </div>
        </Section>
      )}

      {dropped.length > 0 && (
        <Section title={t("meetings.inspector.block.dropped")}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px]">
            {dropped.map((l) => (
              <li key={l.id} className="flex flex-wrap gap-x-2">
                <span className="mono text-muted-foreground">{l.targetId}</span>
                <span>
                  {l.reason
                    ? t(verdictTextKey(l.reason), { defaultValue: l.reason })
                    : t("meetings.inspector.stepStatus.unknown")}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title={t("meetings.inspector.block.messages")}
        testId="meetings-inspector-messages"
      >
        <div className="grid gap-2">
          {call.messages.map((m, i) => (
            <div key={i}>
              <span className="text-muted-foreground text-[11px]">
                {t(`meetings.inspector.role.${m.role}`, {
                  defaultValue: m.role,
                })}
              </span>
              <MonoBlock>{m.content}</MonoBlock>
            </div>
          ))}
          <div>
            <CopyButton
              text={messagesText}
              label={t("meetings.inspector.copyMessages")}
            />
          </div>
        </div>
      </Section>

      <Section title={t("meetings.inspector.block.schema")} open={false}>
        <p className="mono text-muted-foreground m-0 mb-1 text-[11px]">
          {call.schema.name} v{call.schema.version}
        </p>
        <MonoBlock>{prettyJson(call.schema.json)}</MonoBlock>
      </Section>

      <Section
        title={t("meetings.inspector.block.parameters")}
        testId="meetings-inspector-params"
      >
        {ledger ? (
          <div className="grid gap-2 text-[12px]">
            <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5">
              {ledger.topLevel.map((r) => (
                <Field key={`top:${r.name}`} label={r.name}>
                  {r.value}
                </Field>
              ))}
            </dl>
            {ledger.extraBody.length > 0 && (
              <div>
                <span className="text-muted-foreground">
                  {t("meetings.inspector.extraBody")}
                </span>
                <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5">
                  {ledger.extraBody.map((r) => (
                    <Field key={`extra:${r.name}`} label={r.name}>
                      {r.value}
                    </Field>
                  ))}
                </dl>
              </div>
            )}
            {ledger.dropped.length > 0 && (
              <div>
                <span className="text-muted-foreground">
                  {t("meetings.inspector.paramsDropped")}
                </span>
                <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5">
                  {ledger.dropped.map((r) => (
                    <Field key={`drop:${r.name}`} label={r.name}>
                      {r.value ? `${r.value} · ${r.reason}` : r.reason}
                    </Field>
                  ))}
                </dl>
              </div>
            )}
            <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5">
              <Field label={t("meetings.inspector.source")}>
                {ledger.source.presetId
                  ? `${ledger.source.mode} · ${ledger.source.presetId}`
                  : ledger.source.mode}
              </Field>
              <Field label={t("meetings.inspector.structuredMode")}>
                {ledger.structuredMode}
              </Field>
            </dl>
            {ledger.warnings.map((w) => (
              <p key={w} className="mono text-muted-foreground m-0 text-[11px]">
                {w}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground m-0 text-[12px]">
            {t("meetings.inspector.noRecord")}
          </p>
        )}
      </Section>

      <Section
        title={t("meetings.inspector.block.raw")}
        testId="meetings-inspector-raw"
      >
        {call.rawText !== null ? (
          <div className="grid gap-2">
            <MonoBlock>{call.rawText}</MonoBlock>
            <div>
              <CopyButton
                text={call.rawText}
                label={t("meetings.inspector.copyRaw")}
              />
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground m-0 text-[12px]">
            {t("meetings.inspector.noResponse")}
          </p>
        )}
      </Section>

      <Section
        title={t("meetings.inspector.block.parsed")}
        testId="meetings-inspector-parsed"
      >
        {call.parsed !== null ? (
          <div className="grid gap-2">
            <MonoBlock>{prettyJson(call.parsed)}</MonoBlock>
            <div>
              <CopyButton
                text={prettyJson(call.parsed)}
                label={t("meetings.inspector.copyParsed")}
              />
            </div>
          </div>
        ) : (
          <MonoBlock>{call.errorDetail ?? ""}</MonoBlock>
        )}
      </Section>
    </div>
  );
}
