"""
LIFFアプリからのAPIリクエストを処理するBlueprint
"""
from flask import Blueprint, request, abort, jsonify, g, current_app, Response
from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
import os
import sys
import csv
import io

# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if project_root not in sys.path:
    sys.path.insert(0, project_root)
from datetime import datetime, timezone, timedelta
from app_core.utils import get_user_info_by_line_id, get_calendar_statuses, get_all_category_b_labels, update_category_b_statuses, create_new_category_b, reactivate_category_b, check_unmapped_jobcan_employees, create_employee_mapping, calculate_monthly_period
from app_core.utils import send_push_message, activate_download_link
# from app_core.utils import send_quick_report_email # 【実装保留】のためコメントアウト
from app_core.config import COLLECTION_DAILY_REPORTS, COLLECTION_JOBCAN_RAW_RESPONSES
from functools import wraps
from flask_cors import CORS

# --- Blueprintの作成 ---
api_bp = Blueprint('api', __name__)
CORS(api_bp)

# --- クライアントと定数の初期化 ---
db = firestore.Client()
import jwt
LINE_LOGIN_CHANNEL_ID = os.environ.get("LINE_LOGIN_CHANNEL_ID")
LINE_JWKS_URL = "https://api.line.me/oauth2/v2.1/certs"

# --- 認証ヘルパー関数 & デコレータ ---

def verify_line_id_token(id_token: str) -> dict:
    """JWKSを使用してLINEのIDトークンを検証し、デコードされたペイロードを返す。"""
    try:
        jwks_client = jwt.PyJWKClient(LINE_JWKS_URL)
        signing_key = jwks_client.get_signing_key_from_jwt(id_token)
        decoded_payload = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["ES256"],
            audience=LINE_LOGIN_CHANNEL_ID,
        )
        return decoded_payload
    except jwt.ExpiredSignatureError:
        abort(401, "トークンの有効期限が切れています。再度ログインしてください。")
    except jwt.InvalidAudienceError:
        abort(401, "トークンのオーディエンスが無効です。")
    except jwt.InvalidTokenError as e:
        abort(401, f"無効なトークンです: {e}")
    except jwt.PyJWTError as e:
        # abort(401)を投げることで、Flaskのエラーハンドラが適切なレスポンスを返す
        abort(401, f"IDトークンの検証に失敗しました: {e}")
    except Exception as e:
        # 予期せぬエラーは500として処理
        abort(500, f"An unexpected error occurred during token verification: {e}")

def token_required(f):
    """LINE IDトークンを検証するデコレータ"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            abort(401, "Authorization header is missing or invalid.")
        
        try:
            id_token = auth_header.split(" ")[1]
            payload = verify_line_id_token(id_token)
            # gはリクエスト内でデータを共有するためのFlaskのグローバルオブジェクト
            g.line_user_id = payload["sub"]
        except (ValueError, IndexError, KeyError):
            abort(401, "ID token is invalid.")
        return f(*args, **kwargs)
    return decorated_function

def manager_required(f):
    """
    ユーザーが管理者権限を持っていることを要求するデコレータ。
    @token_required の後に使用する必要がある。
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not hasattr(g, 'line_user_id'):
            abort(401, "Authentication token is required before checking manager status.")
        
        try:
            user_info = get_user_info_by_line_id(g.line_user_id)
            if not user_info.get('is_manager'):
                abort(403, "Administrator privileges are required for this operation.")
            
            # ユーザー情報をgオブジェクトに格納して後続処理で利用可能にする
            g.user_info = user_info

        except Exception as e:
            # get_user_info_by_line_id が abort を送出する可能性がある
            if hasattr(e, 'code'):
                abort(e.code, e.description)
            abort(500, "An error occurred while verifying user permissions.")
            
        return f(*args, **kwargs)
    return decorated_function

def scheduler_token_required(f):
    """Cloud Schedulerからのリクエストを認証するデコレータ"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Cloud Schedulerからのリクエストには、このヘッダーが含まれる
        # ローカルでのテスト用に、ヘッダーがない場合も許容する（環境変数で制御）
        if os.environ.get("FLASK_ENV") != "development" and not request.headers.get("X-CloudScheduler"):
             abort(403, "Forbidden: Not a Cloud Scheduler request.")

        auth_header = request.headers.get("Authorization")
        scheduler_token = os.environ.get('SCHEDULER_TOKEN')
        if not scheduler_token:
            current_app.logger.critical("SCHEDULER_TOKEN environment variable is not set!")
            abort(500, "Server configuration error: Scheduler token is not set.")

        expected_token = f"Bearer {scheduler_token}"
        if not auth_header or auth_header != expected_token:
            current_app.logger.error(f"Scheduler authentication failed. Received: '{auth_header}', Expected: '{expected_token}'")
            abort(401, "Unauthorized: Invalid scheduler token.")
        return f(*args, **kwargs)
    return decorated_function
# --- APIエンドポイント定義 ---

@api_bp.route("/verify-employee", methods=["POST"])
@token_required
def verify_employee():
    """LIFFアプリから送られた社員IDを検証し、名前を返すエンドポイント"""
    data = request.get_json()
    if not data or "employeeId" not in data:
        abort(400, "Request body must contain 'employeeId'.")
    employee_id = data["employeeId"]

    mapping_ref = db.collection("employee_mappings").document(employee_id)
    mapping_doc = mapping_ref.get()

    if not mapping_doc.exists:
        abort(404, f"社員ID「{employee_id}」は見つかりませんでした。")

    mapping_data = mapping_doc.to_dict()
    name = mapping_data.get("name", "名前未登録")
    return jsonify({"status": "found", "name": name, "employeeId": employee_id}), 200

@api_bp.route("/register", methods=["POST"])
@token_required
def register_from_liff():
    """LIFFアプリから社員ID登録を受け付けるエンドポイント"""
    user_id = g.line_user_id
    data = request.get_json()
    if not data or "employeeId" not in data:
        abort(400, "Request body must contain 'employeeId'.")
    
    employee_id = data["employeeId"]
    if not isinstance(employee_id, str) or not employee_id.isdigit():
        abort(400, "'employeeId' must be a string containing only digits.")

    # 1. 登録しようとしている社員IDがemployee_mappingsに存在するか確認
    mapping_ref = db.collection("employee_mappings").document(employee_id)
    mapping_doc = mapping_ref.get()
    if not mapping_doc.exists:
        abort(404, f"社員ID「{employee_id}」はシステムに登録されていません。")
    
    mapping_data = mapping_doc.to_dict()
    jobcan_employee_id = mapping_data.get("jobcan_employee_id")
    is_manager = mapping_data.get("is_manager", False)
    mail = mapping_data.get("mail") # mailフィールドも取得

    # Jobcanからメイングループを取得して保存する
    main_group_id = None
    if jobcan_employee_id:
        try:
            from services.jobcan_service import JobcanService
            app_env = os.environ.get("APP_ENV", "development")
            is_sandbox = app_env != "production"
            jobcan_service = JobcanService(sandbox=is_sandbox)
            employee_details = jobcan_service.get_employee_details(employee_code=jobcan_employee_id)
            if employee_details:
                main_group_id = employee_details.get("main_group")
        except Exception as e:
            current_app.logger.warning(f"Failed to fetch main_group during registration: {e}")

    # 2. このLINEアカウントが既に他の社員IDに紐付いていないか確認
    users_ref = db.collection("users")
    query = users_ref.where(filter=FieldFilter("line_user_id", "==", user_id)).limit(1)
    docs = list(query.stream())
    if docs:
        existing_doc = docs[0]
        linked_company_id = existing_doc.id
        if linked_company_id != employee_id:
            abort(409, f"このLINEアカウントは既に別の社員ID（{linked_company_id}）に紐付いています。")

    # 3. usersコレクションにデータを書き込む
    user_ref = users_ref.document(employee_id)
    user_doc = user_ref.get()

    user_data_to_set = {
        "jobcan_employee_id": jobcan_employee_id,
        "line_user_id": user_id,
        "is_manager": is_manager,
        "mail": mail, # mailフィールドを保存
        "main_group": main_group_id, # メイングループIDを保存
        "updated_at": firestore.SERVER_TIMESTAMP
    }

    if not user_doc.exists:
        user_data_to_set["created_at"] = firestore.SERVER_TIMESTAMP
        user_ref.set(user_data_to_set)
        action = "created"
    else:
        user_ref.update(user_data_to_set)
        action = "updated"

    return jsonify({"status": action, "employeeId": employee_id}), 200


@api_bp.route("/reports", methods=["POST"])
@token_required
def post_report():
    """LIFFアプリから業務報告を受け取り、Firestoreに保存するエンドポイント"""
    user_id = g.line_user_id

    report_data = request.get_json()
    if not report_data:
        abort(400, "Request body is missing or not a valid JSON.")

    date = report_data.get("date")
    work_time = report_data.get("taskTotalMinutes") # フロントエンドのキー名 'taskTotalMinutes' に合わせる
    jobcan_work_minutes = report_data.get("jobcanWorkMinutes") # 勤務時間を取得
    tasks = report_data.get("tasks") # tasks配列を受け取る

    # work_timeは0の場合があるため、Noneでないことをチェックする
    if not date or work_time is None or jobcan_work_minutes is None:
        abort(400, "Invalid request body. 'date', 'taskTotalMinutes', and 'jobcanWorkMinutes' are required.")
    
    # tasksは必須だが、工数合計が0の場合は空のリストを許容する
    if tasks is None or (work_time > 0 and not tasks):
        abort(400, "Invalid request body. 'tasks' is required when 'taskTotalMinutes' is greater than 0.")

    # tasks配列を整形して1つの文字列にする。
    report_content_lines = [
        f"【{task.get('time', 0)}分】{task.get('categoryA_label', '')} - {task.get('categoryB_label', '')}"
        for task in (tasks or [])
    ]
    report_content = "\n".join(report_content_lines)

    # work_timeを数値に変換
    work_time_minutes = int(work_time) if str(work_time).isdigit() else 0

    # 【修正】date文字列をdatetimeオブジェクトに変換
    date_obj = datetime.strptime(date, '%Y-%m-%d')

    # 共通関数を使ってユーザー情報を取得（部署名も含まれる）
    user_info = get_user_info_by_line_id(user_id)
    company_employee_id = user_info["company_employee_id"]
    
    # --- 代理報告機能のための準備 ---
    # 現状は本人報告なので、報告対象者と入力者は同一人物
    target_employee_id = company_employee_id
    target_employee_name = user_info.get("name")
    inputter_id = company_employee_id
    inputter_name = user_info.get("name")
    is_proxy = False
    # 将来、代理報告機能を実装する際は、リクエストから報告対象者のIDを受け取り、
    # target_employee_id と target_employee_name を上書きする

    # daily_summaryのドキュメントIDは「会社発行社員ID_日付」
    doc_id = f"{target_employee_id}_{date}"

    try:
        doc_ref = db.collection(COLLECTION_DAILY_REPORTS).document(doc_id) # ドキュメントIDは文字列のまま
        doc_ref.set({
            # --- 集計用に追加するフィールド ---
            "employee_name": target_employee_name, # 報告対象者
            "inputter_id": inputter_id,            # 入力者の社員ID
            "inputter_name": inputter_name,        # 入力者名
            "is_proxy_report": is_proxy,           # 代理報告フラグ
            "group_id": user_info.get("main_group_id"), # グループID
            "group_name": user_info.get("main_group_name"), # グループ名
            "report_year": date_obj.year,
            "report_month": date_obj.month,
            # jobcan_work_minutes は、工数入力画面で「更新」を押した際に取得した値を
            # フロントエンドから送信してもらうか、このAPI内で再度取得する必要がある。
            # フロントエンドから送信された値を使用する
            "jobcan_work_minutes": int(jobcan_work_minutes),
            # --- 既存のフィールド ---
            "date": date_obj, # 【修正】Timestamp型で保存
            "company_employee_id": target_employee_id,
            "task_total_minutes": work_time_minutes, # フィールド名を work_time から task_total_minutes に変更
            "tasks": tasks, # tasks配列をそのまま保存
            "report_content": report_content, # 従来の文字列形式も互換性のために残す
            "report_updated_at": firestore.SERVER_TIMESTAMP
        })
    except Exception as e:
        # app.logger.error(f"Error updating Firestore: {e}") # loggerはappコンテキストが必要
        print(f"Error updating Firestore: {e}")
        abort(500, "Failed to save report.")

    return jsonify({"status": "success"}), 200

@api_bp.route("/report-details", methods=["GET"])
@token_required
def get_report_details():
    """指定された日付の工数報告詳細を取得するエンドポイント"""
    user_id = g.line_user_id
    target_date = request.args.get("date")

    if not target_date:
        abort(400, "Query parameter 'date' is required.")

    # ユーザー情報を取得
    user_info = get_user_info_by_line_id(user_id)
    company_employee_id = user_info["company_employee_id"]

    # ドキュメントIDを構築してFirestoreからデータを取得
    doc_id = f"{company_employee_id}_{target_date}"
    doc_ref = db.collection(COLLECTION_DAILY_REPORTS).document(doc_id)
    doc = doc_ref.get()

    if doc.exists:
        # ドキュメントが存在すれば、その内容を返す
        return jsonify({**doc.to_dict(), "date": doc.to_dict()["date"].strftime('%Y-%m-%d')}), 200 # 【修正】Timestampを文字列に変換
    else:
        # 存在しなければ、空のタスクリストを返す
        return jsonify({"tasks": []}), 200

@api_bp.route("/user", methods=["GET"])
@token_required
def get_user_info():
    """
    現在のLINEユーザーに紐づく社員情報を返すエンドポイント。
    フロントエンドが報告者名を表示するために使用する。
    """
    # g.user_infoに依存せず、常にDBから最新の情報を取得する
    user_id = g.line_user_id
    user_info = get_user_info_by_line_id(user_id)

    # main_group が未設定の場合、Jobcanから取得して補完する
    if user_info.get("main_group_id") is None and user_info.get("jobcan_employee_id"):
        try:
            from services.jobcan_service import JobcanService
            app_env = os.environ.get("APP_ENV", "development")
            is_sandbox = app_env != "production"
            jobcan_service = JobcanService(sandbox=is_sandbox)
            
            employee_details = jobcan_service.get_employee_details(employee_code=user_info["jobcan_employee_id"])
            latest_group_id = employee_details.get("main_group") if employee_details else None
            
            if latest_group_id is not None:
                # Firestoreを更新
                db.collection("users").document(user_info["company_employee_id"]).update({
                    "main_group": latest_group_id,
                    "updated_at": firestore.SERVER_TIMESTAMP
                })
                # レスポンス用の辞書も更新
                user_info["main_group_id"] = latest_group_id
                
                # グループ名も取得して更新（表示用）
                group_doc = db.collection("group_mappings").document(str(latest_group_id)).get()
                if group_doc.exists:
                    user_info["main_group_name"] = group_doc.to_dict().get("name")
                    
        except Exception as e:
            current_app.logger.warning(f"Failed to fetch main_group from Jobcan in /user: {e}")

    # get_user_info_by_line_id はユーザーが見つからない場合にabort(404)を発生させるため、
    # ここでの追加のチェックは不要。

    # フロントエンドが期待するキー名 'employeeId' に変換して返す
    # ユーザーが見つからない場合は、get_user_info_by_line_idがabortするため、このコードには到達しない
    return jsonify({
        "employeeId": user_info.get("company_employee_id"),
        "name": user_info.get("name"),
        "is_manager": user_info.get("is_manager", False),
        "main_group_name": user_info.get("main_group_name"), # 表示名を返す
        "main_group": user_info.get("main_group_id") # グループIDを返す
    }), 200

@api_bp.route("/work-time", methods=["GET"])
@token_required
def get_work_time():
    """
    指定された日付の勤務時間をJobcanから取得して返すエンドポイント。
    管理者は employee_id クエリを指定することで他従業員の情報を取得可能。
    """
    user_id = g.line_user_id
    target_date = request.args.get("date")
    target_employee_id = request.args.get("employee_id") # 管理者用パラメータ
    source = request.args.get("source", "report") # デフォルトは 'report'
    # フロントエンドから待機時間を指定するためのパラメータ
    try:
        wait_param = float(request.args.get("wait", "0"))
    except (ValueError, TypeError):
        wait_param = 0.0

    if not target_date:
        abort(400, "Query parameter 'date' is required.")

    # 1. ユーザー情報と、対象となるjobcan_employee_idを取得
    user_info = get_user_info_by_line_id(user_id)
    jobcan_employee_id = None

    # 管理者が他従業員の情報を取得する場合
    if target_employee_id:
        if not user_info.get('is_manager'):
            abort(403, "Administrator privileges are required to specify an employee_id.")
        
        # 指定された company_employee_id から jobcan_employee_id を取得
        mapping_ref = db.collection("employee_mappings").document(target_employee_id)
        mapping_doc = mapping_ref.get()
        if not mapping_doc.exists:
            current_app.logger.warning(f"Work time requested for non-existent employee mapping: {target_employee_id}")
            return jsonify({"date": target_date, "workTime": 0}), 200
        jobcan_employee_id = mapping_doc.to_dict().get("jobcan_employee_id")
    else:
        # 一般ユーザーが自身の情報を取得する場合
        jobcan_employee_id = user_info.get("jobcan_employee_id")

    # Jobcan IDがない場合は0を返す
    if not jobcan_employee_id:
        return jsonify({"date": target_date, "workTime": 0}), 200

    # 当日かどうかを判定 (JST基準)
    today_str = (datetime.now(timezone(timedelta(hours=9)))).strftime('%Y-%m-%d')

    # 2. JobcanServiceを使って勤務サマリーを取得
    try:
        # config.pyへの依存をなくすため、services.jobcan_serviceは関数内でimportする
        from services.jobcan_service import JobcanService

        # 実行環境に応じてサンドボックスフラグを設定
        # Cloud Runの環境変数 APP_ENV が 'production' の場合は本番用、それ以外はサンドボックス用を使用
        app_env = os.environ.get("APP_ENV", "development")
        is_sandbox = app_env != "production"

        jobcan_service = JobcanService(
            db=db,
            sandbox=is_sandbox, # JobcanServiceがこのフラグを元に認証情報とURLを決定する
            raw_responses_collection=COLLECTION_JOBCAN_RAW_RESPONSES
        )

        work_minutes = 0
        # 当日の場合は打刻情報から計算するメソッドを呼び出す
        if target_date == today_str:
            # 呼び出し元に応じて待機時間を設定
            # waitパラメータが指定されていればそれを優先する
            if wait_param > 0:
                wait_seconds = wait_param
            else:
                wait_seconds = 2.0 if source == 'report' else 0

            current_app.logger.info(
                f"Fetching real-time work time for today ({target_date}) from '{source}'. Wait: {wait_seconds}s"
            )
            work_minutes = jobcan_service.calculate_work_time_from_adits(employee_id=jobcan_employee_id, date=target_date, wait_seconds=wait_seconds)
        else:
            # 当日以外は従来通りサマリーAPIを呼び出す
            current_app.logger.info(f"Fetching summarized work time for {target_date}")
            response_data = jobcan_service.get_daily_summaries(employee_id=jobcan_employee_id, dates=[target_date])
            if response_data and response_data.get("daily_summaries"):
                summary = response_data["daily_summaries"][0]
                work_minutes = summary.get("work", 0)
        
        return jsonify({"date": target_date, "workTime": work_minutes}), 200
    except Exception as e:
        print(f"Error getting work time from Jobcan: {e}")
        abort(500, "Failed to get work time from Jobcan.")

@api_bp.route("/calendar-statuses", methods=["GET"])
@token_required
def get_calendar_status_for_month():
    """
    指定された年月（または現在）の勤務状況ステータスを返すエンドポイント。
    フロントエンドがカレンダーの表示を更新するために使用する。
    """
    user_id = g.line_user_id
    # クエリパラメータから 'start_date' と 'end_date' を取得
    start_date_str = request.args.get("start_date")
    end_date_str = request.args.get("end_date")

    if not start_date_str or not end_date_str:
        abort(400, "Query parameters 'start_date' and 'end_date' are required.")

    # 【デバッグ】エンドポイントが呼び出されたことをログに出力
    current_app.logger.info(f"[/api/calendar-statuses] endpoint called with start: {start_date_str}, end: {end_date_str}")

    # ユーザー情報を取得
    user_info = get_user_info_by_line_id(user_id)
    jobcan_employee_id = user_info.get("jobcan_employee_id")
    company_employee_id = user_info.get("company_employee_id")

    # 指定された期間の日付リストを生成
    try:
        start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
        end_date = datetime.strptime(end_date_str, '%Y-%m-%d')
        if start_date > end_date:
            abort(400, "'start_date' must be before or the same as 'end_date'.")
        dates_in_month = [(start_date + timedelta(days=i)).strftime('%Y-%m-%d') for i in range((end_date - start_date).days + 1)]
    except ValueError:
        abort(400, "Invalid date format. Please use YYYY-MM-DD.")

    statuses = get_calendar_statuses(jobcan_employee_id, company_employee_id, dates_in_month)
    return jsonify(statuses), 200

@api_bp.route("/manager/categories/b", methods=["GET"])
@token_required
def get_manager_category_b():
    """
    管理者向けに、category_bの一覧（詳細情報含む）を返すエンドポイント。
    """
    kind = request.args.get("kind")
    if not kind:
        abort(400, "Query parameter 'kind' is required.")

    # 'kind'の値が想定通りかバリデーション
    if kind not in ["engineering", "net"]:
        abort(400, "Invalid 'kind' parameter. Must be 'engineering' or 'net'.")

    try:
        query = db.collection("category_b").where(filter=FieldFilter("kind", "==", kind))
        docs = query.stream()
        
        categories = []
        for doc in docs:
            data = doc.to_dict()
            categories.append({
                "id": doc.id,
                "label": data.get("label", ""),
                "kind": data.get("kind", ""),
                "active": data.get("active", True),
                "order": data.get("order", 0),
                "client": data.get("client", ""),   # 将来用フィールド
                "project": data.get("project", "")  # 将来用フィールド
            })
        
        # order降順、label昇順でソート
        categories.sort(key=lambda x: (-x['order'], x['label']))
        
        return jsonify(categories), 200
    except Exception as e:
        current_app.logger.error(f"Failed to fetch categories: {e}")
        abort(500, f"Failed to fetch categories: {e}")

@api_bp.route("/manager/categories/b/update_status", methods=["POST"])
@token_required
def update_category_b_status():
    """
    管理者向けに、複数のcategory_bのactiveステータスを一括更新する。
    """
    updates = request.get_json()
    if not isinstance(updates, list):
        abort(400, "Request body must be a list of category updates.")
    
    try:
        update_category_b_statuses(updates)
        return jsonify({"status": "success"}), 200
    except Exception as e:
        abort(500, f"An error occurred while updating categories: {e}")

@api_bp.route("/manager/groups", methods=["GET"])
@token_required
@manager_required
def get_all_groups():
    """
    全てのグループマッピング情報を取得する。
    """
    try:
        docs = db.collection("group_mappings").stream()
        groups = []
        for doc in docs:
            data = doc.to_dict()
            groups.append({
                "id": doc.id,
                "name": data.get("name", "名称未設定")
            })
        # ID順でソート
        groups.sort(key=lambda x: int(x['id']) if x['id'].isdigit() else x['id'])
        return jsonify(groups), 200
    except Exception as e:
        current_app.logger.error(f"Failed to fetch groups: {e}")
        abort(500, "Failed to fetch groups.")

@api_bp.route("/manager/categories/b/check", methods=["GET"])
@token_required
def check_category_b_exists():
    """
    指定されたkindとlabelを持つカテゴリが存在するかチェックする。
    """
    kind = request.args.get("kind")
    label = request.args.get("label")
    if not kind or not label:
        abort(400, "Query parameters 'kind' and 'label' are required.")

    query = db.collection("category_b").where(filter=FieldFilter("label", "==", label)).where(filter=FieldFilter("kind", "==", kind)).limit(1)
    docs = list(query.stream())
    
    if not docs:
        return jsonify({"status": "not_exists"})

    doc_data = docs[0].to_dict()
    is_active = doc_data.get("active", False)

    if is_active:
        return jsonify({"status": "active"})
    else:
        return jsonify({"status": "inactive"})

@api_bp.route("/manager/categories/b/create", methods=["POST"])
@token_required
def create_category_b():
    """
    新しいcategory_bを作成する。
    """
    data = request.get_json()
    label = data.get("label")
    kind = data.get("kind")

    if not label or not kind:
        abort(400, "Request body must contain 'label' and 'kind'.")

    try:
        new_category = create_new_category_b(label=label, kind=kind)
        return jsonify(new_category), 201 # 201 Created
    except Exception as e:
        abort(500, f"An error occurred while creating the category: {e}")

@api_bp.route("/manager/categories/b/reactivate", methods=["POST"])
@token_required
def reactivate_category_b_endpoint():
    """
    非表示のカテゴリを再表示（active: trueに更新）する。
    """
    data = request.get_json()
    label = data.get("label")
    kind = data.get("kind")

    if not label or not kind:
        abort(400, "Request body must contain 'label' and 'kind'.")

    try:
        updated_category = reactivate_category_b(label=label, kind=kind)
        return jsonify(updated_category), 200
    except Exception as e:
        abort(500, f"An error occurred while reactivating the category: {e}")


@api_bp.route("/categories/b", methods=["GET"])
@token_required
def get_category_b_for_user():
    """
    一般ユーザー向けに、category_bのラベル一覧を降順で返すエンドポイント。
    工数入力画面の選択肢として使用される。
    """
    try:
        # 1. Firestoreから基本情報を取得
        user_info = get_user_info_by_line_id(g.line_user_id)
        jobcan_employee_id = user_info.get("jobcan_employee_id")

        # 2. Jobcan APIから最新のグループ情報を取得
        if jobcan_employee_id:
            from services.jobcan_service import JobcanService
            app_env = os.environ.get("APP_ENV", "development")
            is_sandbox = app_env != "production"
            jobcan_service = JobcanService(sandbox=is_sandbox)
            employee_details = jobcan_service.get_employee_details(employee_code=jobcan_employee_id)
            
            latest_group_id = employee_details.get("main_group") if employee_details else None

            if latest_group_id is not None:
                # Jobcanから取得したIDを元に、group_mappingsからグループ名を取得
                group_mapping_ref = db.collection("group_mappings").document(str(latest_group_id))
                group_mapping_doc = group_mapping_ref.get()
                
                if group_mapping_doc.exists:
                    latest_group_name = group_mapping_doc.to_dict().get("name")
                    # このリクエスト内で使用するグループ名を最新のものに更新
                    user_info["main_group_name"] = latest_group_name
                else:
                    # マッピングが見つからない場合、ログを出力してフォールバック
                    current_app.logger.warning(f"Group mapping not found for ID: {latest_group_id}. User: {g.line_user_id}")

                # Firestoreに保存されているグループIDを取得
                user_doc_ref = db.collection("users").document(user_info["company_employee_id"])
                original_user_doc = user_doc_ref.get()
                original_group_id = original_user_doc.to_dict().get("main_group") if original_user_doc.exists else None

                # FirestoreのIDとJobcanのIDが異なる場合、DBを更新
                if latest_group_id != original_group_id:
                    current_app.logger.info(f"Updating main_group ID for user {g.line_user_id} from '{original_group_id}' to '{latest_group_id}'.")
                    user_doc_ref.update({
                        "main_group": latest_group_id,
                        "updated_at": firestore.SERVER_TIMESTAMP
                    })
            else:
                current_app.logger.warning(f"Could not retrieve latest group info from Jobcan for user {g.line_user_id}. Falling back to Firestore data.")

        # 3. 最新のグループ名に基づいてカテゴリの 'kind' を決定
        current_group_name = user_info.get("main_group_name", "")
        if "ネット" in current_group_name:
            kind = "net"
        else:
            # デフォルトは工務
            kind = "engineering"

        # 4. 決定したkindでカテゴリを取得して返す (詳細情報付き)
        # get_all_category_b_labels(kind=kind) の代わりに直接クエリを実行
        query = db.collection("category_b").where(filter=FieldFilter("kind", "==", kind)).where(filter=FieldFilter("active", "==", True))
        docs = query.stream()

        categories = []
        for doc in docs:
            data = doc.to_dict()
            categories.append({
                "id": doc.id,
                "label": data.get("label", ""),
                "client": data.get("client", ""),
                "project": data.get("project", ""),
                "order": data.get("order", 0)
            })

        # order降順、label昇順でソート
        categories.sort(key=lambda x: (-x['order'], x['label']))

        return jsonify(categories), 200
    except Exception as e:
        current_app.logger.error(f"Error getting categories for user {g.line_user_id}: {e}")
        # エラーが発生した場合は、デフォルトの工務カテゴリを返す
        labels = get_all_category_b_labels(kind="engineering")
        return jsonify(labels)

@api_bp.route("/batch/notify-unreported", methods=["POST"])
@scheduler_token_required
def batch_notify_unreported():
    """
    Cloud Schedulerからトリガーされ、工数未入力のユーザーに通知を送信する。
    """
    data = request.get_json()
    notify_time_str = data.get("notify_time", "16:00") # "15:30" などの形式
    if not notify_time_str:
        abort(400, "Request body must contain 'notify_time'.")

    today_str = (datetime.now(timezone(timedelta(hours=9)))).strftime('%Y-%m-%d')
    current_app.logger.info(f"Batch job started for notify_time: {notify_time_str} on {today_str}")

    # 1. 通知対象時刻のユーザーを取得
    users_ref = db.collection("users")
    # `notify_time` フィールドはFirestoreに文字列 "HH:MM" で保存されている想定
    query = users_ref.where(filter=FieldFilter("notify_time", "==", notify_time_str))
    target_users = list(query.stream())

    if not target_users:
        current_app.logger.info("No users found for this notification time.")
        return jsonify({"status": "success", "message": "No users to notify."}), 200

    # 2. JobcanServiceを初期化
    from services.jobcan_service import JobcanService
    app_env = os.environ.get("APP_ENV", "development")
    is_sandbox = app_env != "production"
    jobcan_service = JobcanService(sandbox=is_sandbox)

    notified_count = 0
    # 3. 各ユーザーの条件をチェックして通知
    for user_doc in target_users:
        user_data = user_doc.to_dict()
        line_user_id = user_data.get("line_user_id")
        jobcan_employee_id = user_data.get("jobcan_employee_id")
        company_employee_id = user_doc.id

        if not all([line_user_id, jobcan_employee_id, company_employee_id]):
            current_app.logger.warning(f"Skipping user {user_doc.id} due to missing info.")
            continue

        try:
            # 条件1: 当日の勤務時間を取得
            summary_res = jobcan_service.get_daily_summaries(employee_id=jobcan_employee_id, dates=[today_str])
            work_minutes = 0
            if summary_res and summary_res.get("daily_summaries"):
                work_minutes = summary_res["daily_summaries"][0].get("work", 0)

            # 条件2: 当日の工数報告時間を取得
            report_doc_ref = db.collection(COLLECTION_DAILY_REPORTS).document(f"{company_employee_id}_{today_str}")
            report_doc = report_doc_ref.get()
            reported_minutes = report_doc.to_dict().get("task_total_minutes", 0) if report_doc.exists else 0

            # 条件判定と通知実行
            if work_minutes > 0 and reported_minutes == 0:
                current_app.logger.info(f"Notifying user {company_employee_id} (LINE: {line_user_id}). Work: {work_minutes}min, Reported: {reported_minutes}min.")
                send_push_message(line_user_id, "本日の工数が未入力です。")
                notified_count += 1
            else:
                current_app.logger.info(f"Skipping user {company_employee_id}. Work: {work_minutes}min, Reported: {reported_minutes}min.")

        except Exception as e:
            current_app.logger.error(f"Error processing user {company_employee_id}: {e}")

    return jsonify({
        "status": "success",
        "processed_users": len(target_users),
        "notified_users": notified_count
    }), 200

@api_bp.route("/manager/employees/check-unmapped", methods=["GET"])
@token_required
def get_unmapped_employees():
    """
    Jobcanに存在するが、Firestoreにマッピングされていない従業員のリストを返す。
    """
    try:
        unmapped_list = check_unmapped_jobcan_employees()
        return jsonify(unmapped_list), 200
    except Exception as e:
        abort(500, f"未マッピング従業員のチェック中にエラーが発生しました: {e}")

@api_bp.route("/manager/employees/create-mapping", methods=["POST"])
@token_required
def post_employee_mapping():
    """
    新しい従業員マッピングをFirestoreに作成する。
    """
    data = request.get_json()
    company_employee_id = data.get("company_employee_id")
    jobcan_employee_id = data.get("jobcan_employee_id")
    name = data.get("name")

    if not all([company_employee_id, jobcan_employee_id, name]):
        abort(400, "company_employee_id, jobcan_employee_id, name は必須です。")

    try:
        new_mapping = create_employee_mapping(company_employee_id, jobcan_employee_id, name)
        return jsonify(new_mapping), 201 # 201 Created
    except Exception as e:
        # create_employee_mapping内でabortが呼ばれた場合、そのエラーが返される
        if hasattr(e, 'code'):
            raise
        abort(500, f"従業員マッピングの作成中にエラーが発生しました: {e}")

@api_bp.route("/categories/category_a", methods=["GET"])
@token_required
def get_category_a():
    """
    category_a（業務種別）のリストを取得するエンドポイント。
    工数入力画面の選択肢として使用される。
    """
    try:
        docs = db.collection("category_a").order_by("label").stream()
        # フロントエンドが期待する { "label": "..." } の形式で返す
        categories = [{"id": doc.id, "label": doc.to_dict().get("label")} for doc in docs if doc.to_dict().get("label")]
        return jsonify(categories), 200
    except Exception as e:
        print(f"Error getting categories from 'category_a': {e}")
        abort(500, "Failed to get categories from 'category_a'.")

@api_bp.route("/config", methods=["GET"])
@token_required
def get_config():
    """
    フロントエンドに提供する設定情報を返すエンドポイント。
    現在は締め日（CLOSING_DAY）を返す。
    """
    closing_day = int(os.environ.get("CLOSING_DAY", "20")) # 環境変数から取得、デフォルトは20
    return jsonify({"closing_day": closing_day}), 200

# --- 【実装保留】速報値メール送信機能 ---
# 代替案（GoogleドライブへのCSV保存）を実装するため、一旦コメントアウト。
# @api_bp.route("/manager/send-report-mail", methods=["POST"])
# @token_required
# @manager_required
# def send_report_mail():
#     """
#     管理者向けに、速報値メールを送信するエンドポイント。
#     メールは操作した管理者本人にのみ送信される。
#     """
#     try:
#         # @manager_required デコレータによって g.user_info にユーザー情報が格納されている
#         recipient_email = g.user_info.get("mail")
#
#         if not recipient_email:
#             abort(400, "あなたのユーザー情報にメールアドレスが登録されていません。")
#
#         send_quick_report_email(recipient_email=recipient_email)
#         return jsonify({"message": f"{recipient_email} に速報値メールを送信しました。"}), 200
#     except Exception as e:
#         # send_quick_report_email内でabortが呼ばれた場合、そのエラーが返される
#         # ここでは予期せぬエラーをキャッチする
#         abort(500, "メール送信処理の呼び出し中に予期せぬエラーが発生しました。")

@api_bp.route("/manager/daily-reports", methods=["GET"])
@token_required
@manager_required
def get_manager_daily_reports():
    """
    指定された日付の日報一覧（予実突合データ）を取得する
    """
    target_date_str = request.args.get('date')
    if not target_date_str:
        abort(400, "Query parameter 'date' is required.")

    try:
        # 日付の形式チェック
        target_date = datetime.strptime(target_date_str, '%Y-%m-%d')
        
        # 1. 全社員マッピングを取得 (IDと名前のマッピング用)
        # これにより、未提出者も一覧に表示できる
        mappings_ref = db.collection('employee_mappings')
        # status: "active" の従業員のみを対象とする
        query = mappings_ref.where(filter=FieldFilter("status", "==", "active"))
        mappings_docs = query.stream()
        
        # usersコレクションからグループ情報を取得するためのマップを作成
        # employee_mappingsにはmain_groupがないため、usersから補完する
        users_ref = db.collection('users')
        users_docs = users_ref.stream()
        users_group_map = {}
        for u_doc in users_docs:
            u_data = u_doc.to_dict()
            # usersドキュメントIDはcompany_employee_idと同じ前提
            if 'main_group' in u_data:
                users_group_map[u_doc.id] = u_data['main_group']

        employees = []
        for doc in mappings_docs:
            data = doc.to_dict()
            emp_id = doc.id
            employees.append({
                'id': emp_id, # company_employee_id
                'name': data.get('name', 'Unknown'),
                'group_id': users_group_map.get(emp_id) # usersコレクションから取得したグループIDを設定
            })

        # 2. 指定日の日報データを取得
        reports_ref = db.collection(COLLECTION_DAILY_REPORTS)
        query = reports_ref.where(filter=FieldFilter("date", "==", target_date))
        reports_docs = query.stream()

        reports_map = {}
        for doc in reports_docs:
            data = doc.to_dict()
            emp_id = data.get('company_employee_id')
            if emp_id:
                reports_map[emp_id] = data

        # 3. 結合と集計
        results = []
        for emp in employees:
            emp_id = emp['id']
            name = emp['name']
            group_id = emp.get('group_id') # グループIDを取得
            report = reports_map.get(emp_id)
            
            if report:
                work_time = report.get('jobcan_work_minutes', 0)
                task_time = report.get('task_total_minutes', 0)
                diff = task_time - work_time
                
                results.append({
                    'date': target_date_str,
                    'name': name,
                    'workTime': work_time,
                    'taskTime': task_time,
                    'diff': diff,
                    'employeeId': emp_id,
                    'group_id': group_id # レスポンスに含める
                })
            else:
                # 未提出者
                results.append({
                    'date': target_date_str,
                    'name': name,
                    'workTime': None,
                    'taskTime': None,
                    'diff': None,
                    'employeeId': emp_id,
                    'group_id': group_id # レスポンスに含める
                })

        # 社員ID順でソート
        results.sort(key=lambda x: x['employeeId'])

        return jsonify(results), 200

    except ValueError:
        abort(400, "Invalid date format. Use YYYY-MM-DD.")
    except Exception as e:
        current_app.logger.error(f"Error fetching daily reports: {e}")
        abort(500, f"Internal Server Error: {str(e)}")

@api_bp.route("/manager/work-times", methods=["GET"])
@token_required
@manager_required
def get_all_employee_work_times():
    """
    【管理者向け】指定された日付の全アクティブ従業員の勤務時間をJobcanから取得する。
    日報＞グループ別画面の「勤務時間受信」ボタンで使用される。
    """
    target_date_str = request.args.get('date')
    if not target_date_str:
        abort(400, "Query parameter 'date' is required.")

    try:
        # 日付の形式チェック
        datetime.strptime(target_date_str, '%Y-%m-%d')
    except ValueError:
        abort(400, "Invalid date format. Use YYYY-MM-DD.")

    try:
        # 1. 全アクティブ従業員のマッピングを取得 (jobcan_employee_id を含む)
        mappings_ref = db.collection('employee_mappings')
        query = mappings_ref.where(filter=FieldFilter("status", "==", "active"))
        mappings_docs = query.stream()

        employees_to_fetch = []
        for doc in mappings_docs:
            data = doc.to_dict()
            if data.get('jobcan_employee_id'):
                employees_to_fetch.append({
                    'company_employee_id': doc.id,
                    'jobcan_employee_id': data['jobcan_employee_id']
                })

        if not employees_to_fetch:
            return jsonify([]), 200

        # 2. JobcanServiceを初期化
        from services.jobcan_service import JobcanService
        app_env = os.environ.get("APP_ENV", "development")
        is_sandbox = app_env != "production"
        jobcan_service = JobcanService(sandbox=is_sandbox)

        # 3. 各従業員の勤務時間を取得
        results = []
        for emp in employees_to_fetch:
            company_id = emp['company_employee_id']
            jobcan_id = emp['jobcan_employee_id']
            try:
                response_data = jobcan_service.get_daily_summaries(employee_id=jobcan_id, dates=[target_date_str])
                work_minutes = 0
                if response_data and response_data.get("daily_summaries"):
                    work_minutes = response_data["daily_summaries"][0].get("work", 0)
                results.append({'employeeId': company_id, 'workTime': work_minutes})
            except Exception as e:
                current_app.logger.error(f"Failed to get work time for employee {jobcan_id} on {target_date_str}: {e}")
                results.append({'employeeId': company_id, 'workTime': None}) # エラー時はnullを返す
        return jsonify(results), 200
    except Exception as e:
        current_app.logger.error(f"Error fetching all employee work times: {e}")
        abort(500, f"Internal Server Error: {str(e)}")

@api_bp.route("/manager/project-summary", methods=["GET"])
@token_required
@manager_required
def get_project_summary():
    """
    指定された工事番号（プロジェクト）について、当月度の工数を集計し、
    日付を行、従業員を列とするマトリクス形式で返す。
    """
    # 1. リクエストパラメータの取得
    project_label = request.args.get('project_label')
    if not project_label:
        abort(400, "Query parameter 'project_label' is required.")

    # 基準日（省略時は今日）
    date_str = request.args.get('date', datetime.now(timezone(timedelta(hours=9))).strftime('%Y-%m-%d'))
    try:
        target_date = datetime.strptime(date_str, '%Y-%m-%d')
    except ValueError:
        abort(400, "Invalid date format for 'date'. Use YYYY-MM-DD.")

    # カテゴリ詳細（顧客名、案件名）を取得
    client = ""
    project = ""
    try:
        cat_query = db.collection("category_b").where(filter=FieldFilter("label", "==", project_label)).limit(1)
        cat_docs = list(cat_query.stream())
        if cat_docs:
            cat_data = cat_docs[0].to_dict()
            client = cat_data.get("client") or ""
            project = cat_data.get("project") or ""
    except Exception as e:
        current_app.logger.warning(f"Failed to fetch category details for {project_label}: {e}")

    try:
        # 2. 当月度の期間を計算
        start_date, end_date = calculate_monthly_period(target_date)

        # 2.5. 全てのアクティブな従業員情報を取得（列として使用）
        mappings_ref = db.collection('employee_mappings')
        query_mappings = mappings_ref.where(filter=FieldFilter("status", "==", "active"))
        mappings_docs = query_mappings.stream()
        
        users_ref = db.collection('users')
        users_docs = users_ref.stream()
        users_group_map = {doc.id: doc.to_dict().get('main_group') for doc in users_docs if doc.to_dict().get('main_group') is not None}

        all_active_employees = []
        for doc in mappings_docs:
            data = doc.to_dict()
            emp_id = doc.id
            if data.get('name'):
                all_active_employees.append({
                    'id': emp_id,
                    'name': data.get('name'),
                    'group_id': users_group_map.get(emp_id)
                })
        all_active_employees.sort(key=lambda x: x['name'])

        # 3. Firestoreから期間内のレポートを取得
        query = db.collection(COLLECTION_DAILY_REPORTS).where(filter=FieldFilter("date", ">=", start_date)).where(filter=FieldFilter("date", "<=", end_date))
        docs = query.stream()

        # 4. 指定された工事番号でフィルタリングし、データを集計
        # 形式: { "YYYY-MM-DD": { "employee_name": total_hours } }
        summary_data = {}
        relevant_employee_names = set() # 実績のある従業員名を保持するセット

        for doc in docs:
            data = doc.to_dict()
            report_date, employee_name, tasks = data.get('date'), data.get('employee_name'), data.get('tasks', [])
            if not all([report_date, employee_name]): continue

            project_minutes = sum(task.get('time', 0) for task in tasks if task.get('categoryB_label') == project_label)
            
            if project_minutes > 0:
                date_key = report_date.strftime('%Y-%m-%d')
                summary_data.setdefault(date_key, {})[employee_name] = summary_data.get(date_key, {}).get(employee_name, 0.0) + (project_minutes / 60.0)
                relevant_employee_names.add(employee_name)

        # 実績のある従業員のみにフィルタリング (all_active_employeesのソート順を維持)
        filtered_employees = [emp for emp in all_active_employees if emp['name'] in relevant_employee_names]

        # 5. マトリクス形式に整形
        rows = []
        current_date = start_date
        while current_date <= end_date:
            date_key = current_date.strftime('%Y-%m-%d')
            row = [date_key] + [summary_data.get(date_key, {}).get(emp['name'], 0.0) for emp in filtered_employees]
            rows.append(row)
            current_date += timedelta(days=1)

        return jsonify({
            "project_label": project_label, "client": client, "project": project,
            "start_date": start_date.strftime('%Y-%m-%d'), "end_date": end_date.strftime('%Y-%m-%d'),
            "employees": filtered_employees, "rows": rows
        }), 200

    except Exception as e:
        current_app.logger.error(f"Error fetching project summary for '{project_label}': {e}")
        abort(500, f"Internal Server Error: {str(e)}")

@api_bp.route("/manager/prepare-report-csv", methods=["POST"])
@token_required
@manager_required
def prepare_report_csv():
    """
    管理者向けに、日次レポートのCSVを生成し、一時的にFirestoreに保存してダウンロードURLを返す。
    Request Body: { "date": "YYYY-MM-DD" } (省略時は前日)
    """
    try:
        # 1. リクエストパラメータの取得
        data = request.get_json() or {}
        target_date_str = data.get('date')
        target_group_id = data.get('group_id')
        is_monthly = data.get('is_monthly', False)
        
        jst = timezone(timedelta(hours=9))
        if not target_date_str:
            target_date_str = datetime.now(jst).strftime('%Y-%m-%d')
            
        try:
            target_date_obj = datetime.strptime(target_date_str, '%Y-%m-%d')
        except ValueError:
            abort(400, "Invalid date format. Use YYYY-MM-DD.")

        # 2. Firestoreからレポートを取得
        query = db.collection(COLLECTION_DAILY_REPORTS)
        file_name = ""

        if is_monthly:
            # 月度内一括の場合、対象日付が属する月度の範囲を計算
            start_date, end_date = calculate_monthly_period(target_date_obj)
            
            # 範囲検索
            query = query.where(filter=FieldFilter("date", ">=", start_date)).where(filter=FieldFilter("date", "<=", end_date))
            file_name = f"monthly_report_{start_date.strftime('%Y%m%d')}-{end_date.strftime('%Y%m%d')}.csv"
        else:
            # 通常の日次集計
            query = query.where(filter=FieldFilter("date", "==", target_date_obj))
            file_name = f"daily_report_{target_date_str}.csv"
        
        # グループIDが指定されている場合はフィルタリング
        group_id_list = []
        if target_group_id:
            try:
                # カンマ区切り文字列の場合はリストに変換してIN検索 (例: "4,5,6,7,8")
                if isinstance(target_group_id, str) and ',' in target_group_id:
                    group_id_list = [int(x.strip()) for x in target_group_id.split(',')]
                else:
                    # JobcanのグループIDは数値で保存されているため、intに変換して検索
                    group_id_list = [int(target_group_id)]
            except (ValueError, TypeError):
                abort(400, "Invalid group_id format. Must be an integer or comma-separated integers.")

            # 日次集計(等価検索)の場合は、Firestore側でフィルタリングしてもインデックス不要なため適用する。
            # 月度集計(範囲検索)の場合は、複合インデックス未作成エラーを回避するため、Firestoreクエリには含めない。
            if not is_monthly:
                if len(group_id_list) > 1:
                    query = query.where(filter=FieldFilter("group_id", "in", group_id_list))
                else:
                    query = query.where(filter=FieldFilter("group_id", "==", group_id_list[0]))

        docs = query.stream()
        
        reports = []
        for doc in docs:
            data = doc.to_dict()
            # 月度集計の場合はメモリ内でフィルタリングを行う
            if is_monthly and group_id_list:
                # データにgroup_idがない、またはリストに含まれていない場合はスキップ
                if data.get("group_id") not in group_id_list:
                    continue
            reports.append(data)
            
        # データが0件の場合はCSV生成をスキップしてレスポンスを返す
        if not reports:
            return jsonify({
                "status": "success",
                "count": 0,
                "message": "No data found matching the criteria."
            }), 200

        # 3. CSV生成
        output = io.StringIO()
        # Excelで文字化けしないようにBOMを付与
        output.write('\ufeff')
        writer = csv.writer(output)
        
        # ヘッダー
        writer.writerow(['日付', '社員名', '社員ID', '部署', '勤務時間(分)', '工数合計(分)', '業務内容'])
        
        for report in reports:
            # レポートの日付を使用（Timestamp型の場合は変換）
            report_date = report.get('date')
            if isinstance(report_date, datetime):
                row_date_str = report_date.strftime('%Y-%m-%d')
            else:
                row_date_str = target_date_str

            # 業務内容の整形
            tasks = report.get('tasks') or []
            task_details = [f"[{t.get('categoryA_label', '')}/{t.get('categoryB_label', '')}] {t.get('time',0)}分: {t.get('detail', '')}" for t in tasks]
            tasks_str = "\n".join(task_details)
            
            writer.writerow([
                row_date_str,
                report.get('employee_name', ''),
                report.get('company_employee_id', ''),
                report.get('group_name', ''),
                report.get('jobcan_work_minutes', 0),
                report.get('task_total_minutes', 0),
                tasks_str
            ])
            
        csv_content = output.getvalue()
        output.close()

        # 4. Firestoreに一時保存 (download_links)
        # main.py の download_csv が期待するID形式: {manager_id} (固定)
        manager_id = g.user_info.get('company_employee_id')
        # 日付に依存せず、管理者IDをキーにして常に上書き保存する
        doc_id = str(manager_id)

        db.collection("download_links").document(doc_id).set({
            "manager_id": manager_id,
            "csv_content": csv_content,
            "file_name": file_name,
            "created_at": datetime.now(timezone.utc),
            "target_date": target_date_str
        })

        # 5. ダウンロードURLの生成
        base_url = request.host_url.rstrip('/')
        download_url = f"{base_url}/liff/download/{manager_id}"

        return jsonify({
            "status": "success",
            "download_url": download_url,
            "file_name": file_name,
            "count": len(reports)
        }), 200

    except Exception as e:
        current_app.logger.error(f"Failed to prepare report CSV: {e}")
        abort(500, f"CSV generation failed: {e}")