# -*- coding: utf-8 -*-
"""app.py —— ElementPicker 元素定位拾取器 入口 ( pywebview + 内置 HTTP )"""
import functools
import http.server
import json
import os
import socket
import sys
import threading

# 应用标识: 窗口标题 / 前端版本徽标 / CI 产物名 / Release tag 全部同源
APP_NAME = "element_picker"          # exe / zip / repo 标识
APP_TITLE = "ElementPicker 元素定位拾取器"   # 窗口标题栏
APP_VERSION = "1.0.0"                # CI 打包时由 ci_version.sh 自动改写

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

from core import history, locator  # noqa: E402
from core.engine_playwright import PlaywrightEngine  # noqa: E402
from core.engine_selenium import SeleniumEngine  # noqa: E402
from core.app_cdp import AppCdpEngine  # noqa: E402


def get_resource_path(rel):
    base = getattr(sys, "_MEIPASS", BASE)
    return os.path.join(base, rel)


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass


class Api(object):
    def __init__(self):
        self._engines = {"playwright": PlaywrightEngine(), "selenium": SeleniumEngine()}
        self._app = AppCdpEngine()
        self._active = None  # 当前浏览器引擎名

    def app_info(self):
        return {"name": APP_NAME, "title": APP_TITLE, "version": APP_VERSION}

    # ---------- 浏览器拾取 ----------
    def browser_open(self, url, engine, browser="edge"):
        eng = self._engines.get(engine or "playwright")
        if not eng:
            return {"ok": False, "error": "unknown engine"}
        old = self._active
        r = eng.open(url, browser=(browser if browser in ("edge", "chrome") else "edge"))
        if r.get("ok"):
            self._active = engine
        return r

    def browser_close(self):
        stopped = []
        for name, eng in self._engines.items():
            if eng.status()["running"]:
                eng.close()
                stopped.append(name)
        if self._active in stopped:
            self._active = None
        return {"ok": True, "stopped": stopped}

    def browser_status(self):
        active = self._engines.get(self._active) if self._active else None
        st = active.status() if active else {"running": False, "engine": "", "url": "", "picker": False}
        st["active"] = self._active or ""
        return st

    def browser_picks(self):
        if not self._active:
            return []
        eng = self._engines[self._active]
        picked = eng.drain()
        eng.ensure_picker()  # 页面跳转后自动补装
        return [locator.enrich(dict(p)) for p in picked]

    def browser_validate(self, kind, value):
        if not self._active:
            return {"count": -1, "error": "浏览器未启动"}
        return self._engines[self._active].validate(kind, value)

    def browser_set_mode(self, mode):
        """pick=拾取(拦截点击); browse=浏览(放行点击供页内导航)"""
        if not self._active:
            return {"ok": False, "error": "浏览器未启动"}
        return self._engines[self._active].set_mode(mode)

    # ---------- App 拾取 ----------
    def app_connect(self, port):
        return self._app.connect(port or 9222)

    def app_targets(self):
        return self._app.refresh_targets()

    def app_select(self, idx):
        return self._app.select(int(idx))

    def app_disconnect(self):
        self._app.close()
        return {"ok": True}

    def app_picks(self):
        picked = self._app.drain()
        return [locator.enrich(dict(p)) for p in picked]

    def app_validate(self, kind, value):
        return self._app.validate(kind, value)

    def app_set_mode(self, mode):
        return self._app.set_mode(mode)

    # ---------- 历史 ----------
    def history_list(self):
        return history.list_all()

    def history_save(self, record):
        rec = history.add(record)
        return locator.summarize(rec)

    def history_delete(self, rid):
        return {"ok": bool(history.delete(rid))}

    def history_clear(self):
        return {"ok": bool(history.clear())}

    def history_update(self, rid, patch):
        rec = history.update(rid, patch)
        return locator.summarize(rec) if rec else {"ok": False}

    def history_detail(self, rid):
        data = history.list_all()
        for r in data["records"]:
            if r.get("id") == rid:
                return r
        return None

    def group_add(self, name):
        return {"groups": history.group_add(name)}

    def group_delete(self, name):
        return {"groups": history.group_delete(name)}

    # ---------- 导出 ----------
    def export_json(self, records):
        path = os.path.join(BASE, "data", "export_%s.json" % __import__("time").strftime("%Y%m%d_%H%M%S"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)
        return {"ok": True, "path": path}


def _start_http():
    port = find_free_port()
    web_dir = get_resource_path("web")
    handler = functools.partial(QuietHandler, directory=web_dir)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return port


def main():
    try:
        import webview  # pywebview
    except ModuleNotFoundError:
        sys.stderr.write("[错误] 缺少依赖 pywebview ...\n  pip install \"pywebview>=5.0,<6.0\"\n")
        sys.exit(1)

    # 打包版内置了 Chromium ( playwright/driver/package/.local-browsers ):
    # PLAYWRIGHT_BROWSERS_PATH=0 让驱动在包内找浏览器, 目标机无需安装任何环境
    bundled = os.path.join(get_resource_path("playwright"), "driver", "package", ".local-browsers")
    if os.path.isdir(bundled):
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = "0"

    port = _start_http()
    api = Api()
    win = webview.create_window(
        "%s v%s" % (APP_TITLE, APP_VERSION),
        "http://127.0.0.1:%d/index.html" % port,
        js_api=api,
        width=1440, height=960,
        background_color="#0b100e",
    )

    def _on_closed():
        """应用窗口关闭时, 联动关闭拾取浏览器 / CDP 连接, 避免 Chromium 进程残留"""
        try:
            api.browser_close()
        except Exception:
            pass
        try:
            api._app.close()
        except Exception:
            pass

    win.events.closed += _on_closed
    webview.start(debug=False)
    _on_closed()  # start 返回后兜底再清一次 (closed 事件异步派发时防止进程残留)


if __name__ == "__main__":
    main()
