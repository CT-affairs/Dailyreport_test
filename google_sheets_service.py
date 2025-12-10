import os
from datetime import datetime

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2 import service_account
from google.auth import default

SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID")
SHEET_NAME = "log"


class GoogleSheetsService:
    """Googleスプレッドシート連携サービス"""

    def __init__(self):
        self.service = self._build_client()

    def _build_client(self):
        scopes = ["https://www.googleapis.com/auth/spreadsheets"]

        # ローカル：JSONキーあり
        if os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
            creds = service_account.Credentials.from_service_account_file(
                os.environ["GOOGLE_APPLICATION_CREDENTIALS"],
                scopes=scopes
            )
        # Cloud Run：ADC
        else:
            creds, _ = default(scopes=scopes)

        return build("sheets", "v4", credentials=creds, cache_discovery=False)

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
