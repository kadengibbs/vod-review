const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const https = require("https");
const { URL } = require("url");
const { spawn } = require("child_process");
const path = require("path");
const { startServer } = require("./server");

// Existing handler (keep)
ipcMain.handle("app:getVersion", () => app.getVersion());

// Alias handler (fixes: "No handler registered for 'getVersion'")
ipcMain.handle("getVersion", () => app.getVersion());
function sanitizeFilename(name) {
  return String(name || "installer.exe").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function guessFilenameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const last = (u.pathname.split("/").pop() || "").trim();
    return sanitizeFilename(last || "installer.exe");
  } catch {
    return "installer.exe";
  }
}

function downloadHttpsToFile(urlStr, destPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const doReq = (uStr, redirectsLeft) => {
      const req = https.get(uStr, { headers: { "User-Agent": "VOD-Review-Updater" } }, (res) => {
        // Redirect handling
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error("Redirect without location header."));
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects."));
          const nextUrl = new URL(loc, uStr).toString();
          res.resume();
          return doReq(nextUrl, redirectsLeft - 1);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed (HTTP ${res.statusCode}).`));
        }

        const file = fs.createWriteStream(destPath);
        res.pipe(file);

        file.on("finish", () => file.close(() => resolve(destPath)));
        file.on("error", (err) => {
          try { fs.unlinkSync(destPath); } catch { }
          reject(err);
        });
      });

      req.on("error", reject);
    };

    doReq(urlStr, maxRedirects);
  });
}

// Download installer to Downloads folder
ipcMain.handle("update:downloadInstaller", async (_event, { url, version } = {}) => {
  const downloadUrl = String(url || "").trim();
  if (!downloadUrl) throw new Error("Missing download URL.");

  const downloadsDir = app.getPath("downloads");
  const filenameFromUrl = guessFilenameFromUrl(downloadUrl);

  // Prefer a versioned filename if we can
  const v = String(version || "").trim();
  const preferred = v ? sanitizeFilename(`VOD.Review.Setup.${v}.exe`) : filenameFromUrl;
  const targetPath = path.join(downloadsDir, preferred);

  // Ensure we can overwrite
  try { fs.unlinkSync(targetPath); } catch { }

  await downloadHttpsToFile(downloadUrl, targetPath);
  return { filePath: targetPath };
});

// Launch installer, then quit current app
ipcMain.handle("update:installAndQuit", async (_event, { filePath } = {}) => {
  const exePath = String(filePath || "").trim();
  if (!exePath) throw new Error("Missing installer path.");
  if (!fs.existsSync(exePath)) throw new Error("Installer file not found.");

  // Launch installer normally (UI)
  spawn(exePath, [], { detached: true, stdio: "ignore" }).unref();

  // Quit current app so installer isn't blocked by running process
  app.quit();
  return { ok: true };
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
    }
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
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (serverHandle?.server) serverHandle.server.close();
  if (process.platform !== "darwin") app.quit();
});
