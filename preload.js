const { contextBridge, ipcRenderer } = require("electron");

// View/close/tab hotkeys come through the app menu (accelerators fire even when a
// <webview> guest has keyboard focus — a plain renderer keydown listener would not).
contextBridge.exposeInMainWorld("api", {
  onToggleView: (cb) => ipcRenderer.on("toggle-view", () => cb()),
  onClosePane: (cb) => ipcRenderer.on("close-pane", () => cb()),
  onReloadPane: (cb) => ipcRenderer.on("reload-pane", () => cb()),
  onNavBack: (cb) => ipcRenderer.on("nav-back", () => cb()),
  onNavForward: (cb) => ipcRenderer.on("nav-forward", () => cb()),
  onNewTab: (cb) => ipcRenderer.on("new-tab", () => cb()),
  onCloseTab: (cb) => ipcRenderer.on("close-tab", () => cb()),

  getCdpMode: () => ipcRenderer.invoke("cdp:get"),
  setCdpMode: (mode) => ipcRenderer.invoke("cdp:set", mode), // returns new {mode, port, lanIp}
  getViewPref: () => ipcRenderer.invoke("view:get"),
  setViewPref: (mode) => ipcRenderer.send("view:set", mode),
  getThemePref: () => ipcRenderer.invoke("theme:get"),
  setThemePref: (t) => ipcRenderer.send("theme:set", t),
  copy: (text) => ipcRenderer.send("clipboard:write", text), // clipboard isn't available in a sandboxed preload
  confirmQuit: () => ipcRenderer.send("app:confirm-quit"),
  log: (scope, msg) => ipcRenderer.send("monica:log", scope, msg),

  // proxy-driven panes (external CDP clients creating/closing pages)
  onProxyConnectionOpen: (cb) => ipcRenderer.on("proxy:connection-open", (_e, d) => cb(d)),
  onProxyConnectionLabel: (cb) => ipcRenderer.on("proxy:connection-label", (_e, d) => cb(d.connectionId, d.label)),
  onProxyConnectionClose: (cb) => ipcRenderer.on("proxy:connection-close", (_e, d) => cb(d.connectionId)),
  onProxyCreatePane: (cb) => ipcRenderer.on("proxy:create-pane", (_e, d) => cb(d)),
  replyCreatePane: (reqId, leafId) => ipcRenderer.send("proxy:create-pane-result", { reqId, leafId }),
  onProxyClosePane: (cb) => ipcRenderer.on("proxy:close-pane", (_e, d) => cb(d.leafId)),
});
