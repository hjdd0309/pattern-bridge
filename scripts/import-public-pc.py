"""Convert public PC/laptop datasets into the Pattern Bridge schema.

Each dataset becomes a SQLite DB with the same tables as data/pattern-bridge.sqlite.
Timestamps are shifted by whole weeks so the newest event lands just before
now, which keeps hour-of-day and weekday intact for the pattern engine.
Activity categories come from config/categories.json (same rules as
scripts/anonymize-data.py).

Usage:
  python scripts/import-public-pc.py awt    <awt_data_1_pseudonymized.csv> <out.sqlite>
  python scripts/import-public-pc.py swell  <features_sheet1.csv>          <out.sqlite>
  python scripts/import-public-pc.py gesis  <web_tracking dir or file>      <out.sqlite>
"""
import csv
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KST = timezone(timedelta(hours=9))
WEEK_MS = 7 * 24 * 3600 * 1000

with open(os.path.join(ROOT, "config", "categories.json"), encoding="utf-8") as f:
    _rules = json.load(f)
FIELDS = ("app", "domain", "title")
RULES = [{**r, **{k: re.compile(r[k], re.IGNORECASE) for k in FIELDS if k in r}} for r in _rules["rules"]]
FALLBACK = _rules.get("fallback", "other")


def categorize(app=None, domain=None, title=None):
    values = {"app": app or "", "domain": domain or "", "title": title or ""}
    for rule in RULES:
        if any(k in rule and values[k] and rule[k].search(values[k]) for k in FIELDS):
            return rule["category"], rule.get("subcategory")
    return FALLBACK, None


SCHEMA = """
CREATE TABLE user_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  metadata    TEXT    NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL
);
CREATE TABLE detected_patterns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  pattern_type TEXT    NOT NULL,
  score        REAL    NOT NULL,
  payload      TEXT    NOT NULL DEFAULT '{}',
  detected_at  INTEGER NOT NULL,
  notified     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE notification_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id           INTEGER NOT NULL REFERENCES detected_patterns(id),
  triggered_at         INTEGER NOT NULL,
  predicted_time       INTEGER NOT NULL,
  actual_delay_minutes INTEGER NOT NULL,
  confidence_score     REAL    NOT NULL,
  algorithm_scores     TEXT    NOT NULL DEFAULT '{}',
  user_feedback        TEXT,
  feedback_at          INTEGER
);
CREATE INDEX idx_user_events_user_time ON user_events (user_id, occurred_at);
CREATE INDEX idx_patterns_notified ON detected_patterns (notified, detected_at);
CREATE INDEX idx_notification_log_pattern ON notification_log (pattern_id);
CREATE INDEX idx_notification_log_feedback ON notification_log (user_feedback);
"""


def local_ms(dt):
    """Treat a naive local time as KST so hour-of-day reads the same here."""
    return int(dt.replace(tzinfo=KST).timestamp() * 1000)


def write_db(out, rows):
    """rows: iterable of (user_id, action, metadata dict, occurred_at ms)."""
    rows = list(rows)
    if not rows:
        sys.exit("no rows parsed")
    newest = max(r[3] for r in rows)
    now = int(time.time() * 1000)
    shift = ((now - newest) // WEEK_MS) * WEEK_MS
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    if os.path.exists(out):
        os.remove(out)
    db = sqlite3.connect(out)
    db.executescript(SCHEMA)
    db.executemany(
        "INSERT INTO user_events (user_id, action, metadata, occurred_at) VALUES (?, ?, ?, ?)",
        ((u, a, json.dumps(m, ensure_ascii=False), t + shift) for u, a, m, t in sorted(rows, key=lambda r: r[3])),
    )
    db.commit()
    db.execute("VACUUM")
    db.close()
    print(f"{len(rows)} events -> {out} (shifted {shift // WEEK_MS} weeks)")


def with_category(meta, **kw):
    cat, sub = categorize(**kw)
    meta["category"] = cat
    if sub:
        meta["subcategory"] = sub
    return meta


# ── AWT: one academic's labelled active-window log (Beerepoot 2024) ──────────
def import_awt(src):
    with open(src, encoding="utf-8-sig", errors="replace") as f:
        for r in csv.DictReader(f, delimiter=";"):
            begin = datetime.strptime(r["Begin"], "%d-%m-%Y %H:%M")
            end = datetime.strptime(r["End"], "%d-%m-%Y %H:%M")
            meta = with_category(
                {"app": r["App"], "title": r["Title"], "platform": "windows", "source": "awt",
                 "label": r["Activity"], "case": r["Case"],
                 "durationSec": int((end - begin).total_seconds())},
                app=r["App"], title=r["Title"],
            )
            yield ("awt-user0", "window_focus", meta, local_ms(begin))


# ── SWELL-KW: per-minute keyboard/mouse features under work conditions ────────
SWELL_CONDITIONS = {"R": "relax", "N": "neutral", "I": "interruption", "T": "time_pressure"}


def import_swell(src):
    with open(src, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if not r.get("PP"):
                continue
            ts = datetime.strptime(r["timestamp"][:15], "%Y%m%dT%H%M%S")
            meta = {
                "count": int(float(r["SnKeyStrokes"] or 0)),
                "windowMs": 60_000,
                "mouseActions": int(float(r["SnMouseAct"] or 0)),
                "appChanges": int(float(r["SnAppChange"] or 0)),
                "tabChanges": int(float(r["SnTabfocusChange"] or 0)),
                "errorKeys": int(float(r["SnErrorKeys"] or 0)),
                "condition": SWELL_CONDITIONS.get(r["Condition"], r["Condition"]),
                "source": "swell",
            }
            yield (f"swell-{r['PP'].lower()}", "keyboard_activity", meta, local_ms(ts))


# ── GESIS web tracking: 2,148 German users, one month of browsing ────────────
# Domain categories from the dataset (41 kinds) mapped onto ours, in priority order.
GESIS_MAP = [
    ("streamingmedia", "entertainment", "video"), ("mediasharing", "entertainment", "video"),
    ("games", "entertainment", "game"), ("gambling", "entertainment", "gambling"),
    ("adult", "entertainment", "adult"), ("humor", "entertainment", "community"),
    ("messageboardsandforums", "entertainment", "community"),
    ("socialnetworking", "sns", None), ("datingandpersonals", "sns", None), ("personals", "sns", None),
    ("blogsandpersonal", "sns", None),
    ("chatandmessaging", "communication", None), ("email", "communication", None),
    ("education", "study", None), ("translation", "study", None), ("translators", "study", None),
    ("productivity", "work", None), ("business", "work", None), ("informationtech", "work", None),
    ("jobrelated", "work", None),
    ("shopping", "shopping", None), ("realestate", "shopping", None), ("travel", "shopping", None),
    ("economyandfinance", "finance", None),
    ("sport", "leisure", "sports"), ("sports", "leisure", "sports"),
    ("food", "leisure", None), ("foodandrecipes", "leisure", None), ("foodfoodandrecipes", "leisure", None),
    ("newsandmedia", "search", "news"), ("searchenginesandportals", "search", None),
]


def gesis_category(domain, raw_cats):
    cat, sub = categorize(domain=domain)
    if cat != FALLBACK:
        return cat, sub
    for key, c, s in GESIS_MAP:
        if key in raw_cats:
            return c, s
    return FALLBACK, None


def import_gesis(src):
    """src: the extracted web_routineness_release/ folder, or dataset/public/gesis/
    (which holds browsing-compact.csv.gz, users.csv, domain_categories.csv).

    Env GESIS_USERS limits the output to that many users (seeded sample), so
    the DB stays under GitHub's file size limit."""
    import gzip
    import random
    raw_dir = os.path.join(src, "raw")
    if not os.path.isdir(raw_dir):
        raw_dir = src
    with open(os.path.join(raw_dir, "domain_categories.csv"), encoding="utf-8") as f:
        dom_cats = {r["domain"]: set((r["category"] or "").split(",")) for r in csv.DictReader(f)}
    keep = None
    if os.environ.get("GESIS_USERS"):
        with open(os.path.join(raw_dir, "users.csv"), encoding="utf-8") as f:
            ids = sorted(r["panelist_id"] for r in csv.DictReader(f))
        keep = set(random.Random(42).sample(ids, int(os.environ["GESIS_USERS"])))
    cache = {}
    full = os.path.join(raw_dir, "browsing.csv")
    opener = (lambda: open(full, encoding="utf-8")) if os.path.exists(full) else \
        (lambda: gzip.open(os.path.join(raw_dir, "browsing-compact.csv.gz"), "rt", encoding="utf-8"))
    with opener() as f:
        for r in csv.DictReader(f):
            pid = r["panelist_id"]
            if keep is not None and pid not in keep:
                continue
            dom = r["domain"]
            if dom not in cache:
                cache[dom] = gesis_category(dom, dom_cats.get(dom, set()))
            cat, sub = cache[dom]
            meta = {"url": dom, "activeSec": int(float(r["active_seconds"] or 0)),
                    "platform": "web", "source": "gesis", "category": cat}
            if sub:
                meta["subcategory"] = sub
            ts = datetime.strptime(r["used_at"], "%Y-%m-%d %H:%M:%S")
            yield (f"gesis-{pid}", "browser_url", meta, local_ms(ts))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    kind, src, out = sys.argv[1:]
    importer = {"awt": import_awt, "swell": import_swell, "gesis": import_gesis}[kind]
    write_db(out, importer(src))
