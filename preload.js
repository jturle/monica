const { contextBridge, ipcRenderer } = require("electron");

// Split/close hotkeys come through the app menu (accelerators fire even when a
// <webview> guest has keyboard focus — a plain renderer keydown listener would not).
contextBridge.exposeInMainWorld("api", {
  onSplit: (cb) => ipcRenderer.on("split", (_e, dir) => cb(dir)),
  onClosePane: (cb) => ipcRenderer.on("close-pane", () => cb()),
});
