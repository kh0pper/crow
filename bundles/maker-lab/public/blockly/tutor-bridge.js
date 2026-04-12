/**
 * Maker Lab — tutor-bridge.js
 *
 * Client-side glue between the Blockly kiosk and the maker-lab HTTP API.
 *
 * Responsibilities:
 *   - Fetch session context + current lesson
 *   - Mount a Blockly workspace (minimal toolbox; curriculum-driven in follow-up)
 *   - Wire the "?" hint button → POST /kiosk/api/hint, render filtered text
 *   - Wire "I'm done!" → POST /kiosk/api/progress
 *   - Detect offline + queue progress POSTs in IndexedDB, replay on reconnect
 *   - Client-side idle activity hook (counts block-change events only)
 *
 * Phase 2 notes:
 *   - The client-side salt for the device fingerprint is stored in localStorage
 *     and echoed via x-maker-kiosk-salt on every request.
 *   - Real companion WS integration (tutor-event message) is stubbed until the
 *     companion backend patches land (bundles/companion/patches/backend/0001).
 *     For now the hint audio plays via the kiosk's own TTS (speechSynthesis).
 */

const SALT_KEY = "maker-kiosk-salt";
const QUEUE_DB = "maker-lab-queue";
const QUEUE_STORE = "progress";

function ensureSalt() {
  let s = localStorage.getItem(SALT_KEY);
  if (!s) {
    s = crypto.randomUUID();
    localStorage.setItem(SALT_KEY, s);
  }
  return s;
}

function apiFetch(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set("x-maker-kiosk-salt", ensureSalt());
  if (opts.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(path, { ...opts, headers, credentials: "same-origin" });
}

// ─── IndexedDB offline queue ───────────────────────────────────────────────

function openQueueDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(QUEUE_STORE, { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queuePush(payload) {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).add({ payload, at: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function queueDrain(postFn) {
  const db = await openQueueDb();
  const tx = db.transaction(QUEUE_STORE, "readwrite");
  const store = tx.objectStore(QUEUE_STORE);
  const all = await new Promise((r) => { store.getAll().onsuccess = (e) => r(e.target.result); });
  for (const row of all) {
    try {
      const res = await postFn(row.payload);
      if (res.ok) {
        store.delete(row.id);
      } else {
        break; // leave rest for next drain
      }
    } catch {
      break;
    }
  }
}

// ─── Hint UI ───────────────────────────────────────────────────────────────

const hintBtn = document.getElementById("hintBtn");
const doneBtn = document.getElementById("doneBtn");
const hintBubble = document.getElementById("hintBubble");
const hintText = document.getElementById("hintText");
const hintClose = document.getElementById("hintClose");
const titleEl = document.getElementById("lessonTitle");
const transcriptChip = document.getElementById("transcriptChip");
const offlineChip = document.getElementById("offlineChip");

let hintLevel = 1;
let currentLesson = null;
let currentSurface = "blockly";
let currentWorkspace = null;

hintClose?.addEventListener("click", () => {
  hintBubble.hidden = true;
});

function speak(text) {
  try {
    if ("speechSynthesis" in window && text) {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    }
  } catch { /* TTS is best-effort */ }
}

async function requestHint() {
  hintText.textContent = "Thinking…";
  hintBubble.hidden = false;
  try {
    const res = await apiFetch("/kiosk/api/hint", {
      method: "POST",
      body: JSON.stringify({
        surface: currentSurface,
        question: "I need a hint.",
        level: hintLevel,
        lesson_id: currentLesson?.id || null,
        canned_hints: currentLesson?.canned_hints || null,
      }),
    });
    if (!res.ok) {
      hintText.textContent = "Your tutor is taking a nap. Try the lesson hints on your own for a minute!";
      return;
    }
    const data = await res.json();
    hintText.textContent = data.text;
    speak(data.text);
    hintLevel = Math.min(3, hintLevel + 1); // escalate next time
  } catch {
    hintText.textContent = "Your tutor is taking a nap. Try the lesson hints on your own for a minute!";
  }
}

hintBtn?.addEventListener("click", requestHint);

// ─── Progress ──────────────────────────────────────────────────────────────

async function postProgress(payload) {
  return apiFetch("/kiosk/api/progress", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

doneBtn?.addEventListener("click", async () => {
  // success_check gate: missing required blocks → nudge, don't mark complete.
  const required = currentLesson?.success_check?.required_blocks;
  if (Array.isArray(required) && required.length && currentWorkspace) {
    const present = workspaceBlockTypes(currentWorkspace);
    const missing = required.filter((t) => !present.has(t));
    if (missing.length) {
      const msg = currentLesson.success_check.message_missing
        || `Almost! Your workspace is missing: ${missing.join(", ")}.`;
      hintText.textContent = msg;
      hintBubble.hidden = false;
      speak(msg);
      return;
    }
  }
  const payload = {
    surface: currentSurface,
    activity: currentLesson?.id || "unknown",
    outcome: "completed",
    note: null,
  };
  try {
    const res = await postProgress(payload);
    if (!res.ok) throw new Error("http_" + res.status);
    hintText.textContent = "Great job! 🎉";
    hintBubble.hidden = false;
    hintLevel = 1;
    speak("Great job!");
  } catch {
    await queuePush(payload);
    offlineChip.hidden = false;
  }
});

// ─── Connectivity ──────────────────────────────────────────────────────────

window.addEventListener("online", async () => {
  offlineChip.hidden = true;
  await queueDrain(postProgress);
});
window.addEventListener("offline", () => {
  offlineChip.hidden = false;
});

// ─── Idle lock screen ──────────────────────────────────────────────────────

let lockEl = null;
let lockCountdownEl = null;
let resumeTimer = null;

function buildLockScreen() {
  const root = document.createElement("div");
  root.className = "lock-screen";
  const box = document.createElement("div");
  box.className = "lock-box";
  const title = document.createElement("div");
  title.className = "lock-title";
  title.textContent = "Ask a grown-up to unlock";
  const hint = document.createElement("div");
  hint.className = "lock-hint";
  hint.textContent = "We noticed you took a break.";
  const countdown = document.createElement("div");
  countdown.className = "lock-countdown";
  box.appendChild(title);
  box.appendChild(hint);
  box.appendChild(countdown);
  root.appendChild(box);
  lockCountdownEl = countdown;
  return root;
}

function showLockScreen(etaSeconds) {
  if (!lockEl) {
    lockEl = buildLockScreen();
    document.body.appendChild(lockEl);
  }
  lockEl.hidden = false;
  if (resumeTimer) clearInterval(resumeTimer);
  let remaining = Math.max(0, Math.floor(Number(etaSeconds) || 0));
  const render = () => {
    if (!lockCountdownEl) return;
    if (remaining <= 0) {
      lockCountdownEl.textContent = "Waking up…";
    } else {
      const m = Math.floor(remaining / 60), s = remaining % 60;
      lockCountdownEl.textContent = `Auto-resume in ${m}:${String(s).padStart(2, "0")}`;
    }
  };
  render();
  resumeTimer = setInterval(() => { remaining--; render(); }, 1000);
}

function hideLockScreen() {
  if (lockEl) lockEl.hidden = true;
  if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
}

// ─── Boot ──────────────────────────────────────────────────────────────────

async function loadContext() {
  try {
    const ctx = await (await apiFetch("/kiosk/api/context")).json();
    if (ctx.transcripts_on) {
      transcriptChip.textContent = "Your grown-up might read our chat";
    } else {
      transcriptChip.textContent = "This chat is private";
    }
    if (ctx.idle_locked) {
      showLockScreen(ctx.auto_resume_eta_seconds);
    } else {
      hideLockScreen();
    }
  } catch { /* non-fatal */ }
}

async function heartbeat() {
  try {
    await apiFetch("/kiosk/api/heartbeat", { method: "POST", body: "{}" });
  } catch { /* best-effort */ }
}

let lastHeartbeatAt = 0;
function throttledHeartbeat() {
  const now = Date.now();
  if (now - lastHeartbeatAt < 5000) return;
  lastHeartbeatAt = now;
  heartbeat();
}

async function loadLesson(id) {
  try {
    const r = await apiFetch(`/kiosk/api/lesson/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    const { lesson } = await r.json();
    currentLesson = lesson;
    currentSurface = lesson.surface || "blockly";
    titleEl.textContent = lesson.title || id;
    return lesson;
  } catch {
    return null;
  }
}

// Default shadow values for common block types so they drop in ready to run
// (otherwise `controls_repeat_ext` has an empty TIMES slot that won't connect
// to plain number blocks).
const BLOCK_SHADOWS = {
  controls_repeat_ext: {
    TIMES: { type: "math_number", fields: { NUM: 4 } },
  },
  text_print: {
    TEXT: { type: "text", fields: { TEXT: "Hi!" } },
  },
  logic_compare: {
    A: { type: "math_number", fields: { NUM: 5 } },
    B: { type: "math_number", fields: { NUM: 3 } },
  },
};

function blockEntry(type) {
  const entry = { kind: "block", type };
  const shadows = BLOCK_SHADOWS[type];
  if (shadows) {
    entry.inputs = {};
    for (const [slot, shadow] of Object.entries(shadows)) {
      entry.inputs[slot] = { shadow };
    }
  }
  return entry;
}

// Build a Blockly JSON toolbox from lesson.toolbox (either shape) or a
// sensible default when no lesson is loaded.
function buildToolbox(lessonToolbox) {
  if (!lessonToolbox) {
    return {
      kind: "categoryToolbox",
      contents: [
        { kind: "category", name: "Do", colour: "#3b82f6", contents: [blockEntry("text_print")] },
      ],
    };
  }
  if (Array.isArray(lessonToolbox)) {
    return { kind: "flyoutToolbox", contents: lessonToolbox.map(blockEntry) };
  }
  if (lessonToolbox.categories) {
    return {
      kind: "categoryToolbox",
      contents: lessonToolbox.categories.map((c) => ({
        kind: "category",
        name: c.name,
        colour: c.colour || "#3b82f6",
        contents: (c.blocks || []).map(blockEntry),
      })),
    };
  }
  return buildToolbox(null);
}

function mountBlockly(lessonToolbox) {
  if (typeof Blockly === "undefined") {
    titleEl.textContent = "Blockly couldn't load. Ask a grown-up to check the network.";
    return null;
  }
  return Blockly.inject("blocklyArea", {
    toolbox: buildToolbox(lessonToolbox),
    trashcan: true,
    grid: { spacing: 20, length: 3, colour: "#ccc", snap: true },
    zoom: { controls: true, wheel: true, startScale: 1.1 },
  });
}

// Walk all blocks in the workspace and collect their type names. Used by the
// success_check gate on "Done" — missing required types block progression.
function workspaceBlockTypes(ws) {
  if (!ws || typeof ws.getAllBlocks !== "function") return new Set();
  return new Set(ws.getAllBlocks(false).map((b) => b.type));
}

async function init() {
  const urlLesson = new URLSearchParams(location.search).get("lesson") || "blockly-01-move-cat";
  await loadContext();
  await loadLesson(urlLesson);
  const ws = mountBlockly(currentLesson?.toolbox);
  currentWorkspace = ws;
  // Count workspace changes as activity (per plan's allowlist: hint request,
  // progress POST, Blockly workspace change, explicit heartbeat — NOT
  // mouse-move or scroll).
  ws?.addChangeListener((ev) => {
    // Filter out Blockly-internal UI events (clicks, viewport moves) that
    // aren't structural changes. Only the BLOCK_CHANGE / BLOCK_CREATE /
    // BLOCK_MOVE / BLOCK_DELETE family counts as activity.
    if (!ev || !ev.type) return;
    const actionable = ev.type === "create" || ev.type === "delete" ||
      ev.type === "change" || ev.type === "move";
    if (!actionable) return;
    throttledHeartbeat();
  });
  // Poll /api/context periodically so idle-lock state surfaces to the kiosk
  // even when the kid is just staring. 15s cadence keeps DB churn low while
  // giving a tight enough feedback loop for the countdown.
  setInterval(loadContext, 15_000);
  // Drain any queued progress from a previous offline spell.
  if (navigator.onLine) { queueDrain(postProgress).catch(() => {}); }
}

init();
