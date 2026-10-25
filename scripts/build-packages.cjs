#!/usr/bin/env node
"use strict";

// Builds independent npm packages from the canonical repository sources. Run
// sync-runtime.ps1 first; each package contains exactly one platform adapter.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const outputRoot = path.join(root, "packages");
const version = require(path.join(root, "package.json")).version;
const installTemplate = fs.readFileSync(path.join(__dirname, "install-template.cjs"), "utf8");
const platforms = [
  { id: "codex", displayName: "code CLI" },
  { id: "claude", displayName: "Claude Code" },
  { id: "gemini", displayName: "Gemini CLI" },
  { id: "grok", displayName: "Grok Build" },
  { id: "opencode", displayName: "OpenCode" },
  { id: "pi", displayName: "Pi" },
];

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "test") continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function copyRuntime(destination, openCode = false) {
  for (const name of ["hook", "dispatch"]) {
    const target = openCode ? `ai-cli-notify-${name}.ps1` : `${name}.ps1`;
    copyFile(path.join(root, "runtime", `${name}.ps1`), path.join(destination, target));
  }
}

function createManifest(platform, packageName) {
  const common = {
    name: `ai-cli-notify-${platform.id}`,
    version,
    description: `Windows task-completion notifications for ${platform.displayName}. Independent adapter with an aggregated Anya reminder.`,
    license: "MIT",
    keywords: [platform.id, "notifications", "windows", "cli-plugin"],
    os: ["win32"],
    engines: { node: ">=22.19.0" },
    bin: { [packageName]: "cli.cjs" },
    files: [],
  };
  if (platform.id === "opencode") {
    common.type = "module";
    common.main = "./index.js";
    common.exports = "./index.js";
  } else if (platform.id === "pi") {
    common.pi = { extensions: ["./extension.ts"] };
    common.peerDependencies = { "@earendil-works/pi-coding-agent": "*" };
  }
  return common;
}

for (const platform of platforms) {
  const packageName = `ai-cli-notify-${platform.id}`;
  const destination = path.join(outputRoot, platform.id);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  const manifest = createManifest(platform, packageName);
  const installScript = installTemplate
    .replaceAll("__PLATFORM_ID__", platform.id)
    .replaceAll("__PLATFORM__", platform.displayName)
    .replaceAll("__PACKAGE__", packageName);
  fs.writeFileSync(path.join(destination, "cli.cjs"), installScript, { mode: 0o755 });
  copyFile(path.join(root, "LICENSE"), path.join(destination, "LICENSE"));
  copyFile(path.join(root, "README.md"), path.join(destination, "README.md"));

  if (platform.id === "opencode") {
    copyFile(path.join(root, "adapters/opencode/ai-cli-notify.js"), path.join(destination, "index.js"));
    copyRuntime(destination, true);
    manifest.files.push("index.js", "ai-cli-notify-*.ps1", "cli.cjs", "README.md", "LICENSE");
  } else if (platform.id === "pi") {
    copyFile(path.join(root, "adapters/pi/ai-cli-notify.ts"), path.join(destination, "extension.ts"));
    copyRuntime(path.join(destination, "runtime"));
    manifest.files.push("extension.ts", "runtime/", "cli.cjs", "README.md", "LICENSE");
  } else {
    if (platform.id !== "gemini") {
      copyDirectory(path.join(root, "adapters", platform.id), destination);
    }
    copyRuntime(path.join(destination, "runtime"));
    manifest.files.push("cli.cjs", "README.md", "LICENSE", "runtime/", "hooks.json", "plugin.json");
    if (platform.id === "claude") manifest.files.push(".claude-plugin/");
    if (platform.id === "codex") manifest.files.push(".codex-plugin/");
    if (platform.id === "grok") manifest.files.push("hooks/");
  }

  if (platform.id === "gemini") {
    copyFile(path.join(root, "gemini-extension.json"), path.join(destination, "gemini-extension.json"));
    copyDirectory(path.join(root, "hooks"), path.join(destination, "hooks"));
    manifest.files.push("gemini-extension.json", "hooks/");
  }
  if (platform.id === "claude") {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
    catalog.plugins[0].source = "./";
    writeJson(path.join(destination, ".claude-plugin/marketplace.json"), catalog);
  } else if (platform.id === "codex") {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
    catalog.plugins[0].source = { source: "local", path: "./" };
    writeJson(path.join(destination, ".agents/plugins/marketplace.json"), catalog);
    manifest.files.push(".agents/");
  }
  copyDirectory(path.join(root, "anya-notifier"), path.join(destination, "anya-notifier"));
  manifest.files.push("anya-notifier/");
  writeJson(path.join(destination, "package.json"), manifest);
  console.log(`Built ${packageName} (${platform.displayName} only)`);
}
console.log(`Independent packages are ready under ${outputRoot}`);
