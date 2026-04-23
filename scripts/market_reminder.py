"""Market-open reminder for Option E-final execution plan.

Fires daily at 08:50 Taipei (00:50 UTC) via GitHub Actions cron. Determines
today's phase in the plan, reads current prices from the dashboard snapshot,
builds a Chinese reminder, and POSTs it to the Discord webhook.

Plan milestones (all Asia/Taipei):
  W1  2026-04-27  00878 定期定額 NT$12,500 首扣
  W2  2026-05-11  TSMC 零股定期定額 NT$12,500 首扣
  W3  2026-05-25  決策日 — 4 條件觸發 [A/A'/B/C]
  W4  2026-06-08  最終部署 — 累積 PnL [X/Y/Z]
  Post-plan  month-end reminder for ongoing monthly DCA
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib import error, request

TAIPEI_TZ = timezone(timedelta(hours=8))

PLAN = {
    "W1": date(2026, 4, 27),
    "W2": date(2026, 5, 11),
    "W3": date(2026, 5, 25),
    "W4": date(2026, 6, 8),
}

# Taiwan stock-market closed days (TWSE-only days excluded). Maintain manually
# once a year per Executive Yuan announcement. v1 covers 2026 fully + 2027 Q1.
TWSE_CLOSED = {
    # 2026
    "2026-01-01",  # 元旦
    "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",  # 春節連假
    "2026-02-27",  # 228 補假
    "2026-04-03", "2026-04-06",  # 兒童節 + 清明 連假
    "2026-05-01",  # 勞動節
    "2026-06-19",  # 端午節
    "2026-09-25",  # 中秋節
    "2026-10-09",  # 國慶 補假
    # 2027 Q1 (in case plan reminder still active)
    "2027-01-01",
    "2027-02-15", "2027-02-16", "2027-02-17", "2027-02-18", "2027-02-19",  # 春節
    "2027-02-26",  # 228 (Sun) 補假
}

# Option E-final cap per slot
SLOT_NT = 12500


def today_taipei() -> date:
    return datetime.now(TAIPEI_TZ).date()


def load_snapshot(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def find_item(snapshot: dict, symbol: str) -> dict | None:
    for bucket in ("holdings", "watchlist"):
        for item in snapshot.get(bucket, []):
            if item.get("symbol") == symbol:
                return item
    return None


def fmt_price_row(snapshot: dict, symbol: str, label: str, currency: str = "NT$") -> str:
    item = find_item(snapshot, symbol)
    if not item or not item.get("data"):
        return f"  {label}: —"
    d = item["data"]
    price = d.get("price")
    chg = d.get("change_pct")
    if price is None:
        return f"  {label}: —"
    arrow = "▲" if (chg or 0) > 0 else "▼" if (chg or 0) < 0 else "→"
    chg_str = f"{chg:+.2f}%" if chg is not None else ""
    return f"  {label}: {currency}{price:,.2f} {arrow} {chg_str}"


def phase_label(today: date) -> str:
    if today < PLAN["W1"]:
        return f"⏳ 計畫尚未啟動 (W1 於 {PLAN['W1']} 開始)"
    if today == PLAN["W1"]:
        return "🚀 W1 首扣日"
    if today < PLAN["W2"]:
        days = (PLAN["W2"] - today).days
        return f"📆 W1 → W2 interval (距 W2 還 {days} 天)"
    if today == PLAN["W2"]:
        return "🚀 W2 首扣日"
    if today < PLAN["W3"]:
        days = (PLAN["W3"] - today).days
        return f"📆 W2 → W3 interval (距 W3 決策日還 {days} 天)"
    if today == PLAN["W3"]:
        return "🎯 W3 決策日（4 選 1 條件觸發）"
    if today < PLAN["W4"]:
        days = (PLAN["W4"] - today).days
        return f"📆 W3 → W4 interval (距 W4 最終部署還 {days} 天)"
    if today == PLAN["W4"]:
        return "🎯 W4 最終部署日（累積 PnL 決策）"
    return "✅ 計畫完成 — 月度 DCA 繼續"


def action_block(today: date, snapshot: dict | None) -> str:
    if today == PLAN["W1"]:
        return (
            "**🚀 W1 首扣日 action**\n"
            "- 中信亮點 APP 會自動扣款 NT$12,500 買 00878 零股累積\n"
            "- 確認扣款帳戶餘額 ≥ NT$12,500 + 手續費 NT$1\n"
            "- 晚上收盤後查扣款紀錄與持股變動\n"
            "- 若 APP 沒扣，立即檢查定期定額設定"
        )
    if today == PLAN["W2"]:
        return (
            "**🚀 W2 首扣日 action**\n"
            "- 中信亮點 APP 會自動扣款 NT$12,500 買 **TSMC (2330) 零股**\n"
            "- 確認你已經在 APP 設定好 TSMC 定期定額（每月 11 日扣）\n"
            "- 餘額 ≥ NT$12,500 + 手續費 NT$1\n"
            "- 若尚未設定，今天立即補設定 → 否則本月跳過，留待下月"
        )
    if today == PLAN["W3"]:
        return (
            "**🎯 W3 決策日 — 必查 3 件事**\n\n"
            "1. **00878 當日收盤價**（亮點 APP 看）\n"
            "2. **國泰投信 Q1 配息公告金額**\n"
            "   → www.cathaysite.com.tw (查 2026Q1 配息)\n"
            "3. **緯穎 (6669) Q1 法說 AWS% breakdown**\n"
            "   → mops.twse.com.tw 查法說資料\n\n"
            "**觸發 4 選 1（Case γ 版）**:\n"
            "```\n"
            "[A]  00878 <NT$23 + 季配 ≥0.45  → 加碼 00878 NT$12,500\n"
            "[A'] 00878 <NT$23 + 季配 <0.40  → 改 TSMC 零股 NT$12,500\n"
            "[B]  緯穎 AWS% <50% + 00878 23-25\n"
            "     → 緯穎 2 股 (NT$8,700) + 00878 零股 (NT$3,800)\n"
            "[C]  default（橫盤 or 其他）     → 00878 NT$12,500\n"
            "```\n"
            "**記錄**你選 [A/A'/B/C] 並手動下單（W3 非定期定額）。"
        )
    if today == PLAN["W4"]:
        return (
            "**🎯 W4 最終部署 — 算累積 PnL 再決定**\n\n"
            "**Step 1**: 算 W1-W3 累積報酬率\n"
            "```\n"
            "累積 PnL% = (現在 W1-W3 市值 - 累積投入成本) / 累積投入成本 × 100%\n"
            "```\n\n"
            "**Step 2**: 觸發 3 選 1\n"
            "```\n"
            "[X] ≥+5%   → 鎖利：00878 NT$12,500\n"
            "[Y] ≤-5%   → 逆勢：TSMC 零股 NT$12,500\n"
            "[Z] ±5%內  → split：00878 NT$6,250 + TSMC NT$6,250\n"
            "```\n\n"
            "Step 3: 手動下單，紀錄結果。**NT$50,000 全部署完成。**"
        )
    if today < PLAN["W1"]:
        days_until = (PLAN["W1"] - today).days
        return (
            f"**⏳ 計畫尚未啟動 (距 W1 {days_until} 天)**\n"
            "- 若尚未完成 Step 1（設 00878 定期定額），今天就做\n"
            "- 中信亮點 APP → 台股 → 定期定額\n"
            "  標的 00878、金額 12,500、扣款日 27 日"
        )
    if today > PLAN["W4"]:
        return (
            "**✅ 計畫完成** — NT$50,000 已全部署\n"
            "- 後續：繼續每月 27 日 00878 定期定額（原本 DCA 紀律）\n"
            "- 6 個月後檢視總績效 + 再平衡"
        )
    # Interval day
    return "**📆 Interval day — 自動扣款中，無手動 action 需要**\n只觀察市場走勢，下個 milestone 再行動。"


def trigger_alerts(today: date, snapshot: dict | None) -> list[str]:
    """Price-based early warnings for upcoming milestone."""
    if not snapshot:
        return []
    alerts = []
    item_00878 = find_item(snapshot, "00878.TW")
    if item_00878 and item_00878.get("data"):
        price = item_00878["data"].get("price")
        if price and PLAN["W2"] <= today < PLAN["W3"] and price < 23:
            alerts.append(
                f"⚠️ 00878 已 <NT$23 (現 {price:.2f})，W3 決策日 {PLAN['W3']} "
                f"若 Q1 季配 ≥0.45 會觸發 [A] 加碼"
            )
    item_wiwynn = find_item(snapshot, "6669.TW")
    if item_wiwynn and item_wiwynn.get("data"):
        price = item_wiwynn["data"].get("price")
        if price and 23 < price < 4500:
            pass  # Placeholder for future refinement
    return alerts


def build_message(today: date, snapshot: dict | None) -> str:
    header = f"📊 **市場開盤前提醒** ({today.strftime('%Y-%m-%d')}, 台股 09:00 開盤)"
    phase = phase_label(today)
    action = action_block(today, snapshot)

    price_lines = []
    if snapshot:
        price_lines.append("**【即時價】** (前一日盤後)")
        price_lines.append(fmt_price_row(snapshot, "00878.TW", "00878", "NT$"))
        price_lines.append(fmt_price_row(snapshot, "2330.TW", "TSMC ", "NT$"))
        price_lines.append(fmt_price_row(snapshot, "6669.TW", "緯穎 ", "NT$"))
        price_lines.append(fmt_price_row(snapshot, "GC=F", "黃金 ", "$"))
    price_block = "\n".join(price_lines) if price_lines else ""

    alerts = trigger_alerts(today, snapshot)
    alert_block = "\n\n**🚨 警示**\n" + "\n".join(f"- {a}" for a in alerts) if alerts else ""

    return (
        f"{header}\n\n"
        f"**【階段】** {phase}\n\n"
        f"{action}\n\n"
        f"{price_block}"
        f"{alert_block}"
    )


def post_discord(webhook_url: str, content: str) -> int:
    data = json.dumps({"content": content}).encode("utf-8")
    req = request.Request(
        webhook_url,
        data=data,
        headers={"Content-Type": "application/json"},
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


def is_trading_day(today: date) -> bool:
    """Mon-Fri AND not on the closed-days list."""
    if today.weekday() >= 5:  # Sat=5, Sun=6
        return False
    if today.isoformat() in TWSE_CLOSED:
        return False
    return True


def main() -> int:
    # Joseph's local Task Scheduler pattern uses ABRAHAM_WEBHOOK_URL.
    # Fall back to DISCORD_WEBHOOK_URL for the GitHub Actions path so the
    # same script supports both deployment modes.
    webhook = os.environ.get("ABRAHAM_WEBHOOK_URL") or os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook:
        print("ERROR: ABRAHAM_WEBHOOK_URL (or DISCORD_WEBHOOK_URL) env var not set", file=sys.stderr)
        return 2

    today = today_taipei()

    # Skip non-trading days (weekend or TWSE holiday) silently — exit 0 so
    # Task Scheduler does not flag a failure.
    if not is_trading_day(today):
        print(f"Skip: {today} is not a TWSE trading day")
        return 0
    snapshot_path = Path(__file__).resolve().parent.parent / "docs" / "data" / "latest.json"
    snapshot = load_snapshot(snapshot_path)
    if snapshot is None:
        print(f"WARN: snapshot not found at {snapshot_path}", file=sys.stderr)

    message = build_message(today, snapshot)
    print(message)
    print()

    status = post_discord(webhook, message)
    print(f"Discord POST status: {status}")
    return 0 if status == 204 else 1


if __name__ == "__main__":
    sys.exit(main())
