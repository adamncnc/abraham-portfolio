/* Verify the 模擬倉 removal did not leave a trap.
 *
 * The real risk is not "the tab is gone" — it is that a saved preference pointing at the
 * removed tab activates nothing and leaves Adam staring at a blank page. His pref is
 * cloud-synced, so it is live on his phone right now.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "docs/js/app.js");
const HTML = path.join(ROOT, "docs/index.html");

const app = fs.readFileSync(APP, "utf8");
const html = fs.readFileSync(HTML, "utf8");

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (!cond && detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
}

console.log("== the tab really is gone from the page ==");
check("no sim tab button", html.indexOf('data-tab="sim"') < 0);
check("no sim sub-tab nav", html.indexOf('id="sim-subtabs"') < 0);
check("no sim panels", html.indexOf('id="panel-sim-') < 0);
check("zero 'sim' occurrences left in html", (html.match(/sim/g) || []).length === 0,
      String((html.match(/sim/g) || []).length));
check("日報 tab still present", html.indexOf('data-tab="report"') >= 0);
check("other tabs untouched",
      ["tw", "us", "idx", "pos"].every((t) => html.indexOf('data-tab="' + t + '"') >= 0));

console.log("");
console.log("== no sim work is scheduled any more ==");
check("loadSim() no longer called on load", app.indexOf("    loadSim();") < 0);
check("renderSim loop removed from liveRefresh", app.indexOf("SIM_BOOKS.forEach(({ key })") < 0);
check("sim sub-tab click handler removed", app.indexOf('closest(".sim-subtab")') < 0);
check("summary-hide condition no longer mentions sim", app.indexOf('which === "sim" || which === "report"') < 0);

console.log("");
console.log("== THE TRAP: a stale saved pref must not blank the page ==");
{
  // Extract activateTab and exercise its tab-resolution with a stale pref.
  const start = app.indexOf("function activateTab(");
  const end = app.indexOf("\nfunction activateSimBook(");
  const fnSrc = app.slice(start, end > start ? end : start + 2500);

  const panels = ["panel-tw", "panel-us", "panel-idx", "panel-pos", "panel-report"];
  function run(saved) {
    const state = { activated: null, stored: {} };
    const nodes = panels.map((id) => ({ id, classList: { toggle: (c, on) => { if (on) state.activated = id; } } }));
    const tabs = ["tw", "us", "idx", "pos", "report"].map((t) => ({
      dataset: { tab: t }, classList: { toggle: () => {} },
    }));
    const ctx = {
      console,
      document: {
        querySelectorAll: (sel) => (sel === ".market-tab" ? tabs : sel === ".tab-panel" ? nodes : []),
        getElementById: () => null,
      },
      lsGet: (k, d) => (k === "abraham.activeTab" ? saved : d),
      lsSet: (k, v) => { state.stored[k] = v; },
      applySort: () => {}, renderSummary: () => {}, ensureReportLoaded: () => {},
      CURRENT_SNAPSHOT: null, ACTIVE_MARKET_TAB: "tw", CHART_INSTANCES: new Map(),
    };
    vm.createContext(ctx);
    vm.runInContext(fnSrc + "\nactivateTab(" + JSON.stringify(saved) + ", false);", ctx);
    return state;
  }

  const a = run("sim");
  check('saved pref "sim" falls back to 台股, not blank', a.activated === "panel-tw", String(a.activated));
  check('saved pref "sim" rewrites the stored pref', a.stored["abraham.activeTab"] === "tw",
        String(a.stored["abraham.activeTab"]));

  const b = run("sim-tw-2");
  check('legacy pref "sim-tw-2" also falls back to 台股', b.activated === "panel-tw", String(b.activated));

  const c = run("report");
  check("日報 pref still activates 日報", c.activated === "panel-report", String(c.activated));

  const d = run("us");
  check("normal pref unaffected", d.activated === "panel-us", String(d.activated));
}

console.log("");
if (failures) { console.log("FAILED " + failures); process.exit(1); }
console.log("all sim-removal tests passed");
