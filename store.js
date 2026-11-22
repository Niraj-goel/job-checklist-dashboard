// The checklist workbook (Job Checklist DB.xlsx in Google Drive) is the database.
//   Master     – one row per live task (same columns as the dashboard's "Export master" / import template)
//   Doers      – list of doers (column A)
//   Settings   – Key / Value: AsOf, Source
//   State      – shared changes made on the dashboard, as JSON. Written by this server only; do not edit.
//   Change Log – the same changes as readable rows. Rewritten on every save.
// Any other sheet (e.g. Archive) is kept as it is.
//
// The server holds the shared changes in memory, answers the page from memory, and writes them back to the
// workbook a couple of seconds after the last change. If someone edits the workbook in Drive meanwhile, the
// newest copy is downloaded first and only State and Change Log are replaced, so their edit is kept.
const fs = require("fs");
const crypto = require("crypto");
const XLSX = require("./lib/xlsx.js");
const g = require("./google.js");

const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CELL = 30000;            // Excel allows 32,767 characters per cell
const SAVE_DELAY = 2000;       // ms after the last change before writing to Drive
const CHECK_EVERY = 30000;     // ms between checks for edits made directly in Drive
const LOG_COLS = [
  ["Ref", "batch"], ["Logged at", "ts"], ["Action", "action"], ["Frequency", "freq"], ["Task", "task"], ["Company", "company"],
  ["Cost Centre", "cc"], ["From", "from"], ["From Dept", "fromDept"], ["From Reporting To", "fromRep"], ["To", "to"],
  ["To Dept", "toDept"], ["To Reporting To", "toRep"], ["Effective", "eff"], ["Reason", "why"], ["Remarks", "note"],
  ["Maker", "maker"], ["Checker", "checker"], ["Source", "source"], ["Undone", "undone"], ["Task Id", "id"],
];
const FREQ_NAME = {D: "Daily", W: "Weekly", M: "Monthly", Y: "Yearly"};

function backendFor({fileId, localFile}) {
  if (localFile) return {   // for testing without Drive
    name: localFile,
    meta: async () => ({name: localFile, modifiedTime: fs.statSync(localFile).mtime.toISOString(), capabilities: {canEdit: true}}),
    download: async () => fs.readFileSync(localFile),
    upload: async bytes => { fs.writeFileSync(localFile, bytes); return {modifiedTime: fs.statSync(localFile).mtime.toISOString()}; },
  };
  return {name: fileId, meta: () => g.meta(fileId), download: () => g.download(fileId), upload: bytes => g.upload(fileId, bytes, MIME)};
}

const blank = v => v === null || v === undefined || String(v).trim() === "";
const rows = (wb, name, raw = true) => wb.Sheets[name]
  ? XLSX.utils.sheet_to_json(wb.Sheets[name], {header: 1, raw, defval: null, blankrows: false}) : null;

function readSource(wb, fileName) {
  const masterName = wb.SheetNames.find(n => n.trim().toLowerCase() === "master") || wb.SheetNames[0];
  const master = rows(wb, masterName) || [];
  if (!master.some(r => String((r || [])[0] || "").trim().toLowerCase() === "action"))
    throw new Error(`Sheet "${masterName}" has no header row starting with "Action"`);
  const doers = (rows(wb, "Doers") || []).map(r => r[0]).filter(v => !blank(v)).map(v => String(v).trim())
    .filter(v => !/^doers?$/i.test(v));
  const settings = {};
  (rows(wb, "Settings", false) || []).forEach(r => { if (!blank(r[0])) settings[String(r[0]).trim().toLowerCase()] = blank(r[1]) ? "" : String(r[1]).trim(); });
  const asof = settings.asof || "", source = settings.source || fileName || "Job Checklist DB.xlsx";
  const ver = crypto.createHash("sha1").update(JSON.stringify([master, doers, asof, source])).digest("hex").slice(0, 10);
  return {master, doers, asof, source, ver, sheet: masterName};
}

function readState(wb) {
  const r = rows(wb, "State") || [];
  const i = r.findIndex(x => /^json/i.test(String((x || [])[0] || "")));
  if (i < 0) return {};
  const text = r.slice(i + 1).map(x => (x && x[0] != null) ? String(x[0]) : "").join("");
  if (!text.trim()) return {};
  try { const j = JSON.parse(text); return (j && j.docs) || {}; }
  catch (e) { throw new Error(`The State sheet's JSON could not be read (${e.message}). Restore an earlier version of the workbook in Drive.`); }
}

function logRows(docs) {
  const items = Object.keys(docs).filter(p => p.startsWith("lg/")).sort()
    .flatMap(p => (docs[p] && docs[p].items) || []);
  return [LOG_COLS.map(c => c[0])].concat(items.map(l => LOG_COLS.map(([, k]) => {
    const v = l[k];
    if (k === "freq") return FREQ_NAME[v] || v || "";
    if (k === "undone") return v ? "Yes" : "";
    return v == null ? "" : String(v);
  })));
}

function stateRows(docs, info) {
  const text = JSON.stringify({docs});
  const out = [["rev", info.rev || ""], ["sig", info.sig || ""], ["savedAt", new Date().toISOString()],
    ["JSON (do not edit) ↓", "Written by the dashboard server. Editing it can lose the team's changes."]];
  for (let i = 0; i < text.length; i += CELL) out.push([text.slice(i, i + CELL)]);
  return out;
}

function setSheet(wb, name, aoa, widths) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (widths) ws["!cols"] = widths.map(w => ({wch: w}));
  if (!wb.Sheets[name]) wb.SheetNames.push(name);
  wb.Sheets[name] = ws;
}

function createStore(opts) {
  const backend = backendFor(opts);
  let book = null;            // {buf, modifiedTime, canEdit, name}
  let source = null;
  let docs = {};
  let loading = null, lastCheck = 0;
  let seq = 0, savedSeq = 0, saving = false, timer = null, saveError = null, savedAt = null;

  async function fetchBook() {
    const m = await backend.meta();
    const buf = await backend.download();
    const wb = XLSX.read(buf, {type: "buffer", cellNF: true, cellStyles: true});
    return {m, buf, wb};
  }

  function ensureLoaded() {
    if (book) return Promise.resolve();
    if (!loading) loading = (async () => {
      const {m, buf, wb} = await fetchBook();
      source = readSource(wb, m.name);
      docs = readState(wb);
      book = {buf, modifiedTime: m.modifiedTime, canEdit: !(m.capabilities && m.capabilities.canEdit === false), name: m.name};
      lastCheck = Date.now();
    })().finally(() => { loading = null; });
    return loading;
  }

  // Picks up edits made directly to the workbook in Drive (new Master rows, AsOf date, …).
  async function checkFresh(force) {
    await ensureLoaded();
    if (saving || (!force && Date.now() - lastCheck < CHECK_EVERY)) return;
    lastCheck = Date.now();
    const m = await backend.meta();
    book.canEdit = !(m.capabilities && m.capabilities.canEdit === false);
    if (m.modifiedTime === book.modifiedTime && !force) return;
    const buf = await backend.download();
    const wb = XLSX.read(buf, {type: "buffer", cellNF: true, cellStyles: true});
    source = readSource(wb, m.name);
    book.buf = buf; book.modifiedTime = m.modifiedTime;
  }

  function schedule(delay = SAVE_DELAY) { clearTimeout(timer); timer = setTimeout(flush, delay); }

  async function flush() {
    if (saving) return schedule();
    if (seq === savedSeq) return;
    saving = true;
    const target = seq;
    try {
      const m = await backend.meta();
      let buf = book.buf;
      if (m.modifiedTime !== book.modifiedTime) buf = await backend.download();   // someone edited it in Drive: keep their edit
      const wb = XLSX.read(buf, {type: "buffer", cellNF: true, cellStyles: true});
      source = readSource(wb, m.name);
      setSheet(wb, "State", stateRows(docs, docs["meta/info"] || {}), [40, 60]);
      setSheet(wb, "Change Log", logRows(docs), LOG_COLS.map(([h]) => h === "Task" ? 60 : Math.max(12, h.length + 2)));
      const out = XLSX.write(wb, {type: "buffer", bookType: "xlsx", cellStyles: true, compression: true, bookSST: true});
      const r = await backend.upload(out);
      book.buf = out; book.modifiedTime = r.modifiedTime || book.modifiedTime;
      savedSeq = target; saveError = null; savedAt = new Date().toISOString();
    } catch (e) {
      saveError = e.status === 403 || e.status === 404
        ? `Could not save to Drive: share "${book && book.name}" with ${safeEmail()} as Editor (${e.message})`
        : `Could not save to Drive: ${e.message}`;
      console.error(saveError);
      schedule(15000);
    } finally {
      saving = false;
      if (seq !== savedSeq && !saveError) schedule();
    }
  }

  const safeEmail = () => { try { return g.clientEmail(); } catch { return "the service account"; } };

  return {
    ensureLoaded,
    async source(force) { await checkFresh(force); return source; },
    async status() {
      await checkFresh(false).catch(() => {});
      return {doc: docs["meta/info"] || null, ver: source && source.ver, canEdit: book ? book.canEdit : null,
        pending: seq !== savedSeq, saveError, savedAt};
    },
    async collection(name) {
      await ensureLoaded();
      return Object.keys(docs).filter(p => p.startsWith(name + "/")).sort().map(p => ({id: p.slice(name.length + 1), data: docs[p]}));
    },
    async set(path, body) { await ensureLoaded(); docs[path] = body; seq++; schedule(); },
    async remove(path) { await ensureLoaded(); if (path in docs) { delete docs[path]; seq++; schedule(); } },
    size: () => JSON.stringify(docs).length,
    async flushNow() { clearTimeout(timer); if (book && seq !== savedSeq) await flush(); },
  };
}

module.exports = {createStore, readSource, readState, logRows};
