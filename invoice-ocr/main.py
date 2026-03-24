from flask import Flask, jsonify, request, render_template_string
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from googleapiclient.errors import HttpError
from google.cloud import vision
from google.cloud import storage
from google.cloud import vision_v1 as vision_pdf
from pdfminer.high_level import extract_text
import google.auth
import io
import json
import os
import time
import traceback
import urllib.request
import urllib.error
from collections import defaultdict

# LLM 抽出（OpenAI）
ENABLE_LLM_EXTRACT = os.environ.get("ENABLE_LLM_EXTRACT", "0") == "1"
LLM_CONFIDENCE_THRESHOLD = float(os.environ.get("LLM_CONFIDENCE_THRESHOLD", "0.75"))
APP_DEBUG = os.environ.get("APP_DEBUG", "0") == "1"

app = Flask(__name__)

SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

FOLDER_ID = "1cQdDHAg8zIG7oVxE_WUoXD5tsb_Ql89U"

# Vision PDF OCR 用（GCS 経由）
GCS_BUCKET_NAME = os.environ.get("GCS_BUCKET_NAME", "")
GCS_OCR_OUTPUT_PREFIX = os.environ.get("GCS_OCR_OUTPUT_PREFIX", "vision-output")


# ----------------------------
# Drive認証（Application Default Credentials 使用）
# ----------------------------
def get_drive_service():
    creds, _ = google.auth.default(scopes=SCOPES)
    return build('drive', 'v3', credentials=creds)


# ----------------------------
# PDFダウンロード
# ----------------------------
def download_file(file_id, drive_service):
    request = drive_service.files().get_media(fileId=file_id)
    file_data = io.BytesIO()

    downloader = MediaIoBaseDownload(file_data, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()

    file_data.seek(0)
    return file_data


# ----------------------------
# デジタルPDF判定
# ----------------------------
def extract_text_if_digital(file_bytes):
    try:
        text = extract_text(io.BytesIO(file_bytes))
        if text and text.strip():
            return text
    except Exception:
        pass
    return None


# ----------------------------
# Vision OCR（スキャン用）
# ----------------------------
def vision_ocr(file_bytes):
    client = vision.ImageAnnotatorClient()

    image = vision.Image(content=file_bytes)
    response = client.document_text_detection(image=image)

    if response.error and getattr(response.error, "message", ""):
        return f"[VISION_ERROR] {response.error.message}"

    if response.full_text_annotation:
        return response.full_text_annotation.text

    return ""


# ----------------------------
# GCS upload（Vision PDF OCR 用）
# ----------------------------
def upload_pdf_to_gcs(pdf_bytes: bytes, blob_name: str) -> str:
    if not GCS_BUCKET_NAME:
        raise RuntimeError("GCS_BUCKET_NAME is not set")

    storage_client = storage.Client()
    bucket = storage_client.bucket(GCS_BUCKET_NAME)
    blob = bucket.blob(blob_name)
    blob.upload_from_string(pdf_bytes, content_type="application/pdf")
    return f"gs://{GCS_BUCKET_NAME}/{blob_name}"


# ----------------------------
# Vision PDF OCR（GCS 経由・async）
# ----------------------------
def vision_pdf_ocr_via_gcs(pdf_bytes: bytes, file_id: str) -> dict:
    if not GCS_BUCKET_NAME:
        return {"text": "[CONFIG_ERROR] GCS_BUCKET_NAME is not set", "layout": {"pages": [], "lines": []}}

    input_blob_name = f"input/{file_id}.pdf"
    gcs_source_uri = upload_pdf_to_gcs(pdf_bytes, input_blob_name)
    # 同じ file_id で繰り返し処理すると過去出力が残りやすいので、実行ごとに出力先を分ける
    run_id = str(int(time.time() * 1000))
    gcs_output_uri = f"gs://{GCS_BUCKET_NAME}/{GCS_OCR_OUTPUT_PREFIX}/{file_id}/{run_id}/"

    client = vision_pdf.ImageAnnotatorClient()

    feature = vision_pdf.Feature(type_=vision_pdf.Feature.Type.DOCUMENT_TEXT_DETECTION)
    gcs_source = vision_pdf.GcsSource(uri=gcs_source_uri)
    input_config = vision_pdf.InputConfig(
        gcs_source=gcs_source, mime_type="application/pdf"
    )

    gcs_destination = vision_pdf.GcsDestination(uri=gcs_output_uri)
    output_config = vision_pdf.OutputConfig(
        gcs_destination=gcs_destination, batch_size=1
    )

    async_request = vision_pdf.AsyncAnnotateFileRequest(
        features=[feature],
        input_config=input_config,
        output_config=output_config,
    )

    operation = client.async_batch_annotate_files(requests=[async_request])

    try:
        operation.result(timeout=300)
    except Exception as e:
        return {"text": f"[VISION_PDF_OCR_ERROR] {e}", "layout": {"pages": [], "lines": []}}

    storage_client = storage.Client()
    bucket = storage_client.bucket(GCS_BUCKET_NAME)
    prefix = f"{GCS_OCR_OUTPUT_PREFIX}/{file_id}/{run_id}/"

    texts: list[str] = []
    pages_layout: list[dict] = []
    for blob in bucket.list_blobs(prefix=prefix):
        if not blob.name.endswith(".json"):
            continue

        try:
            data = json.loads(blob.download_as_text())
        except Exception as e:
            return {"text": f"[OCR_OUTPUT_PARSE_ERROR] {e}", "layout": {"pages": [], "lines": []}}

        for resp in data.get("responses", []):
            full_text = resp.get("fullTextAnnotation", {}).get("text")
            if full_text:
                texts.append(full_text)
            pages_layout.extend(_extract_layout_from_full_text_annotation(resp.get("fullTextAnnotation", {})))

    return {
        "text": "\n".join(texts).strip(),
        "layout": {
            "pages": pages_layout,
            "lines": _group_lines_by_y(pages_layout),
        },
    }


def _normalize_bounding_box(bb: dict) -> dict:
    vertices = bb.get("vertices", []) if isinstance(bb, dict) else []
    norm_vertices = []
    xs = []
    ys = []
    for v in vertices:
        x = int(v.get("x", 0) or 0)
        y = int(v.get("y", 0) or 0)
        norm_vertices.append({"x": x, "y": y})
        xs.append(x)
        ys.append(y)
    return {
        "vertices": norm_vertices,
        "x_min": min(xs) if xs else 0,
        "y_min": min(ys) if ys else 0,
        "x_max": max(xs) if xs else 0,
        "y_max": max(ys) if ys else 0,
    }


def _word_text(word: dict) -> str:
    symbols = word.get("symbols", []) if isinstance(word, dict) else []
    return "".join((s.get("text", "") for s in symbols if isinstance(s, dict))).strip()


def _extract_layout_from_full_text_annotation(full: dict) -> list[dict]:
    pages = full.get("pages", []) if isinstance(full, dict) else []
    out_pages: list[dict] = []
    for p_idx, page in enumerate(pages):
        blocks = page.get("blocks", []) if isinstance(page, dict) else []
        out_blocks = []
        for b_idx, block in enumerate(blocks):
            paragraphs = block.get("paragraphs", []) if isinstance(block, dict) else []
            out_paragraphs = []
            for para in paragraphs:
                words = para.get("words", []) if isinstance(para, dict) else []
                out_words = []
                for word in words:
                    text = _word_text(word)
                    if not text:
                        continue
                    out_words.append(
                        {
                            "text": text,
                            "boundingBox": _normalize_bounding_box(word.get("boundingBox", {})),
                        }
                    )
                out_paragraphs.append(
                    {
                        "boundingBox": _normalize_bounding_box(para.get("boundingBox", {})),
                        "words": out_words,
                    }
                )
            out_blocks.append(
                {
                    "blockIndex": b_idx,
                    "boundingBox": _normalize_bounding_box(block.get("boundingBox", {})),
                    "paragraphs": out_paragraphs,
                }
            )
        out_pages.append(
            {
                "pageIndex": p_idx,
                "width": page.get("width"),
                "height": page.get("height"),
                "blocks": out_blocks,
            }
        )
    return out_pages


def _group_lines_by_y(pages_layout: list[dict], y_tolerance_px: int = 8) -> list[dict]:
    """
    同じ高さのテキストを1行としてグルーピングする簡易ロジック。
    """
    grouped_lines: list[dict] = []
    for page in pages_layout:
        page_idx = page.get("pageIndex", 0)
        buckets: dict[int, list[dict]] = defaultdict(list)
        for block in page.get("blocks", []):
            for para in block.get("paragraphs", []):
                for w in para.get("words", []):
                    bb = w.get("boundingBox", {})
                    y = int(bb.get("y_min", 0))
                    key = int(round(y / max(1, y_tolerance_px)))
                    buckets[key].append(w)

        for key in sorted(buckets.keys()):
            words = buckets[key]
            words = sorted(words, key=lambda w: (w.get("boundingBox", {}).get("x_min", 0)))
            line_text = " ".join((w.get("text", "") for w in words)).strip()
            line_bb = {
                "x_min": min((w.get("boundingBox", {}).get("x_min", 0) for w in words), default=0),
                "y_min": min((w.get("boundingBox", {}).get("y_min", 0) for w in words), default=0),
                "x_max": max((w.get("boundingBox", {}).get("x_max", 0) for w in words), default=0),
                "y_max": max((w.get("boundingBox", {}).get("y_max", 0) for w in words), default=0),
            }
            grouped_lines.append(
                {
                    "pageIndex": page_idx,
                    "lineKey": key,
                    "text": line_text,
                    "boundingBox": line_bb,
                    "words": words,
                }
            )
    return grouped_lines


# ----------------------------
# OCRメイン処理（自動判定）
# ----------------------------
def ocr_pdf(file_id):

    drive_service = get_drive_service()
    file_data = download_file(file_id, drive_service)

    file_bytes = file_data.read()

    # ① まずデジタルPDFとしてテキスト抽出を試す
    text = extract_text_if_digital(file_bytes)
    if text:
        return {
            "method": "digital_pdf_text_extract",
            "text": text,
            "layout": {"pages": [], "lines": []},
        }

    # ② ダメなら Vision の PDF OCR（GCS 経由）
    ocr = vision_pdf_ocr_via_gcs(file_bytes, file_id)
    return {
        "method": "vision_pdf_ocr_via_gcs",
        "text": ocr.get("text", ""),
        "layout": ocr.get("layout", {"pages": [], "lines": []}),
    }


# ----------------------------
# フォルダ内PDF取得
# ----------------------------
def get_drive_files():
    drive_service = get_drive_service()

    query = (
        f"'{FOLDER_ID}' in parents and "
        "mimeType='application/pdf' and "
        "trashed=false"
    )

    try:
        results = drive_service.files().list(
            q=query,
            pageSize=10,
            fields="files(id, name, mimeType, parents, modifiedTime)",
            orderBy="modifiedTime desc",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        return results.get("files", [])
    except HttpError as e:
        # 呼び出し失敗のときに原因が見えるよう、例外内容を呼び出し元で扱える形式にする
        return [{"error": "drive_list_failed", "details": str(e)}]


@app.errorhandler(Exception)
def handle_unexpected_error(e):
    """
    Cloud Run で HTML の 500 ページが返るとブラウザ側が Quirks Mode 警告を出しがちなので、
    例外時も JSON で返す。スタックトレースは APP_DEBUG=1 のときのみレスポンスに含める。
    """
    app.logger.exception("Unhandled exception: %s", e)
    payload = {"error": "internal_server_error", "message": str(e)}
    if APP_DEBUG:
        payload["traceback"] = traceback.format_exc()
    return jsonify(payload), 500


# ----------------------------
# APIエンドポイント
# ----------------------------
def build_invoice_response():
    t0 = time.time()
    files = get_drive_files()
    t_files = time.time()

    if not files:
        return {"message": "No PDF found"}, 200

    if isinstance(files, list) and files and isinstance(files[0], dict) and files[0].get("error"):
        # Drive API 自体が失敗している
        return {"message": "Drive API error", "debug": files[0]}, 500

    # 明示指定があればそれを優先（デバッグ/検証用）
    requested_file_id = request.args.get("file_id")
    chosen = None
    if requested_file_id:
        chosen = next((f for f in files if f.get("id") == requested_file_id), None)
        if not chosen:
            return {
                "message": "Requested file_id not found in folder listing",
                "requested_file_id": requested_file_id,
                "available_files": files,
            }, 404
    else:
        chosen = files[0]

    file_id = chosen["id"]

    ocr_result = ocr_pdf(file_id)
    t_ocr = time.time()

    resp = {
        "file_id": file_id,
        "file_name": chosen.get("name"),
        "file_modifiedTime": chosen.get("modifiedTime"),
        "method_used": ocr_result["method"],
        "ocr_text": ocr_result["text"],
        "ocr_layout": ocr_result.get("layout", {"pages": [], "lines": []}),
        "timing_ms": {
            "drive_list": int((t_files - t0) * 1000),
            "ocr_total": int((t_ocr - t_files) * 1000),
            "total": int((time.time() - t0) * 1000),
        },
    }

    # オプション: LLMで項目抽出（コスト検証用に環境変数で制御）
    if ENABLE_LLM_EXTRACT and isinstance(ocr_result.get("text"), str) and ocr_result["text"].strip():
        try:
            from open_ai import extract_invoice_data

            t_llm0 = time.time()
            extracted = extract_invoice_data(ocr_result["text"])
            resp["timing_ms"]["llm_total"] = int((time.time() - t_llm0) * 1000)
            confidence = extracted.get("confidence")
            resp["llm_extraction"] = extracted
            resp["llm_extraction_accepted"] = (
                isinstance(confidence, (int, float)) and float(confidence) >= LLM_CONFIDENCE_THRESHOLD
            )
            resp["llm_confidence_threshold"] = LLM_CONFIDENCE_THRESHOLD
        except Exception as e:
            app.logger.exception("LLM extraction failed: %s", e)
            resp["llm_extraction_error"] = str(e)
            if APP_DEBUG:
                resp["llm_extraction_traceback"] = traceback.format_exc()

    return resp, 200


@app.route("/")
def index():
    resp, status = build_invoice_response()
    return jsonify(resp), status


@app.route("/view")
def view():
    """
    抽出結果の人間向け表示（ブラウザ確認用）。
    / と同じ処理を実行して、ヘッダ情報 + 明細テーブルで表示する。
    """
    resp, status = build_invoice_response()
    if status != 200:
        return jsonify(resp), status

    llm = resp.get("llm_extraction") or {}
    llm_error = resp.get("llm_extraction_error")

    # スキーマ差分に対応:
    # - 新: {vendor:{...}, invoice:{...}, line_items:[...]}
    # - 旧: {vendor_name, invoice_number, ...}
    vendor = llm.get("vendor") or {}
    invoice = llm.get("invoice") or {}
    line_items = llm.get("line_items") or []

    if not vendor and "vendor_name" in llm:
        vendor = {
            "vendor_name": llm.get("vendor_name"),
            "confidence": llm.get("confidence"),
        }
    if not invoice and any(k in llm for k in ["invoice_number", "date", "total_amount"]):
        invoice = {
            "invoice_number": llm.get("invoice_number"),
            "order_number": llm.get("order_number"),
            "date": llm.get("date"),
            "payment_due_date": llm.get("payment_due_date"),
            "total_amount": llm.get("total_amount"),
            "tax_amount": llm.get("tax_amount"),
        }

    html = """
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invoice OCR Viewer</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; color: #222; }
    h1, h2 { margin: 8px 0; }
    .meta { margin-bottom: 14px; padding: 10px; background: #f6f8fa; border-radius: 8px; }
    .row { margin: 4px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #ddd; padding: 6px; text-align: left; vertical-align: top; }
    th { background: #f2f2f2; position: sticky; top: 0; }
    .mono { font-family: Consolas, monospace; }
    .ok { color: #137333; font-weight: bold; }
    .ng { color: #a50e0e; font-weight: bold; }
    .small { color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Invoice OCR Result</h1>
  {% if llm_error %}
  <div class="meta" style="background:#fdecea; border:1px solid #f5c2c7;">
    <div class="row"><b>llm_extraction_error:</b> {{ llm_error }}</div>
  </div>
  {% endif %}
  <div class="meta">
    <div class="row"><b>file_id:</b> <span class="mono">{{ resp.file_id }}</span></div>
    <div class="row"><b>file_name:</b> {{ resp.file_name }}</div>
    <div class="row"><b>modified:</b> {{ resp.file_modifiedTime }}</div>
    <div class="row"><b>ocr_method:</b> {{ resp.method_used }}</div>
    <div class="row"><b>LLM accepted:</b>
      {% if resp.llm_extraction_accepted %}
        <span class="ok">true</span>
      {% else %}
        <span class="ng">false</span>
      {% endif %}
      <span class="small">(threshold={{ resp.llm_confidence_threshold }})</span>
    </div>
  </div>

  <h2>Invoice Header</h2>
  <div class="meta">
    <div class="row"><b>vendor_name:</b> {{ vendor.vendor_name }}</div>
    <div class="row"><b>vendor_confidence:</b> {{ vendor.confidence }}</div>
    <div class="row"><b>invoice_number:</b> {{ invoice.invoice_number }}</div>
    <div class="row"><b>order_number:</b> {{ invoice.order_number }}</div>
    <div class="row"><b>date:</b> {{ invoice.date }}</div>
    <div class="row"><b>payment_due_date:</b> {{ invoice.payment_due_date }}</div>
    <div class="row"><b>total_amount:</b> {{ invoice.total_amount }}</div>
    <div class="row"><b>tax_amount:</b> {{ invoice.tax_amount }}</div>
  </div>

  <h2>Line Items ({{ line_items|length }})</h2>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>item_name</th>
        <th>order_number</th>
        <th>quantity</th>
        <th>unit</th>
        <th>unit_price</th>
        <th>amount</th>
        <th>tax</th>
        <th>note</th>
        <th>confidence</th>
        <th>status</th>
      </tr>
    </thead>
    <tbody>
      {% for item in line_items %}
      <tr>
        <td>{{ loop.index }}</td>
        <td>{{ item.item_name }}</td>
        <td>{{ item.order_number }}</td>
        <td>{{ item.quantity }}</td>
        <td>{{ item.unit }}</td>
        <td>{{ item.unit_price }}</td>
        <td>{{ item.amount }}</td>
        <td>{{ item.tax }}</td>
        <td>{{ item.note }}</td>
        <td>{{ item.confidence }}</td>
        <td>{{ item.status }}</td>
      </tr>
      {% endfor %}
    </tbody>
  </table>

  <h2>Reasoning</h2>
  <div class="meta">{{ llm.reasoning }}</div>

  <h2>LLM Raw (debug)</h2>
  <div class="meta mono" style="white-space: pre-wrap;">{{ llm._raw }}</div>
</body>
</html>
"""
    return render_template_string(
        html,
        resp=resp,
        vendor=vendor,
        invoice=invoice,
        line_items=line_items,
        llm=llm,
        llm_error=llm_error,
    )


@app.route("/debug")
def debug():
    """
    Cloud Run 上でサービスアカウントから Drive が見えているか切り分ける。
    - FOLDER_ID にアクセスできるか（files.get）
    - FOLDER_ID 配下の子要素が取れるか（files.list）
    """
    # Drive と同じ ADC から「実際に使われた認証情報」を可視化
    creds, project_id = google.auth.default(scopes=SCOPES)
    drive_service = build("drive", "v3", credentials=creds)

    # Cloud Run 実行中のサービスアカウント email をメタデータサーバから取得
    runtime_sa_email = None
    try:
        req = urllib.request.Request(
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
            headers={"Metadata-Flavor": "Google"},
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            runtime_sa_email = resp.read().decode("utf-8")
    except Exception:
        runtime_sa_email = None

    out = {
        "adc_project_id": project_id,
        "adc_credential_type": type(creds).__name__,
        "adc_service_account_email": getattr(creds, "service_account_email", None),
        "runtime_service_account_email": runtime_sa_email,
        "folder_id": FOLDER_ID,
        "folder_get": None,
        "children_list": None,
        "notes": [
            "folder_get が 404/403 なら、サービスアカウントがそのフォルダにアクセスできていません（共有が必要）",
            "children_list が空なら、フォルダ内にファイルが無い/条件に合うファイルが無い可能性があります",
            "adc_service_account_email が期待値と違う場合、Cloud Run のサービスアカウント設定が別のものになっています",
            "runtime_service_account_email が Cloud Run の実行サービスアカウントです。これを Drive 側で共有してください",
        ],
    }

    try:
        out["folder_get"] = drive_service.files().get(
            fileId=FOLDER_ID,
            fields="id,name,mimeType,parents,driveId",
            supportsAllDrives=True,
        ).execute()
    except HttpError as e:
        out["folder_get"] = {"error": "folder_get_failed", "details": str(e)}

    try:
        out["children_list"] = drive_service.files().list(
            q=f"'{FOLDER_ID}' in parents and trashed=false",
            pageSize=20,
            fields="files(id,name,mimeType,parents)",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
    except HttpError as e:
        out["children_list"] = {"error": "children_list_failed", "details": str(e)}

    # jsonify が Bytes を扱えないので念のため整形
    return app.response_class(
        response=json.dumps(out, ensure_ascii=False),
        status=200,
        mimetype="application/json",
    )


# Cloud Run用
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)