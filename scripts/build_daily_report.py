#!/usr/bin/env python3
"""Build docs/data/daily-report.json — the "日報" tab's data file.

Design notes live in ~/Abraham/daily-report-PLAN.md. The parts that matter here,
each of which exists because an adversarial review found the naive version broken:

  * The record store is SQLite (stdlib), one row per record id, PRIMARY KEY upsert.
    Re-running a shift replaces it in place; it never duplicates.
  * The published JSON is a DERIVED artifact. It is always rebuilt from the store and
    written temp -> atomic replace. The store itself is never trimmed, so a day rolling
    off the page is not a delete.
  * Publishing is a DRAIN LOOP against a monotonic revision, not a single pass. Checking
    "has the DB moved?" once before writing is a time-of-check/time-of-use race; looping
    until published_revision == revision makes correctness not depend on winning it.
  * The builder NEVER parses prose. Sentiment, tickers and notify_reason are authored
    explicitly (discriminated union, validated below) because they cannot be recovered
    from free text. A missing required field fails loudly and publishes nothing.
  * Day bucketing is Asia/Taipei, always. UTC bucketing files the overnight US session
    under the wrong day.
  * The builder does NOT decide what "today" is, and does NOT decide what is overdue.
    It publishes the schedule and per-shift health; the browser computes both against
    its own clock. Anything time-derived must be computed by something that is actually
    running, and this script only runs when there is something to write.

Usage:
    python build_daily_report.py --add record.json     # validate + store + publish
    python build_daily_report.py --publish             # drain/rebuild only
    python build_daily_report.py --selftest            # acceptance tests, uses temp dirs
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

TAIPEI = timezone(timedelta(hours=8))
DAYS_KEPT = 7
SCHEMA = 1

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DB = Path.home() / "Abraham" / ".daily-report.db"
DEFAULT_OUT = REPO / "docs" / "data" / "daily-report.json"

# The shifts the page expects. grace_min is how late a shift may be before the page
# calls it failed rather than pending.
SCHEDULE = {
    "timezone": "Asia/Taipei",
    "shifts": [
        {"id": "morning", "name": "早班", "due": "06:10", "grace_min": 120, "days": "mon-sun"},
        {"id": "midday",  "name": "午班", "due": "14:10", "grace_min": 120, "days": "mon-sun"},
        {"id": "evening", "name": "晚班", "due": "21:00", "grace_min": 120, "days": "mon-sun"},
    ],
    "skip_dates": [],
}
SHIFT_IDS = [s["id"] for s in SCHEDULE["shifts"]]

VALID_SENTIMENT = {"positive", "negative", "neutral"}
VALID_NOTIFY = {"watchlist_event", "new_opportunity", "none"}
VALID_OUTCOME = {"complete", "no-output", "failed"}


class ValidationError(ValueError):
    """Raised when a record is malformed. The builder publishes nothing on this."""


# ---------------------------------------------------------------- validation


def _require(cond, msg):
    if not cond:
        raise ValidationError(msg)


def _parse_dt(value, field):
    _require(isinstance(value, str) and value, f"{field} missing")
    try:
        dt = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValidationError(f"{field} is not ISO-8601: {value!r} ({exc})") from exc
    # An offset-naive timestamp is the exact bug that files overnight items on the wrong
    # day, so it is rejected rather than assumed to be local.
    _require(dt.tzinfo is not None, f"{field} must carry a UTC offset: {value!r}")
    return dt


def _validate_item(item, where):
    _require(isinstance(item, dict), f"{where}: item must be an object")
    for f in ("t", "body"):
        _require(isinstance(item.get(f), str) and item[f].strip(), f"{where}: item.{f} missing")
    _require(item.get("s") in VALID_SENTIMENT, f"{where}: item.s must be one of {sorted(VALID_SENTIMENT)}")
    _require(
        item.get("notify_reason") in VALID_NOTIFY,
        f"{where}: item.notify_reason must be one of {sorted(VALID_NOTIFY)} "
        f"(authored, never inferred from sentiment)",
    )
    tickers = item.get("tickers")
    _require(isinstance(tickers, list), f"{where}: item.tickers must be a list (may be empty, never absent)")
    _require(all(isinstance(t, str) for t in tickers), f"{where}: item.tickers must be strings")


def validate(rec):
    """Validate one authored record. Raises ValidationError; never guesses a default."""
    _require(isinstance(rec, dict), "record must be an object")
    _require(rec.get("schema") == SCHEMA, f"unknown schema {rec.get('schema')!r}; expected {SCHEMA}")
    kind = rec.get("kind")
    _require(kind in ("shift", "event"), "kind must be 'shift' or 'event'")
    _require(isinstance(rec.get("id"), str) and rec["id"].strip(), "id missing")
    occurred = _parse_dt(rec.get("occurred_at"), "occurred_at")

    if kind == "shift":
        _require(rec.get("shift") in SHIFT_IDS, f"shift must be one of {SHIFT_IDS}")
        outcome = rec.get("outcome")
        _require(outcome in VALID_OUTCOME, f"outcome must be one of {sorted(VALID_OUTCOME)}")
        if outcome == "failed":
            _require(isinstance(rec.get("error"), str) and rec["error"].strip(),
                     "outcome=failed requires a non-empty error")
        if outcome == "complete":
            _require(isinstance(rec.get("summary"), str) and rec["summary"].strip(),
                     "outcome=complete requires a non-empty summary")
        items = rec.get("items", [])
        _require(isinstance(items, list), "items must be a list")
        for i, item in enumerate(items):
            _validate_item(item, f"items[{i}]")
        highlights = rec.get("highlights", [])
        _require(isinstance(highlights, list) and all(isinstance(h, str) for h in highlights),
                 "highlights must be a list of strings")
    else:
        _validate_item(rec, "event")

    return occurred.astimezone(TAIPEI)


# ---------------------------------------------------------------- store


def connect(db_path):
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), isolation_level=None, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS records (
            id           TEXT PRIMARY KEY,
            kind         TEXT NOT NULL,
            shift        TEXT,
            occurred_at  TEXT NOT NULL,
            taipei_date  TEXT NOT NULL,
            payload      TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_records_date ON records(taipei_date);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        -- Phase 2 (notifications). Created now so the schema does not change later.
        CREATE TABLE IF NOT EXISTS outbox (
            record_id  TEXT NOT NULL,
            category   TEXT NOT NULL,
            state      TEXT NOT NULL,
            attempts   INTEGER NOT NULL DEFAULT 0,
            next_try_at TEXT,
            created_at TEXT NOT NULL,
            sent_at    TEXT,
            note       TEXT,
            PRIMARY KEY (record_id, category)
        );
        """
    )
    return conn


def _meta_int(conn, key, default=0):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return int(row[0]) if row else default


def _meta_set(conn, key, value):
    conn.execute(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def add_record(conn, rec):
    """Validate then upsert. Bumps revision inside the same transaction as the write."""
    occurred_tpe = validate(rec)
    now = datetime.now(timezone.utc).astimezone(TAIPEI).isoformat(timespec="seconds")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            """INSERT INTO records(id,kind,shift,occurred_at,taipei_date,payload,updated_at)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 kind=excluded.kind, shift=excluded.shift, occurred_at=excluded.occurred_at,
                 taipei_date=excluded.taipei_date, payload=excluded.payload,
                 updated_at=excluded.updated_at""",
            (
                rec["id"], rec["kind"], rec.get("shift"),
                occurred_tpe.isoformat(timespec="seconds"),
                occurred_tpe.date().isoformat(),
                json.dumps(rec, ensure_ascii=False), now,
            ),
        )
        _meta_set(conn, "revision", _meta_int(conn, "revision") + 1)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return occurred_tpe


# ---------------------------------------------------------------- build


def _health(conn):
    """Per-shift last attempt / last delivery / last error.

    'complete' and 'no-output' both count as a DELIVERY: a shift that ran and found
    nothing is a success, not a fault. An error is reported by the page only when it is
    not superseded by a later delivery, so recovery clears the warning by itself and
    there is no separate "clear the error" step that could be forgotten.
    """
    health = {}
    for sid in SHIFT_IDS:
        rows = conn.execute(
            "SELECT occurred_at, payload FROM records WHERE kind='shift' AND shift=? ORDER BY occurred_at",
            (sid,),
        ).fetchall()
        entry = {"last_attempt_at": None, "last_attempt_outcome": None,
                 "last_delivery_at": None, "last_error": None}
        for occurred_at, payload in rows:
            rec = json.loads(payload)
            outcome = rec.get("outcome")
            entry["last_attempt_at"] = occurred_at
            entry["last_attempt_outcome"] = outcome
            if outcome in ("complete", "no-output"):
                entry["last_delivery_at"] = occurred_at
                entry["last_error"] = None          # superseded by a later success
            elif outcome == "failed":
                entry["last_error"] = {"at": occurred_at, "message": rec.get("error", "")}
        health[sid] = entry
    return health


def build_payload(conn, now_tpe=None):
    now_tpe = now_tpe or datetime.now(timezone.utc).astimezone(TAIPEI)
    today = now_tpe.date()
    wanted = [(today - timedelta(days=i)).isoformat() for i in range(DAYS_KEPT)]

    rows = conn.execute(
        "SELECT taipei_date, kind, payload, occurred_at FROM records "
        "WHERE taipei_date >= ? ORDER BY occurred_at",
        (wanted[-1],),
    ).fetchall()

    by_day = {d: {"shifts": {}, "events": [], "top": []} for d in wanted}
    for tdate, kind, payload, occurred_at in rows:
        if tdate not in by_day:
            continue
        rec = json.loads(payload)
        if kind == "shift":
            by_day[tdate]["shifts"][rec["shift"]] = {
                "id": rec["id"],
                "shift": rec["shift"],
                "outcome": rec.get("outcome"),
                "delivered_at": occurred_at,
                "summary": rec.get("summary", ""),
                "error": rec.get("error"),
                "items": rec.get("items", []),
            }
            by_day[tdate]["top"].extend(rec.get("highlights", []))
        else:
            ev = {k: rec.get(k) for k in ("id", "t", "s", "tickers", "body", "src", "notify_reason")}
            ev["occurred_at"] = occurred_at
            by_day[tdate]["events"].append(ev)

    days = []
    for d in wanted:
        blob = by_day[d]
        shifts = [blob["shifts"][sid] for sid in SHIFT_IDS if sid in blob["shifts"]]
        days.append({
            "date": d,
            "top": blob["top"],
            "shifts": shifts,
            "events": sorted(blob["events"], key=lambda e: e["occurred_at"]),
        })

    return {
        "schema": SCHEMA,
        "_updated": now_tpe.isoformat(timespec="seconds"),
        "revision": _meta_int(conn, "revision"),
        "schedule": SCHEDULE,
        "health": _health(conn),
        # NOTE: days[] is what the builder knew at build time. The page derives its own
        # 7 Taipei dates from its own clock and overlays this, so the window still rolls
        # over at midnight when nothing has run overnight.
        "days": days,
    }


def _atomic_write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def publish(conn, out_path=DEFAULT_OUT, now_tpe=None, max_passes=10):
    """Drain loop: rebuild until the published revision matches the store's revision.

    A single build-then-check pass is a TOCTOU race — a write can land between the check
    and the replace. Looping means a late write costs one extra pass instead of being
    silently left unpublished until the next authoring event.
    """
    passes = 0
    while passes < max_passes:
        passes += 1
        rev_before = _meta_int(conn, "revision")
        payload = build_payload(conn, now_tpe=now_tpe)
        _atomic_write(out_path, json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        rev_after = _meta_int(conn, "revision")
        if rev_after == rev_before:
            _meta_set(conn, "published_revision", rev_after)
            return {"revision": rev_after, "passes": passes, "path": str(out_path)}
    raise RuntimeError(f"publish did not converge after {max_passes} passes — store is changing faster than it builds")


# ---------------------------------------------------------------- selftest


def _selftest():
    import shutil
    tmp = Path(tempfile.mkdtemp(prefix="drtest-"))
    failures = []

    def check(name, cond, detail=""):
        print(("  PASS  " if cond else "  FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    try:
        db = tmp / "t.db"
        out = tmp / "out.json"
        conn = connect(db)
        now = datetime(2026, 8, 17, 16, 0, tzinfo=TAIPEI)

        def shift_rec(date, sid, outcome="complete", hhmm="06:40", **kw):
            r = {"schema": 1, "kind": "shift", "id": f"{date}.{sid}", "shift": sid,
                 "occurred_at": f"{date}T{hhmm}:00+08:00", "outcome": outcome}
            if outcome == "complete":
                r.setdefault("summary", "ok")
            if outcome == "failed":
                r.setdefault("error", "boom")
            r.update(kw)
            return r

        # T5c — a record missing a required field must be refused outright.
        bad = shift_rec("2026-08-17", "morning")
        del bad["outcome"]
        try:
            add_record(conn, bad)
            check("T5c reject record missing required field", False, "no exception raised")
        except ValidationError:
            check("T5c reject record missing required field", True)

        # Offset-naive timestamps are the wrong-day bug; must be refused.
        naive = shift_rec("2026-08-17", "morning")
        naive["occurred_at"] = "2026-08-17T06:40:00"
        try:
            add_record(conn, naive)
            check("reject offset-naive occurred_at", False, "accepted")
        except ValidationError:
            check("reject offset-naive occurred_at", True)

        # notify_reason must be authored, not defaulted from sentiment.
        noreason = shift_rec("2026-08-17", "morning",
                             items=[{"t": "x", "s": "positive", "tickers": [], "body": "b"}])
        try:
            add_record(conn, noreason)
            check("reject item without notify_reason", False, "accepted")
        except ValidationError:
            check("reject item without notify_reason", True)

        # Happy path.
        add_record(conn, shift_rec("2026-08-17", "morning", highlights=["h1"],
                                   items=[{"t": "x", "s": "positive", "tickers": ["MU"],
                                           "body": "b", "notify_reason": "watchlist_event"}]))
        res = publish(conn, out, now_tpe=now)
        data = json.loads(out.read_text(encoding="utf-8"))
        check("publishes 7 day slots", len(data["days"]) == 7, str(len(data["days"])))
        check("newest day first", data["days"][0]["date"] == "2026-08-17", data["days"][0]["date"])
        check("shift stored", len(data["days"][0]["shifts"]) == 1)
        check("highlights surface as top", data["days"][0]["top"] == ["h1"])

        # T7 — same id twice upserts in place.
        add_record(conn, shift_rec("2026-08-17", "morning", summary="revised", highlights=["h2"]))
        publish(conn, out, now_tpe=now)
        data = json.loads(out.read_text(encoding="utf-8"))
        check("T7 same id upserts, no duplicate", len(data["days"][0]["shifts"]) == 1)
        check("T7 upsert replaces content", data["days"][0]["shifts"][0]["summary"] == "revised")

        # T8 — 02:00 Taipei belongs to THAT Taipei day, not the previous UTC day.
        add_record(conn, {"schema": 1, "kind": "event", "id": "2026-08-17.evt.1",
                          "occurred_at": "2026-08-17T02:14:00+08:00", "t": "overnight",
                          "s": "negative", "tickers": [], "body": "b",
                          "notify_reason": "new_opportunity"})
        publish(conn, out, now_tpe=now)
        data = json.loads(out.read_text(encoding="utf-8"))
        d17 = next(d for d in data["days"] if d["date"] == "2026-08-17")
        check("T8 02:00 Taipei event lands on that Taipei date", len(d17["events"]) == 1)

        # T5d — a failure followed by a later delivery must clear; an unsuperseded one must stay.
        add_record(conn, shift_rec("2026-08-16", "evening", outcome="failed", hhmm="21:05"))
        publish(conn, out, now_tpe=now)
        h = json.loads(out.read_text(encoding="utf-8"))["health"]
        check("T5d unsuperseded failure is reported", h["evening"]["last_error"] is not None)
        add_record(conn, shift_rec("2026-08-17", "evening", outcome="no-output", hhmm="21:02"))
        publish(conn, out, now_tpe=now)
        h = json.loads(out.read_text(encoding="utf-8"))["health"]
        check("T5d later no-output counts as delivery and clears the error", h["evening"]["last_error"] is None)
        check("T5d no-output records a delivery time", h["evening"]["last_delivery_at"] is not None)

        # T4 — trim is not a delete: the store keeps days that have left the JSON.
        add_record(conn, shift_rec("2026-08-01", "morning"))
        publish(conn, out, now_tpe=now)
        data = json.loads(out.read_text(encoding="utf-8"))
        check("T4 old day is outside the 7-day window", all(d["date"] != "2026-08-01" for d in data["days"]))
        kept = conn.execute("SELECT COUNT(*) FROM records WHERE taipei_date='2026-08-01'").fetchone()[0]
        check("T4 store still holds the trimmed day", kept == 1)
        # ...and the page can be rebuilt from the store alone for that older window.
        older = build_payload(conn, now_tpe=datetime(2026, 8, 3, 12, 0, tzinfo=TAIPEI))
        check("T4 rebuild from store alone recovers it",
              any(d["date"] == "2026-08-01" and d["shifts"] for d in older["days"]))

        # Publish is idempotent and records the revision it published.
        rev = _meta_int(conn, "revision")
        r2 = publish(conn, out, now_tpe=now)
        check("publish converges in one pass when idle", r2["passes"] == 1, str(r2["passes"]))
        check("published_revision tracks revision", _meta_int(conn, "published_revision") == rev)

        # Schedule/health are published for the browser to reason about.
        data = json.loads(out.read_text(encoding="utf-8"))
        check("schedule is published for client-side overdue calc", data["schedule"]["timezone"] == "Asia/Taipei")
        check("all shifts present in health", set(data["health"]) == set(SHIFT_IDS))

        # Atomic write leaves no temp files behind.
        check("no temp files left behind", not list(out.parent.glob(".tmp-*")))

        conn.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if failures:
        print(f"FAILED {len(failures)}: {failures}")
        return 1
    print("all selftests passed")
    return 0


# ---------------------------------------------------------------- cli


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--add", metavar="JSON_FILE", help="validate and store one record, then publish")
    ap.add_argument("--publish", action="store_true", help="rebuild and publish from the store")
    ap.add_argument("--selftest", action="store_true", help="run acceptance tests in a temp dir")
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args(argv)

    if args.selftest:
        return _selftest()

    if not args.add and not args.publish:
        ap.print_help()
        return 2

    conn = connect(args.db)
    try:
        if args.add:
            rec = json.loads(Path(args.add).read_text(encoding="utf-8"))
            when = add_record(conn, rec)
            print(f"stored {rec['id']} on Taipei date {when.date().isoformat()}")
        res = publish(conn, args.out)
        print(f"published revision {res['revision']} in {res['passes']} pass(es) -> {res['path']}")
    except ValidationError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        print("nothing was published.", file=sys.stderr)
        return 1
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
