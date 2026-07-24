/**
 * system-notices.js
 * =============================================================================
 * システム改修情報（ダッシュボード表示 + 管理画面 CRUD）を単一ファイルにまとめたもの。
 *
 * 【別リポへの持ち込み】
 * 1. このファイルをコピーする
 * 2. HTML で読み込む（例: <script src="js/system-notices.js"></script>）
 * 3. ダッシュボード側で mountDashboard、管理画面側で mountAdmin を呼ぶ
 *
 * 【API】
 * 既定では日報ツール API の /api/system-notices を使う（同一 GCP プロジェクト想定）。
 * - GET    /api/system-notices
 * - POST   /api/system-notices          （管理者）
 * - PUT    /api/system-notices/:id      （管理者）
 * - DELETE /api/system-notices/:id      （管理者）
 * Firestore コレクション: system_notices
 *   { type: "plan"|"history", date: "YYYY-MM-DD", content: string }
 *
 * 【最小例】
 *   SystemNotices.mountDashboard(document.getElementById('notices-slot'), {
 *     apiBaseUrl: 'https://dailyreport-service-....run.app',
 *     fetchWithAuth: (url, opts) => fetch(url, { ...opts, credentials: 'include' }),
 *     onOpenAdmin: () => { location.hash = '#system_admin'; },
 *   });
 *
 *   SystemNotices.mountAdmin(document.getElementById('content'), {
 *     apiBaseUrl: '...',
 *     fetchWithAuth: myAuthFetch,
 *   });
 * =============================================================================
 */
(function (global) {
    'use strict';

    const DEFAULT_API_BASE = 'https://dailyreport-service-1088643883290.asia-northeast1.run.app';

    function escapeHTML(str) {
        if (typeof str !== 'string') return '';
        return str.replace(/[&<>"']/g, function (match) {
            return {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            }[match];
        });
    }

    function resolveEl(target) {
        if (!target) return null;
        if (typeof target === 'string') return document.querySelector(target);
        return target;
    }

    function normalizeOptions(options) {
        const opts = options && typeof options === 'object' ? options : {};
        const apiBaseUrl = String(opts.apiBaseUrl || DEFAULT_API_BASE).replace(/\/$/, '');
        const fetchWithAuth = typeof opts.fetchWithAuth === 'function'
            ? opts.fetchWithAuth
            : function (url, init) {
                return fetch(url, Object.assign({ credentials: 'include' }, init || {}));
            };
        return {
            apiBaseUrl: apiBaseUrl,
            fetchWithAuth: fetchWithAuth,
            onOpenAdmin: typeof opts.onOpenAdmin === 'function' ? opts.onOpenAdmin : null,
            title: opts.title || 'システム改修情報',
            showAdminButton: opts.showAdminButton !== false,
        };
    }

    function noticesUrl(apiBaseUrl, noticeId) {
        const base = apiBaseUrl + '/api/system-notices';
        return noticeId ? base + '/' + encodeURIComponent(noticeId) : base;
    }

    async function fetchNotices(opts) {
        const response = await opts.fetchWithAuth(noticesUrl(opts.apiBaseUrl));
        if (!response.ok) throw new Error('改修情報の取得に失敗しました (Status: ' + response.status + ')');
        const notices = await response.json();
        return Array.isArray(notices) ? notices : [];
    }

    function buildDashboardCardHtml(opts) {
        const adminBtn = opts.showAdminButton
            ? '<div class="sn-goto-admin-btn" style="position: absolute; top: 10px; right: 10px; width: 20px; height: 20px; border: 1px solid rgba(0,0,0,0.1); cursor: pointer; z-index: 100;" title="管理"></div>'
            : '';
        return (
            '<div class="card sn-dashboard-card" style="background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; position: relative;">' +
            adminBtn +
            '<h3 style="margin-top: 0; border-bottom: 1px solid #eee; padding-bottom: 10px; font-size: 1.2em; color: #2c3e50;">' +
            escapeHTML(opts.title) +
            '</h3>' +
            '<div style="display: flex; gap: 40px; flex-wrap: wrap;">' +
            '<div style="flex: 1; min-width: 300px;">' +
            '<h4 style="color: #e67e22; margin-bottom: 10px; border-left: 4px solid #e67e22; padding-left: 10px;">改修予定</h4>' +
            '<div style="height: 120px; overflow-y: auto; border: 1px solid #f0f0f0; border-radius: 4px; padding: 5px; background-color: #fafafa;">' +
            '<ul class="sn-plan-list" style="margin: 0; font-size: 0.9em; line-height: 1.6; padding-left: 20px; color: #555;"><li>読み込み中...</li></ul>' +
            '</div></div>' +
            '<div style="flex: 1; min-width: 300px;">' +
            '<h4 style="color: #2ecc71; margin-bottom: 10px; border-left: 4px solid #2ecc71; padding-left: 10px;">改修履歴</h4>' +
            '<div style="height: 120px; overflow-y: auto; border: 1px solid #f0f0f0; border-radius: 4px; padding: 5px; background-color: #fafafa;">' +
            '<ul class="sn-history-list" style="margin: 0; font-size: 0.9em; line-height: 1.6; padding-left: 20px; color: #666;"><li>読み込み中...</li></ul>' +
            '</div></div></div></div>'
        );
    }

    function renderNoticesIntoLists(root, notices) {
        const planList = root.querySelector('.sn-plan-list') || root.querySelector('#dashboard-plan-list');
        const historyList = root.querySelector('.sn-history-list') || root.querySelector('#dashboard-history-list');
        if (!planList && !historyList) return;

        if (planList) planList.innerHTML = '';
        if (historyList) historyList.innerHTML = '';

        const historyItems = notices.filter(function (n) { return n.type === 'history'; });
        const planItems = notices.filter(function (n) { return n.type === 'plan'; });
        planItems.sort(function (a, b) {
            return String(a.date || '').localeCompare(String(b.date || ''));
        });

        historyItems.forEach(function (notice) {
            const li = document.createElement('li');
            li.innerHTML = '<strong>' + escapeHTML(notice.date) + ':</strong> ' + escapeHTML(notice.content);
            if (historyList) historyList.appendChild(li);
        });
        planItems.forEach(function (notice) {
            const li = document.createElement('li');
            li.textContent = notice.content || '';
            if (planList) planList.appendChild(li);
        });

        if (planList && planList.children.length === 0) {
            planList.innerHTML = '<li>予定はありません</li>';
        }
        if (historyList && historyList.children.length === 0) {
            historyList.innerHTML = '<li>履歴はありません</li>';
        }
    }

    async function loadDashboard(root, options) {
        const el = resolveEl(root);
        if (!el) return;
        const opts = normalizeOptions(options);
        try {
            const notices = await fetchNotices(opts);
            renderNoticesIntoLists(el, notices);
        } catch (error) {
            console.error('お知らせの取得に失敗:', error);
            const planList = el.querySelector('.sn-plan-list') || el.querySelector('#dashboard-plan-list');
            const historyList = el.querySelector('.sn-history-list') || el.querySelector('#dashboard-history-list');
            if (planList) planList.innerHTML = '<li>読み込みに失敗しました</li>';
            if (historyList) historyList.innerHTML = '<li>読み込みに失敗しました</li>';
        }
    }

    function bindAdminButton(root, onOpenAdmin) {
        const el = resolveEl(root);
        if (!el || typeof onOpenAdmin !== 'function') return;
        const btn = el.querySelector('.sn-goto-admin-btn') || el.querySelector('#goto-sys-admin-btn');
        if (!btn) return;
        btn.addEventListener('click', function () {
            onOpenAdmin();
        });
    }

    /**
     * ダッシュボード用カードを描画し、一覧を読み込む。
     * @param {Element|string} target
     * @param {object} [options]
     * @returns {Promise<void>}
     */
    async function mountDashboard(target, options) {
        const el = resolveEl(target);
        if (!el) throw new Error('SystemNotices.mountDashboard: target が見つかりません');
        const opts = normalizeOptions(options);
        el.innerHTML = buildDashboardCardHtml(opts);
        bindAdminButton(el, opts.onOpenAdmin);
        await loadDashboard(el, opts);
    }

    function clearAdminForm(root) {
        const el = resolveEl(root);
        if (!el) return;
        const idEl = el.querySelector('#sys-notice-id');
        const typeEl = el.querySelector('#sys-notice-type');
        const dateEl = el.querySelector('#sys-notice-date');
        const contentEl = el.querySelector('#sys-notice-content');
        const saveBtn = el.querySelector('#sys-notice-save-btn');
        if (idEl) idEl.value = '';
        if (typeEl) typeEl.value = 'plan';
        if (dateEl) dateEl.value = '';
        if (contentEl) contentEl.value = '';
        if (saveBtn) saveBtn.textContent = '保存';
    }

    async function loadAdminList(root, opts) {
        const el = resolveEl(root);
        const container = el && el.querySelector('#sys-notice-list-container');
        if (!container) return;

        try {
            const notices = await fetchNotices(opts);
            notices.sort(function (a, b) {
                return String(b.date || '').localeCompare(String(a.date || ''));
            });

            if (notices.length === 0) {
                container.innerHTML = '<p>データがありません。</p>';
                return;
            }

            let html = '<table class="data-table" style="width: 100%;"><thead><tr><th>Type</th><th>Date</th><th>Content</th><th>Action</th></tr></thead><tbody>';
            notices.forEach(function (notice) {
                const typeLabel = notice.type === 'plan'
                    ? '<span style="color:#e67e22">予定</span>'
                    : '<span style="color:#2ecc71">履歴</span>';
                const jsonStr = escapeHTML(JSON.stringify(notice));
                html +=
                    '<tr>' +
                    '<td style="text-align:center;">' + typeLabel + '</td>' +
                    '<td>' + escapeHTML(notice.date) + '</td>' +
                    '<td>' + escapeHTML(notice.content) + '</td>' +
                    '<td style="text-align:center; width: 120px;">' +
                    '<button type="button" class="btn-secondary sn-edit-notice-btn" data-notice="' + jsonStr + '" style="padding: 4px 8px; margin-right: 5px;">編集</button>' +
                    '<button type="button" class="btn-secondary sn-delete-notice-btn" data-id="' + escapeHTML(notice.id) + '" style="padding: 4px 8px; background-color: #e74c3c; color: white;">削除</button>' +
                    '</td></tr>';
            });
            html += '</tbody></table>';
            container.innerHTML = html;

            container.querySelectorAll('.sn-edit-notice-btn').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    const notice = JSON.parse(e.currentTarget.dataset.notice);
                    el.querySelector('#sys-notice-id').value = notice.id || '';
                    el.querySelector('#sys-notice-type').value = notice.type || 'history';
                    el.querySelector('#sys-notice-date').value = notice.date || '';
                    el.querySelector('#sys-notice-content').value = notice.content || '';
                    el.querySelector('#sys-notice-save-btn').textContent = '更新';
                    window.scrollTo(0, 0);
                });
            });
            container.querySelectorAll('.sn-delete-notice-btn').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    void deleteNotice(el, opts, e.currentTarget.dataset.id);
                });
            });
        } catch (error) {
            container.innerHTML = '<p style="color:red;">エラー: ' + escapeHTML(error.message) + '</p>';
        }
    }

    async function saveNotice(root, opts) {
        const el = resolveEl(root);
        if (!el) return;

        const id = (el.querySelector('#sys-notice-id') || {}).value || '';
        const type = (el.querySelector('#sys-notice-type') || {}).value || 'history';
        const date = (el.querySelector('#sys-notice-date') || {}).value || '';
        const content = String((el.querySelector('#sys-notice-content') || {}).value || '').trim();
        const btn = el.querySelector('#sys-notice-save-btn');

        if (!date || !content) {
            alert('日付と内容は必須です。');
            return;
        }

        if (btn) {
            btn.disabled = true;
            btn.textContent = '保存中...';
        }

        try {
            const method = id ? 'PUT' : 'POST';
            const url = noticesUrl(opts.apiBaseUrl, id || null);
            const response = await opts.fetchWithAuth(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: type, date: date, content: content }),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(function () { return {}; });
                throw new Error(errorData.message || ('保存に失敗しました (Status: ' + response.status + ')'));
            }
            alert('保存しました。');
            clearAdminForm(el);
            await loadAdminList(el, opts);
        } catch (error) {
            console.error(error);
            alert('エラー: ' + error.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = id ? '更新' : '保存';
            }
        }
    }

    async function deleteNotice(root, opts, noticeId) {
        if (!noticeId || !confirm('本当に削除しますか？')) return;
        try {
            const response = await opts.fetchWithAuth(noticesUrl(opts.apiBaseUrl, noticeId), {
                method: 'DELETE',
            });
            if (!response.ok) {
                const errorData = await response.json().catch(function () { return {}; });
                throw new Error(errorData.message || ('削除失敗 (Status: ' + response.status + ')'));
            }
            await loadAdminList(root, opts);
        } catch (error) {
            alert('エラー: ' + error.message);
        }
    }

    /**
     * 改修情報マスタ（追加・編集・一覧）を描画する。
     * @param {Element|string} target
     * @param {object} [options]
     * @returns {Promise<void>}
     */
    async function mountAdmin(target, options) {
        const el = resolveEl(target);
        if (!el) throw new Error('SystemNotices.mountAdmin: target が見つかりません');
        const opts = normalizeOptions(options);

        el.innerHTML =
            '<div class="sn-admin-root" style="padding: 20px; max-width: 800px;">' +
            '<div style="margin-bottom: 30px; padding: 20px; background-color: #f8f9fa; border-radius: 8px; border: 1px solid #e9ecef;">' +
            '<h3 style="margin-top: 0; margin-bottom: 15px; font-size: 1.1em; color: #333;">改修情報の追加・編集</h3>' +
            '<input type="hidden" id="sys-notice-id">' +
            '<div style="display: flex; gap: 10px; margin-bottom: 10px;">' +
            '<select id="sys-notice-type" style="padding: 8px; border-radius: 4px; border: 1px solid #ccc;">' +
            '<option value="plan">改修予定 (plan)</option>' +
            '<option value="history">改修履歴 (history)</option>' +
            '</select>' +
            '<input type="date" id="sys-notice-date" style="padding: 8px; border-radius: 4px; border: 1px solid #ccc;">' +
            '</div>' +
            '<div style="margin-bottom: 15px;">' +
            '<input type="text" id="sys-notice-content" placeholder="内容を入力してください" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box;">' +
            '</div>' +
            '<div style="display: flex; gap: 10px;">' +
            '<button type="button" id="sys-notice-save-btn" class="btn-primary" style="padding: 8px 20px; background-color: #3498db; color: white; border: none; border-radius: 4px; cursor: pointer;">保存</button>' +
            '<button type="button" id="sys-notice-clear-btn" class="btn-secondary" style="padding: 8px 20px; background-color: #95a5a6; color: white; border: none; border-radius: 4px; cursor: pointer;">クリア</button>' +
            '</div></div>' +
            '<h3 style="font-size: 1.1em; color: #333; border-bottom: 2px solid #333; padding-bottom: 5px;">登録済み一覧</h3>' +
            '<div id="sys-notice-list-container">読み込み中...</div>' +
            '</div>';

        el.querySelector('#sys-notice-save-btn').addEventListener('click', function () {
            void saveNotice(el, opts);
        });
        el.querySelector('#sys-notice-clear-btn').addEventListener('click', function () {
            clearAdminForm(el);
        });
        await loadAdminList(el, opts);
    }

    const api = {
        DEFAULT_API_BASE: DEFAULT_API_BASE,
        escapeHTML: escapeHTML,
        buildDashboardCardHtml: function (options) {
            return buildDashboardCardHtml(normalizeOptions(options));
        },
        loadDashboard: loadDashboard,
        mountDashboard: mountDashboard,
        mountAdmin: mountAdmin,
        bindAdminButton: bindAdminButton,
    };

    global.SystemNotices = api;
})(typeof window !== 'undefined' ? window : this);
