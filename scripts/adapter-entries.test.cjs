"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pathToFileURL } = require("node:url");

(async () => {
  const root = path.resolve(__dirname, "..");
  const calls = [];
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (file, args, options) => {
    calls.push({ file, args, options });
    return { on() {} };
  };
  try {
    const openCode = await import(pathToFileURL(path.join(root, "packages/opencode/index.js")).href);
    const plugin = await openCode.AiCliNotifyPlugin({});
    await plugin.event({ event: { type: "session.idle" } });
    assert.equal(calls.length, 1);
    const openCodeHook = calls[0].args[calls[0].args.indexOf("-File") + 1];
    assert.equal(openCodeHook, path.join(root, "packages/opencode/ai-cli-notify-hook.ps1"));
    assert.ok(fs.existsSync(openCodeHook));
    assert.ok(calls[0].args.includes("OpenCode"));

    const pi = await import(pathToFileURL(path.join(root, "packages/pi/extension.ts")).href);
    let settled;
    pi.default({ on(event, callback) { assert.equal(event, "agent_settled"); settled = callback; } });
    settled({ aborted: false });
    assert.equal(calls.length, 2);
    const piHook = calls[1].args[calls[1].args.indexOf("-File") + 1];
    assert.equal(piHook, path.join(root, "packages/pi/runtime/hook.ps1"), "Pi must use its packaged runtime, not the repository parent");
    assert.ok(fs.existsSync(piHook));
    assert.ok(calls[1].args.includes("Pi"));
    const payload = JSON.parse(Buffer.from(calls[1].args.at(-1), "base64").toString("utf8"));
    assert.deepEqual(payload, { aborted: false });
    console.log("PASS: independent OpenCode and Pi entries load and call their packaged hooks.");
  } finally {
    childProcess.spawn = originalSpawn;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
