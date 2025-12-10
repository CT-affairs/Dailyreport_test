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
    print("CALLBACK START")

    body = request.get_data(as_text=False)

    # Cloud Run（＝ .env が無い）場合のみ署名検証
    if not os.path.exists(".env"):
        signature = request.headers.get("X-Line-Signature", "")
        if not validate_signature(body, signature):
            abort(400)

    data = json.loads(body)
    sheets_service = GoogleSheetsService()

    for event in data.get("events", []):
        if event.get("type") == "message":
            message = event["message"].get("text", "")
            user_id = event.get("source", {}).get("userId", "UNKNOWN")
            sheets_service.append_log(user_id, message)

    return "OK"


@app.route("/ping", methods=["GET"])
def ping():
    return "pong"


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
