/* Public leaderboard (leaderboard.html): rank, team, total score. Nothing else is sent to this page. */
(function () {
  'use strict';

  const G = window.Guts;
  const $ = (s) => document.querySelector(s);
  const REFRESH_MS = 20000;

  let contests = [];
  let current = null;     // contest id being shown
  let schedule = null;    // { state, startTime, endTime } of the shown contest, for the header clock
  let loading = false;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function setHeader(title) {
    $('#contest-name').textContent = title;
    document.title = title + ' — leaderboard';
  }

  async function load() {
    if (!current || loading) return;
    loading = true;
    const id = current;
    try {
      const d = await G.api({ action: 'leaderboard', contest: id }, 1);
      if (id !== current) return;   // the user switched contest meanwhile
      if (!d.ok) {
        if (d.hidden) {
          const c = contests.find((x) => x.id === id);
          $('#hidden-title').textContent = c ? c.title : 'Leaderboard';
          setHeader(c ? c.title : 'Leaderboard');
          G.showView('hidden');
          return;
        }
        throw new Error(d.error || 'The server returned an error.');
      }
      schedule = { state: d.state, startTime: d.startTime, endTime: d.endTime };
      render(d);
      G.showView('board');
    } catch (err) {
      if (G.view() === 'board') G.toast(err.message, 'error');
      else { $('#error-msg').textContent = err.message; G.showView('error'); }
    } finally {
      loading = false;
    }
  }

  function render(d) {
    setHeader(d.contestTitle);
    $('#board-title').textContent = d.contestTitle;
    const stateLabel = { unscheduled: 'Not scheduled yet', before: 'Starts ' + G.fmtDate(d.startTime), running: 'In progress', ended: 'Final' }[d.state] || '';
    $('#board-sub').textContent = stateLabel;
    $('#board-updated').textContent = 'Updated ' + G.fmtTime(Date.now());

    const table = $('#board');
    table.textContent = '';
    const thead = el('thead');
    const hr = el('tr');
    hr.appendChild(el('th', 'num', '#'));
    hr.appendChild(el('th', null, 'Team'));
    hr.appendChild(el('th', 'num', 'Score'));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    let rank = 0;
    let prevScore = null;
    d.rows.forEach((r, i) => {
      if (r.score !== prevScore) { rank = i + 1; prevScore = r.score; }   // ties share a rank
      const tr = el('tr', i < 3 && r.score > 0 ? 'top' : null);
      tr.appendChild(el('td', 'num', String(rank)));
      tr.appendChild(el('td', null, r.team));
      tr.appendChild(el('td', 'num score', String(r.score)));
      tbody.appendChild(tr);
    });
    if (!d.rows.length) {
      const tr = el('tr');
      const td = el('td', 'muted', 'No teams yet.');
      td.colSpan = 3;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  function choose(id) {
    current = id;
    schedule = null;
    try { history.replaceState(null, '', id ? '?contest=' + encodeURIComponent(id) : location.pathname); } catch (e) { /* ignore */ }
    G.showView('loading');
    load();
  }

  async function refreshContests() {
    const d = await G.api({ action: 'status' });
    if (!d.ok) throw new Error(d.error || 'The server returned an error.');
    contests = d.contests || [];
    if (!contests.length) { G.showView('empty'); return false; }
    const sel = $('#contest-select');
    G.fillContestSelect(sel, contests, current || G.urlParam('contest'));
    return true;
  }

  async function init() {
    $('#retry-btn').addEventListener('click', () => window.location.reload());
    $('#contest-select').addEventListener('change', (ev) => choose(ev.target.value));
    if (!G.configured) { G.showView('setup'); return; }
    try {
      if (!(await refreshContests())) return;
    } catch (err) {
      $('#error-msg').textContent = err.message;
      G.showView('error');
      return;
    }
    choose($('#contest-select').value);
    setInterval(() => G.paintTimer(schedule), 250);
    setInterval(load, REFRESH_MS);
    setInterval(() => { refreshContests().catch(() => {}); }, 120000);
  }

  init();
})();
