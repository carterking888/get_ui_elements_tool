# -*- coding: utf-8 -*-
"""history.py —— 本地拾取历史存储 (data/history.json)"""
import json
import os
import threading
import time
import uuid

_LOCK = threading.Lock()
_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
_FILE = os.path.join(_DIR, "history.json")

_DEFAULT = {"records": [], "groups": [], "seq": 1}


def _load():
    try:
        with open(_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = dict(_DEFAULT)
    for k, v in _DEFAULT.items():
        data.setdefault(k, json.loads(json.dumps(v)))
    return data


def _save(data):
    os.makedirs(_DIR, exist_ok=True)
    tmp = _FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _FILE)


def list_all():
    with _LOCK:
        return _load()


def add(record):
    with _LOCK:
        data = _load()
        rec = dict(record)
        rec["id"] = "r" + uuid.uuid4().hex[:8]
        rec["saved_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        rec.setdefault("group", "")
        rec.setdefault("star", False)
        data["records"].insert(0, rec)
        if len(data["records"]) > 500:
            data["records"] = data["records"][:500]
        _save(data)
        return rec


def delete(rid):
    with _LOCK:
        data = _load()
        data["records"] = [r for r in data["records"] if r.get("id") != rid]
        _save(data)
        return True


def clear():
    with _LOCK:
        data = _load()
        data["records"] = []
        _save(data)
        return True


def update(rid, patch):
    with _LOCK:
        data = _load()
        for r in data["records"]:
            if r.get("id") == rid:
                r.update(patch)
                _save(data)
                return r
        return None


def group_add(name):
    with _LOCK:
        data = _load()
        if name not in data["groups"]:
            data["groups"].append(name)
            _save(data)
        return data["groups"]


def group_delete(name):
    with _LOCK:
        data = _load()
        data["groups"] = [g for g in data["groups"] if g != name]
        for r in data["records"]:
            if r.get("group") == name:
                r["group"] = ""
        _save(data)
        return data["groups"]
