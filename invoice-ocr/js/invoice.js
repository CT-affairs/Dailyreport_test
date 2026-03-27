let invoiceOcrListSnapshot = null;
let invoiceOcrDraftByFileId = {};
let invoiceOcrActiveFileId = null;
const LIFF_ID = "2008638177-6GA6Mf63";
const AUTH_STORAGE_KEY = "invoice_internal_token";
const AUTH_REFRESH_MARGIN_SEC = 24 * 60 * 60; // 24h

function _decodeJwtPayload(token) {
    try {
        const payload = token.split(".")[1];
        const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
        const json = decodeURIComponent(escape(window.atob(b64)));
        return JSON.parse(json);
    } catch {
        return null;
    }
}

function _getStoredAuthToken() {
    const token = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!token) return null;
    const payload = _decodeJwtPayload(token);
    if (!payload || !payload.exp) return null;
    const now = Math.floor(Date.now() / 1000);
    if (now >= Number(payload.exp)) return null;
    return { token, exp: Number(payload.exp) };
}

async function _requestInternalTokenWithLine() {
    if (typeof liff === "undefined") throw new Error("LIFF SDK is not loaded");
    try {
        await liff.init({ liffId: LIFF_ID });
    } catch {
        // already initialized
    }
    if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: window.location.href });
        throw new Error("LINE login redirect");
    }
    const lineIdToken = await liff.getIDToken();
    if (!lineIdToken) throw new Error("LINE id token unavailable");

    const res = await fetch("/api/auth/line-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-cache",
        body: JSON.stringify({ line_id_token: lineIdToken }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `line login failed (${res.status})`);
    }
    const data = await res.json();
    if (!data.token) throw new Error("internal token missing");
    localStorage.setItem(AUTH_STORAGE_KEY, data.token);
    return data.token;
}

async function _refreshInternalToken(currentToken) {
    const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${currentToken}`,
        },
        cache: "no-cache",
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    if (!data.token) return null;
    localStorage.setItem(AUTH_STORAGE_KEY, data.token);
    return data.token;
}

async function ensureInvoiceInternalToken() {
    const cached = _getStoredAuthToken();
    if (!cached) return _requestInternalTokenWithLine();
    const now = Math.floor(Date.now() / 1000);
    if ((cached.exp - now) <= AUTH_REFRESH_MARGIN_SEC) {
        const refreshed = await _refreshInternalToken(cached.token);
        if (refreshed) return refreshed;
        return _requestInternalTokenWithLine();
    }
    return cached.token;
}

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

function showToast(message, type = 'info') {
    const statusEl = document.getElementById('invoice-ocr-status');
    if (!statusEl) return;
    const color = type === 'error' ? '#c0392b' : (type === 'success' ? '#137333' : '#666');
    statusEl.style.color = color;
    statusEl.textContent = message;
}

async function fetchInvoiceOcr(path, options = {}) {
    const token = await ensureInvoiceInternalToken();
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {}),
    };
    return fetch(path, {
        ...options,
        headers,
        cache: 'no-cache',
    });
}

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

function renderInvoiceOcrUiFromSnapshot() {
    const statusEl = document.getElementById('invoice-ocr-status');
    const contentEl = document.getElementById('invoice-ocr-content');
    if (!contentEl) return;

    const invoices = Array.isArray(invoiceOcrListSnapshot) ? invoiceOcrListSnapshot : [];
    if (statusEl) {
        statusEl.style.color = '#666';
        statusEl.textContent = `表示 ${invoices.length}件`;
    }

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
            <div style="background:#fff; padding: 14px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.06); margin-bottom: 12px;">
                <div style="display:flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px;">
                    <label style="display:flex; align-items:center; gap: 8px; font-weight: bold; cursor: pointer;">
                        <input type="checkbox" class="invoice-ocr-invoice-check" data-file-id="${fileId}" ${invChk ? 'checked' : ''} />
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
                </div>
                <div style="font-size: 0.9em; color:#333; line-height: 1.6;">
                    <div><b>file</b>: <span style="font-family: Consolas, monospace;">${fileId}</span> ${fileName ? `(${fileName})` : ''}</div>
                    <div><b>vendor</b>: ${vendorName || '-'}</div>
                    <div><b>invoice</b>: ${invoiceNumber || '-'} / <b>date</b>: ${invoiceDate || '-'}</div>
                </div>
                <div style="margin-top: 10px; overflow-x:auto;">
                    <table class="data-table" style="min-width: 1020px;">
                        <thead>
                            <tr>
                                <th style="width:56px;">確認</th>
                                <th style="width:180px;">order_number</th>
                                <th style="width:130px;">document_date</th>
                                <th>item_name</th>
                                <th style="width:100px;">quantity</th>
                                <th style="width:90px;">unit</th>
                                <th style="width:110px;">unit_price</th>
                                <th style="width:110px;">amount</th>
                                <th>note</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${draft.line_items.map((li, idx) => `
                                <tr>
                                    <td style="text-align:center;"><input type="checkbox" class="invoice-ocr-line-check" data-file-id="${fileId}" data-index="${idx}" ${_normalizeLineItemStatus(li?.status) === 'checked' ? 'checked' : ''} /></td>
                                    <td><input type="text" class="invoice-ocr-line-order-number" data-file-id="${fileId}" data-index="${idx}" value="${escapeHTML(String(li?.order_number || ''))}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width:160px;"></td>
                                    <td><input type="text" class="invoice-ocr-line-document-date" data-file-id="${fileId}" data-index="${idx}" value="${escapeHTML(_normalizeDocumentDate(li?.document_date))}" placeholder="YYYY/MM/DD" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width:110px;"></td>
                                    <td><input type="text" class="invoice-ocr-line-item-name" data-file-id="${fileId}" data-index="${idx}" value="${escapeHTML(String(li?.item_name || ''))}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width:100%;"></td>
                                    <td><input type="text" class="invoice-ocr-line-quantity" data-file-id="${fileId}" data-index="${idx}" value="${escapeHTML(String(li?.quantity ?? ''))}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width:80px;"></td>
                                    <td><input type="text" class="invoice-ocr-line-unit" data-file-id="${fileId}" data-index="${idx}" value="${escapeHTML(String(li?.unit ?? ''))}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width:70px;"></td>
                                    <td><input type="text" class="invoice-ocr-line-unit-price" data-file-id="${fileId}" data-index="${idx}" value="${escapeHTML(String(li?.unit_price ?? ''))}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width:90px;"></td>
                                    <td><input type="text" class="invoice-ocr-line-amount" data-file-id="${fileId}" data-index="${idx}" value="${escapeHTML(String(li?.amount ?? ''))}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width:90px;"></td>
                                    <td><input type="text" class="invoice-ocr-line-note" data-file-id="${fileId}" data-index="${idx}" value="${escapeHTML(String(li?.note || ''))}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width:100%;"></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>`;
    });
    contentEl.innerHTML = html;

    document.querySelectorAll('.invoice-ocr-invoice-check').forEach((cb) => {
        const fid = String(cb.dataset.fileId);
        const d = invoiceOcrDraftByFileId[fid];
        if (d && d.line_items.length) {
            const n = d.line_items.filter((li) => _normalizeLineItemStatus(li.status) === 'checked').length;
            cb.checked = n === d.line_items.length;
            cb.indeterminate = n > 0 && n < d.line_items.length;
        }
        cb.addEventListener('change', (e) => {
            const fileId = String(e.target.dataset.fileId);
            const draft = invoiceOcrDraftByFileId[fileId];
            if (!draft || !draft.line_items.length) return;
            const on = !!e.target.checked;
            draft.line_items.forEach((li) => { li.status = on ? 'checked' : 'pending'; });
            draft.dirty = true;
            renderInvoiceOcrUiFromSnapshot();
        });
    });

    document.querySelectorAll('.invoice-ocr-line-check').forEach((cb) => {
        cb.addEventListener('change', (e) => {
            const fileId = String(e.target.dataset.fileId);
            const idx = parseInt(e.target.dataset.index, 10);
            const draft = invoiceOcrDraftByFileId[fileId];
            if (!draft || !draft.line_items[idx]) return;
            draft.line_items[idx].status = e.target.checked ? 'checked' : 'pending';
            draft.dirty = true;
            renderInvoiceOcrUiFromSnapshot();
        });
    });

    const applyInvoiceOrderNumberToLines = (fileId) => {
        const draft = invoiceOcrDraftByFileId[fileId];
        if (!draft) return false;
        const v = String(draft.invoice.order_number || '');
        if (!v) return false;
        draft.line_items.forEach((li) => { li.order_number = v; });
        draft.dirty = true;
        return true;
    };

    document.querySelectorAll('.invoice-ocr-apply-order-number').forEach((cb) => {
        cb.addEventListener('change', (e) => {
            if (!e.target.checked) return;
            const fileId = String(e.target.dataset.fileId);
            if (!applyInvoiceOrderNumberToLines(fileId)) {
                e.target.checked = false;
                return;
            }
            renderInvoiceOcrUiFromSnapshot();
        });
    });

    document.querySelectorAll('.invoice-ocr-invoice-order-number').forEach((inp) => {
        inp.addEventListener('input', (e) => {
            const fileId = String(e.target.dataset.fileId);
            const draft = invoiceOcrDraftByFileId[fileId];
            if (!draft) return;
            draft.invoice.order_number = e.target.value;
            draft.dirty = true;
            const card = e.target.closest('div');
            const applyCb = card ? card.querySelector('.invoice-ocr-apply-order-number') : null;
            if (applyCb && applyCb.checked && applyInvoiceOrderNumberToLines(fileId)) {
                renderInvoiceOcrUiFromSnapshot();
            }
        });
    });

    const bindLineInput = (selector, key) => {
        document.querySelectorAll(selector).forEach((inp) => {
            inp.addEventListener('input', (e) => {
                const fileId = String(e.target.dataset.fileId);
                const idx = parseInt(e.target.dataset.index, 10);
                const draft = invoiceOcrDraftByFileId[fileId];
                if (!draft || !draft.line_items[idx]) return;
                draft.line_items[idx][key] = e.target.value;
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
    showToast('読込中...', 'info');
    try {
        const res = await fetchInvoiceOcr('/api/invoices?limit=5');
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const invoices = Array.isArray(data.invoices) ? data.invoices : [];
        invoiceOcrListSnapshot = invoices;
        invoices.forEach((inv) => {
            const fid = String(inv.file_id || '');
            if (fid) invoiceOcrDraftByFileId[fid] = _initInvoiceOcrDraftFromServer(inv);
        });
        renderInvoiceOcrUiFromSnapshot();
    } catch (e) {
        showToast(`読み込み失敗: ${e.message}`, 'error');
    }
}

async function saveInvoiceOcrCurrentDraft() {
    if (!invoiceOcrActiveFileId) return showToast('保存対象がありません', 'error');
    const fileId = String(invoiceOcrActiveFileId);
    const draft = invoiceOcrDraftByFileId[fileId];
    if (!draft || !draft.dirty) return showToast('変更がありません', 'info');

    const btn = document.getElementById('invoice-ocr-save-btn');
    if (btn) btn.disabled = true;
    showToast('保存中...', 'info');
    try {
        const res = await fetchInvoiceOcr(`/api/invoices/${encodeURIComponent(fileId)}`, {
            method: 'POST',
            body: JSON.stringify({
                invoice: { order_number: draft.invoice.order_number },
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
        showToast(`保存失敗: ${e.message}`, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('invoice-ocr-refresh-btn');
    const saveBtn = document.getElementById('invoice-ocr-save-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadAndRenderInvoiceOcrInvoices);
    if (saveBtn) saveBtn.addEventListener('click', saveInvoiceOcrCurrentDraft);
    loadAndRenderInvoiceOcrInvoices();
});
