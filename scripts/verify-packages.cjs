#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const platforms = ["codex", "claude", "gemini", "grok", "opencode", "pi"];
const eventSources = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
  grok: "GrokBuild",
  opencode: "OpenCode",
  pi: "Pi",
};
const foreignPlatforms = {
  codex: ["Claude", "Gemini", "GrokBuild", "OpenCode", "Pi"],
  claude: ["Codex", "Gemini", "GrokBuild", "OpenCode", "Pi"],
  gemini: ["Codex", "Claude", "GrokBuild", "OpenCode", "Pi"],
  grok: ["Codex", "Claude", "Gemini", "OpenCode", "Pi"],
  opencode: ["Codex", "Claude", "Gemini", "GrokBuild", "Pi"],
  pi: ["Codex", "Claude", "Gemini", "GrokBuild", "OpenCode"],
};
const allFiles = [];

for (const platform of platforms) {
  const directory = path.join(root, "packages", platform);
  const manifestPath = path.join(directory, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.name, `ai-cli-notify-${platform}`);
  assert.ok(manifest.bin, "Installer command missing");
  assert.ok(fs.existsSync(path.join(directory, "cli.cjs")), "Installer missing");
  assert.deepEqual(manifest.bin, { [manifest.name]: "cli.cjs" }, "npx command name must match package name");
  const bin = manifest.bin[manifest.name];
  const binScript = fs.readFileSync(path.join(directory, bin), "utf8");
  assert.ok(binScript.startsWith("#!/usr/bin/env node"), "npx entry needs a Node shebang");
  assert.ok(fs.existsSync(path.join(directory, "anya-notifier/src/main.js")), "Anya front-end missing");
  assert.ok(fs.existsSync(path.join(directory, "anya-notifier/src/notification-state.js")), "Shared state missing");
  assert.ok(!fs.existsSync(path.join(directory, "adapters")), "Umbrella adapters leaked into an independent package");
  assert.ok(!fs.existsSync(path.join(directory, "anya-notifier/test")), "Test files should not be shipped");
  assert.ok(!fs.existsSync(path.join(directory, "anya-notifier/node_modules")), "Electron/npm dependencies should not be bundled");
  assert.equal(manifest.version, require(path.join(root, "package.json")).version, "Package version drift");
  assert.equal(require(path.join(directory, "anya-notifier/package.json")).version, manifest.version, "Anya version drift");
  assert.ok(fs.existsSync(path.join(directory, "runtime/dispatch.ps1")) || fs.existsSync(path.join(directory, "ai-cli-notify-dispatch.ps1")), "Dispatcher missing");

  const adapterFiles = [];
  function collect(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const file = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "anya-notifier") collect(file);
      } else if (entry.isFile() && entry.name !== "README.md") {
        adapterFiles.push(file);
        allFiles.push(file);
      }
    }
  }
  collect(directory);
  for (const file of adapterFiles) {
    const content = fs.readFileSync(file, "utf8");
    for (const other of foreignPlatforms[platform]) {
      const isGenericSharedRuntime = /(?:^|[\\/])(?:runtime|anya-notifier)[\\/]/.test(file) ||
        /ai-cli-notify-(?:hook|dispatch|overlay)\.ps1$/.test(file);
      if (!isGenericSharedRuntime) {
        assert.ok(!content.includes(`-Source ${other}`) && !content.includes(`"${other}"`),
          `${platform} adapter contains another platform (${other}): ${file}`);
      }
    }
  }
  if (platform === "pi") {
    assert.ok(manifest.pi.extensions.length === 1);
    const entry = fs.readFileSync(path.join(directory, "extension.ts"), "utf8");
    assert.ok(entry.includes("./runtime/hook.ps1"), "Pi must resolve its package-local runtime first");
    assert.ok(entry.includes("existsSync(bundledHook)"), "Pi must distinguish package and repository layouts");
    for (const name of ["hook", "dispatch", "overlay"]) {
      assert.ok(fs.existsSync(path.join(directory, "runtime", `${name}.ps1`)), `Pi runtime/${name}.ps1 missing`);
      assert.ok(!fs.existsSync(path.join(directory, `${name}.ps1`)), `Pi ${name}.ps1 must be inside runtime/`);
    }
  }
  if (platform === "opencode") assert.equal(manifest.main, "./index.js");
  if (platform === "gemini") assert.ok(fs.existsSync(path.join(directory, "gemini-extension.json")));
  if (platform === "grok") assert.ok(fs.existsSync(path.join(directory, "hooks/hooks.json")));
  if (!["opencode", "pi"].includes(platform)) {
    const hookFile = ["gemini", "grok"].includes(platform) ? "hooks/hooks.json" : "hooks.json";
    const hookConfig = JSON.parse(fs.readFileSync(path.join(directory, hookFile), "utf8"));
    const commands = Object.values(hookConfig.hooks).flat().flatMap((hook) => hook.hooks || []).map((hook) => hook.command);
    assert.ok(commands.length > 0, `${platform} has no hook command`);
    assert.ok(commands.every((command) => command.includes(`-Source ${eventSources[platform]}`)),
      `${platform} registers another platform's event source`);
  } else {
    const entry = fs.readFileSync(path.join(directory, platform === "pi" ? "extension.ts" : "index.js"), "utf8");
    assert.ok(entry.includes(`"${eventSources[platform]}"`), `${platform} entry has the wrong event source`);
  }
  if (platform === "claude") {
    const catalog = JSON.parse(fs.readFileSync(path.join(directory, ".claude-plugin/marketplace.json"), "utf8"));
    assert.deepEqual(catalog.plugins.map((p) => p.source), ["./"]);
  }
  if (platform === "codex") {
    const catalog = JSON.parse(fs.readFileSync(path.join(directory, ".agents/plugins/marketplace.json"), "utf8"));
    assert.equal(catalog.plugins.length, 1);
    assert.deepEqual(catalog.plugins[0].source, { source: "local", path: "./" });
  }

  // npm pack --dry-run inspects the actual publish file list without creating
  // a tarball or contacting the registry.
  const npm = process.platform === "win32"
    ? path.join(path.dirname(process.execPath), "npm.cmd")
    : "npm";
  const packed = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  }));
  const packedFiles = packed[0].files.map((file) => file.path.replaceAll("/", "\\"));
  const requiredPacked = ["cli.cjs", "package.json", "anya-notifier\\src\\main.js", "anya-notifier\\src\\notification-state.js"];
  if (platform === "opencode") requiredPacked.push("index.js", "ai-cli-notify-hook.ps1", "ai-cli-notify-dispatch.ps1", "ai-cli-notify-overlay.ps1");
  else {
    requiredPacked.push("runtime\\hook.ps1", "runtime\\dispatch.ps1", "runtime\\overlay.ps1");
    if (platform !== "pi") requiredPacked.push(["gemini", "grok"].includes(platform) ? "hooks\\hooks.json" : "hooks.json");
    if (platform === "pi") requiredPacked.push("extension.ts");
    if (platform === "gemini") requiredPacked.push("gemini-extension.json");
    if (platform === "grok") requiredPacked.push("plugin.json");
    if (platform === "claude") requiredPacked.push(".claude-plugin\\plugin.json", ".claude-plugin\\marketplace.json");
    if (platform === "codex") requiredPacked.push(".codex-plugin\\plugin.json", ".agents\\plugins\\marketplace.json");
  }
  for (const file of requiredPacked) assert.ok(packedFiles.includes(file), `${platform}: ${file} missing from actual npm tarball`);
  assert.ok(packedFiles.every((file) => !/(?:^|\\)node_modules(?:\\|$)|(?:^|\\)test(?:\\|$)/i.test(file)), `${platform}: test/dependency leaked into npm tarball`);
  console.log(`OK ${manifest.name}: one adapter, Anya, shared runtime; ${packedFiles.length} packed files verified`);
}
console.log(`Verified ${platforms.length} independent packages (${allFiles.length} adapter/manifest files checked).`);
