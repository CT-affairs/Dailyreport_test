"""
Jobcan 従業員マスタ一覧 GET /master/v1/employees を取得する単体スクリプト。
test_jobcan_holiday_types.py と同様に .env / --production / --sandbox に対応。

必要な OAuth スコープ: employees.read

実行例:
  python scripts/test_jobcan_employees.py --production
  python scripts/test_jobcan_employees.py --sandbox
"""
import os
import sys
import json
import base64
import requests
import argparse
from typing import Tuple, Dict, Any, List
from pathlib import Path


def load_env_file() -> None:
    """
    .env を読み込み、未設定の環境変数だけ os.environ に反映する。
    依存ライブラリ不要で、簡易的な KEY=VALUE 形式を扱う。
    """
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def resolve_env_by_app_env(force_mode: str = "") -> Tuple[bool, str, str]:
    """
    jobcan_service.py と同じ方針で環境を決定する。
    - APP_ENV=production のとき本番
    - それ以外は sandbox
    """
    if force_mode == "production":
        sandbox = False
    elif force_mode == "sandbox":
        sandbox = True
    else:
        app_env = os.environ.get("APP_ENV", "development")
        sandbox = app_env != "production"

    if sandbox:
        client_id = os.environ.get("JOBCAN_CLIENT_ID_SANDBOX")
        client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_SANDBOX")
    else:
        client_id = os.environ.get("JOBCAN_CLIENT_ID_PRODUCTION")
        client_secret = os.environ.get("JOBCAN_CLIENT_SECRET_PRODUCTION")

    if not client_id or not client_secret:
        mode = "SANDBOX" if sandbox else "PRODUCTION"
        raise RuntimeError(
            f"Missing Jobcan credentials for {mode}. "
            "Set JOBCAN_CLIENT_ID_* and JOBCAN_CLIENT_SECRET_* env vars."
        )

    return sandbox, client_id, client_secret


def get_access_token(client_id: str, client_secret: str, sandbox: bool, scope: str) -> str:
    auth_domain = "sandbox-api-auth-kintai.jobcan.jp" if sandbox else "api-auth-kintai.jobcan.jp"
    token_url = f"https://{auth_domain}/oauth/token"

    auth_string = f"{client_id}:{client_secret}"
    encoded = base64.b64encode(auth_string.encode("utf-8")).decode("utf-8")
    headers = {
        "Authorization": f"Basic {encoded}",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    payload = {
        "grant_type": "client_credentials",
        "scope": scope,
    }

    resp = requests.post(token_url, headers=headers, data=payload, timeout=20)
    resp.raise_for_status()
    body = resp.json()
    token = body.get("access_token")
    if not token:
        raise RuntimeError(f"access_token missing. response={body}")
    return token


def fetch_all_employees(access_token: str, sandbox: bool) -> Dict[str, Any]:
    """
    GET /master/v1/employees をページネーションで全件取得する。
    jobcan_service.JobcanService.get_all_employees と同じパラメータ（last_id, count）。
    """
    base_domain = "sandbox-api-kintai.jobcan.jp" if sandbox else "api-kintai.jobcan.jp"
    url = f"https://{base_domain}/master/v1/employees"
    headers = {"Authorization": f"Bearer {access_token}"}

    all_employees: List[Any] = []
    last_id = 0
    limit = 100
    max_pages = 5000  # 無限ループ防止（100 * 5000 件まで）

    for page in range(max_pages):
        resp = requests.get(
            url,
            headers=headers,
            params={"last_id": last_id, "count": limit},
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json() if resp.text else {}
        employees = data.get("employees", [])

        if not employees:
            break

        all_employees.extend(employees)
        last_employee = employees[-1]
        next_id = last_employee.get("id")
        if next_id is None:
            break
        last_id = next_id

        if len(employees) < limit:
            break

        print(f"[INFO] fetched page {page + 1}, total employees so far: {len(all_employees)}", file=sys.stderr)
    else:
        raise RuntimeError(f"Stopped after {max_pages} pages (safety limit). Check API pagination.")

    return {"employees": all_employees}


def main() -> int:
    try:
        load_env_file()
        parser = argparse.ArgumentParser(description="Fetch Jobcan master/v1/employees (all pages).")
        parser.add_argument("--production", action="store_true", help="Use production Jobcan env vars")
        parser.add_argument("--sandbox", action="store_true", help="Use sandbox Jobcan env vars")
        args = parser.parse_args()

        force_mode = ""
        if args.production and args.sandbox:
            raise RuntimeError("Specify only one of --production or --sandbox.")
        if args.production:
            force_mode = "production"
        elif args.sandbox:
            force_mode = "sandbox"

        sandbox, client_id, client_secret = resolve_env_by_app_env(force_mode)
        scope = "employees.read"
        token = get_access_token(client_id, client_secret, sandbox, scope)
        result = fetch_all_employees(token, sandbox)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
