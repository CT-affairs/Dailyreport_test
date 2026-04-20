// --- 設定 (liff-app.jsと同じものを使用) ---
const LIFF_ID = "2008638177-6GA6Mf63"; // ←ここに実際のLIFF IDを貼り付けてください
const API_BASE_URL = "https://dailyreport-service-1088643883290.asia-northeast1.run.app";
/** Invoice OCR（Cloud Run）。帳票_一覧カレンダー用。CORS はサービス側 INVOICE_OCR_CORS_ORIGIN で調整 */
const INVOICE_OCR_BASE_URL = "https://invoice-ocr-1088643883290.asia-northeast1.run.app";

/**
 * リンククリックを処理し、修飾キーが押されている場合はブラウザのデフォルト動作に任せる。
 * @param {MouseEvent} event - クリックイベント
 * @param {Function} callback - 通常クリック時に実行するコールバック
 */
function handleLinkNavigation(event, callback) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) {
        return; // Let the browser handle the click
    }
    event.preventDefault();
    callback();
}
/**
 * 認証情報付きでAPIにリクエストを送信するfetchのラッパー関数
 * (liff-app.jsから複製。後で共通化する)
 */
const USE_PC_SESSION_AUTH = true; // PC版: セッション(Cookie)優先。スマホLIFFは liff-app.js を維持。
let pcSessionEnsuringPromise = null;

/** 本番 monthly_closings の前月度ステータス（GET /api/manager/monthly-closing/status） */
let dashboardMonthlyClosingStatus = null;

async function ensurePcSession() {
    if (!USE_PC_SESSION_AUTH) return;
    if (pcSessionEnsuringPromise) return pcSessionEnsuringPromise;

    pcSessionEnsuringPromise = (async () => {
        if (typeof liff === 'undefined') {
            throw new Error('LIFF SDK が読み込まれていません。');
        }
        // main() で init 済み想定だが、環境差の保険
        try {
            await liff.init({ liffId: LIFF_ID });
        } catch {
            // ignore (already initialized)
        }

        if (!liff.isLoggedIn()) {
            // セッションが無い/期限切れ時のみ LINE ログインへ
            liff.login({ redirectUri: window.location.href });
            throw new Error('ログインにリダイレクトします。');
        }

        const idToken = await liff.getIDToken();
        if (!idToken) throw new Error('IDトークンが取得できませんでした。');

        const res = await fetch(`${API_BASE_URL}/api/pc/session`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${idToken}` },
            credentials: 'include',
            cache: 'no-cache',
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.message || `セッション発行に失敗しました (${res.status})`);
        }
    })().finally(() => {
        pcSessionEnsuringPromise = null;
    });

    return pcSessionEnsuringPromise;
}

async function fetchWithAuth(url, options = {}) {
    const headers = {
        ...options.headers,
        'Content-Type': 'application/json',
    };
    
    // cache: 'no-cache' を追加して、ブラウザキャッシュを無効化する
    let response = await fetch(url, { ...options, headers, cache: 'no-cache', credentials: 'include' });

    // PC版: セッションが無効なら、このタイミングのみLINEログイン→セッション発行→再試行
    if (USE_PC_SESSION_AUTH && response.status === 401) {
        try {
            await ensurePcSession();
            response = await fetch(url, { ...options, headers, cache: 'no-cache', credentials: 'include' });
        } catch (e) {
            console.warn('ensurePcSession failed:', e);
        }
    }

    // 401エラー（認証エラー）かつトークン期限切れの場合の自動復旧処理
    if (response.status === 401) {
        const errorData = await response.clone().json().catch(() => ({}));
        // バックエンドからのエラーメッセージに「有効期限」などが含まれている場合
        if (errorData.message && (errorData.message.includes("有効期限") || errorData.message.includes("トークン"))) {
            console.warn("トークン有効期限切れを検知。再ログインを実行します。");
            // ネット事業部: Firestore へ最終同期（下書きは使わない）。工務部: localStorage 下書き。
            const isNetProxyOpen = document.getElementById('proxy-report-container')
                && currentProxyTarget
                && String(currentProxyTarget.groupId) === '3';
            if (isNetProxyOpen) {
                try {
                    await autoSaveProxyNetReport('pre-relogin');
                } catch (e) {
                    console.error('pre-relogin auto-save failed', e);
                }
                const dk = getProxyDraftKey();
                if (dk) localStorage.removeItem(dk);
            } else {
                saveProxyDraftReport();
            }

            // PC版は Cookie セッション優先のため、ここで強制ログアウトしない（必要時のみ ensurePcSession に任せる）
            if (!USE_PC_SESSION_AUTH) {
                liff.logout();
                window.location.reload();
                throw new Error("セッションの有効期限が切れました。再読み込みしています...");
            }
        }
    }
    return response;
}

/**
 * スクリプトを動的に読み込むヘルパー関数
 * @param {string} src スクリプトのURL
 * @returns {Promise<void>}
 */
function loadScript(src) {
    return new Promise((resolve, reject) => {
        // すでに読み込まれていないかチェック
        if (document.querySelector(`script[src="${src}"]`)) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => {
            console.error(`Failed to load script: ${src}`);
            reject(new Error(`Failed to load script: ${src}`));
        };
        document.head.appendChild(script);
    });
}

/**
 * ユーザー情報を取得してサイドバーに表示する
 */
async function updateUserInfo() {
    const userInfoContainer = document.getElementById('admin-user-info');
    userInfoContainer.textContent = '読込中...';

    try {
        // PCセッション方式では、LINEプロフィール取得は必須にしない（必要時のみログインが発生するため）
        let profile = null;
        try {
            if (typeof liff !== 'undefined' && liff.isLoggedIn && liff.isLoggedIn()) {
                profile = await liff.getProfile();
            }
        } catch {
            profile = null;
        }
        
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
        const lineName = profile && profile.displayName ? escapeHTML(profile.displayName) : '（未ログイン）';
        let html = `<div style="font-weight:bold; margin-bottom:4px;">${lineName}</div>`;
        
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
        document.getElementById('logout-btn').addEventListener('click', async () => {
            try {
                // PCセッション破棄（Cookie削除）
                await fetch(`${API_BASE_URL}/api/pc/session`, { method: 'DELETE', credentials: 'include', cache: 'no-cache' });
            } catch (e) {
                console.warn(e);
            }
            try {
                // LINEログイン状態もクリアしたい場合は明示ログアウト
                if (typeof liff !== 'undefined' && liff.isLoggedIn && liff.isLoggedIn()) {
                    liff.logout();
                }
            } catch (e) {
                console.warn(e);
            }
            window.location.reload();
        });

        // --- メニューの表示制御 ---
        const koumuMenuItems = document.querySelectorAll('.menu-koumu');
        const netMenuItems = document.querySelectorAll('.menu-net');
        const somuMenuItems = document.querySelectorAll('.menu-somu');

        const showKoumu = () => koumuMenuItems.forEach(el => el.style.display = '');
        const hideKoumu = () => koumuMenuItems.forEach(el => el.style.display = 'none');
        const showNet = () => netMenuItems.forEach(el => el.style.display = '');
        const hideNet = () => netMenuItems.forEach(el => el.style.display = 'none');
        const showSomu = () => somuMenuItems.forEach(el => el.style.display = '');
        const hideSomu = () => somuMenuItems.forEach(el => el.style.display = 'none');

        if (systemUser) {
            const isSystemAdmin = systemUser.is_system_admin === true || systemUser.is_system_admin === 1 || systemUser.is_system_admin === '1';
            const mainGroupId = systemUser.main_group;

            if (isSystemAdmin) {
                // システム管理者は全て表示
                showKoumu();
                showNet();
                showSomu();
            } else {
                hideSomu();
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
            hideSomu();
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
 * Base64（UTF-8 CSV バイト列）をダウンロードする（ネット業務別集計など）
 */
function downloadCsvFromBase64(filename, base64Content) {
    const bin = atob(base64Content);
    const buffer = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        buffer[i] = bin.charCodeAt(i);
    }
    const blob = new Blob([buffer], { type: 'text/csv;charset=utf-8;' });
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

// --- 帳票一覧（Invoice OCR）カレンダー（日報カレンダーと同系のグリッド） ---
let invoiceListCalendarYear = null;
let invoiceListCalendarMonth = null; // 1-12

// --- UI操作・画面描画 ---

/**
 * サイドバーのナビゲーション設定
 */
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            // 修飾キー(Ctrl, Cmd, Shift)または中クリックの場合はブラウザのデフォルト動作に任せる
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) {
                return;
            }
            e.preventDefault(); // 通常のクリックではJSで画面遷移

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
            // stateがない場合(手動でのハッシュ変更など)、URLから復元する
            const hash = window.location.hash.substring(1);
            const [target, queryString] = hash.split('?');
            const params = new URLSearchParams(queryString);
            const paramsObj = Object.fromEntries(params.entries());
            handleNavigation(target || 'home', paramsObj, { push: false });
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
 * ネット事業部向けカテゴリ設定画面のUIを描画
 */
async function renderCategoriesNetUI(container) {
    try {
        // HTMLテンプレートを読み込み
        const html = await fetchHtmlAsString('_manager_categories_net.html');
        container.innerHTML = html;
        // 左右のtbodyを取得
        const tbodyLeft = container.querySelector('#net-category-table-body-left');
        const tbodyRight = container.querySelector('#net-category-table-body-right');

        // カテゴリBとカテゴリAのデータを並行取得
        const [catBRes, catARes] = await Promise.all([
            fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b?kind=net`),
            fetchWithAuth(`${API_BASE_URL}/api/manager/categories/a?kind=net`)
        ]);

        if (!catBRes.ok || !catARes.ok) {
            throw new Error('カテゴリデータの取得に失敗しました。');
        }

        const categoriesB = await catBRes.json();
        const categoriesA = await catARes.json();

        // カテゴリBを左右のグループに分割し、指定された順序でソートする
        // ラベルの大文字小文字や表記ゆれに対応するため候補を追加
        const leftOrder = ['KIREI', 'kireispot', 'FAVRAS', 'favras', 'KIMITO', 'kimito'];
        const rightOrder = ['全体', '梱包室'];

        // 大文字小文字を無視して比較するヘルパー
        const isMatch = (label, list) => list.some(item => item.toUpperCase() === label.toUpperCase());
        // ソート順序用インデックス取得
        const getOrderIndex = (label, list) => list.findIndex(item => item.toUpperCase() === label.toUpperCase());

        const categoriesB_left = categoriesB
            .filter(cat => isMatch(cat.label, leftOrder))
            .sort((a, b) => getOrderIndex(a.label, leftOrder) - getOrderIndex(b.label, leftOrder));

        const categoriesB_right = categoriesB
            .filter(cat => rightOrder.includes(cat.label))
            .sort((a, b) => rightOrder.indexOf(a.label) - rightOrder.indexOf(b.label));

        // 集計項目（カテゴリB）に割り当てる5色を定義
        const categoryBColors = ['#e9dce4',' #dae6e9', '#e0ebe0', '#e7e6da', '#e1dce9'];

        // 背景色が濃い場合に文字色を白にするための判定用
        const isDarkColor = (color) => {
            if (!color) return false;
            const hex = color.replace('#', '');
            if (hex.length !== 6) return false;
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            return (r * 0.299 + g * 0.587 + b * 0.114) < 140;
        };

        // テーブルHTMLを生成する共通関数（カテゴリBごとに1コンテナ）
        const generateTableHtml = (targetCategoriesB, allCategoriesA) => {
            let tableHtml = '';
            targetCategoriesB.forEach((catB, bIndex) => {
                const catBLabel = catB.label;
                const catBId = catB.id; // ★カテゴリBのID
                const catBColor = categoryBColors[bIndex % categoryBColors.length];
                const settings = catB.category_a_settings || {};
                const sortSettings = catB.category_a_sort || {}; // ★PC入力画面専用 並び順設定

                // カテゴリBごとに独立したテーブルコンテナを作成
                let rowsHtml = '';
                allCategoriesA.forEach((catA, index) => {
                    const catALabel = catA.label;
                    const catAId = catA.id;
                    const colorCode = settings[catAId] || '';
                    const isChecked = !!settings[catAId];
                    const sortValue = typeof sortSettings[catAId] === 'number' ? sortSettings[catAId] : '';
                    const uniqueId = `cb_${catBId}_${catAId}`;

                    rowsHtml += '<tr>';
                    if (index === 0) {
                        // 1列目: 集計項目の値（見出し）を上だけに表示し、rowspan で固定
                        rowsHtml += `<td rowspan="${allCategoriesA.length}" data-original-rowspan="${allCategoriesA.length}" style="vertical-align: middle; font-weight: bold; background-color: ${catBColor};">${escapeHTML(catBLabel)}</td>`;
                    }
                    rowsHtml += `<td>${escapeHTML(catALabel)}</td>`;
                    rowsHtml += `<td class="cell-center">
                        <input type="checkbox" class="net-category-select"
                            id="${uniqueId}"
                            data-b-id="${catBId}"
                            data-b-label="${escapeHTML(catBLabel)}"
                            data-a-id="${catAId}"
                            data-a-label="${escapeHTML(catALabel)}"
                            data-color="${colorCode}"
                            ${isChecked ? 'checked' : ''}>
                    </td>`;

                    const displayColor = colorCode || '#ffffff';
                    rowsHtml += `<td>
                        <div class="color-editor" style="display: flex; align-items: center; gap: 4px;">
                            <input type="color" class="net-category-color-picker" value="${displayColor}" data-target-id="${uniqueId}" style="border: 1px solid #ccc; padding: 0; width: 24px; height: 24px; cursor: pointer; background: none;">
                            <input type="text" class="net-category-color-text" value="${colorCode.toUpperCase()}" placeholder="#RRGGBB" data-target-id="${uniqueId}" style="font-size: 0.85em; font-family: monospace; color: #333; width: 70px; border: 1px solid #ccc; padding: 2px 4px;">
                        </div>
                    </td>`;

                    // ★PC入力画面専用の並び順（category_a_sort）
                    rowsHtml += `<td>
                        <input type="number"
                               class="net-category-sort"
                               data-b-id="${catBId}"
                               data-a-id="${catAId}"
                               value="${sortValue !== '' ? sortValue : ''}"
                               min="0"
                               step="1"
                               style="width: 60px; padding: 2px 4px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.8em; text-align: right;">
                    </td>`;
                    rowsHtml += '</tr>';
                });

                tableHtml += `
                    <div class="net-category-block">
                        <div class="table-container">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>集計項目の値</th>
                                        <th>業務種別</th>
                                        <th>✓</th>
                                        <th>Color</th>
                                        <th>順序(PC)</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${rowsHtml}
                                </tbody>
                            </table>
                        </div>
                    </div>
                `;
            });
            return tableHtml;
        };

        // 左右のテーブルHTMLを生成して描画（カテゴリBごとにコンテナを並べる）
        tbodyLeft.innerHTML = generateTableHtml(categoriesB_left, categoriesA);
        tbodyRight.innerHTML = generateTableHtml(categoriesB_right, categoriesA);

        // --- カラーピッカーとテキスト入力のイベントリスナー ---
        const handleColorPickerChange = (e) => {
            const picker = e.target;
            const newColor = picker.value.toUpperCase();
            const targetId = picker.dataset.targetId;
            const checkbox = container.querySelector(`#${targetId}`);
            const textInput = picker.nextElementSibling; // The text input is the next sibling

            if (checkbox) checkbox.dataset.color = newColor;
            if (textInput) textInput.value = newColor;
        };

        const handleColorTextChange = (e) => {
            const textInput = e.target;
            let newColor = textInput.value.toUpperCase();

            // Auto-add '#' if missing
            if (newColor && !newColor.startsWith('#')) {
                newColor = '#' + newColor;
            }
            textInput.value = newColor; // Reflect the formatted value

            // Update picker only if the format is valid
            if (/^#[0-9A-F]{6}$/i.test(newColor)) {
                const targetId = textInput.dataset.targetId;
                const checkbox = container.querySelector(`#${targetId}`);
                const picker = textInput.previousElementSibling; // The color picker is the previous sibling

                if (checkbox) checkbox.dataset.color = newColor;
                if (picker) picker.value = newColor;
            }
        };

        container.querySelectorAll('.net-category-color-picker').forEach(picker => {
            picker.addEventListener('input', handleColorPickerChange);
        });

        container.querySelectorAll('.net-category-color-text').forEach(textInput => {
            textInput.addEventListener('change', handleColorTextChange); // Use 'change' to avoid updates on every keystroke
        });

        // --- チェックボックス変更時のイベントリスナー ---
        const handleCheckboxChange = (e) => {
            const checkbox = e.target;
            const row = checkbox.closest('tr');
            if (!row) return;

            const colorPicker = row.querySelector('.net-category-color-picker');
            const colorText = row.querySelector('.net-category-color-text');

            // チェックが入った時、かつ色が未設定の場合のみ処理
            if (checkbox.checked && (!checkbox.dataset.color || !checkbox.dataset.color.startsWith('#'))) {
                const defaultColor = '#FFFFFF';
                checkbox.dataset.color = defaultColor;
                if (colorPicker) colorPicker.value = defaultColor;
                if (colorText) colorText.value = defaultColor;
            }
        };
        container.querySelectorAll('.net-category-select').forEach(checkbox => {
            checkbox.addEventListener('change', handleCheckboxChange);
        });

        // --- マッピング生成テスト用の保存ボタン ---
        const saveContainer = document.createElement('div');
        saveContainer.style.marginTop = '20px';
        // ボタンをコンテナの右端に配置
        saveContainer.style.display = 'flex';
        saveContainer.style.justifyContent = 'flex-end';
        saveContainer.innerHTML = `<button id="save-net-mapping-btn" class="btn-primary">設定を保存</button>`;
        container.appendChild(saveContainer);

        document.getElementById('save-net-mapping-btn').addEventListener('click', async () => {
            const mapping = {};

            // まずカテゴリAごとの色と有効フラグを収集
            container.querySelectorAll('.net-category-select').forEach(cb => {
                const { bId, aId, color, aLabel } = cb.dataset;
                if (!mapping[bId]) mapping[bId] = {};
                if (!mapping[bId][aId]) mapping[bId][aId] = {};
                mapping[bId][aId].active = cb.checked;
                mapping[bId][aId].color = color;
                mapping[bId][aId].label = aLabel;
            });

            // 続いてPC専用の並び順(category_a_sort)も一緒に送る
            container.querySelectorAll('.net-category-sort').forEach(input => {
                const bId = input.dataset.bId;
                const aId = input.dataset.aId;
                if (!mapping[bId]) mapping[bId] = {};
                if (!mapping[bId][aId]) mapping[bId][aId] = {};

                const val = input.value;
                const num = val === '' ? null : Number(val);
                if (num !== null && !Number.isNaN(num)) {
                    mapping[bId][aId].sort = num;
                } else {
                    // 値が空 or 不正な場合は sort を送らない（既存値維持はサーバー側に委ねる）
                    // 明示的に削除したい場合は、別途サーバー側で対応する
                }
            });

            const btn = document.getElementById('save-net-mapping-btn');
            const originalText = btn.textContent;
            btn.disabled = true;
            btn.textContent = '保存中...';

            try {
                const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/net/mapping`, {
                    method: 'POST',
                    body: JSON.stringify(mapping)
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.message || `保存に失敗しました (Status: ${response.status})`);
                }
                const result = await response.json();
                showToast(result.message || '設定を保存しました。', 'success');
                renderCategoriesNetUI(container); // 画面を再描画して最新の状態を反映
            } catch (error) {
                console.error('Failed to save mapping:', error);
                showToast(`エラー: ${error.message}`, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        });

        // --- 表示切替トグルのイベントリスナー ---
        const toggleCheckbox = container.querySelector('#net-category-toggle-checked');
        if (toggleCheckbox) {
            toggleCheckbox.addEventListener('change', () => {
                const isCheckedOnly = toggleCheckbox.checked;
                const sideContainers = [tbodyLeft, tbodyRight];

                sideContainers.forEach(side => {
                    if (!side) return;
                    const blocks = Array.from(side.querySelectorAll('.net-category-block'));

                    blocks.forEach(block => {
                        const rows = Array.from(block.querySelectorAll('tbody tr'));
                        if (!isCheckedOnly) {
                            // フィルターOFF: すべて表示し、rowspanを元に戻す
                            block.style.display = '';
                            rows.forEach((row, idx) => {
                                row.style.display = '';
                                if (idx === 0) {
                                    const headerCell = row.querySelector('td[data-original-rowspan]');
                                    if (headerCell) {
                                        const original = parseInt(headerCell.getAttribute('data-original-rowspan') || rows.length, 10);
                                        headerCell.rowSpan = original;
                                        // ヘッダー行の2〜4列目も必ず表示
                                        row.querySelectorAll('td:not([data-original-rowspan])').forEach(cell => {
                                            cell.style.display = '';
                                        });
                                    }
                                }
                            });
                            return;
                        }

                        // フィルターON: チェックされた業務種別のみ表示
                        const checkedRows = rows.filter(r => r.querySelector('.net-category-select')?.checked);

                        if (checkedRows.length === 0) {
                            // この集計項目には有効な行が無いのでコンテナごと非表示
                            block.style.display = 'none';
                            return;
                        }

                        block.style.display = '';
                        const headerRow = rows[0];
                        const headerCell = headerRow.querySelector('td[data-original-rowspan]');
                        const otherRows = rows.slice(1);
                        const checkedOtherRows = otherRows.filter(r => r.querySelector('.net-category-select')?.checked);

                        // ヘッダー行は、ブロック内に1つでもチェックがあれば常に表示
                        headerRow.style.display = '';
                        const headerChecked = !!headerRow.querySelector('.net-category-select')?.checked;
                        headerRow.querySelectorAll('td:not([data-original-rowspan])').forEach(cell => {
                            // 1行目自身が未チェックなら、2〜4列目は隠す（見出しセルだけ残す）
                            cell.style.display = headerChecked ? '' : 'none';
                        });

                        // 2行目以降は、チェックされた行だけ表示
                        otherRows.forEach(row => {
                            const isRowChecked = !!row.querySelector('.net-category-select')?.checked;
                            row.style.display = isRowChecked ? '' : 'none';
                        });

                        // 先頭行の見出しセルのrowspanを「表示中の行数」に合わせて更新
                        if (headerCell) {
                            const visibleCount = 1 + checkedOtherRows.length; // ヘッダー行 + 表示されているデータ行
                            headerCell.rowSpan = visibleCount;
                        }
                    });
                });
            });
        }

    } catch (error) {
        console.error('Error rendering net categories UI:', error);
        // エラーハンドリングも左右両方に対応
        const tbodyLeft = container.querySelector('#net-category-table-body-left');
        const tbodyRight = container.querySelector('#net-category-table-body-right');
        const errorMessage = `<tr><td colspan="4" class="error" style="text-align:center;">${error.message}</td></tr>`;
        if (tbodyLeft) {
            tbodyLeft.innerHTML = errorMessage;
        }
        if (tbodyRight) {
            tbodyRight.innerHTML = errorMessage;
        }
    }
}

/**
 * 休暇タイプ一覧（Jobcan 休暇タイプマスタ参照）画面。
 * client_id / before_expiration / after_expiration は一覧に含めない。
 */
async function renderHolidaySettingsUI(container) {
    container.innerHTML = `
        <div class="holiday-settings-panel">
            <p style="color:#666; margin-bottom: 12px;">
                Jobcan の休暇タイプ（マスタ）を最新取得し、データベースを更新します。
            </p>
            <div style="margin-bottom: 16px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
                <button type="button" id="holiday-types-refresh-btn" class="btn-primary">最新情報を取得</button>
                <span id="holiday-types-status" style="color:#666; font-size:0.9em;"></span>
            </div>
            <div class="table-container">
                <table class="data-table" id="holiday-types-table" style="display:none;">
                    <thead>
                        <tr>
                            <th>holiday_type_id</th>
                            <th>group_id</th>
                            <th>work_kind_id</th>
                            <th>name</th>
                            <th>vacation_type</th>
                            <th>amount_use</th>
                            <th>holiday (start–end)</th>
                            <th>minutes</th>
                        </tr>
                    </thead>
                    <tbody id="holiday-types-tbody"></tbody>
                </table>
            </div>
            <div id="holiday-types-empty" style="text-align:center; color:#888; padding: 24px;">
                「最新情報を取得」を押すとここに一覧が表示されます。
            </div>
        </div>
    `;

    const btn = document.getElementById('holiday-types-refresh-btn');
    const statusEl = document.getElementById('holiday-types-status');
    const tbody = document.getElementById('holiday-types-tbody');
    const table = document.getElementById('holiday-types-table');
    const emptyEl = document.getElementById('holiday-types-empty');

    const extractList = (data) => {
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.holiday_types)) return data.holiday_types;
        if (data && Array.isArray(data.items)) return data.items;
        return [];
    };

    const fmtHoliday = (h) => {
        if (!h || typeof h !== 'object') return '';
        const s = h.start != null ? String(h.start) : '';
        const e = h.end != null ? String(h.end) : '';
        if (s && e) return `${s} – ${e}`;
        return s || e || '';
    };

    const fetchTypes = async () => {
        statusEl.textContent = '取得中...';
        btn.disabled = true;
        try {
            const res = await fetchWithAuth(`${API_BASE_URL}/api/manager/jobcan/holiday-types`);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.message || `取得に失敗しました (${res.status})`);
            }
            const data = await res.json();
            const rows = extractList(data);
            const saved =
                data && typeof data.saved_to_firestore === 'number' ? data.saved_to_firestore : null;
            const savedLabel =
                saved !== null ? `・Firestore保存 ${saved}件` : '';

            tbody.innerHTML = '';
            if (!rows.length) {
                table.style.display = 'none';
                emptyEl.style.display = 'block';
                emptyEl.textContent = '休暇タイプが0件でした。';
                statusEl.textContent = `完了（表示0件${savedLabel}）`;
                return;
            }

            emptyEl.style.display = 'none';
            table.style.display = '';
            rows.forEach((row) => {
                const tr = document.createElement('tr');
                const holidayStr = fmtHoliday(row.holiday);
                tr.innerHTML = `
                    <td>${escapeHTML(String(row.holiday_type_id ?? ''))}</td>
                    <td>${escapeHTML(String(row.group_id ?? ''))}</td>
                    <td>${escapeHTML(String(row.work_kind_id ?? ''))}</td>
                    <td>${escapeHTML(String(row.name ?? ''))}</td>
                    <td>${escapeHTML(String(row.vacation_type ?? ''))}</td>
                    <td>${escapeHTML(row.amount_use != null ? String(row.amount_use) : '')}</td>
                    <td>${escapeHTML(holidayStr)}</td>
                    <td>${row.minutes != null && row.minutes !== '' ? escapeHTML(String(row.minutes)) : ''}</td>
                `;
                tbody.appendChild(tr);
            });
            statusEl.textContent = `完了（表示 ${rows.length}件${savedLabel}）`;
        } catch (e) {
            console.error(e);
            statusEl.textContent = '';
            showToast(e.message || String(e), 'error');
        } finally {
            btn.disabled = false;
        }
    };

    btn.addEventListener('click', fetchTypes);
}

/**
 * スタッフ一覧（Jobcan 従業員マスタ抜粋）画面。
 */
async function renderStaffListUI(container) {
    container.innerHTML = `
        <div class="staff-list-panel">
            <p style="color:#666; margin-bottom: 12px;">
                Jobcan の従業員マスタ（<code>master/v1/employees</code>）を取得し、一覧用の項目のみ表示します。
                併せて <code>users</code> のうち <code>jobcan_employee_id</code> が一致するドキュメントに <code>work_kind_id</code>（Jobcan の <code>work_kind</code>）を書き込みます。
            </p>
            <div style="margin-bottom: 16px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
                <button type="button" id="staff-list-refresh-btn" class="btn-primary">最新情報を取得</button>
                <span id="staff-list-status" style="color:#666; font-size:0.9em;"></span>
            </div>
            <div class="table-container" style="overflow-x: auto;">
                <table class="data-table" id="staff-list-table" style="display:none;">
                    <thead>
                        <tr>
                            <th>id</th>
                            <th>last_name</th>
                            <th>first_name</th>
                            <th>main_group</th>
                            <th>sub_group</th>
                            <th>work_kind</th>
                        </tr>
                    </thead>
                    <tbody id="staff-list-tbody"></tbody>
                </table>
            </div>
            <div id="staff-list-empty" style="text-align:center; color:#888; padding: 24px;">
                「最新情報を取得」を押すとここに一覧が表示されます。
            </div>
        </div>
    `;

    const btn = document.getElementById('staff-list-refresh-btn');
    const statusEl = document.getElementById('staff-list-status');
    const tbody = document.getElementById('staff-list-tbody');
    const table = document.getElementById('staff-list-table');
    const emptyEl = document.getElementById('staff-list-empty');

    const fmtSubGroup = (sg) => {
        if (!Array.isArray(sg)) return '';
        try {
            return JSON.stringify(sg);
        } catch {
            return String(sg);
        }
    };

    const fetchStaff = async () => {
        statusEl.textContent = '取得中...';
        btn.disabled = true;
        try {
            const res = await fetchWithAuth(`${API_BASE_URL}/api/manager/jobcan/employees`);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.message || `取得に失敗しました (${res.status})`);
            }
            const data = await res.json();
            const rows = Array.isArray(data.employees) ? data.employees : [];

            tbody.innerHTML = '';
            const uuEmpty =
                data && typeof data.users_work_kind_updated === 'number'
                    ? data.users_work_kind_updated
                    : null;
            const uuLabelEmpty = uuEmpty !== null ? `・users更新 ${uuEmpty}件` : '';
            if (!rows.length) {
                table.style.display = 'none';
                emptyEl.style.display = 'block';
                emptyEl.textContent = 'スタッフが0件でした。';
                statusEl.textContent = `完了（表示0件${uuLabelEmpty}）`;
                return;
            }

            emptyEl.style.display = 'none';
            table.style.display = '';
            rows.forEach((row) => {
                const tr = document.createElement('tr');
                const subStr = fmtSubGroup(row.sub_group);
                tr.innerHTML = `
                    <td>${escapeHTML(row.id != null ? String(row.id) : '')}</td>
                    <td>${escapeHTML(String(row.last_name ?? ''))}</td>
                    <td>${escapeHTML(String(row.first_name ?? ''))}</td>
                    <td>${escapeHTML(row.main_group != null ? String(row.main_group) : '')}</td>
                    <td style="font-family: monospace; font-size: 0.85em;">${escapeHTML(subStr)}</td>
                    <td>${escapeHTML(row.work_kind != null ? String(row.work_kind) : '')}</td>
                `;
                tbody.appendChild(tr);
            });
            const cnt = typeof data.count === 'number' ? data.count : rows.length;
            const uu =
                data && typeof data.users_work_kind_updated === 'number'
                    ? data.users_work_kind_updated
                    : null;
            const uuLabel = uu !== null ? `・users更新 ${uu}件` : '';
            statusEl.textContent = `完了（表示 ${cnt}件${uuLabel}）`;
        } catch (e) {
            console.error(e);
            statusEl.textContent = '';
            showToast(e.message || String(e), 'error');
        } finally {
            btn.disabled = false;
        }
    };

    btn.addEventListener('click', fetchStaff);
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
        // パラメータをURLに含める
        const searchParams = new URLSearchParams(params).toString();
        const newUrl = `${window.location.pathname}${window.location.search}#${target}${searchParams ? '?' + searchParams : ''}`;
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

        case 'holiday_settings':
            pageTitle.textContent = '休暇タイプ一覧';
            renderHolidaySettingsUI(contentArea);
            break;

        case 'staff_list':
            pageTitle.textContent = 'スタッフ一覧';
            renderStaffListUI(contentArea);
            break;

        case 'dashboard':
            pageTitle.textContent = '日報_拠点ごと一覧';
            dashboardListMode = 'koumu';
            // 工務: グループ選択を有効
            const groupSelectKoumu = document.getElementById('target-group');
            const dateInput = document.getElementById('target-date');
            if (groupSelectKoumu) {
                groupSelectKoumu.disabled = false;
                groupSelectKoumu.style.display = '';

                // 工務画面ではネット事業部(3)を選択不可にする（キャッシュ等で残っていても削除）
                const netOption = groupSelectKoumu.querySelector('option[value="3"]');
                if (netOption) netOption.remove();

                // ★ パラメータからグループを設定
                if (params.group_id) {
                    groupSelectKoumu.value = params.group_id;
                } else if (String(groupSelectKoumu.value) === '3') {
                    groupSelectKoumu.value = '4,5,6,7,8';
                }
            }
            // ★ パラメータから日付を設定
            if (dateInput && params.date) {
                dateInput.value = params.date;
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
            dashboardListMode = 'koumu';
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
            
        case 'categories_net':
            pageTitle.textContent = 'カテゴリ設定（ネット）';
            renderCategoriesNetUI(contentArea);
            break;

        case 'groups':
            pageTitle.textContent = 'グループ設定';
            contentArea.innerHTML = '<div style="padding:20px;">グループ設定画面（準備中）</div>';
            break;

        case 'invoice_ocr':
            // 帳票_一覧は専用画面へ分離
            window.location.href = 'https://clean-techno.com/liff2/invoice.html';
            break;

        case 'system_admin':
            pageTitle.textContent = 'システム管理';
            renderSystemAdminUI(contentArea);
            break;
    }
}

// --- 帳票_一覧（Invoice OCR / Firestore invoices） ---

/**
 * Invoice OCR は別オリジンのため Cookie セッションは送れず、Bearer が必要。
 * PC版は dailyreport 側が Cookie セッションでも、ここは LIFF の ID トークンが必要。
 * main() が「未ログインでも即リダイレクトしない」ため、帳票画面だけ先に ensurePcSession() で揃える。
 */
async function fetchInvoiceOcrWithAuth(path, options = {}) {
    if (typeof liff === 'undefined') {
        throw new Error('LIFF SDK が読み込まれていません。');
    }
    try {
        await liff.init({ liffId: LIFF_ID });
    } catch {
        // 既に init 済み
    }

    if (USE_PC_SESSION_AUTH) {
        try {
            await ensurePcSession();
        } catch (e) {
            if (e && e.message && String(e.message).includes('リダイレクト')) {
                throw e;
            }
            console.warn('ensurePcSession (invoice-ocr):', e);
        }
    }

    if (!liff.isLoggedIn()) {
        throw new Error(
            'LINE のログインが必要です。画面を再読み込みするか、再度ログインしてください。',
        );
    }

    const idToken = await liff.getIDToken();
    if (!idToken) {
        throw new Error('IDトークンが取得できませんでした。');
    }

    const headers = {
        ...options.headers,
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
    };
    return await fetch(`${INVOICE_OCR_BASE_URL}${path}`, { ...options, headers, cache: 'no-cache' });
}

/** GET /api/invoices の直近結果（チェック変更時は再フェッチせずこれ＋draftで再描画） */
let invoiceOcrListSnapshot = null;

function _normalizeLineItemStatus(st) {
    if (st === 'checked') return 'checked';
    return 'pending';
}

function _normalizeDocumentDate(v) {
    if (v === null || v === undefined) return '';
    const s = String(v).trim();
    if (!s) return '';
    const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (!m) return '';
    const yyyy = m[1];
    const mm = String(parseInt(m[2], 10)).padStart(2, '0');
    const dd = String(parseInt(m[3], 10)).padStart(2, '0');
    return `${yyyy}/${mm}/${dd}`;
}

function _deriveInvoiceStatusFromDraftLines(lineItems) {
    if (!lineItems || lineItems.length === 0) return 'pending';
    let checked = 0;
    lineItems.forEach((li) => {
        if (_normalizeLineItemStatus(li && li.status) === 'checked') checked += 1;
    });
    if (checked === 0) return 'pending';
    if (checked === lineItems.length) return 'checked';
    return 'confirming';
}

function _invoiceDerivedStatusLabel(derived) {
    if (derived === 'checked') return '確認済み（全明細）';
    if (derived === 'confirming') return '一部確認済み';
    return '未確認';
}

function renderInvoiceOcrInvoicesUI(container) {
    container.innerHTML = `
        <div style="padding: 10px; background-color: #f8f9fa; border-bottom: 1px solid #e9ecef; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
            <button type="button" id="invoice-ocr-refresh-btn" class="btn-secondary">再読込</button>
            <button type="button" id="invoice-ocr-save-btn" class="btn-secondary" style="background-color:#083969; color:#fff;">更新</button>
            <div id="invoice-ocr-status" style="font-size: 0.9em; color: #666;"></div>
        </div>
        <div id="invoice-ocr-content" style="padding: 10px;">
            <div style="text-align:center; padding: 2em; color:#666;">読み込み中...</div>
        </div>
    `;

    document.getElementById('invoice-ocr-refresh-btn').addEventListener('click', loadAndRenderInvoiceOcrInvoices);
    document.getElementById('invoice-ocr-save-btn').addEventListener('click', saveInvoiceOcrCurrentDraft);
    loadAndRenderInvoiceOcrInvoices();
}

// 画面上の編集内容（保存前）
let invoiceOcrDraftByFileId = {}; // fileId -> draft
let invoiceOcrActiveFileId = null;

function _initInvoiceOcrDraftFromServer(inv) {
    const lineItems = Array.isArray(inv.line_items) ? inv.line_items : [];
    return {
        invoice: {
            order_number: inv.order_number || '',
        },
        line_items: lineItems.map((li) => ({
            order_number: li?.order_number || '',
            document_date: _normalizeDocumentDate(li?.document_date),
            status: _normalizeLineItemStatus(li?.status),
            item_name: li?.item_name || '',
            quantity: li?.quantity ?? '',
            unit: li?.unit ?? '',
            unit_price: li?.unit_price ?? '',
            amount: li?.amount ?? '',
            tax: li?.tax ?? '',
            note: li?.note || '',
        })),
        dirty: false,
    };
}

/**
 * スナップショット＋draft からカードを描画（API再取得なし）
 */
function renderInvoiceOcrUiFromSnapshot() {
    const statusEl = document.getElementById('invoice-ocr-status');
    const contentEl = document.getElementById('invoice-ocr-content');
    if (!contentEl) return;

    const invoices = Array.isArray(invoiceOcrListSnapshot) ? invoiceOcrListSnapshot : [];
    if (statusEl) statusEl.textContent = `表示 ${invoices.length}件`;

    if (invoices.length === 0) {
        contentEl.innerHTML = `<div style="text-align:center; padding: 2em; color:#666;">データがありません</div>`;
        return;
    }

    invoiceOcrActiveFileId = invoices[0]?.file_id ? String(invoices[0].file_id) : null;

    let html = '';
    invoices.forEach((inv) => {
        const rawFid = String(inv.file_id || '');
        const fileId = escapeHTML(rawFid);
        const fileName = escapeHTML(String(inv.file_name || ''));
        const vendorName = escapeHTML(String(inv.vendor_name || ''));
        const invoiceNumber = escapeHTML(String(inv.invoice_number || ''));
        const invoiceDate = escapeHTML(String(inv.invoice_date || ''));

        if (!invoiceOcrDraftByFileId[rawFid]) {
            invoiceOcrDraftByFileId[rawFid] = _initInvoiceOcrDraftFromServer(inv);
        }

        const draft = invoiceOcrDraftByFileId[rawFid];
        const derived = _deriveInvoiceStatusFromDraftLines(draft.line_items);
        const nLines = draft.line_items.length;
        const nChecked = draft.line_items.filter((li) => _normalizeLineItemStatus(li.status) === 'checked').length;
        const invChk = nLines > 0 && nChecked === nLines;

        html += `
                <div class="card" style="background:#fff; padding: 14px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.06); margin-bottom: 12px;">
                    <div style="display:flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px;">
                        <label style="display:flex; align-items:center; gap: 8px; font-weight: bold; cursor: pointer;">
                            <input type="checkbox" class="invoice-ocr-invoice-check" data-file-id="${fileId}" ${invChk ? 'checked' : ''} title="全明細を一括で確認済み/未確認にします" />
                            <span>請求書 確認済み</span>
                        </label>
                        <span style="font-size:0.85em; color:#666;">${_invoiceDerivedStatusLabel(derived)}</span>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <b>order_number</b>
                            <input type="text" class="invoice-ocr-invoice-order-number" data-file-id="${fileId}" value="${escapeHTML(String(draft.invoice.order_number || ''))}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 180px;">
                            <label style="display:flex; align-items:center; gap:4px; cursor:pointer; font-size:0.9em;">
                                <input type="checkbox" class="invoice-ocr-apply-order-number" data-file-id="${fileId}" />
                                <span>明細へ反映</span>
                            </label>
                        </div>
                        <a href="${INVOICE_OCR_BASE_URL}/view?file_id=${fileId}" target="_blank" rel="noopener" style="margin-left:auto;">/view を開く</a>
                    </div>
                    <div style="font-size: 0.9em; color:#333; line-height: 1.6;">
                        <div><b>file</b>: <span style="font-family: Consolas, monospace;">${fileId}</span> ${fileName ? `(${fileName})` : ''}</div>
                        <div><b>vendor</b>: ${vendorName || '-'}</div>
                        <div style="display:flex; gap: 10px; flex-wrap: wrap; align-items: center;">
                            <div><b>invoice</b>: ${invoiceNumber || '-'}</div>
                            <div><b>date</b>: ${invoiceDate || '-'}</div>
                        </div>
                    </div>

                    <div style="margin-top: 10px;">
                        <h4 style="margin: 0 0 6px 0; font-size: 1.0em;">明細 (${draft.line_items.length})</h4>
                        <div style="overflow-x:auto;">
                            <table class="data-table" style="min-width: 1020px;">
                                <thead>
                                    <tr>
                                        <th style="width: 56px;">確認</th>
                                        <th style="width: 180px;">order_number</th>
                                        <th style="width: 130px;">document_date</th>
                                        <th>item_name</th>
                                        <th style="width: 100px;">quantity</th>
                                        <th style="width: 90px;">unit</th>
                                        <th style="width: 110px;">unit_price</th>
                                        <th style="width: 110px;">amount</th>
                                        <th>note</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${draft.line_items
                                        .map((li, idx) => {
                                            const st = _normalizeLineItemStatus(li && li.status);
                                            const lineChecked = st === 'checked';
                                            const orderNo = escapeHTML(String(li?.order_number || ''));
                                            const documentDate = escapeHTML(_normalizeDocumentDate(li?.document_date));
                                            const itemName = escapeHTML(String(li?.item_name || ''));
                                            const qty = escapeHTML(String(li?.quantity ?? ''));
                                            const unit = escapeHTML(String(li?.unit ?? ''));
                                            const unitPrice = escapeHTML(String(li?.unit_price ?? ''));
                                            const amount = escapeHTML(String(li?.amount ?? ''));
                                            const note = escapeHTML(String(li?.note || ''));
                                            return `
                                            <tr>
                                                <td style="text-align:center;">
                                                    <input type="checkbox" class="invoice-ocr-line-check" data-file-id="${fileId}" data-index="${idx}" ${lineChecked ? 'checked' : ''} title="確認済み" />
                                                </td>
                                                <td><input type="text" class="invoice-ocr-line-order-number" data-file-id="${fileId}" data-index="${idx}" value="${orderNo}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 160px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-document-date" data-file-id="${fileId}" data-index="${idx}" value="${documentDate}" placeholder="YYYY/MM/DD" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 110px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-item-name" data-file-id="${fileId}" data-index="${idx}" value="${itemName}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 100%;"></td>
                                                <td><input type="text" class="invoice-ocr-line-quantity" data-file-id="${fileId}" data-index="${idx}" value="${qty}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 80px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-unit" data-file-id="${fileId}" data-index="${idx}" value="${unit}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 70px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-unit-price" data-file-id="${fileId}" data-index="${idx}" value="${unitPrice}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 90px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-amount" data-file-id="${fileId}" data-index="${idx}" value="${amount}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 90px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-note" data-file-id="${fileId}" data-index="${idx}" value="${note}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 100%;"></td>
                                            </tr>
                                        `;
                                        })
                                        .join('')}
                                </tbody>
                            </table>
                        </div>
                        <div style="margin-top: 6px; color:#666; font-size: 0.85em;">
                            各項目はいつでも編集できます。確認状態はチェックボックスのみ。保存は「更新」で請求書単位の一括保存です。
                        </div>
                    </div>
                </div>
            `;
    });

    contentEl.innerHTML = html;

    document.querySelectorAll('.invoice-ocr-invoice-check').forEach((cb) => {
        const fid = String(cb.dataset.fileId);
        const draft = invoiceOcrDraftByFileId[fid];
        if (draft && draft.line_items.length) {
            const n = draft.line_items.filter((li) => _normalizeLineItemStatus(li.status) === 'checked').length;
            cb.checked = n === draft.line_items.length;
            cb.indeterminate = n > 0 && n < draft.line_items.length;
        }
        cb.addEventListener('change', (e) => {
            const el = e.target;
            const fileId = String(el.dataset.fileId);
            const draft = invoiceOcrDraftByFileId[fileId];
            if (!draft || !draft.line_items.length) return;
            const on = !!el.checked;
            draft.line_items.forEach((li) => {
                li.status = on ? 'checked' : 'pending';
            });
            draft.dirty = true;
            renderInvoiceOcrUiFromSnapshot();
        });
    });

    document.querySelectorAll('.invoice-ocr-line-check').forEach((cb) => {
        cb.addEventListener('change', (e) => {
            const el = e.target;
            const fileId = String(el.dataset.fileId);
            const idx = parseInt(el.dataset.index, 10);
            const draft = invoiceOcrDraftByFileId[fileId];
            if (!draft || !draft.line_items[idx]) return;
            draft.line_items[idx].status = el.checked ? 'checked' : 'pending';
            draft.dirty = true;
            renderInvoiceOcrUiFromSnapshot();
        });
    });

    const applyInvoiceOrderNumberToLines = (fileId) => {
        const draft = invoiceOcrDraftByFileId[fileId];
        if (!draft) return false;
        const invoiceOrderNumber = String(draft.invoice.order_number || '');
        if (!invoiceOrderNumber) return false;
        draft.line_items.forEach((li) => {
            li.order_number = invoiceOrderNumber;
        });
        draft.dirty = true;
        return true;
    };

    document.querySelectorAll('.invoice-ocr-apply-order-number').forEach((cb) => {
        cb.addEventListener('change', (e) => {
            const el = e.target;
            const fileId = String(el.dataset.fileId);
            if (!el.checked) return;
            const changed = applyInvoiceOrderNumberToLines(fileId);
            if (!changed) {
                el.checked = false;
                return;
            }
            renderInvoiceOcrUiFromSnapshot();
        });
    });

    document.querySelectorAll('.invoice-ocr-invoice-order-number').forEach((inp) => {
        inp.addEventListener('input', (e) => {
            const el = e.target;
            const fileId = String(el.dataset.fileId);
            const draft = invoiceOcrDraftByFileId[fileId];
            if (!draft) return;
            draft.invoice.order_number = el.value;
            draft.dirty = true;
            const card = el.closest('.card');
            const applyCb = card ? card.querySelector('.invoice-ocr-apply-order-number') : null;
            if (applyCb && applyCb.checked) {
                const changed = applyInvoiceOrderNumberToLines(fileId);
                if (changed) {
                    renderInvoiceOcrUiFromSnapshot();
                }
            }
        });
    });

    const bindLineInput = (cls, key) => {
        document.querySelectorAll(cls).forEach((inp) => {
            inp.addEventListener('input', (e) => {
                const el = e.target;
                const fileId = String(el.dataset.fileId);
                const idx = parseInt(el.dataset.index, 10);
                const draft = invoiceOcrDraftByFileId[fileId];
                if (!draft || !draft.line_items[idx]) return;
                draft.line_items[idx][key] = el.value;
                draft.dirty = true;
            });
        });
    };
    bindLineInput('.invoice-ocr-line-order-number', 'order_number');
    bindLineInput('.invoice-ocr-line-document-date', 'document_date');
    bindLineInput('.invoice-ocr-line-item-name', 'item_name');
    bindLineInput('.invoice-ocr-line-quantity', 'quantity');
    bindLineInput('.invoice-ocr-line-unit', 'unit');
    bindLineInput('.invoice-ocr-line-unit-price', 'unit_price');
    bindLineInput('.invoice-ocr-line-amount', 'amount');
    bindLineInput('.invoice-ocr-line-note', 'note');
}

async function loadAndRenderInvoiceOcrInvoices() {
    const statusEl = document.getElementById('invoice-ocr-status');
    const contentEl = document.getElementById('invoice-ocr-content');
    if (!statusEl || !contentEl) return;

    statusEl.textContent = '読込中...';
    contentEl.innerHTML = `<div style="text-align:center; padding: 2em; color:#666;">読み込み中...</div>`;

    try {
        const res = await fetchInvoiceOcrWithAuth('/api/invoices?limit=5');
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const invoices = Array.isArray(data.invoices) ? data.invoices : [];
        invoiceOcrListSnapshot = invoices;

        invoices.forEach((inv) => {
            const fid = String(inv.file_id || '');
            if (fid) {
                invoiceOcrDraftByFileId[fid] = _initInvoiceOcrDraftFromServer(inv);
            }
        });

        renderInvoiceOcrUiFromSnapshot();
    } catch (e) {
        console.error(e);
        statusEl.textContent = '';
        const hint =
            e && e.message && String(e.message).includes('リダイレクト')
                ? 'LINEログインへ移動します。完了後にもう一度「再読込」を押してください。'
                : 'PC版は帳票API用に LINE のログイン状態が別途必要です。再読み込みやログインし直しを試してください。通信・CORSの問題の場合は Invoice OCR 側の設定も確認してください。';
        contentEl.innerHTML = `<div style="text-align:center; padding: 2em; color:#c0392b;">読み込みに失敗しました: ${escapeHTML(e.message)}</div>
            <div style="text-align:center; color:#666; font-size: 0.9em;">${escapeHTML(hint)}</div>`;
    }
}

async function saveInvoiceOcrCurrentDraft() {
    if (!invoiceOcrActiveFileId) {
        showToast('保存対象がありません', 'error');
        return;
    }
    const fileId = String(invoiceOcrActiveFileId);
    const draft = invoiceOcrDraftByFileId[fileId];
    if (!draft || !draft.dirty) {
        showToast('変更がありません', 'info');
        return;
    }
    const btn = document.getElementById('invoice-ocr-save-btn');
    const statusEl = document.getElementById('invoice-ocr-status');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = '保存中...';
    try {
        const res = await fetchInvoiceOcrWithAuth(`/api/invoices/${encodeURIComponent(fileId)}`, {
            method: 'POST',
            body: JSON.stringify({
                invoice: {
                    order_number: draft.invoice.order_number,
                },
                line_items: draft.line_items.map((li) => ({
                    order_number: li.order_number,
                    document_date: _normalizeDocumentDate(li.document_date),
                    status: _normalizeLineItemStatus(li.status),
                    item_name: li.item_name,
                    quantity: li.quantity,
                    unit: li.unit,
                    unit_price: li.unit_price,
                    amount: li.amount,
                    tax: li.tax,
                    note: li.note,
                })),
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `HTTP ${res.status}`);
        }
        draft.dirty = false;
        showToast('保存しました', 'success');
        await loadAndRenderInvoiceOcrInvoices();
    } catch (e) {
        console.error(e);
        showToast(`保存失敗: ${e.message}`, 'error');
        if (statusEl) statusEl.textContent = '';
    } finally {
        if (btn) btn.disabled = false;
    }
}

/** API 未取得時のフォールバック: 締め日を 20 日固定で直近締め日終端（ローカル暦） */
function getDashboardLastCompletedShimeClosingEnd() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();
    if (d > 20) {
        return new Date(y, m, 20, 23, 59, 59, 999);
    }
    return new Date(y, m - 1, 20, 23, 59, 59, 999);
}

/** `YYYY-MM-DD` をローカル暦のその日 23:59:59.999 に変換 */
function parsePeriodEndDateToLocalEndOfDay(ymd) {
    if (!ymd || typeof ymd !== 'string') return null;
    const parts = ymd.split('-').map((x) => parseInt(x, 10));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    const [y, mo, d] = parts;
    return new Date(y, mo - 1, d, 23, 59, 59, 999);
}

/** 本番 monthly_closings の前月度状態を取得して dashboardMonthlyClosingStatus を更新 */
async function refreshDashboardMonthlyClosingStatus() {
    try {
        const res = await fetchWithAuth(`${API_BASE_URL}/api/manager/monthly-closing/status`);
        const raw = await res.text();
        let data = null;
        try {
            data = raw ? JSON.parse(raw) : null;
        } catch {
            data = null;
        }
        if (res.ok && data && typeof data === 'object') {
            dashboardMonthlyClosingStatus = data;
        } else {
            dashboardMonthlyClosingStatus = null;
        }
    } catch (e) {
        console.warn('refreshDashboardMonthlyClosingStatus', e);
        dashboardMonthlyClosingStatus = null;
    }
}

/**
 * 前月度ダウンロードの実行前確認。
 * 管理ドキュメント（本番 monthly_closings）状態に応じて文言を切り替える。
 * @param {'enj'|'net'|'all'} scope
 * @returns {Promise<boolean>}
 */
async function confirmPreviousMonthDownloadMode(scope) {
    if (!dashboardMonthlyClosingStatus) {
        await refreshDashboardMonthlyClosingStatus();
    }
    const st = dashboardMonthlyClosingStatus;
    const enjDone = !!(st && st.enj && st.enj.exists && st.enj.status === 'completed');
    const netDone = !!(st && st.net && st.net.exists && st.net.status === 'completed');

    let snapshotReady = false;
    if (scope === 'enj') snapshotReady = enjDone;
    else if (scope === 'net') snapshotReady = netDone;
    else snapshotReady = enjDone && netDone; // all

    if (snapshotReady) {
        return confirm('締め後のデータにて集計を行います。よろしいですか？');
    }
    return confirm('締め処理前なので暫定値となります。集計してよろしいですか？');
}

function formatElapsedDaysHoursFromEndToNow(endDate) {
    const now = Date.now();
    const t = endDate.getTime();
    if (!Number.isFinite(t) || now <= t) return { days: 0, hours: 0 };
    let diff = now - t;
    const days = Math.floor(diff / 86400000);
    diff -= days * 86400000;
    const hours = Math.floor(diff / 3600000);
    return { days, hours };
}

function updateDashboardShimePanel() {
    const featureEnabledAt = new Date(2026, 3, 20, 0, 0, 0, 0); // 2026/04/20 00:00 (local)
    const isFeatureEnabled = Date.now() >= featureEnabledAt.getTime();
    const st = dashboardMonthlyClosingStatus;
    const enj = st && st.enj;
    const net = st && st.net;
    const kDone = !!(enj && enj.exists && enj.status === 'completed');
    const nDone = !!(net && net.exists && net.status === 'completed');
    const kRunning = !!(enj && enj.exists && enj.status === 'running');
    const nRunning = !!(net && net.exists && net.status === 'running');
    const kFailed = !!(enj && enj.exists && enj.status === 'failed');
    const nFailed = !!(net && net.exists && net.status === 'failed');
    const anyRunning = kRunning || nRunning;
    const statusFetchFailed = isFeatureEnabled && !st;

    const endAt =
        st && st.period_end_date
            ? parsePeriodEndDateToLocalEndOfDay(st.period_end_date)
            : getDashboardLastCompletedShimeClosingEnd();
    const { days, hours } = formatElapsedDaysHoursFromEndToNow(endAt || getDashboardLastCompletedShimeClosingEnd());
    const elapsedLine = `前月度が終わってから${days}日${hours}時間経過`;

    const lineFor = (done, running, failed) => {
        if (failed) return { text: '締め処理は失敗状態です（システム管理者へ連絡）', color: '#c62828' };
        if (running) return { text: '締め処理を実行中です', color: '#f57c00' };
        if (done) return { text: '締め処理は完了しています', color: '#2e7d32' };
        return { text: '締め処理が未完了です', color: '#c0392b' };
    };

    const kLine = statusFetchFailed
        ? { text: '本番の締め状態を取得できませんでした', color: '#7f8c8d' }
        : lineFor(kDone, kRunning, kFailed);
    const nLine = statusFetchFailed
        ? { text: '本番の締め状態を取得できませんでした', color: '#7f8c8d' }
        : lineFor(nDone, nRunning, nFailed);

    const kStatus = document.getElementById('dashboard-shime-koumu-status');
    const kElapsed = document.getElementById('dashboard-shime-koumu-elapsed');
    const nStatus = document.getElementById('dashboard-shime-net-status');
    const nElapsed = document.getElementById('dashboard-shime-net-elapsed');
    const kBtn = document.getElementById('dashboard-shime-koumu-btn');
    const nBtn = document.getElementById('dashboard-shime-net-btn');

    const kBtnDisabled = !isFeatureEnabled || kDone || anyRunning;
    const nBtnDisabled = !isFeatureEnabled || nDone || anyRunning;

    if (kBtn) {
        kBtn.disabled = kBtnDisabled;
        kBtn.style.opacity = kBtnDisabled && isFeatureEnabled ? '0.55' : isFeatureEnabled ? '1' : '0.55';
        kBtn.style.cursor = kBtnDisabled ? 'not-allowed' : 'pointer';
        kBtn.title = !isFeatureEnabled
            ? '2026/04/20 以降に有効'
            : kDone
              ? '本番ではこの前月度の締めは完了済みです'
              : anyRunning
                ? '他部署または自部署の締め実行中のため待機してください'
                : statusFetchFailed
                  ? '本番の締め状態は未取得ですが、実行時はサーバが判定します'
                  : '前月度の締め処理を実行（API）';
    }
    if (nBtn) {
        nBtn.disabled = nBtnDisabled;
        nBtn.style.opacity = nBtnDisabled && isFeatureEnabled ? '0.55' : isFeatureEnabled ? '1' : '0.55';
        nBtn.style.cursor = nBtnDisabled ? 'not-allowed' : 'pointer';
        nBtn.title = !isFeatureEnabled
            ? '2026/04/20 以降に有効'
            : nDone
              ? '本番ではこの前月度の締めは完了済みです'
              : anyRunning
                ? '他部署または自部署の締め実行中のため待機してください'
                : statusFetchFailed
                  ? '本番の締め状態は未取得ですが、実行時はサーバが判定します'
                  : '前月度の締め処理を実行（API）';
    }

    if (!isFeatureEnabled) {
        if (kStatus) {
            kStatus.textContent = '2026/04/20 以降に判定開始';
            kStatus.style.color = '#7f8c8d';
        }
        if (kElapsed) {
            kElapsed.textContent = '';
            kElapsed.style.display = 'none';
        }
        if (nStatus) {
            nStatus.textContent = '2026/04/20 以降に判定開始';
            nStatus.style.color = '#7f8c8d';
        }
        if (nElapsed) {
            nElapsed.textContent = '';
            nElapsed.style.display = 'none';
        }
        return;
    }

    if (kStatus) {
        kStatus.textContent = kLine.text;
        kStatus.style.color = kLine.color;
    }
    if (kElapsed) {
        const hideElapsed = kDone || kFailed || statusFetchFailed;
        kElapsed.textContent = hideElapsed ? '' : elapsedLine;
        kElapsed.style.display = hideElapsed ? 'none' : 'block';
    }
    if (nStatus) {
        nStatus.textContent = nLine.text;
        nStatus.style.color = nLine.color;
    }
    if (nElapsed) {
        const hideElapsed = nDone || nFailed || statusFetchFailed;
        nElapsed.textContent = hideElapsed ? '' : elapsedLine;
        nElapsed.style.display = hideElapsed ? 'none' : 'block';
    }
}

/**
 * 締め処理の2段目以降の確認用。ネイティブ confirm を連打するとブラウザが
 * 「さらにダイアログを表示しない」チェック付きになるため、DOM モーダルで代替する。
 * @param {string} message
 * @returns {Promise<boolean>} OK なら true
 */
function showMonthlyClosingStepConfirm(message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText =
            'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;';
        const box = document.createElement('div');
        box.style.cssText =
            'background:#fff;border-radius:8px;max-width:440px;padding:20px 24px;box-shadow:0 8px 32px rgba(0,0,0,0.2);font-size:15px;line-height:1.55;color:#333;';
        const p = document.createElement('p');
        p.style.margin = '0 0 20px 0';
        p.textContent = message;
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'キャンセル';
        cancelBtn.style.cssText =
            'padding:8px 16px;border:1px solid #ccc;background:#f8f8f8;border-radius:4px;cursor:pointer;font-size:14px;';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.textContent = 'OK';
        okBtn.style.cssText =
            'padding:8px 16px;border:none;background:#397939;color:#fff;border-radius:4px;cursor:pointer;font-size:14px;';
        const finish = (ok) => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve(ok);
        };
        cancelBtn.addEventListener('click', () => finish(false));
        okBtn.addEventListener('click', () => finish(true));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) finish(false);
        });
        btns.appendChild(cancelBtn);
        btns.appendChild(okBtn);
        box.appendChild(p);
        box.appendChild(btns);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        okBtn.focus();
    });
}

/**
 * ダッシュボード締めボタン: 確認の後に POST /api/manager/monthly-closing を呼ぶ。
 * @param {'enj'|'net'} division
 * @param {string} divisionLabel 表示用（工務 / ネット事業部）
 */
async function executeDashboardShimeClosing(division, divisionLabel) {
    if (!confirm('あなたは担当部署の締め処理を実施する管理者で間違いありませんか？')) {
        return;
    }
    if (!(await showMonthlyClosingStepConfirm('締め処理は原則、部署内全従業員が、日報入力を完了しているのが前提となります。実行しますか？'))) {
        return;
    }
    if (!(await showMonthlyClosingStepConfirm('この処理はやり直しが効きません。本当に実行してよろしいですか？'))) {
        return;
    }

    const kBtn = document.getElementById('dashboard-shime-koumu-btn');
    const nBtn = document.getElementById('dashboard-shime-net-btn');
    const busy = [kBtn, nBtn].filter(Boolean);
    busy.forEach((b) => {
        b.disabled = true;
        b.dataset._shimePrevText = b.textContent;
        b.textContent = '実行中...';
    });

    try {
        const res = await fetchWithAuth(`${API_BASE_URL}/api/manager/monthly-closing`, {
            method: 'POST',
            body: JSON.stringify({ division }),
        });
        const raw = await res.text();
        let data = {};
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch {
            data = { message: raw.slice(0, 300).trim() || res.statusText };
        }
        const errMsg = data.message || data.error || data.description || `HTTP ${res.status}`;

        if (res.ok) {
            const testHint = data.test_mode ? '［テストモード］' : '';
            const period = data.period_key ? ` (${data.period_key})` : '';
            showToast(
                `${divisionLabel} ${testHint}${data.message || '締め処理APIが応答しました。'}${period}`,
                data.status === 'completed' ? 'success' : 'info',
            );
        } else if (res.status === 409) {
            showToast(errMsg, 'warning');
        } else {
            showToast(errMsg, 'error');
        }
    } catch (e) {
        console.error('monthly-closing', e);
        showToast(`通信エラー: ${e.message}`, 'error');
    } finally {
        busy.forEach((b) => {
            b.textContent = b.dataset._shimePrevText || '締め処理実行';
            delete b.dataset._shimePrevText;
        });
        await refreshDashboardMonthlyClosingStatus();
        updateDashboardShimePanel();
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
    const DASHBOARD_BASE_WIDTH_PX = 1000;
    const SHIME_COLUMN_WIDTH_PX = Math.round(DASHBOARD_BASE_WIDTH_PX * 0.6);
    const DASHBOARD_TWO_COL_WIDTH_PX = DASHBOARD_BASE_WIDTH_PX + SHIME_COLUMN_WIDTH_PX + 20; // +gap

    container.innerHTML = `
        <div class="dashboard-container" style="padding: 20px; max-width: ${DASHBOARD_TWO_COL_WIDTH_PX}px;">
            <div class="dashboard-home-two-col" style="--dashboard-left-col-width: ${DASHBOARD_BASE_WIDTH_PX}px; --dashboard-right-col-width: ${SHIME_COLUMN_WIDTH_PX}px;">
                <div class="dashboard-home-col-left">

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
                <h3 style="margin-top: 0; border-bottom: 1px solid #eee; padding-bottom: 10px; font-size: 1.2em; color: #2c3e50;">集計表ダウンロード -エクセル/CSV形式-</h3>
                
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

                </div>
                <div class="dashboard-home-col-right">

            <!-- 締め処理（右列・処理は今後接続） -->
            <div class="card" style="background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 0;">
                <h3 style="margin-top: 0; border-bottom: 1px solid #eee; padding-bottom: 10px; font-size: 1.2em; color: #2c3e50;">締め処理</h3>
                <div style="display: flex; flex-direction: column; gap: 0;">
                    <div style="margin-top: 15px; margin-bottom: 20px;">
                        <h4 style="margin: 0 0 8px 0; font-size: 1em; color: ${navyColor};">工務</h4>
                        <div style="display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px;">
                            <button type="button" id="dashboard-shime-koumu-btn" class="btn-dashboard-action" title="前月度の締め処理を実行" style="flex-shrink: 0; background-color: ${greenColor}; border-color: ${greenBorderColor}; ${buttonSizeStyle}">締め処理実行</button>
                            <div style="flex: 1; min-width: 0; font-size: 0.9em; line-height: 1.55; color: #555;">
                                <div id="dashboard-shime-koumu-status" style="font-weight: 600;">締め処理が未完了です</div>
                                <div id="dashboard-shime-koumu-elapsed" style="margin-top: 4px; color: #666;"></div>
                            </div>
                        </div>
                    </div>
                    <div style="padding-top: 16px; border-top: 1px solid #f0f0f0;">
                        <h4 style="margin: 0 0 8px 0; font-size: 1em; color: ${navyColor};">ネット事業部</h4>
                        <div style="display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px;">
                            <button type="button" id="dashboard-shime-net-btn" class="btn-dashboard-action" title="前月度の締め処理を実行" style="flex-shrink: 0; background-color: ${wineRedColor}; border-color: ${wineRedBorderColor}; ${buttonSizeStyle}">締め処理実行</button>
                            <div style="flex: 1; min-width: 0; font-size: 0.9em; line-height: 1.55; color: #555;">
                                <div id="dashboard-shime-net-status" style="font-weight: 600;">締め処理が未完了です</div>
                                <div id="dashboard-shime-net-elapsed" style="margin-top: 4px; color: #666;"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

                </div>
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

    await refreshDashboardMonthlyClosingStatus();
    updateDashboardShimePanel();
    const shimeKBtn = document.getElementById('dashboard-shime-koumu-btn');
    const shimeNBtn = document.getElementById('dashboard-shime-net-btn');
    if (shimeKBtn) {
        shimeKBtn.addEventListener('click', () => {
            if (shimeKBtn.disabled) return;
            void executeDashboardShimeClosing('enj', '工務');
        });
    }
    if (shimeNBtn) {
        shimeNBtn.addEventListener('click', () => {
            if (shimeNBtn.disabled) return;
            void executeDashboardShimeClosing('net', 'ネット事業部');
        });
    }

    // Excelダウンロードボタン（API経由）
    const handleExcelDownload = async (targetMonth, btnId) => {
        if (targetMonth === 'previous') {
            const ok = await confirmPreviousMonthDownloadMode('enj');
            if (!ok) return;
        }
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
    const handleStaffSummaryDownload = async (targetMonth, btnId, previousScope = 'enj') => {
        if (targetMonth === 'previous') {
            const ok = await confirmPreviousMonthDownloadMode(previousScope);
            if (!ok) return;
        }
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

    // 宿泊/現場(全社) 手当集計Excelダウンロード（template_allowance → allowance_YYYYMM.xlsx）
    const handleAllowanceDownload = async (targetMonth, btnId) => {
        if (targetMonth === 'previous') {
            const ok = await confirmPreviousMonthDownloadMode('all');
            if (!ok) return;
        }
        const btn = document.getElementById(btnId);
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '生成中...';

        try {
            const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/allowance/excel`, {
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
            console.error('Allowance Excel download error:', error);
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

    // 宿泊/現場(全社) - 手当集計Excel（template_allowance → allowance_YYYYMM.xlsx）
    document.getElementById('shukuhaku-zenkoku-curr-btn').addEventListener('click', () => handleAllowanceDownload('current', 'shukuhaku-zenkoku-curr-btn'));
    document.getElementById('shukuhaku-zenkoku-prev-btn').addEventListener('click', () => handleAllowanceDownload('previous', 'shukuhaku-zenkoku-prev-btn'));

    // 業務別(ネット): ピボット用縦持ちCSV（/api/manager/net-task-summary/csv）
    const handleNetGyomuCsvDownload = async (targetMonth, btnId) => {
        if (targetMonth === 'previous') {
            const ok = await confirmPreviousMonthDownloadMode('net');
            if (!ok) return;
        }
        const btn = document.getElementById(btnId);
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '生成中...';

        try {
            const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/net-task-summary/csv`, {
                method: 'POST',
                body: JSON.stringify({ target_month: targetMonth }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || `ダウンロード失敗: ${response.status}`);
            }

            const result = await response.json();
            downloadCsvFromBase64(result.file_name, result.file_content);
        } catch (error) {
            console.error('Net task summary CSV download error:', error);
            alert(`エラーが発生しました: ${error.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    };
    document.getElementById('net-gyomu-curr-btn').addEventListener('click', () => handleNetGyomuCsvDownload('current', 'net-gyomu-curr-btn'));
    document.getElementById('net-gyomu-prev-btn').addEventListener('click', () => handleNetGyomuCsvDownload('previous', 'net-gyomu-prev-btn'));

    // スタッフ別(ネット) は未実装のためアラートのみ
    const showNetStaffNotImplemented = () => {
        alert('スタッフ別(ネット)の集計表ダウンロードは現在未実装です。');
    };
    document.getElementById('net-staff-curr-btn').addEventListener('click', showNetStaffNotImplemented);
    document.getElementById('net-staff-prev-btn').addEventListener('click', showNetStaffNotImplemented);

    // 残業/休出(全社) - 非表示だが念のためリスナーを追加
    document.getElementById('zankyu-zensha-curr-btn').addEventListener('click', () => handleStaffSummaryDownload('current', 'zankyu-zensha-curr-btn'));
    document.getElementById('zankyu-zensha-prev-btn').addEventListener('click', () => handleStaffSummaryDownload('previous', 'zankyu-zensha-prev-btn', 'all'));

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
                html += `<th class="col-worker"><a href="#dashboard?group_id=${emp.group_id}&date=${baseDateStr}" 
                            onclick="handleLinkNavigation(event, () => handleNavigation('dashboard', {group_id: '${emp.group_id}', date: '${baseDateStr}'}))" 
                            title="グループID: ${emp.group_id} の日報へ">${escapeHTML(emp.name)}</a></th>`;
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
            if (emp && emp.group_id) { // リンク付きセル
                html += `<td class="col-worker col-worker-data"><a href="#dashboard?group_id=${emp.group_id}&date=${rowDate}" onclick="handleLinkNavigation(event, () => handleNavigation('dashboard', {group_id: '${emp.group_id}', date: '${rowDate}'}))" style="text-decoration:none; color:inherit; display:block;">${displayValue}</a></td>`;
            } else { // リンクなしセル
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
                <td title="${escapeHTML(cat.label)}"><a href="#tasks_current?kouban=${escapeHTML(cat.label)}" 
                       onclick="handleLinkNavigation(event, () => handleNavigation('tasks_current', { kouban: '${escapeHTML(cat.label)}' }))" 
                       style="color: #2980b9; text-decoration: underline;">${escapeHTML(cat.label)}</a></td>
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
        // 工務部の業務種別設定画面では、kind='engineering' のカテゴリAのみを対象とする
        const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/a?kind=engineering`);
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
                <td><a href="#${calendarTarget}?employeeId=${row.employeeId}" 
                       onclick="handleLinkNavigation(event, () => handleNavigation('${calendarTarget}', { employeeId: '${row.employeeId}' }))" 
                       title="${escapeHTML(row.name)}さんの当月度の出勤簿へ">${escapeHTML(row.name)}</a></td>
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
    const netFiscalListBtnHtml = dashboardListMode === 'net'
        ? '<button type="button" id="staff-calendar-net-fiscal-list-btn" class="btn-net-wine-red" style="margin-right: 5px;" title="当月度（21日〜翌月20日）の過去日報を一覧表示">一覧</button>'
        : '';
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
                <button id="staff-cal-sync-holidays" class="btn-secondary" style="background-color: #006400; color: white; margin-right: 5px;">更新</button>
                ${netFiscalListBtnHtml}
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

    if (dashboardListMode === 'net') {
        ensureNetFiscalPastReportsModalInitialized();
        const netListBtn = document.getElementById('staff-calendar-net-fiscal-list-btn');
        if (netListBtn) {
            netListBtn.addEventListener('click', openNetFiscalPastReportsModal);
        }
    }

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

        // Firestore 側の最新反映を確実に取りに行くため、毎回ユニークなURLで取得する
        const cacheBuster = Date.now();
        const response = await fetchWithAuth(
            `${API_BASE_URL}/api/manager/calendar-statuses?employee_id=${employeeId}&start_date=${startDateStr}&end_date=${endDateStr}&_ts=${cacheBuster}`,
        );
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

    if (!confirm("Jobcanから勤怠データ（勤務時間・有休・宿泊備考）を取得し、反映しますか？\n※表示中の月度が対象です。")) return;

    const btn = document.getElementById('staff-cal-sync-holidays');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "受信中...";

    try {
        const isManager = !!(cachedAdminUserInfo && cachedAdminUserInfo.is_manager === true);
        // 個別入力画面と同等に、月度内の日ごとに勤務時間を強制再取得する（wait=3）
        const startDateOfNextMonth = closingDay + 1;
        const year = currentCalendarReportMonth.getUTCFullYear();
        const month = currentCalendarReportMonth.getUTCMonth();
        const startDate = new Date(Date.UTC(year, month - 1, startDateOfNextMonth));
        const endDate = new Date(Date.UTC(year, month, closingDay));
        const totalDays = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
        let done = 0;
        for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
            const ymd = toUTCDateString(d);
            // 一般ユーザーは本人向けに取得（employee_id を付けない）
            const workTimeUrl = isManager
                ? `${API_BASE_URL}/api/work-time?date=${ymd}&employee_id=${currentCalendarEmployeeId}&source=admin&wait=3`
                : `${API_BASE_URL}/api/work-time?date=${ymd}&source=report&wait=3`;
            await fetchWithAuth(workTimeUrl);
            done += 1;
            btn.innerText = `受信中... (${done}/${totalDays})`;
        }

        btn.innerText = "反映中...";
        // 休暇・宿泊備考などは既存同期APIで反映
        const dateStr = toUTCDateString(currentCalendarReportMonth);
        const syncBody = {
            date: dateStr,
        };
        // 一般ユーザーは target_employee_id を送らず、本人同期として実行する
        if (isManager) {
            syncBody.target_employee_id = currentCalendarEmployeeId; // 管理者機能として対象IDを指定
        }
        const response = await fetchWithAuth(`${API_BASE_URL}/api/sync-paid-holidays`, {
            method: 'POST',
            body: JSON.stringify(syncBody)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            throw new Error(errorData?.message || `反映に失敗しました: ${response.status}`);
        }
        await response.json().catch(() => ({}));

        // 更新後は勤務時間（Jobcan）だけでなく、日報入力（Firestore）側も再読込して突合を更新する
        await initializeStaffCalendar();
        // 同期API直後の反映タイミング差に備え、短い待機後にもう一度再読込
        await new Promise((resolve) => setTimeout(resolve, 500));
        await initializeStaffCalendar();

        alert('同期が完了しました。');

    } catch (e) {
        console.error(e);
        alert(`エラー: ${e.message}`);
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
    }
}

/**
 * ネット個別カレンダー用: 「ラベル:分数（単位なし）＋全角スペース2＋X時間Y分」
 * @param {string} label - 例: 勤務時間 / 日報入力
 * @param {number|string} totalMinutes
 */
function formatStaffCalendarNetTimeLine(label, totalMinutes) {
    const m = Math.max(0, parseInt(totalMinutes, 10) || 0);
    const h = Math.floor(m / 60);
    const minRem = m % 60;
    const gap = '\u3000\u3000';
    return `${label}:${m}${gap}${h}時間${minRem}分`;
}

/**
 * ネット個別カレンダー: 勤務／日報行の色分け用スタイル（初回のみ head に追加）
 */
function ensureStaffCalendarNetTimeRowStyles() {
    const sid = 'staff-calendar-net-time-rows-v3';
    if (document.getElementById(sid)) return;
    const style = document.createElement('style');
    style.id = sid;
    style.textContent = `
        .custom-calendar-table .staff-cal-time--net-work {
            color: #4b5563;
            margin-bottom: 3px;
            font-weight: 500;
        }
        .custom-calendar-table .staff-cal-time--net-report {
            color: #14532d;
            font-weight: 500;
        }
    `;
    document.head.appendChild(style);
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
                if (dashboardListMode === 'net') {
                    if (jobcanMinutes > 0) {
                        workTimeHtml = `<div class="time-display work-time staff-cal-time--net-work">${formatStaffCalendarNetTimeLine('勤務時間', jobcanMinutes)}</div>`;
                    }
                    if (reportedMinutes > 0) {
                        reportedTimeHtml = `<div class="time-display reported-time staff-cal-time--net-report">${formatStaffCalendarNetTimeLine('日報入力', reportedMinutes)}</div>`;
                    }
                } else {
                    if (jobcanMinutes > 0) workTimeHtml = `<div class="time-display work-time">勤務時間:${jobcanMinutes}</div>`;
                    if (reportedMinutes > 0) reportedTimeHtml = `<div class="time-display reported-time">日報入力:${reportedMinutes}</div>`;
                }
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
    if (dashboardListMode === 'net') {
        ensureStaffCalendarNetTimeRowStyles();
    }

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
            /* 今日: 祝日っぽく見えないよう、黒文字＋薄いグリーンの円に変更 */
            .custom-calendar-table .is-today .day-number {
                font-weight: bold;
                color: #000000;
                background-color: #d4f4dd; /* 薄いグリーン */
                border-radius: 50%;
                width: 1.5em;
                height: 1.5em;
                display: inline-block;
                text-align: center;
                line-height: 1.5em;
            }
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
let isProxySubmitting = false; // 代理報告の二重送信防止フラグ
// 1スロット保留キュー（latest-wins）
let proxyPendingSaveRequest = null; // { type: 'auto'|'submit', payload, submitBtn, triggerName }

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
    // ネット事業部は Firestore 逐次保存が正とする。localStorage 下書きは二重保持・古い復元の原因になるため書かない。
    if (currentProxyTarget && String(currentProxyTarget.groupId) === '3') {
        const dk = getProxyDraftKey();
        if (dk) localStorage.removeItem(dk);
        return;
    }

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
    const isNetTemplate = currentProxyTarget && String(currentProxyTarget.groupId) === '3';

    if (isNetTemplate) {
        // ネット事業部用: .timetable-task から収集
        document.querySelectorAll('.timetable-task').forEach(taskEl => {
            const ds = taskEl.dataset;
            tasks.push({
                // renderExistingTimetableTask が期待するスネークケースのキーで保存
                startTime: ds.startTime,
                endTime: ds.endTime,
                categoryA_id: ds.categoryAId,
                categoryA_label: ds.categoryALabel,
                categoryB_id: ds.categoryBId,
                categoryB_label: ds.categoryBLabel,
                comment: ds.comment
            });
        });
    } else {
        // 工務部用: 既存のロジック
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
    }

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
    if (currentProxyTarget && String(currentProxyTarget.groupId) === '3') {
        return;
    }

    const draftKey = getProxyDraftKey();
    if (!draftKey) return;

    const draftString = localStorage.getItem(draftKey);
    if (!draftString) return;

    try {
        const draft = JSON.parse(draftString);
        document.getElementById('proxy-report-work').value = draft.workTime;

        const isNetTemplate = currentProxyTarget && String(currentProxyTarget.groupId) === '3';

        if (isNetTemplate) {
            // ネット事業部用: renderExistingTimetableTask を使って復元
            if (draft.tasks && draft.tasks.length > 0) {
                // 復元前に、APIから読み込まれた既存のタスクを一度すべて削除する
                // これにより、リロード時にタスクが二重に描画されるのを防ぐ
                document.querySelectorAll('.timetable-task').forEach(el => el.remove());
                // 下書きのタスクを描画
                draft.tasks.forEach(task => renderExistingTimetableTask(task));
            }
        } else {
            // 工務部用: 既存のロジック
            // 復元前に既存のタスク行をクリア
            document.getElementById('proxy-task-entries-container').innerHTML = '';
            proxyTaskCounter = 0;

            if (draft.tasks && draft.tasks.length > 0) {
                draft.tasks.forEach(task => addProxyTaskEntry(task));
            } else {
                addProxyTaskEntry(); // 空の行を追加
            }
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

        // PC版はセッション(Cookie)優先にするため、未ログインでも即リダイレクトしない。
        // APIが401を返したときだけ ensurePcSession() が必要に応じてログインへ誘導する。

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
        const hash = window.location.hash.substring(1);
        const [initialTarget, queryString] = hash.split('?');
        const params = new URLSearchParams(queryString);
        const paramsObj = Object.fromEntries(params.entries());
        handleNavigation(initialTarget || 'home', paramsObj, { push: true }); // 初期表示時も履歴にstateを登録

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

document.addEventListener('DOMContentLoaded', main);

// --- 代理入力機能 ---

let proxyTaskCounter = 0;
let proxyCategoryAOptions = [];
let proxyCategoryBOptions = [];
/** setupProxyCategoryDatalists / 過去日報用 ensure で最後に読み込んだ categories/b の kind */
let _proxyCategoryBOptionsKindLoaded = null;
let proxyActiveSliderInput = null;
let currentProxyTarget = null; // { employeeId, name, date, groupId, returnTarget, returnProxyTarget? }
let currentProxyHistory = { catA: [], catB: [] }; // 代理入力対象者の履歴
let proxySelectionResolver = null; // 選択パネルのPromise解決用
/** ネット代理入力: load / 自動保存成功後のフォーム状態（変更検知用 JSON 文字列） */
let proxyNetSavedSnapshot = null;

/**
 * 代理入力画面を開く
 * @param {{ returnTarget?: string, skipProxyStack?: boolean }} [openOptions] - 戻り先固定や、戻りスタック無効化など
 */
async function openProxyReport(employeeId, name, date, groupId, openOptions) {
    const previousProxyTarget = currentProxyTarget;
    const isOpeningFromProxyScreen = !!document.getElementById('proxy-report-container');

    const activeTarget = document.querySelector('.nav-item.active')?.dataset?.target;
    let returnTarget;
    if (openOptions && openOptions.returnTarget != null && String(openOptions.returnTarget).trim() !== '') {
        returnTarget = String(openOptions.returnTarget).trim();
    } else {
        returnTarget = activeTarget || 'dashboard';
    }
    // ネット事業部のスタッフを開いた場合、一覧に戻る先はネット用を優先（明示 returnTarget 時は上書きしない）
    if (
        !(openOptions && openOptions.returnTarget != null && String(openOptions.returnTarget).trim() !== '')
        && groupId && String(groupId) === '3'
        && returnTarget === 'dashboard'
    ) {
        returnTarget = 'dashboard_net';
    }

    const nextProxyTarget = { employeeId, name, date, groupId, returnTarget };
    if (
        !(openOptions && openOptions.skipProxyStack)
        && isOpeningFromProxyScreen
        && previousProxyTarget
        && previousProxyTarget.employeeId
        && previousProxyTarget.date
    ) {
        nextProxyTarget.returnProxyTarget = { ...previousProxyTarget };
    }
    currentProxyTarget = nextProxyTarget;
    const contentArea = document.getElementById('content-area');
    
    // 代理入力用のHTMLを読み込む
    try {
        const templateFile = (groupId && String(groupId) === '3')
            ? '_manager_proxy_report_net.html'
            : '_manager_proxy_report.html';
        const isNetTemplate = (groupId && String(groupId) === '3');
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
        await initializeProxyReportScreen(isNetTemplate);
    } catch (error) {
        console.error('代理入力画面の読み込みエラー:', error);
        alert('画面の読み込みに失敗しました。');
    }
}

/**
 * 代理入力画面の初期化
 */
async function initializeProxyReportScreen(isNetTemplate) {
    const { employeeId, name, date } = currentProxyTarget;
    
    // 対象者情報の表示（ネット事業部は「対象者 → 対象日」の順）
    const targetInfoRows = isNetTemplate
        ? `
            <div><strong>対象者:</strong> ${escapeHTML(name)} (ID: ${employeeId})</div>
            <div><strong>対象日:</strong> ${date}</div>
        `
        : `
            <div><strong>対象日:</strong> ${date}</div>
            <div><strong>対象者:</strong> ${escapeHTML(name)} (ID: ${employeeId})</div>
        `;
    const targetInfoEl = document.getElementById('proxy-target-info');
    if (isNetTemplate) {
        targetInfoEl.innerHTML = `
            <div class="proxy-target-info-bar">
                <div class="proxy-target-info-primary">
                    <div class="proxy-target-info-rows">
                        ${targetInfoRows}
                    </div>
                </div>
                <div class="proxy-target-info-secondary" id="proxy-target-info-secondary" aria-label="前日・翌日">
                    <div class="proxy-target-day-nav" role="group" aria-label="対象日の移動">
                        <button type="button" id="proxy-target-prev-day-btn" class="btn-secondary proxy-target-day-nav-btn">◀前日</button>
                        <button type="button" id="proxy-target-next-day-btn" class="btn-secondary proxy-target-day-nav-btn">翌日▶</button>
                    </div>
                    <p class="proxy-target-day-nav-note">※表示されている日報は、変更がある場合のみ保存してから移動します</p>
                </div>
            </div>
        `;
    } else {
        targetInfoEl.innerHTML = `
            <div style="display:flex; gap: 28px; align-items: baseline; flex-wrap: wrap;">
                ${targetInfoRows}
            </div>
        `;
    }
    document.getElementById('proxy-report-date').value = date;

    // 共通バッジスタイルを適用
    setupSharedBadgeStyles();

    // 戻るボタン用の共通遷移ロジック
    const navigateBack = () => {
        // ★タイマー停止と下書き破棄
        if (proxyAutoSaveTimer) clearInterval(proxyAutoSaveTimer);
        const draftKey = getProxyDraftKey();
        if (draftKey) localStorage.removeItem(draftKey);

        // 直前に表示していた代理入力画面に戻す（例: 月度モーダル → 代理入力(別日) → 送信 → 一覧に戻る）
        const prev = currentProxyTarget && currentProxyTarget.returnProxyTarget ? currentProxyTarget.returnProxyTarget : null;
        if (prev && prev.employeeId && prev.date) {
            void openProxyReport(
                String(prev.employeeId),
                prev.name || '',
                prev.date,
                prev.groupId != null ? String(prev.groupId) : '',
                { returnTarget: prev.returnTarget || undefined, skipProxyStack: true },
            );
            return;
        }

        const target = currentProxyTarget?.returnTarget || 'dashboard';
        const params = {};
        // 遷移先が個別カレンダー画面の場合、対象者のemployeeIdをパラメータとして渡す
        if ((target === 'staff_calendar' || target === 'staff_calendar_net') && currentProxyTarget?.employeeId) {
            params.employeeId = currentProxyTarget.employeeId;
        }
        handleNavigation(target, params);
    };

    // イベントリスナー設定
    document.getElementById('close-proxy-report-btn').addEventListener('click', navigateBack);
    // 完了画面の「一覧に戻る」は、（遷移ではなく）同じ対象者・同じ日付の入力フォームへ戻す
    const backToListBtn = document.getElementById('proxy-back-to-list-btn');
    if (backToListBtn) {
        backToListBtn.addEventListener('click', async () => {
            const formWrap = document.getElementById('proxy-report-form-wrapper');
            const completion = document.getElementById('proxy-completion-screen');
            if (completion) completion.style.display = 'none';
            if (formWrap) formWrap.style.display = '';
            // 送信ボタンの表示を元に戻す（送信中... が残り続けないようにする）
            const submitBtn = document.getElementById('proxy-submit-button');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = '送信';
            }
            // 送信後に再編集するケースに備え、最新データで再描画して差分をなくす
            try {
                await loadProxyExistingData();
            } catch (e) {
                console.error(e);
            }
        });
    }

    // ボタンのテキストと機能を変更（ラベルは「更新」に変更）
    const syncBtn = document.getElementById('proxy-get-work-time-button');
    syncBtn.textContent = '更新';
    syncBtn.removeEventListener('click', handleProxyGetWorkTime); // 古いリスナーを削除
    syncBtn.addEventListener('click', handleProxySyncData); // 新しいリスナーを設定

    // ボタンの位置を変更（ネット用テンプレートでは専用アンカーを優先）
    const syncAnchor = document.getElementById('proxy-sync-anchor');
    if (syncAnchor) {
        syncAnchor.appendChild(syncBtn);
    } else {
        const dateInput = document.getElementById('proxy-report-date');
        if (dateInput && dateInput.parentElement) {
            dateInput.parentElement.appendChild(syncBtn); // 日付入力と同じ行の末尾に移動
            dateInput.parentElement.style.gap = '10px';
        }
    }

    // ★カテゴリデータの準備を先に実行する
    await setupProxyCategoryDatalists();

    if (isNetTemplate) {
        // ネット事業部用のタイムテーブルUIの初期化
        await initializeProxyTimetable();
    } else {
        // 工務用のUI初期化
        document.getElementById('proxy-add-task-button').addEventListener('click', () => addProxyTaskEntry());
        setupProxySliderEvents();
    }

    document.getElementById('proxy-report-work').addEventListener('input', updateProxyWorkTimeSummary);
    document.getElementById('proxy-report-form').addEventListener('submit', handleProxyReportSubmit);

    // 注意事項モーダルのイベントリスナー
    const notesModal = document.getElementById('proxy-work-time-notes-modal');
    const notesTrigger = document.getElementById('proxy-work-time-notes-trigger');
    const notesCloseBtn = document.getElementById('proxy-work-time-notes-close');

    if (notesModal && notesTrigger && notesCloseBtn) {
        notesTrigger.onclick = () => { notesModal.classList.add('is-active'); };
        notesCloseBtn.onclick = () => { notesModal.classList.remove('is-active'); };
        // window.onclick は他のモーダルと競合するため、モーダル自身へのクリックイベントに変更
        notesModal.addEventListener('click', (event) => {
            if (event.target.classList.contains('dr-modal')) {
                notesModal.classList.remove('is-active');
            }
        });
    }

    // 既存データの読み込み
    await loadProxyExistingData();

    if (isNetTemplate) {
        const prevDayBtn = document.getElementById('proxy-target-prev-day-btn');
        const nextDayBtn = document.getElementById('proxy-target-next-day-btn');
        if (prevDayBtn) {
            prevDayBtn.addEventListener('click', () => {
                void navigateProxyNetAdjacentDay(-1);
            });
        }
        if (nextDayBtn) {
            nextDayBtn.addEventListener('click', () => {
                void navigateProxyNetAdjacentDay(1);
            });
        }
        // ネット: Firestore が正。残っている下書きキーは削除のみ（復元・定期local保存はしない）
        const dk = getProxyDraftKey();
        if (dk) localStorage.removeItem(dk);
        if (proxyAutoSaveTimer) clearInterval(proxyAutoSaveTimer);
        proxyAutoSaveTimer = null;
    } else {
        // 工務: localStorage 下書きの確認復元 + 10秒ごとの下書き保存
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
                    localStorage.removeItem(draftKey);
                } catch (e) {
                    localStorage.removeItem(draftKey);
                }
            }
        }
        if (proxyAutoSaveTimer) clearInterval(proxyAutoSaveTimer);
        proxyAutoSaveTimer = setInterval(saveProxyDraftReport, 10000);
    }
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
    // 対象者のグループに基づいてkindを決定
    let kind = 'engineering';
    if (currentProxyTarget.groupId && String(currentProxyTarget.groupId) === '3') {
        kind = 'net';
    }

    try {
        // 大分類
        // ★修正: kindパラメータを付与
        const responseA = await fetchWithAuth(`${API_BASE_URL}/api/categories/category_a?kind=${kind}`);
        if (responseA.ok) {
            const categories = await responseA.json();
            proxyCategoryAOptions = categories.map(cat => ({ id: cat.id, label: cat.label }));
            // 履歴でソート
            proxyCategoryAOptions = sortProxyOptionsByHistory(proxyCategoryAOptions, currentProxyHistory.catA);
        }

        // 小分類 (対象者のグループに基づいて取得)
        // NOTE:
        // PC入力画面は管理者・一般ユーザーの両方で利用されるため、
        // manager API が 401/403 の場合は user API に自動フォールバックする。
        // これにより、権限差で「集計項目」が空になる事象を防ぐ。
        let responseB = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b?kind=${kind}`);
        if (!responseB.ok && (responseB.status === 401 || responseB.status === 403)) {
            responseB = await fetchWithAuth(`${API_BASE_URL}/api/categories/b?kind=${kind}`);
        }
        if (!responseB.ok) {
            throw new Error(`集計項目の取得に失敗しました: ${responseB.status}`);
        }

        const categories = await responseB.json();
        // active が明示的に false のものだけ除外（一般APIは active を返さない場合あり）
        const activeCategories = categories.filter((cat) => cat.active !== false);

        proxyCategoryBOptions = activeCategories.map((cat) => ({
            id: cat.id,
            label: cat.label,
            order: typeof cat.order === 'number' ? cat.order : 0,
            client: cat.client || '',
            project: cat.project || '',
            offices: cat.offices || [],
            category_a_settings: cat.category_a_settings || {},
            // 一般APIは category_a_sort を返さないため空マップで吸収
            category_a_sort: cat.category_a_sort || {},
        }));
        // 集計項目は order 昇順で表示（PC日報入力・ネット事業部）
        proxyCategoryBOptions.sort((a, b) => (a.order - b.order) || a.label.localeCompare(b.label || '', 'ja'));
        _proxyCategoryBOptionsKindLoaded = kind;
    } catch (error) {
        console.error("カテゴリ候補の取得に失敗しました:", error);
    }
}

/**
 * 代理入力画面を開いていない場合でも、過去日報の色付けに必要な集計項目（category B）マスタを読み込む
 * @param {'net'|'engineering'} kind
 */
async function ensureProxyCategoryBOptionsForPastReports(kind) {
    if (_proxyCategoryBOptionsKindLoaded === kind && proxyCategoryBOptions.length > 0) {
        return;
    }
    try {
        let responseB = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b?kind=${kind}`);
        if (!responseB.ok && (responseB.status === 401 || responseB.status === 403)) {
            responseB = await fetchWithAuth(`${API_BASE_URL}/api/categories/b?kind=${kind}`);
        }
        if (!responseB.ok) return;
        const categories = await responseB.json();
        const activeCategories = categories.filter((cat) => cat.active !== false);
        proxyCategoryBOptions = activeCategories.map((cat) => ({
            id: cat.id,
            label: cat.label,
            order: typeof cat.order === 'number' ? cat.order : 0,
            client: cat.client || '',
            project: cat.project || '',
            offices: cat.offices || [],
            category_a_settings: cat.category_a_settings || {},
            category_a_sort: cat.category_a_sort || {},
        }));
        proxyCategoryBOptions.sort(
            (a, b) => (a.order - b.order) || (a.label || '').localeCompare(b.label || '', 'ja'),
        );
        _proxyCategoryBOptionsKindLoaded = kind;
    } catch (e) {
        console.error('過去日報表示用カテゴリの取得に失敗:', e);
    }
}

/**
 * 既存の勤務時間と日報データを読み込む
 */
async function loadProxyExistingData() {
    const { employeeId, date, groupId } = currentProxyTarget;
    const messageDiv = document.getElementById('proxy-report-message');
    const isNetLoad = groupId != null && String(groupId) === '3';
    let prevDayNavBtn = null;
    let nextDayNavBtn = null;
    if (isNetLoad) {
        prevDayNavBtn = document.getElementById('proxy-target-prev-day-btn');
        nextDayNavBtn = document.getElementById('proxy-target-next-day-btn');
        if (prevDayNavBtn) prevDayNavBtn.disabled = true;
        if (nextDayNavBtn) nextDayNavBtn.disabled = true;
        proxyNetSavedSnapshot = null;
    }

    messageDiv.textContent = 'データを読み込み中...';

    try {
        let reportData = {};
        const [workTimeRes, reportDetailsRes] = await Promise.all([
            fetchWithAuth(`${API_BASE_URL}/api/work-time?date=${date}&employee_id=${employeeId}&source=admin`),
            fetchWithAuth(`${API_BASE_URL}/api/report-details?date=${date}&employee_id=${employeeId}`)
        ]);

        let existingTasks = [];
        const isNetTemplate = (groupId && String(groupId) === '3');
        
        if (workTimeRes.ok) {
            const data = await workTimeRes.json();
            document.getElementById('proxy-report-work').value = data.workTime || 0;
        }

        if (reportDetailsRes.ok) {
            reportData = await reportDetailsRes.json();
            if (reportData.jobcan_work_minutes !== undefined) {
                document.getElementById('proxy-report-work').value = reportData.jobcan_work_minutes;
            }
            existingTasks = reportData.tasks || [];
        }

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
        badgeContainer.innerHTML = '';

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

        if (isNetTemplate) {
            // ネット事業部: タイムテーブルに既存タスクを描画
            // APIがstartTime/endTimeを返すようになったら、この部分が機能する
            // 再読込時の重複描画を防ぐため、既存タスク表示を先にクリアする
            document.querySelectorAll('.timetable-task').forEach((el) => el.remove());
            detachedTaskElements = [];
            timetableStartHour = TIMETABLE_DEFAULT_START;
            timetableEndHour = TIMETABLE_DEFAULT_END;
            if (existingTasks.length > 0) {
                expandProxyTimetableRangeForTasks(existingTasks);
            }
            renderProxyTimetable();
            if (existingTasks.length > 0) {
                existingTasks.forEach(task => {
                    if (task.startTime && task.endTime) {
                        renderExistingTimetableTask(task);
                    }
                });
            }
        } else {
            // 工務部: 従来のリスト形式でタスクを初期化
            const container = document.getElementById('proxy-task-entries-container');
            container.innerHTML = '';
            proxyTaskCounter = 0;

            if (existingTasks.length > 0) {
                existingTasks.forEach(task => addProxyTaskEntry(task));
            } else {
                addProxyTaskEntry();
            }
        }
        
        updateProxyWorkTimeSummary();
        messageDiv.textContent = '';

        // ★ 既存データに休憩タスクが含まれていない場合のみ、デフォルト（12:00-13:00）を生成
        const hasBreakTask = isNetTemplate && existingTasks.some(t => t.categoryA_id === 'N99');
        if (!hasBreakTask) {
            createDefaultBreakTask();
        }

        if (isNetTemplate) {
            updateProxyWorkTimeSummary();
            refreshProxyNetSavedSnapshot();
        }

    } catch (error) {
        console.error("データ読み込みエラー:", error);
        messageDiv.textContent = 'データの読み込みに失敗しました。';
        
        const isNetTemplate = (currentProxyTarget.groupId && String(currentProxyTarget.groupId) === '3');
        if (!isNetTemplate) {
            const container = document.getElementById('proxy-task-entries-container');
            if (container) {
                addProxyTaskEntry();
            }
        }
        if (currentProxyTarget && String(currentProxyTarget.groupId) === '3') {
            refreshProxyNetSavedSnapshot();
        }
    } finally {
        if (prevDayNavBtn) prevDayNavBtn.disabled = false;
        if (nextDayNavBtn) nextDayNavBtn.disabled = false;
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
 * 休憩タスクを指定された開始・終了時刻でタイムテーブルに描画する（共通処理）
 * @param {string} startTime - 例: '12:00'
 * @param {string} endTime - 例: '13:00'
 */
function renderBreakTask(startTime, endTime) {
    const st = normalizeProxyNetTimeStr(startTime);
    const et = normalizeProxyNetTimeStr(endTime);
    const start = new Date(`1970-01-01T${st}:00`);
    const end = new Date(`1970-01-01T${et}:00`);
    if (end <= start) end.setDate(end.getDate() + 1);
    const duration = (end - start) / 1000 / 60;

    const startRow = document.querySelector(`#timetable-rows tr[data-time="${st}"]`);
    if (!startRow) {
        console.warn('Could not find start row for break task:', st);
        return;
    }
    const startSlotCell = startRow.querySelector('.timetable-slot');

    const taskElement = document.createElement('div');
    taskElement.className = 'timetable-task';
    taskElement.dataset.taskType = 'break';

    const bgColor = '#e9ecef';
    const textColor = '#6c757d';
    const borderColor = 'transparent';
    const taskHeight = (duration / 15) * 24;

    taskElement.style.cssText = `position: absolute; top: 0; left: 0; right: 0; height: ${taskHeight}px; background-color: ${bgColor}; color: ${textColor}; border-left: 3px solid ${borderColor}; padding: 4px 6px; font-size: 0.8em; line-height: 1.3; overflow: hidden; z-index: 10; box-sizing: border-box; cursor: grab; display: flex; align-items: center; justify-content: center;`;

    taskElement.innerHTML = `<div>昼休憩</div>`;

    taskElement.dataset.startTime = st;
    taskElement.dataset.endTime = et;
    taskElement.dataset.time = '0';
    taskElement.dataset.comment = '昼休憩';
    taskElement.dataset.categoryAId = 'N99';
    taskElement.dataset.categoryALabel = '昼休憩';
    taskElement.dataset.categoryBId = 'n_break';
    taskElement.dataset.categoryBLabel = '休憩';

    taskElement.addEventListener('click', () => handleTaskClick(taskElement));

    startSlotCell.appendChild(taskElement);
}

/**
 * デフォルトの休憩タスク（12:00-13:00）をタイムテーブルに描画する
 * 既に休憩がいる、または保存データから復元する場合は呼ばれない想定
 */
function createDefaultBreakTask() {
    const startTime = '12:00';
    const endTime = '13:00';

    // 既に休憩タスクが存在する場合は何もしない
    if (document.querySelector('.timetable-task[data-task-type="break"]')) {
        return;
    }

    // 12:00-13:00の範囲に他のタスクが既に存在する場合は描画しない
    if (checkTaskCollision(startTime, endTime)) {
        console.log('Default break time (12:00-13:00) collides with an existing task. Skipping creation.');
        return;
    }

    renderBreakTask(startTime, endTime);
}

/**
 * 代理入力のサマリー更新
 */
function updateProxyWorkTimeSummary() {
    const totalWork = parseInt(document.getElementById('proxy-report-work').value, 10) || 0;
    let allocated = 0;
    
    const isNetTemplate = currentProxyTarget && (String(currentProxyTarget.groupId) === '3');

    if (isNetTemplate) {
        // Net: 既存由来(lockedTime=1)は保存済みtimeを優先、
        // 入力中(lockedTime!=1)は開始/終了差分で算出する。
        document.querySelectorAll('.timetable-task').forEach(taskEl => {
            // ★休憩タスクは合計に含めない
            if (taskEl.dataset.taskType === 'break') return;
            allocated += getProxyNetTaskMinutes(taskEl);
        });
    } else {
        // Koumu: Sum durations from input fields
        const container = document.getElementById('proxy-task-entries-container');
        if (container) {
            container.querySelectorAll('.task-time').forEach(el => {
                allocated += parseInt(el.value, 10) || 0;
            });
        }
    }

    document.getElementById('proxy-total-work-time-display').textContent = totalWork;
    document.getElementById('proxy-allocated-time-display').textContent = allocated;
    const remainingEl = document.getElementById('proxy-remaining-time-display');
    const remaining = totalWork - allocated;
    remainingEl.textContent = remaining;
    remainingEl.style.color = (remaining === 0 && allocated > 0) ? '#2ecc71' : '#d9534f';

    // 送信ボタン制御
    const submitBtn = document.getElementById('proxy-submit-button');
    if (submitBtn) {
        if (isNetTemplate) {
            const hasValidTask = document.querySelectorAll('.timetable-task').length > 0;
            // ★ allocated が 0 の場合も送信可能にする (入力クリアのため)
            submitBtn.disabled = !(hasValidTask || allocated === 0);
        } else {
            const hasValidTask = Array.from(document.querySelectorAll('#proxy-task-entries-container .task-entry')).some(entry => {
                const major = entry.querySelector('.task-category-major').value;
                const minor = entry.querySelector('.task-category-minor').value;
                const time = parseInt(entry.querySelector('.task-time').value, 10) || 0;
                return major && minor && time > 0;
            });
            submitBtn.disabled = !(hasValidTask || allocated === 0);
        }
    }
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

    const { employeeId, date, groupId } = currentProxyTarget;

    // ログインユーザー自身の場合は権限チェックをスキップ
    const isSelf = cachedAdminUserInfo && String(cachedAdminUserInfo.employeeId) === String(employeeId);
    if (!isSelf) {
        if (!await checkAdminPermission()) return; // ★権限チェック
    }

    const submitBtn = document.getElementById('proxy-submit-button');
    
    if (!confirm('この内容で代理報告を送信しますか？')) return;

    submitBtn.disabled = true;
    submitBtn.textContent = '送信中...';

    const isNetTemplate = (groupId && String(groupId) === '3');

    if (isNetTemplate) {
        const tasks = collectProxyNetTasksFromTimetable();

        // 送信前の重複チェック
        // 収集したタスクリスト内で時間的な重複がないかチェック
        for (let i = 0; i < tasks.length; i++) {
            const taskA = tasks[i];
            // 休憩タスクはチェック対象外
            if (taskA.categoryA_id === 'N99') continue;

            const startA = new Date(`1970-01-01T${taskA.startTime}:00`);
            const endA = new Date(`1970-01-01T${taskA.endTime}:00`);

            for (let j = i + 1; j < tasks.length; j++) {
                const taskB = tasks[j];
                // 休憩タスクはチェック対象外
                if (taskB.categoryA_id === 'N99') continue;

                const startB = new Date(`1970-01-01T${taskB.startTime}:00`);
                const endB = new Date(`1970-01-01T${taskB.endTime}:00`);

                // 重複判定: (StartA < EndB) AND (EndA > StartB)
                if (startA < endB && endA > startB) {
                    alert(`タスクが重複しています。時間を見直してください。\n\n重複タスク1: ${taskA.categoryB_label} (${taskA.startTime}-${taskA.endTime})\n重複タスク2: ${taskB.categoryB_label} (${taskB.startTime}-${taskB.endTime})`);
                    submitBtn.disabled = false;
                    submitBtn.textContent = '代理報告を送信';
                    isProxySubmitting = false; // 送信フラグをリセット
                    return; // 送信を中止
                }
            }
        }
        const payload = {
            date: date,
            taskTotalMinutes: parseInt(document.getElementById('proxy-allocated-time-display').textContent, 10),
            jobcanWorkMinutes: parseInt(document.getElementById('proxy-report-work').value, 10),
            tasks: tasks,
            // 代理入力用のパラメータを追加 (API側の対応が必要)
            target_employee_id: employeeId,
            is_proxy: true
        };

        // 実行中なら待機キューへ（送信要求は自動保存より優先）
        const queued = enqueueProxyNetSaveRequest({
            type: 'submit',
            payload,
            submitBtn,
            triggerName: 'manual-submit'
        });
        if (queued) {
            submitBtn.textContent = '送信待機中...';
        }
        await processQueuedProxyNetSaveRequests();
    } else {
        const tasks = [];
        // 工務部（リスト形式）のタスク収集
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
            isProxySubmitting = true;

            const response = await fetchWithAuth(`${API_BASE_URL}/api/reports`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.message || '送信に失敗しました');
            }

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
        } finally {
            isProxySubmitting = false;
        }
    }
}

/**
 * ネット代理入力のタイムテーブルから送信用tasksを作成する。
 * 保存済みtimeを優先し、未保持時のみ開始/終了差分で補完する。
 */
function collectProxyNetTasksFromTimetable() {
    const tasks = [];
    document.querySelectorAll('.timetable-task').forEach(taskEl => {
        const isBreakTask = taskEl.dataset.taskType === 'break';
        if (isBreakTask) {
            tasks.push({
                categoryA_id: 'N99',
                categoryA_label: '昼休憩',
                categoryB_id: 'n_break',
                categoryB_label: '休憩',
                time: 0,
                startTime: taskEl.dataset.startTime,
                endTime: taskEl.dataset.endTime,
                comment: '昼休憩'
            });
            return;
        }

        const taskMinutes = getProxyNetTaskMinutes(taskEl);

        tasks.push({
            categoryA_id: taskEl.dataset.categoryAId,
            categoryA_label: taskEl.dataset.categoryALabel,
            categoryB_id: taskEl.dataset.categoryBId,
            categoryB_label: taskEl.dataset.categoryBLabel,
            time: taskMinutes,
            startTime: taskEl.dataset.startTime,
            endTime: taskEl.dataset.endTime,
            comment: taskEl.dataset.comment || ""
        });
    });
    return tasks;
}

/**
 * 比較用にネットタイムテーブル tasks を正規化（時刻ゼロ埋め・安定ソート）
 */
function normalizeProxyNetTasksForCompare(tasks) {
    if (!Array.isArray(tasks)) return [];
    const rows = tasks.map((t) => ({
        categoryA_id: String(t.categoryA_id ?? ''),
        categoryA_label: String(t.categoryA_label ?? ''),
        categoryB_id: String(t.categoryB_id ?? ''),
        categoryB_label: String(t.categoryB_label ?? ''),
        time: Number(t.time) || 0,
        startTime: normalizeProxyNetTimeStr(t.startTime),
        endTime: normalizeProxyNetTimeStr(t.endTime),
        comment: String(t.comment ?? ''),
    }));
    rows.sort((a, b) => {
        const c1 = (a.startTime || '').localeCompare(b.startTime || '');
        if (c1 !== 0) return c1;
        const c2 = (a.endTime || '').localeCompare(b.endTime || '');
        if (c2 !== 0) return c2;
        return `${a.categoryB_id}:${a.categoryA_id}`.localeCompare(`${b.categoryB_id}:${b.categoryA_id}`);
    });
    return rows;
}

function formatLocalYmdFromProxyDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function addDaysToProxyYmd(ymd, deltaDays) {
    const base = parseProxyYmdToLocalDate(ymd);
    base.setDate(base.getDate() + deltaDays);
    return formatLocalYmdFromProxyDate(base);
}

/** 同一「21日〜翌月20日」月度か（月度をまたぐ前日/翌日移動を拒否する） */
function isSameNetFiscalMonthForProxyYmd(ymdA, ymdB) {
    const da = parseProxyYmdToLocalDate(ymdA);
    const db = parseProxyYmdToLocalDate(ymdB);
    const ca = getNetFiscalPastReportsClosingEndForDate(da);
    const cb = getNetFiscalPastReportsClosingEndForDate(db);
    return ca.getTime() === cb.getTime();
}

function snapshotProxyNetFormState() {
    const workEl = document.getElementById('proxy-report-work');
    const allocEl = document.getElementById('proxy-allocated-time-display');
    const workRaw = workEl ? parseInt(workEl.value, 10) : 0;
    const allocRaw = allocEl ? parseInt(allocEl.textContent, 10) : 0;
    const work = Number.isFinite(workRaw) ? workRaw : 0;
    const allocated = Number.isFinite(allocRaw) ? allocRaw : 0;
    const tasks = normalizeProxyNetTasksForCompare(collectProxyNetTasksFromTimetable());
    return JSON.stringify({ work, allocated, tasks });
}

function refreshProxyNetSavedSnapshot() {
    if (!currentProxyTarget || String(currentProxyTarget.groupId) !== '3') {
        proxyNetSavedSnapshot = null;
        return;
    }
    try {
        proxyNetSavedSnapshot = snapshotProxyNetFormState();
    } catch (e) {
        console.warn('refreshProxyNetSavedSnapshot:', e);
        proxyNetSavedSnapshot = null;
    }
}

function hasProxyNetUnsavedChanges() {
    if (!currentProxyTarget || String(currentProxyTarget.groupId) !== '3') return false;
    if (proxyNetSavedSnapshot === null) return true;
    try {
        return snapshotProxyNetFormState() !== proxyNetSavedSnapshot;
    } catch {
        return true;
    }
}

async function navigateProxyNetAdjacentDay(deltaDays) {
    if (!currentProxyTarget || String(currentProxyTarget.groupId) !== '3') return;
    if (isProxySubmitting) {
        alert('保存処理中です。完了してから再度お試しください。');
        return;
    }
    const curDate = currentProxyTarget.date;
    if (!curDate || typeof curDate !== 'string') return;

    const newDate = addDaysToProxyYmd(curDate, deltaDays);
    if (!isSameNetFiscalMonthForProxyYmd(curDate, newDate)) {
        alert('月度が変わる日付へは、ここから移動できません。一覧またはカレンダーから該当月度を開いてください。');
        return;
    }

    if (hasProxyNetUnsavedChanges()) {
        await autoSaveProxyNetReport('day-nav');
        if (hasProxyNetUnsavedChanges()) {
            alert('保存に失敗したため、日付を移動できません。内容を確認してください。');
            return;
        }
    }

    await openProxyReport(
        String(currentProxyTarget.employeeId),
        currentProxyTarget.name || '',
        newDate,
        String(currentProxyTarget.groupId),
        { returnTarget: currentProxyTarget.returnTarget, skipProxyStack: true },
    );
}

function getProxyNetTaskMinutes(taskEl) {
    const isLocked = taskEl.dataset.lockedTime === '1';
    const storedTime = parseInt(taskEl.dataset.time, 10);
    if (isLocked && !Number.isNaN(storedTime) && storedTime >= 0) {
        return storedTime;
    }
    const start = new Date(`1970-01-01T${taskEl.dataset.startTime}:00`);
    const end = new Date(`1970-01-01T${taskEl.dataset.endTime}:00`);
    if (end < start) end.setDate(end.getDate() + 1);
    const diffMinutes = Math.round((end - start) / 1000 / 60);
    if (!Number.isNaN(diffMinutes) && diffMinutes >= 0) return diffMinutes;
    if (!Number.isNaN(storedTime) && storedTime >= 0) return storedTime;
    return 0;
}

/**
 * ネット代理入力の保存要求を1スロット保留キューへ登録する。
 * - latest-wins: 同種要求は新しいものに置換
 * - submit 優先: submit 待機中に auto は上書きしない
 * 戻り値: true のとき「待機キュー入り」, false のとき「この後すぐ実行される可能性あり」
 */
function enqueueProxyNetSaveRequest(request) {
    if (proxyPendingSaveRequest && proxyPendingSaveRequest.type === 'submit' && request.type === 'auto') {
        return true; // submit待機中はauto要求を捨てる
    }
    proxyPendingSaveRequest = request;
    return isProxySubmitting;
}

async function processQueuedProxyNetSaveRequests() {
    if (isProxySubmitting) return;
    while (proxyPendingSaveRequest) {
        const req = proxyPendingSaveRequest;
        proxyPendingSaveRequest = null;
        await executeProxyNetSaveRequest(req);
    }
}

async function executeProxyNetSaveRequest(req) {
    let saveSucceeded = false;
    try {
        isProxySubmitting = true;
        const response = await fetchWithAuth(`${API_BASE_URL}/api/reports_net`, {
            method: 'POST',
            body: JSON.stringify(req.payload)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            throw new Error(errorData?.message || `${req.type === 'submit' ? '送信' : '自動保存'}に失敗しました`);
        }

        saveSucceeded = true;

        if (req.type === 'submit') {
            // ★送信成功時にタイマー停止と下書き削除
            if (proxyAutoSaveTimer) clearInterval(proxyAutoSaveTimer);
            const draftKey = getProxyDraftKey();
            if (draftKey) localStorage.removeItem(draftKey);
            document.getElementById('proxy-report-form-wrapper').style.display = 'none';
            document.getElementById('proxy-completion-screen').style.display = 'block';
        }
    } catch (error) {
        console.error(`[${req.triggerName}]`, error);
        if (req.type === 'submit') {
            alert(`エラー: ${error.message}`);
            if (req.submitBtn) {
                req.submitBtn.disabled = false;
                req.submitBtn.textContent = '代理報告を送信';
            }
        } else {
            showToast(`保存失敗: ${error.message}`, 'error');
        }
    } finally {
        isProxySubmitting = false;
        if (
            saveSucceeded
            && req.type === 'auto'
            && currentProxyTarget
            && String(currentProxyTarget.groupId) === '3'
        ) {
            refreshProxyNetSavedSnapshot();
        }
        // 実行中に次の要求が積まれた場合は続けて処理する
        if (proxyPendingSaveRequest) {
            void processQueuedProxyNetSaveRequests();
        }
    }
}

/**
 * ネット代理入力の自動保存（追加/変更保存の直後）。
 * 送信処理と同じ isProxySubmitting フラグで直列化し、1スロット保留キューで順次実行する。
 */
async function autoSaveProxyNetReport(triggerName = 'auto-save') {
    if (!currentProxyTarget || String(currentProxyTarget.groupId) !== '3') return;
    const { employeeId, date } = currentProxyTarget;
    const payload = {
        date: date,
        taskTotalMinutes: parseInt(document.getElementById('proxy-allocated-time-display').textContent, 10),
        jobcanWorkMinutes: parseInt(document.getElementById('proxy-report-work').value, 10),
        tasks: collectProxyNetTasksFromTimetable(),
        target_employee_id: employeeId,
        is_proxy: true
    };
    enqueueProxyNetSaveRequest({
        type: 'auto',
        payload,
        triggerName
    });
    await processQueuedProxyNetSaveRequests();
}

// --- タイムテーブル用の状態変数 ---
let currentlyEditingTaskElement = null; // ★編集中のタスク要素を保持
let detachedTaskElements = []; // ★画面外のタスク要素を保持する
// --- ネットタイムテーブル: コピー&ペースト（15分決め打ち） ---
const PROXY_NET_TASK_CLIPBOARD_STORAGE_KEY = 'proxy_net_task_clipboard_v1';
let proxyNetTaskClipboard = null; // { categoryB_id, categoryB_label, categoryA_id, categoryA_label, comment }

function isTypingInTextField() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
        const t = (el.getAttribute('type') || '').toLowerCase();
        return ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'time', 'date'].includes(t);
    }
    return tag === 'select';
}

function loadProxyNetTaskClipboard() {
    if (proxyNetTaskClipboard) return proxyNetTaskClipboard;
    try {
        const raw = localStorage.getItem(PROXY_NET_TASK_CLIPBOARD_STORAGE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        if (!obj.categoryA_id || !obj.categoryB_id) return null;
        proxyNetTaskClipboard = obj;
        return proxyNetTaskClipboard;
    } catch {
        return null;
    }
}

function saveProxyNetTaskClipboard(obj) {
    proxyNetTaskClipboard = obj;
    try {
        localStorage.setItem(PROXY_NET_TASK_CLIPBOARD_STORAGE_KEY, JSON.stringify(obj));
    } catch {
        // ignore
    }
}

function addMinutesToTimeStrProxyNet(startTimeStr, addMinutes) {
    const s = normalizeProxyNetTimeStr(startTimeStr);
    const sm = timeStrToMinutesProxyNet(s);
    if (sm === null) return '';
    const total = (sm + addMinutes) % (24 * 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function pasteProxyNetTimetableTaskFromClipboard() {
    const clip = loadProxyNetTaskClipboard();
    if (!clip) return;

    const startTimeInput = document.getElementById('task-start-time');
    const endTimeInput = document.getElementById('task-end-time');
    if (!startTimeInput) return;

    const startTime = normalizeProxyNetTimeStr(startTimeInput.value);
    if (!startTime) return;

    // 15分固定。複数選択（30分以上）の場合は選択範囲の長さで延長解釈
    let durationMin = 15;
    const endTimeSelected = endTimeInput ? normalizeProxyNetTimeStr(endTimeInput.value) : '';
    const sm = timeStrToMinutesProxyNet(startTime);
    const em = endTimeSelected ? timeStrToMinutesProxyNet(endTimeSelected) : null;
    if (sm !== null && em !== null) {
        let diff = em - sm;
        if (diff < 0) diff += 24 * 60;
        if (diff >= 30) {
            durationMin = Math.max(15, Math.round(diff / 15) * 15);
        }
    }

    const endTime = addMinutesToTimeStrProxyNet(startTime, durationMin);
    if (!endTime) return;

    const catBSelect = document.getElementById('task-category-b-select');
    const catASelect = document.getElementById('task-category-a-select');
    const commentInput = document.getElementById('task-comment');
    if (!catBSelect || !catASelect) return;

    // フォームへ反映（catB -> change -> catA の順）
    startTimeInput.value = startTime;
    if (endTimeInput) endTimeInput.value = endTime;
    catBSelect.value = String(clip.categoryB_id);
    catBSelect.dispatchEvent(new Event('change'));
    catASelect.value = String(clip.categoryA_id);
    if (commentInput) commentInput.value = clip.comment || '';

    // duration は updateTaskDuration が計算する（表示用）
    updateTaskDuration();

    // addProxyTimetableTask は開始行が無ければ拡張して描画する実装済み
    addProxyTimetableTask();
}

function bindProxyNetTaskClipboardShortcuts() {
    if (window.__proxyNetTaskClipboardBound) return;
    window.__proxyNetTaskClipboardBound = true;

    document.addEventListener('keydown', async (e) => {
        // ネットのタイムテーブル画面でのみ有効化
        if (!document.getElementById('timetable-body')) return;
        if (!currentProxyTarget || String(currentProxyTarget.groupId) !== '3') return;

        const key = (e.key || '').toLowerCase();
        const isCopy = (key === 'c') && (e.ctrlKey || e.metaKey);
        const isPaste = (key === 'v') && (e.ctrlKey || e.metaKey);
        if (!isCopy && !isPaste) return;

        // 通常のテキストコピー/貼り付けは邪魔しない
        if (isTypingInTextField()) return;

        if (isCopy) {
            if (!currentlyEditingTaskElement) return;
            const isBreakTask = currentlyEditingTaskElement.dataset.taskType === 'break'
                || currentlyEditingTaskElement.dataset.categoryAId === 'N99';
            if (isBreakTask) return;

            const obj = {
                categoryB_id: currentlyEditingTaskElement.dataset.categoryBId,
                categoryB_label: currentlyEditingTaskElement.dataset.categoryBLabel,
                categoryA_id: currentlyEditingTaskElement.dataset.categoryAId,
                categoryA_label: currentlyEditingTaskElement.dataset.categoryALabel,
                comment: currentlyEditingTaskElement.dataset.comment || '',
            };
            if (!obj.categoryA_id || !obj.categoryB_id) return;
            saveProxyNetTaskClipboard(obj);
            e.preventDefault();
            showToast('タスク内容をコピーしました（Ctrl+Vで貼り付け）', 'success');
            return;
        }

        if (isPaste) {
            e.preventDefault();
            await pasteProxyNetTimetableTaskFromClipboard();
        }
    });
}

let timetableStartHour = 7;
let timetableEndHour = 21;
const TIMETABLE_MIN_START = 5; // 早出の最小時刻
const TIMETABLE_ZOOM_OUT_START = 8; // ズームアウト時の最大開始時刻
const TIMETABLE_DEFAULT_START = 7;
const TIMETABLE_ZOOM_OUT_END = 17; // ズームアウト時の最小終了時刻
/** 表示の終了は排他的（7〜21 なら 7:00 行から 20:45 行まで）→ 7:00〜20:00 台をデフォルト表示 */
const TIMETABLE_DEFAULT_END = 21;
const TIMETABLE_MAX_END = 22; // 残業の最大時刻

/**
 * API・フォームの時刻を data-time 行（HH:MM ゼロ埋め）に合わせる
 */
function normalizeProxyNetTimeStr(timeStr) {
    if (timeStr == null || timeStr === '') return '';
    const s = String(timeStr).trim();
    const m = s.match(/^(\d{1,2}):(\d{2})(?::\d+)?$/);
    if (!m) return s;
    const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
    const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function timeStrToMinutesProxyNet(timeStr) {
    const n = normalizeProxyNetTimeStr(timeStr);
    if (!n || !/^\d{2}:\d{2}$/.test(n)) return null;
    const [h, min] = n.split(':').map((x) => parseInt(x, 10));
    return h * 60 + min;
}

/**
 * 既存タスクの開始・終了が現在の表示範囲外でも行が生成されるよう拡張する
 */
function expandProxyTimetableRangeForTaskTimes(startTimeStr, endTimeStr) {
    const sm = timeStrToMinutesProxyNet(startTimeStr);
    const em0 = timeStrToMinutesProxyNet(endTimeStr);
    if (sm === null || em0 === null) return;

    let em = em0;
    if (em <= sm) em += 24 * 60;

    const firstHour = Math.floor(sm / 60);
    timetableStartHour = Math.max(TIMETABLE_MIN_START, Math.min(timetableStartHour, firstHour));

    const lastSlotStartMin = em - 15;
    if (lastSlotStartMin < sm) return;
    const requiredEndExclusive = Math.floor(lastSlotStartMin / 60) + 1;
    timetableEndHour = Math.min(TIMETABLE_MAX_END, Math.max(timetableEndHour, requiredEndExclusive));
}

function expandProxyTimetableRangeForTasks(tasks) {
    if (!Array.isArray(tasks)) return;
    tasks.forEach((task) => {
        if (task && task.startTime && task.endTime) {
            expandProxyTimetableRangeForTaskTimes(task.startTime, task.endTime);
        }
    });
}

/**
 * 代理入力（ネット事業部版）のタイムテーブルUIを初期化する
 */
async function initializeProxyTimetable() {
    // ★ Interact.js を動的に読み込む
    try {
        await loadScript('https://cdn.jsdelivr.net/npm/interactjs/dist/interact.min.js');
    } catch (error) {
        console.error(error);
        showToast('インタラクションライブラリの読み込みに失敗しました。', 'error');
    }

    // 初期状態リセット
    timetableStartHour = TIMETABLE_DEFAULT_START;
    timetableEndHour = TIMETABLE_DEFAULT_END;
    detachedTaskElements = []; // ★リセットを追加

    // 初期表示
    renderProxyTimetable();

    // ズームボタンのイベントリスナー設定
    const zoomInTop = document.getElementById('timetable-zoom-in-top');
    const zoomOutTop = document.getElementById('timetable-zoom-out-top');
    const zoomInBottom = document.getElementById('timetable-zoom-in-bottom');
    const zoomOutBottom = document.getElementById('timetable-zoom-out-bottom');

    // ★「過去日報」ボタンのイベントリスナーを追加
    const showPastReportsBtn = document.getElementById('show-past-reports-btn');
    if (showPastReportsBtn) {
        showPastReportsBtn.addEventListener('click', openPastReportsModal);
    }

    // ★過去日報モーダルの閉じるイベント
    const pastReportsModal = document.getElementById('past-reports-modal');
    const pastReportsModalClose = document.getElementById('past-reports-modal-close');
    if (pastReportsModal && pastReportsModalClose) {
        const closeModal = () => { pastReportsModal.classList.remove('is-active'); };
        pastReportsModalClose.addEventListener('click', closeModal);
        // モーダルの外側（オーバーレイ部分）クリックでも閉じる
        pastReportsModal.addEventListener('click', (e) => {
            // クリックされたのがモーダル自身（背景のオーバーレイ）であるかを確認
            if (e.target.classList.contains('dr-modal')) closeModal();
        });
    }

    if (zoomInTop) {
        zoomInTop.addEventListener('click', () => {
            if (timetableStartHour > TIMETABLE_MIN_START) {
                timetableStartHour--;
                renderProxyTimetable();
            }
        });
    }
    if (zoomOutTop) {
        zoomOutTop.addEventListener('click', () => {
            if (timetableStartHour < TIMETABLE_ZOOM_OUT_START) {
                timetableStartHour++;
                renderProxyTimetable();
            }
        });
    }
    if (zoomInBottom) {
        zoomInBottom.addEventListener('click', () => {
            if (timetableEndHour < TIMETABLE_MAX_END) {
                timetableEndHour++;
                renderProxyTimetable();
            }
        });
    }
    if (zoomOutBottom) {
        zoomOutBottom.addEventListener('click', () => {
            if (timetableEndHour > TIMETABLE_ZOOM_OUT_END) {
                timetableEndHour--;
                renderProxyTimetable();
            }
        });
    }

    // ドラッグ選択機能のセットアップ
    setupProxyTimetableDragSelection();

    // ★ Interact.js のインタラクションをセットアップ
    setupTimetableInteractions();

    // Ctrl+C / Ctrl+V（ネットタイムテーブルのタスク複製）
    bindProxyNetTaskClipboardShortcuts();

    // 右側の時刻入力フォームが変更されたら、合計時間も更新する
    const startTimeInput = document.getElementById('task-start-time');
    const endTimeInput = document.getElementById('task-end-time');
    if (startTimeInput && endTimeInput) {
        startTimeInput.addEventListener('change', updateTaskDuration);
        endTimeInput.addEventListener('change', updateTaskDuration);
    }

    // カテゴリ選択プルダウンの初期化
    const catA_select = document.getElementById('task-category-a-select');
    const catB_select = document.getElementById('task-category-b-select');
    const catA_label = document.querySelector('label[for="task-category-a-select"]');
    const catB_label = document.querySelector('label[for="task-category-b-select"]');

    // ★ 1) UIの入れ替え
    if (catA_label && catB_label) {
        const catA_container = catA_label.parentElement;
        const catB_container = catB_label.parentElement;
        if (catA_container && catB_container && catA_container.parentElement === catB_container.parentElement) {
            // catBのコンテナをcatAのコンテナの前に挿入
            catA_container.parentElement.insertBefore(catB_container, catA_container);
        }
    }


    if (catA_select) {
        // ★既存のオプションをクリア
        catA_select.innerHTML = '<option value="">選択してください...</option>';
        proxyCategoryAOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.id;
            option.textContent = opt.label;
            catA_select.appendChild(option);
        });

        // ★ 2) 業務種別を初期状態で無効化
        catA_select.disabled = true;
    }
    if (catB_select) {
        // ★既存のオプションをクリア
        catB_select.innerHTML = '<option value="">選択してください...</option>';
        proxyCategoryBOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.id;
            // 工事番号(label)と案件名(project)を連結して表示
            const displayText = [opt.label, opt.project].filter(Boolean).join(' ');
            option.textContent = displayText;
            catB_select.appendChild(option);
        });

        // ★ 3) イベントリスナーの追加（category_a_sort でPC入力画面専用の並び順を反映）
        catB_select.addEventListener('change', () => {
            const selectedCatB_Id = catB_select.value;
            const selectedCatB = proxyCategoryBOptions.find(opt => opt.id === selectedCatB_Id);
            const settings = selectedCatB ? selectedCatB.category_a_settings : null;
            const sortMap = selectedCatB ? (selectedCatB.category_a_sort || {}) : {};

            // 業務種別プルダウンをリセット
            catA_select.innerHTML = '<option value="">選択してください...</option>';
            
            if (settings && Object.keys(settings).length > 0) {
                // 業務種別を選択可能に
                catA_select.disabled = false;
                
                // 許可された業務種別のIDリスト
                const allowedCatA_Ids = Object.keys(settings);
                
                // 選択肢をフィルタリング
                let filteredOptions = proxyCategoryAOptions.filter(opt => allowedCatA_Ids.includes(opt.id));
                
                // category_a_sort で並び替え（PC入力画面限定の並び順）
                filteredOptions.sort((a, b) => {
                    const sa = sortMap[a.id];
                    const sb = sortMap[b.id];
                    if (typeof sa === 'number' && typeof sb === 'number') {
                        if (sa !== sb) return sa - sb;
                    } else if (typeof sa === 'number') return -1;
                    else if (typeof sb === 'number') return 1;
                    return (a.label || '').localeCompare(b.label || '', 'ja');
                });
                
                filteredOptions.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt.id;
                    option.textContent = opt.label;
                    catA_select.appendChild(option);
                });
            } else {
                // 設定がない場合は業務種別を選択不可に
                catA_select.disabled = true;
            }
        });
    }

    // タスク追加ボタンのイベントリスナー
    const addTaskBtn = document.getElementById('add-task-btn');
    if (addTaskBtn) {
        addTaskBtn.addEventListener('click', addProxyTimetableTask);
 
        // --- ★編集・削除ボタンを動的に生成・設定 ---
        const buttonContainer = addTaskBtn.parentElement;
        if (buttonContainer) {
            buttonContainer.style.display = 'flex';
            buttonContainer.style.justifyContent = 'space-between'; // 両端に配置
            buttonContainer.style.gap = '10px'; // ボタン間の最小間隔

            // 編集ボタン
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.id = 'edit-task-btn';
            editBtn.className = 'btn-primary';
            editBtn.textContent = '変更を保存';
            editBtn.addEventListener('click', handleEditTask);
            buttonContainer.appendChild(editBtn);

            // 削除ボタン
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.id = 'delete-task-btn';
            deleteBtn.className = 'btn-secondary';
            deleteBtn.textContent = '削除';
            deleteBtn.addEventListener('click', handleDeleteTask);
            buttonContainer.appendChild(deleteBtn);
        }
    }
    // ★ボタンの初期状態を設定
    updateTaskFormButtons('add');
}

/**
 * タイムテーブルを描画する
 */
function renderProxyTimetable() {
    const tbody = document.getElementById('timetable-rows');
    if (!tbody) return;

    // ★ 変更点: 既存のタスクが消えないように、退避・再配置するロジックに変更
    const currentDomTasks = Array.from(document.querySelectorAll('.timetable-task'));
    const allTaskElements = [...currentDomTasks, ...detachedTaskElements];
    detachedTaskElements = []; // 待機リストをクリア

    currentDomTasks.forEach(el => el.remove());

    tbody.innerHTML = ''; // 既存の時間行をクリア

    for (let hour = timetableStartHour; hour < timetableEndHour; hour++) {
        for (let minute = 0; minute < 60; minute += 15) {
            const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
            const tr = document.createElement('tr');
            tr.dataset.time = timeStr;
            tr.innerHTML = `
                <td style="width: 70px; text-align: center; font-size: 0.8em; color: #666; border-right: 1px solid #eee; vertical-align: top; padding-top: 2px;">
                    ${minute === 0 ? timeStr : ''}
                </td>
                <td class="timetable-slot" style="padding: 0; box-sizing: border-box; border-bottom: 1px ${minute === 45 ? 'solid #ddd' : 'dotted #ddd'}; height: 24px; cursor: pointer; position: relative;"></td>
            `;
            tbody.appendChild(tr);
        }
    }

    allTaskElements.forEach(taskEl => {
        const startTime = taskEl.dataset.startTime;
        const startRow = document.querySelector(`#timetable-rows tr[data-time="${startTime}"]`);
        if (startRow) {
            startRow.querySelector('.timetable-slot').appendChild(taskEl);
        } else {
            detachedTaskElements.push(taskEl);
        }
    });

    // ズームボタンの活性/非活性を更新
    updateTimetableZoomButtons();
}

/**
 * タイムテーブルのズームボタンの活性/非活性を更新する
 */
function updateTimetableZoomButtons() {
    const zoomInTop = document.getElementById('timetable-zoom-in-top');
    const zoomOutTop = document.getElementById('timetable-zoom-out-top');
    const zoomInBottom = document.getElementById('timetable-zoom-in-bottom');
    const zoomOutBottom = document.getElementById('timetable-zoom-out-bottom');

    if (zoomInTop) zoomInTop.disabled = (timetableStartHour <= TIMETABLE_MIN_START);
    if (zoomOutTop) zoomOutTop.disabled = (timetableStartHour >= TIMETABLE_ZOOM_OUT_START);
    if (zoomInBottom) zoomInBottom.disabled = (timetableEndHour >= TIMETABLE_MAX_END);
    if (zoomOutBottom) zoomOutBottom.disabled = (timetableEndHour <= TIMETABLE_ZOOM_OUT_END);
}

/**
 * 指定された時間帯が既存のタスクと重複していないかチェックする
 * @param {string} startTimeStr 開始時刻 (HH:MM)
 * @param {string} endTimeStr 終了時刻 (HH:MM)
 * @param {HTMLElement|null} excludeElement チェックから除外する要素（移動・リサイズ中の自分自身など）
 * @returns {boolean} 重複している場合は true
 */
function checkTaskCollision(startTimeStr, endTimeStr, excludeElement = null) {
    const ns = normalizeProxyNetTimeStr(startTimeStr);
    const ne = normalizeProxyNetTimeStr(endTimeStr);
    // 比較用のDateオブジェクトを作成
    const newStart = new Date(`1970-01-01T${ns}:00`);
    let newEnd = new Date(`1970-01-01T${ne}:00`);
    // 日付またぎ対応 (終了時刻が開始時刻より前の場合は翌日とみなす)
    if (newEnd < newStart) {
        newEnd.setDate(newEnd.getDate() + 1);
    }

    const tasks = document.querySelectorAll('.timetable-task');
    for (const task of tasks) {
        if (task === excludeElement) continue;

        const taskStart = new Date(`1970-01-01T${normalizeProxyNetTimeStr(task.dataset.startTime)}:00`);
        let taskEnd = new Date(`1970-01-01T${normalizeProxyNetTimeStr(task.dataset.endTime)}:00`);
        if (taskEnd < taskStart) {
            taskEnd.setDate(taskEnd.getDate() + 1);
        }

        // 重複判定: (StartA < EndB) AND (EndA > StartB)
        if (newStart < taskEnd && newEnd > taskStart) {
            return true;
        }
    }
    return false;
}

/**
 * タイムテーブルのドラッグ選択機能をセットアップする
 */
function setupProxyTimetableDragSelection() {
    const timetableBody = document.getElementById('timetable-body');
    const startTimeInput = document.getElementById('task-start-time');
    const endTimeInput = document.getElementById('task-end-time');

    if (!timetableBody || !startTimeInput || !endTimeInput) return;

    let isDragging = false;
    let startRow = null;
    let endRow = null;
    let shiftClickStartRow = null; // Shift+クリックの開始点を保持

    timetableBody.addEventListener('mousedown', (e) => {
        // クリックされたのが既存タスクの場合、ドラッグ選択は開始せず、
        // タスク自身のクリックイベントに処理を任せる
        if (e.target.closest('.timetable-task')) {
            return;
        }

        // 空の領域がクリックされ、かつ編集モードだった場合は編集モードを解除する
        if (currentlyEditingTaskElement) {
            clearProxyTaskDetailsForm();
        }

        // ★ Shift+クリックによる範囲選択
        if (e.shiftKey && shiftClickStartRow) {
            e.preventDefault();
            startRow = shiftClickStartRow;
            endRow = e.target.closest('tr');
            updateSelectionHighlight();
            updateFormTimes();
            // Shiftクリックでの選択後はドラッグモードに移行しない
            isDragging = false; 
            return;
        }

        const targetRow = e.target.closest('tr');
        if (!targetRow) return;

        e.preventDefault(); // テキスト選択などを防ぐ
        isDragging = true;
        startRow = targetRow;
        shiftClickStartRow = targetRow; // 通常のクリックでも開始点を記憶
        endRow = targetRow;
        
        updateSelectionHighlight();
    });

    timetableBody.addEventListener('mouseover', (e) => {
        if (!isDragging) return;

        const targetRow = e.target.closest('tr');
        if (targetRow && targetRow !== endRow) {
            endRow = targetRow;
            updateSelectionHighlight();
        }
    });

    // ドラッグがテーブル外に出てもmouseupを検知できるようにwindowに設定
    window.addEventListener('mouseup', (e) => {
        if (!isDragging) return;

        isDragging = false;
        updateFormTimes();

        // ★ 追加: 新規作成時の重複チェック
        const sTime = startTimeInput.value;
        const eTime = endTimeInput.value;
        if (sTime && eTime && checkTaskCollision(sTime, eTime)) {
            alert('他のタスクと時間が重なっています。');
            clearProxyTaskDetailsForm(); // フォームをクリア
            updateSelectionHighlight(); // ハイライトを消す（startRow/endRow等は残るが、フォームが空なので実質リセット）
        }
    });

    function updateSelectionHighlight() {
        const allRows = Array.from(timetableBody.querySelectorAll('tbody tr'));
        let inSelection = false;

        const startIndex = allRows.indexOf(startRow);
        const endIndex = allRows.indexOf(endRow);
        
        const minIndex = Math.min(startIndex, endIndex);
        const maxIndex = Math.max(startIndex, endIndex);

        allRows.forEach((row, index) => {
            const slot = row.querySelector('.timetable-slot');
            if (index >= minIndex && index <= maxIndex) {
                // ★ 変更: フォームがクリアされた(start/end timeが空)場合はハイライトしない
                const hasTime = document.getElementById('task-start-time').value !== '';
                slot.style.backgroundColor = hasTime ? '#edeecf' : ''; 
            } else {
                slot.style.backgroundColor = '';
            }
        });
    }

    function updateFormTimes() {
        const allRows = Array.from(timetableBody.querySelectorAll('tbody tr'));
        const startIndex = allRows.indexOf(startRow);
        const endIndex = allRows.indexOf(endRow);

        const firstRow = allRows[Math.min(startIndex, endIndex)];
        const lastRow = allRows[Math.max(startIndex, endIndex)];

        const startTime = firstRow.dataset.time;
        
        // 終了時刻は、選択した最後のセルの15分後
        const lastTimeParts = lastRow.dataset.time.split(':');
        const lastDate = new Date();
        lastDate.setHours(parseInt(lastTimeParts[0], 10), parseInt(lastTimeParts[1], 10), 0, 0);
        lastDate.setMinutes(lastDate.getMinutes() + 15);
        const endTime = `${String(lastDate.getHours()).padStart(2, '0')}:${String(lastDate.getMinutes()).padStart(2, '0')}`;

        startTimeInput.value = startTime;
        endTimeInput.value = endTime;

        // 合計時間も更新
        updateTaskDuration();
    }
}

/**
 * タスク詳細フォームの合計時間（分）を更新する
 */
function updateTaskDuration() {
    const startTimeInput = document.getElementById('task-start-time');
    const endTimeInput = document.getElementById('task-end-time');
    const durationInput = document.getElementById('task-duration');

    if (!startTimeInput.value || !endTimeInput.value) {
        durationInput.value = '';
        return;
    }

    try {
        const start = new Date(`1970-01-01T${startTimeInput.value}:00`);
        const end = new Date(`1970-01-01T${endTimeInput.value}:00`);
        
        // 日付をまたぐ場合を考慮
        if (end < start) {
            end.setDate(end.getDate() + 1);
        }

        const diffMinutes = (end - start) / 1000 / 60;
        durationInput.value = diffMinutes;
    } catch (e) {
        console.error("時間計算エラー:", e);
        durationInput.value = '';
    }
}

/**
 * 色が濃いかどうかを判定するヘルパー関数
 * @param {string} color - 色コード (#RRGGBB or rgba(r,g,b,a))
 * @returns {boolean}
 */
const isDarkColor = (color) => {
    if (!color) return false;

    let r, g, b;
    if (color.startsWith('rgba')) {
        const parts = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!parts) return false;
        [_, r, g, b] = parts.map(Number);
    } else if (color.startsWith('#')) {
        const hex = color.replace('#', '');
        if (hex.length !== 6) return false;
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
    } else { return false; }
    return (r * 0.299 + g * 0.587 + b * 0.114) < 140;
};

/**
 * タイムテーブルにタスクブロックを追加する
 */
function addProxyTimetableTask() {
    const startTime = normalizeProxyNetTimeStr(document.getElementById('task-start-time').value);
    const endTime = normalizeProxyNetTimeStr(document.getElementById('task-end-time').value);
    const duration = parseInt(document.getElementById('task-duration').value, 10);
    const catA_select = document.getElementById('task-category-a-select');
    const catB_select = document.getElementById('task-category-b-select');
    const categoryA_id = catA_select.value;
    const categoryA_label = catA_select.options[catA_select.selectedIndex].text;
    const categoryB_id = catB_select.value;
    const categoryB_label = catB_select.options[catB_select.selectedIndex].text;
    const comment = document.getElementById('task-comment').value;

    // Validation
    if (!startTime || !endTime || !duration || duration <= 0) {
        alert('有効な時間を選択してください。');
        return;
    }
    if (!categoryA_id || !categoryB_id) {
        alert('業務種別と集計項目の両方を選択してください。');
        return;
    }

    // ★ 重複チェックを追加
    if (checkTaskCollision(startTime, endTime)) {
        alert('他のタスクと時間が重なっています。');
        return;
    }

    let startRow = document.querySelector(`#timetable-rows tr[data-time="${startTime}"]`);
    if (!startRow) {
        expandProxyTimetableRangeForTaskTimes(startTime, endTime);
        renderProxyTimetable();
        startRow = document.querySelector(`#timetable-rows tr[data-time="${startTime}"]`);
    }
    if (!startRow) {
        alert('タイムテーブル上で開始時刻に対応する行が見つかりません。');
        return;
    }
    const startSlotCell = startRow.querySelector('.timetable-slot');

    // Create task element
    const taskElement = document.createElement('div');
    taskElement.className = 'timetable-task';
    
    // --- 色の決定ロジック ---
    const selectedCatB = proxyCategoryBOptions.find(opt => opt.id === categoryB_id);
    // category_a_settings: { "A01": "#ff0000", ... } が渡されることを想定
    const settings = selectedCatB ? selectedCatB.category_a_settings : null; 
    const taskColor = settings ? settings[categoryA_id] : null;
    const defaultBgColor = 'rgba(252, 185, 237, 0.8)'; 
    const bgColor = taskColor || defaultBgColor;
    const borderColor = '#d9534f'; // 未送信タスクを示す赤
    const textColor = isDarkColor(bgColor) ? '#FFFFFF' : '#333333';

    const slots = duration / 15;
    // 各スロットの高さが正確に24pxになったため、計算を単純化
    const taskHeight = slots * 24;

    taskElement.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: ${taskHeight}px;
        background-color: ${bgColor}; /* 動的に設定 */
        color: ${textColor};
        border-left: 3px solid ${borderColor};
        padding: 4px 6px;
        font-size: 0.8em;
        line-height: 1.3;
        overflow: hidden;
        z-index: 10;
        box-sizing: border-box;
        cursor: pointer;
    `;

    // 表示テキストを「集計項目 / 業務種別 / コメント」の形式で1行にまとめる
    const displayText = [
        categoryB_label,
        categoryA_label,
        comment
    ].filter(Boolean).join(' / ');

    taskElement.innerHTML = `<div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHTML(displayText)}">${escapeHTML(displayText)}</div>`;

    // データを要素に保存（将来の編集/削除用）
    taskElement.dataset.startTime = startTime;
    taskElement.dataset.endTime = endTime;
    taskElement.dataset.time = String(duration);
    taskElement.dataset.lockedTime = '0'; // 入力中タスク
    taskElement.dataset.categoryAId = categoryA_id;
    taskElement.dataset.categoryALabel = categoryA_label;
    taskElement.dataset.categoryBId = categoryB_id;
    taskElement.dataset.categoryBLabel = categoryB_label;
    taskElement.dataset.comment = comment;

    // クリックで詳細をalert表示するイベントリスナー
    taskElement.addEventListener('click', () => handleTaskClick(taskElement));

    startSlotCell.appendChild(taskElement);

    // フォームとハイライトをクリア
    clearProxyTaskDetailsForm();
    document.querySelectorAll('.timetable-slot').forEach(slot => {
        slot.style.backgroundColor = '';
    });
    autoSaveProxyNetReport('add-task');
}

/**
 * 代理入力（ネット）のタスク詳細フォームをクリアする
 */
function clearProxyTaskDetailsForm() {
    // フォームの値をクリア
    document.getElementById('task-start-time').value = '';
    document.getElementById('task-end-time').value = '';
    document.getElementById('task-duration').value = '';
    
    const catA_select = document.getElementById('task-category-a-select');
    catA_select.value = '';
    // ★ 業務種別を無効化し、選択肢をリセット
    catA_select.disabled = true;
    catA_select.innerHTML = '<option value="">選択してください...</option>';

    const catBSelect = document.getElementById('task-category-b-select');
    const commentInput = document.getElementById('task-comment');

    catBSelect.value = '';
    commentInput.value = '';

    // ★無効化されたフォームを有効に戻す
    catBSelect.disabled = false;
    commentInput.disabled = false;

    // 編集モードを解除
    if (currentlyEditingTaskElement) {
        // ハイライトを消す
        currentlyEditingTaskElement.style.outline = '';
        currentlyEditingTaskElement.style.boxShadow = '';
        currentlyEditingTaskElement = null;
    }

    // ボタンを「追加」モードに戻す
    updateTaskFormButtons('add');
}

/**
 * タイムテーブルに既存のタスクブロックを描画する（APIからのデータロード用）
 * @param {object} task APIから取得したタスクオブジェクト
 */
function renderExistingTimetableTask(task) {
    // ★休憩タスクの場合、保存された開始・終了時刻で描画する（デフォルトの12:00-13:00に戻さない）
    if (task.categoryA_id === 'N99' && task.startTime && task.endTime) {
        renderBreakTask(normalizeProxyNetTimeStr(task.startTime), normalizeProxyNetTimeStr(task.endTime));
        return;
    }

    const { categoryA_id, categoryA_label, categoryB_id, categoryB_label, comment } = task;
    const startTime = normalizeProxyNetTimeStr(task.startTime);
    const endTime = normalizeProxyNetTimeStr(task.endTime);

    if (!startTime || !endTime) {
        console.warn('Skipping rendering existing task due to missing time:', task);
        return;
    }

    const start = new Date(`1970-01-01T${startTime}:00`);
    const end = new Date(`1970-01-01T${endTime}:00`);
    if (end < start) end.setDate(end.getDate() + 1);
    const duration = (end - start) / 1000 / 60;

    if (duration <= 0) {
        console.warn('Skipping rendering existing task due to invalid duration:', task);
        return;
    }

    const startRow = document.querySelector(`#timetable-rows tr[data-time="${startTime}"]`);
    if (!startRow) {
        console.warn(`Could not find start row for time ${startTime}`);
        return;
    }
    const startSlotCell = startRow.querySelector('.timetable-slot');

    // --- 色の決定ロジック ---
    const catBData = proxyCategoryBOptions.find(opt => opt.id === categoryB_id);
    const settings = catBData ? catBData.category_a_settings : null;
    const taskColor = settings ? settings[categoryA_id] : null;
    const defaultBgColor = 'rgba(200, 200, 200, 0.8)'; // 少し薄いグレーに変更
    const bgColor = taskColor || defaultBgColor;
    const borderColor = 'transparent'; // ★保存済みタスクはバーなし
    const textColor = isDarkColor(bgColor) ? '#FFFFFF' : '#333333';

    const taskElement = document.createElement('div');
    taskElement.className = 'timetable-task';
    
    const slots = duration / 15;
    const taskHeight = slots * 24;

    taskElement.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: ${taskHeight}px;
        background-color: ${bgColor}; /* 動的に設定 */
        color: ${textColor};
        border-left: 3px solid ${borderColor};
        padding: 4px 6px;
        font-size: 0.8em;
        line-height: 1.3;
        overflow: hidden;
        z-index: 10;
        box-sizing: border-box;
        cursor: pointer;
    `;

    // 表示テキストを「集計項目 / 業務種別 / コメント」の形式で1行にまとめる
    const displayText = [
        categoryB_label,
        categoryA_label,
        comment || ''
    ].filter(Boolean).join(' / ');

    taskElement.innerHTML = `<div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHTML(displayText)}">${escapeHTML(displayText)}</div>`;

    taskElement.dataset.startTime = startTime;
    taskElement.dataset.endTime = endTime;
    taskElement.dataset.time = (task.time !== undefined && task.time !== null) ? String(task.time) : String(Math.round(duration));
    taskElement.dataset.lockedTime = '1'; // 既存日報由来タスク
    taskElement.dataset.categoryAId = categoryA_id;
    taskElement.dataset.categoryALabel = categoryA_label;
    taskElement.dataset.categoryBId = categoryB_id;
    taskElement.dataset.categoryBLabel = categoryB_label;
    taskElement.dataset.comment = comment || '';

    // クリックで詳細をalert表示するイベントリスナー
    taskElement.addEventListener('click', () => handleTaskClick(taskElement));

    startSlotCell.appendChild(taskElement);
}

// --- ★ここから追加: タイムテーブルのタスク編集・削除関連の関数 ---

/**
 * フォームのボタン表示を切り替える
 * @param {'add' | 'edit'} mode 
 */
function updateTaskFormButtons(mode) {
    const addBtn = document.getElementById('add-task-btn');
    const editBtn = document.getElementById('edit-task-btn');
    const deleteBtn = document.getElementById('delete-task-btn');

    if (!addBtn || !editBtn || !deleteBtn) return;

    if (mode === 'edit') {
        addBtn.style.display = 'none';

        // ★休憩タスクの場合は「変更を保存」を非表示にする
        const isBreakTask = currentlyEditingTaskElement && currentlyEditingTaskElement.dataset.taskType === 'break';
        editBtn.style.display = isBreakTask ? 'none' : 'inline-block';

        deleteBtn.style.display = 'inline-block';
    } else { // 'add' mode
        addBtn.style.display = 'inline-block';
        editBtn.style.display = 'none';
        deleteBtn.style.display = 'none';
    }
}

/**
 * タイムテーブル上のタスクがクリックされたときの処理
 * @param {HTMLElement} taskElement クリックされたタスク要素
 */
function handleTaskClick(taskElement) {
    // ドラッグやリサイズ操作中はクリックイベントを無視する
    if (taskElement.classList.contains('is-dragging') || taskElement.classList.contains('is-resizing')) {
        return;
    }

    // 既存の選択を解除
    if (currentlyEditingTaskElement) {
        currentlyEditingTaskElement.style.outline = '';
        currentlyEditingTaskElement.style.boxShadow = '';
    }

    // 新しいタスクを選択
    currentlyEditingTaskElement = taskElement;
    taskElement.style.outline = '2px solid #3498db';
    taskElement.style.boxShadow = '0 0 8px rgba(52, 152, 219, 0.6)';

    // フォームにデータをロード
    document.getElementById('task-start-time').value = taskElement.dataset.startTime;
    document.getElementById('task-end-time').value = taskElement.dataset.endTime;

    const isBreakTask = taskElement.dataset.taskType === 'break';
    const catBSelect = document.getElementById('task-category-b-select');
    const catASelect = document.getElementById('task-category-a-select');
    const commentInput = document.getElementById('task-comment');

    // ★先に集計項目を設定
    catBSelect.value = taskElement.dataset.categoryBId;
    // ★集計項目のchangeイベントを発火させて業務種別の選択肢を更新
    catBSelect.dispatchEvent(new Event('change'));
    // ★業務種別を選択（選択肢が更新された後に行う）
    catASelect.value = taskElement.dataset.categoryAId;

    commentInput.value = taskElement.dataset.comment;

    // ★休憩タスクの場合、カテゴリとコメントの編集を不可にする
    catBSelect.disabled = isBreakTask;
    catASelect.disabled = isBreakTask;
    commentInput.disabled = isBreakTask;

    // 既存由来(locked)は保存time優先、入力中は開始/終了差分で表示
    const isLocked = taskElement.dataset.lockedTime === '1';
    const storedTime = parseInt(taskElement.dataset.time, 10);
    if (isLocked && !Number.isNaN(storedTime) && storedTime >= 0) {
        document.getElementById('task-duration').value = storedTime;
    } else {
        updateTaskDuration();
    }

    // ボタンを編集モードに切り替え
    updateTaskFormButtons('edit');
}

/**
 * 「変更を保存」ボタンがクリックされたときの処理
 */
function handleEditTask() {
    if (!currentlyEditingTaskElement) return;

    // フォームから値を取得
    const startTime = document.getElementById('task-start-time').value;
    const endTime = document.getElementById('task-end-time').value;
    const duration = parseInt(document.getElementById('task-duration').value, 10);
    const catA_select = document.getElementById('task-category-a-select');
    const catB_select = document.getElementById('task-category-b-select');
    const categoryA_id = catA_select.value;
    const categoryA_label = catA_select.options[catA_select.selectedIndex].text;
    const categoryB_id = catB_select.value;
    const categoryB_label = catB_select.options[catB_select.selectedIndex].text;
    const comment = document.getElementById('task-comment').value;

    // Validation
    if (!startTime || !endTime || !duration || duration <= 0) {
        alert('有効な時間を選択してください。');
        return;
    }
    if (!categoryA_id || !categoryB_id) {
        alert('業務種別と集計項目の両方を選択してください。');
        return;
    }

    // ★ 重複チェックを追加 (自分自身はチェック対象から除外)
    if (checkTaskCollision(startTime, endTime, currentlyEditingTaskElement)) {
        alert('他のタスクと時間が重なっています。');
        return;
    }

    // 新しい背景色と文字色を計算
    const selectedCatB = proxyCategoryBOptions.find(opt => opt.id === categoryB_id);
    const settings = selectedCatB ? selectedCatB.category_a_settings : null;
    const taskColor = settings ? settings[categoryA_id] : null;
    const defaultBgColor = 'rgba(252, 185, 237, 0.8)'; // addProxyTimetableTaskのデフォルト色
    const newBgColor = taskColor || defaultBgColor;
    const newTextColor = isDarkColor(newBgColor) ? '#FFFFFF' : '#333333';

    // 開始行が変更された場合、DOM要素を移動
    const newStartRow = document.querySelector(`#timetable-rows tr[data-time="${startTime}"]`);
    if (!newStartRow) {
        alert('タイムテーブル上で開始時刻に対応する行が見つかりません。');
        return;
    }
    newStartRow.querySelector('.timetable-slot').appendChild(currentlyEditingTaskElement);

    // datasetを更新
    currentlyEditingTaskElement.dataset.startTime = startTime;
    currentlyEditingTaskElement.dataset.endTime = endTime;
    currentlyEditingTaskElement.dataset.time = String(duration);
    currentlyEditingTaskElement.dataset.lockedTime = '0'; // 編集後は入力中タスクとして扱う
    currentlyEditingTaskElement.dataset.categoryAId = categoryA_id;
    currentlyEditingTaskElement.dataset.categoryALabel = categoryA_label;
    currentlyEditingTaskElement.dataset.categoryBId = categoryB_id;
    currentlyEditingTaskElement.dataset.categoryBLabel = categoryB_label;
    currentlyEditingTaskElement.dataset.comment = comment;

    // 表示を更新 (高さと内容)
    const slots = duration / 15;
    const taskHeight = slots * 24;
    currentlyEditingTaskElement.style.height = `${taskHeight}px`;
    // 背景色と文字色も更新
    currentlyEditingTaskElement.style.backgroundColor = newBgColor;
    currentlyEditingTaskElement.style.color = newTextColor;

    const displayText = [categoryB_label, categoryA_label, comment].filter(Boolean).join(' / ');
    currentlyEditingTaskElement.innerHTML = `<div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHTML(displayText)}">${escapeHTML(displayText)}</div>`;

    // ★ 変更されたタスクなので、未送信を示す赤色バーに更新
    currentlyEditingTaskElement.style.borderLeftColor = '#d9534f';

    // 編集モードを終了
    clearProxyTaskDetailsForm();
    updateProxyWorkTimeSummary();
    autoSaveProxyNetReport('edit-task');
}

/**
 * 「削除」ボタンがクリックされたときの処理
 */
function handleDeleteTask() {
    if (!currentlyEditingTaskElement) return;

    if (confirm('このタスクを削除しますか？')) {
        currentlyEditingTaskElement.remove();
        currentlyEditingTaskElement = null;
        clearProxyTaskDetailsForm();
        updateProxyWorkTimeSummary();
        autoSaveProxyNetReport('delete-task');
    }
}

/**
 * Interact.js を使ってタイムテーブルのインタラクションを設定する
 * この関数は、_manager_proxy_report_net.html で Interact.js が読み込まれていることを前提とします。
 */
function setupTimetableInteractions() {
    // interact が未定義の場合は何もしない（ライブラリ未ロード対策）
    if (typeof interact === 'undefined') {
        console.warn('Interact.js is not loaded. Timetable drag & drop will not be available.');
        return;
    }

    const slotHeight = 24; // 1スロットの高さ (px)
    const formatTime = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

    interact('.timetable-task')
        // --- ドラッグ移動機能 ---
        .draggable({
            inertia: false, // ドラッグ後の慣性を無効化
            autoScroll: true, // ドラッグ中にコンテナを自動スクロール
            listeners: {
                start (event) {
                    // ドラッグ開始時にフラグを立て、クリックイベントと競合しないようにする
                    event.target.classList.add('is-dragging');
                },
                move (event) {
                    const target = event.target;
                    // Y方向の移動量のみを data-y 属性に蓄積
                    const y = (parseFloat(target.getAttribute('data-y')) || 0) + event.dy;
                    // 要素をY軸方向に移動させる
                    target.style.transform = `translateY(${y}px)`;
                    target.setAttribute('data-y', y);
                },
                end (event) {
                    const target = event.target;
                    // 少し遅延させてからドラッグフラグを解除し、クリックイベントが誤発火するのを防ぐ
                    setTimeout(() => target.classList.remove('is-dragging'), 100);

                    // Y方向の総移動量から、何スロット分移動したかを計算
                    const movedSlots = Math.round((parseFloat(target.getAttribute('data-y')) || 0) / slotHeight);

                    // スタイルと一時的な属性をリセット
                    target.style.transform = '';
                    target.removeAttribute('data-y');

                    if (movedSlots === 0) return; // 移動がなければ何もしない

                    const movedMinutes = movedSlots * 15;

                    // 元の時刻と期間から新しい時刻を計算
                    const originalStartTime = new Date(`1970-01-01T${target.dataset.startTime}`);
                    const duration = (new Date(`1970-01-01T${target.dataset.endTime}`) - originalStartTime) / 60000;

                    const newStartTime = new Date(originalStartTime.getTime() + movedMinutes * 60000);
                    const newEndTime = new Date(newStartTime.getTime() + duration * 60000);

                    const newStartTimeStr = formatTime(newStartTime);
                    const newEndTimeStr = formatTime(newEndTime);

                    // ★ 追加: 移動先の重複チェック
                    if (checkTaskCollision(newStartTimeStr, newEndTimeStr, target)) {
                        alert('移動先が他のタスクと重なっています。');
                        // 元の位置に戻す（DOM移動せず、styleのみリセットでOK）
                        return;
                    }

                    // 新しい開始位置のDOM要素を探す
                    const newStartRow = document.querySelector(`#timetable-rows tr[data-time="${newStartTimeStr}"]`);
                    if (!newStartRow) {
                        // alert('移動先の時間帯が無効です。'); // 範囲外ドロップなどで頻発するのでalertは抑制しても良い
                        return;
                    }

                    // データを更新してDOMを移動
                    target.dataset.startTime = newStartTimeStr;
                    target.dataset.endTime = newEndTimeStr;
                    target.dataset.lockedTime = '0'; // 操作後は入力中タスクとして扱う
                    newStartRow.querySelector('.timetable-slot').appendChild(target);

                    // 編集中のタスクを移動した場合、フォームの表示も更新
                    if (currentlyEditingTaskElement === target) {
                        document.getElementById('task-start-time').value = newStartTimeStr;
                        document.getElementById('task-end-time').value = newEndTimeStr;
                    }
                }
            }
        })
        // --- ★リサイズ機能を追加 ---
        .resizable({
            edges: { top: false, bottom: true }, // ★下方向のリサイズのみを有効化
            listeners: {
                start (event) {
                    // ★休憩タスクのリサイズを禁止
                    if (event.target.dataset.taskType === 'break') {
                        alert('休憩時間は変更できません。');
                        event.interaction.stop();
                        return;
                    }
                    // リサイズ開始時にもフラグを立てる
                    event.target.classList.add('is-resizing');
                },
                move (event) {
                    const target = event.target;
                    let y = parseFloat(target.getAttribute('data-y')) || 0;

                    // 高さを更新
                    target.style.height = event.rect.height + 'px';

                    // 上端をリサイズした場合、要素の位置も動かす
                    y += event.deltaRect.top;
                    target.style.transform = `translateY(${y}px)`;
                    target.setAttribute('data-y', y);
                },
                end (event) {
                    const target = event.target;
                    setTimeout(() => target.classList.remove('is-resizing'), 100);

                    // スタイルと一時的な属性をリセット
                    target.style.transform = '';
                    target.removeAttribute('data-y');

                    // 新しい高さからスロット数を計算
                    const newHeight = event.rect.height;
                    const newSlots = Math.round(newHeight / slotHeight);
                    const newDuration = newSlots * 15;

                    // 新しい開始・終了時刻を計算
                    let newStartTime, newEndTime;
                    if (event.edges.top) { // 上端をリサイズした場合
                        const originalEndTime = new Date(`1970-01-01T${target.dataset.endTime}`);
                        newEndTime = originalEndTime;
                        newStartTime = new Date(newEndTime.getTime() - newDuration * 60000);
                    } else { // 下端をリサイズした場合
                        const originalStartTime = new Date(`1970-01-01T${target.dataset.startTime}`);
                        newStartTime = originalStartTime;
                        newEndTime = new Date(newStartTime.getTime() + newDuration * 60000);
                    }

                    const newStartTimeStr = formatTime(newStartTime);
                    const newEndTimeStr = formatTime(newEndTime);

                    // ★ 追加: リサイズ後の重複チェック
                    if (checkTaskCollision(newStartTimeStr, newEndTimeStr, target)) {
                        alert('変更後の範囲が他のタスクと重なっています。');
                        // 元のサイズに戻す (datasetはまだ更新されていないので、それを使って高さを再計算)
                        const originalSlots = Math.round((new Date(`1970-01-01T${target.dataset.endTime}`) - new Date(`1970-01-01T${target.dataset.startTime}`)) / (15 * 60000));
                        target.style.height = (originalSlots * slotHeight) + 'px';
                        return;
                    }

                    // データを更新
                    target.dataset.startTime = newStartTimeStr;
                    target.dataset.endTime = newEndTimeStr;
                    target.dataset.time = String(newDuration);
                    target.dataset.lockedTime = '0'; // 操作後は入力中タスクとして扱う
                    target.style.height = (newSlots * slotHeight) + 'px'; // 最終的な高さを確定

                    // フォームとサマリーを更新
                    handleTaskClick(target); // 編集モードにしてフォームに反映
                    updateProxyWorkTimeSummary();
                }
            }
        });
}

// --- ★ここから追加: 過去日報参照機能 ---

let pastReportsCurrentEndDate = null; // 過去日報の表示期間の終了日

/** 過去日報タイムテーブルの表示時間帯（タスク位置・横線と同期） */
const PAST_REPORTS_VISIBLE_TIME = Object.freeze({
    DEFAULT_START_H: 7,
    DEFAULT_END_H: 18,
    /** 過去日報一覧（月度）モーダルの規定表示: 7:00〜20:00（終了時刻はグリッド上の 20:00 ラベルまで） */
    FISCAL_DEFAULT_START_H: 7,
    FISCAL_DEFAULT_END_H: 20,
    MIN_START_H: 5,
    MAX_END_H: 22,
});

let pastReportsVisibleStartHour = PAST_REPORTS_VISIBLE_TIME.DEFAULT_START_H;
let pastReportsVisibleEndHour = PAST_REPORTS_VISIBLE_TIME.DEFAULT_END_H;
/** 直近描画の再描画用キャッシュ（時刻幅変更ボタン用） */
let pastReportsTimetableRenderState = null;
/** 取得データの日付範囲が変わったら表示時間帯をデフォルトに戻す */
let pastReportsLastDataRangeKey = '';

/**
 * ネット月度モーダル用コメントツールチップの表示までの待ち（ms）。
 * ネイティブの title は待ち時間を短くできないため、独自ツールチップで制御する。
 * 体感では title の約半分（多くの環境で title は約1秒前後）を目安にしている。
 */
const PAST_REPORTS_COMMENT_TOOLTIP_DELAY_MS = 500;

let pastReportsCommentTooltipTimer = null;
let pastReportsCommentTooltipEl = null;

function hidePastReportsCommentTooltip() {
    if (pastReportsCommentTooltipTimer !== null) {
        clearTimeout(pastReportsCommentTooltipTimer);
        pastReportsCommentTooltipTimer = null;
    }
    if (pastReportsCommentTooltipEl && pastReportsCommentTooltipEl.parentNode) {
        pastReportsCommentTooltipEl.remove();
    }
    pastReportsCommentTooltipEl = null;
}

function positionPastReportsCommentTooltip(anchorEl, tipEl) {
    const rect = anchorEl.getBoundingClientRect();
    const margin = 8;
    let left = rect.left + rect.width / 2 - tipEl.offsetWidth / 2;
    let top = rect.bottom + margin;
    if (left < margin) left = margin;
    if (left + tipEl.offsetWidth > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - margin - tipEl.offsetWidth);
    }
    if (top + tipEl.offsetHeight > window.innerHeight - margin) {
        top = rect.top - margin - tipEl.offsetHeight;
    }
    tipEl.style.left = `${Math.round(left)}px`;
    tipEl.style.top = `${Math.round(top)}px`;
}

/**
 * @param {HTMLElement} taskBlock
 * @param {string} tooltipPlainText - textContent のみ（XSS 回避）
 */
function bindPastReportsNetFiscalCommentTooltip(taskBlock, tooltipPlainText) {
    taskBlock.removeAttribute('title');
    taskBlock.addEventListener('mouseenter', () => {
        hidePastReportsCommentTooltip();
        pastReportsCommentTooltipTimer = window.setTimeout(() => {
            pastReportsCommentTooltipTimer = null;
            const el = document.createElement('div');
            el.className = 'past-reports-comment-tooltip';
            el.setAttribute('role', 'tooltip');
            el.textContent = tooltipPlainText;
            el.style.cssText =
                'position:fixed;z-index:10050;max-width:min(420px,90vw);padding:8px 10px;' +
                'background:#333;color:#fff;font-size:12px;line-height:1.4;border-radius:4px;' +
                'box-shadow:0 2px 8px rgba(0,0,0,0.25);pointer-events:none;white-space:pre-wrap;word-break:break-word;';
            document.body.appendChild(el);
            positionPastReportsCommentTooltip(taskBlock, el);
            pastReportsCommentTooltipEl = el;
        }, PAST_REPORTS_COMMENT_TOOLTIP_DELAY_MS);
    });
    taskBlock.addEventListener('mouseleave', hidePastReportsCommentTooltip);
    taskBlock.addEventListener('click', hidePastReportsCommentTooltip);
}

function formatLocalYmd(d) {
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

function getPastReportsDataRangeKey(rangeStart, rangeEnd) {
    return `${formatLocalYmd(rangeStart)}_${formatLocalYmd(rangeEnd)}`;
}

/**
 * @param {{ defaultStartH?: number, defaultEndH?: number }} [resetHourOptions] - 省略時は週次モーダル用 DEFAULT_* を使用
 */
function maybeResetPastReportsVisibleHoursForDataRange(rangeStart, rangeEnd, resetHourOptions) {
    const key = getPastReportsDataRangeKey(rangeStart, rangeEnd);
    if (key !== pastReportsLastDataRangeKey) {
        pastReportsLastDataRangeKey = key;
        const ds = resetHourOptions && Number.isFinite(resetHourOptions.defaultStartH)
            ? resetHourOptions.defaultStartH
            : PAST_REPORTS_VISIBLE_TIME.DEFAULT_START_H;
        const de = resetHourOptions && Number.isFinite(resetHourOptions.defaultEndH)
            ? resetHourOptions.defaultEndH
            : PAST_REPORTS_VISIBLE_TIME.DEFAULT_END_H;
        pastReportsVisibleStartHour = ds;
        pastReportsVisibleEndHour = de;
    }
}

function getPastReportsVisibleTimeTotals() {
    const startMin = pastReportsVisibleStartHour * 60;
    const endMin = pastReportsVisibleEndHour * 60;
    const totalMin = endMin - startMin;
    const hourSpan = pastReportsVisibleEndHour - pastReportsVisibleStartHour;
    return { startMin, endMin, totalMin, hourSpan };
}

function parsePastReportTimeToMinutes(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    const parts = timeStr.trim().split(':');
    if (parts.length < 2) return null;
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
}

function repaintPastReportsTimetablesFromCache() {
    if (!pastReportsTimetableRenderState) return;
    const { reportsByDate, rangeStart, rangeEnd, container, taskClickHandler } = pastReportsTimetableRenderState;
    renderPastReportsTimetables(reportsByDate, rangeStart, rangeEnd, container, taskClickHandler);
}

function handlePastReportsLayoutClick(event) {
    const btn = event.target.closest('[data-past-action]');
    if (!btn || btn.disabled) return;
    const action = btn.getAttribute('data-past-action');
    let changed = false;
    if (action === 'earlier-start') {
        if (pastReportsVisibleStartHour > PAST_REPORTS_VISIBLE_TIME.MIN_START_H) {
            pastReportsVisibleStartHour -= 1;
            changed = true;
        }
    } else if (action === 'later-start') {
        // 上部「−」: 表示開始を遅くするが、既定の 7:00 より遅くはできない
        if (pastReportsVisibleStartHour < pastReportsVisibleEndHour - 1
            && pastReportsVisibleStartHour < PAST_REPORTS_VISIBLE_TIME.DEFAULT_START_H) {
            pastReportsVisibleStartHour += 1;
            changed = true;
        }
    } else if (action === 'later-end') {
        if (pastReportsVisibleEndHour < PAST_REPORTS_VISIBLE_TIME.MAX_END_H) {
            pastReportsVisibleEndHour += 1;
            changed = true;
        }
    } else if (action === 'earlier-end') {
        // 下部「−」: 表示終了を早くするが、既定の 18:00 より早くはできない
        if (pastReportsVisibleEndHour > pastReportsVisibleStartHour + 1
            && pastReportsVisibleEndHour > PAST_REPORTS_VISIBLE_TIME.DEFAULT_END_H) {
            pastReportsVisibleEndHour -= 1;
            changed = true;
        }
    }
    if (!changed) return;
    event.preventDefault();
    repaintPastReportsTimetablesFromCache();
}

function updatePastReportsRulerButtons(layout) {
    if (!layout) return;
    const es = layout.querySelector('[data-past-action="earlier-start"]');
    const ls = layout.querySelector('[data-past-action="later-start"]');
    const le = layout.querySelector('[data-past-action="later-end"]');
    const ee = layout.querySelector('[data-past-action="earlier-end"]');
    if (es) es.disabled = pastReportsVisibleStartHour <= PAST_REPORTS_VISIBLE_TIME.MIN_START_H;
    if (ls) {
        ls.disabled = pastReportsVisibleStartHour >= pastReportsVisibleEndHour - 1
            || pastReportsVisibleStartHour >= PAST_REPORTS_VISIBLE_TIME.DEFAULT_START_H;
    }
    if (le) le.disabled = pastReportsVisibleEndHour >= PAST_REPORTS_VISIBLE_TIME.MAX_END_H;
    if (ee) {
        ee.disabled = pastReportsVisibleEndHour <= pastReportsVisibleStartHour + 1
            || pastReportsVisibleEndHour <= PAST_REPORTS_VISIBLE_TIME.DEFAULT_END_H;
    }
}

/**
 * 過去日報参照モーダルを開く
 */
function openPastReportsModal() {
    const modal = document.getElementById('past-reports-modal');
    if (!modal) {
        console.error('Past reports modal not found.');
        return;
    }

    pastReportsVisibleStartHour = PAST_REPORTS_VISIBLE_TIME.DEFAULT_START_H;
    pastReportsVisibleEndHour = PAST_REPORTS_VISIBLE_TIME.DEFAULT_END_H;
    pastReportsLastDataRangeKey = '';

    // 表示期間の初期化（今日の1日前を終了日とする）
    pastReportsCurrentEndDate = new Date(currentProxyTarget.date);
    pastReportsCurrentEndDate.setDate(pastReportsCurrentEndDate.getDate() - 1);

    modal.classList.add('is-active');
    // !important を使ったCSS変更を確実に反映させるためのハック
    void modal.offsetWidth;

    fetchAndRenderPastReports();

    // ナビゲーションボタンのイベントリスナーを（再）設定
    const prevBtn = document.getElementById('past-reports-prev-btn');
    const nextBtn = document.getElementById('past-reports-next-btn');

    // 一旦リスナーを削除して重複登録を防ぐ
    prevBtn.replaceWith(prevBtn.cloneNode(true));
    nextBtn.replaceWith(nextBtn.cloneNode(true));

    document.getElementById('past-reports-prev-btn').addEventListener('click', () => {
        pastReportsCurrentEndDate.setDate(pastReportsCurrentEndDate.getDate() - 7);
        fetchAndRenderPastReports();
    });
    document.getElementById('past-reports-next-btn').addEventListener('click', () => {
        pastReportsCurrentEndDate.setDate(pastReportsCurrentEndDate.getDate() + 7);
        fetchAndRenderPastReports();
    });
}

/**
 * admin.html に配置した月度モーダルの閉じる操作を一度だけバインド
 */
function ensureNetFiscalPastReportsModalInitialized() {
    if (window.__netFiscalPastReportsModalListenersBound) return;
    const netFiscalPastModal = document.getElementById('net-fiscal-past-reports-modal');
    const netFiscalPastModalClose = document.getElementById('net-fiscal-past-reports-modal-close');
    if (!netFiscalPastModal || !netFiscalPastModalClose) return;
    window.__netFiscalPastReportsModalListenersBound = true;
    if (!window.__pastReportsFiscalTooltipScrollHideBound) {
        window.__pastReportsFiscalTooltipScrollHideBound = true;
        document.addEventListener('scroll', hidePastReportsCommentTooltip, true);
        window.addEventListener('resize', hidePastReportsCommentTooltip);
    }
    const closeNetFiscal = () => {
        hidePastReportsCommentTooltip();
        netFiscalPastModal.classList.remove('is-active');
    };
    netFiscalPastModalClose.addEventListener('click', closeNetFiscal);
    netFiscalPastModal.addEventListener('click', (e) => {
        if (e.target.classList.contains('dr-modal')) closeNetFiscal();
    });
}

/**
 * 月度（21日〜翌月20日）の過去日報一覧モーダルを開く（「一覧」ボタン）
 * 左ペイン・ナビは7日分の過去日報モーダルと同じ方式
 */
function openNetFiscalPastReportsModal() {
    ensureNetFiscalPastReportsModalInitialized();
    const ctx = getNetFiscalPastReportsTargetContext();
    if (!ctx) {
        alert('対象者が取得できません。社員IDを検索してからお試しください。');
        return;
    }

    resetNetFiscalPastTaskDetailPanel();

    const modal = document.getElementById('net-fiscal-past-reports-modal');
    if (!modal) {
        console.error('Net fiscal past reports modal not found.');
        return;
    }

    pastReportsVisibleStartHour = PAST_REPORTS_VISIBLE_TIME.FISCAL_DEFAULT_START_H;
    pastReportsVisibleEndHour = PAST_REPORTS_VISIBLE_TIME.FISCAL_DEFAULT_END_H;
    pastReportsLastDataRangeKey = '';

    resetNetFiscalPastReportsPeriodToCurrent();

    modal.classList.add('is-active');
    void modal.offsetWidth;

    fetchAndRenderNetFiscalPastReports(
        'net-fiscal-past-reports-container',
        'net-fiscal-past-reports-period-display',
        { nextButtonEl: 'net-fiscal-past-reports-next-btn' },
    );

    const prevBtn = document.getElementById('net-fiscal-past-reports-prev-btn');
    const nextBtn = document.getElementById('net-fiscal-past-reports-next-btn');
    if (prevBtn) {
        prevBtn.replaceWith(prevBtn.cloneNode(true));
        document.getElementById('net-fiscal-past-reports-prev-btn').addEventListener('click', () => {
            goNetFiscalPastReportsToPreviousPeriod();
            fetchAndRenderNetFiscalPastReports(
                'net-fiscal-past-reports-container',
                'net-fiscal-past-reports-period-display',
                { nextButtonEl: 'net-fiscal-past-reports-next-btn' },
            );
        });
    }
    if (nextBtn) {
        nextBtn.replaceWith(nextBtn.cloneNode(true));
        document.getElementById('net-fiscal-past-reports-next-btn').addEventListener('click', () => {
            goNetFiscalPastReportsToNextPeriod();
            fetchAndRenderNetFiscalPastReports(
                'net-fiscal-past-reports-container',
                'net-fiscal-past-reports-period-display',
                { nextButtonEl: 'net-fiscal-past-reports-next-btn' },
            );
        });
    }
}

/**
 * 過去日報データを取得して描画する
 */
async function fetchAndRenderPastReports() {
    const container = document.getElementById('past-reports-container');
    const periodDisplay = document.getElementById('past-reports-period-display');
    const nextBtn = document.getElementById('past-reports-next-btn');
    if (!container || !periodDisplay || !currentProxyTarget) return;

    container.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 50px 0;">読み込み中...</div>';

    const endDate = new Date(pastReportsCurrentEndDate);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 6);

    const formatDate = (d) => d.toISOString().split('T')[0];
    const startDateStr = formatDate(startDate);
    const endDateStr = formatDate(endDate);

    periodDisplay.textContent = `${startDateStr} 〜 ${endDateStr}`;

    // 終了日が今日以降になったら「未来」ボタンを無効化
    const today = new Date(currentProxyTarget.date);
    nextBtn.disabled = endDate >= today;

    try {
        // 管理者APIを優先し、権限不足時は一般APIへフォールバック
        let response = await fetchWithAuth(
            `${API_BASE_URL}/api/manager/past-reports?employee_id=${currentProxyTarget.employeeId}&start_date=${startDateStr}&end_date=${endDateStr}`,
        );
        if (!response.ok && (response.status === 401 || response.status === 403)) {
            response = await fetchWithAuth(
                `${API_BASE_URL}/api/past-reports?employee_id=${currentProxyTarget.employeeId}&start_date=${startDateStr}&end_date=${endDateStr}`,
            );
        }
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.message || '過去日報の取得に失敗しました。');
        }
        const reportsByDate = await response.json();
        const rangeStart = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
        const rangeEnd = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
        maybeResetPastReportsVisibleHoursForDataRange(rangeStart, rangeEnd);
        renderPastReportsTimetables(reportsByDate, rangeStart, rangeEnd);

    } catch (error) {
        console.error(error);
        container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 50px 0; color: red;">${error.message}</div>`;
    }
}

/**
 * 取得したデータから指定期間のタイムテーブルを描画する（過去日報モーダル／ネット月度過去日報など共通）
 * @param {Object} reportsByDate - 日付キー（YYYY-MM-DD）→ タスク配列
 * @param {Date} startDate
 * @param {Date} endDate
 * @param {HTMLElement|string|null} [containerEl] - 描画先。省略時は #past-reports-container
 * @param {function(Event):void} [taskClickHandler] - タスククリック時。省略時は過去日報モーダル用ハンドラ
 */
function renderPastReportsTimetables(reportsByDate, startDate, endDate, containerEl, taskClickHandler) {
    const container = (typeof containerEl === 'string' ? document.getElementById(containerEl) : containerEl)
        || document.getElementById('past-reports-container');
    if (!container) return;

    hidePastReportsCommentTooltip();

    const onTaskClick = typeof taskClickHandler === 'function' ? taskClickHandler : handlePastTaskClick;
    container.innerHTML = ''; // コンテナをクリア

    // APIから返されたデータが空オブジェクトの場合、メッセージを表示して終了
    if (Object.keys(reportsByDate).length === 0) {
        pastReportsTimetableRenderState = null;
        container.innerHTML = '<div style="text-align: center; padding: 50px 0; color: #666;">この期間に記録された日報はありません。</div>';
        return;
    }

    const rangeStart = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const rangeEnd = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    const { startMin, endMin, totalMin, hourSpan } = getPastReportsVisibleTimeTotals();
    if (totalMin <= 0) {
        pastReportsTimetableRenderState = null;
        container.innerHTML = '<div style="text-align: center; padding: 50px 0; color: #c00;">表示時間帯の設定が不正です。</div>';
        return;
    }
    if (rangeStart.getTime() > rangeEnd.getTime()) {
        pastReportsTimetableRenderState = null;
        container.innerHTML = '<div style="text-align: center; padding: 50px 0; color: #c00;">表示期間が不正です。</div>';
        return;
    }

    const days = ['日', '月', '火', '水', '木', '金', '土'];

    const layout = document.createElement('div');
    layout.className = 'past-reports-layout';

    const rulerColumn = document.createElement('div');
    rulerColumn.className = 'past-day-column past-reports-ruler-column';
    rulerColumn.innerHTML = `
        <div class="past-day-header">時刻</div>
        <div class="past-timetable-strip">
            <button type="button" class="past-ruler-btn" data-past-action="earlier-start" title="表示開始を1時間早く（最大${PAST_REPORTS_VISIBLE_TIME.MIN_START_H}:00）">+</button>
            <button type="button" class="past-ruler-btn" data-past-action="later-start" title="表示開始を1時間遅く（${PAST_REPORTS_VISIBLE_TIME.DEFAULT_START_H}:00まで）">−</button>
        </div>
        <div class="past-day-timetable past-ruler-timetable"></div>
        <div class="past-timetable-strip">
            <button type="button" class="past-ruler-btn" data-past-action="later-end" title="表示終了を1時間遅く（最大${PAST_REPORTS_VISIBLE_TIME.MAX_END_H}:00）">+</button>
            <button type="button" class="past-ruler-btn" data-past-action="earlier-end" title="表示終了を1時間早く（${PAST_REPORTS_VISIBLE_TIME.DEFAULT_END_H}:00まで）">−</button>
        </div>
    `;
    const rulerTimetable = rulerColumn.querySelector('.past-ruler-timetable');
    rulerTimetable.style.setProperty('--past-hour-span', String(hourSpan));
    for (let h = pastReportsVisibleStartHour; h <= pastReportsVisibleEndHour; h += 1) {
        const label = document.createElement('div');
        label.className = 'past-ruler-hour-label';
        label.textContent = `${h}:00`;
        const pct = ((h * 60 - startMin) / totalMin) * 100;
        if (h === pastReportsVisibleStartHour) {
            label.classList.add('is-first');
        } else if (h === pastReportsVisibleEndHour) {
            label.classList.add('is-last');
        } else {
            label.classList.add('is-mid');
            label.style.top = `${pct}%`;
        }
        rulerTimetable.appendChild(label);
    }

    const daysWrap = document.createElement('div');
    daysWrap.className = 'past-reports-days-wrap';
    const gridInner = document.createElement('div');
    gridInner.className = 'past-reports-grid-inner';
    const isNetFiscalMonthlyView = !!(container && container.id === 'net-fiscal-past-reports-container');
    if (isNetFiscalMonthlyView) {
        gridInner.classList.add('past-reports-grid-inner--fiscal');
    }

    let dayCount = 0;
    for (let d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) {
        dayCount += 1;
        const dateStr = formatLocalYmd(d);
        const dayOfWeek = days[d.getDay()];
        const reports = reportsByDate[dateStr] || [];

        const column = document.createElement('div');
        column.className = 'past-day-column';

        let headerClass = '';
        if (d.getDay() === 0) headerClass = 'sunday';
        if (d.getDay() === 6) headerClass = 'saturday';

        const dateOnlyLabel = dateStr.substring(5).replace('-', '/');
        const headerText = isNetFiscalMonthlyView
            ? dateOnlyLabel
            : `${dateOnlyLabel} (${dayOfWeek})`;

        column.innerHTML = `
            <div class="past-day-header ${headerClass}">
                ${headerText}
            </div>
            <div class="past-timetable-strip past-day-spacer-strip">&nbsp;</div>
            <div class="past-day-timetable"></div>
            <div class="past-timetable-strip past-day-spacer-strip">&nbsp;</div>
        `;

        const headerEl = column.querySelector('.past-day-header');
        if (isNetFiscalMonthlyView && headerEl) {
            headerEl.classList.add('past-day-header--nav');
            headerEl.title = 'この日の日報入力画面を開く';
            headerEl.dataset.pastNavDate = dateStr;
            headerEl.setAttribute('role', 'button');
            headerEl.setAttribute('tabindex', '0');
            const goToProxyInputForPastNavDate = (e) => {
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                const navCtx = getNetFiscalPastReportsTargetContext();
                if (!navCtx || !navCtx.employeeId) return;
                hidePastReportsCommentTooltip();
                const fiscalModal = document.getElementById('net-fiscal-past-reports-modal');
                if (fiscalModal) fiscalModal.classList.remove('is-active');
                const openOpts = navCtx.returnTarget ? { returnTarget: navCtx.returnTarget } : undefined;
                void openProxyReport(
                    String(navCtx.employeeId),
                    navCtx.name || '',
                    dateStr,
                    navCtx.groupId != null ? String(navCtx.groupId) : '3',
                    openOpts,
                );
            };
            headerEl.addEventListener('click', goToProxyInputForPastNavDate);
            headerEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    goToProxyInputForPastNavDate(e);
                }
            });
        }

        const timetableEl = column.querySelector('.past-day-timetable');
        timetableEl.style.setProperty('--past-hour-span', String(hourSpan));

        reports.forEach((task) => {
            if (!task.startTime || !task.endTime || task.categoryA_id === 'N99') return;

            const taskStartMin = parsePastReportTimeToMinutes(task.startTime);
            const taskEndMin = parsePastReportTimeToMinutes(task.endTime);
            if (taskStartMin === null || taskEndMin === null) return;
            const duration = taskEndMin - taskStartMin;
            if (duration <= 0) return;

            const clipStart = Math.max(taskStartMin, startMin);
            const clipEnd = Math.min(taskEndMin, endMin);
            if (clipEnd <= clipStart) return;

            const top = ((clipStart - startMin) / totalMin) * 100;
            const height = ((clipEnd - clipStart) / totalMin) * 100;

            const taskBlock = document.createElement('div');
            taskBlock.className = 'past-task-block';
            taskBlock.style.top = `${top}%`;
            taskBlock.style.height = `${height}%`;

            const catBData = proxyCategoryBOptions.find((opt) => String(opt.id) === String(task.categoryB_id));
            const settings = catBData ? catBData.category_a_settings : null;
            const aId = task.categoryA_id;
            const taskColor = settings
                ? (settings[aId] ?? settings[String(aId)])
                : null;
            const bgColor = taskColor || '#e0e0e0';
            taskBlock.style.backgroundColor = bgColor;
            taskBlock.style.color = isDarkColor(bgColor) ? '#fff' : '#333';

            const commentRaw = task.comment != null ? String(task.comment) : '';
            const commentTrimmed = commentRaw.trim();
            const displayText = [task.comment, task.categoryB_label, task.categoryA_label].filter(Boolean).join(' / ');
            if (isNetFiscalMonthlyView) {
                taskBlock.textContent = commentTrimmed;
                taskBlock.style.overflow = 'hidden';
                taskBlock.style.textOverflow = 'ellipsis';
                taskBlock.style.whiteSpace = 'nowrap';
                bindPastReportsNetFiscalCommentTooltip(
                    taskBlock,
                    commentRaw ? commentRaw : '（コメントなし）',
                );
            } else {
                taskBlock.textContent = displayText;
                taskBlock.title = displayText;
            }

            taskBlock.dataset.categoryBId = task.categoryB_id;
            taskBlock.dataset.categoryAId = task.categoryA_id;
            taskBlock.dataset.comment = task.comment || '';
            taskBlock.dataset.categoryBLabel = task.categoryB_label != null ? String(task.categoryB_label) : '';
            taskBlock.dataset.categoryALabel = task.categoryA_label != null ? String(task.categoryA_label) : '';
            taskBlock.dataset.taskBgColor = bgColor;

            taskBlock.addEventListener('click', onTaskClick);
            timetableEl.appendChild(taskBlock);
        });

        gridInner.appendChild(column);
    }

    if (dayCount === 0) {
        pastReportsTimetableRenderState = null;
        container.innerHTML = '<div style="text-align: center; padding: 50px 0; color: #666;">表示する日がありません。</div>';
        return;
    }

    /* 日付列の横並びは CSS（.past-reports-grid-inner の flex）で固定。列数は子要素数で決まる */
    gridInner.style.display = 'flex';
    gridInner.style.flexDirection = 'row';
    gridInner.style.flexWrap = 'nowrap';
    daysWrap.appendChild(gridInner);

    layout.appendChild(rulerColumn);
    layout.appendChild(daysWrap);
    container.appendChild(layout);

    layout.addEventListener('click', handlePastReportsLayoutClick);
    updatePastReportsRulerButtons(layout);

    pastReportsTimetableRenderState = {
        reportsByDate,
        rangeStart,
        rangeEnd,
        container,
        taskClickHandler: onTaskClick,
    };
}

/**
 * 過去日報タスクの内容を日報入力フォームへ反映する（モーダル開閉は別）
 */
function applyPastTaskSelectionToProxyForm(taskBlock) {
    if (!taskBlock) return;
    const { categoryBId, categoryAId, comment } = taskBlock.dataset;

    if (!categoryBId || !categoryAId) return;

    const catBSelect = document.getElementById('task-category-b-select');
    const catASelect = document.getElementById('task-category-a-select');
    const commentInput = document.getElementById('task-comment');
    if (!catBSelect || !catASelect) return;

    // 集計項目を選択
    catBSelect.value = categoryBId;
    // changeイベントを発火させて業務種別の選択肢を更新
    catBSelect.dispatchEvent(new Event('change'));
    // 業務種別を選択
    catASelect.value = categoryAId;

    // コメントを追記する
    if (comment && commentInput) {
        const current = commentInput.value || '';
        commentInput.value = current ? current + '\n' + comment : comment;
    }
}

/**
 * 過去日報のタスクをクリックした際の処理
 */
function handlePastTaskClick(event) {
    applyPastTaskSelectionToProxyForm(event.currentTarget);
    // モーダルを閉じる
    const modal = document.getElementById('past-reports-modal');
    if (modal) modal.classList.remove('is-active');
}

/**
 * ネット事業部「月度（21日〜翌月20日）」過去日報モーダル専用: 下部パネルに集計項目・業務種別・コメントを表示
 */
function handleNetFiscalModalTaskDetailClick(event) {
    event.stopPropagation();
    const el = event.currentTarget;
    const catB = el.dataset.categoryBLabel || '';
    const catA = el.dataset.categoryALabel || '';
    const cmt = el.dataset.comment || '';
    const taskBg = el.dataset.taskBgColor || '';
    updateNetFiscalPastTaskDetailPanel(catB, catA, cmt, taskBg);
}

/**
 * 月度モーダル下部の詳細パネルを初期状態に戻す
 */
function resetNetFiscalPastTaskDetailPanel() {
    const ph = document.getElementById('net-fiscal-past-task-detail-placeholder');
    const body = document.getElementById('net-fiscal-past-task-detail-body');
    const elB = document.getElementById('net-fiscal-detail-cat-b');
    const elA = document.getElementById('net-fiscal-detail-cat-a');
    const elC = document.getElementById('net-fiscal-detail-comment');
    const swatch = document.getElementById('net-fiscal-detail-task-swatch');
    if (ph) {
        ph.style.display = '';
        ph.textContent = 'タイムテーブル内のタスクをクリックすると、ここに詳細が表示されます。';
    }
    if (body) body.style.display = 'none';
    if (elB) elB.textContent = '';
    if (elA) elA.textContent = '';
    if (elC) elC.textContent = '';
    if (swatch) swatch.style.backgroundColor = '';
}

/**
 * 月度モーダル下部にタスク詳細を表示（textContent のみで XSS 回避）
 * @param {string} taskBgColor - タイムテーブル上のタスク背景色（描画時に dataset と同値）
 */
function updateNetFiscalPastTaskDetailPanel(categoryBLabel, categoryALabel, comment, taskBgColor) {
    const ph = document.getElementById('net-fiscal-past-task-detail-placeholder');
    const body = document.getElementById('net-fiscal-past-task-detail-body');
    const elB = document.getElementById('net-fiscal-detail-cat-b');
    const elA = document.getElementById('net-fiscal-detail-cat-a');
    const elC = document.getElementById('net-fiscal-detail-comment');
    const swatch = document.getElementById('net-fiscal-detail-task-swatch');
    if (!body || !elB || !elA || !elC) return;
    if (ph) ph.style.display = 'none';
    body.style.display = 'block';
    elB.textContent = categoryBLabel.trim() ? categoryBLabel : '（なし）';
    elA.textContent = categoryALabel.trim() ? categoryALabel : '（なし）';
    elC.textContent = comment.trim() ? comment : '（なし）';
    if (swatch) {
        const c = taskBgColor && String(taskBgColor).trim() ? String(taskBgColor).trim() : '#e0e0e0';
        swatch.style.backgroundColor = c;
    }
}

// --- ★ネット事業部: 月度（21日〜翌月20日）の過去日報表示（UI配置は別途） ---

/** 締め日（翌月側の末日） */
const NET_FISCAL_PAST_REPORTS_CLOSING_DAY = 20;
/** 月度の開始日（当月側） */
const NET_FISCAL_PAST_REPORTS_OPENING_DAY = 21;

/** 現在表示中の「締め日」（常に当月度ブロックの20日）。前月ボタンで1ヶ月戻す */
let netFiscalPastReportsClosingEndDate = null;

/**
 * YYYY-MM-DD をローカル日付として解釈（UTCずれ防止）
 */
function parseProxyYmdToLocalDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return new Date();
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return new Date(dateStr);
    const [y, m, d] = parts;
    return new Date(y, m - 1, d);
}

/**
 * 基準日が属する「21日〜翌月20日」月度の締め日（20日）を返す
 * @param {Date} refDate
 * @returns {Date}
 */
function getNetFiscalPastReportsClosingEndForDate(refDate) {
    const y = refDate.getFullYear();
    const m = refDate.getMonth();
    const day = refDate.getDate();
    let endY;
    let endM;
    if (day >= NET_FISCAL_PAST_REPORTS_OPENING_DAY) {
        endM = m + 1;
        endY = y + Math.floor(endM / 12);
        endM = endM % 12;
    } else {
        endY = y;
        endM = m;
    }
    return new Date(endY, endM, NET_FISCAL_PAST_REPORTS_CLOSING_DAY);
}

/**
 * 締め日（20日）から月度の開始日（前月21日）を返す
 * @param {Date} closingEndDate
 * @returns {Date}
 */
function getNetFiscalPastReportsStartFromClosingEnd(closingEndDate) {
    const y = closingEndDate.getFullYear();
    const m = closingEndDate.getMonth();
    return new Date(y, m - 1, NET_FISCAL_PAST_REPORTS_OPENING_DAY);
}

/**
 * 締め日を1ヶ月前／後にずらす（日は常に20日）
 * @param {Date} closingEndDate
 * @param {number} deltaMonths - 負数で前月
 */
function shiftNetFiscalPastReportsClosingEnd(closingEndDate, deltaMonths) {
    const y = closingEndDate.getFullYear();
    const m = closingEndDate.getMonth();
    return new Date(y, m + deltaMonths, NET_FISCAL_PAST_REPORTS_CLOSING_DAY);
}

/**
 * 月度過去日報APIに用いる対象者・基準日（代理入力中は currentProxy 優先、日報_個別（ネット）カレンダーでは検索済み社員）
 * @returns {{ employeeId: string, name: string, date: string, groupId?: string, returnTarget?: string }|null}
 */
function getNetFiscalPastReportsTargetContext() {
    const activeTarget = document.querySelector('.nav-item.active')?.dataset?.target;
    const isStaffCalendarNetView = activeTarget === 'staff_calendar_net';

    // 日報_個別（ネット）画面では、現在表示中の社員を必ず優先する
    if (isStaffCalendarNetView && dashboardListMode === 'net' && currentCalendarEmployeeId) {
        const selectedStaff = staffList.find((s) => String(s.employeeId) === String(currentCalendarEmployeeId));
        const cm = currentCalendarReportMonth || new Date();
        const y = cm.getUTCFullYear();
        const m = cm.getUTCMonth();
        const refDateStr = `${y}-${String(m + 1).padStart(2, '0')}-15`;
        return {
            employeeId: currentCalendarEmployeeId,
            name: selectedStaff ? selectedStaff.name : '',
            date: refDateStr,
            groupId: selectedStaff != null && selectedStaff.groupId != null ? String(selectedStaff.groupId) : '3',
            returnTarget: 'staff_calendar_net',
        };
    }
    if (currentProxyTarget && currentProxyTarget.employeeId && currentProxyTarget.date) {
        return currentProxyTarget;
    }
    return null;
}

/**
 * 基準日を元に、当月度（21〜20）の締め日へ状態をリセット
 */
function resetNetFiscalPastReportsPeriodToCurrent() {
    const ctx = getNetFiscalPastReportsTargetContext();
    if (!ctx || !ctx.date) {
        netFiscalPastReportsClosingEndDate = getNetFiscalPastReportsClosingEndForDate(new Date());
        return;
    }
    const ref = parseProxyYmdToLocalDate(ctx.date);
    netFiscalPastReportsClosingEndDate = getNetFiscalPastReportsClosingEndForDate(ref);
}

/**
 * 表示月度を1つ前（前の21日〜20日ブロック）にずらす
 */
function goNetFiscalPastReportsToPreviousPeriod() {
    if (!netFiscalPastReportsClosingEndDate) {
        resetNetFiscalPastReportsPeriodToCurrent();
    }
    netFiscalPastReportsClosingEndDate = shiftNetFiscalPastReportsClosingEnd(netFiscalPastReportsClosingEndDate, -1);
}

/**
 * 現在の netFiscalPastReportsClosingEndDate に対応する表示用ラベル・日付文字列
 * @returns {{ startDate: Date, endDate: Date, startDateStr: string, endDateStr: string, label: string }}
 */
function getNetFiscalPastReportsCurrentRange() {
    if (!netFiscalPastReportsClosingEndDate) {
        resetNetFiscalPastReportsPeriodToCurrent();
    }
    const endDate = new Date(netFiscalPastReportsClosingEndDate);
    const startDate = getNetFiscalPastReportsStartFromClosingEnd(endDate);
    const toYmd = (d) => {
        const yy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yy}-${mm}-${dd}`;
    };
    const startDateStr = toYmd(startDate);
    const endDateStr = toYmd(endDate);
    return {
        startDate,
        endDate,
        startDateStr,
        endDateStr,
        label: `${startDateStr} 〜 ${endDateStr}`,
    };
}

/**
 * 基準日の月度ブロックが「現在の作業日（プロキシ日付）」と同じか（次月ボタン無効化などに利用可）
 */
function isNetFiscalPastReportsAtCurrentTargetPeriod() {
    const ctx = getNetFiscalPastReportsTargetContext();
    if (!ctx || !ctx.date || !netFiscalPastReportsClosingEndDate) return false;
    const ref = parseProxyYmdToLocalDate(ctx.date);
    const currentClosing = getNetFiscalPastReportsClosingEndForDate(ref);
    return (
        currentClosing.getFullYear() === netFiscalPastReportsClosingEndDate.getFullYear()
        && currentClosing.getMonth() === netFiscalPastReportsClosingEndDate.getMonth()
        && currentClosing.getDate() === netFiscalPastReportsClosingEndDate.getDate()
    );
}

/**
 * ネット事業部用: 月度（21日〜翌月20日）の過去日報を取得し、指定コンテナに描画する。
 * 表示場所の要素が決まったら container を渡して呼び出す。
 *
 * @param {HTMLElement|string} containerEl - 描画先
 * @param {HTMLElement|string|null} [periodDisplayEl] - 期間表示用（省略可）
 * @param {{ nextButtonEl?: HTMLElement|string|null }} [options] - nextButtonEl があれば「現在の作業月度」まで来たら無効化
 */
async function fetchAndRenderNetFiscalPastReports(containerEl, periodDisplayEl, options) {
    const container = typeof containerEl === 'string' ? document.getElementById(containerEl) : containerEl;
    const ctx = getNetFiscalPastReportsTargetContext();
    if (!container || !ctx) return;

    const categoryKind = ctx.groupId && String(ctx.groupId) === '3' ? 'net' : 'engineering';
    await ensureProxyCategoryBOptionsForPastReports(categoryKind);

    resetNetFiscalPastTaskDetailPanel();

    const periodEl = periodDisplayEl
        ? (typeof periodDisplayEl === 'string' ? document.getElementById(periodDisplayEl) : periodDisplayEl)
        : null;
    const nextBtn = options && options.nextButtonEl
        ? (typeof options.nextButtonEl === 'string' ? document.getElementById(options.nextButtonEl) : options.nextButtonEl)
        : null;

    if (!netFiscalPastReportsClosingEndDate) {
        resetNetFiscalPastReportsPeriodToCurrent();
    }

    const range = getNetFiscalPastReportsCurrentRange();
    if (periodEl) {
        periodEl.textContent = range.label;
    }
    if (nextBtn) {
        nextBtn.disabled = isNetFiscalPastReportsAtCurrentTargetPeriod();
    }

    container.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 50px 0;">読み込み中...</div>';

    try {
        let response = await fetchWithAuth(
            `${API_BASE_URL}/api/manager/past-reports?employee_id=${ctx.employeeId}&start_date=${range.startDateStr}&end_date=${range.endDateStr}`,
        );
        if (!response.ok && (response.status === 401 || response.status === 403)) {
            response = await fetchWithAuth(
                `${API_BASE_URL}/api/past-reports?employee_id=${ctx.employeeId}&start_date=${range.startDateStr}&end_date=${range.endDateStr}`,
            );
        }
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.message || '過去日報の取得に失敗しました。');
        }
        const reportsByDate = await response.json();
        const rs = new Date(range.startDate.getFullYear(), range.startDate.getMonth(), range.startDate.getDate());
        const re = new Date(range.endDate.getFullYear(), range.endDate.getMonth(), range.endDate.getDate());
        maybeResetPastReportsVisibleHoursForDataRange(rs, re, {
            defaultStartH: PAST_REPORTS_VISIBLE_TIME.FISCAL_DEFAULT_START_H,
            defaultEndH: PAST_REPORTS_VISIBLE_TIME.FISCAL_DEFAULT_END_H,
        });
        renderPastReportsTimetables(
            reportsByDate,
            rs,
            re,
            container,
            handleNetFiscalModalTaskDetailClick,
        );
    } catch (error) {
        console.error(error);
        resetNetFiscalPastTaskDetailPanel();
        container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 50px 0; color: red;">${error.message}</div>`;
    }
}

/**
 * 次の月度（21〜20）へ（現在の作業日が属する月度を上限とする想定で next ボタンと併用）
 */
function goNetFiscalPastReportsToNextPeriod() {
    if (!netFiscalPastReportsClosingEndDate) {
        resetNetFiscalPastReportsPeriodToCurrent();
        return;
    }
    const ctx = getNetFiscalPastReportsTargetContext();
    const ref = ctx && ctx.date
        ? parseProxyYmdToLocalDate(ctx.date)
        : new Date();
    const maxClosing = getNetFiscalPastReportsClosingEndForDate(ref);
    const candidate = shiftNetFiscalPastReportsClosingEnd(netFiscalPastReportsClosingEndDate, 1);
    if (candidate > maxClosing) return;
    netFiscalPastReportsClosingEndDate = candidate;
}

// --- ★ここまで: 過去日報参照機能 ---
