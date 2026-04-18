"""
締め処理（スナップショット）対象の日報ドキュメント判定。

集計（`daily_reports` の `date` 範囲クエリ）と同じく、対象可否は **ドキュメントの `date` フィールド**
を正とする。月度境界は `app_core.utils.calculate_monthly_period` のみを使用する（ブレ防止）。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal, Optional, Tuple

from app_core.utils import calculate_monthly_period

Division = Literal["enj", "net"]


def parse_daily_report_document_id(document_id: str) -> Optional[Tuple[str, str]]:
    """
    daily_reports のドキュメントID `{company_employee_id}_{YYYY-MM-DD}` を分解する。

    Returns:
        (company_employee_id, date_str) または不正時は None
    """
    if not document_id or "_" not in document_id:
        return None
    emp_id, date_part = document_id.rsplit("_", 1)
    if len(date_part) != 10 or date_part[4] != "-" or date_part[7] != "-":
        return None
    try:
        datetime.strptime(date_part, "%Y-%m-%d")
    except ValueError:
        return None
    emp_id = emp_id.strip()
    if not emp_id:
        return None
    return emp_id, date_part


def division_from_group_id(group_id) -> Division:
    """
    締め処理の division 判定。
    - group_id が 3（文字列でも数値でも strip 後 "3"）→ net
    - それ以外 → enj
    """
    if group_id is not None and str(group_id).strip() == "3":
        return "net"
    return "enj"


def normalize_report_date_value(value: Any) -> Optional[date]:
    """
    Firestore の `date` フィールド（datetime / DatetimeWithNanoseconds / 文字列等）を暦日に正規化する。
    解釈不能な場合は None。
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if type(value) is date:
        return value
    if isinstance(value, str):
        s = value.strip()
        if len(s) >= 10:
            try:
                return datetime.strptime(s[:10], "%Y-%m-%d").date()
            except ValueError:
                return None
        return None
    to_dt = getattr(value, "to_datetime", None)
    if callable(to_dt):
        try:
            dt = to_dt()
            if isinstance(dt, datetime):
                return dt.date()
        except Exception:
            return None
    return None


def _as_date(d: datetime) -> date:
    return d.date() if isinstance(d, datetime) else d


def is_report_date_value_in_inclusive_period(
    report_date_value: Any,
    period_start: datetime,
    period_end: datetime,
) -> bool:
    """`date` フィールドの値が [period_start, period_end] の暦日範囲に含まれるか（日付のみで比較）。"""
    rd = normalize_report_date_value(report_date_value)
    if rd is None:
        return False
    ps = _as_date(period_start)
    pe = _as_date(period_end)
    return ps <= rd <= pe


def compute_previous_monthly_period(now: Optional[datetime] = None) -> Tuple[datetime, datetime]:
    """
    JST 基準で「前月度」の開始・終了を返す。
    `calculate_monthly_period` のみを用いる（`routes/api.py` の前月度集計と同型）。
    """
    jst = timezone(timedelta(hours=9))
    base = now if now is not None else datetime.now(jst)
    if base.tzinfo is None:
        base = base.replace(tzinfo=jst)
    else:
        base = base.astimezone(jst)

    start_current, _ = calculate_monthly_period(base)
    prev_base = start_current - timedelta(days=1)
    return calculate_monthly_period(prev_base)


def classify_for_previous_month_closing_snapshot(
    report_date_value: Any,
    group_id,
    period_start: datetime,
    period_end: datetime,
) -> Tuple[bool, Optional[Division]]:
    """
    締めスナップショット対象として扱うかを (対象か, division) で返す。

    - 対象: **ドキュメントの `date` フィールド**が period 内（集計の日付条件と整合）
    - division: `group_id` から決定（常に enj または net）
    - `date` が解釈不能または範囲外の場合は (False, None)
    """
    if not is_report_date_value_in_inclusive_period(report_date_value, period_start, period_end):
        return False, None
    return True, division_from_group_id(group_id)


def filter_document_ids_for_previous_month_division(
    entries: list[tuple[str, Any, Any]],
    period_start: datetime,
    period_end: datetime,
    division: Division,
) -> list[str]:
    """
    前月度かつ指定 division のドキュメントIDだけを返す。

    Args:
        entries: `(document_id, report_date_field, group_id)` のリスト（`daily_reports` 1件ずつ）
        period_start, period_end: 前月度の開始・終了（`calculate_monthly_period` の戻り値をそのまま渡す想定）
        division: "enj" または "net"
    """
    out: list[str] = []
    for doc_id, date_val, group_id in entries:
        ok, div = classify_for_previous_month_closing_snapshot(
            date_val,
            group_id,
            period_start,
            period_end,
        )
        if ok and div == division:
            out.append(doc_id)
    return out
