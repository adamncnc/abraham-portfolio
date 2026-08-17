/* Proves the publish gate still blocks real violations after the paragraph-join fix.
 *
 * The fix (join chunks with "\n\n" instead of "\n") could plausibly have been a way to
 * make a blocked publish pass. So this asserts BOTH directions:
 *   1. a genuine violation — action language about a stale-zone ticker in the SAME item —
 *      must still exit 1. If this ever passes, the gate is dead and the fix was wrong.
 *   2. the false positive — a zone word in one item, the ticker in a DIFFERENT item —
 *      must exit 0.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const GATE = path.join(__dirname, "check_daily_report_zones.js");
const HUNT = path.join(os.homedir(), "Abraham", ".hunt-list.json");

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (!cond && detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
};

// Pick a real frozen / stale-zone ticker out of the live hunt list rather than inventing
// one, so the fixture exercises the same code path production does.
const hunt = JSON.parse(fs.readFileSync(HUNT, "utf8")).entries;
const frozen = hunt.find((e) => e.frozen === true && (e.zone_lo == null || e.zone_hi == null));
if (!frozen) { console.error("FATAL: no frozen null-zone entry in hunt list to test with"); process.exit(2); }
const name = frozen.name || String(frozen.ticker).split(".")[0];
console.log("  using real stale entry: " + frozen.ticker + " (" + name + ")");

function report(items) {
  return {
    schema: 1, _updated: "2026-08-17T23:00:00+08:00", revision: 1,
    schedule: { timezone: "Asia/Taipei", shifts: [
      { id: "morning", name: "早班", due: "06:10", grace_min: 120, days: "mon-sun" },
      { id: "midday", name: "午班", due: "14:10", grace_min: 120, days: "mon-sun" },
      { id: "evening", name: "晚班", due: "22:10", grace_min: 90, days: "mon-sun" }] , skip_dates: [] },
    health: {},
    days: [{ date: "2026-08-17", top: [], events: [], shifts: [
      { id: "s", shift: "morning", outcome: "complete", delivered_at: "2026-08-17T06:10:00+08:00",
        summary: "測試", error: null, items: items }] }],
  };
}

function runGate(obj, label) {
  const f = path.join(os.tmpdir(), "zonegate-" + label + ".json");
  fs.writeFileSync(f, JSON.stringify(obj), "utf8");
  try {
    execFileSync(process.execPath, [GATE, f], { stdio: "pipe" });
    fs.unlinkSync(f);
    return 0;
  } catch (e) {
    fs.unlinkSync(f);
    if (process.env.ZG_DEBUG) console.error((e.stderr||'').toString().slice(0,400));
    return e.status === undefined ? -1 : e.status;
  }
}

// ── 1. genuine violation: same item names the ticker AND recommends buying in its zone
const violation = report([{
  t: name + " 進場區可以進了",
  s: "positive", tickers: [String(frozen.ticker).split(".")[0]], notify_reason: "none",
  body: name + " 的進場區現在可以買，等回落就進場加碼。這一檔的區間我建議在這裡買進。",
  src: "test",
}]);
check("genuine violation still BLOCKS (exit 1)", runGate(violation, "bad") === 1,
      "got exit " + runGate(violation, "bad") + " — if 0, the gate is dead");

// ── 2. the false positive the fix targets: zone word and ticker in DIFFERENT items
// Item 1 deliberately names NO hunt-list ticker. If it named one, its own buy language
// would be a genuine violation for that ticker and the test would block for the right
// reason while looking like the bug (first draft did exactly that with 台積電, whose zone
// is itself stale). With no ticker of its own, the ONLY way this can block is if the
// gate wrongly attributes item 1's zone word to the ticker named in item 2.
const falsePositive = report([
  { t: "今天的進場框架檢查", s: "neutral", tickers: [], notify_reason: "none",
    body: "其中一檔的進場區今天可以分批買進，等回落再加一些。", src: "test" },
  { t: name + " 的評估已經過期", s: "negative", tickers: [String(frozen.ticker).split(".")[0]],
    notify_reason: "none",
    body: name + " 被我標成凍結，該有的評估欄位全是空的。我今天對這一檔沒有任何看法。", src: "test" },
]);
const fpExit = runGate(falsePositive, "fp");
check("cross-item false positive does NOT block (exit 0)", fpExit === 0, "got exit " + fpExit);

// ── 3. the real published report must pass
const realExit = runGate(JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "docs", "data", "daily-report.json"), "utf8")), "real");
check("the live published report passes", realExit === 0, "got exit " + realExit);

console.log("");
if (failures) { console.error(failures + " test(s) FAILED"); process.exit(1); }
console.log("all zone-gate paragraph tests passed");
