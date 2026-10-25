# Win32 window inspection is compiled once in the persistent worker. It is
# never invoked as a separate script per notification tick.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AnyaNotifyWindows {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
}
'@
function Get-AnyaWindowSnapshot {
    param([long[]]$Handles)
    $native = [AnyaNotifyWindows]
    $foreground = $native::GetForegroundWindow()
    $foregroundRoot = if ($foreground -eq [IntPtr]::Zero) { $foreground } else { $native::GetAncestor($foreground, 2) }
    if ($foregroundRoot -eq [IntPtr]::Zero) { $foregroundRoot = $foreground }
    function Get-Identity([IntPtr]$handle) {
        $processId = [uint32]0
        if ($handle -ne [IntPtr]::Zero) { [void]$native::GetWindowThreadProcessId($handle, [ref]$processId) }
        $startTicks = ""
        if ($processId -gt 0) {
            try { $startTicks = (Get-Process -Id ([int]$processId) -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString() } catch {}
        }
        return [pscustomobject]@{ processId = [int]$processId; startTicks = $startTicks }
    }
    $foregroundIdentity = Get-Identity $foregroundRoot
    $windows = @(
        foreach ($handleValue in $Handles) {
            if ($handleValue -gt 0 -and $native::IsWindow([IntPtr]$handleValue)) {
                $handle = [IntPtr]$handleValue
                $root = $native::GetAncestor($handle, 2)
                if ($root -eq [IntPtr]::Zero) { $root = $handle }
                $identity = Get-Identity $root
                [pscustomobject]@{ handle = $handleValue; root = $root.ToInt64(); processId = $identity.processId; startTicks = $identity.startTicks }
            }
        }
    )
    return [pscustomobject]@{
        foreground = [pscustomobject]@{ root = $foregroundRoot.ToInt64(); processId = $foregroundIdentity.processId; startTicks = $foregroundIdentity.startTicks }
        windows = @($windows)
    }
}
