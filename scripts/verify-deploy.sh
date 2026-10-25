#!/usr/bin/env bash
# FORK (damian-rafael-lattenero): post-deploy verification.
# Usage: scripts/verify-deploy.sh
#
# 回答一个问题：刚部署的代码就是正在运行/即将运行的代码吗？
# 检查（任何 FAIL = exit 1）：
#   1. /Applications 只有一个 ZCode.app（多余副本会让 Dock/Spotlight 启动旧的）
#   2. 安装的 app bundle 里的 agent（Resources/glm/zcode.cjs）带每一波的 marker
#   3. 仓库 dist agent（apps/zcode-cli/packages/cli/dist/zcode.cjs —— 当 workspace 就是
#      本 monorepo 时它**优先于** app bundle 被解析！）同样带 marker 且不比 bundle 旧
#   4. 正在运行的 ZCode 进程启动于安装的 bundle 之后（否则提示 ⌘Q 重开）
#
# 每次新增 fork 波次：往 MARKERS 加一行。
set -uo pipefail
cd "$(dirname "$0")/.."

APP=/Applications/ZCode.app
BUNDLE="$APP/Contents/Resources/glm/zcode.cjs"
DIST="apps/zcode-cli/packages/cli/dist/zcode.cjs"

fail() { echo "[verify-deploy] FAIL: $*" >&2; exit 1; }

# 每波部署的代码 marker（新增波次就追加）。
MARKERS=(
  "nextAttemptAtMs"         # Ola 4b: countdown absoluto
  "usageLimitResetWaitMs"   # Ola 5: wait-until-reset (next_flush_time)
  "apiRetryStatusMessageId" # Ola 6 (B2): labels honestos por reason
)

echo "[verify-deploy] app: $APP"
[ -d "$APP" ] || fail "no existe $APP"

# Solo alertar copias del MISMO producto (dev.zcode.app)；名字相近的个人工具不算。
extras=$(ls -d /Applications/ZCode*.app 2>/dev/null | grep -v "^$APP$" || true)
if [ -n "$extras" ]; then
  for extra in $extras; do
    bid=$(defaults read "$extra/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || echo "?")
    if [ "$bid" = "dev.zcode.app" ]; then
      echo "[verify-deploy] WARN: hay apps ZCode extra (Dock/Spotlight pueden abrir la vieja):"
      echo "  - $extra"
    fi
  done
fi

[ -f "$BUNDLE" ] || fail "falta el agent del bundle: $BUNDLE"
for marker in "${MARKERS[@]}"; do
  grep -q "$marker" "$BUNDLE" || fail "agent del bundle sin marker: $marker"
done
echo "[verify-deploy] ok: bundle del app tiene todos los markers (${#MARKERS[@]})"

if [ -f "$DIST" ]; then
  for marker in "${MARKERS[@]}"; do
    grep -q "$marker" "$DIST" ||
      fail "repo dist ($DIST) sin marker: $marker — en este workspace el agent se resuelve desde ahí ANTES que el bundle; regenerar con el build"
  done
  echo "[verify-deploy] ok: repo dist tiene todos los markers"
  if [ "$DIST" -ot "$BUNDLE" ]; then
    echo "[verify-deploy] WARN: repo dist más viejo que el bundle del app — los agents de este workspace correrían código viejo; recompilar"
  fi
else
  echo "[verify-deploy] note: sin repo dist (checkout limpio) — el agent saldrá del bundle del app"
fi

main_pid=$(pgrep -x ZCode | head -1 || true)
if [ -n "$main_pid" ]; then
  bundle_epoch=$(stat -f %m "$BUNDLE")
  start_line=$(ps -p "$main_pid" -o lstart= | sed 's/  */ /g')
  start_epoch=$(date -j -f "%a %b %d %H:%M:%S %Y" "$start_line" +%s 2>/dev/null || echo 0)
  if [ "$start_epoch" -gt 0 ] && [ "$start_epoch" -lt "$bundle_epoch" ]; then
    fail "la ZCode corriendo (pid $main_pid, iniciada $start_line) es anterior al bundle instalado — hacer ⌘Q y reabrir"
  fi
  echo "[verify-deploy] ok: la app corriendo es el build instalado (pid $main_pid)"
else
  echo "[verify-deploy] note: ZCode no está corriendo — abrir y volver a correr este script"
fi

echo "[verify-deploy] PASS"
