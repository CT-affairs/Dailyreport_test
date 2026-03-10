"""
業務報告LINE Botのバックエンドアプリケーション。
Flaskアプリケーションのエントリーポイント。
各コンポーネント（Blueprint）を登録し、アプリケーションを起動する。
"""
from flask import Flask, jsonify, Response, abort, request
import os
import sys
import logging

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
# これにより、どの環境から実行してもapp_coreパッケージを正しくインポートできる
project_root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, project_root)

from google.cloud import firestore
from datetime import datetime, timezone, timedelta

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

from flask_cors import CORS
from routes import webhook # webhookモジュールを先にインポート

app = Flask(__name__)

db = firestore.Client()

# --- CORS設定 ---
# 本番環境のLIFF URLと、ローカル開発用のURLからのAPIリクエストを許可する
allowed_origins = [
    "https://clean-techno.com", # 本番LIFFのドメイン
    "http://localhost:8080",    # ローカル開発サーバー
    "http://127.0.0.1:8080"   # ローカル開発サーバー
]
CORS(app, resources={r"/api/*": {"origins": allowed_origins}})

# --- ロガー設定 ---
# Cloud Runのログは標準出力/エラーに出力されたものが収集される
gunicorn_logger = logging.getLogger('gunicorn.error')
app.logger.handlers = gunicorn_logger.handlers
app.logger.setLevel(gunicorn_logger.level)

# --- 起動時の設定確認ログ ---
TEST_LINE_USER_ID = os.environ.get("TEST_LINE_USER_ID")
if TEST_LINE_USER_ID:
    # セキュリティのため一部伏せ字で出力
    masked_id = f"{TEST_LINE_USER_ID[:4]}...{TEST_LINE_USER_ID[-4:]}" if len(TEST_LINE_USER_ID) > 8 else "***"
    app.logger.info(f"Config: TEST_LINE_USER_ID is set to {masked_id}")
else:
    app.logger.warning("Config: TEST_LINE_USER_ID is NOT set. Test announcements will fail.")

# LINE Messaging APIの環境変数チェック
LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")
if LINE_CHANNEL_ACCESS_TOKEN:
    # トークン自体はログに出さない。長さと最初の数文字で形式を確認する。
    app.logger.info(f"Config: LINE_CHANNEL_ACCESS_TOKEN is set. Length: {len(LINE_CHANNEL_ACCESS_TOKEN)}, Starts with: '{LINE_CHANNEL_ACCESS_TOKEN[:5]}...'")
else:
    app.logger.critical("CRITICAL: LINE_CHANNEL_ACCESS_TOKEN is NOT set. LINE features will fail.")

LINE_MESSAGING_API_CHANNEL_SECRET = os.environ.get("LINE_MESSAGING_API_CHANNEL_SECRET")
if not LINE_MESSAGING_API_CHANNEL_SECRET:
    app.logger.critical("CRITICAL: LINE_MESSAGING_API_CHANNEL_SECRET is NOT set. Webhook will fail.")

# --- アプリケーション初期化処理 ---
# webhook.py でLINEクライアントの初期化とハンドラ登録が完結しているため、
# main.py での初期化処理は不要です。

# --- Blueprintの登録 ---
from routes.api import api_bp
from routes.webhook import webhook_bp
# app_coreパッケージをインポートして、その中のモジュールを使えるようにする
from app_core import config, utils # この行は直接使われていないが、可読性のために残しても良い

app.register_blueprint(api_bp, url_prefix='/api')
app.register_blueprint(webhook_bp)

# --- エラーハンドラ定義 ---

@app.errorhandler(400)
def bad_request(e):
    # 400エラーが発生した際に、リクエストのボディをログに出力してデバッグを容易にする
    request_body = request.get_data(as_text=True)
    app.logger.warning(f"Bad Request (400): {e.description} - Request Body: {request_body}")
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

# --- ヘルスチェック用エンドポイント ---

@app.route("/ping", methods=["GET"])
def ping():
    return "pong"

@app.route("/", methods=["GET"])
def health_check():
    return "Cloud Run is alive", 200

# --- CSVダウンロード用エンドポイント ---
@app.route("/liff/download/<manager_id>", methods=["GET"])
def download_csv(manager_id):
    """
    指定された管理者IDの直近の一時保存CSVをダウンロードする。
    """
    # 日付に依存せず、管理者IDをキーにして取得する
    doc_id = str(manager_id)

    # ログ出力: リクエスト情報
    app.logger.info(f"Download request: manager_id={manager_id}, doc_id={doc_id}")
    
    doc_ref = db.collection("download_links").document(doc_id)
    doc = doc_ref.get()
    
    if not doc.exists:
        app.logger.warning(f"Document not found: {doc_id}")
        abort(404, "ダウンロードデータが見つかりません。管理者画面から集計を実行してください。")
        
    data = doc.to_dict()
    # 期限チェックは行わない

    csv_content = data.get("csv_content", "")
    file_name = data.get("file_name", "report.csv")
    
    # CSVとしてレスポンスを返す
    return Response(
        csv_content,
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment;filename={file_name}"}
    )

# --- アプリケーション実行 ---

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
