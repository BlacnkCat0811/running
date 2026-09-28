#!/usr/bin/env bash
# Manual operator tool: intentionally excluded from automated production checks.
# Run on the target Linux/systemd server; local tests cannot certify its runtime.
# Read-only production evidence. Does not restart, export health data, or print secrets.
set -euo pipefail
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Production runtime check requires Linux/systemd; no runtime was checked.' >&2
  exit 2
fi
unit="${RAI_CHECK_UNIT:-rai-api.service}"
root="${RAI_CHECK_RUNTIME:-/var/lib/rai}"
systemctl show "$unit" --property=ActiveState,SubState,MainPID,MemoryCurrent,MemoryMax,CPUQuotaPerSecUSec,TasksMax
pid="$(systemctl show "$unit" --property=MainPID --value)"
if [[ "$pid" == 0 ]]; then echo 'Service is not running; cannot verify effective configuration.' >&2; exit 1; fi
python3 - "$pid" "$root" <<'PY'
import json, pathlib, sys
pid, root = sys.argv[1], pathlib.Path(sys.argv[2])
try:
    data = pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
    env = dict(item.decode(errors='replace').split('=', 1) for item in data if b'=' in item)
except OSError:
    print('Process environment unavailable: rerun with an account allowed to inspect this service.', file=sys.stderr)
    sys.exit(1)
# Only these values are emitted. Tokens, provider keys, origins and health payloads are never printed.
config = {key: env.get(key, '(default/not set)') for key in ('RAI_API_HOST', 'RAI_API_PORT', 'RAI_IMPORT_ENGINE', 'RAI_RUST_FALLBACK')}
config['apiTokenConfigured'] = bool(env.get('RAI_API_TOKEN', '').strip())
config['anonymousReadsConfigured'] = bool(env.get('RAI_PUBLIC_HOSTS', '').strip())
print(json.dumps(config, ensure_ascii=False, indent=2))
print('Environment shows configuration intent only; validate actual engine from per-job telemetry.')
for name in ('rai.sqlite', 'rai-control.sqlite', 'runtime.sqlite'):
    path = root / 'var' / name
    print(f'{name}: ' + ('present' if path.is_file() else 'not at default path; check effective database paths'))
backups = root / 'var' / 'backups'
files = [p for p in backups.glob('*.sqlite') if p.is_file()]
print(f'Database backup file count: {len(files)}; this is NOT proof of complete runtime recovery.')
if config['anonymousReadsConfigured']:
    print('ACTION: anonymous health reads are configured. Review route-coordinate and health privacy before release.')
PY
df -h "$root"
echo 'Still required: deployed Git revision, TLS/nginx configuration, end-to-end device sync, whole-runtime restore rehearsal.'
