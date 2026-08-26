# Class Tracker

A local dashboard for classes, syllabi, and deadlines. No account, no cloud, no build step, just Python's standard library and vanilla JS. Data is stored as plain JSON files on your own machine, under `data/`.

## Run it

```bash
git clone https://github.com/<your-username>/class-tracker.git
cd class-tracker
python3 server.py
```

Open http://127.0.0.1:8420 in your browser. Leave the terminal running while you use it, `Ctrl+C` to stop.

No dependencies to install and nothing to build. The app creates its own `data/` folder on first run, starting empty.

Optional: add an alias so you can just type `classes` from anywhere.

```bash
echo 'alias classes="cd /path/to/class-tracker && python3 server.py"' >> ~/.zshrc
```

## What it does

- **Dashboard**: everything due soon (7/14/30 day filter) sorted by priority, upcoming exams with a countdown, and quick stats.
- **Priority ranking**: due-soon items get a priority chip (🔥/⚡/🌱). Priority is how much the item is worth toward your final grade, times how soon it's due. A 30%-weighted final counts for more than a 2%-weighted homework even if the homework is due first, but something due tomorrow still gets bumped up.
- **Timetable**: a weekly grid built from each course's meeting days/times, color-coded per class.
- **Courses**: one card per class with code, name, professor, color, meeting times, grading weightage (with a running total-should-be-100% check), exam dates, free-text syllabus notes, and assignments. Courses are listed worst-grade-first, so the class you're struggling in doesn't get ignored.
- **Grades**: per-course estimated current grade, same worst-to-best ordering as Courses, computed from your weightage categories and whatever scores you've entered.
- **Settings → Canvas Sync**: optional. Pulls courses, due dates, and grading weightage from Canvas.
- **Notifications**: opt-in browser notification for anything due within 24 hours.
- **Backup**: export/import everything as JSON.

To get grade estimates and priority ranking working, enter a course's weightage categories, then set each assignment's category (matching a weightage name) and, once graded, its score. Anything ungraded or unmatched still shows up with a low baseline priority instead of being hidden.

## Connecting Canvas

Works with any school on Canvas. The Settings tab has three methods, in order of how easy they are to set up:

1. **Calendar Feed**: paste your Canvas calendar feed URL. Due dates only, but works even if your school has disabled access tokens.
2. **Browser Sync**: install the included Tampermonkey userscript (`public/canvas-sync.user.js`) and sync from a logged-in Canvas tab. Gets due dates, points, and grading weights without a token.
3. **Access Token**: Canvas → Account → Settings → Approved Integrations → New Access Token. Paste the token and your school's Canvas base URL (e.g. `https://yourschool.instructure.com`) into the app.

Whichever method you use, the token/URL is saved only in `data/config.json` on your machine and sent only to your Canvas domain.

What sync fills in automatically: courses, assignment/quiz due dates, and grading category weights.

What you still add by hand: meeting days/times, locations, and exam dates (Canvas doesn't expose a reliable "class schedule" or "exam" API, so this isn't something sync can get). Sync is safe to re-run any time - it updates existing items instead of duplicating them, and never touches meeting times, colors, or notes you've entered.

You don't need Canvas at all. Adding courses by hand in the Courses tab works exactly the same as synced courses.

## Data files

Everything lives in plain JSON under `data/`, created automatically on first run:

- `data/courses.json` - your courses
- `data/assignments.json` - assignments/exams/quizzes
- `data/config.json` - Canvas URL and token
- `data/notes.json`, `data/conflicts.json`, `data/canvas_dismissed.json`, `data/undo_history.json` - notes, Canvas-sync bookkeeping, undo history

This folder is gitignored, so your data stays local and never gets committed. Back it up (or use the in-app Export button) before wiping your machine.
