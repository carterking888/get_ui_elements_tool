# -*- coding: utf-8 -*-
"""bundle_browsers.py —— 把 Playwright 的 Chromium 预置进 playwright 包内

打包机执行 `playwright install chromium` 后, 浏览器位于平台缓存目录
(Windows: %LOCALAPPDATA%\\ms-playwright / macOS: ~/Library/Caches/ms-playwright)。
本脚本把 chromium* 目录拷进 site-packages 的
playwright/driver/package/.local-browsers/, 配合运行时
PLAYWRIGHT_BROWSERS_PATH=0, 打出的包在目标机零环境下即可打开页面。

幂等: 已存在 .local-browsers/chromium* 时跳过。
"""
import glob
import os
import shutil
import sys


def browsers_cache_dir():
    """playwright install 的浏览器缓存目录 (跨平台)"""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local")
        return os.path.join(base, "ms-playwright")
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Caches/ms-playwright")
    return os.path.expanduser("~/.cache/ms-playwright")


def playwright_pkg_dir():
    import playwright
    return os.path.dirname(os.path.abspath(playwright.__file__))


def main():
    src_root = browsers_cache_dir()
    dst_root = os.path.join(playwright_pkg_dir(), "driver", "package", ".local-browsers")

    srcs = sorted(glob.glob(os.path.join(src_root, "chromium*")))
    if not srcs:
        sys.stderr.write("[错误] %s 下没有 chromium*, 请先执行: python -m playwright install chromium\n" % src_root)
        return 1

    have = set(glob.glob(os.path.join(dst_root, "chromium*")))
    todo = [s for s in srcs if os.path.join(dst_root, os.path.basename(s)) not in have]
    if not todo:
        print("已内置 %d 个 chromium 目录, 跳过" % len(have))
        return 0

    os.makedirs(dst_root, exist_ok=True)
    for s in todo:
        name = os.path.basename(s)
        print("内置浏览器: %s -> .local-browsers/%s" % (s, name))
        shutil.copytree(s, os.path.join(dst_root, name), dirs_exist_ok=True)

    total = sum(
        len(files) for _, _, files in os.walk(dst_root)
    )
    print(".local-browsers 就绪: %d 个目录, %d 个文件" % (len(glob.glob(os.path.join(dst_root, 'chromium*'))), total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
