#!/usr/bin/env bash
# Build the bg2x static embed for /upscale. Run from repo root:
#   bash scripts/build-upscale.sh [bg2x-checkout]
# Patches live in the build area only (upstream source untouched except two
# documented fork deltas: astro base + router BASE_URL + header back-link).
set -euo pipefail
SRC="${1:-/tmp/bg2x}"
test -d "$SRC" || { echo "bg2x checkout not found: $SRC"; exit 1; }
cd "$SRC"
python3 - <<'PY'
import re
p = 'src/router/router.ts'
s = open(p).read()
old = "createWebHistory(),"
if old in s:
    s = s.replace(old, "createWebHistory(import.meta.env.BASE_URL),")
    open(p, 'w').write(s)
    print('router base patched')
else:
    print('router base already patched')
p = 'src/components/AppHeader.vue'
s = open(p).read()
if 'Compress images with Squoosh' not in s:
    old = "          <Github />\n        </a>\n      </div>"
    new = ("          <Github />\n        </a>\n"
           "        <a\n          class=\"icon-btn\"\n          href=\"/\"\n"
           "          :title=\"'Compress'\"\n          aria-label=\"Compress images with Squoosh\"\n"
           "        >\n          <span style=\"font-size:12px;font-weight:600\">ZIP</span>\n"
           "        </a>\n      </div>")
    assert old in s
    open(p, 'w').write(s.replace(old, new))
    print('header back-link patched')
else:
    print('header back-link already patched')
PY
cat > astro.upscale.config.mjs <<'EOF'
// @ts-check
// Build-area only: serves bg2x under /upscale on the Squoosh worker.
import base from './astro.config.mjs';
export default { ...base, base: '/upscale' };
EOF
if [ ! -d node_modules ]; then
  (command -v pnpm >/dev/null && pnpm install) || npm install
fi
./node_modules/.bin/astro build --config ./astro.upscale.config.mjs
# Fix root-absolute favicon (breaks under /upscale subpath).
grep -rl 'href="/favicon.png"' dist/ | xargs sed -i '' 's|href="/favicon.png"|href="/upscale/favicon.png"|'
rm -rf "$OLDPWD/build/upscale"
mkdir -p "$OLDPWD/build"
cp -r dist "$OLDPWD/build/upscale"
# Workers Assets caps single files at 25MiB: split oversized wasm into
# <name>.partNN chunks (served reassembled by the worker's
# /upscale/_astro/:file route — generic over hashed names, no R2 needed).
mkdir -p "$OLDPWD/vendor/upscale-wasm"
for f in "$OLDPWD/build/upscale/_astro"/*.wasm; do
  if [ -f "$f" ] && [ "$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")" -gt 26214400 ]; then
    split -b 10m -d "$f" "$f.part"
    mv "$f" "$OLDPWD/vendor/upscale-wasm/"
    echo "split oversized $(basename "$f") into .partNN chunks"
  fi
done
echo "upscale build copied to $OLDPWD/build/upscale"

# _headers override so /upscale/* is never cross-origin isolated (match upstream).
if ! grep -q "upscale/\*" "$OLDPWD/build/_headers" 2>/dev/null; then
  cat >> "$OLDPWD/build/_headers" <<'HDR'

# bg2x embed must NOT be isolated (match upstream: single-threaded wasm).
/upscale/*
  Cross-Origin-Opener-Policy: unsafe-none
  Cross-Origin-Embedder-Policy: unsafe-none
HDR
fi
