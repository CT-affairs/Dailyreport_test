import os
import json
import requests
import sys

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
project_root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, project_root)


# --- ローカル環境のみ .env 読み込み ---
if os.path.exists(".env"):
    from dotenv import load_dotenv
    load_dotenv()

# --- 設定 ---
# LIFFアプリのキャッシュを更新したい場合に、このバージョン番号を変更してください
LIFF_APP_VERSION = "1.0.2" 


def set_rich_menu():
    """LINEにリッチメニューを設定する"""
    access_token = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")
    liff_url_input = os.environ.get("LIFF_URL_INPUT_REPORT") # .envファイルにLIFFアプリのURLを追加してください
    if not access_token:
        print("エラー: 環境変数 'LINE_CHANNEL_ACCESS_TOKEN' が設定されていません。")
        return
    if not liff_url_input:
        print("エラー: 環境変数 'LIFF_URL_INPUT_REPORT' が設定されていません。")
        return

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }

    # 1. リッチメニューの構造を定義
    # 画像サイズは 2500x1686 を推奨
    rich_menu_object = {
        "size": {"width": 2500, "height": 1686},
        "selected": True,
        "name": "LIFF App Menu",
        "chatBarText": "メニュー",
        "areas": [
            {
                # 上部領域: 日付選択
                # ?page=calendar を付与して、LIFF側でカレンダー画面の表示を制御する
                "bounds": {"x": 0, "y": 0, "width": 2500, "height": 843},
                "action": {"type": "uri", "uri": f"{liff_url_input}?page=calendar"}
            },
            {
                # 左下領域: 業務内容入力 (LIFF起動)
                "bounds": {"x": 0, "y": 843, "width": 1250, "height": 843},
                # URLの末尾にバージョン情報をクエリとして付与することで、キャッシュを回避する
                # HTMLを更新するたびに、このバージョン番号を変えてリッチメニューを再設定する
                # 例: ?v=1.0.1, ?v=20240520 など
                "action": {"type": "uri", "uri": f"{liff_url_input}?v={LIFF_APP_VERSION}"}
            },
            {
                # 右下領域: ID登録
                "bounds": {"x": 1250, "y": 843, "width": 1250, "height": 843},
                # ?page=register を付与して、LIFF側で表示を切り替える
                "action": {"type": "uri", "uri": f"{liff_url_input}?page=register"}
            }
        ]
    }

    # 2. リッチメニューを作成し、richMenuId を取得
    print("リッチメニューを作成中...")
    r = requests.post(
        "https://api.line.me/v2/bot/richmenu",
        headers=headers,
        json=rich_menu_object  # data=json.dumps(...) の代わりに json=... を使うとよりシンプル
    )
    try:
        r.raise_for_status()
    except requests.exceptions.HTTPError as e:
        print(f"エラー: リッチメニューの作成に失敗しました。 Status: {e.response.status_code}, Response: {e.response.text}")
        return

    rich_menu_id = r.json()["richMenuId"]
    print(f"リッチメニューが作成されました。ID: {rich_menu_id}")

    # 3. リッチメニューに画像をアップロード
    print("画像をアップロード中...")
    image_path = "rich_menu_liff.jpg"
    with open(image_path, "rb") as f:
        headers["Content-Type"] = "image/jpeg"
        r_img = requests.post(
            f"https://api-data.line.me/v2/bot/richmenu/{rich_menu_id}/content",
            headers=headers,
            data=f
        )
        try:
            r_img.raise_for_status()
        except requests.exceptions.HTTPError as e:
            print(f"エラー: 画像のアップロードに失敗しました。 Status: {e.response.status_code}, Response: {e.response.text}")
            return
    print("画像がアップロードされました。")

    # 4. デフォルトのリッチメニューとして設定
    print("デフォルトメニューとして設定中...")
    r_default = requests.post(f"https://api.line.me/v2/bot/user/all/richmenu/{rich_menu_id}", headers=headers)
    try:
        r_default.raise_for_status()
    except requests.exceptions.HTTPError as e:
        print(f"エラー: デフォルトメニューの設定に失敗しました。 Status: {e.response.status_code}, Response: {e.response.text}")
        return

    print("リッチメニューの設定が完了しました！")



if __name__ == "__main__":
    set_rich_menu()