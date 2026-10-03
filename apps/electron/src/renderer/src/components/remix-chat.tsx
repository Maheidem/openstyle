import { useChat } from "@ai-sdk/react";
import { REMIX_PRESETS, type RemixPreset } from "@openstyle/validations";
import { AgentActivity } from "@renderer/components/agents/agent-activity";
import type { AgentActivityStep } from "@renderer/components/agents/agent-activity/types";
import { AgentDisclosure } from "@renderer/components/agents/agent-disclosure";
import { ThinkingShimmer } from "@renderer/components/agents/loading-states/thinking-shimmer";
import { MessageScroller } from "@renderer/components/agents/message-scroller";
import { apiFetch } from "@renderer/lib/api";
import {
  DefaultChatTransport,
  type DynamicToolUIPart,
  getToolOrDynamicToolName,
  isTextUIPart,
  isToolOrDynamicToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { domMax, LazyMotion } from "motion/react";
import type React from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { RemixSelectionPayload } from "../../../shared/remix";
import { OpenstyleMark } from "./openstyle-mark";
import {
  INK_DIM,
  INK_FAINT,
  MINI_STRIP_MAX,
  MINI_STRIP_PAD,
  REMIX_CHAT_CSS,
} from "./remix-chat-styles";
import {
  REMIX_CHAT_STRIP,
  REMIX_CHAT_SURFACE,
  type RemixChatAnchor,
} from "./remix-chat-surface";

function anchoredLayerStyle(
  anchor: RemixChatAnchor,
  size: { width: number; height: number },
): React.CSSProperties {
  return {
    position: "absolute",
    width: size.width,
    height: size.height,
    ...(anchor.v === "top" ? { top: 0 } : { bottom: 0 }),
    ...(anchor.h === "right"
      ? { right: 0 }
      : { left: "50%", transform: "translateX(-50%)" }),
  };
}

interface ThreadState {
  threadId: number;
  resumed: boolean;
  messages: UIMessage[];
}

export interface RemixChatProps {
  context: RemixSelectionPayload;
  initialInstruction: string | null;
  minimized: boolean;
  onMiniHeightChange?: (height: number) => void;
  anchor: RemixChatAnchor;
  onExpand: () => void;
  onMinimize: () => void;
  onClose: () => void;
}

export function RemixChat(props: RemixChatProps): React.JSX.Element {
  const [thread, setThread] = useState<ThreadState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // State (not props) so "New" can clear it without a remount re-sending.
  const [initialInstruction, setInitialInstruction] = useState(
    props.initialInstruction,
  );

  // Pill is focusable:false; follow the card so the composer can take keyboard.
  useEffect(() => {
    window.api?.setRemixChatFocus(!props.minimized);
    return () => window.api?.setRemixChatFocus(false);
  }, [props.minimized]);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/remix/thread")
      .then(async (res) => {
        if (!res.ok) throw new Error(`thread fetch ${res.status}`);
        const data = (await res.json()) as ThreadState & {
          threadId: number | null;
        };
        if (data.threadId !== null) {
          if (!cancelled) setThread(data as ThreadState);
          return;
        }
        const fresh = await createThread();
        if (!cancelled) setThread(fresh);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loadFailed || !props.minimized) return;
    const timer = setTimeout(props.onClose, MINI_IDLE_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [loadFailed, props.minimized, props.onClose]);

  useEffect(() => {
    if (props.initialInstruction) {
      setInitialInstruction(props.initialInstruction);
    }
  }, [props.initialInstruction]);

  const startNewThread = useCallback(() => {
    setInitialInstruction(null);
    setThread(null);
    setLoadFailed(false);
    createThread()
      .then(setThread)
      .catch(() => setLoadFailed(true));
  }, []);

  if (loadFailed) {
    if (props.minimized) {
      return <MiniStrip text="Remix couldn't open" onEnter={props.onExpand} />;
    }
    return (
      <div style={{ padding: 14, fontSize: 12.5, color: INK_DIM }}>
        <style>{REMIX_CHAT_CSS}</style>
        Couldn't open Remix. Is the Openstyle server running?
      </div>
    );
  }
  if (!thread) {
    if (props.minimized) {
      return <MiniStrip text="Opening Remix…" busy onEnter={props.onExpand} />;
    }
    return (
      <div style={{ padding: 14, fontSize: 12.5, color: INK_FAINT }}>
        <style>{REMIX_CHAT_CSS}</style>
        Opening Remix…
      </div>
    );
  }
  return (
    <RemixThread
      key={thread.threadId}
      thread={thread}
      context={props.context}
      initialInstruction={initialInstruction}
      minimized={props.minimized}
      anchor={props.anchor}
      onExpand={props.onExpand}
      onMinimize={props.onMinimize}
      onClose={props.onClose}
      onNewThread={startNewThread}
      onMiniHeightChange={props.onMiniHeightChange}
    />
  );
}

function MiniStrip(props: {
  text: string;
  busy?: boolean;
  failed?: boolean;
  onEnter?: () => void;
}): React.JSX.Element {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: expand also via hotkey/bar
    <div
      className="remix-chat dark"
      data-testid="remix-chat-mini"
      onMouseEnter={props.onEnter}
    >
      <style>{REMIX_CHAT_CSS}</style>
      <div className="remix-mini" role="status" aria-live="polite">
        <span
          className="remix-mini-dot"
          data-busy={props.busy === true}
          data-failed={props.failed === true}
        />
        <span className="remix-mini-text">{props.text}</span>
      </div>
    </div>
  );
}

interface RemixThreadProps {
  thread: ThreadState;
  context: RemixSelectionPayload;
  initialInstruction: string | null;
  minimized: boolean;
  anchor: RemixChatAnchor;
  onExpand: () => void;
  onMinimize: () => void;
  onClose: () => void;
  onNewThread: () => void;
  onMiniHeightChange?: (height: number) => void;
}

interface ActionRow {
  id: number;
  label: string;
  status: "running" | "done" | "failed";
  detail?: string;
}

const MINIMIZE_GRACE_MS = 380;
const MINI_IDLE_DISMISS_MS = 7000;
const MINI_SETTLED_DISMISS_MS = 3000;

function RemixThread(props: RemixThreadProps): React.JSX.Element {
  const { thread, minimized, anchor, onExpand, onMinimize, onClose } = props;
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const actionSeqRef = useRef(0);

  const contextRef = useRef<RemixSelectionPayload>(props.context);
  const [liveContext, setLiveContext] = useState<RemixSelectionPayload>(
    props.context,
  );
  useEffect(() => {
    contextRef.current = props.context;
    setLiveContext(props.context);
  }, [props.context]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/remix/agent",

        fetch: (async (_input: unknown, init?: RequestInit) => {
          const res = await apiFetch("/api/remix/agent", init ?? {});
          if (!res.ok) {
            throw await errorFromResponse(res);
          }
          return res;
        }) as typeof fetch,
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            messages,
            context: {
              selection: contextRef.current.text,
              appName: contextRef.current.appName,
              windowTitle: contextRef.current.windowTitle,
              clipboard: contextRef.current.clipboard ?? null,
              clipboardLength: contextRef.current.clipboardLength ?? 0,
              capturedAt: contextRef.current.capturedAt,
            },
          },
        }),
      }),
    [],
  );

  const executeTool = useCallback(
    async (toolCall: {
      toolName: string;
      toolCallId: string;
      input: unknown;
    }): Promise<Record<string, unknown>> => {
      const name = toolCall.toolName;
      const input = (toolCall.input ?? {}) as Record<string, unknown>;
      const str = (key: string): string =>
        typeof input[key] === "string" ? (input[key] as string) : "";
      const num = (key: string): number | undefined =>
        typeof input[key] === "number" ? (input[key] as number) : undefined;
      const badArgs = (expected: string): Record<string, unknown> => ({
        ok: false,
        reason: "bad-args",
        expected,
        received: JSON.stringify(toolCall.input)?.slice(0, 300) ?? "undefined",
      });

      const result = await runTool();
      if (import.meta.env.DEV) {
        console.log(
          `[remix] ${name}(${JSON.stringify(toolCall.input)?.slice(0, 400) ?? ""}) →`,
          JSON.stringify(result).slice(0, 400),
        );
      }
      return result;

      async function runTool(): Promise<Record<string, unknown>> {
        switch (name) {
          case "get_context": {
            const res = await window.api.remixGetContext();
            if (res.ok) {
              contextRef.current = {
                text: res.selection,
                appName: res.appName,
                windowTitle: res.windowTitle,
                url: res.url,
                clipboard: res.clipboardPreview ?? null,
                clipboardLength: res.clipboardLength ?? 0,
                capturedAt: Date.now(),
              };
              setLiveContext(contextRef.current);
            }
            return { ...res };
          }
          case "read_document":
            return { ...(await window.api.remixReadDocument()) };
          case "select_all":
            return { ...(await window.api.remixSelectAll()) };
          case "select_text":
            if (!str("text")) return badArgs("{ text: string }");
            return {
              ...(await window.api.remixSelectText(
                str("text"),
                num("occurrence"),
              )),
            };
          case "collapse_selection":
            return { ...(await window.api.remixCollapseSelection()) };
          case "copy":
            return { ...(await window.api.remixCopy()) };
          case "set_clipboard":
            if (!str("text")) return badArgs("{ text: string }");
            return { ...(await window.api.remixSetClipboard(str("text"))) };
          case "set_clipboard_image":
            if (!str("url")) return badArgs("{ url: string }");
            return { ...(await window.api.remixSetClipboardImage(str("url"))) };
          case "paste":
            return { ...(await window.api.remixPasteClipboard()) };
          case "undo":
            return { ...(await window.api.remixUndo()) };
          case "redo":
            return { ...(await window.api.remixRedo()) };
          case "press_key":
            if (!str("key")) return badArgs("{ key: string }");
            return {
              ...(await window.api.remixPressKey(str("key"), num("times"))),
            };
          case "get_clipboard":
            return { ...(await window.api.remixGetClipboard()) };
          default:
            return { ok: false, reason: `unknown tool: ${name}` };
        }
      }
    },
    [],
  );
  const { messages, sendMessage, addToolResult, status, stop, clearError } =
    useChat<UIMessage>({
      id: `remix-thread-${thread.threadId}`,
      messages: thread.messages,
      transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onToolCall: async ({ toolCall }) => {
        const output = await executeTool(
          toolCall as unknown as {
            toolName: string;
            toolCallId: string;
            input: unknown;
          },
        );
        void addToolResult({
          tool: getToolOrDynamicToolName(toolCall as never) as never,
          toolCallId: (toolCall as { toolCallId: string }).toolCallId,
          output,
        });
      },
      onError: (err) => {
        setNotice(err.message || "Remix failed.");
      },
      onFinish: ({ messages: finished }) => {
        void apiFetch("/api/remix/thread/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: thread.threadId,
            messages: finished,
          }),
        }).catch(() => {});
      },
    });

  const busy = status === "submitted" || status === "streaming";

  const narrating = useMemo(
    () =>
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.parts.some(
            (part) => isToolOrDynamicToolUIPart(part) && !isToolFinished(part),
          ),
      ),
    [messages],
  );

  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (busy) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), 450);
    return () => clearTimeout(timer);
  }, [busy]);

  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(
    () => () => {
      void stopRef.current();
    },
    [],
  );

  // Guard so the opening instruction is sent exactly once.
  const sentInitialRef = useRef(false);
  useEffect(() => {
    if (sentInitialRef.current) return;
    const instruction = props.initialInstruction?.trim();
    if (!instruction) return;
    sentInitialRef.current = true;
    void sendMessage({ text: instruction });
  }, [props.initialInstruction, sendMessage]);

  // Document-level mouseout: element leave is lost when rows reflow under the
  // cursor. Grace timer distinguishes leave from edge graze; a draft pins open.
  const minimizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearMinimizeTimer = useCallback(() => {
    if (minimizeTimerRef.current) {
      clearTimeout(minimizeTimerRef.current);
      minimizeTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearMinimizeTimer, [clearMinimizeTimer]);
  const handleMouseEnter = useCallback(() => {
    clearMinimizeTimer();
    if (minimized) onExpand();
  }, [clearMinimizeTimer, minimized, onExpand]);
  useEffect(() => {
    if (minimized) return;
    const handleOver = (): void => {
      clearMinimizeTimer();
      document.removeEventListener("mouseover", handleOver);
    };
    const handleOut = (event: MouseEvent): void => {
      if (event.relatedTarget) return;
      if (inputRef.current?.value.trim()) return;
      clearMinimizeTimer();
      minimizeTimerRef.current = setTimeout(() => {
        minimizeTimerRef.current = null;
        document.removeEventListener("mouseover", handleOver);
        onMinimize();
      }, MINIMIZE_GRACE_MS);
      document.addEventListener("mouseover", handleOver);
    };
    document.addEventListener("mouseout", handleOut);
    return () => {
      document.removeEventListener("mouseout", handleOut);
      document.removeEventListener("mouseover", handleOver);
    };
  }, [minimized, onMinimize, clearMinimizeTimer]);

  useEffect(() => {
    if (minimized) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      stopRef.current();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [minimized, onClose]);

  const miniMessageRef = useRef<HTMLDivElement | null>(null);
  const [miniContentHeight, setMiniContentHeight] = useState<number | null>(
    null,
  );
  const finalText = useMemo(() => {
    if (busy) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      const text = message.parts
        .filter(isTextUIPart)
        .map((part) => part.text)
        .join("")
        .trim();
      return text || null;
    }
    return null;
  }, [messages, busy]);
  const showFullFinal =
    minimized && settled && notice === null && finalText !== null;
  const miniStripHeight = showFullFinal
    ? Math.min(
        Math.max(
          miniContentHeight ?? REMIX_CHAT_STRIP.height,
          REMIX_CHAT_STRIP.height,
        ),
        MINI_STRIP_MAX,
      )
    : REMIX_CHAT_STRIP.height;

  const onMiniHeightChangeRef = useRef(props.onMiniHeightChange);
  onMiniHeightChangeRef.current = props.onMiniHeightChange;
  useEffect(() => {
    onMiniHeightChangeRef.current?.(miniStripHeight);
  }, [miniStripHeight]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: finalText re-runs the measurement when a new final message lands in the same settled state
  useLayoutEffect(() => {
    if (!minimized) return;
    if (!showFullFinal) {
      setMiniContentHeight(null);
      return;
    }
    const el = miniMessageRef.current;
    if (!el) return;
    setMiniContentHeight(el.scrollHeight + MINI_STRIP_PAD);
  }, [minimized, showFullFinal, finalText]);

  useEffect(() => {
    if (!minimized || !settled) return;
    const timer = setTimeout(onClose, MINI_SETTLED_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [minimized, settled, onClose]);

  const refreshContext = useCallback(async () => {
    try {
      const re = await window.api.remixRecapture();
      if (re && !re.stale) {
        contextRef.current = {
          // Null can mean empty highlight or a slow reply — keep last known.
          text: re.selection ?? contextRef.current.text,
          appName: re.appName,
          windowTitle: re.windowTitle,
          url: re.url ?? null,
          clipboard: re.clipboard ?? contextRef.current.clipboard ?? null,
          clipboardLength:
            re.clipboardLength ?? contextRef.current.clipboardLength ?? 0,
          capturedAt: re.capturedAt,
        };
        setLiveContext(contextRef.current);
      }
    } catch {
      // Keep last context.
    }
  }, []);

  const sendText = useCallback(
    (text: string) => {
      setNotice(null);
      clearError();
      void sendMessage({ text });
    },
    [clearError, sendMessage],
  );

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const el = inputRef.current;
    if (el) el.style.height = "auto";
    void sendText(text);
  }, [busy, input, sendText]);

  const presetRunningRef = useRef(false);
  const runPresetTransform = useCallback(async (preset: RemixPreset) => {
    const selection = contextRef.current.text;
    if (!selection) return;
    const id = ++actionSeqRef.current;
    setActions((rows) => [
      ...rows,
      { id, label: preset.label, status: "running" },
    ]);
    const settle = (patch: Partial<ActionRow>): void =>
      setActions((rows) =>
        rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      );
    try {
      const res = await apiFetch("/api/remix/transform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: selection,
          remixId: preset.id,
          appName: contextRef.current.appName,
        }),
      });
      if (!res.ok) {
        throw await errorFromResponse(res);
      }
      const data = (await res.json()) as { text?: string };
      const edited = (data.text ?? "").trim();
      if (!edited) throw new Error("The model returned nothing.");
      const delivered = await window.api.remixPasteText(edited);
      if (!delivered.ok) {
        throw new Error("Couldn't replace it — nothing was changed.");
      }

      contextRef.current = { ...contextRef.current, text: edited };
      settle({ status: "done" });
    } catch (err) {
      settle({
        status: "failed",
        detail: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
  }, []);

  const runPreset = useCallback(
    async (preset: RemixPreset) => {
      if (busy || presetRunningRef.current) return;
      presetRunningRef.current = true;
      try {
        await refreshContext();
        const selection = contextRef.current.text;
        if (!selection) {
          setNotice("Nothing is highlighted — select some text first.");
          return;
        }
        await runPresetTransform(preset);
      } finally {
        presetRunningRef.current = false;
      }
    },
    [busy, refreshContext, runPresetTransform],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover cancels minimize; Esc closes
    <div
      className="remix-chat dark"
      data-minimized={minimized}
      data-testid={minimized ? "remix-chat-mini" : "remix-chat"}
      onMouseEnter={handleMouseEnter}
    >
      <style>{REMIX_CHAT_CSS}</style>
      {/* domMax for layout projection; strict requires m.* not motion.* */}
      <LazyMotion features={domMax} strict>
        <div
          className="remix-chat-face remix-chat-face-strip"
          style={anchoredLayerStyle(anchor, {
            width: REMIX_CHAT_STRIP.width,
            height: miniStripHeight,
          })}
          aria-hidden={!minimized}
        >
          <div className="remix-mini" data-full={showFullFinal}>
            <span
              className="remix-mini-dot"
              data-busy={busy || !settled}
              data-failed={notice !== null}
            />
            {showFullFinal ? (
              <div className="remix-mini-message" ref={miniMessageRef}>
                <Markdown text={finalText ?? ""} />
              </div>
            ) : busy || !settled ? (
              <ThinkingShimmer className="remix-mini-line">
                {notice ?? latestActivity(messages, true)}
              </ThinkingShimmer>
            ) : (
              <span className="remix-mini-line remix-mini-text">
                {notice ?? latestActivity(messages, false)}
              </span>
            )}
          </div>
        </div>

        <div
          className="remix-chat-face remix-chat-face-full"
          style={anchoredLayerStyle(anchor, REMIX_CHAT_SURFACE)}
          aria-hidden={minimized}
        >
          <div className="remix-chat-head">
            <span className="remix-chat-title">
              <OpenstyleMark size={15} />
              <span className="remix-chat-wordmark">Remix</span>
            </span>
            <span className="remix-chat-actions">
              <button
                type="button"
                className="remix-chat-icon"
                onClick={() => {
                  stop();
                  props.onNewThread();
                }}
                aria-label="Start a new thread"
                title="Start a new thread"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
                  <path
                    d="M7 2.5v9M2.5 7h9"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="remix-chat-icon"
                onClick={() => {
                  stop();
                  onClose();
                }}
                aria-label="Close"
                title="Close (Esc)"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                >
                  <path
                    d="M2 2l6 6M8 2l-6 6"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </span>
          </div>

          <MessageScroller
            className="remix-chat-scroll"
            busy={busy}
            label="Remix conversation"
            contentClassName="remix-chat-thread"
          >
            {messages.length === 0 && actions.length === 0 && !busy && (
              <div className="remix-chat-empty">
                {liveContext.text
                  ? "Say or type what to do with your selection."
                  : "Nothing selected — ask me to write, research, or answer."}
              </div>
            )}
            {actions.map((action) => (
              <div
                key={action.id}
                className="remix-chat-action"
                data-failed={action.status === "failed"}
              >
                {action.status === "running"
                  ? `${action.label}…`
                  : action.status === "done"
                    ? `${action.label} — replaced your text`
                    : `${action.label} failed — ${action.detail ?? ""}`}
              </div>
            ))}
            {messages.map((message) => (
              <MessageRow key={message.id} message={message} busy={busy} />
            ))}
            {busy && !narrating && (
              <ThinkingShimmer className="remix-chat-busy">
                Thinking…
              </ThinkingShimmer>
            )}
          </MessageScroller>

          {notice && (
            <div className="remix-chat-notice" role="alert">
              {notice}
            </div>
          )}

          {!busy && messages.length === 0 && liveContext.text ? (
            <div className="remix-chat-quick">
              {REMIX_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="remix-chat-chip"
                  onClick={() => void runPreset(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="remix-chat-composer">
            <textarea
              ref={inputRef}
              className="remix-chat-input"
              rows={1}
              value={input}
              aria-label="Message Remix"
              placeholder={busy ? "Working…" : "Message Remix…"}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {busy ? (
              <button
                type="button"
                className="remix-chat-send"
                onClick={() => stop()}
                aria-label="Stop"
                title="Stop"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                >
                  <rect x="1.5" y="1.5" width="9" height="9" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="remix-chat-send"
                disabled={!input.trim()}
                onClick={submit}
                aria-label="Send"
                title="Send"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path
                    d="M8 12.8V3.6M4.1 7.4 8 3.5l3.9 3.9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </LazyMotion>
    </div>
  );
}

async function errorFromResponse(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as {
    detail?: string;
  } | null;
  return new Error(body?.detail || `Remix failed (${res.status}).`);
}

async function createThread(): Promise<ThreadState> {
  const res = await apiFetch("/api/remix/thread/new", { method: "POST" });
  if (!res.ok) throw new Error(`thread new ${res.status}`);
  return (await res.json()) as ThreadState;
}

function isToolFinished(part: ToolUIPart | DynamicToolUIPart): boolean {
  return part.state === "output-available" || part.state === "output-error";
}

const TOOL_LABELS: Record<string, { doing: string; done: string }> = {
  get_context: {
    doing: "Looking at your screen…",
    done: "Checked your screen",
  },
  read_document: {
    doing: "Reading the document…",
    done: "Read the document",
  },
  select_all: { doing: "Selecting everything…", done: "Selected everything" },
  select_text: {
    doing: "Selecting in your document…",
    done: "Moved your selection",
  },
  collapse_selection: {
    doing: "Placing the cursor…",
    done: "Placed the cursor",
  },
  copy: { doing: "Reading your selection…", done: "Read your selection" },
  set_clipboard: {
    doing: "Preparing text…",
    done: "Put text on your clipboard",
  },
  set_clipboard_image: {
    doing: "Fetching an image…",
    done: "Put an image on your clipboard",
  },
  paste: { doing: "Pasting…", done: "Pasted into your document" },
  undo: { doing: "Undoing…", done: "Undid the last edit" },
  redo: { doing: "Redoing…", done: "Redid the edit" },
  press_key: { doing: "Pressing a key…", done: "Pressed a key" },
  get_clipboard: {
    doing: "Reading your clipboard…",
    done: "Read your clipboard",
  },
  web_search: { doing: "Searching the web…", done: "Searched the web" },
  image_search: { doing: "Searching images…", done: "Searched images" },
};

function toolLabels(name: string): { doing: string; done: string } {
  return (
    TOOL_LABELS[name] ?? { doing: `Running ${name}…`, done: `Ran ${name}` }
  );
}

function latestActivity(messages: UIMessage[], busy: boolean): string {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m];
    for (let i = message.parts.length - 1; i >= 0; i--) {
      const part = message.parts[i];
      if (isToolOrDynamicToolUIPart(part)) {
        const name = getToolOrDynamicToolName(part);
        const labels = toolLabels(name);
        return isToolFinished(part) && !busy ? labels.done : labels.doing;
      }
      if (isTextUIPart(part) && part.text.trim()) {
        const line = part.text.trim().split("\n")[0] ?? "";
        if (message.role === "user") return busy ? "Thinking…" : `“${line}”`;
        return line;
      }
    }
  }
  return busy ? "Thinking…" : "Openstyle Remix";
}

const MessageRow = memo(function MessageRow({
  message,
  busy,
}: {
  message: UIMessage;
  busy: boolean;
}): React.JSX.Element {
  if (message.role === "user") {
    const text = message.parts
      .filter(isTextUIPart)
      .map((part) => part.text)
      .join("");
    return <div className="remix-chat-user">{text}</div>;
  }

  const blocks: Array<
    | { kind: "tools"; parts: Array<ToolUIPart | DynamicToolUIPart> }
    | { kind: "text"; text: string; index: number }
  > = [];
  message.parts.forEach((part, index) => {
    if (isToolOrDynamicToolUIPart(part)) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "tools") last.parts.push(part);
      else blocks.push({ kind: "tools", parts: [part] });
    } else if (isTextUIPart(part) && part.text.trim()) {
      blocks.push({ kind: "text", text: part.text, index });
    }
  });

  return (
    <div className="remix-chat-assistant">
      {blocks.map((block) =>
        block.kind === "tools" ? (
          <ToolActivity
            key={block.parts[0].toolCallId}
            parts={block.parts}
            busy={busy}
          />
        ) : (
          <AssistantText key={`text-${block.index}`} text={block.text} />
        ),
      )}
    </div>
  );
});

function AssistantText({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="remix-chat-response">
      <Markdown text={text} />
    </div>
  );
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) return "—";
  try {
    const text =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text.length > 2400 ? `${text.slice(0, 2400)}…` : text;
  } catch {
    return String(value);
  }
}

function ToolStepLabel({
  part,
  label,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  label: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const finished = isToolFinished(part);
  return (
    <span className="remix-chat-step">
      <button
        type="button"
        className="remix-chat-step-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="remix-chat-step-label">{label}</span>
        <svg
          className="remix-chat-step-chevron"
          data-open={open}
          width="8"
          height="8"
          viewBox="0 0 8 8"
          aria-hidden="true"
        >
          <path
            d="M2.5 1.5 5.5 4 2.5 6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <AgentDisclosure open={open}>
        {/* Spans: AgentActivity puts labels in a <span>; block tags would be invalid. */}
        <span className="remix-chat-step-body">
          <span className="remix-chat-step-key">Input</span>
          <span className="remix-chat-step-pre">{pretty(part.input)}</span>
          {finished && (
            <>
              <span className="remix-chat-step-key">Output</span>
              <span className="remix-chat-step-pre">
                {pretty(
                  part.state === "output-error" ? part.errorText : part.output,
                )}
              </span>
            </>
          )}
        </span>
      </AgentDisclosure>
    </span>
  );
}

function ToolActivity({
  parts,
  busy,
}: {
  parts: Array<ToolUIPart | DynamicToolUIPart>;
  busy: boolean;
}): React.JSX.Element {
  const items: AgentActivityStep[] = parts.map((part) => {
    const name = getToolOrDynamicToolName(part);
    const labels = toolLabels(name);
    const finished = isToolFinished(part);
    const output =
      part.state === "output-available" &&
      typeof part.output === "object" &&
      part.output !== null
        ? (part.output as { ok?: boolean })
        : null;
    const failed = part.state === "output-error" || output?.ok === false;
    return {
      id: part.toolCallId,
      type: "step",
      label: (
        <ToolStepLabel
          part={part}
          label={failed ? `${labels.done} — didn't work` : labels.done}
        />
      ),
      status: finished ? "complete" : "active",
      meta: finished ? undefined : "…",
    };
  });

  const inFlight = parts.find((part) => !isToolFinished(part));

  // Override step summary ("Thought for Ns") — these are document tools.
  const summary = `Ran ${parts.length} ${parts.length === 1 ? "tool" : "tools"}`;
  const activeLabel = inFlight
    ? toolLabels(getToolOrDynamicToolName(inFlight)).doing
    : undefined;

  return (
    <AgentActivity
      className="remix-chat-activity"
      items={items}
      maxHeight={280}
      summary={summary}
      activeLabel={activeLabel}
      status={inFlight && busy ? "working" : "complete"}
    />
  );
}

const Markdown = memo(function Markdown({
  text,
}: {
  text: string;
}): React.JSX.Element {
  return (
    <div className="remix-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
