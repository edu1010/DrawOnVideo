const { ipcMain, dialog, app } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const { probeVideo } = require("../services/videoProbe");
const { convertRecordingToMp4 } = require("../services/exportService");

let handlersRegistered = false;

function parseFileNameWithoutExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function extensionFromFormat(format) {
  const safe = String(format || "").toLowerCase();
  if (safe === "mov") {
    return "mov";
  }
  if (safe === "webm") {
    return "webm";
  }
  return "mp4";
}

function ensureOutputExtension(filePath, format) {
  if (!filePath) {
    return filePath;
  }

  const expectedExt = `.${extensionFromFormat(format)}`;
  const currentExt = path.extname(filePath).toLowerCase();

  if (currentExt === expectedExt) {
    return filePath;
  }

  if (!currentExt) {
    return `${filePath}${expectedExt}`;
  }

  return `${filePath.slice(0, -currentExt.length)}${expectedExt}`;
}

function registerIpcHandlers() {
  if (handlersRegistered) {
    return;
  }

  handlersRegistered = true;

  ipcMain.handle("dialog:openVideo", async () => {
    const result = await dialog.showOpenDialog({
      title: "Open video",
      properties: ["openFile"],
      filters: [
        { name: "Video", extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v"] },
        { name: "All files", extensions: ["*"] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle("video:probe", async (_, videoPath) => {
    if (!videoPath) {
      throw new Error("Missing video path.");
    }

    return probeVideo(videoPath);
  });

  ipcMain.handle("project:save", async (_, project) => {
    const defaultBaseName = project?.videoPath
      ? `${parseFileNameWithoutExt(project.videoPath)}.vpaint.json`
      : "untitled.vpaint.json";

    const result = await dialog.showSaveDialog({
      title: "Save project",
      defaultPath: path.join(app.getPath("documents"), defaultBaseName),
      filters: [{ name: "Video Paint Project", extensions: ["json"] }]
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    const payload = JSON.stringify(project, null, 2);
    await fs.writeFile(result.filePath, payload, "utf8");

    return result.filePath;
  });

  ipcMain.handle("project:load", async () => {
    const result = await dialog.showOpenDialog({
      title: "Open project",
      properties: ["openFile"],
      filters: [{ name: "Video Paint Project", extensions: ["json"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const filePath = result.filePaths[0];
    const raw = await fs.readFile(filePath, "utf8");
    const project = JSON.parse(raw);

    return { filePath, project };
  });

  ipcMain.handle("util:pathToMediaUrl", async (_, filePath) => {
    if (!filePath) {
      return null;
    }

    return `local-media://video?path=${encodeURIComponent(filePath)}`;
  });

  ipcMain.handle("export:pickOutput", async (_, options = {}) => {
    const suggestedName = typeof options === "string" ? options : options.suggestedName;
    const format = typeof options === "string" ? "mp4" : (options.format || "mp4");
    const ext = extensionFromFormat(format);
    const result = await dialog.showSaveDialog({
      title: "Export annotated video",
      defaultPath: path.join(app.getPath("videos"), suggestedName || `annotated-output.${ext}`),
      filters: [
        { name: "MP4 Video", extensions: ["mp4"] },
        { name: "QuickTime MOV", extensions: ["mov"] },
        { name: "WebM Video", extensions: ["webm"] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    return ensureOutputExtension(result.filePath, format);
  });

  ipcMain.handle("export:convertRecording", async (_, payload) => {
    const {
      recordingBytes,
      sourceVideoPath,
      outputPath,
      fps = 30,
      includeAudio = true,
      preset = "medium",
      encoderMode = "auto",
      bitrateMbps = 12,
      outputFormat = "mp4",
      outputWidth,
      outputHeight,
      audioBitrate = "192k"
    } = payload || {};

    if (!recordingBytes || !outputPath) {
      throw new Error("Missing export parameters.");
    }

    const tempDir = path.join(app.getPath("temp"), "drawonvideo");
    await fs.mkdir(tempDir, { recursive: true });

    const tempInputPath = path.join(tempDir, `recording-${Date.now()}.webm`);
    await fs.writeFile(tempInputPath, Buffer.from(recordingBytes));

    try {
      await convertRecordingToMp4({
        recordingPath: tempInputPath,
        sourceVideoPath,
        outputPath,
        fps,
        includeAudio,
        preset,
        encoderMode,
        bitrateMbps,
        outputFormat,
        outputWidth,
        outputHeight,
        audioBitrate
      });
      return { outputPath };
    } finally {
      await fs.rm(tempInputPath, { force: true });
    }
  });
}

module.exports = {
  registerIpcHandlers
};
