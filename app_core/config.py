"""
プロジェクト全体で使用する設定値を管理するモジュール
"""

# --- Firestore Collections ---
COLLECTION_ATTENDANCE_SNAPSHOTS = "attendance_snapshots"
COLLECTION_JOBCAN_RAW_RESPONSES = "jobcan_raw_responses"
COLLECTION_DAILY_REPORTS = "daily_reports" # 工数報告とJobcan実績サマリーを格納
COLLECTION_SHIFT_REQUESTS = "shift_requests"
COLLECTION_ADITS_SUMMARY = "adits_summary"
COLLECTION_CONFIRMED_SHIFTS = "confirmed_shifts"
COLLECTION_ATTENDANCE_REPORTS = "attendance_reports"

# --- Project ID ---
PROJECT_ID = "dailyreport-480700"

# --- Target Employees ---
TARGET_EMPLOYEE_IDS = ["16"] # 取得対象の従業員IDリスト。例: ["16", "17", "18"]