// gold-clips.mts: short audio clips of the spans that the owner must check
// by ear, and a local review page (`pnpm meeting:eval:gold-clips`).
//
// Usage (from the repo root):
//   pnpm meeting:eval:gold-clips --meeting <id8> --spans <file>
//
// --spans: a JSON file with the spans. Either an array, or an object with a
// `spans` or a `diffSpans` array (so a gold-draft file works as it is). Each
// span: { id, channel: "mic" | "system", startMs, endMs, a?, b?, gold? }.
// `a` and `b` are the texts of the two engines; `gold` is the text that the
// gold holds for the span now (the words that an answer replaces; when it is
// absent, `a` is used).
//
// Output (folder mode 0700): /tmp/meeting-eval/clips/<id8>/
//   src/mic.wav, src/system.wav  copies of the meeting audio (the real
//                                meeting folder is read only)
//   <n>.wav                      span n (1-based, in file order) plus 0.5 s
//                                on each side, 16 kHz mono PCM16
//   review.html                  one row per span: an audio player, the two
//                                engine texts and a text box. "Save" downloads
//                                answers.json for pnpm meeting:eval:gold-merge.
//
// The tool never plays audio. The console prints counts, sizes and paths only.
// ffmpeg: the repo's apps/electron/resources/bin/<platform>/ffmpeg, else the
// ffmpeg on PATH.
//
// Exit codes: 0 ok; 1 a clip failed; 2 usage.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { CHANNELS, type Channel } from "./gold.mts";
import { REAL_PROFILE, ROOT, repoRoot } from "./runtime.mts";

const PAD_MS = 500;
/** 16 kHz mono PCM16. */
const BYTES_PER_MS = 32;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function usage(msg: string): never {
  console.error(msg);
  console.error(
    "usage: pnpm meeting:eval:gold-clips --meeting <id8> --spans <file>",
  );
  process.exit(2);
}

interface ClipSpan {
  id: string;
  channel: Channel;
  startMs: number;
  endMs: number;
  a: string;
  b: string;
  gold: string | null;
}

/** Read the spans of a spans file (array, or object with spans / diffSpans). */
function parseSpans(json: string): ClipSpan[] {
  const v = JSON.parse(json);
  const list = Array.isArray(v) ? v : (v?.spans ?? v?.diffSpans);
  if (!Array.isArray(list)) throw new Error("spans: no span array in the file");
  const seen = new Set<string>();
  return list.map((x, i) => {
    const w = `spans[${i}]`;
    if (typeof x?.id !== "string" || !/^[A-Za-z0-9_.-]{1,40}$/.test(x.id))
      throw new Error(`${w}: id must match [A-Za-z0-9_.-]{1,40}`);
    if (seen.has(x.id)) throw new Error(`${w}: id ${x.id} is used twice`);
    seen.add(x.id);
    if (!CHANNELS.includes(x.channel))
      throw new Error(`${w}: channel must be mic or system`);
    const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
    if (!ok(x.startMs) || !ok(x.endMs) || x.endMs < x.startMs)
      throw new Error(`${w}: needs integer startMs <= endMs`);
    const str = (s: unknown) => (typeof s === "string" ? s : "");
    return {
      id: x.id,
      channel: x.channel,
      startMs: x.startMs,
      endMs: x.endMs,
      a: str(x.a),
      b: str(x.b),
      gold: typeof x.gold === "string" ? x.gold : null,
    };
  });
}

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );

/** The review page. The span data is embedded; "Save" downloads answers.json. */
function reviewHtml(id8: string, spans: ClipSpan[]): string {
  const rows = spans
    .map(
      (s, i) => `<tr data-i="${i}">
<td>${i + 1}<br><small>${esc(s.id)} ${s.channel}<br>${mmss(s.startMs)}-${mmss(s.endMs)}</small></td>
<td><audio controls preload="none" src="${i + 1}.wav"></audio></td>
<td><b>A</b> ${esc(s.a) || "<i>(none)</i>"}<br><b>B</b> ${esc(s.b) || "<i>(none)</i>"}${s.gold !== null ? `<br><b>Gold</b> ${esc(s.gold) || "<i>(none)</i>"}` : ""}
<br><button type="button" data-use="a">Use A</button> <button type="button" data-use="b">Use B</button></td>
<td><textarea rows="3" cols="40" placeholder="Type the words you hear"></textarea><br>
<label><input type="checkbox"> No speech</label></td>
</tr>`,
    )
    .join("\n");
  const data = JSON.stringify({ meeting: id8, spans }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gold review ${esc(id8)}</title>
<style>
body { font: 14px system-ui, sans-serif; margin: 16px; }
table { border-collapse: collapse; width: 100%; }
td { border-top: 1px solid #ccc; padding: 8px; vertical-align: top; }
textarea { width: 100%; box-sizing: border-box; }
.bar { position: sticky; top: 0; background: #fff; padding: 8px 0; }
</style></head><body>
<div class="bar"><b>Meeting ${esc(id8)}</b>: ${spans.length} spans.
Listen to each clip, type the words you hear (or check "No speech"), then press
<button type="button" id="save">Save</button> to download answers.json.
Rows with an empty box are not saved. <span id="status"></span></div>
<table>${rows}</table>
<script>
const DATA = ${data};
const rows = [...document.querySelectorAll("tr[data-i]")];
for (const tr of rows) {
  const s = DATA.spans[Number(tr.dataset.i)];
  for (const b of tr.querySelectorAll("button[data-use]"))
    b.addEventListener("click", () => {
      tr.querySelector("textarea").value = s[b.dataset.use];
    });
}
document.getElementById("save").addEventListener("click", () => {
  const answers = [];
  for (const tr of rows) {
    const s = DATA.spans[Number(tr.dataset.i)];
    const text = tr.querySelector("textarea").value.trim();
    const none = tr.querySelector("input[type=checkbox]").checked;
    if (!text && !none) continue;
    answers.push({ id: s.id, channel: s.channel, startMs: s.startMs,
      endMs: s.endMs, from: s.gold ?? s.a, text: none ? "" : text });
  }
  const out = { format: "openstyle-gold-answers", meeting: DATA.meeting,
    savedAt: new Date().toISOString(), answers };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)],
    { type: "application/json" }));
  a.download = "answers.json";
  a.click();
  document.getElementById("status").textContent =
    "saved " + answers.length + " answers";
});
</script>
</body></html>
`;
}

function ffmpegPath(): string {
  const local = join(
    repoRoot,
    "apps",
    "electron",
    "resources",
    "bin",
    `${process.platform}-${process.arch}`,
    "ffmpeg",
  );
  if (existsSync(local)) return local;
  for (const dir of (process.env.PATH ?? "").split(":"))
    if (dir && existsSync(join(dir, "ffmpeg"))) return join(dir, "ffmpeg");
  throw new Error(
    "no ffmpeg (pnpm --filter @openstyle/electron download:ffmpeg, or install ffmpeg)",
  );
}

function main(): number {
  const id8 = arg("meeting");
  const spansPath = arg("spans");
  if (!id8 || !/^[0-9a-f]{8}$/.test(id8)) usage("--meeting <id8> is required");
  if (!spansPath) usage("--spans <file> is required");
  const spans = parseSpans(readFileSync(spansPath, "utf8"));
  if (spans.length === 0) usage("the spans file holds no spans");

  // The meeting folder of the real profile: read only (copy out).
  const meetingsDir = join(REAL_PROFILE, "meetings");
  const ids = readdirSync(meetingsDir).filter((d) => d.startsWith(id8));
  if (ids.length !== 1)
    throw new Error(
      `meeting ${id8}: ${ids.length} folders in the real profile`,
    );
  const src = join(meetingsDir, ids[0] as string);

  const out = join(ROOT, "clips", id8);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "src"), { recursive: true, mode: 0o700 });
  for (const d of [join(ROOT, "clips"), out, join(out, "src")])
    chmodSync(d, 0o700);
  for (const ch of CHANNELS) {
    const f = join(src, `${ch}.wav`);
    if (spans.some((s) => s.channel === ch)) {
      if (!existsSync(f)) throw new Error(`meeting ${id8}: no ${ch}.wav`);
      copyFileSync(f, join(out, "src", `${ch}.wav`));
    }
  }

  const ffmpeg = ffmpegPath();
  let failed = 0;
  let bytes = 0;
  spans.forEach((s, i) => {
    const from = Math.max(0, s.startMs - PAD_MS);
    const dur = s.endMs + PAD_MS - from;
    const file = join(out, `${i + 1}.wav`);
    const r = spawnSync(
      ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-ss",
        (from / 1000).toFixed(3),
        "-t",
        (dur / 1000).toFixed(3),
        "-i",
        join(out, "src", `${s.channel}.wav`),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        file,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    // A clip must hold audio: more than the WAV header, at most the asked
    // length (the end of the file can cut it short).
    const size = existsSync(file) ? statSync(file).size : 0;
    if (r.status !== 0 || size <= 44 || size > dur * BYTES_PER_MS + 4096) {
      failed++;
      console.error(
        `clip ${i + 1} (${s.id}): ffmpeg exit ${r.status}, ${size} bytes`,
      );
      return;
    }
    bytes += size;
  });

  const page = join(out, "review.html");
  writeFileSync(page, reviewHtml(id8, spans), { mode: 0o600 });
  const wavs = readdirSync(out).filter((f) => /^\d+\.wav$/.test(f)).length;
  console.log(
    `clips: ${wavs}/${spans.length} WAV files, ${(bytes / 1e6).toFixed(2)} MB, padding ${PAD_MS} ms each side`,
  );
  console.log(
    `review page (private text): ${page} (${statSync(page).size} bytes)`,
  );
  console.log(
    `next: open the page, save answers.json, then pnpm meeting:eval:gold-merge --meeting ${id8} --answers <answers.json>`,
  );
  console.log(`cleanup (private audio and text): rm -rf ${out}`);
  return failed > 0 || wavs !== spans.length ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`gold-clips failed: ${(e as Error).message}`);
  process.exit(1);
}
