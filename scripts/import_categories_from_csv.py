import os
import sys
import csv
import argparse
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

def import_categories(csv_file_path: str):
    """
    指定されたCSVファイルからcategory_bのデータを読み込み、Firestoreに登録する。
    """
    collection_ref = db.collection("category_b")
    
    try:
        with open(csv_file_path, mode='r', encoding='cp932') as csvfile:
            reader = csv.reader(csvfile)
            
            batch = db.batch()
            order_counter = 100
            doc_count = 0
            
            print(f"'{csv_file_path}' からデータを読み込み、登録を開始します...")

            for i, row in enumerate(reader):
                # 空白行はスキップ
                if not any(row):
                    continue

                if len(row) < 3:
                    print(f"警告: {i+1}行目のデータが3列未満です。スキップします: {row}")
                    continue

                label = row[0].strip()
                client = row[1].strip()
                project = row[2].strip()

                if not label:
                    print(f"警告: {i+1}行目のA列(label)が空です。スキップします。")
                    continue

                doc_id = f"e_{label}"
                doc_ref = collection_ref.document(doc_id)

                data_to_set = {
                    "active": True,
                    "client": client,
                    "kind": "engineering",
                    "label": label,
                    "order": order_counter,
                    "project": project
                }

                batch.set(doc_ref, data_to_set)
                order_counter += 1
                doc_count += 1

                # Firestoreのバッチ書き込み制限（500件）を考慮してコミット
                if doc_count % 400 == 0:
                    batch.commit()
                    print(f"  ... {doc_count} 件処理済み")
                    batch = db.batch()

            # 残りのバッチをコミット
            if doc_count % 400 != 0:
                batch.commit()

            print(f"\n処理が完了しました。合計 {doc_count} 件のドキュメントを登録/更新しました。")

    except FileNotFoundError:
        print(f"エラー: CSVファイルが見つかりません: {csv_file_path}")
    except Exception as e:
        print(f"予期せぬエラーが発生しました: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CSVからFirestoreのcategory_bにデータをインポートします。")
    parser.add_argument("csv_file", help="インポートするCSVファイルのパス (例: csv/my_categories.csv)")
    args = parser.parse_args()
    
    import_categories(args.csv_file)