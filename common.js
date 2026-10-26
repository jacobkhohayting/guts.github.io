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

  // Math environments KaTeX can typeset on its own (auto-render hands it the whole \begin...\end block).
  const MATH_ENVS = ['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'CD'];
  const MATH_DELIMITERS = [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '\\(', right: '\\)', display: false },
    { left: '$', right: '$', display: false },
  ].concat(MATH_ENVS.map((env) => ({ left: '\\begin{' + env + '}', right: '\\end{' + env + '}', display: true })));

  // ---------- a little text-mode LaTeX ----------
  // Problem statements are often pasted straight out of a .tex file. KaTeX only typesets math, so
  // the common *text* constructs are translated to HTML here (built as DOM nodes, never innerHTML):
  //   \begin{center} / flushleft / flushright, \begin{itemize} / enumerate + \item,
  //   \textit \emph \textbf \underline \texttt \textsc, \\ and \newline, ~, \%, \&, \#, \_, \$, \{ \},
  //   \quad, \ldots, ``quotes'', and spacing/no-op commands (\noindent, \centering, \vspace{..}...).
  // Math ($..$, $$..$$, \(..\), \[..\] and the MATH_ENVS above) is copied through untouched for KaTeX.
  // Asymptote blocks and \includegraphics can't be drawn in a browser: they become a visible note
  // so the organizer puts the figure in the Image column instead.
  const INLINE_TAGS = {
    textit: 'em', emph: 'em', textsl: 'em', textbf: 'strong', underline: 'u', texttt: 'code',
    textsc: 'span.sc', text: 'span', textrm: 'span', textnormal: 'span', mbox: 'span', caption: 'div.tex-caption',
  };
  const NOOP_CMDS = /^(noindent|centering|raggedright|raggedleft|clearpage|newpage|hfill|vfill|medskip|smallskip|bigskip|linebreak|nopagebreak|relax|strut|indent)$/;
  const ARG_NOOP_CMDS = /^(vspace\*?|hspace\*?|label|setlength|usepackage|documentclass|pagestyle|thispagestyle)$/;
  const BLOCK_ENVS = {
    center: 'div.tex-center', flushleft: 'div.tex-left', flushright: 'div.tex-right',
    itemize: 'ul', enumerate: 'ol', description: 'ul',
    figure: 'div', 'figure*': 'div', minipage: 'div', document: 'div',
    asy: 'FIGURE', asydef: 'DROP', tikzpicture: 'FIGURE',
  };
  const FIGURE_NOTE = '[Figure missing: this problem contains drawing code (Asymptote/TikZ), which a browser cannot run. ' +
    'Organizers: export the figure as an image and paste its URL (or the SVG itself) into the Image column.]';

  const make = (spec) => {
    const [tag, cls] = spec.split('.');
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };

  // Index of the brace that closes the one at `i`, or -1.
  function matchBrace(src, i) {
    let depth = 0;
    for (let k = i; k < src.length; k++) {
      const ch = src[k];
      if (ch === '\\') { k++; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return k; }
    }
    return -1;
  }

  // Index of the \end{env} matching the \begin{env} at `i` (nesting-aware), or -1.
  function matchEnv(src, i, env) {
    const open = '\\begin{' + env + '}';
    const close = '\\end{' + env + '}';
    let depth = 0;
    let k = i;
    for (;;) {
      const a = src.indexOf(open, k);
      const b = src.indexOf(close, k);
      if (b < 0) return -1;
      if (a >= 0 && a < b) { depth++; k = a + open.length; } else { depth--; if (depth === 0) return b; k = b + close.length; }
    }
  }

  // Index just past the math segment starting at `i` (which begins with a math delimiter), or -1.
  function mathEnd(src, i) {
    const pairs = [['$$', '$$'], ['\\[', '\\]'], ['\\(', '\\)'], ['$', '$']];
    for (const [l, r] of pairs) {
      if (!src.startsWith(l, i)) continue;
      let k = i + l.length;
      for (;;) {
        const e = src.indexOf(r, k);
        if (e < 0) return -1;
        let bs = 0;
        for (let j = e - 1; j >= 0 && src[j] === '\\'; j--) bs++;
        if (bs % 2 === 0) return e + r.length;
        k = e + 1;
      }
    }
    const m = /^\\begin\{([a-zA-Z*]+)\}/.exec(src.slice(i));
    if (m && MATH_ENVS.includes(m[1])) {
      const e = matchEnv(src, i, m[1]);
      return e < 0 ? -1 : e + ('\\end{' + m[1] + '}').length;
    }
    return -1;
  }

  function buildRich(container, src, inList) {
    let cur = container;        // current append target (a <li> while inside a list)
    let buf = '';
    const flush = () => { if (buf) { cur.appendChild(document.createTextNode(buf)); buf = ''; } };
    const block = (node) => {   // start a block: drop the newline before it
      buf = buf.replace(/[ \t]*\n?$/, '');
      flush();
      cur.appendChild(node);
      return node;
    };
    const skipNewline = (k) => (src[k] === '\n' ? k + 1 : k);
    let i = 0;
    while (i < src.length) {
      const ch = src[i];

      // ---- math: copied verbatim for KaTeX ----
      if (ch === '$' || src.startsWith('\\[', i) || src.startsWith('\\(', i) || (src.startsWith('\\begin{', i) && mathEnd(src, i) >= 0)) {
        const e = mathEnd(src, i);
        if (e >= 0) {
          const display = src.startsWith('$$', i) || src.startsWith('\\[', i) || src.startsWith('\\begin', i);
          if (display) buf = buf.replace(/[ \t]*\n?$/, '');   // display math is a block of its own: no blank line around it
          buf += src.slice(i, e);
          i = display ? skipNewline(e) : e;
          continue;
        }
        buf += ch; i++; continue;
      }

      if (ch === '\\') {
        const rest = src.slice(i + 1);
        // \\ or \\[len] → line break
        if (rest[0] === '\\') {
          flush(); cur.appendChild(document.createElement('br'));
          i += 2;
          const m = /^\[[^\]]*\]/.exec(src.slice(i)); if (m) i += m[0].length;
          i = skipNewline(i);
          continue;
        }
        // escaped characters
        if ('%&#_{}'.includes(rest[0])) { buf += rest[0]; i += 2; continue; }
        if (rest[0] === '$') { flush(); cur.appendChild(document.createTextNode('$')); i += 2; continue; }
        if (rest[0] === ' ' || rest[0] === ',' || rest[0] === ';' || rest[0] === ':') { buf += ' '; i += 2; continue; }
        if (rest[0] === '!' ) { i += 2; continue; }

        const cm = /^([a-zA-Z]+\*?)/.exec(rest);
        if (cm) {
          const name = cm[1];
          let k = i + 1 + name.length;
          if (name === 'begin' || name === 'end') {
            const bm = /^\{([^}]*)\}/.exec(src.slice(k));
            if (bm && name === 'begin' && BLOCK_ENVS[bm[1]]) {
              const env = bm[1];
              const spec = BLOCK_ENVS[env];
              const start = k + bm[0].length;
              const e = matchEnv(src, i, env);
              if (e >= 0) {
                const inner = src.slice(start, e);
                if (spec === 'DROP') { /* nothing */ }
                else if (spec === 'FIGURE') block(make('div.tex-missing')).textContent = FIGURE_NOTE;
                else {
                  const node = block(make(spec));
                  const isList = spec === 'ul' || spec === 'ol';
                  buildRich(node, isList ? inner : inner.replace(/^\s*\n/, '').replace(/\s+$/, ''), isList);
                }
                i = skipNewline(e + ('\\end{' + env + '}').length);
                continue;
              }
            }
            // unknown environment (or unmatched): keep the text as is
            buf += src.slice(i, k); i = k; continue;
          }
          if (name === 'item') {
            if (inList) {
              buf = buf.replace(/\s+$/, ''); flush();
              cur = container.appendChild(document.createElement('li'));
              const om = /^\[([^\]]*)\]/.exec(src.slice(k));   // \item[label]
              if (om) { const b = cur.appendChild(make('strong')); buildRich(b, om[1], false); buf = ' '; k += om[0].length; }
            } else { buf += '• '; }
            i = k; while (src[i] === ' ') i++;
            continue;
          }
          if (INLINE_TAGS[name] && src[k] === '{') {
            const e = matchBrace(src, k);
            if (e >= 0) {
              flush();
              const node = cur.appendChild(make(INLINE_TAGS[name]));
              buildRich(node, src.slice(k + 1, e), false);
              i = e + 1; continue;
            }
          }
          if (name === 'includegraphics') {
            const om = /^(\[[^\]]*\])?\{[^}]*\}/.exec(src.slice(k));
            block(make('div.tex-missing')).textContent = '[Image missing: \\includegraphics cannot load files here. Organizers: paste the image URL (or SVG) into the Image column.]';
            i = om ? k + om[0].length : k; continue;
          }
          if (ARG_NOOP_CMDS.test(name)) {
            let k2 = k;
            const om = /^\[[^\]]*\]/.exec(src.slice(k2)); if (om) k2 += om[0].length;
            if (src[k2] === '{') { const e = matchBrace(src, k2); if (e >= 0) k2 = e + 1; }
            if (name === 'setlength' && src[k2] === '{') { const e = matchBrace(src, k2); if (e >= 0) k2 = e + 1; }
            i = skipNewline(k2); continue;
          }
          if (NOOP_CMDS.test(name)) { i = k; while (src[i] === ' ') i++; i = skipNewline(i); continue; }
          if (name === 'par') { buf += '\n\n'; i = k; continue; }
          if (name === 'newline') { flush(); cur.appendChild(document.createElement('br')); i = skipNewline(k); continue; }
          if (name === 'quad') { buf += ' '; i = k; continue; }
          if (name === 'qquad') { buf += '  '; i = k; continue; }
          if (name === 'ldots' || name === 'dots') { buf += '…'; i = k; continue; }
          if (name === 'LaTeX') { buf += 'LaTeX'; i = k; continue; }
          if (name === 'TeX') { buf += 'TeX'; i = k; continue; }
          // anything else (e.g. a math command outside math) is left visible as typed
          buf += src.slice(i, k); i = k; continue;
        }
        buf += ch; i++; continue;
      }

      if (ch === '~') { buf += ' '; i++; continue; }
      if (src.startsWith('``', i)) { buf += '“'; i += 2; continue; }
      if (src.startsWith("''", i)) { buf += '”'; i += 2; continue; }
      if (ch === '%' ) {   // LaTeX comment to end of line
        const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl + 1; continue;
      }
      buf += ch; i++;
    }
    if (inList) buf = buf.replace(/\s+$/, '');
    flush();
  }

  // Problem text: plain text with LaTeX math and a little text-mode LaTeX (see buildRich). Everything is
  // built from text nodes and a fixed set of harmless elements, so nothing in it can inject markup.
  function renderRichText(el, text) {
    el.textContent = '';
    try {
      buildRich(el, text == null ? '' : String(text), false);
    } catch (err) {
      el.textContent = text == null ? '' : String(text);
    }
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

  // The Image column may hold a URL or the SVG markup itself (handy for Asymptote/TikZ exports).
  function imageSrc(v) {
    const t = String(v || '').trim();
    if (!t) return '';
    if (/^<svg[\s>]/i.test(t) || /^<\?xml/i.test(t)) return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(t);
    return t;
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
    fmtDuration, fmtDate, fmtTime, paintTimer, fillContestSelect, urlParam, imageSrc,
    showView, view, toast,
  };
})();
