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
# Livros das famílias de teste (scripts/novo-livro.sh)
for d in "$APP_DIR"/livros/*/; do
  [ -d "$d/data" ] || continue
  s=$(basename "$d")
  docker compose exec -T "livro-$s" node -e "require('better-sqlite3')('/data/arvore.db',{readonly:true}).backup('/data/backup-temp.db').then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})" || continue
  tar czf "$DEST/livro-$s-$STAMP.tgz" -C "$d/data" backup-temp.db $( [ -d "$d/data/uploads" ] && echo uploads )
  rm -f "$d/data/backup-temp.db"; chmod 600 "$DEST/livro-$s-$STAMP.tgz"
done
# Livros por código (familiaduartemelo.de/K7P2Q): ficam dentro de data/livros-codigo
for d in "$APP_DIR"/data/livros-codigo/*/; do
  [ -f "$d/arvore.db" ] || continue
  c=$(basename "$d")
  docker compose exec -T arvore node -e "require('better-sqlite3')('/data/livros-codigo/$c/arvore.db',{readonly:true}).backup('/data/livros-codigo/$c/backup-temp.db').then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})" || continue
  tar czf "$DEST/livro-$c-$STAMP.tgz" -C "$d" backup-temp.db $( [ -d "$d/uploads" ] && echo uploads )
  rm -f "$d/backup-temp.db"; chmod 600 "$DEST/livro-$c-$STAMP.tgz"
done
find "$DEST" -name 'livro-*.tgz' -mtime +30 -delete
