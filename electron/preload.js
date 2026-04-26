const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  openVideoDialog: () => ipcRenderer.invoke("dialog:openVideo"),
  probeVideo: (videoPath) => ipcRenderer.invoke("video:probe", videoPath),
  saveProject: (project) => ipcRenderer.invoke("project:save", project),
  loadProject: () => ipcRenderer.invoke("project:load"),
  pathToMediaUrl: (filePath) => ipcRenderer.invoke("util:pathToMediaUrl", filePath),
  pickExportPath: (options) => ipcRenderer.invoke("export:pickOutput", options),
  convertRecordingToMp4: (payload) => ipcRenderer.invoke("export:convertRecording", payload)
});
