"""Speaker-attributed (saa) whole-file output: tag counts per channel against the app diarizer. Numbers only.
Run: python3 -I saa_stats.py <whole_dir> <cell2_keys_file> <id8,...>
The app reference is the number of distinct speaker labels per channel in the lab DB (Qwen cell).
"""
import collections, glob, os, re, sqlite3, sys
d, kf, ids = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
keys = dict(l.split() for l in open(kf))
C = os.path.expanduser("~/.openstyle-eval/lab/asr/cache")
tot = collections.Counter()
for i8 in ids:
    row = [i8]
    for ch in ("mic", "system"):
        t = open(f"{d}/{i8}.saa.{ch}.txt", encoding="utf-8").read()
        tags = re.findall(r"<spk:(\d+)>", t)
        turns = sum(1 for a, b in zip(tags, tags[1:] + [None]) if a != b)
        db = sqlite3.connect(f"file:{glob.glob(f'{C}/{i8}*.{keys[i8]}.db')[0]}?immutable=1", uri=True)
        app = db.execute("select count(distinct speaker_label), count(*) from meeting_segments where meeting_id like ? and source=? and speaker_label is not null", (i8 + "%", ch)).fetchone()
        row += [f"{ch}: saa_tags={len(tags)} saa_speakers={len(set(tags))} saa_turns={turns} app_speakers={app[0]} app_labeled_segs={app[1]} words={len(re.sub(r'<[^>]*>',' ',t).split())}"]
        tot["saa_tags"] += len(tags)
    print(" | ".join(row))
