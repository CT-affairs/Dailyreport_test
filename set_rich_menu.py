import os
import json
import requests

# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()


def set_rich_menu():
    """LINEにリッチメニューを設定する"""
    access_token = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")
    if not access_token:
        print("エラー: 環境変数 'LINE_CHANNEL_ACCESS_TOKEN' が設定されていません。")
        return

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }

    # 1. リッチメニューの構造を定義
    # 画像サイズは 2500x843 を想定
    rich_menu_object = {
        "size": {"width": 2500, "height": 843},
        "selected": False,
        "name": "Default Rich Menu",
        "chatBarText": "メニュー",
        "areas": [
            {
                # 左半分の領域
                "bounds": {"x": 0, "y": 0, "width": 1250, "height": 843},
                "action": {"type": "postback", "label": "業務内容を入力", "data": "action=input_report"}
            },
            {
                # 右半分の領域
                "bounds": {"x": 1250, "y": 0, "width": 1250, "height": 843},
                "action": {"type": "postback", "label": "過去分を確認", "data": "action=view_history"}
            }
        ]
    }

    # 2. リッチメニューを作成し、richMenuId を取得
    print("リッチメニューを作成中...")
    r = requests.post(
        "https://api.line.me/v2/bot/richmenu",
        headers=headers,
        data=json.dumps(rich_menu_object)
    )
    r.raise_for_status()
    rich_menu_id = r.json()["richMenuId"]
    print(f"リッチメニューが作成されました。ID: {rich_menu_id}")

    # 3. リッチメニューに画像をアップロード
    print("画像をアップロード中...")
    image_path = "rich_menu.png"  # 画像ファイルへのパス
    with open(image_path, "rb") as f:
        headers["Content-Type"] = "image/png"
        r_img = requests.post(
            f"https://api-data.line.me/v2/bot/richmenu/{rich_menu_id}/content",
            headers=headers,
            data=f
        )
        r_img.raise_for_status()
    print("画像がアップロードされました。")

    # 4. デフォルトのリッチメニューとして設定
    print("デフォルトメニューとして設定中...")
    r_default = requests.post(f"https://api.line.me/v2/bot/user/all/richmenu/{rich_menu_id}", headers=headers)
    r_default.raise_for_status()
    print("リッチメニューの設定が完了しました！")

if __name__ == "__main__":
    set_rich_menu()