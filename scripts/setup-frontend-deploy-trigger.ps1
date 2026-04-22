#Requires -Version 5.1
# Creates a Cloud Build GitHub trigger: push to main -> cloudbuild-frontend.yaml (FTP upload).
# Uses "gcloud beta builds triggers import" because "gcloud builds triggers create github"
# often returns INVALID_ARGUMENT on this project/API version.
#
# Prereqs:
#   gcloud auth login
#   gcloud config set project <PROJECT_ID>
#
# Set these env vars before running (do not commit secrets):
#   $env:CT_FRONTEND_FTP_HOST = "ftp.example.com"
#   $env:CT_FRONTEND_FTP_USER = "user"
#   $env:CT_FRONTEND_FTP_PASS = "pass"
#
# Note: If CT_FRONTEND_FTP_PASS contains a single quote ('), YAML escaping may break; avoid that character in the password
#       or edit scripts/cloudbuild-trigger-frontend.yaml and import manually.
#
# Optional: disable the long pack-build trigger (not FTP), e.g.:
#   gcloud builds triggers update 99ff55ba-cf98-4e59-8bc2-372ed6789e35 --disabled --project=dailyreport-480700

param(
    [string] $ProjectId = "dailyreport-480700",
    [string] $TriggerName = "dailyreport-frontend-ftp-deploy",
    [string] $RepoOwner = "CT-affairs",
    [string] $RepoName = "Dailyreport_test",
    # Must use single quotes at call site: in double quotes, $ would be interpreted by PowerShell.
    [string] $BranchPattern = '^main$',
    [string] $ServiceAccountEmail = "1088643883290-compute@developer.gserviceaccount.com",
    [switch] $WithIncludedFiles
)

$ErrorActionPreference = "Stop"

function Escape-YamlSingleQuoted {
    param([string] $Value)
    if ($null -eq $Value) { return "" }
    return $Value.Replace("'", "''")
}

function Require-Env {
    param([string] $Name)
    $v = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $v) {
        throw ("Missing environment variable: " + $Name)
    }
    return $v
}

$ftpHost = Require-Env -Name "CT_FRONTEND_FTP_HOST"
$ftpUser = Require-Env -Name "CT_FRONTEND_FTP_USER"
$ftpPass = Require-Env -Name "CT_FRONTEND_FTP_PASS"

$names = @(gcloud builds triggers list --project $ProjectId --format "value(name)" 2>$null)
if ($names -contains $TriggerName) {
    Write-Host ("Trigger already exists: " + $TriggerName)
    Write-Host ("Delete first: gcloud builds triggers delete " + $TriggerName + " --project=" + $ProjectId)
    exit 0
}

$hHost = Escape-YamlSingleQuoted $ftpHost
$hUser = Escape-YamlSingleQuoted $ftpUser
$hPass = Escape-YamlSingleQuoted $ftpPass

$yaml = New-Object System.Text.StringBuilder
[void]$yaml.AppendLine("name: " + $TriggerName)
[void]$yaml.AppendLine("filename: cloudbuild-frontend.yaml")
[void]$yaml.AppendLine("substitutions:")
[void]$yaml.AppendLine("  _FTP_HOST: '" + $hHost + "'")
[void]$yaml.AppendLine("  _FTP_USER: '" + $hUser + "'")
[void]$yaml.AppendLine("  _FTP_PASS: '" + $hPass + "'")
[void]$yaml.AppendLine("github:")
[void]$yaml.AppendLine("  name: " + $RepoName)
[void]$yaml.AppendLine("  owner: " + $RepoOwner)
[void]$yaml.AppendLine("  push:")
[void]$yaml.AppendLine("    branch: " + $BranchPattern)
if ($WithIncludedFiles) {
    [void]$yaml.AppendLine("includedFiles:")
    @(
        "admin.html",
        "admin_net.html",
        "index.html",
        "liff-app.js",
        "css/admin.css",
        "js/**",
        "deploy_frontend.txt",
        "_*.html"
    ) | ForEach-Object { [void]$yaml.AppendLine("  - " + $_) }
}
[void]$yaml.AppendLine("serviceAccount: projects/" + $ProjectId + "/serviceAccounts/" + $ServiceAccountEmail)

$tempPath = Join-Path $env:TEMP ("cloudbuild-trigger-" + [Guid]::NewGuid().ToString("N") + ".yaml")
try {
    [System.IO.File]::WriteAllText($tempPath, $yaml.ToString(), [System.Text.UTF8Encoding]::new($false))
    Write-Host ("Importing trigger: " + $TriggerName + " in project " + $ProjectId)
    & gcloud beta builds triggers import --source $tempPath --project $ProjectId --quiet
    if ($LASTEXITCODE -ne 0) {
        throw ("gcloud failed with exit code " + $LASTEXITCODE)
    }
}
finally {
    if (Test-Path $tempPath) {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ("Done. Verify: gcloud builds triggers describe " + $TriggerName + " --project=" + $ProjectId)
