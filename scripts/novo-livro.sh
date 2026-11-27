#!/usr/bin/env bash
# Cria um "livro" (site separado) para uma família de teste, no mesmo servidor.
# Uso:  scripts/novo-livro.sh <apelido> <endereço> "<Nome sugerido da família>" <e-mail do responsável> ["<cidade, UF>"]
# O nome é só uma sugestão: a família confirma ou troca na instalação e pode mudar depois em Administrar.
# Ex.:  scripts/novo-livro.sh silva-itaipe silva-itaipe.familiaduartemelo.de "Família Silva · Itaipé" ana@exemplo.com "Itaipé, MG"
# Usar o lugar no apelido e no nome evita confundir famílias diferentes com o mesmo sobrenome.
# Cada livro tem os seus próprios dados, contas e senha de instalação. Nada é misturado com a sua árvore.
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -eq 4 ] || [ $# -eq 5 ] || { echo 'Uso: scripts/novo-livro.sh <apelido> <endereço> "<Nome da família>" <e-mail do responsável> ["<cidade, UF>"]'; exit 1; }
SLUG="$1"; DOM="$2"; FAM="$3"; RESP="$4"; LUGAR="${5:-}"
REG=data/livros.tsv   # lista dos livros criados (o site principal usa para avisar "pode ser a mesma família")
mkdir -p data; touch "$REG"
simples() { echo "$1" | sed 's/á/a/g;s/à/a/g;s/â/a/g;s/ã/a/g;s/é/e/g;s/ê/e/g;s/í/i/g;s/ó/o/g;s/ô/o/g;s/õ/o/g;s/ú/u/g;s/ü/u/g;s/ç/c/g;s/Á/a/g;s/À/a/g;s/Â/a/g;s/Ã/a/g;s/É/e/g;s/Ê/e/g;s/Í/i/g;s/Ó/o/g;s/Ô/o/g;s/Õ/o/g;s/Ú/u/g;s/Ç/c/g' | tr 'A-Z' 'a-z' | tr -c 'a-z\n' ' '; }
lugar_slug() { simples "$1" | awk '{print $1}'; }
[[ "$SLUG" =~ ^[a-z0-9-]{2,30}$ ]] || { echo "O apelido só pode ter letras minúsculas, números e hífen (ex.: silva)."; exit 1; }
if [ -e "livros/$SLUG" ]; then
  echo "Já existe um livro com o apelido $SLUG."
  L=$(lugar_slug "$LUGAR"); case "$SLUG" in *"$L"*|"") SUG="$SLUG-2";; *) SUG="$SLUG-$L";; esac
  echo "Sugestão: use $SUG (com o lugar no apelido e no endereço)."
  exit 1
fi
# Mesmo sobrenome em outro livro? Avisa antes de criar: pode ser um ramo da mesma família.
PARECIDOS=""
for w in $(simples "$FAM"); do
  case "$w" in familia|de|da|do|das|dos|e) continue;; esac
  [ ${#w} -gt 2 ] || continue
  while IFS=$'\t' read -r s2 d2 f2 l2; do
    [ -n "$s2" ] || continue
    if simples "$f2" | grep -qw "$w"; then PARECIDOS="$PARECIDOS\n  - $f2${l2:+ ($l2)} em https://$d2"; fi
  done < "$REG"
done
if [ -n "$PARECIDOS" ]; then
  echo "Atenção: já existe livro com o mesmo sobrenome:"; echo -e "$PARECIDOS" | sed "/^$/d" | sort -u
  echo "Se for a mesma família, o melhor é convidar a pessoa para o livro que já existe."
  read -r -p "Criar mesmo assim um livro separado? (s/N) " R
  [ "$R" = "s" ] || [ "$R" = "S" ] || { echo "Nada foi criado."; exit 0; }
fi
[ -f .env ] || { echo "Falta o .env principal."; exit 1; }
mkdir -p "livros/$SLUG/data"
KEY=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
{
  echo "DOMAIN=$DOM"
  echo "FAMILY_SUBTITLE=$FAM"
  echo "SETUP_KEY=$KEY"
  echo "HUB_URL=https://$(get DOMAIN)"
  for v in BRAND_NAME BRAND_LINE BRAND_SLOGAN LEGAL_NAME LEGAL_EMAIL LEGAL_ADDRESS SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM MAX_UPLOAD_MB MAX_USER_STORAGE_MB; do x=$(get $v); [ -n "$x" ] && echo "$v=$x"; done
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
printf '%s\t%s\t%s\t%s\n' "$SLUG" "$DOM" "$FAM" "$LUGAR" >> "$REG"
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
