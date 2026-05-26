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

  // Generic settings (the new feature toggles).
  getSettings: () => ipcRenderer.invoke("settings:get"),
  patchSettings: (patch) => ipcRenderer.send("settings:patch", patch),

  // Pin / unpin a pane (skip auto-close-stale + close-on-disconnect).
  setPinned: (leafId, isPinned) => ipcRenderer.send("pane:set-pinned", leafId, !!isPinned),

  // Snapshot a pane to ~/Downloads. Renderer ships the PNG bytes (Uint8Array).
  snapshotPane: (leafId, name, pngBytes) => ipcRenderer.invoke("pane:snapshot", leafId, name, pngBytes),

  // Proxy activity bumps (one event per pane, throttled in the proxy).
  onProxyActivity: (cb) => ipcRenderer.on("proxy:activity", (_e, d) => cb(d.leafId)),
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
