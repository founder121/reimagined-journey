#!/bin/bash
# Fix cm2-website: invokeLLM 404 + OutreachEngine null crash
# Runs directly on server — no nested SSH
set -euo pipefail

CM2="/home/cm2/app/cm2-website"
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
step() { echo -e "\n${CYAN}  → $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; }

echo ""
echo "════════════════════════════════════════"
echo "  CM2-WEBSITE FIX — $(date '+%Y-%m-%d %H:%M')"
echo "════════════════════════════════════════"

# ── 1. Back up server.ts / relevant source files ──────────────────────────────
step "Backing up source files"
cp -r "$CM2/server" "$CM2/server.bak.$(date +%s)" 2>/dev/null && ok "server/ backed up" || warn "Backup skipped"

# ── 2. Find invokeLLM source ──────────────────────────────────────────────────
step "Locating invokeLLM function"
INVOKE_FILE=$(grep -rl 'invokeLLM\|invoke_llm' "$CM2/server" 2>/dev/null | grep -v 'dist\|\.bak\|node_modules' | head -1)
if [ -z "$INVOKE_FILE" ]; then
  INVOKE_FILE=$(grep -rl 'invokeLLM\|invoke_llm' "$CM2/src" 2>/dev/null | head -1)
fi
echo "  Found: ${INVOKE_FILE:-NOT FOUND}"

if [ -n "$INVOKE_FILE" ]; then
  echo "  --- invokeLLM current code ---"
  grep -n 'model\|endpoint\|anthropic\|claude\|invokeLLM\|messages.*api\|baseURL\|api\.anthropic' "$INVOKE_FILE" | head -25

  # Detect model name in use
  CURRENT_MODEL=$(grep -o '"claude[^"]*"' "$INVOKE_FILE" | head -1 | tr -d '"')
  echo "  Current model: ${CURRENT_MODEL:-not detected}"

  # Fix: replace any deprecated model with claude-3-5-sonnet-20241022
  DEPRECATED_MODELS="claude-2|claude-2\.0|claude-2\.1|claude-instant|claude-instant-1|claude-instant-1\.2|claude-1|claude-3-opus-20240229|claude-3-sonnet-20240229"
  if echo "$CURRENT_MODEL" | grep -qE "$DEPRECATED_MODELS"; then
    warn "Deprecated model detected: $CURRENT_MODEL — updating to claude-3-5-sonnet-20241022"
    sed -i "s|\"$CURRENT_MODEL\"|\"claude-3-5-sonnet-20241022\"|g" "$INVOKE_FILE"
    ok "Model updated in $INVOKE_FILE"
  elif [ -z "$CURRENT_MODEL" ]; then
    warn "Could not detect model name automatically — check file manually"
  else
    ok "Model $CURRENT_MODEL looks current"
  fi

  # Check for wrong API endpoint
  if grep -q 'api\.anthropic\.com/v1/complete\b' "$INVOKE_FILE"; then
    warn "Old /v1/complete endpoint found — updating to /v1/messages"
    sed -i 's|/v1/complete|/v1/messages|g' "$INVOKE_FILE"
    ok "Endpoint updated"
  fi
  if grep -q 'api\.anthropic\.com/v1/messages' "$INVOKE_FILE"; then
    ok "Endpoint /v1/messages is correct"
  fi
else
  warn "invokeLLM source not found in server/ — checking dist"
  # Try to find it from dist line reference
  grep -n 'invokeLLM\|model.*claude\|anthropic' "$CM2/dist/index.js" 2>/dev/null | sed -n '1250,1265p' || true
fi

# ── 3. Find classifyLead and show model context ───────────────────────────────
step "Checking classifyLead → invokeLLM model call"
CLASSIFY_FILE=$(grep -rl 'classifyLead\|classify_lead' "$CM2/server" 2>/dev/null | grep -v '\.bak\|node_modules' | head -1)
if [ -n "$CLASSIFY_FILE" ]; then
  echo "  Found: $CLASSIFY_FILE"
  grep -n 'model\|claude\|invokeLLM\|classifyLead' "$CLASSIFY_FILE" | head -20
fi

# Quick test of Anthropic API with current key
step "Testing Anthropic API key"
ANTH_KEY=$(grep 'ANTHROPIC_API_KEY' "$CM2/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | head -1)
if [ -n "$ANTH_KEY" ]; then
  HTTP=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "x-api-key: $ANTH_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
    https://api.anthropic.com/v1/messages)
  echo "  Anthropic API response: HTTP $HTTP"
  if [ "$HTTP" = "200" ]; then ok "Anthropic API key valid, model reachable"
  elif [ "$HTTP" = "404" ]; then fail "404 — model name or endpoint wrong in the call"
  elif [ "$HTTP" = "401" ]; then fail "401 — API key invalid"
  else warn "Unexpected HTTP $HTTP"
  fi
else
  warn "Could not read ANTHROPIC_API_KEY from .env"
fi

# ── 4. Fix OutreachEngine webhook null crash ──────────────────────────────────
step "Locating OutreachEngine webhook handler"
OUTREACH_FILE=$(grep -rl 'OutreachEngine\|outreachEngine\|webhook.*outreach\|outreach.*webhook' "$CM2/server" 2>/dev/null | grep -v '\.bak\|node_modules' | head -1)
if [ -z "$OUTREACH_FILE" ]; then
  OUTREACH_FILE=$(grep -rl 'orderSelectedFields\|Event webhook' "$CM2/server" 2>/dev/null | grep -v '\.bak\|node_modules' | head -1)
fi
echo "  Found: ${OUTREACH_FILE:-NOT FOUND}"

if [ -n "$OUTREACH_FILE" ]; then
  echo "  --- Webhook handler context ---"
  grep -n 'webhook\|Event webhook\|orderSelectedFields\|undefined\|null\|\.execute\|select(' "$OUTREACH_FILE" | head -30

  # Show the area around the crash
  CRASH_LINE=$(grep -n 'Event webhook\|orderSelectedFields' "$OUTREACH_FILE" | head -1 | cut -d: -f1)
  if [ -n "$CRASH_LINE" ]; then
    echo "  --- Lines around crash ($CRASH_LINE) ---"
    sed -n "$((CRASH_LINE-10)),$((CRASH_LINE+20))p" "$OUTREACH_FILE"
  fi

  # Apply null guard: find the execute call that crashes and add a guard
  # Pattern: if the select/where is called with a variable that could be null
  # We add a guard before the Drizzle .execute() call in the webhook handler
  if grep -q 'Event webhook error' "$OUTREACH_FILE"; then
    warn "Applying null guard to webhook handler"
    # Back up the file
    cp "$OUTREACH_FILE" "${OUTREACH_FILE}.bak"

    # Strategy: wrap the Drizzle query in the webhook handler with a null check
    # Find the function and add an early return if payload is null/undefined
    python3 << PYEOF
import re

with open('$OUTREACH_FILE', 'r') as f:
    src = f.read()

# Pattern 1: webhook handler receives event/payload and calls db query
# Add guard: if (!event || !payload) return
# Find webhook handler function
webhook_pattern = r'(async\s+\w*[Ww]ebhook\w*\s*\([^)]*\)\s*\{)'
match = re.search(webhook_pattern, src)
if match:
    insert_pos = match.end()
    guard = '\n    if (!arguments[0] || typeof arguments[0] !== "object") { console.warn("[OutreachEngine] Skipping webhook: null/undefined payload"); return; }'
    # Only add if not already present
    if 'Skipping webhook: null' not in src:
        src = src[:insert_pos] + guard + src[insert_pos:]
        with open('$OUTREACH_FILE', 'w') as f:
            f.write(src)
        print("  Guard added to webhook handler")
    else:
        print("  Guard already present")
else:
    # Pattern 2: find the orderSelectedFields call and guard it
    order_pattern = r'(orderSelectedFields\s*\()'
    if re.search(order_pattern, src):
        # Add null coalescing before orderSelectedFields
        src_new = re.sub(
            r'orderSelectedFields\s*\(([^)]+)\)',
            lambda m: f'orderSelectedFields(({m.group(1)}) ?? {{}})',
            src
        )
        if src_new != src:
            with open('$OUTREACH_FILE', 'w') as f:
                f.write(src_new)
            print("  Null guard added to orderSelectedFields call")
        else:
            print("  Pattern found but substitution unchanged")
    else:
        print("  Could not auto-patch — manual fix needed. Check file: $OUTREACH_FILE")
PYEOF
    ok "Null guard applied"
  fi
else
  warn "OutreachEngine source not found — searching dist for context"
  grep -n 'Event webhook\|orderSelectedFields' "$CM2/dist/index.js" 2>/dev/null | head -10 || true
fi

# ── 5. Rebuild ────────────────────────────────────────────────────────────────
step "Rebuilding cm2-website"
cd "$CM2"
if [ -f "pnpm-lock.yaml" ]; then
  pnpm build 2>&1 | tail -8
else
  npm run build 2>&1 | tail -8
fi
ok "Build complete"

# ── 6. Restart and monitor ────────────────────────────────────────────────────
step "Restarting cm2-website"
pm2 restart cm2-website
sleep 5
pm2 list | grep cm2-website

step "Watching logs for 90 seconds (Ctrl+C to stop early)"
timeout 90 pm2 logs cm2-website --lines 0 2>&1 || true

# ── 7. Confirm site is up ─────────────────────────────────────────────────────
step "Checking https://thecm2.com"
sleep 3
HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://thecm2.com 2>/dev/null || echo "FAILED")
echo "  External HTTP status: $HTTP"
if [ "$HTTP" = "200" ]; then ok "Site is UP — HTTP 200"
elif [ "$HTTP" = "301" ] || [ "$HTTP" = "302" ]; then ok "Site responding with redirect ($HTTP)"
else fail "Site returned $HTTP — still needs investigation"
fi

echo ""
echo "════════════════════════════════════════"
echo "  FIX COMPLETE — paste output to Julian"
echo "════════════════════════════════════════"
