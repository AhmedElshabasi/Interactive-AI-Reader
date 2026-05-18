const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { sanitizeForTTS, splitTextForTTS } = require("./ttsSanitize.cjs");

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

function runPiper(piperPath, modelPath, lines, outputPath) {
  return new Promise((resolve, reject) => {
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

    for (const line of lines) {
      proc.stdin.write(Buffer.from(`${line}\n`, "utf8"));
    }
    proc.stdin.end();
  });
}

ipcMain.handle("tts:speak", async (_event, text) => {
  const lines = splitTextForTTS(typeof text === "string" ? text : "", 500);
  if (lines.length === 0) {
    throw new Error("No text provided for local TTS.");
  }

  const totalChars = lines.reduce((n, l) => n + l.length, 0);
  console.log(`[Piper] Synthesizing ${totalChars} chars in ${lines.length} segment(s)...`);

  const { piperPath, modelPath } = resolveTtsPaths();
  if (!fs.existsSync(piperPath)) {
    throw new Error(`Piper binary not found at: ${piperPath}`);
  }
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Piper model not found at: ${modelPath}`);
  }

  const segmentPaths = [];
  const audioBuffers = [];

  try {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const outputPath = path.join(
        os.tmpdir(),
        `interactive-ai-reader-${Date.now()}-${i}-${Math.random().toString(16).slice(2)}.wav`
      );

      try {
        await runPiper(piperPath, modelPath, [line], outputPath);
        segmentPaths.push(outputPath);
        console.log(`[Piper] Segment ${i + 1}/${lines.length} OK (${line.length} chars)`);

        const audioBuffer = await fs.promises.readFile(outputPath);
        audioBuffers.push(
          audioBuffer.buffer.slice(
            audioBuffer.byteOffset,
            audioBuffer.byteOffset + audioBuffer.byteLength
          )
        );
      } catch (err) {
        console.warn(
          `[Piper] Segment ${i + 1}/${lines.length} skipped (${line.length} chars):`,
          err.message || err
        );
      }
    }

    if (audioBuffers.length === 0) {
      throw new Error("All Piper segments failed (unicode or espeak error on every line).");
    }

    return audioBuffers.length === 1 ? audioBuffers[0] : audioBuffers;
  } finally {
    await Promise.all(segmentPaths.map((p) => fs.promises.unlink(p).catch(() => {})));
  }
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
