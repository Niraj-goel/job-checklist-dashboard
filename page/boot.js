  // Live start-up: load the checklist from the server (Job Checklist DB.xlsx in Drive), then join the shared store.
  // The workbook's Master sheet has one row per task in the "Export master" layout; it is rebuilt here into the
  // four frequency sheets the dashboard reads.
  function masterToSrc(m){
    const A = m.master || [];
    const h = A.findIndex(r => key((r || [])[0]) === 'action');
    const hdr = (A[h] || []).map(key), ix = n => hdr.indexOf(key(n)), get = (r, n) => { const i = ix(n); return i < 0 ? null : r[i]; };
    const src = {};
    FK.forEach(fk => { const f = FREQ[fk];
      src[f.sheet] = [['Date:- ' + (m.asof || '')], ['SL.NO.','DOER','DEPT.','REPORTING TO',f.title,'TASK ALIAS','Company','Cost Centre','Task Merged'].concat(f.cols)]; });
    const problems = [];
    for (let i = h + 1; i < A.length; i++) {
      const r = A[i] || []; if (r.every(blank)) continue;
      const fk = freqOf(get(r, 'Frequency'));
      if (!FREQ[fk]) { problems.push('row ' + (i + 1) + ': frequency "' + (get(r, 'Frequency') || '') + '"'); continue; }
      const b = buildSched(fk, {time: get(r, 'Daily Time'), wk: ['Mon','Tue','Wed','Thu','Fri','Sat'].map(n => isTick(get(r, n))),
        mdays: get(r, 'Monthly Due Day(s)'), ydays: FREQ.Y.cols.map(n => get(r, n))});
      if (b.err) problems.push('row ' + (i + 1) + ': ' + b.err);
      const sched = b.sched || FREQ[fk].cols.map(() => null);
      const sheet = src[FREQ[fk].sheet];
      sheet.push([sheet.length - 1, get(r, 'Doer'), get(r, 'Department'), get(r, 'Reporting To'), get(r, 'Task Description'),
        get(r, 'Task Alias'), get(r, 'Company'), get(r, 'Cost Centre'), null].concat(sched));
    }
    src.doers = m.doers || []; src.asof = m.asof || ''; src.source = m.source || ''; src.ver = m.ver || '';
    return {src, problems};
  }
  function showLoadError(msg, hint){
    const box = document.createElement('div');
    box.className = 'notice';
    box.style.cssText = 'margin:16px auto;max-width:900px;border:1px solid var(--bad);background:var(--bad-bg);color:var(--ink);padding:14px 16px;border-radius:8px';
    box.innerHTML = '<b>The checklist could not be loaded.</b><br>' + esc(msg) + (hint ? '<br>' + esc(hint) : '') +
      '<br><button class="btn sm" style="margin-top:10px" onclick="location.reload()">Try again</button>';
    document.body.insertBefore(box, document.body.children[1] || null);
  }
  const hdrMeta = document.querySelector('header .meta');
  if (hdrMeta && !document.getElementById('srcVerNote')) {
    const n = document.createElement('div'); n.id = 'srcVerNote'; n.hidden = true;
    n.innerHTML = '<a href="#" onclick="location.reload();return false" style="color:inherit;text-decoration:underline">The checklist was updated in Drive – reload</a>';
    hdrMeta.appendChild(n);
  }
  setSync('busy', 'Loading checklist…');
  fetch('/api/source', {cache: 'no-store', credentials: 'same-origin'})
    .then(r => r.json().then(j => { if (!r.ok) throw Object.assign(new Error(j.error || ('Server error ' + r.status)), {hint: j.hint}); return j; }))
    .then(m => {
      window.__CHECKLIST_CAN_WRITE = !!m.canWrite; window.__CHECKLIST_VER = m.ver;
      const {src, problems} = masterToSrc(m);
      SNAP = src;
      init(SNAP);
      if (problems.length) { console.warn('Checklist rows with problems:', problems); toast(problems.length + ' row(s) in the Master sheet have problems – see the browser console (F12).'); }
      startShared();
    })
    .catch(e => { console.error(e); setSync('warn', 'Not loaded'); showLoadError(e.message, e.hint); });
