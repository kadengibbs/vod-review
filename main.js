const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
if (process.platform === 'win32') {
  app.setAppUserModelId("com.vodreview.app");
}
const https = require("https");
const { URL } = require("url");
const { spawn } = require("child_process");
const path = require("path");
const { startServer } = require("./server");

// Existing handler (keep)
ipcMain.handle("app:getVersion", () => app.getVersion());

// Dev mode check
ipcMain.handle("app:isDev", () => {
  return process.env.DEV_UI === "1" && !app.isPackaged;
});

// Alias handler (fixes: "No handler registered for 'getVersion'")
ipcMain.handle("getVersion", () => app.getVersion());

// Feedback submission handler
const FEEDBACK_URL = "https://script.google.com/macros/s/AKfycbxrKRvRALjFtaShQor9LZ8Co3EnQtefCYVHNWIRVAheZReS-Esx2FjMIE2wPDUH-IAtJw/exec";
const FEEDBACK_KEY = "v0dr3v13w_fb_9Qk7mD2sLx8R4pT1nH6cW5yG0eZ3uJ";

function postFeedback(payload, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const urlObj = new URL(FEEDBACK_URL);

    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        // Apps Script returns 302 redirect on success, or 200
        if (res.statusCode === 200 || res.statusCode === 302) {
          resolve(body);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });

    req.write(data);
    req.end();
  });
}

ipcMain.handle("feedback:submit", async (_event, { message }) => {
  const platform = process.platform === "win32" ? "Windows"
    : process.platform === "darwin" ? "macOS"
      : "Linux";

  const payload = {
    key: FEEDBACK_KEY,
    message: message || "",
    appVersion: app.getVersion(),
    platform,
    timestamp: new Date().toISOString()
  };

  await postFeedback(payload);
  return { success: true };
});



let serverHandle = null;

// Display mode persistence
const settingsPath = path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
  } catch { }
  return {};
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch { }
}

// Dynamic keybinds (key -> action)
// Dynamic keybinds (key -> action)
let keyToAction = {};
let keybindsArmed = false;
let isTyping = false;

async function createWindow() {
  // Start local server so YouTube sees an http(s) origin instead of file://
  serverHandle = await startServer(3000);

  // Load saved display mode
  const settings = loadSettings();
  const savedDisplayMode = settings.displayMode || "windowed-maximized";
  const isFullscreen = savedDisplayMode === "fullscreen";

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    fullscreen: isFullscreen,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, "icon.ico"),
    autoHideMenuBar: process.env.DEV_UI !== "1"
  });

  // Apply windowed-maximized mode after window creation
  if (savedDisplayMode === "windowed-maximized") {
    win.maximize();
  }

  if (process.env.DEV_UI !== "1") {
    win.setMenu(null);
  }

  // Prevent new windows (e.g. from YouTube title clicks)
  win.webContents.setWindowOpenHandler(() => {
    return { action: "deny" };
  });

  win.loadURL(`http://127.0.0.1:${serverHandle.port}/index.html`);
  // Custom keybinds: capture at the webContents level so it works even when a YouTube iframe is focused
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.control || input.alt || input.meta) return;

    // 1. If logic not armed, let it pass (standard typing)
    if (!keybindsArmed) return;

    // 2. If user is typing in an input, let it pass
    if (isTyping) return;

    const key = String(input.key || "").toLowerCase();
    const action = keyToAction[key];
    if (!action) return;

    // Prevent YouTube / HTML5 players from handling it
    event.preventDefault();

    // Forward to renderer
    win.webContents.send("app:customKeybind", action);
  });

  // Renderer sends updated binds
  ipcMain.on("app:updateKeybinds", (_evt, binds) => {
    const next = {};
    if (binds && typeof binds === "object") {
      for (const [action, key] of Object.entries(binds)) {
        const k = String(key || "").toLowerCase();
        if (!k) continue;
        if (!next[k]) next[k] = action;
      }
    }
    keyToAction = next;
  });

  ipcMain.on("app:setKeybindsArmed", (_evt, val) => {
    keybindsArmed = !!val;
  });

  ipcMain.on("app:setTyping", (_evt, val) => {
    isTyping = !!val;
  });

  // Display mode handlers
  ipcMain.handle("display:getMode", () => {
    // Return saved preference, NOT current window state
    const settings = loadSettings();
    return settings.displayMode || "windowed-maximized";
  });

  ipcMain.handle("display:setMode", (_evt, mode) => {
    // Apply visual state
    if (mode === "fullscreen") {
      win.setFullScreen(true);
    } else if (mode === "windowed-maximized") {
      win.setFullScreen(false);
      if (!win.isMaximized()) win.maximize();
    } else {
      // windowed
      win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
    }

    // Persist the setting explicitly
    const settings = loadSettings();
    settings.displayMode = mode;
    saveSettings(settings);

    return mode;
  });

  // Audio on load setting handlers
  ipcMain.handle("audio:getOnLoad", () => {
    const settings = loadSettings();
    return settings.audioOnLoad || "mute-all";
  });

  ipcMain.handle("audio:setOnLoad", (_evt, mode) => {
    const settings = loadSettings();
    settings.audioOnLoad = mode;
    saveSettings(settings);
    return mode;
  });

  // Layout preference handlers
  ipcMain.handle("layout:getPreferences", () => {
    const settings = loadSettings();
    return settings.layoutPreferences || {};
  });

  ipcMain.handle("layout:setPreference", (_evt, { count, option }) => {
    const settings = loadSettings();
    if (!settings.layoutPreferences) settings.layoutPreferences = {};
    settings.layoutPreferences[count] = option;
    saveSettings(settings);
    return settings.layoutPreferences;
  });

  // Focused Video Size handlers
  ipcMain.handle("focus:getSize", () => {
    const settings = loadSettings();
    return settings.focusSize || "focused"; // Default to 'focused' (70/30)
  });

  ipcMain.handle("focus:setSize", (_evt, size) => {
    const settings = loadSettings();
    settings.focusSize = size;
    saveSettings(settings);
    return size;
  });

  // Pause On Draw handlers
  ipcMain.handle("pause:getOnDraw", () => {
    const settings = loadSettings();
    // Default to true if not set
    return settings.pauseOnDraw === undefined ? true : settings.pauseOnDraw;
  });

  ipcMain.handle("pause:setOnDraw", (_evt, val) => {
    const settings = loadSettings();
    settings.pauseOnDraw = !!val;
    saveSettings(settings);
    return settings.pauseOnDraw;
  });

  // Drift persistence
  ipcMain.handle("drift:getEnabled", () => {
    const settings = loadSettings();
    // Default to true
    return settings.driftEnabled === undefined ? true : settings.driftEnabled;
  });

  ipcMain.handle("drift:setEnabled", (_evt, val) => {
    const settings = loadSettings();
    settings.driftEnabled = !!val;
    saveSettings(settings);
    return settings.driftEnabled;
  });

  ipcMain.handle("drift:getStandard", () => {
    const settings = loadSettings();
    return settings.driftStandard !== undefined ? settings.driftStandard : 0.25;
  });

  ipcMain.handle("drift:setStandard", (_evt, val) => {
    const settings = loadSettings();
    settings.driftStandard = Number(val);
    saveSettings(settings);
    return settings.driftStandard;
  });

  ipcMain.handle("drift:getTwitch", () => {
    const settings = loadSettings();
    return settings.driftTwitch !== undefined ? settings.driftTwitch : 1.5;
  });

  ipcMain.handle("drift:setTwitch", (_evt, val) => {
    const settings = loadSettings();
    settings.driftTwitch = Number(val);
    saveSettings(settings);
    return settings.driftTwitch;
  });

  // Default Draw Color persistence
  ipcMain.handle("draw:getDefaultColor", () => {
    const settings = loadSettings();
    return settings.drawDefaultColor !== undefined ? settings.drawDefaultColor : "#ff0000";
  });

  ipcMain.handle("draw:setDefaultColor", (_evt, val) => {
    const settings = loadSettings();
    settings.drawDefaultColor = val;
    saveSettings(settings);
    return settings.drawDefaultColor;
  });

  // Circle Draw Mode persistence
  ipcMain.handle("draw:getCircleMode", () => {
    const settings = loadSettings();
    // Default "corner"
    return settings.drawCircleMode !== undefined ? settings.drawCircleMode : "corner";
  });

  ipcMain.handle("draw:setCircleMode", (_evt, val) => {
    const settings = loadSettings();
    settings.drawCircleMode = val;
    saveSettings(settings);
    return settings.drawCircleMode;
  });

  // Default Draw Tool persistence
  ipcMain.handle("draw:getDefaultTool", () => {
    const settings = loadSettings();
    return settings.drawDefaultTool !== undefined ? settings.drawDefaultTool : "pencil";
  });

  ipcMain.handle("draw:setDefaultTool", (_evt, val) => {
    const settings = loadSettings();
    settings.drawDefaultTool = val;
    saveSettings(settings);
    return settings.drawDefaultTool;
  });
}

// Disable hardware media keys to prevent hijacking global shortcuts
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

app.whenReady().then(() => {
  // Check for admin privileges on Windows
  if (process.platform === 'win32') {
    require('child_process').exec('net session', (err, stdout, stderr) => {
      if (!err) {
        console.warn("\x1b[31m%s\x1b[0m", "WARNING: Running as Administrator. This may block third-party hotkeys (Discord, etc).");
      }
    });
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (serverHandle?.server) serverHandle.server.close();
  if (process.platform !== "darwin") app.quit();
});
