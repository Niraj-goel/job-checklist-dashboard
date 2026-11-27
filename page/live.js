/* ================= LIVE SERVER LAYER =================
   Added by build-page.js on top of the stand-alone dashboard. It:
   - loads the checklist from the server (only the tasks this person may see) and joins the shared store;
   - signs the person in by email, shows only the tabs, buttons and downloads ticked for them;
   - turns a maker's transfer / add / edit / delete / import into a change request instead of a change;
   - gives the checker an Approvals view that applies a request with the page's own logic, so it lands in the
     Change Log with the requester as maker and the checker as checker;
   - gives admins the Access tab (one row per person: ticks per tab, request, approve, download, data scope);
   - adds sorting and filtering to every table, and a print layout for every tab. */
(function () {
  "use strict";
  if (!location.pathname.endsWith('/') && !/\.html$/.test(location.pathname)) { location.replace(location.pathname + '/' + location.search); return; }

  let ME = null, PROFILES = [], APPROVED = {recs: [], log: []}, REQS = [], PENDING = 0, ACC = null, ACC_DIRTY = false;
  const clone = o => JSON.parse(JSON.stringify(o));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const can = k => !!(ME && (ME.admin || (ME.perms && ME.perms[k])));
  const isWriter = () => !!(ME && ME.writer);
  const isMaker = () => !isWriter();
  const fmtDT = s => s ? new Date(s).toLocaleString('en-IN', {day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
  const PFX = {TRANSFER: 'TRF', ADD: 'ADD', EDIT: 'EDT', DELETE: 'DEL', IMPORT: 'IMP'};
  const KIND_NAME = {TRANSFER: 'Transfer', ADD: 'Add', EDIT: 'Edit', DELETE: 'Delete', IMPORT: 'Excel import'};
  const ST_CLS = {pending: 'st warn', approved: 'st good', rejected: 'st bad', cancelled: 'st'};
  const TAB_PERM = {ov: 'tab.ov', wl: 'tab.wl', due: 'tab.due', rep: 'tab.rep', tm: 'tab.tm', log: 'tab.log', dq: 'tab.dq'};
  const TAB_NAME = {ov: 'Overview', wl: 'Doer Workload', due: 'Due Schedule', rep: 'Management Report', tm: 'Task Master', log: 'Change Log', dq: 'Data Quality', req: 'Requests', acc: 'Access', data: 'Data (Drive)'};

  async function api(method, url, body) {
    const res = await fetch(url, {method, credentials: 'same-origin', cache: 'no-store',
      headers: body !== undefined ? {'content-type': 'application/json'} : {}, body: body !== undefined ? JSON.stringify(body) : undefined});
    let j = null; try { j = await res.json(); } catch (e) {}
    if (res.status === 401 || (j && j.code === 'must_change')) { location.reload(); throw new Error('Signed out'); }
    if (!res.ok) throw Object.assign(new Error((j && j.error) || ('Server error ' + res.status)), {hint: j && j.hint});
    return j;
  }

  /* ---------- page furniture ---------- */
  function addHtml() {
    // header: who is signed in
    const hw = $('header.top .wrap');
    $('#fileIn') && $('#fileIn').closest('label').remove();   // the Drive workbook is the source; no local loading
    hw.insertAdjacentHTML('beforeend',
      '<button class="btn sm pend" id="pendBtn" title="Requests waiting for your approval"></button>' +
      '<div class="who"><b id="whoName"></b><span class="role" id="whoRole"></span>' +
      '<button class="btn sm ghost-light" id="pwBtn">Change password</button>' +
      '<button class="btn sm ghost-light" id="outBtn">Sign out</button></div>');
    // tabs
    const nw = $('nav.tabs .wrap');
    nw.insertAdjacentHTML('beforeend', '<button role="tab" data-tab="req" aria-selected="false" id="reqTabBtn">Requests<span class="cnt" id="reqCnt" hidden></span></button>' +
      '<button role="tab" data-tab="acc" aria-selected="false" id="accTabBtn" hidden>Access</button>' +
      '<button role="tab" data-tab="data" aria-selected="false" id="dataTabBtn" hidden>Data (Drive)</button>' +
      '<span class="navsp"></span><button class="btn sm" id="printBtn" title="Print this tab (A4 landscape)">Print this tab</button>');
    $('#reqTabBtn').addEventListener('click', () => { showTab('req'); renderReqs(); });
    $('#accTabBtn').addEventListener('click', () => { showTab('acc'); loadAccess(); });
    $('#dataTabBtn').addEventListener('click', () => { showTab('data'); loadData(); });
    $('#printBtn').addEventListener('click', () => window.print());
    $('#pendBtn').addEventListener('click', () => { showTab('req'); $('#qSt').value = 'pending'; renderReqs(); });
    $('#pwBtn').addEventListener('click', openPw);
    $('#outBtn').addEventListener('click', () => fetch('logout', {credentials: 'same-origin'}).finally(() => location.reload()));
    // print header
    document.body.insertAdjacentHTML('afterbegin', '<div id="printHead"><img alt="" src="data:image/jpeg;base64,' + LOGO_B64 + '"><div><div class="t" id="phT"></div><div class="s" id="phS"></div></div><div class="r" id="phR"></div></div>');
    // sections
    $('main .wrap').insertAdjacentHTML('beforeend', `
<section class="tab" id="tab-req">
  <div class="notice" id="reqNote"></div>
  <div class="kpis" id="reqKpis"></div>
  <div class="filters">
    <div class="fld"><label for="qSt">Status</label><select id="qSt"><option value="">All</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option></select></div>
    <div class="fld"><label for="qKind">Type</label><select id="qKind"><option value="">All types</option><option value="TRANSFER">Transfer</option><option value="ADD">Add</option><option value="EDIT">Edit</option><option value="DELETE">Delete</option><option value="IMPORT">Excel import</option></select></div>
    <div class="fld" id="qByWrap"><label for="qBy">Requested by</label><select id="qBy"></select></div>
    <div class="fld grow"><label for="qQ">Search</label><input id="qQ" type="search" placeholder="Ref, task, remark…"></div>
    <button class="btn" id="qXls">Download requests (Excel)</button>
  </div>
  <div class="card"><div class="tbl-wrap"><table class="dt" id="reqTbl"></table></div></div>
</section>
<section class="tab" id="tab-data">
  <div class="notice">Everything this dashboard holds is kept in <b>one Google Drive file</b>. The server loads it from Drive when it starts, writes every change back within a few seconds, and copies the whole file once a day (and before every checklist upload) into the same Drive folder. Nothing is ever deleted: removed people stay on file, reversed changes stay in the Change Log, and Drive keeps every version (File → Version history).</div>
  <div class="card"><div class="card-h"><div class="grow"><h2>The Drive file</h2><div class="cap">Live status of the workbook this dashboard runs on.</div></div>
    <button class="btn" id="dReload" title="Read the workbook from Drive again now (after editing it in Drive)">Reload from Drive now</button>
    <label class="btn primary" id="dUpBtn" title="Replace the checklist (Master) with a new file">Upload new checklist<input type="file" id="dUp" accept=".xlsx,.xlsm,.html,.htm" hidden></label></div>
    <div id="dataInfo" class="small">Loading…</div>
  </div>
  <div class="card"><h2>What is in the file</h2><div class="cap">Sheets marked “you” can be edited in Drive; the dashboard picks the edit up within a minute. The others are written by the dashboard – edit those through the dashboard.</div>
    <div class="tbl-wrap"><table class="dt"><thead><tr><th>Sheet</th><th>What it holds</th><th>Edited by</th></tr></thead><tbody>
      <tr><td><b>Master</b></td><td>The checklist as loaded or uploaded: one row per task (Master / import layout)</td><td>you, or <i>Upload new checklist</i></td></tr>
      <tr><td><b>Doers</b></td><td>List of doers</td><td>you</td></tr>
      <tr><td><b>Settings</b></td><td>AsOf date and Source file name</td><td>you</td></tr>
      <tr><td><b>Current Tasks</b></td><td>The checklist as it stands now: Master with every approved transfer, edit, addition and deletion applied (deleted rows kept, marked Deleted)</td><td>dashboard</td></tr>
      <tr><td><b>Users</b></td><td>Every person, their email ID, status, data scope and ticks, last sign-in (no passwords)</td><td>dashboard (Access tab)</td></tr>
      <tr><td><b>Requests</b></td><td>Every maker request and the checker's decision</td><td>dashboard</td></tr>
      <tr><td><b>Change Log</b></td><td>Every approved change with maker, checker and source</td><td>dashboard</td></tr>
      <tr><td><b>Audit Log</b></td><td>Who did what and when: sign-ins, password changes, access changes, requests, uploads, reloads</td><td>dashboard</td></tr>
      <tr><td><b>State</b></td><td>The same data in machine form (password hashes only). The dashboard restores itself from this – do not edit</td><td>dashboard</td></tr>
      <tr><td><b>Archive</b> and others</td><td>Kept as they are</td><td>you</td></tr>
    </tbody></table></div>
  </div>
</section>
<section class="tab" id="tab-acc">
  <div class="notice">One row per person. Each person gets exactly what is ticked. <b>Data scope</b>: <i>Own</i> = tasks where they are the doer; <i>Team</i> = own plus tasks of people who report to them; <i>All</i> = every task. The <b>name must match the doer name</b> in the checklist, or they will see no tasks. Request ticks let a person send changes for approval; <b>Approve</b> makes them a checker (needs scope All). Admin = everything plus this tab. Changes apply from the person's next page load.</div>
  <div class="card acc-add">
    <div class="card-h"><div class="grow"><h2>Add a person</h2><div class="cap">A temporary password is created and shown once; the person sets their own at first sign-in.</div></div></div>
    <div class="row" style="align-items:flex-end">
      <div class="fld"><label for="nName">Name (as in checklist)</label><input id="nName" list="dlAll"></div>
      <div class="fld" style="min-width:240px"><label for="nEmail">Email (sign-in ID)</label><input id="nEmail" type="email" placeholder="name@alcoverealty.in"></div>
      <div class="fld"><label for="nScope">Data scope</label><select id="nScope"><option value="own">Own</option><option value="team">Team</option><option value="all">All</option></select></div>
      <button class="btn primary" id="nAdd">Add person</button><span class="small" id="nErr" style="color:var(--bad)"></span>
    </div>
  </div>
  <div class="card">
    <div class="card-h"><div class="grow"><h2>Access matrix</h2><div class="cap" id="accCap"></div></div>
      <button class="btn" id="accXls">Download (Excel)</button><button class="btn" id="accUndo">Discard changes</button><button class="btn primary" id="accSave">Save changes</button></div>
    <div class="acc-wrap"><table class="dt" id="accTbl"></table></div>
  </div>
</section>`);
    document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlgReq" style="width:min(1200px,96vw)"><div class="dh"><h2 id="rqH"></h2><button class="btn sm" data-close>Close</button></div>
  <div class="db"><div id="rqInfo" class="small" style="margin-bottom:10px"></div><div class="tbl-wrap" style="max-height:52vh"><table class="dt" id="rqTbl"></table></div>
  <div class="fld" id="rqRemWrap" style="margin-top:10px"><label for="rqRem">Checker remark (required to reject)</label><input id="rqRem" placeholder="e.g. Approved as discussed / Reason for rejection"></div></div>
  <div class="df"><span id="rqErr" class="small" style="color:var(--bad);flex:1"></span><button class="btn" data-close>Close</button>
    <button class="btn danger" id="rqCancel">Withdraw request</button><button class="btn danger" id="rqReject">Reject</button><button class="btn primary" id="rqApprove">Approve and apply</button></div></dialog>
<dialog id="dlgMsg" style="width:min(640px,94vw)"><div class="dh"><h2 id="mH"></h2></div><div class="db" id="mB"></div><div class="df"><button class="btn" id="mCopy" hidden>Copy</button><button class="btn primary" data-close>OK</button></div></dialog>
<dialog id="dlgPw" style="width:min(440px,94vw)"><div class="dh"><h2>Change password</h2><button class="btn sm" data-close>Close</button></div>
  <form class="db" id="pwForm"><input type="email" autocomplete="username" id="pwUser" hidden>
  <div class="fld" style="margin-bottom:8px"><label for="pwCur">Current password</label><input id="pwCur" type="password" autocomplete="current-password" required></div>
  <div class="fld" style="margin-bottom:8px"><label for="pwNew">New password (8+ characters)</label><input id="pwNew" type="password" autocomplete="new-password" minlength="8" required></div>
  <div class="fld"><label for="pwNew2">Repeat new password</label><input id="pwNew2" type="password" autocomplete="new-password" minlength="8" required></div></form>
  <div class="df"><span id="pwErr" class="small" style="color:var(--bad);flex:1"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="pwSave">Save</button></div></dialog>`);
    $$('#dlgReq [data-close],#dlgMsg [data-close],#dlgPw [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
    $('#pwSave').addEventListener('click', savePw);
    ['#qSt', '#qKind', '#qBy'].forEach(s => $(s).addEventListener('change', renderReqs));
    $('#qQ').addEventListener('input', () => { clearTimeout(renderReqs._t); renderReqs._t = setTimeout(renderReqs, 200); });
    $('#qXls').addEventListener('click', () => exportReqs().catch(e => toast('Export failed: ' + e.message)));
    $('#reqTbl').addEventListener('click', e => { const b = e.target.closest('[data-rq]'); if (b) openReq(b.dataset.rq); });
    $('#rqApprove').addEventListener('click', () => approveCur());
    $('#rqReject').addEventListener('click', () => rejectCur());
    $('#rqCancel').addEventListener('click', () => cancelCur());
    $('#nAdd').addEventListener('click', addPerson);
    $('#dReload').addEventListener('click', reloadDrive);
    $('#dUp').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadChecklist(f); });
    $('#accSave').addEventListener('click', saveAccess);
    $('#accUndo').addEventListener('click', () => { ACC_DIRTY = false; loadAccess(true); });
    $('#accXls').addEventListener('click', () => exportAccess().catch(e => toast('Export failed: ' + e.message)));
    $('#accTbl').addEventListener('input', accChanged);
    $('#accTbl').addEventListener('change', accChanged);
    $('#accTbl').addEventListener('click', e => {
      const r = e.target.closest('[data-reset]'); if (r) return resetPw(r.dataset.reset);
      const d = e.target.closest('[data-del]'); if (d) return delPerson(d.dataset.del);
      const rs = e.target.closest('[data-restore]'); if (rs) return restorePerson(rs.dataset.restore);
    });
    window.addEventListener('beforeunload', e => { if (ACC_DIRTY) { e.preventDefault(); e.returnValue = ''; } });
  }

  function showMsg(title, html, copyText) {
    $('#mH').textContent = title; $('#mB').innerHTML = html;
    const c = $('#mCopy'); c.hidden = !copyText;
    c.onclick = () => { navigator.clipboard.writeText(copyText).then(() => toast('Copied.'), () => toast('Select the text and copy it.')); };
    $('#dlgMsg').showModal();
  }

  /* ---------- password ---------- */
  function openPw() { $('#pwForm').reset(); $('#pwUser').value = ME.email; $('#pwErr').textContent = ''; $('#dlgPw').showModal(); }
  async function savePw() {
    const err = m => { $('#pwErr').textContent = m; };
    if ($('#pwNew').value !== $('#pwNew2').value) return err('The two new passwords are not the same.');
    if ($('#pwNew').value.length < 8) return err('At least 8 characters.');
    try { await api('POST', 'password', {current: $('#pwCur').value, next: $('#pwNew').value}); $('#dlgPw').close(); toast('Password changed.'); }
    catch (e) { err(e.message); }
  }

  /* ---------- who / permissions ---------- */
  function applyPerms() {
    $('#whoName').textContent = ME.name;
    $('#whoRole').textContent = (ME.admin ? 'Admin' : ME.writer ? 'Checker' : 'Maker') + ' · ' + ({own: 'own tasks', team: 'own + team tasks', all: 'all tasks'})[ME.scope] + ' · ' + ME.email;
    if (ME.breakGlass) $('#pwBtn').hidden = true;
    document.body.classList.toggle('maker', isMaker());
    // tabs
    Object.entries(TAB_PERM).forEach(([t, k]) => { const b = $('nav.tabs button[data-tab="' + t + '"]'); if (b) b.hidden = !can(k); });
    $('#accTabBtn').hidden = !ME.admin;
    $('#dataTabBtn').hidden = !ME.admin;
    const first = $$('nav.tabs button[data-tab]').find(b => !b.hidden);
    const cur = $('nav.tabs button[aria-selected="true"]');
    if (!cur || cur.hidden) showTab(first ? first.dataset.tab : 'req');
    // request / approve actions
    const hide = (sel, off) => $$(sel).forEach(el => { el.hidden = off; if (off) el.style.setProperty('display', 'none', 'important'); else el.style.removeProperty('display'); });
    hide('#tAdd', !(isWriter() || can('act.add')));
    hide('#tEdit', !(isWriter() || can('act.edit')));
    hide('#tDel', !(isWriter() || can('act.delete')));
    hide('#tImp', !(isWriter() || can('act.import')));
    hide('#trPanel .fld,#trGo,#trPanel h2,#trSel', !(isWriter() || can('act.transfer')));
    document.body.classList.toggle('no-edit', !(isWriter() || can('act.edit')));
    // downloads
    const dl = can('dl.excel');
    hide('#wlXls,#dXls,#rXls,#rXlsAll,#mXls,#lXls,#qXls,#accXls,#oldDl,#iErrXls', !dl);
    hide('#tTpl,#tTplCur,#iTpl2', !(dl && (isWriter() || can('act.import'))));
    hide('#mXls + .small', !dl);
    // maker / checker fields: the signed-in person fills one side automatically
    const lockF = (ids, v) => ids.forEach(id => { const el = $(id); if (!el) return; el.value = v; el.readOnly = true; el.classList.add('lock'); el.removeAttribute('list'); });
    if (isMaker()) {
      lockF(['#trMaker', '#aMaker', '#xMaker', '#iMaker'], ME.name);
      lockF(['#trChecker', '#aChecker', '#xChecker', '#iChecker'], 'Checker – on approval');
      $('#roNote').hidden = false;
      $('#roNote').innerHTML = 'You are signed in as a <b>maker</b>: transfers, additions, edits, deletions and imports you make here are sent to the checker as <b>requests</b>. Nothing changes until the checker approves. Follow them in the <b>Requests</b> tab.';
    } else {
      lockF(['#trChecker', '#aChecker', '#xChecker', '#iChecker'], ME.name);
      ['#trMaker', '#aMaker', '#xMaker', '#iMaker'].forEach(id => { const el = $(id); if (el) el.placeholder = 'Who asked for this change'; });
    }
    const lc = $('#tab-log .cap'); if (lc) lc.innerHTML = 'Every approved addition, edit, deletion and transfer with the maker–checker trail and source. Saved for everyone in the checklist workbook (Change Log sheet).' + (isWriter() ? ' Reverse newest-first.' : '');
    relabel();
  }
  const noEditCss = document.createElement('style');
  noEditCss.textContent = 'body.no-edit [data-edit]{display:none!important}';
  document.head.appendChild(noEditCss);

  // Maker buttons say what really happens.
  function relabel() {
    if (!isMaker()) return;
    const n = sel.size;
    $('#trGo').textContent = n ? 'Request transfer of ' + n + ' task(s)' : 'Request transfer';
    $('#tDel').textContent = n ? 'Request deletion (' + n + ')' : 'Request deletion';
    $('#xSave').textContent = 'Send deletion request';
    $('#aSave').textContent = EDIT_MODE ? 'Send edit request' : 'Send add request';
    const ia = $('#iApply'); if (ia && /^Apply/.test(ia.textContent)) ia.textContent = ia.textContent.replace(/^Apply/, 'Send') + ' for approval';
  }

  /* ---------- checklist load (rows keep their numbers so task ids match the checker's) ---------- */
  function toSrc(m) {
    const H = m.head || [];
    const h = H.findIndex(r => key((r || [])[0]) === 'action');
    const hdr = (H[h] || []).map(key), ix = n => hdr.indexOf(key(n)), get = (r, n) => { const i = ix(n); return i < 0 ? null : r[i]; };
    const src = {}, problems = [];
    FK.forEach(fk => { const f = FREQ[fk];
      const sheet = [['Date:- ' + (m.asof || '')], ['SL.NO.', 'DOER', 'DEPT.', 'REPORTING TO', f.title, 'TASK ALIAS', 'Company', 'Cost Centre', 'Task Merged'].concat(f.cols)];
      sheet.length = Math.max(2, (m.lens || {})[fk] || 2);
      src[f.sheet] = sheet; });
    (m.rows || []).forEach(({n, fk, r}) => {
      if (!FREQ[fk]) return;
      const b = buildSched(fk, {time: get(r, 'Daily Time'), wk: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(c => isTick(get(r, c))),
        mdays: get(r, 'Monthly Due Day(s)'), ydays: FREQ.Y.cols.map(c => get(r, c))});
      if (b.err) problems.push(FREQ[fk].name + ' row ' + n + ': ' + b.err);
      const sched = b.sched || FREQ[fk].cols.map(() => null);
      src[FREQ[fk].sheet][n - 1] = [n - 2, get(r, 'Doer'), get(r, 'Department'), get(r, 'Reporting To'), get(r, 'Task Description'),
        get(r, 'Task Alias'), get(r, 'Company'), get(r, 'Cost Centre'), null].concat(sched);
    });
    src.doers = m.doers || []; src.asof = m.asof || ''; src.source = m.source || ''; src.ver = m.ver || '';
    return {src, problems};
  }

  function snapshotApproved() { APPROVED = {recs: clone(stateRecords()), log: clone(LOG)}; }
  function restoreApproved() {
    ALLT = parseSource(SRC); LOG = clone(APPROVED.log); applyRecords(clone(APPROVED.recs)); refresh();
    sel.clear(); buildFilters(); updateMeta(); renderAll();
  }

  /* ---------- patches to the page's own functions ---------- */
  function patch() {
    const _loadRemote = loadRemote;
    loadRemote = async function (m) { const ok = await _loadRemote(m); if (ok) snapshotApproved(); return ok; };

    const _setReadOnly = setReadOnly;
    setReadOnly = function (ro) { if (ro && ME && isMaker()) return; _setReadOnly(ro); };

    const _setSync = setSync;
    setSync = function (state, txt) {
      if (ME && isMaker() && /^View only/.test(txt || '')) txt = txt.replace(/^View only/, 'Changes go for approval');
      _setSync(state, txt);
    };

    AFTER = afterChange;
    afterChange = function (msg) {
      if (ME && isMaker()) return submitRequest(msg);
      return AFTER(msg);
    };

    const _renderSelInfo = renderSelInfo;
    renderSelInfo = function () { _renderSelInfo(); relabel(); };
    const _setMode = setMode;
    setMode = function (edit, id, picker) { _setMode(edit, id, picker); relabel(); };
    const _renderImport = renderImport;
    renderImport = function () { _renderImport(); relabel(); };

    // Makers may only add tasks for themselves (own) or their team (team).
    const _openAdd = openAdd;
    openAdd = function () {
      _openAdd();
      const allow = addAllowed();
      if (allow) {
        $('#aDoer').innerHTML = '<option value="">— select doer —</option>' + allow.map(v => '<option>' + esc(v) + '</option>').join('');
        if (allow.length === 1) $('#aDoer').value = allow[0];
        onAddDoer();
      }
    };
    const _parseImport = parseImport;
    parseImport = function (aoa, fname) {
      const r = _parseImport(aoa, fname);
      const allow = addAllowed();
      if (allow && r && r.rows) r.rows.forEach(o => {
        if (o.act === 'ADD' && o.doer && !allow.some(a => key(a) === key(o.doer))) { o.msgs.push('You can only add tasks for ' + allow.join(', ')); o.status = 'error'; }
      });
      return r;
    };
    // Doer profiles (dept / reviewer) for people whose tasks this person can't see.
    const _targetProfile = targetProfile;
    targetProfile = function (name) {
      const p = _targetProfile(name); if (p) return p;
      const q = PROFILES.find(x => key(x.name) === key(name));
      return q ? {dept: q.dept, rep: q.rep} : null;
    };
    // Task Master: show every row when printing.
    let tmAll = false;
    const _renderTM = renderTM;
    renderTM = function () {
      if (!tmAll) return _renderTM();
      const L = tmFiltered();
      let h = '<thead><tr><th></th><th>Freq</th><th>Doer</th><th>Reporting to</th><th>Task</th><th>Schedule</th><th></th></tr></thead><tbody>';
      L.forEach(t => { h += '<tr><td></td><td><span class="badge f-' + t.freq + '">' + FREQ[t.freq].name + '</span></td><td>' + esc(t.doer) + '</td><td>' + esc(t.rep) + '</td><td>' + esc(t.merged) + '</td><td>' + esc(schedText(t)) + '</td><td></td></tr>'; });
      $('#tTbl').innerHTML = h + '</tbody>'; $('#tCount').textContent = fmtN(L.length) + ' task line(s)'; $('#tMore').textContent = '';
    };
    window.addEventListener('beforeprint', () => {
      fillPrintHead();
      $$('details.dq').forEach(d => { d.dataset.wasOpen = d.open ? '1' : ''; d.open = true; });
      if ($('#tab-tm').classList.contains('active') && TASKS.length > 400) { tmAll = true; renderTM(); }
    });
    window.addEventListener('afterprint', () => {
      $$('details.dq').forEach(d => { d.open = d.dataset.wasOpen === '1'; });
      if (tmAll) { tmAll = false; renderTM(); }
    });
  }
  let AFTER = null;

  function addAllowed() {
    if (!ME || isWriter() || ME.scope === 'all') return null;
    const me = ME.name, out = [me];
    if (ME.scope === 'team') PROFILES.filter(p => key(p.rep) === key(me)).forEach(p => out.push(p.name));
    return uniq(out);
  }

  /* ---------- maker: send a request instead of changing ---------- */
  async function submitRequest(msg) {
    const newL = LOG.slice(APPROVED.log.length);
    if (!newL.length) { restoreApproved(); return; }
    const pre = String(newL[0].batch || '').split('-')[0];
    const kind = pre === 'IMP' ? 'IMPORT' : (newL[0].action || 'TRANSFER');
    const adds = newL.filter(l => l.action === 'ADD').map(l => {
      const t = ALLT.find(x => x.id === l.id);
      return t && {id: t.id, freq: t.freq, doer: t.doer, dept: t.dept, rep: t.rep, task: t.task, alias: t.alias, company: t.company, cc: t.cc, sched: clone(t.sched), merged: t.merged};
    }).filter(Boolean);
    const entries = newL.map(l => { const o = clone(l); delete o.batch; delete o.ts; delete o.undone; delete o.undoTs; return o; });
    const summary = String(msg || '').replace(/^[A-Z]+-\d+:\s*/, '').replace(/ Reverse from the Change Log if needed\./, '');
    restoreApproved();
    try {
      const rq = await api('POST', 'api/requests', {kind, summary, entries, adds});
      toast(rq.ref + ' sent for approval: ' + summary);
      await loadReqs();
    } catch (e) {
      showMsg('Request not sent', '<p>' + esc(e.message) + '</p><p class="muted small">Nothing was changed. Try again, or ask the admin about your access.</p>');
    }
  }

  /* ---------- checker: apply a request with the page's own logic ---------- */
  function replay(rq) {
    const addById = new Map((rq.adds || []).map(a => [a.id, a])), idMap = new Map(), skipped = [];
    const batch = newBatch(PFX[rq.kind] || 'RQ'); let ok = 0;
    const base = {maker: (rq.by && rq.by.name) || '', checker: ME.name};
    const skip = (l, why) => skipped.push({task: l.task || '', why});
    (rq.entries || []).forEach(l => {
      const act = l.action || 'TRANSFER';
      const source = 'Request ' + rq.ref + (l.source && l.source !== 'Dashboard (manual)' ? ' · ' + l.source : '');
      const meta = Object.assign({eff: l.eff || '', why: l.why || '', note: l.note || '', source}, base);
      if (act === 'ADD') {
        const a = addById.get(l.id); if (!a) return skip(l, 'Details of the new task are missing');
        if (TASKS.some(x => dupKey(x.freq, x.doer, x.merged) === dupKey(a.freq, a.doer, a.merged))) return skip(l, 'The same task already exists');
        const nt = commitAdd({freq: a.freq, doer: a.doer, dept: a.dept, rep: a.rep, task: a.task, alias: a.alias, company: a.company, cc: a.cc, sched: clone(a.sched)}, Object.assign({}, meta, {why: meta.why || 'New task'}), batch);
        idMap.set(l.id, nt.id); refresh(); ok++; return;
      }
      const t = findForReplay(l, new Map(), idMap);
      if (!t) return skip(l, 'Task not found (it may have been changed or removed since the request)');
      idMap.set(l.id, t.id);
      if (act === 'DELETE') { if (t.deleted) return skip(l, 'Already deleted'); commitDelete(t, meta, batch); refresh(); ok++; return; }
      if (t.deleted) return skip(l, 'Task has been deleted');
      if (act === 'TRANSFER') {
        const to = canon(l.to);
        if (t.doer === to && t.dept === l.toDept && t.rep === canon(l.toRep)) return skip(l, 'Already the same');
        logEntry('TRANSFER', batch, t, Object.assign({from: t.doer, fromDept: t.dept, fromRep: t.rep, to, toDept: l.toDept, toRep: canon(l.toRep)}, meta));
        t.doer = to; t.dept = l.toDept; t.rep = canon(l.toRep); t.ref = batch; recomputeMoved(t); ok++; return;
      }
      if (act === 'EDIT') {
        const b = l.before || {}, a = l.after || {}, before = snap(t); let ch = false;
        ['doer', 'dept', 'rep', 'task', 'alias', 'company', 'cc', 'sched'].forEach(k => { if (JSON.stringify(b[k]) !== JSON.stringify(a[k]) && a[k] !== undefined) { t[k] = clone(a[k]); ch = true; } });
        if (['task', 'company', 'cc'].some(k => JSON.stringify(b[k]) !== JSON.stringify(a[k]))) t.merged = mergedOf(t.task, t.company, t.cc);
        if (!ch || sameSnap(before, snap(t))) { Object.assign(t, before); return skip(l, 'Already the same'); }
        logEntry('EDIT', batch, t, Object.assign({from: before.doer, fromDept: before.dept, fromRep: before.rep, to: t.doer, toDept: t.dept, toRep: t.rep, chg: l.chg || '', before, after: snap(t)}, meta));
        t.editRef = batch; if (before.doer !== t.doer) t.ref = batch; recomputeMoved(t); ok++; return;
      }
      skip(l, 'Unknown action');
    });
    return {batch, ok, skipped};
  }
  async function saveNow() {
    for (let i = 0; i < 4; i++) {
      clearTimeout(syncTimer);
      while (writing) await sleep(150);
      await doSync();
      if ($('#syncSt').classList.contains('ok')) return true;
      await sleep(1500);
    }
    return false;
  }

  /* ---------- requests ---------- */
  async function loadReqs() {
    try { const j = await api('GET', 'api/requests'); REQS = j.requests || []; PENDING = j.pending || 0; }
    catch (e) { return; }
    const c = $('#reqCnt'); c.hidden = !PENDING; c.textContent = PENDING;
    const pb = $('#pendBtn');
    pb.classList.toggle('on', isWriter() && PENDING > 0); pb.textContent = PENDING + ' request' + (PENDING === 1 ? '' : 's') + ' to approve';
    if ($('#tab-req').classList.contains('active') || !renderReqs._done) renderReqs();
  }
  function reqLines(r) {
    const c = {}; (r.entries || []).forEach(l => { c[l.action] = (c[l.action] || 0) + 1; });
    return Object.entries(c).map(([a, n]) => (KIND_NAME[a] || a) + ' ' + n).join(', ');
  }
  function reqFiltered() {
    const st = $('#qSt').value, k = $('#qKind').value, by = $('#qBy').value, q = key($('#qQ').value);
    return REQS.filter(r => (!st || r.status === st) && (!k || r.kind === k) && (!by || (r.by && r.by.email) === by) &&
      (!q || key([r.ref, r.summary, r.remark, r.by && r.by.name].concat((r.entries || []).map(l => l.task)).join(' ')).includes(q)));
  }
  function renderReqs() {
    renderReqs._done = true;
    const people = uniq(REQS.map(r => r.by && r.by.email).filter(Boolean));
    fillSel($('#qBy'), people, 'Everyone', true);
    $('#qByWrap').hidden = !isWriter();
    $('#reqNote').innerHTML = isWriter()
      ? 'Requests sent by makers. <b>Approve and apply</b> makes the change for everyone and records it in the Change Log (maker = requester, checker = you). <b>Reject</b> needs a remark. Open a request to see every line before deciding.'
      : 'Your change requests. A request changes nothing until the checker approves it. You can withdraw a request while it is pending.';
    const n = s => REQS.filter(r => r.status === s).length;
    $('#reqKpis').innerHTML = [['Pending', n('pending'), 'waiting for the checker'], ['Approved', n('approved'), 'applied to the checklist'], ['Rejected', n('rejected'), 'not applied'], ['Withdrawn', n('cancelled'), 'by the maker']]
      .map(k => '<div class="kpi"><div class="l">' + k[0] + '</div><div class="v">' + k[1] + '</div><div class="n">' + k[2] + '</div></div>').join('');
    const L = reqFiltered();
    if (!L.length) { $('#reqTbl').innerHTML = '<tbody><tr><td class="muted">' + (REQS.length ? 'No requests match the filters.' : 'No requests yet.') + '</td></tr></tbody>'; return; }
    let h = '<thead><tr><th>Ref</th><th>Submitted</th>' + (isWriter() ? '<th>Requested by</th>' : '') + '<th>Type</th><th>Lines</th><th>Summary</th><th>Status</th><th>Decided</th><th>Checker remark</th><th>Change ref</th><th class="rq-act"></th></tr></thead><tbody>';
    L.forEach(r => {
      h += '<tr><td style="white-space:nowrap"><b>' + esc(r.ref) + '</b></td><td class="small" style="white-space:nowrap">' + fmtDT(r.at) + '</td>' +
        (isWriter() ? '<td>' + esc(r.by && r.by.name) + '</td>' : '') +
        '<td>' + esc(KIND_NAME[r.kind] || r.kind) + '</td><td class="small">' + esc(reqLines(r)) + '</td><td class="small">' + esc(r.summary) + '</td>' +
        '<td><span class="' + (ST_CLS[r.status] || 'st') + '">' + esc(r.status === 'cancelled' ? 'withdrawn' : r.status) + '</span></td>' +
        '<td class="small">' + (r.decidedAt ? fmtDT(r.decidedAt) + '<div class="muted">' + esc(r.decidedBy && r.decidedBy.name) + '</div>' : '') + '</td>' +
        '<td class="small">' + esc(r.remark || '') + (r.result && r.result.skipped && r.result.skipped.length ? '<div class="muted">' + r.result.ok + ' applied, ' + r.result.skipped.length + ' skipped</div>' : '') + '</td>' +
        '<td>' + esc(r.result && r.result.batch || '') + '</td>' +
        '<td class="rq-act"><button class="btn sm' + (r.status === 'pending' && isWriter() ? ' primary' : '') + '" data-rq="' + esc(r.id) + '">' + (r.status === 'pending' && isWriter() ? 'Review' : 'View') + '</button></td></tr>';
    });
    $('#reqTbl').innerHTML = h + '</tbody>';
  }

  let CUR = null;
  function entryRow(l) {
    const act = l.action || 'TRANSFER', a = ACT_ST[act] || ['st', act];
    let chg = '';
    if (act === 'TRANSFER') chg = esc(l.from || '') + ' → <b>' + esc(l.to || '') + '</b><div class="muted">' + esc([l.toDept, l.toRep && ('reports to ' + l.toRep)].filter(Boolean).join(' · ')) + '</div>';
    else if (act === 'EDIT') chg = esc(l.chg || '');
    else if (act === 'ADD') chg = 'for <b>' + esc(l.to || '') + '</b><div class="muted">' + esc([l.toDept, l.toRep && ('reports to ' + l.toRep)].filter(Boolean).join(' · ')) + '</div>';
    else if (act === 'DELETE') chg = 'from ' + esc(l.from || '');
    return '<tr><td><span class="' + a[0] + '">' + a[1] + '</span></td><td><span class="badge f-' + l.freq + '">' + (FREQ[l.freq] ? FREQ[l.freq].name : '') + '</span></td><td class="small">' + esc(l.task) + '</td><td class="small">' + chg + '</td><td class="small">' + esc(l.why || '') + (l.note ? '<div class="muted">' + esc(l.note) + '</div>' : '') + '</td><td style="white-space:nowrap">' + (l.eff ? ddmmyyyy(parseIso(l.eff)) : '') + '</td><td class="small muted">' + esc(l.source && l.source !== 'Dashboard (manual)' ? l.source : '') + '</td></tr>';
  }
  function openReq(id) {
    const r = REQS.find(x => x.id === id); if (!r) return;
    CUR = r;
    $('#rqH').textContent = r.ref + ' · ' + (KIND_NAME[r.kind] || r.kind) + ' · ' + (r.status === 'cancelled' ? 'withdrawn' : r.status);
    $('#rqInfo').innerHTML = 'Requested by <b>' + esc(r.by && r.by.name) + '</b> (' + esc(r.by && r.by.email) + ') on ' + fmtDT(r.at) + ' · ' + (r.entries || []).length + ' line(s)' +
      (r.summary ? '<div style="margin-top:4px">' + esc(r.summary) + '</div>' : '') +
      (r.decidedAt ? '<div style="margin-top:4px">' + esc(r.status === 'cancelled' ? 'Withdrawn' : r.status[0].toUpperCase() + r.status.slice(1)) + ' by <b>' + esc(r.decidedBy && r.decidedBy.name) + '</b> on ' + fmtDT(r.decidedAt) + (r.remark ? ' – ' + esc(r.remark) : '') + (r.result && r.result.batch ? ' · Change ref <b>' + esc(r.result.batch) + '</b>' : '') + '</div>' : '') +
      (r.result && r.result.skipped && r.result.skipped.length ? '<div class="st warn" style="margin-top:6px">' + r.result.skipped.length + ' line(s) were skipped: ' + esc(r.result.skipped.map(s => lbl(s.task) + ' (' + s.why + ')').join('; ')) + '</div>' : '');
    $('#rqTbl').innerHTML = '<thead><tr><th>Action</th><th>Freq</th><th>Task</th><th>Change</th><th>Reason / remarks</th><th>Effective</th><th>Source</th></tr></thead><tbody>' + (r.entries || []).map(entryRow).join('') + '</tbody>';
    const pend = r.status === 'pending', mine = r.by && key(r.by.email) === key(ME.email);
    $('#rqApprove').hidden = !(pend && isWriter() && !mine); $('#rqReject').hidden = !(pend && isWriter() && !mine);
    $('#rqRemWrap').hidden = !(pend && isWriter() && !mine); $('#rqCancel').hidden = !(pend && mine);
    $('#rqRem').value = ''; $('#rqErr').textContent = '';
    if (pend && isWriter() && mine) $('#rqErr').textContent = 'Your own request needs another checker.';
    $('#dlgReq').showModal();
  }
  async function approveCur() {
    const r = CUR; if (!r) return;
    const btn = $('#rqApprove'); btn.disabled = true; $('#rqErr').textContent = '';
    try {
      if (!CAN_WRITE || !SYNC_ON) throw new Error('This page cannot save shared changes right now – reload and try again.');
      const res = replay(r);
      if (!res.ok) { $('#rqErr').textContent = 'Nothing could be applied: ' + res.skipped.map(s => lbl(s.task) + ' – ' + s.why).join('; ') + '. Reject the request with a remark instead.'; return; }
      AFTER(res.batch + ': ' + r.ref + ' approved – ' + res.ok + ' line(s) applied' + (res.skipped.length ? ', ' + res.skipped.length + ' skipped' : '') + '.');
      const saved = await saveNow();
      await api('POST', 'api/requests/decide', {id: r.id, status: 'approved', remark: $('#rqRem').value.trim(), result: res});
      $('#dlgReq').close();
      if (!saved) showMsg('Approved – saving is still retrying', '<p>' + esc(r.ref) + ' is approved and applied on this page, but the save to Drive has not finished yet. Keep this page open until the header shows “Saved for everyone”.</p>');
      else if (res.skipped.length) showMsg(r.ref + ' approved with skipped lines', '<p>' + res.ok + ' line(s) applied under change ref <b>' + esc(res.batch) + '</b>. These were skipped:</p><ul>' + res.skipped.map(s => '<li>' + esc(lbl(s.task)) + ' – ' + esc(s.why) + '</li>').join('') + '</ul>');
      await loadReqs();
    } catch (e) { $('#rqErr').textContent = e.message; }
    finally { btn.disabled = false; }
  }
  async function rejectCur() {
    const r = CUR; if (!r) return;
    const rem = $('#rqRem').value.trim(); if (!rem) { $('#rqErr').textContent = 'Write the reason for rejecting in the remark box.'; $('#rqRem').focus(); return; }
    try { await api('POST', 'api/requests/decide', {id: r.id, status: 'rejected', remark: rem}); $('#dlgReq').close(); toast(r.ref + ' rejected.'); await loadReqs(); }
    catch (e) { $('#rqErr').textContent = e.message; }
  }
  async function cancelCur() {
    const r = CUR; if (!r) return;
    try { await api('POST', 'api/requests/cancel', {id: r.id}); $('#dlgReq').close(); toast(r.ref + ' withdrawn.'); await loadReqs(); }
    catch (e) { $('#rqErr').textContent = e.message; }
  }
  async function exportReqs() {
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Requests'), wl = wb.addWorksheet('Request Lines');
    const H = ['Ref', 'Submitted', 'Requested by', 'Email', 'Type', 'Lines', 'Summary', 'Status', 'Decided at', 'Decided by', 'Checker remark', 'Change ref', 'Applied', 'Skipped'];
    hdrRow(ws.addRow(H));
    const L = reqFiltered();
    L.forEach(r => ws.addRow([r.ref, r.at ? new Date(r.at) : null, r.by && r.by.name, r.by && r.by.email, KIND_NAME[r.kind] || r.kind, (r.entries || []).length, r.summary,
      r.status === 'cancelled' ? 'withdrawn' : r.status, r.decidedAt ? new Date(r.decidedAt) : null, r.decidedBy && r.decidedBy.name, r.remark || '', r.result && r.result.batch || '', r.result ? r.result.ok : null, r.result ? (r.result.skipped || []).length : null]));
    hdrRow(wl.addRow(['Ref', 'Status', 'Action', 'Frequency', 'Task', 'From', 'To', 'To Dept', 'To Reporting To', 'Change', 'Reason', 'Remarks', 'Effective', 'Source']));
    L.forEach(r => (r.entries || []).forEach(l => wl.addRow([r.ref, r.status, l.action, FREQ[l.freq] ? FREQ[l.freq].name : '', l.task, l.from || '', l.to || '', l.toDept || '', l.toRep || '', l.chg || '', l.why || '', l.note || '', l.eff || '', l.source || ''])));
    [ws, wl].forEach(s => { s.columns.forEach((c, i) => { c.width = [14, 18, 22, 26, 12, 8, 60, 12, 18, 20, 30, 12, 9, 9][i] || 16; }); s.views = [{state: 'frozen', ySplit: 1}];
      s.pageSetup = {orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1'}; });
    ws.getColumn(2).numFmt = 'dd-mm-yyyy hh:mm'; ws.getColumn(9).numFmt = 'dd-mm-yyyy hh:mm';
    await dl(wb, 'Checklist_Requests_' + ddmmyyyy(new Date()) + '.xlsx');
  }

  /* ---------- access (admins) ---------- */
  async function loadAccess(force) {
    if (!ME.admin) return;
    if (ACC && !force && ACC_DIRTY) return;
    try { ACC = await api('GET', 'api/access'); ACC_DIRTY = false; renderAccess(); }
    catch (e) { $('#accCap').textContent = 'Could not load: ' + e.message; }
  }
  function knownNames() { return new Set(DOERLIST.concat(PROFILES.map(p => p.name), PROFILES.map(p => p.rep)).map(key)); }
  function renderAccess() {
    const P = ACC.perms, names = knownNames();
    const groups = []; P.forEach(p => { const g = groups.find(x => x.g === p.group); if (g) g.n++; else groups.push({g: p.group, n: 1}); });
    let h = '<thead><tr><th rowspan="2">Name</th><th rowspan="2">Email (sign-in ID)</th><th rowspan="2">Active</th><th rowspan="2">Admin</th><th rowspan="2">Data scope</th>' +
      groups.map(g => '<th class="grp" colspan="' + g.n + '">' + esc(g.g) + '</th>').join('') + '<th rowspan="2">Password</th><th rowspan="2">Last sign-in</th><th rowspan="2" class="rq-act"></th></tr><tr>' +
      P.map(p => '<th class="c" title="' + esc(p.note || p.label) + '">' + esc(p.label) + '</th>').join('') + '</tr></thead><tbody>';
    ACC.users.slice().sort((a, b) => (!!a.removed - !!b.removed) || (b.admin - a.admin) || a.name.localeCompare(b.name)).forEach(u => {
      if (u.removed) {
        h += '<tr data-email="' + esc(u.email) + '" data-removed="1" class="off"><td>' + esc(u.name) + '</td><td>' + esc(u.email) + '</td><td colspan="' + (3 + P.length + 2) + '"><span class="st bad">Removed ' + esc(fmtDT(u.removed)) + '</span> <span class="muted small">kept on file · cannot sign in</span></td>' +
          '<td class="rq-act"><button class="btn sm" data-restore="' + esc(u.email) + '">Restore</button></td></tr>';
        return;
      }
      const off = !u.active, nameWarn = !names.has(key(u.name)) ? '<div class="warnx">Not a doer / reviewer name in the checklist</div>' : '';
      h += '<tr data-email="' + esc(u.email) + '" class="' + (off ? 'off' : '') + '">' +
        '<td><input type="text" class="nm" data-f="name" value="' + esc(u.name) + '" list="dlAll" aria-label="Name">' + nameWarn + '</td>' +
        '<td><input type="email" class="em" data-f="email" value="' + esc(u.email) + '" aria-label="Email"></td>' +
        '<td class="c"><input type="checkbox" class="chk" data-f="active"' + (u.active ? ' checked' : '') + ' aria-label="Active"></td>' +
        '<td class="c"><input type="checkbox" class="chk" data-f="admin"' + (u.admin ? ' checked' : '') + ' aria-label="Admin"></td>' +
        '<td><select data-f="scope" aria-label="Data scope"' + (u.admin ? ' disabled' : '') + '>' + ACC.scopes.map(s => '<option value="' + s + '"' + ((u.admin ? 'all' : u.scope) === s ? ' selected' : '') + '>' + s[0].toUpperCase() + s.slice(1) + '</option>').join('') + '</select></td>' +
        P.map(p => '<td class="c"><input type="checkbox" class="chk" data-p="' + p.key + '"' + (u.admin || u.perms[p.key] ? ' checked' : '') + (u.admin ? ' disabled' : '') + ' aria-label="' + esc(p.label) + '"></td>').join('') +
        '<td class="small" style="white-space:nowrap">' + (u.mustChange ? '<span class="st warn">Temporary</span>' : u.hasPassword ? '<span class="st good">Set</span>' : '<span class="st bad">None</span>') + ' <button class="btn sm rq-act" data-reset="' + esc(u.email) + '">Reset</button></td>' +
        '<td class="small" style="white-space:nowrap">' + (u.lastLogin ? fmtDT(u.lastLogin) : '<span class="muted">never</span>') + '</td>' +
        '<td class="rq-act">' + (key(u.email) === key(ME.email) ? '' : '<button class="btn sm danger" data-del="' + esc(u.email) + '">Remove</button>') + '</td></tr>';
    });
    $('#accTbl').innerHTML = h + '</tbody>';
    const live = ACC.users.filter(u => !u.removed), gone = ACC.users.length - live.length;
    $('#accCap').textContent = live.length + ' people · ' + live.filter(u => u.active).length + ' active · ' + live.filter(u => u.admin).length + ' admin(s)' + (gone ? ' · ' + gone + ' removed (kept on file)' : '') +
      (ACC.breakGlass ? ' · Break-glass admin sign-in (server setting): ' + ACC.breakGlass : '');
    markDirty(false);
  }
  function markDirty(on) { ACC_DIRTY = on; $('#accSave').disabled = !on; $('#accUndo').disabled = !on; }
  function accChanged(e) {
    const tr = e.target.closest('tr[data-email]'); if (!tr) return;
    tr.classList.add('dirty');
    if (e.target.dataset.f === 'admin') {
      const a = e.target.checked;
      tr.querySelectorAll('[data-p]').forEach(c => { c.disabled = a; if (a) c.checked = true; });
      const s = tr.querySelector('[data-f=scope]'); s.disabled = a; if (a) s.value = 'all';
    }
    if (e.target.dataset.p === 'act.approve' && e.target.checked) { const s = tr.querySelector('[data-f=scope]'); if (s.value !== 'all') { s.value = 'all'; toast('A checker needs data scope All – scope set to All.'); } }
    if (e.target.dataset.f === 'scope' && e.target.value !== 'all') { const a = tr.querySelector('[data-p="act.approve"]'); if (a && a.checked) { a.checked = false; toast('Approve needs data scope All – Approve unticked.'); } }
    if (e.target.dataset.f === 'active') tr.classList.toggle('off', !e.target.checked);
    markDirty(true);
  }
  async function saveAccess() {
    const rows = $$('#accTbl tr[data-email]:not([data-removed])').map(tr => {
      const g = f => tr.querySelector('[data-f="' + f + '"]');
      const perms = {}; tr.querySelectorAll('[data-p]').forEach(c => { if (c.checked) perms[c.dataset.p] = true; });
      return {email: tr.dataset.email, newEmail: g('email').value.trim(), name: g('name').value.trim(), active: g('active').checked, admin: g('admin').checked, scope: g('scope').value, perms};
    });
    try { ACC = await api('PUT', 'api/access/users', {users: rows}); renderAccess(); toast('Access saved. It applies from each person\'s next page load.'); }
    catch (e) { showMsg('Not saved', '<p>' + esc(e.message) + '</p>'); }
  }
  function pwMessage(name, email, pw) {
    const link = location.origin + location.pathname;
    const text = 'Job Report Checklist – your sign-in\nLink: ' + link + '\nEmail: ' + email + '\nTemporary password: ' + pw + '\nYou will be asked to set your own password when you first sign in.';
    showMsg('Temporary password for ' + name, '<p>Share this with <b>' + esc(name) + '</b>. It is shown only now; they set their own password at first sign-in.</p><div class="pwbox">' + esc(pw) + '</div><p class="small muted" style="white-space:pre-line;margin-top:10px">' + esc(text) + '</p>', text);
  }
  async function addPerson() {
    const err = m => { $('#nErr').textContent = m; };
    const name = $('#nName').value.replace(/\s+/g, ' ').trim(), email = $('#nEmail').value.trim();
    if (!name) return err('Enter the name.'); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Enter a valid email.');
    if (ACC_DIRTY && !(await askConfirm('You have unsaved changes in the matrix. Adding a person reloads the matrix and drops them. Continue?', 'Continue'))) return;
    err('');
    try {
      const r = await api('POST', 'api/access/users', {name, email, scope: $('#nScope').value});
      $('#nName').value = ''; $('#nEmail').value = '';
      await loadAccess(true); pwMessage(name, r.email, r.password);
    } catch (e) { err(e.message); }
  }
  async function resetPw(email) {
    const u = ACC.users.find(x => x.email === email);
    if (!(await askConfirm('Reset the password of ' + (u ? u.name : email) + '? Their current password stops working and they are signed out.', 'Reset password'))) return;
    try { const r = await api('POST', 'api/access/reset', {email}); await loadAccess(true); pwMessage(u ? u.name : email, r.email, r.password); }
    catch (e) { showMsg('Not reset', '<p>' + esc(e.message) + '</p>'); }
  }
  async function delPerson(email) {
    const u = ACC.users.find(x => x.email === email);
    if (!(await askConfirm('Remove ' + (u ? u.name : email) + ' (' + email + ')? They can no longer sign in. Nothing is deleted: the person stays on file (Users sheet in Drive) and can be restored.', 'Remove'))) return;
    try { ACC = await api('DELETE', 'api/access/users?email=' + encodeURIComponent(email)); renderAccess(); toast('Removed – kept on file.'); }
    catch (e) { showMsg('Not removed', '<p>' + esc(e.message) + '</p>'); }
  }
  async function restorePerson(email) {
    try { ACC = await api('POST', 'api/access/restore', {email}); renderAccess(); toast('Restored. They can sign in with their earlier password.'); }
    catch (e) { showMsg('Not restored', '<p>' + esc(e.message) + '</p>'); }
  }

  /* ---------- data: the Drive workbook (admins) ---------- */
  let DATA = null;
  async function loadData() {
    if (!ME.admin) return;
    try { DATA = await api('GET', 'api/data'); renderData(); }
    catch (e) { $('#dataInfo').innerHTML = '<span class="st bad">Could not read: ' + esc(e.message) + '</span>'; }
  }
  function renderData() {
    const d = DATA, b = d.backup;
    $('#dataInfo').innerHTML = '<table class="dt"><tbody>' + [
      ['File', '<b>' + esc(d.name) + '</b>' + (d.link ? ' · <a href="' + esc(d.link) + '" target="_blank" rel="noopener">Open in Google Drive ↗</a>' : '')],
      ['Checklist', 'as of <b>' + esc(d.asof || '—') + '</b> · ' + fmtN(d.tasks) + ' task rows in Master · source: ' + esc(d.source || '—')],
      ['Last saved to Drive', (d.savedAt ? fmtDT(d.savedAt) : 'no change saved since the server started') + (d.pending ? ' · <span class="st warn">saving…</span>' : '') + (d.saveError ? ' · <span class="st bad">' + esc(d.saveError) + '</span>' : '')],
      ['Drive version', fmtDT(d.modifiedTime)],
      ['Last backup copy', b ? esc(b.name) + ' · ' + fmtDT(b.at) + (b.link ? ' · <a href="' + esc(b.link) + '" target="_blank" rel="noopener">open ↗</a>' : '') : 'none yet – made with the first save of each day']
    ].map(r => '<tr><td style="width:180px"><b>' + r[0] + '</b></td><td>' + r[1] + '</td></tr>').join('') + '</tbody></table>';
  }
  async function reloadDrive() {
    const btn = $('#dReload'); btn.disabled = true;
    try { DATA = await api('POST', 'api/data/reload'); renderData(); toast('Reloaded from Drive. Reload this page to see the newest data.'); $('#srcVerNote').hidden = false; }
    catch (e) { showMsg('Not reloaded', '<p>' + esc(e.message) + '</p>'); }
    finally { btn.disabled = false; }
  }
  // Reads an upload: a dashboard HTML (embedded data), a checklist workbook (Daily/Weekly/Monthly/Yearly Task List
  // sheets) or a Master / import-layout sheet (header row starting with "Action").
  function readUpload(file) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onerror = () => reject(new Error('Could not read the file'));
      if (/\.html?$/i.test(file.name)) {
        rd.onload = () => { try {
          const line = String(rd.result).split(/\r?\n/).find(l => l.startsWith('const SNAP = {'));
          if (!line) throw new Error('This HTML has no embedded checklist data.');
          resolve({snap: JSON.parse(line.slice('const SNAP = '.length).replace(/;\s*$/, '')), fileName: file.name});
        } catch (e) { reject(e); } };
        return rd.readAsText(file);
      }
      rd.onload = () => { try {
        const wb = XLSX.read(new Uint8Array(rd.result), {type: 'array', cellDates: false});
        const fsheets = FK.map(k => FREQ[k].sheet);
        const m = file.name.match(/(\d{2}-\d{2}-\d{4})/), asof = m ? m[1] : ddmmyyyy(new Date(file.lastModified));
        if (fsheets.every(n => wb.Sheets[n])) {
          const snap = {asof, source: file.name};
          fsheets.forEach(n => { snap[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], {header: 1, raw: true, defval: null, blankrows: true}); });
          const vd = wb.Sheets['Validation Data'];
          snap.doers = vd ? XLSX.utils.sheet_to_json(vd, {header: 1, raw: true, defval: null, blankrows: false}).slice(2).map(r => r[1]).filter(x => !blank(x)) : [];
          return resolve({snap, fileName: file.name});
        }
        for (const n of ['Master', 'Import', 'Current Tasks'].concat(wb.SheetNames)) {
          const ws = wb.Sheets[n]; if (!ws) continue;
          const aoa = XLSX.utils.sheet_to_json(ws, {header: 1, raw: true, defval: null, blankrows: false});
          const h = aoa.findIndex(r => key((r || [])[0]) === 'action' || (n === 'Current Tasks' && key((r || [])[2]) === 'frequency'));
          if (h < 0) continue;
          let rows = aoa.slice(h);
          if (n === 'Current Tasks') { const st = rows[0].indexOf('Status'); rows = [['Action'].concat(rows[0].slice(2, 30))].concat(rows.slice(1).filter(r => r[st] !== 'Deleted').map(r => [''].concat(r.slice(2, 30)))); }
          const ds = wb.Sheets.Doers ? XLSX.utils.sheet_to_json(wb.Sheets.Doers, {header: 1, raw: false, blankrows: false}).map(r => r[0]).filter(x => x && !/^doers?$/i.test(String(x).trim())) : [];
          return resolve({rows, doers: ds, asof, fileName: file.name});
        }
        throw new Error('No checklist found: expected the Daily / Weekly / Monthly / Yearly Task List sheets, or a sheet whose header row starts with "Action".');
      } catch (e) { reject(e); } };
      rd.readAsArrayBuffer(file);
    });
  }
  async function uploadChecklist(file) {
    let payload;
    try { payload = await readUpload(file); } catch (e) { return showMsg('Cannot use this file', '<p>' + esc(e.message) + '</p>'); }
    let dry;
    try { dry = await api('POST', 'api/data/checklist', Object.assign({dry: true}, payload)); }
    catch (e) { return showMsg('Cannot use this file', '<p>' + esc(e.message) + '</p>'); }
    const f = o => ['Daily', 'Weekly', 'Monthly', 'Yearly'].map(k => k + ' ' + fmtN(o[k])).join(' · ');
    const msg = 'Replace the checklist in Drive with "' + file.name + '"?\n\nNow: as of ' + (dry.nowAsof || '—') + ' · ' + fmtN(dry.nowTasks) + ' tasks (' + f(dry.now) + ')\nNew: as of ' + (dry.asof || '—') + ' · ' + fmtN(dry.tasks) + ' tasks (' + f(dry.next) + ')\n\n' +
      'A copy of the current workbook is saved in the same Drive folder first. Users, requests, the change log and the audit log are kept.' +
      (dry.approvedChanges ? ' ' + dry.approvedChanges + ' approved change record(s) belong to the current version; after the upload you will be offered to re-apply them.' : '');
    if (!(await askConfirm(msg, 'Upload to Drive'))) return;
    const btn = $('#dUpBtn'); btn.disabled = true; toast('Uploading to Drive…');
    try {
      const r = await api('POST', 'api/data/checklist', payload);
      DATA = r.file; renderData();
      showMsg('Checklist uploaded', '<p>The checklist as of <b>' + esc(r.asof) + '</b> (' + fmtN(r.tasks) + ' tasks) is now in Drive. A copy of the previous workbook was saved first.</p><p>Reload the page to work on the new version. Everyone else sees “The checklist was updated in Drive – reload”.</p>');
    } catch (e) { showMsg('Upload failed', '<p>' + esc(e.message) + '</p><p class="muted small">Nothing was replaced.</p>'); }
    finally { btn.disabled = false; }
  }
  async function exportAccess() {
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Access Matrix');
    const P = ACC.perms;
    hdrRow(ws.addRow(['Name', 'Email', 'Active', 'Admin', 'Data scope'].concat(P.map(p => p.group + ': ' + p.label), ['Password', 'Last sign-in'])));
    ACC.users.forEach(u => ws.addRow([u.name, u.email, u.active ? 'Yes' : 'No', u.admin ? 'Yes' : 'No', u.admin ? 'all' : u.scope].concat(P.map(p => (u.admin || u.perms[p.key]) ? '✓' : ''),
      [u.mustChange ? 'Temporary' : u.hasPassword ? 'Set' : 'None', u.lastLogin ? new Date(u.lastLogin) : null])));
    ws.columns.forEach((c, i) => { c.width = i === 0 ? 24 : i === 1 ? 32 : 11; });
    ws.views = [{state: 'frozen', ySplit: 1, xSplit: 2}];
    ws.pageSetup = {orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1'};
    await dl(wb, 'Checklist_Access_Matrix_' + ddmmyyyy(new Date()) + '.xlsx');
  }

  /* ---------- sorting and filtering on every table ---------- */
  const SORTS = {}, FILTERS = {};
  let enhancing = false, obs = null;
  function tid(tb) {
    if (tb.id) return tb.id;
    const sec = tb.closest('section.tab'), all = sec ? $$('#' + sec.id + ' table.dt') : [];
    return (sec ? sec.id : 'x') + ':' + all.indexOf(tb);
  }
  function cellVal(td) {
    if (!td) return '';
    const c = td.querySelector('input[type=checkbox]'); if (c) return c.checked ? 1 : 0;
    const f = td.querySelector('input,select'); if (f) return f.value;
    return td.textContent.trim();
  }
  function sortKey(v) {
    if (typeof v === 'number') return [0, v];
    const s = String(v).trim();
    let m = /^(\d{2})[-/](\d{2})[-/](\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?/.exec(s);
    if (m) return [0, +(m[3] + m[2] + m[1] + String(m[4] || 0).padStart(2, '0') + (m[5] || '00'))];
    const n = s.replace(/[,%₹\s]/g, '');
    if (n !== '' && /^-?\d+(\.\d+)?$/.test(n)) return [0, +n];
    return [1, s.toLowerCase()];
  }
  function cmpVals(a, b) {
    const x = sortKey(a), y = sortKey(b);
    if (x[0] !== y[0]) return x[0] - y[0];
    return x[0] === 0 ? x[1] - y[1] : x[1].localeCompare(y[1], 'en', {numeric: true});
  }
  function headCells(tb) {
    const tr = tb.tHead && tb.tHead.rows[tb.tHead.rows.length - 1]; if (!tr) return [];
    return Array.from(tr.cells);
  }
  function colIndex(tb, th) {
    // works for two-row headers (rowspans): map the clicked cell to its column position
    const rows = tb.tHead.rows, grid = [];
    for (let r = 0; r < rows.length; r++) {
      let c = 0;
      for (const cell of rows[r].cells) {
        while (grid[r] && grid[r][c]) c++;
        for (let i = 0; i < (cell.rowSpan || 1); i++) for (let j = 0; j < (cell.colSpan || 1); j++) { (grid[r + i] = grid[r + i] || [])[c + j] = cell; }
        if (cell === th) return c;
        c += cell.colSpan || 1;
      }
    }
    return -1;
  }
  function applySort(tb) {
    const s = SORTS[tid(tb)]; if (!s || !tb.tBodies[0]) return;
    const rows = Array.from(tb.tBodies[0].rows);
    if (rows.length < 2) return;
    rows.sort((a, b) => cmpVals(cellVal(a.cells[s.col]), cellVal(b.cells[s.col])) * s.dir);
    const tbody = tb.tBodies[0]; rows.forEach(r => tbody.appendChild(r));
    Array.from(tb.querySelectorAll('th.srt')).forEach(th => { if (colIndex(tb, th) === s.col) th.dataset.dir = s.dir; else delete th.dataset.dir; });
  }
  function applyFilter(tb) {
    const q = key(FILTERS[tid(tb)] || ''); let shown = 0, total = 0;
    if (!tb.tBodies[0]) return;
    Array.from(tb.tBodies[0].rows).forEach(r => {
      total++;
      const txt = q ? key(r.textContent + ' ' + Array.from(r.querySelectorAll('input:not([type=checkbox]),select')).map(i => i.value).join(' ')) : '';
      const ok = !q || txt.includes(q); r.hidden = !ok; if (ok) shown++;
    });
    const cnt = tb.__tools && tb.__tools.querySelector('.muted');
    if (cnt) cnt.textContent = q ? shown + ' of ' + total + ' row(s)' : '';
  }
  function wants(tb) {
    if (tb.closest('dialog') || tb.closest('.rp')) return {sort: !!tb.closest('dialog'), filter: false};
    if (tb.id === 'tTbl' || tb.closest('#dueList')) return {sort: true, filter: false};   // these already have their own filters
    if (tb.closest('#tab-data')) return {sort: false, filter: false};                     // short information tables
    return {sort: true, filter: true};
  }
  function enhance(tb) {
    const w = wants(tb);
    if (w.sort && tb.tHead && !tb.tHead.dataset.enh) {
      tb.tHead.dataset.enh = '1';
      if (!tb.querySelector('th.sortable')) Array.from(tb.tHead.querySelectorAll('th')).forEach(th => { if ((th.colSpan || 1) === 1 && th.textContent.trim()) th.classList.add('srt'); });
    }
    if (w.filter && tb.tBodies[0] && tb.tBodies[0].rows.length > 1) {
      const host = tb.closest('.tbl-wrap,.acc-wrap') || tb;
      let tools = host.previousElementSibling;
      if (!tools || !tools.classList.contains('tbl-tools')) {
        tools = document.createElement('div'); tools.className = 'tbl-tools';
        tools.innerHTML = '<input type="search" placeholder="Filter these rows…" aria-label="Filter rows"><span class="muted"></span>';
        host.parentNode.insertBefore(tools, host);
        const k = tid(tb);
        tools.querySelector('input').value = FILTERS[k] || '';
        tools.querySelector('input').addEventListener('input', e => { FILTERS[k] = e.target.value; const t = tools.nextElementSibling; const table = t.matches('table') ? t : t.querySelector('table.dt'); if (table) applyFilter(table); });
      }
      tb.__tools = tools;
    }
    applySort(tb);
    if (w.filter) applyFilter(tb);
  }
  function enhanceAll() {
    enhancing = true;
    try { $$('table.dt').forEach(enhance); }
    finally { if (obs) obs.takeRecords(); enhancing = false; }
  }
  function startTables() {
    document.addEventListener('click', e => {
      const th = e.target.closest('table.dt th.srt'); if (!th || e.target.closest('input,select,button')) return;
      const tb = th.closest('table'), col = colIndex(tb, th); if (col < 0) return;
      const k = tid(tb), cur = SORTS[k];
      SORTS[k] = {col, dir: cur && cur.col === col ? -cur.dir : 1};
      enhancing = true; try { applySort(tb); } finally { obs.takeRecords(); enhancing = false; }
    });
    obs = new MutationObserver(() => { if (enhancing) return; cancelAnimationFrame(startTables._r); startTables._r = requestAnimationFrame(enhanceAll); });
    obs.observe(document.body, {childList: true, subtree: true});
    enhanceAll();
  }

  /* ---------- print header ---------- */
  function fillPrintHead() {
    const t = ($('nav.tabs button[aria-selected="true"]') || {}).dataset;
    const tab = t && t.tab || 'ov';
    $('#phT').textContent = 'Job Report Checklist — ' + (TAB_NAME[tab] || '');
    const f = [];
    const add = (lab, sel) => { const el = $(sel); if (el && el.value && el.selectedIndex !== undefined && el.options[el.selectedIndex]) f.push(lab + ': ' + el.options[el.selectedIndex].text); };
    if (tab === 'ov' || tab === 'wl') { add('Department', '#fDept'); add('Reporting to', '#fRep'); add('Company', '#fCo'); add('Frequency', '#fFreq'); }
    if (tab === 'due') { f.push('Date: ' + ddmmyyyy(parseIso($('#dDate').value || isoDate(new Date())))); add('View', '#dView'); add('Doer', '#dDoer'); add('Reporting to', '#dRep'); }
    if (tab === 'tm') { add('Frequency', '#tFreq'); add('Doer', '#tDoer'); add('Company', '#tCo'); if ($('#tQ').value) f.push('Search: ' + $('#tQ').value); }
    if (tab === 'log') add('Action', '#lAct');
    if (tab === 'req') { add('Status', '#qSt'); add('Type', '#qKind'); add('Requested by', '#qBy'); }
    if (tab === 'rep') { add('Doer', '#rDoer'); }
    $('#phS').textContent = 'Checklist as of ' + (SRC && SRC.asof || '—') + (f.length ? ' · ' + f.join(' · ') : '');
    $('#phR').innerHTML = 'Printed ' + esc(fmtDT(new Date().toISOString())) + '<br>by ' + esc(ME ? ME.name : '');
  }

  /* ---------- start ---------- */
  function showLoadError(msg, hint) {
    const box = document.createElement('div');
    box.className = 'notice';
    box.style.cssText = 'margin:16px auto;max-width:900px;border:1px solid var(--bad);background:var(--bad-bg);color:var(--ink);padding:14px 16px;border-radius:8px';
    box.innerHTML = '<b>The checklist could not be loaded.</b><br>' + esc(msg) + (hint ? '<br>' + esc(hint) : '') +
      '<br><button class="btn sm" style="margin-top:10px" onclick="location.reload()">Try again</button>';
    document.body.insertBefore(box, $('main'));
  }
  addHtml();
  patch();
  const hdrMeta = $('header .meta');
  if (hdrMeta && !$('#srcVerNote')) {
    const n = document.createElement('div'); n.id = 'srcVerNote'; n.hidden = true;
    n.innerHTML = '<a href="#" onclick="location.reload();return false" style="color:inherit;text-decoration:underline">The checklist was updated in Drive – reload</a>';
    hdrMeta.appendChild(n);
  }
  setSync('busy', 'Loading checklist…');
  api('GET', 'api/source').then(m => {
    ME = m.me; PROFILES = m.profiles || [];
    window.__CHECKLIST_CAN_WRITE = !!m.canWrite; window.__CHECKLIST_VER = m.ver;
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}   // the server is the record; never start from a browser copy
    applyPerms();
    const {src, problems} = toSrc(m);
    SNAP = src;
    init(SNAP);
    snapshotApproved();
    if (problems.length && isWriter()) { console.warn('Checklist rows with problems:', problems); toast(problems.length + ' row(s) in the Master sheet have problems – see the browser console (F12).'); }
    startShared();
    startTables();
    loadReqs(); setInterval(loadReqs, 30000);
    if (ME.admin) loadAccess();
    relabel();
  }).catch(e => { console.error(e); setSync('warn', 'Not loaded'); showLoadError(e.message, e.hint); });
})();
