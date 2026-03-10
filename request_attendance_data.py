import os
from google.cloud import firestore
import sys

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
project_root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, project_root)

from datetime import datetime, timezone

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

import time
from services.jobcan_service import JobcanService
from app_core.config import PROJECT_ID, COLLECTION_ATTENDANCE_REPORTS

db = firestore.Client(project=PROJECT_ID)

def main():
    """メイン処理"""
    db = None
    try:
        db = firestore.Client(project=PROJECT_ID)

        # 【保留】このスクリプトは勤務データ作成リクエストAPI(/attendance/v1/reporting)をテストするものです。
        # このAPIは非同期のファイル作成処理であり、日々の勤務時間を手軽に取得する目的には不向きと判断しました。
        # より軽量なAPI（勤務サマリーや打刻情報）の検証を優先するため、一旦検証を保留します。
        # return # 必要に応じて、スクリプトが実行されないようにこの行のコメントを外してください。

        # Jobcan 認証情報
        client_id = os.environ.get("JOBCAN_CLIENT_ID_SANDBOX")
        client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_SANDBOX")

        # Jobcan サービス
        jobcan_service = JobcanService(client_id, client_secret, db=db)

        # --- テスト用パラメータ ---
        # TODO: Jobcan管理画面で確認した正しいフォーマットIDを設定してください
        format_id = 1  # 例: 1
        period_type = "day"
        period_value = "2026-01-13"
        staff_codes = ["16"]

        print(f"勤務データ作成をリクエストします...")
        print(f"  - フォーマットID: {format_id}")
        print(f"  - 期間タイプ: {period_type}")
        print(f"  - 期間値: {period_value}")
        print(f"  - スタッフコード: {staff_codes}")

        # API 呼び出し
        response_data = jobcan_service.request_attendance_data_download(
            format_id=format_id,
            period_type=period_type,
            period_value=period_value,
            staff_codes=staff_codes,
            output_format="json"
        )

        print("\nAPIからの応答:", response_data)

        # APIからの応答をFirestoreに保存
        if response_data is not None:
            doc_id = f"{period_value}_{staff_codes[0]}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
            db.collection(COLLECTION_ATTENDANCE_REPORTS).document(doc_id).set({
                "request_params": {"format_id": format_id, "period_type": period_type, "period_value": period_value, "staff_codes": staff_codes},
                "response": response_data,
                "created_at": datetime.now(timezone.utc)
            })
            print(f"\nFirestore にAPIの応答を保存しました: {doc_id}")
    finally:
        # gRPCのバックグラウンドスレッドがシャットダウンするのを待つ
        time.sleep(1)

if __name__ == "__main__":
    main()