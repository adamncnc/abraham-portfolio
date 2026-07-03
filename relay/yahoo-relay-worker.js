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
    for (const s of dropped) quotes[s] = { ok: false, error: "symbol cap exceeded (" + MAX_SYMBOLS + ")" };
    return new Response(
      JSON.stringify({ ok: true, ts: Date.now(), dropped: dropped.length, quotes }),
      { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } }
    );
  },
};
