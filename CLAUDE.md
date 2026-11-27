# Dequem · Genealogia (repositório Duarte_Family)

Guia para quem for trabalhar neste código (pessoa ou IA). Leia antes de mexer.

## O que é
Site privado de árvore genealógica da família Duarte Melo, em https://familiaduartemelo.de, com a marca **Dequem** (linha "GENEALOGIA", frase "Ocê é fi dequem?").
O dono é o Leo (Wemerson Duarte Melo), que mora em Copenhague e fala português do Brasil.
A ideia é abrir para outras famílias: cada família tem o próprio "livro", separado dos outros.
O propósito, que está nos termos, é ter conversas de família, juntar as prosas num lugar só, unir as famílias e salvar as lembranças dos que se foram.

## Regras de trabalho com o Leo
- Escreva para ele em **português do Brasil**: frases curtas, sem jargão, sem emojis, sem travessão longo, começando pela conclusão.
- O texto do site também é em português do Brasil, simples (o público inclui gente mais velha no interior de Minas).
- Sempre que mudar algo, diga a ele como atualizar o servidor (abaixo).
- Commits e comentários do código em inglês (commits) e português (comentários), como já está.
- **Não mude a identidade visual por conta própria.** O logo (public/brand) é de autoria do Leo. Paleta e fontes foram escolhidas por ele: tema A creme no claro, B escuro no modo noturno e C verde como opção.
- Nunca descarte versões divergentes de relatos de família: todas são guardadas.

## Stack
- Node 22 + Express, better-sqlite3 (WAL), multer (uploads), sharp (fotos), bcryptjs, nodemailer, fflate. Sem framework no front: `public/app.js` em JS puro, `public/index.html`, `public/style.css`.
- Docker + Caddy (HTTPS automático) no servidor Strato (Ubuntu).
- Repositório: github.com/wemersomelo/Duarte_Family (público por enquanto; o Leo pensa em deixar privado).

## Rodar e testar
```
npm install
npm test        # migration.js, smoke.js, security.js, books.js: tudo precisa passar
DATA_DIR=/tmp/x PORT=3000 node server.js
```
Os testes usam pasta temporária e `SMTP_HOST=test` (os e-mails ficam em `mail.sent`). Toda funcionalidade nova ganha teste em `test/`.

## Atualizar o servidor (o Leo faz)
```
ssh root@familiaduartemelo.de          # pule se já estiver em root@ubuntu
cd ~/arvore && git pull && docker compose up -d --build
```
Backup diário: `scripts/backup.sh`, que guarda 30 dias em /root/backups-arvore e inclui os livros das famílias.

## Mapa do código
- `server.js`: todas as rotas e regras (cerca de 1.500 linhas). Seções marcadas com `// ---------- nome ----------`.
- `src/db.js`: esquema SQLite e migrações. Colunas novas sempre por `ALTER TABLE` com checagem `cols()`. Nunca apague dados antigos.
- `src/books.js`: livros por código (ver abaixo).
- `src/brand.js`: marca, lida do .env (BRAND_NAME, BRAND_LINE, BRAND_SLOGAN, FAMILY_SUBTITLE).
- `src/mail.js`: envio; sem SMTP configurado, o site funciona sem e-mail.
- `src/lote.js`, `src/relatos.js`: importação dos relatos de família (lote.csv / pastas de relato) e busca de duplicados.
- `src/sugestoes.js`: sugestões de ligações para o administrador. `src/gedcom.js`: exportação GEDCOM.
- `public/comecar.html/.js`: página pública para pedir um livro. `public/termos.html`: termos e privacidade (GDPR + LGPD), versão `TERMS_VERSION`.
- `scripts/novo-livro.sh`: método antigo, um site por subdomínio. Ainda funciona, mas o normal agora é o livro por código.

## Arquitetura dos livros (várias famílias)
- O site principal (`familiaduartemelo.de/`) é o livro da Família Duarte Melo, e o administrador é o Leo.
- Pedido em `/comecar` → aviso ao administrador → botão **Aprovar e criar o livro** → `books.create()` gera um código de 5 caracteres, sem I, L, O, 0 e 1 (ex.: `K7P2Q`).
- O livro fica em `familiaduartemelo.de/K7P2Q`, com dados em `data/livros-codigo/K7P2Q/`.
- A pessoa recebe por e-mail o link com `?chave=` (a chave de instalação) e cria a conta de administrador daquele livro.
- Cada livro roda como **processo separado** (fork do mesmo `server.js` com `BOOK_CODE`, `DATA_DIR`, `PORT`=socket unix).
  - O principal repassa `/K7P2Q/...` para ele (proxy em `src/books.js`).
  - O livro dorme depois de 30 min sem uso; perto da meia-noite de Brasília todos acordam para o resumo diário.
- Dentro do livro:
  - `BASE='/K7P2Q'`;
  - cookies com nome próprio (`sid_K7P2Q`, Path=/K7P2Q);
  - `baseUrl()` já inclui o BASE.
- No front, `BASE` vem de `<meta name="book-base">`. A função `api()` prefixa sozinha. Endereços montados à mão precisam de `${BASE}`, por exemplo `/api/files/...`, `/convite/`, `/senha/`, `/familia/`.
- Isolamento é regra: nada de um livro pode aparecer em outro. Há testes disso em `test/books.js`. Mantenha.

## Regras do site (já implementadas, não quebre)
**Papéis**
- admin, member (membro) e viewer (leitor).
- Visitante pelo "link da família" só vê: dos falecidos, tudo; dos vivos, só nome, apelido e ligações.

**Quem edita uma ficha** (`canManagePerson`)
- o administrador;
- a própria pessoa (quando se identificou com "Esta pessoa sou eu");
- quem cadastrou, enquanto a pessoa não assumir a ficha;
- os parentes diretos, se a pessoa já faleceu.

Parente não direto recebe um aviso para falar com os parentes diretos.

**"Esta pessoa sou eu" e "não sou eu"**
- "Esta pessoa sou eu" pede confirmação e avisa o administrador.
- "Não sou eu" desfaz tudo o que a pessoa alterou (`revertSelfChanges`).

**Avisos e resumo por e-mail**
- Avisos (`notifications`) vão para os parentes diretos e para o administrador quando alguém acrescenta ou muda algo.
- O resumo por e-mail é opcional: no máximo 1 por dia, à meia-noite de Brasília, com o que aconteceu até as 20h.

**Documentos e fotos**
- Documentos (`files.doc=1`), como certidões e carteira de trabalho, só o administrador vê. Os outros veem só os dados que entraram na ficha.
- A foto de perfil (`files.profile=1`) não se repete na galeria.

**Proteções dos termos**
- Contas só para maiores de 18 anos.
- Menores só com autorização dos responsáveis e com visão restrita.
- Cor/raça e origem de pessoa viva só a própria pessoa preenche.
- "Ocultar meus dados" (oposição).
- Denúncias de conteúdo.
- Exportar e apagar a conta.
- Aceite de termos versionado.

**Família**
- Cada pessoa tem um pai e uma mãe, casados ou não. Não existe "filho legítimo" e não deve existir.
- Meio-irmãos aparecem como "por parte de pai/mãe"; filhos aparecem agrupados pelo outro pai ou mãe; há a seção "Teve filhos com".
- A ficha tem seções: Pais, Cônjuge, Filhos e Irmãos fixas; Tios e Primos de cada lado recolhíveis, com contagem.
- O marcador "não teve / não deixou descendentes" tem nota explicando a diferença.

**Duplicados**
- A busca não pergunta sobre pessoas com pais conhecidos diferentes.
- O administrador junta fichas (merge) ou marca "pessoas diferentes".

**Entrar**
- Senha, código de 6 números por e-mail (10 min, 5 tentativas) ou "esqueci a senha" (link de 1 hora).
- As respostas nunca revelam se o e-mail tem conta.

**Segurança**
- CSP sem script inline.
- Bloqueio de outra origem (CSRF).
- Limite de tentativas.
- `X-Robots-Tag: noindex`.
- Uploads até MAX_UPLOAD_MB.

## Pendências conhecidas
- Revisão jurídica dos termos.
- Repositório privado.
- Registrar domínios (dequem.com, .com.br, .app) e a marca (EUIPO classes 9 e 42; INPI).
- LEGAL_EMAIL ainda é o Gmail do SMTP_USER (aparece publicamente nos termos).
- Domínio próprio da marca: hoje tudo mora em familiaduartemelo.de.
- Conferir no celular a ficha com meio-irmãos (feito por último, testado só automaticamente).

## Material da pesquisa (fora do código)
Os relatos e relatórios ficam no PC do Leo em `genealogical tree/relatorios/` e no projeto "GENEALOGIC TREE" do claude.ai. O site importa relatos pela pasta de entrada (`RELATOS_INBOX`) ou por Administrar.
