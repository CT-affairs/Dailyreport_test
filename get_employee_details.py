import os
import sys
import argparse
import json

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
project_root = os.path.dirname(os.path.abspath(__file__))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

from services.jobcan_service import JobcanService
from app_core.config import PROJECT_ID

# --- デフォルト値 ---
DEFAULT_EMPLOYEE_CODE = "16" # Jobcan上の社員コード

def get_employee_details_from_jobcan(employee_code: str, sandbox: bool = True):
    """
    Jobcan APIから指定された社員コードの従業員詳細情報を取得する。

    Args:
        employee_code (str): 取得対象のJobcan社員コード。
        sandbox (bool): サンドボックス環境を使用するかどうか。

    Returns:
        dict: 取得した従業員情報の辞書。失敗した場合はNone。
    """
    print(f"環境: {'サンドボックス' if sandbox else '本番'}")
    print(f"社員コード: {employee_code} の詳細情報をJobcanから取得します...")

    try:
        # 環境に応じて認証情報を切り替え
        if sandbox:
            client_id = os.environ.get("JOBCAN_CLIENT_ID_SANDBOX")
            client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_SANDBOX")
        else:
            # 本番用の環境変数名を想定 (例: JOBCAN_CLIENT_ID_PRODUCTION)
            client_id = os.environ.get("JOBCAN_CLIENT_ID_PRODUCTION")
            client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_PRODUCTION")

        if not client_id or not client_secret:
            raise ValueError("Jobcanの認証情報が環境変数に設定されていません。")

        # JobcanServiceのインスタンスを作成し、環境フラグを渡す
        jobcan_service = JobcanService(
            client_id=client_id, client_secret=client_secret, sandbox=sandbox
        )
        employee_data = jobcan_service.get_employee_details(employee_code=employee_code)

        print("\n--- 取得成功 ---")
        # JSONを整形して表示
        print(json.dumps(employee_data, indent=2, ensure_ascii=False))

        return employee_data

    except Exception as e:
        print(f"\nエラー: 社員情報の取得に失敗しました: {e}")
        return None

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Jobcanから指定した従業員の詳細情報を取得します。")
    parser.add_argument("--code", type=str, default=DEFAULT_EMPLOYEE_CODE,
                        help=f"取得対象のJobcan社員コード (デフォルト: {DEFAULT_EMPLOYEE_CODE})")
    parser.add_argument("--prod", action="store_true",
                        help="本番環境のAPIに対して実行します。")
    args = parser.parse_args()

    get_employee_details_from_jobcan(employee_code=args.code, sandbox=not args.prod)