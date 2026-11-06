# MCP harness evidence matrix

Run: 2026-11-06T15:54:08.962Z. Data: fictional seed only. Server name: `openstyle-dev`.

| Tool | claude | pi | Evidence (first harness) |
|---|---|---|---|
| list_meetings | ok | ok | evidence/claude/J01-connect-claude.jsonl (J01-connect-claude) |
| get_meeting | ok | ok | evidence/claude/J03-summary.jsonl (J03-summary) |
| update_meeting | ok | ok | evidence/claude/J06-meeting-fields.jsonl (J06-meeting-fields) |
| set_calendar_link | ok | ok | evidence/claude/J06-meeting-fields.jsonl (J06-meeting-fields) |
| set_attendees | ok | ok | evidence/claude/J06-meeting-fields.jsonl (J06-meeting-fields) |
| list_tags | ok | ok | evidence/claude/J06-meeting-fields.jsonl (J06-meeting-fields) |
| set_meeting_tags | ok | ok | evidence/claude/J06-meeting-fields.jsonl (J06-meeting-fields) |
| move_meetings | ok | ok | evidence/claude/J07-folders.jsonl (J07-folders) |
| delete_meeting | ok | ok | evidence/claude/J13-delete-consent.jsonl (J13-delete-consent) |
| search_meetings | ok | ok | evidence/claude/J10-vocabulary.jsonl (J10-vocabulary) |
| get_live_transcript | ok | ok | evidence/claude/J15-live.jsonl (J15-live) |
| get_transcript | ok | ok | evidence/claude/J03-summary.jsonl (J03-summary) |
| set_enhanced_segments | ok | ok | evidence/claude/J04-enhanced.jsonl (J04-enhanced) |
| update_speaker | ok | ok | evidence/claude/J05-speakers.jsonl (J05-speakers) |
| get_summary_versions | ok | ok | evidence/claude/J03-summary.jsonl (J03-summary) |
| set_summary | ok | ok | evidence/claude/J03-summary.jsonl (J03-summary) |
| start_meeting_job | ok | ok | evidence/claude/J12b-jobs.jsonl (J12b-jobs) |
| cancel_meeting_job | ok | ok | evidence/claude/J12b-jobs.jsonl (J12b-jobs) |
| list_jobs | ok | ok | evidence/claude/J12b-jobs.jsonl (J12b-jobs) |
| list_folders | ok | ok | evidence/claude/J07-folders.jsonl (J07-folders) |
| create_folder | ok | ok | evidence/claude/J07-folders.jsonl (J07-folders) |
| update_folder | ok | ok | evidence/claude/J07-folders.jsonl (J07-folders) |
| delete_folder | ok | ok | evidence/claude/J13-delete-consent.jsonl (J13-delete-consent) |
| get_folder_overview | ok | ok | evidence/claude/J07-folders.jsonl (J07-folders) |
| set_action_item_done | ok | ok | evidence/claude/J07-folders.jsonl (J07-folders) |
| get_folder_standing | ok | ok | evidence/claude/J07-folders.jsonl (J07-folders) |
| set_folder_standing | ok | ok | evidence/claude/J07-folders.jsonl (J07-folders) |
| list_ask_threads | ok | ok | evidence/claude/J09-ask-history.jsonl (J09-ask-history) |
| get_ask_thread | ok | ok | evidence/claude/J09-ask-history.jsonl (J09-ask-history) |
| rename_ask_thread | ok | ok | evidence/claude/J09-ask-history.jsonl (J09-ask-history) |
| delete_ask_thread | ok | ok | evidence/claude/J13-delete-consent.jsonl (J13-delete-consent) |
| list_dictations | ok | ok | evidence/claude/J09-ask-history.jsonl (J09-ask-history) |
| get_dictation | ok | ok | evidence/claude/J09-ask-history.jsonl (J09-ask-history) |
| delete_dictation | ok | ok | evidence/claude/J13-delete-consent.jsonl (J13-delete-consent) |
| list_open_items | ok | ok | evidence/claude/J08-open-items.jsonl (J08-open-items) |
| create_open_item | ok | ok | evidence/claude/J08-open-items.jsonl (J08-open-items) |
| update_open_item | ok | ok | evidence/claude/J08-open-items.jsonl (J08-open-items) |
| add_open_item_mark | ok | ok | evidence/claude/J08-open-items.jsonl (J08-open-items) |
| delete_open_item | ok | ok | evidence/claude/J13-delete-consent.jsonl (J13-delete-consent) |
| list_vocabulary | ok | ok | evidence/claude/J10-vocabulary.jsonl (J10-vocabulary) |
| add_vocabulary | ok | ok | evidence/claude/J10-vocabulary.jsonl (J10-vocabulary) |
| update_vocabulary | ok | ok | evidence/claude/J10-vocabulary.jsonl (J10-vocabulary) |
| delete_vocabulary | ok | ok | evidence/claude/J13-delete-consent.jsonl (J13-delete-consent) |
| list_settings | ok | ok | evidence/claude/J11-settings.jsonl (J11-settings) |
| set_setting | ok | ok | evidence/claude/J11-settings.jsonl (J11-settings) |
| get_app_settings | ok | ok | evidence/claude/J11-settings.jsonl (J11-settings) |
| set_app_settings | ok | ok | evidence/claude/J11-settings.jsonl (J11-settings) |
| list_models | ok | ok | evidence/claude/J12a-model-download.jsonl (J12a-model-download) |
| download_model | ok | ok | evidence/claude/J12a-model-download.jsonl (J12a-model-download) |
| get_download_status | ok | ok | evidence/claude/J12a-model-download.jsonl (J12a-model-download) |

Cells ok: 100 of 100.

## claude

- Install: ok, Codex install: ok
- Remove: ok
- J14 failure texts: ok
- J15 live: ok (cursors [14800,17800,17800])

## pi

- Install: ok
- Remove: ok
- J14 failure texts: ok
- J15 live: ok (cursors [11800,14800,17800])

## Real agent configs (before and after)

```json
{
  "before": {
    "files": [
      {
        "path": "~/.claude.json",
        "size": 524775,
        "mtime": "2026-11-06T15:35:33.837Z"
      },
      {
        "path": "~/.claude/settings.json",
        "size": 8386,
        "mtime": "2026-11-05T18:24:40.432Z"
      },
      {
        "path": "~/.pi/agent/mcp.json",
        "size": 2354,
        "mtime": "2026-10-05T11:59:00.414Z"
      },
      {
        "path": "~/.pi/agent/settings.json",
        "size": 1812,
        "mtime": "2026-10-27T18:10:20.344Z"
      },
      {
        "path": "~/.pi/agent/trust.json",
        "size": 207,
        "mtime": "2026-10-02T21:30:15.813Z"
      },
      {
        "path": "~/.pi/agent/mcp-project-approvals.json",
        "size": 299,
        "mtime": "2026-10-01T17:31:36.978Z"
      },
      {
        "path": "~/.codex/config.toml",
        "size": 8148,
        "mtime": "2026-10-30T17:31:59.804Z"
      }
    ],
    "openstyleEntries": {
      "claude": [],
      "pi": [],
      "codex": true
    }
  },
  "after": {
    "files": [
      {
        "path": "~/.claude.json",
        "size": 524775,
        "mtime": "2026-11-06T15:46:00.160Z"
      },
      {
        "path": "~/.claude/settings.json",
        "size": 8386,
        "mtime": "2026-11-05T18:24:40.432Z"
      },
      {
        "path": "~/.pi/agent/mcp.json",
        "size": 2354,
        "mtime": "2026-10-05T11:59:00.414Z"
      },
      {
        "path": "~/.pi/agent/settings.json",
        "size": 1812,
        "mtime": "2026-10-27T18:10:20.344Z"
      },
      {
        "path": "~/.pi/agent/trust.json",
        "size": 207,
        "mtime": "2026-10-02T21:30:15.813Z"
      },
      {
        "path": "~/.pi/agent/mcp-project-approvals.json",
        "size": 299,
        "mtime": "2026-10-01T17:31:36.978Z"
      },
      {
        "path": "~/.codex/config.toml",
        "size": 8148,
        "mtime": "2026-10-30T17:31:59.804Z"
      }
    ],
    "openstyleEntries": {
      "claude": [],
      "pi": [],
      "codex": true
    }
  },
  "openstyleLogs": {
    "before": [
      {
        "file": "openstyle-server.log",
        "size": 705780,
        "mtime": "2026-11-06T15:21:44.585Z"
      },
      {
        "file": "openstyle-trace.log",
        "size": 4295485,
        "mtime": "2026-11-06T15:21:44.584Z"
      },
      {
        "file": "openstyle-trace1.log",
        "size": 5253484,
        "mtime": "2026-11-05T16:09:22.279Z"
      },
      {
        "file": "openstyle-trace2.log",
        "size": 5255801,
        "mtime": "2026-11-03T13:33:46.986Z"
      },
      {
        "file": "openstyle.log",
        "size": 295839,
        "mtime": "2026-11-06T15:35:29.100Z"
      },
      {
        "file": "openstyle1.log",
        "size": 2097263,
        "mtime": "2026-10-30T19:35:30.534Z"
      },
      {
        "file": "openstyle2.log",
        "size": 2101072,
        "mtime": "2026-09-21T15:00:38.785Z"
      }
    ],
    "after": [
      {
        "file": "openstyle-server.log",
        "size": 705780,
        "mtime": "2026-11-06T15:21:44.585Z"
      },
      {
        "file": "openstyle-trace.log",
        "size": 4295485,
        "mtime": "2026-11-06T15:21:44.584Z"
      },
      {
        "file": "openstyle-trace1.log",
        "size": 5253484,
        "mtime": "2026-11-05T16:09:22.279Z"
      },
      {
        "file": "openstyle-trace2.log",
        "size": 5255801,
        "mtime": "2026-11-03T13:33:46.986Z"
      },
      {
        "file": "openstyle.log",
        "size": 296343,
        "mtime": "2026-11-06T15:50:29.323Z"
      },
      {
        "file": "openstyle1.log",
        "size": 2097263,
        "mtime": "2026-10-30T19:35:30.534Z"
      },
      {
        "file": "openstyle2.log",
        "size": 2101072,
        "mtime": "2026-09-21T15:00:38.785Z"
      }
    ]
  },
  "tccPrompts": {
    "before": 0,
    "after": 0
  },
  "claudeInit": {
    "mcp_servers": [
      {
        "name": "openstyle-dev",
        "status": "connected",
        "source": "dynamic"
      }
    ],
    "openstyleTools": 50
  }
}
```
