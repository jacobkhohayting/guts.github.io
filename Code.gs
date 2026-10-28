/**
 * Contest backend — Google Apps Script (multi-contest version)
 * ============================================================
 * Install (full walkthrough in README.md):
 *   1. Create a Google Sheet. Extensions → Apps Script. Replace the default code with this file. Save.
 *   2. Choose "setup" in the function dropdown and click Run (approve the permissions). This creates the tabs,
 *      or upgrades the tabs of an older single-contest sheet in place (nothing is deleted).
 *   3. Fill in the Config, Contests, Problems and Teams tabs.
 *   4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy.
 *   5. Paste the Web app URL into config.js on the website.
 *
 * Everything secret (problems, answers, passcodes, team passwords, admin password) lives in this private
 * spreadsheet. The website repo only contains this file, which has no secrets in it.
 *
 * Tabs:
 *   Config       admin_password, site_name
 *   Contests     one row per contest: ID, Title, Passcode, Start time, Duration, Open registration, Show leaderboard
 *   Problems     Contest, Round, Problem #, Problem, Accepted answers, Points, Image URL
 *   Teams        Contest, Team Name, Password, Registered At, Member 1..3, Email
 *   Submissions  Timestamp, Contest, Team, Round, Answer 1..K, Correct 1..K, Points, Elapsed
 *   Drafts       the not-yet-submitted answers of each team's current round (what keeps a team's devices in sync)
 *
 * What the server enforces:
 *   - A team signs up ONCE (its name must be unused in that contest); teammates then log in with the team name
 *     and password. Every request also needs the contest's passcode, if one is set.
 *   - Problems for round N are released to a team only after it has submitted rounds 1..N-1 of that contest,
 *     and only while that contest is running (server clock, not the participant's).
 *   - A round can be submitted exactly once, and only the team's current round.
 *   - Teams never receive answers or correctness; the public leaderboard only carries total scores.
 */

// Leave blank when this script is attached to the spreadsheet (Extensions → Apps Script).
// Otherwise paste the spreadsheet ID from its URL.
const SPREADSHEET_ID = '';

const PROBLEMS_PER_ROUND = 3;      // the Submissions tab gets this many Answer/Correct columns
const MAX_MEMBERS = 3;             // member-name slots recorded per team (1 name + 1 email are required at login)
const GRACE_SECONDS = 20;          // still accept a submission this long after time runs out (slow networks)
const MAX_ANSWER_LENGTH = 200;
const MIN_PASSWORD_LENGTH = 4;     // for teams that sign up themselves (passwords you type into the sheet are not checked)
const MAX_PASSWORD_LENGTH = 40;
const CONFIG_CACHE_SECONDS = 15;   // edits to Config/Contests take effect within this long
const PROBLEMS_CACHE_SECONDS = 60; // edits to Problems take effect within this long (or use Contest → Apply edits now)

const SHEET = { config: 'Config', contests: 'Contests', problems: 'Problems', teams: 'Teams', submissions: 'Submissions', drafts: 'Drafts' };

// Column layout (0-based) of the data tabs.
const COL = {
  contests: { id: 0, title: 1, passcode: 2, start: 3, duration: 4, openReg: 5, leaderboard: 6 },
  problems: { contest: 0, round: 1, n: 2, text: 3, answers: 4, points: 5, image: 6 },
  teams: { contest: 0, name: 1, password: 2, registered: 3, member1: 4, email: 4 + MAX_MEMBERS },
  subs: { time: 0, contest: 1, team: 2, round: 3, answers: 4 },
  // Drafts: Contest, Team, Round, then per problem: Draft i, Stamp i (server time of its last change), Device i (who wrote it).
  // The three cells of a problem sit side by side so one small write updates one problem and nothing else.
  drafts: { contest: 0, team: 1, round: 2, fields: 3 },
};

// ============================================================================
// Web entry points
// ============================================================================

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.action) {
    return ContentService.createTextOutput(
      'Contest backend is running. The website talks to this URL; you do not need to open it yourself.');
  }
  return respond(handle(p));
}

function doPost(e) {
  let p;
  try {
    p = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ ok: false, error: 'Request body must be JSON.' });
  }
  return respond(handle(p || {}));
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle(p) {
  try {
    switch (String(p.action || '')) {
      case 'status':      return status();
      case 'signup':      return teamState(p, 'signup');
      case 'login':       return teamState(p, 'login');
      case 'state':       return teamState(p, null);
      case 'draft':       return draftSync(p);
      case 'submit':      return submit(p);
      case 'leaderboard': return leaderboard(p);
      case 'admin':       return admin(p);
      default:            return { ok: false, error: 'Unknown action: ' + p.action };
    }
  } catch (err) {
    return {
      ok: false,
      error: String((err && err.message) || err),
      auth: !!(err && err.auth),
      hidden: !!(err && err.hidden),
      needsInfo: !!(err && err.needsInfo),
    };
  }
}

function authError(msg) {
  const e = new Error(msg);
  e.auth = true;
  return e;
}

// ============================================================================
// Actions
// ============================================================================

/** Public: site name, the list of contests (no passcodes), schedule and server time. No problems. */
function status() {
  const cfg = getConfig();
  const probs = getProblems();
  return {
    ok: true,
    siteName: cfg.siteName,
    serverTime: Date.now(),
    problemsPerRound: PROBLEMS_PER_ROUND,
    contests: getContests().map(function (c) { return publicContest(c, probs); }),
  };
}

function publicContest(c, probs) {
  return Object.assign({
    id: c.id,
    title: c.title,
    hasPasscode: !!c.passcode,
    openRegistration: c.openRegistration,
    showLeaderboard: c.showLeaderboard,
    durationMinutes: c.durationMinutes,
    totalRounds: countRounds(contestProblems(probs, c.id)),
  }, timeInfo(c));
}

/**
 * Team: where am I in this contest?
 *   mode 'signup' creates the team (only if the name is free), 'login' checks name + password,
 *   null (state polling) just checks name + password.
 */
function teamState(p, mode) {
  const contest = requireContest(p);
  const team = authenticate(p, contest, mode);
  return buildTeamState(team, contest);
}

function buildTeamState(team, contest) {
  const probs = contestProblems(getProblems(), contest.id);
  const t = timeInfo(contest);
  const totalRounds = countRounds(probs);
  const prog = teamProgress(contest.id, team.name, getSubmissions());
  const res = Object.assign({
    ok: true,
    contest: contest.id,
    contestTitle: contest.title,
    showLeaderboard: contest.showLeaderboard,
    team: team.name,
    members: team.members || [],
    email: team.email || '',
    totalRounds: totalRounds,
    problemsPerRound: PROBLEMS_PER_ROUND,
    durationMinutes: contest.durationMinutes,
    currentRound: prog.currentRound,
    submittedRounds: prog.submittedRounds,
    finished: prog.currentRound > totalRounds,
  }, t);
  // Problems are only ever sent for the team's current round, while the contest is running.
  if (t.state === 'running' && !res.finished) {
    res.problems = roundProblems(probs, prog.currentRound)
      .map(function (q) { return { n: q.n, text: q.text, points: q.points, image: q.image }; });
    res.draft = draftFor(contest.id, team.name, prog.currentRound);   // answers a teammate already typed
  }
  return res;
}

/** Team: submit the current round. Locks it, grades it, and returns the next round. */
function submit(p) {
  const contest = requireContest(p);
  const team = authenticate(p, contest, null);
  const t = timeInfo(contest);
  if (t.state === 'unscheduled' || t.state === 'before') throw new Error('The contest has not started yet.');
  if (t.serverTime > contest.endTime + GRACE_SECONDS * 1000) throw new Error('Time is up — submissions are closed.');

  const probs = contestProblems(getProblems(), contest.id);
  const totalRounds = countRounds(probs);
  const round = Number(p.round);
  if (!(round >= 1 && round <= totalRounds)) throw new Error('Invalid round.');
  const given = Array.isArray(p.answers) ? p.answers : [];

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const prog = teamProgress(contest.id, team.name, getSubmissions());
    if (prog.currentRound > totalRounds) throw new Error('You have already submitted every round.');
    if (round !== prog.currentRound) {
      throw new Error('You are on round ' + prog.currentRound + ', not round ' + round + '. Reload the page.');
    }
    const qs = roundProblems(probs, round);
    const answers = [];
    const correct = [];
    let points = 0;
    for (let i = 0; i < PROBLEMS_PER_ROUND; i++) {
      const a = String(given[i] == null ? '' : given[i]).trim().slice(0, MAX_ANSWER_LENGTH);
      const q = qs[i];
      const ok = !!q && isCorrect(a, q.answers);
      answers.push(a);
      correct.push(ok);
      if (ok) points += q.points;
    }
    const nowMs = Date.now();
    const elapsed = Math.round((nowMs - contest.startTime) / 600) / 100; // minutes since start, 2 decimals
    const row = [new Date(nowMs), asText(contest.id), asText(team.name), round]
      .concat(answers.map(asText), correct, [points, elapsed]);
    sheet(SHEET.submissions).appendRow(row);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  // The round is locked, so its draft is no longer needed. Done after releasing the lock (and best-effort):
  // a slow cleanup must never delay other teams' submissions or turn a successful submit into an error.
  try { clearDraft(contest.id, team.name, round); } catch (err) { /* harmless leftovers; the round is never read again */ }
  return buildTeamState(team, contest);
}

/**
 * Team: keep the typed-but-unsubmitted answers of the current round in sync between a team's devices.
 * One call both stores this device's edits and returns the team's latest draft, so the same call serves as
 * the poll. p.changes = { "0": { v: "text", t: when-it-was-typed } , ... } by problem position (a bare string
 * is accepted too). Each problem keeps the time of its last edit ("stamp"); an edit that is OLDER than the stored
 * one (e.g. typed on a device that was offline while a teammate kept going) is not applied, and the caller gets
 * the stored text back to show instead. Two people editing different problems never collide.
 * Also tells the caller if the team has moved on (a teammate submitted): currentRound > round.
 */
function draftSync(p) {
  const contest = requireContest(p);
  const team = authenticate(p, contest, null);
  const t = timeInfo(contest);
  const totalRounds = roundsOf(contest.id);
  const round = Number(p.round);
  const prog = teamProgress(contest.id, team.name, getSubmissions());
  const res = {
    ok: true,
    serverTime: t.serverTime,
    state: t.state,
    round: round,
    currentRound: prog.currentRound,
    finished: prog.currentRound > totalRounds,
    stale: false,
  };
  if (res.finished || round !== prog.currentRound) { res.stale = true; return res; }
  // Same window as submissions: while running, plus the short grace period after the end.
  const open = t.state === 'running' || (t.state === 'ended' && t.serverTime <= contest.endTime + GRACE_SECONDS * 1000);
  if (!open) return res;

  // No script-wide lock for saving: a device writes only the cells it changed, so drafts from many teams never
  // queue behind each other (or behind a round submission). Only creating a team's draft row takes the lock.
  draftsSheet();   // make sure the tab exists before any lock is taken below
  const changes = parseDraftChanges(p.changes);
  if (changes) writeDraft(contest.id, team.name, round, changes, p.device);
  const d = draftFor(contest.id, team.name, round);
  res.answers = d.answers;
  res.stamps = d.stamps;
  res.devices = d.devices;
  return res;
}

/** Public: ranking with total scores only (no per-problem detail), if the contest allows it. */
function leaderboard(p) {
  const contest = findContest(p.contest);
  if (!contest) throw authError('Unknown contest.');
  if (!contest.showLeaderboard) {
    const e = new Error('The organizers have hidden the leaderboard for this contest.');
    e.hidden = true;
    throw e;
  }
  const probs = contestProblems(getProblems(), contest.id);
  const rows = computeScores(contest.id, probs, getTeams(), getSubmissions()).map(function (t) {
    return { team: t.name, score: t.score };
  });
  return Object.assign({ ok: true, contestTitle: contest.title, contest: contest.id, totalRounds: countRounds(probs), rows: rows }, timeInfo(contest));
}

/** Organizers: everything for one contest (answers, every team and person, all submissions) plus an overview of all contests. */
function admin(p) {
  const cfg = getConfig();
  if (!cfg.adminPassword) throw authError('Set admin_password in the Config tab first.');
  if (String(p.password == null ? '' : p.password) !== cfg.adminPassword) throw authError('Wrong admin password.');

  const contests = getContests();
  const probs = getProblems();
  const teams = getTeams();
  const subs = getSubmissions();
  const overview = contests.map(function (c) {
    return Object.assign(publicContest(c, probs), {
      passcode: c.passcode,
      teams: teams.filter(function (t) { return t.contest === c.id; }).length,
      submissions: subs.filter(function (s) { return s.contest === c.id; }).length,
    });
  });
  const wanted = normId(p.contest);
  const selected = contests.filter(function (c) { return c.id === wanted; })[0] || contests[0] || null;
  const res = { ok: true, siteName: cfg.siteName, serverTime: Date.now(), problemsPerRound: PROBLEMS_PER_ROUND, contests: overview, selected: null };
  if (selected) {
    const cp = contestProblems(probs, selected.id);
    res.selected = Object.assign(publicContest(selected, probs), {
      passcode: selected.passcode,
      problems: cp,
      teams: teams.filter(function (t) { return t.contest === selected.id; }).map(function (t) {
        return { contest: t.contest, name: t.name, registeredAt: t.registeredAt, members: t.members, email: t.email };   // never the password
      }),
      submissions: subs.filter(function (s) { return s.contest === selected.id; }),
    });
  }
  return res;
}

// ============================================================================
// Contests
// ============================================================================

function getContests() {
  const hit = cacheGet('contests');
  if (hit) return JSON.parse(hit);
  const C = COL.contests;
  const rows = sheet(SHEET.contests).getDataRange().getValues().slice(1);
  const list = rows.filter(function (r) { return cell(r[C.id]) !== ''; }).map(function (r) {
    const startTime = parseStart(r[C.start], cell(r[C.id]));
    const durationMinutes = Number(cell(r[C.duration])) || 60;
    return {
      id: normId(r[C.id]),
      title: cell(r[C.title]) || cell(r[C.id]),
      passcode: cell(r[C.passcode]),
      startTime: startTime,
      endTime: startTime == null ? null : startTime + durationMinutes * 60000,
      durationMinutes: durationMinutes,
      openRegistration: isTrue(r[C.openReg]),
      showLeaderboard: cell(r[C.leaderboard]) === '' ? true : isTrue(r[C.leaderboard]),
    };
  });
  cachePut('contests', JSON.stringify(list), CONFIG_CACHE_SECONDS);
  return list;
}

function findContest(id) {
  const key = normId(id);
  if (!key) return null;
  return getContests().filter(function (c) { return c.id === key; })[0] || null;
}

/** The contest named in the request, after checking its passcode. */
function requireContest(p) {
  const contest = findContest(p.contest);
  if (!contest) throw authError('Please choose a contest.');
  if (contest.passcode && contest.passcode.toLowerCase() !== cell(p.passcode).toLowerCase()) {
    throw authError('Incorrect contest passcode.');
  }
  return contest;
}

function timeInfo(contest) {
  const serverTime = Date.now();
  let state = 'unscheduled';
  if (contest.startTime != null) {
    state = serverTime < contest.startTime ? 'before' : serverTime < contest.endTime ? 'running' : 'ended';
  }
  return { serverTime: serverTime, startTime: contest.startTime, endTime: contest.endTime, state: state };
}

function parseStart(v, label) {
  if (v instanceof Date) return v.getTime();
  const s = cell(v);
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new Error('Start time of contest "' + label + '" is not a valid date/time: "' + s + '". Use e.g. 2026-11-07T14:00:00-05:00');
  }
  return d.getTime();
}

// ============================================================================
// Teams & progress
// ============================================================================

/** The team password from a request. (Older pages sent it as "code".) */
function passwordOf(p) {
  return cell(p.password != null ? p.password : p.code);
}

/**
 * Who is calling?
 *   mode 'signup'  create the team; refused if the name is already taken in this contest (so a team can't
 *                  register twice), or if the contest is closed to new teams.
 *   mode 'login'   the team must exist and the password must match. A team the organizers created by hand has
 *                  no members/email on file yet, so its first login has to supply them (needsInfo).
 *   mode null      state / submit / draft calls: just check team name + password.
 */
function authenticate(p, contest, mode) {
  const name = cell(p.team).normalize('NFC').replace(/\s+/g, ' ');
  const password = passwordOf(p);
  if (!name) throw authError('Please enter a team name.');
  if (name.length > 40) throw authError('Team name is too long (40 characters max).');
  if (!password) throw authError('Please enter your team password.');

  if (mode === 'signup') return signUp(p, contest, name, password);

  const team = findTeam(contest.id, name);
  if (!team) {
    throw authError(contest.openRegistration
      ? 'No team with that name in this contest. Check the spelling, or use Sign up if your team is new.'
      : 'No team with that name in this contest. Check the spelling, or ask the organizers.');
  }
  if (!team.password) throw authError('This team has no password yet. Ask the organizers to fill in its Password cell.');
  if (team.password.toLowerCase() !== password.toLowerCase()) throw authError('Incorrect team password.');
  if (mode === 'login') completeProfile(p, team);
  return team;
}

/** Creates a team. The first person on a team does this once; everyone else logs in. */
function signUp(p, contest, name, password) {
  if (!contest.openRegistration) {
    throw authError('New teams cannot sign up for this contest. Use Log in with the team name and password the organizers gave you.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) throw authError('Please choose a password of at least ' + MIN_PASSWORD_LENGTH + ' characters.');
  if (password.length > MAX_PASSWORD_LENGTH) throw authError('Password is too long (' + MAX_PASSWORD_LENGTH + ' characters max).');
  if (p.confirm != null && cell(p.confirm) !== password) throw authError('The two passwords do not match.');
  const info = parseMemberInfo(p);   // validate everything before touching the sheet

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (findTeam(contest.id, name)) {   // checked inside the lock, so two simultaneous sign-ups can't both win
      throw authError('A team named "' + name + '" has already signed up for this contest. If that is your team, choose Log in and enter its password.');
    }
    const slots = info.given.slice(0, MAX_MEMBERS);
    while (slots.length < MAX_MEMBERS) slots.push('');
    const row = [asText(contest.id), asText(name), asText(password), new Date()].concat(slots.map(asText), [asText(info.email)]);
    sheet(SHEET.teams).appendRow(row);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return findTeam(contest.id, name);
}

/** First login of a team the organizers created by hand: it still needs member names + a contact email. */
function completeProfile(p, team) {
  if (team.members.length && team.email) return;
  const supplied = (Array.isArray(p.members) && p.members.some(function (m) { return cell(m); })) || cell(p.email);
  let info;
  try {
    info = parseMemberInfo(p);
  } catch (err) {
    const e = new Error(supplied ? err.message : 'First login for this team: please add at least one team member\'s name and a contact email.');
    e.needsInfo = true;
    throw e;
  }
  recordMembers(team, info);
}

function parseTeamRow(r, rowNumber) {
  const T = COL.teams;
  const members = [];
  for (let i = 0; i < MAX_MEMBERS; i++) { const m = cell(r[T.member1 + i]); if (m) members.push(m); }
  return {
    contest: normId(r[T.contest]),
    name: cell(r[T.name]),
    password: cell(r[T.password]),
    registeredAt: toMillis(r[T.registered]),
    members: members,
    email: cell(r[T.email]),
    row: rowNumber,
  };
}

function getTeams() {
  const rows = sheet(SHEET.teams).getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (cell(rows[i][COL.teams.name]) !== '') out.push(parseTeamRow(rows[i], i + 1));
  }
  return out;
}

function findTeam(contestId, name) {
  const key = normName(name);
  const cid = normId(contestId);
  return getTeams().filter(function (t) { return t.contest === cid && normName(t.name) === key; })[0] || null;
}

function parseMemberInfo(p) {
  const given = (Array.isArray(p.members) ? p.members : [])
    .map(function (m) { return cell(m).replace(/\s+/g, ' ').slice(0, 60); })
    .filter(Boolean);
  const email = cell(p.email).slice(0, 120);
  if (!given.length) throw authError('Please enter at least one team member\'s name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw authError('Please enter a valid email address.');
  return { given: given, email: email };
}

/**
 * Saves member names + email into an existing team's row (used when an organizer-created team first logs in).
 * Names are merged, never overwritten; the most recently entered email wins.
 */
function recordMembers(team, info) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet(SHEET.teams);
    const current = findTeam(team.contest, team.name) || team;
    const merged = (current.members || []).slice();
    info.given.forEach(function (m) {
      const dup = merged.some(function (e) { return e.toLowerCase() === m.toLowerCase(); });
      if (!dup && merged.length < MAX_MEMBERS) merged.push(m);
    });
    const slots = merged.slice();
    while (slots.length < MAX_MEMBERS) slots.push('');
    sh.getRange(current.row, COL.teams.member1 + 1, 1, MAX_MEMBERS + 1).setValues([slots.map(asText).concat([asText(info.email)])]);
    SpreadsheetApp.flush();
    team.members = merged;
    team.email = info.email;
  } finally {
    lock.releaseLock();
  }
}

function teamProgress(contestId, teamName, subs) {
  const key = normName(teamName);
  const cid = normId(contestId);
  const rounds = subs.filter(function (s) { return s.contest === cid && normName(s.team) === key; })
    .map(function (s) { return s.round; })
    .sort(function (a, b) { return a - b; });
  const maxRound = rounds.length ? rounds[rounds.length - 1] : 0;
  return { currentRound: maxRound + 1, submittedRounds: rounds };
}

function getSubmissions() {
  const rows = sheet(SHEET.submissions).getDataRange().getValues().slice(1);
  const K = PROBLEMS_PER_ROUND;
  const S = COL.subs;
  return rows.filter(function (r) { return cell(r[S.team]) !== ''; }).map(function (r) {
    return {
      time: toMillis(r[S.time]),
      contest: normId(r[S.contest]),
      team: cell(r[S.team]),
      round: Number(cell(r[S.round])),
      answers: r.slice(S.answers, S.answers + K).map(cell),
      correct: r.slice(S.answers + K, S.answers + 2 * K).map(isTrue),
      points: Number(cell(r[S.answers + 2 * K])) || 0,
      elapsed: Number(cell(r[S.answers + 2 * K + 1])) || 0,
    };
  });
}

/** Total scores per team, recomputed from the Correct flags so manual overrides in the sheet count. */
function computeScores(contestId, probs, teams, subs) {
  const cid = normId(contestId);
  const ptsOf = {};
  probs.forEach(function (q) { ptsOf[q.round + ':' + q.n] = q.points; });
  const map = {};
  const order = [];
  const get = function (name) {
    const k = normName(name);
    if (!map[k]) { map[k] = { name: name, score: 0, last: 0, maxRound: 0 }; order.push(map[k]); }
    return map[k];
  };
  teams.filter(function (t) { return t.contest === cid; }).forEach(function (t) { get(t.name); });
  subs.filter(function (s) { return s.contest === cid; }).forEach(function (s) {
    const t = get(s.team);
    s.correct.forEach(function (c, i) { if (c) t.score += ptsOf[s.round + ':' + (i + 1)] || 0; });
    t.last = Math.max(t.last, s.time || 0);
    t.maxRound = Math.max(t.maxRound, s.round);
  });
  return order.sort(function (a, b) {
    return b.score - a.score || (a.last || Infinity) - (b.last || Infinity) || a.name.localeCompare(b.name);
  });
}

// ============================================================================
// Drafts: unsubmitted answers, shared by all devices of a team
// ============================================================================

/**
 * The Drafts tab; created on first use if setup() has not been run since upgrading. Creation takes the lock so
 * simultaneous first requests can't both try to insert it. (Callers must not hold the lock when the tab may
 * still be missing — draftSync makes sure it exists before taking any lock.)
 */
function draftsSheet() {
  const ss = spreadsheet();
  const sh = ss.getSheetByName(SHEET.drafts);
  if (sh) return sh;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return ss.getSheetByName(SHEET.drafts) || createDraftsSheet(ss);
  } finally {
    lock.releaseLock();
  }
}

/** Number of rounds of a contest. Cached briefly: a draft poll needs only this, not every problem text. */
function roundsOf(contestId) {
  const key = 'rounds:' + normId(contestId);
  const hit = cacheGet(key);
  if (hit) return Number(hit);
  const n = countRounds(contestProblems(getProblems(), contestId));
  cachePut(key, String(n), PROBLEMS_CACHE_SECONDS);
  return n;
}

function createDraftsSheet(ss) {
  const sh = ss.insertSheet(SHEET.drafts);
  const K = PROBLEMS_PER_ROUND;
  const D = COL.drafts;
  const h = ['Contest', 'Team', 'Round'];
  const widths = [90, 180, 60];
  for (let i = 1; i <= K; i++) {
    h.push('Draft ' + i, 'Stamp ' + i, 'Device ' + i);
    widths.push(160, 110, 90);
  }
  sh.getRange('A:B').setNumberFormat('@');
  for (let i = 0; i < K; i++) {
    sh.getRange(1, D.fields + 3 * i + 1, sh.getMaxRows(), 1).setNumberFormat('@');       // Draft: text
    sh.getRange(1, D.fields + 3 * i + 2, sh.getMaxRows(), 1).setNumberFormat('0');       // Stamp: whole number
  }
  sh.getRange(1, 1, 1, h.length).setValues([h]);
  styleHeader(sh, widths);
  return sh;
}

/** Finds a team's draft row for a round. Returns { row, answers, stamps, devices } (row 0 = none yet). */
function findDraft(contestId, teamName, round) {
  const D = COL.drafts;
  const K = PROBLEMS_PER_ROUND;
  const cid = normId(contestId);
  const key = normName(teamName);
  const rows = draftsSheet().getDataRange().getValues();
  const out = { row: 0, answers: [], stamps: [], devices: [] };
  for (let i = 0; i < K; i++) { out.answers.push(''); out.stamps.push(0); out.devices.push(''); }
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (normId(r[D.contest]) === cid && normName(r[D.team]) === key && Number(cell(r[D.round])) === round) {
      out.row = i + 1;
      for (let k = 0; k < K; k++) {
        const base = D.fields + 3 * k;
        out.answers[k] = cell(r[base]);
        out.stamps[k] = Number(cell(r[base + 1])) || 0;
        out.devices[k] = cell(r[base + 2]);
      }
      break;
    }
  }
  return out;
}

/**
 * What a team has typed so far in a round: { round, answers: [K strings], stamps: [K edit times],
 * devices: [K ids of the device that wrote each problem] }. A device uses "devices" to notice that a teammate
 * is typing somewhere else.
 */
function draftFor(contestId, teamName, round) {
  const d = findDraft(contestId, teamName, round);
  return { round: round, answers: d.answers, stamps: d.stamps, devices: d.devices };
}

/**
 * Reads p.changes into { index: { text, t } } for valid problem positions, or null if there are none.
 * Each entry is { v: "text", t: ms-when-typed } or just the text; t is optional.
 */
function parseDraftChanges(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let n = 0;
  Object.keys(raw).forEach(function (k) {
    const i = Number(k);
    if (!(i >= 0 && i < PROBLEMS_PER_ROUND) || Math.floor(i) !== i) return;
    const e = raw[k];
    const isObj = e && typeof e === 'object';
    const text = cell(String((isObj ? e.v : e) == null ? '' : (isObj ? e.v : e)).slice(0, MAX_ANSWER_LENGTH));
    const t = isObj ? Number(e.t) : NaN;
    out[i] = { text: text, t: isFinite(t) && t > 0 ? t : null };
    n++;
  });
  return n ? out : null;
}

/**
 * Stores changed problems. Only the three cells of a changed problem are written and no lock is held (see
 * draftSync), so saves from different devices never overwrite each other's problems. An edit is stamped with
 * the time it was typed (never later than now); if the stored text is newer than that, the edit is dropped.
 * If two devices still manage to write the same problem at the same instant, whichever write lands last stays
 * and every device converges on it at its next poll.
 */
function writeDraft(contestId, teamName, round, changes, device) {
  const D = COL.drafts;
  const cur = ensureDraftRow(contestId, teamName, round);
  const sh = draftsSheet();
  const who = String(device == null ? '' : device).replace(/[^\w-]/g, '').slice(0, 20);
  const now = Date.now();
  Object.keys(changes).forEach(function (k) {
    const i = Number(k);
    const c = changes[i];
    if (c.text === cur.answers[i]) return;                       // nothing new (nothing is echoed to other devices)
    const stamp = c.t == null ? Math.max(now, cur.stamps[i] + 1) : Math.min(c.t, now);
    if (stamp < cur.stamps[i]) return;                           // a newer edit of this problem is already stored
    sh.getRange(cur.row, D.fields + 3 * i + 1, 1, 3).setValues([[asText(c.text), stamp, asText(who)]]);
  });
}

/** The draft row of this team and round, created if needed. Creating it is the only step that takes the lock. */
function ensureDraftRow(contestId, teamName, round) {
  const cur = findDraft(contestId, teamName, round);
  if (cur.row) return cur;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const again = findDraft(contestId, teamName, round);   // a teammate's device may have created it a moment ago
    if (again.row) return again;
    const sh = draftsSheet();
    const row = [asText(normId(contestId)), asText(cell(teamName)), round];
    for (let i = 0; i < PROBLEMS_PER_ROUND * 3; i++) row.push('');
    sh.appendRow(row);
    SpreadsheetApp.flush();
    again.row = sh.getLastRow();
    return again;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Blanks a round's draft once the round has been submitted. The row itself stays, so row numbers never shift
 * under a concurrent save. Call while holding the script lock.
 */
function clearDraft(contestId, teamName, round) {
  const cur = findDraft(contestId, teamName, round);
  if (!cur.row) return;
  const blanks = [];
  for (let i = 0; i < PROBLEMS_PER_ROUND * 3; i++) blanks.push('');
  draftsSheet().getRange(cur.row, COL.drafts.fields + 1, 1, blanks.length).setValues([blanks]);
}

// ============================================================================
// Config & problems (cached briefly so the start-time rush stays fast)
// ============================================================================

function getConfig() {
  const hit = cacheGet('config');
  if (hit) return JSON.parse(hit);
  const rows = sheet(SHEET.config).getDataRange().getValues();
  const raw = {};
  rows.forEach(function (r) {
    const k = cell(r[0]).toLowerCase();
    if (k) raw[k] = r[1];
  });
  const cfg = {
    adminPassword: cell(raw.admin_password),
    siteName: cell(raw.site_name) || 'Contests',
  };
  cachePut('config', JSON.stringify(cfg), CONFIG_CACHE_SECONDS);
  return cfg;
}

function getProblems() {
  const hit = cacheGet('problems');
  if (hit) return JSON.parse(hit);
  const P = COL.problems;
  const rows = sheet(SHEET.problems).getDataRange().getValues().slice(1);
  const list = rows
    .filter(function (r) { return cell(r[P.round]) !== '' && cell(r[P.n]) !== ''; })
    .map(function (r) {
      return {
        contest: normId(r[P.contest]),
        round: Number(cell(r[P.round])),
        n: Number(cell(r[P.n])),
        text: cell(r[P.text]),
        answers: cell(r[P.answers]),
        points: Number(cell(r[P.points])) || 0,
        image: cell(r[P.image]),
      };
    })
    .filter(function (q) { return q.round > 0 && q.n > 0; });
  cachePut('problems', JSON.stringify(list), PROBLEMS_CACHE_SECONDS);
  return list;
}

function contestProblems(probs, contestId) {
  const cid = normId(contestId);
  return probs.filter(function (q) { return q.contest === cid; });
}

function countRounds(probs) {
  return probs.reduce(function (m, q) { return Math.max(m, q.round); }, 0);
}

function roundProblems(probs, round) {
  return probs.filter(function (q) { return q.round === round; })
    .sort(function (a, b) { return a.n - b.n; });
}

// ============================================================================
// Grading
// ============================================================================

/** True if `given` matches any of the `|`-separated accepted answers after normalization. */
function isCorrect(given, accepted) {
  const g = normalizeAnswer(given);
  if (!g) return false;
  return String(accepted == null ? '' : accepted).split('|').some(function (alt) {
    const a = normalizeAnswer(alt);
    if (!a) return false;
    if (a === g) return true;
    const na = toNumber(a);
    const ng = toNumber(g);
    return na !== null && ng !== null && Math.abs(na - ng) <= 1e-9 * Math.max(1, Math.abs(na));
  });
}

/**
 * Collapse common equivalent spellings: \frac{1}{2} = 1/2, 2\sqrt{5} = 2\sqrt5, 45^\circ = 45,
 * x^{2} = x^2, \text{none} = none, $...$ wrappers, spacing, case, trailing period.
 * Both the accepted answer and the submitted answer go through this, so it only has to be consistent.
 */
function normalizeAnswer(s) {
  let t = cell(s);
  if (!t) return '';
  t = t.replace(/\$/g, '');
  t = t.replace(/\\[dt]frac\b/g, '\\frac');
  t = t.replace(/\\(left|right|displaystyle|textstyle|boxed|textrm|textbf|textit|text|mathrm|mathbf|mathit|operatorname)\b\s*/g, '');
  t = t.replace(/\\[,;!: ]/g, '').replace(/\\q?quad\b/g, '').replace(/~/g, '');
  t = t.replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)').replace(/\\sqrt\s*(\d)/g, 'sqrt($1)');
  const token = function (x) { return /^[-+]?[a-z0-9.\\]+(\([^()]*\))?$/i.test(x) ? x : '(' + x + ')'; };
  const frac = /\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
  const fracRepl = function (m, a, b) { return token(a.trim()) + '/' + token(b.trim()); };
  t = t.replace(frac, fracRepl).replace(frac, fracRepl);
  t = t.replace(/\\frac\s*(\d)\s*(\d)/g, '$1/$2');
  t = t.replace(/\\(cdot|times)\b/g, '*').replace(/\\div\b/g, '/');
  t = t.replace(/\\(leq|le)\b/g, '<=').replace(/\\(geq|ge)\b/g, '>=').replace(/\\(neq|ne)\b/g, '!=');
  t = t.replace(/\\infty\b/g, 'inf');
  t = t.replace(/\\?[{}]/g, '');
  t = t.replace(/\^\s*\\circ\b|\\degree\b|°/g, '');
  t = t.replace(/\\%/g, '%');
  t = t.replace(/\\([a-zA-Z]+)/g, '$1');
  t = t.replace(/\s+/g, '');
  t = t.replace(/\(([-a-z0-9.]+)\)/gi, '$1');
  t = t.replace(/^\(([^()]*)\)$/, '$1');
  t = t.replace(/\.$/, '').replace(/^\+/, '');
  return t.toLowerCase();
}

function toNumber(s) {
  const x = s.replace(/,/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(x)) return null;
  const n = Number(x);
  return isFinite(n) ? n : null;
}

// ============================================================================
// Sheet helpers
// ============================================================================

let _ss = null;
function spreadsheet() {
  if (_ss) return _ss;
  _ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!_ss) throw new Error('Spreadsheet not found. Attach this script to a sheet (Extensions → Apps Script) or set SPREADSHEET_ID.');
  return _ss;
}

function sheet(name) {
  const sh = spreadsheet().getSheetByName(name);
  if (!sh) throw new Error('The "' + name + '" tab is missing. In the Apps Script editor, run setup() once.');
  return sh;
}

/** Cell value as trimmed text (strips the apostrophe Sheets uses to force text). */
function cell(v) {
  return v == null ? '' : String(v).replace(/^'/, '').trim();
}

/** Force a value to be stored as text so "1/2" is not turned into a date and "=..." is not a formula. */
function asText(s) {
  return s === '' ? '' : "'" + s;
}

function isTrue(v) {
  return v === true || /^(true|yes|y|1)$/i.test(String(v == null ? '' : v).trim());
}

function toMillis(v) {
  if (v instanceof Date) return v.getTime();
  const s = cell(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function normName(s) {
  // NFC first, so "Café" typed with a precomposed é and with e + combining accent is the same team name.
  return cell(s).normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
}

/** Contest IDs are compared case-insensitively and ignoring spaces. */
function normId(s) {
  return cell(s).toLowerCase().replace(/\s+/g, '');
}

// ============================================================================
// One-time setup / upgrade, and the "Contest" menu in the spreadsheet
// ============================================================================

const DEFAULT_CONTEST_ID = 'contest1';   // ID given to existing data when upgrading an older single-contest sheet

/**
 * Run this once from the Apps Script editor. Creates the tabs, or upgrades the tabs of an older
 * single-contest sheet in place: a Contest column is added to Problems/Teams/Submissions and the old
 * Config schedule becomes the first row of the new Contests tab. Nothing is deleted.
 */
function setup() {
  const ss = spreadsheet();
  const notes = [];

  // ---- Config (and the old per-contest settings it may still hold) ----
  const cfg = getOrCreateSheet(ss, SHEET.config);
  const oldConfig = {};
  if (cfg.getLastRow() === 0) {
    cfg.getRange('B:B').setNumberFormat('@');
    cfg.getRange(1, 1, 3, 3).setValues([
      ['Setting', 'Value', 'Notes'],
      ['admin_password', 'change-me', 'Needed to open admin.html. Change it! Every organizer uses this same password.'],
      ['site_name', 'Math Contests', 'Shown on the login and leaderboard pages before a contest is chosen.'],
    ]);
    styleHeader(cfg, [160, 300, 620]);
    cfg.getRange(2, 3, 2, 1).setWrap(true);
  } else {
    const rows = cfg.getDataRange().getValues();
    const moved = ['contest_name', 'start_time', 'duration_minutes', 'open_registration'];
    for (let i = rows.length - 1; i >= 1; i--) {
      const k = cell(rows[i][0]).toLowerCase();
      if (moved.indexOf(k) >= 0) {
        oldConfig[k] = rows[i][1];
        cfg.deleteRow(i + 1);
      }
    }
    if (!rows.some(function (r) { return cell(r[0]).toLowerCase() === 'site_name'; })) {
      cfg.appendRow(['site_name', 'Math Contests', 'Shown on the login and leaderboard pages before a contest is chosen.']);
    }
  }

  // ---- Contests ----
  const ct = getOrCreateSheet(ss, SHEET.contests);
  if (ct.getLastRow() === 0) {
    ct.getRange('A:D').setNumberFormat('@');
    const header = ['ID', 'Title', 'Passcode', 'Start time', 'Duration (min)', 'Open registration', 'Show leaderboard', 'Notes'];
    const migrating = Object.keys(oldConfig).length > 0;
    const first = migrating
      ? [DEFAULT_CONTEST_ID, cell(oldConfig.contest_name) || 'Math Contest', '',
         oldConfig.start_time instanceof Date ? oldConfig.start_time.toISOString() : cell(oldConfig.start_time),
         Number(cell(oldConfig.duration_minutes)) || 60, isTrue(oldConfig.open_registration) ? 'TRUE' : 'FALSE', 'TRUE',
         'Upgraded from the old single-contest setup. Add a passcode if you want one.']
      : ['sample', 'Sample Contest', 'pumpkin', '2026-11-07T14:00:00-05:00', 60, 'FALSE', 'TRUE', 'Example row — replace me.'];
    ct.getRange(1, 1, 2, header.length).setValues([header, first]);
    ct.getRange(3, 1, 1, header.length).setValues([['', '', '', '', '', '', '',
      'ID: short, no spaces, used in links (leaderboard.html?contest=ID). Title: shown to participants. ' +
      'Passcode: participants must enter it to sign up or log in (blank = none). Start time: ISO with UTC offset, e.g. 2026-11-07T14:00:00-05:00. ' +
      'Open registration: TRUE lets teams create themselves with Sign up (one sign-up per team name; teammates then Log in). ' +
      'FALSE means only teams listed in the Teams tab can log in. Show leaderboard: FALSE hides the public leaderboard.']]);
    styleHeader(ct, [110, 220, 120, 230, 110, 130, 130, 520]);
    ct.getRange(2, 8, 2, 1).setWrap(true);
    if (migrating) notes.push('Moved the old contest settings from Config into the Contests tab as contest "' + DEFAULT_CONTEST_ID + '".');
  }

  // ---- Problems ----
  const pr = getOrCreateSheet(ss, SHEET.problems);
  if (pr.getLastRow() === 0) {
    pr.getRange('A:A').setNumberFormat('@');
    pr.getRange('D:E').setNumberFormat('@');
    pr.getRange('G:G').setNumberFormat('@');
    const rows = [['Contest', 'Round', 'Problem #', 'Problem (LaTeX between $...$)', 'Accepted answer(s) — alternatives separated by |', 'Points', 'Image URL (optional)']];
    for (let r = 1; r <= 8; r++) {
      for (let n = 1; n <= PROBLEMS_PER_ROUND; n++) {
        rows.push(['sample', r, n,
          'Sample problem ' + r + '.' + n + ': Compute $' + r + ' \\times ' + n + ' + \\frac{1}{2} \\cdot 2$. (Replace me with a real problem.)',
          String(r * n + 1), 4 + Math.ceil(r / 2), '']);
      }
    }
    pr.getRange(1, 1, rows.length, 7).setValues(rows);
    styleHeader(pr, [90, 60, 80, 520, 280, 60, 240]);
    pr.getRange(2, 4, rows.length - 1, 1).setWrap(true);
  } else if (cell(pr.getRange(1, 1).getValue()).toLowerCase() !== 'contest') {
    addContestColumn(pr, 1, 2);
    notes.push('Added a Contest column to the Problems tab.');
  }

  // ---- Teams ----
  const tm = getOrCreateSheet(ss, SHEET.teams);
  if (tm.getLastRow() === 0) {
    tm.getRange('A:C').setNumberFormat('@');
    const header = ['Contest', 'Team Name', 'Password', 'Registered At'];
    for (let i = 1; i <= MAX_MEMBERS; i++) header.push('Member ' + i);
    header.push('Email');
    const blanks = header.map(function () { return ''; });
    const t1 = blanks.slice(); t1[0] = 'sample'; t1[1] = 'Test Team'; t1[2] = 'test123';
    const t2 = blanks.slice(); t2[0] = 'sample'; t2[1] = 'Another Team'; t2[2] = 'abc456';
    tm.getRange(1, 1, 3, header.length).setValues([header, t1, t2]);
    const widths = [90, 220, 160, 180];
    for (let i = 0; i < MAX_MEMBERS; i++) widths.push(160);
    widths.push(240);
    styleHeader(tm, widths);
  } else {
    if (cell(tm.getRange(1, 1).getValue()).toLowerCase() !== 'contest') {
      addContestColumn(tm, 1, 2);
      notes.push('Added a Contest column to the Teams tab.');
    }
    if (cell(tm.getRange(1, COL.teams.member1 + 1).getValue()) === '') {
      const h = [];
      for (let i = 1; i <= MAX_MEMBERS; i++) h.push('Member ' + i);
      h.push('Email');
      tm.getRange(1, COL.teams.member1 + 1, 1, h.length).setValues([h]).setFontWeight('bold');
    }
    const pwHeader = tm.getRange(1, COL.teams.password + 1);
    if (/^(access )?code$/i.test(cell(pwHeader.getValue()))) {
      pwHeader.setValue('Password');
      notes.push('Renamed the Teams column "Access Code" to "Password" (existing codes keep working as passwords).');
    }
  }

  // ---- Drafts (the typed-but-unsubmitted answers shared between a team's devices) ----
  if (!ss.getSheetByName(SHEET.drafts)) {
    createDraftsSheet(ss);
    notes.push('Added a Drafts tab (used to keep a team\'s devices in sync; you normally never need to touch it).');
  }

  // ---- Submissions ----
  const sb = getOrCreateSheet(ss, SHEET.submissions);
  if (sb.getLastRow() === 0) {
    const h = ['Timestamp', 'Contest', 'Team', 'Round'];
    for (let i = 1; i <= PROBLEMS_PER_ROUND; i++) h.push('Answer ' + i);
    for (let i = 1; i <= PROBLEMS_PER_ROUND; i++) h.push('Correct ' + i);
    h.push('Points', 'Elapsed (min)');
    sb.getRange(1, 1, 1, h.length).setValues([h]);
    sb.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    const widths = [170, 90, 180, 60];
    for (let i = 0; i < PROBLEMS_PER_ROUND; i++) widths.push(160);
    for (let i = 0; i < PROBLEMS_PER_ROUND; i++) widths.push(80);
    widths.push(70, 100);
    styleHeader(sb, widths);
  } else if (cell(sb.getRange(1, 2).getValue()).toLowerCase() !== 'contest') {
    addContestColumn(sb, 2, 3);
    notes.push('Added a Contest column to the Submissions tab.');
  }

  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  clearCache();
  const msg = (notes.length ? notes.join('\n') + '\n\n' : '') +
    'Setup complete. Fill in the Config, Contests, Problems and Teams tabs, then deploy as a web app (or redeploy a new version).';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* run from the editor; see the log */ }
}

/** Insert a "Contest" column at position `col` (1-based) and fill it for every data row that has text in `dataCol`. */
function addContestColumn(sh, col, dataCol) {
  sh.insertColumnBefore(col);
  sh.getRange(1, col).setValue('Contest').setFontWeight('bold');
  sh.getRange(1, col, sh.getMaxRows(), 1).setNumberFormat('@');
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    const data = sh.getRange(2, dataCol, n, 1).getValues();
    sh.getRange(2, col, n, 1).setValues(data.map(function (r) { return [cell(r[0]) === '' ? '' : DEFAULT_CONTEST_ID]; }));
  }
  sh.setColumnWidth(col, 90);
}

function getOrCreateSheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function styleHeader(sh, widths) {
  sh.getRange(1, 1, 1, widths.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
}

/** Adds a "Contest" menu to the spreadsheet. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Contest')
    .addItem('Set up / upgrade sheets', 'setup')
    .addItem('Check setup', 'checkSetup')
    .addItem('Apply edits now (clear cache)', 'clearCache')
    .addSeparator()
    .addItem('Delete submissions of one contest…', 'deleteContestSubmissions')
    .addItem('Delete ALL submissions…', 'deleteAllSubmissions')
    .addToUi();
}

function clearCache() {
  const keys = ['config', 'contests', 'problems'];
  const hit = cacheGet('contests');
  if (hit) JSON.parse(hit).forEach(function (c) { keys.push('rounds:' + c.id); });
  CacheService.getScriptCache().removeAll(keys);
}

/**
 * CacheService refuses values over 100 KB ("Argument too large: value"), which happens once the
 * Image column holds a few SVGs. Caching is only an optimization, so just skip it when it fails:
 * the data is read from the sheet on every request instead (a few hundred ms slower).
 */
function cachePut(key, value, seconds) {
  try {
    CacheService.getScriptCache().put(key, value, seconds);
  } catch (err) {
    /* too large (or cache unavailable) — serve uncached */
  }
}

function cacheGet(key) {
  try {
    return CacheService.getScriptCache().get(key);
  } catch (err) {
    return null;
  }
}

/** Sanity-checks the sheets and reports problems. Safe to run any time. */
function checkSetup() {
  clearCache();
  const lines = [];
  const cfg = getConfig();
  const contests = getContests();
  const probs = getProblems();
  const teams = getTeams();
  lines.push('Admin password set: ' + (cfg.adminPassword ? 'yes' : 'NO — set admin_password in Config'));
  lines.push('Contests: ' + contests.length);
  if (!contests.length) lines.push('  WARNING: no contests in the Contests tab');
  const seen = {};
  contests.forEach(function (c) {
    if (seen[c.id]) lines.push('  WARNING: duplicate contest ID "' + c.id + '"');
    seen[c.id] = true;
    lines.push('');
    lines.push('[' + c.id + '] ' + c.title);
    lines.push('  Start: ' + (c.startTime != null ? new Date(c.startTime).toString() : 'NOT SET') + ', ' + c.durationMinutes + ' min');
    lines.push('  Passcode: ' + (c.passcode ? 'yes' : 'none') + ', open registration: ' + c.openRegistration + ', leaderboard: ' + (c.showLeaderboard ? 'shown' : 'hidden'));
    const cp = contestProblems(probs, c.id);
    const rounds = countRounds(cp);
    lines.push('  Rounds: ' + rounds + ' (' + cp.length + ' problems)');
    if (!cp.length) lines.push('  WARNING: no problems for this contest');
    for (let r = 1; r <= rounds; r++) {
      const qs = roundProblems(cp, r);
      if (qs.length !== PROBLEMS_PER_ROUND) {
        lines.push('  WARNING: round ' + r + ' has ' + qs.length + ' problems (expected ' + PROBLEMS_PER_ROUND + ')');
      }
      qs.forEach(function (q) {
        if (!q.answers) lines.push('  WARNING: round ' + r + ' problem ' + q.n + ' has no accepted answer');
      });
    }
    const ct = teams.filter(function (t) { return t.contest === c.id; });
    lines.push('  Teams: ' + ct.length);
    ct.forEach(function (t) { if (!t.password) lines.push('  WARNING: team "' + t.name + '" has no password'); });
    if (!c.openRegistration && !ct.length) lines.push('  WARNING: registration is closed and the Teams tab has no teams for this contest');
  });
  probs.forEach(function (q) {
    if (!seen[q.contest]) lines.push('WARNING: problem round ' + q.round + ' #' + q.n + ' belongs to unknown contest "' + q.contest + '"');
  });
  teams.forEach(function (t) {
    if (!seen[t.contest]) lines.push('WARNING: team "' + t.name + '" belongs to unknown contest "' + t.contest + '"');
  });
  const out = lines.join('\n');
  Logger.log(out);
  try { SpreadsheetApp.getUi().alert(out); } catch (e) { /* not run from the sheet; see the log */ }
  return out;
}

/** Clears the Submissions tab for one contest (its teams restart from round 1). Run from the Contest menu. */
function deleteContestSubmissions() {
  const ui = SpreadsheetApp.getUi();
  const ans = ui.prompt('Delete submissions of one contest', 'Contest ID (as in the Contests tab):', ui.ButtonSet.OK_CANCEL);
  if (ans.getSelectedButton() !== ui.Button.OK) return;
  const cid = normId(ans.getResponseText());
  if (!cid) return;
  const sh = sheet(SHEET.submissions);
  const rows = sh.getDataRange().getValues();
  let n = 0;
  for (let i = rows.length - 1; i >= 1; i--) {
    if (normId(rows[i][COL.subs.contest]) === cid) { sh.deleteRow(i + 1); n++; }
  }
  blankDrafts(cid);
  clearCache();
  ui.alert('Deleted ' + n + ' submission(s) (and any saved drafts) of contest "' + cid + '".');
}

/**
 * Empties the saved drafts of one contest (or of all contests when cid is omitted). The rows are blanked rather
 * than deleted, so row numbers never shift under a save that is happening at that moment.
 */
function blankDrafts(cid) {
  const sh = draftsSheet();
  const rows = sh.getDataRange().getValues();
  const n = PROBLEMS_PER_ROUND * 3;
  const blanks = [];
  for (let i = 0; i < n; i++) blanks.push('');
  for (let i = 1; i < rows.length; i++) {
    if (!cid || normId(rows[i][COL.drafts.contest]) === cid) sh.getRange(i + 1, COL.drafts.fields + 1, 1, n).setValues([blanks]);
  }
}

/** Clears the whole Submissions tab (every team of every contest restarts from round 1). */
function deleteAllSubmissions() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert('Delete ALL submissions?',
    'This clears every row of the Submissions tab for every contest. This cannot be undone.',
    ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) return;
  const sh = sheet(SHEET.submissions);
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.deleteRows(2, n);
  blankDrafts();
  clearCache();
  ui.alert('Deleted ' + Math.max(0, n) + ' submission(s) and all saved drafts.');
}
