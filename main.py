from flask import Flask, request, abort
import os
import hmac
import hashlib
import base64
import json

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

from services.line_service import LineService
from services.google_sheets_service import GoogleSheetsService

app = Flask(__name__)

CHANNEL_SECRET = os.environ.get("LINE_CHANNEL_SECRET")


def validate_signature(body: bytes, signature: str) -> bool:
    if not CHANNEL_SECRET:
        return False
    digest = hmac.new(
        CHANNEL_SECRET.encode("utf-8"),
        body,
        hashlib.sha256
    ).digest()
    return base64.b64encode(digest).decode() == signature


@app.route("/callback", methods=["POST"])
def callback():
    body = request.get_json()
    events = body.get("events", [])

    for event in events:
        event_type = event.get("type")

        if event_type == "message":
            reply_token = event["replyToken"]
            message = LineService.build_yes_no_buttons()
            LineService.send_reply(reply_token, message)

        elif event_type == "postback":
            record = LineService.parse_postback(event)
            GoogleSheetsService.append_yes_no(record)

    return "OK"

@app.route("/ping", methods=["GET"])
def ping():
    return "pong"

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
