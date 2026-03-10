import os
import sys

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from dotenv import load_dotenv
from services.jobcan_service import JobcanService
from datetime import datetime, timedelta

# .envファイルを読み込む
dotenv_path = os.path.join(project_root, '.env')
load_dotenv(dotenv_path)

def test_selection_remarks():
    # テスト設定
    # テストしたい従業員のJobcan ID (管理画面等で確認してください)
    target_employee_id = "12" 
    
    # テスト期間 (直近の1ヶ月など)
    end_date = datetime.now()
    start_date = end_date - timedelta(days=30)
    
    from_str = start_date.strftime('%Y-%m-%d')
    to_str = end_date.strftime('%Y-%m-%d')

    print(f"Testing Jobcan Selection Remarks API")
    print(f"Employee ID: {target_employee_id}")
    print(f"Period: {from_str} to {to_str}")
    print("-" * 30)

    try:
        # サービス初期化 (sandbox=False で本番環境につなぐ場合は注意)
        # 本番環境固定
        print(f"Environment: Production")

        service = JobcanService(sandbox=False)
        
        # データ取得
        results = service.get_selection_notes(target_employee_id, from_str, to_str)
        
        print(f"Result count: {len(results)}")
        if results:
            print("Found remarks:")
            for date, note in results.items():
                print(f"  - {date}: {note}")
        else:
            print("No selection remarks found (ID=1 or Code=1) in this period.")
            print("Hint: データがあるはずなのに取得できない場合、指定したIDが「社員コード」ではなく「Jobcan内部ID」か確認してください。")

    except Exception as e:
        print(f"Error occurred: {e}")

if __name__ == "__main__":
    # 環境変数が設定されているか確認
    if not os.environ.get("JOBCAN_CLIENT_ID_PRODUCTION"):
        print("Error: Environment variables for Jobcan (Production) are not set.")
    else:
        test_selection_remarks()
