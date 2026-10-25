# Dispatch: picks the notifier front-end for a completed turn.
#
# Zero-setup, plugin-friendly:
#   - Anya (Electron) is used when its runtime is available.
#   - Otherwise the classic PowerShell overlay is used IMMEDIATELY (the user is
#     never left without a reminder), and the Electron runtime is fetched in the
#     background so later turns use Anya automatically.
#
# Runs from runtime/ (and from each adapter's self-contained runtime/ copy).
# The Anya app itself is resolved relative to the plugin, or from a shared
# per-user location that this script provisions on demand.

param(
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA "AI CLI Notify"),
    [string]$WorkerPath = ""
)

$ErrorActionPreference = "SilentlyContinue"

function Write-DispatchLog {
    param([string]$Message, [string]$Level = "INFO")
    if (-not $env:AI_CLI_NOTIFY_LOG) { return }
    try {
        $logPath = Join-Path $StateDirectory "notify.log"
        $line = "{0} [{1}] [dispatch] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $Level, $Message
        [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, [Text.Encoding]::UTF8)
    } catch {}
}

if ([string]::IsNullOrWhiteSpace($WorkerPath)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $WorkerPath = Join-Path $scriptDir "overlay.ps1"
}

$sharedRoot = Join-Path $env:LOCALAPPDATA "ai-cli-notify"
$sharedApp = Join-Path $sharedRoot "anya-notifier"
$electronExe = Join-Path (Join-Path $sharedRoot "electron") "electron.exe"
$electronMetadata = Join-Path (Join-Path $sharedRoot "electron") "electron-release.json"
$expectedElectronVersion = if ($env:ANYA_NOTIFY_ELECTRON_VERSION) { $env:ANYA_NOTIFY_ELECTRON_VERSION } else { "33.4.11" }
$configPath = Join-Path $StateDirectory "anya-config.json"

# ---- Config (optional; created with defaults on first run) --------------------
$config = @{}
if (Test-Path -LiteralPath $configPath) {
    try { $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } catch { $config = @{} }
}

# ---- Locate the Anya app (no copying; run it in place when possible) ---------
function Get-AnyaAppDir {
    if ($config.appDir -and (Test-Path -LiteralPath (Join-Path ([string]$config.appDir) "src\main.js"))) {
        return [string]$config.appDir
    }
    # 1. Sibling of this runtime/ dir (repo layout).
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $candidates = @(
        (Join-Path $scriptDir "anya-notifier"),
        (Join-Path (Split-Path -Parent $scriptDir) "anya-notifier"),
        (Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) "anya-notifier"),
        $sharedApp
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath (Join-Path $c "src\main.js"))) { return $c }
    }
    return $null
}

function Get-ElectronPath {
    if ($config.electronPath -and (Test-Path -LiteralPath ([string]$config.electronPath))) {
        return [string]$config.electronPath
    }
    if ($env:ANYA_NOTIFY_ELECTRON_PATH -and (Test-Path -LiteralPath $env:ANYA_NOTIFY_ELECTRON_PATH)) {
        return $env:ANYA_NOTIFY_ELECTRON_PATH
    }
    if ((Test-Path -LiteralPath $electronExe -PathType Leaf) -and
        (Test-Path -LiteralPath $electronMetadata -PathType Leaf)) {
        try {
            $release = Get-Content -LiteralPath $electronMetadata -Raw | ConvertFrom-Json
            $expectedArtifact = "electron-v$expectedElectronVersion-win32-x64.zip"
            if ($release.version -eq $expectedElectronVersion -and
                $release.artifact -eq $expectedArtifact -and
                [string]$release.sha256 -match "^[a-fA-F0-9]{64}$") {
                return $electronExe
            }
        } catch {}
    }
    return $null
}

# ---- Background provisioning of the Electron runtime -------------------------
function Start-ElectronDownload {
    # A marker file prevents concurrent/duplicate downloads across rapid events.
    $marker = Join-Path $sharedRoot "electron-download.lock"
    if (Test-Path -LiteralPath $marker) {
        $markerIsActive = $false
        try {
            $markerText = Get-Content -LiteralPath $marker -Raw
            try { $download = $markerText | ConvertFrom-Json -ErrorAction Stop } catch { $download = $null }
            if ($download.pid) {
                $process = Get-Process -Id ([int]$download.pid) -ErrorAction SilentlyContinue
                if ($process) {
                    $markerStarted = [DateTimeOffset]::Parse([string]$download.started).UtcDateTime
                    $markerIsActive = $process.StartTime.ToUniversalTime() -le $markerStarted.AddSeconds(5)
                }
            } else {
                # Malformed or legacy markers are judged by their age.
                $age = (Get-Date) - (Get-Item -LiteralPath $marker).LastWriteTime
                $markerIsActive = $age.TotalMinutes -lt 30
            }
        } catch {
            $markerIsActive = $false
        }
        if ($markerIsActive) { return }
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    }
    $appDir = Get-AnyaAppDir
    if (-not $appDir) { return }
    $ensureScript = Join-Path $appDir "scripts\ensure-electron.js"
    if (-not (Test-Path -LiteralPath $ensureScript)) { return }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { return }

    New-Item -ItemType Directory -Path $sharedRoot -Force | Out-Null
    try {
        Start-Process -FilePath $node.Source -ArgumentList @("`"$ensureScript`"") -WindowStyle Hidden | Out-Null
        Write-DispatchLog "background Electron download started"
    } catch {
        Write-DispatchLog "could not start Electron download: $_" "WARN"
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    }
}

# ---- Choose front-end --------------------------------------------------------
$useAnya = ($config.useAnya -ne $false)
$appDir = Get-AnyaAppDir
$electron = Get-ElectronPath

if ($useAnya -and $electron -and $appDir) {
    try {
        # Some Node-based CLI wrappers set NODE_OPTIONS flags that Electron
        # rejects before loading the app. Isolate this Electron child only.
        $savedNodeOptions = $env:NODE_OPTIONS
        try {
            $env:NODE_OPTIONS = ""
            $electronLog = if ($env:AI_CLI_NOTIFY_LOG) {
                Join-Path $StateDirectory ("electron-{0}.log" -f [DateTime]::UtcNow.ToString("yyyyMMdd"))
            } else { $null }
            if ($electronLog) {
                $electronErrorLog = Join-Path $StateDirectory ("electron-error-{0}.log" -f [DateTime]::UtcNow.ToString("yyyyMMdd"))
                $process = Start-Process -FilePath $electron -ArgumentList @("`"$appDir`"") -WindowStyle Hidden `
                    -RedirectStandardOutput $electronLog -RedirectStandardError $electronErrorLog -PassThru
                Write-DispatchLog "Anya process started (pid=$($process.Id), log=$electronLog, errorLog=$electronErrorLog)"
            } else {
                Start-Process -FilePath $electron -ArgumentList @("`"$appDir`"") -WindowStyle Hidden
            }
        } finally {
            $env:NODE_OPTIONS = $savedNodeOptions
        }
        Write-DispatchLog "Anya notifier started"
        exit 0
    } catch {
        Write-DispatchLog "Anya start failed, using overlay: $_" "WARN"
    }
} else {
    Write-DispatchLog ("Anya unavailable (useAnya=$useAnya electron=" + [bool]$electron + " app=" + [bool]$appDir + ")")
    if ($useAnya -and $appDir -and -not $electron) {
        Start-ElectronDownload
    }
}

# Fallback: classic PowerShell overlay (immediate, dependency-free).
if (Test-Path -LiteralPath $WorkerPath) {
    $escapedWorker = $WorkerPath.Replace("'", "''")
    $escapedState = $StateDirectory.Replace("'", "''")
    $workerCommand = "& '$escapedWorker' -StateDirectory '$escapedState'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($workerCommand))
    Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded
    ) | Out-Null
    Write-DispatchLog "overlay.ps1 started"
}
