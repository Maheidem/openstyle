#!/usr/bin/env bash
# council.sh — three-judge council for meeting quality changes (PR #36).
#
# A quality change (meeting transcript output) is judged by three
# independent judges: Claude (the coordinator), pi (the local model),
# Codex (the cloud — the owner approves it per data set). Each judge
# reads the SAME compare.mts output files and writes judge-<who>.md
# with a fixed machine-readable header line. The owner releases only
# on consensus (all SHIP); otherwise the divergence is found and
# reported, and the result is recorded in the spec.
# See .claude/skills/council/SKILL.md.
#
# Usage:
#   scripts/council.sh prepare <round-name> <compare-file>...
#   scripts/council.sh collect <round-name>
#
# prepare: writes /tmp/meeting-v2/council/<round-name>/ with brief-
#   claude.md, brief-pi.md and brief-codex.md (identical rubric) and
#   tells each judge to write its verdict to judge-<who>.md there.
#   The compare files must come from scripts/meeting-v2/compare.mts
#   (self-checked); prepare refuses missing files and warns about
#   files outside the compare.mts output dir (/tmp/meeting-v2/compare).
#
# collect: reads judge-claude.md, judge-pi.md, judge-codex.md, prints
#   one table (judge, verdict, counts) and CONSENSUS: yes|no.
#   exit 0 = all SHIP (consensus), 2 = disagreement or an unparseable
#   verdict, 3 = a judge file is missing.
set -uo pipefail

COUNCIL_DIR=/tmp/meeting-v2/council
JUDGES="claude pi codex"
COMPARE_LIST=""

usage() {
  echo "usage: council.sh prepare <round-name> <compare-file>... | council.sh collect <round-name>" >&2
  exit 2
}

check_round() {
  case "$1" in
    "" | -* | *[!a-z0-9-]*)
      echo "REFUSED: bad round name: '$1' (lowercase letters, digits and '-')" >&2
      exit 2
      ;;
  esac
}

write_brief() {
  local round=$1 who=$2 dir=$3 note=$4
  {
    echo "# Council brief — round $round — judge: $who"
    echo
    echo "You are one of three independent judges of a meeting quality change (round $round)."
    echo "Read the compare files below and judge every changed region."
    echo
    echo "Compare files (produced by scripts/meeting-v2/compare.mts; self-checked, never hand-edited):"
    printf '%s' "$COMPARE_LIST"
    echo
    echo "Rubric (identical for all three judges):"
    echo "- Each changed region is BETTER, WORSE or SAME-ISH."
    echo "- Tag every region with every tag that applies: CUT-OK, CUT-BAD,"
    echo "  LABEL-FIX, LABEL-BAD, MISSED-CHANGE, LOST, DUP, PUNCT, TEXT, OTHER."
    echo "- Quote at most 6 words of transcript per observation."
    echo "- The totals count every judged region: BETTER, WORSE, SAME (SAME-ISH goes to SAME)."
    echo
    echo "Verdict (exactly one):"
    echo "- SHIP: the change is net good; nothing blocks the release."
    echo "- FIX-FIRST: name the fix that must land first."
    echo "- REVERT: the change is net worse."
    echo
    echo "OUTPUT: write your judgment to $dir/judge-$who.md"
    echo "Line 1 must be exactly this machine-readable header (one line):"
    echo "  VERDICT: <SHIP|FIX-FIRST|REVERT> BETTER=<n> WORSE=<n> SAME=<n>"
    echo "Under it: your per-region reasoning; for FIX-FIRST, name the fix."
    echo
    echo "$note"
  } > "$dir/brief-$who.md"
}

prepare() {
  local round=$1; shift
  check_round "$round"
  if [ $# -lt 1 ]; then
    echo "REFUSED: prepare needs at least one compare file" >&2
    exit 2
  fi
  local f dir list="" who note
  dir=$COUNCIL_DIR/$round
  for f in "$@"; do
    [ -f "$f" ] || { echo "REFUSED: compare file missing: $f" >&2; exit 2; }
  done
  for f in "$@"; do
    case "$f" in
      /tmp/meeting-v2/compare/*) ;;
      *) echo "warning: $f is not under /tmp/meeting-v2/compare (compare.mts output dir)" ;;
    esac
    list="$list  - $f
"
  done
  mkdir -p "$dir" || { echo "REFUSED: cannot create $dir" >&2; exit 2; }
  COMPARE_LIST=$list
  for who in $JUDGES; do
    case "$who" in
      claude)
        note="You are the coordinator judge (Claude). Write your own verdict BEFORE reading the pi or Codex verdict files: do not read judge-pi.md or judge-codex.md before judge-claude.md is written."
        ;;
      pi)
        note="You are the pi judge (the local model). Read only the compare files named above. Do not read the other judges' verdict files."
        ;;
      codex)
        note="You are the Codex judge. Your text goes to the cloud: the owner must approve this data set BEFORE the coordinator sends you the compare files. Judge only after the owner approved."
        ;;
    esac
    write_brief "$round" "$who" "$dir" "$note"
  done
  echo "prepared $dir:"
  echo "  brief-claude.md -> judge-claude.md"
  echo "  brief-pi.md     -> judge-pi.md"
  echo "  brief-codex.md  -> judge-codex.md"
  echo "compare files:"
  printf '%s' "$list"
  echo "then: scripts/council.sh collect $round"
}

collect() {
  local round=$1
  check_round "$round"
  local dir=$COUNCIL_DIR/$round
  local who f hdr verdict b w s
  local missing="" all_ship=yes
  printf '%-8s  %-10s  %s\n' "judge" "verdict" "BETTER WORSE SAME"
  for who in $JUDGES; do
    f=$dir/judge-$who.md
    if [ ! -f "$f" ]; then
      missing="$missing $who"
      all_ship=no
      printf '%-8s  %-10s  %s\n' "$who" MISSING "-"
      continue
    fi
    hdr=$(grep -m1 -E '^VERDICT: (SHIP|FIX-FIRST|REVERT) BETTER=[0-9]+ WORSE=[0-9]+ SAME=[0-9]+$' "$f" || true)
    if [ -z "$hdr" ]; then
      all_ship=no
      printf '%-8s  %-10s  %s\n' "$who" INVALID "-"
      continue
    fi
    verdict=${hdr#VERDICT: }
    verdict=${verdict%% *}
    b=$(printf '%s\n' "$hdr" | sed -E 's/.*BETTER=([0-9]+).*/\1/')
    w=$(printf '%s\n' "$hdr" | sed -E 's/.*WORSE=([0-9]+).*/\1/')
    s=$(printf '%s\n' "$hdr" | sed -E 's/.*SAME=([0-9]+).*/\1/')
    printf '%-8s  %-10s  %s %s %s\n' "$who" "$verdict" "$b" "$w" "$s"
    [ "$verdict" = SHIP ] || all_ship=no
  done
  if [ "$all_ship" = yes ]; then echo "CONSENSUS: yes"; else echo "CONSENSUS: no"; fi
  if [ -n "$missing" ]; then
    echo "missing judge files:$missing" >&2
    exit 3
  fi
  [ "$all_ship" = yes ] && exit 0
  exit 2
}

cmd=${1:-}
[ -n "$cmd" ] || usage
shift || true
case "$cmd" in
  prepare)
    [ $# -ge 1 ] || usage
    prepare "$@"
    ;;
  collect)
    [ $# -eq 1 ] || usage
    collect "$1"
    ;;
  *)
    usage
    ;;
esac
