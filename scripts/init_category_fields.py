import os
import sys
from google.cloud import firestore

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

def initialize_category_fields():
    """
    category_bコレクションの全ドキュメントに対し、
    clientとprojectフィールドが存在しない場合に空文字で初期化するスクリプト
    """
    print("Firestoreクライアントを初期化中...")
    
    # ローカル実行時は GOOGLE_APPLICATION_CREDENTIALS 環境変数が必要
    try:
        db = firestore.Client()
    except Exception as e:
        print(f"エラー: Firestoreクライアントの初期化に失敗しました。\n{e}")
        print("ヒント: GOOGLE_APPLICATION_CREDENTIALS 環境変数が正しく設定されているか確認してください。")
        return

    collection_name = 'category_b'
    print(f"コレクション '{collection_name}' のドキュメントをスキャンしています...")
    
    # 全ドキュメントを取得
    docs = list(db.collection(collection_name).stream())
    total_docs = len(docs)
    print(f"対象ドキュメント総数: {total_docs}")

    batch = db.batch()
    batch_count = 0
    updated_count = 0

    for doc in docs:
        data = doc.to_dict()
        updates = {}

        # clientフィールドがない場合、空文字を設定
        # ※強制的にリセットしたい場合は if 文を外してください
        if 'client' not in data:
            updates['client'] = ''
        
        # projectフィールドがない場合、空文字を設定
        if 'project' not in data:
            updates['project'] = ''

        if updates:
            batch.update(doc.reference, updates)
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

if __name__ == "__main__":
    initialize_category_fields()