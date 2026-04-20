# 日報ツール — 概要（README）

業務報告の **LINE Bot**、**LIFF（スマホ日報入力）**、**管理者用 PC 画面（`admin.html` 等）** を提供するリポジトリです。バックエンドは Flask（`main.py`）、Cloud Run 想定。Firestore に日報・マスタ・ユーザー紐付けを保持し、勤務実績は Jobcan 連携（`services/jobcan_service.py` 等）を参照します。

**兄弟ツール**: **帳票ツール（CT_invoice-ocr）** は別リポジトリ。Firestore の `users` / `employee_mappings` などデータモデルで関連します。詳細は `REPOSITORY.md`（帳票側）と本リポの `context.md.example` を参照。

> **使い方**: AI・運用の詳細前提を書く場合は `context.md.example` をコピーして `context.md` をリポジトリルートに置き、中身を埋める。  
> **注意**: 秘密値（API キー、トークン、個人情報）は `readme.md` / `context.md` に書かない。URL やプロジェクト ID は公開してよい範囲のみ。

---

## 1. ツールの目的

- **業務上の目的**:  
  従業員が日々の業務内容・工数を報告し、管理者が一覧・個別（工務 / ネット事業部）・代理入力・集計で確認・運用できるようにする。LINE 経由と PC 管理画面の両方から同じバックエンド API を利用する。
- **このツールがやらないこと（非目標）**:  
  給与計算そのもの、会計仕訳の確定、帳票 OCR（それは帳票ツールの責務）。

---

## 2. 関連リポジトリ・ツール

| 名称 | 関係 | メモ |
|------|------|------|
| 帳票ツール（CT_invoice-ocr） | 兄弟リポ | 請求・帳票 OCR。`users` / `employee_mappings` 等の共有前提の整理は両 README・`context.md` で揃える。 |
| Jobcan | 外部連携 | 勤務時間・休暇種別などの取得・同期。 |
| LINE | 認証・配信 | Messaging API、LIFF、Webhook（`routes/webhook.py`）。 |

---

## 3. 本番・ステージング（公開してよい範囲のみ）

| 環境 | ベース URL / 備考 |
|------|-------------------|
| Cloud Run（API） | デプロイ先に応じたベース URL。ヘルスは `/` または `/ping`。 |
| LIFF / 静的画面 | `index.html`、`liff-app.js` 等。CORS origins は `main.py` の `allowed_origins` を参照。 |
| 管理画面静的ファイル | `admin.html`、`admin_net.html`、`_*.html` パーシャル、`js/`、`css/`。フロント配信対象は `deploy_frontend.txt` が一覧の目安。 |

---

## 4. 主要エンドポイント（概要）

| 用途 | メソッド | パス | 認証の概要 |
|------|----------|------|------------|
| ヘルス | GET | `/` / `/ping` | なし |
| 日報送信（工務等） | POST | `/api/reports` | LINE / トークン（ルート定義参照） |
| ネット日報送信 | POST | `/api/reports_net` | 同上 |
| 日報詳細取得 | GET | `/api/report-details` | `token_required` 等 |
| 勤務時間取得 | GET | `/api/work-time` | Jobcan 連携・パラメータで挙動切替 |
| PC セッション | POST / DELETE | `/api/pc/session` | LINE ID トークン起点 |
| 予実一覧（管理） | GET | `/api/manager/daily-reports` | 管理者向け |
| 締め処理（前月度） | POST | `/api/manager/monthly-closing` | 管理者向け。完了済み・実行中・他部署実行中は 409。対象日報をスナップショットへコピー |
| 過去日報 | GET | `/api/manager/past-reports` / `/api/past-reports` | 登録ユーザー向け（詳細は `routes/api.py`） |
| Webhook | POST | （`webhook_bp` 登録パス） | LINE 署名 |

※詳細は `routes/api.py` の `@api_bp.route` とデコレータ（`token_required` / `login_required` / `manager_required`）を正とする。

---

## 5. Firestore

### 5.1 主要コレクション（例）

| コレクション | 用途 | 備考 |
|--------------|------|------|
| `daily_reports` | 日報本体 | `app_core/config.py` の `COLLECTION_DAILY_REPORTS` |
| `users` | ユーザー・社員紐付け | LINE ユーザー ID 等 |
| `employee_mappings` | 社員 ID マッピング | Jobcan 等との対応 |
| `category_b` / `category_a` 系 | 集計項目・業務種別マスタ | 管理画面・API で更新 |
| `jobcan_raw_responses` | Jobcan 生レスポンス | 定数は `COLLECTION_JOBCAN_RAW_RESPONSES` |
| `holiday_types` | 休暇タイプマスタ | `COLLECTION_HOLIDAY_TYPES` |
| `download_links` | CSV 等一時ダウンロード | `/liff/download/<manager_id>` |

### 5.2 他ツールと共有するフィールド・概念

- **LINE ユーザー ID**: 認証・ユーザー検索（`users` 等）
- **社員番号（company_employee_id）**: 日報・一覧・代理入力のキー
- **グループ（group_id）**: 工務 / ネット事業部など画面分岐

---

## 6. 環境変数（意味のみ・値は書かない）

| 変数名 | 役割 |
|--------|------|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API |
| `LINE_MESSAGING_API_CHANNEL_SECRET` | Webhook 署名検証 |
| `TEST_LINE_USER_ID` | テスト通知（任意） |
| `PORT` | ローカル起動時ポート（既定 8080 等） |
| `MONTHLY_CLOSING_TEST_MODE` | 真（`1` / `true` / `yes` / `on`、大文字小文字無視）のとき、締め処理 API の**管理ドキュメント・スナップショット既定先**だけをテスト用コレクションに切り替える。集計の前月度参照は**常に本番**の `monthly_closings` / `daily_reports_snapshot` のみ |
| `MONTHLY_CLOSINGS_TEST_COLLECTION` | 任意。テスト時の管理ドキュメントコレクション名（既定 `monthly_closings_test`） |
| `MONTHLY_CLOSING_TEST_SNAPSHOT_COLLECTION` | 任意。テスト時のスナップショット既定コレクション名（既定 `daily_reports_snapshot_test`） |
| （GCP） | Cloud Run / Firestore 用プロジェクトは `app_core/config.py` の `PROJECT_ID` 等 |

ローカルではリポジトリ直下に `.env` を置くと `main.py` が読み込む。完全な一覧は運用に合わせて `.env.example` がある場合はそれを正とする。

---

## 7. よくある運用

- **スマホ日報**: LIFF から入力 → `/api/reports` / `/api/reports_net`。
- **管理画面**: `admin.html` — 日報一覧（予実突合）、社員カレンダー、代理入力（`_manager_proxy_report*.html`）、カテゴリ設定など。
- **勤務時間の更新**: 一覧の「更新」や `work-time` 系 API（反映待ち・再取得の注意は UI メッセージ参照）。
- **バッチ**: `/api/batch/refresh-all-work-times` 等（Scheduler トークン・認証は `routes/api.py` 参照）。

---

## 8. 社内用語

| 用語 | 意味 |
|------|------|
| 日報_個別（ネット） | ネット事業部向けスタッフ別カレンダー画面（`staff_calendar_net`）。 |
| 代理入力 | 管理者が他者の日付の日報を入力する画面。 |
| 予実突合 | 勤務時間（Jobcan）と日報タスク時間の突合一覧。 |
| 工務 / ネット | グループ・画面テンプレートの分岐（例: `group_id` 3 = ネット）。 |

---

## 9. 開発メモ（任意）

- **ローカル**: `python main.py` または gunicorn（本番と同様）。ポートは `PORT`。
- **フロント**: `deploy_frontend.txt` に記載のファイルを静的ホスティング先に配置する想定。
- **主要コード**: `routes/api.py`、`routes/webhook.py`、`app_core/utils.py`、`liff-app.js`、`js/admin-app.js`。

---

## 10. 更新履歴（任意）

| 日付 | 変更内容 |
|------|----------|
| 2026-04-18 | 締め: `date`/`group_id` ルール・月度一本化・テストモード分離・`POST /api/manager/monthly-closing`（スナップショット実コピー、管理 running/completed/failed、409 条件拡張） |
| 2026-04-16 | `context.md.example` に沿った README 初版 |

---

## 締め処理メモ（合意事項・実装前）

> このセクションは、締め処理の実装前に合意した運用ルールを逐次追記するためのメモ。  
> まずは安全性優先で運用し、詳細実装は別途設計確定後に着手する。

### 合意1（確定）: 管理ドキュメントを作成する

- 締め処理の実行状態・完了状態は、専用の管理ドキュメントで管理する。
- Dashboard のボタン活性/非活性判定は、この管理ドキュメントを正とする。

### 合意2（確定）: 工務/ネットの同時実行は禁止

- 現時点ではドキュメント単位で工務/ネットの厳密な切り分け可否が未確定のため、  
  **工務またはネットのどちらか一方でも締め処理が実行中なら、もう一方は開始不可** とする。
- これは同時実行による競合・誤判定を避けるための暫定安全策。

### 合意3（確定）: 前月度の締め完了後は再実行不可（原則）

- 管理ドキュメント上で「前月度の締め処理完了」を確認した場合、Dashboard の該当ボタンを不活性化する。
- 締めのやり直しは原則不可とし、ボタン押下時は以下メッセージを表示する。
  - `締めのやり直しをする場合はシステム管理者へ連絡してください。`

### 合意4（確定）: 締め後コピー先コレクションは参照系から分離

- 締め処理で作成する「締め後ドキュメント置き場」のコレクションは、  
  カレンダー・過去日報表示・通常編集フローでは **呼ばない**。
- 既存の「過去日報の閲覧/変更」は従来どおり維持する（挙動は変えない）。
- 位置づけは以下のとおり:
  - 締め後コピー: 参考値（スナップショット）
  - 確定値: 別管理（既存データ/管理ドキュメント）

### 合意5（確定）: 差分チェック機能は別タスク

- 「確定内容との差分チェック」は将来実装するが、  
  締め処理の初期実装とは切り離して進める（スコープ分離）。

### 合意6（確定）: 管理ドキュメントの暫定スキーマを実装期間中のみ README に保持

- 締め処理機能の実装中は、管理ドキュメント（`monthly_closings` 想定）の暫定スキーマを README に残す。
- 機能完成後に、以下を判断する:
  - このセクションをそのまま恒久運用ドキュメントとして残す
  - 実装時メモとして役目を終えたため削除する

**現時点の作成例（実装メモ）**

- `copied_count`: `""`（int64）
- `division`: `"enj"`（string）
- `finished_at`: `timestamp`
- `period_end`: `timestamp`
- `period_key`: `"2026-03-21_2026-04-20"`（string）
- `period_start`: `timestamp`
- `retry_allowed`: `false`（boolean）
- `run_id`: `""`（string）
- `snapshot_collection`: `"daily_reports_snapshot"`（string）
- `started_by`: `""`（string）
- `status`: `"running "`（string）

**補足（実装時の整備候補）**

- `status` は余分な空白なしの固定値（例: `running`）に統一する。
- `division` 値は `enj` または `net` の2択で確定。
- `copied_count` は数値型（number）への統一を検討する（空文字運用は避ける）。

### 合意7（確定）: division と管理ドキュメントIDの確定ルール

- 日報ドキュメントごとに `group_id` が保持され、月内で部署間移動はない前提で運用する。
- したがって、締め処理は部署単位（`division`）で安全に実行可能とする。
- `division` は `enj` または `net` の2択とする。
- 管理ドキュメントIDは `"{period_key}_{division}"` の形式でユニークにする。
  - 例: `2026-03-21_2026-04-20_enj`
- すべての日報は、対象月度のいずれか一方に必ず属する。
  - `"{period_key}_enj"` または `"{period_key}_net"`

### 合意7-補足（確定）: 締め対象ドキュメントの判定基準

- **対象に含めるかどうかは、ドキュメントの `date` フィールド**で判定する（集計 API が `daily_reports` に対して行う `date` の範囲条件と同一の考え方）。
- ドキュメント ID に埋め込まれた日付だけでは判定しない（ID と `date` が不整合なレガシーがあっても、集計と締めで同じドキュメント集合を見るため）。
- **`group_id` が欠損している場合（`None`、空文字、空白のみ等）の現状ルール**: **ネット（`net`）には含めず、工務（`enj`）側の扱いとする**（`str(group_id).strip() == "3"` のときだけ `net`。それ以外はすべて `enj`）。

### 合意7-API（確定）: 完了済み・実行中の拒否

- `POST /api/manager/monthly-closing` は、対象となる前月度の `period_key` とリクエストの `division` について、管理ドキュメントの `status` が **completed**（前後空白を除き小文字比較）のとき **HTTP 409** で拒否する。
- 同一ドキュメントが **running** のとき、および **もう一方の division（enj/net）が running** のときも **409** で拒否する（同時実行の抑止）。
- 上記を通過したうえで、`daily_reports` から対象日報を列挙しスナップショットへコピーし、管理ドキュメントを **completed** に更新する。

### 実装メモ: 月度期間の単一ソース

- 月度の開始・終了の計算は **`app_core.utils` の `calculate_monthly_period` のみ**を正とする。
- 締め対象の補助ロジック（`app_core/monthly_closing_snapshot_selection.py`）も同関数を import して用いる。
- **保守**: 締め本体を実装したあと、コードベースに utils と**重複した月度計算**（未使用のヘルパ等）が残っていないか確認し、残存していれば可読性・単一責務の観点から**削除を検討**する。

### テストモード（締め処理の本番前検証）

**ロジックの妥当性（結論）**: 妥当。Firestore ではコレクションは書き込みで暗黙的に作られるため、「テスト専用のスナップショットコレクション」にだけコピーを書き、検証後に**そのコレクション（と、テスト用の管理コレクション）を丸ごと削除**すれば、本番の `daily_reports`・`monthly_closings`・`daily_reports_snapshot` には手をかけていなければ本番へ影響しない。

**実装方針**

- 環境変数 `MONTHLY_CLOSING_TEST_MODE` が真のとき、締め実行 API（および将来の締め本体）は **`monthly_closings_test` / `daily_reports_snapshot_test` を既定**とする（上書きは `MONTHLY_CLOSINGS_TEST_COLLECTION` / `MONTHLY_CLOSING_TEST_SNAPSHOT_COLLECTION`）。
- **集計**（前月度で `daily_reports` と `daily_reports_snapshot` を切り替える処理）は、**常に本番**の `monthly_closings` のみを参照する（テストモードの切替の影響を受けない）。
- コピー先・管理ドキュメントの参照は **`app_core.config` の `monthly_closings_collection_for_closing_run` / `default_snapshot_collection_for_closing_run`** を用いる。

**運用上の注意**

- 検証後は **テスト用コレクションだけ** を削除すること（誤って本番コレクションを消さない）。
- 本番 Cloud Run で検証する場合、検証後は **`MONTHLY_CLOSING_TEST_MODE` を必ずオフ**にする。オンにしたままだと、管理者の締め操作がテスト用コレクションに流れ続ける。

### 合意8（確定）: 締め後コピー先のドキュメントIDは元 `daily_reports` と同一IDを使用

- 締め後コピー先コレクション（例: `daily_reports_snapshot`）のドキュメントIDは、  
  元コレクション `daily_reports` のドキュメントIDをそのまま使用する。
- 元 `daily_reports` 側でIDが一意に設計されているため、コピー先でも同一IDで不都合はない前提で運用する。
- 目的:
  - 元データとの突合を単純化する
  - 将来の差分チェック機能でID対応を明確にする

### 合意9（確定）: 全社系ボタンの参照切替条件

- 対象: 全社系ボタン（例: 宿泊/現場など、`enj` と `net` の両divisionを跨ぐ集計）。
- 「前月度」処理時は、管理ドキュメントを参照して切替判定を行う。
- **`enj` と `net` の両方が締め完了のときのみ**、参照先を `daily_reports_snapshot` に切り替える。
- どちらか片方でも未完了なら、参照先は従来どおり `daily_reports` とする。

### 合意10（記録）: 宿泊判定の将来移行を見据えたメモ

- 現在、宿泊判定（宿泊費申請の元データ）は Jobcan 側を参照している。
- 将来的に、宿泊判定を本ツール側で実施する可能性がある（Jobcan申請からの移行可能性あり）。
- そのため、全社系集計で「どのデータソースを参照しているか（Jobcan / daily_reports / daily_reports_snapshot）」の設計判断は README に継続記録する。
- 締め処理実装時点では、宿泊判定ロジックの移行はスコープ外とし、別タスクで扱う。

---

## 文字エンコーディング

日本語を含む本文は **UTF-8（BOM なし）** で保存する。
