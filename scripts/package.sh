#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export CARGO_HOME="$PWD/.tools/cargo"
export RUSTUP_HOME="$PWD/.tools/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
scripts/build-backend.sh
.venv/bin/python scripts/verify-frozen.py
node node_modules/@tauri-apps/cli/tauri.js build --bundles app
mkdir -p dist
/usr/bin/ditto -c -k --sequesterRsrc --keepParent 'src-tauri/target/release/bundle/macos/PromoterAtlas Desktop.app' dist/PromoterAtlas-Desktop-0.4.1-arm64.zip
