// Exposes a minimal, safe bridge to the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("anya", {
  onShow: (cb) => ipcRenderer.on("anya:show", (_e, data) => cb(data)),
  onArtwork: (cb) => ipcRenderer.on("anya:artwork", (_e, data) => cb(data)),
  startDrag: () => ipcRenderer.send("anya:drag-start"),
  moveDrag: (data) => ipcRenderer.send("anya:drag-move", data),
  endDrag: () => ipcRenderer.send("anya:drag-end"),
});
