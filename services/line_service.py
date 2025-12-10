import os
import requests
from datetime import datetime

class LineService:
    CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")
    REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply"

    @staticmethod
    def build_yes_no_buttons():
        return {
            "type": "template",
            "altText": "Yes / No",
            "template": {
                "type": "buttons",
                "text": "今日は対応できましたか？",
                "actions": [
                    {
                        "type": "postback",
                        "label": "Yes",
                        "data": "answer=YES"
                    },
                    {
                        "type": "postback",
                        "label": "No",
                        "data": "answer=NO"
                    }
                ]
            }
        }

    @staticmethod
    def parse_postback(event):
        data = event["postback"]["data"]
        answer = data.split("=")[1]
        user_id = event["source"].get("userId")

        return {
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "user_id": user_id,
            "answer": answer
        }

    @staticmethod
    def _get_service():
        creds, _ = default()
        return build("sheets", "v4", credentials=creds, cache_discovery=False)

    @staticmethod
    def send_reply(reply_token: str, message: dict):
        access_token = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")
        if not access_token:
            raise RuntimeError("LINE_CHANNEL_ACCESS_TOKEN is not set")

        url = "https://api.line.me/v2/bot/message/reply"

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {access_token}",
        }

        body = {
            "replyToken": reply_token,
            "messages": [message], 
        }

        response = requests.post(url, headers=headers, json=body)

        if response.status_code != 200:
            raise RuntimeError(
                f"LINE reply failed: {response.status_code} {response.text}"
            )
