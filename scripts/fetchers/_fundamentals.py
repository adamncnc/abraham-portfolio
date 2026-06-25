"""Shared fundamentals helper — most recent single-quarter reported EPS.

The dashboard shows two EPS figures so they're not confused after an earnings
report (the confusion that prompted this: Micron reported a single-quarter EPS
of 25.11 while the dashboard's trailing field still read 21.14):

- 年EPS  (the existing ``eps`` field) = Yahoo ``trailingEps`` = trailing twelve
  months, i.e. the sum of the last four quarters. Lags an earnings report by
  hours-to-days because Yahoo recomputes the fundamental field after the print.
- 季EPS  (this helper's ``eps_q``)     = the most recent *single quarter*
  reported EPS — the headline number compared against the analyst estimate
  (the beat/miss figure), populated the moment a company reports.

Source = ``Ticker.earnings_history`` ("epsActual" column), a JSON API that does
NOT require lxml and carries the fresh number immediately on the print — unlike
``trailingEps`` and ``quarterly_income_stmt``, which only pick the quarter up
once Yahoo recomputes/files days later. Coverage is good for US large caps and
spotty for .TW / .TWO symbols, so every failure path degrades to ``None`` (the
dashboard renders ─ rather than a wrong number).
"""
from __future__ import annotations

import math


def _clean(value):
    if value is None:
        return None
    try:
        fvalue = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(fvalue) or math.isinf(fvalue):
        return None
    return fvalue


def fetch_recent_quarter_eps(symbol: str):
    """Return the most recent *reported* single-quarter EPS, or None.

    Reads ``Ticker.earnings_history`` — the per-quarter actual reported EPS that
    Yahoo compares against the analyst estimate (the headline beat/miss figure).
    Returns the latest quarter's ``epsActual``. Any failure (network flakiness,
    missing column, symbol without earnings history — common for .TW / .TWO) →
    None, so the caller/dashboard falls back to ─ instead of a wrong figure.
    """
    import yfinance as yf

    ticker = yf.Ticker(symbol)
    df = None
    try:
        df = ticker.get_earnings_history()
    except Exception:  # noqa: BLE001 — yfinance network / parsing flakiness
        try:
            df = ticker.earnings_history
        except Exception:  # noqa: BLE001
            df = None
    if df is None or getattr(df, "empty", True):
        return None

    col = next((c for c in ("epsActual", "epsactual", "EPS Actual") if c in df.columns), None)
    if col is None:
        return None

    # earnings_history is indexed by quarter date (YYYY-MM-DD, ascending) — the
    # last non-null epsActual is the most recently reported quarter.
    try:
        series = df[col].dropna()
        if series.empty:
            return None
        try:
            series = series.sort_index()
        except Exception:  # noqa: BLE001 — non-sortable index, keep original order
            pass
        val = _clean(series.iloc[-1])
        return round(val, 4) if val is not None else None
    except Exception:  # noqa: BLE001
        return None
