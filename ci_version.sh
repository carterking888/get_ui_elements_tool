#!/usr/bin/env bash
# 版本号解析脚本（CI 与本地通用）
#
# 作用：算出「本次构建」要用的版本号，并把 app.py 的 APP_VERSION 改成它。
#   - 应用内显示的版本、产物 zip 的文件名、GitHub tag、Release 标题 —— 全部同源
#   - 只改工作区文件，不回写仓库；仓库里的 APP_VERSION 只是「一个 tag 都没有」时的兜底基准
#
# 规则（按优先级）：
#   1) 传了参数           -> 用参数（CI 的 version job 先算一次，其余 job 复用它）
#   2) 本次是 push tag    -> 用 tag 本身（正式发版不递增）
#   3) 存在 v* tag        -> 取最新 tag，patch +1    例：v1.0.0 -> 1.0.1
#   4) 一个 tag 都没有    -> app.py 现有 APP_VERSION，patch +1
#
# 用法：
#   VER=$(bash ci_version.sh)        # 自动递增
#   VER=$(bash ci_version.sh 1.1.0)  # 指定版本
set -euo pipefail

EXPLICIT="${1:-}"

[ -f app.py ] || { echo "[错误] 找不到 app.py，请在项目根目录执行" >&2; exit 1; }

read_app_version() {
  sed -nE 's/^APP_VERSION[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' app.py | head -1
}
is_semver() { echo "$1" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; }
is_version() { echo "$1" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([.+-][0-9A-Za-z.+-]+)?$'; }

BASE=""
if [ -n "$EXPLICIT" ]; then
  VER="$EXPLICIT"
  echo "  版本来源: 外部指定（同一次运行内复用）" >&2
elif [ "${GITHUB_REF_TYPE:-}" = "tag" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
  VER="${GITHUB_REF_NAME#v}"
  echo "  版本来源: 正式发版 tag $GITHUB_REF_NAME（不递增）" >&2
else
  LATEST=$(git tag -l 'v[0-9]*' --sort=-v:refname 2>/dev/null | head -1 || true)
  BASE="${LATEST#v}"
  BASE="${BASE%%-*}"
  if ! is_semver "$BASE"; then
    BASE="$(read_app_version)"
    [ -n "$BASE" ] || BASE="0.0.0"
  fi
  is_semver "$BASE" || BASE="0.0.0"
  VER=$(echo "$BASE" | awk -F. '{printf "%s.%s.%d", $1, $2, $3 + 1}')
  echo "  版本来源: 最新 tag ${LATEST:-（无，用 app.py 兜底）} -> patch +1" >&2
fi

is_version "$VER" || { echo "[错误] 版本号形态异常：$VER（应形如 1.0.1）" >&2; exit 1; }

# 写回 app.py。用「临时文件 + mv」：macOS 的 BSD sed 与 Linux 的 GNU sed 对 -i 参数要求不同
sed -E "s/^(APP_VERSION[[:space:]]*=[[:space:]]*)\"[^\"]+\"/\1\"${VER}\"/" app.py > app.py.versiontmp
mv app.py.versiontmp app.py
grep -qE "^APP_VERSION[[:space:]]*=[[:space:]]*\"${VER}\"" app.py \
  || { echo "[错误] 改写 app.py 的 APP_VERSION 失败" >&2; exit 1; }

echo "  本次构建版本: $VER" >&2
echo "$VER"
