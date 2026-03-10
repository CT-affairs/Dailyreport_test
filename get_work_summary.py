import os
from google.cloud import firestore
import sys

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
project_root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, project_root)

from google.cloud.firestore import Client as FirestoreClient
from datetime import datetime, timezone, timedelta

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

import requests
from requests.exceptions import RequestException
import argparse
import time
from typing import List, Dict, Any, Optional

# 共通サービスをインポート
from services.jobcan_service import JobcanService
from app_core.config import PROJECT_ID, COLLECTION_DAILY_REPORTS, COLLECTION_JOBCAN_RAW_RESPONSES

# --- デフォルト値 ---
# 昨日の日付を 'YYYY-MM-DD' 形式で取得
YESTERDAY = (datetime.now(timezone.utc) + timedelta(hours=9) - timedelta(days=1)).strftime('%Y-%m-%d')
DEFAULT_EMPLOYEE_ID = "16"
DEFAULT_DATES = [YESTERDAY]

def save_work_summary_to_firestore(db: FirestoreClient, employee_id: str, summary: Dict[str, Any]):
    """勤務サマリーをFirestoreに保存する"""
    date = summary.get("date")
    if not date:
        print(f"  - スキップ: サマリーに日付が含まれていません: {summary}")
        return

    doc_id = f"{employee_id}_{date}"
    try:
        # 最新状態を上書き保存
        db.collection(COLLECTION_DAILY_REPORTS).document(doc_id).set({
            "staff_id": employee_id,
            "date": date,
            "summary": summary, # APIからの全レスポンスを保存
            "fetched_at": datetime.now(timezone.utc),
            "source": "jobcan_summary_api"
        })
        print(f"  - {date}: {summary.get('work')}分 (Firestoreに保存: {doc_id})")
    except Exception as e:
        print(f"Error: Firestoreへの保存に失敗しました: {doc_id}, {e}")

def main():
    """メイン処理"""
    # --- コマンドライン引数の設定 ---
    parser = argparse.ArgumentParser(description="Jobcanから指定した従業員の勤務サマリーを取得します。")
    parser.add_argument("--employee_id", type=str, default=DEFAULT_EMPLOYEE_ID,
                        help=f"取得対象の従業員ID (デフォルト: {DEFAULT_EMPLOYEE_ID})")
    parser.add_argument("--dates", type=str, nargs='+', default=DEFAULT_DATES,
                        help=f"取得対象の日付 (YYYY-MM-DD形式)。複数指定可。 (デフォルト: 昨日)")
    args = parser.parse_args()

    # Jobcan 認証情報
    client_id = os.environ.get("JOBCAN_CLIENT_ID_SANDBOX")
    client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_SANDBOX")

    if not client_id or not client_secret:
        print("エラー: Jobcanの認証情報が環境変数に設定されていません。")
        return

    db = None  # finallyブロックで参照できるよう、外で初期化
    try:
        db = firestore.Client(project=PROJECT_ID)

        # Jobcan サービス
        jobcan_service = JobcanService(
            client_id=client_id,
            client_secret=client_secret,
            db=db,
            raw_responses_collection=COLLECTION_JOBCAN_RAW_RESPONSES
        )

        print(f"\n従業員ID: {args.employee_id}, 日付: {args.dates} の勤務サマリーを取得します...")

        try:
            # API 呼び出し
            response_data = jobcan_service.get_daily_summaries(
                employee_id=args.employee_id,
                dates=args.dates,
                save_raw=True
            )
        except RequestException as e:
            print(f"エラー: Jobcan APIの呼び出しに失敗しました: {e}")
            return

        if not response_data or not response_data.get("daily_summaries"):
            print("  - 取得できる勤務サマリーはありませんでした。")
            return

        summaries = response_data.get("daily_summaries", [])
        print(f"  - {len(summaries)}件のサマリーを取得しました。")

        # 取得結果をFirestoreに保存
        for summary in summaries:
            save_work_summary_to_firestore(db, args.employee_id, summary)
            
    finally:
        # gRPCのバックグラウンドスレッドがシャットダウンするのを待つ
        time.sleep(1)

if __name__ == "__main__":
    main()