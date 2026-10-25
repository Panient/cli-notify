# Syncs the canonical runtime scripts and Anya app into adapter plugin payloads.
# runtime/ and anya-notifier/ at the repository root are the source of truth.
#
#   .\sync-runtime.ps1          # copy root runtime -> adapters (fix drift)
#   .\sync-runtime.ps1 -Check   # verify only; exit code 1 if drift detected

[CmdletBinding()]
param([switch]$Check)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$sourceDir = Join-Path $root "runtime"
$files = @("hook.ps1", "overlay.ps1", "dispatch.ps1")
$adapterDirs = @("codex", "claude", "grok") | ForEach-Object {
    Join-Path $root "adapters\$_\runtime"
}
$anyaSourceDir = Join-Path $root "anya-notifier"
$anyaAdapterDirs = @("codex", "claude", "grok", "opencode") | ForEach-Object {
    Join-Path $root "adapters\$_\anya-notifier"
}
$openCodeScriptFiles = [ordered]@{
    "hook.ps1" = "ai-cli-notify-hook.ps1"
    "overlay.ps1" = "ai-cli-notify-overlay.ps1"
    "dispatch.ps1" = "ai-cli-notify-dispatch.ps1"
}

$drifted = [System.Collections.Generic.List[string]]::new()

foreach ($dir in $adapterDirs) {
    foreach ($file in $files) {
        $sourcePath = Join-Path $sourceDir $file
        $targetPath = Join-Path $dir $file

        $needsSync = $true
        if (Test-Path -LiteralPath $targetPath) {
            $sourceBytes = [IO.File]::ReadAllBytes($sourcePath)
            $targetBytes = [IO.File]::ReadAllBytes($targetPath)
            if ($sourceBytes.Length -eq $targetBytes.Length) {
                $needsSync = $false
                for ($i = 0; $i -lt $sourceBytes.Length; $i++) {
                    if ($sourceBytes[$i] -ne $targetBytes[$i]) { $needsSync = $true; break }
                }
            }
        }

        if (-not $needsSync) { continue }

        $label = $targetPath.Substring($root.Length + 1)
        if ($Check) {
            Write-Output "DRIFT: $label"
            $drifted.Add($label)
        } else {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
            Write-Output "SYNCED: $label"
        }
    }
}

# Anya is kept once at the repository root and copied into the self-contained
# plugin payloads. Do not copy development dependencies or tests into a plugin.
$anyaFiles = @()
if (Test-Path -LiteralPath $anyaSourceDir) {
    $anyaFiles = Get-ChildItem -LiteralPath $anyaSourceDir -Recurse -File |
        Where-Object { $_.FullName -notmatch "(?:^|[\\/])(?:node_modules|test)(?:[\\/]|$)" } |
        ForEach-Object { $_.FullName.Substring($anyaSourceDir.Length + 1) }
}

foreach ($dir in $anyaAdapterDirs) {
    $expectedFiles = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($relative in $anyaFiles) { [void]$expectedFiles.Add($relative) }
    if (Test-Path -LiteralPath $dir) {
        foreach ($targetFile in (Get-ChildItem -LiteralPath $dir -Recurse -File)) {
            $relative = $targetFile.FullName.Substring($dir.Length + 1)
            if ($relative -match "(?:^|[\\/])(?:node_modules|test)(?:[\\/]|$)") {
                $label = $targetFile.FullName.Substring($root.Length + 1)
                if ($Check) {
                    Write-Output "EXTRANEOUS: $label"
                    $drifted.Add($label)
                } else {
                    Remove-Item -LiteralPath $targetFile.FullName -Force
                    Write-Output "REMOVED: $label"
                }
            } elseif (-not $expectedFiles.Contains($relative)) {
                $label = $targetFile.FullName.Substring($root.Length + 1)
                Write-Output "EXTRA (not removed): $label"
            }
        }
    }
    foreach ($relative in $anyaFiles) {
        $sourcePath = Join-Path $anyaSourceDir $relative
        $targetPath = Join-Path $dir $relative

        $needsSync = $true
        if (Test-Path -LiteralPath $targetPath) {
            $sourceBytes = [IO.File]::ReadAllBytes($sourcePath)
            $targetBytes = [IO.File]::ReadAllBytes($targetPath)
            if ($sourceBytes.Length -eq $targetBytes.Length) {
                $needsSync = $false
                for ($i = 0; $i -lt $sourceBytes.Length; $i++) {
                    if ($sourceBytes[$i] -ne $targetBytes[$i]) { $needsSync = $true; break }
                }
            }
        }

        if (-not $needsSync) { continue }

        $label = $targetPath.Substring($root.Length + 1)
        if ($Check) {
            Write-Output "DRIFT: $label"
            $drifted.Add($label)
        } else {
            $targetDir = Split-Path -Parent $targetPath
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
            Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
            Write-Output "SYNCED: $label"
        }
    }
}

# OpenCode loads a flat JS plugin directory, so its self-contained PowerShell
# runtime scripts use stable, prefixed names next to the plugin entry point.
$opencodeDir = Join-Path $root "adapters\opencode"
foreach ($sourceName in $openCodeScriptFiles.Keys) {
    $sourcePath = Join-Path $sourceDir $sourceName
    $targetPath = Join-Path $opencodeDir $openCodeScriptFiles[$sourceName]
    $needsSync = $true
    if (Test-Path -LiteralPath $targetPath) {
        $sourceBytes = [IO.File]::ReadAllBytes($sourcePath)
        $targetBytes = [IO.File]::ReadAllBytes($targetPath)
        if ($sourceBytes.Length -eq $targetBytes.Length) {
            $needsSync = $false
            for ($i = 0; $i -lt $sourceBytes.Length; $i++) {
                if ($sourceBytes[$i] -ne $targetBytes[$i]) { $needsSync = $true; break }
            }
        }
    }
    if (-not $needsSync) { continue }

    $label = $targetPath.Substring($root.Length + 1)
    if ($Check) {
        Write-Output "DRIFT: $label"
        $drifted.Add($label)
    } else {
        New-Item -ItemType Directory -Path $opencodeDir -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
        Write-Output "SYNCED: $label"
    }
}

if ($Check) {
    if ($drifted.Count -gt 0) {
        Write-Output "$($drifted.Count) file(s) out of sync with the canonical runtime/ or anya-notifier/. Run sync-runtime.ps1 to fix."
        exit 1
    }
    Write-Output "All adapter copies match runtime/."
} elseif ($drifted.Count -eq 0 -and -not $PSCmdlet.MyInvocation.BoundParameters.ContainsKey("Check")) {
    Write-Output "All adapter copies are up to date."
}
