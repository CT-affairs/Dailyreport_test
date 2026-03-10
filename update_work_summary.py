import os
import sys

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
project_root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, project_root)


# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

import requests
from typing import List, Dict, Optional
from services.google_sheets_service import GoogleSheetsService
from services.jobcan_service import JobcanService


def main():
    """メイン処理"""
    SHEET_NAME = "Daily_summary"

    # 1. スプレッドシートから日付と従業員IDを取得
    print("スプレッドシートから日付と従業員IDを読み込んでいます...")
    # 2行目のB列以降から従業員IDを取得
    header_row = GoogleSheetsService.get_values(f"{SHEET_NAME}!2:2")
    if not header_row or not header_row[0][1:]:
        print("エラー: シートから従業員IDが読み込めませんでした。")
        return
    employee_ids = header_row[0][1:]

    # A列の2行目以降から日付を取得
    date_column = GoogleSheetsService.get_values(f"{SHEET_NAME}!A2:A")
    if not date_column:
        print("エラー: シートから日付が読み込めませんでした。")
        return
    dates = [row[0] for row in date_column if row]

    # 日付リストを日付とその行インデックスの辞書に変換
    date_map = {date: i for i, date in enumerate(dates, start=3)}

    print(f"対象従業員: {len(employee_ids)}名, 対象日付: {len(dates)}日")

    # 2. Jobcan APIから勤務時間を取得
    client_id = os.environ.get("JOBCAN_CLIENT_ID_SANDBOX")
    client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_SANDBOX")
    jobcan_service = JobcanService(client_id, client_secret)

    update_data = []
    print(f"Jobcan APIから勤務時間の取得を開始します...")

    # 従業員ごとにループ
    for col_idx, employee_id in enumerate(employee_ids, start=2):
        print(f"  従業員ID: {employee_id} のデータを取得中...")
        # 日付を31日ずつのチャンクに分割してAPIを呼び出す
        for i in range(0, len(dates), 31):
            date_chunk = dates[i:i + 31]
            print(f"    - {date_chunk[0]} から {date_chunk[-1]} の期間を取得...")
            
            response_data = jobcan_service.get_daily_summaries(employee_id, date_chunk)

            work_minutes_map = {}
            if response_data and "daily_summaries" in response_data:
                for summary in response_data["daily_summaries"]:
                    if "date" in summary and "work" in summary:
                        work_minutes_map[summary["date"]] = summary["work"]

            if not work_minutes_map:
                continue

            # 取得したデータをスプレッドシート更新用の形式に変換
            for date, work_minutes in work_minutes_map.items():
                row_idx = date_map.get(date)
                if row_idx:
                    col_char = chr(ord('A') + col_idx - 1)
                    update_data.append({
                        "range": f"{SHEET_NAME}!{col_char}{row_idx}",
                        "values": [[work_minutes]]
                    })

    # 3. スプレッドシートを更新
    if update_data:
        print("スプレッドシートを更新しています...")
        GoogleSheetsService.batch_update(update_data)
    else:
        print("更新するデータがありませんでした。")

    print("処理が完了しました。")


if __name__ == "__main__":
    main()