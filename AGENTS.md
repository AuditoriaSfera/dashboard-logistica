# Guia para IAs e desenvolvedores — Dashboard Logística

Leia este arquivo ANTES de alterar, commitar ou publicar. Ele existe para que qualquer IA/pessoa consiga
publicar sem quebrar o Railway e **sem precisar pedir o log de erro do Railway ao usuário**.

## Como o deploy funciona

- Repositório: `https://github.com/AuditoriaSfera/dashboard-logistica`, branch **`main`**.
- O Railway (conta diferente da conta de quem desenvolve) está conectado ao GitHub e **publica sozinho a cada
  push na `main`** (~1–2 min). Não existe outro caminho: não há acesso à CLI/painel do Railway, não use
  `railway up`, não tente logar no Railway.
- URL de produção: `https://dashboard-logistica-production.up.railway.app/`
- Não há `Dockerfile`/`railway.json`: o Railway detecta Node + pnpm pelo `package.json`/`pnpm-lock.yaml`
  e roda `npm run build` (`vinext build`) e `npm start` (`vinext start`).
- Em produção roda **somente** o app vinext (`app/` + `app/api/*`). O `server/index.mjs` (Express, porta 8788,
  lê o Excel) é **apenas local/desenvolvimento** — nada que dependa dele funciona online.

## Antes de TODO push (obrigatório)

```bash
pnpm install --frozen-lockfile   # se mexeu em dependências, atualize e commite o pnpm-lock.yaml
npm run verify                   # tsc --noEmit + testes + build de produção
```

Só faça push se `npm run verify` passar. O `vinext build` **não checa tipos**, então um build verde sozinho não
garante nada — por isso o `tsc` faz parte do `verify`. Os testes de `parser` são ignorados (skip) quando a planilha
`Novas Premiações.xlsx` não existe na máquina; isso é esperado.

## Como commitar e publicar

1. Trabalhe direto na `main` (é o fluxo atual) ou em branch e faça merge — o que importa é o que chega na `main`.
2. Mensagem no padrão já usado: `fix: ...`, `feat: ...` (português ou inglês, uma linha objetiva + corpo se precisar).
3. `git pull --rebase origin main` antes do push (outras IAs/pessoas também publicam; evite sobrescrever).
4. `git push origin main`. **Nunca** use `--force` na `main`.
5. Um push = um deploy. Evite sequência de pushes pequenos em poucos segundos: o Railway cancela o deploy anterior
   (aparece como `in_progress` → `inactive`, não é erro).

## Confirmar que o deploy deu certo SEM acesso ao Railway

O Railway reporta cada deploy ao GitHub. Consulte pela API pública (sem token):

```bash
# estados do deploy mais recente: esperado  in_progress > success
curl -s "https://api.github.com/repos/AuditoriaSfera/dashboard-logistica/deployments?per_page=1"
# pegue o "id" e depois:
curl -s "https://api.github.com/repos/AuditoriaSfera/dashboard-logistica/deployments/<ID>/statuses"
```

- `success` = publicado. `failure`/`error` ou ficar só em `in_progress` por mais de ~5 min = build quebrou.
- Se quebrou, **reproduza localmente** com `npm run verify` (o build do Railway é o mesmo `vinext build`); o erro
  quase sempre aparece lá. Corrija e publique de novo — não peça o log ao usuário.
- Teste o site no ar: `GET /` deve dar 200 (tela de login) e `GET /api/auth` deve dar 200 com `{"user":null}`.
  `503` em `/api/auth` = problema de armazenamento de usuários (veja a seção abaixo).

## Regras que já causaram falha (não repetir)

- **pnpm**: mantenha `pnpm-workspace.yaml` com `packages: ['.']` e apenas `onlyBuiltDependencies`
  (esbuild, sharp, unrs-resolver, workerd). Chaves inválidas como `allowBuilds` já derrubaram o build.
- **Lockfile**: toda mudança em `package.json` exige `pnpm-lock.yaml` atualizado e commitado
  (o Railway instala com `--frozen-lockfile`; divergência = build falha).
- **Node**: `engines.node >= 22.13.0`. Não use APIs mais novas que isso.
- **Caracteres especiais / encoding**: todos os arquivos em **UTF-8 sem BOM**. Nomes de arquivo enviados em
  cabeçalho HTTP (ex.: `X-File-Name`) devem passar por `encodeURIComponent` (travessão “–”, aspas curvas e
  emojis derrubam o `fetch` com "Cannot convert argument to a ByteString"). Não grave dados com acento via
  `Out-File`/`Set-Content` do PowerShell 5 sem `-Encoding utf8`. O parser Python (`server/parse_orders_large.py`)
  e o Windows já tiveram texto acentuado corrompido — valide acentos (ç, ã, é) após importar planilhas.
- **Caminhos**: nada de caminho absoluto de máquina (`C:\Users\...`) em código que roda no Railway (Linux).
  Use `process.cwd()`/`import.meta.url`. Caminhos do Carlos só existem no fluxo local (`INICIAR_DASHBOARD.cmd`).
- **Tipos**: `npx tsc --noEmit` deve ficar com **0 erros**. Props novas precisam ser declaradas e passadas
  (já houve `onStore` usado sem ser recebido → erro só ao clicar numa loja).
- **ESLint**: existem 8 erros antigos de regras do React 19 (`set-state-in-effect` etc.). Não bloqueiam o deploy;
  não os "conserte" de passagem em um commit de outra natureza.

## Banco de dados (Supabase) — persistência definitiva

O disco do Railway é apagado a cada deploy, então **tudo que precisa durar fica no Supabase** (Postgres).

- Projeto Supabase: `dashboard-logistica` (org AuditoriaSfera, região `sa-east-1`, ref `uutkextcrllwypmdkcgb`).
- O sistema usa o banco **somente se a variável `DATABASE_URL` existir** (no Railway ou no seu `.env`). Sem ela
  tudo cai nos arquivos de `data/`, como antes — por isso o código funciona nos dois modos. Remover `DATABASE_URL`
  do Railway é o "botão de emergência" para voltar aos arquivos.
- `DATABASE_URL` = URL do **transaction pooler**, porta **6543**, usuário `dashboard_app.<ref>` (papel de privilégio
  mínimo, não o `postgres`). Formato:
  `postgresql://dashboard_app.uutkextcrllwypmdkcgb:<SENHA>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`.
  **Nunca** commite a senha/URL (repositório público). Não use o host direto `db.<ref>.supabase.co` (IPv6; o Railway não alcança).
- Tabelas (`db/migrations/001_initial_schema.sql`, papel em `002_app_role.sql`): `access_users`, `access_sessions`,
  `access_login_attempts`, `access_meta` (usuários/sessões), `dashboard_snapshots` (chaves `dashboard` e `orders`),
  `order_records` (pedidos detalhados), `order_imports` (histórico de importações). RLS ligada; só o papel
  `dashboard_app` acessa. Mudanças de esquema: novo arquivo `db/migrations/00N_*.sql` **e** aplicar no Supabase
  (conector Supabase/`apply_migration` ou SQL Editor).
- Código: `server/db.mjs` (todas as consultas). Leitura: `app/api/dashboard` e `app/api/orders/records` leem do banco
  primeiro e usam arquivos como fallback. Escrita: `app/api/refresh` (upload online) e `server/index.mjs` (Express local)
  gravam no banco depois de processar a planilha.
- **Não troque o carregamento do driver** em `server/db.mjs` por `import postgres from "postgres"`: o empacotador do
  vinext embute a variante Cloudflare e o servidor passa a falhar com `ERR_UNSUPPORTED_ESM_URL_SCHEME`
  (já aconteceu). O driver é carregado com `createRequire` em tempo de execução. Sempre use `prepare: false` (pooler).
- Comandos: `DATABASE_URL=... npm run db:check` (diagnóstico: conexão e contagem das tabelas) e
  `DATABASE_URL=... npm run db:seed` (recarrega o banco a partir de `data/*.json`).
- Nunca rode SQL destrutivo em produção (`delete`/`truncate` em `access_users`, `order_records`) sem o usuário pedir.

## Dados online (`data/`)

- Com `DATABASE_URL`, o site lê os dados do **banco**; os JSON de `data/` viram só o fallback/semente.
- `.gitignore` ignora `/data/*`, **exceto** `.gitkeep`; os dois JSON abaixo estão versionados à força:
  - `data/dashboard-snapshot.json` (~4,5 MB) e `data/pedidos-cumulativos.json` (~3,3 MB).
- Atualização de dados: pelo upload online (`/api/refresh`, grava no banco) ou localmente (Express + planilha, que
  também grava no banco quando `DATABASE_URL` está definida). Não precisa mais commitar JSON para atualizar o site.
  Se for atualizar o fallback versionado: `git add -f data/dashboard-snapshot.json data/pedidos-cumulativos.json`.
- **Nunca** commite `data/access-users.json`, `data/auth-backups/`, `*.lock`, `.env*` nem planilhas `.xlsx/.csv`
  de pedidos (contêm hash de senhas / dados pessoais). O repositório é **público**.

## Autenticação e usuários (`server/auth.mjs`)

- **Com `DATABASE_URL`: usuários e sessões ficam no banco** e sobrevivem a deploys (modo normal). O administrador
  inicial (`admin@sfera.local`, senha temporária `TEMP_PASSWORD`, troca obrigatória) só é criado se a tabela
  `access_users` estiver vazia. `ACCESS_STORAGE=file` força arquivo mesmo com `DATABASE_URL`.
- Sem `DATABASE_URL`, usuários ficam em `access-users.json`. Ordem de escolha do diretório: `ACCESS_DATA_DIR` →
  `RAILWAY_VOLUME_MOUNT_PATH` → (Railway sem volume) disco do container em **modo temporário**.
- Sem banco e sem volume, a cada deploy as contas são recriadas (só `admin@sfera.local` com a senha
  temporária, troca obrigatória no 1º acesso). É esperado, não é bug.
- **Não reintroduza** o bloqueio "Configure um volume persistente" como padrão: ele já deixou o site inteiro fora
  do ar (503 em `/api/auth`). Quem quiser o bloqueio rígido define `ACCESS_REQUIRE_VOLUME=true` no Railway.
- Quando o dono do Railway criar um Volume, o sistema passa a usá-lo sozinho (sem mudança de código).
  Para uma instalação nova com volume vazio é preciso `ACCESS_ALLOW_INITIAL_SETUP=true` uma única vez.
- O login valida `Origin`; domínio público vem de `RAILWAY_PUBLIC_DOMAIN` (ou `ACCESS_APP_ORIGIN`).

## Atalhos

| Tarefa | Comando |
|---|---|
| Validar tudo | `npm run verify` |
| Só tipos | `npx tsc --noEmit` |
| Só testes | `npm test` |
| Diagnóstico do banco | `DATABASE_URL=... npm run db:check` |
| Recarregar banco a partir de `data/*.json` | `DATABASE_URL=... npm run db:seed` |
| Rodar produção local simulando Railway | `RAILWAY_PROJECT_ID=x NODE_ENV=production npx vinext start -p 4010` |
| Dev local completo | `INICIAR_DASHBOARD.cmd` (API 8788 + web 3000) |
