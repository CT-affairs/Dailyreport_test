import os
import sys
from google.cloud import firestore

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# --- ローカル環境のみ .env 読み込み ---
dotenv_path = os.path.join(project_root, ".env")
if os.path.exists(dotenv_path):
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=dotenv_path)

# --- Firestoreクライアントの初期化 ---
try:
    db = firestore.Client()
    print("Firestoreクライアントの初期化に成功しました。")
except Exception as e:
    print(f"エラー: Firestoreクライアントの初期化に失敗しました: {e}")
    sys.exit(1)

def init_notify_time_field():
    """
    usersコレクションのすべてのドキュメントをスキャンし、
    'notify_time' フィールドが存在しない場合に空文字で初期化します。
    既に値が設定されているドキュメントはスキップします。
    """
    try:
        users_ref = db.collection("users")
        docs = users_ref.stream()

        batch = db.batch()
        batch_count = 0
        updated_count = 0
        total_docs = 0

        print("usersコレクションのドキュメントをスキャンしています...")

        for doc in docs:
            total_docs += 1
            doc_data = doc.to_dict()

            # 'notify_time' フィールドが存在しない場合のみ更新対象に追加
            if 'notify_time' not in doc_data:
                batch.update(doc.reference, {'notify_time': ''})
                batch_count += 1
                updated_count += 1

            # Firestoreのバッチ書き込み制限（500件）を考慮してコミット
            if batch_count >= 400:
                batch.commit()
                print(f"  ... {updated_count} 件更新済み")
                batch = db.batch()
                batch_count = 0

        # 残りのバッチをコミット
        if batch_count > 0:
            batch.commit()

        print(f"完了: 合計 {updated_count} / {total_docs} 件のドキュメントを更新しました。")

    except Exception as e:
        print(f"エラーが発生しました: {e}")

if __name__ == "__main__":
    init_notify_time_field()