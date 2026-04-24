"""IPO watcher.

Polls Taiwan MOPS (公開資訊觀測站) for upcoming IPO subscriptions, diffs against
a local state file, and POSTs Discord webhook alerts for any newly-discovered IPOs
that retail investors can subscribe to.

Data source: https://mopsov.twse.com.tw/ipospoinform/
  - Endpoint A: IpoQueryCase   — returns list of all IPO cases (no params)
  - Endpoint B: IpoQueryFast   — returns subscription details for one stockNo

Run modes:
  python ipo_watcher.py              -> fetch + diff + POST webhook
  python ipo_watcher.py --print-only -> fetch + print message, no POST
  python ipo_watcher.py --reset      -> wipe state file (next run will notify all)
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Optional
from urllib import error, request
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = REPO_ROOT / "data" / "ipo_seen.json"
TZ = ZoneInfo("Asia/Taipei")

MOPS_BASE = "https://mopsov.twse.com.tw/server-java/apiM/ipo/interfaces"

# Issue types that count as a "real" IPO retail subscription.
# Skip 可轉換公司債 (convertible bonds), 競價拍賣 only deals (institutional auction).
IPO_TYPES = {"初上市", "初上櫃", "第一上市公司初上市", "創新板初上市"}

USER_AGENT = "Abraham-Portfolio-Bot/1.0 (+github.com/adamncnc/abraham-portfolio)"


@dataclass
class IpoCase:
    stock_no: str
    name: str
    case_type: str  # raw type string from IpoQueryCase
    subscription_period: Optional[str] = None
    lottery_date: Optional[str] = None
    underwrite_price: Optional[str] = None  # NT$ per share, string
    underwrite_lots: Optional[str] = None  # number of lots offered
    grant_date: Optional[str] = None  # 撥券日
    underwriter: Optional[str] = None  # 主辦券商


import time


def http_get_json(url: str, retries: int = 3, backoff: float = 2.0) -> dict:
    """GET + JSON decode with retry on transient failures."""
    last_exc: Optional[Exception] = None
    for attempt in range(retries):
        try:
            req = request.Request(url, headers={"User-Agent": USER_AGENT})
            with request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (error.URLError, error.HTTPError, json.JSONDecodeError, TimeoutError) as exc:
            last_exc = exc
            if attempt < retries - 1:
                sleep_for = backoff ** attempt
                print(f"WARN: http_get_json {url[:80]}... attempt {attempt+1} failed ({exc}); retry in {sleep_for}s", file=sys.stderr)
                time.sleep(sleep_for)
    raise last_exc if last_exc else RuntimeError("http_get_json: unknown failure")


def fetch_ipo_cases() -> list[IpoCase]:
    body = urllib.parse.quote("{}")
    url = f"{MOPS_BASE}/IpoQueryCase?requestBody={body}&requestHeader={body}"
    try:
        payload = http_get_json(url)
    except Exception as exc:
        print(f"ERROR: fetch_ipo_cases failed after retries: {exc}", file=sys.stderr)
        return []
    rows = payload.get("responseBody", {}).get("allType", [])
    cases: list[IpoCase] = []
    for row in rows:
        data = row.get("data", [])
        if len(data) < 3:
            continue
        stock_no, name, case_type = data[0], data[1], data[2]
        if case_type not in IPO_TYPES:
            continue
        cases.append(IpoCase(stock_no=stock_no, name=name, case_type=case_type))
    return cases


def hydrate_case(case: IpoCase) -> IpoCase:
    body = urllib.parse.quote(json.dumps({"stockNo": case.stock_no, "order": "desc"}))
    url = f"{MOPS_BASE}/IpoQueryFast?requestBody={body}&requestHeader=%7B%7D"
    try:
        payload = http_get_json(url)
    except (error.URLError, json.JSONDecodeError) as exc:
        print(f"WARN: hydrate {case.stock_no} failed: {exc}", file=sys.stderr)
        return case
    body_data = payload.get("responseBody", {})
    types = body_data.get("allType", [])
    if not types:
        return case
    bucket = types[0]
    case.grant_date = bucket.get("grantStockDate")
    case.underwriter = bucket.get("underWriterName")
    for entry in bucket.get("allData", []):
        if entry.get("type") != "申購":
            continue
        fields = entry.get("fields", [])
        data = entry.get("data", [])
        mapping = dict(zip(fields, data))
        case.subscription_period = mapping.get("申購期間（起迄）")
        case.lottery_date = mapping.get("抽籤日期")
        case.underwrite_price = mapping.get("承銷價（元）")
        case.underwrite_lots = mapping.get("實際承銷張數")
        break
    return case


def has_active_subscription(case: IpoCase) -> bool:
    """True if subscription period exists and end date >= today."""
    if not case.subscription_period or "-" not in case.subscription_period:
        return False
    try:
        _, end_str = case.subscription_period.split("-")
        end_date = datetime.strptime(end_str.strip(), "%Y/%m/%d").date()
    except (ValueError, IndexError):
        return False
    today = datetime.now(TZ).date()
    return end_date >= today


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"notified": {}}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"notified": {}}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def total_cost_per_lot(price_str: Optional[str]) -> Optional[int]:
    if not price_str:
        return None
    try:
        return int(round(float(price_str) * 1000))
    except (ValueError, TypeError):
        return None


def format_ntd(value: Optional[int]) -> str:
    if value is None:
        return "—"
    return f"NT${value:,}"


def build_message(new_cases: list[IpoCase]) -> str:
    today_str = datetime.now(TZ).strftime("%Y-%m-%d")
    lines = [
        f"🎲 **新 IPO 申購機會** ({len(new_cases)} 檔) — {today_str}",
        "",
    ]
    for case in new_cases:
        cost = total_cost_per_lot(case.underwrite_price)
        lines.extend(
            [
                f"**{case.name}** ({case.stock_no}) — {case.case_type}",
                f"  承銷價：NT${case.underwrite_price or '—'} → 1 張 = {format_ntd(cost)}",
                f"  申購期：{case.subscription_period or '—'}",
                f"  抽籤日：{case.lottery_date or '—'}",
                f"  撥券日：{case.grant_date or '—'}",
                f"  承銷張數：{case.underwrite_lots or '—'}",
                f"  主辦券商：{case.underwriter or '—'}",
                "",
            ]
        )
    lines.extend(
        [
            "**提醒**：",
            "- 申購處理費 NT$20（每檔每次，不論中不中）",
            "- 中籤後扣款 = 承銷價 × 1000 + NT$50 撥券費",
            "- 戶頭沒備足現金別申購（違約交割影響信用）",
        ]
    )
    return "\n".join(lines)


def post_discord(webhook_url: str, content: str) -> int:
    data = json.dumps({"content": content}).encode("utf-8")
    req = request.Request(
        webhook_url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=15) as resp:
            return resp.status
    except error.HTTPError as e:
        print(f"Discord HTTP error: {e.code} {e.reason}", file=sys.stderr)
        print(e.read().decode("utf-8", errors="replace"), file=sys.stderr)
        return e.code
    except error.URLError as e:
        print(f"Discord URL error: {e.reason}", file=sys.stderr)
        return -1


def main() -> int:
    args = sys.argv[1:]
    if "--reset" in args:
        if STATE_FILE.exists():
            STATE_FILE.unlink()
            print(f"State file removed: {STATE_FILE}")
        else:
            print("No state file to remove")
        return 0

    print_only = "--print-only" in args

    print("Fetching IPO case list from MOPS...", file=sys.stderr)
    cases = fetch_ipo_cases()
    print(f"  found {len(cases)} IPO-type cases (excluding CB)", file=sys.stderr)

    print("Hydrating subscription details...", file=sys.stderr)
    hydrated = [hydrate_case(c) for c in cases]
    active = [c for c in hydrated if has_active_subscription(c)]
    print(f"  {len(active)} have active subscription window", file=sys.stderr)

    state = load_state()
    seen = state.setdefault("notified", {})
    first_run = not STATE_FILE.exists()

    new_cases = [c for c in active if c.stock_no not in seen]

    if first_run and not print_only:
        # First-ever run: silently seed state with current IPOs (Adam already knows them).
        # Subsequent runs notify only newly-appearing IPOs.
        today_iso = datetime.now(TZ).strftime("%Y-%m-%d")
        for case in active:
            seen[case.stock_no] = {
                "name": case.name,
                "notified_at": today_iso,
                "subscription_period": case.subscription_period,
                "seeded": True,
            }
        save_state(state)
        print(f"First run: seeded {len(active)} IPOs as baseline. No notifications sent.", file=sys.stderr)
        return 0

    if not new_cases:
        print("No new IPOs. Nothing to notify.", file=sys.stderr)
        return 0

    print(f"NEW: {len(new_cases)} IPOs to notify", file=sys.stderr)
    message = build_message(new_cases)

    if print_only:
        print(message)
        return 0

    webhook = os.environ.get("ABRAHAM_WEBHOOK_URL") or os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook:
        print("ERROR: ABRAHAM_WEBHOOK_URL (or DISCORD_WEBHOOK_URL) env var not set", file=sys.stderr)
        return 1

    status = post_discord(webhook, message)
    print(f"Discord POST status: {status}", file=sys.stderr)
    if status not in (200, 204):
        return 1

    today_iso = datetime.now(TZ).strftime("%Y-%m-%d")
    for case in new_cases:
        seen[case.stock_no] = {
            "name": case.name,
            "notified_at": today_iso,
            "subscription_period": case.subscription_period,
        }
    save_state(state)
    print(f"State saved: {len(seen)} IPOs marked as notified", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
