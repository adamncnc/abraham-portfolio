/* Tests for 日報 v2 — verbatim bodies + fold/unfold (Adam 2026-08-17).
 *
 * Loads the REAL module source out of the shipped app.js, and — unlike the older
 * harness — also loads the REAL escapeHtml. The old harness stubs escapeHtml to the
 * identity function, which is fine for layout assertions but would make an
 * escaping test pass for entirely the wrong reason. A gate that cannot fail is
 * not a gate.
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "docs", "js", "app.js");
const src = fs.readFileSync(APP, "utf8");

const idx = src.indexOf("const REPORT_URL =");
if (idx < 0) { console.error("FATAL: report module not found in app.js"); process.exit(2); }
const moduleSrc = src.slice(idx);

// Pull the real escapeHtml out of the same file rather than retyping it.
const escStart = src.indexOf("function escapeHtml(s) {");
const escEnd = src.indexOf("\n}", escStart);
if (escStart < 0 || escEnd < 0) { console.error("FATAL: escapeHtml not found in app.js"); process.exit(2); }
const escSrc = src.slice(escStart, escEnd + 2);

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (!cond && detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
}

function makeCtx(nowISO) {
  const RealDate = Date;
  const fixed = new RealDate(nowISO).getTime();
  function FakeDate(...args) {
    if (args.length === 0) return new RealDate(fixed);
    return new RealDate(...args);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => fixed;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;

  const nodes = {};
  const stubEl = () => ({ innerHTML: "", textContent: "", classList: { contains: () => false, toggle: () => {} } });
  const ctx = {
    Date: FakeDate, Intl, console, JSON, Math, Object, String, Number, Array, Boolean, Map, Set, RegExp,
    setInterval: () => 0, setTimeout: () => 0,
    document: { hidden: false, getElementById: (id) => (nodes[id] = nodes[id] || stubEl()) },
    fetch: async () => { throw new Error("no network in test"); },
    _nodes: nodes,
  };
  vm.createContext(ctx);
  vm.runInContext(escSrc, ctx);      // real escapeHtml, before the module that calls it
  vm.runInContext(moduleSrc, ctx);
  ctx.setData = (d) => { ctx.__d = d; vm.runInContext("REPORT_DATA = __d;", ctx); };
  ctx.setDay = (d) => { ctx.__day = d; vm.runInContext("REPORT_DAY = __day;", ctx); };
  ctx.call = (expr) => vm.runInContext(expr, ctx);
  return ctx;
}

const SCHEDULE = {
  timezone: "Asia/Taipei",
  shifts: [
    { id: "morning", name: "早班", due: "06:10", grace_min: 120, days: "mon-sun" },
    { id: "midday", name: "午班", due: "14:10", grace_min: 120, days: "mon-sun" },
    { id: "evening", name: "晚班", due: "22:10", grace_min: 120, days: "mon-sun" },
  ],
  skip_dates: [],
};

function dataWith(days) {
  return { schema: 1, _updated: "2026-08-17T20:00:00+08:00", revision: 9, schedule: SCHEDULE, health: {}, days };
}

// ── 1. escaping happens BEFORE decoration ───────────────────────────────────
console.log("\n== verbatim body is escaped before it is decorated ==");
{
  const ctx = makeCtx("2026-08-17T12:00:00Z");
  const evil = '<img src=x onerror=alert(1)> and <script>bad()</script>';
  const out = ctx.call("reportRichText(" + JSON.stringify(evil) + ")");
  check("no raw <img> survives", !/<img/i.test(out), out.slice(0, 80));
  check("no raw <script> survives", !/<script/i.test(out), out.slice(0, 80));
  check("angle brackets became entities", out.includes("&lt;img"), out.slice(0, 80));
}
{
  // A body that contains the literal text "**" around an escaped entity must not be able
  // to reconstitute a tag: decoration only ever adds <strong>, never re-parses entities.
  const ctx = makeCtx("2026-08-17T12:00:00Z");
  const out = ctx.call("reportRichText(" + JSON.stringify('**<b>x</b>**') + ")");
  check("bold applied", out.includes("<strong>"), out);
  check("inner tag still escaped", out.includes("&lt;b&gt;"), out);
}

// ── 2. markdown-ish decoration ──────────────────────────────────────────────
console.log("\n== Discord-flavoured text renders ==");
{
  const ctx = makeCtx("2026-08-17T12:00:00Z");
  const out = ctx.call("reportRichText(" + JSON.stringify("**粗體**\n\n━━━━━━\n## 標題\n一般行") + ")");
  check("bold → <strong>", out.includes("<strong>粗體</strong>"), out);
  check("blank line → gap", out.includes("report-gap"), out);
  check("━━━ → rule", out.includes("report-rule"), out);
  check("## → heading", out.includes('report-h2">標題'), out);
  check("plain line kept", out.includes("<div>一般行</div>"), out);
}
{
  const ctx = makeCtx("2026-08-17T12:00:00Z");
  const out = ctx.call("reportRichText('')");
  check("empty body yields empty string", out === "", JSON.stringify(out));
}

// ── 3. long bodies clamp, short ones do not ─────────────────────────────────
console.log("\n== long verbatim bodies clamp behind 展開全文 ==");
{
  const ctx = makeCtx("2026-08-17T12:00:00Z");
  const clamp = ctx.call("REPORT_CLAMP_CHARS");
  const short = ctx.call("reportItemHtml({t:'t',s:'neutral',tickers:[],body:'短'})");
  check("short body not clamped", !short.includes("clamped"), short.slice(0, 100));
  check("short body has no 展開 button", !short.includes("report-more"), short.slice(0, 100));

  const longBody = "字".repeat(clamp + 50);
  const long = ctx.call("reportItemHtml({t:'t',s:'neutral',tickers:[],body:" + JSON.stringify(longBody) + "})");
  check("long body clamped", long.includes("clamped"), long.slice(0, 120));
  check("long body offers 展開全文", long.includes("report-more"), long.slice(0, 120));
  check("button reports the real length", long.includes(String(clamp + 50) + " 字"), long.slice(0, 200));
  check("full text is present in the DOM, not truncated",
    long.includes("字".repeat(20)) && long.split("字").length - 1 >= clamp + 50,
    "clamping must be visual only — the whole body must ship");
}

// ── 4. fold state ───────────────────────────────────────────────────────────
console.log("\n== sections default open, and honour REPORT_CLOSED ==");
{
  const ctx = makeCtx("2026-08-17T12:00:00Z");   // 20:00 Taipei
  ctx.setData(dataWith([{
    date: "2026-08-17", top: ["重點一"],
    shifts: [{ id: "s1", shift: "morning", outcome: "complete", delivered_at: "2026-08-17T06:10:00+08:00",
      summary: "摘要", error: null, items: [{ t: "標題", s: "neutral", tickers: [], body: "內文" }] }],
    events: [],
  }]));
  ctx.setDay("2026-08-17");
  ctx.call("renderDailyReport()");
  let html = ctx._nodes["report-body"].innerHTML;
  check("shift section rendered open by default", /class="report-shift[^"]*\sopen"/.test(html), html.slice(0, 200));
  check("caret shows ▾ when open", html.includes("▾"), html.slice(0, 200));
  check("fold-all bar present", html.includes("report-foldall"), html.slice(0, 160));
  check("section carries a stable data-sect key", html.includes('data-sect="2026-08-17.morning"'), html.slice(0, 300));

  // Scope the assertion to the section actually closed. The schedule renders all three
  // shifts, so midday/evening stay open and a page-wide regex would always find one —
  // it would pass whether or not folding worked.
  const sectClass = (h, key) => {
    const m = new RegExp('<section class="([^"]*)" data-sect="' + key.replace(/\./g, "\\.") + '"').exec(h);
    return m ? m[1] : null;
  };
  check("sanity: morning section is open before closing",
    /\bopen\b/.test(sectClass(html, "2026-08-17.morning") || ""), sectClass(html, "2026-08-17.morning"));

  ctx.call("REPORT_CLOSED.add('2026-08-17.morning')");
  ctx.call("renderDailyReport()");
  html = ctx._nodes["report-body"].innerHTML;
  check("closed section loses .open", !/\bopen\b/.test(sectClass(html, "2026-08-17.morning") || ""),
    sectClass(html, "2026-08-17.morning"));
  check("its sibling stays open (fold is per-section)",
    /\bopen\b/.test(sectClass(html, "2026-08-17.midday") || ""), sectClass(html, "2026-08-17.midday"));
  check("caret flips to ▸", html.includes("▸"), html.slice(0, 200));
  check("body still in DOM (CSS hides it, JS does not drop content)", html.includes("內文"), html.slice(0, 300));
}

// ── 5. non-shift streams group by name ──────────────────────────────────────
console.log("\n== other sources group into their own foldable blocks ==");
{
  const ctx = makeCtx("2026-08-17T12:00:00Z");
  ctx.setData(dataWith([{
    date: "2026-08-17", top: [], shifts: [],
    events: [
      { id: "e1", t: "A", s: "neutral", tickers: [], body: "b1", stream: "網紅摘要", occurred_at: "2026-08-17T07:00:00+08:00" },
      { id: "e2", t: "B", s: "neutral", tickers: [], body: "b2", stream: "網紅摘要", occurred_at: "2026-08-17T15:00:00+08:00" },
      { id: "e3", t: "C", s: "neutral", tickers: [], body: "b3", stream: "新聞雷達", occurred_at: "2026-08-17T20:50:00+08:00" },
      { id: "e4", t: "D", s: "neutral", tickers: [], body: "b4", occurred_at: "2026-08-17T21:30:00+08:00" },
    ],
  }]));
  ctx.setDay("2026-08-17");
  ctx.call("renderDailyReport()");
  const html = ctx._nodes["report-body"].innerHTML;
  check("網紅摘要 group exists", html.includes("網紅摘要"), html.slice(0, 200));
  check("新聞雷達 group exists", html.includes("新聞雷達"), html.slice(0, 200));
  check("stream with 2 items shows 2 則", html.includes("2 則"), html.slice(0, 400));
  check("unlabelled event falls back to 臨時事件", html.includes("臨時事件"), html.slice(0, 400));
  check("all four bodies present", ["b1", "b2", "b3", "b4"].every((b) => html.includes(b)), html.slice(0, 400));
  check("event time prefixes the title", html.includes("20:50"), html.slice(0, 600));
}

// ── 6. the count in the header includes stream items ────────────────────────
console.log("\n== header count reflects everything on the day ==");
{
  const ctx = makeCtx("2026-08-17T12:00:00Z");
  ctx.setData(dataWith([{
    date: "2026-08-17", top: [], shifts: [
      { id: "s1", shift: "morning", outcome: "complete", delivered_at: "2026-08-17T06:10:00+08:00",
        summary: "s", error: null, items: [{ t: "x", s: "neutral", tickers: [], body: "y" }] }],
    events: [{ id: "e1", t: "A", s: "neutral", tickers: [], body: "b", stream: "網紅摘要", occurred_at: "2026-08-17T07:00:00+08:00" }],
  }]));
  ctx.setDay("2026-08-17");
  ctx.call("renderDailyReport()");
  check("count = 1 shift item + 1 event", ctx._nodes["report-count"].textContent === "2 則",
    ctx._nodes["report-count"].textContent);
}

console.log("");
if (failures) { console.error(failures + " test(s) FAILED"); process.exit(1); }
console.log("all 日報 verbatim/fold tests passed");
