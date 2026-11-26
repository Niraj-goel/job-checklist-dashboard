# Job Checklist Dashboard

The Job Report Checklist dashboard, served live with sign-in and maker–checker approval. A small Node.js server (no dependencies) reads **Job Checklist DB.xlsx** from Google Drive with the company service account and serves the dashboard page.

## Who can do what

- **Sign-in ID is the person's email.** Everyone signs in with a password. New people get a temporary password and must set their own at first sign-in. Anyone can change their password from the header. An admin can reset a password from the **Access** tab.
- **Each person sees only their data scope**, worked out on the server so a browser never receives other people's tasks:
  - *Own*: tasks where they are the doer.
  - *Team*: own tasks plus tasks of people who report to them.
  - *All*: every task.
- **Makers** (anyone with Request ticks) can transfer, add, edit, delete or import tasks as usual, but nothing changes. Each action becomes a **request** in the **Requests** tab.
- **The checker** (Approve tick, scope All) or an admin reviews each request line by line, then **Approves and applies** it or **Rejects** it with a remark. An approved request goes into the Change Log, with the requester as maker and the checker as checker. Nobody can approve their own request.
- **The Access tab** (admins only) has one row per person:
  - active, admin and data scope;
  - ticks for each tab, each request type, Approve, and Excel downloads.

  Each person gets exactly what is ticked. The person's name must match their doer name in the checklist.

Server-side enforcement: data scope, who can send which requests, and who can approve or change the shared checklist. Tabs and download buttons are hidden in the page. Those only show data the person can already see.

Every table can be sorted (click a column heading) and filtered (box above the table). **Print this tab** prints the open tab on A4 landscape, with title, date, filters and the person's name at the top, and table headings repeated on every page.

## The workbook is the database

| Sheet | What it holds | Who edits it |
|---|---|---|
| `Master` | One row per live task (same columns as the dashboard's *Export master* and import template) | You, in Drive or Excel |
| `Doers` | List of doers, column A | You |
| `Settings` | `AsOf` (date shown on the dashboard), `Source` | You |
| `State` | Approved changes, change requests and the user list (password hashes only), as JSON | The server only. Do not edit |
| `Change Log` | Approved changes as readable rows, rewritten on every save | The server only |
| `Requests` | Every request with its decision, rewritten on every save | The server only |
| `Archive` and any other sheet | Kept as it is | You |

- Changes are written to Drive about 2 seconds after the last change. Drive keeps every version (**File → Version history**).
- When you edit `Master`, `Doers` or `Settings` in Drive, open pages show *"The checklist was updated in Drive – reload"* within about a minute.
- Because users and requests live in the workbook, redeploys and restarts lose nothing.
- Run only **one** server against the workbook at a time. A second one (for example an old Render service) would overwrite the first one's changes.

## Deploy

### Alcove Deploy (employees.alcoverealty.in)

This folder is published on its own as the GitHub repository `Niraj-goel/job-checklist-dashboard` (private). From the monorepo, push it with:

```
git subtree push --prefix Checklist checklist main
```

In Alcove Deploy, add a project for that repository and set these environment variables:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_EMAIL` | `company-master-dashboard@company-master-dashboard.iam.gserviceaccount.com` |
| `GOOGLE_PRIVATE_KEY` | `private_key` from the service-account JSON (same as the Company Master project) |
| `CHECKLIST_FILE_ID` | `1bmgjKdSf6zITxFC6A6omZLQ6pdMi0oma` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Optional break-glass admin sign-in that works even if the user list is damaged. It is not stored anywhere else |
| `SESSION_HOURS` | Optional, default 12 |

The server listens on `PORT` (default 3000) and answers `/healthz` for health checks.

### Render

`render.yaml` in the monorepo root still describes a Render service from this folder. Use either Render or Alcove Deploy, not both (see above).

## Adding people in bulk

`node seed-users.js people.csv` adds everyone in the CSV (`name,email,admin,scope,active`) who is not on the list yet. It writes their temporary passwords to `temp-passwords.csv`. Run it **only while no server is running** against the workbook. Once the dashboard is live, use the Access tab instead. Never commit either CSV.

## Updating the page

The page is built from the stand-alone dashboard HTML. When you get a newer version of that file:

```
node build-page.js "C:\Users\NIRAJ\Downloads\Job_Checklist_Dashboard_NEW.html"
```

It removes the embedded data and adds `page/adapter.js` (shared store), `page/live.css` and `page/live.js` (sign-in, requests, approvals, access, table sort/filter, print). It writes `public/index.html`. Commit and push, and the host redeploys.

## Run it locally

`node server.js` in this folder, then open http://localhost:3000. It reads `Checklist/.env`, then the project's root `.env`, for the key. To try it without touching Drive, point it at a local copy: `CHECKLIST_LOCAL_FILE=C:\path\to\copy.xlsx`.

## Files

| File | What it is |
|---|---|
| `server.js` | Web server, sign-in, data scope, requests and approvals, access API |
| `access.js` | Users, access matrix, password hashing, session cookies |
| `visibility.js` | Which tasks and log lines each person may see |
| `store.js` | Reads the workbook and writes the shared state, Change Log and Requests back into it |
| `google.js` | Google sign-in with the service account, Drive download and upload |
| `env.js` | Reads `.env` files |
| `seed-users.js` | One-time bulk add of people |
| `lib/xlsx.js` | SheetJS 0.18.5 (Apache-2.0), the same Excel library the page uses |
| `build-page.js`, `page/` | Builds `public/index.html` from the stand-alone dashboard |
| `public/index.html`, `public/login.html` | The dashboard page (no task data inside) and the sign-in page |
