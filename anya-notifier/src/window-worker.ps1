param()
$ErrorActionPreference = "Stop"
# The parent passes the shared Win32 query source through an environment
# variable; no writable helper script is created at runtime.
. ([ScriptBlock]::Create($env:AI_CLI_NOTIFY_WINDOW_QUERY))
$mutex = [System.Threading.Mutex]::new($false, $env:AI_CLI_NOTIFY_MUTEX_NAME)
$owned = $false
try {
    try { $owned = $mutex.WaitOne(15000) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) {
        [Console]::Out.WriteLine("BUSY")
        [Console]::Out.Flush()
        exit 0
    }
    [Console]::Out.WriteLine("LOCKED")
    [Console]::Out.Flush()
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line -or $line -eq "STOP") { break }
        if (-not $line.StartsWith("QUERY ")) { continue }
        $handles = @()
        if ($line.Length -gt 6) {
            $handles = @($line.Substring(6).Split(',') | ForEach-Object {
                $handle = [long]0
                if ([long]::TryParse($_, [ref]$handle)) { $handle }
            })
        }
        try {
            $result = Get-AnyaWindowSnapshot $handles
            $json = ConvertTo-Json -InputObject $result -Compress -Depth 4
            [Console]::Out.WriteLine($json)
        } catch {
            [Console]::Out.WriteLine("ERROR")
        }
        [Console]::Out.Flush()
    }
} finally {
    if ($owned) { try { $mutex.ReleaseMutex() } catch {} }
    $mutex.Dispose()
}
