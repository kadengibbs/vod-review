const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { startServer } = require("./server");

// Existing handler (keep)
ipcMain.handle("app:getVersion", () => app.getVersion());

// Alias handler (fixes: "No handler registered for 'getVersion'")
ipcMain.handle("getVersion", () => app.getVersion());

let serverHandle = null;

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

    const key = String(input.key || "").toLowerCase();
    if (!["g", "h", "j", "k", "l"].includes(key)) return;

    // Prevent YouTube / HTML5 players from handling it
    event.preventDefault();

    // Forward to renderer
    win.webContents.send("app:customKeybind", key);
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (serverHandle?.server) serverHandle.server.close();
  if (process.platform !== "darwin") app.quit();
});
