#!/usr/bin/env python3
"""Switch HQ LLM from deepseek to groq and restart. Groq key already present."""
import subprocess, re, os

env_path = '/home/cm2/app/hq/.env'

with open(env_path) as f:
    src = f.read()

m = re.search(r'LLM_PROVIDER=(\S+)', src)
current = m.group(1) if m else 'NOT FOUND'
print(f"Current LLM_PROVIDER: {current}")

if current == 'groq':
    print("Already on groq — no change needed.")
else:
    new_src = re.sub(r'LLM_PROVIDER=\S+', 'LLM_PROVIDER=groq', src)
    with open(env_path, 'w') as f:
        f.write(new_src)
    print("Switched LLM_PROVIDER -> groq")

# Confirm GROQ_API_KEY is present
gk = re.search(r'GROQ_API_KEY=(\S+)', src)
print(f"GROQ_API_KEY: {'SET (' + gk.group(1)[:8] + '...)' if gk and gk.group(1) else 'MISSING!'}")

# Restart hq-server
print("\nRestarting hq-server...")
r = subprocess.run(['pm2', 'restart', 'hq-server', '--update-env'], capture_output=True, text=True)
print(r.stdout.strip() or r.stderr.strip())

import time; time.sleep(4)

# Show last 15 error log lines
print("\n=== HQ error log (last 15 lines) ===")
r2 = subprocess.run(
    ['pm2', 'logs', 'hq-server', '--lines', '15', '--nostream', '--err'],
    capture_output=True, text=True
)
print(r2.stdout.strip() or r2.stderr.strip())

print("\n=== Done ===")
