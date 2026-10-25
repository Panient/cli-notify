# Dispatch the one and only front-end: the large Electron Anya reminder.
# Events remain on disk until that Anya process consumes them. If Electron is
# not ready, provision it and retry; never start a second/classic interface.
# Runs from runtime/ and from each self-contained platform package.

param(
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA "AI CLI Notify"),
    [int]$RetryCount = 1,
    [int]$RetryDelaySeconds = 15
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

function Test-AnyaDispatchEnabled {
    if ($env:AI_CLI_NOTIFY_TEST) { return $false }
    if ($env:AI_CLI_NOTIFY_STATE_DIRECTORY) {
        return [IO.Path]::GetFullPath($env:AI_CLI_NOTIFY_STATE_DIRECTORY).TrimEnd('\') -ieq [IO.Path]::GetFullPath($StateDirectory).TrimEnd('\')
    }
    return $true
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
$useAnya = ($config.useAnya -ne $false)
if (-not $useAnya) {
    Write-DispatchLog "Anya is disabled; event remains queued. The legacy overlay has been removed."
    exit 0
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
    if (-not (Test-AnyaDispatchEnabled)) { return }
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

    New-Item -ItemType Directory -Path $sharedRoot -Force | Out-Null
    try {
        # Reuse the explicit install bootstrap for npm and GitHub installs.
        # A completed bootstrap atomically provisions the shared runtime.
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        $sharedBootstrap = Join-Path $sharedRoot "bootstrap\ensure-electron.cmd"
        $launch = if ($node) { $node.Source } elseif (Test-Path -LiteralPath $sharedBootstrap) { $sharedBootstrap } else { $null }
        if (-not $launch) {
            Write-DispatchLog "Node.js is required for the first Electron bootstrap; event remains queued" "WARN"
            return
        }
        Start-Process -FilePath $launch -ArgumentList @("`"$ensureScript`"", "--app-dir", "`"$appDir`"", "--state-directory", "`"$StateDirectory`"") -WindowStyle Hidden | Out-Null
        Write-DispatchLog "background Electron bootstrap started"
    } catch {
        Write-DispatchLog "could not start Electron bootstrap: $_" "WARN"
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    }
}

# ---- Choose the sole front-end ----------------------------------------------
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
        Write-DispatchLog "Anya start failed; event remains queued: $_" "ERROR"
    }
} else {
    Write-DispatchLog ("Anya unavailable; event remains queued (useAnya=$useAnya electron=" + [bool]$electron + " app=" + [bool]$appDir + ")")
    if ($useAnya -and $appDir -and -not $electron) {
        Start-ElectronDownload
    }
}

# A bounded retry covers the first Electron download. Later events dispatch
# immediately, and the queue itself remains the durable source of truth.
if ($useAnya -and $appDir -and $RetryCount -gt 0 -and (Test-AnyaDispatchEnabled)) {
    $self = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
    if (Test-Path -LiteralPath $self) {
        $command = "Start-Sleep -Seconds $([Math]::Max(1, $RetryDelaySeconds)); & '$($self.Replace("'", "''"))' -StateDirectory '$($StateDirectory.Replace("'", "''"))' -RetryCount $($RetryCount - 1) -RetryDelaySeconds $RetryDelaySeconds"
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
        Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded) | Out-Null
        Write-DispatchLog "Anya retry scheduled; no secondary notifier will be started"
    }
}
