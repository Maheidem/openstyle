"""Sample the RSS of the MLX workers that the app started. Stops when the app exits.

Usage: python3 -I sample-rss.py <app.pid file> <out.csv>
Kinds: llm (--llm), embed (--embed), asr (the rest).
"""
import os
import subprocess
import sys
import time

pid_file, out = sys.argv[1], sys.argv[2]
while not os.path.exists(pid_file):
    time.sleep(1)
time.sleep(1)
app = int(open(pid_file).read())
with open(out, "w") as f:
    f.write("ts,pid,rss_kb,kind\n")
while True:
    ps = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,rss=,args="], capture_output=True, text=True
    ).stdout.splitlines()
    rows = {}
    for line in ps:
        p = line.split(None, 3)
        if len(p) < 4:
            continue
        rows[int(p[0])] = (int(p[1]), int(p[2]), p[3])

    def is_child_of_app(pid):
        cur = pid
        for _ in range(12):
            if cur == app:
                return True
            if cur not in rows:
                return False
            cur = rows[cur][0]
        return False

    with open(out, "a") as f:
        for pid, (_, rss, args) in rows.items():
            if "mlx_asr_worker" in args and is_child_of_app(pid):
                kind = "llm" if " --llm" in args else ("embed" if " --embed" in args else "asr")
                f.write(f"{int(time.time())},{pid},{rss},{kind}\n")
    if app not in rows:
        break
    time.sleep(5)
