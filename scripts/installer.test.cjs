"use strict";

// Invoked by scripts/test-installers.cjs with fake native CLI commands.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const platform = process.env.AI_CLI_NOTIFY_TEST_PLATFORM;
const callsPath = process.env.AI_CLI_NOTIFY_TEST_CALLS;
const statePath = process.env.AI_CLI_NOTIFY_TEST_STATE;
const installRoot = process.env.AI_CLI_NOTIFY_INSTALL_ROOT;
const bundle = path.join(installRoot, `${platform}-${require(path.join(root, "package.json")).version}`);

function run(extraArgs = []) {
  const result = spawnSync(process.execPath, [path.join(root, "packages", platform, "cli.cjs"), ...extraArgs], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, `${platform}: ${result.stdout}\n${result.stderr}`);
  return result;
}

function calls() {
  return JSON.parse(fs.readFileSync(callsPath, "utf8"));
}

function mutatingCalls() {
  return calls().filter((call) => !call.args.includes("list") && !call.args.includes("--json") && !call.args.includes("--output-format"));
}

if (["codex", "claude", "gemini", "grok"].includes(platform)) {
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).exists, false);
  run();
  let actions = mutatingCalls();
  if (platform === "codex") {
    assert.deepEqual(actions.map((call) => call.args), [
      ["plugin", "marketplace", "add", bundle],
      ["plugin", "add", "ai-cli-notify@ai-cli-notify"],
    ]);
  } else if (platform === "claude") {
    assert.deepEqual(actions.map((call) => call.args), [
      ["plugin", "marketplace", "add", bundle],
      ["plugin", "install", "ai-cli-notify@ai-cli-notify"],
    ]);
  } else if (platform === "gemini") {
    assert.deepEqual(actions.map((call) => call.args), [["extensions", "install", bundle, "--consent"]]);
  } else {
    assert.deepEqual(actions.map((call) => call.args), [["plugin", "install", bundle, "--trust"]]);
  }
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).source, bundle);
  for (const required of ["cli.cjs", "anya-notifier/src/main.js", "runtime/hook.ps1", "runtime/dispatch.ps1"]) {
    assert.ok(fs.existsSync(path.join(bundle, required)), `${platform}: stable bundle missing ${required}`);
  }
  if (platform === "grok") assert.ok(fs.existsSync(path.join(bundle, "hooks/hooks.json")));
  assert.ok(!fs.existsSync(path.join(bundle, "adapters")));
  assert.ok(!fs.existsSync(path.join(bundle, "electron")));
  assert.ok(!fs.existsSync(path.join(bundle, "anya-notifier/test")));
  assert.ok(!fs.existsSync(path.join(bundle, "runtime/overlay.ps1")), `${platform}: legacy overlay must be deleted`);
  assert.ok(fs.existsSync(path.join(process.env.LOCALAPPDATA, "ai-cli-notify", "bootstrap", "ensure-electron.cmd")), `${platform}: stable Electron bootstrap missing`);
  const firstCount = mutatingCalls().length;
  run();
  actions = mutatingCalls().slice(firstCount);
  if (platform === "codex") {
    assert.deepEqual(actions.map((call) => call.args), [
      ["plugin", "remove", "ai-cli-notify@ai-cli-notify"],
      ["plugin", "marketplace", "add", bundle],
      ["plugin", "add", "ai-cli-notify@ai-cli-notify"],
    ]);
  } else if (platform === "claude") {
    assert.deepEqual(actions.map((call) => call.args), [
      ["plugin", "marketplace", "add", bundle],
      ["plugin", "update", "ai-cli-notify@ai-cli-notify"],
    ]);
  } else if (platform === "gemini") {
    assert.deepEqual(actions.map((call) => call.args), [["extensions", "update", "ai-cli-notify"]]);
  } else {
    assert.deepEqual(actions.map((call) => call.args), [["plugin", "update", "ai-cli-notify"]]);
  }
  assert.ok(fs.existsSync(path.join(bundle, "cli.cjs")));
  run(["uninstall"]);
  assert.equal(fs.existsSync(bundle), false, `${platform}: native uninstall should remove only its stable bundle`);
  const remaining = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(remaining.exists, false);
} else if (["opencode", "pi"].includes(platform)) {
  run();
  assert.deepEqual(calls().at(-1).args, platform === "opencode"
    ? ["plugin", "ai-cli-notify-opencode", "--global"]
    : ["install", "npm:ai-cli-notify-pi"]);
  assert.equal(fs.existsSync(bundle), false);
} else {
  throw new Error(`Test platform not supplied: ${platform}`);
}
console.log(`PASS ${platform}: fresh install, stable paths, and native registration verified.`);
