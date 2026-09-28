# -*- mode: python ; coding: utf-8 -*-
"""element_picker.spec —— PyInstaller 打包配置

Windows: onedir + element_picker.exe            (build_win.py 调用)
macOS:   onedir + element_picker.app bundle     (build_mac.sh 调用)

内置内容:
  - web/          前端资源 (H5/CSS/JS)
  - config/       应用图标
  - playwright    拾取引擎驱动 (bundle_browsers.py 会把 Chromium 预置进
                  playwright/driver/package/.local-browsers/, 运行时
                  PLAYWRIGHT_BROWSERS_PATH=0 即可在包内找到, 目标机零环境)
"""
import os
import re
import sys

from PyInstaller.utils.hooks import collect_all

BASE = SPECPATH  # PyInstaller 注入: spec 文件所在目录

APP_NAME = 'element_picker'
APP_VERSION = re.search(
    r'APP_VERSION\s*=\s*"([^"]+)"',
    open(os.path.join(BASE, 'app.py'), encoding='utf-8').read(),
).group(1)

ICON_ICO = os.path.join(BASE, 'config', 'icon.ico')
ICON_PNG = os.path.join(BASE, 'config', 'icon.png')

datas = [
    (os.path.join(BASE, 'web'), 'web'),
    (os.path.join(BASE, 'core', 'picker.js'), 'core'),
    (ICON_ICO, 'config'),
    (ICON_PNG, 'config'),
]
binaries = []
hiddenimports = []

# playwright / selenium / webview 都是函数内延迟导入, 静态分析看不到, 全量收集
for pkg in ('playwright', 'selenium', 'webview'):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# Lite 轻量版 ( ELEMENT_PICKER_LITE=1, 由 build_win.py --lite / build_mac.sh --lite 设置 ):
# 从 collect_all 结果里剔除 bundle_browsers.py 预置进 venv 的 Chromium
# ( playwright/driver/package/.local-browsers ), 启动时改用系统 Chrome/Edge
LITE = os.environ.get('ELEMENT_PICKER_LITE', '') == '1'
if LITE:
    def _is_bundled_browser(entry):
        dest = entry[1].replace('\\', '/')
        return '.local-browsers' in dest
    n0 = len(datas) + len(binaries)
    datas = [e for e in datas if not _is_bundled_browser(e)]
    binaries = [e for e in binaries if not _is_bundled_browser(e)]  # Chromium 的 dll 会进 binaries
    print('[spec] Lite 模式: 剔除内置 Chromium %d 项 (datas+binaries), 剩 %d 项'
          % (n0 - len(datas) - len(binaries), len(datas) + len(binaries)))

if sys.platform == 'win32':
    # pywebview Windows 后端 (EdgeChromium/WebView2) 依赖 pythonnet
    for pkg in ('clr_loader', 'pythonnet'):
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    hiddenimports += [
        'webview.platforms.edgechromium',
        'webview.platforms.winforms',
    ]
else:
    hiddenimports += ['webview.platforms.cocoa']

a = Analysis(
    [os.path.join(BASE, 'app.py')],
    pathex=[BASE],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=APP_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    icon=ICON_ICO if sys.platform == 'win32' else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name=APP_NAME,
)

if sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name='%s.app' % APP_NAME,
        icon=ICON_ICO,  # PyInstaller 借助 Pillow 自动转 .icns
        bundle_identifier='com.elementpicker.app',
        info_plist={
            'CFBundleDisplayName': 'ElementPicker',
            'CFBundleName': APP_NAME,
            'CFBundleShortVersionString': APP_VERSION,
            'CFBundleVersion': APP_VERSION,
            'NSHighResolutionCapable': True,
            'LSMinimumSystemVersion': '10.13',
        },
    )
