---
name: memory-tier-test
description: Test if live transcript and chat fit a small Mac (8, 16, 24 GB) from this big Mac. Ballast process, GPU cap sysctl, isolated app, footprint sampling, pass/fail summary. Use before any claim that a feature "runs on a 16 GB Mac", and to repeat the no-cap baseline.
---

# Memory-tier test

Goal: find out if the app stays inside the memory budget of a small Mac. This Mac has 128 GB, so the test takes memory away from the app.

Command: `scripts/memory-tier-test.sh`. Load: `apps/electron/tests/memory-tier.test.ts` (skips without `OPENSTYLE_MEMTIER_OUT`). Ballast: `scripts/memory-tier/ballast.py`.

## Rules for the tiers (owner decision 2026-10-30)

- OS reserve is 2.5 GB. App budget = tier - 2.5 GB. Tiers 8, 16, 24 GB give budgets 5.5, 13.5, 21.5 GB.
- GPU cap per tier = `iogpu.wired_limit_mb` = 84 % of tier RAM (measured: 107.5 of 128 GiB). The ratio is the parameter `--gpu-pct`. Caps: 8 GB = 6881, 16 GB = 13762, 24 GB = 20643 MB.
- This is an optimistic floor. 2.5 GB is an assumption for an idle OS. The repo fit table uses 3 and 4 GiB.

## Facts (measured 2026-10-30, `research/memory-tier-testing.md` in the eval folder)

- `mx.set_memory_limit` does not cap. `RLIMIT_AS` is not enforced on macOS. Do not use them.
- `ps` RSS does not count GPU memory. `footprint` does (IOAccelerator). The script uses `footprint` on the whole process tree (Electron, server, MLX workers).
- `mlock` does not wire the ballast. The ballast writes random data to every page and writes one byte to every page each second, so the pages stay active.
- Wired memory cannot be swapped. If other apps already use a lot of wired memory, a big ballast cannot push it out. The script lowers the ballast by the extra OS use (`--os-used-gib auto`). Close other apps and VMs before a real tier run.
- MLX reads its GPU cap from the sysctl at process start. The script sets nothing itself unless `--sudo` works.

## Commands

Baseline, no cap, no ballast (no sudo). Run it once, keep `summary.json`:

```bash
scripts/memory-tier-test.sh --no-ballast --minutes 30
```

One tier. The script checks the GPU cap first. If the cap is wrong, it prints the two sudo commands and exits with code 3:

```bash
scripts/memory-tier-test.sh --tier 16 --minutes 30 --baseline <baseline-results>/summary.json
```

Owner steps for each tier (the script prints the exact numbers for this Mac):

1. `sudo sysctl iogpu.wired_limit_mb=<cap>` (set).
2. Run the tier command above.
3. `sudo sysctl iogpu.wired_limit_mb=<boot value>` (restore).

The boot value comes from the LaunchDaemon that sets the cap at boot. The script reads it at run time (`plutil -p /Library/LaunchDaemons/*iogpu*wired*.plist`) and prints it. `sudo sysctl iogpu.wired_limit_mb=0` gives the system default when no daemon exists.

Scripted mode for the future eval: `--sudo` sets and restores the cap with `sudo -n`. It works only when `sudo -n true` works. Otherwise the script prints the commands and stops.

`--allow-gpu-mismatch` runs without the right cap (ballast and sampling only). The summary then says "INVALID TIER RESULT". Use it only to check the tooling.

## What the script does

1. Computes the GPU cap and the budget. Checks `iogpu.wired_limit_mb`.
2. Takes the shared GPU lock (`/tmp/openstyle-gpu.lock`) and honors the queue.
3. Builds an isolated scratch folder (`scripts/isolated-env.sh`), clones the models from the Hugging Face cache (read only), makes a long fictional audio file with `say -o`.
4. Starts the ballast. Size = RAM - tier - max(0, os_used - 2.5). Waits for `READY`.
5. Samples every 5 s: `footprint` of the app tree (`samples.csv`, `procs.csv`), swap, `vm_stat` swapouts/pageouts, pressure level, free level.
6. Runs the app through the Test Runner (quiet mode): live chat on, fake mic audio, `GET /live` every second, a chat question every 2 min.
7. Writes `summary.json` and `summary.txt`. Exit code 0 pass, 1 fail.

## Pass and fail

| Check | Pass when |
|---|---|
| Peak footprint | Peak of the whole tree is at most the budget |
| Swapouts | Delta during the run is below `--swapout-max` (default 50000 pages, about 0.8 GB) |
| Pressure | `kern.memorystatus_vm_pressure_level` never reaches 4 (critical). Level 2 counts are listed |
| No OOM or kill | Test exit 0, no OOM or worker-exit line in the app logs, no memorystatus kill line in the kernel log |
| Latency | Live partial p95, live final p95 and chat p50 are at most 1.5 x the baseline |

Read the result:

- `summary.txt` has the verdict, each check and the peak footprint for each process group.
- `latency.csv` has the lag of each live line behind the audio (partial and final). The first 120 s are warm-up and are not in the percentiles.
- `chat.csv` has the wall time of each chat call. The first call loads the model.
- The ballast footprint (`ballast_fp_mb` in `samples.csv`) must stay near its size. If it drops, the kernel took ballast pages and the squeeze is weaker than planned.
- Open points: the pressure level values (1, 2, 4) and the kernel predicate are from the xnu headers, not confirmed on this Mac. Compare one tier with a real Mac of that size when you can.

## Cleanup

The script removes its scratch folder, stops the ballast, releases the lock and restores the cap when it set it (`--sudo`). The results folder stays. If someone kills the script by force, stop the ballast with `kill <pid>` (find it with `pgrep -f memory-tier/ballast.py`), release the lock only if the script took it, and restore the cap with the printed command.
