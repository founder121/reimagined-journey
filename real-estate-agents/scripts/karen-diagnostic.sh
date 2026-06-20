#!/bin/bash
# Phase 1: Karen fabrication diagnostic (read-only)
SERVER="root@204.168.190.158"
KEY="$HOME/.ssh/cm2_server"

ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$SERVER" 'bash -s' << '"REMOTE"'

echo ""
echo "════════════════════════════════════════"
echo "  KAREN DIAGNOSTIC — Phase 1"
echo "════════════════════════════════════════"

HQ="/home/cm2/app/hq/server.js"

# ── 1. Karen's system prompt (AGENT_PROMPTS[9]) ───────────────────────────────
echo ""
echo "━━━ 1. KAREN SYSTEM PROMPT (agentId 9) ━━━"
node -e "
const fs = require('fs');
const src = fs.readFileSync('$HQ', 'utf8');
// Try AGENT_PROMPTS object/array
const m = src.match(/AGENT_PROMPTS\s*=\s*(\{[\s\S]*?\n\})/);
if (m) {
  try {
    const obj = eval('(' + m[1] + ')');
    const k = obj[9] || obj['9'];
    if (k) { console.log(typeof k === 'string' ? k : JSON.stringify(k, null, 2)); process.exit(0); }
  } catch(e) {}
}
// Fallback: find agentId 9 prompt block
const lines = src.split('\n');
let printing = false, depth = 0, found = false;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (!found && (l.includes('9:') || l.includes('[9]') || l.match(/id.*[:=].*9[^0-9]/)) && l.includes('prompt')) {
    found = true; printing = true;
  }
  if (printing) {
    console.log(l);
    if (++depth > 80) { console.log('...truncated...'); break; }
  }
}
" 2>/dev/null || grep -A 120 '"9":\|9:\s*{' "$HQ" | head -130

# ── 2. Tools registered for agentId 9 in /api/chat ───────────────────────────
echo ""
echo "━━━ 2. TOOLS WIRED INTO /api/chat FOR AGENT 9 ━━━"
grep -n 'tools\|function.*call\|tool_choice\|functions:' "$HQ" | head -40
echo "--- Tool schema definitions ---"
grep -n 'name.*:\s*"' "$HQ" | grep -i 'tool\|func\|action\|send\|write\|insert\|direct\|email\|whatsapp' | head -30

# ── 3. Write access to agentMessages / agentBriefings / agentCollaboration ────
echo ""
echo "━━━ 3. DATABASE WRITE ACCESS ━━━"
mysql -u cm2 -pcm2secure2026 cm2db -e "SHOW COLUMNS FROM agentMessages;" 2>/dev/null || echo "agentMessages: table not found"
mysql -u cm2 -pcm2secure2026 cm2db -e "SHOW COLUMNS FROM agentBriefings;" 2>/dev/null || echo "agentBriefings: table not found"
mysql -u cm2 -pcm2secure2026 cm2db -e "SHOW COLUMNS FROM agentCollaboration;" 2>/dev/null || echo "agentCollaboration: table not found"
echo "--- INSERT references in server.js ---"
grep -n 'INSERT.*agentMessages\|INSERT.*agentBriefings\|INSERT.*agentCollaboration\|\.insert.*agent' "$HQ" | head -20
echo "--- Karen tool calls that write anything ---"
grep -n 'agentId.*9\|karen' "$HQ" | grep -i 'insert\|update\|write\|send\|emit' | head -20

# ── 4. Alexandra sourcing — cron schedule ─────────────────────────────────────
echo ""
echo "━━━ 4. ALEXANDRA CRON / ON-DEMAND TRIGGERS ━━━"
COMMAND_CORE="/home/cm2/app/hq/commandCore.js"
if [ -f "$COMMAND_CORE" ]; then
  grep -n 'schedule\|cron\|06:\|compan\|hnwi\|prospect\|alexa\|lead.*source\|source.*lead' "$COMMAND_CORE" | head -30
else
  echo "commandCore.js not found at $COMMAND_CORE"
  find /home/cm2/app/hq -name "*.js" | xargs grep -l 'cron\|schedule' 2>/dev/null | head -5
fi
echo "--- Any on-demand trigger for agent 2 (Alexandra) ---"
grep -n 'agentId.*2\|agent.*2.*run\|runAgent.*2\|trigger.*alexa' "$HQ" 2>/dev/null | grep -iv 'case\|switch\|default' | head -15

# ── 5. K12 rule as currently written ─────────────────────────────────────────
echo ""
echo "━━━ 5. K12 RULE (current wording) ━━━"
grep -n -A 5 'K12\|k12' "$HQ" | head -30

echo ""
echo "════════════════════════════════════════"
echo "  PHASE 1 COMPLETE — paste output to Claude"
echo "════════════════════════════════════════"
REMOTE
