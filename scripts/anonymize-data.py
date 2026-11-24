"""Make a shareable copy of the collected DB with personal details removed.

Keeps what the pattern engine reads (action, occurred_at, metadata.app) and
replaces personal text with an activity category:
  - category        <- derived from app / domain / title (config/categories.json),
                       unless the event already has one (the collector assigns
                       it when recording, and the guardian later removes old
                       titles, so recomputing would lose information)
  - subcategory     <- e.g. shortform, video, game (when a rule sets one)
  - title           -> removed
  - url             -> domain only (a bare domain is kept as is)
  - path            -> removed (ext is kept)

Usage: python scripts/anonymize-data.py [src] [dst]
"""
import json
import os
import re
import shutil
import sqlite3
import sys
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = sys.argv[1] if len(sys.argv) > 1 else "data/pattern-bridge.sqlite"
dst = sys.argv[2] if len(sys.argv) > 2 else "dataset/pattern-bridge-anon.sqlite"

with open(os.path.join(ROOT, "config", "categories.json"), encoding="utf-8") as f:
    rule_file = json.load(f)
FIELDS = ("app", "domain", "title")
RULES = [
    {**r, **{k: re.compile(r[k], re.IGNORECASE) for k in FIELDS if k in r}}
    for r in rule_file["rules"]
]
FALLBACK = rule_file.get("fallback", "other")

# Only these actions describe what the user is doing on screen.
CATEGORIZED_ACTIONS = {"window_focus", "browser_url", "browser_visit", "browser_tab"}


def host_of(url):
    url = str(url)
    if "://" not in url:
        return url  # already a bare domain (e.g. after the guardian's retention cleanup)
    return urlparse(url).hostname or ""


def categorize(app, domain, title):
    values = {"app": app or "", "domain": domain or "", "title": title or ""}
    for rule in RULES:
        if any(k in rule and values[k] and rule[k].search(values[k]) for k in FIELDS):
            return rule["category"], rule.get("subcategory")
    return FALLBACK, None


os.makedirs(os.path.dirname(dst), exist_ok=True)
if os.path.exists(dst):
    os.remove(dst)
shutil.copyfile(src, dst)

db = sqlite3.connect(dst)
rows = db.execute("SELECT id, action, metadata FROM user_events").fetchall()
updates = []
for row_id, action, raw in rows:
    try:
        meta = json.loads(raw)
    except (TypeError, ValueError):
        meta = {}
    title = meta.pop("title", None)
    meta.pop("path", None)
    if "url" in meta:
        meta["url"] = host_of(meta["url"])
    if action in CATEGORIZED_ACTIONS and "category" not in meta:
        category, sub = categorize(meta.get("app"), meta.get("url"), title)
        meta["category"] = category
        if sub:
            meta["subcategory"] = sub
    updates.append((json.dumps(meta, ensure_ascii=False), row_id))

db.executemany("UPDATE user_events SET metadata = ? WHERE id = ?", updates)
db.commit()
db.execute("VACUUM")
db.close()
print(f"anonymized {len(updates)} events -> {dst}")
