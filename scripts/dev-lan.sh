#!/usr/bin/env bash
# Start backend + frontend for LAN access (floor tablets, scan pistols, phones).
#
# Usage (from repo root):
#   ./scripts/dev-lan.sh
#
# Other devices on the same Wi‑Fi open the printed Network URL (port 5173).
# The built UI is also available on port 7474 when the frontend has been built.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d venv ]]; then
  echo "Missing venv — run: python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt -r requirements-dev.txt"
  exit 1
fi

# shellcheck disable=SC1091
source venv/bin/activate

LAN_IP="$(python3 - <<'PY'
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("8.8.8.8", 80))
    print(s.getsockname()[0])
    s.close()
except OSError:
    print("")
PY
)"

echo ""
echo "=== Bambuddy dev (LAN enabled) ==="
if [[ -n "$LAN_IP" ]]; then
  echo "  Dev UI (hot reload):  http://${LAN_IP}:5173"
  echo "  API + built UI:       http://${LAN_IP}:7474"
  echo "  Floor scan page:      http://${LAN_IP}:5173/floor/scan"
else
  echo "  Could not detect LAN IP — use the Network URL Vite prints below."
fi
echo ""
echo "If another device cannot connect, allow incoming connections for Python"
echo "and Node in System Settings → Network → Firewall on this Mac."
echo ""

trap 'kill 0' EXIT INT TERM

HOST=0.0.0.0 DEBUG=true uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 7474 --loop asyncio &
npm run dev --prefix frontend
