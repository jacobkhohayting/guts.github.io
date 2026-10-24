/* Shared helpers for index.html and admin.html. */
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
    if (window.renderMathInElement) {
      renderMathInElement(el, { delimiters: MATH_DELIMITERS, throwOnError: false });
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
      katex.render(s, el, { throwOnError: false, displayMode: true, strict: 'ignore' });
    } catch (err) {
      el.textContent = s;
    }
  }

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

  return { API_URL, configured, clock, now, sleep, api, renderRichText, renderAnswer, fmtDuration, fmtDate, fmtTime, showView, view, toast };
})();
