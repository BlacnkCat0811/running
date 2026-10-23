#!/usr/bin/env bash
# Cold, whole-runtime backup. Deliberately opt-in; never copies live SQLite files.
set -euo pipefail
umask 077
runtime=/var/lib/rai
output=
service=rai-api.service
apply=false
env_file=
database=
control_database=
manifest_out=
no_default_env=false
while (($#)); do
  case "$1" in
    --runtime-root) runtime="${2:?missing runtime root}"; shift 2 ;;
    --output-dir) output="${2:?missing output directory}"; shift 2 ;;
    --service) service="${2:?missing service unit}"; shift 2 ;;
    --env-file) env_file="${2:?missing env file}"; shift 2 ;;
    --database) database="${2:?missing database path}"; shift 2 ;;
    --control-database) control_database="${2:?missing control database path}"; shift 2 ;;
    --manifest-out) manifest_out="${2:?missing manifest output path}"; shift 2 ;;
    --no-default-env) no_default_env=true; shift ;;
    --apply) apply=true; shift ;;
    *) echo "Usage: $0 --output-dir EXISTING_DIR [--runtime-root DIR] [--service UNIT] [--env-file FILE | --database PATH --control-database PATH] [--manifest-out FILE] [--apply]" >&2; exit 2 ;;
  esac
done
[[ -n "$output" && -d "$output" && -d "$runtime/var" ]] || {
  echo "Create the output directory first; runtime must contain var/." >&2; exit 2;
}
[[ "$service" =~ ^[A-Za-z0-9_-]+\.service$ ]] || { echo "Invalid service unit" >&2; exit 2; }
runtime=$(cd "$runtime" && pwd -P)
output=$(cd "$output" && pwd -P)
[[ "$output" != "$runtime" && "$output" != "$runtime/"* ]] || {
  echo "Backup output must be outside the runtime tree." >&2; exit 2;
}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# In a repository checkout the helpers live in ../scripts. A root-owned
# installation (recommended for production) puts the script and all helpers in
# the same directory.
helper_dir="${RAI_BACKUP_HELPER_DIR:-$script_dir/../scripts}"
if [[ ! -f "$helper_dir/check-runtime-backup-paths.mjs" && -f "$script_dir/check-runtime-backup-paths.mjs" ]]; then
  helper_dir="$script_dir"
fi
path_checker="$helper_dir/check-runtime-backup-paths.mjs"
archive_verifier="$helper_dir/verify-runtime-backup-archive.mjs"
service_resolver="$helper_dir/resolve-runtime-backup-service.mjs"
live_env_checker="$helper_dir/verify-live-service-env.mjs"
[[ -f "$path_checker" ]] || { echo "Missing path checker: $path_checker" >&2; exit 2; }
[[ -f "$archive_verifier" ]] || { echo "Missing archive verifier: $archive_verifier" >&2; exit 2; }
[[ -f "$service_resolver" ]] || { echo "Missing service resolver: $service_resolver" >&2; exit 2; }
[[ -f "$live_env_checker" ]] || { echo "Missing live service env checker: $live_env_checker" >&2; exit 2; }

# 阶段 4（F3/T12，复核 R2/R3）：脚本只归档 runtime 根，所以必须证明主库/
# 控制库及其侧车都在该根内。**不接受隐式默认值**：API 的缺省主库是
# `<projectRoot>/var/rai.sqlite`，不是 `<runtimeRoot>/var/rai.sqlite`；只有
# 部署 env 或命令行显式给出两个路径，检查器才会继续。
if ! $no_default_env && [[ -z "$env_file" && -z "$database" && -z "$control_database" && -f /etc/rai/rai.env ]]; then
  env_file=/etc/rai/rai.env
fi
if [[ -n "$env_file" && ( -n "$database" || -n "$control_database" ) ]]; then
  echo "Refusing backup: --env-file cannot be combined with --database or --control-database." >&2
  exit 2
fi
if $apply; then
  # Resolve the service's actual, supported configuration before any path scan or stop.
  resolver_args=(--service "$service" --runtime "$runtime")
  [[ -n "$env_file" ]] && resolver_args+=(--env-file "$env_file")
  [[ -n "$database" ]] && resolver_args+=(--database "$database")
  [[ -n "$control_database" ]] && resolver_args+=(--control-database "$control_database")
  service_config=$(node "$service_resolver" "${resolver_args[@]}") || exit 2
  database=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).configuredMain)' "$service_config")
  control_database=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).configuredControl)' "$service_config")
  config_source=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).source)' "$service_config")
fi
path_args=(--runtime-root "$runtime")
if $apply; then
  path_args+=(--database "$database" --control-database "$control_database" --configuration-source "$config_source" --database-source "$config_source")
  [[ -n "$env_file" ]] && path_args+=(--service-env-file "$env_file")
else
  [[ -n "$env_file" ]] && path_args+=(--deployment-env "$env_file")
  [[ -n "$database" ]] && path_args+=(--database "$database")
  [[ -n "$control_database" ]] && path_args+=(--control-database "$control_database")
fi
if [[ -z "$env_file" && ( -z "$database" || -z "$control_database" ) ]]; then
  if $apply; then
    echo "Refusing --apply: cannot verify database path closure without both database paths." >&2
    echo "Pass --env-file /etc/rai/rai.env (readable by this user) or both --database and --control-database." >&2
    exit 2
  fi
  echo "WARNING: no deployment env file or explicit database paths; path closure is UNVERIFIED." >&2
fi
preflight_args=("${path_args[@]}")
if $apply; then
  # 停服前的 preflight 只判闭包；逐文件摘要留到停服后的权威 manifest，避免
  # 在服务仍运行时对整棵 runtime 做两次全量哈希。
  preflight_args+=(--no-digests)
elif [[ -n "$manifest_out" ]]; then
  preflight_args+=(--out "$manifest_out")
fi
if ! node "$path_checker" "${preflight_args[@]}"; then
  echo "Refusing backup: path closure is incomplete (outside runtime root, missing, unreadable, or a symbolic link)." >&2
  exit 2
fi
if ! $apply; then
  if [[ -n "$manifest_out" ]]; then
    echo "Path manifest written: $manifest_out"
  fi
  printf 'DRY RUN: stop %s if active; archive all of %s into %s; restore prior service state.\n' "$service" "$runtime" "$output"
  echo "Path closure checked: main/control/runtime/epoch sidecar/restore journal are plain files inside the runtime root."
  echo "Requires local disks and no CLI writers. Use --apply after checking."
  exit 0
fi

for tool in systemctl flock tar sha256sum mktemp node find; do command -v "$tool" >/dev/null; done
# A fixed lock next to the runtime, not inside each output directory: two
# operators using different --output-dir must still exclude each other.
backup_lock="${runtime}.backup.lock"
exec 9>"$backup_lock"
flock -n 9 || { echo "Another backup is running for $runtime." >&2; exit 1; }
[[ "$(systemctl show "$service" -p LoadState --value)" == "loaded" ]] || {
  echo "Service is not installed." >&2; exit 1;
}
state=$(systemctl show "$service" -p ActiveState --value)
[[ "$state" == active || "$state" == inactive ]] || {
  echo "Service is transitioning or failed; resolve it before backing up." >&2; exit 1;
}
temporary=
restart=false
cleanup() {
  local status=$?
  trap - EXIT
  # Never let an unremovable temp file skip the service restore.
  if [[ -n "$temporary" && -d "$temporary" ]]; then rm -rf -- "$temporary" || true; fi
  if $restart; then
    if ! systemctl start "$service"; then
      echo "CRITICAL: could not restart $service; restart it manually." >&2
      status=1
    elif [[ "$(systemctl show "$service" -p ActiveState --value)" != "active" ]]; then
      echo "CRITICAL: $service did not become active after backup." >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The env file can be edited after the service started. Compare the running
# process environment on Linux before stopping it; otherwise the archive can
# silently contain a different database than the process that is serving.
if [[ "$state" == active ]]; then
  live_pid=$(systemctl show "$service" -p MainPID --value)
  if [[ "$live_pid" =~ ^[0-9]+$ && "$live_pid" -gt 0 ]]; then
    node "$live_env_checker" --pid "$live_pid" --runtime "$runtime" \
      --database "$database" --control-database "$control_database" || exit 2
  else
    echo "Refusing backup: $service is active but MainPID is unavailable; cannot verify its running database paths." >&2
    exit 2
  fi
fi
if [[ "$state" == active ]]; then
  restart=true
  systemctl stop "$service"
fi
[[ "$(systemctl show "$service" -p ActiveState --value)" == "inactive" ]] || {
  echo "Refusing to copy a running service." >&2; exit 1;
}

# The service is stopped, so its own API locks are gone. Any remaining live
# CLI publication lock means an independent writer can still change the
# runtime during the archive window. Refuse rather than rely on the "no CLI
# writers" documentation precondition.
check_cli_locks() {
  local lock owner pid
  while IFS= read -r lock; do
    [[ -n "$lock" ]] || continue
    owner="$lock"
    if [[ -d "$lock" && -f "$lock/owner.json" ]]; then owner="$lock/owner.json"; fi
    pid=$(node -e 'const fs=require("fs");try{const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(o&&Number.isInteger(o.pid)&&o.pid>0)process.stdout.write(String(o.pid))}catch{}' "$owner" 2>/dev/null || true)
    if [[ -z "$pid" ]]; then
      echo "Refusing: cannot prove publication lock $lock is stale." >&2
      return 1
    fi
    if kill -0 "$pid" 2>/dev/null; then
      echo "Refusing: active CLI publication lock $lock (pid $pid)." >&2
      return 1
    fi
  done < <(find "$runtime" \( -name '*.import.lock' -o -name 'import-scope-init.lock' \) -print 2>/dev/null)
}
check_cli_locks || exit 1

temporary=$(mktemp -d "$output/.rai-runtime-XXXXXXXX")
# Authoritative manifest is taken after the service stopped (WAL/SHM presence is
# part of the evidence); the pre-flight check above only gates the operation.
node "$path_checker" "${path_args[@]}" --out "$temporary/path-manifest.json"
# Uncompressed: minimize downtime and CPU use. Encrypt/compress the finished
# archive outside the stopped interval before copying it off this trusted disk.
COPYFILE_DISABLE=1 tar -C "$runtime" -cf "$temporary/runtime.tar" .
# 语义闭包：逐项比对归档条目/类型/摘要，并确认归档窗口结束后源文件没有被删改。
node "$archive_verifier" --archive "$temporary/runtime.tar" \
  --manifest "$temporary/path-manifest.json" --source-root "$runtime" --extract-root "$output"
printf 'rai-runtime-backup-v1\n' > "$temporary/format-version.txt"
(cd "$temporary" && sha256sum runtime.tar > SHA256SUMS && sha256sum path-manifest.json >> SHA256SUMS)
destination="$output/rai-runtime-$(date -u +%Y%m%dT%H%M%SZ)-$$"
[[ ! -e "$destination" ]] || { echo "Backup destination already exists." >&2; exit 1; }
mv -- "$temporary" "$destination"
temporary=
if [[ -n "$manifest_out" ]]; then cp "$destination/path-manifest.json" "$manifest_out"; fi
echo "Backup created: $destination (contains private health data; not encrypted)"
