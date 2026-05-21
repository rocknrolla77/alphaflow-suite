#!/bin/bash
# Файл: devops/setup-debian.sh
# Инициализация GCP Debian инстанса (instance-20260330-115005)
# Запуск: sudo bash devops/setup-debian.sh

set -euo pipefail

echo "═══════════════════════════════════════════════════════════════"
echo "  AlphaFlow Suite — Server Infrastructure Setup"
echo "  Instance: instance-20260330-115005"
echo "═══════════════════════════════════════════════════════════════"

# ─── 1. Logrotate: предотвращение переполнения диска логами ──────────

mkdir -p /var/log/alphaflow

cat << 'EOF' > /etc/logrotate.d/alphaflow
/var/log/alphaflow/*.log {
    su root root
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    maxsize 50M
    create 0640 nodejs nodejs
}
EOF

echo "[1/7] Logrotate configured (maxsize 50M, rotate 7)"

# ─── 2. Cron: автоматическая очистка ─────────────────────────────────

cat << 'EOF' > /etc/cron.daily/alphaflow-cleanup
#!/bin/bash
# AlphaFlow Daily Cleanup
set -e

# System package cache
apt-get clean -y 2>/dev/null

# Temp files older than 2 days
find /tmp -type f -mtime +2 -delete 2>/dev/null || true

# NPM cache (prevents 'No space left on device')
if command -v npm &>/dev/null; then
    npm cache clean --force 2>/dev/null || true
fi

# Docker dangling images (если используется)
if command -v docker &>/dev/null; then
    docker image prune -f 2>/dev/null || true
    docker builder prune -f --keep-storage 2G 2>/dev/null || true
fi

# Journal vacuum (keep 100M max)
journalctl --vacuum-size=100M 2>/dev/null || true

echo "$(date): AlphaFlow cleanup completed" >> /var/log/alphaflow/cleanup.log
EOF

chmod +x /etc/cron.daily/alphaflow-cleanup
echo "[2/7] Daily cleanup cron installed"

# ─── 3. Redis с AOF persistence ──────────────────────────────────────

if ! command -v redis-server &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq redis-server
fi

# Configure Redis for production
cat << 'EOF' > /etc/redis/alphaflow.conf
# AlphaFlow Redis Config
bind 127.0.0.1
port 6379
timeout 300
tcp-keepalive 60

# Persistence: AOF for FSM state recovery
appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb

# Memory limit (prevent OOM kill)
maxmemory 512mb
maxmemory-policy allkeys-lru

# Security
requirepass ${REDIS_PASSWORD:-alphaflow_dev_password}

# Logging
logfile /var/log/alphaflow/redis.log
loglevel notice
EOF

systemctl restart redis-server
echo "[3/7] Redis configured (AOF, 512MB limit, password)"

# ─── 4. Node.js 20 LTS ───────────────────────────────────────────────

if ! command -v node &>/dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

echo "[4/7] Node.js $(node -v) ready"

# ─── 5. Docker + Docker Compose (для Phala DStack) ───────────────────

if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | bash
    usermod -aG docker nodejs 2>/dev/null || true
fi

echo "[5/7] Docker $(docker --version | cut -d' ' -f3) ready"

# ─── 6. Disk monitoring (alert at 85%) ───────────────────────────────

cat << 'EOF' > /etc/cron.hourly/disk-alert
#!/bin/bash
USAGE=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$USAGE" -gt 85 ]; then
    echo "$(date): DISK WARNING: ${USAGE}% used" >> /var/log/alphaflow/disk-alert.log
    # TODO: Send Telegram alert via bot
fi
EOF

chmod +x /etc/cron.hourly/disk-alert
echo "[6/7] Disk monitoring (85% threshold) installed"

# ─── 7. Firewall (only necessary ports) ──────────────────────────────

if command -v ufw &>/dev/null; then
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow 22/tcp    # SSH
    ufw allow 3001/tcp  # BFF API (internal, behind Cloudflare Tunnel)
    ufw allow 443/tcp   # HTTPS (Cloudflare Tunnel)
    ufw --force enable
    echo "[7/7] UFW firewall configured"
else
    echo "[7/7] UFW not installed — skipping firewall"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✅ Infrastructure setup complete"
echo "═══════════════════════════════════════════════════════════════"
