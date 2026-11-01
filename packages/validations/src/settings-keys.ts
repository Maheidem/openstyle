/**
 * The one registry of settings keys. The server and the Electron app both
 * import it, so a key string lives in one place only.
 */
export const SETTINGS_KEYS = {
  advancedMode: "advanced_mode",
  audioDuckingEnabled: "audio_ducking_enabled",
  audioPlaybackMode: "audio_playback_mode",
  cleanupAppAssignments: "cleanup_app_assignments",
  cleanupCustomPrompt: "cleanup_custom_prompt",
  cleanupEmailTone: "cleanup_email_tone",
  cleanupIntensity: "cleanup_intensity",
  cleanupOverallTone: "cleanup_overall_tone",
  cleanupPersonalTone: "cleanup_personal_tone",
  cleanupSampling: "cleanup_sampling",
  cleanupWorkTone: "cleanup_work_tone",
  hotkey: "hotkey",
  hotkeyMode: "hotkey_mode",
  historyPaused: "history_paused",
  historyRetentionDays: "history_retention_days",
  // Legacy singular language key. Kept for one-time migration reads only;
  // the canonical setting is now `languages` (a JSON array of ISO codes).
  language: "language",
  languageHotkeys: "language_hotkeys",
  languages: "languages",
  llmCleanup: "llm_cleanup",
  llmParameterPresets: "llm_parameter_presets",
  llmTaskAssignments: "llm_task_assignments",
  /** (model, task) -> profile links. The resolver reads only this map. */
  llmProfileLinks: "llm_profile_links",
  /** "1" once the links of the old task assignments are bound to a model. */
  llmProfileLinksMigrated: "llm_profile_links_migrated",
  /**
   * I1 (specs/meeting-transcription-v2.md §3.1): the previous-chunk
   * context for meeting transcription. Decision (owner, 2026-10-07):
   * OFF by default — only the value `"true"` turns it on; a missing row
   * or `"false"` means off.
   */
  meetingAsrContext: "meeting_asr_context",
  /**
   * Issue #169: JSON memory of the meeting audio devices. It holds the last
   * macOS default input that was not a transient Bluetooth default, and the
   * mic and output of the last recording. Main reads and writes it.
   */
  meetingAudioDevices: "meeting_audio_devices",
  /**
   * Link meetings to calendar events (specs/calendar-eventkit.md). OFF by
   * default (owner decision): only the value `"true"` turns it on. While it
   * is off, nothing reads the calendar.
   */
  calendarEnabled: "calendar_enabled",
  meetingDiarizationEnabled: "meeting_diarization_enabled",
  meetingEnhanceAutoRun: "meeting_enhance_auto_run",
  /**
   * Project memory (issue #234, specs/local-semantic-search.md 8.4): Summary
   * and Enhance of a filed meeting use earlier meetings of its folder. ON by
   * default (owner decision 2026-10-26, reversing 2026-10-22): a missing row
   * means on, and only `"false"` turns it off.
   */
  meetingProjectMemory: "meeting_project_memory",
  /**
   * Live transcript and chat during a recording (issue #375,
   * specs/live-chat.md). Experimental. OFF by default: only the value
   * `"true"` turns it on.
   */
  liveChatEnabled: "live_chat_enabled",
  /**
   * The meeting chat agent, Ask tab (specs/meeting-chat-agent.md 2.3 stage 0).
   * Experimental. OFF by default: only the value `"true"` turns it on.
   */
  meetingChatEnabled: "meeting_chat_enabled",
  /** Ask page (spec 2.9): tool rounds, 1 to 5. A missing row means 3. */
  chatRounds: "chat_rounds",
  /** Ask page: answer source budget in estimated tokens. A missing row means 6000. */
  chatSourceBudget: "chat_source_budget",
  /** Ask page: retrieval k, 3 to 20. A missing row means 8. */
  chatRetrievalK: "chat_retrieval_k",
  /** Ask page: turn deadline in seconds, 20 to 180. A missing row means 60. */
  chatDeadlineSeconds: "chat_deadline_seconds",
  /** Ask page: `"false"` turns the "search wider" offer off. */
  chatSearchWider: "chat_search_wider",
  /**
   * Ask page: the router uses the native tool calls of the local worker
   * (spec 2.1 point 6). A missing row means on; only `"false"` turns it off.
   */
  chatNativeTools: "chat_native_tools",
  /**
   * The global hotkey of the Ask bubble (spec 11.6.2). An accelerator such as
   * `Control+Alt+K`. A missing or empty row means the default of the platform.
   * It is registered only while `meeting_chat_enabled` is `"true"`.
   */
  chatHotkey: "chat_hotkey",
  /**
   * Stop saves the live transcript as the transcript of the meeting (mark
   * "From live"). OFF by default: only the value `"true"` turns it on. It
   * has an effect only while `live_chat_enabled` is on.
   */
  liveKeepTranscriptAtStop: "live_keep_transcript_at_stop",
  /**
   * Show the last live lines as captions in the recording pill (issue #375).
   * OFF by default: only the value `"true"` turns it on. It has an effect
   * only while `live_chat_enabled` is on.
   */
  liveCaptionsPill: "live_captions_pill",
  /**
   * I2 (specs/meeting-transcription-v2.md §3.2): the one-time auto-Enhance
   * prompt (or the onboarding step for new users) has been shown. Only
   * `"true"` counts as shown; a missing row means not shown yet. Written
   * by the prompt and the onboarding step; no other writer.
   */
  meetingEnhancePromptSeen: "meeting_enhance_prompt_seen",
  // The Enhance twin of `meetingSummaryTimeoutSeconds` below. It limits ONE
  // non-streaming LLM call per chunk. It does not limit the whole pass. The
  // key has three places: this file, `routes/settings.ts` (the bounds branch),
  // and `task-profiles.ts` -> `taskTimeoutMs()`. In version 2.8.0 the setting
  // shipped without effect because only some of these places existed.
  meetingEnhanceTimeoutSeconds: "meeting_enhance_timeout_seconds",
  meetingMaxDurationHours: "meeting_max_duration_hours",
  meetingRetentionDays: "meeting_retention_days",
  /**
   * I3 (specs/meeting-transcription-v2.md §3.3): JSON model pair meetings
   * transcribe with, instead of the default voice (dictation) model. An
   * empty string means missing — meetings use the dictation model.
   */
  meetingSttModel: "meeting_stt_model",
  meetingSummaryContextBudget: "meeting_summary_context_budget",
  meetingSummaryInstructions: "meeting_summary_instructions",
  meetingSummaryTimeoutSeconds: "meeting_summary_timeout_seconds",
  micDeviceId: "mic_device_id",
  mlxAsrKeepAliveMinutes: "mlx_asr_keep_alive_minutes",
  mlxLlmKeepAliveMinutes: "mlx_llm_keep_alive_minutes",
  /** JSON `MlxLlmKeepReady`: per task, keep the built-in local model loaded. */
  mlxLlmKeepReady: "mlx_llm_keep_ready",
  networkCaCertPath: "network_ca_cert_path",
  networkProxyUrl: "network_proxy_url",
  outputMode: "output_mode",
  /**
   * The name of the person who uses the app, for example "Ana Silva". Meeting
   * transcription puts it first in the ASR bias prompt, so the model spells
   * the owner's name right. An empty value or a missing row means no name.
   */
  ownerName: "owner_name",
  pausePlaybackWhileRecording: "pause_playback_while_recording",
  pillCancelButton: "pill_cancel_button",
  /**
   * The catalog id of the built-in embedding model for search
   * (specs/local-semantic-search.md 5.5). Written by
   * POST /api/mlx-embed/models/:id/use. Empty or missing means no model:
   * search is then off with reason `no_model`.
   */
  searchEmbeddingModel: "search_embedding_model",
  soundEnabled: "sound_enabled",
  theme: "theme",
  translateMode: "translate_mode",
  whisperKeepAliveMinutes: "whisper_keep_alive_minutes",
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];
