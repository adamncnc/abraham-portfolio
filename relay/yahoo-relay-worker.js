// Abraham Dashboard — Yahoo Finance CORS relay (Cloudflare Worker)
//
// Why: GitHub Pages is static and the browser can't call Yahoo directly
// (CORS-blocked). This tiny Worker fetches Yahoo server-side (no CORS limit)
// and re-serves the data with Access-Control-Allow-Origin so the dashboard's
// "抓即時" button can pull live quotes on demand.
//
// Deploy (one-time, free):
//   1. https://dash.cloudflare.com  → sign up / log in
//   2. Workers & Pages → Create application → Create Worker → name it
//      (e.g. abraham-quotes) → Deploy
//   3. Edit code → paste THIS whole file, replacing the template → Deploy
//   4. Test in a browser:
//        https://<your-worker>.workers.dev/?symbols=2330.TW,NBIS,GC=F
//      Should return JSON with a "quotes" object.
//   5. Send the workers.dev URL to Abraham → it wires the button + ships.
//
// Optional lock-down: set ALLOW to "https://adamncnc.github.io" (only the
// dashboard origin can use it). "*" works too (anyone can call it; it only
// exposes public market data, so that's fine).

const ALLOW = "*";
const CORS = {
  "Access-Control-Allow-Origin": ALLOW,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

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
      // Latest price incl. extended hours (pre/post market) when in those sessions.
      let price = m.regularMarketPrice ?? null;
      const ms = m.marketState || "";
      if (ms.startsWith("PRE") && m.preMarketPrice != null) price = m.preMarketPrice;
      else if ((ms === "POST" || ms === "POSTPOST") && m.postMarketPrice != null) price = m.postMarketPrice;
      if (price == null) { lastErr = "no price"; continue; }  // partial payload — retry rather than report a null-price "ok"
      const prev = m.chartPreviousClose ?? m.previousClose ?? null;
      const change = price != null && prev != null ? price - prev : null;
      const changePct = change != null && prev ? (change / prev) * 100 : null;
      const ts = res.timestamp || [];
      const closes =
        (res.indicators && res.indicators.quote && res.indicators.quote[0] &&
          res.indicators.quote[0].close) || [];
      const off = m.gmtoffset || 0;
      const pad = (n) => String(n).padStart(2, "0");
      const intraday = [];
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (c == null) continue;
        const d = new Date((ts[i] + off) * 1000);
        const t =
          d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" +
          pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
        intraday.push({ t, c: Math.round(c * 10000) / 10000 });
      }
      return { ok: true, price, prevClose: prev, change, changePct, intraday };
    } catch (e) {
      lastErr = String(e);
    }
  }
  return { ok: false, error: lastErr };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url);
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
