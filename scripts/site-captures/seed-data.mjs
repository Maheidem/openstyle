// Fictional demo rows for the site captures. No route creates history rows or
// a summarized meeting, so they go straight into the isolated SQLite DB
// (columns: apps/server/src/lib/schema.ts). Call after the server has made
// the schema (health is up).
import { DatabaseSync } from "node:sqlite";

const MIN = 60 * 1000;

// The default setup of a new install: the built-in Qwen3-ASR model for voice
// and the built-in Gemma 4 E2B model for cleanup (both local MLX).
const VOICE = ["local-mlx", "qwen3-0.6b-8bit"];
const LLM = ["local-mlx-llm", "gemma-4-e2b-qat-4bit"];

// [raw, cleaned, [voice provider, voice model], [llm provider, llm model],
//  duration ms, audio ms, cost usd, created_at SQL]
const HISTORY = [
  [
    "um so the deploy went fine but uh the login page is slow on safari",
    "The deploy went fine, but the login page is slow on Safari.",
    VOICE,
    LLM,
    3200,
    2900,
    0,
    "datetime('now', '-2 hours')",
  ],
  [
    "hey can you send the invoice to accounting by end of day thanks",
    "Hey, can you send the invoice to Accounting by end of day? Thanks.",
    VOICE,
    ["groq", "llama-3.3-70b-versatile"],
    2600,
    2400,
    0.0003,
    "datetime('now', '-5 hours')",
  ],
  [
    "heads up the staging api is throwing 500s on upload again can someone take a look",
    "Heads up: the staging API is throwing 500s on upload again. Can someone take a look?",
    VOICE,
    LLM,
    4800,
    4500,
    0,
    "datetime('now', '-1 day')",
  ],
  [
    "remember to rotate the api keys and update the env file on both boxes",
    "Remember to rotate the API keys and update the .env file on both boxes.",
    VOICE,
    LLM,
    3900,
    3600,
    0,
    "datetime('now', '-1 day', '-3 hours')",
  ],
  [
    "fix clamp the waveform buffer so long recordings do not crash the pill",
    "fix: clamp the waveform buffer so long recordings do not crash the pill",
    VOICE,
    LLM,
    2900,
    2700,
    0,
    "datetime('now', '-2 days')",
  ],
  [
    "então amanhã a gente revisa o contrato",
    "Amanhã a gente revisa o contrato.",
    VOICE,
    LLM,
    1800,
    1600,
    0,
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 120, 24, ?, ${at})`,
    );
  for (const [
    raw,
    cleaned,
    [vp, vm],
    [lp, lm],
    dur,
    adur,
    cost,
    at,
  ] of HISTORY) {
    insert(at).run(raw, cleaned, vp, vm, lp, lm, dur, adur, cost);
  }
}

// Meeting folders and tags (columns: meeting_folders, tags, meeting_tags).
const FOLDERS = [
  ["folder_product", "Product team", "Weekly syncs and planning."],
  ["folder_customers", "Customer calls", "Calls with pilot customers."],
  ["folder_hiring", "Hiring", null],
];
const TAGS = ["release", "onboarding", "safari", "qa"];

// Two short meetings, so the other folders are not empty.
// [id, title, folder id, hours ago, minutes, context, lines]
const OTHER_MEETINGS = [
  [
    "meet_demo_pilot_call",
    "Pilot check-in with Northwind",
    "folder_customers",
    50,
    24,
    "Monthly call with the pilot customer.",
    [
      [
        "mic",
        null,
        "Thanks for the time. How did the first month go for your team?",
      ],
      [
        "system",
        "1",
        "Mostly well. Two people still type their notes after each call.",
      ],
      [
        "system",
        "1",
        "We would like the summaries to go straight into our wiki.",
      ],
      ["mic", null, "Noted. We will look at an export to Markdown first."],
    ],
  ],
  [
    "meet_demo_interview",
    "Interview debrief: frontend role",
    "folder_hiring",
    74,
    18,
    "Debrief after the second interview round.",
    [
      ["mic", null, "Let us go around. Strong points first, then concerns."],
      [
        "system",
        "1",
        "Clear thinking on state management and good questions about testing.",
      ],
      [
        "system",
        "2",
        "I agree. The take-home was clean, but light on accessibility.",
      ],
      [
        "mic",
        null,
        "Then we move to the final round and ask about accessibility there.",
      ],
    ],
  ],
];

function insertMeeting(db, m) {
  db.prepare(
    `INSERT INTO meetings
       (id, title, started_at, ended_at, duration_ms, status, audio_dir,
        stt_provider, stt_model, language, context, folder_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'summarized', NULL, ?, ?, 'en', ?, ?, ?)`,
  ).run(
    m.id,
    m.title,
    m.startedAt,
    m.startedAt + m.durationMs,
    m.durationMs,
    VOICE[0],
    VOICE[1],
    m.context,
    m.folderId,
    m.startedAt,
  );

  const seg = db.prepare(
    `INSERT INTO meeting_segments
       (id, meeting_id, source, idx, start_ms, end_ms, text, status,
        speaker_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
  );
  const step = Math.floor(m.durationMs / m.lines.length);
  m.lines.forEach(([source, speaker, text], i) => {
    const start = i * step + 2000;
    seg.run(
      `${m.id}-seg-${i}`,
      m.id,
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
     VALUES (?, ?, ?, ?, 1840, 320, 0, ?)`,
  ).run(m.id, m.summary, LLM[0], LLM[1], m.startedAt + m.durationMs + 45000);
}

function seedMeetings(db) {
  const now = Date.now();
  const folder = db.prepare(
    `INSERT INTO meeting_folders (id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const [id, name, description] of FOLDERS) {
    folder.run(id, name, description, now - 30 * 24 * 60 * MIN, now);
  }

  const startedAt = now - 26 * 60 * MIN;
  insertMeeting(db, {
    id: MEETING_ID,
    title: MEETING_TITLE,
    folderId: "folder_product",
    startedAt,
    durationMs: MEETING_MS,
    context: "Weekly sync of the product team.",
    lines: LINES,
    summary: SUMMARY,
  });
  for (const [
    id,
    title,
    folderId,
    hoursAgo,
    minutes,
    context,
    lines,
  ] of OTHER_MEETINGS) {
    insertMeeting(db, {
      id,
      title,
      folderId,
      startedAt: now - hoursAgo * 60 * MIN,
      durationMs: minutes * MIN,
      context,
      lines,
      summary: `## Summary\n- ${lines[1][2]}\n- ${lines.at(-1)[2]}`,
    });
  }

  const tag = db.prepare(
    "INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)",
  );
  const link = db.prepare(
    `INSERT INTO meeting_tags (meeting_id, tag_id, source, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  TAGS.forEach((name, i) => {
    tag.run(`tag_${name}`, name, now);
    link.run(MEETING_ID, `tag_${name}`, i < 2 ? "llm" : "user", now);
  });
  link.run("meet_demo_pilot_call", "tag_onboarding", "llm", now);

  const speaker = db.prepare(
    `INSERT INTO meeting_speakers
       (meeting_id, speaker_label, display_name, suggested_name,
        suggested_evidence, merged_into, updated_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, ?)`,
  );
  speaker.run(MEETING_ID, "1", "Alex", startedAt + MEETING_MS);
  speaker.run(MEETING_ID, "2", "Sam", startedAt + MEETING_MS);
}

// Hide the first-run tutorial card and the one-time Enhance dialog, as on a
// Mac that has used the app for some weeks. Advanced mode shows Models in
// the sidebar. AI cleanup is on.
function seedSettings(db) {
  db.prepare(
    "INSERT OR IGNORE INTO dismissed_notifications (key) VALUES ('today.tutorial_hero')",
  ).run();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('meeting_enhance_prompt_seen', 'true')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();
  for (const key of ["advanced_mode", "llm_cleanup"]) {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, 'true')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key);
  }
}

export function seedDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    seedHistory(db);
    seedMeetings(db);
    seedSettings(db);
  } finally {
    db.close();
  }
}
