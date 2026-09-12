#!/bin/bash
# Deploy /book-a-call page to cm2-website
# Run: bash apply-book-a-call.sh [path-to-cm2-website]
set -euo pipefail

PATCH_DIR="$(cd "$(dirname "$0")/book-a-call-patch" && pwd)"
CM2_DIR="${1:-/home/cm2/app/cm2-website}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
step() { echo -e "\n${CYAN}  → $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }

# ── 1. Copy BookACall.tsx ──────────────────────────────────────────────────────
step "Copying BookACall.tsx"
cp "$PATCH_DIR/client/src/pages/BookACall.tsx" "$CM2_DIR/client/src/pages/BookACall.tsx"
ok "BookACall.tsx created"

# ── 2. Add /book-a-call route to App.tsx ─────────────────────────────────────
step "Patching App.tsx"
APP_TSX="$CM2_DIR/client/src/App.tsx"

if ! grep -q 'import BookACall' "$APP_TSX"; then
  sed -i '/^import Login from ".\/pages\/Login";/a import BookACall from ".\/pages\/BookACall";' "$APP_TSX"
  ok "BookACall import added"
else
  ok "BookACall import already present"
fi

if ! grep -q 'path="/book-a-call"' "$APP_TSX"; then
  sed -i '/path="\/login"/a\      <Route path="\/book-a-call" component={() => <BookACall \/>} \/>' "$APP_TSX"
  ok "/book-a-call route added"
else
  ok "/book-a-call route already present"
fi

# ── 3. Copy bookACall router ──────────────────────────────────────────────────
step "Copying bookACall tRPC router"
ROUTER_DIR="$CM2_DIR/server/routers"
mkdir -p "$ROUTER_DIR"
cp "$PATCH_DIR/server/routers/bookACall.ts" "$ROUTER_DIR/bookACall.ts"
ok "bookACall.ts router created"

# ── 4. Wire router into main router file ─────────────────────────────────────
step "Wiring bookACallRouter into main router"
# Find the main router file (routers.ts or _appRouter.ts etc.)
MAIN_ROUTER=""
for F in "$CM2_DIR/server/routers.ts" "$CM2_DIR/server/_core/router.ts" \
         "$CM2_DIR/server/router.ts" "$CM2_DIR/server/trpc/router.ts"; do
  if [ -f "$F" ]; then MAIN_ROUTER="$F"; break; fi
done

if [ -z "$MAIN_ROUTER" ]; then
  warn "Could not find main tRPC router file — manual step needed"
  warn "Add to your router: import { bookACallRouter } from './routers/bookACall';"
  warn "Then merge: bookACall: bookACallRouter"
else
  if ! grep -q 'bookACallRouter' "$MAIN_ROUTER"; then
    # Add import after last import line
    sed -i "/^import.*from/!b; \${/^import.*from/!b}; s|^import.*from.*$|&|" "$MAIN_ROUTER" 2>/dev/null || true
    # Safer: prepend import at top of file
    sed -i "1s|^|import { bookACallRouter } from './routers/bookACall';\n|" "$MAIN_ROUTER"
    # Add to router merge — find mergeRouters or router({ pattern
    if grep -q 'mergeRouters' "$MAIN_ROUTER"; then
      sed -i 's/mergeRouters(/mergeRouters(\n  bookACallRouter,/' "$MAIN_ROUTER"
    elif grep -q 'createCallerFactory\|router({' "$MAIN_ROUTER"; then
      # Try to find the last entry in the router object and add after it
      sed -i 's/\(router({\)/\1\n  bookACall: bookACallRouter,/' "$MAIN_ROUTER"
    fi
    ok "bookACallRouter wired into $MAIN_ROUTER"
  else
    ok "bookACallRouter already present in router"
  fi
fi

# ── 5. Check ENV has SENDGRID_API_KEY ────────────────────────────────────────
step "Checking env.ts for sendgridApiKey"
ENV_FILE="$CM2_DIR/server/_core/env.ts"
if ! grep -q 'sendgridApiKey\|SENDGRID' "$ENV_FILE"; then
  sed -i 's/isProduction: process\.env\.NODE_ENV/sendgridApiKey: process.env.SENDGRID_API_KEY ?? "",\n  isProduction: process.env.NODE_ENV/' "$ENV_FILE"
  ok "sendgridApiKey added to ENV"
else
  ok "sendgridApiKey already in ENV"
fi

# ── 6. Check @sendgrid/mail is installed ─────────────────────────────────────
step "Checking @sendgrid/mail"
if ! [ -d "$CM2_DIR/node_modules/@sendgrid" ]; then
  cd "$CM2_DIR" && pnpm add @sendgrid/mail 2>/dev/null || npm install @sendgrid/mail 2>/dev/null || true
  ok "@sendgrid/mail installed"
else
  ok "@sendgrid/mail already present"
fi

# ── 7. Update sequenceCampaigns email bodies ──────────────────────────────────
step "Appending book-a-call CTA to sequenceCampaigns"
CTA='\n\nTo arrange a call at a time that suits you: https://www.thecm2.com/book-a-call'
mysql -u cm2 -pcm2secure2026 cm2db 2>/dev/null <<SQL
UPDATE sequenceCampaigns
SET body = CONCAT(body, '\n\nTo arrange a call at a time that suits you: https://www.thecm2.com/book-a-call')
WHERE body NOT LIKE '%book-a-call%';
SQL
ROWS=$(mysql -u cm2 -pcm2secure2026 cm2db -se "SELECT ROW_COUNT();" 2>/dev/null || echo "?")
ok "sequenceCampaigns updated ($ROWS rows)"

# ── 8. Build ──────────────────────────────────────────────────────────────────
step "Building cm2-website"
cd "$CM2_DIR"
if [ -f "pnpm-lock.yaml" ]; then
  pnpm build 2>&1 | tail -5
else
  npm run build 2>&1 | tail -5
fi
ok "Build complete"

# ── 9. Restart ────────────────────────────────────────────────────────────────
step "Restarting cm2-website"
pm2 restart cm2-website
sleep 3
pm2 status cm2-website
ok "cm2-website restarted"

echo ""
echo "  /book-a-call is live at https://www.thecm2.com/book-a-call"
echo ""
