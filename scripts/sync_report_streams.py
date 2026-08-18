"""Publish every scheduled stream's output to the 日報 page, without anyone remembering to.

Adam 2026-08-18 07:55: "我仍未見看盤網頁早班日報 ... 你都排定何時更新?" -- nothing was scheduled.
Every stream DM'd him and then dropped its output on the floor; the page only ever moved when
I hand-ran `build_daily_report.py --add`.

WHY THIS IS A POLLER, NOT A HOOK IN EACH JOB
--------------------------------------------
The obvious fix is to have each scheduled job publish its own result. That fails in exactly the
case that matters: a job that crashes, hangs, or never fires publishes nothing AND reports
nothing, so the page silently freezes on yesterday and looks healthy. Anything that must act
when NOTHING happened cannot live inside the thing that only runs when something happens.

So this scans the artifacts on disk and publishes whatever is not on the page yet. It self-heals
a missed run, a late shift, and a backlog, because it re-derives state every time rather than
trusting a "did I already do it" flag. Idempotent by construction: each artifact maps to a
STABLE record id, and the store upserts, so running twice changes nothing.

    python sync_report_streams.py [--dry-run]

Exit 0 = nothing to do or published fine. Exit 1 = something failed (the caller logs it).
"""
import argparse
import io
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

TAIPEI = timezone(timedelta(hours=8))
HOME = os.path.expanduser("~")
AB = os.path.join(HOME, "Abraham")
REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DB = os.path.join(AB, ".daily-report.db")
GATE = os.path.join(REPO, "scripts", "check_daily_report_zones.js")
BUILDER = os.path.join(REPO, "scripts", "build_daily_report.py")
NODE = r"C:\Program Files\nodejs\node.exe"
LOG = os.path.join(AB, ".report-sync.log")

sys.path.insert(0, os.path.join(REPO, "scripts"))
import outbox_to_report as OUT     # noqa: E402  (shares the shift-window assertion)


def log(msg):
    line = "[%s] %s" % (datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line)
    try:
        with io.open(LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def existing_ids():
    """Ask the store what is already published. Deriving state beats trusting a flag file."""
    try:
        con = sqlite3.connect(DB)
        ids = {r[0] for r in con.execute("SELECT id FROM records")}
        con.close()
        return ids
    except Exception as exc:
        raise SystemExit("cannot read the record store (%s) -- refusing to guess: %s" % (DB, exc))


def mtime_taipei(path):
    return datetime.fromtimestamp(os.path.getmtime(path), TAIPEI)


def slot_of(dt):
    """morning / noon / night, by which scheduled block the timestamp falls in."""
    m = dt.hour * 60 + dt.minute
    if 5 * 60 <= m < 12 * 60:
        return "morning"
    if 12 * 60 <= m < 19 * 60:
        return "noon"
    return "night"


SLOT_ZH = {"morning": "早班", "noon": "午班", "night": "晚班"}


def ev(rid, occurred, stream, title, body, src=None):
    return {"schema": 1, "kind": "event", "id": rid, "occurred_at": occurred.isoformat(),
            "stream": stream, "t": title, "s": "neutral", "tickers": [],
            "notify_reason": "none", "body": body, "src": src}


# ---------------------------------------------------------------- collectors

def c_deepread(have):
    """The three deep-read shifts. The delivered text is archived verbatim by the pipeline."""
    out = []
    for p in sorted(OUT.glob_outbox()):
        m = re.search(r"consumed-(\d{8})T(\d{6})Z", os.path.basename(p))
        if not m:
            continue
        d, t = m.group(1), m.group(2)
        hh, mm = int(t[:2]), int(t[2:4])
        sid, _ = OUT.shift_for(hh * 60 + mm)
        if sid is None:
            log("SKIP %s: %02d:%02d is not inside any shift window" % (os.path.basename(p), hh, mm))
            continue
        rid = "%s-%s-%s.%s" % (d[:4], d[4:6], d[6:], sid)
        if rid in have:
            continue
        rec, _items, _n = OUT.build(p)
        out.append(rec)
    return out


def c_kol(have):
    """KOL batches. The raw posts are the stream; my written commentary is added separately
    when I am in the loop, and its absence must not stop the posts from appearing."""
    out = []
    d = os.path.join(AB, ".kol-digest")
    if not os.path.isdir(d):
        return out
    for f in sorted(os.listdir(d)):
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-([\w-]+)\.json$", f)
        if not m:
            continue                       # .seen.json sidecars and anything else
        y, mo, dd, hh, mi, _run = m.groups()
        when = datetime(int(y), int(mo), int(dd), int(hh), int(mi), tzinfo=TAIPEI)
        slot = slot_of(when)
        rid = "%s-%s-%s.kol.%s" % (y, mo, dd, slot)
        if rid in have:
            continue
        try:
            data = json.load(io.open(os.path.join(d, f), encoding="utf-8"))
        except Exception as exc:
            log("SKIP kol %s: unreadable (%s)" % (f, exc))
            continue
        res = data.get("results") or []    # NOT "handles" -- guessed that once and got 0
        # ONE EVENT PER HANDLE, not one per batch. A batch-sized body is a single unit to the
        # zone gate, so one incidental number collision (a KOL quoting "58,200") would take the
        # entire digest off the page and nothing would say why. Per-handle, a collision costs
        # that one account. It also reads better now that items collapse to a title.
        n_total, failed = 0, []
        for h in res:
            if not h.get("ok"):
                failed.append(str(h.get("name") or h.get("handle")))
                continue
            posts = h.get("newPosts") or []
            if not posts:
                continue
            n_total += len(posts)
            name = h.get("name") or h.get("handle")
            body = []
            for p in posts:
                txt = p if isinstance(p, str) else json.dumps(p, ensure_ascii=False)
                body.append(re.sub(r"\s*\n\s*", " ", str(txt)).strip()[:900])
            hid = re.sub(r"[^A-Za-z0-9]+", "", str(h.get("handle") or name))[:24] or "x"
            out.append(ev("%s.%s" % (rid, hid), when, "網紅摘要（%s）" % SLOT_ZH[slot],
                          "%s（%s）%d 則" % (name, h.get("tag") or "", len(posts)),
                          "\n\n".join(body), src=str(h.get("handle") or "")))
        # The run itself is recorded even when every account is quiet, so "the job did not run"
        # and "the job ran and found nothing" stay distinguishable on the page.
        head = ["這一批共 %d 則新貼文。" % n_total] if n_total else ["這一批十個帳號都沒有新貼文。"]
        if failed:
            head.append("⚠️ 這批抓不到：" + "、".join(failed))
        out.append(ev(rid, when, "網紅摘要（%s）" % SLOT_ZH[slot],
                      "%s 網紅摘要：%d 則" % (SLOT_ZH[slot], n_total), "\n".join(head)))
    return out


def _text_stream(have, filename, rid_tmpl, stream, title_fn, window=None):
    """Shared shape for the jobs that leave their DM text in a flat file."""
    p = os.path.join(AB, filename)
    if not os.path.exists(p):
        return []
    body = io.open(p, encoding="utf-8", errors="replace").read().strip()
    if not body:
        return []
    when = mtime_taipei(p)
    if window and not (window[0] <= when.hour * 60 + when.minute <= window[1]):
        log("SKIP %s: mtime %s is outside its scheduled window" % (filename, when.strftime("%H:%M")))
        return []
    rid = when.strftime(rid_tmpl)
    if rid in have:
        return []
    first = next((l.strip() for l in body.split("\n") if l.strip()), stream)
    return [ev(rid, when, stream, title_fn(first, when), body)]


def c_presswire(have):
    return _text_stream(have, ".press-wire-digest.txt", "%Y-%m-%d.radar.presswire",
                        "新聞稿雷達", lambda first, w: re.sub(r"^📰\s*", "", first)[:90])


def c_gooptions(have):
    return _text_stream(have, "gooptions-digest.txt", "%Y-%m-%d.gooptions.%H%M",
                        "聰明錢・gooptions",
                        lambda first, w: "%s gooptions：%s" % (w.strftime("%H:%M"),
                                                              re.sub(r"^📰\s*", "", first)[:70]))


def c_transcript(have):
    return _text_stream(have, ".transcript-watch-last.txt", "%Y-%m-%d.transcript",
                        "法說逐字稿偵測",
                        lambda first, w: "逐字稿掃描：" + first[:70])


def c_stream_outbox(have):
    """Anything dropped in ~/Abraham/.stream-outbox/.

    The streams whose DM text I compose live (EDGAR smart-money, supply-chain, weekly
    synthesis, ad-hoc alerts) archive nothing, so a collector cannot reach them -- and
    inventing their content from a state file would be fabrication. This is the general fix:
    when I send one of those DMs I also drop the same text here, and it reaches the page on
    the next tick. One drop-box beats a bespoke collector per stream, and it covers streams
    that do not exist yet.

    Filename: <YYYYMMDD>T<HHMM>__<stream>__<slug>.md   (first line = title, rest = body)
    """
    out = []
    d = os.path.join(AB, ".stream-outbox")
    if not os.path.isdir(d):
        return out
    for f in sorted(os.listdir(d)):
        m = re.match(r"(\d{8})T(\d{4})__([^_]+)__(.+)\.md$", f)
        if not m:
            continue
        ymd, hm, stream, slug = m.groups()
        when = datetime(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:]),
                        int(hm[:2]), int(hm[2:]), tzinfo=TAIPEI)
        rid = "%s-%s-%s.out.%s.%s" % (ymd[:4], ymd[4:6], ymd[6:], re.sub(r"\W+", "", stream)[:20], hm)
        if rid in have:
            continue
        body = io.open(os.path.join(d, f), encoding="utf-8", errors="replace").read().strip()
        if not body:
            continue
        lines = [l for l in body.split("\n") if l.strip()]
        title = re.sub(r"^[#*\s📰🔴🟠⭐🆕]+", "", lines[0])[:90] if lines else slug
        out.append(ev(rid, when, stream, title, body))
    return out


COLLECTORS = [("deepread", c_deepread), ("kol", c_kol),
              ("presswire", c_presswire), ("gooptions", c_gooptions),
              ("transcript", c_transcript), ("stream-outbox", c_stream_outbox)]


# ---------------------------------------------------------------- gate + publish

def gate_blocked(rec):
    """Per-item zone-gate check, using the REAL gate. Returns (kept_items, dropped)."""
    items = rec.get("items")
    probe = items if items is not None else [{"t": rec.get("t", ""), "s": "neutral", "tickers": [],
                                              "body": rec.get("body", ""), "notify_reason": "none"}]
    kept, dropped = [], []
    for it in probe:
        one = {"schema": 1, "_updated": rec["occurred_at"], "revision": 1,
               "schedule": {"timezone": "Asia/Taipei", "shifts": [], "skip_dates": []}, "health": {},
               "days": [{"date": rec["id"].split(".")[0], "top": [], "shifts": [],
                         "events": [dict(it, id="probe", occurred_at=rec["occurred_at"])]}]}
        fd, tmp = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        try:
            io.open(tmp, "w", encoding="utf-8").write(json.dumps(one, ensure_ascii=False))
            p = subprocess.run([NODE, GATE, tmp], capture_output=True, text=True, encoding="utf-8")
        finally:
            os.unlink(tmp)
        if p.returncode == 2:
            raise RuntimeError("zone gate could not run — treating as blocked: "
                               + (p.stderr or "").strip()[:200])
        if p.returncode == 1:
            dropped.append((it.get("t", "")[:60],
                            sorted(set(re.findall(r"BLOCK (\S+) ::", (p.stderr or "") + (p.stdout or ""))))))
        else:
            kept.append(it)
    return kept, dropped


def publish(rec):
    fd, tmp = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    try:
        io.open(tmp, "w", encoding="utf-8").write(json.dumps(rec, ensure_ascii=False))
        p = subprocess.run([sys.executable, BUILDER, "--add", tmp],
                           capture_output=True, text=True, encoding="utf-8",
                           env=dict(os.environ, PYTHONUTF8="1"))
    finally:
        os.unlink(tmp)
    return p.returncode == 0, ((p.stdout or "") + (p.stderr or "")).strip().splitlines()[-1:] or [""]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    have = existing_ids()
    pending, failures = [], 0
    for name, fn in COLLECTORS:
        try:
            got = fn(have)
        except Exception as exc:
            log("COLLECTOR FAILED %s: %s" % (name, exc))
            failures += 1
            continue
        for rec in got:
            pending.append((name, rec))

    if not pending:
        log("nothing new (store holds %d records)" % len(have))
        return 1 if failures else 0

    for name, rec in pending:
        kept, dropped = gate_blocked(rec)
        for title, ticks in dropped:
            log("  zone-gate dropped [%s] %s :: %s" % (rec["id"], title, ",".join(ticks)))
        if rec.get("items") is not None:
            if not kept:
                log("SKIP %s: every item blocked by the zone gate" % rec["id"])
                continue
            rec["items"] = kept
        elif dropped:
            log("SKIP %s: blocked by the zone gate" % rec["id"])
            continue
        if args.dry_run:
            log("DRY-RUN would publish %s (%s)" % (rec["id"], name))
            continue
        ok, tail = publish(rec)
        log(("PUBLISHED %s (%s) %s" if ok else "FAILED %s (%s) %s") % (rec["id"], name, tail[0][:120]))
        if not ok:
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
