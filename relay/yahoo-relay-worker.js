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
      const q0 = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
      const closes = q0.close || [];
      const barVols = q0.volume || [];   // per-bar volume → 1d 量能柱 (Adam 2026-07-22)
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
        const bar = { t, c: Math.round(c * 10000) / 10000 };
        if (barVols[i] != null && Number.isFinite(barVols[i])) bar.v = barVols[i];
        intraday.push(bar);
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
      // Baseline for change%. During REGULAR hours the price being compared is that same
      // session's live/last print, so Yahoo's chartPreviousClose (the prior session's close)
      // is the right partner.
      // In PRE/POST it is NOT: Yahoo has not rolled the day yet, so regularMarketPrice is
      // still the LAST REGULAR CLOSE and chartPreviousClose is the close BEFORE that — i.e.
      // one session too far back. Pairing a pre-market print with it silently skips a whole
      // trading day (verified live 2026-08-03 pre-market: MU showed −6.99% vs the true
      // −1.16%; AAPL −7.64% vs −0.31%; AMD/SNDK/ASML even had the SIGN inverted — red while
      // actually up). The correct baseline in extended hours is the last regular close,
      // which is exactly what regularMarketPrice holds at that moment.
      const prev = session === "regular"
        ? (m.chartPreviousClose ?? m.previousClose ?? null)
        : (m.regularMarketPrice ?? m.chartPreviousClose ?? m.previousClose ?? null);
      const change = price != null && prev != null ? price - prev : null;  // vs previous close (pre/post shown as move vs 昨收)
      const changePct = change != null && prev ? (change / prev) * 100 : null;
      // 當日累積成交量 (shares): prefer meta.regularMarketVolume; fall back to summing the
      // chart bars' volume (includePrePost → may include a little extended-hours volume,
      // acceptable for an intraday 「今日量」 readout — frontend labels it 盤中累積).
      let dayVolume = Number.isFinite(m.regularMarketVolume) ? m.regularMarketVolume : null;
      if (dayVolume == null) {
        let sum = 0, seen = false;
        for (const vv of barVols) { if (vv != null && Number.isFinite(vv)) { sum += vv; seen = true; } }
        dayVolume = seen ? sum : null;
      }
      return { ok: true, price, prevClose: prev, change, changePct, session, asOf: session === "regular" ? rmt : lastBarT, intraday, dayVolume };
    } catch (e) {
      lastErr = String(e);
    }
  }
  return { ok: false, error: lastErr };
}

// ── Yahoo 隔夜盤 (OVERNIGHT / Blue Ocean ATS) overlay for US symbols ───────────
// US equities now trade a THIRD session — 20:00–04:00 ET on the Blue Ocean ATS ("BOATS"),
// which is neither pre nor post. The chart endpoint this worker already uses CANNOT see it:
// its bars stop at the 19:59 post-market close and currentTradingPeriod only ever carries
// pre/regular/post — verified 2026-08-04 against ?overnightPrice=true / ?includeOvernight=true
// on v8/finance/chart, all identical. So overnight needs the QUOTE endpoint instead.
//
// Two non-obvious requirements, both verified live 2026-08-04 00:4x ET:
//   1. The query param `overnightPrice=true` is the switch. WITHOUT it the API does not
//      merely omit the fields — it reports marketState "PREPRE" and nulls every overnight
//      field, i.e. it actively looks like "no overnight session exists". With it, the same
//      request returns marketState "OVERNIGHT" plus live prices.
//   2. v7/finance/quote requires a cookie + crumb (bare request → HTTP 401). A cheap
//      GET https://fc.yahoo.com/ 404s but sets the A3 cookie, which is enough for
//      /v1/test/getcrumb — no need to pull the 1.2 MB quote page.
//
// Baseline: overnightMarketPrice === regularMarketPrice + overnightMarketChange for every
// symbol tested (38/38), i.e. the move is quoted against the REGULAR CLOSE, not the
// post-market close. Same trap as the pre/post baseline bug fixed 2026-08-03 — pairing it
// with chartPreviousClose would silently skip a whole session.
//
// Coverage is partial and thin: 38/39 watchlist US names had a quote (HUBB none), but the
// last print ranged from 0 min to 255 min old (NVMI/TLN/POWI last traded 20:35 ET and then
// nothing for four hours). We therefore pass overnightMarketTime through as asOf so the
// frontend's existing 慢N分 badge tells the truth instead of dressing a 4-hour-old print
// as live.
const CRUMB_KEY = "yahoo-crumb-v1";
const CRUMB_TTL_MS = 30 * 60 * 1000;
const YF_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Obtain a (cookie, crumb) pair, cached in KV so we don't re-handshake every refresh.
// force=true skips the cache — used once after a 401, in case the cached pair went stale.
async function getYahooAuth(env, force) {
  // Always read the cache, even when forcing: the handshake is measurably flaky (Yahoo
  // does not always return Set-Cookie to a Worker — observed failing and succeeding
  // seconds apart on 2026-08-04), and a stale crumb that might still work beats no crumb
  // at all. A dead one just 401s, which costs one forced retry.
  let cached = null;
  if (env && env.PREFS) {
    try { cached = await env.PREFS.get(CRUMB_KEY, { type: "json" }); } catch (e) { /* KV miss/unbound */ }
    if (cached && (!cached.crumb || !cached.cookie)) cached = null;
    if (!force && cached && Date.now() - cached.at < CRUMB_TTL_MS) return cached;
  }
  // Cookie seeding differs by egress network — measured from the Worker 2026-08-04 via
  // ?onDebug=1 rather than reasoned about:
  //   fc.yahoo.com            → 404, ZERO Set-Cookie   (works from a residential IP, not from CF)
  //   finance.yahoo.com/      → 200, ZERO Set-Cookie
  //   finance.yahoo.com/quote → 200, ZERO Set-Cookie
  //   getcrumb w/ HTML Accept → 406, but SETS A1/A3/A1S ← the only one that works from CF
  // So we probe candidates in CF-first order and take the first that yields A1/A3. The
  // non-2xx status on the winning call is expected: we want its Set-Cookie, not its body.
  const SEEDS = [
    ["https://query1.finance.yahoo.com/v1/test/getcrumb", "text/html,application/xhtml+xml"],
    ["https://fc.yahoo.com/", "text/html,application/xhtml+xml"],
    ["https://finance.yahoo.com/", "text/html,application/xhtml+xml"],
  ];
  let cookie = "";
  // On a forced retry sweep the list twice: the failure mode is transient (Yahoo simply
  // omits Set-Cookie sometimes), so a second pass usually lands it.
  for (const [seedUrl, accept] of (force ? SEEDS.concat(SEEDS) : SEEDS)) {
    let seed;
    try {
      seed = await fetch(seedUrl, {
        headers: { "User-Agent": YF_UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
        cf: { cacheTtl: 0 },
      });
    } catch (e) { continue; }
    // Multiple Set-Cookie headers fold differently across runtimes (Workers vs undici), and
    // a naive split(",") also breaks on the comma inside a cookie's Expires date. Prefer the
    // structured getSetCookie() where available and only fall back to the folded string.
    const jar = typeof seed.headers.getSetCookie === "function"
      ? seed.headers.getSetCookie()
      : String(seed.headers.get("set-cookie") || "").split(/,(?=\s*[A-Za-z0-9_-]+=)/);
    cookie = jar.map((p) => String(p).trim().split(";")[0]).filter((p) => /^A[13]=/.test(p)).join("; ");
    if (cookie) break;
  }
  // Handshake failed. Returning null would silently drop the whole overnight overlay for
  // this refresh; a stale crumb is strictly better — if it is dead the quote call 401s and
  // triggers exactly one forced retry, which is the path that repairs it.
  if (!cookie) return cached;
  const cr = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": YF_UA, Accept: "application/json,text/plain,*/*", Cookie: cookie },
    cf: { cacheTtl: 0 },
  });
  if (!cr.ok) return cached;
  const crumb = (await cr.text()).trim();
  // A crumb looks like "5hQs7ms2rhT" — reject an HTML error page masquerading as one.
  if (!crumb || crumb.length > 32 || /[<>{}\s]/.test(crumb)) return cached;
  const auth = { crumb, cookie, at: Date.now() };
  if (env && env.PREFS) { try { await env.PREFS.put(CRUMB_KEY, JSON.stringify(auth)); } catch (e) { /* non-fatal */ } }
  return auth;
}

const ON_FIELDS = "symbol,marketState,regularMarketPrice,overnightMarketPrice,overnightMarketChange,overnightMarketChangePercent,overnightMarketTime";

// Returns { SYM: { price, prevClose, changePct, asOf(sec) } } for symbols currently quoting
// in the overnight session. Empty object on any failure → callers keep the Yahoo chart
// quote, so this overlay can never make the dashboard worse than before it existed.
async function fetchOvernightBatch(usSymbols, env) {
  const out = {};
  if (!usSymbols.length) return out;
  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await getYahooAuth(env, attempt > 0);
    if (!auth) return out;
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
      encodeURIComponent(usSymbols.join(",")) +
      "&fields=" + encodeURIComponent(ON_FIELDS) +
      "&overnightPrice=true&lang=en-US&region=US&crumb=" + encodeURIComponent(auth.crumb);
    let r;
    try {
      r = await fetch(url, {
        headers: { "User-Agent": YF_UA, Accept: "application/json,text/plain,*/*", Cookie: auth.cookie },
        cf: { cacheTtl: 0 },
      });
    } catch (e) { return out; }
    if (r.status === 401 || r.status === 403) continue;  // stale crumb → one forced re-handshake
    if (!r.ok) return out;
    let j;
    try { j = await r.json(); } catch (e) { return out; }
    const res = (j && j.quoteResponse && j.quoteResponse.result) || [];
    for (const q of res) {
      if (!q || q.marketState !== "OVERNIGHT") continue;   // only during the overnight window
      const price = q.overnightMarketPrice, prev = q.regularMarketPrice, ts = q.overnightMarketTime;
      // A symbol Blue Ocean doesn't carry returns nulls — skip it rather than invent a price.
      if (!Number.isFinite(price) || !Number.isFinite(prev) || !Number.isFinite(ts)) continue;
      out[q.symbol] = {
        price,
        prevClose: prev,
        changePct: Number.isFinite(q.overnightMarketChangePercent) ? q.overnightMarketChangePercent : null,
        asOf: ts,
      };
    }
    return out;
  }
  return out;
}

// ── TWSE MIS 官方即時報價 (near-real-time ~5-10s) for .TW / .TWO ───────────────
// Yahoo's free TW feed lags ~20 min (regularMarketTime is ~20 min behind the tape).
// TWSE MIS is the exchange's own snapshot — what broker apps show — delayed only a few
// seconds. We overlay MIS onto the Yahoo base for TW symbols DURING LIVE TRADING, and
// keep Yahoo for intraday history + as the fallback when MIS is unreachable/off-hours.
// Crucially asOf = the MIS quote's own time, so the dashboard can label the price's REAL
// time (delay ≈ 0) instead of the fetch time. (Adam 2026-07-06: 資料不對也不即時)
// 台股「指數」也走 MIS (Adam 2026-07-31「台股指數要改用證交所即時來源」)。
// 個股早就吃 MIS 了，指數卻被漏掉 — 因為下面的 regex 只認純數字代號，^TWII 不符合，
// 於是大盤那張卡一直掛在 Yahoo 的 ~20 分延遲上。MIS 的 t00 頻道就是交易所自己的
// 加權指數即時快照 (盤中每 5 秒更新、13:30 後凍結在正式收盤值)。
const MIS_INDEX_CHANNEL = {
  "^TWII": "tse_t00.tw",   // 發行量加權股價指數 (TAIEX)
  "^TWOII": "otc_o00.tw",  // 櫃買指數 (目前未列在 indices.json，先備著)
};
function misChannel(sym) {
  // ^TWII → tse_t00.tw ; 2330.TW → tse_2330.tw ; 6488.TWO → otc_6488.tw ; 其他 → null
  const idx = MIS_INDEX_CHANNEL[String(sym || "").toUpperCase()];
  if (idx) return idx;
  const m = /^(\d{3,6})\.(TW|TWO)$/i.exec(sym || "");
  if (!m) return null;
  return (m[2].toUpperCase() === "TWO" ? "otc" : "tse") + "_" + m[1] + ".tw";
}
function isMisIndexChannel(ch) {
  return ch === "tse_t00.tw" || ch === "otc_o00.tw";
}
function misNum(v) {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// Top-of-book price from a MIS five-level string like "865.0000_864.0000_863.0000_..._".
// Deliberately NOT split("_")[0]: when a stock is LOCKED at its daily limit, MIS pads the
// live side with a leading "0.0000" level and blanks the opposite side to "-" (verified
// against live MIS 2026-08-03 on 10 limit-up names, incl. 3037 欣興 / 6223 旺矽). Index [0]
// then reads 0 → misNum → null → both sides null → the entire MIS row was skipped and the
// dashboard silently served Yahoo's 20-60 min stale quote, precisely on the days that move
// most. Scan for the first POSITIVE level instead.
function misBookTop(s) {
  for (const part of String(s == null ? "" : s).split("_")) {
    const n = misNum(part);
    if (n != null) return n;
  }
  return null;
}
// Fetch MIS for a batch of yf TW symbols. Returns { yfSym: { price, prevClose, asOf(sec) } }.
// Only returns entries whose quote is fresh (<10 min) → self-gates to trading hours; stale
// off-hours ticks are skipped so we never override Yahoo's close with a frozen MIS value.
async function fetchMisBatch(twSymbols) {
  const out = {};
  const chans = [];
  const bySym = {};   // stock-code (or index code t00/o00) → yf symbol
  const idxCodes = new Set();
  for (const s of twSymbols) {
    const ch = misChannel(s);
    if (!ch) continue;
    const code = ch.replace(/^(tse|otc)_/, "").replace(/\.tw$/, "");
    chans.push(ch);
    bySym[code] = s;
    if (isMisIndexChannel(ch)) idxCodes.add(code);
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
      // MIS is the PRIMARY TW source whenever it has today's quote — live during 09:00-13:30,
      // and the frozen official close after 13:30 (MIS keeps returning z=close, asOf=13:30).
      // Only >6h old (a previous session's leftover) is skipped so Yahoo's close can stand.
      if (!asOf || nowS - asOf > 6 * 3600) continue;
      // Price: last trade z when present; MIS blanks z to "-" between matches, so fall back
      // to the best bid/ask midpoint (spread is 1 tick for liquid names → ≈ last).
      let price = misNum(a.z);
      if (price == null) {
        const bid = misBookTop(a.b);
        const ask = misBookTop(a.a);
        if (bid != null && ask != null) price = Math.round(((bid + ask) / 2) * 100) / 100;
        // Exactly one side present = locked at the daily limit (up → no asks, down → no
        // bids). The live side IS the limit price, so use it rather than giving up.
        else price = bid != null ? bid : ask;
      }
      if (price == null) continue;
      // fresh (<5min) = live trading; older-but-same-session = the official closing print →
      // frontend labels "closed" as 收盤 (not 慢N分). (Adam 2026-07-06: 收盤後別假裝慢N分)
      const session = nowS - asOf <= 300 ? "regular" : "closed";
      // a.v = 當日累積成交量 (張, exchange-official) → ×1000 = shares, matching yfinance units.
      // 指數頻道沒有 a.v (指數本來就沒有「成交股數」) → isIndex 讓 caller 明確送出 null，
      // 不要回頭去撿 Yahoo 對 ^TWII 回的 0 (那個 0 會被前端印成「今日量 0 股 / 量比 0.0×」).
      const isIndex = idxCodes.has(code);
      const volLots = isIndex ? null : misNum(a.v);
      out[yf] = { price, prevClose: misNum(a.y), asOf, session, isIndex, dayVolume: volLots != null ? Math.round(volLots * 1000) : null };
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

    // Diagnostic: ?onDebug=1 reports each step of the overnight handshake. The overlay
    // worked from a laptop but not from the Worker, and the difference is environmental
    // (Cloudflare egress IPs, Set-Cookie surface) — guessing which is exactly the habit
    // that wastes rounds. Truncates the cookie; the A3 value is an anonymous Yahoo cookie,
    // not user data, but there is no reason to publish it in full.
    if (u.searchParams.get("onDebug") === "1") {
      const d = { ua: YF_UA.slice(0, 24) + "…", seeds: [] };
      try {
        // fc.yahoo.com returns 404 with ZERO Set-Cookie from Cloudflare egress (measured
        // 2026-08-04) even though it seeds the cookie fine from a residential IP. Probe
        // several candidates and report what each actually returns.
        let cookie = "";
        for (const seedUrl of [
          "https://fc.yahoo.com/",
          "https://finance.yahoo.com/",
          "https://finance.yahoo.com/quote/AMZN/",
          "https://query1.finance.yahoo.com/v1/test/getcrumb",
        ]) {
          let row = { url: seedUrl.replace("https://", "") };
          try {
            const seed = await fetch(seedUrl, {
              headers: { "User-Agent": YF_UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
              cf: { cacheTtl: 0 },
            });
            row.status = seed.status;
            const jar = typeof seed.headers.getSetCookie === "function"
              ? seed.headers.getSetCookie()
              : String(seed.headers.get("set-cookie") || "").split(/,(?=\s*[A-Za-z0-9_-]+=)/);
            row.jarCount = jar.filter(Boolean).length;
            row.names = jar.map((p) => String(p).trim().split("=")[0]).filter(Boolean).slice(0, 8);
            const c = jar.map((p) => String(p).trim().split(";")[0]).filter((p) => /^A[13]=/.test(p)).join("; ");
            row.aCookie = c.length;
            if (c && !cookie) cookie = c;
          } catch (e) { row.err = String(e).slice(0, 80); }
          d.seeds.push(row);
        }
        d.cookieLen = cookie.length;
        // Also: does getcrumb work at all from CF without any cookie?
        try {
          const bare = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
            headers: { "User-Agent": YF_UA, Accept: "application/json,text/plain,*/*" }, cf: { cacheTtl: 0 },
          });
          d.bareCrumbStatus = bare.status;
          d.bareCrumbSample = (await bare.text()).trim().slice(0, 40);
        } catch (e) { d.bareCrumbErr = String(e).slice(0, 80); }
        if (cookie) {
          const cr = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
            headers: { "User-Agent": YF_UA, Accept: "application/json,text/plain,*/*", Cookie: cookie },
            cf: { cacheTtl: 0 },
          });
          d.crumbStatus = cr.status;
          const body = (await cr.text()).trim();
          d.crumbLen = body.length;
          d.crumbSample = body.slice(0, 40);
          if (cr.ok && body && body.length <= 32 && !/[<>{}\s]/.test(body)) {
            const qr = await fetch(
              "https://query1.finance.yahoo.com/v7/finance/quote?symbols=AMZN&fields=" +
              encodeURIComponent(ON_FIELDS) + "&overnightPrice=true&lang=en-US&region=US&crumb=" +
              encodeURIComponent(body),
              { headers: { "User-Agent": YF_UA, Accept: "application/json,text/plain,*/*", Cookie: cookie }, cf: { cacheTtl: 0 } }
            );
            d.quoteStatus = qr.status;
            const qt = await qr.text();
            d.quoteSample = qt.slice(0, 300);
          }
        }
      } catch (e) { d.error = String(e); }
      // Exercise the PRODUCTION path too — the raw handshake above can succeed while the
      // real code path still yields nothing (KV cache, marketState gate, field shape).
      try {
        const auth = await getYahooAuth(env, true);
        d.prodAuth = auth ? { crumb: auth.crumb, cookieLen: auth.cookie.length } : null;
        if (auth) {
          const r = await fetch(
            "https://query1.finance.yahoo.com/v7/finance/quote?symbols=AMZN&fields=" +
            encodeURIComponent(ON_FIELDS) + "&overnightPrice=true&lang=en-US&region=US&crumb=" +
            encodeURIComponent(auth.crumb),
            { headers: { "User-Agent": YF_UA, Accept: "application/json,text/plain,*/*", Cookie: auth.cookie }, cf: { cacheTtl: 0 } }
          );
          const jj = await r.json();
          const q = jj && jj.quoteResponse && jj.quoteResponse.result && jj.quoteResponse.result[0];
          d.prodQuote = q ? {
            marketState: q.marketState,
            onPriceType: typeof q.overnightMarketPrice,
            onPrice: q.overnightMarketPrice,
            onTimeType: typeof q.overnightMarketTime,
            onTime: q.overnightMarketTime,
            regType: typeof q.regularMarketPrice,
            reg: q.regularMarketPrice,
          } : { note: "no result", keys: Object.keys(jj || {}) };
        }
        d.prodBatch = await fetchOvernightBatch(["AMZN", "PLTR"], env);
      } catch (e) { d.prodError = String(e).slice(0, 200); }
      return jsonResponse(d);
    }

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
          session: m.session || "regular",   // "closed" post-13:30 → frontend shows 🕒 收盤, not 慢N分
          asOf: m.asOf,        // MIS quote time (~seconds old live / 13:30 close) → labels the price's REAL time
          intraday,
          // 證交所當日累積量 (shares); Yahoo fallback。指數例外: 一律 null，不撿 Yahoo 的 0。
          dayVolume: m.isIndex ? null : (m.dayVolume != null ? m.dayVolume : (base.dayVolume ?? null)),
          src: "twse-mis",     // provenance (debugging)
        };
      }
    }

    // Overlay the US overnight session (Blue Ocean ATS) — the chart endpoint above simply
    // cannot see it, so without this the card sits on the 19:59 post-market print all night
    // and the freshness badge just counts the minutes up (Adam 2026-08-04, AMZN 慢520分).
    // Deliberately does NOT touch `intraday`: the sparkline is one regular-day x-axis, and
    // hanging an 04:00-ET point off the end would stretch the whole chart to draw one dot.
    const usSyms = symbols.filter((s) => !misChannel(s) && !s.startsWith("^") && !s.includes("="));
    if (usSyms.length) {
      const on = await fetchOvernightBatch(usSyms, env);
      for (const s of usSyms) {
        const o = on[s];
        if (!o) continue;   // no overnight quote for this name → Yahoo's regular/post stands
        const base = quotes[s] || {};
        const change = Math.round((o.price - o.prevClose) * 10000) / 10000;
        quotes[s] = {
          ...base,
          ok: true,
          price: o.price,
          prevClose: o.prevClose,          // = last REGULAR close (verified: price = prev + change)
          change,
          changePct: o.changePct != null ? o.changePct : (o.prevClose ? (change / o.prevClose) * 100 : null),
          session: "overnight",            // frontend renders 隔夜 + honest 慢N分 from asOf
          asOf: o.asOf,                    // the overnight print's OWN time (0–255 min old in testing)
          src: "yahoo-overnight",          // provenance (debugging)
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
