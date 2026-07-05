"""Holdings ATR trailing-stop engine.

Reads config/holdings.json (Adam's real positions) and, for each holding,
computes the exit-side numbers from the 移動停利 method (肌肉書僮 video,
memory: reference_trailing_stop_exit_methodology):

  - current price + unrealized P/L
  - ATR(14) + ATR(20) from daily OHLC (Wilder's smoothing = what trading
    software shows)
  - highest-high-since-entry  (the 電梯 only goes up)
  - ratcheting trailing stop = highest_high - mult*ATR, made monotonic via a
    small state file so the stop can only ever move UP (棘輪效應)
  - distance to stop (in % and in ATRs of cushion) + a status light
  - scale-out (分批鎖利) flag once unrealized >= +50%
  - regime classification (飆/穩) → default ATR multiple (3x volatile / 2x steady)
  - Taiwan chip signals (主力買賣家數差 / 三大法人 / 融資) — Phase 2 stub

Writes docs/data/holdings.json for the dashboard's 4th tab ("即時持倉").

Self-contained + independently runnable — does NOT touch the main
fetch_prices.py → latest.json pipeline. Run it after fetch_prices.py in the
schedule, or standalone:

    python scripts/holdings_atr.py
    python scripts/holdings_atr.py --config config/holdings.json --out docs/data/holdings.json

An empty holdings list still writes a valid (empty) holdings.json so the tab
renders its "尚無持倉" guide instead of erroring.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent

# Regime threshold: mean 20-day daily amplitude (High-Low)/Close above this %
# counts as a 飆股 (volatile) and gets the wider 3x ATR buffer; below → 2x.
AMPLITUDE_VOLATILE_PCT = 4.0
MULT_VOLATILE = 3.0
MULT_STEADY = 2.0
SCALE_OUT_TRIGGER_PCT = 50.0  # 分批鎖利: flag once unrealized >= +50%


def _num(x, ndigits=2):
    """Round to a JSON-safe float, or None for NaN/inf/None."""
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, ndigits)


def _atr_series(df: pd.DataFrame, period: int) -> pd.Series:
    """Wilder's ATR (the classic / what most trading platforms display).

    True Range = max(H-L, |H-prevClose|, |L-prevClose|) — the |...prevClose|
    terms fold GAPS in (跳空), which the video calls out as the whole reason to
    prefer ATR over a plain moving average. Wilder smoothing = EWM alpha=1/n.
    """
    high, low, close = df["High"], df["Low"], df["Close"]
    prev_close = close.shift(1)
    tr = pd.concat(
        [(high - low), (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()


def compute_holding(item: dict, state: dict) -> dict:
    """Fetch daily OHLC and compute the full ATR / trailing-stop read for one holding."""
    out = dict(item)  # carry config fields (id/name/symbol/type/currency/shares/...)
    symbol = item.get("symbol")
    hid = item.get("id") or symbol

    if not symbol:
        out["status_fetch"] = "error"
        out["error"] = "missing symbol"
        return out

    try:
        ticker = yf.Ticker(symbol)
        # ~14 months of daily bars: enough for ATR(20) warm-up + since-entry high
        # for a position held up to a year. auto_adjust=False keeps raw OHLC.
        df = ticker.history(period="14mo", interval="1d", auto_adjust=False)
        if df is None or df.empty or len(df) < 20:
            out["status_fetch"] = "error"
            out["error"] = f"insufficient daily history ({0 if df is None else len(df)} bars)"
            return out
        df = df.dropna(subset=["High", "Low", "Close"])

        # --- current price: prefer live last price, fall back to last close ---
        price = None
        try:
            fi = ticker.fast_info
            price = fi.get("last_price") if hasattr(fi, "get") else getattr(fi, "last_price", None)
        except Exception:
            price = None
        last_close = float(df["Close"].iloc[-1])
        if price is None or (isinstance(price, float) and (math.isnan(price) or price <= 0)):
            price = last_close
        price = float(price)
        prev_close = float(df["Close"].iloc[-2])
        change_pct = (price - prev_close) / prev_close * 100 if prev_close else None

        # --- ATR(14) + ATR(20) ---
        atr14 = _atr_series(df, 14).iloc[-1]
        atr20 = _atr_series(df, 20).iloc[-1]
        atr14 = None if pd.isna(atr14) else float(atr14)
        atr20 = None if pd.isna(atr20) else float(atr20)

        # --- regime: mean 20-day amplitude % → default multiple ---
        amp = ((df["High"] - df["Low"]) / df["Close"]).tail(20).mean() * 100
        amp = None if pd.isna(amp) else float(amp)
        if item.get("atr_mult") is not None:
            mult = float(item["atr_mult"])
            regime = item.get("regime") or ("飆" if mult >= 2.5 else "穩")
        else:
            if amp is not None and amp > AMPLITUDE_VOLATILE_PCT:
                mult, regime = MULT_VOLATILE, "飆"
            else:
                mult, regime = MULT_STEADY, "穩"

        # --- which ATR period drives the stop (default 14, config override) ---
        period_used = int(item.get("atr_period") or 14)
        atr_used = atr14 if period_used == 14 else atr20
        if atr_used is None:
            atr_used = atr14 if atr14 is not None else atr20

        # --- highest high since entry (the ratchet's high-water mark) ---
        entry_date = item.get("entry_date")
        hh = None
        if entry_date:
            try:
                ed = pd.Timestamp(entry_date)
                if ed.tzinfo is None and df.index.tz is not None:
                    ed = ed.tz_localize(df.index.tz)
                since = df.loc[df.index >= ed, "High"]
                if not since.empty:
                    hh = float(since.max())
            except Exception:
                hh = None
        if hh is None:  # no entry date / parse fail → last 60 bars high
            hh = float(df["High"].tail(60).max())
        # a new high can't be below today's price
        hh = max(hh, price)

        # --- trailing stop = highest_high - mult*ATR, ratcheted monotonic up ---
        computed_stop = hh - mult * atr_used if atr_used is not None else None
        st = state.get(hid, {})
        prior_stop = st.get("ratchet_stop")
        if computed_stop is None:
            trailing_stop = prior_stop
        elif prior_stop is None:
            trailing_stop = computed_stop
        else:
            trailing_stop = max(computed_stop, float(prior_stop))  # 電梯只上不下
        state[hid] = {
            "ratchet_stop": trailing_stop,
            "peak_high": max(hh, float(st.get("peak_high") or 0)),
            "updated": datetime.now(timezone.utc).isoformat(),
        }

        # --- cushion + status light ---
        buffer_atr = dist_pct = status = status_label = None
        if trailing_stop is not None and atr_used:
            dist_pct = (price - trailing_stop) / price * 100
            buffer_atr = (price - trailing_stop) / atr_used
            if price <= trailing_stop:
                status, status_label = "hit", "🔴 跌破移動停損（該走）"
            elif buffer_atr <= 1.0:
                status, status_label = "near", "🟡 接近停損（剩 <1×ATR 緩衝）"
            else:
                status, status_label = "hold", "🟢 抱著（停損在下方）"

        # --- P/L ---
        shares = item.get("shares")
        cost = item.get("cost_basis")
        market_value = unrealized = unrealized_pct = None
        if shares and cost:
            market_value = shares * price
            unrealized = shares * (price - cost)
            unrealized_pct = (price - cost) / cost * 100 if cost else None

        # --- 分批鎖利 (+50%) ---
        scale_out_due = False
        scale_out_note = None
        if unrealized_pct is not None and unrealized_pct >= SCALE_OUT_TRIGGER_PCT and not item.get("half_locked"):
            scale_out_due = True
            scale_out_note = f"🎯 已 +{unrealized_pct:.0f}%，到分批鎖利點：可考慮先賣一半、把成本拿回來（保本），剩下當底倉續跑"

        out.update({
            "status_fetch": "ok",
            "price": _num(price),
            "prev_close": _num(prev_close),
            "change_pct": _num(change_pct, 2),
            "atr14": _num(atr14),
            "atr20": _num(atr20),
            "atr_period_used": period_used,
            "atr_used": _num(atr_used),
            "amplitude_pct_20d": _num(amp, 2),
            "regime": regime,
            "atr_mult": mult,
            "highest_high_since_entry": _num(hh),
            "trailing_stop": _num(trailing_stop),
            "stop_formula": f"最高價 {_num(hh)} − {mult}×ATR({period_used}) {_num(atr_used)}",
            "buffer_atr": _num(buffer_atr, 2),
            "dist_to_stop_pct": _num(dist_pct, 2),
            "status": status,
            "status_label": status_label,
            "market_value": _num(market_value),
            "unrealized_pnl": _num(unrealized),
            "unrealized_pnl_pct": _num(unrealized_pct, 2),
            "scale_out_due": scale_out_due,
            "scale_out_note": scale_out_note,
            "chip": None,  # Taiwan 主力買賣家數差 / 三大法人 / 融資 — Phase 2
            "atr_asof": df.index[-1].strftime("%Y-%m-%d"),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        })
        return out
    except Exception as exc:
        out["status_fetch"] = "error"
        out["error"] = f"{type(exc).__name__}: {exc}"
        out["traceback"] = traceback.format_exc()
        return out


def main() -> int:
    # Console summary prints emoji + Chinese status labels; Windows default cp1252
    # stdout would crash on them (and, after the file is already written, turn a
    # successful run into a non-zero exit that fools the scheduler). Force UTF-8.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "config" / "holdings.json"))
    ap.add_argument("--out", default=str(ROOT / "docs" / "data" / "holdings.json"))
    ap.add_argument("--state", default=str(ROOT / "data" / "holdings-atr-state.json"))
    args = ap.parse_args()

    cfg_path, out_path, state_path = Path(args.config), Path(args.out), Path(args.state)

    cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {"holdings": []}
    holdings_cfg = cfg.get("holdings", [])

    state = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            state = {}

    results = [compute_holding(item, state) for item in holdings_cfg]

    # summary totals by currency (P/L only meaningfully aggregates within a currency)
    summary = {"count": len(results), "pnl_by_currency": {}}
    for r in results:
        cur = r.get("currency") or "?"
        pnl = r.get("unrealized_pnl")
        if pnl is not None:
            summary["pnl_by_currency"].setdefault(cur, 0.0)
            summary["pnl_by_currency"][cur] += pnl
    summary["pnl_by_currency"] = {k: _num(v) for k, v in summary["pnl_by_currency"].items()}

    snapshot = {
        "schema_version": "1.0",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "method_source": "移動停利/ATR (肌肉書僮) — reference_trailing_stop_exit_methodology",
        "summary": summary,
        "holdings": results,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(snapshot, ensure_ascii=False, default=str, separators=(",", ":")),
        encoding="utf-8",
    )
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    print(f"Holdings ATR written: {out_path}  ({len(results)} holdings)")
    for r in results:
        mark = "OK " if r.get("status_fetch") == "ok" else "ERR"
        print(f"  [{mark}] {str(r.get('id')):14s} {str(r.get('symbol')):12s} "
              f"price={r.get('price')} stop={r.get('trailing_stop')} "
              f"{r.get('status_label') or r.get('error') or ''}")
    err = sum(1 for r in results if r.get("status_fetch") == "error")
    return 1 if results and err == len(results) else 0


if __name__ == "__main__":
    sys.exit(main())
