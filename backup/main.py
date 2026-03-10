"""
業務報告LINE Botのバックエンドアプリケーション。
LIFFアプリからのAPIリクエスト処理、LINE Messaging APIのWebhook処理を行う。
"""
from flask import Flask, request, abort, make_response
import os
import json
from linebot import WebhookHandler, LineBotApi
from linebot.models import PostbackEvent, MessageEvent, TextMessage, TextSendMessage
import requests
import jwt # PyJWTライブラリ
from flask import jsonify
import base64
from functools import wraps

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

from google.cloud import firestore
from datetime import datetime, timedelta
from flask_cors import CORS

app = Flask(__name__)

# LIFFアプリ (https://liff.line.me) からのAPIリクエストを許可する
CORS(app, resources={r"/api/*": {"origins": "https://clean-techno.com"}})

# --- エラーハンドラ定義 ---

@app.errorhandler(400)
def bad_request(e):
    return jsonify(error="bad_request", message=str(e.description)), 400

@app.errorhandler(401)
def unauthorized(e):
    return jsonify(error="unauthorized", message=str(e.description)), 401

@app.errorhandler(403)
def forbidden(e):
    return jsonify(error="forbidden", message=str(e.description)), 403

@app.errorhandler(409)
def conflict(e):
    return jsonify(error="conflict", message=str(e.description)), 409

@app.errorhandler(500)
def internal_error(e):
    # 500エラーの場合は、元のエラー情報もログに出力しておくとデバッグに役立つ
    app.logger.error(f"Internal Server Error: {e.original_exception}")
    return jsonify(error="internal_error", message=str(e.description)), 500

# --- 環境変数とグローバルクライアントの初期化 ---

LINE_MESSAGING_API_CHANNEL_SECRET = os.environ.get("LINE_MESSAGING_API_CHANNEL_SECRET")
if not LINE_MESSAGING_API_CHANNEL_SECRET:
    raise ValueError("環境変数 'LINE_MESSAGING_API_CHANNEL_SECRET' が設定されていません。")

LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")
if not LINE_CHANNEL_ACCESS_TOKEN:
    raise ValueError("環境変数 'LINE_CHANNEL_ACCESS_TOKEN' が設定されていません。")

LINE_LOGIN_CHANNEL_ID = os.environ.get("LINE_LOGIN_CHANNEL_ID")
if not LINE_LOGIN_CHANNEL_ID:
    raise ValueError("環境変数 'LINE_LOGIN_CHANNEL_ID' が設定されていません。")

db = firestore.Client()
handler = WebhookHandler(LINE_MESSAGING_API_CHANNEL_SECRET)
line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)

# --- 定数 ---
LINE_JWKS_URL = "https://api.line.me/oauth2/v2.1/certs"
LINE_ISSUER = "https://access.line.me"

# --- ヘルパー関数 & ビジネスロジック ---

def verify_line_id_token(id_token: str) -> dict:
    """
    JWKSを使用してLINEのIDトークンを検証し、デコードされたペイロードを返す。
    """
    try:
        # 1. JWKSを取得
        jwks_client = jwt.PyJWKClient(LINE_JWKS_URL)
        signing_key = jwks_client.get_signing_key_from_jwt(id_token)

        # 2. IDトークンをデコード・検証
        #    - 署名の検証
        #    - 有効期限 (exp) の検証
        #    - 発行者 (iss) の検証
        #    - 対象者 (aud) の検証
        decoded_payload = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["ES256"],
            audience=LINE_LOGIN_CHANNEL_ID,
        )
        return decoded_payload

    except jwt.PyJWTError as e:
        # JWTに関するあらゆるエラー（期限切れ、署名不正、クレーム不正など）を捕捉
        app.logger.error(f"ID token verification failed: {e}")
        raise ValueError(f"Invalid ID token: {e}")
    except Exception as e:
        app.logger.error(f"An unexpected error occurred during token verification: {e}")
        raise

def register_employee_id(current_line_user_id: str, company_employee_id: str, reply_token: str = None):
    """
    会社発行の社員IDを主キーとして、LINEユーザーIDを紐付けてFirestoreに保存する。
    reply_tokenが指定されていれば、結果をLINEで返信する。
    """
    try:
        # 1. 入力された会社発行IDからJobcanIDを検索
        mapping_ref = db.collection("employee_mappings").document(company_employee_id)
        mapping_doc = mapping_ref.get()

        if not mapping_doc.exists:
            app.logger.warning(f"Employee mapping not found for company_employee_id: {company_employee_id}")
            # 紐付けが見つからない場合はエラーとしてNoneを返す
            if reply_token:
                line_bot_api.reply_message(reply_token, TextSendMessage(text="入力された社員IDはシステムに登録されていません。"))
            return None, None

        jobcan_employee_id = mapping_doc.to_dict().get("jobcan_employee_id")
        is_manager = mapping_doc.to_dict().get("is_manager", False)

        # 2. usersコレクションを会社IDで検索し、登録/更新
        user_ref = db.collection("users").document(company_employee_id)
        user_doc = user_ref.get()

        if not user_doc.exists:
            # Case A: ドキュメントが存在しない (本当の新規登録)
            user_ref.set({
                "line_user_id": current_line_user_id,
                "jobcan_employee_id": jobcan_employee_id,
                "is_manager": is_manager,
                "created_at": firestore.SERVER_TIMESTAMP,
                "updated_at": firestore.SERVER_TIMESTAMP
            })
            action = "created"
            reply_message = f"社員ID「{company_employee_id}」を新規登録しました。"
            app.logger.info(f"Successfully created registration for company_id '{company_employee_id}' with LINE user '{current_line_user_id}'.")
        else:
            # Case B: ドキュメントが存在する
            user_data = user_doc.to_dict()
            existing_line_user_id = user_data.get("line_user_id")

            if not existing_line_user_id:
                # Case B-1: 管理者によって紐付けが解除されている場合 (再登録)
                user_ref.update({
                    "line_user_id": current_line_user_id,
                    "updated_at": firestore.SERVER_TIMESTAMP
                })
                action = "updated" # 実質的には再リンクだが、クライアント側では更新として扱う
                reply_message = f"社員ID「{company_employee_id}」にLINEアカウントを再登録しました。"
                app.logger.info(f"Successfully re-linked company_id '{company_employee_id}' to new LINE user '{current_line_user_id}'.")
            elif existing_line_user_id == current_line_user_id:
                # Case B-2: 既に自分自身が紐付いている場合
                action = "no_change"
                reply_message = f"社員ID「{company_employee_id}」は既にこのLINEアカウントに登録済みです。"
                app.logger.info(f"Registration attempt for company_id '{company_employee_id}' with the same LINE user. No change made.")
            else:
                # Case B-3: 別のLINEアカウントが既に紐付いている場合 (なりすまし防止)
                app.logger.warning(f"Conflict: company_id '{company_employee_id}' is already linked to another LINE user.")
                abort(409, f"この社員IDは既に別のLINEアカウントと紐付いています。アカウントを変更した場合は、システム管理者にご連絡ください。")

        if reply_token:
            line_bot_api.reply_message(reply_token, TextSendMessage(text=reply_message))
        return action, company_employee_id
    except Exception as e:
        # abort(409) から来たエラーはそのまま伝播させる
        if hasattr(e, 'code') and e.code == 409:
            raise
        app.logger.error(f"Failed to register user ID for '{current_line_user_id}': {e}")
        if reply_token:
            line_bot_api.reply_message(reply_token, TextSendMessage(text="エラーが発生しました。登録に失敗しました。"))
        return None, None

# --- APIエンドポイント定義 (LIFFアプリからのリクエストを処理) ---

@app.route("/api/verify-employee", methods=["POST", "OPTIONS"])
def verify_employee():
    """LIFFアプリから送られた社員IDを検証し、名前を返すエンドポイント"""
    if request.method == "OPTIONS":
        response = make_response()
        response.headers.add("Access-Control-Allow-Origin", "https://clean-techno.com")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type,Authorization")
        response.headers.add("Access-Control-Allow-Methods", "POST,OPTIONS")
        return response

    # 認証
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        abort(401, "Authorization header is missing or invalid.")
    try:
        verify_line_id_token(auth_header.split(" ")[1])
    except ValueError:
        abort(401, "ID token is invalid.")

    # リクエストボディから社員IDを取得
    data = request.get_json()
    if not data or "employeeId" not in data:
        abort(400, "Request body must contain 'employeeId'.")
    employee_id = data["employeeId"]

    # employee_mappingsからドキュメントを検索
    mapping_ref = db.collection("employee_mappings").document(employee_id)
    mapping_doc = mapping_ref.get()

    if not mapping_doc.exists:
        abort(404, f"社員ID「{employee_id}」は見つかりませんでした。")

    mapping_data = mapping_doc.to_dict()
    name = mapping_data.get("name", "名前未登録")
    return jsonify({"status": "found", "name": name, "employeeId": employee_id}), 200

@app.route("/api/register", methods=["POST", "OPTIONS"])
def register_from_liff():
    """LIFFアプリから社員ID登録を受け付けるエンドポイント"""
    if request.method == "OPTIONS":
        # プリフライトリクエストに応答するためのヘッダーを付与
        response = make_response()
        response.headers.add("Access-Control-Allow-Origin", "https://clean-techno.com")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type,Authorization")
        response.headers.add("Access-Control-Allow-Methods", "POST,OPTIONS")
        return response

    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        abort(401, "Authorization header is missing or invalid.")
    try:
        id_token = auth_header.split(" ")[1]
        user_id = verify_line_id_token(id_token)["sub"]
    except (ValueError, IndexError, KeyError):
        abort(401, "ID token is invalid.")

    # 2. リクエストボディから社員IDを取得
    data = request.get_json()
    if not data or "employeeId" not in data:
        abort(400, "Request body must contain 'employeeId'.")
    
    employee_id = data["employeeId"]
    if not isinstance(employee_id, str) or not employee_id.isdigit():
        abort(400, "'employeeId' must be a string containing only digits.")

    # このLINEアカウントが既に他の社員IDに紐付いていないか確認
    users_ref = db.collection("users")
    query = users_ref.where("line_user_id", "==", user_id).limit(1)
    docs = list(query.stream())

    if docs:
        existing_doc = docs[0]
        # 既に紐付いている会社IDを取得
        linked_company_id = existing_doc.id
        # もし、既に紐付いているIDと、今回入力されたIDが異なる場合
        if linked_company_id != employee_id:
            app.logger.warning(f"Conflict: LINE user '{user_id}' is already linked to company_id '{linked_company_id}' but tried to register with '{employee_id}'.")
            abort(409, f"このLINEアカウントは既に別の社員ID（{linked_company_id}）に紐付いています。")

    # 3. 登録処理を実行
    action, registered_id = register_employee_id(current_line_user_id=user_id, company_employee_id=employee_id)

    if action and registered_id:
        return {"status": action, "employeeId": registered_id}, 200
    else:
        abort(500, "Failed to process employee ID registration.")

@app.route("/api/reports", methods=["POST", "OPTIONS"])
def post_report():
    """LIFFアプリから業務報告を受け取り、Firestoreに保存するエンドポイント"""
    # プリフライトリクエスト(OPTIONS)への対応
    if request.method == "OPTIONS":
        # プリフライトリクエストに応答するためのヘッダーを付与
        response = make_response()
        response.headers.add("Access-Control-Allow-Origin", "https://clean-techno.com")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type,Authorization")
        response.headers.add("Access-Control-Allow-Methods", "POST,OPTIONS")
        return response

    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        abort(401, "Authorization header is missing or invalid.")
    try:
        id_token = auth_header.split(" ")[1]
        user_id = verify_line_id_token(id_token)["sub"]
    except (ValueError, IndexError, KeyError):
        abort(401, "ID token is invalid.")

    # 3. リクエストボディからデータを取得
    report_data = request.get_json()
    if not report_data:
        print("Error: Request body is missing or not a valid JSON.")
        abort(400, "Request body is missing or not a valid JSON.")

    date = report_data.get("date")
    content = report_data.get("content")
    if not date or not content:
        print(f"Error: Invalid request body. date='{date}', content='{content}'")
        abort(400, "Invalid request body. 'date' and 'content' must not be empty.")

    # 4. Firestoreにデータを保存（追記・補足）
    # LINEユーザーIDを元に、usersコレクションから紐づく社員情報を逆引き検索
    users_ref = db.collection("users")
    query = users_ref.where("line_user_id", "==", user_id).limit(1)
    docs = list(query.stream())

    if not docs:
        # 紐づくユーザーが見つからない場合はエラー
        app.logger.warning(f"User mapping not found for line_user_id: {user_id}. User needs to register.")
        abort(403, "User not registered in the system.")
    
    user_doc = docs[0]
    user_data = user_doc.to_dict()
    employee_id = user_data.get("jobcan_employee_id")

    target_date = date
    doc_id = f"{employee_id}_{target_date}"
    
    try:
        doc_ref = db.collection("daily_summary").document(doc_id)
        # .set(..., merge=True) を使うことで、ドキュメントが存在しない場合は新規作成、存在する場合はマージ（フィールドの追加・更新）する
        doc_ref.set({
            "report_content": content,
            "report_updated_at": firestore.SERVER_TIMESTAMP # 更新日時を記録
        }, merge=True)
    except Exception as e:
        print(f"Error updating Firestore: {e}")
        abort(500, "Failed to save report.")

    print(f"User '{user_id}' submitted a report for '{date}'.")
    return {"status": "success"}, 200

# --- Webhookエンドポイント定義 (LINEプラットフォームからのリクエストを処理) ---

@app.route("/callback", methods=["POST"])
def callback():
    """LINE Messaging APIからのWebhookを受け取るエンドポイント"""
    signature = request.headers['X-Line-Signature']
    body = request.get_data(as_text=True)
    app.logger.info("Request body: " + body)

    try:
        handler.handle(body, signature)
    except Exception as e:
        app.logger.error(f"Webhook handling error: {e}")
        abort(400)

    return "OK"

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    """テキストメッセージを受け取った際の処理"""
    user_id = event.source.user_id
    text = event.message.text.strip()

    # 数字のみのメッセージを社員IDとして処理 (LINEのトーク画面からの簡易登録)
    if text.isdigit():
        employee_id = text
        register_employee_id(user_id, employee_id, event.reply_token)
    else:
        pass # 数字以外のメッセージには応答しない

# --- ヘルスチェック用エンドポイント ---

@app.route("/ping", methods=["GET"])
def ping():
    return "pong"

@app.route("/", methods=["GET"])
def health_check():
    return "Cloud Run is alive", 200

# --- アプリケーション実行 ---

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
