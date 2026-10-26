/* Participant page (index.html). Shared helpers live in common.js. */
(function () {
  'use strict';

  const G = window.Guts;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const SESSION_KEY = 'contest.session';
  const START_JITTER_MS = 3000;   // spread out the burst of requests at the start time
  const STATUS_POLL_MS = 45000;   // re-sync the clock and schedule with the server

  const app = {
    session: null,          // { contest, passcode, team, code }
    contests: [],           // public list from the server
    siteName: 'Contest',
    info: null,             // latest data for the logged-in team's contest (merged)
    submitting: false,
    startRequested: false,  // we have asked the server for round 1 after the start time
    timeUpHandled: false,
    autoSubmittedRound: null,
  };

  // ---------- local storage ----------
  function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; } }
  function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ } }

  // Typed answers are kept on the device so a refresh never loses them.
  const draftKey = (round) => 'contest.draft.' + (app.session ? app.session.contest + '.' + app.session.team.toLowerCase() : '') + '.' + round;
  function saveDraft(round, answers) { try { localStorage.setItem(draftKey(round), JSON.stringify(answers)); } catch (e) { /* ignore */ } }
  function loadDraft(round) { try { return JSON.parse(localStorage.getItem(draftKey(round))) || []; } catch (e) { return []; } }
  function clearDraft(round) { try { localStorage.removeItem(draftKey(round)); } catch (e) { /* ignore */ } }

  // ---------- server state ----------
  const credentials = () => ({ contest: app.session.contest, passcode: app.session.passcode, team: app.session.team, code: app.session.code });

  function setHeader(title) {
    $('#contest-name').textContent = title;
    document.title = title;
  }

  function setLeaderboardLink(contestId) {
    const a = $('#leaderboard-link');
    a.href = 'leaderboard.html' + (contestId ? '?contest=' + encodeURIComponent(contestId) : '');
  }

  // Copy the contest-wide fields (schedule, title) from a team-state response.
  function absorb(d) {
    app.info = app.info || {};
    ['state', 'startTime', 'endTime', 'contestTitle', 'totalRounds', 'problemsPerRound', 'durationMinutes', 'showLeaderboard']
      .forEach((k) => { if (d[k] !== undefined) app.info[k] = d[k]; });
    if (app.info.contestTitle) setHeader(app.info.contestTitle);
    if (G.view() === 'waiting' && app.info.startTime) $('#waiting-start').textContent = G.fmtDate(app.info.startTime);
    const lb = app.info.showLeaderboard !== false;
    $('#leaderboard-link').hidden = !lb;
    $('#finished-note').hidden = !lb;
    $('#ended-lb').hidden = !lb;
  }

  // Apply a full team state (from login / state / submit) and show the right screen.
  function applyState(d) {
    absorb(d);
    Object.assign(app.info, {
      team: d.team,
      members: d.members || [],
      currentRound: d.currentRound,
      finished: !!d.finished,
      submittedRounds: d.submittedRounds || [],
      problems: d.problems || [],
    });
    $('#logout-btn').hidden = false;
    setLeaderboardLink(app.session.contest);
    if (d.state === 'unscheduled') {
      $('#unscheduled-team').textContent = d.team;
      G.showView('unscheduled');
    } else if (d.state === 'before') {
      app.startRequested = false;
      renderWaiting();
    } else if (d.state === 'ended') {
      renderEnded();
    } else if (app.info.finished) {
      renderFinished();
    } else {
      renderRound();
    }
  }

  // Ask the server where this team is. Returns the response, or null if the login was rejected.
  async function refreshState() {
    const d = await G.api(Object.assign({ action: 'state' }, credentials()));
    if (!d.ok) {
      if (d.auth) { logout(true); setLoginError(d.error); return null; }
      throw new Error(d.error || 'The server returned an error.');
    }
    applyState(d);
    return d;
  }

  // ---------- rendering ----------
  function teamLabel() {
    const m = app.info.members || [];
    return app.info.team + (m.length ? ` (${m.join(', ')})` : '');
  }

  function renderWaiting() {
    $('#waiting-team').textContent = teamLabel();
    $('#waiting-start').textContent = G.fmtDate(app.info.startTime);
    G.showView('waiting');
  }

  function renderProgress() {
    const { totalRounds, currentRound, finished } = app.info;
    const box = $('#progress');
    box.textContent = '';
    for (let r = 1; r <= totalRounds; r++) {
      const dot = document.createElement('span');
      const done = finished || r < currentRound;
      dot.className = 'step' + (done ? ' done' : r === currentRound ? ' current' : '');
      dot.textContent = r;
      dot.title = done ? `Round ${r}: submitted` : r === currentRound ? `Round ${r}: in progress` : `Round ${r}: locked`;
      box.appendChild(dot);
    }
  }

  function renderRound() {
    const info = app.info;
    const round = info.currentRound;
    $('#round-title').textContent = `Round ${round} of ${info.totalRounds}`;
    $('#team-line').textContent = `Team: ${teamLabel()}`;
    renderProgress();

    const list = $('#problems');
    list.textContent = '';
    if (!info.problems.length) {
      const card = document.createElement('div');
      card.className = 'card';
      card.textContent = `No problems were found for round ${round}. Please tell the organizers.`;
      list.appendChild(card);
    }

    const draft = loadDraft(round);
    const tpl = $('#problem-template');
    info.problems.forEach((q, i) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelector('.problem-num').textContent = `Problem ${q.n}`;
      node.querySelector('.problem-pts').textContent = q.points ? `${q.points} pt${q.points === 1 ? '' : 's'}` : '';
      G.renderRichText(node.querySelector('.problem-text'), q.text);
      const img = node.querySelector('.problem-image');
      if (q.image) { img.src = G.imageSrc(q.image); img.hidden = false; }
      const input = node.querySelector('.answer-input');
      const preview = node.querySelector('.preview');
      input.id = `answer-${i}`;
      node.querySelector('.answer-label').htmlFor = input.id;
      input.value = draft[i] || '';
      G.renderAnswer(preview, input.value, 'Your answer appears here as you type');
      input.addEventListener('input', () => {
        G.renderAnswer(preview, input.value, 'Your answer appears here as you type');
        saveDraft(round, getAnswers());
      });
      list.appendChild(node);
    });

    const btn = $('#submit-btn');
    btn.disabled = !info.problems.length;
    btn.textContent = 'Submit round';
    if (info.endTime > G.now()) app.timeUpHandled = false;
    G.showView('round');
    window.scrollTo(0, 0);
  }

  function renderFinished() {
    $('#finished-team').textContent = app.info.team;
    G.showView('finished');
  }

  function renderEnded() {
    const done = app.info.submittedRounds || [];
    let msg = done.length ? `You submitted ${done.length} of ${app.info.totalRounds} rounds.` : '';
    if (app.autoSubmittedRound) {
      msg = `Your Round ${app.autoSubmittedRound} answers were submitted automatically when time ran out. ` + msg;
    }
    $('#ended-note').textContent = msg;
    G.showView('ended');
  }

  function renderLogin() {
    const sel = $('#contest-select');
    const chosen = G.fillContestSelect(sel, app.contests, G.urlParam('contest') || (app.session && app.session.contest));
    $('#no-contests').hidden = app.contests.length > 0;
    $('#login-btn').disabled = !app.contests.length;
    onContestChoice(chosen);
    setHeader(app.siteName);
    setLeaderboardLink(chosen);
    G.showView('login');
  }

  function onContestChoice(id) {
    const c = app.contests.find((x) => x.id === id);
    $('#passcode-wrap').hidden = !(c && c.hasPasscode);
    $('#login-intro').textContent = c && c.openRegistration
      ? 'Enter your team name and choose a team code. You will need the same code to log back in.'
      : 'Enter your team name and the team code the organizers gave you.';
    setLeaderboardLink(id);
  }

  // ---------- actions ----------
  function setLoginError(msg) {
    const el = $('#login-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  async function onLoginSubmit(ev) {
    ev.preventDefault();
    const contest = $('#contest-select').value;
    const passcode = $('#passcode-input').value.trim();
    const team = $('#team-input').value.trim().replace(/\s+/g, ' ');
    const code = $('#code-input').value.trim();
    const members = ['#member1-input', '#member2-input', '#member3-input']
      .map((sel) => $(sel).value.trim().replace(/\s+/g, ' '));
    const email = $('#email-input').value.trim();
    const c = app.contests.find((x) => x.id === contest);
    if (!c) { setLoginError('Please choose a contest.'); return; }
    if (c.hasPasscode && !passcode) { setLoginError('Please enter the contest passcode.'); return; }
    if (!team || !code) { setLoginError('Please enter your team name and team code.'); return; }
    if (!members.some(Boolean)) { setLoginError('Please enter at least one team member\'s name.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setLoginError('Please enter a valid contact email address.'); return; }
    setLoginError('');
    const btn = $('#login-btn');
    btn.disabled = true;
    btn.textContent = 'Entering…';
    try {
      const d = await G.api({ action: 'login', contest, passcode, team, code, members, email });
      if (!d.ok) { setLoginError(d.error || 'Login failed.'); return; }
      app.session = { contest: d.contest, passcode, team: d.team, code };
      saveSession(app.session);
      app.autoSubmittedRound = null;
      app.info = null;
      applyState(d);
    } catch (err) {
      setLoginError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enter';
    }
  }

  function logout(silent) {
    if (!silent && G.view() === 'round' && !window.confirm('Switch team? Your typed answers stay saved on this device.')) return;
    clearSession();
    app.session = null;
    app.info = null;
    app.startRequested = false;
    $('#logout-btn').hidden = true;
    ['#passcode-input', '#team-input', '#code-input', '#member1-input', '#member2-input', '#member3-input', '#email-input']
      .forEach((sel) => { $(sel).value = ''; });
    setLoginError('');
    renderLogin();
  }

  function getAnswers() {
    return $$('#problems .answer-input').map((el) => el.value);
  }

  function openConfirm() {
    const answers = getAnswers();
    const list = $('#confirm-list');
    list.textContent = '';
    answers.forEach((a, i) => {
      const row = document.createElement('div');
      row.className = 'confirm-row';
      const label = document.createElement('div');
      label.className = 'confirm-label';
      label.textContent = `Problem ${app.info.problems[i].n}`;
      const value = document.createElement('div');
      value.className = 'confirm-value';
      G.renderAnswer(value, a, '(blank)');
      row.append(label, value);
      list.appendChild(row);
    });
    const blanks = answers.filter((a) => !a.trim()).length;
    const warn = $('#confirm-warning');
    warn.textContent = blanks ? `${blanks === 1 ? '1 answer is' : blanks + ' answers are'} blank.` : '';
    warn.hidden = !blanks;
    $('#confirm-title').textContent = `Submit Round ${app.info.currentRound}?`;
    $('#confirm-modal').hidden = false;
  }

  async function doSubmit(auto) {
    if (app.submitting || !app.info || !app.info.problems.length) return;
    app.submitting = true;
    const round = app.info.currentRound;
    const answers = getAnswers();
    const btn = $('#submit-btn');
    const inputs = $$('#problems .answer-input');
    btn.disabled = true;
    btn.textContent = auto ? 'Time is up — submitting…' : 'Submitting…';
    inputs.forEach((el) => { el.disabled = true; });
    try {
      let d = await G.api(Object.assign({ action: 'submit', round, answers }, credentials()));
      let byTeammate = false;
      if (!d.ok) {
        if (d.auth) { logout(true); setLoginError(d.error); return; }
        // Maybe a teammate already submitted this round from another device. Re-sync before giving up.
        const s = await G.api(Object.assign({ action: 'state' }, credentials()));
        if (s.ok && s.currentRound > round) {
          d = s;
          byTeammate = true;
        } else if (s.ok && s.state === 'ended') {
          G.toast(d.error || 'Submissions are closed.', 'error');
          applyState(s);
          return;
        } else {
          throw new Error(d.error || 'Submission failed.');
        }
      }
      clearDraft(round);
      if (auto && !byTeammate) app.autoSubmittedRound = round;
      applyState(d);
      G.toast(byTeammate ? `Round ${round} had already been submitted by a teammate — here is the next round.` : `Round ${round} submitted.`);
    } catch (err) {
      G.toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Submit round';
      inputs.forEach((el) => { el.disabled = false; });
    } finally {
      app.submitting = false;
    }
  }

  // The countdown hit zero while we were waiting: fetch round 1.
  async function onContestStart() {
    await G.sleep(Math.random() * START_JITTER_MS);
    try {
      const d = await refreshState();
      if (d && d.state === 'before') {
        // The server's clock is a hair behind ours; tick() will try again shortly.
        await G.sleep(1000);
        app.startRequested = false;
      }
    } catch (err) {
      G.toast(err.message, 'error');
      await G.sleep(2000);
      app.startRequested = false;
    }
  }

  // The contest clock hit zero while a round was open: submit what's typed, then show the end screen.
  async function onTimeUp() {
    if (G.view() === 'round' && !app.submitting && getAnswers().some((a) => a.trim())) {
      await doSubmit(true);
    }
    if (G.view() !== 'ended') {
      await G.sleep(500);
      try { await refreshState(); } catch (err) { renderEnded(); }
    }
  }

  // ---------- timer ----------
  function tick() {
    if (!app.session) {
      // Not logged in: show the countdown of the contest picked in the dropdown.
      const c = app.contests.find((x) => x.id === $('#contest-select').value);
      G.paintTimer(c || null);
      return;
    }
    const left = G.paintTimer(app.info);
    if (!app.info || !app.info.startTime) return;
    if (G.view() === 'waiting' && !app.startRequested) {
      app.startRequested = true;
      onContestStart();
    }
    if (left !== null && left <= 0 && G.view() === 'round' && !app.timeUpHandled) {
      app.timeUpHandled = true;
      onTimeUp();
    }
  }

  async function pollStatus() {
    const v = G.view();
    if (v === 'ended' || v === 'finished' || v === 'setup' || v === 'error') return;
    try {
      const d = await G.api({ action: 'status' }, 0);
      if (!d.ok) return;
      app.contests = d.contests || [];
      if (app.session && app.info) {
        const c = app.contests.find((x) => x.id === app.session.contest);
        if (c) absorb({ state: c.state, startTime: c.startTime, endTime: c.endTime, contestTitle: c.title, durationMinutes: c.durationMinutes, showLeaderboard: c.showLeaderboard });
      } else if (v === 'login') {
        const keep = $('#contest-select').value;
        G.fillContestSelect($('#contest-select'), app.contests, keep);
        onContestChoice($('#contest-select').value);
      }
    } catch (err) { /* ignore; next poll will try again */ }
  }

  // ---------- modals & wiring ----------
  function openRules() {
    const box = $('#rules-content');
    const info = app.info || {};
    const fills = {
      rounds: info.totalRounds,
      perRound: info.problemsPerRound,
      duration: info.durationMinutes,
    };
    box.querySelectorAll('[data-fill]').forEach((el) => {
      const v = fills[el.dataset.fill];
      if (v != null && v !== '') el.textContent = v;
    });
    if (!box.dataset.rendered) {
      G.typesetIn(box);
      box.dataset.rendered = '1';
    }
    $('#rules-modal').hidden = false;
  }

  function closeModals() {
    $$('.modal').forEach((m) => { m.hidden = true; });
  }

  function bindUI() {
    $('#rules-btn').addEventListener('click', openRules);
    $('#logout-btn').addEventListener('click', () => logout(false));
    $('#login-form').addEventListener('submit', onLoginSubmit);
    $('#contest-select').addEventListener('change', (ev) => onContestChoice(ev.target.value));
    $('#submit-btn').addEventListener('click', openConfirm);
    $('#confirm-yes').addEventListener('click', () => { closeModals(); doSubmit(false); });
    $('#retry-btn').addEventListener('click', () => window.location.reload());
    $$('[data-close]').forEach((el) => el.addEventListener('click', closeModals));
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeModals(); });
  }

  async function init() {
    bindUI();
    if (!G.configured) { G.showView('setup'); return; }
    G.showView('loading');
    try {
      const d = await G.api({ action: 'status' });
      if (!d.ok) throw new Error(d.error || 'The server returned an error.');
      app.contests = d.contests || [];
      app.siteName = d.siteName || 'Contest';
      app.session = loadSession();
      if (app.session && app.session.contest && app.session.team && app.session.code) {
        if (!app.contests.some((c) => c.id === app.session.contest)) {
          logout(true);   // the contest was removed
        } else {
          await refreshState();
        }
      } else {
        app.session = null;
        renderLogin();
      }
    } catch (err) {
      $('#error-msg').textContent = err.message;
      G.showView('error');
      return;
    }
    setInterval(tick, 250);
    setInterval(pollStatus, STATUS_POLL_MS);
    tick();
  }

  init();
})();
