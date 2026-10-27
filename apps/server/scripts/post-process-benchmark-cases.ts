export interface BenchmarkCase {
  id: string;
  language: "en" | "es" | "pt";
  label: string;
  input: string;
  expected: string;
}

export const POST_PROCESS_BENCHMARK_CASES: BenchmarkCase[] = [
  {
    id: "date-correction-en",
    language: "en",
    label: "Date correction",
    input: "let's meet thursday wait no actually friday at three",
    expected: "Let's meet Friday at three.",
  },
  {
    id: "recipient-correction-en",
    language: "en",
    label: "Recipient correction",
    input: "send it to marketing actually no to legal",
    expected: "Send it to legal.",
  },
  {
    id: "list-after-correction-en",
    language: "en",
    label: "List after correction",
    input:
      "ship it from the warehouse actually no from the office and i need one cable two adapters three batteries",
    expected: "Ship it from the office:\n\n1. Cable\n2. Adapters\n3. Batteries",
  },
  {
    id: "ordered-steps-en",
    language: "en",
    label: "Ordered steps",
    input: "one update the docs two notify support three restart the server",
    expected: "1. Update the docs\n2. Notify support\n3. Restart the server",
  },
  {
    id: "light-punctuation-en",
    language: "en",
    label: "Light punctuation",
    input: "please send the draft by end of week",
    expected: "Please send the draft by end of week.",
  },
  {
    id: "preserve-reminder-en",
    language: "en",
    label: "Preserve reminder",
    input: "don't forget we still owe finance the revised contract review",
    expected: "Don't forget we still owe finance the revised contract review.",
  },
  {
    id: "dictated-list-en",
    language: "en",
    label: "Dictated list",
    input:
      "here's what i need by end of week sam please update the draft we also need design to sign off on the mockup and don't forget we still owe finance the revised contract review",
    expected:
      "Here's what I need by end of week:\n\n1. Sam, please update the draft.\n2. We also need design to sign off on the mockup.\n3. Don't forget we still owe finance the revised contract review.",
  },
  {
    id: "casual-preservation-en",
    language: "en",
    label: "Casual preservation",
    input:
      "hey just wanted to let you know we're gonna push the demo back a bit cuz we found some issues",
    expected:
      "Hey, just wanted to let you know we're gonna push the demo back a bit cuz we found some issues.",
  },
  {
    id: "superseded-plan-en",
    language: "en",
    label: "Superseded plan",
    input:
      "let's meet in san francisco uh wait oakland actually no let's just do a remote zoom call instead",
    expected: "Let's just do a remote Zoom call instead.",
  },
  {
    id: "date-correction-es",
    language: "es",
    label: "Correccion de fecha",
    input: "reunamonos el jueves espera no en realidad el viernes a las tres",
    expected: "Reunamonos el viernes a las tres.",
  },
  {
    id: "recipient-correction-es",
    language: "es",
    label: "Correccion de destinatario",
    input: "envialo a marketing en realidad no a legal",
    expected: "Envialo a legal.",
  },
  {
    id: "list-after-correction-es",
    language: "es",
    label: "Lista tras correccion",
    input:
      "envialo desde el almacen en realidad no desde la oficina y necesito un cable dos adaptadores tres baterias",
    expected:
      "Envialo desde la oficina:\n\n1. Cable\n2. Adaptadores\n3. Baterias",
  },
  {
    id: "ordered-steps-es",
    language: "es",
    label: "Pasos ordenados",
    input:
      "uno actualiza la documentacion dos avisa a soporte tres reinicia el servidor",
    expected:
      "1. Actualiza la documentacion\n2. Avisa a soporte\n3. Reinicia el servidor",
  },
  {
    id: "light-punctuation-es",
    language: "es",
    label: "Puntuacion ligera",
    input: "por favor envia el borrador para fin de semana",
    expected: "Por favor envia el borrador para fin de semana.",
  },
  {
    id: "preserve-reminder-es",
    language: "es",
    label: "Recordatorio",
    input:
      "no olvides que todavia le debemos a finanzas la revision del contrato revisado",
    expected:
      "No olvides que todavia le debemos a finanzas la revision del contrato revisado.",
  },
  {
    id: "dictated-list-es",
    language: "es",
    label: "Lista dictada",
    input:
      "esto es lo que necesito para fin de semana sam por favor actualiza el borrador tambien necesitamos que diseno apruebe la maqueta y no olvides que todavia le debemos a finanzas la revision del contrato revisado",
    expected:
      "Esto es lo que necesito para fin de semana:\n\n1. Sam, por favor actualiza el borrador.\n2. Tambien necesitamos que diseno apruebe la maqueta.\n3. No olvides que todavia le debemos a finanzas la revision del contrato revisado.",
  },
  {
    id: "casual-preservation-es",
    language: "es",
    label: "Preservar tono casual",
    input:
      "hola solo queria avisarte que vamos a retrasar un poco la demo porque encontramos algunos problemas",
    expected:
      "Hola, solo queria avisarte que vamos a retrasar un poco la demo porque encontramos algunos problemas.",
  },
  {
    id: "superseded-plan-es",
    language: "es",
    label: "Plan reemplazado",
    input:
      "reunamonos en san francisco eh espera oakland en realidad no mejor hagamos una llamada de zoom remota",
    expected: "Mejor hagamos una llamada remota por Zoom.",
  },
  // Portuguese (owner decision 2026-10-27: en, es and pt; zh is not a target).
  {
    id: "date-correction-pt",
    language: "pt",
    label: "Correcao de data",
    input:
      "vamos nos encontrar na quinta espera nao na verdade na sexta as tres",
    expected: "Vamos nos encontrar na sexta às três.",
  },
  {
    id: "recipient-correction-pt",
    language: "pt",
    label: "Correcao de destinatario",
    input: "manda para o marketing na verdade nao para o juridico",
    expected: "Manda para o jurídico.",
  },
  {
    id: "list-after-correction-pt",
    language: "pt",
    label: "Lista apos correcao",
    input:
      "envia do deposito na verdade nao do escritorio e eu preciso de um cabo dois adaptadores tres baterias",
    expected:
      "Envia do escritório. Preciso de 1 cabo, 2 adaptadores e 3 baterias.",
  },
  {
    id: "ordered-steps-pt",
    language: "pt",
    label: "Passos ordenados",
    input:
      "um atualize a documentacao dois avise o suporte tres reinicie o servidor",
    expected:
      "1. Atualize a documentacao\n2. Avise o suporte\n3. Reinicie o servidor",
  },
  {
    id: "light-punctuation-pt",
    language: "pt",
    label: "Pontuacao leve",
    input: "por favor envie o rascunho ate o fim da semana",
    expected: "Por favor envie o rascunho ate o fim da semana.",
  },
  {
    id: "preserve-reminder-pt",
    language: "pt",
    label: "Lembrete",
    input:
      "nao esquece que ainda devemos ao financeiro a revisao do contrato revisado",
    expected:
      "Nao esquece que ainda devemos ao financeiro a revisao do contrato revisado.",
  },
  {
    id: "dictated-list-pt",
    language: "pt",
    label: "Lista ditada",
    input:
      "isso e o que eu preciso ate o fim da semana sam por favor atualiza o rascunho tambem precisamos que o design aprove o mockup e nao esquece que ainda devemos ao financeiro a revisao do contrato",
    expected:
      "Isso é o que eu preciso até o fim da semana:\n\n1. Sam, por favor atualiza o rascunho.\n2. Também precisamos que o design aprove o mockup.\n3. Não esquece que ainda devemos ao financeiro a revisão do contrato.",
  },
  {
    id: "casual-preservation-pt",
    language: "pt",
    label: "Tom casual",
    input:
      "oi so queria te avisar que a gente vai atrasar um pouco a demo porque achamos uns problemas",
    expected:
      "Oi, so queria te avisar que a gente vai atrasar um pouco a demo porque achamos uns problemas.",
  },
  {
    id: "superseded-plan-pt",
    language: "pt",
    label: "Plano substituido",
    input:
      "vamos nos ver em sao paulo hum espera em campinas na verdade nao melhor fazer uma chamada remota no zoom",
    expected: "Melhor fazer uma chamada remota no Zoom.",
  },
];

// The pass check of a bench case. Owner rules: numbers are digits
// (2026-10-26), so the date-correction checks take "3" as well as the word;
// quantities stay quantities, not a list (2026-10-27).
function normalizeForCompare(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\r\n/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function containsAll(text: string, patterns: RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(text));
}

function containsNone(text: string, patterns: RegExp[]): boolean {
  return patterns.every((pattern) => !pattern.test(text));
}

type Lang = BenchmarkCase["language"];

const CHECKS: Record<
  string,
  Record<Lang, { all: RegExp[]; none?: RegExp[] }>
> = {
  "date-correction": {
    en: { all: [/friday/i, /\b(three|3)\b/i], none: [/thursday/i] },
    es: { all: [/viernes/i, /(tres|\b3\b)/i], none: [/jueves/i] },
    pt: { all: [/sexta/i, /(tres|\b3\b)/i], none: [/quinta/i] },
  },
  "recipient-correction": {
    en: { all: [/legal/i], none: [/marketing/i] },
    es: { all: [/legal/i], none: [/marketing/i] },
    pt: { all: [/juridico/i], none: [/marketing/i] },
  },
  "list-after-correction": {
    en: {
      all: [/office/i, /\b1 cable/i, /\b2 adapters/i, /\b3 batteries/i],
      none: [/warehouse/i, /^\s*\d+\.\s/m],
    },
    es: {
      all: [/oficina/i, /\b1 cable/i, /\b2 adaptadores/i, /\b3 baterias/i],
      none: [/almacen/i, /^\s*\d+\.\s/m],
    },
    pt: {
      all: [/escritorio/i, /\b1 cabo/i, /\b2 adaptadores/i, /\b3 baterias/i],
      none: [/deposito/i, /^\s*\d+\.\s/m],
    },
  },
  "dictated-list": {
    en: {
      all: [
        /^here'?s what i need by end of week:/i,
        /1\./,
        /2\./,
        /3\./,
        /sam/i,
        /design/i,
        /finance/i,
      ],
    },
    es: {
      all: [
        /^esto es lo que necesito para fin de semana:/i,
        /1\./,
        /2\./,
        /3\./,
        /sam/i,
        /diseno/i,
        /finanzas/i,
      ],
    },
    pt: {
      all: [
        /^isso e o que eu preciso ate o fim da semana:/i,
        /1\./,
        /2\./,
        /3\./,
        /sam/i,
        /design/i,
        /financeiro/i,
      ],
    },
  },
  "superseded-plan": {
    en: { all: [/zoom/i], none: [/san francisco/i, /oakland/i] },
    es: { all: [/zoom/i], none: [/san francisco/i, /oakland/i] },
    pt: { all: [/zoom/i], none: [/sao paulo/i, /campinas/i] },
  },
};

export function evaluateCase(testCase: BenchmarkCase, actual: string): boolean {
  const normalized = normalizeForCompare(actual);
  const family = Object.keys(CHECKS).find((f) => testCase.id.startsWith(f));
  const check = family ? CHECKS[family]?.[testCase.language] : undefined;
  if (check) {
    return (
      containsAll(normalized, check.all) &&
      containsNone(normalized, check.none ?? [])
    );
  }
  return normalizeForCompare(testCase.expected) === normalized;
}
