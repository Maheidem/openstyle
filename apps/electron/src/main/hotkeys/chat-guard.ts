// The dictation guard of the Ask bubble hotkey (specs/meeting-chat-agent.md
// 11.6.2). The dictation hotkey (Control+Alt) is a prefix of the chat hotkey
// (Control+Alt+K). A press of Control+Alt must not start a dictation when K
// follows. So a dictation start waits 150 ms. If the chat key goes down in
// this window, the start is cancelled and the bubble opens.
//
// This module has no `electron` import, so vitest tests it with a fake clock.
import { isChordPrefix } from "../hotkey-utils";

/** The wait before a dictation starts while the chat hotkey is on. */
export const CHAT_CHORD_GUARD_MS = 150;

export interface DictationStartGuardOptions {
  /** True while a dictation runs (it started after the guard window). */
  isDictating: () => boolean;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface PendingStart {
  start: () => void;
  timer: unknown;
}

export class DictationStartGuard {
  private chatAccel: string | null = null;
  private pending: PendingStart | null = null;
  private readonly delayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: DictationStartGuardOptions) {
    this.delayMs = options.delayMs ?? CHAT_CHORD_GUARD_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** The accelerator of the chat hotkey, or null when it is off. */
  setChatAccel(accel: string | null): void {
    this.chatAccel = accel;
    // A start that waits for a chat key that can no longer come goes now.
    if (accel === null) this.release();
  }

  /** True while a dictation start waits for the window to end. */
  get waiting(): boolean {
    return this.pending !== null;
  }

  /** True while the chat hotkey is on, so a dictation start can wait. */
  get armed(): boolean {
    return this.chatAccel !== null;
  }

  /**
   * A dictation hotkey went down. `start` begins the dictation (or toggles
   * it). It runs at once when the chat hotkey is off or the dictation hotkey
   * is not a prefix of it. Else it runs when the window ends.
   */
  press(dictationAccel: string | null, start: () => void): void {
    // A second press while one waits: the first one is not lost.
    this.release();
    if (
      this.chatAccel === null ||
      dictationAccel === null ||
      !isChordPrefix(dictationAccel, this.chatAccel)
    ) {
      start();
      return;
    }
    const entry: PendingStart = { start, timer: null };
    entry.timer = this.setTimer(() => {
      if (this.pending !== entry) return;
      this.pending = null;
      entry.start();
    }, this.delayMs);
    this.pending = entry;
  }

  /**
   * The dictation hotkey went up. A start that still waits runs now, so a
   * short tap starts and stops a dictation as it did before the guard.
   */
  release(): void {
    const entry = this.pending;
    if (!entry) return;
    this.pending = null;
    this.clearTimer(entry.timer);
    entry.start();
  }

  /** Drop a waiting start without running it (a re-registration). */
  cancel(): void {
    const entry = this.pending;
    if (!entry) return;
    this.pending = null;
    this.clearTimer(entry.timer);
  }

  /**
   * The chat key went down. Returns true when the bubble may open. A waiting
   * dictation start is cancelled. A dictation that already runs keeps the key:
   * the chat key is ignored (false).
   */
  chatKeyDown(): boolean {
    if (this.pending) {
      this.cancel();
      return true;
    }
    return !this.options.isDictating();
  }
}
