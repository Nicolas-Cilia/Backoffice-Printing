#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for Backoffice Printing.
# Runs from the repository root after checkout.
set -euo pipefail

# The default Cloud Agent image can ship a Python without ensurepip, which
# breaks `python3 -m venv`. Install python3-venv only when it is missing.
if ! python3 -c "import ensurepip" >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends python3-venv
fi

# Backend: (re)create the virtualenv and install pinned runtime + dev deps.
python3 -m venv venv
# shellcheck disable=SC1091
. venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt -r requirements-dev.txt

# Frontend: clean install from the committed lockfile.
npm ci --prefix frontend
