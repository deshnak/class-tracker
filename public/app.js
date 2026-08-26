// ---------- State ----------
let courses = [];
let assignments = [];
let notes = [];
let conflicts = [];
let dueSoonDays = 7;
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const COLORS = ["#7c5cff", "#ec4899", "#3b82f6", "#14b8a6", "#f59e0b", "#f43f5e", "#06b6d4", "#8b5cf6"];
const NOTE_COLORS = ["#f59e0b", "#ec4899", "#3b82f6", "#14b8a6", "#8b5cf6"];

// ---------- API ----------
const api = {
  get: (p) => fetch(p).then(r => r.json()),
  post: (p, body) => fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()),
  put: (p, body) => fetch(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()),
  del: (p) => fetch(p, { method: "DELETE" }).then(r => r.json()),
};

async function loadAll() {
  [courses, assignments, notes, conflicts] = await Promise.all([
    api.get("/api/courses"), api.get("/api/assignments"), api.get("/api/notes"), api.get("/api/conflicts"),
  ]);
  renderAll();
}

function renderAll() {
  renderConflicts();
  renderDashboard();
  renderTimetable();
  renderCourses();
  renderGrades();
  renderNotes();
  refreshUndoStatus();
}

function courseById(id) { return courses.find(c => c.id === id); }

// ---------- Priority & grade estimation ----------
// How much of the course grade a single assignment is worth, as a percent (0-100).
// Uses the course's weightage category for the assignment's group, split across
// that group's assignments by points (or evenly, if points aren't set).
function assignmentWeightPercent(a) {
  const c = courseById(a.courseId);
  if (!c) return 3;
  const category = (c.weightage || []).find(w => w.name === a.group);
  if (!category) return 3; // small baseline so untagged items still show up, but rank low
  const siblings = assignments.filter(x => x.courseId === a.courseId && (x.group || "") === a.group);
  const withPoints = siblings.filter(s => s.points);
  const totalPoints = withPoints.reduce((s, x) => s + x.points, 0);
  if (a.points && totalPoints > 0) {
    return category.percent * (a.points / totalPoints);
  }
  return category.percent / siblings.length;
}

// Combines grade-weight with urgency: closer due dates get boosted, worth-more items get boosted.
function priorityScore(a) {
  const weight = assignmentWeightPercent(a);
  const days = daysUntil(a.dueDate);
  const urgencyMultiplier = 1 + Math.max(0, (14 - Math.min(Math.max(days, 0), 14)) / 14) * 0.8;
  return weight * urgencyMultiplier;
}
function priorityTier(score) {
  if (score >= 18) return "high";
  if (score >= 8) return "medium";
  return "low";
}
function priorityChipHtml(a) {
  const score = priorityScore(a);
  const tier = priorityTier(score);
  const label = tier === "high" ? "🔥 high priority" : tier === "medium" ? "⚡ medium priority" : "🌱 low priority";
  return `<span class="priority-chip priority-${tier}" title="~${assignmentWeightPercent(a).toFixed(1)}% of course grade">${label}</span>`;
}

// Current estimated grade for a course, from weightage categories + any scored assignments.
function computeCourseGrade(c) {
  const weightage = c.weightage || [];
  if (!weightage.length) return null;
  const courseAssignments = assignments.filter(a => a.courseId === c.id);
  let earnedWeight = 0, totalGradedWeight = 0;
  const catBreakdown = weightage.map(w => {
    const inCat = courseAssignments.filter(a => (a.group || "") === w.name && a.score != null && a.points);
    let catAvg = null;
    if (inCat.length) {
      catAvg = inCat.reduce((s, a) => s + (a.score / a.points), 0) / inCat.length;
      earnedWeight += catAvg * w.percent;
      totalGradedWeight += w.percent;
    }
    return { name: w.name, percent: w.percent, avg: catAvg };
  });
  const overall = totalGradedWeight > 0 ? (earnedWeight / totalGradedWeight * 100) : null;
  return { overall, totalGradedWeight, catBreakdown };
}

// ---------- Tabs ----------
document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
});

// ---------- Dark mode ----------
// Light (the paper ledger) is the default; dark is an opt-in "night ledger" variant.
function applyTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  document.getElementById("darkToggle").textContent = saved === "dark" ? "☀️" : "🌙";
}
document.getElementById("darkToggle").addEventListener("click", () => {
  const isDark = localStorage.getItem("theme") === "dark";
  localStorage.setItem("theme", isDark ? "light" : "dark");
  applyTheme();
});
applyTheme();

// ---------- Date helpers ----------
// Parse "YYYY-MM-DD" (or "YYYY-MM-DDTHH:MM:SS") as a LOCAL calendar date.
// `new Date("YYYY-MM-DD")` parses as UTC midnight, which rolls back a day in any
// timezone behind UTC once displayed locally (e.g. a Tue exam shows as Monday) - always go through this.
function parseLocalDate(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function daysUntil(dateStr) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = parseLocalDate(dateStr).getTime();
  return Math.round((target - startToday) / 86400000);
}
function fmtWhen(dateStr) {
  const n = daysUntil(dateStr);
  if (n < 0) return "Past due";
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n <= 7) return `In ${n} days`;
  return parseLocalDate(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function urgencyClass(dateStr) {
  const n = daysUntil(dateStr);
  if (n <= 1) return "urgent-red";
  if (n <= 4) return "urgent-orange";
  return "urgent-green";
}
function fmtDateNice(dateStr) {
  if (!dateStr) return "";
  return parseLocalDate(dateStr).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

// ---------- Canvas Check ----------
function renderConflicts() {
  const card = document.getElementById("conflictsCard");
  if (!conflicts.length) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";
  document.getElementById("conflictsCount").textContent = `${conflicts.length} to review`;
  document.getElementById("conflictsList").innerHTML = conflicts.map(c => conflictRowHtml(c)).join("");

  document.querySelectorAll("[data-resolve]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await api.post(`/api/conflicts/${btn.dataset.resolve}/resolve`, { resolution: btn.dataset.resolution });
      await loadAll();
    });
  });
}

function conflictRowHtml(c) {
  const course = courseById(c.courseId);
  const courseLabel = course ? course.code : "";
  const dot = course ? course.color : "#999";

  if (c.type === "conflict") {
    const fieldLabel = c.field === "dueDate" ? "Due date" : "Points";
    const fmt = (v) => c.field === "dueDate" ? (v ? fmtDateNice(v.slice(0, 10)) : "—") : (v == null ? "—" : v + " pts");
    return `<div class="item">
      <div class="dot" style="background:${dot}"></div>
      <div class="info">
        <div class="title">${escapeHtml(c.title)}</div>
        <div class="sub">${escapeHtml(courseLabel)} &middot; ${fieldLabel} &mdash; yours: ${fmt(c.localValue)} &nbsp;vs&nbsp; Canvas: ${fmt(c.canvasValue)}</div>
      </div>
      <div class="btn-row" style="margin-top:0;">
        <button class="btn small" data-resolve="${c.id}" data-resolution="mine">Keep Mine</button>
        <button class="btn small primary" data-resolve="${c.id}" data-resolution="canvas">Use Canvas's</button>
      </div>
    </div>`;
  }

  const dueLabel = c.canvasValue ? fmtDateNice(c.canvasValue.slice(0, 10)) : "no due date";
  return `<div class="item">
    <div class="dot" style="background:${dot}"></div>
    <div class="info">
      <div class="title">${escapeHtml(c.title)} <span class="priority-chip priority-medium">new on canvas</span></div>
      <div class="sub">${escapeHtml(courseLabel)} &middot; ${dueLabel}${c.points != null ? " &middot; " + c.points + " pts" : ""}${c.group ? " &middot; " + escapeHtml(c.group) : ""}</div>
    </div>
    <div class="btn-row" style="margin-top:0;">
      <button class="btn small" data-resolve="${c.id}" data-resolution="ignore">Skip</button>
      <button class="btn small primary" data-resolve="${c.id}" data-resolution="add">Add It</button>
    </div>
  </div>`;
}

// ---------- Dashboard ----------
document.getElementById("dueSoonFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  document.querySelectorAll("#dueSoonFilter .seg-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  dueSoonDays = parseInt(btn.dataset.days, 10);
  renderDashboard();
});

function renderDashboard() {
  const pending = assignments.filter(a => !a.completed);
  const dueSoon = pending.filter(a => a.dueDate && daysUntil(a.dueDate) <= dueSoonDays && daysUntil(a.dueDate) >= -1)
    .sort((a, b) => priorityScore(b) - priorityScore(a));

  const allExams = [];
  courses.forEach(c => (c.examDates || []).forEach(e => allExams.push({ ...e, courseId: c.id })));
  const upcomingExams = allExams.filter(e => e.date && daysUntil(e.date) >= -1)
    .sort((a, b) => parseLocalDate(a.date) - parseLocalDate(b.date));

  const dueThisWeek = pending.filter(a => a.dueDate && daysUntil(a.dueDate) <= 7 && daysUntil(a.dueDate) >= 0).length;
  const nextExam = upcomingExams[0];

  document.getElementById("statRow").innerHTML = `
    <div class="stat-tile"><div class="num">${courses.length}</div><div class="label">Courses</div></div>
    <div class="stat-tile ${dueThisWeek > 0 ? "urgent" : ""}"><div class="num">${dueThisWeek}</div><div class="label">Due This Week</div></div>
    <div class="stat-tile"><div class="num">${pending.length}</div><div class="label">Open Assignments</div></div>
    <div class="stat-tile ${nextExam && daysUntil(nextExam.date) <= 7 ? "urgent" : ""}">
      <div class="num">${nextExam ? daysUntil(nextExam.date) : "–"}</div>
      <div class="label">${nextExam ? "Days to Next Exam" : "No Exams Set"}</div>
    </div>
  `;

  document.getElementById("dueSoonList").innerHTML = dueSoon.length ? dueSoon.map(a => itemRow(a)).join("") :
    `<div class="empty-note">Nothing due in the next ${dueSoonDays} days. 🎉</div>`;

  document.getElementById("examList").innerHTML = upcomingExams.length ? upcomingExams.map(e => {
    const c = courseById(e.courseId);
    return `<div class="item ${urgencyClass(e.date)}">
      <div class="dot" style="background:${c ? c.color : "#999"}"></div>
      <div class="info"><div class="title">${escapeHtml(e.name)}</div><div class="sub">${c ? escapeHtml(c.code) : ""} &middot; ${fmtDateNice(e.date)}</div></div>
      <div class="when">${fmtWhen(e.date)}</div>
    </div>`;
  }).join("") : `<div class="empty-note">No exam dates added yet. Add them in the Courses tab.</div>`;

  const todayN = pending.filter(a => a.dueDate && daysUntil(a.dueDate) >= 0 && daysUntil(a.dueDate) <= 6)
    .sort((a, b) => parseLocalDate(a.dueDate) - parseLocalDate(b.dueDate));
  document.getElementById("todayList").innerHTML = todayN.length ? todayN.map(a => itemRow(a)).join("") :
    `<div class="empty-note">Nothing on the calendar this week.</div>`;

  // Past due, points set, but no score logged — the stuff you'll forget to enter once it's graded.
  const needsGrade = assignments.filter(a => a.dueDate && daysUntil(a.dueDate) < 0 && a.points != null && a.score == null)
    .sort((a, b) => parseLocalDate(a.dueDate) - parseLocalDate(b.dueDate));
  const needsGradeCard = document.getElementById("needsGradeCard");
  needsGradeCard.style.display = needsGrade.length ? "" : "none";
  document.getElementById("needsGradeList").innerHTML = needsGrade.map(a => needsGradeRow(a)).join("");
  document.querySelectorAll(".ng-save").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const input = document.querySelector(`.ng-score[data-id="${id}"]`);
      const val = parseFloat(input.value);
      if (isNaN(val)) { input.focus(); return; }
      const a = assignments.find(x => x.id === id);
      a.score = val;
      await api.put(`/api/assignments/${id}`, a);
      renderAll();
    });
  });

  document.querySelectorAll("[data-toggle-complete]").forEach(cb => {
    cb.addEventListener("change", async (e) => {
      const id = e.target.dataset.toggleComplete;
      const a = assignments.find(x => x.id === id);
      a.completed = e.target.checked;
      await api.put(`/api/assignments/${id}`, a);
      renderAll();
    });
  });

  maybeNotify(dueSoon);
}

function needsGradeRow(a) {
  const c = courseById(a.courseId);
  const daysOverdue = Math.abs(daysUntil(a.dueDate));
  return `<div class="item needs-grade-row">
    <div class="dot" style="background:${c ? c.color : "#999"}"></div>
    <div class="info">
      <div class="title">${escapeHtml(a.title)}</div>
      <div class="sub">${c ? escapeHtml(c.code) : "No course"} &middot; ${daysOverdue}d overdue &middot; out of ${a.points} pts</div>
    </div>
    <input type="number" class="ng-score" data-id="${a.id}" placeholder="score" style="max-width:70px">
    <button class="btn small primary ng-save" data-id="${a.id}">Log</button>
  </div>`;
}

function itemRow(a) {
  const c = courseById(a.courseId);
  const icon = a.type === "exam" ? "📝" : a.type === "quiz" ? "❓" : "📄";
  return `<div class="item ${urgencyClass(a.dueDate)}">
    <input type="checkbox" data-toggle-complete="${a.id}" ${a.completed ? "checked" : ""}>
    <div class="dot" style="background:${c ? c.color : "#999"}"></div>
    <div class="info">
      <div class="title">${icon} ${escapeHtml(a.title)}</div>
      <div class="sub">${c ? escapeHtml(c.code) : "No course"} ${a.points ? "&middot; " + a.points + " pts" : ""} ${priorityChipHtml(a)}</div>
    </div>
    <div class="when">${fmtWhen(a.dueDate)}</div>
  </div>`;
}

// ---------- Notifications ----------
let notifiedOnce = false;
document.getElementById("notifBtn").addEventListener("click", () => {
  Notification.requestPermission().then(p => {
    document.getElementById("notifBtn").textContent = p === "granted" ? "Notifications Enabled ✓" : "Permission Denied";
  });
});
function maybeNotify(dueSoon) {
  if (notifiedOnce || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const urgent = dueSoon.filter(a => daysUntil(a.dueDate) <= 1);
  if (urgent.length) {
    new Notification("Class Tracker", { body: `${urgent.length} item(s) due within 24 hours: ${urgent.map(a => a.title).join(", ")}` });
  }
  notifiedOnce = true;
}

// ---------- Timetable ----------
const TT_HOUR_PX = 44;
function renderTimetable() {
  const startHour = 8;
  // Grid must cover every meeting's actual end time (with an hour of padding), not just a
  // fixed 9pm cutoff - a class ending at 9:15pm was getting silently dropped entirely because
  // it didn't fit inside a grid that stopped at 9:00pm.
  let latestEndHour = 21;
  courses.forEach(c => (c.meetings || []).forEach(m => {
    if (!m.end) return;
    const [eh, em] = m.end.split(":").map(Number);
    const endHourCeil = eh + (em > 0 ? 1 : 0);
    if (endHourCeil > latestEndHour) latestEndHour = endHourCeil;
  }));
  const endHour = latestEndHour + 1;
  const hourCount = endHour - startHour;

  let headerHtml = `<div class="tt-hour-label"></div>`;
  DAY_NAMES.slice(0, 5).forEach(d => headerHtml += `<div class="tt-head">${d}</div>`);

  let hoursHtml = "";
  for (let h = startHour; h < endHour; h++) {
    hoursHtml += `<div class="tt-hour">${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}</div>`;
  }

  let daysHtml = "";
  for (let d = 0; d < 5; d++) {
    daysHtml += `<div class="tt-day-col" data-day="${d}" style="height:${hourCount * TT_HOUR_PX}px; background-size: 100% ${TT_HOUR_PX}px;"></div>`;
  }

  document.getElementById("timetableGrid").innerHTML = `
    <div class="tt-header-row">${headerHtml}</div>
    <div class="tt-body">
      <div class="tt-hours-col">${hoursHtml}</div>
      <div class="tt-days-row">${daysHtml}</div>
    </div>`;

  const totalMinutes = hourCount * 60;
  courses.forEach(c => {
    (c.meetings || []).forEach(m => {
      if (!m.start || !m.end) return;
      const [sh, sm] = m.start.split(":").map(Number);
      const [eh, em] = m.end.split(":").map(Number);
      const startMin = (sh - startHour) * 60 + sm;
      const endMin = (eh - startHour) * 60 + em;
      if (startMin < 0 || endMin > totalMinutes) return;
      (m.days || []).forEach(day => {
        const dIdx = DAY_NAMES.indexOf(day);
        if (dIdx < 0 || dIdx > 4) return;
        const col = document.querySelector(`.tt-day-col[data-day="${dIdx}"]`);
        if (!col) return;
        const block = document.createElement("div");
        block.className = "tt-block";
        block.style.background = c.color || "#5b6df0";
        block.style.top = ((startMin / 60) * TT_HOUR_PX) + "px";
        block.style.height = Math.max(((endMin - startMin) / 60) * TT_HOUR_PX - 2, 16) + "px";
        block.innerHTML = `${escapeHtml(c.code)}<div class="loc">${escapeHtml(m.location || "")}</div>`;
        col.appendChild(block);
      });
    });
  });

  // Courses with no fixed meeting time (async/online) don't show up on the grid at all -
  // list them separately so every class is accounted for somewhere on this page.
  const noMeetingCourses = courses.filter(c => !(c.meetings || []).some(m => m.start && m.end && (m.days || []).length));
  const asyncEl = document.getElementById("timetableAsyncNote");
  if (noMeetingCourses.length) {
    asyncEl.style.display = "";
    asyncEl.innerHTML = noMeetingCourses.map(c =>
      `<span class="async-chip"><span class="dot" style="background:${c.color}"></span>${escapeHtml(c.code)} - no fixed meeting time (async/online)</span>`
    ).join("");
  } else {
    asyncEl.style.display = "none";
  }
}

// ---------- Courses tab ----------
document.getElementById("addCourseBtn").addEventListener("click", async () => {
  const newCourse = {
    code: "New Course", name: "", professor: "", color: COLORS[courses.length % COLORS.length],
    canvasCourseId: null, meetings: [], weightage: [], examDates: [], notes: ""
  };
  const saved = await api.post("/api/courses", newCourse);
  courses.push(saved);
  renderCourses();
  renderTimetable();
  const el = document.querySelector(`.course-card[data-id="${saved.id}"]`);
  if (el) el.classList.add("open");
});

function renderCourses() {
  const list = document.getElementById("courseList");
  if (!courses.length) {
    list.innerHTML = `<div class="empty-note">No courses yet. Add one, or sync Canvas from Settings.</div>`;
    return;
  }
  // Worst grade first, so the class that needs the most attention floats to the top.
  // Courses with no grade data yet (nothing to rank) sort to the bottom.
  const ranked = [...courses].sort((a, b) => {
    const ga = computeCourseGrade(a), gb = computeCourseGrade(b);
    const va = ga && ga.overall != null ? ga.overall : Infinity;
    const vb = gb && gb.overall != null ? gb.overall : Infinity;
    return va - vb;
  });
  list.innerHTML = ranked.map(c => courseCardHtml(c)).join("");
  ranked.forEach(c => wireCourseCard(c));
}

function gradeBadgeHtml(c) {
  const g = computeCourseGrade(c);
  if (!g || g.overall == null) return `<span class="rank-badge grade-none">no grades yet</span>`;
  const pct = g.overall;
  const tier = pct < 75 ? "grade-low" : pct < 90 ? "grade-mid" : "grade-high";
  const face = pct < 75 ? "😬" : pct < 90 ? "🙂" : "🌟";
  return `<span class="rank-badge ${tier}">${face} ${pct.toFixed(1)}%</span>`;
}

function courseCardHtml(c) {
  return `
  <div class="course-card" data-id="${c.id}">
    <div class="course-card-head">
      <div class="course-color-bar" style="background:${c.color}"></div>
      <div class="titles">
        <div class="code">${escapeHtml(c.code)}${c.canvasCourseId ? " · <span title='Synced from Canvas'>🔗</span>" : ""} ${gradeBadgeHtml(c)}</div>
        <div class="name">${escapeHtml(c.name || "")}</div>
      </div>
      <span class="chevron">▶</span>
    </div>
    <div class="course-card-body">
      <div class="field-grid">
        <label>Course Code <input type="text" class="f-code" value="${escapeAttr(c.code)}"></label>
        <label>Course Name <input type="text" class="f-name" value="${escapeAttr(c.name)}"></label>
        <label>Professor <input type="text" class="f-prof" value="${escapeAttr(c.professor || "")}"></label>
        <label>Color <input type="text" class="f-color" value="${escapeAttr(c.color)}" placeholder="#5b6df0"></label>
      </div>

      <div class="subsection">
        <div class="subsection-head"><h4>Meeting Times</h4><button class="btn small add-meeting">+ Add</button></div>
        <div class="row-list meetings-list">${(c.meetings || []).map((m, i) => meetingRowHtml(m, i)).join("")}</div>
      </div>

      <div class="subsection">
        <div class="subsection-head"><h4>Grading Weightage</h4><button class="btn small add-weight">+ Add</button></div>
        <div class="row-list weight-list">${(c.weightage || []).map((w, i) => weightRowHtml(w, i)).join("")}</div>
        <div class="weight-total"></div>
      </div>

      <div class="subsection">
        <div class="subsection-head"><h4>Exam Dates</h4><button class="btn small add-exam">+ Add</button></div>
        <div class="row-list exam-list">${(c.examDates || []).map((e, i) => examRowHtml(e, i)).join("")}</div>
      </div>

      <label>Syllabus Notes (paste grading policy, late policy, etc.)
        <textarea class="f-notes">${escapeHtml(c.notes || "")}</textarea>
      </label>

      <div class="subsection">
        <div class="subsection-head"><h4>Assignments</h4><button class="btn small add-assignment">+ Add</button></div>
        <div class="row-list assignments-list">${assignments.filter(a => a.courseId === c.id).map(a => assignmentRowHtml(a, c)).join("") || `<div class="empty-note">No assignments yet.</div>`}</div>
      </div>

      <div class="btn-row">
        <button class="btn primary save-course">Save Changes</button>
        <button class="btn danger delete-course">Delete Course</button>
      </div>
    </div>
  </div>`;
}

function meetingRowHtml(m, i) {
  const days = m.days || [];
  return `<div class="row-item meeting-row" data-i="${i}">
    <div class="days">${DAY_NAMES.slice(0, 5).map(d => `<span class="day-chip ${days.includes(d) ? "on" : ""}" data-day="${d}">${d}</span>`).join("")}</div>
    <input type="time" class="m-start" value="${m.start || ""}">
    <input type="time" class="m-end" value="${m.end || ""}">
    <input type="text" class="m-loc" placeholder="Location" value="${escapeAttr(m.location || "")}">
    <button class="btn small danger remove-row">✕</button>
  </div>`;
}
function weightRowHtml(w, i) {
  return `<div class="row-item weight-row" data-i="${i}">
    <input type="text" class="w-name" placeholder="Category" value="${escapeAttr(w.name || "")}">
    <input type="number" class="w-pct" placeholder="%" style="max-width:70px" value="${w.percent ?? ""}">
    <button class="btn small danger remove-row">✕</button>
  </div>`;
}
function examRowHtml(e, i) {
  return `<div class="row-item exam-row" data-i="${i}">
    <input type="text" class="e-name" placeholder="Exam name" value="${escapeAttr(e.name || "")}">
    <input type="date" class="e-date" value="${e.date || ""}">
    <button class="btn small danger remove-row">✕</button>
  </div>`;
}
function assignmentRowHtml(a, c) {
  const groupOptions = (c.weightage || []).map(w =>
    `<option value="${escapeAttr(w.name)}" ${a.group === w.name ? "selected" : ""}>${escapeHtml(w.name)}</option>`
  ).join("");
  return `<div class="row-item assignment-row" data-id="${a.id}">
    <input type="checkbox" class="a-done" title="Completed" ${a.completed ? "checked" : ""}>
    <input type="text" class="a-title" placeholder="Title" value="${escapeAttr(a.title || "")}">
    <input type="date" class="a-date" value="${(a.dueDate || "").slice(0, 10)}">
    <select class="a-group" title="Grading category"><option value="">(category)</option>${groupOptions}</select>
    <input type="number" class="a-points" placeholder="pts" title="Points possible" style="max-width:64px" value="${a.points ?? ""}">
    <input type="number" class="a-score" placeholder="score" title="Points earned" style="max-width:64px" value="${a.score ?? ""}">
    <button class="btn small danger remove-assignment">✕</button>
  </div>`;
}

function collectCourseFromCard(card) {
  const id = card.dataset.id;
  const c = courseById(id);
  const meetings = [...card.querySelectorAll(".meeting-row")].map(row => ({
    days: [...row.querySelectorAll(".day-chip.on")].map(d => d.dataset.day),
    start: row.querySelector(".m-start").value,
    end: row.querySelector(".m-end").value,
    location: row.querySelector(".m-loc").value,
  }));
  const weightage = [...card.querySelectorAll(".weight-row")].map(row => ({
    name: row.querySelector(".w-name").value,
    percent: parseFloat(row.querySelector(".w-pct").value) || 0,
  }));
  const examDates = [...card.querySelectorAll(".exam-row")].map(row => ({
    name: row.querySelector(".e-name").value,
    date: row.querySelector(".e-date").value,
  }));
  return {
    ...c,
    code: card.querySelector(".f-code").value,
    name: card.querySelector(".f-name").value,
    professor: card.querySelector(".f-prof").value,
    color: card.querySelector(".f-color").value || "#5b6df0",
    notes: card.querySelector(".f-notes").value,
    meetings, weightage, examDates,
  };
}

function updateWeightTotal(card) {
  const total = [...card.querySelectorAll(".w-pct")].reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
  const el = card.querySelector(".weight-total");
  el.textContent = `Total: ${total}%` + (total !== 100 ? " (should add up to 100%)" : " ✓");
  el.className = "weight-total " + (total === 100 ? "ok" : "bad");
}

function wireCourseCard(c) {
  const card = document.querySelector(`.course-card[data-id="${c.id}"]`);
  if (!card) return;
  updateWeightTotal(card);

  card.querySelector(".course-card-head").addEventListener("click", () => card.classList.toggle("open"));

  card.querySelectorAll(".day-chip").forEach(chip => {
    chip.addEventListener("click", () => chip.classList.toggle("on"));
  });

  card.querySelector(".add-meeting").addEventListener("click", () => {
    const list = card.querySelector(".meetings-list");
    list.insertAdjacentHTML("beforeend", meetingRowHtml({}, list.children.length));
    wireRemoveButtons(card);
    card.querySelectorAll(".day-chip").forEach(chip => chip.addEventListener("click", () => chip.classList.toggle("on")));
  });
  card.querySelector(".add-weight").addEventListener("click", () => {
    card.querySelector(".weight-list").insertAdjacentHTML("beforeend", weightRowHtml({}, 0));
    wireRemoveButtons(card);
    wirePctInputs(card);
  });
  card.querySelector(".add-exam").addEventListener("click", () => {
    card.querySelector(".exam-list").insertAdjacentHTML("beforeend", examRowHtml({}, 0));
    wireRemoveButtons(card);
  });
  card.querySelector(".add-assignment").addEventListener("click", async () => {
    const saved = await api.post("/api/assignments", { courseId: c.id, title: "New Assignment", dueDate: new Date().toISOString().slice(0, 10), points: null, score: null, group: "", type: "assignment" });
    assignments.push(saved);
    renderCourses();
    renderAll();
    const el = document.querySelector(`.course-card[data-id="${c.id}"]`);
    if (el) el.classList.add("open");
  });

  wireRemoveButtons(card);
  wirePctInputs(card);

  card.querySelectorAll(".assignment-row").forEach(row => {
    row.querySelector(".a-done").addEventListener("change", async (e) => {
      const a = assignments.find(x => x.id === row.dataset.id);
      a.completed = e.target.checked;
      await api.put(`/api/assignments/${a.id}`, a);
    });
    row.querySelector(".remove-assignment").addEventListener("click", async () => {
      await api.del(`/api/assignments/${row.dataset.id}`);
      assignments = assignments.filter(x => x.id !== row.dataset.id);
      renderCourses(); renderAll();
    });
  });

  card.querySelector(".save-course").addEventListener("click", async () => {
    const updated = collectCourseFromCard(card);
    const saved = await api.put(`/api/courses/${c.id}`, updated);
    Object.assign(c, saved);
    // Save any inline assignment edits too
    for (const row of card.querySelectorAll(".assignment-row")) {
      const a = assignments.find(x => x.id === row.dataset.id);
      if (!a) continue;
      a.title = row.querySelector(".a-title").value;
      a.dueDate = row.querySelector(".a-date").value;
      a.group = row.querySelector(".a-group").value;
      a.points = parseFloat(row.querySelector(".a-points").value) || null;
      a.score = row.querySelector(".a-score").value === "" ? null : parseFloat(row.querySelector(".a-score").value);
      await api.put(`/api/assignments/${a.id}`, a);
    }
    renderAll();
    flashSaved(card.querySelector(".save-course"));
  });

  card.querySelector(".delete-course").addEventListener("click", async () => {
    if (!confirm(`Delete ${c.code}? This also removes its assignments.`)) return;
    await api.del(`/api/courses/${c.id}`);
    courses = courses.filter(x => x.id !== c.id);
    assignments = assignments.filter(x => x.courseId !== c.id);
    renderAll();
  });
}

function wireRemoveButtons(card) {
  card.querySelectorAll(".remove-row").forEach(btn => {
    btn.onclick = () => { btn.closest(".row-item").remove(); updateWeightTotal(card); };
  });
}
function wirePctInputs(card) {
  card.querySelectorAll(".w-pct").forEach(inp => { inp.oninput = () => updateWeightTotal(card); });
}
function flashSaved(btn) {
  const orig = btn.textContent;
  btn.textContent = "Saved ✓";
  setTimeout(() => btn.textContent = orig, 1200);
}

// ---------- Grades tab ----------
function renderGrades() {
  const el = document.getElementById("gradesList");
  if (!courses.length) {
    el.innerHTML = `<div class="empty-note">Add a course with weightage categories to see grade estimates.</div>`;
    return;
  }
  // Same worst-to-best ordering as the Courses tab, so the class dragging you down is always front and center.
  const ranked = [...courses].sort((a, b) => {
    const ga = computeCourseGrade(a), gb = computeCourseGrade(b);
    const va = ga && ga.overall != null ? ga.overall : Infinity;
    const vb = gb && gb.overall != null ? gb.overall : Infinity;
    return va - vb;
  });
  el.innerHTML = ranked.map(c => {
    const g = computeCourseGrade(c);
    if (!g) {
      return `<div class="card grade-card"><h2>${escapeHtml(c.code)}</h2><p class="muted">No grading weightage set yet. Add categories in the Courses tab.</p></div>`;
    }
    const rows = g.catBreakdown.map(cat => `<div class="grade-cat">
        <span>${escapeHtml(cat.name)}</span>
        <span class="pct">${cat.percent}%${cat.avg != null ? ` &middot; ${(cat.avg * 100).toFixed(1)}% avg` : " · no grades yet"}</span>
      </div>`).join("");

    const scoreable = assignments.filter(a => a.courseId === c.id && a.points != null)
      .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));

    return `<div class="card grade-card">
      <div class="grade-card-head"><h2>${escapeHtml(c.code)}</h2>${gradeBadgeHtml(c)}</div>
      ${rows}
      <div class="grade-summary">
        <span class="big">${g.overall != null ? g.overall.toFixed(1) + "%" : "—"}</span>
        <span class="muted">${g.overall != null ? `estimated grade (based on ${g.totalGradedWeight}% of weight graded so far)` : "enter scores on assignments to see an estimate"}</span>
      </div>
      <div class="subsection">
        <button class="btn small toggle-scores" data-course="${c.id}">Enter Scores ${scoreable.length ? `(${scoreable.length})` : ""}</button>
        <div class="row-list score-entry-list" data-course="${c.id}" style="display:none;">
          ${scoreable.length ? scoreable.map(a => gradeEntryRowHtml(a)).join("") : `<div class="empty-note">No assignments with points set yet - add points in the Courses tab first.</div>`}
        </div>
      </div>
    </div>`;
  }).join("");

  document.querySelectorAll(".toggle-scores").forEach(btn => {
    btn.addEventListener("click", () => {
      const list = document.querySelector(`.score-entry-list[data-course="${btn.dataset.course}"]`);
      const open = list.style.display !== "none";
      list.style.display = open ? "none" : "";
      btn.textContent = btn.textContent.replace(open ? "Hide Scores" : "Enter Scores", open ? "Enter Scores" : "Hide Scores");
    });
  });
  document.querySelectorAll(".save-grade-score").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const input = document.querySelector(`.grade-score-input[data-id="${id}"]`);
      const val = input.value === "" ? null : parseFloat(input.value);
      if (input.value !== "" && isNaN(val)) { input.focus(); return; }
      const a = assignments.find(x => x.id === id);
      a.score = val;
      await api.put(`/api/assignments/${id}`, a);
      renderAll();
    });
  });
}

function gradeEntryRowHtml(a) {
  const c = courseById(a.courseId);
  const pct = a.score != null ? ` (${((a.score / a.points) * 100).toFixed(0)}%)` : "";
  return `<div class="row-item">
    <div class="dot" style="background:${c ? c.color : "#999"}; flex-shrink:0;"></div>
    <span style="flex:2; min-width:0;">${escapeHtml(a.title)}</span>
    <span class="muted" style="flex:1; font-size:12px;">${a.dueDate ? fmtDateNice(a.dueDate.slice(0, 10)) : ""}</span>
    <input type="number" class="grade-score-input" data-id="${a.id}" value="${a.score ?? ""}" placeholder="score" style="max-width:70px;">
    <span class="muted" style="font-size:12px;">/ ${a.points}${pct}</span>
    <button class="btn small primary save-grade-score" data-id="${a.id}">Save</button>
  </div>`;
}

// ---------- Settings ----------
async function loadConfig() {
  const cfg = await api.get("/api/config");
  document.getElementById("canvasUrl").value = cfg.canvas_base_url || "";
  document.getElementById("canvasToken").placeholder = cfg.canvas_token_set ? "Token saved (hidden)" : "Paste token here";
  document.getElementById("canvasIcsUrl").placeholder = cfg.canvas_ics_url_set ? "Feed URL saved (hidden)" : "https://yourschool.instructure.com/feeds/calendars/user_xxxxxxxx.ics";
}

function summarizeCanvasResult(res) {
  const parts = [`Matched: ${res.matchedCourses.join(", ") || "none"}`];
  if (res.unmatchedCourses.length) parts.push(`couldn't match: ${res.unmatchedCourses.join(", ")}`);
  if (res.autoFilled) parts.push(`filled in ${res.autoFilled} blank value(s)`);
  parts.push(res.pendingReview ? `${res.pendingReview} item(s) need your review below` : "nothing needs review");
  return parts.join(" · ");
}

document.getElementById("icsSyncBtn").addEventListener("click", async () => {
  const status = document.getElementById("icsSyncStatus");
  const urlInput = document.getElementById("canvasIcsUrl");
  status.textContent = "Saving settings...";
  if (urlInput.value.trim()) {
    await api.post("/api/config", { canvas_ics_url: urlInput.value.trim() });
  }
  status.textContent = "Fetching your calendar feed...";
  const res = await api.post("/api/canvas/ics-sync", {});
  if (res.error) {
    status.textContent = "Error: " + res.error;
    return;
  }
  status.textContent = summarizeCanvasResult(res);
  await loadAll();
});

document.getElementById("syncBtn").addEventListener("click", async () => {
  const status = document.getElementById("syncStatus");
  status.textContent = "Saving settings...";
  await api.post("/api/config", {
    canvas_base_url: document.getElementById("canvasUrl").value.trim(),
    canvas_token: document.getElementById("canvasToken").value.trim(),
  });
  status.textContent = "Checking Canvas...";
  const res = await api.post("/api/canvas/sync", {});
  if (res.error) {
    status.textContent = "Error: " + res.error;
    return;
  }
  status.textContent = summarizeCanvasResult(res);
  await loadAll();
});

// ---------- Backup ----------
document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ courses, assignments }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `class-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
document.getElementById("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    if (!confirm("This will replace your current courses and assignments with the backup. Continue?")) return;
    for (const c of courses) await api.del(`/api/courses/${c.id}`);
    for (const c of (data.courses || [])) await api.post("/api/courses", c);
    for (const a of (data.assignments || [])) await api.post("/api/assignments", a);
    await loadAll();
    alert("Backup restored.");
  } catch (err) {
    alert("Invalid backup file.");
  }
});

// ---------- Sticky notes ----------
function renderNotes() {
  const grid = document.getElementById("notesGrid");
  grid.innerHTML = notes.map(n => `
    <div class="note-card" style="--note-accent:${n.color}" data-id="${n.id}">
      <button class="note-remove" data-remove-note="${n.id}">✕</button>
      <textarea data-note-text="${n.id}" placeholder="Write a reminder...">${escapeHtml(n.text || "")}</textarea>
    </div>
  `).join("") + `<button class="note-add-card" id="addNoteBtn">+</button>`;

  document.getElementById("addNoteBtn").addEventListener("click", async () => {
    const color = NOTE_COLORS[notes.length % NOTE_COLORS.length];
    const saved = await api.post("/api/notes", { text: "", color });
    notes.push(saved);
    renderNotes();
  });

  grid.querySelectorAll("[data-remove-note]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.removeNote;
      await api.del(`/api/notes/${id}`);
      notes = notes.filter(n => n.id !== id);
      renderNotes();
    });
  });

  grid.querySelectorAll("[data-note-text]").forEach(ta => {
    ta.addEventListener("blur", async () => {
      const id = ta.dataset.noteText;
      const n = notes.find(x => x.id === id);
      if (!n || n.text === ta.value) return;
      n.text = ta.value;
      await saveNote(n);
    });
  });
}
async function saveNote(n) {
  // Notes have no PUT endpoint (kept the API small) — delete and re-add with the same id/color.
  await api.del(`/api/notes/${n.id}`);
  const saved = await fetch("/api/notes", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: n.id, text: n.text, color: n.color })
  }).then(r => r.json());
  const idx = notes.findIndex(x => x.id === n.id);
  if (idx >= 0) notes[idx] = saved;
}

// ---------- Undo ----------
// Site-wide: the server snapshots full state before every mutating request, so Undo just
// restores the most recent one - works uniformly for any kind of edit, anywhere in the app.
async function refreshUndoStatus() {
  const btn = document.getElementById("undoBtn");
  try {
    const { description } = await api.get("/api/undo/peek");
    if (description) {
      btn.disabled = false;
      btn.title = `Undo: ${description}`;
    } else {
      btn.disabled = true;
      btn.title = "Nothing to undo yet";
    }
  } catch (e) {
    // leave button as-is if the check itself fails
  }
}
document.getElementById("undoBtn").addEventListener("click", async () => {
  const btn = document.getElementById("undoBtn");
  btn.disabled = true;
  const res = await api.post("/api/undo", {});
  if (res.error) {
    btn.textContent = "Nothing to undo";
    setTimeout(() => { btn.textContent = "↶ Undo"; refreshUndoStatus(); }, 1400);
    return;
  }
  btn.textContent = "Undone ✓";
  await loadAll();
  setTimeout(() => { btn.textContent = "↶ Undo"; }, 1400);
});

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- Init ----------
loadAll();
loadConfig();

// Picks up conflicts pushed by the browser-sync userscript from another tab, without a manual refresh.
setInterval(async () => {
  const latest = await api.get("/api/conflicts");
  if (latest.length !== conflicts.length) {
    conflicts = latest;
    renderConflicts();
  }
}, 20000);
