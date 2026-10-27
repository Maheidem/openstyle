// Code stage S3 (specs/dictation-pipeline.md 4.2): spoken contact info and
// symbols become their written form: emails, URLs, domains, file names and
// paths. The rules read the en, es and pt spoken words for "dot", "at",
// "slash", "underscore" and "dash". A form needs a known last label (a TLD or
// a file type), so "meet me at x dot y" stays words. Phone numbers are digits:
// the numbers stage (S4) owns them.

const TLDS = [
  "com",
  "org",
  "net",
  "io",
  "dev",
  "ai",
  "app",
  "co",
  "uk",
  "us",
  "es",
  "mx",
  "ar",
  "cl",
  "br",
  "de",
  "fr",
  "it",
  "cn",
  "jp",
  "edu",
  "gov",
  "info",
  "me",
  "tv",
];
const FILE_TYPES = [
  "txt",
  "pdf",
  "md",
  "json",
  "csv",
  "ts",
  "js",
  "py",
  "html",
  "docx",
  "xlsx",
  "pptx",
  "png",
  "jpg",
  "zip",
  "yaml",
  "yml",
  "sh",
  "log",
];
const LAST_LABEL = [...TLDS, ...FILE_TYPES].join("|");
const WEB_END = new RegExp(`\\.(${TLDS.join("|")})$`, "i");
/** Country TLDs that are also common words in en, es or pt. */
const AMBIGUOUS_TLD = new Set(
  "de es it me us co ar cl br mx fr ai tv uk cn jp".split(" "),
);

const DOT = "(?:\\s+(?:dot|punto|ponto)\\s+)";
const AT = "(?:\\s+(?:at|arroba)\\s+|\\s*@\\s*)";
const ATOM = "[A-Za-z0-9][A-Za-z0-9_\\-]*";
const DOT_RE = new RegExp(DOT, "giu");

/** First words of a spoken "x at y dot com" that are not an email local part. */
const EMAIL_STOP = new Set([
  "me",
  "us",
  "him",
  "her",
  "them",
  "you",
  "it",
  "i",
  "we",
  "home",
  "work",
  "look",
  "is",
  "are",
  "was",
  "be",
  "meet",
  "arrive",
  "leave",
  "office",
]);

/** Correction cues inside contact info: "a@b.com no wait b.org". */
const CUE =
  "(?:no wait|wait no|no espera|espera no|actually no|no actually|actually|i mean|sorry|wait|no|en realidad no|en realidad|mejor|perd[oó]n|n[aã]o espera|espera n[aã]o|na verdade|ali[aá]s|quer dizer|n[aã]o)";

const joinDots = (s: string) => s.replace(DOT_RE, ".");

/** S3: write spoken contact info and symbols in their written form. */
export function contactInfo(text: string): string {
  let out = text;
  // "https colon slash slash"
  out = out.replace(
    /\b(https?)\s+(?:colon|dos puntos|dois pontos)\s+(?:slash|barra)\s+(?:slash|barra)\s*/giu,
    (_m, p: string) => `${p.toLowerCase()}://`,
  );
  // Underscore joins (identifiers); a dash joins only inside a dotted name.
  for (let i = 0; i < 4; i++) {
    out = out.replace(
      new RegExp(
        `(${ATOM})\\s+(?:underscore|gui[oó]n bajo|underline|sublinhado)\\s+(${ATOM})`,
        "giu",
      ),
      "$1_$2",
    );
    out = out.replace(
      new RegExp(
        `(${ATOM})\\s+(?:dash|hyphen|gui[oó]n|tra[cç]o|h[ií]fen)\\s+(${ATOM})(?=${DOT})`,
        "giu",
      ),
      "$1-$2",
    );
  }
  // Emails: local (dot local)* at domain (dot label)* dot TLD.
  out = out.replace(
    new RegExp(
      `(?<![A-Za-z0-9.@])(${ATOM}(?:${DOT}${ATOM})*)${AT}(${ATOM}(?:${DOT}${ATOM})*${DOT}(?:${LAST_LABEL}))(?![A-Za-z0-9])`,
      "giu",
    ),
    (m, local: string, domain: string) => {
      const first = local.split(/\s+/)[0]?.toLowerCase() ?? "";
      if (EMAIL_STOP.has(first)) return m;
      return `${joinDots(local)}@${joinDots(domain)}`.toLowerCase();
    },
  );
  // Domains and file names: label (dot label)+ with a known last label.
  out = out.replace(
    new RegExp(
      `(?<![A-Za-z0-9@])(${ATOM}(?:${DOT}${ATOM})*${DOT}(?:${LAST_LABEL}))(?![A-Za-z0-9])`,
      "giu",
    ),
    (m) => {
      const joined = joinDots(m);
      // A country TLD that is also a common word ("de", "es", "it", "me")
      // needs "www" or a second dot: "no ponto de ônibus" stays words.
      const parts = joined.split(".");
      if (
        AMBIGUOUS_TLD.has((parts.at(-1) ?? "").toLowerCase()) &&
        parts.length < 3 &&
        parts[0]?.toLowerCase() !== "www"
      ) {
        return m;
      }
      // Web names are lower case; file names keep their case.
      return WEB_END.test(joined) ? joined.toLowerCase() : joined;
    },
  );
  // A correction inside contact info keeps the last form.
  out = out.replace(
    new RegExp(
      `([A-Za-z0-9._\\-]+)@([A-Za-z0-9\\-]+(?:\\.[A-Za-z0-9\\-]+)+)[,.]?\\s*${CUE}[,.]?\\s+(?:(?:to|a|al)\\s+)?([A-Za-z0-9\\-]+(?:\\.[A-Za-z0-9\\-]+)+)(?![A-Za-z0-9@])`,
      "giu",
    ),
    (_m, local: string, _old: string, domain: string) => `${local}@${domain}`,
  );
  out = out.replace(
    new RegExp(
      `(?<![@A-Za-z0-9])([A-Za-z0-9\\-]+(?:\\.[A-Za-z0-9\\-]+)+)[,.]?\\s*${CUE}[,.]?\\s+([A-Za-z0-9\\-]+(?:\\.[A-Za-z0-9\\-]+)+)(?![A-Za-z0-9@])`,
      "giu",
    ),
    (_m, _old: string, next: string) => next,
  );
  // A path after a domain or URL: "example.com slash v1".
  for (let i = 0; i < 6; i++) {
    out = out.replace(
      /((?:https?:\/\/)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[A-Za-z0-9_.-]+)*)\s+(?:slash|barra)\s+([A-Za-z0-9_.-]+)/giu,
      "$1/$2",
    );
  }
  // A path on its own: "slash home slash user slash notes.txt".
  out = out.replace(
    /(^|[\s(])((?:(?:slash|barra)\s+[A-Za-z0-9_.-]+\s*){2,})/giu,
    (_m, pre: string, path: string) => {
      const written = path
        .trim()
        .split(/\s*(?:slash|barra)\s+/i)
        .filter(Boolean)
        .map((p) => `/${p.trim()}`)
        .join("");
      return `${pre}${written}${/\s$/.test(path) ? " " : ""}`;
    },
  );
  return out;
}
