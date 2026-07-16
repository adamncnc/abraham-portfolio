"""Shared price history fetcher.

Returns two series that the dashboard can use to render all scope options
(1D / 3D / 1W / 1M / 3M / 1Y / All):

- intraday: 5-minute interval for the most recent trading day
- daily:    daily closes since inception (capped at 10 years for JSON size)

Both series use the compact shape `[{t, c}]` — t is the ISO timestamp,
c is the close price — to keep the JSON payload small.
"""
from __future__ import annotations

import datetime
import math
from typing import Any

import yfinance as yf

# Daily-close fallback: only fall back from a *known* closed / extended session
# (allowlist — never REGULAR, never an unknown/garbage state) and only when the
# last daily bar IS the symbol's most recent traded session (proven by its own
# intraday series). A recency backstop rejects a grossly old (dead-feed) series.
_CLOSED_STATES = frozenset({"PRE", "PREPRE", "POST", "POSTPOST", "CLOSED"})
_MAX_STALE_DAYS = 4   # last bar older than this vs now -> stale feed, fail-closed


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
        # prepost=True includes pre-market + after-hours bars (US equities / futures);
        # symbols without extended sessions (e.g. TW stocks) just return regular bars.
        intraday_df = ticker.history(period="1d", interval="5m", auto_adjust=False, prepost=True)
    except Exception:
        intraday_df = None

    try:
        # 30-min bars over ~1 month: powers the 3d / 1w / 1M scopes with real intraday
        # detail. (Daily resolution made 3d look like 3-4 flat points — over-smoothed.)
        # Regular hours only (no prepost) to keep the multi-day curve clean.
        mid_df = ticker.history(period="1mo", interval="30m", auto_adjust=False)
    except Exception:
        mid_df = None

    try:
        daily_df = ticker.history(period="10y", interval="1d", auto_adjust=False)
    except Exception:
        daily_df = None

    return {
        "intraday": _serialize(intraday_df, "%Y-%m-%dT%H:%M"),
        "intraday_mid": _serialize(mid_df, "%Y-%m-%dT%H:%M"),
        "daily": _serialize(daily_df, "%Y-%m-%d"),
    }


def _bar_date(t) -> datetime.date | None:
    try:
        return datetime.datetime.strptime(str(t)[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def _latest_session_date(history: dict) -> datetime.date | None:
    """Newest traded-session date across the symbol's own intraday series (5-min +
    30-min, both from `fetch_history`). Takes the MAX so a stale short series can't
    mask a fresher one. This is the market telling us which session last traded —
    used to prove `daily[-1]` is that session and not an older bar left behind when
    today's daily close was NaN-dropped. None if no intraday data at all."""
    dates = []
    for key in ("intraday", "intraday_mid"):
        series = (history or {}).get(key) or []
        if series:
            d = _bar_date(series[-1].get("t"))
            if d is not None:
                dates.append(d)
    return max(dates) if dates else None


def resolve_price(live_price, live_prev, history: dict, market_state, now_utc=None):
    """Return (price, previous_close) with a fail-closed post-close daily-close fallback.

    Why this exists: yfinance's `regularMarketPrice` intermittently returns None
    **post-close** for some tickers — observed 2026-07-16 on the TPEx name 力智
    6719.TW after the 13:30 close (real close 244, confirmed via TWSE). The card
    then blanked / carried a stale intraday value. `daily` is already fetched for
    the chart, so the last completed close costs no extra network call.

    Design (hardened over three Codex audits, 2026-07-16). A daily bar is served as
    the current price ONLY when *proven* to be the most recent completed session:

    - Live quote present -> use it, paired with the caller's `live_prev`. A live
      price is NEVER mixed with a history prev (that can produce a misleading %).
    - Live quote None -> fall back to `daily[-1]` ONLY IF ALL hold: (a) market state
      is in the allowlist of known closed/extended sessions `_CLOSED_STATES` (never
      REGULAR, never an unknown/garbage value); (b) `daily[-1]`'s date is within
      `_MAX_STALE_DAYS` of now (rejects a dead feed); (c) that date equals the
      symbol's most recent traded session per its intraday series — so a
      NaN-dropped today-close (which would leave `daily[-1]` on an earlier date)
      fails this check. `previous_close` is returned None: adjacency of `daily[-2]`
      cannot be proven without a trading calendar, and a blank change beats a
      multi-day move shown as one day.
    - Anything unproven returns price None, so `carry_forward_stale` shows the last
      known-good price and flags it `stale` (the UI's existing, consumed freshness
      path). Fail-CLOSED: never emit an unverified "close". Scheduled dashboard runs
      are post-close with a known state + fresh intraday, so 力智 & co still fall
      back to their real close when they should.

    KNOWN LIMITATION (Adam 2026-07-16, ratified option B over 4 Codex audit rounds):
    the intraday-series check proves internal consistency, not an external "expected
    trading session". Two rare Yahoo-feed edges remain uncaught: (1) every series for
    a ticker commonly stalled one day back, and (2) a same-day-dated but not-yet-final
    daily bar (mitigated by the scheduled post-close buffer). Both degrade SAFELY —
    the shown price is at most a few days old, and never a live-quote failure blanking
    the card. Fully closing them needs a trading-calendar (exchange_calendars) +
    bar-completeness check; judged over-engineering for a rarely-triggered fallback.
    """
    if live_price is not None:
        return live_price, live_prev

    if str(market_state).upper() not in _CLOSED_STATES:
        return None, live_prev  # unknown / open / garbage state -> no partial bar

    daily = (history or {}).get("daily") or []
    last = daily[-1] if daily else None
    last_c = _sanitize_close(last.get("c")) if isinstance(last, dict) else None
    last_d = _bar_date(last.get("t")) if isinstance(last, dict) else None
    if last_c is None or last_d is None:
        return None, live_prev  # NaN / empty / undated last bar cannot be a close

    now = now_utc or datetime.datetime.now(datetime.timezone.utc).date()
    if hasattr(now, "date"):
        now = now.date()
    if not 0 <= (now - last_d).days <= _MAX_STALE_DAYS:
        return None, live_prev  # grossly old series (dead feed) -> carry_forward flags it

    if last_d != _latest_session_date(history):
        return None, live_prev  # today's daily close missing/NaN-dropped -> fail-closed

    return last_c, None
