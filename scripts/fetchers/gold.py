"""Gold fetcher.

Default: COMEX gold futures (GC=F) via yfinance, which is the most liquid
benchmark for USD/oz. Returns a normalized dict with the same shape as
the stock fetchers so the dashboard can render uniformly.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

import yfinance as yf


def _sanitize(value):
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


def fetch_gold(symbol: str = "GC=F") -> dict:
    ticker = yf.Ticker(symbol)
    info = ticker.info or {}

    price = _sanitize(info.get("regularMarketPrice") or info.get("bid") or info.get("previousClose"))
    prev_close = _sanitize(info.get("regularMarketPreviousClose") or info.get("previousClose"))

    change = None
    change_pct = None
    if price is not None and prev_close is not None:
        change = price - prev_close
        if prev_close != 0:
            change_pct = (change / prev_close) * 100

    fifty_two_high = _sanitize(info.get("fiftyTwoWeekHigh"))
    fifty_two_low = _sanitize(info.get("fiftyTwoWeekLow"))
    dist_from_high_pct = None
    dist_from_low_pct = None
    if price is not None and fifty_two_high:
        dist_from_high_pct = ((price - fifty_two_high) / fifty_two_high) * 100
    if price is not None and fifty_two_low:
        dist_from_low_pct = ((price - fifty_two_low) / fifty_two_low) * 100

    return {
        "symbol": symbol,
        "quote_type": "FUTURE",
        "exchange": info.get("fullExchangeName") or "COMEX",
        "currency": info.get("currency") or "USD",
        "price": price,
        "previous_close": prev_close,
        "change": _sanitize(change),
        "change_pct": _sanitize(change_pct),
        "day_low": _sanitize(info.get("regularMarketDayLow")),
        "day_high": _sanitize(info.get("regularMarketDayHigh")),
        "fifty_two_week_high": fifty_two_high,
        "fifty_two_week_low": fifty_two_low,
        "dist_from_high_pct": _sanitize(dist_from_high_pct),
        "dist_from_low_pct": _sanitize(dist_from_low_pct),
        "fifty_day_avg": _sanitize(info.get("fiftyDayAverage")),
        "two_hundred_day_avg": _sanitize(info.get("twoHundredDayAverage")),
        "regular_market_time": _sanitize(info.get("regularMarketTime")),
        "market_state": info.get("marketState"),
        "long_name": info.get("longName") or info.get("shortName") or "Gold Futures",
        "unit": "USD per troy ounce",
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
