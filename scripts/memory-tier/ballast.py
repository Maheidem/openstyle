#!/usr/bin/env python3
"""RAM ballast for scripts/memory-tier-test.sh.

Holds GIB gibibytes of anonymous memory. It writes random data to every page
(zero pages would compress to nothing), then writes one byte to every page
again each INTERVAL seconds. The pages stay "active", so the kernel takes
memory from other processes first. mlock alone does not wire the pages on
macOS (measured 2026-10-30), so the re-touch is the method.

Safe stop: SIGTERM or SIGINT, a parent that has died, or --max-seconds.
Progress goes to stdout. The line "READY <gib>" means all pages are filled.
"""

import argparse
import mmap
import os
import signal
import sys
import time

PAGE = 16384  # Apple silicon page size
CHUNK = 1 << 30  # one mmap per GiB


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gib", type=float, required=True)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--max-seconds", type=float, default=4 * 3600)
    args = ap.parse_args()

    stop = False

    def handler(_sig, _frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)

    parent = os.getppid()
    total = int(args.gib * (1 << 30)) // PAGE * PAGE
    # One random block, copied into every chunk. The kernel compresses per
    # page and does not de-duplicate, so one random block is enough.
    block = os.urandom(64 << 20)
    chunks = []
    done = 0
    while done < total and not stop:
        size = min(CHUNK, total - done)
        mm = mmap.mmap(-1, size)
        for off in range(0, size, len(block)):
            n = min(len(block), size - off)
            mm[off : off + n] = block[:n]
        chunks.append(mm)
        done += size
        print(f"FILL {done / (1 << 30):.1f}/{total / (1 << 30):.1f} GiB", flush=True)
    if not stop:
        print(f"READY {done / (1 << 30):.1f}", flush=True)

    started = time.monotonic()
    token = bytes([1]) * (CHUNK // PAGE)
    while not stop:
        if os.getppid() != parent or time.monotonic() - started > args.max_seconds:
            break
        for mm in chunks:
            # Extended slice: one byte in each page, looped in C.
            count = len(range(0, len(mm), PAGE))
            mm[0 : len(mm) : PAGE] = token[:count]
        time.sleep(args.interval)
    for mm in chunks:
        mm.close()
    print("STOPPED", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
