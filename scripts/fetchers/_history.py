"""Shared price history fetcher.

Returns two series that the dashboard can use to render all scope options
(1D / 3D / 1W / 1M / 3M / 1Y / All):

- intraday: 5-minute interval for the most recent trading day
- daily:    daily closes since inception (capped at 10 years for JSON size)

Both series use the compact shape `[{t, c}]` — t is the ISO timestamp,
c is the close price — to keep the JSON payload small.
"""
from __future__ import annotations

import math
from typing import Any

import yfinance as yf


def _sanitize_close(value: Any) -> float | None:
    if value is None:
        return None
    try:
        fvalue = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(fvalue) or math.isinf(fvalue):
        return None
    return round(fvalue, 4)


def _serialize(df, ts_format: str) -> list[dict]:
    if df is None or df.empty:
        return []
    out: list[dict] = []
    for ts, row in df.iterrows():
        close = _sanitize_close(row.get("Close"))
        if close is None:
            continue
        try:
            t = ts.strftime(ts_format)
        except Exception:
            t = str(ts)
        out.append({"t": t, "c": close})
    return out


def fetch_history(symbol: str) -> dict:
    """Fetch intraday + daily close series for a symbol.

    Resilient: if either fetch fails (e.g., newly listed symbol without
    history, intraday disabled outside market hours), the respective list
    is returned empty instead of raising. The dashboard tolerates empties.
    """
    ticker = yf.Ticker(symbol)

    try:
        intraday_df = ticker.history(period="1d", interval="5m", auto_adjust=False)
    except Exception:
        intraday_df = None

    try:
        daily_df = ticker.history(period="10y", interval="1d", auto_adjust=False)
    except Exception:
        daily_df = None

    return {
        "intraday": _serialize(intraday_df, "%Y-%m-%dT%H:%M"),
        "daily": _serialize(daily_df, "%Y-%m-%d"),
    }
