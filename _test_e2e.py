# -*- coding: utf-8 -*-
"""_test_e2e.py —— PlaywrightEngine 真实浏览器端到端拾取验证 ( 会短暂弹出 Chromium 窗口 )"""
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

from core import locator
from core.engine_playwright import PlaywrightEngine

PAGE = (
    "data:text/html;charset=utf-8,<html><head><title>E2E</title></head><body>"
    "<ul class='product-list'>"
    "<li class='product-card'><a class='product-title' href='/p/1' data-sku='A1023'>简约格纹大衣</a></li>"
    "<li class='product-card'><a id='target' class='product-title' href='/p/2' data-sku='A1024'>羊毛混纺针织衫</a></li>"
    "</ul>"
    "<input id='keyword' name='keyword' type='text' placeholder='搜索商品'>"
    "</body></html>"
)

PICK_JS = """
() => {
  const el = document.getElementById('target');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
  return (window.__elementor_picks || []).length;
}
"""

def main():
    e = PlaywrightEngine()
    print("open:", e.open(PAGE))
    st = e.status()
    assert st["running"], st
    print("status:", st)

    ok = e.ensure_picker()
    print("picker installed:", ok)
    assert ok

    n = e._executor.submit(lambda: e._eval(PICK_JS)).result(timeout=15)
    print("synthetic picks:", n)
    assert n >= 1

    picks = e.drain()
    print("drained:", len(picks))
    assert len(picks) >= 1

    rec = locator.enrich(dict(picks[0]))
    print("tag:", rec["tag"], "| best_css:", rec["best_css"], "| best_xpath:", rec["best_xpath"])
    assert rec["tag"] == "a" and "target" in rec["best_css"]

    v1 = e.validate("css", rec["best_css"])
    v2 = e.validate("xpath", rec["best_xpath"])
    print("validate css:", v1, "| xpath:", v2)
    assert v1["count"] == 1 and v2["count"] == 1

    v3 = e.validate("css", "a.product-title")
    print("validate 多匹配:", v3)
    assert v3["count"] == 2

    e.close()
    print("E2E_ALL_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
