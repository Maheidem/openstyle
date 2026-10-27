// The code stages of the dictation pipeline (specs/dictation-pipeline.md 4.2),
// in en, es and pt (owner decision 2026-10-27). Fictional text only.
import { describe, expect, it } from "vitest";
import { lostTokens } from "../src/lib/dictation/guard.js";
import {
  langOf,
  resolveDictationLanguage,
} from "../src/lib/dictation/language.js";
import { contactInfo } from "../src/lib/dictation/stages/contact.js";
import {
  contactEnd,
  fragments,
  lightFormat,
  listMarkers,
} from "../src/lib/dictation/stages/layout.js";
import { spokenNumbers } from "../src/lib/dictation/stages/numbers.js";
import {
  formatCountedList,
  joinParts,
  splitCountedList,
  splitLineCommands,
} from "../src/lib/dictation/stages/structure.js";

describe("language", () => {
  it("maps a code to its rule language; other languages have no rules", () => {
    expect(langOf("pt-BR")).toBe("pt");
    expect(langOf("es-MX")).toBe("es");
    expect(langOf("en")).toBe("en");
    expect(langOf("zh-Hans")).toBeNull();
    expect(langOf("de")).toBeNull();
  });

  it("one configured language wins, also for a text in another language", () => {
    expect(resolveDictationLanguage("hola ana", ["en"])).toEqual({
      rules: "en",
      llm: ["en"],
    });
  });

  it("detects en, es and pt among the configured languages", () => {
    const langs = ["en", "es", "pt-BR"];
    expect(resolveDictationLanguage("the meeting is on monday", langs)).toEqual(
      { rules: "en", llm: ["en"] },
    );
    expect(
      resolveDictationLanguage("la reunión es el lunes y mañana", langs).rules,
    ).toBe("es");
    expect(
      resolveDictationLanguage("a reunião é na segunda e não amanhã", langs),
    ).toEqual({ rules: "pt", llm: ["pt-BR"] });
  });

  it("gives no rules and the full list when a configured language has no rules", () => {
    expect(resolveDictationLanguage("the meeting", ["en", "de"])).toEqual({
      rules: null,
      llm: ["en", "de"],
    });
    expect(resolveDictationLanguage("你好", ["zh-Hans"])).toEqual({
      rules: null,
      llm: ["zh-Hans"],
    });
  });
});

describe("S1 line commands", () => {
  it("splits en, es and pt commands; paragraph gives a blank line", () => {
    expect(
      splitLineCommands(
        "hi sam new paragraph the report is ready new line thanks",
        "en",
      ),
    ).toEqual({
      parts: ["hi sam", "the report is ready", "thanks"],
      seps: ["\n\n", "\n"],
    });
    expect(
      splitLineCommands(
        "la reunión terminó punto y aparte mañana enviamos",
        "es",
      ),
    ).toEqual({
      parts: ["la reunión terminó", "mañana enviamos"],
      seps: ["\n\n"],
    });
    expect(
      splitLineCommands(
        "oi ana novo parágrafo o relatório está pronto nova linha obrigado",
        "pt",
      ),
    ).toEqual({
      parts: ["oi ana", "o relatório está pronto", "obrigado"],
      seps: ["\n\n", "\n"],
    });
    expect(
      splitLineCommands("a reunião acabou ponto parágrafo amanhã", "pt").seps,
    ).toEqual(["\n\n"]);
  });

  it("does not split a word that only contains a command", () => {
    expect(splitLineCommands("a renewed line of credit", "en").parts).toEqual([
      "a renewed line of credit",
    ]);
  });

  it("no language rules: one part", () => {
    expect(splitLineCommands("neue Zeile hallo", null)).toEqual({
      parts: ["neue Zeile hallo"],
      seps: [],
    });
  });

  it("joins parts and drops empty ones", () => {
    expect(joinParts(["A.", "", "B."], ["\n", "\n"])).toBe("A.\n\nB.");
    expect(joinParts(["", "B."], ["\n"])).toBe("B.");
  });
});

describe("S2 counted lists", () => {
  it("splits counted tasks in en, es and pt", () => {
    expect(
      splitCountedList(
        "one update the docs two notify support three restart the server",
        "en",
      ),
    ).toEqual({
      leadIn: "",
      items: ["update the docs", "notify support", "restart the server"],
    });
    expect(
      splitCountedList(
        "uno actualiza la documentacion dos avisa a soporte tres reinicia el servidor",
        "es",
      )?.items,
    ).toEqual([
      "actualiza la documentacion",
      "avisa a soporte",
      "reinicia el servidor",
    ]);
    expect(
      splitCountedList(
        "um atualize a documentação dois avise o suporte três reinicie o servidor",
        "pt",
      )?.items,
    ).toEqual([
      "atualize a documentação",
      "avise o suporte",
      "reinicie o servidor",
    ]);
  });

  it("splits ordinals in en, es and pt", () => {
    expect(splitCountedList("first wash second dry", "en")).toEqual({
      leadIn: "",
      items: ["wash", "dry"],
    });
    expect(
      splitCountedList(
        "primero reserva la sala segundo envía la invitación",
        "es",
      )?.items,
    ).toEqual(["reserva la sala", "envía la invitación"]);
    expect(
      splitCountedList("primeiro reserva a sala segundo manda o convite", "pt")
        ?.items,
    ).toEqual(["reserva a sala", "manda o convite"]);
  });

  it("keeps quantities as a sentence: a count before a plural noun is not a list", () => {
    expect(
      splitCountedList("i need one cable two adapters three batteries", "en"),
    ).toBeNull();
    expect(
      splitCountedList("necesito un cable dos adaptadores tres baterías", "es"),
    ).toBeNull();
    expect(
      splitCountedList(
        "preciso de um cabo dois adaptadores três baterias",
        "pt",
      ),
    ).toBeNull();
    expect(
      splitCountedList(
        "we need one new cable two new adapters three spare batteries",
        "en",
      ),
    ).toBeNull();
  });

  it("needs 3 plain numbers or 2 ordinals, in order, each with text", () => {
    expect(splitCountedList("one question and two issues", "en")).toBeNull();
    expect(splitCountedList("two apples three pears", "en")).toBeNull();
    expect(splitCountedList("one two three", "en")).toBeNull();
    // "segunda-feira" (Monday) is not the ordinal "segunda".
    expect(
      splitCountedList("primeiro a gente fala na segunda-feira", "pt"),
    ).toBeNull();
  });

  it("formats the list with a colon lead-in", () => {
    expect(formatCountedList("I need.", ["cable.", "adapters"])).toBe(
      "I need:\n\n1. Cable\n2. Adapters",
    );
    expect(formatCountedList("", ["atualize a documentação."])).toBe(
      "1. Atualize a documentação",
    );
  });
});

describe("S3 contact info", () => {
  it.each([
    [
      "email me at john dot smith at example dot com",
      "email me at john.smith@example.com",
    ],
    [
      "go to https colon slash slash api dot example dot com slash v1",
      "go to https://api.example.com/v1",
    ],
    [
      "the file lives at slash home slash user slash notes dot txt",
      "the file lives at /home/user/notes.txt",
    ],
    [
      "rename it to report underscore final dot pdf",
      "rename it to report_final.pdf",
    ],
    [
      "send it to sara at example dot com no wait example dot org",
      "send it to sara@example.org",
    ],
    [
      "escríbeme a ana punto lopez arroba ejemplo punto com",
      "escríbeme a ana.lopez@ejemplo.com",
    ],
    [
      "la página es www punto ejemplo punto es barra precios",
      "la página es www.ejemplo.es/precios",
    ],
    [
      "me escreve no joao ponto silva arroba exemplo ponto com ponto br",
      "me escreve no joao.silva@exemplo.com.br",
    ],
    [
      "o site é www ponto exemplo ponto com ponto br barra precos",
      "o site é www.exemplo.com.br/precos",
    ],
    [
      "renomeia para relatorio underline final ponto pdf",
      "renomeia para relatorio_final.pdf",
    ],
    [
      "manda para ana arroba exemplo ponto com não espera exemplo ponto org",
      "manda para ana@exemplo.org",
    ],
  ])("%s", (input, expected) => {
    expect(contactInfo(input)).toBe(expected);
  });

  it("keeps words that are not contact info", () => {
    for (const t of [
      "meet me at x dot y",
      "i will be at home",
      "look at this",
      "esse é o ponto principal",
      "a gente se vê no ponto de ônibus",
    ]) {
      expect(contactInfo(t)).toBe(t);
    }
  });

  it("is idempotent", () => {
    const once = contactInfo("email sara at example dot com");
    expect(contactInfo(once)).toBe(once);
  });
});

describe("S4 numbers are digits", () => {
  it.each([
    [
      "the meeting is march fifteenth at three pm",
      "the meeting is March 15th at 3 PM",
    ],
    ["it costs twenty five dollars", "it costs 25 dollars"],
    ["at nine thirty am no wait ten thirty am", "at 9:30 AM no wait 10:30 AM"],
    ["we grew by twelve percent", "we grew by 12%"],
    [
      "the budget is three thousand five hundred euros",
      "the budget is 3,500 euros",
    ],
    ["on june twenty first two thousand twenty seven", "on June 21st, 2027"],
    ["call me at five five five one two three four", "call me at 555-1234"],
    ["four one five five five five zero one nine nine", "415-555-0199"],
    ["let's meet friday at three", "let's meet friday at 3"],
    ["we meet at three thirty", "we meet at 3:30"],
    [
      "i need two adapters and twenty one cables",
      "i need 2 adapters and 21 cables",
    ],
    [
      "please order one cable two adapters and three batteries",
      "please order 1 cable 2 adapters and 3 batteries",
    ],
    ["back in twenty twenty six", "back in 2026"],
    ["it grew two point five times", "it grew 2.5 times"],
    ["a hundred people came", "100 people came"],
  ])("en: %s", (input, expected) => {
    expect(spokenNumbers(input, "en")).toBe(expected);
  });

  it.each([
    [
      "el quince de marzo a las tres de la tarde",
      "el 15 de marzo a las 3 de la tarde",
    ],
    ["cuesta veinticinco dólares", "cuesta 25 dólares"],
    ["tres mil quinientos euros y un doce por ciento", "3500 euros y un 12 %"],
    ["el primero de abril a las nueve y media", "el 1 de abril a las 9:30"],
    ["seis uno dos tres cuatro cinco seis siete ocho", "612 34 56 78"],
    ["reunámonos el viernes a las tres", "reunámonos el viernes a las 3"],
    ["somos veinte mil personas", "somos 20.000 personas"],
    [
      "pide un cable dos adaptadores y tres baterías",
      "pide 1 cable 2 adaptadores y 3 baterías",
    ],
    ["ciento veinte personas", "120 personas"],
  ])("es: %s", (input, expected) => {
    expect(spokenNumbers(input, "es")).toBe(expected);
  });

  it.each([
    [
      "a reunião é no dia quinze de março às três da tarde",
      "a reunião é no dia 15 de março às 3 da tarde",
    ],
    ["custa vinte e cinco reais", "custa 25 reais"],
    [
      "o orçamento é de três mil e quinhentos reais e crescemos doze por cento",
      "o orçamento é de 3.500 reais e crescemos 12%",
    ],
    [
      "o voo sai no primeiro de abril às nove e meia",
      "o voo sai no 1º de abril às 9:30",
    ],
    [
      "meu celular é nove oito sete seis cinco quatro três dois um",
      "meu celular é 98765-4321",
    ],
    ["onze nove oito sete seis cinco meia quatro três dois", "11 98765-6432"],
    ["cento e vinte e cinco pessoas", "125 pessoas"],
    [
      "pede um cabo dois adaptadores e três baterias",
      "pede 1 cabo 2 adaptadores e 3 baterias",
    ],
    ["às dez e quinze", "às 10:15"],
    ["dois vírgula cinco", "2,5"],
  ])("pt: %s", (input, expected) => {
    expect(spokenNumbers(input, "pt")).toBe(expected);
  });

  it("keeps the words that are not counts", () => {
    for (const [t, lang] of [
      ["no one knows", "en"],
      ["one of them is the second item", "en"],
      ["may i come", "en"],
      ["un café y mil gracias", "es"],
      ["un día de estos", "es"],
      ["um dia desses", "pt"],
      ["mil vezes obrigado", "pt"],
      ["o segundo item", "pt"],
      ["as três opções", "pt"],
    ] as const) {
      expect(spokenNumbers(t, lang)).toBe(
        t === "as três opções" ? "as 3 opções" : t,
      );
    }
  });

  it("no rules for the language: no change; empty text stays empty", () => {
    expect(spokenNumbers("zwei Kabel", null)).toBe("zwei Kabel");
    expect(spokenNumbers("", "en")).toBe("");
  });

  it("is idempotent", () => {
    for (const [t, lang] of [
      ["march fifteenth at three pm costs twenty dollars", "en"],
      ["el quince de marzo a las tres", "es"],
      ["quinze de março às três custa vinte reais", "pt"],
    ] as const) {
      const once = spokenNumbers(t, lang);
      expect(spokenNumbers(once, lang)).toBe(once);
    }
  });
});

describe("layout", () => {
  it("light format: fillers out, capitals, I, final period; no grammar fix", () => {
    expect(
      lightFormat("um so the reports was sent and uh i'm done", "en"),
    ).toBe("So the reports was sent and I'm done.");
    expect(lightFormat("eh los informes fue enviado ayer", "es")).toBe(
      "Los informes fue enviado ayer.",
    );
    expect(lightFormat("hum os relatórios foi enviado ontem", "pt")).toBe(
      "Os relatórios foi enviado ontem.",
    );
    expect(lightFormat("it grew 12%", "en")).toBe("It grew 12%.");
    expect(lightFormat("Done?", "en")).toBe("Done?");
  });

  it("S8: numbered becomes bullets only when nothing was counted", () => {
    const list = "Things:\n\n1. Docs\n2. Support";
    expect(listMarkers(list, "things docs and support", "en")).toBe(
      "Things:\n\n- Docs\n- Support",
    );
    expect(listMarkers(list, "one docs two support", "en")).toBe(list);
    expect(listMarkers(list, "um docs dois suporte", "pt")).toBe(list);
    expect(listMarkers("Plain text.", "plain text", "en")).toBe("Plain text.");
  });

  it("S9: no final period for 3 words or less, unless the text has a digit", () => {
    expect(fragments("Notes for Tuesday.", "notes for tuesday")).toBe(
      "Notes for Tuesday",
    );
    expect(fragments("Notas da reunião.", "notas da reunião")).toBe(
      "Notas da reunião",
    );
    expect(fragments("Cuesta 25 dólares.", "cuesta veinticinco dólares")).toBe(
      "Cuesta 25 dólares.",
    );
    expect(fragments("Notes for the meeting.", "notes for the meeting")).toBe(
      "Notes for the meeting.",
    );
    expect(fragments("Hi. Bye.", "hi bye")).toBe("Hi. Bye.");
    expect(fragments("A.\nB.", "a b")).toBe("A.\nB.");
  });
});

describe("guard", () => {
  it("finds lost numbers, contact forms and date words", () => {
    expect(
      lostTokens(
        "Call 555-1234 or sara@example.com tomorrow.",
        "Call later.",
        "en",
      ),
    ).toEqual(["555-1234", "sara@example.com", "tomorrow"]);
    expect(
      lostTokens("Me passa os números amanhã.", "Me passa os números.", "pt"),
    ).toEqual(["amanhã"]);
    expect(
      lostTokens("Nos vemos el viernes.", "Nos vemos pronto.", "es"),
    ).toEqual(["viernes"]);
  });

  it("accepts the same facts in other words and case", () => {
    expect(
      lostTokens("Ship it Monday at 3 PM.", "ship it monday at 3pm", "en"),
    ).toEqual([]);
    expect(
      lostTokens("Envia na sexta.", "Por favor, envie na Sexta.", "pt"),
    ).toEqual([]);
  });
});

describe("contact end", () => {
  it("drops a period that follows a contact form at the end", () => {
    expect(contactEnd("Go to https://api.example.com/v1.")).toBe(
      "Go to https://api.example.com/v1",
    );
    expect(contactEnd("Write to sara@example.com.")).toBe(
      "Write to sara@example.com",
    );
    expect(contactEnd("Open /home/user/notes.txt.")).toBe(
      "Open /home/user/notes.txt",
    );
  });

  it("keeps other periods", () => {
    for (const t of [
      "It costs $3.50.",
      "See you at 3 PM.",
      "Done etc.",
      "Hi.",
    ]) {
      expect(contactEnd(t)).toBe(t);
    }
  });
});
