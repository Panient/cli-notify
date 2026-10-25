// Ensures a verified Electron runtime is available.
//
// The ZIP is downloaded to a unique temporary file, checked against Electron's
// release checksum list, extracted into a staging directory, and only then
// swapped into the shared cache. Incomplete or unchecked archives are never
// treated as the runtime.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const https = require("https");
const { execFileSync, spawn } = require("child_process");

const VERSION = process.env.ANYA_NOTIFY_ELECTRON_VERSION || "33.4.11";
const MIRROR = process.env.ANYA_NOTIFY_ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
const CHECKSUM_URL = `https://github.com/electron/electron/releases/download/v${VERSION}/SHASUMS256.txt`;
const CACHE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "ai-cli-notify", "electron");
const CACHE_ROOT = path.dirname(CACHE_DIR);
const DOWNLOAD_LOCK = path.join(CACHE_ROOT, "electron-download.node.lock");
const DOWNLOAD_MARKER = path.join(CACHE_ROOT, "electron-download.lock");
const REQUEST_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const STALE_LOCK_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(VERSION)) {
  throw new Error("ANYA_NOTIFY_ELECTRON_VERSION must be a valid Electron release version");
}

function log(message) {
  console.log("[anya-notifier] " + message);
}

function installSharedBootstrap() {
  if (process.platform !== "win32") return;
  const directory = path.join(CACHE_ROOT, "bootstrap");
  const script = path.join(directory, "ensure-electron.js");
  const shim = path.join(directory, "ensure-electron.cmd");
  fs.mkdirSync(directory, { recursive: true });
  // This stable user-cache copy never points into an npx temporary directory.
  if (path.resolve(__filename) !== path.resolve(script)) fs.copyFileSync(__filename, script);
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
}

function startAnya(appDir, stateDirectory) {
  const electron = findExisting();
  if (!electron || !isRegularFile(path.join(appDir, "src", "main.js"))) return false;
  const child = spawn(electron, [appDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      LOCALAPPDATA: process.env.LOCALAPPDATA || os.tmpdir(),
      AI_CLI_NOTIFY_STATE_DIRECTORY: stateDirectory || "",
    },
  });
  child.unref();
  log("Anya started; queued events will be consumed by the single Electron front-end.");
  return true;
}

function isRegularFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function findExisting() {
  const override = process.env.ANYA_NOTIFY_ELECTRON_PATH;
  if (override && isRegularFile(override)) return override;

  const local = path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
  if (isRegularFile(local)) return local;

  const cached = path.join(CACHE_DIR, "electron.exe");
  const metadata = path.join(CACHE_DIR, "electron-release.json");
  if (isRegularFile(cached) && isRegularFile(metadata)) {
    try {
      const release = JSON.parse(fs.readFileSync(metadata, "utf8"));
      const expectedArtifact = `electron-v${VERSION}-win32-x64.zip`;
      if (release.version === VERSION && release.artifact === expectedArtifact &&
          typeof release.sha256 === "string" && /^[a-f0-9]{64}$/i.test(release.sha256)) {
        return cached;
      }
    } catch {}
  }
  return null;
}

function secureUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Electron downloads require HTTPS URLs");
  return url;
}

function requestWithRedirects(rawUrl, redirects = 0) {
  const url = secureUrl(rawUrl);
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { "User-Agent": "ai-cli-notify-electron-bootstrap" },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error("Too many HTTPS redirects while downloading Electron"));
          return;
        }
        try {
          const next = new URL(response.headers.location, url).toString();
          secureUrl(next);
          requestWithRedirects(next, redirects + 1).then(resolve, reject);
        } catch (error) {
          reject(new Error("Invalid or insecure HTTPS redirect: " + error.message));
        }
        return;
      }
      resolve(response);
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("Electron download timed out")));
    request.on("error", reject);
  });
}

async function downloadToFile(rawUrl, destination, onProgress) {
  const response = await requestWithRedirects(rawUrl);
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error("HTTP " + response.statusCode + " while downloading Electron");
  }
  const declaredLength = Number.parseInt(response.headers["content-length"] || "0", 10) || 0;
  if (declaredLength > MAX_ARCHIVE_BYTES) {
    response.resume();
    throw new Error("Electron archive exceeds the download size limit");
  }

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination, { flags: "wx" });
    const total = declaredLength;
    let received = 0;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error("Electron archive download exceeded the total time limit")), DOWNLOAD_TIMEOUT_MS);
    const removePartialFile = () => { try { fs.unlinkSync(destination); } catch {} };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      response.destroy();
      file.destroy();
      if (file.closed) removePartialFile();
      else file.once("close", removePartialFile);
      reject(error);
    };
    response.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_ARCHIVE_BYTES) {
        fail(new Error("Electron archive exceeds the download size limit"));
        return;
      }
      if (onProgress && total) onProgress(received, total);
    });
    response.on("error", fail);
    response.on("aborted", () => fail(new Error("Electron archive download was interrupted")));
    file.on("error", fail);
    file.on("finish", () => {
      if (total && received !== total) {
        fail(new Error("Electron archive download ended before the declared size"));
        return;
      }
      file.close((error) => {
        if (settled) return;
        if (error) return fail(error);
        settled = true;
        clearTimeout(timeout);
        resolve();
      });
    });
    response.pipe(file);
  });
}

async function downloadText(rawUrl, maxBytes = 1024 * 1024) {
  const response = await requestWithRedirects(rawUrl);
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error("HTTP " + response.statusCode + " while downloading checksum list");
  }
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy(new Error("Checksum list is unexpectedly large"));
        return;
      }
      chunks.push(chunk);
    });
    response.on("error", reject);
    response.on("aborted", () => reject(new Error("Checksum list download was interrupted")));
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function expectedSha256(checksumText, filename) {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^([a-fA-F0-9]{64})\\s+\\*?${escaped}\\s*$`, "m");
  const match = checksumText.match(pattern);
  if (!match) throw new Error(`Checksum for ${filename} was not found in SHASUMS256.txt`);
  return match[1].toLowerCase();
}

function acquireDownloadLock() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  try {
    const fd = fs.openSync(DOWNLOAD_LOCK, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    return fd;
  } catch (error) {
    if (error.code === "EEXIST") {
      try {
        const owner = JSON.parse(fs.readFileSync(DOWNLOAD_LOCK, "utf8"));
        let alive = false;
        try {
          process.kill(Number(owner.pid), 0);
          alive = true;
        } catch (processError) {
          alive = processError.code === "EPERM";
        }
        if (Number.isInteger(owner.pid) && !alive) {
          fs.unlinkSync(DOWNLOAD_LOCK);
          return acquireDownloadLock();
        }
      } catch {}
      try {
        if (Date.now() - fs.statSync(DOWNLOAD_LOCK).mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(DOWNLOAD_LOCK);
          return acquireDownloadLock();
        }
      } catch {}
      throw new Error("Another Electron download is already in progress");
    }
    throw error;
  }
}

function releaseDownloadLock(fd) {
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(DOWNLOAD_LOCK); } catch {}
}

function writeDownloadMarker() {
  const temporary = `${DOWNLOAD_MARKER}.${process.pid}.tmp`;
  try { fs.unlinkSync(temporary); } catch {}
  fs.writeFileSync(temporary, JSON.stringify({
    pid: process.pid,
    started: new Date().toISOString(),
  }) + "\n", { encoding: "utf8", flag: "wx" });
  try { fs.unlinkSync(DOWNLOAD_MARKER); } catch {}
  fs.renameSync(temporary, DOWNLOAD_MARKER);
}

function removeOwnedDownloadMarker() {
  try {
    const marker = JSON.parse(fs.readFileSync(DOWNLOAD_MARKER, "utf8"));
    if (marker.pid === process.pid) fs.unlinkSync(DOWNLOAD_MARKER);
  } catch {}
}

function removePath(filePath) {
  try { fs.rmSync(filePath, { recursive: true, force: true }); } catch {}
}

function extractZip(zipPath, destination) {
  const command = "$zip = [Environment]::GetEnvironmentVariable('AI_CLI_NOTIFY_ZIP'); " +
    "$dest = [Environment]::GetEnvironmentVariable('AI_CLI_NOTIFY_DEST'); " +
    "Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force";
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      stdio: "inherit",
      windowsHide: true,
      env: Object.assign({}, process.env, {
        AI_CLI_NOTIFY_ZIP: zipPath,
        AI_CLI_NOTIFY_DEST: destination,
      }),
    }
  );
}

function validateZip(zipPath) {
  const command = "$zip = [Environment]::GetEnvironmentVariable('AI_CLI_NOTIFY_ZIP'); " +
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
    "$archive = [IO.Compression.ZipFile]::OpenRead($zip); " +
    "try { foreach ($entry in $archive.Entries) { " +
    "$name = $entry.FullName.Replace('\\', '/'); " +
    "if ([IO.Path]::IsPathRooted($name) -or $name -match '(^|/)\\.\\.(/|$)' -or $name -match '^[A-Za-z]:/') { " +
    "throw [System.IO.InvalidDataException]::new('Unsafe ZIP entry: ' + $entry.FullName) } } } " +
    "finally { $archive.Dispose() }";
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      stdio: "inherit",
      windowsHide: true,
      env: Object.assign({}, process.env, { AI_CLI_NOTIFY_ZIP: zipPath }),
    }
  );
}

function replaceCache(stagingDir) {
  const backupDir = `${CACHE_DIR}.old-${process.pid}-${Date.now()}`;
  let movedOld = false;
  try {
    if (fs.existsSync(CACHE_DIR)) {
      fs.renameSync(CACHE_DIR, backupDir);
      movedOld = true;
    }
    fs.renameSync(stagingDir, CACHE_DIR);
    if (movedOld) removePath(backupDir);
  } catch (error) {
    if (!fs.existsSync(CACHE_DIR) && movedOld && fs.existsSync(backupDir)) {
      try { fs.renameSync(backupDir, CACHE_DIR); } catch {}
    }
    throw error;
  }
}

async function ensure() {
  const existing = findExisting();
  if (existing) {
    log("Electron found: " + existing);
    return existing;
  }

  const lockFd = acquireDownloadLock();
  const zipName = `electron-v${VERSION}-win32-x64.zip`;
  // Expand-Archive validates the filename extension, so keep .zip last even
  // though the archive is still an exclusively-created temporary file.
  const zipPath = path.join(CACHE_ROOT, `${zipName}.${process.pid}.${Date.now()}.tmp.zip`);
  const stagingDir = path.join(CACHE_ROOT, `electron-staging-${process.pid}-${Date.now()}`);
  const url = MIRROR.replace(/\/$/, "") + `/${VERSION}/${zipName}`;

  let completed = false;
  try {
    const afterLock = findExisting();
    if (afterLock) return afterLock;

    writeDownloadMarker();

    log("Electron not found, downloading v" + VERSION + " (win32-x64) ...");
    let lastPct = -1;
    await downloadToFile(url, zipPath, (received, total) => {
      const pct = Math.floor((received / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        log(`downloading ${(received / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB`);
        lastPct = pct;
      }
    });

    const actualHash = await sha256(zipPath);
    const checksumText = await downloadText(CHECKSUM_URL);
    const expectedHash = expectedSha256(checksumText, zipName);
    if (actualHash !== expectedHash) {
      throw new Error(`Electron SHA-256 mismatch (expected ${expectedHash}, got ${actualHash})`);
    }
    log("Electron archive checksum verified");

    validateZip(zipPath);
    fs.mkdirSync(stagingDir, { recursive: true });
    extractZip(zipPath, stagingDir);
    const stagedExe = path.join(stagingDir, "electron.exe");
    if (!isRegularFile(stagedExe)) throw new Error("Extraction failed: electron.exe not found");
    fs.writeFileSync(path.join(stagingDir, "electron-release.json"), JSON.stringify({
      version: VERSION,
      artifact: zipName,
      sha256: actualHash,
      checksumUrl: CHECKSUM_URL,
      downloadedAt: new Date().toISOString(),
    }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });

    replaceCache(stagingDir);
    try { fs.unlinkSync(DOWNLOAD_MARKER); } catch {}
    try { fs.unlinkSync(zipPath); } catch {}
    const exe = path.join(CACHE_DIR, "electron.exe");
    completed = true;
    log("Electron ready: " + exe);
    return exe;
  } finally {
    try { fs.unlinkSync(zipPath); } catch {}
    removePath(stagingDir);
    removeOwnedDownloadMarker();
    releaseDownloadLock(lockFd);
  }
}

async function bootstrap(appDirectory, stateDirectory) {
  installSharedBootstrap();
  await ensure();
  if (appDirectory) startAnya(appDirectory, stateDirectory);
}

if (require.main === module) {
  const appArgument = process.argv.indexOf("--app-dir");
  const stateArgument = process.argv.indexOf("--state-directory");
  bootstrap(
    appArgument >= 0 ? process.argv[appArgument + 1] : null,
    stateArgument >= 0 ? process.argv[stateArgument + 1] : null,
  ).catch((error) => {
    console.error("[anya-notifier] failed to ensure Electron:", error.message);
    process.exit(1);
  });
}

module.exports = { ensure, bootstrap, findExisting, installSharedBootstrap };
