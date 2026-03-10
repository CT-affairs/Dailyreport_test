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

def reorder_categories():
    """
    category_bコレクションのorderフィールドを再採番する。
    order < 10000 のドキュメントを対象とし、
    現在のorderが大きい順に 100, 101, 102... と振り直す。
    """
    collection_ref = db.collection("category_b")
    
    # order < 10000 のドキュメントを取得
    # Firestoreのクエリ制限により、不等号フィルタを使ったフィールドでソートする必要があるため
    # クエリでソートまで行うか、全件取得してメモリ内でソートするか検討。
    # ここでは対象件数がそれほど多くないと想定し、フィルタ後にメモリ内でソートする方式を採用。
    
    print("対象ドキュメントを取得中...")
    docs = list(collection_ref.where(filter=firestore.FieldFilter("order", "<", 10000)).stream())
    
    if not docs:
        print("対象となるドキュメント（order < 10000）が見つかりませんでした。")
        return

    # 現在のorderの降順（大きい順）にソート
    # orderフィールドがない場合は0として扱う（通常はないはずだが安全のため）
    sorted_docs = sorted(docs, key=lambda x: x.to_dict().get("order", 0), reverse=True)
    
    print(f"対象件数: {len(sorted_docs)} 件")
    print("再採番を開始します（開始番号: 100）...")

    batch = db.batch()
    new_order = 100
    count = 0

    for doc in sorted_docs:
        batch.update(doc.reference, {"order": new_order})
        new_order += 1
        count += 1

        if count % 400 == 0:
            batch.commit()
            print(f"  ... {count} 件更新済み")
            batch = db.batch()

    if count % 400 != 0:
        batch.commit()

    print(f"完了: 合計 {count} 件のドキュメントを再採番しました。")

if __name__ == "__main__":
    reorder_categories()