const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");

// --- CDP: one endpoint, every pane/webview shows up as an attachable target ---
// Launch the whole app with remote debugging so agent-browser / Playwright /
// chrome-devtools-mcp can attach to localhost:9222 and pick a target by id.
app.commandLine.appendSwitch("remote-debugging-port", "9222");
// Chromium 111+ blocks CDP websocket attach unless the origin is allow-listed.
// Without this, `curl /json` works but external clients can't actually drive a target.
app.commandLine.appendSwitch("remote-allow-origins", "*");

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    backgroundColor: "#0b0e14",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      // Panes are <webview> elements living in the DOM so tiling/resize is just CSS.
      webviewTag: true,
    },
  });
  win.loadFile("renderer/index.html");
  return win;
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const send = (win, ch, ...args) => win && win.webContents.send(ch, ...args);

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "Pane",
      submenu: [
        {
          label: "Split Right (side-by-side)",
          accelerator: "CmdOrCtrl+D",
          click: (_i, win) => send(win, "split", "row"),
        },
        {
          label: "Split Down (stacked)",
          accelerator: "CmdOrCtrl+Shift+D",
          click: (_i, win) => send(win, "split", "col"),
        },
        { type: "separator" },
        {
          label: "Close Pane",
          accelerator: "CmdOrCtrl+W",
          click: (_i, win) => send(win, "close-pane"),
        },
      ],
    },
    { role: "viewMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
