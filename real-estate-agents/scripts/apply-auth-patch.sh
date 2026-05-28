#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Apply Manus → password auth patch to cm2-website
#  Run after cloning cm2-website, before pnpm install/build
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

PATCH_DIR="$(cd "$(dirname "$0")/cm2-auth-patch" && pwd)"
CM2_DIR="${1:-/home/cm2/app/cm2-website}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
step() { echo -e "\n${CYAN}  → $1${NC}"; }

step "Patching server/_core/env.ts"
cp "$PATCH_DIR/server/_core/env.ts"   "$CM2_DIR/server/_core/env.ts"
ok "env.ts — removed Manus vars, added adminPassword"

step "Patching server/_core/oauth.ts"
cp "$PATCH_DIR/server/_core/oauth.ts" "$CM2_DIR/server/_core/oauth.ts"
ok "oauth.ts — POST /api/auth/login password handler"

step "Patching server/_core/sdk.ts"
cp "$PATCH_DIR/server/_core/sdk.ts"   "$CM2_DIR/server/_core/sdk.ts"
ok "sdk.ts — stripped Manus HTTP, kept JWT signing/verification"

step "Patching client/src/const.ts"
cp "$PATCH_DIR/client/src/const.ts"   "$CM2_DIR/client/src/const.ts"
ok "const.ts — getLoginUrl() → /login"

step "Adding client/src/pages/Login.tsx"
cp "$PATCH_DIR/client/src/pages/Login.tsx" "$CM2_DIR/client/src/pages/Login.tsx"
ok "Login.tsx — password form page created"

step "Patching client/src/App.tsx — adding /login route"
APP_TSX="$CM2_DIR/client/src/App.tsx"

# Add Login import after the NotFound import (idempotent check)
if ! grep -q 'import Login from "./pages/Login"' "$APP_TSX"; then
  sed -i '/^import NotFound from ".\/pages\/NotFound";/a import Login from ".\/pages\/Login";' "$APP_TSX"
  ok "App.tsx — Login import added"
else
  ok "App.tsx — Login import already present, skipping"
fi

# Add /login route inside RootRouter Switch, before the AppLayout fallback (idempotent)
if ! grep -q 'path="/login"' "$APP_TSX"; then
  sed -i '/^      <Route component={() => <AppLayout \/>} \/>$/i\      <Route path="\/login" component={() => <Login \/>} \/>' "$APP_TSX"
  ok "App.tsx — /login route added"
else
  ok "App.tsx — /login route already present, skipping"
fi

echo ""
echo "  Auth patch applied. Environment variables needed in .env:"
echo "    ADMIN_PASSWORD=cm2julian2026"
echo "    JWT_SECRET=<64-char hex>"
echo "    OWNER_OPEN_ID=oKaCpXvcwRHTtSLr2qbPVL"
echo ""
