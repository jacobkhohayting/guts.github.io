/* Organizer dashboard (admin.html). Shared helpers live in common.js. */
(function () {
  'use strict';

  const G = window.Guts;
  const $ = (s) => document.querySelector(s);
  const KEY = 'contest.admin.password';
  const REFRESH_MS = 15000;

  let data = null;        // last admin response
  let sel = null;         // data.selected (the contest being shown)
  let wanted = G.urlParam('contest');
  let loading = false;

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function setLoginError(msg) {
    const e = $('#login-error');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  async function load() {
    const password = sessionStorage.getItem(KEY);
    if (!password) { G.showView('login'); return; }
    if (loading) return;
    loading = true;
    try {
      const d = await G.api({ action: 'admin', password, contest: wanted });
      if (!d.ok) {
        if (d.auth) {
          sessionStorage.removeItem(KEY);
          G.showView('login');
          setLoginError(d.error);
          return;
        }
        throw new Error(d.error || 'The server returned an error.');
      }
      data = d;
      sel = d.selected;
      wanted = sel ? sel.id : '';
      render();
      G.showView('dash');
      ['#contest-select', '#auto-refresh-wrap', '#refresh-btn', '#logout-btn'].forEach((s) => { $(s).hidden = false; });
    } catch (err) {
      G.toast(err.message, 'error');
    } finally {
      loading = false;
    }
  }

  // Scores are recomputed here from the Correct flags, so manual overrides in the sheet count.
  function compute() {
    const ptsOf = {};
    sel.problems.forEach((q) => { ptsOf[q.round + ':' + q.n] = q.points; });
    const teams = new Map();
    const blank = (name) => ({ name, score: 0, rounds: {}, last: 0, maxRound: 0, members: [], email: '' });
    sel.teams.forEach((t) => teams.set(norm(t.name), Object.assign(blank(t.name), { members: t.members || [], email: t.email || '' })));
    sel.submissions.forEach((s) => {
      const k = norm(s.team);
      if (!teams.has(k)) teams.set(k, blank(s.team));
      const t = teams.get(k);
      let p = 0;
      s.correct.forEach((c, i) => { if (c) p += ptsOf[s.round + ':' + (i + 1)] || 0; });
      s.points = p;
      t.rounds[s.round] = { correct: s.correct, points: p };
      t.score += p;
      t.last = Math.max(t.last, s.time || 0);
      t.maxRound = Math.max(t.maxRound, s.round);
    });
    const list = [...teams.values()].sort((a, b) =>
      b.score - a.score || (a.last || Infinity) - (b.last || Infinity) || a.name.localeCompare(b.name));
    return { list, ptsOf };
  }

  function render() {
    G.fillContestSelect($('#contest-select'), data.contests, wanted);
    renderContests();
    if (!sel) {
      $('#contest-name').textContent = data.siteName;
      document.title = data.siteName + ' — organizers';
      ['#stats', '#scoreboard', '#submissions', '#problem-list'].forEach((s) => { $(s).textContent = ''; });
      $('#stats').appendChild(el('div', 'stat', 'No contests yet — add one in the Contests tab of the sheet.'));
      return;
    }
    $('#contest-name').textContent = sel.title;
    document.title = sel.title + ' — organizers';
    $('#lb-link').href = 'leaderboard.html?contest=' + encodeURIComponent(sel.id);
    const { list } = compute();
    renderStats(list);
    renderScoreboard(list);
    renderSubmissions();
    renderProblems();
  }

  function renderStats(list) {
    const box = $('#stats');
    box.textContent = '';
    const stateLabel = { unscheduled: 'Not scheduled', before: 'Waiting to start', running: 'Running', ended: 'Ended' }[sel.state] || sel.state;
    const finished = list.filter((t) => t.maxRound >= sel.totalRounds).length;
    const people = list.reduce((n, t) => n + (t.members || []).length, 0);
    [
      ['Status', stateLabel],
      ['Starts', G.fmtDate(sel.startTime)],
      ['Ends', G.fmtDate(sel.endTime)],
      ['Passcode', sel.passcode || 'none'],
      ['Teams / people', `${list.length} / ${people}`],
      ['Submissions', String(sel.submissions.length)],
      ['Teams finished', String(finished)],
      ['Public leaderboard', sel.showLeaderboard ? 'shown' : 'hidden'],
    ].forEach(([label, value]) => {
      const s = el('div', 'stat');
      s.appendChild(el('div', 'label', label));
      s.appendChild(el('div', 'value', value));
      box.appendChild(s);
    });
  }

  function renderScoreboard(list) {
    const table = $('#scoreboard');
    table.textContent = '';
    const thead = el('thead');
    const hr = el('tr');
    hr.appendChild(el('th', 'num', '#'));
    hr.appendChild(el('th', null, 'Team'));
    hr.appendChild(el('th', null, 'Members'));
    hr.appendChild(el('th', null, 'Email'));
    hr.appendChild(el('th', 'num', 'Score'));
    hr.appendChild(el('th', 'num', 'On round'));
    for (let r = 1; r <= sel.totalRounds; r++) hr.appendChild(el('th', 'num', 'R' + r));
    hr.appendChild(el('th', null, 'Last submission'));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    list.forEach((t, i) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'num', String(i + 1)));
      tr.appendChild(el('td', null, t.name));
      tr.appendChild(el('td', null, (t.members || []).join(', ') || '—'));
      tr.appendChild(el('td', null, t.email || '—'));
      tr.appendChild(el('td', 'num', String(t.score)));
      tr.appendChild(el('td', 'num', t.maxRound >= sel.totalRounds ? 'Done' : String(t.maxRound + 1)));
      for (let r = 1; r <= sel.totalRounds; r++) {
        const td = el('td', 'num');
        const rr = t.rounds[r];
        if (!rr) {
          td.appendChild(el('span', 'mark-none', '·'));
        } else {
          const marks = el('span', 'marks');
          rr.correct.forEach((c) => marks.appendChild(el('span', c ? 'mark-ok' : 'mark-bad', c ? '✓' : '✗')));
          td.appendChild(marks);
          td.appendChild(el('span', 'muted', ' ' + rr.points));
        }
        tr.appendChild(td);
      }
      tr.appendChild(el('td', null, t.last ? G.fmtTime(t.last) : '—'));
      tbody.appendChild(tr);
    });
    if (!list.length) {
      const tr = el('tr');
      const td = el('td', 'muted', 'No teams yet.');
      td.colSpan = 7 + sel.totalRounds;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  function renderSubmissions() {
    const table = $('#submissions');
    table.textContent = '';
    const K = data.problemsPerRound;
    $('#sub-count').textContent = sel.submissions.length ? `(${sel.submissions.length})` : '';

    const thead = el('thead');
    const hr = el('tr');
    ['Time', 'Elapsed', 'Team', 'Round'].forEach((h) => hr.appendChild(el('th', h === 'Round' || h === 'Elapsed' ? 'num' : null, h)));
    for (let i = 1; i <= K; i++) hr.appendChild(el('th', null, 'Answer ' + i));
    hr.appendChild(el('th', 'num', 'Points'));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    const rows = sel.submissions.slice().sort((a, b) => (b.time || 0) - (a.time || 0));
    rows.forEach((s) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, G.fmtTime(s.time)));
      tr.appendChild(el('td', 'num', s.elapsed != null ? s.elapsed + ' min' : ''));
      tr.appendChild(el('td', null, s.team));
      tr.appendChild(el('td', 'num', String(s.round)));
      for (let i = 0; i < K; i++) {
        const td = el('td');
        const wrap = el('div', 'ans');
        wrap.appendChild(el('span', s.correct[i] ? 'mark-ok' : 'mark-bad', s.correct[i] ? '✓' : '✗'));
        const math = el('span');
        G.renderAnswer(math, s.answers[i], '(blank)');
        wrap.appendChild(math);
        td.appendChild(wrap);
        tr.appendChild(td);
      }
      tr.appendChild(el('td', 'num', String(s.points)));
      tbody.appendChild(tr);
    });
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'muted', 'No submissions yet.');
      td.colSpan = 5 + K;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  function renderProblems() {
    const box = $('#problem-list');
    box.textContent = '';
    const probs = sel.problems.slice().sort((a, b) => a.round - b.round || a.n - b.n);
    probs.forEach((q) => {
      const item = el('div', 'pl-item');
      item.appendChild(el('div', null, `Round ${q.round}, Problem ${q.n} — ${q.points} pt${q.points === 1 ? '' : 's'}`)).style.fontWeight = '600';
      const text = el('div', 'problem-text');
      G.renderRichText(text, q.text);
      item.appendChild(text);
      if (q.image) {
        const img = el('img', 'problem-image');
        img.src = q.image;
        img.alt = 'Figure';
        item.appendChild(img);
      }
      const ans = el('div', 'muted');
      ans.appendChild(document.createTextNode('Accepted answer(s): '));
      ans.appendChild(el('code', null, q.answers || '(none!)'));
      item.appendChild(ans);
      box.appendChild(item);
    });
    if (!probs.length) box.appendChild(el('p', 'muted', 'No problems for this contest in the Problems tab.'));
  }

  function renderContests() {
    const table = $('#contests-table');
    table.textContent = '';
    const thead = el('thead');
    const hr = el('tr');
    ['ID', 'Title', 'Passcode', 'Status', 'Starts', 'Minutes', 'Rounds', 'Teams', 'Submissions', 'Leaderboard'].forEach((h) => hr.appendChild(el('th', null, h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    data.contests.forEach((c) => {
      const tr = el('tr');
      const idTd = el('td');
      const a = el('a', null, c.id);
      a.href = '?contest=' + encodeURIComponent(c.id);
      a.addEventListener('click', (ev) => { ev.preventDefault(); wanted = c.id; load(); });
      idTd.appendChild(a);
      tr.appendChild(idTd);
      tr.appendChild(el('td', null, c.title));
      tr.appendChild(el('td', null, c.passcode || '—'));
      tr.appendChild(el('td', null, { unscheduled: 'Not scheduled', before: 'Waiting', running: 'Running', ended: 'Ended' }[c.state] || c.state));
      tr.appendChild(el('td', null, G.fmtDate(c.startTime)));
      tr.appendChild(el('td', 'num', String(c.durationMinutes)));
      tr.appendChild(el('td', 'num', String(c.totalRounds)));
      tr.appendChild(el('td', 'num', String(c.teams)));
      tr.appendChild(el('td', 'num', String(c.submissions)));
      tr.appendChild(el('td', null, c.showLeaderboard ? 'shown' : 'hidden'));
      tbody.appendChild(tr);
    });
    if (!data.contests.length) {
      const tr = el('tr');
      const td = el('td', 'muted', 'No contests in the Contests tab.');
      td.colSpan = 10;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  function bind() {
    $('#login-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const pw = $('#password-input').value;
      if (!pw) { setLoginError('Enter the admin password.'); return; }
      sessionStorage.setItem(KEY, pw);
      setLoginError('');
      load();
    });
    $('#contest-select').addEventListener('change', (ev) => { wanted = ev.target.value; load(); });
    $('#refresh-btn').addEventListener('click', load);
    $('#logout-btn').addEventListener('click', () => {
      sessionStorage.removeItem(KEY);
      data = null;
      sel = null;
      ['#contest-select', '#auto-refresh-wrap', '#refresh-btn', '#logout-btn'].forEach((s) => { $(s).hidden = true; });
      G.showView('login');
    });
  }

  function init() {
    bind();
    if (!G.configured) { G.showView('setup'); return; }
    load();
    setInterval(() => G.paintTimer(sel), 250);
    setInterval(() => { if ($('#auto-refresh').checked && G.view() === 'dash') load(); }, REFRESH_MS);
  }

  init();
})();
