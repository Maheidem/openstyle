#!/usr/bin/env bash
# Close out a merged PR: prove its changes are on main, then delete the local
# branch and its worktree. Usage: scripts/branch-closeout.sh <pr-number>
# Safe after squash merges (git cherry gives false alarms there).
set -euo pipefail
pr="${1:?usage: branch-closeout.sh <pr-number>}"
REPO="${BRANCH_STATUS_REPO:-Maheidem/openstyle}"
cd "$(git rev-parse --show-toplevel)"
read -r state branch head merge < <(gh pr view "$pr" --repo "$REPO" --json state,headRefName,headRefOid,mergeCommit \
  --jq '[.state, .headRefName, .headRefOid, (.mergeCommit.oid // "")] | @tsv')
[ "$state" = MERGED ] || { echo "PR #$pr is $state, not MERGED: nothing to close out"; exit 1; }
git fetch -q --prune origin
git cat-file -e "$head" && git cat-file -e "$merge" || { echo "missing commit $head or $merge locally"; exit 1; }
base=$(git merge-base "$head" "$merge^")
# Compare the changed lines exactly, but not the hunk headers (@@ line numbers)
# or index lines: when another PR merged first and moved lines in a shared
# file, the same change sits at other line numbers (2026-10-08, PR #35).
strip() { grep -v -e '^@@' -e '^index ' || true; }
pr_diff=$(git diff "$base" "$head" | strip)
sq_diff=$(git diff "$merge^" "$merge" | strip)
[ -n "$pr_diff" ] || { echo "PR diff is empty: refusing (cannot prove anything)"; exit 1; }
[ "$pr_diff" = "$sq_diff" ] || { echo "PR #$pr changes differ from merge commit ${merge:0:7}: NOT deleting $branch"; exit 1; }
echo "verified: PR #$pr changes == ${merge:0:7} ($(printf '%s\n' "$pr_diff" | wc -l | tr -d ' ') diff lines)"
wt=$(git worktree list --porcelain | awk -v b="refs/heads/$branch" '/^worktree /{p=$2} $0=="branch "b{print p}')
if [ -n "$wt" ] && [ "$wt" != "$(pwd)" ]; then git worktree remove "$wt" && echo "removed worktree $wt"; fi
if git show-ref -q --verify "refs/heads/$branch"; then
  [ "$(git branch --show-current)" = "$branch" ] && git switch -q main
  git branch -D "$branch" >/dev/null && echo "deleted local branch $branch"
fi
git merge -q --ff-only origin/main 2>/dev/null || true
