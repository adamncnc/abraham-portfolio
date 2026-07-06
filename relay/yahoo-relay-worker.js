// Abraham Dashboard — Cloudflare Worker (2 jobs)
//   1. Yahoo Finance CORS relay for the 抓即時 live-quote button (GET /?symbols=...)
//   2. Cross-device settings sync (GET/POST /prefs) backed by Workers KV — so
//      pinned cards / custom order / sort mode / active tab match on every device.
//
// Why a Worker: GitHub Pages is static; the browser can't call Yahoo (CORS) and has
// nowhere to store shared settings. This tiny Worker fetches Yahoo server-side and
// keeps one shared settings blob in KV.
//
// ── Deploy (one-time, free) ─────────────────────────────────────────────────
//   A. Create/refresh the Worker
//      1. https://dash.cloudflare.com → Workers & Pages → your worker (abraham-quotes)
//         → Edit code → paste THIS whole file → Deploy
//   B. Add the KV store for /prefs (needed for cross-device sync)
//      2. Workers & Pages → KV → Create a namespace → name it e.g. "abraham-prefs" → Add
//      3. Back in the worker → Settings → Variables and Bindings → KV Namespace Bindings
//         → Add binding:  Variable name = PREFS   (exactly)   → select the namespace → Save
//      4. Deploy again so the binding takes effect.
//   Test: open https://<your-worker>.workers.dev/prefs  → should return {}  (empty at first)
//         open https://<your-worker>.workers.dev/?symbols=2330.TW,NBIS → quotes JSON
//
// Security note: /prefs stores ONLY non-sensitive UI layout prefs (which cards are
// pinned + their order + sort mode + active tab). No account or financial data. POST
// writes require the shared token below (?k=...), which also lives in the dashboard's
// app.js (PREFS_SECRET) — it's anti-grief, not high security; worst case is a scrambled
// card order that a drag fixes in seconds.

const ALLOW = "*";
const CORS = {
  "Access-Control-Allow-Origin": ALLOW,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// ── /prefs settings-sync config ──
const PREFS_KEY = "dashboard-v1";       // single shared blob → all devices unified
const PREFS_SECRET = "abr-dash-7c3f9a"; // MUST match app.js PREFS_SECRET
const PREFS_MAX_BYTES = 65536;          // reject oversized writes

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// GET /prefs  → return the stored settings blob (or {} if none / KV not bound yet)
// POST /prefs?k=TOKEN → overwrite the settings blob (validated JSON, size-capped)
async function handlePrefs(request, env) {
  if (!env || !env.PREFS) {
    // KV not bound yet → GET returns empty so the dashboard silently uses localStorage.
    if (request.method === "GET") {
      return new Response("{}", { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    return jsonResponse({ ok: false, error: "PREFS KV namespace not bound — see deploy step B" }, 200);
  }
  if (request.method === "GET") {
    const v = await env.PREFS.get(PREFS_KEY);
    return new Response(v || "{}", { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  if (request.method === "POST") {
    const u = new URL(request.url);
    if (PREFS_SECRET && u.searchParams.get("k") !== PREFS_SECRET) {
      return jsonResponse({ ok: false, error: "bad or missing token" }, 403);
    }
    const body = await request.text();
    if (body.length > PREFS_MAX_BYTES) return jsonResponse({ ok: false, error: "payload too large" }, 413);
    try { JSON.parse(body); } catch (e) { return jsonResponse({ ok: false, error: "invalid JSON" }, 400); }
    await env.PREFS.put(PREFS_KEY, body);
    return jsonResponse({ ok: true, updatedAt: Date.now() });
  }
  return jsonResponse({ ok: false, error: "method not allowed" }, 405);
}

const FETCH_ATTEMPTS = 2;  // Yahoo intermittently 429s / returns empty — one retry kills most transient stalls.

async function fetchOne(symbol) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(symbol) +
    "?range=1d&interval=5m&includePrePost=true";
  let lastErr = "unknown";
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 200));  // brief backoff before retry
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        // No edge cache: a 30s cache made identical repeated requests serve a stale
        // quote, adding avoidable lag. Each refresh now hits Yahoo fresh.
        cf: { cacheTtl: 0 },
      });
      if (!r.ok) {
        lastErr = "HTTP " + r.status;
        if (r.status === 404) break;  // bad symbol — retrying won't help
        continue;
      }
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      const m = res && res.meta;
      if (!m) { lastErr = "no meta"; continue; }
      const ts = res.timestamp || [];
      const closes =
        (res.indicators && res.indicators.quote && res.indicators.quote[0] &&
          res.indicators.quote[0].close) || [];
      const off = m.gmtoffset || 0;
      const pad = (n) => String(n).padStart(2, "0");
      const intraday = [];
      let lastBarT = null, lastBarC = null;  // last non-null bar (epoch, close) — includePrePost=true so this covers pre/post
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (c == null) continue;
        lastBarT = ts[i]; lastBarC = c;
        const d = new Date((ts[i] + off) * 1000);
        const t =
          d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" +
          pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
        intraday.push({ t, c: Math.round(c * 10000) / 10000 });
      }
      // Latest price incl. pre/post market. The chart META does NOT carry
      // marketState/preMarketPrice/postMarketPrice (verified 2026-07-03 — the old code
      // reading them was dead, so pre/post sessions silently showed the regular close).
      // Instead: prefer the newest CHART BAR when it is (a) newer than the last regular
      // trade and (b) fresh (<15 min old) — i.e. an extended-hours session is live NOW.
      // On holidays/weekends/overnight the bars are hours old → official close is used.
      const rmt = m.regularMarketTime || 0;
      const nowS = Math.floor(Date.now() / 1000);
      const FRESH_S = 15 * 60;
      let price = m.regularMarketPrice ?? null;
      let session = "regular";
      if (lastBarC != null && lastBarT > rmt && nowS - lastBarT <= FRESH_S) {
        price = lastBarC;
        const reg = (m.currentTradingPeriod && m.currentTradingPeriod.regular) || null;
        session = reg && lastBarT >= reg.end ? "post"
                : reg && lastBarT < reg.start ? "pre"
                : "regular";
      }
      if (price == null) { lastErr = "no price"; continue; }  // partial payload — retry rather than report a null-price "ok"
      const prev = m.chartPreviousClose ?? m.previousClose ?? null;
      const change = price != null && prev != null ? price - prev : null;  // vs previous close (pre/post shown as move vs 昨收)
      const changePct = change != null && prev ? (change / prev) * 100 : null;
      return { ok: true, price, prevClose: prev, change, changePct, session, asOf: session === "regular" ? rmt : lastBarT, intraday };
    } catch (e) {
      lastErr = String(e);
    }
  }
  return { ok: false, error: lastErr };
}

// ── TWSE MIS 官方即時報價 (near-real-time ~5-10s) for .TW / .TWO ───────────────
// Yahoo's free TW feed lags ~20 min (regularMarketTime is ~20 min behind the tape).
// TWSE MIS is the exchange's own snapshot — what broker apps show — delayed only a few
// seconds. We overlay MIS onto the Yahoo base for TW symbols DURING LIVE TRADING, and
// keep Yahoo for intraday history + as the fallback when MIS is unreachable/off-hours.
// Crucially asOf = the MIS quote's own time, so the dashboard can label the price's REAL
// time (delay ≈ 0) instead of the fetch time. (Adam 2026-07-06: 資料不對也不即時)
function misChannel(sym) {
  // 2330.TW → tse_2330.tw ; 6488.TWO → otc_6488.tw ; non-TW → null
  const m = /^(\d{3,6})\.(TW|TWO)$/i.exec(sym || "");
  if (!m) return null;
  return (m[2].toUpperCase() === "TWO" ? "otc" : "tse") + "_" + m[1] + ".tw";
}
function misNum(v) {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// Fetch MIS for a batch of yf TW symbols. Returns { yfSym: { price, prevClose, asOf(sec) } }.
// Only returns entries whose quote is fresh (<10 min) → self-gates to trading hours; stale
// off-hours ticks are skipped so we never override Yahoo's close with a frozen MIS value.
async function fetchMisBatch(twSymbols) {
  const out = {};
  const chans = [];
  const bySym = {};   // stock-code → yf symbol
  for (const s of twSymbols) {
    const ch = misChannel(s);
    if (ch) { chans.push(ch); bySym[ch.replace(/^(tse|otc)_/, "").replace(/\.tw$/, "")] = s; }
  }
  if (!chans.length) return out;
  const url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&_=" +
    Date.now() + "&ex_ch=" + encodeURIComponent(chans.join("|"));
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://mis.twse.com.tw/stock/index.jsp",
        Accept: "application/json",
      },
      cf: { cacheTtl: 0 },
    });
    if (!r.ok) return out;
    const j = await r.json();
    if (!j || j.rtcode !== "0000" || !Array.isArray(j.msgArray)) return out;
    const nowS = Math.floor(Date.now() / 1000);
    for (const a of j.msgArray) {
      const code = a.c || (a.ch || "").replace(/\.tw$/i, "");
      const yf = bySym[code];
      if (!yf) continue;
      const asOf = a.tlong ? Math.floor(parseInt(a.tlong, 10) / 1000) : null;
      if (!asOf || nowS - asOf > 600) continue;   // stale (off-hours) → let Yahoo close stand
      // Price: last trade z when present; MIS blanks z to "-" between matches, so fall back
      // to the best bid/ask midpoint (spread is 1 tick for liquid names → ≈ last).
      let price = misNum(a.z);
      if (price == null) {
        const bid = misNum((a.b || "").split("_")[0]);
        const ask = misNum((a.a || "").split("_")[0]);
        if (bid != null && ask != null) price = Math.round(((bid + ask) / 2) * 100) / 100;
        else price = bid != null ? bid : ask;
      }
      if (price == null) continue;
      out[yf] = { price, prevClose: misNum(a.y), asOf };
    }
  } catch (e) { /* MIS unreachable → caller keeps the Yahoo quote (honest-but-delayed) */ }
  return out;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const u = new URL(request.url);

    // Cross-device settings sync
    if (u.pathname === "/prefs") return handlePrefs(request, env);

    // Live-quote relay (default route)
    const raw = u.searchParams.get("symbols") || u.searchParams.get("symbol") || "";
    const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!requested.length) {
      return new Response(
        JSON.stringify({ ok: false, error: "pass ?symbols=A,B,C" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }
    // Cap concurrent Yahoo fetches, but report anything beyond the cap EXPLICITLY
    // (ok:false) instead of silently dropping it — the old silent slice(0,40) made
    // the tail of a 53-symbol request vanish without a trace (the "stuck" bug).
    // The dashboard now also chunks requests <= 30, so this cap is a safety net.
    const MAX_SYMBOLS = 60;
    const symbols = requested.slice(0, MAX_SYMBOLS);
    const dropped = requested.slice(MAX_SYMBOLS);
    const pairs = await Promise.all(
      symbols.map(async (s) => [s, await fetchOne(s)])
    );
    const quotes = Object.fromEntries(pairs);

    // Overlay TWSE MIS near-real-time onto TW symbols (Yahoo stays as fallback + intraday
    // source). One batched MIS call for all .TW/.TWO in this request. If MIS is off-hours
    // or unreachable, nothing is overridden and Yahoo's (delayed) quote stands.
    const twSyms = symbols.filter((s) => misChannel(s));
    if (twSyms.length) {
      const mis = await fetchMisBatch(twSyms);
      for (const s of twSyms) {
        const m = mis[s];
        if (!m) continue;
        const base = quotes[s] || {};
        const prev = m.prevClose != null ? m.prevClose : base.prevClose;
        const change = prev != null ? Math.round((m.price - prev) * 10000) / 10000 : (base.change ?? null);
        const changePct = change != null && prev ? (change / prev) * 100 : (base.changePct ?? null);
        // Append the live MIS point to Yahoo's intraday so the sparkline ends at the
        // real-time price instead of the ~20-min-old Yahoo tail (replace if same minute).
        const intraday = Array.isArray(base.intraday) ? base.intraday.slice() : [];
        const d = new Date((m.asOf + 8 * 3600) * 1000);   // MIS asOf → Taipei wall clock
        const p2 = (n) => String(n).padStart(2, "0");
        const tStr = d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate()) +
          "T" + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
        if (intraday.length && intraday[intraday.length - 1].t === tStr) intraday[intraday.length - 1].c = m.price;
        else intraday.push({ t: tStr, c: m.price });
        quotes[s] = {
          ok: true,
          price: m.price,
          prevClose: prev,
          change,
          changePct,
          session: "regular",
          asOf: m.asOf,        // MIS quote time (~seconds old) → dashboard labels the price's REAL time
          intraday,
          src: "twse-mis",     // provenance (debugging)
        };
      }
    }

    for (const s of dropped) quotes[s] = { ok: false, error: "symbol cap exceeded (" + MAX_SYMBOLS + ")" };
    return new Response(
      JSON.stringify({ ok: true, ts: Date.now(), dropped: dropped.length, quotes }),
      { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } }
    );
  },
};
