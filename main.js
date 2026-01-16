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

// Dynamic keybinds (key -> action)
// Dynamic keybinds (key -> action)
let keyToAction = {};
let keybindsArmed = false;
let isTyping = false;

async function createWindow() {
  // Start local server so YouTube sees an http(s) origin instead of file://
  serverHandle = await startServer(3000);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, "icon.ico"),
    autoHideMenuBar: process.env.DEV_UI !== "1"
  });

  if (process.env.DEV_UI !== "1") {
    win.setMenu(null);
  }

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
