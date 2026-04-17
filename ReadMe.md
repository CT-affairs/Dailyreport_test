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
| 2026-04-16 | `context.md.example` に沿った README 初版 |

---

## 文字エンコーディング

日本語を含む本文は **UTF-8（BOM なし）** で保存する。
