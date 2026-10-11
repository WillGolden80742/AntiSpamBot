# AntiSpamBot — Clone Group Help Telegram

> Bot Node.js + SQLite para moderação automática de grupos no Telegram — **2 motores, 0 IA externa, 0 rede, 0 chave paga**.
> Fiscaliza **alfabetos** (árabe, cirílico, chinês, hindi, bengali, não-ocidental, latim) + **antispam semântico** (regex com pesos + fastText local + Bayes de reserva) com painel inline no privado, whitelist, regras e trava de dono.

- **Stack:** Node.js ESM (`"type": "module"`) + `node-telegram-bot-api` (polling) + `better-sqlite3` (WAL) + `fasttext` (binário do sistema) + `dotenv`
- **Banco:** `db/grouphelp.db` (SQLite)
- **Modelos locais:** `db/fasttext/spam.ftz` (97 MB quantizado, usado pelo bot) + `db/bayes.json` (fallback puro-JS)
- **Corpus (~41k msgs):** treino `db/corpus/spam.json` (10.000) + `db/corpus/nao_spam.json` (11.108) = 21.108 · teste separado `db/corpus/spam_teste.json` (10.000) + `db/corpus/nao_spam_teste.json` (10.000) = 20.000 — ou seja, **~10k por classe, ~40k no total**
- **Precisão atual (teste separado de 20k):** fastText `P@1 0.994 / R@1 0.994` · **fusão bot (regras+modelo): 10.000/10.000 spam pego (100%), 0 FP punido no ham** (só 36 🟡 log) | Bayes `19.692/20.000` (242 FP)

---

## Índice

1. [O que o bot faz](#1-o-que-o-bot-faz)
2. [Estrutura de diretórios (DIR)](#2-estrutura-de-diretórios-dir)
3. [O que cada arquivo faz](#3-o-que-cada-arquivo-faz)
4. [Arquitetura e fluxo](#4-arquitetura-e-fluxo)
5. [Motor 1 — Alfabetos](#5-motor-1--alfabetos)
6. [Motor 2 — Antispam semântico](#6-motor-2--antispam-semântico)
7. [Painéis e comandos](#7-painéis-e-comandos)
8. [Banco de dados](#8-banco-de-dados)
9. [Instalação](#9-instalação)
10. [Configuração (.env)](#10-configuração-env)
11. [Rodando o bot](#11-rodando-o-bot)
12. [Treinamento (`bin/treinar.js`)](#12-treinamento-bintreinarjs)
13. [Whitelist, Regras e Tolerância](#13-whitelist-regras-e-tolerância)
14. [Trava de dono e segurança](#14-trava-de-dono-e-segurança)
15. [Logs, backups e troubleshooting](#15-logs-backups-e-troubleshooting)
16. [Scripts NPM](#16-scripts-npm)
17. [Roadmap / ideias](#17-roadmap--ideias)

---

## 1. O que o bot faz

| Capacidade | Como |
|---|---|
| **Bloqueia alfabetos indesejados** | Detecta árabe, cirílico, chinês (inclui japonês/coreano), hindi, bengali, *não-ocidental* (catch-all: grego, hebraico, tailandês…) e latim. Cada um com multisseleção: `Deletar / Silenciar / Banir / Progressivo`. |
| **Antispam sem IA externa** | 3 camadas: 1) whitelist perdoa, 2) 43 regex com pesos (tigrinho, pirâmide, phishing, APK, trader, sorteio falso, leilão apreensão, pedido de pix…) + análise de links por metadados, 3) fastText local (ou Bayes). Níveis `🟡 baixo (só log) · 🟠 médio · 🔴 severo`. |
| **Punição em escada, nunca direta** | Alfa progressivo e semântico contam warns (`alfabeto:*`, `sem:*`) até `max_warns` (2–5) e só então aplicam `ban / mute / apenas deletar`. |
| **Painel 100% no Telegram** | `/settings` no grupo → botão abre o privado → hub → `Alfabetos` ou `Antispam` → submenus (tolerância, whitelist, regras, retreinar, disparar varredura). |
| **Varredura sob demanda** | Bot grava tudo que vê em `messages_log`; botão *Disparar* revarre os últimos 61 min. Tempo real julga cada mensagem na hora. |
| **Trava de dono** | Só o `OWNER_ID` adiciona o bot em grupos. Grupo estranho = aviso + `leaveChat` + limpeza local. |
| **Isolamento total de falhas** | `unhandledRejection/uncaughtException` só logam; cada listener tem `try/catch` + `notificarFalha` no privado. Bot nunca cai. |

---

## 2. Estrutura de diretórios (DIR)

Gerada com a skill `gerar-arvore-diretorios` (`python3 ~/.config/opencode/skills/gerar-arvore-diretorios/dir_tree.py .`):

```
AntiSpamBot/
├── app/
│   ├── controllers/
│   │   ├── acesso.js        # trava de dono (gate de entrada + rede 5min)
│   │   ├── alfabetos.js     # fiscal de alfabetos + progressivo + logs ADM
│   │   ├── callbacks.js     # hub de botões inline (open/mod_alfa/ai/wl/...)
│   │   ├── commands.js      # /start /settings /setlog /regras /analise /sinais...
│   │   └── semantico.js     # juiz semântico + varredura + retreinar + tolerância
│   ├── helpers/
│   │   ├── admin.js         # guard/canEdit/ensureBotPerm/targetIsStaff
│   │   ├── buffer.js        # messages_log: registra/lê janela/poda/marca julgadas
│   │   ├── classico.js      # fastText (.ftz→.bin) + Bayes fallback (prob≥0.9)
│   │   ├── defaults.js      # DEFAULT_SETTINGS (seed de cada grupo novo)
│   │   ├── falhas.js        # notificarFalha no privado sem quebrar
│   │   ├── keyboards.js     # manageKeyboard/settingsKeyboard/openPrivate
│   │   ├── linkmeta.js      # extrairLinks/analisarLinks (TLD/encurtador/t.me)
│   │   ├── pending.js       # estado pendente p/ editar regras/whitelist no privado
│   │   ├── regras.js        # get/set texto das regras (módulo 'regras')
│   │   ├── sinais.js        # ~30 regex com pesos + TOTAL_SINAIS + anti-ofuscação
│   │   └── whitelist.js     # links + assuntos perdoados (furam o juiz)
│   └── models/
│       └── group.js         # findOrCreate/backfill/list/visibleGroups/logEvent
├── bin/
│   ├── bot.js               # entry real: polling + register* + getMe log
│   └── treinar.js           # treino fastText (treino/teste separados) + fusão real + Bayes + stats.json
├── config/
│   └── database.js          # better-sqlite3 + WAL + auto-exec schema.sql
├── db/
│   ├── corpus/
│   │   ├── spam.json        # 10.000 exemplos spam (TREINO)
│   │   ├── nao_spam.json    # 11.108 exemplos ham (TREINO)
│   │   ├── spam_teste.json      # 10.000 exemplos spam (TESTE separado)
│   │   └── nao_spam_teste.json  # 10.000 exemplos ham (TESTE separado)
│   ├── fasttext/
│   │   ├── spam.ftz         # modelo quantizado EM USO (97 MB, dim 100 / epoch 100 / lr 0.7)
│   │   ├── spam.vec         # vetores (19 MB, inspeção)
│   │   └── stats.json       # {treino:{spam,ham,total}, teste:{...}, fasttextTest, fusao:{...}, bayes:{...}}
│   ├── migrate/
│   │   └── 001_ai_mods.sql  # migração legada antispam_ai/censurar
│   ├── bayes.json           # modelo Bayes puro-JS (163 KB)
│   ├── grouphelp.db         # SQLite principal (+ -shm/-wal)
│   ├── schema.sql           # DDL: groups/settings/warns/messages_log/events
│   └── seeds.js             # seed demo (-1001001 Anarquia e Libertarianismo)
├── backups/
│   ├── 2026-10-11_121833/   # codigo.tar.gz + grouphelp.db + MANIFEST.md + env.keys
│   └── 2026-10-11_141019/   # codigo.tar.gz + grouphelp.db
├── log/
│   └── bot.log              # log de runtime
├── graphify-out/            # knowledge graph (AST) — ver `graphify update .`
├── bot.js                   # entry raiz (só `import './bin/bot.js'`)
├── package.json             # name grouphelp-clone v1.0.0, scripts bot/db:seed/sem:treinar
├── .env                     # TELEGRAM_BOT_TOKEN + OWNER_ID (não commitar)
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── yarn.lock
```

> `node_modules/`, `graphify-out/cache`, `*.db-shm/-wal` e conteúdo de `backups/*.tar.gz` são omitidos do detalhamento — só o nome aparece na árvore completa.

---

## 3. O que cada arquivo faz

### Entry e boot

| Arquivo | Papel |
|---|---|
| `bot.js` (raiz, 2 linhas) | Convenção Rails: delega para `bin/bot.js`. `npm run bot` / `dev` apontam aqui. |
| `bin/bot.js` (25 linhas) | Carrega `.env`, valida `TELEGRAM_BOT_TOKEN`, arma `unhandledRejection/uncaughtException`, cria `TelegramBot({polling:true})`, registra os 5 controllers (`commands/callbacks/alfabetos/semantico/acesso`), loga `Bot online como @user \| MODO: alfabetos+semantico`. |
| `config/database.js` | Abre `DB_PATH` (ou `db/grouphelp.db`), `journal_mode=WAL`, `foreign_keys=ON`, executa `schema.sql` se existir. Exporta `db` + `DB_PATH`. |

### Controllers (`app/controllers/`)

| Arquivo | Responsabilidade | Detalhe |
|---|---|---|
| `acesso.js` (113 linhas) | Trava de dono | `OWNER_ID` do env. `new_chat_members`: se quem adicionou ≠ dono → avisa e sai. Rede: mensagem de grupo sem `settings.acesso.autorizado` há +5 min → sai + `DELETE groups/settings/warns`. Grupos já no banco no boot = legado (do dono). |
| `alfabetos.js` (678 linhas) | Fiscal de alfabetos | `ALFA_REGEX` por script + `detectarAlfabetoAtivo` (respeita desativados + exceções do não-ocidental + ignora emoji puro + ignora `/comandos` + ignora staff salvo `punir_staff`). `aplicarSelecaoImediata` (flags fixas na hora) vs `aplicarProgressivo` (warns até final). Logs espelhados em `logNoGrupoADM` ou DM dos admins. Ouve `message` + `edited_message`. |
| `semantico.js` (402 linhas) | Juiz semântico | `analisarTexto` (regex+modelo+tolerância) → `julgarNucleo` (baixo=só `sem_log`; médio/severo=delete+warn em escada até ban/mute) → `julgarMensagem` (tempo real + buffer + whitelist + staff) → `varreduraGrupo` (61 min, silenciosa) → `retreinar` (spawn `bin/treinar.js`). Painéis `painelSemantico/painelTolerancia/painelTolNumeros`. |
| `callbacks.js` (663 linhas) | Todos os botões inline | Prefixos `open:/done:/mod:/mod_alfa:/ab:/ab_tgl:/ab_exceto:/ab_excts:/ab_prog:/ab_max:/ab_final:/ab_warnmsg:/ab_log:/ab_staff:` (alfabetos) + `ai:/ai_tgl:/ai_max:/ai_final:/ai_warnmsg:/ai_del:/ai_warn:/ai_staff:/ai_run:` (antispam) + `sem_tol:/sem_tol_custom:/sem_tol_set:/sem_treinar:` + `cens_ver:/cens_editar:` (regras) + `wl:/wl_add_link:/wl_add_assunto:/wl_rm_*`. `canEdit` exige admin do grupo. Multisseleção com exclusividades (progressivo × silenciar/banir; silenciar × banir). |
| `commands.js` (314 linhas) | Comandos `/` | `/start` (privado=hub, grupo=requisito admin), `/reload` (sincroniza admins), `/settings|/config|/pvtconfig` (abre privado), `/setlog [ID|aqui|limpar]` (grupo ADM de logs), `/chatid`, `/regras`, `/definir_regras`, `/analise` (reply: veredito + % + ação no privado), `/aistatus`, `/sinais` (dry-run sem punir), `/retreinar`, `/perdaoai` (zera `sem:*`), `/perdao` (zera `alfabeto:*`). |

### Helpers (`app/helpers/`)

| Arquivo | O que tem dentro |
|---|---|
| `admin.js` | `guard` (só grupo + só admin), `senderIsAdmin`, `targetIsStaff`, `isAnonymousAdmin`, `ensureBotPerm` (checa `can_restrict_members`/`can_delete_messages` antes de punir). |
| `buffer.js` | `registrarMensagem` (cada msg vista) · `lerJanela(gid, 3600s)` · `marcarJulgadas` (`julgado_em`) · `podar` (limpa antigas). Base do botão *Disparar*. |
| `classico.js` | `temModelo()` (.ftz ou .bin) · `classificar()` (fastText via `predict-prob` → P(spam); fallback Bayes com corte 0.9) · `statsModelo()` (lê `stats.json`) · `reload()`. |
| `defaults.js` | `DEFAULT_SETTINGS`: alfabetos tudo `desativado` + progressivo ON 3x ban; semantico OFF + deletar/warn ON 3x mute tol 65%; regras padrão 3 linhas; whitelist vazia. |
| `falhas.js` | `notificarFalha(bot,gid,modulo,msg)` — avisa admins no privado sem derrubar o loop. |
| `keyboards.js` | `manageKeyboard(groups)`, `settingsKeyboard(gid)` (hub com 2 motores), `openPrivateKeyboard(botUsername)` (deep-link `t.me/bot?start=`), `manageText`. |
| `linkmeta.js` | `URL_RE`, `extrairLinks`, `analisarLinks` — classifica link por TLD estranho, encurtador (`bit.ly/t.ly`), `t.me`, caminho suspeito. Cada suspeito = +4 no score. |
| `pending.js` | `setPendente/getPendente/clearPendente` (mapa chat+user → `{gid,tipo}`) para fluxos de 1 mensagem no privado (regras/whitelist). `cancelar` desiste. |
| `regras.js` | `getRegrasTexto/setRegrasTexto` (módulo `regras`, até ~4000 chars). Critério humano que o painel exibe. |
| `sinais.js` | `normalizar` (minúscula, sem acento, leet só dígito colado em letra `t1gr1nho→tigrinho`, zero-width, repetições) · `SINAIS` (43 regex peso 1/2/3/4 com motivo PT-BR) · `analisarSinais` (soma + CAPS + repetidos + links) → `{score,nivel,motivos}` · `TOTAL_SINAIS`. |
| `whitelist.js` | `getWhitelist/saveWhitelist/ehPermitido/painelWhitelist/removerWlItem` — `{links:[domínios], assuntos:[strings]}`. Perdão total: nem é julgado. |

### Model e DB

| Arquivo | Papel |
|---|---|
| `app/models/group.js` | `findOrCreateGroup` (cria grupo + seed de todos os módulos + backfill de módulos novos) · `listGroups` · `visibleGroupsFor` (só onde bot E usuário são admins, checagem live) · `getModule` · `logEvent`. |
| `db/schema.sql` | `groups(id,title)` · `settings(group_id,module,data,updated_at)` (módulos `alfabetos/semantico/regras/whitelist/acesso/...`) · `warns(id,group_id,user_id,reason,created_at)` · `messages_log(group_id,message_id,user_id,texto,criado_em,julgado_em)` · `events(id,kind,group_id,user_id,meta,created_at)`. |
| `db/seeds.js` | `pnpm db:seed`: grupo `-1001001 Anarquia e Libertarianismo` + defaults. Produção usa `/reload` no Telegram. |
| `db/migrate/001_ai_mods.sql` | Migração dos módulos legados `antispam_ai/censurar/ia_conexao` → `semantico`. |
| `db/corpus/*.json` | Treino + teste separados: `{conteudo}` por linha. Treino 10k spam + 11.108 ham · teste 10k + 10k (~40k total). |
| `db/fasttext/spam.ftz` | Modelo em uso (quantizado, dim 100/epoch 100). `.vec` = vetores p/ inspeção. `stats.json` = métricas do último treino (fastText + fusão + Bayes). |
| `db/bayes.json` | `{ns,nh,ts,th,vocab}` — fallback quando fastText ausente. |

---

## 4. Arquitetura e fluxo

```
Telegram (polling)
   └─ bin/bot.js
       ├─ commands.js ──→ /start /settings /setlog /analise /sinais /regras ...
       ├─ callbacks.js ─→ botões inline (hub → alfabetos / antispam / whitelist)
       ├─ alfabetos.js ─→ on message/edited_message: detectarAlfabetoAtivo → punir
       ├─ semantico.js ─→ on message/edited_message: buffer → whitelist → analisarTexto → julgarNucleo
       └─ acesso.js ────→ gate new_chat_members + rede 5min (leave se estranho)
             │
             ▼
   config/database.js → db/grouphelp.db (WAL)
     groups / settings (JSON por módulo) / warns / messages_log / events
             │
             ▼
   classico.js → fastText .ftz (predict-prob) ou Bayes (≥0.9)
   sinais.js + linkmeta.js → score regex + motivos PT-BR
```

**Ordem do juiz semântico** (`julgarMensagem`): só grupo → ignora bot/comando → `registrarMensagem` → se `enabled=false` para → se sem modelo loga `sem_degraded` → staff passa se `punir_staff=false` → whitelist perdoa → `julgarNucleo` → `marcarJulgadas`.

**Fusão regex+modelo** (`analisarTexto`): severo/médio do regex (com veto do modelo se `pct<15` → vira baixo) · `score≥1` + `pct>tolerância` → médio senão baixo · `score=0` + `pct>modelo_min (default 90)` → médio · `pct≥50` → baixo · senão limpo. O `modelo_min` fecha a torneira do modelo puro: sem nenhum sinal de regex, só vira punição acima de 90%.

---

## 5. Motor 1 — Alfabetos

Regex em `ALFA_REGEX`: árabe `0600-08FF`, cirílico `0400-052F`, chinês `4E00-9FFF+3040-30FF+AC00-D7AF` (pega chinês/japonês/coreano), hindi `0900-097F`, bengali `0980-09FF`, não-ocidental `[^0000-024F...]` (catch-all), latim `[A-Za-zÀ-ÿ]`. Ordem `CHECK_ORDER`: específicos → não-ocidental → latim.

- **Emoji puro nunca pune:** `temLetraOuNumeroNaoOcidental` exige letra/número de outro script (`\p{L}\p{N}`). `"ótimo 👍"` passa.
- **Exceções:** `exceto_nao_ocidental: [cirilico,...]` — russo passa, hebraico continua bloqueado (`stripScripts` + `passaNaExcecao`).
- **Multisseleção por alfabeto:** `{deletar, silenciar, banir, progressivo}`. Legado string (`desativado/deletar/silenciar+deletar/ban+deletar/progressivo`) migra sozinho via `normSelecao`. Regras de exclusão: progressivo × (silenciar/banir); silenciar × banir; deletar combina com tudo; desmarcar tudo = desativado.
- **Progressivo global:** `progressivo_enabled` (default ON), `max_warns` 2–5 (default 3), `acao_final` ban/mute/deletar, `avisar_no_grupo`, `log_no_admin_grupo` + `admin_grupo_id`, `punir_staff` (modo teste, default OFF = staff totalmente ignorado, sem delete/warn).
- **Apenas deletar:** se só `deletar` marcado (ou `acao_final=deletar`), nunca conta warn, nunca restringe — só apaga + avisa curto + log ADM.

---

## 6. Motor 2 — Antispam semântico

`sinais.js`: normalização anti-ofuscação + 43 padrões (era ~30):

- **Peso 4 (certeiro):** tigrinho/fortune tiger/aviãozinho/cassino/bet · renda extra/lucro garantido/fique rico/método secreto/retorno fixo · phishing conta bloqueada/taxa correios/benefício (só sem domínio confiável junto) · golpe empréstimo/FGTS/airdrop/staking · pedido de pix por engano/familiar internado/código por engano · sorteio falso (iPhone/carro/concorra) · seleção falsa (benefício governo/comenta eu quero) · leilão/apreensão (moto/carro/Detran/PF) · moto apreendida · adulto (vazad/onlyfans/nudes/novinha/packs/+18) .
- **Peso 3:** malware (whatsapp gb/apk) · venda falsa (CNH/diploma) · falso lucro (saquei lucro) .
- **Peso 2:** trader/forex · dinheiro (R$ mil por dia/pix/saque) · bônus 200% · robô sinais · divulgação (entra no meu grupo/link na bio/anuncie aqui) · casa de apostas (bacbo/bet7k/tigre vip/cashback) · falsa vaga · crédito liberado · oferta falsa .
- **Peso 1:** urgência (só hoje/últimas vagas) · emoji dinheiro · CAPS >60% (+1) · repetidos `(.)\1{4,}` (+1) · cada link suspeito (+4) · 3+ links (+1).

Anti-ofuscação: leet **só em dígitos colados em letra** (`t1gr1nho→tigrinho`, `R$500` intacto, `+18`/`!!!`/`$`/`@trader` intactos) + zero-width removido + repetições colapsadas (`oooo→oo`). `R$` agora exige valor (`\d+\s*(mil|por dia|de lucro|garantido|…)`) — evita FP em conversa normal sobre preço.

`linkmeta.js`: julga por **metadados**, não por lista — TLD estranho, encurtador, `t.me`, caminho com aposta. Domínios confiáveis (`gov.br, wikipedia, github, google, youtube…`) **vetam** phishing.

Punição (`julgarNucleo`): `baixo` = só `events(sem_log)`, silencioso. `médio/severo` sobem a **mesma escada**: deleta (se `deletar`) + warn `sem:*` até `max_warns` → `ban/mute` (se `acao_final≠deletar`) e zera. Se `warn=false`, só deleta. Aviso no grupo mostra **só motivo** (nunca trecho/%) — trecho + % vão só no privado/ADM.

---

## 7. Painéis e comandos

### Comandos (todos exigem admin, exceto `/regras` e `/chatid`)

| Comando | Onde | O que faz |
|---|---|---|
| `/start` | privado/grupo | Privado: hub de grupos (`visibleGroupsFor`). Grupo: lembra bot precisa ser admin + `/settings`. |
| `/reload` | grupo | `findOrCreateGroup` + sincroniza admins. |
| `/settings`, `/config`, `/pvtconfig` | grupo/privado | Grupo: cartão com botão deep-link p/ privado. Privado: hub. |
| `/setlog [ID\|aqui\|limpar]` | grupo | Define grupo ADM que recebe logs de mute/ban. Valida com `sendChatAction`. |
| `/chatid` | qualquer | Devolve o ID (use p/ descobrir `OWNER_ID` e `admin_grupo_id`). |
| `/regras` | grupo | Mostra regras (qualquer membro). |
| `/definir_regras <texto>` | grupo (ou reply) | Edita regras (mín 10 chars). |
| `/analise` | grupo (reply) | Veredito `SPAM/suspeita/limpo` + nível + % + motivo + sinais + ação (toma ação se spam). Vai no **privado** do admin. |
| `/aistatus` | qualquer | Motor + treino (`stats.json`) + resumo antispam/whitelist do grupo. |
| `/sinais` | grupo (reply) | Dry-run: nível/motivo/score/% **sem punir**. |
| `/retreinar` | grupo | Roda `bin/treinar.js` em background (cooldown 60s). |
| `/perdaoai [@\|ID\|reply]` | grupo | Zera warns `sem:*` (+ legados `ai:*/censura:*`). |
| `/perdao [@\|ID\|reply]` | grupo | Zera warns `alfabeto:*`. |

### Painéis inline (`callbacks.js`)

`CONFIGURAÇÕES → [🔤 Alfabetos] [🛡 Antispam]` → cada motor tem toggles clicáveis (liga/desliga, avisos 2–5, ação final ban→mute→deletar, aviso no grupo, log ADM, admin no teste), submenu por alfabeto (4 flags), `Não ocidental libera:` (5 exceções), `Tolerância` (50/65/80 + grade 10–90), `Whitelist` (links/assuntos + add/remove), `Regras` (ver/editar via `pending.js`), `Retreinar`, `Disparar` (varredura 61 min).

---

## 8. Banco de dados

`db/schema.sql` (WAL, FK ON):

```sql
groups(id TEXT PK, title TEXT)
settings(group_id, module, data JSON, updated_at) PK(group_id,module)
warns(id AI PK, group_id, user_id, reason, created_at)       -- reason 'alfabeto:*' ou 'sem:*'
messages_log(group_id, message_id, user_id, texto, criado_em, julgado_em) PK(group_id,message_id)
events(id AI PK, kind, group_id, user_id, meta JSON, created_at)
```

Módulos em `settings.data`: `alfabetos` (7 seleções + 6 flags globais) · `semantico` (enabled/deletar/warn/avisar/max/ação/log/staff/tolerância) · `regras` (texto) · `whitelist` (links/assuntos) · `acesso` (autorizado/adicionado_por/em). Legados `antispam_ai/censurar/ia_conexao` migrados automaticamente.

---

## 9. Instalação

Pré-requisitos: **Node 18+**, **fasttext** (binário), **pnpm ou npm**.

```bash
# 1. clone / entre na pasta
cd AntiSpamBot

# 2. instale deps (escolha 1)
pnpm install        # ou: npm install --no-audit --no-fund

# 3. instale o fasttext (Ubuntu/Debian)
sudo apt update && sudo apt install -y fasttext
# macOS: brew install fasttext
fasttext -h  # deve abrir a ajuda

# 4. configure o .env (ver próxima seção)
cp .env.example .env  # se existir; senão crie (abaixo)
nano .env

# 5. inicie o banco + treine o modelo (primeira vez)
node db/seeds.js
node bin/treinar.js

# 6. rode o bot
node bot.js           # ou: pnpm bot / pnpm dev
```

---

## 10. Configuração (.env)

```env
TELEGRAM_BOT_TOKEN=123456:ABC-seu-token-do-BotFather
OWNER_ID=123456789
# DB_PATH=./db/grouphelp.db   # opcional (default: db/grouphelp.db)
```

| Var | Obrigatória | Como descobrir |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **sim** | `@BotFather` → `/newbot`. Sem ela o bot sai com `Falta TELEGRAM_BOT_TOKEN`. |
| `OWNER_ID` | recomendado | Fale `/chatid` com o bot no privado → seu ID numérico. Sem ela a trava fica **DESLIGADA** (qualquer grupo pode adicionar o bot). |
| `DB_PATH` | não | Caminho alternativo do SQLite. |

Depois de subir: adicione o bot como **admin do grupo** (permissões: apagar, banir, fixar, convidar) → **o DONO** adiciona o bot no grupo → `/reload` → `/settings` → configure no privado.

---

## 11. Rodando o bot

```bash
node bot.js            # produção simples
pnpm bot               # alias
pnpm dev               # alias dev (mesmo entry)
node bin/bot.js        # direto no bin (convenção Rails)
```

Saída esperada: `Bot online como @SeuBot | MODO: alfabetos+semantico | trava de dono | DB: db/grouphelp.db`.

Para manter online na VPS: `pm2 start bot.js --name antispam`, `systemd`, ou `tmux`/`screen`. Logs em `log/bot.log`.

---

## 12. Treinamento (`bin/treinar.js`)

```bash
node bin/treinar.js   # ou: pnpm sem:treinar  |  ou: /retreinar no Telegram
```

Pipeline (todo local, sem rede) — **treino e teste em arquivos separados** (sem vazamento treino→teste):

1. Lê treino `db/corpus/spam.json` (10.000) + `nao_spam.json` (11.108) = **21.108** e teste `db/corpus/spam_teste.json` (10.000) + `nao_spam_teste.json` (10.000) = **20.000**. Total **~41k mensagens (~10k por classe)**. Normaliza (lower, 1 espaço, 500 chars). Sem `*_teste.json`, cai p/ holdout 20% do treino (fallback).
2. `fasttext supervised -dim 100 -epoch 100 -wordNgrams 2 -lr 0.7 -minn 3 -maxn 6` (só no treino) → `spam.bin` → `quantize` → `spam.ftz` (o bot usa o `.ftz`; o `.bin` é apagado).
3. Avalia no **teste separado**: `fasttext test` (P@1/R@1) + `predict-prob` por classe.
4. **Recall REAL do bot (fusão regras+modelo)** no teste — replica `analisarTexto`/`nivelFusao` com `TOL 65`: conta spam pego/punido/escapado + ham punido (FP) / só log 🟡 + lista até 8 exemplos escapados.
5. Treina Bayes puro-JS no **treino**, avalia no **teste** → `db/bayes.json` + acurácia.
6. Salva `db/fasttext/stats.json`: `{em, treino:{spam,ham,total}, teste:{...}, fasttextTest, fusao:{spamPego,spamTotal,pct,escapou,hamPunido,hamLog}, bayes:{acerto,total,fpHam}}` (mantém `nSpam/nHam/fpHam` legados).

Último treino (`2026-10-11T20:52:53Z`): treino 21.108 (spam 10.000 / ham 11.108) · teste 20.000 (10k/10k) · fastText `P@1 0.994 R@1 0.994` · **fusão: spam 10.000/10.000 (100%), 0 escapou, ham punido 0/10.000, só log 36** · Bayes `19.692/20.000` (FP 242). Para melhorar: adicione exemplos em `db/corpus/*.json` (`{conteudo: "..."}`) e `db/corpus/*_teste.json` e retreine.

---

## 13. Whitelist, Regras e Tolerância

- **Whitelist** (`wl:`): domínios (`exemplo.com`) e assuntos (frases) que **furam o juiz** — nem são analisados. Gerencie no painel ou no privado (fluxo `pending.js`, `cancelar` desiste). Ideal p/ links oficiais do grupo e avisos da moderação.
- **Regras** (`cens_ver/cens_editar`, `/regras`, `/definir_regras`): texto humano exibido no painel do antispam como *critério*. Não é regex — é referência p/ admins e membros.
- **Tolerância** (`sem_tol`, default **65%**): probabilidade mínima do fastText p/ entrar na escada. `Baixo 50%` = rigoroso (pune mais) · `Médio 65%` · `Alto 80%` = perdoa mais · `Personalizar` 10–90. Regex severo **sempre** pune independente da tolerância (salvo veto `pct<15`). **Modelo puro sem regex** só pune acima de `modelo_min` (default **90%**, faixa 50–100) — abaixo disso vira só 🟡 log.

---

## 14. Trava de dono e segurança

- `OWNER_ID` ausente → trava desligada + warn no log (não trava o bot antes de configurar).
- Bot adicionado por não-dono → avisa no grupo + `leaveChat` + apaga `groups/settings/warns` locais + `events(acesso_saida)`.
- Grupos no banco antes de ligar a trava contam como legado (do dono).
- Edição de config exige ser **admin do grupo** (`canEdit`/`guard` checam live via `getChatAdministrators`).
- Produção (`punir_staff=false`): staff é **totalmente ignorado** (sem delete/warn/aviso) e warns antigos do admin são limpos. Ligue `punir_staff` só p/ testar.
- Bot precisa ser admin com *apagar + restringir*; sem permissão ele **avisa** em vez de falhar silencioso.
- `.env`, `*.db`, `backups/env.keys.txt` **nunca** vão pro git. Comandos nunca vazam trecho/% no grupo — só motivo; detalhes só no privado/ADM.

---

## 15. Logs, backups e troubleshooting

| Sintoma | Causa provável | Solução |
|---|---|---|
| `Falta TELEGRAM_BOT_TOKEN` | `.env` sem token | Preencha e reinicie. |
| Bot não pune | Não é admin / sem permissão / módulo desligado / staff ignorado / whitelist perdoou / sem modelo | Dê admin + permissões → `/reload` → ligue o motor → cheque `punir_staff` → `/sinais` (reply) p/ dry-run → `/aistatus` p/ modelo. |
| `modelo local ausente — rode Retreinar` | sem `.ftz` | `node bin/treinar.js` (precisa do binário `fasttext`). |
| Logs só no privado, não no grupo ADM | `admin_grupo_id` vazio ou bot fora do grupo ADM | Adicione o bot no grupo ADM → `/chatid` lá → `/setlog ID` no monitorado. |
| `/retreinar` diz aguarde 1 min | cooldown 60s | Aguarde e tente de novo. |
| Mensagem em russo punida mesmo liberada | alfabeto cirílico com flag marcada (flag vence exceção) | Desligue o cirílico (deixe OFF) e mantenha só a exceção marcada. |
| Emoji sozinho punido | impossível por design | Se puniu, era outro script junto — use `/sinais` p/ ver o motivo. |

- **Logs de moderação:** tabela `events` (`alfabeto_*/sem_*/ai_*/whitelist_*/settings_change`) + espelho no grupo ADM (`/setlog`) ou DM dos admins + `log/bot.log`.
- **Backups:** `backups/YYYY-MM-DD_HHMMSS/` com `codigo.tar.gz` + `grouphelp.db` + `MANIFEST.md`. Faça antes de atualizar: `tar -czf backups/$(date +%F_%H%M%S)/codigo.tar.gz --exclude=node_modules --exclude=.git .` + `cp db/grouphelp.db backups/.../`.
- **Graph:** `graphify update .` reconstrói o knowledge graph (`graphify-out/`) — AST grátis, sem LLM.

---

## 16. Scripts NPM

```json
{
  "bot": "node bot.js",
  "dev": "node bot.js",
  "db:seed": "node db/seeds.js",
  "db:init": "node db/seeds.js",
  "sem:treinar": "node bin/treinar.js"
}
```

---

## 17. Roadmap / ideias

- [ ] Painel web localhost Material Design 3 (citado na descrição do `package.json`, ainda não presente — hoje tudo é via Telegram).
- [ ] Testes automatizados p/ `normSelecao`, `analisarSinais`, `analisarTexto` e `detectarAlfabetoAtivo`.
- [ ] Rate-limit / antiflood (mensagens repetidas em janela curta).
- [ ] Comando `/stats` (warns + events por grupo/usuário).
- [ ] i18n do painel (PT/EN/ES).

---

*Gerado com `buildify` (graphify-first): `graphify update .` → `graphify query` → leitura de `bin/`, `app/`, `config/`, `db/` → árvore via `gerar-arvore-diretorios` → este README. Após mudar código, rode `graphify update .` de novo.*
