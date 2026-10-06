---
name: pi-briefs
description: How to delegate Openstyle work to pi children (the local model via pi-delegate) so they finish fast and correctly. Use before every pi_agent or pi_send_message that starts a task, and when a pi child is slow or stuck.
---

# Writing pi briefs

The project pins pi to `Desktop/qwen3.8-27b@adaptive`. This is a smaller local model. It does well on a narrow task with exact steps. It does badly on an open task, and it loses time when it must find a known fact again.

## Setup facts

- The pin file must list `extensions: @maheidem/model-discovery`. The `Desktop`, `local-mac` and `mac-m3` providers come from that extension. Without it the child fails with `Unknown provider "Desktop"`.
- pi children are lean. They do not load skills, `AGENTS.md`, `CLAUDE.md` or `.lore.md`. The brief must tell the child which files to read.
- A hook refuses a brief that names the pin file or the orchestrator config file by path. Write "the pi pin file" and "the orchestrator config file".
- Tell the child not to open image files with its read tool. On 2026-10-06 a turn ended with `stopReason "error"` right after the child read two WebP images. The likely cause is that the endpoint does not take image input. This is not confirmed. The coordinator looks at screenshots; the child reports file names, sizes and `sips -g pixelWidth -g pixelHeight` output. A failed turn keeps the images in its session, so start a new generation (`pi_agent` with the same name) instead of resuming.

## What to delegate

- Delegate: scoped code changes, builds, test runs, scripts, screenshots, measurements.
- Keep: decisions, design, review of the child's diffs and screenshots, the final evidence, and every outward action (push, merge, release, GitHub settings).
- If the task is open (research across many files, a design choice), use a Claude subagent and tell the owner.

## Brief template

```
SCOPE: <bug fix | feature | measurement | screenshots>, in one line. Approach is decided | your call.
READ FIRST: <.claude/skills/live-testing/SKILL.md, specs/<spec>.md section N, file:line of the code to change>
REPO / GIT: branch <name>; commit there only; never push or merge; commit trailers:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: <session url>
FILES YOU MAY CHANGE: <list>. Do not touch: <list>.
KNOWN FACTS: <everything already proven: routes, env vars, working commands, earlier results>
TASK: <numbered steps, each with one result>
RULES: <privacy, no port 4649, kill only your PIDs, no outward actions>
TIME BOX: <N> minutes. If a step fails 2 times, stop and report what failed. Do not dig.
VERIFY: <exact commands; "report the real output">
FINAL ANSWER: <what to return>; Simplified Technical English; metrics only for private data.
```

## Rules for good briefs

1. Put every known fact in the brief. Do not make the child find a route, an env var or a working command again. When a mechanism already worked in this project, give the command, not the question.
2. Give one deliverable per child. Split a long task into phases that each have their own verify step.
3. Write every acceptance check as a command with an expected output. A screenshot is an extra check for the owner, not the only check.
4. Name the files the child may change, and the files it must not touch.
5. When two children run at the same time, give each its own scratch folder. Tell each child that the other exists, and that it must not touch the other's processes.
6. Ask for real command output in the final answer, not a summary of it.

## Watch the child

- Send one message for each change of plan. On 2026-10-06 a child got "do not change the capture resolution", then the owner's choice to re-capture at 2x. It followed the first message and did not re-capture. When a decision replaces an earlier note, say so in the same message: "This replaces my note X."

- On every `done` event, read the result and look at its screenshots yourself before you report anything.
- On a `question` event, answer technical questions yourself with `pi_answer`. Ask the owner first (AskUserQuestion, then `relay_user:true`) when the answer changes scope or is outward-facing.
- If a child runs longer than its time box: read `pi_read {what:"transcript", last:8}` and `pi_list_agents {name}`. Signs of a stuck child are many steps on one bug, tokens above about 5 million, or the same file read again and again.
- If it is stuck, stop it with `pi_stop`, tell the owner, and give the job to a Claude agent. Give that agent the child's scratch folder and what already works.

## Example

The landing-page screen captures on 2026-10-06 ran 44 minutes and used 13.7 million tokens without one final image. Two things caused it:
- The brief asked the child to investigate a launch method that was already proven.
- The brief had no time box.

The fix: give the proven commands (see the live-testing skill), set a time box, and hand stuck work to a Claude agent.
