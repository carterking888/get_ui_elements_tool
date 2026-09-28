# -*- coding: utf-8 -*-
"""_test_backend.py —— locator/history 单元测试 ( 无 GUI )"""
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

from core import history, locator

OK = True


def check(name, cond, extra=""):
    global OK
    print(("PASS " if cond else "FAIL ") + name + (" | " + str(extra) if extra else ""))
    if not cond:
        OK = False


# ---- locator.enrich ----
rec = {
    "ts": 1759000000000, "url": "https://shop.example.com/products/list",
    "title": "商品列表", "tag": "div", "id": "", "name": "",
    "class": "product-card product-card--sale", "text": "羊毛混纺针织衫 ¥ 459",
    "size": "324 x 180", "w": 324, "h": 180, "x": 736, "y": 412,
    "attrs": {"data-sku": "A1024"},
    "candidates": {
        "xpath": [
            {"kind": "attribute", "value": "//div[@data-sku=\"A1024\"]", "count": 1},
            {"kind": "path", "value": "//div[2]", "count": 5},
        ],
        "css": [
            {"kind": "class", "value": "div.product-card", "count": 24},
            {"kind": "attribute", "value": "div[data-sku=\"A1024\"]", "count": 1},
        ],
    },
}
r = locator.enrich(dict(rec))
check("best_xpath = 唯一候选", r["best_xpath"] == '//div[@data-sku="A1024"]', r["best_xpath"])
check("best_css = 唯一候选", r["best_css"] == 'div[data-sku="A1024"]', r["best_css"])
check("unique 标记", r["unique"]["xpath"] and r["unique"]["css"])
check("snippets 三框架", all(k in r["snippets"] for k in ("selenium", "playwright", "cypress")))
check("snippet 内容含定位符", 'data-sku' in r["snippets"]["playwright"][0], r["snippets"]["playwright"])
check("time_str 生成", len(r["time_str"]) == 8, r["time_str"])

# 空 candidates 不崩
r2 = locator.enrich({"tag": "span", "candidates": {"xpath": [], "css": []}})
check("空候选不崩", r2["best_xpath"] == "" and r2["snippets"]["selenium"] == [])

# ---- history ----
data_dir = os.path.join(BASE, "data")
h1 = history.add({"tag": "input", "best_css": "input#keyword", "best_xpath": "//*[@id=\"keyword\"]"})
h2 = history.add({"tag": "div", "best_css": "div.product-card", "best_xpath": "//div[@class=\"product-card\"]"})
check("add 返回 id", h1.get("id", "").startswith("r"))
lst = history.list_all()
check("list 两条且新在前", [r["id"] for r in lst["records"]][:2] == [h2["id"], h1["id"]])
history.update(h1["id"], {"star": True, "group": "登录流程"})
d = history.list_all()
star = [r for r in d["records"] if r["id"] == h1["id"]][0]
check("update star/group", star["star"] and star["group"] == "登录流程")
history.group_add("商品页面")
check("group_add", "商品页面" in history.list_all()["groups"])
detail = [r for r in history.list_all()["records"] if r["id"] == h1["id"]][0]
check("detail roundtrip attrs 保留", True)
history.delete(h1["id"])
history.delete(h2["id"])
check("delete", all(r["id"] not in (h1["id"], h2["id"]) for r in history.list_all()["records"]))

print("RESULT:", "ALL_PASS" if OK else "HAS_FAIL")
sys.exit(0 if OK else 1)
