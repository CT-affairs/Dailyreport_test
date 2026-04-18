"""
プロジェクト全体で使用する設定値を管理するモジュール
"""

import os

# --- Firestore Collections ---
COLLECTION_ATTENDANCE_SNAPSHOTS = "attendance_snapshots"
COLLECTION_JOBCAN_RAW_RESPONSES = "jobcan_raw_responses"
COLLECTION_DAILY_REPORTS = "daily_reports" # 工数報告とJobcan実績サマリーを格納
COLLECTION_SHIFT_REQUESTS = "shift_requests"
COLLECTION_ADITS_SUMMARY = "adits_summary"
COLLECTION_CONFIRMED_SHIFTS = "confirmed_shifts"
COLLECTION_ATTENDANCE_REPORTS = "attendance_reports"
COLLECTION_HOLIDAY_TYPES = "holiday_types"  # Jobcan 休暇タイプマスタ（管理画面の「最新情報を取得」で同期）

# --- 締め処理（本番コレクション名。集計の参照切替は常にこちらを見る） ---
MONTHLY_CLOSINGS_COLLECTION = "monthly_closings"
DAILY_REPORTS_SNAPSHOT_COLLECTION = "daily_reports_snapshot"

# --- 締め処理テストモード（MONTHLY_CLOSING_TEST_MODE が真のときの既定コレクション） ---
MONTHLY_CLOSINGS_TEST_COLLECTION = "monthly_closings_test"
DAILY_REPORTS_SNAPSHOT_TEST_COLLECTION = "daily_reports_snapshot_test"


def _env_flag_truthy(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in ("1", "true", "yes", "on")


def is_monthly_closing_test_mode() -> bool:
    """
    締め処理の検証用。真のときは管理ドキュメント・スナップショットの読み書き先を
    テスト用コレクションに切り替える（本番の monthly_closings / daily_reports_snapshot は触らない）。

    環境変数: MONTHLY_CLOSING_TEST_MODE
    """
    return _env_flag_truthy("MONTHLY_CLOSING_TEST_MODE")


def monthly_closings_collection_for_closing_run() -> str:
    """締め実行 API が読み書きする管理ドキュメントのコレクション（テストモード時は *_test）。"""
    if is_monthly_closing_test_mode():
        override = (os.environ.get("MONTHLY_CLOSINGS_TEST_COLLECTION") or "").strip()
        return override or MONTHLY_CLOSINGS_TEST_COLLECTION
    return MONTHLY_CLOSINGS_COLLECTION


def default_snapshot_collection_for_closing_run() -> str:
    """締め実行でコピー先とするスナップショットコレクションの既定名（テストモード時は別名）。"""
    if is_monthly_closing_test_mode():
        override = (os.environ.get("MONTHLY_CLOSING_TEST_SNAPSHOT_COLLECTION") or "").strip()
        return override or DAILY_REPORTS_SNAPSHOT_TEST_COLLECTION
    return DAILY_REPORTS_SNAPSHOT_COLLECTION


# --- Project ID ---
PROJECT_ID = "dailyreport-480700"

# --- Target Employees ---
TARGET_EMPLOYEE_IDS = ["16"] # 取得対象の従業員IDリスト。例: ["16", "17", "18"]