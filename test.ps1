$ErrorActionPreference = "Stop"
$hook = Join-Path $PSScriptRoot "runtime\hook.ps1"
$payload = '{"hook_event_name":"AfterAgent","prompt_response":"AI CLI Notify test passed."}'
& $hook -Source Gemini -Payload $payload
Write-Output "Test completion queued. The reminder stays until you return to the terminal or close its window."
