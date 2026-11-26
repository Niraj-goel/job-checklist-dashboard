// Job Checklist Dashboard server.
// Serves the dashboard page and a small API. Task data comes from the checklist workbook in Google Drive,
// read with a service account whose key stays on this server.
//
// Sign-in is by email and password. Each person sees only the tasks their data scope allows (own / team / all);
// the filtering happens here, so a browser never receives other people's tasks. People with request ticks
// (makers) send change requests; only a checker (the Approve tick, with scope All) or an admin can change the
// shared checklist, which is saved back into the workbook (State, Change Log and Requests sheets).
require("./env.js");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {createStore} = require("./store.js");
const {createAccess, SESSION_HOURS} = require("./access.js");
const V = require("./visibility.js");

const CONFIG = {
  port: +process.env.PORT || 3000,
  fileId: process.env.CHECKLIST_FILE_ID || "1bmgjKdSf6zITxFC6A6omZLQ6pdMi0oma",   // Job Checklist DB.xlsx
  localFile: process.env.CHECKLIST_LOCAL_FILE || "",   // testing only: use a local .xlsx instead of Drive
};
const MAX_DOC = 1_000_000, MAX_TOTAL = 25_000_000;
const DOC_PATH = /^(meta\/info|st\/c\d{3}|lg\/c\d{3})$/;
const COOKIE = "jc_session";
const KINDS = {TRANSFER: "act.transfer", ADD: "act.add", EDIT: "act.edit", DELETE: "act.delete", IMPORT: "act.import"};
const LIMITED = new Set(["/api/me", "/password", "/logout"]);   // all a person may do before changing a temporary password

const store = createStore(CONFIG);
const access = createAccess(store);
const file = name => fs.readFileSync(path.join(__dirname, "public", name));

// ---------- helpers ----------
const send = (res, code, type, body, extra = {}) => {
  res.writeHead(code, {"content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", "x-frame-options": "SAMEORIGIN", ...extra});
  res.end(body);
};
const json = (res, code, obj, extra) => send(res, code, "application/json; charset=utf-8", JSON.stringify(obj), extra);
function readBody(req, max = MAX_DOC) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > max) { reject(Object.assign(new Error("Too large"), {status: 413})); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function bodyJson(req, max) {
  let b; try { b = JSON.parse(await readBody(req, max) || "{}"); } catch (e) { throw Object.assign(new Error(e.status === 413 ? "Too large" : "Body must be JSON"), {status: e.status || 400}); }
  if (!b || typeof b !== "object") throw Object.assign(new Error("Body must be an object"), {status: 400});
  return b;
}
// The first cookie of a name wins: browsers send the one with the most specific path first.
const cookies = req => {
  const o = {};
  String(req.headers.cookie || "").split(/;\s*/).filter(Boolean).forEach(c => { const i = c.indexOf("="), k = c.slice(0, i); if (!(k in o)) o[k] = decodeURIComponent(c.slice(i + 1)); });
  return o;
};
const secure = req => req.headers["x-forwarded-proto"] === "https" || !!process.env.RENDER;
// No Path attribute: the browser scopes the cookie to this app's folder, which also works behind a /p/... proxy prefix.
const setCookie = (req, v, maxAge) => `${COOKIE}=${encodeURIComponent(v)}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`;
const clientIp = req => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const bad = (msg, status = 400) => Object.assign(new Error(msg), {status});

function hint(e) {
  let email = "the service account";
  try { email = require("./google.js").clientEmail(); } catch {}
  if (e.status === 403 && /has not been used|disabled/.test(e.message)) return "Enable the Google Drive API for the service account's Cloud project.";
  if (e.status === 403 || e.status === 404) return `Share "Job Checklist DB.xlsx" in Google Drive with ${email} as Editor.`;
  return "";
}

// ---------- visibility (cached per checklist version + shared-state revision) ----------
let visCache = {k: "", idx: null, eff: null};
async function visibility(me) {
  const source = await store.source(false);
  const info = (await store.rawDoc("meta/info")) || {};
  const k = source.ver + "|" + (info.rev || "");
  if (visCache.k !== k) {
    const idx = V.indexSource(source);
    const st = await store.collection("st");
    visCache = {k, idx, eff: V.effective(idx, st)};
  }
  return {source, idx: visCache.idx, eff: visCache.eff, vis: V.visibleIds(me, visCache.eff)};
}

// ---------- change requests ----------
const pick = (o, ks) => Object.fromEntries(ks.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const ENTRY_KEYS = ["action", "id", "freq", "task", "company", "cc", "from", "fromDept", "fromRep", "to", "toDept", "toRep", "eff", "why", "note",
  "chg", "before", "after", "source", "maker", "checker"];
const ADD_KEYS = ["id", "freq", "doer", "dept", "rep", "task", "alias", "company", "cc", "sched", "merged"];

async function createRequest(me, b) {
  const kind = String(b.kind || "").toUpperCase();
  if (!KINDS[kind]) throw bad("Unknown request type");
  if (!me.perms[KINDS[kind]]) throw bad("Your access does not include " + kind.toLowerCase() + " requests", 403);
  const entries = Array.isArray(b.entries) ? b.entries : [];
  if (!entries.length) throw bad("Nothing to request");
  if (entries.length > 3000) throw bad("Too many lines in one request (max 3000)");
  const allowed = kind === "IMPORT" ? ["ADD", "DELETE"] : [kind];
  const {vis} = await visibility(me);
  const myName = V.key(me.name);
  const clean = entries.map(e => {
    if (!e || typeof e !== "object" || !allowed.includes(e.action)) throw bad("A request line has the wrong action");
    if (!/^[DWMY]$/.test(e.freq)) throw bad("A request line has no frequency");
    const c = pick(e, ENTRY_KEYS);
    if (e.action === "ADD") {
      if (vis && !(V.key(e.to) === myName || (me.scope === "team" && V.key(e.toRep) === myName)))
        throw bad("You can only request new tasks for yourself" + (me.scope === "team" ? " or people who report to you" : ""), 403);
    } else if (vis && !vis.has(e.id)) throw bad("A requested task is outside your access", 403);
    return c;
  });
  const addIds = new Set(clean.filter(e => e.action === "ADD").map(e => e.id));
  const adds = (Array.isArray(b.adds) ? b.adds : []).filter(a => a && addIds.has(a.id)).map(a => pick(a, ADD_KEYS));
  if (adds.length !== addIds.size) throw bad("Details of a new task are missing");
  const all = await store.listDocs("rq/");
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  const rq = {id, ref: "RQ-" + String(all.length + 1).padStart(4, "0"), at: new Date().toISOString(), by: {email: me.email, name: me.name},
    kind, summary: String(b.summary || "").slice(0, 500), entries: clean, adds, status: "pending"};
  await store.setDoc("rq/" + id, rq);
  return rq;
}

async function listRequests(me) {
  const all = await store.listDocs("rq/");
  const mine = me.writer ? all : all.filter(r => r.by && V.key(r.by.email) === V.key(me.email));
  return {requests: mine.sort((a, b) => String(b.at).localeCompare(String(a.at))), pending: mine.filter(r => r.status === "pending").length};
}

async function decide(me, b) {
  if (!me.writer) throw bad("Only a checker can approve or reject requests", 403);
  const rq = await store.getDoc("rq/" + String(b.id || ""));
  if (!rq) throw bad("No such request", 404);
  if (rq.status !== "pending") throw bad(`${rq.ref} is already ${rq.status}`, 409);
  if (!["approved", "rejected"].includes(b.status)) throw bad("Status must be approved or rejected");
  if (rq.by && V.key(rq.by.email) === V.key(me.email)) throw bad("You can't approve or reject your own request (maker and checker must differ)", 403);
  if (b.status === "rejected" && !String(b.remark || "").trim()) throw bad("Give a reason for rejecting");
  rq.status = b.status; rq.decidedAt = new Date().toISOString(); rq.decidedBy = {email: me.email, name: me.name};
  rq.remark = String(b.remark || "").slice(0, 500);
  if (b.status === "approved") {
    const r = b.result || {};
    rq.result = {batch: String(r.batch || ""), ok: +r.ok || 0, skipped: (Array.isArray(r.skipped) ? r.skipped : []).slice(0, 3000).map(s => ({task: String(s.task || ""), why: String(s.why || "")}))};
  }
  await store.setDoc("rq/" + rq.id, rq);
  return rq;
}

async function cancel(me, b) {
  const rq = await store.getDoc("rq/" + String(b.id || ""));
  if (!rq || !rq.by || V.key(rq.by.email) !== V.key(me.email)) throw bad("No such request of yours", 404);
  if (rq.status !== "pending") throw bad(`${rq.ref} is already ${rq.status}`, 409);
  rq.status = "cancelled"; rq.decidedAt = new Date().toISOString(); rq.decidedBy = {email: me.email, name: me.name};
  await store.setDoc("rq/" + rq.id, rq);
  return rq;
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/healthz") return send(res, 200, "text/plain", "ok");
  await store.ensureLoaded();

  if (p === "/login" && req.method === "POST") {
    const b = await bodyJson(req, 10_000);
    const email = String(b.email || "").trim().toLowerCase(), keys = ["e:" + email, "ip:" + clientIp(req)];
    if (access.throttled(keys)) return json(res, 429, {error: "Too many failed attempts. Try again in 15 minutes."});
    if (!access.isEmail(email)) return json(res, 400, {error: "Sign in with your email address."});
    const u = await access.verify(email, b.password);
    if (!u) { access.failed(keys); return json(res, 401, {error: "Wrong email or password."}); }
    access.cleared(keys); await access.touchLogin(u);
    return json(res, 200, {ok: true, mustChange: !!u.mustChange}, {"set-cookie": setCookie(req, access.issue(u), SESSION_HOURS * 3600)});
  }
  if (p === "/logout") return json(res, 200, {ok: true}, {"set-cookie": setCookie(req, "", 0)});

  const raw = await access.check(cookies(req)[COOKIE]);
  const me = raw ? access.view(raw) : null;
  if (req.method === "GET" && (p === "/" || p === "/index.html")) {
    if (!(await access.anyUsers())) return send(res, 503, "text/plain", "No users yet: set ADMIN_EMAIL and ADMIN_PASSWORD in the server's environment (or run seed-users.js), then restart.");
    return send(res, 200, "text/html; charset=utf-8", file(me && !me.mustChange ? "index.html" : "login.html"));
  }
  if (!me) return json(res, 401, {code: "signed_out", error: "Signed out – reload the page and sign in again."});
  if (me.mustChange && !LIMITED.has(p)) return json(res, 403, {code: "must_change", error: "Change your temporary password first."});

  if (p === "/api/me" && req.method === "GET") return json(res, 200, me);
  // At the app root (like login), so the browser gives the new session cookie the same path as the first one.
  if (p === "/password" && req.method === "POST") {
    const b = await bodyJson(req, 10_000);
    const u = await access.changeOwnPassword(me, b.current, b.next);
    return json(res, 200, {ok: true}, {"set-cookie": setCookie(req, access.issue(u), SESSION_HOURS * 3600)});
  }

  if (req.method === "GET" && p === "/api/source") {
    if (url.searchParams.has("refresh")) await store.source(true);
    const {source, idx, vis} = await visibility(me);
    const s = V.sourceFor(source, idx, vis);
    return json(res, 200, {...s, doers: source.doers, profiles: V.profiles(source), asof: source.asof, source: source.source, ver: source.ver,
      me, canWrite: me.writer});
  }
  if (req.method === "GET" && p === "/api/db/meta") {
    const st = await store.status();
    return json(res, 200, me.writer ? st : {...st, saveError: null});
  }
  if (req.method === "GET" && p === "/api/db/collection") {
    const c = url.searchParams.get("c");
    if (!/^(st|lg|meta)$/.test(c || "")) return json(res, 400, {error: "Unknown collection"});
    let docs = await store.collection(c);
    if (c !== "meta") {
      const {vis} = await visibility(me);
      docs = c === "st" ? V.filterSt(docs, vis) : V.filterLg(docs, me, vis);
    }
    return json(res, 200, {docs});
  }
  if (p === "/api/db/doc" && (req.method === "PUT" || req.method === "DELETE")) {
    const dp = url.searchParams.get("path") || "";
    if (!DOC_PATH.test(dp)) return json(res, 400, {code: "invalid_argument", error: "Unknown document"});
    if (!me.writer) return json(res, 403, {code: "not_granted", error: "Only a checker can change the shared checklist. Send a request instead."});
    if (req.method === "DELETE") { await store.remove(dp); return json(res, 200, {ok: true}); }
    const body = await bodyJson(req);
    if (store.size() > MAX_TOTAL) return json(res, 413, {code: "quota_exceeded", error: "Shared storage is full"});
    await store.set(dp, body);
    return json(res, 200, {ok: true});
  }

  if (p === "/api/requests" && req.method === "GET") return json(res, 200, await listRequests(me));
  if (p === "/api/requests" && req.method === "POST") return json(res, 200, await createRequest(me, await bodyJson(req, 5_000_000)));
  if (p === "/api/requests/decide" && req.method === "POST") return json(res, 200, await decide(me, await bodyJson(req, 2_000_000)));
  if (p === "/api/requests/cancel" && req.method === "POST") return json(res, 200, await cancel(me, await bodyJson(req, 10_000)));

  if (p.startsWith("/api/access")) {
    if (!me.admin) return json(res, 403, {error: "Admins only"});
    if (p === "/api/access" && req.method === "GET") return json(res, 200, await access.adminView());
    if (p === "/api/access/users" && req.method === "POST") return json(res, 200, await access.addUser(await bodyJson(req, 50_000), me));
    if (p === "/api/access/users" && req.method === "PUT") { await access.saveUsers((await bodyJson(req, 500_000)).users, me); return json(res, 200, await access.adminView()); }
    if (p === "/api/access/users" && req.method === "DELETE") { await access.deleteUser(url.searchParams.get("email"), me); return json(res, 200, await access.adminView()); }
    if (p === "/api/access/reset" && req.method === "POST") return json(res, 200, await access.resetPassword((await bodyJson(req, 10_000)).email, me));
  }
  send(res, 404, "text/plain", "Not found");
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (e.status && e.status < 500) return json(res, e.status, {error: e.message});
    console.error(e);
    json(res, 502, {error: e.message, hint: hint(e)});
  });
}).listen(CONFIG.port, () => {
  console.log(`Job Checklist Dashboard: http://localhost:${CONFIG.port}`);
  store.ensureLoaded().then(() => console.log("Checklist workbook loaded."), e => console.error("Could not load the checklist workbook:", e.message, hint(e)));
});

// The host (and Ctrl+C) stops the server with a signal: write pending changes to Drive first.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => {
  try { await store.flushNow(); } catch (e) { console.error(e.message); }
  process.exit(0);
});
