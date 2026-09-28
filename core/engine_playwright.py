# -*- coding: utf-8 -*-
"""engine_playwright.py —— Playwright 浏览器拾取引擎 ( headed Chromium )"""
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor


def _resource_path(rel):
    """打包态 (PyInstaller): 数据文件在 sys._MEIPASS (项目根结构);
    源码态: 回退到项目根目录 (core/ 的上一级)"""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(base, rel)


_PICKER = open(_resource_path(os.path.join("core", "picker.js")), "r", encoding="utf-8").read()

_DRAIN_JS = "() => { const p = (window.__elementor_picks || []).splice(0); return p; }"
_INSTALLED_JS = "() => !!window.__elementor_installed"
_ENSURE_JS = """
(src) => {
  if (window.__elementor_installed) return true;
  try { (new Function(src))(); return !!window.__elementor_installed; }
  catch (e) { return false; }
}
"""


_COUNT_CSS_JS = "(v) => { try { return document.querySelectorAll(v).length; } catch(e){ return -1; } }"
_COUNT_XPATH_JS = ("(v) => { try { return document.evaluate(v, document, null,"
                   " XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength; } catch(e){ return -1; } }")

_SET_MODE_ARG_JS = ("(m) => { if (window.__elementor_set_mode) return window.__elementor_set_mode(m);"
                    " window.__elementor_mode = m; return m; }")

_NAV_HINTS = (
    ("ERR_CONNECTION_CLOSED", "连接被关闭 ( 检查网络 / 代理 / 防火墙 )"),
    ("ERR_CONNECTION_RESET", "连接被重置 ( 检查网络 / 代理 / 防火墙 )"),
    ("ERR_CONNECTION_REFUSED", "连接被拒绝 ( 目标服务未启动? )"),
    ("ERR_NAME_NOT_RESOLVED", "域名无法解析 ( 检查地址拼写 / DNS )"),
    ("ERR_TIMED_OUT", "连接超时 ( 检查网络 / 目标可达性 )"),
    ("ERR_TUNNEL_CONNECTION_FAILED", "代理隧道建立失败 ( 检查系统代理设置 )"),
    ("ERR_PROXY_CONNECTION_FAILED", "代理不可用 ( 检查系统代理设置 )"),
    ("ERR_CERT_", "证书校验失败"),
    ("ERR_ABORTED", "导航被中止"),
)


def _friendly_nav_error(e):
    s = str(e)
    for k, v in _NAV_HINTS:
        if k in s:
            return v
    return s.split("\n")[0][:200]


def _js_str(s):
    return "JSON.parse(%s)" % __import__("json").dumps(s)


def _clear_stale_running_loop():
    """playwright 同步 API 在每次调用后会用 asyncio._set_running_loop 把自己的
    事件循环残留为本线程的 running loop (线程本地)。同一线程再次执行
    sync_playwright().start() 时会被误判为"在 asyncio 循环里使用同步 API"。
    本工具的所有 playwright 调用都跑在专用工作线程里, 该线程绝无自己的
    合法循环, 检测到残留直接清掉即可。"""
    import asyncio
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return  # 无残留, 正常
    asyncio._set_running_loop(None)


class BaseEngine(object):
    """通用页面驱动封装: 子类实现 _attach() / _eval(js) / _quit()"""

    def __init__(self):
        self._executor = ThreadPoolExecutor(max_workers=1)
        self._ready = False
        self._url = ""
        self._error = ""
        self._warn = ""
        self._mode = "pick"
        self._browser_pref = "edge"   # 默认 Edge; 可选 chrome

    # ---- 供子类实现 ----
    def _attach(self, url):
        raise NotImplementedError

    def _eval(self, js):
        raise NotImplementedError

    def _eval_arg(self, js, arg):
        """带参求值, 供 validate 使用; Playwright 系页面默认实现"""
        page = getattr(self, "_page", None)
        if not page:
            raise RuntimeError("page not ready")
        return page.evaluate(js, arg)

    def _quit(self):
        raise NotImplementedError

    def engine_name(self):
        return "base"

    # ---- 对外 API ----
    def _reset_executor(self):
        """重建工作线程: playwright 同步 API 绑定创建它的线程,
        换线程是彻底摆脱残留状态最可靠的方式"""
        try:
            self._executor.shutdown(wait=False)
        except Exception:
            pass
        self._executor = ThreadPoolExecutor(max_workers=1)

    def open(self, url, browser="edge"):
        self._browser_pref = browser if browser in ("edge", "chrome") else "edge"
        self._warn = ""
        fut = self._executor.submit(self._attach, url)
        try:
            # 需要覆盖"自动下载 Chromium (~150MB)"的最坏情况; 常规失败
            # (浏览器缺失/导航报错) 都会在远小于此的时间内抛出
            fut.result(timeout=900)
            self._url = url
            self._ready = True
            r = {"ok": True}
            if self._warn:
                r["warn"] = self._warn
            return r
        except Exception as e:
            self._error = str(e)[:300]
            # 清掉半启动的 playwright, 并换一个干净线程供下次重开
            try:
                self._executor.submit(self._quit).result(timeout=10)
            except Exception:
                pass
            self._reset_executor()
            return {"ok": False, "error": self._error}

    def drain(self):
        if not self._ready:
            return []
        try:
            fut = self._executor.submit(self._eval, _DRAIN_JS)
            return fut.result(timeout=10) or []
        except Exception:
            return []

    def ensure_picker(self):
        if not self._ready:
            return False
        try:
            fut = self._executor.submit(self._eval, "(%s)(%s)" % (_INSTALLED_JS, ""))
            if fut.result(timeout=5):
                return True
            fut = self._executor.submit(self._eval, "(%s)(%s)" % (_ENSURE_JS, _js_str(_PICKER)))
            return bool(fut.result(timeout=5))
        except Exception:
            return False

    def validate(self, kind, value):
        if not self._ready:
            return {"count": -1, "error": "浏览器未启动"}
        js = _COUNT_CSS_JS if kind == "css" else _COUNT_XPATH_JS
        try:
            fut = self._executor.submit(lambda: self._eval_arg(js, value))
            return {"count": fut.result(timeout=10)}
        except Exception as e:
            return {"count": -1, "error": str(e)[:200]}

    def status(self):
        """检测浏览器窗口是否已被用户手动关闭; url 报告活动标签页实时地址"""
        if self._ready:
            def _probe():
                pg = self._active_page()
                if pg is None:
                    return True, ""
                url = ""
                try:
                    url = pg.url or ""
                except Exception:
                    pass
                return False, url
            try:
                closed, url = self._executor.submit(_probe).result(timeout=5)
                if closed:
                    self._ready = False
                elif url:
                    self._url = url
            except Exception:
                self._ready = False
        return {"running": self._ready, "engine": self.engine_name(), "url": self._url,
                "error": self._error, "warn": self._warn, "picker": self._ready, "mode": self._mode}

    def set_mode(self, mode):
        """pick=拦截点击采集; browse=放行点击供页内导航"""
        self._mode = "browse" if mode == "browse" else "pick"
        if not self._ready:
            return {"ok": True, "mode": self._mode}
        try:
            fut = self._executor.submit(self._apply_mode, self._mode)
            fut.result(timeout=15)
            return {"ok": True, "mode": self._mode}
        except Exception as e:
            return {"ok": False, "error": str(e)[:200]}

    def _apply_mode(self, mode):
        """子类实现: 对当前所有页面生效, 并让后续新页面继承"""
        raise NotImplementedError

    def close(self):
        if self._executor._threads:
            try:
                self._executor.submit(self._quit).result(timeout=15)
            except Exception:
                pass
        self._reset_executor()
        self._ready = False
        self._warn = ""


class PlaywrightEngine(BaseEngine):
    """启动本机 Chromium 内核(headed), init_script 保证每个新页面都带拾取器"""

    def __init__(self):
        BaseEngine.__init__(self)
        self._pw = None
        self._browser = None
        self._page = None
        self._ctx = None
        self._lock = threading.Lock()
        self._auto_install_tried = False   # Chromium 自动安装每次会话只试一次

    def engine_name(self):
        return "playwright"

    def _attach(self, url):
        from playwright.sync_api import sync_playwright
        _clear_stale_running_loop()
        # 重开场景: 先停掉上一个实例, 避免泄漏
        if self._pw:
            try:
                self._pw.stop()
            except Exception:
                pass
            self._pw = None
            self._browser = None
            self._ctx = None
            self._page = None
        self._lock.acquire()
        try:
            self._mode = "pick"
            self._warn = ""
            self._pw = sync_playwright().start()
            self._browser = self._launch_chromium()
            self._ctx = self._browser.new_context(no_viewport=True)
            self._ctx.add_init_script(_PICKER)
            self._page = self._ctx.new_page()
            # 新标签页跟随: 链接新开标签页后自动把拾取/采集切过去
            # ( 拾取器由 add_init_script 自动装到每个新页面, 无需重装 )
            try:
                self._ctx.on("page", self._on_new_page)
            except Exception:
                pass
            try:
                self._goto_with_retry(url)
            except Exception as e:
                # 导航失败不杀浏览器: 拾取脚本已通过 init_script 装好,
                # 用户可在地址栏手动导航, 每个新文档都会自动装上拾取器
                self._warn = "页面加载失败: %s; 浏览器保持打开, 可在地址栏手动访问后继续拾取" % _friendly_nav_error(e)
        finally:
            self._lock.release()

    def _launch_chromium(self):
        """启动优先级: 用户所选的系统浏览器 -> 包内内置 Chromium ( 完整版 )
        -> 另一个系统浏览器。默认 Edge: 目标机未必装了 Chrome, 而 Windows 一定有 Edge。
        注意 Playwright channel 名: Edge 是 'msedge' ( 不是 'ms-edge'/'edge' )。"""
        pref = self._browser_pref
        channel = "msedge" if pref == "edge" else "chrome"
        other = "chrome" if pref == "edge" else "msedge"
        try:
            return self._launch_channel(channel)
        except Exception as e1:
            base = getattr(sys, "_MEIPASS", None)
            if base:
                lb = os.path.join(base, "playwright", "driver", "package", ".local-browsers")
                try:
                    if os.path.isdir(lb) and any(
                            d.startswith("chromium") for d in os.listdir(lb)):
                        self._warn = "系统 %s 未找到, 已改用内置 Chromium" % (
                            "Edge" if pref == "edge" else "Chrome")
                        return self._pw.chromium.launch(
                            headless=False, args=["--start-maximized"])
                except OSError:
                    pass
            try:
                return self._launch_channel(other)
            except Exception as e2:
                # 终极兜底: 系统 Edge/Chrome 都没有 -> 用内置 playwright 驱动
                # 自带的 node 跑 `install chromium` 自动下载 ( 无需 Python 环境 )
                try:
                    return self._auto_install_and_launch()
                except Exception as e3:
                    raise RuntimeError(
                        "本机未找到可用的浏览器, 且 Chromium 自动安装未成功; "
                        "尝试过程: %s | %s | %s"
                        % (str(e1)[:120], str(e2)[:120], str(e3)[:200]))

    def _launch_channel(self, channel):
        return self._pw.chromium.launch(
            headless=False, channel=channel, args=["--start-maximized"])

    def _driver_dir(self):
        """playwright 驱动目录 ( 打包版在 _internal, 开发版在 site-packages )"""
        base = getattr(sys, "_MEIPASS", None)
        if base:
            d = os.path.join(base, "playwright", "driver")
            if os.path.isdir(d):
                return d
        import playwright
        return os.path.join(os.path.dirname(playwright.__file__), "driver")

    def _auto_install_and_launch(self):
        """用包内 playwright 驱动自带的 node 执行 `install chromium`,
        下载到用户目录 ( %LOCALAPPDATA%/ms-playwright ), 与 launch() 的
        查找路径一致; 全程不需要目标机有 Python。"""
        if self._auto_install_tried:
            raise RuntimeError("Chromium 自动安装本次运行已尝试过且未成功")
        self._auto_install_tried = True
        import subprocess
        d = self._driver_dir()
        node = os.path.join(d, "node.exe" if os.name == "nt" else "node")
        cli = os.path.join(d, "package", "cli.js")
        if not (os.path.isfile(node) and os.path.isfile(cli)):
            raise RuntimeError("找不到内置驱动 (%s), 无法自动安装" % d)
        self._warn = "未找到系统浏览器, 正在自动下载 Chromium (约 150MB, 联网一次, 请耐心等待)..."
        try:
            r = subprocess.run([node, cli, "install", "chromium"],
                               capture_output=True, timeout=900)
        except subprocess.TimeoutExpired:
            raise RuntimeError("Chromium 自动下载超时 ( 15 分钟 ), 请检查网络后重试")
        if r.returncode != 0:
            tail = (r.stderr or b"").decode("utf-8", "ignore").strip()[-200:]
            raise RuntimeError("Chromium 自动安装失败 ( 请检查网络 ): %s" % tail)
        self._warn = ("系统未找到 Edge/Chrome, 已自动下载 Chromium (约 150MB, 仅此一次); "
                      "如需更快启动可在界面选择系统已装的浏览器")
        return self._pw.chromium.launch(headless=False, args=["--start-maximized"])

    def _goto_with_retry(self, url, attempts=2):
        """网络抖动 ( ERR_CONNECTION_CLOSED 等 ) 常见为瞬时失败, 重试一次"""
        import time
        last = None
        for i in range(attempts):
            if i:
                time.sleep(0.8)
            try:
                self._page.goto(url, wait_until="domcontentloaded", timeout=45000)
                return
            except Exception as e:
                last = e
        raise last

    def _on_new_page(self, page):
        """context 的 page 事件: 有新标签页打开时, 活动页切过去并置前。
        处理器异常会沿事件派发抛出, 必须全部吞掉。"""
        try:
            self._page = page
            try:
                page.bring_to_front()
            except Exception:
                pass
        except Exception:
            pass

    def _active_page(self):
        """当前活动页: 页被用户关掉时自动落到剩余的最后一个标签页"""
        pg = self._page
        if pg is not None:
            try:
                if not pg.is_closed():
                    return pg
            except Exception:
                pass
        try:
            pages = list(self._ctx.pages) if self._ctx else []
        except Exception:
            pages = []
        if pages:
            self._page = pages[-1]
            return self._page
        return None

    def _apply_mode(self, mode):
        """当前所有页面立即生效 + init_script 让后续新页面继承"""
        if not self._ctx:
            return
        try:
            self._ctx.add_init_script("window.__elementor_mode = %s;" % json.dumps(mode))
        except Exception:
            pass
        for pg in self._ctx.pages:
            try:
                pg.evaluate(_SET_MODE_ARG_JS, mode)
            except Exception:
                pass

    def _eval(self, js):
        pg = self._active_page()
        if not pg:
            raise RuntimeError("page not ready")
        return pg.evaluate(js)

    def _eval_arg(self, js, arg):
        pg = self._active_page()
        if not pg:
            raise RuntimeError("page not ready")
        return pg.evaluate(js, arg)

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
        self._ctx = None
        self._page = None
        self._pw = None
