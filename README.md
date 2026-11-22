# Job Checklist Dashboard

The Job Report Checklist dashboard, served live. A small Node.js server reads **Job Checklist DB.xlsx** from Google Drive with the company service account and serves the dashboard page. Transfers, additions, edits and deletions made on the dashboard are shared with everyone and saved back into the same workbook.

## The workbook is the database

| Sheet | What it holds | Who edits it |
|---|---|---|
| `Master` | One row per live task (same columns as the dashboard's *Export master* and import template) | You, in Drive or Excel |
| `Doers` | List of doers, column A | You |
| `Settings` | `AsOf` (date shown on the dashboard), `Source` | You |
| `State` | The team's changes as JSON | The server only. Do not edit |
| `Change Log` | The same changes as readable rows, rewritten on every save | The server only |
| `Archive` and any other sheet | Kept as it is | You |

- Changes made on the dashboard are written to Drive about 2 seconds after the last change. Drive keeps every version, so an earlier one can be restored from **File → Version history**.
- When you edit `Master`, `Doers` or `Settings` in Drive, open pages show *"The checklist was updated in Drive – reload"* within about a minute. As with loading a new checklist file before, changes made on the old version are offered for re-apply.
- Only `State` and `Change Log` are rewritten. The server writes values, not formatting, so cell colours in the workbook may be lost after the first save.

## One-time Google setup

1. Share **Job Checklist DB.xlsx** (or its shared drive) with the service account as **Editor** (Content manager on a shared drive):
   `company-master-dashboard@company-master-dashboard.iam.gserviceaccount.com`
2. The Google Drive API is already enabled for the key's Cloud project.

## Deploy on Render

1. Push this repository to GitHub (already connected: `Niraj-goel/company-master-dashboard`).
2. In Render: **New → Blueprint**, pick the repository. It reads `render.yaml` and creates the `job-checklist-dashboard` web service from the `Checklist` folder.
3. When asked, fill in:
   - `DASHBOARD_PASSWORD`: the password the team will use (user name `alcove`).
   - `VIEWER_PASSWORD`: optional, a view-only sign-in (user name `viewer`). Leave blank for none.
   - `GOOGLE_PRIVATE_KEY`: the `private_key` from the service-account JSON (the same value as in the project's `.env`). Paste it as it is; quotes and `\n` are fine.
4. Open the `https://job-checklist-dashboard….onrender.com` address Render shows and sign in.

On Render's free plan the service sleeps after 15 minutes without visitors, so the first visit after that takes about a minute. Nothing is lost when it sleeps: changes are already in Drive. The paid *Starter* plan keeps it awake.

Render's own disk is wiped on every restart, which is why changes are kept in the Drive workbook and not on the server.

## Updating the page

The page is built from the stand-alone dashboard HTML. When you get a newer version of that file:

```
node build-page.js "C:\Users\NIRAJ\Downloads\Job_Checklist_Dashboard_NEW.html"
```

This removes the embedded data, adds the server adapter (`page/adapter.js`) and the live start-up (`page/boot.js`), and writes `public/index.html`. Commit and push; Render redeploys by itself.

## Run it locally

`node server.js` in this folder, then open http://localhost:3000. It reads `Checklist/.env`, then the project's root `.env`, for the key. With no `DASHBOARD_PASSWORD` set, anyone who can reach the port can change the checklist; on Render the server refuses to run that way.

To try it without touching Drive, point it at a local copy: set `CHECKLIST_LOCAL_FILE=C:\path\to\copy.xlsx`.

## Files

| File | What it is |
|---|---|
| `server.js` | Web server, sign-in, and the API the page uses |
| `store.js` | Reads the workbook and writes the team's changes back into it |
| `google.js` | Google sign-in with the service account, Drive download and upload |
| `env.js` | Reads `.env` files |
| `lib/xlsx.js` | SheetJS 0.18.5 (Apache-2.0), the same Excel library the page uses |
| `build-page.js`, `page/` | Builds `public/index.html` from the stand-alone dashboard |
| `public/index.html` | The dashboard page (no task data inside; it loads it from the server) |
