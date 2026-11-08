// Page renderers for the admin SPA.
const Views = (() => {
  const { $, el, esc, money, num, timeAgo, dateTime, toast, modal, closeModal, confirmDialog, copy, spinner } = UI;
  let chart = null;

  function mount(node) {
    const view = $('#view');
    view.innerHTML = '';
    view.appendChild(node);
  }
  function loading() { mount(spinner()); }

  function statTile({ icon, label, value, delta, tint }) {
    return el('div', { class: 'stat', style: tint ? `--tint:${tint}` : '' }, [
      el('div', { class: 'stat-ico', text: icon }),
      el('div', { class: 'stat-label', text: label }),
      el('div', { class: 'stat-value', text: value }),
      delta ? el('div', { class: 'stat-delta up', html: delta }) : null,
    ]);
  }

  function badge(status) { return el('span', { class: `badge ${status}`, text: status }); }

  // ============================ DASHBOARD ============================
  async function dashboard() {
    loading();
    let d;
    try { d = await API.dashboard(); } catch (e) { return mount(errorBox(e)); }
    const s = d.stats;

    const wrap = el('div');
    const stats = el('div', { class: 'grid cols-4' }, [
      statTile({ icon: '💰', label: 'Total Revenue', value: money(s.revenue), delta: `+${money(s.revenueToday)} today`, tint: 'linear-gradient(135deg,#6c5cff,#a855f7)' }),
      statTile({ icon: '🧾', label: 'Orders', value: num(s.totalOrders), delta: `${s.deliveredOrders} delivered`, tint: 'linear-gradient(135deg,#22d3ee,#6c5cff)' }),
      statTile({ icon: '⏳', label: 'Pending Payments', value: num(s.pendingOrders), delta: 'auto-detected', tint: 'linear-gradient(135deg,#ffb020,#ff5c7a)' }),
      statTile({ icon: '👥', label: 'Customers', value: num(s.totalUsers), delta: `+${num(s.newUsersToday)} today`, tint: 'linear-gradient(135deg,#37d399,#22d3ee)' }),
    ]);
    wrap.appendChild(stats);

    // Profit row — product sales only, top-ups excluded.
    const profitTiles = el('div', { class: 'grid cols-4', style: 'margin-top:18px' }, [
      statTile({ icon: '🛍️', label: 'Sales Revenue', value: money(s.salesRevenue || 0), delta: 'products only', tint: 'linear-gradient(135deg,#6c5cff,#22d3ee)' }),
      statTile({ icon: '🏷️', label: 'Cost of Goods', value: money(s.totalCost || 0), delta: 'at time of sale', tint: 'linear-gradient(135deg,#ffb020,#ff5c7a)' }),
      statTile({ icon: (s.profit || 0) >= 0 ? '📈' : '📉', label: 'Profit', value: money(s.profit || 0), delta: `${s.margin || 0}% margin`, tint: 'linear-gradient(135deg,#37d399,#6c5cff)' }),
      statTile({ icon: '⚠️', label: 'Lines Without Cost', value: num(s.linesMissingCost || 0), delta: s.linesMissingCost ? 'profit overstated' : 'all costed', tint: 'linear-gradient(135deg,#94a3b8,#64748b)' }),
    ]);
    wrap.appendChild(profitTiles);

    // Per-product profit table
    if (Array.isArray(d.productProfit) && d.productProfit.length) {
      const rows = d.productProfit.map((r) =>
        el('tr', {}, [
          el('td', { text: `${r.emoji || ''} ${r.name}` }),
          el('td', { text: num(r.qty) }),
          el('td', { text: money(r.revenue) }),
          el('td', { text: money(r.cost) }),
          el('td', { class: r.profit >= 0 ? 'ok' : 'bad', text: money(r.profit) }),
          el('td', { text: r.revenue > 0 ? `${Math.round((r.profit / r.revenue) * 100)}%` : '—' }),
        ])
      );
      const profitCard = el('div', { class: 'card', style: 'margin-top:18px' }, [
        el('div', { class: 'card-head' }, [
          el('div', {}, [
            el('h3', { text: 'Profit by product' }),
            el('div', { class: 'sub', text: 'Cost is the value recorded at the time of each sale' }),
          ]),
        ]),
        el('div', { class: 'table-wrap' }, [
          el('table', { class: 'table' }, [
            el('thead', {}, [
              el('tr', {}, ['Product', 'Sold', 'Revenue', 'Cost', 'Profit', 'Margin'].map((h) => el('th', { text: h }))),
            ]),
            el('tbody', {}, rows),
          ]),
        ]),
      ]);
      wrap.appendChild(profitCard);
    }

    const row = el('div', { class: 'grid cols-2', style: 'margin-top:18px' });
    // Revenue chart card
    const chartCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('div', {}, [el('h3', { text: 'Revenue · last 14 days' }), el('div', { class: 'sub', text: 'Paid & delivered orders' })])]),
      el('div', { class: 'chart-wrap' }, [el('canvas', { id: 'revChart' })]),
    ]);
    row.appendChild(chartCard);

    // Top products card
    const topBody = d.topProducts.length
      ? el('div', {}, d.topProducts.map((t) => el('div', { class: 'row-flex', style: 'padding:9px 0;border-bottom:1px solid var(--stroke)' }, [
          el('span', { style: 'font-size:20px', text: t.emoji }),
          el('div', { class: 't-strong', text: t.name }),
          el('div', { class: 'right t-muted', text: `${t.qty} sold` }),
          el('div', { style: 'width:90px;text-align:right;font-weight:700', text: money(t.revenue) }),
        ])))
      : emptyState('📦', 'No sales yet');
    const topCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '🔥 Top Products' })]),
      topBody,
    ]);
    row.appendChild(topCard);
    wrap.appendChild(row);

    // Low stock + recent orders
    const row2 = el('div', { class: 'grid cols-2', style: 'margin-top:18px' });
    const lowBody = d.lowStock.length
      ? el('div', {}, d.lowStock.map((p) => el('div', { class: 'row-flex', style: 'padding:9px 0;border-bottom:1px solid var(--stroke)' }, [
          el('span', { style: 'font-size:18px', text: p.emoji }),
          el('div', { class: 't-strong', text: p.name }),
          el('div', { class: `right stock-chip ${p.stock === 0 ? 'zero' : 'low'}`, text: p.stock === 0 ? 'OUT' : `${p.stock} left` }),
        ])))
      : emptyState('✅', 'All products well stocked');
    row2.appendChild(el('div', { class: 'card' }, [el('div', { class: 'card-head' }, [el('h3', { text: '⚠️ Low Stock' })]), lowBody]));

    const recentBody = d.recentOrders.length
      ? el('div', { class: 'table-wrap' }, [ordersTable(d.recentOrders, true)])
      : emptyState('🧾', 'No orders yet');
    row2.appendChild(el('div', { class: 'card', style: 'grid-column:auto' }, [el('div', { class: 'card-head' }, [el('h3', { text: '🕑 Recent Orders' })]), recentBody]));
    wrap.appendChild(row2);

    mount(wrap);

    // draw chart
    const ctx = document.getElementById('revChart');
    if (chart) { chart.destroy(); chart = null; }
    const grad = ctx.getContext('2d').createLinearGradient(0, 0, 0, 260);
    grad.addColorStop(0, 'rgba(108,92,255,.5)');
    grad.addColorStop(1, 'rgba(108,92,255,0)');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: d.series.map((p) => p.date.slice(5)),
        datasets: [{
          label: 'Revenue', data: d.series.map((p) => p.revenue),
          borderColor: '#8b7bff', backgroundColor: grad, fill: true, tension: .38,
          borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: '#22d3ee',
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => money(c.parsed.y) } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#6b739a', maxTicksLimit: 8 } },
          y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#6b739a', callback: (v) => money(v) }, beginAtZero: true },
        },
      },
    });
  }

  function ordersTable(orders, compact) {
    const table = el('table');
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Order' }), el('th', { text: 'Customer' }), el('th', { text: 'Items' }),
      el('th', { text: 'Amount' }), el('th', { text: 'Status' }), el('th', { text: compact ? 'When' : 'Created' }),
    ])]));
    const tb = el('tbody');
    for (const o of orders) {
      tb.appendChild(el('tr', { style: 'cursor:pointer', onclick: () => orderDetail(o.id) }, [
        el('td', { class: 'mono t-strong', text: o.publicId }),
        el('td', {}, [customerCell(o.user)]),
        el('td', { class: 't-muted', text: truncate(o.summary, 40) }),
        el('td', { class: 't-strong', text: money(o.amount, o.currency) }),
        el('td', {}, [badge(o.status)]),
        el('td', { class: 't-muted', text: compact ? timeAgo(o.createdAt) : dateTime(o.createdAt) }),
      ]));
    }
    table.appendChild(tb);
    return table;
  }

  function customerCell(u) {
    if (!u) return el('span', { class: 't-muted', text: '—' });
    const name = u.username ? '@' + u.username : (u.firstName || 'User');
    return el('div', {}, [el('div', { class: 't-strong', text: name }), el('div', { class: 't-muted mono', style: 'font-size:11px', text: u.telegramId })]);
  }

  // ============================ PRODUCTS ============================
  async function products() {
    loading();
    let data;
    try { data = await API.products(); } catch (e) { return mount(errorBox(e)); }
    const list = data.products;

    const head = el('div', { class: 'toolbar' }, [
      el('div', { class: 'grow' }, [el('h2', { class: 'topbar-title', text: `${list.length} Products`, style: 'font-size:16px' })]),
      el('button', { class: 'btn btn-primary', html: '＋ New Product', onclick: () => productModal(null) }),
    ]);

    const grid = el('div', { class: 'prod-grid' });
    if (!list.length) grid.appendChild(emptyState('🏷️', 'No products yet — create your first one'));
    for (const p of list) grid.appendChild(productCard(p));

    mount(el('div', {}, [head, grid]));
  }

  function productCard(p) {
    const stockChip = p.usesStock
      ? el('span', { class: `stock-chip ${p.stock === 0 ? 'zero' : p.stock <= 3 ? 'low' : ''}`, text: p.stock === 0 ? 'Out of stock' : `${p.stock} in stock` })
      : el('span', { class: 'stock-chip', text: '♾️ Unlimited' });
    const activeChip = p.isActive ? null : el('span', { class: 'badge EXPIRED', text: 'Hidden' });
    const supplierChip = p.supplierId ? el('span', { class: 'badge PAID', text: `🚚 ${p.supplierName || 'Supplier'}` }) : null;
    return el('div', { class: 'card prod-card' + (p.isActive ? '' : ' dim') }, [
      el('div', { class: 'prod-top' }, [
        el('div', { class: 'prod-emoji', text: p.emoji }),
        el('div', {}, [el('div', { class: 'prod-name', text: p.name }), el('div', { class: 'prod-price', text: money(p.price) })]),
      ]),
      el('div', { class: 'prod-meta' }, [stockChip, supplierChip, activeChip]),
      el('div', { class: 'prod-actions' }, [
        p.usesStock && !p.supplierId ? el('button', { class: 'btn btn-sm btn-good', html: '📦 Stock', onclick: () => stockModal(p) }) : null,
        el('button', { class: 'btn btn-sm', html: '✎ Edit', onclick: () => productModal(p) }),
        el('button', { class: 'btn btn-sm btn-danger', html: '🗑', onclick: () => deleteProduct(p) }),
      ]),
    ]);
  }

  function productModal(p) {
    const isNew = !p;
    const f = (id) => document.getElementById(id);
    const body = el('div', { class: 'form-grid' }, [
      field('Emoji', `<input id="p-emoji" value="${esc(p?.emoji || '🛍️')}" maxlength="8" />`),
      field('Premium emoji ID (optional)', `<input id="p-emoji-id" inputmode="numeric" placeholder="e.g. 5321197740800120767" value="${esc(p?.emojiId || '')}" /><span class="hint">Shown in the Telegram bot instead of the emoji. Send the premium emoji to the bot as admin to get its ID. Leave empty for a normal emoji.</span>`),
      field('Price (USD)', `<input id="p-price" type="number" step="0.01" min="0" value="${p?.price ?? ''}" />`),
      field('Your cost (USD)', `<input id="p-cost" type="number" step="0.01" min="0" value="${p?.cost ?? 0}" /><span class="hint">What this item costs you. Used for profit only — never shown to customers.</span>`),
      field('Name', `<input id="p-name" value="${esc(p?.name || '')}" />`, true),
      field('Description', `<textarea id="p-desc" placeholder="Shown on the product page">${esc(p?.description || '')}</textarea>`, true),
      field('Uses stock inventory', `<label class="switch"><input type="checkbox" id="p-stock" ${p?.usesStock !== false ? 'checked' : ''}/><span class="track"></span></label><span class="hint">Off = unlimited, delivers fixed content</span>`, true),
      field('Fixed delivery content (when stock is off)', `<textarea id="p-fixed" placeholder="Delivered to buyer. Supports {order_id}">${esc(p?.fixedContent || '')}</textarea>`, true),
      field('Active (visible in shop)', `<label class="switch"><input type="checkbox" id="p-active" ${p?.isActive !== false ? 'checked' : ''}/><span class="track"></span></label>`, true),
    ]);
    const save = el('button', { class: 'btn btn-primary', text: isNew ? 'Create Product' : 'Save Changes' });
    save.onclick = async () => {
      const payload = {
        name: f('p-name').value.trim(), emoji: f('p-emoji').value.trim() || '🛍️',
        emojiId: f('p-emoji-id').value.trim(),
        description: f('p-desc').value, price: parseFloat(f('p-price').value),
        cost: parseFloat(f('p-cost').value) || 0,
        usesStock: f('p-stock').checked, fixedContent: f('p-fixed').value,
        isActive: f('p-active').checked,
      };
      if (!payload.name || !(payload.price >= 0)) return toast('Name and a valid price are required', 'bad');
      save.disabled = true;
      try {
        if (isNew) await API.post('/products', payload);
        else await API.put(`/products/${p.id}`, payload);
        toast(isNew ? 'Product created' : 'Product updated');
        closeModal(); products();
      } catch (e) { toast(e.message, 'bad'); save.disabled = false; }
    };
    modal({ title: isNew ? 'New Product' : 'Edit Product', body, footer: [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }), save], wide: true });
  }

  async function deleteProduct(p) {
    if (!(await confirmDialog({ title: 'Delete product?', message: `“${p.name}” will be removed. If it has order history it will be hidden instead.`, confirmText: 'Delete', danger: true }))) return;
    try { const r = await API.del(`/products/${p.id}`); toast(r.softDeleted ? 'Product hidden (has history)' : 'Product deleted'); products(); }
    catch (e) { toast(e.message, 'bad'); }
  }

  async function stockModal(p) {
    const m = modal({
      title: `📦 Stock · ${p.emoji} ${p.name}`,
      subtitle: 'Paste one item (code/account) per line. Each line becomes one deliverable unit.',
      body: el('div', {}, [spinner()]),
      wide: true,
    });
    let data;
    try { data = await API.stock(p.id); } catch (e) { return toast(e.message, 'bad'); }

    const textarea = el('textarea', { id: 'stock-input', placeholder: 'ACCOUNT-1:pass\nACCOUNT-2:pass\nCODE-XXXX-YYYY', style: 'min-height:150px' });
    const info = el('div', { class: 'row-flex', style: 'margin:12px 0' }, [
      el('span', { class: 'stock-chip', text: `${data.available} available` }),
      el('span', { class: 'badge EXPIRED', text: `${data.sold} sold` }),
      el('button', { class: 'btn btn-sm btn-danger right', html: '🧹 Clear unsold', onclick: async () => {
        if (!(await confirmDialog({ title: 'Clear unsold stock?', message: 'Deletes all unsold items for this product.', confirmText: 'Clear', danger: true }))) return;
        try { await API.del(`/stock/product/${p.id}/clear`); toast('Unsold stock cleared'); stockModal(p); } catch (e) { toast(e.message, 'bad'); }
      } }),
    ]);

    const listWrap = el('div', { class: 'table-wrap', style: 'max-height:220px;overflow-y:auto' });
    const t = el('table'); t.appendChild(el('thead', {}, [el('tr', {}, [el('th', { text: 'Content' }), el('th', { text: 'Status' }), el('th', { text: '' })])]));
    const tb = el('tbody');
    for (const it of data.items) {
      tb.appendChild(el('tr', {}, [
        el('td', { class: 'mono', text: truncate(it.content, 46) }),
        el('td', {}, [el('span', { class: `badge ${it.isSold ? 'DELIVERED' : 'PAID'}`, text: it.isSold ? 'sold' : 'available' })]),
        el('td', {}, [it.isSold ? el('span', { class: 't-muted', text: dateTime(it.soldAt) }) : el('button', { class: 'btn btn-sm btn-danger', text: '✕', onclick: async () => { try { await API.del(`/stock/${it.id}`); toast('Removed'); stockModal(p); } catch (e) { toast(e.message, 'bad'); } } })]),
      ]));
    }
    t.appendChild(tb); listWrap.appendChild(data.items.length ? t : emptyState('📭', 'No stock items yet'));

    const addBtn = el('button', { class: 'btn btn-primary', html: '＋ Add stock' });
    addBtn.onclick = async () => {
      const content = textarea.value.trim();
      if (!content) return toast('Paste at least one line', 'bad');
      addBtn.disabled = true;
      try { const r = await API.post(`/stock/product/${p.id}`, { content }); toast(`Added ${r.added} item(s)`); textarea.value = ''; stockModal(p); }
      catch (e) { toast(e.message, 'bad'); addBtn.disabled = false; }
    };

    m.querySelector('.modal-head').insertAdjacentElement('afterend',
      el('div', {}, [
        el('div', { class: 'field' }, [el('span', { text: 'Add new stock' }), textarea]),
        el('div', { class: 'modal-foot', style: 'margin-top:12px' }, [addBtn]),
        info, listWrap,
        el('div', { class: 'modal-foot' }, [el('button', { class: 'btn btn-ghost', text: 'Done', onclick: () => { closeModal(); products(); } })]),
      ])
    );
    // remove the spinner we injected as body
    const spin = m.querySelector('.loading'); if (spin) spin.remove();
  }

  // ============================ ORDERS ============================
  const orderState = { status: 'ALL', search: '', page: 1 };
  async function orders() {
    const wrap = el('div');
    const statuses = ['ALL', 'PENDING', 'PAID', 'DELIVERED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'FAILED'];
    const seg = el('div', { class: 'seg' }, statuses.map((s) =>
      el('button', { class: orderState.status === s ? 'active' : '', text: s === 'ALL' ? 'All' : s[0] + s.slice(1).toLowerCase(), onclick: () => { orderState.status = s; orderState.page = 1; orders(); } })));
    const search = el('div', { class: 'search grow' }, [el('input', { placeholder: 'Search order id, username, telegram id…', value: orderState.search, onkeydown: (e) => { if (e.key === 'Enter') { orderState.search = e.target.value.trim(); orderState.page = 1; orders(); } } })]);
    wrap.appendChild(el('div', { class: 'toolbar' }, [seg, search]));

    const container = el('div', {}, [spinner()]);
    wrap.appendChild(container);
    mount(wrap);

    let data;
    try { data = await API.orders({ status: orderState.status, search: orderState.search, page: orderState.page, pageSize: 25 }); }
    catch (e) { container.innerHTML = ''; container.appendChild(errorBox(e)); return; }

    container.innerHTML = '';
    if (!data.orders.length) { container.appendChild(el('div', { class: 'card' }, [emptyState('🧾', 'No orders match')])); return; }
    container.appendChild(el('div', { class: 'table-wrap' }, [ordersTable(data.orders)]));
    container.appendChild(pager(data, (pg) => { orderState.page = pg; orders(); }));
  }

  async function orderDetail(id) {
    modal({ title: 'Order', body: el('div', {}, [spinner()]), wide: true });
    let data;
    try { data = (await API.order(id)).order; } catch (e) { return toast(e.message, 'bad'); }

    const o = data;
    const actions = el('div', { class: 'modal-foot', style: 'flex-wrap:wrap' }, []);
    const act = (label, cls, fn) => { const b = el('button', { class: `btn btn-sm ${cls}`, html: label }); b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'bad'); b.disabled = false; } }; return b; };
    if (o.status === 'PENDING') actions.appendChild(act('🔄 Re-check payment', 'btn-good', async () => { const r = await API.post(`/orders/${o.id}/recheck`); toast(`Status: ${r.status}`); closeModal(); orderDetail(o.id); }));
    if (['PAID', 'DELIVERED'].includes(o.status)) actions.appendChild(act('📤 Re-deliver', 'btn-good', async () => { await API.post(`/orders/${o.id}/redeliver`); toast('Delivery re-sent'); }));
    if (['PAID', 'DELIVERED'].includes(o.status)) actions.appendChild(act('↩️ Mark refunded', '', async () => { await API.post(`/orders/${o.id}/refund`); toast('Marked refunded'); closeModal(); orderDetail(o.id); }));
    if (o.status === 'PENDING') actions.appendChild(act('✕ Cancel', 'btn-danger', async () => { await API.post(`/orders/${o.id}/cancel`); toast('Cancelled'); closeModal(); orderDetail(o.id); }));

    const itemsList = el('div', {}, o.items.map((i) => el('div', { style: 'padding:8px 0;border-bottom:1px solid var(--stroke)' }, [
      el('div', { class: 'row-flex' }, [el('span', { text: i.emoji }), el('span', { class: 't-strong', text: `${i.productName} ×${i.quantity}` }), el('span', { class: 'right t-strong', text: money(i.lineTotal, o.currency) })]),
      i.delivered && i.delivered.length ? el('div', { class: 'deliver-box copyable', title: 'Click to copy', text: i.delivered.join('\n'), onclick: () => copy(i.delivered.join('\n')) }) : null,
    ])));

    const kv = el('div', { class: 'kv' }, [
      el('div', { class: 'k', text: 'Order ID' }), el('div', { class: 'v mono', text: o.publicId }),
      el('div', { class: 'k', text: 'Status' }), el('div', { class: 'v' }, [badge(o.status)]),
      el('div', { class: 'k', text: 'Customer' }), el('div', { class: 'v', text: (o.user?.username ? '@' + o.user.username : o.user?.firstName || '—') }),
      el('div', { class: 'k', text: 'Telegram ID' }), el('div', { class: 'v mono', text: o.user?.telegramId || '—' }),
      el('div', { class: 'k', text: 'Amount' }), el('div', { class: 'v', text: money(o.amount, o.currency) }),
      el('div', { class: 'k', text: 'Paid in' }), el('div', { class: 'v', text: o.payAmount ? `${o.payAmount} ${o.payCurrency || ''} ${o.network ? '(' + o.network + ')' : ''}` : '—' }),
      el('div', { class: 'k', text: 'Created' }), el('div', { class: 'v', text: dateTime(o.createdAt) }),
      el('div', { class: 'k', text: 'Paid at' }), el('div', { class: 'v', text: dateTime(o.paidAt) }),
      el('div', { class: 'k', text: 'Delivered' }), el('div', { class: 'v', text: dateTime(o.deliveredAt) }),
    ]);

    const timeline = el('div', { class: 'timeline' }, (o.events || []).map((ev) => el('div', { class: 'tl-item' }, [
      el('div', { class: 'tl-dot' }),
      el('div', { class: 'tl-body' }, [el('div', { class: 'tl-type', text: ev.type.replace(/_/g, ' ') }), ev.message ? el('div', { class: 't-muted', text: ev.message }) : null, el('div', { class: 'tl-time', text: dateTime(ev.createdAt) })]),
    ])));

    const body = el('div', {}, [
      el('div', { class: 'grid cols-2' }, [
        el('div', {}, [el('h3', { style: 'font-family:var(--font-head);margin:0 0 10px', text: 'Details' }), kv]),
        el('div', {}, [el('h3', { style: 'font-family:var(--font-head);margin:0 0 10px', text: 'Timeline' }), o.events?.length ? timeline : el('div', { class: 'hint', text: 'No events' })]),
      ]),
      el('h3', { style: 'font-family:var(--font-head);margin:18px 0 6px', text: 'Items' }), itemsList,
    ]);

    const m = $('#modal');
    m.innerHTML = '';
    modal({ title: `Order ${o.publicId}`, subtitle: o.payUrl ? 'Hosted invoice active' : '', body, footer: null, wide: true });
    $('#modal').appendChild(actions);
    $('#modal').appendChild(el('div', { class: 'modal-foot' }, [el('button', { class: 'btn btn-ghost', text: 'Close', onclick: closeModal })]));
  }

  // ============================ USERS ============================
  const userState = { search: '', page: 1 };
  async function users() {
    const wrap = el('div');
    const search = el('div', { class: 'search grow' }, [el('input', { placeholder: 'Search username, name, telegram id…', value: userState.search, onkeydown: (e) => { if (e.key === 'Enter') { userState.search = e.target.value.trim(); userState.page = 1; users(); } } })]);
    wrap.appendChild(el('div', { class: 'toolbar' }, [search]));
    const container = el('div', {}, [spinner()]);
    wrap.appendChild(container); mount(wrap);

    let data;
    try { data = await API.users({ search: userState.search, page: userState.page, pageSize: 25 }); }
    catch (e) { container.innerHTML = ''; container.appendChild(errorBox(e)); return; }

    container.innerHTML = '';
    if (!data.users.length) { container.appendChild(el('div', { class: 'card' }, [emptyState('👥', 'No users found')])); return; }

    const table = el('table');
    table.appendChild(el('thead', {}, [el('tr', {}, [el('th', { text: 'Customer' }), el('th', { text: 'Orders' }), el('th', { text: 'Spent' }), el('th', { text: 'Balance' }), el('th', { text: 'Joined' }), el('th', { text: '' })])]));
    const tb = el('tbody');
    for (const u of data.users) {
      tb.appendChild(el('tr', { style: 'cursor:pointer', onclick: () => userDetail(u.id) }, [
        el('td', {}, [customerCell(u), u.isBanned ? el('span', { class: 'badge FAILED', text: 'banned', style: 'margin-top:4px' }) : null]),
        el('td', { class: 't-strong', text: num(u.orders) }),
        el('td', { text: money(u.totalSpent) }),
        el('td', { text: money(u.balance) }),
        el('td', { class: 't-muted', text: timeAgo(u.createdAt) }),
        el('td', {}, [el('span', { class: 'hint', text: '›' })]),
      ]));
    }
    table.appendChild(tb);
    container.appendChild(el('div', { class: 'table-wrap' }, [table]));
    container.appendChild(pager(data, (pg) => { userState.page = pg; users(); }));
  }

  async function userDetail(id) {
    modal({ title: 'Customer', body: el('div', {}, [spinner()]), wide: true });
    let res;
    try { res = await API.user(id); } catch (e) { return toast(e.message, 'bad'); }
    const u = res.user;

    const kv = el('div', { class: 'kv' }, [
      el('div', { class: 'k', text: 'Name' }), el('div', { class: 'v', text: [u.firstName, u.lastName].filter(Boolean).join(' ') || '—' }),
      el('div', { class: 'k', text: 'Username' }), el('div', { class: 'v', text: u.username ? '@' + u.username : '—' }),
      el('div', { class: 'k', text: 'Telegram ID' }), el('div', { class: 'v mono', text: u.telegramId }),
      el('div', { class: 'k', text: 'Balance' }), el('div', { class: 'v', text: money(u.balance) }),
      el('div', { class: 'k', text: 'Total spent' }), el('div', { class: 'v', text: money(u.totalSpent) }),
      el('div', { class: 'k', text: 'Joined' }), el('div', { class: 'v', text: dateTime(u.createdAt) }),
    ]);

    const msgArea = el('textarea', { placeholder: 'Send a direct message to this customer…', style: 'min-height:70px' });
    const balInput = el('input', { type: 'number', step: '0.01', placeholder: 'e.g. 5 or -5', style: 'max-width:140px' });

    const actions = el('div', { class: 'row-flex', style: 'gap:8px;flex-wrap:wrap;margin-top:10px' }, [
      el('button', { class: `btn btn-sm ${u.isBanned ? 'btn-good' : 'btn-danger'}`, html: u.isBanned ? '✓ Unban' : '⛔ Ban', onclick: async () => { try { const r = await API.post(`/users/${u.id}/ban`, { banned: !u.isBanned }); toast(r.isBanned ? 'User banned' : 'User unbanned'); closeModal(); userDetail(u.id); } catch (e) { toast(e.message, 'bad'); } } }),
      balInput,
      el('button', { class: 'btn btn-sm', html: '💰 Adjust balance', onclick: async () => { const delta = parseFloat(balInput.value); if (!isFinite(delta)) return toast('Enter an amount', 'bad'); try { const r = await API.post(`/users/${u.id}/balance`, { delta }); toast(`Balance: ${money(r.balance)}`); closeModal(); userDetail(u.id); } catch (e) { toast(e.message, 'bad'); } } }),
    ]);

    const sendBtn = el('button', { class: 'btn btn-primary btn-sm', html: '📨 Send message', onclick: async () => { const text = msgArea.value.trim(); if (!text) return toast('Type a message', 'bad'); try { const r = await API.post(`/users/${u.id}/message`, { text }); toast(r.ok ? 'Message sent' : (r.error || 'Failed'), r.ok ? 'good' : 'bad'); msgArea.value = ''; } catch (e) { toast(e.message, 'bad'); } } });

    const ordersList = res.orders.length
      ? el('div', { class: 'table-wrap', style: 'margin-top:8px' }, [(() => {
          const t = el('table'); t.appendChild(el('thead', {}, [el('tr', {}, [el('th', { text: 'Order' }), el('th', { text: 'Items' }), el('th', { text: 'Amount' }), el('th', { text: 'Status' })])]));
          const tb = el('tbody');
          for (const o of res.orders) tb.appendChild(el('tr', { style: 'cursor:pointer', onclick: () => orderDetail(o.id) }, [el('td', { class: 'mono', text: o.publicId }), el('td', { class: 't-muted', text: truncate(o.summary, 32) }), el('td', { text: money(o.amount, o.currency) }), el('td', {}, [badge(o.status)])]));
          t.appendChild(tb); return t;
        })()])
      : el('div', { class: 'hint', style: 'margin-top:8px', text: 'No orders yet' });

    const body = el('div', {}, [
      el('div', { class: 'grid cols-2' }, [
        el('div', {}, [el('h3', { style: 'font-family:var(--font-head);margin:0 0 10px', text: 'Profile' }), kv, actions]),
        el('div', {}, [el('h3', { style: 'font-family:var(--font-head);margin:0 0 10px', text: 'Message' }), msgArea, el('div', { style: 'margin-top:8px' }, [sendBtn])]),
      ]),
      el('h3', { style: 'font-family:var(--font-head);margin:18px 0 4px', text: 'Recent Orders' }), ordersList,
    ]);
    modal({ title: (u.username ? '@' + u.username : u.firstName || 'Customer'), body, footer: [el('button', { class: 'btn btn-ghost', text: 'Close', onclick: closeModal })], wide: true });
  }

  // ============================ BROADCAST ============================
  async function broadcast() {
    const textarea = el('textarea', { id: 'bc-text', placeholder: 'Write an announcement… HTML supported: <b>bold</b>, <i>italic</i>, <a href="...">link</a>', style: 'min-height:140px' });
    const sendBtn = el('button', { class: 'btn btn-primary', html: '🚀 Send to all users' });
    const progress = el('div', { class: 'hint', style: 'margin-top:10px' });

    sendBtn.onclick = async () => {
      const text = textarea.value.trim();
      if (!text) return toast('Write a message first', 'bad');
      if (!(await confirmDialog({ title: 'Send broadcast?', message: 'This message will be delivered to every non-banned user.', confirmText: 'Send now' }))) return;
      sendBtn.disabled = true;
      try {
        const r = await API.post('/broadcast', { text });
        toast(`Broadcasting to ${r.recipients} users…`);
        pollBroadcast(progress, sendBtn);
      } catch (e) { toast(e.message, 'bad'); sendBtn.disabled = false; }
    };

    const composer = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '📣 New Broadcast' })]),
      textarea,
      el('div', { class: 'modal-foot', style: 'margin-top:14px' }, [sendBtn]),
      progress,
    ]);

    const histCard = el('div', { class: 'card', style: 'margin-top:18px' }, [el('div', { class: 'card-head' }, [el('h3', { text: 'History' })]), el('div', { id: 'bc-history' }, [spinner()])]);
    mount(el('div', {}, [composer, histCard]));

    try {
      const h = await API.get('/broadcast/history');
      const box = document.getElementById('bc-history'); box.innerHTML = '';
      if (!h.items.length) box.appendChild(emptyState('📭', 'No broadcasts sent yet'));
      else for (const b of h.items) box.appendChild(el('div', { style: 'padding:10px 0;border-bottom:1px solid var(--stroke)' }, [
        el('div', { class: 't-strong', text: truncate(b.text.replace(/<[^>]+>/g, ''), 80) }),
        el('div', { class: 'hint' }, [el('span', { text: `✅ ${b.sentCount} sent · ⛔ ${b.failCount} failed · ${dateTime(b.createdAt)}` })]),
      ]));
    } catch { /* ignore */ }
  }

  async function pollBroadcast(progressEl, btn) {
    const iv = setInterval(async () => {
      try {
        const s = await API.get('/broadcast/status');
        if (s.lastResult) progressEl.innerHTML = `Sending… <b>${s.lastResult.sent}</b>/${s.lastResult.total} · failed ${s.lastResult.failed}`;
        if (!s.inProgress) { clearInterval(iv); btn.disabled = false; if (s.lastResult) { toast(`Broadcast done · ${s.lastResult.sent} delivered`); broadcast(); } }
      } catch { clearInterval(iv); btn.disabled = false; }
    }, 1200);
  }

  // ============================ SETTINGS ============================
  async function settings() {
    loading();
    let data;
    try { data = await API.settings(); } catch (e) { return mount(errorBox(e)); }
    const s = data.settings; const rt = data.runtime;

    const health = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '🩺 System Health' })]),
      el('div', { class: 'kv' }, [
        el('div', { class: 'k', text: 'Bot' }), el('div', { class: 'v' }, [healthPill(rt.botConfigured)]),
        el('div', { class: 'k', text: 'Cryptomus' }), el('div', { class: 'v' }, [healthPill(rt.cryptomusConfigured)]),
        el('div', { class: 'k', text: 'Environment' }), el('div', { class: 'v', text: rt.env }),
        el('div', { class: 'k', text: 'Currency' }), el('div', { class: 'v', text: rt.currency }),
        el('div', { class: 'k', text: 'Poll interval' }), el('div', { class: 'v', text: rt.pollIntervalSec + 's' }),
        el('div', { class: 'k', text: 'Order expiry' }), el('div', { class: 'v', text: rt.orderExpiryMin + ' min' }),
        el('div', { class: 'k', text: 'Admin IDs' }), el('div', { class: 'v mono', text: (rt.adminTelegramIds || []).join(', ') || '—' }),
      ]),
      rt.missing?.length ? el('div', { class: 'toast bad', style: 'margin-top:12px' }, [el('span', { class: 'tc', text: '⚠️' }), el('div', { text: 'Missing env: ' + rt.missing.join(', ') })]) : null,
      el('div', { class: 'field', style: 'margin-top:14px' }, [el('span', { text: 'Cryptomus webhook URL (set in Cryptomus dashboard)' }),
        el('div', { class: 'row-flex' }, [el('input', { value: rt.webhookUrl, readonly: true, class: 'mono' }), el('button', { class: 'btn btn-sm', text: 'Copy', onclick: () => copy(rt.webhookUrl) })])]),
    ]);

    const f = (key, label, multi) => field(label, multi
      ? `<textarea id="s-${key}">${esc(s[key] || '')}</textarea>`
      : `<input id="s-${key}" value="${esc(s[key] || '')}" />`, true);

    const maint = s.maintenance_mode === 'true';
    const content = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '✏️ Bot Content & Messages' }), el('div', { class: 'sub', text: 'Use {shop_name} as a placeholder' })]),
      el('div', { class: 'form-grid' }, [
        field('Shop name', `<input id="s-shop_name" value="${esc(s.shop_name || '')}" />`),
        field('Maintenance mode', `<label class="switch"><input type="checkbox" id="s-maintenance_mode" ${maint ? 'checked' : ''}/><span class="track"></span></label>`),
        f('welcome_message', 'Welcome message', true),
        f('shop_intro', 'Shop intro', true),
        f('order_paid_message', 'Payment confirmed message', true),
        f('support_text', 'Support text', true),
        f('faq_text', 'FAQ text', true),
        f('maintenance_text', 'Maintenance message', true),
      ]),
    ]);

    const saveBtn = el('button', { class: 'btn btn-primary', html: '💾 Save settings' });
    saveBtn.onclick = async () => {
      const keys = ['shop_name', 'welcome_message', 'shop_intro', 'order_paid_message', 'support_text', 'faq_text', 'maintenance_text'];
      const payload = {};
      for (const k of keys) { const elx = document.getElementById(`s-${k}`); if (elx) payload[k] = elx.value; }
      payload.maintenance_mode = document.getElementById('s-maintenance_mode').checked ? 'true' : 'false';
      saveBtn.disabled = true;
      try { await API.put('/settings', { settings: payload }); toast('Settings saved'); document.getElementById('brand-name').textContent = payload.shop_name || 'Shop Control'; }
      catch (e) { toast(e.message, 'bad'); }
      saveBtn.disabled = false;
    };

    mount(el('div', {}, [el('div', { class: 'grid cols-2' }, [content, health]), el('div', { class: 'modal-foot', style: 'margin-top:18px' }, [saveBtn])]));
  }

  // ============================ SUPPLIERS ============================
  const fmtNum = (n, cur) => (n == null ? '—' : `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${cur || ''}`.trim());

  async function suppliers() {
    loading();
    let d;
    try { d = await API.get('/suppliers'); } catch (e) { return mount(errorBox(e)); }

    const head = el('div', { class: 'toolbar' }, [
      el('div', { class: 'hint grow', text: 'Sell your suppliers’ products with live stock. Prices = supplier price ÷ rate + your markup, updated automatically every minute. When a customer buys, the bot orders from the supplier and delivers instantly.' }),
      el('button', { class: 'btn btn-primary', html: '＋ Add supplier', onclick: () => supplierModal(null, d) }),
    ]);

    const body = d.suppliers.length
      ? el('div', { class: 'grid cols-2' }, d.suppliers.map((s) => {
          const act = (label, cls, fn) => el('button', { class: `btn btn-sm ${cls}`, html: label, onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); } catch (err) { toast(err.message, 'bad'); } b.disabled = false; } });
          return el('div', { class: 'card' + (s.isActive ? '' : ' dim') }, [
            el('div', { class: 'card-head' }, [
              el('h3', { text: `🚚 ${s.name}` }),
              el('span', { class: `badge ${s.isActive ? (s.lastSyncError ? 'FAILED' : 'DELIVERED') : 'CANCELLED'}`, text: !s.isActive ? 'disabled' : s.lastSyncError ? 'sync error' : 'connected' }),
            ]),
            el('div', { class: 'kv' }, [
              el('div', { class: 'k', text: 'Type' }), el('div', { class: 'v', text: s.typeLabel }),
              el('div', { class: 'k', text: 'Balance there' }), el('div', { class: 'v t-strong', text: fmtNum(s.balance, s.currency) }),
              el('div', { class: 'k', text: 'Rate' }), el('div', { class: 'v', text: `1 ${d.shopCurrency} = ${fmtNum(s.rate, s.currency)}` }),
              el('div', { class: 'k', text: 'Markup' }), el('div', { class: 'v', text: `+${s.markupPct}%` }),
              el('div', { class: 'k', text: 'Products' }), el('div', { class: 'v', text: `${s.selling} in my shop · ${s.products} available` }),
              el('div', { class: 'k', text: 'API key' }), el('div', { class: 'v mono', text: s.keyHint ? '••••' + s.keyHint : '—' }),
              el('div', { class: 'k', text: 'Last sync' }), el('div', { class: 'v', text: s.lastSyncAt ? timeAgo(s.lastSyncAt) : 'never' }),
            ]),
            s.lastSyncError ? el('div', { class: 'toast bad', style: 'margin-top:10px' }, [el('span', { class: 'tc', text: '⚠️' }), el('div', { class: 'mono', style: 'font-size:12px', text: s.lastSyncError })]) : null,
            el('div', { class: 'row-flex', style: 'gap:6px;flex-wrap:wrap;margin-top:12px' }, [
              act('🛍️ Products', 'btn-primary', async () => supplierProducts(s.id)),
              act('🔄 Sync now', '', async () => { const r = await API.post(`/suppliers/${s.id}/sync`); toast(`Synced: ${r.result.variants} products (${r.result.created} new, ${r.result.updated} updated)`); suppliers(); }),
              act('🧪 Test', '', async () => supplierTest(s)),
              act('✎ Edit', '', async () => supplierModal(s, d)),
              act(s.isActive ? 'Disable' : 'Enable', '', async () => { await API.put(`/suppliers/${s.id}`, { isActive: !s.isActive }); toast(s.isActive ? 'Supplier disabled — its products are hidden' : 'Supplier enabled'); suppliers(); }),
              act('🗑', 'btn-danger', async () => {
                if (!(await confirmDialog({ title: 'Delete supplier?', message: `“${s.name}” will be removed and its ${s.products} products hidden. Order history is kept.`, confirmText: 'Delete', danger: true }))) return;
                await API.del(`/suppliers/${s.id}`); toast('Supplier deleted'); suppliers();
              }),
            ]),
          ]);
        }))
      : el('div', { class: 'card' }, [emptyState('🚚', 'No suppliers yet. Add one with its API key to import products with live stock.')]);

    mount(el('div', {}, [head, el('div', { style: 'margin-top:14px' }, [body])]));
  }

  function supplierModal(s, d) {
    const isNew = !s;
    const types = d.types || [];
    const t0 = types.find((t) => t.type === (s?.type || 'tokopremium')) || types[0];
    const f = (id) => document.getElementById(id);
    const body = el('div', { class: 'form-grid' }, [
      field('Supplier name', `<input id="sp-name" value="${esc(s?.name || '')}" placeholder="e.g. TokoPremium" />`),
      field('API type', `<select id="sp-type">${types.map((t) => `<option value="${t.type}" ${t.type === t0.type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`),
      field('API base URL', `<input id="sp-url" class="mono" value="${esc(s?.baseUrl || t0.defaultBaseUrl)}" />`, true),
      field(isNew ? 'API key' : `API key (leave empty to keep ••••${esc(s.keyHint || '')})`, `<input id="sp-key" type="password" autocomplete="off" class="mono" placeholder="tpk_…" />`, true),
      field('Supplier currency', `<input id="sp-cur" value="${esc(s?.currency || t0.defaultCurrency)}" />`),
      field(`Rate: 1 ${d.shopCurrency} = ? supplier currency`, `<input id="sp-rate" type="number" step="0.0001" value="${s ? s.rate : ''}" placeholder="e.g. 16500" />`),
      field('Markup % (your profit)', `<input id="sp-markup" type="number" step="0.1" value="${s ? s.markupPct : 20}" />`),
    ]);
    const preview = el('div', { class: 'hint', style: 'margin-top:10px' });
    const updatePreview = () => {
      const rate = parseFloat(f('sp-rate')?.value), mk = parseFloat(f('sp-markup')?.value) || 0, cur = f('sp-cur')?.value || '';
      if (!(rate > 0)) { preview.textContent = 'Enter the exchange rate to see a price example.'; return; }
      const sample = cur === 'IDR' ? 10000 : 10;
      const cost = sample / rate;
      preview.textContent = `Example: supplier price ${sample.toLocaleString()} ${cur} → your cost ${money(cost, d.shopCurrency)} → you sell at ${money(cost * (1 + mk / 100), d.shopCurrency)}`;
    };
    const save = el('button', { class: 'btn btn-primary', text: isNew ? 'Add & sync' : 'Save' });
    save.onclick = async () => {
      const payload = {
        name: f('sp-name').value.trim(), type: f('sp-type').value, baseUrl: f('sp-url').value.trim(),
        currency: f('sp-cur').value.trim(), rate: parseFloat(f('sp-rate').value), markupPct: parseFloat(f('sp-markup').value),
      };
      const key = f('sp-key').value.trim();
      if (key) payload.apiKey = key;
      if (isNew && !key) return toast('Enter the API key', 'bad');
      if (!(payload.rate > 0)) return toast('Enter the exchange rate', 'bad');
      save.disabled = true; save.textContent = isNew ? 'Connecting…' : 'Saving…';
      try {
        if (isNew) {
          const r = await API.post('/suppliers', payload);
          closeModal();
          if (r.syncError) toast(`Saved, but sync failed: ${r.syncError}`, 'bad');
          else toast(`Connected! ${r.sync.variants} products found — turn on “In my shop” for the ones you want to sell`);
          supplierProducts(r.supplier.id);
        } else {
          await API.put(`/suppliers/${s.id}`, payload);
          closeModal(); toast('Supplier saved — prices recalculated'); suppliers();
        }
      } catch (e) { toast(e.message, 'bad'); save.disabled = false; save.textContent = isNew ? 'Add & sync' : 'Save'; }
    };
    modal({ title: isNew ? 'Add supplier' : `Edit ${s.name}`, subtitle: 'The API key is stored encrypted and never shown again.', body: el('div', {}, [body, preview]), footer: [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }), save], wide: true });
    ['sp-rate', 'sp-markup', 'sp-cur'].forEach((id) => f(id).addEventListener('input', updatePreview));
    f('sp-type').addEventListener('change', () => { const t = types.find((x) => x.type === f('sp-type').value); if (t && isNew) { f('sp-url').value = t.defaultBaseUrl; f('sp-cur').value = t.defaultCurrency; } });
    updatePreview();
  }

  async function supplierTest(s) {
    modal({ title: `Testing ${s.name}…`, body: el('div', {}, [spinner()]), wide: true });
    const r = await API.post(`/suppliers/${s.id}/test`);
    if (!r.ok) {
      return modal({ title: '❌ Connection failed', body: el('div', {}, [
        el('div', { class: 'kv' }, [
          el('div', { class: 'k', text: 'Error' }), el('div', { class: 'v', text: r.error }),
          el('div', { class: 'k', text: 'Code' }), el('div', { class: 'v mono', text: r.code || '—' }),
          el('div', { class: 'k', text: 'HTTP' }), el('div', { class: 'v', text: String(r.status || '—') }),
          el('div', { class: 'k', text: 'Request ID' }), el('div', { class: 'v mono', text: r.requestId || '—' }),
        ]),
      ]), footer: [el('button', { class: 'btn', text: 'Close', onclick: closeModal })], wide: true });
    }
    const t = el('table');
    t.appendChild(el('thead', {}, [el('tr', {}, ['Variant', 'Name', 'Supplier price', 'Stock', 'Your cost', 'Your price'].map((h) => el('th', { text: h })))]));
    t.appendChild(el('tbody', {}, r.sampleParsed.map((v) => el('tr', {}, [
      el('td', { class: 'mono', text: v.variantId }), el('td', { text: v.name }), el('td', { text: fmtNum(v.supplierPrice, s.currency) }),
      el('td', { text: String(v.stock) }), el('td', { text: money(v.cost) }), el('td', { class: 't-strong', text: money(v.price) }),
    ]))));
    modal({
      title: '✅ Connected',
      subtitle: `${r.variantCount} products found. Check the parsed values match the supplier's raw data.`,
      body: el('div', {}, [
        el('h3', { style: 'font-family:var(--font-head);margin:0 0 6px', text: 'Parsed (first 5)' }),
        el('div', { class: 'table-wrap' }, [t]),
        el('h3', { style: 'font-family:var(--font-head);margin:16px 0 6px', text: '/ping' }),
        el('pre', { class: 'mono', style: 'white-space:pre-wrap;font-size:12px;max-height:160px;overflow:auto', text: JSON.stringify(r.ping, null, 2) }),
        el('h3', { style: 'font-family:var(--font-head);margin:16px 0 6px', text: 'Raw /products sample' }),
        el('pre', { class: 'mono', style: 'white-space:pre-wrap;font-size:12px;max-height:260px;overflow:auto', text: JSON.stringify(r.sampleRaw, null, 2) }),
      ]),
      footer: [el('button', { class: 'btn', text: 'Copy raw sample', onclick: () => copy(JSON.stringify(r.sampleRaw, null, 2)) }), el('button', { class: 'btn btn-primary', text: 'Close', onclick: closeModal })],
      wide: true,
    });
  }

  const supState = { id: null, q: '', filter: 'all' };
  async function supplierProducts(id) {
    if (supState.id !== id) Object.assign(supState, { id, q: '', filter: 'all' });
    loading();
    let d;
    try { d = await API.get(`/suppliers/${id}/products`); } catch (e) { return mount(errorBox(e)); }
    const s = d.supplier;
    const reload = () => supplierProducts(id);
    const bulk = (label, cls, payload, msg, confirmOpts) => el('button', { class: `btn btn-sm ${cls}`, text: label, onclick: async () => {
      if (confirmOpts && !(await confirmDialog(confirmOpts))) return;
      try { const r = await API.post(`/suppliers/${id}/products/select`, payload); toast(`${r.count} ${msg}`); reload(); } catch (e) { toast(e.message, 'bad'); }
    } });

    const search = el('input', { placeholder: 'Search products…', value: supState.q });
    const tableWrap = el('div', { class: 'table-wrap' });
    const draw = () => {
      const q = supState.q.toLowerCase();
      const rows = d.products.filter((p) => (!q || p.name.toLowerCase().includes(q)) &&
        (supState.filter === 'all' || (supState.filter === 'selected' ? p.selected : !p.selected)));
      tableWrap.innerHTML = '';
      if (!rows.length) return tableWrap.appendChild(emptyState('📦', d.products.length ? 'No products match' : 'No products imported yet — press Sync now'));
      const t = el('table');
      t.appendChild(el('thead', {}, [el('tr', {}, ['Product', `Supplier price (${s.currency})`, 'Your cost', 'Your price', 'Stock', 'Sold', 'In my shop'].map((h) => el('th', { text: h })))]));
      t.appendChild(el('tbody', {}, rows.map((p) => {
        const sw = el('input', { type: 'checkbox' }); sw.checked = p.selected;
        sw.onchange = async () => {
          try {
            await API.post(`/suppliers/${id}/products/select`, { selected: sw.checked, productIds: [p.id] });
            p.selected = sw.checked; p.isActive = sw.checked;
            toast(sw.checked ? `Added to your shop: ${p.name}` : `Removed from your shop: ${p.name}`);
            draw();
          } catch (e) { sw.checked = !sw.checked; toast(e.message, 'bad'); }
        };
        // Selected but hidden on the Products page → say so, it isn't on sale.
        const note = p.selected && !p.isActive ? el('div', { class: 't-muted', style: 'font-size:11px', text: 'hidden on Products page' }) : null;
        return el('tr', {}, [
          el('td', {}, [el('div', { class: 't-strong', text: p.name }), el('div', { class: 't-muted mono', style: 'font-size:11px', text: p.variantId }), note]),
          el('td', { text: fmtNum(p.supplierPrice) }),
          el('td', { class: 't-muted', text: money(p.cost) }),
          el('td', { class: 't-strong', text: money(p.price) }),
          el('td', {}, [el('span', { class: `stock-chip ${p.supplierStock === 0 ? 'zero' : p.supplierStock <= 3 ? 'low' : ''}`, text: p.supplierStock === 0 ? 'Out' : String(p.supplierStock) })]),
          el('td', { text: String(p.sold) }),
          el('td', {}, [el('label', { class: 'switch' }, [sw, el('span', { class: 'track' })])]),
        ]);
      })));
      tableWrap.appendChild(t);
    };
    search.addEventListener('input', () => { supState.q = search.value; draw(); });
    const selectedCount = d.products.filter((p) => p.selected).length;
    const seg = el('div', { class: 'seg' }, [['all', `All (${d.products.length})`], ['selected', `Selected (${selectedCount})`], ['unselected', 'Not selected']].map(([v, l]) =>
      el('button', { class: supState.filter === v ? 'active' : '', text: l, onclick: () => { supState.filter = v; reload(); } })));

    mount(el('div', {}, [
      el('div', { class: 'toolbar' }, [
        el('button', { class: 'btn btn-sm', text: '‹ All suppliers', onclick: () => suppliers() }),
        el('h2', { style: 'font-family:var(--font-head);margin:0 0 0 8px', text: `🚚 ${s.name}` }),
        el('span', { class: 't-muted', text: `Balance: ${fmtNum(s.balance, s.currency)} · +${s.markupPct}% markup · synced ${s.lastSyncAt ? timeAgo(s.lastSyncAt) : 'never'}` }),
      ]),
      el('div', { class: 'card', style: 'margin-top:14px' }, [
        el('div', { class: 'row-flex', style: 'gap:8px;flex-wrap:wrap;margin-bottom:12px' }, [
          el('div', { class: 'search grow' }, [search]), seg,
          bulk('✅ Add all in stock', 'btn-primary', { selected: true, inStockOnly: true }, 'products added to your shop'),
          bulk('Remove all', 'btn-danger', { selected: false }, 'products removed from your shop',
            { title: 'Remove all from your shop?', message: `All ${selectedCount} selected products from ${s.name} will be removed from your Products page and the bot.`, confirmText: 'Remove all', danger: true }),
          el('button', { class: 'btn btn-sm', text: '🔄 Sync now', onclick: async () => { try { const r = await API.post(`/suppliers/${id}/sync`); toast(`Synced ${r.result.variants} products`); reload(); } catch (e) { toast(e.message, 'bad'); } } }),
        ]),
        el('div', { class: 'hint', style: 'margin-bottom:10px', text: 'Turn on “In my shop” for the products you want to sell — only those appear on your Products page and in the bot. Rename them or change emoji/category on the Products page; price and stock always follow the supplier.' }),
        tableWrap,
      ]),
    ]));
    draw();
  }

  // ============================ RESELLER API ============================
  async function apiKeys() {
    loading();
    let data;
    try { data = await API.get('/api-keys'); } catch (e) { return mount(errorBox(e)); }
    const base = data.baseUrl;

    const nameInput = el('input', { placeholder: 'Reseller / store name, e.g. Rahim Store' });
    const tgInput = el('input', { placeholder: 'Reseller Telegram ID (optional — enables ordering)', inputmode: 'numeric' });
    const createBtn = el('button', { class: 'btn btn-primary', html: '＋ Create API key' });
    createBtn.onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) return toast('Enter a name for this key', 'bad');
      createBtn.disabled = true;
      try {
        const r = await API.post('/api-keys', { name, telegramId: tgInput.value.trim() });
        showNewKey(r.apiKey, r.key.name);
      } catch (e) { toast(e.message, 'bad'); createBtn.disabled = false; }
    };

    const createCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '🔑 New reseller key' }), el('div', { class: 'sub', text: 'One key per reseller, so you can revoke them individually' })]),
      el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, [nameInput, tgInput, el('div', {}, [createBtn])]),
      el('div', { class: 'hint', style: 'margin-top:10px', text: 'With a Telegram ID linked, the reseller can order through the API, paid from that account’s wallet balance. They top up in the bot, or you add balance from the reseller’s Details page. Without one, the key can only read products and stock.' }),
    ]);

    const keysBody = data.keys.length
      ? (() => {
          const t = el('table');
          t.appendChild(el('thead', {}, [el('tr', {}, ['Name', 'Key', 'Reseller account', 'API sales', 'Status', 'Last used', ''].map((h) => el('th', { text: h })))]));
          const tb = el('tbody');
          for (const k of data.keys) {
            const toggle = el('button', { class: 'btn btn-sm', text: k.isActive ? 'Disable' : 'Enable', onclick: async () => {
              try { await API.put(`/api-keys/${k.id}`, { isActive: !k.isActive }); toast(k.isActive ? 'Key disabled' : 'Key enabled'); apiKeys(); } catch (e) { toast(e.message, 'bad'); }
            } });
            const del = el('button', { class: 'btn btn-sm btn-danger', text: 'Delete', onclick: async () => {
              if (!(await confirmDialog({ title: 'Delete API key?', message: `“${k.name}” will stop receiving your products and stock immediately.`, confirmText: 'Delete', danger: true }))) return;
              try { await API.del(`/api-keys/${k.id}`); toast('Key deleted'); apiKeys(); } catch (e) { toast(e.message, 'bad'); }
            } });
            const link = el('button', { class: 'btn btn-sm', text: k.user ? 'Unlink' : 'Link account', onclick: () => linkKeyModal(k) });
            const account = k.user
              ? el('div', {}, [
                  el('div', { text: k.user.username ? '@' + k.user.username : (k.user.firstName || 'User') }),
                  el('div', { class: 't-muted mono', text: `${k.user.telegramId} · ${money(k.user.balance)}` }),
                ])
              : el('span', { class: 't-muted', text: 'not linked (read-only)' });
            const open = () => resellerDetail(k.id);
            tb.appendChild(el('tr', {}, [
              el('td', {}, [el('a', { class: 't-strong', style: 'cursor:pointer;text-decoration:underline', text: k.name, onclick: open })]),
              el('td', { class: 'mono', text: k.keyPrefix + '…' }),
              el('td', {}, [account]),
              el('td', {}, [el('div', { class: 't-strong', text: money(k.stats.revenue) }), el('div', { class: 't-muted', style: 'font-size:11px', text: `${k.stats.orders} orders` })]),
              el('td', {}, [el('span', { class: `badge ${k.isActive ? 'DELIVERED' : 'CANCELLED'}`, text: k.isActive ? 'active' : 'disabled' })]),
              el('td', { text: k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never' }),
              el('td', {}, [el('div', { class: 'row-flex', style: 'gap:6px' }, [el('button', { class: 'btn btn-sm btn-primary', text: 'Details', onclick: open }), link, toggle, del])]),
            ]));
          }
          t.appendChild(tb);
          return el('div', { class: 'table-wrap' }, [t]);
        })()
      : emptyState('🔑', 'No API keys yet. Create one for each reseller.');

    const keysCard = el('div', { class: 'card', style: 'margin-top:18px' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: 'Reseller keys' })]),
      keysBody,
    ]);

    const example = `curl -H "X-API-Key: YOUR_KEY" ${base}/products`;
    const docsCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '📘 How resellers connect' })]),
      el('div', { class: 'field' }, [el('span', { text: 'API base URL' }),
        el('div', { class: 'row-flex' }, [el('input', { value: base, readonly: true, class: 'mono' }), el('button', { class: 'btn btn-sm', text: 'Copy', onclick: () => copy(base) })])]),
      el('div', { class: 'kv', style: 'margin-top:12px' }, [
        el('div', { class: 'k mono', text: 'GET /products' }), el('div', { class: 'v', text: 'All active products with live stock' }),
        el('div', { class: 'k mono', text: 'GET /products/:id' }), el('div', { class: 'v', text: 'A single product' }),
        el('div', { class: 'k mono', text: 'GET /stock' }), el('div', { class: 'v', text: 'Just { productId: stock } — cheap to poll' }),
        el('div', { class: 'k mono', text: 'GET /balance' }), el('div', { class: 'v', text: 'Reseller wallet balance (linked keys)' }),
        el('div', { class: 'k mono', text: 'POST /orders' }), el('div', { class: 'v', text: '{ productId, quantity, reference } → pays from balance, returns the codes instantly' }),
        el('div', { class: 'k mono', text: 'GET /orders[/:id]' }), el('div', { class: 'v', text: 'Order history / one order (by ORD id or reference)' }),
      ]),
      el('div', { class: 'hint', style: 'margin-top:12px', text: 'Send the key in the X-API-Key header. Limit: 120 requests/minute per key. stock is null for unlimited products. Reusing the same reference returns the original order instead of buying twice.' }),
      el('div', { class: 'field', style: 'margin-top:12px' }, [el('span', { text: 'Example' }),
        el('div', { class: 'row-flex' }, [el('input', { value: example, readonly: true, class: 'mono' }), el('button', { class: 'btn btn-sm', text: 'Copy', onclick: () => copy(example) })])]),
    ]);

    mount(el('div', {}, [el('div', { class: 'grid cols-2' }, [createCard, docsCard]), keysCard]));
  }

  // One reseller: account, wallet, API sales stats, top products, order history.
  const resellerState = { id: null, source: 'api', page: 1 };
  async function resellerDetail(id, opts = {}) {
    if (resellerState.id !== id) Object.assign(resellerState, { id, source: 'api', page: 1 });
    Object.assign(resellerState, opts);
    loading();
    let d;
    try { d = await API.get(`/api-keys/${id}/details?source=${resellerState.source}&page=${resellerState.page}`); }
    catch (e) { return mount(errorBox(e)); }
    const k = d.key; const a = d.account; const s = d.stats;
    const reload = () => resellerDetail(id);

    const head = el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn btn-sm', text: '‹ All resellers', onclick: () => apiKeys() }),
      el('h2', { style: 'font-family:var(--font-head);margin:0 0 0 8px', text: k.name }),
      el('span', { class: `badge ${k.isActive ? 'DELIVERED' : 'CANCELLED'}`, text: k.isActive ? 'key active' : 'key disabled' }),
      a?.isBanned ? el('span', { class: 'badge FAILED', text: 'account banned' }) : null,
    ]);

    const tiles = el('div', { class: 'grid cols-4', style: 'margin-top:14px' }, [
      statTile({ icon: '💳', label: 'Wallet Balance', value: a ? money(a.balance) : '—', delta: a ? 'available to order' : 'no account linked', tint: 'linear-gradient(135deg,#37d399,#22d3ee)' }),
      statTile({ icon: '💰', label: 'API Sales', value: money(s.revenue), delta: `+${money(s.todayRevenue)} today`, tint: 'linear-gradient(135deg,#6c5cff,#a855f7)' }),
      statTile({ icon: '🧾', label: 'API Orders', value: num(s.orders), delta: `${num(s.units)} units · ${num(s.last30Orders)} in 30 days`, tint: 'linear-gradient(135deg,#22d3ee,#6c5cff)' }),
      statTile({ icon: s.profit >= 0 ? '📈' : '📉', label: 'Profit from Reseller', value: money(s.profit), delta: `${money(s.last30Revenue)} sales in 30 days`, tint: 'linear-gradient(135deg,#37d399,#6c5cff)' }),
    ]);

    // ---- Account card (wallet + actions) ----
    let accountCard;
    if (a) {
      const balInput = el('input', { type: 'number', step: '0.01', placeholder: 'e.g. 50 or -10', style: 'max-width:140px' });
      const msgArea = el('textarea', { placeholder: 'Message this reseller on Telegram…', style: 'min-height:60px' });
      accountCard = el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('h3', { text: '👤 Reseller account' })]),
        el('div', { class: 'kv' }, [
          el('div', { class: 'k', text: 'Name' }), el('div', { class: 'v', text: [a.firstName, a.lastName].filter(Boolean).join(' ') || '—' }),
          el('div', { class: 'k', text: 'Username' }), el('div', { class: 'v', text: a.username ? '@' + a.username : '—' }),
          el('div', { class: 'k', text: 'Telegram ID' }), el('div', { class: 'v mono', text: a.telegramId }),
          el('div', { class: 'k', text: 'Balance' }), el('div', { class: 'v t-strong', text: money(a.balance) }),
          el('div', { class: 'k', text: 'Total topped up' }), el('div', { class: 'v', text: s.topups ? `${money(s.topups.total)} (${s.topups.count}×)` : '—' }),
          el('div', { class: 'k', text: 'Total spent (bot + API)' }), el('div', { class: 'v', text: money(a.totalSpent) }),
          el('div', { class: 'k', text: 'Last seen in bot' }), el('div', { class: 'v', text: timeAgo(a.lastSeenAt) }),
          el('div', { class: 'k', text: 'Key last used' }), el('div', { class: 'v', text: k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never' }),
          el('div', { class: 'k', text: 'Key created' }), el('div', { class: 'v', text: dateTime(k.createdAt) }),
        ]),
        el('div', { class: 'row-flex', style: 'gap:8px;flex-wrap:wrap;margin-top:12px' }, [
          balInput,
          el('button', { class: 'btn btn-sm btn-primary', html: '💰 Adjust balance', onclick: async () => {
            const delta = parseFloat(balInput.value);
            if (!isFinite(delta) || delta === 0) return toast('Enter an amount (negative to deduct)', 'bad');
            try { const r = await API.post(`/users/${a.id}/balance`, { delta }); toast(`New balance: ${money(r.balance)}`); reload(); } catch (e) { toast(e.message, 'bad'); }
          } }),
          el('button', { class: 'btn btn-sm', text: k.isActive ? 'Disable key' : 'Enable key', onclick: async () => {
            try { await API.put(`/api-keys/${k.id}`, { isActive: !k.isActive }); toast(k.isActive ? 'Key disabled' : 'Key enabled'); reload(); } catch (e) { toast(e.message, 'bad'); }
          } }),
          el('button', { class: `btn btn-sm ${a.isBanned ? 'btn-good' : 'btn-danger'}`, html: a.isBanned ? '✓ Unban account' : '⛔ Ban account', onclick: async () => {
            try { await API.post(`/users/${a.id}/ban`, { banned: !a.isBanned }); toast(a.isBanned ? 'Account unbanned' : 'Account banned — API ordering blocked'); reload(); } catch (e) { toast(e.message, 'bad'); }
          } }),
        ]),
        el('div', { style: 'margin-top:12px' }, [msgArea, el('div', { style: 'margin-top:8px' }, [el('button', { class: 'btn btn-sm', html: '📨 Send message', onclick: async () => {
          const text = msgArea.value.trim(); if (!text) return toast('Type a message', 'bad');
          try { const r = await API.post(`/users/${a.id}/message`, { text }); toast(r.ok ? 'Message sent' : (r.error || 'Failed'), r.ok ? 'good' : 'bad'); if (r.ok) msgArea.value = ''; } catch (e) { toast(e.message, 'bad'); }
        } })])]),
      ]);
    } else {
      accountCard = el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('h3', { text: '👤 Reseller account' })]),
        emptyState('🔗', 'No Telegram account linked — this key can only read products and stock.'),
        el('div', { style: 'text-align:center' }, [el('button', { class: 'btn btn-primary btn-sm', text: 'Link account', onclick: () => linkKeyModal(k, reload) })]),
      ]);
    }

    // ---- Top products ----
    const topCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '🏆 Top products via API' }), s.notDelivered ? el('div', { class: 'sub', text: `${s.notDelivered} API order(s) not delivered` }) : null]),
      d.topProducts.length
        ? el('div', { class: 'table-wrap' }, [(() => {
            const t = el('table');
            t.appendChild(el('thead', {}, [el('tr', {}, ['Product', 'Units', 'Sales'].map((h) => el('th', { text: h })))]));
            t.appendChild(el('tbody', {}, d.topProducts.map((p) => el('tr', {}, [el('td', { text: p.name }), el('td', { text: num(p.units) }), el('td', { class: 't-strong', text: money(p.revenue) })]))));
            return t;
          })()])
        : emptyState('📦', 'No API sales yet'),
    ]);

    // ---- Orders ----
    const tabs = [['api', 'API orders'], ['all', 'All activity'], ['topup', 'Top-ups']];
    const seg = el('div', { class: 'seg' }, tabs.map(([v, label]) => el('button', {
      class: resellerState.source === v ? 'active' : '', text: label,
      disabled: v !== 'api' && !a ? true : null,
      onclick: () => resellerDetail(id, { source: v, page: 1 }),
    })));
    const ordersBody = d.orders.length
      ? el('div', { class: 'table-wrap' }, [(() => {
          const t = el('table');
          t.appendChild(el('thead', {}, [el('tr', {}, ['Order', 'Source', 'Reference', 'Items', 'Amount', 'Status', 'When'].map((h) => el('th', { text: h })))]));
          const tb = el('tbody');
          for (const o of d.orders) {
            tb.appendChild(el('tr', { style: 'cursor:pointer', onclick: () => orderDetail(o.id) }, [
              el('td', { class: 'mono t-strong', text: o.publicId }),
              el('td', {}, [el('span', { class: `badge ${o.source === 'API' ? 'PAID' : o.source === 'Top-up' ? 'DELIVERED' : 'PENDING'}`, text: o.source })]),
              el('td', { class: 'mono t-muted', text: o.reference || '—' }),
              el('td', { class: 't-muted', text: truncate(o.summary, 40) }),
              el('td', { class: 't-strong', text: money(o.amount, o.currency) }),
              el('td', {}, [badge(o.status)]),
              el('td', { class: 't-muted', text: dateTime(o.createdAt) }),
            ]));
          }
          t.appendChild(tb);
          return t;
        })()])
      : emptyState('🧾', 'No orders here yet');
    const ordersCard = el('div', { class: 'card', style: 'margin-top:18px' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: '🧾 Orders' }), seg]),
      ordersBody,
      pager(d, (p) => resellerDetail(id, { page: p })),
    ]);

    mount(el('div', {}, [head, tiles, el('div', { class: 'grid cols-2', style: 'margin-top:18px' }, [accountCard, topCard]), ordersCard]));
  }

  function linkKeyModal(k, after) {
    const save = async (telegramId) => {
      try { await API.put(`/api-keys/${k.id}`, { telegramId }); closeModal(); toast(telegramId ? 'Account linked — ordering enabled' : 'Account unlinked — key is read-only'); (after || apiKeys)(); }
      catch (e) { toast(e.message, 'bad'); }
    };
    if (k.user) {
      return confirmDialog({ title: 'Unlink reseller account?', message: `“${k.name}” will no longer be able to place orders. Products and stock stay readable.`, confirmText: 'Unlink', danger: true })
        .then((ok) => ok && save(''));
    }
    const input = el('input', { placeholder: 'Telegram numeric ID, e.g. 123456789', inputmode: 'numeric' });
    modal({
      title: 'Link reseller account',
      subtitle: `Orders from “${k.name}” will be paid from this account’s wallet balance.`,
      body: el('div', {}, [input, el('div', { class: 'hint', style: 'margin-top:8px', text: 'The reseller must have started the bot at least once.' })]),
      footer: [el('button', { class: 'btn btn-primary', text: 'Link', onclick: () => { const v = input.value.trim(); if (!v) return toast('Enter a Telegram ID', 'bad'); save(v); } })],
    });
  }

  function showNewKey(rawKey, name) {
    modal({
      title: 'API key created',
      subtitle: `For ${name}. Copy it now — it will not be shown again.`,
      body: el('div', {}, [
        el('div', { class: 'row-flex' }, [el('input', { value: rawKey, readonly: true, class: 'mono' }), el('button', { class: 'btn btn-sm', text: 'Copy', onclick: () => copy(rawKey) })]),
      ]),
      footer: [el('button', { class: 'btn btn-primary', text: 'Done', onclick: () => { closeModal(); apiKeys(); } })],
    });
  }

  function healthPill(ok) { return el('span', { class: `badge ${ok ? 'DELIVERED' : 'FAILED'}`, text: ok ? 'connected' : 'not configured' }); }

  // ============================ shared bits ============================
  function field(label, innerHTML, full) {
    const wrap = el('label', { class: 'field' + (full ? ' full' : '') });
    wrap.appendChild(el('span', { text: label }));
    wrap.insertAdjacentHTML('beforeend', innerHTML);
    return wrap;
  }
  function emptyState(emoji, text) { return el('div', { class: 'empty' }, [el('span', { class: 'em', text: emoji }), el('div', { text })]); }
  function errorBox(e) { return el('div', { class: 'card' }, [emptyState('😕', e.message || 'Something went wrong')]); }
  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function pager(data, go) {
    if (data.pages <= 1) return el('div');
    return el('div', { class: 'pager' }, [
      el('button', { class: 'btn btn-sm', text: '‹ Prev', disabled: data.page <= 1, onclick: () => go(data.page - 1) }),
      el('span', { text: `Page ${data.page} of ${data.pages} · ${num(data.total)} total` }),
      el('button', { class: 'btn btn-sm', text: 'Next ›', disabled: data.page >= data.pages, onclick: () => go(data.page + 1) }),
    ]);
  }

  return { dashboard, products, orders, users, broadcast, settings, apiKeys, suppliers };
})();
