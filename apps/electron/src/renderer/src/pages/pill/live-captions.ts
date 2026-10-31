import { getClient } from "@renderer/lib/api";
import { SETTINGS_KEYS } from "@shared/settings-keys";
import { useEffect, useRef, useState } from "react";

/** The pill asks the server for new live text once each second. */
export const CAPTION_POLL_MS = 1000;
/** The captions hide when the text does not change for this long. */
export const CAPTION_HIDE_MS = 8000;
/** The window needs a moment to grow before the captions fade in. */
const ROOM_MS = 80;
/** The window shrinks after the captions have faded out. */
const SHRINK_MS = 300;

/** A live line, as `GET /api/meetings/:id/live` sends it. */
export interface CaptionSourceLine {
  startMs: number;
  text: string;
  final: boolean;
}

/** The text of the two caption lines. The oldest is on top. */
export interface Caption {
  /** The newest final line. */
  final: string | null;
  /** The newest partial line (text that can still change). */
  partial: string | null;
}

/** The two lines to show: the newest final line and the newest partial. */
export function pickCaption(lines: readonly CaptionSourceLine[]): Caption {
  let final: CaptionSourceLine | null = null;
  let partial: CaptionSourceLine | null = null;
  for (const line of lines) {
    if (!line.text.trim()) continue;
    if (line.final) {
      if (!final || line.startMs >= final.startMs) final = line;
    } else if (!partial || line.startMs >= partial.startMs) {
      partial = line;
    }
  }
  return {
    final: final ? final.text.trim() : null,
    partial: partial ? partial.text.trim() : null,
  };
}

export function captionIsEmpty(caption: Caption): boolean {
  return caption.final === null && caption.partial === null;
}

/** A key that changes when the text changes. */
export function captionKey(caption: Caption): string {
  return `${caption.final ?? ""}\u0000${caption.partial ?? ""}`;
}

/**
 * The live captions of the pill (issue #375). They show only when both
 * `live_chat_enabled` and `live_captions_pill` are on. The hook polls the
 * live route of the recording meeting, the same route as the live view. It
 * returns the text to show and whether the window has room for it, and it
 * asks main to grow the pill window while text is visible.
 */
export function useLiveCaptions(): {
  caption: Caption | null;
  shown: boolean;
} {
  const [enabled, setEnabled] = useState(false);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [current, setCurrent] = useState<Caption | null>(null);
  const [shown, setShown] = useState(false);
  // Kept while the text fades out.
  const [last, setLast] = useState<Caption | null>(null);
  const lastKey = useRef("");

  // The settings and the meeting id, once, when the recording capsule mounts.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getClient().api.settings.$get();
        if (!res.ok) return;
        const s = await res.json();
        const on =
          s[SETTINGS_KEYS.liveChatEnabled] === "true" &&
          s[SETTINGS_KEYS.liveCaptionsPill] === "true";
        if (!on || cancelled) return;
        const status = await window.api.getMeetingStatus();
        if (cancelled || status.status !== "recording") return;
        setMeetingId(status.meetingId ?? null);
        setEnabled(true);
      } catch {
        // No captions. The capsule works as before.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the live route. A change of text restarts the hide timer.
  useEffect(() => {
    if (!enabled || !meetingId) return;
    let stopped = false;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try {
        const res = await getClient().api.meetings[":id"].live.$get({
          param: { id: meetingId },
        });
        if (stopped || !res.ok) return;
        const data = await res.json();
        const next = data.status === "off" ? null : pickCaption(data.lines);
        const key = next && !captionIsEmpty(next) ? captionKey(next) : "";
        if (key === lastKey.current) return;
        lastKey.current = key;
        clearTimeout(hideTimer);
        if (!next || !key) {
          setCurrent(null);
          return;
        }
        setCurrent(next);
        setLast(next);
        hideTimer = setTimeout(() => setCurrent(null), CAPTION_HIDE_MS);
      } catch {
        // Try again at the next tick.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), CAPTION_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(hideTimer);
    };
  }, [enabled, meetingId]);

  // Room first, then the fade-in. Fade-out first, then give the room back.
  useEffect(() => {
    if (!enabled) return;
    if (current) {
      window.api?.setPillCaptions?.(true);
      const timer = setTimeout(() => setShown(true), ROOM_MS);
      return () => clearTimeout(timer);
    }
    setShown(false);
    const timer = setTimeout(
      () => window.api?.setPillCaptions?.(false),
      SHRINK_MS,
    );
    return () => clearTimeout(timer);
  }, [enabled, current]);

  // Give the room back when the capsule goes away.
  useEffect(() => {
    if (!enabled) return;
    return () => window.api?.setPillCaptions?.(false);
  }, [enabled]);

  return { caption: enabled ? last : null, shown: shown && current !== null };
}
