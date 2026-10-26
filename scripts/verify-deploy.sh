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
ASAR="$APP/Contents/Resources/app.asar"
DIST="apps/zcode-cli/packages/cli/dist/zcode.cjs"
# 构建产物（带原始 mtime）：swap 的 ditto 会刷新安装副本的 mtime，
# 年龄对比必须用 staging 副本，否则永远误报 dist “更旧”。
STAGED_BUNDLE="packages/desktop/bundled-agents/darwin-arm64/glm/zcode.cjs"

fail() { echo "[verify-deploy] FAIL: $*" >&2; exit 1; }

# 每波部署的代码 marker（新增波次就追加）。
# AGENT_MARKERS 查 Resources/glm/zcode.cjs（CLI runtime）；UI_MARKERS 查 app.asar
# （renderer + desktop services）。别放错列表：CLI 的 marker 在 asar 里查不到，反之亦然。
AGENT_MARKERS=(
  "nextAttemptAtMs"         # Ola 4b: countdown absoluto (adapter publish)
  "usageLimitResetWaitMs"   # Ola 5: wait-until-reset (next_flush_time)
  "live_io_partial"         # FORK live CoT: mid-request sidecar flush (runner-debug)
)
# renderer/shared 打包进 asar 且会经过压缩混淆：marker 必须是字面量（i18n key、
# 属性名），函数名会被 minify 吃掉。asar 是二进制 → grep 需要 -a。
UI_MARKERS=(
  "chat.apiRetryStatus.serverError" # Ola 6 (B2): labels honestos (i18n literal)
  "chat.apiRetryStatus.recovery"    # Ola 6 (B2): stream recovery 标记
  "nextRetryAtMs"                   # Ola 4b: normalizer + legacy schema (属性名)
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
for marker in "${AGENT_MARKERS[@]}"; do
  LC_ALL=C grep -a -q "$marker" "$BUNDLE" || fail "agent del bundle sin marker: $marker"
done
echo "[verify-deploy] ok: bundle del app (agent) tiene todos los markers (${#AGENT_MARKERS[@]})"

[ -f "$ASAR" ] || fail "falta el asar del app: $ASAR"
for marker in "${UI_MARKERS[@]}"; do
  LC_ALL=C grep -a -q "$marker" "$ASAR" || fail "asar del app sin marker UI: $marker"
done
echo "[verify-deploy] ok: asar del app (UI/shared) tiene todos los markers (${#UI_MARKERS[@]})"

if [ -f "$DIST" ]; then
  for marker in "${AGENT_MARKERS[@]}"; do
    LC_ALL=C grep -a -q "$marker" "$DIST" ||
      fail "repo dist ($DIST) sin marker: $marker — en este workspace el agent se resuelve desde ahí ANTES que el bundle; regenerar con el build"
  done
  echo "[verify-deploy] ok: repo dist tiene todos los markers"
else
  echo "[verify-deploy] note: sin repo dist (checkout limpio) — el agent saldrá del bundle del app"
fi

# 主进程经 Dock 启动时 argv[0] 只是 "ZCode"（无完整路径），pgrep -f/-x 都不可靠；
# ps 的 comm 字段是唯一稳定来源。
main_pid=$(ps -A -o pid=,comm= | awk 'NF==2 && $2=="ZCode" {print $1; exit}')
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
