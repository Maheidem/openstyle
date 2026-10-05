/**
 * Which speech model families a custom MLX model may use
 * (specs/custom-mlx-models.md section 4).
 *
 * The server must know before the download which families the frozen worker
 * can load. So the answer lives here as a static allowlist. `resolveSttFamily`
 * ports the way mlx-audio 0.5.7 picks a family (`utils.py` `base_load_model`
 * and `get_model_class`, `stt/utils.py` `load_model`), including the rule that
 * a part of the repo name can override `model_type` from `config.json`.
 */

/**
 * The `MLX_WORKER_BUILD_SPEC` value (`runtime.ts`) that this file was reviewed
 * against. A unit test fails when the two differ. A worker upgrade then forces
 * a human to check the allowlist and the tables below again.
 */
export const FAMILIES_FOR_WORKER_SPEC =
  "pyinstaller=6.22.3;mlx-audio=0.5.7;mlx=0.32.3;mlx-metal=0.32.3;huggingface_hub=1.33.0;transformers>=5.14;bundle=onedir";

/**
 * A file that a family needs next to its weights. A plain name must be in the
 * repo. A list means that any one of its names is enough.
 */
type RequiredFile = string | readonly string[];

interface SttFamilyDef {
  family: string;
  displayName: string;
  /**
   * Top-level files that the load hook of the family reads
   * (`post_load_hook` in mlx-audio 0.5.7, checked on 2026-10-04). A repo that
   * lacks one loads without error, or fails at the first transcription. The
   * files that `config.json` replaces are not listed.
   */
  requiredFiles: readonly RequiredFile[];
}

/**
 * v1 allowlist: worker key to the curated family spelling. A family enters
 * this list only after its smoke test passes in the frozen worker.
 */
export const SUPPORTED_STT_FAMILIES: Record<string, SttFamilyDef> = {
  // `AutoTokenizer` and `WhisperFeatureExtractor` load in the hook. A missing
  // file fails the load, or leaves the text as chat-template tokens only
  // (tested with Qwen3-ASR-0.6B-5bit). The curated repos have no tokenizer.json.
  qwen3_asr: {
    family: "qwen3-asr",
    displayName: "Qwen3-ASR",
    requiredFiles: [
      "preprocessor_config.json",
      "tokenizer_config.json",
      "vocab.json",
      "merges.txt",
    ],
  },
  // Without a tokenizer file the text is a list of token ids.
  sensevoice: {
    family: "sensevoice",
    displayName: "SenseVoice",
    requiredFiles: [["chn_jpn_yue_eng_ko_spectok.bpe.model", "tokens.json"]],
  },
  // The vocabulary is in `config.json`.
  parakeet: { family: "parakeet", displayName: "Parakeet", requiredFiles: [] },
  // The hook calls `WhisperProcessor.from_pretrained` inside a `try`. When it
  // fails, the load works and every transcription fails with "Processor not
  // found". Tested with whisper-tiny-asr-fp16: with preprocessor_config.json
  // and no tokenizer.json, the transcription fails or gives wrong text, even
  // with vocab.json and merges.txt. Repos in the mlx-whisper layout (config.json
  // and weights only) have neither file.
  whisper: {
    family: "whisper",
    displayName: "Whisper",
    requiredFiles: ["preprocessor_config.json", "tokenizer.json"],
  },
};

/**
 * The required files of a family that the repo does not have. An empty list
 * means the repo is complete. A group of alternatives shows as `a or b`.
 */
export function missingFamilyFiles(
  def: SttFamilyDef,
  paths: readonly string[],
): string[] {
  const present = new Set(paths);
  return def.requiredFiles.flatMap((need) => {
    const names = typeof need === "string" ? [need] : need;
    return names.some((name) => present.has(name)) ? [] : [names.join(" or ")];
  });
}

/** Families that load but do not transcribe speech. Checked before the allowlist. */
const NOT_TRANSCRIBER_FAMILIES = new Set(["moss_music", "phonon"]);

/**
 * `Qwen3-ForcedAligner` has `model_type: qwen3_asr`, but it aligns text and
 * does not transcribe. Its `config.json` has `timestamp_token_id`. The ASR
 * config does not.
 */
export function isNotTranscriber(
  family: string | null,
  config: Record<string, unknown>,
  repoName: string,
): boolean {
  return (
    (family !== null && NOT_TRANSCRIBER_FAMILIES.has(family)) ||
    "timestamp_token_id" in config ||
    repoName.toLowerCase().includes("aligner")
  );
}

// Snapshot of mlx-audio 0.5.7. `STT_MODEL_DIRS` holds the dir names in
// `stt/models`. `STT_MODEL_REMAPPING` is `MODEL_REMAPPING` in `stt/utils.py`.
// The name scan needs both, because a name part that is a remapping key ends
// the scan. They only route the scan. `SUPPORTED_STT_FAMILIES` stays the gate.
const STT_MODEL_DIRS = new Set([
  "canary",
  "cohere_asr",
  "fireredasr2",
  "fun_asr_nano",
  "glmasr",
  "granite_speech",
  "granite_speech5_ctc",
  "granite_speech_nar",
  "higgs_audio_3",
  "lasr_ctc",
  "mega_asr",
  "mms",
  "moonshine",
  "moss_music",
  "moss_transcribe_diarize",
  "nemo",
  "nemotron_asr",
  "parakeet",
  "phonon",
  "qwen2_audio",
  "qwen3_asr",
  "qwen3_forced_aligner",
  "sensevoice",
  "vibevoice_asr",
  "voxtral",
  "voxtral_realtime",
  "wav2vec",
  "whisper",
]);

const STT_MODEL_REMAPPING = new Map([
  ["parakeet", "parakeet"],
  ["parakeet_tdt", "parakeet"],
  ["cohere_asr", "cohere_asr"],
  ["fireredasr2", "fireredasr2"],
  ["glm", "glmasr"],
  ["sensevoice", "sensevoice"],
  ["voxtral", "voxtral"],
  ["voxtral_realtime", "voxtral_realtime"],
  ["vibevoice", "vibevoice_asr"],
  ["qwen3_asr", "qwen3_asr"],
  ["phonon", "phonon"],
  ["moss_transcribe_diarize", "moss_transcribe_diarize"],
  ["fun_asr_nano", "fun_asr_nano"],
  ["canary", "canary"],
  ["moonshine", "moonshine"],
  ["mms", "mms"],
  ["granite_speech", "granite_speech"],
  ["granite_speech5_ctc", "granite_speech5_ctc"],
  ["granite_speech_nar", "granite_speech_nar"],
  ["qwen2_audio", "qwen2_audio"],
  ["mega_asr", "mega_asr"],
  ["higgs_audio_3", "higgs_audio_3"],
  ["moss_music", "moss_music"],
]);

const PHONON_CONFIG_SCHEMA = "fermion.phonon/1";

/** Port of `get_model_name_parts` for a repo name (`utils.py`). */
function modelNameParts(repoName: string): string[] {
  const name = repoName.toLowerCase().split("/").at(-1) ?? "";
  const dashParts = name.split("-").filter(Boolean);
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (part: string): void => {
    if (part && !seen.has(part)) {
      parts.push(part);
      seen.add(part);
    }
  };

  for (const part of dashParts) {
    if (seen.has(part)) continue;
    add(part);
    if (part.includes("_")) {
      for (const sub of part.split("_")) add(sub);
    }
    add(part.replace(/[^a-z0-9]+/g, ""));
  }

  for (let start = 0; start < dashParts.length; start++) {
    for (let end = start + 2; end <= dashParts.length; end++) {
      const segment = dashParts.slice(start, end);
      add(segment.join("_"));
      add(segment.join(""));
    }
  }
  return parts;
}

/** Port of `model_type_from_config` (`registry.py`). */
function modelTypeFromConfig(config: Record<string, unknown>): string | null {
  const type = str(config.model_type) || str(config.architecture);
  const mimoKeys = [
    "speech_vocab_size",
    "speech_zeroemb_idx",
    "input_local_layers",
    "local_layers",
    "group_size",
    "audio_channels",
    "delay_pattern",
  ];
  const architectures = Array.isArray(config.architectures)
    ? config.architectures
    : [];
  if (
    (type === null || type === "qwen2" || type === "mimo_audio") &&
    (architectures.includes("MiMoAudioModel") ||
      mimoKeys.every((key) => key in config))
  ) {
    return "mimo_audio";
  }
  return type;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * The worker key that mlx-audio 0.5.7 would load for this repo, or `null`.
 * The key may name a family the worker cannot load. The caller checks it
 * against `SUPPORTED_STT_FAMILIES`.
 */
export function resolveSttFamily(
  config: Record<string, unknown>,
  repoName: string,
): string | null {
  const nameParts = modelNameParts(repoName);

  // stt/utils.py load_model: the HF alias parakeet_tdt, and Phonon configs.
  let modelType: string | null;
  if (config.model_type === "parakeet_tdt") modelType = "parakeet";
  else if (config.config_schema === PHONON_CONFIG_SCHEMA) modelType = "phonon";
  else {
    // utils.py base_load_model
    modelType = modelTypeFromConfig(config);
    modelType ??= nameParts[0]?.toLowerCase() ?? null;
    if (modelType === "llama" && "acoustic_dim" in config) modelType = "tada";
  }
  if (modelType === null) return null;

  // utils.py get_model_class
  const mapped = STT_MODEL_REMAPPING.get(modelType) ?? null;
  if (mapped !== modelType) {
    for (const part of nameParts) {
      if (STT_MODEL_DIRS.has(part)) modelType = part;
      const remapped = STT_MODEL_REMAPPING.get(part);
      if (remapped !== undefined) {
        modelType = remapped;
        break;
      }
    }
  }
  return modelType;
}
