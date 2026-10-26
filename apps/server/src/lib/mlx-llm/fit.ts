import { totalmem } from "node:os";
import { GIB } from "./constants.js";

// The fit label of a built-in LLM on this Mac (specs/llm-runtime-tuning.md
// section 5). The owner approved the formula and its constants on
// 2026-10-26 (section 9 item 2). The constants are not measured.

/** "Runs well", "Tight fit" or "Won't fit" in the Models page. */
export type MlxLlmFitLabel = "runs_well" | "tight" | "wont_fit";

export interface MlxLlmFit {
  label: MlxLlmFitLabel;
  /** The owner rule raised the label: the formula says "Won't fit". */
  raised: boolean;
  /** P(model): the MLX peak of the model (section 5.1). */
  peakBytes: number;
  /** Total RAM of this Mac (`hw.memsize`). */
  ramBytes: number;
  /** RAM minus the OS reserve, the app and the ASR worker. */
  budgetBytes: number;
  /** The GPU cap from the worker, or null before the first worker start. */
  gpuCapBytes: number | null;
}

/** RSS of the app processes (section 2). */
const APP_BYTES = 1.65 * GIB;
/** RSS of the local ASR worker (section 4.7). */
const ASR_BYTES = 2.56 * GIB;
const RUNS_WELL_BUDGET_SHARE = 0.8;
const RUNS_WELL_GPU_SHARE = 0.9;

/** The OS reserve: 3 GiB when RAM <= 16 GiB, else 4 GiB (UNVERIFIED). */
function reserveBytes(ramBytes: number): number {
  return ramBytes <= 16 * GIB ? 3 * GIB : 4 * GIB;
}

export interface MlxLlmFitInput {
  peakBytes: number;
  ramBytes: number;
  gpuCapBytes: number | null;
  /** A local ASR model is selected, so its worker uses memory too. */
  localAsr: boolean;
  /** Owner rule: this model is never "Won't fit" (Gemma 4 E2B). */
  neverWontFit: boolean;
}

/**
 * The formula of section 5.1. Without a GPU cap (no worker start yet), the
 * label uses the budget rule only.
 */
export function computeMlxLlmFit(input: MlxLlmFitInput): MlxLlmFit {
  const { peakBytes, ramBytes, gpuCapBytes } = input;
  const budgetBytes =
    ramBytes -
    reserveBytes(ramBytes) -
    APP_BYTES -
    (input.localAsr ? ASR_BYTES : 0);
  const gpuOk = (share: number): boolean =>
    gpuCapBytes == null || peakBytes <= share * gpuCapBytes;

  let label: MlxLlmFitLabel = "wont_fit";
  if (
    peakBytes <= RUNS_WELL_BUDGET_SHARE * budgetBytes &&
    gpuOk(RUNS_WELL_GPU_SHARE)
  ) {
    label = "runs_well";
  } else if (peakBytes <= budgetBytes && gpuOk(1)) {
    label = "tight";
  }
  const raised = label === "wont_fit" && input.neverWontFit;
  return {
    label: raised ? "tight" : label,
    raised,
    peakBytes,
    ramBytes,
    budgetBytes,
    gpuCapBytes,
  };
}

/** A positive number of GiB from the environment, as bytes, or null. */
function envGibBytes(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * GIB) : null;
}

/**
 * Total RAM and GPU cap for the fit label.
 *
 * TRUSTED-OPERATOR-ONLY escape hatch, same class as OPENSTYLE_MLX_LLM_WORKER:
 * OPENSTYLE_MLX_LLM_FIT_RAM_GIB and OPENSTYLE_MLX_LLM_FIT_GPU_CAP_GIB simulate
 * another Mac in tests and isolated proofs. Never set them from untrusted
 * input. With a RAM override and no GPU cap override, the GPU cap of the
 * real worker does not apply, so the label uses the budget rule only.
 */
export function fitMachine(workerGpuCapBytes: number | null): {
  ramBytes: number;
  gpuCapBytes: number | null;
} {
  const ramOverride = envGibBytes("OPENSTYLE_MLX_LLM_FIT_RAM_GIB");
  const gpuOverride = envGibBytes("OPENSTYLE_MLX_LLM_FIT_GPU_CAP_GIB");
  return {
    ramBytes: ramOverride ?? totalmem(),
    gpuCapBytes:
      gpuOverride ?? (ramOverride == null ? workerGpuCapBytes : null),
  };
}
