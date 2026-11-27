/**
 * 煎時 JIANSHI 線上訂單系統（Google Apps Script）
 * ------------------------------------------------------------
 * 綁定在 Google 試算表上的 Apps Script，部署為「網頁應用程式」後：
 *   - 網站結帳時 POST 訂單 → 寫入「訂單」「訂單明細」工作表
 *   - 依「菜單價格」工作表在伺服器端重算金額（防竄改）
 *   - 寄送顧客確認信、店家新訂單通知
 *   - 「訂單」狀態欄改動時自動記錄更新時間
 *   - 每晚寄出當日營業報表
 *
 * 第一次使用：在編輯器選擇函式 setup 並執行（會要求授權），
 * 再執行 installTriggers 安裝每日報表與狀態追蹤觸發器。
 * 詳細步驟見 gas/README.md
 */

/* ========== 可自行修改的設定 ========== */
const CONFIG = {
  STORE_NAME: '煎時 JIANSHI',
  NOTIFY_EMAIL: '',          // 店家接收新訂單通知的 Email（留空 = 寄給部署者本人）
  SEND_CUSTOMER_EMAIL: true, // 顧客有填 Email 時寄送訂單確認信
  SHIPPING_FEE: 160,         // 宅配運費
  FREE_SHIP: 1500,           // 宅配滿額免運
  DAILY_REPORT_HOUR: 21,     // 每日報表寄送時間（24 小時制，台北時間）
  MAX_QTY_PER_ITEM: 99,
  MAX_ORDERS_PER_PHONE_10MIN: 5,
  STORES: {
    flagship: '旗艦店',
    xinyi: '信義店',
    banqiao: '板橋店'
  }
};

const SHEETS = { ORDERS: '訂單', ITEMS: '訂單明細', PRICES: '菜單價格' };
const ORDER_HEADERS = ['訂單編號', '建立時間', '狀態', '取餐方式', '門市', '姓名', '手機', 'Email', '宅配地址',
  '備註', '品項摘要', '件數', '小計', '運費', '應付金額', '狀態更新時間'];
const ITEM_HEADERS = ['訂單編號', '建立時間', '品項ID', '品名', '單價', '數量', '小計'];
const PRICE_HEADERS = ['品項ID', '品名', '價格', '單位', '供應中'];
const STATUSES = ['新訂單', '製作中', '可取餐/已出貨', '已完成', '已取消'];
const MODE_LABEL = { dine: '內用', takeout: '外帶自取', delivery: '冷凍宅配' };
const COL = Object.fromEntries(ORDER_HEADERS.map((h, i) => [h, i + 1]));

// 初始菜單（與網站一致）；之後請直接在「菜單價格」工作表調整
const DEFAULT_MENU = [
  ['p1', '招牌鮮肉鍋貼', 80, '10 顆'], ['p2', '韭黃蝦仁鍋貼', 120, '10 顆'], ['p3', '麻辣起司鍋貼', 110, '10 顆'],
  ['p4', '咖哩牛肉鍋貼', 130, '10 顆'], ['d1', '高麗菜豬肉水餃', 70, '10 顆'], ['d2', '玉米鮮肉水餃', 75, '10 顆'],
  ['d3', '香菇雞肉水餃', 85, '10 顆'], ['d4', '紅油抄手', 90, '8 顆'], ['s1', '酸辣湯', 45, '碗'],
  ['s2', '玉米濃湯', 45, '碗'], ['s3', '古早味紅茶', 30, '杯'], ['s4', '手工無糖豆漿', 35, '杯'],
  ['c1', '涼拌小黃瓜', 40, '份'], ['c2', '皮蛋豆腐', 50, '份'], ['c3', '滷味拼盤', 80, '份'],
  ['c4', '麻辣鴨血', 60, '份'], ['g1', '招牌招財鍋貼禮盒', 680, '50 入'], ['g2', '闔家團圓綜合禮盒', 980, '80 入'],
  ['g3', '節慶限定福袋禮盒', 1380, '100 入']
];

/* ========== 網頁應用程式入口 ========== */

/** 網站送出訂單（POST，body 為 JSON 字串） */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'createOrder' || !body.action) return json_(createOrder_(body));
    return json_({ ok: false, error: '不支援的操作' });
  } catch (err) {
    if (!err.userMessage) console.error(err);          // 顧客輸入錯誤不記為系統錯誤
    return json_({ ok: false, error: err.userMessage || '系統忙碌中，請稍後再試或直接致電門市' });
  }
}

/** 健康檢查 / 訂單查詢：?action=status&orderNo=...&phone=... */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'status') {
    const found = findOrder_(String(p.orderNo || ''), normalizePhone_(p.phone));
    return json_(found ? { ok: true, orderNo: found.orderNo, status: found.status, total: found.total, updatedAt: found.updatedAt }
                       : { ok: false, error: '查無此訂單，請確認訂單編號與手機號碼' });
  }
  return json_({ ok: true, service: CONFIG.STORE_NAME + ' 訂單 API', time: new Date().toISOString() });
}

/* ========== 建立訂單 ========== */
function createOrder_(body) {
  // 1. 防機器人：隱藏欄位有值就當作成功但不寫入
  if (body.website) return { ok: true, orderNo: 'JS000000-000', total: 0 };

  // 2. 驗證顧客資料
  const c = body.customer || {};
  const name = clean_(c.name, 40);
  const phone = normalizePhone_(c.phone);
  const email = clean_(c.email, 100);
  const address = clean_(c.address, 200);
  const note = clean_(c.note, 300);
  const mode = MODE_LABEL[body.mode] ? body.mode : null;
  const store = CONFIG.STORES[body.store] || '';
  if (!name) throw userError_('請填寫姓名');
  if (!/^09\d{8}$/.test(phone)) throw userError_('手機號碼格式不正確');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw userError_('Email 格式不正確');
  if (!mode) throw userError_('請選擇取餐方式');
  if (mode === 'delivery' && !address) throw userError_('請填寫宅配地址');
  if (mode !== 'delivery' && !store) throw userError_('請選擇門市');

  // 3. 依「菜單價格」重算金額
  const prices = getPrices_();
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 50).map((it) => {
    const p = prices[String(it.id)];
    const qty = Math.floor(Number(it.qty));
    if (!p) throw userError_('部分品項已下架，請重新整理頁面後再試');
    if (!(qty >= 1 && qty <= CONFIG.MAX_QTY_PER_ITEM)) throw userError_('品項數量不正確');
    return { id: String(it.id), name: p.name, price: p.price, qty, amount: p.price * qty };
  });
  if (!items.length) throw userError_('購物車是空的');
  const subtotal = items.reduce((s, it) => s + it.amount, 0);
  const shipping = mode === 'delivery' && subtotal < CONFIG.FREE_SHIP ? CONFIG.SHIPPING_FEE : 0;
  const total = subtotal + shipping;
  const qtyTotal = items.reduce((s, it) => s + it.qty, 0);

  // 4. 頻率限制（同一手機 10 分鐘內最多 N 張）
  const cache = CacheService.getScriptCache();
  const rateKey = 'rate_' + phone;
  const count = Number(cache.get(rateKey) || 0);
  if (count >= CONFIG.MAX_ORDERS_PER_PHONE_10MIN) throw userError_('下單次數過於頻繁，請稍後再試或致電門市');

  // 5. 防重複送出：同一個 clientId 只建立一次
  const clientId = clean_(body.clientId, 64);
  if (clientId) {
    const prev = cache.get('cid_' + clientId);
    if (prev) return JSON.parse(prev);
  }

  // 6. 寫入試算表（鎖定避免同時下單時編號重複）
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let result;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const now = new Date();
    const orderNo = nextOrderNo_(now);
    const summary = items.map((it) => `${it.name}×${it.qty}`).join('、');
    ss.getSheetByName(SHEETS.ORDERS).appendRow([
      orderNo, now, STATUSES[0], MODE_LABEL[mode], mode === 'delivery' ? '' : store, safe_(name), "'" + phone,
      safe_(email), safe_(address), safe_(note), summary, qtyTotal, subtotal, shipping, total, now
    ]);
    const itemSheet = ss.getSheetByName(SHEETS.ITEMS);
    const rows = items.map((it) => [orderNo, now, it.id, it.name, it.price, it.qty, it.amount]);
    itemSheet.getRange(itemSheet.getLastRow() + 1, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
    SpreadsheetApp.flush();
    result = { ok: true, orderNo, subtotal, shipping, total, mode, store, createdAt: now.toISOString() };
  } finally {
    lock.releaseLock();
  }

  cache.put(rateKey, String(count + 1), 600);
  if (clientId) cache.put('cid_' + clientId, JSON.stringify(result), 600);

  // 7. Email 通知（失敗不影響訂單成立）
  const order = { orderNo: result.orderNo, name, phone, email, address, note, mode, store, items, subtotal, shipping, total };
  try { notifyStore_(order); } catch (err) { console.error('notifyStore', err); }
  if (CONFIG.SEND_CUSTOMER_EMAIL && email) {
    try { notifyCustomer_(order); } catch (err) { console.error('notifyCustomer', err); }
  }
  return result;
}

/** 每日流水號：JS + yyMMdd + - + 3 碼 */
function nextOrderNo_(now) {
  const day = Utilities.formatDate(now, 'Asia/Taipei', 'yyMMdd');
  const props = PropertiesService.getScriptProperties();
  const key = 'seq_' + day;
  const seq = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(seq));
  return 'JS' + day + '-' + String(seq).padStart(3, '0');
}

function getPrices_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PRICES);
  const values = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), PRICE_HEADERS.length).getValues();
  const map = {};
  values.forEach(([id, name, price, unit, active]) => {
    if (id && active !== false && Number(price) > 0) map[String(id)] = { name: String(name), price: Number(price), unit };
  });
  return map;
}

function findOrder_(orderNo, phone) {
  if (!/^JS\d{6}-\d{3}$/.test(orderNo) || !phone) return null;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ORDERS);
  const hit = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).createTextFinder(orderNo).matchEntireCell(true).findNext();
  if (!hit) return null;
  const row = sheet.getRange(hit.getRow(), 1, 1, ORDER_HEADERS.length).getValues()[0];
  if (normalizePhone_(row[COL['手機'] - 1]) !== phone) return null;
  return { orderNo, status: row[COL['狀態'] - 1], total: row[COL['應付金額'] - 1], updatedAt: row[COL['狀態更新時間'] - 1] };
}

/* ========== Email ========== */
function itemsTable_(o) {
  const rows = o.items.map((it) =>
    `<tr><td style="padding:6px 0">${esc_(it.name)} × ${it.qty}</td><td style="text-align:right">NT$ ${it.amount}</td></tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
    <tr><td style="padding-top:10px;border-top:1px solid #e9ddd1">小計</td><td style="text-align:right;padding-top:10px;border-top:1px solid #e9ddd1">NT$ ${o.subtotal}</td></tr>
    <tr><td>運費</td><td style="text-align:right">${o.mode === 'delivery' ? (o.shipping ? 'NT$ ' + o.shipping : '免運') : '—'}</td></tr>
    <tr><td style="font-weight:bold;font-size:16px">應付金額</td><td style="text-align:right;font-weight:bold;font-size:16px;color:#c4641c">NT$ ${o.total}</td></tr></table>`;
}
function where_(o) { return o.mode === 'delivery' ? '宅配至：' + esc_(o.address) : esc_(o.store); }

function notifyCustomer_(o) {
  const html = `<div style="font-family:sans-serif;max-width:520px;margin:auto;color:#3b2a1e">
    <h2 style="color:#c4641c">${esc_(CONFIG.STORE_NAME)}｜訂單已收到</h2>
    <p>${esc_(o.name)} 您好，感謝您的訂購！</p>
    <p>訂單編號：<b>${o.orderNo}</b><br>取餐方式：${MODE_LABEL[o.mode]}（${where_(o)}）</p>
    ${itemsTable_(o)}
    ${o.note ? `<p style="color:#7a5a40">備註：${esc_(o.note)}</p>` : ''}
    <p style="color:#7a5a40;font-size:13px">如需修改訂單，請直接致電門市並告知訂單編號。</p></div>`;
  MailApp.sendEmail({ to: o.email, subject: `【${CONFIG.STORE_NAME}】訂單確認 ${o.orderNo}`, htmlBody: html, name: CONFIG.STORE_NAME });
}

function notifyStore_(o) {
  const to = CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
  if (!to) return;
  const url = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  const html = `<div style="font-family:sans-serif;max-width:520px;color:#3b2a1e">
    <h3>🥟 新訂單 ${o.orderNo}｜${MODE_LABEL[o.mode]}｜NT$ ${o.total}</h3>
    <p>${esc_(o.name)}　${o.phone}${o.email ? '　' + esc_(o.email) : ''}<br>${where_(o)}</p>
    ${itemsTable_(o)}
    ${o.note ? `<p><b>備註：</b>${esc_(o.note)}</p>` : ''}
    <p><a href="${url}">開啟訂單試算表</a></p></div>`;
  MailApp.sendEmail({ to, subject: `🥟 新訂單 ${o.orderNo}｜${MODE_LABEL[o.mode]}｜NT$ ${o.total}`, htmlBody: html, name: CONFIG.STORE_NAME });
}

/* ========== 每日營業報表（時間觸發器） ========== */
function dailyReport() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ORDERS);
  const last = sheet.getLastRow();
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  const rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues()
    .filter((r) => r[1] instanceof Date && Utilities.formatDate(r[1], 'Asia/Taipei', 'yyyy-MM-dd') === today && r[2] !== '已取消');
  const revenue = rows.reduce((s, r) => s + Number(r[COL['應付金額'] - 1] || 0), 0);
  const byMode = {};
  rows.forEach((r) => { const m = r[COL['取餐方式'] - 1]; byMode[m] = (byMode[m] || 0) + 1; });

  const itemSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ITEMS);
  const orderSet = new Set(rows.map((r) => r[0]));
  const top = {};
  if (itemSheet.getLastRow() > 1) {
    itemSheet.getRange(2, 1, itemSheet.getLastRow() - 1, ITEM_HEADERS.length).getValues()
      .filter((r) => orderSet.has(r[0])).forEach((r) => { top[r[3]] = (top[r[3]] || 0) + Number(r[5]); });
  }
  const topList = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([n, q], i) => `<li>${i + 1}. ${esc_(n)} — ${q} 份</li>`).join('') || '<li>今日尚無訂單</li>';
  const html = `<div style="font-family:sans-serif;color:#3b2a1e">
    <h2>📊 ${esc_(CONFIG.STORE_NAME)} ${today} 營業報表</h2>
    <p>有效訂單：<b>${rows.length}</b> 張　營收：<b>NT$ ${revenue.toLocaleString()}</b>
    　平均客單：<b>NT$ ${rows.length ? Math.round(revenue / rows.length) : 0}</b></p>
    <p>${Object.entries(byMode).map(([m, n]) => `${m} ${n} 張`).join('　') || ''}</p>
    <h3>熱銷品項</h3><ol style="list-style:none;padding:0">${topList}</ol>
    <p><a href="${SpreadsheetApp.getActiveSpreadsheet().getUrl()}">開啟訂單試算表</a></p></div>`;
  MailApp.sendEmail({ to: CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail(),
    subject: `📊 ${CONFIG.STORE_NAME} ${today} 營業報表｜${rows.length} 張・NT$ ${revenue.toLocaleString()}`, htmlBody: html, name: CONFIG.STORE_NAME });
}

/* ========== 狀態欄改動 → 記錄更新時間（可安裝的 onEdit 觸發器） ========== */
function onOrderEdit(e) {
  const range = e && e.range;
  if (!range || range.getSheet().getName() !== SHEETS.ORDERS || range.getRow() < 2) return;
  if (range.getColumn() <= COL['狀態'] && range.getLastColumn() >= COL['狀態']) {
    range.getSheet().getRange(range.getRow(), COL['狀態更新時間'], range.getNumRows(), 1).setValue(new Date());
  }
}

/* ========== 一次性設定 ========== */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Asia/Taipei');
  const orders = ensureSheet_(ss, SHEETS.ORDERS, ORDER_HEADERS);
  orders.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm');
  orders.getRange('P:P').setNumberFormat('yyyy-mm-dd hh:mm');
  orders.getRange('G:G').setNumberFormat('@');
  orders.getRange('M:O').setNumberFormat('"NT$ "#,##0');
  const statusRule = SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build();
  orders.getRange(2, COL['狀態'], orders.getMaxRows() - 1, 1).setDataValidation(statusRule);
  const statusRange = orders.getRange('C2:C');
  orders.setConditionalFormatRules([
    ['新訂單', '#fbe6d3', '#a14f13'], ['製作中', '#fff4c2', '#7a5a00'], ['可取餐/已出貨', '#dcefd8', '#2f6b2a'],
    ['已完成', '#e9ddd1', '#4a3424'], ['已取消', '#eeeeee', '#999999']
  ].map(([t, bg, fg]) => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(t).setBackground(bg).setFontColor(fg).setRanges([statusRange]).build()));
  [120, 130, 110, 90, 70, 80, 100, 170, 200, 160, 260, 50, 80, 60, 90, 130].forEach((w, i) => orders.setColumnWidth(i + 1, w));

  const items = ensureSheet_(ss, SHEETS.ITEMS, ITEM_HEADERS);
  items.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm');

  const prices = ensureSheet_(ss, SHEETS.PRICES, PRICE_HEADERS);
  if (prices.getLastRow() < 2) {
    prices.getRange(2, 1, DEFAULT_MENU.length, PRICE_HEADERS.length).setValues(DEFAULT_MENU.map((r) => r.concat([true])));
  }
  prices.getRange(2, 5, Math.max(prices.getLastRow() - 1, 1), 1).insertCheckboxes();

  const blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  ss.setActiveSheet(orders);
  safeAlert_('設定完成！接著請執行 installTriggers，然後部署為網頁應用程式。');
}

function installTriggers() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (['dailyReport', 'onOrderEdit'].includes(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyReport').timeBased().atHour(CONFIG.DAILY_REPORT_HOUR).nearMinute(30).everyDays(1).inTimezone('Asia/Taipei').create();
  ScriptApp.newTrigger('onOrderEdit').forSpreadsheet(ss).onEdit().create();
  safeAlert_('已安裝：每日 ' + CONFIG.DAILY_REPORT_HOUR + ':30 營業報表、狀態更新時間記錄。');
}

/** 試算表選單 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🥟 煎時訂單')
    .addItem('初始化工作表', 'setup')
    .addItem('安裝觸發器（每日報表／狀態追蹤）', 'installTriggers')
    .addItem('立即寄出今日營業報表', 'dailyReport')
    .addToUi();
}

/* ========== 小工具 ========== */
function ensureSheet_(ss, name, headers) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#3b2a1e').setFontColor('#faf5ee');
  sheet.setFrozenRows(1);
  return sheet;
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function clean_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function safe_(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; }   // 防公式注入
function normalizePhone_(v) { return String(v == null ? '' : v).replace(/[^\d]/g, '').replace(/^9(\d{8})$/, '09$1'); }
function esc_(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function userError_(msg) { const e = new Error(msg); e.userMessage = msg; return e; }
function safeAlert_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); } }
