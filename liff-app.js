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
    const idToken = await getVerifiedIdToken();

    const headers = {
        ...options.headers,
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
    };
    return fetch(url, { ...options, headers });
}

// --- モーダル履歴管理とスタイル制御 ---
let isBackNavigation = false; // ブラウザバックによる操作かを判定するフラグ
let currentModalCloseFunc = null; // 現在開いているモーダルを閉じる関数

// ブラウザの「戻る」操作を検知
window.addEventListener('popstate', function(e) {
    if (currentModalCloseFunc) {
        // モーダルが開いている場合、そのモーダルを閉じる処理を実行
        isBackNavigation = true;
        try {
            currentModalCloseFunc();
        } catch (error) {
            console.error("モーダルクローズ処理中にエラーが発生しました:", error);
        } finally {
            currentModalCloseFunc = null;
            isBackNavigation = false;
        }
    }
});

/**
 * モーダルを開く際に呼び出す。履歴を追加し、戻るボタンで閉じられるようにする。
 * @param {Function} closeFunc - モーダルを閉じるための関数
 */
function openModalState(closeFunc) {
    history.pushState(null, null, null);
    currentModalCloseFunc = closeFunc;
}

/**
 * モーダルを閉じる際に呼び出す。履歴を整合させる。
 */
function closeModalState() {
    if (!isBackNavigation && currentModalCloseFunc) {
        // UI上のボタン（OK/キャンセルなど）で閉じる場合、履歴を1つ戻す
        // 先にnullにすることで、popstateイベントでの二重実行を防ぐ
        currentModalCloseFunc = null;
        history.back();
    }
}

/**
 * モーダル用の共通スタイル（ぼかし効果など）を適用する
 */
function setupModalStyles() {
    const styleId = 'modal-common-style';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        .modal { 
            backdrop-filter: blur(5px); 
            -webkit-backdrop-filter: blur(5px); 
            background-color: rgba(0, 0, 0, 0.6) !important; 
            z-index: 9999; /* 最前面を確保 */
        }
        body.modal-open { 
            overflow: hidden; 
            touch-action: none; /* モバイルでのスクロール操作も抑制 */
        }
        .modal-close-button-common {
            background-color: #083969; /* ネイビー */
            color: white;
            border: none;
            border-radius: 4px;
            padding: 8px 12px;
            font-size: 0.9rem;
            font-weight: bold;
            cursor: pointer;
            line-height: 1;
            margin-bottom: 25px; 
            align-self: flex-start; /* flexコンテナ内で左上に配置 */
        }
    `;
    document.head.appendChild(style);
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
let categoryBOptions = []; // 小分類の候補を保持する配列 (オブジェクト配列: {label, client, project})
let lastDeletedTask = null; // 直前に削除されたタスクを保持する変数
let activeSliderInput = null; // スライダーで操作中の入力フィールドを保持
/** 工数入力（ネット）画面かどうか。true のとき1行レイアウト（開始・終了時刻あり）で描画する */
let isReportNetPage = false;

/**
 * ユーザーの所属グループに基づいて、小分類（Category B）の表示ラベルを決定する
 * @returns {string} 表示ラベル ('店舗名' または '工事番号・案件名')
 */
function getCategoryBLabel() {
    const groupName = (cachedEmployeeInfo && cachedEmployeeInfo.main_group_name) ? cachedEmployeeInfo.main_group_name : '';
    // グループ名に「ネット」が含まれる場合はネット事業部とみなす
    if (groupName.includes('ネット')) {
        return '店舗';
    }
    // それ以外は工務とみなす
    return '工事番号';
}

/**
 * 新しいタスク入力行を追加する
 * @param {{categoryA_label: string, categoryA_id: string, categoryB_label: string, categoryB_id: string, time: number}|null} task - (オプション) 初期表示するタスクデータ
 */
function addTaskEntry(task = null) {
    taskCounter++;
    const container = document.getElementById('task-entries-container');
    if (!container) return;
    const entryDiv = document.createElement('div');
    entryDiv.className = 'task-entry';
    entryDiv.id = `task-entry-${taskCounter}`;
    entryDiv.style.display = 'flex';
    entryDiv.style.alignItems = 'center';
    entryDiv.style.gap = '5px';
    entryDiv.style.marginBottom = '10px';
    entryDiv.style.flexWrap = 'nowrap';

    const categoryBLabel = getCategoryBLabel();

    if (isReportNetPage) {
        // ネット: 集計→業務→開始/終了→分。－は右寄せで「＋」と揃え（.net-task-remove-wrapで幅38px統一）。
        entryDiv.style.alignItems = 'stretch';
        entryDiv.innerHTML = `
            <input type="text" class="task-category-minor" placeholder="集計" style="flex: 0 0 86px; min-width: 0; align-self: center;" required readonly>
            <input type="text" class="task-category-major" placeholder="業務" style="flex: 1 1 0; min-width: 0; align-self: center;" required readonly>
            <div class="task-time-range-wrap" style="flex: 0 0 84px; display: flex; flex-direction: column; gap: 2px; justify-content: center;">
                <input type="time" class="task-start-time" style="width: 100%; box-sizing: border-box;">
                <input type="time" class="task-end-time" style="width: 100%; box-sizing: border-box;">
            </div>
            <input type="number" class="task-time time-input" inputmode="numeric" placeholder="分" style="flex: 0 0 48px; align-self: center;" required>
            <div class="net-task-remove-wrap"><button type="button" class="remove-task-button net-task-remove-btn">－</button></div>
        `;
    } else {
        entryDiv.innerHTML = `
            <input type="text" class="task-category-major" placeholder="業務種別" style="flex-grow: 1.5;" required readonly>
            <input type="text" class="task-category-minor" placeholder="${categoryBLabel}" style="flex-grow: 1;" required readonly>
            <input type="number" class="task-time time-input" inputmode="numeric" required>
            <button type="button" class="remove-task-button">－</button>
        `;
    }

    container.appendChild(entryDiv);

    const majorInput = entryDiv.querySelector('.task-category-major');
    const minorInput = entryDiv.querySelector('.task-category-minor');
    const timeInput = entryDiv.querySelector('.task-time');
    const startTimeInput = entryDiv.querySelector('.task-start-time');
    const endTimeInput = entryDiv.querySelector('.task-end-time');

    // 初期データがあれば設定する
    if (task) {
        majorInput.value = task.categoryA_label || task.categoryA || '';
        majorInput.dataset.id = task.categoryA_id || '';
        minorInput.value = task.categoryB_label || task.categoryB || '';
        minorInput.dataset.id = task.categoryB_id || '';
        timeInput.value = (task.time !== undefined && task.time !== null) ? String(task.time) : '';
        // 既存日報由来の行は分数を固定表示（start/end変更で初めて再計算モードへ）
        entryDiv.dataset.lockedTime = '1';
        if (isReportNetPage) {
            const startEl = entryDiv.querySelector('.task-start-time');
            const endEl = entryDiv.querySelector('.task-end-time');
            if (startEl && task.startTime) { startEl.value = task.startTime; entryDiv.dataset.startTime = task.startTime; }
            if (endEl && task.endTime) { endEl.value = task.endTime; entryDiv.dataset.endTime = task.endTime; }
        }
        if (task.comment) entryDiv.dataset.comment = task.comment;
    }

    // ネット画面: ネイティブ時刻ピッカー使用。
    // - 既存日報由来(lockedTime=1): DB分数を維持
    // - 入力中タスク(lockedTime!=1): 開始/終了から分数を再計算
    if (isReportNetPage && (startTimeInput || endTimeInput)) {
        const roundTimeTo15 = (value) => {
            if (!value || typeof value !== 'string') return '';
            const [h, m] = value.split(':').map(v => parseInt(v, 10));
            if (isNaN(h) || isNaN(m)) return value;
            const total = h * 60 + m;
            const rounded = Math.round(total / 15) * 15;
            const rh = Math.floor(rounded / 60) % 24;
            const rm = rounded % 60;
            return String(rh).padStart(2, '0') + ':' + String(rm).padStart(2, '0');
        };
        const timeToMinutes = (value) => {
            if (!value || typeof value !== 'string') return null;
            const [h, m] = value.split(':').map(v => parseInt(v, 10));
            if (isNaN(h) || isNaN(m)) return null;
            return h * 60 + m;
        };
        const updateMinutesFromRange = () => {
            const startVal = startTimeInput ? startTimeInput.value : '';
            const endVal = endTimeInput ? endTimeInput.value : '';
            const startMin = timeToMinutes(startVal);
            const endMin = timeToMinutes(endVal);
            if (startMin !== null && endMin !== null) {
                let diff = endMin - startMin;
                if (diff < 0) diff += 24 * 60; // 翌日跨ぎ
                timeInput.value = Math.max(0, diff);
            }
        };
        const applyRoundAndMinutes = (input) => {
            if (!input) return;
            input.addEventListener('change', () => {
                if (input.value) {
                    input.value = roundTimeTo15(input.value);
                    if (input.classList.contains('task-start-time')) entryDiv.dataset.startTime = input.value;
                    if (input.classList.contains('task-end-time')) entryDiv.dataset.endTime = input.value;
                    // 既存日報由来の行でも、時刻を編集した時点で再計算モードへ移行
                    if (entryDiv.dataset.lockedTime === '1') {
                        entryDiv.dataset.lockedTime = '0';
                    }
                    if (entryDiv.dataset.lockedTime !== '1') {
                        updateMinutesFromRange();
                    }
                    updateWorkTimeSummary();
                }
            });
        };
        applyRoundAndMinutes(startTimeInput);
        applyRoundAndMinutes(endTimeInput);
    }

    // イベントリスナーを新しい要素に設定
    entryDiv.querySelector('.task-time').addEventListener('input', updateWorkTimeSummary);
    entryDiv.querySelector('.remove-task-button').addEventListener('click', (e) => {
        const entryToRemove = e.currentTarget.closest('.task-entry');
        const majorIn = entryToRemove.querySelector('.task-category-major');
        const minorIn = entryToRemove.querySelector('.task-category-minor');
        lastDeletedTask = {
            categoryA_label: majorIn.value,
            categoryA_id: majorIn.dataset.id,
            categoryB_label: minorIn.value,
            categoryB_id: minorIn.dataset.id,
            time: entryToRemove.querySelector('.task-time').value
        };
        if (isReportNetPage) {
            const se = entryToRemove.querySelector('.task-start-time');
            const ee = entryToRemove.querySelector('.task-end-time');
            lastDeletedTask.startTime = se ? se.value : '';
            lastDeletedTask.endTime = ee ? ee.value : '';
        }
        entryToRemove.remove();
        updateWorkTimeSummary();
    });

    // --- 入力欄クリックで選択モーダルを表示 ---
    majorInput.addEventListener('click', async () => {
        try {
            let optionsForA = categoryAOptions;
            if (isReportNetPage) {
                // ネット: 集計(B)を先に選び、それに紐づく業務(A)だけ選べる
                const selectedBId = minorInput.dataset.id || (minorInput.value ? (categoryBOptions.find(b => b.label === minorInput.value) || {}).id : '');
                if (!selectedBId) {
                    alert('先に集計を選択してください。');
                    return;
                }
                const bOption = categoryBOptions.find(b => b.id === selectedBId);
                const allowedAIds = bOption && bOption.category_a_settings ? Object.keys(bOption.category_a_settings) : [];
                optionsForA = categoryAOptions.filter(a => allowedAIds.includes(a.id));
                if (optionsForA.length === 0) {
                    alert('この集計に紐づく業務がありません。');
                    return;
                }
            }
            const selectedObj = await showSelectionModal('業務種別を選択', optionsForA, majorInput, isReportNetPage ? { skipOfficeFilter: true } : {});
            if (typeof selectedObj === 'object') {
                majorInput.value = selectedObj.label;
                majorInput.dataset.id = selectedObj.id || '';
            } else {
                majorInput.value = selectedObj;
            }
            if (!isReportNetPage) {
                // 工務: 大分類が変更されたら、小分類をクリアする
                minorInput.value = '';
                minorInput.dataset.id = '';
            }
            updateWorkTimeSummary();
        } catch (error) { /* キャンセル時は何もしない */ }
    });
    minorInput.addEventListener('click', async () => {
        try {
            // ネット事業部では拠点フィルタは表示しない（skipOfficeFilter: true）
            const selectedObj = await showSelectionModal(
                '集計軸カテゴリを選択',
                categoryBOptions,
                minorInput,
                isReportNetPage ? { skipOfficeFilter: true } : {}
            );
            if (typeof selectedObj === 'object') {
                minorInput.value = selectedObj.label;
                minorInput.dataset.id = selectedObj.id || '';
            } else {
                minorInput.value = selectedObj;
            }
            if (isReportNetPage) {
                // ネット: 集計(B)を変更したら業務(A)をクリア（紐づくAのリストが変わるため）
                majorInput.value = '';
                majorInput.dataset.id = '';
            }
            updateWorkTimeSummary();
        } catch (error) { /* キャンセル時は何もしない */ }
    });

    // --- 分数入力欄クリックでスライダーモーダルを表示 ---
    timeInput.addEventListener('click', (e) => {
        const uiToggleButton = document.getElementById('ui-toggle-button');
        // UIトグルがアクティブの場合のみスライダーを表示
        if (uiToggleButton && uiToggleButton.classList.contains('active')) {
            e.preventDefault(); // キーボードの表示を抑制
            timeInput.blur();   // ★追加: 入力欄からフォーカスを外し、キーボード表示を抑制する
            activeSliderInput = timeInput; // 操作対象の入力欄を保存

            // --- スライダーの最大値を計算 ---
            const totalWorkTime = parseInt(document.getElementById('report-work').value, 10) || 0;
            let allocatedMinutes = 0;
            document.querySelectorAll('.task-time').forEach(input => {
                if (input !== activeSliderInput) { // 自分以外の入力欄の合計
                    allocatedMinutes += parseInt(input.value, 10) || 0;
                }
            });
            const remainingMinutes = totalWorkTime - allocatedMinutes;
            const currentValue = parseInt(activeSliderInput.value, 10) || 0;

            const slider = document.getElementById('time-slider');
            const sliderValueDisplay = document.getElementById('slider-value-display');
            const sliderRemainingTimeDisplay = document.getElementById('slider-remaining-time-display');

            // 最大値は残り分数。ただし0未満にはしない
            slider.max = Math.max(0, remainingMinutes);
            // 現在の値が最大値を超えている場合は、最大値に丸める
            slider.value = Math.min(currentValue, slider.max);
            sliderValueDisplay.textContent = `${slider.value} 分`;
            // 残り時間も表示（形式変更）
            sliderRemainingTimeDisplay.textContent = `残り時間：${remainingMinutes} 分`;

            // モーダルを表示
            const modal = document.getElementById('time-slider-modal');

            // --- ★閉じるボタンの追加 ---
            const sliderContent = modal.querySelector('.slider-modal-content');
            if (sliderContent) {
                sliderContent.style.paddingTop = '2px';
                if (!sliderContent.querySelector('.modal-close-button-common')) {
                    const closeButton = document.createElement('button');
                    closeButton.type = 'button';
                    closeButton.className = 'modal-close-button-common';
                    closeButton.innerHTML = '← 閉じる';
                    sliderContent.prepend(closeButton); // コンテンツの先頭に追加
                }
                // ボタンにクリックイベントを設定
                sliderContent.querySelector('.modal-close-button-common').onclick = hideSliderModal;
            }
            // --- ★ここまで ---

            modal.classList.add('modal');
            // ★★★ 修正: .modalクラスのスタイルを上書きし、下部表示を復元する ★★★
            // .modalクラスは画面上部からの表示を想定しているため、
            // 下部表示用の.slider-modalと競合するスタイル(top, height, padding-top)をJSで無効化する。
            modal.style.display = 'block';
            modal.style.paddingTop = '2';   // 上部パディングをリセット
            modal.style.top = 'auto';       // top指定を解除してbottom:0を有効にする
            modal.style.height = 'auto';      // height指定を解除してコンテンツの高さに合わせる

            // 過去の試行で設定した可能性のあるスタイルを完全にリセット
            modal.style.alignItems = '';
            modal.style.flexDirection = '';
            modal.style.justifyContent = '';
            document.body.classList.add('modal-open'); // 背景スクロール固定
            
            // ★履歴管理に追加（戻るボタンで閉じるようにする）
            openModalState(hideSliderModal);

            // アニメーションのために少し遅延させる
            setTimeout(() => {
                modal.classList.add('show');
            }, 10);
        }
    });
    return entryDiv;
}

/**
 * 追加したタスク行を見える位置へ移動し、最初に操作する入力へフォーカスする。
 * 工務: 業務種別、ネット: 集計 を優先。
 * @param {HTMLElement|null} entry
 */
function focusAndRevealNewTaskEntry(entry) {
    if (!entry) return;
    entry.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    const primarySelector = isReportNetPage ? '.task-category-minor' : '.task-category-major';
    const focusTarget = entry.querySelector(primarySelector) || entry.querySelector('.task-time');
    if (!focusTarget) return;
    setTimeout(() => {
        try {
            focusTarget.focus({ preventScroll: true });
        } catch {
            focusTarget.focus();
        }
    }, 20);
}

function hideSliderModal() {
    // ★履歴管理の状態をクリア
    closeModalState();

    const modal = document.getElementById('time-slider-modal');
    modal.classList.remove('show');
    document.body.classList.remove('modal-open'); // 背景スクロール解除
    setTimeout(() => {
        modal.style.display = 'none';
        activeSliderInput = null; // 操作対象をリセット
    }, 300); // transitionの時間に合わせる
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

    // 条件に応じて送信ボタンの活性/不活性を切り替え
    // - 入力があれば、タスクが完成している必要がある
    // - 入力が0分でも送信（クリア）できるようにする
    submitButton.disabled = !(isAnyTaskComplete || allocatedMinutes === 0);

    // 残り時間の色分け
    // allocatedMinutes > 0 の条件を追加し、何も入力していないときは赤にならないようにする
    if (remainingMinutes === 0 && allocatedMinutes > 0) {
        remainingTimeDisplay.style.color = '#00B900'; // 緑
    } else {
        remainingTimeDisplay.style.color = '#d9534f'; // 赤
    }
}

/**
 * 工数入力画面にステータス（宿泊、現場など）を表示する
 * @param {object} reportData - 日報データ
 */
function updateReportStatusBadges(reportData) {
    const container = document.getElementById('report-status-badges');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (reportData.has_accommodation) {
        const span = document.createElement('span');
        span.textContent = '「宿泊」';
        span.style.color = '#258301'; // カレンダーのバッジ色(緑)と統一
        container.appendChild(span);
    }
    
    if (reportData.on_site) {
        const span = document.createElement('span');
        if (reportData.on_site === 'full') {
            span.textContent = '「現場_全」';
            span.style.color = '#031ae6'; // カレンダーのバッジ色(青)と統一
        } else if (reportData.on_site === 'half') {
            span.textContent = '「現場_半」';
            span.style.color = '#8679ff'; // カレンダーのバッジ色(薄い青/紫)と統一
        }
        container.appendChild(span);
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
 * @param {string} source - 呼び出し元を示す文字列 ('report' or 'calendar')
 */
async function fetchWorkTime(date, source = 'report') { // デフォルトは 'report'
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/work-time?date=${date}&source=${source}`);
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
 * 履歴に基づいて選択肢をソートするヘルパー関数
 * @param {Array} options - 選択肢の配列
 * @param {Array} historyIds - 履歴IDの配列
 * @returns {Array} ソートされた選択肢
 */
function sortOptionsByHistory(options, historyIds) {
    if (!historyIds || historyIds.length === 0) return options;
    
    // 履歴IDとそのインデックスのマップを作成
    const historyMap = new Map(historyIds.map((id, index) => [id, index]));
    
    return [...options].sort((a, b) => {
        const indexA = historyMap.has(a.id) ? historyMap.get(a.id) : Infinity;
        const indexB = historyMap.has(b.id) ? historyMap.get(b.id) : Infinity;
        
        if (indexA !== indexB) return indexA - indexB; // 履歴順
        return 0; // 履歴になければ元の順序を維持（または別途ソート）
    });
}

/**
 * 大分類・小分類の候補をサーバーから取得し、datalistに設定する
 */
async function setupCategoryDatalists() {
    // 最初に大分類を取得
    const userMainGroup = cachedEmployeeInfo ? cachedEmployeeInfo.main_group : null;
    let categoryAKind = 'engineering'; // デフォルトは工務
    if (String(userMainGroup) === '3') { // ネット事業部
        categoryAKind = 'net';
    }

    try {
        const responseA = await fetchWithAuth(`${API_BASE_URL}/api/categories/category_a?kind=${categoryAKind}`);
        if (responseA.ok) {
            const categories = await responseA.json();
            categoryAOptions = categories.map(cat => ({ id: cat.id, label: cat.label }));
            
            // 履歴があればソート
            const historyA = cachedEmployeeInfo?.history?.catA || [];
            categoryAOptions = sortOptionsByHistory(categoryAOptions, historyA);
        }
    } catch (error) {
        console.error("大分類カテゴリ候補の取得に失敗しました:", error);
    }

    // 次にユーザー情報に基づいて小分類を取得
    try {
        let categoryBEndpoint;

        // main_groupの値で分岐し、取得するカテゴリを切り替える
        if (String(userMainGroup) === '3') {
            // main_groupが'3' (ネット事業部) の場合
            categoryBEndpoint = `${API_BASE_URL}/api/categories/b?kind=net`;
        } else {
            // main_groupが'3'以外 (工務など)、または取得できなかった場合
            categoryBEndpoint = `${API_BASE_URL}/api/categories/b?kind=engineering`;
        }

        const responseB = await fetchWithAuth(categoryBEndpoint);
        if (responseB.ok) {
            const categories = await responseB.json();
            // アクティブなカテゴリのみを抽出
            const activeCategories = categories.filter(cat => cat.active !== false);

            // ラベルだけでなく、client・project・category_a_settings（ネット時: Bに紐づくAのID一覧）も保持
            categoryBOptions = activeCategories.map(cat => ({
                id: cat.id,
                label: cat.label,
                client: cat.client || '',
                project: cat.project || '',
                offices: cat.offices || [],
                category_a_settings: cat.category_a_settings || {}
            }));

            // 履歴があればソート
            const historyB = cachedEmployeeInfo?.history?.catB || [];
            categoryBOptions = sortOptionsByHistory(categoryBOptions, historyB);
        }
    } catch (error) {
        console.error("カテゴリ候補の取得に失敗しました:", error);
    }
}

/**
 * 選択肢のモーダルを表示し、ユーザーの選択を待つPromiseを返す
 * @param {string} title モーダルのタイトル
 * @param {Array} options 選択肢の配列 (文字列 または {label, client, project} オブジェクト)
 * @param {HTMLInputElement} inputElement - 検索機能の対象となる入力要素
 * @param {{ skipOfficeFilter?: boolean }} modalOptions - skipOfficeFilter: true で拠点フィルターを出さない（ネットの業務A用）
 * @returns {Promise<string|object>} ユーザーが選択した値（文字列またはオブジェクト）
 */
function showSelectionModal(title, options, inputElement, modalOptions = {}) {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('selection-modal');
        modal.classList.add('modal');
        const modalTitle = document.getElementById('selection-modal-title');
        const optionsContainer = document.getElementById('selection-modal-options');
        const modalContent = modal.querySelector('.modal-content');
        let viewportCleanup = null;

        // ★要望: 上端の余白を狭くする
        modalContent.style.paddingTop = '2px';

        // --- ★モーダルを閉じる共通関数 ---
        const closeModalAndCancel = () => {
            closeModalState();
            modal.style.display = "none";
            document.body.classList.remove('modal-open');
            optionsContainer.removeEventListener('click', handleSelection);
            window.onclick = null; // window.onclickもリセット
            if (typeof viewportCleanup === 'function') {
                viewportCleanup();
                viewportCleanup = null;
            }
            reject('cancelled');
        };

        // --- ★閉じるボタンの追加 ---
        let closeButton = modalContent.querySelector('.modal-close-button-common');
        if (!closeButton) {
            closeButton = document.createElement('button');
            closeButton.type = 'button';
            closeButton.className = 'modal-close-button-common';
            closeButton.innerHTML = '← 閉じる';
            modalContent.prepend(closeButton);
        }
        closeButton.onclick = closeModalAndCancel;

        // ★履歴管理に追加（戻るボタンで閉じるようにする）
        // 戻るボタンで閉じられた場合はキャンセル扱いとする
        openModalState(closeModalAndCancel);

        // モーダルの高さ調整:
        // iOS/LIFF WebView で vh が過大計算されるケースに備え、dvh + visualViewport で補正する。
        const applySelectionModalViewport = () => {
            const vv = window.visualViewport;
            const vhPx = vv && vv.height ? Math.floor(vv.height) : window.innerHeight;
            // 上下に少し余白を残し、機種差でのはみ出しを避ける
            const desired = Math.max(320, vhPx - 12);
            modalContent.style.height = `${desired}px`;
            modalContent.style.maxHeight = '92dvh';
        };
        const bindSelectionModalViewportResize = () => {
            let rafId = 0;
            const onResize = () => {
                if (rafId) cancelAnimationFrame(rafId);
                rafId = requestAnimationFrame(() => {
                    applySelectionModalViewport();
                });
            };
            applySelectionModalViewport();
            // 初回表示直後にもう一度補正（WebViewで1フレーム遅れるケース対策）
            requestAnimationFrame(() => requestAnimationFrame(applySelectionModalViewport));
            window.addEventListener('resize', onResize);
            window.addEventListener('orientationchange', onResize);
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', onResize);
                window.visualViewport.addEventListener('scroll', onResize);
            }
            return () => {
                if (rafId) cancelAnimationFrame(rafId);
                window.removeEventListener('resize', onResize);
                window.removeEventListener('orientationchange', onResize);
                if (window.visualViewport) {
                    window.visualViewport.removeEventListener('resize', onResize);
                    window.visualViewport.removeEventListener('scroll', onResize);
                }
            };
        };

        // モーダルの高さを画面いっぱいに広げるスタイル調整
        modal.style.paddingTop = '2px'; // 上部の余白を詰める
        modalContent.style.display = 'flex';
        modalContent.style.flexDirection = 'column';
        optionsContainer.style.maxHeight = 'none'; // max-height制限を解除
        optionsContainer.style.flexGrow = '1'; // 残りの領域を埋める
        optionsContainer.style.overflowY = 'auto'; // スクロール可能に

        // フィルタコンテナの取得または作成
        let filterContainer = document.getElementById('selection-modal-filters');
        if (!filterContainer) {
            filterContainer = document.createElement('div');
            filterContainer.id = 'selection-modal-filters';
            // optionsContainerの直前に挿入
            optionsContainer.parentNode.insertBefore(filterContainer, optionsContainer);
        }
        filterContainer.style.display = 'none'; // デフォルトは非表示

        // 選択状態を管理する変数
        let selectedIndex = -1;

        // 既存のスタイルを上書きするためのスタイルタグを追加
        const styleId = 'selection-modal-style';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .selection-option {
                    padding: 0.5em 0.8em !important; /* パディングを減らす */
                    margin-top: 0.2em !important; /* マージンを減らす */
                    border: 1px solid #ddd !important;
                }
                .selection-option.selected {
                    background-color: #e9f5e9 !important;
                    border-color: #397939 !important;
                    position: relative;
                }
                .selection-option.selected::after {
                    content: '✔';
                    position: absolute;
                    right: 10px;
                    top: 50%;
                    transform: translateY(-50%);
                    color: #397939;
                    font-weight: bold;
                }
                /* フィルタチップのスタイル（スマホ向けに小さめ） */
                #selection-modal-filters {
                    display: flex;
                    /* flex-wrap: wrap; */ /* 1行に収める */
                    justify-content: center; /* アイテムが伸びるので実質的な影響は少ないが中央揃えを意図 */
                    gap: 8px; /* ★要望: 誤タップ防止で間隔を少し広げる */
                    padding: 0 0 10px 0; /* ★要望: 全幅にするため左右paddingを削除 */
                    border-bottom: 1px solid #eee;
                    margin-bottom: 10px;
                }
                .filter-chip {
                    padding: 4px 8px;
                    border: 1px solid #ddd;
                    border-radius: 8px;
                    background: #f8f8f8;
                    font-size: 0.75rem; /* 小さめ */
                    color: #666;
                    cursor: pointer;
                    user-select: none;
                    text-align: center;
                    line-height: 1.2;
                    display: flex; align-items: center; justify-content: center;
                    flex-grow: 1; /* ★要望: 各ボタンが利用可能なスペースを均等に分け合う */
                }
                .filter-chip.active {
                    background-color: #06c755; /* LINE Green */
                    color: white;
                    border-color: #06c755;
                }
            `;
            document.head.appendChild(style);
        }

        modalTitle.textContent = title;
        
        // リスト描画関数
        const renderList = (items) => {
            optionsContainer.innerHTML = '';
            selectedIndex = -1; // 選択状態リセット

            if (items.length === 0) {
                optionsContainer.innerHTML = '<div style="padding:20px; text-align:center; color:#999;">該当なし</div>';
                return;
            }

            optionsContainer.innerHTML = items.map((opt, index) => {
                let displayHtml = '';
                // 元の配列(options)内でのインデックスを探す（選択時に正しいオブジェクトを返すため）
                const originalIndex = options.indexOf(opt);

                if (typeof opt === 'object' && opt.label) {
                    // オブジェクトの場合: label + client + project(先頭5文字)
                    // clientは最大8文字
                    const clientStr = opt.client || '';
                    const clientShort = clientStr.length > 8 ? clientStr.substring(0, 8) + '...' : clientStr;
                    
                    displayHtml = `
                        <div style="display: flex; align-items: baseline; width: 100%; overflow: hidden; white-space: nowrap;">
                            <strong style="flex-shrink: 0; margin-right: 8px;">${escapeHTML(opt.label)}</strong>
                            <span style="font-size: 0.85em; color: #666; display: flex; overflow: hidden; flex-grow: 1;">
                                ${opt.client ? `<span style="flex-shrink: 0; margin-right: 4px;">${escapeHTML(clientShort)}</span>` : ''}
                                ${opt.client && opt.project ? '<span style="flex-shrink: 0; margin-right: 4px;">/</span>' : ''}
                                ${opt.project ? `<span style="overflow: hidden; text-overflow: ellipsis;">${escapeHTML(opt.project)}</span>` : ''}
                            </span>
                        </div>
                    `;
                } else {
                    // 文字列の場合
                    displayHtml = escapeHTML(opt);
                }
                // data-index には元の配列のインデックスをセットする
                return `<button type="button" class="selection-option" data-index="${originalIndex}">${displayHtml}</button>`;
            }).join('');
        };

        const handleSelection = (e) => {
            const button = e.target.closest('.selection-option');
            if (button) {
                const index = button.dataset.index;
                
                // 文字列同士で比較
                if (String(selectedIndex) === String(index)) {
                    // 2回目のタップ（確定）
                    const selectedValue = options[index];
                    
                    // ★履歴管理の状態をクリア
                    closeModalState();
                    
                    modal.style.display = 'none';
                    document.body.classList.remove('modal-open');
                    optionsContainer.removeEventListener('click', handleSelection);
                    if (typeof viewportCleanup === 'function') {
                        viewportCleanup();
                        viewportCleanup = null;
                    }
                    resolve(selectedValue);
                } else {
                    // 1回目のタップ（選択）
                    // 以前の選択を解除
                    const prevSelected = optionsContainer.querySelector('.selection-option.selected');
                    if (prevSelected) {
                        prevSelected.classList.remove('selected');
                    }
                    // 新しい選択を適用
                    button.classList.add('selected');
                    selectedIndex = index;
                }
            }
        };

        // フィルタリング機能の初期化（工務のみ。ネットでは拠点フィルターは使わない）
        const hasOffices = !modalOptions.skipOfficeFilter && options.length > 0 && typeof options[0] === 'object' && Array.isArray(options[0].offices);

        if (hasOffices) {
            modalTitle.style.display = 'none'; // 見出しを非表示
            filterContainer.style.display = 'flex';
            filterContainer.innerHTML = ''; // リセット

            const filters = [
                { label: '全て', value: '全て' },
                { label: '本社<br>現場', value: '本社現場' },
                { label: '本社<br>加工', value: '本社加工' },
                { label: '四日<br>市', value: '四日市' },
                { label: '花巻', value: '花巻' },
                { label: '千歳', value: '千歳' }
            ];
            
            filters.forEach(filter => {
                const chip = document.createElement('div');
                chip.innerHTML = filter.label; // 改行タグを有効にするためinnerHTMLを使用
                chip.className = 'filter-chip';
                if (filter.value === '全て') chip.classList.add('active');

                chip.onclick = () => {
                    // アクティブ状態の更新
                    filterContainer.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                    chip.classList.add('active');
                    
                    // フィルタリング実行
                    if (filter.value === '全て') {
                        renderList(options);
                    } else {
                        const filtered = options.filter(opt => opt.offices && opt.offices.includes(filter.value));
                        renderList(filtered);
                    }
                };
                filterContainer.appendChild(chip);
            });
            
            // 初期表示（全て）
            renderList(options);
        } else {
            // ★要望: カテゴリAモーダルでもタイトルを非表示にする
            modalTitle.style.display = 'none';
            filterContainer.style.display = 'none';
            renderList(options);
        }

        optionsContainer.addEventListener('click', handleSelection);
        modal.style.display = 'block';
        document.body.classList.add('modal-open'); // 背景スクロール固定
        viewportCleanup = bindSelectionModalViewportResize();

        // モーダルの外側をクリックしたら閉じる（キャンセル扱い）
        window.onclick = (event) => {
            if (event.target == modal) closeModalAndCancel();
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
    workTimeInput.disabled = true; // 処理中は入力欄も無効化
    messageDiv.className = 'message';
    messageDiv.textContent = `[${reportDate}] のデータを取得しています...`;

    try {
        // 勤務時間と工数詳細を並行して取得
        const [workTimeResult, reportDetailsResult] = await Promise.all([
            fetchWorkTime(reportDate, 'report'), // 'report'ソースで待機あり
            fetchReportDetails(reportDate)
        ]);

        // 勤務時間を反映
        if (workTimeResult.success) {
            workTimeInput.value = workTimeResult.workTime;
        } else {
            // 勤務時間の取得に失敗しても、工数内訳の表示は試みる
            console.error("勤務時間の取得エラー:", workTimeResult.error);
        }

        // 工数内訳を反映
        initializeTaskArea(reportDetailsResult.tasks);

        messageDiv.textContent = `データを取得しました。`;
            messageDiv.className = 'message success';
    } catch (error) {
        messageDiv.textContent = `データの取得に失敗しました: ${error.message}`;
        messageDiv.className = 'message error';
    } finally {
        getWorkTimeButton.disabled = false;
        workTimeInput.disabled = false;
    }
}

/**
 * 工数入力フォームをリセットして再表示する
 */
async function resetAndShowForm() {
    // 完了画面を非表示にし、フォームを表示する
    document.getElementById('completion-screen').style.display = 'none';
    document.getElementById('report-form-wrapper').style.display = 'block';
    const messageDiv = document.getElementById('report-message');
    messageDiv.textContent = '本日のデータを読み込み中...';
    messageDiv.className = 'message';

    // フォームの値をリセット
    document.getElementById('report-form').reset();
    
    // 日付を今日に設定
    const todayStr = toLocalDateString(new Date());
    document.getElementById('report-date').value = todayStr;

    // 当日の勤務時間と工数詳細を並行して取得
    try {
        const [workTimeResult, reportDetailsResult] = await Promise.all([
            fetchWorkTime(todayStr, 'report'), // 'report'ソースで待機あり
            fetchReportDetails(todayStr)
        ]);

        if (workTimeResult.success) {
            document.getElementById('report-work').value = workTimeResult.workTime;
        } else {
            console.error("自動受信エラー:", workTimeResult.error);
        }

        initializeTaskArea(reportDetailsResult.tasks);
        updateReportStatusBadges(reportDetailsResult);
        messageDiv.textContent = ''; // 読み込み完了後メッセージをクリア
    } catch (error) {
        messageDiv.textContent = `本日のデータ読み込みに失敗しました: ${error.message}`;
        messageDiv.className = 'message error';
        initializeTaskArea(); // エラー時は空のフォームを表示
    }
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

    // 0分で送信する場合の確認
    if (allocatedMinutes === 0) {
        const isConfirmed = confirm('0分で送信しようとしています。入力済みの工数はクリアされますが、よろしいですか？');
        if (!isConfirmed) {
            submitButton.disabled = false; // 送信をキャンセルしたのでボタンを有効に戻す
            messageDiv.textContent = ''; // メッセージをクリア
            return; // 処理を中断
        }
    } else if (remainingMinutes !== 0) { // 0分以外で、差異がある場合の確認
        const isConfirmed = confirm('勤務時間と入力した工数に差異があります。このまま送信しますか？');
        if (!isConfirmed) {
            submitButton.disabled = false; // 送信をキャンセルしたのでボタンを有効に戻す
            messageDiv.textContent = ''; // メッセージをクリア
            return; // 処理を中断
        }
    }

    try {
        const tasks = [];
        if (isReportNetPage) {
            // ネット: カテゴリA/B・開始/終了・分数・comment を送信（/api/reports_net）
            document.querySelectorAll('.task-entry').forEach(entry => {
                const categoryMajor = entry.querySelector('.task-category-major');
                const categoryMinor = entry.querySelector('.task-category-minor');
                const timeInput = entry.querySelector('.task-time');
                const startEl = entry.querySelector('.task-start-time');
                const endEl = entry.querySelector('.task-end-time');
                const majorVal = categoryMajor ? categoryMajor.value : '';
                const minorVal = categoryMinor ? categoryMinor.value : '';
                const time = parseInt(timeInput ? timeInput.value : 0, 10) || 0;
                const startTime = startEl ? startEl.value : '';
                const endTime = endEl ? endEl.value : '';
                if (!majorVal || !minorVal || !startTime || !endTime) return;
                tasks.push({
                    categoryA_id: categoryMajor ? categoryMajor.dataset.id || '' : '',
                    categoryA_label: majorVal,
                    categoryB_id: categoryMinor ? categoryMinor.dataset.id || '' : '',
                    categoryB_label: minorVal,
                    time,
                    startTime,
                    endTime,
                    comment: entry.dataset.comment || ''
                });
            });
        } else {
            // 工務: 従来形式（/api/reports）
            document.querySelectorAll('.task-entry').forEach(entry => {
                const categoryMajor = entry.querySelector('.task-category-major').value;
                const categoryMajorId = entry.querySelector('.task-category-major').dataset.id || null;
                const categoryMinor = entry.querySelector('.task-category-minor').value;
                const categoryMinorId = entry.querySelector('.task-category-minor').dataset.id || null;
                const time = parseInt(entry.querySelector('.task-time').value, 10) || 0;
                if (categoryMajor && categoryMinor && time > 0) {
                    tasks.push({
                        categoryA_id: categoryMajorId,
                        categoryA_label: categoryMajor,
                        categoryB_id: categoryMinorId,
                        categoryB_label: categoryMinor,
                        time
                    });
                }
            });
        }

        const requestBody = {
            date: document.getElementById('report-date').value,
            taskTotalMinutes: allocatedMinutes,
            jobcanWorkMinutes: parseInt(document.getElementById('report-work').value, 10) || 0,
            tasks: tasks
        };
        const reportEndpoint = isReportNetPage ? `${API_BASE_URL}/api/reports_net` : `${API_BASE_URL}/api/reports`;
        const response = await fetchWithAuth(reportEndpoint, {
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
        const closingDate = closingDay;
        const startDateOfNextMonth = closingDate + 1;

        const year = reportMonthDate.getUTCFullYear();
        const month = reportMonthDate.getUTCMonth(); // 0-11

        const startDate = new Date(Date.UTC(year, month - 1, startDateOfNextMonth));
        const endDate = new Date(Date.UTC(year, month, closingDate));

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
    // 今日の日付文字列をローカルタイムゾーン基準で取得する
    // new Date() でJSTの現在時刻が取得され、toLocalDateStringでJSTの年月日が "YYYY-MM-DD" 形式になる
    const todayStr = toLocalDateString(new Date());

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
            const isOtherMonth = !dateToMonthMap[dateStr] || (dateToMonthMap[dateStr].getTime() !== currentCalendarReportMonth.getTime());

            // --- ステータス表示ロジック (dayCellDidMountから移植) ---
            let statusIndicatorHtml = '';
            let workTimeHtml = '';
            let reportedTimeHtml = '';
            let accommodationBadgeHtml = '';
            let onSiteBadgeHtml = '';

            // 当月度内かどうかの判定
            if (!isOtherMonth) {
                const statusData = calendarStatuses[dateStr];
                let statusText = undefined;
                let bgColor = '#777';
                let textColor = 'white';

                // statusDataが存在し、かつstatusがnullでない場合にバッジを判定
                if (statusData && statusData.status !== null) {
                    switch (statusData.status) {
                        case 'completed':
                            statusText = '完了';
                            bgColor = '#083969'; // 暗い青
                            break;
                        case 'inconsistent':
                            statusText = '不一致'; // より適切な表現に修正
                            bgColor = '#d9534f'; // 赤
                            break;
                        case 'pending':
                            statusText = '未入力';
                            bgColor = '#777'; // 未入力時の背景色（グレー）を明示的に設定
                            break;
                    }
                }

                // statusTextが設定された（＝表示すべきステータスがある）場合のみバッジを生成
                if (statusText) {
                    statusIndicatorHtml += `<div class="status-indicator" style="background-color: ${bgColor}; color: ${textColor};">${statusText}</div>`;
                }

                // 勤務時間と報告時間は、データがあれば常に表示する
                const jobcanMinutes = statusData?.jobcan_minutes ?? 0;
                const reportedMinutes = statusData?.reported_minutes ?? 0;
                if (jobcanMinutes > 0) {
                    workTimeHtml = `<div class="time-display work-time">勤-${jobcanMinutes}</div>`;
                }
                if (reportedMinutes > 0) {
                    reportedTimeHtml = `<div class="time-display reported-time">済-${reportedMinutes}</div>`;
                }
            }

            // 宿泊・現場バッジの生成
            if (!isOtherMonth) {
                const statusData = calendarStatuses[dateStr];
                if (statusData && statusData.has_accommodation) {
                    accommodationBadgeHtml = `<span class="calendar-badge accommodation-badge">宿</span>`;
                }
                if (statusData && statusData.on_site) {
                    const onSiteClass = statusData.on_site === 'full' ? 'full' : 'half';
                    onSiteBadgeHtml = `<span class="calendar-badge on-site-badge ${onSiteClass}">現</span>`;
                }
            }
            // --- ここまで ---

            // --- セルのクラスを決定 ---
            let cellContentClass = 'day-cell-content';
            // 月度外の日は 'other-month' スタイルでグレーアウト
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
                            <div class="day-header">
                                <span class="day-number">${day}</span>
                                <div class="badge-area">${accommodationBadgeHtml}${onSiteBadgeHtml}</div>
                            </div>
                            <div class="status-container">
                                ${statusIndicatorHtml ? `<div class="badge-container">${statusIndicatorHtml}</div>` : ''}
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

    // --- カレンダーの日付表示スタイルを調整 ---
    const styleId = 'calendar-day-style-override';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .day-header { display: flex; justify-content: space-between; align-items: baseline; }
            .badge-area { display: flex; gap: 2px; flex-shrink: 0; }
            .calendar-badge { display: inline-block; font-size: 10px; font-weight: bold; line-height: 1.2; margin-left: 1px; }
            .accommodation-badge { color: #258301; } 
            .on-site-badge.full { color: #031ae6; } 
            .on-site-badge.half { color: #8679ff; } 
            .day-number {
                font-size: 0.8em; /* 日付のフォントサイズを小さくする */
            }
            .badge-container {
                margin-bottom: 2px; /* ステータスバッジと時間表示の間隔を調整 */
            }
        `;
        document.head.appendChild(style);
    }

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

    // 2. 有休情報を取得してマージする
    // ★将来的に自動工数入力に使用する予定だが、現時点ではカレンダー表示には反映しないためコメントアウト
    /*
    try {
        const year = currentCalendarReportMonth.getUTCFullYear();
        const month = currentCalendarReportMonth.getUTCMonth(); 
        const startDate = new Date(Date.UTC(year, month - 1, closingDay + 1));
        const endDate = new Date(Date.UTC(year, month, closingDay));
        
        const fromDate = toUTCDateString(startDate);
        const toDate = toUTCDateString(endDate);

        const paidHolidays = await fetchJobcanPaidHolidays(fromDate, toDate);
        paidHolidays.forEach(h => {
            if (!calendarStatuses[h.date]) {
                calendarStatuses[h.date] = {};
            }
            calendarStatuses[h.date].paid_holiday = h.type; // 'full' or 'half'
        });
    } catch (e) {
        console.error("有休情報の取得に失敗:", e);
    }
    */

    // 3. 【重要】当日分の勤務時間をリアルタイムで取得し、カレンダーデータを上書き＆ステータスを再計算する
    const todayStr = toLocalDateString(new Date());
    // カレンダーの表示範囲に当日が含まれている場合のみ実行
    if (calendarStatuses[todayStr]) {
        const workTimeResult = await fetchWorkTime(todayStr, 'calendar'); // 呼び出し元として 'calendar' を指定
        if (workTimeResult.success) {
            // バックエンドから取得した最新の勤務時間で上書き
            calendarStatuses[todayStr].jobcan_minutes = workTimeResult.workTime;

            // 最新の勤務時間と報告時間を使って、当日のステータスを再計算する
            const jobcanMinutes = calendarStatuses[todayStr].jobcan_minutes || 0;
            const reportedMinutes = calendarStatuses[todayStr].reported_minutes; // nullの可能性があるので || 0 は使わない
            const isExecutive = cachedEmployeeInfo && cachedEmployeeInfo.is_executive === true;

            if (reportedMinutes !== null) {
                if (reportedMinutes === 0 && jobcanMinutes === 0) {
                    calendarStatuses[todayStr].status = null;
                } else if (reportedMinutes === 0 && jobcanMinutes > 0) {
                    calendarStatuses[todayStr].status = 'pending';
                } else if (isExecutive && reportedMinutes >= jobcanMinutes && reportedMinutes > 0) {
                    // 役員ロジック
                    calendarStatuses[todayStr].status = 'completed';
                } else if (!isExecutive && jobcanMinutes > 0 && jobcanMinutes === reportedMinutes) {
                    // 一般ユーザーロジック
                    calendarStatuses[todayStr].status = 'completed';
                } else {
                    calendarStatuses[todayStr].status = 'inconsistent';
                }
            } else if (jobcanMinutes > 0) {
                // 報告なし、実績あり
                calendarStatuses[todayStr].status = 'pending';
            }
        }
    }

    // 4. カレンダーのヘッダータイトルとテーブルを更新する
    const year = currentCalendarReportMonth.getUTCFullYear();
    const month = currentCalendarReportMonth.getUTCMonth() + 1;
    calendarContainer.querySelector('#calendar-title').innerText = `${year}年${month}月度`;
    calendarContainer.querySelector('#calendar-table-container').innerHTML = renderCustomCalendar();

    // 5. イベントリスナーを設定する
    setupCalendarEventListeners(calendarContainer);
}

/**
 * カレンダーの表示範囲を計算するヘルパー関数
 * @param {Date} currentDate 計算の基準となる日付
 * @returns {{start: Date, end: Date}} カレンダーの開始日と終了日
 */
function calculateVisibleRange(currentDate) {
    const closingDate = closingDay;
    const startDateOfNextMonth = closingDate + 1;

    const targetReportYear = currentDate.getUTCFullYear();
    const targetReportMonth = currentDate.getUTCMonth(); // 0-11

    // 「当月度」の期間を動的に計算
    const periodStart = new Date(Date.UTC(targetReportYear, targetReportMonth - 1, startDateOfNextMonth));
    const periodEnd = new Date(Date.UTC(targetReportYear, targetReportMonth, closingDate));

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
        // 【ロジック変更】クリック無効化のクラスチェックを削除し、すべての日付をタップ可能にする
        if (clickedCell && clickedCell.dataset.date) {
            const clickedDate = clickedCell.dataset.date;
            const todayStr = toUTCDateString(new Date());
            const statusData = calendarStatuses[clickedDate];

            // --- 【ロジック抜本変更】確認ダイアログの判定順序を整理 ---

            // 1. 未来日のチェック (最優先)
            if (clickedDate > todayStr && !confirm('未来の日付です。先行して入力しますか？')) {
                return;
            }

            // 2. 完了済みのチェック
            if (statusData && statusData.status === 'completed') {
                if (!confirm('工数入力完了しています。再入力しますか？')) {
                    return;
                }
            }

            // 3. 勤務時間0分のチェック (上記以外の場合に実行)
            const jobcanMinutes = statusData?.jobcan_minutes ?? 0;
            if (jobcanMinutes === 0) {
                if (!confirm('勤務時間が0分です。工数入力しますか？')) {
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
    const closingDate = closingDay; // 締め日
    const startDateOfNextMonth = closingDate + 1; // 翌月度の開始日

    let currentDate = new Date(Date.UTC(mapStartDate.getFullYear(), mapStartDate.getMonth(), mapStartDate.getDate()));
    while (currentDate <= mapEndDate) {
        const calendarYear = currentDate.getUTCFullYear();  // 暦年
        const calendarMonth = currentDate.getUTCMonth();    // 暦月 (0-11)
        const calendarDay = currentDate.getUTCDate();       // 暦日

        let reportMonthDate; // この日が属する「月度」の代表日
        // 締め日の翌日以降はその月の翌月度として扱う
        if (calendarDay >= startDateOfNextMonth) {
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
let closingDay = 20; // デフォルトの締め日

/**
 * ユーザー情報を表示する関数
 * @param {HTMLElement} container - 情報を表示する親コンテナ要素
 */
function displayUserInfo(container) {
    if (!container) return;

    const displayElement = container.querySelector('.user-info-bar');
    if (!displayElement) return;

    let userInfoText = 'ユーザー情報の取得に失敗しました。';
    let additionalInfoHtml = ''; // 追加情報用のHTML

    if (cachedEmployeeInfo) {
        const name = cachedEmployeeInfo.name || 'ゲスト';
        const employeeId = cachedEmployeeInfo.employeeId;

        if (employeeId) {
            userInfoText = `報告者：${name}（ID：${employeeId}）`;

            // ID登録画面の場合のみ、追加情報を生成する
            if (container.id === 'register-container') {
                // 管理者フラグの表示
                const managerStatus = cachedEmployeeInfo.is_manager === true ? 'ON' : 'OFF';
                additionalInfoHtml += `<div style="margin-top: 0.25em;">管理者フラグ：${managerStatus}</div>`;

                // メイングループの表示
                // バックエンドから渡された表示名をそのまま使う
                const groupName = cachedEmployeeInfo.main_group_name || '（未設定）';
                additionalInfoHtml += `<div style="margin-top: 0.25em;">メイングループ：${groupName}</div>`;
            }

        } else {
            userInfoText = `未登録　※ID登録してください`;
        }
    }
    // innerHTMLを使用して、基本情報と追加情報の両方を表示
    displayElement.innerHTML = `<div>${userInfoText}</div>${additionalInfoHtml}`;
}

async function main() {
    const loadingContainer = document.getElementById('loading-container');
    const loadingMessage = document.getElementById('loading-message');

    // ★共通スタイルの適用
    setupModalStyles();

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

        // --- 設定情報とユーザー情報を並行して取得 ---
        try {
            const [configResponse, userInfoResponse] = await Promise.all([
                fetchWithAuth(`${API_BASE_URL}/api/config`),
                fetchWithAuth(`${API_BASE_URL}/api/user`)
            ]);

            if (configResponse.ok) {
                const config = await configResponse.json();
                closingDay = config.closing_day || 20; // 取得した締め日を設定
            }

            if (userInfoResponse.ok) {
                employeeInfo = await userInfoResponse.json();
            } else if (userInfoResponse.status === 404) {
                employeeInfo = { name: '（ID未登録）', employeeId: null };
            }
            cachedEmployeeInfo = employeeInfo;

        } catch (e) {
            console.error("設定または社員情報の取得に失敗:", e);
            cachedEmployeeInfo = { name: '（情報取得エラー）', employeeId: null };
        }

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
        return; // 致命的なエラーなので処理を中断
    }

    // --- 締め日設定が取得できたので、日付マッピングを生成 ---
    const todayForMap = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
    const mapStartDate = new Date(Date.UTC(todayForMap.getUTCFullYear() - 5, 0, 1)); // 5年前の1月1日
    const mapEndDate = new Date(Date.UTC(todayForMap.getUTCFullYear() + 5, 11, 31)); // 5年後の12月31日
    generateDateToMonthMap(mapStartDate, mapEndDate);

    // --- ページの表示切り替え ---
    // ユーザー情報取得後に実行することで、どのページでもユーザー情報を利用できるようにする
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const page = urlParams.get('page');

        if (page === 'register') {
            // ID登録画面を表示
            document.title = "ID登録";
            const registerContainer = document.getElementById('register-container');
            
            // HTMLを文字列として取得し、DOMとして解析
            const registerHtmlString = await fetchHtmlAsString('_register.html');
            const parser = new DOMParser();
            const doc = parser.parseFromString(registerHtmlString, 'text/html');
            
            // 変更後のHTML全体をコンテナに挿入
            registerContainer.innerHTML = doc.body.innerHTML;

            // --- 管理者画面への入口を挿入 ---
            if (cachedEmployeeInfo && cachedEmployeeInfo.is_manager === true) {
                const managerButton = document.createElement('button');
                managerButton.textContent = '管理者画面へ';
                managerButton.type = 'button'; // submitを防ぐ
                managerButton.className = 'sub-button'; // 既存のスタイルを適用
                managerButton.style.backgroundColor = '#e67e22'; // 色を上書き
                managerButton.style.width = '100%'; // 幅を100%に
                managerButton.onclick = () => { window.location.href = '?page=manager'; };

                document.getElementById('register-form').insertAdjacentElement('afterend', managerButton);
            }
            registerContainer.style.display = 'block';

            displayUserInfo(registerContainer);
            document.getElementById('register-form').addEventListener('submit', handleRegisterSubmit);
        } else if (page === 'manager') {
            // 管理者画面を表示
            // 管理者でない場合はカレンダーページにリダイレクト
            if (!cachedEmployeeInfo || cachedEmployeeInfo.is_manager !== true) {
                console.warn("管理者権限がありません。カレンダー画面にリダイレクトします。");
                window.location.href = '?page=calendar';
                return; // 処理を中断
            }
            
            const view = urlParams.get('view');
            if (view === 'groups') {
                // グループ設定画面を表示
                document.title = "グループ設定";
                const container = document.getElementById('manager-container');
                const html = await fetchHtmlAsString('_manager_group_settings.html');
                container.innerHTML = html;
                container.style.display = 'block';
                displayUserInfo(container);

                // イベントリスナーを設定
                container.querySelector('#get-jobcan-groups-button').addEventListener('click', () => {
                    alert('「ジョブカンのグループ情報を取得」機能は未実装です。');
                });
                document.getElementById('back-to-manager-menu-button').addEventListener('click', () => {
                    window.location.href = '?page=manager';
                });

            } else if (view === 'categories') {
                // カテゴリ設定画面を表示
                document.title = "カテゴリ設定";
                const container = document.getElementById('manager-container');
                const html = await fetchHtmlAsString('_manager_category_settings.html');
                container.innerHTML = html;
                container.style.display = 'block';
                displayUserInfo(container);

                // 注意事項モーダルのイベントリスナーを設定
                const notesModal = document.getElementById('category-notes-modal');
                const notesTrigger = document.getElementById('category-notes-trigger');
                const notesCloseBtn = document.getElementById('category-notes-modal-close');

                if (notesModal && notesTrigger && notesCloseBtn) {
                    notesTrigger.onclick = () => { notesModal.style.display = "block"; };
                    notesCloseBtn.onclick = () => { notesModal.style.display = "none"; };
                    window.addEventListener('click', (event) => {
                        if (event.target == notesModal) {
                            notesModal.style.display = "none";
                        }
                    });
                }

                // イベントリスナーを設定
                document.getElementById('get-existing-categories-button').addEventListener('click', async () => {
                    const container = document.getElementById('category-list-container');
                    if (!container) return;

                    container.innerHTML = '<p>取得中...</p>'; // 処理中のメッセージを表示

                    try {
                        // プルダウンから選択された部署の値を取得
                        const department = document.getElementById('category-department-select').value;
                        // 部署の値をバックエンドが期待する 'kind' の値にマッピング
                        const kind = department === 'koumu' ? 'engineering' : 'net';

                        const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b?kind=${kind}`);

                        if (!response.ok) {
                            const errorData = await response.json().catch(() => ({ message: 'サーバーエラーが発生しました。' }));
                            throw new Error(errorData.message || `カテゴリの取得に失敗しました (コード: ${response.status})`);
                        }

                        const labels = await response.json();

                        if (!labels || labels.length === 0) {
                            container.innerHTML = '<p>登録されているカテゴリはありません。</p>';
                            return;
                        }

                        // チェックボックス付きのリストHTMLを生成
                        let listHtml = '<div id="category-checkbox-list">';
                        labels.forEach((category, index) => {
                            const label = category.label;
                            const isChecked = category.active ? 'checked' : '';
                            const checkboxId = `category-checkbox-${index}`;
                            listHtml += `
                                <div class="form-check" style="display: flex; align-items: center; justify-content: space-between; padding: 0.3em 0; border-bottom: 1px solid #eee;">
                                    <label class="form-check-label" for="${checkboxId}" style="font-size: 0.9em;">${escapeHTML(label)}</label>
                                    <input type="checkbox" class="form-check-input" id="${checkboxId}" data-label="${escapeHTML(label)}" ${isChecked}>
                                </div>`;
                        });
                        listHtml += '</div>';

                        container.innerHTML = listHtml;
                    } catch (error) {
                        console.error("カテゴリの取得に失敗しました:", error);
                        container.innerHTML = `<p class="error">エラー: ${error.message}</p>`;
                    }
                });
                document.getElementById('back-to-manager-menu-button-categories').addEventListener('click', () => {
                    window.location.href = '?page=manager';
                });

                // 更新ボタンのイベントリスナー
                document.getElementById('update-categories-button').addEventListener('click', async () => {
                    const checkboxes = document.querySelectorAll('#category-checkbox-list .form-check-input');
                    if (checkboxes.length === 0) {
                        alert('更新対象のカテゴリがありません。');
                        return;
                    }

                    const updates = Array.from(checkboxes).map(cb => ({
                        label: cb.dataset.label,
                        active: cb.checked
                    }));

                    const messageContainer = document.getElementById('category-list-container');
                    messageContainer.insertAdjacentHTML('beforebegin', '<p id="update-status-msg">更新中...</p>');

                    try {
                        const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b/update_status`, {
                            method: 'POST',
                            body: JSON.stringify(updates)
                        });

                        const statusMsg = document.getElementById('update-status-msg');
                        if (response.ok) {
                            statusMsg.textContent = '更新が完了しました。';
                            statusMsg.className = 'message success';
                        } else {
                            const errorData = await response.json().catch(() => ({ message: 'サーバーエラー' }));
                            throw new Error(errorData.message || `更新に失敗しました (コード: ${response.status})`);
                        }
                    } catch (error) {
                        const statusMsg = document.getElementById('update-status-msg');
                        statusMsg.textContent = `エラー: ${error.message}`;
                        statusMsg.className = 'message error';
                    } finally {
                        // 3秒後にメッセージを消す
                        setTimeout(() => {
                            const statusMsg = document.getElementById('update-status-msg');
                            if (statusMsg) statusMsg.remove();
                        }, 3000);
                    }
                });

                // カテゴリ追加ボタンのイベントリスナー
                document.getElementById('add-new-category-button').addEventListener('click', async () => {
                    const newLabel = await showInputModal(
                        "カテゴリ追加/再表示",
                        "追加/再表示したいカテゴリ名（工事番号等）を入力してください:"
                    );
                    if (!newLabel || newLabel.trim() === '') {
                        return; // 入力がないかキャンセルされた場合は終了
                    }

                    const department = document.getElementById('category-department-select').value;
                    const kind = department === 'koumu' ? 'engineering' : 'net';

                    const messageContainer = document.getElementById('category-list-container');
                    const statusMsgId = 'add-status-msg';
                    let statusMsg = document.getElementById(statusMsgId);
                    if (!statusMsg) {
                        messageContainer.insertAdjacentHTML('beforebegin', `<p id="${statusMsgId}"></p>`);
                        statusMsg = document.getElementById(statusMsgId);
                    }
                    statusMsg.textContent = 'カテゴリをチェック中...';
                    statusMsg.className = 'message';

                    try {
                        // 1. カテゴリの存在チェック
                        const checkResponse = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b/check?kind=${kind}&label=${encodeURIComponent(newLabel)}`);
                        const checkResult = await checkResponse.json();

                        switch (checkResult.status) {
                            case 'active':
                                alert(`カテゴリ「${newLabel}」は既に稼働中です。`);
                                statusMsg.textContent = ''; // メッセージをクリア
                                break;

                            case 'inactive':
                                if (confirm(`非表示カテゴリ「${newLabel}」が見つかりました。再表示しますか？`)) {
                                    statusMsg.textContent = 'カテゴリを再表示中...';
                                    const reactivateResponse = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b/reactivate`, {
                                        method: 'POST',
                                        body: JSON.stringify({ label: newLabel, kind: kind })
                                    });
                                    if (!reactivateResponse.ok) throw new Error('再表示に失敗しました。');
                                    
                                    statusMsg.textContent = 'カテゴリを再表示しました。一覧を更新します。';
                                    statusMsg.className = 'message success';
                                    document.getElementById('get-existing-categories-button').click();
                                } else {
                                    statusMsg.textContent = 'キャンセルされました。';
                                }
                                break;

                            case 'not_exists':
                                if (confirm(`カテゴリ「${newLabel}」を新規追加します。よろしいですか？`)) {
                                    statusMsg.textContent = 'カテゴリを追加中...';
                                    const createResponse = await fetchWithAuth(`${API_BASE_URL}/api/manager/categories/b/create`, {
                                        method: 'POST',
                                        body: JSON.stringify({ label: newLabel, kind: kind })
                                    });

                                    if (!createResponse.ok) {
                                        const errorData = await createResponse.json().catch(() => ({ message: 'サーバーエラー' }));
                                        throw new Error(errorData.message || `作成に失敗しました (コード: ${createResponse.status})`);
                                    }

                                    statusMsg.textContent = 'カテゴリを追加しました。一覧を更新します。';
                                    statusMsg.className = 'message success';
                                    document.getElementById('get-existing-categories-button').click();
                                } else {
                                    statusMsg.textContent = 'キャンセルされました。';
                                }
                                break;
                            
                            default:
                                throw new Error('不明なカテゴリ状態です。');
                            }

                    } catch (error) {
                        statusMsg.textContent = `エラー: ${error.message}`;
                        statusMsg.className = 'message error';
                    } finally {
                        setTimeout(() => {
                            if (statusMsg) statusMsg.remove();
                        }, 3000);
                    }
                });

            } else if (view === 'users') {
                // ユーザー設定画面を表示
                document.title = "ユーザー設定";
                const container = document.getElementById('manager-container');
                const html = await fetchHtmlAsString('_manager_user_settings.html');
                container.innerHTML = html;
                container.style.display = 'block';
                displayUserInfo(container);

                // --- Jobcanユーザー同期機能の初期化 ---
                initManagerUserSettingsPage();

                // IDを重複させないように注意
                document.getElementById('back-to-manager-menu-button-users').addEventListener('click', () => {
                    window.location.href = '?page=manager';
                });

            } else {
                // デフォルトの管理者メニューを表示
                document.title = "管理者画面";
                const container = document.getElementById('manager-container');
                const html = await fetchHtmlAsString('_manager.html');
                container.innerHTML = html;
                container.style.display = 'block';
                displayUserInfo(container);
                // グループ設定ボタンに遷移イベントを設定
                // _manager.htmlには'group-settings-button'は存在しないため、削除

                // ユーザー設定ボタンに遷移イベントを設定
                document.getElementById('user-settings-button').addEventListener('click', () => {
                    window.location.href = '?page=manager&view=users';
                });
                // カテゴリ設定ボタンに遷移イベントを設定
                document.getElementById('category-settings-button').addEventListener('click', () => {
                    // グループ設定は未実装のため、カテゴリ設定に直接遷移させる
                     window.location.href = '?page=manager&view=categories';
                });

                // --- 速報値(日次データ)集計ボタンのイベントリスナー ---
                const dataExportButton = document.getElementById('data-export-button');
                if (dataExportButton) {
                    dataExportButton.addEventListener('click', async () => {
                        const managerMessage = document.getElementById('manager-message');
                        if (!managerMessage) return;

                        // モーダル要素を取得
                        const modal = document.getElementById('group-selection-modal');
                        const listContainer = document.getElementById('group-selection-list');
                        const okButton = document.getElementById('group-selection-ok');
                        const cancelButton = document.getElementById('group-selection-cancel');
                        const closeSpan = document.getElementById('group-selection-modal-close');

                        if (!modal) {
                            console.error('Group selection modal not found.');
                            return;
                        }

                        // モーダルを表示してグループ一覧を取得
                        modal.classList.add('modal');
                        modal.style.display = 'block';
                        listContainer.innerHTML = '<p>グループ情報を取得中...</p>';

                        try {
                            const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/groups`);
                            if (!response.ok) {
                                throw new Error('グループ情報の取得に失敗しました');
                            }
                            const groups = await response.json();

                            // 自分のメイングループID
                            const myGroupId = (cachedEmployeeInfo && cachedEmployeeInfo.main_group != null) 
                                ? parseInt(cachedEmployeeInfo.main_group, 10) 
                                : null;

                            // 並び順の定義 (8>7>4>5>6>3)
                            const customOrder = [8, 7, 4, 5, 6, 3];

                            // ソート処理
                            groups.sort((a, b) => {
                                const idA = parseInt(a.id, 10);
                                const idB = parseInt(b.id, 10);

                                // 1. 自分のグループを最優先 (一番上)
                                if (myGroupId !== null) {
                                    if (idA === myGroupId) return -1;
                                    if (idB === myGroupId) return 1;
                                }

                                // 2. 指定された順序に従う
                                const indexA = customOrder.indexOf(idA);
                                const indexB = customOrder.indexOf(idB);

                                if (indexA !== -1 && indexB !== -1) {
                                    return indexA - indexB;
                                }
                                // 指定リストにあるものを優先
                                if (indexA !== -1) return -1;
                                if (indexB !== -1) return 1;

                                // 3. その他はID昇順
                                return idA - idB;
                            });

                            let html = '';
                            
                            // 日付選択フィールドを追加 (デフォルトは当日)
                            const todayStr = toLocalDateString(new Date());
                            // 日付項目も2列レイアウトに変更
                            html += `
                                <div style="margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 10px;">
                                    <label style="display: block; margin-bottom: 5px; font-weight: bold; font-size: 0.9em;">対象日付</label>
                                    <div style="display: flex; gap: 15px; align-items: center;">
                                        <div style="flex: 1;">
                                            <input type="date" id="report-target-date" value="${todayStr}" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                                        </div>
                                        <div style="flex: 1; display: flex; align-items: center;">
                                            <label style="cursor: pointer; display: flex; align-items: center;">
                                                <input type="checkbox" id="report-monthly-checkbox" style="margin-right: 8px;">
                                                <span style="font-size: 0.9em;">月度内一括</span>
                                            </label>
                                        </div>
                                    </div>
                                </div>
                            `;

                            // 2列レイアウトの開始
                            html += '<div style="display: flex; gap: 15px;">';

                            // --- 左列: 個別グループ ---
                            html += '<div style="flex: 1;">';
                            html += '<div style="font-weight: bold; margin-bottom: 10px; font-size: 0.9em; border-bottom: 1px solid #ddd;">個別グループ</div>';

                            if (groups.length === 0) {
                                html += '<p>グループが見つかりません。</p>';
                            } else {
                                groups.forEach(group => {
                                    const groupIdNum = parseInt(group.id, 10);
                                    const isChecked = (myGroupId !== null && groupIdNum === myGroupId) ? 'checked' : '';
                                    html += `
                                        <div style="margin-bottom: 8px;">
                                            <label style="display: flex; align-items: center; cursor: pointer;">
                                                <input type="radio" name="target-group" value="${group.id}" ${isChecked} style="margin-right: 8px;">
                                                <span style="font-size: 0.9em;">${escapeHTML(group.name)}</span>
                                            </label>
                                        </div>
                                    `;
                                });
                            }
                            html += '</div>'; // 左列終了

                            // --- 右列: 一括集計 ---
                            html += '<div style="flex: 1; border-left: 1px solid #eee; padding-left: 15px;">';
                            html += '<div style="font-weight: bold; margin-bottom: 10px; font-size: 0.9em; border-bottom: 1px solid #ddd;">一括集計</div>';
                            
                            // 工務_全体 (4,5,6,7,8)
                            html += `
                                <div style="margin-bottom: 8px;">
                                    <label style="display: flex; align-items: center; cursor: pointer;">
                                        <input type="radio" name="target-group" value="4,5,6,7,8" style="margin-right: 8px;">
                                        <span style="font-size: 0.9em;">工務_全体</span>
                                    </label>
                                </div>
                            `;
                            // 工務_本社 (7,8)
                            html += `
                                <div style="margin-bottom: 8px;">
                                    <label style="display: flex; align-items: center; cursor: pointer;">
                                        <input type="radio" name="target-group" value="7,8" style="margin-right: 8px;">
                                        <span style="font-size: 0.9em;">工務_本社</span>
                                    </label>
                                </div>
                            `;
                            html += '</div>'; // 右列終了
                            
                            html += '</div>'; // Flexコンテナ終了

                            listContainer.innerHTML = html;

                            // 月度内一括チェックボックスの制御
                            const monthlyCheckbox = document.getElementById('report-monthly-checkbox');
                            const dateInput = document.getElementById('report-target-date');

                            if (monthlyCheckbox && dateInput) {
                                monthlyCheckbox.addEventListener('change', (e) => {
                                    if (e.target.checked) {
                                        dateInput.disabled = true;
                                        dateInput.style.backgroundColor = '#eee';
                                        dateInput.style.color = '#aaa';
                                    } else {
                                        dateInput.disabled = false;
                                        dateInput.style.backgroundColor = '';
                                        dateInput.style.color = '';
                                    }
                                });
                            }

                            // デフォルト選択がない場合、先頭を選択
                            const radios = listContainer.querySelectorAll('input[name="target-group"]');
                            if (radios.length > 0 && !listContainer.querySelector('input[name="target-group"]:checked')) {
                                radios[0].checked = true;
                            }

                        } catch (error) {
                            console.error(error);
                            listContainer.innerHTML = `<p class="error">エラー: ${error.message}</p>`;
                        }

                        // モーダルを閉じる関数
                        const closeModal = () => {
                            modal.style.display = 'none';
                        };

                        // イベントリスナー設定
                        cancelButton.onclick = closeModal;
                        closeSpan.onclick = closeModal;
                        window.onclick = (event) => {
                            if (event.target == modal) closeModal();
                        };

                        okButton.onclick = async () => {
                            const selectedRadio = listContainer.querySelector('input[name="target-group"]:checked');
                            
                            // ボタン押下時に最新のDOM要素を取得する
                            const currentDateInput = document.getElementById('report-target-date');
                            const currentMonthlyCheckbox = document.getElementById('report-monthly-checkbox');
                            
                            if (!selectedRadio) {
                                alert('グループを選択してください。');
                                return;
                            }

                            const selectedDate = currentDateInput ? currentDateInput.value : null;
                            if (!selectedDate) {
                                alert('日付を選択してください。');
                                return;
                            }

                            const selectedGroupId = selectedRadio.value;
                            const isMonthly = currentMonthlyCheckbox ? currentMonthlyCheckbox.checked : false;
                            
                            closeModal();

                            // 集計処理開始
                            const originalText = dataExportButton.textContent;
                            dataExportButton.disabled = true;
                            dataExportButton.textContent = 'CSV生成中...';
                            managerMessage.textContent = '';
                            managerMessage.className = 'message';

                            try {
                                const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/prepare-report-csv`, {
                                    method: 'POST',
                                    body: JSON.stringify({
                                        group_id: selectedGroupId, // 選択されたグループIDを送信
                                        date: selectedDate,        // 選択された日付を送信
                                        is_monthly: isMonthly      // 月度内一括フラグを送信
                                    })
                                });

                                if (!response.ok) {
                                    const result = await response.json().catch(() => ({}));
                                    const errorMessage = result.description || result.message || `サーバーエラー (コード: ${response.status})`;
                                    throw new Error(errorMessage);
                                }

                                const result = await response.json();

                                if (result.count === 0) {
                                    // データなしの場合
                                    managerMessage.textContent = '指定された条件に該当するデータはありませんでした。';
                                    managerMessage.className = 'message'; // 通常色（黒）または注意色
                                } else {
                                    // データありの場合
                                    managerMessage.innerHTML = `集計が完了しました（${result.count}件）。<br>PCのブックマークからダウンロードしてください。<br>※このURLで常に最新の集計結果を取得できます。`;
                                    managerMessage.classList.add('success');
                                }

                            } catch (error) {
                                console.error('CSV作成エラー:', error);
                                managerMessage.textContent = `エラー: ${error.message}`;
                                managerMessage.classList.add('error');
                            } finally {
                                dataExportButton.disabled = false;
                                dataExportButton.textContent = originalText;
                            }
                        };
                    });
                }
            }

        } else if (page === 'calendar') {
            // カレンダー画面を表示
            document.title = "カレンダー";
            const calendarHtml = await fetchHtmlAsString('_calendar.html');
            const calendarContainer = document.getElementById('calendar-container');
            calendarContainer.innerHTML = calendarHtml;
            calendarContainer.style.display = 'block';

            // ★修正: URLパラメータから月度情報を取得し、currentCalendarReportMonthを設定
            const monthParam = urlParams.get('month');
            if (monthParam && /^\d{4}-\d{2}-\d{2}$/.test(monthParam)) {
                // YYYY-MM-DD形式の文字列をUTCのDateオブジェクトに変換
                currentCalendarReportMonth = new Date(monthParam + 'T00:00:00Z');
            }

            // --- カレンダー画面のレイアウト調整 ---
            const prevBtn = document.getElementById('prev-month-button');
            const nextBtn = document.getElementById('next-month-button');
            
            // ヘッダーのレイアウト調整 (左右端に配置)
            if (prevBtn && prevBtn.parentElement) {
                const header = prevBtn.parentElement;
                header.style.display = 'flex';
                header.style.justifyContent = 'space-between';
                header.style.alignItems = 'center';
            }

            // タイトルのフォントサイズ調整
            const titleEl = document.getElementById('calendar-title');
            if (titleEl) {
                titleEl.style.fontSize = '1.2rem';
                titleEl.style.margin = '0';
                titleEl.style.lineHeight = '32px';
            }

            // ボタンの共通スタイル（高さ固定、Flexboxで中央揃え）
            const btnStyleBase = "color: white; border: none; border-radius: 4px; padding: 0 10px; font-size: 0.9rem; cursor: pointer; height: 32px; display: flex; align-items: center; justify-content: center; margin: 0; box-sizing: border-box;";

            if (prevBtn) {
                prevBtn.innerText = '<前';
                prevBtn.style.cssText = btnStyleBase + "background-color: #555;";
            }
            if (nextBtn) {
                nextBtn.innerText = '次>';
                nextBtn.style.cssText = btnStyleBase + "background-color: #555;";

                // 有休反映ボタンの作成と挿入（ラベルは「更新」に変更）
                const syncBtn = document.createElement('button');
                syncBtn.id = 'sync-holidays-button';
                syncBtn.innerText = '更新';
                syncBtn.className = 'sub-button'; // 既存のスタイルクラスがあれば利用
                // スタイル調整: 暗いグリーン、マージンなど
                syncBtn.style.cssText = btnStyleBase + "background-color: #006400; margin: 0 5px;";
                
                syncBtn.onclick = handleSyncPaidHolidays;

                // 「次＞」ボタンの前に挿入
                if (nextBtn.parentNode) {
                    nextBtn.parentNode.insertBefore(syncBtn, nextBtn);
                }
            }

            // ★修正: currentCalendarReportMonthが未設定の場合のみ、当月度をセット
            if (!currentCalendarReportMonth) {
                const today = new Date();
                const todayString = toUTCDateString(today);
                currentCalendarReportMonth = dateToMonthMap[todayString] || new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
            }

            setTimeout(async () => {
                await initializeCalendarScreen(calendarContainer);
            }, 0);
        } else {
            // デフォルトまたは page=report の場合は工数入力画面を表示
            // main_group が 3（数値）または '3'（文字列）のときのみネット用コピー画面を表示
            const mg = cachedEmployeeInfo && cachedEmployeeInfo.main_group;
            const isNetGroup = mg === 3 || mg === '3';
            if (isNetGroup) {
                await showReportPageNet(urlParams);
            } else {
                await showReportPage(urlParams);
            }
        }

        loadingContainer.style.display = 'none'; // コンテンツの準備ができてからローディング表示を消す

    } catch (error) {
        console.error('Page rendering failed', error);
        const loadingMessage = document.getElementById('loading-message');
        loadingMessage.innerText = `ページの表示に失敗しました: ${error.message}`;
        loadingMessage.className = 'message error';
        document.getElementById('loading-container').style.display = 'block';
    }
}

/**
 * 管理者画面（ユーザー設定）の初期化処理
 */
function initManagerUserSettingsPage() {
    const getJobcanUsersButton = document.getElementById('get-jobcan-users-button');
    const resultsContainer = document.getElementById('jobcan-user-sync-results');

    if (getJobcanUsersButton) {
        getJobcanUsersButton.addEventListener('click', fetchUnmappedEmployees);
    }

    /**
     * 未マッピングの従業員を取得して表示する
     */
    async function fetchUnmappedEmployees() {
        getJobcanUsersButton.disabled = true;
        getJobcanUsersButton.textContent = '検索中...';
        resultsContainer.innerHTML = ''; // 結果をクリア

        try {
            const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/employees/check-unmapped`);
            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.message || `サーバーエラー (コード: ${response.status})`);
            }
            const result = await response.json();
            const unmappedEmployees = result.unmapped;
            const totalEmployees = result.total;

            if (unmappedEmployees.length === 0) {
                resultsContainer.innerHTML = `<p class="sync-message success">ジョブカンユーザー${totalEmployees}名分、全員システムに登録済みでした。</p>`;
            } else {
                renderUserTable(unmappedEmployees);
            }
        } catch (error) {
            console.error('未登録ユーザーの取得に失敗しました:', error);
            resultsContainer.innerHTML = `<p class="sync-message error">エラー: ${error.message}</p>`;
        } finally {
            getJobcanUsersButton.disabled = false;
            getJobcanUsersButton.textContent = 'ジョブカンのユーザー情報を取得';
        }
    }

    /**
     * ユーザーリストのテーブルを描画する
     * @param {Array} employees - 未登録の従業員リスト
     */
    function renderUserTable(employees) {
        const tableRows = employees.map(emp => `
            <tr data-jobcan-id="${escapeHTML(emp.jobcan_employee_id)}" data-name="${escapeHTML(emp.name)}">
                <td>${escapeHTML(emp.jobcan_employee_id)}</td>
                <td>${escapeHTML(emp.name)}</td>
                <td>
                    <input type="text" class="company-id-input" placeholder="半角数字6桁" maxlength="6" inputmode="numeric">
                </td>
                <td>
                    <button type="button" class="sub-button btn-register">登録</button>
                </td>
            </tr>
        `).join('');

        resultsContainer.innerHTML = `
            <table class="sync-table">
                <thead>
                    <tr>
                        <th>Jobcan ID</th>
                        <th>氏名</th>
                        <th>社内ID</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
        `;

        // 各「登録」ボタンにイベントリスナーを設定
        resultsContainer.querySelectorAll('.btn-register').forEach(button => {
            button.addEventListener('click', handleRegisterClick);
        });
    }

    /**
     * 「登録」ボタンクリック時の処理
     * @param {Event} event - クリックイベント
     */
    async function handleRegisterClick(event) {
        const button = event.target;
        const row = button.closest('tr');
        const jobcanId = row.dataset.jobcanId;
        const name = row.dataset.name;
        const companyIdInput = row.querySelector('.company-id-input');
        const companyId = companyIdInput.value.trim();

        if (!/^\d{6}$/.test(companyId)) {
            alert('社内IDは半角数字6桁で入力してください。');
            companyIdInput.focus();
            return;
        }

        button.disabled = true;
        button.textContent = '登録中...';

        try {
            const payload = {
                company_employee_id: companyId,
                jobcan_employee_id: jobcanId,
                name: name
            };

            const response = await fetchWithAuth(`${API_BASE_URL}/api/manager/employees/create-mapping`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.message || `登録に失敗しました (コード: ${response.status})`);
            }

            alert(`「${name}」さんを非管理者、在籍中で登録しました。`);
            row.remove(); // 成功したらテーブルから行を削除

        } catch (error) {
            alert(`エラー: ${error.message}`);
            button.disabled = false;
            button.textContent = '登録';
        }
    }
}

/**
 * テキスト入力モーダルを表示し、ユーザーの入力を待つPromiseを返す
 * @param {string} title モーダルのタイトル
 * @param {string} message プロンプトメッセージ
 * @returns {Promise<string|null>} ユーザーが入力した値、またはキャンセルされた場合はnull
 */
function showInputModal(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('category-input-modal');
        modal.classList.add('modal');
        const modalTitle = document.getElementById('category-input-modal-title');
        const inputText = document.getElementById('category-input-text');
        const okButton = document.getElementById('category-input-ok-button');
        const cancelButton = document.getElementById('category-input-cancel-button');

        // ★履歴管理に追加
        const handleBackClose = () => {
            cleanup();
            resolve(null);
        };
        openModalState(handleBackClose);

        modalTitle.textContent = title;
        inputText.value = ''; // 毎回クリアする

        // 全角を半角に変換する入力イベント
        const onInput = () => {
            inputText.value = inputText.value.replace(/[！-～]/g, (s) =>
                String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
            );
        };
        inputText.addEventListener('input', onInput);

        const cleanup = () => {
            // ★履歴管理の状態をクリア
            closeModalState();
            modal.style.display = 'none';
            document.body.classList.remove('modal-open');
            okButton.onclick = null;
            cancelButton.onclick = null;
            window.onclick = null;
            inputText.removeEventListener('input', onInput);
        };

        okButton.onclick = () => {
            // cleanup内でcloseModalStateを呼ぶため、ここでは直接cleanupを呼ぶ前に値を取得
            const val = inputText.value.trim();
            cleanup();
            resolve(val);
        };

        cancelButton.onclick = () => {
            cleanup();
            resolve(null);
        };
        modal.style.display = 'block';
        document.body.classList.add('modal-open');
    });
}

/**
 * 文字列をHTMLエスケープする
 * @param {string} str エスケープする文字列
 * @returns {string} エスケープされた文字列
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
 * 工数入力画面の表示と初期化を行う
 * @param {URLSearchParams} urlParams 
 */
async function showReportPage(urlParams) {
    isReportNetPage = false;
    document.title = "工数入力";

    const reportHtml = await fetchHtmlAsString('_report.html');
    const reportContainer = document.getElementById('report-container');
    reportContainer.style.display = 'block';
    reportContainer.innerHTML = reportHtml;

    const dateParam = urlParams.get('date');
    const targetDate = dateParam || toUTCDateString(new Date());
    document.getElementById('report-date').value = targetDate;

    document.getElementById('report-form').addEventListener('submit', handleReportSubmit);
    document.getElementById('get-work-time-button').addEventListener('click', handleGetWorkTime);

    // 送信ボタンの下に「出勤簿へ戻る」ボタンを追加（右寄せ・グレー）
    const submitBtn = document.getElementById('submit-button');
    if (submitBtn) {
        const backBtnContainer = document.createElement('div');
        backBtnContainer.style.display = 'flex';
        backBtnContainer.style.width = '100%';
        backBtnContainer.style.justifyContent = 'flex-end'; // 右寄せ
        backBtnContainer.style.marginTop = '5px';

        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.textContent = '出勤簿へ戻る';
        backBtn.className = submitBtn.className; // 送信ボタンと同じスタイルクラスを継承
        backBtn.style.backgroundColor = '#777'; // グレー
        backBtn.style.borderColor = '#777';
        backBtn.style.color = 'white';
        backBtn.style.width = '45%'; 
        backBtn.style.paddingLeft = '15px';
        backBtn.style.paddingRight = '15px';

        backBtn.onclick = () => {
            // カレンダーに戻る処理（「続けて入力」と同様のロジック）
            const reportedDateStr = document.getElementById('report-date').value;
            let targetMonthStr = '';
            if (reportedDateStr && dateToMonthMap[reportedDateStr]) {
                targetMonthStr = toUTCDateString(dateToMonthMap[reportedDateStr]);
            }
            const url = targetMonthStr ? `?page=calendar&month=${targetMonthStr}` : '?page=calendar';
            window.location.href = url;
        };

        backBtnContainer.appendChild(backBtn);
        const formWrapper = document.getElementById('report-form-wrapper');
        if (formWrapper) {
            formWrapper.appendChild(backBtnContainer);
        }
    }

    document.getElementById('add-task-button').addEventListener('click', () => {
        const newEntry = addTaskEntry(lastDeletedTask);
        lastDeletedTask = null;
        updateWorkTimeSummary();
        focusAndRevealNewTaskEntry(newEntry);
    });
    const submitAddTaskButton = document.getElementById('submit-add-task-button');
    if (submitAddTaskButton) {
        submitAddTaskButton.addEventListener('click', () => {
            document.getElementById('add-task-button').click();
        });
    }

    const addTaskButton = document.getElementById('add-task-button');
    if (addTaskButton && !document.getElementById('ui-toggle-button')) {
        const uiToggleButton = document.createElement('button');
        uiToggleButton.type = 'button';
        uiToggleButton.id = 'ui-toggle-button';
        uiToggleButton.className = 'ui-toggle-button';
        uiToggleButton.textContent = 'UI';
        uiToggleButton.classList.add('active');
        uiToggleButton.addEventListener('click', () => {
            const isActive = uiToggleButton.classList.toggle('active');
            console.log(`スライド入力モード: ${isActive}`);
        });
        addTaskButton.parentNode.insertBefore(uiToggleButton, addTaskButton);
    }
    document.getElementById('report-work').addEventListener('input', updateWorkTimeSummary);

    // ★要望: 「続けて入力する」ボタンで、入力していた月度のカレンダーに戻るように変更
    document.getElementById('continue-button').addEventListener('click', () => {
        // 完了画面を非表示
        document.getElementById('completion-screen').style.display = 'none';

        // ローディング画面を表示
        const loadingContainer = document.getElementById('loading-container');
        const loadingMessage = document.getElementById('loading-message');
        loadingContainer.style.display = 'block';
        loadingMessage.innerText = 'カレンダーに戻っています...';

        // 報告した日付を取得し、その日付が属する「月度」をグローバル変数に設定
        const reportedDateStr = document.getElementById('report-date').value;
        let targetMonthStr = '';
        if (reportedDateStr && dateToMonthMap[reportedDateStr]) {
            targetMonthStr = toUTCDateString(dateToMonthMap[reportedDateStr]);
        }
        const url = targetMonthStr ? `?page=calendar&month=${targetMonthStr}` : '?page=calendar';
        window.location.href = url;
    });
    document.getElementById('close-button').addEventListener('click', () => liff.closeWindow());

    const modal = document.getElementById('work-time-notes-modal');
    const openBtn = document.getElementById('work-time-notes-trigger');
    const sliderModal = document.getElementById('time-slider-modal');
    const timeSlider = document.getElementById('time-slider');
    const sliderValueDisplay = document.getElementById('slider-value-display');

    timeSlider.addEventListener('input', () => {
        sliderValueDisplay.textContent = `${timeSlider.value} 分`;
    });

    document.getElementById('slider-step-up').addEventListener('click', () => {
        let currentValue = parseInt(timeSlider.value, 10);
        let currentMax = parseInt(timeSlider.max, 10);
        const newValue = currentValue + 15;
        if (newValue > currentMax) {
            timeSlider.max = newValue;
        }
        timeSlider.value = newValue;
        sliderValueDisplay.textContent = `${newValue} 分`;
    });

    document.getElementById('slider-step-down').addEventListener('click', () => {
        let currentValue = parseInt(timeSlider.value, 10);
        let newValue = currentValue - 15;
        if (newValue < 0) newValue = 0;
        timeSlider.value = newValue;
        sliderValueDisplay.textContent = `${newValue} 分`;
    });

    document.getElementById('slider-ok-button').addEventListener('click', () => {
        if (activeSliderInput) {
            activeSliderInput.value = timeSlider.value;
            updateWorkTimeSummary();
        }
        hideSliderModal();
    });

    document.getElementById('slider-cancel-button').addEventListener('click', hideSliderModal);
    sliderModal.addEventListener('click', (e) => { if (e.target === sliderModal) hideSliderModal(); });

    const closeBtn = document.getElementById('modal-close-button');
    if (modal && openBtn && closeBtn) {
        // モーダルを閉じる共通処理
        const closeNotesModal = () => {
            closeModalState(); // 履歴を戻す
            modal.style.display = "none";
            document.body.classList.remove('modal-open');
        };

        openBtn.onclick = () => {
            openModalState(closeNotesModal); // 履歴を追加
            modal.classList.add('modal');
            modal.style.display = "block";
            document.body.classList.add('modal-open');
        };
        closeBtn.onclick = closeNotesModal;
        window.onclick = (event) => {
            if (event.target == modal) {
                closeNotesModal();
            }
        };
    }

    setupCategoryDatalists();

    const [workTimeResult, reportDetailsResult] = await Promise.all([
        fetchWorkTime(targetDate),
        fetchReportDetails(targetDate)
    ]);

    displayUserInfo(reportContainer);
    if (workTimeResult.success) {
        document.getElementById('report-work').value = workTimeResult.workTime;
        updateWorkTimeSummary();
    } else {
        console.error("自動受信エラー:", workTimeResult.error);
    }

    initializeTaskArea(reportDetailsResult.tasks);
    updateReportStatusBadges(reportDetailsResult);
}

/**
 * 工数入力画面（ネット事業部・main_group=3 用コピー）の表示と初期化を行う
 * @param {URLSearchParams} urlParams
 */
async function showReportPageNet(urlParams) {
    isReportNetPage = true;
    document.title = "工数入力（ネット）";

    const reportHtml = await fetchHtmlAsString('_report_net.html');
    const reportNetContainer = document.getElementById('report-net-container');
    reportNetContainer.style.display = 'block';
    reportNetContainer.innerHTML = reportHtml;

    const dateParam = urlParams.get('date');
    const targetDate = dateParam || toUTCDateString(new Date());
    document.getElementById('report-date').value = targetDate;

    document.getElementById('report-form').addEventListener('submit', handleReportSubmit);
    document.getElementById('get-work-time-button').addEventListener('click', handleGetWorkTime);

    const submitBtn = document.getElementById('submit-button');
    if (submitBtn) {
        const backBtnContainer = document.createElement('div');
        backBtnContainer.style.display = 'flex';
        backBtnContainer.style.width = '100%';
        backBtnContainer.style.justifyContent = 'flex-end';
        backBtnContainer.style.marginTop = '5px';

        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.textContent = '出勤簿へ戻る';
        backBtn.className = submitBtn.className;
        backBtn.style.backgroundColor = '#777';
        backBtn.style.borderColor = '#777';
        backBtn.style.color = 'white';
        backBtn.style.width = '45%';
        backBtn.style.paddingLeft = '15px';
        backBtn.style.paddingRight = '15px';

        backBtn.onclick = () => {
            const reportedDateStr = document.getElementById('report-date').value;
            let targetMonthStr = '';
            if (reportedDateStr && dateToMonthMap[reportedDateStr]) {
                targetMonthStr = toUTCDateString(dateToMonthMap[reportedDateStr]);
            }
            const url = targetMonthStr ? `?page=calendar&month=${targetMonthStr}` : '?page=calendar';
            window.location.href = url;
        };

        backBtnContainer.appendChild(backBtn);
        const formWrapper = document.getElementById('report-form-wrapper');
        if (formWrapper) {
            formWrapper.appendChild(backBtnContainer);
        }
    }

    document.getElementById('add-task-button').addEventListener('click', () => {
        let newEntry = null;
        if (lastDeletedTask) {
            newEntry = addTaskEntry(lastDeletedTask);
            lastDeletedTask = null;
        } else {
            const entries = document.querySelectorAll('#task-entries-container .task-entry');
            let prevEnd = '';
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i];
                const endInput = entry.querySelector('.task-end-time');
                const endVal = (endInput && endInput.value) || entry.dataset.endTime || '';
                if (endVal) {
                    prevEnd = endVal;
                    break;
                }
            }
            newEntry = addTaskEntry(prevEnd ? { startTime: prevEnd } : null);
        }
        updateWorkTimeSummary();
        focusAndRevealNewTaskEntry(newEntry);
    });
    const submitAddTaskButton = document.getElementById('submit-add-task-button');
    if (submitAddTaskButton) {
        submitAddTaskButton.addEventListener('click', () => {
            document.getElementById('add-task-button').click();
        });
    }

    const addTaskButton = document.getElementById('add-task-button');
    if (addTaskButton && !document.getElementById('ui-toggle-button')) {
        const uiToggleButton = document.createElement('button');
        uiToggleButton.type = 'button';
        uiToggleButton.id = 'ui-toggle-button';
        uiToggleButton.className = 'ui-toggle-button';
        uiToggleButton.textContent = 'UI';
        uiToggleButton.classList.add('active');
        uiToggleButton.addEventListener('click', () => {
            uiToggleButton.classList.toggle('active');
        });
        addTaskButton.parentNode.insertBefore(uiToggleButton, addTaskButton);

        const lunchButton = document.createElement('button');
        lunchButton.type = 'button';
        lunchButton.id = 'lunch-preset-button';
        lunchButton.className = 'ui-toggle-button';
        lunchButton.textContent = '昼';
        lunchButton.title = '昼休憩の行を追加';
        lunchButton.addEventListener('click', () => {
            const newEntry = addTaskEntry({
                categoryA_id: 'N99',
                categoryA_label: '昼休憩',
                categoryB_id: 'n_break',
                categoryB_label: '休憩',
                comment: '昼休憩',
                startTime: '12:00',
                endTime: '13:00',
                time: 0
            });
            updateWorkTimeSummary();
            focusAndRevealNewTaskEntry(newEntry);
        });
        addTaskButton.parentNode.insertBefore(lunchButton, addTaskButton);
    }
    document.getElementById('report-work').addEventListener('input', updateWorkTimeSummary);

    document.getElementById('continue-button').addEventListener('click', () => {
        document.getElementById('completion-screen').style.display = 'none';
        const loadingContainer = document.getElementById('loading-container');
        const loadingMessage = document.getElementById('loading-message');
        loadingContainer.style.display = 'block';
        loadingMessage.innerText = 'カレンダーに戻っています...';
        const reportedDateStr = document.getElementById('report-date').value;
        let targetMonthStr = '';
        if (reportedDateStr && dateToMonthMap[reportedDateStr]) {
            targetMonthStr = toUTCDateString(dateToMonthMap[reportedDateStr]);
        }
        const url = targetMonthStr ? `?page=calendar&month=${targetMonthStr}` : '?page=calendar';
        window.location.href = url;
    });
    document.getElementById('close-button').addEventListener('click', () => liff.closeWindow());

    const modal = document.getElementById('work-time-notes-modal');
    const openBtn = document.getElementById('work-time-notes-trigger');
    const sliderModal = document.getElementById('time-slider-modal');
    const timeSlider = document.getElementById('time-slider');
    const sliderValueDisplay = document.getElementById('slider-value-display');

    timeSlider.addEventListener('input', () => {
        sliderValueDisplay.textContent = `${timeSlider.value} 分`;
    });

    document.getElementById('slider-step-up').addEventListener('click', () => {
        let currentValue = parseInt(timeSlider.value, 10);
        let currentMax = parseInt(timeSlider.max, 10);
        const newValue = currentValue + 15;
        if (newValue > currentMax) timeSlider.max = newValue;
        timeSlider.value = newValue;
        sliderValueDisplay.textContent = `${newValue} 分`;
    });

    document.getElementById('slider-step-down').addEventListener('click', () => {
        let currentValue = parseInt(timeSlider.value, 10);
        let newValue = currentValue - 15;
        if (newValue < 0) newValue = 0;
        timeSlider.value = newValue;
        sliderValueDisplay.textContent = `${newValue} 分`;
    });

    document.getElementById('slider-ok-button').addEventListener('click', () => {
        if (activeSliderInput) {
            activeSliderInput.value = timeSlider.value;
            updateWorkTimeSummary();
        }
        hideSliderModal();
    });

    document.getElementById('slider-cancel-button').addEventListener('click', hideSliderModal);
    sliderModal.addEventListener('click', (e) => { if (e.target === sliderModal) hideSliderModal(); });

    const closeBtn = document.getElementById('modal-close-button');
    if (modal && openBtn && closeBtn) {
        const closeNotesModal = () => {
            closeModalState();
            modal.style.display = "none";
            document.body.classList.remove('modal-open');
        };
        openBtn.onclick = () => {
            openModalState(closeNotesModal);
            modal.classList.add('modal');
            modal.style.display = "block";
            document.body.classList.add('modal-open');
        };
        closeBtn.onclick = closeNotesModal;
        window.onclick = (event) => {
            if (event.target == modal) closeNotesModal();
        };
    }

    setupCategoryDatalists();

    const [workTimeResult, reportDetailsResult] = await Promise.all([
        fetchWorkTime(targetDate),
        fetchReportDetails(targetDate)
    ]);

    displayUserInfo(reportNetContainer);
    if (workTimeResult.success) {
        document.getElementById('report-work').value = workTimeResult.workTime;
        updateWorkTimeSummary();
    } else {
        console.error("自動受信エラー:", workTimeResult.error);
    }

    initializeTaskArea(reportDetailsResult.tasks);
    updateReportStatusBadges(reportDetailsResult);
}

/**
 * 有休情報をJobcanから取得して日報に反映する（ボタンラベルは「更新」）
 */
async function handleSyncPaidHolidays() {
    if (!confirm("Jobcanから有休情報を取得し、日報データに反映しますか？\n※表示中の月度が対象です。")) return;

    const btn = document.getElementById('sync-holidays-button');
    const originalText = btn ? btn.innerText : '更新';
    
    try {
        if (btn) {
            btn.disabled = true;
            btn.innerText = "反映中...";
        }

        // 表示中の月度の代表日を送信
        const dateStr = toUTCDateString(currentCalendarReportMonth);
        
        const response = await fetchWithAuth(`${API_BASE_URL}/api/sync-paid-holidays`, {
            method: 'POST',
            body: JSON.stringify({ date: dateStr })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            throw new Error(errorData?.message || `反映に失敗しました: ${response.status}`);
        }

        const result = await response.json();
        alert(`有休反映が完了しました。\n処理件数: ${result.count}件`);
        
        // カレンダーを再描画して反映を確認
        await initializeCalendarScreen(document.getElementById('calendar-container'));

    } catch (e) {
        console.error(e);
        alert(`エラー: ${e.message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = originalText;
        }
    }
}

main();

// --- Jobcan有休情報取得機能 ---
/**
 * Jobcanから指定期間の有給休暇取得情報を取得する
 * (バックエンド経由でJobcan APIを呼び出す想定)
 * 
 * @param {string} fromDate - 検索開始日 (YYYY-MM-DD)
 * @param {string} toDate - 検索終了日 (YYYY-MM-DD)
 * @param {string|number|null} targetEmployeeId - 対象の従業員ID (nullの場合はフィルタリングなし)
 * @param {string} vacationType - 休暇タイプ (paid, exchange, etc.)
 * @returns {Promise<Array<{date: string, type: 'full'|'half', days: number}>>} 取得した有休情報のリスト
 */
async function fetchJobcanPaidHolidays(fromDate, toDate, targetEmployeeId = null, vacationType = 'paid') {
    // 新設するバックエンドAPIのエンドポイント
    // Jobcan APIのパラメータ (from, to, vacation_type) をクエリパラメータとして渡す想定
    const url = `${API_BASE_URL}/api/jobcan/paid-holidays?from=${fromDate}&to=${toDate}&vacation_type=${vacationType}`;

    try {
        const response = await fetchWithAuth(url);
        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            throw new Error(errorData?.message || `Jobcan有休情報の取得に失敗しました: ${response.status}`);
        }

        const data = await response.json();
        const holidays = [];

        // /use-days APIのレスポンスを処理する
        // レスポンス構造: { "use_days": [ { "client_id": ..., "employee_id": ..., "use_logs": [...] } ] }
        // バックエンドがログインユーザーのIDで絞り込むため、フロントでのフィルタリングは不要
        if (data.use_days && Array.isArray(data.use_days)) {
            for (const employeeData of data.use_days) {
                if (employeeData.use_logs && Array.isArray(employeeData.use_logs)) {
                    for (const log of employeeData.use_logs) {
                        let holidayType = null;
                        let holidayDays = 0;

                        // detail.type が 'paid' のものを対象とする
                        if (log.detail && log.detail.type === 'paid') {
                            const days = (log.use_days && log.use_days.days) ? parseFloat(log.use_days.days) : 0;
                            
                            if (days >= 1.0) {
                                holidayType = 'full';
                                holidayDays = days;
                            } else if (days > 0) {
                                holidayType = 'half';
                                holidayDays = days;
                            }
                        }

                        if (holidayType) {
                            holidays.push({
                                date: log.use_date,
                                type: holidayType,
                                days: holidayDays
                            });
                        }
                    }
                }
            }
        }
        return holidays;
    } catch (error) {
        console.error("有休情報の取得に失敗:", error);
        throw error;
    }
}
