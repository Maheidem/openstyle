// Reads jobs JSON on stdin; prints WER/CER counts per job and channel.
// The Python steps of the silver pipeline call it, so they use the same
// scorer as the eval (scoreChannel, scoreWords, normalizeWords; no port).
// Run: node --import scripts/meeting-v2/ts-register.mjs <this file> < jobs.json
// wv/wvr, cv/cvr: errors anchored at turns with verified=true (silver-2 sets verified := wer_eligible).
import { normalizeWords, scoreChannel, scoreWords } from "../score.mts";

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const { jobs, spans } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const out: any = { wer: {}, norm: {} };
for (const j of jobs ?? []) {
  const gold: any = { transcript: j.transcript };
  out.wer[j.key] = {};
  for (const ch of ["mic", "system"]) {
    const rows = j.rows.filter((r: any) => r.source === ch);
    const s = scoreChannel(gold, ch as any, j.rows, "asr");
    out.wer[j.key][ch] = s && {
      wv: s.wordsVerified.errors,
      wvr: s.wordsVerified.ref,
      cv: s.charsVerified.errors,
      cvr: s.charsVerified.ref,
      w: s.words.errors,
      wr: s.words.ref,
      c: s.chars.errors,
      cr: s.chars.ref,
      sub: s.substitutions,
      del: s.deletions,
      ins: s.insertions,
      nrows: rows.length,
    };
  }
}
// Normal form for span matching: scoreWords + normalizeWords (numbers to digits, repeats once).
for (const [k, t] of Object.entries(spans ?? {}))
  out.norm[k] = normalizeWords(scoreWords(t as string)).words.join(" ");
process.stdout.write(JSON.stringify(out));
