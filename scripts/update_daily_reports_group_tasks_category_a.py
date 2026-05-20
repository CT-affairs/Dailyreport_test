"""
daily_reports の tasks 内 categoryA を一括置換するメンテナンススクリプト
================================================================================

【概要】
  group_id が一致する daily_reports ドキュメントを対象に、
  tasks 配列内で条件に合う要素の categoryA_id / categoryA_label を置換する。

【事前準備】
  1. スクリプト先頭の定数（GROUP_ID, OLD_*, NEW_*）を書き換える
  2. Firestore 認証を通す（GOOGLE_APPLICATION_CREDENTIALS または gcloud デフォルト）
  3. 必ず dry-run で件数を確認してから apply する

【実行例】
  # 件数確認（Firestore は書き換えない）
  python scripts/update_daily_reports_group_tasks_category_a.py --mode dry-run

  # 本番実行（確認プロンプトあり・バックアップ自動保存）
  python scripts/update_daily_reports_group_tasks_category_a.py --mode apply

  # 確認プロンプトをスキップ
  python scripts/update_daily_reports_group_tasks_category_a.py --mode apply --yes

  # バックアップ保存先を指定
  python scripts/update_daily_reports_group_tasks_category_a.py --mode apply --backup-file scripts/backup/my_backup.json

  # ロールバック（apply 時に保存した JSON を指定）
  python scripts/update_daily_reports_group_tasks_category_a.py --mode rollback --backup-file scripts/backup/daily_reports_group3_category_a_backup_YYYYMMDD_HHMMSS.json

【影響範囲】
  - 読み取り: daily_reports のうち group_id == GROUP_ID のドキュメントのみ
  - 書き込み: 上記のうち、マッチした task が 1 件以上あったドキュメントのみ
  - 更新フィールド: tasks のみ（他フィールドは変更しない）
  - group_id != GROUP_ID のドキュメント・他コレクションには触れない

【注意事項】
  - OLD_CATEGORY_A_ID / NEW_* は実行前に必ず設定すること（未設定だとエラー終了）
  - OLD_CATEGORY_A_LABEL を None にすると label では絞らない（id のみでマッチ）
  - apply は Firestore 更新後にローカル JSON バックアップを保存する（更新成功後に
    スクリプトが落ちるとバックアップが無い可能性あり）
  - バックアップは tasks 配列のみ。ロールバックも tasks の復元のみ
  - バッチ書き込みは 450 件ごとに分割（Firestore 上限 500 のマージン）
  - 締め日後など、本番データへの影響を考慮して実行タイミングを選ぶこと
  - 繰り返し実行する場合は、1 回ごとに定数を書き換え → dry-run → apply の順で行う

【関連】
  同系統: scripts/update_daily_reports_n20_category_b.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

from google.cloud import firestore


# --- プロジェクトのルートディレクトリをPythonパスに追加 ---
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

# --- ローカル環境のみ .env 読み込み ---
dotenv_path = os.path.join(PROJECT_ROOT, ".env")
if os.path.exists(dotenv_path):
    from dotenv import load_dotenv

    load_dotenv(dotenv_path=dotenv_path)


# =============================================================================
# 実行ごとにここを書き換える（ドキュメント条件・タスク条件・置換先）
# =============================================================================
COLLECTION_NAME = "daily_reports"
GROUP_ID = 3  # int

# マッチ条件（tasks 配列内の要素）
OLD_CATEGORY_A_ID = "N02"
OLD_CATEGORY_A_LABEL = "新商品アップ"

# 置換先
NEW_CATEGORY_A_ID = "N03"
NEW_CATEGORY_A_LABEL = "新商品ページ制作"
# =============================================================================

BATCH_COMMIT_LIMIT = 450  # Firestore 上限 500 未満のマージン


def init_db() -> firestore.Client:
    try:
        db = firestore.Client()
        print("Firestoreクライアントの初期化に成功しました。")
        return db
    except Exception as e:
        print(f"エラー: Firestoreクライアントの初期化に失敗しました: {e}")
        sys.exit(1)


def validate_config() -> None:
    if not OLD_CATEGORY_A_ID:
        print("エラー: OLD_CATEGORY_A_ID を設定してください。")
        sys.exit(1)
    if not NEW_CATEGORY_A_ID or not NEW_CATEGORY_A_LABEL:
        print("エラー: NEW_CATEGORY_A_ID と NEW_CATEGORY_A_LABEL を設定してください。")
        sys.exit(1)


def task_matches(task: Dict[str, Any]) -> bool:
    if task.get("categoryA_id") != OLD_CATEGORY_A_ID:
        return False
    if OLD_CATEGORY_A_LABEL is not None and task.get("categoryA_label") != OLD_CATEGORY_A_LABEL:
        return False
    return True


def iter_target_docs(db: firestore.Client) -> Iterable:
    """group_id が GROUP_ID の daily_reports を取得する。"""
    col = db.collection(COLLECTION_NAME)
    query = col.where(filter=firestore.FieldFilter("group_id", "==", GROUP_ID))
    yield from query.stream()


def build_replaced_tasks(tasks: Any) -> tuple[List[Dict[str, Any]], int]:
    """
    tasks 内で条件に合う要素の categoryA_id / categoryA_label を置換して返す。
    """
    if not isinstance(tasks, list):
        return [], 0

    changed_count = 0
    new_tasks: List[Dict[str, Any]] = []
    for task in tasks:
        if not isinstance(task, dict):
            new_tasks.append(task)
            continue

        copied = dict(task)
        if task_matches(copied):
            copied["categoryA_id"] = NEW_CATEGORY_A_ID
            copied["categoryA_label"] = NEW_CATEGORY_A_LABEL
            changed_count += 1
        new_tasks.append(copied)
    return new_tasks, changed_count


def commit_batch(batch: firestore.WriteBatch, batch_ops: int) -> int:
    if batch_ops <= 0:
        return 0
    batch.commit()
    return batch_ops


def ensure_backup_dir() -> str:
    path = os.path.join(PROJECT_ROOT, "scripts", "backup")
    os.makedirs(path, exist_ok=True)
    return path


def backup_filename() -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return os.path.join(
        ensure_backup_dir(),
        f"daily_reports_group{GROUP_ID}_category_a_backup_{ts}.json",
    )


def write_backup(path: str, payload: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"バックアップを保存しました: {path}")


def run_scan_or_apply(db: firestore.Client, apply_changes: bool, backup_path: str) -> None:
    validate_config()

    docs = list(iter_target_docs(db))
    print(f"対象ドキュメント候補: {len(docs)} 件 (group_id={GROUP_ID})")

    changed_docs: List[Dict[str, Any]] = []
    total_task_replacements = 0

    batch = db.batch()
    batch_ops = 0
    committed = 0

    for doc in docs:
        data = doc.to_dict() or {}
        original_tasks = data.get("tasks", [])
        new_tasks, changed_count = build_replaced_tasks(original_tasks)

        if changed_count <= 0:
            continue

        changed_docs.append(
            {
                "doc_id": doc.id,
                "changed_task_count": changed_count,
                "original_tasks": original_tasks,
            }
        )
        total_task_replacements += changed_count

        if apply_changes:
            batch.update(doc.reference, {"tasks": new_tasks})
            batch_ops += 1
            if batch_ops >= BATCH_COMMIT_LIMIT:
                committed += commit_batch(batch, batch_ops)
                batch = db.batch()
                batch_ops = 0

    if apply_changes:
        committed += commit_batch(batch, batch_ops)

    print(f"変更対象ドキュメント数: {len(changed_docs)}")
    print(f"置換される tasks 件数: {total_task_replacements}")

    if not changed_docs:
        print("変更対象がないため終了します。")
        return

    if apply_changes:
        payload = {
            "created_at": datetime.now().isoformat(),
            "collection": COLLECTION_NAME,
            "rule": {
                "group_id": GROUP_ID,
                "old_categoryA_id": OLD_CATEGORY_A_ID,
                "old_categoryA_label": OLD_CATEGORY_A_LABEL,
                "new_categoryA_id": NEW_CATEGORY_A_ID,
                "new_categoryA_label": NEW_CATEGORY_A_LABEL,
            },
            "documents": changed_docs,
        }
        write_backup(backup_path, payload)
        print(f"更新コミット済みドキュメント数: {committed}")
        print("完了: apply mode")
    else:
        print("dry-run のため Firestore は更新していません。")
        print("完了: dry-run mode")


def run_rollback(db: firestore.Client, backup_path: str) -> None:
    if not os.path.exists(backup_path):
        print(f"エラー: バックアップファイルが見つかりません: {backup_path}")
        sys.exit(1)

    with open(backup_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    docs = payload.get("documents", [])
    if not isinstance(docs, list) or not docs:
        print("ロールバック対象ドキュメントがバックアップに含まれていません。")
        return

    col = db.collection(COLLECTION_NAME)
    batch = db.batch()
    batch_ops = 0
    restored = 0
    skipped = 0

    for row in docs:
        doc_id = row.get("doc_id")
        original_tasks = row.get("original_tasks")
        if not doc_id or not isinstance(original_tasks, list):
            skipped += 1
            continue

        ref = col.document(doc_id)
        snap = ref.get()
        if not snap.exists:
            skipped += 1
            continue

        batch.update(ref, {"tasks": original_tasks})
        batch_ops += 1
        restored += 1

        if batch_ops >= BATCH_COMMIT_LIMIT:
            commit_batch(batch, batch_ops)
            batch = db.batch()
            batch_ops = 0

    if batch_ops > 0:
        commit_batch(batch, batch_ops)

    print(f"ロールバック完了: 復元 {restored} 件 / スキップ {skipped} 件")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "daily_reports のうち group_id が一致するドキュメントを対象に、"
            "tasks 配列内で条件に合う要素の categoryA_id / categoryA_label を一括置換する。"
            "条件はスクリプト先頭の定数を書き換えて繰り返し実行する。"
        )
    )
    parser.add_argument(
        "--mode",
        choices=["dry-run", "apply", "rollback"],
        default="dry-run",
        help="実行モード。既定は dry-run。",
    )
    parser.add_argument(
        "--backup-file",
        default="",
        help=(
            "apply時: 保存先バックアップファイル(省略時は scripts/backup に自動生成)。"
            "rollback時: 復元元バックアップファイル(必須)。"
        ),
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="apply / rollback 実行時の確認プロンプトをスキップする。",
    )
    return parser.parse_args()


def confirm_or_exit(mode: str, yes: bool) -> None:
    if yes or mode == "dry-run":
        return
    print("--- 実行条件 ---")
    print(f"  group_id              : {GROUP_ID}")
    print(f"  OLD categoryA_id      : {OLD_CATEGORY_A_ID}")
    print(f"  OLD categoryA_label   : {OLD_CATEGORY_A_LABEL} (None のときは label で絞らない)")
    print(f"  NEW categoryA_id      : {NEW_CATEGORY_A_ID}")
    print(f"  NEW categoryA_label   : {NEW_CATEGORY_A_LABEL}")
    print("----------------")
    answer = input(f"{mode} を実行します。続行しますか？ [y/N]: ").strip().lower()
    if answer not in {"y", "yes"}:
        print("中止しました。")
        sys.exit(0)


def main() -> None:
    args = parse_args()
    db = init_db()

    if args.mode == "dry-run":
        run_scan_or_apply(db, apply_changes=False, backup_path="")
        return

    if args.mode == "apply":
        confirm_or_exit(args.mode, args.yes)
        backup_path = args.backup_file.strip() or backup_filename()
        run_scan_or_apply(db, apply_changes=True, backup_path=backup_path)
        return

    backup_path = args.backup_file.strip()
    if not backup_path:
        print("エラー: rollback では --backup-file が必須です。")
        sys.exit(1)
    confirm_or_exit(args.mode, args.yes)
    run_rollback(db, backup_path)


if __name__ == "__main__":
    main()
