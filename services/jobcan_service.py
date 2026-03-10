import os
import requests
import json
from datetime import datetime, timedelta # timedelta をインポート
import base64 # Basic認証のために追加
from typing import List, Dict, Any, Optional
from google.cloud import firestore
from google.cloud.firestore import Client as FirestoreClient

class JobcanService:
    """Jobcan APIと連携するための汎用サービスクラス"""

    def __init__(self, client_id: str = None, client_secret: str = None, db: Optional[FirestoreClient] = None, raw_responses_collection: Optional[str] = None, sandbox: bool = True):
        self.client_id = client_id
        self.client_secret = client_secret
        self.sandbox = sandbox

        # 環境に応じてAPIのベースURLとトークンURLを切り替える
        base_domain = "sandbox-api-kintai.jobcan.jp" if sandbox else "api-kintai.jobcan.jp"
        auth_domain = "sandbox-api-auth-kintai.jobcan.jp" if sandbox else "api-auth-kintai.jobcan.jp"

        self.ATTENDANCE_API_BASE_URL = f"https://{base_domain}/attendance/v1"
        self.SHIFT_API_BASE_URL = f"https://{base_domain}/shift/v1"
        self.APPLY_API_BASE_URL = f"https://{base_domain}/apply/v1"
        self.MASTER_API_BASE_URL = f"https://{base_domain}/master/v1" # 従業員情報取得用
        self.TOKEN_URL = f"https://{auth_domain}/oauth/token"
        self.HOLIDAY_API_BASE_URL = f"https://{base_domain}/holiday/v1"

        self.access_tokens = {}  # scopeごとのアクセストークンを保持
        self.db = db
        self.raw_responses_collection = raw_responses_collection

        # 認証情報が渡されない場合は、環境変数から読み込む
        if not self.client_id:
            if self.sandbox:
                self.client_id = os.environ.get("JOBCAN_CLIENT_ID_SANDBOX")
            else:
                self.client_id = os.environ.get("JOBCAN_CLIENT_ID_PRODUCTION")
        if not self.client_secret:
            if self.sandbox:
                self.client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_SANDBOX")
            else:
                self.client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_PRODUCTION")

        if not self.client_id or not self.client_secret:
            raise ValueError("JobcanのClient IDとClient Secretが設定されていません。")

    def _get_access_token(self, scope: str) -> Optional[str]:
        """指定されたスコープのアクセストークンを取得または生成する"""
        if scope in self.access_tokens:
            return self.access_tokens[scope]

        print(f"Jobcanのアクセストークンを取得しています... (scope: {scope})")
        # Jobcan APIの仕様に基づき、client_idとclient_secretをリクエストボディに含める
        # リクエストボディにはgrant_typeとscopeのみを含める
        payload = {"grant_type": "client_credentials", "scope": scope}
        
        # Basic認証ヘッダーを生成: Authorization: Basic <BASE64(ID:SECRET)>
        auth_string = f"{self.client_id}:{self.client_secret}"
        encoded_auth_string = base64.b64encode(auth_string.encode("utf-8")).decode("utf-8")
        headers = {
            "Authorization": f"Basic {encoded_auth_string}",
            "Content-Type": "application/x-www-form-urlencoded" # 明示的にContent-Typeを設定
        }

        try:
            response = requests.post(self.TOKEN_URL, headers=headers, data=payload)
            response.raise_for_status()
            token_data = response.json()
            access_token = token_data.get("access_token")
            if not access_token:
                print(f"エラー: レスポンスにアクセストークンが含まれていません。(scope: {scope})")
                return None
            self.access_tokens[scope] = access_token
            print("アクセストークンの取得に成功しました。")
            return access_token
        except requests.exceptions.RequestException as e:
            print(f"エラー: アクセストークンの取得に失敗しました - {e}")
            if e.response is not None:
                print(f"Jobcan API Response: {e.response.text}") # 詳細なエラーレスポンスを出力
            return None

    def _request(
        self,
        method: str,
        url: str,
        scope: str,
        params: Optional[List[tuple]] = None,
        json_body: Optional[Dict] = None,
        retry: bool = True
    ) -> Optional[Any]:
        """APIリクエストを汎用的に処理する"""
        access_token = self._get_access_token(scope)
        if not access_token:
            return None

        headers = {"Authorization": f"Bearer {access_token}"}
        
        try:
            # GETリクエストの場合はjson_bodyを無視し、POSTの場合はjsonパラメータで送信する
            if method.upper() == "POST":
                response = requests.request(method, url, headers=headers, params=params, json=json_body)
            else:
                response = requests.request(method, url, headers=headers, params=params)

            response.raise_for_status()
            # レスポンスボディが空の場合もあるため、JSONデコードは試行する
            return response.json() if response.text else {}
        except requests.exceptions.RequestException as e:
            if retry and e.response is not None and e.response.status_code == 401:
                self.access_tokens.pop(scope, None) # 古いトークンを削除
                return self._request(method, url, scope, params=params, json_body=json_body, retry=False)
            
            error_details = f" Details: {e.response.text}" if e.response is not None else ""
            print(f"エラー: APIリクエストに失敗しました - {e}{error_details}")
            return None
        except json.JSONDecodeError:
            print(f"エラー: レスポンスの形式が不正です (JSONデコード失敗)。 Body: {response.text}")
            return None

    def get_access_token(self, scope: str) -> Optional[str]:
        """指定されたスコープのアクセストークンを取得する（外部呼び出し用）"""
        return self._get_access_token(scope)

    def _save_raw_response(self, employee_id: str, date: str, api_endpoint: str, response_data: Any):
        """FirestoreにJobcan APIの生レスポンスを保存する"""
        if not self.db or not self.raw_responses_collection or not response_data:
            return
        save_jobcan_raw_response(self.db, self.raw_responses_collection, employee_id, date, api_endpoint, response_data)

    def get_daily_summaries(self, employee_id: str, dates: List[str], save_raw: bool = False) -> Optional[Dict]:
        """勤務サマリーを取得する"""
        scope = "summaries.read"
        url = f"{self.ATTENDANCE_API_BASE_URL}/summaries/daily/{employee_id}"
        params = [("date", d) for d in dates]
        response_data = self._request("GET", url, scope, params=params)

        if save_raw and response_data and "daily_summaries" in response_data:
            for summary in response_data["daily_summaries"]:
                if "date" in summary:
                    self._save_raw_response(employee_id, summary["date"], "summaries/daily", summary)
        return response_data

    def refresh_daily_summary(self, employee_id: str, date: str) -> Optional[Dict]:
        """指定した日の勤務サマリーの再計算をリクエストする (POST)"""
        scope = "summaries.create" # 仕様書で確認した正しい書き込みスコープ
        url = f"{self.ATTENDANCE_API_BASE_URL}/summaries/daily/{employee_id}/refresh"

        # 仕様書に基づき、toの日付をfromの翌日に設定する (from <= N < to)
        from_date = datetime.strptime(date, "%Y-%m-%d")
        to_date = (from_date + timedelta(days=1)).strftime("%Y-%m-%d")

        json_data = {
            "conditions": {
                "range": {
                    "from": date, # 例: "2024-05-24"
                    "to": to_date # 例: "2024-05-25"
                }
            }
        }

        print(f"Requesting summary refresh for {employee_id} on {date}...")
        # このAPIは成功してもレスポンスボディが空か、またはステータス情報のみを返す可能性がある
        return self._request("POST", url, scope, json_body=json_data)

    def calculate_work_time_from_adits(self, employee_id: str, date: str, wait_seconds: float = 0) -> int:
        """
        【リフレッシュAPI改善】サマリーをリフレッシュし、完了を確認してから勤務時間を取得する。
        1. refresh API (POST) を呼び出してジョブカンにサマリーの再計算を依頼する。
        2. レスポンスのステータスが 'finished' であることを確認する。
        3. summaries API (GET) を呼び出して更新されたデータを取得する。
        """
        import time # timeモジュールをインポート
        print(f"Executing real-time work time calculation for {employee_id} on {date}")

        # ステップ1: ジョブカンにサマリーの再計算をリクエスト
        refresh_response = self.refresh_daily_summary(employee_id=employee_id, date=date)

        # ステップ2: リフレッシュ処理のステータスを確認
        if refresh_response and refresh_response.get("refresh", {}).get("status") == "finished":
            print(f"  - Summary refresh for {date} confirmed as 'finished'. Proceeding to get summary.")
        else:
            # レスポンスが期待通りでない場合も、処理は続行してみる（ログに警告を残す）
            print(f"  - Warning: Summary refresh status is not 'finished' or response is unexpected: {refresh_response}")

        # 【重要】非同期処理のため、ジョブカン側での計算完了を待つ
        if wait_seconds > 0:
            print(f"  - Waiting for {wait_seconds} seconds for the summary to be refreshed...")
            time.sleep(wait_seconds)

        # ステップ3: 更新された（はずの）サマリーを取得
        response_data = self.get_daily_summaries(employee_id=employee_id, dates=[date])

        work_minutes = 0
        if response_data and response_data.get("daily_summaries"):
            summary = response_data["daily_summaries"][0]
            work_minutes = summary.get("work", 0)

        return work_minutes

    def get_all_employees(self) -> Optional[Dict]:
        """
        従業員マスタ一覧を取得する。ページネーションに対応。
        https://api-docs.jobcan.jp/kinmu/master/employees/
        """
        scope = "employees.read"
        url = f"{self.MASTER_API_BASE_URL}/employees"
        all_employees = []
        last_id = 0
        limit = 100 # 1回あたりの取得数（最大100）
        retries = 1 # 401エラー時の再試行回数

        while True:
            print(f"Fetching employees from Jobcan, last_id: {last_id}...")
            access_token = self._get_access_token(scope)
            if not access_token:
                return None # トークン取得失敗

            headers = {"Authorization": f"Bearer {access_token}"}
            params = {"last_id": last_id, "count": limit}
            
            try:
                response = requests.get(url, headers=headers, params=params)
                response.raise_for_status()
                
                data = response.json()
                employees = data.get("employees", [])
                
                if not employees:
                    break

                all_employees.extend(employees)

                # 次のページのためにlast_idを更新
                last_employee = employees[-1]
                last_id = last_employee.get("id")
                
                # 取得数がlimit未満なら、これ以上データはないはずなので終了
                if len(employees) < limit:
                    break

                retries = 1 # 成功したらリトライ回数をリセット

            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 401 and retries > 0:
                    print(f"警告: 認証エラー(401)。トークンを更新して再試行します。 (scope: {scope})")
                    self.access_tokens.pop(scope, None)
                    retries -= 1
                    continue
                error_details = f" Details: {e.response.text}" if e.response is not None else ""
                print(f"エラー: APIリクエストに失敗しました - {e}{error_details}")
                return None
            except (requests.exceptions.RequestException, json.JSONDecodeError) as e:
                print(f"エラー: APIリクエストまたはJSONデコードに失敗しました - {e}")
                return None

        return {"employees": all_employees}

    def get_employee_details(self, employee_code: str, save_raw: bool = False) -> Optional[Dict]:
        """従業員詳細情報を取得する"""
        # 従業員情報取得のスコープ
        scope = "employees.read"
        url = f"{self.MASTER_API_BASE_URL}/employees/{employee_code}"
        
        response_data = self._request("GET", url, scope)

        if save_raw and response_data:
            # このAPIは日付に依存しないため、現在の日付をキーとして保存する
            today_str = datetime.now().strftime('%Y-%m-%d')
            self._save_raw_response(employee_code, today_str, "master/v1/employees", response_data)

        return response_data

    def get_default_shifts(self, employee_id: str, save_raw: bool = False) -> Optional[Dict]:
        """基本シフトを取得する"""
        scope = "defaultShifts.read"
        # 【修正】API仕様書に基づき、employee_id はパスパラメータではなくクエリパラメータで渡す
        url = f"{self.SHIFT_API_BASE_URL}/default-shifts"
        params = [("employee_id", employee_id)]
        response_data = self._request("GET", url, scope, params=params)

        if save_raw:
            self._save_raw_response(employee_id, datetime.now().strftime('%Y-%m-%d'), "default-shifts", response_data)

        return response_data

    def get_adits(self, employee_id: str, date: str, save_raw: bool = False) -> Optional[Dict]:
        """打刻情報を取得する"""
        scope = "adits.read"
        url = f"{self.ATTENDANCE_API_BASE_URL}/adits/{employee_id}"
        params = [("date", date)]
        response_data = self._request("GET", url, scope, params=params)

        if save_raw:
            self._save_raw_response(employee_id, date, "adits", response_data)

        return response_data

    def get_shift_requests(self, employee_id: str, dates: List[str], save_raw: bool = False) -> Optional[Dict]:
        """シフト申請情報を取得する"""
        scope = "shiftRequests.read"
        url = f"{self.SHIFT_API_BASE_URL}/requests/{employee_id}"
        params = [("date", d) for d in dates]
        response_data = self._request("GET", url, scope, params=params)

        if save_raw and dates:
            self._save_raw_response(employee_id, dates[0], "shift/v1/requests", response_data)

        return response_data

    def get_confirmed_shifts(self, employee_id: str, dates: List[str], save_raw: bool = False) -> Optional[Dict]:
        """確定シフトを取得する"""
        scope = "shifts.read"
        url = f"{self.SHIFT_API_BASE_URL}/shifts/{employee_id}"
        # API仕様書に基づき、複数のdateパラメータを生成する
        params = [("date", d) for d in dates]

        response_data = self._request("GET", url, scope, params=params)

        if save_raw and response_data and "shifts" in response_data:
            for shift_info in response_data["shifts"]:
                if "date" in shift_info:
                    self._save_raw_response(employee_id, shift_info["date"], "shifts", shift_info)

        return response_data

    def get_overtime_requests(self, employee_id: str, date: str, save_raw: bool = False) -> Optional[Dict]:
        """残業申請情報を取得する"""
        # API仕様書にスコープの記載がないため、エンドポイント名から推測
        scope = "overWorkRequests.read"
        # 新しい仕様書に基づき、employee_id をパスパラメータとしてURLに含める
        url = f"{self.APPLY_API_BASE_URL}/employees/{employee_id}/over-work/requests"
        params = [
            ("mode", "select"), # APIエラーレスポンスに基づき、期間指定検索の "select" を指定
            ("from_over_work_date", date), 
            ("to_over_work_date", date)]
        response_data = self._request("GET", url, scope, params=params)

        if save_raw:
            self._save_raw_response(employee_id, date, "apply/v1/employees/over-work/requests", response_data)

        return response_data

    def get_paid_holidays(self, employee_id: str, from_date: str, to_date: str, vacation_type: str = "paid") -> Optional[Dict]:
        """休暇「使用」情報を取得する"""
        scope = "holidayUseDays.read"
        url = f"{self.HOLIDAY_API_BASE_URL}/employees/{employee_id}/use-days"
        params = {
            'from': from_date,
            'to': to_date,
            'vacation_type': vacation_type
        }
        return self._request("GET", url, scope, params=params)

    def get_selection_notes(self, employee_id: str, from_date: str, to_date: str) -> Dict[str, str]:
        """
        指定期間の選択備考（ID=1 または Code=1）を取得する。
        戻り値: { "YYYY-MM-DD": "選択肢名" }
        """
        scope = "dailySelectionRemarks.read"
        url = f"{self.ATTENDANCE_API_BASE_URL}/employees/{employee_id}/summaries/daily/selection-remarks"
        
        # 日付リスト生成
        try:
            start = datetime.strptime(from_date, '%Y-%m-%d')
            end = datetime.strptime(to_date, '%Y-%m-%d')
        except ValueError:
            print(f"Error: Invalid date format. from: {from_date}, to: {to_date}")
            return {}

        dates = []
        curr = start
        while curr <= end:
            dates.append(curr.strftime('%Y-%m-%d'))
            curr += timedelta(days=1)

        results = {}
        
        # 31日ごとに分割してリクエスト (API仕様: 最大31日まで)
        chunk_size = 31
        for i in range(0, len(dates), chunk_size):
            chunk = dates[i:i + chunk_size]
            params = [("date", d) for d in chunk]
            
            response_data = self._request("GET", url, scope, params=params)
            
            # ★デバッグ用: レスポンスの中身を整形して出力
            # print(f"[DEBUG] API Response: {json.dumps(response_data, indent=2, ensure_ascii=False)}")
            
            # 実機レスポンスに合わせて解析ロジックを修正
            if response_data and "daily_selection_remarks" in response_data:
                for employee_data in response_data["daily_selection_remarks"]:
                    summaries = employee_data.get("summaries", [])
                    for summary in summaries:
                        date_str = summary.get("date")
                        if not date_str:
                            continue
                        
                        # 日付フォーマットの正規化 (YYYY-MM-DD) とクリーニング
                        try:
                            dt = datetime.strptime(str(date_str).strip(), '%Y-%m-%d')
                            date_str = dt.strftime('%Y-%m-%d')
                        except ValueError:
                            print(f"[WARN] Invalid date format from Jobcan: {date_str}")
                            continue

                        # キー名は 'selection_remarks'
                        remarks = summary.get("selection_remarks", [])
                        
                        for r in remarks:
                            # remark_id または remark_code が "1" のものを対象とする
                            if str(r.get("remark_id")) == "1" or str(r.get("remark_code")) == "1":
                                selections = r.get("selections", [])
                                note_parts = [s.get("selection_name") or s.get("selection_code") or "" for s in selections]
                                # 空文字を除去
                                note_parts = [n for n in note_parts if n]
                                if note_parts:
                                    val = ", ".join(note_parts)
                                    results[date_str] = val
                                    print(f"[DEBUG] Found accommodation note for {date_str}: {val}")
        return results

    def request_attendance_data_download(
        self,
        format_id: int,
        period_type: str,
        period_value: str,
        staff_codes: Optional[List[str]] = None,
        output_format: str = "json"
    ) -> Optional[Dict]:
        """勤務データの作成をリクエストする (非同期)"""
        scope = "reportingAttendance.write"
        # API仕様書にエンドポイントの記載がないため、スコープ名から推測
        url = f"{self.ATTENDANCE_API_BASE_URL}/reporting"

        # リクエストボディを構築
        body = {
            "format_id": format_id,
            "period_type": period_type,
            "period_value": period_value,
            "output_format": output_format,
        }
        if staff_codes:
            body["staff_codes"] = ",".join(staff_codes)

        return self._request("POST", url, scope, json_body=body)

def save_jobcan_raw_response(
    db: FirestoreClient,
    collection_name: str,
    employee_id: str,
    date: str,
    api_endpoint: str,
    jobcan_response: Any
):
    """FirestoreにJobcan APIの生レスポンスを保存する"""
    fetched_at = datetime.now()
    safe_fetched_at = fetched_at.strftime('%Y%m%d%H%M%S%f')
    doc_id = f"{employee_id}_{date}_{safe_fetched_at}"
    data = {
        "staff_id": employee_id,
        "date": date,
        "fetched_at": fetched_at, # Firestoreのタイムスタンプ型で保存
        "api_endpoint": api_endpoint,
        "jobcan_response": jobcan_response
    }
    db.collection(collection_name).document(doc_id).set(data)
    print(f"  - Raw response for {date} saved to Firestore as {doc_id}.")