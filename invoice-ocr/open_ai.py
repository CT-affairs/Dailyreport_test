import json
import os
import re
from typing import Any, Dict

from openai import OpenAI

# 環境変数にAPIキーをセットしておく
# export OPENAI_API_KEY="sk-xxxx"

client = OpenAI()

def _response_to_debug_dict(response: Any) -> Dict[str, Any]:
    try:
        return response.model_dump()  # type: ignore[attr-defined]
    except Exception:
        return {"repr": repr(response)}


def _call_extract(prompt: str, max_output_tokens: int) -> Any:
    """
    Responses API 呼び出し。SDK/モデル差異に備えて、JSON強制オプションは試してダメならフォールバック。
    """
    try:
        # 可能なら JSON を強制し、reasoning を抑えて本文(JSON)を出させる
        return client.responses.create(
            model="gpt-5-mini",
            input=prompt,
            max_output_tokens=max_output_tokens,
            reasoning={"effort": "low"},
            text={"format": {"type": "json_object"}},
        )
    except TypeError:
        # 互換性フォールバック（古いSDKや未対応パラメータ）
        return client.responses.create(
            model="gpt-5-mini",
            input=prompt,
            max_output_tokens=max_output_tokens,
        )


def _coerce_json(text: str) -> Dict[str, Any]:
    """
    モデルが余計なテキストを混ぜても、最初の JSON オブジェクトを救出してパースする。
    """
    text = text.strip()
    try:
        return json.loads(text)
    except Exception:
        pass

    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        raise ValueError("No JSON object found in model output")
    return json.loads(m.group(0))


def _repair_json_via_model(bad_json_text: str) -> str:
    """
    壊れたJSONっぽいテキストを、モデルに「有効なJSONのみ」に修復させる（失敗時のみ1回呼ぶ想定）。
    """
    repair_prompt = f"""
次のテキストを「有効なJSONオブジェクト」に修復してください。
出力はJSONオブジェクトのみ（説明禁止）。値の意味は変えず、構文だけ直してください。

テキスト:
{bad_json_text}
""".strip()

    resp = _call_extract(repair_prompt, max_output_tokens=800)
    text = getattr(resp, "output_text", None)
    if not text:
        try:
            text = resp.output[0].content[0].text  # type: ignore[attr-defined]
        except Exception:
            text = json.dumps(_response_to_debug_dict(resp), ensure_ascii=False)
    return str(text)


def extract_invoice_data(ocr_text: str) -> Dict[str, Any]:
    """
    OCR テキストから請求書主要項目を抽出する。

    返り値（必ず dict）:
      - invoice_number: str|None
      - date: str|None (YYYY-MM-DD)
      - vendor_name: str|None
      - registration_number: str|None (Tから始まる)
      - total_amount: int|None
      - confidence: float (0.0-1.0)
      - reasoning: str （短い根拠。ログ/デバッグ用途）
    """
    prompt = f"""
あなたはOCRテキストから請求書データを構造化するAIです。
これは文章ではなく、**請求書の表構造を復元するタスク**です。

以下のOCRテキストから、請求書情報を解析し、
**指定されたJSON構造を厳密に守って出力してください。説明は禁止。**

---

# ■ 最重要指示（必ず守る）

- 明細行（line_items）は「1行＝1レコード」で分解する
- 表形式を読み取り、列を推定してマッピングする
- 合計行・税行は line_items に含めない
- 数値はすべて数値型（カンマ除去）
- 不明値は null
- 推測した場合は confidence を下げる

---

# ■ 発注番号（order_number）の扱い（重要）

発注番号は以下のルールで処理する：

① 請求書全体に1つだけ存在する場合
  - それは「請求書全体の発注番号」とみなす
  - 明細行ごとの発注番号が存在しない場合は：
    → すべてのline_itemsに同じorder_numberを必ず設定する
  - これは明示的な補完であり、欠損ではない

② 明細行ごとに発注番号が存在する場合
  - 各行から個別に抽出する
  - この場合、全体の発注番号は無視する

③ 両方存在する場合
  - 明細行の値を優先する
  - 全体の値は使用しない

④ 判別できない場合
  - order_numberはnullにする（推測で埋めない）

# ■ 判定ヒント

- ヘッダ付近・合計付近に1つ → 全体
- 明細内に複数 → 行単位
- 「注文番号」「発注No」などのラベルを優先
# ■ 出力JSON構造（厳守）

{{
  "invoice_id": null,
  "status": "pending",

  "vendor": {{
    "vendor_id": null,
    "vendor_name": null,
    "confidence": 0.0
  }},

  "invoice": {{
    "invoice_number": null,
    "order_number": null,
    "date": null,
    "payment_due_date": null,
    "total_amount": null,
    "tax_amount": null
  }},

  "line_items": [
    {{
      "item_name": null,
      "order_number": null,
      "quantity": null,
      "unit": null,
      "unit_price": null,
      "amount": null,
      "tax": null,
      "note": null,
      "confidence": 0.0,
      "status": "pending"
    }}
  ],

  "ocr_text": null,
  "created_at": null
}}

---

# ■ 明細抽出ルール（超重要）

以下のように列を推定：

- 品名 → item_name
- 数量 → quantity
- 単位 → unit
- 単価 → unit_price
- 金額 → amount
- 税 → tax
- 注文番号や型番 → order_number
- その他 → note

---

# ■ よくあるパターン対応

- 「¥」「円」→ 除去して数値化
- 「1,200」→ 1200
- 「10個」→ quantity=10, unit="個"
- 「一式」→ quantity=1, unit="式"
- 空欄 → null

---

# ■ OCRテキスト

{ocr_text}
    """.strip()

    # まずは余裕を持たせる（reasoningだけで枠を使い切るケースを減らす）
    response = _call_extract(prompt, max_output_tokens=30000)

    # max_output_tokens で未完なら 1 回だけ増やしてリトライ
    status = getattr(response, "status", None)
    incomplete_reason = getattr(getattr(response, "incomplete_details", None), "reason", None)
    if status == "incomplete" and incomplete_reason == "max_output_tokens":
        response = _call_extract(prompt, max_output_tokens=1400)

    # Responses API は output の構造が一定でないことがあるため、まずは output_text を優先
    raw_text = getattr(response, "output_text", None)
    if not raw_text:
        try:
            raw_text = response.output[0].content[0].text  # type: ignore[attr-defined]
        except Exception:
            # ここまで来たらデバッグ情報を返せるようにする
            raw_text = json.dumps(_response_to_debug_dict(response), ensure_ascii=False)

    # それでも JSON が無い（reasoning only など）なら、わかりやすいエラーにする
    if not isinstance(raw_text, str) or not raw_text.strip():
        raise ValueError(f"Empty model output. debug={json.dumps(_response_to_debug_dict(response), ensure_ascii=False)}")
    try:
        data = _coerce_json(raw_text)
    except json.JSONDecodeError:
        # まれに JSON が壊れるので、修復を1回だけ試す
        repaired = _repair_json_via_model(raw_text)
        data = _coerce_json(repaired)

    # 最低限の形を揃える（欠けても落とさない）
    out: Dict[str, Any] = {
        "invoice_number": data.get("invoice_number"),
        "date": data.get("date"),
        "vendor_name": data.get("vendor_name"),
        "registration_number": data.get("registration_number"),
        "total_amount": data.get("total_amount"),
        "confidence": data.get("confidence"),
        "reasoning": data.get("reasoning"),
        "_raw": raw_text,
    }
    return out


# ===== テスト =====
if __name__ == "__main__":
    sample_ocr = """
納品書
売上日 2026年03月10日
No. 00000034
株式会社 紀光
登録番号 T7010901017688
合計 13,200
"""

    result = extract_invoice_data(sample_ocr)
    print(json.dumps(result, ensure_ascii=False, indent=2))