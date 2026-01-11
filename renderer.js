let apiReady = false;
let players = [];   // unified adapters (YT + local files)
let holders = [];   // only used for YT holders
let offsets = [];   // seconds per video (same order as sources)

// Track created blob URLs so we can revoke them when reloading
let activeObjectUrls = [];

let syncing = false;
let ignoreEventsUntil = 0;

let driftTimer = null;
let uiTimer = null;
let isSeeking = false;
let isZenSeeking = false;
let lastZenHoverV = null; // stores the exact range value we computed from mouse position

// End-handling
let endedFlags = []; // per video: true once it reaches end (until global time goes back before end)
const END_EPS = 0.12; // seconds of tolerance near end

// When clamping to end, we want a slightly larger epsilon to avoid "seekTo(duration)" weirdness.
const CLAMP_EPS = 0.35;

// Global timeline cursor
let globalCursorTime = 0;

// Behavior: clicking Load should hide settings (enter zen mode)
const ENTER_ZEN_ON_LOAD = true;

// After Load is clicked successfully, block native YouTube + HTML5 <video> keyboard shortcuts.
// (We will add app-level shortcuts later.)
let keybindsArmed = false;

// Mute selection mode state
let muteSelectMode = false;

// Draw mode state
let drawMode = false;
let drawColor = "#ff0000";
let isDrawing = false;
let drawCanvas = null;
let drawCtx = null;
let lastX = 0;
let lastY = 0;
let drawHistory = [];  // Stack of canvas states for undo
let redoHistory = [];  // Stack for redo

// Focus mode state
let focusMode = false;
let focusedPlayerIndex = null;

// Layout options: defines row structure for each video count and option
// Each entry is an array of { count, centered } where count = videos in that row
const LAYOUT_CONFIGS = {
  1: { A: [{ count: 1, centered: false }] },
  2: {
    A: [{ count: 2, centered: false }],
    B: [{ count: 1, centered: false }, { count: 1, centered: false }]
  },
  3: {
    A: [{ count: 3, centered: false }],
    B: [{ count: 1, centered: true }, { count: 2, centered: false }],
    C: [{ count: 2, centered: false }, { count: 1, centered: true }]
  },
  4: { A: [{ count: 2, centered: false }, { count: 2, centered: false }] },
  5: {
    A: [{ count: 3, centered: false }, { count: 2, centered: true }],
    B: [{ count: 2, centered: true }, { count: 3, centered: false }]
  },
  6: {
    A: [{ count: 3, centered: false }, { count: 3, centered: false }]
  }
};

let currentLayoutOption = 'A';
let currentFilledVideoCount = 0;
let cachedDriftBeforeTwitch = null;

function isTypingTarget(node) {
  if (!node) return false;
  const elNode = node.nodeType === 1 ? node : node.parentElement;
  if (!elNode) return false;

  if (elNode.isContentEditable) return true;

  // Check if it's a form element that requires typing
  const checkInput = (el) => {
    const tTag = (el.tagName || "").toUpperCase();
    if (tTag === "TEXTAREA" || tTag === "SELECT") return true;
    if (tTag === "INPUT") {
      const type = (el.type || "").toLowerCase();
      // Allow keybinds for these types
      if (["range", "checkbox", "radio", "button", "submit", "reset", "file", "color", "image"].includes(type)) {
        return false;
      }
      return true;
    }
    return false;
  };

  // Check the element itself
  if (checkInput(elNode)) return true;

  // Check ancestry
  const closest = elNode.closest?.("input, textarea, select, [contenteditable='true']");
  if (closest && checkInput(closest)) return true;

  return false;
}

function isNativePlayerKey(e) {
  // Don’t mess with OS / app shortcuts
  if (e.ctrlKey || e.altKey || e.metaKey) return false;

  const k = (e.key || "").toLowerCase();

  // Space / arrows / navigation keys
  if (
    k === " " ||
    k === "arrowleft" || k === "arrowright" || k === "arrowup" || k === "arrowdown" ||
    k === "home" || k === "end" || k === "pageup" || k === "pagedown"
  ) return true;

  // 0–9 (YouTube jump)
  if (/^[0-9]$/.test(k)) return true;

  // Common YouTube keys
  if (
    k === "j" || k === "k" || k === "l" ||
    k === "," || k === "." ||
    k === "m" || k === "f" ||
    k === "c" || k === "t" || k === "i"
  ) return true;

  // Some browsers report space via code
  if ((e.code || "").toLowerCase() === "space") return true;

  return false;
}

// Capture-phase so we beat focused elements (including <video>).
document.addEventListener("keydown", (e) => {
  if (!keybindsArmed) return;
  if (isTypingTarget(e.target)) return;

  if (isNativePlayerKey(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// Global typing detection to tell main process to STOP stealing keys found in inputs
document.addEventListener("focusin", (e) => {
  const isTy = isTypingTarget(e.target);
  ipcRenderer.send("app:setTyping", isTy);
}, true);

document.addEventListener("focusout", () => {
  // Wait a tick to see where focus went (if anywhere)
  setTimeout(() => {
    const isTy = isTypingTarget(document.activeElement);
    ipcRenderer.send("app:setTyping", isTy);
  }, 10);
});

// ----- Editable keybinds -----
const DEFAULT_BINDS = {
  rew30: "g",
  rew5: "h",
  playpause: "j",
  fwd5: "k",
  fwd30: "l",
  mute: "m",
  focus: "f",
  draw: "d"
};

let keybinds = loadKeybinds();
let editingAction = null;

function loadKeybinds() {
  try {
    const raw = localStorage.getItem("vod_keybinds");
    if (!raw) return { ...DEFAULT_BINDS };
    const obj = JSON.parse(raw);
    const merged = { ...DEFAULT_BINDS, ...(obj || {}) };

    // enforce uniqueness; if duplicates exist, revert duplicates back to default
    const used = new Set();
    for (const action of Object.keys(DEFAULT_BINDS)) {
      let k = String(merged[action] || "").toLowerCase();
      if (!k || used.has(k)) {
        k = DEFAULT_BINDS[action];
      }
      merged[action] = k;
      used.add(k);
    }
    return merged;
  } catch {
    return { ...DEFAULT_BINDS };
  }
}

function saveKeybinds() {
  localStorage.setItem("vod_keybinds", JSON.stringify(keybinds));
  // Send to main so YouTube-focused keys still work
  ipcRenderer.send("app:updateKeybinds", keybinds);
}

function renderKeybindsUi() {
  const set = (id, val) => {
    const n = el(id);
    if (n) n.textContent = String(val || "").toUpperCase();
  };
  set("kb_key_rew30", keybinds.rew30);
  set("kb_key_rew5", keybinds.rew5);
  set("kb_key_playpause", keybinds.playpause);
  set("kb_key_fwd5", keybinds.fwd5);
  set("kb_key_fwd30", keybinds.fwd30);
  set("kb_key_mute", keybinds.mute);
  set("kb_key_focus", keybinds.focus);
  set("kb_key_draw", keybinds.draw);
}

function setEditing(actionOrNull) {
  editingAction = actionOrNull;

  document.querySelectorAll(".kbRow").forEach(r => {
    r.classList.toggle("editing", r.getAttribute("data-action") === editingAction);
  });
}

// Electron helpers (nodeIntegration is enabled)
const { ipcRenderer, shell } = require("electron");

// Custom keybinds forwarded from main process (works even when YouTube iframe has focus)
ipcRenderer.on("app:customKeybind", (_evt, action) => {
  if (!keybindsArmed) return;

  // Don’t trigger shortcuts while typing in inputs
  if (isTypingTarget(document.activeElement)) return;

  switch (action) {
    case "rew30": skipAll(-30); break;
    case "rew5": skipAll(-5); break;
    case "playpause": togglePlayPauseAll(); break;
    case "fwd5": skipAll(5); break;
    case "fwd30": skipAll(30); break;
    case "mute": if (!drawMode) toggleMuteSelectMode(); break;
    case "focus": if (!drawMode) toggleFocusSelectMode(); break;
    case "draw": toggleDrawMode(); break;
  }
});

// Where the app checks for update info (host this on GitHub Pages)
const UPDATE_MANIFEST_URL = "https://kadengibbs.github.io/vod-review/latest.json";
let currentAppVersion = null;


const el = id => document.getElementById(id);

function on(id, event, handler) {
  const node = el(id);
  if (!node) return;
  node.addEventListener(event, handler);
}

let statusTimer = null;
function setStatus(msg, isError = false, timeoutMs = 0) {
  const s = el("status");
  if (!s) return;
  s.textContent = msg;
  s.classList.toggle("error", isError);

  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }

  if (timeoutMs > 0) {
    statusTimer = setTimeout(() => {
      s.textContent = "";
      s.classList.remove("error");
    }, timeoutMs);
  }
}

function nowMs() { return Date.now(); }
function inLockout() { return nowMs() < ignoreEventsUntil; }
function beginLockout(ms = 450) {
  syncing = true;
  ignoreEventsUntil = nowMs() + ms;
  setTimeout(() => (syncing = false), ms);
}
function safe(fn) { try { fn(); } catch { } }

function extractId(s) {
  s = (s || "").trim();
  if (!s) return null;
  if (/^[\w-]{8,20}$/.test(s) && !s.includes("http")) return s;
  try {
    const u = new URL(s);
    return u.searchParams.get("v") || u.pathname.split("/").pop();
  } catch {
    return null;
  }
}

// Extract Twitch VOD ID from URL or bare ID
// Accepts: "v123456789", "123456789", "https://www.twitch.tv/videos/123456789"
function extractTwitchId(s) {
  s = (s || "").trim();
  if (!s) return null;

  // Check if it's just a numeric ID or v-prefixed ID
  if (/^v?\d{8,12}$/.test(s)) {
    return s.replace(/^v/, "");
  }

  // Try to parse as URL
  try {
    const u = new URL(s);
    if (!u.hostname.includes("twitch.tv")) return null;

    // Match /videos/123456789
    const videoMatch = u.pathname.match(/\/videos\/(\d+)/);
    if (videoMatch) return videoMatch[1];

    return null;
  } catch {
    return null;
  }
}

// Always hh:mm:ss
function formatTime(t) {
  t = Math.floor(Math.max(0, t || 0));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function getOffset(i) {
  const v = offsets?.[i];
  return Number.isFinite(v) ? v : 0;
}

function getCurrentTimeSafe(i) {
  const p = players[i];
  if (!p) return 0;
  let t = 0;
  safe(() => { t = p.getCurrentTime(); });
  return Number.isFinite(t) ? t : 0;
}

function getDurationSafe(i) {
  const p = players[i];
  if (!p) return 0;
  let d = 0;
  safe(() => { d = p.getDuration(); });
  return Number.isFinite(d) ? d : 0;
}

/* ---------- End-aware participation ---------- */

function shouldParticipate(i, globalTarget) {
  // If there's no global target (ex: pause), allow everyone
  if (globalTarget == null) return true;

  // If video was marked ended, it should NOT participate if global target is still past its end.
  // It *may* rejoin if global target is before end.
  const d = getDurationSafe(i);
  if (!Number.isFinite(d) || d <= 0) return true;

  let endGlobal = (d + getOffset(i));
  if (players[i]?.__type === "twitch") {
    endGlobal -= 2.0; // Effective end for Twitch is 2s earlier
  }

  if (endedFlags[i]) {
    // If global target is before its end, we can rejoin
    if (globalTarget < endGlobal - END_EPS) return true;
    return false;
  }
  return true;
}

function clearEndedIfRejoining(i, globalT) {
  if (!endedFlags[i]) return;
  const d = getDurationSafe(i);
  if (!Number.isFinite(d) || d <= 0) return;

  let endGlobal = d + getOffset(i);
  if (players[i]?.__type === "twitch") {
    endGlobal -= 2.0;
  }

  if (globalT <= endGlobal - END_EPS) endedFlags[i] = false;
}

function computeLocalTarget(i, globalT) {
  const off = getOffset(i);
  const local = globalT - off;
  const d = getDurationSafe(i);

  if (!Number.isFinite(d) || d <= 0) {
    return { localT: Math.max(0, local), playable: true, clampedToEnd: false };
  }

  if (globalT >= (d + off) - END_EPS) {
    return { localT: Math.max(0, d - CLAMP_EPS), playable: false, clampedToEnd: true };
  }

  return { localT: Math.max(0, Math.min(local, d)), playable: true, clampedToEnd: false };
}

function applySeekClamped(i, globalT) {
  const p = players[i];
  if (!p) return;

  const { localT, playable } = computeLocalTarget(i, globalT);

  if (!playable) {
    endedFlags[i] = true;
    safe(() => p.seekTo(localT, true));
    safe(() => p.pauseVideo());
    return;
  }

  // Rejoin syncing
  clearEndedIfRejoining(i, globalT);
  safe(() => p.seekTo(localT, true));
}

/* ---------- Global time helpers (exclude ended) ---------- */

function getGlobalTimes(globalTarget = null) {
  const times = [];
  for (let i = 0; i < players.length; i++) {
    if (!shouldParticipate(i, globalTarget)) continue;

    // Skip Twitch players that aren't fully ready (unreliable time during init)
    const p = players[i];
    if (p && p.__type === "twitch" && !p.__ready) continue;

    const ct = getCurrentTimeSafe(i);
    times.push(ct + getOffset(i));
  }
  return times;
}

function getMedianGlobalTime() {
  // Use current cursor as the participation target so "ended" videos don't pull the median backward
  const times = getGlobalTimes(globalCursorTime);
  if (times.length) {
    const m = median(times);
    globalCursorTime = m;
    return m;
  }
  return globalCursorTime;
}

function refreshGlobalCursorFromActive(globalTarget = null) {
  const times = getGlobalTimes(globalTarget);
  if (times.length) globalCursorTime = median(times);
}

function getMaxGlobalEnd() {
  let maxEnd = 0;
  for (let i = 0; i < players.length; i++) {
    const d = getDurationSafe(i);
    const endG = d + getOffset(i);
    if (Number.isFinite(endG)) maxEnd = Math.max(maxEnd, endG);
  }
  return maxEnd;
}

/* ---------- Core actions ---------- */

function playAll(lockoutMs = 450) {
  const gCur = getMedianGlobalTime();
  broadcast(p => safe(() => p.playVideo()), lockoutMs, gCur);
}

function pauseAll(lockoutMs = 450) {
  broadcast(p => safe(() => p.pauseVideo()), lockoutMs, null);
}

function anyPlaying() {
  for (const p of players) {
    if (!p) continue;
    // Skip Twitch players that aren't fully ready (unreliable state during init)
    if (p.__type === "twitch" && !p.__ready) continue;
    try {
      const st = p.getPlayerState();
      // YT: 1 = playing, File: 1 = playing
      if (st === 1) return true;
    } catch { }
  }
  return false;
}

function togglePlayPauseAll() {
  if (anyPlaying()) pauseAll(450);
  else playAll(450);
  setTimeout(updatePlayPauseLabel, 120);
}

/* ---------- Mute selection mode ---------- */

function toggleMuteSelectMode() {
  muteSelectMode = !muteSelectMode;
  document.body.classList.toggle("muteSelectMode", muteSelectMode);

  // Exit focus select mode if entering mute mode
  if (muteSelectMode && focusMode) {
    focusMode = false;
    document.body.classList.remove("focusSelectMode");
  }

  // Update card click handlers
  const cards = document.querySelectorAll("#grid .card");
  cards.forEach((card, i) => {
    if (muteSelectMode) {
      card.dataset.muteClickable = "1";
    } else {
      delete card.dataset.muteClickable;
    }
  });

  // Disable/Enable volume sliders
  const sliders = document.querySelectorAll(".volSlider");
  sliders.forEach(s => {
    s.disabled = muteSelectMode;
  });
}

function toggleMuteForPlayer(playerIndex) {
  const p = players[playerIndex];
  if (!p) return;

  const card = document.querySelectorAll("#grid .card")[playerIndex];
  if (!card) return;

  const isMuted = card.classList.contains("muted");

  if (p.__type === "yt") {
    // YouTube player
    try {
      if (isMuted) {
        p.__yt.unMute();
      } else {
        p.__yt.mute();
      }
    } catch { }
  } else if (p.__type === "file") {
    try {
      p.__video.muted = !isMuted;
    } catch { }
  } else if (p.__type === "twitch") {
    // Twitch player
    try {
      p.__twitch.setMuted(!isMuted);
    } catch { }
  }

  card.classList.toggle("muted", !isMuted);

  // Sync slider
  const slider = card.querySelector(".volSlider");
  if (slider) {
    if (isMuted) {
      // We just became UNMUTED (was muted)
      let vol = 100;
      try { vol = p.getVolume(); } catch { }
      // If vol is 0 for some reason (maybe it was set to 0), default to 100?
      if (vol === 0) vol = 100;
      slider.value = vol;
    } else {
      // We just became MUTED (was unmuted)
      slider.value = 0;
    }
    // Update fill
    const val = (slider.value - slider.min) / (slider.max - slider.min) * 100;
    slider.style.background = `linear-gradient(to right, #eee ${val}%, #444 ${val}%)`;

    // Update Icon
    const icon = card.querySelector(".volIcon");
    if (icon) {
      const PATH_MUTE = 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z';
      const PATH_LOW = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z';
      const PATH_HIGH = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';

      let path = PATH_MUTE;
      const v = +slider.value;
      if (v > 50) path = PATH_HIGH;
      else if (v > 0) path = PATH_LOW;

      icon.innerHTML = `<path d="${path}"/>`;
    }
  }
}

// Global click handler for mute selection mode (capture phase to intercept before video handlers)
document.addEventListener("click", (e) => {
  if (!muteSelectMode) return;

  const card = e.target.closest("#grid .card");
  if (!card) return;

  // Prevent the click from triggering play/pause or any other behavior
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const cards = Array.from(document.querySelectorAll("#grid .card"));
  const index = cards.indexOf(card);
  if (index >= 0) {
    toggleMuteForPlayer(index);
  }
}, true); // true = capture phase

/* ---------- Focus selection mode ---------- */

function toggleFocusSelectMode() {
  // Only allow focus mode if 2+ videos loaded
  if (players.length < 2) return;

  // If we're in focus layout mode, exit it
  if (document.body.classList.contains("focusLayout")) {
    exitFocusLayout();
    return;
  }

  // Toggle focus select mode
  focusMode = !focusMode;
  document.body.classList.toggle("focusSelectMode", focusMode);

  // Exit mute select mode if entering focus mode
  if (focusMode && muteSelectMode) {
    muteSelectMode = false;
    document.body.classList.remove("muteSelectMode");
  }
}

function setFocusedPlayer(playerIndex) {
  if (playerIndex < 0 || playerIndex >= players.length) return;

  focusedPlayerIndex = playerIndex;
  document.body.classList.remove("focusSelectMode");
  focusMode = false;
  applyFocusLayout();
}

function applyFocusLayout() {
  const grid = el("grid");
  if (!grid || focusedPlayerIndex === null) return;

  // Find all cards - they could be in gridRows or directly in grid
  const cards = Array.from(grid.querySelectorAll(".card"));
  if (cards.length < 2) return;

  // Just add CSS classes - no DOM manipulation!
  document.body.classList.add("focusLayout");

  // Count unfocused cards and set grid columns dynamically
  const unfocusedCount = cards.length - 1;
  grid.style.gridTemplateColumns = `repeat(${unfocusedCount}, 1fr)`;

  // Mark the focused card and set CSS order
  cards.forEach((card, i) => {
    if (i === focusedPlayerIndex) {
      card.classList.add("focusedCard");
      card.style.order = "0";
    } else {
      card.classList.remove("focusedCard");
      card.classList.add("unfocusedCard");
      card.style.order = "1";
    }
  });

  // Hide gridRows (they interfere with flex layout)
  grid.querySelectorAll(".gridRow").forEach(row => {
    row.style.display = "contents";
  });
}

function exitFocusLayout() {
  const grid = el("grid");
  if (!grid) return;

  document.body.classList.remove("focusLayout");
  focusedPlayerIndex = null;

  // Remove focus classes and order styles
  const cards = Array.from(grid.querySelectorAll(".card"));
  cards.forEach(card => {
    card.classList.remove("focusedCard", "unfocusedCard");
    card.style.order = "";
  });

  // Reset grid columns
  grid.style.gridTemplateColumns = "";

  // Restore gridRows
  grid.querySelectorAll(".gridRow").forEach(row => {
    row.style.display = "";
  });

  setTimeout(() => {
    updateTileHeight();
    updateSafeArea();
  }, 0);
}

// Global click handler for focus selection mode (capture phase)
document.addEventListener("click", (e) => {
  if (!focusMode) return;

  const card = e.target.closest("#grid .card");
  if (!card) return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const cards = Array.from(document.querySelectorAll("#grid .card"));
  const index = cards.indexOf(card);
  if (index >= 0) {
    setFocusedPlayer(index);
  }
}, true);

/* ---------- Draw mode ---------- */

const DRAW_COLORS = [
  { name: "gray", hex: "#808080" },
  { name: "black", hex: "#1a1a1a" },
  { name: "white", hex: "#ffffff" },
  { name: "yellow", hex: "#ffeb3b" },
  { name: "orange", hex: "#ff9800" },
  { name: "red", hex: "#f44336" },
  { name: "pink", hex: "#e91e63" },
  { name: "purple", hex: "#9c27b0" },
  { name: "blue", hex: "#2196f3" },
  { name: "green", hex: "#4caf50" }
];

function createDrawCanvas() {
  if (drawCanvas) return;

  const grid = el("grid");
  if (!grid) return;

  drawCanvas = document.createElement("canvas");
  drawCanvas.id = "drawCanvas";
  drawCanvas.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 1000;
    cursor: crosshair;
    pointer-events: auto;
  `;
  document.body.appendChild(drawCanvas);

  drawCanvas.width = window.innerWidth;
  drawCanvas.height = window.innerHeight;

  drawCtx = drawCanvas.getContext("2d");
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  drawCtx.lineWidth = 4;
  drawCtx.strokeStyle = drawColor;

  drawCanvas.addEventListener("mousedown", startDrawing);
  drawCanvas.addEventListener("mousemove", draw);
  drawCanvas.addEventListener("mouseup", stopDrawing);
  drawCanvas.addEventListener("mouseout", stopDrawing);
  window.addEventListener("resize", resizeDrawCanvas);
  document.addEventListener("keydown", handleDrawKeydown);
}

function resizeDrawCanvas() {
  if (!drawCanvas || !drawCtx) return;
  const imageData = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
  drawCanvas.width = window.innerWidth;
  drawCanvas.height = window.innerHeight;
  drawCtx.putImageData(imageData, 0, 0);
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  drawCtx.lineWidth = 4;
  drawCtx.strokeStyle = drawColor;
}

function startDrawing(e) {
  isDrawing = true;
  lastX = e.clientX;
  lastY = e.clientY;
}

function draw(e) {
  if (!isDrawing) return;
  drawCtx.beginPath();
  drawCtx.moveTo(lastX, lastY);
  drawCtx.lineTo(e.clientX, e.clientY);
  drawCtx.stroke();
  lastX = e.clientX;
  lastY = e.clientY;
}

function stopDrawing() {
  if (isDrawing && drawCanvas && drawCtx) {
    // Save current state to history for undo
    drawHistory.push(drawCanvas.toDataURL());
    redoHistory = [];  // Clear redo stack on new drawing
  }
  isDrawing = false;
}

function removeDrawCanvas() {
  if (drawCanvas) {
    drawCanvas.removeEventListener("mousedown", startDrawing);
    drawCanvas.removeEventListener("mousemove", draw);
    drawCanvas.removeEventListener("mouseup", stopDrawing);
    drawCanvas.removeEventListener("mouseout", stopDrawing);
    window.removeEventListener("resize", resizeDrawCanvas);
    document.removeEventListener("keydown", handleDrawKeydown);
    drawCanvas.remove();
    drawCanvas = null;
    drawCtx = null;
    drawHistory = [];
    redoHistory = [];
  }
}

function handleDrawKeydown(e) {
  if (!drawMode || !drawCanvas || !drawCtx) return;

  // Ctrl+Z for undo
  if (e.ctrlKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undoDraw();
  }
  // Ctrl+Y for redo
  if (e.ctrlKey && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redoDraw();
  }
}

function undoDraw() {
  if (drawHistory.length === 0) return;

  // Save current state to redo stack
  redoHistory.push(drawCanvas.toDataURL());

  // Pop last state from history
  const previousState = drawHistory.pop();

  // Restore previous state (or clear if it was the first stroke)
  if (drawHistory.length === 0) {
    // Clear canvas completely
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  } else {
    // Load the state before the last stroke
    const img = new Image();
    img.onload = () => {
      drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      drawCtx.drawImage(img, 0, 0);
    };
    img.src = drawHistory[drawHistory.length - 1];
  }
}

function redoDraw() {
  if (redoHistory.length === 0) return;

  // Pop from redo stack
  const redoState = redoHistory.pop();

  // Save current to history
  drawHistory.push(drawCanvas.toDataURL());

  // Restore redo state
  const img = new Image();
  img.onload = () => {
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    drawCtx.drawImage(img, 0, 0);
  };
  img.src = redoState;
}

function createColorSelector() {
  const existing = el("drawColorBar");
  if (existing) existing.remove();

  const bar = document.createElement("div");
  bar.id = "drawColorBar";
  bar.style.cssText = `
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1001;
    background: #1a1a1a;
    border-radius: 25px;
    padding: 8px 16px;
    display: flex;
    gap: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  `;

  DRAW_COLORS.forEach(color => {
    const btn = document.createElement("button");
    btn.className = "drawColorBtn";
    btn.dataset.color = color.hex;
    btn.title = color.name;
    btn.style.cssText = `
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 2px solid ${color.hex === drawColor ? "#fff" : "transparent"};
      background: ${color.hex};
      cursor: pointer;
      padding: 0;
      transition: transform 0.1s, border-color 0.1s;
    `;

    btn.addEventListener("click", () => {
      drawColor = color.hex;
      if (drawCtx) drawCtx.strokeStyle = drawColor;
      document.querySelectorAll(".drawColorBtn").forEach(b => {
        b.style.borderColor = b.dataset.color === drawColor ? "#fff" : "transparent";
      });
    });

    btn.addEventListener("mouseenter", () => { btn.style.transform = "scale(1.15)"; });
    btn.addEventListener("mouseleave", () => { btn.style.transform = "scale(1)"; });

    bar.appendChild(btn);
  });

  document.body.appendChild(bar);
}

function removeColorSelector() {
  const bar = el("drawColorBar");
  if (bar) bar.remove();
}

function toggleDrawMode() {
  drawMode = !drawMode;
  document.body.classList.toggle("drawMode", drawMode);

  if (drawMode) {
    pauseAll(100);

    if (muteSelectMode) {
      muteSelectMode = false;
      document.body.classList.remove("muteSelectMode");
    }
    if (focusMode) {
      focusMode = false;
      document.body.classList.remove("focusSelectMode");
    }

    createDrawCanvas();
    createColorSelector();
  } else {
    removeDrawCanvas();
    removeColorSelector();
  }
}

function syncNow() {
  const g = getMedianGlobalTime();
  seekAllToGlobal(g, 2000);
}

function skipAll(deltaSeconds) {
  const g = getMedianGlobalTime() + (Number(deltaSeconds) || 0);
  seekAllToGlobal(g, 2000);
}

function updatePlayPauseLabel() {
  const isPlay = anyPlaying();

  const topPlay = el("playAllBtn");
  const topPause = el("pauseAllBtn");
  const z = el("zPlayPause");

  if (topPlay) topPlay.disabled = isPlay;
  if (topPause) topPause.disabled = !isPlay;
  if (z) z.textContent = isPlay ? "Pause" : "Play";
}

/* ---------- Sync helpers (GLOBAL timeline) ---------- */

function broadcast(fn, lockoutMs = 450, globalTarget = null) {
  beginLockout(lockoutMs);
  for (let i = 0; i < players.length; i++) {
    if (!shouldParticipate(i, globalTarget)) continue;
    const p = players[i];
    p && safe(() => fn(p, i));
  }
}

function seekAllToGlobal(globalT, lockoutMs = 650) {
  globalCursorTime = Math.max(0, globalT);

  beginLockout(lockoutMs);

  for (let i = 0; i < players.length; i++) {
    // If ended and globalT is still past its end, ignore.
    // If globalT is before end, allow rejoin.
    if (!shouldParticipate(i, globalT)) continue;
    applySeekClamped(i, globalT);
  }

  setTimeout(() => {
    // refreshGlobalCursorFromActive(globalCursorTime); // REMOVED: causes jump-back if players lag
    updateUiTime();
  }, 120);
}

/* ---------- UI time + seekbar ---------- */

function updateUiTime() {
  if (!players.length) return;

  const g = (syncing || inLockout()) ? globalCursorTime : getMedianGlobalTime();
  const d = getMaxGlobalEnd();

  const timeLabel = el("timeLabel");
  const zenTime = el("zenTime");

  if (timeLabel) timeLabel.textContent = `${formatTime(g)} / ${formatTime(d)}`;
  if (zenTime) zenTime.textContent = `${formatTime(g)} / ${formatTime(d)}`;

  if (Number.isFinite(d) && d > 0) {
    const clampedT = Math.max(0, Math.min(g, d));
    const v = Math.round((clampedT / d) * 1000);
    if (!isSeeking && el("seekBar")) el("seekBar").value = v;
    if (!isZenSeeking && el("zenSeek")) el("zenSeek").value = v;
  } else {
    if (!isSeeking && el("seekBar")) el("seekBar").value = 0;
    if (!isZenSeeking && el("zenSeek")) el("zenSeek").value = 0;
  }

  updatePlayPauseLabel();
}

/* ---------- Drift correction loop ---------- */

function startDriftLoop() {
  clearInterval(driftTimer);
  driftTimer = setInterval(() => {
    if (!players.length) return;
    if (syncing || inLockout()) return;

    // Only correct drift if something is playing
    if (!anyPlaying()) return;

    const threshold = Math.max(0, +(el("threshold")?.value || 0.25));
    if (!Number.isFinite(threshold) || threshold <= 0) return;

    const gMed = getMedianGlobalTime();

    for (let i = 0; i < players.length; i++) {
      // Special check for Twitch: prevent "Up Next" screen
      // If within 1s of end, force pause (which effectively hides the end screen)
      if (players[i]?.__type === "twitch") {
        const d = getDurationSafe(i);
        const t = getCurrentTimeSafe(i);
        if (d > 0 && t > d - 2.0) {
          safe(() => players[i].pauseVideo());
          endedFlags[i] = true;
          continue; // Don't do drift correction on a player we just paused
        }
      }

      if (!shouldParticipate(i, gMed)) continue;

      const off = getOffset(i);
      const local = getCurrentTimeSafe(i);
      const g = local + off;

      const diff = g - gMed;
      if (Math.abs(diff) > threshold) {
        applySeekClamped(i, gMed);
      }
    }
  }, 350);
}

function startUiLoop() {
  clearInterval(uiTimer);
  uiTimer = setInterval(updateUiTime, 250);
}

/* ---------- Auto-hide controls ---------- */

let autoHideEnabled = false;
let hideTimer = null;

function setAutoHide(enabled) {
  autoHideEnabled = !!enabled;

  const zone = el("zenHoverZone");
  const bar = el("zenBar");
  if (!zone || !bar) return;

  if (document.body.classList.contains("zen") && autoHideEnabled) {
    zone.classList.add("active");
    scheduleHide();
  } else {
    zone.classList.remove("active");
    bar.classList.remove("autohideHidden");
    clearTimeout(hideTimer);
  }

  // If Autohide is OFF in Zen, reserve space so the bar doesn't cover the bottom row
  document.body.classList.toggle(
    "zenPinned",
    document.body.classList.contains("zen") && !autoHideEnabled
  );

  updateZenBarSpace();
  setTimeout(() => {
    updateTileHeight();
    updateSafeArea();
  }, 0);
}

function scheduleHide() {
  clearTimeout(hideTimer);
  if (!autoHideEnabled) return;
  if (!document.body.classList.contains("zen")) return;

  hideTimer = setTimeout(() => {
    el("zenBar")?.classList.add("autohideHidden");
  }, 900);
}

function showBarNow() {
  el("zenBar")?.classList.remove("autohideHidden");
  scheduleHide();
}

/* ---------- Zen mode ---------- */

function showZenBar(show) {
  el("zenBar")?.classList.toggle("show", !!show);
  updateZenBarSpace();
}

function setZenMode(onMode) {
  document.body.classList.toggle("zen", !!onMode);
  showZenBar(!!onMode && players.length > 0);
  updateZenBarSpace();

  setTimeout(() => {
    setAutoHide(false);
    updateTileHeight();
    updateSafeArea();
    updatePlayPauseLabel();
  }, 50);
}

function toggleZenMode() {
  setZenMode(!document.body.classList.contains("zen"));
}

function updateZenBarSpace() {
  const bar = el("zenBar");
  if (!bar) return;

  const h = Math.ceil(bar.getBoundingClientRect().height || 0);
  document.documentElement.style.setProperty("--zenBarH", `${h}px`);
}

/* ---------- Layout sizing ---------- */
function updateTileHeight() {
  const grid = el("grid");
  const rowsInput = el("rows");
  if (!grid || !rowsInput) return;

  const rows = Math.max(1, +rowsInput.value || 1);
  const gap = 5;

  const available = grid.clientHeight - (gap * (rows - 1));
  const tileH = Math.max(120, Math.floor((available / rows) - 1));

  document.documentElement.style.setProperty("--tileH", `${tileH}px`);
  document.documentElement.style.setProperty("--gap", "5px");
}

function updateSafeArea() {
  const wraps = document.querySelectorAll(".playerWrap");
  if (!wraps.length) {
    document.documentElement.style.setProperty("--safe", "12px");
    return;
  }

  let minH = Infinity;
  wraps.forEach(w => {
    const h = w.getBoundingClientRect().height;
    if (h && h < minH) minH = h;
  });

  const safePx =
    minH < 220 ? 26 :
      minH < 280 ? 22 :
        minH < 360 ? 16 :
          12;

  document.documentElement.style.setProperty("--safe", `${safePx}px`);
}

function applyLayout() {
  document.documentElement.style.setProperty("--gap", "5px");

  document.querySelectorAll(".playerWrap").forEach(w => {
    w.className = "playerWrap " + (el("ratio")?.value || "r16x9");
  });

  setTimeout(() => {
    updateTileHeight();
    updateSafeArea();
  }, 0);
}



/* ---------- Unified adapters ---------- */

function makeYtAdapter(ytPlayer) {
  return {
    __type: "yt",
    __yt: ytPlayer,
    destroy: () => ytPlayer.destroy(),
    getCurrentTime: () => ytPlayer.getCurrentTime(),
    getDuration: () => ytPlayer.getDuration(),
    seekTo: (t, allowSeekAhead) => ytPlayer.seekTo(t, allowSeekAhead),
    playVideo: () => ytPlayer.playVideo(),
    pauseVideo: () => ytPlayer.pauseVideo(),
    pauseVideo: () => ytPlayer.pauseVideo(),
    setPlaybackRate: (v) => ytPlayer.setPlaybackRate(v),
    getPlayerState: () => ytPlayer.getPlayerState(),
    setVolume: (v) => ytPlayer.setVolume(v),
    getVolume: () => ytPlayer.getVolume(),
    unMute: () => ytPlayer.unMute(),
    mute: () => ytPlayer.mute(),
    isMuted: () => ytPlayer.isMuted()
  };
}

function makeFileAdapter(videoEl, cleanup) {
  return {
    __type: "file",
    __video: videoEl,
    destroy: () => cleanup?.(),
    getCurrentTime: () => videoEl.currentTime || 0,
    getDuration: () => (Number.isFinite(videoEl.duration) ? videoEl.duration : 0),
    seekTo: (t) => { videoEl.currentTime = Math.max(0, t || 0); },
    playVideo: () => { const p = videoEl.play(); if (p?.catch) p.catch(() => { }); },
    pauseVideo: () => videoEl.pause(),
    setPlaybackRate: (v) => { videoEl.playbackRate = Number(v) || 1; },
    getPlayerState: () => (videoEl.paused ? 2 : 1),
    setVolume: (v) => { videoEl.volume = Math.max(0, Math.min(100, v)) / 100; videoEl.muted = (v === 0); },
    getVolume: () => (videoEl.muted ? 0 : videoEl.volume * 100),
    unMute: () => { videoEl.muted = false; },
    mute: () => { videoEl.muted = true; },
    isMuted: () => videoEl.muted
  };
}

function makeTwitchAdapter(twitchPlayer, holderEl) {
  return {
    __type: "twitch",
    __twitch: twitchPlayer,
    __holder: holderEl,
    __ready: false, // Set to true after initialization completes
    destroy: () => {
      // Twitch player doesn't have a destroy method, so we remove the holder element
      try { holderEl?.remove(); } catch { }
    },
    getCurrentTime: () => {
      try { return twitchPlayer.getCurrentTime() || 0; } catch { return 0; }
    },
    getDuration: () => {
      try { return twitchPlayer.getDuration() || 0; } catch { return 0; }
    },
    seekTo: (t) => {
      try { twitchPlayer.seek(Math.max(0, t || 0)); } catch { }
    },
    playVideo: () => {
      try { twitchPlayer.play(); } catch { }
    },
    pauseVideo: () => {
      try { twitchPlayer.pause(); } catch { }
    },
    setPlaybackRate: (v) => {
      // Twitch doesn't support playback rate - no-op
    },
    getPlayerState: () => {
      try {
        return twitchPlayer.isPaused() ? 2 : 1;
      } catch { return 2; }
    },
    setVolume: (v) => {
      try {
        // Twitch volume is 0-1, input is 0-100
        twitchPlayer.setVolume(Math.max(0, Math.min(100, v)) / 100);
        if (v === 0) twitchPlayer.setMuted(true);
      } catch { }
    },
    getVolume: () => {
      try {
        if (twitchPlayer.getMuted()) return 0;
        return (twitchPlayer.getVolume() || 0) * 100;
      } catch { return 0; }
    },
    unMute: () => {
      try { twitchPlayer.setMuted(false); } catch { }
    },
    mute: () => {
      try { twitchPlayer.setMuted(true); } catch { }
    },
    isMuted: () => {
      try { return twitchPlayer.getMuted(); } catch { return true; }
    }
  };
}

/* ---------- YouTube API ready ---------- */

window.onYouTubeIframeAPIReady = () => {
  apiReady = true;
};

/* ---------- Video setup UI (dynamic rows) ---------- */

function parseStartTimeToSeconds(raw) {
  const s = String(raw || "").trim();
  if (!s) return 0;

  // Allow plain seconds like "5" or "5.5"
  if (/^-?\d+(\.\d+)?$/.test(s)) return Math.max(0, parseFloat(s));

  // Allow hh:mm:ss or mm:ss
  const parts = s.split(":").map(p => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return 0;

  const nums = parts.map(p => parseFloat(p));
  if (nums.some(n => !Number.isFinite(n))) return 0;

  let hh = 0, mm = 0, ss = 0;
  if (parts.length === 2) {
    [mm, ss] = nums;
  } else {
    [hh, mm, ss] = nums;
  }
  return Math.max(0, (hh * 3600) + (mm * 60) + ss);
}

function formatStartPlaceholder() {
  return "Start Time: hh:mm:ss";
}

function checkTwitchConstraints() {
  const list = el("videoList");
  if (!list) return;

  // Check if any visible video input contains a Twitch URL
  const inputs = Array.from(list.querySelectorAll(".videoUrl"));
  const hasTwitch = inputs.some(input => !!extractTwitchId(input.value));

  const tInput = el("threshold");
  if (!tInput) return;

  if (hasTwitch) {
    if (cachedDriftBeforeTwitch === null) {
      cachedDriftBeforeTwitch = tInput.value;
    }
    tInput.min = "1";
    if (Number(tInput.value) < 1) {
      tInput.value = "1";
      setStatus("Minimum drift required with Twitch is 1 sec", true, 3000);
    }
  } else {
    tInput.removeAttribute("min");
    if (cachedDriftBeforeTwitch !== null) {
      tInput.value = cachedDriftBeforeTwitch;
      cachedDriftBeforeTwitch = null;
    }
  }
}

function ensureVideoRow(idx) {
  const list = el("videoList");
  if (!list) return null;

  // already exists?
  const existing = list.querySelector(`.videoBlock[data-idx="${idx}"]`);
  if (existing) return existing;

  const block = document.createElement("div");
  block.className = "videoBlock";
  block.dataset.idx = String(idx);

  const title = document.createElement("div");
  title.className = "videoTitle";
  title.textContent = `Video ${idx + 1}`;
  block.appendChild(title);

  const row = document.createElement("div");
  row.className = "videoRow";

  // URL / ID input
  const url = document.createElement("input");
  url.type = "text";
  url.className = "videoUrl";
  url.placeholder = "YouTube, Twitch VOD, or File";
  url.autocomplete = "off";
  row.appendChild(url);

  // browse button + hidden file input
  const browseBtn = document.createElement("button");
  browseBtn.type = "button";
  browseBtn.className = "browseBtn";
  browseBtn.textContent = "Browse";

  const file = document.createElement("input");
  file.type = "file";
  file.accept = "video/*";
  file.className = "videoFile";
  file.style.display = "none";

  browseBtn.addEventListener("click", () => file.click());
  row.appendChild(browseBtn);
  row.appendChild(file);

  // Start time
  const st = document.createElement("input");
  st.type = "text";
  st.className = "startTime";
  st.placeholder = formatStartPlaceholder();
  st.autocomplete = "off";
  row.appendChild(st);

  // Video Name
  const vn = document.createElement("input");
  vn.type = "text";
  vn.className = "videoNameInput";
  vn.placeholder = "Video Name";
  vn.autocomplete = "off";
  row.appendChild(vn);

  block.appendChild(row);

  // Events: if user types a YT link, clear file
  url.addEventListener("input", () => {
    if (url.value.trim()) {
      // If they type a URL, prefer it and clear any selected file
      try { file.value = ""; } catch { }
      block.dataset.hasFile = "0";
    }
    checkTwitchConstraints();
    maybeAddNextRow();
  });

  // If file picked, show its name in the text box and clear YT URL
  file.addEventListener("change", () => {
    const f = file.files?.[0] || null;
    if (f) {
      url.value = f.name;
      block.dataset.hasFile = "1";
    } else {
      block.dataset.hasFile = "0";
    }
    checkTwitchConstraints();
    maybeAddNextRow();
  });

  st.addEventListener("input", () => maybeAddNextRow());

  list.appendChild(block);
  return block;
}

function rowIsFilled(block) {
  if (!block) return false;
  const url = block.querySelector(".videoUrl");
  const file = block.querySelector(".videoFile");
  const hasFile = (file?.files?.length || 0) > 0;
  const hasUrl = !!(url?.value || "").trim();
  return hasFile || hasUrl;
}

function maybeAddNextRow() {
  const list = el("videoList");
  if (!list) return;

  const blocks = Array.from(list.querySelectorAll(".videoBlock"));

  // Find the index of the last filled row
  let lastFilledIndex = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (rowIsFilled(blocks[i])) {
      lastFilledIndex = i;
    }
  }

  // We want exactly one empty row after the last filled one, but max 6 total.
  // If no rows are filled, lastFilledIndex is -1 => target is 1 row (index 0).
  // If row 0 is filled, lastFilledIndex is 0 => target is 2 rows.
  let targetCount = lastFilledIndex + 2;
  if (targetCount > 6) targetCount = 6;

  // Add rows if needed
  while (blocks.length < targetCount) {
    const newBlock = ensureVideoRow(blocks.length);
    blocks.push(newBlock);
  }

  // Remove rows if we have too many
  // But be careful not to remove the *last* existing row if everything is empty (targetCount=1)
  // The loop condition `blocks.length > targetCount` handles this safely.
  while (blocks.length > targetCount) {
    const r = blocks.pop();
    r.remove();
  }

  // Update filled count and layout options
  const filledCount = lastFilledIndex + 1;
  if (filledCount !== currentFilledVideoCount) {
    currentFilledVideoCount = filledCount;
    currentLayoutOption = 'A'; // Reset layout preference
    updateLayoutOptionsUI(filledCount);
  }
}

function updateLayoutOptionsUI(videoCount) {
  const btnA = el("layoutA");
  const btnB = el("layoutB");
  const btnC = el("layoutC");
  if (!btnA || !btnB || !btnC) return;

  const configs = LAYOUT_CONFIGS[videoCount] || {};
  const hasA = !!configs.A;
  const hasB = !!configs.B;
  const hasC = !!configs.C;

  btnA.style.display = hasA ? "" : "none";
  btnB.style.display = hasB ? "" : "none";
  btnC.style.display = hasC ? "" : "none";

  // Generate icon content for each button
  if (hasA) btnA.innerHTML = generateLayoutIcon(configs.A);
  if (hasB) btnB.innerHTML = generateLayoutIcon(configs.B);
  if (hasC) btnC.innerHTML = generateLayoutIcon(configs.C);

  // If current option is not available, reset to 'A'
  if (!configs[currentLayoutOption]) {
    currentLayoutOption = 'A';
  }

  // Update active state
  btnA.classList.toggle("active", currentLayoutOption === 'A');
  btnB.classList.toggle("active", currentLayoutOption === 'B');
  btnC.classList.toggle("active", currentLayoutOption === 'C');
}

function generateLayoutIcon(rows) {
  // rows is an array of { count, centered } objects
  let html = '';
  for (const row of rows) {
    const boxes = '<div class="layoutIconBox"></div>'.repeat(row.count);
    html += `<div class="layoutIconRow">${boxes}</div>`;
  }
  return html;
}

function initVideoSetupUI() {
  const list = el("videoList");
  if (!list) return;
  list.innerHTML = "";
  ensureVideoRow(0);
}

/* ---------- Load videos from dynamic rows ---------- */

function collectSourcesFromUI() {
  const list = el("videoList");
  const blocks = Array.from(list?.querySelectorAll(".videoBlock") || []);

  const sources = [];
  for (const block of blocks) {
    const urlEl = block.querySelector(".videoUrl");
    const fileEl = block.querySelector(".videoFile");
    const stEl = block.querySelector(".startTime");
    const vnEl = block.querySelector(".videoNameInput");

    const f = fileEl?.files?.[0] || null;
    const rawUrl = (urlEl?.value || "").trim();
    const startAt = parseStartTimeToSeconds(stEl?.value || "");
    const name = (vnEl?.value || "").trim();

    if (f) {
      sources.push({ type: "file", file: f, startAt, name });
    } else if (rawUrl) {
      // Check Twitch first (more distinctive URL pattern)
      const twitchId = extractTwitchId(rawUrl);
      if (twitchId) {
        sources.push({ type: "twitch", videoId: twitchId, startAt, name });
      } else {
        // Fall back to YouTube
        const id = extractId(rawUrl);
        if (id) sources.push({ type: "yt", id, startAt, name });
        else sources.push({ type: "bad", raw: rawUrl, startAt, name });
      }
    }
  }

  return sources;
}

function cleanupObjectUrls() {
  for (const u of activeObjectUrls) {
    try { URL.revokeObjectURL(u); } catch { }
  }
  activeObjectUrls = [];
}

function loadVideos() {
  const sources = collectSourcesFromUI();

  const bad = sources.filter(s => s.type === "bad");
  if (bad.length) {
    setStatus(`One or more YouTube links look invalid. Fix them and try again.`, true);
    return;
  }

  const realSources = sources.filter(s => s.type === "yt" || s.type === "file" || s.type === "twitch");



  if (realSources.some(s => s.type === "yt") && !apiReady) {
    setStatus("YouTube API not ready yet. Try again in a second.", true);
    return;
  }

  const totalCount = realSources.length;

  if (totalCount <= 0) {
    setStatus("Add at least one YouTube link/ID or choose a local video file.", true);
    return;
  }


  // Arm native keybind blocking only after Load succeeds
  keybindsArmed = true;
  ipcRenderer.send("app:setKeybindsArmed", true);

  // Start Time means: at global 0, the video should be at local "startAt".
  // Our sync math uses global = local + offset => offset must be -startAt.
  offsets = realSources.map(s => -(Number(s.startAt) || 0));
  endedFlags = Array(totalCount).fill(false);
  globalCursorTime = 0;

  setStatus(`Loading ${totalCount} video(s).`, false);

  players.forEach(p => { try { p.destroy(); } catch { } });
  players = [];
  holders = [];
  if (el("grid")) el("grid").innerHTML = "";
  cleanupObjectUrls();

  // Get layout configuration for this video count
  const layoutConfig = LAYOUT_CONFIGS[totalCount]?.[currentLayoutOption] ||
    LAYOUT_CONFIGS[totalCount]?.A ||
    [{ count: totalCount, centered: false }];

  // Create row containers based on layout config
  const rowContainers = [];
  for (const rowDef of layoutConfig) {
    const rowDiv = document.createElement("div");
    rowDiv.className = "gridRow" + (rowDef.centered ? " centered" : "");
    el("grid").appendChild(rowDiv);
    rowContainers.push({ el: rowDiv, count: rowDef.count, filled: 0 });
  }

  // Helper to get next available row container
  let currentRowIdx = 0;
  const getRowForCard = () => {
    while (currentRowIdx < rowContainers.length) {
      const row = rowContainers[currentRowIdx];
      if (row.filled < row.count) {
        row.filled++;
        return row.el;
      }
      currentRowIdx++;
    }
    // Fallback: create a new row if needed
    const fallbackRow = document.createElement("div");
    fallbackRow.className = "gridRow";
    el("grid").appendChild(fallbackRow);
    return fallbackRow;
  };

  for (let i = 0; i < totalCount; i++) {
    const card = document.createElement("div");
    card.className = "card";

    // Video Name Header
    const src = realSources[i];
    const nameStr = src.name || "";
    const header = document.createElement("div");
    header.className = "videoHeader";

    const nameSpan = document.createElement("span");
    nameSpan.className = "videoNameText";
    nameSpan.textContent = nameStr;
    header.appendChild(nameSpan);

    // Volume Slider
    const volWrap = document.createElement("div");
    volWrap.className = "volControl";

    // Icon
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("class", "volIcon");

    // SVG Paths
    const PATH_MUTE = 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z';
    const PATH_LOW = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z';
    const PATH_HIGH = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';

    const updateIcon = (val) => {
      let path = PATH_MUTE;
      if (val > 50) path = PATH_HIGH;
      else if (val > 0) path = PATH_LOW;
      icon.innerHTML = `<path d="${path}"/>`;
    };
    // Initialize default (mute)
    updateIcon(0);

    // Toggle mute on icon click
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMuteForPlayer(i);
    });
    // Stop propagation for mousedown too just in case
    icon.addEventListener("mousedown", (e) => e.stopPropagation());

    volWrap.appendChild(icon);

    const range = document.createElement("input");
    range.type = "range";
    range.className = "volSlider";
    range.min = 0;
    range.max = 100;
    range.value = 0; // Default mute

    const updateSliderFill = (input) => {
      const val = (input.value - input.min) / (input.max - input.min) * 100;
      input.style.background = `linear-gradient(to right, #eee ${val}%, #444 ${val}%)`;
    };
    updateSliderFill(range);

    range.addEventListener("input", (e) => {
      updateSliderFill(e.target);
      const v = +e.target.value;
      updateIcon(v);
      const p = players[i];
      if (p) {
        if (v > 0) p.unMute();
        else p.mute();
        p.setVolume(v);
      }
      // Update mute class on card
      const c = document.querySelectorAll("#grid .card")[i];
      if (c) c.classList.toggle("muted", v === 0);
    });
    // Stop propagation so seeking volume doesn't trigger card clicks/drag
    range.addEventListener("click", e => e.stopPropagation());
    range.addEventListener("mousedown", e => e.stopPropagation());

    volWrap.appendChild(range);
    header.appendChild(volWrap);

    card.appendChild(header);

    const wrap = document.createElement("div");
    wrap.className = "playerWrap r16x9";

    card.appendChild(wrap);
    getRowForCard().appendChild(card);

    card.__wrap = wrap;
  }

  setTimeout(() => {
    updateTileHeight();
    updateSafeArea();
  }, 0);

  function afterAnyReady() {
    updateTileHeight();
    updateSafeArea();
    updatePlayPauseLabel();

    const topSpeed = el("speedSelect");
    const zenSpeed = el("zSpeed");
    if (topSpeed && zenSpeed) zenSpeed.value = topSpeed.value;

    showBarNow();
  }

  const cards = Array.from(el("grid")?.querySelectorAll(".card") || []);

  // Build players in the SAME ORDER as the setup list
  realSources.forEach((src, i) => {
    const wrap = cards[i]?.__wrap;
    if (!wrap) return;

    if (src.type === "yt") {
      const holder = document.createElement("div");
      holder.id = `p${i}-${Date.now()}`;
      wrap.appendChild(holder);
      holders.push(holder.id);

      // Check controls setting
      const showControls = el("ytControlsToggle")?.checked || false;

      const yt = new YT.Player(holder.id, {
        width: "100%",
        height: "100%",
        videoId: src.id,
        playerVars: {
          disablekb: 1,        // no YouTube keyboard shortcuts
          controls: showControls ? 1 : 0,
          fs: 0,               // disable fullscreen
          rel: 0,              // reduce related videos
          modestbranding: 1,   // remove branding
          iv_load_policy: 3,   // hide annotations
          playsinline: 1,
          showinfo: 0,         // hide title / channel info (legacy but still effective)
          enablejsapi: 1,
          origin: "http://127.0.0.1"
        },
        events: {
          onReady: () => {
            setStatus(`Loaded ${totalCount} video(s).`, false);

            // Mute by default
            yt.mute();
            const card = cards[i];
            if (card) card.classList.add("muted");

            // Only disable mouse interaction if controls are hidden
            // If controls are shown, we let the user interact (sync might be affected but that's expected)
            const frame = holder.querySelector("iframe");
            if (frame && !showControls) {
              frame.style.pointerEvents = "none";
            }

            afterAnyReady();
          },

          onStateChange: e => {
            const srcYt = e.target;
            const srcIdx = players.findIndex(p => p.__type === "yt" && p.__yt === srcYt);

            // Always record ENDED even during lockout
            if (e.data === 0) {
              if (srcIdx >= 0) endedFlags[srcIdx] = true;
              setTimeout(updatePlayPauseLabel, 150);
              showBarNow();
              return;
            }

            if (syncing || inLockout()) return;

            const srcOff = getOffset(srcIdx >= 0 ? srcIdx : 0);

            let tLocal = 0;
            safe(() => { tLocal = srcYt.getCurrentTime(); });

            const g = tLocal + srcOff;
            globalCursorTime = g;

            if (e.data === 1) {
              // Play => seek others to same global time then play (only those playable)
              beginLockout(700);
              for (let k = 0; k < players.length; k++) {
                if (!shouldParticipate(k, g)) continue;

                const pk = players[k];

                // Skip seeking Twitch players - just play them without forcing time sync
                // Twitch seeking causes stutter due to its API latency
                if (pk && pk.__type === "twitch") {
                  safe(() => pk.playVideo());
                  continue;
                }

                const { playable } = computeLocalTarget(k, g);
                if (!playable) {
                  endedFlags[k] = true;
                  applySeekClamped(k, g);
                  continue;
                }

                applySeekClamped(k, g);
                safe(() => players[k].playVideo());
              }
              setTimeout(updatePlayPauseLabel, 150);
              showBarNow();
              return;
            }

            if (e.data === 2) {
              // Pause => pause others
              beginLockout(450);
              for (let k = 0; k < players.length; k++) {
                if (!shouldParticipate(k, null)) continue;
                safe(() => players[k].pauseVideo());
              }
              setTimeout(updatePlayPauseLabel, 150);
              showBarNow();
              return;
            }

            if (e.data === 3) {
              // Buffering => ignore
              return;
            }
          }
        }
      });

      players[i] = makeYtAdapter(yt);

      // Apply initial start time once player is usable
      const localStart = Math.max(0, Number(src.startAt) || 0);
      if (localStart > 0) {
        setTimeout(() => {
          try { yt.seekTo(localStart, true); } catch { }
        }, 250);
      }

      return;
    }

    // Twitch VOD
    if (src.type === "twitch") {
      const holder = document.createElement("div");
      holder.id = `twitch-${i}-${Date.now()}`;
      // Make holder fill the entire playerWrap container
      holder.style.position = "absolute";
      holder.style.top = "0";
      holder.style.left = "0";
      holder.style.width = "100%";
      holder.style.height = "100%";
      wrap.appendChild(holder);

      // Check controls setting (reusing the same checkbox as YT)
      const showControls = el("ytControlsToggle")?.checked || false;

      const twitchPlayer = new Twitch.Player(holder.id, {
        width: "100%",
        height: "100%",
        video: src.videoId,
        parent: ["127.0.0.1"],
        autoplay: false,
        muted: true,
        controls: showControls
      });

      // Mark as muted by default
      const card = cards[i];
      if (card) card.classList.add("muted");

      // Track if Twitch player is fully ready (to avoid spurious events during initialization)
      // We use both a local variable and set __ready on the adapter for anyPlaying() checks

      twitchPlayer.addEventListener(Twitch.Player.READY, () => {
        setStatus(`Loaded ${totalCount} video(s).`, false);

        // Style the iframe to fill the holder
        // Only disable pointer events if controls are HIDDEN.
        // If controls are shown, user needs to click play/pause/timeline.
        const frame = holder.querySelector("iframe");
        if (frame) {
          frame.style.width = "100%";
          frame.style.height = "100%";
          if (!showControls) {
            frame.style.pointerEvents = "none";
          }
        }

        // Seek to start position (0 or user-specified offset)
        const localStart = Math.max(0, Number(src.startAt) || 0);

        // Helper to ensure player is paused - retries until confirmed
        const ensurePausedAndReady = (retriesLeft = 5) => {
          try {
            twitchPlayer.pause();
            twitchPlayer.seek(localStart);
          } catch { }

          // Check if player thinks it's paused
          setTimeout(() => {
            let isPaused = true;
            try { isPaused = twitchPlayer.isPaused(); } catch { }

            if (!isPaused && retriesLeft > 0) {
              // Player still thinks it's playing - retry
              try { twitchPlayer.pause(); } catch { }
              ensurePausedAndReady(retriesLeft - 1);
            } else {
              // Player is paused (or we gave up) - mark as ready
              if (players[i]) players[i].__ready = true;
              afterAnyReady();
            }
          }, 200);
        };

        // Start the pause+ready sequence after initial delay
        setTimeout(ensurePausedAndReady, 300);
      });

      twitchPlayer.addEventListener(Twitch.Player.PLAY, () => {
        // Ignore events until adapter is fully ready (avoid spurious events during init)
        if (!players[i] || !players[i].__ready) return;
        if (syncing || inLockout()) return;

        // Twitch PLAY: just play other videos without forcing a seek
        // This avoids sync feedback loops since Twitch time reporting can be slightly off
        beginLockout(700);

        for (let k = 0; k < players.length; k++) {
          const pk = players[k];
          if (!pk) continue;
          // Don't re-trigger this same player
          if (pk.__type === "twitch" && pk.__twitch === twitchPlayer) continue;
          safe(() => pk.playVideo());
        }

        setTimeout(updatePlayPauseLabel, 150);
        showBarNow();
      });

      twitchPlayer.addEventListener(Twitch.Player.PAUSE, () => {
        // Ignore events until adapter is fully ready (avoid spurious events during init)
        if (!players[i] || !players[i].__ready) return;

        // If this video is marked as ended (ignored), DON'T broadcast pause
        if (endedFlags[i]) return;

        if (syncing || inLockout()) return;

        // Twitch PAUSE: just pause other videos without seeking
        beginLockout(450);

        for (let k = 0; k < players.length; k++) {
          const pk = players[k];
          if (!pk) continue;
          if (pk.__type === "twitch" && pk.__twitch === twitchPlayer) continue;
          safe(() => pk.pauseVideo());
        }

        setTimeout(updatePlayPauseLabel, 150);
        showBarNow();
      });

      twitchPlayer.addEventListener(Twitch.Player.ENDED, () => {
        const srcIdx = players.findIndex(p => p.__type === "twitch" && p.__twitch === twitchPlayer);
        if (srcIdx >= 0) endedFlags[srcIdx] = true;
        setTimeout(updatePlayPauseLabel, 150);
        showBarNow();
      });

      // Twitch SEEK: Don't sync other players when Twitch seeks
      // Since Twitch iframe has pointer-events disabled, user can't seek anyway
      // This event may fire on initial load or during buffering
      twitchPlayer.addEventListener(Twitch.Player.SEEK, () => {
        // Just update UI, don't sync others
        setTimeout(updatePlayPauseLabel, 150);
        showBarNow();
      });

      players[i] = makeTwitchAdapter(twitchPlayer, holder);
      return;
    }

    // Local file
    const v = document.createElement("video");
    v.style.width = "100%";
    v.style.height = "100%";
    v.style.background = "black";
    // No native HTML5 video UI (we control playback via the app)
    v.controls = false;
    v.playsInline = true;
    v.muted = true; // Mute by default

    // Extra hardening: remove extra built-in menus/features when supported
    v.setAttribute("controlslist", "nodownload noremoteplayback noplaybackrate");
    v.disablePictureInPicture = true;
    v.disableRemotePlayback = true;
    // Prevent native <video> keybinds from triggering via focus
    v.tabIndex = -1;

    v.addEventListener("contextmenu", (e) => e.preventDefault());

    const url = URL.createObjectURL(src.file);
    activeObjectUrls.push(url);
    v.src = url;

    wrap.appendChild(v);

    // Mute by default (visual state)
    const card = el("grid")?.children[i];
    if (card) card.classList.add("muted");

    // Wire file events for sync
    const onPlay = () => {
      if (syncing || inLockout()) return;

      const srcIdx = players.findIndex(p => p.__type === "file" && p.__video === v);
      const srcOff = getOffset(srcIdx >= 0 ? srcIdx : 0);
      const g = (v.currentTime || 0) + srcOff;
      globalCursorTime = g;

      beginLockout(700);

      for (let k = 0; k < players.length; k++) {
        if (!shouldParticipate(k, g)) continue;

        const pk = players[k];

        // Skip seeking Twitch players - just play them without forcing time sync
        if (pk && pk.__type === "twitch") {
          safe(() => pk.playVideo());
          continue;
        }

        const { playable } = computeLocalTarget(k, g);
        if (!playable) {
          endedFlags[k] = true;
          applySeekClamped(k, g);
          continue;
        }

        applySeekClamped(k, g);
        safe(() => players[k].playVideo());
      }

      setTimeout(updatePlayPauseLabel, 150);
      showBarNow();
    };

    const onPause = () => {
      // If pause is due to end, don't broadcast global pause
      if (v.ended) return;

      if (syncing || inLockout()) return;
      beginLockout(450);
      for (let k = 0; k < players.length; k++) {
        if (!shouldParticipate(k, null)) continue;
        safe(() => players[k].pauseVideo());
      }
      setTimeout(updatePlayPauseLabel, 150);
      showBarNow();
    };

    const onSeeked = () => {
      if (syncing || inLockout()) return;

      const srcIdx = players.findIndex(p => p.__type === "file" && p.__video === v);
      const srcOff = getOffset(srcIdx >= 0 ? srcIdx : 0);
      const g = (v.currentTime || 0) + srcOff;
      globalCursorTime = g;

      const wasPlaying = !v.paused;

      seekAllToGlobal(g, 700);
      if (wasPlaying) setTimeout(() => playAll(450), 80);
      else setTimeout(() => pauseAll(450), 80);

      setTimeout(updatePlayPauseLabel, 150);
      showBarNow();
    };

    const onRateChange = () => {
      if (syncing || inLockout()) return;
      const rate = Number(v.playbackRate) || 1;

      const topSpeed = el("speedSelect");
      const zenSpeed = el("zSpeed");
      if (topSpeed) topSpeed.value = String(rate);
      if (zenSpeed) zenSpeed.value = String(rate);

      const gCur = getMedianGlobalTime();
      broadcast(p => safe(() => p.setPlaybackRate(rate)), 300, gCur);
      showBarNow();
    };

    const onEnded = () => {
      const srcIdx = players.findIndex(p => p.__type === "file" && p.__video === v);
      if (srcIdx >= 0) endedFlags[srcIdx] = true;
      setTimeout(updatePlayPauseLabel, 150);
      showBarNow();
    };

    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("ratechange", onRateChange);
    v.addEventListener("ended", onEnded);

    const cleanup = () => {
      try {
        v.removeEventListener("play", onPlay);
        v.removeEventListener("pause", onPause);
        v.removeEventListener("seeked", onSeeked);
        v.removeEventListener("ratechange", onRateChange);
        v.removeEventListener("ended", onEnded);
      } catch { }
      try { v.pause(); } catch { }
      try { v.src = ""; } catch { }
    };

    players[i] = makeFileAdapter(v, cleanup);

    v.addEventListener("loadedmetadata", () => {
      setStatus(`Loaded ${totalCount} video(s).`, false);
      afterAnyReady();

      const localStart = Math.max(0, Number(src.startAt) || 0);
      if (localStart > 0) {
        try { v.currentTime = localStart; } catch { }
      }
    }, { once: true });
  });

  applyLayout();

  // ✅ Hide all settings after Load (like before)
  if (ENTER_ZEN_ON_LOAD) {
    setZenMode(true);
    document.body.classList.add("hasLoaded");
    showBarNow();
  }
}

/* Initialize the dynamic setup list on first load */
initVideoSetupUI();

/* ---------- Update checking ---------- */

function normalizeVersion(v) {
  const s = String(v || "").trim();
  const m = s.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return `${parseInt(m[1], 10)}.${parseInt(m[2], 10)}.${parseInt(m[3], 10)}`;
}

function compareVersions(a, b) {
  const pa = a.split(".").map(n => parseInt(n, 10));
  const pb = b.split(".").map(n => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function fetchUpdateManifest() {
  const res = await fetch(UPDATE_MANIFEST_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function checkForUpdates() {
  try {
    setStatus("Checking for updates.");
    const manifest = await fetchUpdateManifest();

    const latestVersion = normalizeVersion(manifest?.version);
    const downloadUrl = String(manifest?.url || "").trim();
    const notes = String(manifest?.notes || "").trim();

    if (!latestVersion || !downloadUrl) {
      setStatus("Update manifest is missing version/url.", true);
      return;
    }

    const cur = normalizeVersion(currentAppVersion || "0.0.0");
    const cmp = compareVersions(latestVersion, cur);

    if (cmp <= 0) {
      setStatus(`You're up to date (v${cur}).`);
      return;
    }

    const msg =
      `Update available!\n\n` +
      `Current: v${cur}\n` +
      `Latest:  v${latestVersion}\n\n` +
      (notes ? `Notes:\n${notes}\n\n` : "") +
      `Download now?`;

    const ok = window.confirm(msg);
    if (ok) {
      setStatus(`Downloading v${latestVersion}…`);

      // Download inside app (to Downloads)
      const { filePath } = await ipcRenderer.invoke("update:downloadInstaller", {
        url: downloadUrl,
        version: latestVersion
      });

      setStatus(`Downloaded v${latestVersion}. Ready to install.`);

      const installNow = window.confirm(
        `Downloaded v${latestVersion}.\n\nInstall now?\n\n(Your current version will close so the installer can run.)`
      );

      if (installNow) {
        // Launch installer, then quit app so install isn't blocked
        await ipcRenderer.invoke("update:installAndQuit", { filePath });
        // No further UI needed; app will quit
      }
    } else {
      setStatus(`Update available (v${latestVersion}).`);
    }

  } catch (err) {
    setStatus(`Update check failed: ${err?.message || err}`, true);
  }
}

/* ---------- App version UI ---------- */

async function initAppVersionUI() {
  try {
    currentAppVersion = await ipcRenderer.invoke("app:getVersion");
    const lab = el("appVersion");
    if (lab) lab.textContent = `v${currentAppVersion}`;
  } catch {
    currentAppVersion = null;
  }
}

/* ---------- Wiring ---------- */

// Settings UI toggle
on("autoHideToggle", "change", () => {
  setAutoHide(el("autoHideToggle").checked);
});

// Hover zone behavior
on("zenHoverZone", "mouseenter", () => showBarNow());
on("zenHoverZone", "mousemove", () => showBarNow());
on("zenBar", "mouseenter", () => showBarNow());
on("zenBar", "mousemove", () => showBarNow());
on("zenBar", "mouseleave", () => scheduleHide());

// Topbar
on("loadBtn", "click", loadVideos);
on("checkUpdateBtn", "click", checkForUpdates);

// Keybinds modal open / close
const kbModal = el("keybindsModal");

const openKb = () => {
  renderKeybindsUi();
  kbModal?.classList.add("open");
};

const closeKb = () => kbModal?.classList.remove("open");

on("keybindsBtn", "click", openKb);
on("keybindsClose", "click", closeKb);

// Click outside panel to close (Discord-style)
kbModal?.addEventListener("click", (e) => {
  if (e.target === kbModal) closeKb();
});

// Populate UI + send binds to main on startup
renderKeybindsUi();
saveKeybinds(); // sends to main

// Edit buttons
document.querySelectorAll(".kbEdit").forEach(btn => {
  btn.addEventListener("click", () => {
    const action = btn.getAttribute("data-action");
    if (!action) return;
    setEditing(action);
  });
});

// Capture the next key press when editing
window.addEventListener("keydown", (e) => {
  if (!editingAction) return;

  // ESC cancels edit
  if (e.key === "Escape") {
    e.preventDefault();
    setEditing(null);
    return;
  }

  // Ignore modifier combos
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const pressed = String(e.key || "").toLowerCase();

  // Ignore pure modifiers
  if (pressed === "shift" || pressed === "control" || pressed === "alt" || pressed === "meta") return;

  // Don’t allow binding to a key already used
  const alreadyUsedBy = Object.entries(keybinds).find(([act, k]) => act !== editingAction && k === pressed);
  if (alreadyUsedBy) {
    e.preventDefault();
    // keep editing active; do nothing
    return;
  }

  e.preventDefault();

  keybinds[editingAction] = pressed;
  renderKeybindsUi();
  saveKeybinds();
  setEditing(null);
}, true);

// Layout
["cols", "rows", "ratio"].forEach(id => {
  on(id, "change", () => {
    applyLayout();
    updateTileHeight();
    updateSafeArea();
  });
});

// Zen bar buttons
on("zRew30", "click", () => { skipAll(-30); showBarNow(); });
on("zRew5", "click", () => { skipAll(-5); showBarNow(); });
on("zPlayPause", "click", () => { togglePlayPauseAll(); showBarNow(); });
on("zFwd5", "click", () => { skipAll(+5); showBarNow(); });
on("zFwd30", "click", () => { skipAll(+30); showBarNow(); });
on("zSync", "click", () => { syncNow(); showBarNow(); });

on("zSpeed", "change", () => {
  const z = el("zSpeed");
  const top = el("speedSelect");
  if (z && top) {
    top.value = z.value;
    top.dispatchEvent(new Event("change"));
  }
  showBarNow();
});

on("zSettings", "click", () => {
  // Exit focus modes if active before showing settings
  if (document.body.classList.contains("focusLayout")) {
    exitFocusLayout();
  }
  // Also exit focus select mode
  if (focusMode) {
    focusMode = false;
    document.body.classList.remove("focusSelectMode");
  }
  // Also exit mute select mode
  if (muteSelectMode) {
    muteSelectMode = false;
    document.body.classList.remove("muteSelectMode");
  }
  toggleZenMode();
});

function hideZenHover() {
  lastZenHoverV = null;
  const tip = el("zenHoverTime");
  if (!tip) return;
  tip.classList.remove("show");
}

function updateZenHoverFromMouseEvent(e) {
  const zb = el("zenSeek");
  const wrap = el("zenSeekWrap");
  const tip = el("zenHoverTime");
  if (!zb || !wrap || !tip) return;

  const dGlobal = getMaxGlobalEnd();
  if (!Number.isFinite(dGlobal) || dGlobal <= 0) {
    lastZenHoverV = null;
    hideZenHover();
    return;
  }

  // IMPORTANT: compute the same value the range would end up with on click
  const rect = zb.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const pct = rect.width > 0 ? Math.max(0, Math.min(1, x / rect.width)) : 0;

  const min = Number.isFinite(+zb.min) ? +zb.min : 0;
  const max = Number.isFinite(+zb.max) ? +zb.max : 1000;
  const step = (zb.step && zb.step !== "any" && Number.isFinite(+zb.step) && +zb.step > 0) ? +zb.step : 1;

  const raw = min + pct * (max - min);
  let v = Math.round(raw / step) * step;
  v = Math.max(min, Math.min(max, v));
  lastZenHoverV = v;
  const g = (v / 1000) * dGlobal;
  tip.textContent = formatTime(g);
  tip.classList.add("show");

  // Position centered above cursor, clamped so it never goes off-screen
  const wrapRect = wrap.getBoundingClientRect();
  const cursorLeft = e.clientX - wrapRect.left;

  // measure after text set
  const tipW = tip.offsetWidth || 0;
  const half = tipW / 2;

  const clampedLeft = Math.max(half, Math.min(wrapRect.width - half, cursorLeft));
  tip.style.left = `${clampedLeft}px`;
}

// Zen timeline
on("zenSeek", "input", () => { isZenSeeking = true; showBarNow(); });
on("zenSeek", "mousemove", updateZenHoverFromMouseEvent);
on("zenSeek", "mousedown", updateZenHoverFromMouseEvent);
on("zenSeek", "mouseleave", hideZenHover);
on("zenSeek", "change", () => {
  const dGlobal = getMaxGlobalEnd();
  if (!Number.isFinite(dGlobal) || dGlobal <= 0) {
    isZenSeeking = false;
    return;
  }

  const zb = el("zenSeek");
  const v = (lastZenHoverV != null ? lastZenHoverV : +(zb?.value || 0));
  const g = (v / 1000) * dGlobal;

  const wasPlaying = anyPlaying();
  // Use a longer lockout (2000ms) to ensure Twitch players have time to seek without sync fighting back
  seekAllToGlobal(g, 2000);
  if (wasPlaying) setTimeout(() => playAll(2000), 80);
  else setTimeout(() => pauseAll(2000), 80);

  isZenSeeking = false;
  showBarNow();
});

// Keyboard + resize
window.addEventListener("keydown", e => {
  if (e.key === "Escape") toggleZenMode();
});
window.addEventListener("resize", () => {
  updateTileHeight();
  updateSafeArea();
});

// Kick off loops + init
applyLayout();
startDriftLoop();
startUiLoop();

// Initialize version label (and enables update checks)
initAppVersionUI();

// Layout option button handlers
on("layoutA", "click", () => {
  currentLayoutOption = 'A';
  updateLayoutOptionsUI(currentFilledVideoCount);
});
on("layoutB", "click", () => {
  currentLayoutOption = 'B';
  updateLayoutOptionsUI(currentFilledVideoCount);
});
on("layoutC", "click", () => {
  currentLayoutOption = 'C';
  updateLayoutOptionsUI(currentFilledVideoCount);
});

on("threshold", "change", () => {
  checkTwitchConstraints();
});
