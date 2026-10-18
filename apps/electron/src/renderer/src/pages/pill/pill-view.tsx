import { AlertCardBody } from "@renderer/components/alert-card-body";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  CANCEL_SIZE,
  CHECK_PATH_LENGTH,
  INK,
  STATUS_GAP,
} from "../pill-motion";
import { PILL_STYLES } from "../pill-styles";
import {
  ALERT,
  BAR_COLOR,
  CHECK_SIZE,
  PILL_CORE_WIDTH,
  type PillExit,
  type PillState,
  pillInnerStyle,
  STATUS_SIZE,
} from "./constants";

export interface PillViewProps {
  state: PillState;
  accessibleStatus: string;
  layerClass: string;
  showErrorCard: boolean;
  entered: boolean;
  exiting: PillExit | null;
  handlePillEnter: () => void;
  handlePillLeave: () => void;
  riseBy: (distance: number) => CSSProperties;
  transformOrigin: string;
  pillAlign: "start" | "end";
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
}

export function PillView({
  state,
  accessibleStatus,
  layerClass,
  showErrorCard,
  entered,
  exiting,
  handlePillEnter,
  handlePillLeave,
  riseBy,
  transformOrigin,
  pillAlign,
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
}: PillViewProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="relative h-screen w-screen select-none overflow-hidden">
      <style>{PILL_STYLES}</style>

      {state !== "idle" && (
        <>
          <span className="sr-only" role="status" aria-live="polite">
            {accessibleStatus}
          </span>

          {/* ---- Capsule ---- */}
          <div className={layerClass} aria-hidden={errorCardOpen}>
            {/* The capsule is a status indicator, not a control, so an
                interactive role would misdescribe it. These handlers only
                reveal the cancel button, which is a real <button> with its own
                label, and the same action is on Escape — nothing here is
                pointer-only. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
            <div
              className="pill-surface pill-capsule inline-flex items-center"
              data-show={!showErrorCard && entered}
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
                    aria-label={t("pill.cancelDictation")}
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

                {pillLanguageLabel &&
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
                {waveform}
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
        </>
      )}
    </div>
  );
}
