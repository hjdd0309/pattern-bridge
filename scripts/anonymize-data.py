"""Make a shareable copy of the collected DB with personal details removed.

Keeps what the pattern engine reads (action, occurred_at, metadata.app) and
drops window titles, full URLs and file paths:
  - title           -> removed
  - url             -> domain only
  - path            -> removed (ext is kept)

Usage: python scripts/anonymize-data.py [src] [dst]
"""
import json
import os
import shutil
import sqlite3
import sys
from urllib.parse import urlparse

src = sys.argv[1] if len(sys.argv) > 1 else "data/pattern-bridge.sqlite"
dst = sys.argv[2] if len(sys.argv) > 2 else "dataset/pattern-bridge-anon.sqlite"

os.makedirs(os.path.dirname(dst), exist_ok=True)
if os.path.exists(dst):
    os.remove(dst)
shutil.copyfile(src, dst)

db = sqlite3.connect(dst)
rows = db.execute("SELECT id, metadata FROM user_events").fetchall()
updates = []
for row_id, raw in rows:
    try:
        meta = json.loads(raw)
    except (TypeError, ValueError):
        meta = {}
    meta.pop("title", None)
    meta.pop("path", None)
    if "url" in meta:
        meta["url"] = urlparse(str(meta["url"])).hostname or ""
    updates.append((json.dumps(meta, ensure_ascii=False), row_id))

db.executemany("UPDATE user_events SET metadata = ? WHERE id = ?", updates)
db.commit()
db.execute("VACUUM")
db.close()
print(f"anonymized {len(updates)} events -> {dst}")
