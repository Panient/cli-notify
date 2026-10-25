"use strict";

// Optional native Windows smoke test. It uses an isolated LOCALAPPDATA queue,
// starts the real Electron front-end, and captures the single, same-platform,
// and cross-platform states through the Chrome DevTools Protocol.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const native = process.platform === "win32" ? require("./windows-native.cjs") : null;

if (process.platform !== "win32") {
  console.log("Skipped: the visual smoke test requires Windows.");
  process.exit(0);
}

const appDir = path.resolve(__dirname, "..");
const userArtwork = path.join(process.env.LOCALAPPDATA || "", "AI CLI Notify", "artwork", "anya.png");
const electron = process.env.ANYA_NOTIFY_ELECTRON_PATH ||
  path.join(process.env.LOCALAPPDATA || "", "ai-cli-notify", "electron", "electron.exe");
assert.ok(fs.existsSync(electron), `Electron not found: ${electron}. Run npm run ensure first.`);

const outputArgument = process.argv.indexOf("--output");
const temporaryRoot = outputArgument >= 0 && process.argv[outputArgument + 1]
  ? path.resolve(process.argv[outputArgument + 1])
  : fs.mkdtempSync(path.join(os.tmpdir(), "ai-cli-notify-visual-"));
fs.mkdirSync(temporaryRoot, { recursive: true });
const eventsDir = path.join(temporaryRoot, "AI CLI Notify", "events");
fs.mkdirSync(eventsDir, { recursive: true });
const port = 19000 + (process.pid % 1000);
// A fixed per-user Electron singleton is normally desirable, but it would make
// this test compete with a real notifier. Isolate the test instance completely.
process.env.AI_CLI_NOTIFY_TEST = "1";
process.env.AI_CLI_NOTIFY_MUTEX_NAME = `Local\\AiCliNotifyFrontendTest${process.pid}`;
process.env.AI_CLI_NOTIFY_STATE_DIRECTORY = path.join(temporaryRoot, "AI CLI Notify");
const nativeScript = native.nativeScript(temporaryRoot);
// Artwork is not shipped in an adapter. Reuse the user's validated cache when
// available so an offline visual test exercises the large PNG, not Canvas.
if (fs.existsSync(userArtwork)) {
  const artwork = path.join(temporaryRoot, "AI CLI Notify", "artwork", "anya.png");
  fs.mkdirSync(path.dirname(artwork), { recursive: true });
  fs.copyFileSync(userArtwork, artwork);
}
const child = spawn(electron, [appDir, `--remote-debugging-port=${port}`], {
  env: { ...process.env, LOCALAPPDATA: temporaryRoot, NODE_OPTIONS: "" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let childOutput = "";
const originalExit = process.exit;
process.exit = (code) => {
  native.stopTree(child.pid);
  native.stopHelpers(temporaryRoot);
  originalExit(code);
};
child.stdout.on("data", (chunk) => { childOutput += chunk; });
child.stderr.on("data", (chunk) => { childOutput += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let nextId = 0;
const pendingCalls = new Map();

async function waitForPage() {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode}): ${childOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find((item) => item.type === "page" && item.url.endsWith("renderer.html"));
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError || new Error("Timed out waiting for the Anya renderer");
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`CDP call timed out: ${method}`));
    }, 10000);
    pendingCalls.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await call("Runtime.evaluate", { expression, returnByValue: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

function emit(filename, source, createdAt) {
  const event = {
    source,
    aborted: false,
    createdAt,
    windowHandle: 0,
    windowProcessId: 0,
    windowProcessStartTicks: "0",
  };
  const destination = path.join(eventsDir, filename);
  fs.writeFileSync(`${destination}.tmp`, JSON.stringify(event));
  fs.renameSync(`${destination}.tmp`, destination);
}

async function capture(name) {
  const result = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const destination = path.join(temporaryRoot, `${name}.png`);
  fs.writeFileSync(destination, Buffer.from(result.data, "base64"));
  console.log(`Screenshot: ${destination}`);
}

async function run() {
  const page = await waitForPage();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pendingCalls.has(message.id)) return;
    const request = pendingCalls.get(message.id);
    pendingCalls.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  await call("Page.enable");

  emit("single.json", "Codex", 100);
  await sleep(2000);
  const single = await evaluate(`(() => {
    const bubble = document.getElementById('bubble').getBoundingClientRect();
    return { width: bubble.width, viewport: innerWidth, summaryHidden: document.getElementById('sourceSummary').hidden };
  })()`);
  assert.ok(single.width < 280, `Single-source bubble is too wide: ${JSON.stringify(single)}`);
  assert.ok(single.width <= single.viewport, "Single-source bubble overflows the window");
  assert.equal(single.summaryHidden, true);
  assert.ok(fs.existsSync(path.join(temporaryRoot, "AI CLI Notify", "artwork", "anya.png")), "Large Anya artwork should be available for the visual test");
  await sleep(500);
  assert.equal(await evaluate(`document.getElementById('petImage').style.display`), "block", "Large Anya PNG is not displayed");
  native.inspect(nativeScript, child.pid, { x: 1100, y: 80 });
  // Let Windows finish its initial DPI-coordinate reconciliation before the
  // baseline; subsequent real pointer drags must preserve exactly these bounds.
  native.inspect(nativeScript, child.pid, { drag: true });
  const beforeDrag = native.inspect(nativeScript, child.pid);
  const afterHover = native.inspect(nativeScript, child.pid, { hover: true });
  assert.deepEqual([afterHover.width, afterHover.height], [beforeDrag.width, beforeDrag.height], "Hovering must not enlarge Anya");
  const afterDrag = native.inspect(nativeScript, child.pid, { drag: true });
  assert.deepEqual([afterDrag.width, afterDrag.height], [beforeDrag.width, beforeDrag.height], "Dragging must not enlarge Anya");
  assert.ok(afterDrag.x !== beforeDrag.x || afterDrag.y !== beforeDrag.y, "The real mouse drag did not move the native window");
  await capture("single");

  emit("same-2.json", "Codex", 200);
  emit("same-3.json", "Codex", 300);
  await sleep(1800);
  const samePlatform = await evaluate(`(() => {
    const bubble = document.getElementById('bubble').getBoundingClientRect();
    const badge = document.getElementById('badge').getBoundingClientRect();
    return {
      tag: document.getElementById('cliTag').textContent,
      badgeText: document.getElementById('badgeCount').textContent,
      summary: document.getElementById('sourceSummary').textContent,
      bubble: { top: bubble.top, right: bubble.right },
      badgeBounds: { top: badge.top, right: badge.right, left: badge.left, bottom: badge.bottom },
    };
  })()`);
  assert.equal(samePlatform.tag, "code CLI");
  assert.equal(samePlatform.badgeText, "3");
  assert.match(samePlatform.summary, /code CLI3/);
  assert.ok(samePlatform.badgeBounds.top < samePlatform.bubble.top && samePlatform.badgeBounds.bottom > samePlatform.bubble.top, "Count badge must straddle the bubble's top edge");
  assert.ok(samePlatform.badgeBounds.left < samePlatform.bubble.right && samePlatform.badgeBounds.right > samePlatform.bubble.right, "Count badge must straddle the bubble's right edge");
  assert.ok(Math.abs(samePlatform.badgeBounds.right - samePlatform.bubble.right) < 20, "Count badge drifted away from the bubble");
  await capture("same-platform");

  emit("other-4.json", "Claude", 400);
  emit("other-5.json", "Pi", 500);
  await sleep(1800);
  const crossPlatform = await evaluate(`(() => {
    const bubble = document.getElementById('bubble').getBoundingClientRect();
    return {
      tag: document.getElementById('cliTag').textContent,
      badge: document.getElementById('badgeCount').textContent,
      summary: document.getElementById('sourceSummary').textContent,
      width: bubble.width,
      right: bubble.right,
      viewport: innerWidth,
    };
  })()`);
  assert.equal(crossPlatform.tag, "Pi");
  assert.equal(crossPlatform.badge, "5");
  for (const label of ["code CLI", "Claude Code", "Pi"]) assert.match(crossPlatform.summary, new RegExp(label));
  assert.ok(crossPlatform.right <= crossPlatform.viewport, `Summary overflows: ${JSON.stringify(crossPlatform)}`);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert.equal(pages.filter((item) => item.url.endsWith("renderer.html")).length, 1, "More than one Anya window was created");
  await capture("cross-platform");
  console.log("Visual smoke test passed: large Anya, fixed hover/drag bounds, attached badge, and one aggregated window.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (socket) socket.close();
  native.stopTree(child.pid);
  native.stopHelpers(temporaryRoot);
  await sleep(800);
  if (process.argv.includes("--keep") || process.env.AI_CLI_NOTIFY_VISUAL_KEEP === "1") {
    console.log(`Isolated test files retained at: ${temporaryRoot}`);
  } else {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
