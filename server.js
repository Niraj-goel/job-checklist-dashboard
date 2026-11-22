// Job Checklist Dashboard server.
// Serves public/index.html and a small API. Task data comes from the checklist workbook in Google Drive,
// read with a service account whose key stays on this server. Changes made on the dashboard are shared by
// everyone and saved back into that workbook (State and Change Log sheets).
require("./env.js");
const http = require("http");
const fs = require("fs");
const path = require("path");
const {createStore} = require("./store.js");

const CONFIG = {
  port: +process.env.PORT || 3000,
  fileId: process.env.CHECKLIST_FILE_ID || "1bmgjKdSf6zITxFC6A6omZLQ6pdMi0oma",   // Job Checklist DB.xlsx
  localFile: process.env.CHECKLIST_LOCAL_FILE || "",   // testing only: use a local .xlsx instead of Drive
  // Editors can change tasks; viewers (optional) can only look and download reports.
  users: [
    {user: process.env.DASHBOARD_USER || "alcove", password: process.env.DASHBOARD_PASSWORD || "", edit: true},
    {user: process.env.VIEWER_USER || "viewer", password: process.env.VIEWER_PASSWORD || "", edit: false},
  ].filter(u => u.password),
};
const MAX_DOC = 1_000_000, MAX_TOTAL = 25_000_000;
const DOC_PATH = /^(meta\/info|st\/c\d{3}|lg\/c\d{3})$/;

const store = createStore(CONFIG);
const page = () => fs.readFileSync(path.join(__dirname, "public", "index.html"));

function who(req) {
  if (!CONFIG.users.length) return {user: "local", edit: true};          // no password set: local use only
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const [u, ...p] = Buffer.from(m[1], "base64").toString().split(":");
  return CONFIG.users.find(x => x.user === u && x.password === p.join(":")) || null;
}

const send = (res, code, type, body, extra = {}) => {
  res.writeHead(code, {"content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", ...extra});
  res.end(body);
};
const json = (res, code, obj) => send(res, code, "application/json; charset=utf-8", JSON.stringify(obj));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > MAX_DOC) { reject(Object.assign(new Error("Too large"), {status: 413})); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function hint(e) {
  let email = "the service account";
  try { email = require("./google.js").clientEmail(); } catch {}
  if (e.status === 403 && /has not been used|disabled/.test(e.message)) return "Enable the Google Drive API for the service account's Cloud project.";
  if (e.status === 403 || e.status === 404) return `Share "Job Checklist DB.xlsx" in Google Drive with ${email} as Editor.`;
  return "";
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") return send(res, 200, "text/plain", "ok");
  if (!CONFIG.users.length && process.env.RENDER)   // on a public host, never run without a password
    return send(res, 503, "text/plain", "Set DASHBOARD_PASSWORD in the Render service's Environment settings, then redeploy.");
  const u = who(req);
  if (!u) return send(res, 401, "text/plain", "Sign in required", {"www-authenticate": 'Basic realm="Job Checklist", charset="UTF-8"'});
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html"))
      return send(res, 200, "text/html; charset=utf-8", page());

    if (req.method === "GET" && url.pathname === "/api/source") {
      const s = await store.source(url.searchParams.has("refresh"));
      return json(res, 200, {...s, user: u.user, canWrite: u.edit});
    }
    if (req.method === "GET" && url.pathname === "/api/db/meta") return json(res, 200, await store.status());
    if (req.method === "GET" && url.pathname === "/api/db/collection") {
      const c = url.searchParams.get("c");
      if (!/^(st|lg|meta)$/.test(c || "")) return json(res, 400, {error: "Unknown collection"});
      return json(res, 200, {docs: await store.collection(c)});
    }
    if (url.pathname === "/api/db/doc" && (req.method === "PUT" || req.method === "DELETE")) {
      const p = url.searchParams.get("path") || "";
      if (!DOC_PATH.test(p)) return json(res, 400, {code: "invalid_argument", error: "Unknown document"});
      if (!u.edit) return json(res, 403, {code: "not_granted", error: "This sign-in can view only."});
      if (req.method === "DELETE") { await store.remove(p); return json(res, 200, {ok: true}); }
      let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, e.status || 400, {code: e.status === 413 ? "quota_exceeded" : "invalid_argument", error: e.message}); }
      if (!body || typeof body !== "object") return json(res, 400, {code: "invalid_argument", error: "Body must be an object"});
      if (store.size() > MAX_TOTAL) return json(res, 413, {code: "quota_exceeded", error: "Shared storage is full"});
      await store.set(p, body);
      return json(res, 200, {ok: true});
    }
    send(res, 404, "text/plain", "Not found");
  } catch (e) {
    console.error(e);
    json(res, 502, {error: e.message, hint: hint(e)});
  }
}).listen(CONFIG.port, () => {
  console.log(`Job Checklist Dashboard: http://localhost:${CONFIG.port}`);
  if (!CONFIG.users.length) console.log("No DASHBOARD_PASSWORD set: anyone who can reach this port can see and change the checklist.");
  store.ensureLoaded().then(() => console.log("Checklist workbook loaded."), e => console.error("Could not load the checklist workbook:", e.message, hint(e)));
});

// Render (and Ctrl+C) stop the server with a signal: write pending changes to Drive first.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => {
  try { await store.flushNow(); } catch (e) { console.error(e.message); }
  process.exit(0);
});
