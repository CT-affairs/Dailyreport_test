const INVOICE_OCR_BASE_URL = "https://invoice-ocr-1088643883290.asia-northeast1.run.app";

let invoiceOcrListSnapshot = null;
let invoiceOcrDraftByFileId = {};
let invoiceOcrActiveFileId = null;

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
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
    };
    return fetch(`${INVOICE_OCR_BASE_URL}${path}`, {
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
                                    ${draft.line_items.map((li, idx) => {
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
                                                <td style="text-align:center;"><input type="checkbox" class="invoice-ocr-line-check" data-file-id="${fileId}" data-index="${idx}" ${lineChecked ? 'checked' : ''} title="確認済み" /></td>
                                                <td><input type="text" class="invoice-ocr-line-order-number" data-file-id="${fileId}" data-index="${idx}" value="${orderNo}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 160px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-document-date" data-file-id="${fileId}" data-index="${idx}" value="${documentDate}" placeholder="YYYY/MM/DD" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 110px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-item-name" data-file-id="${fileId}" data-index="${idx}" value="${itemName}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 100%;"></td>
                                                <td><input type="text" class="invoice-ocr-line-quantity" data-file-id="${fileId}" data-index="${idx}" value="${qty}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 80px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-unit" data-file-id="${fileId}" data-index="${idx}" value="${unit}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 70px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-unit-price" data-file-id="${fileId}" data-index="${idx}" value="${unitPrice}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 90px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-amount" data-file-id="${fileId}" data-index="${idx}" value="${amount}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 90px;"></td>
                                                <td><input type="text" class="invoice-ocr-line-note" data-file-id="${fileId}" data-index="${idx}" value="${note}" style="padding:4px 6px; border:1px solid #ccc; border-radius:4px; width: 100%;"></td>
                                            </tr>`;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>`;
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
            const fileId = String(e.target.dataset.fileId);
            const d = invoiceOcrDraftByFileId[fileId];
            if (!d || !d.line_items.length) return;
            const on = !!e.target.checked;
            d.line_items.forEach((li) => { li.status = on ? 'checked' : 'pending'; });
            d.dirty = true;
            renderInvoiceOcrUiFromSnapshot();
        });
    });

    document.querySelectorAll('.invoice-ocr-line-check').forEach((cb) => {
        cb.addEventListener('change', (e) => {
            const fileId = String(e.target.dataset.fileId);
            const idx = parseInt(e.target.dataset.index, 10);
            const d = invoiceOcrDraftByFileId[fileId];
            if (!d || !d.line_items[idx]) return;
            d.line_items[idx].status = e.target.checked ? 'checked' : 'pending';
            d.dirty = true;
            renderInvoiceOcrUiFromSnapshot();
        });
    });

    const applyInvoiceOrderNumberToLines = (fileId) => {
        const d = invoiceOcrDraftByFileId[fileId];
        if (!d) return false;
        const v = String(d.invoice.order_number || '');
        if (!v) return false;
        d.line_items.forEach((li) => { li.order_number = v; });
        d.dirty = true;
        return true;
    };

    document.querySelectorAll('.invoice-ocr-apply-order-number').forEach((cb) => {
        cb.addEventListener('change', (e) => {
            if (!e.target.checked) return;
            const fileId = String(e.target.dataset.fileId);
            const changed = applyInvoiceOrderNumberToLines(fileId);
            if (!changed) {
                e.target.checked = false;
                return;
            }
            renderInvoiceOcrUiFromSnapshot();
        });
    });

    document.querySelectorAll('.invoice-ocr-invoice-order-number').forEach((inp) => {
        inp.addEventListener('input', (e) => {
            const fileId = String(e.target.dataset.fileId);
            const d = invoiceOcrDraftByFileId[fileId];
            if (!d) return;
            d.invoice.order_number = e.target.value;
            d.dirty = true;
            const card = e.target.closest('.card');
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
                const d = invoiceOcrDraftByFileId[fileId];
                if (!d || !d.line_items[idx]) return;
                d.line_items[idx][key] = e.target.value;
                d.dirty = true;
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

    statusEl.style.color = '#666';
    statusEl.textContent = '読込中...';
    contentEl.innerHTML = `<div style="text-align:center; padding: 2em; color:#666;">読み込み中...</div>`;

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
        console.error(e);
        showToast(`読み込み失敗: ${e.message}`, 'error');
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
    if (btn) btn.disabled = true;
    showToast('保存中...', 'info');

    try {
        const res = await fetchInvoiceOcr(`/api/invoices/${encodeURIComponent(fileId)}`, {
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
    } finally {
        if (btn) btn.disabled = false;
    }
}

function initInvoicePage() {
    const refreshBtn = document.getElementById('invoice-ocr-refresh-btn');
    const saveBtn = document.getElementById('invoice-ocr-save-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadAndRenderInvoiceOcrInvoices);
    if (saveBtn) saveBtn.addEventListener('click', saveInvoiceOcrCurrentDraft);
    loadAndRenderInvoiceOcrInvoices();
}

document.addEventListener('DOMContentLoaded', initInvoicePage);
