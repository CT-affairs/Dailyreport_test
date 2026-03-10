import os
import sys
from google.cloud import firestore

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
# このスクリプトは 'scripts' フォルダにあるため、親ディレクトリ（プロジェクトルート）をパスに追加
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# --- ローカル環境のみ .env 読み込み ---
dotenv_path = os.path.join(project_root, ".env")
if os.path.exists(dotenv_path):
    from dotenv import load_dotenv
    # .envファイルがあるディレクトリを基準にパスを解決するようにする
    load_dotenv(dotenv_path=dotenv_path)

# --- Firestoreクライアントの初期化 ---
try:
    db = firestore.Client()
    print("Firestoreクライアントの初期化に成功しました。")
except Exception as e:
    print(f"エラー: Firestoreクライアントの初期化に失敗しました: {e}")
    sys.exit(1)

def add_mail_field_to_all_mappings():
    """
    employee_mappingsコレクションのすべてのドキュメントに、
    空文字列の 'mail' フィールドを追加または上書きします。
    """
    try:
        mappings_ref = db.collection("employee_mappings")
        docs = mappings_ref.stream()

        batch = db.batch()
        count = 0
        updated_count = 0

        print("employee_mappingsコレクションのドキュメントを走査しています...")

        for doc in docs:
            count += 1
            doc_data = doc.to_dict()
            # 'mail' フィールドが存在しない、またはNoneの場合のみ更新する
            if 'mail' not in doc_data or doc_data.get('mail') is None:
                batch.update(doc.reference, {'mail': ''})
                updated_count += 1
                print(f"  - 更新対象に追加: {doc.id}")

            # Firestoreのバッチ書き込みは500件ごとの制限があるため、
            # 490件ごとにコミットする
            if updated_count > 0 and updated_count % 490 == 0:
                print(f"{updated_count}件のドキュメントを更新します...")
                batch.commit()
                batch = db.batch() # 新しいバッチを開始

        # ループ終了後に残りのバッチをコミット
        if updated_count > 0:
            print(f"残りの{updated_count % 490}件のドキュメントを更新します...")
            batch.commit()

        print("\n--- 処理完了 ---")
        print(f"総ドキュメント数: {count}件")
        print(f"更新されたドキュメント数: {updated_count}件")

    except Exception as e:
        print(f"\nエラー: 処理中にエラーが発生しました: {e}")

if __name__ == "__main__":
    # 実行前にユーザーに確認を求める
    confirm = input("employee_mappingsコレクションの全ドキュメントに空の'mail'フィールドを追加します。よろしいですか？ (y/n): ")
    if confirm.lower() == 'y':
        add_mail_field_to_all_mappings()
    else:
        print("処理をキャンセルしました。")
