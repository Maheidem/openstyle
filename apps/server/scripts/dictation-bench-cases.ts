// Fictional dictation cases for the staged pipeline (specs/dictation-pipeline.md
// 7). Each case has its intensity, an optional destination tone, and regex
// checks: every `must` matches and no `mustNot` matches. Numbers are digits
// (owner rule 2026-10-26). Languages: en, es, pt (owner decision 2026-10-27).
// The cases test the new stages, so they favour the pipeline (spec 10 item 4).

export type CaseIntensity = "low" | "medium" | "high";
export interface CaseTone {
  destination: "overall" | "personal" | "work" | "email";
  personalTone?: "polished" | "casual" | "very_casual";
  workTone?: "direct" | "friendly" | "formal";
  emailTone?: "casual" | "warm" | "formal";
  overallTone?: "casual" | "neutral" | "professional";
}
export interface PipelineCase {
  id: string;
  language: "en" | "es" | "pt";
  feature:
    | "itn"
    | "contact"
    | "line"
    | "list"
    | "fragment"
    | "tone"
    | "intensity"
    | "mixed";
  intensity: CaseIntensity;
  tone?: CaseTone;
  input: string;
  must: RegExp[];
  mustNot?: RegExp[];
}

const L = (n: number) => new RegExp(`(^|\\n)(\\s*- .+(\\n|$)){${n}}`);
const NUMBERED = /^\s*\d+\.\s/m;

// biome-ignore format: one case per line is easier to read and review.
export const DICTATION_PIPELINE_CASES: PipelineCase[] = [
  // --- dates, times, money, percent ---
  { id: "itn-date-time-en", language: "en", feature: "itn", intensity: "medium", input: "the meeting is march fifteenth at three pm", must: [/March 15(th)?/, /3 ?(PM|p\.m\.|pm)/i], mustNot: [/fifteen/i, /three/i] },
  { id: "itn-money-en", language: "en", feature: "itn", intensity: "medium", input: "it costs twenty five dollars for the upgrade", must: [/(25 dollars|\$25)/], mustNot: [/twenty/i] },
  { id: "itn-correction-time-en", language: "en", feature: "itn", intensity: "medium", input: "the deadline is october third at nine thirty am no wait ten thirty am", must: [/October 3(rd)?/, /10:30 ?(AM|a\.m\.|am)/i], mustNot: [/9:30|nine/i] },
  { id: "itn-percent-amount-en", language: "en", feature: "itn", intensity: "medium", input: "we grew by twelve percent and the budget is three thousand five hundred euros", must: [/12 ?(%|percent)/, /(3,?500 euros|€ ?3,?500)/], mustNot: [/twelve|thousand/i] },
  { id: "itn-year-en", language: "en", feature: "itn", intensity: "medium", input: "the party is on june twenty first two thousand twenty seven", must: [/June 21(st)?,? 2027/], mustNot: [/twenty/i] },
  { id: "itn-date-time-es", language: "es", feature: "itn", intensity: "medium", input: "la reunión es el quince de marzo a las tres de la tarde", must: [/15 de marzo/, /(3 de la tarde|15:00|3 ?p\.? ?m\.?)/i], mustNot: [/quince|tres/i] },
  { id: "itn-money-es", language: "es", feature: "itn", intensity: "medium", input: "cuesta veinticinco dólares", must: [/(25 d[oó]lares|\$ ?25|25 ?\$)/, /\.$/], mustNot: [/veinticinco/i] },
  { id: "itn-percent-amount-es", language: "es", feature: "itn", intensity: "medium", input: "el presupuesto es de tres mil quinientos euros y crecimos un doce por ciento", must: [/3500 (euros|€)/, /12 ?(%|por ciento)/], mustNot: [/quinientos|doce/i] },
  { id: "itn-date-time2-es", language: "es", feature: "itn", intensity: "medium", input: "el vuelo sale el primero de abril a las nueve y media de la mañana", must: [/1\.?º? de abril/, /9:30/], mustNot: [/primero|nueve/i] },
  { id: "itn-date-time-pt", language: "pt", feature: "itn", intensity: "medium", input: "a reunião é no dia quinze de março às três da tarde", must: [/15 de março/, /(3 da tarde|15:00|15h)/i], mustNot: [/quinze|três/i] },
  { id: "itn-money-pt", language: "pt", feature: "itn", intensity: "medium", input: "custa vinte e cinco reais", must: [/(25 reais|R\$ ?25)/, /\.$/], mustNot: [/vinte/i] },
  { id: "itn-percent-amount-pt", language: "pt", feature: "itn", intensity: "medium", input: "o orçamento é de três mil e quinhentos reais e crescemos doze por cento", must: [/(3\.500 reais|R\$ ?3\.500)/, /12 ?(%|por cento)/], mustNot: [/quinhentos|doze/i] },
  { id: "itn-date-time2-pt", language: "pt", feature: "itn", intensity: "medium", input: "o voo sai no primeiro de abril às nove e meia da manhã", must: [/1º? de abril/, /9:30|9h30/], mustNot: [/primeiro|nove/i] },

  // --- contact info and symbols ---
  { id: "contact-email-en", language: "en", feature: "contact", intensity: "medium", input: "email me at john dot smith at example dot com about the launch", must: [/john\.smith@example\.com/i], mustNot: [/\bdot\b/i] },
  { id: "contact-url-en", language: "en", feature: "contact", intensity: "medium", input: "go to https colon slash slash api dot example dot com slash v1", must: [/https:\/\/api\.example\.com\/v1/] },
  { id: "contact-path-en", language: "en", feature: "contact", intensity: "medium", input: "the file lives at slash home slash user slash notes dot txt", must: [/\/home\/user\/notes\.txt/] },
  { id: "contact-phone7-en", language: "en", feature: "contact", intensity: "medium", input: "call me at five five five one two three four", must: [/555-?1234/] },
  { id: "contact-phone10-en", language: "en", feature: "contact", intensity: "medium", input: "my number is four one five five five five zero one nine nine", must: [/(415-?555-?0199|\(415\) ?555-0199)/] },
  { id: "contact-email-correction-en", language: "en", feature: "contact", intensity: "medium", input: "send the contract to sara at example dot com no wait example dot org", must: [/sara@example\.org/i], mustNot: [/example\.com/i] },
  { id: "contact-filename-en", language: "en", feature: "contact", intensity: "medium", input: "rename the file to report underscore final dot pdf", must: [/report_final\.pdf/i] },
  { id: "contact-email-es", language: "es", feature: "contact", intensity: "medium", input: "escríbeme a ana punto lopez arroba ejemplo punto com", must: [/ana\.lopez@ejemplo\.com/i] },
  { id: "contact-phone-es", language: "es", feature: "contact", intensity: "medium", input: "mi teléfono es seis uno dos tres cuatro cinco seis siete ocho", must: [/612 ?34 ?56 ?78|612 ?345 ?678/] },
  { id: "contact-url-es", language: "es", feature: "contact", intensity: "medium", input: "la página es www punto ejemplo punto es barra precios", must: [/www\.ejemplo\.es\/precios/i] },
  { id: "contact-email-pt", language: "pt", feature: "contact", intensity: "medium", input: "me escreve no joao ponto silva arroba exemplo ponto com ponto br", must: [/joao\.silva@exemplo\.com\.br/i], mustNot: [/\bponto\b/i] },
  { id: "contact-phone-pt", language: "pt", feature: "contact", intensity: "medium", input: "meu celular é nove oito sete seis cinco quatro três dois um", must: [/98765-?4321/] },
  { id: "contact-url-pt", language: "pt", feature: "contact", intensity: "medium", input: "o site é www ponto exemplo ponto com ponto br barra precos", must: [/www\.exemplo\.com\.br\/precos/i] },
  { id: "contact-filename-pt", language: "pt", feature: "contact", intensity: "medium", input: "renomeia o arquivo para relatorio underline final ponto pdf", must: [/relatorio_final\.pdf/i] },

  // --- line commands ---
  { id: "line-cmds-en", language: "en", feature: "line", intensity: "medium", input: "hi sam new paragraph the report is ready new line thanks", must: [/\n\n/, /ready[.!]?\nThanks/i], mustNot: [/new (line|paragraph)/i] },
  { id: "line-cmd2-en", language: "en", feature: "line", intensity: "medium", input: "the first box holds the cables new line the second box holds the adapters", must: [/cables[.]?\nThe second box/i], mustNot: [/new line/i] },
  { id: "line-cmds-es", language: "es", feature: "line", intensity: "medium", input: "hola ana nuevo párrafo el informe está listo nueva línea gracias", must: [/\n\n/, /listo[.!]?\nGracias/i], mustNot: [/nuev[oa] (p[aá]rrafo|l[ií]nea)/i] },
  { id: "line-aparte-es", language: "es", feature: "line", intensity: "medium", input: "la reunión terminó punto y aparte mañana enviamos el resumen", must: [/termin[oó]\.\n\nMa[nñ]ana/], mustNot: [/punto y aparte/i] },
  { id: "line-cmds-pt", language: "pt", feature: "line", intensity: "medium", input: "oi ana novo parágrafo o relatório está pronto nova linha obrigado", must: [/\n\n/, /pronto[.!]?\nObrigado/i], mustNot: [/nov[oa] (par[aá]grafo|linha)/i] },
  { id: "line-paragrafo-pt", language: "pt", feature: "line", intensity: "medium", input: "a reunião acabou ponto parágrafo amanhã mandamos o resumo", must: [/acabou\.\n\nAmanh[aã]/], mustNot: [/ponto par[aá]grafo/i] },

  // --- lists: bullets when nothing is counted (high), numbers when counted, quantities stay ---
  { id: "list-bullets-en", language: "en", feature: "list", intensity: "high", input: "a few things for tomorrow update the docs notify support and restart the server", must: [L(3), /docs/i, /support/i, /server/i], mustNot: [NUMBERED] },
  { id: "list-bullets-es", language: "es", feature: "list", intensity: "high", input: "unas cosas para mañana actualizar la documentación avisar a soporte y reiniciar el servidor", must: [L(3), /documentaci[oó]n/i, /soporte/i, /servidor/i], mustNot: [NUMBERED] },
  { id: "list-bullets-pt", language: "pt", feature: "list", intensity: "high", input: "umas coisas para amanhã atualizar a documentação avisar o suporte e reiniciar o servidor", must: [L(3), /documenta[cç][aã]o/i, /suporte/i, /servidor/i], mustNot: [NUMBERED] },
  { id: "list-counted-high-en", language: "en", feature: "list", intensity: "high", input: "one send the intro email two follow up with the prospect three log the call in the crm", must: [/^1\. /m, /^2\. /m, /^3\. /m], mustNot: [/^- /m] },
  { id: "list-enumeration-en", language: "en", feature: "list", intensity: "medium", input: "first book the room second send the invite third print the agenda", must: [/^1\. Book/m, /^2\. Send/m, /^3\. Print/m] },
  { id: "list-enumeration-es", language: "es", feature: "list", intensity: "medium", input: "primero reserva la sala segundo envía la invitación tercero imprime la agenda", must: [/^1\. Reserva/m, /^2\. Env[ií]a/m, /^3\. Imprime/m] },
  { id: "list-enumeration-pt", language: "pt", feature: "list", intensity: "medium", input: "primeiro reserva a sala segundo manda o convite terceiro imprime a pauta", must: [/^1\. Reserva/m, /^2\. Manda/m, /^3\. Imprime/m] },
  { id: "list-quantities-en", language: "en", feature: "list", intensity: "medium", input: "please order one cable two adapters and three batteries", must: [/\b1 cable/i, /\b2 adapters/i, /\b3 batteries/i], mustNot: [NUMBERED] },
  { id: "list-quantities-es", language: "es", feature: "list", intensity: "medium", input: "por favor pide un cable dos adaptadores y tres baterías", must: [/\b1 cable/i, /\b2 adaptadores/i, /\b3 bater[ií]as/i], mustNot: [NUMBERED] },
  { id: "list-quantities-pt", language: "pt", feature: "list", intensity: "medium", input: "por favor pede um cabo dois adaptadores e três baterias", must: [/\b1 cabo/i, /\b2 adaptadores/i, /\b3 baterias/i], mustNot: [NUMBERED] },

  // --- fragments: no forced period ---
  { id: "fragment-en", language: "en", feature: "fragment", intensity: "medium", input: "notes for tuesday", must: [/^Notes for Tuesday$/] },
  { id: "fragment2-en", language: "en", feature: "fragment", intensity: "medium", input: "grocery list", must: [/^Grocery list$/] },
  { id: "fragment-es", language: "es", feature: "fragment", intensity: "medium", input: "notas de la reunión", must: [/^Notas de la reuni[oó]n$/] },
  { id: "fragment-pt", language: "pt", feature: "fragment", intensity: "medium", input: "notas da reunião", must: [/^Notas da reuni[aã]o$/] },

  // --- tone (destination tone, medium intensity) ---
  { id: "tone-work-formal-en", language: "en", feature: "tone", intensity: "medium", tone: { destination: "work", workTone: "formal" }, input: "hey can u send me the numbers by tmrw thx", must: [/\byou\b/i, /tomorrow/i], mustNot: [/\bu\b|\bthx\b|\btmrw\b/i] },
  { id: "tone-very-casual-en", language: "en", feature: "tone", intensity: "medium", tone: { destination: "personal", personalTone: "very_casual" }, input: "are you still coming to dinner tonight", must: [/dinner tonight/], mustNot: [/^[A-Z]/, /[.?]$/] },
  { id: "tone-email-en", language: "en", feature: "tone", intensity: "medium", tone: { destination: "email", emailTone: "formal" }, input: "hi alex can you send me the latest version of the deck when you get a chance thanks", must: [/^(Hi|Hello|Dear) Alex,?\n\n/, /\n\n(Thanks|Thank you)[,.!]?$/] },
  { id: "tone-work-formal-es", language: "es", feature: "tone", intensity: "medium", tone: { destination: "work", workTone: "formal" }, input: "oye me pasas los números pa mañana porfa", must: [/ma[nñ]ana/i], mustNot: [/\bpa\b|porfa|\boye\b/i] },
  { id: "tone-very-casual-es", language: "es", feature: "tone", intensity: "medium", tone: { destination: "personal", personalTone: "very_casual" }, input: "nos vemos esta noche en el bar", must: [/bar/], mustNot: [/^[A-ZÁÉÍÓÚ]/, /[.]$/] },
  { id: "tone-work-formal-pt", language: "pt", feature: "tone", intensity: "medium", tone: { destination: "work", workTone: "formal" }, input: "e aí me passa os números pra amanhã por favor valeu", must: [/amanh[aã]/i, /n[uú]meros/i], mustNot: [/\bpra\b|valeu|e a[ií]/i] },
  { id: "tone-very-casual-pt", language: "pt", feature: "tone", intensity: "medium", tone: { destination: "personal", personalTone: "very_casual" }, input: "a gente se vê hoje à noite no bar", must: [/bar/], mustNot: [/^[A-ZÁÉÍÓÚ]/, /[.]$/] },
  { id: "tone-email-pt", language: "pt", feature: "tone", intensity: "medium", tone: { destination: "email", emailTone: "formal" }, input: "oi marcos pode me mandar a versão mais recente da apresentação quando puder obrigado", must: [/^(Oi|Olá|Prezado) Marcos,?\n\n/, /\n\n(Obrigad[oa]|Atenciosamente)[,.!]?$/] },

  // --- intensity ---
  { id: "intensity-low-en", language: "en", feature: "intensity", intensity: "low", input: "um so the reports was sent yesterday and uh we gonna review them", must: [/reports was sent/i, /gonna/], mustNot: [/\bum\b|\buh\b/i] },
  { id: "intensity-medium-en", language: "en", feature: "intensity", intensity: "medium", input: "um so the reports was sent yesterday and uh we gonna review them", must: [/reports were sent/i], mustNot: [/\bum\b|\buh\b/i] },
  { id: "intensity-high-en", language: "en", feature: "intensity", intensity: "high", input: "ok so basically what i'm saying is um we need to like ship the the beta this week but only if the the tests pass and uh if they don't pass then we wait till monday", must: [/beta/i, /this week/i, /tests pass/i, /monday/i, /only if|if the tests/i], mustNot: [/basically|what i'm saying|\blike\b|the the/i] },
  { id: "intensity-low-es", language: "es", feature: "intensity", intensity: "low", input: "eh los informes fue enviado ayer", must: [/informes fue enviado/i], mustNot: [/\beh\b/i] },
  { id: "intensity-medium-es", language: "es", feature: "intensity", intensity: "medium", input: "eh los informes fue enviado ayer", must: [/informes fueron enviados/i], mustNot: [/\beh\b/i] },
  { id: "intensity-high-es", language: "es", feature: "intensity", intensity: "high", input: "bueno o sea lo que digo es que tenemos que eh lanzar la beta esta semana pero solo si las pruebas pasan", must: [/beta/i, /esta semana/i, /pruebas/i, /solo si/i], mustNot: [/o sea|lo que digo/i] },
  { id: "intensity-low-pt", language: "pt", feature: "intensity", intensity: "low", input: "hum os relatórios foi enviado ontem", must: [/relat[oó]rios foi enviado/i], mustNot: [/\bhum\b/i] },
  { id: "intensity-medium-pt", language: "pt", feature: "intensity", intensity: "medium", input: "hum os relatórios foi enviado ontem", must: [/relat[oó]rios foram enviados/i], mustNot: [/\bhum\b/i] },
  { id: "intensity-high-pt", language: "pt", feature: "intensity", intensity: "high", input: "então tipo o que eu tô dizendo é que a gente precisa hum lançar o beta essa semana mas só se os testes passarem", must: [/beta/i, /(essa|esta) semana/i, /testes/i, /s[oó] se/i], mustNot: [/o que eu t[oô] dizendo|\btipo\b/i] },

  // --- mixed ---
  { id: "mixed-en", language: "en", feature: "mixed", intensity: "medium", input: "email sara at example dot com by march fifteenth at three pm new line thanks", must: [/sara@example\.com/i, /March 15(th)?/, /3 ?PM/i, /\nThanks/], mustNot: [/new line/i] },
  { id: "mixed-es", language: "es", feature: "mixed", intensity: "medium", input: "llama al seis uno dos tres cuatro cinco seis siete ocho antes del quince de marzo nueva línea gracias", must: [/612 ?34 ?56 ?78|612345678/, /15 de marzo/, /\nGracias/i], mustNot: [/nueva l[ií]nea/i] },
  { id: "mixed-pt", language: "pt", feature: "mixed", intensity: "medium", input: "manda para ana arroba exemplo ponto com até quinze de março às três nova linha obrigado", must: [/ana@exemplo\.com/i, /15 de março/, /\b3\b/, /\nObrigado/i], mustNot: [/nova linha/i] },
];
