"""
アプリケーション全体で共有されるビジネスロジックやヘルパー関数を定義するモジュール。
"""
import io
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from typing import Optional
from google.cloud.firestore_v1.field_path import FieldPath
from google.cloud import firestore
from flask import abort, current_app, request
import requests

from linebot import LineBotApi
from linebot.exceptions import LineBotApiError
from linebot.models import TextSendMessage
from app_core.config import (
    COLLECTION_JOBCAN_RAW_RESPONSES,
    COLLECTION_DAILY_REPORTS,
    COLLECTION_HOLIDAY_TYPES,
)

# --- メール送信用ライブラリ ---
import base64
from google.auth import default, impersonated_credentials
from email.mime.text import MIMEText
from google.cloud.firestore_v1.base_query import FieldFilter

# --- クライアントの初期化 ---
db = firestore.Client()

def get_user_info_by_line_id(line_user_id: str) -> dict:
    """
    LINEユーザーIDを元に、usersコレクションから紐づく社員情報を取得する。
    見つからない場合は404エラーを発生させる。
    """
    users_ref = db.collection("users")
    query = users_ref.where(filter=FieldFilter("line_user_id", "==", line_user_id)).limit(1)
    docs = list(query.stream())

    if not docs:
        abort(404, "ユーザー情報が見つかりません。先にID登録を完了してください。")

    user_doc = docs[0]
    user_data = user_doc.to_dict()
    company_employee_id = user_doc.id

    # employee_mappingsから名前を取得
    mapping_ref = db.collection("employee_mappings").document(company_employee_id)
    mapping_doc = mapping_ref.get()
    name = mapping_doc.to_dict().get("name", "名前未登録") if mapping_doc.exists else "名前未登録"

    # --- main_groupの値から表示名を取得する ---
    main_group_id = user_data.get("main_group")
    group_name = "（未設定）" # デフォルト

    if main_group_id is not None:
        # group_mappingsコレクションからグループ名を取得
        group_mapping_ref = db.collection("group_mappings").document(str(main_group_id))
        group_mapping_doc = group_mapping_ref.get()
        if group_mapping_doc.exists:
            # ドキュメントが存在すれば、'name'フィールドを取得
            group_name = group_mapping_doc.to_dict().get("name", f"名称未設定({main_group_id})")
        else:
            # マッピングが見つからない場合のフォールバック表示
            # この場合、管理画面でグループ設定を追加する必要があります。
            group_name = f"不明なグループ({main_group_id})"

    # 履歴情報の取得
    history = get_user_selection_history(company_employee_id)

    return {
        "company_employee_id": company_employee_id,
        "jobcan_employee_id": user_data.get("jobcan_employee_id"),
        "main_group_id": main_group_id, # 集計用にグループIDも返す
        "name": name,
        "is_manager": user_data.get("is_manager", False),
        "is_executive": user_data.get("is_executive", False), # 新しいフィールドを取得
        "is_system_admin": user_data.get("is_system_admin", False), # ★システム管理者フラグを追加
        "main_group_name": group_name,
        "mail": user_data.get("mail"), # メールアドレスを取得する処理を追加
        "history": history # 選択履歴を追加
    }

def _get_realtime_work_minutes(jobcan_service, jobcan_employee_id: str) -> int:
    """
    指定された従業員の当日の勤務時間をリアルタイムで計算して返す。
    打刻情報から計算し、失敗した場合は0を返す。
    """
    try:
        today_jst = datetime.now(timezone(timedelta(hours=9)))
        today_str = today_jst.strftime('%Y-%m-%d')

        adits_data = jobcan_service.get_adits(employee_id=jobcan_employee_id, date=today_str)
        if not adits_data or not adits_data.get("adits"):
            return 0

        valid_adits = [adit for adit in adits_data["adits"] if "recorded_at" in adit]
        if len(valid_adits) < 1:
            return 0

        sorted_adits = sorted(valid_adits, key=lambda x: x["recorded_at"])
        start_time = datetime.fromisoformat(sorted_adits[0]["recorded_at"])

        if len(valid_adits) % 2 != 0:
            # 勤務中の場合は、現在時刻を終業時刻とみなす
            end_time = today_jst
        else:
            # 勤務終了の場合は、最後の打刻時刻を終業時刻とする
            end_time = datetime.fromisoformat(sorted_adits[-1]["recorded_at"])

        duration = end_time - start_time
        # 休憩時間を考慮していないため、概算値となる
        duration_minutes = int(duration.total_seconds() / 60)
        
        current_app.logger.info(f"Realtime work time for {today_str}: {duration_minutes} minutes")
        return duration_minutes

    except Exception as e:
        current_app.logger.error(f"Failed to get realtime work time. Error: {e}")
        return 0

def get_calendar_statuses(jobcan_employee_id: str, company_employee_id: str, dates: list[str], is_executive: bool = False) -> dict:
    """
    指定された期間のJobcan勤務時間とFirestoreの報告時間を比較し、
    カレンダー表示用のステータスを生成する。
    jobcan_employee_id が None/空の場合はJobcanを呼ばず勤務時間を0として扱い、
    Firestoreの日報データのみでステータスを返す（active_officer 等に対応）。
    """
    # --- 1. Jobcanから勤務サマリーを取得（IDが無い場合はスキップし勤務時間0とする）---
    if not jobcan_employee_id:
        jobcan_data = {"daily_summaries": []}
        default_shift_data = None
        current_app.logger.info(f"[get_calendar_statuses] jobcan_employee_id is empty for company_employee_id={company_employee_id}; skipping Jobcan API, treating work time as 0.")
    else:
        from services.jobcan_service import JobcanService
        app_env = os.environ.get("APP_ENV", "development")
        is_sandbox = app_env != "production"
        jobcan_service = JobcanService(
            db=db,
            sandbox=is_sandbox,
            raw_responses_collection=COLLECTION_JOBCAN_RAW_RESPONSES
        )
        jobcan_data = jobcan_service.get_daily_summaries(employee_id=jobcan_employee_id, dates=dates)
        default_shift_data = jobcan_service.get_default_shifts(employee_id=jobcan_employee_id)
        current_app.logger.debug("--- [DEBUG] API (/default-shifts) Response ---")
        current_app.logger.debug(f"Data: {default_shift_data}")

    # 最終的な結果を格納する辞書を初期化
    calendar_statuses = {date: {"status": None, "jobcan_minutes": None, "reported_minutes": None, "has_shift": False, "has_accommodation": False, "jobcan_note": "", "on_site": None} for date in dates}

    # --- 2. 基本シフト情報から、各日付が勤務日か休日かを判定 ---
    # 【修正】キー名を "default_shifts" から "default_shift" に変更
    if default_shift_data and default_shift_data.get("default_shift"):
        all_employee_shifts = default_shift_data.get("default_shift") # デフォルト値なしで取得
        
        # 【修正】レスポンスは全従業員分なので、該当の従業員を探す
        target_employee_shift = None
        # all_employee_shiftsがリストであることを確認してからループする
        if isinstance(all_employee_shifts, list):
            for emp_shift in all_employee_shifts:
                # 【修正】両方をintに変換して比較を確実にする
                api_emp_id = emp_shift.get("employee_id")
                if api_emp_id is not None and int(api_emp_id) == int(jobcan_employee_id):
                    target_employee_shift = emp_shift
                    break

        if target_employee_shift:
            week_shifts = target_employee_shift.get("week_default_shifts", [])
            shift_pattern = {shift.get("week_id"): shift for shift in week_shifts}

            # --- ユーザーを絞ったデバッグログ ---
            current_app.logger.info(f"--- [DEBUG] Found shift pattern for employee_id: {jobcan_employee_id} ---")
            current_app.logger.info(f"Shift Pattern: {shift_pattern}")
            # --- ここまで ---

            for date_str in dates:
                try:
                    date_obj = datetime.strptime(date_str, '%Y-%m-%d')
                    # 【修正】Jobcanのweek_id (月曜=1, ..., 日曜=7) に合わせるため isoweekday() を使用
                    day_of_week = date_obj.isoweekday()

                    # その曜日のシフトパターンを取得
                    day_pattern = shift_pattern.get(day_of_week)

                    if day_pattern:
                        # holiday_typeが0（平日）ならシフトあり、それ以外はシフトなし
                        is_holiday = day_pattern.get("holiday_type", 0) != 0
                        calendar_statuses[date_str]["has_shift"] = not is_holiday
                except (ValueError, KeyError) as e:
                    current_app.logger.warning(f"Could not determine shift for date {date_str}. Error: {e}")
        else:
            # 【フォールバック処理】基本シフトが見つからない場合は、全日を「シフトあり」として扱う
            for date_str in dates:
                calendar_statuses[date_str]["has_shift"] = True

            # --- ユーザーが見つからなかった場合のデバッグログ ---
            current_app.logger.warning(f"--- [DEBUG] Shift pattern NOT found for employee_id: {jobcan_employee_id} in API response ---")
            # --- ここまで ---

    # --- 3. Jobcan勤務実績を整理 ---
    if jobcan_data and jobcan_data.get("daily_summaries"):
        for summary in jobcan_data["daily_summaries"]:
            date = summary["date"]
            if date in calendar_statuses:
                calendar_statuses[date]["jobcan_minutes"] = summary.get("work", 0)

    # --- 5. Firestoreから報告済み工数を取得 ---
    all_docs = []
    doc_ids = [f"{company_employee_id}_{date}" for date in dates]

    # Firestore 'in' クエリの要素数上限(30)に対応するため、doc_idsをチャンクに分割
    chunk_size = 30
    for i in range(0, len(doc_ids), chunk_size):
        doc_id_chunk = doc_ids[i:i + chunk_size]
        if doc_id_chunk:
            query = db.collection("daily_reports").where(FieldPath.document_id(), "in", doc_id_chunk)
            all_docs.extend(query.stream())

    # 【修正】当日分の工数報告が取得できていなかった問題を修正
    # カレンダーの表示範囲に当日が含まれている場合、当日分の工数報告を別途取得してマージする
    today_str = datetime.now(timezone(timedelta(hours=9))).strftime('%Y-%m-%d')
    if today_str in dates:
        today_doc_id = f"{company_employee_id}_{today_str}"
        # 既に取得済みのドキュメントに含まれていないかチェック
        if not any(doc.id == today_doc_id for doc in all_docs):
            today_doc_ref = db.collection("daily_reports").document(today_doc_id)
            today_doc = today_doc_ref.get()
            if today_doc.exists:
                all_docs.append(today_doc)


    # 取得したすべてのドキュメントを処理
    for doc in all_docs:
        doc_data = doc.to_dict()
        date = doc_data.get("date")
        if date:  # dateはTimestamp型で取得される
            date_str = date.strftime('%Y-%m-%d')
            if date_str in calendar_statuses:
                # 基本は task_total_minutes を使う
                reported = doc_data.get("task_total_minutes", 0)
                # 万一 task_total_minutes が 0 / 未設定でも、tasks に時間が入っている場合は
                # タスク合計から再計算してカレンダー表示用の reported_minutes に反映する
                if (reported is None or reported == 0) and doc_data.get("tasks"):
                    try:
                        reported_from_tasks = sum(
                            int(t.get("time", 0)) for t in doc_data.get("tasks", [])
                        )
                        if reported_from_tasks > 0:
                            reported = reported_from_tasks
                    except (ValueError, TypeError):
                        # 不正値が混じっていても、ここで例外にせず task_total_minutes の値を優先
                        pass

                calendar_statuses[date_str]["reported_minutes"] = reported
                calendar_statuses[date_str]["has_accommodation"] = doc_data.get("has_accommodation", False)
                calendar_statuses[date_str]["jobcan_note"] = doc_data.get("jobcan_note", "")
                calendar_statuses[date_str]["on_site"] = doc_data.get("on_site")

    # ステータス判定ループ
    for date in dates:
        status_data = calendar_statuses[date]
        has_shift = status_data["has_shift"]
        jobcan_time = status_data["jobcan_minutes"]
        report_time = status_data["reported_minutes"]

        # Jobcanから実績が返ってこない日は0分として扱う
        effective_jobcan_time = jobcan_time if jobcan_time is not None else 0

        if report_time is not None:
            # 報告時間と実績を比較してステータスを決定
            if report_time == 0 and effective_jobcan_time == 0: # 両方0の場合
                status_data["status"] = None # フロント側で非表示にするための目印
            elif report_time == 0 and effective_jobcan_time > 0: # 実績あり、報告0分の場合
                status_data["status"] = "pending" # 「未入力」として扱う
            elif is_executive and report_time >= effective_jobcan_time and report_time > 0:
                # 役員特別ロジック: 報告時間が実績以上なら完了 (報告が0より大きい場合のみ)
                status_data["status"] = "completed"
            elif not is_executive and effective_jobcan_time > 0 and effective_jobcan_time == report_time:
                # 一般ユーザーロジック: 実績と報告が一致すれば完了
                status_data["status"] = "completed"
            else:
                # 上記以外はすべて不一致
                status_data["status"] = "inconsistent"
        elif effective_jobcan_time > 0:
            # 実績があり、報告がない場合は「未入力」
            status_data["status"] = "pending"

    return calendar_statuses

def get_all_category_b_labels(kind: str = "engineering") -> list[dict]:
    """
    Firestoreの 'category_b' コレクションからすべての 'label' を取得し、
    降順でソートして返す。
    'kind' が指定された場合は、そのkindを持つドキュメントのみを対象とする。
    指定がない場合は、デフォルトで 'engineering' (工務) を対象とする。
    """
    try:
        query = db.collection("category_b")
        
        # activeがtrueのドキュメントのみを対象とする
        query = query.where(filter=FieldFilter("active", "==", True))

        # kindがNoneや空文字列でないことを確認してからクエリを追加
        if kind:
            query = query.where(filter=FieldFilter("kind", "==", kind))
        
        # Firestoreの複合インデックス要件を完全に回避するため、
        # order_byは使わず、絞り込み後のドキュメントを全て取得する
        docs = query.stream()
        
        # doc.to_dict()だけだとIDが落ちるので、IDを含めた辞書リストを作る
        doc_list = []
        for doc in docs:
            d = doc.to_dict()
            d['id'] = doc.id
            doc_list.append(d)

        # 取得したデータをPython側でソートする（orderで降順）
        sorted_docs = sorted(doc_list, key=lambda x: x.get('order', 0), reverse=True)

        # labelとactiveを含むオブジェクトのリストを返す
        return [
            {"id": doc.get("id"), "label": doc.get("label"), "active": doc.get("active", False)} 
            for doc in sorted_docs if doc.get("label")
        ]
    except Exception as e:
        # エラーが発生した場合はログに出力し、空のリストを返す
        print(f"Error getting category_b labels: {e}")
        return []

def update_category_b_statuses(updates: list[dict]):
    """
    category_bコレクションの複数のドキュメントのactiveステータスを一括更新する。
    updates: [{"label": "...", "active": True/False}, ...]
    """
    batch = db.batch()
    categories_ref = db.collection("category_b")

    for update in updates:
        label = update.get("label")
        active = update.get("active")
        if label is not None and active is not None:
            # labelを元にドキュメントを検索
            query = categories_ref.where(filter=FieldFilter("label", "==", label)).limit(1)
            docs = list(query.stream())
            if docs:
                doc_ref = docs[0].reference
                batch.update(doc_ref, {"active": active})
    
    batch.commit()

def reactivate_category_b(label: str, kind: str):
    """
    指定されたlabelとkindを持つ非表示のカテゴリを再表示（active: trueに更新）する。
    """
    categories_ref = db.collection("category_b")
    query = categories_ref.where(filter=FieldFilter("label", "==", label)).where(filter=FieldFilter("kind", "==", kind)).limit(1)
    docs = list(query.stream())

    if not docs:
        abort(404, f"カテゴリ '{label}' が見つかりません。")

    doc_ref = docs[0].reference
    doc_ref.update({"active": True})

    # 更新後の情報を返す
    updated_doc = doc_ref.get().to_dict()
    return {"label": updated_doc.get("label"), "active": updated_doc.get("active")}

def create_new_category_b(label: str, kind: str, client: str = None, project: str = None, offices: list = None):
    """
    新しいcategory_bドキュメントを作成する。
    """
    categories_ref = db.collection("category_b")

    # 1. 同じlabelとkindのドキュメントが既に存在しないか最終チェック
    query = categories_ref.where(filter=FieldFilter("label", "==", label)).where(filter=FieldFilter("kind", "==", kind)).limit(1)
    if len(list(query.stream())) > 0:
        abort(409, f"カテゴリ '{label}' は既に存在します。")

    # 2. 新しい 'order' を決定する (既存の最大order + 1)
    order_query = categories_ref.where(filter=FieldFilter("kind", "==", kind))
    docs = order_query.stream()
    orders = [doc.to_dict().get("order") for doc in docs if doc.to_dict().get("order") is not None]
    max_order = max(orders) if orders else 0
    new_order = max_order + 1

    # 3. ドキュメントIDを生成
    prefix = "e" if kind == "engineering" else "n"
    doc_id = f"{prefix}_{label}"

    # 4. 新しいドキュメントを作成
    new_doc_ref = categories_ref.document(doc_id)
    new_doc_ref.set({
        "label": label,
        "kind": kind,
        "client": client,
        "project": project,
        "offices": offices or [],
        "order": new_order,
        "active": True,
        "created_at": firestore.SERVER_TIMESTAMP
    })

    return {"id": doc_id, "label": label, "order": new_order}

def update_category_b_offices(updates: list[dict]):
    """
    category_bコレクションの複数のドキュメントのofficesフィールドを一括更新する。
    updates: [{"id": "...", "offices": [...]}, ...]
    """
    batch = db.batch()
    categories_ref = db.collection("category_b")
    
    count = 0
    for update in updates:
        doc_id = update.get("id")
        offices = update.get("offices")
        
        if doc_id and offices is not None:
            doc_ref = categories_ref.document(doc_id)
            batch.update(doc_ref, {"offices": offices})
            count += 1
            
            if count >= 400:
                batch.commit()
                batch = db.batch()
                count = 0
    
    if count > 0:
        batch.commit()

def update_category_b_details(doc_id: str, client: str = None, project: str = None, offices: list = None):
    """
    category_bドキュメントの顧客、案件、事業所を更新する。
    """
    doc_ref = db.collection("category_b").document(doc_id)
    
    if not doc_ref.get().exists:
        abort(404, f"カテゴリID '{doc_id}' が見つかりません。")

    update_data = {
        "client": client,
        "project": project,
        "offices": offices,
        "updated_at": firestore.SERVER_TIMESTAMP
    }
    
    doc_ref.update(update_data)
    return {"id": doc_id, "status": "updated"}

def register_employee_id(current_line_user_id: str, company_employee_id: str, reply_token: str = None, line_bot_api: LineBotApi = None):
    """
    会社発行の社員IDを主キーとして、LINEユーザーIDを紐付けてFirestoreに保存する。
    reply_tokenが指定されていれば、結果をLINEで返信する。
    """
    try:
        # line_bot_apiが渡されなかった場合、環境変数から初期化する（後方互換性のため）
        if reply_token and not line_bot_api:
            line_bot_api = LineBotApi(os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")) # webhook.pyと統一

        mapping_ref = db.collection("employee_mappings").document(company_employee_id)
        mapping_doc = mapping_ref.get()

        if not mapping_doc.exists:
            if reply_token:
                line_bot_api.reply_message(reply_token, TextSendMessage(text="入力された社員IDはシステムに登録されていません。"))
            return None, None

        mapping_data = mapping_doc.to_dict()
        is_manager = mapping_data.get("is_manager", False)
        jobcan_employee_id = mapping_data.get("jobcan_employee_id")
        mail = mapping_data.get("mail") # mailフィールドも取得

        # --- Jobcan APIから所属グループ情報を取得 ---
        main_group_id = None # デフォルト値
        if jobcan_employee_id:
            try:
                from services.jobcan_service import JobcanService
                # 実行環境に応じてサンドボックスフラグを設定
                app_env = os.environ.get("APP_ENV", "development")
                is_sandbox = app_env != "production"
                jobcan_service = JobcanService(sandbox=is_sandbox)
                employee_details = jobcan_service.get_employee_details(employee_code=jobcan_employee_id)

                # JobcanのレスポンスからグループIDを取得する
                if employee_details and employee_details.get("main_group"):
                    main_group_id = employee_details["main_group"]
            except Exception as e:
                # Jobcan APIとの通信でエラーが発生しても登録処理は続行する
                # --- エラーログを詳細化 ---
                print(f"警告: Jobcanから従業員詳細の取得に失敗しました。'main_group'は登録されません。エラータイプ: {type(e).__name__}, 詳細: {e}")
        # --- ここまで ---

        user_ref = db.collection("users").document(company_employee_id)
        user_doc = user_ref.get()

        if not user_doc.exists:
            user_ref.set({
                "jobcan_employee_id": jobcan_employee_id,
                "line_user_id": current_line_user_id,
                "main_group": main_group_id, # Jobcanから取得した所属グループIDを設定
                "is_manager": is_manager,
                "mail": mail, # mailフィールドを保存
                "created_at": firestore.SERVER_TIMESTAMP,
                "updated_at": firestore.SERVER_TIMESTAMP
            })
            action = "created"
            reply_message = f"社員ID「{company_employee_id}」を新規登録しました。"
        else:
            user_data = user_doc.to_dict()
            existing_line_user_id = user_data.get("line_user_id")

            if not existing_line_user_id:
                user_ref.update({
                    "line_user_id": current_line_user_id,
                    "main_group": main_group_id, # 既存ユーザーにもグループ情報を更新
                    "mail": mail, # mailフィールドも更新
                    "updated_at": firestore.SERVER_TIMESTAMP
                })
                action = "updated"
                reply_message = f"社員ID「{company_employee_id}」にLINEアカウントを再登録しました。"
            elif existing_line_user_id == current_line_user_id:
                action = "no_change"
                reply_message = f"社員ID「{company_employee_id}」は既にこのLINEアカウントに登録済みです。"
            else:
                abort(409, f"この社員IDは既に別のLINEアカウントと紐付いています。")

        if reply_token:
            line_bot_api.reply_message(reply_token, TextSendMessage(text=reply_message))
        return action, company_employee_id
    except Exception as e:
        if hasattr(e, 'code') and e.code == 409:
            raise
        if reply_token:
            line_bot_api.reply_message(reply_token, TextSendMessage(text="エラーが発生しました。登録に失敗しました。"))
        return None, None

def get_all_employees_from_jobcan() -> list[dict]:
    """
    Jobcan APIから全従業員のリストを取得し、指定されたキー（id, last_name, first_name）を抽出して返す。
    管理画面のユーザー設定などで使用することを想定。
    """
    try:
        from services.jobcan_service import JobcanService

        # 実行環境に応じてサンドボックスフラグを設定
        app_env = os.environ.get("APP_ENV", "development")
        is_sandbox = app_env != "production"

        jobcan_service = JobcanService(sandbox=is_sandbox)
        
        # JobcanServiceに新しく追加するメソッドを呼び出す
        employees_data = jobcan_service.get_all_employees()

        if not employees_data or "employees" not in employees_data:
            current_app.logger.warning("従業員データの取得に失敗したか、データが存在しません。")
            return []

        # 必要な情報（id, last_name, first_name）を抽出
        extracted_list = [
            {
                "id": str(emp.get("id")), # IDを文字列に統一して取得
                "last_name": emp.get("last_name"),
                "first_name": emp.get("first_name"),
            }
            for emp in employees_data.get("employees", [])
        ]
        
        return extracted_list

    except ImportError:
        current_app.logger.error("エラー: JobcanServiceのインポートに失敗しました。")
        return []
    except Exception as e:
        current_app.logger.error(f"Jobcanからの全従業員リストの取得中にエラーが発生しました: {e}")
        return []

def check_unmapped_jobcan_employees() -> dict:
    """
    Jobcanの全従業員とFirestoreのemployee_mappingsを比較し、
    まだマッピングされていないJobcan従業員のリストと、Jobcanの全従業員数を返す。
    """
    # 1. Jobcanから全従業員を取得
    jobcan_employees = get_all_employees_from_jobcan()
    total_jobcan_employees = len(jobcan_employees)
    
    # デバッグログ: 取得件数を確認
    current_app.logger.info(f"Jobcan fetched employees count: {total_jobcan_employees}")
    if jobcan_employees:
        # 先頭のIDをログに出して確認
        current_app.logger.info(f"Jobcan IDs sample: {[e.get('id') for e in jobcan_employees[:5]]}")

    if not jobcan_employees:
        return {"unmapped": [], "total": 0}

    # 2. Firestoreのemployee_mappingsから既存のJobcan IDをすべて取得
    mappings_ref = db.collection("employee_mappings")
    docs = mappings_ref.stream()
    # 文字列型に変換して比較の一貫性を保つ
    mapped_jobcan_ids = {str(doc.to_dict().get("jobcan_employee_id")) for doc in docs if doc.to_dict().get("jobcan_employee_id")}

    # デバッグログ: マッピング済み件数を確認
    current_app.logger.info(f"Firestore mapped Jobcan IDs count: {len(mapped_jobcan_ids)}")

    # 3. Jobcan従業員のうち、まだマッピングされていない従業員を抽出
    unmapped_employees = []
    for emp in jobcan_employees:
        # JobcanのIDも文字列型に変換して比較
        jobcan_id_str = str(emp.get("id"))
        if jobcan_id_str not in mapped_jobcan_ids:
            unmapped_employees.append({
                "jobcan_employee_id": jobcan_id_str,
                "name": f"{emp.get('last_name', '')} {emp.get('first_name', '')}".strip()
            })
    
    # デバッグログ: 未マッピング件数を確認
    current_app.logger.info(f"Unmapped employees found: {len(unmapped_employees)}")
    
    return {"unmapped": unmapped_employees, "total": total_jobcan_employees}

def create_employee_mapping(company_employee_id: str, jobcan_employee_id: str, name: str):
    """
    新しい従業員マッピングをemployee_mappingsコレクションに作成する。
    ドキュメントIDは会社発行の社員IDとする。
    """
    mapping_ref = db.collection("employee_mappings").document(company_employee_id)
    
    # 既に同じ会社IDが存在する場合はエラー
    if mapping_ref.get().exists:
        abort(409, f"社員ID '{company_employee_id}' は既に使用されています。")

    # is_managerはfalse, statusはactiveをデフォルトとして設定
    mapping_ref.set({
        "is_manager": False,
        "jobcan_employee_id": jobcan_employee_id,
        "name": name,
        "status": "active",
        "created_at": firestore.SERVER_TIMESTAMP
    })

    # 作成したデータを返す
    return {
        "company_employee_id": company_employee_id,
        "jobcan_employee_id": jobcan_employee_id,
        "name": name,
        "is_manager": False,
        "status": "active"
    }

def send_push_message(line_user_id: str, message_text: str) -> bool:
    """
    指定されたLINEユーザーIDにPush Messageを送信する。
    成功した場合はTrue、失敗した場合はFalseを返す。
    """
    if not line_user_id or not message_text:
        current_app.logger.error("send_push_message: line_user_id and message_text are required.")
        return False
    try:
        line_bot_api = LineBotApi(os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")) # webhook.pyと統一
        line_bot_api.push_message(line_user_id, TextSendMessage(text=message_text))
        current_app.logger.info(f"Successfully sent push message to user: {line_user_id}")
        return True
    except LineBotApiError as e:
        # LINE APIからのエラーを個別にハンドリング
        if e.status_code == 400:
            # ユーザーがボットをブロックしている可能性が高い。これは運用上の警告であり、システムエラーではない。
            current_app.logger.warning(f"Could not send push message to user {line_user_id} (status: 400). The user may have blocked the bot. Details: {e.error.message}")
        else:
            # その他のAPIエラーはエラーとして記録
            current_app.logger.error(f"Failed to send push message to user: {line_user_id}. Status: {e.status_code}, Error: {e.error.message}")
        return False
    except Exception as e:
        # その他の予期せぬエラー
        current_app.logger.error(f"Failed to send push message to user: {line_user_id}. Error: {e}")
        return False

# --- 【実装保留】速報値メール送信機能 ---
# 代替案（GoogleドライブへのCSV保存）を実装するため、一旦コメントアウト。
# def send_quick_report_email(recipient_email: str):
#     """
#     速報値メールをGmail API経由で送信する。
#     送信先は引数で指定されたメールアドレス。
#     サービスアカウントの権限借用（impersonation）を使用する。
#     """
#     if not recipient_email or '@' not in recipient_email:
#         current_app.logger.error(f"無効なメールアドレスのため、送信を中止しました: {recipient_email}")
#         abort(400, "送信先メールアドレスが無効です。")
#
#     # --- 環境変数から設定を読み込む ---
#     # 権限を借用するユーザーのメールアドレス（例: noreply@your-domain.com）
#     impersonated_user = os.environ.get("GMAIL_IMPERSONATED_USER")
#
#     if not impersonated_user:
#         current_app.logger.error("メール送信に必要な環境変数（GMAIL_IMPERSONATED_USER）が設定されていません。")
#         abort(500, "サーバーのメール設定が不完全です。")
#
#     try:
#         # --- 認証情報の設定 ---
#         # 【ロジックを権限借用に変更】Cloud Runのサービスアカウントが、Workspaceユーザーになりすましてメールを送信する。
#         source_creds, _ = default()
#         creds = impersonated_credentials.Credentials(
#             source_credentials=source_creds,
#             target_principal=impersonated_user,
#             target_scopes=['https://www.googleapis.com/auth/gmail.send']
#         )
#         service = build('gmail', 'v1', credentials=creds)
#
#
#         # --- メールの作成 ---
#         jst = timezone(timedelta(hours=9))
#         current_time_str = datetime.now(jst).strftime('%Y年%m月%d日 %H:%M')
#
#         message = MIMEText(f"これは {current_time_str} に送信されたテストメールです。")
#         message['to'] = recipient_email
#         message['from'] = impersonated_user
#         message['subject'] = f"【速報値】テストメール ({current_time_str})"
#
#         # base64エンコード
#         encoded_message = base64.urlsafe_b64encode(message.as_bytes()).decode()
#         create_message = {'raw': encoded_message}
#
#         # --- メールの送信 ---
#         send_message = service.users().messages().send(userId='me', body=create_message).execute()
#         current_app.logger.info(f"速報値メールを {recipient_email} に送信しました。Message ID: {send_message.get('id')}")
#
#     except Exception as e:
#         current_app.logger.error(f"速報値メールの送信に失敗しました: {e}")
#         # デバッグのため、フロントエンドに詳細なエラーメッセージを返す
#         error_message = f"メール送信中にエラーが発生しました: {e}"
#         abort(500, error_message)

def get_all_active_employees() -> list[dict]:
    """
    全てのアクティブな従業員情報を取得する。
    employee_mappings と users を結合し、ID, 名前, グループIDを返す。
    """
    # 1. 全てのアクティブな従業員マッピングを取得
    mappings_ref = db.collection('employee_mappings')
    query_mappings = mappings_ref.where(filter=FieldFilter("status", "==", "active"))
    mappings_docs = query_mappings.stream()
    
    # 2. 全てのユーザー情報を取得してグループIDのマップを作成
    users_ref = db.collection('users')
    users_docs = users_ref.stream()
    users_group_map = {doc.id: doc.to_dict().get('main_group') for doc in users_docs if doc.to_dict().get('main_group') is not None}

    # 3. 結合してリストを作成
    employees = []
    for doc in mappings_docs:
        data = doc.to_dict()
        emp_id = doc.id
        if data.get('name'):
            employees.append({
                'id': emp_id,
                'name': data.get('name'),
                'group_id': users_group_map.get(emp_id)
            })
    
    # 名前順でソート
    employees.sort(key=lambda x: x['name'])
    return employees

def calculate_monthly_period(target_date: datetime) -> tuple[datetime, datetime]:
    """
    対象の日付が属する「月度」の開始日と終了日を計算して返す。
    締め日は環境変数 'CLOSING_DAY' から取得する。
    """
    closing_day = int(os.environ.get("CLOSING_DAY", "20"))

    if target_date.day <= closing_day:
        # 当月度 (例: 締め日20日で5/15の場合 -> 4/21〜5/20)
        # 終了日: 今月の締め日
        end_date = target_date.replace(day=closing_day)
        # 開始日: 先月の締め日翌日
        first_day_of_month = target_date.replace(day=1)
        last_month_end = first_day_of_month - timedelta(days=1)
        start_date = last_month_end.replace(day=closing_day + 1)
    else:
        # 翌月度 (例: 締め日20日で5/21の場合 -> 5/21〜6/20)
        # 開始日: 今月の締め日翌日
        start_date = target_date.replace(day=closing_day + 1)
        # 終了日: 翌月の締め日
        if target_date.month == 12:
            next_month_first_day = target_date.replace(year=target_date.year + 1, month=1, day=1)
        else:
            next_month_first_day = target_date.replace(month=target_date.month + 1, day=1)
        end_date = next_month_first_day.replace(day=closing_day)

    return start_date, end_date

def activate_download_link(manager_id: str) -> str:
    """
    ダミーのCSVデータを作成し、Firestoreに一時保存してダウンロードを有効化する。
    有効期限は作成から10分間に設定する。
    戻り値としてダウンロード用URLを返す。
    """
    try:
        # --- ダミーCSVデータの作成 ---
        jst = timezone(timedelta(hours=9))
        now = datetime.now(jst)
        timestamp_str = now.strftime('%Y%m%d_%H%M%S')
        
        # CSVデータを文字列として作成
        csv_content = "日付,担当者,工数(分),内容\n"
        csv_content += f"2024-01-01,山田太郎,60,テスト作業A\n"
        csv_content += f"2024-01-01,鈴木一郎,120,テスト作業B\n"

        # --- Firestoreへの保存 ---
        # ドキュメントIDを manager_id に設定（常に上書き）
        doc_id = str(manager_id)
        doc_ref = db.collection("download_links").document(doc_id)
        
        doc_ref.set({
            "csv_content": csv_content,
            "created_at": firestore.SERVER_TIMESTAMP,
            "file_name": f"daily_report_{timestamp_str}.csv"
        })

        # ダウンロード用URLを生成して返す
        base_url = request.host_url.rstrip('/')
        download_url = f"{base_url}/liff/download/{manager_id}"
        current_app.logger.info(f"Download link activated for manager: {manager_id}")
        
        return download_url

    except Exception as e:
        current_app.logger.error(f"CSVデータの保存とURL有効化に失敗しました: {e}")
        abort(500, f"ダウンロードリンクの生成中にエラーが発生しました: {e}")

def get_user_selection_history(company_employee_id: str) -> dict:
    """
    ユーザーの選択履歴（よく使う項目など）を取得する。
    """
    try:
        doc_ref = db.collection("users").document(company_employee_id)
        doc = doc_ref.get()
        if doc.exists:
            data = doc.to_dict()
            return data.get("selection_history", {"catA": [], "catB": []})
        return {"catA": [], "catB": []}
    except Exception as e:
        current_app.logger.error(f"Failed to get selection history for {company_employee_id}: {e}")
        return {"catA": [], "catB": []}

def update_user_selection_history(company_employee_id: str, tasks: list):
    """
    日報提出時に選択されたタスクから履歴を更新する。
    最近使った順（LRUライク）に保存し、リストの長さを制限する。
    """
    if not tasks:
        return

    try:
        doc_ref = db.collection("users").document(company_employee_id)
        
        doc = doc_ref.get()
        if not doc.exists:
            return

        data = doc.to_dict()
        history = data.get("selection_history", {"catA": [], "catB": []})
        
        current_catA = history.get("catA", [])
        current_catB = history.get("catB", [])

        new_catA_ids = [t.get("categoryA_id") for t in tasks if t.get("categoryA_id")]
        new_catB_ids = [t.get("categoryB_id") for t in tasks if t.get("categoryB_id")]

        def update_list(current_list, new_items, max_len=20):
            updated = list(current_list)
            # 新しいアイテムを順に追加（重複排除しつつ先頭へ）
            for item in new_items:
                if item in updated:
                    updated.remove(item)
                updated.insert(0, item)
            return updated[:max_len]

        updated_catA = update_list(current_catA, new_catA_ids)
        updated_catB = update_list(current_catB, new_catB_ids)

        doc_ref.update({
            "selection_history": {
                "catA": updated_catA,
                "catB": updated_catB
            }
        })
    except Exception as e:
        current_app.logger.error(f"Failed to update selection history for {company_employee_id}: {e}")

def get_accommodation_notes_for_employees(employee_ids: list[str], start_date: datetime, end_date: datetime) -> dict:
    """
    指定された期間と従業員リストについて、宿泊備考（選択備考ID=1）を取得する。
    
    Args:
        employee_ids (list[str]): 会社の従業員IDのリスト。
        start_date (datetime): 取得開始日。
        end_date (datetime): 取得終了日。

    Returns:
        dict: { "company_employee_id": { "YYYY-MM-DD": "備考内容" } }
    """
    from services.jobcan_service import JobcanService
    app_env = os.environ.get("APP_ENV", "development")
    is_sandbox = app_env != "production"
    
    jobcan_service = JobcanService(
        db=db,
        sandbox=is_sandbox,
        raw_responses_collection=COLLECTION_JOBCAN_RAW_RESPONSES
    )

    # 会社IDとJobcan IDのマッピングを取得（Firestore 'in' は最大30件のためチャンク分割）
    mappings_ref = db.collection("employee_mappings")
    id_map = {}
    chunk_size = 30
    for i in range(0, len(employee_ids), chunk_size):
        id_chunk = employee_ids[i:i + chunk_size]
        docs = mappings_ref.where(FieldPath.document_id(), "in", id_chunk).stream()
        for doc in docs:
            id_map[doc.id] = doc.to_dict().get("jobcan_employee_id")

    all_notes = {}
    from_str = start_date.strftime('%Y-%m-%d')
    to_str = end_date.strftime('%Y-%m-%d')

    for company_id, jobcan_id in id_map.items():
        if not jobcan_id:
            continue
        try:
            notes = jobcan_service.get_selection_notes(jobcan_id, from_str, to_str)
            if notes:
                all_notes[company_id] = notes
        except Exception as e:
            current_app.logger.error(f"Failed to get accommodation notes for employee {company_id} (Jobcan ID: {jobcan_id}): {e}")

    return all_notes

def get_on_site_status_for_employees(employee_ids: list[str], start_date: datetime, end_date: datetime) -> dict:
    """
    指定された期間と従業員リストについて、現場作業ステータス（終日/半日）を取得する。
    日報のタスク(categoryA_id='A01')の合計時間から判定する。

    Args:
        employee_ids (list[str]): 会社の従業員IDのリスト。
        start_date (datetime): 取得開始日。
        end_date (datetime): 取得終了日。

    Returns:
        dict: { "company_employee_id": { "YYYY-MM-DD": 1.0 or 0.5 or 0.0 } }
    """
    results = {emp_id: {} for emp_id in employee_ids}

    # Firestore 'in' クエリの要素数上限(30)に対応するため、IDをチャンクに分割
    chunk_size = 30
    for i in range(0, len(employee_ids), chunk_size):
        id_chunk = employee_ids[i:i + chunk_size]
        
        query = db.collection(COLLECTION_DAILY_REPORTS) \
            .where(filter=FieldFilter("company_employee_id", "in", id_chunk)) \
            .where(filter=FieldFilter("date", ">=", start_date)) \
            .where(filter=FieldFilter("date", "<=", end_date))

        docs = query.stream()

        for doc in docs:
            data = doc.to_dict()
            emp_id = data.get("company_employee_id")
            report_date = data.get("date")
            tasks = data.get("tasks", [])

            if not emp_id or not report_date:
                continue

            date_str = report_date.strftime('%Y-%m-%d')

            # A01（現場作業）の時間を集計
            on_site_minutes = sum(int(task.get("time", 0)) for task in tasks if task.get("categoryA_id") == "A01")
            
            status_value = 0.0
            if on_site_minutes >= 360:
                status_value = 1.0
            elif on_site_minutes >= 240:
                status_value = 0.5
            
            results[emp_id][date_str] = status_value

    return results


def extract_jobcan_holiday_types_list(jobcan_result) -> list:
    """
    Jobcan GET /holiday/v1/holiday-types のレスポンスから、休暇タイプの配列を取り出す。
    レスポンス形式の揺れ（直下配列 / holiday_types / items）に対応。
    """
    if jobcan_result is None:
        return []
    if isinstance(jobcan_result, list):
        return jobcan_result
    if isinstance(jobcan_result, dict):
        ht = jobcan_result.get("holiday_types")
        if isinstance(ht, list):
            return ht
        items = jobcan_result.get("items")
        if isinstance(items, list):
            return items
    return []


def compute_holiday_minutes_from_holiday_map(holiday) -> Optional[int]:
    """
    holiday が map で start / end に有効な "HH:MM" 形式の文字列があるとき、
    終了−開始の差分を分で返す。解釈できない場合は None。
    終了が開始より小さい場合は翌日まで跨ぐとみなし 24h を加算する。
    """
    if not isinstance(holiday, dict):
        return None
    start_raw = holiday.get("start")
    end_raw = holiday.get("end")
    if start_raw is None or end_raw is None:
        return None
    if not isinstance(start_raw, str) or not isinstance(end_raw, str):
        return None
    start_s = start_raw.strip()
    end_s = end_raw.strip()
    if not start_s or not end_s:
        return None

    def _minutes_from_midnight(t: str) -> Optional[int]:
        parts = t.split(":", 1)
        if len(parts) != 2:
            return None
        try:
            h = int(parts[0].strip())
            mi = int(parts[1].strip())
        except ValueError:
            return None
        if mi < 0 or mi > 59:
            return None
        if h < 0 or h > 24:
            return None
        if h == 24 and mi != 0:
            return None
        if h == 24:
            return 24 * 60
        return h * 60 + mi

    start_m = _minutes_from_midnight(start_s)
    end_m = _minutes_from_midnight(end_s)
    if start_m is None or end_m is None:
        return None

    delta = end_m - start_m
    if delta < 0:
        delta += 24 * 60
    if delta <= 0:
        return None
    return int(delta)


def enrich_holiday_types_payload_with_minutes(payload) -> None:
    """
    Jobcan 休暇タイプの配列（辞書内または直下）を走査し、
    holiday.start / holiday.end から計算した minutes を各要素に付与する（参照をそのまま更新）。
    """
    items = extract_jobcan_holiday_types_list(payload)
    for item in items:
        if not isinstance(item, dict):
            continue
        m = compute_holiday_minutes_from_holiday_map(item.get("holiday"))
        if m is not None:
            item["minutes"] = m
        else:
            item.pop("minutes", None)


def save_jobcan_holiday_types_to_firestore(db_client, jobcan_result) -> int:
    """
    休暇タイプ一覧を Firestore の holiday_types コレクションに保存する。
    ドキュメントIDは holiday_type_id（文字列化）。各ドキュメントは set で上書き。
    同期日時は synced_at（UTC）を付与する。
    """
    items = extract_jobcan_holiday_types_list(jobcan_result)
    if not items:
        return 0

    col = db_client.collection(COLLECTION_HOLIDAY_TYPES)
    now = datetime.now(timezone.utc)
    batch = db_client.batch()
    batch_count = 0
    saved = 0
    max_batch = 450  # Firestore バッチ上限 500 の余裕

    for item in items:
        if not isinstance(item, dict):
            continue
        hid = item.get("holiday_type_id")
        if hid is None:
            continue
        doc_id = str(hid)

        # JSON 往復で Firestore 向けにシリアライズ可能な型だけにする
        try:
            doc_data = json.loads(json.dumps(item, default=str))
        except (TypeError, ValueError):
            doc_data = {k: v for k, v in item.items() if v is not None}

        mins = compute_holiday_minutes_from_holiday_map(doc_data.get("holiday"))
        if mins is not None:
            doc_data["minutes"] = mins
        else:
            doc_data.pop("minutes", None)

        doc_data["synced_at"] = now

        batch.set(col.document(doc_id), doc_data)
        batch_count += 1
        saved += 1

        if batch_count >= max_batch:
            batch.commit()
            batch = db_client.batch()
            batch_count = 0

    if batch_count > 0:
        batch.commit()

    return saved