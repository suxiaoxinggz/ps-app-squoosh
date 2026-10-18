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
           "        <a\n          href=\"/\"\n          title=\"Compress\"\n"
           "          aria-label=\"Compress images with Squoosh\"\n"
           "          style=\"white-space:nowrap;margin:0 8px 0 2px;padding:7px 14px;border-radius:999px;background:var(--primary,#c2410c);color:#fff;font-size:13px;font-weight:600;text-decoration:none;line-height:1\"\n"
           "        >Compress</a>\n      </div>")
    assert old in s
    open(p, 'w').write(s.replace(old, new))
    print('header back-link patched')
else:
    print('header back-link already patched')
PY
# ---- Rebrand bg2x -> Squoosh (build-area only, upstream untouched) ----
# Logo: caller may drop a squoosh icon at $SQUOOSH_ICON to replace favicon.
if [ -n "${SQUOOSH_ICON:-}" ] && [ -f "$SQUOOSH_ICON" ]; then
  cp "$SQUOOSH_ICON" public/favicon.png
fi
python3 - <<'PYEOF'
import re
def sub(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert old in s, f'{path}: MISSING {old[:60]}'
        s = s.replace(old, new)
    open(path, 'w').write(s)

sub('src/config/app.ts', [
  ("export const APP_NAME = 'bg2x';", "export const APP_NAME = 'Squoosh';"),
  ("export const GITHUB_REPO = 'isixe/bg2x';", "export const GITHUB_REPO = 'suxiaoxinggz/ps-app-squoosh';"),
  ("export const HOMEPAGE_URL = 'https://bg2x.itea.dev/';", "export const HOMEPAGE_URL = 'https://squoosh.016666666.xyz/upscale/';"),
])
sub('src/components/AppHeader.vue', [
  ('<img src="/favicon.png" alt="bg2x" class="logo-img" />', '<img src="/favicon.png" alt="Squoosh" class="logo-img" />'),
  ('<span class="logo-text">bg2x</span>', '<span class="logo-text">Squoosh</span>'),
  ('href="https://github.com/isixe/bg2x"', 'href="https://github.com/suxiaoxinggz/ps-app-squoosh"'),
])
for _f in ['src/components/AppHeader.vue', 'src/components/HomePage.vue', 'src/components/SettingsView.vue']:
    with open(_f) as fh:
        _s = fh.read()
    with open(_f, 'w') as fh:
        fh.write(_s.replace('src="/favicon.png"', 'src="/upscale/favicon.png"'))
print('img src paths fixed')
sub('src/pages/index.astro', [('<Layout title="bg2x">', '<Layout title="Squoosh Upscale">')])
sub('src/pages/[...view].astro', [('`bg2x - ${pageTitle}`', '`Squoosh - ${pageTitle}`'), (": 'bg2x';", ": 'Squoosh Upscale';")])
sub('src/layouts/Layout.astro', [
  ("description = 'bg2x - AI-powered image super resolution tool',", "description = 'Squoosh AI image super resolution (upscale) tool',"),
  ("'bg2x, AI image upscaling,", "'Squoosh, AI image upscaling,"),
])
sub('src/components/SettingsView.vue', [
  ('bgx: Eraser,\n  imageDash: Images,', ''),
])
# Drop upstream analytics tracker + repoint related tab at our own links.
p57='src/layouts/Layout.astro'
s57=open(p57).read()
i=s57.index('    <script is:inline>')
j=s57.index('  </head>')
assert 'analytics.itea.dev' in s57[i:j]
s57=s57[:i]+s57[j:]
open(p57,'w').write(s57)
p58='src/config/related.ts'
s58=open(p58).read()
i58=s58.index('export const RELATED_PROJECTS')
s58=s58[:i58]+"""export const RELATED_PROJECTS: RelatedProject[] = [
  { name: 'Squoosh Compress', url: '/', i18nKey: 'squooshCompress', favicon: '/favicon.png' },
  { name: 'Squoosh on GitHub', url: 'https://github.com/suxiaoxinggz/ps-app-squoosh', i18nKey: 'squooshGithub', favicon: '/favicon.png' },
];
"""
open(p58,'w').write(s58)
p59='src/components/SettingsView.vue'
s59=open(p59).read()
s59=re.sub(r'const RELATED_ICONS[^;]*?\};', 'const RELATED_ICONS: Record<string, Component> = {};', s59, flags=re.S)
s59=s59.replace("  Scale,\n  Eraser,\n  Images,\n", "  Scale,\n")
open(p59,'w').write(s59)
for loc, items in [('src/locales/en.json', ('"squooshCompress": "Compress and convert images.",\n      "squooshGithub": "Source code on GitHub."')), ('src/locales/zh.json', ('"squooshCompress": "压缩与转换图片。",\n      "squooshGithub": "GitHub 源码。"')), ('src/locales/ja.json', ('"squooshCompress": "画像を圧縮・変換する。",\n      "squooshGithub": "GitHub のソースコード。"'))]:
    sl=open(loc).read()
    sl=re.sub(r'"bgx": "[^"]*",\n      "imageDash": "[^"]*"', items, sl)
    open(loc,'w').write(sl)
print('related+tracker patches staged')
for loc in ['src/locales/en.json', 'src/locales/zh.json', 'src/locales/ja.json']:
    s = open(loc).read()
    s = s.replace('"title": "bg2x"', '"title": "Squoosh"')
    s = re.sub(r'"aboutDesc": "bg2x', '"aboutDesc": "Squoosh', s)
    open(loc, 'w').write(s)
print('rebrand patches applied')
PYEOF

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
echo "NOTE: run this AFTER \"npm run build\" (which wipes build/); never before."

# _headers override so /upscale/* is never cross-origin isolated (match upstream).
if ! grep -q "upscale/\*" "$OLDPWD/build/_headers" 2>/dev/null; then
  cat >> "$OLDPWD/build/_headers" <<'HDR'

# bg2x embed must NOT be isolated (match upstream: single-threaded wasm).
/upscale/*
  Cross-Origin-Opener-Policy: unsafe-none
  Cross-Origin-Embedder-Policy: unsafe-none
HDR
fi
