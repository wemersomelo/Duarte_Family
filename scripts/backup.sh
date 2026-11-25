#!/usr/bin/env bash
# Cópia de segurança diária da árvore. Guarda 30 dias em /root/backups-arvore.
# Instalado automaticamente por scripts/proteger-servidor.sh.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/root/backups-arvore
mkdir -p "$DEST"
cd "$APP_DIR"
# Cópia consistente do banco, feita com o app ligado.
docker compose exec -T arvore node -e "require('better-sqlite3')('/data/arvore.db',{readonly:true}).backup('/data/backup-temp.db').then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"
STAMP=$(date +%F)
tar czf "$DEST/arvore-$STAMP.tgz" -C "$APP_DIR/data" backup-temp.db uploads
rm -f "$APP_DIR/data/backup-temp.db"
chmod 600 "$DEST/arvore-$STAMP.tgz"
find "$DEST" -name 'arvore-*.tgz' -mtime +30 -delete
echo "Cópia salva: $DEST/arvore-$STAMP.tgz"
