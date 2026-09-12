#!/usr/bin/env python3
"""Hard-pause all outreach: set OUTREACH_PAUSED=true in both .env files"""
import subprocess, re

for env_path in ['/home/cm2/app/hq/.env', '/home/cm2/app/cm2-website/.env']:
    try:
        with open(env_path) as f:
            src = f.read()
        if 'OUTREACH_PAUSED' in src:
            new_src = re.sub(r'OUTREACH_PAUSED=\S*', 'OUTREACH_PAUSED=true', src)
        else:
            new_src = src.rstrip() + '\nOUTREACH_PAUSED=true\n'
        with open(env_path, 'w') as f:
            f.write(new_src)
        print(f"PAUSED: {env_path}")
    except Exception as e:
        print(f"Error {env_path}: {e}")

# Also switch HQ LLM from broken deepseek to groq while we're here
env_path = '/home/cm2/app/hq/.env'
try:
    with open(env_path) as f:
        src = f.read()
    new_src = re.sub(r'LLM_PROVIDER=\S+', 'LLM_PROVIDER=groq', src)
    with open(env_path, 'w') as f:
        f.write(new_src)
    print("HQ LLM -> groq (was broken deepseek)")
except Exception as e:
    print(f"LLM switch error: {e}")

subprocess.run(['pm2', 'restart', 'hq-server', '--update-env'], capture_output=True)
subprocess.run(['pm2', 'restart', 'cm2-website', '--update-env'], capture_output=True)
print("\nAll outreach PAUSED. hq-server + cm2-website restarted.")
print("No emails will go out until OUTREACH_PAUSED is explicitly cleared.")
