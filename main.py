from flask import Flask, request, abort
import os
import hmac
import hashlib
import base64
import json

from datetime import datetime
from google.auth import default
from googleapiclient.discovery import build

app = Flask(__name__)

CHANNEL_SECRET = os.environ.get("LINE_CHANNEL_SECRET")

SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID")
SHEET_NAME = "log"


def validate_signature(body, signature):
    hash = hmac.new(
        CHANNEL_SECRET.encode("utf-8"),
        body,
        hashlib.sha256
    ).digest()
    return base64.b64encode(hash).decode() == signature


@app.route("/callback", methods=["POST"])
def callback():
    print("CALLBACK START")
    body = request.get_data(as_text=False)
    print("BODY RECEIVED")
    signature = request.headers.get("X-Line-Signature", "")

    # if not validate_signature(body, signature):
    #     abort(400)

    data = json.loads(body)

    creds, _ = default()
    service = build("sheets", "v4", credentials=creds, cache_discovery=False)

    for event in data.get("events", []):
        if event.get("type") == "message":
            message = event["message"].get("text", "")
            user_id = event["source"].get("userId", "")

            values = [[
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                user_id,
                message
            ]]

            service.spreadsheets().values().append(
                spreadsheetId=SPREADSHEET_ID,
                range=f"{SHEET_NAME}!A:C",
                valueInputOption="RAW",
                body={"values": values}
            ).execute()

    return "OK"

@app.route("/ping", methods=["GET", "POST"])
def ping():
    print("PING CALLED")
    return "pong"
