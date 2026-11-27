// Minimal Google Drive client for a service account. No dependencies (Node 18+).
// Credentials come from the environment: GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY, or GOOGLE_SERVICE_ACCOUNT_JSON.
require("./env.js");
const crypto = require("crypto");

// Full Drive scope: the server writes shared changes back into the checklist workbook.
// The service account can still only reach files that have been shared with it.
const SCOPES = "https://www.googleapis.com/auth/drive";

let key = null, token = null, tokenExp = 0;
const b64url = b => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

// Accepts the private key however a host stores it: with or without quotes, real line breaks, literal \n,
// or all on one line. Rebuilds a clean PEM from the base64 body.
function normalisePem(raw) {
  let s = String(raw).trim();
  if (/^(["']).*\1$/s.test(s)) s = s.slice(1, -1);
  s = s.replace(/\\r/g, "").replace(/\\n/g, "\n").replace(/\r/g, "");
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s) && /^[A-Za-z0-9+/=\s]+$/.test(s)) {
    const decoded = Buffer.from(s.replace(/\s/g, ""), "base64").toString("utf8");
    if (decoded.includes("PRIVATE KEY-----")) s = decoded;
  }
  const m = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/.exec(s);
  if (!m) throw new Error("GOOGLE_PRIVATE_KEY is not a private key: it must contain -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY-----");
  const body = m[2].replace(/[^A-Za-z0-9+/=]/g, "");
  const pem = `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join("\n")}\n-----END ${m[1]}-----\n`;
  try { crypto.createPrivateKey(pem); }
  catch (e) { throw new Error(`GOOGLE_PRIVATE_KEY could not be read (${e.message}). Paste the private_key value from the service-account JSON again, all of it.`); }
  return pem;
}

function loadKey() {
  if (key) return key;
  let {GOOGLE_CLIENT_EMAIL: email, GOOGLE_PRIVATE_KEY: pk, GOOGLE_TOKEN_URI: uri, GOOGLE_SERVICE_ACCOUNT_JSON: json} = process.env;
  if (json) { const j = JSON.parse(json); email = email || j.client_email; pk = pk || j.private_key; uri = uri || j.token_uri; }
  if (!email || !pk) throw new Error("GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY must be set (in .env, or in the host's environment settings)");
  key = {client_email: email.trim(), private_key: normalisePem(pk), token_uri: (uri || "https://oauth2.googleapis.com/token").trim()};
  return key;
}

async function accessToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const k = loadKey(), now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(JSON.stringify({alg: "RS256", typ: "JWT"})) + "." +
    b64url(JSON.stringify({iss: k.client_email, scope: SCOPES, aud: k.token_uri, iat: now, exp: now + 3600}));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(unsigned).sign(k.private_key));
  const res = await fetch(k.token_uri, {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig})});
  const j = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${j.error_description || j.error || res.status}`);
  token = j.access_token; tokenExp = Date.now() + j.expires_in * 1000;
  return token;
}

async function api(url, {method = "GET", body, type, raw = false} = {}) {
  const headers = {authorization: `Bearer ${await accessToken()}`};
  if (type) headers["content-type"] = type;
  const res = await fetch(url, {method, headers, body});
  if (!res.ok) {
    let msg = res.statusText; try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch {}
    const e = new Error(`${res.status} ${msg}`); e.status = res.status; throw e;
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

const DRIVE = "https://www.googleapis.com/drive/v3/files/";
const meta = id => api(`${DRIVE}${id}?supportsAllDrives=true&fields=id,name,mimeType,modifiedTime,md5Checksum,parents,webViewLink,capabilities(canEdit)`);
const download = id => api(`${DRIVE}${id}?alt=media&supportsAllDrives=true`, {raw: true});
// Replaces the file's content, keeping its id, name, sharing and version history.
const upload = (id, bytes, mimeType) => api(
  `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&supportsAllDrives=true&fields=id,modifiedTime,md5Checksum`,
  {method: "PATCH", body: bytes, type: mimeType});

// Copies a file (same folder unless parents is given). Used for the daily backup of the checklist workbook.
const copy = (id, name, parents) => api(`${DRIVE}${id}/copy?supportsAllDrives=true&fields=id,name,webViewLink`,
  {method: "POST", type: "application/json", body: JSON.stringify(parents ? {name, parents} : {name})});

module.exports = {accessToken, meta, download, upload, copy, clientEmail: () => loadKey().client_email};
