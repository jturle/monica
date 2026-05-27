const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, nativeTheme, webContents } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const proxy = require("./proxy");

// Brand the app as "monica" (not "Electron"). Must run before any getPath() call so
// userData/storage land under …/monica. In dev the macOS *menu-bar title* still reads
// "Electron" (it comes from the prebuilt Electron.app bundle, read before JS runs) —
// `yarn package` produces a fully-branded monica.app for that.
app.setName("monica");
const ICON_PNG = path.join(__dirname, "build", "icon.png");

const PUBLIC_PORT = proxy.PUBLIC_PORT; // 9222 — what clients/tunnels connect to
const SETTINGS_FILE = path.join(app.getPath("userData"), "monica-settings.json");

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; }
}
function writeSettings(next) {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2)); } catch {}
}
function firstLanIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "0.0.0.0";
}
const addrFor = (mode) => (mode === "lan" ? "0.0.0.0" : "127.0.0.1");

let settings = readSettings();
function savePref(patch) { settings = { ...settings, ...patch }; writeSettings(settings); }
let cdpMode = settings.cdpMode === "lan" ? "lan" : "local";

// Defaults + sanitisation for the values exposed via settings:get/patch. Anything
// that affects the proxy (closeOnDisconnect / slowMo) is forwarded into the proxy
// at runtime via proxy.setSettings whenever it changes.
const SETTINGS_DEFAULTS = {
  closeOnDisconnect: "close",   // "close" | "retain" | "delay"
  closeDelaySeconds: 10,
  autoCloseStaleMinutes: 0,     // 0 = off
  slowMo: 0,                    // ms delay on user-facing CDP commands
};
const intPref = (v, fallback) => (Number.isFinite(v) ? Math.max(0, v | 0) : fallback);
function effectiveSettings() {
  return {
    cdpMode,
    view: settings.view === "tabs" ? "tabs" : "grid",
    theme: ["light", "dark"].includes(settings.theme) ? settings.theme : "system",
    closeOnDisconnect: ["close", "retain", "delay"].includes(settings.closeOnDisconnect)
      ? settings.closeOnDisconnect : SETTINGS_DEFAULTS.closeOnDisconnect,
    closeDelaySeconds: intPref(settings.closeDelaySeconds, SETTINGS_DEFAULTS.closeDelaySeconds),
    autoCloseStaleMinutes: intPref(settings.autoCloseStaleMinutes, SETTINGS_DEFAULTS.autoCloseStaleMinutes),
    slowMo: intPref(settings.slowMo, SETTINGS_DEFAULTS.slowMo),
  };
}

// Which panes the user has "pinned" — auto-close-stale and named-session close-on-
// disconnect both skip these. Renderer is the source of truth; we mirror via IPC.
const pinned = new Set();

// --- debug log: written to the project dir (truncated each launch) so it's easy
// to tail/inspect. Logs HTTP hits, CDP requests, connections, and pane/tab churn.
const LOG_FILE = path.join(__dirname, "monica-debug.log");
const logStream = fs.createWriteStream(LOG_FILE, { flags: "w" });
function log(scope, ...parts) {
  try { logStream.write(new Date().toISOString() + " [" + scope + "] " + parts.join(" ") + "\n"); } catch {}
}
log("app", "started; cdp mode=" + cdpMode);

// Real Chromium DevTools stays INTERNAL and local-only; the proxy owns the public
// port and decides whether to expose it to the LAN.
app.commandLine.appendSwitch("remote-debugging-port", "9223");
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
// Chromium 111+ requires the connecting origin to be allow-listed; the proxy (and
// the clients behind it) connect from arbitrary origins.
app.commandLine.appendSwitch("remote-allow-origins", "*");

let mainWindow = null;

function createWindow() {
  // Match the pre-paint window background to the resolved theme so launch isn't a flash.
  const dark = settings.theme === "dark" || (settings.theme !== "light" && nativeTheme.shouldUseDarkColors);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    backgroundColor: dark ? "#1a2030" : "#c1cedb",
    icon: ICON_PNG,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      webviewTag: true,
    },
  });
  mainWindow.loadFile("renderer/index.html");
  return mainWindow;
}

// ---- proxy <-> renderer bridge ---------------------------------------------

let reqSeq = 0;
const createResolvers = new Map();
ipcMain.on("proxy:create-pane-result", (_e, { reqId, leafId }) => {
  const resolve = createResolvers.get(reqId);
  if (resolve) { createResolvers.delete(reqId); resolve(leafId); }
});

function createPaneInRenderer(connectionId, url) {
  return new Promise((resolve) => {
    const reqId = ++reqSeq;
    createResolvers.set(reqId, resolve);
    safeSend("proxy:create-pane", { connectionId, url, reqId });
    setTimeout(() => {
      if (createResolvers.has(reqId)) { createResolvers.delete(reqId); resolve(null); }
    }, 10000);
  });
}

// Pane webContents registry. Renderer tells us each pane's guest webContents id
// on attach, so main can drive webContents-level APIs (printToPDF) directly —
// the <webview>.printToPDF path in the renderer fails ("GUEST_VIEW_MANAGER_CALL
// … Printing failed") when the pane isn't currently visible.
const paneWcIds = new Map();
ipcMain.on("pane:register-wc", (_e, leafId, wcId) => { paneWcIds.set(leafId, wcId); });
ipcMain.on("pane:unregister-wc", (_e, leafId) => { paneWcIds.delete(leafId); });

// CDP Page.printToPDF params → Electron webContents.printToPDF options, with
// CDP's documented defaults (= Chrome's "Save as PDF" UI defaults) for anything
// the caller didn't specify. Without them, Electron's own defaults can leak
// background colours and auto-add headers/footers.
function cdpToElectronPDFOptions(p) {
  p = p && typeof p === "object" ? p : {};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const bool = (v, d) => (typeof v === "boolean" ? v : d);
  const o = {
    landscape: bool(p.landscape, false),
    displayHeaderFooter: bool(p.displayHeaderFooter, false),
    printBackground: bool(p.printBackground, false),
    scale: num(p.scale, 1),
    preferCSSPageSize: bool(p.preferCSSPageSize, false),
    pageRanges: typeof p.pageRanges === "string" ? p.pageRanges : "",
    pageSize: {
      // CDP is inches; Electron pageSize is microns (1in = 25400µm).
      width: Math.round(num(p.paperWidth, 8.5) * 25400),
      height: Math.round(num(p.paperHeight, 11) * 25400),
    },
    margins: {
      top: num(p.marginTop, 0.4),
      bottom: num(p.marginBottom, 0.4),
      left: num(p.marginLeft, 0.4),
      right: num(p.marginRight, 0.4),
    },
  };
  if (typeof p.headerTemplate === "string") o.headerTemplate = p.headerTemplate;
  if (typeof p.footerTemplate === "string") o.footerTemplate = p.footerTemplate;
  return o;
}

// Safe send to the host renderer. The renderer's frame can be transiently absent
// (mid-reload, window closing, guest crash propagation) while webContents itself
// is still truthy — direct .send() then throws "Render frame was disposed before
// WebFrameMain could be accessed". With high-frequency proxy:activity events that
// gap is hit easily, so every host send goes through here.
function safeSend(channel, payload) {
  const wc = mainWindow?.webContents;
  if (!wc || wc.isDestroyed()) return;
  try { wc.send(channel, payload); } catch {}
}

const proxyHooks = {
  onConnectionOpen: (connectionId, label) => safeSend("proxy:connection-open", { connectionId, label }),
  onConnectionLabel: (connectionId, label) => safeSend("proxy:connection-label", { connectionId, label }),
  onConnectionClose: (connectionId) => safeSend("proxy:connection-close", { connectionId }),
  createPane: async (connectionId, url) => ({ leafId: await createPaneInRenderer(connectionId, url) }),
  closePane: (leafId) => safeSend("proxy:close-pane", { leafId }),
  onActivity: (leafId) => safeSend("proxy:activity", { leafId }),
  isPinned: (leafId) => pinned.has(leafId),
  printToPDF: async (leafId, options) => {
    const wcId = paneWcIds.get(leafId);
    if (!wcId) throw new Error("pane has no registered webContents");
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) throw new Error("pane webContents gone");
    const buf = await wc.printToPDF(cdpToElectronPDFOptions(options));
    log("pdf", "pane=" + leafId + " " + buf.length + " bytes");
    return buf.toString("base64");
  },
};

// ---- CDP bind controls -----------------------------------------------------

ipcMain.on("clipboard:write", (_e, text) => clipboard.writeText(String(text ?? "")));
ipcMain.on("monica:log", (_e, scope, msg) => log(String(scope || "ui"), String(msg ?? "")));

let quitDialogOpen = false;
ipcMain.on("app:confirm-quit", async (e) => {
  if (quitDialogOpen) return;
  quitDialogOpen = true;
  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
    type: "question",
    buttons: ["Cancel", "Quit monica"],
    defaultId: 1,
    cancelId: 0,
    message: "Close monica?",
    detail: "No tabs are open.",
  });
  quitDialogOpen = false;
  if (response === 1) app.quit();
});

ipcMain.handle("cdp:get", () => ({ mode: cdpMode, port: PUBLIC_PORT, lanIp: firstLanIPv4() }));

// View mode (grid|tabs) persists in the same settings file as the CDP bind.
ipcMain.handle("view:get", () => (settings.view === "tabs" ? "tabs" : "grid"));
ipcMain.on("view:set", (_e, mode) => savePref({ view: mode === "grid" ? "grid" : "tabs" }));

// Theme (system|light|dark) — default system (follow the OS); resolved in the renderer.
ipcMain.handle("theme:get", () => (["light", "dark"].includes(settings.theme) ? settings.theme : "system"));
ipcMain.on("theme:set", (_e, t) => savePref({ theme: ["light", "dark"].includes(t) ? t : "system" }));

// Generic settings bag (for the new feature toggles: closeOnDisconnect, slowMo, …).
// Proxy-affecting fields are forwarded into the running proxy immediately.
ipcMain.handle("settings:get", () => effectiveSettings());
ipcMain.on("settings:patch", (_e, patch) => {
  if (!patch || typeof patch !== "object") return;
  const clean = {};
  if (["close", "retain", "delay"].includes(patch.closeOnDisconnect)) clean.closeOnDisconnect = patch.closeOnDisconnect;
  if (Number.isFinite(patch.closeDelaySeconds))     clean.closeDelaySeconds     = Math.max(0, patch.closeDelaySeconds | 0);
  if (Number.isFinite(patch.autoCloseStaleMinutes)) clean.autoCloseStaleMinutes = Math.max(0, patch.autoCloseStaleMinutes | 0);
  if (Number.isFinite(patch.slowMo))                clean.slowMo                = Math.max(0, patch.slowMo | 0);
  if (!Object.keys(clean).length) return;
  savePref(clean);
  proxy.setSettings?.(effectiveSettings());
  log("app", "settings " + JSON.stringify(clean));
});

// Pin / unpin a pane — pinned panes skip auto-close-stale and close-on-disconnect.
ipcMain.on("pane:set-pinned", (_e, leafId, isPinned) => {
  if (isPinned) pinned.add(leafId); else pinned.delete(leafId);
});

// Pane snapshot. We do the capture in MAIN (not the renderer) because
// webview.capturePage() in the host renderer has hit a V8/GPU fatal on macOS
// (Empty MaybeLocal → render frame disposed). The renderer just hands us the
// guest webContents id; main captures + writes the PNG.
ipcMain.handle("pane:snapshot", async (_e, leafId, name, wcId) => {
  try {
    const wc = typeof wcId === "number" ? webContents.fromId(wcId) : null;
    if (!wc || wc.isDestroyed()) return { error: "webContents not available" };
    const img = await wc.capturePage();
    const buf = img && img.toPNG ? img.toPNG() : null;
    if (!buf || !buf.length) return { error: "empty capture" };
    const dir = app.getPath("downloads");
    const safe = String(name || ("pane-" + leafId)).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || ("pane-" + leafId);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
    const file = path.join(dir, "monica-" + safe + "-" + ts + ".png");
    await fs.promises.writeFile(file, buf);
    log("snap", "saved " + file + " (" + buf.length + " bytes)");
    return { file };
  } catch (e) {
    log("snap", "error " + String(e?.message || e));
    return { error: String(e?.message || e) };
  }
});

ipcMain.handle("cdp:set", async (e, requested) => {
  const mode = requested === "lan" ? "lan" : "local";
  if (mode === cdpMode) return { mode: cdpMode, port: PUBLIC_PORT, lanIp: firstLanIPv4() };
  const lan = mode === "lan";
  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
    type: lan ? "warning" : "question",
    buttons: ["Cancel", lan ? "Expose on LAN" : "Switch to local"],
    defaultId: lan ? 0 : 1,
    cancelId: 0,
    title: "Re-bind CDP endpoint",
    message: lan ? "Expose CDP to your local network?" : "Switch CDP to local only?",
    detail: lan
      ? "The CDP endpoint will rebind to 0.0.0.0:" + PUBLIC_PORT +
        " — reachable by ANY device on your network, which could fully drive your browsers. Only do this on a trusted network. (Active connections will drop.)"
      : "The CDP endpoint will rebind to 127.0.0.1:" + PUBLIC_PORT + " (local only). Active connections will drop.",
  });
  if (response !== 1) return { mode: cdpMode, port: PUBLIC_PORT, lanIp: firstLanIPv4() };
  cdpMode = mode;
  savePref({ cdpMode: mode });
  await proxy.setBind(addrFor(mode)); // live rebind — no relaunch
  log("app", "cdp rebind -> " + mode);
  return { mode: cdpMode, port: PUBLIC_PORT, lanIp: firstLanIPv4() };
});

// ---- menu ------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === "darwin";
  const send = (win, ch, ...args) => win && win.webContents.send(ch, ...args);

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "Tab",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: (_i, win) => send(win, "new-tab") },
        { label: "Close Tab", accelerator: "CmdOrCtrl+Shift+W", click: (_i, win) => send(win, "close-tab") },
      ],
    },
    {
      label: "Pane",
      submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+Left", click: (_i, win) => send(win, "nav-back") },
        { label: "Forward", accelerator: "CmdOrCtrl+Right", click: (_i, win) => send(win, "nav-forward") },
        { type: "separator" },
        { label: "Reload Pane", accelerator: "CmdOrCtrl+R", click: (_i, win) => send(win, "reload-pane") },
        { label: "Close Pane", accelerator: "CmdOrCtrl+W", click: (_i, win) => send(win, "close-pane") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle Grid / Tabs", accelerator: "CmdOrCtrl+G", click: (_i, win) => send(win, "toggle-view") },
        { type: "separator" },
        { label: "Reload App", accelerator: "CmdOrCtrl+Shift+R", role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Dock icon + About panel branding (works in dev; the menu-bar title needs a packaged app).
  if (process.platform === "darwin" && app.dock) {
    try { app.dock.setIcon(ICON_PNG); } catch {}
  }
  app.setAboutPanelOptions({
    applicationName: "monica",
    applicationVersion: app.getVersion(),
    credits: "A cockpit for the browsers your agents drive.",
    copyright: "© 2026 James Turle",
    iconPath: ICON_PNG,
  });
  buildMenu();
  createWindow();
  try {
    await proxy.start({ bindAddr: addrFor(cdpMode), hooks: proxyHooks, log, settings: effectiveSettings() });
  } catch (err) {
    dialog.showErrorBox("monica CDP proxy failed to start", String(err?.message || err));
  }
  // Auto-close-stale: every 30s, ask the proxy to prune anything older than the
  // configured threshold (skipping pinned panes). Setting 0 disables.
  setInterval(() => {
    const m = effectiveSettings().autoCloseStaleMinutes;
    if (m <= 0) return;
    proxy.sweepStale?.(Date.now() - m * 60000, (leafId) => pinned.has(leafId));
  }, 30000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
