import os
import requests
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9), 'JST')
 
class LineService:
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
                    {"type": "postback", "label": "Yes", "data": "answer=YES"},
                    {"type": "postback", "label": "No",  "data": "answer=NO"},
                ]
            }
        }

    @staticmethod
    def parse_postback(event):
        data = event["postback"]["data"]
        return {
            "timestamp": datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S"),
            "user_id": event["source"].get("userId"),
            "answer": data.split("=")[1],
        }

    @staticmethod
    def send_reply(reply_token: str, message: dict):
        access_token = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")
        if not access_token:
            raise RuntimeError("LINE_CHANNEL_ACCESS_TOKEN is not set")

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {access_token}",
        }

        body = {
            "replyToken": reply_token,
            "messages": [message],
        }

        r = requests.post(LineService.REPLY_ENDPOINT, headers=headers, json=body)
        if r.status_code != 200:
            raise RuntimeError(f"LINE reply failed: {r.status_code} {r.text}")
