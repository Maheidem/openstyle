"""True (exit 0) when our line is the first live line of the GPU queue.

Usage: python3 -I queue-turn.py <queue file> <our line>
Same rule as scripts/meeting-v2/eval/gpu-queue.mts: a line older than 2 h is skipped
(never deleted). A line with no time counts as live.
"""
import re
import sys
import time
from datetime import datetime, timedelta

STALE_S = 2 * 3600
queue, ours = sys.argv[1], sys.argv[2]
now = time.time()


def line_time(line):
    m = re.search(r"\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?", line)
    if m:
        try:
            s = m.group(0)
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            d = datetime.fromisoformat(s)
            return d.timestamp()
        except ValueError:
            pass
    m = re.search(r"(?:^|\s)(\d{1,2}):(\d\d)(?::(\d\d))?(?=\s|$)", line)
    if not m:
        return None
    d = datetime.now().replace(hour=int(m[1]), minute=int(m[2]), second=int(m[3] or 0), microsecond=0)
    t = d.timestamp()
    return t - 86400 if t > now + 300 else t


try:
    lines = open(queue).read().split("\n")
except FileNotFoundError:
    lines = []
for raw in lines:
    line = raw.strip()
    if not line:
        continue
    if line == ours:
        sys.exit(0)
    t = line_time(line)
    if t is None or now - t <= STALE_S:
        sys.exit(1)
sys.exit(1)
