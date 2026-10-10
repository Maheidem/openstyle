import type { Recorder } from "@renderer/lib/recorder";
import type { Streamer } from "@renderer/lib/streamer";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { PillCancelMode } from "../../../../shared/pill-cancel";
import type { RemixSelectionPayload } from "../../../../shared/remix";
import type { BarJitter } from "../pill-waveform";
import type {
  BarMode,
  Deferred,
  PillExit,
  PillNotice,
  PillState,
  RemixSession,
  TranscribeResult,
} from "./constants";

// State shared by all pill hooks. AppPage builds one object of this type and passes it to every hook.
export interface PillShared {
  setPillState: (next: PillState) => void;
  setPillNotice: (notice: PillNotice) => void;
  setCanRetry: Dispatch<SetStateAction<boolean>>;
  setPillLanguageLabel: Dispatch<SetStateAction<string | null>>;
  setPendingCount: Dispatch<SetStateAction<number>>;
  setMicSilent: Dispatch<SetStateAction<boolean>>;
  setElapsedLabel: Dispatch<SetStateAction<string | null>>;
  setColdLocalModel: Dispatch<SetStateAction<boolean>>;
  setExiting: Dispatch<SetStateAction<PillExit | null>>;
  setRemix: (next: RemixSession | null) => void;
  patchRemix: (patch: Partial<RemixSession>) => void;

  stateRef: RefObject<PillState>;
  pillNoticeRef: RefObject<PillNotice>;
  supportsSessionTransportRef: RefObject<boolean>;
  recordingSessionUsesTransportRef: RefObject<boolean>;
  providerCategoryRef: RefObject<string | null>;
  streamSessionErrorRef: RefObject<{ message: string; code?: string } | null>;
  failedTranscriptionErrorRef: RefObject<string>;
  lastRecordingDurationRef: RefObject<number>;
  pinnedLanguageRef: RefObject<string | null>;
  recordingLanguageRef: RefObject<string | null>;
  streamLanguageRef: RefObject<string | null>;
  remixRef: RefObject<RemixSession | null>;
  remixDownAtRef: RefObject<number>;
  remixSeqRef: RefObject<number>;
  remixMicGenRef: RefObject<number | null>;
  remixSelectionRef: RefObject<Deferred<string | null> | null>;
  remixContextRef: RefObject<RemixSelectionPayload | null>;
  remixRunningRef: RefObject<boolean>;
  remixHoldTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  remixStreamerRef: RefObject<Streamer | null>;
  remixTransportRef: RefObject<boolean>;
  remixFinalRef: RefObject<Deferred<string> | null>;
  recorderRef: RefObject<Recorder>;
  streamerRef: RefObject<Streamer | null>;
  analyserCtxRef: RefObject<AudioContext | null>;
  audioSourceRef: RefObject<MediaStreamAudioSourceNode | null>;
  analyserNodeRef: RefObject<AnalyserNode | null>;
  barsRef: RefObject<number[]>;
  barLinesRef: RefObject<SVGLineElement[]>;
  cancelOpenRef: RefObject<number>;
  cancelTargetRef: RefObject<number>;
  lastCancelWriteRef: RefObject<number>;
  cancelSlotRef: RefObject<HTMLSpanElement | null>;
  waveClipRef: RefObject<HTMLSpanElement | null>;
  flatlineRef: RefObject<SVGLineElement | null>;
  silentSinceRef: RefObject<number>;
  flatAmountRef: RefObject<number>;
  flatTargetRef: RefObject<number>;
  micSilentRef: RefObject<boolean>;
  exitTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  exitingRef: RefObject<PillExit | null>;
  hoveredRef: RefObject<boolean>;
  cancelModeRef: RefObject<PillCancelMode>;
  targetsRef: RefObject<number[]>;
  sampleRef: RefObject<{
    lastSampleAt: number;
    peak: number;
    jitter: BarJitter;
  }>;
  rafRef: RefObject<number>;
  startTimeRef: RefObject<number>;
  wantsMicRef: RefObject<boolean>;
  recordingActiveRef: RefObject<boolean>;
  appContextRef: RefObject<string | null>;
  pendingCommitRef: RefObject<boolean>;
  pillActiveRef: RefObject<boolean>;
  duckingPromiseRef: RefObject<Promise<unknown> | undefined>;
  barModeRef: RefObject<BarMode | null>;
  modeStartRef: RefObject<number>;
  lastIpcTimeRef: RefObject<number>;
  freqDataRef: RefObject<Uint8Array<ArrayBuffer> | null>;
  voiceBandRef: RefObject<{
    startBin: number;
    endBin: number;
    levelDivisor: number;
  }>;
  queueRef: RefObject<Promise<TranscribeResult>[]>;
  drainingRef: RefObject<boolean>;
  streamResolverRef: RefObject<((r: TranscribeResult) => void) | null>;
  drainAgainRef: RefObject<boolean>;
  pendingReRecordRef: RefObject<boolean>;
}
