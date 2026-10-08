/**
 * Candidate ASR-bias terms extracted from a meeting's free-text context
 * (PR #39). The context field is where the owner pastes the calendar
 * invitee list: person names, emails, the meeting title, and calendar
 * noise (Organizer, Optional, Home, Office, "Outside working hours"…).
 *
 * Pure function: no database, no network, no Apple silicon, no ffmpeg —
 * it runs in unit tests and on CI (Linux) identically.
 *
 * Rules, in order of appearance in the text:
 *
 * 1. Email addresses: the local part is split on `.`/`_`/`-` and
 *    title-cased into a person name ("grace.gao" -> "Grace Gao"); the
 *    domain word (the label before the TLD) is used as-is, lowercase
 *    ("ecoatm.com" -> "ecoatm" — the real brand casing is not
 *    derivable from the domain).
 * 2. A pair of consecutive capitalized words is a person name
 *    ("Jane Doe (Required)" -> "Jane Doe" — the noise word flushes the
 *    completed pair, it does not cancel it).
 * 3. Mixed-case tokens (an uppercase letter inside the token, e.g.
 *    "ecoATM") are kept as written, in every line shape.
 * 4. A single capitalized word is kept unless it is a calendar-noise
 *    word — but only on SHORT lines (fewer than 4 word tokens). A
 *    longer line is a sentence (usually the title line), and its first
 *    word ("Status of the…") is capitalization, not a name.
 * 5. Three or more consecutive capitalized words (a title sentence) are
 *    NOT added as a phrase — only the mixed-case tokens inside it.
 *
 * Calendar noise (case-insensitive): Organizer, Optional, Required,
 * Home, Office, bedtime, Edit, and the phrase "Outside working hours".
 * Non-word tokens ("-") are ignored. Results are deduplicated
 * case-insensitively and capped at {@link CONTEXT_TERMS_MAX}.
 */

/** Hard cap on extracted terms — the bias prompt has a 900-char budget. */
export const CONTEXT_TERMS_MAX = 30;

/** A line with at least this many word tokens is a sentence (the title
 * line), not an invitee line — a lone capitalized word in it is
 * sentence-initial capitalization, not a name. */
const SENTENCE_LINE_TOKENS = 4;

/**
 * Calendar-noise words that appear capitalized in invitee lists and
 * title lines but are never a bias target. The first seven are the
 * noise words observed in the 2026-10 meeting (ca70f895); the rest are
 * common meeting-title words that would otherwise flood the prompt.
 */
const NOISE_WORDS = new Set([
  "organizer",
  "optional",
  "required",
  "home",
  "office",
  "bedtime",
  "edit",
  "weekly",
  "monthly",
  "daily",
  "quarterly",
  "sync",
  "meeting",
  "call",
  "update",
  "review",
  "planning",
  "session",
  "product",
  "catchup",
  "catch-up",
  "standup",
  "stand-up",
  "checkin",
  "check-in",
  "huddle",
  "team",
  "project",
  "general",
  "all-hands",
  "allhands",
]);

/** The phrase noise that spans several words. */
const NOISE_PHRASES = [/\boutside working hours\b/gi];

/** Domain labels that are TLD-ish and never the company word. */
const GENERIC_DOMAIN_LABELS = new Set([
  "com",
  "net",
  "org",
  "io",
  "co",
  "dev",
  "ai",
  "app",
  "info",
  "me",
  "us",
  "uk",
  "br",
  "ca",
  "de",
  "fr",
  "es",
  "it",
  "nl",
  "au",
  "jp",
  "in",
]);

/** "grace" -> "Grace" (rest lower-cased so "Mike.Reilly" -> "Mike Reilly"). */
function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** True for tokens like "ecoATM" (an uppercase letter inside the
 * token, not at position 0). */
function hasInternalUpper(word: string): boolean {
  return /[A-Z]/.test(word.slice(1));
}

/**
 * A capitalized word (first letter upper) or a mixed-case token (e.g.
 * "ecoATM"). Single letters ("I") don't count — they are capital
 * letters, not names.
 */
function isCapitalized(word: string): boolean {
  if (word.length < 2) return false;
  return /^[A-Z]/.test(word) || hasInternalUpper(word);
}

/**
 * The company word of a domain: the label before the TLD, skipping
 * TLD-ish labels ("doe.com.br" -> "doe", "mail.google.com" ->
 * "google"). Returned lowercase, as written in the domain; null when
 * there is no usable word.
 */
function domainWord(domain: string): string | null {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return null;
  let idx = labels.length - 2;
  while (idx > 0 && GENERIC_DOMAIN_LABELS.has(labels[idx]!)) idx--;
  const word = labels[idx]!;
  if (word.length < 2) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(word)) return null;
  return word;
}

/**
 * Person name from an email local part: "grace.gao" -> "Grace Gao",
 * "mike-reilly" -> "Mike Reilly". A single part ("support") is
 * title-cased alone unless it is noise.
 */
function nameFromLocalPart(local: string): string | null {
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    const w = parts[0]!;
    if (w.length < 2 || NOISE_WORDS.has(w.toLowerCase())) return null;
    return titleCase(w);
  }
  return parts.map(titleCase).join(" ");
}

export function extractContextTerms(context: string): string[] {
  if (!context || !context.trim()) return [];
  let text = context;
  for (const phrase of NOISE_PHRASES) text = text.replace(phrase, " ");

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (term: string | null | undefined): void => {
    if (!term) return;
    const t = term.trim();
    if (t.length < 2) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (out.length < CONTEXT_TERMS_MAX) out.push(t);
  };

  // An email as ONE token (so its parts never leak into the word runs)
  // or a word (a letter, then letters/digits with optional inner
  // apostrophes or hyphens — "Q3" stays one token, "2026" matches no
  // word at all).
  const TOKEN =
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*[A-Za-z0-9]|[A-Za-z][A-Za-z0-9'-]*/g;

  for (const rawLine of text.split(/\r?\n/)) {
    // Invitee lines are often parenthesized: "(mike.reilly@x.com)".
    const line = rawLine.replace(/^[(\s]+|[)\s]+$/g, "");
    if (!line) continue;

    const tokens = line.match(TOKEN) ?? [];
    const isSentenceLine = tokens.length >= SENTENCE_LINE_TOKENS;
    let run: string[] = [];

    /** A run of consecutive capitalized words (noise words do not
     * break it): a pair is a name; three or more are a title sentence
     * (only mixed-case tokens inside it are kept). */
    const flushRun = (): void => {
      if (run.length === 2) {
        const [a, b] = run;
        add(`${a} ${b}`);
      } else if (run.length >= 3) {
        for (const w of run) if (hasInternalUpper(w)) add(w);
      } else if (run.length === 1) {
        const w = run[0]!;
        // A sentence line's lone capitalized word is capitalization,
        // not a name — keep only mixed-case tokens there.
        if (!isSentenceLine || hasInternalUpper(w)) add(w);
      }
      run = [];
    };

    for (const tok of tokens) {
      const at = tok.indexOf("@");
      if (at > 0) {
        const name = nameFromLocalPart(tok.slice(0, at));
        if (name) add(name);
        const word = domainWord(tok.slice(at + 1));
        if (word) add(word);
        flushRun();
        continue;
      }
      if (NOISE_WORDS.has(tok.toLowerCase())) {
        // Noise does not break a name pair around it.
        continue;
      }
      if (isCapitalized(tok)) {
        run.push(tok);
      } else {
        flushRun();
      }
    }
    flushRun();
  }

  return out;
}
