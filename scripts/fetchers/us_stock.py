"""US stock / ETF fetcher using yfinance.

Adds pre / post-market data fields since US equities trade extended hours.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

import yfinance as yf

from ._fundamentals import fetch_quarterly_revenue_qoq, fetch_recent_quarter_eps
from ._history import fetch_history, resolve_price


def _sanitize(value):
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


def fetch_us_stock(symbol: str) -> dict:
    ticker = yf.Ticker(symbol)
    info = ticker.info or {}
    history = fetch_history(symbol)  # fetched once; reused for the close-fallback + output
    market_state = info.get("marketState")

    # Same proven-completed-close fallback as the TW fetcher (see _history.py): when
    # the live quote is None, use the last daily close only if the state is a known
    # non-REGULAR session and the bar is recent; otherwise stay None (carry_forward).
    price, prev_close = resolve_price(
        _sanitize(info.get("regularMarketPrice")),
        _sanitize(info.get("regularMarketPreviousClose") or info.get("previousClose")),
        history, market_state,
    )

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
    if dividend_yield is not None and dividend_yield > 25:
        # the `yield` fallback can be percentage-format (0.4 = 0.4%) -> x100 turns it into 40%;
        # no sane yield exceeds 25 -> blank beats wrong (audit 2026-07-03 P2-6)
        dividend_yield = None

    # 營收成長率(季 YoY) — US 用 Yahoo revenueGrowth (對美股 reliable, 與季報計算吻合;
    # 注意: 對台股會誤導故台股改走 FinMind 月營收, 見 feedback_yahoo_revenuegrowth_vs_monthly)。
    # 加速度需 YoY-of-YoY(~8 季), Yahoo 只回溯 5 季算不出 → US 標 None(不顯示)。
    _rg = _sanitize(info.get("revenueGrowth"))
    rev_yoy_pct = round(_rg * 100, 1) if _rg is not None else None

    # 空單比例 (Adam 2026-07-23): FINRA 雙週申報經 Yahoo 轉載 — 佔流通股比例。
    # dateShortInterest=申報基準日 (落後約兩週屬資料本質, as-of 必隨數字顯示)。
    # ETF/指數通常無此數據 → None, 前端誠實隱藏。
    _spf = _sanitize(info.get("shortPercentOfFloat"))
    _short_ts = _sanitize(info.get("dateShortInterest"))
    short_asof = None
    if _short_ts:
        try:
            short_asof = datetime.fromtimestamp(_short_ts, tz=timezone.utc).strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001
            short_asof = None

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
        "short_pct": round(_spf * 100, 2) if _spf is not None else None,
        "short_days_to_cover": _sanitize(info.get("shortRatio")),
        "short_shares": _sanitize(info.get("sharesShort")),
        "short_shares_prior": _sanitize(info.get("sharesShortPriorMonth")),
        "short_asof": short_asof,
        "short_basis": "float" if _spf is not None else None,
        "net_assets": net_assets,
        "dividend_yield_pct": _sanitize(dividend_yield),
        "trailing_pe": _sanitize(info.get("trailingPE")),
        "forward_pe": _sanitize(info.get("forwardPE")),
        "target_mean_price": _sanitize(info.get("targetMeanPrice")),
        "target_high_price": _sanitize(info.get("targetHighPrice")),
        "target_low_price": _sanitize(info.get("targetLowPrice")),
        "num_analysts": _sanitize(info.get("numberOfAnalystOpinions")),
        "recommendation": info.get("recommendationKey"),
        "recommendation_mean": _sanitize(info.get("recommendationMean")),
        "eps": _sanitize(info.get("trailingEps")),  # 年EPS (TTM, 近四季加總)
        "eps_q": fetch_recent_quarter_eps(symbol),  # 季EPS (最近單季公布值, beat/miss 頭條那個)
        "gross_margins": _sanitize(info.get("grossMargins")),
        "rev_yoy_pct": rev_yoy_pct,
        "rev_accel_pp": None,
        "rev_mom_pct": None,  # 美股無月營收, 月增率不適用 (Adam 2026-07-15)
        "rev_qoq_pct": fetch_quarterly_revenue_qoq(symbol),  # 季增率: 最新季 vs 前季 (Adam 2026-07-15)
        "rev_growth_period": "季" if rev_yoy_pct is not None else None,
        "expense_ratio": _sanitize(info.get("netExpenseRatio") or info.get("annualReportExpenseRatio")),
        "ytd_return_pct": _sanitize(info.get("ytdReturn")),
        "regular_market_time": _sanitize(info.get("regularMarketTime")),
        "market_state": market_state,
        "long_name": info.get("longName") or info.get("shortName"),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "history": history,
    }
