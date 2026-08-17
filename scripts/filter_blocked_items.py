"""Drop any restored item the zone gate refuses, and say exactly which and why.

Two different things get caught, and both are handled the same way -- by removing the item,
never by touching the gate:

  * REAL: my own 進場區攔截 / 進場區檢查 blocks quote buy levels that have since gone stale.
    Re-serving those on a page Adam reads today is precisely the hazard the gate exists for,
    so they should not be republished at all. The gate is right.

  * COLLISION: an ordinary number in a news article lands inside some stale ticker's range.
    "5,200 美元" (gold) splits at the comma to 200, which sits in 力智's 190.4-210.4;
    "35 萬韓元" (memory) sits in Ouster's 35-40. Neither is a price for that ticker.

The collision cases are a known limitation, not a reason to weaken a safety rail: a gate that
over-fires on an archive is failing in the safe direction. Rewriting the article text to dodge
it would corrupt the record I am restoring, so the item is dropped and reported instead.

    python filter_blocked_items.py        # rewrites .report-records/*.json, prints the manifest
"""
import io
import json
import glob
import os
import re
import subprocess
import tempfile

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
GATE = os.path.join(REPO, "scripts", "check_daily_report_zones.js")
NODE = r"C:\Program Files\nodejs\node.exe"
RECORDS = os.path.join(REPO, ".report-records")


def gate_blocks(rec, item):
    """Run the REAL gate over a one-item report. Returns the list of blocked tickers."""
    one = {"schema": 1, "_updated": rec["occurred_at"], "revision": 1,
           "schedule": {"timezone": "Asia/Taipei", "shifts": [], "skip_dates": []},
           "health": {},
           "days": [{"date": rec["id"].split(".")[0], "top": [],
                     "shifts": [{"id": "x", "shift": rec["shift"], "outcome": "complete",
                                 "delivered_at": rec["occurred_at"], "summary": "s",
                                 "error": None, "items": [item]}],
                     "events": []}]}
    fd, tmp = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    try:
        io.open(tmp, "w", encoding="utf-8").write(json.dumps(one, ensure_ascii=False))
        p = subprocess.run([NODE, GATE, tmp], capture_output=True, text=True, encoding="utf-8")
    finally:
        os.unlink(tmp)
    if p.returncode == 2:
        raise SystemExit("gate could not run (exit 2) — treat as blocked: "
                         + (p.stderr or "").strip()[:200])
    out = (p.stderr or "") + (p.stdout or "")
    return sorted(set(re.findall(r"BLOCK (\S+) ::", out))) if p.returncode == 1 else []


def main():
    dropped, kept, total = [], 0, 0
    # The manifest this script writes also ends in .json and would be re-read as a record
    # on the next run, so match dated records only.
    for f in sorted(glob.glob(os.path.join(RECORDS, "20??-??-??.*.json"))):
        rec = json.load(io.open(f, encoding="utf-8"))
        keep = []
        for it in rec["items"]:
            total += 1
            names = gate_blocks(rec, it)
            if names:
                dropped.append((rec["id"], it["t"], names))
            else:
                keep.append(it)
        if not keep:
            raise SystemExit(rec["id"] + ": every item was blocked — that is a gate/parse "
                             "problem, not 9 bad shifts. Refusing to publish an empty shift.")
        kept += len(keep)
        rec["items"] = keep
        io.open(f, "w", encoding="utf-8").write(json.dumps(rec, ensure_ascii=False, indent=1))

    print("items: %d total, %d kept, %d dropped\n" % (total, kept, len(dropped)))
    for rid, t, names in dropped:
        print("  DROPPED %-22s %-50s %s" % (rid, t[:50], ",".join(names)))
    man = os.path.join(RECORDS, "_dropped.json")
    io.open(man, "w", encoding="utf-8").write(json.dumps(
        [{"shift": r, "title": t, "tickers": n} for r, t, n in dropped], ensure_ascii=False, indent=1))
    print("\nmanifest -> " + man)


if __name__ == "__main__":
    main()
