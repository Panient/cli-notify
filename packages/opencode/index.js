import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const hookScript = fileURLToPath(new URL("./ai-cli-notify-hook.ps1", import.meta.url));
const overlayScript = fileURLToPath(new URL("./ai-cli-notify-overlay.ps1", import.meta.url));
const dispatchScript = fileURLToPath(new URL("./ai-cli-notify-dispatch.ps1", import.meta.url));

export const AiCliNotifyPlugin = async () => ({
  event: async ({ event }) => {
    if (process.platform !== "win32" || event.type !== "session.idle") return;

    const payload = Buffer.from(JSON.stringify({ type: "session.idle" }), "utf8").toString("base64");
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        hookScript,
        "-Source",
        "OpenCode",
        "-WorkerPath",
        overlayScript,
        "-DispatchPath",
        dispatchScript,
        "-PayloadBase64",
        payload,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    child.on("error", () => {});
  },
});
