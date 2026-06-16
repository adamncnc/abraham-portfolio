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

async function fetchOne(symbol) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(symbol) +
    "?range=1d&interval=5m";
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      cf: { cacheTtl: 30, cacheEverything: true },
    });
    if (!r.ok) return { ok: false, error: "HTTP " + r.status };
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    const m = res && res.meta;
    if (!m) return { ok: false, error: "no meta" };
    const price = m.regularMarketPrice ?? null;
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
    return { ok: false, error: String(e) };
  }
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url);
    const raw = u.searchParams.get("symbols") || u.searchParams.get("symbol") || "";
    const symbols = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 40);
    if (!symbols.length) {
      return new Response(
        JSON.stringify({ ok: false, error: "pass ?symbols=A,B,C" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }
    const pairs = await Promise.all(
      symbols.map(async (s) => [s, await fetchOne(s)])
    );
    return new Response(
      JSON.stringify({ ok: true, ts: Date.now(), quotes: Object.fromEntries(pairs) }),
      { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } }
    );
  },
};
