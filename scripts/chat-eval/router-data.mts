// router-data.mts: the router prompts, the plan table (spec 2.3 stage 2), the
// rules router (arm A3) and the extra multilingual intent items. The 7 UI
// languages are de, en, es, fr, it, ja, pt (AGENTS.md, "UI conventions").
// Honesty note: the rules were written by the author who had seen the gold
// questions in EN and PT, so the rules arm is an upper bound for new phrasings.
// The five other languages are scored on 44 items written after the rules.

import { existsSync, readFileSync } from "node:fs";
import type { Intent, Lang } from "./types.mts";

export interface RouterItem {
  id: string;
  lang: string;
  text: string;
  intent: Intent;
}

/**
 * Intent labels follow what E2B says (owner decision 2026-10-31, P0 report
 * section 9 point 6): "When is X?" is temporal and "Who will do X?" is
 * who_said. Only a question labelled lookup is relabelled. Gold questions and
 * the blind set use this one rule.
 */
export function relabelIntent(text: string, intent: Intent): Intent {
  if (intent !== "lookup") return intent;
  if (/\b(who will|quem vai)\b/i.test(text)) return "who_said";
  if (/\b(when|quando|para quando)\b/i.test(text)) return "temporal";
  return intent;
}

const X: Record<string, string[]> = {
  // lookup, who_said, aggregate, temporal, review, status, write, other
  de: [
    "Wie viel kostet das Angebot für den Speicher-Cluster?",
    "Wer hat den Pilotversuch vorgeschlagen?",
    "Liste die offenen Aufgaben von Ana auf.",
    "Welche Meetings hatten wir letzte Woche?",
    "Zeig mir alle Entscheidungen im Projekt Atlas.",
    "Wie ist der Stand beim Projekt Atlas?",
    "Markiere die Aufgabe „Rollback-Plan schreiben“ als erledigt.",
    "Hallo, was kannst du alles?",
  ],
  es: [
    "¿Cuánto costó la cotización del clúster de almacenamiento?",
    "¿Quién propuso el piloto?",
    "Lista las tareas abiertas de Ana.",
    "¿Qué reuniones tuvimos la semana pasada?",
    "Muéstrame todas las decisiones del proyecto Atlas.",
    "¿Cómo vamos con el proyecto Atlas?",
    "Marca la tarea «escribir el plan de rollback» como hecha.",
    "Hola, ¿qué puedes hacer?",
  ],
  fr: [
    "Combien coûte le devis pour le cluster de stockage ?",
    "Qui a proposé le pilote ?",
    "Liste les tâches ouvertes d'Ana.",
    "Quelles réunions avons-nous eues la semaine dernière ?",
    "Montre-moi toutes les décisions du projet Atlas.",
    "Où en est le projet Atlas ?",
    "Marque la tâche « écrire le plan de rollback » comme terminée.",
    "Bonjour, que sais-tu faire ?",
  ],
  it: [
    "Quanto costa il preventivo per il cluster di archiviazione?",
    "Chi ha proposto il pilota?",
    "Elenca le attività aperte di Ana.",
    "Quali riunioni abbiamo avuto la settimana scorsa?",
    "Mostrami tutte le decisioni del progetto Atlas.",
    "A che punto siamo con il progetto Atlas?",
    "Segna l'attività «scrivere il piano di rollback» come completata.",
    "Ciao, cosa sai fare?",
  ],
  ja: [
    "ストレージクラスターの見積もりはいくらでしたか？",
    "パイロットを提案したのは誰ですか？",
    "Anaの未完了のタスクを一覧にしてください。",
    "先週どの会議がありましたか？",
    "Atlasプロジェクトの決定事項をすべて見せてください。",
    "Atlasプロジェクトの進捗はどうですか？",
    "「ロールバック計画を書く」タスクを完了にしてください。",
    "こんにちは、何ができますか？",
  ],
};
const ORDER: Intent[] = [
  "lookup",
  "who_said",
  "aggregate",
  "temporal",
  "review",
  "status",
  "write",
  "other",
];

/** The blind held-out set (written by an agent that did not see the rules or the prompts). */
export function heldoutRouterItems(): RouterItem[] {
  const file = new URL("./router-heldout.json", import.meta.url);
  if (!existsSync(file)) return [];
  const rows = JSON.parse(readFileSync(file, "utf8")) as {
    id: string;
    lang: string;
    intent: Intent;
    text: string;
  }[];
  return rows.map((r) => ({
    id: `h-${r.id}`,
    lang: r.lang,
    text: r.text,
    intent: relabelIntent(r.text, r.intent),
  }));
}

export function extraRouterItems(): RouterItem[] {
  const out: RouterItem[] = [];
  for (const [lang, qs] of Object.entries(X)) {
    qs.forEach((text, i) =>
      out.push({
        id: `x-${lang}-${i}`,
        lang,
        text,
        intent: ORDER[i] as Intent,
      }),
    );
  }
  const other: [string, string][] = [
    ["en", "Hello, what can you do?"],
    ["en", "Thanks, that is all."],
    ["pt", "Olá, o que você sabe fazer?"],
    ["pt", "Obrigado, é só isso."],
  ];
  other.forEach(([lang, text], i) =>
    out.push({ id: `x-${lang}-o${i}`, lang, text, intent: "other" }),
  );
  return out;
}

// --- Prompts ---------------------------------------------------------------

const INTENT_LINES_EN = `lookup: one fact. "How much was the vendor quote?" "When is the launch?"
who_said: who said or proposed something. "Who proposed the pilot?"
aggregate: lists or counts. "List the open action items for Ana." "How many meetings did we have?"
temporal: meetings by date. "Which meetings did we have last week?"
review: all decisions or open questions. "Show all decisions."
status: where a project stands. "Where do we stand on Atlas?"
write: change data (done, tag, move, merge). "Mark the task as done."
other: greeting or not about meetings. "Hello!"`;

const INTENT_LINES_ML = `lookup: one fact. "Quanto custou a cotação?" "Wann ist der Start?"
who_said: who said or proposed something. "¿Quién propuso el piloto?" "Qui a dit cela ?"
aggregate: lists or counts. "Liste os itens em aberto." "Quante riunioni abbiamo avuto?"
temporal: meetings by date. "Welche Meetings hatten wir letzte Woche?" "先週の会議は？"
review: all decisions or open questions. "Mostre todas as decisões." "Show all open questions."
status: where a project stands. "Em que pé estamos com o Atlas?" "¿Cómo vamos con Atlas?"
write: change data (done, tag, move, merge). "Marque como concluída." "Marque la tarea como hecha."
other: greeting or not about meetings. "Olá!" "Hello!"`;

export type RouterPrompt = "en" | "ml" | "v2";
/**
 * v2 (written after the first run, using only the even gold questions for the
 * wording): it says what separates lookup from review, temporal and who_said.
 */
const INTENT_LINES_V2 = `lookup: asks for ONE specific fact: an amount, a date, a number, a name, or what was decided about one topic. "When is the launch?" "What did we decide on the database?"
who_said: asks WHO said, proposed, approved or owns something. "Who proposed the pilot?"
aggregate: asks for a list of items or a count. "List the open tasks of Ana." "How many meetings did we have?"
temporal: asks WHICH meetings happened in a time range. "Which meetings did we have last week?"
review: asks to show ALL decisions or ALL open questions of a project. "Show all decisions."
status: asks where a project stands. "Where do we stand on Atlas?"
write: asks you to change data: mark done, reopen, tag, move, merge. "Mark the task as done."
other: a greeting, thanks, or not about the meetings. "Hello!"`;

export function routerSystem(kind: RouterPrompt): string {
  if (kind === "v2")
    return `You route a user question about meeting notes. Answer with exactly one intent. The question can be in any language.\n${INTENT_LINES_V2}`;
  return `You route a user question about meeting notes. Answer with exactly one intent. The question can be in any language.\n${kind === "en" ? INTENT_LINES_EN : INTENT_LINES_ML}`;
}

export const ROUTER_SCHEMA = {
  type: "object",
  required: ["intent"],
  additionalProperties: false,
  properties: {
    intent: {
      enum: [
        "lookup",
        "who_said",
        "aggregate",
        "temporal",
        "review",
        "status",
        "write",
        "other",
      ],
    },
  },
} as const;

// --- Plan table (spec 2.3, stage 2) -----------------------------------------------------

/** The tools of the plan for an intent. `other` acts as lookup (stage 1 default). */
export function planFor(intent: Intent): string[] {
  switch (intent) {
    case "who_said":
      return ["search_chunks", "get_transcript_window"];
    case "aggregate":
      return ["list_people", "list_action_items", "list_meetings"];
    case "temporal":
      return ["list_meetings", "get_meeting_summary"];
    case "review":
      return ["list_decisions_questions", "list_action_items"];
    case "status":
      return ["folder_status"];
    case "write":
      return ["list_action_items", "propose_action_item_change"];
    default:
      return ["search_chunks", "get_meeting_summary"];
  }
}

// --- Rules router (arm A3) ----------------------------------------------------------------

const R = (s: string) => new RegExp(s, "iu");
const RULES: [Intent, RegExp][] = [
  [
    "write",
    R(
      "\\b(mark|tag|move|merge|reopen|close|rename|marque|mova|una|reabra|feche|marca|marcar|mueve|fusiona|reabre|markiere|verschiebe|markiere|marque|déplace|fusionne|segna|sposta|unisci)\\b|完了にして|移動|統合",
    ),
  ],
  [
    "status",
    R(
      "(where do we stand|status of|how is .* going|em que p[eé] estamos|como est[aá] o|c[oó]mo vamos|wie ist der stand|o[uù] en est|a che punto|進捗)",
    ),
  ],
  [
    "who_said",
    R(
      "\\b(who (said|proposed|suggested|signed off|approved|mentioned)|what did \\w+ say|quem (disse|prop[oô]s|aprovou|falou)|qui a |wer hat|qui[eé]n (dijo|propuso)|chi ha )|誰",
    ),
  ],
  [
    "review",
    R(
      "(all (the )?decisions|open questions|decis[oõ]es|perguntas (ainda )?em aberto|decisiones|offene fragen|entscheidungen|questions ouvertes|décisions|decisioni|決定事項)",
    ),
  ],
  [
    "temporal",
    R(
      "(which meetings|what meetings|last week|last month|this month|meeting (on|of)|quais reuni[oõ]es|semana passada|m[eê]s passado|neste m[eê]s|qu[eé] reuniones|semana pasada|welche meetings|letzte woche|quelles r[eé]unions|semaine derni[eè]re|quali riunioni|settimana scorsa|先週|reuni[aã]o de |na reuni[aã]o)",
    ),
  ],
  [
    "aggregate",
    R(
      "(\\blist\\b|how many|open action items|itens de a[cç][aã]o|quantas|quantos|liste|cu[aá]ntas|lista |wie viele|liste |combien|quante|elenca|未完了|一覧)",
    ),
  ],
  [
    "other",
    R(
      "^(hello|hi|hey|thanks|thank you|ol[aá]|obrigad|hola|gracias|hallo|bonjour|merci|ciao|grazie|こんにちは)\\b",
    ),
  ],
];
export function rulesRoute(text: string): Intent {
  for (const [intent, re] of RULES) if (re.test(text)) return intent;
  return "lookup";
}

export const LANG_LABEL: Record<Lang, string> = {
  en: "English",
  pt: "Portuguese",
};
