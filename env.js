// Loads KEY=value lines into process.env. Values already set in the real environment (for example on Render) win.
// Reads Checklist/.env first, then the project's root .env, so a local run can reuse the Company Master key.
// Double-quoted values may contain \n, which becomes a line break (needed for the private key).
const fs = require("fs");
const path = require("path");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv(path.join(__dirname, ".env"));
loadEnv(path.join(__dirname, "..", ".env"));
module.exports = loadEnv;
