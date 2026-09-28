# -*- coding: utf-8 -*-
"""_test_mode_e2e.py —— 拾取/浏览模式切换 真实浏览器端到端验证
用法: python _test_mode_e2e.py   (需 playwright chromium)
覆盖: 拾取模式拦截采集 / 浏览模式放行导航 / 模式跨导航继承 / 新页面自动注入 / 切回恢复
"""
import sys
import os
import time
import threading
import http.server

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from core.engine_playwright import PlaywrightEngine  # noqa: E402


def ev(e, js, timeout=15):
    return e._executor.submit(lambda: e._eval(js)).result(timeout=timeout)


def main():
    ok = fail = 0

    def check(name, cond, extra=''):
        nonlocal ok, fail
        if cond:
            ok += 1
            print('PASS', name)
        else:
            fail += 1
            print('FAIL', name, extra)

    P1 = "<html><body><a id='go' href='/page2' style='display:inline-block;padding:20px;font-size:20px'>TO PAGE 2</a></body></html>"
    P2 = "<html><body><h1 id='p2'>PAGE TWO</h1><a id='back' href='/' style='display:inline-block;padding:20px'>BACK</a></body></html>"

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body = P2 if self.path == '/page2' else P1
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(body.encode())

    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    e = PlaywrightEngine()
    e.open("http://127.0.0.1:%d/" % port)
    e.ensure_picker()
    time.sleep(0.8)

    def pos(sel):
        return ev(e, "() => { const a = document.querySelector('%s'); if (!a) return null;"
                     " const rc = a.getBoundingClientRect();"
                     " return { x: rc.left+rc.width/2, y: rc.top+rc.height/2 }; }" % sel)

    def click_at(p):
        e._executor.submit(lambda: e._page.mouse.click(p['x'], p['y'])).result(timeout=15)

    # 拾取模式: 拦截
    p = pos("#go")
    click_at(p)
    time.sleep(0.6)
    st = ev(e, "() => ({p: (window.__elementor_picks||[]).length, u: location.pathname})")
    check('拾取模式: 采集成功', st['p'] == 1, st)
    check('拾取模式: 未跳转', st['u'] == '/', st)

    # 浏览模式: 放行导航
    r = e.set_mode('browse')
    check('set_mode(browse)', r.get('ok') and r.get('mode') == 'browse', r)
    time.sleep(0.3)
    click_at(p)
    time.sleep(1.5)
    st2 = ev(e, "() => ({p: (window.__elementor_picks||[]).length, u: location.pathname,"
                  " m: window.__elementor_get_mode(), inst: !!window.__elementor_installed})")
    check('浏览模式: 已跳转到 /page2', st2['u'] == '/page2', st2)
    check('浏览模式: 未采集', st2['p'] == 0, st2)
    check('浏览模式: 模式跨导航继承', st2['m'] == 'browse', st2)
    check('浏览模式: 新页面拾取器自动注入', st2['inst'], st2)

    # 浏览模式继续导航回首页
    e._executor.submit(lambda: e._page.bring_to_front()).result(timeout=10)
    click_at(pos("#back"))
    time.sleep(1.2)
    check('浏览模式: 导航回 /', ev(e, "() => location.pathname") == '/')

    # 切回拾取: 恢复采集
    e.set_mode('pick')
    time.sleep(0.3)
    click_at(pos("#go"))
    time.sleep(0.6)
    st3 = ev(e, "() => ({p: (window.__elementor_picks||[]).length, u: location.pathname})")
    check('切回拾取: 恢复采集', st3['p'] >= 1, st3)
    check('切回拾取: 未跳转', st3['u'] == '/', st3)

    srv.shutdown()
    e.close()
    print('RESULT: pass=%d fail=%d' % (ok, fail))
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()
