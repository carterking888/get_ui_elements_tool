#!/bin/bash
# build_mac.sh —— macOS 一键打包: venv -> 内置 Chromium -> PyInstaller .app -> 签名 -> 分发包
#
# 用法:
#   ./build_mac.sh            # 产出 dist/element_picker.app + zip
#   ./build_mac.sh --dmg      # 额外再打一个 dmg
#   ./build_mac.sh --lite     # 轻量版: 不内置 Chromium (~30MB), 启动时用系统 Chrome/Edge
#
# 前提:
#   1. 必须在 macOS 上跑 (PyInstaller 不能交叉编译, Windows 打不出 mac 产物)
#   2. Xcode Command Line Tools: xcode-select --install
#   3. 架构跟随本机 Python: M 系列 -> arm64, Intel -> x86_64
set -e

cd "$(dirname "$0")"

PY="${PY:-python3}"
VENV=".venv_mac"
ARCH="$(uname -m)"
MAKE_DMG=0
LITE=0
for arg in "$@"; do
    [ "$arg" = "--dmg" ] && MAKE_DMG=1
    [ "$arg" = "--lite" ] && LITE=1
done
NAME="element_picker"

echo "==> 0/6 环境检查"
if [ "$(uname -s)" != "Darwin" ]; then
    echo "[错误] 本脚本只能在 macOS 上运行。" >&2
    echo "       替代方案: GitHub Actions 的 mac runner (见 .github/workflows/release.yml)。" >&2
    exit 1
fi
command -v "$PY" >/dev/null || { echo "[错误] 找不到 $PY"; exit 1; }
if ! xcode-select -p >/dev/null 2>&1; then
    echo "[错误] 缺少 Xcode Command Line Tools, 请先执行: xcode-select --install"
    exit 1
fi
echo "    python : $($PY -V 2>&1)"
echo "    arch   : $ARCH  ($([ "$ARCH" = "arm64" ] && echo 'Apple Silicon' || echo 'Intel'))"

echo "==> 1/6 创建虚拟环境 $VENV"
if [ ! -x "$VENV/bin/python" ]; then
    "$PY" -m venv "$VENV"
fi
VPY="$VENV/bin/python"
"$VPY" -m pip install -q --upgrade pip setuptools wheel

echo "==> 2/6 安装依赖"
"$VPY" -m pip install -q -r requirements.txt
"$VPY" -m pip install -q "pyinstaller>=6.0"
# Pillow: spec 里 BUNDLE 的 icon 用 config/icon.ico, PyInstaller 需 Pillow 转 .icns
"$VPY" -m pip install -q "pillow>=10.0"

if [ "$LITE" = "1" ]; then
    echo "==> 3/6 跳过 Chromium 内置 (Lite 版启动时自动改用系统 Chrome/Edge)"
else
    echo "==> 3/6 下载并内置 Chromium (目标机零环境)"
    "$VPY" -m playwright install chromium
    "$VPY" bundle_browsers.py
fi

echo "==> 4/6 PyInstaller 打包 (.app bundle)"
if [ "$LITE" = "1" ]; then
    export ELEMENT_PICKER_LITE=1   # spec 据此剔除内置 Chromium
elif [ -n "$ELEMENT_PICKER_LITE" ]; then
    unset ELEMENT_PICKER_LITE
fi
# 打包前把 venv 里的 .local-browsers 移出 playwright hook 递归收集范围
# ( 实测 hook 会收集 driver/package 下的一切, 同目录改名 / spec 过滤都拦不住,
#   只能移到 venv 根目录断供 )。Lite 不需要浏览器; 完整版打完再拷进 .app。
LB_RENAMED=""
LB="$($VPY -c "import playwright,os;print(os.path.join(os.path.dirname(playwright.__file__),'driver','package','.local-browsers'))")"
LB_ORIG="$LB"
VENV_ROOT="$($VPY -c "import playwright,os;print(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(playwright.__file__)))))")"
if [ -d "$LB" ]; then
    mv "$LB" "$VENV_ROOT/lite_browsers_holding" && LB_RENAMED="$VENV_ROOT/lite_browsers_holding"
    echo "    已临时移走 venv 内置浏览器 ( hook 递归收集范围外 )"
fi
restore_lb() {
    if [ -n "$LB_RENAMED" ] && [ -d "$LB_RENAMED" ]; then
        mkdir -p "$(dirname "$LB_ORIG")"
        mv "$LB_RENAMED" "$LB_ORIG" \
          && echo "    venv 内置浏览器已还原" \
          || echo "    [warn] 浏览器目录还原失败, 手工从 lite_browsers_holding 移回: $LB_ORIG"
    fi
}
trap restore_lb EXIT
"$VPY" -m PyInstaller element_picker.spec --noconfirm --clean
APP="dist/$NAME.app"
EXE="$APP/Contents/MacOS/$NAME"
test -x "$EXE" || { echo "[错误] 未生成 $EXE"; exit 1; }

# macOS: Chromium 不让 PyInstaller 收集 —— 其对 Mach-O 的 ad-hoc 重签处理会在
# "Google Chrome for Testing" 主程序上失败 ( SystemError: Failed to process binary )。
# 打完包从暂存目录用普通 cp -R 拷进 .app ( 纯文件拷贝绕过二进制处理 );
# sys._MEIPASS 指向 Contents/Frameworks, 目标路径与运行时检测 /
# playwright driver 的浏览器发现路径完全对齐。
if [ "$LITE" != "1" ]; then
    LB_HOLD="$VENV_ROOT/lite_browsers_holding"
    LB_DEST="$APP/Contents/Frameworks/playwright/driver/package/.local-browsers"
    if [ -d "$LB_HOLD" ]; then
        echo "==> 4.5/6 拷贝内置 Chromium 进 .app ( 绕过 PyInstaller 二进制处理 )"
        mkdir -p "$(dirname "$LB_DEST")"
        # cp -R 保留符号链接 ( Chrome Frameworks 里有 Current -> A 软链 )
        cp -R "$LB_HOLD" "$LB_DEST"
        echo "    已拷贝: $(du -sh "$LB_DEST" | cut -f1)"
    else
        echo "[错误] 没找到浏览器暂存目录 $LB_HOLD, 先确认 bundle_browsers.py 已跑过"; exit 1
    fi
fi

# 自检: 完整版浏览器必须进包; Lite 版必须没有浏览器 (防止 dist 残留混入)
# 注意: playwright 的 mac Chromium 主程序叫 "Google Chrome for Testing",
# 只按 chromium-* 目录匹配, 不能用 -name "Chromium"
SO_N=$(find "$APP/Contents" -path "*playwright/driver/package/.local-browsers/chromium-*" -type d | wc -l | tr -d ' ')
if [ "$LITE" = "1" ]; then
    [ "$SO_N" = "0" ] || { echo "[错误] Lite 版里混入了 Chromium, 请清理 dist 后重打"; exit 1; }
    echo "    Lite 自检: 包内无 Chromium, OK"
else
    [ "$SO_N" -ge 1 ] || { echo "[错误] 包内没有内置 Chromium"; exit 1; }
fi
# 自检: Selenium Manager 必须进包 ( 目标机无 Python, driver 自动下载全靠它 )
SM_N=$(find "$APP/Contents" -path "*selenium/webdriver/common/*" -name "selenium-manager" | wc -l | tr -d ' ')
[ "$SM_N" -ge 1 ] || { echo "[错误] 包内缺少 selenium-manager, 请 pip install selenium 后重打"; exit 1; }
echo "    包内 selenium-manager: OK"

echo "==> 5/6 解除隔离属性 + ad-hoc 签名"
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --timestamp=none -s - "$APP" 2>/dev/null \
    && echo "    codesign: ad-hoc OK" \
    || echo "    [warn] codesign 失败 (不影响本机运行, 分发给他人会被告警)"

echo "==> 6/6 生成分发包"
VER=$("$VPY" -c "import re;print(re.search(r'APP_VERSION\s*=\s*\"([^\"]+)\"', open('app.py', encoding='utf-8').read()).group(1))")
SUFFIX=""
[ "$LITE" = "1" ] && SUFFIX="_lite"
echo "    版本: v$VER (取自 app.py APP_VERSION)"
rm -f "dist/${NAME}_v${VER}_macos_${ARCH}${SUFFIX}.zip"
# zip -y 保留符号链接: .app 内部依赖软链, 丢了会起不来
(cd dist && zip -qry "${NAME}_v${VER}_macos_${ARCH}${SUFFIX}.zip" "$NAME.app")
echo "    dist/${NAME}_v${VER}_macos_${ARCH}${SUFFIX}.zip  ($(du -sh "$APP" | cut -f1) -> $(du -h "dist/${NAME}_v${VER}_macos_${ARCH}${SUFFIX}.zip" | cut -f1))"

if [ "$MAKE_DMG" = "1" ]; then
    DMG="dist/${NAME}_v${VER}_macos_${ARCH}${SUFFIX}.dmg"
    rm -f "$DMG"
    if ! hdiutil create -volname "ElementPicker" -srcfolder "$APP" \
            -ov -format UDZO -fs HFS+ "$DMG" >/dev/null; then
        echo "[错误] dmg 生成失败 (hdiutil 非 0 退出)" >&2
        exit 1
    fi
    hdiutil verify "$DMG" >/dev/null 2>&1 \
        && echo "    dmg 校验通过" \
        || { echo "[错误] dmg 校验失败" >&2; exit 1; }
    echo "    $DMG ($(du -h "$DMG" | cut -f1))"
fi

echo
echo "完成。运行: open $APP"
echo "分发: 把 dist/${NAME}_v${VER}_macos_${ARCH}.zip 发给同芯片的 mac;"
echo "      对方解压后若提示「已损坏/无法打开」, 执行一次: xattr -cr $NAME.app"
echo "      若提示「无法验证开发者」: 右键 -> 打开 (仅首次)"
