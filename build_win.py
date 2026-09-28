# -*- coding: utf-8 -*-
"""build_win.py —— Windows 一键打包: PyInstaller (element_picker.spec) + 分发 zip

用法:
    python build_win.py                 # 完整版: 内置 Chromium, 产物 dist/element_picker_v<版本>_win64.zip
    python build_win.py --lite          # 轻量版: 不内置 Chromium (~60MB), 用系统 Edge/Chrome
    python build_win.py --no-zip        # 只打包不打 zip
    python build_win.py --distpath X    # 指定 PyInstaller 输出目录 (默认 dist; 本地反复重打时
                                        #   换新目录可规避"删除旧输出"阻塞, 分发 zip 仍输出到 dist/)

前置:
    pip install -r requirements.txt pyinstaller
    python -m playwright install chromium   # 浏览器由 bundle_browsers.py 内置进包 (完整版)
"""
import os
import re
import subprocess
import sys
import zipfile

BASE = os.path.dirname(os.path.abspath(__file__))
APP_NAME = "element_picker"


def app_version():
    src = open(os.path.join(BASE, "app.py"), encoding="utf-8").read()
    m = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', src)
    if not m:
        sys.stderr.write("[错误] app.py 里找不到 APP_VERSION\n")
        sys.exit(1)
    return m.group(1)


def main():
    make_zip = "--no-zip" not in sys.argv
    lite = "--lite" in sys.argv
    dist_name = "dist"
    if "--distpath" in sys.argv:
        dist_name = sys.argv[sys.argv.index("--distpath") + 1]
    dist_out = os.path.join(BASE, dist_name)          # PyInstaller 输出目录
    work_out = os.path.join(BASE, dist_name + "_work")  # workpath 同步走独立目录, 重打不冲突
    dist_zip = os.path.join(BASE, "dist")             # 分发 zip 统一放 dist/
    os.makedirs(dist_zip, exist_ok=True)
    ver = app_version()
    suffix = "_lite" if lite else ""
    print("==> 版本: v%s%s" % (ver, " (Lite 轻量版)" if lite else ""))

    if lite:
        print("==> 1/2 跳过 Chromium 内置 (Lite 版启动时自动改用系统 Chrome/Edge)")
    else:
        print("==> 1/3 内置 Chromium (playwright .local-browsers)")
        r = subprocess.run([sys.executable, os.path.join(BASE, "bundle_browsers.py")])
        if r.returncode != 0:
            sys.exit(r.returncode)

    print("==> PyInstaller 打包 (onedir, windowed)")
    env = dict(os.environ)
    if lite:
        env["ELEMENT_PICKER_LITE"] = "1"   # spec 据此剔除内置 Chromium
    elif "ELEMENT_PICKER_LITE" in env:
        del env["ELEMENT_PICKER_LITE"]

    # Lite: 把 venv 里的 .local-browsers 移出 driver/package —— PyInstaller 的 playwright
    # hook 会递归收集 driver/package 下的一切 (连改名目录都收), 必须挪到扫描范围之外
    renamed = None
    if lite:
        import playwright
        _pkg = os.path.dirname(playwright.__file__)
        _lb = os.path.join(_pkg, "driver", "package", ".local-browsers")
        if os.path.isdir(_lb):
            _venv_root = os.path.dirname(os.path.dirname(os.path.dirname(_pkg)))
            _hold = os.path.join(_venv_root, "lite_browsers_holding")
            renamed = (_lb, _hold)
            os.rename(_lb, _hold)
            print("    [lite] 已临时移走 venv 内置浏览器 -> %s" % _hold)
    try:
        r = subprocess.run([sys.executable, "-m", "PyInstaller",
                            os.path.join(BASE, "element_picker.spec"),
                            "--noconfirm", "--clean", "--distpath", dist_out,
                            "--workpath", work_out], env=env)
    finally:
        if renamed:
            try:
                os.rename(renamed[1], renamed[0])
                print("    [lite] venv 内置浏览器已还原")
            except OSError as e:
                sys.stderr.write("[警告] 还原 %s 失败: %s (手工改回即可)\n" % (renamed[1], e))
    if r.returncode != 0:
        sys.stderr.write("[错误] PyInstaller 打包失败\n")
        sys.exit(r.returncode)

    app_dir = os.path.join(dist_out, APP_NAME)
    exe = os.path.join(app_dir, "%s.exe" % APP_NAME)
    if not os.path.isfile(exe):
        sys.stderr.write("[错误] 未生成 %s\n" % exe)
        sys.exit(1)

    # 自检: 完整版浏览器必须进包; Lite 版必须没有浏览器 (防止 dist 残留混入)
    lb = os.path.join(app_dir, "_internal", "playwright", "driver", "package", ".local-browsers")
    n = len([d for d in (os.listdir(lb) if os.path.isdir(lb) else []) if d.startswith("chromium")])
    if lite:
        if n > 0:
            sys.stderr.write("[错误] Lite 版里混入了 Chromium (查: %s), 请清理 dist 后重打\n" % lb)
            sys.exit(1)
        print("    Lite 自检: 包内无 Chromium, OK")
    else:
        if n == 0:
            sys.stderr.write("[错误] 包内没有内置 Chromium (查: %s)\n" % lb)
            sys.exit(1)
        print("    包内 Chromium: %d 个目录" % n)

    # 自检: Selenium 引擎及其 Selenium Manager 必须进包 —— 目标机没有 Python 环境,
    # driver 自动匹配下载全靠包内这个独立 exe ( 缺了打包版的 Selenium 引擎就是死的 )
    sm = os.path.join(app_dir, "_internal", "selenium", "webdriver", "common",
                      "windows", "selenium-manager.exe")
    if not os.path.isfile(sm):
        sys.stderr.write("[错误] 包内缺少 selenium-manager.exe (查: %s)\n"
                         "       Selenium 引擎在目标机将无法自动下载 driver; "
                         "请 pip install selenium 后重打\n" % sm)
        sys.exit(1)
    print("    包内 selenium-manager.exe: OK")

    if not make_zip:
        print("==> 完成 (--no-zip): %s" % app_dir)
        return

    print("==> 生成分发 zip")
    zip_path = os.path.join(BASE, "dist", "%s_v%s_win64%s.zip" % (APP_NAME, ver, suffix))
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, _, files in os.walk(app_dir):
            for f in files:
                full = os.path.join(root, f)
                zf.write(full, os.path.relpath(full, os.path.dirname(app_dir)))
    size_mb = os.path.getsize(zip_path) / 1024.0 / 1024.0
    print("完成: %s (%.1f MB)" % (zip_path, size_mb))
    print("使用: 解压后双击 %s.exe%s" % (APP_NAME, " (无系统浏览器时自动下载 Chromium)" if lite else ""))


if __name__ == "__main__":
    main()
