"""Regression tests for the post-close price fallback (2026-07-16).

Bug: yfinance's `regularMarketPrice` intermittently returns None after the close
for some tickers (observed on TPEx name 力智 6719.TW after 13:30). The dashboard
then showed a blank/stale card. Fix: `resolve_price` serves the last daily close
as the current price ONLY when proven — a known closed/extended market state
(allowlist), a recent bar, AND that bar's date equals the symbol's most recent
traded session (per its own intraday series, so a NaN-dropped today-close is
caught). Otherwise price stays None and the existing `carry_forward_stale` shows
the last known-good price flagged stale.

Tests exercise the REAL `resolve_price` (deterministic now_utc) + one integration
path through the real `fetch_tw_stock`. Run: `python tests/test_close_fallback.py`
"""
import datetime
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

_fake_yf = types.ModuleType("yfinance")
_fake_yf.Ticker = lambda *a, **k: types.SimpleNamespace(info={}, history=lambda *a, **k: None)
sys.modules.setdefault("yfinance", _fake_yf)

from fetchers._history import _CLOSED_STATES, resolve_price  # noqa: E402

_NOW = datetime.date(2026, 7, 16)
_HIST = {
    "daily": [{"t": "2026-07-14", "c": 248.0}, {"t": "2026-07-15", "c": 246.0},
              {"t": "2026-07-16", "c": 244.0}],
    "intraday": [{"t": "2026-07-16T13:00", "c": 243.0}, {"t": "2026-07-16T13:20", "c": 244.0}],
}

# ---------- live-quote paths ----------

def test_live_quote_used_with_live_prev():
    assert resolve_price(110.0, 100.0, _HIST, "CLOSED", _NOW) == (110.0, 100.0)


def test_live_price_never_paired_with_history_prev():
    assert resolve_price(110.0, None, _HIST, "CLOSED", _NOW) == (110.0, None)


# ---------- fallback fires only when proven ----------

def test_fallback_fires_post_close_prev_none():
    # 力智 case: live None, CLOSED, bar == intraday session, recent -> real close, prev None
    assert resolve_price(None, None, _HIST, "CLOSED", _NOW) == (244.0, None)


def test_all_closed_states_fire():
    for st in _CLOSED_STATES:
        assert resolve_price(None, None, _HIST, st, _NOW) == (244.0, None), st


# ---------- P2b: state allowlist (deny everything not explicitly closed) ----------

def test_regular_and_unknown_states_fail_closed():
    assert resolve_price(None, 9.0, _HIST, "REGULAR", _NOW) == (None, 9.0)
    assert resolve_price(None, None, _HIST, None, _NOW) == (None, None)
    assert resolve_price(None, None, _HIST, "", _NOW) == (None, None)
    assert resolve_price(None, None, _HIST, "UNKNOWN", _NOW) == (None, None)   # garbage/new enum
    assert resolve_price(None, None, _HIST, "POSTPOST ", _NOW) == (None, None)  # not exact


# ---------- P2a: prove daily[-1] IS the latest traded session ----------

def test_nan_dropped_today_bar_fails_closed():
    # today's (7/16) daily close was NaN -> _serialize dropped it -> daily[-1] is 7/15,
    # but intraday shows 7/16 traded -> mismatch -> fail-closed (not silently served)
    h = {"daily": [{"t": "2026-07-14", "c": 248.0}, {"t": "2026-07-15", "c": 246.0}],
         "intraday": [{"t": "2026-07-16T13:20", "c": 244.0}]}
    assert resolve_price(None, None, h, "CLOSED", _NOW) == (None, None)


def test_no_intraday_cannot_prove_session_fail_closed():
    h = {"daily": _HIST["daily"], "intraday": [], "intraday_mid": []}
    assert resolve_price(None, None, h, "CLOSED", _NOW) == (None, None)


def test_intraday_mid_used_when_intraday_empty():
    h = {"daily": _HIST["daily"], "intraday": [],
         "intraday_mid": [{"t": "2026-07-16T13:00", "c": 243.0}]}
    assert resolve_price(None, None, h, "CLOSED", _NOW) == (244.0, None)


def test_latest_session_takes_max_not_first():
    # a stale 5-min series must NOT mask a fresher 30-min one: max(7/15, 7/16) = 7/16
    h = {"daily": _HIST["daily"],
         "intraday": [{"t": "2026-07-15T13:20", "c": 246.0}],       # stale short series
         "intraday_mid": [{"t": "2026-07-16T13:00", "c": 243.0}]}   # fresh -> proves 7/16
    assert resolve_price(None, None, h, "CLOSED", _NOW) == (244.0, None)


# ---------- other guards ----------

def test_recency_guard_rejects_dead_feed():
    stale = {"daily": [{"t": "2026-01-01", "c": 200.0}],
             "intraday": [{"t": "2026-01-01T13:00", "c": 200.0}]}
    assert resolve_price(None, None, stale, "CLOSED", _NOW) == (None, None)


def test_nan_last_daily_bar_fails_closed():
    h = {"daily": [{"t": "2026-07-15", "c": 246.0}, {"t": "2026-07-16", "c": float("nan")}],
         "intraday": [{"t": "2026-07-16T13:20", "c": 244.0}]}
    assert resolve_price(None, None, h, "CLOSED", _NOW) == (None, None)


def test_empty_and_missing_history_fail_closed():
    assert resolve_price(None, 5.0, {"daily": []}, "CLOSED", _NOW) == (None, 5.0)
    assert resolve_price(None, None, {}, "CLOSED", _NOW) == (None, None)
    assert resolve_price(None, None, None, "CLOSED", _NOW) == (None, None)


# ---------- integration: real fetch_tw_stock, no dead metadata ----------

def test_fetch_tw_stock_integration():
    import fetchers.tw_stock as tw

    today = datetime.datetime.now(datetime.timezone.utc).date()
    hist = {"daily": [{"t": (today - datetime.timedelta(days=1)).isoformat(), "c": 246.0},
                      {"t": today.isoformat(), "c": 244.0}],
            "intraday": [{"t": today.isoformat() + "T13:20", "c": 244.0}]}
    calls = {"history": 0}

    def _fake_history(symbol):
        calls["history"] += 1
        return hist

    class _FakeTicker:
        def __init__(self, sym):
            self.info = {"regularMarketPrice": None, "previousClose": None,
                         "marketState": "CLOSED", "quoteType": "EQUITY"}

    orig = (tw.fetch_history, tw.yf.Ticker, tw.fetch_recent_quarter_eps, tw._tw_revenue_growth)
    tw.fetch_history = _fake_history
    tw.yf.Ticker = _FakeTicker
    tw.fetch_recent_quarter_eps = lambda s: None
    tw._tw_revenue_growth = lambda s: {"yoy": None, "accel": None, "mom": None, "qoq": None, "asof": None}
    try:
        out = tw.fetch_tw_stock("6719.TW")
    finally:
        tw.fetch_history, tw.yf.Ticker, tw.fetch_recent_quarter_eps, tw._tw_revenue_growth = orig

    assert out["price"] == 244.0
    assert out["previous_close"] is None          # prev not paired on fallback
    assert out["change_pct"] is None              # -> no misleading % shown
    assert calls["history"] == 1                   # fetched once, reused
    assert out["history"] is hist
    assert "price_source" not in out and "price_asof" not in out


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"[PASS] {fn.__name__}")
    print(f"ALL {len(fns)} TESTS PASSED")
