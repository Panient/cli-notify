// Anya Notifier - Electron main process.
// A REMINDER, not a desktop pet: hidden until a turn completes, shows a large
// draggable Anya reminder, and disappears once the user returns to the
// terminal (or the terminal window closes). Never steals focus.

const { app, BrowserWindow, screen, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");
const {
  compareEventsByCompletion,
  createPendingNotification,
  buildNotificationPresentation,
  resolvePendingNotifications,
} = require("./notification-state");

const STATE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "AI CLI Notify");
const QUEUE_DIR = path.join(STATE_DIR, "events");
const CONFIG_PATH = path.join(STATE_DIR, "anya-config.json");
const POSITION_PATH = path.join(STATE_DIR, "anya-position.json");
const ARTWORK_PATH = path.join(STATE_DIR, "artwork", "anya.png");
const ARTWORK_URL = "https://www.pngmart.com/files/23/Anya-PNG-Isolated-File.png";
const MAX_ARTWORK_BYTES = 4 * 1024 * 1024;

let win = null;
let watcher = null;
let tickTimer = null;
let positionSaveTimer = null;
let positionPollTimer = null;
let lastObservedPosition = null;
let dragOrigin = null;
let state = "hidden"; // hidden | celebrating
let mutexProcess = null;
let windowQueryInFlight = false;
let windowQueryHandler = null;
let windowQueryBuffer = "";
let workerHandshakeHandler = null;
let nativeWorker = null;
let nativeWorkerStarted = false;
const windowQuerySource = fs.readFileSync(path.join(__dirname, "window-query.ps1"), "utf8");
let rendererReady = false;
let renderedPresentationKey = null;
let currentForeground = null;
let fixedWindowSize = null;
let pending = []; // { windowHandle, windowProcessId, windowProcessStartTicks, source, aborted, leftTerminal, fallbackExpiry }
let artworkDataUrl = readCachedArtwork();

const config = loadConfig();

function loadConfig() {
  const defaults = {
    enabled: true,
    expandedWidth: 420,
    expandedHeight: 430,
    // Only a multi-platform summary needs a wider viewport.
    maxExpandedWidth: 560,
    marginX: 20,
    marginY: 22,
    fallbackExpireMs: 30 * 60 * 1000,
    tickMs: 1500,
  };
  try {
    const user = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return Object.assign(defaults, user);
  } catch {
    return defaults;
  }
}

function ensureQueueDir() {
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  } catch {}
}

function readSavedPosition() {
  try {
    const value = JSON.parse(fs.readFileSync(POSITION_PATH, "utf8"));
    if (Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y)) {
      return { x: value.x, y: value.y };
    }
  } catch {}
  return null;
}

let savedPosition = readSavedPosition();

function writeSavedPosition(immediate = false) {
  if (!win) return;
  if (positionSaveTimer) clearTimeout(positionSaveTimer);
  if (immediate) {
    positionSaveTimer = null;
    const [currentX, currentY] = win.getPosition();
    writePositionFile(currentX, currentY);
    return;
  }
  positionSaveTimer = setTimeout(() => {
    positionSaveTimer = null;
    if (!win) return;
    const [currentX, currentY] = win.getPosition();
    writePositionFile(currentX, currentY);
  }, 250);
}

function writePositionFile(x, y) {
  const temporaryPath = `${POSITION_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(POSITION_PATH), { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify({ x, y }), { encoding: "utf8", flag: "wx" });
    try {
      fs.renameSync(temporaryPath, POSITION_PATH);
    } catch {
      try { fs.unlinkSync(POSITION_PATH); } catch {}
      fs.renameSync(temporaryPath, POSITION_PATH);
    }
    savedPosition = { x, y };
  } catch {
    try { fs.unlinkSync(temporaryPath); } catch {}
  }
}

function observeWindowPosition() {
  if (!win) return;
  const [x, y] = win.getPosition();
  if (lastObservedPosition && lastObservedPosition.x === x && lastObservedPosition.y === y) return;
  lastObservedPosition = { x, y };
  writeSavedPosition();
}

function isWindowSender(event) {
  return Boolean(win && event.sender && event.sender.id === win.webContents.id);
}

ipcMain.on("anya:drag-start", (event) => {
  if (!isWindowSender(event) || !fixedWindowSize) return;
  const [x, y] = win.getPosition();
  dragOrigin = { x, y, width: fixedWindowSize.width, height: fixedWindowSize.height };
});

ipcMain.on("anya:drag-move", (event, data = {}) => {
  if (!isWindowSender(event) || !dragOrigin) return;
  const dx = Number(data.dx);
  const dy = Number(data.dy);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  // Dragging is a pure translation. Never recompute content dimensions here,
  // even if the pointer crosses displays with different scale factors.
  win.setBounds({
    x: Math.round(dragOrigin.x + dx),
    y: Math.round(dragOrigin.y + dy),
    width: dragOrigin.width,
    height: dragOrigin.height,
  }, false);
  writeSavedPosition();
});

ipcMain.on("anya:drag-end", (event) => {
  if (!isWindowSender(event)) return;
  dragOrigin = null;
  writeSavedPosition(true);
});

function isValidPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > MAX_ARTWORK_BYTES) return false;
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 4096 && height <= 4096;
}

function readCachedArtwork() {
  try {
    const buffer = fs.readFileSync(ARTWORK_PATH);
    return isValidPng(buffer) ? `data:image/png;base64,${buffer.toString("base64")}` : null;
  } catch {
    return null;
  }
}

function downloadArtwork() {
  return new Promise((resolve, reject) => {
    const request = https.get(ARTWORK_URL, {
      headers: { "User-Agent": "AI-CLI-Notify/1.0" },
      timeout: 10000,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Artwork server returned HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_ARTWORK_BYTES) {
          response.destroy(new Error("Artwork file exceeds the 4 MB limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (!isValidPng(buffer)) {
          reject(new Error("Artwork response is not a supported PNG image"));
          return;
        }
        resolve(buffer);
      });
    });
    request.on("timeout", () => request.destroy(new Error("Artwork download timed out")));
    request.on("error", reject);
  });
}

async function ensureArtwork() {
  if (artworkDataUrl) return;
  const buffer = await downloadArtwork();
  fs.mkdirSync(path.dirname(ARTWORK_PATH), { recursive: true });
  const temporaryPath = `${ARTWORK_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, buffer, { flag: "wx" });
  try {
    fs.renameSync(temporaryPath, ARTWORK_PATH);
  } catch {
    try { fs.unlinkSync(ARTWORK_PATH); } catch {}
    fs.renameSync(temporaryPath, ARTWORK_PATH);
  }
  artworkDataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  if (win && rendererReady) win.webContents.send("anya:artwork", { dataUrl: artworkDataUrl });
}

// One long-lived helper owns the singleton mutex and answers Win32 window
// queries over a pipe. Do not spawn PowerShell for every notification tick.
function startNativeWorker() {
  if (nativeWorkerStarted) return nativeWorker;
  const workerPath = path.join(__dirname, "window-worker.ps1");
  nativeWorkerStarted = true;
  nativeWorker = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", workerPath,
  ], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    env: {
      ...process.env,
      AI_CLI_NOTIFY_MUTEX_NAME: process.env.AI_CLI_NOTIFY_MUTEX_NAME || "Local\\AiCliNotifyFrontend",
      AI_CLI_NOTIFY_WINDOW_QUERY: windowQuerySource,
    },
  });
  nativeWorker.stdout.setEncoding("utf8");
  nativeWorker.stdout.on("data", (chunk) => {
    windowQueryBuffer += chunk;
    let newline;
    while ((newline = windowQueryBuffer.indexOf("\n")) >= 0) {
      const line = windowQueryBuffer.slice(0, newline).trim();
      windowQueryBuffer = windowQueryBuffer.slice(newline + 1);
      if (!line) continue;
      if (workerHandshakeHandler) {
        const handler = workerHandshakeHandler;
        workerHandshakeHandler = null;
        handler(line);
      } else if (windowQueryHandler) {
        const handler = windowQueryHandler;
        windowQueryHandler = null;
        handler(line);
      }
    }
  });
  nativeWorker.on("error", () => {
    if (nativeWorkerStarted) app.quit();
  });
  nativeWorker.on("exit", () => {
    if (nativeWorkerStarted) app.quit();
  });
  return nativeWorker;
}

function stopNativeWorker() {
  nativeWorkerStarted = false;
  nativeWorker = null;
  mutexProcess = null;
  windowQueryHandler = null;
  workerHandshakeHandler = null;
  windowQueryBuffer = "";
}

function acquireFrontendMutex() {
  return new Promise((resolve, reject) => {
    const child = startNativeWorker();
    const timer = setTimeout(() => {
      stopNativeWorker();
      child.kill();
      reject(new Error("Timed out acquiring the Anya singleton mutex"));
    }, 20000);
    workerHandshakeHandler = (line) => {
      clearTimeout(timer);
      if (line === "LOCKED") {
        mutexProcess = child;
        resolve(true);
      } else {
        stopNativeWorker();
        child.stdin.end();
        child.kill();
        resolve(false);
      }
    };
  });
}

function releaseFrontendMutex() {
  const child = nativeWorker;
  stopNativeWorker();
  if (!child) return;
  try { child.stdin.end("STOP\n"); } catch {}
}

// ---- Window ----------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: config.expandedWidth,
    height: config.expandedHeight,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "renderer.html"));
  win.webContents.once("did-finish-load", () => {
    rendererReady = true;
    resetRenderedPresentation();
    if (artworkDataUrl) win.webContents.send("anya:artwork", { dataUrl: artworkDataUrl });
    renderCurrentNotification();
  });
  positionExpanded();
  win.on("move", writeSavedPosition);
  win.on("moved", writeSavedPosition);
  lastObservedPosition = (() => {
    const [x, y] = win.getPosition();
    return { x, y };
  })();
  positionPollTimer = setInterval(observeWindowPosition, 500);
  win.on("closed", () => {
    if (positionPollTimer) clearInterval(positionPollTimer);
    positionPollTimer = null;
    dragOrigin = null;
    win = null;
    rendererReady = false;
    fixedWindowSize = null;
    resetRenderedPresentation();
  });
}

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

function resizeFixedWindow(width, height) {
  if (!win) return;
  const nextSize = {
    width: Math.max(1, Math.round(Number(width))),
    height: Math.max(1, Math.round(Number(height))),
  };
  if (!Number.isFinite(nextSize.width) || !Number.isFinite(nextSize.height)) return;
  if (fixedWindowSize && fixedWindowSize.width === nextSize.width && fixedWindowSize.height === nextSize.height) return;
  // The same fixed bounds are used throughout a drag. Explicit min/max bounds
  // also prevent Windows resize messages or DPI changes from growing the pet.
  win.setResizable(true);
  win.setMinimumSize(nextSize.width, nextSize.height);
  win.setMaximumSize(nextSize.width, nextSize.height);
  win.setSize(nextSize.width, nextSize.height);
  win.setResizable(false);
  fixedWindowSize = nextSize;
}

function positionExpanded(resize = true) {
  if (!win) return;
  if (resize && !fixedWindowSize) resizeFixedWindow(config.expandedWidth, config.expandedHeight);
  const [windowWidth, windowHeight] = win.getSize();
  const wa = workArea();
  const defaultX = Math.round(wa.x + wa.width - windowWidth - config.marginX);
  const defaultY = Math.round(wa.y + wa.height - windowHeight - config.marginY);
  const position = savedPosition || { x: defaultX, y: defaultY };
  const display = screen.getDisplayNearestPoint({
    x: position.x + Math.round(windowWidth / 2),
    y: position.y + Math.round(windowHeight / 2),
  });
  const area = display.workArea;
  const x = Math.max(area.x, Math.min(position.x, area.x + area.width - windowWidth));
  const y = Math.max(area.y, Math.min(position.y, area.y + area.height - windowHeight));
  win.setPosition(Math.round(x), Math.round(y));
}

// ---- State machine -----------------------------------------------------------

function showCelebration() {
  if (!win) return;
  state = "celebrating";
  positionExpanded();
  renderCurrentNotification();
}

function resetRenderedPresentation() {
  renderedPresentationKey = null;
}

function renderCurrentNotification() {
  if (!win || !rendererReady || state === "hidden") return;
  const presentation = buildNotificationPresentation(pending, currentForeground);
  if (!presentation) {
    renderedPresentationKey = null;
    win.hide();
    return;
  }
  const key = JSON.stringify(presentation);
  if (key === renderedPresentationKey && win.isVisible()) return;
  fitWindowToPresentation(presentation);
  win.webContents.send("anya:show", presentation);
  renderedPresentationKey = key;
  win.showInactive();
}

function hideAll() {
  if (!win) return;
  state = "hidden";
  renderedPresentationKey = null;
  win.hide();
}

function displaySource(s) {
  return (
    {
      Codex: "Codex CLI",
      Claude: "Claude Code",
      Gemini: "Gemini CLI",
      GrokBuild: "Grok Build",
      OpenCode: "OpenCode",
      Pi: "Pi",
    }[s] ||
    s ||
    "AI CLI"
  );
}

function fitWindowToPresentation(data) {
  if (!win) return;
  const desiredWidth = data && data.sources && data.sources.length > 1
    ? Math.min(config.maxExpandedWidth, 380 + data.sources.length * 44)
    : config.expandedWidth;
  resizeFixedWindow(Math.max(config.expandedWidth, desiredWidth), config.expandedHeight);
  positionExpanded(false);
}

// ---- Event queue (consumer) -------------------------------------------------

function readEvents() {
  let files;
  try {
    files = fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return;
  }
  const events = [];
  for (const f of files) {
    const full = path.join(QUEUE_DIR, f);
    let evt = null;
    try {
      evt = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      evt = null;
    }
    try {
      fs.unlinkSync(full);
    } catch {}
    if (evt) events.push(evt);
  }
  if (events.length === 0) return;
  // GUID filenames do not preserve completion order. Hooks stamp each event
  // at completion; legacy events retain a stable zero timestamp.
  events.sort(compareEventsByCompletion);
  pending.push(...events.map((evt) =>
    createPendingNotification(evt, Date.now(), config.fallbackExpireMs)
  ));
  pending.sort(compareEventsByCompletion);
  // Take a foreground snapshot before the first presentation. Otherwise a
  // completion in the active CLI could flash briefly before the next tick.
  const handles = [...new Set(pending.flatMap((n) => [n.windowHandle, n.terminalWindowHandle]).filter((h) => h > 0))];
  queryWindows(handles, (result) => {
    if (result) currentForeground = result.foreground || null;
    showCelebration();
  });
}

// ---- Dismissal detection ------------------------------------------------------
// The one persistent helper batches Win32 queries over stdin/stdout. No new
// PowerShell process is created per tick, regardless of notification count.

function queryWindows(handles, cb) {
  const child = nativeWorker;
  if (!child || !mutexProcess || windowQueryHandler) return cb(null);
  let settled = false;
  const timer = setTimeout(() => finish(null), 4000);
  function finish(result) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (windowQueryHandler === handler) windowQueryHandler = null;
    cb(result);
  }
  function handler(line) {
    if (!line || line === "ERROR") return finish(null);
    try {
      const result = JSON.parse(line);
      const entries = Array.isArray(result.windows) ? result.windows : (result.windows ? [result.windows] : []);
      finish({
        foreground: result.foreground || { root: 0, processId: 0, startTicks: "" },
        windows: new Map(entries.map((item) => [Number(item.handle), item])),
      });
    } catch {
      finish(null);
    }
  }
  windowQueryHandler = handler;
  const list = handles.length ? handles.join(",") : "0";
  child.stdin.write(`QUERY ${list}\n`, (error) => {
    if (error) finish(null);
  });
}

function tick() {
  readEvents();
  if (pending.length === 0 || windowQueryInFlight) return;

  const handles = [...new Set(pending.flatMap((n) => [n.windowHandle, n.terminalWindowHandle]).filter((h) => h > 0))];
  const queried = new Set(pending);
  windowQueryInFlight = true;
  queryWindows(handles, (res) => {
    windowQueryInFlight = false;
    if (!res) return;
    currentForeground = res.foreground || null;
    const resolved = resolvePendingNotifications(pending, queried, res, Date.now());
    pending = resolved.pending;
    if (pending.length === 0) {
      hideAll();
    } else if (resolved.changed) {
      // Do not leave a source visible after its terminal has been revisited.
      renderCurrentNotification();
    } else {
      // A terminal that was active at completion becomes visible only after
      // the user leaves it, even if no pending entry was removed this tick.
      renderCurrentNotification();
    }
  });
}

// ---- Lifecycle -----------------------------------------------------------------

if (process.env.AI_CLI_NOTIFY_TEST === "1") {
  app.setPath("userData", path.join(STATE_DIR, "electron-test-profile"));
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {});
  app.whenReady().then(async () => {
    if (!config.enabled) {
      app.quit();
      return;
    }
    let ownsFrontendMutex = false;
    try {
      ownsFrontendMutex = await acquireFrontendMutex();
    } catch (err) {
      console.error("[anya-notifier] shared mutex unavailable:", err.message);
      app.quit();
      return;
    }
    if (!ownsFrontendMutex) {
      app.quit();
      return;
    }
    ensureQueueDir();
    ensureQueueDir();
    createWindow();
    readEvents();
    ensureArtwork().catch((err) => {
      console.warn("[anya-notifier] using the built-in character because artwork is unavailable:", err.message);
    });
    try {
      watcher = fs.watch(QUEUE_DIR, { persistent: false }, (evt, filename) => {
        if (filename && filename.endsWith(".json")) readEvents();
      });
      watcher.on("error", () => (watcher = null));
    } catch {
      watcher = null;
    }
    tickTimer = setInterval(tick, config.tickMs);
  });
  app.on("window-all-closed", () => {}); // keep watching for events
  app.on("before-quit", () => {
    if (watcher) watcher.close();
    if (tickTimer) clearInterval(tickTimer);
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    if (positionPollTimer) clearInterval(positionPollTimer);
    releaseFrontendMutex();
  });
}
