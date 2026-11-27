// Loads a new checklist into the workbook's Master sheet from a stand-alone dashboard HTML (its embedded data).
//
//   node load-master.js "C:\Users\NIRAJ\Downloads\Job_Checklist_Dashboard_26.html"           (dry run: shows what would change)
//   node load-master.js "C:\Users\NIRAJ\Downloads\Job_Checklist_Dashboard_26.html" --write   (writes Master, Doers, Settings in Drive)
//   node load-master.js --check "…dashboard.html"   (compares the HTML's data with the current Master, row by row)
//
// Only Master, Doers and the AsOf / Source settings are replaced. State (users, requests, approved changes),
// Change Log, Requests and other sheets are kept. The live server notices the new version within a minute.
require("./env.js");
const fs = require("fs");
const XLSX = require("./lib/xlsx.js");
const g = require("./google.js");

const FILE_ID = process.env.CHECKLIST_FILE_ID || "1bmgjKdSf6zITxFC6A6omZLQ6pdMi0oma";
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const {HDR, blank, masterRows, snapFromHtml, doersOf} = require("./master-format.js");
const snapOf = f => snapFromHtml(fs.readFileSync(f, "utf8"));

const norm = v => blank(v) ? "" : String(v).replace(/\s+/g, " ").trim();
function compare(a, b) {
  const diffs = [];
  const n = Math.max(a.length, b.length);
  for (let i = 1; i < n; i++) {
    const x = (a[i] || []).map(norm).join(" | "), y = (b[i] || []).map(norm).join(" | ");
    if (x !== y) diffs.push([i + 1, x.slice(0, 160), y.slice(0, 160)]);
  }
  return diffs;
}

(async () => {
  const args = process.argv.slice(2);
  const check = args.includes("--check"), write = args.includes("--write");
  const htmlFile = args.find(a => !a.startsWith("--"));
  if (!htmlFile) { console.error('Usage: node load-master.js "dashboard.html" [--write | --check]'); process.exit(1); }
  const snap = snapOf(htmlFile);
  const rows = masterRows(snap), doers = doersOf(snap);
  const buf = await g.download(FILE_ID);
  const wb = XLSX.read(buf, {type: "buffer", cellNF: true, cellStyles: true});
  const cur = XLSX.utils.sheet_to_json(wb.Sheets.Master, {header: 1, raw: true, defval: null, blankrows: false});
  const count = R => { const c = {}; R.slice(1).forEach(r => { c[r[1]] = (c[r[1]] || 0) + 1; }); return JSON.stringify(c); };
  console.log("HTML data:   as of", snap.asof, "·", rows.length - 1, "tasks", count(rows), "·", doers.length, "doers");
  console.log("Master now:  ", cur.length - 1, "tasks", count(cur));
  const d = compare(cur, rows);
  console.log(d.length ? d.length + " row(s) differ" : "Identical to the current Master");
  d.slice(0, check ? 15 : 5).forEach(([r, x, y]) => console.log("  row " + r + "\n    now: " + x + "\n    new: " + y));
  if (check || !write) { if (!write) console.log("\nDry run. Add --write to replace Master, Doers and Settings in Drive."); return; }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = HDR.map(h => ({wch: h === "Task Description" ? 60 : h === "Task Alias" ? 30 : h === "Company" ? 28 : Math.max(8, h.length + 2)}));
  wb.Sheets.Master = ws;
  const dws = XLSX.utils.aoa_to_sheet([["Doer"]].concat(doers.map(x => [x])));
  dws["!cols"] = [{wch: 28}];
  wb.Sheets.Doers = dws;
  const set = XLSX.utils.sheet_to_json(wb.Sheets.Settings, {header: 1, raw: false, defval: "", blankrows: false});
  const put = (k, v) => { const r = set.find(x => String(x[0]).trim().toLowerCase() === k.toLowerCase()); if (r) r[1] = v; else set.push([k, v, ""]); };
  put("AsOf", snap.asof || ""); put("Source", snap.source || "");
  wb.Sheets.Settings = XLSX.utils.aoa_to_sheet(set);
  const out = XLSX.write(wb, {type: "buffer", bookType: "xlsx", cellStyles: true, compression: true, bookSST: true});
  const r = await g.upload(FILE_ID, out, MIME);
  console.log("Written to Drive:", r.modifiedTime || "ok");
})().catch(e => { console.error(e.message); process.exit(1); });
