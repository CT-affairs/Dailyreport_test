import os
import sys
from google.cloud import firestore

# プロジェクトのルートディレクトリをPythonパスに追加して、他のモジュールをインポートできるようにする
# このスクリプトでは直接は不要ですが、将来的な拡張のために含めておくと便利です。
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# --- Firestoreクライアントの初期化 ---
# このスクリプトを実行する環境で、GCPへの認証が済んでいる必要があります。
# (例: gcloud auth application-default login)
try:
    db = firestore.Client()
    print("Firestoreクライアントの初期化に成功しました。")
except Exception as e:
    print(f"Firestoreクライアントの初期化に失敗しました: {e}")
    print("GCPの認証情報を確認してください。 (例: gcloud auth application-default login)")
    exit()

def add_status_to_employee_mappings():
    """
    'employee_mappings'コレクションのすべてのドキュメントに
    'status: "active"' フィールドを追加する。
    フィールドが既に存在する場合はスキップします。
    """
    collection_ref = db.collection('employee_mappings')
    docs = collection_ref.stream()
    
    batch = db.batch()
    total_docs = 0
    updated_docs = 0
    
    print("\n'employee_mappings'コレクションの更新を開始します...")

    for doc in docs:
        total_docs += 1
        doc_data = doc.to_dict()
        
        # 既に'status'フィールドが存在しない場合のみ更新対象とする
        if 'status' not in doc_data:
            doc_ref = collection_ref.document(doc.id)
            batch.update(doc_ref, {'status': 'active'})
            updated_docs += 1
            
            # バッチは500件ごとにコミットする (Firestoreのバッチ上限)
            if updated_docs > 0 and updated_docs % 500 == 0:
                print(f"  - {updated_docs}件のドキュメントを更新中...")
                batch.commit()
                batch = db.batch() # 新しいバッチを開始
    
    # ループ終了後に残りのバッチをコミット
    if updated_docs % 500 != 0:
        batch.commit()

    print("\n--- 更新完了 ---")
    print(f"総ドキュメント数: {total_docs}件")
    print(f"更新されたドキュメント数: {updated_docs}件")
    print("----------------")

if __name__ == '__main__':
    # 誤操作を防ぐため、ユーザーに実行確認を求める
    confirm = input("本当に'employee_mappings'コレクションの全ドキュメントに'status: \"active\"'を追加しますか？ (yes/no): ")
    if confirm.lower() == 'yes':
        add_status_to_employee_mappings()
    else:
        print("処理をキャンセルしました。")

