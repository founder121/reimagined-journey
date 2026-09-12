#!/bin/bash
# Emergency agent activation + pipeline brief
# Run from your local terminal:
#   bash emergency-brief.sh

SERVER="root@204.168.190.158"
KEY="$HOME/.ssh/cm2_server"

run() { ssh -i "$KEY" "$SERVER" "$1"; }

echo ""
echo "════════════════════════════════════════"
echo "  CM2 EMERGENCY BRIEF — $(date '+%A %d %b %Y')"
echo "════════════════════════════════════════"

echo ""
echo "▶ Restarting all services..."
run "pm2 restart all > /dev/null 2>&1 && sleep 4 && pm2 status"

echo ""
echo "▶ Live pipeline..."
run "mysql -u cm2 -pcm2secure2026 cm2db -e '
SELECT
  COUNT(*) as total_leads,
  SUM(doNotContact=0) as contactable,
  SUM(replied=1 AND doNotContact=0) as replied,
  SUM(genuineReply=1) as genuine_replies,
  SUM(lastClickedAt IS NOT NULL AND doNotContact=0) as clicked
FROM investorLeads;
' 2>/dev/null"

echo ""
echo "▶ Top leads to action today..."
run "mysql -u cm2 -pcm2secure2026 cm2db -e '
SELECT id, name, email, whatsapp,
  investmentBudget as budget,
  COALESCE(lead_score,5) as score,
  replied, genuineReply
FROM investorLeads
WHERE doNotContact=0
AND (replied=1 OR genuineReply=1 OR lastClickedAt IS NOT NULL OR COALESCE(lead_score,5)>=7)
ORDER BY genuineReply DESC, replied DESC, lastClickedAt DESC, COALESCE(lead_score,5) DESC
LIMIT 20;
' 2>/dev/null"

echo ""
echo "▶ £1M+ uncontacted leads..."
run "mysql -u cm2 -pcm2secure2026 cm2db -e '
SELECT id, name, email, whatsapp, investmentBudget as budget
FROM investorLeads
WHERE doNotContact=0 AND sequenceStep=0
AND investmentBudget IN (\"£1M - £3M\",\"£1M – £3M\",\"£3M+\")
LIMIT 10;
' 2>/dev/null"

agent() {
  local label="$1" id="$2" msg="$3"
  echo ""
  echo "▶ $label..."
  run "curl -sf -X POST http://localhost:3002/api/chat \
    -H 'Content-Type: application/json' \
    -d '{\"message\":\"$msg\",\"agentId\":$id}' \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get(\"response\",\"ERROR\")[:600])' 2>/dev/null \
    || echo '[agent not responding]'"
  sleep 2
}

agent "KAREN — 48h emergency plan" 9 \
  "Karen I am Julian. I want a deal closed this week. Give me your emergency action plan for the next 48 hours. What exactly do I do today, tomorrow and Monday morning to get a qualified conversation booked?"

agent "VICTORIA — who do I call today" 5 \
  "Victoria who in our pipeline has shown any interest — clicks, opens, replies? Give me names, budgets, and exactly what I say when I contact them today."

agent "ALEXANDRA — top 10 leads right now" 2 \
  "Alexandra pull the top 10 highest scored leads. Who should I personally WhatsApp today? Give me name, company, budget and a suggested opening message."

agent "CHARLOTTE — LinkedIn post now" 4 \
  "Charlotte write the best LinkedIn post Julian can publish in the next 30 minutes to attract UAE and London HNW investors. Make it compelling and post-ready."

agent "EDWARD — investment memo" 3 \
  "Edward write a sharp one-paragraph investment case for Westminster Tower SE1 I can paste into a WhatsApp to a serious buyer today. Include yield, SDLT for overseas buyer, closing line."

agent "MARCUS — market angle this week" 6 \
  "Marcus what is the single strongest market angle for outreach this weekend? What is happening in London or UAE property right now that creates urgency for a buyer?"

echo ""
echo "════════════════════════════════════════"
echo "  BRIEF COMPLETE"
echo "════════════════════════════════════════"
