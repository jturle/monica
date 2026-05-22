const { contextBridge, ipcRenderer, clipboard } = require("electron");

// Split/close/tab hotkeys come through the app menu (accelerators fire even when a
// <webview> guest has keyboard focus — a plain renderer keydown listener would not).
contextBridge.exposeInMainWorld("api", {
  onSplit: (cb) => ipcRenderer.on("split", (_e, dir) => cb(dir)),
  onClosePane: (cb) => ipcRenderer.on("close-pane", () => cb()),
  onReloadPane: (cb) => ipcRenderer.on("reload-pane", () => cb()),
  onNewTab: (cb) => ipcRenderer.on("new-tab", () => cb()),
  onCloseTab: (cb) => ipcRenderer.on("close-tab", () => cb()),

  getCdpMode: () => ipcRenderer.invoke("cdp:get"),
  setCdpMode: (mode) => ipcRenderer.invoke("cdp:set", mode), // returns new {mode, port, lanIp}
  copy: (text) => clipboard.writeText(text),

  // proxy-driven panes (external CDP clients creating/closing pages)
  onProxyConnectionOpen: (cb) => ipcRenderer.on("proxy:connection-open", (_e, d) => cb(d)),
  onProxyConnectionClose: (cb) => ipcRenderer.on("proxy:connection-close", (_e, d) => cb(d.connectionId)),
  onProxyCreatePane: (cb) => ipcRenderer.on("proxy:create-pane", (_e, d) => cb(d)),
  replyCreatePane: (reqId, leafId) => ipcRenderer.send("proxy:create-pane-result", { reqId, leafId }),
  onProxyClosePane: (cb) => ipcRenderer.on("proxy:close-pane", (_e, d) => cb(d.leafId)),
});
