---
name: branch-lifecycle
description: The branch rules for Openstyle - every branch is born with a draft PR, at most 2 open at once, checked at session start, auto-merged on green CI and deleted. Use before creating any branch or worktree, at session start, before a handoff, and when branch-status reports a problem.
---

# Branch lifecycle

On 2026-10-08 the owner found trash branches, forgotten branches and lost or duplicated work. Agents and sessions forget; this policy makes GitHub remember. GitHub is the single list of open work.

## Rules (hard)

1. **A branch is born with a draft PR.** Create the branch, push it at once, open a draft PR. The PR body has: Goal, Spec (path + section), Owner (which session or pi child), Done when (a checklist with commands or checks). No local-only branch lives longer than the time to write its first commit.
2. **WIP limit: 2 open PRs.** To start a third, finish or close one. Do not start parallel work to avoid a decision.
3. **One branch per deliverable.** Name it `type/short-topic` (feat, fix, chore, docs, test). Never reuse a merged branch.
4. **Only the coordinator creates, pushes and merges branches.** pi children and subagents work on the branch they are given and never create, push, merge or delete branches. Their brief names the branch.
5. **Worktrees only for parallel lanes.** A worktree holds exactly one branch with an open PR. Create it with `git worktree add -b <branch> ../openstyle-<topic> origin/main`. Remove it when its PR merges or closes. No detached worktrees.
6. **No stashes as storage.** Turn a stash into a branch + draft PR, or drop it.
7. **main is protected** (ruleset "main: PR + green CI", id 24718487): no direct push, no force push, no deletion; only squash-merged PRs with a green `CI Status` check. Only the release bot (app 4715859) bypasses it, for Craft's release merge.
8. **Merge = auto-merge.** When the PR is ready: mark it ready (`gh pr ready`), then `gh pr merge --squash --auto`. GitHub merges when CI is green and deletes the branch. A quality change (meeting transcript output) needs the council verdict in the PR before `--auto`.
9. **Stale = 2 days.** A PR with no update for 2 days is finished or closed before any new work starts.

## Session start and end

```bash
bash scripts/branch-status.sh
```

- It lists open PRs (draft/ready, CI state, auto-merge, age), local branches (upstream, commits not on main), remote branches without a PR, worktrees, stashes, and every rule break as `!!`.
- A SessionStart hook runs it for every new session in this repo. Fix every `!!` line before you start new work.
- A handoff includes its output.

## Close-out checklist (after a merge)

- `git switch main && git pull --ff-only`
- `git branch -d <branch>` (squash merges need `-D` after you check `git cherry origin/main <branch>` shows no `+`)
- `git worktree remove ../openstyle-<topic>` if you used one
- `bash scripts/branch-status.sh` shows 0 problems for that branch.
