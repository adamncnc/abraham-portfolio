// Abraham Portfolio Dashboard — data-driven renderer
// Reads ./data/latest.json and renders holdings + watchlist dynamically.
// Adding/removing items in config/*.json is all that's needed to change tracked set.

const DATA_URL = "./data/latest.json";

// Live-quote relay (Cloudflare Worker — see relay/yahoo-relay-worker.js).
// Set to your workers.dev URL to enable the 抓即時 button's live fetch.
// Empty => 抓即時 falls back to reloading the snapshot file.
const RELAY_BASE = "https://abraham-quotes.adamncnc.workers.dev";
let CURRENT_SNAPSHOT = null;
let LIVE_MODE = false;  // once user presses 抓即時, auto-refresh keeps pulling live

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
// recreating (auto-refresh every 5 min, scope changes).
const CHART_INSTANCES = new Map();
// Cache each card's history payload by canvas id so scope toggles don't need
// to re-fetch. Populated during initializeCharts().
const CARD_HISTORY = new Map();
// Entry-zone (進場區) per canvas id: { lo, hi }. Drawn as overlay lines on the
// trend chart so Adam sees current price vs the pre-set 進場上限/下限.
const CARD_META = new Map();

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
  // 台股慣例: 漲=紅, 跌=綠
  const lineColor = last >= first ? "#f87171" : "#4ade80";
  const fillColor = last >= first ? "rgba(248, 113, 113, 0.15)" : "rgba(74, 222, 128, 0.15)";

  const closes = points.map((p) => p.c);
  // High/low of the displayed range -> text line below the chart (updates per scope).
  const hiloEl = document.getElementById("hilo-" + canvasId);
  if (hiloEl) {
    hiloEl.textContent = `區間　高 ${fmtNum(Math.max(...closes), 2)}　低 ${fmtNum(Math.min(...closes), 2)}`;
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

  // y-axis is scaled to the PRICE range only (range high/low) so the trend is
  // always legible. Entry-zone lines are still drawn, but they do NOT expand the
  // axis — if the band sits far outside the visible price range it simply clips
  // out of view. (Adam 2026-06-17: 縱軸由範圍內最大最小值決定；進場區虛線不強求顯示。)
  const meta = CARD_META.get(canvasId);
  const yMin = Math.min(...closes);
  const yMax = Math.max(...closes);
  if (meta && meta.hi != null) {
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
  const pad = (yMax - yMin) * 0.06 || 1;

  const currency = (CARD_META.get(canvasId) || {}).currency || "USD";
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
          },
        },
      },
      scales: {
        x: { display: false },
        y: { display: false, min: yMin - pad, max: yMax + pad },
      },
      animation: { duration: 200 },
    },
  });
  CHART_INSTANCES.set(canvasId, chart);
}

function chartBlockHtml(canvasId) {
  const tabs = SCOPES.map((s) => {
    const activeCls = s.key === DEFAULT_SCOPE ? " active" : "";
    return `<button class="scope-btn${activeCls}" data-scope="${s.key}" data-canvas="${canvasId}">${s.label}</button>`;
  }).join("");
  return `
    <div class="chart-block">
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
    });
    renderChart(canvasId, DEFAULT_SCOPE);
  }
}

document.addEventListener("click", (e) => {
  const rb = e.target.closest(".card-refresh");
  if (rb) {
    refreshOneCard(rb.dataset.section, rb.dataset.cardid, rb.dataset.sym, rb);
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

// ========== Asset Card Builder ==========
function buildAssetCard(item, section) {
  const data = item.data || {};
  const isError = item.status === "error";
  const typeTag = `<span class="asset-type-tag tag-${escapeHtml(item.type)}">${escapeHtml((item.type || "").replace("_", " "))}</span>`;

  // Error card
  if (isError) {
    return `
      <div class="asset-card error" data-card="${escapeHtml(section + "-" + item.id)}">
        <div class="asset-head">
          <div class="asset-name-block">
            <div class="asset-name">${escapeHtml(item.name || item.id)}</div>
            <div class="asset-symbol">${escapeHtml(item.symbol || "–")}</div>
          </div>
          ${typeTag}
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
  const price = data.price;
  const change = data.change;
  const changePct = data.change_pct;
  const cls = changeClass(changePct);
  const changeSign = changePct > 0 ? "+" : changePct < 0 ? "" : "";

  // Per-card 即時 refresh button (right-aligned in the price row) — updates just this symbol.
  const cardRefreshBtn = item.symbol
    ? `<button class="card-refresh" title="更新此檔即時" data-sym="${escapeHtml(item.symbol)}" data-section="${escapeHtml(section)}" data-cardid="${escapeHtml(item.id)}">↻</button>`
    : "";

  const priceRow = price !== null && price !== undefined
    ? `
      <div class="asset-price-row">
        <span class="asset-price ${cls}">${fmtNum(price, 2)}</span>
        <span class="asset-change ${cls}">
          ${change !== null ? `${changeSign}${fmtNum(change, 2)}` : "–"}
          (${fmtPct(changePct)})
        </span>
        ${cardRefreshBtn}
      </div>
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
  if (data.dist_from_high_pct !== null && data.dist_from_high_pct !== undefined) {
    const cls2 = distFromHighClass(data.dist_from_high_pct);
    const label = distFromHighLabel(data.dist_from_high_pct);
    metrics.push(["距 52W 高", `<span class="${cls2}">${fmtPct(data.dist_from_high_pct)} ${label}</span>`]);
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

  // PnL for holdings
  let pnlHtml = "";
  if (section === "holdings" && item.unrealized_pnl !== undefined && item.unrealized_pnl !== null) {
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
  const canvasId = canvasIdFor(section, item);
  const chartHtml = chartBlockHtml(canvasId);

  const notesHtml = item.notes ? `<div class="asset-notes">📝 ${escapeHtml(item.notes)}</div>` : "";

  // Drag handle only in sortable sections (watchlist / indices), not holdings.
  const dragHandle = (section === "watchlist" || section === "indices")
    ? '<span class="drag-handle" title="按住拖拉排序">⠿</span>' : "";

  return `
    <div class="asset-card" data-card="${escapeHtml(section + "-" + item.id)}">
      <div class="asset-head">
        ${dragHandle}
        <div class="asset-name-block">
          <div class="asset-name">${escapeHtml(item.name || item.id)}</div>
          <div class="asset-symbol">${escapeHtml(item.symbol || "–")} · ${escapeHtml(item.theme || data.exchange || "")}</div>
        </div>
        ${typeTag}
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

// ========== Portfolio Summary ==========
function renderSummary(summary) {
  const el = document.getElementById("portfolio-summary");

  // Copilot mode: no tracked positions -> show a watchlist-focused summary
  // instead of empty 總市值/總成本/損益 cards reading "–".
  if (!summary || !summary.holdings_count) {
    el.innerHTML = `
    <div class="summary-card">
      <div class="summary-label">觀察清單</div>
      <div class="summary-value">${summary?.watchlist_count ?? "–"}</div>
      <div class="summary-sub">追蹤標的</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">模式</div>
      <div class="summary-value" style="font-size:18px;">Copilot</div>
      <div class="summary-sub">標的觀點 · 不記錄持倉</div>
    </div>`;
    return;
  }

  const mv = summary.total_market_value_usd_equiv;
  const cost = summary.total_cost_usd_equiv;
  const pnl = summary.total_unrealized_pnl_usd_equiv;
  const pnlPct = summary.total_unrealized_pnl_pct;

  el.innerHTML = `
    <div class="summary-card">
      <div class="summary-label">總市值</div>
      <div class="summary-value">${mv ? fmtCompactCurrency(mv, "USD") : "–"}</div>
      <div class="summary-sub">持倉 ${summary.holdings_count} 檔</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">總成本</div>
      <div class="summary-value">${cost ? fmtCompactCurrency(cost, "USD") : "–"}</div>
      <div class="summary-sub">已投入資金</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">未實現損益</div>
      <div class="summary-value ${changeClass(pnl)}">
        ${pnl !== null && pnl !== undefined ? fmtCompactCurrency(pnl, "USD") : "–"}
      </div>
      <div class="summary-sub ${changeClass(pnlPct)}">${fmtPct(pnlPct)}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">觀察清單</div>
      <div class="summary-value">${summary.watchlist_count}</div>
      <div class="summary-sub">追蹤中</div>
    </div>
  `;
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

  // Counts
  const total = (snapshot.holdings?.length || 0) + (snapshot.watchlist?.length || 0) + (snapshot.indices?.length || 0);
  document.getElementById("item-count").textContent = `${total} items`;
  document.getElementById("holdings-count").textContent = `${snapshot.holdings?.length || 0} 檔`;
  document.getElementById("watchlist-count").textContent = `${snapshot.watchlist?.length || 0} 檔`;
  const idxCountEl = document.getElementById("indices-count");
  if (idxCountEl) idxCountEl.textContent = `${snapshot.indices?.length || 0} 檔`;

  renderSummary(snapshot.portfolio_summary);

  // Holdings (hidden entirely when empty — copilot mode)
  const holdingsGrid = document.getElementById("holdings-grid");
  if (!snapshot.holdings?.length) {
    holdingsGrid.innerHTML = '<div class="loading">（尚無持倉）</div>';
  } else {
    holdingsGrid.innerHTML = snapshot.holdings.map(item => buildAssetCard(item, "holdings")).join("");
  }
  const holdingsSection = document.getElementById("holdings-section");
  if (holdingsSection) holdingsSection.style.display = snapshot.holdings?.length ? "" : "none";

  // Watchlist
  const watchGrid = document.getElementById("watchlist-grid");
  if (!snapshot.watchlist?.length) {
    watchGrid.innerHTML = '<div class="loading">（觀察清單為空）</div>';
  } else {
    watchGrid.innerHTML = snapshot.watchlist.map(item => buildAssetCard(item, "watchlist")).join("");
  }

  // Indices (大盤指數) — bottom section
  const indicesGrid = document.getElementById("indices-grid");
  if (indicesGrid) {
    if (!snapshot.indices?.length) {
      indicesGrid.innerHTML = '<div class="loading">（無指數資料）</div>';
    } else {
      indicesGrid.innerHTML = snapshot.indices.map(item => buildAssetCard(item, "indices")).join("");
    }
  }

  if (snapshot.holdings?.length) initializeCharts(snapshot.holdings, "holdings");
  if (snapshot.watchlist?.length) initializeCharts(snapshot.watchlist, "watchlist");
  if (snapshot.indices?.length) initializeCharts(snapshot.indices, "indices");

  setupOrdering();
}

async function loadAndRender() {
  const refreshBtn = document.getElementById("refresh-btn");
  refreshBtn.textContent = "…";
  try {
    const res = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snapshot = await res.json();
    CURRENT_SNAPSHOT = snapshot;
    renderSnapshot(snapshot);
  } catch (err) {
    console.error("Failed to load data:", err);
    document.getElementById("timestamp").textContent = `❌ 載入失敗：${err.message}`;
    document.getElementById("holdings-grid").innerHTML =
      `<div class="loading">無法載入 ${DATA_URL}<br><small>${err.message}</small></div>`;
    document.getElementById("watchlist-grid").innerHTML = "";
  } finally {
    refreshBtn.textContent = "↻";
  }
}

// Live refresh: pull current quotes for every tracked symbol from the relay
// (Cloudflare Worker), merge into the snapshot, and re-render. Falls back to a
// plain snapshot reload if the relay isn't configured, and to last-close per
// symbol if the relay call partially fails.
async function liveRefresh() {
  const btn = document.getElementById("live-btn");
  if (!RELAY_BASE) { await loadAndRender(); return; }
  if (!CURRENT_SNAPSHOT) await loadAndRender();
  if (!CURRENT_SNAPSHOT) return;

  const all = [...(CURRENT_SNAPSHOT.holdings || []), ...(CURRENT_SNAPSHOT.watchlist || []), ...(CURRENT_SNAPSHOT.indices || [])];
  const symbols = [...new Set(all.map(it => it.symbol).filter(Boolean))];
  if (!symbols.length) return;

  if (btn) { btn.disabled = true; btn.textContent = "抓取中…"; }
  try {
    const url = RELAY_BASE.replace(/\/+$/, "") + "/?symbols=" + encodeURIComponent(symbols.join(","));
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
    const data = await res.json();
    const quotes = (data && data.quotes) || {};

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
          next.data.history = { ...(next.data.history || {}), intraday: q.intraday };
        }
      } else if (item.status !== "error") {
        failCount++;
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
      ? `${okCount} 檔即時 · ${failCount} 檔抓取失敗(顯示最近收盤)`
      : `${okCount} 檔即時`;
    renderSnapshot(live, { live: true, note });
    LIVE_MODE = true;
  } catch (err) {
    console.error("Live refresh failed:", err);
    document.getElementById("timestamp").textContent =
      `⚠️ 即時抓取失敗，顯示最近收盤：${err.message}`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🔄 抓即時"; }
  }
}

// Per-card ↻: refresh a single card's live quote (just that symbol) and rebuild only that card.
async function refreshOneCard(section, id, symbol, btn) {
  if (!RELAY_BASE || !symbol || !CURRENT_SNAPSHOT) { await liveRefresh(); return; }
  const list = CURRENT_SNAPSHOT[section] || [];
  const item = list.find((it) => it.id === id);
  if (!item) return;
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
    if (q.intraday && q.intraday.length) item.data.history = { ...(item.data.history || {}), intraday: q.intraday };
    item.status = "ok";
    const node = document.querySelector('[data-card="' + CSS.escape(section + "-" + id) + '"]');
    if (node) {
      const cid = canvasIdFor(section, item);
      const old = CHART_INSTANCES.get(cid);
      if (old) { try { old.destroy(); } catch (e) { /* ignore */ } CHART_INSTANCES.delete(cid); }
      node.outerHTML = buildAssetCard(item, section);
      initializeCharts([item], section);
    }
  } catch (err) {
    console.error("card refresh failed:", symbol, err);
    if (btn) {
      btn.classList.remove("spin");
      btn.textContent = "✕";
      setTimeout(() => { btn.textContent = "↻"; btn.disabled = false; }, 1500);
    }
  }
}

// ========== Card ordering: drag-drop (A) + sort dropdown (B) ==========
// Adam manages card order himself, persisted per-device in localStorage:
//   A. drag a card by its ⠿ handle (SortableJS, touch-friendly) -> mode 自訂
//   B. 排序 dropdown per section: 預設 / 漲跌幅 / 距進場區 / 名稱 / 自訂(拖拉)
// DOM nodes are re-appended in place so charts/canvas are preserved (no rebuild).
const ORDER_SECTIONS = ["watchlist", "indices"];
const SORTABLE_INSTANCES = {};

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode / quota — ignore */ } }

function cardIdOf(card, section) {
  const dc = card.getAttribute("data-card") || "";
  return dc.startsWith(section + "-") ? dc.slice(section.length + 1) : dc;
}

function sortMetric(item, mode) {
  const d = (item && item.data) || {};
  if (mode === "change") return d.change_pct == null ? -Infinity : d.change_pct; // 漲跌幅 大->小
  if (mode === "zone") {                                                          // 距進場區 近->遠
    const hi = item && item.entry_zone_hi, p = d.price;
    if (hi == null || p == null) return Infinity;                                 // 無進場區 -> 排最後
    return Math.abs(p - hi) / hi;
  }
  return 0;
}

// Reorder the section's card nodes per its saved sort mode (appendChild = move).
function applySort(section) {
  const grid = document.getElementById(section + "-grid");
  if (!grid || !CURRENT_SNAPSHOT) return;
  const items = CURRENT_SNAPSHOT[section] || [];
  const byId = new Map(items.map((it) => [String(it.id), it]));
  const cards = Array.from(grid.querySelectorAll(".asset-card"));
  if (cards.length < 2) return;
  const mode = lsGet("abraham.sort." + section, "default");

  if (mode === "name") {
    cards
      .map((c) => [c, (byId.get(cardIdOf(c, section)) || {}).name || ""])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]), "zh-Hant"))
      .forEach((pair) => grid.appendChild(pair[0]));
    return;
  }

  let ranked;
  if (mode === "change" || mode === "zone") {
    const dir = mode === "change" ? -1 : 1;
    ranked = cards.map((c) => [c, sortMetric(byId.get(cardIdOf(c, section)), mode) * dir]);
  } else if (mode === "custom") {
    let order = [];
    try { order = JSON.parse(lsGet("abraham.order." + section, "[]")) || []; } catch (e) { order = []; }
    const rank = new Map(order.map((id, i) => [String(id), i]));
    ranked = cards.map((c, i) => [c, rank.has(cardIdOf(c, section)) ? rank.get(cardIdOf(c, section)) : 1e9 + i]);
  } else {
    const rank = new Map(items.map((it, i) => [String(it.id), i])); // 預設 = snapshot order
    ranked = cards.map((c, i) => [c, rank.has(cardIdOf(c, section)) ? rank.get(cardIdOf(c, section)) : 1e9 + i]);
  }
  ranked.sort((a, b) => a[1] - b[1]).forEach((pair) => grid.appendChild(pair[0]));
}

// (Re)init SortableJS + sync dropdown + apply saved order. Called after every render.
function setupOrdering() {
  for (const section of ORDER_SECTIONS) {
    const grid = document.getElementById(section + "-grid");
    if (!grid) continue;
    const sel = document.querySelector('.sort-select[data-section="' + section + '"]');
    if (sel) sel.value = lsGet("abraham.sort." + section, "default");
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
loadAndRender();

// Auto-refresh every 5 minutes (when tab visible). Stay in whichever mode the
// user last chose: live keeps pulling live quotes, otherwise reload snapshot.
setInterval(() => {
  if (document.hidden) return;
  if (LIVE_MODE) liveRefresh(); else loadAndRender();
}, 5 * 60 * 1000);
