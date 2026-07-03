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
import time
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


def process_item(item: dict, retries: int = 2) -> dict:
    item_type = item.get("type")
    symbol = item.get("symbol")
    if not item_type or not symbol:
        item["status"] = "error"
        item["error"] = "Missing type or symbol"
        return item

    # yfinance intermittently rate-limits / returns empty; a couple of retries with
    # backoff turns most transient failures into a clean fetch (2026-06-30).
    last_exc = None
    last_tb = ""
    for attempt in range(retries + 1):
        try:
            item["data"] = fetch_by_type(item_type, symbol)
            item["status"] = "ok"
            item.pop("error", None)
            item.pop("traceback", None)
            return item
        except Exception as exc:
            last_exc = exc
            last_tb = traceback.format_exc()
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))

    item["status"] = "error"
    item["error"] = f"{type(last_exc).__name__}: {last_exc}"
    item["traceback"] = last_tb
    item["data"] = None
    return item


def load_prev_by_id(latest_path: Path) -> dict:
    """Index the previous snapshot by item id, for last-known-good carry-forward."""
    if not latest_path.exists():
        return {}
    try:
        prev = json.loads(latest_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    by_id = {}
    for sec in ("holdings", "watchlist", "indices"):
        for it in prev.get(sec, []):
            if it.get("id"):
                by_id[it["id"]] = it
    return by_id


def carry_forward_stale(items: list, prev_by_id: dict) -> int:
    """For items that failed this run (status=error, or status ok but price is None),
    reuse the previous snapshot's data marked stale, so a transient fetch failure
    shows the last-known-good price instead of blanking the card. Returns count carried.

    Matching is by stable `id` (never resurrects a symbol removed from config, since
    we only iterate this run's items)."""
    carried = 0
    for item in items:
        data = item.get("data") or {}
        failed = item.get("status") == "error" or data.get("price") is None
        if not failed:
            continue
        prev = prev_by_id.get(item.get("id"))
        prev_data = (prev or {}).get("data") or {}
        if prev_data.get("price") is None:
            continue  # nothing good to carry forward
        new_data = dict(prev_data)
        new_data["stale"] = True
        # Preserve the ORIGINAL good timestamp even across repeated failures.
        new_data["stale_since"] = prev_data.get("fetched_at") or new_data.get("stale_since")
        new_data["stale_error"] = item.get("error") or "price unavailable this run"
        item["data"] = new_data
        item["status"] = "ok"   # render the carried price, not the error card
        item["stale"] = True
        item.pop("error", None)
        item.pop("traceback", None)
        carried += 1
    return carried


def main() -> int:
    holdings_cfg = load_config(ROOT / "config" / "holdings.json")
    watchlist_cfg = load_config(ROOT / "config" / "watchlist.json")
    # indices.json is optional (bottom 大盤指數 section); tolerate its absence.
    indices_path = ROOT / "config" / "indices.json"
    indices_cfg = load_config(indices_path) if indices_path.exists() else {"indices": []}

    holdings = [dict(item, _section="holdings") for item in holdings_cfg.get("holdings", [])]
    watchlist = [dict(item, _section="watchlist") for item in watchlist_cfg.get("watchlist", [])]
    indices = [dict(item, _section="indices") for item in indices_cfg.get("indices", [])]

    processed_holdings = [process_item(item) for item in holdings]
    processed_watchlist = [process_item(item) for item in watchlist]
    processed_indices = [process_item(item) for item in indices]
    # internal routing tag - never serialize it into latest.json / snapshots (audit 2026-07-03 P3-4)
    for _lst in (processed_holdings, processed_watchlist, processed_indices):
        for _it in _lst:
            _it.pop("_section", None)

    # Last-known-good carry-forward (2026-06-30): a transient per-item fetch failure
    # should show the previous good price marked "stale", not blank the card.
    prev_by_id = load_prev_by_id(ROOT / "docs" / "data" / "latest.json")
    carried = (
        carry_forward_stale(processed_holdings, prev_by_id)
        + carry_forward_stale(processed_watchlist, prev_by_id)
        + carry_forward_stale(processed_indices, prev_by_id)
    )

    # Enrich holdings AFTER carry-forward so position metrics use the shown price.
    processed_holdings = [enrich_holding(item) for item in processed_holdings]

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
            "indices_count": len(processed_indices),
        },
        "holdings": processed_holdings,
        "watchlist": processed_watchlist,
        "indices": processed_indices,
    }

    docs_data_dir = ROOT / "docs" / "data"
    docs_data_dir.mkdir(parents=True, exist_ok=True)
    latest_path = docs_data_dir / "latest.json"
    # latest.json is what the browser downloads on every load — write it COMPACT
    # (no indentation) to cut payload size / parse time. The dated snapshot below
    # stays indented for human/debug readability.
    latest_path.write_text(
        json.dumps(snapshot, ensure_ascii=False, default=str, separators=(",", ":")),
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
    if carried:
        print(f"Carried-forward stale (last-known-good): {carried}")
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
    print()
    print(f"Indices ({len(processed_indices)}):")
    for item in processed_indices:
        status = item.get("status")
        price = (item.get("data") or {}).get("price")
        marker = "OK" if status == "ok" else "ERR"
        print(f"  [{marker}] {item.get('id'):20s} {item.get('symbol'):12s} price={price}")

    all_items = processed_holdings + processed_watchlist + processed_indices
    error_count = sum(1 for item in all_items if item.get("status") == "error")
    return 1 if all_items and error_count == len(all_items) else 0


if __name__ == "__main__":
    sys.exit(main())
