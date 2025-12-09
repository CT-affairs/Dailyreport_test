from flask import Flask
import os
from datetime import datetime

from google.auth import default
from googleapiclient.discovery import build

app = Flask(__name__)

SPREADSHEET_ID = "1vbIIfOhXIZjB6TPi8QjjhNBYlPch2c38Hu-zPKiKF0k"
SHEET_NAME = "log"

@app.route("/")
def index():
    return "Cloud Run OK"

@app.route("/sheet-test")
def sheet_test():
    # Cloud Run のサービスアカウントを自動使用
    creds, _ = default()

    service = build(
        "sheets",
        "v4",
        credentials=creds,
        cache_discovery=False
    )

    values = [[
        datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "cloud-run",
        "sheet write test"
    ]]

    service.spreadsheets().values().append(
        spreadsheetId=SPREADSHEET_ID,
        range=f"{SHEET_NAME}!A:C",
        valueInputOption="RAW",
        body={"values": values}
    ).execute()

    return "Sheet write OK"

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
