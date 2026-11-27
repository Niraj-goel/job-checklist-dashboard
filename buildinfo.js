// When this app's code was last updated, for the "Last updated" line in the page header.
// 1. The last git commit, when the app runs from a git checkout (local runs, or a host that keeps .git).
// 2. Otherwise the newest file time in the app folder: a host that clones the repo on every push
//    stamps the files with the clone time, which is when the last push was deployed.
const fs = require("fs");
const path = require("path");
const {execFileSync} = require("child_process");

function fromGit(dir) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI%n%h", "--", "."], {cwd: dir, stdio: ["ignore", "pipe", "ignore"], timeout: 5000}).toString().trim().split("\n");
    return out[0] ? {time: new Date(out[0]).toISOString(), commit: out[1] || "", source: "git"} : null;
  } catch (e) { return null; }
}

function fromFiles(dir) {
  let newest = 0;
  const walk = (d, depth) => {
    for (const f of fs.readdirSync(d, {withFileTypes: true})) {
      if (/^(\.git|node_modules)$/.test(f.name) || f.name.startsWith(".env")) continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (depth < 3) walk(p, depth + 1); }
      else if (/\.(js|html|css|json)$/i.test(f.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  try { walk(dir, 0); } catch (e) {}
  return newest ? {time: new Date(newest).toISOString(), commit: "", source: "deploy"} : null;
}

// What changed recently: version.json, written before each commit by stamp-version.js.
function changes(dir) {
  try { return (JSON.parse(fs.readFileSync(path.join(dir, "version.json"), "utf8")).changes || []).slice(0, 15); }
  catch (e) { return []; }
}

module.exports = dir => ({...(fromGit(dir) || fromFiles(dir) || {time: "", commit: "", source: "unknown"}), changes: changes(dir)});
