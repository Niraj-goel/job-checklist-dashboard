// Which tasks each person may see, worked out on the server so a person's browser never receives other
// people's tasks.
//
// Task ids follow the page's own numbering: the page rebuilds the Master sheet into four frequency lists
// (two header rows each), and a task's id is its frequency letter plus its row number in that list
// ("M-0012"). The same numbering is done here, and a person's rows are sent with their row numbers so the
// ids match the checker's (approvals and the shared change records refer to tasks by id).
//
// A task belongs to whoever is its doer after the approved changes (transfers, edits, additions).

const key = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
const blank = v => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || v === 0;
function freqOf(v) {
  const k = key(v);
  if (!k) return "";
  if (["d", "daily"].includes(k)) return "D";
  if (["w", "weekly"].includes(k)) return "W";
  if (["m", "monthly"].includes(k)) return "M";
  if (["y", "yearly", "annual", "annually"].includes(k)) return "Y";
  return "?";
}
const idOf = (fk, n) => fk + "-" + String(n).padStart(4, "0");

// source: from store.source(). Returns {hdrAt, rows:[{i, id, fk, n, doer, rep}], lens:{D,W,M,Y}}.
function indexSource(source) {
  const A = source.master || [];
  const h = A.findIndex(r => key((r || [])[0]) === "action");
  const hdr = (A[h] || []).map(key);
  const di = hdr.indexOf("doer"), ri = hdr.indexOf("reporting to"), fi = hdr.indexOf("frequency");
  const lens = {D: 2, W: 2, M: 2, Y: 2}, rows = [];
  for (let i = h + 1; i < A.length; i++) {
    const r = A[i] || [];
    if (r.every(blank)) continue;
    const fk = freqOf(fi < 0 ? null : r[fi]);
    if (!lens[fk]) continue;
    const n = ++lens[fk];
    rows.push({i, id: idOf(fk, n), fk, n, doer: key(r[di]), rep: key(r[ri])});
  }
  return {h, rows, lens};
}

// Current doer / reviewer of every task, after the approved shared changes (st/* documents).
function effective(idx, stDocs) {
  const eff = new Map(idx.rows.map(r => [r.id, {doer: r.doer, rep: r.rep}]));
  for (const d of stDocs) for (const it of (d.data && d.data.items) || []) {
    if (!it) continue;
    if (it.k === "ov" && it.s && eff.has(it.id)) eff.set(it.id, {doer: key(it.s.doer), rep: key(it.s.rep)});
    else if (it.k === "add" && it.t && it.t.id) eff.set(it.t.id, {doer: key(it.t.doer), rep: key(it.t.rep)});
  }
  return eff;
}

// The person's own tasks, or own + their reports' tasks (team), or everything (all = null).
function visibleIds(user, eff) {
  if (user.scope === "all") return null;
  const me = key(user.name), out = new Set();
  for (const [id, e] of eff) if (e.doer === me || (user.scope === "team" && e.rep === me)) out.add(id);
  return out;
}

function sourceFor(source, idx, vis) {
  const A = source.master || [];
  const head = A.slice(0, idx.h + 1);
  const rows = idx.rows.filter(r => !vis || vis.has(r.id)).map(r => ({n: r.n, fk: r.fk, r: A[r.i]}));
  return {head, rows, lens: idx.lens};
}

function filterSt(docs, vis) {
  if (!vis) return docs;
  return docs.map(d => ({id: d.id, data: {...d.data, items: ((d.data && d.data.items) || []).filter(it =>
    it && (it.k === "add" ? it.t && vis.has(it.t.id) : vis.has(it.id)))}}));
}

function logVisible(l, user, vis) {
  if (!vis) return true;
  const me = key(user.name);
  if (vis.has(l.id)) return true;
  if (key(l.from) === me || key(l.to) === me) return true;
  if (user.scope === "team" && (key(l.fromRep) === me || key(l.toRep) === me)) return true;
  return false;
}
function filterLg(docs, user, vis) {
  if (!vis) return docs;
  return docs.map(d => ({id: d.id, data: {...d.data, items: ((d.data && d.data.items) || []).filter(l => l && logVisible(l, user, vis))}}));
}

// Each doer's usual department and reviewer (no tasks), so a maker's transfer / add form can fill them in.
function profiles(source) {
  const A = source.master || [];
  const h = A.findIndex(r => key((r || [])[0]) === "action");
  const hdr = (A[h] || []).map(key);
  const di = hdr.indexOf("doer"), de = hdr.indexOf("department"), ri = hdr.indexOf("reporting to");
  const cnt = new Map();
  for (let i = h + 1; i < A.length; i++) {
    const r = A[i] || [], d = String(r[di] == null ? "" : r[di]).replace(/\s+/g, " ").trim();
    if (!d) continue;
    const k = key(d);
    if (!cnt.has(k)) cnt.set(k, {name: d, dept: new Map(), rep: new Map()});
    const c = cnt.get(k), dv = String(r[de] == null ? "" : r[de]).trim(), rv = String(r[ri] == null ? "" : r[ri]).replace(/\s+/g, " ").trim();
    if (dv) c.dept.set(dv, (c.dept.get(dv) || 0) + 1);
    if (rv) c.rep.set(rv, (c.rep.get(rv) || 0) + 1);
  }
  const top = m => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  return [...cnt.values()].map(c => ({name: c.name, dept: top(c.dept), rep: top(c.rep)}));
}

module.exports = {key, indexSource, effective, visibleIds, sourceFor, filterSt, filterLg, logVisible, profiles};
