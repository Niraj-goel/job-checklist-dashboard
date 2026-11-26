/* ---------------- server adapter ----------------
   The dashboard was written to run as a Claude artifact and share changes through window.claude.use('db').
   This gives it the same calls, backed by the dashboard server (which saves them into the Drive workbook). */
(function(){
  "use strict";
  function apiErr(res, j){
    const e = new Error((j && j.error) || ('Server error ' + res.status));
    e.code = (j && j.code) || (res.status === 403 ? 'not_granted' : res.status === 413 ? 'quota_exceeded' : 'unavailable');
    return e;
  }
  async function call(method, url, body){
    const res = await fetch(url, {method, credentials: 'same-origin', cache: 'no-store',
      headers: body !== undefined ? {'content-type': 'application/json'} : {}, body: body !== undefined ? JSON.stringify(body) : undefined});
    let j = null; try { j = await res.json(); } catch(e) {}
    if (res.status === 401 || (j && j.code === 'must_change')) { location.reload(); throw apiErr(res, j); }
    if (!res.ok) throw apiErr(res, j);
    return j;
  }
  const snapOf = (id, data) => ({id, exists: data !== null && data !== undefined, data: () => data});

  let pollTimer = null, lastMetaJson = null, verWarned = false, saveWarned = '';
  const listeners = [];
  async function poll(){
    try {
      const m = await call('GET', 'api/db/meta');
      window.__CHECKLIST_STATUS = m;
      if (m.ver && window.__CHECKLIST_VER && m.ver !== window.__CHECKLIST_VER && !verWarned) {
        verWarned = true;
        const el = document.getElementById('srcVerNote'); if (el) el.hidden = false;
      }
      if (m.saveError && m.saveError !== saveWarned) {
        saveWarned = m.saveError;
        if (typeof setSync === 'function') setSync('warn', 'Not saved to Drive yet');
        if (typeof toast === 'function') toast(m.saveError);
      } else if (!m.saveError) saveWarned = '';
      const js = JSON.stringify(m.doc);
      if (js !== lastMetaJson) { lastMetaJson = js; listeners.forEach(l => l.next(snapOf('info', m.doc))); }
    } catch(e) { /* network blip: try again on the next tick */ }
  }

  const DB = {
    doc(p){
      return {
        set: body => call('PUT', 'api/db/doc?path=' + encodeURIComponent(p), body),
        delete: () => call('DELETE', 'api/db/doc?path=' + encodeURIComponent(p)),
        onSnapshot(next, error){
          if (p !== 'meta/info') throw new Error('Only meta/info can be watched');
          const l = {next, error}; listeners.push(l);
          lastMetaJson = null; poll();
          if (!pollTimer) pollTimer = setInterval(poll, 10000);
          return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
        }
      };
    },
    collection(c){
      return {get: async () => ({docs: (await call('GET', 'api/db/collection?c=' + encodeURIComponent(c))).docs.map(d => snapOf(d.id, d.data))})};
    }
  };
  const USER = {can: async () => !!window.__CHECKLIST_CAN_WRITE};

  window.claude = {
    use: async name => {
      if (name === 'db') return DB;
      if (name === 'user') return USER;
      return null;   // 'downloads' etc.: the page falls back to ordinary browser downloads
    }
  };
})();
