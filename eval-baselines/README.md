# eval-baselines

Baselines of the meeting quality eval (`pnpm meeting:eval`). Each file is
the numbers-only scorecard of one run, so that a later run can say "better",
"worse" or "same" per stage.

**No text ever goes in this folder.** A baseline holds ids, counts and rates
only. It never holds transcript text, summary text, tag names or speaker
names. The gold keys (which hold real meeting text) stay in
`~/.openstyle-eval/gold/` on the owner's Mac and never come into the repo.

## Make and use a baseline

```bash
# Save: writes eval-baselines/<YYYY-MM-DD>-<name>.json (local date).
pnpm meeting:eval --models gemma-4-e2b-qat-4bit --gold --save-baseline main-2.19.0

# Noise bands: run the same setup again and store the bands in a second file.
pnpm meeting:eval --models gemma-4-e2b-qat-4bit --gold \
  --save-baseline main-2.19.0-b --noise-from eval-baselines/<date>-main-2.19.0.json

# Compare a change with a baseline. Exit 3 = regression.
pnpm meeting:eval --models gemma-4-e2b-qat-4bit --gold \
  --compare eval-baselines/<date>-main-2.19.0-b.json
```

The tool refuses to replace a file. Pick a new name for each baseline. Check
that the run used the gold versions you expect (`gold.versions`) before you
commit the file.

## Format (version 1)

```json
{
  "format": "openstyle-eval-baseline",
  "version": 1,
  "name": "main-2.19.0",
  "createdAt": "2026-10-21T10:00:00.000Z",
  "commit": "abc1234",
  "asrHash": "0123456789abcdef",
  "asrModel": "local-mlx/qwen3-1.7b-8bit",
  "models": ["gemma-4-e2b-qat-4bit"],
  "gold": { "source": "gold-v2", "versions": { "2943c36a": 3 } },
  "noise": { "asr.wer": 0.002 },
  "runs": [
    {
      "model": "gemma-4-e2b-qat-4bit",
      "meeting": "2943c36a",
      "stages": {
        "checks": { "hardFails": 0, "segments": 0, "numbers": 0 },
        "asr": { "wer": 0.1234, "wer.mic": 0.1, "werVerified": 0.08 },
        "enhance": { "wer": 0.11, "delta": 0.0134, "fixesFound": 4 },
        "summary": { "actionItemsRecall": 0.75, "ownerWrong": 0 },
        "tags": { "precision": 0.6667, "recall": 0.5 },
        "speakers": { "correct": 2, "wrong": 0, "missing": 1 }
      },
      "hardFails": []
    }
  ]
}
```

- `commit`, `asrHash`, `asrModel`, `models` and `gold.versions` say what the
  run measured. A compare across another ASR hash or gold version is still
  possible, but read its deltas with that in mind.
- `stages.<stage>.<metric>` is a number or null. `scripts/meeting-v2/eval/score.mts`
  (`stageMetrics`) defines the metrics; `baseline.mts` defines the direction
  (lower or higher is better) and the default noise band.
- `noise` is optional. Without it, the band is 0.005 for a rate and 0 for a
  count. `--noise-from` sets each band to the largest difference between two
  runs of the same setup.
- `hardFails` lists ids only: `run:failed`, `check:<name>`, `claim:<gold id>`,
  `speaker:<diarized label>`. A gold id matches `[A-Za-z0-9_.-]{1,40}`.

## Compare rules

- A metric is **worse** when it moves the wrong way by more than its noise
  band, or when it is in the baseline and missing now.
- A **new hard fail** is a hard-fail id that the baseline run of the same
  model and meeting did not have.
- Any worse metric or new hard fail gives exit code 3. Pairs of model and
  meeting that are in one side only are listed as "not compared".

The JSON files here are machine-written. Biome skips them (`biome.json`).
