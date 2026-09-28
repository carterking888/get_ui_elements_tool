/* _picker_check.js —— picker.js 采集逻辑验证 ( jsdom, 无需浏览器 ) */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
}

const pageHtml = `<!DOCTYPE html><html><head><title>商品列表 - NOVA</title></head><body>
  <header id="top"><nav><a href="/" data-track="nav-top-item" data-spm="header">首页</a><a href="/new" data-track="nav-top-item" data-spm="header-new">新品</a></nav></header>
  <main id="main">
    <ul class="product-list">
      <li class="product-card"><a class="product-title" href="/p/1" data-sku="A1023">简约格纹大衣</a><span class="price-num">299</span></li>
      <li class="product-card"><a class="product-title" href="/p/2" data-sku="A1024">羊毛混纺针织衫</a><span class="price-num">459</span></li>
      <li class="product-card"><a class="product-title" href="/p/3" data-sku="A1025">复古灯芯绒衬衫</a><span class="price-num">329</span></li>
      <li class="product-card"><a class="product-title promo-item j-track" href="/product/detail/2024" data-sku="SKU-2026-0888" data-brand="nova-official">真丝方巾</a><span class="price-num">199</span></li>
    </ul>
    <input id="keyword" name="keyword" type="text" placeholder="搜索商品">
    <button id="checkout" class="btn-checkout">去结算</button>
  </main>
</body></html>`;

const dom = new JSDOM(pageHtml, { url: 'https://shop.example.com/products/list', runScripts: 'outside-only', pretendToBeVisual: true });
const win = dom.window;
const doc = win.document;

/* jsdom 桩 */
win.HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 100, top: 200, width: 324, height: 180, right: 424, bottom: 380 };
};
let probe = null;
doc.elementFromPoint = function (x, y) { return probe; };
doc.addEventListener = doc.addEventListener.bind(doc);

/* jsdom (outside-only) readyState 恒为 loading, 桩成 complete 让 picker 立即 boot */
Object.defineProperty(doc, 'readyState', { configurable: true, get() { return 'complete'; } });

/* 注入 picker */
win.eval(fs.readFileSync(path.join(__dirname, 'core/picker.js'), 'utf8'));
check('安装标记', win.__elementor_installed === true);

function clickAt(el, x, y) {
  probe = el;
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

(async () => {
  /* 1. 拾取带 data-sku 的链接 */
  const link = doc.querySelector('a[data-sku="A1024"]');
  clickAt(link, 736, 412);
  await new Promise(r => setTimeout(r, 50));
  const picks = win.__elementor_picks;
  check('采集到 1 条', picks.length === 1, picks.length);
  const p = picks[0];
  check('基础字段', p.tag === 'a' && p['class'] === 'product-title' && p.url.includes('/products/list'));
  check('data-sku 进 attrs', p.attrs['data-sku'] === 'A1024', p.attrs);
  check('坐标', p.x === 736 && p.y === 412);
  check('尺寸', p.size === '324 x 180');

  /* XPath 候选 */
  const xps = p.candidates.xpath;
  const attrXp = xps.find(c => c.value.includes('data-sku'));
  check('属性 XPath 唯一', attrXp && attrXp.count === 1, xps);
  check('含结构路径候选', xps.some(c => c.kind === 'path' || c.kind === 'absolute'));

  /* 文本定位系列 */
  check('text() 系列 >= 4 条', xps.filter(c => c.kind === 'text' || c.kind === 'text-index' || c.kind === 'text-contains').length >= 4, xps);
  check('//a[text()="羊毛混纺针织衫"]', xps.some(c => c.value === '//a[text()="羊毛混纺针织衫"]' && c.count === 1));
  check('//*[text()="羊毛混纺针织衫"]', xps.some(c => c.value === '//*[text()="羊毛混纺针织衫"]' && c.count === 1));
  check('(//*[text()=...])[1] 形式', xps.some(c => c.value === '(//*[text()="羊毛混纺针织衫"])[1]' && c.count === 1));
  check('normalize-space 变体保留', xps.some(c => c.value.includes('normalize-space(text())')));

  /* CSS 候选 */
  const css = p.candidates.css;
  const attrCss = css.find(c => c.value.includes('data-sku'));
  check('属性 CSS 唯一', attrCss && attrCss.count === 1, css);
  const classCss = css.find(c => c.value === 'a.product-title');
  check('class CSS 多匹配 (4)', classCss && classCss.count === 4, css);

  /* 2. 拾取 id 输入框: id 双形态定位 + 输入类元素放行默认行为 */
  const input = doc.getElementById('keyword');
  probe = input;
  const inputEv = new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 500, clientY: 60 });
  const inputNotPrevented = input.dispatchEvent(inputEv);
  await new Promise(r => setTimeout(r, 50));
  check('输入框点击不拦截默认行为 (可聚焦输入)', inputNotPrevented === true);
  const p2 = picks[1];
  check('第二条采集', !!p2 && p2.tag === 'input');
  const idCss = p2.candidates.css.find(c => c.value === '#keyword');
  check('id CSS 唯一', idCss && idCss.count === 1);
  const nameXp = p2.candidates.xpath.find(c => c.value.includes('@name="keyword"'));
  check('name XPath 候选', !!nameXp && nameXp.count === 1);

  /* 2.5 拾取文本按钮 */
  const btn = doc.getElementById('checkout');
  clickAt(btn, 700, 500);
  await new Promise(r => setTimeout(r, 50));
  const pb = picks[2];
  check('按钮采集', !!pb && pb.tag === 'button');
  const btnXps = pb ? pb.candidates.xpath : [];
  check('按钮 //*[text()="去结算"] 唯一', btnXps.some(c => c.value === '//*[text()="去结算"]' && c.count === 1), btnXps);
  check('按钮 (//*[text()="去结算"])[1]', btnXps.some(c => c.value === '(//*[text()="去结算"])[1]'));
  check('按钮 //button[text()="去结算"]', btnXps.some(c => c.value === '//button[text()="去结算"]'));
  check('按钮 //button[contains(text(), "去结算")]', btnXps.some(c => c.value === '//button[contains(text(), "去结算")]' && c.count === 1), btnXps);
  check('按钮 //*[contains(text(), "去结算")]', btnXps.some(c => c.value === '//*[contains(text(), "去结算")]'));

  /* 2.6 拾取富属性链接: 类名组合 / 结构路径 (精确属性唯一时不生成运算符) */
  const rich = doc.querySelector('a[data-sku="SKU-2026-0888"]');
  clickAt(rich, 736, 480);
  await new Promise(r => setTimeout(r, 50));
  const pr = picks[3];
  check('富属性链接采集', !!pr && pr.tag === 'a');
  const rc = pr ? pr.candidates.css : [];
  check('精确属性唯一时不生成 ^=', !rc.some(c => c.value.includes('data-sku^=')), rc);
  check('href ^= 运算符 (链接类始终生成)', rc.some(c => c.value === 'a[href^="/product/d"]' && c.count === 1), rc);
  check('类名两两组合', rc.some(c => c.value === 'a.product-title.promo-item' && c.count === 1), rc);
  check('无标签类选择器', rc.some(c => c.value === '.product-title.promo-item.j-track' && c.count === 1), rc);
  const prPath = rc.find(c => c.kind === 'path');
  check('带类最短结构路径', prPath && prPath.value === 'li.product-card > a.product-title.promo-item' && prPath.count === 1, rc.filter(c => c.kind === 'path'));
  check('CSS 候选无重复值', new Set(rc.map(c => c.value)).size === rc.length);
  check('CSS 候选不超过 14 条', rc.length <= 14, rc.length);
  const rcKinds = new Set(rc.map(c => c.kind));
  check('attribute/class/path kind 齐全', rcKinds.has('attribute') && rcKinds.has('class') && rcKinds.has('path'), [...rcKinds]);

  /* 2.7 祖先 ID 锚定短路径 */
  check('#main > button.btn-checkout', (pb ? pb.candidates.css : []).some(c => c.value === '#main > button.btn-checkout' && c.count === 1), pb && pb.candidates.css);

  /* 2.8 精确属性不唯一时: 运算符 + 多属性组合兜底 */
  const navHome = doc.querySelector('nav a[href="/"]');
  clickAt(navHome, 30, 20);
  await new Promise(r => setTimeout(r, 50));
  const pn = picks[4];
  check('导航链接采集', !!pn && pn.tag === 'a');
  const nc = pn ? pn.candidates.css : [];
  check('属性 ^= 前缀 (精确不唯一)', nc.some(c => c.value === 'a[data-track^="nav-to"]' && c.count === 2), nc);
  check('多属性组合兜底唯一', nc.some(c => c.value === 'a[data-track="nav-top-item"][data-spm="header"]' && c.count === 1), nc);

  /* 2.9 祖先类名锚定 + nth-child 路径: .product-list > li:nth-child(1) .price-num */
  const price1 = doc.querySelector('ul.product-list li:first-child .price-num');
  clickAt(price1, 800, 300);
  await new Promise(r => setTimeout(r, 50));
  const pp = picks[picks.length - 1];
  check('价格 span 采集', !!pp && pp.tag === 'span', picks.map(x => x && x.tag));
  const pcss = pp ? pp.candidates.css : [];
  check('.product-card > span.price-num (父级锚定, 4 处)', pcss.some(c => c.value === '.product-card > span.price-num' && c.count === 4), pcss);
  check('.product-card > .price-num', pcss.some(c => c.value === '.product-card > .price-num' && c.count === 4), pcss);
  check('.product-list > li:nth-child(1) span.price-num 唯一', pcss.some(c => c.value === '.product-list > li:nth-child(1) span.price-num' && c.count === 1), pcss);
  check('.product-list > li:nth-child(1) .price-num', pcss.some(c => c.value === '.product-list > li:nth-child(1) .price-num' && c.count === 1), pcss);
  const priceXps = pp ? pp.candidates.xpath : [];
  check('价格 //span[contains(text(), "299")]', priceXps.some(c => c.value === '//span[contains(text(), "299")]' && c.count === 1), priceXps);

  /* 3. 点击被拦截: 链接不跳转 ( preventDefault ) */
  const nav = doc.querySelector('nav a');
  const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  probe = nav;
  const notPrevented = nav.dispatchEvent(ev);
  check('默认行为被拦截', notPrevented === false);
  check('链接未跳转', win.location.pathname === '/products/list');

  /* 4. Esc 暂停拾取 (输入框聚焦时 Esc 不暂停) */
  const before = win.__elementor_picks.length;
  Object.defineProperty(doc, 'activeElement', { configurable: true, get() { return doc.getElementById('keyword'); } });
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  probe = doc.getElementById('checkout');
  doc.getElementById('checkout').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
  await new Promise(r => setTimeout(r, 30));
  check('输入框内 Esc 不暂停拾取', win.__elementor_picks.length > before);
  Object.defineProperty(doc, 'activeElement', { configurable: true, get() { return doc.body; } });
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const afterEsc = win.__elementor_picks.length;
  probe = doc.getElementById('checkout');
  doc.getElementById('checkout').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
  await new Promise(r => setTimeout(r, 30));
  check('焦点在页面时 Esc 暂停拾取', win.__elementor_picks.length === afterEsc);

  console.log('\nSUMMARY: pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
