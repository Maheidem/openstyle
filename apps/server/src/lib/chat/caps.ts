// Size caps of the chat answer path (eval study 2026-11-03). The app uses the
// DEFAULT caps, made for a small local model. WIDE caps are for a cloud model
// with a big context. Only the eval asks for them (`ChatTurnInput.caps`), and
// a local model never gets them. The app does not use them yet.

export interface Caps {
  /** Characters of a chunk hit that go to the model (tools.ts). */
  hitChars: number;
  /** Sources and characters for each source of one research worker (workers.ts). */
  workerSources: number;
  workerChars: number;
  /** Floor of the source budget, in tokens (the setting can be higher). */
  sourceBudget: number | null;
  /** Bullets of an answer, at most. */
  maxBullets: number;
  /** Output caps of the answer call, in tokens. */
  answerMaxTokens: number;
  synthMaxTokens: number;
  /** The score floor of the research path; null keeps SCORE_FLOOR. */
  scoreFloor: number | null;
  /** Workers of one research turn. null keeps the FAN_* values. */
  fanItems: number | null;
  fanMeetings: number | null;
}

export const DEFAULT_CAPS: Caps = {
  hitChars: 640,
  workerSources: 5,
  workerChars: 520,
  sourceBudget: null,
  maxBullets: 6,
  answerMaxTokens: 500,
  synthMaxTokens: 1500,
  scoreFloor: null,
  fanItems: null,
  fanMeetings: null,
};

export const WIDE_CAPS: Caps = {
  hitChars: 2000,
  workerSources: 12,
  workerChars: 1500,
  sourceBudget: 30000,
  maxBullets: 12,
  answerMaxTokens: 2000,
  synthMaxTokens: 3000,
  scoreFloor: 0.3,
  // The open-items list shows 8 actions and 4 questions (LIST_SHOWN): 12 covers it.
  fanItems: 12,
  fanMeetings: 16,
};
