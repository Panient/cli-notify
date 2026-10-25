# Converts Anya artwork into transparency-capable WebM animations for the
# notifier. Requires ffmpeg on PATH (winget install Gyan.FFmpeg).
#
# Usage examples:
#   .\make-animation.ps1 -Input ..\..\anya-celebrate.mp4 -Name celebrate
#   .\make-animation.ps1 -Input anya.gif -Name idle
#   .\make-animation.ps1 -Input sheet.png -Name celebrate -FrameWidth 192 -FrameHeight 208
#
# Output: ..\assets\animations\<Name>.webm  (VP9 + alpha, loops seamlessly)
#
# Notes on sources:
#   - Video/GIF with a solid background: pass -ChromaColor to key it out.
#   - Already-transparent PNG/WebP/APNG: no keying needed.
#   - Sprite sheet: pass -FrameWidth/-FrameHeight to slice into a sequence.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Input,
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$ChromaColor = "",        # e.g. "0x00FF00" for green screen
    [int]$FrameWidth = 0,
    [int]$FrameHeight = 0,
    [int]$Fps = 24,
    [int]$MaxWidth = 640
)

$ErrorActionPreference = "Stop"

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    throw "ffmpeg not found. Install it (winget install Gyan.FFmpeg) and reopen the terminal."
}

$outDir = Join-Path (Join-Path $PSScriptRoot "..") "assets\animations"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$outFile = Join-Path $outDir "$Name.webm"
$inFile = (Resolve-Path -LiteralPath $Input).Path

# Build the filter chain.
$filters = @()
if ($FrameWidth -gt 0 -and $FrameHeight -gt 0) {
    # Slice a sprite sheet into a numbered sequence first.
    $frameDir = Join-Path $env:TEMP ("anya-frames-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $frameDir -Force | Out-Null
    Write-Output "Slicing sprite sheet ${FrameWidth}x${FrameHeight} -> $frameDir"
    & $ffmpeg.Source -y -i $inFile -vf "crop=iw:ih:0:0,scale=$($MaxWidth):-1" "$frameDir\frame-%04d.png" 2>&1 | Out-Null
    $inFile = Join-Path $frameDir "frame-%04d.png"
}

if ($ChromaColor) {
    # Key out a solid color and keep alpha.
    $filters += "chromakey=$($ChromaColor.Replace('#','0x')):0.12:0.06"
}
$filters += "scale=$($MaxWidth):-1:flags=lanczos"
$vf = $filters -join ","

Write-Output "Encoding $Name.webm (VP9 + alpha) ..."
& $ffmpeg.Source -y -i $inFile -r $Fps -vf $vf `
    -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 32 `
    -auto-alt-ref 0 -an $outFile

if (Test-Path -LiteralPath $outFile) {
    $size = (Get-Item -LiteralPath $outFile).Length
    Write-Output "Done: $outFile ($([math]::Round($size/1KB)) KB)"
    Write-Output "The notifier picks this up automatically on the next event."
} else {
    throw "Encoding failed."
}
