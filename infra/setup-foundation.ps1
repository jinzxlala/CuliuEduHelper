[CmdletBinding()]
param(
    [switch]$SkipPull,
    [switch]$SkipMigrations
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$InfraDir = $PSScriptRoot
$RepositoryRoot = Split-Path -Parent $InfraDir
$ComposeFile = Join-Path $InfraDir "docker-compose.yml"
$EnvFile = Join-Path $InfraDir ".env"

function Resolve-DockerExe {
    $command = Get-Command docker -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $localInstall = Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe"
    if (Test-Path -LiteralPath $localInstall -PathType Leaf) {
        return $localInstall
    }

    $machineInstall = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
    if (Test-Path -LiteralPath $machineInstall -PathType Leaf) {
        return $machineInstall
    }

    throw "Docker CLI was not found. Start or reinstall Docker Desktop first."
}

function Invoke-Docker {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & $script:DockerExe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed: docker $($Arguments -join ' ')"
    }
}

function New-SecureToken {
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }

    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Test-MissingOrPlaceholder {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Values,
        [Parameter(Mandatory = $true)][string]$Key
    )

    return (-not $Values.ContainsKey($Key)) -or
        [string]::IsNullOrWhiteSpace([string]$Values[$Key]) -or
        ([string]$Values[$Key] -match '^replace(?:-|$)')
}

function Read-EnvValues {
    $values = @{}
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
        return $values
    }

    foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
        if ($line -match '^\s*#' -or $line -notmatch '=') {
            continue
        }
        $parts = $line -split '=', 2
        $values[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
    }
    return $values
}

function Write-EnvValues {
    param([Parameter(Mandatory = $true)][hashtable]$Values)

    $orderedKeys = @(
        "MEILI_HOST",
        "MEILI_MASTER_KEY",
        "POSTGRES_DB",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD",
        "DATABASE_URL",
        "DATABASE_POOL_MAX",
        "NEXTAUTH_SECRET",
        "NEXTAUTH_URL",
        "REDIS_PASSWORD",
        "REDIS_URL",
        "LOCAL_STORAGE_ROOT",
        "BACKUP_ROOT",
        "BACKUP_ENCRYPTION_KEY",
        "POSTGRES_CONTAINER_NAME",
        "DEEPSEEK_API_KEY"
    )
    $lines = foreach ($key in $orderedKeys) {
        if ($Values.ContainsKey($key)) {
            "$key=$($Values[$key])"
        }
    }
    $remainingKeys = $Values.Keys | Where-Object { $_ -notin $orderedKeys } | Sort-Object
    foreach ($key in $remainingKeys) {
        $lines += "$key=$($Values[$key])"
    }

    [System.IO.File]::WriteAllText(
        $EnvFile,
        (($lines -join "`r`n") + "`r`n"),
        (New-Object System.Text.UTF8Encoding($false))
    )
}

function Ensure-LocalEnv {
    $values = Read-EnvValues
    if (Test-MissingOrPlaceholder -Values $values -Key "MEILI_HOST") {
        $values["MEILI_HOST"] = "http://127.0.0.1:7700"
    }
    if (Test-MissingOrPlaceholder -Values $values -Key "MEILI_MASTER_KEY") {
        $values["MEILI_MASTER_KEY"] = New-SecureToken
    }
    if (Test-MissingOrPlaceholder -Values $values -Key "POSTGRES_DB") {
        $values["POSTGRES_DB"] = "culiu_edu_helper"
    }
    if (Test-MissingOrPlaceholder -Values $values -Key "POSTGRES_USER") {
        $values["POSTGRES_USER"] = "culiu"
    }
    if (Test-MissingOrPlaceholder -Values $values -Key "POSTGRES_PASSWORD") {
        $values["POSTGRES_PASSWORD"] = New-SecureToken
    }
    if (Test-MissingOrPlaceholder -Values $values -Key "DATABASE_POOL_MAX") {
        $values["DATABASE_POOL_MAX"] = "10"
    }
    if (Test-MissingOrPlaceholder -Values $values -Key "NEXTAUTH_SECRET") {
        $values["NEXTAUTH_SECRET"] = New-SecureToken
    }
    if (Test-MissingOrPlaceholder -Values $values -Key "NEXTAUTH_URL") {
        $values["NEXTAUTH_URL"] = "http://127.0.0.1:3000"
    }
    if (Test-MissingOrPlaceholder -Values $values -Key "REDIS_PASSWORD") {
        $values["REDIS_PASSWORD"] = New-SecureToken
    }

    $databasePassword = [Uri]::EscapeDataString($values["POSTGRES_PASSWORD"])
    $redisPassword = [Uri]::EscapeDataString($values["REDIS_PASSWORD"])
    $values["DATABASE_URL"] = "postgresql://$($values['POSTGRES_USER']):$databasePassword@127.0.0.1:5432/$($values['POSTGRES_DB'])"
    $values["REDIS_URL"] = "redis://:$redisPassword@127.0.0.1:6379"

    if (Test-MissingOrPlaceholder -Values $values -Key "LOCAL_STORAGE_ROOT") {
        $storagePath = Join-Path $RepositoryRoot ".local-data\evidence"
        $values["LOCAL_STORAGE_ROOT"] = $storagePath.Replace('\', '/')
    }
    if (Test-MissingOrPlaceholder -Values $values -Key "BACKUP_ROOT") {
        $backupPath = Join-Path $RepositoryRoot ".local-data\backups"
        $values["BACKUP_ROOT"] = $backupPath.Replace('\', '/')
    }
    if (Test-MissingOrPlaceholder -Values $values -Key "BACKUP_ENCRYPTION_KEY") {
        $values["BACKUP_ENCRYPTION_KEY"] = New-SecureToken
    }
    if (Test-MissingOrPlaceholder -Values $values -Key "POSTGRES_CONTAINER_NAME") {
        $values["POSTGRES_CONTAINER_NAME"] = "culiu-edu-helper-postgres"
    }

    Write-EnvValues -Values $values
    return $values
}

function Wait-ForHealthyContainer {
    param([Parameter(Mandatory = $true)][string]$ContainerName)

    for ($attempt = 1; $attempt -le 30; $attempt++) {
        $status = & $script:DockerExe inspect --format "{{.State.Health.Status}}" $ContainerName 2>$null
        if ($LASTEXITCODE -eq 0 -and $status -eq "healthy") {
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "Container did not become healthy: $ContainerName"
}

$script:DockerExe = Resolve-DockerExe
$dockerDirectory = Split-Path -Parent $script:DockerExe
$env:PATH = "$dockerDirectory;$env:PATH"
$values = Ensure-LocalEnv

foreach ($entry in $values.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
}

$compose = @("compose", "--env-file", $EnvFile, "-f", $ComposeFile)
Invoke-Docker -Arguments ($compose + @("config", "--quiet"))
if (-not $SkipPull) {
    Invoke-Docker -Arguments ($compose + @("pull", "postgres", "redis"))
}
Invoke-Docker -Arguments ($compose + @("up", "-d", "postgres", "redis"))

Wait-ForHealthyContainer -ContainerName "culiu-edu-helper-postgres"
Wait-ForHealthyContainer -ContainerName "culiu-edu-helper-redis"

if (-not $SkipMigrations) {
    $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        $pnpm = Get-Command pnpm -ErrorAction Stop
    }

    Push-Location $RepositoryRoot
    try {
        & $pnpm.Source --filter "@culiu/database" db:migrate
        if ($LASTEXITCODE -ne 0) {
            throw "Database migration command failed."
        }
        & $pnpm.Source --filter "@culiu/database" db:seed
        if ($LASTEXITCODE -ne 0) {
            throw "Redacted fixture command failed."
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host "PostgreSQL and Redis are healthy; secrets remain in ignored infra/.env."
