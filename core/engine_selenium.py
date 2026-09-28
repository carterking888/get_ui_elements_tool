# -*- coding: utf-8 -*-
"""engine_selenium.py —— Selenium 浏览器拾取引擎 ( Edge / Chrome + CDP 注入 )"""
import json
import os

_DRIVER_NAMES = ("chromedriver.exe", "chromedriver", "msedgedriver.exe", "msedgedriver")


def _strip_drivers_from_path():
    """PATH 里有旧版 chromedriver 时, Selenium 会直接采用它, 与本机 Chrome 版本
    不匹配直接报错 ( 版本相差一大截时 Selenium Manager 也不肯覆盖 )。
    临时从 PATH 剔除这些 driver, 让 Selenium Manager 按当前浏览器版本自动下载
    匹配的 driver ( 缓存在 ~/.cache/selenium, 只需下载一次 )。返回原 PATH 供恢复。"""
    old_path = os.environ.get("PATH", "")
    parts = old_path.split(os.pathsep)
    kept = []
    for p in parts:
        if p and any(os.path.isfile(os.path.join(p, n)) for n in _DRIVER_NAMES):
            continue
        kept.append(p)
    os.environ["PATH"] = os.pathsep.join(kept)
    return old_path


def _restore_path(old_path):
    if old_path is not None:
        os.environ["PATH"] = old_path

from .engine_playwright import BaseEngine, _PICKER, _js_str

_DRAIN_JS_RAW = "{ const p = (window.__elementor_picks || []).splice(0); return p; }"
_ENSURE_RAW = ("{ if (window.__elementor_installed) return true;"
               " try { (new Function(arguments[0]))(); return !!window.__elementor_installed; }"
               " catch (e) { return false; } }")


def _count_raw(kind, value):
    if kind == "css":
        return ("{ try { return document.querySelectorAll(arguments[0]).length; }"
                " catch(e){ return -1; } }")
    return ("{ try { return document.evaluate(arguments[0], document, null,"
            " XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength; } catch(e){ return -1; } }")


class SeleniumEngine(BaseEngine):
    def __init__(self):
        BaseEngine.__init__(self)
        self._driver = None
        self._seen_handles = set()   # 出现过的窗口句柄, 用于发现新标签页

    def engine_name(self):
        return "selenium"

    def _sync_window(self):
        """新标签页跟随: 链接新开标签页时自动切过去; 活动标签页被关掉时
        自动落到剩余标签页, 避免会话假死。"""
        d = self._driver
        if not d:
            return
        try:
            hs = d.window_handles
        except Exception:
            return
        if not hs:
            return
        try:
            cur = d.current_window_handle
        except Exception:
            cur = None
        if cur not in hs:
            d.switch_to.window(hs[-1])
        elif hs[-1] not in self._seen_handles:
            d.switch_to.window(hs[-1])   # 有新标签页 -> 跟过去
        self._seen_handles = set(hs)

    def _attach(self, url):
        from selenium import webdriver
        pref = self._browser_pref  # 'edge' | 'chrome', 默认 Edge
        old_path = _strip_drivers_from_path()
        try:
            # 依次尝试: 所选浏览器 -> 另一个 ( 目标机未必两个都装了 )
            # Selenium Manager 是 selenium 包自带的独立 exe, 打包后无需 Python
            # 环境, 首次使用会自动下载匹配版本的 driver ( 之后走本地缓存 )
            order = ["edge", "chrome"] if pref == "edge" else ["chrome", "edge"]
            last = None
            for name in order:
                try:
                    if name == "edge":
                        from selenium.webdriver.edge.options import Options as EdgeOptions
                        eopts = EdgeOptions()
                        eopts.add_argument("--start-maximized")
                        self._driver = webdriver.Edge(options=eopts)
                    else:
                        from selenium.webdriver.chrome.options import Options
                        opts = Options()
                        opts.add_argument("--start-maximized")
                        opts.add_experimental_option("excludeSwitches", ["enable-automation"])
                        self._driver = webdriver.Chrome(options=opts)
                    if name != pref:
                        self._warn = "系统 %s 未找到, 已自动改用 %s" % (
                            "Chrome" if pref == "chrome" else "Edge",
                            "Chrome" if name == "chrome" else "Edge")
                    break
                except Exception as e:
                    last = e
                    self._driver = None
            if not self._driver:
                raise RuntimeError(
                    "本机未找到 Edge / Chrome, 无法启动 Selenium 引擎; 原始错误: %s"
                    % str(last)[:200])
        finally:
            _restore_path(old_path)
        # CDP: 每个新文档自动注入拾取器 ( 等价 Playwright init_script )
        try:
            self._driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": _PICKER})
        except Exception:
            pass
        try:
            self._seen_handles = {self._driver.current_window_handle}
        except Exception:
            self._seen_handles = set()
        self._driver.get(url)

    def _eval(self, js):
        """BaseEngine 传来的 js 是箭头函数体, Selenium 里转成普通 script 执行"""
        if not self._driver:
            raise RuntimeError("driver not ready")
        if js.startswith("() =>"):
            body = js[5:].strip()
            return self._driver.execute_script("return " + body)
        return self._driver.execute_script(js)

    def drain(self):
        if not self._ready:
            return []
        try:
            self._sync_window()
            self.ensure_picker()
            return self._driver.execute_script("return " + _DRAIN_JS_RAW) or []
        except Exception:
            return []

    def ensure_picker(self):
        if not self._ready:
            return False
        try:
            ok = self._driver.execute_script("return !!window.__elementor_installed;")
            if ok:
                return True
            return bool(self._driver.execute_script(_ENSURE_RAW, _PICKER))
        except Exception:
            return False

    def validate(self, kind, value):
        if not self._ready:
            return {"count": -1, "error": "浏览器未启动"}
        try:
            self._sync_window()
            self.ensure_picker()
            return {"count": self._driver.execute_script(_count_raw(kind, value), value)}
        except Exception as e:
            return {"count": -1, "error": str(e)[:200]}

    def _apply_mode(self, mode):
        """所有窗口立即生效 + CDP 让后续新文档继承"""
        d = self._driver
        if not d:
            return
        lit = json.dumps(mode)
        try:
            d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument",
                              {"source": "window.__elementor_mode = %s;" % lit})
        except Exception:
            pass
        try:
            cur = d.current_window_handle
        except Exception:
            cur = None
        for h in d.window_handles:
            try:
                d.switch_to.window(h)
                d.execute_script(
                    "if (window.__elementor_set_mode) window.__elementor_set_mode(%s);"
                    " else window.__elementor_mode = %s;" % (lit, lit))
            except Exception:
                pass
        if cur:
            try:
                d.switch_to.window(cur)
            except Exception:
                pass

    def status(self):
        """检测浏览器窗口是否已被用户手动关闭"""
        if self._ready:
            try:
                self._sync_window()
                _ = self._driver.current_window_handle
            except Exception:
                self._ready = False
        return BaseEngine.status(self)

    def _quit(self):
        try:
            self._driver and self._driver.quit()
        except Exception:
            pass
        self._driver = None
