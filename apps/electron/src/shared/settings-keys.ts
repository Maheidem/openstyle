export const SETTINGS_KEYS = {
  advancedMode: "advanced_mode",
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
  localLlmApiKey: "local_llm_api_key",
  localLlmUrl: "local_llm_url",
  meetingDiarizationEnabled: "meeting_diarization_enabled",
  meetingEnhanceAutoRun: "meeting_enhance_auto_run",
  // The Enhance twin of `meetingSummaryTimeoutSeconds` below: bounds ONE
  // non-streaming LLM call per chunk, not the whole pass. Registered here, in
  // `routes/settings.ts` (the bounds branch) and read in
  // `task-profiles.ts` -> `taskTimeoutMs()` — all three existed separately at
  // various points, which is how the knob shipped as a phantom in 2.8.0.
  meetingEnhanceTimeoutSeconds: "meeting_enhance_timeout_seconds",
  meetingMaxDurationHours: "meeting_max_duration_hours",
  meetingRetentionDays: "meeting_retention_days",
  meetingSummaryContextBudget: "meeting_summary_context_budget",
  meetingSummaryInstructions: "meeting_summary_instructions",
  meetingSummaryTimeoutSeconds: "meeting_summary_timeout_seconds",
  micDeviceId: "mic_device_id",
  mlxAsrKeepAliveMinutes: "mlx_asr_keep_alive_minutes",
  networkCaCertPath: "network_ca_cert_path",
  networkProxyUrl: "network_proxy_url",
  omlxApiKey: "omlx_api_key",
  omlxBaseUrl: "omlx_base_url",
  openaiSttApiKey: "openai_stt_api_key",
  openaiSttBaseUrl: "openai_stt_base_url",
  outputMode: "output_mode",
  pillCancelButton: "pill_cancel_button",
  soundEnabled: "sound_enabled",
  theme: "theme",
  translateMode: "translate_mode",
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];
