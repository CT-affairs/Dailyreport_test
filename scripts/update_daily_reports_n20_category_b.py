from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from typing import Any, Dict, Iterable, List

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


COLLECTION_NAME = "daily_reports"
DOC_ID_PREFIX = "2"
OLD_CATEGORY_A_ID = "N20"
OLD_CATEGORY_B_ID = "n_whole"
NEW_CATEGORY_B_ID = "n_logistics"
OLD_CATEGORY_B_LABEL = "全体"
NEW_CATEGORY_B_LABEL = "梱包室"


def init_db() -> firestore.Client:
    try:
        db = firestore.Client()
        print("Firestoreクライアントの初期化に成功しました。")
        return db
    except Exception as e:
        print(f"エラー: Firestoreクライアントの初期化に失敗しました: {e}")
        sys.exit(1)


def iter_target_docs(db: firestore.Client) -> Iterable:
    """
    document_id が '2' で始まる daily_reports を対象に取得する。
    """
    col = db.collection(COLLECTION_NAME)
    # 注意:
    # 一部環境では __key__ / document_id 範囲フィルタが "must be a Key" で失敗するため、
    # ここでは全件ストリーム後に Python 側で prefix 判定する。
    for doc in col.stream():
        if doc.id.startswith(DOC_ID_PREFIX):
            yield doc


def build_replaced_tasks(tasks: Any) -> tuple[List[Dict[str, Any]], int]:
    """
    tasks 内で以下を置換して返す。
    - categoryA_id='N20' and categoryB_id='n_whole' -> categoryB_id='n_logistics'
    - categoryA_id='N20' and categoryB_label='全体'   -> categoryB_label='梱包室'
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
        changed = False
        if copied.get("categoryA_id") == OLD_CATEGORY_A_ID:
            if copied.get("categoryB_id") == OLD_CATEGORY_B_ID:
                copied["categoryB_id"] = NEW_CATEGORY_B_ID
                changed = True
            if copied.get("categoryB_label") == OLD_CATEGORY_B_LABEL:
                copied["categoryB_label"] = NEW_CATEGORY_B_LABEL
                changed = True

        if changed:
            changed_count += 1
        new_tasks.append(copied)
    return new_tasks, changed_count


def ensure_backup_dir() -> str:
    path = os.path.join(PROJECT_ROOT, "scripts", "backup")
    os.makedirs(path, exist_ok=True)
    return path


def backup_filename() -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return os.path.join(
        ensure_backup_dir(), f"daily_reports_n20_category_b_backup_{ts}.json"
    )


def write_backup(path: str, payload: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"バックアップを保存しました: {path}")


def run_scan_or_apply(db: firestore.Client, apply_changes: bool, backup_path: str) -> None:
    docs = list(iter_target_docs(db))
    print(f"対象ドキュメント候補: {len(docs)} 件 (ID先頭='{DOC_ID_PREFIX}')")

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
            if batch_ops >= 450:
                batch.commit()
                committed += batch_ops
                batch = db.batch()
                batch_ops = 0

    if apply_changes and batch_ops > 0:
        batch.commit()
        committed += batch_ops

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
                "doc_id_prefix": DOC_ID_PREFIX,
                "categoryA_id": OLD_CATEGORY_A_ID,
                "from_categoryB_id": OLD_CATEGORY_B_ID,
                "to_categoryB_id": NEW_CATEGORY_B_ID,
                "from_categoryB_label": OLD_CATEGORY_B_LABEL,
                "to_categoryB_label": NEW_CATEGORY_B_LABEL,
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

        if batch_ops >= 450:
            batch.commit()
            batch = db.batch()
            batch_ops = 0

    if batch_ops > 0:
        batch.commit()

    print(f"ロールバック完了: 復元 {restored} 件 / スキップ {skipped} 件")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "daily_reports のうちドキュメントID先頭が '2' のものを対象に、"
            "tasks[].categoryA_id='N20' の要素について "
            "categoryB_id: 'n_whole' -> 'n_logistics' と "
            "categoryB_label: '全体' -> '梱包室' を置換するスクリプト。"
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

    # rollback
    backup_path = args.backup_file.strip()
    if not backup_path:
        print("エラー: rollback では --backup-file が必須です。")
        sys.exit(1)
    confirm_or_exit(args.mode, args.yes)
    run_rollback(db, backup_path)


if __name__ == "__main__":
    main()
