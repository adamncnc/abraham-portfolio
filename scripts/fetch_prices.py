"""Main orchestrator.

Loads holdings.json + watchlist.json, dispatches each item to the correct
fetcher by `type`, and writes a combined snapshot to docs/data/latest.json
plus a dated copy to data/snapshots/{YYYY-MM-DD}.json.

Errors on one item never kill the whole run — the failing item gets
status="error" but other items still get fresh data.

Usage:
    python scripts/fetch_prices.py
"""
from __future__ import annotations

import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from fetchers import fetch_by_type  # noqa: E402


def load_config(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"Config not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def enrich_holding(item: dict) -> dict:
    """Compute position-level metrics for holdings (not watchlist items)."""
    data = item.get("data") or {}
    price = data.get("price")

    # Gold special case — quantity_oz * price
    if item.get("type") == "commodity":
        qty = item.get("quantity_oz") or 0
        cost_basis = item.get("cost_basis_usd_per_oz")
        if qty and price is not None:
            item["market_value"] = qty * price
            if cost_basis:
                item["total_cost"] = qty * cost_basis
                item["unrealized_pnl"] = item["market_value"] - item["total_cost"]
                item["unrealized_pnl_pct"] = (
                    (item["unrealized_pnl"] / item["total_cost"]) * 100
                    if item["total_cost"] else None
                )
        return item

    # Stock / ETF holdings (not yet used — Adam holds 0 shares of all tracked ETFs today)
    shares = item.get("shares") or 0
    cost_basis = item.get("cost_basis") or item.get("cost_basis_twd") or item.get("cost_basis_usd")
    if shares and price is not None:
        item["market_value"] = shares * price
        if cost_basis:
            item["total_cost"] = shares * cost_basis
            item["unrealized_pnl"] = item["market_value"] - item["total_cost"]
            item["unrealized_pnl_pct"] = (
                (item["unrealized_pnl"] / item["total_cost"]) * 100
                if item["total_cost"] else None
            )
    return item


def process_item(item: dict) -> dict:
    item_type = item.get("type")
    symbol = item.get("symbol")
    if not item_type or not symbol:
        item["status"] = "error"
        item["error"] = "Missing type or symbol"
        return item

    try:
        item["data"] = fetch_by_type(item_type, symbol)
        item["status"] = "ok"
    except Exception as exc:
        item["status"] = "error"
        item["error"] = f"{type(exc).__name__}: {exc}"
        item["traceback"] = traceback.format_exc()
        item["data"] = None
    return item


def main() -> int:
    holdings_cfg = load_config(ROOT / "config" / "holdings.json")
    watchlist_cfg = load_config(ROOT / "config" / "watchlist.json")

    holdings = [dict(item, _section="holdings") for item in holdings_cfg.get("holdings", [])]
    watchlist = [dict(item, _section="watchlist") for item in watchlist_cfg.get("watchlist", [])]

    processed_holdings = [enrich_holding(process_item(item)) for item in holdings]
    processed_watchlist = [process_item(item) for item in watchlist]

    # Portfolio-level rollup (holdings only)
    total_market_value = sum(
        (item.get("market_value") or 0) for item in processed_holdings
    )
    total_cost = sum(
        (item.get("total_cost") or 0) for item in processed_holdings
    )
    total_pnl = total_market_value - total_cost if total_cost else None

    snapshot = {
        "schema_version": "1.0",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "portfolio_summary": {
            "total_market_value_usd_equiv": total_market_value,
            "total_cost_usd_equiv": total_cost,
            "total_unrealized_pnl_usd_equiv": total_pnl,
            "total_unrealized_pnl_pct": (
                (total_pnl / total_cost) * 100 if total_cost else None
            ),
            "holdings_count": len(processed_holdings),
            "watchlist_count": len(processed_watchlist),
        },
        "holdings": processed_holdings,
        "watchlist": processed_watchlist,
    }

    docs_data_dir = ROOT / "docs" / "data"
    docs_data_dir.mkdir(parents=True, exist_ok=True)
    latest_path = docs_data_dir / "latest.json"
    latest_path.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )

    snapshots_dir = ROOT / "data" / "snapshots"
    snapshots_dir.mkdir(parents=True, exist_ok=True)
    dated_path = snapshots_dir / f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.json"
    dated_path.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )

    # Console summary
    print(f"Snapshot written: {latest_path}")
    print(f"Dated copy:       {dated_path}")
    print()
    print(f"Holdings ({len(processed_holdings)}):")
    for item in processed_holdings:
        status = item.get("status")
        price = (item.get("data") or {}).get("price")
        marker = "OK" if status == "ok" else "ERR"
        print(f"  [{marker}] {item.get('id'):20s} {item.get('symbol'):12s} price={price}")
    print()
    print(f"Watchlist ({len(processed_watchlist)}):")
    for item in processed_watchlist:
        status = item.get("status")
        price = (item.get("data") or {}).get("price")
        marker = "OK" if status == "ok" else "ERR"
        print(f"  [{marker}] {item.get('id'):20s} {item.get('symbol'):12s} price={price}")

    error_count = sum(
        1 for item in (processed_holdings + processed_watchlist)
        if item.get("status") == "error"
    )
    return 1 if error_count == len(processed_holdings) + len(processed_watchlist) else 0


if __name__ == "__main__":
    sys.exit(main())
