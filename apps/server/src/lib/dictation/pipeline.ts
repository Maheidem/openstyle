// The staged dictation cleanup (specs/dictation-pipeline.md 4.1). A plain
// async chain of stage functions, not a LangGraph run: dictation is on the hot
// path and is never resumed.
//
//   S1 line commands -> S2 counted lists -> S3 contact info -> S4 numbers (code)
//   -> S5 cleanup LLM (medium and high; low: light format in code)
//   -> S6 polish LLM (high) -> S7 tone LLM (tone on)
//   -> S8 list markers (high) -> S9 fragments (code)
//
// The dictionary runs after this, in post-process.ts. A stage never throws: on
// a fault it gives back its input (the cleanup stage gives the light format).

import { lostTokens } from "./guard.js";
import { type DictationLang, resolveDictationLanguage } from "./language.js";
import {
  cleanupStagePrompt,
  polishStagePrompt,
  type StagePrompt,
  toneStagePrompt,
} from "./prompts.js";
import { contactInfo } from "./stages/contact.js";
import {
  contactEnd,
  fragments,
  lightFormat,
  listMarkers,
} from "./stages/layout.js";
import { spokenNumbers } from "./stages/numbers.js";
import {
  formatCountedList,
  joinParts,
  splitCountedList,
  splitLineCommands,
} from "./stages/structure.js";

export type DictationIntensity = "low" | "medium" | "high";
export type LlmStage = "cleanup" | "polish" | "tone";

export interface StageCall {
  stage: LlmStage;
  /** The text the stage edits. */
  input: string;
  /** The prompt of a text (the context guard builds one per piece). */
  build: (text: string) => StagePrompt;
}

/** text null: the call failed or gave nothing usable. */
export interface StageAnswer {
  text: string | null;
}

/** One LLM call. It never throws (post-process.ts and the bench build it). */
export type StageLlm = (call: StageCall) => Promise<StageAnswer>;

export interface DictationPipelineInput {
  /** The raw transcript, after sanitizeTranscriptText. */
  raw: string;
  intensity: DictationIntensity;
  /** The tone stage text, or null when the tone is off. */
  tone: { block: string; tail: string } | null;
  /** The configured dictation languages (empty: auto). */
  languages: readonly string[];
}

export interface StageTrace {
  stage: LlmStage;
  ms: number;
  /** Why the stage gave back its input: "failed", or the lost tokens. */
  fellBack: string[] | null;
}

export interface DictationPipelineResult {
  text: string;
  /** The rule language of the code stages. */
  lang: DictationLang | null;
  /** The language list that the LLM stages got. */
  llmLanguages: string[];
  stages: StageTrace[];
}

/**
 * Run the stages on one dictation. `llm` null: no model (it did not start);
 * every LLM stage gives back its input.
 */
export async function runDictationPipeline(
  input: DictationPipelineInput,
  llm: StageLlm | null,
): Promise<DictationPipelineResult> {
  const { rules: lang, llm: llmLanguages } = resolveDictationLanguage(
    input.raw,
    input.languages,
  );
  const stages: StageTrace[] = [];

  const callStage = async (
    stage: LlmStage,
    build: (text: string) => StagePrompt,
    text: string,
  ): Promise<string | null> => {
    if (!llm) return null;
    const started = Date.now();
    const answer = await llm({ stage, input: text, build });
    const out = answer.text?.trim() ? answer.text.trim() : null;
    stages.push({
      stage,
      ms: Date.now() - started,
      fellBack: out === null ? ["failed"] : null,
    });
    return out;
  };

  /** S3 + S4 + S5 on one span of raw text. */
  const cleanSpan = async (span: string): Promise<string> => {
    const coded = spokenNumbers(contactInfo(span), lang);
    if (!coded.trim()) return "";
    if (input.intensity === "low") return lightFormat(coded, lang);
    const cleaned = await callStage(
      "cleanup",
      (t) => cleanupStagePrompt(t, llmLanguages),
      coded,
    );
    return cleaned ?? lightFormat(coded, lang);
  };

  // S1: line commands. S2: counted lists, per part.
  const { parts, seps } = splitLineCommands(input.raw, lang);
  const cleanedParts: string[] = [];
  for (const part of parts) {
    if (!part.trim()) {
      cleanedParts.push("");
      continue;
    }
    const list = splitCountedList(part, lang);
    if (!list) {
      cleanedParts.push(await cleanSpan(part));
      continue;
    }
    const lead = list.leadIn ? await cleanSpan(list.leadIn) : "";
    const items: string[] = [];
    for (const item of list.items) items.push(await cleanSpan(item));
    cleanedParts.push(formatCountedList(lead, items));
  }
  let text = joinParts(cleanedParts, seps);

  /** S6 and S7: an answer that loses a protected token gives back its input. */
  const guarded = async (
    stage: LlmStage,
    build: (text: string) => StagePrompt,
  ): Promise<string> => {
    const out = await callStage(stage, build, text);
    if (out === null) return text;
    const lost = lostTokens(text, out, lang);
    if (lost.length > 0) {
      const last = stages[stages.length - 1];
      if (last) last.fellBack = lost;
      return text;
    }
    return out;
  };

  if (text && input.intensity === "high") {
    text = await guarded("polish", (t) => polishStagePrompt(t, llmLanguages));
  }
  const tone = input.tone;
  if (text && tone) {
    text = await guarded("tone", (t) => toneStagePrompt(t, llmLanguages, tone));
  }
  if (input.intensity === "high") text = listMarkers(text, input.raw, lang);
  text = fragments(contactEnd(text), input.raw);
  return { text, lang, llmLanguages, stages };
}
