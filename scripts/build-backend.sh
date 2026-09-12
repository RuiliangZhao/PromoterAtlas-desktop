#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export PYINSTALLER_CONFIG_DIR="$PWD/.cache/pyinstaller"
export MPLCONFIGDIR="$PWD/.cache/matplotlib"
.venv/bin/python -m PyInstaller --noconfirm --distpath src-tauri/resources --workpath build/pyinstaller backend/backend.spec
