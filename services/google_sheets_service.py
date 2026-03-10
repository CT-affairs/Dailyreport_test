import os
from datetime import datetime, timezone, timedelta
from typing import List

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2 import service_account
from google.auth import default

SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID")
SHEET_NAME = "log"

JST = timezone(timedelta(hours=9), 'JST')

class GoogleSheetsService:
    @staticmethod
    def _get_service():
        creds, _ = default()
        return build(
            "sheets",
            "v4",
            credentials=creds,
            cache_discovery=False
        )    
    
    @staticmethod
    def append_yes_no(record):
        values = [[
            record["timestamp"],
            record["user_id"],
            record["answer"]
        ]]

        service = GoogleSheetsService._get_service()
        service.spreadsheets().values().append(
            spreadsheetId=SPREADSHEET_ID,
            range="log!A:C",
            valueInputOption="RAW",
            body={"values": values}
        ).execute()

    def append_log(self, user_id: str, message: str):
        values = [[
            datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S"),
            user_id,
            message
        ]]

        try:
            self.service.spreadsheets().values().append(
                spreadsheetId=SPREADSHEET_ID,
                range=f"{SHEET_NAME}!A:C",
                valueInputOption="RAW",
                body={"values": values}
            ).execute()
        except HttpError as e:
            print(f"[Sheets Error] {e}")

    @staticmethod
    def get_values(sheet_range: str) -> List[List[str]]:
        """指定された範囲の値を取得する"""
        try:
            service = GoogleSheetsService._get_service()
            result = service.spreadsheets().values().get(
                spreadsheetId=SPREADSHEET_ID,
                range=sheet_range
            ).execute()
            return result.get('values', [])
        except HttpError as e:
            print(f"[Sheets Error] {e}")
            return []

    @staticmethod
    def batch_update(data: List[dict]):
        """
        複数のセルの値を一括で更新する
        data: [{"range": "シート名!A1", "values": [[値]]}, ...]
        """
        if not data:
            return

        try:
            service = GoogleSheetsService._get_service()
            body = {
                'valueInputOption': 'USER_ENTERED',
                'data': data
            }
            service.spreadsheets().values().batchUpdate(
                spreadsheetId=SPREADSHEET_ID,
                body=body
            ).execute()
            print(f"{len(data)}個のセルを更新しました。")
        except HttpError as e:
            print(f"[Sheets Error] {e}")
