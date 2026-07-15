"""Taiwan stock / ETF fetcher using yfinance.

Handles .TW (TWSE) and .TWO (TPEx) symbols. Returns a normalized dict that
the dashboard can render regardless of underlying data source.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import yfinance as yf

from ._fundamentals import fetch_recent_quarter_eps
from ._history import fetch_history


def _sanitize(value):
    """yfinance sometimes returns NaN / inf; JSON can't serialize those."""
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


def _tw_revenue_growth(symbol: str):
    """台股營收成長: FinMind 月營收 (anonymous, 無 token)。
    台股用「月營收」因它最即時(每月10號公布)、且 Yahoo revenueGrowth 對台股是混合/TTM
    會誤導 (feedback_yahoo_revenuegrowth_vs_monthly: 6/16 力智誤報+0%實際-9.6% / 大中+4%實際+22%)。
    回 dict(yoy/accel/mom/qoq/asof)：yoy=年增率、accel=本月YoY−上月YoY、
    mom=月增率(本月vs上月)、qoq=季增率=最近3個月合計vs前一輪3個月合計(滾動, Adam 2026-07-15:
    例 4/5/6 vs 1/2/3)。任何失敗皆 graceful 回全 None dict 不影響主 fetch。"""
    empty = {"yoy": None, "accel": None, "mom": None, "qoq": None, "asof": None}
    code = symbol.split(".")[0]
    try:
        import requests
        r = requests.get(
            "https://api.finmindtrade.com/api/v4/data",
            # 550 天 ≈ 18 個月：YoY 要去年同月(最遠 13 個月前)、滾動 QoQ 要 6 個月，全年任何月份都夠
            # (舊寫法 now().year-1 年初會缺去年同月, audit 2026-07-03 P3-19 的殘邊)
            params={"dataset": "TaiwanStockMonthRevenue", "data_id": code, "start_date": (datetime.now() - timedelta(days=550)).strftime("%Y-%m-01")},
            headers={"User-Agent": "Mozilla/5.0"}, timeout=20,
        )
        j = r.json()
        if j.get("msg") != "success":
            return empty
        hist = {(d["revenue_year"], d["revenue_month"]): d["revenue"] for d in j.get("data", [])}
        if not hist:
            return empty
        y, m = max(hist.keys())

        def _back(yy, mm, k):
            """k 個月前的 (年, 月)，跨年安全。"""
            idx = yy * 12 + (mm - 1) - k
            return idx // 12, idx % 12 + 1

        def _yoy(yy, mm):
            cur, prev = hist.get((yy, mm)), hist.get((yy - 1, mm))
            return None if (not cur or not prev) else (cur / prev - 1.0) * 100.0

        y0, y1 = _yoy(y, m), _yoy(*_back(y, m, 1))
        accel = (y0 - y1) if (y0 is not None and y1 is not None) else None

        cur, prev = hist.get((y, m)), hist.get(_back(y, m, 1))
        mom = (cur / prev - 1.0) * 100.0 if (cur and prev) else None

        # 滾動 3 月 QoQ：6 個月缺任一筆就回 None——寧可不顯示也不給部分合計的假數字
        six = [hist.get(_back(y, m, k)) for k in range(6)]
        qoq = (sum(six[:3]) / sum(six[3:]) - 1.0) * 100.0 if all(six) else None

        return {
            "yoy": round(y0, 1) if y0 is not None else None,
            "accel": round(accel, 1) if accel is not None else None,
            "mom": round(mom, 1) if mom is not None else None,
            "qoq": round(qoq, 1) if qoq is not None else None,
            "asof": f"{y}-{m:02d}",
        }
    except Exception:  # noqa: BLE001
        return empty


def fetch_tw_stock(symbol: str) -> dict:
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
    # yfinance returns yield as either a percentage (5.34) or decimal (0.0534)
    # depending on version. Normalize to percentage.
    if dividend_yield is not None and dividend_yield < 1:
        dividend_yield = dividend_yield * 100
    if dividend_yield is not None and dividend_yield > 25:
        # percentage-format `yield` fallback x100 protection - blank beats wrong (audit 2026-07-03 P2-6)
        dividend_yield = None

    tw_rev = _tw_revenue_growth(symbol)

    return {
        "symbol": symbol,
        "quote_type": info.get("quoteType"),
        "exchange": info.get("fullExchangeName") or info.get("exchange"),
        "currency": info.get("currency"),
        "price": price,
        "previous_close": prev_close,
        "change": _sanitize(change),
        "change_pct": _sanitize(change_pct),
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
        "forward_pe": _sanitize(info.get("forwardPE")),
        "target_mean_price": _sanitize(info.get("targetMeanPrice")),
        "target_high_price": _sanitize(info.get("targetHighPrice")),
        "target_low_price": _sanitize(info.get("targetLowPrice")),
        "num_analysts": _sanitize(info.get("numberOfAnalystOpinions")),
        "recommendation": info.get("recommendationKey"),
        "recommendation_mean": _sanitize(info.get("recommendationMean")),
        "eps": _sanitize(info.get("trailingEps")),  # 年EPS (TTM, 近四季加總)
        "eps_q": fetch_recent_quarter_eps(symbol),  # 季EPS (最近單季公布值; 台股 Yahoo 常無 → None)
        "gross_margins": _sanitize(info.get("grossMargins")),
        "rev_yoy_pct": tw_rev["yoy"],
        "rev_accel_pp": tw_rev["accel"],
        "rev_mom_pct": tw_rev["mom"],  # 月增率 (Adam 2026-07-15)
        "rev_qoq_pct": tw_rev["qoq"],  # 季增率: 滾動3月合計 vs 前3月合計 (Adam 2026-07-15)
        "rev_growth_period": "月" if tw_rev["yoy"] is not None else None,
        "rev_growth_asof": tw_rev["asof"],
        "expense_ratio": _sanitize(info.get("netExpenseRatio") or info.get("annualReportExpenseRatio")),
        "ytd_return_pct": _sanitize(info.get("ytdReturn")),
        "regular_market_time": _sanitize(info.get("regularMarketTime")),
        "market_state": info.get("marketState"),
        "long_name": info.get("longName") or info.get("shortName"),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "history": fetch_history(symbol),
    }
