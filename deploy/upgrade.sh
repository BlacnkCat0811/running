#!/usr/bin/env bash
#
# 服务器端发布脚本：把 /opt/rai 的 main 快进到远端，重建前端产物并重启 API。
#
# 背景：deploy/README-UBUNTU.md 的「后续发布新版」是 4 条手敲命令，
# 顺序错一步（例如漏做备份、忘记 npm ci）就会把线上库置于无备份状态。
#
# 默认 **dry-run**：只打印将要执行的命令。确认无误后加 --apply 真正执行。
#
#   sudo bash deploy/upgrade.sh            # 预演
#   sudo bash deploy/upgrade.sh --apply    # 执行
#
set -euo pipefail

APP_DIR=${RAI_APP_DIR:-/opt/rai}
SERVICE=${RAI_SERVICE:-rai-api}
ENV_FILE=${RAI_ENV_FILE:-/etc/rai/rai.env}
BRANCH=${RAI_BRANCH:-main}
RUN_USER=${RAI_RUN_USER:-rai}
HEALTH_URL=${RAI_HEALTH_URL:-http://127.0.0.1:8787/v1/health}

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（只支持 --apply）" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() {
  if [ "$APPLY" -eq 1 ]; then
    say "+ $*"
    "$@"
  else
    say "[dry-run] $*"
  fi
}

as_user() {
  if [ "$APPLY" -eq 1 ]; then
    say "+ sudo -u $RUN_USER $*"
    sudo -u "$RUN_USER" "$@"
  else
    say "[dry-run] sudo -u $RUN_USER $*"
  fi
}

[ "$APPLY" -eq 1 ] || say "=== DRY-RUN（不会改动任何东西；确认后加 --apply）==="
say "目标：$APP_DIR  服务：$SERVICE  分支：$BRANCH"

# --- 0. 前置检查 -------------------------------------------------------------
[ -d "$APP_DIR/.git" ] || { echo "错误：$APP_DIR 不是 git 仓库" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "错误：缺少 $ENV_FILE" >&2; exit 1; }

# 只检查已跟踪文件的改动：/opt/rai 下的 .npm/ 与 .npmrc 是 npm 缓存噪声，不属于仓库。
if [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ]; then
  echo "错误：$APP_DIR 有未提交的已跟踪改动，先处理再发布" >&2
  git -C "$APP_DIR" status --short --untracked-files=no >&2
  exit 1
fi
before_head=$(git -C "$APP_DIR" rev-parse --short HEAD)
before_lock=$(git -C "$APP_DIR" rev-parse HEAD:package-lock.json)
say "当前 HEAD：$before_head"

# --- 1. 备份（必须成功，否则中止）-------------------------------------------
# 令牌只从 EnvironmentFile 读取，绝不回显。
api_token=$(sudo grep -E '^RAI_API_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
[ -n "$api_token" ] || { echo "错误：$ENV_FILE 中没有 RAI_API_TOKEN" >&2; exit 1; }

if [ "$APPLY" -eq 1 ]; then
  say "+ POST ${HEALTH_URL%/v1/health}/v1/backups"
  backup_code=$(curl -sS -o /tmp/rai-upgrade-backup.json -w '%{http_code}' \
    -X POST "${HEALTH_URL%/v1/health}/v1/backups" \
    -H "Authorization: Bearer $api_token")
  if [ "$backup_code" != "200" ] && [ "$backup_code" != "201" ]; then
    echo "错误：备份失败（HTTP $backup_code），中止发布" >&2
    cat /tmp/rai-upgrade-backup.json >&2
    exit 1
  fi
  say "备份完成"
else
  say "[dry-run] POST ${HEALTH_URL%/v1/health}/v1/backups（失败即中止）"
fi

# --- 2. 拉取代码 -------------------------------------------------------------
run sudo -u "$RUN_USER" git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
after_head=$(git -C "$APP_DIR" rev-parse --short HEAD)
say "目标 HEAD：$after_head"

# --- 3. 依赖：只有 package-lock.json 变了才重装 ---------------------------------
after_lock=$(git -C "$APP_DIR" rev-parse "HEAD:package-lock.json")
if [ "$before_lock" != "$after_lock" ]; then
  say "package-lock.json 有变化 → 重装依赖"
  as_user env ONNXRUNTIME_NODE_INSTALL=skip npm --prefix "$APP_DIR" ci
else
  say "package-lock.json 未变化 → 跳过 npm ci"
fi

# --- 4. 重建前端产物（Nginx 直接读 dist）--------------------------------------
as_user npm --prefix "$APP_DIR" run build

# --- 5. 重启并验证 -----------------------------------------------------------
run systemctl restart "$SERVICE"

if [ "$APPLY" -eq 1 ]; then
  unauthenticated=$(curl -sS -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)
  authenticated=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $api_token" "$HEALTH_URL" || true)
  say "GET /v1/health  无令牌=$unauthenticated（期望 401）  带令牌=$authenticated（期望 200）"
  say "HEAD=$after_head"
  say "schema_migrations 最新 version："
  sudo -u "$RUN_USER" node -e '
    const { DatabaseSync } = require("node:sqlite");
    const path = process.env.RAI_DATABASE || "/var/lib/rai/var/rai.sqlite";
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
    console.log("  " + row.v);
    db.close();
  ' 2>/dev/null || say "  （无法读取 schema_migrations，请手动核对）"
else
  say "[dry-run] 验证：GET /v1/health 无令牌应 401、带令牌应 200；并核对 schema_migrations"
fi

say "完成。"
