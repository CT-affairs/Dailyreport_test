import os
import csv
from google.cloud import firestore

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

def upload_mappings_from_csv(csv_file_path: str):
    """
    CSVファイルから社員IDとJobcanIDの紐付け情報を読み込み、
    Firestoreの 'employee_mappings' コレクションに登録する。
    """
    try:
        db = firestore.Client()
        collection_ref = db.collection("employee_mappings")

        with open(csv_file_path, mode='r', encoding='utf-8-sig') as csvfile:
            reader = csv.DictReader(csvfile)
            
            # CSVヘッダーの存在チェック
            if "company_id" not in reader.fieldnames or "jobcan_id" not in reader.fieldnames:
                print("エラー: CSVファイルには 'company_id' と 'jobcan_id' のヘッダーが必要です。")
                return

            print(f"'{csv_file_path}' からデータを読み込み、Firestoreへの登録を開始します...")
            
            count = 0
            for row in reader:
                company_id = row.get("company_id")
                jobcan_id = row.get("jobcan_id")
                name = row.get("name") # name列も取得
                is_manager_str = row.get("manager", "").strip().lower() # manager列を取得し、小文字に変換

                if not company_id or not jobcan_id:
                    print(f"警告: スキップされた行があります (company_idまたはjobcan_idが空です): {row}")
                    continue

                # 保存するデータを作成
                data_to_set = {
                    "jobcan_employee_id": jobcan_id.strip(),
                    "is_manager": is_manager_str == "true" # "true"という文字列ならTrue、それ以外はFalse
                }
                # name列が存在し、空でなければデータに追加
                if name and name.strip():
                    data_to_set["name"] = name.strip()

                doc_ref = collection_ref.document(company_id.strip())
                doc_ref.set(data_to_set)
                count += 1
                manager_status = "管理者" if data_to_set["is_manager"] else "一般"
                print(f"  - 登録完了: {company_id.strip()} -> jobcan_id: {jobcan_id.strip()}, name: {name.strip() if name else 'N/A'}, role: {manager_status}")

            print(f"\n処理が完了しました。{count}件のデータを登録/更新しました。")

    except FileNotFoundError:
        print(f"エラー: CSVファイルが見つかりません: {csv_file_path}")
    except Exception as e:
        print(f"予期せぬエラーが発生しました: {e}")

if __name__ == "__main__":
    # プロジェクトのルートディレクトリにある 'mappings.csv' を指定
    upload_mappings_from_csv("mappings.csv")