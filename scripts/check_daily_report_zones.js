#!/usr/bin/env node
/* Pre-publish gate for docs/data/daily-report.json.
 *
 * The daily report is advice to Adam that gets published. It must clear the same
 * entry-zone validator every Discord message clears — otherwise a shift summary that
 * quotes a void entry zone would sail straight onto a public page with no gate at all.
 *
 * FAILS CLOSED. If the validator or the hunt list cannot be loaded, or the population
 * looks wrong, this exits non-zero and the builder refuses to publish. A check that
 * quietly skips is worse than no check, because it reads as a pass.
 *
 * Usage: node check_daily_report_zones.js <path-to-daily-report.json>
 * Exit:  0 = clear, 1 = blocked, 2 = could not check (treat as blocked)
 */
const fs = require("fs");
const path = require("path");

const HUNT = "C:/Users/Adam/Abraham/.hunt-list.json";
const LIB = "C:/Users/Adam/Abraham/hunt-zone-lib.js";
const MIN_POP = 50;                 // hunt list is ~72; anything near zero means a parse fell through
const CONTROLS = ["3363", "8299"];  // known-present tickers: if these go missing, the parse is broken

function die(code, msg) { console.error("[zone-gate] " + msg); process.exit(code); }

const target = process.argv[2];
if (!target) die(2, "usage: check_daily_report_zones.js <daily-report.json>");

let L, hunt, report;
try { L = require(LIB); } catch (e) { die(2, "cannot load validator: " + e.message); }
try { hunt = JSON.parse(fs.readFileSync(HUNT, "utf8")).entries; } catch (e) { die(2, "cannot load hunt list: " + e.message); }
try { report = JSON.parse(fs.readFileSync(path.resolve(target), "utf8")); } catch (e) { die(2, "cannot read report: " + e.message); }

// Population assertion + positive control. A parser that silently returns the wrong
// shape yields a small, tidy, entirely wrong universe — and then everything "passes".
if (!Array.isArray(hunt) || hunt.length < MIN_POP) die(2, "hunt population looks wrong: " + (hunt && hunt.length));
for (const c of CONTROLS) {
  if (!hunt.some((e) => String(e.ticker).replace(/\.[A-Z]+$/, "") === c)) {
    die(2, "positive control missing (" + c + ") — the list parse is broken, not the report");
  }
}

const chunks = [];
for (const day of report.days || []) {
  (day.top || []).forEach((t) => chunks.push(t));
  for (const s of day.shifts || []) {
    chunks.push(s.summary || "", s.error || "");
    for (const it of s.items || []) chunks.push(it.t || "", it.body || "", it.src || "");
  }
  for (const e of day.events || []) chunks.push(e.t || "", e.body || "", e.src || "");
}
// Join with a BLANK line, not a single newline. hunt-zone-lib decides "is this zone
// reference talking about this ticker?" by paragraph, and it splits paragraphs on "\n\n".
// With "\n" every chunk boundary was invisible, so two unrelated entries merged into one
// paragraph and a zone word from item A got attributed to a ticker named in item B.
// That produced a real false BLOCK on 2026-08-17 (台積電's 進場區 blamed on 聯亞).
// This makes attribution match the library's actual unit; it removes no check.
const text = chunks.filter(Boolean).join("\n\n");

let blocked = 0, touched = 0;
for (const e of hunt) {
  const em = L.entryMentionIndices(text, e);
  const zr = L.zoneRefIndices(text, e);
  if (!em.length && !zr.length) continue;
  touched++;
  const si = L.evalStaleness(e);
  const r = L.validateAnswer(e, si, text);
  const fails = r.issues.filter((i) => i.level === "FAIL");
  if (r.checks.actionAtStaleZone || fails.length) {
    blocked++;
    console.error("[zone-gate] BLOCK " + e.ticker + " :: " + fails.map((f) => f.msg).join(" | "));
  }
}

console.log("[zone-gate] population " + hunt.length + ", controls ok, "
  + text.length + " chars, " + touched + " ticker(s) touched, " + blocked + " blocked");
if (blocked) die(1, "refusing to publish: fix the wording, never the gate");
console.log("[zone-gate] clear");
