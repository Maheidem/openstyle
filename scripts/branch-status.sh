#!/usr/bin/env bash
# Branch lifecycle report: open PRs, branches, worktrees and stashes, with
# the problems the branch policy forbids (.claude/skills/branch-lifecycle).
# Read-only by default; runs at session start (SessionStart hook) and before
# new work. With --fix it also closes out merged PRs: for every local branch
# whose PR is MERGED it runs scripts/branch-closeout.sh <pr> (which verifies
# and deletes); a failed close-out is printed as !! and the run continues.
# The SessionStart hook stays read-only: with merged branches it prints
# `run: bash scripts/branch-status.sh --fix` instead of closing anything.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 0
FIX=0
for a in "$@"; do
  case "$a" in
    --fix) FIX=1 ;;
    -h|--help) echo "usage: branch-status.sh [--fix]"; exit 0 ;;
    *) echo "unknown argument: $a (usage: branch-status.sh [--fix])" >&2; exit 2 ;;
  esac
done
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
# Merged PRs (most recent 100) by head branch: a local branch whose PR is
# MERGED but not closed out is a leftover (branch-lifecycle: close out
# right after the merge).
merged_prs=$(timeout 20 gh pr list --repo "$REPO" --state merged --limit 100 --json number,headRefName \
  --jq '.[] | [.headRefName, .number] | @tsv' 2>/dev/null)
pr_branches=""
merged_list=""
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
  # A branch whose PR is already MERGED: report it and close it out in the
  # --fix section below (a squash merge leaves the branch's commits off
  # main, so the ordinary "commits not on main" checks do not apply).
  mnum=$(printf '%s\n' "$merged_prs" | awk -F'\t' -v b="$br" '$1==b{print $2; exit}')
  if [ -n "$mnum" ]; then
    echo "  $br MERGED (PR #$mnum)"
    merged_list="$merged_list $br:$mnum"
    continue
  fi
  up=$(git rev-parse --abbrev-ref "$br@{upstream}" 2>/dev/null || echo "")
  unmerged=$(git cherry origin/main "$br" 2>/dev/null | grep -c '^+' || true)
  ahead=0
  [ -n "$up" ] && ahead=$(git rev-list --count "$up..$br" 2>/dev/null || echo 0)
  echo "  $br upstream=${up:-NONE} commits-not-on-main=$unmerged unpushed=$ahead"
  [ -z "$up" ] && flag "$br is local only: push it and open a draft PR"
  [ "$ahead" -gt 0 ] && flag "$br has $ahead unpushed commit(s): push them"
  case " $pr_branches " in *" $br "*) ;; *) [ "$unmerged" -eq 0 ] && flag "$br is fully on main: delete it" || flag "$br has no open PR";; esac
done

if [ -n "$merged_list" ]; then
  if [ "$FIX" -eq 1 ]; then
    echo "== Close out merged PRs (--fix) =="
    for entry in $merged_list; do
      br=${entry%%:*}; mnum=${entry#*:}
      echo "-- close-out $br (PR #$mnum) --"
      if bash scripts/branch-closeout.sh "$mnum"; then
        echo "  closed out $br (PR #$mnum)"
      else
        flag "close-out FAILED for $br (PR #$mnum): run bash scripts/branch-closeout.sh $mnum"
      fi
    done
  else
    for entry in $merged_list; do
      br=${entry%%:*}; mnum=${entry#*:}
      flag "$br has a merged PR (#$mnum) that is not closed out"
    done
    echo "run: bash scripts/branch-status.sh --fix"
  fi
fi

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
