#Requires -Version 5.1
<#
.SYNOPSIS
  GitHub push (main) からフロント FTP 配信用の Cloud Build トリガーを作成する。

.DESCRIPTION
  - リポ: CT-affairs/Dailyreport_test
  - ビルド: リポジトリ直下の cloudbuild-frontend.yaml
  - FTP 認証は Cloud Build トリガーの置換変数で渡す（コミットしないこと）

  事前準備:
    1) gcloud auth login
    2) gcloud config set project <PROJECT_ID>
    3) 次の環境変数を設定してから本スクリプトを実行:
         $env:CT_FRONTEND_FTP_HOST = "ftp.example.com"
         $env:CT_FRONTEND_FTP_USER = "ユーザー"
         $env:CT_FRONTEND_FTP_PASS = "パスワード"

  任意:
    - 既存の長時間 pack ビルド用トリガー（rmgpgab-test-...）は無効化を推奨。
      gcloud builds triggers update 99ff55ba-cf98-4e59-8bc2-372ed6789e35 --disabled --project=$ProjectId
#>
param(
    [string] $ProjectId = "dailyreport-480700",
    [string] $TriggerName = "dailyreport-frontend-ftp-deploy",
    [string] $RepoOwner = "CT-affairs",
    [string] $RepoName = "Dailyreport_test",
    [string] $BranchPattern = "^main$"
)

$ErrorActionPreference = "Stop"

function Require-Env([string] $name) {
    $v = [Environment]::GetEnvironmentVariable($name, "Process")
    if (-not $v) { throw "環境変数 $name が未設定です。スクリプト先頭のコメントを参照してください。" }
    return $v
}

$hostFtp = Require-Env "CT_FRONTEND_FTP_HOST"
$userFtp = Require-Env "CT_FRONTEND_FTP_USER"
$passFtp = Require-Env "CT_FRONTEND_FTP_PASS"

# フロント関連の変更時のみ発火（deploy_frontend.txt と整合）
$included = @(
    "admin.html",
    "admin_net.html",
    "index.html",
    "liff-app.js",
    "css/admin.css",
    "js/**",
    "deploy_frontend.txt",
    "_*.html"
) -join ","

$names = @(gcloud builds triggers list --project $ProjectId --format "value(name)" 2>$null)
if ($names -contains $TriggerName) {
    Write-Host "トリガー '$TriggerName' は既に存在します。削除する場合:"
    Write-Host "  gcloud builds triggers delete $TriggerName --project=$ProjectId"
    exit 0
}

Write-Host "Creating trigger '$TriggerName' in project $ProjectId ..."

gcloud builds triggers create github `
    --name=$TriggerName `
    --project=$ProjectId `
    --repo-owner=$RepoOwner `
    --repo-name=$RepoName `
    --branch-pattern=$BranchPattern `
    --build-config=cloudbuild-frontend.yaml `
    --included-files=$included `
    --substitutions="_FTP_HOST=$hostFtp,_FTP_USER=$userFtp,_FTP_PASS=$passFtp"

Write-Host "Done. 確認: gcloud builds triggers describe $TriggerName --project=$ProjectId"
