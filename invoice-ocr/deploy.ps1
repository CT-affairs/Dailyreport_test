# invoice-ocr を Cloud Run へデプロイ（このフォルダをルートに実行）
# 既定: Dockerfile からビルドしてデプロイ（gcloud 1 回）
# 従来どおり gcr.io に build submit してから deploy する場合: .\deploy.ps1 -UseContainerRegistry

param(
    [string]$Project = 'dailyreport-480700',
    [string]$Region = 'asia-northeast1',
    [string]$Service = 'invoice-ocr',
    [switch]$UseContainerRegistry
)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if ($UseContainerRegistry) {
        $image = "gcr.io/$Project/${Service}:latest"
        gcloud builds submit --project $Project --tag $image . --verbosity=info
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        gcloud run deploy $Service --project $Project --image $image --region $Region --verbosity=info
    }
    else {
        # 既定の出力は少なく、ソースアップロード＋Cloud Build で数分かかることがある。--verbosity=info で進捗が見える。
        gcloud run deploy $Service --project $Project --region $Region --source . --verbosity=info
    }
}
finally {
    Pop-Location
}
