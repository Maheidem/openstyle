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
  remixHotkey: "remix_hotkey",
  remixBarEnabled: "remix_bar_enabled",
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
  meetingDiarizationEnabled: "meeting_diarization_enabled",
  meetingEnhanceAutoRun: "meeting_enhance_auto_run",
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
  networkCaCertPath: "network_ca_cert_path",
  networkProxyUrl: "network_proxy_url",
  outputMode: "output_mode",
  pausePlaybackWhileRecording: "pause_playback_while_recording",
  pillCancelButton: "pill_cancel_button",
  soundEnabled: "sound_enabled",
  theme: "theme",
  translateMode: "translate_mode",
  whisperKeepAliveMinutes: "whisper_keep_alive_minutes",
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];
