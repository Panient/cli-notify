param(
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA "AI CLI Notify")
)

$ErrorActionPreference = "Stop"

function Write-AiCliNotifyLog {
    param([string]$Message, [string]$Level = "INFO")
    if (-not $env:AI_CLI_NOTIFY_LOG) { return }
    try {
        $logPath = Join-Path (Join-Path $env:LOCALAPPDATA "AI CLI Notify") "notify.log"
        $line = "{0} [{1}] [overlay] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $Level, $Message
        [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, [Text.Encoding]::UTF8)
    } catch {
    }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class AiCliNotifyFloatingForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
}

public static class AiCliNotifyNative {
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("kernel32.dll")]
    public static extern bool FreeConsole();

    public static void ShowOverlay(IntPtr handle) {
        ShowWindow(handle, 4);
        SetWindowPos(handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040);
    }

    public static IntPtr RootWindow(IntPtr handle) {
        if (handle == IntPtr.Zero) return IntPtr.Zero;
        IntPtr root = GetAncestor(handle, 2);
        return root == IntPtr.Zero ? handle : root;
    }

    public static uint WindowProcessId(IntPtr handle) {
        uint processId;
        GetWindowThreadProcessId(handle, out processId);
        return processId;
    }

    public static long ProcessStartTicks(uint processId) {
        try {
            using (var process = System.Diagnostics.Process.GetProcessById((int)processId)) {
                return process.StartTime.ToUniversalTime().Ticks;
            }
        } catch {
            return 0;
        }
    }
}
"@ -ReferencedAssemblies @("System.Windows.Forms", "System.Drawing")

$script:QueueDirectory = Join-Path $StateDirectory "events"
$script:LatestEvent = $null
$script:Notifications = [System.Collections.Generic.List[object]]::new()
$script:Expanded = $false
$script:CollapseAt = [DateTime]::MaxValue
$script:IdleSince = [DateTime]::Now
$script:Form = $null
$script:TitleLabel = $null
$script:MessageLabel = $null
$script:CountBadge = $null
$script:IconPanel = $null
$script:LogoLabel = $null
$script:LogoFont = $null
$script:TitleFont = $null
$script:MessageFont = $null

New-Item -ItemType Directory -Path $script:QueueDirectory -Force | Out-Null

$mutex = [System.Threading.Mutex]::new($false, "Local\AiCliNotifyFrontend")
$ownsMutex = $false
try {
    $ownsMutex = $mutex.WaitOne(0)
    if (-not $ownsMutex) {
        $mutex.Dispose()
        $mutex = $null
        exit
    }
} catch [System.Threading.AbandonedMutexException] {
    $ownsMutex = $true
}

[AiCliNotifyNative]::FreeConsole() | Out-Null
Write-AiCliNotifyLog "overlay started, stateDirectory=$StateDirectory"

function Set-RoundedRegion {
    param(
        [System.Windows.Forms.Control]$Control,
        [int]$Radius
    )

    $diameter = [Math]::Min($Radius * 2, [Math]::Min($Control.Width, $Control.Height))
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $path.AddArc($Control.Width - $diameter, 0, $diameter, $diameter, 270, 90)
    $path.AddArc($Control.Width - $diameter, $Control.Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc(0, $Control.Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    if ($Control.Region) {
        $Control.Region.Dispose()
    }
    $Control.Region = [System.Drawing.Region]::new($path)
    $path.Dispose()
}

function Get-DisplaySource {
    if (-not $script:LatestEvent) { return "AI CLI" }
    switch ([string]$script:LatestEvent.source) {
        "Codex" { return "Codex CLI" }
        "Claude" { return "Claude Code" }
        "Gemini" { return "Gemini CLI" }
        "GrokBuild" { return "Grok Build" }
        "OpenCode" { return "OpenCode" }
        "Pi" { return "Pi" }
        default { return [string]$script:LatestEvent.source }
    }
}

function Get-CountLabel {
    if ($script:Notifications.Count -gt 9) { return "9+" }
    return [string]$script:Notifications.Count
}

function Update-Layout {
    if ($script:Expanded) {
        $script:Form.ClientSize = [System.Drawing.Size]::new(286, 78)
        $script:IconPanel.Location = [System.Drawing.Point]::new(14, 17)
        $script:IconPanel.Size = [System.Drawing.Size]::new(44, 44)
        $script:CountBadge.Location = [System.Drawing.Point]::new(43, 5)
        $script:CountBadge.Size = [System.Drawing.Size]::new(23, 23)
        $script:TitleLabel.Location = [System.Drawing.Point]::new(70, 15)
        $script:TitleLabel.Size = [System.Drawing.Size]::new(200, 24)
        $script:MessageLabel.Location = [System.Drawing.Point]::new(70, 41)
        $script:MessageLabel.Size = [System.Drawing.Size]::new(200, 20)
        $script:TitleLabel.Visible = $true
        $script:MessageLabel.Visible = $true
    } else {
        $script:Form.ClientSize = [System.Drawing.Size]::new(64, 64)
        $script:IconPanel.Location = [System.Drawing.Point]::new(4, 4)
        $script:IconPanel.Size = [System.Drawing.Size]::new(56, 56)
        $script:CountBadge.Location = [System.Drawing.Point]::new(34, 2)
        $script:CountBadge.Size = [System.Drawing.Size]::new(26, 26)
        $script:TitleLabel.Visible = $false
        $script:MessageLabel.Visible = $false
    }

    $script:LogoLabel.Size = $script:IconPanel.ClientSize
    $script:CountBadge.Text = Get-CountLabel
    Set-RoundedRegion -Control $script:IconPanel -Radius 13
    Set-RoundedRegion -Control $script:CountBadge -Radius 11
    Set-RoundedRegion -Control $script:Form -Radius 17

    $workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $script:Form.Location = [System.Drawing.Point]::new(
        $workArea.Right - $script:Form.Width - 20,
        $workArea.Bottom - $script:Form.Height - 22
    )
}

function Update-Notification {
    if (-not $script:LatestEvent) { return }

    $source = Get-DisplaySource
    if ($script:LatestEvent.aborted -eq $true) {
        $script:TitleLabel.Text = "$source 已中断"
        $script:MessageLabel.Text = "本次运行已停止。"
    } else {
        $script:TitleLabel.Text = "$source 已完成"
        $script:MessageLabel.Text = "任务已经完成，辛苦了。"
    }

    $script:Expanded = $true
    $script:CollapseAt = [DateTime]::Now.AddSeconds(8)
    $script:IdleSince = $null
    Update-Layout
    $script:Form.Opacity = 1
    $script:Form.TopMost = $true
    [AiCliNotifyNative]::ShowOverlay($script:Form.Handle)
}

$script:Watcher = $null
$script:WatcherEvent = $false
$script:LastFallbackScan = [DateTime]::MinValue

try {
    $script:Watcher = [System.IO.FileSystemWatcher]::new($script:QueueDirectory, "*.json")
    $script:Watcher.NotifyFilter = [System.IO.NotifyFilters]::FileName
    $script:Watcher.IncludeSubdirectories = $false
    $handler = { $script:WatcherEvent = $true }
    $script:Watcher.add_Created($handler)
    $script:Watcher.add_Renamed($handler)
    $script:Watcher.EnableRaisingEvents = $true
    Write-AiCliNotifyLog "FileSystemWatcher started on $script:QueueDirectory"
} catch {
    $script:Watcher = $null
    Write-AiCliNotifyLog "FileSystemWatcher unavailable, fallback scan only: $_" "WARN"
}

function Process-EventQueue {
    $changed = $false
    foreach ($file in (Get-ChildItem -LiteralPath $script:QueueDirectory -Filter "*.json" -File | Sort-Object Name)) {
        try {
            $event = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            $handle = [Int64]0
            if ($event.windowHandle) {
                try { $handle = [Int64]$event.windowHandle } catch {}
            }
            $processId = [uint32]0
            $processStartTicks = [Int64]0
            try { $processId = [uint32]$event.windowProcessId } catch {}
            try { $processStartTicks = [Int64]$event.windowProcessStartTicks } catch {}
            if ($processId -le 0 -or $processStartTicks -le 0) {
                $handle = [Int64]0
                $processId = [uint32]0
                $processStartTicks = [Int64]0
            }
            $script:Notifications.Add([pscustomobject]@{
                windowHandle = $handle
                windowProcessId = $processId
                windowProcessStartTicks = $processStartTicks
                leftTerminal = $false
                fallbackExpiry = [DateTime]::Now.AddMinutes(30)
            })
            $script:LatestEvent = $event
            $changed = $true
            Write-AiCliNotifyLog "event consumed from $($file.Name) source=$($event.source)"
        } catch {
            Write-AiCliNotifyLog "failed to process $($file.Name): $_" "ERROR"
        }
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    }

    if ($changed) {
        Update-Notification
    }
}

function Remove-ResolvedNotifications {
    if ($script:Notifications.Count -eq 0) { return }

    $foregroundRoot = [AiCliNotifyNative]::RootWindow([AiCliNotifyNative]::GetForegroundWindow())
    $resolved = [System.Collections.Generic.List[object]]::new()
    foreach ($notification in $script:Notifications) {
        $handle = [IntPtr]::new([Int64]$notification.windowHandle)
        if ($handle -eq [IntPtr]::Zero) {
            if ([DateTime]::Now -ge $notification.fallbackExpiry) {
                $resolved.Add($notification)
            }
            continue
        }

        if (-not [AiCliNotifyNative]::IsWindow($handle)) {
            $resolved.Add($notification)
            continue
        }

        $terminalRoot = [AiCliNotifyNative]::RootWindow($handle)
        if ($terminalRoot -ne $handle) {
            $resolved.Add($notification)
            continue
        }
        if ($notification.windowProcessId -gt 0) {
            $ownerProcessId = [AiCliNotifyNative]::WindowProcessId($terminalRoot)
            if ($ownerProcessId -le 0) {
                continue
            }
            if ($ownerProcessId -ne $notification.windowProcessId) {
                $resolved.Add($notification)
                continue
            }
            if ($notification.windowProcessStartTicks -gt 0 -and $ownerProcessId -gt 0) {
                $actualStartTicks = [AiCliNotifyNative]::ProcessStartTicks($ownerProcessId)
                if ($actualStartTicks -gt 0 -and $actualStartTicks -ne $notification.windowProcessStartTicks) {
                    $resolved.Add($notification)
                    continue
                }
            }
        }
        if ($foregroundRoot -eq [IntPtr]::Zero) {
            continue
        }
        if ($foregroundRoot -eq $terminalRoot) {
            if ($notification.leftTerminal) {
                $resolved.Add($notification)
            }
        } else {
            $notification.leftTerminal = $true
        }
    }

    $changed = $false
    foreach ($notification in $resolved) {
        [void]$script:Notifications.Remove($notification)
        $changed = $true
    }
    if ($changed -and $script:Notifications.Count -gt 0) {
        $script:CountBadge.Text = Get-CountLabel
    }
    if ($script:Notifications.Count -eq 0) {
        Write-AiCliNotifyLog "all notifications resolved, closing"
        $script:Form.Close()
    }
}

$script:Form = [AiCliNotifyFloatingForm]::new()
$script:Form.ShowInTaskbar = $false
$script:Form.ShowIcon = $false
$script:Form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$script:Form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$script:Form.TopMost = $true
$script:Form.BackColor = [System.Drawing.Color]::FromArgb(250, 251, 250)
$script:Form.ClientSize = [System.Drawing.Size]::new(286, 78)
$script:Form.Opacity = 0
$script:Form.Text = "AI CLI Notify"

$script:IconPanel = [System.Windows.Forms.Panel]::new()
$script:IconPanel.BackColor = [System.Drawing.Color]::FromArgb(32, 112, 104)
$script:LogoLabel = [System.Windows.Forms.Label]::new()
$script:LogoLabel.Text = "AI"
$script:LogoLabel.ForeColor = [System.Drawing.Color]::White
$script:LogoLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$script:LogoLabel.BackColor = [System.Drawing.Color]::Transparent
$script:LogoFont = [System.Drawing.Font]::new("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$script:LogoLabel.Font = $script:LogoFont
$script:IconPanel.Controls.Add($script:LogoLabel)

$script:CountBadge = [System.Windows.Forms.Label]::new()
$script:CountBadge.BackColor = [System.Drawing.Color]::FromArgb(210, 69, 74)
$script:CountBadge.ForeColor = [System.Drawing.Color]::White
$script:CountBadge.Font = [System.Drawing.Font]::new("Segoe UI", 8, [System.Drawing.FontStyle]::Bold)
$script:CountBadge.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter

$script:TitleLabel = [System.Windows.Forms.Label]::new()
$script:TitleLabel.ForeColor = [System.Drawing.Color]::FromArgb(37, 48, 52)
$script:TitleFont = [System.Drawing.Font]::new("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$script:TitleLabel.Font = $script:TitleFont
$script:TitleLabel.AutoEllipsis = $true

$script:MessageLabel = [System.Windows.Forms.Label]::new()
$script:MessageLabel.ForeColor = [System.Drawing.Color]::FromArgb(93, 104, 106)
$script:MessageFont = [System.Drawing.Font]::new("Segoe UI", 9)
$script:MessageLabel.Font = $script:MessageFont
$script:MessageLabel.AutoEllipsis = $true

$script:Form.Controls.Add($script:IconPanel)
$script:Form.Controls.Add($script:CountBadge)
$script:Form.Controls.Add($script:TitleLabel)
$script:Form.Controls.Add($script:MessageLabel)
Update-Layout
$script:Form.Add_Shown({
    if ($script:Notifications.Count -gt 0) {
        $script:Form.Opacity = 1
        [AiCliNotifyNative]::ShowOverlay($script:Form.Handle)
    }
})

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 200
$timer.Add_Tick({
    # Event-driven path: process the queue immediately when the watcher fires.
    # Fallback: if the watcher is unavailable or missed an event, scan at most
    # once every 2 seconds instead of the old every-tick full directory scan.
    $fallbackDue = ([DateTime]::Now - $script:LastFallbackScan).TotalSeconds -ge 2
    if ($script:WatcherEvent -or $null -eq $script:Watcher -or $fallbackDue) {
        $script:WatcherEvent = $false
        $script:LastFallbackScan = [DateTime]::Now
        Process-EventQueue
    }
    if ($script:Expanded -and [DateTime]::Now -ge $script:CollapseAt) {
        $script:Expanded = $false
        Update-Layout
    }
    if ($script:Notifications.Count -gt 0) {
        Remove-ResolvedNotifications
    } elseif (([DateTime]::Now - $script:IdleSince).TotalSeconds -ge 2 -and
        -not (Get-ChildItem -LiteralPath $script:QueueDirectory -Filter "*.json" -File -ErrorAction SilentlyContinue)) {
        $script:Form.Close()
    }
})

$script:Form.Add_FormClosed({
    $timer.Stop()
    $timer.Dispose()
    if ($script:Watcher) {
        $script:Watcher.EnableRaisingEvents = $false
        $script:Watcher.Dispose()
    }
    $script:LogoFont.Dispose()
    $script:TitleFont.Dispose()
    $script:MessageFont.Dispose()
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
})
$timer.Start()
[System.Windows.Forms.Application]::Run($script:Form)
