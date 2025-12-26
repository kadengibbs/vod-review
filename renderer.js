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

function isTypingTarget(node) {
  if (!node) return false;
  const elNode = node.nodeType === 1 ? node : node.parentElement;
  if (!elNode) return false;

  if (elNode.isContentEditable) return true;

  const tag = (elNode.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;

  const closest = elNode.closest?.("input, textarea, select, [contenteditable='true']");
  return !!closest;
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

// ----- Editable keybinds -----
const DEFAULT_BINDS = {
  rew30: "g",
  rew5: "h",
  playpause: "j",
  fwd5: "k",
  fwd30: "l"
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

function setStatus(msg, isError = false) {
  const s = el("status");
  if (!s) return;
  s.textContent = msg;
  s.classList.toggle("error", isError);
}

function nowMs() { return Date.now(); }
function inLockout() { return nowMs() < ignoreEventsUntil; }
function beginLockout(ms = 450) {
  syncing = true;
  ignoreEventsUntil = nowMs() + ms;
  setTimeout(() => (syncing = false), ms);
}
function safe(fn) { try { fn(); } catch {} }

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

  const endGlobal = (d + getOffset(i));
  if (endedFlags[i]) {
    // If global target is before its end, we can rejoin
    if (globalTarget <= endGlobal - END_EPS) return true;
    return false;
  }
  return true;
}

function clearEndedIfRejoining(i, globalT) {
  if (!endedFlags[i]) return;
  const d = getDurationSafe(i);
  if (!Number.isFinite(d) || d <= 0) return;

  const endGlobal = d + getOffset(i);
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

    const ct = getCurrentTimeSafe(i);
    times.push(ct + getOffset(i));
  }
  return times;
}

function getMedianGlobalTime() {
  const times = getGlobalTimes(null);
  return times.length ? median(times) : globalCursorTime;
}

function refreshGlobalCursorFromActive() {
  const times = getGlobalTimes(null);
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
    try {
      const st = p.getPlayerState();
      // YT: 1 = playing, File: 1 = playing
      if (st === 1) return true;
    } catch {}
  }
  return false;
}

function togglePlayPauseAll() {
  if (anyPlaying()) pauseAll(450);
  else playAll(450);
  setTimeout(updatePlayPauseLabel, 120);
}

function syncNow() {
  const g = getMedianGlobalTime();
  seekAllToGlobal(g, 650);
}

function skipAll(deltaSeconds) {
  const g = getMedianGlobalTime() + (Number(deltaSeconds) || 0);
  seekAllToGlobal(g, 650);
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
    refreshGlobalCursorFromActive();
    updateUiTime();
  }, 120);
}

/* ---------- UI time + seekbar ---------- */

function updateUiTime() {
  if (!players.length) return;

  const g = getMedianGlobalTime();
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

let autoHideEnabled = true;
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
}

function setZenMode(onMode) {
  document.body.classList.toggle("zen", !!onMode);
  showZenBar(!!onMode && players.length > 0);

  setTimeout(() => {
    setAutoHide(el("autoHideToggle")?.checked ?? true);
    updateTileHeight();
    updateSafeArea();
    updatePlayPauseLabel();
  }, 50);
}

function toggleZenMode() {
  setZenMode(!document.body.classList.contains("zen"));
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
  const cols = Math.max(1, +(el("cols")?.value || 1));
  const rows = Math.max(1, +(el("rows")?.value || 1));

  document.documentElement.style.setProperty("--cols", cols);
  document.documentElement.style.setProperty("--rows", rows);
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
    setPlaybackRate: (v) => ytPlayer.setPlaybackRate(v),
    getPlayerState: () => ytPlayer.getPlayerState()
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
    playVideo: () => { const p = videoEl.play(); if (p?.catch) p.catch(() => {}); },
    pauseVideo: () => videoEl.pause(),
    setPlaybackRate: (v) => { videoEl.playbackRate = Number(v) || 1; },
    getPlayerState: () => (videoEl.paused ? 2 : 1)
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
  url.placeholder = "YouTube Link or File Input";
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

  block.appendChild(row);

  // Events: if user types a YT link, clear file
  url.addEventListener("input", () => {
    if (url.value.trim()) {
      // If they type a URL, prefer it and clear any selected file
      try { file.value = ""; } catch {}
      block.dataset.hasFile = "0";
    }
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
  if (blocks.length === 0) {
    ensureVideoRow(0);
    return;
  }

  const last = blocks[blocks.length - 1];
  if (rowIsFilled(last)) {
    ensureVideoRow(blocks.length); // add one more blank
  }
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

    const f = fileEl?.files?.[0] || null;
    const rawUrl = (urlEl?.value || "").trim();
    const startAt = parseStartTimeToSeconds(stEl?.value || "");

    if (f) {
      sources.push({ type: "file", file: f, startAt });
    } else if (rawUrl) {
      const id = extractId(rawUrl);
      if (id) sources.push({ type: "yt", id, startAt });
      else sources.push({ type: "bad", raw: rawUrl, startAt });
    }
  }

  return sources;
}

function cleanupObjectUrls() {
  for (const u of activeObjectUrls) {
    try { URL.revokeObjectURL(u); } catch {}
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

  const realSources = sources.filter(s => s.type === "yt" || s.type === "file");

  if (realSources.some(s => s.type === "yt") && !apiReady) {
    setStatus("YouTube API not ready yet. Try again in a second.", true);
    return;
  }

  const cols = Math.max(1, +(el("cols")?.value || 1));
  const rows = Math.max(1, +(el("rows")?.value || 1));
  const capacity = cols * rows;

  const totalCount = realSources.length;

  if (totalCount <= 0) {
    setStatus("Add at least one YouTube link/ID or choose a local video file.", true);
    return;
  }

  if (totalCount > capacity) {
    setStatus(`Error: ${totalCount} video(s) but layout only allows ${capacity} (${cols}×${rows}).`, true);
    return;
  }

  // Arm native keybind blocking only after Load succeeds
  keybindsArmed = true;


  // Start Time means: at global 0, the video should be at local "startAt".
  // Our sync math uses global = local + offset => offset must be -startAt.
  offsets = realSources.map(s => -(Number(s.startAt) || 0));
  endedFlags = Array(totalCount).fill(false);
  globalCursorTime = 0;

  setStatus(`Loading ${totalCount} video(s).`, false);

  players.forEach(p => { try { p.destroy(); } catch {} });
  players = [];
  holders = [];
  if (el("grid")) el("grid").innerHTML = "";
  cleanupObjectUrls();

  for (let i = 0; i < totalCount; i++) {
    const card = document.createElement("div");
    card.className = "card";

    const wrap = document.createElement("div");
    wrap.className = "playerWrap r16x9";

    card.appendChild(wrap);
    el("grid").appendChild(card);

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

  const cards = Array.from(el("grid")?.children || []);

  // Build players in the SAME ORDER as the setup list
  realSources.forEach((src, i) => {
    const wrap = cards[i]?.__wrap;
    if (!wrap) return;

    if (src.type === "yt") {
      const holder = document.createElement("div");
      holder.id = `p${i}-${Date.now()}`;
      wrap.appendChild(holder);
      holders.push(holder.id);

      const yt = new YT.Player(holder.id, {
        width: "100%",
        height: "100%",
        videoId: src.id,
        playerVars: { disablekb: 1 },
        events: {
          onReady: () => {
            setStatus(`Loaded ${totalCount} video(s).`, false);
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
          try { yt.seekTo(localStart, true); } catch {}
        }, 250);
      }

      return;
    }

    // Local file
    const v = document.createElement("video");
    v.style.width = "100%";
    v.style.height = "100%";
    v.style.background = "black";
    v.controls = true;
    v.playsInline = true;
    // Prevent native <video> keybinds from triggering via focus
    v.tabIndex = -1;

    const url = URL.createObjectURL(src.file);
    activeObjectUrls.push(url);
    v.src = url;

    wrap.appendChild(v);

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
      } catch {}
      try { v.pause(); } catch {}
      try { v.src = ""; } catch {}
    };

    players[i] = makeFileAdapter(v, cleanup);

    v.addEventListener("loadedmetadata", () => {
      setStatus(`Loaded ${totalCount} video(s).`, false);
      afterAnyReady();

      const localStart = Math.max(0, Number(src.startAt) || 0);
      if (localStart > 0) {
        try { v.currentTime = localStart; } catch {}
      }
    }, { once: true });
  });

  applyLayout();

  // ✅ Hide all settings after Load (like before)
  if (ENTER_ZEN_ON_LOAD) {
    setZenMode(true);
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
  toggleZenMode();
});

// Zen timeline
on("zenSeek", "input", () => { isZenSeeking = true; showBarNow(); });
on("zenSeek", "change", () => {
  const dGlobal = getMaxGlobalEnd();
  if (!Number.isFinite(dGlobal) || dGlobal <= 0) {
    isZenSeeking = false;
    return;
  }

  const zb = el("zenSeek");
  const g = ((zb?.value || 0) / 1000) * dGlobal;

  const wasPlaying = anyPlaying();
  seekAllToGlobal(g, 750);
  if (wasPlaying) setTimeout(() => playAll(450), 80);
  else setTimeout(() => pauseAll(450), 80);

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
