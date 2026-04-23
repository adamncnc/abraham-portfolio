"""US stock / ETF fetcher using yfinance.

Adds pre / post-market data fields since US equities trade extended hours.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

import yfinance as yf

from ._history import fetch_history


def _sanitize(value):
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


def fetch_us_stock(symbol: str) -> dict:
    ticker = yf.Ticker(symbol)
    info = ticker.info or {}

    price = _sanitize(info.get("regularMarketPrice"))
    prev_close = _sanitize(info.get("regularMarketPreviousClose") or info.get("previousClose"))

    change = None
    change_pct = None
    if price is not None and prev_close is not None:
        change = price - prev_close
        if prev_close != 0:
            change_pct = (change / prev_close) * 100

    pre_price = _sanitize(info.get("preMarketPrice"))
    pre_change_pct = _sanitize(info.get("preMarketChangePercent"))
    post_price = _sanitize(info.get("postMarketPrice"))
    post_change_pct = _sanitize(info.get("postMarketChangePercent"))

    nav = _sanitize(info.get("navPrice"))
    premium_pct = None
    if price is not None and nav is not None and nav != 0:
        premium_pct = ((price - nav) / nav) * 100

    fifty_two_high = _sanitize(info.get("fiftyTwoWeekHigh"))
    fifty_two_low = _sanitize(info.get("fiftyTwoWeekLow"))
    dist_from_high_pct = None
    dist_from_low_pct = None
    if price is not None and fifty_two_high:
        dist_from_high_pct = ((price - fifty_two_high) / fifty_two_high) * 100
    if price is not None and fifty_two_low:
        dist_from_low_pct = ((price - fifty_two_low) / fifty_two_low) * 100

    net_assets = _sanitize(info.get("totalAssets") or info.get("netAssets"))
    dividend_yield = _sanitize(info.get("dividendYield") or info.get("yield"))
    if dividend_yield is not None and dividend_yield < 1:
        dividend_yield = dividend_yield * 100

    return {
        "symbol": symbol,
        "quote_type": info.get("quoteType"),
        "exchange": info.get("fullExchangeName") or info.get("exchange"),
        "currency": info.get("currency"),
        "price": price,
        "previous_close": prev_close,
        "change": _sanitize(change),
        "change_pct": _sanitize(change_pct),
        "pre_market_price": pre_price,
        "pre_market_change_pct": pre_change_pct,
        "post_market_price": post_price,
        "post_market_change_pct": post_change_pct,
        "day_low": _sanitize(info.get("regularMarketDayLow")),
        "day_high": _sanitize(info.get("regularMarketDayHigh")),
        "nav": nav,
        "premium_pct": _sanitize(premium_pct),
        "fifty_two_week_high": fifty_two_high,
        "fifty_two_week_low": fifty_two_low,
        "dist_from_high_pct": _sanitize(dist_from_high_pct),
        "dist_from_low_pct": _sanitize(dist_from_low_pct),
        "fifty_day_avg": _sanitize(info.get("fiftyDayAverage")),
        "two_hundred_day_avg": _sanitize(info.get("twoHundredDayAverage")),
        "volume": _sanitize(info.get("regularMarketVolume")),
        "average_volume": _sanitize(info.get("averageVolume")),
        "net_assets": net_assets,
        "dividend_yield_pct": _sanitize(dividend_yield),
        "trailing_pe": _sanitize(info.get("trailingPE")),
        "expense_ratio": _sanitize(info.get("netExpenseRatio") or info.get("annualReportExpenseRatio")),
        "ytd_return_pct": _sanitize(info.get("ytdReturn")),
        "regular_market_time": _sanitize(info.get("regularMarketTime")),
        "market_state": info.get("marketState"),
        "long_name": info.get("longName") or info.get("shortName"),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "history": fetch_history(symbol),
    }
