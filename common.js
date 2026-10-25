/* Shared helpers for index.html, admin.html and leaderboard.html. */
window.Guts = (function () {
  'use strict';

  const API_URL = String((window.CONTEST_CONFIG || {}).API_URL || '').trim();
  const configured = !!API_URL && !/PASTE_YOUR/i.test(API_URL);

  // Clock sync: every server response carries serverTime; we keep the offset so the
  // countdown is driven by the server's clock, not the participant's computer.
  const clock = { offset: 0 };
  const now = () => Date.now() + clock.offset;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // POST JSON to the Apps Script web app. Sending the body without a Content-Type
  // header (text/plain) avoids a CORS preflight, which Apps Script cannot answer.
  // Network failures are retried with backoff; server-side errors ({ok:false}) are not.
  async function api(payload, retries = 3) {
    let delay = 1500;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify(payload) });
        const data = await res.json();
        if (typeof data.serverTime === 'number') clock.offset = data.serverTime - Date.now();
        return data;
      } catch (err) {
        if (attempt >= retries) {
          throw new Error('Could not reach the contest server. Check your connection and try again.');
        }
        await sleep(delay + Math.random() * 800);
        delay = Math.min(delay * 2, 8000);
      }
    }
  }

  // ---------- KaTeX ----------
  // halloweenmath symbols. KaTeX has no glyphs for them, so each command becomes a span
  // (via \htmlClass) that CSS fills with an icon in the current text color — see .hwm in style.css.
  const HALLOWEEN = {
    '\\mathghost': 'ghost',
    '\\pumpkin': 'pumpkin',
    '\\skull': 'skull',
    '\\mathbat': 'bat',
  };
  const MACROS = {};
  Object.keys(HALLOWEEN).forEach((cmd) => {
    MACROS[cmd] = '\\htmlClass{hwm hwm-' + HALLOWEEN[cmd] + '}{\\phantom{\\mathrm{M}}}';
  });
  // Only \htmlClass is trusted (it can only add CSS classes); \href, \url etc. stay disabled.
  const trust = (ctx) => ctx.command === '\\htmlClass';
  // KaTeX writes into the macros object when input defines macros, so hand it a fresh copy each time.
  const katexOptions = (extra) => Object.assign({ macros: Object.assign({}, MACROS), trust, throwOnError: false }, extra);

  const MATH_DELIMITERS = [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '\\(', right: '\\)', display: false },
    { left: '$', right: '$', display: false },
  ];

  // Plain text containing $...$ / $$...$$ math. The text is inserted as text (never as
  // HTML) and then typeset, so nothing in it can inject markup.
  function renderRichText(el, text) {
    el.textContent = text == null ? '' : String(text);
    typesetIn(el);
  }

  // Typeset $...$ math already present (as text) inside an element, e.g. the rules.
  function typesetIn(el) {
    if (window.renderMathInElement) {
      renderMathInElement(el, katexOptions({ delimiters: MATH_DELIMITERS }));
    }
  }

  // Typeset a raw answer (a plain number or LaTeX) as display math.
  function renderAnswer(el, raw, placeholder) {
    const s = String(raw == null ? '' : raw).replace(/\$/g, '').trim();
    el.textContent = '';
    if (!s) {
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = placeholder || '—';
      el.appendChild(span);
      return;
    }
    if (!window.katex) { el.textContent = s; return; }
    try {
      katex.render(s, el, katexOptions({ displayMode: true, strict: 'ignore' }));
    } catch (err) {
      el.textContent = s;
    }
  }

  // ---------- formatting ----------
  const pad = (n) => String(n).padStart(2, '0');

  function fmtDuration(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }

  function fmtDate(ms) {
    if (!ms) return '—';
    try {
      return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return new Date(ms).toLocaleString();
    }
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    try {
      return new Date(ms).toLocaleTimeString(undefined, { timeStyle: 'medium' });
    } catch (e) {
      return new Date(ms).toLocaleTimeString();
    }
  }

  // Drive the header clock (#timer / #timer-label) from a contest's schedule. Returns the ms left (or null).
  function paintTimer(info) {
    const timerEl = document.getElementById('timer');
    const labelEl = document.getElementById('timer-label');
    if (!timerEl || !labelEl) return null;
    if (!info || !info.startTime) {
      timerEl.textContent = '--:--';
      timerEl.classList.remove('urgent');
      labelEl.textContent = info && info.state === 'unscheduled' ? 'Not scheduled' : '';
      return null;
    }
    const t = now();
    if (t < info.startTime) {
      labelEl.textContent = 'Starts in';
      timerEl.textContent = fmtDuration(info.startTime - t);
      timerEl.classList.remove('urgent');
      return null;
    }
    const left = info.endTime - t;
    labelEl.textContent = left > 0 ? 'Time left' : 'Time is up';
    timerEl.textContent = fmtDuration(Math.max(0, left));
    timerEl.classList.toggle('urgent', left > 0 && left <= 5 * 60000);
    return left;
  }

  // Fill a <select> with the contests from a status response. Returns the id that ended up selected.
  function fillContestSelect(select, contests, preferred) {
    select.textContent = '';
    contests.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      const label = { before: 'starts ' + fmtDate(c.startTime), running: 'in progress', ended: 'ended', unscheduled: 'not scheduled' }[c.state] || '';
      opt.textContent = c.title + (label ? ' — ' + label : '');
      select.appendChild(opt);
    });
    const ids = contests.map((c) => c.id);
    const want = String(preferred || '').toLowerCase().replace(/\s+/g, '');
    select.value = ids.includes(want) ? want : (ids[0] || '');
    return select.value;
  }

  const urlParam = (name) => { try { return new URLSearchParams(window.location.search).get(name) || ''; } catch (e) { return ''; } };

  let currentView = null;
  function showView(name) {
    currentView = name;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
  }
  const view = () => currentView;

  let toastTimer = null;
  function toast(msg, kind) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  return {
    API_URL, configured, clock, now, sleep, api, katexOptions,
    renderRichText, typesetIn, renderAnswer,
    fmtDuration, fmtDate, fmtTime, paintTimer, fillContestSelect, urlParam,
    showView, view, toast,
  };
})();
