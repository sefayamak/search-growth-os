#!/usr/bin/env bash
# READ-ONLY başlangıç denetimi: bin/project-status.ts'e ince sarmalayıcı. Hiçbir şeyi değiştirmez.
# Kullanım: bash scripts/project-status.sh [--remote] [--json]
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
exec node --experimental-strip-types bin/project-status.ts "$@"
