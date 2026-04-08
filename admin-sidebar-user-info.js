/**
 * 別ツール用のサイドバーユーザー表示モジュール（単体コピー用）。
 * 日報ツールの管理画面では読み込まない。ユーザー表示は js/admin-app.js の updateUserInfo のみ。
 */
(function (global) {
    'use strict';

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

    function groupAndRoleBadgesHtml(systemUser) {
        var groupDisplayName = '全社/その他';
        var mainGroupId = systemUser.main_group;
        if (systemUser.main_group_name) {
            groupDisplayName = String(systemUser.main_group_name);
        } else {
            if (mainGroupId === '3' || mainGroupId === 3) {
                groupDisplayName = 'ネット事業部';
            } else if (mainGroupId !== null && mainGroupId !== undefined) {
                groupDisplayName = '工務部';
            }
        }
        var html = '<div style="font-size:0.8em;">所属: ' + escapeHTML(groupDisplayName) + '</div>';

        var isSystemAdmin =
            systemUser.is_system_admin === true ||
            systemUser.is_system_admin === 1 ||
            systemUser.is_system_admin === '1';
        var isExecutive =
            systemUser.is_executive === true ||
            systemUser.is_executive === 1 ||
            systemUser.is_executive === '1';

        if (isSystemAdmin) {
            html += '<div style="font-size:0.8em; color:#cfd138;">[システム管理者]</div>';
        } else if (systemUser.is_manager) {
            if (isExecutive) {
                html += '<div style="font-size:0.8em; color:#f39c12;">[管理者[上位]]</div>';
            } else {
                html += '<div style="font-size:0.8em; color:#2ecc71;">[管理者]</div>';
            }
        } else {
            html += '<div style="font-size:0.8em; color:#3498db;">[ユーザー]</div>';
        }
        return html;
    }

    function sanitizeDomId(id) {
        var s = String(id || 'logout-btn').replace(/[^a-zA-Z0-9_-]/g, '');
        return s || 'logout-btn';
    }

    function logoutBlockHtml(logoutButtonId) {
        var id = sanitizeDomId(logoutButtonId || 'logout-btn');
        return (
            '<div style="margin-top: 12px; padding-top: 8px; border-top: 1px solid #34495e;">' +
            '<button type="button" id="' +
            id +
            '" style="width: 100%; padding: 6px; background-color: #6aaacf; color: white; border: none; ' +
            'border-radius: 4px; cursor: pointer; font-size: 0.8em;">ログアウト</button>' +
            '</div>'
        );
    }

    function buildSidebarUserInfoHtml(lineDisplayName, systemUser, fetchError, logoutButtonId) {
        var html = '';

        if (fetchError) {
            html += '<div style="font-weight:bold; margin-bottom:4px;">—</div>';
            html += '<div style="font-size:0.8em; color:red;">' + escapeHTML(String(fetchError)) + '</div>';
        } else if (systemUser && systemUser.employeeId) {
            var empName = systemUser.name ? String(systemUser.name) : '';
            html +=
                '<div style="font-weight:bold; margin-bottom:4px;">' +
                escapeHTML(empName || '（氏名未設定）') +
                '</div>';
            html += '<div style="font-size:0.8em;">ID: ' + escapeHTML(String(systemUser.employeeId)) + '</div>';
            html += groupAndRoleBadgesHtml(systemUser);
        } else {
            html += '<div style="font-weight:bold; margin-bottom:4px;">ID未登録</div>';
            if (lineDisplayName) {
                html +=
                    '<div style="font-size:0.75em; color:#95a5a6;">LINE: ' +
                    escapeHTML(String(lineDisplayName)) +
                    '</div>';
            } else {
                html += '<div style="font-size:0.75em; color:#95a5a6;">（LINE 未連携）</div>';
            }
        }

        html += logoutBlockHtml(logoutButtonId);
        return html;
    }

    function defaultFetchWithAuth(url) {
        return fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            cache: 'no-cache',
        });
    }

    function resolveContainer(container) {
        if (!container) return document.getElementById('admin-user-info');
        if (typeof container === 'string') return document.querySelector(container);
        return container;
    }

    function applyMenuVisibilityFromUser(systemUser, root) {
        root = root || document;
        var koumuMenuItems = root.querySelectorAll('.menu-koumu');
        var netMenuItems = root.querySelectorAll('.menu-net');
        var somuMenuItems = root.querySelectorAll('.menu-somu');

        function showKoumu() {
            koumuMenuItems.forEach(function (el) {
                el.style.display = '';
            });
        }
        function hideKoumu() {
            koumuMenuItems.forEach(function (el) {
                el.style.display = 'none';
            });
        }
        function showNet() {
            netMenuItems.forEach(function (el) {
                el.style.display = '';
            });
        }
        function hideNet() {
            netMenuItems.forEach(function (el) {
                el.style.display = 'none';
            });
        }
        function showSomu() {
            somuMenuItems.forEach(function (el) {
                el.style.display = '';
            });
        }
        function hideSomu() {
            somuMenuItems.forEach(function (el) {
                el.style.display = 'none';
            });
        }

        if (systemUser) {
            var isSystemAdmin =
                systemUser.is_system_admin === true ||
                systemUser.is_system_admin === 1 ||
                systemUser.is_system_admin === '1';
            var mainGroupId = systemUser.main_group;

            if (isSystemAdmin) {
                showKoumu();
                showNet();
                showSomu();
            } else {
                hideSomu();
                if (mainGroupId === '3' || mainGroupId === 3) {
                    hideKoumu();
                    showNet();
                } else if (mainGroupId === null || mainGroupId === undefined) {
                    showKoumu();
                    showNet();
                } else {
                    showKoumu();
                    hideNet();
                }
            }
        } else {
            hideKoumu();
            hideNet();
            hideSomu();
        }
    }

    function bindLogout(apiBaseUrl, logoutButtonId) {
        var btn = document.getElementById(sanitizeDomId(logoutButtonId));
        if (!btn) return;
        btn.addEventListener('click', async function () {
            try {
                await fetch(apiBaseUrl.replace(/\/$/, '') + '/api/pc/session', {
                    method: 'DELETE',
                    credentials: 'include',
                    cache: 'no-cache',
                });
            } catch (e) {
                console.warn(e);
            }
            try {
                if (typeof global.liff !== 'undefined' && global.liff.isLoggedIn && global.liff.isLoggedIn()) {
                    global.liff.logout();
                }
            } catch (e) {
                console.warn(e);
            }
            global.location.reload();
        });
    }

    async function mount(options) {
        if (!options || !options.apiBaseUrl) {
            throw new Error('AdminSidebarUserInfo.mount: apiBaseUrl は必須です');
        }
        var apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
        var userInfoContainer = resolveContainer(options.container);
        if (!userInfoContainer) {
            console.warn('AdminSidebarUserInfo: コンテナが見つかりません');
            return;
        }

        userInfoContainer.textContent = '読込中...';

        var fetchWithAuth = options.fetchWithAuth || defaultFetchWithAuth;
        var logoutId = options.logoutButtonId || 'logout-btn';

        try {
            var profile = null;
            try {
                if (typeof global.liff !== 'undefined' && global.liff.isLoggedIn && global.liff.isLoggedIn()) {
                    profile = await global.liff.getProfile();
                }
            } catch (e) {
                profile = null;
            }

            var systemUser = null;
            var fetchError = null;

            try {
                var response = await fetchWithAuth(apiBaseUrl + '/api/user');
                if (response.ok) {
                    systemUser = await response.json();
                    if (typeof options.onUserLoaded === 'function') {
                        options.onUserLoaded(systemUser);
                    }
                } else if (response.status !== 404) {
                    fetchError = '通信エラー (' + response.status + ')';
                }
            } catch (e) {
                console.warn('システムユーザー情報の取得に失敗:', e);
                fetchError = '通信失敗';
            }

            var lineName = profile && profile.displayName ? profile.displayName : null;
            userInfoContainer.innerHTML = buildSidebarUserInfoHtml(lineName, systemUser, fetchError, logoutId);

            bindLogout(apiBaseUrl, logoutId);

            if (options.applyMenuVisibility) {
                applyMenuVisibilityFromUser(systemUser, options.menuRoot || document);
            }
        } catch (error) {
            console.error('ユーザー情報の表示エラー:', error);
            userInfoContainer.textContent = '取得エラー';
        }
    }

    global.AdminSidebarUserInfo = {
        escapeHTML: escapeHTML,
        buildSidebarUserInfoHtml: buildSidebarUserInfoHtml,
        applyMenuVisibilityFromUser: applyMenuVisibilityFromUser,
        mount: mount,
    };
})(typeof window !== 'undefined' ? window : this);
