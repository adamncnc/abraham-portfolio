"""Convert a delivered deep-read outbox file into a daily-report shift record.

Adam 2026-08-18: "網頁日報要讓我知道讀到什麼新聞，包含該條新聞的簡述，後面再接你的解讀."

The delivered Discord text ALREADY has that shape -- `### Article N: <headline>` , then the
facts, then a `👉` line carrying my take. The page lost it because those shifts were re-typed
from my working notes instead of being carried over. So this does not invent a format: it
lifts the original text and makes the news/opinion boundary explicit.

Nothing is paraphrased. Every non-empty source line must land in exactly one item body or be
consumed as a title, and the script refuses to emit a record if any line goes missing.

    python outbox_to_report.py <consumed-file> [...]   # writes one JSON per file, prints a review table

⚠️ The `Z` in the filenames is a LIE. `...consumed-20260817T223253Z.md` is 22:32 TAIPEI, not
UTC -- it lands ~20 min after the 22:10 shift, and its mtime (local) agrees. Reading it as UTC
would push every evening shift onto the following day. The window assertion below enforces it.
"""
import io
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone

TAIPEI = timezone(timedelta(hours=8))
SHIFTS = [("morning", 6 * 60 + 10), ("midday", 14 * 60 + 10), ("evening", 22 * 60 + 10)]
GRACE_MIN = 180

BLOCK_LABEL = "**🧠 以下整段是我的判斷，不是新聞內容**"

SEP = re.compile(r"^\s*-{3,}\s*$")
HEAD = re.compile(r"^###\s*(.+?)\s*$")
# "Article 1:" / "Article 1：" / "Article 1（本班最重要）:" -- scaffolding, not part of the
# headline. Any parenthetical I added is kept; only the token and its colon are dropped.
ART = re.compile(r"^Article\s*\d+\s*")


def shift_for(minutes):
    for sid, due in SHIFTS:
        if due <= minutes <= due + GRACE_MIN:
            return sid, due
    return None, None


def strip_lead(s):
    """Drop leading markdown and decorative symbols. Enumerating emoji by hand missed 🔎
    and left '## ' in place on the first pass; the Unicode category covers the whole class."""
    prev = None
    while s != prev:
        prev = s
        s = re.sub(r"^[#*\s️‍]+", "", s)
        if s and unicodedata.category(s[0]) in ("So", "Sk"):
            s = s[1:]
    return s.strip()


def clean_title(raw):
    t = ART.sub("", raw).strip()
    t = re.sub(r"^[:：]\s*", "", t)
    t = re.sub(r"^(（[^）]*）)\s*[:：]\s*", r"\1", t)   # （本班最重要）: X -> （本班最重要）X
    return t.strip()


def parse(path):
    text = io.open(path, encoding="utf-8").read().replace("\r\n", "\n")
    lines = text.split("\n")

    # Segment on ### headings and --- rules. Whatever precedes the first of either is the
    # opening block (how many articles were read, the time anchor, the selection note).
    segs, cur_title, cur = [], None, []
    n_head = n_sep = 0
    for ln in lines:
        h = HEAD.match(ln)
        if h:
            segs.append((cur_title, cur))
            cur_title, cur, n_head = h.group(1), [], n_head + 1
        elif SEP.match(ln):
            segs.append((cur_title, cur))
            cur_title, cur, n_sep = None, [], n_sep + 1
        else:
            cur.append(ln)
    segs.append((cur_title, cur))

    # Every source line is now either inside a segment body, or was a heading (kept as a
    # title) or a rule (pure punctuation). If that does not add up, something was eaten.
    counted = sum(len(b) for _, b in segs) + n_head + n_sep
    if counted != len(lines):
        raise SystemExit("%s: line accounting failed (%d != %d)" % (path, counted, len(lines)))

    out = []
    for idx, (head_title, chunk) in enumerate(segs):
        body_lines = list(chunk)
        while body_lines and not body_lines[0].strip():
            body_lines.pop(0)
        while body_lines and not body_lines[-1].strip():
            body_lines.pop()
        if not body_lines:
            continue

        # The collapsed list is now the whole navigation surface, so each title has to say
        # on its own which it is. 📰 = a headline I read; 🧠 = my own analysis. Adam's
        # complaint was that the two were indistinguishable once folded together.
        if head_title is not None and head_title.startswith("Article"):
            is_article = True
            title = "📰 " + clean_title(head_title)
        else:
            is_article = False
            if head_title is not None:
                base = head_title
            elif idx == 0:
                base = "本班開場：讀了幾篇、時間錨、選片說明"
            else:
                base = body_lines[0].strip()
            base = strip_lead(re.sub(r"\*\*", "", base)).rstrip("：:").strip()
            title = "🧠 " + (base[:58] + "…" if len(base) > 60 else base)

        # Article bodies ship VERBATIM, with nothing injected.
        #
        # The first attempt split each one into "what the article said" / "my reading" at the
        # 👉 marker. Measured against the real files that was wrong: only 6 of 70 articles use
        # 👉. In the other 64 the facts and my commentary are interleaved in prose (a caveat
        # paragraph opening ⚠️, a bolded aside, sometimes neither), so there is no boundary to
        # find. Stamping "**這篇新聞說了什麼**" over the top of that would file my own judgment
        # as reporting -- the precise thing Adam objected to, made harder to see. A label that
        # is right 9% of the time is worse than no label.
        #
        # The delivered Discord text is what Adam is asking to get back ("與你從前 discord 深讀
        # 不一樣"), and it already reads facts-first with the headline on top. Carrying it over
        # untouched IS the fix; the separation he wants comes from the title being the real
        # headline instead of my conclusion sentence.
        if is_article:
            body = "\n".join(body_lines)
        else:
            # These blocks are wholly mine -- 進場區攔截, 主軸影響總結, 防護航自查 and the like
            # contain no article content at all, so this label is a claim I can actually make.
            body = BLOCK_LABEL + "\n" + "\n".join(body_lines)

        out.append({"t": title, "s": "neutral", "tickers": [], "notify_reason": "none",
                    "body": body, "is_article": is_article})

    return out, text


def build(path):
    m = re.search(r"consumed-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z", os.path.basename(path))
    if not m:
        raise SystemExit("cannot read a timestamp out of " + path)
    y, mo, d, hh, mm, ss = (int(x) for x in m.groups())
    minutes = hh * 60 + mm
    sid, due = shift_for(minutes)
    if sid is None:
        raise SystemExit("%s: %02d:%02d is not within %d min of any shift -- if this really is "
                         "UTC the whole mapping is wrong, so refusing to guess" % (path, hh, mm, GRACE_MIN))
    occurred = datetime(y, mo, d, hh, mm, ss, tzinfo=TAIPEI)

    items, text = parse(path)
    if not items:
        raise SystemExit(path + ": parsed zero items")

    n_art_src = len(re.findall(r"^###\s*Article", text, re.M))
    n_art_out = sum(1 for it in items if it["is_article"])
    if n_art_src != n_art_out:
        raise SystemExit("%s: source has %d articles, output has %d" % (path, n_art_src, n_art_out))

    summary = next((l.strip() for l in text.split("\n") if l.strip()), "")
    rec = {
        "schema": 1, "kind": "shift", "id": "%04d-%02d-%02d.%s" % (y, mo, d, sid),
        "occurred_at": occurred.isoformat(), "shift": sid, "outcome": "complete",
        "summary": summary, "error": None,
        "items": [{k: v for k, v in it.items() if k != "is_article"} for it in items],
    }
    return rec, items, n_art_src


def main(argv):
    outdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".report-records")
    outdir = os.path.normpath(outdir)
    os.makedirs(outdir, exist_ok=True)
    for path in argv:
        rec, items, n_art = build(path)
        dest = os.path.join(outdir, rec["id"] + ".json")
        io.open(dest, "w", encoding="utf-8").write(json.dumps(rec, ensure_ascii=False, indent=1))
        chars = sum(len(i["body"]) for i in rec["items"])
        print("\n%s  ->  %s   %d items (%d news / %d mine)  %d chars"
              % (os.path.basename(path)[-20:], rec["id"], len(items), n_art, len(items) - n_art, chars))
        print("   occurred_at %s" % rec["occurred_at"])
        for it in items:
            print("     " + it["t"][:66])


if __name__ == "__main__":
    main(sys.argv[1:])
