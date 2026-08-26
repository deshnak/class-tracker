#!/usr/bin/env python3
"""
Class Tracker - a tiny local dashboard for classes, syllabi, and Canvas sync.
Zero third-party dependencies: stdlib only. Run with `python3 server.py`.
"""
import datetime
import json
import os
import re
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
PUBLIC_DIR = os.path.join(ROOT, "public")
COURSES_FILE = os.path.join(DATA_DIR, "courses.json")
ASSIGNMENTS_FILE = os.path.join(DATA_DIR, "assignments.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
NOTES_FILE = os.path.join(DATA_DIR, "notes.json")
CONFLICTS_FILE = os.path.join(DATA_DIR, "conflicts.json")
DISMISSED_FILE = os.path.join(DATA_DIR, "canvas_dismissed.json")
UNDO_FILE = os.path.join(DATA_DIR, "undo_history.json")

PORT = int(os.environ.get("PORT", "8420"))
UNDO_MAX = 20
# Every mutating request snapshots the full state (all 5 data files) first, keyed with a
# human-readable description. Undo pops the most recent snapshot and restores every file
# from it. One mechanism covers every kind of edit (courses, assignments, notes, conflict
# resolution, Canvas syncs) instead of a separate inverse for each action.
UNDOABLE_FILES = {
    "courses": COURSES_FILE, "assignments": ASSIGNMENTS_FILE, "notes": NOTES_FILE,
    "conflicts": CONFLICTS_FILE, "dismissed": DISMISSED_FILE,
}


def read_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r") as f:
        content = f.read().strip()
        return json.loads(content) if content else default


def write_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def push_undo_snapshot(description):
    history = read_json(UNDO_FILE, [])
    snapshot = {"description": description}
    for key, path in UNDOABLE_FILES.items():
        snapshot[key] = read_json(path, [])
    history.append(snapshot)
    history = history[-UNDO_MAX:]
    write_json(UNDO_FILE, history)


def pop_undo_snapshot():
    history = read_json(UNDO_FILE, [])
    if not history:
        return None
    snapshot = history.pop()
    for key, path in UNDOABLE_FILES.items():
        if key in snapshot:
            write_json(path, snapshot[key])
    write_json(UNDO_FILE, history)
    return snapshot["description"]


def peek_undo_description():
    history = read_json(UNDO_FILE, [])
    return history[-1]["description"] if history else None


def infer_type(name, submission_types):
    n = (name or "").lower()
    if re.search(r"\b(exam|midterm|final)\b", n):
        return "exam"
    if "online_quiz" in (submission_types or []) or "quiz" in n:
        return "quiz"
    return "assignment"


def canvas_get(base_url, token, path, params=None):
    url = base_url.rstrip("/") + path
    if params:
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        url += ("&" if "?" in url else "?") + qs
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def normalize_course_key(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def match_canvas_course(local_code, canvas_courses):
    """Only matches against an existing local course. Never used to create new ones."""
    key = normalize_course_key(local_code)
    if not key:
        return None
    for cc in canvas_courses:
        candidate = normalize_course_key((cc.get("course_code") or "") + (cc.get("name") or ""))
        if key in candidate:
            return cc
    return None


def normalize_assignment_key(title):
    """Distinguishes assignments for cross-source matching.

    HW/Project/Quiz/Exam get a light abbreviation-bridging scheme (so 'Homework 3' matches
    'HW3'). The item number has to sit right next to the category word, not just be the first
    digit anywhere in the title, so a leading course/unit prefix number doesn't get mistaken
    for it.

    Everything else falls back to requiring the full cleaned title to match exactly. An earlier
    version grabbed the first digit anywhere in the title as a fuzzy key, which collapsed 'A1:
    Process Doc 1' and 'A1: Process Doc 2' into the same key and silently deleted one of them.
    Exact match trades a few missed auto-links for zero false merges, which is the right
    tradeoff here.
    """
    clean = re.sub(r"\(.*?\)", "", (title or "").lower())
    clean = re.sub(r"[^a-z0-9]+", " ", clean).strip()
    clean = re.sub(r"\s+", " ", clean)

    m = re.search(r"\b(?:homework|hw)\s*#?\s*(\d+[a-z]?)\b", clean)
    if m:
        return f"hw-{m.group(1)}"
    m = re.search(r"\bproject\s*#?\s*(\d+[a-z]?)\b", clean) or re.search(r"\bp(\d+[a-z]?)\b", clean)
    if m:
        return f"project-{m.group(1)}"
    m = re.search(r"\bquiz\s*#?\s*(\d+[a-z]?)\b", clean)
    if m:
        return f"quiz-{m.group(1)}"
    # 'midterm' and 'exam' are specific enough to trust alone, but bare 'final' is a common
    # English word ('final episode', 'final portfolio'). Only treat it as an exam marker when
    # it's paired with 'exam', so unrelated titles don't match by accident.
    m = re.search(r"\bmidterm\b\s*#?\s*(\d+[a-z]?)?", clean)
    if m:
        return f"exam-midterm{m.group(1) or ''}"
    if re.search(r"\bfinal\s+exam\b", clean):
        return "exam-final"
    m = re.search(r"\bexam\b\s*#?\s*(\d+[a-z]?)?", clean)
    if m:
        return f"exam-{m.group(1) or ''}"

    return f"free-{clean}"


def unescape_ics_text(v):
    """RFC 5545 TEXT values escape backslash/comma/semicolon/newline. Without this, titles
    end up with literal '\\,' in them."""
    if not v:
        return v
    out, i = [], 0
    while i < len(v):
        if v[i] == "\\" and i + 1 < len(v):
            nxt = v[i + 1]
            out.append("\n" if nxt in "nN" else nxt)
            i += 2
        else:
            out.append(v[i])
            i += 1
    return "".join(out)


def clean_canvas_title(raw):
    """Strips the '- Due Friday, 8/28/26, 11:59pm' boilerplate Canvas's calendar feed appends
    to event titles. Keeps titles readable, and makes sure the same assignment normalizes to
    the same key no matter which sync method (or which day) pulled it in."""
    t = (raw or "").strip()
    # Two passes. First strip everything from "Due <weekday>[,] <date>" onward (real Canvas
    # feeds put all sorts of things right before "Due": a dash, "Survey", nothing at all).
    # Then clean up whatever separator is left dangling at the new end.
    t = re.sub(r"\bDue\s+\w+,?\s+\d{1,2}/\d{1,2}/\d{2,4}.*$", "", t, flags=re.I)
    t = re.sub(r"\s*\(\s*due\s+midnight\s*\)\s*$", "", t, flags=re.I)
    t = re.sub(r"[\s\-:]+$", "", t)
    return t.strip()


def canvas_utc_to_local_iso(v):
    """Canvas's REST API due_at is ISO8601 UTC ('2026-08-29T03:59:00Z'). Convert to this
    machine's local time before formatting. Just stripping the 'Z' (the old behavior) silently
    rolled the calendar date forward by one for any 'due at midnight' assignment, since midnight
    Eastern is around 4-5am UTC the next day. That was the actual cause of the token/browser-sync
    path disagreeing with the calendar-feed path on the same assignment's due date."""
    if not v:
        return None
    try:
        if v.endswith("Z"):
            dt_utc = datetime.datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
            return dt_utc.astimezone().strftime("%Y-%m-%dT%H:%M:%S")
        return v
    except ValueError:
        return v


def assignment_groups_to_items(groups):
    """Converts Canvas's native assignment_groups API shape into the normalized
    {id, name, due_at, points} items the reconciliation engine expects."""
    items = []
    for g in groups:
        for ca in (g.get("assignments") or []):
            items.append({
                "id": f"a-{ca['id']}",
                "name": clean_canvas_title(ca.get("name", "Untitled")),
                "due_at": canvas_utc_to_local_iso(ca.get("due_at")),
                "points": ca.get("points_possible"),
                "group": g.get("name", ""),
                "assignmentType": infer_type(ca.get("name"), ca.get("submission_types")),
                "url": ca.get("html_url"),
            })
    return items


def reconcile_course_assignments(course, assignments, conflicts, dismissed, canvas_items):
    """The one place that decides auto-fill vs. conflict vs. new-item, for any Canvas data
    source (token API, calendar feed, or a browser-session push). They all funnel through here,
    so the three sync paths can never disagree on what counts as a conflict."""

    def is_dismissed(canvas_id, field, canvas_value):
        return any(d.get("courseId") == course["id"] and d.get("canvasAssignmentId") == canvas_id
                   and d.get("field") == field and d.get("canvasValue") == canvas_value for d in dismissed)

    def has_pending(canvas_id, field):
        return any(c.get("courseId") == course["id"] and c.get("canvasAssignmentId") == canvas_id
                   and c.get("field") == field for c in conflicts)

    local_by_canvas_id = {}
    local_by_key = {}
    for a in assignments:
        if a["courseId"] != course["id"]:
            continue
        if a.get("canvasAssignmentId"):
            local_by_canvas_id[a["canvasAssignmentId"]] = a
        local_by_key.setdefault(normalize_assignment_key(a["title"]), []).append(a)

    auto_filled = 0
    new_conflicts = 0

    for ca in canvas_items:
        due, points, cid = ca.get("due_at"), ca.get("points"), ca["id"]
        if due is None and points is None:
            continue

        local = local_by_canvas_id.get(cid)
        if not local:
            key = normalize_assignment_key(ca.get("name", ""))
            candidates = local_by_key.get(key, [])
            if len(candidates) == 1:
                local = candidates[0]
                local["canvasAssignmentId"] = cid

        if local:
            if due:
                local_date = (local.get("dueDate") or "")[:10]
                canvas_date = due[:10]
                if not local_date:
                    local["dueDate"] = due
                    auto_filled += 1
                elif local_date != canvas_date and not is_dismissed(cid, "dueDate", due) and not has_pending(cid, "dueDate"):
                    conflicts.append({
                        "id": f"cf-{os.urandom(4).hex()}", "type": "conflict", "field": "dueDate",
                        "courseId": course["id"], "assignmentId": local["id"], "canvasAssignmentId": cid,
                        "title": local["title"], "canvasTitle": ca.get("name"),
                        "localValue": local.get("dueDate"), "canvasValue": due,
                    })
                    new_conflicts += 1
            if points is not None:
                if local.get("points") is None:
                    local["points"] = points
                    auto_filled += 1
                elif local.get("points") != points and not is_dismissed(cid, "points", points) and not has_pending(cid, "points"):
                    conflicts.append({
                        "id": f"cf-{os.urandom(4).hex()}", "type": "conflict", "field": "points",
                        "courseId": course["id"], "assignmentId": local["id"], "canvasAssignmentId": cid,
                        "title": local["title"], "canvasTitle": ca.get("name"),
                        "localValue": local.get("points"), "canvasValue": points,
                    })
                    new_conflicts += 1
        else:
            already_flagged = any(c.get("type") == "new" and c.get("courseId") == course["id"]
                                   and c.get("canvasAssignmentId") == cid for c in conflicts)
            if not is_dismissed(cid, "new", due) and not already_flagged:
                conflicts.append({
                    "id": f"cf-{os.urandom(4).hex()}", "type": "new",
                    "courseId": course["id"], "canvasAssignmentId": cid,
                    "title": ca.get("name", "Untitled"), "canvasValue": due, "points": points,
                    "group": ca.get("group", ""), "assignmentType": ca.get("assignmentType", "assignment"),
                    "url": ca.get("url"),
                })
                new_conflicts += 1

    return auto_filled, new_conflicts


def do_canvas_crosscheck():
    """Path A: Canvas Personal Access Token. Some schools disable self-service tokens for
    students; see do_canvas_ics_crosscheck / do_canvas_push_crosscheck for the workarounds."""
    config = read_json(CONFIG_FILE, {})
    base_url = config.get("canvas_base_url", "").strip()
    token = config.get("canvas_token", "").strip()
    if not base_url or not token:
        raise ValueError("Set your Canvas base URL and access token in Settings first.")

    courses = read_json(COURSES_FILE, [])
    assignments = read_json(ASSIGNMENTS_FILE, [])
    conflicts = read_json(CONFLICTS_FILE, [])
    dismissed = read_json(DISMISSED_FILE, [])

    canvas_courses = canvas_get(base_url, token, "/api/v1/courses", {"enrollment_state[]": "active", "per_page": "100"})

    matched, unmatched, auto_filled, new_conflicts = [], [], 0, 0
    for course in courses:
        cc = None
        if course.get("canvasCourseId"):
            cc = next((x for x in canvas_courses if x["id"] == course["canvasCourseId"]), None)
        if not cc:
            cc = match_canvas_course(course["code"], canvas_courses)
        if not cc:
            unmatched.append(course["code"])
            continue
        course["canvasCourseId"] = cc["id"]
        matched.append(course["code"])

        try:
            groups = canvas_get(base_url, token, f"/api/v1/courses/{cc['id']}/assignment_groups",
                                 {"include[]": "assignments", "per_page": "100"})
        except urllib.error.HTTPError:
            continue

        af, nc = reconcile_course_assignments(course, assignments, conflicts, dismissed, assignment_groups_to_items(groups))
        auto_filled += af
        new_conflicts += nc

    write_json(COURSES_FILE, courses)
    write_json(ASSIGNMENTS_FILE, assignments)
    write_json(CONFLICTS_FILE, conflicts)
    return {"matchedCourses": matched, "unmatchedCourses": unmatched,
            "autoFilled": auto_filled, "newConflicts": new_conflicts, "pendingReview": len(conflicts)}


def parse_ics(text):
    """Minimal RFC 5545 VEVENT parser: unfolds continuation lines, then grabs key:value pairs."""
    lines = text.replace("\r\n", "\n").split("\n")
    unfolded = []
    for line in lines:
        if line.startswith((" ", "\t")) and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)

    events, current = [], None
    for line in unfolded:
        stripped = line.strip()
        if stripped == "BEGIN:VEVENT":
            current = {}
        elif stripped == "END:VEVENT":
            if current is not None:
                events.append(current)
            current = None
        elif current is not None and ":" in line:
            key, _, value = line.partition(":")
            current[key.split(";")[0]] = unescape_ics_text(value)
    return events


def ics_dt_to_local_iso(v):
    """Canvas's calendar feed emits UTC timestamps (trailing Z). Convert to this machine's
    local time before formatting, so the stored date lines up with how the app displays dates."""
    if not v:
        return None
    v = v.strip()
    try:
        if v.endswith("Z") and "T" in v:
            dt_utc = datetime.datetime.strptime(v, "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
            return dt_utc.astimezone().strftime("%Y-%m-%dT%H:%M:%S")
        if "T" in v:
            return datetime.datetime.strptime(v, "%Y%m%dT%H%M%S").strftime("%Y-%m-%dT%H:%M:%S")
        return f"{v[0:4]}-{v[4:6]}-{v[6:8]}"
    except ValueError:
        return None


def do_canvas_ics_crosscheck():
    """Path B: Canvas Calendar Feed (.ics). Gets due dates only (no points/weights), but the
    feed URL isn't gated behind the 'Approved Integrations' token restriction."""
    config = read_json(CONFIG_FILE, {})
    ics_url = config.get("canvas_ics_url", "").strip()
    if not ics_url:
        raise ValueError("Paste your Canvas Calendar Feed URL in Settings first.")

    courses = read_json(COURSES_FILE, [])
    assignments = read_json(ASSIGNMENTS_FILE, [])
    conflicts = read_json(CONFLICTS_FILE, [])
    dismissed = read_json(DISMISSED_FILE, [])

    req = urllib.request.Request(ics_url, headers={"User-Agent": "class-tracker/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    events = parse_ics(text)

    items_by_course = {}
    unmatched_events = 0
    skipped_calendar_events = 0
    for ev in events:
        url = ev.get("URL", "")
        idm = re.search(r"/(assignments|quizzes|calendar_events)/(\d+)", url)
        # Generic 'calendar_events' aren't gradable assignments (e.g. a course-wide reminder
        # block). Including them was pulling in junk like "Systems and Networks - CS-2200-A".
        if idm and idm.group(1) == "calendar_events":
            skipped_calendar_events += 1
            continue

        summary = ev.get("SUMMARY", "")
        m = re.search(r"\[([^\]]+)\]\s*$", summary)
        bracket = m.group(1) if m else ""
        title = re.sub(r"\[([^\]]+)\]\s*$", "", summary).strip()
        title = re.sub(r"^(assignment|quiz):\s*", "", title, flags=re.I)
        title = clean_canvas_title(title)
        if not title:
            continue

        course = None
        if bracket:
            bracket_key = normalize_course_key(bracket)
            course = next((c for c in courses if normalize_course_key(c["code"]) and normalize_course_key(c["code"]) in bracket_key), None)
        if not course:
            unmatched_events += 1
            continue

        cid = f"{idm.group(1)}-{idm.group(2)}" if idm else ev.get("UID", summary)

        items_by_course.setdefault(course["id"], []).append({
            "id": cid, "name": title, "due_at": ics_dt_to_local_iso(ev.get("DTSTART")), "points": None,
        })

    matched, auto_filled, new_conflicts = [], 0, 0
    for course in courses:
        items = items_by_course.get(course["id"], [])
        if not items:
            continue
        matched.append(course["code"])
        af, nc = reconcile_course_assignments(course, assignments, conflicts, dismissed, items)
        auto_filled += af
        new_conflicts += nc

    write_json(ASSIGNMENTS_FILE, assignments)
    write_json(CONFLICTS_FILE, conflicts)
    unmatched = [c["code"] for c in courses if c["code"] not in matched]
    return {"matchedCourses": matched, "unmatchedCourses": unmatched, "eventCount": len(events),
            "unmatchedEvents": unmatched_events, "skippedCalendarEvents": skipped_calendar_events,
            "autoFilled": auto_filled, "newConflicts": new_conflicts, "pendingReview": len(conflicts)}


def do_canvas_push_crosscheck(payload):
    """Path C: data pushed from a Tampermonkey userscript running in an already-logged-in
    Canvas tab (session-cookie authenticated, so it works even with tokens disabled). Payload
    shape mirrors the Canvas API: {courses: [...], assignmentGroups: {canvasCourseId: [...]}}."""
    canvas_courses = payload.get("courses") or []
    groups_by_id = payload.get("assignmentGroups") or {}
    if not canvas_courses:
        raise ValueError("No course data received from the browser sync.")

    courses = read_json(COURSES_FILE, [])
    assignments = read_json(ASSIGNMENTS_FILE, [])
    conflicts = read_json(CONFLICTS_FILE, [])
    dismissed = read_json(DISMISSED_FILE, [])

    matched, unmatched, auto_filled, new_conflicts = [], [], 0, 0
    for course in courses:
        cc = None
        if course.get("canvasCourseId"):
            cc = next((x for x in canvas_courses if x["id"] == course["canvasCourseId"]), None)
        if not cc:
            cc = match_canvas_course(course["code"], canvas_courses)
        if not cc:
            unmatched.append(course["code"])
            continue
        course["canvasCourseId"] = cc["id"]
        matched.append(course["code"])

        groups = groups_by_id.get(str(cc["id"])) or groups_by_id.get(cc["id"]) or []
        af, nc = reconcile_course_assignments(course, assignments, conflicts, dismissed, assignment_groups_to_items(groups))
        auto_filled += af
        new_conflicts += nc

    write_json(COURSES_FILE, courses)
    write_json(ASSIGNMENTS_FILE, assignments)
    write_json(CONFLICTS_FILE, conflicts)
    return {"matchedCourses": matched, "unmatchedCourses": unmatched,
            "autoFilled": auto_filled, "newConflicts": new_conflicts, "pendingReview": len(conflicts)}


def resolve_conflict(conflict_id, resolution):
    conflicts = read_json(CONFLICTS_FILE, [])
    dismissed = read_json(DISMISSED_FILE, [])
    idx = next((i for i, c in enumerate(conflicts) if c["id"] == conflict_id), None)
    if idx is None:
        raise ValueError("conflict not found")
    conflict = conflicts[idx]

    if conflict["type"] == "conflict":
        if resolution == "canvas":
            assignments = read_json(ASSIGNMENTS_FILE, [])
            for a in assignments:
                if a["id"] == conflict["assignmentId"]:
                    a[conflict["field"]] = conflict["canvasValue"]
                    break
            write_json(ASSIGNMENTS_FILE, assignments)
        elif resolution == "mine":
            dismissed.append({
                "courseId": conflict["courseId"], "canvasAssignmentId": conflict["canvasAssignmentId"],
                "field": conflict["field"], "canvasValue": conflict["canvasValue"],
            })
        else:
            raise ValueError("resolution must be 'mine' or 'canvas' for a conflict")
    elif conflict["type"] == "new":
        if resolution == "add":
            assignments = read_json(ASSIGNMENTS_FILE, [])
            assignments.append({
                "id": f"a-canvas-{os.urandom(4).hex()}", "courseId": conflict["courseId"],
                "title": conflict["title"], "dueDate": conflict.get("canvasValue"),
                "points": conflict.get("points"), "score": None, "group": conflict.get("group", ""),
                "type": conflict.get("assignmentType", "assignment"), "completed": False,
                "source": "canvas", "canvasAssignmentId": conflict["canvasAssignmentId"],
                "url": conflict.get("url"),
            })
            write_json(ASSIGNMENTS_FILE, assignments)
        elif resolution == "ignore":
            dismissed.append({
                "courseId": conflict["courseId"], "canvasAssignmentId": conflict["canvasAssignmentId"],
                "field": "new", "canvasValue": conflict.get("canvasValue"),
            })
        else:
            raise ValueError("resolution must be 'add' or 'ignore' for a new item")

    conflicts.pop(idx)
    write_json(CONFLICTS_FILE, conflicts)
    write_json(DISMISSED_FILE, dismissed)
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, status, payload, content_type="application/json"):
        body = json.dumps(payload).encode("utf-8") if content_type == "application/json" else payload
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # Lets the Tampermonkey browser-sync userscript (running on your Canvas domain) POST
        # here directly, in case it isn't using GM_xmlhttpRequest.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        fs_path = os.path.normpath(os.path.join(PUBLIC_DIR, path.lstrip("/")))
        if not fs_path.startswith(PUBLIC_DIR) or not os.path.isfile(fs_path):
            self._send(404, {"error": "not found"})
            return
        ext = os.path.splitext(fs_path)[1]
        ctype = {
            ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
            ".json": "application/json", ".svg": "image/svg+xml"
        }.get(ext, "application/octet-stream")
        with open(fs_path, "rb") as f:
            self._send(200, f.read(), content_type=ctype)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/courses":
            return self._send(200, read_json(COURSES_FILE, []))
        if path == "/api/assignments":
            return self._send(200, read_json(ASSIGNMENTS_FILE, []))
        if path == "/api/config":
            cfg = read_json(CONFIG_FILE, {})
            return self._send(200, {
                "canvas_base_url": cfg.get("canvas_base_url", ""),
                "canvas_token_set": bool(cfg.get("canvas_token")),
                "canvas_ics_url_set": bool(cfg.get("canvas_ics_url")),
            })
        if path == "/api/notes":
            return self._send(200, read_json(NOTES_FILE, []))
        if path == "/api/conflicts":
            return self._send(200, read_json(CONFLICTS_FILE, []))
        if path == "/api/undo/peek":
            return self._send(200, {"description": peek_undo_description()})
        return self._serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self._read_body()
        except Exception:
            return self._send(400, {"error": "invalid JSON body"})

        if path == "/api/courses":
            push_undo_snapshot(f"add course “{body.get('code', 'New Course')}”")
            courses = read_json(COURSES_FILE, [])
            body.setdefault("id", f"c-{len(courses)+1}-{os.urandom(3).hex()}")
            body.setdefault("meetings", [])
            body.setdefault("weightage", [])
            body.setdefault("examDates", [])
            courses.append(body)
            write_json(COURSES_FILE, courses)
            return self._send(200, body)

        if path == "/api/assignments":
            push_undo_snapshot(f"add assignment “{body.get('title', 'Untitled')}”")
            assignments = read_json(ASSIGNMENTS_FILE, [])
            body.setdefault("id", f"a-{len(assignments)+1}-{os.urandom(3).hex()}")
            body.setdefault("source", "manual")
            body.setdefault("completed", False)
            assignments.append(body)
            write_json(ASSIGNMENTS_FILE, assignments)
            return self._send(200, body)

        if path == "/api/notes":
            push_undo_snapshot("add sticky note")
            notes = read_json(NOTES_FILE, [])
            body.setdefault("id", f"n-{os.urandom(4).hex()}")
            body.setdefault("color", "#ffe27a")
            notes.append(body)
            write_json(NOTES_FILE, notes)
            return self._send(200, body)

        if path == "/api/config":
            cfg = read_json(CONFIG_FILE, {})
            if "canvas_base_url" in body:
                cfg["canvas_base_url"] = body["canvas_base_url"]
            if "canvas_token" in body and body["canvas_token"]:
                cfg["canvas_token"] = body["canvas_token"]
            if "canvas_ics_url" in body and body["canvas_ics_url"]:
                cfg["canvas_ics_url"] = body["canvas_ics_url"]
            write_json(CONFIG_FILE, cfg)
            return self._send(200, {"ok": True})

        if path == "/api/canvas/sync":
            push_undo_snapshot("Canvas token sync")
            try:
                result = do_canvas_crosscheck()
                return self._send(200, result)
            except urllib.error.HTTPError as e:
                return self._send(502, {"error": f"Canvas API error: {e.code} {e.reason}"})
            except Exception as e:
                return self._send(400, {"error": str(e)})

        if path == "/api/canvas/ics-sync":
            push_undo_snapshot("Canvas calendar feed sync")
            try:
                result = do_canvas_ics_crosscheck()
                return self._send(200, result)
            except urllib.error.HTTPError as e:
                return self._send(502, {"error": f"Couldn't fetch the calendar feed: {e.code} {e.reason}"})
            except Exception as e:
                return self._send(400, {"error": str(e)})

        if path == "/api/canvas/push-sync":
            push_undo_snapshot("Canvas browser sync")
            try:
                result = do_canvas_push_crosscheck(body)
                return self._send(200, result)
            except Exception as e:
                return self._send(400, {"error": str(e)})

        m = re.match(r"^/api/conflicts/(.+)/resolve$", path)
        if m:
            conflicts = read_json(CONFLICTS_FILE, [])
            conflict = next((c for c in conflicts if c["id"] == m.group(1)), None)
            desc = f"resolve Canvas Check item “{conflict['title']}”" if conflict else "resolve Canvas Check item"
            push_undo_snapshot(desc)
            try:
                result = resolve_conflict(m.group(1), body.get("resolution"))
                return self._send(200, result)
            except Exception as e:
                return self._send(400, {"error": str(e)})

        if path == "/api/undo":
            description = pop_undo_snapshot()
            if description is None:
                return self._send(400, {"error": "Nothing to undo."})
            return self._send(200, {"ok": True, "description": description})

        return self._send(404, {"error": "not found"})

    def do_PUT(self):
        path = urlparse(self.path).path
        try:
            body = self._read_body()
        except Exception:
            return self._send(400, {"error": "invalid JSON body"})

        m = re.match(r"^/api/courses/(.+)$", path)
        if m:
            courses = read_json(COURSES_FILE, [])
            for i, c in enumerate(courses):
                if c["id"] == m.group(1):
                    push_undo_snapshot(f"edit course “{c.get('code', c['id'])}”")
                    body["id"] = c["id"]
                    courses[i] = body
                    write_json(COURSES_FILE, courses)
                    return self._send(200, body)
            return self._send(404, {"error": "course not found"})

        m = re.match(r"^/api/assignments/(.+)$", path)
        if m:
            assignments = read_json(ASSIGNMENTS_FILE, [])
            for i, a in enumerate(assignments):
                if a["id"] == m.group(1):
                    push_undo_snapshot(f"edit “{a.get('title', a['id'])}”")
                    body["id"] = a["id"]
                    assignments[i] = body
                    write_json(ASSIGNMENTS_FILE, assignments)
                    return self._send(200, body)
            return self._send(404, {"error": "assignment not found"})

        return self._send(404, {"error": "not found"})

    def do_DELETE(self):
        path = urlparse(self.path).path

        m = re.match(r"^/api/courses/(.+)$", path)
        if m:
            courses = read_json(COURSES_FILE, [])
            existing = next((c for c in courses if c["id"] == m.group(1)), None)
            push_undo_snapshot(f"delete course “{existing.get('code', m.group(1))}”" if existing else "delete course")
            courses = [c for c in courses if c["id"] != m.group(1)]
            write_json(COURSES_FILE, courses)
            assignments = read_json(ASSIGNMENTS_FILE, [])
            assignments = [a for a in assignments if a["courseId"] != m.group(1)]
            write_json(ASSIGNMENTS_FILE, assignments)
            return self._send(200, {"ok": True})

        m = re.match(r"^/api/assignments/(.+)$", path)
        if m:
            assignments = read_json(ASSIGNMENTS_FILE, [])
            existing = next((a for a in assignments if a["id"] == m.group(1)), None)
            push_undo_snapshot(f"delete “{existing.get('title', m.group(1))}”" if existing else "delete assignment")
            assignments = [a for a in assignments if a["id"] != m.group(1)]
            write_json(ASSIGNMENTS_FILE, assignments)
            return self._send(200, {"ok": True})

        m = re.match(r"^/api/notes/(.+)$", path)
        if m:
            push_undo_snapshot("delete sticky note")
            notes = read_json(NOTES_FILE, [])
            notes = [n for n in notes if n["id"] != m.group(1)]
            write_json(NOTES_FILE, notes)
            return self._send(200, {"ok": True})

        return self._send(404, {"error": "not found"})


if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Class Tracker running at http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
