#!/usr/bin/env python3
"""Breakup email investigation + Karen prompt location"""
import subprocess, os, re

DB = ["mysql", "-u", "cm2", "-pcm2secure2026", "cm2db", "--table"]

def q(label, sql):
    r = subprocess.run(DB + ["-e", sql], capture_output=True, text=True)
    print(f"\n=== {label} ===")
    print(r.stdout.strip() or r.stderr.strip())

q("1. Contactable segment (budget+market populated)",
  "SELECT COUNT(*) contactable FROM investorLeads "
  "WHERE doNotContact=0 AND LENGTH(COALESCE(investmentBudget,''))>0 "
  "AND LENGTH(COALESCE(mandateInterest,''))>0")

q("2. Distribution by sequenceStep",
  "SELECT sequenceStep, COUNT(*) n, "
  "SUM(replied) replied, SUM(genuineReply) genuine, "
  "SUM(lastClickedAt IS NOT NULL) clicked "
  "FROM investorLeads WHERE doNotContact=0 "
  "GROUP BY sequenceStep ORDER BY sequenceStep")

q("3. Max sequence steps defined",
  "SELECT MAX(stepNumber) max_steps FROM sequenceCampaigns")

q("4. Breakup eligible (sequenced, zero engagement)",
  "SELECT COUNT(*) breakup_eligible FROM investorLeads "
  "WHERE doNotContact=0 AND replied=0 AND genuineReply=0 "
  "AND lastClickedAt IS NULL AND sequenceStep > 0")

q("5. Sample breakup-eligible leads (top 5)",
  "SELECT id, name, email, investmentBudget, mandateInterest, sequenceStep "
  "FROM investorLeads WHERE doNotContact=0 AND replied=0 "
  "AND genuineReply=0 AND lastClickedAt IS NULL AND sequenceStep > 0 "
  "ORDER BY sequenceStep DESC, lead_score DESC LIMIT 5")

# OUTREACH_PAUSED flag
print("\n=== 6. OUTREACH_PAUSED / lock state ===")
env_path = "/home/cm2/app/cm2-website/.env"
if os.path.exists(env_path):
    for line in open(env_path):
        if "OUTREACH_PAUSED" in line or "master_outreach" in line.lower():
            print(line.strip())
else:
    print(f"{env_path} not found")

# Karen prompt location
print("\n=== 7. Karen AGENT_PROMPTS location ===")
hq = "/home/cm2/app/hq/server.js"
if os.path.exists(hq):
    lines = open(hq).readlines()
    for i, l in enumerate(lines):
        if "AGENT_PROMPTS" in l:
            print(f"Line {i+1}: {l.rstrip()}")
            # Show a few lines of context
            for j in range(i, min(i+5, len(lines))):
                print(f"  {j+1}: {lines[j].rstrip()}")
            break
else:
    print(f"{hq} not found")
