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
let isLoadingScreenActive = false;

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
    A: [{ count: 1, centered: true }, { count: 2, centered: false }],
    B: [{ count: 2, centered: false }, { count: 1, centered: true }],
    C: [{ count: 3, centered: false }]
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
  if (!keybindsArmed || isLoadingScreenActive) return;
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
  playpause: " ",
  fwd5: "k",
  fwd30: "l",
  mute: "m",
  focus: "f",
  draw: "d"
};

let keybinds = loadKeybinds();
let showKeybindLegend = loadShowKeybindLegend();
let editingAction = null;

function loadShowKeybindLegend() {
  try {
    const raw = localStorage.getItem("vod_show_kbl");
    return raw !== "false"; // Default true
  } catch {
    return true;
  }
}

function saveShowKeybindLegend() {
  localStorage.setItem("vod_show_kbl", String(showKeybindLegend));
}

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
    if (n) {
      let v = String(val || "").toUpperCase();
      if (v === " " || v === "") v = "SPACE"; // also handle empty if needed, but per request " " -> "SPACE"
      if (v.trim() === "" && v.length > 0) v = "SPACE"; // catch-all for whitespace-only if not empty
      n.textContent = v;
    }
  };
  set("kb_key_rew30", keybinds.rew30);
  set("kb_key_rew5", keybinds.rew5);
  set("kb_key_playpause", keybinds.playpause);
  set("kb_key_fwd5", keybinds.fwd5);
  set("kb_key_fwd30", keybinds.fwd30);
  set("kb_key_mute", keybinds.mute);
  set("kb_key_focus", keybinds.focus);
  set("kb_key_draw", keybinds.draw);

  updateKeybindLegend();
}


function updateKeybindLegend() {
  const legend = document.getElementById("keybindLegend");
  if (!legend) return;

  const items = [
    { key: keybinds.rew30, label: "-30s", action: "rew30" },
    { key: keybinds.rew5, label: "-5s", action: "rew5" },
    { key: keybinds.playpause, label: "Play/Pause", action: "playpause" },
    { key: keybinds.fwd5, label: "+5s", action: "fwd5" },
    { key: keybinds.fwd30, label: "+30s", action: "fwd30" },
    { key: keybinds.mute, label: "Mute", action: "mute" },
    { key: keybinds.focus, label: "Focus", action: "focus" },
    { key: keybinds.draw, label: "Draw", action: "draw" }
  ];

  const legendHtml = items.map(item => {
    let k = String(item.key || "").toUpperCase();
    if (k === " ") k = "SPACE";
    if (k === "") k = "UNBOUND";
    // Add clickable class for feedback
    return `<div class="kblItem clickable" data-action="${item.action}"><span class="kblKey">${k}</span> ${item.label}</div>`;
  }).join("");

  legend.innerHTML = legendHtml;

  // Add click handlers
  legend.querySelectorAll(".kblItem").forEach(item => {
    item.addEventListener("click", () => {
      const action = item.getAttribute("data-action");
      if (action) triggerAction(action);
    });
  });

  // Only show if setting is true; logic for "zen mode only" is handled by CSS (body.zen)
  // But if showKeybindLegend is false, we want it hidden even in zen mode.
  // The CSS says: #keybindLegend { display: none; } ... body.zen #keybindLegend { display: flex; }
  // We need to override that if showKeybindLegend is false.
  if (!showKeybindLegend) {
    legend.style.setProperty("display", "none", "important");
    document.body.classList.add("keybind-legend-hidden");
  } else {
    legend.style.removeProperty("display");
    document.body.classList.remove("keybind-legend-hidden");
    // Let CSS handle the rest (flex in .zen, none otherwise)
  }
}

function updateKeybindLegendToggleUI() {
  const v = el("keybindLegendValue");
  if (v) v.textContent = showKeybindLegend ? "On" : "Off";
  updateKeybindLegend();
}

function cycleKeybindLegend() {
  showKeybindLegend = !showKeybindLegend;
  saveShowKeybindLegend();
  updateKeybindLegendToggleUI();
}

function setEditing(actionOrNull) {
  editingAction = actionOrNull;

  document.querySelectorAll(".kbRow").forEach(r => {
    const action = r.getAttribute("data-action");
    const isEditing = action === editingAction;
    r.classList.toggle("editing", isEditing);

    // Update button icon
    const btn = r.querySelector(".kbEdit");
    if (btn) {
      if (isEditing) {
        // X icon (Cancel)
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        btn.title = "Cancel";
      } else {
        // Pencil icon (Edit)
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
        btn.title = "Edit";
      }
    }
  });
}

// Electron helpers (nodeIntegration is enabled)
const { ipcRenderer, shell } = require("electron");

// Reusable action trigger (for keybinds AND legend clicks)
function triggerAction(action) {
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
}

// Custom keybinds forwarded from main process (works even when YouTube iframe has focus)
ipcRenderer.on("app:customKeybind", (_evt, action) => {
  if (!keybindsArmed || isLoadingScreenActive) return;

  // Don’t trigger shortcuts while typing in inputs
  if (isTypingTarget(document.activeElement)) return;

  triggerAction(action);
});


let currentAppVersion = null;


const el = id => document.getElementById(id);

function on(id, event, handler) {
  const node = el(id);
  if (!node) return;
  node.addEventListener(event, handler);
}

// Bind Keybind Legend toggle
on("keybindLegendLeft", "click", cycleKeybindLegend);
on("keybindLegendRight", "click", cycleKeybindLegend);

// Help Tooltip Logic
const showTooltip = (icon) => {
  const tip = document.getElementById("customTooltip");
  if (!tip || !icon) return;

  const text = icon.getAttribute("data-help-text");
  if (!text) return;

  tip.textContent = text;
  tip.classList.add("show");
  tip._lastIcon = icon;

  // Position it
  const rect = icon.getBoundingClientRect();
  // Position below the icon, centered if possible
  let top = rect.bottom + 8;
  let left = rect.left + (rect.width / 2) - 100; // Center guess

  // Simple clamp (assuming usage in the modal mostly)
  if (left < 10) left = 10;

  // Check if it goes off right edge
  const tipWidth = 200; // approx max width
  if (left + tipWidth > window.innerWidth - 10) {
    left = window.innerWidth - tipWidth - 10;
  }

  tip.style.top = top + "px";
  tip.style.left = left + "px";
};

const hideTooltip = () => {
  const tip = document.getElementById("customTooltip");
  if (tip) {
    tip.classList.remove("show");
    tip._lastIcon = null;
  }
};

document.addEventListener("click", (e) => {
  const icon = e.target.closest(".help-icon");
  if (icon) {
    e.stopPropagation();
    const tip = document.getElementById("customTooltip");
    // If clicking same active icon, toggle off
    if (tip?.classList.contains("show") && tip._lastIcon === icon) {
      hideTooltip();
    } else {
      showTooltip(icon);
    }
  } else {
    // Clicked elsewhere
    hideTooltip();
  }
});

document.addEventListener("mouseover", (e) => {
  const icon = e.target.closest(".help-icon");
  if (icon) {
    showTooltip(icon);
  }
});

document.addEventListener("mouseout", (e) => {
  const icon = e.target.closest(".help-icon");
  if (icon) {
    // Only hide if we are currently showing THIS icon
    const tip = document.getElementById("customTooltip");
    if (tip && tip._lastIcon === icon) {
      hideTooltip();
    }
  }
});

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

  // Exclude failed players
  if (failedPlayerIndices.has(i)) return false;

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

function playAll(lockoutMs = 450, forceTime = null) {
  const gCur = (forceTime !== null) ? forceTime : getMedianGlobalTime();
  broadcast(p => safe(() => p.playVideo()), lockoutMs, gCur);
}

function pauseAll(lockoutMs = 450) {
  broadcast(p => safe(() => p.pauseVideo()), lockoutMs, null);
}

function anyPlaying() {
  for (let i = 0; i < players.length; i++) {
    if (failedPlayerIndices.has(i)) continue;
    const p = players[i];
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
  if (popupState.isOpen && !muteSelectMode) return;
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
  if (popupState.isOpen && !focusMode) return;
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
  { name: "white", hex: "#ffffff" },
  { name: "red", hex: "#ff0000" },
  { name: "orange", hex: "#ff7f00" },
  { name: "yellow", hex: "#ffFF00" },
  { name: "green", hex: "#00ff00" },
  { name: "blue", hex: "#0000ff" },
  { name: "indigo", hex: "#4b0082" },
  { name: "violet", hex: "#9400d3" }
];

let currentDrawTool = "pencil"; // "pencil" | "arrow" | "circle"
let dragStart = { x: 0, y: 0 };
let imageSnapshot = null;

function createDrawCanvas() {
  if (drawCanvas) return;

  const grid = el("grid");
  if (!grid) return;

  const isZen = document.body.classList.contains("zen");
  const showKeybinds = (typeof showKeybindLegend !== 'undefined') ? showKeybindLegend : true;
  const topOffset = (isZen && showKeybinds) ? 27 : 0;

  drawCanvas = document.createElement("canvas");
  drawCanvas.id = "drawCanvas";
  drawCanvas.style.cssText = `
    position: fixed;
    top: ${topOffset}px;
    left: 0;
    width: 100vw;
    height: calc(100vh - ${topOffset}px);
    z-index: 1000;
    cursor: crosshair;
    pointer-events: auto;
  `;
  document.body.appendChild(drawCanvas);

  drawCanvas.width = drawCanvas.clientWidth;
  drawCanvas.height = drawCanvas.clientHeight;

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
  drawCanvas.width = drawCanvas.clientWidth;
  drawCanvas.height = drawCanvas.clientHeight;
  drawCtx.putImageData(imageData, 0, 0);
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  drawCtx.lineWidth = 4;
  drawCtx.strokeStyle = drawColor;
}

function startDrawing(e) {
  isDrawing = true;
  lastX = e.offsetX;
  lastY = e.offsetY;

  if (currentDrawTool === "arrow" || currentDrawTool === "circle") {
    dragStart = { x: e.offsetX, y: e.offsetY };
    if (drawCtx && drawCanvas) {
      imageSnapshot = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
    }
  }
}

function draw(e) {
  if (!isDrawing) return;

  if (currentDrawTool === "pencil") {
    drawCtx.beginPath();
    drawCtx.moveTo(lastX, lastY);
    drawCtx.lineTo(e.offsetX, e.offsetY);
    drawCtx.stroke();
    lastX = e.offsetX;
    lastY = e.offsetY;
  } else if (currentDrawTool === "arrow") {
    // Restore snapshot to clear previous frame of arrow preview
    if (imageSnapshot) {
      drawCtx.putImageData(imageSnapshot, 0, 0);
    }
    drawArrow(drawCtx, dragStart.x, dragStart.y, e.offsetX, e.offsetY);
  } else if (currentDrawTool === "circle") {
    if (imageSnapshot) {
      drawCtx.putImageData(imageSnapshot, 0, 0);
    }
    drawCircle(drawCtx, dragStart.x, dragStart.y, e.offsetX, e.offsetY);
  }
}

function drawArrow(ctx, fromX, fromY, toX, toY) {
  const headLength = 20; // length of head in pixels
  const dx = toX - fromX;
  const dy = toY - fromY;
  const angle = Math.atan2(dy, dx);

  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  // Arrow head
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLength * Math.cos(angle - Math.PI / 6), toY - headLength * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLength * Math.cos(angle + Math.PI / 6), toY - headLength * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function drawCircle(ctx, x1, y1, x2, y2) {
  if (circleDrawMode === "grow") {
    // "Drag to Grow": Center is start point, Radius is distance to current point
    const r = Math.hypot(x2 - x1, y2 - y1);
    ctx.beginPath();
    ctx.arc(x1, y1, r, 0, 2 * Math.PI);
    ctx.stroke();
  } else {
    // "Drag to Corner" (Default): Square bounding box
    const dx = x2 - x1;
    const dy = y2 - y1;
    const size = Math.max(Math.abs(dx), Math.abs(dy));

    // Calculate center and radius for a circle inscribed in the square
    const endX = x1 + (dx >= 0 ? size : -size);
    const endY = y1 + (dy >= 0 ? size : -size);

    const centerX = (x1 + endX) / 2;
    const centerY = (y1 + endY) / 2;
    const radius = size / 2;

    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
    ctx.stroke();
  }
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

  // Apply Default Draw Tool Setting
  if (typeof defaultDrawToolSetting !== 'undefined' && defaultDrawToolSetting !== "last") {
    currentDrawTool = defaultDrawToolSetting;
  }

  /* Adjust top calculation based on Keybind Hints visibility */
  const topPos = showKeybindLegend ? "30px" : "3px";

  const bar = document.createElement("div");
  bar.id = "drawColorBar";
  bar.style.cssText = `
    position: fixed;
    top: ${topPos};
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

  // --- Pencil Tool (Draw) ---
  const pencilBtn = document.createElement("button");
  pencilBtn.id = "drawToolPencil";
  pencilBtn.className = "drawBarBtn";
  pencilBtn.title = "Draw Tool";
  pencilBtn.style.cssText = `
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: #333;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.1s, background 0.1s;
  `;
  pencilBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;

  // --- Arrow Tool (Draw) ---
  const arrowBtn = document.createElement("button");
  arrowBtn.id = "drawToolArrow";
  arrowBtn.className = "drawBarBtn";
  arrowBtn.title = "Arrow Tool";
  arrowBtn.style.cssText = `
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: #333;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.1s, background 0.1s;
  `;
  arrowBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="19" x2="19" y2="5"></line><polyline points="12 5 19 5 19 12"></polyline></svg>`;

  // --- Circle Tool (Draw) ---
  const circleBtn = document.createElement("button");
  circleBtn.id = "drawToolCircle";
  circleBtn.className = "drawBarBtn";
  circleBtn.title = "Circle Tool";
  circleBtn.style.cssText = `
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: #333;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.1s, background 0.1s;
  `;
  circleBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle></svg>`;

  const updateToolActiveState = () => {
    // If interacting, no draw tools active
    const isInteract = document.body.classList.contains("drawMouseActive");

    // Interact Button
    const mouseBtn = document.getElementById("drawToolMouse");
    if (mouseBtn) {
      if (isInteract) {
        mouseBtn.style.border = "2px solid #fff";
        mouseBtn.style.background = "#555";
      } else {
        mouseBtn.style.border = "none";
        mouseBtn.style.background = "#333";
      }
    }

    // Pencil Button
    if (!isInteract && currentDrawTool === "pencil") {
      pencilBtn.style.border = "2px solid #fff";
      pencilBtn.style.background = "#555";
    } else {
      pencilBtn.style.border = "none";
      pencilBtn.style.background = "#333";
    }

    // Arrow Button
    if (!isInteract && currentDrawTool === "arrow") {
      arrowBtn.style.border = "2px solid #fff";
      arrowBtn.style.background = "#555";
    } else {
      arrowBtn.style.border = "none";
      arrowBtn.style.background = "#333";
    }

    // Circle Button
    if (!isInteract && currentDrawTool === "circle") {
      circleBtn.style.border = "2px solid #fff";
      circleBtn.style.background = "#555";
    } else {
      circleBtn.style.border = "none";
      circleBtn.style.background = "#333";
    }
  };

  pencilBtn.addEventListener("click", () => {
    if (drawCanvas) {
      drawCanvas.style.pointerEvents = "auto";
      drawCanvas.style.cursor = "crosshair";
    }
    document.body.classList.remove("drawMouseActive");
    currentDrawTool = "pencil";

    updateToolActiveState();

    // Re-highlight the active color
    document.querySelectorAll(".drawColorBtn").forEach(b => {
      b.style.borderColor = b.dataset.color === drawColor ? "#fff" : "transparent";
    });
  });

  arrowBtn.addEventListener("click", () => {
    if (drawCanvas) {
      drawCanvas.style.pointerEvents = "auto";
      drawCanvas.style.cursor = "crosshair";
    }
    document.body.classList.remove("drawMouseActive");
    currentDrawTool = "arrow";

    updateToolActiveState();

    // Re-highlight the active color
    document.querySelectorAll(".drawColorBtn").forEach(b => {
      b.style.borderColor = b.dataset.color === drawColor ? "#fff" : "transparent";
    });
  });

  circleBtn.addEventListener("click", () => {
    if (drawCanvas) {
      drawCanvas.style.pointerEvents = "auto";
      drawCanvas.style.cursor = "crosshair";
    }
    document.body.classList.remove("drawMouseActive");
    currentDrawTool = "circle";

    updateToolActiveState();

    // Re-highlight the active color
    document.querySelectorAll(".drawColorBtn").forEach(b => {
      b.style.borderColor = b.dataset.color === drawColor ? "#fff" : "transparent";
    });
  });

  pencilBtn.addEventListener("mouseenter", () => {
    if (pencilBtn.style.border === "none") {
      pencilBtn.style.transform = "scale(1.15)";
    }
  });
  pencilBtn.addEventListener("mouseleave", () => { pencilBtn.style.transform = "scale(1)"; });

  arrowBtn.addEventListener("mouseenter", () => {
    if (arrowBtn.style.border === "none") {
      arrowBtn.style.transform = "scale(1.15)";
    }
  });
  arrowBtn.addEventListener("mouseleave", () => { arrowBtn.style.transform = "scale(1)"; });

  circleBtn.addEventListener("mouseenter", () => {
    if (circleBtn.style.border === "none") {
      circleBtn.style.transform = "scale(1.15)";
    }
  });
  circleBtn.addEventListener("mouseleave", () => { circleBtn.style.transform = "scale(1)"; });

  bar.appendChild(pencilBtn);
  bar.appendChild(arrowBtn);
  bar.appendChild(circleBtn);

  DRAW_COLORS.forEach(color => {
    const btn = document.createElement("button");
    btn.className = "drawColorBtn drawBarBtn";
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
      if (drawCtx) {
        drawCtx.strokeStyle = drawColor;
      }
      // Re-enable pointer events on canvas
      if (drawCanvas) {
        drawCanvas.style.pointerEvents = "auto";
        drawCanvas.style.cursor = "crosshair";
      }

      document.querySelectorAll(".drawColorBtn").forEach(b => {
        b.style.borderColor = b.dataset.color === drawColor ? "#fff" : "transparent";
      });
      // Selecting a color activates drawing mode, default to existing tool or pencil?
      document.body.classList.remove("drawMouseActive");

      // Keep current tool if it was already selected, otherwise default to pencil if coming from Interact?
      // Actually, variable persists, so we just stick with currentDrawTool.
      updateToolActiveState();
    });

    btn.addEventListener("mouseenter", () => { btn.style.transform = "scale(1.15)"; });
    btn.addEventListener("mouseleave", () => { btn.style.transform = "scale(1)"; });

    bar.appendChild(btn);
  });

  // Set initial state
  setTimeout(() => updateToolActiveState(), 0);

  // --- Mouse Tool (Interact) ---
  const mouseBtn = document.createElement("button");
  mouseBtn.id = "drawToolMouse";
  mouseBtn.className = "drawBarBtn";
  mouseBtn.title = "Interact";
  mouseBtn.style.cssText = `
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: #333;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.1s, background 0.1s;
  `;
  // Simple mouse pointer icon
  mouseBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="white"><path d="M7 2l12 11.2-5.8.5 3.3 7.3-2.2.9-3.2-7.4-4.4 4V2z"/></svg>`;

  mouseBtn.addEventListener("click", () => {
    // Disable pointer events on canvas so clicks pass through
    if (drawCanvas) {
      drawCanvas.style.pointerEvents = "none";
      drawCanvas.style.cursor = "default";
    }
    // Visual feedback: clear color selections
    document.querySelectorAll(".drawColorBtn").forEach(b => {
      b.style.borderColor = "transparent";
    });

    document.body.classList.add("drawMouseActive"); // <--- ADD CLASS
    updateToolActiveState();
  });

  mouseBtn.addEventListener("mouseenter", () => {
    // Only hover effect if not active? or always. active state usually managed by click
    if (mouseBtn.style.border !== "2px solid rgb(255, 255, 255)") { // naive check
      mouseBtn.style.transform = "scale(1.15)";
    }
  });
  mouseBtn.addEventListener("mouseleave", () => {
    mouseBtn.style.transform = "scale(1)";
  });

  bar.appendChild(mouseBtn);


  // Helper to create action buttons
  const makeActionBtn = (title, iconPath, onClick) => {
    const btn = document.createElement("button");
    btn.className = "drawBarBtn";
    btn.title = title;
    btn.style.cssText = `
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: none;
      background: #333;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.1s, background 0.1s;
    `;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="white"><path d="${iconPath}"/></svg>`;

    btn.addEventListener("click", onClick);
    btn.addEventListener("mouseenter", () => {
      btn.style.transform = "scale(1.15)";
      btn.style.background = "#555";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.transform = "scale(1)";
      btn.style.background = "#333";
    });

    bar.appendChild(btn);
  };

  // Undo Button
  makeActionBtn("Undo", "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z", undoDraw);

  // Redo Button
  makeActionBtn("Redo", "M18.4 10.6C16.55 9 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z", redoDraw);

  // Clear All Button - Trash can icon
  const clearDraw = () => {
    if (!drawCanvas || !drawCtx) return;
    drawHistory.push(drawCanvas.toDataURL());
    redoHistory = [];
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  };
  makeActionBtn("Clear", "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z", clearDraw);

  document.body.appendChild(bar);
}

function removeColorSelector() {
  const bar = el("drawColorBar");
  if (bar) bar.remove();
}

function toggleDrawMode() {
  if (popupState.isOpen && !drawMode) return;
  drawMode = !drawMode;
  document.body.classList.toggle("drawMode", drawMode);
  document.body.classList.remove("drawMouseActive"); // <--- RESET ON TOGGLE

  if (drawMode) {
    if (pauseOnDraw) {
      pauseAll(100);
    }

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
    if (!driftEnabled) return;

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

  // Handle explicit visibility changes from loadVideos/exitToVideoLoader
  if (!onMode) {
    // Exiting Zen = Showing Input/Controls
    // We must revert the inline 'display: none' hacks we added
    const setup = document.querySelector(".setupPane");
    if (setup) setup.style.display = ""; // Remove inline, let CSS handle it

    const topbar = document.querySelector(".topbar");
    if (topbar) topbar.style.display = ""; // Remove inline, let CSS handle it

    // Grid: If we are exiting Zen, do we hide Grid? 
    // Usually "Zen Mode" off means we see the setup pane above the grid?
    // Or does it mean we see the top bar + setup pane AND the grid?
    // If we clear the inline styles, CSS default for .setupPane is block.
    // CSS default for .grid depends.
    // Let's just trust that clearing 'display: none' allows the CSS to work as before.
  }

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

let lastTwitchState = null;

async function checkTwitchConstraints(force = false) {
  const list = el("videoList");
  if (!list) return;

  if (!driftEnabled) return; // Skip if drift is disabled

  // Check if any visible video input contains a Twitch URL
  const inputs = Array.from(list.querySelectorAll(".videoUrl"));
  const hasTwitch = inputs.some(input => !!extractTwitchId(input.value));

  const tInput = el("threshold");
  if (!tInput) return;

  // Manual Check: If user is typing in the box (not a forced context switch)
  if (!force && hasTwitch === lastTwitchState) {
    const val = parseFloat(tInput.value);

    // Enforce minima
    if (hasTwitch) {
      tInput.min = "1.0";
      if (Number.isFinite(val) && val < 1.0) {
        tInput.value = "1.0";
        setStatus("Minimum drift required with Twitch is 1.0 sec", true, 3000);
      }
    } else {
      tInput.min = "0.1";
      if (Number.isFinite(val) && val < 0.1) {
        tInput.value = "0.1";
        setStatus("Minimum drift tolerance is 0.1 sec", true, 3000);
      }
    }
    return;
  }

  // FORCE / CONTEXT SWITCH: Apply Defaults
  let targetVal;
  if (hasTwitch) {
    targetVal = await ipcRenderer.invoke("drift:getTwitch");
    if (!targetVal) targetVal = 1.5;
    tInput.min = "1.0";
  } else {
    targetVal = await ipcRenderer.invoke("drift:getStandard");
    if (!targetVal) targetVal = 0.25;
    tInput.min = "0.1";
  }

  tInput.value = targetVal;
  lastTwitchState = hasTwitch;
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

  /* REMOVED video title block
  const title = document.createElement("div");
  title.className = "videoTitle";
  title.textContent = `Video ${idx + 1}`;
  block.appendChild(title);
  */

  const row = document.createElement("div");
  row.className = "videoRow";

  // URL / ID input
  const urlGroup = document.createElement("div");
  urlGroup.className = "inputGroup";

  const urlLabel = document.createElement("div");
  urlLabel.className = "fieldLabel";
  urlLabel.textContent = `Video ${idx + 1}`;
  urlGroup.appendChild(urlLabel);

  const url = document.createElement("input");
  url.type = "text";
  url.className = "videoUrl";
  url.placeholder = "YouTube, Twitch VOD, or File";
  url.autocomplete = "off";
  urlGroup.appendChild(url);
  row.appendChild(urlGroup);

  // browse button + hidden file input
  const browseBtn = document.createElement("button");
  browseBtn.type = "button";
  browseBtn.className = "browseBtn";
  browseBtn.textContent = "Browse";

  const file = document.createElement("input");
  file.type = "file";
  file.accept = ""; // Allow all files
  file.className = "videoFile";
  file.style.display = "none";

  browseBtn.addEventListener("click", () => file.click());
  row.appendChild(browseBtn);
  row.appendChild(file);

  // Start time
  const stGroup = document.createElement("div");
  stGroup.className = "inputGroup";

  const stLabel = document.createElement("div");
  stLabel.className = "fieldLabel";
  stLabel.textContent = "Start Time";
  stGroup.appendChild(stLabel);

  const stContainer = document.createElement("div");
  stContainer.className = "startTimeContainer";

  const makeTimeInput = (cls, placeholder) => {
    const inp = document.createElement("input");
    inp.type = "text"; // Use text to avoid spinner weirdness, but we can enforce numbers if needed
    inp.inputMode = "numeric";
    inp.maxLength = 2; // Limit to 2 chars
    inp.className = cls + " startTimeBox";
    inp.placeholder = placeholder;
    inp.autocomplete = "off";

    // Enforce integers only
    inp.addEventListener("input", () => {
      // Remove non-digits
      let val = inp.value.replace(/\D/g, "");
      // Limit to 2 digits (just in case)
      if (val.length > 2) val = val.slice(0, 2);
      if (val !== inp.value) inp.value = val;
    });

    return inp;
  };

  const stH = makeTimeInput("startTimeH", "hh");
  const stM = makeTimeInput("startTimeM", "mm");
  const stS = makeTimeInput("startTimeS", "ss");

  const sep1 = document.createElement("span");
  sep1.className = "startTimeSep";
  sep1.textContent = ":";

  const sep2 = document.createElement("span");
  sep2.className = "startTimeSep";
  sep2.textContent = ":";

  stContainer.appendChild(stH);
  stContainer.appendChild(sep1);
  stContainer.appendChild(stM);
  stContainer.appendChild(sep2);
  stContainer.appendChild(stS);

  stGroup.appendChild(stContainer);
  row.appendChild(stGroup);

  // Video Name
  const vnGroup = document.createElement("div");
  vnGroup.className = "inputGroup";

  /* REMOVED Video Name label per user request
  const vnLabel = document.createElement("div");
  vnLabel.className = "fieldLabel";
  vnLabel.textContent = "Video Name";
  vnGroup.appendChild(vnLabel);
  */

  const vn = document.createElement("input");
  vn.type = "text";
  vn.className = "videoNameInput";
  vn.placeholder = "Video Name";
  vn.autocomplete = "off";
  vnGroup.appendChild(vn);
  row.appendChild(vnGroup);

  block.appendChild(row);

  // Events: if user types in the box (or clears it), clear any selected file
  url.addEventListener("input", () => {
    // Always clear the file input if the user is modifying the text manually
    try { file.value = ""; } catch { }
    block.dataset.hasFile = "0";

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

  stH.addEventListener("input", () => {
    if (stH.value.length >= 2) stM.focus();
    maybeAddNextRow();
  });
  stM.addEventListener("input", () => {
    if (stM.value.length >= 2) stS.focus();
    maybeAddNextRow();
  });

  // Backspace navigation
  const handleBackspace = (current, prev) => (e) => {
    if (e.key === "Backspace" && current.value === "") {
      e.preventDefault();
      prev.focus();
      if (prev.value.length > 0) {
        prev.value = prev.value.slice(0, -1);
        maybeAddNextRow(); // Trigger update since we modified a value
      }
    }
  };

  stM.addEventListener("keydown", handleBackspace(stM, stH));
  stS.addEventListener("keydown", handleBackspace(stS, stM));

  stS.addEventListener("input", () => maybeAddNextRow());

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

const compactVideoRows = () => {
  const list = el("videoList");
  if (!list) return;

  const blocks = Array.from(list.querySelectorAll(".videoBlock"));
  const filled = [];
  const empty = [];

  // Separate filled and empty blocks
  blocks.forEach(block => {
    if (rowIsFilled(block)) filled.push(block);
    else empty.push(block);
  });

  // Map original indices to detect movement
  const oldIndexMap = new Map();
  blocks.forEach((b, i) => oldIndexMap.set(b, i));

  // Reorder DOM: all filled first, then all empty
  // Check if order is already correct to avoid unnecessary DOM thrashing and focus loss
  const sortedBlocks = [...filled, ...empty];
  let orderChanged = false;
  if (blocks.length === sortedBlocks.length) {
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i] !== sortedBlocks[i]) {
        orderChanged = true;
        break;
      }
    }
  } else {
    orderChanged = true;
  }

  if (orderChanged) {
    filled.forEach(b => list.appendChild(b));
    // For empty blocks that are being moved 'down' (to a higher index), clear their data
    // This solves the bug where deleting Row 1 moves Row 1's metadata to the 'new' Row 2 (which is physically the old Row 0)
    empty.forEach((b, i) => {
      list.appendChild(b);
      // Calculate new index for this empty block
      const newIndex = filled.length + i;
      const oldIndex = oldIndexMap.get(b);

      if (newIndex > oldIndex) {
        // Row moved down (was a gap) -> Clear metadata
        const stH = b.querySelector(".startTimeH");
        const stM = b.querySelector(".startTimeM");
        const stS = b.querySelector(".startTimeS");
        const vn = b.querySelector(".videoNameInput");
        if (stH) stH.value = "";
        if (stM) stM.value = "";
        if (stS) stS.value = "";
        if (vn) vn.value = "";

        // Also ensure URL/File are clean (though they should be empty to be here)
        const u = b.querySelector(".videoUrl");
        const f = b.querySelector(".videoFile");
        if (u) u.value = "";
        if (f) f.value = "";
        b.dataset.hasFile = "0";
      }
    });
  }

  // Update indices and labels
  const allBlocks = [...filled, ...empty];
  allBlocks.forEach((block, index) => {
    block.dataset.idx = String(index);
    const title = block.querySelector(".videoTitle");
    if (title) title.textContent = `Video ${index + 1}`;

    // Also update the first field label which contains "Video X"
    const label = block.querySelector(".fieldLabel");
    if (label) label.textContent = `Video ${index + 1}`;
  });
};

async function maybeAddNextRow() {
  const list = el("videoList");
  if (!list) return;

  // First, compact any gaps (e.g. if Video 1 was deleted but Video 2 exists)
  compactVideoRows();

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
    // Load preference instead of resetting to 'A'
    const prefs = await ipcRenderer.invoke("layout:getPreferences");
    currentLayoutOption = prefs[filledCount] || 'A';
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
    const stH = block.querySelector(".startTimeH");
    const stM = block.querySelector(".startTimeM");
    const stS = block.querySelector(".startTimeS");
    const vnEl = block.querySelector(".videoNameInput");

    const f = fileEl?.files?.[0] || null;
    const rawUrl = (urlEl?.value || "").trim();

    const h = parseInt(stH?.value || "0", 10) || 0;
    const m = parseInt(stM?.value || "0", 10) || 0;
    const s = parseInt(stS?.value || "0", 10) || 0;
    const startAt = (h * 3600) + (m * 60) + s;

    const name = (vnEl?.value || "").trim();

    if (f) {
      sources.push({ type: "file", file: f, startAt, name });
    } else if (rawUrl) {
      // Check Twitch first (more distinctive URL pattern)
      const twitchId = extractTwitchId(rawUrl);
      if (twitchId) {
        sources.push({ type: "twitch", videoId: twitchId, startAt, name });
      } else if (rawUrl.includes("twitch.tv")) {
        // Found a Twitch URL but couldn't extract a valid VOD/Clip ID -> Bad
        sources.push({ type: "bad", raw: rawUrl, startAt, name, inputElement: urlEl });
      } else {
        // Fall back to YouTube
        const id = extractId(rawUrl);
        if (id) sources.push({ type: "yt", id, startAt, name });
        else sources.push({ type: "bad", raw: rawUrl, startAt, name, inputElement: urlEl });
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

function validateStartTimes() {
  const list = el("videoList");
  const blocks = Array.from(list?.querySelectorAll(".videoBlock") || []);
  let allValid = true;

  for (const block of blocks) {
    const stContainer = block.querySelector(".startTimeContainer");
    const stH = block.querySelector(".startTimeH");
    const stM = block.querySelector(".startTimeM");
    const stS = block.querySelector(".startTimeS");

    if (stContainer) stContainer.classList.remove("error");

    const h = parseInt(stH?.value || "0", 10) || 0;
    const m = parseInt(stM?.value || "0", 10) || 0;
    const s = parseInt(stS?.value || "0", 10) || 0;

    // Check ranges: mm and ss must be < 60. hh is naturally limited by 2 digits (0-99).
    if (m > 59 || s > 59) {
      if (stContainer) stContainer.classList.add("error");
      allValid = false;
    }
  }

  return allValid;
}

async function loadVideos() {
  // Fetch audio on load setting
  const audioOnLoad = await ipcRenderer.invoke("audio:getOnLoad");

  failedPlayerIndices.clear();
  pendingUnavailableModal = false;

  // Clear any previous error highlights on URL inputs
  const list = el("videoList");
  const allInputs = list ? Array.from(list.querySelectorAll(".videoUrl")) : [];
  allInputs.forEach(inp => inp.classList.remove("error"));

  // Run validation checks
  const startTimesOk = validateStartTimes(); // Internal side-effect: adds .error class to start time inputs
  const sources = collectSourcesFromUI();
  const badSources = sources.filter(s => s.type === "bad");

  // Highlight bad URLs
  if (badSources.length > 0) {
    badSources.forEach(s => {
      if (s.inputElement) s.inputElement.classList.add("error");
    });
  }

  // If any validation failed, stop here
  if (!startTimesOk || badSources.length > 0) {
    if (!startTimesOk && badSources.length > 0) {
      setStatus("Please check start times and video links.", true);
    } else if (!startTimesOk) {
      setStatus("Please check start time.", true);
    } else {
      setStatus("One or more video links look invalid. Fix them and try again.", true);
    }
    return;
  }

  const realSources = sources.filter(s => s.type === "yt" || s.type === "file" || s.type === "twitch");



  if (realSources.some(s => s.type === "yt") && !apiReady) {
    setStatus("YouTube API not ready yet. Try again in a second.", true);
    return;
  }

  const totalCount = realSources.length;

  if (totalCount <= 0) {
    setStatus("Add at least one YouTube/Twitch link/ID or choose a local video file.", true);
    return;
  }

  // Show loading screen only on success
  // Show loading screen only on success
  const overlay = document.getElementById("loadingOverlay");

  // Switch to Grid View immediately
  const setup = document.querySelector(".setupPane");
  if (setup) setup.style.display = "none";

  if (el("grid")) {
    el("grid").style.display = ""; // Reset to default (visible)
  }

  // Ensure topbar is hidden in Grid View (unless Zen mode logic handles it differently, but user implies it shouldn't be there)
  // Based on user feedback, the "Video Loader UI" (Grid) should NOT have the Top Bar.
  const topbar = document.querySelector(".topbar");
  if (topbar) topbar.style.display = "none";

  const minDuration = 1500;

  // State for dynamic loading
  let loadingState = {
    readyCount: 0,
    totalCount: totalCount,
    minTimeDone: false,
    hasTwitch: realSources.some(s => s.type === "twitch"),
    twitchDelayDone: false,
    delayTimerStarted: false
  };

  const checkLoadingScreen = () => {
    if (loadingState.readyCount >= loadingState.totalCount && loadingState.minTimeDone) {
      // If we have Twitch videos, add an extra 1s delay
      if (loadingState.hasTwitch && !loadingState.twitchDelayDone) {
        if (!loadingState.delayTimerStarted) {
          loadingState.delayTimerStarted = true;
          setTimeout(() => {
            loadingState.twitchDelayDone = true;
            checkLoadingScreen(); // Re-check to close
          }, 1000);
        }
        return;
      }

      if (overlay) {
        overlay.style.display = "none";
        isLoadingScreenActive = false;

        // Show pending unavailable modal if any failed during loading
        if (pendingUnavailableModal) {
          openVideoUnavailableModal(null);
          pendingUnavailableModal = false;
        }
      }
    }
  };

  if (overlay) {
    overlay.style.display = "flex";
    isLoadingScreenActive = true;

    // Reset and apply animation (using minDuration for the fade-in speed)
    const icon = document.getElementById("loadingIcon");
    if (icon) {
      icon.style.animation = "none";
      void icon.offsetWidth; // trigger reflow
      // 1.5s in + 1.5s out = 3s total cycle
      icon.style.animation = `loadingPulse 3s linear infinite`;
    }

    // Start minimum timer
    setTimeout(() => {
      loadingState.minTimeDone = true;
      checkLoadingScreen();
    }, minDuration);
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

  // Conditionally hide speed control if Twitch is present (Twitch doesn't allow speed control)
  const zSpeed = el("zSpeed");
  if (zSpeed) {
    zSpeed.value = "1"; // Reset to 1x on new load
    const hasTwitch = realSources.some(s => s.type === "twitch");
    zSpeed.style.display = hasTwitch ? "none" : "";
  }

  // Get layout configuration for this video count
  // First, check if we have a persistent preference for this video count
  const layoutPrefs = await ipcRenderer.invoke("layout:getPreferences");
  const preferredOption = layoutPrefs[totalCount] || 'A';
  currentLayoutOption = preferredOption;

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

    // Set initial volume based on audioOnLoad setting
    // i is the card index (0-based), so i === 0 means primary video
    let initialVolume = 0; // default mute-all
    if (audioOnLoad === "unmute-all") {
      initialVolume = 50;
    } else if (audioOnLoad === "primary-only" && i === 0) {
      initialVolume = 50;
    }
    range.value = initialVolume;

    const updateSliderFill = (input) => {
      const val = (input.value - input.min) / (input.max - input.min) * 100;
      input.style.background = `linear-gradient(to right, #eee ${val}%, #444 ${val}%)`;
    };
    updateSliderFill(range);

    // Update icon to match initial volume
    updateIcon(initialVolume);

    // Add muted class to card if volume is 0
    if (initialVolume === 0) {
      card.classList.add("muted");
    }

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

      // Block top bar interactions (Title, Share, Watch Later)
      // Block top bar interactions (Title, Share, Watch Later)
      const topBlocker = document.createElement("div");
      topBlocker.className = "ytTopBlocker";
      // Use default cursor (Normal Select) instead of pointer
      topBlocker.style.cssText = "position: absolute; top: 0; left: 0; width: 100%; height: 60px; z-index: 10; cursor: default;";

      const kill = e => { e.preventDefault(); e.stopPropagation(); };

      topBlocker.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = players[i];
        if (p) {
          try {
            const s = p.getPlayerState();
            // 1 = playing, 2 = paused/ended/unk
            if (s === 1) p.pauseVideo();
            else p.playVideo();
          } catch (err) { }
        }
      });

      ["dblclick", "mousedown", "mouseup", "contextmenu"].forEach(evt => topBlocker.addEventListener(evt, kill));
      wrap.appendChild(topBlocker);

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
          onError: (event) => {
            const code = event.data;
            // 101 or 150 = embed not allowed
            if (code === 101 || code === 150) {
              console.log(`[Player ${i}] Embed failed (code ${code})`);
              openVideoUnavailableModal(i);
            }
          },
          onStateChange: (event) => {
            const state = event.data;
            // 1=PLAYING, 2=PAUSED, 3=BUFFERING
            if (state === 1 || state === 2 || state === 3) {
              if (embedCheckTimers[i]) {
                clearTimeout(embedCheckTimers[i]);
                delete embedCheckTimers[i];
              }
              // If it was marked failed, unmark it
              if (failedPlayerIndices.has(i)) {
                failedPlayerIndices.delete(i);
                const card = document.querySelectorAll("#grid .card")[i];
                if (card) {
                  card.style.opacity = "1";
                  card.style.pointerEvents = "auto";
                }
              }
            }
          },
          onReady: () => {
            // Timeout removed: it was causing false positives on valid videos that start paused.
            // if (embedCheckTimers[i]) clearTimeout(embedCheckTimers[i]);
            // embedCheckTimers[i] = setTimeout(...)

            // Mark ready
            loadingState.readyCount++;
            checkLoadingScreen();

            setStatus(`Loaded ${totalCount} video(s).`, false);

            // Apply audio on load setting
            const card = cards[i];
            const shouldUnmute = audioOnLoad === "unmute-all" || (audioOnLoad === "primary-only" && i === 0);
            if (shouldUnmute) {
              yt.unMute();
              yt.setVolume(50);
              if (card) card.classList.remove("muted");
            } else {
              yt.mute();
              if (card) card.classList.add("muted");
            }

            // Only disable mouse interaction if controls are hidden
            // If controls are shown, we let the user interact (sync might be affected but that's expected)
            const frame = holder.querySelector("iframe");
            if (frame && !showControls) {
              frame.style.pointerEvents = "none";
            }

            // Apply initial start time if present, and ensure PAUSED state
            const localStart = Math.max(0, Number(src.startAt) || 0);
            if (localStart > 0) {
              try {
                yt.seekTo(localStart, true);
                if (typeof yt.pauseVideo === 'function') yt.pauseVideo();
              } catch { }
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

      players[i] = makeYtAdapter(yt);

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

      // Apply audio on load setting
      const shouldUnmuteTwitch = audioOnLoad === "unmute-all" || (audioOnLoad === "primary-only" && i === 0);

      const twitchPlayer = new Twitch.Player(holder.id, {
        width: "100%",
        height: "100%",
        video: src.videoId,
        parent: ["127.0.0.1"],
        autoplay: false,
        muted: !shouldUnmuteTwitch,
        controls: showControls
      });

      // Mark as muted based on setting
      const card = cards[i];
      if (card) {
        if (shouldUnmuteTwitch) {
          card.classList.remove("muted");
        } else {
          card.classList.add("muted");
        }
      }

      // Track if Twitch player is fully ready (to avoid spurious events during initialization)
      // We use both a local variable and set __ready on the adapter for anyPlaying() checks

      twitchPlayer.addEventListener(Twitch.Player.READY, () => {
        // Mark ready
        loadingState.readyCount++;
        checkLoadingScreen();

        setStatus(`Loaded ${totalCount} video(s).`, false);

        // Apply audio on load setting after player is ready
        // (constructor muted option may not always work due to browser policies)
        if (shouldUnmuteTwitch) {
          try {
            twitchPlayer.setMuted(false);
            twitchPlayer.setVolume(0.5); // 50%
          } catch { }
        } else {
          try {
            twitchPlayer.setMuted(true);
          } catch { }
        }

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

    // Apply audio on load setting for file player
    const shouldUnmuteFile = audioOnLoad === "unmute-all" || (audioOnLoad === "primary-only" && i === 0);
    v.muted = !shouldUnmuteFile;
    if (shouldUnmuteFile) {
      v.volume = 0.5; // 50%
    }

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

    // Muted state based on setting (visual state)
    const card = el("grid")?.children[i];
    if (card) {
      if (shouldUnmuteFile) {
        card.classList.remove("muted");
      } else {
        card.classList.add("muted");
      }
    }

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

    // Toggle play/pause on click
    v.addEventListener("click", () => {
      if (v.paused) v.play();
      else v.pause();
    });

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
      loadingState.readyCount++;
      checkLoadingScreen();

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
ipcRenderer.send("app:setKeybindsArmed", false);
initVideoSetupUI();
initDevMode();

// Initialize drift input validation (Moved from top to avoid el ref error)
const driftInput = el("threshold");
if (driftInput) {
  driftInput.addEventListener("change", () => {
    let val = parseFloat(driftInput.value);
    // Respect minima based on twitch state
    const min = driftInput.min ? parseFloat(driftInput.min) : 0;
    if (!Number.isFinite(val) || val < min) val = min;
    driftInput.value = val.toFixed(2);
  });
}

async function initDevMode() {
  try {
    const isDev = await ipcRenderer.invoke("app:isDev");
    if (isDev) {
      document.body.classList.add("dev-mode");
      // console.log("Dev mode enabled");
    }
  } catch (err) {
    console.error("Failed to check dev mode:", err);
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
// Topbar
on("loadBtn", "click", loadVideos);


// Settings modal open / close + tab switching
const settingsModal = el("settingsModal");

const openSettings = () => {
  renderKeybindsUi();
  updateDisplayModeUI();
  updateAudioOnLoadUI();
  renderLayoutPreferences();
  updateFocusSizeUI();
  updatePauseOnDrawUI();
  updateDriftCorrectionUI();
  updateResetTooltip("general");
  // Force reset tabs to "General"
  const tabs = document.querySelectorAll(".settingsTab");
  const panels = document.querySelectorAll(".settingsTabContent");
  tabs.forEach(t => t.classList.remove("active"));
  panels.forEach(p => p.classList.remove("active"));

  // Set first tab active
  const genTab = document.querySelector('.settingsTab[data-tab="general"]');
  const genPanel = document.getElementById("settingsTabGeneral");
  if (genTab) genTab.classList.add("active");
  if (genPanel) genPanel.classList.add("active");

  settingsModal?.classList.add("open");
};

const closeSettings = () => {
  settingsModal?.classList.remove("open");
  setEditing(null);
};

on("settingsBtn", "click", openSettings);
on("settingsClose", "click", closeSettings);

// ========== Tab-Specific Reset Functions ==========

/**
 * Reset General settings to defaults:
 * - Display Mode: Windowed Maximized
 * - Audio on Load: Mute All
 * - Pause On Draw: On (true)
 * - Drift Correction: On (true)
 * - Standard Drift Tolerance: 0.25
 * - Twitch Drift Tolerance: 1.00
 */
async function resetGeneralSettings() {
  /* Display Mode is NO LONGER reset to defaults based on user request.
  // Display Mode -> windowed-maximized (index 1)
  currentDisplayModeIndex = 1;
  await ipcRenderer.invoke("display:setMode", "windowed-maximized");
  const displayEl = el("displayModeValue");
  if (displayEl) displayEl.textContent = "Windowed Maximized"; */

  // Audio on Load -> mute-all (index 0)
  currentAudioOnLoadIndex = 0;
  await ipcRenderer.invoke("audio:setOnLoad", "mute-all");
  const audioEl = el("audioOnLoadValue");
  if (audioEl) audioEl.textContent = "Mute All";

  // Show Keybind Legend -> On (true)
  showKeybindLegend = true;
  saveShowKeybindLegend();
  updateKeybindLegendToggleUI();

  // CRITICAL: Set driftEnabled to true FIRST before updating inputs
  await ipcRenderer.invoke("drift:setEnabled", true);
  driftEnabled = true;

  // Set drift tolerance values
  await ipcRenderer.invoke("drift:setStandard", 0.25);
  await ipcRenderer.invoke("drift:setTwitch", 1.5);

  // Update UI for drift correction toggle
  const driftValEl = el("driftEnabledValue");
  if (driftValEl) driftValEl.textContent = "On";

  // Show drift options in top bar
  const driftOptions = el("driftOptions");
  if (driftOptions) driftOptions.style.display = "";

  // CRITICAL: Explicitly update the tolerance input states
  // Set values and ensure they are editable (not disabled, not readOnly)
  const stdInput = el("driftStandardInput");
  const twInput = el("driftTwitchInput");

  if (stdInput) {
    stdInput.value = "0.25";
    stdInput.disabled = false;
    stdInput.readOnly = false;
    stdInput.style.pointerEvents = "";
    el("stdDriftRow")?.classList.remove("disabled");
  }

  if (twInput) {
    twInput.value = "1.50";
    twInput.disabled = false;
    twInput.readOnly = false;
    twInput.style.pointerEvents = "";
    el("twitchDriftRow")?.classList.remove("disabled");
  }

  // Update top bar drift threshold too
  const thresholdInput = el("threshold");
  if (thresholdInput) thresholdInput.value = "0.25";

  // Force check twitch constraints to update active threshold
  checkTwitchConstraints(true);

  // ACCEPTANCE CHECK: Log the states after reset for verification
  // Expected: driftEnabled=true, stdInput.disabled=false, stdInput.readOnly=false, twInput.disabled=false, twInput.readOnly=false
  console.log("[General Reset] Acceptance Check:", {
    driftEnabled: driftEnabled,
    stdInputDisabled: stdInput?.disabled,
    stdInputReadOnly: stdInput?.readOnly,
    twInputDisabled: twInput?.disabled,
    twInputReadOnly: twInput?.readOnly
  });
  // Assert expected values
  if (driftEnabled !== true || stdInput?.disabled !== false || stdInput?.readOnly !== false || twInput?.disabled !== false || twInput?.readOnly !== false) {
    console.error("[General Reset] FAILED Acceptance Check! Tolerance inputs may not be editable.");
  }
}

/**
 * Reset Layout settings to defaults:
 * - All layout preferences: 'A' (first option for each video count)
 * - Focused Video Size: Focused (70/30)
 */
async function resetLayoutSettings() {
  // Reset all layout preferences to 'A'
  for (let count = 1; count <= 6; count++) {
    await ipcRenderer.invoke("layout:setPreference", { count, option: 'A' });
  }

  // Focused Video Size -> focused (index 1)
  currentFocusSizeIndex = 1;
  await ipcRenderer.invoke("focus:setSize", "focused");
  const focusEl = el("focusSizeValue");
  if (focusEl) focusEl.textContent = "Focused (70 / 30)";
  applyFocusSize("focused");

  // Refresh the layout preferences UI
  await renderLayoutPreferences();

  // If we have videos loaded, update the current layout
  if (currentFilledVideoCount > 0) {
    currentLayoutOption = 'A';
    updateLayoutOptionsUI(currentFilledVideoCount);
    applyLayout();
  }
}

/**
 * Reset Keybind settings to defaults:
 * G=-30s, H=-5s, Space=Pause/Play, K=+5s, L=+30s, M=Toggle Mute, F=Toggle Focus, D=Toggle Draw
 */
function resetKeybindSettings() {
  keybinds = { ...DEFAULT_BINDS };
  saveKeybinds();
  renderKeybindsUi();
  setEditing(null);
}

/**
 * Reset Draw settings to defaults:
 * - Pause On Draw: On (true)
 * - Default Color: Red
 */
async function resetDrawSettings() {
  // Pause On Draw -> On (true)
  await ipcRenderer.invoke("pause:setOnDraw", true);
  pauseOnDraw = true;
  const pauseEl = el("pauseOnDrawValue");
  if (pauseEl) pauseEl.textContent = "On";

  // Default Color -> Red (index 1)
  defaultDrawColorIndex = 1;
  await ipcRenderer.invoke("draw:setDefaultColor", "#ff0000");
  drawColor = "#ff0000";
  if (drawCtx) drawCtx.strokeStyle = drawColor;
  const colorEl = el("defaultColorValue");
  if (colorEl) colorEl.textContent = "Red";

  // Circle Draw Mode -> Drag to Corner (corner)
  await ipcRenderer.invoke("draw:setCircleMode", "corner");
  circleDrawMode = "corner";
  const cmEl = el("circleModeValue");
  if (cmEl) cmEl.textContent = "Drag to Corner";

  // Default Draw Tool -> Always Pencil (pencil)
  await ipcRenderer.invoke("draw:setDefaultTool", "pencil");
  defaultDrawToolSetting = "pencil";
  const toolEl = el("defaultToolValue");
  if (toolEl) toolEl.textContent = "Always Pencil";
}

/**
 * Get the currently active settings tab name
 * Returns: "general" | "layout" | "keybinds"
 */
function getActiveSettingsTab() {
  const activeTab = document.querySelector(".settingsTab.active");
  return activeTab?.getAttribute("data-tab") || "general";
}

// Reset button hold logic
const resetBtn = el("keybindsReset");
let resetHoldTimer = null;
let resetCountdownInterval = null;
const RESET_HOLD_DURATION = 3000;
let originalResetHtml = "";

if (resetBtn) {
  // Store the original icon
  originalResetHtml = resetBtn.innerHTML;

  resetBtn.addEventListener("mousedown", (e) => {
    // Only left click
    if (e.button !== 0) return;

    const activeTab = getActiveSettingsTab();
    let timeLeft = 3;

    // Show initial count
    resetBtn.textContent = timeLeft;
    resetBtn.style.color = "#fff"; // highlighted state
    resetBtn.style.fontSize = "16px";
    resetBtn.style.fontWeight = "bold";

    // Countdown interval to update the text
    resetCountdownInterval = setInterval(() => {
      timeLeft--;
      if (timeLeft > 0) {
        resetBtn.textContent = timeLeft;
      }
    }, 1000);

    // Main timer to trigger the action
    resetHoldTimer = setTimeout(async () => {
      // Action triggering!
      clearInterval(resetCountdownInterval);

      switch (activeTab) {
        case "general":
          await resetGeneralSettings();
          break;
        case "layout":
          await resetLayoutSettings();
          break;
        case "keybinds":
          resetKeybindSettings();
          break;
        case "draw":
          await resetDrawSettings();
          break;
      }

      // Visual feedback that it finished
      // We can flash it or just restore
      resetBtn.innerHTML = originalResetHtml;
      resetBtn.style.color = "";
      resetBtn.style.fontSize = "";
      resetBtn.style.fontWeight = "";

      // Clear timers
      resetHoldTimer = null;
      resetCountdownInterval = null;
    }, RESET_HOLD_DURATION);
  });

  const cancelReset = () => {
    if (resetHoldTimer) {
      clearTimeout(resetHoldTimer);
      resetHoldTimer = null;
    }
    if (resetCountdownInterval) {
      clearInterval(resetCountdownInterval);
      resetCountdownInterval = null;
    }
    // Restore icon
    if (resetBtn.innerHTML !== originalResetHtml) {
      resetBtn.innerHTML = originalResetHtml;
      resetBtn.style.color = "";
      resetBtn.style.fontSize = "";
      resetBtn.style.fontWeight = "";
    }
  };

  resetBtn.addEventListener("mouseup", cancelReset);
  resetBtn.addEventListener("mouseleave", cancelReset);
}

// Click outside panel to close (Discord-style)
settingsModal?.addEventListener("click", (e) => {
  if (e.target === settingsModal) closeSettings();
});

// Tab switching
document.querySelectorAll(".settingsTab").forEach(tab => {
  tab.addEventListener("click", () => {
    const tabName = tab.getAttribute("data-tab");
    if (!tabName) return;

    // Update tab button active state
    document.querySelectorAll(".settingsTab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");

    // Show corresponding content panel
    document.querySelectorAll(".settingsTabContent").forEach(panel => {
      panel.classList.remove("active");
    });
    const targetPanel = el("settingsTab" + tabName.charAt(0).toUpperCase() + tabName.slice(1));
    if (targetPanel) targetPanel.classList.add("active");

    // Update Reset Icon Tooltip
    updateResetTooltip(tabName);

    // Cancel any keybind editing when switching tabs
    setEditing(null);
  });
});

function updateResetTooltip(tabName) {
  const resetBtn = el("keybindsReset");
  if (!resetBtn) return;

  const prettyName = tabName.charAt(0).toUpperCase() + tabName.slice(1);
  const tooltip = `Hold to reset ${prettyName} to default`;

  resetBtn.title = tooltip;
  resetBtn.setAttribute("aria-label", tooltip);
}

// Default Draw Color Logic
let defaultDrawColorIndex = 1; // Default Red

async function updateDefaultDrawColorUI() {
  const hex = await ipcRenderer.invoke("draw:getDefaultColor");

  // Find index
  const idx = DRAW_COLORS.findIndex(c => c.hex.toLowerCase() === (hex || "").toLowerCase());
  // If not found, default to Red (1)
  defaultDrawColorIndex = idx >= 0 ? idx : 1;
  const color = DRAW_COLORS[defaultDrawColorIndex];

  const label = el("defaultColorValue");
  if (label) label.textContent = color.name.charAt(0).toUpperCase() + color.name.slice(1);

  return color.hex;
}

async function cycleDefaultDrawColor(direction) {
  defaultDrawColorIndex = (defaultDrawColorIndex + direction + DRAW_COLORS.length) % DRAW_COLORS.length;
  const newColor = DRAW_COLORS[defaultDrawColorIndex];

  await ipcRenderer.invoke("draw:setDefaultColor", newColor.hex);

  // Apply immediately to current session
  drawColor = newColor.hex;
  if (drawCtx) drawCtx.strokeStyle = drawColor;

  const label = el("defaultColorValue");
  if (label) label.textContent = newColor.name.charAt(0).toUpperCase() + newColor.name.slice(1);
}

on("defaultColorLeft", "click", () => cycleDefaultDrawColor(-1));
on("defaultColorRight", "click", () => cycleDefaultDrawColor(1));


// Circle Draw Mode Logic
let circleDrawMode = "corner"; // "corner" | "grow"

async function updateCircleDrawModeUI() {
  circleDrawMode = await ipcRenderer.invoke("draw:getCircleMode");
  const label = el("circleModeValue");
  if (label) label.textContent = circleDrawMode === "grow" ? "Drag to Grow" : "Drag to Corner";
}

async function cycleCircleDrawMode() {
  const newVal = circleDrawMode === "corner" ? "grow" : "corner";
  await ipcRenderer.invoke("draw:setCircleMode", newVal);
  circleDrawMode = newVal;
  const label = el("circleModeValue");
  if (label) label.textContent = newVal === "grow" ? "Drag to Grow" : "Drag to Corner";
}

on("circleModeLeft", "click", cycleCircleDrawMode);
on("circleModeRight", "click", cycleCircleDrawMode);

// Default Draw Tool Logic
const DEFAULT_DRAW_TOOL_MODES = ["pencil", "arrow", "circle", "last"];
const DEFAULT_DRAW_TOOL_LABELS = {
  "pencil": "Always Pencil",
  "arrow": "Always Arrow",
  "circle": "Always Circle",
  "last": "Last Selected"
};
let defaultDrawToolSetting = "pencil"; // stored preference
let defaultDrawToolIndex = 0;

async function updateDefaultDrawToolUI() {
  defaultDrawToolSetting = await ipcRenderer.invoke("draw:getDefaultTool");
  defaultDrawToolIndex = DEFAULT_DRAW_TOOL_MODES.indexOf(defaultDrawToolSetting);
  if (defaultDrawToolIndex < 0) defaultDrawToolIndex = 0;

  const label = el("defaultToolValue");
  if (label) label.textContent = DEFAULT_DRAW_TOOL_LABELS[DEFAULT_DRAW_TOOL_MODES[defaultDrawToolIndex]];
}

async function cycleDefaultDrawTool(direction) {
  defaultDrawToolIndex = (defaultDrawToolIndex + direction + DEFAULT_DRAW_TOOL_MODES.length) % DEFAULT_DRAW_TOOL_MODES.length;
  const newValue = DEFAULT_DRAW_TOOL_MODES[defaultDrawToolIndex];

  await ipcRenderer.invoke("draw:setDefaultTool", newValue);
  defaultDrawToolSetting = newValue;

  const label = el("defaultToolValue");
  if (label) label.textContent = DEFAULT_DRAW_TOOL_LABELS[newValue];
}

on("defaultToolLeft", "click", () => cycleDefaultDrawTool(-1));
on("defaultToolRight", "click", () => cycleDefaultDrawTool(1));


// Populate UI + send binds to main on startup
(async function init() {
  renderKeybindsUi();
  saveKeybinds(); // sends to main
  updateFocusSizeUI(); // Apply saved focus size preference
  updatePauseOnDrawUI(); // Load saved pause on draw preference

  // Load Default Draw Color and Apply it as current drawColor
  const defColor = await updateDefaultDrawColorUI();
  if (defColor) {
    drawColor = defColor;
    // Also update UI states? 
    // Usually draw color UI is built in createDrawCanvas or createColorSelector. 
    // Does createColorSelector run on init? No. It runs when Draw is toggled.
    // So setting global variable is enough.
  }

  await updateCircleDrawModeUI(); // Load saved circle mode preference
  await updateDefaultDrawToolUI(); // Load saved default tool preference

  updateKeybindLegendToggleUI(); // Load saved keybind legend preference
  await updateDriftCorrectionUI(); // Load saved drift preference
  checkTwitchConstraints(true); // Force update active threshold from settings on startup
})();

// Display mode cycling
const DISPLAY_MODES = ["windowed", "windowed-maximized", "fullscreen"];
let currentDisplayModeIndex = 0;

// Helper to format display mode name for UI (e.g., "windowed-maximized" -> "Windowed Maximized")
function formatDisplayModeName(mode) {
  return mode.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

async function updateDisplayModeUI() {
  const mode = await ipcRenderer.invoke("display:getMode");
  currentDisplayModeIndex = DISPLAY_MODES.indexOf(mode);
  if (currentDisplayModeIndex < 0) currentDisplayModeIndex = 0;

  const valueEl = el("displayModeValue");
  if (valueEl) {
    valueEl.textContent = formatDisplayModeName(DISPLAY_MODES[currentDisplayModeIndex]);
  }
}

async function cycleDisplayMode(direction) {
  currentDisplayModeIndex = (currentDisplayModeIndex + direction + DISPLAY_MODES.length) % DISPLAY_MODES.length;
  const newMode = DISPLAY_MODES[currentDisplayModeIndex];

  await ipcRenderer.invoke("display:setMode", newMode);

  const valueEl = el("displayModeValue");
  if (valueEl) {
    valueEl.textContent = formatDisplayModeName(newMode);
  }
}

on("displayModeLeft", "click", () => cycleDisplayMode(-1));
on("displayModeRight", "click", () => cycleDisplayMode(1));

// Audio on load cycling
const AUDIO_ON_LOAD_MODES = ["mute-all", "primary-only", "unmute-all"];
const AUDIO_ON_LOAD_LABELS = {
  "mute-all": "Mute All",
  "primary-only": "Primary Video Only",
  "unmute-all": "Unmute All"
};
let currentAudioOnLoadIndex = 0;

async function updateAudioOnLoadUI() {
  const mode = await ipcRenderer.invoke("audio:getOnLoad");
  currentAudioOnLoadIndex = AUDIO_ON_LOAD_MODES.indexOf(mode);
  if (currentAudioOnLoadIndex < 0) currentAudioOnLoadIndex = 0;

  const valueEl = el("audioOnLoadValue");
  if (valueEl) {
    valueEl.textContent = AUDIO_ON_LOAD_LABELS[AUDIO_ON_LOAD_MODES[currentAudioOnLoadIndex]];
  }
}

async function cycleAudioOnLoad(direction) {
  currentAudioOnLoadIndex = (currentAudioOnLoadIndex + direction + AUDIO_ON_LOAD_MODES.length) % AUDIO_ON_LOAD_MODES.length;
  const newMode = AUDIO_ON_LOAD_MODES[currentAudioOnLoadIndex];

  await ipcRenderer.invoke("audio:setOnLoad", newMode);

  const valueEl = el("audioOnLoadValue");
  if (valueEl) {
    valueEl.textContent = AUDIO_ON_LOAD_LABELS[newMode];
  }
}

// Layout Preferences handling
// Layout Preferences handling
async function renderLayoutPreferences() {
  const container = el("layoutPreferencesList");
  if (!container) return;

  const prefs = await ipcRenderer.invoke("layout:getPreferences");

  // If container is empty, build the DOM (Initial Render)
  if (container.children.length === 0) {
    for (let count = 1; count <= 6; count++) {
      const configs = LAYOUT_CONFIGS[count];
      if (!configs) continue;

      const row = document.createElement("div");
      row.className = "settingsRow";

      const label = document.createElement("span");
      label.className = "settingsLabel";
      label.textContent = count === 1 ? "1 Video" : `${count} Videos`;
      // Fix vertical centering manual adjustment
      label.style.marginTop = "-1px";
      row.appendChild(label);

      const group = document.createElement("div");
      group.className = "layoutOptionGroup";

      const options = Object.keys(configs).sort();
      options.forEach(opt => {
        const btn = document.createElement("button");
        btn.className = "layoutPrefBtn";
        // Store metadata for easier updates
        btn.dataset.count = count;
        btn.dataset.option = opt;

        if ((prefs[count] || 'A') === opt) btn.classList.add("active");

        btn.innerHTML = generateLayoutIcon(configs[opt]);
        btn.title = `Layout ${opt}`;

        btn.addEventListener("click", async () => {
          await ipcRenderer.invoke("layout:setPreference", { count, option: opt });
          renderLayoutPreferences(); // refresh UI (triggers update path)

          // If we currently have this many videos loaded, update the grid immediately
          if (currentFilledVideoCount === count) {
            currentLayoutOption = opt;
            updateLayoutOptionsUI(count);
            applyLayout();
          }
        });
        group.appendChild(btn);
      });

      row.appendChild(group);
      container.appendChild(row);
    }
  } else {
    // Container already populated, just update active states (Flicker-free update)
    const buttons = container.querySelectorAll(".layoutPrefBtn");
    buttons.forEach(btn => {
      const c = parseInt(btn.dataset.count);
      const o = btn.dataset.option;
      const isActive = (prefs[c] || 'A') === o;

      if (isActive) btn.classList.add("active");
      else btn.classList.remove("active");
    });
  }
}

on("audioOnLoadLeft", "click", () => cycleAudioOnLoad(-1));
on("audioOnLoadRight", "click", () => cycleAudioOnLoad(1));

// Pause On Draw Logic
let pauseOnDraw = true;

async function updatePauseOnDrawUI() {
  pauseOnDraw = await ipcRenderer.invoke("pause:getOnDraw");
  const valueEl = el("pauseOnDrawValue");
  if (valueEl) valueEl.textContent = pauseOnDraw ? "On" : "Off";
}

async function cyclePauseOnDraw() {
  const newVal = !pauseOnDraw;
  await ipcRenderer.invoke("pause:setOnDraw", newVal);
  await updatePauseOnDrawUI();
}

on("pauseOnDrawLeft", "click", cyclePauseOnDraw);
on("pauseOnDrawRight", "click", cyclePauseOnDraw);
on("pauseOnDrawLeft", "click", cyclePauseOnDraw);
on("pauseOnDrawRight", "click", cyclePauseOnDraw);


// Drift Correction Logic
let driftEnabled = true;

async function updateDriftCorrectionUI() {
  driftEnabled = await ipcRenderer.invoke("drift:getEnabled");

  // Update settings toggle
  const valueEl = el("driftEnabledValue");
  if (valueEl) valueEl.textContent = driftEnabled ? "On" : "Off";

  // Show/Hide top bar UI
  const driftOptions = el("driftOptions");
  if (driftOptions) {
    driftOptions.style.display = driftEnabled ? "" : "none";
  }

  // Update inputs
  const std = await ipcRenderer.invoke("drift:getStandard");
  const tw = await ipcRenderer.invoke("drift:getTwitch");

  if (driftStandardInput) {
    driftStandardInput.disabled = !driftEnabled;
    driftStandardInput.value = (parseFloat(std) || 0.25).toFixed(2);
    el("stdDriftRow")?.classList.toggle("disabled", !driftEnabled);
  }
  if (driftTwitchInput) {
    driftTwitchInput.disabled = !driftEnabled;
    driftTwitchInput.value = (parseFloat(tw) || 1.5).toFixed(2);
    el("twitchDriftRow")?.classList.toggle("disabled", !driftEnabled);
  }

  // Force update active threshold in top bar

}

const driftStandardInput = el("driftStandardInput");
const driftTwitchInput = el("driftTwitchInput");

// Bind input changes
if (driftStandardInput) {
  driftStandardInput.addEventListener("change", async (e) => {
    let val = parseFloat(e.target.value);
    if (!Number.isFinite(val) || val < 0.1) val = 0.1;
    e.target.value = val.toFixed(2);
    await ipcRenderer.invoke("drift:setStandard", val);
    checkTwitchConstraints(true); // Force update active threshold
  });
}

if (driftTwitchInput) {
  driftTwitchInput.addEventListener("change", async (e) => {
    let val = parseFloat(e.target.value);
    if (!Number.isFinite(val) || val < 1.0) val = 1.0;
    e.target.value = val.toFixed(2);
    await ipcRenderer.invoke("drift:setTwitch", val);
    checkTwitchConstraints(true); // Force update active threshold
  });
}

async function cycleDriftCorrection() {
  const newVal = !driftEnabled;
  await ipcRenderer.invoke("drift:setEnabled", newVal);
  await updateDriftCorrectionUI();
  checkTwitchConstraints(true); // Force logic update
}

on("driftEnabledLeft", "click", cycleDriftCorrection);
on("driftEnabledRight", "click", cycleDriftCorrection);

// Focused Video Size cycling
const FOCUS_SIZE_MODES = ["balanced", "focused", "dominant"];
const FOCUS_SIZE_LABELS = {
  "balanced": "Balanced (60 / 40)",
  "focused": "Focused (70 / 30)",
  "dominant": "Dominant (80 / 20)"
};
let currentFocusSizeIndex = 1; // Default to 'focused'

async function updateFocusSizeUI() {
  const size = await ipcRenderer.invoke("focus:getSize");
  currentFocusSizeIndex = FOCUS_SIZE_MODES.indexOf(size);
  if (currentFocusSizeIndex < 0) currentFocusSizeIndex = 1; // Default 'focused'

  const valueEl = el("focusSizeValue");
  if (valueEl) {
    valueEl.textContent = FOCUS_SIZE_LABELS[FOCUS_SIZE_MODES[currentFocusSizeIndex]];
  }
  applyFocusSize(size);
}

async function cycleFocusSize(direction) {
  currentFocusSizeIndex = (currentFocusSizeIndex + direction + FOCUS_SIZE_MODES.length) % FOCUS_SIZE_MODES.length;
  const newSize = FOCUS_SIZE_MODES[currentFocusSizeIndex];

  await ipcRenderer.invoke("focus:setSize", newSize);

  const valueEl = el("focusSizeValue");
  if (valueEl) {
    valueEl.textContent = FOCUS_SIZE_LABELS[newSize];
  }
  applyFocusSize(newSize);
}

function applyFocusSize(size) {
  const r = document.documentElement;
  // Default 'focused' is 7fr 3fr (70/30)
  if (size === "balanced") {
    r.style.setProperty("--focus-main", "6fr");
    r.style.setProperty("--focus-sub", "4fr");
  } else if (size === "dominant") {
    r.style.setProperty("--focus-main", "8fr");
    r.style.setProperty("--focus-sub", "2fr");
  } else {
    // focused (default)
    r.style.setProperty("--focus-main", "7fr");
    r.style.setProperty("--focus-sub", "3fr");
  }
}

on("focusSizeLeft", "click", () => cycleFocusSize(-1));
on("focusSizeRight", "click", () => cycleFocusSize(1));

// Update settings UI when settings modal opens
// (Logic already integrated into openSettings)

// Edit buttons
document.querySelectorAll(".kbEdit").forEach(btn => {
  btn.addEventListener("click", () => {
    const action = btn.getAttribute("data-action");
    if (!action) return;

    // Toggle: if already editing this action, cancel it
    if (editingAction === action) {
      setEditing(null);
    } else {
      setEditing(action);
    }
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
  if (!z) return;

  const rate = Number(z.value) || 1;
  const gCur = getMedianGlobalTime();

  // Apply to all players
  broadcast(p => safe(() => p.setPlaybackRate(rate)), 300, gCur);
  showBarNow();
});

on("zSettings", "click", () => {
  // Pause all videos so audio doesn't keep playing in background
  pauseAll();

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
  // Also exit draw mode
  if (drawMode) {
    toggleDrawMode();
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
  if (wasPlaying) setTimeout(() => playAll(2500, g), 80);
  else setTimeout(() => pauseAll(2000), 80);

  isZenSeeking = false;
  showBarNow();
});

// Keyboard + resize
window.addEventListener("keydown", e => {
  // Ignore keys during global loading
  if (isLoadingScreenActive) return;

  if (e.key === "Escape") {
    // Close Settings Modal if open
    if (settingsModal && settingsModal.classList.contains("open")) {
      closeSettings();
      return;
    }

    // Exit all interactive modes
    if (muteSelectMode) {
      muteSelectMode = false;
      document.body.classList.remove("muteSelectMode");
    }
    if (focusMode) {
      toggleFocusSelectMode();
    }
    if (drawMode) {
      toggleDrawMode();
    }
    if (document.body.classList.contains("zen")) {
      // Use common exit logic
      exitToVideoLoader();
    }

    // Disable keybinds until Load is pressed again
    keybindsArmed = false;
    ipcRenderer.send("app:setKeybindsArmed", false);
  }
});
window.addEventListener("resize", () => {
  updateTileHeight();
  updateSafeArea();
});

// Kick off loops + init
applyLayout();
startDriftLoop();
startUiLoop();
updateKeybindLegend();

// Initialize version label (and enables update checks)
initAppVersionUI();

// Layout option button handlers
on("layoutA", "click", async () => {
  currentLayoutOption = 'A';
  if (currentFilledVideoCount > 1) {
    await ipcRenderer.invoke("layout:setPreference", { count: currentFilledVideoCount, option: 'A' });
  }
  updateLayoutOptionsUI(currentFilledVideoCount);
  applyLayout();
});
on("layoutB", "click", async () => {
  currentLayoutOption = 'B';
  if (currentFilledVideoCount > 1) {
    await ipcRenderer.invoke("layout:setPreference", { count: currentFilledVideoCount, option: 'B' });
  }
  updateLayoutOptionsUI(currentFilledVideoCount);
  applyLayout();
});
on("layoutC", "click", async () => {
  currentLayoutOption = 'C';
  if (currentFilledVideoCount > 1) {
    await ipcRenderer.invoke("layout:setPreference", { count: currentFilledVideoCount, option: 'C' });
  }
  updateLayoutOptionsUI(currentFilledVideoCount);
  applyLayout();
});

on("threshold", "change", () => {
  checkTwitchConstraints();
});

// --------------- Feedback Modal ---------------
on("feedbackBtn", "click", () => {
  el("feedbackModal").classList.add("open");
  el("feedbackText").value = "";
  el("feedbackStatus").textContent = "";
  el("feedbackSubmit").disabled = true;
});

on("feedbackClose", "click", () => {
  el("feedbackModal").classList.remove("open");
});

// Close on backdrop click
el("feedbackModal")?.addEventListener("click", (e) => {
  if (e.target.id === "feedbackModal") {
    el("feedbackModal").classList.remove("open");
  }
});

on("feedbackText", "input", () => {
  el("feedbackSubmit").disabled = !el("feedbackText").value.trim();
});

on("feedbackSubmit", "click", async () => {
  const msg = el("feedbackText").value.trim();
  if (!msg) return;

  el("feedbackSubmit").disabled = true;
  el("feedbackStatus").textContent = "Sending…";

  try {
    await ipcRenderer.invoke("feedback:submit", { message: msg });
    el("feedbackStatus").textContent = "Sent. Thank you for helping me improve this app!";
    setTimeout(() => el("feedbackModal").classList.remove("open"), 1500);
  } catch (err) {
    el("feedbackStatus").textContent = "Failed to send. Try again.";
    el("feedbackSubmit").disabled = false;
  }
});


// --- Video Unavailable Modal Logic ---
let popupState = {
  isOpen: false,
  stepIndex: 0,
  maxSteps: 3,
  sourceTileId: null
};

// Track failed players to exclude from sync
let failedPlayerIndices = new Set();
let pendingUnavailableModal = false;
// Timers for embed failure detection (index -> timerId)
let embedCheckTimers = {};

function openVideoUnavailableModal(playerIndex) {
  // If players are cleared (exited to loader), ignore late errors
  if (players.length === 0) return;

  // If this tile caused the popup, ensure it's marked as failed
  if (playerIndex !== null) {
    if (!failedPlayerIndices.has(playerIndex)) {
      failedPlayerIndices.add(playerIndex);
      // Refresh safe area or other UI if needed?
      // Maybe dim the card or show an icon?
      const card = document.querySelectorAll("#grid .card")[playerIndex];
      if (card) {
        card.style.opacity = "0.5";
        card.style.pointerEvents = "none";
      }
    }

    const label = document.getElementById("vuFailedVideoLabel");
    if (label) {
      // Sort indices and map to "Video X"
      const failedList = Array.from(failedPlayerIndices)
        .sort((a, b) => a - b)
        .map(i => i + 1)
        .join(", ");
      label.textContent = `Failed: Video ${failedList}`;
    }
  }

  // Defer showing if loading screen is still up
  if (isLoadingScreenActive) {
    pendingUnavailableModal = true;
    return;
  }

  if (popupState.isOpen) return; // Prevent spam

  popupState.isOpen = true;
  popupState.sourceTileId = playerIndex;
  popupState.stepIndex = 0;

  document.getElementById("videoUnavailableModal").classList.add("open");
  updateVuStepper();

  // Hide Top Bar for a cleaner look (modal covers everything properly)
  const topbar = document.querySelector(".topbar");
  if (topbar) topbar.style.display = "none";

  // Disable keybinds while modal is open
  keybindsArmed = false;
  ipcRenderer.send("app:setKeybindsArmed", false);
}

function closeVideoUnavailableModal() {
  popupState.isOpen = false;
  popupState.sourceTileId = null;
  document.getElementById("videoUnavailableModal").classList.remove("open");

  // Re-enable keybinds when modal closes (if we are exiting, exitToVideoLoader will disable them again immediately)
  keybindsArmed = true;
  ipcRenderer.send("app:setKeybindsArmed", true);
}


function exitToVideoLoader() {
  closeVideoUnavailableModal();
  document.body.classList.remove("zen");
  document.body.classList.remove("zenPinned");
  const zenBar = document.getElementById("zenBar");
  if (zenBar) zenBar.classList.remove("show");

  const grid = document.getElementById("grid");
  if (grid) {
    grid.style.display = "none";
    grid.innerHTML = "";
  }

  const setup = document.querySelector(".setupPane");
  if (setup) setup.style.display = "block";

  const topbar = document.querySelector(".topbar");
  if (topbar) topbar.style.display = "flex";

  players.forEach(p => { try { p.pauseVideo(); } catch { } });
  players = [];

  // Clear any pending embed check timers so they don't pop up late
  Object.values(embedCheckTimers).forEach(timerId => clearTimeout(timerId));
  embedCheckTimers = {};
}

function updateVuStepper() {
  // Show/Hide slides
  const slides = document.querySelectorAll(".vuSlide");
  slides.forEach(slide => {
    const s = parseInt(slide.dataset.step, 10);
    slide.style.display = (s === popupState.stepIndex) ? "block" : "none";
  });

  // Update Dots
  const dots = document.querySelectorAll(".vuDot");
  dots.forEach((dot, i) => {
    if (i === popupState.stepIndex) dot.classList.add("active");
    else dot.classList.remove("active");
  });

  // Buttons
  const prevBtn = document.getElementById("vuPrevBtn");
  const nextBtn = document.getElementById("vuNextBtn");

  if (prevBtn) {
    const isFirst = (popupState.stepIndex <= 0);
    prevBtn.disabled = isFirst;
    prevBtn.style.opacity = isFirst ? "0" : "1";
    // Also set cursor to default if hidden to avoid confusion? 
    // css disabled handles cursor: not-allowed, but if hidden we probably want it to feel gone.
    prevBtn.style.cursor = isFirst ? "default" : "pointer";
  }

  if (nextBtn) {
    // If last step, show "Done", otherwise "Next"
    if (popupState.stepIndex >= popupState.maxSteps) {
      nextBtn.textContent = "Done";
    } else {
      nextBtn.textContent = "Next"; // Restore label if went back
    }
    // Always enabled now (unless we want to block "Done"?)
    nextBtn.disabled = false;
    nextBtn.style.opacity = "";
  }
}

// Wire up events
document.addEventListener("DOMContentLoaded", () => {

  document.getElementById("vuPrevBtn")?.addEventListener("click", (e) => {
    e.target.blur();
    if (popupState.stepIndex > 0) {
      popupState.stepIndex--;
      updateVuStepper();
    }
  });

  document.getElementById("vuNextBtn")?.addEventListener("click", (e) => {
    e.target.blur();
    // If on last step, "Done" -> Close
    if (popupState.stepIndex >= popupState.maxSteps) {
      exitToVideoLoader();
    } else {
      popupState.stepIndex++;
      updateVuStepper();
    }
  });

  // New X close button
  document.getElementById("vuCloseBtn")?.addEventListener("click", () => {
    exitToVideoLoader();
  });

  // Secondary link if it exists/user kept it (Removing based on request, but safe to keep handler if element exists)
  document.getElementById("vuBackToLoader")?.addEventListener("click", () => {
    exitToVideoLoader();
  });

  // Global Esc key handler for this popup
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && popupState.isOpen) {
      exitToVideoLoader();
    }
  });
});
