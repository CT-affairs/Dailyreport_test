"""Jobcan 月次勤務実績 API の疎通確認（work-time/results/monthly）。"""
import argparse
import base64
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

import requests

# test_jobcan_holiday_types と同じ .env 読み込み
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_jobcan_holiday_types import load_env_file, resolve_env_by_app_env  # noqa: E402


def get_access_token(client_id: str, client_secret: str, sandbox: bool, scope: str) -> str:
    auth_domain = "sandbox-api-auth-kintai.jobcan.jp" if sandbox else "api-auth-kintai.jobcan.jp"
    token_url = f"https://{auth_domain}/oauth/token"
    auth_string = f"{client_id}:{client_secret}"
    encoded = base64.b64encode(auth_string.encode("utf-8")).decode("utf-8")
    headers = {
        "Authorization": f"Basic {encoded}",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    payload = {"grant_type": "client_credentials", "scope": scope}
    resp = requests.post(token_url, headers=headers, data=payload, timeout=20)
    print(f"Token scope={scope!r} status={resp.status_code}")
    if resp.status_code != 200:
        print(resp.text)
        resp.raise_for_status()
    token = resp.json().get("access_token")
    if not token:
        raise RuntimeError(f"access_token missing scope={scope}")
    return token


def fetch_monthly(
    access_token: str,
    sandbox: bool,
    employee_id: str,
    params: List[Tuple[str, str]],
) -> Tuple[int, str]:
    base_domain = "sandbox-api-kintai.jobcan.jp" if sandbox else "api-kintai.jobcan.jp"
    url = f"https://{base_domain}/attendance/v1/employees/{employee_id}/work-time/results/monthly"
    headers = {"Authorization": f"Bearer {access_token}"}
    resp = requests.get(url, headers=headers, params=params, timeout=30)
    return resp.status_code, resp.text


def main() -> int:
    load_env_file()
    parser = argparse.ArgumentParser()
    parser.add_argument("--production", action="store_true")
    parser.add_argument("--sandbox", action="store_true")
    parser.add_argument("--employee-id", required=True)
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--month", type=int, default=5)
    args = parser.parse_args()

    force_mode = ""
    if args.production:
        force_mode = "production"
    elif args.sandbox:
        force_mode = "sandbox"

    sandbox, client_id, client_secret = resolve_env_by_app_env(force_mode)
    print(f"env={'sandbox' if sandbox else 'production'} employee_id={args.employee_id}")

    scopes = ["monthlyWorkTimeResults.read", "summaries.read"]
    for scope in scopes:
        try:
            token = get_access_token(client_id, client_secret, sandbox, scope)
        except Exception as e:
            print(f"  token failed: {e}")
            continue

        param_sets = [
            [("year", str(args.year)), ("month", str(args.month))],
            [("year", str(args.year)), ("month_no", str(args.month))],
            [],
        ]
        for params in param_sets:
            label = dict(params) if params else "(no params)"
            status, body = fetch_monthly(token, sandbox, args.employee_id, params)
            print(f"\n--- scope={scope} params={label} HTTP {status} ---")
            if status == 200:
                try:
                    parsed: Dict[str, Any] = json.loads(body) if body else {}
                    print(json.dumps(parsed, ensure_ascii=False, indent=2)[:3000])
                except json.JSONDecodeError:
                    print(body[:1000])
            else:
                print(body[:1000])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
