import os
from datetime import datetime

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2 import service_account
from google.auth import default

SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID")
SHEET_NAME = "log"


class GoogleSheetsService:
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
            print(f"[Sheets Error] {e}")
