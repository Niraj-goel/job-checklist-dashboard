// Turns the stand-alone dashboard HTML (with its data embedded) into public/index.html for this server.
//   node build-page.js "C:\Users\NIRAJ\Downloads\Job_Checklist_Dashboard_22_1.html"
// What it changes:
//   1. Removes the embedded task data (const SNAP = {...}); the page loads it from /api/source instead.
//   2. Adds a small adapter that gives the page the same shared-store calls it used as a Claude artifact
//      (window.claude.use('db' | 'user')), backed by this server and saved into the Drive workbook.
//   3. Replaces the start-up code so it loads the live checklist first.
// Everything else in the page is left as it is.
const fs = require("fs");
const path = require("path");

const src = process.argv[2];
if (!src) { console.error("Usage: node build-page.js <dashboard.html>"); process.exit(1); }
let html = fs.readFileSync(src, "utf8");

const must = (cond, what) => { if (!cond) { console.error("Could not find " + what + " in the page. Has its code changed?"); process.exit(1); } };

// 1. embedded data
const snapRe = /^const SNAP = \{.*\};$/m;
must(snapRe.test(html), "the embedded data line (const SNAP = {...};)");
html = html.replace(snapRe, () => "let SNAP = null; // loaded from the server (/api/source)");

// 3. start-up
const bootOld = "  init(SNAP);\n  startShared();\n})();";
must(html.includes(bootOld), "the start-up block (init(SNAP); startShared();)");
html = html.replace(bootOld, () => fs.readFileSync(path.join(__dirname, "page", "boot.js"), "utf8").trimEnd() + "\n})();");

// 2. adapter, placed just before the page's own script
const mainScript = '<script>\n"use strict";\n/* ---------------- configuration ---------------- */';
must(html.includes(mainScript), "the start of the page's main script");
const adapter = fs.readFileSync(path.join(__dirname, "page", "adapter.js"), "utf8");
html = html.replace(mainScript, () => "<script>\n" + adapter.trimEnd() + "\n</script>\n" + mainScript);

const out = path.join(__dirname, "public", "index.html");
fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} KB, was ${(fs.statSync(src).size / 1024).toFixed(0)} KB)`);
