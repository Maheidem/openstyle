import { useElapsedClock } from "@renderer/hooks/use-elapsed-clock";
import { type CSSProperties, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CANCEL_SIZE, INK } from "../pill-motion";
import {
  LIVE,
  PILL_HEIGHT,
  pillInnerStyle,
  SURFACE,
  SURFACE_BORDER,
} from "./constants";
import { type Caption, useLiveCaptions } from "./live-captions";

/**
 * The meeting Recording state of the pill: a pulsing live dot, the elapsed
 * time and a Stop button. The pill shows it while a meeting records and no
 * dictation runs. The words "Recording meeting" go to the tooltip and the
 * live region, not into the capsule (specs/voice-pill-motion.md §2,
 * principle 3).
 */
export function MeetingCapsule({
  startedAt,
  leaving,
  layerClass,
  riseBy,
  transformOrigin,
  pillAlign,
}: {
  startedAt: number;
  /** True after a stop: play the quiet exit (the dictation's `quiet`). */
  leaving: boolean;
  layerClass: string;
  riseBy: (distance: number) => CSSProperties;
  transformOrigin: string;
  pillAlign: "start" | "end";
}): React.JSX.Element {
  const { t } = useTranslation();
  const elapsed = useElapsedClock(startedAt);
  const [stopping, setStopping] = useState(false);
  const { caption, shown: captionShown } = useLiveCaptions();
  const label = t("pill.status.meetingRecording");

  // Mount one frame hidden, then show, so the arrival transition runs (the
  // same handshake as the dictation capsule).
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const stop = (): void => {
    if (stopping) return;
    setStopping(true);
    // The status change starts the exit. The main process hides the pill
    // when the exit ends.
    void window.api.stopMeetingRecording().catch(() => setStopping(false));
  };

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {label}
      </span>
      {caption && (
        <CaptionBox
          caption={caption}
          shown={captionShown && !leaving}
          riseBy={riseBy}
          transformOrigin={transformOrigin}
          pillAlign={pillAlign}
        />
      )}
      <div className={layerClass}>
        <div
          className="pill-surface pill-capsule inline-flex items-center"
          data-show={entered}
          data-exit={leaving ? "quiet" : undefined}
          data-testid="pill-meeting"
          title={label}
          style={{
            ...pillInnerStyle,
            ...riseBy(10),
            transformOrigin,
            marginBottom: pillAlign === "end" ? 8 : 0,
            marginTop: pillAlign === "start" ? 8 : 0,
            gap: 8,
            padding: "0 7px 0 12px",
          }}
        >
          <span
            className="pill-live-dot"
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              background: LIVE,
              flexShrink: 0,
            }}
          />
          <span
            data-testid="pill-meeting-elapsed"
            style={{
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1,
              letterSpacing: "0.01em",
              fontVariantNumeric: "tabular-nums",
              color: "rgba(245, 241, 228, 0.85)",
            }}
          >
            {elapsed}
          </span>
          <button
            type="button"
            className="pill-cancel inline-flex items-center justify-center"
            onClick={stop}
            disabled={stopping}
            aria-label={t("pill.stopMeeting")}
            title={t("pill.stopMeeting")}
            style={
              {
                width: CANCEL_SIZE,
                height: CANCEL_SIZE,
                padding: 0,
                flexShrink: 0,
                cursor: "default",
                WebkitAppRegion: "no-drag",
              } as CSSProperties
            }
          >
            <svg
              className="pill-cancel-glyph"
              width={CANCEL_SIZE}
              height={CANCEL_SIZE}
              viewBox="0 0 16 16"
              aria-hidden="true"
              style={{ opacity: 0.6 }}
            >
              <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill={INK} />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}

/** Space between the capsule and the caption box, in px. */
const CAPTION_GAP = 6;
const CAPTION_LINE_HEIGHT = 16;

/** One caption line. A line that is too long loses its start ("..."). */
function CaptionLine({
  text,
  muted,
  testId,
}: {
  text: string;
  muted: boolean;
  testId: string;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      style={{
        height: CAPTION_LINE_HEIGHT,
        lineHeight: `${CAPTION_LINE_HEIGHT}px`,
        fontSize: 12,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        // The right-to-left box keeps the end of the text and cuts the start.
        direction: "rtl",
        textAlign: "left",
        color: muted
          ? "rgba(245, 241, 228, 0.55)"
          : "rgba(245, 241, 228, 0.92)",
      }}
    >
      <bdo dir="ltr">{text}</bdo>
    </div>
  );
}

/**
 * The live captions of the meeting capsule (issue #375): the newest final
 * line, then the newest partial line in a muted style. The box sits on the
 * side of the capsule that faces the screen centre. It never moves the
 * capsule, because the window grows around the capsule's anchored edge.
 */
function CaptionBox({
  caption,
  shown,
  riseBy,
  transformOrigin,
  pillAlign,
}: {
  caption: Caption;
  shown: boolean;
  riseBy: (distance: number) => CSSProperties;
  transformOrigin: string;
  pillAlign: "start" | "end";
}): React.JSX.Element {
  const offset = 8 + PILL_HEIGHT + CAPTION_GAP;
  return (
    <div
      className="absolute inset-x-2 flex justify-center"
      style={{
        pointerEvents: "none",
        [pillAlign === "end" ? "bottom" : "top"]: offset,
      }}
    >
      <div
        className="pill-surface"
        data-show={shown}
        data-testid="pill-captions"
        aria-hidden="true"
        style={{
          ...riseBy(10),
          transformOrigin,
          width: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          padding: "5px 11px",
          borderRadius: 12,
          background: SURFACE,
          border: SURFACE_BORDER,
          pointerEvents: "none",
        }}
      >
        {caption.final !== null && (
          <CaptionLine
            text={caption.final}
            muted={false}
            testId="pill-caption-final"
          />
        )}
        {caption.partial !== null && (
          <CaptionLine
            text={caption.partial}
            muted
            testId="pill-caption-partial"
          />
        )}
      </div>
    </div>
  );
}
