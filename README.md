# Class Tracker

A tiny, local, zero-dependency dashboard for classes, syllabi, and deadlines. No account, no cloud, no build step — just Python's standard library and vanilla JS. Your data lives in plain JSON files on your own machine (`data/`).

## Run it

```bash
git clone https://github.com/<your-username>/class-tracker.git
cd class-tracker
python3 server.py
```

Then open **http://127.0.0.1:8420** in your browser. Leave the terminal window open while you use it; `Ctrl+C` to stop.

That's it — no dependencies to install, no build step, no account. The app creates its own `data/` folder on first run and starts empty, ready for you to add your own courses.

(Optional) Add an alias so you can just type `classes` from anywhere:

```bash
echo 'alias classes="cd /path/to/class-tracker && python3 server.py"' >> ~/.zshrc
```

## What it does

- **Dashboard** — everything due soon (7/14/30 day filter), sorted by **priority**, upcoming exams with a live countdown, and quick stats (courses, items due this week, days to next exam).
- **Priority ranking** — each due-soon item gets a 🔥/⚡/🌱 priority chip. Priority = how much the item is worth toward your final grade (from that course's weightage categories, split across assignments in the category by points) × how soon it's due. A 30%-weighted final counts for more than a 2%-weighted homework, even if the homework is due first — but something due tomorrow still gets bumped up.
- **Timetable** — a weekly grid built from each course's meeting days/times, color-coded per class.
- **Courses** — one card per class: code, name, professor, color, meeting times, grading weightage (with a running total-should-be-100% check), exam dates, free-text syllabus notes (paste in your grading/late policy), and its assignments (with score + category fields so grade/priority math has something to work with). **Courses are listed worst-grade-first** — the class you're struggling in floats to the top so it doesn't get ignored.
- **Grades** — per-course estimated current grade (same worst-to-best ranking as the Courses tab), computed from your weightage categories and any scores you enter on assignments (shows how much of the weight is graded so far).
- **Settings → Canvas Sync** — optional; pulls your active courses, assignment due dates, and grading weightage straight from Canvas.
- **Notifications** — opt-in browser notification when something's due within 24 hours.
- **Backup** — one-click export/import of everything as JSON, so you're never locked in.

To get grade estimates and priority ranking working for a course, enter its weightage categories, then on each assignment set its **category** (matching a weightage name) and, once graded, its **score**. Ungraded/unmatched items still show up with a low-confidence baseline priority so nothing's hidden.

## Connecting Canvas

Works with any school on Canvas (Instructure) — see the **Settings** tab in the app for three methods, in order of ease:

1. **Calendar Feed** — paste your Canvas calendar feed URL. Gets due dates only, but works even if your school has disabled access tokens.
2. **Browser Sync** — install the included Tampermonkey userscript (`public/canvas-sync.user.js`) and sync straight from a logged-in Canvas tab. Gets due dates, points, and grading weights, no token needed.
3. **Access Token** — go to Canvas → **Account → Settings** → **Approved Integrations** → **+ New Access Token**, then paste the token and your school's Canvas base URL (e.g. `https://yourschool.instructure.com`) into the app.

Whichever method you use, the token/URL is saved only in `data/config.json` on your own machine and is sent only to your Canvas domain — nothing else touches it.

**What Canvas sync fills in automatically:** courses, assignment/quiz due dates, and grading category weights (from Canvas's assignment groups).

**What you still add by hand:** class meeting days/times and locations, and exam dates for exams Canvas doesn't expose as assignments (Canvas has no reliable "class schedule" or "exam" API — this is a real gap in Canvas, not a shortcut we took). Sync is safe to re-run any time; it updates existing items instead of duplicating them, and never overwrites the meeting times, colors, or notes you've entered.

If you don't want to use Canvas at all, just add your courses by hand in the **Courses** tab, pasting details straight from your syllabus PDFs — that's the "hardcode" path and it works exactly the same as synced courses.

## Data files

Everything lives in plain JSON under `data/`, created automatically on first run:

- `data/courses.json` — your courses
- `data/assignments.json` — assignments/exams/quizzes
- `data/config.json` — Canvas URL + token
- `data/notes.json`, `data/conflicts.json`, `data/canvas_dismissed.json`, `data/undo_history.json` — notes, Canvas-sync bookkeeping, and undo history

This folder is gitignored — your data stays local and never gets committed. Back it up (or just use the in-app Export button) before wiping your machine.
