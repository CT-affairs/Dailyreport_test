import os
import sys
import json
import hmac
import hashlib
import base64
import time
import requests

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# --- 環境変数の読み込み ---
# .envファイルはプロジェクトルートにあることを想定
from dotenv import load_dotenv
dotenv_path = os.path.join(project_root, '.env')
if os.path.exists(dotenv_path):
    load_dotenv(dotenv_path=dotenv_path)

# --- 設定値 ---
# WebhookのURLとチャネルシークレットを環境変数から取得
WEBHOOK_URL = os.environ.get("WEBHOOK_URL")
# LINE Messaging APIのチャネルシークレットを取得
CHANNEL_SECRET = os.environ.get("LINE_MESSAGING_API_CHANNEL_SECRET")

# テスト用のダミーLINEユーザーID (適宜変更してください)
TEST_USER_ID = "U01fdc8f83114f5e73fa6aea001116e7d"

def generate_signature(channel_secret: str, request_body: str) -> str:
    """
    LINE Messaging APIのシグネチャを生成する。
    """
    if not channel_secret:
        raise ValueError("Channel secret is not set.")
    
    hash_obj = hmac.new(
        channel_secret.encode('utf-8'),
        request_body.encode('utf-8'),
        hashlib.sha256
    ).digest()
    
    return base64.b64encode(hash_obj).decode('utf-8')

def simulate_follow_event(webhook_url: str, channel_secret: str, user_id: str):
    """
    指定されたWebhook URLにFollowEventをシミュレートしたリクエストを送信する。
    """
    if not webhook_url or not channel_secret:
        print("エラー: 環境変数 'WEBHOOK_URL' と 'LINE_MESSAGING_API_CHANNEL_SECRET' を設定してください。")
        return

    print(f"シミュレーション開始: FollowEventを {webhook_url} に送信します...")
    print(f"対象ユーザーID: {user_id}")

    # 1. FollowEventのペイロードを作成
    request_body = {
        "destination": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", # BotのID (通常は検証されない)
        "events": [
            {
                "type": "follow",
                "timestamp": int(time.time() * 1000),
                "source": {
                    "type": "user",
                    "userId": user_id
                },
                "replyToken": "00000000000000000000000000000000", # テスト用のダミートークン
                "mode": "active"
            }
        ]
    }
    body_str = json.dumps(request_body)

    # 2. シグネチャを生成
    try:
        signature = generate_signature(channel_secret, body_str)
    except ValueError as e:
        print(f"エラー: {e}")
        return

    # 3. HTTPヘッダーを設定
    headers = {'Content-Type': 'application/json', 'X-Line-Signature': signature}

    # 4. WebhookにPOSTリクエストを送信
    try:
        response = requests.post(webhook_url, headers=headers, data=body_str, timeout=10)
        print("\n--- レスポンス ---")
        print(f"ステータスコード: {response.status_code}")
        print(f"レスポンスボディ: {response.text}")
    except requests.exceptions.RequestException as e:
        print(f"\nエラー: Webhookへの接続に失敗しました: {e}")



if __name__ == "__main__":
    # スクリプト実行時に引数でユーザーIDを指定できるようにする
    target_user_id = sys.argv[1] if len(sys.argv) > 1 else TEST_USER_ID
    simulate_follow_event(WEBHOOK_URL, CHANNEL_SECRET, target_user_id)