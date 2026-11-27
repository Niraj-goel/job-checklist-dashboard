// The Master sheet layout (the dashboard's "Export for import" columns) and conversions into it.
// Used by load-master.js, by checklist uploads from the dashboard, and for the "Current Tasks" sheet.
const V = require("./visibility.js");

const FREQ = {
  D: {name: "Daily", sheet: "Daily Task List", n: 1}, W: {name: "Weekly", sheet: "Weekly Task List", n: 6},
  M: {name: "Monthly", sheet: "Monthly Task List", n: 4}, Y: {name: "Yearly", sheet: "Yearly Task List", n: 12},
};
const HDR = ["Action", "Frequency", "Doer", "Department", "Reporting To", "Task Description", "Task Alias", "Company", "Cost Centre", "Daily Time",
  "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Monthly Due Day(s)", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
  "Reason", "Requested By (Maker)", "Approved By (Checker)", "Remarks"];
const blank = v => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || v === 0;
const s = v => blank(v) ? "" : v;
const dayNum = v => { const m = String(v == null ? "" : v).match(/(\d{1,2})/); return m ? +m[1] : null; };
// Daily time as the page shows it ("8:00 PM"); Excel time fractions become text, anything else stays as it is.
function timeText(v) {
  if (typeof v === "number" && v >= 0 && v < 1) { const m = Math.round(v * 1440); let h = Math.floor(m / 60); const mi = m % 60, ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return h + ":" + String(mi).padStart(2, "0") + " " + ap; }
  return blank(v) ? "" : String(v).trim();
}

// One Master row from a task's fields and its schedule (the page's sched array for that frequency).
function taskRow(fk, t, sched) {
  const row = HDR.map(() => "");
  row[1] = FREQ[fk].name; row[2] = s(t.doer); row[3] = s(t.dept); row[4] = s(t.rep); row[5] = s(t.task); row[6] = s(t.alias); row[7] = s(t.company); row[8] = s(t.cc);
  sched = sched || [];
  if (fk === "D") row[9] = timeText(sched[0]);
  if (fk === "W") for (let k = 0; k < 6; k++) row[10 + k] = blank(sched[k]) ? "" : "Y";
  if (fk === "M") row[16] = sched.map(dayNum).filter(Boolean).join(", ");
  if (fk === "Y") for (let k = 0; k < 12; k++) row[17 + k] = blank(sched[k]) ? "" : (dayNum(sched[k]) || s(sched[k]));
  return row;
}

// Master rows from the dashboard's frequency sheets (the embedded SNAP of a dashboard HTML, or a checklist workbook).
function masterRows(snap) {
  const out = [HDR];
  for (const fk of ["D", "W", "M", "Y"]) {
    const f = FREQ[fk], rows = snap[f.sheet] || [];
    for (let i = 2; i < rows.length; i++) {
      const r = rows[i] || [];
      if ([1, 2, 3, 4, 5, 6, 7].map(j => r[j]).every(blank)) continue;
      const sched = Array.from({length: f.n}, (_, k) => r[9 + k] === undefined ? null : r[9 + k]);
      out.push(taskRow(fk, {doer: r[1], dept: r[2], rep: r[3], task: r[4], alias: r[5], company: r[6], cc: r[7]}, sched));
    }
  }
  return out;
}

// The checklist as it stands now: Master with every approved change (transfers, edits, additions, deletions) applied.
const CUR_HDR = ["Task Id", "Status"].concat(HDR.slice(1, 29), ["Last Change Ref", "Added Ref", "Deleted Ref"]);
function currentTasks(source, stDocs) {
  const A = source.master || [];
  const idx = V.indexSource(source);
  const h = idx.h, hdr = (A[h] || []).map(V.key);
  const col = n => hdr.indexOf(V.key(n));
  const recs = [];
  for (const d of stDocs) for (const it of (d.data && d.data.items) || []) if (it) recs.push(it);
  const ov = new Map(), del = new Map(), adds = [];
  recs.forEach(r => { if (r.k === "ov") ov.set(r.id, r); else if (r.k === "del") del.set(r.id, r); else if (r.k === "add" && r.t) adds.push(r.t); });
  const out = [CUR_HDR];
  const masterCols = HDR.slice(1, 29).map(col);
  for (const r of idx.rows) {
    const src = A[r.i] || [];
    let row = masterCols.map(i => i < 0 ? "" : s(src[i]));
    const o = ov.get(r.id);
    let ref = "";
    if (o && o.s && String(src[col("Task Description")] ?? "") === String(o.txt ?? "")) {
      row = taskRow(r.fk, o.s, o.s.sched).slice(1, 29);
      ref = o.editRef || o.ref || "";
    }
    const d = del.get(r.id);
    out.push([r.id, d ? "Deleted" : (o ? "Changed" : "Live")].concat(row, [ref, "", d ? d.delRef || "" : ""]));
  }
  for (const t of adds) {
    const d = del.get(t.id);
    out.push([t.id, t.deleted || d ? "Deleted" : "Added"].concat(taskRow(t.freq, t, t.sched).slice(1, 29), [t.editRef || t.ref || "", t.addRef || "", (d && d.delRef) || t.delRef || ""]));
  }
  return out;
}

// The embedded data of a stand-alone dashboard HTML (the line "const SNAP = {...};").
function snapFromHtml(text) {
  const line = String(text).split(/\r?\n/).find(l => l.startsWith("const SNAP = {"));
  if (!line) throw new Error("This HTML has no embedded checklist data (const SNAP = {...}).");
  return JSON.parse(line.slice("const SNAP = ".length).replace(/;\s*$/, ""));
}
const doersOf = snap => (snap.doers || []).filter(v => !blank(v)).map(v => String(v).trim());

module.exports = {FREQ, HDR, CUR_HDR, blank, dayNum, timeText, taskRow, masterRows, currentTasks, snapFromHtml, doersOf};
