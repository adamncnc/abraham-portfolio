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

// Assertions about an UNDELIVERED shift must not depend on the live file happening to
// lack one. The evening shift actually ran at 2026-08-17 22:11 and every such test
// flipped from PASS to FAIL — they were testing the data, not the logic. Derive an
// explicit 'evening missing' fixture instead so they hold whatever the live file says.
const dataNoEvening = JSON.parse(JSON.stringify(data));
for (const d of dataNoEvening.days) d.shifts = (d.shifts || []).filter((s) => s.shift !== "evening");

// The day these blocks render must come from the data, not a hardcoded calendar date.
// The file keeps a rolling 7-day window: a literal "2026-08-17" dies the day it rolls
// out, and it already half-died the morning 2026-08-18 grew a morning-only record (the
// body-needle started resolving to a day the test does not render). Newest day whose
// morning AND midday both completed = safe on any future file.
const DAY = (data.days || [])
  .filter((d) => ["morning", "midday"].every((id) => (d.shifts || []).some((s) => s.shift === id && s.outcome === "complete")))
  .map((d) => d.date).sort().pop();
if (!DAY) { console.error("FATAL: live file has no day with morning+midday complete"); process.exit(2); }
// Taipei wall-clock HH:MM on DAY → the UTC instant the fake clock should freeze at.
const dayAt = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(DAY + "T00:00:00+08:00") + (h * 60 + m) * 60000).toISOString();
};

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
  // Taipei DAY 23:45 — all three shifts past deadline (evening deadline is 23:40); only two delivered.
  const ctx = makeCtx(dayAt("23:45"));
  ctx.setData(dataNoEvening);
  const now = ctx.taipeiNowParts();
  const blob = ctx.reportDayBlob(DAY);
  const sched = data.schedule.shifts;
  const st = (id) => ctx.reportShiftStatus(DAY, sched.find((s) => s.id === id), blob, now);
  check("delivered morning reads complete", st("morning").key === "complete", st("morning").key);
  check("delivered midday reads complete", st("midday").key === "complete", st("midday").key);
  check("T5a undelivered evening past deadline reads FAILED (backend dead)",
        st("evening").key === "failed", st("evening").key);
  check("day status is failed when a shift is missing",
        ctx.reportDayStatus(DAY, blob, now, true) === "failed");
}

console.log("");
console.log("== no false alarm before the deadline (grace window) ==");
{
  // Taipei DAY 22:30 — evening due 22:10, grace 90 → deadline 23:40. Late but inside grace.
  const ctx = makeCtx(dayAt("22:30"));
  ctx.setData(dataNoEvening);
  const now = ctx.taipeiNowParts();
  const blob = ctx.reportDayBlob(DAY);
  const ev = data.schedule.shifts.find((s) => s.id === "evening");
  const st = ctx.reportShiftStatus(DAY, ev, blob, now);
  check("T14b inside grace = pending, not failed", st.key === "pending", st.key);
  check("T14b label says it is due", st.label === "快到了", st.label);
}
{
  // Taipei DAY 20:00 — before due at all (due is 22:10).
  const ctx = makeCtx(dayAt("20:00"));
  ctx.setData(dataNoEvening);
  const now = ctx.taipeiNowParts();
  const ev = data.schedule.shifts.find((s) => s.id === "evening");
  const st = ctx.reportShiftStatus(DAY, ev, ctx.reportDayBlob(DAY), now);
  check("T14b before due = pending", st.key === "pending", st.key);
  check("T14b label says not yet", st.label === "還沒到", st.label);
}
{
  // One minute past the deadline → must flip to failed.
  const ctx = makeCtx(dayAt("23:41"));   // deadline is 23:40
  ctx.setData(dataNoEvening);
  const now = ctx.taipeiNowParts();
  const ev = data.schedule.shifts.find((s) => s.id === "evening");
  check("T14b one minute past deadline = failed",
        ctx.reportShiftStatus(DAY, ev, ctx.reportDayBlob(DAY), now).key === "failed");
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
  const ctx = makeCtx(dayAt("18:00"));
  ctx.setData(dataNoEvening);   // this block asserts evening is not-yet-due
  ctx.setDay(DAY);
  ctx.renderDailyReport();
  const html = ctx._nodes["report-body"].innerHTML;
  check("highlights block rendered", html.indexOf("今天的重點") >= 0);
  check("morning shift rendered", html.indexOf("早班") >= 0);
  check("midday shift rendered", html.indexOf("午班") >= 0);
  // 18:00 Taipei: evening is due at 22:10, so "not yet" is the CORRECT render here.
  // (First version of this test asserted "late" and failed — the test was wrong, not the code.)
  check("evening correctly shown as not-yet-due at 18:00", html.indexOf("還沒到") >= 0);
  check("no false alarm banner at 18:00", ctx._nodes["report-health"].innerHTML.indexOf("還沒進來") < 0);
}

console.log("");
console.log("== late evening DOES render as missing, and raises the banner ==");
{
  const ctx = makeCtx(dayAt("23:45"));   // past the 23:40 deadline
  ctx.setData(dataNoEvening);
  ctx.setDay(DAY);
  ctx.renderDailyReport();
  const html = ctx._nodes["report-body"].innerHTML;
  check("T5a late evening rendered as missing", html.indexOf("沒收到") >= 0);
  check("T5a banner names the missing shift",
        ctx._nodes["report-health"].innerHTML.indexOf("還沒進來") >= 0);
  // Derive the expectation from the data instead of hardcoding a phrase out of that
  // day's copy. The old version asserted "SanDisk" and broke the moment the editorial
  // content changed — it was testing today's wording, not that bodies render at all.
  // Derive it from the day actually being RENDERED (and from the fixture with evening
  // stripped): taking the first body anywhere in the file broke the morning 2026-08-18
  // grew records while this block still rendered 08-17.
  const firstBody = (((dataNoEvening.days || []).find((d) => d.date === DAY) || {}).shifts || [])
    .flatMap((s) => s.items || [])
    .map((i) => i.body)
    .find((b) => b && b.length > 12);
  // Bodies are Discord-flavoured text: ** becomes <strong>, ## becomes a heading div, and
  // & < > are escaped. A raw prefix slice therefore stops matching the moment the slice
  // lands on markup — which it now does, because restored bodies lead with a bold label.
  // Compare against a run of plain characters so this tests "bodies render" rather than
  // "bodies happen to start with undecorated text".
  const plainRun = (s) => (String(s).split(/[\n*#━─—=<>&]+/).find((x) => x.trim().length >= 12) || "").trim();
  const needle = plainRun(firstBody).slice(0, 12);
  check("fixture actually has an item body to render", !!firstBody);
  check("fixture body yields a markup-free run to look for", needle.length === 12, JSON.stringify(needle));
  check("item body rendered", !!needle && html.indexOf(needle) >= 0, needle || "no body in fixture");
  check("subtabs rendered 7 buttons",
        (ctx._nodes["report-subtabs"].innerHTML.match(/report-subtab/g) || []).length === 7);
  check("today is selected by default", ctx.getDay() === DAY);
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
