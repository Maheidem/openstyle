// Score ASR arms against the silver gold keys. Numbers only, never text.
// usage (from the repo root):
//   pnpm meeting:silver:score-arms <arm> [<arm> ...]
// Input per arm: $SILVER_EVAL_HOME/out/<arm>/raw.db (arms/transcribed.db of
// the eval; run_arm.sh makes it). SILVER_EVAL_HOME defaults to
// /tmp/meeting-eval. Output per arm: results.md and results.json in that
// folder. Meetings: SILVER_MEETINGS (comma list), else every <id8>.json key
// in SILVER_KEYS (default ~/.openstyle-eval/gold-silver).
//
// Recall: the harness's own scoreSpans and addSpanScores (stage asr).
// Precision: each occurrence in the ASR text of (a) a vocabulary term or
// (b) an attendee name token (3+ letters) is "supported" when a gold span
// of any confidence on the same channel, within +-3 s, holds the same
// normal words. An unsupported occurrence is a possible insertion.
// The owner name (setting owner_name of raw.db, else env OWNER_NAME) is a
// name token too, in every arm. Its own count is reported apart.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadGold } from "../../gold.mts";
import {
  addSpanScores,
  normalizeWords,
  type SpanCount,
  type SpanScore,
  scoreSpans,
  scoreWords,
} from "../../score.mts";
import {
  attendeeNames,
  attendeeTokens,
  countRun as count,
  hasRun as has,
} from "./names.mts";

const EVAL_HOME = process.env.SILVER_EVAL_HOME || "/tmp/meeting-eval";
const KEYS =
  process.env.SILVER_KEYS || join(homedir(), ".openstyle-eval", "gold-silver");
const MEETINGS = process.env.SILVER_MEETINGS
  ? process.env.SILVER_MEETINGS.split(/[\s,]+/).filter(Boolean)
  : readdirSync(KEYS)
      .filter((f) => /^[0-9a-f]{8}\.json$/.test(f))
      .map((f) => f.slice(0, 8))
      .sort();
const TOL = 3000;
const golds = loadGold(MEETINGS, KEYS);
const norm = (t: string) => normalizeWords(scoreWords(t)).words;
const pct = (c: SpanCount) =>
  `${c.rate === null ? "-" : (c.rate * 100).toFixed(1)} (${c.hits}/${c.n})`;
const cells = (s: SpanScore) => [
  pct(s.all),
  pct(s.high),
  pct(s.byLabel.term),
  pct(s.byLabel.person),
  pct(s.byLabel.other),
  pct(s.byVocab.inVocab),
  pct(s.byVocab.notInVocab),
  String(s.unsure),
  String(s.empty),
];
const HDR = [
  "Arm",
  "Meeting",
  "All",
  "High",
  "Term+product",
  "Person",
  "Other",
  "In vocab",
  "Not in vocab",
  "Unsure skipped",
  "Empty skipped",
];
const row = (xs: string[]) => `| ${xs.join(" | ")} |`;
const table = (h: string[], rows: string[][]) => [
  row(h),
  row(h.map(() => "---")),
  ...rows.map(row),
];

type Prec = {
  vocabOcc: number;
  vocabUnsup: number;
  nameOcc: number;
  nameUnsup: number;
  ownerOcc: number;
  ownerUnsup: number;
};
const addPrec = (xs: Prec[]): Prec => ({
  vocabOcc: xs.reduce((a, x) => a + x.vocabOcc, 0),
  vocabUnsup: xs.reduce((a, x) => a + x.vocabUnsup, 0),
  nameOcc: xs.reduce((a, x) => a + x.nameOcc, 0),
  nameUnsup: xs.reduce((a, x) => a + x.nameUnsup, 0),
  ownerOcc: xs.reduce((a, x) => a + x.ownerOcc, 0),
  ownerUnsup: xs.reduce((a, x) => a + x.ownerUnsup, 0),
});

const summary: Record<string, unknown> = {};
const pooledRows: string[][] = [];
const precRows: string[][] = [];
for (const arm of process.argv.slice(2)) {
  const dir = join(EVAL_HOME, "out", arm);
  const db = new DatabaseSync(join(dir, "raw.db"), { readOnly: true });
  const vocab = (
    db.prepare("SELECT term FROM vocabulary").all() as { term: string }[]
  )
    .map((r) => norm(r.term))
    .filter((w) => w.length > 0);
  const ownerRaw = (
    (
      db.prepare("SELECT value FROM settings WHERE key = 'owner_name'").get() as
        | { value?: string }
        | undefined
    )?.value ??
    process.env.OWNER_NAME ??
    ""
  ).trim();
  const owner = ownerRaw ? norm(ownerRaw) : [];
  const per: {
    meeting: string;
    spans: SpanScore;
    noOwner: SpanScore;
    prec: Prec;
  }[] = [];
  for (const id8 of MEETINGS) {
    const gold = golds.get(id8);
    const m = db
      .prepare("SELECT id, calendar_attendees FROM meetings WHERE id LIKE ?")
      .get(`${id8}%`) as { id: string; calendar_attendees: string | null };
    const rows = db
      .prepare(
        "SELECT id, source, idx, start_ms, end_ms, text, enhanced_text FROM meeting_segments WHERE meeting_id = ? ORDER BY source, idx, start_ms",
      )
      .all(m.id) as any[];
    const spans = scoreSpans(gold?.spans ?? [], rows, "asr");
    // The same score without the owner-name spans (normal words = the owner name).
    const noOwner = scoreSpans(
      (gold?.spans ?? []).filter(
        (sp) =>
          owner.length === 0 || norm(sp.text).join(" ") !== owner.join(" "),
      ),
      rows,
      "asr",
    );
    const gs = (gold?.spans ?? []).map((sp) => ({
      ...sp,
      words: norm(sp.text),
    }));
    const nameKeys = new Set<string>();
    const names = [
      ...attendeeTokens(m.calendar_attendees).map(norm),
      owner,
    ].filter(
      (w) =>
        w.length > 0 && !nameKeys.has(w.join(" ")) && nameKeys.add(w.join(" ")),
    );
    const prec: Prec = {
      vocabOcc: 0,
      vocabUnsup: 0,
      nameOcc: 0,
      nameUnsup: 0,
      ownerOcc: 0,
      ownerUnsup: 0,
    };
    for (const s of rows) {
      if (s.start_ms === null) continue;
      const words = norm(s.text ?? "");
      const start = s.start_ms as number;
      const end = Math.max(start, s.end_ms ?? start);
      const near = gs.filter(
        (sp) =>
          sp.channel === s.source &&
          sp.endMs >= start - TOL &&
          sp.startMs <= end + TOL,
      );
      for (const [terms, kind] of [
        [vocab, "vocab"],
        [names, "name"],
      ] as const)
        for (const t of terms) {
          const n = count(words, t);
          if (n === 0) continue;
          const ok = near.some((sp) => has(sp.words, t));
          if (kind === "vocab") {
            prec.vocabOcc += n;
            if (!ok) prec.vocabUnsup += n;
          } else {
            prec.nameOcc += n;
            if (!ok) prec.nameUnsup += n;
          }
          if (
            kind === "name" &&
            owner.length > 0 &&
            t.join(" ") === owner.join(" ")
          ) {
            prec.ownerOcc += n;
            if (!ok) prec.ownerUnsup += n;
          }
        }
    }
    per.push({ meeting: id8, spans, noOwner, prec });
  }
  // Proof: the bias prompt per meeting (length, attendee full names found).
  const proofPath = join(EVAL_HOME, `proof-${arm}-bias.txt`);
  const proof: {
    meeting: string;
    chars: number;
    names: number;
    namesPresent: number;
    firstPresent: number;
    owner: boolean;
  }[] = [];
  const wordIn = (text: string, w: string) =>
    new RegExp(
      `(^|[^\\p{L}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`,
      "u",
    ).test(text);
  if (existsSync(proofPath))
    for (const ln of readFileSync(proofPath, "utf8").split("\n")) {
      const mm =
        /meeting ([0-9a-f-]+): ASR bias prompt \((\d+) chars\): (.*)$/.exec(ln);
      if (!mm) continue;
      const m = db
        .prepare("SELECT calendar_attendees FROM meetings WHERE id = ?")
        .get(mm[1]) as { calendar_attendees: string | null } | undefined;
      const full = attendeeNames(m?.calendar_attendees ?? null);
      const text = (mm[3] as string).toLowerCase();
      // The bias text holds the terms before the global vocabulary; "first
      // names" counts the attendees whose first word is present as a word.
      proof.push({
        meeting: (mm[1] as string).slice(0, 8),
        chars: Number(mm[2]),
        names: full.length,
        namesPresent: full.filter((n) => text.includes(n.toLowerCase())).length,
        firstPresent: full.filter((n) =>
          wordIn(text, n.split(/\s+/)[0] as string),
        ).length,
        owner: ownerRaw !== "" && wordIn(text, ownerRaw),
      });
    }
  console.log(
    `proof ${arm}: ownerSetting=${ownerRaw ? "set" : "unset"} prompts=${proof.length} ${proof.map((p) => `${p.meeting} chars=${p.chars} full=${p.namesPresent}/${p.names} first=${p.firstPresent}/${p.names} owner=${p.owner ? 1 : 0}`).join(" ")}`,
  );
  db.close();
  const pooled = addSpanScores(per.map((p) => p.spans));
  const pooledNoOwner = addSpanScores(per.map((p) => p.noOwner));
  const pp = addPrec(per.map((p) => p.prec));
  const pr = (p: Prec) => [
    String(p.vocabOcc),
    String(p.vocabUnsup),
    String(p.nameOcc),
    String(p.nameUnsup),
    String(p.ownerOcc),
    String(p.ownerOcc - p.ownerUnsup),
  ];
  const PH = [
    "Arm",
    "Meeting",
    "Vocab occurrences",
    "Vocab unsupported",
    "Name-token occurrences",
    "Name-token unsupported",
    "Owner occurrences",
    "Owner supported",
  ];
  const md = [
    `# ASR arm ${arm}: silver span recall and possible insertions`,
    "",
    "Stage asr only (raw text). Recall from the harness scoreSpans (high+medium, +-3000 ms). Numbers only.",
    "",
    "## Spans",
    "",
    ...table(HDR, [
      [arm, "pooled", ...cells(pooled)],
      ...per.map((p) => [arm, p.meeting, ...cells(p.spans)]),
    ]),
    "",
    "## Possible insertions (no gold span of any confidence with the same words, same channel, +-3000 ms)",
    "",
    ...table(PH, [
      [arm, "pooled", ...pr(pp)],
      ...per.map((p) => [arm, p.meeting, ...pr(p.prec)]),
    ]),
    "",
  ].join("\n");
  writeFileSync(join(dir, "results.md"), md);
  const json = {
    arm,
    stage: "asr",
    pooled: {
      ...pooled,
      missedKeys: undefined,
      missed: pooled.missedKeys.length,
    },
    personNoOwner: pooledNoOwner.byLabel.person,
    precision: pp,
    meetings: per.map((p) => ({
      meeting: p.meeting,
      spans: {
        ...p.spans,
        missedKeys: undefined,
        missed: p.spans.missedKeys.length,
      },
      personNoOwner: p.noOwner.byLabel.person,
      precision: p.prec,
    })),
  };
  writeFileSync(
    join(dir, "results.json"),
    `${JSON.stringify(json, null, 1)}\n`,
  );
  summary[arm] = json;
  pooledRows.push([arm, "pooled", ...cells(pooled)]);
  precRows.push([arm, "pooled", ...pr(pp)]);
  console.log(`--- ${arm}`);
  for (const p of per)
    console.log(
      `${p.meeting} all=${pct(p.spans.all)} person=${pct(p.spans.byLabel.person)} term=${pct(p.spans.byLabel.term)} vocabUnsup=${p.prec.vocabUnsup}/${p.prec.vocabOcc} nameUnsup=${p.prec.nameUnsup}/${p.prec.nameOcc} owner=${p.prec.ownerOcc - p.prec.ownerUnsup}/${p.prec.ownerOcc}`,
    );
}
console.log(table(HDR, pooledRows).join("\n"));
console.log(
  table(
    [
      "Arm",
      "Meeting",
      "Vocab occ",
      "Vocab unsup",
      "Name occ",
      "Name unsup",
      "Owner occ",
      "Owner supported",
    ],
    precRows,
  ).join("\n"),
);
