'use strict';
// In-browser replacement for api.php + MySQL, so the site runs on static hosting (GitHub Pages).
// Same routes, validation and rules as the PHP modules; data is saved in this browser's localStorage.
window.KristwinDB = (() => {
  const DB_KEY = 'kristwin_db_v1';
  const SESSION_KEY = 'kristwin_session';
  const TIMEZONE = 'Asia/Manila';
  const LOW_DEMAND_UNITS = 500;
  const REORDER_SOON_MARGIN = 0.10;
  const SEED_PASSWORDS = { admin: 'admin123', staff: 'staff123' };

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const CATEGORIES = ['School Supplies', 'Office Supplies', 'Custom Souvenirs', 'Craft Products'];
  const CHANNELS = ['In-store', 'Messenger'];
  const ROLES = ['admin', 'staff'];
  const PO_FLOW = {
    Pending: ['In Progress', 'Delivered', 'Cancelled'],
    'In Progress': ['Delivered', 'Cancelled'],
    Delivered: [],
    Cancelled: [],
  };

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  // ---------------------------------------------------------------- storage

  const mem = {};
  const storage = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { mem[k] = v; } },
    del: (k) => { try { localStorage.removeItem(k); } catch { delete mem[k]; } },
  };

  let db = null;

  async function hashPassword(password) {
    const data = new TextEncoder().encode('kristwin:' + password);
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', data);
      return 'sha256:' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return 'plain:' + password; // non-secure context (plain http) has no crypto.subtle
  }

  async function verifyPassword(password, hash) {
    if (hash.startsWith('plain:')) return hash === 'plain:' + password;
    return hash === (await hashPassword(password));
  }

  async function seed() {
    const S = window.KRISTWIN_SEED;
    const fresh = {
      users: [],
      products: S.products.map(([id, code, name, category, unit, price, stock, reorder_level, created_at]) =>
        ({ id, code, name, category, unit, price, stock, reorder_level, created_at })),
      suppliers: S.suppliers.map(([id, name, contact_person, phone, email, address, created_at]) =>
        ({ id, name, contact_person, phone, email, address, created_at })),
      purchase_orders: S.purchase_orders.map(([id, po_no, supplier_id, order_date, status, notes, stock_applied, delivered_at, created_at]) =>
        ({ id, po_no, supplier_id, order_date, status, notes, stock_applied, delivered_at, created_at })),
      purchase_order_items: S.purchase_order_items.map(([po_id, product_id, qty, unit_cost], i) =>
        ({ id: i + 1, po_id, product_id, qty, unit_cost })),
      sales: S.sales.map(([id, txn_no, sale_date, product_id, qty, unit_price, discount, amount, customer, channel, created_by, created_at]) =>
        ({ id, txn_no, sale_date, product_id, qty, unit_price, discount, amount, customer, channel, created_by, created_at })),
    };
    for (const [id, username, full_name, role, , created_at] of S.users) {
      fresh.users.push({ id, username, full_name, role, password_hash: await hashPassword(SEED_PASSWORDS[username]), created_at });
    }
    return fresh;
  }

  async function load() {
    if (db) return db;
    try { db = JSON.parse(storage.get(DB_KEY)); } catch { db = null; }
    if (!db || !Array.isArray(db.sales)) { db = await seed(); save(); }
    return db;
  }

  function save() { storage.set(DB_KEY, JSON.stringify(db)); }

  const nextId = (table) => db[table].reduce((m, r) => Math.max(m, r.id), 0) + 1;

  // ---------------------------------------------------------------- helpers

  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const lower = (s) => String(s).toLowerCase();

  function nowParts() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return p;
  }
  const today = () => { const p = nowParts(); return `${p.year}-${p.month}-${p.day}`; };
  const now = () => { const p = nowParts(); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; };

  // ---------------------------------------------------------------- validation

  function text(value, label, required = true, max = 120) {
    const s = String(value ?? '').trim();
    if (required && s === '') throw new HttpError(400, `${label} is required.`);
    if ([...s].length > max) throw new HttpError(400, `${label} must be at most ${max} characters.`);
    return s;
  }

  function number(value, label, min = 0, integer = false) {
    const ok = typeof value === 'number' ? Number.isFinite(value)
      : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
    if (!ok) throw new HttpError(400, `${label} must be a number.`);
    const n = Number(value);
    if (integer && Math.floor(n) !== n) throw new HttpError(400, `${label} must be a whole number.`);
    if (n < min) throw new HttpError(400, `${label} must be at least ${min}.`);
    return integer ? n : round2(n);
  }

  function dateStr(value, label) {
    const s = String(value ?? '');
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!d || d.toISOString().slice(0, 10) !== s) throw new HttpError(400, `${label} must be a valid date.`);
    return s;
  }

  function oneOf(value, list, label) {
    if (!list.includes(value)) throw new HttpError(400, `${label} must be one of: ${list.join(', ')}.`);
    return value;
  }

  function findOr404(table, id, label) {
    const r = db[table].find((x) => x.id === (parseInt(id, 10) || 0));
    if (!r) throw new HttpError(404, `${label} not found.`);
    return r;
  }

  // ---------------------------------------------------------------- auth

  function currentUser() {
    const id = Number(storage.get(SESSION_KEY)) || 0;
    const user = id && db.users.find((u) => u.id === id);
    if (!user) throw new HttpError(401, 'Please log in.');
    return user;
  }

  function requireAdmin(user) {
    if (user.role !== 'admin') throw new HttpError(403, 'Only an administrator can do this.');
  }

  // ---------------------------------------------------------------- views

  function stockStatus(stock, reorder) {
    if (stock <= 0) return 'Out of Stock';
    if (stock < reorder) return 'Low Stock';
    if (stock <= Math.ceil(reorder * (1 + REORDER_SOON_MARGIN))) return 'Reorder Soon';
    return 'In Stock';
  }

  const productView = (p) => ({
    id: p.id, code: p.code, name: p.name, category: p.category, unit: p.unit,
    price: p.price, stock: p.stock, reorderLevel: p.reorder_level,
    status: stockStatus(p.stock, p.reorder_level),
  });

  function saleView(s) {
    const p = db.products.find((x) => x.id === s.product_id);
    return {
      id: s.id, txnNo: s.txn_no, date: s.sale_date, productId: s.product_id,
      productName: p ? p.name : '(deleted product)', unit: p ? p.unit : '',
      qty: s.qty, unitPrice: s.unit_price, discount: s.discount, amount: s.amount,
      customer: s.customer, channel: s.channel, createdBy: s.created_by,
    };
  }

  const supplierView = (s) => ({
    id: s.id, name: s.name, contactPerson: s.contact_person, phone: s.phone, email: s.email, address: s.address,
    poCount: db.purchase_orders.filter((po) => po.supplier_id === s.id).length,
  });

  const userView = (u) => ({ id: u.id, username: u.username, name: u.full_name, role: u.role, createdAt: u.created_at });

  function poView(po) {
    const supplier = db.suppliers.find((s) => s.id === po.supplier_id);
    const items = db.purchase_order_items.filter((i) => i.po_id === po.id).sort((a, b) => a.id - b.id).map((it) => {
      const p = db.products.find((x) => x.id === it.product_id);
      return {
        productId: it.product_id, productName: p ? p.name : '(deleted product)', unit: p ? p.unit : '',
        qty: it.qty, unitCost: it.unit_cost, lineTotal: round2(it.qty * it.unit_cost),
      };
    });
    return {
      id: po.id, poNo: po.po_no, supplierId: po.supplier_id,
      supplierName: supplier ? supplier.name : '(deleted supplier)',
      date: po.order_date, status: po.status, notes: po.notes, deliveredAt: po.delivered_at,
      items, itemCount: items.length,
      totalQty: items.reduce((t, i) => t + i.qty, 0),
      totalCost: round2(items.reduce((t, i) => t + i.lineTotal, 0)),
    };
  }

  const byDateDescIdDesc = (dateKey) => (a, b) => (b[dateKey] < a[dateKey] ? -1 : b[dateKey] > a[dateKey] ? 1 : b.id - a.id);
  const posSorted = () => [...db.purchase_orders].sort(byDateDescIdDesc('order_date'));

  // ---------------------------------------------------------------- routes

  const ROUTES = [];
  function route(method, pattern, handler, auth = true) {
    const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    ROUTES.push({ method, regex, handler, auth });
  }

  // --- auth
  route('POST', '/login', async ({ body }) => {
    const username = lower(String(body.username ?? '').trim());
    const user = db.users.find((u) => lower(u.username) === username);
    if (!user || !(await verifyPassword(String(body.password ?? ''), user.password_hash))) {
      throw new HttpError(401, 'Incorrect username or password.');
    }
    storage.set(SESSION_KEY, String(user.id));
    return { user: userView(user) };
  }, false);

  route('POST', '/logout', () => { storage.del(SESSION_KEY); return { ok: true }; }, false);

  route('GET', '/me', ({ user }) => ({ user: userView(user) }));

  // --- dashboard
  route('GET', '/dashboard', ({ query }) => {
    const curYear = Number(today().slice(0, 4));
    let years = [...new Set(db.sales.map((s) => Number(s.sale_date.slice(0, 4))))].sort((a, b) => b - a);
    if (!years.length) years = [curYear];
    const qYear = parseInt(query.get('year'), 10) || 0;
    const year = years.includes(qYear) ? qYear : years[0];
    const monthsCount = year === curYear ? Number(today().slice(5, 7)) : 12;
    const inYear = db.sales.filter((s) => s.sale_date.startsWith(year + '-'));

    const months = Array(12).fill(0);
    for (const s of inYear) months[Number(s.sale_date.slice(5, 7)) - 1] += s.amount;
    for (let i = 0; i < 12; i++) months[i] = round2(months[i]);
    const total = round2(months.reduce((a, b) => a + b, 0));

    let highest = { month: 0, total: months[0] };
    let lowest = { month: 0, total: months[0] };
    for (let i = 1; i < monthsCount; i++) {
      if (months[i] > highest.total) highest = { month: i, total: months[i] };
      if (months[i] < lowest.total) lowest = { month: i, total: months[i] };
    }

    const peaks = months.map((t, i) => ({ t, i })).filter((x) => x.t > 0)
      .sort((a, b) => b.t - a.t).slice(0, 2).map((x) => x.i).sort((a, b) => a - b);

    const perProduct = db.products.map((p) => {
      const ps = inYear.filter((s) => s.product_id === p.id);
      return { name: p.name, amount: round2(ps.reduce((t, s) => t + s.amount, 0)), units: ps.reduce((t, s) => t + s.qty, 0) };
    });

    const selling = perProduct.filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount);
    const byProduct = selling.slice(0, 5).map((r) => ({ name: r.name, amount: r.amount }));
    const rest = selling.slice(5).reduce((t, r) => t + r.amount, 0);
    if (rest > 0) byProduct.push({ name: 'Other Products', amount: round2(rest), other: true });
    for (const b of byProduct) b.pct = total ? b.amount / total * 100 : 0;

    const lowDemand = LOW_DEMAND_UNITS * monthsCount / 12;
    const lowPerforming = [...perProduct]
      .sort((a, b) => (a.amount - b.amount) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, 4)
      .map((r) => ({ ...r, status: r.units === 0 ? 'No Sales' : r.units < lowDemand ? 'Low Demand' : 'Slow Moving' }));

    const recent = posSorted().slice(0, 5).reverse();

    return {
      year,
      years,
      periodLabel: monthsCount === 1 ? `Jan ${year}` : `Jan–${MONTHS[monthsCount - 1]} ${year}`,
      months,
      peaks,
      kpis: { total, average: round2(total / monthsCount), avgMonths: monthsCount, highest, lowest },
      byProduct,
      inventory: [...db.products].sort((a, b) => a.id - b.id).map(productView),
      procurement: recent.map(poView),
      lowPerforming,
    };
  });

  // --- products
  function productInput(b, existingId = 0) {
    const p = {
      code: text(b.code, 'Product code', true, 20),
      name: text(b.name, 'Product name', true, 80),
      category: oneOf(b.category ?? '', CATEGORIES, 'Category'),
      unit: text(b.unit, 'Unit', true, 20),
      price: number(b.price ?? '', 'Selling price'),
      stock: number(b.stock ?? '', 'Current stock', 0, true),
      reorder_level: number(b.reorderLevel ?? '', 'Reorder level', 0, true),
    };
    const clash = db.products.find((x) => x.id !== existingId && (lower(x.code) === lower(p.code) || lower(x.name) === lower(p.name)));
    if (clash) {
      const field = lower(clash.code) === lower(p.code) ? 'code' : 'name';
      throw new HttpError(409, `A product with that ${field} already exists.`);
    }
    return p;
  }

  route('GET', '/products', () => [...db.products].sort((a, b) => a.id - b.id).map(productView));

  route('POST', '/products', ({ body }) => {
    const p = { id: nextId('products'), ...productInput(body), created_at: now() };
    db.products.push(p);
    return productView(p);
  });

  route('PUT', '/products/:id', ({ body, params }) => {
    const existing = findOr404('products', params.id, 'Product');
    Object.assign(existing, productInput(body, existing.id));
    return productView(existing);
  });

  route('DELETE', '/products/:id', ({ user, params }) => {
    requireAdmin(user);
    const p = findOr404('products', params.id, 'Product');
    const used = db.sales.some((s) => s.product_id === p.id) || db.purchase_order_items.some((i) => i.product_id === p.id);
    if (used) throw new HttpError(409, `${p.name} has sales or purchase records and cannot be deleted.`);
    db.products = db.products.filter((x) => x.id !== p.id);
    return { ok: true };
  });

  // --- sales
  route('GET', '/sales', () => [...db.sales].sort(byDateDescIdDesc('sale_date')).map(saleView));

  route('POST', '/sales', ({ body: b, user }) => {
    const product = db.products.find((p) => p.id === (parseInt(b.productId, 10) || 0));
    if (!product) throw new HttpError(404, 'Product not found.');
    const qty = number(b.qty ?? '', 'Quantity', 1, true);
    const unitPrice = number((b.unitPrice ?? '') === '' ? product.price : b.unitPrice, 'Unit price');
    const discount = number((b.discount ?? '') === '' ? 0 : b.discount, 'Discount');
    const amount = round2(qty * unitPrice - discount);
    if (amount < 0) throw new HttpError(400, 'Discount cannot be larger than the sale amount.');
    if (qty > product.stock) {
      throw new HttpError(400, `Not enough stock. Only ${product.stock} ${product.unit} of ${product.name} left.`);
    }
    const id = nextId('sales');
    const sale = {
      id,
      txn_no: 'TXN-' + String(id).padStart(5, '0'),
      sale_date: dateStr(b.date || today(), 'Date'),
      product_id: product.id,
      qty,
      unit_price: unitPrice,
      discount,
      amount,
      customer: text(b.customer, 'Customer', false, 80) || 'Walk-in',
      channel: oneOf(b.channel || 'In-store', CHANNELS, 'Channel'),
      created_by: user.full_name,
      created_at: now(),
    };
    db.sales.push(sale);
    product.stock -= qty;
    return saleView(sale);
  });

  route('DELETE', '/sales/:id', ({ user, params }) => {
    requireAdmin(user);
    const sale = findOr404('sales', params.id, 'Sale');
    const product = db.products.find((p) => p.id === sale.product_id);
    if (product) product.stock += sale.qty;
    db.sales = db.sales.filter((s) => s.id !== sale.id);
    return { ok: true };
  });

  // --- suppliers
  function supplierInput(b, existingId = 0) {
    const s = {
      name: text(b.name, 'Supplier name', true, 80),
      contact_person: text(b.contactPerson, 'Contact person', false, 80),
      phone: text(b.phone, 'Phone', false, 40),
      email: text(b.email, 'Email / Messenger', false, 120),
      address: text(b.address, 'Address', false, 160),
    };
    if (db.suppliers.some((x) => x.id !== existingId && lower(x.name) === lower(s.name))) {
      throw new HttpError(409, 'A supplier with that name already exists.');
    }
    return s;
  }

  route('GET', '/suppliers', () => [...db.suppliers].sort((a, b) => a.id - b.id).map(supplierView));

  route('POST', '/suppliers', ({ body }) => {
    const s = { id: nextId('suppliers'), ...supplierInput(body), created_at: now() };
    db.suppliers.push(s);
    return supplierView(s);
  });

  route('PUT', '/suppliers/:id', ({ body, params }) => {
    const existing = findOr404('suppliers', params.id, 'Supplier');
    Object.assign(existing, supplierInput(body, existing.id));
    return supplierView(existing);
  });

  route('DELETE', '/suppliers/:id', ({ user, params }) => {
    requireAdmin(user);
    const s = findOr404('suppliers', params.id, 'Supplier');
    if (db.purchase_orders.some((po) => po.supplier_id === s.id)) {
      throw new HttpError(409, `${s.name} has purchase orders and cannot be deleted.`);
    }
    db.suppliers = db.suppliers.filter((x) => x.id !== s.id);
    return { ok: true };
  });

  // --- purchase orders
  function purchaseInput(b) {
    const supplier = findOr404('suppliers', b.supplierId ?? 0, 'Supplier');
    const lines = b.items;
    if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'Add at least one item.');
    const seen = new Set();
    const items = lines.map((it, i) => {
      const n = i + 1;
      const product = findOr404('products', it.productId ?? 0, `Product on line ${n}`);
      if (seen.has(product.id)) throw new HttpError(400, `${product.name} is listed more than once.`);
      seen.add(product.id);
      return {
        product_id: product.id,
        qty: number(it.qty ?? '', `Quantity on line ${n}`, 1, true),
        unit_cost: number(it.unitCost ?? '', `Unit cost on line ${n}`),
      };
    });
    return {
      supplier_id: supplier.id,
      order_date: dateStr(b.date || today(), 'Date'),
      notes: text(b.notes, 'Notes', false, 300),
      items,
    };
  }

  function savePoItems(poId, items) {
    db.purchase_order_items = db.purchase_order_items.filter((i) => i.po_id !== poId);
    for (const it of items) db.purchase_order_items.push({ id: nextId('purchase_order_items'), po_id: poId, ...it });
  }

  route('GET', '/purchases', () => posSorted().map(poView));

  route('POST', '/purchases', ({ body }) => {
    const { items, ...input } = purchaseInput(body);
    const year = input.order_date.slice(0, 4);
    const last = db.purchase_orders
      .filter((po) => po.po_no.startsWith(`PO-${year}-`))
      .reduce((m, po) => Math.max(m, parseInt(po.po_no.split('-').pop(), 10) || 0), 0);
    const po = {
      id: nextId('purchase_orders'),
      po_no: `PO-${year}-${String(last + 1).padStart(3, '0')}`,
      ...input,
      status: 'Pending',
      stock_applied: 0,
      delivered_at: null,
      created_at: now(),
    };
    db.purchase_orders.push(po);
    savePoItems(po.id, items);
    return poView(po);
  });

  route('PUT', '/purchases/:id', ({ body, params }) => {
    const po = findOr404('purchase_orders', params.id, 'Purchase order');
    if (!PO_FLOW[po.status].length) throw new HttpError(409, `${po.status} purchase orders can no longer be edited.`);
    const { items, ...input } = purchaseInput(body);
    Object.assign(po, input);
    savePoItems(po.id, items);
    return poView(po);
  });

  route('PATCH', '/purchases/:id/status', ({ body, params }) => {
    const status = String(body.status ?? '');
    const po = db.purchase_orders.find((x) => x.id === (parseInt(params.id, 10) || 0));
    if (!po) throw new HttpError(404, 'Purchase order not found.');
    if (!PO_FLOW[po.status].includes(status)) {
      throw new HttpError(409, `Cannot change status from ${po.status} to ${status || '(blank)'}.`);
    }
    po.status = status;
    if (status === 'Delivered' && !po.stock_applied) {
      for (const it of db.purchase_order_items.filter((i) => i.po_id === po.id)) {
        const p = db.products.find((x) => x.id === it.product_id);
        if (p) p.stock += it.qty;
      }
      po.stock_applied = 1;
      po.delivered_at = today();
    }
    return poView(po);
  });

  route('DELETE', '/purchases/:id', ({ user, params }) => {
    requireAdmin(user);
    const po = findOr404('purchase_orders', params.id, 'Purchase order');
    if (po.status === 'Delivered') throw new HttpError(409, 'Delivered purchase orders cannot be deleted.');
    db.purchase_orders = db.purchase_orders.filter((x) => x.id !== po.id);
    db.purchase_order_items = db.purchase_order_items.filter((i) => i.po_id !== po.id);
    return { ok: true };
  });

  // --- users
  route('GET', '/users', ({ user }) => {
    requireAdmin(user);
    return [...db.users].sort((a, b) => a.id - b.id).map(userView);
  });

  route('POST', '/users', async ({ user, body: b }) => {
    requireAdmin(user);
    const username = lower(text(b.username, 'Username', true, 30));
    if (!/^[a-z0-9._-]+$/.test(username)) throw new HttpError(400, 'Username may only use letters, numbers, dots, dashes and underscores.');
    if (db.users.some((u) => lower(u.username) === username)) throw new HttpError(409, 'That username is already taken.');
    const password = String(b.password ?? '');
    if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
    const u = {
      id: nextId('users'),
      username,
      full_name: text(b.name, 'Full name', true, 80),
      role: oneOf(b.role ?? '', ROLES, 'Role'),
      password_hash: await hashPassword(password),
      created_at: now(),
    };
    db.users.push(u);
    return userView(u);
  });

  route('PUT', '/users/:id', async ({ user, body: b, params }) => {
    requireAdmin(user);
    const target = findOr404('users', params.id, 'User');
    const role = oneOf(b.role ?? '', ROLES, 'Role');
    if (target.id === user.id && role !== 'admin') throw new HttpError(400, 'You cannot remove your own administrator role.');
    const fullName = text(b.name, 'Full name', true, 80);
    let hash = null;
    if (b.password) {
      if (String(b.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
      hash = await hashPassword(String(b.password));
    }
    target.full_name = fullName;
    target.role = role;
    if (hash) target.password_hash = hash;
    return userView(target);
  });

  route('DELETE', '/users/:id', ({ user, params }) => {
    requireAdmin(user);
    const target = findOr404('users', params.id, 'User');
    if (target.id === user.id) throw new HttpError(400, 'You cannot delete your own account.');
    db.users = db.users.filter((u) => u.id !== target.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- dispatcher

  /** Runs one API call. Resolves with the JSON result, or rejects with an Error carrying .status. */
  async function request(method, path, body) {
    await load();
    const [pathname, search = ''] = path.split('?');
    const clean = '/' + pathname.replace(/^\/+|\/+$/g, '');
    let match = null;
    let params = {};
    for (const r of ROUTES) {
      const m = r.method === method && r.regex.exec(clean);
      if (m) { match = r; params = m.groups || {}; break; }
    }
    if (!match) throw new HttpError(404, 'Not found.');

    // Work on a copy so a failed request changes nothing (like a rolled-back transaction).
    const backup = JSON.stringify(db);
    try {
      const user = match.auth ? currentUser() : null;
      const input = body == null ? {} : JSON.parse(JSON.stringify(body));
      const result = await match.handler({ body: input, params, query: new URLSearchParams(search), user });
      if (method !== 'GET') save();
      return JSON.parse(JSON.stringify(result ?? { ok: true }));
    } catch (e) {
      db = JSON.parse(backup);
      if (e instanceof HttpError) throw e;
      console.error(e);
      throw new HttpError(500, 'Something went wrong.');
    }
  }

  /** Restores the sample data (the old install.php "Reset database"). */
  async function reset() {
    db = await seed();
    save();
    storage.del(SESSION_KEY);
  }

  return { request, reset };
})();
