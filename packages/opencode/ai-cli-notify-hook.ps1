param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Codex", "Claude", "Gemini", "GrokBuild", "OpenCode", "Pi")]
    [string]$Source,

    [string]$Payload,
    [string]$PayloadBase64,
    [switch]$GeminiOutput,
    [string]$DispatchPath = "",
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA "AI CLI Notify")
)

# $PSScriptRoot can be empty in some interop contexts; fall back to the
# directory of the running script so -File invocation always resolves.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

$ErrorActionPreference = "SilentlyContinue"

function Write-AiCliNotifyLog {
    param([string]$Message, [string]$Level = "INFO")
    if (-not $env:AI_CLI_NOTIFY_LOG) { return }
    try {
        $logPath = Join-Path (Join-Path $env:LOCALAPPDATA "AI CLI Notify") "notify.log"
        $line = "{0} [{1}] [hook:{2}] {3}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $Level, $Source, $Message
        [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, [Text.Encoding]::UTF8)
    } catch {
    }
}

$raw = $Payload

if (-not [string]::IsNullOrWhiteSpace($PayloadBase64)) {
    try {
        $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
    } catch {
        $raw = ""
    }
} elseif ([string]::IsNullOrWhiteSpace($raw)) {
    try {
        $raw = [Console]::In.ReadToEnd()
    } catch {
        $raw = ""
    }
}

$data = $null
if (-not [string]::IsNullOrWhiteSpace($raw)) {
    try {
        $data = $raw | ConvertFrom-Json
    } catch {
        $data = $null
    }
}

$dataHasProperty = $null -ne $data
if ($dataHasProperty) {
    if ($data -is [System.Collections.IDictionary]) {
        $dataHasProperty = $data.Contains("type") -or $data.Contains("hook_event_name") -or
            $data.Contains("hookEventName") -or $data.Contains("reason") -or
            $data.Contains("aborted") -or $data.Contains("agent_type") -or $data.Contains("agentType") -or
            $data.Contains("subagentType") -or $data.Contains("cwd")
    } else {
        $dataHasProperty = $null -ne $data.PSObject.Properties["type"] -or
            $null -ne $data.PSObject.Properties["hook_event_name"] -or
            $null -ne $data.PSObject.Properties["hookEventName"] -or
            $null -ne $data.PSObject.Properties["reason"] -or
            $null -ne $data.PSObject.Properties["aborted"] -or
            $null -ne $data.PSObject.Properties["agent_type"] -or
            $null -ne $data.PSObject.Properties["agentType"] -or
            $null -ne $data.PSObject.Properties["subagentType"] -or
            $null -ne $data.PSObject.Properties["cwd"]
    }
}

$title = "$Source task completed"
$message = "The current turn has finished."
$shouldNotify = $true

if ($dataHasProperty) {
    Write-AiCliNotifyLog "event received"
    switch ($Source) {
        "Codex" {
            if ($data.type -and $data.type -ne "agent-turn-complete") {
                $shouldNotify = $false
            }
            $message = "Codex CLI has finished the current turn."
        }
        "Claude" {
            if ($data.hook_event_name -eq "SubagentStop" -or $data.agent_type -or $data.agentType) {
                $shouldNotify = $false
            }
            if ($data.hook_event_name -eq "StopFailure") {
                $title = "Claude Code turn failed"
            }
            $message = "Claude Code has finished the current turn."
        }
        "Gemini" {
            if ($data.hook_event_name -and $data.hook_event_name -ne "AfterAgent") {
                $shouldNotify = $false
            }
            $message = "Gemini CLI has finished the current turn."
        }
        "GrokBuild" {
            if ($data.hookEventName -and $data.hookEventName -ne "stop") {
                $shouldNotify = $false
            }
            if ($data.reason -and $data.reason -ne "end_turn") {
                $shouldNotify = $false
            }
            if ($data.subagentType) {
                $shouldNotify = $false
            }
            $message = "Grok Build has finished the current turn."
        }
        "OpenCode" {
            if ($data.type -and $data.type -ne "session.idle") {
                $shouldNotify = $false
            }
            $message = "The OpenCode session is ready."
        }
        "Pi" {
            if ($data.aborted -eq $true) {
                $title = "Pi turn interrupted"
                $message = "The Pi agent run was interrupted."
            } else {
                $message = "The Pi agent run has finished."
            }
        }
    }
}

$message = ($message -replace "\s+", " ").Trim()
if ([string]::IsNullOrWhiteSpace($message)) {
    $message = "The current turn has finished."
}
if ($message.Length -gt 240) {
    $message = $message.Substring(0, 237) + "..."
}

if ($shouldNotify) {
    try {
        $windowHandle = [Int64]0
        $windowProcessId = [Int64]0
        $windowProcessStartTicks = [Int64]0
        try {
            # One Toolhelp32 snapshot gives the pid->ppid map; avoids spawning a
            # slow WMI/CIM query for every level of the ancestor walk.
            Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AiCliNotifyProcessTree {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct PROCESSENTRY32 {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static Dictionary<uint, uint> GetParentMap() {
        var map = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        if (snapshot == new IntPtr(-1)) return map;
        try {
            var entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (Process32First(snapshot, ref entry)) {
                do {
                    map[entry.th32ProcessID] = entry.th32ParentProcessID;
                } while (Process32Next(snapshot, ref entry));
            }
        } finally {
            CloseHandle(snapshot);
        }
        return map;
    }
}

public static class AiCliNotifyWindowNative {
    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
}
"@
            $parentMap = [AiCliNotifyProcessTree]::GetParentMap()
            $processId = [uint32]$PID
            for ($depth = 0; $depth -lt 10; $depth++) {
                if (-not $parentMap.ContainsKey($processId)) { break }
                $parentId = [int]$parentMap[$processId]
                if ($parentId -eq 0) { break }
                $parent = Get-Process -Id $parentId -ErrorAction SilentlyContinue
                if ($parent -and $parent.MainWindowHandle.ToInt64() -ne 0) {
                    $mainWindow = $parent.MainWindowHandle
                    $rootWindow = [AiCliNotifyWindowNative]::GetAncestor($mainWindow, 2)
                    if ($rootWindow -eq [IntPtr]::Zero) { $rootWindow = $mainWindow }
                    $ownerProcessId = [uint32]0
                    [void][AiCliNotifyWindowNative]::GetWindowThreadProcessId($rootWindow, [ref]$ownerProcessId)
                    if ($ownerProcessId -eq 0) { $ownerProcessId = [uint32]$parent.Id }
                    $windowHandle = $rootWindow.ToInt64()
                    $windowProcessId = [Int64]$ownerProcessId
                    try {
                        $ownerProcess = Get-Process -Id ([int]$ownerProcessId) -ErrorAction Stop
                        $windowProcessStartTicks = [Int64]$ownerProcess.StartTime.ToUniversalTime().Ticks
                    } catch {
                        $windowProcessStartTicks = [Int64]0
                    }
                    break
                }
                $processId = [uint32]$parentId
            }
            # Without the owner PID and its start time, a reused HWND cannot
            # be distinguished safely. Use the bounded no-handle fallback.
            if ($windowProcessId -le 0 -or $windowProcessStartTicks -le 0) {
                $windowHandle = [Int64]0
                $windowProcessId = [Int64]0
                $windowProcessStartTicks = [Int64]0
            }
        } catch {
            $windowHandle = [Int64]0
            $windowProcessId = [Int64]0
            $windowProcessStartTicks = [Int64]0
        }

        $workingDirectory = $PWD.Path
        $payloadCwd = if ($data -is [System.Collections.IDictionary]) { $data["cwd"] } else { $data.cwd }
        if ($payloadCwd -and (Test-Path -LiteralPath ([string]$payloadCwd) -PathType Container)) {
            $workingDirectory = [string]$payloadCwd
        }
        Write-AiCliNotifyLog "dispatching overlay, windowHandle=$windowHandle terminalPid=$windowProcessId"
        $queueDirectory = Join-Path $StateDirectory "events"
        New-Item -ItemType Directory -Path $queueDirectory -Force | Out-Null
        $event = [ordered]@{
            title = $title
            message = $message
            source = $Source
            windowHandle = $windowHandle
            windowProcessId = $windowProcessId
            windowProcessStartTicks = [string]$windowProcessStartTicks
            cwd = $workingDirectory
            createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            aborted = ($data.aborted -eq $true)
        }
        $eventJson = ConvertTo-Json -InputObject $event -Compress
        $eventPath = Join-Path $queueDirectory ("{0}.json" -f [Guid]::NewGuid().ToString("N"))
        $temporaryPath = "$eventPath.tmp"
        [IO.File]::WriteAllText($temporaryPath, $eventJson, (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporaryPath -Destination $eventPath

        # There is only one front-end: the large Electron Anya. The durable
        # queue above is written before dispatch, so an unavailable runtime
        # never causes the completed task to be silently discarded.
        $dispatcher = $null
        $dispatcherCandidates = [System.Collections.Generic.List[string]]::new()
        if (-not [string]::IsNullOrWhiteSpace($DispatchPath)) {
            $dispatcherCandidates.Add($DispatchPath)
        }
        foreach ($name in @("dispatch.ps1", "ai-cli-notify-dispatch.ps1")) {
            $dispatcherCandidates.Add((Join-Path $scriptDir $name))
        }
        foreach ($candidate in $dispatcherCandidates) {
            if (Test-Path -LiteralPath $candidate) { $dispatcher = $candidate; break }
        }
        if ($dispatcher) {
            try {
                $escapedDispatch = $dispatcher.Replace("'", "''")
                $escapedStateDirectory = $StateDirectory.Replace("'", "''")
                $dispatchCommand = "& '$escapedDispatch' -StateDirectory '$escapedStateDirectory'"
                $encodedDispatch = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($dispatchCommand))
                Start-Process -FilePath "powershell.exe" -ArgumentList @(
                    "-NoProfile",
                    "-ExecutionPolicy", "Bypass",
                    "-EncodedCommand", $encodedDispatch
                ) | Out-Null
                Write-AiCliNotifyLog "Anya dispatcher started"
            } catch {
                Write-AiCliNotifyLog "Anya dispatcher failed; event remains queued: $_" "ERROR"
            }
        } else {
            Write-AiCliNotifyLog "Anya dispatcher missing; event remains queued" "ERROR"
        }
    } catch {
        Write-AiCliNotifyLog "dispatch failed: $_" "ERROR"
    }
}

if ($GeminiOutput) {
    [Console]::Out.WriteLine("{}")
}
