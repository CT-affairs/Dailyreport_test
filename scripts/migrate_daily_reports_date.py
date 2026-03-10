import os
import sys
from google.cloud import firestore
from datetime import datetime

# プロジェクトのルートディレクトリをPythonパスに追加
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

from app_core.config import COLLECTION_DAILY_REPORTS

# --- Firestoreクライアントの初期化 ---
try:
    db = firestore.Client()
    print("Firestoreクライアントの初期化に成功しました。")
except Exception as e:
    print(f"Firestoreクライアントの初期化に失敗しました: {e}")
    print("GCPの認証情報を確認してください。 (例: gcloud auth application-default login)")
    exit()

def migrate_date_to_timestamp():
    """
    'daily_reports'コレクションのすべてのドキュメントをスキャンし、
    'date'フィールドが文字列であればTimestamp型に変換して更新する。
    """
    collection_ref = db.collection(COLLECTION_DAILY_REPORTS)
    docs = collection_ref.stream()

    batch = db.batch()
    total_docs = 0
    updated_docs = 0

    print(f"\n'{COLLECTION_DAILY_REPORTS}'コレクションのデータ移行を開始します...")

    for doc in docs:
        total_docs += 1
        doc_data = doc.to_dict()
        date_field = doc_data.get('date')

        # 'date'フィールドが文字列型の場合のみ更新対象とする
        if isinstance(date_field, str):
            try:
                date_obj = datetime.strptime(date_field, '%Y-%m-%d')
                batch.update(doc.reference, {'date': date_obj})
                updated_docs += 1
                print(f"  - 更新対象: {doc.id} (文字列 '{date_field}' -> Timestamp)")

                # バッチは500件ごとにコミットする (Firestoreのバッチ上限)
                if updated_docs > 0 and updated_docs % 499 == 0:
                    print(f"  - {updated_docs}件のドキュメントをバッチ更新中...")
                    batch.commit()
                    batch = db.batch() # 新しいバッチを開始
            except ValueError:
                print(f"  - 警告: スキップされました。日付形式が不正です: {doc.id}, date: {date_field}")

    # ループ終了後に残りのバッチをコミット
    if updated_docs % 499 != 0 or updated_docs == 0 and total_docs > 0 and updated_docs % 499 == 0 :
         batch.commit()

    print("\n--- データ移行完了 ---")
    print(f"総ドキュメント数: {total_docs}件")
    print(f"更新されたドキュメント数: {updated_docs}件")
    print("--------------------")

if __name__ == '__main__':
    confirm = input(f"本当に'{COLLECTION_DAILY_REPORTS}'コレクションの全ドキュメントの'date'フィールドをTimestamp型に移行しますか？ (yes/no): ")
    if confirm.lower() == 'yes':
        migrate_date_to_timestamp()
    else:
        print("処理をキャンセルしました。")