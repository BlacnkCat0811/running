#!/usr/bin/env bash
# Compatibility entry point; backups are no longer tied to the home/N100 plan.
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backup-runtime.sh" "$@"
