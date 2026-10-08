---
name: council
description: Judge a meeting quality change (transcript output) with a three-judge council — Claude (coordinator), pi (local model), Codex (cloud, owner-approved per data set). Release only on consensus. Use before releasing any meeting quality change, after the compare.mts files exist.
---

# Council (three judges for meeting quality changes)

One judge reading the compare files is not enough. A quality change (meeting transcript output) is judged by three independent judges who read the SAME self-checked compare files and write the same rubric. The owner releases only on consensus.

The script is `scripts/council.sh` (PR #36). Round state lives in `/tmp/meeting-v2/council/<round>/`.

## Procedure

1. **The compare files must come from `scripts/meeting-v2/compare.mts`** (one word: `pnpm meeting:compare ...`). It self-checks both sides against the stored dumps and exits non-zero on a mismatch. Never judge a hand-edited file or a copy-edited per-run compare script (that is how the 2026-10-07 false findings happened — see the meeting-benchmarks skill, "Compare tools must check themselves").
2. **Prepare the round** (one round per quality change, e.g. `r4h-test`, `r5`):
   ```bash
   bash scripts/council.sh prepare <round> <compare-file>...
   ```
   Writes `brief-claude.md`, `brief-pi.md`, `brief-codex.md` with the identical rubric: per changed region BETTER / WORSE / SAME-ISH; tags CUT-OK, CUT-BAD, LABEL-FIX, LABEL-BAD, MISSED-CHANGE, LOST, DUP, PUNCT, TEXT, OTHER; quote at most 6 words of transcript per observation; verdict SHIP / FIX-FIRST (name the fix) / REVERT.
3. **Each judge writes its verdict** to `/tmp/meeting-v2/council/<round>/judge-<who>.md`. Line 1 must be the machine-readable header:
   ```
   VERDICT: <SHIP|FIX-FIRST|REVERT> BETTER=<n> WORSE=<n> SAME=<n>
   ```
   with the per-region reasoning under it.
   - **Claude is the coordinator and writes its own verdict BEFORE reading the pi or Codex verdict files.** Reading the others first is how independent judges stop being independent.
   - **pi** is the local model: hand it `brief-pi.md` (via the pi-briefs skill). It reads the compare files on the owner's Mac.
   - **Codex sends the meeting text to the cloud.** The owner must approve it per data set BEFORE the coordinator sends the compare files. No data set is sent without that approval.
4. **Collect:**
   ```bash
   bash scripts/council.sh collect <round>
   ```
   Prints one table (judge, verdict, BETTER/WORSE/SAME counts) and `CONSENSUS: yes|no`. Exit codes: `0` all SHIP, `2` disagreement (or an unparseable verdict), `3` a judge file is missing.
5. **The owner's rule: release only on consensus** (all three SHIP). On any other outcome, find the divergence — which region each judge rated differently and why — and report it. A FIX-FIRST names the fix; a REVERT means the change rolls back.
6. **Record the result in the spec** (`specs/meeting-transcription-v2.md`, next to the run's record in 5.0): round name, compare files, each judge's verdict line, the consensus, and the decision.

## What the council is NOT

- Not a metrics gate: metrics pass first (see the meeting-benchmarks acceptance), the council judges the text quality of the changed regions.
- Not a retry loop: a disagreement is reported to the owner with the diverging regions, not re-run until it agrees.
