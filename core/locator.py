# -*- coding: utf-8 -*-
"""locator.py —— 拾取记录后处理: 候选定位符排序 + 多框架代码片段生成"""
import time


def _best(cands):
    """从候选里取 count==1 的第一条, 没有 then count>0 最短"""
    if not cands:
        return None
    unique = [c for c in cands if c.get("count") == 1]
    if unique:
        return unique[0]
    positive = [c for c in cands if c.get("count", 0) > 0]
    if positive:
        return sorted(positive, key=lambda c: (len(c["value"]), c.get("count", 999)))[0]
    return cands[0]


def enrich(record):
    """给拾取记录补齐摘要字段: best 定位符 / 唯一性 / 片段"""
    cands = record.get("candidates") or {"xpath": [], "css": []}
    bx = _best(cands.get("xpath", []))
    bc = _best(cands.get("css", []))
    id_css = next((c for c in cands.get("css", []) if c.get("kind") == "id"), None)
    name_attr = record.get("name") or ""

    record["best_xpath"] = bx["value"] if bx else ""
    record["best_css"] = bc["value"] if bc else ""
    record["unique"] = {
        "xpath": bool(bx and bx.get("count") == 1),
        "css": bool(bc and bc.get("count") == 1),
        "id": bool(id_css and id_css.get("count") == 1),
        "name": False,  # name 属性无法离线断言唯一, 由前端实时校验
    }
    record["snippets"] = build_snippets(record)
    record["time_str"] = time.strftime("%H:%M:%S", time.localtime(record.get("ts", time.time() * 1000) / 1000))
    return record


def build_snippets(record):
    xp = record.get("best_xpath") or ""
    css = record.get("best_css") or ""
    action = "click()"
    if record.get("tag") == "input" and record.get("attrs", {}).get("type") not in ("button", "submit"):
        action = "fill('...')"
    out = {"selenium": [], "playwright": [], "cypress": []}
    if css:
        out["selenium"].append("driver.find_element(By.CSS_SELECTOR, '%s').%s" % (css, action))
        out["playwright"].append("page.locator('%s').%s" % (css, action))
        out["cypress"].append("cy.get('%s').%s" % (css, action.replace("fill('...')", "type('...')")))
    if xp:
        out["selenium"].append("driver.find_element(By.XPATH, '%s').%s" % (xp, action))
        out["playwright"].append("page.locator('xpath=%s').%s" % (xp, action))
        out["cypress"].append("cy.xpath('%s').%s" % (xp, action.replace("fill('...')", "type('...')")))
    return out


def summarize(record):
    """列表页摘要"""
    return {
        "id": record.get("id"),
        "tag": record.get("tag"),
        "ident": (record.get("best_css") or record.get("best_xpath") or record.get("tag", ""))[:48],
        "text": record.get("text", "")[:30],
        "time_str": record.get("time_str", ""),
        "url": record.get("url", ""),
        "group": record.get("group", ""),
        "star": record.get("star", False),
    }
