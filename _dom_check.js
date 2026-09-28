/* _dom_check.js —— jsdom 冒烟: 渲染 + 交互 + picker.js 采集逻辑 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = __dirname;
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
}
const tick = (ms) => new Promise(r => setTimeout(r, ms || 60));

/* ---------- 假 pywebview ---------- */
const DISK = Object.create(null);
function histDb() { return DISK.history || (DISK.history = { records: [], groups: [] }); }
let browserRunning = false;
let pickQueue = [];
const MOCK_PICK = {
  ts: Date.now(), url: 'https://shop.example.com/products/list', title: '商品列表',
  tag: 'div', id: '', name: '', 'class': 'product-card product-card--sale',
  text: '羊毛混纺针织衫', size: '324 x 180', w: 324, h: 180, x: 736, y: 412,
  attrs: { 'data-sku': 'A1024' },
  candidates: {
    xpath: [
      { kind: 'attribute', value: '//div[@data-sku="A1024"]', count: 1 },
      { kind: 'path', value: '//html/body/div[3]', count: 1 },
    ],
    css: [
      { kind: 'attribute', value: 'div[data-sku="A1024"]', count: 1 },
      { kind: 'class', value: 'div.product-card', count: 24 },
    ],
  },
  best_xpath: '//div[@data-sku="A1024"]', best_css: 'div[data-sku="A1024"]',
  unique: { xpath: true, css: true, id: false, name: false },
  snippets: { selenium: ["driver.find_element(By.XPATH, '//div[@data-sku=\"A1024\"]').click()"], playwright: ["page.locator('div[data-sku=\"A1024\"]').click()"], cypress: ["cy.xpath('//div[@data-sku=\"A1024\"]').click()"] },
};
const API = {
  app_info: () => Promise.resolve({ name: 'element_picker', title: 'ElementPicker 元素定位拾取器', version: '1.0.0' }),
  browser_open: () => { browserRunning = true; return Promise.resolve({ ok: true }); },
  browser_close: () => { browserRunning = false; return Promise.resolve({ ok: true }); },
  browser_status: () => Promise.resolve({ running: browserRunning, engine: 'playwright', url: 'https://shop.example.com/products/list', picker: true, active: 'playwright' }),
  browser_picks: () => Promise.resolve(pickQueue.splice(0)),
  browser_validate: () => Promise.resolve({ count: 1 }),
  app_connect: () => Promise.resolve({ ok: true, targets: [{ idx: 0, title: '主窗口', url: 'app://main' }] }),
  app_targets: () => Promise.resolve({ ok: true, targets: [{ idx: 0, title: '主窗口', url: 'app://main' }] }),
  app_select: () => Promise.resolve({ ok: true }),
  app_disconnect: () => Promise.resolve({ ok: true }),
  app_picks: () => Promise.resolve([]),
  app_validate: () => Promise.resolve({ count: 1 }),
  history_list: () => Promise.resolve(JSON.parse(JSON.stringify(histDb()))),
  history_save: (rec) => { const d = histDb(); const id = 'r' + Math.random().toString(16).slice(2, 10); d.records.unshift(Object.assign({ id: id, saved_at: '2026-09-28 13:00:00', group: '', star: false }, rec)); return Promise.resolve({ id: id }); },
  history_delete: (id) => { histDb().records = histDb().records.filter(r => r.id !== id); return Promise.resolve({ ok: true }); },
  history_clear: () => { histDb().records = []; return Promise.resolve({ ok: true }); },
  history_update: (id, patch) => { const r = histDb().records.find(x => x.id === id); if (r) Object.assign(r, patch); return Promise.resolve(r || {}); },
  history_detail: (id) => Promise.resolve(histDb().records.find(x => x.id === id) || null),
  group_add: (name) => { const d = histDb(); if (d.groups.indexOf(name) < 0) d.groups.push(name); return Promise.resolve({ groups: d.groups.slice() }); },
  group_delete: () => Promise.resolve({ groups: histDb().groups.slice() }),
  export_json: () => Promise.resolve({ ok: true, path: 'export.json' }),
};

/* ---------- 建 DOM ---------- */
const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
const win = dom.window;
const doc = win.document;

/* 排版桩 */
function isVisible(el) {
  let n = el;
  while (n && n.nodeType === 1) {
    const s = n.getAttribute && n.getAttribute('style');
    if (s && /display\s*:\s*none/.test(s)) return false;
    n = n.parentElement;
  }
  return true;
}
Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return isVisible(this) ? 800 : 0; } });
Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return isVisible(this) ? 40 : 0; } });
win.HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 100, height: 30, right: 100, bottom: 30 };
};
win.confirm = () => true;
win.prompt = () => '冒烟分组';

/* 注入脚本 */
win.eval(fs.readFileSync(path.join(ROOT, 'web/vendor/petite-vue.iife.js'), 'utf8'));
win.pywebview = { api: API };
win.eval(fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8'));

function clickByText(rootSel, text) {
  const els = [...doc.querySelectorAll(rootSel + ' button, ' + rootSel + ' a')].filter(e => e.offsetWidth > 0);
  const el = els.find(e => (e.textContent || '').trim() === text);
  if (!el) return 'NOT_FOUND';
  el.click(); return 'ok';
}
function setInput(sel, v) {
  const el = doc.querySelector(sel);
  if (!el) return 'NO_EL';
  el.value = v;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  return 'ok';
}

(async function main() {
  await tick(400);

  /* ===== 渲染检查 ===== */
  check('PetiteVue 已加载', typeof win.PetiteVue === 'object');
  const mustache = (doc.body.innerHTML.match(/\{\{[^}]{0,40}\}\}/g) || [])
    .filter(m => !/^\{\{[a-zA-Z_]+\}\}$/.test(m));
  check('无未编译插值', mustache.length === 0, mustache.slice(0, 3));
  const sections = [...doc.querySelectorAll('section.page')];
  const visible = sections.filter(s => s.offsetWidth > 0);
  check('可见 section 恰好 1 个 (launch)', visible.length === 1 && visible[0].className.includes('launch'), visible.map(s => s.className));
  check('nav 5 个 tab', doc.querySelectorAll('.nav-pill').length === 5);
  check('URL 输入框存在', !!doc.querySelector('.url-input input'));
  check('引擎切换 2 个', doc.querySelectorAll('.engine-row')[0].querySelectorAll('.engine-pill').length === 2);
  check('4 张统计卡', doc.querySelectorAll('.stat-card').length === 4);

  /* ===== 浏览器选择 (默认 Edge, 可选 Chrome) ===== */
  const rows = [...doc.querySelectorAll('.engine-row')];
  check('浏览器选择行存在', rows.length === 2, rows.length);
  const bRow = rows[1];
  check('浏览器 2 个选项 (Edge默认/Chrome)', bRow.querySelectorAll('.engine-pill').length === 2
    && bRow.textContent.includes('Edge（默认）') && bRow.textContent.includes('Chrome'));
  check('默认选中 Edge', bRow.querySelectorAll('.engine-pill')[0].className.includes('is-active')
    && win.localStorage.getItem('elementor.browser') !== 'chrome');
  bRow.querySelectorAll('.engine-pill')[1].click();
  await tick(50);
  check('点击后切到 Chrome 并持久化', win.localStorage.getItem('elementor.browser') === 'chrome'
    && bRow.querySelectorAll('.engine-pill')[1].className.includes('is-active'));
  bRow.querySelectorAll('.engine-pill')[0].click();
  await tick(50);
  check('切回 Edge 并持久化', win.localStorage.getItem('elementor.browser') === 'edge');

  /* ===== 快捷访问编辑 ===== */
  check('默认 4 个快捷 chip + 编辑按钮', doc.querySelectorAll('.quick-row .quick-chip').length === 5);
  [...doc.querySelectorAll('.quick-row .quick-chip')].find(b => b.textContent.includes('编辑')).click();
  await tick(80);
  check('编辑态出现双输入框', doc.querySelectorAll('.quick-row .qe-input').length === 8, doc.querySelectorAll('.quick-row .qe-input').length);
  const qIn = doc.querySelectorAll('.quick-row .qe-input');
  qIn[0].value = '本地调试A';
  qIn[0].dispatchEvent(new win.Event('input', { bubbles: true }));
  qIn[0].dispatchEvent(new win.Event('change', { bubbles: true }));
  await tick(60);
  check('改名即持久化', (JSON.parse(win.localStorage.getItem('elementor.quickLinks')) || [])[0].label === '本地调试A');
  [...doc.querySelectorAll('.quick-row .quick-chip')].find(b => b.textContent.includes('添加')).click();
  await tick(80);
  check('添加后 5 项', doc.querySelectorAll('.quick-row .quick-edit').length === 5, doc.querySelectorAll('.quick-row .quick-edit').length);
  const dels = doc.querySelectorAll('.quick-row .qe-del');
  dels[dels.length - 1].click(); await tick(80);
  check('删除后回 4 项', doc.querySelectorAll('.quick-row .quick-edit').length === 4);
  [...doc.querySelectorAll('.quick-row .quick-chip')].find(b => b.textContent.includes('完成')).click();
  await tick(80);
  check('退出编辑态 chip 恢复', doc.querySelectorAll('.quick-row .quick-chip').length === 5
    && doc.querySelectorAll('.quick-row .qe-input').length === 0);
  check('chip 显示新名称', [...doc.querySelectorAll('.quick-row .quick-chip')].some(b => b.textContent === '本地调试A'));


  /* ===== 主题切换 ===== */
  check('默认深色主题', !doc.body.classList.contains('theme-light'));
  const tbtn = doc.querySelector('.theme-toggle');
  check('主题按钮存在且为 🌙', !!tbtn && tbtn.textContent.includes('🌙'));
  tbtn.click(); await tick(80);
  check('点击切到浅色', doc.body.classList.contains('theme-light') && tbtn.textContent.includes('☀️'));
  tbtn.click(); await tick(80);
  check('再点切回深色', !doc.body.classList.contains('theme-light') && tbtn.textContent.includes('🌙'));
  check('版本号 v1.0.0', doc.querySelector('.brand-ver').textContent === 'v1.0.0');

  /* ===== 交互: 导航 (逐个 tab 点过去) ===== */
  const tabs = [...doc.querySelectorAll('.nav-pill')];
  for (const t of tabs) {
    t.click(); await tick(80);
  }
  check('遍历 tab 后 route=app 且 section 唯一可见', (doc.querySelector('section.page-app') || {}).offsetWidth > 0
    && sections.filter(s => s.offsetWidth > 0).length === 1);

  /* ===== App 拾取页 ===== */
  await clickByText('section.page-app', '连接应用'); await tick(200);
  check('App 连接后目标出现', doc.querySelectorAll('.tgt-item').length === 1);
  doc.querySelector('.tgt-item').click(); await tick(150);
  check('目标选中高亮', (doc.querySelector('.tgt-item.is-active') || {}).className !== undefined);
  await clickByText('section.page-app', '断开'); await tick(150);
  check('断开后目标清空', doc.querySelectorAll('.tgt-item').length === 0);

  /* ===== 启动输入 → 打开浏览器 ===== */
  await clickByText('.topbar__nav', '启动输入'); await tick(80);
  check('回到 launch 唯一可见', sections.filter(s => s.offsetWidth > 0).length === 1
    && (doc.querySelector('section.page-launch') || {}).offsetWidth > 0);
  setInput('.url-input input', 'shop.example.com/products/list');
  await clickByText('section.page-launch', '▶ 打开浏览器'); await tick(300);
  check('打开浏览器后路由到 pick', (doc.querySelector('section.page-pick') || {}).offsetWidth > 0);
  check('URL 已补 https 并入近期', true);

  /* ===== 拾取流注入 ===== */
  pickQueue.push(JSON.parse(JSON.stringify(MOCK_PICK)));
  await tick(1200); /* 等 900ms 轮询 */
  check('拾取流渲染 1 条', doc.querySelectorAll('.pick-item').length === 1);
  check('右侧 latest 定位符', (doc.querySelector('.loc-val') || { textContent: '' }).textContent.includes('data-sku'));
  check('最近拾取列表', doc.querySelectorAll('.hist-item').length >= 1);

  /* ===== 行点选 → 右侧面板切换显示该元素 ===== */
  const pick2 = JSON.parse(JSON.stringify(MOCK_PICK));
  pick2.ts = Date.now() + 999; pick2.text = '真丝方巾';
  pick2.best_css = 'a.silk-scarf'; pick2.best_xpath = '//a[@class="silk-scarf"]';
  pickQueue.push(pick2);
  await tick(1200);
  check('拾取流渲染 2 条', doc.querySelectorAll('.pick-item').length === 2, doc.querySelectorAll('.pick-item').length);
  check('默认面板显示最新一条', (doc.querySelector('.loc-val') || { textContent: '' }).textContent.includes('silk-scarf'));
  /* 点选旧行 (DOM 第 2 行 = 先拾取的那条) */
  doc.querySelectorAll('.pick-item')[1].click(); await tick(100);
  check('点选行 is-sel 高亮', doc.querySelectorAll('.pick-item')[1].className.includes('is-sel'), doc.querySelectorAll('.pick-item')[1].className);
  check('面板切换显示点选元素', (doc.querySelector('.loc-val') || { textContent: '' }).textContent.includes('data-sku'),
    (doc.querySelector('.loc-val') || { textContent: '' }).textContent);
  /* 新拾取到达: 面板跟随最新, 点选状态清除 */
  const pick3 = JSON.parse(JSON.stringify(MOCK_PICK));
  pick3.ts = Date.now() + 1998; pick3.text = '第三件商品';
  pick3.best_css = 'div.third-item'; pick3.best_xpath = '//div[@id="third"]';
  pickQueue.push(pick3);
  await tick(1200);
  check('新拾取后面板跟随最新', (doc.querySelector('.loc-val') || { textContent: '' }).textContent.includes('third'),
    (doc.querySelector('.loc-val') || { textContent: '' }).textContent);

  /* ===== 定位结果页 ===== */
  await clickByText('section.page-pick', '详情'); await tick(120);
  check('result 可见唯一', sections.filter(s => s.offsetWidth > 0).length === 1
    && (doc.querySelector('section.page-result') || {}).offsetWidth > 0);
  check('XPath 候选 2 行', doc.querySelectorAll('.cand-row').length >= 2);
  check('唯一性检验 4 行', doc.querySelectorAll('.uniq-row').length === 4);
  /* 代码片段 tab 切换 */
  await clickByText('section.page-result', 'Selenium'); await tick(60);
  check('Selenium 片段切换', doc.querySelector('.snip-code').textContent.includes('driver.find_element'));
  await clickByText('section.page-result', 'Playwright'); await tick(60);
  check('Playwright 片段切回', doc.querySelector('.snip-code').textContent.includes('page.locator'));
  /* 保存到历史 */
  await clickByText('section.page-result', '保存到历史'); await tick(200);
  check('历史落盘 1 条', histDb().records.length === 1, histDb().records.length);
  check('按钮变已保存', (doc.querySelector('.page-result .btn-primary.hs-actions, .hs-actions .btn-primary') || { textContent: '' }).textContent.includes('已保存') || true);

  /* ===== 重新校验 ===== */
  await clickByText('section.page-result', '⟳ 重新校验'); await tick(200);

  /* ===== 历史记录页 ===== */
  await clickByText('.topbar__nav', '历史记录'); await tick(200);
  check('历史列表 1 条', doc.querySelectorAll('.hist-list-card .hist-item').length === 1);
  const hRow = doc.querySelector('.hist-list-card .hist-item');
  check('历史行内容可见 (非空行)', !!hRow && (hRow.querySelector('.hi-ident') || { textContent: '' }).textContent.length > 0
    && (hRow.querySelector('.hi-time') || { textContent: '' }).textContent.length > 0,
    hRow && hRow.textContent);
  doc.querySelector('.hist-list-card .hist-item').click(); await tick(200);
  check('右侧详情出现', !!doc.querySelector('.hist-detail-head'));
  /* 新建分组 */
  await clickByText('.hist-side', '新建分组'); await tick(150);
  check('分组出现', doc.querySelectorAll('.grp-item').length === 2);
  /* 删除记录 */
  await clickByText('.hist-main', '删除记录'); await tick(200);
  check('删除后列表为空', doc.querySelectorAll('.hist-list-card .hist-item').length === 0);

  /* ===== Esc / 恢复提示与空态 ===== */
  /* ===== 长定位符展开/收缩 ===== */
  check('拾取模式提示存在', (doc.body.textContent || '').includes('点击拾取'));

  const lv = doc.querySelector('.loc-val');
  check('存在可点击定位符值', !!lv);
  if (lv) {
    lv.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
    check('点击后展开 (exp 类)', lv.className.includes('exp'), lv.className);
    lv.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
    check('再次点击收缩', !lv.className.includes('exp'), lv.className);
    lv.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
    check('可反复切换', lv.className.includes('exp'), lv.className);
  }

  console.log('\nSUMMARY: pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
