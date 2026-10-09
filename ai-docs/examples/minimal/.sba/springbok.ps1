param(
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'
# Teaching skeleton: fail before any side effect. Never report a fake deployment.
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$result = [ordered]@{
    schemaVersion = $request.schemaVersion
    taskId = $request.taskId
    action = $request.action
    sourceSha = $request.sourceSha
    applicationVersion = $request.applicationVersion
    status = 'failed'
    checks = @()
    errorCode = 'EXAMPLE_NOT_IMPLEMENTED'
}
$temporary = $ResultPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
[IO.File]::WriteAllText($temporary, ($result | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
[IO.File]::Move($temporary, $ResultPath)
