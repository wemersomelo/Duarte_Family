# Árvore da Família

Um app privado de árvore genealógica que **você mesmo hospeda**. Os dados da família ficam no seu servidor, não num site comercial.

- Só entra quem recebe um **convite** (link de uso único, vale 30 dias).
- **Link da família** (opcional): um link único, sem cadastro, para mandar no grupo. Mostra tudo dos falecidos e, dos vivos, só nome e ligações. O administrador troca ou desliga o link quando quiser. Conta como falecido quem tem data ou local de falecimento, ou nasceu até 1915 (ajuste com `FALECIDOS_ATE_ANO`).
- Quem entra pelo link pode **pedir para participar** (nome, e-mail, parentesco). O administrador aprova, e o convite só funciona com aquele e-mail.
- Todos os convidados **veem** a árvore inteira e podem deixar **lembranças**, **fotos e documentos** (JPG, PNG, HEIC, PDF) e **links de vídeos** em qualquer pessoa.
- Quem tem acesso "Pode adicionar" também acrescenta pessoas, pais, filhos, cônjuges e **informações**.
- Cada pessoa pode ter uma **foto principal**, que aparece na ficha e na árvore.
- **Cada pessoa só altera ou remove o que ela mesma adicionou.** Para corrigir algo de outra pessoa, usa "Acrescentar informação".
- O **administrador** altera tudo, convida, bloqueia contas, exporta e importa.
- Funciona no celular e pode ser instalado na tela inicial ("Adicionar à tela de início").
- Exporta em **JSON** (cópia completa) e **GEDCOM** (formato padrão de genealogia).

Este repositório guarda **só o código**. Nenhum dado da família vai para cá: a pasta `data/` fica no servidor e é ignorada pelo Git.

---

## Colocar no ar (servidor próprio, ~1 hora)

Você precisa de:
1. **Um servidor pequeno (VPS)** com Ubuntu. Qualquer um com 1 GB de memória serve (por exemplo Hetzner CX22, a partir de uns 4 euros por mês).
2. **Um endereço** (domínio ou subdomínio) apontando para o IP do servidor. Pode ser um domínio seu (`arvore.seusite.com`) ou um subdomínio gratuito (por exemplo DuckDNS). O HTTPS é configurado automaticamente.

No servidor, como administrador:

```bash
# 1. Instalar Docker
curl -fsSL https://get.docker.com | sh

# 2. Baixar o código
git clone https://github.com/wemersomelo/duarte_family.git arvore
cd arvore

# 3. Configurar
cp .env.example .env
nano .env            # preencha DOMAIN e troque SETUP_KEY por uma frase longa

# 4. Pasta dos dados (fica só no servidor)
mkdir -p data && sudo chown 1000:1000 data

# 5. Ligar
sudo docker compose up -d --build
```

Depois:
1. Abra `https://SEU-ENDERECO` e crie a conta de **administrador** (vai pedir a `SETUP_KEY`).
2. Em **Administrar → Importar**, envie o arquivo `arvore-familia-AAAA-MM-DD.json` com os dados atuais.
3. Em **Administrar → Convidar parente**, crie um convite para cada pessoa e mande o link por WhatsApp.

### Atualizar o app
```bash
cd arvore && git pull && sudo docker compose up -d --build
```

### Proteger o servidor (uma vez)
```bash
cd ~/arvore && sudo bash scripts/proteger-servidor.sh
```
Liga o firewall, bloqueia tentativas de adivinhar a senha do SSH (fail2ban), ativa atualizações de segurança automáticas e agenda uma cópia diária da árvore em `/root/backups-arvore` (guarda 30 dias).

### Cópias de segurança
Tudo fica na pasta `data/` (o banco `arvore.db` e a pasta `uploads/` com os documentos). Para guardar uma cópia:
```bash
cd arvore && sudo tar czf ~/backup-arvore-$(date +%F).tgz data
```
Baixe esse arquivo para o seu computador de vez em quando. Pelo app, **Administrar → Baixar dados (JSON)** e **Baixar GEDCOM** também servem como cópia.

---

## Testar no próprio computador

Precisa do Node.js 20 ou mais novo.

```bash
npm install
npm start          # abre em http://localhost:3000
npm test           # testa as regras de acesso
```

### E-mail automático

Quando um parente pede para participar, você recebe um e-mail. Quando você aprova, a pessoa recebe um e-mail com o link para criar a senha (isso confirma o e-mail dela). Para ligar, preencha no `.env` `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` e `SMTP_PASS` (na Strato: `smtp.strato.de`, porta `465`, o endereço completo e a senha de uma caixa de e-mail do domínio) e reinicie com `docker compose up -d`. Sem isso, o site continua funcionando e você manda o convite à mão.

Variáveis úteis: `DATA_DIR` (onde guardar os dados), `PORT`, `FAMILY_NAME`, `DEFAULT_PERSON`, `SETUP_KEY`, `MAX_UPLOAD_MB`, `MAX_USER_STORAGE_MB` (limite de envio por pessoa, padrão 2000), `COOKIE_SECURE=1` (use atrás de HTTPS).

## Como funciona por dentro

- `server.js`: servidor (Node.js + Express), contas, convites, regras de acesso, envio de arquivos, exportação.
- `src/db.js`: banco SQLite (um único arquivo, fácil de copiar).
- `src/gedcom.js`: exportação GEDCOM.
- `public/`: a página (HTML, CSS e JavaScript, sem dependências externas).
- Senhas guardadas com bcrypt; sessão por cookie HttpOnly e Secure; limite de tentativas de login por conta e por endereço; limite de alterações por hora.
- Documentos só abrem para quem está logado. Fotos passam por verificação e têm os dados escondidos removidos (localização GPS, modelo do celular). Arquivos disfarçados são recusados.
- Cabeçalhos de proteção (CSP, HSTS, anti-iframe) e aviso para buscadores não indexarem o site.
- Histórico de ações para o administrador; itens removidos ficam guardados no histórico e fotos removidas vão para `data/uploads/lixeira`.
- O administrador cria links de nova senha para quem esqueceu a sua.

## Marca e famílias de teste

- **Trocar o nome do site:** no `.env`, mude `BRAND_NAME`, `BRAND_LINE`, `BRAND_SLOGAN` e `FAMILY_SUBTITLE` e rode `docker compose up -d`. O título, a tela de entrada, o topo, o app do celular e os e-mails mudam juntos. O logo fica em `public/brand/`.
- **Livros por código (o jeito normal):** quem pede em `/comecar` aparece nos Avisos e em Administrar → Famílias pedindo um livro. Toque em **Aprovar e criar o livro**: o site cria o livro com um código de 5 letras e números (ex.: `K7P2Q`), em `seu-site/K7P2Q`, e manda para a pessoa o endereço e a chave de instalação. Cada livro tem banco, fotos e contas próprios (`data/livros-codigo/<código>`), roda num processo separado que dorme sem uso e acorda no próximo acesso, e entra na cópia de segurança diária. Não precisa de terminal nem de DNS.
- **Entrar com código por e-mail:** além da senha, a pessoa pode pedir um código de 6 números (vale 10 minutos, 5 tentativas). Precisa do e-mail configurado (SMTP_*).
- **Abrir um livro com endereço próprio (antigo, opcional):** `scripts/novo-livro.sh <apelido> <endereço> "<Nome da família>" <e-mail> ["<cidade, UF>"]`. Avisa se já existe livro com o mesmo sobrenome (pode ser um ramo da mesma família) e guarda a lista em `data/livros.tsv`, que o site usa para marcar pedidos "pode ser a mesma família". Cria um site separado no mesmo servidor, com dados, contas e senha de instalação próprios, e o endereço no Caddy. O endereço precisa apontar para o servidor (registro A). As cópias de segurança diárias já incluem os livros.
