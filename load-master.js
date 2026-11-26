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
const FREQ = {
  D: {name: "Daily", sheet: "Daily Task List", n: 1}, W: {name: "Weekly", sheet: "Weekly Task List", n: 6},
  M: {name: "Monthly", sheet: "Monthly Task List", n: 4}, Y: {name: "Yearly", sheet: "Yearly Task List", n: 12},
};
const HDR = ["Action", "Frequency", "Doer", "Department", "Reporting To", "Task Description", "Task Alias", "Company", "Cost Centre", "Daily Time",
  "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Monthly Due Day(s)", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
  "Reason", "Requested By (Maker)", "Approved By (Checker)", "Remarks"];
const blank = v => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || v === 0;
const s = v => blank(v) ? "" : (typeof v === "string" ? v : v);
// Daily time as the page shows it ("8:00 PM"); Excel time fractions become text, anything else stays as it is.
function timeText(v) {
  if (typeof v === "number" && v >= 0 && v < 1) { const m = Math.round(v * 1440); let h = Math.floor(m / 60); const mi = m % 60, ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return h + ":" + String(mi).padStart(2, "0") + " " + ap; }
  return blank(v) ? "" : String(v).trim();
}
const dayNum = v => { const m = String(v == null ? "" : v).match(/(\d{1,2})/); return m ? +m[1] : null; };

function snapOf(htmlFile) {
  const line = fs.readFileSync(htmlFile, "utf8").split(/\r?\n/).find(l => l.startsWith("const SNAP = {"));
  if (!line) throw new Error("No embedded data (const SNAP = {...}) in " + htmlFile);
  return JSON.parse(line.slice("const SNAP = ".length).replace(/;\s*$/, ""));
}

// The page's own reading of the frequency sheets (parseSource), turned into Master rows.
function masterRows(snap) {
  const out = [HDR];
  for (const fk of ["D", "W", "M", "Y"]) {
    const f = FREQ[fk], rows = snap[f.sheet] || [];
    for (let i = 2; i < rows.length; i++) {
      const r = rows[i] || [];
      if ([1, 2, 3, 4, 5, 6, 7].map(j => r[j]).every(blank)) continue;
      const sched = Array.from({length: f.n}, (_, k) => r[9 + k] === undefined ? null : r[9 + k]);
      const row = HDR.map(() => "");
      row[1] = f.name; row[2] = s(r[1]); row[3] = s(r[2]); row[4] = s(r[3]); row[5] = s(r[4]); row[6] = s(r[5]); row[7] = s(r[6]); row[8] = s(r[7]);
      if (fk === "D") row[9] = timeText(sched[0]);
      if (fk === "W") sched.forEach((v, k) => { row[10 + k] = blank(v) ? "" : "Y"; });
      if (fk === "M") row[16] = sched.map(dayNum).filter(Boolean).join(", ");
      if (fk === "Y") sched.forEach((v, k) => { row[17 + k] = blank(v) ? "" : (dayNum(v) || s(v)); });
      out.push(row);
    }
  }
  return out;
}
const doersOf = snap => (snap.doers || []).filter(v => !blank(v)).map(v => String(v).trim());

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
