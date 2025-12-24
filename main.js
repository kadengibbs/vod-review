const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { startServer } = require("./server");

ipcMain.handle("app:getVersion", () => app.getVersion());

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
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (serverHandle?.server) serverHandle.server.close();
  if (process.platform !== "darwin") app.quit();
});
