"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const directory = fs.mkdtempSync(path.join(__dirname, ".installer-test-"));
const bin = path.join(directory, "bin");
fs.mkdirSync(bin);
const callsPath = path.join(directory, "calls.json");
const statePath = path.join(directory, "state.json");
const shim = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const platform = process.env.AI_CLI_NOTIFY_FAKE_PLATFORM;
const stateFile = process.env.AI_CLI_NOTIFY_TEST_STATE;
const callsFile = process.env.AI_CLI_NOTIFY_TEST_CALLS;
const args = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(callsFile, "utf8"));
calls.push({ platform, args });
fs.writeFileSync(callsFile, JSON.stringify(calls, null, 2));
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const name = "ai-cli-notify";
const id = "ai-cli-notify@ai-cli-notify";
const isList = args[1] === "list";
if (isList) {
  if (platform === "codex") process.stdout.write(JSON.stringify({ installed: state.exists ? [{ pluginId: id, marketplaceSource: { source: state.source } }] : [] }));
  else if (platform === "claude") process.stdout.write(JSON.stringify(state.exists ? [{ id, readFromFolder: state.source }] : []));
  else if (platform === "gemini") process.stdout.write(JSON.stringify(state.exists ? [{ name, installMetadata: { source: state.source } }] : []));
  else process.stdout.write(JSON.stringify(state.exists ? [{ name, source: state.source }] : []));
  process.exit(0);
}
const isInstall = (platform === "codex" || platform === "claude") && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add" ||
  platform === "gemini" && args[0] === "extensions" && args[1] === "install" ||
  platform === "grok" && args[0] === "plugin" && args[1] === "install";
const isRemove = (platform === "codex" || platform === "claude") && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove" ||
  (platform === "codex" || platform === "claude") && args[0] === "plugin" && (args[1] === "remove" || args[1] === "uninstall") ||
  platform === "gemini" && args[0] === "extensions" && args[1] === "uninstall" ||
  platform === "grok" && args[0] === "plugin" && args[1] === "uninstall";
if (isInstall) {
  state.exists = true;
  state.source = args.at(platform === "grok" || platform === "gemini" ? -2 : -1);
}
if (isRemove) {
  state.exists = false;
  state.source = null;
}
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
`;
for (const platform of ["codex", "claude", "gemini", "grok", "opencode", "pi"]) {
  fs.writeFileSync(path.join(bin, `${platform}.cjs`), shim, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, `${platform}.cmd`), `@echo off\r\nset AI_CLI_NOTIFY_FAKE_PLATFORM=${platform}\r\nnode.exe "%~dp0${platform}.cjs" %*\r\n`);
}
if (process.platform === "win32") {
  const source = path.join(bin, "grok-shim.cs");
  const csharp = String.raw`using System;
using System.Diagnostics;
class GrokShim {
  static int Main(string[] args) {
    Environment.SetEnvironmentVariable("AI_CLI_NOTIFY_FAKE_PLATFORM", "grok");
    string script = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "grok.cjs");
    var start = new ProcessStartInfo("node.exe");
    start.UseShellExecute = false;
    start.Arguments = "\"" + script + "\"";
    foreach (string arg in args) start.Arguments += " \"" + arg.Replace("\"", "\"\"") + "\"";
    var process = Process.Start(start);
    process.WaitForExit();
    return process.ExitCode;
  }
}`;
  fs.writeFileSync(source, csharp);
  const command = `Add-Type -TypeDefinition (Get-Content -LiteralPath '${source.replaceAll("'", "''")}' -Raw) -OutputAssembly '${path.join(bin, "grok.exe").replaceAll("'", "''")}' -OutputType ConsoleApplication`;
  const compiled = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
  assert.equal(compiled.status, 0, `Could not compile isolated Grok shim: ${compiled.stdout}\n${compiled.stderr}`);
}

try {
for (const platform of ["codex", "claude", "gemini", "grok", "opencode", "pi"]) {
  const platformDirectory = path.join(directory, platform);
  fs.mkdirSync(platformDirectory, { recursive: true });
  const callsPath = path.join(platformDirectory, "calls.json");
  const statePath = path.join(platformDirectory, "state.json");
  const installRoot = path.join(platformDirectory, "stable");
  fs.writeFileSync(callsPath, "[]");
  fs.writeFileSync(statePath, JSON.stringify({ exists: false, source: null }));
  const node = process.execPath;
  const script = path.join(__dirname, "installer.test.cjs");
  const testBin = path.join(platformDirectory, "test-bin");
  const testLocalAppData = path.join(platformDirectory, "localappdata");
  fs.mkdirSync(testBin, { recursive: true });
  fs.mkdirSync(testLocalAppData, { recursive: true });
  fs.copyFileSync(node, path.join(testBin, path.basename(node)));
  const electronCache = path.join(testLocalAppData, "ai-cli-notify", "electron");
  fs.mkdirSync(electronCache, { recursive: true });
  fs.writeFileSync(path.join(electronCache, "electron.exe"), "isolated-test-placeholder");
  fs.writeFileSync(path.join(electronCache, "electron-release.json"), JSON.stringify({ version: "33.4.11", artifact: "electron-v33.4.11-win32-x64.zip", sha256: "0".repeat(64) }));
  const result = spawnSync(path.join(testBin, path.basename(node)), [script, platform], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      LOCALAPPDATA: testLocalAppData,
      PATH: `${testBin}${path.delimiter}${bin}${path.delimiter}${process.env.PATH}`,
      AI_CLI_NOTIFY_TEST_BIN: bin,
      AI_CLI_NOTIFY_TEST_CALLS: callsPath,
      AI_CLI_NOTIFY_TEST_STATE: statePath,
      AI_CLI_NOTIFY_INSTALL_ROOT: installRoot,
      AI_CLI_NOTIFY_TEST_PLATFORM: platform,
    },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `Native installer simulation failed for ${platform}: ${callsPath}`);
}
console.log("All six platform installers passed isolated native-command simulations.");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
