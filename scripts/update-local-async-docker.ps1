param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
function Invoke-LocalDocker([string[]]$DockerArguments) {
    $previousPreference = $ErrorActionPreference
    try {
        # Compose writes ordinary build/progress messages to stderr in Windows PowerShell.
        $ErrorActionPreference = 'Continue'
        & docker @DockerArguments
        $dockerExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($dockerExitCode -ne 0) { throw "Docker command failed (exit $dockerExitCode)" }
}
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location $taskRoot
try {
    $compose = @('compose', '-p', 'npati-agent', '-f', 'docker-compose.yml', '-f', 'docker-compose.fresh-local.yml', '-f', 'docker-compose.sandbox-runner.yml')
    # Preserve the existing Desktop installation's locally prepared MinIO image when present.
    $localOverride = Join-Path $taskRoot 'artifacts/docker-compose.local-testing.yml'
    if (Test-Path -LiteralPath $localOverride) { $compose += @('-f', $localOverride) }
    Invoke-LocalDocker ($compose + @('config', '--quiet'))
    if (-not $SkipBuild) {
        Invoke-LocalDocker ($compose + @('build', 'agent-api', 'company-worker', 'sandbox-runner'))
    }
    Invoke-LocalDocker ($compose + @('up', '-d', '--remove-orphans', '--no-deps', '--wait', '--wait-timeout', '360', 'agent-api', 'company-worker', 'sandbox-runner'))
    # Chat branch admission runs here, not in the project-runtime toolchain.
    Invoke-LocalDocker ($compose + @('exec', '-T', 'agent-api', 'git', '--version'))
    Invoke-LocalDocker ($compose + @('exec', '-T', 'company-worker', 'git', '--version'))
    Write-Host 'Local async stack ready: combined frontend/API http://localhost:3000 (also http://localhost:3001), one shared project runtime http://localhost:7865'
} finally { Pop-Location }
