// Turns the stand-alone dashboard HTML (with its data embedded) into public/index.html for this server.
//   node build-page.js "C:\Users\NIRAJ\Downloads\Job_Checklist_Dashboard_22_8.html"
// What it changes:
//   1. Removes the embedded task data (const SNAP = {...}); the page loads it from the server instead.
//   2. Adds a small adapter that gives the page the same shared-store calls it used as a Claude artifact
//      (window.claude.use('db' | 'user')), backed by this server and saved into the Drive workbook.
//   3. Removes the page's own start-up (init + startShared); page/live.js starts it after sign-in.
//   4. Adds page/live.css and page/live.js: sign-in bar, maker requests, checker approvals, the Access tab,
//      sorting / filtering on every table, and the print layout.
// Everything else in the page is left as it is.
const fs = require("fs");
const path = require("path");

const src = process.argv[2];
if (!src) { console.error("Usage: node build-page.js <dashboard.html>"); process.exit(1); }
let html = fs.readFileSync(src, "utf8");
const part = f => fs.readFileSync(path.join(__dirname, "page", f), "utf8").trimEnd();

const must = (cond, what) => { if (!cond) { console.error("Could not find " + what + " in the page. Has its code changed?"); process.exit(1); } };

// 1. embedded data
const snapRe = /^const SNAP = \{.*\};$/m;
must(snapRe.test(html), "the embedded data line (const SNAP = {...};)");
html = html.replace(snapRe, () => "let SNAP = null; // loaded from the server (api/source) by live.js");

// 3. start-up
const bootOld = "  init(SNAP);\n  startShared();\n})();";
must(html.includes(bootOld), "the start-up block (init(SNAP); startShared();)");
html = html.replace(bootOld, () => "  // start-up moved to live.js (after sign-in, with only the tasks this person may see)\n})();");

// 2. adapter, placed just before the page's own script
const mainScript = '<script>\n"use strict";\n/* ---------------- configuration ---------------- */';
must(html.includes(mainScript), "the start of the page's main script");
html = html.replace(mainScript, () => "<script>\n" + part("adapter.js") + "\n</script>\n" + mainScript);

// 4. live layer
must(html.includes("</style>"), "the page's stylesheet");
html = html.replace("</style>", () => part("live.css") + "\n</style>");
const end = html.lastIndexOf("</body>");
must(end > 0, "</body>");
html = html.slice(0, end) + "<script>\n" + part("live.js") + "\n</script>\n" + html.slice(end);

const out = path.join(__dirname, "public", "index.html");
fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} KB, was ${(fs.statSync(src).size / 1024).toFixed(0)} KB)`);
