// Fictional dictation cases for the staged pipeline (specs/dictation-pipeline.md
// 7). Each case has its intensity, an optional destination tone, and regex
// checks: every `must` matches and no `mustNot` matches. Numbers are digits
// (owner rule 2026-10-26). Written for the research spike; they test the new
// stages, so they favour the pipeline (spec 10 item 4).

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
  language: "en" | "es" | "zh-Hans";
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

export const DICTATION_PIPELINE_CASES: PipelineCase[] = [
  // --- dates, times, money, percent ---
  {
    id: "itn-date-time-en",
    language: "en",
    feature: "itn",
    intensity: "medium",
    input: "the meeting is march fifteenth at three pm",
    must: [/March 15(th)?/, /3 ?(PM|p\.m\.|pm)/i],
    mustNot: [/fifteen/i, /three/i],
  },
  {
    id: "itn-money-en",
    language: "en",
    feature: "itn",
    intensity: "medium",
    input: "it costs twenty five dollars for the upgrade",
    must: [/(25 dollars|\$25)/],
    mustNot: [/twenty/i],
  },
  {
    id: "itn-correction-time-en",
    language: "en",
    feature: "itn",
    intensity: "medium",
    input:
      "the deadline is october third at nine thirty am no wait ten thirty am",
    must: [/October 3(rd)?/, /10:30 ?(AM|a\.m\.|am)/i],
    mustNot: [/9:30|nine/i],
  },
  {
    id: "itn-percent-amount-en",
    language: "en",
    feature: "itn",
    intensity: "medium",
    input:
      "we grew by twelve percent and the budget is three thousand five hundred euros",
    must: [/12 ?(%|percent)/, /(3,?500 euros|€ ?3,?500)/],
    mustNot: [/twelve|thousand/i],
  },
  {
    id: "itn-year-en",
    language: "en",
    feature: "itn",
    intensity: "medium",
    input: "the party is on june twenty first two thousand twenty seven",
    must: [/June 21(st)?,? 2027/],
    mustNot: [/twenty/i],
  },
  {
    id: "itn-date-time-es",
    language: "es",
    feature: "itn",
    intensity: "medium",
    input: "la reunión es el quince de marzo a las tres de la tarde",
    must: [/15 de marzo/, /(3 de la tarde|15:00|3 ?p\.? ?m\.?)/i],
    mustNot: [/quince|tres/i],
  },
  {
    id: "itn-money-es",
    language: "es",
    feature: "itn",
    intensity: "medium",
    input: "cuesta veinticinco dólares",
    must: [/(25 d[oó]lares|\$ ?25|25 ?\$)/],
    mustNot: [/veinticinco/i],
  },
  {
    id: "itn-percent-amount-es",
    language: "es",
    feature: "itn",
    intensity: "medium",
    input:
      "el presupuesto es de tres mil quinientos euros y crecimos un doce por ciento",
    must: [/3[. ]?500 (euros|€)/, /12 ?(%|por ciento)/],
    mustNot: [/quinientos|doce/i],
  },
  {
    id: "itn-date-time2-es",
    language: "es",
    feature: "itn",
    intensity: "medium",
    input: "el vuelo sale el primero de abril a las nueve y media de la mañana",
    must: [/1\.?º? de abril/, /9:30/],
    mustNot: [/primero|nueve/i],
  },
  {
    id: "itn-date-time-zh",
    language: "zh-Hans",
    feature: "itn",
    intensity: "medium",
    input: "会议在三月十五号下午三点",
    must: [/3月15[号日]/, /下午(3|三)点|15:00/],
    mustNot: [/三月|十五/],
  },
  {
    id: "itn-money-zh",
    language: "zh-Hans",
    feature: "itn",
    intensity: "medium",
    input: "这个要二十五块钱",
    must: [/25块钱?|25元/],
    mustNot: [/二十五/],
  },
  {
    id: "itn-percent-amount-zh",
    language: "zh-Hans",
    feature: "itn",
    intensity: "medium",
    input: "预算是三千五百元增长了百分之十二",
    must: [/3,?500元/, /12 ?%/],
    mustNot: [/三千|百分之/],
  },
  {
    id: "itn-year-zh",
    language: "zh-Hans",
    feature: "itn",
    intensity: "medium",
    input: "航班是二零二七年六月二十一号早上九点半",
    must: [/2027年6月21[号日]/, /(9:30|9点半)/],
    mustNot: [/二零|九点/],
  },

  // --- contact info and symbols ---
  {
    id: "contact-email-en",
    language: "en",
    feature: "contact",
    intensity: "medium",
    input: "email me at john dot smith at example dot com about the launch",
    must: [/john\.smith@example\.com/i],
    mustNot: [/\bdot\b/i],
  },
  {
    id: "contact-url-en",
    language: "en",
    feature: "contact",
    intensity: "medium",
    input: "go to https colon slash slash api dot example dot com slash v1",
    must: [/https:\/\/api\.example\.com\/v1/],
  },
  {
    id: "contact-path-en",
    language: "en",
    feature: "contact",
    intensity: "medium",
    input: "the file lives at slash home slash user slash notes dot txt",
    must: [/\/home\/user\/notes\.txt/],
  },
  {
    id: "contact-phone7-en",
    language: "en",
    feature: "contact",
    intensity: "medium",
    input: "call me at five five five one two three four",
    must: [/555-?1234/],
  },
  {
    id: "contact-phone10-en",
    language: "en",
    feature: "contact",
    intensity: "medium",
    input: "my number is four one five five five five zero one nine nine",
    must: [/(415-?555-?0199|\(415\) ?555-0199)/],
  },
  {
    id: "contact-email-correction-en",
    language: "en",
    feature: "contact",
    intensity: "medium",
    input:
      "send the contract to sara at example dot com no wait example dot org",
    must: [/sara@example\.org/i],
    mustNot: [/example\.com/i],
  },
  {
    id: "contact-filename-en",
    language: "en",
    feature: "contact",
    intensity: "medium",
    input: "rename the file to report underscore final dot pdf",
    must: [/report_final\.pdf/i],
  },
  {
    id: "contact-email-es",
    language: "es",
    feature: "contact",
    intensity: "medium",
    input: "escríbeme a ana punto lopez arroba ejemplo punto com",
    must: [/ana\.lopez@ejemplo\.com/i],
  },
  {
    id: "contact-phone-es",
    language: "es",
    feature: "contact",
    intensity: "medium",
    input: "mi teléfono es seis uno dos tres cuatro cinco seis siete ocho",
    must: [/612 ?34 ?56 ?78|612 ?345 ?678/],
  },
  {
    id: "contact-url-es",
    language: "es",
    feature: "contact",
    intensity: "medium",
    input: "la página es www punto ejemplo punto es barra precios",
    must: [/www\.ejemplo\.es\/precios/i],
  },
  {
    id: "contact-email-zh",
    language: "zh-Hans",
    feature: "contact",
    intensity: "medium",
    input: "我的邮箱是 zhang dot wei at example dot com",
    must: [/zhang\.wei@example\.com/i],
  },
  {
    id: "contact-phone-zh",
    language: "zh-Hans",
    feature: "contact",
    intensity: "medium",
    input: "我的手机号是一三八零零一三八零零零",
    must: [/138[ -]?0013[ -]?8000/],
  },
  {
    id: "contact-url-zh",
    language: "zh-Hans",
    feature: "contact",
    intensity: "medium",
    input: "网址是 www 点 example 点 com",
    must: [/www\.example\.com/i],
  },

  // --- line commands ---
  {
    id: "line-cmds-en",
    language: "en",
    feature: "line",
    intensity: "medium",
    input: "hi sam new paragraph the report is ready new line thanks",
    must: [/\n\n/, /ready[.!]?\nThanks/i],
    mustNot: [/new (line|paragraph)/i],
  },
  {
    id: "line-cmd2-en",
    language: "en",
    feature: "line",
    intensity: "medium",
    input:
      "the first box holds the cables new line the second box holds the adapters",
    must: [/cables[.]?\nThe second box/i],
    mustNot: [/new line/i],
  },
  {
    id: "line-cmds-es",
    language: "es",
    feature: "line",
    intensity: "medium",
    input: "hola ana nuevo párrafo el informe está listo nueva línea gracias",
    must: [/\n\n/, /listo[.!]?\nGracias/i],
    mustNot: [/nuev[oa] (p[aá]rrafo|l[ií]nea)/i],
  },
  {
    id: "line-aparte-es",
    language: "es",
    feature: "line",
    intensity: "medium",
    input: "la reunión terminó punto y aparte mañana enviamos el resumen",
    must: [/termin[oó]\.\n\nMa[nñ]ana/],
    mustNot: [/punto y aparte/i],
  },
  {
    id: "line-cmds-zh",
    language: "zh-Hans",
    feature: "line",
    intensity: "medium",
    input: "你好新段落报告已经好了换行谢谢",
    must: [/\n\n/, /\n谢谢/],
    mustNot: [/新段落|换行/],
  },

  // --- lists: bullets when nothing is counted (high), numbers when counted ---
  {
    id: "list-bullets-en",
    language: "en",
    feature: "list",
    intensity: "high",
    input:
      "a few things for tomorrow update the docs notify support and restart the server",
    must: [L(3), /docs/i, /support/i, /server/i],
    mustNot: [/^\s*\d+\./m],
  },
  {
    id: "list-bullets-es",
    language: "es",
    feature: "list",
    intensity: "high",
    input:
      "unas cosas para mañana actualizar la documentación avisar a soporte y reiniciar el servidor",
    must: [L(3), /documentaci[oó]n/i, /soporte/i, /servidor/i],
    mustNot: [/^\s*\d+\./m],
  },
  {
    id: "list-bullets-zh",
    language: "zh-Hans",
    feature: "list",
    intensity: "high",
    input: "明天要做几件事更新文档通知支持重启服务器",
    must: [L(3), /文档/, /支持/, /服务器/],
    mustNot: [/^\s*\d+[.．、]/m],
  },
  {
    id: "list-counted-high-en",
    language: "en",
    feature: "list",
    intensity: "high",
    input:
      "one send the intro email two follow up with the prospect three log the call in the crm",
    must: [/^1\. /m, /^2\. /m, /^3\. /m],
    mustNot: [/^- /m],
  },

  // --- fragments: no forced period ---
  {
    id: "fragment-en",
    language: "en",
    feature: "fragment",
    intensity: "medium",
    input: "notes for tuesday",
    must: [/^Notes for Tuesday$/],
  },
  {
    id: "fragment2-en",
    language: "en",
    feature: "fragment",
    intensity: "medium",
    input: "grocery list",
    must: [/^Grocery list$/],
  },
  {
    id: "fragment-es",
    language: "es",
    feature: "fragment",
    intensity: "medium",
    input: "notas de la reunión",
    must: [/^Notas de la reuni[oó]n$/],
  },
  {
    id: "fragment-zh",
    language: "zh-Hans",
    feature: "fragment",
    intensity: "medium",
    input: "会议记录",
    must: [/^会议记录$/],
  },

  // --- tone (destination tone, medium intensity) ---
  {
    id: "tone-work-formal-en",
    language: "en",
    feature: "tone",
    intensity: "medium",
    tone: { destination: "work", workTone: "formal" },
    input: "hey can u send me the numbers by tmrw thx",
    must: [/\byou\b/i, /tomorrow/i],
    mustNot: [/\bu\b|\bthx\b|\btmrw\b/i],
  },
  {
    id: "tone-very-casual-en",
    language: "en",
    feature: "tone",
    intensity: "medium",
    tone: { destination: "personal", personalTone: "very_casual" },
    input: "are you still coming to dinner tonight",
    must: [/dinner tonight/],
    mustNot: [/^[A-Z]/, /[.?]$/],
  },
  {
    id: "tone-email-en",
    language: "en",
    feature: "tone",
    intensity: "medium",
    tone: { destination: "email", emailTone: "formal" },
    input:
      "hi alex can you send me the latest version of the deck when you get a chance thanks",
    must: [/^(Hi|Hello|Dear) Alex,?\n\n/, /\n\n(Thanks|Thank you)[,.!]?$/],
  },
  {
    id: "tone-work-formal-es",
    language: "es",
    feature: "tone",
    intensity: "medium",
    tone: { destination: "work", workTone: "formal" },
    input: "oye me pasas los números pa mañana porfa",
    must: [/ma[nñ]ana/i],
    mustNot: [/\bpa\b|porfa|\boye\b/i],
  },
  {
    id: "tone-very-casual-es",
    language: "es",
    feature: "tone",
    intensity: "medium",
    tone: { destination: "personal", personalTone: "very_casual" },
    input: "nos vemos esta noche en el bar",
    must: [/bar/],
    mustNot: [/^[A-ZÁÉÍÓÚ]/, /[.]$/],
  },
  {
    id: "tone-work-formal-zh",
    language: "zh-Hans",
    feature: "tone",
    intensity: "medium",
    tone: { destination: "work", workTone: "formal" },
    input: "嘿把那个数字明天发我呗",
    must: [/明天/, /数字|数据/],
    mustNot: [/呗|嘿/],
  },

  // --- intensity ---
  {
    id: "intensity-low-en",
    language: "en",
    feature: "intensity",
    intensity: "low",
    input: "um so the reports was sent yesterday and uh we gonna review them",
    must: [/reports was sent/i, /gonna/],
    mustNot: [/\bum\b|\buh\b/i],
  },
  {
    id: "intensity-medium-en",
    language: "en",
    feature: "intensity",
    intensity: "medium",
    input: "um so the reports was sent yesterday and uh we gonna review them",
    must: [/reports were sent/i],
    mustNot: [/\bum\b|\buh\b/i],
  },
  {
    id: "intensity-high-en",
    language: "en",
    feature: "intensity",
    intensity: "high",
    input:
      "ok so basically what i'm saying is um we need to like ship the the beta this week but only if the the tests pass and uh if they don't pass then we wait till monday",
    must: [
      /beta/i,
      /this week/i,
      /tests pass/i,
      /monday/i,
      /only if|if the tests/i,
    ],
    mustNot: [/basically|what i'm saying|\blike\b|the the/i],
  },
  {
    id: "intensity-low-es",
    language: "es",
    feature: "intensity",
    intensity: "low",
    input: "eh los informes fue enviado ayer",
    must: [/informes fue enviado/i],
    mustNot: [/\beh\b/i],
  },
  {
    id: "intensity-medium-es",
    language: "es",
    feature: "intensity",
    intensity: "medium",
    input: "eh los informes fue enviado ayer",
    must: [/informes fueron enviados/i],
    mustNot: [/\beh\b/i],
  },
  {
    id: "intensity-high-es",
    language: "es",
    feature: "intensity",
    intensity: "high",
    input:
      "bueno o sea lo que digo es que tenemos que eh lanzar la beta esta semana pero solo si las pruebas pasan",
    must: [/beta/i, /esta semana/i, /pruebas/i, /solo si/i],
    mustNot: [/o sea|lo que digo/i],
  },
  {
    id: "intensity-high-zh",
    language: "zh-Hans",
    feature: "intensity",
    intensity: "high",
    input: "就是说嗯我们这周得发布那个测试版但是前提是测试都通过",
    must: [/测试版/, /这周|本周/, /通过/],
    mustNot: [/就是说|嗯/],
  },

  // --- mixed ---
  {
    id: "mixed-en",
    language: "en",
    feature: "mixed",
    intensity: "medium",
    input:
      "email sara at example dot com by march fifteenth at three pm new line thanks",
    must: [/sara@example\.com/i, /March 15(th)?/, /3 ?PM/i, /\nThanks/],
    mustNot: [/new line/i],
  },
  {
    id: "mixed-es",
    language: "es",
    feature: "mixed",
    intensity: "medium",
    input:
      "llama al seis uno dos tres cuatro cinco seis siete ocho antes del quince de marzo nueva línea gracias",
    must: [/612 ?34 ?56 ?78|612345678/, /15 de marzo/, /\nGracias/i],
    mustNot: [/nueva l[ií]nea/i],
  },
];
