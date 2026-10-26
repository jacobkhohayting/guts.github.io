# Contest site (multi-contest, one-way rounds, shared timer, live leaderboard)

A plain static website for timed team contests, hosted free on **GitHub Pages**, with a tiny private backend that lives in **your own Google Sheet** (Google Apps Script). Nothing secret is ever in the GitHub repo. One sheet runs any number of contests.

**What participants get**

- Pick a contest, enter its **passcode**, then log in with a team name + team code, member names (up to 3, at least 1) and a contact email.
- A countdown to the scheduled start. **No start button** — Round 1 appears for everyone at the same moment.
- One round at a time (3 problems per round, as many rounds as you put in the sheet — 8 by default). Problems are typeset with LaTeX (KaTeX), including the `halloweenmath` symbols `\mathghost`, `\pumpkin`, `\skull`, `\mathbat`.
- An answer box per problem with a **live LaTeX preview** of exactly what they are submitting, plus a final review before the round is locked.
- Submitting a round locks it forever and immediately reveals the next round. **No going back.**
- A single contest clock shared by everyone, driven by the server's time. When it hits zero, whatever is typed is auto-submitted.
- A **Rules** button available at all times, and a **Leaderboard** button.
- Typed answers survive a refresh (saved on the device).
- Participants are **never told which answers were right or wrong** — not on the page, not in any response from the server.

**What everyone gets**

- `leaderboard.html`: a public, live leaderboard per contest showing **only rank, team and total score** (auto-refreshes every 20 s). Each contest can hide it with one cell in the sheet.

**What organizers get**

- `admin.html`: one admin password; switch between contests; see every team, every member name and email, the live scoreboard with ✓/✗ per problem, every submission with rendered answers, the problems and answer key, and an overview of all contests (status, passcode, teams, submissions).
- The Google Sheet itself: the raw log (`Submissions` tab), where you can override any grade by hand.

## How the problems stay hidden

| Where it lives | Visible to |
|---|---|
| Problems, answers, points, passcodes, team codes, admin password, start times | Only your Google Sheet (private) |
| This repo (HTML/CSS/JS + a copy of the Apps Script code) | Public — contains **no** problems or secrets |

The backend only ever sends a team the problems of **its current round of its contest**, and only after that contest's start time (checked on the server's clock). Round N is released to a team only after it has submitted rounds 1…N‑1. A round can be submitted exactly once. Someone who finds your GitHub repo finds nothing but the website's skeleton.

Participants *can* submit blank rounds to move ahead quickly — that is allowed on purpose (it's the usual rule for this format), but those rounds are then locked. With `Open registration` = `FALSE` (the default), only the team names + codes you list can log in, so nobody can create a throwaway team to peek ahead.

---

## Setup (about 15 minutes)

### Part A — Backend: Google Sheet + Apps Script

1. Create a new Google Sheet (any name).
2. In the sheet: **Extensions → Apps Script**. Delete the default code, paste the whole contents of `backend/Code.gs`, and press **Save** (💾).
3. In the toolbar, pick **`setup`** in the function dropdown and click **▶ Run**. Approve the permissions when asked (Review permissions → choose your account → *Advanced → Go to (project name)* → Allow). This creates five tabs: `Config`, `Contests`, `Problems`, `Teams`, `Submissions`.
4. Go back to the sheet and fill in:
   - **Config**
     - `admin_password` — change it. Every organizer uses this one password.
     - `site_name` — shown on the login/leaderboard pages before a contest is chosen.
   - **Contests** — one row per contest:
     - `ID` — short, no spaces, used in links (`leaderboard.html?contest=ID`, `index.html?contest=ID`). Can't be changed once teams have logged in (it tags every row in the other tabs).
     - `Title` — what participants see.
     - `Passcode` — participants must type it to log in. Blank = no passcode. (Leading zeros are kept; the column is text.)
     - `Start time` — ISO format **with a UTC offset**, e.g. `2026-11-07T14:00:00-05:00` (`-05:00` = US Eastern Standard Time, `-04:00` = Eastern Daylight Time, `+00:00` = UTC). Leave blank for "not scheduled yet". Verify on `admin.html` (it shows the time in your local zone).
     - `Duration (min)` — e.g. `60`.
     - `Open registration` — `FALSE` (recommended) or `TRUE`.
     - `Show leaderboard` — `TRUE` to publish the live leaderboard, `FALSE` to hide it (e.g. until you've checked the grading).
   - **Problems** — one row per problem: `Contest` (the ID), `Round`, `Problem #`, `Problem` (LaTeX between `$...$`, `$$...$$` for display math; line breaks inside a cell are kept), `Accepted answer(s)` (alternatives separated by `|`), `Points`, optional `Image URL`. Sample rows for a contest called `sample` show the format — replace or delete them.
   - **Teams** — one row per team: `Contest`, `Team Name`, `Access Code`. Give each team its code privately. (Names and codes are matched case‑insensitively; the same team name can exist in different contests.) The `Member 1–3` and `Email` columns fill in by themselves at login.
5. **Deploy → New deployment**. Click the gear next to *Select type* → **Web app**. Set:
   - Description: anything
   - Execute as: **Me**
   - Who has access: **Anyone** (this exact option — not "Anyone with a Google account")

   Click **Deploy**, approve permissions again if asked, and **copy the Web app URL** (ends in `/exec`).

> Whenever you change `Code.gs` later, you must publish a new version: **Deploy → Manage deployments → ✎ Edit → Version: New version → Deploy**. The URL stays the same. (Editing the *sheet* never needs a redeploy.)

### Upgrading from the single-contest version

If your sheet was made by the earlier version (a `Config` tab with `contest_name`/`start_time`, no `Contests` tab): paste the new `Code.gs`, save, run **`setup`** once, then redeploy a new version. `setup` upgrades in place and deletes nothing:

- a `Contests` tab is created and your old `contest_name`, `start_time`, `duration_minutes` and `open_registration` become its first row, with ID `contest1` (no passcode until you add one);
- a `Contest` column is added to `Problems`, `Teams` and `Submissions`, filled with `contest1` for every existing row;
- those four settings are removed from `Config`; `admin_password` stays.

Your problems, teams, members/emails and submissions carry over. Participants who were logged in before the upgrade are sent back to the login screen once (the saved session has no contest in it).

### Part B — Frontend: GitHub Pages

1. Create a new GitHub repository (public is fine — there is nothing secret in it).
2. Upload everything in this folder (`index.html`, `leaderboard.html`, `admin.html`, `style.css`, `common.js`, `app.js`, `leaderboard.js`, `admin.js`, `config.js`, `.nojekyll`, `README.md`, `backend/Code.gs`).
3. Edit `config.js` and paste your Web app URL:
   ```js
   window.CONTEST_CONFIG = {
     API_URL: 'https://script.google.com/macros/s/AKfycb.../exec',
   };
   ```
4. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save**. After a minute your site is at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.
   - Participants: `…/index.html` (or `…/index.html?contest=ID` to preselect a contest).
   - Spectators: `…/leaderboard.html?contest=ID`.
   - Organizers: `…/admin.html`.

### Part C — Do a dry run (really, do this)

1. In `Contests`, set the `sample` contest's `Start time` to a couple of minutes from now.
2. Open the site, pick *Sample Contest*, passcode `pumpkin`, log in as `Test Team` / `test123`. You should see the countdown, then Round 1 should appear by itself.
3. Type some answers (watch the previews), submit a round, confirm Round 2 appears, open `leaderboard.html` and `admin.html`.
4. In the sheet, use **Contest → Delete submissions of one contest…** (ID `sample`) to wipe the test data, then delete or rename the sample rows.
5. Use **Contest → Check setup** to catch missing answers, rounds with the wrong number of problems, teams without codes, or rows pointing at an unknown contest ID.

---

## Writing problems

- Inline math: `Find $x$ if $2x + 3 = 11$.`  Display math: `$$\int_0^1 x^2\,dx$$`, `\[ ... \]`, or `\begin{align*} ... \end{align*}` (also `align`, `gather`, `equation`, `alignat`). Anything KaTeX supports works inside math.
- **Pasting from a .tex file** mostly just works. Besides math, these text-mode constructs are understood: `\begin{center}`, `\begin{flushright}`, `\begin{itemize}` / `\begin{enumerate}` with `\item`, `\textit{}` / `\emph{}`, `\textbf{}`, `\underline{}`, `\texttt{}`, `\\` and `\newline`, `~`, `\%`, `\$`, `\&`, `\_`, `\ldots`, ``` ``quotes'' ```, `%` comments, and layout no-ops like `\noindent`, `\centering`, `\vspace{}`. Anything else is shown as typed, so you'll notice it in the admin preview. Not supported: `tabular`, `\newcommand`, and anything that needs a package other than the symbols below.
- **Figures (Asymptote, TikZ, `\includegraphics`)** cannot be drawn in a browser — the page shows an orange *Figure missing* note where they were. Make the drawing an image and put it in the `Image URL` column, in either form:
  - **paste the SVG itself** into the cell (the whole `<svg ...>...</svg>` text; cells hold up to 50,000 characters, enough for most figures). Get it from `asy -f svg figure.asy` locally, or from the online Asymptote app (asymptote.ualberta.ca → choose SVG output), or from TikZ via `dvisvgm`. Nothing to host, and nothing in the repo.
  - or a **direct URL** to a PNG/SVG hosted somewhere not guessable (not in this repo, or it's visible). Then delete the `\begin{asy}...\end{asy}` block from the problem text.
- **Halloween symbols** (from the LaTeX package `halloweenmath`): `\mathghost`, `\pumpkin`, `\skull`, `\mathbat` work inside math, e.g. `If $3\pumpkin + 2\mathghost = \skull$, find $\mathbat$.` They render as icons in the text color and scale with the font. They are also fine inside answers (`\pumpkin` is accepted for `\pumpkin`). Other `halloweenmath` commands are not defined; to add one, draw an SVG, add a `.hwm-NAME` rule in `style.css` and a line in `HALLOWEEN` in `common.js`.
- The `Problem`, `Answer` and `Image URL` columns are formatted as plain text by `setup`, so things like `1/2` aren't turned into dates by Sheets. If you ever add columns or paste over them, keep them as plain text (Format → Number → Plain text).
- **Accepted answers**: list every form you'll accept, separated by `|`, e.g. `\frac{5}{6}|5/6`. Grading already treats these as equal, so you usually don't need alternatives for them:
  - `\frac{1}{2}` = `\dfrac{1}{2}` = `1/2` = `$\frac{1}{2}$` = ` 1 / 2 `
  - `2\sqrt{5}` = `2\sqrt5`,  `\frac{\sqrt{3}}{2}` = `\sqrt3/2`,  `\frac{\pi}{4}` = `\pi/4`
  - `45^\circ` = `45°` = `45`,  `x^{2}` = `x^2`,  `\text{none}` = `None`,  `12.` = `12`,  `\boxed{7}` = `7`
  - numbers compare numerically: `1,000` = `1000`, `3.10` = `3.1`
  - **not** automatically equal: `1/2` vs `0.5`, `2^{10}` vs `1024` — list both if you want to accept both.
- **Points**: whatever you like per problem. Score = sum of points for correct answers.
- **Images** show under the problem text, centered; see *Figures* above.
- **Rules**: edit the list inside `<div id="rules-content">` in `index.html` (look for the `EDIT YOUR RULES HERE` comment). The numbers in `<span data-fill="…">` are filled in from the contest the team is logged in to.

Edits to the `Problems` tab are picked up within about a minute (the backend caches them briefly); edits to `Config`/`Contests` within ~15 seconds. **Contest → Apply edits now** forces it immediately.

## Running a contest

- **Participants** open the site any time before the start, pick the contest, log in, and leave the tab open. Round 1 appears automatically; the header shows the shared countdown.
- **Spectators** watch `leaderboard.html?contest=ID`. Scores update live as rounds are submitted. If you'd rather reveal scores only at the end, set `Show leaderboard` to `FALSE` during the contest and flip it to `TRUE` afterwards.
- **Organizers** open `admin.html` (auto‑refreshes every 15 s), switch contests with the dropdown, and/or watch the `Submissions` tab fill up.
- **Override a grade**: in `Submissions`, change the `Correct N` cell to `TRUE`/`FALSE`. Both the admin page and the public leaderboard recompute from those cells (ignore the `Points` column, it's just what was computed at submission time).
- **Extend the time** (e.g. technical trouble): change that contest's `Duration (min)`. Everyone's timer updates within about a minute.
- **Restart a team**: delete that team's rows from `Submissions` — they go back to the round after the last remaining row.
- **Reset a contest**: **Contest → Delete submissions of one contest…**. Other contests are untouched.
- Late submissions are accepted for 20 seconds after the end to absorb slow networks (`GRACE_SECONDS` in `Code.gs`).
- Several members of one team can log in on their own devices (each fills in the form; member names are merged into the team's row). The team's progress is shared: when one member submits a round, the others see the next round after a refresh — or when they try to submit, in which case their page tells them a teammate already submitted and shows the next round. Only the first submission of a round counts.

## Customizing

- **Rounds**: just add/remove rows in `Problems`; a contest's number of rounds is its highest `Round` value.
- **Problems per round**: change `PROBLEMS_PER_ROUND` in `Code.gs` *before* running `setup` (it decides how many `Answer`/`Correct` columns the `Submissions` tab has), then redeploy.
- **Look**: all styling is in `style.css` (colors at the top).
- **Text**: all participant‑facing wording is in `index.html`, `leaderboard.html` and `app.js`.

## Troubleshooting

- **"Something went wrong" / "Could not reach the contest server"** — check that `config.js` has the `/exec` URL, and that the deployment's *Who has access* is **Anyone**. Open the `/exec` URL in a browser: you should see "Contest backend is running."
- **Error mentions a missing tab** — run `setup` in the Apps Script editor.
- **"Argument too large: value"** — you have an old `Code.gs` and several SVGs in the Image column; the backend's cache has a 100 KB limit. Paste the current `Code.gs` (caching is optional now) and redeploy a new version.
- **Error mentions a start time** — use the ISO format shown above, with the offset; the message names the contest.
- **Changed `Code.gs` but nothing happened** — you need a new deployment version (see Part A).
- **The login page says "No contests have been set up yet"** — the `Contests` tab has no rows with an `ID`.
- **The timer looks wrong for someone** — it uses the server's clock, not the participant's; a wrong time on their computer doesn't matter. Check the start time on `admin.html`.
- **Answers like `1/2` show up as dates in the sheet** — a column lost its plain‑text format; reformat it (Format → Number → Plain text). The site itself stores submissions as text automatically.

## Limits worth knowing

- Google Apps Script handles roughly 30 simultaneous requests. Participants' pages spread their start‑time requests over a few seconds and retry automatically, which is fine for a few dozen teams. For 100+ teams, test with that many browser tabs beforehand, or consider a different backend. Contests that run at the same time share this limit.
- Each request to Apps Script takes about a second, so the page shows a brief "Submitting…" state. That's normal.
- Everything in the Sheet is only as private as your Google account. Don't share the sheet or the admin password.
