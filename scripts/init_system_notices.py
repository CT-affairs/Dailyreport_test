import os
import sys
from google.cloud import firestore
from datetime import datetime

# プロジェクトルートをパスに追加
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# .env 読み込み
dotenv_path = os.path.join(project_root, ".env")
if os.path.exists(dotenv_path):
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=dotenv_path)

def init_system_notices():
    try:
        db = firestore.Client()
        collection_ref = db.collection("system_notices")
        
        # 既存のデータを削除（初期化のため）
        docs = collection_ref.stream()
        for doc in docs:
            doc.reference.delete()
            
        print("既存のデータをクリアしました。")

        # 初期データ
        notices = [
            # 改修予定 (type: plan)
            {
                "type": "plan",
                "date": "2024-04-01", # ソート用日付
                "content": "工事番号追加機能",
                "created_at": datetime.now()
            },
            {
                "type": "plan",
                "date": "2024-04-05",
                "content": "工番別集計表のCSVダウンロード機能",
                "created_at": datetime.now()
            },
            {
                "type": "plan",
                "date": "2024-04-10",
                "content": "工事番号の事業所別カテゴライズ機能",
                "created_at": datetime.now()
            },
            # 改修履歴 (type: history)
            {
                "type": "history",
                "date": "2024-02-24",
                "content": "ダッシュボードUI更新、単価設定項目の追加",
                "created_at": datetime.now()
            },
            {
                "type": "history",
                "date": "2024-02-21",
                "content": "代理入力機能の追加",
                "created_at": datetime.now()
            },
            {
                "type": "history",
                "date": "2024-02-21",
                "content": "工番別集計機能のリリース",
                "created_at": datetime.now()
            }
        ]

        for notice in notices:
            collection_ref.add(notice)
            
        print(f"{len(notices)} 件のお知らせデータを登録しました。")

    except Exception as e:
        print(f"エラーが発生しました: {e}")

if __name__ == "__main__":
    init_system_notices()