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
from typing import List, Dict
import time

# 共通サービスをインポート
from services.jobcan_service import JobcanService
from app_core.config import PROJECT_ID, COLLECTION_CONFIRMED_SHIFTS

db = firestore.Client(project=PROJECT_ID)

def main():
    """メイン処理"""
    db = None
    try:
        db = firestore.Client(project=PROJECT_ID, database="(default)")

        # 【保留】このスクリプトは確定シフトAPI(/shift/v1/shifts/{employee_id})をテストするものだが、
        # 期待したデータ(8:00-17:00のシフト)が得られていない。
        # このAPIが目的のデータを取得するために適切かどうか不明なため、一旦検証を保留する。
        # return # 必要に応じて、スクリプトが実行されないようにこの行のコメントを外してください。

        # Jobcan 認証情報
        client_id = os.environ.get("JOBCAN_CLIENT_ID_SANDBOX")
        client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_SANDBOX")

        # Jobcan サービス
        jobcan_service = JobcanService(client_id, client_secret, db=db)

        # テスト用パラメータ
        employee_id = "16"  # テスト用従業員ID
        target_date = "2026-01-13"  # テスト用日付

        print(f"従業員ID: {employee_id}, 日付: {target_date} の確定シフトを取得します...")

        # API 呼び出し
        response_data = jobcan_service.get_confirmed_shifts(
            employee_id=employee_id,
            dates=[target_date], # メソッドの仕様変更に合わせてリストで渡す
            save_raw=True
        )

        shifts = response_data.get("shifts", []) if response_data else []
        print("\n取得結果:", shifts)

        # --- 取得したシフト情報から主要な情報を抽出して表示 ---
        if shifts:
            print("\n--- シフト詳細 ---")
            for daily_shift in shifts:
                shift_date = daily_shift.get("date")
                # 入れ子になった shifts リストから時間情報を取得
                time_blocks = daily_shift.get("shifts", [])
                if time_blocks:
                    # 最初の時間ブロックの開始・終了時刻を表示
                    first_block = time_blocks[0]
                    start_time = first_block.get("start")
                    end_time = first_block.get("end")
                    print(f"日付: {shift_date}, 勤務時間: {start_time} - {end_time}")
                else:
                    print(f"日付: {shift_date}, 勤務時間: データなし")

        # Firestoreに保存
        if shifts:
            doc_id = f"{employee_id}_{target_date}"
            db.collection(COLLECTION_CONFIRMED_SHIFTS).document(doc_id).set({
                "staff_id": employee_id,
                "date": target_date,
                "shifts_data": shifts, # キー名を変更して、生データであることを明確化
                "fetched_at": datetime.now(timezone.utc),
                "source": "jobcan"
            })
            print(f"\nFirestore に保存しました: {doc_id}")
        else:
            print("\n取得できる確定シフトはありませんでした。")
    finally:
        # gRPCのバックグラウンドスレッドがシャットダウンするのを待つ
        time.sleep(1)

if __name__ == "__main__":
    main()