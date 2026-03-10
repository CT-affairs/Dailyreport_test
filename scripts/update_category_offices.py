import os
import sys
from google.cloud import firestore

# プロジェクトルートをパスに追加（必要に応じて調整してください）
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# --- ローカル環境のみ .env 読み込み ---
dotenv_path = os.path.join(project_root, ".env")
if os.path.exists(dotenv_path):
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=dotenv_path)

def update_all_engineering_categories():
    """
    category_bコレクションの 'e_' で始まる（kind='engineering'）全ドキュメントに対し、
    officesフィールドに全拠点を追加する。
    """
    # Firestoreクライアントの初期化
    # 環境変数 GOOGLE_APPLICATION_CREDENTIALS が設定されているか、
    # gcloud auth application-default login で認証済みであることを前提とします。
    db = firestore.Client()
    collection_ref = db.collection("category_b")
    
    # 設定する全拠点のリスト
    all_offices = ['本社現場', '本社加工', '四日市', '花巻', '千歳']
    
    # 'e_' で始まるドキュメントは kind='engineering' であるため、kindでクエリします
    print("ドキュメントを取得中...")
    docs = collection_ref.where("kind", "==", "engineering").stream()
    
    batch = db.batch()
    count = 0
    updated_count = 0
    
    print(f"以下の拠点情報を設定します: {all_offices}")
    print("更新を開始します...")
    
    for doc in docs:
        # 念のためIDが 'e_' で始まるか確認
        if not doc.id.startswith("e_"):
            continue
            
        doc_ref = doc.reference
        # officesフィールドを更新
        batch.update(doc_ref, {"offices": all_offices})
        count += 1
        updated_count += 1
        
        # Firestoreのバッチ書き込み制限（最大500件）に対応
        if count >= 400:
            batch.commit()
            batch = db.batch()
            count = 0
            print(f"{updated_count}件 処理中...")
            
    if count > 0:
        batch.commit()
        
    print(f"完了しました。合計 {updated_count} 件のドキュメントを更新しました。")

if __name__ == "__main__":
    # 直接実行された場合のみ処理を行う
    update_all_engineering_categories()