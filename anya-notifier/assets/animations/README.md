# Animation assets

The default character is the user-selected transparent PNG, cached per user on first launch. The high-DPI canvas-drawn character remains available when the image cannot be reached. If you have your own licensed animation, drop transparency-capable WebM files here to replace the PNG during its matching state:

- `celebrate.webm` — played when a turn completes
- `idle.webm` — played when a turn is aborted

Requirements: VP9 codec with alpha channel (`-pix_fmt yuva420p`), seamless loop, roughly 200-360 px tall.

Generate them from a video, GIF, or sprite sheet with `../../scripts/make-animation.ps1`:

```powershell
.\make-animation.ps1 -Input .\anya-celebrate.mp4 -Name celebrate
.\make-animation.ps1 -Input .\anya.mp4 -Name idle -ChromaColor "0x00FF00"
```

If these files are absent or fail to decode, the cached PNG is shown. If it is unavailable too, the built-in canvas character is drawn instead.
