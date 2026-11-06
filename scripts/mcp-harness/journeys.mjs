// The journeys of the MCP harness (specs/mcp.md 10) as agent prompts, and the
// checks that run.mjs does after each journey. Every value is fictional.
//
// A prompt names the tools, so every tool gets a call. A delete tool gets
// one call without confirm (the refusal) and one with confirm: true.

export const SERVER = "openstyle-dev";

/** The fictional rows that run.mjs adds next to seedDatabase(). */
export const SEED = {
  meeting: "meet_demo_product_sync",
  pilot: "meet_demo_pilot_call",
  interview: "meet_demo_interview",
  folder: "folder_product",
  deleteMeeting: "meet_harness_delete",
  deleteFolder: "folder_harness_empty",
  keepThread: "thr_harness_release",
  deleteThread: "thr_harness_scratch",
  keepItem: "led_harness_safari",
  deleteItem: "led_harness_old",
  deleteTerm: "Deleteme Term",
  deleteDictationText: "Delete me: a test note about the parking lot.",
  model: "gemma-4-e2b-qat-4bit",
};

const PRE = (h) =>
  [
    "You test the Openstyle MCP server. All data is fictional test data.",
    `Use only the tools of the MCP server "${SERVER}".`,
    h === "pi"
      ? `In codemode, each tool is tools.mcp__openstyle_dev__<tool name>, for example tools.mcp__openstyle_dev__list_meetings({}).`
      : "",
    "Do the steps in the given order. Do every step, also when a step gives an error.",
    "Do not ask questions. At the end, write a short report: one line for each tool call with the tool name and ok or error.",
    "",
    "Steps:",
  ]
    .filter(Boolean)
    .join("\n");

/** One journey: id, title, the prompt for harness h, and the expected tools. */
export function journeys(h, ctx) {
  const tag = h === "pi" ? "pi" : "claude";
  return [
    {
      id: "J01-connect-claude",
      only: "claude",
      title: "Connect Claude Code",
      tools: ["list_meetings"],
      prompt: `${PRE(h)}
1. Call list_meetings with no arguments.
2. Write how many Openstyle tools you have, and the titles of the meetings.`,
    },
    {
      id: "J02-connect-pi",
      only: "pi",
      title: "Connect pi",
      tools: ["list_meetings"],
      prompt: `${PRE(h)}
1. Call list_meetings with no arguments.
2. Write the titles of the meetings.`,
    },
    {
      id: "J03-summary",
      title: "Summary rewrite with versions",
      tools: [
        "get_meeting",
        "get_transcript",
        "set_summary",
        "get_summary_versions",
      ],
      prompt: `${PRE(h)}
1. Call get_meeting with meeting_id "${SEED.meeting}".
2. Call get_transcript with meeting_id "${SEED.meeting}" and limit 50.
3. Call set_summary for meeting_id "${SEED.meeting}". Write a new summary from the transcript. The markdown must start with the line "## Summary (${tag})". Give summary_json with overview, keyPoints, decisions, actionItems (task, owner, due) and openQuestions. Put at least one action item with the task "Size the onboarding change (${tag})" and the owner "Alex".
4. Call get_summary_versions with meeting_id "${SEED.meeting}".`,
    },
    {
      id: "J04-enhanced",
      title: "Enhanced fixes",
      tools: ["get_transcript", "set_enhanced_segments"],
      prompt: `${PRE(h)}
1. Call get_transcript with meeting_id "${SEED.meeting}", offset 0 and limit 5.
2. Call set_enhanced_segments for meeting_id "${SEED.meeting}" with exactly these 3 segments:
   - id "${SEED.meeting}-seg-0", enhanced_text "Thanks for joining. Three topics today: onboarding, the Safari bug and the release date. (${tag})"
   - id "${SEED.meeting}-seg-1", enhanced_text "Onboarding first. The drop-off at the model download step is still about forty percent. (${tag})"
   - id "${SEED.meeting}-seg-2", enhanced_text "We could start with the small model and offer the large one later, in the background. (${tag})"`,
    },
    {
      id: "J05-speakers",
      title: "Speakers",
      tools: ["get_meeting", "update_speaker"],
      prompt: `${PRE(h)}
1. Call get_meeting with meeting_id "${SEED.meeting}" and read the speakers.
2. Call update_speaker with meeting_id "${SEED.meeting}", label "1" and display_name "Alex Rivera".
3. Call update_speaker with meeting_id "${SEED.meeting}", label "2" and merged_into "1".`,
    },
    {
      id: "J06-meeting-fields",
      title: "Meeting fields and attendees",
      tools: [
        "update_meeting",
        "list_tags",
        "set_meeting_tags",
        "set_calendar_link",
        "set_attendees",
      ],
      prompt: `${PRE(h)}
1. Call update_meeting with meeting_id "${SEED.pilot}", title "Pilot call, week 45 (${tag})", language "en" and context "Notes: the pilot customer wants a second demo."
2. Call list_tags.
3. Call set_meeting_tags with meeting_id "${SEED.pilot}" and tags ["pilot", "customer-${tag}"].
4. Call set_calendar_link with meeting_id "${SEED.pilot}" and event null.
5. Call set_attendees with meeting_id "${SEED.pilot}" and attendees [{"name": "Dana Reyes", "email": "dana@example.com"}, {"name": "Lee Park"}].`,
    },
    {
      id: "J07-folders",
      title: "Folders",
      tools: [
        "create_folder",
        "move_meetings",
        "list_folders",
        "get_folder_overview",
        "set_action_item_done",
        "get_folder_standing",
        "set_folder_standing",
        "update_folder",
      ],
      prompt: `${PRE(h)}
1. Call create_folder with name "Harness ${tag}" and description "Made by the MCP harness."
2. Call move_meetings with meeting_ids ["${SEED.pilot}", "${SEED.interview}"] and folder_id = the id of the new folder.
3. Call list_folders.
4. Call get_folder_overview with folder_id "${SEED.folder}". Find the key of the first action item.
5. Call set_action_item_done with folder_id "${SEED.folder}", that key and done true.
6. Call get_folder_standing with folder_id "${SEED.folder}".
7. Call set_folder_standing with folder_id "${SEED.folder}" and bullets ["Onboarding change in review (${tag}).", "Safari login fix needs a second reviewer."].
8. Call update_folder with folder_id = the id of the new folder and name "Harness ${tag} renamed".`,
    },
    {
      id: "J08-open-items",
      title: "Open items",
      tools: [
        "list_open_items",
        "create_open_item",
        "add_open_item_mark",
        "update_open_item",
      ],
      prompt: `${PRE(h)}
1. Call list_open_items with folder_id "${SEED.folder}".
2. Call create_open_item with meeting_id "${SEED.meeting}", kind "action", text "Book the release review (${tag})", quote "I will have it ready for review on Thursday." and owner "Alex".
3. Call add_open_item_mark with item_id = the id of the new item, meeting_id "${SEED.meeting}", status "done" and quote "I will have it ready for review on Thursday."
4. Call update_open_item with item_id = the id of the new item and text "Book the release review for Thursday (${tag})".`,
    },
    {
      id: "J09-ask-history",
      title: "Ask and history",
      tools: [
        "list_ask_threads",
        "get_ask_thread",
        "rename_ask_thread",
        "list_dictations",
        "get_dictation",
      ],
      prompt: `${PRE(h)}
1. Call list_ask_threads with meeting_id "${SEED.meeting}".
2. Call get_ask_thread with thread_id "${SEED.keepThread}".
3. Call rename_ask_thread with thread_id "${SEED.keepThread}" and title "Release date (${tag})".
4. Call list_dictations with limit 5.
5. Call get_dictation with the id of the first dictation in that list.`,
    },
    {
      id: "J10-vocabulary",
      title: "Vocabulary from meetings",
      tools: [
        "search_meetings",
        "get_transcript",
        "add_vocabulary",
        "update_vocabulary",
        "list_vocabulary",
      ],
      prompt: `${PRE(h)}
1. Call search_meetings with query "Safari".
2. Call get_transcript with meeting_id "${SEED.meeting}" and limit 20.
3. Call add_vocabulary with terms [{"term": "Alex Rivera ${tag}"}, {"term": "Safari Tech Preview ${tag}"}, {"term": "Kestrel ${tag}", "notes": "Project name"}].
4. Call list_vocabulary with query "Kestrel ${tag}" and find its id.
5. Call update_vocabulary with that id and notes "Project name, fixed by the agent".
6. Call list_vocabulary with no query.`,
    },
    {
      id: "J11-settings",
      title: "Config with live apply, and app-shell settings",
      tools: [
        "list_settings",
        "set_setting",
        "get_app_settings",
        "set_app_settings",
      ],
      prompt: `${PRE(h)}
1. Call list_settings.
2. Call set_setting with key "chat_hotkey" and value "Control+Alt+J".
3. Call set_setting with key "output_mode" and value "clipboard".
4. Call set_setting with key "sound_enabled" and value "false".
5. Call get_app_settings.
6. Call set_app_settings with pill_position "bottom-right" and launch_at_login false.
7. Call set_setting with key "network_proxy_url" and value "http://proxy.example.com:8080". Expect a refusal.`,
    },
    {
      id: "J12a-model-download",
      title: "Model download",
      tools: ["list_models", "download_model", "get_download_status"],
      prompt: `${PRE(h)}
1. Call list_models.
2. Call download_model with model_id "${SEED.model}".
3. Call get_download_status with model_id "${SEED.model}" once.`,
    },
    {
      id: "J12b-jobs",
      title: "Jobs",
      tools: [
        "get_download_status",
        "start_meeting_job",
        "list_jobs",
        "cancel_meeting_job",
      ],
      prompt: `${PRE(h)}
1. Call get_download_status with model_id "${SEED.model}".
2. Call start_meeting_job with meeting_id "${SEED.meeting}" and kind "summarize".
3. Call list_jobs.
4. Call start_meeting_job with meeting_id "${SEED.pilot}" and kind "enhance".
5. Call cancel_meeting_job with meeting_id "${SEED.pilot}".
6. Call list_jobs.`,
    },
    {
      id: "J13-delete-consent",
      title: "Delete with consent",
      tools: [
        "delete_meeting",
        "delete_folder",
        "delete_open_item",
        "delete_ask_thread",
        "delete_dictation",
        "delete_vocabulary",
      ],
      prompt: `${PRE(h)}
Part A. Call each delete tool once WITHOUT the confirm argument. Each call must give a refusal.
1. delete_meeting with meeting_id "${SEED.deleteMeeting}".
2. delete_folder with folder_id "${SEED.deleteFolder}".
3. delete_open_item with item_id "${SEED.deleteItem}".
4. delete_ask_thread with thread_id "${SEED.deleteThread}".
5. delete_dictation with dictation_id ${ctx.deleteDictationId}.
6. delete_vocabulary with vocabulary_id ${ctx.deleteTermId}.
Part B. The user agrees to all six deletes. Call each delete tool again with the same id and confirm true.
7. delete_meeting, 8. delete_folder, 9. delete_open_item, 10. delete_ask_thread, 11. delete_dictation, 12. delete_vocabulary.`,
    },
    {
      id: "J15-live",
      title: "Follow the live transcript",
      live: true,
      tools: ["get_live_transcript", "set_setting"],
      prompt: `${PRE(h)}
1. Call get_live_transcript with no arguments. Expect the text that live transcription is off.
2. Call set_setting with key "live_chat_enabled" and value "true".
3. Call get_live_transcript with no arguments. Note cursor.
4. Call get_live_transcript again with since_seq = that cursor.
5. Call get_live_transcript again with since_seq = the new cursor.
6. Write the lines that you got in each call.`,
    },
    {
      id: "J14-failures",
      title: "Failure messages",
      failure: true,
      tools: ["openstyle_status"],
      prompt: `${PRE(h)}
1. Look at the tools of the server "${SERVER}". If the tool openstyle_status is there, call it with no arguments. Else call list_meetings with no arguments.
2. In your final answer, quote the exact text of the tool result.`,
    },
  ].filter((j) => !j.only || j.only === h);
}

/** The text of section 5 that each failure mode must show. */
// The texts of specs/mcp.md section 5 (server: apps/server/src/mcp/index.ts,
// bridge: apps/electron/src/mcp-bridge/bridge.ts).
export const FAILURE_TEXTS = {
  off: "Agent access is off. Turn on Settings > Agents (MCP) in Openstyle.",
  token:
    "Openstyle refused the connection key of this agent. Quit Openstyle and start it again, then try again.",
  down: "Openstyle is not running. Start the app, then try again.",
};
export const CONFIRM_TEXT = "Ask the user, then call again with confirm: true";
export const LIVE_OFF_TEXT = "Live transcription is off.";
/** The two lines of the J15 late-line step (live-server.ts). */
export const LIVE_FAR_LINE = "The last truck leaves the pier at five.";
export const LIVE_LATE_LINE = "The pilot boat waits at the south buoy.";
