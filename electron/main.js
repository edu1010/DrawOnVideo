const { app, BrowserWindow, protocol, net } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const { registerIpcHandlers } = require("./ipc/registerIpc");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "local-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

let mediaProtocolRegistered = false;

function registerLocalMediaProtocol() {
  if (mediaProtocolRegistered) {
    return;
  }

  mediaProtocolRegistered = true;

  protocol.handle("local-media", (request) => {
    try {
      const parsedUrl = new URL(request.url);
      const encodedPath = parsedUrl.searchParams.get("path");

      if (!encodedPath) {
        return new Response("Missing local media path.", { status: 400 });
      }

      const filePath = decodeURIComponent(encodedPath);
      return net.fetch(pathToFileURL(filePath).toString(), {
        method: request.method,
        headers: request.headers
      });
    } catch {
      return new Response("Invalid local media request.", { status: 400 });
    }
  });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    title: "DrawOnVideo",
    width: 1520,
    height: 920,
    minWidth: 1180,
    minHeight: 700,
    backgroundColor: "#0b1018",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  registerLocalMediaProtocol();
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
