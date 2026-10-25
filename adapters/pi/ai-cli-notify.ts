import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("agent_settled", (event) => {
    if (process.platform !== "win32") return;
    // Independent packages place this extension at the package root, while
    // the repository adapter lives two directories below the shared runtime.
    const bundledHook = fileURLToPath(new URL("./runtime/hook.ps1", import.meta.url));
    const repositoryHook = fileURLToPath(new URL("../../runtime/hook.ps1", import.meta.url));
    const hook = existsSync(bundledHook) ? bundledHook : repositoryHook;
    const payload = Buffer.from(JSON.stringify({ aborted: event.aborted }), "utf8").toString("base64");
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        hook,
        "-Source",
        "Pi",
        "-PayloadBase64",
        payload,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    child.on("error", () => {});
  });
}
