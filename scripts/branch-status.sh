#!/usr/bin/env bash
# Branch lifecycle report: open PRs, branches, worktrees and stashes, with
# the problems the branch policy forbids (.claude/skills/branch-lifecycle).
# Read-only. Runs at session start (SessionStart hook) and before new work.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 0
REPO="${BRANCH_STATUS_REPO:-Maheidem/openstyle}"
WIP_LIMIT=2
STALE_DAYS=2
now=$(date +%s)
problems=0
flag() { echo "  !! $*"; problems=$((problems + 1)); }

timeout 20 git fetch -q --prune origin 2>/dev/null || echo "  (fetch failed; remote data may be old)"

echo "== Open PRs ($REPO) =="
prs=$(timeout 20 gh pr list --repo "$REPO" --state open --json number,headRefName,isDraft,updatedAt,autoMergeRequest,statusCheckRollup \
  --jq '.[] | [.number, .headRefName, (if .isDraft then "draft" else "ready" end), .updatedAt, (if .autoMergeRequest then "auto-merge" else "-" end), ([.statusCheckRollup[]? | select(.name=="CI Status") | (.conclusion // .status)] | first // "no-CI")] | @tsv' 2>/dev/null)
pr_branches=""
if [ -z "$prs" ]; then echo "  (none)"; fi
while IFS=$'\t' read -r num br state upd am ci; do
  [ -z "${num:-}" ] && continue
  pr_branches="$pr_branches $br"
  age=$(( (now - $(date -j -f %Y-%m-%dT%H:%M:%SZ "$upd" +%s 2>/dev/null || echo "$now")) / 86400 ))
  echo "  #$num $br [$state] CI=$ci $am updated ${age}d ago"
  [ "$age" -ge "$STALE_DAYS" ] && flag "#$num stale (${age}d): finish or close it before new work"
done <<< "$prs"
open_count=$(printf '%s\n' "$prs" | grep -c . || true)
[ "$open_count" -gt "$WIP_LIMIT" ] && flag "$open_count open PRs > WIP limit $WIP_LIMIT"

echo "== Local branches =="
for br in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
  [ "$br" = main ] && continue
  up=$(git rev-parse --abbrev-ref "$br@{upstream}" 2>/dev/null || echo "")
  unmerged=$(git cherry origin/main "$br" 2>/dev/null | grep -c '^+' || true)
  echo "  $br upstream=${up:-NONE} commits-not-on-main=$unmerged"
  [ -z "$up" ] && flag "$br is local only: push it and open a draft PR"
  case " $pr_branches " in *" $br "*) ;; *) [ "$unmerged" -eq 0 ] && flag "$br is fully on main: delete it" || flag "$br has no open PR";; esac
done

echo "== Remote branches without an open PR =="
for rb in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/ | grep -v -E '^origin(/HEAD|/main)?$'); do
  br=${rb#origin/}
  case "$br" in release/*) continue;; esac
  case " $pr_branches " in *" $br "*) ;; *) flag "origin/$br has no open PR";; esac
done

echo "== Worktrees =="
git worktree list | sed 's/^/  /'
git worktree list --porcelain | awk '/^worktree /{p=$2} /^detached/{print p}' | while read -r p; do
  [ "$p" != "$(pwd)" ] && echo "  !! detached worktree $p: remove it (git worktree remove)"
done

echo "== Stashes =="
st=$(git stash list); [ -z "$st" ] && echo "  (none)" || { echo "$st" | sed 's/^/  /'; flag "stashes exist: turn them into a branch + PR or drop them"; }

echo "== Result: $problems problem(s) =="
exit 0
