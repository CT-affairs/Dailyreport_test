import json
import os
import re
from typing import Any, Dict, List, Optional

from openai import OpenAI

# 環境変数にAPIキーをセットしておく
# export OPENAI_API_KEY="sk-xxxx"

client = OpenAI()

# LLM 応答が長い明細JSONで途中切れしないよう、上限は環境変数で調整可能
LLM_MAX_OUTPUT_TOKENS = int(os.environ.get("LLM_MAX_OUTPUT_TOKENS", "32000"))
_llm_retry_default = max(64000, LLM_MAX_OUTPUT_TOKENS * 2)
LLM_MAX_OUTPUT_TOKENS_RETRY = int(
    os.environ.get("LLM_MAX_OUTPUT_TOKENS_RETRY", str(_llm_retry_default))
)


ORDER_NUMBER_PATTERN = re.compile(r"\b\d{5,}[\/_-]\d{3,}\b|\b\d{6,}\b")


def _to_number(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return None
    s = s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def _normalize_order_number(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    # OCR由来の空白や全角記号を最低限吸収
    s = s.replace(" ", "").replace("　", "")
    s = s.replace("／", "/").replace("ー", "-")
    m = ORDER_NUMBER_PATTERN.search(s)
    return m.group(0) if m else None


def _extract_order_number_from_item(item: Dict[str, Any]) -> Optional[str]:
    for key in ("order_number", "note", "item_name"):
        cand = _normalize_order_number(item.get(key))
        if cand:
            return cand
    return None


def _is_summary_line(item_name: str) -> bool:
    s = (item_name or "").strip()
    if not s:
        return False
    # 合計行・税行・小計行などは明細から除外
    summary_keywords = ["合計", "小計", "税抜", "消費税", "税込", "請求額", "値引", "差引"]
    return any(k in s for k in summary_keywords)


def _is_meaningful_line_item(item: Dict[str, Any]) -> bool:
    item_name = str(item.get("item_name") or "").strip()
    qty = _to_number(item.get("quantity"))
    unit_price = _to_number(item.get("unit_price"))
    amount = _to_number(item.get("amount"))
    order_no = _normalize_order_number(item.get("order_number"))

    if _is_summary_line(item_name):
        return False

    # 明細行として扱う最小条件
    # - 品名あり かつ (数量/金額/単価/発注番号のいずれかあり)
    if item_name and (qty is not None or amount is not None or unit_price is not None or order_no):
        return True

    # 例外: 品名が薄くても数値3点が揃うなら明細扱い
    numeric_points = sum(x is not None for x in (qty, unit_price, amount))
    return numeric_points >= 2


def _postprocess_line_items(line_items: List[Dict[str, Any]], invoice_obj: Dict[str, Any]) -> List[Dict[str, Any]]:
    normalized_items: List[Dict[str, Any]] = []

    # 1) 明細行判定 + order_number候補抽出
    for raw in line_items:
        if not isinstance(raw, dict):
            continue

        item = {
            "item_name": raw.get("item_name"),
            "order_number": _normalize_order_number(raw.get("order_number")),
            "quantity": _to_number(raw.get("quantity")),
            "unit": raw.get("unit"),
            "unit_price": _to_number(raw.get("unit_price")),
            "amount": _to_number(raw.get("amount")),
            "tax": _to_number(raw.get("tax")),
            "note": raw.get("note"),
            "confidence": raw.get("confidence"),
            "status": raw.get("status") or "pending",
            # 先方伝票番号は補助情報として後付け
            "supplier_slip_number": raw.get("supplier_slip_number"),
        }

        if not _is_meaningful_line_item(item):
            continue

        if not item["order_number"]:
            item["order_number"] = _extract_order_number_from_item(raw)

        normalized_items.append(item)

    # 2) 明細に order_number を可能な限り埋める（最優先要件）
    invoice_level_order = _normalize_order_number(invoice_obj.get("order_number"))
    if invoice_level_order:
        for item in normalized_items:
            if not item.get("order_number"):
                item["order_number"] = invoice_level_order

    # 3) 先方伝票番号（補助情報）を後付け
    invoice_no = invoice_obj.get("invoice_number")
    for item in normalized_items:
        if not item.get("supplier_slip_number"):
            item["supplier_slip_number"] = invoice_no

    return normalized_items

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

④ 表記ゆれについて
  - 「注文番号」「発注No」「注文No」のように表記ゆれを考慮して判断する

⑤ 発注番号の重要性について
  - 解析の目的は明細行に分解した要素に発注番号を振っていくことであるため、請求書発行元が振っている伝票番号よりも重要性は高い

⑥ 判別できない場合
  - order_numberはnullにする（推測で埋めない）

# ■ 判定ヒント

- ヘッダ付近・合計付近に1つ → 全体
- 明細内に複数 → 行単位
- 「注文番号」「発注No」などのラベルを優先

# ■ OCRテキストの再構築について

- OCRは改行が崩れている可能性がある
- そのため、視覚的な表の行を推定して再構築すること

- 明細行1行として候補とする場合の条件
・品名、及び、数値（数量 + 単価 + 小計の3つであることが多い)のまとまりが、1明細行として成立する
・「明細行」としては1行でも、品名の詳細部分や発注番号は改行されて記載されていることがある

# ■ 解析の優先順位

1. 明細行の正しい分割
2. 各行へのorder_number付与
3. 数値項目の正確性
※ ここまでは重要で、以下は優先順位が低い
4. 請求元が付与した伝票番号
5. 入金情報のような、請求書として目的からやや外れた連絡的な要素、副次的な要素

※ 完璧でなくても、order_numberが正しく付与されることを最優先とする

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

    response = _call_extract(prompt, max_output_tokens=LLM_MAX_OUTPUT_TOKENS)

    # max_output_tokens で未完なら、上限を上げて 1 回だけリトライ（以前の 1400 は誤りで逆効果）
    status = getattr(response, "status", None)
    incomplete_reason = getattr(getattr(response, "incomplete_details", None), "reason", None)
    if status == "incomplete" and incomplete_reason == "max_output_tokens":
        response = _call_extract(prompt, max_output_tokens=LLM_MAX_OUTPUT_TOKENS_RETRY)

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

    # 新スキーマ（vendor/invoice/line_items）を優先して返す。
    # 旧スキーマのキーしか無い場合でも互換のために最低限埋める。
    vendor_obj = data.get("vendor") if isinstance(data.get("vendor"), dict) else {}
    invoice_obj = data.get("invoice") if isinstance(data.get("invoice"), dict) else {}
    line_items_obj = data.get("line_items") if isinstance(data.get("line_items"), list) else []

    invoice_payload = {
        "invoice_number": invoice_obj.get("invoice_number", data.get("invoice_number")),
        "order_number": invoice_obj.get("order_number", data.get("order_number")),
        "date": invoice_obj.get("date", data.get("date")),
        "payment_due_date": invoice_obj.get("payment_due_date"),
        "total_amount": invoice_obj.get("total_amount", data.get("total_amount")),
        "tax_amount": invoice_obj.get("tax_amount"),
        "registration_number": invoice_obj.get("registration_number", data.get("registration_number")),
    }
    processed_line_items = _postprocess_line_items(
        [x for x in line_items_obj if isinstance(x, dict)],
        invoice_payload,
    )

    out: Dict[str, Any] = {
        "invoice_id": data.get("invoice_id"),
        "status": data.get("status"),
        "vendor": {
            "vendor_id": vendor_obj.get("vendor_id"),
            "vendor_name": vendor_obj.get("vendor_name") or data.get("vendor_name"),
            "confidence": vendor_obj.get("confidence", data.get("confidence")),
        },
        "invoice": invoice_payload,
        "line_items": processed_line_items,
        "reasoning": data.get("reasoning"),
        "confidence": data.get("confidence", vendor_obj.get("confidence")),
        "ocr_text": data.get("ocr_text"),
        "created_at": data.get("created_at"),
        "_raw": raw_text,
        "llm_response_status": getattr(response, "status", None),
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