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

import requests
from typing import List, Dict, Any
import time

# 共通サービスをインポート
from services.jobcan_service import JobcanService, save_jobcan_raw_response
from app_core.config import PROJECT_ID, COLLECTION_SHIFT_REQUESTS

def main():
    """メイン処理"""
    db = None
    try:
        db = firestore.Client(project=PROJECT_ID, database="(default)")

        # Jobcan 認証情報
        client_id = os.environ.get("JOBCAN_CLIENT_ID_SANDBOX")
        client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_SANDBOX")

        # Jobcan サービス
        jobcan_service = JobcanService(client_id, client_secret, db=db)

        # テスト用パラメータ
        employee_id = "16"  # テスト用従業員ID
        target_date = "2026-01-12"  # 過去の日付で検証

        print(f"従業員ID: {employee_id}, 日付: {target_date} のシフト申請情報を取得します...")

        # API 呼び出し
        response_data = jobcan_service.get_shift_requests(
            employee_id=employee_id,
            dates=[target_date],
            save_raw=True
        )

        # --- デバッグ用：APIからの生の応答をコンソールに出力 ---
        print("\n--- API Response ---")
        print(response_data)
        print("--------------------")

        # APIレスポンスの 'requests' キーからリストを取得する
        shift_requests = response_data.get("requests", []) if isinstance(response_data, dict) else []

        print("\n取得結果:", shift_requests)

        # Firestoreに保存
        if shift_requests:
            doc_id = f"{employee_id}_{target_date}"
            db.collection(COLLECTION_SHIFT_REQUESTS).document(doc_id).set({ # こちらはテスト用の別コレクション
                "staff_id": employee_id,
                "date": target_date,
                "shift_requests": shift_requests,
                "fetched_at": datetime.now(timezone.utc),
                "source": "jobcan"
            })
            print(f"\nFirestore に保存しました: {doc_id}")
        else:
            print("\n取得できるシフト申請情報はありませんでした。")
    finally:
        # gRPCのバックグラウンドスレッドがシャットダウンするのを待つ
        time.sleep(1)

if __name__ == "__main__":
    main()