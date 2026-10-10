import { AlertCardBody } from "@renderer/components/alert-card-body";
import { OpenstyleMark } from "@renderer/components/openstyle-mark";
import {
  REMIX_CHAT_STRIP,
  REMIX_CHAT_SURFACE,
} from "@renderer/components/remix-chat-surface";
import {
  type CSSProperties,
  type Dispatch,
  lazy,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  Suspense,
} from "react";
import type { RemixSelectionPayload } from "../../../../shared/remix";
import {
  CANCEL_SIZE,
  CHECK_PATH_LENGTH,
  INK,
  STATUS_GAP,
  SVG_HEIGHT,
} from "../pill-motion";
import { PILL_STYLES } from "../pill-styles";
import {
  ALERT,
  BAR_COLOR,
  CHECK_SIZE,
  PILL_CORE_WIDTH,
  PILL_HEIGHT,
  type PillExit,
  type PillState,
  pillInnerStyle,
  type RemixSession,
  STATUS_SIZE,
} from "./constants";

// Lazy: keep Motion/agent chat out of the dictation entry chunk.
const RemixChat = lazy(() =>
  import("@renderer/components/remix-chat").then((mod) => ({
    default: mod.RemixChat,
  })),
);

export interface PillViewProps {
  state: PillState;
  showRemixCard: boolean;
  accessibleStatus: string;
  layerClass: string;
  cardOpen: boolean;
  showCard: boolean;
  entered: boolean;
  exiting: PillExit | null;
  handlePillEnter: () => void;
  handlePillLeave: () => void;
  riseBy: (distance: number) => CSSProperties;
  transformOrigin: string;
  pillAlign: "start" | "end";
  pillSide: "center" | "right";
  cancelSlotRef: RefObject<HTMLSpanElement | null>;
  cancelRecording: () => void;
  pillLanguageLabel: string | null;
  waveColor: string;
  waveform: ReactNode;
  wantsStatus: boolean;
  status: { label: string | null; count: string | null; isAlert: boolean };
  errorCardOpen: boolean;
  cardSurfaceStyle: CSSProperties;
  card: { title: string; body: string; canRetry: boolean };
  dismissPill: (kind: PillExit) => void;
  retryFailedTranscription: () => void;
  remixOpen: boolean;
  viewIsChat: boolean;
  cardSurfaceRef: RefObject<HTMLDivElement | null>;
  chatSurfaceRef: RefObject<HTMLDivElement | null>;
  disarmHotRect: () => void;
  rearmHotRect: () => void;
  cardView: RemixSession | null;
  endRemix: (options?: { hide?: boolean }) => void;
  remixTranscript: string;
  remixHint: string;
  chatMiniVisual: boolean;
  remixMiniHeight: number;
  chatView: RemixSession | null;
  remixContextRef: RefObject<RemixSelectionPayload | null>;
  expandRemixChat: () => void;
  minimizeRemixChat: () => void;
  closeRemix: () => void;
  setRemixMiniHeight: Dispatch<SetStateAction<number>>;
}

export function PillView({
  state,
  showRemixCard,
  accessibleStatus,
  layerClass,
  cardOpen,
  showCard,
  entered,
  exiting,
  handlePillEnter,
  handlePillLeave,
  riseBy,
  transformOrigin,
  pillAlign,
  pillSide,
  cancelSlotRef,
  cancelRecording,
  pillLanguageLabel,
  waveColor,
  waveform,
  wantsStatus,
  status,
  errorCardOpen,
  cardSurfaceStyle,
  card,
  dismissPill,
  retryFailedTranscription,
  remixOpen,
  viewIsChat,
  cardSurfaceRef,
  chatSurfaceRef,
  disarmHotRect,
  rearmHotRect,
  cardView,
  endRemix,
  remixTranscript,
  remixHint,
  chatMiniVisual,
  remixMiniHeight,
  chatView,
  remixContextRef,
  expandRemixChat,
  minimizeRemixChat,
  closeRemix,
  setRemixMiniHeight,
}: PillViewProps): React.JSX.Element {
  return (
    <div className="relative h-screen w-screen select-none overflow-hidden">
      <style>{PILL_STYLES}</style>

      {(state !== "idle" || showRemixCard) && (
        <>
          <span className="sr-only" role="status" aria-live="polite">
            {accessibleStatus}
          </span>

          {/* ---- Capsule ---- */}
          <div className={layerClass} aria-hidden={cardOpen}>
            {/* The capsule is a status indicator, not a control, so an
                interactive role would misdescribe it. These handlers only
                reveal the cancel button, which is a real <button> with its own
                label, and the same action is on Escape — nothing here is
                pointer-only. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
            <div
              className="pill-surface pill-capsule inline-flex items-center"
              data-show={!showCard && entered}
              data-exit={exiting ?? undefined}
              onMouseEnter={handlePillEnter}
              onMouseLeave={handlePillLeave}
              style={{
                ...pillInnerStyle,
                ...riseBy(10),
                transformOrigin,
                marginBottom: pillAlign === "end" ? 8 : 0,
                marginTop: pillAlign === "start" ? 8 : 0,
              }}
            >
              {/* The fixed core: the cancel slot's width is driven by the draw
                  loop, from zero (closed) to CANCEL_SLOT — the disc plus the
                  gap to the waveform — and the waveform gives up exactly that
                  much, so the core's own width never changes. */}
              <span
                className="inline-flex items-center justify-center"
                style={{ width: PILL_CORE_WIDTH, flexShrink: 0 }}
              >
                <span
                  ref={cancelSlotRef}
                  className="inline-flex items-center justify-start"
                  style={
                    {
                      // Width alone carries the layout, so no padding — it
                      // would be added on top of the animated width.
                      width: 0,
                      height: CANCEL_SIZE,
                      opacity: 0,
                      flexShrink: 0,
                      // Grow out of the capsule's left edge rather than from
                      // the slot's centre, and don't clip the disc while it
                      // scales.
                      transformOrigin: "left center",
                      pointerEvents: "none",
                      WebkitAppRegion: "no-drag",
                    } as React.CSSProperties
                  }
                >
                  <button
                    type="button"
                    className="pill-cancel inline-flex items-center justify-center"
                    onClick={cancelRecording}
                    // The pill window has no i18n provider (only the dashboard
                    // does), and no other string in it is translated. Not worth
                    // pulling the i18next runtime in for one label.
                    aria-label="Cancel dictation"
                    style={{
                      width: CANCEL_SIZE,
                      height: CANCEL_SIZE,
                      padding: 0,
                      flexShrink: 0,
                      cursor: "default",
                    }}
                  >
                    <svg
                      className="pill-cancel-glyph"
                      width={CANCEL_SIZE}
                      height={CANCEL_SIZE}
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                      style={{ opacity: 0.6 }}
                    >
                      {/* Larger and thinner than it was inside the disc: with
                          no chip to give it presence, the mark carries
                          itself. */}
                      <path
                        d="M4.7 4.7 11.3 11.3 M11.3 4.7 4.7 11.3"
                        stroke={INK}
                        strokeWidth={1.5}
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </span>

                {!showRemixCard &&
                  pillLanguageLabel &&
                  (state === "recording" || state === "transcribing") && (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: "0.02em",
                        color: waveColor,
                        opacity: 0.85,
                        marginInlineStart: 4,
                        flexShrink: 0,
                      }}
                    >
                      {pillLanguageLabel}
                    </span>
                  )}
                {!showRemixCard && waveform}
              </span>

              {/* The delivered mark, centred on the capsule rather than inside
                  the waveform's clip: it takes the place the row occupied, at
                  the row's own centre, and is not subject to the clip that
                  hides retiring samples. */}
              <span className="pill-check" aria-hidden="true">
                <svg
                  width={CHECK_SIZE}
                  height={CHECK_SIZE}
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path
                    d="M4.1 8.5 6.8 11.2 11.9 5.2"
                    fill="none"
                    stroke={BAR_COLOR}
                    strokeWidth={1.9}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      strokeDasharray: CHECK_PATH_LENGTH,
                      strokeDashoffset: CHECK_PATH_LENGTH,
                    }}
                  />
                </svg>
              </span>

              {/* Status, outside the core: the capsule grows to the right by
                  one mark's width and nothing else moves. The words are in
                  the tooltip — and in the live region above — so the glyph
                  itself doesn't have to spell anything out. */}
              <span
                className="pill-status inline-flex items-center justify-end"
                data-open={wantsStatus}
                title={status.label ?? undefined}
                aria-hidden="true"
                style={
                  {
                    height: STATUS_SIZE,
                    WebkitAppRegion: "no-drag",
                  } as React.CSSProperties
                }
              >
                <span
                  className="pill-status-mark inline-flex items-center justify-center"
                  style={{
                    width: STATUS_SIZE,
                    height: STATUS_SIZE,
                    marginRight: STATUS_GAP,
                    flexShrink: 0,
                  }}
                >
                  {status.label ? (
                    status.isAlert ? (
                      <svg
                        width={STATUS_SIZE}
                        height={STATUS_SIZE}
                        viewBox="0 0 16 16"
                      >
                        <title>{status.label}</title>
                        <circle
                          cx="8"
                          cy="8"
                          r="5.6"
                          fill="none"
                          stroke={ALERT}
                          strokeWidth={1.4}
                        />
                        <path
                          d="M8 5.1v3.3"
                          stroke={ALERT}
                          strokeWidth={1.4}
                          strokeLinecap="round"
                        />
                        <circle cx="8" cy="10.7" r="0.8" fill={ALERT} />
                      </svg>
                    ) : (
                      <svg
                        className="pill-spinner"
                        width={STATUS_SIZE}
                        height={STATUS_SIZE}
                        viewBox="0 0 16 16"
                      >
                        <title>{status.label}</title>
                        {/* The track keeps the mark the same weight as the
                            cancel one even where the arc isn't drawn. */}
                        <circle
                          cx="8"
                          cy="8"
                          r="5.6"
                          fill="none"
                          stroke={INK}
                          strokeOpacity={0.18}
                          strokeWidth={1.4}
                        />
                        <path
                          d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6"
                          fill="none"
                          stroke={INK}
                          strokeOpacity={0.8}
                          strokeWidth={1.4}
                          strokeLinecap="round"
                        />
                      </svg>
                    )
                  ) : (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        lineHeight: 1,
                        letterSpacing: "0.01em",
                        color: "rgba(245, 241, 228, 0.6)",
                      }}
                    >
                      {status.count}
                    </span>
                  )}
                </span>
              </span>
            </div>
          </div>

          {/* ---- Failure card ---- */}
          <div className={layerClass} aria-hidden={!errorCardOpen}>
            <div
              className="pill-surface pill-card"
              data-show={errorCardOpen && !exiting}
              style={{
                ...cardSurfaceStyle,
                padding: "13px 15px 12px",
                ...(errorCardOpen ? { WebkitAppRegion: "drag" } : {}),
              }}
            >
              <AlertCardBody
                title={card.title}
                body={card.body}
                lineClamp={2}
                onDismiss={() => dismissPill("cancelled")}
                onRetry={card.canRetry ? retryFailedTranscription : undefined}
                ink={INK}
                alert={ALERT}
              />
            </div>
          </div>

          {/* ---- Remix card ---- */}
          {/* Same surface and the same place on screen as the failure card, so
              the two read as one object the pill can turn into rather than as
              two unrelated popups. The dictation card and the chat are
              separate layers: a phase flip animates one out while the other
              rises, and each holds its last content while it leaves. */}
          <div className={layerClass} aria-hidden={!(remixOpen && !viewIsChat)}>
            {/* The card surface is a container, not a control — these handlers
                only arm/disarm the window's hover hit-rect; every real action
                inside is its own labeled <button>. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
            <div
              ref={cardSurfaceRef}
              className="pill-surface pill-card"
              data-show={remixOpen && !viewIsChat}
              onMouseEnter={disarmHotRect}
              onMouseLeave={rearmHotRect}
              style={{
                ...cardSurfaceStyle,
                // The anchored edge gets the capsule's inset — (PILL_HEIGHT -
                // SVG_HEIGHT) / 2 — so the waveform lands exactly where it sat
                // a moment ago. The far edge is free to be roomier.
                padding:
                  pillAlign === "start"
                    ? `${(PILL_HEIGHT - SVG_HEIGHT) / 2}px 14px 13px`
                    : `13px 14px ${(PILL_HEIGHT - SVG_HEIGHT) / 2}px`,
                ...(remixOpen && !viewIsChat
                  ? { WebkitAppRegion: "drag" }
                  : {}),
              }}
            >
              {cardView?.phase === "error" ? (
                <AlertCardBody
                  title={cardView.title}
                  body={cardView.body}
                  lineClamp={3}
                  onDismiss={() => endRemix()}
                  ink={INK}
                  alert={ALERT}
                />
              ) : (
                <div className="pill-remix-body" data-anchor={pillAlign}>
                  <div
                    className="pill-remix-brand pill-rise pill-rise-1"
                    aria-hidden="true"
                  >
                    <OpenstyleMark size={15} />
                    <span>Remix</span>
                  </div>

                  <div
                    className="pill-remix-transcript pill-rise pill-rise-2"
                    data-empty={!remixTranscript}
                  >
                    <span>{remixTranscript || remixHint}</span>
                  </div>

                  {/* The waveform, at the size and the spot it occupies in the
                      capsule — the box grows around it rather than replacing
                      it, so the bars never jump when the card takes over. Only
                      ever mounted here while a remix is up: a second copy in
                      the tree would take the ref the draw loop writes through,
                      and the visible row would sit still. */}
                  <div className="pill-remix-wave">
                    {showRemixCard && waveform}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ---- Remix chat ---- */}
          {/* Its own object: either the one-line activity strip (a capsule)
              or the full conversation (a tall card holding an input and a
              scroll area), morphing between the two under the pointer —
              always inside room the window already holds, so the morph is
              never clipped or resized mid-flight. */}
          <div className={layerClass} aria-hidden={!(remixOpen && viewIsChat)}>
            {/* Same as the card surface above: hover only arms/disarms the
                window's hit-rect; the chat's controls are real buttons. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
            <div
              ref={chatSurfaceRef}
              className="pill-surface pill-card pill-chat-morph"
              data-show={remixOpen && viewIsChat}
              onMouseEnter={disarmHotRect}
              onMouseLeave={rearmHotRect}
              style={{
                ...cardSurfaceStyle,
                ...(chatMiniVisual
                  ? {
                      width: REMIX_CHAT_STRIP.width,
                      height: remixMiniHeight,
                      // A grown strip is a card, not a capsule — a 999px
                      // radius on a tall box reads as a lozenge.
                      borderRadius:
                        remixMiniHeight > REMIX_CHAT_STRIP.height ? 18 : 999,
                      padding: 0,
                      overflow: "hidden",
                    }
                  : {
                      width: REMIX_CHAT_SURFACE.width,
                      height: REMIX_CHAT_SURFACE.height,
                      borderRadius: 18,
                      padding: 0,
                      overflow: "hidden",
                    }),
              }}
            >
              {chatView && (
                <Suspense fallback={null}>
                  <RemixChat
                    context={
                      remixContextRef.current ?? {
                        text: chatView.selection,
                        appName: null,
                        windowTitle: null,
                        capturedAt: Date.now(),
                      }
                    }
                    initialInstruction={chatView.initialInstruction ?? null}
                    minimized={chatMiniVisual}
                    anchor={{
                      v: pillAlign === "start" ? "top" : "bottom",
                      h: pillSide === "right" ? "right" : "center",
                    }}
                    onExpand={expandRemixChat}
                    onMinimize={minimizeRemixChat}
                    onClose={closeRemix}
                    onMiniHeightChange={setRemixMiniHeight}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
