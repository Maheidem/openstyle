// The code stages of the dictation pipeline (specs/dictation-pipeline.md 4.2),
// in en, es and zh. Fictional text only.
import { describe, expect, it } from "vitest";
import { lostTokens } from "../src/lib/dictation/guard.js";
import {
  langOf,
  resolveDictationLanguage,
} from "../src/lib/dictation/language.js";
import { contactInfo } from "../src/lib/dictation/stages/contact.js";
import {
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
  it("maps a code to its rule language", () => {
    expect(langOf("zh-Hans")).toBe("zh");
    expect(langOf("es-MX")).toBe("es");
    expect(langOf("de")).toBeNull();
  });

  it("one configured language wins, also for a text in another language", () => {
    expect(resolveDictationLanguage("hola ana", ["en"])).toEqual({
      rules: "en",
      llm: ["en"],
    });
  });

  it("detects zh, es and en among the configured languages", () => {
    const langs = ["en", "es", "zh-Hans"];
    expect(resolveDictationLanguage("你好世界", langs).rules).toBe("zh");
    expect(resolveDictationLanguage("你好世界", langs).llm).toEqual([
      "zh-Hans",
    ]);
    expect(
      resolveDictationLanguage("la reunión es el lunes", langs).rules,
    ).toBe("es");
    expect(
      resolveDictationLanguage("the meeting is on monday", langs).rules,
    ).toBe("en");
  });

  it("gives no rules and the full list when a configured language has no rules", () => {
    expect(resolveDictationLanguage("the meeting", ["en", "de"])).toEqual({
      rules: null,
      llm: ["en", "de"],
    });
  });
});

describe("S1 line commands", () => {
  it("splits en, es and zh commands; paragraph gives a blank line", () => {
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
    expect(splitLineCommands("你好新段落报告好了换行谢谢", "zh")).toEqual({
      parts: ["你好", "报告好了", "谢谢"],
      seps: ["\n\n", "\n"],
    });
  });

  it("does not split a word that only contains a command", () => {
    expect(splitLineCommands("the newline character", "en").parts).toHaveLength(
      2,
    );
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
  it("splits counted items in en, es and zh", () => {
    expect(
      splitCountedList("i need one cable two adapters three batteries", "en"),
    ).toEqual({ leadIn: "i need", items: ["cable", "adapters", "batteries"] });
    expect(
      splitCountedList("necesito un cable dos adaptadores tres baterias", "es"),
    ).toEqual({
      leadIn: "necesito",
      items: ["cable", "adaptadores", "baterias"],
    });
    expect(splitCountedList("第一更新文档第二通知支持", "zh")).toEqual({
      leadIn: "",
      items: ["更新文档", "通知支持"],
    });
    expect(splitCountedList("我需要一个线缆两个适配器三个电池", "zh")).toEqual({
      leadIn: "我需要",
      items: ["线缆", "适配器", "电池"],
    });
  });

  it("needs 3 plain numbers or 2 ordinals, in order, each with text", () => {
    expect(splitCountedList("one question and two issues", "en")).toBeNull();
    expect(splitCountedList("two apples three pears", "en")).toBeNull();
    expect(splitCountedList("first wash second dry", "en")).toEqual({
      leadIn: "",
      items: ["wash", "dry"],
    });
    expect(splitCountedList("one two three", "en")).toBeNull();
    expect(splitCountedList("我有一个问题", "zh")).toBeNull();
  });

  it("formats the list with a colon lead-in", () => {
    expect(formatCountedList("I need.", ["cable.", "adapters"], "en")).toBe(
      "I need:\n\n1. Cable\n2. Adapters",
    );
    expect(formatCountedList("", ["更新文档。"], "zh")).toBe("1. 更新文档");
    expect(formatCountedList("我需要", ["线缆"], "zh")).toBe(
      "我需要：\n\n1. 线缆",
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
      "我的邮箱是 zhang dot wei at example dot com",
      "我的邮箱是 zhang.wei@example.com",
    ],
    ["网址是 www 点 example 点 com", "网址是 www.example.com"],
  ])("%s", (input, expected) => {
    expect(contactInfo(input)).toBe(expected);
  });

  it("keeps words that are not contact info", () => {
    for (const t of [
      "meet me at x dot y",
      "i will be at home",
      "look at this",
      "三点开会",
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
  ])("es: %s", (input, expected) => {
    expect(spokenNumbers(input, "es")).toBe(expected);
  });

  it.each([
    ["会议在三月十五号下午三点", "会议在3月15号下午3点"],
    ["这个要二十五块钱", "这个要25块钱"],
    ["预算是三千五百元增长了百分之十二", "预算是3500元增长了12%"],
    ["二零二七年六月二十一号早上九点半", "2027年6月21号早上9点半"],
    ["一三八零零一三八零零零", "13800138000"],
    ["两个适配器和十分钟", "2个适配器和10分钟"],
    ["周五三点见", "周五3点见"],
  ])("zh: %s", (input, expected) => {
    expect(spokenNumbers(input, "zh")).toBe(expected);
  });

  it("keeps the words that are not counts", () => {
    for (const [t, lang] of [
      ["no one knows", "en"],
      ["one of them is the second item", "en"],
      ["may i come", "en"],
      ["un café y mil gracias", "es"],
      ["这个十分好", "zh"],
      ["好一点", "zh"],
      ["一个三明治", "zh"],
      ["第二个问题", "zh"],
      ["一两个人", "zh"],
    ] as const) {
      expect(spokenNumbers(t, lang)).toBe(t);
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
      ["三月十五号下午三点两个人", "zh"],
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
    expect(lightFormat("呃我们明天开会", "zh")).toBe("我们明天开会。");
    expect(lightFormat("it grew 12%", "en")).toBe("It grew 12%.");
    expect(lightFormat("Done?", "en")).toBe("Done?");
  });

  it("S8: numbered becomes bullets only when nothing was counted", () => {
    const list = "Things:\n\n1. Docs\n2. Support";
    expect(listMarkers(list, "things docs and support", "en")).toBe(
      "Things:\n\n- Docs\n- Support",
    );
    expect(listMarkers(list, "one docs two support", "en")).toBe(list);
    expect(listMarkers("Plain text.", "plain text", "en")).toBe("Plain text.");
  });

  it("S9: no final period for 3 words or less (zh: 6 characters or less)", () => {
    expect(fragments("Notes for Tuesday.", "notes for tuesday", "en")).toBe(
      "Notes for Tuesday",
    );
    expect(fragments("会议记录。", "会议记录", "zh")).toBe("会议记录");
    expect(
      fragments("Notes for the meeting.", "notes for the meeting", "en"),
    ).toBe("Notes for the meeting.");
    expect(fragments("Hi. Bye.", "hi bye", "en")).toBe("Hi. Bye.");
    expect(fragments("A.\nB.", "a b", "en")).toBe("A.\nB.");
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
    expect(lostTokens("把数字明天发我。", "请把数字发给我。", "zh")).toEqual([
      "明天",
    ]);
  });

  it("accepts the same facts in other words and case", () => {
    expect(
      lostTokens("Ship it Monday at 3 PM.", "ship it monday at 3pm", "en"),
    ).toEqual([]);
    expect(lostTokens("我们这周发布。", "我们本周发布。", "zh")).toEqual([]);
    expect(lostTokens("周三见", "星期三见", "zh")).toEqual([]);
  });
});
