#!/usr/bin/env node
"use strict";

// Installed as a platform-specific npx command. This is intentionally a normal
// explicit command, not an npm lifecycle script: users can inspect --dry-run
// before authorizing a CLI to register its hooks.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const platform = process.env.AI_CLI_NOTIFY_PLATFORM || "grok";
const displayName = "Grok Build";
const packageName = process.env.AI_CLI_NOTIFY_PACKAGE || "ai-cli-notify-grok";
const bundleRoot = path.resolve(__dirname);
const marketplace = "ai-cli-notify";
const pluginId = `${marketplace}@${marketplace}`;
const args = process.argv.slice(2);
const action = args.find((arg) => !arg.startsWith("-")) || "install";
const dryRun = args.includes("--dry-run");
const local = args.includes("--local");
const version = require(path.join(bundleRoot, "package.json")).version;
// Local-path plugin mechanisms must not retain an npx cache path, which npm
// can delete after the command exits. Each platform/version gets its own copy.
const installationRoot = path.join(
  process.env.AI_CLI_NOTIFY_INSTALL_ROOT || path.join(process.env.LOCALAPPDATA || process.cwd(), "ai-cli-notify", "plugins"),
  `${platform}-${version}`,
);

function prepareLocalBundle() {
  if (path.resolve(bundleRoot) === path.resolve(installationRoot)) return bundleRoot;
  if (dryRun) {
    console.log(`[dry-run] Copy only the ${displayName} bundle to ${installationRoot}`);
    return installationRoot;
  }
  const staging = `${installationRoot}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.cpSync(bundleRoot, staging, { recursive: true, force: true });
    fs.rmSync(installationRoot, { recursive: true, force: true });
    fs.renameSync(staging, installationRoot);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return installationRoot;
}

function usage() {
  console.log(`AI CLI Notify for ${displayName}\n\nUsage:\n  npx --yes ${packageName} [install] [--dry-run]\n  npx --yes ${packageName} uninstall [--dry-run]\n\nOnly this platform's adapter is included. Review the bundled hooks before\ninstalling. --local only changes Pi to use this local package directory.\n`);
}

function quote(value) {
  return /^[\w:./\\@-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

function run(executable, commandArgs) {
  const printable = `${executable} ${commandArgs.map(quote).join(" ")}`;
  if (dryRun) {
    console.log(`[dry-run] ${printable}`);
    return;
  }
  console.log(`> ${printable}`);
  // npm-distributed Windows CLIs provide .cmd launchers. Node cannot spawn
  // those directly without a shell; spawning the .cmd file uses the standard
  // Windows command shim without interpolating a shell command string.
  const useCommandShim = process.platform === "win32" && executable !== "grok";
  const executableName = useCommandShim ? `${executable}.cmd` : executable;
  // .cmd launchers require the Windows command shim; native .exe commands
  // such as Grok must be launched directly, never through a .cmd suffix.
  const result = spawnSync(executableName, commandArgs, {
    stdio: "inherit",
    windowsHide: false,
    shell: useCommandShim,
  });
  if (result.error) {
    throw new Error(`Could not run ${executable}. Install ${displayName} and make sure its command is on PATH. ${result.error.message}`);
  }
  if (result.status !== 0) throw new Error(`${executable} exited with code ${result.status ?? "unknown"}`);
}

function inspectInstalled() {
  switch (platform) {
    case "codex": return inspect("codex", ["plugin", "list", "--marketplace", marketplace, "--json"]);
    case "claude": return inspect("claude", ["plugin", "list", "--json"]);
    case "gemini": return inspect("gemini", ["extensions", "list", "--output-format", "json"]);
    case "grok": return inspect("grok", ["plugin", "list", "--json"]);
    default: return { exists: false, source: null };
  }
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => {
    const normalized = path.resolve(String(value)).replace(/^\\\\\?\\/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function inspect(executable, commandArgs) {
  if (dryRun) return { exists: false, source: null };
  const result = spawnSync(executable + (process.platform === "win32" && executable !== "grok" ? ".cmd" : ""), commandArgs, {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32" && executable !== "grok",
  });
  if (result.error || result.status !== 0) throw new Error(`Could not inspect existing ${displayName} plugin registration.`);
  // Gemini's JSON list command currently writes JSON to stderr on Windows.
  let data;
  try { data = JSON.parse(result.stdout.trim() || result.stderr.trim()); }
  catch { throw new Error(`${displayName} returned an unreadable plugin list.`); }
  if (platform === "codex") {
    const plugin = (data.installed || []).find((item) => item.pluginId === pluginId);
    return { exists: Boolean(plugin), source: plugin?.marketplaceSource?.source || null };
  }
  if (platform === "claude") {
    const plugin = data.find((item) => item.id === pluginId);
    return { exists: Boolean(plugin), source: plugin?.readFromFolder || null };
  }
  if (platform === "gemini") {
    const plugin = data.find((item) => item.name === marketplace);
    return { exists: Boolean(plugin), source: plugin?.installMetadata?.source || null };
  }
  if (platform === "grok") {
    const plugin = data.find((item) => item.name === marketplace);
    return { exists: Boolean(plugin), source: plugin?.source || null };
  }
  return { exists: false, source: null };
}

function migrate() {
  console.log(`Migrating the existing ${displayName} registration to a stable per-user bundle.`);
  if (platform === "gemini") {
    // Gemini local updates resolve their original source. Migrate that source
    // first, then future updates can use its native update command normally.
    run("gemini", ["extensions", "uninstall", marketplace]);
    run("gemini", ["extensions", "install", installationRoot, "--consent"]);
  } else if (platform === "grok") {
    run("grok", ["plugin", "uninstall", marketplace, "--confirm"]);
    run("grok", ["plugin", "install", installationRoot, "--trust"]);
  }
}

function install() {
  switch (platform) {
    case "codex": {
      const existing = inspectInstalled();
      const bundle = prepareLocalBundle();
      if (existing.exists) {
        if (samePath(existing.source, bundle)) {
          run("codex", ["plugin", "remove", pluginId]);
        } else {
          run("codex", ["plugin", "marketplace", "remove", marketplace]);
        }
      }
      run("codex", ["plugin", "marketplace", "add", bundle]);
      run("codex", ["plugin", "add", pluginId]);
      break;
    }
    case "claude": {
      const existing = inspectInstalled();
      const bundle = prepareLocalBundle();
      if (existing.exists && !samePath(existing.source, bundle)) {
        run("claude", ["plugin", "uninstall", pluginId]);
        run("claude", ["plugin", "marketplace", "remove", marketplace]);
      }
      run("claude", ["plugin", "marketplace", "add", bundle]);
      if (existing.exists && samePath(existing.source, bundle)) run("claude", ["plugin", "update", pluginId]);
      else run("claude", ["plugin", "install", pluginId]);
      break;
    }
    case "gemini": {
      const existing = inspectInstalled();
      const bundle = prepareLocalBundle();
      if (existing.exists && samePath(existing.source, bundle)) {
        run("gemini", ["extensions", "update", marketplace]);
      } else if (existing.exists) {
        migrate();
      } else {
        run("gemini", ["extensions", "install", bundle, "--consent"]);
      }
      break;
    }
    case "grok": {
      const existing = inspectInstalled();
      const bundle = prepareLocalBundle();
      if (existing.exists && samePath(existing.source, bundle)) {
        run("grok", ["plugin", "update", marketplace]);
      } else if (existing.exists) {
        migrate();
      } else {
        run("grok", ["plugin", "install", bundle, "--trust"]);
      }
      break;
    }
    case "opencode":
      // OpenCode natively manages npm plugins. It downloads this exact small
      // package, rather than an umbrella package containing every CLI adapter.
      run("opencode", ["plugin", packageName, "--global"]);
      break;
    case "pi":
      run("pi", ["install", local ? bundleRoot : `npm:${packageName}`]);
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
  if (!dryRun) console.log(`Installed AI CLI Notify for ${displayName}. Restart ${displayName} to load its hooks.`);
}

function uninstall() {
  const existing = inspectInstalled();
  switch (platform) {
    case "codex":
      run("codex", ["plugin", "remove", pluginId]);
      run("codex", ["plugin", "marketplace", "remove", marketplace]);
      break;
    case "claude":
      run("claude", ["plugin", "uninstall", pluginId]);
      run("claude", ["plugin", "marketplace", "remove", marketplace]);
      break;
    case "gemini":
      run("gemini", ["extensions", "uninstall", marketplace]);
      break;
    case "grok":
      run("grok", ["plugin", "uninstall", marketplace, "--confirm"]);
      break;
    case "pi":
      run("pi", ["remove", local ? bundleRoot : `npm:${packageName}`]);
      break;
    case "opencode":
      console.log(`Remove \"${packageName}\" from the \"plugin\" array in your global opencode.json, then restart OpenCode.`);
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
  if (!dryRun && samePath(existing.source, installationRoot)) {
    fs.rmSync(installationRoot, { recursive: true, force: true });
  }
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
} else {
  try {
    if (!["install", "uninstall"].includes(action)) throw new Error(`Unknown command: ${action}`);
    if (action === "uninstall") uninstall();
    else install();
  } catch (error) {
    console.error(`AI CLI Notify: ${error.message}`);
    process.exitCode = 1;
  }
}
