import firebase_admin
from firebase_admin import credentials, firestore
import os

# --- 設定 ---
# サービスアカウントキーのパスを、このスクリプトファイルからの相対パスで指定します。
SERVICE_ACCOUNT_KEY_PATH = '../json/dailyreport-local.json'
# --- 設定ここまで ---

# スクリプトの場所を基準にキーファイルの絶対パスを構築
script_dir = os.path.dirname(__file__)
key_path = os.path.join(script_dir, SERVICE_ACCOUNT_KEY_PATH)

# Firebase Admin SDKを初期化
try:
    cred = credentials.Certificate(key_path)
    firebase_admin.initialize_app(cred)
except Exception as e:
    print(f"❌ Firebase Admin SDKの初期化に失敗しました: {e}")
    print(f"キーファイル '{key_path}' が正しい場所にあるか確認してください。")
    exit()

db = firestore.client()

def add_kind_to_category_a():
    """
    category_a コレクションの全ドキュメントに kind: 'engineering' を追加する関数
    """
    print("Updating documents in 'category_a' collection...")

    try:
        collection_ref = db.collection('category_a')
        docs = list(collection_ref.stream())

        if not docs:
            print("No documents found in 'category_a' collection. Nothing to do.")
            return

        print(f"Found {len(docs)} documents. Preparing to update...")

        # Firestoreのバッチ書き込みは一度に500件まで
        batch = db.batch()
        for i, doc in enumerate(docs):
            doc_ref = collection_ref.document(doc.id)
            batch.update(doc_ref, {'kind': 'engineering'})
            
            # 500件ごとにコミット
            if (i + 1) % 500 == 0:
                batch.commit()
                batch = db.batch() # 新しいバッチを開始

        batch.commit() # 残りのバッチをコミット
        print(f"✅ Successfully updated {len(docs)} documents.")

    except Exception as e:
        print(f"❌ Error updating documents: {e}")

if __name__ == "__main__":
    add_kind_to_category_a()