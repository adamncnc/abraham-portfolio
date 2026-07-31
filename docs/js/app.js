// Abraham Portfolio Dashboard — data-driven renderer
// Reads ./data/latest.json and renders holdings + watchlist dynamically.
// Adding/removing items in config/*.json is all that's needed to change tracked set.

const DATA_URL = "./data/latest.json";
// 即時持倉 + ATR 移動停利分頁 (Adam 2026-07-06) — separate small file written by
// scripts/holdings_atr.py; fetched independently so a holdings error never breaks
// the main 3 market tabs.
const HOLDINGS_URL = "./data/holdings.json";
// 模擬倉分頁 (Adam 2026-07-13) — 虛擬 100 萬 TWD 實驗帳本. Written locally by
// ~/Abraham/abraham-portfolio-sync.py from ~/Abraham/sim-portfolio/ and committed;
// fetched independently (same isolation pattern as holdings.json).
// 六本模擬倉 (Adam 2026-07-13 22:17): 台股/美股 × 策略1/2/3，各虛擬 100 萬、互不調度。
// 策略1=我看好的名單 × 進場帶紀律；策略2=全市場 × 純技術；策略3=我看好的名單 × 純技術。
// 台股/美股拆開的理由：相對強度是「贏過自己市場」，兩市場指數強弱不同 → 不可同榜排序。
// key 同時是 DOM id 前綴 (panel-sim3 / sim3-positions / chart-sim3-nav / tab-count-sim3).
const SIM_BOOKS = [
  { key: "sim-tw-1", url: "./data/sim-tw-1.json" },
  { key: "sim-tw-2", url: "./data/sim-tw-2.json" },
  { key: "sim-tw-3", url: "./data/sim-tw-3.json" },
  { key: "sim-us-1", url: "./data/sim-us-1.json" },
  { key: "sim-us-2", url: "./data/sim-us-2.json" },
  { key: "sim-us-3", url: "./data/sim-us-3.json" },
];

// Live-quote relay (Cloudflare Worker — see relay/yahoo-relay-worker.js).
// Set to your workers.dev URL to enable the 抓即時 button's live fetch.
// Empty => 抓即時 falls back to reloading the snapshot file.
const RELAY_BASE = "https://abraham-quotes.adamncnc.workers.dev";
// Cloud settings sync (Adam 2026-07-01): same Worker, /prefs route backed by KV.
// Syncs ONLY UI layout prefs (pin / custom order / sort mode / active tab) so every
// device shows the same layout. Degrades to local-only if the relay/KV isn't set up.
const PREFS_URL = RELAY_BASE ? RELAY_BASE.replace(/\/+$/, "") + "/prefs" : "";
const PREFS_SECRET = "abr-dash-7c3f9a";   // low-stakes anti-grief token; must match the Worker
let PREFS_SYNCING = true;                  // suppress uploads during initial load / cloud-apply
let _prefsPushTimer = null;
let CURRENT_SNAPSHOT = null;
let HOLDINGS_SNAP = null;   // base 即時持倉 data from holdings.json; live ticks recompute 距停損 off this (never mutated)
const SIM_SNAPS = {};       // 模擬倉 data keyed by book key (sim/sim2); re-rendered after each live tick so 現價 join stays fresh
let LIVE_MODE = false;  // set true after a successful live pull; scheduler resets it to false off-hours so auto-refresh reverts to snapshot mode
let REFRESH_INFLIGHT = false;  // guards liveRefresh / refreshOneCard against overlap (auto-refresh + manual)
// Relay caps each request's symbol count, so one request for the whole list silently
// drops the tail. Chunk well under the cap and merge so every symbol gets a quote.
const LIVE_BATCH_SIZE = 30;

const DEFAULT_SCOPE = "1d";
const SCOPES = [
  { key: "1d", label: "1d" },
  { key: "3d", label: "3d" },
  { key: "1w", label: "1w" },
  { key: "1m", label: "1M" },
  { key: "3m", label: "3M" },
  { key: "6m", label: "6M" },
  { key: "1y", label: "1y" },
  { key: "2y", label: "2y" },
  { key: "5y", label: "5y" },
  { key: "all", label: "All" },
];
// Days to slice from daily series. 1d is handled separately (uses intraday).
const SCOPE_DAYS = { "3d": 3, "1w": 7, "1m": 30, "3m": 90, "6m": 180, "1y": 365, "2y": 730, "5y": 1825 };

// Active Chart.js instances keyed by canvas id so we can destroy them before
// recreating (auto-refresh every 1 min, scope changes).
const CHART_INSTANCES = new Map();
// Cache each card's history payload by canvas id so scope toggles don't need
// to re-fetch. Populated during initializeCharts().
const CARD_HISTORY = new Map();
// Entry-zone (進場區) per canvas id: { lo, hi }. Drawn as overlay lines on the
// trend chart so Adam sees current price vs the pre-set 進場上限/下限.
const CARD_META = new Map();
// 圖上覆蓋層擇一顯示 (Adam 2026-07-23): 每卡 'sr'(支撐壓力, 預設) 或 'zone'(進場區金線),
// 兩組線同畫會混淆。CARD_OVERLAY 只存使用者點過的選擇; 沒點過走 overlayModeFor 預設.
const CARD_OVERLAY = new Map();
function overlayModeFor(canvasId) {
  const m = CARD_META.get(canvasId) || {};
  const srHas = !!(m.sr && ((m.sr.supports && m.sr.supports.length) || (m.sr.resistances && m.sr.resistances.length)));
  const zoneHas = m.hi != null;
  const saved = CARD_OVERLAY.get(canvasId);
  if (saved === "zone" && zoneHas) return "zone";
  if (saved === "sr" && srHas) return "sr";
  return srHas || !zoneHas ? "sr" : "zone";
}
// Which MARKET tab (tw/us/idx) the summary cards follow (Adam 2026-07-22: 進場區內/
// 回檔排行榜 跟著分頁走 — 台股分頁只看台股). Sim/pos tabs keep the last market view.
let ACTIVE_MARKET_TAB = "tw";
const MARKET_TAB_LABEL = { tw: "🇹🇼 台股", us: "🇺🇸 美股", idx: "📊 指數" };
// Search index over all market-tab cards: [{id, name, symbol, tab, hay}] (Adam 2026-07-22).
let SEARCH_INDEX = [];

// ============================================================================
// 漲紅跌綠 (台股慣例) — SINGLE SOURCE OF TRUTH for up/down colours.
// Adam 2026-06-17: 「固定漲紅跌綠 不要忘記」。漲 = 紅、跌 = 綠。
// BOTH the price-change text (.up/.down in style.css, same hex) AND the trend
// chart line read their colour from here. NEVER invert (漲綠跌紅 is wrong) and
// NEVER hardcode a different up/down colour — any new coloured element calls
// trendColor()/trendFill() so the convention can never drift again.
// ============================================================================
const TREND_UP_COLOR = "#f87171";    // 漲 = 紅
const TREND_DOWN_COLOR = "#4ade80";  // 跌 = 綠
const TREND_UP_FILL = "rgba(248, 113, 113, 0.15)";
const TREND_DOWN_FILL = "rgba(74, 222, 128, 0.15)";
function trendColor(delta) { return Number(delta) >= 0 ? TREND_UP_COLOR : TREND_DOWN_COLOR; }
function trendFill(delta) { return Number(delta) >= 0 ? TREND_UP_FILL : TREND_DOWN_FILL; }

// ========== Formatters ==========
function fmtNum(val, decimals = 2) {
  if (val === null || val === undefined || isNaN(val)) return "–";
  return Number(val).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtCurrency(val, currency = "USD", decimals = 2) {
  if (val === null || val === undefined || isNaN(val)) return "–";
  const symbol = currency === "TWD" ? "NT$" : currency === "USD" ? "$" : "";
  return `${symbol}${fmtNum(val, decimals)}`;
}

function fmtPct(val, withSign = true) {
  if (val === null || val === undefined || isNaN(val)) return "–";
  const sign = withSign && val > 0 ? "+" : "";
  return `${sign}${fmtNum(val, 2)}%`;
}

function fmtCompactCurrency(val, currency = "USD") {
  if (val === null || val === undefined || isNaN(val)) return "–";
  const symbol = currency === "TWD" ? "NT$" : currency === "USD" ? "$" : "";
  const abs = Math.abs(val);
  if (abs >= 1e12) return `${symbol}${fmtNum(val / 1e12, 2)}T`;
  if (abs >= 1e9) return `${symbol}${fmtNum(val / 1e9, 2)}B`;
  if (abs >= 1e6) return `${symbol}${fmtNum(val / 1e6, 2)}M`;
  if (abs >= 1e4) return `${symbol}${fmtNum(val / 1e4, 2)}萬`;
  return fmtCurrency(val, currency);
}

function changeClass(val) {
  if (val === null || val === undefined || isNaN(val)) return "flat";
  if (val > 0) return "up";
  if (val < 0) return "down";
  return "flat";
}

function distFromHighClass(distPct) {
  if (distPct === null || distPct === undefined) return "";
  if (distPct > -3) return "badge-near-high";
  if (distPct < -20) return "badge-near-low";
  return "badge-mid";
}

function distFromHighLabel(distPct) {
  if (distPct === null || distPct === undefined) return "";
  if (distPct > -3) return "黏住";
  if (distPct < -20) return "深回檔";
  return "中段";
}

// ========== Range Bar ==========
function rangeBarHtml(price, low, high) {
  if (price === null || low === null || high === null || high === low) {
    return '<div class="range-bar"><div class="range-fill"></div></div>';
  }
  const pct = Math.max(0, Math.min(100, ((price - low) / (high - low)) * 100));
  return `
    <div class="range-bar">
      <div class="range-fill"></div>
      <div class="range-marker" style="left: ${pct}%;"></div>
    </div>
    <div class="range-labels">
      <span>${fmtNum(low, 2)}<br><small>52W 低</small></span>
      <span style="text-align:center;">現價 ${fmtNum(price, 2)}</span>
      <span style="text-align:right;">${fmtNum(high, 2)}<br><small>52W 高</small></span>
    </div>
  `;
}

// ========== Chart helpers ==========
// Whitelist generated DOM ids to [A-Za-z0-9_-] so a config id can never inject
// markup through id="..."/data-canvas="..." attributes. This is the single source
// of canvasId, so DOM ids + map keys + getElementById stay mutually consistent.
function safeDomId(s) { return String(s == null ? "" : s).replace(/[^A-Za-z0-9_-]/g, "_"); }
function canvasIdFor(section, item) {
  return `chart-${safeDomId(section)}-${safeDomId(item.id)}`;
}

function filterHistory(history, scope) {
  if (!history) return [];
  if (scope === "1d") return history.intraday || [];
  // 3d / 1w / 1M: 30-min intraday (intraday_mid) sliced to the last N calendar days,
  // so short scopes show real intraday detail instead of 1-point-per-day (over-smoothed).
  const mid = history.intraday_mid || [];
  if ((scope === "3d" || scope === "1w" || scope === "1m") && mid.length) {
    const nDays = SCOPE_DAYS[scope];
    const cutoff = new Date(mid[mid.length - 1].t.slice(0, 10) + "T00:00:00");
    cutoff.setDate(cutoff.getDate() - (nDays - 1));
    const sliced = mid.filter((p) => new Date(p.t.slice(0, 10) + "T00:00:00") >= cutoff);
    if (sliced.length >= 2) return sliced;
  }
  const daily = history.daily || [];
  if (scope === "all") return daily;
  const days = SCOPE_DAYS[scope];
  if (!days) return daily;
  return daily.slice(-days);
}

// Live quotes carry only today's fine-grained `intraday` bars, but the multi-day
// chart scopes read `intraday_mid` (3d/1w/1m) and `daily` (3m+/all) from the
// close-time snapshot, which ends at the LAST completed session. Without splicing
// today in, switching to ≥3d never draws the current day (Adam 2026-07-02). Merge
// the live bars/price into every series so the line reaches "now" at all scopes.
function mergeLiveIntoHistory(history, q) {
  if (!q || !Array.isArray(q.intraday) || !q.intraday.length) return history;
  const h = { ...(history || {}) };
  const bars = q.intraday;
  h.intraday = bars;                                            // 1d scope — unchanged
  const today = (bars[bars.length - 1].t || "").slice(0, 10);   // exchange-local date
  const px = (q.price != null) ? q.price : bars[bars.length - 1].c;
  // 3d/1w/1m: replace any stale "today" slice with the fresh live intraday bars.
  if (Array.isArray(h.intraday_mid) && h.intraday_mid.length) {
    h.intraday_mid = [...h.intraday_mid.filter((p) => (p.t || "").slice(0, 10) !== today), ...bars];
  }
  // 3m+/all: append (or update) today's single daily point at the live price.
  if (Array.isArray(h.daily) && h.daily.length) {
    const last = h.daily[h.daily.length - 1];
    h.daily = ((last.t || "").slice(0, 10) === today)
      ? [...h.daily.slice(0, -1), { ...last, c: px }]
      : [...h.daily, { t: today, c: px }];
  }
  return h;
}

// Classify an intraday bar into pre-market / regular / post-market by its
// exchange-local time. Yahoo intraday `t` is "YYYY-MM-DDTHH:MM" in the exchange's
// own timezone, so a minute-of-day comparison is enough.
//   US equities/ETF: regular 09:30–16:00 ET.
//   TW equities/ETF: 09:00–13:30 (TW has no real extended session — defensive).
//   Other types (commodities/futures): no clean split → treated as regular.
function classifySession(t, type) {
  const tp = String(t).split("T")[1];
  if (!tp) return "reg"; // daily bar, no intraday session
  const [h, m] = tp.split(":").map(Number);
  const mins = h * 60 + m;
  if (type === "us_stock" || type === "us_etf") {
    if (mins < 570) return "pre";   // before 09:30
    if (mins >= 960) return "post"; // 16:00 onward
    return "reg";
  }
  if (type === "tw_stock" || type === "tw_etf") {
    if (mins < 540) return "pre";  // before 09:00
    if (mins > 810) return "post"; // after 13:30 (13:30 close print stays regular)
    return "reg";
  }
  return "reg";
}

// Format a history point's `t` for the tooltip title.
// intraday "2026-06-15T17:16" -> "6月15日 下午5:16"; daily "2026-06-15" -> "2026/6/15".
function fmtChartTs(t) {
  if (!t) return "";
  const [datePart, timePart] = String(t).split("T");
  const [y, m, d] = datePart.split("-");
  if (timePart) {
    const [h, min] = timePart.split(":").map(Number);
    const ampm = h < 12 ? "上午" : "下午";
    const h12 = h % 12 || 12;
    return `${Number(m)}月${Number(d)}日 ${ampm}${h12}:${String(min).padStart(2, "0")}`;
  }
  return `${y}/${Number(m)}/${Number(d)}`;
}

// Crosshair: vertical dashed guide at the active (hovered/tapped) point, so
// tapping anywhere on the trend reveals that point's date + price. Pairs with
// interaction {mode:"index", intersect:false} below for mobile-friendly taps.
const crosshairPlugin = {
  id: "abrahamCrosshair",
  afterDraw(chart) {
    const tip = chart.tooltip;
    const active = tip && tip.getActiveElements ? tip.getActiveElements() : [];
    if (!active.length) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(139, 149, 167, 0.55)";
    ctx.stroke();
    ctx.restore();
  },
};

// Mark the high & low of the currently-displayed range on the price line —
// a dot + value label at the peak (高) and trough (低) of the visible scope.
const minMaxLabelPlugin = {
  id: "abrahamMinMax",
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data || meta.data.length < 2) return;
    const vals = chart.data.datasets[0].data;
    let maxI = 0, minI = 0;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] > vals[maxI]) maxI = i;
      if (vals[i] < vals[minI]) minI = i;
    }
    const ctx = chart.ctx;
    const dot = (idx) => {
      const pt = meta.data[idx];
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3, 0, 2 * Math.PI);
      ctx.fillStyle = "#e4e8f0";
      ctx.fill();
    };
    ctx.save();
    dot(maxI);  // 高點位置 (數值顯示在圖下方 .chart-hilo)
    dot(minI);  // 低點位置
    ctx.restore();
  },
};

function renderChart(canvasId, scope) {
  const history = CARD_HISTORY.get(canvasId);
  // Resolve the STABLE wrapper by id — it keeps its id even when a prior empty-state
  // message replaced the canvas, so switching to a scope WITH data recovers the canvas.
  const wrap = document.getElementById("wrap-" + canvasId);
  if (!wrap) return;

  let points = filterHistory(history, scope);

  // Destroy any chart bound to this canvas before touching the DOM (avoid leaks) —
  // including when we fall into the empty-state branch below.
  const existing = CHART_INSTANCES.get(canvasId);
  if (existing) { try { existing.destroy(); } catch (e) {} CHART_INSTANCES.delete(canvasId); }

  if (!points || points.length < 2) {
    wrap.classList.add("empty");
    wrap.innerHTML = '<span>（該範圍無資料）</span>';
    const he = document.getElementById("hilo-" + canvasId);
    if (he) he.textContent = "";
    return;
  }
  wrap.classList.remove("empty");
  // Recreate the canvas if a prior empty-state removed it (or it never existed).
  if (!document.getElementById(canvasId)) {
    wrap.innerHTML = `<canvas id="${canvasId}"></canvas>`;
  }

  // 夜盤 (盤前/盤後) handling — intraday (1d scope) only. Classify each bar by
  // its exchange-local time; once the regular session has opened that day, drop
  // the leading pre-market segment (Adam 2026-06-17: 開盤後不再顯示前一段夜盤).
  // After-hours bars stay in the series but render white via the segment callback.
  const cardType = (CARD_META.get(canvasId) || {}).type || "";
  let sessions = null;
  if (scope === "1d") {
    sessions = points.map((p) => classifySession(p.t, cardType));
    if (sessions.includes("reg")) {
      const keptPts = [], keptSess = [];
      points.forEach((p, i) => {
        if (sessions[i] !== "pre") { keptPts.push(p); keptSess.push(sessions[i]); }
      });
      if (keptPts.length >= 2) { points = keptPts; sessions = keptSess; }
    }
  }

  // Regular-session bars drive the up/down (red/green) line color; after-hours
  // segments get overridden to white by the dataset segment callback below.
  const regCloses = sessions ? points.filter((_, i) => sessions[i] === "reg").map((p) => p.c) : null;
  const colorRef = regCloses && regCloses.length ? regCloses : points.map((p) => p.c);
  const first = colorRef[0];
  const last = colorRef[colorRef.length - 1];
  // 漲紅跌綠 — colour the line by the card's DAY move (= the price-number's
  // up/down), via the single trendColor() source of truth, so the line colour
  // can never contradict the number (Adam 2026-06-17 固定漲紅跌綠 不要忘記).
  // Fallback to the displayed-window trend only when day-change is unavailable.
  // 線色隨時間軸：1d=當日漲跌(漲紅跌綠 Adam 6/17)；其他 scope=該區間 首→末，與下方漲跌數字一致、不矛盾(Adam 6/21)。
  const dayChange = (CARD_META.get(canvasId) || {}).dayChange;
  const trendDelta = scope === "1d"
    ? ((dayChange != null && !isNaN(dayChange)) ? Number(dayChange) : (last - first))
    : (last - first);
  const lineColor = trendColor(trendDelta);
  const fillColor = trendFill(trendDelta);

  const closes = points.map((p) => p.c);
  // High/low of the displayed range -> text line below the chart (updates per scope).
  const hiloEl = document.getElementById("hilo-" + canvasId);
  if (hiloEl) {
    hiloEl.textContent = `區間　高 ${fmtNum(Math.max(...closes), 2)}　低 ${fmtNum(Math.min(...closes), 2)}`;
  }
  // 股價後方漲跌數字隨時間軸更新 (Adam 2026-06-21): 1d=當日官方漲跌; 其他=該區間 首→末 漲跌 + 期間標籤。
  const chgEl = document.getElementById("chg-" + canvasId);
  if (chgEl) {
    const cm = CARD_META.get(canvasId) || {};
    let absChg, pctChg, suffix;
    if (scope === "1d") {
      absChg = cm.dayChangeAbs ?? null; pctChg = cm.dayChange ?? null; suffix = "";
    } else {
      const f = closes[0], l = closes[closes.length - 1];
      absChg = (f != null && l != null) ? l - f : null;
      pctChg = f ? ((l - f) / f) * 100 : null;
      suffix = " · " + scope;
    }
    const sign = (absChg != null && absChg > 0) ? "+" : "";
    chgEl.className = "asset-change " + changeClass(pctChg);
    chgEl.innerHTML = `${absChg != null ? sign + fmtNum(absChg, 2) : "–"} (${fmtPct(pctChg)})${suffix}`;
  }
  const datasets = [{
    label: "價格",
    data: closes,
    borderColor: lineColor,
    segment: {
      // 夜盤(盤前/盤後) segments render white; regular session keeps 漲紅跌綠.
      borderColor: (ctx) => (sessions && sessions[ctx.p1DataIndex] !== "reg" ? "#ffffff" : undefined),
    },
    backgroundColor: fillColor,
    borderWidth: 1.8,
    fill: true,
    tension: 0.15,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHoverBackgroundColor: lineColor,
    pointHoverBorderColor: "#0f1419",
    pointHoverBorderWidth: 2,
    order: 1,
  }];

  // y-axis: price range first, then widened just enough to include the active
  // overlay lines (Adam 2026-07-23: 按出來的線一定要看得見 — 1d 盤中窄區間常讓
  // 支撐壓力/進場區整組落在範圍外, 舊規則會整段裁掉、看起來像沒畫).
  // (取代 2026-06-17「進場區虛線不強求顯示」— 那是線常駐當裝飾時代的規則.)
  const meta = CARD_META.get(canvasId);
  const yMin = Math.min(...closes);
  const yMax = Math.max(...closes);
  const overlayVals = [];
  const overlayMode = overlayModeFor(canvasId);  // 'sr' | 'zone' — 擇一畫, 避免兩組線混淆
  if (overlayMode === "zone" && meta && meta.hi != null) {
    overlayVals.push(meta.hi);
    datasets.push({
      label: "進場上限",
      data: new Array(closes.length).fill(meta.hi),
      borderColor: "#fbbf24",
      borderWidth: 1.3,
      borderDash: [5, 4],
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 0,
      tension: 0,
      order: 0,
    });
    if (meta.lo != null) {
      overlayVals.push(meta.lo);
      datasets.push({
        label: "進場下限",
        data: new Array(closes.length).fill(meta.lo),
        borderColor: "rgba(251, 191, 36, 0.45)",
        borderWidth: 1,
        borderDash: [3, 4],
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0,
        order: 0,
      });
    }
  }
  // 支撐/壓力虛線 (Adam 2026-07-22; 2026-07-23 起全刻度) — 有切換鍵、且預設就是
  // 支撐壓力後, 使用者在哪個刻度按就在哪個刻度看到 (原本只畫 3M/6M → 預設頁 1d
  // 永遠空白, 看起來像沒做). 壓力紅/支撐綠 對齊 ta-stock 慣例, 細虛線不搶價格線.
  if (overlayMode === "sr" && meta && meta.sr) {
    const srLine = (px, color, label) => ({
      label,
      data: new Array(closes.length).fill(px),
      borderColor: color,
      borderWidth: 1,
      borderDash: [2, 3],
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 0,
      tension: 0,
      order: 0,
    });
    // 夠格的位階全畫 (Adam 2026-07-23 拍板:「真的有多條就留著」, 文字區同步全列) —
    // srLevels 各邊已 cap 2 條、nearest-first; 與卡片 🧱/🛟 文字列同一來源.
    for (const r of meta.sr.resistances) { overlayVals.push(r.px); datasets.push(srLine(r.px, "rgba(248, 113, 113, 0.55)", "壓力")); }
    for (const s of meta.sr.supports) { overlayVals.push(s.px); datasets.push(srLine(s.px, "rgba(74, 222, 128, 0.55)", "支撐")); }
  }
  const yLo = overlayVals.length ? Math.min(yMin, ...overlayVals) : yMin;
  const yHi = overlayVals.length ? Math.max(yMax, ...overlayVals) : yMax;
  const pad = (yHi - yLo) * 0.06 || 1;

  // 量能柱 (Adam 2026-07-22): every scope up to 1y — intraday bars (1d~1M) and the
  // daily v-tail (3M/6M/1y) both carry v now. 2y/5y/All stay off by design (>700 bars
  // → sub-pixel bars, unreadable). 紅=漲/綠=跌 (漲紅跌綠鐵則), 透明度低不搶價格線.
  // Coverage guard: ≥50% of visible bars need v (partial tails look broken); 1d only
  // needs 3 bars so the bars appear within minutes of the open.
  let volTip = null, volMax = 0;
  if (scope !== "2y" && scope !== "5y" && scope !== "all") {
    const vols = points.map((p) => (p && p.v != null ? p.v : null));
    const have = vols.filter((v) => v != null);
    if (have.length >= Math.max(scope === "1d" ? 3 : 10, points.length * 0.5)) {
      volMax = Math.max(...have);
      if (volMax > 0) {
        volTip = vols;
        const volColors = vols.map((v, i) => {
          if (v == null) return "rgba(0,0,0,0)";
          const up = i > 0 && closes[i] != null && closes[i - 1] != null ? closes[i] >= closes[i - 1] : true;
          return up ? "rgba(248, 113, 113, 0.32)" : "rgba(74, 222, 128, 0.32)";
        });
        datasets.push({
          type: "bar",
          label: "量",
          data: vols,
          backgroundColor: volColors,
          borderWidth: 0,
          yAxisID: "yv",
          barPercentage: 1.0,
          categoryPercentage: 0.85,
          order: 3,             // higher order → drawn beneath the price line
        });
      }
    }
  }

  const currency = (CARD_META.get(canvasId) || {}).currency || "USD";
  const twLotsChart = String(cardType).startsWith("tw_");
  const el = document.getElementById(canvasId);
  const chart = new Chart(el, {
    type: "line",
    data: {
      labels: points.map((p) => p.t),
      datasets,
    },
    plugins: [crosshairPlugin, minMaxLabelPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // index + intersect:false => tapping anywhere on the line surfaces the
      // nearest point (no need to hit it exactly — works on touch screens).
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          backgroundColor: "rgba(15, 20, 25, 0.95)",
          titleColor: "#8b95a7",
          bodyColor: "#e4e8f0",
          borderColor: "#2d3548",
          borderWidth: 1,
          padding: 8,
          filter: (item) => item.datasetIndex === 0,
          callbacks: {
            title: (items) => fmtChartTs(items[0]?.label),
            label: (ctx) => `價格 ${fmtCurrency(ctx.parsed.y, currency, 2)}`,
            afterBody: (items) => {
              if (!volTip || !items.length) return;
              const v = volTip[items[0].dataIndex];
              return v != null ? `量 ${fmtVolumeByType(v, twLotsChart)}` : undefined;
            },
          },
        },
      },
      scales: {
        x: { display: false },
        y: { display: false, min: yLo - pad, max: yHi + pad },
        // Hidden volume axis: max ×4 keeps the bars in the bottom quarter of the chart.
        ...(volTip ? { yv: { display: false, min: 0, max: volMax * 4.2 } } : {}),
      },
      animation: { duration: 200 },
    },
  });
  CHART_INSTANCES.set(canvasId, chart);
}

function chartBlockHtml(canvasId, hasZone, hasSr) {
  const tabs = SCOPES.map((s) => {
    const activeCls = s.key === DEFAULT_SCOPE ? " active" : "";
    return `<button class="scope-btn${activeCls}" data-scope="${s.key}" data-canvas="${canvasId}">${s.label}</button>`;
  }).join("");
  // 覆蓋層切換鍵 (Adam 2026-07-23): 支撐壓力 / 進場區 擇一, 預設支撐壓力。
  // 沒資料的那顆 disabled (進場區未設 ≠ 壞掉, 灰色講清楚)。active 依已存選擇或預設.
  const saved = CARD_OVERLAY.get(canvasId);
  const mode = (saved === "zone" && hasZone) || (saved === "sr" && hasSr)
    ? saved
    : (hasSr || !hasZone ? "sr" : "zone");
  const ovBtn = (key, label, has, offTitle) =>
    `<button class="overlay-btn${mode === key && has ? " active" : ""}" data-overlay="${key}" data-canvas="${canvasId}"${has ? "" : ` disabled title="${offTitle}"`}>${label}</button>`;
  return `
    <div class="chart-block">
      <div class="overlay-toggle">
        ${ovBtn("sr", "支撐壓力", hasSr, "無夠格的支撐壓力位")}
        ${ovBtn("zone", "進場區", hasZone, "進場區未設")}
      </div>
      <div class="chart-canvas-wrap" id="wrap-${canvasId}">
        <canvas id="${canvasId}"></canvas>
      </div>
      <div class="chart-hilo" id="hilo-${canvasId}"></div>
      <div class="scope-tabs">${tabs}</div>
    </div>
  `;
}

function initializeCharts(items, section) {
  for (const item of items) {
    if (item.status === "error") continue;
    const canvasId = canvasIdFor(section, item);
    const history = item.data?.history;
    CARD_HISTORY.set(canvasId, history);
    CARD_META.set(canvasId, {
      lo: item.entry_zone_lo ?? null,
      hi: item.entry_zone_hi ?? null,
      currency: item.currency || item.data?.currency || "USD",
      type: item.type || "",
      dayChange: item.data?.change_pct ?? null,  // drives the line colour (漲紅跌綠, matches the number)
      dayChangeAbs: item.data?.change ?? null,   // 當日漲跌絕對值 (給 1d scope 漲跌數字用)
      sr: srLevels(item),                        // 支撐/壓力 (2026-07-22) — 覆蓋虛線用 (7/23 起全刻度)
    });
    renderChart(canvasId, DEFAULT_SCOPE);
  }
}

document.addEventListener("click", (e) => {
  const tabBtn = e.target.closest(".market-tab");
  if (tabBtn) { activateTab(tabBtn.dataset.tab); return; }
  const simBtn = e.target.closest(".sim-subtab");
  if (simBtn) { activateSimBook(simBtn.dataset.simbook); return; }
  // 進場區內 / 回檔排行榜 rows + search results → jump to that card (Adam 2026-07-22).
  const jr = e.target.closest(".jump-row");
  if (jr && jr.dataset.jumpTab && jr.dataset.jumpId) {
    jumpToCard(jr.dataset.jumpTab, jr.dataset.jumpId);
    return;
  }
  const rb = e.target.closest(".card-refresh");
  if (rb) {
    refreshOneCard(rb.dataset.section, rb.dataset.cardid, rb.dataset.sym, rb);
    return;
  }
  // 圖釘: toggle pinned state + re-apply sort (floats to top unless 漲跌幅/距進場區).
  const pinB = e.target.closest(".pin-btn");
  if (pinB) {
    const section = pinB.dataset.section, id = pinB.dataset.cardid;
    if (section && id) {
      const nowPinned = togglePin(section, id);
      pinB.classList.toggle("pinned", nowPinned);
      pinB.title = nowPinned ? "取消置頂" : "釘選置頂";
      pinB.setAttribute("aria-pressed", String(nowPinned));
      const card = pinB.closest(".asset-card");
      if (card) card.classList.toggle("pinned", nowPinned);
      applySort(section);
    }
    return;
  }
  // 覆蓋層切換 (支撐壓力 ↔ 進場區): 記住選擇 → 用當前刻度重畫該卡 (Adam 2026-07-23)
  const ovB = e.target.closest(".overlay-btn");
  if (ovB) {
    const canvasId = ovB.dataset.canvas, mode = ovB.dataset.overlay;
    if (canvasId && mode && !ovB.disabled) {
      CARD_OVERLAY.set(canvasId, mode);
      ovB.parentElement.querySelectorAll(".overlay-btn").forEach((b) => b.classList.toggle("active", b === ovB));
      const scope = ovB.closest(".chart-block")?.querySelector(".scope-btn.active")?.dataset.scope || DEFAULT_SCOPE;
      renderChart(canvasId, scope);
    }
    return;
  }
  const btn = e.target.closest(".scope-btn");
  if (!btn) return;
  const canvasId = btn.dataset.canvas;
  const scope = btn.dataset.scope;
  if (!canvasId || !scope) return;
  // Update active state within the same tab group
  const tabs = btn.parentElement.querySelectorAll(".scope-btn");
  tabs.forEach((t) => t.classList.toggle("active", t === btn));
  renderChart(canvasId, scope);
});

// Escape text destined for innerHTML. Card text comes from my config + Yahoo
// (e.g. notes contain "認錯 <190"), so escape to avoid broken markup / injection.
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Per-card data-freshness badge (Adam 2026-06-30): make the FEW symbols that fail
// to refresh live visible instead of silently looking "stuck". Green = live quote,
// amber = showing close (live fetch missed this symbol, or pipeline carried stale),
// grey = plain盤後 snapshot. (Freshness ≠ price direction — separate pill/row, so it
// doesn't collide with the 漲紅跌綠 price colours.)
function freshnessBadge(item) {
  const data = item.data || {};
  const hhmm = (ms) => new Date(ms).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }).slice(0, 5);
  if (item._live === true) {
    // Show the PRICE's own time (quote asOf), not our fetch time — so a delayed source is
    // honest instead of masquerading as live. (Adam 2026-07-06: 應標『該價格是什麼時間』)
    const qts = item._quoteTs || item._liveTs;
    // Market closed: this IS the official close (證交所), not "delayed" data → 收盤, never 慢N分.
    // (Adam 2026-07-06: 收盤後別退回 Yahoo 舊價 + 假裝慢N分)
    if (item._session === "closed") {
      return `<span class="freshness snap" title="今日收盤價（證交所）；市場已收盤，非即時">🕒 收盤 ${hhmm(qts)}</span>`;
    }
    const lbl = item._session === "pre" ? "盤前" : item._session === "post" ? "盤後" : "即時";
    const delayMin = item._quoteTs && item._liveTs ? Math.round((item._liveTs - item._quoteTs) / 60000) : 0;
    if (delayMin >= 3) {
      // Don't call a lagged quote 「即時」— that's the very thing Adam flagged. Use 報價.
      const dlbl = item._session === "pre" ? "盤前" : item._session === "post" ? "盤後" : "報價";
      return `<span class="freshness delayed" title="這是該價格本身的成交時間；資料源延遲約 ${delayMin} 分鐘（非即時）">🟡 ${dlbl} ${hhmm(qts)}·慢${delayMin}分</span>`;
    }
    return `<span class="freshness fresh" title="報價成交時間（幾乎即時）">🟢 ${lbl} ${hhmm(qts)}</span>`;
  }
  // Carried-forward stale (pipeline kept last-known-good) is the stronger signal —
  // check it BEFORE the generic live-miss so wording stays exact. (Codex R2 P4.)
  if (data.stale) {
    const since = data.stale_since ? new Date(data.stale_since).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    return `<span class="freshness stale" title="本輪抓取失敗，顯示上次收盤價${since ? "（" + since + "）" : ""}">🟡 舊資料${since ? " " + since : ""}</span>`;
  }
  if (item._live === false) {
    return `<span class="freshness stale" title="此檔即時抓取失敗，顯示最近收盤價">🟡 未即時·收盤</span>`;
  }
  if (data.fetched_at) {
    const s = new Date(data.fetched_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `<span class="freshness snap" title="盤後快照資料">🕒 收盤 ${s}</span>`;
  }
  return "";
}

// ========== 成交量 (Adam 2026-07-22) ==========
// TW stocks/ETF trade in 張 (1 張 = 1000 股); yfinance/MIS-relay volumes are SHARES.
function isTwLots(item) { return String(item.type || "").startsWith("tw_"); }
function fmtVolumeByType(shares, twLots) {
  if (shares == null || isNaN(shares)) return "–";
  if (twLots) {
    const lots = shares / 1000;
    if (lots >= 100000) return `${fmtNum(lots / 10000, 1)}萬張`;   // 只有超大量才進萬張 (10,588 張比 1.06萬張易讀)
    return `${fmtNum(lots, 0)} 張`;
  }
  const abs = Math.abs(shares);
  if (abs >= 1e9) return `${fmtNum(shares / 1e9, 2)}B 股`;
  if (abs >= 1e6) return `${fmtNum(shares / 1e6, 2)}M 股`;
  if (abs >= 1e3) return `${fmtNum(shares / 1e3, 1)}K 股`;
  return `${fmtNum(shares, 0)} 股`;
}
function fmtVolume(shares, item) { return fmtVolumeByType(shares, isTwLots(item)); }

// ⚠️ relay 的 session="regular" 是它的初始預設值 — 台股隔夜空檔 (Yahoo fallback 路徑,
// 非 post 非 pre) 也會掛著 "regular" 回來 (2026-07-23 凌晨 05:35 實測)。所以「盤中」
// 判定必須加報價新鮮度: regular 且報價時戳在 30 分鐘內才算 live, 否則按收盤處理
// (數字仍可用 — dayVolume 是該日全量 — 只是不能標「盤中/今日累積中」)。
// _quoteTs 缺席時放行 (=舊行為; 真實 relay 一律帶 asOf)。
function sessionFreshLive(item, nowMs) {
  if (item._session !== "regular" && item._session != null) return false;  // pre/post/closed
  if (item._quoteTs == null) return true;
  return ((nowMs != null ? nowMs : Date.now()) - item._quoteTs) <= 30 * 60 * 1000;
}

// Volume picture for a card, honest about WHICH session the number belongs to.
//   live session + relay dayVolume → 今日盤中累積量, 量比 = 累積量/20日均 (ramps up intraday)
//   otherwise → last completed session's volume from the daily series (v-tail),
//   量比 = that bar / mean(prior ≤20 v-bars). Falls back to snapshot volume/average_volume
//   (3-month avg) while the v-tail hasn't been fetched yet — tooltip says which basis.
// 指數沒有「成交股數」這回事 — Yahoo 對 ^TWII 一律回 0，照著印就變成「今日量 0 股 /
// 量比 0.0×」這種看起來像真的假數字 (Adam 2026-07-31 截圖指出)。指數一律不出量能三行:
// 寧可空白，也不給一個假的 0。ETF (EWT) 是真有量的商品，不在此列 (type=us_etf)。
function isIndexItem(item) {
  return !!item && item.type === "index";
}

function volumeInfo(item, nowMs) {
  if (isIndexItem(item)) return null;
  const data = item.data || {};
  const daily = (data.history && data.history.daily) || [];
  const vbars = daily.filter((b) => b && b.v != null);
  let avg20 = null;
  let lastBar = null;
  if (vbars.length >= 6) {
    lastBar = vbars[vbars.length - 1];
    const prior = vbars.slice(Math.max(0, vbars.length - 21), vbars.length - 1);
    if (prior.length >= 5) avg20 = prior.reduce((s, b) => s + b.v, 0) / prior.length;
  }
  // Relay dayVolume (證交所 MIS / Yahoo) is fresher than the snapshot's last daily bar:
  // during the session it's 盤中累積, after close it's the official full-day volume.
  if (item._live === true && item._dayVolume != null) {
    const sessionLive = item._session !== "closed" && item._session !== "post" && sessionFreshLive(item, nowMs);
    const ratio = avg20 ? item._dayVolume / avg20 : (data.average_volume ? item._dayVolume / data.average_volume : null);
    return { vol: item._dayVolume, label: sessionLive ? "今日量" : "量(最近日)", live: sessionLive, ratio, basis: avg20 ? "20日均量" : "3個月均量" };
  }
  if (lastBar && avg20) {
    const d = String(lastBar.t || "").slice(5).replace("-", "/");
    return { vol: lastBar.v, label: `量(${d})`, live: false, ratio: lastBar.v / avg20, basis: "20日均量" };
  }
  if (data.volume != null) {
    const ratio = data.average_volume ? data.volume / data.average_volume : null;
    return { vol: data.volume, label: "量(前日)", live: false, ratio, basis: "3個月均量" };
  }
  return null;
}

function volumeBadge(ratio, live, dp = 1) {
  if (ratio == null || !isFinite(ratio)) return "";
  if (ratio >= 1.5) return `<span class="vol-chip vol-surge">爆量 ${fmtNum(ratio, dp)}×</span>`;
  if (ratio >= 0.6 || live) return `<span class="vol-chip vol-norm">${fmtNum(ratio, dp)}×</span>`;
  return `<span class="vol-chip vol-dry">縮量 ${fmtNum(ratio, dp)}×</span>`;
}

// ========== 即時量比 (Adam 2026-07-23) ==========
// 看盤軟體標準口徑: 今日累積量 ÷ (近5個交易日均量 × 已開盤時間比例) — 盤中任一時刻
// 1.0×=步調正常。跟「量比」(分母=全日均量, 早盤結構性偏低、收盤才準) 是互補讀數。
// 已開盤分鐘用**報價自己的時間戳** (_quoteTs=relay asOf) 對交易所時區開盤時刻算,
// 不用瀏覽器牆鐘 — 免疫延遲 feed 與使用者時區。是否在盤中以 relay 的 session 欄
// 為權威 (MIS/Yahoo 實測值), 不用日曆推測 → 颱風臨時休市/假日自然走收盤路徑。
// 已知邊界: 美股感恩節前後的半日盤 (13:00 ET 提前收) 收盤後 ratio 會略偏低 (仍以
// 390 分母計), 屬罕見日、誠實不特判。
const SESSION_SPEC = {
  tw: { tz: "Asia/Taipei", openMin: 9 * 60, totalMin: 270 },            // 09:00–13:30
  us: { tz: "America/New_York", openMin: 9 * 60 + 30, totalMin: 390 },  // 09:30–16:00 (DST 交給 tz)
};
function itemSessionMarket(item) {
  if ((item.type || "") === "commodity") return null;  // 黃金近24h交易, 無「開盤經過時間」概念
  const s = String(item.symbol || item.id || "");
  if (isTwLots(item) || /\.TWO?$/i.test(s) || /^\^TWII/.test(s)) return "tw";
  return "us";
}
function dateInTz(tsMs, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(tsMs));
}
function sessionElapsedMin(market, tsMs) {
  const spec = SESSION_SPEC[market];
  if (!spec || tsMs == null || isNaN(tsMs)) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: spec.tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(tsMs));
  let h = 0, m = 0;
  for (const p of parts) { if (p.type === "hour") h = +p.value; else if (p.type === "minute") m = +p.value; }
  return Math.max(0, Math.min(spec.totalMin, h * 60 + m - spec.openMin));
}
// 近5個完成交易日均量。sameDayStr 那天已入 bars 時剔除該根 — 盤中推 code 觸發 fetch
// 寫入的當日 partial 棒、或盤後 fetch 後 dayVolume 與末根同日, 都不能進基準。
function fiveDayBase(vbars, sameDayStr) {
  if (vbars.length < 6) return null;
  const last = vbars[vbars.length - 1];
  const arr = String(last.t || "").slice(0, 10) === sameDayStr ? vbars.slice(-6, -1) : vbars.slice(-5);
  const m = arr.reduce((s, b) => s + b.v, 0) / arr.length;
  return m || null;
}

function realtimeVolInfo(item, nowMs) {
  if (isIndexItem(item)) return null;   // 指數無成交股數 → 量比類一律空白，不印假 0
  const market = itemSessionMarket(item);
  if (!market) return null;
  const spec = SESSION_SPEC[market];
  const data = item.data || {};
  const daily = (data.history && data.history.daily) || [];
  const vbars = daily.filter((b) => b && b.v != null && b.v > 0);  // v=0 幻影/停牌 K 不進基準
  if (vbars.length < 6) return null;
  const lastBar = vbars[vbars.length - 1];

  if (item._live === true && item._dayVolume != null && item._session !== "pre") {
    // 盤中判定 = session regular 且報價新鮮 (30分內) — 隔夜殘留的 "regular" 按收盤處理
    // (elapsed=全日, 數字仍正確, 只是不標「已開盤N分」)。
    const inSession = sessionFreshLive(item, nowMs);
    const ts = item._quoteTs != null ? item._quoteTs : (item._liveTs != null ? item._liveTs : (nowMs != null ? nowMs : Date.now()));
    const base5 = fiveDayBase(vbars, dateInTz(ts, spec.tz));
    if (!base5) return null;
    // regular: 折算到已開盤分鐘 (前5分鐘按5分計, 防開盤瞬間爆表); post/closed: dayVolume 已是全日量
    const em = sessionElapsedMin(market, ts);
    const elapsed = inSession ? Math.max(5, em == null ? spec.totalMin : em) : spec.totalMin;
    return { ratio: item._dayVolume / (base5 * (elapsed / spec.totalMin)), live: inSession, elapsed: inSession ? elapsed : null, market };
  }
  // 收盤路徑: 最近完成日 vs 它之前5日 (sameDayStr=末根自身日期 → 必排除)
  const base5 = fiveDayBase(vbars, String(lastBar.t || "").slice(0, 10));
  if (!base5) return null;
  return { ratio: lastBar.v / base5, live: false, elapsed: null, market, asofBar: String(lastBar.t || "").slice(0, 10) };
}

// ========== 瞬時量比/突波偵測 (Adam 2026-07-23「加」) ==========
// 近~10分鐘的每分鐘量 vs 正常每分鐘量 (5日均量攤平) — 抓「此刻正在爆量」的股票,
// 補即時量比 (累積制) 對尾盤突波鈍化的盲點。**盤中限定**: 報價新鮮 (sessionFreshLive)
// 且分線是當日的才算, 收盤/資料舊 → null 誠實空白。方向=同視窗價格變化 (±0.2% deadband)。
// v1 已知口徑 (已對 Adam 講明): 分母是攤平步調 (無歷史分線可做同時段基準) → 開盤/
// 尾盤自然量大的時段倍數天生偏高, 「突波」章門檻 3× 抵消; 進行中的末根 5min bar
// 未走完會稀釋 rate → 取 max(末根/5, 末兩根/10) 緩解。
// ── 即時量 tick 差分 (2026-07-23 修): 台股 MIS 只給「價+當日累積量」、分線點無量,
// Yahoo 分線有量但台股延遲 ~20 分 → 開盤頭 25 分突波啞火。改法: 每次 live tick 記
// {quoteTs, 累積量, 價}, 用差分算「近幾分鐘每分鐘量」= 真即時。頁面開著 ~2 分鐘武裝;
// tick 不足時回退分線路徑 (US 分線近即時, 回退品質仍好)。
const LIVE_VOL_TICKS = new Map();          // item.id -> [{ts, vol, px}]
const VOL_TICK_WINDOW_MS = 11 * 60 * 1000; // 保留 ~11 分 (口徑=近10分)
const VOL_TICK_MIN_SPAN_MS = 90 * 1000;    // 至少 90 秒的差分才算得出 rate

function trackVolTick(id, ts, vol, px) {
  if (ts == null || vol == null || !isFinite(vol)) return;
  const key = String(id);
  let arr = LIVE_VOL_TICKS.get(key);
  if (!arr) { arr = []; LIVE_VOL_TICKS.set(key, arr); }
  const last = arr[arr.length - 1];
  if (last && vol < last.vol) arr.length = 0;         // 累積量倒退 = 換日/換源 → 重來
  if (last && ts <= last.ts) { last.vol = vol; if (px != null) last.px = px; }  // 同刻更新
  else arr.push({ ts, vol, px });
  const cut = ts - VOL_TICK_WINDOW_MS;
  while (arr.length && arr[0].ts < cut) arr.shift();
}

// tick 差分路徑: ≥2 tick、跨度 ≥90s、最新 tick 就是當前報價 → 每分鐘量 vs 5日正常步調
function burstFromTicks(item, spec, nowMs) {
  const arr = LIVE_VOL_TICKS.get(String(item.id));
  if (!arr || arr.length < 2) return null;
  const first = arr[0], last = arr[arr.length - 1];
  const spanMs = last.ts - first.ts;
  if (spanMs < VOL_TICK_MIN_SPAN_MS) return null;
  const now = nowMs != null ? nowMs : Date.now();
  if (now - last.ts > 3 * 60 * 1000) return null;     // tick 斷流 >3 分 → 不出陳舊值
  const daily = (((item.data || {}).history || {}).daily || []).filter((b) => b && b.v != null && b.v > 0);
  if (daily.length < 6) return null;
  const base5 = fiveDayBase(daily, dateInTz(last.ts, spec.tz));
  if (!base5) return null;
  const rate = (last.vol - first.vol) / (spanMs / 60000);   // 股/分鐘
  const ratio = rate / (base5 / spec.totalMin);
  if (!isFinite(ratio) || ratio < 0) return null;
  const chgPct = first.px ? ((last.px - first.px) / first.px) * 100 : null;
  const dir = chgPct == null || Math.abs(chgPct) < 0.2 ? "flat" : (chgPct > 0 ? "up" : "down");
  return { ratio, dir, chgPct, market: null, src: "tick" };
}

function burstVolInfo(item, nowMs) {
  if (isIndexItem(item)) return null;   // 同上：指數不做突波偵測
  const market = itemSessionMarket(item);
  if (!market) return null;
  const spec = SESSION_SPEC[market];
  if (!(item._live === true && item._quoteTs != null && sessionFreshLive(item, nowMs))) return null;
  const tick = burstFromTicks(item, spec, nowMs);
  if (tick) { tick.market = market; return tick; }    // 即時差分優先 (真·近10分)
  const data = item.data || {};
  const daily = ((data.history && data.history.daily) || []).filter((b) => b && b.v != null && b.v > 0);
  const intra = ((data.history && data.history.intraday) || []).filter((b) => b && b.v != null && classifySession(b.t, item.type) === "reg");
  if (daily.length < 6 || intra.length < 2) return null;
  const qDate = dateInTz(item._quoteTs, spec.tz);
  const last = intra[intra.length - 1], prev = intra[intra.length - 2];
  if (String(last.t).slice(0, 10) !== qDate) return null;   // 分線還是舊交易日 → 不硬算
  const base5 = fiveDayBase(daily, qDate);
  if (!base5) return null;
  const rate = Math.max(last.v / 5, (last.v + prev.v) / 10); // 每分鐘量 (5min bars)
  const ratio = rate / (base5 / spec.totalMin);
  if (!isFinite(ratio)) return null;
  const ref = intra.length >= 3 ? intra[intra.length - 3] : prev; // 視窗起點前一根收價
  const chgPct = ref && ref.c ? ((last.c - ref.c) / ref.c) * 100 : null;
  const dir = chgPct == null || Math.abs(chgPct) < 0.2 ? "flat" : (chgPct > 0 ? "up" : "down");
  return { ratio, dir, chgPct, market, src: "bar" };
}
function burstChip(ratio) {
  if (ratio == null || !isFinite(ratio)) return "";
  if (ratio >= 3) return `<span class="vol-chip vol-surge">突波 ${fmtNum(ratio, 1)}×</span>`;
  if (ratio < 0.6) return `<span class="vol-chip vol-dry">${fmtNum(ratio, 1)}×</span>`;
  return `<span class="vol-chip vol-norm">${fmtNum(ratio, 1)}×</span>`;
}
function burstDirTag(dir, short) {
  if (dir === "up") return `<span class="up">${short ? "買" : "偏買盤"}</span>`;
  if (dir === "down") return `<span class="down">${short ? "賣" : "偏賣壓"}</span>`;
  return short ? "" : `<span class="sr-meta">方向不明</span>`;
}

// ========== 支撐/壓力 (Adam 2026-07-22「每一檔的支撐線和壓力牆」) ==========
// v2 (Adam 同日回饋「一年等權沒參考價值, 美光 463 不合理」): 改對齊 ta-stock 深掃的
// 方法——**近期結構優先 + 匯合原則**。swing 觸碰按新舊加權 (近90根 1.0 / 90-180根
// 0.7 / 更舊 0.45), 加成證據 = 量能密集區 (只看近 120 根的 volume profile, 避免遠古
// 低價區壟斷分箱) + 主腿 fib 回撤位匯合 + 50/200日均匯合。距現價 >±30% 的位一律
// 不show (古董位對當下決策無參考價值)。夠格門檻: 近期位 score≥1.5 / 舊位 ≥2.0。
// 誠實不畫原則不變: 沒有夠格的位就空手, 不硬畫。
// (美光 7/20 深掃的 ~895-900 = fib 38.2% 回撤 × 7/7 波段低點匯合 — 本 v2 即該邏輯的
//  自動化版; 台帳 ast-0055。)
const SR_LOOKBACK = 250;      // ~1y of daily bars
const SR_SWING_K = 3;         // swing = strict extreme among ±3 bars
const SR_CLUSTER_PCT = 0.015; // levels within ±1.5% of the cluster mean merge
const SR_MAX_EACH = 2;
const SR_RECENT = 90;         // active-structure window (bars)
const SR_MID = 180;
const SR_MAX_DIST = 0.30;     // 距現價 >30% 的位不 show (Adam 2026-07-22)

function srLevels(item) {
  const data = item.data || {};
  const daily = (data.history && data.history.daily) || [];
  const price = data.price;
  const none = { supports: [], resistances: [] };
  if (price == null || daily.length < 40) return none;
  const bars = daily.slice(-SR_LOOKBACK);
  const n = bars.length;

  // 1) close-based swing highs/lows (strict extreme among ±k; unconfirmed tail excluded)
  const swings = [];
  for (let i = SR_SWING_K; i < n - SR_SWING_K; i++) {
    const c = bars[i].c;
    if (c == null) continue;
    let isHigh = true, isLow = true;
    for (let j = i - SR_SWING_K; j <= i + SR_SWING_K; j++) {
      if (j === i) continue;
      const cj = bars[j].c;
      if (cj == null) { isHigh = isLow = false; break; }
      if (cj >= c) isHigh = false;
      if (cj <= c) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh || isLow) swings.push({ px: c, idx: i });
  }
  if (!swings.length) return none;

  // 2) 量能密集區: volume profile over the LAST 120 bars only (active regime) — a
  //    momentum stock's ancient cheap-price volume would otherwise dominate the bins
  //    (美光 463 bug 的根因之一). Top-20% bins = HVN. Degrades to no-bonus without v.
  let hvnTest = () => false;
  const vwin = bars.slice(-120).filter((b) => b.v != null && b.c != null);
  if (vwin.length >= 60) {
    const cs = vwin.map((b) => b.c);
    const lo = Math.min(...cs), hi = Math.max(...cs);
    if (hi > lo) {
      const NBINS = 24;
      const binVol = new Array(NBINS).fill(0);
      const binOf = (px) => Math.min(NBINS - 1, Math.max(0, Math.floor(((px - lo) / (hi - lo)) * NBINS)));
      for (const b of vwin) binVol[binOf(b.c)] += b.v;
      const ranked = [...binVol].sort((a, b) => b - a);
      const thresh = ranked[Math.max(0, Math.floor(NBINS * 0.2) - 1)];
      if (thresh > 0) hvnTest = (px) => px >= lo && px <= hi && binVol[binOf(px)] >= thresh;
    }
  }

  // 3) 主腿 fib 回撤位 (ta-stock 核心): dominant leg = min↔max of the last 180 bars,
  //    amplitude ≥25%; clusters within 2.5% of a 23.6/38.2/50/61.8 retracement earn
  //    the 匯合 bonus (美光 895 = 38.2% × 7/7 低點 的同款邏輯).
  const legBars = bars.slice(-SR_MID);
  const legCloses = legBars.map((b) => b.c).filter((c) => c != null);
  let fibSet = [];
  if (legCloses.length >= 40) {
    const legHi = Math.max(...legCloses), legLo = Math.min(...legCloses);
    if (legLo > 0 && (legHi - legLo) / legLo >= 0.25) {
      const hiIdx = legCloses.lastIndexOf(legHi), loIdx = legCloses.indexOf(legLo);
      const range = legHi - legLo;
      fibSet = [0.236, 0.382, 0.5, 0.618].map((f) =>
        loIdx < hiIdx ? legHi - range * f : legLo + range * f);  // 上升腿=回撤 / 下降腿=反彈
    }
  }
  const fibNear = (px) => fibSet.some((f) => Math.abs(px - f) / px <= 0.025);
  const maNear = (px) => {
    const m50 = data.fifty_day_avg, m200 = data.two_hundred_day_avg;
    return (m50 != null && Math.abs(px - m50) / px <= 0.02) ||
           (m200 != null && Math.abs(px - m200) / px <= 0.02);
  };

  // 4) greedy price-sorted clustering (join while within ±1.5% of the running mean)
  swings.sort((a, b) => a.px - b.px);
  const clusters = [];
  for (const s of swings) {
    const cl = clusters[clusters.length - 1];
    if (cl && Math.abs(s.px - cl.mean) / cl.mean <= SR_CLUSTER_PCT) {
      cl.pts.push(s);
      cl.mean = cl.pts.reduce((sum, p) => sum + p.px, 0) / cl.pts.length;
    } else {
      clusters.push({ mean: s.px, pts: [s] });
    }
  }

  // 5) score = Σ 加權觸碰 (近新) + 匯合證據; 近期位 ≥1.5 / 舊位 ≥2.0 才夠格;
  //    距現價 >30% 一律出局 (nearest-first 選各邊前 2)
  const supports = [], resistances = [];
  for (const cl of clusters) {
    if (Math.abs(cl.mean - price) / price > SR_MAX_DIST) continue;
    let w = 0, newest = -1;
    for (const p of cl.pts) {
      w += p.idx >= n - SR_RECENT ? 1.0 : p.idx >= n - SR_MID ? 0.7 : 0.45;
      if (p.idx > newest) newest = p.idx;
    }
    const hvn = hvnTest(cl.mean);
    const fib = fibNear(cl.mean);
    const ma = maNear(cl.mean);
    const score = w + (hvn ? 0.75 : 0) + (fib ? 0.75 : 0) + (ma ? 0.5 : 0);
    const isRecent = newest >= n - SR_RECENT;
    if (score < (isRecent ? 1.5 : 2.0)) continue;
    const lvl = { px: cl.mean, touches: cl.pts.length, hvn, fib, ma, score };
    (cl.mean > price ? resistances : supports).push(lvl);
  }
  supports.sort((a, b) => b.px - a.px);      // nearest below current price first
  resistances.sort((a, b) => a.px - b.px);   // nearest above first
  return { supports: supports.slice(0, SR_MAX_EACH), resistances: resistances.slice(0, SR_MAX_EACH) };
}

// Level display precision: S/R are cluster means (帶狀概念), don't over-report digits.
function fmtLevel(px) { return fmtNum(px, px >= 1000 ? 0 : px >= 100 ? 1 : 2); }

// ========== Jump-to-card (search + 排行榜/進場區 rows) ==========
function jumpToCard(tab, id) {
  activateTab(tab);
  // Card nodes exist across tab switches (panels are display:none), but scroll after
  // the tab paints so scrollIntoView measures the visible layout.
  requestAnimationFrame(() => {
    const node = document.querySelector('[data-card="' + CSS.escape(tab + "-" + id) + '"]');
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.remove("card-flash");
    void node.offsetWidth;                 // restart the animation if re-triggered
    node.classList.add("card-flash");
    setTimeout(() => node.classList.remove("card-flash"), 2600);
  });
}

// ========== K線下方資訊板塊 (Adam 2026-07-23) ==========
// 每檔個股卡的文字區改成三層：①簡介（產業/產品/族群）②下個大日子（財報/法說，過期自動隱藏）
// ③深讀新聞 ≤5 條、一季內（>92 天自動過期），每條 日期+利多/中性/利空 標籤（漲紅跌綠同色語言）。
// 資料源 docs/data/stock-profiles.json（深讀班維護）；無 profile → 回退 config notes（指數頁等）。
const PROFILES_URL = "./data/stock-profiles.json";
const STOCK_PROFILES = {};            // id -> {intro, next_event:{d,t}, news:[{d,s,t}]}
const NEWS_MAX = 5;
const NEWS_MAX_AGE_DAYS = 92;         // 「一季內」(Adam: 超過 3 個月過期)

async function loadProfiles() {
  try {
    const res = await fetch(PROFILES_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    const p = (j && j.profiles) || {};
    for (const k of Object.keys(STOCK_PROFILES)) delete STOCK_PROFILES[k];
    Object.assign(STOCK_PROFILES, p);
  } catch (e) { /* fail-soft：載不到就全卡回退 notes，不擋 dashboard */ }
}

function fmtNewsDate(d) { return String(d).slice(5).replace("-", "/"); }  // 2026-07-22 -> 07/22

function stockInfoHtml(item, nowMs) {
  const p = STOCK_PROFILES[String(item.id)];
  if (!p) return item.notes ? `<div class="asset-notes">📝 ${escapeHtml(item.notes)}</div>` : "";
  const now = nowMs != null ? nowMs : Date.now();
  const today = dateInTz(now, "Asia/Taipei");
  let html = `<div class="asset-info">`;
  if (p.intro) html += `<div class="asset-intro">${escapeHtml(p.intro)}</div>`;
  const ev = p.next_event;
  if (ev && ev.d && String(ev.d) >= today) {
    html += `<div class="asset-bigday">📅 <b>${escapeHtml(fmtNewsDate(ev.d))}</b> ${escapeHtml(ev.t || "")}</div>`;
  }
  const cutoff = dateInTz(now - NEWS_MAX_AGE_DAYS * 86400e3, "Asia/Taipei");
  const news = (p.news || [])
    .filter((n) => n && n.d && n.t && String(n.d) >= cutoff)
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))
    .slice(0, NEWS_MAX);
  if (news.length) {                    // 沒新聞就整段省略 (Adam: 沒有新聞就不用標)
    html += `<div class="asset-newslist">` + news.map((n) => {
      const cls = n.s === "利多" ? "tag-bull" : n.s === "利空" ? "tag-bear" : "tag-neutral";
      return `<div class="asset-news-row"><span class="news-date">${escapeHtml(fmtNewsDate(n.d))}</span><span class="news-tag ${cls}">${escapeHtml(n.s || "中性")}</span><span class="news-text">${escapeHtml(n.t)}</span></div>`;
    }).join("") + `</div>`;
  }
  return html + `</div>`;
}

// ========== Asset Card Builder ==========
function buildAssetCard(item, section) {
  const data = item.data || {};
  const isError = item.status === "error";
  const typeTag = `<span class="asset-type-tag tag-${escapeHtml(item.type)}">${escapeHtml((item.type || "").replace("_", " "))}</span>`;

  // 圖釘按鈕 (右上) — only in sortable market tabs (台股/美股/指數). Reflects saved
  // pinned state on render so it survives re-renders / live refresh (Adam 2026-06-19).
  const sortable = (section === "tw" || section === "us" || section === "idx");
  const pinnedState = sortable && isPinned(section, item.id);
  const pinnedCardCls = pinnedState ? " pinned" : "";
  const pinBtn = sortable
    ? `<button class="pin-btn${pinnedState ? " pinned" : ""}" title="${pinnedState ? "取消置頂" : "釘選置頂"}" aria-pressed="${pinnedState}" data-section="${escapeHtml(section)}" data-cardid="${escapeHtml(item.id)}">📌</button>`
    : "";

  // Error card
  if (isError) {
    return `
      <div class="asset-card error${pinnedCardCls}" data-card="${escapeHtml(section + "-" + item.id)}">
        <div class="asset-head">
          <div class="asset-name-block">
            <div class="asset-name">${escapeHtml(item.name || item.id)}</div>
            <div class="asset-symbol">${escapeHtml(item.symbol || "–")}</div>
          </div>
          ${typeTag}
          ${pinBtn}
        </div>
        <div class="error-box">
          ⚠️ <strong>無法抓取資料</strong><br>
          <span style="font-family:monospace; font-size:11px;">${escapeHtml(item.error || "Unknown error")}</span>
        </div>
        ${item.notes ? `<div class="asset-notes">${escapeHtml(item.notes)}</div>` : ""}
      </div>
    `;
  }

  // Price block
  const canvasId = canvasIdFor(section, item);  // also reused by chart block below
  const price = data.price;
  const change = data.change;
  const changePct = data.change_pct;
  const cls = changeClass(changePct);
  const changeSign = changePct > 0 ? "+" : changePct < 0 ? "" : "";

  // Per-card 即時 refresh button (right-aligned in the price row) — updates just this symbol.
  const cardRefreshBtn = item.symbol
    ? `<button class="card-refresh" title="更新此檔即時" data-sym="${escapeHtml(item.symbol)}" data-section="${escapeHtml(section)}" data-cardid="${escapeHtml(item.id)}">↻</button>`
    : "";

  const badge = freshnessBadge(item);
  const priceRow = price !== null && price !== undefined
    ? `
      <div class="asset-price-row">
        <span class="asset-price ${cls}">${fmtNum(price, 2)}</span>
        <span class="asset-change ${cls}" id="chg-${canvasId}">
          ${change !== null ? `${changeSign}${fmtNum(change, 2)}` : "–"}
          (${fmtPct(changePct)})
        </span>
        ${cardRefreshBtn}
      </div>
      ${badge ? `<div class="freshness-row">${badge}</div>` : ""}
    `
    : `
      <div class="asset-price-row">
        <span class="asset-price flat">尚無資料</span>
        ${cardRefreshBtn}
      </div>
      <div style="font-size:12px; color:var(--text-dim); margin-bottom:12px;">
        可能原因：新掛牌尚未有交易資料 / 非交易時段 / 標的代碼錯誤
      </div>
    `;

  // Metrics grid
  const metrics = [];
  // Entry zone (進場區) + 現價距進場上限. Supports hi-only (single line, e.g. NBIS $201).
  if (item.entry_zone_hi != null) {
    const hi = item.entry_zone_hi, lo = item.entry_zone_lo;
    let zoneVal = lo != null ? `${fmtNum(lo, 0)}–${fmtNum(hi, 0)}` : `≤ ${fmtNum(hi, 0)}`;
    if (price !== null && price !== undefined) {
      const distTop = ((price - hi) / hi) * 100;
      if (distTop > 0.5) zoneVal += ` <span class="badge-near-high">高出 ${fmtNum(distTop, 1)}%</span>`;
      else if (distTop < -0.5) zoneVal += ` <span class="badge-near-low">已入區/破底</span>`;
      else zoneVal += ` <span class="badge-mid">在區頂</span>`;
    }
    metrics.push(["🎯 進場區", zoneVal]);
  }
  if (data.nav !== null && data.nav !== undefined) {
    const premium = data.premium_pct;
    metrics.push(["NAV", fmtNum(data.nav, 2)]);
    if (premium !== null && premium !== undefined) {
      const premiumText = premium > 0 ? `溢價 ${fmtPct(premium)}` : `折價 ${fmtPct(premium)}`;
      const premiumCls = Math.abs(premium) > 1 ? (premium > 0 ? "down" : "up") : "flat";
      metrics.push(["折溢價", `<span class="${premiumCls}">${premiumText}</span>`]);
    }
  }
  if (data.dividend_yield_pct !== null && data.dividend_yield_pct !== undefined) {
    metrics.push(["殖利率", `<span class="up">${fmtPct(data.dividend_yield_pct, false)}</span>`]);
  }
  // 估值資訊 — 本益比(目前/預估) + 分析師平均目標價(含距現價%) + 評等 (Adam 2026-06-19 要求).
  // 指數/黃金沒有這些欄位 → Yahoo 回 null → 自動跳過不顯示，不亂編。
  // 負/零 本益比 = 虧損或無盈餘，乘數無意義 → 不顯示（不誤導）。
  if (data.trailing_pe !== null && data.trailing_pe !== undefined && data.trailing_pe > 0) {
    metrics.push(["本益比", fmtNum(data.trailing_pe, 1)]);
  }
  if (data.forward_pe !== null && data.forward_pe !== undefined && data.forward_pe > 0) {
    metrics.push(["預估本益比", fmtNum(data.forward_pe, 1)]);
  }
  // 年EPS(近四季加總 / TTM) — Yahoo trailingEps，財報後幾小時~1-2 天才重算；負值=虧損照實顯示。
  const hasAnnualEps = data.eps !== null && data.eps !== undefined;
  if (hasAnnualEps) {
    metrics.push(["年EPS", fmtCurrency(data.eps, data.currency || item.currency)]);
  }
  // 季EPS(最近單季公布值 = 拿來跟分析師預估比 beat/miss 的頭條數字)。只在有 EPS 的個股顯示
  // (指數/黃金/ETF 無 EPS 不需要這欄)。台股 Yahoo 常無單季 EPS → 顯示 ─ 明確標「沒資料」，
  // 而非默默消失讓人誤以為漏抓。
  if (hasAnnualEps) {
    const hasQ = data.eps_q !== null && data.eps_q !== undefined;
    metrics.push(["季EPS", hasQ ? fmtCurrency(data.eps_q, data.currency || item.currency) : "─"]);
  }
  // 毛利率 — Yahoo grossMargins 是小數(0.45)，×100 顯示百分比。
  if (data.gross_margins !== null && data.gross_margins !== undefined) {
    metrics.push(["毛利率", fmtPct(data.gross_margins * 100, false)]);
  }
  // 營收成長率 — 台股=月營收YoY(FinMind官方)/美股=季營收YoY(Yahoo)；成長加速度=本期YoY−前期YoY
  // (台股有;美股 Yahoo 只回溯5季算不出YoY-of-YoY→不顯示)。正=成長加速(漲紅)。
  if (data.rev_yoy_pct !== null && data.rev_yoy_pct !== undefined) {
    const per = data.rev_growth_period ? `(${data.rev_growth_period})` : "";
    metrics.push([`營收成長率${per}`, `<span class="${changeClass(data.rev_yoy_pct)}">${fmtPct(data.rev_yoy_pct)}</span>`]);
  }
  // 月增率/季增率 (Adam 2026-07-15): 上面的營收成長率是「跟去年同月比」, 會把月對月的
  // 回落藏起來 (旺矽 6 月 MoM -3.9% 但 YoY +65% 的盲點)。月增率=本月vs上月 (台股月營收才有);
  // 季增率=台股取最近3個月合計vs前一輪3個月合計 (滾動, 例 4/5/6 vs 1/2/3) / 美股=最新季vs前季。
  if (data.rev_mom_pct !== null && data.rev_mom_pct !== undefined) {
    metrics.push(["月增率", `<span class="${changeClass(data.rev_mom_pct)}">${fmtPct(data.rev_mom_pct)}</span>`]);
  }
  if (data.rev_qoq_pct !== null && data.rev_qoq_pct !== undefined) {
    metrics.push(["季增率", `<span class="${changeClass(data.rev_qoq_pct)}">${fmtPct(data.rev_qoq_pct)}</span>`]);
  }
  if (data.rev_accel_pp !== null && data.rev_accel_pp !== undefined) {
    const a = data.rev_accel_pp;
    const tag = a > 0.5 ? "↑加速" : a < -0.5 ? "↓減速" : "→持平";
    metrics.push(["成長加速度", `<span class="${changeClass(a)}">${a > 0 ? "+" : ""}${fmtNum(a, 1)}pp ${tag}</span>`]);
  }
  if (data.target_mean_price !== null && data.target_mean_price !== undefined) {
    let tgtVal = fmtCurrency(data.target_mean_price, data.currency || item.currency);
    if (price !== null && price !== undefined && price !== 0) {
      const upside = ((data.target_mean_price - price) / price) * 100;
      const upSign = upside > 0 ? "+" : "";
      tgtVal += ` <span class="${changeClass(upside)}">(距現價 ${upSign}${fmtNum(upside, 1)}%)</span>`;
    }
    metrics.push(["分析師目標", tgtVal]);
  }
  if (data.recommendation && data.recommendation !== "none") {
    const recMap = {
      strong_buy: "強力買進", buy: "買進", outperform: "優於大盤",
      hold: "中立", underperform: "劣於大盤", sell: "賣出", strong_sell: "強力賣出", none: "—",
    };
    const recZh = recMap[data.recommendation] || data.recommendation;
    const nAna = (data.num_analysts !== null && data.num_analysts !== undefined) ? ` · ${data.num_analysts} 位` : "";
    metrics.push(["分析師評等", `${recZh}${nAna}`]);
  }
  if (data.dist_from_high_pct !== null && data.dist_from_high_pct !== undefined) {
    const cls2 = distFromHighClass(data.dist_from_high_pct);
    const label = distFromHighLabel(data.dist_from_high_pct);
    metrics.push(["距 52W 高", `<span class="${cls2}">${fmtPct(data.dist_from_high_pct)} ${label}</span>`]);
  }
  // 成交量 + 量比 (Adam 2026-07-22): 盤中=今日累積量(證交所/Yahoo), 收盤=最近交易日量;
  // 量比 vs 20日均量 (v-tail 未抓到前退回 3個月均量), 爆量≥1.5× / 縮量≤0.6×.
  const vi = volumeInfo(item);
  if (vi && vi.vol != null) {
    const liveTag = vi.live ? `<span class="vol-live-tag" title="盤中累積量，收盤前逐步累積屬正常">盤中累積</span> ` : "";
    metrics.push([`📊 ${vi.label}`, `${liveTag}${fmtVolume(vi.vol, item)}`]);
    if (vi.ratio != null && isFinite(vi.ratio)) {
      metrics.push([`量比`, `<span title="與${vi.basis}相比${vi.live ? "（盤中累積，尚未收盤）" : ""}">${volumeBadge(vi.ratio, vi.live)}</span>`]);
    }
  }
  // 即時量比 (Adam 2026-07-23): 累積量÷(5日均量×已開盤時間比例) — 盤中任一時刻
  // 1×=步調正常, 補「量比」早盤結構性偏低的盲點。收盤後=全日量/5日均量。
  const rt = realtimeVolInfo(item);
  if (rt && rt.ratio != null && isFinite(rt.ratio)) {
    const meta = rt.live
      ? `已開盤${Math.round(rt.elapsed)}分・相對5日步調`
      : `收盤全日・相對5日均量${rt.asofBar ? "・" + rt.asofBar.slice(5).replace("-", "/") : ""}`;
    metrics.push(["⏱️ 即時量比", `<span title="今日累積量÷(近5個交易日均量×已開盤時間比例)，盤中 1×=正常步調">${volumeBadge(rt.ratio, rt.live, 2)}</span> <span class="sr-meta">${meta}</span>`]);
  }
  // 突波偵測 (Adam 2026-07-23「加」): 近10分鐘每分鐘量 vs 正常步調 — 盤中限定, 收盤不顯示。
  const bv = burstVolInfo(item);
  if (bv && bv.ratio != null) {
    metrics.push(["💥 瞬時量比", `<span title="近10分鐘每分鐘量÷正常每分鐘量(5日均攤平)，抓此刻正在爆量；≥3×=突波">${burstChip(bv.ratio)}</span> ${burstDirTag(bv.dir)} <span class="sr-meta">近10分 vs 正常步調</span>`]);
  }
  // 空單比例 (Adam 2026-07-23): 美股=FINRA 申報空單佔流通股 (雙週更, as-of 必show,
  // 附回補天數+較上月增減); 台股=(融券+借券賣出餘額)/發行股數 (每日盤後, 附兩本張數)。
  // ETF/指數無資料誠實不顯示。
  if (data.short_pct != null) {
    let meta;
    if (data.short_basis === "float") {
      const bits = ["佔流通股"];
      if (data.short_days_to_cover != null) bits.push(`回補約${fmtNum(data.short_days_to_cover, 1)}天`);
      if (data.short_shares != null && data.short_shares_prior) {
        const mom = (data.short_shares / data.short_shares_prior - 1) * 100;
        bits.push(`較上月${mom >= 0 ? "+" : "−"}${fmtNum(Math.abs(mom), 1)}%`);
      }
      if (data.short_asof) bits.push(String(data.short_asof).slice(5).replace("-", "/"));
      meta = bits.join(" · ");
    } else {
      const lots = (v) => (v == null ? null : Math.round(v / 1000).toLocaleString("en-US"));
      const parts = [];
      if (lots(data.short_margin_shares) != null) parts.push(`融券${lots(data.short_margin_shares)}張`);
      if (lots(data.short_sbl_shares) != null) parts.push(`借券${lots(data.short_sbl_shares)}張`);
      meta = parts.join("＋") || "佔發行股數";
      if (data.short_asof) meta += ` · ${String(data.short_asof).slice(5).replace("-", "/")}`;
    }
    metrics.push(["🩳 空單比例", `${fmtNum(data.short_pct, 2)}% <span class="sr-meta">${meta}</span>`]);
  }
  // 支撐/壓力 (Adam 2026-07-22; 2026-07-23 全列): 夠格的位階全部列出 (nearest 在前),
  // 每條 = 價位 + 距現價% + 匯合證據; 沒夠格的位誠實不顯示. 圖上虛線與此同一來源.
  if (price !== null && price !== undefined) {
    const sr = srLevels(item);
    const whyOf = (l) => `${l.touches} 次觸碰${l.hvn ? "・量密" : ""}${l.fib ? "・回撤位" : ""}${l.ma ? "・均線" : ""}`;
    const lvlHtml = (l, sign, d) =>
      `<span title="近期波段結構優先（±1.5% 帶）：${whyOf(l)}">${fmtLevel(l.px)} <span class="sr-meta">${sign}${fmtNum(d, 1)}%・${whyOf(l)}</span></span>`;
    if (sr.resistances.length) {
      metrics.push(["🧱 壓力", sr.resistances.map((r) => lvlHtml(r, "+", ((r.px - price) / price) * 100)).join("<br>")]);
    }
    if (sr.supports.length) {
      metrics.push(["🛟 支撐", sr.supports.map((s) => lvlHtml(s, "−", ((price - s.px) / price) * 100)).join("<br>")]);
    }
  }
  if (data.expense_ratio !== null && data.expense_ratio !== undefined) {
    metrics.push(["費用率", `${fmtNum(data.expense_ratio, 2)}%`]);
  }
  if (data.net_assets !== null && data.net_assets !== undefined) {
    metrics.push(["規模", fmtCompactCurrency(data.net_assets, data.currency || item.currency)]);
  }
  if (data.fifty_day_avg !== null && data.fifty_day_avg !== undefined) {
    metrics.push(["50D 均", fmtNum(data.fifty_day_avg, 2)]);
  }
  if (data.ytd_return_pct !== null && data.ytd_return_pct !== undefined) {
    const ytdCls = changeClass(data.ytd_return_pct);
    metrics.push(["YTD", `<span class="${ytdCls}">${fmtPct(data.ytd_return_pct)}</span>`]);
  }

  const metricsHtml = metrics.length
    ? `<div class="asset-metrics">${metrics
        .map(([k, v]) => `<span class="metric-label">${k}</span><span class="metric-value">${v}</span>`)
        .join("")}</div>`
    : "";

  // Range bar
  const rangeHtml = data.price !== null && data.fifty_two_week_low !== null && data.fifty_two_week_high !== null
    ? `<div class="range-bar-wrap">${rangeBarHtml(data.price, data.fifty_two_week_low, data.fifty_two_week_high)}</div>`
    : "";

  // PnL — shown whenever the item carries cost/PnL (holdings). Copilot mode has
  // none, but a future holding shows PnL inside its market tab card.
  let pnlHtml = "";
  if (item.unrealized_pnl !== undefined && item.unrealized_pnl !== null) {
    const pnlCls = changeClass(item.unrealized_pnl);
    pnlHtml = `
      <div class="pnl-row">
        <span class="pnl-label">市值 / 損益</span>
        <span class="pnl-value ${pnlCls}">
          ${fmtCurrency(item.market_value, item.currency)} ·
          ${item.unrealized_pnl > 0 ? "+" : ""}${fmtCurrency(item.unrealized_pnl, item.currency)}
          (${fmtPct(item.unrealized_pnl_pct)})
        </span>
      </div>
      <div class="pnl-row">
        <span class="pnl-label">持倉 / 成本</span>
        <span class="pnl-value">
          ${item.quantity_oz !== undefined
            ? `${fmtNum(item.quantity_oz, 2)} oz`
            : `${fmtNum(item.shares || 0, 0)} 股`} ·
          ${fmtCurrency(item.cost_basis_usd_per_oz || item.cost_basis || 0, item.currency)}
        </span>
      </div>
    `;
  }

  // Trend chart block (all non-error cards)
  const srPeek = srLevels(item);  // overlay 按鈕 disabled 判定 (與 CARD_META.sr 同一來源函式)
  const chartHtml = chartBlockHtml(
    canvasId,
    item.entry_zone_hi != null,
    !!(srPeek.supports.length || srPeek.resistances.length)
  );

  const notesHtml = stockInfoHtml(item);

  // Drag handle in every sortable market tab (台股 / 美股 / 指數).
  const dragHandle = sortable
    ? '<span class="drag-handle" title="按住拖拉排序">⠿</span>' : "";

  return `
    <div class="asset-card${pinnedCardCls}" data-card="${escapeHtml(section + "-" + item.id)}">
      <div class="asset-head">
        ${dragHandle}
        <div class="asset-name-block">
          <div class="asset-name">${escapeHtml(item.name || item.id)}</div>
          <div class="asset-symbol">${escapeHtml(item.symbol || "–")} · ${escapeHtml(item.theme || data.exchange || "")}</div>
        </div>
        ${typeTag}
        ${pinBtn}
      </div>
      ${priceRow}
      ${metricsHtml}
      ${rangeHtml}
      ${pnlHtml}
      ${chartHtml}
      ${notesHtml}
    </div>
  `;
}

// ========== Entry-zone watch (進場區內) ==========
// Scan watchlist/holdings for names whose live price has fallen into (or below)
// their configured entry zone [lo, hi]. Powers the top-summary 進場區內 card so
// Adam sees at a glance which names are at actionable buy levels — none -> 無.
// (Adam 2026-06-17: 紅圈那塊改列進入進場區的股票名單，沒有就寫「無」。)
// Per-tab (Adam 2026-07-22: 台股分頁只顯示台股進場區名單, 美股分頁只顯示美股的).
// Each entry carries its market tab + card id so the row can jump to the card.
function entryZoneEntries(snapshot, tab) {
  const items = [
    ...((snapshot && snapshot.watchlist) || []),
    ...((snapshot && snapshot.holdings) || []),
  ];
  const out = [];
  for (const item of items) {
    const itemTab = tabForItem(item);
    if (tab && itemTab !== tab) continue;            // summary follows the active market tab
    const hi = item.entry_zone_hi;
    if (hi == null) continue;                        // no zone defined -> skip
    const price = item.data && item.data.price;
    if (price == null) continue;                     // no live price -> skip
    const distTop = ((price - hi) / hi) * 100;       // % above zone top
    if (distTop > 0.5) continue;                      // still above zone (waiting) -> skip
    const lo = item.entry_zone_lo;
    let state, pct;
    if (lo != null && price < lo) {
      state = "破底";                                 // dropped below the zone bottom
      pct = ((lo - price) / lo) * 100;                // how far below lo
    } else {
      state = "在區內";                               // within the buy zone (incl. hi-only)
      pct = null;
    }
    out.push({ name: item.name || item.id, id: item.id, tab: itemTab, state, pct, distTop });
  }
  out.sort((a, b) => a.distTop - b.distTop);          // deepest into the zone first
  return out;
}

// 總覽卡拖曳 (Adam 2026-07-23「排行榜/進場區內卡片也做成可以拖曳更動位置」):
// 每張 summary card 帶 data-sum key + ⠿ handle, 順序存 abraham.sumorder (prefs-synced)。
const SUMMARY_DRAG_HANDLE = '<span class="drag-handle" title="按住拖拉排序">⠿</span>';

function zoneCardHtml(snapshot, tab) {
  const entries = entryZoneEntries(snapshot, tab);
  let body;
  if (!entries.length) {
    body = `<div class="zone-empty">無</div>`;
  } else {
    body = `<div class="zone-list">` + entries.map((e) => {
      const cls = e.state === "破底" ? "zone-below" : "zone-in";
      const tail = e.state === "破底" ? `破底 ${fmtNum(e.pct, 1)}%` : "在區內";
      return `<div class="zone-row jump-row" data-jump-tab="${escapeHtml(e.tab)}" data-jump-id="${escapeHtml(e.id)}" title="點一下跳到這張卡"><span class="zone-name">${escapeHtml(e.name)}</span><span class="${cls}">${tail}</span></div>`;
    }).join("") + `</div>`;
  }
  const mkt = MARKET_TAB_LABEL[tab] || "";
  const sub = entries.length ? `${entries.length} 檔現價落入買進區` : "目前皆在進場區之上";
  return `
    <div class="summary-card zone-card" data-sum="zone">
      <div class="summary-label">${SUMMARY_DRAG_HANDLE}🎯 進場區內 <span class="summary-label-mkt">${mkt}</span></div>
      ${body}
      <div class="summary-sub">${sub}</div>
    </div>`;
}

// ========== 回檔深度排行榜 (Adam 2026-07-22, 取代原「觀察清單」計數卡) ==========
// Depth = 現價 vs 近一個月最高收盤 (Adam 指定一個月高點; close-basis, 含今日 live 價).
// Top 10 deepest, per market tab. Rows jump to the card on click.
function pullbackEntries(snapshot, tab) {
  const bucket = (snapshot && snapshot[tab]) || [];
  const out = [];
  for (const item of bucket) {
    if (item.status === "error") continue;
    const data = item.data || {};
    const price = data.price;
    const daily = (data.history && data.history.daily) || [];
    if (price == null || daily.length < 5) continue;   // 掛牌太新/沒價 → 不排
    let hi = price;                                     // 今日 live 價也算候選高點
    for (let i = Math.max(0, daily.length - 22); i < daily.length; i++) {
      const c = daily[i] && daily[i].c;
      if (c != null && c > hi) hi = c;
    }
    if (!hi) continue;
    const depth = ((price - hi) / hi) * 100;            // ≤ 0
    out.push({ name: item.name || item.id, id: item.id, tab, depth });
  }
  out.sort((a, b) => a.depth - b.depth);                // 最深(最負)在前
  return out.slice(0, 10);
}

function pullbackCardHtml(snapshot, tab) {
  const entries = pullbackEntries(snapshot, tab);
  let body;
  if (!entries.length) {
    body = `<div class="zone-empty">–</div>`;
  } else {
    body = `<div class="pullback-list">` + entries.map((e, i) => {
      const depthCls = e.depth <= -0.05 ? "down" : "flat";  // 跌 = 綠 (漲紅跌綠鐵則)
      return `<div class="pullback-row jump-row" data-jump-tab="${escapeHtml(e.tab)}" data-jump-id="${escapeHtml(e.id)}" title="點一下跳到這張卡">
        <span class="pullback-rank">${i + 1}</span>
        <span class="pullback-name">${escapeHtml(e.name)}</span>
        <span class="pullback-depth ${depthCls}">${fmtNum(e.depth, 1)}%</span>
      </div>`;
    }).join("") + `</div>`;
  }
  const mkt = MARKET_TAB_LABEL[tab] || "";
  return `
    <div class="summary-card pullback-card" data-sum="pullback">
      <div class="summary-label">${SUMMARY_DRAG_HANDLE}📉 回檔深度排行 <span class="summary-label-mkt">${mkt}</span></div>
      ${body}
      <div class="summary-sub">距近 1 個月最高收盤的跌幅 · 前 10 名</div>
    </div>`;
}

// ========== 成交量/量比/即時量比排行榜 (Adam 2026-07-23, 前 10 名, 跟分頁走) ==========
// 與卡片 📊/量比/⏱️ 同源 (volumeInfo / realtimeVolInfo): 盤中=今日累積量(證交所/Yahoo
// relay), 收盤=最近交易日量; 量比 vs 20日均量; 即時量比=按開盤時間折算 vs 5日步調。
// live tick 重繪 → 盤中會動。
function volumeBoardEntries(snapshot, tab, kind) {
  const bucket = (snapshot && snapshot[tab]) || [];
  const out = [];
  for (const item of bucket) {
    if (item.status === "error") continue;
    let val, live, dir;
    if (kind === "rt") {
      const rt = realtimeVolInfo(item);
      if (!rt) continue;
      val = rt.ratio; live = rt.live;
    } else if (kind === "burst") {
      const bv = burstVolInfo(item);
      if (!bv) continue;             // 盤中限定 — 收盤時整張榜自然空
      val = bv.ratio; live = true; dir = bv.dir;
    } else {
      const vi = volumeInfo(item);
      if (!vi) continue;
      val = kind === "ratio" ? vi.ratio : vi.vol;
      live = vi.live;
    }
    if (val == null || !isFinite(val)) continue;
    const chg = (item.data || {}).change_pct;   // 即時單日漲跌幅 (Adam 2026-07-23: 榜內附註+紅漲綠跌著色)
    out.push({ name: item.name || item.id, id: item.id, tab, val, live, dir, chg, item });
  }
  out.sort((a, b) => b.val - a.val);                    // 大在前
  return out.slice(0, 10);
}

function volumeBoardCardHtml(snapshot, tab, kind) {
  const entries = volumeBoardEntries(snapshot, tab, kind);
  let body;
  if (!entries.length) {
    body = `<div class="zone-empty">${kind === "burst" ? "盤中限定・目前收盤" : "–"}</div>`;
  } else {
    // vol/ratio/rt 三榜 (Adam 2026-07-23): 名稱+資訊文字紅漲綠跌、量值後附即時漲跌幅;
    // 量比/即時量比的爆量/縮量晶片維持自己的色系 (爆量恆紅), 只有其餘文字跟漲跌轉色。
    body = `<div class="pullback-list">` + entries.map((e, i) => {
      const cc = kind === "burst" ? "" : changeClass(e.chg);
      const nameCls = cc === "up" || cc === "down" ? cc : "";   // 平盤/無資料的名稱不轉灰, 維持預設色
      const valHtml = kind === "ratio" ? volumeBadge(e.val, e.live)   // 沿用卡片爆量/縮量晶片語言
        : kind === "rt" ? volumeBadge(e.val, e.live, 2)
        : kind === "burst" ? `${burstDirTag(e.dir, true)} ${burstChip(e.val)}`
        : `<span class="pullback-depth ${cc || "flat"}">${fmtVolume(e.val, e.item)}</span>`;
      const chgHtml = kind !== "burst" && e.chg != null
        ? `<span class="board-chg ${cc || "flat"}">${fmtPct(e.chg)}</span>` : "";
      return `<div class="pullback-row jump-row" data-jump-tab="${escapeHtml(e.tab)}" data-jump-id="${escapeHtml(e.id)}" title="點一下跳到這張卡">
        <span class="pullback-rank">${i + 1}</span>
        <span class="pullback-name ${nameCls}">${escapeHtml(e.name)}</span>
        ${valHtml}${chgHtml}
      </div>`;
    }).join("") + `</div>`;
  }
  const mkt = MARKET_TAB_LABEL[tab] || "";
  const title = kind === "ratio" ? "⚡ 量比排行" : kind === "rt" ? "⏱️ 即時量比排行"
    : kind === "burst" ? "💥 突波偵測" : "📊 成交量排行";
  const sub = kind === "ratio" ? "相對 20 日均量的倍數 · 前 10 名"
    : kind === "rt" ? "依開盤時間折算 · 1×=5日正常步調 · 前 10 名"
    : kind === "burst" ? "近10分鐘 vs 正常步調 · 盤中限定 · ≥3×=突波"
    : "盤中為今日累積量 · 前 10 名";
  return `
    <div class="summary-card pullback-card" data-sum="${kind}">
      <div class="summary-label">${SUMMARY_DRAG_HANDLE}${title} <span class="summary-label-mkt">${mkt}</span></div>
      ${body}
      <div class="summary-sub">${sub}</div>
    </div>`;
}

// ========== 漲幅/跌幅排行榜 (Adam 2026-07-23「漲幅前10 跌幅前10 兩張卡片」) ==========
// 依即時單日漲跌幅 change_pct 排序 (liveRefresh 每 tick 更新, 見 2375/2440 → 盤中會動),
// 跟分頁走。漲幅榜 = 只收上漲 (chg>0) 由大到小前 10; 跌幅榜 = 只收下跌 (chg<0) 由小到大
// 前 10 (看盤軟體慣例: 漲幅榜不混入下跌股)。全部紅漲綠跌 (漲幅榜恆紅/跌幅榜恆綠), 可點跳卡。
function changeBoardEntries(snapshot, tab, dir) {
  const bucket = (snapshot && snapshot[tab]) || [];
  const out = [];
  for (const item of bucket) {
    if (item.status === "error") continue;
    const chg = (item.data || {}).change_pct;
    if (chg == null || !isFinite(chg)) continue;
    if (dir === "gain" ? chg > 0 : chg < 0) {
      out.push({ name: item.name || item.id, id: item.id, tab, chg });
    }
  }
  out.sort((a, b) => (dir === "gain" ? b.chg - a.chg : a.chg - b.chg));  // 漲幅大在前 / 跌幅深在前
  return out.slice(0, 10);
}

function changeBoardCardHtml(snapshot, tab, dir) {
  const entries = changeBoardEntries(snapshot, tab, dir);
  let body;
  if (!entries.length) {
    body = `<div class="zone-empty">–</div>`;
  } else {
    body = `<div class="pullback-list">` + entries.map((e, i) => {
      const cc = changeClass(e.chg);                       // up=紅 / down=綠 (漲紅跌綠鐵則)
      const nameCls = cc === "up" || cc === "down" ? cc : "";
      return `<div class="pullback-row jump-row" data-jump-tab="${escapeHtml(e.tab)}" data-jump-id="${escapeHtml(e.id)}" title="點一下跳到這張卡">
        <span class="pullback-rank">${i + 1}</span>
        <span class="pullback-name ${nameCls}">${escapeHtml(e.name)}</span>
        <span class="pullback-depth ${cc || "flat"}">${fmtPct(e.chg)}</span>
      </div>`;
    }).join("") + `</div>`;
  }
  const mkt = MARKET_TAB_LABEL[tab] || "";
  const title = dir === "gain" ? "🔺 漲幅排行" : "🔻 跌幅排行";
  const sub = dir === "gain" ? "即時單日漲幅 · 前 10 名" : "即時單日跌幅 · 前 10 名";
  return `
    <div class="summary-card pullback-card" data-sum="${dir === "gain" ? "gainers" : "losers"}">
      <div class="summary-label">${SUMMARY_DRAG_HANDLE}${title} <span class="summary-label-mkt">${mkt}</span></div>
      ${body}
      <div class="summary-sub">${sub}</div>
    </div>`;
}

// ========== Portfolio Summary ==========
// Summary cards follow the active MARKET tab (Adam 2026-07-22): 進場區內 + 回檔深度排行
// both filter to 台股/美股/指數. The old 觀察清單 count card is retired (排行榜取代).
function renderSummary(summary, snapshot) {
  const el = document.getElementById("portfolio-summary");
  const tab = ACTIVE_MARKET_TAB;
  // Keyed cards (Adam 2026-07-23 拖曳): default order = 陳列順序; saved abraham.sumorder wins.
  const boards = [
    { k: "zone", html: zoneCardHtml(snapshot, tab) },
    { k: "pullback", html: pullbackCardHtml(snapshot, tab) },
    { k: "gainers", html: changeBoardCardHtml(snapshot, tab, "gain") },  // Adam 2026-07-23 漲幅前10
    { k: "losers", html: changeBoardCardHtml(snapshot, tab, "lose") },   // Adam 2026-07-23 跌幅前10
    { k: "vol", html: volumeBoardCardHtml(snapshot, tab, "vol") },       // Adam 2026-07-23
    { k: "ratio", html: volumeBoardCardHtml(snapshot, tab, "ratio") },
    { k: "rt", html: volumeBoardCardHtml(snapshot, tab, "rt") },         // 即時量比 (Adam 2026-07-23)
    { k: "burst", html: volumeBoardCardHtml(snapshot, tab, "burst") },   // 突波偵測 (Adam 2026-07-23「加」)
  ];

  // Copilot mode: no tracked positions -> 排行榜 cards only (no empty 總市值 cards).
  if (!summary || !summary.holdings_count) {
    el.innerHTML = orderSummaryCards(boards).map((c) => c.html).join("");
    initSummaryDrag(el);
    return;
  }

  const mv = summary.total_market_value_usd_equiv;
  const cost = summary.total_cost_usd_equiv;
  const pnl = summary.total_unrealized_pnl_usd_equiv;
  const pnlPct = summary.total_unrealized_pnl_pct;

  const cards = [
    { k: "mv", html: `
    <div class="summary-card" data-sum="mv">
      <div class="summary-label">${SUMMARY_DRAG_HANDLE}總市值</div>
      <div class="summary-value">${mv ? fmtCompactCurrency(mv, "USD") : "–"}</div>
      <div class="summary-sub">持倉 ${summary.holdings_count} 檔</div>
    </div>` },
    { k: "cost", html: `
    <div class="summary-card" data-sum="cost">
      <div class="summary-label">${SUMMARY_DRAG_HANDLE}總成本</div>
      <div class="summary-value">${cost ? fmtCompactCurrency(cost, "USD") : "–"}</div>
      <div class="summary-sub">已投入資金</div>
    </div>` },
    { k: "pnl", html: `
    <div class="summary-card" data-sum="pnl">
      <div class="summary-label">${SUMMARY_DRAG_HANDLE}未實現損益</div>
      <div class="summary-value ${changeClass(pnl)}">
        ${pnl !== null && pnl !== undefined ? fmtCompactCurrency(pnl, "USD") : "–"}
      </div>
      <div class="summary-sub ${changeClass(pnlPct)}">${fmtPct(pnlPct)}</div>
    </div>` },
  ].concat(boards);

  el.innerHTML = orderSummaryCards(cards).map((c) => c.html).join("");
  initSummaryDrag(el);
}

// ========== Market tabs (台股 / 美股 / 指數) ==========
// Adam 2026-06-17: 網頁上方三個標籤頁，各檔分門別類；黃金暫放指數頁。
// Bucket every tracked item by market. Holdings + watchlist split into 台股/美股
// by type; 黃金 (commodity) and all 大盤指數 go to 指數. Buckets hold REFERENCES
// to the same item objects, so live-quote mutations (refreshOneCard) show up
// without re-bucketing.
function tabForItem(item) {
  const t = item.type || "";
  if (t.startsWith("tw_")) return "tw";   // tw_stock / tw_etf -> 台股
  if (t === "commodity") return "idx";    // 黃金 -> 指數頁 (Adam 2026-06-17)
  return "us";                            // us_stock / us_etf / 其他 -> 美股
}

function bucketSnapshot(snapshot) {
  const tw = [], us = [], idx = [];
  // Holdings live in their own 即時持倉 tab now — do NOT also bucket them into the
  // market tabs, or a held+watched stock shows twice (2026-07-06 欣興 duplicate fix).
  for (const item of (snapshot.watchlist || [])) {
    const tab = tabForItem(item);
    (tab === "tw" ? tw : tab === "idx" ? idx : us).push(item);
  }
  for (const item of (snapshot.indices || [])) idx.push(item);  // 大盤指數 -> 指數頁
  snapshot.tw = tw;
  snapshot.us = us;
  snapshot.idx = idx;
}

// Switch the visible market tab. Charts created while a panel was display:none
// render at 0×0, so resize this tab's charts once it becomes visible.
// Two-level nav (Adam 2026-07-22): 最外層 台股/美股/指數/即時持倉/模擬倉 五大項;
// 模擬倉 active 時才顯示六本子分頁, 並記住上次看的那本 (abraham.simBook, prefs-synced).
function activateTab(which, doResize = true) {
  if (!which) return;
  // Legacy migration: a saved activeTab like "sim-tw-2" (pre-2026-07-22 flat tabs, may
  // still live in cloud prefs) folds into the 模擬倉 group with that book selected.
  if (which.startsWith("sim-")) { lsSet("abraham.simBook", which); which = "sim"; }
  document.querySelectorAll(".market-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === which));
  const subRow = document.getElementById("sim-subtabs");
  if (subRow) subRow.classList.toggle("open", which === "sim");
  if (which === "sim") {
    activateSimBook(lsGet("abraham.simBook", "sim-tw-1"), doResize);
  } else {
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + which));
  }
  lsSet("abraham.activeTab", which);
  // Adam 2026-07-24: 即時持倉(pos)/模擬倉(sim) 兩分頁隱藏排行榜/進場區總覽卡列（那兩頁有自己的內容）;
  // 回 台股/美股/指數 再顯示。切分頁時 renderSummary 仍會更新 innerHTML，但元素維持 display:none 不露出。
  const summaryEl = document.getElementById("portfolio-summary");
  if (summaryEl) summaryEl.style.display = (which === "pos" || which === "sim") ? "none" : "";
  // Summary cards (進場區內/回檔排行) follow the market tab; sim/pos keep the last market view.
  if (which === "tw" || which === "us" || which === "idx") {
    applySort(which);  // 切分頁 = 重排白名單時機 (Adam 2026-07-23: 自動更新凍結順序, 切分頁時套最新排序)
    if (which !== ACTIVE_MARKET_TAB) {
      ACTIVE_MARKET_TAB = which;
      if (CURRENT_SNAPSHOT) renderSummary(CURRENT_SNAPSHOT.portfolio_summary, CURRENT_SNAPSHOT);
    }
  }
  if (doResize && which !== "sim") {
    CHART_INSTANCES.forEach((chart, cid) => {
      if (cid.startsWith("chart-" + which + "-")) { try { chart.resize(); } catch (e) { /* ignore */ } }
    });
  }
}

function activateSimBook(book, doResize = true) {
  if (!SIM_BOOKS.some((b) => b.key === book)) book = "sim-tw-1";  // stale/garbage pref -> default
  document.querySelectorAll(".sim-subtab").forEach((t) => t.classList.toggle("active", t.dataset.simbook === book));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + book));
  lsSet("abraham.simBook", book);
  if (doResize) {
    CHART_INSTANCES.forEach((chart, cid) => {
      if (cid.startsWith("chart-" + book + "-")) { try { chart.resize(); } catch (e) { /* ignore */ } }
    });
  }
}

// 模擬倉 top-level badge = 六本 (持倉+掛單) 加總 — refreshed as each book's data lands.
function updateSimAggregateCount() {
  let total = 0, any = false;
  for (const { key } of SIM_BOOKS) {
    const pf = (SIM_SNAPS[key] && SIM_SNAPS[key].portfolio) || null;
    if (!pf) continue;
    any = true;
    total += (pf.positions || []).length + (pf.pending_orders || []).length;
  }
  setText("tab-count-sim", any ? total : "–");
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function renderGrid(section, items, emptyMsg) {
  const grid = document.getElementById(section + "-grid");
  if (!grid) return;
  grid.innerHTML = items && items.length
    ? items.map((item) => buildAssetCard(item, section)).join("")
    : `<div class="loading">${emptyMsg}</div>`;
}

// ========== Main Render ==========
// Render a snapshot object into the page. Shared by the initial snapshot load
// and the live-refresh path so price/badges/range/chart all update uniformly.
function renderSnapshot(snapshot, opts = {}) {
  // Destroy existing charts before re-render — otherwise Chart.js leaks canvases.
  for (const chart of CHART_INSTANCES.values()) {
    try { chart.destroy(); } catch (e) { /* ignore */ }
  }
  CHART_INSTANCES.clear();
  CARD_HISTORY.clear();
  CARD_META.clear();

  // Timestamp — live refresh shows the wall-clock fetch time + a freshness note.
  const tsEl = document.getElementById("timestamp");
  if (opts.live) {
    const now = new Date().toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
    tsEl.textContent = `🟢 即時報價 ${now} (Taipei)` + (opts.note ? ` · ${opts.note}` : "");
  } else {
    const ts = new Date(snapshot.timestamp_utc);
    tsEl.textContent = `資料時間：${ts.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })} (Taipei)`;
  }

  // Bucket every tracked item into the 3 market tabs (台股/美股/指數).
  bucketSnapshot(snapshot);
  buildSearchIndex(snapshot);

  // Counts — header pill = grand total; per-tab counts on tab buttons + headers.
  const total = snapshot.tw.length + snapshot.us.length + snapshot.idx.length;
  setText("item-count", `${total} items`);
  setText("tab-count-tw", snapshot.tw.length);
  setText("tab-count-us", snapshot.us.length);
  setText("tab-count-idx", snapshot.idx.length);
  setText("tw-count", `${snapshot.tw.length} 檔`);
  setText("us-count", `${snapshot.us.length} 檔`);
  setText("idx-count", `${snapshot.idx.length} 檔`);

  renderSummary(snapshot.portfolio_summary, snapshot);

  // 自動更新不跳位 (Adam 2026-07-23): 30s live tick / 盤外自動 reload 帶 keepOrder=true —
  // 先記下重建前的卡片順序, 重建+setupOrdering 後還原 (數字全新、位置不動)。
  // 重排只發生在使用者動作: 切排序選單 / 重新整理 / ↻ 全部重抓 / 切分頁 (activateTab)。
  const prevOrder = opts.keepOrder ? ORDER_SECTIONS.map((s) => {
    const g = document.getElementById(s + "-grid");
    return [s, g ? Array.from(g.querySelectorAll(".asset-card")).map((c) => c.dataset.card).filter(Boolean) : []];
  }) : null;

  // 自動更新保留使用者選的時間軸 (Adam 2026-07-24): 30s 即時 / 抓即時 / 盤外 reload 會整批重畫卡片,
  // 重畫後每張圖的 scope-btn 都被設回預設(1d) → 使用者研究某檔時每 30 秒被打回預設, 很煩。
  // 先記下各卡當下 active 的 scope(只記非預設的), 重畫完再還原。只在 keepOrder(非破壞性自動更新)時做 —
  // 初次載入 / ↻全部重抓 / F5 走一般 render(keepOrder=false) → 回預設, 符合 Adam「不要有記憶性、
  // 頁面重新整理再回預設」(不寫 localStorage, reload 自然清空)。
  const prevScopes = opts.keepOrder ? (() => {
    const m = new Map();
    document.querySelectorAll("#tw-grid .asset-card, #us-grid .asset-card, #idx-grid .asset-card").forEach((c) => {
      const key = c.dataset.card;
      const s = c.querySelector(".scope-btn.active")?.dataset.scope;
      if (key && s && s !== DEFAULT_SCOPE) m.set(key, s);
    });
    return m;
  })() : null;

  // Render each market tab's grid (台股 / 美股 / 指數含黃金)
  renderGrid("tw", snapshot.tw, "（台股清單為空）");
  renderGrid("us", snapshot.us, "（美股清單為空）");
  renderGrid("idx", snapshot.idx, "（無指數資料）");

  initializeCharts(snapshot.tw, "tw");
  initializeCharts(snapshot.us, "us");
  initializeCharts(snapshot.idx, "idx");

  setupOrdering();
  if (prevOrder) {
    for (const [s, keys] of prevOrder) {
      const g = document.getElementById(s + "-grid");
      if (!g || keys.length < 2) continue;
      for (const key of keys) {
        const n = g.querySelector('[data-card="' + CSS.escape(key) + '"]');
        if (n) g.appendChild(n);   // appendChild = move; canvas/chart 不重建 (同 applySort 機制)
      }
    }
  }

  // 還原各卡使用者手動切的時間軸(scope) — 與 refreshOneCard(line ~2513) 相同機制: 點一下該
  // scope-btn, 委派在 document(line 622) 的 click handler 會設 active + renderChart 重畫成該刻度。
  // 只還原非預設的卡(通常只有使用者剛切過的 1-2 張), 不多花 render。
  if (prevScopes && prevScopes.size) {
    for (const [key, s] of prevScopes) {
      const node = document.querySelector('[data-card="' + CSS.escape(key) + '"]');
      const sb = node && node.querySelector('.scope-btn[data-scope="' + s + '"]');
      if (sb) sb.click();
    }
  }
}

async function loadAndRender(opts = {}) {
  const refreshBtn = document.getElementById("refresh-btn");
  refreshBtn.textContent = "…";
  try {
    const res = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snapshot = await res.json();
    await loadProfiles();   // 個股簡介/大日子/深讀新聞 — 先載好再 render, 卡片一次到位
    CURRENT_SNAPSHOT = snapshot;
    renderSnapshot(snapshot, opts.keepOrder ? { keepOrder: true } : {});
    loadHoldings();  // 即時持倉分頁 — independent fetch, own error handling
    loadSim();       // 模擬倉分頁 — independent fetch, own error handling
  } catch (err) {
    console.error("Failed to load data:", err);
    document.getElementById("timestamp").textContent = `❌ 載入失敗：${err.message}`;
    const errHtml = `<div class="loading">無法載入 ${DATA_URL}<br><small>${err.message}</small></div>`;
    ["tw", "us", "idx"].forEach((s) => { const g = document.getElementById(s + "-grid"); if (g) g.innerHTML = errHtml; });
  } finally {
    refreshBtn.textContent = "↻";
  }
}

// ========== 即時持倉 + ATR 移動停利 (Adam 2026-07-06, 第四分頁) ==========
// Data source: docs/data/holdings.json, written by scripts/holdings_atr.py.
// Method: reference_trailing_stop_exit_methodology (肌肉書僮 移動停利).
function loadHoldings() {
  const grid = document.getElementById("pos-grid");
  fetch(HOLDINGS_URL + "?t=" + Date.now(), { cache: "no-store" })
    .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .then((snap) => { HOLDINGS_SNAP = snap; renderHoldings(snap); })
    .catch((err) => {
      // A holdings failure must never break the other 3 tabs — just note it here.
      console.warn("holdings load failed:", err);
      setText("tab-count-pos", "–");
      setText("pos-count", "–");
      if (grid) grid.innerHTML = `<div class="loading">持倉資料尚未產生<br><small>${escapeHtml(err.message)}</small></div>`;
    });
}

function renderHoldings(snap) {
  const holdings = (snap && snap.holdings) || [];
  const grid = document.getElementById("pos-grid");
  const summaryEl = document.getElementById("pos-summary");
  setText("tab-count-pos", holdings.length || "–");
  setText("pos-count", `${holdings.length} 檔`);
  if (!grid) return;

  if (!holdings.length) {
    if (summaryEl) summaryEl.innerHTML = "";
    grid.innerHTML = `<div class="pos-empty">
        <div class="pos-empty-icon">🎯</div>
        <div class="pos-empty-title">尚無持倉紀錄</div>
        <div class="pos-empty-body">跟我說你買了什麼（股票、幾股、平均成本、買進日期），我就把它加進來，<br>即時幫你算 ATR 移動停損價、距離、以及該不該分批鎖利保本。</div>
      </div>`;
    return;
  }

  if (summaryEl) {
    // Recompute P&L from the holdings actually shown (so it matches live-refreshed cards).
    const pnlByCur = {};
    for (const h of holdings) {
      if (h.unrealized_pnl != null) pnlByCur[h.currency || "?"] = (pnlByCur[h.currency || "?"] || 0) + h.unrealized_pnl;
    }
    const parts = Object.entries(pnlByCur).map(([cur, v]) => {
      const cls = changeClass(v);   // 漲紅跌綠：獲利=up=紅，虧損=down=綠
      return `<span class="pos-sum-pnl ${cls}">${escapeHtml(cur)} 未實現 ${v >= 0 ? "+" : ""}${fmtCurrency(v, cur, 0)}</span>`;
    });
    let stamp = "";
    if (snap._liveTs || snap._quoteTs) {
      // Stamp the PRICE's own time (quote asOf), not the fetch time — honest about any lag.
      const qts = snap._quoteTs || snap._liveTs;
      const t = new Date(qts).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }).slice(0, 5);
      const delayMin = snap._quoteTs && snap._liveTs ? Math.round((snap._liveTs - snap._quoteTs) / 60000) : 0;
      if (snap._session === "closed") {
        // Market closed → official close (證交所). 距停損 is off the daily ATR, computed on the close.
        stamp = `<span class="pos-sum-asof">🕒 收盤 ${t} (Taipei) · 停損為日線 ATR · 已收盤</span>`;
      } else if (delayMin >= 3) {
        stamp = `<span class="pos-sum-asof pos-sum-delayed">🟡 報價 ${t} (Taipei) · 資料源延遲約 ${delayMin} 分 · 非即時</span>`;
      } else {
        stamp = `<span class="pos-sum-asof pos-sum-live">🟢 盤中即時 ${t} (Taipei) · 距停損隨價跳動</span>`;
      }
    } else if (snap.timestamp_utc) {
      const asof = new Date(snap.timestamp_utc).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      stamp = `<span class="pos-sum-asof">🕒 收盤價 ${asof} (Taipei) · 停損為日線 ATR</span>`;
    }
    summaryEl.innerHTML = `<div class="pos-sum-row">${parts.join("")}${stamp}</div>`;
  }

  grid.innerHTML = holdings.map(buildHoldingCard).join("");
}

// Live recompute of one holding's 距停損 / 燈號 / 損益 off a fresh intraday price, using the
// daily-computed stop + ATR from holdings.json. Mirrors scripts/holdings_atr.py exactly so
// the intraday numbers are continuous with the close-of-day ones. (Adam 2026-07-06: 盤中即時距停損)
function recomputeHoldingLive(h, livePrice) {
  const out = { ...h, price: livePrice };
  if (h.prev_close) out.change_pct = (livePrice - h.prev_close) / h.prev_close * 100;
  const stop = h.trailing_stop, atr = h.atr_used;
  if (stop != null && atr) {
    out.dist_to_stop_pct = (livePrice - stop) / livePrice * 100;
    out.buffer_atr = (livePrice - stop) / atr;
    if (livePrice <= stop) { out.status = "hit"; out.status_label = "🔴 跌破移動停損（該走）"; }
    else if (out.buffer_atr <= 1) { out.status = "near"; out.status_label = "🟡 接近停損（剩 <1×ATR 緩衝）"; }
    else { out.status = "hold"; out.status_label = "🟢 抱著（停損在下方）"; }
  }
  if (h.shares && h.cost_basis) {
    out.market_value = h.shares * livePrice;
    out.unrealized_pnl = h.shares * (livePrice - h.cost_basis);
    out.unrealized_pnl_pct = (livePrice - h.cost_basis) / h.cost_basis * 100;
  }
  return out;
}

// Apply live quotes (already fetched by liveRefresh) to the 即時持倉 tab and re-render.
// The stop LEVEL stays daily; price / 距停損 / 燈號 / 損益 update every live tick (~30s).
function applyLiveToHoldings(quotes, liveTs) {
  if (!HOLDINGS_SNAP || !((HOLDINGS_SNAP.holdings || []).length)) return;
  let anyLive = false;
  let quoteTs = null;        // newest quote asOf among held symbols (ms) → stamp shows the price's real time
  let quoteSession = null;   // session of that newest quote ("regular"/"closed") → 收盤 vs 即時 stamp
  const holdings = HOLDINGS_SNAP.holdings.map((h) => {
    const q = quotes[h.symbol];
    if (q && q.ok && q.price != null) {
      anyLive = true;
      if (q.asOf) { const ms = q.asOf * 1000; if (!quoteTs || ms > quoteTs) { quoteTs = ms; quoteSession = q.session || null; } }
      return recomputeHoldingLive(h, q.price);
    }
    return h;
  });
  renderHoldings({ ...HOLDINGS_SNAP, holdings, _liveTs: anyLive ? liveTs : null, _quoteTs: anyLive ? quoteTs : null, _session: anyLive ? quoteSession : null });
}

function posRow(label, val, extraCls = "") {
  return `<div class="pos-metric ${extraCls}"><span class="pos-metric-label">${label}</span><span class="pos-metric-val">${val}</span></div>`;
}

function buildHoldingCard(h) {
  const cur = h.currency || "USD";
  if (h.status_fetch === "error") {
    return `<div class="asset-card error pos-card">
      <div class="asset-head"><div class="asset-name-block">
        <div class="asset-name">${escapeHtml(h.name || h.id)}</div>
        <div class="asset-symbol">${escapeHtml(h.symbol || "–")}</div>
      </div></div>
      <div class="error-box">⚠️ <strong>無法計算 ATR</strong><br><span style="font-family:monospace;font-size:11px;">${escapeHtml(h.error || "unknown")}</span></div>
    </div>`;
  }
  // Status light is a SEPARATE semantic from 漲紅跌綠 price colours — carried by the
  // emoji + a left-border accent, so it never collides with the price/P&L cells.
  const statusCls = h.status === "hit" ? "pos-hit" : h.status === "near" ? "pos-near" : "pos-hold";
  const priceCls = changeClass(h.change_pct);
  const pnlCls = changeClass(h.unrealized_pnl_pct);
  const regimeBadge = h.regime
    ? `<span class="pos-regime pos-regime-${h.regime === "飆" ? "hot" : "calm"}">${h.regime === "飆" ? "飆·波動大" : "穩健"}</span>`
    : "";

  const rows = [];
  rows.push(posRow("🛑 移動停損價", `<b>${fmtCurrency(h.trailing_stop, cur)}</b>`, "pos-stop-row"));
  rows.push(posRow("距停損", `${h.dist_to_stop_pct != null ? fmtPct(h.dist_to_stop_pct) : "–"}${h.buffer_atr != null ? ` · 緩衝 ${fmtNum(h.buffer_atr, 2)}×ATR` : ""}`));
  rows.push(posRow("買進後最高", fmtCurrency(h.highest_high_since_entry, cur)));
  rows.push(posRow(`ATR(${h.atr_period_used || 14}) ×倍數`, `${fmtCurrency(h.atr_used, cur)} × ${h.atr_mult}`));
  rows.push(posRow("ATR14 / ATR20", `${fmtNum(h.atr14)} / ${fmtNum(h.atr20)}`));
  rows.push(posRow("日均振幅(20日)", h.amplitude_pct_20d != null ? `${fmtNum(h.amplitude_pct_20d, 1)}%` : "–"));
  rows.push(posRow("持股 @ 成本", `${fmtNum(h.shares, 0)} @ ${fmtCurrency(h.cost_basis, cur)}`));
  rows.push(posRow("市值", fmtCurrency(h.market_value, cur, 0)));
  rows.push(posRow("未實現損益", `<span class="${pnlCls}">${h.unrealized_pnl != null && h.unrealized_pnl >= 0 ? "+" : ""}${fmtCurrency(h.unrealized_pnl, cur, 0)} (${fmtPct(h.unrealized_pnl_pct)})</span>`));

  const scaleOut = h.scale_out_due ? `<div class="pos-scaleout">${escapeHtml(h.scale_out_note || "🎯 到分批鎖利點")}</div>` : "";
  const chip = h.type === "tw_stock"
    ? `<div class="pos-chip-note">📊 主力買賣家數差 / 三大法人 / 融資 訊號：建置中（Phase 2）</div>`
    : "";
  const foot = [h.entry_date ? `買進 ${escapeHtml(h.entry_date)}` : "", h.atr_asof ? `ATR 截至 ${escapeHtml(h.atr_asof)}` : ""].filter(Boolean).join(" · ");

  return `<div class="asset-card pos-card ${statusCls}">
    <div class="asset-head">
      <div class="asset-name-block">
        <div class="asset-name">${escapeHtml(h.name || h.id)} ${regimeBadge}</div>
        <div class="asset-symbol">${escapeHtml(h.symbol || "–")}</div>
      </div>
    </div>
    <div class="asset-price-row">
      <span class="asset-price ${priceCls}">${fmtCurrency(h.price, cur)}</span>
      <span class="asset-change ${priceCls}">${fmtPct(h.change_pct)}</span>
    </div>
    <div class="pos-status ${statusCls}">${escapeHtml(h.status_label || "")}</div>
    ${scaleOut}
    <div class="pos-metrics">${rows.join("")}</div>
    <div class="pos-formula" title="移動停損 = 買進後最高 − 倍數 × ATR，隨新高往上鎖">${escapeHtml(h.stop_formula || "")}</div>
    ${chip}
    ${foot ? `<div class="pos-foot">${foot}</div>` : ""}
  </div>`;
}

// ========== 模擬倉 (Adam 2026-07-13, 第五分頁) ==========
// Data source: docs/data/sim.json = {portfolio, nav_log, generated_at}, merged from
// ~/Abraham/sim-portfolio/ by abraham-portfolio-sync.py. 虛擬 100 萬 TWD 實驗:
// 帳戶摘要 + 持倉 + 掛單 + 交易紀錄(含 skip, 透明度優先) + 淨值曲線.
// 現價 join: positions match latest.json symbols via CURRENT_SNAPSHOT (live ticks
// update it, and liveRefresh re-calls renderSim so 市值/損益 follow the live price).
function loadSim() {
  SIM_BOOKS.forEach((book) => loadSimBook(book));
}

function loadSimBook({ key, url }) {
  fetch(url + "?t=" + Date.now(), { cache: "no-store" })
    .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .then((sim) => { SIM_SNAPS[key] = sim; renderSim(sim, key); })
    .catch((err) => {
      // A sim-book failure must never break the other tabs — just note it in-panel.
      console.warn(`${key} load failed:`, err);
      setText(`tab-count-${key}`, "–");
      setText(`${key}-count`, "–");
      const posEl = document.getElementById(`${key}-positions`);
      if (posEl) posEl.innerHTML = `<div class="loading">模擬倉資料尚未產生<br><small>${escapeHtml(err.message)}</small></div>`;
      [`${key}-orders`, `${key}-trades`].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<div class="sim-empty">–</div>`;
      });
    });
}

// symbol -> live/snapshot price from the market tabs' data (watchlist/holdings/indices).
// Sim tickers use the same yfinance symbols (3017.TW / 3324.TWO), so a direct key match.
function simPriceMap() {
  const m = {};
  const snap = CURRENT_SNAPSHOT || {};
  for (const it of [...(snap.watchlist || []), ...(snap.holdings || []), ...(snap.indices || [])]) {
    if (it.symbol && it.data && it.data.price != null) m[it.symbol] = it.data.price;
  }
  return m;
}

// "2026-07-13T03:46:55+08:00" -> "07-13 03:46" (Taipei)
function fmtSimTs(ts) {
  if (!ts) return "–";
  const d = new Date(ts);
  if (isNaN(d)) return escapeHtml(String(ts));
  return d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function simTableHtml(headers, rows, emptyMsg) {
  if (!rows.length) return `<div class="sim-empty">${escapeHtml(emptyMsg)}</div>`;
  const thead = headers.map(([label, numCls]) => `<th${numCls ? ' class="num"' : ""}>${escapeHtml(label)}</th>`).join("");
  return `<table class="sim-table"><thead><tr>${thead}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

// 持倉表: 名稱/股數/成本價/現價/市值/損益%/認錯線.
// (2026-07-13 Adam: 模擬倉頁不顯示進場區 — 掛單顯示實際限價、持倉不帶分析帶)
// 現價三層 fallback（2026-07-21「損益%沒算出來」修正）:
//   ① priceMap (latest.json live tick, 觀察清單名字才有, ~30s 更新)
//   ② p.px (sync 時全持倉統一抓的價, 倉2/3 全市場名字靠這個)
//   ③ cost 星號 fallback（兩者皆無, 沿用舊行為）
// 市值一律換算 TWD：美股 mv = px*股數*usdtwd（舊版直接把 USD 數字掛 NT$ 標籤 = 錯 32 倍）。
// Position schema is defensive: ticker/name/shares + cost under cost|avg_cost|cost_basis|avg_price, stop.
function simPositionsHtml(positions, priceMap, opts = {}) {
  const isUS = !!opts.isUS;
  const bookFx = opts.usdtwd ?? null;
  const rows = positions.map((p) => {
    const cost = p.cost ?? p.avg_cost ?? p.cost_basis ?? p.avg_price ?? null;
    const live = priceMap[p.ticker];
    const synced = p.px;
    const px = live ?? synced ?? cost;                   // ①live ②synced ③成本
    const hasPrice = live != null || synced != null;
    const fx = isUS ? (bookFx ?? p.fx_at_fill ?? null) : 1;   // 美股市值換 TWD
    const mv = px != null && p.shares != null && fx != null ? px * p.shares * fx : null;
    const pnlPct = hasPrice && cost ? ((px - cost) / cost) * 100 : null;
    const pnlCls = changeClass(pnlPct);                  // 漲紅跌綠 via existing classes
    const pxCell = live != null
      ? fmtNum(live, 2)
      : (synced != null
        ? `<span title="同步時抓的價（${escapeHtml(p.px_date || "非即時")}）">${fmtNum(synced, 2)}</span>`
        : (cost != null ? `<span class="flat" title="無現價，暫以成本價顯示">${fmtNum(cost, 2)}*</span>` : "–"));
    return `<tr>
      <td><b>${escapeHtml(p.name || p.ticker || "–")}</b><br><span class="sim-sub">${escapeHtml(p.ticker || "")}</span></td>
      <td class="num">${fmtNum(p.shares, 0)}</td>
      <td class="num">${cost != null ? fmtNum(cost, 2) : "–"}</td>
      <td class="num">${pxCell}</td>
      <td class="num">${mv != null ? fmtCurrency(mv, "TWD", 0) : "–"}</td>
      <td class="num ${pnlCls}">${pnlPct != null ? fmtPct(pnlPct) : "–"}</td>
      <td class="num">${p.stop != null ? fmtNum(p.stop, 0) : "–"}</td>
    </tr>`;
  });
  return simTableHtml(
    [["名稱", 0], ["股數", 1], ["成本價", 1], ["現價", 1], ["市值(NT$)", 1], ["損益%", 1], ["認錯線", 1]],
    rows,
    "尚無持倉 — 等掛單成交後顯示"
  );
}

// 掛單表: 名稱/預算/限價(實際掛單價)/認錯線/掛單時間/狀態(pending).
// (2026-07-13 Adam: 要寫實際掛單, 不寫進場區 — limit 欄為準, 舊資料 fallback band 上緣)
function simOrdersHtml(orders) {
  const rows = orders.map((o) => {
    const lim = o.limit ?? (Array.isArray(o.band) && o.band.length === 2 ? o.band[1] : null);
    return `<tr>
      <td><b>${escapeHtml(o.name || o.ticker || "–")}</b><br><span class="sim-sub">${escapeHtml(o.ticker || "")}</span></td>
      <td class="num">${o.budget_twd != null ? fmtCurrency(o.budget_twd, "TWD", 0) : "–"}</td>
      <td class="num"><b>${lim != null ? fmtNum(lim, 0) : "–"}</b></td>
      <td class="num">${o.stop != null ? fmtNum(o.stop, 0) : "–"}</td>
      <td class="num">${fmtSimTs(o.placed_ts)}</td>
      <td><span class="badge-mid">⏳ pending</span></td>
    </tr>`;
  });
  return simTableHtml(
    [["名稱", 0], ["預算", 1], ["限價", 1], ["認錯線", 1], ["掛單時間", 1], ["狀態", 0]],
    rows,
    "無掛單"
  );
}

// 交易紀錄表: 時間/動作/名稱/股數/價格/費用/理由 — skip_* rows顯示照舊 (透明度是重點).
function simTradesHtml(trades) {
  const actionCell = (a) => {
    const act = String(a || "–");
    if (act === "buy") return `<span class="up">買進</span>`;    // 買 = 紅 (台式, existing .up)
    if (act === "sell") return `<span class="down">賣出</span>`; // 賣 = 綠 (existing .down)
    return `<span class="flat">${escapeHtml(act)}</span>`;       // skip_* etc. 原字照登
  };
  const rows = trades.map((t) => `<tr>
      <td class="sim-time">${fmtSimTs(t.ts || t.time)}</td>
      <td>${actionCell(t.action || t.side)}</td>
      <td><b>${escapeHtml(t.name || t.ticker || "–")}</b></td>
      <td class="num">${t.shares != null ? fmtNum(t.shares, 0) : "–"}</td>
      <td class="num">${t.price != null ? fmtNum(t.price, 2) : "–"}</td>
      <td class="num">${(t.fee ?? t.fee_twd) != null ? fmtNum(t.fee ?? t.fee_twd, 0) : "–"}</td>
      <td class="sim-reason">${escapeHtml(t.reason || "")}</td>
    </tr>`);
  return simTableHtml(
    [["時間", 0], ["動作", 0], ["名稱", 0], ["股數", 1], ["價格", 1], ["費用", 1], ["理由", 0]],
    rows,
    "尚無交易紀錄"
  );
}

// 淨值曲線 — Chart.js is already loaded from <head> for the market-tab trend charts,
// so reuse it (no new library). <2 points -> placeholder text (v1 表格為主).
function renderSimNavChart(navLog, key = "sim") {
  const wrap = document.getElementById(`${key}-nav-wrap`);
  if (!wrap) return;
  const cid = `chart-${key}-nav`;
  const existing = CHART_INSTANCES.get(cid);
  if (existing) { try { existing.destroy(); } catch (e) {} CHART_INSTANCES.delete(cid); }
  const pts = (navLog || []).filter((r) => r && r.nav_twd != null);
  if (pts.length < 2 || typeof Chart === "undefined") {
    wrap.classList.add("empty");
    wrap.innerHTML = "<span>（淨值紀錄滿 2 筆後顯示曲線）</span>";
    return;
  }
  wrap.classList.remove("empty");
  if (!document.getElementById(cid)) wrap.innerHTML = `<canvas id="${cid}"></canvas>`;
  const navs = pts.map((r) => r.nav_twd);
  // 漲紅跌綠 via the single source of truth — line colour = 期末 vs 期初淨值.
  const delta = navs[navs.length - 1] - navs[0];
  const chart = new Chart(document.getElementById(cid), {
    type: "line",
    data: {
      labels: pts.map((r) => r.ts),
      datasets: [{
        label: "淨值",
        data: navs,
        borderColor: trendColor(delta),
        backgroundColor: trendFill(delta),
        borderWidth: 1.8,
        fill: true,
        tension: 0.15,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: trendColor(delta),
        pointHoverBorderColor: "#0f1419",
        pointHoverBorderWidth: 2,
      }],
    },
    plugins: [crosshairPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          backgroundColor: "rgba(15, 20, 25, 0.95)",
          titleColor: "#8b95a7",
          bodyColor: "#e4e8f0",
          borderColor: "#2d3548",
          borderWidth: 1,
          padding: 8,
          callbacks: {
            title: (items) => fmtChartTs(items[0]?.label),
            label: (ctx) => `淨值 ${fmtCurrency(ctx.parsed.y, "TWD", 0)}`,
          },
        },
      },
      scales: { x: { display: false }, y: { display: false } },
      animation: { duration: 200 },
    },
  });
  CHART_INSTANCES.set(cid, chart);  // "chart-<key>-" prefix -> activateTab(key) auto-resizes it
}

function renderSim(sim, key = "sim") {
  const pf = (sim && sim.portfolio) || {};
  const navLog = Array.isArray(sim && sim.nav_log) ? sim.nav_log : [];
  const positions = pf.positions || [];
  const orders = pf.pending_orders || [];
  const trades = pf.trades || [];

  // --- 帳戶摘要卡 ---
  const initial = pf.initial_capital_twd ?? null;
  const last = navLog.length ? navLog[navLog.length - 1] : null;
  const nav = last ? last.nav_twd : initial;             // 淨值: nav_log 最後一筆, 沒有就 initial
  const retPct = last
    ? last.return_pct
    : (nav != null && initial ? ((nav - initial) / initial) * 100 : null);
  // bench_return_pct: 同期 0050/SPY 報酬 — schema 可能是 {ticker: pct} 或單一數字, 都吃.
  let benchText = "尚無基準紀錄";
  const bench = last ? last.bench_return_pct : null;
  if (bench != null) {
    benchText = typeof bench === "object"
      ? Object.entries(bench).map(([k, v]) => `${escapeHtml(k)} ${fmtPct(v)}`).join(" · ")
      : `基準 ${fmtPct(bench)}`;
  }
  const sumEl = document.getElementById(`${key}-summary`);
  if (sumEl) {
    sumEl.innerHTML = `
      <div class="summary-card">
        <div class="summary-label">💰 淨值</div>
        <div class="summary-value">${nav != null ? fmtCurrency(nav, "TWD", 0) : "–"}</div>
        <div class="summary-sub">起始 ${initial != null ? fmtCurrency(initial, "TWD", 0) : "–"} · ${escapeHtml(pf.inception_ts ? "自 " + fmtSimTs(pf.inception_ts) : "")}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">📊 報酬</div>
        <div class="summary-value ${changeClass(retPct)}">${retPct != null ? fmtPct(retPct) : "–"}</div>
        <div class="summary-sub">對照同期：${benchText}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">💵 現金</div>
        <div class="summary-value">${pf.cash_twd != null ? fmtCurrency(pf.cash_twd, "TWD", 0) : "–"}</div>
        <div class="summary-sub">可動用資金</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">📦 開倉數</div>
        <div class="summary-value">${positions.length}</div>
        <div class="summary-sub">掛單 ${orders.length} 筆 · 交易 ${trades.length} 筆</div>
      </div>`;
  }

  // --- counts (sub-tab badge + 模擬倉 top-level aggregate) ---
  setText(`tab-count-${key}`, positions.length + orders.length || "–");
  updateSimAggregateCount();
  setText(`${key}-count`, `持倉 ${positions.length} · 掛單 ${orders.length}`);
  setText(`${key}-pos-count`, `${positions.length} 檔`);
  setText(`${key}-ord-count`, `${orders.length} 筆`);
  setText(`${key}-trade-count`, `${trades.length} 筆`);

  // --- 三張表 ---
  const priceMap = simPriceMap();
  const posEl = document.getElementById(`${key}-positions`);
  if (posEl) posEl.innerHTML = simPositionsHtml(positions, priceMap, { isUS: key.startsWith("sim-us"), usdtwd: sim && sim.usdtwd });
  const ordEl = document.getElementById(`${key}-orders`);
  if (ordEl) ordEl.innerHTML = simOrdersHtml(orders);
  const trdEl = document.getElementById(`${key}-trades`);
  if (trdEl) trdEl.innerHTML = simTradesHtml(trades);

  // --- 淨值曲線 ---
  renderSimNavChart(navLog, key);
}

// Fetch live quotes in batches of <= LIVE_BATCH_SIZE and merge. The relay caps
// symbols per request, so sending the whole list in one shot silently dropped the
// tail (the long-standing "a few symbols stuck on close price" bug, 2026-06-30).
// Batches run sequentially to keep Yahoo concurrency (and rate-limit risk) modest.
async function fetchQuotesBatched(symbols) {
  const base = RELAY_BASE.replace(/\/+$/, "");
  const merged = {};
  for (let i = 0; i < symbols.length; i += LIVE_BATCH_SIZE) {
    const batch = symbols.slice(i, i + LIVE_BATCH_SIZE);
    try {
      const url = base + "/?symbols=" + encodeURIComponent(batch.join(","));
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
      const data = await res.json();
      Object.assign(merged, (data && data.quotes) || {});
    } catch (err) {
      // One batch failing must not discard the others — mark just this batch's
      // symbols failed so the successful batches still render live. (Codex R2 P3.)
      console.error("live batch failed:", batch.join(","), err);
      for (const s of batch) if (!(s in merged)) merged[s] = { ok: false, error: String((err && err.message) || err) };
    }
  }
  return merged;
}

// Live refresh: pull current quotes for every tracked symbol from the relay
// (Cloudflare Worker), merge into the snapshot, and re-render. Falls back to a
// plain snapshot reload if the relay isn't configured, and to last-close per
// symbol if the relay call partially fails.
async function liveRefresh() {
  const btn = document.getElementById("live-btn");
  if (!RELAY_BASE) { await loadAndRender({ keepOrder: true }); return; }
  if (!CURRENT_SNAPSHOT) await loadAndRender();
  if (!CURRENT_SNAPSHOT) return;

  const all = [...(CURRENT_SNAPSHOT.holdings || []), ...(CURRENT_SNAPSHOT.watchlist || []), ...(CURRENT_SNAPSHOT.indices || [])];
  // include 即時持倉 symbols so the holdings tab's 距停損 updates on the same live tick
  const holdingSyms = ((HOLDINGS_SNAP && HOLDINGS_SNAP.holdings) || []).map((h) => h.symbol).filter(Boolean);
  const symbols = [...new Set([...all.map(it => it.symbol).filter(Boolean), ...holdingSyms])];
  if (!symbols.length) return;

  if (REFRESH_INFLIGHT) return;  // an auto/manual refresh is already running — don't overlap
  REFRESH_INFLIGHT = true;
  if (btn) { btn.disabled = true; btn.textContent = "抓取中…"; }
  try {
    const quotes = await fetchQuotesBatched(symbols);
    const liveTs = Date.now();

    let okCount = 0, failCount = 0;
    const apply = (item) => {
      const q = quotes[item.symbol];
      const next = { ...item, data: { ...(item.data || {}) } };
      if (q && q.ok && q.price != null) {
        okCount++;
        next.data.price = q.price;
        if (q.prevClose != null) next.data.previous_close = q.prevClose;
        if (q.change != null) next.data.change = q.change;
        if (q.changePct != null) next.data.change_pct = q.changePct;
        if (q.intraday && q.intraday.length) {
          next.data.history = mergeLiveIntoHistory(next.data.history, q);
        }
        // 今日累積量 (證交所/Yahoo)。指數擋掉 — 它沒有成交股數，Yahoo 給的 0 不是資料是雜訊。
        if (q.dayVolume != null && !isIndexItem(item)) next._dayVolume = q.dayVolume;
        next._live = true;        // fresh live quote applied → green per-card badge
        next._liveTs = liveTs;    // when WE fetched (for delay calc)
        next._quoteTs = q.asOf ? q.asOf * 1000 : null;  // when the PRICE is actually from (Adam 2026-07-06)
        if (q.dayVolume != null && next._quoteTs != null && !isIndexItem(item)) {
          trackVolTick(item.id, next._quoteTs, q.dayVolume, q.price);  // 突波 tick 差分 (2026-07-23)
        }
        next._session = q.session || "regular";  // "pre"/"post" → badge shows 盤前/盤後
        delete next.data.stale;   // a fresh quote supersedes any carried-forward stale flag
      } else {
        next._live = false;       // showing snapshot close → amber "未即時" per-card badge
        if (item.status !== "error") failCount++;
      }
      return next;
    };

    const live = {
      ...CURRENT_SNAPSHOT,
      holdings: (CURRENT_SNAPSHOT.holdings || []).map(apply),
      watchlist: (CURRENT_SNAPSHOT.watchlist || []).map(apply),
      indices: (CURRENT_SNAPSHOT.indices || []).map(apply),
    };
    const note = failCount
      ? `${okCount} 檔即時 · ${failCount} 檔未即時(顯示收盤)`
      : `${okCount} 檔即時`;
    CURRENT_SNAPSHOT = live;  // adopt merged snapshot so per-card refresh + ordering read live buckets
    renderSnapshot(live, { live: true, note, keepOrder: true });  // 自動/手動抓即時都不跳位 (Adam 2026-07-23)
    applyLiveToHoldings(quotes, liveTs);   // 即時持倉分頁: 距停損隨這批即時價重算
    SIM_BOOKS.forEach(({ key }) => {       // 模擬倉分頁: 現價 join 吃這批即時價 + 重建被 renderSnapshot 銷毀的淨值圖
      if (SIM_SNAPS[key]) renderSim(SIM_SNAPS[key], key);
    });
    LIVE_MODE = true;
  } catch (err) {
    console.error("Live refresh failed:", err);
    document.getElementById("timestamp").textContent =
      `⚠️ 即時抓取失敗，顯示最近收盤：${err.message}`;
  } finally {
    REFRESH_INFLIGHT = false;
    if (btn) { btn.disabled = false; btn.textContent = "🔄 抓即時"; }
  }
}

// Per-card ↻: refresh a single card's live quote (just that symbol) and rebuild only that card.
async function refreshOneCard(section, id, symbol, btn) {
  if (!RELAY_BASE || !symbol || !CURRENT_SNAPSHOT) { await liveRefresh(); return; }
  const list = CURRENT_SNAPSHOT[section] || [];
  const item = list.find((it) => it.id === id);
  if (!item) return;
  if (REFRESH_INFLIGHT) return;  // don't overlap with an auto/full refresh
  REFRESH_INFLIGHT = true;
  if (btn) { btn.disabled = true; btn.classList.add("spin"); }
  try {
    const url = RELAY_BASE.replace(/\/+$/, "") + "/?symbols=" + encodeURIComponent(symbol);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("relay " + res.status);
    const q = ((await res.json()).quotes || {})[symbol];
    if (!q || !q.ok || q.price == null) throw new Error((q && q.error) || "no quote");
    item.data = item.data || {};
    item.data.price = q.price;
    if (q.prevClose != null) item.data.previous_close = q.prevClose;
    if (q.change != null) item.data.change = q.change;
    if (q.changePct != null) item.data.change_pct = q.changePct;
    if (q.intraday && q.intraday.length) item.data.history = mergeLiveIntoHistory(item.data.history, q);
    if (q.dayVolume != null) item._dayVolume = q.dayVolume;  // 今日累積量 (證交所/Yahoo)
    item.status = "ok";
    item._live = true;             // single-card live quote applied → green badge
    item._liveTs = Date.now();
    item._quoteTs = q.asOf ? q.asOf * 1000 : null;  // the price's own time (Adam 2026-07-06)
    item._session = q.session || "regular";  // "pre"/"post" → badge shows 盤前/盤後
    if (item.data) delete item.data.stale;  // a fresh quote supersedes any carried-forward stale data
    const node = document.querySelector('[data-card="' + CSS.escape(section + "-" + id) + '"]');
    if (node) {
      // keep the user's chart scope across the per-card rebuild (was silently reset to 1d — audit 2026-07-03 P3-3)
      const prevScope = node.querySelector(".scope-btn.active")?.dataset.scope;
      const cid = canvasIdFor(section, item);
      const old = CHART_INSTANCES.get(cid);
      if (old) { try { old.destroy(); } catch (e) { /* ignore */ } CHART_INSTANCES.delete(cid); }
      node.outerHTML = buildAssetCard(item, section);
      initializeCharts([item], section);
      if (prevScope && prevScope !== DEFAULT_SCOPE) {
        const rebuilt = document.querySelector('[data-card="' + CSS.escape(section + "-" + id) + '"]');
        const scopeBtn = rebuilt?.querySelector('.scope-btn[data-scope="' + prevScope + '"]');
        if (scopeBtn) scopeBtn.click();  // delegated handler re-renders the chart + active tab
      }
    }
    // Re-evaluate 進場區內 summary — this symbol's new price may have just
    // entered (or left) its entry zone. (Adam 2026-06-17: 每次更新都要判別)
    renderSummary(CURRENT_SNAPSHOT.portfolio_summary, CURRENT_SNAPSHOT);
  } catch (err) {
    console.error("card refresh failed:", symbol, err);
    if (btn) {
      btn.classList.remove("spin");
      btn.textContent = "✕";
      setTimeout(() => { btn.textContent = "↻"; btn.disabled = false; }, 1500);
    }
  } finally {
    REFRESH_INFLIGHT = false;
  }
}

// ========== Card ordering: drag-drop (A) + sort dropdown (B) ==========
// Adam manages card order himself, persisted per-device in localStorage:
//   A. drag a card by its ⠿ handle (SortableJS, touch-friendly) -> mode 自訂
//   B. 排序 dropdown per section: 預設 / 漲跌幅 / 距進場區 / 名稱 / 自訂(拖拉)
// DOM nodes are re-appended in place so charts/canvas are preserved (no rebuild).
const ORDER_SECTIONS = ["tw", "us", "idx"];
const SORTABLE_INSTANCES = {};
let SUMMARY_SORTABLE = null;

// 總覽卡順序 (Adam 2026-07-23): saved key ranks win; 沒存過/新卡 keep default 相對位置
// (1e9+i pattern, 同 applySort custom mode)。saved 裡的未知 key 直接忽略。
function orderSummaryCards(cards, savedJson) {
  let order = [];
  try { order = JSON.parse(savedJson != null ? savedJson : lsGet("abraham.sumorder", "[]")) || []; } catch (e) { order = []; }
  const rank = new Map(order.map((k, i) => [String(k), i]));
  return cards
    .map((c, i) => [c, rank.has(c.k) ? rank.get(c.k) : 1e9 + i])
    .sort((a, b) => a[1] - b[1])
    .map((p) => p[0]);
}

// Sortable binds to the CONTAINER (#portfolio-summary, 常駐 node) and resolves items
// per interaction, so one init survives every innerHTML re-render — create once, lazily
// from renderSummary (boot / tab switch / refresh 都經過那裡).
function initSummaryDrag(el) {
  if (SUMMARY_SORTABLE || typeof window === "undefined" || !window.Sortable || !el) return;
  SUMMARY_SORTABLE = window.Sortable.create(el, {
    handle: ".drag-handle",
    animation: 150,
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    onEnd: () => {
      const keys = Array.from(el.querySelectorAll("[data-sum]"))
        .map((c) => c.getAttribute("data-sum")).filter(Boolean);
      lsSet("abraham.sumorder", JSON.stringify(keys));
    },
  });
}

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); if (!PREFS_SYNCING && k.indexOf("abraham.") === 0) schedulePrefsPush(); } catch (e) { /* private mode / quota — ignore */ } }

// 圖釘置頂 (Adam 2026-06-19) — per-section pinned id set, persisted like order/sort.
// Pinned cards float to the top of their tab in ALL sort modes EXCEPT 漲跌幅/距進場區.
function getPinned(section) { try { return (JSON.parse(lsGet("abraham.pinned." + section, "[]")) || []).map(String); } catch (e) { return []; } }
function setPinned(section, ids) { lsSet("abraham.pinned." + section, JSON.stringify(ids)); }
function isPinned(section, id) { return getPinned(section).includes(String(id)); }
function togglePin(section, id) {
  const ids = getPinned(section);
  const i = ids.indexOf(String(id));
  if (i >= 0) ids.splice(i, 1); else ids.push(String(id));
  setPinned(section, ids);
  return i < 0;  // true => now pinned
}

function cardIdOf(card, section) {
  const dc = card.getAttribute("data-card") || "";
  return dc.startsWith(section + "-") ? dc.slice(section.length + 1) : dc;
}

// 純數值排序模式 -> 方向 (-1 = 大到小 / +1 = 小到大)。圖釘在這些模式不置頂 (純 metric 勝)。
// 2026-07-23 Adam: +fpe(預估本益比)/qoq(營收季增)/vol(成交量)/volratio(量比), 移除 eps(年EPS)
// 2026-07-23 Adam: +short(空單比例 高→低; 美股=佔流通股, 台股=融券+借券佔發行股數)
// 2026-07-23 Adam: +rtvol(即時量比 高→低 — 按開盤時間折算, 與卡片 ⏱️ 同源)
// 2026-07-23 Adam「加」: +burst(瞬時量比/突波 高→低 — 盤中限定, 收盤時全 -Inf 保持原序)
const METRIC_DIR = { change: -1, growth: -1, qoq: -1, pe: 1, fpe: 1, vol: -1, volratio: -1, rtvol: -1, burst: -1, short: -1, zone: 1, drawdown: 1 };

function sortMetric(item, mode) {
  const d = (item && item.data) || {};
  if (mode === "change") return d.change_pct == null ? -Infinity : d.change_pct;   // 漲跌幅 大->小
  if (mode === "drawdown") return d.dist_from_high_pct == null ? Infinity : d.dist_from_high_pct; // 回檔深度 距52W高 深(負大)->上, 無資料->最後
  if (mode === "growth") return d.rev_yoy_pct == null ? -Infinity : d.rev_yoy_pct; // 營收年增率 大->小
  if (mode === "qoq")    return d.rev_qoq_pct == null ? -Infinity : d.rev_qoq_pct; // 營收季增率 大->小
  if (mode === "pe") {                                                             // 本益比 小->大 (便宜在前)
    const pe = d.trailing_pe;
    return (pe == null || pe <= 0) ? Infinity : pe;                                // 無/負(虧損) -> 最後
  }
  if (mode === "fpe") {                                                            // 預估本益比 小->大
    const pe = d.forward_pe;
    return (pe == null || pe <= 0) ? Infinity : pe;                                // 無/負 -> 最後
  }
  if (mode === "vol") {                                                            // 成交量 大->小 (與卡片 📊 同源: 盤中用今日累積量)
    const vi = volumeInfo(item);
    return vi && vi.vol != null ? vi.vol : -Infinity;
  }
  if (mode === "volratio") {                                                       // 量比 高->低 (與卡片量比同源)
    const vi = volumeInfo(item);
    return vi && vi.ratio != null && isFinite(vi.ratio) ? vi.ratio : -Infinity;
  }
  if (mode === "rtvol") {                                                          // 即時量比 高->低 (與卡片 ⏱️ 同源)
    const rt = realtimeVolInfo(item);
    return rt && rt.ratio != null && isFinite(rt.ratio) ? rt.ratio : -Infinity;
  }
  if (mode === "burst") {                                                          // 瞬時量比 高->低 (盤中限定)
    const bv = burstVolInfo(item);
    return bv && bv.ratio != null && isFinite(bv.ratio) ? bv.ratio : -Infinity;
  }
  if (mode === "short") return d.short_pct == null ? -Infinity : d.short_pct;      // 空單比例 高->低, 無資料->最後
  if (mode === "zone") {                                                           // 距進場區 近->遠
    const hi = item && item.entry_zone_hi, p = d.price;
    if (hi == null || p == null) return Infinity;                                  // 無進場區 -> 排最後
    return Math.abs(p - hi) / hi;
  }
  return 0;
}

// Reorder the section's card nodes per its saved sort mode (appendChild = move,
// so charts/canvas are preserved — no rebuild). 圖釘 cards then float to the top
// in every mode EXCEPT 漲跌幅(change)/距進場區(zone) (Adam 2026-06-19 指定例外).
function applySort(section) {
  const grid = document.getElementById(section + "-grid");
  if (!grid || !CURRENT_SNAPSHOT) return;
  const items = CURRENT_SNAPSHOT[section] || [];
  const byId = new Map(items.map((it) => [String(it.id), it]));
  const cards = Array.from(grid.querySelectorAll(".asset-card"));
  if (cards.length < 2) return;
  const mode = lsGet("abraham.sort." + section, "default");

  // 1) base ordering per sort mode -> ordered list of card nodes
  let ordered;
  if (mode === "name") {
    ordered = cards
      .map((c) => [c, (byId.get(cardIdOf(c, section)) || {}).name || ""])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]), "zh-Hant"))
      .map((p) => p[0]);
  } else if (METRIC_DIR[mode]) {
    const dir = METRIC_DIR[mode];
    ordered = cards
      .map((c) => [c, sortMetric(byId.get(cardIdOf(c, section)), mode) * dir])
      .sort((a, b) => a[1] - b[1])
      .map((p) => p[0]);
  } else if (mode === "custom") {
    let order = [];
    try { order = JSON.parse(lsGet("abraham.order." + section, "[]")) || []; } catch (e) { order = []; }
    const rank = new Map(order.map((id, i) => [String(id), i]));
    ordered = cards
      .map((c, i) => [c, rank.has(cardIdOf(c, section)) ? rank.get(cardIdOf(c, section)) : 1e9 + i])
      .sort((a, b) => a[1] - b[1])
      .map((p) => p[0]);
  } else {
    const rank = new Map(items.map((it, i) => [String(it.id), i])); // 預設 = snapshot order
    ordered = cards
      .map((c, i) => [c, rank.has(cardIdOf(c, section)) ? rank.get(cardIdOf(c, section)) : 1e9 + i])
      .sort((a, b) => a[1] - b[1])
      .map((p) => p[0]);
  }

  // 2) 圖釘置頂 — pinned cards float to top (keeping their relative order), EXCEPT
  //    in 純數值排序模式 (漲跌幅/成長率/EPS/本益比/距進場區) where the metric sort wins.
  if (!METRIC_DIR[mode]) {
    const pinned = new Set(getPinned(section));
    if (pinned.size) {
      const pins = ordered.filter((c) => pinned.has(cardIdOf(c, section)));
      if (pins.length) ordered = pins.concat(ordered.filter((c) => !pinned.has(cardIdOf(c, section))));
    }
  }

  ordered.forEach((c) => grid.appendChild(c));
}

// (Re)init SortableJS + sync dropdown + apply saved order. Called after every render.
function setupOrdering() {
  for (const section of ORDER_SECTIONS) {
    const grid = document.getElementById(section + "-grid");
    if (!grid) continue;
    const sel = document.querySelector('.sort-select[data-section="' + section + '"]');
    if (sel) {
      let saved = lsGet("abraham.sort." + section, "default");
      // 選項退役防護 (2026-07-23 移除年EPS): 存的模式已不在選單 -> 回預設, 免得 select 變空白
      if (!sel.querySelector('option[value="' + saved + '"]')) { saved = "default"; lsSet("abraham.sort." + section, saved); }
      sel.value = saved;
    }
    if (SORTABLE_INSTANCES[section]) { try { SORTABLE_INSTANCES[section].destroy(); } catch (e) {} delete SORTABLE_INSTANCES[section]; }
    if (window.Sortable && grid.querySelector(".asset-card")) {
      SORTABLE_INSTANCES[section] = window.Sortable.create(grid, {
        handle: ".drag-handle",
        animation: 150,
        ghostClass: "sortable-ghost",
        chosenClass: "sortable-chosen",
        dragClass: "sortable-drag",
        onEnd: () => {
          const ids = Array.from(grid.querySelectorAll(".asset-card")).map((c) => cardIdOf(c, section)).filter(Boolean);
          lsSet("abraham.order." + section, JSON.stringify(ids));
          lsSet("abraham.sort." + section, "custom");
          const s = document.querySelector('.sort-select[data-section="' + section + '"]');
          if (s) s.value = "custom";
          applySort(section);  // keep 圖釘 invariant: pinned stay on top after a drag
        },
      });
    }
    applySort(section);
  }
}

// Sort dropdown change (delegated — survives re-renders since headers are static).
document.addEventListener("change", (e) => {
  const sel = e.target && e.target.closest && e.target.closest(".sort-select");
  if (!sel) return;
  const section = sel.dataset.section;
  lsSet("abraham.sort." + section, sel.value);
  applySort(section);
});

// ↻ = reload snapshot file (exits live mode); 🔄 抓即時 = live quotes (enters live mode).
document.getElementById("refresh-btn").addEventListener("click", () => { LIVE_MODE = false; loadAndRender(); });
const _liveBtn = document.getElementById("live-btn");
if (_liveBtn) _liveBtn.addEventListener("click", liveRefresh);

// --- Cloud prefs sync helpers (Adam 2026-07-01) ---
// One shared blob in the Worker's KV holds every "abraham.*" localStorage key, so all
// devices converge. Pull on boot (cloud wins), push debounced on any local change.
function collectPrefs() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf("abraham.") === 0) out[k] = localStorage.getItem(k);
    }
  } catch (e) {}
  return out;
}
function applyPrefs(obj) {
  if (!obj || typeof obj !== "object") return;
  try {
    for (const k in obj) {
      if (k.indexOf("abraham.") === 0 && typeof obj[k] === "string") localStorage.setItem(k, obj[k]);
    }
  } catch (e) {}
}
async function pullPrefs() {
  if (!PREFS_URL) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);  // never block boot on a slow/missing relay
    const res = await fetch(PREFS_URL, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!res.ok) return;
    const prefs = await res.json();
    if (prefs && typeof prefs === "object" && Object.keys(prefs).length) applyPrefs(prefs);
  } catch (e) { /* relay/KV not set up or offline → keep this device's localStorage */ }
}
function schedulePrefsPush() {
  if (!PREFS_URL) return;
  clearTimeout(_prefsPushTimer);
  _prefsPushTimer = setTimeout(pushPrefs, 1200);  // debounce bursts of drags/toggles
}
async function pushPrefs() {
  if (!PREFS_URL) return;
  try {
    await fetch(PREFS_URL + (PREFS_SECRET ? "?k=" + encodeURIComponent(PREFS_SECRET) : ""), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPrefs()),
    });
  } catch (e) { /* offline / not set up → the next change re-syncs */ }
}

// ========== 搜尋欄 (Adam 2026-07-22: 打關鍵字直接跳到那張卡) ==========
// Index = every card in the 3 market tabs; haystack covers 名稱/代號/主題/筆記.
function buildSearchIndex(snapshot) {
  const out = [];
  for (const tab of ["tw", "us", "idx"]) {
    for (const item of (snapshot[tab] || [])) {
      out.push({
        id: String(item.id),
        name: item.name || item.id,
        symbol: item.symbol || "",
        tab,
        hay: [item.name, item.symbol, item.id, item.theme, item.notes]
          .filter(Boolean).join(" ").toLowerCase(),
      });
    }
  }
  SEARCH_INDEX = out;
}

function searchMatches(qStr) {
  const q = qStr.trim().toLowerCase();
  if (!q) return [];
  const starts = [], contains = [];
  for (const e of SEARCH_INDEX) {
    const nameL = e.name.toLowerCase(), symL = e.symbol.toLowerCase();
    if (nameL.startsWith(q) || symL.startsWith(q)) starts.push(e);
    else if (e.hay.includes(q)) contains.push(e);
  }
  return [...starts, ...contains].slice(0, 8);
}

(function setupSearch() {
  const input = document.getElementById("search-input");
  const drop = document.getElementById("search-drop");
  if (!input || !drop) return;
  let sel = -1;      // keyboard-highlighted row index
  let rows = [];     // current match entries

  const close = () => { drop.classList.remove("open"); drop.innerHTML = ""; sel = -1; rows = []; };
  const jump = (e) => { if (!e) return; close(); input.blur(); jumpToCard(e.tab, e.id); };

  const render = () => {
    if (!rows.length) { close(); return; }
    drop.innerHTML = rows.map((e, i) => `
      <div class="search-row${i === sel ? " sel" : ""}" data-i="${i}">
        <span class="search-row-name">${escapeHtml(e.name)}</span>
        <span class="search-row-sym">${escapeHtml(e.symbol)}</span>
        <span class="search-row-tab">${MARKET_TAB_LABEL[e.tab] || ""}</span>
      </div>`).join("");
    drop.classList.add("open");
  };

  input.addEventListener("input", () => { rows = searchMatches(input.value); sel = rows.length ? 0 : -1; render(); });
  input.addEventListener("focus", () => { if (input.value.trim()) { rows = searchMatches(input.value); sel = rows.length ? 0 : -1; render(); } });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); jump(rows[Math.max(0, sel)] || rows[0]); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); if (rows.length) { sel = (sel + 1) % rows.length; render(); } }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); if (rows.length) { sel = (sel - 1 + rows.length) % rows.length; render(); } }
    else if (ev.key === "Escape") { close(); input.blur(); }
  });
  // mousedown (not click) so the row fires before the input's blur clears the dropdown.
  drop.addEventListener("mousedown", (ev) => {
    const row = ev.target.closest(".search-row");
    if (row) { ev.preventDefault(); jump(rows[Number(row.dataset.i)]); }
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
})();

// Boot: pull the unified settings from the relay KV BEFORE first paint so pinned /
// custom order / sort mode / active tab match on every device. If the relay or its KV
// isn't set up (or offline), the fetch just fails and we fall back to this device's
// localStorage — nothing breaks. Edits after boot auto-upload (debounced).
(async () => {
  await pullPrefs();
  // Restore last-viewed market tab BEFORE the first render so its charts size correctly.
  activateTab(lsGet("abraham.activeTab", "tw"), false);
  // Render saved snapshot immediately (fast), then upgrade to live quotes.
  await loadAndRender();
  PREFS_SYNCING = false;   // boot done — user edits from here on sync up to the cloud
  liveRefresh();
})();

// Adaptive auto-refresh (Adam 2026-07-03: 看盤要 30 秒即時).
//   • Market active (TW 09:00-13:30 Taipei / US 04:00-20:00 ET incl. pre+post) → 30s live quotes via relay.
//   • Off-hours / weekend → re-check open every 60s; reload the static snapshot at most every 5 min.
//   • Hidden tab → skip the tick entirely (don't burn the relay in the background).
// setTimeout-reschedule (not setInterval) so the cadence re-evaluates as markets open/close.
// REFRESH_INFLIGHT (inside liveRefresh) skips a tick if the prior pull is still running,
// so a slow 52-symbol pull can't pile up at 30s.
const LIVE_FAST_MS = 30 * 1000;          // a market is open → 30s live quotes
const LIVE_IDLE_MS = 60 * 1000;          // markets closed → re-check open every 60s (cheap; snapshot reload throttled below)
const IDLE_SNAPSHOT_MS = 5 * 60 * 1000;  // off-hours: reload the 4MB static snapshot at most this often
// Market-active test uses each exchange's OWN timezone via Intl, so DST is handled
// automatically and the windows are exact — no broad UTC union / over-polling. (Codex audit P3)
// "Active" = any window where the relay serves a LIVE tick, so it now includes US
// pre-market (04:00 ET) and post-market (to 20:00 ET): the relay serves the freshest
// extended-hours chart bar as the price in those sessions (see relay/yahoo-relay-worker.js
// fetchOne — chart meta has no pre/postMarketPrice fields). Adam 2026-07-03: 盤前/盤後也要 30s。
function marketActive(d) {
  d = d || new Date();
  const localMins = (tz) => {                    // wall-clock minutes-of-day in that market, or -1 on weekend
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    const g = (t) => (p.find((x) => x.type === t) || {}).value;
    const wd = g("weekday");
    if (wd === "Sat" || wd === "Sun") return -1;
    let hh = parseInt(g("hour"), 10); if (hh === 24) hh = 0;   // Intl may emit 24 at midnight
    return hh * 60 + parseInt(g("minute"), 10);
  };
  const tw = localMins("Asia/Taipei");
  if (tw >= 540 && tw <= 810) return true;       // TW 09:00-13:30 (no continuous pre/post session)
  const us = localMins("America/New_York");
  if (us >= 240 && us <= 1200) return true;       // US 04:00-20:00 ET: pre + regular + post (DST auto)
  return false;
}
let _lastSnapshotLoad = Date.now();  // boot's loadAndRender() just ran
(function scheduleRefresh() {
  const activeAtSchedule = marketActive();
  setTimeout(async () => {
    if (!document.hidden) {
      const active = marketActive();  // re-evaluate at FIRE time, not the stale scheduled value (Codex audit P4)
      try {
        if (active) {
          await liveRefresh();                     // any live session (pre/regular/post) → 30s live; forced regardless of LIVE_MODE so a failed tick self-heals
        } else {
          LIVE_MODE = false;                        // markets closed → drop the live latch, don't poll the relay all night (Codex 2026-07-03 P3)
          if (Date.now() - _lastSnapshotLoad >= IDLE_SNAPSHOT_MS) {
            await loadAndRender({ keepOrder: true }); // off-hours auto reload — 同樣不跳位 (Adam 2026-07-23)
            _lastSnapshotLoad = Date.now();
          }
        }
      } catch (e) { console.error("auto-refresh tick failed:", e); }
    }
    scheduleRefresh();  // re-evaluate cadence for the next tick
  }, activeAtSchedule ? LIVE_FAST_MS : LIVE_IDLE_MS);
})();
