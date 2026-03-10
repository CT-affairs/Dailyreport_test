import os
from google.cloud import firestore
from datetime import datetime, timezone
import json

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

import requests
from typing import List, Dict, Any
import time

# 共通サービスをインポート - このスクリプトは独立実行を想定しているため、
# 実行時にパスが通っていないとエラーになる可能性がある。
# from services.jobcan_service import JobcanService
from app_core.config import PROJECT_ID, COLLECTION_DAILY_REPORTS

def main():
    """メイン処理"""
    db = None
    try:
        db = firestore.Client(project=PROJECT_ID, database="(default)")

        # Jobcan 認証情報
        client_id = os.environ.get("JOBCAN_CLIENT_ID_SANDBOX")
        client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_SANDBOX")

        # Jobcan サービス
        # jobcan_service = JobcanService(client_id, client_secret, db=db)
        raise NotImplementedError("このスクリプトは現在使用されていません。JobcanServiceをインポートできません。")

        # テスト用パラメータ
        employee_id = "16"  # テスト用従業員ID
        target_date = "2026-01-09"  # テスト用日付

        print(f"従業員ID: {employee_id}, 日付: {target_date} の日次勤務サマリーを取得します...")

        # API 呼び出し
        # get_daily_summaries はリストを期待するため、日付をリストで渡す
        response_data = jobcan_service.get_daily_summaries(
            employee_id=employee_id,
            dates=[target_date]
        )

        if not response_data or not response_data.get("daily_summaries"):
            print("\n取得できる日次勤務サマリーはありませんでした。")
            return

        summaries = response_data.get("daily_summaries", [])
        print("\n取得結果:", summaries)

        # Firestoreに保存
        # レスポンスはリスト形式なので、ループで処理するのが安全
        if summaries:
            # 1日分しか取得していないが、念のためループで処理する
            for summary_data in summaries:
                # レスポンス内の日付を正として使用する
                date_from_response = summary_data.get("date")
                if not date_from_response:
                    continue

                doc_id = f"{employee_id}_{date_from_response}"

                # 最新状態を上書き保存
                db.collection(COLLECTION_DAILY_REPORTS).document(doc_id).set({
                    "staff_id": employee_id,
                    "date": date_from_response,
                    "summary": summary_data,
                    "fetched_at": datetime.now(timezone.utc),
                    "source": "jobcan"
                })
                print(f"\nFirestore に保存しました: {doc_id}")
        else:
            print("\n取得できる日次勤務サマリーはありませんでした。")
    finally:
        # gRPCのバックグラウンドスレッドがシャットダウンするのを待つ
        time.sleep(1)

if __name__ == "__main__":
    main()