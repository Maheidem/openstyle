// Fictional demo rows for the site captures. No route creates history rows or
// a summarized meeting, so they go straight into the isolated SQLite DB
// (columns: apps/server/src/lib/schema.ts). Call after the server has made
// the schema (health is up).
import { DatabaseSync } from "node:sqlite";

const MIN = 60 * 1000;

// [raw, cleaned, voice provider, voice model, llm provider, llm model,
//  duration ms, audio ms, created_at SQL]
const HISTORY = [
  [
    "um so the deploy went fine but uh the login page is slow on safari",
    "The deploy went fine, but the login page is slow on Safari.",
    "local-mlx",
    "parakeet-tdt-0.6b-v3",
    "server",
    "Qwen3.8-27B",
    3200,
    2900,
    "datetime('now', '-2 hours')",
  ],
  [
    "hey can you send the invoice to accounting by end of day thanks",
    "Hey, can you send the invoice to Accounting by end of day? Thanks.",
    "local-mlx",
    "parakeet-tdt-0.6b-v3",
    "groq",
    "llama-3.3-70b-versatile",
    2600,
    2400,
    "datetime('now', '-5 hours')",
  ],
  [
    "heads up the staging api is throwing 500s on upload again can someone take a look",
    "Heads up: the staging API is throwing 500s on upload again. Can someone take a look?",
    "server",
    "Qwen3-ASR",
    "server",
    "Qwen3.8-27B",
    4800,
    4500,
    "datetime('now', '-1 day')",
  ],
  [
    "remember to rotate the api keys and update the env file on both boxes",
    "Remember to rotate the API keys and update the .env file on both boxes.",
    "local-mlx",
    "parakeet-tdt-0.6b-v3",
    "server",
    "Qwen3.8-27B",
    3900,
    3600,
    "datetime('now', '-1 day', '-3 hours')",
  ],
  [
    "fix clamp the waveform buffer so long recordings do not crash the pill",
    "fix: clamp the waveform buffer so long recordings do not crash the pill",
    "local-mlx",
    "parakeet-tdt-0.6b-v3",
    "server",
    "Qwen3.8-27B",
    2900,
    2700,
    "datetime('now', '-2 days')",
  ],
  [
    "então amanhã a gente revisa o contrato",
    "Amanhã a gente revisa o contrato.",
    "local-mlx",
    "parakeet-tdt-0.6b-v3",
    "server",
    "Qwen3.8-27B",
    1800,
    1600,
    "datetime('now', '-2 days', '-5 hours')",
  ],
];

const MEETING_ID = "meet_demo_product_sync";
const MEETING_TITLE = "Weekly product sync";
const MEETING_MS = 32 * MIN;

// [source, speaker label (null = Me), text]. Spread evenly over 32 minutes.
const LINES = [
  [
    "mic",
    null,
    "Thanks for joining. Three things today: onboarding, the Safari bug and the release date.",
  ],
  [
    "system",
    "1",
    "Onboarding first. Drop-off at the model download step is still around forty percent.",
  ],
  [
    "system",
    "2",
    "We could start with the small model and offer the larger one later, in the background.",
  ],
  ["mic", null, "I like that. Alex, can you size the change?"],
  [
    "system",
    "1",
    "Two days, mostly the progress UI. I will have it ready for review on Thursday.",
  ],
  ["mic", null, "Good. Next, the Safari login bug. Sam, where are we?"],
  [
    "system",
    "2",
    "I can reproduce it. The session cookie is rejected when the page loads inside a redirect.",
  ],
  [
    "system",
    "2",
    "The fix is small, but it touches the auth flow, so I want a second reviewer.",
  ],
  [
    "mic",
    null,
    "Alex will review it. Please ship it behind a flag first, then we turn it on for everyone.",
  ],
  [
    "system",
    "1",
    "Fine by me. On the release date, QA needs three full days after the code freeze.",
  ],
  [
    "mic",
    null,
    "Then freeze is next Monday and we release on Thursday the fourteenth.",
  ],
  [
    "system",
    "2",
    "That works if the onboarding change lands by Friday. Otherwise it slips a week.",
  ],
  ["system", "1", "I will post the plan in the channel after this call."],
];

const SUMMARY = [
  "## Decisions",
  "- Start onboarding with the small model and download the larger one in the background.",
  "- Ship the Safari login fix behind a flag, reviewed by a second engineer.",
  "- Code freeze is next Monday and the release is Thursday the 14th.",
  "",
  "## Action items",
  "- Alex: build the new onboarding download flow, ready for review Thursday.",
  "- Sam: fix the Safari session cookie bug behind a flag.",
  "- Alex: post the release plan in the team channel after the call.",
].join("\n");

function seedHistory(db) {
  const insert = (at) =>
    db.prepare(
      `INSERT INTO transcription_history
         (raw_text, cleaned_text, voice_provider, voice_model, llm_provider,
          llm_model, duration_ms, audio_duration_ms, input_tokens,
          output_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 120, 24, 0.0003, ${at})`,
    );
  for (const [raw, cleaned, vp, vm, lp, lm, dur, adur, at] of HISTORY) {
    insert(at).run(raw, cleaned, vp, vm, lp, lm, dur, adur);
  }
}

function seedMeeting(db) {
  const startedAt = Date.now() - 26 * 60 * MIN;
  db.prepare(
    `INSERT INTO meetings
       (id, title, started_at, ended_at, duration_ms, status, audio_dir,
        stt_provider, stt_model, language, context, created_at)
     VALUES (?, ?, ?, ?, ?, 'summarized', NULL, 'local-mlx',
             'parakeet-tdt-0.6b-v3', 'en', ?, ?)`,
  ).run(
    MEETING_ID,
    MEETING_TITLE,
    startedAt,
    startedAt + MEETING_MS,
    MEETING_MS,
    "Weekly sync of the product team.",
    startedAt,
  );

  const seg = db.prepare(
    `INSERT INTO meeting_segments
       (id, meeting_id, source, idx, start_ms, end_ms, text, status,
        speaker_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
  );
  const step = Math.floor(MEETING_MS / LINES.length);
  LINES.forEach(([source, speaker, text], i) => {
    const start = i * step + 2000;
    seg.run(
      `${MEETING_ID}-seg-${i}`,
      MEETING_ID,
      source,
      i,
      start,
      start + step - 4000,
      text,
      speaker,
    );
  });

  db.prepare(
    `INSERT INTO meeting_summaries
       (meeting_id, markdown, llm_provider, llm_model, input_tokens,
        output_tokens, cost_usd, created_at)
     VALUES (?, ?, 'server', 'Qwen3.8-27B', 1840, 320, 0, ?)`,
  ).run(MEETING_ID, SUMMARY, startedAt + MEETING_MS + 45000);

  const speaker = db.prepare(
    `INSERT INTO meeting_speakers
       (meeting_id, speaker_label, display_name, suggested_name,
        suggested_evidence, merged_into, updated_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, ?)`,
  );
  speaker.run(MEETING_ID, "1", "Alex", startedAt + MEETING_MS);
  speaker.run(MEETING_ID, "2", "Sam", startedAt + MEETING_MS);
}

export function seedDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    seedHistory(db);
    seedMeeting(db);
  } finally {
    db.close();
  }
}
