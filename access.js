// Users, their access matrix and sign-in sessions for the Job Checklist dashboard.
//
// Sign-in ID = email address. Each person has one row in the access matrix: tab ticks, request ticks
// (what they may ask to change), the approve tick (checker), the download tick, and a data scope:
//   own  – only tasks where they are the doer
//   team – their own tasks plus tasks of people who report to them
//   all  – every task
// Admins get everything plus the Access tab.
//
// Users are kept in the checklist workbook itself (State sheet, document "acl/users"), so they survive
// restarts and redeploys. Passwords are stored only as scrypt hashes.
// ADMIN_EMAIL + ADMIN_PASSWORD (server environment) is a break-glass admin sign-in that is never stored.
const crypto = require("crypto");

const PERMS = [
  {key: "tab.ov", group: "Tabs", label: "Overview"},
  {key: "tab.wl", group: "Tabs", label: "Doer Workload"},
  {key: "tab.due", group: "Tabs", label: "Due Schedule"},
  {key: "tab.rep", group: "Tabs", label: "Management Report"},
  {key: "tab.tm", group: "Tabs", label: "Task Master"},
  {key: "tab.log", group: "Tabs", label: "Change Log"},
  {key: "tab.dq", group: "Tabs", label: "Data Quality"},
  {key: "act.transfer", group: "Requests (maker)", label: "Transfer"},
  {key: "act.add", group: "Requests (maker)", label: "Add"},
  {key: "act.edit", group: "Requests (maker)", label: "Edit"},
  {key: "act.delete", group: "Requests (maker)", label: "Delete"},
  {key: "act.import", group: "Requests (maker)", label: "Excel import"},
  {key: "act.approve", group: "Checker", label: "Approve / reject", note: "Needs data scope All"},
  {key: "dl.excel", group: "Downloads", label: "Excel downloads"},
];
const PERM_KEYS = new Set(PERMS.map(p => p.key));
const SCOPES = ["own", "team", "all"];
const NEW_USER = {scope: "own", perms: {"tab.ov": true, "tab.wl": true, "tab.due": true, "tab.rep": true, "tab.tm": true, "tab.log": true,
  "act.transfer": true, "act.add": true, "act.edit": true, "act.delete": true, "dl.excel": true}};
const DOC = "acl/users";
const SESSION_HOURS = +process.env.SESSION_HOURS || 12;
const ADMIN = {email: String(process.env.ADMIN_EMAIL || "").trim().toLowerCase(), password: process.env.ADMIN_PASSWORD || "",
  name: String(process.env.ADMIN_NAME || "Administrator").trim()};

const norm = s => String(s || "").trim().toLowerCase();
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString("hex");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cleanPerms = p => Object.fromEntries(Object.entries(p || {}).filter(([k, v]) => PERM_KEYS.has(k) && v === true));
const bad = (msg, status = 400) => Object.assign(new Error(msg), {status});
// Temporary passwords: no look-alike characters, easy to read out or type from a message.
function tempPassword() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.randomBytes(10);
  return Array.from(b, x => A[x % A.length]).join("").replace(/^(.{5})/, "$1-");
}

function createAccess(store) {
  let cache = null;
  async function state() {
    if (cache) return cache;
    const d = await store.getDoc(DOC);
    cache = {secret: (d && d.secret) || crypto.randomBytes(32).toString("hex"), users: Array.isArray(d && d.users) ? d.users : []};
    if (!d || !d.secret) await persist();
    return cache;
  }
  async function persist() { await store.setDoc(DOC, JSON.parse(JSON.stringify(cache))); }
  const secret = () => process.env.SESSION_SECRET || cache.secret;

  function withStamp(u) { return {...u, stamp: u.hash || ""}; }
  function breakGlass() {
    return {email: ADMIN.email, name: ADMIN.name, admin: true, active: true, scope: "all", perms: {}, breakGlass: true,
      stamp: crypto.createHash("sha256").update(ADMIN.password).digest("hex")};
  }
  async function find(email) {
    const s = await state(), e = norm(email);
    const u = s.users.find(x => norm(x.email) === e);
    return u ? withStamp(u) : null;
  }

  // Exactly what is ticked for this person (admins: everything).
  function view(u) {
    const perms = {};
    for (const p of PERMS) perms[p.key] = !!u.admin || !!(u.perms && u.perms[p.key]);
    const scope = u.admin ? "all" : (SCOPES.includes(u.scope) ? u.scope : "own");
    if (scope !== "all") perms["act.approve"] = false;   // a checker writes the shared checklist, so needs to see all of it
    return {email: u.email, name: u.name || u.email, admin: !!u.admin, scope, perms, mustChange: !!u.mustChange,
      breakGlass: !!u.breakGlass, writer: !!u.admin || perms["act.approve"]};
  }

  async function verify(email, pw) {
    const e = norm(email);
    if (ADMIN.email && ADMIN.password && e === ADMIN.email && same(pw, ADMIN.password)) return breakGlass();
    const u = await find(e);
    if (!u || u.active === false || u.removed || !u.hash) { hashPw(pw, "x"); return null; }   // same work either way
    return same(hashPw(pw, u.salt), u.hash) ? u : null;
  }

  // Session cookie: email|expiry|signature. The signature covers the password hash, so a password change
  // or reset ends that person's other sessions.
  const b64 = s => Buffer.from(s).toString("base64url");
  function issue(u) {
    const body = `${b64(u.email)}|${Date.now() + SESSION_HOURS * 3600e3}`;
    return `${body}|${crypto.createHmac("sha256", secret()).update(body + "|" + u.stamp).digest("base64url")}`;
  }
  async function check(token) {
    await state();
    const [em, exp, sig] = String(token || "").split("|");
    if (!sig || !(+exp > Date.now())) return null;
    const email = Buffer.from(em, "base64url").toString();
    let u = null;
    if (ADMIN.email && ADMIN.password && norm(email) === ADMIN.email) u = breakGlass();
    const stored = await find(email);
    const cands = [u, stored].filter(Boolean);
    for (const c of cands) {
      if (c.active === false || c.removed) continue;
      const want = crypto.createHmac("sha256", secret()).update(`${em}|${exp}|${c.stamp}`).digest("base64url");
      if (same(sig, want)) return c;
    }
    return null;
  }

  // Failed sign-ins: 5 within 15 minutes locks that email (and that address) for 15 minutes.
  const fails = new Map();
  const throttled = keys => keys.some(k => { const f = fails.get(k); return f && f.n >= 5 && Date.now() - f.at < 15 * 60e3; });
  const failed = keys => keys.forEach(k => { const f = fails.get(k), now = Date.now(); fails.set(k, f && now - f.at < 15 * 60e3 ? {n: f.n + 1, at: now} : {n: 1, at: now}); });
  const cleared = keys => keys.forEach(k => fails.delete(k));

  // ---- admin ----
  const publicUser = u => ({email: u.email, name: u.name || "", admin: !!u.admin, active: u.active !== false,
    scope: SCOPES.includes(u.scope) ? u.scope : "own", perms: u.perms || {}, mustChange: !!u.mustChange,
    hasPassword: !!u.hash, lastLogin: u.lastLogin || "", updated: u.updated || "", created: u.created || "", removed: u.removed || ""});
  async function adminView() {
    const s = await state();
    return {perms: PERMS, scopes: SCOPES, newUser: NEW_USER, users: s.users.map(publicUser),
      breakGlass: ADMIN.email ? ADMIN.email : null};
  }

  function applyRow(u, b, actor) {
    const self = norm(u.email) === norm(actor.email);
    if (self && (b.admin === false || b.active === false)) throw bad("You can't remove your own admin access or deactivate yourself");
    u.name = String(b.name ?? u.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!u.name) throw bad(`${u.email}: name is required (it must match the doer name in the checklist)`);
    u.admin = b.admin === true;
    u.active = b.active !== false;
    u.scope = SCOPES.includes(b.scope) ? b.scope : "own";
    u.perms = cleanPerms(b.perms);
    u.updated = new Date().toISOString();
  }
  function setTemp(u) {
    const pw = tempPassword();
    u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPw(pw, u.salt); u.mustChange = true;
    return pw;
  }

  async function addUser(b, actor) {
    const s = await state();
    const email = norm(b.email);
    if (!isEmail(email)) throw bad("Enter a valid email address as the sign-in ID");
    const ex = s.users.find(x => norm(x.email) === email);
    if (ex) throw bad(ex.removed ? `${email} was removed earlier – use Restore on that row` : `${email} already exists`);
    const u = {email, created: new Date().toISOString()};
    applyRow(u, {...NEW_USER, ...b}, actor);
    const pw = setTemp(u);
    s.users.push(u); await persist();
    return {email, password: pw};
  }

  // What changed in one person's row, in words (for the audit log).
  function describe(a, b) {
    const out = [];
    if (a.email !== b.email) out.push(`email ${a.email} → ${b.email}`);
    if ((a.name || "") !== (b.name || "")) out.push(`name "${a.name || ""}" → "${b.name}"`);
    if ((a.active !== false) !== (b.active !== false)) out.push(b.active !== false ? "activated" : "deactivated");
    if (!!a.admin !== !!b.admin) out.push(b.admin ? "made admin" : "admin removed");
    if ((a.scope || "own") !== (b.scope || "own")) out.push(`scope ${a.scope || "own"} → ${b.scope}`);
    const label = k => (PERMS.find(p => p.key === k) || {label: k}).label;
    const pa = a.perms || {}, pb = b.perms || {};
    const on = PERMS.filter(p => pb[p.key] && !pa[p.key]).map(p => label(p.key)), off = PERMS.filter(p => pa[p.key] && !pb[p.key]).map(p => label(p.key));
    if (on.length) out.push("ticked: " + on.join(", "));
    if (off.length) out.push("unticked: " + off.join(", "));
    return out.join("; ");
  }

  async function saveUsers(rows, actor) {
    const s = await state();
    if (!Array.isArray(rows)) throw bad("No users sent");
    const next = s.users.map(u => ({...u}));
    const before = new Map(s.users.map(u => [u, JSON.parse(JSON.stringify(u))]));
    for (const b of rows) {
      const u = next.find(x => norm(x.email) === norm(b.email));
      if (!u) throw bad(`No such user: ${b.email}`);
      if (b.newEmail && norm(b.newEmail) !== norm(u.email)) {
        const ne = norm(b.newEmail);
        if (!isEmail(ne)) throw bad(`${b.newEmail} is not a valid email address`);
        if (next.some(x => x !== u && norm(x.email) === ne)) throw bad(`${ne} is already used by another user`);
        if (norm(u.email) === norm(actor.email)) throw bad("Change your own sign-in email from another admin account");
        u.email = ne;
      }
      applyRow(u, b, actor);
    }
    if (!next.some(u => u.admin && u.active !== false && !u.removed) && !ADMIN.email) throw bad("Keep at least one active admin");
    const changes = [];
    s.users.forEach((u, i) => { const d = describe(before.get(u), next[i]); if (d) changes.push({email: next[i].email, name: next[i].name, change: d}); });
    s.users = next; await persist();
    return changes;
  }

  async function resetPassword(email, actor) {
    const s = await state();
    const u = s.users.find(x => norm(x.email) === norm(email));
    if (!u) throw bad("No such user");
    if (u.removed) throw bad("Restore this person first");
    const pw = setTemp(u); u.updated = new Date().toISOString();
    await persist();
    return {email: u.email, password: pw};
  }

  // People are never deleted: "remove" switches them off and marks the date, and Restore brings them back.
  async function deleteUser(email, actor) {
    const s = await state();
    if (norm(email) === norm(actor.email)) throw bad("You can't remove yourself");
    const u = s.users.find(x => norm(x.email) === norm(email));
    if (!u) throw bad("No such user");
    u.removed = new Date().toISOString(); u.active = false; u.updated = u.removed;
    await persist();
    return {email: u.email, name: u.name};
  }
  async function restoreUser(email, actor) {
    const s = await state();
    const u = s.users.find(x => norm(x.email) === norm(email));
    if (!u) throw bad("No such user");
    delete u.removed; u.active = true; u.updated = new Date().toISOString();
    await persist();
    return {email: u.email, name: u.name};
  }

  async function changeOwnPassword(actor, current, next) {
    if (actor.breakGlass) throw bad("The break-glass admin password is set in the server settings (ADMIN_PASSWORD)");
    if (!(await verify(actor.email, current))) throw bad("Current password is wrong");
    const n = String(next || "");
    if (n.length < 8) throw bad("New password must be at least 8 characters");
    if (n === current) throw bad("Choose a password different from the current one");
    const s = await state();
    const u = s.users.find(x => norm(x.email) === norm(actor.email));
    u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPw(n, u.salt); u.mustChange = false; u.updated = new Date().toISOString();
    await persist();
    return withStamp(u);
  }

  async function touchLogin(u) {
    if (u.breakGlass) return;
    const s = await state();
    const x = s.users.find(v => norm(v.email) === norm(u.email));
    if (x) { x.lastLogin = new Date().toISOString(); await persist(); }
  }

  // Used by the one-time seeding script: adds people who are not there yet, never changes existing ones.
  async function seed(list) {
    const s = await state(), out = [];
    for (const b of list) {
      const email = norm(b.email);
      if (!isEmail(email) || s.users.some(x => norm(x.email) === email)) continue;
      const u = {email, created: new Date().toISOString()};
      applyRow(u, {...NEW_USER, ...b}, {email: ""});
      out.push({name: u.name, email, password: setTemp(u), admin: u.admin, scope: u.scope});
      s.users.push(u);
    }
    if (out.length) await persist();
    return out;
  }

  async function anyUsers() { return (await state()).users.some(u => u.active !== false && !u.removed) || !!(ADMIN.email && ADMIN.password); }

  return {PERMS, verify, view, issue, check, throttled, failed, cleared, adminView, addUser, saveUsers, resetPassword,
    deleteUser, restoreUser, changeOwnPassword, touchLogin, seed, anyUsers, isEmail};
}

module.exports = {createAccess, PERMS, SCOPES, SESSION_HOURS};
