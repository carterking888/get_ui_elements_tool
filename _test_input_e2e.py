# -*- coding: utf-8 -*-
"""_test_input_e2e.py —— 拾取模式下输入类元素「采集+放行」端到端验证
需已安装 playwright chromium。用法: python _test_input_e2e.py
"""
import sys, os, time, threading, http.server
BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from core.engine_playwright import PlaywrightEngine


def ev(e, js, timeout=15):
    return e._executor.submit(lambda: e._eval(js)).result(timeout=timeout)


ok = fail = 0


def check(name, cond, extra=''):
    global ok, fail
    if cond:
        ok += 1
        print('PASS', name)
    else:
        fail += 1
        print('FAIL', name, extra)


P = "<html><body><input id='q' placeholder='Search'><button id='go'>Go</button></body></html>"


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(P.encode())


def main():
    global ok, fail
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    e = PlaywrightEngine()
    e.open("http://127.0.0.1:%d/" % port)
    e.ensure_picker()
    time.sleep(0.8)

    p = ev(e, "() => { const rc = document.getElementById('q').getBoundingClientRect(); return { x: rc.left+rc.width/2, y: rc.top+rc.height/2 }; }")
    check('找到输入框', bool(p), p)

    e._executor.submit(lambda: e._page.mouse.click(p['x'], p['y'])).result(timeout=15)
    time.sleep(0.5)
    st = ev(e, "() => ({ picks: (window.__elementor_picks||[]).length, tag: (window.__elementor_picks[0]||{}).tag, focused: document.activeElement && document.activeElement.id })")
    check('拾取模式: 输入框被采集', st['picks'] == 1 and st['tag'] == 'input', st)
    check('拾取模式: 输入框已聚焦', st['focused'] == 'q', st)

    e._executor.submit(lambda: e._page.keyboard.type('hello picker')).result(timeout=15)
    v = ev(e, "() => document.getElementById('q').value")
    check('拾取模式: 直接输入成功', v == 'hello picker', repr(v))

    e._executor.submit(lambda: e._page.keyboard.press('Escape')).result(timeout=10)
    time.sleep(0.3)
    e._executor.submit(lambda: e._page.mouse.click(p['x'], p['y'])).result(timeout=15)
    time.sleep(0.5)
    st2 = ev(e, "() => (window.__elementor_picks||[]).length")
    check('输入框内 Esc 后仍可拾取', st2 >= 2, st2)

    pb = ev(e, "() => { const rc = document.getElementById('go').getBoundingClientRect(); return { x: rc.left+rc.width/2, y: rc.top+rc.height/2 }; }")
    e._executor.submit(lambda: e._page.mouse.click(pb['x'], pb['y'])).result(timeout=15)
    time.sleep(0.5)
    st3 = ev(e, "() => ({ n: (window.__elementor_picks||[]).length, tag: (window.__elementor_picks[window.__elementor_picks.length-1]||{}).tag })")
    check('非输入类仍拦截采集', st3['n'] >= 3 and st3['tag'] == 'button', st3)

    srv.shutdown()
    e.close()
    print('RESULT: pass=%d fail=%d' % (ok, fail))
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
