/* app.js —— 元素定位拾取器 前端数据层 ( petite-vue ) */
/* global PetiteVue */

/* ---------- 工具 ---------- */
function api(name) {
  var args = Array.prototype.slice.call(arguments, 1);
  return new Promise(function (resolve, reject) {
    if (!window.pywebview || !window.pywebview.api) { reject(new Error('pywebview 未就绪')); return; }
    window.pywebview.api[name].apply(window.pywebview.api, args)
      .then(resolve, function (e) { reject(e); });
  });
}
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
  var ta = document.createElement('textarea');
  ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) { /* noop */ }
  document.body.removeChild(ta);
  return Promise.resolve();
}
function badgeOf(count) {
  if (count === 1) return { text: '唯一', cls: 'is-unique' };
  if (count > 1) return { text: count + ' 项匹配', cls: 'is-multi' };
  return { text: '失效', cls: 'is-dead' };
}
var KIND_LABEL = { id: 'ID', name: 'NAME', 'class': 'CLASS', attribute: '属性', text: '文本', 'text-index': '文本[1]', 'text-contains': '包含文本', path: '路径', absolute: '绝对' };

/* ---------- 记录视图模型 ---------- */
function recordView(r, src) {
  var cands = r.candidates || { xpath: [], css: [] };
  var kindLabel = KIND_LABEL;
  var uniq = r.unique || {};
  return {
    src: src || 'browser',
    id: r.id || '',
    raw: r,
    tag: r.tag || '',
    tagDisp: (r.tag || '') + (r['class'] ? '.' + r['class'].split(/\s+/)[0] : ''),
    idDisp: r.id || '该元素无 id',
    idHas: !!r.id,
    nameDisp: r.name || '该元素无 name 属性',
    nameHas: !!r.name,
    classDisp: r['class'] || '—',
    text: r.text || '(空)',
    size: r.size || '',
    pos: 'x ' + r.x + ' · y ' + r.y,
    x: r.x || 0,
    y: r.y || 0,
    attrCount: Object.keys(r.attrs || {}).length,
    url: r.url || '',
    title: r.title || '',
    timeStr: r.time_str || '',
    bestXpath: r.best_xpath || '',
    bestCss: r.best_css || '',
    uniqueXpath: !!uniq.xpath,
    uniqueCss: !!uniq.css,
    uniqueId: !!uniq.id,
    xpathList: (cands.xpath || []).map(function (c) {
      var b = badgeOf(c.count);
      return { value: c.value, count: c.count, badge: b.text, badgeCls: b.cls, kindLabel: kindLabel[c.kind] || c.kind, unique: c.count === 1 };
    }),
    cssList: (cands.css || []).map(function (c) {
      var b = badgeOf(c.count);
      return { value: c.value, count: c.count, badge: b.text, badgeCls: b.cls, kindLabel: kindLabel[c.kind] || c.kind, unique: c.count === 1 };
    }),
    attrList: Object.keys(r.attrs || {}).map(function (k) { return { k: k, v: r.attrs[k] }; }),
    snipSel: 'playwright',
    snipText: (r.snippets && r.snippets.playwright || []).join('\n') || '// 暂无片段',
    snippetTabs: [
      { key: 'selenium', label: 'Selenium' },
      { key: 'playwright', label: 'Playwright' },
      { key: 'cypress', label: 'Cypress' }
    ],
    saved: false
  };
}
function setSnippet(vm, key) {
  var lines = (vm.raw.snippets || {})[key] || [];
  vm.snipSel = key;
  vm.snipText = lines.join('\n') || '// 暂无片段';
}

/* ---------- 近期访问 ( localStorage ) ---------- */
var LS_RECENT = 'elementor.recent';
function loadRecent() {
  try { return JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); } catch (e) { return []; }
}
function pushRecent(url) {
  if (!url) return [];
  var list = loadRecent().filter(function (r) { return r.url !== url; });
  list.unshift({ url: url, ts: Date.now() });
  list = list.slice(0, 6);
  localStorage.setItem(LS_RECENT, JSON.stringify(list));
  return list;
}
function recentView(list) {
  return list.map(function (r) {
    var d = new Date(r.ts);
    var diff = Math.floor((Date.now() - r.ts) / 60000);
    var label = diff < 1 ? '刚刚' : diff < 60 ? diff + ' 分钟前'
      : diff < 1440 ? Math.floor(diff / 60) + ' 小时前'
      : Math.floor(diff / 1440) + ' 天前';
    var short = r.url.replace(/^https?:\/\//, '');
    var env = /localhost|127\.0\.0\.1/.test(r.url) ? '本地环境'
      : /test|qc|dev/.test(r.url) ? '测试环境'
      : /staging|uat/.test(r.url) ? '预发环境' : '已保存';
    return { url: r.url, short: short, label: label, env: env };
  });
}

/* ---------- 快捷访问 ( localStorage, 可编辑 ) ---------- */
var LS_QUICK = 'elementor.quickLinks';
var QUICK_DEFAULTS = [
  { label: '本地调试', url: 'http://localhost:3000' },
  { label: '测试环境', url: 'http://test.example.com' },
  { label: '预发环境', url: 'http://staging.example.com' },
  { label: '后台管理', url: 'http://admin.example.com' }
];
function loadQuickLinks() {
  try {
    var v = JSON.parse(localStorage.getItem(LS_QUICK) || 'null');
    if (Array.isArray(v) && v.length) {
      return v.filter(function (q) { return q && q.url; })
        .map(function (q) { return { label: q.label || q.url, url: q.url }; });
    }
  } catch (e) { /* noop */ }
  return QUICK_DEFAULTS.slice();
}
function persistQuickLinks(list) {
  try {
    localStorage.setItem(LS_QUICK, JSON.stringify(
      list.filter(function (q) { return q && q.url; })
        .map(function (q) { return { label: q.label || q.url, url: q.url }; })));
  } catch (e) { /* noop */ }
}
function loadBrowserChoice() {
  try {
    var v = localStorage.getItem('elementor.browser');
    return (v === 'chrome') ? 'chrome' : 'edge';   /* 默认 Edge */
  } catch (e) { return 'edge'; }
}

/* ---------- 根状态 ---------- */
var TABS = [
  { key: 'launch', label: '启动输入' },
  { key: 'pick', label: '浏览器拾取' },
  { key: 'result', label: '定位结果' },
  { key: 'history', label: '历史记录' },
  { key: 'app', label: 'App 拾取（调试中）' }
];

var HD_STUB = null;

var state = {
  route: 'launch',
  tabs: TABS,
  toast: '',
  toastCls: '',
  theme: (function () { try { return localStorage.getItem('elementor.theme') || 'dark'; } catch (e) { return 'dark'; } })(),

  get themeIcon() { return this.theme === 'dark' ? '🌙' : '☀️'; },

  toggleTheme() {
    var next = this.theme === 'dark' ? 'light' : 'dark';
    this.theme = next;
    document.body.classList.toggle('theme-light', next === 'light');
    try { localStorage.setItem('elementor.theme', next); } catch (e) { /* noop */ }
    this.showMsg(next === 'dark' ? '已切换到深色主题' : '已切换到浅色主题', 'is-ok');
  },

  /* 启动输入 */
  urlInput: '',
  engine: 'playwright',
  browserChoice: loadBrowserChoice(),
  busy: false,
  recent: recentView(loadRecent()),
  quickLinks: loadQuickLinks(),
  quickEditing: false,

  /* 浏览器拾取 */
  bStatus: { running: false, engine: '', url: '', picker: false, active: '' },
  bMode: 'pick',       /* pick=拾取拦截; browse=放行点击 */
  expMap: {},          /* 长定位符展开状态: value -> 1 */
  bPicks: [],          /* vm 数组, 新的在前 */
  _latest: null,       /* 最新拾取 vm */
  bFocus: null,        /* 拾取流点选中的 vm, 右侧面板优先显示它 */
  current: null,       /* vm, 定位结果页 */
  pollMs: 62,

  /* App 拾取 */
  appPort: '9222',
  appConnected: false,
  aMode: 'pick',
  appTargets: [],
  appSelected: -1,
  appPicks: [],
  _appLatest: null,
  aFocus: null,

  /* 历史 */
  historyLoaded: false,
  appVersion: '',      /* 后端 app_info 注入, 与窗口标题/CI 产物同源 */
  historyRaw: [],      /* 原始记录 */
  historyGroups: [],
  keyword: '',
  activeGroup: '',
  historyItems: [],    /* 摘要 vm */
  historyDetail: null, /* vm */
  savedIds: {},

  get hd() {
    /* 永不为 null, 避免 v-else 分支在置空瞬间的求值竞态 */
    if (this.historyDetail) return this.historyDetail;
    if (!HD_STUB) HD_STUB = recordView({ tag: '', id: '', name: '', 'class': '', text: '', size: '', attrs: {}, candidates: { xpath: [], css: [] }, snippets: {} }, 'browser');
    return HD_STUB;
  },
  get groupChips() {
    var src = this.historyRaw;
    return this.historyGroups.map(function (g) {
      var n = src.filter(function (r) { return r.group === g; }).length;
      return { name: g, count: n };
    });
  },
  get historyFiltered() {
    var kw = String(this.keyword || '').trim().toLowerCase();
    var g = this.activeGroup;
    /* 基于摘要 vm 过滤: 模板用的是 ident/time 等映射字段, 直接滤 historyRaw 会渲染出空行 */
    var src = this.historyItems;
    if (g === '__star') src = src.filter(function (r) { return !!r.star; });
    else if (g) src = src.filter(function (r) { return (r.group || '') === g; });
    if (kw) src = src.filter(function (r) {
      return ((r.tag || '') + ' ' + (r.ident || '') + ' ' + (r.best || '') + ' ' + (r.text || '')).toLowerCase().indexOf(kw) >= 0;
    });
    return src;
  },
  get statPicks() { return this.historyRaw.length; },
  get statLatest() { return this.latest; },
  /* 右侧面板显示目标: 点选中的优先, 否则跟随最新一条 */
  get latest() { return this.bFocus || this._latest; },
  get appLatest() { return this.aFocus || this._appLatest; },
  get latestUniqueRate() {
    var all = this.bPicks;
    if (!all.length) return '—';
    var u = all.filter(function (p) { return p.uniqueXpath || p.uniqueCss; }).length;
    return Math.round(u * 100 / all.length) + '%';
  },

  /* ---------- 生命周期 ---------- */
  init() {
    var self = this;
    if (!window.PetiteVueApp) window.PetiteVueApp = this; /* 响应式 proxy */
    window.addEventListener('hashchange', function () { self.onHash(); });
    this.onHash();
    this.waitApi(0);
  },
  waitApi(n) {
    var self = this;
    if (window.pywebview && window.pywebview.api) {
      self.showMsg('ready', '');
      api('app_info').then(function (r) {
        if (r && r.version) self.appVersion = 'v' + r.version;
      }, function () { });
      self.refreshStatus();
      self.pollLoop();
      return;
    }
    if (n < 60) setTimeout(function () { self.waitApi(n + 1); }, 500);
    else self.showMsg('后端未就绪 (pywebview api 缺失)', 'is-err');
  },
  onHash() {
    var h = (location.hash || '').replace('#/', '');
    if (h && TABS.some(function (t) { return t.key === h; })) this.route = h;
  },
  go(key) { this.route = key; location.hash = '#/' + key; },
  showMsg(text, cls) {
    this.toast = text; this.toastCls = cls || '';
    if (text && text !== 'ready') {
      var self = this;
      clearTimeout(self._tt);
      self._tt = setTimeout(function () { self.toast = ''; }, 2600);
    }
  },
  copy(t) {
    var self = this;
    copyText(t).then(function () { self.showMsg('已复制到剪贴板', 'is-ok'); },
      function () { self.showMsg('复制失败', 'is-err'); });
  },

  toggleExp(v) {
    /* 点击定位符值: 展开/收缩长文本 */
    if (this.expMap[v]) delete this.expMap[v];
    else this.expMap[v] = 1;
  },
  isExp(v) { return !!this.expMap[v]; },

  /* ---------- 快捷访问编辑 ---------- */
  toggleQuickEdit() {
    this.quickEditing = !this.quickEditing;
    if (!this.quickEditing) {
      persistQuickLinks(this.quickLinks);
      this.showMsg('快捷访问已保存', 'is-ok');
    }
  },
  addQuick() {
    if (this.quickLinks.length >= 8) { this.showMsg('最多 8 个快捷入口', 'is-err'); return; }
    this.quickLinks.push({ label: '新入口', url: 'http://' });
  },
  delQuick(q) {
    var i = this.quickLinks.indexOf(q);
    if (i >= 0) this.quickLinks.splice(i, 1);
    persistQuickLinks(this.quickLinks);
  },
  persistQuickNow() { persistQuickLinks(this.quickLinks); },
  setBrowser(b) {
    this.browserChoice = (b === 'chrome') ? 'chrome' : 'edge';
    try { localStorage.setItem('elementor.browser', this.browserChoice); } catch (e) { /* noop */ }
  },

  /* ---------- 启动输入 ---------- */
  openBrowser() {
    var self = this;
    var url = String(this.urlInput || '').trim();
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    if (!url || url === 'https://') { this.showMsg('请输入页面地址', 'is-err'); return; }
    this.busy = true;
    api('browser_open', url, this.engine, this.browserChoice).then(function (r) {
      self.busy = false;
      if (r && r.ok) {
        self.recent = recentView(pushRecent(url));
        self.bStatus = { running: true, engine: self.engine, url: url, picker: true, active: self.engine, browser: self.browserChoice };
        self.bMode = 'pick';
        self.bPicks = []; self._latest = null; self.bFocus = null;
        self.go('pick');
        if (r.warn) self.showMsg(r.warn, 'is-err');
        else self.showMsg('浏览器已打开, 开始拾取', 'is-ok');
      } else {
        self.showMsg('打开失败: ' + ((r && r.error) || '未知错误'), 'is-err');
      }
    }, function (e) { self.busy = false; self.showMsg('打开失败: ' + e, 'is-err'); });
  },
  closeBrowser() {
    var self = this;
    api('browser_close').then(function () {
      self.bStatus = { running: false, engine: '', url: '', picker: false, active: '' };
      self.bMode = 'pick';
      self.showMsg('浏览器已关闭', 'is-ok');
    });
  },
  refreshStatus() {
    var self = this;
    api('browser_status').then(function (st) {
      self.bStatus = st || self.bStatus;
      if (st && st.mode && !self._bModePending) self.bMode = st.mode;
    }, function () { });
  },

  /* ---------- 拾取/浏览模式 ---------- */
  toggleBMode() {
    var self = this;
    var next = this.bMode === 'pick' ? 'browse' : 'pick';
    this._bModePending = true;
    api('browser_set_mode', next).then(function (r) {
      self._bModePending = false;
      if (r && r.ok) {
        self.bMode = r.mode;
        self.showMsg(r.mode === 'browse'
          ? '已切换浏览模式: 可正常点击/输入, 页内导航'
          : '已切换拾取模式: 点击采集定位符', 'is-ok');
      } else self.showMsg('切换失败: ' + ((r && r.error) || ''), 'is-err');
    }, function () { self._bModePending = false; });
  },
  toggleAMode() {
    var self = this;
    var next = this.aMode === 'pick' ? 'browse' : 'pick';
    api('app_set_mode', next).then(function (r) {
      if (r && r.ok) {
        self.aMode = r.mode;
        self.showMsg(r.mode === 'browse' ? 'App 已切换浏览模式' : 'App 已切换拾取模式', 'is-ok');
      } else self.showMsg('切换失败: ' + ((r && r.error) || ''), 'is-err');
    });
  },

  /* ---------- 轮询 ---------- */
  pollLoop() {
    var self = this;
    setInterval(function () {
      var t0 = Date.now();
      if (self.bStatus.running) {
        api('browser_picks').then(function (list) {
          self.pollMs = Date.now() - t0;
          if (list && list.length) self.ingest(list, 'browser');
          self.refreshStatus();
        }, function () { });
      }
      if (self.appConnected) {
        api('app_picks').then(function (list) {
          if (list && list.length) self.ingest(list, 'app');
        }, function () { });
      }
    }, 900);
  },
  /* 点选拾取流某一行: 右侧元素定位面板切换显示该元素 */
  selPick(p, src) {
    if (src === 'app') this.aFocus = p; else this.bFocus = p;
  },
  /* 删除单条拾取 (后端 drain 取走即清, 纯前端删即可, 不会被轮询重新灌入) */
  delPick(p, src) {
    var arr = src === 'app' ? this.appPicks : this.bPicks;
    var i = arr.indexOf(p);
    if (i < 0) return;
    arr.splice(i, 1);
    if (src === 'app') {
      if (this._appLatest === p) this._appLatest = arr[0] || null;
      if (this.aFocus === p) this.aFocus = arr[0] || null;
    } else {
      if (this._latest === p) this._latest = arr[0] || null;
      if (this.bFocus === p) this.bFocus = arr[0] || null;
    }
    this.showMsg('已删除该条拾取', 'is-ok');
  },
  /* 清空拾取流 */
  clearPicks(src) {
    if (src === 'app') {
      this.appPicks = []; this._appLatest = null; this.aFocus = null;
    } else {
      this.bPicks = []; this._latest = null; this.bFocus = null;
    }
    this.showMsg('拾取流已清空', 'is-ok');
  },
  ingest(list, src) {
    var self = this;
    list.forEach(function (r) {
      var vm = recordView(r, src);
      if (self.savedIds[r.best_xpath || r.ts]) vm.saved = true;
      if (src === 'browser') {
        self.bPicks.unshift(vm);
        self._latest = vm;
      } else {
        self.appPicks.unshift(vm);
        self._appLatest = vm;
      }
    });
    /* 新拾取到达: 面板跟随最新一条 (清除旧的点选状态) */
    if (src === 'browser') this.bFocus = null; else this.aFocus = null;
    if (src === 'browser' && this.bPicks.length > 60) this.bPicks.length = 60;
    if (src === 'app' && this.appPicks.length > 60) this.appPicks.length = 60;
  },
  vmToRaw(vm) {
    return vm.raw || vm;
  },

  /* ---------- 定位结果 ---------- */
  openResult(vm) {
    this.current = vm;
    this.go('result');
  },
  selSnippet(vm, key) { setSnippet(vm, key); },
  validateCurrent(vm) {
    var self = this;
    var target = vm || this.current;
    if (!target) return;
    var m = target.src === 'app' ? 'app_validate' : 'browser_validate';
    api(m, 'xpath', target.bestXpath).then(function (r) {
      var b = badgeOf(r.count);
      target.raw.unique = target.raw.unique || {};
      target.raw.unique.xpath = r.count === 1;
      target.uniqueXpath = r.count === 1;
      var xpRow = target.xpathList.filter(function (c) { return c.value === target.bestXpath; })[0];
      if (xpRow) { xpRow.count = r.count; xpRow.badge = b.text; xpRow.badgeCls = b.cls; xpRow.unique = r.count === 1; }
      self.showMsg('XPath 实测: ' + b.text, r.count === 1 ? 'is-ok' : 'is-err');
    }, function (e) { self.showMsg('校验失败: ' + e, 'is-err'); });
  },
  saveRecord(vm) {
    var self = this;
    var target = vm || this.current;
    if (!target) return;
    var raw = this.vmToRaw(target);
    api('history_save', raw).then(function (s) {
      target.saved = true;
      if (raw.best_xpath) self.savedIds[raw.best_xpath] = true;
      self.showMsg('已保存到历史记录', 'is-ok');
      self.loadHistory();
    }, function (e) { self.showMsg('保存失败: ' + e, 'is-err'); });
  },
  exportJson() {
    var self = this;
    var rec = this.current ? [this.vmToRaw(this.current)] : [];
    if (!rec.length) { this.showMsg('暂无可导出的记录', 'is-err'); return; }
    api('export_json', rec).then(function (r) {
      self.showMsg('已导出: ' + r.path, 'is-ok');
    }, function (e) { self.showMsg('导出失败: ' + e, 'is-err'); });
  },

  /* ---------- 历史 ---------- */
  loadHistory() {
    var self = this;
    api('history_list').then(function (data) {
      self.historyRaw = data.records || [];
      self.historyGroups = data.groups || [];
      self.historyItems = self.historyRaw.map(function (r) {
        return {
          id: r.id, ident: r.best_css || r.best_xpath || r.tag || '',
          firstCls: ((r['class'] || '').split(/\s+/)[0]) || '',
          tag: r.tag, text: r.text || '', time: r.saved_at || '',
          group: r.group || '', star: !!r.star,
          best: r.best_css || r.best_xpath || ''
        };
      });
      self.historyLoaded = true;
    }, function () { });
  },
  openHistoryResult() {
    if (this.historyDetail) this.current = this.historyDetail;
    this.go('result');
  },
  selGroup(g) { this.activeGroup = g; },
  openHistory(id) {
    var self = this;
    api('history_detail', id).then(function (r) {
      if (!r) { self.showMsg('记录不存在', 'is-err'); return; }
      self.historyDetail = recordView(r, 'browser');
    });
  },
  delHistory(id) {
    var self = this;
    api('history_delete', id).then(function () {
      self.historyDetail = null;
      self.loadHistory();
      self.showMsg('记录已删除', 'is-ok');
    });
  },
  clearHistory() {
    var self = this;
    if (!window.confirm('确认清空全部历史记录?')) return;
    api('history_clear').then(function () {
      self.historyDetail = null;
      self.loadHistory();
      self.showMsg('历史已清空', 'is-ok');
    });
  },
  starHistory(item) {
    var self = this;
    var next = !item.star;
    api('history_update', item.id, { star: next }).then(function () {
      item.star = next;
    });
  },
  addGroup() {
    var self = this;
    var name = window.prompt('新分组名称:');
    if (!name) return;
    api('group_add', name).then(function (r) {
      self.historyGroups = r.groups;
    });
  },
  assignGroup(item) {
    var self = this;
    var name = window.prompt('将该记录移动到分组 (输入名称):', item.group || '');
    if (name === null) return;
    api('history_update', item.id, { group: name }).then(function () {
      item.group = name;
      self.loadHistory();
    });
  },

  /* ---------- App 拾取 ---------- */
  connectApp() {
    var self = this;
    this.busy = true;
    api('app_connect', parseInt(this.appPort, 10) || 9222).then(function (r) {
      self.busy = false;
      if (r && r.ok) {
        self.appConnected = true;
        self.appTargets = (r.targets || []).map(function (t) {
          return { idx: t.idx, title: t.title, url: t.url, short: t.url.slice(0, 60) };
        });
        self.showMsg('已连接 CDP 端口 ' + self.appPort, 'is-ok');
      } else {
        self.appConnected = false;
        self.showMsg('连接失败: ' + ((r && r.error) || '请确认应用已开启远程调试端口'), 'is-err');
      }
    }, function (e) { self.busy = false; self.appConnected = false; self.showMsg('连接失败: ' + e, 'is-err'); });
  },
  refreshTargets() {
    var self = this;
    api('app_targets').then(function (r) {
      if (r && r.ok) {
        self.appTargets = (r.targets || []).map(function (t) {
          return { idx: t.idx, title: t.title, url: t.url, short: t.url.slice(0, 60) };
        });
        self.showMsg('目标列表已刷新', 'is-ok');
      } else self.showMsg('刷新失败', 'is-err');
    });
  },
  selectTarget(t) {
    var self = this;
    api('app_select', t.idx).then(function (r) {
      if (r && r.ok) {
        self.appSelected = t.idx;
        self.appPicks = []; self.appLatest = null;
        self.showMsg('已选中: ' + t.title, 'is-ok');
      } else self.showMsg('选中失败: ' + ((r && r.error) || ''), 'is-err');
    });
  },
  disconnectApp() {
    var self = this;
    api('app_disconnect').then(function () {
      self.appConnected = false;
      self.appTargets = []; self.appSelected = -1;
      self.appPicks = []; self.appLatest = null;
      self.showMsg('已断开连接', 'is-ok');
    });
  },
  openAppResult(vm) {
    this.current = vm;
    this.go('result');
  }
};

/* 主题: 挂载前先把 class 落到 body, 避免首帧闪色 */
if (state.theme === 'light') document.body.classList.add('theme-light');

PetiteVue.createApp(state).mount();
