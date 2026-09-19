#!/usr/bin/env bash
# Cold, whole-runtime backup. Deliberately opt-in; never copies live SQLite files.
set -euo pipefail
umask 077
runtime=/var/lib/rai
output=
service=rai-api.service
apply=false
while (($#)); do
  case "$1" in
    --runtime-root) runtime="${2:?missing runtime root}"; shift 2 ;;
    --output-dir) output="${2:?missing output directory}"; shift 2 ;;
    --service) service="${2:?missing service}"; shift 2 ;;
    --apply) apply=true; shift ;;
    *) echo "Usage: $0 --output-dir EXISTING_DIR [--runtime-root DIR] [--service UNIT] [--apply]" >&2; exit 2 ;;
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
if ! $apply; then
  printf 'DRY RUN: stop %s if active; archive all of %s into %s; restore prior service state.\n' "$service" "$runtime" "$output"
  echo "Requires local disks, no CLI writers, and all DB/artifact paths inside runtime. Use --apply after checking."
  exit 0
fi
for tool in systemctl flock tar sha256sum mktemp; do command -v "$tool" >/dev/null; done
exec 9>"$output/.rai-runtime-backup.lock"
flock -n 9 || { echo "Another backup is running." >&2; exit 1; }
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
  if [[ -n "$temporary" && -d "$temporary" ]]; then rm -rf -- "$temporary"; fi
  if $restart; then
    if ! systemctl start "$service"; then
      echo "CRITICAL: could not restart $service; restart it manually." >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "$state" == active ]]; then
  restart=true
  systemctl stop "$service"
fi
[[ "$(systemctl show "$service" -p ActiveState --value)" == inactive ]] || {
  echo "Refusing to copy a running service." >&2; exit 1;
}
temporary=$(mktemp -d "$output/.rai-runtime-XXXXXXXX")
# Uncompressed: minimize downtime and CPU use. Encrypt/compress the finished
# archive outside the stopped interval before copying it off this trusted disk.
tar -C "$runtime" -cf "$temporary/runtime.tar" .
tar -tf "$temporary/runtime.tar" >/dev/null
printf 'rai-runtime-backup-v1\n' > "$temporary/format-version.txt"
(cd "$temporary" && sha256sum runtime.tar > SHA256SUMS)
destination="$output/rai-runtime-$(date -u +%Y%m%dT%H%M%SZ)-$$"
[[ ! -e "$destination" ]] || { echo "Backup destination already exists." >&2; exit 1; }
mv -- "$temporary" "$destination"
temporary=
echo "Backup created: $destination (contains private health data; not encrypted)"
