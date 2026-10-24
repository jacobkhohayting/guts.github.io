# Contest site (8 rounds × 3 problems, one-way, 60 minutes)

A plain static website for a timed team contest, hosted free on **GitHub Pages**, with a tiny private backend that lives in **your own Google Sheet** (Google Apps Script). Nothing secret is ever in the GitHub repo.

**What participants get**

- Log in with a team name + team code.
- A countdown to the scheduled start. **No start button** — Round 1 appears for everyone at the same moment.
- One round at a time, 3 problems per round, 8 rounds. Problems are typeset with LaTeX (KaTeX).
- An answer box per problem with a **live LaTeX preview** of exactly what they are submitting, plus a final review before the round is locked.
- Submitting a round locks it forever and immediately reveals the next round. **No going back.**
- A single 60‑minute contest clock shared by everyone, driven by the server's time. When it hits zero, whatever is typed is auto‑submitted.
- A **Rules** button available at all times.
- Typed answers survive a refresh (saved on the device).

**What organizers get**

- `admin.html`: a password‑protected live scoreboard, every submission with ✓/✗ auto‑grading, rendered answers, and a preview of all problems to check the LaTeX.
- The Google Sheet itself: the raw log (`Submissions` tab), where you can override any grade by hand.

## How the problems stay hidden

| Where it lives | Visible to |
|---|---|
| Problems, answers, points, team codes, admin password, start time | Only your Google Sheet (private) |
| This repo (HTML/CSS/JS + a copy of the Apps Script code) | Public — contains **no** problems or secrets |

The backend only ever sends a team the problems of **its current round**, and only after the start time (checked on the server's clock). Round N is released to a team only after that team has submitted rounds 1…N‑1. A round can be submitted exactly once. Someone who finds your GitHub repo finds nothing but the website's skeleton.

Participants *can* submit blank rounds to move ahead quickly — that is allowed on purpose (it's the usual rule for this format), but those rounds are then locked. With `open_registration` set to `FALSE` (the default), only the team names + codes you list can log in, so nobody can create a throwaway team to peek ahead.

---

## Setup (about 15 minutes)

### Part A — Backend: Google Sheet + Apps Script

1. Create a new Google Sheet (any name).
2. In the sheet: **Extensions → Apps Script**. Delete the default code, paste the whole contents of `backend/Code.gs`, and press **Save** (💾).
3. In the toolbar, pick **`setup`** in the function dropdown and click **▶ Run**. Approve the permissions when asked (Review permissions → choose your account → *Advanced → Go to (project name)* → Allow). This creates four tabs in your sheet: `Config`, `Problems`, `Teams`, `Submissions`.
4. Go back to the sheet and fill in:
   - **Config**
     - `contest_name` — shown in the header.
     - `start_time` — when the contest starts, in ISO format **with a UTC offset**, e.g. `2026-11-07T14:00:00-05:00` (`-05:00` = US Eastern Standard Time, `-04:00` = Eastern Daylight Time, `+00:00` = UTC). You can verify how it was understood on `admin.html` (it shows the start time in your local time).
     - `duration_minutes` — `60`.
     - `admin_password` — change it.
     - `open_registration` — keep `FALSE` unless you want anyone to be able to make a team.
   - **Problems** — 24 rows: `Round`, `Problem #`, `Problem` (LaTeX between `$...$`, `$$...$$` for display math; line breaks inside a cell are kept), `Accepted answer(s)` (alternatives separated by `|`), `Points`, and an optional `Image URL`. Sample rows are there to show the format — replace them.
   - **Teams** — one row per team: `Team Name`, `Access Code`. Give each team its code privately. (Team names are matched case‑insensitively; codes too.)
5. **Deploy → New deployment**. Click the gear next to *Select type* → **Web app**. Set:
   - Description: anything
   - Execute as: **Me**
   - Who has access: **Anyone** (this exact option — not "Anyone with a Google account")
   
   Click **Deploy**, approve permissions again if asked, and **copy the Web app URL** (ends in `/exec`).

> Whenever you change `Code.gs` later, you must publish a new version: **Deploy → Manage deployments → ✎ Edit → Version: New version → Deploy**. The URL stays the same. (Editing the *sheet* never needs a redeploy.)

### Part B — Frontend: GitHub Pages

1. Create a new GitHub repository (public is fine — there is nothing secret in it).
2. Upload everything in this folder (`index.html`, `admin.html`, `style.css`, `common.js`, `app.js`, `admin.js`, `config.js`, `.nojekyll`, `README.md`, `backend/Code.gs`).
3. Edit `config.js` and paste your Web app URL:
   ```js
   window.CONTEST_CONFIG = {
     API_URL: 'https://script.google.com/macros/s/AKfycb.../exec',
   };
   ```
4. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save**. After a minute your site is at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.
   - Participants use that URL.
   - Organizers use `https://YOUR-USERNAME.github.io/YOUR-REPO/admin.html`.

### Part C — Do a dry run (really, do this)

1. In `Config`, set `start_time` to a couple of minutes from now.
2. Open the site, log in as `Test Team` / `test123` (a sample team `setup` created). You should see the countdown, then Round 1 should appear by itself.
3. Type some answers (watch the previews), submit a round, confirm Round 2 appears and that `admin.html` shows the submission and the grading.
4. In the sheet, use the **Contest → Delete ALL submissions…** menu to wipe the test data, delete the sample teams, and set the real `start_time`.
5. Use **Contest → Check setup** to catch missing answers, rounds with the wrong number of problems, or teams without codes.

---

## Writing problems

- Inline math: `Find $x$ if $2x + 3 = 11$.`  Display math: `$$\int_0^1 x^2\,dx$$`. Anything KaTeX supports works.
- The `Problem`, `Answer` and `Image URL` columns are formatted as plain text by `setup`, so things like `1/2` aren't turned into dates by Sheets. If you ever add columns or paste over them, keep them as plain text (Format → Number → Plain text).
- **Accepted answers**: list every form you'll accept, separated by `|`, e.g. `\frac{5}{6}|5/6`. Grading already treats these as equal, so you usually don't need alternatives for them:
  - `\frac{1}{2}` = `\dfrac{1}{2}` = `1/2` = `$\frac{1}{2}$` = ` 1 / 2 `
  - `2\sqrt{5}` = `2\sqrt5`,  `\frac{\sqrt{3}}{2}` = `\sqrt3/2`,  `\frac{\pi}{4}` = `\pi/4`
  - `45^\circ` = `45°` = `45`,  `x^{2}` = `x^2`,  `\text{none}` = `None`,  `12.` = `12`,  `\boxed{7}` = `7`
  - numbers compare numerically: `1,000` = `1000`, `3.10` = `3.1`
  - **not** automatically equal: `1/2` vs `0.5`, `2^{10}` vs `1024` — list both if you want to accept both.
- **Points**: whatever you like per problem (the samples increase by round). Score = sum of points for correct answers.
- **Images**: paste a direct image URL in the `Image URL` column. Host it somewhere that isn't guessable (not in this repo, or it's visible). The image is shown under the problem text.
- **Rules**: edit the list inside `<div id="rules-content">` in `index.html` (look for the `EDIT YOUR RULES HERE` comment). Plain HTML; `$...$` LaTeX works there too.

Edits to the `Problems` tab are picked up within about a minute (the backend caches them briefly); edits to `Config` within ~15 seconds. **Contest → Apply edits now** forces it immediately.

## Running the contest

- **Participants** open the site any time before the start, log in, and leave the tab open. Round 1 appears automatically; the header shows the shared countdown.
- **Organizers** open `admin.html` (auto‑refreshes every 15 s) and/or watch the `Submissions` tab fill up.
- **Override a grade**: in `Submissions`, change the `Correct N` cell to `TRUE`/`FALSE`. The admin page recomputes scores from those cells (ignore the `Points` column, it's just what was computed at submission time).
- **Extend the time** (e.g. technical trouble): change `duration_minutes`. Everyone's timer updates within about a minute.
- **Restart a team**: delete that team's rows from `Submissions` — they go back to the round after the last remaining row.
- Late submissions are accepted for 20 seconds after the end to absorb slow networks (`GRACE_SECONDS` in `Code.gs`).
- Teams don't see whether their answers were right; only organizers do. Announce results however you like.

## Customizing

- **Rounds**: just add/remove rows in `Problems`; the number of rounds is whatever the highest `Round` value is.
- **Problems per round**: change `PROBLEMS_PER_ROUND` in `Code.gs` *before* running `setup` (it decides how many `Answer`/`Correct` columns the `Submissions` tab has), then redeploy.
- **Look**: all styling is in `style.css` (colors at the top).
- **Text**: all participant‑facing wording is in `index.html` and `app.js`.

## Troubleshooting

- **"Something went wrong" / "Could not reach the contest server"** — check that `config.js` has the `/exec` URL, and that the deployment's *Who has access* is **Anyone**. Open the `/exec` URL in a browser: you should see "Contest backend is running."
- **Error mentions a missing tab** — run `setup` in the Apps Script editor.
- **Error mentions `start_time`** — use the ISO format shown above, with the offset.
- **Changed `Code.gs` but nothing happened** — you need a new deployment version (see Part A).
- **The timer looks wrong for someone** — it uses the server's clock, not the participant's; a wrong time on their computer doesn't matter. Check `start_time` on `admin.html`.
- **Answers like `1/2` show up as dates in the sheet** — a column lost its plain‑text format; reformat it (Format → Number → Plain text). The site itself stores submissions as text automatically.

## Limits worth knowing

- Google Apps Script handles roughly 30 simultaneous requests. Participants' pages spread their start‑time requests over a few seconds and retry automatically, which is fine for a few dozen teams. For 100+ teams, test with that many browser tabs beforehand, or consider a different backend.
- Each request to Apps Script takes about a second, so the page shows a brief "Submitting…" state. That's normal.
- Everything in the Sheet is only as private as your Google account. Don't share the sheet or the admin password.
