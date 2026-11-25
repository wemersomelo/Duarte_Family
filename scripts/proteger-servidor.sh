#!/usr/bin/env bash
# Proteção básica do servidor (Ubuntu/Debian). Rode uma vez, como root:
#   cd ~/arvore && bash scripts/proteger-servidor.sh
# O que faz:
#  1. Firewall (ufw): só a porta do SSH, 80 e 443 ficam abertas
#  2. fail2ban: bloqueia quem tenta adivinhar a senha do SSH
#  3. Atualizações de segurança automáticas do sistema
#  4. Cópia de segurança diária da árvore (guarda 30 dias)
# Não mexe nas senhas nem no login do SSH.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Rode como root."; exit 1; }
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')
SSH_PORT=${SSH_PORT:-22}
echo "Porta do SSH detectada: $SSH_PORT"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ufw fail2ban unattended-upgrades >/dev/null

echo "1/4 Firewall"
ufw allow "$SSH_PORT"/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,12p'

echo "2/4 fail2ban"
cat > /etc/fail2ban/jail.d/sshd-arvore.local <<CONF
[sshd]
enabled = true
port = $SSH_PORT
maxretry = 5
findtime = 10m
bantime = 1h
CONF
systemctl enable --now fail2ban >/dev/null 2>&1
systemctl restart fail2ban

echo "3/4 Atualizações automáticas"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<CONF
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

echo "4/4 Cópia de segurança diária (3h da manhã)"
chmod +x "$APP_DIR/scripts/backup.sh"
echo "0 3 * * * root $APP_DIR/scripts/backup.sh >> /var/log/arvore-backup.log 2>&1" > /etc/cron.d/arvore-backup
"$APP_DIR/scripts/backup.sh"

echo
echo "Pronto. Firewall ativo, fail2ban ativo, atualizações automáticas e cópia diária configurados."
