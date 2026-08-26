// ==UserScript==
// @name         Class Tracker - Canvas Browser Sync
// @namespace    class-tracker
// @version      1.0
// @description  Pushes your Canvas courses/assignments to your local Class Tracker app using your already-logged-in browser session - works even when Canvas has disabled self-service Personal Access Tokens.
// @match        https://*.instructure.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  "use strict";

  const LOCAL_APP = "http://127.0.0.1:8420";

  GM_addStyle(`
    #ct-sync-btn {
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      background: #ff3d8f; color: white; border: 2px solid #14120f; border-radius: 6px;
      padding: 10px 16px; font-family: monospace; font-weight: bold; font-size: 13px;
      cursor: pointer; box-shadow: 3px 3px 0 #14120f;
    }
    #ct-sync-btn:active { transform: translate(2px,2px); box-shadow: none; }
    #ct-sync-btn:disabled { opacity: 0.6; cursor: default; }
    #ct-sync-status {
      position: fixed; bottom: 65px; right: 20px; z-index: 999999; max-width: 320px;
      background: #fffdf6; color: #14120f; border: 2px solid #14120f; border-radius: 6px;
      padding: 10px 12px; font-family: monospace; font-size: 12px; display: none;
      white-space: pre-wrap; box-shadow: 3px 3px 0 #14120f;
    }
  `);

  const btn = document.createElement("button");
  btn.id = "ct-sync-btn";
  btn.textContent = "↻ Sync to Class Tracker";
  document.body.appendChild(btn);

  const status = document.createElement("div");
  status.id = "ct-sync-status";
  document.body.appendChild(status);

  function showStatus(text) {
    status.textContent = text;
    status.style.display = "block";
  }

  async function fetchJSON(path) {
    const res = await fetch(path, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  }

  function postToLocalApp(payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `${LOCAL_APP}/api/canvas/push-sync`,
        data: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(new Error("Class Tracker sent back something unexpected.")); }
        },
        onerror: () => reject(new Error("Could not reach Class Tracker - is it running? (python3 server.py)")),
      });
    });
  }

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    showStatus("Fetching your courses from Canvas...");
    try {
      const courses = await fetchJSON("/api/v1/courses?enrollment_state[]=active&per_page=100");
      const assignmentGroups = {};
      for (const c of courses) {
        try {
          assignmentGroups[c.id] = await fetchJSON(`/api/v1/courses/${c.id}/assignment_groups?include[]=assignments&per_page=100`);
        } catch (e) {
          assignmentGroups[c.id] = [];
        }
      }
      showStatus("Sending to Class Tracker...");
      const result = await postToLocalApp({ courses, assignmentGroups });
      if (result.error) {
        showStatus("Error: " + result.error);
      } else {
        const lines = [
          `Matched: ${result.matchedCourses.join(", ") || "none"}`,
          result.unmatchedCourses.length ? `Couldn't match: ${result.unmatchedCourses.join(", ")}` : null,
          result.autoFilled ? `Filled in ${result.autoFilled} blank value(s)` : null,
          result.pendingReview ? `${result.pendingReview} item(s) waiting for you in Class Tracker` : "Nothing needs review",
        ].filter(Boolean);
        showStatus(lines.join("\n"));
      }
    } catch (e) {
      showStatus("Failed: " + e.message);
    } finally {
      btn.disabled = false;
    }
  });
})();
