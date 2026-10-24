/* Organizer dashboard (admin.html). Shared helpers live in common.js. */
(function () {
  'use strict';

  const G = window.Guts;
  const $ = (s) => document.querySelector(s);
  const KEY = 'contest.admin.password';
  const REFRESH_MS = 15000;

  let data = null;
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
      const d = await G.api({ action: 'admin', password });
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
      render();
      G.showView('dash');
      $('#auto-refresh-wrap').hidden = false;
      $('#refresh-btn').hidden = false;
      $('#logout-btn').hidden = false;
    } catch (err) {
      G.toast(err.message, 'error');
    } finally {
      loading = false;
    }
  }

  // Scores are recomputed here from the Correct flags, so manual overrides in the sheet count.
  function compute() {
    const ptsOf = {};
    data.problems.forEach((q) => { ptsOf[q.round + ':' + q.n] = q.points; });
    const teams = new Map();
    const blank = (name) => ({ name, score: 0, rounds: {}, last: 0, maxRound: 0 });
    data.teams.forEach((t) => teams.set(norm(t.name), Object.assign(blank(t.name), { members: t.members || [], email: t.email || '' })));
    data.submissions.forEach((s) => {
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
    $('#contest-name').textContent = data.contestName;
    document.title = data.contestName + ' — organizers';
    const { list } = compute();
    renderStats(list);
    renderScoreboard(list);
    renderSubmissions();
    renderProblems();
  }

  function renderStats(list) {
    const box = $('#stats');
    box.textContent = '';
    const stateLabel = { unscheduled: 'Not scheduled', before: 'Waiting to start', running: 'Running', ended: 'Ended' }[data.state] || data.state;
    const finished = list.filter((t) => t.maxRound >= data.totalRounds).length;
    [
      ['Status', stateLabel],
      ['Starts', G.fmtDate(data.startTime)],
      ['Ends', G.fmtDate(data.endTime)],
      ['Teams', String(list.length)],
      ['Submissions', String(data.submissions.length)],
      ['Teams finished', String(finished)],
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
    for (let r = 1; r <= data.totalRounds; r++) hr.appendChild(el('th', 'num', 'R' + r));
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
      tr.appendChild(el('td', 'num', t.maxRound >= data.totalRounds ? 'Done' : String(t.maxRound + 1)));
      for (let r = 1; r <= data.totalRounds; r++) {
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
      td.colSpan = 7 + data.totalRounds;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  function renderSubmissions() {
    const table = $('#submissions');
    table.textContent = '';
    const K = data.problemsPerRound;
    $('#sub-count').textContent = data.submissions.length ? `(${data.submissions.length})` : '';

    const thead = el('thead');
    const hr = el('tr');
    ['Time', 'Elapsed', 'Team', 'Round'].forEach((h) => hr.appendChild(el('th', h === 'Round' || h === 'Elapsed' ? 'num' : null, h)));
    for (let i = 1; i <= K; i++) hr.appendChild(el('th', null, 'Answer ' + i));
    hr.appendChild(el('th', 'num', 'Points'));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    const rows = data.submissions.slice().sort((a, b) => (b.time || 0) - (a.time || 0));
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
        math.querySelectorAll('.katex-display').forEach((d) => { d.style.margin = '0'; d.style.textAlign = 'left'; });
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
    const probs = data.problems.slice().sort((a, b) => a.round - b.round || a.n - b.n);
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
    if (!probs.length) box.appendChild(el('p', 'muted', 'No problems found in the Problems tab.'));
  }

  function tick() {
    const timerEl = $('#timer');
    const labelEl = $('#timer-label');
    if (!data || !data.startTime) {
      timerEl.textContent = '--:--';
      labelEl.textContent = data && data.state === 'unscheduled' ? 'Not scheduled' : '';
      return;
    }
    const t = G.now();
    if (t < data.startTime) {
      labelEl.textContent = 'Starts in';
      timerEl.textContent = G.fmtDuration(data.startTime - t);
      timerEl.classList.remove('urgent');
      return;
    }
    const left = data.endTime - t;
    labelEl.textContent = left > 0 ? 'Time left' : 'Time is up';
    timerEl.textContent = G.fmtDuration(Math.max(0, left));
    timerEl.classList.toggle('urgent', left > 0 && left <= 5 * 60000);
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
    $('#refresh-btn').addEventListener('click', load);
    $('#logout-btn').addEventListener('click', () => {
      sessionStorage.removeItem(KEY);
      data = null;
      ['#auto-refresh-wrap', '#refresh-btn', '#logout-btn'].forEach((s) => { $(s).hidden = true; });
      G.showView('login');
    });
  }

  function init() {
    bind();
    if (!G.configured) { G.showView('setup'); return; }
    load();
    setInterval(tick, 250);
    setInterval(() => { if ($('#auto-refresh').checked && G.view() === 'dash') load(); }, REFRESH_MS);
  }

  init();
})();
