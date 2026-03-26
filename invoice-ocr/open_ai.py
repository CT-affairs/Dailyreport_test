import json
import os
import re
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

from openai import OpenAI

# 環境変数にAPIキーをセットしておく
# export OPENAI_API_KEY="sk-xxxx"

client = OpenAI()

# LLM 応答が長い明細JSONで途中切れしないよう、上限は環境変数で調整可能
# 3ページPDFなどのテスト用にデフォルトを大きめ（本番では環境変数で下げる）
LLM_MAX_OUTPUT_TOKENS = int(os.environ.get("LLM_MAX_OUTPUT_TOKENS", "128000"))
LLM_MAX_OUTPUT_TOKENS_RETRY = int(
    os.environ.get("LLM_MAX_OUTPUT_TOKENS_RETRY", "200000")
)
LLM_MAX_OUTPUT_TOKENS_RETRY2 = int(
    os.environ.get("LLM_MAX_OUTPUT_TOKENS_RETRY2", "256000")
)

# 長いOCRは1プロンプトに載せるとコンテキストで後半が切れ、2ページ目以降の明細が消える。
# layout.pages がある場合はページ単位、無い場合は文字数でチャンクして明細抽出する。
LLM_PAGED_EXTRACTION = os.environ.get("LLM_PAGED_EXTRACTION", "1") != "0"
OCR_SINGLE_CALL_MAX_CHARS = int(os.environ.get("OCR_SINGLE_CALL_MAX_CHARS", "14000"))
OCR_TEXT_CHUNK_CHARS = int(os.environ.get("OCR_TEXT_CHUNK_CHARS", "12000"))
OCR_TEXT_CHUNK_OVERLAP = int(os.environ.get("OCR_TEXT_CHUNK_OVERLAP", "1500"))
LLM_HEADER_MAX_OUTPUT_TOKENS = int(os.environ.get("LLM_HEADER_MAX_OUTPUT_TOKENS", "8192"))
LLM_PAGE_LINE_ITEMS_MAX_OUTPUT_TOKENS = int(
    os.environ.get("LLM_PAGE_LINE_ITEMS_MAX_OUTPUT_TOKENS", str(LLM_MAX_OUTPUT_TOKENS))
)


# 発注番号ルールは 1ページ目・続きページの両プロンプトで同一文字列を使う（重点の偏りを防ぐ）
_ORDER_NUMBER_RULES_MARKDOWN = """
■ 発注番号（order_number）の扱い（最重要）

発注番号は本システムにおいて最も重要な識別子であり、
各明細行に正しく付与することを最優先とする。

■ 基本形式（原則6桁だが例外あり）
原則として発注番号は6桁の数字である（例：123456）
ただし、請求書に「発注番号：123456789」のように連続した7桁以上の数字だけが明記されている場合は、無理に6桁に切らず、その数字列全体を order_number とする
■ OCR上の表記パターン

請求書上では以下のような形式で記載される場合がある：

123456/1
123456-1
123456 A
123456 山田
123456/山田
123456_789
123456-789

「_」「-」「/」などで区切られた複合表記（例：123456_789、123456-789、104502_2249）では、区切りより前の数字列を order_number とする（原則6桁がここに当てはまる）

123456/山田 のように区切りの後が数字でない場合：

先頭の数字列を order_number とし、それ以降は note に格納してよい

例：
"123456/山田" →
order_number: "123456"
note: "山田"

■ 抽出ルール（重要）
明細行またはその近傍から発注番号を最優先で検出する
英字・記号を含む場合でも、上記の区切りルール・連続桁ルールに従う
数値はカンマや空白を除去して判定する
■ 判定優先順位
明細行内に存在する発注番号
明細行に近接する位置にある発注番号
請求書全体に1つだけ存在する発注番号（全明細に適用）
■ 明細単位 vs 全体の扱い

① 請求書全体に1つだけ存在する場合

「請求書全体の発注番号」とみなす
明細行ごとの発注番号が存在しない場合は：
→ すべてのline_itemsに同じorder_numberを必ず設定する
これは補完であり欠損ではない

② 明細行ごとに発注番号が存在する場合

各行から個別に抽出する
全体の発注番号は使用しない

③ 両方存在する場合

明細行の値を優先する
■ 除外ルール（非常に重要）

以下は order_number として扱ってはならない：

金額（例：120000）
税額
日付（例：20260310）
電話番号
郵便番号
文脈上「発注番号」ではないと判断できる5桁以下の数字（単独）

※ 文脈的に金額・日付と判断されるものは除外すること
※ 連続7桁以上を除外してはならない（上記「基本形式」の例外）

■ 表記ゆれへの対応

以下のラベルを優先して発注番号を探す：

「注文番号」
「発注No」
「注文No」
「Order No」
「PO」
■ 不明な場合
条件に合致する発注番号が存在しない場合のみ null とする
推測で誤った値を設定してはならない
■ 目的（再確認）
各明細行に正しい発注番号を付与することが最優先
他の項目よりも優先して精度高く抽出すること
不完全でもよいが、誤った番号は絶対に設定しない
■ 判定ヒント
ヘッダ付近・合計付近に1つ → 全体の発注番号
明細内に複数 → 行単位
ラベル（注文番号など）付近の値を優先
「区切り付きの複合表記」は上記ルールで分解する
""".strip()

# 明細の取りこぼし対策（フルプロンプト・続きページプロンプトの両方に挿入）
_LINE_ITEMS_COMPLETENESS_MARKDOWN = """
# ■ 明細の網羅（漏れ防止・最重要）

- 請求書内の「品目・明細・数量・単価・金額」など**表のデータ行**は、**可能な限り1行も省略せず** line_items に含める。
- 数値の一部がOCRで欠けていても、**他の明細と同じ表レイアウトの行**であれば必ず1レコードを出力する（欠損は null。無理な推測はしない）。
- 品名・型番・備考が **item_name と note に分断**されていても、**視覚的に同じ明細行**なら1レコードにまとめる。
- **続きページの断片**でも、その断片に写っている**表のデータ行はすべて** line_items に出す（「前後にあるから省略」は禁止）。
- 除外するのは **合計・小計・税額・値引・請求額などの集計行**と、**列見出し（ヘッダ）行のみ**。
- 解釈に迷う行も、周囲の明細と同じ表であるなら line_items に含め、confidence を下げる。
- 表の行数と line_items の件数が大きく乖離しないよう、出力前に見直す。
""".strip()


# 適格請求書等の事業者登録番号: T + 半角数字13桁（表示上のハイフン・空白は除去）
_Z2H_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
_QUAL_REG_T_MARK = re.compile(r"[TtＴｔ]")


def _normalize_qualified_invoice_registration(v: Any) -> Optional[str]:
    """T + 半角数字13桁に正規化する。ハイフン・全角数字は吸収。"""
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    s = s.translate(_Z2H_DIGITS)
    s = s.replace("Ｔ", "T")
    m = _QUAL_REG_T_MARK.search(s)
    if not m:
        return None
    rest = s[m.end() :]
    digits = re.sub(r"[^0-9]", "", rest)
    if len(digits) < 13:
        return None
    return "T" + digits[:13]


_QUALIFIED_INVOICE_LABEL_RE = re.compile(
    r"適\s*格\s*請\s*求\s*書\s*事\s*業\s*者\s*登\s*録\s*番\s*号\s*[:：]\s*"
    r"(?P<tail>[TtＴｔ][^\n\r]{0,160})",
    re.MULTILINE,
)


def _extract_qualified_invoice_reg_from_text(blob: str) -> Optional[str]:
    """ocr_text / reasoning 等から T+13桁 を拾う（ラベル各字の間スペース・番号内スペースに対応）。"""
    if not blob or not isinstance(blob, str):
        return None
    s = blob.translate(_Z2H_DIGITS)
    s = s.replace("Ｔ", "T").replace("ｔ", "t")

    for m in _QUALIFIED_INVOICE_LABEL_RE.finditer(s):
        cand = _normalize_qualified_invoice_registration(m.group("tail"))
        if cand:
            return cand

    # 文中の各 T から十分な幅を取り、数字だけ13桁集める（T と桁の間にスペースが入るOCR向け）
    for m in re.finditer(r"[Tt]", s):
        tail = s[m.start() : m.start() + 120]
        cand = _normalize_qualified_invoice_registration(tail)
        if cand:
            return cand
    return None


def _enrich_invoice_registration_and_invoice_number(
    invoice_payload: Dict[str, Any],
    data: Dict[str, Any],
    vendor_obj: Dict[str, Any],
    *,
    source_ocr_text: Optional[str] = None,
) -> None:
    """
    登録番号を T+13桁 に揃え、invoice_number が空のときはそれで補完する。
    source_ocr_text はパイプライン上の全文 OCR（LLM の ocr_text より優先してスキャン）。
    """
    blob_parts: List[str] = []
    if source_ocr_text is not None and str(source_ocr_text).strip():
        blob_parts.append(str(source_ocr_text))
    ot = data.get("ocr_text")
    if ot is not None and str(ot).strip():
        blob_parts.append(str(ot))
    for key in ("registration_number", "invoice_number"):
        v = invoice_payload.get(key)
        if v is not None and str(v).strip():
            blob_parts.append(str(v))
    r = data.get("reasoning")
    if r is not None and str(r).strip():
        blob_parts.append(str(r))
    vn = vendor_obj.get("vendor_name") or data.get("vendor_name")
    if vn is not None and str(vn).strip():
        blob_parts.append(str(vn))
    blob = "\n".join(blob_parts)

    reg = _normalize_qualified_invoice_registration(invoice_payload.get("registration_number"))
    if not reg:
        reg = _normalize_qualified_invoice_registration(invoice_payload.get("invoice_number"))
    if not reg:
        reg = _extract_qualified_invoice_reg_from_text(blob)

    if reg:
        invoice_payload["registration_number"] = reg

    canon_inv = _normalize_qualified_invoice_registration(invoice_payload.get("invoice_number"))
    if canon_inv:
        invoice_payload["invoice_number"] = canon_inv
        if not invoice_payload.get("registration_number"):
            invoice_payload["registration_number"] = canon_inv

    inv = invoice_payload.get("invoice_number")
    if inv is None or (isinstance(inv, str) and not inv.strip()):
        if reg:
            invoice_payload["invoice_number"] = reg


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
    """
    原則6桁だが、(1) 区切り付き複合は区切り前の数字列、(2) 区切りなしの連続桁は7桁以上も切らずそのまま。
    """
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    s = s.replace(" ", "").replace("　", "")
    s = s.replace("／", "/").replace("ー", "-")

    # 123456_789 / 123456-789 / 123456/1 / 104502_2249 → 区切りより前の数字列（先頭塊が6桁以上）
    m = re.match(r"^(\d+)([_\-/])(.+)$", s)
    if m:
        head = m.group(1)
        return head if len(head) >= 6 else None

    # 数字のみの連続（7桁以上もトリムしない）
    if re.fullmatch(r"\d+", s):
        return s if len(s) >= 6 else None

    # 発注番号：123456789 など
    m = re.search(r"\d{6,}", s)
    if m:
        return m.group(0)

    return None


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
    note_s = str(item.get("note") or "").strip()
    qty = _to_number(item.get("quantity"))
    unit_price = _to_number(item.get("unit_price"))
    amount = _to_number(item.get("amount"))
    order_no = _normalize_order_number(item.get("order_number"))
    tax_v = _to_number(item.get("tax"))

    if _is_summary_line(item_name):
        return False

    label = item_name or note_s
    # 品名が空で note にだけ品目が入った行・発注番号だけ先に取れた行も落とさない
    if label and (qty is not None or amount is not None or unit_price is not None or order_no):
        return True

    # 品目ラベルがあり税額列だけ取れている表レイアウト
    if label and tax_v is not None:
        return True

    # 品名なしでも数量・金額・単価のうち2点あれば明細扱い（OCRで品名列が別ブロックのケース）
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
            "document_date": raw.get("document_date"),
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


def _layout_page_to_plain_text(page: Dict[str, Any], y_tolerance_px: int = 8) -> str:
    """Vision layout の1ページを、行推定してプレーンテキスト化する。"""
    buckets: dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for block in page.get("blocks", []):
        for para in block.get("paragraphs", []):
            for w in para.get("words", []):
                bb = w.get("boundingBox", {})
                y = int(bb.get("y_min", 0))
                key = int(round(y / max(1, y_tolerance_px)))
                buckets[key].append(w)
    lines: List[str] = []
    for key in sorted(buckets.keys()):
        words = sorted(buckets[key], key=lambda w: (w.get("boundingBox", {}).get("x_min", 0)))
        line_text = " ".join((w.get("text", "") for w in words)).strip()
        if line_text:
            lines.append(line_text)
    return "\n".join(lines)


def _page_texts_from_layout(ocr_layout: Dict[str, Any]) -> List[str]:
    pages = ocr_layout.get("pages") if isinstance(ocr_layout, dict) else None
    if not isinstance(pages, list) or not pages:
        return []
    out: List[str] = []
    for page in sorted(pages, key=lambda p: p.get("pageIndex", 0)):
        if not isinstance(page, dict):
            continue
        t = _layout_page_to_plain_text(page).strip()
        if t:
            out.append(t)
    return out


def _chunk_plain_text(text: str, size: int, overlap: int) -> List[str]:
    text = text.strip()
    if len(text) <= size:
        return [text] if text else []
    chunks: List[str] = []
    step = max(1, size - overlap)
    i = 0
    while i < len(text):
        chunks.append(text[i : i + size])
        i += step
    return chunks


def _segment_ocr_for_llm(ocr_text: str, ocr_layout: Optional[Dict[str, Any]]) -> List[str]:
    """
    LLM に渡す単位ごとの OCR 断片を返す（各断片がコンテキストに収まりやすくする）。
    """
    layout = ocr_layout if isinstance(ocr_layout, dict) else {}

    # 1) Vision のページレイアウトがあれば最優先
    from_layout = _page_texts_from_layout(layout)
    if len(from_layout) >= 2:
        return from_layout
    if len(from_layout) == 1 and len(from_layout[0]) <= OCR_SINGLE_CALL_MAX_CHARS:
        return from_layout

    # 2) フォームフィード区切り（一部PDFテキスト）
    if "\f" in ocr_text:
        parts = [p.strip() for p in ocr_text.split("\f") if p.strip()]
        if len(parts) >= 2:
            return parts

    # 3) レイアウト1ページだが極端に長い / レイアウトなしの長文
    if from_layout and len(from_layout[0]) > OCR_SINGLE_CALL_MAX_CHARS:
        return _chunk_plain_text(from_layout[0], OCR_TEXT_CHUNK_CHARS, OCR_TEXT_CHUNK_OVERLAP)

    if len(ocr_text) > OCR_SINGLE_CALL_MAX_CHARS:
        return _chunk_plain_text(ocr_text, OCR_TEXT_CHUNK_CHARS, OCR_TEXT_CHUNK_OVERLAP)

    return [ocr_text] if ocr_text.strip() else []


def _run_llm_json(prompt: str, max_output_tokens: int) -> Tuple[Dict[str, Any], str, Any]:
    """LLM を1回走らせ、dict・生出力・response を返す。"""
    response = _call_extract(prompt, max_output_tokens=max_output_tokens)

    for extra_tokens in (LLM_MAX_OUTPUT_TOKENS_RETRY, LLM_MAX_OUTPUT_TOKENS_RETRY2):
        status = getattr(response, "status", None)
        incomplete_reason = getattr(getattr(response, "incomplete_details", None), "reason", None)
        if status != "incomplete" or incomplete_reason != "max_output_tokens":
            break
        if extra_tokens <= max_output_tokens:
            continue
        response = _call_extract(prompt, max_output_tokens=extra_tokens)

    raw_text = getattr(response, "output_text", None)
    if not raw_text:
        try:
            raw_text = response.output[0].content[0].text  # type: ignore[attr-defined]
        except Exception:
            raw_text = json.dumps(_response_to_debug_dict(response), ensure_ascii=False)

    if not isinstance(raw_text, str) or not raw_text.strip():
        raise ValueError(
            f"Empty model output. debug={json.dumps(_response_to_debug_dict(response), ensure_ascii=False)}"
        )
    try:
        data = _coerce_json(raw_text)
    except json.JSONDecodeError:
        repaired = _repair_json_via_model(raw_text)
        data = _coerce_json(repaired)
    return data, raw_text, response


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

    resp = _call_extract(
        repair_prompt,
        max_output_tokens=int(os.environ.get("LLM_REPAIR_MAX_OUTPUT_TOKENS", "32000")),
    )
    text = getattr(resp, "output_text", None)
    if not text:
        try:
            text = resp.output[0].content[0].text  # type: ignore[attr-defined]
        except Exception:
            text = json.dumps(_response_to_debug_dict(resp), ensure_ascii=False)
    return str(text)


def _build_full_extraction_prompt(ocr_text: str) -> str:
    return f"""
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

{_LINE_ITEMS_COMPLETENESS_MARKDOWN}

---

{_ORDER_NUMBER_RULES_MARKDOWN}

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
      "document_date": null,
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
- 明細行に書かれた納品日/発送日/作業日/取引日（請求書ヘッダの日付とは別） → document_date（可能なら YYYY-MM-DD。難しければOCRの表記のまま文字列）
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


def _build_line_items_only_prompt(ocr_text: str, page_index: int, total_pages: int) -> str:
    return f"""
あなたは請求書OCRの「続き断片」から明細行だけを抽出するAIです。
同一請求書の {page_index} / {total_pages} 番目のOCR断片です（前後ページの文脈は別送り）。

**出力は line_items の配列だけを含むJSONオブジェクトのみ。説明禁止。**

**重要: 発注番号（order_number）のルールは 1ページ目と完全に同一である。続きページだからといって優先度を下げないこと。**

{_ORDER_NUMBER_RULES_MARKDOWN}

# この断片での追加ルール

- 明細行のみ（1行＝1レコード）。合計・税・小計・値引・請求額のような集計行は line_items に含めない。
- 列: 品名→item_name, 数量→quantity, 単位→unit, 単価→unit_price, 金額→amount, 税→tax, 発注・注文番号→order_number（上記の6桁ルールを厳守）, その他→note
- この断片にヘッダが無くても、行に書かれている発注番号は行から取る。無ければ null（推測で埋めない）
- 数値は数値型、カンマ除去、不明は null

---

{_LINE_ITEMS_COMPLETENESS_MARKDOWN}

---

# 出力JSON（厳守）

{{
  "line_items": [
    {{
      "item_name": null,
      "document_date": null,
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
  ]
}}

# OCR断片

{ocr_text}
    """.strip()


def _assemble_extracted_payload(
    data: Dict[str, Any],
    raw_text: str,
    response: Any,
    *,
    extraction_mode: str,
    source_ocr_text: Optional[str] = None,
) -> Dict[str, Any]:
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
    _enrich_invoice_registration_and_invoice_number(
        invoice_payload, data, vendor_obj, source_ocr_text=source_ocr_text
    )
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
        "ocr_text": (
            data.get("ocr_text")
            if (data.get("ocr_text") is not None and str(data.get("ocr_text")).strip())
            else source_ocr_text
        ),
        "created_at": data.get("created_at"),
        "_raw": raw_text,
        "llm_response_status": getattr(response, "status", None),
        "extraction_mode": extraction_mode,
    }
    return out


def _extract_invoice_data_single(
    ocr_text: str,
    *,
    source_ocr_for_reg: Optional[str] = None,
) -> Dict[str, Any]:
    prompt = _build_full_extraction_prompt(ocr_text)
    data, raw_text, response = _run_llm_json(prompt, LLM_MAX_OUTPUT_TOKENS)
    reg_src = source_ocr_for_reg if source_ocr_for_reg is not None else ocr_text
    return _assemble_extracted_payload(
        data,
        raw_text,
        response,
        extraction_mode="single",
        source_ocr_text=reg_src,
    )


def _extract_invoice_data_paged(segments: List[str], *, source_ocr_text: str) -> Dict[str, Any]:
    prompt0 = _build_full_extraction_prompt(segments[0])
    data0, raw0, resp0 = _run_llm_json(prompt0, LLM_PAGE_LINE_ITEMS_MAX_OUTPUT_TOKENS)

    vendor_obj = data0.get("vendor") if isinstance(data0.get("vendor"), dict) else {}
    invoice_obj = data0.get("invoice") if isinstance(data0.get("invoice"), dict) else {}
    line_items_acc: List[Dict[str, Any]] = [
        x for x in (data0.get("line_items") or []) if isinstance(x, dict)
    ]
    raw_pages: List[str] = [raw0]
    statuses: List[Any] = [getattr(resp0, "status", None)]
    counts_pre: List[int] = [len(line_items_acc)]

    total = len(segments)
    for idx, seg in enumerate(segments[1:], start=2):
        p = _build_line_items_only_prompt(seg, idx, total)
        di, raw_i, respi = _run_llm_json(p, LLM_PAGE_LINE_ITEMS_MAX_OUTPUT_TOKENS)
        extra = [x for x in (di.get("line_items") or []) if isinstance(x, dict)]
        line_items_acc.extend(extra)
        raw_pages.append(raw_i)
        statuses.append(getattr(respi, "status", None))
        counts_pre.append(len(extra))

    invoice_payload = {
        "invoice_number": invoice_obj.get("invoice_number", data0.get("invoice_number")),
        "order_number": invoice_obj.get("order_number", data0.get("order_number")),
        "date": invoice_obj.get("date", data0.get("date")),
        "payment_due_date": invoice_obj.get("payment_due_date"),
        "total_amount": invoice_obj.get("total_amount", data0.get("total_amount")),
        "tax_amount": invoice_obj.get("tax_amount"),
        "registration_number": invoice_obj.get("registration_number", data0.get("registration_number")),
    }
    _enrich_invoice_registration_and_invoice_number(
        invoice_payload, data0, vendor_obj, source_ocr_text=source_ocr_text
    )
    processed_line_items = _postprocess_line_items(line_items_acc, invoice_payload)

    out: Dict[str, Any] = {
        "invoice_id": data0.get("invoice_id"),
        "status": data0.get("status"),
        "vendor": {
            "vendor_id": vendor_obj.get("vendor_id"),
            "vendor_name": vendor_obj.get("vendor_name") or data0.get("vendor_name"),
            "confidence": vendor_obj.get("confidence", data0.get("confidence")),
        },
        "invoice": invoice_payload,
        "line_items": processed_line_items,
        "reasoning": data0.get("reasoning"),
        "confidence": data0.get("confidence", vendor_obj.get("confidence")),
        "ocr_text": (
            data0.get("ocr_text")
            if (data0.get("ocr_text") is not None and str(data0.get("ocr_text")).strip())
            else source_ocr_text
        ),
        "created_at": data0.get("created_at"),
        "_raw": raw0,
        "llm_response_status": getattr(resp0, "status", None),
        "extraction_mode": "paged",
        "line_items_raw_count_by_segment": counts_pre,
        "line_items_raw_count_total": sum(counts_pre),
        "_raw_pages": raw_pages,
        "llm_response_status_by_segment": statuses,
    }
    return out


def extract_invoice_data(ocr_text: str, ocr_layout: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    OCR テキストから請求書主要項目を抽出する。
    ocr_layout に Vision の pages がある場合はページ単位で LLM に渡し、入力コンテキスト切り捨てによる
    2ページ目以降の欠落を防ぐ。LLM_PAGED_EXTRACTION=0 で従来の一括プロンプトに戻せる。

    返り値（必ず dict）:
      - invoice_number: str|None
      - date: str|None (YYYY-MM-DD)
      - vendor_name: str|None
      - registration_number: str|None (Tから始まる)
      - total_amount: int|None
      - confidence: float (0.0-1.0)
      - reasoning: str （短い根拠。ログ/デバッグ用途）
    """
    if not LLM_PAGED_EXTRACTION:
        return _extract_invoice_data_single(ocr_text)

    segments = _segment_ocr_for_llm(ocr_text, ocr_layout)
    if len(segments) <= 1:
        fragment = segments[0] if segments else ocr_text
        return _extract_invoice_data_single(fragment, source_ocr_for_reg=ocr_text)

    return _extract_invoice_data_paged(segments, source_ocr_text=ocr_text)


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