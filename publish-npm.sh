#!/usr/bin/env bash
# 用 ~/.npm_auth_token 里的 npm token 发布，不写入 ~/.npmrc，用完即删临时配置。
set -euo pipefail
cd "$(dirname "$0")"
NODE=${NODE:-/Users/mac/.dsh/dsh-runtimes/dsh-next-primary-runtime/dependencies/node/bin/node}
PNPM=${PNPM:-/Users/mac/.dsh/dsh-runtimes/dsh-next-primary-runtime/dependencies/pnpm/bin/pnpm.mjs}
TOKEN_FILE=${TOKEN_FILE:-$HOME/.npm_auth_token}

[ -f "$TOKEN_FILE" ] || { echo "❌ 缺少 $TOKEN_FILE"; exit 1; }
TOKEN=$(tr -d ' \n\r' < "$TOKEN_FILE")
case "$TOKEN" in npm_*) ;; *) echo "⚠️ token 前缀不是 npm_，仍尝试继续";; esac

TMPRC=$(mktemp)
trap 'rm -f "$TMPRC"' EXIT
chmod 600 "$TMPRC"
printf '//registry.npmjs.org/:_authToken=%s\nregistry=https://registry.npmjs.org/\n' "$TOKEN" > "$TMPRC"

echo "=== whoami ==="
NPM_CONFIG_USERCONFIG="$TMPRC" "$NODE" "$PNPM" whoami
echo "=== pack 自检 ==="
"$NODE" "$PNPM" pack >/dev/null && echo "  pack OK"
echo "=== publish ==="
NPM_CONFIG_USERCONFIG="$TMPRC" "$NODE" "$PNPM" publish --access public --no-git-checks
echo "=== 核对 registry ==="
sleep 3
curl -s "https://registry.npmjs.org/$(/Users/mac/miniforge3/bin/python3 -c "import json;print(json.load(open('package.json'))['name'])")/latest" \
  | /Users/mac/miniforge3/bin/python3 -c "import json,sys;d=json.load(sys.stdin);print('  已上架:',d['name'],d['version'])" 2>/dev/null || echo "  （registry 尚未反映，稍等再查）"
