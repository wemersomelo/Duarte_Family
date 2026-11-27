#!/usr/bin/env bash
# Cria um "livro" (site separado) para uma família de teste, no mesmo servidor.
# Uso:  scripts/novo-livro.sh <apelido> <endereço> "<Nome sugerido da família>" <e-mail do responsável>
# O nome é só uma sugestão: a família confirma ou troca na instalação e pode mudar depois em Administrar.
# Ex.:  scripts/novo-livro.sh silva silva.familiaduartemelo.de "Família Silva" ana@exemplo.com
# Cada livro tem os seus próprios dados, contas e senha de instalação. Nada é misturado com a sua árvore.
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -eq 4 ] || { echo 'Uso: scripts/novo-livro.sh <apelido> <endereço> "<Nome da família>" <e-mail do responsável>'; exit 1; }
SLUG="$1"; DOM="$2"; FAM="$3"; RESP="$4"
[[ "$SLUG" =~ ^[a-z0-9-]{2,30}$ ]] || { echo "O apelido só pode ter letras minúsculas, números e hífen (ex.: silva)."; exit 1; }
[ -e "livros/$SLUG" ] && { echo "Já existe um livro com o apelido $SLUG."; exit 1; }
[ -f .env ] || { echo "Falta o .env principal."; exit 1; }
mkdir -p "livros/$SLUG/data"
KEY=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
{
  echo "DOMAIN=$DOM"
  echo "FAMILY_SUBTITLE=$FAM"
  echo "SETUP_KEY=$KEY"
  for v in BRAND_NAME BRAND_LINE BRAND_SLOGAN SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM MAX_UPLOAD_MB MAX_USER_STORAGE_MB; do x=$(get $v); [ -n "$x" ] && echo "$v=$x"; done
  echo "# responsável pelo teste: $RESP"
} > "livros/$SLUG/.env"
chmod 600 "livros/$SLUG/.env"
# serviço do livro
[ -f docker-compose.livros.yml ] || echo "services:" > docker-compose.livros.yml
cat >> docker-compose.livros.yml <<YML
  livro-$SLUG:
    build: .
    restart: unless-stopped
    env_file: livros/$SLUG/.env
    environment:
      COOKIE_SECURE: "1"
      RELATOS_INBOX: /data/relatos-entrada
    volumes:
      - ./livros/$SLUG/data:/data
YML
# endereço no Caddy
cat > "livros-caddy/$SLUG.caddy" <<CADDY
$DOM {
	encode gzip
	request_body {
		max_size 220MB
	}
	header -Server
	reverse_proxy livro-$SLUG:3000
}
CADDY
# o "docker compose" passa a ler também os livros
grep -q '^COMPOSE_FILE=' .env || echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.livros.yml' >> .env
docker compose up -d --build
docker compose restart caddy
cat <<MSG

Pronto. Livro "$FAM" criado.
1. O endereço $DOM precisa apontar para este servidor (registro A no painel da Strato).
2. Mande para $RESP:
   - o endereço: https://$DOM
   - a senha de instalação: $KEY
   Na primeira visita, a pessoa cria a conta de administrador daquele livro com essa senha
   e escolhe o nome da família (vem preenchido com "$FAM", mas ela pode trocar).
MSG
