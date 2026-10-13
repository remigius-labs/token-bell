#!/bin/bash
# Build the panel and pack out/token-bell.zip, the file Decky installs
# (Decky settings > Developer > Install plugin from ZIP, or tools/install.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
rm -rf out && mkdir -p out/token-bell/dist
cp plugin.json package.json main.py out/token-bell/
cp dist/index.js out/token-bell/dist/
cp -r vendor out/token-bell/
(cd out && python3 -m zipfile -c token-bell.zip token-bell/)
echo "out/token-bell.zip"
