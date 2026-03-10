// --- 設定 ---
const LIFF_ID = "2008638177-G9M9XKOd";
const API_BASE_URL = "https://dailyreport-service-1088643883290.asia-northeast1.run.app";

/**
 * ログイン状態を確認し、有効なIDトークンを取得する。
 * 取得できない場合は例外をスローする。
 * @returns {Promise<string>} 取得したIDトークン
 */
async function getVerifiedIdToken() {
    if (!liff.isLoggedIn()) {
        throw new Error("ログインしていません。処理を中断しました。");
    }
    const idToken = await liff.getIDToken();
    // idTokenがnullだった場合、デバッグ情報を追加してエラーをスローする
    if (!idToken) {
        throw new Error("IDトークンの取得に失敗しました。再度お試しください。");
    }
    return idToken;
}

/**
 * 認証情報付きでAPIにリクエストを送信するfetchのラッパー関数
 * @param {string} url リクエストURL
 * @param {object} options fetchのオプション
 * @returns {Promise<Response>} fetchのレスポンス
 */
async function fetchWithAuth(url, options = {}) {
    // この関数内で再度トークンを取得・検証する
    const idToken = await getVerifiedIdToken();

    const headers = {
        ...options.headers,
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
    };
    return fetch(url, { ...options, headers });
}

// ID登録フォームの送信処理
async function handleRegisterSubmit(e) {
    if (e) e.preventDefault();

    const registerButton = document.getElementById('register-button');
    const messageDiv = document.getElementById('register-message');
    const employeeId = document.getElementById('employee-id').value;
    const form = document.getElementById('register-form');

    registerButton.disabled = true;
    messageDiv.className = 'message';
    messageDiv.textContent = "IDを検証中...";

    try {
        // ステップ1: IDを検証して名前を取得
        const verifyResponse = await fetchWithAuth(`${API_BASE_URL}/api/verify-employee`, {
            method: 'POST',
            body: JSON.stringify({ employeeId })
        });

        if (!verifyResponse.ok) {
            const errorData = await verifyResponse.json().catch(() => null);
            const errorMessage = errorData?.message || `IDの検証に失敗しました (コード: ${verifyResponse.status})`;
            throw new Error(errorMessage);
        }

        const verifyResult = await verifyResponse.json();
        const { name } = verifyResult;

        // ステップ2: ユーザーに確認を求める
        form.style.display = 'none'; // 元のフォームを非表示
        messageDiv.innerHTML = `
            <p>「${name}」さん、ID「${employeeId}」で登録します。よろしいですか？</p>
            <button id="confirm-ok">OK</button>
            <button id="confirm-cancel" style="background-color: #777; margin-top: 0.5em;">キャンセル</button>
        `;

        document.getElementById('confirm-ok').onclick = async () => {
            await proceedWithRegistration(employeeId);
        };

        document.getElementById('confirm-cancel').onclick = () => {
            form.style.display = 'block';
            messageDiv.innerHTML = '';
            registerButton.disabled = false;
        };

    } catch (error) {
        console.error('Verification failed:', error);
        messageDiv.textContent = `エラー: ${error.message}`;
        messageDiv.className = 'message error';
        registerButton.disabled = false;
    }
}

// 確認後、実際の登録処理を実行する関数
async function proceedWithRegistration(employeeId) {
    const messageDiv = document.getElementById('register-message');
    messageDiv.className = 'message';
    messageDiv.textContent = "登録処理を実行中...";

    try {
        // ステップ3: 実際の登録処理
        const response = await fetchWithAuth(`${API_BASE_URL}/api/register`, {
            method: 'POST',
            body: JSON.stringify({ employeeId })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            const errorMessage = errorData?.description || errorData?.message || `サーバーエラーが発生しました (コード: ${response.status})`;
            throw new Error(errorMessage);
        }

        const result = await response.json();
        if (result.status === 'created') {
            messageDiv.textContent = `社員ID「${result.employeeId}」を新規登録しました！このウィンドウを閉じてください。`;
        } else if (result.status === 'updated') {
            messageDiv.textContent = `社員IDを「${result.employeeId}」に更新しました！このウィンドウを閉じてください。`;
        } else if (result.status === 'no_change') {
            messageDiv.textContent = `社員ID「${result.employeeId}」は既に登録済みです。変更はありません。`;
        }
        messageDiv.className = 'message success';

    } catch (error) {
        console.error('Registration failed:', error);
        messageDiv.textContent = `エラー: ${error.message}`;
        messageDiv.className = 'message error';
        // エラー発生時はリセット
        document.getElementById('register-form').style.display = 'block';
        document.getElementById('register-button').disabled = false;
    }
}


// --- 動的な工数入力UIの管理 ---
let taskCounter = 0;
let categoryAOptions = []; // 大分類の候補を保持する配列
let categoryBOptions = []; // 小分類の候補を保持する配列
let lastDeletedTask = null; // 直前に削除されたタスクを保持する変数

/**
 * 新しいタスク入力行を追加する
 * @param {{categoryA: string, categoryB: string, time: number}|null} task - (オプション) 初期表示するタスクデータ
 */
function addTaskEntry(task = null) {
    taskCounter++;
    const container = document.getElementById('task-entries-container');
    const entryDiv = document.createElement('div');
    entryDiv.className = 'task-entry';
    entryDiv.id = `task-entry-${taskCounter}`;
    entryDiv.style.display = 'flex';
    entryDiv.style.alignItems = 'center';
    entryDiv.style.gap = '5px'; // ボタン間のスペースを少し詰める
    entryDiv.style.marginBottom = '10px';

    entryDiv.innerHTML = `
        <input type="text" class="task-category-major" placeholder="大分類を選択" style="flex-grow: 1.5;" required readonly>
        <input type="text" class="task-category-minor" placeholder="小分類を選択" style="flex-grow: 1;" required readonly>
        <input type="number" class="task-time time-input" inputmode="numeric" required>
        <button type="button" class="remove-task-button">－</button>
    `;

    container.appendChild(entryDiv);

    const majorInput = entryDiv.querySelector('.task-category-major');
    const minorInput = entryDiv.querySelector('.task-category-minor');
    const timeInput = entryDiv.querySelector('.task-time');

    // 初期データがあれば設定する
    if (task) {
        majorInput.value = task.categoryA || '';
        minorInput.value = task.categoryB || '';
        timeInput.value = task.time || '';
    }

    // イベントリスナーを新しい要素に設定
    entryDiv.querySelector('.task-time').addEventListener('input', updateWorkTimeSummary);
    entryDiv.querySelector('.remove-task-button').addEventListener('click', (e) => {
        const entryToRemove = e.currentTarget.closest('.task-entry');
        
        // 削除する前に行のデータを保存
        lastDeletedTask = {
            categoryA: entryToRemove.querySelector('.task-category-major').value,
            categoryB: entryToRemove.querySelector('.task-category-minor').value,
            time: entryToRemove.querySelector('.task-time').value
        };

        // 行を削除
        entryToRemove.remove();
        updateWorkTimeSummary();
    });

    // --- 入力欄クリックで選択モーダルを表示 ---
    majorInput.addEventListener('click', async () => {
        try {
            const selectedValue = await showSelectionModal('大分類を選択', categoryAOptions);
            majorInput.value = selectedValue;
            updateWorkTimeSummary(); // 選択後にもサマリーを更新
        } catch (error) { /* キャンセル時は何もしない */ }
    });
    minorInput.addEventListener('click', async () => {
        try {
            const selectedValue = await showSelectionModal('小分類を選択', categoryBOptions);
            minorInput.value = selectedValue;
            updateWorkTimeSummary(); // 選択後にもサマリーを更新
        } catch (error) { /* キャンセル時は何もしない */ }
    });
}

/** 時間のサマリーを更新する */
function updateWorkTimeSummary() {
    const totalWorkTimeInput = document.getElementById('report-work');
    const totalMinutes = parseInt(totalWorkTimeInput.value, 10) || 0;

    let allocatedMinutes = 0;
    document.querySelectorAll('.task-time').forEach(input => {
        allocatedMinutes += parseInt(input.value, 10) || 0;
    });

    const remainingMinutes = totalMinutes - allocatedMinutes;

    // 表示を更新
    document.getElementById('total-work-time-display').textContent = totalMinutes;
    document.getElementById('allocated-time-display').textContent = allocatedMinutes;
    const remainingTimeDisplay = document.getElementById('remaining-time-display');
    remainingTimeDisplay.textContent = remainingMinutes;

    // 残り時間に応じて色と送信ボタンの状態を変更
    const submitButton = document.getElementById('submit-button');

    // 1行でも完成しているタスク（大分類・小分類・時間がすべて入力済み）があるかチェック
    const isAnyTaskComplete = Array.from(document.querySelectorAll('.task-entry')).some(entry => {
        const majorCategory = entry.querySelector('.task-category-major').value;
        const minorCategory = entry.querySelector('.task-category-minor').value;
        const time = parseInt(entry.querySelector('.task-time').value, 10) || 0;
        return majorCategory && minorCategory && time > 0;
    });

    // 条件に応じて送信ボタンの活性/不活性を切り替え (allocatedMinutes > 0 のチェックを追加)
    submitButton.disabled = !(isAnyTaskComplete && allocatedMinutes > 0);

    // 残り時間の色分け
    // allocatedMinutes > 0 の条件を追加し、何も入力していないときは赤にならないようにする
    if (remainingMinutes === 0 && allocatedMinutes > 0) {
        remainingTimeDisplay.style.color = '#00B900'; // 緑
    } else {
        remainingTimeDisplay.style.color = '#d9534f'; // 赤
    }
}

/**
 * 工数入力エリアを初期化し、既存のタスクデータを表示する
 * @param {Array} existingTasks - (オプション) 表示する既存のタスクデータの配列
 */
function initializeTaskArea(existingTasks = []) {
    // 既存のタスクをクリア
    document.getElementById('task-entries-container').innerHTML = '';
    taskCounter = 0;

    if (existingTasks && existingTasks.length > 0) {
        existingTasks.forEach(task => addTaskEntry(task));
    } else {
        // 既存のタスクがなければ、空の行を1つ追加
        addTaskEntry();
    }

    // 初期サマリーを計算
    updateWorkTimeSummary();
}

/**
 * 指定された日付の勤務時間をサーバーから取得するヘルパー関数
 * @param {string} date - "YYYY-MM-DD" 形式の日付文字列
 * @returns {Promise<{success: boolean, workTime?: number, error?: string}>} 取得結果
 */
async function fetchWorkTime(date) {
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/work-time?date=${date}`);
        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            const errorMessage = errorData?.message || `勤務時間の取得に失敗しました (コード: ${response.status})`;
            return { success: false, error: errorMessage };
        }
        const result = await response.json();
        return { success: true, workTime: result.workTime || 0 };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * 指定された日付の既存の工数報告詳細を取得するヘルパー関数
 * @param {string} date - "YYYY-MM-DD" 形式の日付文字列
 * @returns {Promise<{tasks: Array}>} 取得結果
 */
async function fetchReportDetails(date) {
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/report-details?date=${date}`);
        if (!response.ok) {
            // エラーでも処理を続行するため、空のデータを返す
            return { tasks: [] };
        }
        return await response.json();
    } catch (error) {
        console.error("既存の工数報告の取得に失敗しました:", error);
        return { tasks: [] };
    }
}

/**
 * 大分類・小分類の候補をサーバーから取得し、datalistに設定する
 */
async function setupCategoryDatalists() {
    try {
        const [responseA, responseB] = await Promise.all([
            fetchWithAuth(`${API_BASE_URL}/api/categories/category_a`),
            fetchWithAuth(`${API_BASE_URL}/api/categories/category_b`)
        ]);

        if (responseA.ok) {
            const categories = await responseA.json();
            // labelプロパティを持つオブジェクトの配列から、ラベル文字列の配列を生成
            categoryAOptions = categories.map(cat => cat.label);
        }
        if (responseB.ok) {
            const categories = await responseB.json();
            categoryBOptions = categories.map(cat => cat.label);
        }
    } catch (error) {
        console.error("カテゴリ候補の取得に失敗しました:", error);
    }
}

/**
 * 選択肢のモーダルを表示し、ユーザーの選択を待つPromiseを返す
 * @param {string} title モーダルのタイトル
 * @param {string[]} options 選択肢の文字列配列
 * @returns {Promise<string>} ユーザーが選択した値
 */
function showSelectionModal(title, options) {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('selection-modal');
        const modalTitle = document.getElementById('selection-modal-title');
        const optionsContainer = document.getElementById('selection-modal-options');

        modalTitle.textContent = title;
        optionsContainer.innerHTML = options.map(opt => 
            `<button type="button" class="selection-option">${opt}</button>`
        ).join('');

        const handleSelection = (e) => {
            if (e.target.classList.contains('selection-option')) {
                modal.style.display = 'none';
                optionsContainer.removeEventListener('click', handleSelection);
                resolve(e.target.textContent);
            }
        };

        optionsContainer.addEventListener('click', handleSelection);
        modal.style.display = 'block';

        // モーダルの外側をクリックしたら閉じる（キャンセル扱い）
        window.onclick = (event) => {
            if (event.target == modal) {
                modal.style.display = "none";
                optionsContainer.removeEventListener('click', handleSelection);
                reject('cancelled');
            }
        };
    });
}

/**
 * 勤務時間を取得するボタンの処理（現在は仮実装）
 */
async function handleGetWorkTime() {
    const getWorkTimeButton = document.getElementById('get-work-time-button');
    const workTimeInput = document.getElementById('report-work');
    const reportDate = document.getElementById('report-date').value;
    const messageDiv = document.getElementById('report-message');

    if (!reportDate) {
        alert('先に報告日を選択してください。');
        return;
    }

    getWorkTimeButton.disabled = true;
    messageDiv.className = 'message';
    messageDiv.textContent = `[${reportDate}] の勤務時間を取得しています...`;

    try {
        const result = await fetchWorkTime(reportDate);
        if (result.success) {
            workTimeInput.value = result.workTime;
            updateWorkTimeSummary(); // サマリーを更新
            messageDiv.textContent = `勤務時間を取得しました。`;
            messageDiv.className = 'message success';
        } else {
            throw new Error(result.error);
        }
    } catch (error) {
        messageDiv.textContent = `勤務時間の取得に失敗しました: ${error.message}`;
        messageDiv.className = 'message error';
    } finally {
        getWorkTimeButton.disabled = false;
    }
}

/**
 * 工数入力フォームをリセットして再表示する
 */
function resetAndShowForm() {
    // 完了画面を非表示にし、フォームを表示する
    document.getElementById('completion-screen').style.display = 'none';
    document.getElementById('report-form-wrapper').style.display = 'block';
    document.getElementById('report-message').textContent = ''; // メッセージをクリア

    // フォームの値をリセット
    document.getElementById('report-form').reset();
    document.getElementById('report-date').valueAsDate = new Date(); // 日付を今日に

    // 工数入力エリアを再初期化
    initializeTaskArea();
}

// 工数入力フォームの送信処理
async function handleReportSubmit(e) {
    e.preventDefault();
    const submitButton = document.getElementById('submit-button');
    const messageDiv = document.getElementById('report-message');

    // 勤務時間と工数の差分を確認
    const totalWorkTime = parseInt(document.getElementById('report-work').value, 10) || 0;
    let allocatedMinutes = 0;
    document.querySelectorAll('.task-time').forEach(input => {
        allocatedMinutes += parseInt(input.value, 10) || 0;
    });

    // 送信処理中はボタンを無効化
    submitButton.disabled = true;
    messageDiv.className = 'message';
    messageDiv.textContent = "送信中...";

    const remainingMinutes = totalWorkTime - allocatedMinutes;

    if (remainingMinutes !== 0) {
        const isConfirmed = confirm('勤務時間と入力した工数に差異があります。このまま送信しますか？');
        if (!isConfirmed) {
            submitButton.disabled = false; // 送信をキャンセルしたのでボタンを有効に戻す
            messageDiv.textContent = ''; // メッセージをクリア
            return; // 処理を中断
        }
    }

    try {
        const tasks = [];
        document.querySelectorAll('.task-entry').forEach(entry => {
            const categoryMajor = entry.querySelector('.task-category-major').value;
            const categoryMinor = entry.querySelector('.task-category-minor').value;
            const time = parseInt(entry.querySelector('.task-time').value, 10) || 0;
            // すべてのフィールドが入力されている場合のみ追加
            if (categoryMajor && categoryMinor && time > 0) {
                tasks.push({ categoryA: categoryMajor, categoryB: categoryMinor, time });
            }
        });

        const requestBody = {
            date: document.getElementById('report-date').value,
            workTime: allocatedMinutes, // ★修正：入力された工数の合計値を送信する
            tasks: tasks // 業務内容を配列で送信
        };
        const response = await fetchWithAuth(`${API_BASE_URL}/api/reports`, {
            method: 'POST',
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            // サーバーからのJSONエラーレスポンスを解析
            const errorData = await response.json().catch(() => null);
            const errorMessage = errorData?.description || errorData?.message || `サーバーエラーが発生しました (コード: ${response.status})`;
            throw new Error(errorMessage);
        }

        // フォームを非表示にし、完了画面を表示する
        document.getElementById('report-form-wrapper').style.display = 'none';
        document.getElementById('report-message').style.display = 'none';
        
        const completionScreen = document.getElementById('completion-screen');
        const completionMessage = document.getElementById('completion-message');
        completionMessage.textContent = "報告が完了しました！";
        completionScreen.style.display = 'block';

    } catch (error) {
        console.error('Report submission failed:', error);
        messageDiv.textContent = `エラー: ${error.message}`;
        messageDiv.className = 'message error';
        submitButton.disabled = false;
    }
}

/**
 * HTMLファイルを読み込んでその内容を文字列として返す関数
 * @param {string} htmlFile 読み込むHTMLファイルへのパス
 * @returns {Promise<string>} 読み込んだHTMLの文字列
 */
async function fetchHtmlAsString(htmlFile) {
    try {
        const response = await fetch(htmlFile);
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
 * Dateオブジェクトをローカルタイムゾーン基準の "YYYY-MM-DD" 形式の文字列に変換する
 * @param {Date} date 変換するDateオブジェクト
 * @returns {string} "YYYY-MM-DD" 形式の文字列
 */
function toLocalDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * DateオブジェクトをUTC基準の "YYYY-MM-DD" 形式の文字列に変換する
 * @param {Date} date 変換するDateオブジェクト
 * @returns {string} "YYYY-MM-DD" 形式の文字列
 */
function toUTCDateString(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// liff-app.js の中のFullCalendar初期化部分 (例)

// カレンダーの表示範囲をカスタマイズ

// --- カレンダーの状態を管理する変数 ---
let calendarStatuses = {}; // 日付ごとのステータスを保持するオブジェクト
let currentCalendarReportMonth = null; // 現在表示している「月度」の代表日 (例: 2024-02-01)

/**
 * 指定された年月のカレンダーステータスをサーバーから取得する
 * @param {Date} reportMonthDate - 月度の代表日 (例: 2024-05-01)
 */
async function fetchCalendarStatuses(reportMonthDate) {
    try {
        // 月度の代表日から、実際の期間（前月21日〜当月20日）を計算する
        const year = reportMonthDate.getUTCFullYear();
        const month = reportMonthDate.getUTCMonth(); // 0-11

        const startDate = new Date(Date.UTC(year, month - 1, 21));
        const endDate = new Date(Date.UTC(year, month, 20));

        const startDateStr = toUTCDateString(startDate);
        const endDateStr = toUTCDateString(endDate);
        const response = await fetchWithAuth(`${API_BASE_URL}/api/calendar-statuses?start_date=${startDateStr}&end_date=${endDateStr}`);
        if (!response.ok) {
            throw new Error(`ステータス取得失敗: ${response.status}`);
        }
        calendarStatuses = await response.json();
    } catch (error) {
        console.error("カレンダーステータスの取得に失敗しました:", error);
        calendarStatuses = {}; // エラー時は空にする
    }
}

/**
 * カスタムカレンダーを描画する
 * @param {HTMLElement} calendarContainer カレンダー全体のコンテナ要素
 */
function renderCustomCalendar() {
    // この関数はカレンダーのテーブル部分のHTML文字列を生成して返す役割に徹する

    const { start, end } = calculateVisibleRange(currentCalendarReportMonth);

    // 今日の日付文字列を一度だけ取得しておく
    // タイムゾーンの問題を避けるため、ローカル日付の0時0分0秒のDateオブジェクトを生成してからUTC文字列に変換する
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = toUTCDateString(today);

    let html = '<table class="custom-calendar-table">';

    // ボディ（日付）
    html += '<tbody>';
    let currentDate = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()));
    while (currentDate <= end) {
        html += '<tr>';
        for (let i = 0; i < 7; i++) {
            const day = currentDate.getDate();
            const dayOfWeek = currentDate.getDay(); // 0:日曜, 6:土曜
            const dateStr = toUTCDateString(currentDate);

            // この日が現在の「月度」に属するかどうかを判定
            const reportMonthForThisDate = dateToMonthMap[dateStr];
            const isOtherMonth = !reportMonthForThisDate || (reportMonthForThisDate.getTime() !== currentCalendarReportMonth.getTime());

            // --- ステータス表示ロジック (dayCellDidMountから移植) ---
            let statusIndicatorHtml = '';
            let workTimeHtml = '';
            let reportedTimeHtml = '';

            // 当該月度の日付の場合のみステータス表示の処理を行う
            if (!isOtherMonth) {
                const statusData = calendarStatuses[dateStr];
                let statusText = undefined;
                let bgColor = '#777';
                let textColor = 'white';

                // 1. 先にサーバーからのステータス(工数入力済みなど)があるかチェック
                if (statusData) {
                     switch (statusData.status) {
                        case 'completed':
                            statusText = '完了';
                            bgColor = '#083969'; // 暗い青
                            break;
                        case 'inconsistent':
                            statusText = '不整合';
                            bgColor = '#d9534f'; // 赤
                            break;
                        case 'pending':
                            // 'pending'は今日以前の日付の場合のみ「未入力」として表示
                            if (dateStr <= todayStr) {
                                statusText = '未入力';
                            }
                            break;
                        case 'off_day':
                            // 休日や勤務実績0の日は何も表示しない
                            statusText = undefined;
                            break;
                    }
                } 

                // 2. サーバーからのステータスがない場合、今日以前なら「未入力」と表示
                if (statusText === undefined && dateStr <= todayStr) {
                    statusText = '未入力';
                }

                // 3. 表示するステータスがあれば、バッジと時間情報のHTMLを生成
                if (statusText) {
                    statusIndicatorHtml = `<div class="status-indicator" style="background-color: ${bgColor}; color: ${textColor};">${statusText}</div>`;
                    // 時間表示は、statusDataがあり、かつ'off_day'でない場合に生成
                    if (statusData && statusData.status !== 'off_day') {
                        const jobcanMinutes = statusData.jobcan_minutes ?? 0;
                        const reportedMinutes = statusData.reported_minutes ?? 0;
                        workTimeHtml = `<div class="time-display work-time">勤-${jobcanMinutes}</div>`;
                        reportedTimeHtml = `<div class="time-display reported-time">済-${reportedMinutes}</div>`;
                    }
                }
            }
            // --- ここまで ---

            // --- セルのクラスを決定 ---
            let cellContentClass = 'day-cell-content';
            if (isOtherMonth) {
                cellContentClass += ' other-month';
            } else { // 月度内の日のみ、曜日に応じたクラスを付与
                if (dayOfWeek === 0) cellContentClass += ' is-sunday';
                if (dayOfWeek === 6) cellContentClass += ' is-saturday';
            }

            // 今日の日付と一致する場合に is-today クラスを付与
            const tdClass = dateStr === todayStr ? 'is-today' : '';

            html += `<td data-date="${dateStr}" class="${tdClass}">
                        <div class="${cellContentClass}">
                            <div class="day-number-wrapper">
                                <span class="day-number">${day}</span>
                            </div>
                            <div class="status-container">
                                <div class="badge-container">${statusIndicatorHtml}</div>
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

    return html;
}

/**
 * カレンダー画面全体の初期化を行う
 * @param {HTMLElement} calendarContainer 
 */
async function initializeCalendarScreen(calendarContainer) {
    // ★修正: ユーザー情報を表示する
    displayUserInfo(calendarContainer); // ユーザー情報を先に表示

    // 1. サーバーからステータス情報を取得する
    await fetchCalendarStatuses(currentCalendarReportMonth);

    // 2. カレンダーのヘッダータイトルとテーブルを更新する
    const year = currentCalendarReportMonth.getUTCFullYear();
    const month = currentCalendarReportMonth.getUTCMonth() + 1;
    calendarContainer.querySelector('#calendar-title').innerText = `${year}年${month}月度`;
    calendarContainer.querySelector('#calendar-table-container').innerHTML = renderCustomCalendar();

    // 3. イベントリスナーを設定する
    setupCalendarEventListeners(calendarContainer);
}

/**
 * カレンダーの表示範囲を計算するヘルパー関数
 * @param {Date} currentDate 計算の基準となる日付
 * @returns {{start: Date, end: Date}} カレンダーの開始日と終了日
 */
function calculateVisibleRange(currentDate) {
    const targetReportYear = currentDate.getUTCFullYear();
    const targetReportMonth = currentDate.getUTCMonth(); // 0-11

            // 「当月度」の期間（前月21日〜当月20日）を定義
    const periodStart = new Date(Date.UTC(targetReportYear, targetReportMonth - 1, 21));
    const periodEnd = new Date(Date.UTC(targetReportYear, targetReportMonth, 20));

            // periodStart を含む週の日曜日を計算
            const viewStart = new Date(periodStart);
            viewStart.setUTCDate(viewStart.getUTCDate() - viewStart.getUTCDay()); // getUTCDay()は日曜=0, 月曜=1...

            // periodEnd を含む週の土曜日を計算
            const viewEnd = new Date(periodEnd);
            viewEnd.setUTCDate(viewEnd.getUTCDate() + (6 - viewEnd.getUTCDay()));

            return { start: viewStart, end: viewEnd };
}

// --- カレンダー画面のイベントリスナー管理 ---
const calendarClickHandlers = {}; // ハンドラをグローバルスコープ（またはモジュールスコープ）に移動

/**
 * 重複登録を防ぎつつイベントリスナーを設定するヘルパー関数
 * @param {string} elementId 
 * @param {string} event 
 * @param {Function} handler 
 */
function addSafeEventListener(elementId, event, handler) {
    const element = document.getElementById(elementId);
    if (element) {
        // 以前のハンドラがあれば削除
        if (calendarClickHandlers[elementId]) {
            element.removeEventListener(event, calendarClickHandlers[elementId]);
        }
        // 新しいハンドラを登録
        element.addEventListener(event, handler);
        calendarClickHandlers[elementId] = handler; // ハンドラを保存
    }
}

/**
 * カレンダー画面のすべてのイベントリスナーを設定する
 * @param {HTMLElement} calendarContainer 
 */
function setupCalendarEventListeners(calendarContainer) {
    // --- ボタン操作 ---
    addSafeEventListener('prev-month-button', 'click', async () => {
        currentCalendarReportMonth.setMonth(currentCalendarReportMonth.getMonth() - 1);
        await fetchCalendarStatuses(currentCalendarReportMonth); // データ再取得
        // タイトルとテーブルを更新
        const newYearPrev = currentCalendarReportMonth.getUTCFullYear();
        const newMonthPrev = currentCalendarReportMonth.getUTCMonth() + 1;
        calendarContainer.querySelector('#calendar-title').innerText = `${newYearPrev}年${newMonthPrev}月度`;
        calendarContainer.querySelector('#calendar-table-container').innerHTML = renderCustomCalendar();
        // 再描画後にリスナーを再設定
        setupCalendarEventListeners(calendarContainer);
    });

    addSafeEventListener('next-month-button', 'click', async () => {
        currentCalendarReportMonth.setMonth(currentCalendarReportMonth.getMonth() + 1);
        await fetchCalendarStatuses(currentCalendarReportMonth); // データ再取得
        // タイトルとテーブルを更新
        const newYearNext = currentCalendarReportMonth.getUTCFullYear();
        const newMonthNext = currentCalendarReportMonth.getUTCMonth() + 1;
        calendarContainer.querySelector('#calendar-title').innerText = `${newYearNext}年${newMonthNext}月度`;
        calendarContainer.querySelector('#calendar-table-container').innerHTML = renderCustomCalendar();
        // 再描画後にリスナーを再設定
        setupCalendarEventListeners(calendarContainer);
    });

    // --- 日付セルクリック ---
    const calendarViewHandler = (e) => {
        const clickedCell = e.target.closest('td');
        if (clickedCell && clickedCell.dataset.date) {
            const clickedDate = clickedCell.dataset.date;
            const todayStr = toUTCDateString(new Date());

            if (clickedDate > todayStr && !confirm('未来の日付です。先行して入力しますか？')) {
                return;
            }

            const statusData = calendarStatuses[clickedDate];
            if (statusData && statusData.status === 'completed') {
                if (!confirm('入力完了済みです。再入力しますか？')) {
                    return;
                }
            }

            const baseUrl = window.location.origin + window.location.pathname;
            window.location.href = `${baseUrl}?page=report&date=${clickedDate}`;
        }
    };
    addSafeEventListener('calendar-view', 'click', calendarViewHandler);
}


/**
 * 日付文字列(YYYY-MM-DD)をキーとし、
 * その日が属する「月度」の開始日(Dateオブジェクト)を値とするマップ
 * 例: { "2024-01-20": Date('2024-01-01'), "2024-01-21": Date('2024-02-01') }
 */
const dateToMonthMap = {};

/**
 * 指定された期間の日付と月度のマッピングデータを生成し、dateToMonthMapに格納する
 * @param {Date} mapStartDate マップ生成を開始する日付
 * @param {Date} mapEndDate マップ生成を終了する日付
 */
function generateDateToMonthMap(mapStartDate, mapEndDate) {
    let currentDate = new Date(Date.UTC(mapStartDate.getFullYear(), mapStartDate.getMonth(), mapStartDate.getDate()));
    while (currentDate <= mapEndDate) {
        const calendarYear = currentDate.getUTCFullYear();  // 暦年
        const calendarMonth = currentDate.getUTCMonth();    // 暦月 (0-11)
        const calendarDay = currentDate.getUTCDate();       // 暦日

        let reportMonthDate; // この日が属する「月度」の代表日
        // 21日以降はその月の翌月度として扱う
        if (calendarDay >= 21) {
            reportMonthDate = new Date(Date.UTC(calendarYear, calendarMonth + 1, 1));
        } else {
            reportMonthDate = new Date(Date.UTC(calendarYear, calendarMonth, 1));
        }
        
        // "YYYY-MM-DD" 形式の文字列をキーにする
        const dateString = toUTCDateString(new Date(currentDate));
        dateToMonthMap[dateString] = reportMonthDate;
        
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }
}

// --- グローバル変数 ---
let cachedUserProfile = null;
let cachedEmployeeInfo = null;

/**
 * ユーザー情報を表示する関数
 * @param {HTMLElement} container - 情報を表示する親コンテナ要素
 */
function displayUserInfo(container) {
    if (!container) return;

    const displayElement = container.querySelector('.user-info-bar');
    if (!displayElement) return;

    let userInfoText = 'ユーザー情報の取得に失敗しました。';
    if (cachedEmployeeInfo) {
        const name = cachedEmployeeInfo.name || 'ゲスト';
        const employeeId = cachedEmployeeInfo.employeeId;

        if (employeeId) {
            userInfoText = `報告者：${name}（ID：${employeeId}）`;
        } else {
            userInfoText = `未登録　※ID登録してください`;
        }
    }
    displayElement.textContent = userInfoText;
}

async function main() {
    const loadingContainer = document.getElementById('loading-container');
    const loadingMessage = document.getElementById('loading-message');

    // アプリケーションのロジックで必要となる日付と月度のマッピングを最初に生成する
    const todayForMap = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
    const mapStartDate = new Date(Date.UTC(todayForMap.getUTCFullYear() - 5, 0, 1)); // 5年前の1月1日
    const mapEndDate = new Date(Date.UTC(todayForMap.getUTCFullYear() + 5, 11, 31)); // 5年後の12月31日
    generateDateToMonthMap(mapStartDate, mapEndDate);

    let userProfile = null;
    let employeeInfo = null;

    try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) {
            loadingMessage.innerText = "LINEにログインしてください。";
            liff.login();
            return;
        }

        // ユーザー情報を一度だけ取得してキャッシュする
        userProfile = await liff.getProfile();
        cachedUserProfile = userProfile;

        try {
            const userInfoResponse = await fetchWithAuth(`${API_BASE_URL}/api/user`);
            if (userInfoResponse.ok) {
                employeeInfo = await userInfoResponse.json();
            } else if (userInfoResponse.status === 404) {
                employeeInfo = { name: '（ID未登録）', employeeId: null };
            }
            cachedEmployeeInfo = employeeInfo;
        } catch (e) {
            console.error("社員情報の取得に失敗:", e);
            cachedEmployeeInfo = { name: '（情報取得エラー）', employeeId: null };
        }

        // URLのクエリパラメータを解析して表示を切り替える
        const urlParams = new URLSearchParams(window.location.search);
        const page = urlParams.get('page');

        if (page === 'register') {
            // ID登録画面を表示
            document.title = "ID登録";
            const registerHtml = await fetchHtmlAsString('_register.html');
            const registerContainer = document.getElementById('register-container');
            registerContainer.style.display = 'block';
            registerContainer.innerHTML = registerHtml; // コンテナを表示してから中身を挿入

            // ★修正: 共通関数でユーザー情報を表示
            displayUserInfo(registerContainer);
            // イベントリスナーはHTMLが挿入された後に設定する
            document.getElementById('register-form').addEventListener('submit', handleRegisterSubmit);
        } else if (page === 'calendar') {
            // カレンダー画面を表示
            document.title = "カレンダー";
            const calendarHtml = await fetchHtmlAsString('_calendar.html');
            const calendarContainer = document.getElementById('calendar-container');
            calendarContainer.innerHTML = calendarHtml;
            calendarContainer.style.display = 'block';

            // 表示対象の月度が未設定の場合、当月度を設定する
            if (!currentCalendarReportMonth) {
                const today = new Date(); // 現在のローカル時刻
                const todayString = toUTCDateString(today);
                // マップから今日が属する月度を取得、なければ現在の暦月を月度とする
                currentCalendarReportMonth = dateToMonthMap[todayString] || new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
            }

            // DOMの描画が完了するのを待ってからカレンダー初期化処理を実行する
            setTimeout(async () => {
                await initializeCalendarScreen(calendarContainer);
            }, 0);
        } else {
            // デフォルトまたは page=report の場合は工数入力画面を表示
            document.title = "工数入力";

            // 1. まず画面の骨格だけを先に表示する
            const reportHtml = await fetchHtmlAsString('_report.html');
            const reportContainer = document.getElementById('report-container');
            reportContainer.style.display = 'block';
            reportContainer.innerHTML = reportHtml;

            // 2. 日付を確定させる
            const dateParam = urlParams.get('date');
            const targetDate = dateParam || toUTCDateString(new Date());
            document.getElementById('report-date').value = targetDate;

            // 3. イベントリスナーを先に設定
            document.getElementById('report-form').addEventListener('submit', handleReportSubmit);
            document.getElementById('get-work-time-button').addEventListener('click', handleGetWorkTime);
            document.getElementById('add-task-button').addEventListener('click', () => {
                // --- UI切り替えボタンの作成と配置 ---
                const addTaskButton = document.getElementById('add-task-button');
                if (addTaskButton && !document.getElementById('ui-toggle-button')) { // ボタンがまだなければ作成
                    const uiToggleButton = document.createElement('button');
                    uiToggleButton.type = 'button';
                    uiToggleButton.id = 'ui-toggle-button';
                    uiToggleButton.className = 'ui-toggle-button';
                    uiToggleButton.textContent = 'UI';
                    uiToggleButton.style.marginRight = '5px'; // ＋ボタンとの間に少し余白

                    // クリックでアクティブ状態を切り替える
                    uiToggleButton.addEventListener('click', () => {
                        const isActive = uiToggleButton.classList.toggle('active');
                        // 背景色で状態を視覚的に示す
                        uiToggleButton.style.backgroundColor = isActive ? '#17a2b8' : '#6c757d';
                        // TODO: ここでUIモードを切り替えるロジックを将来的に実装
                        console.log(`スライド入力モード: ${isActive}`);
                    });

                    // 「＋」ボタンの直前に挿入
                    addTaskButton.parentNode.insertBefore(uiToggleButton, addTaskButton);
                }
                // 直前に削除されたタスクがあればそれを復元し、なければ空の行を追加
                addTaskEntry(lastDeletedTask);
                // 復元は一度きりなので、使用後はnullに戻す
                lastDeletedTask = null;
                // ★追加: 行を追加した後にサマリーを更新して送信ボタンの状態を再評価する
                updateWorkTimeSummary();
            });
            document.getElementById('report-work').addEventListener('input', updateWorkTimeSummary);

            document.getElementById('continue-button').addEventListener('click', resetAndShowForm);
            document.getElementById('close-button').addEventListener('click', () => liff.closeWindow());

            // --- モーダル表示のロジックを追加 ---
            const modal = document.getElementById('work-time-notes-modal');
            const openBtn = document.getElementById('work-time-notes-trigger');
            const closeBtn = document.getElementById('modal-close-button');
            if (modal && openBtn && closeBtn) {
                openBtn.onclick = () => { modal.style.display = "block"; };
                closeBtn.onclick = () => { modal.style.display = "none"; };
                // モーダルの外側をクリックしても閉じるようにする
                window.onclick = (event) => {
                    if (event.target == modal) {
                        modal.style.display = "none";
                    }
                };
            }
            
            // カテゴリ候補を非同期で取得し、datalistを準備する
            setupCategoryDatalists();

            // 4. ユーザー情報、勤務時間、既存の報告内容を "並列で" 実行する
            const [workTimeResult, reportDetailsResult] = await Promise.all([
                fetchWorkTime(targetDate),
                fetchReportDetails(targetDate)
            ]);

            // 5. 取得した結果を画面に反映させる
            displayUserInfo(reportContainer); // ★修正: 共通関数でユーザー情報を表示
            // 勤務時間
            if (workTimeResult.success) {
                document.getElementById('report-work').value = workTimeResult.workTime;
                updateWorkTimeSummary(); // サマリーを更新
            } else {
                // エラーメッセージを表示するなど（コンソールに出力）
                console.error("自動受信エラー:", workTimeResult.error);
            }

            // 既存の工数報告を反映させてUIを初期化
            initializeTaskArea(reportDetailsResult.tasks);
        }

        loadingContainer.style.display = 'none'; // コンテンツの準備ができてからローディング表示を消す

    } catch (error) {
        console.error('LIFF initialization failed', error);
        let displayMessage = `エラーが発生しました: ${error.message}`;
        // 'exp' を含むエラーメッセージの場合、時刻設定に関する案内を追加
        if (error.message && error.message.toLowerCase().includes('exp')) {
            displayMessage += '\n\n端末の「日付と時刻」が正しく設定されているかご確認ください。';
        }
        loadingMessage.innerText = displayMessage;
        loadingMessage.className = 'message error';
        loadingContainer.style.display = 'block'; // エラー時もローディングコンテナは表示したままにする
    }
}

main();
