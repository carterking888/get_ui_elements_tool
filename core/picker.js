/**
 * elementor-picker.js —— 注入到目标页面的元素拾取脚本
 * 浏览器拾取(Playwright/Selenium) 与 App 拾取(WebView2/Electron CDP) 共用。
 * 职责:
 *   1. hover 高亮 + 提示标签
 *   2. 点击采集元素信息(阻止默认行为)
 *   3. 生成 XPath / CSS 候选定位符并做唯一性校验
 *   4. 结果推入 window.__elementor_picks, 由后端轮询取走
 */
(function () {
  if (window.__elementor_installed) return;
  window.__elementor_installed = true;
  window.__elementor_picks = window.__elementor_picks || [];

  function boot() {

  /* ---------- 样式 ---------- */
  var css = document.createElement('style');
  css.textContent = [
    '#__elm_overlay{position:fixed;pointer-events:none;z-index:2147483646;',
    'border:2px solid #00e08d;background:rgba(0,224,141,.12);border-radius:2px;',
    'box-shadow:0 0 0 1px rgba(0,224,141,.35);display:none;}',
    '#__elm_label{position:fixed;pointer-events:none;z-index:2147483647;display:none;',
    'font:11px/1.4 Consolas,monospace;color:#062b1e;background:#00e08d;',
    'padding:2px 7px;border-radius:3px;white-space:nowrap;max-width:420px;',
    'overflow:hidden;text-overflow:ellipsis;}'
  ].join('');
  document.head.appendChild(css);

  var box = document.createElement('div'); box.id = '__elm_overlay';
  var tag = document.createElement('div'); tag.id = '__elm_label';
  document.documentElement.appendChild(box);
  document.documentElement.appendChild(tag);

  var armed = true;

  /* ---------- 定位符生成 ---------- */
  function cssEscape(v) {
    if (window.CSS && CSS.escape) return CSS.escape(v);
    return String(v).replace(/([^a-z0-9_\u00A0-\uFFFF-])/ig, '\\$1');
  }
  function countXPath(xp) {
    try {
      var r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return r.snapshotLength;
    } catch (e) { return -1; }
  }
  function countCss(s) {
    try { return document.querySelectorAll(s).length; } catch (e) { return -1; }
  }
  function absXPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      var idx = 1, sib = el;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === el.tagName) idx++;
      }
      parts.unshift(el.tagName.toLowerCase() + '[' + idx + ']');
      el = el.parentElement;
    }
    return '/' + (parts.length ? parts.join('/') : '') .replace(/^\//, '') ;
  }
  /* 最短结构路径: 逐级上溯到能唯一即可 */
  function minXPath(el) {
    var seg = [];
    var cur = el;
    while (cur && cur.nodeType === 1) {
      var t = cur.tagName.toLowerCase();
      if (cur.id) { seg.unshift(t + '[@id="' + cur.id + '"]'); break; }
      var sibs = cur.parentElement
        ? Array.prototype.filter.call(cur.parentElement.children, function (c) { return c.tagName === cur.tagName; })
        : [cur];
      if (sibs.length > 1) {
        var idx = sibs.indexOf(cur) + 1;
        seg.unshift(t + '[' + idx + ']');
      } else {
        seg.unshift(t);
      }
      cur = cur.parentElement;
      if (seg.length > 6) break; /* 限制深度 */
    }
    return '//' + seg.join('/');
  }
  function buildCandidates(el) {
    var out = { xpath: [], css: [] };
    var tn = el.tagName.toLowerCase();

    if (el.id) {
      var x = '//*[@id="' + el.id + '"]', c = countXPath(x);
      out.xpath.push({ kind: 'id', value: x, count: c });
      var cs = '#' + cssEscape(el.id), cc = countCss(cs);
      out.css.push({ kind: 'id', value: cs, count: cc });
    }
    var name = el.getAttribute('name');
    if (name) {
      var x2 = '//' + tn + '[@name="' + name + '"]', c2 = countXPath(x2);
      out.xpath.push({ kind: 'name', value: x2, count: c2 });
    }
    /* 文本定位系列 —— 任意含直接文本的元素均可生成 */
    function xpLit(s) {
      if (s.indexOf('"') < 0) return '"' + s + '"';
      if (s.indexOf("'") < 0) return "'" + s + "'";
      return 'concat("' + s.replace(/"/g, '", \'"\', "') + '")';
    }
    /* CSS 属性值字面量: 转义反斜杠与双引号 */
    function cssLit(v) {
      return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    /* 直接文本节点 (不含子孙元素文本), 与 XPath text() 语义对齐 */
    var directTxt = '';
    for (var nd = el.firstChild; nd; nd = nd.nextSibling) {
      if (nd.nodeType === 3) directTxt += nd.nodeValue;
    }
    directTxt = directTxt.replace(/\s+/g, ' ').trim();
    var pushX = function (kind, value) {
      for (var q = 0; q < out.xpath.length; q++) if (out.xpath[q].value === value) return;
      var c = countXPath(value);
      if (c > 0) out.xpath.push({ kind: kind, value: value, count: c });
    };
    if (directTxt && directTxt.length <= 40) {
      var L = xpLit(directTxt);
      pushX('text', '//' + tn + '[text()=' + L + ']');
      pushX('text', '//*[text()=' + L + ']');
      pushX('text-index', '(//*[text()=' + L + '])[1]');
      pushX('text', '//' + tn + '[normalize-space(text())=' + L + ']');
      /* contains(text()) 系列: 短文本同样生成, 文本局部变化时仍可命中 */
      pushX('text-contains', '//' + tn + '[contains(text(), ' + L + ')]');
      pushX('text-contains', '//*[contains(text(), ' + L + ')]');
    }
    var allTxt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (allTxt && allTxt.length > directTxt.length && allTxt.length <= 60) {
      var shortTxt = allTxt.length > 24 ? allTxt.slice(0, 24) : allTxt;
      pushX('text-contains', '//*[contains(text(), ' + xpLit(shortTxt) + ')]');
    }
    /* ---------- 属性候选 (data-* 优先) ---------- */
    var attrs = el.attributes, dataAttrs = [], plainAttrs = [];
    var PLAIN_NAMES = ['placeholder', 'type', 'href', 'src', 'action', 'alt', 'title', 'aria-label', 'role'];
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      if (!a.value) continue;
      if (a.name.indexOf('data-') === 0) dataAttrs.push(a);
      else if (PLAIN_NAMES.indexOf(a.name) >= 0 && a.value.length < 60) plainAttrs.push(a);
    }
    /* CSS 候选推送: 去重 + 唯一性计数, 返回 count 便于调用方限量 */
    var pushC = function (kind, value) {
      for (var q = 0; q < out.css.length; q++) if (out.css[q].value === value) return 0;
      var c = countCss(value);
      if (c > 0) { out.css.push({ kind: kind, value: value, count: c }); return c; }
      return 0;
    };
    /* 属性运算符: ^= 前缀 / $= 后缀 / *= 包含 (maxOps 限制条数) */
    var attrOps = function (base, aname, aval, maxOps) {
      if (!aval || aval.length < 6) return 0;
      maxOps = maxOps || 3;
      var half = Math.ceil(aval.length / 2);
      var pre = aval.slice(0, half), suf = aval.slice(aval.length - half);
      var mid = aval.slice(Math.floor(aval.length / 4), aval.length - Math.floor(aval.length / 4));
      var n = 0;
      if (pre && pre !== aval && n < maxOps && pushC('attribute', base + '[' + aname + '^=' + cssLit(pre) + ']')) n++;
      if (suf && suf !== aval && n < maxOps && pushC('attribute', base + '[' + aname + '$=' + cssLit(suf) + ']')) n++;
      if (mid && mid !== aval && mid !== pre && mid !== suf && n < maxOps && pushC('attribute', base + '[' + aname + '*=' + cssLit(mid) + ']')) n++;
      return n;
    };
    if (dataAttrs.length) {
      var d0 = dataAttrs[0];
      var x3 = '//' + tn + '[@' + d0.name + '=' + xpLit(d0.value) + ']', c3 = countXPath(x3);
      if (c3 > 0) out.xpath.push({ kind: 'attribute', value: x3, count: c3 });
      var cc3 = pushC('attribute', tn + '[' + d0.name + '=' + cssLit(d0.value) + ']');
      /* 属性存在性: 页内唯一该属性时即为精确定位, 值变化也不失效 */
      var exd = tn + '[' + d0.name + ']';
      if (countCss(exd) === 1) pushC('attribute', exd);
      /* 精确匹配不唯一时, 运算符/组合候选才有兜底价值 */
      if (cc3 !== 1) {
        attrOps(tn, d0.name, d0.value);
        if (dataAttrs.length >= 2) {
          var d1 = dataAttrs[1];
          pushC('attribute', tn + '[' + d0.name + '=' + cssLit(d0.value) + '][' + d1.name + '=' + cssLit(d1.value) + ']');
        }
      }
    }
    if (plainAttrs.length) {
      for (var pi = 0; pi < Math.min(plainAttrs.length, 2); pi++) {
        var pa = plainAttrs[pi];
        var cpa = pushC('attribute', tn + '[' + pa.name + '=' + cssLit(pa.value) + ']');
        if (pa.name === 'href' || pa.name === 'src' || pa.name === 'action') {
          /* 链接类属性即使精确唯一也补运算符 (表达"某一类链接"语义), 但限量 2 条 */
          attrOps(tn, pa.name, pa.value, 2);
        } else if (cpa !== 1) {
          attrOps(tn, pa.name, pa.value);
        }
      }
      var x4 = '//' + tn + '[@' + plainAttrs[0].name + '=' + xpLit(plainAttrs[0].value) + ']', c4 = countXPath(x4);
      if (c4 > 0) out.xpath.push({ kind: 'attribute', value: x4, count: c4 });
    }

    /* ---------- class 组合 ---------- */
    var cls = (el.getAttribute('class') || '').trim();
    if (cls) {
      var cl = cls.split(/\s+/).filter(Boolean).slice(0, 4);
      /* 全类名组合 */
      pushC('class', tn + '.' + cl.map(cssEscape).join('.'));
      /* 单类 */
      for (var k = 0; k < cl.length; k++) pushC('class', tn + '.' + cssEscape(cl[k]));
      /* 两两组合 (单个类不唯一时常用) */
      if (cl.length > 2) {
        var pairs = 0;
        for (var k1 = 0; k1 < cl.length && pairs < 3; k1++) {
          for (var k2 = k1 + 1; k2 < cl.length && pairs < 3; k2++) {
            if (pushC('class', tn + '.' + cssEscape(cl[k1]) + '.' + cssEscape(cl[k2]))) pairs++;
          }
        }
      }
      /* 无标签类选择器 */
      pushC('class', '.' + cl.map(cssEscape).join('.'));
    }

    /* 结构路径兜底 */
    var mp = minXPath(el), mc = countXPath(mp);
    if (mc > 0) out.xpath.push({ kind: 'path', value: mp, count: mc });
    var ab = absXPath(el), abc = countXPath(ab);
    if (abc > 0) out.xpath.push({ kind: 'absolute', value: ab, count: abc });

    /* ---------- 结构 CSS 路径 ---------- */
    /* 路径分段: tag + 最多2个类; 无类且同级同名时补 nth-of-type */
    function segOf(node) {
      var t = node.tagName.toLowerCase();
      var c = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      var seg = t + (c.length ? '.' + c.map(cssEscape).join('.') : '');
      if (!c.length && node.parentElement) {
        var sameT = Array.prototype.filter.call(node.parentElement.children, function (x) { return x.tagName === node.tagName; });
        if (sameT.length > 1) seg += ':nth-of-type(' + (Array.prototype.indexOf.call(sameT, node) + 1) + ')';
      }
      return seg;
    }
    /* 带类的最短唯一路径: 从元素自身逐级加祖先, 找到 count==1 的最短前缀 */
    var segs = [], cur3 = el;
    while (cur3 && cur3.nodeType === 1 && segs.length < 5) {
      if (cur3.id) { segs.unshift('#' + cssEscape(cur3.id)); break; }
      segs.unshift(segOf(cur3));
      cur3 = cur3.parentElement;
    }
    for (var k3 = 1; k3 <= segs.length; k3++) {
      var cand3 = segs.slice(segs.length - k3).join(' > ');
      var c3n = countCss(cand3);
      /* 与 class 候选同值时 pushC 返回 0, 此时继续加深度而非提前结束 */
      if (c3n === 1 && pushC('path', cand3)) break;
      if (k3 === segs.length && c3n > 0) pushC('path', cand3);
    }
    /* 祖先 ID 锚定短路径: #id > tag / #id tag / #id tag.cls */
    var anc = el.parentElement, hops = 0, anchor = null;
    while (anc && hops < 4) {
      if (anc.id) { anchor = anc; break; }
      anc = anc.parentElement; hops++;
    }
    if (anchor) {
      var anchorSel = '#' + cssEscape(anchor.id), mySeg = segOf(el);
      pushC('path', anchorSel + ' > ' + mySeg);
      pushC('path', anchorSel + ' ' + mySeg);
    }
    /* 祖先类名锚定路径: .cls > span.target / .cls > div:nth-child(i) .target
       nth-child 标注的是锚点与元素之间链上的那个中间节点 */
    var myCl0 = cls.split(/\s+/).filter(Boolean);
    var prevNode = el;
    var ancCls = el.parentElement, hopCls = 0;
    while (ancCls && hopCls < 3) {
      var acls = (ancCls.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      if (acls.length) {
        var aSel = '.' + cssEscape(acls[0]);
        var tTag = myCl0.length ? tn + '.' + cssEscape(myCl0[0]) : tn;
        var tCls = myCl0.length ? '.' + cssEscape(myCl0[0]) : tn;
        if (hopCls === 0) {
          pushC('path', aSel + ' > ' + tTag);
          if (tCls !== tTag) pushC('path', aSel + ' > ' + tCls);
        } else if (prevNode !== el && prevNode.parentElement === ancCls) {
          var midIdx = Array.prototype.indexOf.call(ancCls.children, prevNode) + 1;
          var midSeg = prevNode.tagName.toLowerCase() + ':nth-child(' + midIdx + ')';
          pushC('path', aSel + ' > ' + midSeg + ' ' + tTag);
          if (tCls !== tTag) pushC('path', aSel + ' > ' + midSeg + ' ' + tCls);
        }
      }
      prevNode = ancCls;
      ancCls = ancCls.parentElement; hopCls++;
    }
    /* 纯索引兜底路径 (nth-child) */
    var cssSeg = [], cur2 = el;
    while (cur2 && cur2.nodeType === 1 && cssSeg.length < 5) {
      var t2 = cur2.tagName.toLowerCase();
      if (cur2.id) { cssSeg.unshift('#' + cssEscape(cur2.id)); break; }
      var p = cur2.parentElement;
      if (p) {
        var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === cur2.tagName; });
        var tstr = t2 + (same.length > 1 ? ':nth-child(' + (Array.prototype.indexOf.call(p.children, cur2) + 1) + ')' : '');
        cssSeg.unshift(tstr);
      } else cssSeg.unshift(t2);
      cur2 = cur2.parentElement;
    }
    var cssPath = cssSeg.join(' > ');
    pushC('path', cssPath);

    /* 候选数量上限: 截断时保证每种 kind 至少保留一条 (优先取截断区里的唯一项) */
    function capCands(arr, max) {
      if (arr.length <= max) return;
      var kept = arr.slice(0, max);
      var kinds = {};
      for (var i2 = 0; i2 < kept.length; i2++) kinds[kept[i2].kind] = 1;
      for (var j2 = max; j2 < arr.length; j2++) {
        var c2 = arr[j2];
        if (!kinds[c2.kind]) {
          /* 从截断区尾部腾位: 优先替换重复 kind 的非唯一项 */
          var slot = -1;
          for (var k2 = kept.length - 1; k2 >= 0; k2--) {
            if (kept[k2].kind === c2.kind) { slot = k2; break; }
            if (kept[k2].count !== 1 && slot < 0) slot = k2;
          }
          if (slot >= 0) { kept[slot] = c2; kinds[c2.kind] = 1; }
        }
      }
      arr.length = 0;
      for (var m2 = 0; m2 < kept.length; m2++) arr.push(kept[m2]);
    }
    capCands(out.css, 14);
    capCands(out.xpath, 14);

    return out;
  }
  function collect(el, x, y) {
    var r = el.getBoundingClientRect();
    var cls = (el.getAttribute('class') || '').trim();
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (['id', 'class', 'style'].indexOf(a.name) < 0 && attrs && Object.keys(attrs).length < 12) attrs[a.name] = a.value;
    }
    var cands = buildCandidates(el);
    return {
      ts: Date.now(),
      url: location.href,
      title: document.title,
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      name: el.getAttribute('name') || '',
      class: cls,
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      size: Math.round(r.width) + ' x ' + Math.round(r.height),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(x), y: Math.round(y),
      attrs: attrs,
      candidates: cands
    };
  }

  /* ---------- 模式与交互 ---------- */
  /* mode: 'pick' = 拦截点击采集定位符; 'browse' = 完全放行, 供页内导航/输入 */
  var mode = window.__elementor_mode === 'browse' ? 'browse' : 'pick';
  window.__elementor_set_mode = function (m) {
    mode = (m === 'browse') ? 'browse' : 'pick';
    if (mode === 'browse') hide();
    return mode;
  };
  window.__elementor_get_mode = function () { return mode; };

  function highlight(el, x, y) {
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    var cls = (el.getAttribute('class') || '').split(/\s+/)[0] || '';
    tag.style.display = 'block';
    tag.textContent = el.tagName.toLowerCase() + (cls ? '.' + cls : '') + '  ·  ' + Math.round(r.width) + ' x ' + Math.round(r.height);
    var lx = Math.min(x + 14, window.innerWidth - 260);
    var ly = Math.max(y - 26, 4);
    tag.style.left = lx + 'px'; tag.style.top = ly + 'px';
  }
  function hide() { box.style.display = 'none'; tag.style.display = 'none'; }

  /* 输入类元素: 点击采集的同时放行默认行为 (聚焦/展开), 可直接输入操作 */
  function isEditable(el) {
    if (!el || !el.tagName) return false;
    var t = el.tagName.toLowerCase();
    if (t === 'input' || t === 'textarea' || t === 'select') return true;
    return !!el.isContentEditable;
  }

  /* 监听挂在 window 捕获层: 触发时机早于任何 document/元素级处理器,
     保证在站点自身脚本之前拿到事件 */
  window.addEventListener('mousemove', function (e) {
    if (mode === 'browse' || !armed) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tag || !el.tagName) { hide(); return; }
    highlight(el, e.clientX, e.clientY);
  }, true);

  window.addEventListener('click', function (e) {
    if (mode === 'browse') return;            /* 浏览模式: 不拦截, 正常点击 */
    if (e.ctrlKey) { hide(); return; }        /* 拾取中 Ctrl+点击: 临时穿透, 可跳转 */
    if (!armed) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tag) return;
    var editable = isEditable(el);
    if (!editable) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    /* 可编辑元素: 不拦截不阻断, 采集后站点正常响应 (聚焦/下拉/后续输入) */
    try {
      var rec = collect(el, e.clientX, e.clientY);
      window.__elementor_picks.push(rec);
      if (editable) { hide(); return; }       /* 放行交互, 立即收起高亮 */
      /* 点击反馈闪烁 */
      var old = box.style.background;
      box.style.background = 'rgba(0,224,141,.45)';
      setTimeout(function () { box.style.background = old; hide(); }, 260);
    } catch (err) { /* ignore */ }
  }, true);

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var ae = document.activeElement;
      if (ae && isEditable(ae)) return;       /* 正在输入框内操作: Esc 交给页面, 不暂停拾取 */
      armed = false; hide();
    }
  }, true);

  /* Shift 重新启用拾取 */
  window.addEventListener('keyup', function (e) {
    if (e.key === 'Shift') armed = true;
  }, true);

  } /* end boot */

  /* init_script 可能在文档解析前执行, 此时 head/documentElement 尚不存在 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
