const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const isDev = !app.isPackaged;
const DEV_SERVER_URL = "http://localhost:3000";

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (isDev) {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "build", "index.html"));
  }
}

function getBundledTtsPaths() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "local-tts")
    : path.join(app.getAppPath(), "local-tts");

  return {
    piperPath: path.join(base, "piper.exe"),
    modelPath: path.join(base, "en_US-ryan-high.onnx"),
  };
}

function resolveTtsPaths() {
  const bundled = getBundledTtsPaths();
  return {
    piperPath: process.env.PIPER_BINARY_PATH || bundled.piperPath,
    modelPath: process.env.PIPER_MODEL_PATH || bundled.modelPath,
  };
}

ipcMain.handle("tts:speak", async (_event, text) => {
  const cleaned = typeof text === "string" ? text.trim() : "";
  if (!cleaned) {
    throw new Error("No text provided for local TTS.");
  }

  const { piperPath, modelPath } = resolveTtsPaths();
  if (!fs.existsSync(piperPath)) {
    throw new Error(`Piper binary not found at: ${piperPath}`);
  }
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Piper model not found at: ${modelPath}`);
  }

  const outputPath = path.join(
    os.tmpdir(),
    `interactive-ai-reader-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`
  );

  await new Promise((resolve, reject) => {
    const proc = spawn(piperPath, ["--model", modelPath, "--output_file", outputPath], {
      windowsHide: true,
    });

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Piper exited with code ${code}. ${stderr}`));
        return;
      }
      resolve();
    });

    proc.stdin.write(cleaned);
    proc.stdin.end();
  });

  const audioBuffer = await fs.promises.readFile(outputPath);
  await fs.promises.unlink(outputPath).catch(() => {});

  return audioBuffer.buffer.slice(
    audioBuffer.byteOffset,
    audioBuffer.byteOffset + audioBuffer.byteLength
  );
});

app.whenReady().then(() => {
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
