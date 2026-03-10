import os
from google.cloud import firestore
import sys

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
project_root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, project_root)

from datetime import datetime, timezone, timedelta
import argparse

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

# 共通サービスをインポート
from services.jobcan_service import JobcanService, save_jobcan_raw_response
from app_core.config import PROJECT_ID, COLLECTION_ADITS_SUMMARY, TARGET_EMPLOYEE_IDS

# --- デフォルト値 ---
YESTERDAY = (datetime.now(timezone.utc) + timedelta(hours=9) - timedelta(days=1)).strftime('%Y-%m-%d')
DEFAULT_EMPLOYEE_ID = TARGET_EMPLOYEE_IDS[0] if TARGET_EMPLOYEE_IDS else "16"
DEFAULT_DATE = YESTERDAY

def fetch_adits(jobcan_service, employee_id, date):
    """Jobcan APIから打刻情報を取得する"""
    print(f"従業員ID: {employee_id}, 日付: {date} の打刻情報を取得します...")
    response_data = jobcan_service.get_adits(
        employee_id=employee_id,
        date=date,
        save_raw=True
    )
    if not response_data or not response_data.get("adits"):
        print("\n取得できる打刻情報はありませんでした。")
        return None
    
    adits_list = response_data.get("adits", [])
    print("\n取得結果:", adits_list)
    return adits_list

def calculate_and_print_duration(adits_list):
    """打刻情報から拘束時間を計算して表示する（検証用）"""
    if not adits_list or len(adits_list) < 2:
        print("\n【検証】拘束時間を計算するには打刻が2回以上必要です。")
        return

    try:
        # recorded_at が存在する打刻のみをフィルタリング
        valid_adits = [adit for adit in adits_list if "recorded_at" in adit]
        if len(valid_adits) < 2:
            print("\n【検証】有効な打刻時刻が2つ未満のため、拘束時間を計算できません。")
            return

        # 時刻でソートして最初と最後を取得
        sorted_adits = sorted(valid_adits, key=lambda x: x["recorded_at"])
        start_time = datetime.fromisoformat(sorted_adits[0]["recorded_at"])
        end_time = datetime.fromisoformat(sorted_adits[-1]["recorded_at"])

        duration = end_time - start_time
        duration_minutes = int(duration.total_seconds() / 60)
        print(f"\n【検証】最初の打刻から最後の打刻までの時間: {duration_minutes} 分")
    except (ValueError, TypeError, KeyError) as e:
        print(f"\n【検証】拘束時間の計算に失敗しました: {e}")

def save_adits_to_firestore(db, employee_id, date, adits_list):
    """打刻情報をFirestoreに保存する"""
    if not adits_list:
        return

    doc_id = f"{employee_id}_{date}"
    db.collection(COLLECTION_ADITS_SUMMARY).document(doc_id).set({
        "staff_id": employee_id,
        "date": date,
        "adits": adits_list,
        "fetched_at": datetime.now(timezone.utc),
        "source": "jobcan"
    })
    print(f"\nFirestore に保存しました: {doc_id}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Jobcanから指定した従業員の打刻情報を取得します。")
    parser.add_argument("--employee_id", type=str, default=DEFAULT_EMPLOYEE_ID, help=f"取得対象の従業員ID (デフォルト: {DEFAULT_EMPLOYEE_ID})")
    parser.add_argument("--date", type=str, default=DEFAULT_DATE, help=f"取得対象の日付 (YYYY-MM-DD形式)。 (デフォルト: 昨日)")
    args = parser.parse_args()

    db = None
    try:
        db = firestore.Client(project=PROJECT_ID)

        # Jobcan 認証情報
        client_id = os.environ.get("JOBCAN_CLIENT_ID_SANDBOX")
        client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_SANDBOX")
        if not client_id or not client_secret:
            raise ValueError("環境変数 'JOBCAN_CLIENT_ID_SANDBOX' または 'JOBCAN_CLIENT_SECRET_SANDBOX' が設定されていません。")

        # Jobcan サービス
        jobcan_service = JobcanService(client_id, client_secret, db=db)

        # 1. データの取得
        adits_list = fetch_adits(jobcan_service, args.employee_id, args.date)

        if adits_list:
            # 2. データの処理（検証用）
            calculate_and_print_duration(adits_list)
            # 3. データの保存
            save_adits_to_firestore(db, args.employee_id, args.date, adits_list)

    except Exception as e:
        print(f"エラーが発生しました: {e}")
    finally:
        # Firestoreクライアントは明示的に閉じる必要はありません。
        # Cloud Runジョブなどの短命な環境では、プロセス終了時に自動的にクリーンアップされます。
        print("\n処理を終了します。")