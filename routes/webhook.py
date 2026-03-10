"""
LINE Messaging APIからのWebhookを処理するBlueprint。
"""
from flask import Blueprint, request, abort, current_app
from linebot import WebhookHandler, LineBotApi
from linebot.models import MessageEvent, TextMessage, TextSendMessage
from google.cloud import firestore
import os, sys
from app_core.utils import register_employee_id

# --- Blueprintの作成 ---
webhook_bp = Blueprint('webhook', __name__)

# --- クライアントの初期化 ---
# 環境変数が設定されていない場合、起動時にエラーが発生する
LINE_MESSAGING_API_CHANNEL_SECRET = os.environ.get("LINE_MESSAGING_API_CHANNEL_SECRET")
LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")

if not all([LINE_MESSAGING_API_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN]):
    # 環境変数がなければ、handlerとapiはNoneに設定される。
    # 実際のロギングはmain.pyの起動時と、リクエスト受信時に行う。
    handler = None
    line_bot_api = None
else:
    handler = WebhookHandler(LINE_MESSAGING_API_CHANNEL_SECRET)
    line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)

db = firestore.Client()

# --- Webhookエンドポイント定義 ---

@webhook_bp.route("/callback", methods=["POST"])
def callback():
    """LINE Messaging APIからのWebhookを受け取るエンドポイント"""
    if not handler:
        current_app.logger.error("Webhook handler is not initialized. Check LINE_MESSAGING_API_CHANNEL_SECRET.")
        abort(500, "Webhook handler is not initialized due to missing environment variables.")

    signature = request.headers['X-Line-Signature']
    body = request.get_data(as_text=True)

    try:
        handler.handle(body, signature)
    except Exception as e:
        current_app.logger.error(f"Webhook handling error: {e}")
        abort(400)

    return "OK"

if handler:
    @handler.add(MessageEvent, message=TextMessage)
    def handle_text_message(event):
        """テキストメッセージを受け取った際の処理"""
        if not line_bot_api:
            current_app.logger.error("LineBotApi is not initialized. Cannot reply. Check LINE_CHANNEL_ACCESS_TOKEN.")
            return # 何もせずに終了

        user_id = event.source.user_id
        text = event.message.text.strip()

        if text.isdigit():
            employee_id = text
            register_employee_id(
                current_line_user_id=user_id,
                company_employee_id=employee_id,
                reply_token=event.reply_token,
                line_bot_api=line_bot_api # 初期化済みのインスタンスを渡す
            )