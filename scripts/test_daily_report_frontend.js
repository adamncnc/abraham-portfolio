/* Headless test for the 日報 front-end logic.
 *
 * Loads the REAL module source out of the deployed app.js (not a copy I retype), so the
 * thing under test is the thing that ships. Stubs only the DOM and the clock.
 */
const fs = require("fs");
const vm = require("vm");

const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "docs", "js", "app.js");
const DATA = path.join(ROOT, "docs", "data", "daily-report.json");

const src = fs.readFileSync(APP, "utf8");
const marker = "const REPORT_URL =";
const idx = src.indexOf(marker);
if (idx < 0) { console.error("FATAL: report module not found in app.js"); process.exit(2); }
const moduleSrc = src.slice(idx);

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (!cond && detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
}

// --- clock control: freeze "now" at a chosen real instant -------------------
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
  function stubEl() { return { innerHTML: "", textContent: "", classList: { contains: () => false, toggle: () => {} } }; }
  const ctx = {
    Date: FakeDate, Intl, console, JSON, Math, Object, String, Number, Array, Boolean,
    setInterval: () => 0, setTimeout: () => 0,
    escapeHtml: (s) => String(s == null ? "" : s),
    document: {
      hidden: false,
      getElementById: (id) => (nodes[id] = nodes[id] || stubEl()),
    },
    fetch: async () => { throw new Error("no network in test"); },
    _nodes: nodes,
  };
  vm.createContext(ctx);
  vm.runInContext(moduleSrc, ctx);
  // REPORT_DATA / REPORT_DAY are let-bindings: assigning ctx.X from outside does NOT
  // rebind them. Must assign from inside the context.
  ctx.setData = (d) => { ctx.__d = d; vm.runInContext('REPORT_DATA = __d;', ctx); };
  ctx.setDay  = (d) => { ctx.__day = d; vm.runInContext('REPORT_DAY = __day;', ctx); };
  ctx.getDay  = () => vm.runInContext('REPORT_DAY', ctx);
  return ctx;
}

const data = JSON.parse(fs.readFileSync(DATA, "utf8"));

console.log("== 7-day window is derived from the browser clock, not the JSON ==");
{
  // Taipei 2026-08-20 00:30 = UTC 2026-08-19T16:30Z. The JSON still ends at 08-17.
  const ctx = makeCtx("2026-08-19T16:30:00Z");
  ctx.setData(data);
  const dates = ctx.reportDates();
  check("T8b window advances past midnight with no backend run",
        dates[0] === "2026-08-20", "got " + dates[0]);
  check("T8b exactly 7 slots", dates.length === 7, String(dates.length));
  check("T8b oldest slot is 7 days back", dates[6] === "2026-08-14", "got " + dates[6]);
  const now = ctx.taipeiNowParts();
  check("T8b Taipei date correct just after midnight", now.date === "2026-08-20", now.date);
  check("T8b minutes-since-midnight correct", now.minutes === 30, String(now.minutes));
}

console.log("");
console.log("== overdue is computed client-side, so it works with the backend dead ==");
{
  // Taipei 2026-08-17 23:30 — all three shifts long past their deadline; only two delivered.
  const ctx = makeCtx("2026-08-17T15:30:00Z");
  ctx.setData(data);
  const now = ctx.taipeiNowParts();
  const blob = ctx.reportDayBlob("2026-08-17");
  const sched = data.schedule.shifts;
  const st = (id) => ctx.reportShiftStatus("2026-08-17", sched.find((s) => s.id === id), blob, now);
  check("delivered morning reads complete", st("morning").key === "complete", st("morning").key);
  check("delivered midday reads complete", st("midday").key === "complete", st("midday").key);
  check("T5a undelivered evening past deadline reads FAILED (backend dead)",
        st("evening").key === "failed", st("evening").key);
  check("day status is failed when a shift is missing",
        ctx.reportDayStatus("2026-08-17", blob, now, true) === "failed");
}

console.log("");
console.log("== no false alarm before the deadline (grace window) ==");
{
  // Taipei 2026-08-17 21:30 — evening due 21:00, grace 120 → deadline 23:00. Late but inside grace.
  const ctx = makeCtx("2026-08-17T13:30:00Z");
  ctx.setData(data);
  const now = ctx.taipeiNowParts();
  const blob = ctx.reportDayBlob("2026-08-17");
  const ev = data.schedule.shifts.find((s) => s.id === "evening");
  const st = ctx.reportShiftStatus("2026-08-17", ev, blob, now);
  check("T14b inside grace = pending, not failed", st.key === "pending", st.key);
  check("T14b label says it is due", st.label === "快到了", st.label);
}
{
  // Taipei 2026-08-17 20:00 — before due at all.
  const ctx = makeCtx("2026-08-17T12:00:00Z");
  ctx.setData(data);
  const now = ctx.taipeiNowParts();
  const ev = data.schedule.shifts.find((s) => s.id === "evening");
  const st = ctx.reportShiftStatus("2026-08-17", ev, ctx.reportDayBlob("2026-08-17"), now);
  check("T14b before due = pending", st.key === "pending", st.key);
  check("T14b label says not yet", st.label === "還沒到", st.label);
}
{
  // One minute past the deadline → must flip to failed.
  const ctx = makeCtx("2026-08-17T15:01:00Z");   // Taipei 23:01, deadline 23:00
  ctx.setData(data);
  const now = ctx.taipeiNowParts();
  const ev = data.schedule.shifts.find((s) => s.id === "evening");
  check("T14b one minute past deadline = failed",
        ctx.reportShiftStatus("2026-08-17", ev, ctx.reportDayBlob("2026-08-17"), now).key === "failed");
}

console.log("");
console.log("== days from before the feature existed are not painted as failures ==");
{
  const ctx = makeCtx("2026-08-17T10:00:00Z");
  ctx.setData(data);
  const now = ctx.taipeiNowParts();
  const old = "2026-08-11";
  check("empty pre-feature day = nodata, not failed",
        ctx.reportDayStatus(old, ctx.reportDayBlob(old), now, false) === "nodata",
        ctx.reportDayStatus(old, ctx.reportDayBlob(old), now, false));
}

console.log("");
console.log("== health: an error only shows while it is not superseded ==");
{
  const ctx = makeCtx("2026-08-17T10:00:00Z");
  const d1 = JSON.parse(JSON.stringify(data));
  d1.health.evening = {
    last_attempt_at: "2026-08-16T21:05:00+08:00", last_attempt_outcome: "failed",
    last_delivery_at: "2026-08-17T21:02:00+08:00",
    last_error: { at: "2026-08-16T21:05:00+08:00", message: "boom" },
  };
  ctx.setData(d1);
  ctx.renderReportHealth(ctx.taipeiNowParts());
  const html = ctx._nodes["report-health"].innerHTML;
  check("superseded error is NOT shown", html.indexOf("boom") < 0);

  const ctx2 = makeCtx("2026-08-17T10:00:00Z");
  const d2 = JSON.parse(JSON.stringify(data));
  d2.health.evening = {
    last_attempt_at: "2026-08-17T21:05:00+08:00", last_attempt_outcome: "failed",
    last_delivery_at: "2026-08-16T21:02:00+08:00",
    last_error: { at: "2026-08-17T21:05:00+08:00", message: "boom" },
  };
  ctx2.setData(d2);
  ctx2.renderReportHealth(ctx2.taipeiNowParts());
  check("unsuperseded error IS shown", ctx2._nodes["report-health"].innerHTML.indexOf("boom") >= 0);
}

console.log("");
console.log("== the data timestamp is always printed ==");
{
  const ctx = makeCtx("2026-08-17T10:00:00Z");
  ctx.setData(data);
  ctx.renderReportHealth(ctx.taipeiNowParts());
  check("stamp rendered", ctx._nodes["report-health"].innerHTML.indexOf("資料時間") >= 0);
}

console.log("");
console.log("== rendering the day produces the expected content ==");
{
  const ctx = makeCtx("2026-08-17T10:00:00Z");
  ctx.setData(data);
  ctx.setDay("2026-08-17");
  ctx.renderDailyReport();
  const html = ctx._nodes["report-body"].innerHTML;
  check("highlights block rendered", html.indexOf("今天的重點") >= 0);
  check("morning shift rendered", html.indexOf("早班") >= 0);
  check("midday shift rendered", html.indexOf("午班") >= 0);
  // 18:00 Taipei: evening is due at 21:00, so "not yet" is the CORRECT render here.
  // (First version of this test asserted "late" and failed — the test was wrong, not the code.)
  check("evening correctly shown as not-yet-due at 18:00", html.indexOf("還沒到") >= 0);
  check("no false alarm banner at 18:00", ctx._nodes["report-health"].innerHTML.indexOf("還沒進來") < 0);
}

console.log("");
console.log("== late evening DOES render as missing, and raises the banner ==");
{
  const ctx = makeCtx("2026-08-17T15:30:00Z");   // Taipei 23:30, past deadline 23:00
  ctx.setData(data);
  ctx.setDay("2026-08-17");
  ctx.renderDailyReport();
  const html = ctx._nodes["report-body"].innerHTML;
  check("T5a late evening rendered as missing", html.indexOf("沒收到") >= 0);
  check("T5a banner names the missing shift",
        ctx._nodes["report-health"].innerHTML.indexOf("還沒進來") >= 0);
  check("item body rendered", html.indexOf("SanDisk") >= 0);
  check("subtabs rendered 7 buttons",
        (ctx._nodes["report-subtabs"].innerHTML.match(/report-subtab/g) || []).length === 7);
  check("today is selected by default", ctx.getDay() === "2026-08-17");
}

console.log("");
console.log("== day selection is session-only (never persisted) ==");
{
  check("module does not write day selection to storage",
        moduleSrc.indexOf("lsSet(\"abraham.reportDay") < 0 && moduleSrc.indexOf("abraham.reportDay") < 0);
}

console.log("");
if (failures) { console.log("FAILED " + failures); process.exit(1); }
console.log("all front-end tests passed");
