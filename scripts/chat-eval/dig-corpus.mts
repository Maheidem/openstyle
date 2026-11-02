// dig-corpus.mts: the extra fictional data of the `dig` part (D21, spec 11.9).
// It is built by code, with no random numbers, and is loaded into the scratch
// DB ON TOP of the base corpus (like clarify-corpus.mts). The base corpus, its
// ids and both hashes stay as they are.
//
// The data answers questions that need digging: "what are the open items",
// "why are they open", "what blocked X", "how did decision Y evolve". The
// REASONS are spread over 2 to 4 meetings, and most of them are in the
// transcript only. One search finds one reason, not all of them.
//
//   Orchard Platform (EN, 5 meetings): a hosting contract that stays unsigned
//     for three reasons in three meetings; a sign-in decision that changes
//     twice; an API freeze that one person pushes and one person doubts.
//   Projeto Lagoa (PT, 4 meetings): an app that is not published for three
//     reasons; a launch date that moves twice; a push provider that stays open.
//   Cedar Rollout (EN, 4 meetings): pilot kits that are not ordered; pilot
//     sites that shrink from four to two. One more blocker of the hosting
//     contract is told here (a cross-folder case).

import { lines } from "./clarify-corpus.mts";
import type { Corpus, Folder, Lang, Meeting, Person } from "./types.mts";

const DAY = 86_400_000;

export const DIG_ORCHARD_ID = "fld-dg-orchard";
export const DIG_LAGOA_ID = "fld-dg-lagoa";
export const DIG_CEDAR_ID = "fld-dg-cedar";

/** The id of the n-th meeting (1 based) of a project: `dg-orc-2`. */
export const digMeetingId = (key: "orc" | "lag" | "ced", n: number): string =>
  `dg-${key}-${n}`;

const P = (id: string, first: string, last: string, asr: string): Person => ({
  id,
  first,
  full: `${first} ${last}`,
  variants: [`${first} ${last.charAt(0)}.`],
  asr,
});
const INGRID = P("dg1", "Ingrid", "Valdez", "Ingrid Valdes");
const OMAR = P("dg2", "Omar", "Haddad", "Omar Hadad");
const KENJI = P("dg3", "Kenji", "Morita", "Kenji Morrita");
const BEATRIZ = P("dg4", "Beatriz", "Tavares", "Beatriz Tavarez");
const DMITRI = P("dg5", "Dmitri", "Volkov", "Dmitri Volkoff");
const NADIA = P("dg6", "Nadia", "Okonkwo", "Nadia Okonko");
const FELIPE = P("dg7", "Felipe", "Arantes", "Felipe Arantis");
const GRETA = P("dg8", "Greta", "Lindqvist", "Greta Lindquist");

interface Say {
  who: Person;
  text: string;
}
interface Action {
  task: string;
  owner: Person;
  due: string;
  done?: boolean;
}
interface Spec {
  n: number;
  title: string;
  /** Day offset from the first meeting of the project. */
  day: number;
  overview: string;
  keyPoints: string[];
  decisions?: string[];
  actions?: Action[];
  openQuestions?: string[];
  say: Say[];
}

function build(
  key: "orc" | "lag" | "ced",
  folderId: string,
  lang: Lang,
  start: number,
  team: Person[],
  specs: Spec[],
): Meeting[] {
  return specs.map((s) => {
    const id = digMeetingId(key, s.n);
    const speakers = team.map((p, k) => ({
      label: String(k + 1),
      personId: p.id,
      displayName: p.full,
    }));
    const label = (p: Person) =>
      speakers.find((x) => x.personId === p.id)?.label ?? null;
    return {
      id,
      folderId,
      title: s.title,
      startedAt: start + s.day * DAY,
      durationMs: 2_400_000,
      lang,
      summaryLang: lang,
      tags: ["team"],
      speakers,
      segments: lines(
        id,
        s.say.map((x) => ({
          text: x.text,
          personId: x.who.id,
          label: label(x.who),
        })),
      ),
      overview: s.overview,
      keyPoints: s.keyPoints,
      decisions: (s.decisions ?? []).map((text, i) => ({
        id: `${id}#d${i}`,
        text,
        factId: `${id}-fd${i}`,
      })),
      actionItems: (s.actions ?? []).map((a, i) => ({
        id: `${id}#a${i}`,
        task: a.task,
        owner: a.owner.full,
        ownerPersonId: a.owner.id,
        due: a.due,
        done: a.done ?? false,
        factId: `${id}-fa${i}`,
      })),
      openQuestions: (s.openQuestions ?? []).map((text, i) => ({
        id: `${id}#q${i}`,
        text,
        factId: `${id}-fq${i}`,
      })),
    } satisfies Meeting;
  });
}

// ---------------------------------------------------------------------------
// Orchard Platform (EN)
// ---------------------------------------------------------------------------

const ORCHARD: Spec[] = [
  {
    n: 1,
    day: 0,
    title: "Orchard kickoff",
    overview:
      "The team kicked off the Orchard Platform project and agreed the first plan.",
    keyPoints: [
      "The release budget is 80000 euros.",
      "Sign-in will use the Aldoro identity service.",
      "Hosting needs a vendor contract before the pilot.",
    ],
    decisions: ["Use the Aldoro identity service for sign-in."],
    actions: [
      {
        task: "Sign the Kestrel hosting contract",
        owner: BEATRIZ,
        due: "2026-10-05",
      },
      {
        task: "Publish the onboarding guide",
        owner: INGRID,
        due: "2026-09-18",
        done: true,
      },
    ],
    say: [
      {
        who: INGRID,
        text: "Welcome to the Orchard Platform kickoff. The release budget is 80000 euros.",
      },
      {
        who: KENJI,
        text: "For sign-in we will use the Aldoro identity service. It is the quickest to integrate.",
      },
      { who: INGRID, text: "Decision noted: Aldoro for sign-in." },
      {
        who: BEATRIZ,
        text: "I will own the Kestrel hosting contract. I will sign it once legal confirms the terms.",
      },
      { who: INGRID, text: "The onboarding guide is published already." },
    ],
  },
  {
    n: 2,
    day: 7,
    title: "Orchard security review",
    overview:
      "The team reviewed the security needs of the hosting contract and the public API.",
    keyPoints: [
      "Kestrel offers only the Dublin region, but customer data must stay in the Frankfurt region.",
    ],
    actions: [
      { task: "Freeze the public API", owner: KENJI, due: "2026-10-12" },
    ],
    openQuestions: ["Will Kestrel offer a Frankfurt region?"],
    say: [
      {
        who: OMAR,
        text: "Kestrel only offers the Dublin region today. Our rule is that customer data must stay in the Frankfurt region.",
      },
      {
        who: BEATRIZ,
        text: "Then I cannot sign the Kestrel contract yet. I will ask them for Frankfurt.",
      },
      {
        who: OMAR,
        text: "I also want a public API freeze. The external audit starts on 3 December and we cannot change endpoints during it.",
      },
      {
        who: KENJI,
        text: "A freeze this early worries me. We still have endpoints to build.",
      },
      { who: INGRID, text: "Let us talk about the freeze again next week." },
    ],
  },
  {
    n: 3,
    day: 14,
    title: "Orchard sign-in change",
    overview:
      "The team changed the sign-in service and heard news about the hosting vendor.",
    keyPoints: ["Sign-in moves from Aldoro to the Brumel identity service."],
    decisions: [
      "Switch sign-in to the Brumel identity service, because Aldoro has no SCIM provisioning.",
    ],
    say: [
      {
        who: KENJI,
        text: "Aldoro does not support SCIM provisioning. Without SCIM we cannot create accounts for the customer admins.",
      },
      {
        who: KENJI,
        text: "Brumel supports SCIM. I propose we switch sign-in to Brumel.",
      },
      { who: INGRID, text: "Agreed. We switch to Brumel." },
      {
        who: KENJI,
        text: "About the API freeze. I object. Two endpoints are still missing, export and audit-log, so I cannot freeze the API yet.",
      },
      {
        who: OMAR,
        text: "Kestrel came back. They accept Frankfurt, but they want a 36 month term and they refuse our exit clause.",
      },
      {
        who: BEATRIZ,
        text: "A 36 month term with no exit clause is too risky. I will not sign that.",
      },
    ],
  },
  {
    n: 4,
    day: 21,
    title: "Orchard finance check",
    overview:
      "Finance and security checked the open contract and the API freeze.",
    keyPoints: [
      "The Q4 budget freeze blocks new contract signatures until 12 November.",
    ],
    decisions: ["Freeze the public API once export and audit-log ship."],
    say: [
      {
        who: BEATRIZ,
        text: "Even if Kestrel agrees, finance has a budget freeze. No new contract can be signed until the freeze ends on 12 November.",
      },
      {
        who: OMAR,
        text: "The audit finding is clear. There were 14 customer incidents last quarter through unversioned endpoints. That is why I push for the API freeze.",
      },
      {
        who: INGRID,
        text: "With 14 incidents I side with Omar. We freeze the API after the two missing endpoints ship.",
      },
      {
        who: KENJI,
        text: "Export and audit-log will ship by 28 October.",
      },
    ],
  },
  {
    n: 5,
    day: 28,
    title: "Orchard release plan",
    overview: "The team updated the release plan and the sign-in setup.",
    keyPoints: [
      "The release budget is now 95000 euros because of the Frankfurt hosting.",
      "Sign-in keeps Brumel and uses Aldoro only for contractors.",
    ],
    decisions: ["Keep Brumel for sign-in and use Aldoro only for contractors."],
    openQuestions: ["Do contractors need hardware keys?"],
    say: [
      {
        who: INGRID,
        text: "The release budget is now 95000 euros. The extra money pays for the Frankfurt hosting.",
      },
      {
        who: KENJI,
        text: "For sign-in we keep Brumel. Contractors stay on Aldoro, so we run both.",
      },
      {
        who: OMAR,
        text: "I want hardware keys for all contractors because of the phishing attempt in August.",
      },
      {
        who: KENJI,
        text: "Thirty keys would cost 2400 euros and the budget is already tight.",
      },
      {
        who: BEATRIZ,
        text: "The Kestrel contract is still unsigned. The budget freeze ends on 12 November, then I can sign.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Projeto Lagoa (PT)
// ---------------------------------------------------------------------------

const LAGOA: Spec[] = [
  {
    n: 1,
    day: 0,
    title: "Lagoa: abertura",
    overview:
      "A equipe abriu o projeto Lagoa e definiu o plano inicial do aplicativo.",
    keyPoints: [
      "O lançamento do app está previsto para 1 de dezembro.",
      "A equipe vai comparar dois provedores de notificações push: Pushwave e Notiq.",
    ],
    decisions: ["Lançar o app em 1 de dezembro."],
    actions: [
      {
        task: "Publicar o app na loja de testes",
        owner: FELIPE,
        due: "2026-10-10",
      },
      {
        task: "Montar o plano de testes",
        owner: GRETA,
        due: "2026-09-25",
        done: true,
      },
    ],
    openQuestions: ["Qual provedor de notificações push vamos usar?"],
    say: [
      {
        who: FELIPE,
        text: "Bem-vindos ao projeto Lagoa. O lançamento do app está previsto para 1 de dezembro.",
      },
      {
        who: DMITRI,
        text: "Para as notificações push temos dois candidatos, Pushwave e Notiq. Ainda não sei qual escolher.",
      },
      {
        who: FELIPE,
        text: "Eu fico com a publicação do app na loja de testes.",
      },
      { who: GRETA, text: "O plano de testes já está montado." },
    ],
  },
  {
    n: 2,
    day: 7,
    title: "Lagoa: loja de testes",
    overview: "A equipe tratou da rejeição do app pela loja de testes.",
    keyPoints: [
      "A loja de testes rejeitou o app por causa do ícone com o selo beta.",
    ],
    say: [
      {
        who: FELIPE,
        text: "A revisão da loja de testes rejeitou o app. O motivo foi o ícone com o selo beta.",
      },
      {
        who: NADIA,
        text: "Eu refaço o ícone, mas defendo adiar o lançamento. A bateria drena 12 por cento por hora com a tela de mapa aberta.",
      },
      { who: FELIPE, text: "Adiar agora é cedo. Vamos medir de novo." },
    ],
  },
  {
    n: 3,
    day: 14,
    title: "Lagoa: testes e push",
    overview:
      "A equipe revisou os testes de push e o plano de lançamento do app.",
    keyPoints: [
      "Nos testes de push, o Notiq atrasou 40 segundos em média.",
      "O lançamento mudou para 15 de dezembro.",
    ],
    decisions: ["Mover o lançamento para 15 de dezembro."],
    actions: [
      {
        task: "Obter o certificado de assinatura da Apple",
        owner: DMITRI,
        due: "2026-10-30",
      },
    ],
    say: [
      {
        who: DMITRI,
        text: "Nos testes de push, o Notiq atrasou 40 segundos em média. O Pushwave entregou em 2 segundos.",
      },
      {
        who: FELIPE,
        text: "Ainda não consigo publicar na loja de testes. Falta o certificado de assinatura. O Dmitri pediu à Apple em 3 de outubro e ainda não chegou.",
      },
      {
        who: FELIPE,
        text: "Um concorrente vai lançar em dezembro. Por isso não quero adiar. Quero lançar em 15 de dezembro.",
      },
      {
        who: NADIA,
        text: "Continuo defendendo adiar. A bateria ainda drena 12 por cento por hora.",
      },
    ],
  },
  {
    n: 4,
    day: 21,
    title: "Lagoa: revisão final",
    overview:
      "A equipe adiou o lançamento e revisou o que falta para publicar.",
    keyPoints: [
      "O lançamento foi adiado para 15 de janeiro.",
      "O custo do Pushwave, 1200 euros por mês, ainda não foi aprovado.",
    ],
    decisions: ["Adiar o lançamento para 15 de janeiro."],
    openQuestions: ["Qual provedor de notificações push vamos usar?"],
    say: [
      {
        who: FELIPE,
        text: "O time jurídico quer revisar os termos de privacidade antes da publicação. A previsão é 20 de novembro.",
      },
      {
        who: DMITRI,
        text: "O Pushwave custa 1200 euros por mês. Ainda não aprovamos esse custo, então a escolha do provedor de push continua em aberto.",
      },
      {
        who: NADIA,
        text: "A bateria caiu para 4 por cento por hora, mas o mapa ainda trava em aparelhos antigos. Por isso adiamos para 15 de janeiro.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Cedar Rollout (EN)
// ---------------------------------------------------------------------------

const CEDAR: Spec[] = [
  {
    n: 1,
    day: 0,
    title: "Cedar: pilot scope",
    overview: "The team scoped the Cedar Rollout pilot.",
    keyPoints: [
      "The pilot covers 4 sites with 40 kits.",
      "The candidate sites are Madrid, Porto, Lyon and Milan.",
    ],
    actions: [
      { task: "Order the pilot kits", owner: DMITRI, due: "2026-10-12" },
    ],
    openQuestions: ["Which sites join the pilot?"],
    say: [
      {
        who: DMITRI,
        text: "The pilot covers 4 sites and needs 40 kits. The candidates are Madrid, Porto, Lyon and Milan.",
      },
      {
        who: GRETA,
        text: "We need to choose the sites before we order everything.",
      },
      { who: DMITRI, text: "I will order the pilot kits." },
    ],
  },
  {
    n: 2,
    day: 7,
    title: "Cedar: supplier",
    overview: "The team talked about the kit supplier and the hosting vendor.",
    keyPoints: ["Zorvan is the kit supplier."],
    openQuestions: ["Which sites join the pilot?"],
    say: [
      {
        who: DMITRI,
        text: "Zorvan is our supplier for the kits. Their lead time is 9 weeks, so the kits arrive late.",
      },
      {
        who: OMAR,
        text: "The Kestrel hosting SLA is 99.5 percent. Our pilot needs 99.9, so Kestrel is not enough for the pilot.",
      },
      { who: BEATRIZ, text: "Another reason not to sign Kestrel yet." },
      {
        who: GRETA,
        text: "Madrid has no site contact, so I drop Madrid from the list.",
      },
    ],
  },
  {
    n: 3,
    day: 14,
    title: "Cedar: customs",
    overview: "The team handled a shipment problem and the safety check.",
    keyPoints: ["The first shipment of kits is held at customs."],
    actions: [
      {
        task: "Run the safety check on the kits",
        owner: GRETA,
        due: "2026-11-05",
      },
    ],
    say: [
      {
        who: DMITRI,
        text: "The first shipment of kits is held at customs. Customs asks for a safety certificate.",
      },
      {
        who: GRETA,
        text: "I can run the safety check only when 10 kits are on site, so the certificate waits.",
      },
      {
        who: OMAR,
        text: "Milan has no network at the site. I want to drop Milan.",
      },
    ],
  },
  {
    n: 4,
    day: 21,
    title: "Cedar: pilot sites final",
    overview: "The team fixed the final pilot sites.",
    keyPoints: ["The pilot shrinks to 2 sites and 24 kits: Porto and Lyon."],
    decisions: ["Run the pilot at Porto and Lyon with 24 kits."],
    say: [
      {
        who: OMAR,
        text: "Final decision: the pilot runs at Porto and Lyon only, with 24 kits.",
      },
      {
        who: DMITRI,
        text: "The order for 24 kits is still not placed, because the first shipment is still at customs.",
      },
    ],
  },
];

export interface DigAddon {
  people: Person[];
  folders: Folder[];
  meetings: Meeting[];
}

/**
 * The extra data. The ids use the prefix `dg-`, so they never meet the base
 * corpus (`mtg-...`) or the clarify data (`cl-...`).
 */
export function buildDigAddon(): DigAddon {
  const folders: Folder[] = [
    {
      id: DIG_ORCHARD_ID,
      name: "Orchard Platform",
      description: "The new customer platform: hosting, sign-in and API.",
      teamPersonIds: [INGRID.id, OMAR.id, KENJI.id, BEATRIZ.id],
    },
    {
      id: DIG_LAGOA_ID,
      name: "Projeto Lagoa",
      description: "O aplicativo móvel do projeto Lagoa.",
      teamPersonIds: [FELIPE.id, NADIA.id, DMITRI.id, GRETA.id],
    },
    {
      id: DIG_CEDAR_ID,
      name: "Cedar Rollout",
      description: "The pilot of the Cedar kits at customer sites.",
      teamPersonIds: [OMAR.id, BEATRIZ.id, DMITRI.id, GRETA.id],
    },
  ];
  const meetings = [
    ...build(
      "orc",
      DIG_ORCHARD_ID,
      "en",
      Date.UTC(2026, 8, 14, 10, 0, 0),
      [INGRID, OMAR, KENJI, BEATRIZ],
      ORCHARD,
    ),
    ...build(
      "lag",
      DIG_LAGOA_ID,
      "pt",
      Date.UTC(2026, 8, 21, 10, 0, 0),
      [FELIPE, NADIA, DMITRI, GRETA],
      LAGOA,
    ),
    ...build(
      "ced",
      DIG_CEDAR_ID,
      "en",
      Date.UTC(2026, 9, 5, 10, 0, 0),
      [OMAR, BEATRIZ, DMITRI, GRETA],
      CEDAR,
    ),
  ];
  return {
    people: [INGRID, OMAR, KENJI, BEATRIZ, DMITRI, NADIA, FELIPE, GRETA],
    folders,
    meetings,
  };
}

/** The base corpus with only the dig folders and meetings: what `loadCorpus` inserts. */
export function digAsCorpus(base: Corpus, addon: DigAddon): Corpus {
  return {
    ...base,
    people: [...base.people, ...addon.people],
    folders: addon.folders,
    meetings: addon.meetings,
    facts: [],
  };
}
