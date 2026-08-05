[CmdletBinding()]
param(
    [string]$BaseUrl = "http://127.0.0.1:7700",
    [switch]$SkipPull,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$InfraDir = $PSScriptRoot
$ComposeFile = Join-Path $InfraDir "docker-compose.yml"
$EnvFile = Join-Path $InfraDir ".env"
$IndexDefinitionsFile = Join-Path $InfraDir "..\packages\search\index-definitions.json"

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

function New-LocalMasterKey {
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }

    return [Convert]::ToBase64String($bytes)
}

function Ensure-LocalEnv {
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
        $masterKey = New-LocalMasterKey
        $content = "MEILI_MASTER_KEY=$masterKey`r`n"
        [System.IO.File]::WriteAllText($EnvFile, $content, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "Created infra/.env with a generated local master key."
    }

    $keyLine = Get-Content -LiteralPath $EnvFile -Encoding UTF8 |
        Where-Object { $_ -match '^\s*MEILI_MASTER_KEY\s*=' } |
        Select-Object -First 1

    if (-not $keyLine) {
        throw "MEILI_MASTER_KEY is missing from infra/.env."
    }

    $masterKey = ($keyLine -split '=', 2)[1].Trim().Trim('"').Trim("'")
    if ([System.Text.Encoding]::UTF8.GetByteCount($masterKey) -lt 16) {
        throw "MEILI_MASTER_KEY must contain at least 16 UTF-8 bytes."
    }

    return $masterKey
}

function Get-HttpStatusCode {
    param([Parameter(Mandatory = $true)]$ErrorRecord)

    if ($ErrorRecord.Exception.Response -and $ErrorRecord.Exception.Response.StatusCode) {
        return [int]$ErrorRecord.Exception.Response.StatusCode
    }
    return $null
}

function Invoke-MeiliRequest {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("GET", "POST", "PATCH", "DELETE")][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [object]$Body,
        [switch]$AllowNotFound
    )

    $request = @{
        Method      = $Method
        Uri         = "$BaseUrl$Path"
        Headers     = @{ Authorization = "Bearer $script:MasterKey" }
        ErrorAction = "Stop"
    }

    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 12 -Compress
        $request.ContentType = "application/json; charset=utf-8"
        $request.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
    }

    try {
        return Invoke-RestMethod @request
    }
    catch {
        if ($AllowNotFound -and (Get-HttpStatusCode -ErrorRecord $_) -eq 404) {
            return $null
        }
        throw
    }
}

function Wait-MeiliTask {
    param(
        [Parameter(Mandatory = $true)][long]$TaskUid,
        [int]$TimeoutSeconds = 90
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $task = Invoke-MeiliRequest -Method GET -Path "/tasks/$TaskUid"
        if ($task.status -eq "succeeded") {
            return $task
        }
        if ($task.status -eq "failed" -or $task.status -eq "canceled") {
            $message = if ($task.error.message) { $task.error.message } else { "Unknown task error" }
            throw "Meilisearch task $TaskUid ended with status '$($task.status)': $message"
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting for Meilisearch task $TaskUid."
}

function Wait-MeiliHealth {
    param([int]$TimeoutSeconds = 120)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $health = Invoke-RestMethod -Method GET -Uri "$BaseUrl/health" -TimeoutSec 5
            if ($health.status -eq "available") {
                return
            }
        }
        catch {
            Start-Sleep -Seconds 2
        }
    } while ((Get-Date) -lt $deadline)

    throw "Meilisearch did not become healthy within $TimeoutSeconds seconds."
}

function Ensure-Index {
    param(
        [Parameter(Mandatory = $true)][string]$Uid,
        [Parameter(Mandatory = $true)][string]$PrimaryKey,
        [Parameter(Mandatory = $true)][hashtable]$Settings
    )

    $existing = Invoke-MeiliRequest -Method GET -Path "/indexes/$Uid" -AllowNotFound
    if (-not $existing) {
        $created = Invoke-MeiliRequest -Method POST -Path "/indexes" -Body @{
            uid        = $Uid
            primaryKey = $PrimaryKey
        }
        Wait-MeiliTask -TaskUid $created.taskUid | Out-Null
        Write-Host "Created index: $Uid"
    }
    elseif ($existing.primaryKey -ne $PrimaryKey) {
        throw "Index '$Uid' exists with primary key '$($existing.primaryKey)', expected '$PrimaryKey'."
    }

    $updated = Invoke-MeiliRequest -Method PATCH -Path "/indexes/$Uid/settings" -Body $Settings
    Wait-MeiliTask -TaskUid $updated.taskUid | Out-Null
    Write-Host "Applied settings: $Uid"
}

function Invoke-ChineseSmokeTest {
    $uid = "deployment_smoke_$([Guid]::NewGuid().ToString('N'))"
    $created = $null
    try {
        $created = Invoke-MeiliRequest -Method POST -Path "/indexes" -Body @{
            uid        = $uid
            primaryKey = "id"
        }
        Wait-MeiliTask -TaskUid $created.taskUid | Out-Null

        $documents = @(
            @{
                id      = "smoke-1"
                title   = "跨学科申请规划案例"
                content = "学生通过长期规划完成研究与活动的衔接。"
            }
        )
        $added = Invoke-MeiliRequest -Method POST -Path "/indexes/$uid/documents" -Body $documents
        Wait-MeiliTask -TaskUid $added.taskUid | Out-Null

        $keywordResult = Invoke-MeiliRequest -Method POST -Path "/indexes/$uid/search" -Body @{ q = "申请规划" }
        $phraseResult = Invoke-MeiliRequest -Method POST -Path "/indexes/$uid/search" -Body @{ q = '"长期规划"' }
        if ($keywordResult.estimatedTotalHits -lt 1 -or $phraseResult.estimatedTotalHits -lt 1) {
            throw "Chinese keyword or exact-phrase smoke search returned no hits."
        }

        Write-Host "Chinese keyword and exact-phrase smoke search passed."
    }
    finally {
        $existing = Invoke-MeiliRequest -Method GET -Path "/indexes/$uid" -AllowNotFound
        if ($existing) {
            $deleted = Invoke-MeiliRequest -Method DELETE -Path "/indexes/$uid"
            Wait-MeiliTask -TaskUid $deleted.taskUid | Out-Null
        }
    }
}

$script:DockerExe = Resolve-DockerExe
$dockerBinDir = Split-Path -Parent $script:DockerExe
if (-not (($env:Path -split ';') | Where-Object {
    [string]::Equals($_.TrimEnd('\'), $dockerBinDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
})) {
    $env:Path = "$dockerBinDir;$env:Path"
}
$script:MasterKey = Ensure-LocalEnv

Invoke-Docker -Arguments @("version")
Invoke-Docker -Arguments @("compose", "version")
Invoke-Docker -Arguments @("compose", "--env-file", $EnvFile, "-f", $ComposeFile, "config", "--quiet")
if (-not $SkipPull) {
    Invoke-Docker -Arguments @("compose", "--env-file", $EnvFile, "-f", $ComposeFile, "pull")
}
Invoke-Docker -Arguments @("compose", "--env-file", $EnvFile, "-f", $ComposeFile, "up", "-d")

Wait-MeiliHealth
Write-Host "Meilisearch is healthy at $BaseUrl"

if (-not (Test-Path -LiteralPath $IndexDefinitionsFile -PathType Leaf)) {
    throw "Canonical index definitions were not found: $IndexDefinitionsFile"
}

$parsedIndexes = Get-Content -LiteralPath $IndexDefinitionsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$indexes = @($parsedIndexes | ForEach-Object { $_ })
$targetIndexUids = @($indexes | ForEach-Object { $_.uid })
if ($indexes.Count -ne 3 -or ($targetIndexUids | Select-Object -Unique).Count -ne 3) {
    throw "Canonical index definitions must contain exactly three unique indexes."
}

foreach ($index in $indexes) {
    $settings = @{
        searchableAttributes = @($index.searchableAttributes)
        filterableAttributes = @($index.filterableAttributes)
        sortableAttributes = @($index.sortableAttributes)
    }
    if ($null -ne $index.embedder) {
        $settings.embedders = @{
            $index.embedder.name = @{
                source = $index.embedder.source
                model = $index.embedder.model
                revision = $index.embedder.revision
                documentTemplate = $index.embedder.documentTemplate
            }
        }
    }
    Ensure-Index -Uid $index.uid -PrimaryKey $index.primaryKey -Settings $settings
}

if (-not $SkipSmokeTest) {
    Invoke-ChineseSmokeTest
}

$allIndexes = Invoke-MeiliRequest -Method GET -Path "/indexes?limit=100"
$targetIndexes = @($allIndexes.results | Where-Object { $_.uid -in $targetIndexUids })
if ($targetIndexes.Count -ne 3) {
    throw "Expected three target indexes, found $($targetIndexes.Count)."
}

Write-Host "Meilisearch setup complete. Target indexes: $($targetIndexUids -join ', ')."
