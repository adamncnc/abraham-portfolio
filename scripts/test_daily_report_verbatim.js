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

// ── 3. items render collapsed to a bare title ───────────────────────────────
console.log("\n== an item shows only its title until it is clicked ==");
{
  const ctx = makeCtx("2026-08-17T12:00:00Z");
  const it = ctx.call("reportItemHtml({t:'標題',s:'neutral',tickers:['2330.TW'],src:'來源',body:'內文'})");
  check("item starts collapsed", !/class="report-item[^"]*\sopen"/.test(it), it.slice(0, 120));
  check("head is the click target", it.includes("data-item-toggle"), it.slice(0, 160));
  check("caret starts ▸", it.includes('report-item-caret">▸'), it.slice(0, 200));
  // Ordering must not be expressed as a bare indexOf comparison: a MISSING marker yields
  // -1, which compares as "earlier than everything", so deleting the wrapper entirely would
  // make half of these pass. Require both markers to exist before comparing positions.
  const before = (a, b) => { const ia = it.indexOf(a), ib = it.indexOf(b); return ia >= 0 && ib >= 0 && ia < ib; };
  const DET = 'class="report-item-detail"';
  check("collapsible wrapper exists at all", it.includes(DET), it);
  check("title is outside the collapsible part", before("標題", DET), it);
  check("body sits inside the collapsible part", before(DET, "內文"), it);
  check("tickers are hidden until expanded (Adam: 初始只顯示標題)", before(DET, "2330.TW"), it);
  check("source is hidden until expanded", before(DET, "來源"), it);

  // The old 420-char clamp is gone: one-open-at-a-time already bounds page length, and the
  // clamp would put a third click between Adam and the text he asked to see in full.
  const longBody = "字".repeat(2000);
  const long = ctx.call("reportItemHtml({t:'t',s:'neutral',tickers:[],body:" + JSON.stringify(longBody) + "})");
  check("long body is not clamped", !long.includes("clamped"), long.slice(0, 140));
  check("no 展開全文 button remains", !long.includes("report-more"), long.slice(0, 140));
  check("full text ships in the DOM", long.split("字").length - 1 >= 2000, "body must not be truncated");

  // A caret on an item that cannot open is a dead control.
  const bare = ctx.call("reportItemHtml({t:'只有標題',s:'neutral',tickers:[]})");
  check("item with no content is not clickable", !bare.includes("data-item-toggle"), bare);
  check("item with no content has no caret", !bare.includes("report-item-caret"), bare);
  check("item with no content is marked bare", bare.includes("report-item-bare"), bare);
}

// ── 3b. accordion behaviour, against a fake DOM ─────────────────────────────
// Exercises the real functions. Asserting only on markup would leave every rule Adam
// actually stated (one open per shift, reset on close, sections independent) unverified.
console.log("\n== one item open per shift; shifts stay independent ==");
{
  const ctx = makeCtx("2026-08-17T12:00:00Z");

  const mkEl = (cls) => {
    const set = new Set(String(cls || "").split(/\s+/).filter(Boolean));
    const node = { children: [], textContent: "", _classes: set };
    node.classList = { contains: (c) => set.has(c), add: (c) => set.add(c), remove: (c) => set.delete(c) };
    node.append = (...kids) => { node.children.push(...kids); return node; };
    const all = (n, out) => { for (const c of n.children) { out.push(c); all(c, out); } return out; };
    const hit = (n, sel) => sel.split(".").filter(Boolean).every((c) => n._classes.has(c));
    node.querySelectorAll = (sel) => all(node, []).filter((n) => hit(n, sel));
    node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
    return node;
  };
  const mkSection = (n) => {
    const sect = mkEl("report-shift open");
    const caret = mkEl("report-caret"); caret.textContent = "▾";
    sect.append(mkEl("report-shift-h").append(caret));
    const items = [];
    for (let i = 0; i < n; i++) {
      const ic = mkEl("report-item-caret"); ic.textContent = "▸";
      const li = mkEl("report-item").append(mkEl("report-item-head").append(ic), mkEl("report-item-detail"));
      sect.append(li); items.push(li);
    }
    return { sect, items, caret };
  };
  const openIdx = (b) => b.items.map((li, i) => (li.classList.contains("open") ? i : -1)).filter((i) => i >= 0);
  const toggle = (b, i) => { ctx.__s = b.sect; ctx.__li = b.items[i]; ctx.call("reportToggleItem(__li, __s)"); };
  const setSect = (b, open) => { ctx.__s = b.sect; ctx.__o = open; ctx.call("reportSetSectionOpen(__s, __o)"); };

  const A = mkSection(3), B = mkSection(3);
  check("everything starts collapsed", openIdx(A).length === 0 && openIdx(B).length === 0);

  toggle(A, 1);
  check("clicking an item opens it", JSON.stringify(openIdx(A)) === "[1]", JSON.stringify(openIdx(A)));
  check("its caret flips to ▾", A.items[1].querySelector(".report-item-caret").textContent === "▾");

  toggle(A, 2);
  check("opening a second item closes the first", JSON.stringify(openIdx(A)) === "[2]", JSON.stringify(openIdx(A)));
  check("the closed one's caret resets to ▸",
    A.items[1].querySelector(".report-item-caret").textContent === "▸");

  toggle(A, 2);
  check("clicking the open item closes it", openIdx(A).length === 0, JSON.stringify(openIdx(A)));

  toggle(A, 0); toggle(B, 2);
  check("each shift keeps its own open item",
    JSON.stringify(openIdx(A)) === "[0]" && JSON.stringify(openIdx(B)) === "[2]",
    JSON.stringify(openIdx(A)) + " / " + JSON.stringify(openIdx(B)));

  setSect(B, false);
  check("closing a shift drops .open", !B.sect.classList.contains("open"));
  check("closing a shift resets its items", openIdx(B).length === 0, JSON.stringify(openIdx(B)));
  check("closing a shift flips its caret", B.caret.textContent === "▸");
  check("the OTHER shift is untouched (Adam: 為獨立控制)",
    JSON.stringify(openIdx(A)) === "[0]", JSON.stringify(openIdx(A)));

  setSect(B, true);
  check("re-opening a shift restores no item (Adam: 不需要記憶)", openIdx(B).length === 0, JSON.stringify(openIdx(B)));
  check("re-opening a shift restores .open + ▾",
    B.sect.classList.contains("open") && B.caret.textContent === "▾");
}

// ── 3c. the click listener must not re-render on a fold ─────────────────────
// A rebuild collapses the item accordion in EVERY section, so re-rendering here would
// silently undo 各區塊獨立控制 the moment a second shift was touched — and the markup would
// still look correct, which is why this needs its own check. Asserted at source level:
// the listener sits above the module slice this harness loads, so no fake DOM can reach it.
console.log("\n== folding mutates the DOM instead of rebuilding ==");
{
  const from = src.indexOf("// 日報 folding (Adam 2026-08-17");
  const to = src.indexOf("// 進場區內 / 回檔排行榜", from);
  check("fold branches located in the listener", from > 0 && to > from, from + ".." + to);
  const branch = src.slice(from, to);
  check("section fold does not re-render", !branch.includes("renderDailyReport"), branch.slice(0, 400));
  check("section fold calls the DOM helper", branch.includes("reportSetSectionOpen"), branch.slice(0, 400));
  check("item clicks are routed to the accordion", branch.includes("reportToggleItem"), branch.slice(0, 400));
  check("item click target matches the rendered attribute", branch.includes("data-item-toggle"), branch.slice(0, 400));
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

// ── 4b. editorial dressing (2026-08-18 美化) ────────────────────────────────
// The skin adds masthead/tone/seal/stagger markup. These checks pin the NEW markup so a
// refactor cannot silently drop it, while every older section above pins that the skin
// changed no behaviour.
console.log("\n== masthead, tone accents and stagger decorate without changing behaviour ==");
{
  const ctx = makeCtx("2026-08-17T12:00:00Z");   // Taipei 2026-08-17 20:00 → selected day IS today
  ctx.setData(dataWith([{
    date: "2026-08-17", top: ["重點一"],
    shifts: [{ id: "s1", shift: "morning", outcome: "complete", delivered_at: "2026-08-17T06:10:00+08:00",
      summary: "摘要", error: null, items: [{ t: "標題", s: "neutral", tickers: [], body: "內文" }] }],
    events: [{ id: "e1", t: "🧠 我的看法", s: "neutral", tickers: [], body: "b", stream: "網紅摘要", occurred_at: "2026-08-17T07:00:00+08:00" }],
  }]));
  ctx.setDay("2026-08-17");
  ctx.call("renderDailyReport()");
  const html = ctx._nodes["report-body"].innerHTML;
  check("masthead renders the dateline", html.includes("report-mast") && html.includes("8 月 17 日"), html.slice(0, 200));
  check("今天 chip shows when the selected day is today", html.includes("report-mast-today"), html.slice(0, 300));
  check("shift section carries its tone class", /class="report-shift[^"]*report-tone-morning[^"]*"/.test(html), html.slice(0, 500));
  check("stream section carries a tone class", html.includes("report-tone-kol"), html.slice(0, 500));
  check("shift header shows the seal glyph", html.includes('report-sig">早'), html.slice(0, 500));
  check("stream header shows the seal glyph", html.includes('report-sig">網'), html.slice(0, 500));
  check("shift header shows an item count", html.includes('report-shift-count">1 則'), html.slice(0, 600));
  check("items carry a stagger index", html.includes('style="--i:0"'), html.slice(0, 600));
  check("🧠 titles are marked as my own read", html.includes("report-brain"), html.slice(0, 600));

  // The hh:mm prefix a stream event gets must not defeat the 🧠 marker.
  const withTime = ctx.call("reportItemHtml({t:'07:00 🧠 x',s:'neutral',tickers:[],body:'y'})");
  check("hh:mm prefix still marks 🧠", withTime.includes("report-brain"), withTime.slice(0, 140));
  // And a plain news title must NOT be marked as mine.
  const plain = ctx.call("reportItemHtml({t:'台積電漲',s:'positive',tickers:[],body:'y'})");
  check("plain title is not marked as mine", !plain.includes("report-brain"), plain.slice(0, 140));
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
      { id: "e5", t: "22:00 已帶時間", s: "neutral", tickers: [], body: "b5", stream: "新聞雷達", occurred_at: "2026-08-17T22:00:00+08:00" },
    ],
  }]));
  ctx.setDay("2026-08-17");
  ctx.call("renderDailyReport()");
  const html = ctx._nodes["report-body"].innerHTML;
  check("網紅摘要 group exists", html.includes("網紅摘要"), html.slice(0, 200));
  check("新聞雷達 group exists", html.includes("新聞雷達"), html.slice(0, 200));
  check("stream with 2 items shows 2 則", html.includes("2 則"), html.slice(0, 400));
  check("unlabelled event falls back to 臨時事件", html.includes("臨時事件"), html.slice(0, 400));
  check("all five bodies present", ["b1", "b2", "b3", "b4", "b5"].every((b) => html.includes(b)), html.slice(0, 400));
  check("event time prefixes the title", html.includes("20:50 C"), html.slice(0, 600));
  check("time is NOT doubled when the title already carries it", !html.includes("22:00 22:00"), html.slice(0, 800));
  check("self-timed title still renders once", html.includes("22:00 已帶時間"), html.slice(0, 800));
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
