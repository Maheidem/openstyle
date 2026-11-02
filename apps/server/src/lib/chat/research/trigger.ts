import type { ChatMessage } from "@openstyle/validations";
import {
  asksForCount,
  asksOverview,
  asksSynthesis,
  isDependentFollowUp,
  mentionPhrase,
} from "../plan.js";
import { looksLikeWrite } from "../prompts.js";

// When the research mode runs (specs/meeting-chat-agent.md 11.9.9). Code
// decides, with no model call. A question that needs digging has a digging
// word ("why", "blocked", "still open", "what changed", "who pushed") or it is
// a follow-up that asks for a reason after a list or a cited answer. A single
// fact ("who", "when", "how much") stays on the fast path.

const fold = (q: string): string =>
  q
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

/** Digging words in the 7 UI languages (accents are folded). */
const DIG_RE = new RegExp(
  [
    // en
    "\\b(?:why|because|reasons?|blocked|blockers?|blocking|unresolved|outstanding|pending|evolve[ds]?|evolution)\\b",
    "\\bstill open\\b",
    "\\bopen (?:items?|issues?|questions?|actions?|points?)\\b",
    "\\b(?:what|which)(?:'s| is| are) (?:still )?open\\b",
    "\\bwhat (?:has )?changed\\b",
    "\\bchanged between\\b",
    "\\bhow did .{1,60} (?:change|evolve|develop)\\b",
    "\\bwho (?:pushed|argued|objected|defended|insisted|opposed|drove)\\b",
    "\\bpush(?:ed|ing)? for\\b",
    "\\bwho (?:wanted|asked for|demanded)\\b",
    "\\b(?:stopping|holding up|held back|holds? back|delay(?:s|ed|ing)?|prevent(?:s|ed|ing)?)\\b",
    "\\b(?:nobody|no one) can answer\\b",
    "\\bnot (?:finished|done|settled|resolved|decided) yet\\b",
    "\\b(?:is|are) .{1,60} (?:settled|resolved)\\b",
    "\\b(?:differences?|different|compare[sd]?|comparison) .{0,60}\\b(?:between|first|last|start|end)\\b",
    "\\bwalk me through how\\b",
    "\\bhow did .{1,80} (?:move|shift|go)\\b",
    "\\bwhat(?:'s| is) left\\b",
    "\\bleft to do\\b",
    // pt
    "\\b(?:por ?que|porque|motivos?|razao|razoes|bloque(?:ou|io|ios|ado|ada|ando)|pendentes?|sem resolver|nao resolvid[oa]s?|nao foi decidid[oa])\\b",
    "\\bem aberto\\b",
    "\\bo que mudou\\b",
    "\\b(?:como|quando) .{1,60} mudou\\b",
    "\\bquem (?:defendeu|insistiu|se opos|empurrou)\\b",
    "\\bevolu(?:iu|cao)\\b",
    "\\b(?:atras(?:ou|ado|ada|ar)|segur(?:ou)|trav(?:ou|ado|ada)|impedi(?:u|ndo)|sem solucao|ja foi resolvid[oa]|ainda .{0,20}(?:aberto|resolvid))\\b",
    "\\bquem (?:queria|pediu)\\b",
    "\\b(?:diferenca|diferencas) entre\\b",
    // es
    "\\b(?:por que|porque|motivos?|razon|razones|bloque(?:o|ado|ada|os)|pendientes?|sin resolver|irresuelt[oa]s?)\\b",
    "\\b(?:abiert[oa]s?|en curso)\\b",
    "\\bque cambio\\b",
    "\\bquien (?:defendio|insistio|empujo)\\b",
    "\\bevoluc(?:iono|ion)\\b",
    // fr
    "\\b(?:pourquoi|parce que|raisons?|bloqu(?:e|ee|es|ant)|blocages?|en suspens|en attente|non resolu[es]?|ouverts?)\\b",
    "\\bce qui a change\\b",
    "\\bqui a (?:pousse|defendu|insiste)\\b",
    "\\bevolue[rz]?\\b",
    // de
    "\\b(?:warum|weshalb|wieso|grund|gruende|blockiert|blockade|offen(?:e|en)?|ungeloest|ausstehend|entwickelt)\\b",
    "\\bwas hat sich (?:geaendert|veraendert)\\b",
    "\\bwer hat (?:gedraengt|argumentiert|sich dafuer)\\b",
    // it
    "\\b(?:perche|motivi?|ragioni?|bloccat[oaie]|bloccante|apert[oaie]|in sospeso|irrisolt[oaie])\\b",
    "\\bcosa (?:e|si e) cambiato\\b",
    "\\bchi ha (?:spinto|difeso|insistito)\\b",
    "\\bevolut[oa]\\b",
  ].join("|"),
  "u",
);

const DIG_JA_RE =
  /なぜ|どうして|理由|ブロック|未解決|未完了|オープン|何が変わ|どう変わ|誰が.*(?:主張|推進|反対)/u;

/** A reason word, for the follow-up that asks "why are they open?". */
const REASON_RE = new RegExp(
  [
    "\\b(?:why|because|reasons?|blocked|blocking|blockers?)\\b",
    "\\b(?:por ?que|porque|motivos?|razao|razoes|bloque\\w*)\\b",
    "\\b(?:pourquoi|raisons?|bloqu\\w*)\\b",
    "\\b(?:warum|weshalb|wieso|grund|gruende|blockier\\w*)\\b",
    "\\b(?:perche|motivi?|ragioni?|blocc\\w*)\\b",
  ].join("|"),
  "u",
);
const REASON_JA_RE = /なぜ|どうして|理由|ブロック/u;

/** "Who pushed for X", "what changed", "how did X evolve": the workers read one meeting each. */
const FAN_RE = new RegExp(
  [
    "\\bwho (?:pushed|argued|insisted|wanted|asked for|drove|defended|opposed|objected|demanded)\\b",
    "\\bpush(?:ed|ing)? for\\b",
    "\\bwhat (?:has )?changed\\b",
    "\\bchanged between\\b",
    "\\bhow did .{1,80} (?:change|evolve|move|shift|develop)\\b",
    "\\b(?:differences?|different) between\\b",
    "\\bwalk me through how\\b",
    "\\bevolve[ds]?\\b",
    "\\b(?:blocked|blockers?|blocking|held back|holding up|stopping|delayed|delay)\\b",
    "\\bwhy (?:was|were|is|are|did|has|have)\\b",
    "\\b(?:atras(?:ou|ado|ada)|bloque(?:ou|io|ado|ada)|segurou|travou|impediu)\\b",
    "\\bpor ?que\\b",
    "\\bquem (?:defendeu|insistiu|queria|pediu|empurrou)\\b",
    "\\bo que mudou\\b",
    "\\b(?:como|quando) .{1,80} mudou\\b",
    "\\bquien (?:defendio|insistio|queria|propuso|pidio)\\b",
    "\\bque cambio\\b",
    "\\bqui a (?:pousse|defendu|insiste|voulu|propose)\\b",
    "\\bce qui a change\\b",
    "\\bwer hat (?:gedraengt|argumentiert|darauf bestanden|vorgeschlagen)\\b",
    "\\bwas hat sich (?:geaendert|veraendert)\\b",
    "\\bchi ha (?:spinto|difeso|insistito|voluto|proposto)\\b",
    "\\bcosa (?:e|si e) cambiato\\b",
  ].join("|"),
  "u",
);

/** True when the question asks who pushed, or what changed: one worker for each meeting answers it. */
export function asksAcrossMeetings(question: string): boolean {
  return FAN_RE.test(fold(question));
}

export function hasDiggingWord(question: string): boolean {
  return DIG_RE.test(fold(question)) || DIG_JA_RE.test(question);
}

export function asksReason(question: string): boolean {
  return REASON_RE.test(fold(question)) || REASON_JA_RE.test(question);
}

/** True when the last answer has a list block or two or more cites. */
export function lastAnswerHasLeads(history: readonly ChatMessage[]): boolean {
  const last = history.findLast((m) => m.role === "assistant");
  if (!last) return false;
  return last.blocks.some((b) => b.kind === "list") || last.cites.length >= 2;
}

/** An explicit list command ("List all open action items for Ana"): the list path answers it. */
const LIST_CMD_RE =
  /^\s*(?:list|liste|listar|lista|show|display|mostre|mostrar|muestra|muestre|zeige|montre|mostra|elenca)\b|^\s*一覧/iu;

export function researchTrigger(a: {
  question: string;
  history: readonly ChatMessage[];
  enabled: boolean;
}): boolean {
  if (!a.enabled) return false;
  const q = a.question;
  if (looksLikeWrite(q) || asksForCount(q) || mentionPhrase(q) !== null) {
    return false;
  }
  if (LIST_CMD_RE.test(q)) return false;
  // A broad question keeps the synthesis path (11.7, 11.8 B).
  if (asksSynthesis(q) || asksOverview(q)) return false;
  if (hasDiggingWord(q)) return true;
  return (
    isDependentFollowUp(q) && asksReason(q) && lastAnswerHasLeads(a.history)
  );
}
