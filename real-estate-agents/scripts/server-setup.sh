#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  CM² Production Server Setup — Hetzner CX33 / Ubuntu 24.04
#  Run as root on the fresh server
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────
REAL_ESTATE_REPO="https://github.com/founder121/reimagined-journey"
REAL_ESTATE_SUBDIR="real-estate-agents"   # monorepo subfolder
CM2_WEBSITE_REPO=""                         # FILL IN: your cm2-website repo URL
APP_DIR="/home/cm2/app"
SERVER_IP="204.168.190.158"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

step() { echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${CYAN}  $1${NC}"; echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }
ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $1${NC}"; }
die()  { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

# ════════════════════════════════════════════════════════════════
step "STEP 1 — System update"
# ════════════════════════════════════════════════════════════════
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
ok "System updated"

# ════════════════════════════════════════════════════════════════
step "STEP 2 — Node.js 22"
# ════════════════════════════════════════════════════════════════
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>&1 | grep -v "^$" | tail -5
apt-get install -y nodejs
node --version
npm --version
ok "Node.js installed"

# ════════════════════════════════════════════════════════════════
step "STEP 3 — Global tools (pnpm, pm2, tsx)"
# ════════════════════════════════════════════════════════════════
npm install -g pnpm pm2 tsx --quiet
pnpm --version && ok "pnpm $(pnpm --version)"
pm2 --version  && ok "pm2  $(pm2 --version)"
tsx --version  && ok "tsx  $(tsx --version)"

# ════════════════════════════════════════════════════════════════
step "STEP 4 — System packages (nginx, certbot, chromium, git)"
# ════════════════════════════════════════════════════════════════
apt-get install -y nginx certbot python3-certbot-nginx \
  git curl wget unzip mysql-client \
  chromium-browser xvfb -qq

CHROMIUM=$(which chromium-browser 2>/dev/null || which chromium 2>/dev/null || echo "NOT FOUND")
ok "Chromium: $CHROMIUM"
nginx -v 2>&1 && ok "Nginx ready"

# ════════════════════════════════════════════════════════════════
step "STEP 5 — App user (cm2)"
# ════════════════════════════════════════════════════════════════
if id cm2 &>/dev/null; then
  warn "User cm2 already exists"
else
  useradd -m -s /bin/bash cm2
fi
mkdir -p $APP_DIR
chown -R cm2:cm2 /home/cm2
ok "User cm2 ready, home: /home/cm2"

# ════════════════════════════════════════════════════════════════
step "STEP 6 — Firewall (ufw)"
# ════════════════════════════════════════════════════════════════
ufw allow 22   comment 'SSH'
ufw allow 80   comment 'HTTP'
ufw allow 443  comment 'HTTPS'
ufw allow 3000 comment 'cm2-website'
ufw allow 3001 comment 'sc-agents UI'
ufw --force enable
ufw status verbose
ok "Firewall active"

# ════════════════════════════════════════════════════════════════
step "STEP 7 — SSH key for Claude Code"
# ════════════════════════════════════════════════════════════════
mkdir -p /root/.ssh
ssh-keygen -t ed25519 -C "claude-code@cm2" -f /root/.ssh/claude_code -N "" -q
cat /root/.ssh/claude_code.pub >> /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys

echo ""
echo "━━━━ PRIVATE KEY (save this for Claude Code) ━━━━"
cat /root/.ssh/claude_code
echo "━━━━ END PRIVATE KEY ━━━━"
echo ""
ok "SSH key pair generated"

# ════════════════════════════════════════════════════════════════
step "STEP 8 — Clone repositories"
# ════════════════════════════════════════════════════════════════
su - cm2 -c "
  set -e
  mkdir -p $APP_DIR
  cd $APP_DIR

  # Real-estate-agents (inside monorepo)
  if [ -d '$APP_DIR/reimagined-journey' ]; then
    echo 'Repo already cloned — pulling'
    cd '$APP_DIR/reimagined-journey' && git pull
  else
    git clone $REAL_ESTATE_REPO $APP_DIR/reimagined-journey
  fi

  # Symlink the subfolder for convenience
  ln -sfn $APP_DIR/reimagined-journey/$REAL_ESTATE_SUBDIR $APP_DIR/real-estate-agents

  # cm2-website (separate repo — fill in URL first)
  if [ -n '$CM2_WEBSITE_REPO' ]; then
    if [ -d '$APP_DIR/cm2-website' ]; then
      cd '$APP_DIR/cm2-website' && git pull
    else
      git clone $CM2_WEBSITE_REPO $APP_DIR/cm2-website
    fi
    echo 'cm2-website cloned'
  else
    echo 'WARNING: CM2_WEBSITE_REPO not set — skipping cm2-website clone'
  fi

  ls -la $APP_DIR/
"
ok "Repos ready"

# ════════════════════════════════════════════════════════════════
step "STEP 9 — Install dependencies"
# ════════════════════════════════════════════════════════════════
su - cm2 -c "
  set -e
  if [ -d '$APP_DIR/cm2-website' ]; then
    echo '→ pnpm install cm2-website'
    cd $APP_DIR/cm2-website && pnpm install --frozen-lockfile
  fi

  echo '→ npm install real-estate-agents'
  cd $APP_DIR/real-estate-agents && npm install
"
ok "Dependencies installed"

# ════════════════════════════════════════════════════════════════
step "STEP 10 — Environment files"
# ════════════════════════════════════════════════════════════════
# real-estate-agents .env (non-secret values pre-filled; secrets need your values)
cat > $APP_DIR/real-estate-agents/.env << 'ENVEOF'
# ── CM2 Bridge ──────────────────────────────────────────────────
CM2_BASE_URL=https://www.thecm2.com
CM2_API_KEY=REPLACE_WITH_REAL_KEY
CM2_PUSH_SCORE_MIN=5.0
CM2_RETRY_DELAY_MS=30000
CM2_REQUEST_TIMEOUT=10000

# ── API Keys ────────────────────────────────────────────────────
ANTHROPIC_API_KEY=REPLACE_WITH_REAL_KEY
COMPANIES_HOUSE_API_KEY=REPLACE_WITH_REAL_KEY
SENDGRID_API_KEY=REPLACE_WITH_REAL_KEY

# ── Server ──────────────────────────────────────────────────────
PORT=3001
NODE_ENV=production
ENVEOF

# cm2-website .env template (fill in from Manus)
if [ -d "$APP_DIR/cm2-website" ]; then
  cat > $APP_DIR/cm2-website/.env << 'ENVEOF'
# ── Fill all values from your Manus deployment ──────────────────
DATABASE_URL=REPLACE_WITH_REAL_VALUE
NEXTAUTH_SECRET=REPLACE_WITH_REAL_VALUE
NEXTAUTH_URL=https://thecm2.com
SENDGRID_API_KEY=REPLACE_WITH_REAL_KEY
NODE_ENV=production
PORT=3000
ENVEOF
fi

chown cm2:cm2 $APP_DIR/real-estate-agents/.env 2>/dev/null || true
chown cm2:cm2 $APP_DIR/cm2-website/.env 2>/dev/null || true

warn "ACTION NEEDED: Edit .env files and replace all REPLACE_WITH_REAL_* values"
warn "  nano $APP_DIR/real-estate-agents/.env"
warn "  nano $APP_DIR/cm2-website/.env"

# ════════════════════════════════════════════════════════════════
step "STEP 11 — Build & DB migrate (cm2-website)"
# ════════════════════════════════════════════════════════════════
if [ -d "$APP_DIR/cm2-website" ]; then
  su - cm2 -c "
    cd $APP_DIR/cm2-website
    pnpm build
    pnpm db:push
  " && ok "Build and DB migrate complete" || warn "Build/migrate failed — check .env values"
else
  warn "Skipping — cm2-website not cloned"
fi

# ════════════════════════════════════════════════════════════════
step "STEP 12 — PM2 ecosystem"
# ════════════════════════════════════════════════════════════════
cat > $APP_DIR/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'cm2-website',
      cwd: '/home/cm2/app/cm2-website',
      script: 'server/index.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      max_memory_restart: '1G',
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      error_file: '/home/cm2/logs/cm2-website.err',
      out_file:   '/home/cm2/logs/cm2-website.out'
    },
    {
      name: 'sc-agents',
      cwd: '/home/cm2/app/real-estate-agents',
      script: 'utils/commandCore.js',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '512M',
      cron_restart: '0 6 * * *',
      error_file: '/home/cm2/logs/sc-agents.err',
      out_file:   '/home/cm2/logs/sc-agents.out'
    },
    {
      name: 'sc-server',
      cwd: '/home/cm2/app/real-estate-agents',
      script: 'utils/webServer.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      max_memory_restart: '256M',
      error_file: '/home/cm2/logs/sc-server.err',
      out_file:   '/home/cm2/logs/sc-server.out'
    }
  ]
}
EOF

mkdir -p /home/cm2/logs
chown -R cm2:cm2 $APP_DIR/ecosystem.config.js /home/cm2/logs

su - cm2 -c "
  cd $APP_DIR
  pm2 start ecosystem.config.js
  pm2 save
"

env PATH=\$PATH:/usr/bin pm2 startup systemd -u cm2 --hp /home/cm2 | tail -2
systemctl daemon-reload
systemctl enable pm2-cm2

ok "PM2 running"
pm2 status

# ════════════════════════════════════════════════════════════════
step "STEP 13 — Nginx config"
# ════════════════════════════════════════════════════════════════
cat > /etc/nginx/sites-available/cm2 << 'EOF'
server {
    server_name thecm2.com www.thecm2.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        client_max_body_size 50M;
    }
}

server {
    server_name hq.thecm2.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}

server {
    server_name inbound.thecm2.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
EOF

ln -sf /etc/nginx/sites-available/cm2 /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ok "Nginx configured and reloaded"

# ════════════════════════════════════════════════════════════════
step "STEP 14 — Deploy script"
# ════════════════════════════════════════════════════════════════
cat > $APP_DIR/deploy.sh << 'EOF'
#!/bin/bash
set -e
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  CM² Deploy — $(date)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo "→ Pulling cm2-website..."
cd /home/cm2/app/cm2-website
git pull origin main
pnpm install --frozen-lockfile
pnpm build
pnpm db:push
pm2 restart cm2-website

echo "→ Pulling real-estate-agents..."
cd /home/cm2/app/reimagined-journey
git pull origin main
cd /home/cm2/app/real-estate-agents
npm install
pm2 restart sc-agents sc-server

echo "→ Deploy complete"
pm2 status
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
EOF

chmod +x $APP_DIR/deploy.sh
chown cm2:cm2 $APP_DIR/deploy.sh
ok "Deploy script: $APP_DIR/deploy.sh"

# ════════════════════════════════════════════════════════════════
step "STEP 15 — Final verification"
# ════════════════════════════════════════════════════════════════
echo ""
pm2 status
echo ""
nginx -t
echo ""
echo "→ Testing http://localhost:3000"
curl -s -o /dev/null -w "  cm2-website (port 3000): HTTP %{http_code}\n" http://localhost:3000 || echo "  cm2-website: not responding (start after .env is filled)"
echo "→ Testing http://localhost:3001/status"
curl -s http://localhost:3001/status | head -5 || echo "  sc-server: not responding"
echo ""
systemctl status nginx --no-pager -l | head -20

# ════════════════════════════════════════════════════════════════
step "STEP 16 — DNS records for Cloudflare"
# ════════════════════════════════════════════════════════════════
echo ""
echo "  Add these A records in Cloudflare → thecm2.com → DNS:"
echo ""
echo "  Type  Name       Value              Proxy"
echo "  ────  ─────────  ─────────────────  ───────────────"
echo "  A     @          $SERVER_IP         DNS only (grey)"
echo "  A     www        $SERVER_IP         DNS only (grey)"
echo "  A     hq         $SERVER_IP         DNS only (grey)"
echo "  A     inbound    $SERVER_IP         DNS only (grey)"
echo ""
echo "  After DNS propagates (10–30 min), run:"
echo ""
echo "  certbot --nginx \\"
echo "    -d thecm2.com \\"
echo "    -d www.thecm2.com \\"
echo "    -d hq.thecm2.com \\"
echo "    -d inbound.thecm2.com \\"
echo "    --non-interactive \\"
echo "    --agree-tos \\"
echo "    --email invest@thecm2.com"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete — next steps:"
echo "  1. Fill in .env files (see warnings above)"
echo "  2. Update Cloudflare DNS records"
echo "  3. Run certbot once DNS propagates"
echo "  4. Run: pm2 restart all"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
