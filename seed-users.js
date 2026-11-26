// Adds people to the dashboard's access list (stored in the checklist workbook) in one go, each with a
// temporary password that they replace at first sign-in. People already on the list are left as they are.
//
//   node seed-users.js people.csv [passwords-out.csv]
//
// people.csv columns (header row required): name,email,admin,scope,active,perms
//   admin  – yes / no            scope – own / team / all (default own)
//   active – yes / no (default yes)
//   perms  – optional, space-separated keys (e.g. "tab.ov tab.tm act.transfer"); blank = the default ticks
// The temporary passwords are written to passwords-out.csv (default: temp-passwords.csv). Keep that file
// private and delete it once the passwords are shared. Neither file belongs in git.
require("./env.js");
const fs = require("fs");
const {createStore} = require("./store.js");
const {createAccess} = require("./access.js");

const [inFile, outFile = "temp-passwords.csv"] = process.argv.slice(2);
if (!inFile) { console.error("Usage: node seed-users.js people.csv [passwords-out.csv]"); process.exit(1); }

function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
const yes = v => /^(y|yes|true|1)$/i.test(String(v || "").trim());
const csvCell = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);

(async () => {
  const rows = parseCsv(fs.readFileSync(inFile, "utf8").replace(/^﻿/, ""));
  const hdr = rows.shift().map(h => h.trim().toLowerCase());
  const col = n => hdr.indexOf(n);
  const list = rows.map(r => {
    const g = n => col(n) < 0 ? "" : String(r[col(n)] || "").trim();
    const o = {name: g("name"), email: g("email"), admin: yes(g("admin")), scope: g("scope") || "own", active: g("active") ? yes(g("active")) : true};
    if (g("perms")) o.perms = Object.fromEntries(g("perms").split(/\s+/).filter(Boolean).map(k => [k, true]));
    return o;
  });
  const store = createStore({fileId: process.env.CHECKLIST_FILE_ID || "1bmgjKdSf6zITxFC6A6omZLQ6pdMi0oma", localFile: process.env.CHECKLIST_LOCAL_FILE || ""});
  await store.ensureLoaded();
  const access = createAccess(store);
  const added = await access.seed(list);
  await store.flushNow();
  if (added.length) fs.writeFileSync(outFile, "name,email,temporary password,admin,scope\n" + added.map(a => [a.name, a.email, a.password, a.admin ? "yes" : "no", a.scope].map(csvCell).join(",")).join("\n") + "\n");
  console.log(`${added.length} added, ${list.length - added.length} already there or invalid.` + (added.length ? ` Temporary passwords: ${outFile}` : ""));
})().catch(e => { console.error(e.message); process.exit(1); });
