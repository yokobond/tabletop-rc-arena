#!/bin/sh
# Builds for a subpath and uploads with rsync. Settings come from .env.deploy.local (not committed).
set -eu
cd "$(dirname "$0")/.."
[ -f .env.deploy.local ] || { echo "Create .env.deploy.local from .env.deploy.example" >&2; exit 1; }
. ./.env.deploy.local
: "${DEPLOY_BASE:?}" "${DEPLOY_TARGET:?}"
grep -q '^VITE_CROQUET_BOX=.' .env.local 2>/dev/null || { echo "Set VITE_CROQUET_BOX in .env.local" >&2; exit 1; }
npx tsc --noEmit
npx vite build --base="$DEPLOY_BASE"
rsync -rlvz --delete --chmod=Dg+s,ug+rwX,o+rX -e "ssh -T" dist/ "$DEPLOY_TARGET"
