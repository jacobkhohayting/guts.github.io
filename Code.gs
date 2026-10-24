/**
 * Contest backend — Google Apps Script
 * =====================================
 * Install (full walkthrough in README.md):
 *   1. Create a Google Sheet. Extensions → Apps Script. Replace the default code with this file. Save.
 *   2. Choose "setup" in the function dropdown and click Run (approve the permissions). This creates the tabs.
 *   3. Fill in the Config, Problems and Teams tabs.
 *   4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy.
 *   5. Paste the Web app URL into config.js on the website.
 *
 * Everything secret (problems, answers, team codes, admin password) lives in this private
 * spreadsheet. The website repo only contains this file, which has no secrets in it.
 *
 * What the server enforces:
 *   - Problems for round N are released to a team only after it has submitted rounds 1..N-1,
 *     and only while the contest is running (server clock, not the participant's).
 *   - A round can be submitted exactly once, and only the team's current round.
 *   - Submissions are auto-graded against the Problems tab; organizers can override in the sheet.
 */

// Leave blank when this script is attached to the spreadsheet (Extensions → Apps Script).
// Otherwise paste the spreadsheet ID from its URL.
const SPREADSHEET_ID = '';

const PROBLEMS_PER_ROUND = 3;      // the Submissions tab gets this many Answer/Correct columns
const GRACE_SECONDS = 20;          // still accept a submission this long after time runs out (slow networks)
const MAX_ANSWER_LENGTH = 200;
const MAX_MEMBERS = 3;             // member-name slots recorded per team (1 name + 1 email are required at login)
const CONFIG_CACHE_SECONDS = 15;   // edits to Config take effect within this long
const PROBLEMS_CACHE_SECONDS = 60; // edits to Problems take effect within this long (or use Contest → Apply edits now)

const SHEET = { config: 'Config', problems: 'Problems', teams: 'Teams', submissions: 'Submissions' };

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
      case 'status': return status();
      case 'login':  return teamState(p, true);
      case 'state':  return teamState(p, false);
      case 'submit': return submit(p);
      case 'admin':  return admin(p);
      default:       return { ok: false, error: 'Unknown action: ' + p.action };
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), auth: !!(err && err.auth) };
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

/** Public: contest name, schedule and server time. No problems. */
function status() {
  const cfg = getConfig();
  const probs = getProblems();
  return Object.assign({
    ok: true,
    contestName: cfg.contestName,
    openRegistration: cfg.openRegistration,
    totalRounds: countRounds(probs),
    problemsPerRound: PROBLEMS_PER_ROUND,
  }, timeInfo(cfg));
}

/** Team: where am I? (login may register a new team when open_registration is TRUE) */
function teamState(p, allowRegister) {
  const cfg = getConfig();
  const team = authenticate(p, cfg, allowRegister);
  return buildTeamState(team, cfg);
}

function buildTeamState(team, cfg) {
  const probs = getProblems();
  const t = timeInfo(cfg);
  const totalRounds = countRounds(probs);
  const prog = teamProgress(team.name, getSubmissions());
  const res = Object.assign({
    ok: true,
    team: team.name,
    members: team.members || [],
    email: team.email || '',
    contestName: cfg.contestName,
    openRegistration: cfg.openRegistration,
    totalRounds: totalRounds,
    problemsPerRound: PROBLEMS_PER_ROUND,
    currentRound: prog.currentRound,
    submittedRounds: prog.submittedRounds,
    finished: prog.currentRound > totalRounds,
  }, t);
  // Problems are only ever sent for the team's current round, while the contest is running.
  if (t.state === 'running' && !res.finished) {
    res.problems = roundProblems(probs, prog.currentRound)
      .map(function (q) { return { n: q.n, text: q.text, points: q.points, image: q.image }; });
  }
  return res;
}

/** Team: submit the current round. Locks it, grades it, and returns the next round. */
function submit(p) {
  const cfg = getConfig();
  const team = authenticate(p, cfg, false);
  const t = timeInfo(cfg);
  if (t.state === 'unscheduled' || t.state === 'before') throw new Error('The contest has not started yet.');
  if (t.serverTime > cfg.endTime + GRACE_SECONDS * 1000) throw new Error('Time is up — submissions are closed.');

  const probs = getProblems();
  const totalRounds = countRounds(probs);
  const round = Number(p.round);
  if (!(round >= 1 && round <= totalRounds)) throw new Error('Invalid round.');
  const given = Array.isArray(p.answers) ? p.answers : [];

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const prog = teamProgress(team.name, getSubmissions());
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
    const elapsed = Math.round((nowMs - cfg.startTime) / 600) / 100; // minutes since start, 2 decimals
    const row = [new Date(nowMs), asText(team.name), round]
      .concat(answers.map(asText), correct, [points, elapsed]);
    sheet(SHEET.submissions).appendRow(row);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return buildTeamState(team, cfg);
}

/** Organizers: everything, including answers and all submissions. */
function admin(p) {
  const cfg = getConfig();
  if (!cfg.adminPassword) throw authError('Set admin_password in the Config tab first.');
  if (String(p.password == null ? '' : p.password) !== cfg.adminPassword) throw authError('Wrong admin password.');
  const probs = getProblems();
  const teams = sheet(SHEET.teams).getDataRange().getValues().slice(1)
    .filter(function (r) { return cell(r[0]) !== ''; })
    .map(function (r) {
      return {
        name: cell(r[0]),
        registeredAt: toMillis(r[2]),
        members: [3, 4, 5].map(function (c) { return cell(r[c]); }).filter(Boolean),
        email: cell(r[6]),
      };
    });
  return Object.assign({
    ok: true,
    contestName: cfg.contestName,
    durationMinutes: cfg.durationMinutes,
    openRegistration: cfg.openRegistration,
    totalRounds: countRounds(probs),
    problemsPerRound: PROBLEMS_PER_ROUND,
    problems: probs,
    teams: teams,
    submissions: getSubmissions(),
  }, timeInfo(cfg));
}

// ============================================================================
// Teams & progress
// ============================================================================

function authenticate(p, cfg, allowRegister) {
  const name = cell(p.team).replace(/\s+/g, ' ');
  const code = cell(p.code);
  if (!name) throw authError('Please enter a team name.');
  if (name.length > 40) throw authError('Team name is too long (40 characters max).');
  if (!code) throw authError('Please enter your team code.');
  const info = allowRegister ? parseMemberInfo(p) : null;   // validate before creating anything
  let team = findTeam(name);
  if (!team) {
    if (!allowRegister || !cfg.openRegistration) {
      throw authError('Team not found. Check the spelling of your team name, or ask the organizers.');
    }
    if (code.length > 40) throw authError('Team code is too long (40 characters max).');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      team = findTeam(name);
      if (!team) {
        sheet(SHEET.teams).appendRow([asText(name), asText(code), new Date()]);
        SpreadsheetApp.flush();
        team = { name: name, code: code };
      }
    } finally {
      lock.releaseLock();
    }
  }
  if (team.code.toLowerCase() !== code.toLowerCase()) throw authError('Incorrect team code.');
  if (info) recordMembers(team, info);   // the login form always sends member names + email
  return team;
}

function findTeam(name) {
  const rows = sheet(SHEET.teams).getDataRange().getValues();
  const key = normName(name);
  for (let i = 1; i < rows.length; i++) {
    if (normName(rows[i][0]) === key) {
      const r = rows[i];
      return {
        name: cell(r[0]),
        code: cell(r[1]),
        row: i + 1,
        members: [3, 4, 5].map(function (c) { return cell(r[c]); }).filter(Boolean),
        email: cell(r[6]),
      };
    }
  }
  return null;
}

/**
 * Saves member names + email from the login form into the team's row (columns D–G).
 * Names are merged, never overwritten: a second device adding "Carol" keeps "Alice" and "Bob".
 * The most recently entered email wins, so a typo can be fixed by logging in again.
 */
function parseMemberInfo(p) {
  const given = (Array.isArray(p.members) ? p.members : [])
    .map(function (m) { return cell(m).replace(/\s+/g, ' ').slice(0, 60); })
    .filter(Boolean);
  const email = cell(p.email).slice(0, 120);
  if (!given.length) throw authError('Please enter at least one team member\'s name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw authError('Please enter a valid email address.');
  return { given: given, email: email };
}

function recordMembers(team, info) {
  const given = info.given;
  const email = info.email;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet(SHEET.teams);
    const rows = sh.getDataRange().getValues();
    if (cell(rows[0][3]) === '') {   // sheet made by an older setup(): add the headers
      sh.getRange(1, 4, 1, 4).setValues([['Member 1', 'Member 2', 'Member 3', 'Email']]).setFontWeight('bold');
    }
    const current = findTeam(team.name) || team;
    const merged = (current.members || []).slice();
    given.forEach(function (m) {
      const dup = merged.some(function (e) { return e.toLowerCase() === m.toLowerCase(); });
      if (!dup && merged.length < MAX_MEMBERS) merged.push(m);
    });
    const slots = merged.slice();
    while (slots.length < MAX_MEMBERS) slots.push('');
    sh.getRange(current.row, 4, 1, MAX_MEMBERS + 1).setValues([slots.map(asText).concat([asText(email)])]);
    SpreadsheetApp.flush();
    team.members = merged;
    team.email = email;
  } finally {
    lock.releaseLock();
  }
}

function teamProgress(teamName, subs) {
  const key = normName(teamName);
  const rounds = subs.filter(function (s) { return normName(s.team) === key; })
    .map(function (s) { return s.round; })
    .sort(function (a, b) { return a - b; });
  const maxRound = rounds.length ? rounds[rounds.length - 1] : 0;
  return { currentRound: maxRound + 1, submittedRounds: rounds };
}

function getSubmissions() {
  const rows = sheet(SHEET.submissions).getDataRange().getValues().slice(1);
  const K = PROBLEMS_PER_ROUND;
  return rows.filter(function (r) { return cell(r[1]) !== ''; }).map(function (r) {
    return {
      time: toMillis(r[0]),
      team: cell(r[1]),
      round: Number(cell(r[2])),
      answers: r.slice(3, 3 + K).map(cell),
      correct: r.slice(3 + K, 3 + 2 * K).map(isTrue),
      points: Number(cell(r[3 + 2 * K])) || 0,
      elapsed: Number(cell(r[4 + 2 * K])) || 0,
    };
  });
}

// ============================================================================
// Config & problems (cached briefly so the start-time rush stays fast)
// ============================================================================

function getConfig() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('config');
  if (hit) return JSON.parse(hit);
  const rows = sheet(SHEET.config).getDataRange().getValues();
  const raw = {};
  rows.forEach(function (r) {
    const k = cell(r[0]).toLowerCase();
    if (k) raw[k] = r[1];
  });
  const startTime = parseStart(raw.start_time);
  const durationMinutes = Number(cell(raw.duration_minutes)) || 60;
  const cfg = {
    contestName: cell(raw.contest_name) || 'Contest',
    startTime: startTime,
    endTime: startTime == null ? null : startTime + durationMinutes * 60000,
    durationMinutes: durationMinutes,
    adminPassword: cell(raw.admin_password),
    openRegistration: isTrue(raw.open_registration),
  };
  cache.put('config', JSON.stringify(cfg), CONFIG_CACHE_SECONDS);
  return cfg;
}

function parseStart(v) {
  if (v instanceof Date) return v.getTime();
  const s = cell(v);
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new Error('Config start_time is not a valid date/time: "' + s + '". Use e.g. 2026-11-07T14:00:00-05:00');
  }
  return d.getTime();
}

function getProblems() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('problems');
  if (hit) return JSON.parse(hit);
  const rows = sheet(SHEET.problems).getDataRange().getValues().slice(1);
  const list = rows
    .filter(function (r) { return cell(r[0]) !== '' && cell(r[1]) !== ''; })
    .map(function (r) {
      return {
        round: Number(cell(r[0])),
        n: Number(cell(r[1])),
        text: cell(r[2]),
        answers: cell(r[3]),
        points: Number(cell(r[4])) || 0,
        image: cell(r[5]),
      };
    })
    .filter(function (q) { return q.round > 0 && q.n > 0; });
  cache.put('problems', JSON.stringify(list), PROBLEMS_CACHE_SECONDS);
  return list;
}

function countRounds(probs) {
  return probs.reduce(function (m, q) { return Math.max(m, q.round); }, 0);
}

function roundProblems(probs, round) {
  return probs.filter(function (q) { return q.round === round; })
    .sort(function (a, b) { return a.n - b.n; });
}

function timeInfo(cfg) {
  const serverTime = Date.now();
  let state = 'unscheduled';
  if (cfg.startTime != null) {
    state = serverTime < cfg.startTime ? 'before' : serverTime < cfg.endTime ? 'running' : 'ended';
  }
  return { serverTime: serverTime, startTime: cfg.startTime, endTime: cfg.endTime, state: state };
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
  return cell(s).toLowerCase().replace(/\s+/g, ' ');
}

// ============================================================================
// One-time setup and the "Contest" menu in the spreadsheet
// ============================================================================

/** Run this once from the Apps Script editor. Creates the tabs (never overwrites existing data). */
function setup() {
  const ss = spreadsheet();

  const cfg = getOrCreateSheet(ss, SHEET.config);
  if (cfg.getLastRow() === 0) {
    cfg.getRange('B:B').setNumberFormat('@');
    cfg.getRange(1, 1, 6, 3).setValues([
      ['Setting', 'Value', 'Notes'],
      ['contest_name', 'Math Contest', 'Shown at the top of the website.'],
      ['start_time', '2026-11-07T14:00:00-05:00',
        'When the contest starts, for everyone at once. ISO format WITH a UTC offset, e.g. 2026-11-07T14:00:00-05:00 ' +
        '(-05:00 = US Eastern Standard Time, -04:00 = Eastern Daylight Time, +00:00 = UTC). Check it on admin.html.'],
      ['duration_minutes', 60, 'Length of the contest in minutes. Changing it mid-contest extends/shortens everyone\'s timer.'],
      ['admin_password', 'change-me', 'Needed to open admin.html. Change it!'],
      ['open_registration', 'FALSE',
        'FALSE (recommended): only teams listed in the Teams tab can log in. ' +
        'TRUE: anyone can create a team by choosing a name and a code (a cheater could then make extra teams to peek ahead).'],
    ]);
    styleHeader(cfg, [160, 300, 620]);
    cfg.getRange(2, 3, 5, 1).setWrap(true);
  }

  const pr = getOrCreateSheet(ss, SHEET.problems);
  if (pr.getLastRow() === 0) {
    pr.getRange('C:D').setNumberFormat('@');
    pr.getRange('F:F').setNumberFormat('@');
    const rows = [['Round', 'Problem #', 'Problem (LaTeX between $...$)', 'Accepted answer(s) — alternatives separated by |', 'Points', 'Image URL (optional)']];
    for (let r = 1; r <= 8; r++) {
      for (let n = 1; n <= PROBLEMS_PER_ROUND; n++) {
        rows.push([r, n,
          'Sample problem ' + r + '.' + n + ': Compute $' + r + ' \\times ' + n + ' + \\frac{1}{2} \\cdot 2$. (Replace me with a real problem.)',
          String(r * n + 1), 4 + Math.ceil(r / 2), '']);
      }
    }
    pr.getRange(1, 1, rows.length, 6).setValues(rows);
    styleHeader(pr, [60, 80, 520, 280, 60, 240]);
    pr.getRange(2, 3, rows.length - 1, 1).setWrap(true);
  }

  const tm = getOrCreateSheet(ss, SHEET.teams);
  if (tm.getLastRow() === 0) {
    tm.getRange('A:B').setNumberFormat('@');
    tm.getRange(1, 1, 3, 7).setValues([
      ['Team Name', 'Access Code', 'Registered At', 'Member 1', 'Member 2', 'Member 3', 'Email'],
      ['Test Team', 'test123', '', '', '', '', ''],
      ['Another Team', 'abc456', '', '', '', '', ''],
    ]);
    styleHeader(tm, [220, 160, 180, 160, 160, 160, 240]);
  } else if (cell(tm.getRange(1, 4).getValue()) === '') {
    // Teams tab from an earlier version: add the member/email columns (filled in automatically at login).
    tm.getRange(1, 4, 1, 4).setValues([['Member 1', 'Member 2', 'Member 3', 'Email']]).setFontWeight('bold');
  }

  const sb = getOrCreateSheet(ss, SHEET.submissions);
  if (sb.getLastRow() === 0) {
    const h = ['Timestamp', 'Team', 'Round'];
    for (let i = 1; i <= PROBLEMS_PER_ROUND; i++) h.push('Answer ' + i);
    for (let i = 1; i <= PROBLEMS_PER_ROUND; i++) h.push('Correct ' + i);
    h.push('Points', 'Elapsed (min)');
    sb.getRange(1, 1, 1, h.length).setValues([h]);
    sb.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    const widths = [170, 180, 60];
    for (let i = 0; i < PROBLEMS_PER_ROUND; i++) widths.push(160);
    for (let i = 0; i < PROBLEMS_PER_ROUND; i++) widths.push(80);
    widths.push(70, 100);
    styleHeader(sb, widths);
  }

  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  clearCache();
  Logger.log('Setup complete. Fill in the Config, Problems and Teams tabs, then deploy as a web app.');
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
    .addItem('Set up sheets', 'setup')
    .addItem('Check setup', 'checkSetup')
    .addItem('Apply edits now (clear cache)', 'clearCache')
    .addSeparator()
    .addItem('Delete ALL submissions…', 'deleteAllSubmissions')
    .addToUi();
}

function clearCache() {
  CacheService.getScriptCache().removeAll(['config', 'problems']);
}

/** Sanity-checks the sheets and reports problems. Safe to run any time. */
function checkSetup() {
  clearCache();
  const lines = [];
  const cfg = getConfig();
  const probs = getProblems();
  lines.push('Contest: ' + cfg.contestName);
  lines.push('Start: ' + (cfg.startTime != null ? new Date(cfg.startTime).toString() : 'NOT SET (start_time is empty)'));
  lines.push('Duration: ' + cfg.durationMinutes + ' min');
  lines.push('Open registration: ' + cfg.openRegistration);
  lines.push('Admin password set: ' + (cfg.adminPassword ? 'yes' : 'NO — set admin_password'));
  const rounds = countRounds(probs);
  lines.push('Rounds: ' + rounds + ' (' + probs.length + ' problems)');
  for (let r = 1; r <= rounds; r++) {
    const qs = roundProblems(probs, r);
    if (qs.length !== PROBLEMS_PER_ROUND) {
      lines.push('  WARNING: round ' + r + ' has ' + qs.length + ' problems (expected ' + PROBLEMS_PER_ROUND + ')');
    }
    qs.forEach(function (q) {
      if (!q.answers) lines.push('  WARNING: round ' + r + ' problem ' + q.n + ' has no accepted answer');
    });
  }
  const teams = sheet(SHEET.teams).getDataRange().getValues().slice(1).filter(function (r) { return cell(r[0]) !== ''; });
  lines.push('Teams: ' + teams.length);
  teams.forEach(function (r) {
    if (!cell(r[1])) lines.push('  WARNING: team "' + cell(r[0]) + '" has no access code');
  });
  const out = lines.join('\n');
  Logger.log(out);
  try { SpreadsheetApp.getUi().alert(out); } catch (e) { /* not run from the sheet; see the log */ }
  return out;
}

/** Clears the Submissions tab (teams restart from round 1). Run from the Contest menu. */
function deleteAllSubmissions() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert('Delete ALL submissions?',
    'This clears every row of the Submissions tab, so every team restarts from round 1. This cannot be undone.',
    ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) return;
  const sh = sheet(SHEET.submissions);
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.deleteRows(2, n);
  clearCache();
  ui.alert('Deleted ' + Math.max(0, n) + ' submission(s).');
}
