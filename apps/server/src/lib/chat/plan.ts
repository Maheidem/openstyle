import { z } from "zod";
import {
  type Choices,
  datesFromQuestion,
  hasDateArgs,
  parseToolArgs,
  QUERY_MAX_CHARS,
  queryFor,
  type ToolCall,
  type ToolName,
} from "./choices.js";
import { normalizeText } from "./cites.js";
import { asksForList } from "./prompts.js";
import type { Intent, TurnScope } from "./types.js";

// Stage 2 (plan) and the structured fallback of stage 2b (specs/
// meeting-chat-agent.md 2.3). Code only, except the slot schema that the
// pipeline gives to the model. Dates always come from code.

// ---------------------------------------------------------------------------
// Plan table
// ---------------------------------------------------------------------------

type ScopeKind = TurnScope["kind"];

/**
 * The tools of the plan for an intent and a scope (spec 2.3 stage 2). The
 * scope "all" uses the "A" column. `other` acts as `lookup`.
 * Differences from the table, on purpose:
 * - temporal in scope M adds `search_chunks`: `get_transcript_window` alone
 *   needs a time window that nobody has yet ("When is the cutover?").
 * - aggregate in scope F and A adds `list_meetings`, for "how many meetings".
 * - write lists the 4 propose tools, as the T1 arm of P0 showed them.
 */
export function planFor(intent: Intent, scopeKind: ScopeKind): ToolName[] {
  const m = scopeKind === "meeting";
  const f = scopeKind === "folder";
  switch (intent) {
    case "who_said":
      return ["search_chunks", "get_transcript_window"];
    case "aggregate":
      return m
        ? ["list_action_items", "search_chunks"]
        : [
            "list_action_items",
            "list_people",
            "list_meetings",
            "search_chunks",
          ];
    case "temporal":
      return m
        ? ["search_chunks", "get_transcript_window", "get_meeting_summary"]
        : ["list_meetings", "get_meeting_summary", "search_chunks"];
    case "review":
      return ["list_decisions_questions", "list_action_items"];
    case "status":
      return m
        ? ["get_meeting_summary"]
        : f
          ? ["folder_status"]
          : ["list_meetings", "list_action_items"];
    case "write":
      return [
        "propose_action_item_change",
        "propose_retag",
        "propose_move",
        "propose_merge_people",
      ];
    default:
      return m ? ["search_chunks", "get_meeting_summary"] : ["search_chunks"];
  }
}

// ---------------------------------------------------------------------------
// Question words
// ---------------------------------------------------------------------------

const COUNT_WORDS = [
  "how many",
  "number of",
  "quantas",
  "quantos",
  "quantidade de",
  "cuantos",
  "cuantas",
  "wie viele",
  "combien",
  "quanti",
  "quante",
];

/** True when the question asks for a count (EN, PT, ES, DE, FR, IT). */
export function asksForCount(question: string): boolean {
  const t = ` ${normalizeText(question)} `;
  return COUNT_WORDS.some((w) => t.includes(` ${w} `));
}

const HOW_MANY_MEETINGS =
  /\b(how many|quantas?|quantos|cuantas?|cuantos|wie viele|combien de|quant[ei]) (\w+ )?(meetings?|reunioes|reuniones|besprechungen|reunions|riunioni)\b/;
const MENTION_VERB =
  /\b(named|mentioned|cited|citad[ao]s?|mencionad[ao]s?|nombrad[ao]s?|erwahnt|cite[es]?|nomm[eé]e?s?|menzionat[ae]|nominat[ae])\b/;

/**
 * "In how many meetings was Kestrel Hosting named?" gives the name. Else null.
 * Only a count of meetings with a mention verb counts: "How many meetings do
 * we have in Atlas?" names a project, not a mention.
 */
export function mentionPhrase(question: string): string | null {
  const t = normalizeText(question);
  if (!HOW_MANY_MEETINGS.test(t) || !MENTION_VERB.test(t)) return null;
  const toks = question.match(/[\p{L}\p{N}][\p{L}\p{N}.&'-]*/gu) ?? [];
  let best: string[] = [];
  let run: string[] = [];
  toks.forEach((w, i) => {
    if (i > 0 && /^\p{Lu}/u.test(w)) run.push(w);
    else {
      if (run.length > best.length) best = run;
      run = [];
    }
  });
  if (run.length > best.length) best = run;
  const phrase = best.join(" ");
  return phrase.length >= 3 ? phrase : null;
}

/** "when" in the 7 UI languages. */
const WHEN_RE = /\b(when|quando|cuando|wann|quand)\b|いつ/u;
/** A question about the speaker: "who" or a verb of speech, in the 7 UI languages. */
const WHO_RE =
  /\b(who|whom|quem|qui|wer|wen|quien|chi|say|said|says|disse|dijo|dito|gesagt|sagt|dit|detto|diceva|von wem)\b|誰|だれ|言って|言った/u;

/**
 * Code corrects three habits of a small router (P1.1, #402; the gold labels
 * follow the same rules):
 * - a lookup that names a day is temporal ("What did we decide in the
 *   meeting on August 25?"),
 * - a temporal with no date and no "when" is a lookup ("What is the current
 *   date for the launch?"),
 * - who_said with no "who" word is a lookup ("And which company confirmed
 *   that?").
 */
export function refineIntent(
  question: string,
  intent: Intent,
  todayMs: number,
): Intent {
  const q = fold(question);
  switch (intent) {
    case "lookup":
      // A day with a number ("on August 25"); "yesterday" alone stays a lookup.
      return /\d/.test(question) &&
        datesFromQuestion(question, todayMs).date_from
        ? "temporal"
        : intent;
    case "temporal":
      return !datesFromQuestion(question, todayMs).date_from &&
        !WHEN_RE.test(q) &&
        !MEETING_WORDS.test(q)
        ? "lookup"
        : intent;
    case "who_said":
      return WHO_RE.test(q) ? intent : "lookup";
    default:
      return intent;
  }
}

const MEETING_WORDS =
  /\b(meetings?|reunioes|reuniao|reuniones?|besprechung\w*|reunions?|riunion[ei])\b/;
const QUESTION_WORDS =
  /\b(questions?|perguntas?|preguntas?|fragen?|domand[ae])\b|質問|疑問|未解決/u;
const DONE_WORDS =
  /\b(done|completed|closed|concluidas?|concluidos?|feitas?|terminad[ao]s?|hechas?|erledigt\w*|terminees?|completat[ae])\b/;
const REOPEN_WORDS =
  /\b(reopen|reabr\w*|reabre|reabrir|wieder\s+offnen|rouvr\w*|riapr\w*)\b/;

const fold = (t: string) =>
  t
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export interface SlotValues {
  query?: string | null;
  /** A person id from the choices, or "none". */
  person?: string | null;
  /** An item label A1..A8, or "none". */
  item?: string | null;
  /** A meeting label M1..M12, or "none". */
  meeting?: string | null;
  /** A folder id, or "none". */
  folder?: string | null;
  kind?: "decision" | "open_question" | null;
  change?: "action_item" | "retag" | "move" | "merge_people" | null;
  tag?: string | null;
}

/** An earlier turn, as far as the slots need it. */
export interface PriorTurn {
  question: string;
  answer: string;
}

const FIRST_RE =
  /\b(first|primeira|primeiro|primera|primero|erste[nr]?|premi[eè]re|premier|prima|primo)\b|最初/iu;
/** Short answers that describe no topic. */
const EMPTY_ANSWER = /^(gave no answer|found nothing)$/i;
/** The most turns back that a follow-up leans on. */
const MAX_CHAIN = 3;
/** The part of the earlier answer that joins the query, in characters. */
const ANSWER_HEAD_CHARS = 100;

/**
 * Words that point back to an earlier turn, in the 7 UI languages: "that",
 * "isso", "ele", "dies", "cela", "questo", "それ". A question that holds one of
 * them and is short has no topic of its own.
 */
const REFERENCE_RE =
  /\b(that|this|it|they|them|he|she|him|her|those|these|isso|isto|esse|essa|esses|essas|este|esta|aquilo|ele|ela|eles|elas|disso|dele|dela|eso|esto|ese|esa|ello|[eé]l|ella|ellos|das|dies|diese[rsnm]?|es|er|sie|ihn|ihm|ce|cela|[cç]a|ces|il|elle|ils|elles|questo|questa|quello|quella|lui|lei|loro)\b|それ|これ|その|この|あれ|彼/iu;
/** Words that ask for a reason or a speaker. They need a topic from the turn before. */
const DEPENDENT_WORD_RE =
  /\b(why|por\s*qu[eê]|porque|pourquoi|warum|perch[eé]|who|quem|qui[eé]n|qui|wer|chi)\b|なぜ|どうして|誰/iu;
/** A conjunction at the start of a question: "And when...", "But why...". */
const CONJUNCTION_START_RE =
  /^\s*(and|but|so|then|also|e|mas|ent[aã]o|y|pero|entonces|und|aber|dann|et|mais|alors|ma|quindi|e poi)\b/iu;
/** "this meeting" names the meeting. It points to no earlier turn. */
const THIS_MEETING_RE =
  /\b(this|that|esta|essa|esse|este|deste|desta|dessa|diese[rsn]?|cette|questa|questo)\s+(meeting|call|reuni[aã]o|reunion|reuni[oó]n|besprechung|r[eé]union|riunione)\b|この会議/giu;

const wordCount = (q: string) =>
  q
    .trim()
    .split(/[\s,;:.?!]+/u)
    .filter(Boolean).length;

/**
 * True when the question has no topic of its own and leans on the turn before
 * ("Why?", "And when is that due?", "Who said that?", "my first question").
 * Rules: 3 words or fewer; a conjunction first ("And when..."); a reference
 * word ("that", "isso") in 8 words or fewer; "why" or "who" in 4 words or fewer.
 * A question with its own topic ("What did we decide on the database
 * engine?") is a new topic: it must NOT search with the earlier turn (P1.2:
 * the old answer took over the query and the same chunk came back).
 */
export function isDependentFollowUp(question: string): boolean {
  const q = question.replace(THIS_MEETING_RE, " ").trim();
  if (FIRST_RE.test(q)) return true;
  const n = wordCount(q);
  const cjk = /[\u3040-\u30ff\u4e00-\u9fff]/u.test(q);
  const short = cjk ? q.length <= 14 : n <= 3;
  if (short) return true;
  if (CONJUNCTION_START_RE.test(q) && n <= 9) return true;
  const medium = cjk ? q.length <= 24 : n <= 8;
  if (medium && REFERENCE_RE.test(q)) return true;
  // "Why did we pick Postgres?" has a topic of its own. "Why is it so?" has not.
  const small = cjk ? q.length <= 14 : n <= 4;
  return small && DEPENDENT_WORD_RE.test(q);
}

/** "What was this meeting about?": the summary answers, not a search. */
const OVERVIEW_RE = new RegExp(
  [
    // en
    "what (?:was|is|were) (?:this|the|that) (?:meeting|call) (?:about|for)",
    "what (?:was|is) (?:this|the) (?:meeting|call)",
    "what did we (?:discuss|talk about|cover)",
    "(?:summary|summarize|summarise|overview|recap) (?:of )?(?:this|the) (?:meeting|call)",
    "(?:summary|summarize|summarise|overview|recap) (?:this|the) (?:meeting|call)",
    "tell me about this (?:meeting|call)",
    // pt (accents are folded)
    "sobre o que (?:foi|e|era) (?:esta|essa|a) reuniao",
    "(?:do|de) que (?:se )?(?:tratou|trata|foi|falou) (?:esta|essa|a) reuniao",
    "qual (?:foi|e) o assunto (?:desta|dessa|da) reuniao",
    "(?:resumo|resuma|resumir) (?:da|desta|dessa) reuniao",
    "o que (?:discutimos|conversamos|falamos)",
    // es
    "de que (?:trato|trata|fue|va) (?:esta|la) reunion",
    "(?:resumen|resume) (?:de )?(?:esta|la) reunion",
    "que (?:discutimos|hablamos)",
    // de
    "worum (?:ging|geht) es in (?:dieser|der) besprechung",
    "(?:zusammenfassung|uberblick) (?:von |der |dieser )?besprechung",
    // fr
    "de quoi (?:parlait|traitait|s'agissait) (?:cette|la) reunion",
    "(?:resume|resumer) (?:de )?(?:cette|la) reunion",
    // it
    "di cosa (?:trattava|parlava|si e parlato) (?:questa|la) riunione",
    "(?:riassunto|riassumi|sintesi) (?:di |della |questa )?riunione",
  ].join("|"),
  "u",
);
const OVERVIEW_JA_RE =
  /この会議.*(何|なに|どんな|概要|要約)|会議の(概要|要約)/u;

export function asksOverview(question: string): boolean {
  return OVERVIEW_RE.test(fold(question)) || OVERVIEW_JA_RE.test(question);
}

/**
 * Broad questions (owner report 2026-11-01): history, story, onboarding,
 * "give me details", "tell me more", "what is this project about". A lookup
 * pipeline answers one fact; these ask for a synthesis of the summaries and
 * the top chunks. Accents are folded before the test.
 */
const ELABORATION_RE = new RegExp(
  [
    // en
    "\\b(?:give|gimme|get|need|want|show|send) (?:me )?(?:some |a few )?(?:more |further |extra )?(?:details?|info|information|context|background)\\b",
    "\\bmore (?:details?|info|information|context|background)\\b",
    "\\bdetails? (?:please|about|on|of)\\b",
    "\\btell me more\\b",
    "\\b(?:elaborate|expand on|go deeper|go into (?:more )?detail|in more detail|in detail)\\b",
    "\\bwhat else\\b",
    "\\banything else\\b",
    // pt
    "\\b(?:me )?(?:de|da|passa|passe|quero|preciso de|manda) (?:mais )?detalhes\\b",
    "\\bmais (?:detalhes|informacoes|informacao|contexto)\\b",
    "\\b(?:conte|conta|fale|fala|diga|diz) mais\\b",
    "\\b(?:explique|explica|me explica) melhor\\b",
    "\\b(?:aprofunde|aprofundar|detalhe|detalha)\\b",
    "\\bo que mais\\b",
    // es
    "\\b(?:dame|quiero|necesito|dime) (?:mas )?detalles\\b",
    "\\bmas (?:detalles|informacion|contexto)\\b",
    "\\b(?:cuentame|dime|cuenta) mas\\b",
    "\\bque mas\\b",
    // de
    "\\bmehr (?:details|informationen|kontext)\\b",
    "\\berzahl(?:e)? mir mehr\\b",
    "\\bgenauer\\b",
    // fr
    "\\bplus de (?:details|precisions|informations|contexte)\\b",
    "\\b(?:dis|raconte)[- ]moi (?:en )?plus\\b",
    "\\bdonne[- ]moi (?:plus de )?details\\b",
    // it
    "\\bpiu (?:dettagli|informazioni|contesto)\\b",
    "\\b(?:dimmi|raccontami) (?:di )?(?:piu|altro)\\b",
  ].join("|"),
  "u",
);
const ELABORATION_JA_RE = /詳しく|もっと(?:教えて|知りたい)|詳細/u;

const SYNTHESIS_RE = new RegExp(
  [
    // en
    "\\b(?:tell|give|walk|take) me (?:through |the |a |an )?(?:whole |full |entire |complete |good )?(?:story|history|background|timeline|overview|picture|summary)\\b",
    "\\b(?:story|history|background|timeline|backstory) (?:of|behind|about|for) (?:the |this |our )?(?:project|folder|work|team|everything|all)\\b",
    "\\bwhat(?:'s| is) the (?:story|history|background|timeline|big picture)\\b",
    "\\bhow did (?:this|the|that|our|it) (?:project |work |effort |thing )?(?:begin|start|come about|get started)\\b",
    "\\bhow (?:it|this|the project|everything) (?:began|started)\\b",
    "\\bonboard\\w*",
    "\\b(?:catch|bring|get) me up to speed\\b",
    "\\bcatch me up\\b",
    "\\bwhat(?:'s| is| was) (?:this|the|our) (?:whole )?(?:project|folder|work|effort) (?:about|for)\\b",
    "\\bwhat(?:'s| is| has) (?:been )?(?:happening|going on|happened)(?: so far| here| in this)?\\b",
    "\\b(?:overview|summary|recap|rundown|big picture) of (?:the |this |our |everything|all)\\b",
    "\\b(?:summari[sz]e|recap) (?:the |this |our )?(?:project|folder|everything|all)\\b",
    "\\bthe whole (?:project|story|thing)\\b",
    "\\bwhole project\\b",
    "\\btell me (?:everything|anything|something)\\b",
    "\\bcan(?:'?t| ?not| not) you tell me (?:anything|something)\\b",
    "\\bany(?:thing)? (?:you can|at all)\\b",
    "\\b(?:do you know|is there|have you got) (?:anything|something)\\b",
    "\\bwhat (?:do|can) you (?:know|tell me)\\b",
    "\\bsay something\\b",
    // pt
    "\\b(?:me )?(?:conte|conta|fale|fala|explique|explica|resuma|resume) (?:a |toda a |tudo sobre a |sobre a |sobre o |tudo sobre o )?(?:historia|tudo|projeto|trajetoria|linha do tempo)\\b",
    "\\b(?:a )?historia (?:d[oae]|desse|deste|dessa|desta) (?:projeto|pasta|trabalho|equipe)\\b",
    "\\bqual (?:e |foi )?a historia\\b",
    "\\bcomo (?:esse|este|o|isso|tudo) (?:projeto )?(?:comecou|iniciou|surgiu|nasceu)\\b",
    "\\bonboarding\\b",
    "\\b(?:me )?(?:atualiza|atualize|poe|ponha) (?:a par|em dia)?\\b",
    "\\bvisao geral\\b",
    "\\b(?:resumo|panorama) (?:d[oae]|desse|deste|dessa|desta|geral) ?(?:projeto|pasta|tudo)?\\b",
    "\\bsobre o que (?:e|eh|foi) (?:esse|este|o) projeto\\b",
    "\\bo que (?:ja )?(?:aconteceu|rolou)\\b",
    "\\bnao (?:consegue|pode) (?:me )?(?:dizer|falar|contar) (?:nada|alguma coisa|algo)\\b",
    "\\bprojeto (?:todo|inteiro)\\b",
    // es
    "\\b(?:cuentame|cuenta|dime|explicame) (?:la |toda la |todo sobre la |sobre el |sobre la )?(?:historia|todo|proyecto|cronologia)\\b",
    "\\bhistoria del proyecto\\b",
    "\\bcomo (?:empezo|comenzo|inicio|surgio) (?:este |el )?(?:proyecto)?\\b",
    "\\bvision general\\b",
    "\\bresumen (?:del|de este|de todo) (?:proyecto|todo)\\b",
    "\\bno puedes decirme nada\\b",
    "\\bproyecto entero\\b",
    // de
    "\\berzahl(?:e)? mir (?:die |von der |ueber die )?(?:geschichte|alles)\\b",
    "\\b(?:die )?geschichte (?:des|von diesem|dieses|vom) projekt\\b",
    "\\bwie (?:hat|begann|fing) (?:das |dieses )?projekt (?:angefangen|an|begonnen)\\b",
    "\\buberblick (?:uber|ueber) (?:das|dieses|alles)\\b",
    "\\bkannst du mir (?:nichts|gar nichts) sagen\\b",
    "\\bganze projekt\\b",
    // fr
    "\\b(?:raconte|dis)[- ]moi (?:toute |l')?(?:histoire|tout)\\b",
    "\\bhistorique (?:du|de ce) projet\\b",
    "\\bcomment (?:le|ce) projet a (?:commence|demarre)\\b",
    "\\bapercu (?:du|de ce|global) ?(?:projet)?\\b",
    "\\btu ne peux rien me dire\\b",
    "\\bprojet entier\\b",
    // it
    "\\braccontami (?:la |tutta la )?(?:storia|tutto)\\b",
    "\\bstoria del progetto\\b",
    "\\bcome (?:e iniziato|e cominciato|nasce) (?:il |questo )?progetto\\b",
    "\\bpanoramica (?:del|di questo)? ?(?:progetto)?\\b",
    "\\bnon puoi dirmi niente\\b",
    "\\bprogetto intero\\b",
  ].join("|"),
  "u",
);
const SYNTHESIS_JA_RE =
  /経緯|プロジェクト(?:の|について).*(?:歴史|概要|全体|まとめ)|全体像|何も教えてくれない/u;

/** "Give me details", "tell me more", "elaborate": the user wants more than the last answer gave. */
export function asksElaboration(question: string): boolean {
  return (
    ELABORATION_RE.test(fold(question)) || ELABORATION_JA_RE.test(question)
  );
}

/**
 * A broad question: history, story, onboarding, overview, details, "tell me
 * more", "can't you tell me anything". Code decides (owner decision
 * 2026-11-01). A question about one fact stays a lookup.
 */
export function asksSynthesis(question: string): boolean {
  const q = fold(question).replace(/[’‘]/g, "'");
  return (
    SYNTHESIS_RE.test(q) ||
    SYNTHESIS_JA_RE.test(question) ||
    asksElaboration(question)
  );
}

/** Words that ask for the whole list: the review path (a list block) keeps those. */
const LIST_ALL_RE =
  /\b(show|list|display|all|every|each|mostre|mostrar|liste|listar|todas?|todos|muestra|muestre|alle|zeige|tous|toutes|montre|tutti|tutte|mostra|elenca)\b|一覧|すべて|全部/u;
const TAIL =
  "(?: (?:in|na|nesta|en|esta|in|dans|cette|nella|questa|di|von|der|dieser|bei) (?:this |the |a |la |die |der |das |den |dem |l')?(?:meeting|reuniao|reunion|besprechung|reunion|riunione|call))?(?: (?:so far|ate agora|hasta ahora|bisher|jusqu'ici|finora|today|hoje|hoy|heute|aujourd'hui|oggi|here|aqui))?";
const DECISIONS_RE = new RegExp(
  [
    `^(?:(?:so|and|but|e|mas|y|pero|und|aber|et|mais|ma),? )?(?:what|which)(?: (?:has|have|was|were|is|are))?(?: been)? (?:decided|(?:the )?decisions?)${TAIL}$`,
    `^(?:(?:so|and|but),? )?what (?:did|do|have) (?:we|the team|they|everyone|everybody) (?:decide|decided)${TAIL}$`,
    `^(?:the |any )?decisions?${TAIL}$`,
    `^o que (?:foi|ficou|ja foi|foi que) decidido${TAIL}$`,
    `^o que (?:decidimos|a gente decidiu|foi deliberado)${TAIL}$`,
    `^(?:quais|que) (?:foram )?(?:as )?decisoes${TAIL}$`,
    `^decisoes${TAIL}$`,
    `^que (?:se )?(?:decidio|ha decidido|hemos decidido|decidimos)${TAIL}$`,
    `^cuales (?:fueron )?(?:las )?decisiones${TAIL}$`,
    `^decisiones${TAIL}$`,
    `^was (?:wurde|ist|haben wir) (?:\\w+ )?(?:entschieden|beschlossen)${TAIL}$`,
    `^(?:die )?entscheidungen${TAIL}$`,
    `^(?:qu'est-ce qui a ete decide|qu'a-t-on decide|qu'avons-nous decide|quelles decisions(?: ont ete prises)?)${TAIL}$`,
    `^(?:les )?decisions${TAIL}$`,
    `^(?:cosa|che cosa) (?:e stato deciso|abbiamo deciso|si e deciso)${TAIL}$`,
    `^(?:le )?decisioni${TAIL}$`,
  ].join("|"),
  "u",
);
const DECISIONS_JA_RE =
  /^(?:何が決まりました|何を決めました|決定事項|決まったこと)[かは]?[?？]?$/u;

const NEXT_STEPS_RE = new RegExp(
  [
    `^(?:(?:so|and|but),? )?what(?: are| is|'s)(?: the)? (?:next steps?|action items?|to-?dos?|follow-?ups?|what'?s next)${TAIL}$`,
    `^(?:the )?(?:next steps?|action items?|follow-?ups?)${TAIL}$`,
    `^what(?:'s| is) next${TAIL}$`,
    `^(?:quais|o que) (?:sao )?(?:os )?(?:proximos passos|itens de acao|pendencias|tarefas)${TAIL}$`,
    `^(?:os )?proximos passos${TAIL}$`,
    `^(?:cuales|que) (?:son )?(?:los )?(?:proximos pasos|tareas pendientes|acciones)${TAIL}$`,
    `^(?:los )?proximos pasos${TAIL}$`,
    `^(?:was|welche) (?:sind )?(?:die )?(?:naechsten schritte|nachsten schritte|aufgaben)${TAIL}$`,
    `^(?:die )?(?:naechsten|nachsten) schritte${TAIL}$`,
    `^(?:quelles sont )?(?:les )?prochaines etapes${TAIL}$`,
    `^(?:quali sono )?(?:i )?prossimi passi${TAIL}$`,
  ].join("|"),
  "u",
);
const NEXT_STEPS_JA_RE =
  /^(?:次のステップ|今後の予定|アクションアイテム)[はを]?(?:何|なに)?[ですか]*[?？]?$/u;

const tidyAsk = (q: string): string =>
  fold(q)
    .replace(/[?!.¿¡\s]+$/u, "")
    .replace(/^[¿¡\s]+/u, "")
    .replace(/\s+/g, " ");

/**
 * "What has been decided?", "o que foi decidido", "decisões": the question
 * asks for the decisions of the meeting, with no topic. In a meeting scope the
 * decisions of the summary answer it (P1.2). A question with a topic ("What
 * did we decide on the database?") stays a search. A request for the whole
 * list ("show all decisions") stays the list path.
 */
export function asksDecisions(question: string): boolean {
  if (LIST_ALL_RE.test(fold(question))) return false;
  return (
    DECISIONS_RE.test(tidyAsk(question)) ||
    DECISIONS_JA_RE.test(question.trim())
  );
}

/** "What are the next steps?": the action items of the summary answer it. */
export function asksNextSteps(question: string): boolean {
  return (
    NEXT_STEPS_RE.test(tidyAsk(question)) ||
    NEXT_STEPS_JA_RE.test(question.trim())
  );
}

/**
 * The search query of a turn (spec 2.8 point 4). A dependent follow-up has no
 * topic of its own, so the query holds the NEW question first, then the earlier
 * question (the topic), then the start of the earlier answer (it names the
 * person or thing). The earlier answer is cut short: a whole answer took over
 * the query and every follow-up found the same chunk (P1.2). "My first
 * question" points to the first turn, else the last turn. A question with a
 * topic of its own searches with its own words only.
 */
export function followUpQuery(
  question: string,
  turns: readonly PriorTurn[],
  base?: string | null,
): string {
  const now = (base ?? "").trim() || question.trim();
  if (!isDependentFollowUp(question)) return queryFor(now, question);
  // The turns that the question leans on: the last turn, and the turns before
  // it while the question of a turn is a follow-up itself ("Why?" leans on the
  // fact before it). The last of them has a topic of its own.
  const chain: PriorTurn[] = [];
  if (FIRST_RE.test(question)) {
    if (turns[0]) chain.push(turns[0]);
  } else {
    for (const t of [...turns].reverse().slice(0, MAX_CHAIN)) {
      chain.push(t);
      if (!isDependentFollowUp(t.question)) break;
    }
  }
  const topic = chain.at(-1);
  if (!topic) return queryFor(now, question);
  const answer = EMPTY_ANSWER.test(topic.answer.trim())
    ? ""
    : topic.answer.trim().slice(0, ANSWER_HEAD_CHARS);
  const parts = [now, ...chain.map((t) => t.question), answer].filter(
    (x): x is string => !!x && x.trim() !== "",
  );
  return [...new Set(parts)].join(" ").slice(0, QUERY_MAX_CHARS).trim();
}

/**
 * "decision" or "open_question" from the words of the question. Code decides:
 * a small model got it wrong for "Show all decisions" (P1.1 eval).
 */
export function reviewKind(question: string): "decision" | "open_question" {
  return QUESTION_WORDS.test(fold(question)) ? "open_question" : "decision";
}

/**
 * The slots that code fills with no model call: the query (the question, plus
 * the earlier turn of a follow-up) and the kind of a review. The model only
 * fills what a closed list holds (person, item, meeting, folder).
 */
export function defaultSlots(
  question: string,
  turns: readonly PriorTurn[] = [],
  intent?: Intent,
): SlotValues {
  return {
    query:
      turns.length > 0
        ? followUpQuery(question, turns)
        : queryFor(null, question),
    person: "none",
    item: "none",
    meeting: "none",
    folder: "none",
    kind: intent === "review" ? reviewKind(question) : null,
    change: null,
    tag: null,
  };
}

const oneOf = (values: string[]) =>
  z.enum(["none", ...values] as [string, ...string[]]);

/**
 * The zod schema of the slot fill for one intent, or null when the intent has
 * no slots (status). The fields are closed choices where code built a list.
 * There are NO date fields: code reads the dates from the question.
 */
export function slotZod(
  intent: Intent,
  ch: Choices,
): z.ZodType<SlotValues> | null {
  const person = oneOf(ch.people.map((p) => p.id));
  let shape: Record<string, z.ZodType>;
  switch (intent) {
    case "status":
      return null;
    case "aggregate":
      shape = { person };
      break;
    case "temporal":
      return null;
    case "review":
      // The kind comes from the words of the question (`reviewKind`).
      return null;
    case "write":
      shape = {
        change: z.enum(["action_item", "retag", "move", "merge_people"]),
        item: oneOf(ch.items.map((i) => i.label)),
        meeting: oneOf(ch.meetings.map((m) => m.label)),
        folder: oneOf(ch.folders.map((f) => f.id)),
        person,
        tag: z.string().max(40).nullable(),
      };
      break;
    default:
      // lookup, who_said: no model field. The search query is the question
      // (plus the earlier questions of a follow-up), made by code. In the P1
      // eval a model-written query was right in 66% of the slot calls and a
      // copy of the question in all of them.
      return null;
  }
  return z.object(shape).strict() as unknown as z.ZodType<SlotValues>;
}

const FIELD_HELP: Record<string, string> = {
  query:
    "query: the search words for the question (the topic, names and numbers, from the question itself)",
  person: "person: one id from the list, or none",
  item: "item: one label from the list, or none",
  meeting: "meeting: one label from the list, or none",
  folder: "folder: one id from the list, or none",
  change: "change: action_item (done or reopen), retag, move or merge_people",
  tag: "tag: the tag name to add, or null",
};

function choiceText(intent: Intent, ch: Choices): string {
  const out: string[] = [];
  if (["aggregate", "write"].includes(intent) && ch.people.length)
    out.push(`person: ${ch.people.map((p) => `${p.id}=${p.name}`).join("; ")}`);
  if (intent === "write") {
    if (ch.items.length)
      out.push(
        `item: ${ch.items.map((i) => `${i.label}="${i.text}"`).join("; ")}`,
      );
    if (ch.meetings.length)
      out.push(
        `meeting: ${ch.meetings.map((m) => `${m.label}=${m.text}`).join("; ")}`,
      );
    if (ch.folders.length)
      out.push(
        `folder: ${ch.folders.map((f) => `${f.id}=${f.name}`).join("; ")}`,
      );
  }
  return out.join("\n");
}

/** The system prompt of the slot fill. It names no date field. */
export function slotSystem(
  intent: Intent,
  ch: Choices,
  todayIso: string,
): string {
  const shape = slotZod(intent, ch);
  const keys = shape
    ? Object.keys((shape as unknown as z.ZodObject<z.ZodRawShape>).shape)
    : [];
  return [
    `Fill the fields for a question about meeting notes. Intent: ${intent}.`,
    `Today is ${todayIso}. Do not write dates: code reads them from the question.`,
    ...keys.map((k) => FIELD_HELP[k]),
    choiceText(intent, ch),
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Planned calls (structured fallback path)
// ---------------------------------------------------------------------------

const none = (v: string | null | undefined): string | undefined =>
  v && v !== "none" ? v : undefined;

/** The 3 longest words of a query, in their order. Round 3 uses it. */
function longestWords(query: string): string {
  const words = query.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  if (words.length <= 3) return query;
  const top = new Set(
    words
      .map((w, i) => ({ w, i }))
      .sort((a, b) => b.w.length - a.w.length || a.i - b.i)
      .slice(0, 3)
      .map((x) => x.i),
  );
  return words.filter((_, i) => top.has(i)).join(" ");
}

/**
 * The tool calls of one round for the structured path (spec 2.3, fallback
 * chain). Round 1 uses the dates of the question. Round 2 raises k to 20 and
 * drops the dates. Round 3 is round 2 with the query cut to its 3 longest
 * words. No call is returned when a required slot is missing.
 * `aggregate` gives `list_action_items`, or `list_meetings` when the question
 * asks how many meetings. The pipeline turns a list into a count block when
 * `asksForCount` is true.
 */
export function plannedCalls(
  intent: Intent,
  scope: TurnScope,
  slots: SlotValues,
  choices: Choices,
  question: string,
  todayMs: number,
  round: number,
): ToolCall[] {
  const r = Math.min(Math.max(round, 1), 3);
  const q = fold(question);
  const dates = r === 1 ? datesFromQuestion(question, todayMs) : null;
  const meetingId =
    scope.kind === "meeting"
      ? (scope.id ?? undefined)
      : choices.meetings.find((m) => m.label === none(slots.meeting))?.id;

  const calls: { tool: ToolName; args: Record<string, unknown> }[] = [];
  const search = () => {
    let query = queryFor(slots.query, question);
    if (r === 3) query = longestWords(query);
    calls.push({
      tool: "search_chunks",
      args: {
        query,
        ...(meetingId ? { meeting_ids: [meetingId] } : {}),
        ...(r >= 2 ? { k: 20 } : {}),
      },
    });
  };

  switch (intent) {
    case "who_said":
    case "lookup":
    case "other":
      search();
      break;
    case "temporal":
      // A list of meetings in a range. A question about one topic on a date reads text.
      if (
        scope.kind !== "meeting" &&
        dates?.date_from &&
        asksForList(question) &&
        MEETING_WORDS.test(q)
      ) {
        calls.push({ tool: "list_meetings", args: { limit: 50 } });
      } else search();
      break;
    case "aggregate":
      if (
        scope.kind !== "meeting" &&
        MEETING_WORDS.test(q) &&
        asksForCount(question)
      ) {
        calls.push({ tool: "list_meetings", args: { limit: 50 } });
      } else {
        calls.push({
          tool: "list_action_items",
          args: {
            status: DONE_WORDS.test(q) ? "done" : "open",
            ...(none(slots.person) &&
            choices.people.some((p) => p.id === slots.person)
              ? { person_id: slots.person }
              : {}),
            ...(meetingId ? { meeting_id: meetingId } : {}),
          },
        });
      }
      break;
    case "review":
      calls.push({
        tool: "list_decisions_questions",
        args: {
          kind: slots.kind ?? reviewKind(question),
          ...(meetingId ? { meeting_id: meetingId } : {}),
          limit: 50,
        },
      });
      break;
    case "status":
      if (scope.kind === "meeting" && scope.id) {
        calls.push({
          tool: "get_meeting_summary",
          args: { meeting_id: scope.id },
        });
      } else if (scope.kind === "folder") {
        calls.push({ tool: "folder_status", args: {} });
      } else {
        calls.push({ tool: "list_meetings", args: { limit: 20 } });
        calls.push({ tool: "list_action_items", args: { status: "open" } });
      }
      break;
    case "write":
      if (r === 1)
        calls.push(...writeCalls(slots, choices, q, question, todayMs));
      break;
  }

  const out: ToolCall[] = [];
  for (const c of calls) {
    const args = { ...c.args };
    if (dates && hasDateArgs(c.tool)) {
      if (dates.date_from) args.date_from = dates.date_from;
      if (dates.date_to) args.date_to = dates.date_to;
    }
    const checked = parseToolArgs(c.tool, args);
    if (checked.ok) out.push({ tool: c.tool, args: checked.args });
  }
  return out;
}

function writeCalls(
  slots: SlotValues,
  ch: Choices,
  folded: string,
  question: string,
  todayMs: number,
): { tool: ToolName; args: Record<string, unknown> }[] {
  switch (slots.change) {
    case "action_item": {
      const id = ch.items.find((i) => i.label === none(slots.item))?.id;
      return id
        ? [
            {
              tool: "propose_action_item_change",
              args: { item_id: id, done: !REOPEN_WORDS.test(folded) },
            },
          ]
        : [];
    }
    case "retag": {
      const tag = (slots.tag ?? "").trim();
      let ids: string[] = ch.meetings
        .filter((m) => m.label === none(slots.meeting))
        .map((m) => m.id);
      if (ids.length === 0) {
        const d = datesFromQuestion(question, todayMs);
        if (d.date_from && d.date_to) {
          ids = ch.meetings
            .filter((m) => {
              const day = /\((\d{4}-\d{2}-\d{2})\)$/.exec(m.text)?.[1];
              return (
                day !== undefined &&
                day >= (d.date_from as string) &&
                day <= (d.date_to as string)
              );
            })
            .map((m) => m.id);
        }
      }
      return tag && ids.length
        ? [{ tool: "propose_retag", args: { meeting_ids: ids, tag } }]
        : [];
    }
    case "move": {
      const meeting = ch.meetings.find((m) => m.label === none(slots.meeting));
      const folder = ch.folders.find((f) => f.id === none(slots.folder));
      return meeting && folder
        ? [
            {
              tool: "propose_move",
              args: { meeting_id: meeting.id, folder_id: folder.id },
            },
          ]
        : [];
    }
    case "merge_people": {
      const p = ch.people.find((x) => x.id === none(slots.person));
      return p
        ? [{ tool: "propose_merge_people", args: { person_ids: [p.id] } }]
        : [];
    }
    default:
      return [];
  }
}
