"use strict";
// Windows-only native bounds inspection and process-tree cleanup for the real
// Electron visual test. No third-party native module is added to the product.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

function nativeScript(root) {
  const file = path.join(root, "native-window.ps1");
  fs.writeFileSync(file, String.raw`param([int]$ProcessId, [int]$X = -1, [int]$Y = -1, [switch]$Hover, [switch]$Drag)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct AnyaTestRect { public int Left, Top, Right, Bottom; }
public static class AnyaTestNative {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out AnyaTestRect r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
$h = (Get-Process -Id $ProcessId -ErrorAction Stop).MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw "Anya native window handle is unavailable" }
if ($X -ge 0) { [void][AnyaTestNative]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010); Start-Sleep -Milliseconds 150 }
$r = New-Object AnyaTestRect
[void][AnyaTestNative]::GetWindowRect($h, [ref]$r)
if ($Hover -or $Drag) {
  $x = [int]($r.Left + ($r.Right - $r.Left) / 2)
  $y = [int]($r.Top + [Math]::Min(150, ($r.Bottom - $r.Top) / 2))
  [void][AnyaTestNative]::SetCursorPos($x, $y)
  if ($Drag) {
    Start-Sleep -Milliseconds 250
    [AnyaTestNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    for ($i = 1; $i -le 15; $i++) {
      [void][AnyaTestNative]::SetCursorPos($x + $i * 7, $y + $i * 4)
      Start-Sleep -Milliseconds 60
    }
    [AnyaTestNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
  Start-Sleep -Milliseconds 500
  [void][AnyaTestNative]::GetWindowRect($h, [ref]$r)
}
[pscustomobject]@{ handle=$h.ToInt64(); width=$r.Right-$r.Left; height=$r.Bottom-$r.Top; x=$r.Left; y=$r.Top } | ConvertTo-Json -Compress
`);
  return file;
}

function inspect(script, processId, options = {}) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ProcessId", String(processId)];
  if (Number.isInteger(options.x)) args.push("-X", String(options.x), "-Y", String(options.y));
  if (options.hover) args.push("-Hover");
  if (options.drag) args.push("-Drag");
  const result = execFileSync("powershell.exe", args, { encoding: "utf8", timeout: 20000, windowsHide: true });
  return JSON.parse(result.trim());
}

function stopTree(processId) {
  if (!processId) return;
  spawnSync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10000 });
}

function stopHelpers(root) {
  // Only inspect helper processes whose full command line belongs to this
  // isolated test root; never kill the user's real notifier or other CLIs.
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.Contains('${root.replaceAll("'", "''")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true, timeout: 10000 });
}

module.exports = { nativeScript, inspect, stopTree, stopHelpers };
