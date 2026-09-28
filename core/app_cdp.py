# -*- coding: utf-8 -*-
"""app_cdp.py —— App 应用拾取 ( WebView2 / Electron, CDP 接管 )

WebView2 应用: 启动参数加 --remote-debugging-port=9222
  (或环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222)
Electron 应用: 主进程 app.commandLine.appendSwitch('remote-debugging-port', '9222')
"""
import json
import os

from .engine_playwright import BaseEngine, _PICKER, _DRAIN_JS, _ENSURE_JS, _SET_MODE_ARG_JS, _js_str, _clear_stale_running_loop


class AppCdpEngine(BaseEngine):
    def __init__(self):
        BaseEngine.__init__(self)
        self._pw = None
        self._browser = None
        self._page = None
        self._targets = []
        self._port = 9222

    def engine_name(self):
        return "app-cdp"

    # ---- 目标枚举 ----
    def connect(self, port):
        self._port = int(port)
        fut = self._executor.submit(self._do_connect, self._port)
        try:
            return fut.result(timeout=30)
        except Exception as e:
            return {"ok": False, "error": str(e)[:300]}

    def _do_connect(self, port):
        from playwright.sync_api import sync_playwright
        _clear_stale_running_loop()
        if self._pw:
            try:
                self._pw.stop()
            except Exception:
                pass
            self._pw = None
            self._browser = None
            self._page = None
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % port, timeout=8000)
        self._targets = self._list_targets()
        return {"ok": True, "targets": self._targets}

    def _list_targets(self):
        out = []
        idx = 0
        for ctx in self._browser.contexts:
            for pg in ctx.pages:
                t = {"idx": idx, "title": pg.title() or "(无标题)",
                     "url": pg.url, "type": "page"}
                if t["url"].startswith(("devtools://", "chrome://")):
                    idx += 1
                    continue
                out.append(t)
                idx += 1
        return out

    def refresh_targets(self):
        if not self._browser:
            return {"ok": False, "error": "未连接"}
        try:
            self._targets = self._executor.submit(self._list_targets).result(timeout=10)
            return {"ok": True, "targets": self._targets}
        except Exception as e:
            return {"ok": False, "error": str(e)[:200]}

    def select(self, idx):
        """选中目标页面并注入拾取器"""
        def _do():
            tgt = next((t for t in self._targets if t["idx"] == idx), None)
            if not tgt:
                raise RuntimeError("target not found")
            pg = None
            for ctx in self._browser.contexts:
                for p in ctx.pages:
                    if p.url == tgt["url"]:
                        pg = p
                        break
                if pg:
                    break
            if not pg:
                raise RuntimeError("page lost, refresh targets")
            self._page = pg
            try:
                pg.add_init_script(_PICKER)
            except Exception:
                pass
            pg.evaluate("(src) => { if (!window.__elementor_installed) (new Function(src))(); }", _PICKER)
            return True
        try:
            self._executor.submit(_do).result(timeout=15)
            self._ready = True
            self._url = next((t["url"] for t in self._targets if t["idx"] == idx), "")
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)[:300]}

    def _apply_mode(self, mode):
        """App 内所有页面立即生效 + init_script 让后续导航继承"""
        if not self._browser:
            return
        lit = json.dumps(mode)
        for ctx in self._browser.contexts:
            for pg in ctx.pages:
                try:
                    pg.add_init_script("window.__elementor_mode = %s;" % lit)
                    pg.evaluate(_SET_MODE_ARG_JS, mode)
                except Exception:
                    pass

    def _attach(self, url):  # BaseEngine.open 不适用, 保留兼容
        raise RuntimeError("use connect()/select()")

    def _eval(self, js):
        if not self._page:
            raise RuntimeError("no selected page")
        return self._page.evaluate(js)

    def _quit(self):
        for closer in (
            lambda: self._browser and self._browser.close(),
            lambda: self._pw and self._pw.stop(),
        ):
            try:
                closer()
            except Exception:
                pass
        self._browser = None
        self._page = None
        self._pw = None
        self._ready = False
        self._targets = []
