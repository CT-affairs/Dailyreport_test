// --- 設定 (liff-app.jsと同じものを使用) ---
const LIFF_ID = "2008638177-6GA6Mf63"; // ←ここに実際のLIFF IDを貼り付けてください
const API_BASE_URL = "https://dailyreport-service-1088643883290.asia-northeast1.run.app";

/**
 * 認証情報付きでAPIにリクエストを送信するfetchのラッパー関数
 * (liff-app.jsから複製。後で共通化する)
 */
async function fetchWithAuth(url, options = {}) {
    if (!liff.isLoggedIn()) {
        throw new Error("ログインしていません。");
    }
    const idToken = await liff.getIDToken();
    
    const headers = {
        ...options.headers,
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
    };
    
    // cache: 'no-cache' を追加して、ブラウザキャッシュを無効化する
    const response = await fetch(url, { ...options, headers, cache: 'no-cache' });

    // 401エラー（認証エラー）かつトークン期限切れの場合の自動復旧処理
    if (response.status === 401) {
        const errorData = await response.clone().json().catch(() => ({}));
        // バックエンドからのエラーメッセージに「有効期限」などが含まれている場合
        if (errorData.message && (errorData.message.includes("有効期限") || errorData.message.includes("トークン"))) {
            console.warn("トークン有効期限切れを検知。再ログインを実行します。");
            // ★リロード前に代理入力中の下書きを保存
            saveProxyDraftReport();

            liff.logout();
            window.location.reload();
            throw new Error("セッションの有効期限が切れました。再読み込みしています...");
        }
    }
    return response;
}

/**
 * ユーザー情報を取得してサイドバーに表示する
 */
async function updateUserInfo() {
    const userInfoContainer = document.getElementById('admin-user-info');
    userInfoContainer.textContent = '読込中...';

    try {
        // 1. LINEのプロフィールを取得 (表示名など)
        const profile = await liff.getProfile();
        
        // 2. 社内システムのユーザー情報を取得 (社員ID、権限など)
        //    ※未登録の場合は404が返る可能性があるためハンドリング
        let systemUser = null;
        let fetchError = null;

        try {
            const response = await fetchWithAuth(`${API_BASE_URL}/api/user`);
            if (response.ok) {
                const userData = await response.json();
                cachedAdminUserInfo = userData; // ★グローバル変数にキャッシュ
                systemUser = userData;
            } else if (response.status !== 404) {
                fetchError = `通信エラー (${response.status})`;
            }
        } catch (e) {
            console.warn("システムユーザー情報の取得に失敗:", e);
            fetchError = "通信失敗";
        }

        // 3. 表示の更新
        let html = `<div style="font-weight:bold; margin-bottom:4px;">${escapeHTML(profile.displayName)}</div>`;
        
        if (systemUser && systemUser.employeeId) {
            html += `<div style="font-size:0.8em;">ID: ${systemUser.employeeId}</div>`;

            // グループIDに基づいて表示名を解釈する
            let groupDisplayName = '全社/その他'; // デフォルト
            const mainGroupId = systemUser.main_group; // APIから 'main_group' キーでIDが渡される

            if (mainGroupId === '3' || mainGroupId === 3) {
                groupDisplayName = 'ネット事業部';
            } else if (mainGroupId !== null && mainGroupId !== undefined) {
                groupDisplayName = '工務部';
            }
            html += `<div style="font-size:0.8em;">所属: ${groupDisplayName}</div>`;
            
            // 管理者判定
            const isSystemAdmin = systemUser.is_system_admin === true || systemUser.is_system_admin === 1 || systemUser.is_system_admin === '1';
            const isExecutive = systemUser.is_executive === true || systemUser.is_executive === 1 || systemUser.is_executive === '1';

            if (isSystemAdmin) {
                html += `<div style="font-size:0.8em; color:#cfd138;">[システム管理者]</div>`;
            } else if (systemUser.is_manager) {
                if (isExecutive) {
                    html += `<div style="font-size:0.8em; color:#f39c12;">[管理者[上位]]</div>`;
                } else {
                    html += `<div style="font-size:0.8em; color:#2ecc71;">[管理者]</div>`;
                }
            } else {
                html += `<div style="font-size:0.8em; color:#3498db;">[ユーザー]</div>`;
            }
        } else if (fetchError) {
            html += `<div style="font-size:0.8em; color:red;">${fetchError}</div>`;
        } else {
            html += `<div style="font-size:0.8em; color:#f39c12;">ID未登録</div>`;
        }

        // ログアウトボタンを追加
        html += `
            <div style="margin-top: 12px; padding-top: 8px; border-top: 1px solid #34495e;">
                <button id="logout-btn" style="width: 100%; padding: 6px; background-color: #6aaacf; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.8em;">ログアウト</button>
            </div>`;

        userInfoContainer.innerHTML = html;

        // ログアウトボタンのイベントリスナー
        document.getElementById('logout-btn').addEventListener('click', () => {
            if (liff.isLoggedIn()) {
                liff.logout();
                // ページをリロードすることで、main()関数が再度走り、liff.init() -> liff.login() のフローで新しいトークンが取得されます
                window.location.reload();
            }
        });

        // --- メニューの表示制御 ---
        const koumuMenuItems = document.querySelectorAll('.menu-koumu');
        const netMenuItems = document.querySelectorAll('.menu-net');

        const showKoumu = () => koumuMenuItems.forEach(el => el.style.display = '');
        const hideKoumu = () => koumuMenuItems.forEach(el => el.style.display = 'none');
        const showNet = () => netMenuItems.forEach(el => el.style.display = '');
        const hideNet = () => netMenuItems.forEach(el => el.style.display = 'none');

        if (systemUser) {
            const isSystemAdmin = systemUser.is_system_admin === true || systemUser.is_system_admin === 1 || systemUser.is_system_admin === '1';
            const mainGroupId = systemUser.main_group;

            if (isSystemAdmin) {
                // システム管理者は全て表示
                showKoumu();
                showNet();
            } else {
                if (mainGroupId === '3' || mainGroupId === 3) {
                    // ネット事業部
                    hideKoumu();
                    showNet();
                } else if (mainGroupId === null || mainGroupId === undefined) {
                    // 全社/その他
                    showKoumu();
                    showNet();
                } else {
                    // 工務部 (3以外のID)
                    showKoumu();
                    hideNet();
                }
            }
        } else {
            // ユーザー情報が取得できない場合は、安全のため両方非表示にする
            hideKoumu();
            hideNet();
        }

    } catch (error) {
        console.error("ユーザー情報の表示エラー:", error);
        userInfoContainer.textContent = '取得エラー';
    }
}

/**
 * 文字列をHTMLエスケープする
 */
function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, function(match) {
        return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[match];
    });
}

/**
 * データをブラウザでダウンロードする
 */
function downloadCSV(filename, csvData) {
    // BOMを付与してExcelでの文字化けを防ぐ
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvData], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * Base64文字列をExcelファイルとしてダウンロードする
 */
function downloadExcelFromBase64(filename, base64Content) {
    // Base64をデコードしてバイナリデータに変換
    const bin = atob(base64Content);
    const buffer = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        buffer[i] = bin.charCodeAt(i);
    }
    // Blobを作成
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * HTMLファイルを読み込んでその内容を文字列として返す関数
 * @param {string} htmlFile 読み込むHTMLファイルへのパス
 * @returns {Promise<string>} 読み込んだHTMLの文字列
 */
async function fetchHtmlAsString(htmlFile) {
    try {
        // キャッシュ対策: fetchのオプションでキャッシュを無効化する方式に統一
        const response = await fetch(htmlFile, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`HTMLファイルの読み込みに失敗しました: ${response.statusText}`);
        }
        return await response.text();
    } catch (error) {
        console.error('HTMLの読み込みエラー:', error);
        throw error; // エラーを呼び出し元に伝播させる
    }
}

/**
 * トースト通知を表示する
 * @param {string} message 表示するメッセージ
 * @param {string} type 通知タイプ ('success', 'error', 'info')
 */
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    container.appendChild(toast);

    // 10秒後にフェードアウトして削除
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 500); // transitionの時間に合わせる
    }, 10000);
}

// --- カテゴリ設定用の状態変数 ---
let allCategoryData = [];
let filteredCategoryData = [];
let currentCategoryPage = 1;
const CATEGORY_PAGE_SIZE = 25;
let categorySortOrder = 'desc'; // 'desc' or 'asc'
let categorySortKey = 'order'; // 'order' or 'label'

// --- ユーザー情報 ---
let cachedAdminUserInfo = null; // ログイン中の管理者情報を保持する

/**
 * 管理者権限チェックを行い、実行可否を返す
 * @returns {Promise<boolean>} 実行してよければ true, キャンセルまたは権限なしなら false
 */
async function checkAdminPermission() {
    return new Promise((resolve) => {
        // 管理者かどうかを判定 (cachedAdminUserInfoが未取得の場合はfalse扱い)
        const isManager = cachedAdminUserInfo && cachedAdminUserInfo.is_manager === true;
        
        // モーダルのオーバーレイ
        const modalOverlay = document.createElement('div');
        modalOverlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background-color: rgba(0,0,0,0.5); z-index: 99999;
            display: flex; justify-content: center; align-items: center;
        `;
        
        // モーダルのコンテンツ
        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
            background: white; padding: 25px; border-radius: 8px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3); max-width: 400px; width: 90%;
            text-align: center; font-family: sans-serif;
        `;
        
        const messageBody = document.createElement('p');
        messageBody.textContent = '管理者のみが実行可能な操作です。';
        messageBody.style.marginBottom = '25px';
        messageBody.style.fontWeight = 'bold';
        
        // --- Add styles for the modal buttons ---
        const styleId = 'permission-modal-style';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .permission-modal-btn {
                    padding: 10px 20px;
                    border-radius: 4px;
                    font-size: 0.9rem;
                    cursor: pointer;
                    transition: background-color 0.2s, border-color 0.2s;
                    font-weight: bold;
                    border: 1px solid;
                }
                .permission-modal-btn-execute {
                    background-color: #2ecc71;
                    color: white;
                    border-color: #27ae60;
                }
                .permission-modal-btn-execute:hover {
                    background-color: #28b463;
                    border-color: #259d58;
                }
                .permission-modal-btn-cancel {
                    background-color: #f0f0f0;
                    color: #333;
                    border-color: #ccc;
                }
                .permission-modal-btn-cancel:hover {
                    background-color: #e0e0e0;
                    border-color: #bbb;
                }
            `;
            document.head.appendChild(style);
        }

        const btnContainer = document.createElement('div');
        btnContainer.style.display = 'flex';
        btnContainer.style.justifyContent = 'center';
        btnContainer.style.gap = '25px'; // ボタンの間隔を広げる
        
        // 管理者の場合のみ「実行」ボタンを追加 (先に追加することで左側に配置)
        if (isManager) {
            const executeBtn = document.createElement('button');
            executeBtn.textContent = '実行';
            executeBtn.className = 'permission-modal-btn permission-modal-btn-execute';
            executeBtn.onclick = () => {
                document.body.removeChild(modalOverlay);
                resolve(true);
            };
            btnContainer.appendChild(executeBtn);
        }
        
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '戻る';
        closeBtn.className = 'permission-modal-btn permission-modal-btn-cancel';
        closeBtn.onclick = () => {
            document.body.removeChild(modalOverlay);
            resolve(false);
        };
        btnContainer.appendChild(closeBtn);
        
        modalContent.appendChild(messageBody);
        modalContent.appendChild(btnContainer);
        modalOverlay.appendChild(modalContent);
        document.body.appendChild(modalOverlay);
    });
}

// --- 日報一覧用の状態変数 ---
let allDashboardData = []; // APIから取得した全データ
let filteredDashboardData = []; // フィルタリング後のデータ
let dashboardListMode = 'koumu'; // 'koumu' | 'net'

// --- スタッフ別カレンダー用の状態変数 ---
let staffList = []; // APIから取得した全従業員リスト
let staffCalendarStatuses = {}; // 選択した従業員の日報ステータス
let currentCalendarEmployeeId = null; // 現在選択中の従業員ID
let currentCalendarReportMonth = null; // 現在表示している月度
const closingDay = 20; // 月度締め日 (TODO: liff-app.jsのようにAPIから取得する共通処理にする)
const dateToMonthMap = {}; // 日付文字列(YYYY-MM-DD) -> 月度(Dateオブジェクト) のマッピング

// --- UI操作・画面描画 ---

/**
 * サイドバーのナビゲーション設定
 */
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();

            const target = item.dataset.target;
            handleNavigation(target);
        });
    });

    // ブラウザの戻る/進むボタンに対応
    window.addEventListener('popstate', (event) => {
        if (event.state && event.state.target) {
            // history.stateから復元する際は、新しい履歴を追加しない
            handleNavigation(event.state.target, event.state.params || {}, { push: false });
        } else {
            // 最初のページなど、stateがない場合
            handleNavigation('home', {}, { push: false });
        }
    });

    // 更新ボタン
    document.getElementById('refresh-button').addEventListener('click', async () => {
        const activeTarget = document.querySelector('.nav-item.active').dataset.target;
        if (activeTarget === 'dashboard' || activeTarget === 'dashboard_net') {
            // Jobcanから最新の勤務時間を取得して画面を更新する
            await refreshWorkTimes();
        } else {
            alert('この画面の更新機能は未実装です');
        }
    });

    // 日付変更時
    const dateInput = document.getElementById('target-date');
    // 初期値を今日に設定
    dateInput.value = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
    dateInput.addEventListener('change', () => {
        const activeTarget = document.querySelector('.nav-item.active').dataset.target;
        if (activeTarget === 'dashboard' || activeTarget === 'dashboard_net') {
            loadDashboardData();
        }
    });

    // グループ変更時
    const groupSelect = document.getElementById('target-group');
    if (groupSelect) {
        groupSelect.addEventListener('change', () => {
            filterDashboardData();
        });
    }
}

/**
 * 画面の切り替え処理
 */
function handleNavigation(target, params = {}, options = { push: true }) {
    const pageTitle = document.getElementById('page-title');
    const contentArea = document.getElementById('content-area');
    const topBarActions = document.querySelector('.top-bar-actions');

    // URLと履歴の更新
    if (options.push) {
        const state = { target, params };
        // ページ内遷移なのでハッシュを使う
        const newUrl = `${window.location.pathname}${window.location.search}#${target}`;
        history.pushState(state, '', newUrl);
    }

    // アクティブなナビゲーション項目を更新
    document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
    document.querySelector(`.nav-item[data-target="${target}"]`)?.classList.add('active');

    // ヘッダーアクション（グループ選択、日付選択、更新ボタン）の表示制御
    if (topBarActions) {
        // 日報一覧画面以外では非表示にする
        topBarActions.style.display = (target === 'dashboard' || target === 'dashboard_net') ? 'flex' : 'none';
    }

    switch(target) {
        case 'home':
            pageTitle.textContent = 'ダッシュボード';
            renderDashboardHome(contentArea);
            break;

        case 'dashboard':
            pageTitle.textContent = '日報_拠点ごと一覧';
            dashboardListMode = 'koumu';
            // 工務: グループ選択を有効
            const groupSelectKoumu = document.getElementById('target-group');
            if (groupSelectKoumu) {
                groupSelectKoumu.disabled = false;
                groupSelectKoumu.style.display = '';
            }
            // 突合テーブルのHTML構造を復元
            contentArea.innerHTML = `
                <div class="table-container">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>日付</th>
                                <th>社員名</th>
                                <th>勤務時間</th>
                                <th>工数合計</th>
                                <th>差分</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="comparison-table-body">
                            <tr><td colspan="6" style="text-align:center; padding: 2em;">データを読み込み中...</td></tr>
                        </tbody>
                    </table>
                </div>`;
            loadDashboardData();
            break;

        case 'dashboard_net':
            pageTitle.textContent = '日報_一覧（ネット事業部）';
            dashboardListMode = 'net';
            // ネット: メイングループ '3' 固定で表示
            const groupSelectNet = document.getElementById('target-group');
            if (groupSelectNet) {
                // ネット画面ではプルダウン自体を使わない（工務専用のため）
                groupSelectNet.disabled = true;
                groupSelectNet.style.display = 'none';
            }
            // 突合テーブルのHTML構造を復元（工務と共通）
            contentArea.innerHTML = `
                <div class="table-container">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>日付</th>
                                <th>社員名</th>
                                <th>勤務時間</th>
                                <th>工数合計</th>
                                <th>差分</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="comparison-table-body">
                            <tr><td colspan="6" style="text-align:center; padding: 2em;">データを読み込み中...</td></tr>
                        </tbody>
                    </table>
                </div>`;
            loadDashboardData();
            break;
            
        case 'staff_calendar':
            pageTitle.textContent = '日報_スタッフ個別';
            renderStaffCalendarUI(contentArea, params);
            break;

        case 'staff_calendar_net':
            // 表示するカレンダー自体は共通ロジックを流用
            pageTitle.textContent = '日報_個別（ネット事業部）';
            dashboardListMode = 'net'; // ネットメニューからの遷移として扱う
            renderStaffCalendarUI(contentArea, params);
            break;

        case 'tasks_current':
            pageTitle.textContent = '工番別集計';
            renderTaskAggregationUI(contentArea, 'current', params);
            break;

        case 'tasks_previous':
            pageTitle.textContent = '（旧）工番別集計'; // このメニューは残しますが、実質的には使われなくなります
            renderTaskAggregationUI(contentArea, 'previous');
            break;
            
        case 'users':
            pageTitle.textContent = 'ID登録・管理';
            contentArea.innerHTML = '<div style="padding:20px;">ID登録・管理画面（準備中）</div>';
            break;
            
        case 'categories':
            pageTitle.textContent = '工事番号一覧';
            renderCategorySettingsUI(contentArea);
            break;

        case 'category_a_settings':
            pageTitle.textContent = '業務種別設定';
            renderCategoryASettingsUI(contentArea);
            break;
            
        case 'groups':
            pageTitle.textContent = 'グループ設定';
            contentArea.innerHTML = '<div style="padding:20px;">グループ設定画面（準備中）</div>';
            break;

        case 'system_admin':
            pageTitle.textContent = 'システム管理';
            renderSystemAdminUI(contentArea);
            break;
    }
}

/**
 * ダッシュボード（ホーム）画面の描画
 */
async function renderDashboardHome(container) {
    // ネイビーとグリーンのカラーコードを定義
    const navyColor = '#083969'; // 見出し用
    const greenColor = '#397939'; // 工務ボタン
    const greenBorderColor = '#27692b';
    const wineRedColor = '#a94442'; // ネットボタン
    const wineRedBorderColor = '#8a2c2a';
    const grayColor = '#6c757d'; // 全社ボタン
    const grayBorderColor = '#5a6268';
    const buttonSizeStyle = 'padding: 4px 10px; font-size: 0.9em;';

    container.innerHTML = `
        <div class="dashboard-container" style="padding: 20px; max-width: 1000px;">

            <!-- 上部: 改修情報 -->
            <div class="card" style="background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; position: relative;">
                <!-- 隠しボタン: システム管理へ -->
                <div id="goto-sys-admin-btn" style="position: absolute; top: 10px; right: 10px; width: 20px; height: 20px; border: 1px solid rgba(0,0,0,0.1); cursor: pointer; z-index: 100;" title="管理"></div>
                <h3 style="margin-top: 0; border-bottom: 1px solid #eee; padding-bottom: 10px; font-size: 1.2em; color: #2c3e50;">システム改修情報</h3>
                <div style="display: flex; gap: 40px; flex-wrap: wrap;">
                    <div style="flex: 1; min-width: 300px;">
                        <h4 style="color: #e67e22; margin-bottom: 10px; border-left: 4px solid #e67e22; padding-left: 10px;">改修予定</h4>
                        <div style="height: 120px; overflow-y: auto; border: 1px solid #f0f0f0; border-radius: 4px; padding: 5px; background-color: #fafafa;">
                            <ul id="dashboard-plan-list" style="margin: 0; font-size: 0.9em; line-height: 1.6; padding-left: 20px; color: #555;"><li>読み込み中...</li></ul>
                        </div>
                    </div>
                    <div style="flex: 1; min-width: 300px;">
                        <h4 style="color: #2ecc71; margin-bottom: 10px; border-left: 4px solid #2ecc71; padding-left: 10px;">改修履歴</h4>
                        <div style="height: 120px; overflow-y: auto; border: 1px solid #f0f0f0; border-radius: 4px; padding: 5px; background-color: #fafafa;">
                            <ul id="dashboard-history-list" style="margin: 0; font-size: 0.9em; line-height: 1.6; padding-left: 20px; color: #666;"><li>読み込み中...</li></ul>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 中部: 集計表ダウンロード -->
            <div class="card" style="background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px;">
                <h3 style="margin-top: 0; border-bottom: 1px solid #eee; padding-bottom: 10px; font-size: 1.2em; color: #2c3e50;">集計表ダウンロード -エクセル形式-</h3>
                
                <!-- Row 1: 工務 & 全社 -->
                <div style="display: flex; gap: 20px; flex-wrap: wrap; margin-top: 15px; margin-bottom: 20px;">
                    <!-- 工番別 (工務) -->
                    <div style="flex: 1; min-width: 220px;">
                        <h4 style="margin: 0 0 8px 0; font-size: 1em; color: ${navyColor};">工番別(工務)</h4>
                        <div style="display: flex; gap: 10px;">
                            <button id="koumu-kouban-curr-btn" class="btn-dashboard-action" style="background-color: ${greenColor}; border-color: ${greenBorderColor}; ${buttonSizeStyle}">当月度</button>
                            <button id="koumu-kouban-prev-btn" class="btn-dashboard-action" style="background-color: ${greenColor}; border-color: ${greenBorderColor}; ${buttonSizeStyle}">前月度</button>
                        </div>
                    </div>
                    <!-- スタッフ別(工務) -->
                    <div style="flex: 1; min-width: 220px;">
                        <h4 style="margin: 0 0 8px 0; font-size: 1em; color: ${navyColor};">スタッフ別(工務)</h4>
                        <div style="display: flex; gap: 10px;">
                            <button id="koumu-staff-curr-btn" class="btn-dashboard-action" style="background-color: ${greenColor}; border-color: ${greenBorderColor}; ${buttonSizeStyle}">当月度</button>
                            <button id="koumu-staff-prev-btn" class="btn-dashboard-action" style="background-color: ${greenColor}; border-color: ${greenBorderColor}; ${buttonSizeStyle}">前月度</button>
                        </div>
                    </div>
                    <!-- 宿泊/現場(全社) -->
                    <div style="flex: 1; min-width: 220px;">
                        <h4 style="margin: 0 0 8px 0; font-size: 1em; color: ${navyColor};">宿泊/現場(全社)</h4>
                        <div style="display: flex; gap: 10px;">
                            <button id="shukuhaku-zenkoku-curr-btn" class="btn-dashboard-action" style="background-color: ${grayColor}; border-color: ${grayBorderColor}; ${buttonSizeStyle}">当月度</button>
                            <button id="shukuhaku-zenkoku-prev-btn" class="btn-dashboard-action" style="background-color: ${grayColor}; border-color: ${grayBorderColor}; ${buttonSizeStyle}">前月度</button>
                        </div>
                    </div>
                </div>

                <!-- Row 2: ネット -->
                <div style="display: flex; gap: 20px; flex-wrap: wrap; margin-top: 15px;">
                    <!-- 業務別(ネット) -->
                    <div style="flex: 1; min-width: 220px;">
                        <h4 style="margin: 0 0 8px 0; font-size: 1em; color: ${navyColor};">業務別(ネット)</h4>
                        <div style="display: flex; gap: 10px;">
                            <button id="net-gyomu-curr-btn" class="btn-dashboard-action" style="background-color: ${wineRedColor}; border-color: ${wineRedBorderColor}; ${buttonSizeStyle}">当月度</button>
                            <button id="net-gyomu-prev-btn" class="btn-dashboard-action" style="background-color: ${wineRedColor}; border-color: ${wineRedBorderColor}; ${buttonSizeStyle}">前月度</button>
                        </div>
                    </div>
                    <!-- スタッフ別(ネット) -->
                    <div style="flex: 1; min-width: 220px;">
                        <h4 style="margin: 0 0 8px 0; font-size: 1em; color: ${navyColor};">スタッフ別(ネット)</h4>
                        <div style="display: flex; gap: 10px;">
                            <button id="net-staff-curr-btn" class="btn-dashboard-action" style="background-color: ${wineRedColor}; border-color: ${wineRedBorderColor}; ${buttonSizeStyle}">当月度</button>
                            <button id="net-staff-prev-btn" class="btn-dashboard-action" style="background-color: ${wineRedColor}; border-color: ${wineRedBorderColor}; ${buttonSizeStyle}">前月度</button>
                        </div>
                    </div>
                    <!-- 残業/休出(全社) - 非表示のスペーサー -->
                    <div style="flex: 1; min-width: 220px; visibility: hidden;">
                        <h4 style="margin: 0 0 8px 0; font-size: 1em; color: ${navyColor};">残業/休出(全社)</h4>
                        <div style="display: flex; gap: 10px;">
                            <button id="zankyu-zensha-curr-btn" class="btn-dashboard-action" style="${buttonSizeStyle}">当月度</button>
                            <button id="zankyu-zensha-prev-btn" class="btn-dashboard-action" style="${buttonSizeStyle}">前月度</button>
                        </div>
                    </div>
                </div>

                <p style="font-size: 0.85em; color: #7f8c8d; margin-top: 15px; line-height: 1.4;">
                    ※当月度集計は暫定値です。ジョブカン勤務時間のとおりに日報入力完了後「正」のデータにできます。<br>
                    ※この機能は経費を使います。クリック連打は厳禁です。1クリック3円程度かかります。
                </p>
            </div>

            <!-- 全社連絡 (非表示) -->
            <!--
            <div class="company-announcement-section"> ... </div>
            -->

            <!-- 下部: 設定 (非表示) -->
            <!--
            <div class="card" style="background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"> ... </div>
            -->
        </div>
    `;

    // ★非表示にしたため、関連コードをコメントアウト
    // const unitPriceSettings = [
    //     { id: 'setting-unit-price-meeting', key: 'admin_unit_price_meeting' },
    //     { id: 'setting-unit-price-head-prod', key: 'admin_unit_price_head_prod' },
    //     { id: 'setting-unit-price-yokkaichi', key: 'admin_unit_price_yokkaichi' },
    //     { id: 'setting-unit-price-hanamaki', key: 'admin_unit_price_hanamaki' },
    //     { id: 'setting-unit-price-chitose', key: 'admin_unit_price_chitose' }
    // ];

    // 隠しボタンのイベント
    document.getElementById('goto-sys-admin-btn').addEventListener('click', () => {
        handleNavigation('system_admin');
    });

    // Excelダウンロードボタン（API経由）
    const handleExcelDownload = async (targetMonth, btnId) => {
        const btn = document.getElementById(btnId);
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '生成中...';

        try {
            const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/project-summary/excel`, {
                method: 'POST',
                body: JSON.stringify({ target_month: targetMonth })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || `ダウンロード失敗: ${response.status}`);
            }

            const result = await response.json();
            downloadExcelFromBase64(result.file_name, result.file_content);

        } catch (error) {
            console.error('Excel download error:', error);
            alert(`エラーが発生しました: ${error.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    };

    // スタッフ別集計表ダウンロード処理（工番別をコピー）
    const handleStaffSummaryDownload = async (targetMonth, btnId) => {
        const btn = document.getElementById(btnId);
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '生成中...';

        try {
            // NOTE: バックエンドに /api/manager/staff-summary/excel の実装が必要です。
            const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/staff-summary/excel`, {
                method: 'POST',
                body: JSON.stringify({ target_month: targetMonth })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || `ダウンロード失敗: ${response.status}`);
            }

            const result = await response.json();
            downloadExcelFromBase64(result.file_name, result.file_content);

        } catch (error) {
            console.error('Staff summary download error:', error);
            alert(`エラーが発生しました: ${error.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    };

    // --- 新しいボタンIDに対応したイベントリスナー ---
    // 工番別(工務)
    document.getElementById('koumu-kouban-curr-btn').addEventListener('click', () => handleExcelDownload('current', 'koumu-kouban-curr-btn'));
    document.getElementById('koumu-kouban-prev-btn').addEventListener('click', () => handleExcelDownload('previous', 'koumu-kouban-prev-btn'));

    // スタッフ別(工務)
    document.getElementById('koumu-staff-curr-btn').addEventListener('click', () => handleStaffSummaryDownload('current', 'koumu-staff-curr-btn'));
    document.getElementById('koumu-staff-prev-btn').addEventListener('click', () => handleStaffSummaryDownload('previous', 'koumu-staff-prev-btn'));

    // 宿泊/現場(全社) - スタッフ別と同じ処理を呼ぶ
    document.getElementById('shukuhaku-zenkoku-curr-btn').addEventListener('click', () => handleStaffSummaryDownload('current', 'shukuhaku-zenkoku-curr-btn'));
    document.getElementById('shukuhaku-zenkoku-prev-btn').addEventListener('click', () => handleStaffSummaryDownload('previous', 'shukuhaku-zenkoku-prev-btn'));

    // 業務別(ネット) - スタッフ別と同じ処理を呼ぶ
    document.getElementById('net-gyomu-curr-btn').addEventListener('click', () => handleStaffSummaryDownload('current', 'net-gyomu-curr-btn'));
    document.getElementById('net-gyomu-prev-btn').addEventListener('click', () => handleStaffSummaryDownload('previous', 'net-gyomu-prev-btn'));

    // スタッフ別(ネット)
    document.getElementById('net-staff-curr-btn').addEventListener('click', () => handleStaffSummaryDownload('current', 'net-staff-curr-btn'));
    document.getElementById('net-staff-prev-btn').addEventListener('click', () => handleStaffSummaryDownload('previous', 'net-staff-prev-btn'));

    // 残業/休出(全社) - 非表示だが念のためリスナーを追加
    document.getElementById('zankyu-zensha-curr-btn').addEventListener('click', () => handleStaffSummaryDownload('current', 'zankyu-zensha-curr-btn'));
    document.getElementById('zankyu-zensha-prev-btn').addEventListener('click', () => handleStaffSummaryDownload('previous', 'zankyu-zensha-prev-btn'));

    // ★非表示にしたため、関連コードをコメントアウト
    // 値の読み込み (localStorageから)
    // if (document.getElementById('setting-unit-price-meeting')) { ... }

    // ★非表示にしたため、関連コードをコメントアウト
    // 保存ボタンイベント
    // document.getElementById('save-settings-btn')?.addEventListener('click', async () => { ... });

    // ★非表示にしたため、関連コードをコメントアウト
    // 全社連絡送信ボタンイベント
    // document.getElementById('announcement-send-btn')?.addEventListener('click', async () => { ... });

    // お知らせデータの取得と表示
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/system-notices`);
        if (response.ok) {
            const notices = await response.json();
            
            const planList = document.getElementById('dashboard-plan-list');
            const historyList = document.getElementById('dashboard-history-list');
            
            if (planList) planList.innerHTML = '';
            if (historyList) historyList.innerHTML = '';

            // 履歴(history)と予定(plan)に分割
            const historyItems = notices.filter(n => n.type === 'history'); // APIが新しい順なので、そのままでOK
            const planItems = notices.filter(n => n.type === 'plan');
            
            // 予定は古い順(昇順)にソート
            planItems.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

            // 履歴を描画 (新しい順)
            historyItems.forEach(notice => {
                const li = document.createElement('li');
                li.innerHTML = `<strong>${escapeHTML(notice.date)}:</strong> ${escapeHTML(notice.content)}`;
                if (historyList) historyList.appendChild(li);
            });

            // 予定を描画 (古い順)
            planItems.forEach(notice => {
                const li = document.createElement('li');
                li.textContent = escapeHTML(notice.content);
                if (planList) planList.appendChild(li);
            });

            if (planList && planList.children.length === 0) planList.innerHTML = '<li>予定はありません</li>';
            if (historyList && historyList.children.length === 0) historyList.innerHTML = '<li>履歴はありません</li>';
        }
    } catch (error) {
        console.error("お知らせの取得に失敗:", error);
        // エラー表示は控えめに
    }
}

/**
 * 工番別集計画面のUIを描画
 */
async function renderTaskAggregationUI(container, period, params = {}) {
    // period は 'current' または 'previous'。
    // 'previous' の場合は旧UIのままにする（今回は何もしない）
    if (period === 'previous') {
        container.innerHTML = `<div style="padding: 20px;">この機能は新しい「工番別集計」に統合されました。</div>`;
        return;
    }

    container.innerHTML = `
        <div class="filter-bar" style="padding: 10px; background-color: #f8f9fa; border-bottom: 1px solid #e9ecef; display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end;">
            <div>
                <label for="task-agg-direct-input" style="display: block; font-size: 0.8em; margin-bottom: 2px;">工事番号 (直接入力)</label>
                <input type="text" id="task-agg-direct-input" placeholder="例: 240001" style="padding: 6px; border-radius: 4px; border: 1px solid #ccc; width: 140px;">
            </div>
            <div style="font-size: 1.2em; color: #ccc; padding-bottom: 5px;">または</div>
            <div>
                <label for="task-agg-client-select" style="display: block; font-size: 0.8em; margin-bottom: 2px;">顧客から選択</label>
                <select id="task-agg-client-select" style="padding: 6px; border-radius: 4px; border: 1px solid #ccc; width: 250px;">
                    <option value="">-- 顧客を選択 --</option>
                </select>
            </div>
            <div>
                <label for="task-agg-kouban-select" style="display: block; font-size: 0.8em; margin-bottom: 2px;">工事番号</label>
                <select id="task-agg-kouban-select" style="padding: 6px; border-radius: 4px; border: 1px solid #ccc; width: 300px;" disabled>
                    <option value=""></option>
                </select>
            </div>
            <div>
                <label style="display: block; font-size: 0.8em; margin-bottom: 2px;">基準日</label>
                <span id="task-agg-display-date" style="padding: 6px 0; font-weight: bold; display: inline-block;"></span>
            </div>
            <div>
                <button id="task-agg-button" class="btn-primary" style="padding: 6px 12px;">【当月度】集計実行</button>
            </div>
            <div>
                <button id="task-agg-button-prev" class="btn-primary" style="padding: 6px 12px;">【前月度】集計実行</button>
            </div>
        </div>

        <div id="task-aggregation-results" style="padding: 20px;">
            <p style="color: #666; text-align: center;">条件を選択または入力して「集計実行」ボタンを押してください。</p>
        </div>
    `;

    // 基準日を画面に表示
    const todayStr = new Date().toISOString().split('T')[0];
    document.getElementById('task-agg-display-date').textContent = todayStr;

    // --- データ取得とプルダウン設定 ---
    const clientSelect = document.getElementById('task-agg-client-select');
    const koubanSelect = document.getElementById('task-agg-kouban-select');
    let engineeringCategories = []; // 工務のカテゴリデータを保持

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b?kind=engineering`);
        if (!response.ok) throw new Error('カテゴリデータの取得に失敗しました');
        
        engineeringCategories = await response.json();

        // 顧客プルダウンの作成 (重複を除きソート)
        const clients = [...new Set(engineeringCategories.map(cat => cat.client).filter(Boolean))].sort();
        clients.forEach(client => {
            const option = document.createElement('option');
            option.value = client;
            option.textContent = client;
            clientSelect.appendChild(option);
        });

    } catch (error) {
        console.error(error);
        clientSelect.innerHTML = `<option value="">${error.message}</option>`;
    }

    // --- イベントリスナー設定 ---
    clientSelect.addEventListener('change', () => {
        const selectedClient = clientSelect.value;
        koubanSelect.innerHTML = ''; // いったんクリア
        
        if (selectedClient) {
            koubanSelect.disabled = false;
            
            const koubans = engineeringCategories
                .filter(cat => cat.client === selectedClient)
                .sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true })); // 工事番号で降順ソート

            koubans.forEach(cat => {
                const option = document.createElement('option');
                option.value = cat.label;
                option.textContent = `${cat.label} (${cat.project || '案件名なし'})`;
                koubanSelect.appendChild(option);
            });
        } else {
            koubanSelect.disabled = true;
            koubanSelect.innerHTML = '<option value=""></option>';
        }
    });

    // 工事番号を選択した際に直接入力フォームにも反映
    koubanSelect.addEventListener('change', () => {
        const directInput = document.getElementById('task-agg-direct-input');
        if (directInput) {
            directInput.value = koubanSelect.value;
        }
    });

    // 集計処理を共通化
    const handleAggregation = async (isPrevious = false) => {
        const directInput = document.getElementById('task-agg-direct-input').value.trim();
        const koubanFromSelect = document.getElementById('task-agg-kouban-select').value;
        
        // 直接入力があればそれを優先、なければプルダウンの選択値を使用
        const projectLabel = directInput || koubanFromSelect;
    
        if (!projectLabel) {
            alert('工事番号を入力または選択してください。');
            return;
        }
    
        // isPreviousフラグに基づいて基準日を計算
        const targetDate = new Date();
        if (isPrevious) {
            // 1ヶ月前の日付を計算して、前月度を正しく判定させる
            targetDate.setMonth(targetDate.getMonth() - 1);
        }
        const dateStr = targetDate.toISOString().split('T')[0];
    
        const resultsContainer = document.getElementById('task-aggregation-results');
        const currentButton = document.getElementById('task-agg-button');
        const prevButton = document.getElementById('task-agg-button-prev');
    
        // 処理中の表示
        resultsContainer.innerHTML = '<p style="text-align: center;">集計中...</p>';
        currentButton.disabled = true;
        prevButton.disabled = true;
        currentButton.textContent = '集計中...';
        prevButton.textContent = '集計中...';
    
        try {
            const url = `${API_BASE_URL}/api/manager/project-summary?project_label=${encodeURIComponent(projectLabel)}&date=${dateStr}`;
            const response = await fetchWithAuth(url);
    
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'サーバーエラーが発生しました。' }));
                throw new Error(errorData.message || `集計に失敗しました (コード: ${response.status})`);
            }
    
            const data = await response.json();
            // renderProjectSummaryTable を流用して結果を描画
            renderProjectSummaryTable(data, resultsContainer, dateStr);
    
        } catch (error) {
            console.error('Project summary fetch error:', error);
            resultsContainer.innerHTML = `<p class="error" style="text-align: center;">エラー: ${error.message}</p>`;
        } finally {
            currentButton.disabled = false;
            prevButton.disabled = false;
            currentButton.textContent = '【当月度】集計実行';
            prevButton.textContent = '【前月度】集計実行';
        }
    };

    // 「集計実行」ボタンの処理
    document.getElementById('task-agg-button').addEventListener('click', () => handleAggregation(false)); // 当月度
    document.getElementById('task-agg-button-prev').addEventListener('click', () => handleAggregation(true)); // 前月度

    // --- パラメータによる初期値設定 ---
    if (params && params.kouban) {
        const directInput = document.getElementById('task-agg-direct-input');
        if (directInput) {
            directInput.value = params.kouban;
        }
    }
}

/**
 * 指定されたグループと日付でダッシュボードに遷移するヘルパー関数
 * @param {string} groupId - グループID
 * @param {string} dateStr - 日付文字列 (YYYY-MM-DD)
 */
function navigateToDashboard(groupId, dateStr) {
    const groupSelect = document.getElementById('target-group');
    const dateInput = document.getElementById('target-date');
    
    if (groupSelect && groupId) {
        groupSelect.value = groupId;
    }
    if (dateInput && dateStr) {
        dateInput.value = dateStr;
    }

    // "日報_グループ別" のナビゲーション項目をプログラム的にクリックして画面遷移
    const dashboardNavItem = document.querySelector('.nav-item[data-target="dashboard"]');
    if (dashboardNavItem) {
        dashboardNavItem.click();
    }
}

/**
 * 集計結果をマトリクス表として描画する
 * @param {object} data - APIからのレスポンスデータ
 * @param {HTMLElement} container - 描画先のコンテナ要素
 * @param {string} baseDateStr - 集計の基準日 (リンク生成用)
 */
function renderProjectSummaryTable(data, container, baseDateStr) {
    const resultsContainer = container;
    const { employees, rows, project_label, client, project, start_date, end_date } = data;

    if (!rows || rows.length === 0) {
        resultsContainer.innerHTML = `
            <div style="margin-bottom: 10px; font-size: 0.9em;">
                <span><strong>工事番号:</strong> ${escapeHTML(project_label)}</span>
                <span style="margin-left: 20px;"><strong>集計期間:</strong> ${start_date} 〜 ${end_date}</span>
            </div>
            <p style="text-align: center;">指定された条件に該当するデータはありませんでした。</p>
        `;
        return;
    }

    // 工事番号の表示文字列を作成 (clientとprojectを連結)
    let projectDisplay = escapeHTML(project_label);
    if (client || project) {
        projectDisplay += ` ${escapeHTML(client || '')} ${escapeHTML(project || '')}`;
    }

    // --- 合計計算 ---
    // 列合計 (従業員ごと)
    const columnTotals = new Array(employees ? employees.length : 0).fill(0);
    // 行合計を計算しつつ、新しいrows配列を作成
    const newRows = rows.map(row => {
        // row[0]は日付なので、row[1]からが数値データ
        const numericValues = row.slice(1);
        const rowTotal = numericValues.reduce((sum, val) => sum + val, 0);
        
        // 列合計にも加算
        numericValues.forEach((val, index) => {
            columnTotals[index] += val;
        });

        return [...row, rowTotal]; // 元の行に合計値を追加
    });

    // 総合計
    const grandTotal = columnTotals.reduce((sum, val) => sum + val, 0);

    // --- 表示列数の計算 ---
    const minWorkerColumns = 10; // 作業者列の最低表示数
    const actualWorkerCount = employees ? employees.length : 0;
    const emptyColumnCount = Math.max(0, minWorkerColumns - actualWorkerCount);

    // --- テーブルHTML生成 ---

    let html = `
        <div style="margin-bottom: 10px; font-size: 0.9em;">
            <span><strong>工事番号:</strong> ${projectDisplay}</span>
            <span style="margin-left: 20px;"><strong>集計期間:</strong> ${start_date} 〜 ${end_date}</span>
        </div>
        <div class="project-summary-table-container">
            <table class="data-table dense summary-table project-summary-table">
                <thead>
                    <tr>
                        <th class="col-date">日付</th>
    `;
    
    // ヘッダー（作業者名）
    if (employees) {
        employees.forEach(emp => {
            if (emp.name && emp.group_id) {
                // 遷移先は仮: 現状は日報_グループ別画面へ遷移し、グループと日付(基準日)をセットする仕様
                html += `<th class="col-worker">
                            <a href="#" onclick="event.preventDefault(); navigateToDashboard('${emp.group_id}', '${baseDateStr}')" title="グループID: ${emp.group_id} の日報へ">
                                ${escapeHTML(emp.name)}
                            </a>
                        </th>`;
            } else { // emp.name がない、または group_id がない場合
                html += `<th class="col-worker">${escapeHTML(emp.name)}</th>`;
            }
        });
    }

    // 最低列数に満たない場合、空のヘッダーを追加
    for (let i = 0; i < emptyColumnCount; i++) {
        html += `<th class="col-worker"></th>`;
    }

    html += `
                        <th class="col-total">計</th>
                    </tr>
                </thead>
                <tbody>
    `;

    // データ行
    newRows.forEach(row => {
        html += '<tr>';
        const workerData = row.slice(1, row.length - 1);

        // 日付列
        const rowDate = String(row[0]);
        html += `<td class="col-date">${escapeHTML(rowDate)}</td>`;

        // 実績のある作業者のデータ列
        workerData.forEach((cell, index) => {
            const value = parseFloat(cell);
            const displayValue = value === 0 ? '-' : value.toFixed(2);
            
            // セルにリンクを追加: クリックでその日の日報(グループ別)へ遷移
            // employees[index] からグループIDを取得
            const emp = employees[index];
            if (emp && emp.group_id) {
                html += `<td class="col-worker col-worker-data"><a href="#" onclick="event.preventDefault(); navigateToDashboard('${emp.group_id}', '${rowDate}')" style="text-decoration:none; color:inherit; display:block;">${displayValue}</a></td>`;
            } else {
                html += `<td class="col-worker col-worker-data">${displayValue}</td>`;
            }
        });

        // 空のデータ列を追加
        for (let i = 0; i < emptyColumnCount; i++) {
            html += `<td class="col-worker col-worker-data"></td>`;
        }

        // 計列
        const totalValue = parseFloat(row[row.length - 1]);
        html += `<td class="col-total">${totalValue === 0 ? '-' : totalValue.toFixed(2)}</td>`;

        html += '</tr>';
    });

    html += `
                </tbody>
                <tfoot>
                    <tr>
                        <th class="col-date">合計</th>
    `;
    
    // 合計行 (列合計 + 総合計)
    columnTotals.forEach(total => {
        const displayValue = total === 0 ? '-' : total.toFixed(2);
        html += `<th class="col-worker col-worker-data">${displayValue}</th>`;
    });

    // 空の合計列を追加
    for (let i = 0; i < emptyColumnCount; i++) {
        html += `<th class="col-worker col-worker-data"></th>`;
    }

    // 総合計
    html += `<th class="col-total">${grandTotal.toFixed(2)}</th>`;

    html += `
                    </tr>
                </tfoot>
            </table>
        </div>
    `;

    resultsContainer.innerHTML = html;
}

/**
 * カテゴリ設定画面のUIを描画
 */
function renderCategorySettingsUI(container) {
    container.innerHTML = `
        <div style="padding-bottom: 15px; display: flex; align-items: center; gap: 10px;">

            <div id="client-filter-wrapper" style="display: contents;">
                <label for="category-client-select" style="font-weight: bold;">顧客:</label>
                <select id="category-client-select" style="padding: 6px; border-radius: 4px; border: 1px solid #ccc; width: 450px;">
                    <option value="all">-- すべて --</option>
                </select>
                <span style="font-size: 0.8em; color: #999;">　　　- 顧客での絞り込み、及び、工事番号や拠点での並び替えが可能です -</span>
            </div>

            <button id="save-offices-btn" class="btn-secondary" style="margin-left: auto; margin-right: 10px; background-color: #397939; color: white; border: none; width: 80px;">更新</button>
            <button id="add-category-btn" class="btn-secondary" style="background-color: #397939; color: white; border: none; width: 160px;">＋ 新規作成</button>
        </div>
        <div class="table-container">
            <table class="data-table dense">
                <thead>
                    <tr>
                        <th style="width: 30px;">状態</th>
                        <th id="header-sort-label" class="sortable-th" style="width: 80px;" title="クリックで並び替え">工事番号</th>
                        <th style="width: 160px;">顧客</th>
                        <th>案件(工事名)</th>
                        <th class="header-sort-office sortable-th" data-office="本社現場" style="width: 30px; font-size: 0.8em; text-align: center;" title="クリックで並び替え">本社<br>現場</th>
                        <th class="header-sort-office sortable-th" data-office="本社加工" style="width: 30px; font-size: 0.8em; text-align: center;" title="クリックで並び替え">本社<br>加工</th>
                        <th class="header-sort-office sortable-th" data-office="四日市" style="width: 30px; font-size: 0.8em; text-align: center;" title="クリックで並び替え">四日<br>市</th>
                        <th class="header-sort-office sortable-th" data-office="花巻" style="width: 30px; font-size: 0.8em; text-align: center;" title="クリックで並び替え">花巻</th>
                        <th class="header-sort-office sortable-th" data-office="千歳" style="width: 30px; font-size: 0.8em; text-align: center;" title="クリックで並び替え">千歳</th>
                        <th style="width: 120px; text-align: center;">操作</th>
                    </tr>
                </thead>
                <tbody id="category-table-body">
                    <tr><td colspan="6" style="text-align:center; padding: 2em;">読み込み中...</td></tr>
                </tbody>
            </table>
        </div>
        <!-- ページネーション -->
        <div class="pagination-controls" id="category-pagination" style="display:none;">
            <button id="cat-prev-btn" class="btn-secondary pagination-btn">前へ</button>
            <span id="cat-page-info" style="font-size: 0.9rem; font-weight: bold;">1 / 1</span>
            <button id="cat-next-btn" class="btn-secondary pagination-btn">次へ</button>
        </div>
    `;

    const clientSelect = document.getElementById('category-client-select');
    const addBtn = document.getElementById('add-category-btn');
    const saveOfficesBtn = document.getElementById('save-offices-btn');
    
    // ページネーションイベント
    document.getElementById('cat-prev-btn').addEventListener('click', () => changeCategoryPage(-1));
    document.getElementById('cat-next-btn').addEventListener('click', () => changeCategoryPage(1));

    // ソートヘッダーのイベント
    document.getElementById('header-sort-label').addEventListener('click', () => {
        handleCategorySort('label');
    });
    // 各拠点のソートヘッダーにイベントリスナーを追加
    document.querySelectorAll('.header-sort-office').forEach(th => {
        th.addEventListener('click', () => handleCategorySort(`office:${th.dataset.office}`));
    });

    clientSelect.addEventListener('change', () => filterCategories());
    addBtn.addEventListener('click', () => openAddCategoryModal());

    // 事業所更新ボタンのイベント
    saveOfficesBtn.addEventListener('click', async () => {
        if (!await checkAdminPermission()) return; // ★権限チェック

        // 変更があったデータを抽出
        const updates = allCategoryData.filter(item => {
            const currentStr = JSON.stringify([...(item.offices || [])].sort());
            return currentStr !== item.originalOfficesStr;
        }).map(item => ({
            id: item.id,
            offices: item.offices
        }));

        if (updates.length === 0) {
            alert('変更された項目はありません。');
            return;
        }

        if (!confirm(`${updates.length}件の事業所設定を更新します。よろしいですか？`)) {
            return;
        }

        saveOfficesBtn.disabled = true;
        saveOfficesBtn.textContent = '更新中...';

        try {
            const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b/update_offices`, {
                method: 'POST',
                body: JSON.stringify(updates)
            });

            if (!response.ok) {
                throw new Error(`更新失敗: ${response.status}`);
            }

            alert('更新が完了しました。');
            loadCategories('engineering'); // 再読み込みして最新状態にする
        } catch (error) {
            console.error('更新エラー:', error);
            alert(`エラーが発生しました: ${error.message}`);
        } finally {
            saveOfficesBtn.disabled = false;
            saveOfficesBtn.textContent = '更新';
        }
    });

    // テーブル内のチェックボックス変更イベント（イベント委譲）
    document.getElementById('category-table-body').addEventListener('change', handleOfficeCheckboxChange);

    // 初期ロード
    toggleClientFilter('engineering');
    loadCategories('engineering');
}

/**
 * カテゴリ一覧のソート処理
 */
function handleCategorySort(key) {
    if (categorySortKey === key) {
        // 同じキーなら昇順・降順を反転
        categorySortOrder = categorySortOrder === 'desc' ? 'asc' : 'desc';
    } else {
        // 違うキーならそのキーに変更し、降順（新しい順）をデフォルトにする
        categorySortKey = key;
        categorySortOrder = 'desc';
    }
    filterCategories();
}

/**
 * 事業所チェックボックスの変更ハンドラ
 */
function handleOfficeCheckboxChange(e) {
    if (e.target.classList.contains('office-check')) {
        const id = e.target.dataset.id;
        const office = e.target.dataset.office;
        const isChecked = e.target.checked;

        // allCategoryData内の該当データを更新
        const item = allCategoryData.find(d => d.id === id);
        if (item) {
            item.offices = item.offices || [];
            if (isChecked) {
                if (!item.offices.includes(office)) {
                    item.offices.push(office);
                }
            } else {
                item.offices = item.offices.filter(o => o !== office);
            }
        }
    }
}

/**
 * 顧客フィルタの表示/非表示を切り替える
 */
function toggleClientFilter(kind) {
    const clientWrapper = document.getElementById('client-filter-wrapper');
    const clientSelect = document.getElementById('category-client-select');
    if (!clientWrapper || !clientSelect) return;

    if (kind === 'engineering') {
        clientWrapper.style.display = 'contents';
    } else { // 'net'
        clientWrapper.style.display = 'none';
        // 非表示にする際は、フィルタを「すべて」にリセットする
        clientSelect.value = 'all';
    }
}

/**
 * カテゴリデータをAPIから取得して表示
 */
async function loadCategories(kind) {
    const tbody = document.getElementById('category-table-body');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 2em;">読み込み中...</td></tr>';

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b?kind=${kind}`);
        if (!response.ok) {
            throw new Error(`取得失敗: ${response.status}`);
        }
        // 全データを保持し、1ページ目を表示
        allCategoryData = await response.json();
        
        // 変更検知用に初期状態を保存
        allCategoryData.forEach(item => {
            item.offices = item.offices || [];
            item.originalOfficesStr = JSON.stringify([...item.offices].sort());
        });
        
        // 顧客プルダウンを更新し、初期フィルタ（すべて）を適用
        updateClientOptions(allCategoryData);
        filterCategories();
        
    } catch (error) {
        console.error("カテゴリ取得エラー:", error);
        tbody.innerHTML = `<tr><td colspan="6" style="color:red; text-align:center;">エラー: ${error.message}</td></tr>`;
        document.getElementById('category-pagination').style.display = 'none';
    }
}

/**
 * 顧客プルダウンの選択肢を更新する
 */
function updateClientOptions(data) {
    const clientSelect = document.getElementById('category-client-select');
    if (!clientSelect) return;

    // 重複なしの顧客リストを作成 (空の値は除外)
    const clients = [...new Set(data.map(item => item.client).filter(c => c))].sort();

    let html = '<option value="all">-- すべて --</option>';
    clients.forEach(client => {
        html += `<option value="${escapeHTML(client)}">${escapeHTML(client)}</option>`;
    });
    clientSelect.innerHTML = html;
    clientSelect.value = 'all';
}

/**
 * カテゴリをフィルタリングして表示する
 */
function filterCategories() {
    const clientSelect = document.getElementById('category-client-select');
    const selectedClient = clientSelect ? clientSelect.value : 'all';

    if (selectedClient === 'all') {
        filteredCategoryData = [...allCategoryData];
    } else {
        filteredCategoryData = allCategoryData.filter(item => item.client === selectedClient);
    }

    // フィルタリング後のデータをソートする
    filteredCategoryData.sort((a, b) => {
        const valA_order = a.order || 0;
        const valB_order = b.order || 0;
        
        // 工事番号(label)の比較: 数値が含まれる場合は数値として比較する (例: "10" > "2")
        const valA_label = a.label || "";
        const valB_label = b.label || "";
        const labelCompare = valA_label.localeCompare(valB_label, undefined, { numeric: true });

        if (categorySortKey === 'label') {
            if (categorySortOrder === 'asc') {
                return labelCompare;
            } else {
                return -labelCompare; // 符号反転
            }
        } else if (categorySortKey.startsWith('office:')) {
            // 拠点ごとのチェック有無でソート
            const targetOffice = categorySortKey.split(':')[1];
            const hasA = (a.offices && a.offices.includes(targetOffice)) ? 1 : 0;
            const hasB = (b.offices && b.offices.includes(targetOffice)) ? 1 : 0;
            
            if (hasA !== hasB) {
                return categorySortOrder === 'asc' ? hasA - hasB : hasB - hasA;
            }
            // チェック状態が同じ場合は工事番号順（昇順）
            return valA_label.localeCompare(valB_label, undefined, { numeric: true });
        } else {
            // order
            if (categorySortOrder === 'asc') {
                return valA_order - valB_order;
            } else {
                return valB_order - valA_order;
            }
        }
    });

    currentCategoryPage = 1;
    renderPagedCategoryTable();
}

/**
 * ページネーション操作
 */
function changeCategoryPage(delta) {
    const maxPage = Math.ceil(filteredCategoryData.length / CATEGORY_PAGE_SIZE) || 1;
    const newPage = currentCategoryPage + delta;
    
    if (newPage >= 1 && newPage <= maxPage) {
        currentCategoryPage = newPage;
        renderPagedCategoryTable();
    }
}

/**
 * 現在のページに基づいてカテゴリテーブルを描画
 */
function renderPagedCategoryTable() {
    const tbody = document.getElementById('category-table-body');
    const paginationDiv = document.getElementById('category-pagination');
    
    // ページング計算
    const start = (currentCategoryPage - 1) * CATEGORY_PAGE_SIZE;
    const end = start + CATEGORY_PAGE_SIZE;
    const categories = filteredCategoryData.slice(start, end);
    const totalPages = Math.ceil(filteredCategoryData.length / CATEGORY_PAGE_SIZE) || 1;

    // ページネーション表示制御
    paginationDiv.style.display = filteredCategoryData.length > 0 ? 'flex' : 'none';

    if (!categories || categories.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 2em;">データがありません</td></tr>';
        return;
    }

    let html = '';
    categories.forEach(cat => {
        const activeStatus = cat.active 
            ? '<span style="color:#2ecc71; font-weight:bold;">有効</span>' 
            : '<span style="color:#95a5a6;">無効</span>';
        
        const offices = cat.offices || [];
        
        html += `
            <tr>
                <td style="text-align:center;">${activeStatus}</td>
                <td title="${escapeHTML(cat.label)}">
                    <a href="#" onclick="event.preventDefault(); handleNavigation('tasks_current', { kouban: '${escapeHTML(cat.label)}' });" style="color: #2980b9; text-decoration: underline;">
                        ${escapeHTML(cat.label)}
                    </a>
                </td>
                <td title="${escapeHTML(cat.client || '-')}">${escapeHTML(cat.client || '-')}</td>
                <td title="${escapeHTML(cat.project || '-')}">${escapeHTML(cat.project || '-')}</td>
                <td style="text-align:center;"><input type="checkbox" class="office-check" data-id="${cat.id}" data-office="本社現場" ${offices.includes('本社現場') ? 'checked' : ''}></td>
                <td style="text-align:center;"><input type="checkbox" class="office-check" data-id="${cat.id}" data-office="本社加工" ${offices.includes('本社加工') ? 'checked' : ''}></td>
                <td style="text-align:center;"><input type="checkbox" class="office-check" data-id="${cat.id}" data-office="四日市" ${offices.includes('四日市') ? 'checked' : ''}></td>
                <td style="text-align:center;"><input type="checkbox" class="office-check" data-id="${cat.id}" data-office="花巻" ${offices.includes('花巻') ? 'checked' : ''}></td>
                <td style="text-align:center;"><input type="checkbox" class="office-check" data-id="${cat.id}" data-office="千歳" ${offices.includes('千歳') ? 'checked' : ''}></td>
                <td style="text-align:center;">
                    <button class="btn-secondary" style="padding:2px 8px; font-size:0.8em; margin-right: 5px;" onclick="openEditCategoryModal('${cat.id}')">編集</button>
                    <button class="btn-secondary" style="padding:2px 8px; font-size:0.8em;" onclick="openAddCategoryModal('${cat.id}')">コピー</button>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;

    // ページネーション情報の更新
    document.getElementById('cat-page-info').textContent = `${currentCategoryPage} / ${totalPages}`;
    document.getElementById('cat-prev-btn').disabled = (currentCategoryPage === 1);
    document.getElementById('cat-next-btn').disabled = (currentCategoryPage === totalPages);
}

/**
 * 新規カテゴリ作成モーダルのイベントリスナーを一度だけ設定する
 */
function setupCategoryModal() {
    const modal = document.getElementById('add-category-modal');
    if (!modal) return;

    const closeBtn = document.getElementById('add-category-modal-close');
    const cancelBtn = document.getElementById('add-category-cancel-btn');
    const saveBtn = document.getElementById('add-category-save-btn');
    const messageDiv = document.getElementById('add-category-message');

    // ボタンのレイアウトとスタイルを調整
    if (cancelBtn && saveBtn) {
        const footer = cancelBtn.parentElement;
        if (footer) {
            footer.style.display = 'flex';
            footer.style.justifyContent = 'flex-end';
            footer.style.alignItems = 'center';
            footer.style.gap = '15px'; // ボタン間の間隔を広げる
        }
        cancelBtn.style.padding = '10px 20px';
        saveBtn.style.padding = '10px 20px';
    }

    const closeHandler = () => {
        modal.style.display = 'none';
    };

    const overlayClickHandler = (event) => {
        if (event.target === modal) {
            closeHandler();
        }
    };

    const saveHandler = async () => {
        if (!await checkAdminPermission()) return; // ★権限チェック

        const label = document.getElementById('new-cat-label').value.trim();
        const client = document.getElementById('new-cat-client').value.trim();
        const project = document.getElementById('new-cat-project').value.trim();
        const kind = 'engineering'; // この画面からは工務(engineering)で固定
        
        // チェックボックスの値を取得
        const offices = Array.from(document.querySelectorAll('input[name="new-cat-office"]:checked')).map(cb => cb.value);

        if (offices.length === 0) {
            alert('事業所は少なくとも1つ選択してください。');
            return;
        }

        if (!label) {
            alert('工事番号は必須です。');
            return;
        }

        // 確認メッセージを表示
        if (!confirm('【重要】追加した工事番号は原則、削除不可になります。\n作成します。よろしいですか？')) {
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
        messageDiv.style.display = 'block';
        messageDiv.textContent = 'データを送信しています...';
        messageDiv.className = 'message';

        try {
            // バックエンドAPIは label, client, project, kind を受け取る想定
            const payload = { label, client, project, kind, offices };
            
            // デバッグ用: 送信データをコンソールに出力
            console.log('送信データ:', payload);
            
            // liff-app.jsのカテゴリ追加APIを参考にエンドポイントを指定
            const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b/create`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'サーバーエラーが発生しました。' }));
                throw new Error(errorData.message || `作成に失敗しました (コード: ${response.status})`);
            }

            messageDiv.textContent = '作成に成功しました。一覧を更新します。';
            messageDiv.className = 'message success';

            setTimeout(() => {
                closeHandler();
                // 現在表示している事業部のカテゴリ一覧を再読み込み
                loadCategories('engineering');
            }, 1500);

        } catch (error) {
            console.error('カテゴリ作成エラー:', error);
            messageDiv.textContent = `エラー: ${error.message}`;
            messageDiv.className = 'message error';
            saveBtn.disabled = false;
            saveBtn.textContent = '保存';
        }
    };

    closeBtn.addEventListener('click', closeHandler);
    cancelBtn.addEventListener('click', closeHandler);
    modal.addEventListener('click', overlayClickHandler);
    saveBtn.addEventListener('click', saveHandler);
}

/**
 * 新規カテゴリ作成モーダルを開く
 */
function openAddCategoryModal(categoryId = null) {
    const modal = document.getElementById('add-category-modal');
    if (!modal) {
        console.error('新規作成モーダルが見つかりません。');
        return;
    }

    const form = document.getElementById('add-category-form');
    const saveBtn = document.getElementById('add-category-save-btn');
    const messageDiv = document.getElementById('add-category-message');
    const modalTitle = modal.querySelector('.modal-header h2');
    const clientInput = document.getElementById('new-cat-client');
    const checkboxes = document.querySelectorAll('input[name="new-cat-office"]');

    form.reset();
    messageDiv.style.display = 'none';
    saveBtn.disabled = false;
    saveBtn.textContent = '保存';

    // チェックボックスをリセット
    checkboxes.forEach(cb => cb.checked = false);

    if (categoryId) {
        // コピーモード: IDからデータを検索
        const sourceData = allCategoryData.find(c => c.id === categoryId);
        
        modalTitle.textContent = '工事番号作成（コピー）';
        
        if (sourceData) {
            clientInput.value = sourceData.client || '';
            // 案件はコピーしない（明示的に空にする）
            document.getElementById('new-cat-project').value = '';
            
            // officesの値を反映
            if (sourceData.offices && Array.isArray(sourceData.offices)) {
                checkboxes.forEach(cb => {
                    if (sourceData.offices.includes(cb.value)) cb.checked = true;
                });
            }
        }
        
        clientInput.readOnly = true;
    } else {
        // 新規作成モード
        modalTitle.textContent = '新規工事番号作成';
        clientInput.readOnly = false;
    }

    modal.style.display = 'flex';
}

/**
 * 編集用カテゴリモーダルのイベントリスナーを設定する
 */
function setupEditCategoryModal() {
    const modal = document.getElementById('edit-category-modal');
    if (!modal) return;

    const closeBtn = document.getElementById('edit-category-modal-close');
    const cancelBtn = document.getElementById('edit-category-cancel-btn');
    const saveBtn = document.getElementById('edit-category-save-btn');
    const messageDiv = document.getElementById('edit-category-message');

    // ボタンのレイアウトとスタイルを調整
    if (cancelBtn && saveBtn) {
        const footer = cancelBtn.parentElement;
        if (footer) {
            footer.style.display = 'flex';
            footer.style.justifyContent = 'flex-end';
            footer.style.alignItems = 'center';
            footer.style.gap = '15px'; // ボタン間の間隔を広げる
        }
        cancelBtn.style.padding = '10px 20px';
        saveBtn.style.padding = '10px 20px';
    }

    const closeHandler = () => {
        modal.style.display = 'none';
    };

    const overlayClickHandler = (event) => {
        if (event.target === modal) {
            closeHandler();
        }
    };

    const saveHandler = async () => {
        if (!await checkAdminPermission()) return; // ★権限チェック

        const id = document.getElementById('edit-cat-id').value;
        const client = document.getElementById('edit-cat-client').value.trim();
        const project = document.getElementById('edit-cat-project').value.trim();
        const offices = Array.from(document.querySelectorAll('input[name="edit-cat-office"]:checked')).map(cb => cb.value);

        // 元の顧客名を取得
        const originalClient = modal.dataset.originalClient || '';

        if (offices.length === 0) {
            alert('事業所は少なくとも1つ選択してください。');
            return;
        }

        // 顧客が変更された場合の警告
        if (client !== originalClient) {
            const confirmationMessage = "顧客(元請け)を変更しようとしていますが、間違いありませんか？顧客を変更するとその月度内ですでに出力した工番別集計結果が不正確となるので、締め直後に限定した変更を強くお勧めします";
            if (!confirm(confirmationMessage)) {
                return; // ユーザーがキャンセルした場合、処理を中断
            }
        }

        if (!confirm('変更を保存しますか？')) {
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = '更新中...';
        messageDiv.style.display = 'block';
        messageDiv.textContent = 'データを送信しています...';
        messageDiv.className = 'message';

        try {
            const payload = { id, client, project, offices };
            
            const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b/update`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'サーバーエラーが発生しました。' }));
                throw new Error(errorData.message || `更新に失敗しました (コード: ${response.status})`);
            }

            messageDiv.textContent = '更新に成功しました。一覧を更新します。';
            messageDiv.className = 'message success';

            setTimeout(() => {
                closeHandler();
                loadCategories('engineering');
            }, 1500);

        } catch (error) {
            console.error('カテゴリ更新エラー:', error);
            messageDiv.textContent = `エラー: ${error.message}`;
            messageDiv.className = 'message error';
            saveBtn.disabled = false;
            saveBtn.textContent = '更新';
        }
    };

    closeBtn.addEventListener('click', closeHandler);
    cancelBtn.addEventListener('click', closeHandler);
    modal.addEventListener('click', overlayClickHandler);
    saveBtn.addEventListener('click', saveHandler);
}

/**
 * 編集用カテゴリモーダルを開く
 */
function openEditCategoryModal(categoryId) {
    const modal = document.getElementById('edit-category-modal');
    if (!modal) return;

    const category = allCategoryData.find(c => c.id === categoryId);
    if (!category) {
        alert('カテゴリデータが見つかりません。');
        return;
    }

    // 後で比較するために、元の顧客名をデータ属性に保存
    modal.dataset.originalClient = category.client || '';

    const saveBtn = document.getElementById('edit-category-save-btn');
    const messageDiv = document.getElementById('edit-category-message');

    // フォームのリセット
    messageDiv.style.display = 'none';
    saveBtn.disabled = false;
    saveBtn.textContent = '更新';

    // データのセット
    document.getElementById('edit-cat-id').value = category.id;
    document.getElementById('edit-cat-label').value = category.label;

    const clientInput = document.getElementById('edit-cat-client');
    clientInput.value = category.client || '';
    clientInput.readOnly = false; // 編集可能にする

    document.getElementById('edit-cat-project').value = category.project || '';
    document.getElementById('edit-cat-department').value = 'engineering';

    // チェックボックスのセット
    const checkboxes = document.querySelectorAll('input[name="edit-cat-office"]');
    checkboxes.forEach(cb => {
        cb.checked = (category.offices && category.offices.includes(cb.value));
    });

    modal.style.display = 'flex';
}

/**
 * 業務種別設定画面のUIを描画
 */
async function renderCategoryASettingsUI(container) {
    container.innerHTML = `
        <div style="padding: 20px; max-width: 800px; margin: 0 auto;">
            <style>
                #category-a-table-body tr { cursor: move; }
                #category-a-table-body tr.dragging { opacity: 0.5; background: #f0f0f0; }
            </style>
            <div class="card" style="padding: 20px;">
                <h3 style="margin-top:0;">業務種別設定</h3>
                <p style="font-size: 0.9em; color: #666; line-height: 1.5;">
                    各業務種別が、工番別集計（Excel）で「加工」と「現場」のどちらに分類されるかを設定します。<br>
                    行をドラッグ＆ドロップで並び順を変更できます。変更後は「更新」ボタンを押してください。
                </p>
                <div class="table-container" style="margin-top: 20px;">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>業務種別 (ID)</th>
                                <th style="width: 120px;">分類</th>
                                <th style="width: 150px;">保存状態</th>
                            </tr>
                        </thead>
                        <tbody id="category-a-table-body">
                            <tr><td colspan="3" style="text-align:center; padding: 2em;">読み込み中...</td></tr>
                        </tbody>
                    </table>
                </div>
                <div style="text-align: right; margin-top: 20px;">
                    <div id="category-a-message" style="display: none; text-align: left; margin-bottom: 10px;"></div>
                    <button id="category-a-update-btn" class="btn-primary">更新</button>
                </div>
            </div>
        </div>
    `;

    const tbody = document.getElementById('category-a-table-body');

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/a`);
        if (!response.ok) throw new Error('データ取得に失敗しました');
        const categories = await response.json();

        if (categories.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;">データがありません</td></tr>';
            return;
        }

        // orderでソートしてから表示
        categories.sort((a, b) => {
            const orderA = (a.order !== undefined && a.order !== null) ? a.order : 9999;
            const orderB = (b.order !== undefined && b.order !== null) ? b.order : 9999;
            return orderA - orderB;
        });

        let html = '';
        categories.forEach(cat => {
            html += `
                <tr data-id="${cat.id}" draggable="true">
                    <td>${escapeHTML(cat.label)} (${escapeHTML(cat.id)})</td>
                    <td>
                        <select class="category-a-work-type-select" data-id="${cat.id}" style="padding: 6px; width: 100%;">
                            <option value="null" ${!cat.work_type ? 'selected' : ''}>- 未分類 -</option>
                            <option value="加工" ${cat.work_type === '加工' ? 'selected' : ''}>加工</option>
                            <option value="現場" ${cat.work_type === '現場' ? 'selected' : ''}>現場</option>
                        </select>
                    </td>
                    <td class="update-status-cell" style="font-size: 0.85em; text-align: center; color: #ccc;">☰</td>
                </tr>
            `;
        });
        tbody.innerHTML = html;

        // ドラッグ＆ドロップのイベントリスナー
        let draggedItem = null;

        tbody.addEventListener('dragstart', (e) => {
            draggedItem = e.target.closest('tr');
            if (!draggedItem) return;
            // 少し待ってからクラスを適用しないと、ドラッグゴーストが消える
            setTimeout(() => {
                draggedItem.classList.add('dragging');
            }, 0);
        });

        tbody.addEventListener('dragover', (e) => {
            e.preventDefault();
            const target = e.target.closest('tr');
            if (target && target !== draggedItem) {
                const rect = target.getBoundingClientRect();
                const isAfter = e.clientY > rect.top + rect.height / 2;
                if (isAfter) {
                    target.parentNode.insertBefore(draggedItem, target.nextSibling);
                } else {
                    target.parentNode.insertBefore(draggedItem, target);
                }
            }
        });

        tbody.addEventListener('dragend', () => {
            if (draggedItem) {
                draggedItem.classList.remove('dragging');
            }
            draggedItem = null;
        });

        // 更新ボタンのイベントリスナー
        document.getElementById('category-a-update-btn').addEventListener('click', handleCategoryAUpdate);

    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="3" style="color:red; text-align:center;">${error.message}</td></tr>`;
    }
}

async function handleCategoryAUpdate() {
    if (!await checkAdminPermission()) return; // ★権限チェック

    const btn = document.getElementById('category-a-update-btn');
    const messageDiv = document.getElementById('category-a-message');
    btn.disabled = true;
    btn.textContent = '更新中...';
    messageDiv.style.display = 'none';

    const rows = document.querySelectorAll('#category-a-table-body tr');
    const updates = [];
    rows.forEach((row, index) => {
        const id = row.dataset.id;
        const workTypeSelect = row.querySelector('.category-a-work-type-select');
        const work_type = workTypeSelect.value === 'null' ? null : workTypeSelect.value;
        
        updates.push({
            id: id,
            order: index, // DOMの順序をそのままorderとする
            work_type: work_type
        });
    });

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/a/batch-update`, {
            method: 'POST',
            body: JSON.stringify(updates)
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.message || '更新に失敗しました');
        }

        messageDiv.textContent = '更新に成功しました。';
        messageDiv.className = 'message success';
        messageDiv.style.display = 'block';

    } catch (error) {
        messageDiv.textContent = `エラー: ${error.message}`;
        messageDiv.className = 'message error';
        messageDiv.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = '更新';
    }
}

/**
 * ダッシュボード（予実突合）データの読み込みと表示
 */
async function loadDashboardData() {
    const tbody = document.getElementById('comparison-table-body');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 2em;">データを読み込み中...</td></tr>';
    const targetDate = document.getElementById('target-date').value;

    try {
        // APIから日報一覧データを取得
        const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/daily-reports?date=${targetDate}`);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            throw new Error(errorData?.message || `データ取得失敗: ${response.status}`);
        }

        // 全データを保持
        allDashboardData = await response.json();
        
        // キャッシュから勤務時間を復元
        allDashboardData.forEach(emp => {
            const cachedWorkTime = sessionStorage.getItem(`workTimeCache_${targetDate}_${emp.employeeId}`);
            if (cachedWorkTime !== null) {
                // sessionStorageは文字列で保存されるため数値に変換
                emp.workTime = parseInt(cachedWorkTime, 10);
            }
        });

        // フィルタリングと描画を実行
        filterDashboardData();

    } catch (error) {
        console.error("データ取得エラー:", error);
        // データがない場合(404)は「データなし」と表示、それ以外はエラー表示
        let msg = `エラー: ${error.message}`;
        let color = 'red';

        if (error.message.includes('404')) {
            msg = 'データがありません';
            color = '#666';
        } else if (error.name === 'TypeError' && (error.message === 'Failed to fetch' || error.message.includes('NetworkError'))) {
            msg = '通信エラー: サーバーに接続できませんでした (API未実装またはCORS設定を確認してください)';
        }
        
        tbody.innerHTML = `<tr><td colspan="6" style="color:${color}; text-align:center;">${msg}</td></tr>`;
    }
}

/**
 * 日報データをグループでフィルタリングして表示する
 */
function filterDashboardData() {
    const groupSelect = document.getElementById('target-group');
    const selectedGroupId = groupSelect ? groupSelect.value : 'all';

    // ネット一覧は main_group='3' 固定
    if (dashboardListMode === 'net') {
        filteredDashboardData = allDashboardData.filter(row => String(row.group_id) === '3');
    } else if (selectedGroupId === 'all') {
        filteredDashboardData = [...allDashboardData];
    } else {
        // カンマ区切りで複数のIDが指定される場合に対応
        const targetIds = selectedGroupId.split(',');
        filteredDashboardData = allDashboardData.filter(row => {
            // row.group_id が存在し、かつ指定されたIDリストに含まれる場合のみ表示
            return row.group_id && targetIds.includes(String(row.group_id));
        });
    }

    renderTableRows(filteredDashboardData);
}

/**
 * テーブル行の描画
 */
function renderTableRows(data) {
    const tbody = document.getElementById('comparison-table-body');
    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 2em;">データがありません</td></tr>';
        return;
    }

    // 一覧の表示元に応じて、スタッフ名リンクの遷移先を切り替える
    const activeTarget = document.querySelector('.nav-item.active')?.dataset?.target;
    const isNetListView = (activeTarget === 'dashboard_net') || (dashboardListMode === 'net');
    const calendarTarget = isNetListView ? 'staff_calendar_net' : 'staff_calendar';

    let html = '';
    data.forEach(row => {
        const workTime = (row.workTime !== undefined && row.workTime !== null) ? row.workTime : null;
        const taskTime = (row.taskTime !== undefined && row.taskTime !== null) ? row.taskTime : 0;
        const diff = (workTime !== null) ? taskTime - workTime : null;

        // 差分に応じた色付け
        let diffClass = 'diff-zero';
        if (diff !== null) {
            if (diff < 0) diffClass = 'diff-minus';
            else if (diff > 0) diffClass = 'diff-plus';
        }

        html += `
            <tr id="report-row-${row.employeeId}">
                <td>${escapeHTML(row.date)}</td>
                <td><a href="#" onclick="event.preventDefault(); handleNavigation('${calendarTarget}', { employeeId: '${row.employeeId}' })" title="${escapeHTML(row.name)}さんの当月度の出勤簿へ">${escapeHTML(row.name)}</a></td>
                <td id="work-time-${row.employeeId}">${workTime !== null ? workTime + '分' : '-'}</td>
                <td id="task-time-${row.employeeId}">${taskTime}分</td>
                <td id="diff-${row.employeeId}" class="${diffClass}">${diff !== null ? (diff > 0 ? '+' : '') + diff + '分' : '-'}</td>
                <td>
                    <button class="btn-secondary" style="padding:4px 8px; font-size:0.8em;" onclick="openProxyReport('${row.employeeId}', '${row.name}', '${row.date}', '${row.group_id || ''}')">詳細表示(代理入力)</button>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
}

/**
 * Jobcanから最新の勤務時間を取得し、画面を更新する
 */
async function refreshWorkTimes() {
    const refreshBtn = document.getElementById('refresh-button');
    const tbody = document.getElementById('comparison-table-body');

    const targetDate = document.getElementById('target-date').value;
    const groupSelect = document.getElementById('target-group');
    const selectedGroupId = groupSelect ? groupSelect.value : 'all';

    if (!tbody || !targetDate) {
        alert('日付が選択されていないか、テーブルが表示されていません。');
        return;
    }

    // 「全社」選択時の確認ダイアログ
    if (selectedGroupId === 'all') {
        const confirmation = confirm(
            "全社での受信には、1分程度の時間が掛かります。\n" +
            "また、1度の受信では数字が不正確なことがあります。\n" +
            "グループごとでの受信をおすすめします。\n" +
            "それでも全社での受信を実行しますか？"            
        );
        if (!confirmation) {
            return; // 処理を中断
        }
    }

    // グループ選択に応じて待機時間を設定
    const waitSeconds = (selectedGroupId === 'all') ? 2 : 3;

    // 現在表示されている従業員のリストを取得
    const employeesToUpdate = filteredDashboardData.map(emp => emp.employeeId).filter(Boolean);

    if (employeesToUpdate.length === 0) {
        alert('更新対象の従業員がいません。');
        return;
    }


    const originalBtnText = refreshBtn.textContent;
    refreshBtn.disabled = true;

    refreshBtn.textContent = `受信中 (0/${employeesToUpdate.length})`;

    let completedCount = 0;

    // 各従業員の勤務時間を取得するPromiseの配列を作成
    const fetchPromises = employeesToUpdate.map(employeeId => {
        // 管理者として他人の情報を取得するため、employee_id をクエリに追加
        // source=admin を指定して、バックエンド側での不要な待機をなくす
        return fetchWithAuth(`${API_BASE_URL}/api/work-time?date=${targetDate}&employee_id=${employeeId}&source=admin&wait=${waitSeconds}`)
            .then(response => {
                if (!response.ok) {
                    return response.json().then(err => Promise.reject({ employeeId, error: err.message || `Status ${response.status}` }));
                }
                return response.json();
            })
            .then(data => ({ employeeId, workTime: data.workTime }))
            .catch(errorInfo => {
                console.error(`Failed to fetch work time for ${errorInfo.employeeId || employeeId}:`, errorInfo.error || errorInfo);
                return { employeeId, workTime: null, error: true }; // エラーがあったことを示す
            })
            .finally(() => {
                // 1件完了ごとにプログレスを更新
                completedCount++;
                refreshBtn.textContent = `受信中 (${completedCount}/${employeesToUpdate.length})`;
            });
    });

    // 全てのPromiseが完了するのを待つ
    const results = await Promise.all(fetchPromises);

    // データソースを更新
    results.forEach(item => {
        if (item.error) return; // エラーがあったものはスキップ

        const { employeeId, workTime: newWorkTime } = item;
        
        // 1. sessionStorageに保存
        if (newWorkTime !== null) {
            sessionStorage.setItem(`workTimeCache_${targetDate}_${employeeId}`, newWorkTime);
        } else {
            // APIからnullが返ってきた場合はキャッシュを削除
            sessionStorage.removeItem(`workTimeCache_${targetDate}_${employeeId}`);
        }

        // 2. データソース(allDashboardData, filteredDashboardData)を更新
        const employeeInAll = allDashboardData.find(e => e.employeeId === employeeId);
        if (employeeInAll) {
            employeeInAll.workTime = newWorkTime;
        }
        const employeeInFiltered = filteredDashboardData.find(e => e.employeeId === employeeId);
        if (employeeInFiltered) {
            employeeInFiltered.workTime = newWorkTime;
        }
    });

    // 3. テーブルを再描画
    renderTableRows(filteredDashboardData);

    const successCount = results.filter(r => !r.error).length;
    console.log(`${successCount}件の勤務時間を更新しました。`);

    refreshBtn.disabled = false;
    refreshBtn.textContent = originalBtnText;

    // 処理完了後、トースト通知を表示
    showToast('受信リクエスト完了。反映には時間がかかる場合があります。', 'success');
}

// --- スタッフ別カレンダー機能 (liff-app.jsの出勤簿機能を参考に実装) ---

/**
 * DateオブジェクトをUTC基準の "YYYY-MM-DD" 形式の文字列に変換する (liff-app.jsから移植)
 * @param {Date} date 変換するDateオブジェクト
 * @returns {string} "YYYY-MM-DD" 形式の文字列
 */
function toUTCDateString(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 日付と月度のマッピングデータを生成する (liff-app.jsから移植)
 * この関数が未定義だったためエラーが発生していました。
 */
function generateDateToMonthMap(mapStartDate, mapEndDate) {
    const startDateOfNextMonth = closingDay + 1;

    let currentDate = new Date(Date.UTC(mapStartDate.getFullYear(), mapStartDate.getMonth(), mapStartDate.getDate()));
    while (currentDate <= mapEndDate) {
        const calendarYear = currentDate.getUTCFullYear();
        const calendarMonth = currentDate.getUTCMonth();
        const calendarDay = currentDate.getUTCDate();

        let reportMonthDate;
        if (calendarDay >= startDateOfNextMonth) {
            reportMonthDate = new Date(Date.UTC(calendarYear, calendarMonth + 1, 1));
        } else {
            reportMonthDate = new Date(Date.UTC(calendarYear, calendarMonth, 1));
        }
        
        const dateString = toUTCDateString(new Date(currentDate));
        dateToMonthMap[dateString] = reportMonthDate;
        
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }
}

/**
 * カレンダーの表示範囲を計算する (liff-app.jsから移植)
 */
function calculateVisibleRange(currentDate) {
    const startDateOfNextMonth = closingDay + 1;

    const targetReportYear = currentDate.getUTCFullYear();
    const targetReportMonth = currentDate.getUTCMonth();

    const periodStart = new Date(Date.UTC(targetReportYear, targetReportMonth - 1, startDateOfNextMonth));
    const periodEnd = new Date(Date.UTC(targetReportYear, targetReportMonth, closingDay));

    const viewStart = new Date(periodStart);
    viewStart.setUTCDate(viewStart.getUTCDate() - viewStart.getUTCDay());

    const viewEnd = new Date(periodEnd);
    viewEnd.setUTCDate(viewEnd.getUTCDate() + (6 - viewEnd.getUTCDay()));

    return { start: viewStart, end: viewEnd };
}

/**
 * スタッフ別カレンダー画面のUIを描画する
 */
function renderStaffCalendarUI(container, params = {}) {
     container.innerHTML = `
         <div class="staff-calendar-controls" style="padding: 10px; background-color: #f8f9fa; border-bottom: 1px solid #e9ecef; display: flex; align-items: center; gap: 20px; flex-wrap: wrap;">
             <div>
                 <label for="staff-id-input" style="font-weight: bold; margin-right: 5px;">社員ID:</label>
                 <input type="text" id="staff-id-input" placeholder="社員ID (6桁)" maxlength="6" style="padding: 6px; border-radius: 4px; border: 1px solid #ccc; width: 120px;" inputmode="numeric">
                 <button id="staff-search-btn" class="btn-secondary" style="margin-left: 5px;">検索</button>
             </div>
             <div id="staff-info-display" style="font-weight: bold;"></div>
             <div class="calendar-header" style="display: flex; align-items: center; gap: 10px; margin-left: auto;">
                 <button id="staff-cal-prev-month" class="btn-secondary">&lt; 前月度</button>
                 <h3 id="staff-cal-title" style="margin: 0; font-size: 1.2em; min-width: 120px; text-align: center;"></h3>
                 <button id="staff-cal-sync-holidays" class="btn-secondary" style="background-color: #006400; color: white; margin-right: 5px;">Jobcan同期</button>
                 <button id="staff-cal-next-month" class="btn-secondary">次月度 &gt;</button>
             </div>
         </div>
         <div id="staff-calendar-table-container" style="padding: 10px;">
             <p style="text-align: center; padding: 2em; color: #666;">社員IDを入力して検索してください。</p>
         </div>
     `;
 
     // イベントリスナー
     document.getElementById('staff-search-btn').addEventListener('click', searchStaffAndRenderCalendar);
     document.getElementById('staff-id-input').addEventListener('keypress', (e) => {
         if (e.key === 'Enter') {
             e.preventDefault(); // フォームの送信を防ぐ
             searchStaffAndRenderCalendar();
         }
     });
 
     document.getElementById('staff-cal-prev-month').addEventListener('click', () => {
         if (currentCalendarReportMonth && currentCalendarEmployeeId) {
             currentCalendarReportMonth.setMonth(currentCalendarReportMonth.getMonth() - 1);
             initializeStaffCalendar();
         }
     });
 
     document.getElementById('staff-cal-next-month').addEventListener('click', () => {
         if (currentCalendarReportMonth && currentCalendarEmployeeId) {
             currentCalendarReportMonth.setMonth(currentCalendarReportMonth.getMonth() + 1);
             initializeStaffCalendar();
         }
     });

     document.getElementById('staff-cal-sync-holidays').addEventListener('click', handleSyncPaidHolidaysForStaff);
 
     // パラメータがあれば自動検索
     if (params.employeeId) {
         document.getElementById('staff-id-input').value = params.employeeId;
         searchStaffAndRenderCalendar();
     }
 }
 
 /**
  * 社員IDで従業員を検索し、カレンダーを描画する
  */
 async function searchStaffAndRenderCalendar() {
     const input = document.getElementById('staff-id-input');
     const staffInfoDisplay = document.getElementById('staff-info-display');
     const tableContainer = document.getElementById('staff-calendar-table-container');
     const employeeId = input.value.trim();
 
     if (!/^\d{6}$/.test(employeeId)) {
         alert('社員IDは半角数字6桁で入力してください。');
         return;
     }
 
     staffInfoDisplay.textContent = '検索中...';
     tableContainer.innerHTML = ''; // カレンダーをクリア
 
     try {
         // NOTE: バックエンドに /api/manager/user-by-employee-id の実装が必要です。
         // このAPIは { employeeId, name, groupId } を含むオブジェクトを返すことを想定しています。
         const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/user-by-employee-id?employee_id=${employeeId}`);
         
         if (response.status === 404) {
             throw new Error('該当する社員IDが見つかりません。');
         }
         if (!response.ok) {
             const errorData = await response.json().catch(() => ({}));
             throw new Error(errorData.message || '従業員情報の取得に失敗しました。');
         }
 
         const staff = await response.json();
         
         // ★デバッグ: APIから返されたstaffオブジェクト全体をコンソールに出力
         console.log('[Debug] API response for staff:', staff);
         
         // 取得した従業員情報を staffList にセットする（単一要素の配列として）
         // これにより、既存の renderStaffCalendar のロジックを流用できる
         staffList = [staff];
         currentCalendarEmployeeId = staff.employeeId;
         
         staffInfoDisplay.textContent = `対象者: ${escapeHTML(staff.name)}`;
 
         // カレンダーの描画処理を呼び出す
         initializeStaffCalendar();
 
     } catch (error) {
         console.error(error);
         staffInfoDisplay.textContent = '';
         tableContainer.innerHTML = `<p style="text-align: center; padding: 2em; color: red;">${error.message}</p>`;
         // 状態をリセット
         staffList = [];
         currentCalendarEmployeeId = null;
     }
 }

/**
 * スタッフ別カレンダーの初期化と再描画
 */
async function initializeStaffCalendar() {
    const tableContainer = document.getElementById('staff-calendar-table-container');
    const titleEl = document.getElementById('staff-cal-title');

    if (!currentCalendarEmployeeId) {
        tableContainer.innerHTML = '<p style="text-align: center; padding: 2em; color: #666;">社員IDを入力して検索してください。</p>';
        return;
    }
    
    tableContainer.innerHTML = '<p style="text-align: center; padding: 2em;">カレンダーを読み込み中...</p>';

    // currentCalendarReportMonthが未設定の場合、当月度をセット
    if (!currentCalendarReportMonth) {
        const today = new Date();
        const todayString = toUTCDateString(today);
        currentCalendarReportMonth = dateToMonthMap[todayString] || new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    }

    // 1. サーバーからステータス情報を取得
    // NOTE: バックエンドに /api/manager/calendar-statuses の実装が必要です。
    await fetchStaffCalendarStatuses(currentCalendarEmployeeId, currentCalendarReportMonth);

    // 2. カレンダーのヘッダータイトルとテーブルを更新
    const year = currentCalendarReportMonth.getUTCFullYear();
    const month = currentCalendarReportMonth.getUTCMonth() + 1;
    titleEl.innerText = `${year}年${month}月度`;
    tableContainer.innerHTML = renderStaffCalendar();
}

/**
 * 指定された従業員・月度のカレンダーステータスを取得する
 */
async function fetchStaffCalendarStatuses(employeeId, reportMonthDate) {
    try {
        const startDateOfNextMonth = closingDay + 1;
        const year = reportMonthDate.getUTCFullYear();
        const month = reportMonthDate.getUTCMonth();

        const startDate = new Date(Date.UTC(year, month - 1, startDateOfNextMonth));
        const endDate = new Date(Date.UTC(year, month, closingDay));

        const startDateStr = toUTCDateString(startDate);
        const endDateStr = toUTCDateString(endDate);
        
        const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/calendar-statuses?employee_id=${employeeId}&start_date=${startDateStr}&end_date=${endDateStr}`);
        if (!response.ok) {
            throw new Error(`ステータス取得失敗: ${response.status}`);
        }
        staffCalendarStatuses = await response.json();
    } catch (error) {
        console.error("カレンダーステータスの取得に失敗しました:", error);
        staffCalendarStatuses = {};
    }
}

/**
 * スタッフの有休情報をJobcanから取得して反映する
 */
async function handleSyncPaidHolidaysForStaff() {
    if (!currentCalendarEmployeeId || !currentCalendarReportMonth) return;

    if (!confirm("Jobcanから勤怠データ（有休・宿泊備考）を取得し、反映しますか？\n※表示中の月度が対象です。")) return;

    const btn = document.getElementById('staff-cal-sync-holidays');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "反映中...";

    try {
        const dateStr = toUTCDateString(currentCalendarReportMonth);
        
        const response = await fetchWithAuth(`${API_BASE_URL}/api/sync-paid-holidays`, {
            method: 'POST',
            body: JSON.stringify({ 
                date: dateStr,
                target_employee_id: currentCalendarEmployeeId // 管理者機能として対象IDを指定
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            throw new Error(errorData?.message || `反映に失敗しました: ${response.status}`);
        }

        const result = await response.json();
        alert(`同期が完了しました。\n処理件数: ${result.count}件`);
        
        // カレンダーを再描画
        initializeStaffCalendar();

    } catch (e) {
        console.error(e);
        alert(`エラー: ${e.message}`);
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
    }
}

/**
 * スタッフ別カレンダーのHTMLテーブルを生成する
 */
function renderStaffCalendar() {
    const { start, end } = calculateVisibleRange(currentCalendarReportMonth);    
    const todayStr = toUTCDateString(new Date());

    // 現在表示中の従業員情報を取得し、役員フラグを確認
    // IDの型不一致を防ぐため文字列変換して比較
    const currentStaff = staffList.find(s => String(s.employeeId) === String(currentCalendarEmployeeId));
    
    // ★デバッグ: 取得したスタッフ情報と役員フラグの状態をコンソールに出力(F12キー -> Consoleタブで確認)
    console.log('[Debug] renderStaffCalendar:', { 
        currentCalendarEmployeeId, 
        currentStaff, 
        is_executive: currentStaff?.is_executive,
        staffCalendarStatuses // ★追加: 日付ごとの詳細データ（宿泊フラグなど）を確認できるようにする
    });

    // is_executiveが 1 や "1" で返ってくる場合も考慮して判定
    const isExecutive = currentStaff && (currentStaff.is_executive === true || currentStaff.is_executive === 1 || currentStaff.is_executive === '1');

    let html = '<table class="data-table custom-calendar-table">';

    html += '<thead><tr>';
    ['日', '月', '火', '水', '木', '金', '土'].forEach(day => html += `<th>${day}</th>`);
    html += '</tr></thead>';

    html += '<tbody>';
    let currentDate = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()));
    while (currentDate <= end) {
        html += '<tr>';
        for (let i = 0; i < 7; i++) {
            const day = currentDate.getDate();
            const dayOfWeek = currentDate.getDay();
            const dateStr = toUTCDateString(currentDate);

            const isOtherMonth = !dateToMonthMap[dateStr] || (dateToMonthMap[dateStr].getTime() !== currentCalendarReportMonth.getTime());

            let statusIndicatorHtml = '';
            let workTimeHtml = '';
            let reportedTimeHtml = '';
            let accommodationHtml = ''; // 宿泊バッジ用
            let onSiteBadgeHtml = ''; // 現場バッジ用

            if (!isOtherMonth) {
                const statusData = staffCalendarStatuses[dateStr];
                let statusText = '';
                let bgColor = '#777';

                // liff-app.jsのロジックを参考に、役員判定を加えてステータスを再計算する
                if (statusData) {
                    // 数値型に変換して比較する
                    const jobcanMinutes = parseInt(statusData.jobcan_minutes || 0, 10);
                    const reportedMinutes = statusData.reported_minutes !== null ? parseInt(statusData.reported_minutes, 10) : null;

                    let finalStatus = statusData.status; // バックエンドからのstatusをデフォルトとする

                    // フロントエンドでステータスを再計算
                    if (reportedMinutes !== null) { // 日報が提出されている場合
                        if (reportedMinutes === 0 && jobcanMinutes === 0) {
                            finalStatus = null; // 表示なし
                        } else if (reportedMinutes === 0 && jobcanMinutes > 0) {
                            finalStatus = 'pending';
                        } else if (isExecutive && reportedMinutes >= jobcanMinutes && reportedMinutes > 0) {
                            // 役員ロジック: 報告 >= 勤務 なら完了
                            finalStatus = 'completed';
                        } else if (!isExecutive && jobcanMinutes > 0 && jobcanMinutes === reportedMinutes) {
                            // 一般ユーザーロジック: 報告 === 勤務 なら完了
                            finalStatus = 'completed';
                        } else {
                            // 上記以外は不一致
                            finalStatus = 'inconsistent';
                        }
                    } else if (jobcanMinutes > 0) {
                        // 日報未提出で勤務実績がある場合は未入力
                        finalStatus = 'pending';
                    }

                    // 再計算したステータスに基づいて表示を決定 (スマホアプリの色に合わせる)
                    switch (finalStatus) {
                        case 'completed': statusText = '完了'; bgColor = '#083969'; break;
                        case 'inconsistent': statusText = '不一致'; bgColor = '#d9534f'; break;
                        case 'pending': statusText = '未入力'; bgColor = '#777'; break;
                    }
                }
                
                if (statusText) {
                    statusIndicatorHtml = `<div class="status-indicator" style="background-color: ${bgColor};">${statusText}</div>`;
                }
                
                // 宿泊バッジの表示 (statusData.has_accommodation が true の場合)
                if (statusData && statusData.has_accommodation) {
                    const noteContent = statusData.jobcan_note || '宿泊あり';
                    accommodationHtml = `<span class="accommodation-badge" title="${escapeHTML(noteContent)}">宿泊</span>`;
                }

                // 現場作業バッジの表示
                if (statusData && statusData.on_site) {
                    let badgeText = '';
                    let badgeTitle = '';
                    if (statusData.on_site === 'full') {
                        badgeText = '現場_全';
                        badgeTitle = '現場作業 (全日)';
                    } else if (statusData.on_site === 'half') {
                        badgeText = '現場_半';
                        badgeTitle = '現場作業 (半日)';
                    }
                    if (badgeText) {
                        onSiteBadgeHtml = `<span class="on-site-badge ${statusData.on_site}" title="${badgeTitle}">${badgeText}</span>`;
                    }
                }

                const jobcanMinutes = statusData?.jobcan_minutes ?? 0;
                const reportedMinutes = statusData?.reported_minutes ?? 0;
                if (jobcanMinutes > 0) workTimeHtml = `<div class="time-display work-time">勤務時間:${jobcanMinutes}</div>`;
                if (reportedMinutes > 0) reportedTimeHtml = `<div class="time-display reported-time">日報入力:${reportedMinutes}</div>`;
            }

            let cellClasses = [];
            if (isOtherMonth) cellClasses.push('other-month');
            if (dateStr === todayStr) cellClasses.push('is-today');
            if (dayOfWeek === 0) cellClasses.push('is-sunday');
            if (dayOfWeek === 6) cellClasses.push('is-saturday');
            
            const selectedStaff = staffList.find(s => s.employeeId === currentCalendarEmployeeId);
            const staffName = selectedStaff ? selectedStaff.name : '';
            const staffGroupId = selectedStaff ? selectedStaff.groupId : '';
            const clickAction = isOtherMonth ? '' : `onclick="openProxyReport('${currentCalendarEmployeeId}', '${escapeHTML(staffName)}', '${dateStr}', '${staffGroupId || ''}')"`;

            html += `<td data-date="${dateStr}" class="${cellClasses.join(' ')}" ${clickAction}>
                        <div class="day-cell-content">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                <div class="day-number">${day}</div>
                                <div style="display: flex; gap: 2px;">${accommodationHtml}${onSiteBadgeHtml}</div>
                            </div>
                            <div class="status-container">
                                ${statusIndicatorHtml}
                                <div class="time-info-container">
                                    ${workTimeHtml}
                                    ${reportedTimeHtml}
                                </div>
                            </div>
                        </div>
                     </td>`;
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }
        html += '</tr>';
    }
    html += '</tbody></table>';

    const styleId = 'staff-calendar-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .custom-calendar-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            .custom-calendar-table th, .custom-calendar-table td { border: 1px solid #e0e0e0; vertical-align: top; height: 100px; }
            .custom-calendar-table th { background-color: #f7f7f7; font-weight: normal; color: #333; padding: 4px; text-align: center; }
            .custom-calendar-table td { cursor: pointer; transition: background-color 0.2s; }
            .custom-calendar-table td:hover { background-color: #f5f5f5; }
            .custom-calendar-table .day-cell-content { padding: 4px; }
            .custom-calendar-table .day-number { font-size: 0.9em; }
            .custom-calendar-table .is-today .day-number { font-weight: bold; color: #d9534f; background-color: #ffebcd; border-radius: 50%; width: 1.5em; height: 1.5em; display: inline-block; text-align: center; line-height: 1.5em;}
            .custom-calendar-table .is-sunday { color: #e74c3c; } .custom-calendar-table .is-saturday { color: #3498db; }
            .custom-calendar-table .other-month { color: #ccc; background-color: #fafafa; cursor: default; } .custom-calendar-table .other-month:hover { background-color: #fafafa; }
            .status-container { margin-top: 4px; }
            .status-indicator { font-size: 0.7em; color: white; padding: 2px 4px; border-radius: 3px; text-align: center; margin-bottom: 4px; }
            .time-info-container { font-size: 0.75em; color: #555; line-height: 1.3; }
        `;
        document.head.appendChild(style);
    }

    // 共通のバッジスタイルを設定
    setupSharedBadgeStyles();

    return html;
}

/**
 * 共通のバッジスタイルを適用する
 */
function setupSharedBadgeStyles() {
    const styleId = 'shared-badge-style';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        .accommodation-badge { display: inline-block; background-color: #01721d; color: white; font-size: 0.7em; padding: 1px 4px; border-radius: 3px; }
        .on-site-badge { display: inline-block; color: white; font-size: 0.7em; padding: 1px 4px; border-radius: 3px; }
        .on-site-badge.full { background-color: #032de6; }
        .on-site-badge.half { background-color: rgb(89, 141, 253); }
    `;
    document.head.appendChild(style);
}

// --- 代理入力用の自動保存機能 ---
let proxyAutoSaveTimer = null;

/**
 * 代理入力中の下書き保存用のキーを生成する
 */
function getProxyDraftKey() {
    if (!currentProxyTarget) return null;
    return `proxyDraftReport_${currentProxyTarget.employeeId}_${currentProxyTarget.date}`;
}

/**
 * 代理入力中の工数内容を下書きとしてlocalStorageに保存する
 */
function saveProxyDraftReport() {
    const formWrapper = document.getElementById('proxy-report-form-wrapper');
    // 代理入力フォームが表示されていない、または対象者がいない場合は何もしない
    if (!formWrapper || !currentProxyTarget) {
        if (proxyAutoSaveTimer) clearInterval(proxyAutoSaveTimer);
        // キーが取得できれば、関連する下書きを削除
        const draftKey = getProxyDraftKey();
        if (draftKey) localStorage.removeItem(draftKey);
        return;
    }

    const tasks = [];
    document.querySelectorAll('#proxy-task-entries-container .task-entry').forEach(entry => {
        const majorIn = entry.querySelector('.task-category-major');
        const minorIn = entry.querySelector('.task-category-minor');
        const timeIn = entry.querySelector('.task-time');
        
        if (majorIn.value || minorIn.value || timeIn.value) {
            tasks.push({
                categoryA_id: majorIn.dataset.id || '',
                categoryA_label: majorIn.value || '',
                categoryB_id: minorIn.dataset.id || '',
                categoryB_label: minorIn.value || '',
                time: timeIn.value || ''
            });
        }
    });

    const draft = {
        workTime: document.getElementById('proxy-report-work').value,
        tasks: tasks,
        savedAt: new Date().toISOString()
    };

    const draftKey = getProxyDraftKey();
    if (!draftKey) return;

    // 入力内容が空なら下書きを削除
    if (tasks.length === 0 && (!draft.workTime || draft.workTime === '0')) {
        localStorage.removeItem(draftKey);
    } else {
        localStorage.setItem(draftKey, JSON.stringify(draft));
        console.log('Proxy draft saved at', new Date().toLocaleTimeString());
    }
}

/**
 * localStorageから代理入力の下書きを復元する
 */
function restoreProxyDraftReport() {
    const draftKey = getProxyDraftKey();
    if (!draftKey) return;

    const draftString = localStorage.getItem(draftKey);
    if (!draftString) return;

    try {
        const draft = JSON.parse(draftString);
        document.getElementById('proxy-report-work').value = draft.workTime;
        
        // 復元前に既存のタスク行をクリア
        document.getElementById('proxy-task-entries-container').innerHTML = '';
        proxyTaskCounter = 0;

        if (draft.tasks && draft.tasks.length > 0) {
            draft.tasks.forEach(task => addProxyTaskEntry(task));
        } else {
            addProxyTaskEntry(); // 空の行を追加
        }
        updateProxyWorkTimeSummary();
        console.log('Proxy draft restored.');
    } catch (error) {
        console.error('Failed to restore proxy draft:', error);
    }
}

// --- 初期化処理 ---
async function main() {
    try {
        await liff.init({ liffId: LIFF_ID });

        // PCブラウザで未ログインの場合はログイン画面へリダイレクト
        if (!liff.isLoggedIn()) {
            // エンドポイントURLと異なるページでログインする場合、戻り先(redirectUri)を明示しないとエンドポイント(index.html)に飛ばされます
            liff.login({ redirectUri: window.location.href });
            return;
        }

        // 日付マッピングを生成 (liff-app.jsから移植)
        const todayForMap = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
        const mapStartDate = new Date(Date.UTC(todayForMap.getUTCFullYear() - 5, 0, 1)); // 5年前
        const mapEndDate = new Date(Date.UTC(todayForMap.getUTCFullYear() + 5, 11, 31)); // 5年後
        generateDateToMonthMap(mapStartDate, mapEndDate);

        await updateUserInfo();
        setupCategoryModal(); // 新規カテゴリ作成モーダルのイベントを初期化
        setupEditCategoryModal(); // 編集用カテゴリモーダルのイベントを初期化
        
        // ナビゲーション初期化と初期データ読み込み
        setupNavigation();
        // URLのハッシュを見て初期画面を決定
        const initialTarget = window.location.hash.substring(1) || 'home';
        handleNavigation(initialTarget, {}, { push: true }); // 初期表示時も履歴にstateを登録

        // ローディング画面を非表示にし、メイン画面を表示
        const loadingOverlay = document.getElementById('loading-overlay');
        const appContainer = document.querySelector('.app-container');
        
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        if (appContainer) appContainer.style.display = ''; // CSSのdisplay設定(flexなど)を有効にする

    } catch (error) {
        console.error('LIFF initialization failed', error);
        const userInfoEl = document.getElementById('admin-user-info');
        if (userInfoEl) userInfoEl.textContent = '認証エラー';

        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.innerHTML = `
                <div style="text-align: center; padding: 20px;">
                    <div style="font-size: 1.2em; color: #d9534f; font-weight: bold; margin-bottom: 10px;">エラーが発生しました</div>
                    <div style="color: #333;">${escapeHTML(error.message)}</div>
                    <button onclick="window.location.reload()" style="margin-top: 20px; padding: 8px 16px; cursor: pointer;">再読み込み</button>
                </div>
            `;
        }
    }
}

main();

// --- 代理入力機能 ---

let proxyTaskCounter = 0;
let proxyCategoryAOptions = [];
let proxyCategoryBOptions = [];
let proxyActiveSliderInput = null;
let currentProxyTarget = null; // { employeeId, name, date, groupId, returnTarget }
let currentProxyHistory = { catA: [], catB: [] }; // 代理入力対象者の履歴
let proxySelectionResolver = null; // 選択パネルのPromise解決用

/**
 * 代理入力画面を開く
 */
async function openProxyReport(employeeId, name, date, groupId) {
    const activeTarget = document.querySelector('.nav-item.active')?.dataset?.target;
    let returnTarget = activeTarget || 'dashboard';
    // ネット事業部のスタッフを開いた場合、一覧に戻る先はネット用を優先
    if (groupId && String(groupId) === '3' && returnTarget === 'dashboard') {
        returnTarget = 'dashboard_net';
    }

    currentProxyTarget = { employeeId, name, date, groupId, returnTarget };
    const contentArea = document.getElementById('content-area');
    
    // 代理入力用のHTMLを読み込む
    try {
        const templateFile = (groupId && String(groupId) === '3')
            ? '_manager_proxy_report_net.html'
            : '_manager_proxy_report.html';
        const html = await fetchHtmlAsString(templateFile);
        contentArea.innerHTML = html;
        
        // 対象者の詳細情報（履歴含む）を取得
        try {
            const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/user-by-employee-id?employee_id=${employeeId}`);
            if (response.ok) {
                const userData = await response.json();
                currentProxyHistory = userData.history || { catA: [], catB: [] };
            } else {
                currentProxyHistory = { catA: [], catB: [] };
            }
        } catch (e) {
            console.error("履歴情報の取得に失敗:", e);
            currentProxyHistory = { catA: [], catB: [] };
        }

        // 画面初期化
        await initializeProxyReportScreen();
    } catch (error) {
        console.error('代理入力画面の読み込みエラー:', error);
        alert('画面の読み込みに失敗しました。');
    }
}

/**
 * 代理入力画面の初期化
 */
async function initializeProxyReportScreen() {
    const { employeeId, name, date } = currentProxyTarget;
    
    // 対象者情報の表示
    document.getElementById('proxy-target-info').innerHTML = `
        <strong>対象者:</strong> ${escapeHTML(name)} (ID: ${employeeId})<br>
        <strong>対象日:</strong> ${date}
    `;
    document.getElementById('proxy-report-date').value = date;

    // 共通バッジスタイルを適用
    setupSharedBadgeStyles();

    // イベントリスナー設定
    document.getElementById('close-proxy-report-btn').addEventListener('click', () => {
        // ★タイマー停止と下書き破棄
        if (proxyAutoSaveTimer) clearInterval(proxyAutoSaveTimer);
        const draftKey = getProxyDraftKey();
        if (draftKey) localStorage.removeItem(draftKey);

        // 一覧画面に戻る
        handleNavigation(currentProxyTarget?.returnTarget || 'dashboard');
    });
    
    document.getElementById('proxy-back-to-list-btn').addEventListener('click', () => {
        // ★タイマー停止と下書き破棄
        if (proxyAutoSaveTimer) clearInterval(proxyAutoSaveTimer);
        const draftKey = getProxyDraftKey();
        if (draftKey) localStorage.removeItem(draftKey);

        handleNavigation(currentProxyTarget?.returnTarget || 'dashboard');
    });

    // ボタンのテキストと機能を変更
    const syncBtn = document.getElementById('proxy-get-work-time-button');
    syncBtn.textContent = 'Jobcan同期';
    syncBtn.removeEventListener('click', handleProxyGetWorkTime); // 古いリスナーを削除
    syncBtn.addEventListener('click', handleProxySyncData); // 新しいリスナーを設定

    // ボタンの位置を変更
    const dateInput = document.getElementById('proxy-report-date');
    if (dateInput && dateInput.parentElement) {
        dateInput.parentElement.appendChild(syncBtn); // 日付入力と同じ行の末尾に移動
        dateInput.parentElement.style.gap = '10px';
    }

    document.getElementById('proxy-add-task-button').addEventListener('click', () => addProxyTaskEntry());
    document.getElementById('proxy-report-work').addEventListener('input', updateProxyWorkTimeSummary);
    document.getElementById('proxy-report-form').addEventListener('submit', handleProxyReportSubmit);

    // 注意事項モーダルのイベントリスナー
    const notesModal = document.getElementById('proxy-work-time-notes-modal');
    const notesTrigger = document.getElementById('proxy-work-time-notes-trigger');
    const notesCloseBtn = document.getElementById('proxy-work-time-notes-close');

    if (notesModal && notesTrigger && notesCloseBtn) {
        notesTrigger.onclick = () => { notesModal.style.display = "block"; };
        notesCloseBtn.onclick = () => { notesModal.style.display = "none"; };
        window.onclick = (event) => {
            if (event.target == notesModal) {
                notesModal.style.display = "none";
            }
        };
    }

    // カテゴリデータの準備
    await setupProxyCategoryDatalists();

    // 既存データの読み込み
    await loadProxyExistingData();

    // ★下書き復元の確認
    const draftKey = getProxyDraftKey();
    if (draftKey) {
        const draftString = localStorage.getItem(draftKey);
        if (draftString) {
            try {
                const draft = JSON.parse(draftString);
                const savedDate = new Date(draft.savedAt).toLocaleString();
                if (confirm(`${savedDate}に保存された代理入力途中のデータがあります。復元しますか？`)) {
                    restoreProxyDraftReport();
                }
                // 復元するしないに関わらず、一度確認したら下書きは削除
                localStorage.removeItem(draftKey);
            } catch(e) {
                localStorage.removeItem(draftKey);
            }
        }
    }

    // ★自動保存タイマーを開始
    if (proxyAutoSaveTimer) clearInterval(proxyAutoSaveTimer);
    proxyAutoSaveTimer = setInterval(saveProxyDraftReport, 10000);

    // スライダー関連のイベント
    setupProxySliderEvents();
}

/**
 * 履歴に基づいて選択肢をソートするヘルパー関数
 */
function sortProxyOptionsByHistory(options, historyIds) {
    if (!historyIds || historyIds.length === 0) return options;
    const historyMap = new Map(historyIds.map((id, index) => [id, index]));
    
    return [...options].sort((a, b) => {
        const indexA = historyMap.has(a.id) ? historyMap.get(a.id) : Infinity;
        const indexB = historyMap.has(b.id) ? historyMap.get(b.id) : Infinity;
        if (indexA !== indexB) return indexA - indexB;
        return 0;
    });
}

/**
 * 代理入力用のカテゴリデータを準備
 */
async function setupProxyCategoryDatalists() {
    try {
        // 大分類
        const responseA = await fetchWithAuth(`${API_BASE_URL}/api/categories/category_a`);
        if (responseA.ok) {
            const categories = await responseA.json();
            proxyCategoryAOptions = categories.map(cat => ({ id: cat.id, label: cat.label }));
            // 履歴でソート
            proxyCategoryAOptions = sortProxyOptionsByHistory(proxyCategoryAOptions, currentProxyHistory.catA);
        }

        // 小分類 (対象者のグループに基づいて取得)
        let kind = 'engineering';
        // グループID '3' はネット事業部とみなす
        if (currentProxyTarget.groupId && String(currentProxyTarget.groupId) === '3') {
            kind = 'net';
        }

        const responseB = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b?kind=${kind}`);
        if (responseB.ok) {
            const categories = await responseB.json();
            // アクティブなカテゴリのみを抽出
            const activeCategories = categories.filter(cat => cat.active !== false);
            
            proxyCategoryBOptions = activeCategories.map(cat => ({
                id: cat.id,
                label: cat.label,
                client: cat.client || '',
                project: cat.project || '',
                offices: cat.offices || []
            }));
            proxyCategoryBOptions.sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }));
            // 履歴でソート (通常のソートの後に適用することで、履歴外のものは元の順序を維持)
            proxyCategoryBOptions = sortProxyOptionsByHistory(proxyCategoryBOptions, currentProxyHistory.catB);
        }
    } catch (error) {
        console.error("カテゴリ候補の取得に失敗:", error);
    }
}

/**
 * 既存の勤務時間と日報データを読み込む
 */
async function loadProxyExistingData() {
    const { employeeId, date } = currentProxyTarget;
    const messageDiv = document.getElementById('proxy-report-message');
    
    messageDiv.textContent = 'データを読み込み中...';
    
    try {
        let reportData = {};
        // 勤務時間と日報詳細を並行して取得
        const [workTimeRes, reportDetailsRes] = await Promise.all([
            fetchWithAuth(`${API_BASE_URL}/api/work-time?date=${date}&employee_id=${employeeId}&source=admin`),
            fetchWithAuth(`${API_BASE_URL}/api/report-details?date=${date}&employee_id=${employeeId}`)
        ]);

        let existingTasks = [];
        
        if (workTimeRes.ok) {
            const data = await workTimeRes.json();
            document.getElementById('proxy-report-work').value = data.workTime || 0;
        }

        if (reportDetailsRes.ok) {
            reportData = await reportDetailsRes.json();
            // 日報に保存されている勤務時間があれば、それで上書きする
            if (reportData.jobcan_work_minutes !== undefined) {
                document.getElementById('proxy-report-work').value = reportData.jobcan_work_minutes;
            }
            existingTasks = reportData.tasks || [];
        }

        // バッジ表示エリアの準備と描画
        const workTimeInput = document.getElementById('proxy-report-work');
        let badgeContainer = document.getElementById('proxy-badge-container');
        if (!badgeContainer) {
            badgeContainer = document.createElement('div');
            badgeContainer.id = 'proxy-badge-container';
            badgeContainer.style.marginTop = '5px';
            badgeContainer.style.display = 'flex';
            badgeContainer.style.gap = '5px';
            workTimeInput.parentElement.insertAdjacentElement('afterend', badgeContainer);
        }
        badgeContainer.innerHTML = ''; // クリア

        let accommodationHtml = '';
        if (reportData.has_accommodation) {
            const noteContent = reportData.jobcan_note || '宿泊あり';
            accommodationHtml = `<span class="accommodation-badge" title="${escapeHTML(noteContent)}">宿泊</span>`;
        }

        let onSiteBadgeHtml = '';
        if (reportData.on_site) {
            let badgeText = '';
            let badgeTitle = '';
            if (reportData.on_site === 'full') {
                badgeText = '現場_全';
                badgeTitle = '現場作業 (全日)';
            } else if (reportData.on_site === 'half') {
                badgeText = '現場_半';
                badgeTitle = '現場作業 (半日)';
            }
            if (badgeText) {
                onSiteBadgeHtml = `<span class="on-site-badge ${reportData.on_site}" title="${badgeTitle}">${badgeText}</span>`;
            }
        }
        badgeContainer.innerHTML = accommodationHtml + onSiteBadgeHtml;

        // タスク行を初期化
        document.getElementById('proxy-task-entries-container').innerHTML = '';
        proxyTaskCounter = 0;

        if (existingTasks.length > 0) {
            existingTasks.forEach(task => addProxyTaskEntry(task));
        } else {
            // 既存データがなければ空の行を1つ追加
            addProxyTaskEntry();
        }
        
        updateProxyWorkTimeSummary();
        messageDiv.textContent = '';

    } catch (error) {
        console.error("データ読み込みエラー:", error);
        messageDiv.textContent = 'データの読み込みに失敗しました。';
        addProxyTaskEntry(); // エラーでも入力行は表示
    }
}

/**
 * 代理入力用のタスク行を追加
 */
function addProxyTaskEntry(task = null) {
    proxyTaskCounter++;
    const container = document.getElementById('proxy-task-entries-container');
    const entryDiv = document.createElement('div');
    entryDiv.className = 'task-entry'; // CSSは既存のものを流用
    entryDiv.id = `proxy-task-entry-${proxyTaskCounter}`;
    entryDiv.style.display = 'flex';
    entryDiv.style.alignItems = 'center';
    entryDiv.style.gap = '5px';
    entryDiv.style.marginBottom = '10px';

    entryDiv.innerHTML = `
        <input type="text" class="task-category-major" placeholder="業務種別" style="flex-grow: 1.5; padding: 8px; border: 1px solid #ccc; border-radius: 4px;" readonly>
        <input type="text" class="task-category-minor" placeholder="工事番号/店舗" style="flex-grow: 1; padding: 8px; border: 1px solid #ccc; border-radius: 4px;" readonly>
        <input type="number" class="task-time time-input" placeholder="分" style="width: 80px; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
        <button type="button" class="remove-task-button btn-secondary" style="padding: 8px 12px;">－</button>
    `;

    container.appendChild(entryDiv);

    const majorInput = entryDiv.querySelector('.task-category-major');
    const minorInput = entryDiv.querySelector('.task-category-minor');
    const timeInput = entryDiv.querySelector('.task-time');
    const removeBtn = entryDiv.querySelector('.remove-task-button');

    if (task) {
        majorInput.value = task.categoryA_label || '';
        majorInput.dataset.id = task.categoryA_id || '';
        minorInput.value = task.categoryB_label || '';
        minorInput.dataset.id = task.categoryB_id || '';
        timeInput.value = task.time || '';
    }

    // イベントリスナー
    timeInput.addEventListener('input', updateProxyWorkTimeSummary);
    removeBtn.addEventListener('click', () => {
        entryDiv.remove();
        updateProxyWorkTimeSummary();
    });

    // モーダル選択
    majorInput.addEventListener('click', async () => {
        const selected = await showProxySelectionModal('業務種別を選択', proxyCategoryAOptions);
        if (selected) {
            majorInput.value = selected.label;
            majorInput.dataset.id = selected.id;
            updateProxyWorkTimeSummary();
        }
    });

    minorInput.addEventListener('click', async () => {
        const selected = await showProxySelectionModal('工事番号/店舗を選択', proxyCategoryBOptions);
        if (selected) {
            minorInput.value = selected.label;
            minorInput.dataset.id = selected.id;
            updateProxyWorkTimeSummary();
        }
    });

    // スライダー
    timeInput.addEventListener('click', () => {
        openProxySliderModal(timeInput);
    });
}

/**
 * 代理入力用の選択モーダルを表示
 */
function showProxySelectionModal(title, options) {
    // 既に選択待ちの状態であれば、前の選択をキャンセル（nullで解決）する
    if (proxySelectionResolver) {
        proxySelectionResolver(null);
        proxySelectionResolver = null;
    }

    return new Promise((resolve) => {
        proxySelectionResolver = resolve;

        const titleEl = document.getElementById('proxy-selection-title');
        const placeholder = document.getElementById('proxy-selection-placeholder');
        const container = document.getElementById('proxy-selection-options');
        const actions = document.getElementById('proxy-selection-actions');
        const closeBtn = document.getElementById('proxy-selection-cancel-btn');

        // フィルタコンテナの取得または作成
        let filterContainer = document.getElementById('proxy-selection-filters');
        if (!filterContainer) {
            filterContainer = document.createElement('div');
            filterContainer.id = 'proxy-selection-filters';
            filterContainer.style.marginBottom = '10px';
            filterContainer.style.display = 'flex';
            filterContainer.style.flexWrap = 'wrap';
            filterContainer.style.gap = '5px';
            // タイトルの直後に挿入
            titleEl.parentNode.insertBefore(filterContainer, titleEl.nextSibling);
        }

        titleEl.textContent = title;
        placeholder.style.display = 'none';
        container.style.display = 'block';
        actions.style.display = 'block';
        filterContainer.style.display = 'none'; // デフォルトは非表示

        // リスト描画関数
        const renderList = (items) => {
            container.innerHTML = '';
            if (items.length === 0) {
                container.innerHTML = '<div style="padding:10px; color:#666; text-align:center;">該当する項目はありません</div>';
                return;
            }
            items.forEach(opt => {
                const btn = document.createElement('button');
                btn.className = 'btn-secondary';
                btn.style.display = 'block';
                btn.style.width = '100%';
                btn.style.textAlign = 'left';
                btn.style.marginBottom = '5px';
                
                if (opt.client || opt.project) {
                    const details = [opt.client, opt.project].filter(Boolean).map(escapeHTML).join(' ');
                    btn.innerHTML = `<strong>${escapeHTML(opt.label)}</strong> <span style="font-size:0.8em; color:#666;">${details}</span>`;
                } else {
                    btn.textContent = opt.label;
                }

                btn.onclick = () => {
                    resetProxySelectionPanel();
                    resolve(opt);
                };
                container.appendChild(btn);
            });
        };

        // optionsの要素がofficesを持っているかチェック（工事番号選択の場合のみフィルタを表示）
        const hasOffices = options.length > 0 && Array.isArray(options[0].offices);

        if (hasOffices) {
            filterContainer.style.display = 'flex';
            filterContainer.innerHTML = ''; // フィルタボタンをリセット

            const filters = ['全て', '本社現場', '本社加工', '四日市', '花巻', '千歳'];
            let activeFilter = '全て';

            filters.forEach(filterName => {
                const chip = document.createElement('div');
                chip.textContent = filterName;
                chip.className = 'filter-chip';
                if (filterName === '全て') chip.classList.add('active');

                chip.onclick = () => {
                    // アクティブ状態の更新
                    filterContainer.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                    chip.classList.add('active');
                    
                    // フィルタリング実行
                    if (filterName === '全て') {
                        renderList(options);
                    } else {
                        const filtered = options.filter(opt => opt.offices && opt.offices.includes(filterName));
                        renderList(filtered);
                    }
                };
                filterContainer.appendChild(chip);
            });
            
            // 初期表示（全て）
            renderList(options);
        } else {
            // フィルタ不要な場合（業務種別など）
            renderList(options);
        }

        closeBtn.onclick = () => {
            resetProxySelectionPanel();
            resolve(null);
        };
    });
}

/**
 * 代理入力用の選択パネルをリセットする
 */
function resetProxySelectionPanel() {
    document.getElementById('proxy-selection-title').textContent = '選択してください';
    document.getElementById('proxy-selection-placeholder').style.display = 'block';
    document.getElementById('proxy-selection-options').style.display = 'none';
    document.getElementById('proxy-selection-actions').style.display = 'none';
    document.getElementById('proxy-selection-options').innerHTML = '';
    proxySelectionResolver = null;
}

/**
 * 代理入力用のスライダーモーダルを開く
 */
function openProxySliderModal(inputElement) {
    proxyActiveSliderInput = inputElement;
    const sliderArea = document.getElementById('proxy-slider-area');
    const slider = document.getElementById('proxy-time-slider');
    const valueDisplay = document.getElementById('proxy-slider-value-display');
    
    // 最大値計算
    const totalWork = parseInt(document.getElementById('proxy-report-work').value, 10) || 0;
    const currentValue = parseInt(inputElement.value, 10) || 0;
    
    // 制限を撤廃: 勤務時間、現在の値、または480分のうち最大のものを最大値とする
    slider.max = Math.max(totalWork, currentValue, 480);
    slider.value = currentValue;
    valueDisplay.textContent = `${slider.value} 分`;

    // 残り時間の初期表示更新
    updateProxySliderRemainingTime();

    sliderArea.style.display = 'block';
}

/**
 * スライダー関連のイベント設定
 */
function setupProxySliderEvents() {
    const slider = document.getElementById('proxy-time-slider');
    const valueDisplay = document.getElementById('proxy-slider-value-display');
    
    slider.addEventListener('input', () => {
        valueDisplay.textContent = `${slider.value} 分`;
        updateProxySliderRemainingTime();
    });

    document.getElementById('proxy-slider-step-up').addEventListener('click', () => {
        let currentValue = parseInt(slider.value, 10);
        let currentMax = parseInt(slider.max, 10);
        const newValue = currentValue + 15;
        
        // 最大値を超える場合は最大値を拡張する
        if (newValue > currentMax) {
            slider.max = newValue;
        }
        slider.value = newValue;
        valueDisplay.textContent = `${slider.value} 分`;
        updateProxySliderRemainingTime();
    });
    document.getElementById('proxy-slider-step-down').addEventListener('click', () => {
        slider.value = Math.max(parseInt(slider.value) - 15, 0);
        valueDisplay.textContent = `${slider.value} 分`;
        updateProxySliderRemainingTime();
    });

    document.getElementById('proxy-slider-ok-button').addEventListener('click', () => {
        if (proxyActiveSliderInput) {
            proxyActiveSliderInput.value = slider.value;
            updateProxyWorkTimeSummary();
        }
        document.getElementById('proxy-slider-area').style.display = 'none';
    });
}

/**
 * スライダー操作時の残り時間表示を更新する
 */
function updateProxySliderRemainingTime() {
    const totalWork = parseInt(document.getElementById('proxy-report-work').value, 10) || 0;
    const sliderValue = parseInt(document.getElementById('proxy-time-slider').value, 10) || 0;
    
    // 現在編集中のタスク以外の合計時間を計算
    let otherTasksTotal = 0;
    document.querySelectorAll('#proxy-task-entries-container .task-time').forEach(el => {
        if (el !== proxyActiveSliderInput) {
            otherTasksTotal += parseInt(el.value, 10) || 0;
        }
    });

    const remaining = totalWork - (otherTasksTotal + sliderValue);
    const displayEl = document.getElementById('proxy-slider-remaining-time-display');
    
    if (displayEl) {
        displayEl.textContent = `残り: ${remaining} 分`;
        // マイナスなら赤色、それ以外は通常色
        displayEl.style.color = remaining < 0 ? '#d9534f' : '#666';
    }
}

/**
 * 代理入力のサマリー更新
 */
function updateProxyWorkTimeSummary() {
    const totalWork = parseInt(document.getElementById('proxy-report-work').value, 10) || 0;
    let allocated = 0;
    document.querySelectorAll('#proxy-task-entries-container .task-time').forEach(el => {
        allocated += parseInt(el.value, 10) || 0;
    });
    const remaining = totalWork - allocated;

    document.getElementById('proxy-total-work-time-display').textContent = totalWork;
    document.getElementById('proxy-allocated-time-display').textContent = allocated;
    const remainingEl = document.getElementById('proxy-remaining-time-display');
    remainingEl.textContent = remaining;
    remainingEl.style.color = (remaining === 0 && allocated > 0) ? '#2ecc71' : '#d9534f';

    // 送信ボタン制御
    const submitBtn = document.getElementById('proxy-submit-button');
    const hasValidTask = Array.from(document.querySelectorAll('#proxy-task-entries-container .task-entry')).some(entry => {
        const major = entry.querySelector('.task-category-major').value;
        const minor = entry.querySelector('.task-category-minor').value;
        const time = parseInt(entry.querySelector('.task-time').value, 10) || 0;
        return major && minor && time > 0;
    });
    submitBtn.disabled = !(hasValidTask || allocated === 0);
}

/**
 * システム管理画面（改修情報マスタ）のUIを描画
 */
function renderSystemAdminUI(container) {
    container.innerHTML = `
        <div style="padding: 20px; max-width: 800px;">
            <div style="margin-bottom: 30px; padding: 20px; background-color: #f8f9fa; border-radius: 8px; border: 1px solid #e9ecef;">
                <h3 style="margin-top: 0; margin-bottom: 15px; font-size: 1.1em; color: #333;">改修情報の追加・編集</h3>
                <input type="hidden" id="sys-notice-id">
                <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                    <select id="sys-notice-type" style="padding: 8px; border-radius: 4px; border: 1px solid #ccc;">
                        <option value="plan">改修予定 (plan)</option>
                        <option value="history">改修履歴 (history)</option>
                    </select>
                    <input type="date" id="sys-notice-date" style="padding: 8px; border-radius: 4px; border: 1px solid #ccc;">
                </div>
                <div style="margin-bottom: 15px;">
                    <input type="text" id="sys-notice-content" placeholder="内容を入力してください" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box;">
                </div>
                <div style="display: flex; gap: 10px;">
                    <button id="sys-notice-save-btn" class="btn-primary" style="padding: 8px 20px; background-color: #3498db; color: white; border: none; border-radius: 4px; cursor: pointer;">保存</button>
                    <button id="sys-notice-clear-btn" class="btn-secondary" style="padding: 8px 20px; background-color: #95a5a6; color: white; border: none; border-radius: 4px; cursor: pointer;">クリア</button>
                </div>
            </div>

            <h3 style="font-size: 1.1em; color: #333; border-bottom: 2px solid #333; padding-bottom: 5px;">登録済み一覧</h3>
            <div id="sys-notice-list-container">読み込み中...</div>
        </div>
    `;

    // イベントリスナー
    document.getElementById('sys-notice-save-btn').addEventListener('click', saveSystemNotice);
    document.getElementById('sys-notice-clear-btn').addEventListener('click', clearSystemNoticeForm);

    // 一覧読み込み
    loadSystemNoticesForAdmin();
}

async function loadSystemNoticesForAdmin() {
    const container = document.getElementById('sys-notice-list-container');
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/system-notices`);
        if (!response.ok) throw new Error('取得失敗');
        const notices = await response.json();
        
        // 日付の新しい順にソート
        notices.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        if (notices.length === 0) {
            container.innerHTML = '<p>データがありません。</p>';
            return;
        }

        let html = '<table class="data-table" style="width: 100%;"><thead><tr><th>Type</th><th>Date</th><th>Content</th><th>Action</th></tr></thead><tbody>';
        notices.forEach(notice => {
            const typeLabel = notice.type === 'plan' ? '<span style="color:#e67e22">予定</span>' : '<span style="color:#2ecc71">履歴</span>';
            // 編集用にデータをJSON文字列として埋め込む
            const jsonStr = escapeHTML(JSON.stringify(notice));
            html += `
                <tr>
                    <td style="text-align:center;">${typeLabel}</td>
                    <td>${escapeHTML(notice.date)}</td>
                    <td>${escapeHTML(notice.content)}</td>
                    <td style="text-align:center; width: 120px;">
                        <button class="btn-secondary edit-notice-btn" data-notice="${jsonStr}" style="padding: 4px 8px; margin-right: 5px;">編集</button>
                        <button class="btn-secondary delete-notice-btn" data-id="${notice.id}" style="padding: 4px 8px; background-color: #e74c3c; color: white;">削除</button>
                    </td>
                </tr>
            `;
        });
        html += '</tbody></table>';
        container.innerHTML = html;

        // 動的に生成したボタンへのイベントリスナー（イベント委譲）
        container.querySelectorAll('.edit-notice-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const notice = JSON.parse(e.target.dataset.notice);
                document.getElementById('sys-notice-id').value = notice.id;
                document.getElementById('sys-notice-type').value = notice.type;
                document.getElementById('sys-notice-date').value = notice.date;
                document.getElementById('sys-notice-content').value = notice.content;
                document.getElementById('sys-notice-save-btn').textContent = '更新';
                window.scrollTo(0, 0);
            });
        });
        container.querySelectorAll('.delete-notice-btn').forEach(btn => {
            btn.addEventListener('click', (e) => deleteSystemNotice(e.target.dataset.id));
        });

    } catch (error) {
        container.innerHTML = `<p style="color:red;">エラー: ${error.message}</p>`;
    }
}

async function saveSystemNotice() {
    const id = document.getElementById('sys-notice-id').value;
    const type = document.getElementById('sys-notice-type').value;
    const date = document.getElementById('sys-notice-date').value;
    const content = document.getElementById('sys-notice-content').value.trim();

    if (!date || !content) {
        alert('日付と内容は必須です。');
        return;
    }

    const btn = document.getElementById('sys-notice-save-btn');
    btn.disabled = true;
    btn.textContent = '保存中...';

    try {
        const method = id ? 'PUT' : 'POST';
        const url = id ? `${API_BASE_URL}/api/system-notices/${id}` : `${API_BASE_URL}/api/system-notices`;
        
        const response = await fetchWithAuth(url, {
            method: method,
            body: JSON.stringify({ type, date, content })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `保存に失敗しました (Status: ${response.status})`);
        }

        alert('保存しました。');
        clearSystemNoticeForm();
        loadSystemNoticesForAdmin();

    } catch (error) {
        console.error(error);
        alert(`エラー: ${error.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = id ? '更新' : '保存';
    }
}

async function deleteSystemNotice(id) {
    if (!confirm('本当に削除しますか？')) return;

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/system-notices/${id}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `削除失敗 (Status: ${response.status})`);
        }
        
        loadSystemNoticesForAdmin();
    } catch (error) {
        alert(`エラー: ${error.message}`);
    }
}

function clearSystemNoticeForm() {
    document.getElementById('sys-notice-id').value = '';
    document.getElementById('sys-notice-type').value = 'plan';
    document.getElementById('sys-notice-date').value = '';
    document.getElementById('sys-notice-content').value = '';
    document.getElementById('sys-notice-save-btn').textContent = '保存';
}

/**
 * 代理入力画面用のJobcanデータ同期処理
 */
async function handleProxySyncData() {
    const { employeeId, date } = currentProxyTarget;
    const btn = document.getElementById('proxy-get-work-time-button');
    
    if (!confirm("Jobcanから勤怠データ（有休・宿泊備考）を取得し、反映しますか？")) return;

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "同期中...";

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/sync-paid-holidays`, {
            method: 'POST',
            body: JSON.stringify({ 
                date: date,
                target_employee_id: employeeId
            })
        });
        if (!response.ok) throw new Error('同期に失敗しました');
        
        alert('同期が完了しました。画面を更新します。');
        await loadProxyExistingData();
    } catch (error) {
        console.error(error);
        alert(`エラー: ${error.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

/**
 * Jobcanから勤務時間を取得 (代理入力用)
 */
async function handleProxyGetWorkTime() {
    const { employeeId, date } = currentProxyTarget;
    const btn = document.getElementById('proxy-get-work-time-button');
    
    btn.disabled = true;
    btn.textContent = '取得中';
    
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/work-time?date=${date}&employee_id=${employeeId}&source=admin&wait=3`);
        if (response.ok) {
            const data = await response.json();
            document.getElementById('proxy-report-work').value = data.workTime || 0;
            updateProxyWorkTimeSummary();
        } else {
            alert('勤務時間の取得に失敗しました。');
        }
    } catch (error) {
        console.error(error);
        alert('エラーが発生しました。');
    } finally {
        btn.disabled = false;
        btn.textContent = '受信';
    }
}

/**
 * 代理報告の送信
 */
async function handleProxyReportSubmit(e) {
    e.preventDefault();
    const { employeeId, date } = currentProxyTarget;

    // ログインユーザー自身の場合は権限チェックをスキップ
    const isSelf = cachedAdminUserInfo && String(cachedAdminUserInfo.employeeId) === String(employeeId);
    if (!isSelf) {
        if (!await checkAdminPermission()) return; // ★権限チェック
    }

    const submitBtn = document.getElementById('proxy-submit-button');
    
    if (!confirm('この内容で代理報告を送信しますか？')) return;

    submitBtn.disabled = true;
    submitBtn.textContent = '送信中...';

    const tasks = [];
    document.querySelectorAll('#proxy-task-entries-container .task-entry').forEach(entry => {
        const majorIn = entry.querySelector('.task-category-major');
        const minorIn = entry.querySelector('.task-category-minor');
        const timeIn = entry.querySelector('.task-time');
        
        if (majorIn.value && minorIn.value && timeIn.value > 0) {
            tasks.push({
                categoryA_id: majorIn.dataset.id,
                categoryA_label: majorIn.value,
                categoryB_id: minorIn.dataset.id,
                categoryB_label: minorIn.value,
                time: parseInt(timeIn.value, 10)
            });
        }
    });

    const payload = {
        date: date,
        taskTotalMinutes: parseInt(document.getElementById('proxy-allocated-time-display').textContent, 10),
        jobcanWorkMinutes: parseInt(document.getElementById('proxy-report-work').value, 10),
        tasks: tasks,
        // 代理入力用のパラメータを追加 (API側の対応が必要)
        target_employee_id: employeeId,
        is_proxy: true
    };

    try {
        // APIエンドポイントは既存の /api/reports を使用する想定
        // ※ただし、API側で target_employee_id を受け取る改修が必要
        const response = await fetchWithAuth(`${API_BASE_URL}/api/reports`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error('送信に失敗しました');

        // ★送信成功時にタイマー停止と下書き削除
        if (proxyAutoSaveTimer) clearInterval(proxyAutoSaveTimer);
        const draftKey = getProxyDraftKey();
        if (draftKey) localStorage.removeItem(draftKey);

        document.getElementById('proxy-report-form-wrapper').style.display = 'none';
        document.getElementById('proxy-completion-screen').style.display = 'block';

    } catch (error) {
        console.error(error);
        alert(`エラー: ${error.message}`);
        submitBtn.disabled = false;
        submitBtn.textContent = '代理報告を送信';
    }
}