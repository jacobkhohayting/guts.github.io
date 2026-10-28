/* Participant page (index.html). Shared helpers live in common.js. */
(function () {
  'use strict';

  const G = window.Guts;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const SESSION_KEY = 'contest.session';
  const DEVICE_KEY = 'contest.device';
  const START_JITTER_MS = 3000;          // spread out the burst of requests at the start time
  const STATUS_POLL_MS = 45000;          // re-sync the clock and schedule with the server
  const SYNC_POLL_MS = 6000;             // how often a device asks the server for what teammates typed...
  const SYNC_POLL_JITTER_MS = 2000;      // ...plus up to this much random delay, so devices don't all call at once
  const SYNC_SOLO_FACTOR = 2;            // ...and this many times slower until another device of the team has been seen
  const SYNC_SAVE_DELAY_MS = 1000;       // pause after typing before the draft is sent
  const SYNC_RETRY_MS = 4000;            // retry delay after a failed sync
  const ACTIVE_TYPING_MS = 2500;         // never overwrite a box someone on this device is typing in
  const IDLE_MS = 10000;                 // "this device has not been typed on for a while"
  const PASSIVE_SUBMIT_DELAY_MS = 3000;  // at time-up, an idle device lets the teammate who is typing submit first
  const PRE_SUBMIT_SYNC_MS = 2500;       // most a time-up sync may delay the automatic submit (the grace period is 20 s)
  const CONFIRM_SYNC_MS = 4000;          // most the sync before / after the confirm dialog may take
  const MIN_PASSWORD_LENGTH = 4;
  const PREVIEW_PLACEHOLDER = 'Your answer appears here as you type';
  const SYNCED_TEXT = '✓ Saved — shared with everyone logged in as your team';
  const OFFLINE_TEXT = 'Not synced — can’t reach the server. Your answers are saved on this device and will sync automatically.';
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const app = {
    session: null,          // { contest, passcode, team, password }
    contests: [],           // public list from the server
    siteName: 'Contest',
    info: null,             // latest data for the logged-in team's contest (merged)
    mode: 'login',          // login form: 'login' | 'signup'
    needsProfile: false,    // an organizer-made team's first login must add its members + email
    submitting: false,
    startRequested: false,  // we have asked the server for round 1 after the start time
    timeUpHandled: false,
    autoSubmittedRound: null,
    sync: null,             // live draft-sync state for the open round (see "shared drafts" below)
    lastEditAt: 0,          // when anyone last typed in an answer box on this device
    teammateSeen: false,    // a different device of this team has written to the draft
    confirmedAnswers: [],   // what the confirm dialog showed, to notice changes made before "Submit round" is pressed
  };

  // ---------- local storage ----------
  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (s && s.password == null && s.code != null) { s.password = s.code; delete s.code; }   // saved by an older version
      return s;
    } catch (e) { return null; }
  }
  function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ } }

  // A random id for this browser; the server stores which device wrote a draft last.
  function deviceId() {
    try {
      let d = localStorage.getItem(DEVICE_KEY);
      if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem(DEVICE_KEY, d); }
      return d;
    } catch (e) { return 'anon'; }
  }
  const DEVICE = deviceId();

  // Typed answers are also kept on the device, so a refresh (or a lost connection) never loses them.
  // Stored as { a: [answers], d: [true where the text has not reached the server yet], t: [when each was typed] }.
  const draftKey = (round) => 'contest.draft.' + (app.session ? app.session.contest + '.' + app.session.team.toLowerCase() : '') + '.' + round;
  function saveDraft(round, answers, dirty, edited) {
    try { localStorage.setItem(draftKey(round), JSON.stringify({ a: answers, d: dirty || [], t: edited || [] })); } catch (e) { /* ignore */ }
  }
  function loadDraft(round) {
    try {
      const raw = JSON.parse(localStorage.getItem(draftKey(round)));
      if (Array.isArray(raw)) return { a: raw, d: [], t: [] };                // saved by an older version
      if (raw && Array.isArray(raw.a)) return { a: raw.a, d: Array.isArray(raw.d) ? raw.d : [], t: Array.isArray(raw.t) ? raw.t : [] };
    } catch (e) { /* ignore */ }
    return { a: [], d: [], t: [] };
  }
  function clearDraft(round) { try { localStorage.removeItem(draftKey(round)); } catch (e) { /* ignore */ } }

  // ---------- server state ----------
  const credentials = () => ({ contest: app.session.contest, passcode: app.session.passcode, team: app.session.team, password: app.session.password });

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
    stopSync();
    $('#confirm-modal').hidden = true;   // a confirmation for a round we have just left must never stay open
    absorb(d);
    Object.assign(app.info, {
      team: d.team,
      members: d.members || [],
      currentRound: d.currentRound,
      finished: !!d.finished,
      submittedRounds: d.submittedRounds || [],
      problems: d.problems || [],
      draft: d.draft || null,
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

  function showPreview(input) {
    G.renderAnswer(input.closest('.problem').querySelector('.preview'), input.value, PREVIEW_PLACEHOLDER);
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
      input.id = `answer-${i}`;
      node.querySelector('.answer-label').htmlFor = input.id;
      input.value = draft.a[i] || '';
      showPreview(input);
      input.addEventListener('input', () => { showPreview(input); onAnswerInput(i); });
      list.appendChild(node);
    });

    const btn = $('#submit-btn');
    btn.disabled = !info.problems.length;
    btn.textContent = 'Submit round';
    if (info.endTime > G.now()) app.timeUpHandled = false;
    G.showView('round');
    window.scrollTo(0, 0);
    if (info.problems.length) startSync(round, info.draft);
  }

  function renderFinished() {
    stopSync();
    $('#finished-team').textContent = app.info.team;
    G.showView('finished');
  }

  function renderEnded() {
    stopSync();
    const done = app.info.submittedRounds || [];
    let msg = done.length ? `You submitted ${done.length} of ${app.info.totalRounds} rounds.` : '';
    if (app.autoSubmittedRound) {
      msg = `Your Round ${app.autoSubmittedRound} answers were submitted automatically when time ran out. ` + msg;
    }
    $('#ended-note').textContent = msg;
    G.showView('ended');
  }

  // ---------- shared drafts: what one device types shows up on the team's other devices ----------
  // The server keeps one draft per team and round. A device sends the boxes it changed (with the time it typed
  // them) and, in the same request, gets back the team's latest draft; the same request is the periodic poll.
  // Rules that keep people from clobbering each other:
  //  - a box with an unsent edit on this device is never overwritten; its edit goes to the server, which keeps
  //    whichever edit of that box is newer (an edit typed while offline cannot beat a teammate's later edit);
  //  - every other box simply converges on the server's value, unless someone is typing in it right now;
  //  - people working on different problems never touch each other's boxes.
  const boxes = () => $$('#problems .answer-input');
  const norm = (v) => String(v == null ? '' : v).replace(/^'/, '').trim();   // how the server stores an answer

  function setSyncStatus(kind, text) {
    const el = $('#sync-status');
    el.textContent = text || '';
    el.className = 'sync-status small ' + (kind === 'offline' ? 'warn' : kind === 'ok' ? 'ok' : 'muted');
  }

  function stopSync() {
    const s = app.sync;
    if (!s) return;
    s.closed = true;                       // anything still holding `s` (a request in flight, a timer) must do nothing more
    clearTimeout(s.saveTimer);
    clearTimeout(s.pollTimer);
    clearTimeout(s.statusTimer);
    app.sync = null;
    setSyncStatus('', '');
  }

  const syncActive = (s) => !!s && !s.closed && app.sync === s;

  function startSync(round, serverDraft) {
    stopSync();
    const local = loadDraft(round);
    const s = {
      round,
      dirty: [],         // true where this device has text the server has not acknowledged yet
      edited: [],        // when (server time) each box was last typed in on this device
      busy: false,       // a request is in flight
      queued: false,     // a save was requested while busy
      paused: false,     // true while the confirm dialog is open: don't change what is being confirmed
      force: false,      // set during the check right before submitting: apply teammates' text no matter what
      closed: false,
      failed: false,
      remoteShown: false,   // the "Updated by a teammate" note is currently displayed
      saveTimer: null, pollTimer: null, statusTimer: null,
    };
    boxes().forEach((_, i) => {
      const isDirty = !!local.d[i];
      s.dirty.push(isDirty);
      s.edited.push(isDirty ? (Number(local.t[i]) || G.now()) : 0);
    });
    app.sync = s;
    if (serverDraft && serverDraft.round === round) mergeRemote(s, serverDraft, true);
    if (s.dirty.some(Boolean) || !serverDraft) scheduleSave(s, 0);
    else setSyncStatus('ok', SYNCED_TEXT);
    schedulePoll(s);
  }

  function persistLocal(s) {
    saveDraft(s.round, boxes().map((el) => el.value), s.dirty, s.edited);
  }

  function onAnswerInput(i) {
    app.lastEditAt = Date.now();
    const s = app.sync;
    if (!syncActive(s)) {
      // Sync is between rounds / restarting: keep the text, flagged as unsent, so it is uploaded as soon as sync resumes.
      const round = app.info.currentRound;
      const cur = loadDraft(round);
      const dirty = cur.d.slice();
      const edited = cur.t.slice();
      dirty[i] = true;
      edited[i] = G.now();
      saveDraft(round, boxes().map((el) => el.value), dirty, edited);
      return;
    }
    s.edited[i] = G.now();
    s.dirty[i] = true;
    persistLocal(s);
    scheduleSave(s);
  }

  function scheduleSave(s, delay) {
    if (!syncActive(s)) return;
    clearTimeout(s.saveTimer);
    if (s.dirty.some(Boolean)) setSyncStatus(s.failed ? 'offline' : 'saving', s.failed ? OFFLINE_TEXT : 'Saving…');
    s.saveTimer = setTimeout(() => exchange(s), delay == null ? SYNC_SAVE_DELAY_MS : delay);
  }

  // A device that has never seen a teammate polls less often; once another device has written to the draft, normal pace.
  function schedulePoll(s) {
    if (!syncActive(s)) return;
    clearTimeout(s.pollTimer);
    const base = SYNC_POLL_MS * (app.teammateSeen ? 1 : SYNC_SOLO_FACTOR);
    s.pollTimer = setTimeout(async () => {
      if (!syncActive(s)) return;
      if (!document.hidden && G.view() === 'round' && !app.submitting) await exchange(s);
      schedulePoll(s);
    }, base + Math.random() * SYNC_POLL_JITTER_MS);
  }

  // Send this device's unsent edits (if any) and fetch the team's latest draft, in one request.
  async function exchange(s) {
    if (!syncActive(s) || app.submitting) return;
    if (s.busy) { if (s.dirty.some(Boolean)) s.queued = true; return; }
    s.busy = true;
    clearTimeout(s.saveTimer);
    const els = boxes();
    const sent = {};
    const changes = {};
    s.dirty.forEach((isDirty, i) => {
      if (isDirty && els[i]) { sent[i] = els[i].value; changes[i] = { v: els[i].value, t: s.edited[i] }; }
    });
    try {
      const payload = Object.assign({ action: 'draft', round: s.round, device: DEVICE }, credentials());
      if (Object.keys(changes).length) payload.changes = changes;
      const d = await G.api(payload, 0);
      if (!syncActive(s)) return;
      await handleDraftResponse(s, d, sent);
    } catch (err) {
      if (syncActive(s)) { s.failed = true; setSyncStatus('offline', OFFLINE_TEXT); }
    } finally {
      s.busy = false;
      if (syncActive(s) && s.dirty.some(Boolean)) {
        if (s.failed) scheduleSave(s, SYNC_RETRY_MS);
        else if (s.queued) scheduleSave(s, SYNC_SAVE_DELAY_MS);
      }
      s.queued = false;
    }
  }

  async function handleDraftResponse(s, d, sent) {
    if (!d.ok) {
      if (d.auth) { logout(true); setLoginError(d.error); return; }
      throw new Error(d.error || 'Sync failed.');
    }
    s.failed = false;
    if (app.submitting) return;                      // our own submit is in charge of what happens next
    if (d.stale || d.currentRound > s.round) { await teammateSubmitted(s); return; }
    if (!d.answers) { if (!s.dirty.some(Boolean)) setSyncStatus('ok', SYNCED_TEXT); return; }   // not open (before start / after the end)
    const els = boxes();
    Object.keys(sent).forEach((k) => {
      const i = Number(k);
      // Acknowledged, or superseded by a newer edit of a teammate: either way the server's value is now the truth
      // for this box -- unless more was typed while the request was on its way.
      if (els[i] && els[i].value === sent[k]) s.dirty[i] = false;
    });
    if (!s.paused || s.force) mergeRemote(s, d, false);
    persistLocal(s);
    if (!s.dirty.some(Boolean) && !s.remoteShown) setSyncStatus('ok', SYNCED_TEXT);
    else if (s.dirty.some(Boolean)) { s.queued = true; setSyncStatus('saving', 'Saving…'); }
  }

  // Make the boxes show the team's draft. Returns true if any box changed.
  function mergeRemote(s, d, quiet) {
    if (Array.isArray(d.devices) && d.devices.some((x) => x && x !== DEVICE)) app.teammateSeen = true;
    const els = boxes();
    let changed = false;
    els.forEach((el, i) => {
      if (s.dirty[i]) return;                                         // our unsent edit goes to the server first
      const value = (d.answers && d.answers[i]) || '';
      const stamp = (d.stamps && d.stamps[i]) || 0;
      if (norm(el.value) === value) return;                           // already the same
      if (!value && !stamp) {                                         // text that only exists on this device: upload it
        if (norm(el.value)) { s.dirty[i] = true; s.edited[i] = G.now(); s.queued = true; }
        return;
      }
      if (!s.force && G.now() - s.edited[i] < ACTIVE_TYPING_MS) return;   // typed in just now; the next poll applies it
      el.value = value;
      showPreview(el);
      changed = true;
      if (!quiet) flash(el);
    });
    if (changed) {
      persistLocal(s);
      if (!quiet) {
        s.remoteShown = true;
        setSyncStatus('ok', '✓ Updated by a teammate just now');
        clearTimeout(s.statusTimer);
        s.statusTimer = setTimeout(() => {
          if (!syncActive(s)) return;
          s.statusTimer = null;
          s.remoteShown = false;
          if (!s.dirty.some(Boolean) && !s.failed) setSyncStatus('ok', SYNCED_TEXT);
        }, 3500);
      }
    }
    return changed;
  }

  function flash(el) {
    el.classList.add('remote-flash');
    setTimeout(() => el.classList.remove('remote-flash'), 1200);
  }

  // A teammate submitted this round from another device: move on to whatever comes next.
  async function teammateSubmitted(s) {
    const round = s.round;
    stopSync();
    try {
      const st = await refreshState();
      if (st) G.toast(`A teammate submitted Round ${round}.` + (st.finished || st.state === 'ended' ? '' : ' Here is the next round.'));
    } catch (err) {
      G.toast(err.message, 'error');
      // Network hiccup: keep syncing the round we are still looking at, and try again shortly.
      setTimeout(() => {
        if (G.view() === 'round' && !app.sync && app.info && app.info.currentRound === round) startSync(round, null);
      }, SYNC_RETRY_MS);
    }
  }

  // Push unsent edits and pull the latest, now -- used right before the team's answers are reviewed or submitted.
  // Waits at most maxMs, so a slow server can never hold the team up. `force` applies teammates' text even to a box
  // that was typed in a moment ago, or while the confirm dialog is open. Returns false if the server was not reached.
  async function syncNow(maxMs, force) {
    const s = app.sync;
    if (!syncActive(s)) return true;
    if (force) s.force = true;
    const work = (async () => {
      for (let i = 0; i < 80 && s.busy && syncActive(s); i++) await G.sleep(50);
      if (syncActive(s) && !s.busy) await exchange(s);
    })();
    work.catch(() => {}).then(() => { s.force = false; });
    await Promise.race([work.catch(() => {}), G.sleep(maxMs)]);
    return !s.failed;
  }

  // ---------- log in / sign up ----------
  function setLoginError(msg) {
    const el = $('#login-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  const currentContest = () => app.contests.find((x) => x.id === $('#contest-select').value) || null;

  function updateIntro() {
    const c = currentContest();
    let t;
    if (app.mode === 'signup') {
      t = 'Create your team once — the first person on the team does this. Teammates then choose Log in with the same team name and password, on any device.';
    } else {
      t = c && c.openRegistration
        ? 'Enter your team name and password. If a teammate already signed your team up, just log in — don’t sign up again.'
        : 'Enter your team name and the password the organizers gave you.';
    }
    $('#login-intro').textContent = t;
  }

  function setMode(mode) {
    app.mode = mode;
    app.needsProfile = false;
    const signup = mode === 'signup';
    $('#tab-login').setAttribute('aria-selected', String(!signup));
    $('#tab-signup').setAttribute('aria-selected', String(signup));
    $('#confirm-wrap').hidden = !signup;
    $('#password-hint').hidden = !signup;
    $('#profile-wrap').hidden = !signup;
    $('#profile-note').textContent = 'Who is on your team? Enter at least one name, plus an email address the organizers can reach you at.';
    $('#password-input').autocomplete = signup ? 'new-password' : 'current-password';
    $('#login-btn').textContent = signup ? 'Create team' : 'Log in';
    setLoginError('');
    updateIntro();
  }

  // A team the organizers created by hand has no members/email on file yet; its first login has to add them.
  function requireProfile(msg) {
    app.needsProfile = true;
    $('#profile-note').textContent = 'This team was set up by the organizers and has no members on file yet. Add at least one name and a contact email to continue.';
    $('#profile-wrap').hidden = false;
    setLoginError(msg);
    $('#member1-input').focus();
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
    const open = !!(c && c.openRegistration);
    $('#passcode-wrap').hidden = !(c && c.hasPasscode);
    $('#login-tabs').hidden = !open;                    // contests with closed registration have no Sign up
    if (app.mode === 'signup' && !open) setMode('login');
    else updateIntro();
    setLeaderboardLink(id);
  }

  async function onLoginSubmit(ev) {
    ev.preventDefault();
    const signup = app.mode === 'signup';
    const withProfile = signup || app.needsProfile;
    const contest = $('#contest-select').value;
    const passcode = $('#passcode-input').value.trim();
    const team = $('#team-input').value.trim().replace(/\s+/g, ' ');
    const password = $('#password-input').value.trim();
    const confirm = $('#confirm-input').value.trim();
    const members = ['#member1-input', '#member2-input', '#member3-input']
      .map((sel) => $(sel).value.trim().replace(/\s+/g, ' '));
    const email = $('#email-input').value.trim();
    const c = app.contests.find((x) => x.id === contest);
    if (!c) { setLoginError('Please choose a contest.'); return; }
    if (c.hasPasscode && !passcode) { setLoginError('Please enter the contest passcode.'); return; }
    if (!team) { setLoginError('Please enter your team name.'); return; }
    if (!password) { setLoginError('Please enter your team password.'); return; }
    if (signup) {
      if (password.length < MIN_PASSWORD_LENGTH) { setLoginError(`Please choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`); return; }
      if (confirm !== password) { setLoginError('The two passwords do not match.'); return; }
    }
    if (withProfile) {
      if (!members.some(Boolean)) { setLoginError('Please enter at least one team member\'s name.'); return; }
      if (!EMAIL_RE.test(email)) { setLoginError('Please enter a valid contact email address.'); return; }
    }
    setLoginError('');
    const btn = $('#login-btn');
    btn.disabled = true;
    btn.textContent = signup ? 'Creating team…' : 'Logging in…';
    try {
      const payload = { action: signup ? 'signup' : 'login', contest, passcode, team, password };
      if (signup) payload.confirm = confirm;
      if (withProfile) { payload.members = members; payload.email = email; }
      // No automatic retries for sign-up: a repeated request would look like a second sign-up of the same team.
      const d = await G.api(payload, signup ? 0 : 3);
      if (!d.ok) {
        if (d.needsInfo) requireProfile(d.error);
        else setLoginError(d.error || (signup ? 'Sign-up failed.' : 'Login failed.'));
        return;
      }
      app.session = { contest: d.contest, passcode, team: d.team, password };
      saveSession(app.session);
      app.autoSubmittedRound = null;
      app.teammateSeen = false;
      app.info = null;
      $('#password-input').value = '';
      $('#confirm-input').value = '';
      applyState(d);
      if (signup) G.toast('Team created! Teammates can now log in with your team name and password.');
    } catch (err) {
      setLoginError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = app.mode === 'signup' ? 'Create team' : 'Log in';
    }
  }

  function logout(silent) {
    if (!silent && G.view() === 'round' && !window.confirm('Switch team? Your answers are saved and stay with your team.')) return;
    stopSync();
    clearSession();
    app.session = null;
    app.info = null;
    app.startRequested = false;
    app.teammateSeen = false;
    $('#logout-btn').hidden = true;
    ['#passcode-input', '#team-input', '#password-input', '#confirm-input', '#member1-input', '#member2-input', '#member3-input', '#email-input']
      .forEach((sel) => { $(sel).value = ''; });
    setMode('login');
    renderLogin();
  }

  // ---------- submitting ----------
  function getAnswers() {
    return $$('#problems .answer-input').map((el) => el.value);
  }

  // Review step. First pull in anything a teammate typed on another device, so the dialog shows what the whole
  // team has; while it is open the boxes stay as they are, and "Submit round" checks once more before locking.
  async function openConfirm() {
    if (app.submitting || !app.info || !app.info.problems.length) return;
    const btn = $('#submit-btn');
    const round = app.info.currentRound;
    btn.disabled = true;
    try {
      await syncNow(CONFIRM_SYNC_MS, true);
    } finally {
      if (app.info && app.info.problems.length && !app.submitting) btn.disabled = false;
    }
    if (!app.info || app.info.currentRound !== round || G.view() !== 'round' || app.submitting) return;   // the team moved on; the new round is already shown
    showConfirm('');
  }

  function showConfirm(notice) {
    if (app.sync) app.sync.paused = true;  // keep the answers under review stable until the dialog closes
    const answers = getAnswers();
    app.confirmedAnswers = answers.slice();
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
    const text = [notice, blanks ? `${blanks === 1 ? '1 answer is' : blanks + ' answers are'} blank.` : ''].filter(Boolean).join(' ');
    const warn = $('#confirm-warning');
    warn.textContent = text;
    warn.hidden = !text;
    $('#confirm-title').textContent = `Submit Round ${app.info.currentRound}?`;
    $('#confirm-yes').disabled = false;
    $('#confirm-modal').hidden = false;
  }

  // "Submit round" in the dialog. A teammate may have changed an answer while the dialog was open; if so, show the
  // updated answers and ask again rather than locking in something nobody reviewed.
  async function onConfirmYes() {
    const yes = $('#confirm-yes');
    if (yes.disabled || app.submitting || !app.info) return;
    yes.disabled = true;
    const round = app.info.currentRound;
    const reviewed = app.confirmedAnswers || [];
    await syncNow(CONFIRM_SYNC_MS, true);
    if (!app.info || app.info.currentRound !== round || G.view() !== 'round' || app.submitting) return;   // the team moved on (the dialog was closed with it)
    if ($('#confirm-modal').hidden) return;                       // closed meanwhile (Go back / Escape / time up)
    const now = getAnswers();
    if (now.length !== reviewed.length || now.some((a, i) => a !== reviewed[i])) {
      showConfirm('A teammate changed an answer while you were reviewing. Please check the answers again.');
      return;
    }
    $('#confirm-modal').hidden = true;
    if (app.sync) app.sync.paused = false;
    doSubmit(false);
  }

  async function doSubmit(auto) {
    if (app.submitting || !app.info || !app.info.problems.length) return;
    app.submitting = true;
    const round = app.info.currentRound;
    const answers = getAnswers();           // read synchronously: exactly what was on screen / confirmed
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
      const more = !(d.finished || d.state === 'ended');
      G.toast(byTeammate ? `Round ${round} had already been submitted by a teammate.` + (more ? ' Here is the next round.' : '') : `Round ${round} submitted.`);
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
    if (G.view() === 'round' && !app.submitting) {
      closeConfirm();
      // If a teammate's device has been typing and this one has not, give that device a moment to submit first,
      // so the most complete answers win. (A team with a single device never waits.)
      if (app.sync && app.teammateSeen && Date.now() - app.lastEditAt > IDLE_MS) await G.sleep(PASSIVE_SUBMIT_DELAY_MS);
      if (G.view() === 'round' && !app.submitting) {
        await syncNow(PRE_SUBMIT_SYNC_MS, true);   // include whatever teammates typed in the last few seconds
        if (G.view() === 'round' && getAnswers().some((a) => a.trim())) await doSubmit(true);
      }
    }
    if (G.view() !== 'ended') {
      await G.sleep(500);
      try { await refreshState(); } catch (err) { renderEnded(); }   // renderEnded also stops the sync
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

  function resumeSync() {
    const s = app.sync;
    if (!s) return;
    s.paused = false;
    setTimeout(() => { if (syncActive(s)) exchange(s); }, 300);   // catch up on what teammates typed meanwhile
  }

  function closeConfirm() {
    if (!$('#confirm-modal').hidden) { $('#confirm-modal').hidden = true; resumeSync(); }
  }

  function closeModals() {
    $$('.modal').forEach((m) => { m.hidden = true; });
    resumeSync();
  }

  function bindUI() {
    $('#rules-btn').addEventListener('click', openRules);
    $('#logout-btn').addEventListener('click', () => logout(false));
    $('#login-form').addEventListener('submit', onLoginSubmit);
    $('#contest-select').addEventListener('change', (ev) => {
      if (app.needsProfile) { app.needsProfile = false; $('#profile-wrap').hidden = app.mode !== 'signup'; }
      setLoginError('');
      onContestChoice(ev.target.value);
    });
    $$('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
    $('#show-password').addEventListener('change', (ev) => {
      const type = ev.target.checked ? 'text' : 'password';
      $('#password-input').type = type;
      $('#confirm-input').type = type;
    });
    $('#submit-btn').addEventListener('click', openConfirm);
    $('#confirm-yes').addEventListener('click', onConfirmYes);
    $('#retry-btn').addEventListener('click', () => window.location.reload());
    $$('[data-close]').forEach((el) => el.addEventListener('click', closeModals));
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeModals(); });
    // Switching away flushes unsent text; coming back (or regaining the connection) fetches what teammates typed.
    document.addEventListener('visibilitychange', () => {
      const s = app.sync;
      if (s && (!document.hidden || s.dirty.some(Boolean))) exchange(s);
    });
    window.addEventListener('online', () => { if (app.sync) exchange(app.sync); });
    setMode('login');
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
      if (app.session && app.session.contest && app.session.team && app.session.password) {
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
