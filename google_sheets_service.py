import os
from datetime import datetime

from google.auth import default
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID")
SHEET_NAME = "log"


class GoogleSheetsService:
    """Googleスプレッドシートとの連携を担当するサービスクラス"""

    def __init__(self):
        """APIクライアントを初期化する"""
        creds, _ = default()
        # cache_discovery=False は、特にサーバーレス環境での警告を避けるために推奨されます
        self.service = build("sheets", "v4", credentials=creds, cache_discovery=False)

    def append_log(self, user_id: str, message: str):
        """指定されたメッセージをスプレッドシートに追記する"""
        values = [[
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
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
            print(f"An error occurred: {e}")