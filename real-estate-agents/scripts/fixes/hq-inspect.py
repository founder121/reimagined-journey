#!/usr/bin/env python3
"""HQ server inspection — agent prompts, tools, PM2 status"""
import subprocess, os, re, json

def sh(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return (r.stdout + r.stderr).strip()

print("\n=== PM2 STATUS ===")
print(sh("pm2 list 2>/dev/null || echo 'pm2 not found'"))

HQ = "/home/cm2/app/hq/server.js"
print(f"\n=== HQ FILE SIZE ===")
if os.path.exists(HQ):
    size = os.path.getsize(HQ)
    print(f"{HQ}: {size} bytes")
else:
    print(f"{HQ} NOT FOUND")
    # search for it
    found = sh("find /home/cm2 -name 'server.js' 2>/dev/null | head -10")
    print("Searching:", found)
    exit(0)

src = open(HQ).read()
lines = src.splitlines()

print(f"\n=== APP STRUCTURE (/home/cm2/app) ===")
print(sh("ls /home/cm2/app/"))

print(f"\n=== AGENT PROMPT LINES (first 60) ===")
for i, l in enumerate(lines):
    if any(k in l for k in ["AGENT_PROMPT", "agentPrompt", "systemPrompt", "system_prompt",
                              "karen", "Karen", "alexandra", "Alexandra", "Victoria",
                              "charlotte", "Charlotte"]):
        print(f"{i+1}: {l.rstrip()}")

print(f"\n=== TOOL DEFINITION LINES ===")
for i, l in enumerate(lines):
    if any(k in l for k in ["tools:", "\"tools\"", "function_call", "tool_choice",
                              "\"name\":", "functions:"]):
        if any(k in l for k in ["send", "email", "whatsapp", "insert", "create", "search",
                                  "find", "lead", "outreach", "message"]):
            print(f"{i+1}: {l.rstrip()}")

print(f"\n=== CRON / SCHEDULE LINES ===")
for i, l in enumerate(lines):
    if any(k in l for k in ["cron", "schedule", "setInterval", "setTimeout",
                              "runAgent", "triggerAgent", "agent.*run", "run.*agent"]):
        print(f"{i+1}: {l.rstrip()}")

print(f"\n=== API ROUTES (/api) ===")
for i, l in enumerate(lines):
    if "app.get" in l or "app.post" in l or "router.get" in l or "router.post" in l:
        print(f"{i+1}: {l.rstrip()}")

print(f"\n=== ENV KEYS (no values) ===")
env_path = "/home/cm2/app/hq/.env"
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if line and not line.startswith("#"):
            key = line.split("=")[0]
            has_val = "=".join(line.split("=")[1:]).strip() != ""
            print(f"  {key} = {'[SET]' if has_val else '[EMPTY]'}")
else:
    print(f"{env_path} not found")
    print(sh("find /home/cm2/app/hq -name '.env' 2>/dev/null"))

print(f"\n=== HQ LAST 30 LOG LINES ===")
print(sh("pm2 logs hq-server --lines 30 --nostream 2>/dev/null || tail -30 /home/cm2/.pm2/logs/hq-server-out.log 2>/dev/null"))

print("\n=== DONE ===")
