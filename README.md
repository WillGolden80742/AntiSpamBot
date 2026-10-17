# AntiSpamBot

> Bot Node.js + SQLite para moderação automática de grupos no Telegram — **2 motores, 0 IA externa, 0 rede, 0 chave paga**.
> Fiscaliza **alfabetos** (árabe, cirílico, chinês, hindi, bengali, não-ocidental, latim) + **antispam semântico trilíngue 🇧🇷🇪🇸🇺🇸** (regex com pesos + fastText local + Bayes de reserva) com painel inline no privado, whitelist, regras e trava de dono.

- **Stack:** Node.js ESM (`"type": "module"`) + `node-telegram-bot-api` (polling) + `better-sqlite3` (WAL) + `fasttext` (binário do sistema) + `tesseract-ocr` (leitura de imagens) + `dotenv`
- **Banco:** `db/grouphelp.db` (SQLite)
- **Modelos locais:** `db/fasttext/spam.ftz` (142 MB quantizado, usado pelo bot) + `db/bayes.json` (fallback puro-JS)
- **Idiomas:** 🇧🇷 Português · 🇪🇸 Espanhol · 🇺🇸 Inglês — corpus, regex e salvaguardas nos 3 idiomas
- **Corpus (4.000.000 msgs):** treino `db/corpus/spam.json` (1.000.000) + `db/corpus/nao_spam.json` (1.000.000) = 2.000.000 · teste separado `db/corpus/spam_teste.json` (1.000.000) + `db/corpus/nao_spam_teste.json` (1.000.000) = 2.000.000 — balanceado e trilíngue
- **Precisão atual (teste separado de 2.000.000):** fastText `P@1 0.999 / R@1 0.999` · **fusão bot (regras+modelo): 989.593/1.000.000 spam pego (99,0%), apenas 44 FP punidos no ham (0,0044%)** (e 73.803 🟡 só log) | Bayes `1.997.716/2.000.000` (1.103 FP)

---

## Índice

1. [O que o bot faz](#1-o-que-o-bot-faz)
2. [Suporte trilíngue (PT/ES/EN)](#2-suporte-trilíngue-ptesen)
3. [Estrutura de diretórios (DIR)](#3-estrutura-de-diretórios-dir)
4. [O que cada arquivo faz](#4-o-que-cada-arquivo-faz)
5. [Arquitetura e fluxo](#5-arquitetura-e-fluxo)
6. [Motor 1 — Alfabetos](#6-motor-1--alfabetos)
7. [Motor 2 — Antispam semântico](#7-motor-2--antispam-semântico)
8. [Painéis e comandos](#8-painéis-e-comandos)
9. [Banco de dados](#9-banco-de-dados)
10. [Instalação](#10-instalação)
11. [Configuração (.env)](#11-configuração-env)
12. [Rodando o bot](#12-rodando-o-bot)
13. [Treinamento (`bin/treinar.js`)](#13-treinamento-bintreinarjs)
14. [Whitelist, Regras e Tolerância](#14-whitelist-regras-e-tolerância)
15. [Trava de dono e segurança](#15-trava-de-dono-e-segurança)
16. [Logs, backups e troubleshooting](#16-logs-backups-e-troubleshooting)
17. [Scripts NPM](#17-scripts-npm)
18. [Roadmap / ideias](#18-roadmap--ideias)

---

## 1. O que o bot faz

| Capacidade | Como |
|---|---|
| **Bloqueia alfabetos indesejados** | Detecta árabe, cirílico, chinês (inclui japonês/coreano), hindi, bengali, *não-ocidental* (catch-all: grego, hebraico, tailandês…) e latim. Cada um com multisseleção: `Deletar / Silenciar / Banir / Progressivo`. Suporte opcional a **OCR via Tesseract** em fotos, documentos e stickers. |
| **Antispam trilíngue sem IA externa** | 3 camadas: 1) whitelist perdoa, 2) 71 regex com pesos em PT/ES/EN (desligável por grupo — links continuam valendo) + análise de links por metadados, 3) fastText local treinado em corpus trilíngue de 4M (ou Bayes). Níveis `🟡 baixo (só log) · 🟠 médio · 🔴 severo`. |
| **Punição em escada, nunca direta** | Alfa progressivo e semântico contam warns (`alfabeto:*`, `sem:*`) até `max_warns` (2–5) e só então aplicam `ban / mute / apenas deletar`. |
| **Painel 100% no Telegram** | `/settings` no grupo → botão abre o privado → hub → `Alfabetos` ou `Antispam` → submenus (tolerância, whitelist, regras, mínimo de caracteres, OCR). Retreino só via CLI no servidor. |
| **Varredura sob demanda** | Bot grava tudo que vê em `messages_log`; a função `varreduraGrupo` revarre os últimos 61 min (handler `ai_run`, sem botão no painel atual — legado de mensagens antigas). Tempo real julga cada mensagem na hora. |
| **Trava de dono** | Só o `OWNER_ID` adiciona o bot em grupos. Grupo estranho = aviso + `leaveChat` + limpeza local. |
| **Isolamento total de falhas** | `unhandledRejection/uncaughtException` só logam; cada listener tem `try/catch` + `notificarFalha` no privado. Bot nunca cai. |

---

## 2. Suporte trilíngue (PT/ES/EN)

O bot entende **Português, Espanhol e Inglês** em todas as camadas — sem tradutor externo, sem API, tudo local:

| Camada | Onde | Como funciona nos 3 idiomas |
|---|---|---|
| **Corpus** | `db/corpus/*.json` | Cada arquivo tem campo `idioma` (`Português`/`Espanhol`/`Inglês`), 4.000.000 de exemplos no total (2M treino + 2M teste balanceados) |
| **Regex de spam** | `app/helpers/sinais.js` | Padrões PT (`renda extra`, `saque do FGTS`, `vazou`) + ES (`gana dinero`, `tarjeta`) + EN (`earn $… a day`, `work from home`, `passive income`, `financial freedom`, `withdrawal of`) |
| **Salvaguardas anti-FP** | `app/controllers/semantico.js` → `ehAvisoOuConversaLegitima()` | Avisos legítimos reconhecidos nos 3 idiomas: `dá pra consultar o CPF` / `puedes comprobar el CPF` / `can you check the CPF` · `renovar CNH` / `renew CNH` · `tarjeta de registro de votante` / `voter registration card` · `ganhou/empatou de novo` / `de nuevo` · `fake giveaway` / `falso anúncio` |
| **Modelo fastText** | `db/fasttext/spam.ftz` | Treinado no corpus trilíngue misturado — detecta spam nos 3 idiomas com um único modelo |
| **Normalização** | `sinais.js → normalizar()` | Minúsculas + remove acentos (vale p/ PT/ES) + leet + repetições — antes de qualquer regex |

> Histórico: o tradutor automático open-source (Argos) foi avaliado e **cancelado** — o dono traduziu o corpus para os 3 idiomas manualmente, o que dá precisão maior que tradução por máquina.

---

## 3. Estrutura de diretórios (DIR)

```
AntiSpamBot/
├── app/
│   ├── controllers/
│   │   ├── acesso.js        # trava de dono (gate de entrada + rede 5min)
│   │   ├── alfabetos.js     # fiscal de alfabetos + progressivo + OCR Tesseract + logs ADM
│   │   ├── callbacks.js     # hub de botões inline (open/mod_alfa/ai/wl/ab_ocr/...)
│   │   ├── commands.js      # /start /settings /setlog /regras /analise /sinais...
│   │   └── semantico.js     # juiz semântico + varredura + tolerância (+ retreinar() órfã)
│   ├── helpers/
│   │   ├── admin.js         # guard/senderIsAdmin/targetIsStaff/isAnonymousAdmin/ensureBotPerm/friendlyError
│   │   ├── buffer.js        # messages_log: registra/lê janela/poda/marca julgadas
│   │   ├── classico.js      # fastText (.ftz→.bin) + Bayes fallback (prob≥0.9)
│   │   ├── defaults.js      # DEFAULT_SETTINGS (seed de cada grupo novo)
│   │   ├── falhas.js        # notificarFalha no privado sem quebrar
│   │   ├── keyboards.js     # manageKeyboard/settingsKeyboard/openPrivate
│   │   ├── linkmeta.js      # extrairLinks/analisarLinks (TLD/encurtador/t.me)
│   │   ├── pending.js       # estado pendente p/ editar regras/whitelist no privado
│   │   ├── regras.js        # get/set texto das regras (módulo 'regras')
│   │   ├── sinais.js        # 71 regex PT/ES/EN com pesos + TOTAL_SINAIS + anti-ofuscação
│   │   └── whitelist.js     # links + assuntos perdoados (furam o juiz)
│   └── models/
│       └── group.js         # findOrCreate/backfill/list/visibleGroups/logEvent
├── bin/
│   ├── bot.js               # entry real: polling + register* + getMe log
│   └── treinar.js           # treino leve em streams (nice -n 19, flags --full/--amostra) + fusão + Bayes
├── config/
│   └── database.js          # better-sqlite3 + WAL + auto-exec schema.sql
├── db/
│   ├── corpus/
│   │   ├── spam.json            # 1.000.000 exemplos spam (TREINO trilíngue)
│   │   ├── nao_spam.json        # 1.000.000 exemplos ham (TREINO trilíngue)
│   │   ├── spam_teste.json      # 1.000.000 exemplos spam (TESTE separado)
│   │   └── nao_spam_teste.json  # 1.000.000 exemplos ham (TESTE separado)
│   ├── fasttext/
│   │   ├── spam.ftz         # modelo quantizado EM USO (142 MB, dim 100 / epoch 100 / lr 0.7)
│   │   ├── spam.vec         # vetores (463 MB, inspeção)
│   │   └── stats.json       # {treino:{2M}, teste:{2M}, fasttextTest, fusao:{...}, bayes:{...}}
│   ├── migrate/
│   │   └── 001_ai_mods.sql  # migração legada antispam_ai/censurar
│   ├── bayes.json           # modelo Bayes puro-JS (246 KB)
│   ├── grouphelp.db         # SQLite principal (+ -shm/-wal)
│   ├── schema.sql           # DDL: groups/settings/warns/messages_log/events
│   └── seeds.js             # seed demo (-1001001 Anarquia e Libertarianismo)
├── backups/                   # convenção do servidor (snapshots codigo.tar.gz + grouphelp.db) — não existe neste checkout
├── log/
│   └── bot.log              # log de runtime
├── graphify-out/            # knowledge graph (AST) — ver `graphify update .`
├── bot.js                   # entry raiz (só `import './bin/bot.js'`)
├── package.json             # name grouphelp-clone v1.0.0, scripts bot/db:seed/sem:treinar
├── .env.example             # modelo versionado (copie para .env e preencha)
├── .env                     # TELEGRAM_BOT_TOKEN + OWNER_ID (não commitar)
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── yarn.lock
```

> `node_modules/`, `graphify-out/`, `*.db-shm/-wal` e snapshots de `backups/` não são versionados — ver `.gitignore`.

---

## 4. O que cada arquivo faz

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
| `alfabetos.js` (775 linhas) | Fiscal de alfabetos + OCR | `ALFA_REGEX` por script + `detectarAlfabetoAtivo` (respeita desativados + exceções do não-ocidental + ignora emoji puro + ignora `/comandos` + ignora staff salvo `punir_staff`). Suporte a **OCR via Tesseract** em fotos, imagens e stickers estáticos (`ler_imagens`). `aplicarSelecaoImediata` vs `aplicarProgressivo`. Logs espelhados em `logNoGrupoADM` ou DM dos admins. Ouve `message` + `edited_message`. |
| `semantico.js` (436 linhas) | Juiz semântico trilíngue | `analisarTexto` (regex PT/ES/EN+modelo+tolerância, com chave `regex` que desliga os padrões de texto) → `julgarNucleo` (baixo=só `sem_log`; médio/severo=delete+warn em escada até ban/mute) → `julgarMensagem` (tempo real + buffer + whitelist + staff + filtro de tamanho mínimo de caracteres desconsiderando quebras de linha). Painéis `painelSemantico/painelTolerancia/painelTolNumeros`. |
| `callbacks.js` (680 linhas) | Todos os botões inline | Prefixos `open:/done:/mod:/mod_alfa:/ab:/ab_tgl:/ab_set: (legado)/ab_exceto:/ab_excts:/ab_prog:/ab_max:/ab_final:/ab_warnmsg:/ab_log:/ab_ocr:/ab_staff:` (alfabetos) + `ai:/ai_tgl:/ai_max:/ai_final:/ai_warnmsg:/ai_del:/ai_warn:/ai_staff:/sem_regex:/sem_min:/sem_min_set:/sem_min_arroba:/sem_min_link:` (antispam) + `sem_tol:/sem_tol_custom:/sem_tol_set:` + `cens_ver:/cens_editar:` (regras) + `wl:/wl_add_link:/wl_add_assunto:/wl_rm_*`. Multisseleção com exclusividades. |
| `commands.js` (307 linhas) | Comandos `/` | `/start` (privado=hub, grupo=requisito admin), `/reload` (sincroniza admins), `/settings|/config|/pvtconfig` (abre privado), `/setlog [ID\|aqui\|limpar]` (grupo ADM de logs), `/chatid`, `/regras`, `/definir_regras`, `/analise` (reply: veredito + % + ação no privado), `/aistatus`, `/sinais` (dry-run sem punir), `/perdaoai` (zera `sem:*`), `/perdao` (zera `alfabeto:*`). Sem `/retreinar` (removido — retreino só via CLI). |

### Helpers (`app/helpers/`)

| Arquivo | O que tem dentro |
|---|---|
| `admin.js` | `guard` (só grupo + só admin), `senderIsAdmin`, `targetIsStaff`, `isAnonymousAdmin`, `ensureBotPerm` (checa `can_restrict_members`/`can_delete_messages` antes de punir). |
| `buffer.js` | `registrarMensagem` (cada msg vista) · `lerJanela(gid, 3600s)` (só não-julgadas) · `marcarJulgadas` (`julgado_em`) · `podar` (limpa antigas). Base da `varreduraGrupo` (61 min). |
| `classico.js` | `temModelo()` (.ftz ou .bin) · `classificar()` (fastText via `predict-prob` → P(spam); fallback Bayes com corte 0.9) · `statsModelo()` (lê `stats.json`) · `reload()`. |
| `defaults.js` | `DEFAULT_SETTINGS`: alfabetos tudo `desativado` + progressivo ON 3x ban; semantico OFF + deletar/warn ON 3x mute tol 65 + regex ON; regras padrão 3 linhas; whitelist vazia. |
| `falhas.js` | `notificarFalha(bot,gid,modulo,msg)` — avisa admins no privado sem derrubar o loop. |
| `keyboards.js` | `manageKeyboard(groups)`, `settingsKeyboard(gid)` (hub com 2 motores), `openPrivateKeyboard(botUsername)` (deep-link `t.me/bot?start=`), `manageText`. |
| `linkmeta.js` | `URL_RE`, `extrairLinks` (máx 10/msg), `analisarLinks` — classifica link por TLD estranho (29 TLDs), encurtador (13 domínios), `t.me`, caminho suspeito. 115 domínios confiáveis que vetam phishing. Cada suspeito = +4 no score. |
| `pending.js` | `setPendente/getPendente/clearPendente` (mapa chat+user → `{gid,tipo}`) para fluxos de 1 mensagem no privado (regras/whitelist). `cancelar` desiste. |
| `regras.js` | `getRegrasTexto/setRegrasTexto` (módulo `regras`, máx 4000 chars, mín 10; adota legado `censurar`). Critério humano que o painel exibe. |
| `sinais.js` | `normalizar` (minúscula, NFD sem acento, leet só dígito colado em letra `t1gr1nho→tigrinho`, zero-width, colapsa repetições) · `SINAIS` (71 regex PT/ES/EN peso 1/2/3/4 com motivo PT-BR) · `analisarSinaisTexto()` (só padrões de texto) + `analisarSinaisLinks()` (só metadados de link) + `analisarSinais(texto, 3, 6)` (combinado: limiares fixos médio≥3, severo≥6; soma + CAPS + repetidos + flood de menções + links) → `{score,nivel,motivos}` · `TOTAL_SINAIS` (=71). |
| `whitelist.js` | `getWhitelist/saveWhitelist/ehPermitido/painelWhitelist/removerWlItem` — `{links:[domínios], assuntos:[strings]}` (máx 200 cada; botões ❌ só pros 10 primeiros de cada lista). Perdão total: nem é julgado. |

### Model e DB

| Arquivo | Papel |
|---|---|
| `app/models/group.js` | `findOrCreateGroup` (cria grupo + seed de todos os módulos + backfill de módulos novos) · `listGroups` · `visibleGroupsFor` (só onde bot E usuário são admins, checagem live) · `getModule` · `logEvent`. |
| `db/schema.sql` | `groups(id,title)` · `settings(group_id,module,data,updated_at)` (módulos `alfabetos/semantico/regras/whitelist/acesso/...`) · `warns(id,group_id,user_id,reason,created_at)` · `messages_log(group_id,message_id,user_id,texto,criado_em,julgado_em)` · `events(id,kind,group_id,user_id,meta,created_at)`. |
| `db/seeds.js` | `pnpm db:seed`: grupo `-1001001 Anarquia e Libertarianismo` + defaults. Produção usa `/reload` no Telegram. |
| `db/migrate/001_ai_mods.sql` | Cria `messages_log` + índice (idempotente). A adoção dos legados é no código: `antispam_ai→semantico` em `getSemCfg()`, `censurar→regras` em `getRegrasTexto()` (`ia_conexao` está morto). |
| `db/corpus/*.json` | Treino + teste separados e trilíngues: `{id, idioma, conteudo, infracao|categoria}`. Treino 29.378 spam + 30.000 ham · teste 29.234 + 29.400 (~118k total, ~10k por idioma/classe). |
| `db/fasttext/spam.ftz` | Modelo em uso (quantizado, dim 100/epoch 100, treinado no corpus trilíngue). `.vec` = vetores p/ inspeção. `stats.json` = métricas do último treino (fastText + fusão + Bayes). |
| `db/bayes.json` | `{ns,nh,ts,th,vocab}` — fallback quando fastText ausente. |

---

## 5. Arquitetura e fluxo

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
   classico.js → fastText .ftz trilíngue (predict-prob) ou Bayes (≥0.9)
   sinais.js + linkmeta.js → score regex PT/ES/EN + motivos PT-BR
```

**Ordem do juiz semântico** (`julgarMensagem`): só grupo → ignora bot/comando → `registrarMensagem` → se `enabled=false` para → se sem modelo loga `sem_degraded` → staff passa se `punir_staff=false` → whitelist perdoa → `julgarNucleo` → `marcarJulgadas`.

**Fusão regex+modelo** (`analisarTexto`, limiares do regex fixos `3/6`): com a chave `regex` **ligada** (padrão), severo/médio do regex (com veto do modelo se `pct<15` → vira baixo) · `score≥1` + `pct>tolerância` → médio senão baixo · `score=0` + `pct>modelo_min` → médio · `pct≥50` → baixo · senão limpo. Com a chave **desligada** (`cfg.regex === false`), os 71 padrões de texto somem (`score` de texto = 0) — ficam **só os metadados de link (sempre ativos) + o modelo local**. O `modelo_min` fecha a torneira do modelo puro: sem nenhum sinal, só vira punição acima dele (90 via `getSemCfg`; 95 no fallback interno quando a cfg não traz o campo). Salvaguardas trilíngues (`ehAvisoOuConversaLegitima`) passam na frente de tudo.

---

## 6. Motor 1 — Alfabetos

Regex em `ALFA_REGEX`: árabe `0600-06FF+0750-077F+08A0-08FF`, cirílico `0400-04FF+0500-052F`, chinês `4E00-9FFF+3400-4DBF+F900-FAFF+3040-30FF+AC00-D7AF` (pega chinês/japonês/coreano), hindi `0900-097F`, bengali `0980-09FF`, não-ocidental `[^0000-024F,0300-036F,1D00-1DBF,1E00-1EFF,2C60-2C7F,A720-A7FF,AB30-AB6F]` (catch-all), latim `[A-Za-zÀ-ÿ]` por último. Ordem `CHECK_ORDER`: arabe → cirilico → chines → hindi → bengali → nao_ocidental → latim.

- **Emoji puro nunca pune:** `temLetraOuNumeroNaoOcidental` exige letra/número de outro script (`\p{L}\p{N}`). `"ótimo 👍"` passa.
- **Exceções:** `exceto_nao_ocidental: [cirilico,...]` — russo passa, hebraico continua bloqueado (`stripScripts` + `passaNaExcecao`).
- **OCR Tesseract em Imagens:** toggle `🖼 Ler imagens` (`ab_ocr`, default **desativado**): quando ativado, se a mensagem contiver imagem (foto em alta resolução, documento com mime-type de imagem ou sticker estático) e não for detectada infração no texto visível, o bot baixa a imagem e executa o Tesseract localmente (`por+eng+rus+ara+chi_sim+chi_tra+hin+ben+jpn+kor+tha+heb+ell`). Se encontrar alfabeto restrito dentro da imagem, aplica a punição configurada e anexa o texto lido no log/aviso.
- **Multisseleção por alfabeto:** `{deletar, silenciar, banir, progressivo}`. Legado string (`desativado/deletar/silenciar+deletar/ban+deletar/progressivo`) migra sozinho via `normSelecao`. Regras de exclusão: progressivo × (silenciar/banir); silenciar × banir; deletar combina com tudo; desmarcar tudo = desativado.
- **Progressivo global:** `progressivo_enabled` (default ON), `max_warns` 2–5 (default 3), `acao_final` ban/mute/deletar, `avisar_no_grupo`, `log_no_admin_grupo` + `admin_grupo_id`, `punir_staff` (modo teste, default OFF = staff totalmente ignorado, sem delete/warn), `ler_imagens` (default OFF).
- **Apenas deletar:** se só `deletar` marcado (ou `acao_final=deletar`), nunca conta warn, nunca restringe — só apaga + avisa curto + log ADM.

---

## 7. Motor 2 — Antispam semântico

`sinais.js`: normalização anti-ofuscação + 71 padrões em **PT/ES/EN** (pesos 4/3/2/1, cada um com motivo em PT-BR):

- **Peso 4 (certeiro):** tigrinho/fortune tiger/aviãozinho/cassino/bet · renda extra/lucro garantido/fique rico/método secreto/retorno fixo · *earn $…/day, work from home, make money, passive income, crypto giveaway* · phishing conta bloqueada/taxa correios/benefício (só sem domínio confiável junto) · golpe empréstimo/FGTS/airdrop/staking · pedido de pix por engano/familiar internado/código por engano · sorteio falso (iPhone/carro/concorra) · seleção falsa (benefício governo/comenta eu quero) · leilão/apreensão (moto/carro/Detran/PF) · moto apreendida · adulto (vazad/onlyfans/nudes/novinha/packs/+18) · *depoimento falso trader em EN (financial freedom, withdrawal of, made over $…)*.
- **Peso 3:** malware (whatsapp gb/apk) · venda falsa (CNH/diploma) · falso lucro (saquei lucro).
- **Peso 2:** trader/forex · dinheiro (R$ mil por dia/pix/saque) · bônus 200% · robô sinais · divulgação (entra no meu grupo/link na bio/anuncie aqui) · casa de apostas (bacbo/bet7k/tigre vip/cashback) · falsa vaga · crédito liberado · oferta falsa.
- **Peso 1:** urgência (só hoje/últimas vagas) · emoji dinheiro · CAPS com 20+ letras e >60% maiúsculas (+1, motivo `caixa alta`) · 5+ caracteres repetidos `(.)\1{4,}` (+1) · flood de menções: 5+ `@perfil` +2 · 8+ +4 · 12+ +6 · cada link suspeito (+4) · 3+ links (+1).

Anti-ofuscação: leet **só em dígitos colados em letra** (`t1gr1nho→tigrinho`, `R$500` intacto, `+18`/`!!!`/`$`/`@trader` intactos) + zero-width removido + repetições colapsadas (`oooo→oo`). `R$` agora exige valor (`\d+\s*(mil|por dia|de lucro|garantido|…)`) — evita FP em conversa normal sobre preço.

`linkmeta.js`: julga por **metadados**, não por lista — TLD estranho, encurtador, `t.me`, caminho com aposta. Domínios confiáveis (`gov.br, wikipedia, github, google, youtube…`) **vetam** phishing.

Punição (`julgarNucleo`): `baixo` = só `events(sem_log)`, silencioso. `médio/severo` sobem a **mesma escada**: deleta (se `deletar`) + warn `sem:*` até `max_warns` → `ban/mute` (se `acao_final≠deletar`, com `can_restrict_members` checada antes) e zera. Se `warn=false`, só deleta. No grupo a mensagem é `{emoji} {arroba}\nMotivo: …\nAção feita: …\nRegistro X/Y — faltam Z para o mute/ban` (sem trecho, sem %) — trecho + % + sinais vão só no privado/ADM.

---

## 8. Painéis e comandos

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
| `/perdaoai [@\|ID\|reply]` | grupo | Zera warns `sem:*` (+ legados `ai:*/censura:*`). |
| `/perdao [@\|ID\|reply]` | grupo | Zera warns `alfabeto:*`. |

### Painéis inline (`callbacks.js`)

`CONFIGURAÇÕES → [🔤 Alfabetos] [🛡 Antispam] | [✅ Concluir]` — cada motor tem seu botão `👥 Warns & Bans` dentro da própria sessão.
- **Alfabetos:** submenu por escrita (4 flags) + `Não ocidental libera:` (5 exceções) + passo a passo ON/OFF, avisos 2–5, ação final ban→mute→deletar, aviso no grupo, registro ADM, `🖼 Ler imagens` (OCR Tesseract para fotos/imagens/stickers), testar com admins + `👥 Warns & Bans (Alfabetos)` (só warns `alfabeto:*` e bans `alfabeto_ban/mute`).
- **Antispam (`painelSemantico`):** liga/desliga, avisos 2–5, Final, aviso no grupo, toggles Deletar/Warn, admin no teste, `Mínimo de Caracteres` (desativado/10..100 com exceções `@` e link), `Tolerância` (50/65/80 + grade 10–90), ✅/⬜ `Regex texto` (padrão ligado; desligado = só links + modelo), `Whitelist` (links/assuntos + add/remove), regras (ver/editar via `pending.js`) + `👥 Warns & Bans (Antispam)` (só warns `sem:*` e bans `sem_ban/mute`), voltar.
- **Usuários por motor (`painelListaUsuarios`, `usuarios.js:MOTORES`):** cada lista mostra SÓ quem tem pendência naquele motor (NOME primeiro, completa via `getChatMember` e salva no cache `users`), ordenação `📜 Ver antigos` / `🕒 Ver recentes` e `🌐 não ocidentais por último`, paginação preservando busca + ordem, badges (`⚠️ X` / `🚫 Y`), busca com anti-duplo-clique e `❌ Limpar busca`. Detalhe mostra status live + histórico SÓ do motor e os botões **Zerar Warns (motor)** / **Desbanir / Desmutar** afetam só aquele motor. Volta para a sessão de origem (`mod_alfa` ou `ai`).

---

## 9. Banco de dados

`db/schema.sql` (WAL, FK ON):

```sql
groups(id TEXT PK, title TEXT)
settings(group_id, module, data JSON, updated_at) PK(group_id,module)
warns(id AI PK, group_id, user_id, reason, created_at)       -- reason 'alfabeto:*' ou 'sem:*'
messages_log(group_id, message_id, user_id, texto, criado_em, julgado_em) PK(group_id,message_id)
events(id AI PK, kind, group_id, user_id, meta JSON, created_at)
users(id PK, username, first_name, last_name, atualizado_em) -- cache de perfis conhecidos
```

Módulos em `settings.data`: `alfabetos` (7 seleções + progressivo/max/ação final/aviso/log ADM/grupo ADM/modo teste/ler_imagens) · `semantico` (enabled/deletar/warn/avisar/max_warns/acao_final/log/staff/tolerância/modelo_min/regex/minimo_chars/ignorar_min_arroba/ignorar_min_link) · `regras` (texto) · `whitelist` (links/assuntos) · `acesso` (autorizado/adicionado_por/em). Adoção automática de legados: `antispam_ai→semantico` (`getSemCfg`), `censurar→regras` (`getRegrasTexto`).

---

## 10. Instalação

Pré-requisitos: **Node 20+** (`better-sqlite3` v11 exige Node moderno — testado em v22; no servidor de produção usa-se o binário dedicado do Node v24), **fasttext** (binário), **tesseract-ocr** (binário + idiomas para OCR de imagens), **pnpm ou npm**.

```bash
# 1. clone / entre na pasta
git clone https://github.com/WillGolden80742/AntiSpamBot.git
cd AntiSpamBot

# 2. instale deps (escolha 1)
pnpm install        # ou: npm install --no-audit --no-fund

# 3. instale o fasttext e o tesseract-ocr (Ubuntu/Debian)
sudo apt update && sudo apt install -y fasttext tesseract-ocr tesseract-ocr-por tesseract-ocr-eng tesseract-ocr-rus tesseract-ocr-ara tesseract-ocr-chi-sim tesseract-ocr-chi-tra tesseract-ocr-hin tesseract-ocr-ben tesseract-ocr-jpn tesseract-ocr-kor tesseract-ocr-tha tesseract-ocr-heb tesseract-ocr-ell
# macOS: brew install fasttext tesseract tesseract-lang
fasttext -h  # deve abrir a ajuda
tesseract --version  # deve exibir a versão do Tesseract

# 4. configure o .env (ver próxima seção)
cp .env.example .env && nano .env

# 5. inicie o banco + treine o modelo (primeira vez)
node db/seeds.js
node bin/treinar.js

# 6. rode o bot
node bot.js           # ou: pnpm bot / pnpm dev
```

---

## 11. Configuração (.env)

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

## 12. Rodando o bot

```bash
node bot.js            # produção simples
pnpm bot               # alias
pnpm dev               # alias dev (mesmo entry)
node bin/bot.js        # direto no bin (convenção Rails)
```

Saída esperada: `Bot online como @SeuBot | MODO: alfabetos+semantico | trava de dono | DB: db/grouphelp.db`.

Para manter online na VPS: `pm2 start bot.js --name antispam`, `systemd`, ou `tmux`/`screen`. O código só loga no console — `log/bot.log` é o destino do redirect do gerenciador de processo.

---

## 13. Treinamento (`bin/treinar.js`)

```bash
node bin/treinar.js                # modo leve com streaming e prioridade baixa (nice -n 19)
node bin/treinar.js --full         # modo full (epoch 100, dim 100, threads=12)
node bin/treinar.js --amostra 5000 # teste rápido em lote menor
# ou via npm: pnpm sem:treinar (só no servidor — sem via Telegram)
```

Pipeline (todo local, sem rede, otimizado para não sobrecarregar memória RAM):
1. **Streaming em blocos de 64 KB**: Não faz `JSON.parse` em arquivos inteiros de quase 1 GB. Extrai campos em stream diretamente para `/tmp/ft_train.txt` e `/tmp/ft_test.txt`.
2. Lê treino `db/corpus/spam.json` (1.000.000) + `nao_spam.json` (1.000.000) = **2.000.000** e teste `db/corpus/spam_teste.json` (1.000.000) + `nao_spam_teste.json` (1.000.000) = **2.000.000**. Total **4.000.000 de mensagens balanceadas**.
3. `fasttext supervised` executado com `nice -n 19` (prioridade mínima de CPU).
4. `quantize` gera o binário otimizado `spam.ftz` (142 MB).
5. Avalia no **teste separado de 2.000.000**: `fasttext test` (P@1 / R@1) + probabilidades por classe.
6. **Recall REAL do bot (fusão regras+modelo)** no teste: replica `nivelFusao` com `TOL 65`.
7. Salva `db/fasttext/stats.json` com resumo completo.

Último treino (`2026-10-17`): treino 2.000.000 (spam 1.000.000 / ham 1.000.000) · teste 2.000.000 (1.000.000 / 1.000.000) · fastText `P@1 0.999 R@1 0.999` · **fusão bot: spam pego 989.593/1.000.000 (99,0%), escapou 10.407, ham punido (FP) 44/1.000.000 (0,0044%), só log 🟡 73.803** · Bayes `1.997.716/2.000.000` (FP 1.103).

---

## 14. Whitelist, Regras e Tolerância

- **Whitelist** (`wl:`): domínios (`exemplo.com`) e assuntos (frases) que **furam o juiz** — nem são analisados. Gerencie no painel ou no privado (fluxo `pending.js`, `cancelar` desiste). Ideal p/ links oficiais do grupo e avisos da moderação.
- **Regras** (`cens_ver/cens_editar`, `/regras`, `/definir_regras`): texto humano exibido no painel do antispam como *critério*. Não é regex — é referência p/ admins e membros.
- **Tolerância** (`sem_tol`, default **65%**, clamp 0–100) + **`Regex texto`** (`sem_regex`, default **ligado**): com o regex desligado, os 71 padrões somem e valem só metadados de link + modelo local (ideal p/ grupos que só querem pegar link de aposta/golpe sem filtrar texto). `Baixo 50%` = rigoroso (pune mais) · `Médio 65%` · `Alto 80%` = perdoa mais · `Personalizar` (grade 10–90; o handler aceita 0–100). Com o regex ligado, severo **sempre** pune independente da tolerância (salvo veto `pct<15`). **Modelo puro sem regex** só pune acima de `modelo_min` (faixa 50–100; 90 vindo do `getSemCfg`, 95 no fallback interno) — abaixo disso vira só 🟡 log. Ação final efetiva em grupos novos: semântico `mute` (seed), alfabetos `ban` (o fallback do código quando o campo falta é `ban` nos dois).
- **Mínimo de Caracteres no Antispam** (`sem_min`, default **30** caracteres, opções: `Desativado (0)`, `10`, `20`, `30`, `40`, `50`, `60`, `100`):
  - Mensagens com quantidade de caracteres menor que o limite configurado são descartadas e não passam pela análise do antispam.
  - **Desconsidera quebras de linha**: o comprimento para o filtro conta apenas caracteres reais, removendo `\r\n` e `\n` antes de checar a contagem (`lenSemQuebras`).
  - **Exceção `Ignorar regra quando tiver @`** (`sem_min_arroba`): quando ativa, qualquer mensagem contendo `@` (ex: menção ou arroba) é forçada a passar pela análise de spam, mesmo que seja menor que o mínimo de caracteres.
  - **Exceção `Ignorar regra quando tiver link`** (`sem_min_link`): quando ativa, qualquer mensagem contendo link é forçada a passar pela análise de spam, mesmo que seja menor que o mínimo de caracteres.
  - **Detecção de links inteligentes:** reconhece links com ou sem protocolo (`http/https/www/t.me` e domínios diretos como `virus.aposta.betnacional.ru` ou `1.d`), ignorando pontuações gramaticais de final de frase (ex: `"Boa noite."`).
  - **Exclusividade:** este filtro de caracteres atua estritamente no motor Antispam; o motor de **Alfabetos** não sofre restrição de tamanho de mensagem.
- **Nome do Grupo em Negrito nos Menus:** Todos os menus e submenus inline (Hub principal, Antispam, Mínimo de Caracteres, Tolerância, Whitelist, Alfabetos, Detalhes de Alfabeto e Exceções) exibem o nome do grupo configurado em negrito no topo (`👥 <b>Nome do Grupo</b>`).

---

## 15. Trava de dono e segurança

- `OWNER_ID` ausente → trava desligada + warn no log (não trava o bot antes de configurar).
- Bot adicionado por não-dono → avisa no grupo + `leaveChat` + apaga `groups/settings/warns` locais + `events(acesso_saida)`.
- Grupos no banco antes de ligar a trava contam como legado (do dono).
- Edição de config exige ser **admin do grupo** (`canEdit`/`guard` checam live via `getChatAdministrators`).
- Produção (`punir_staff=false`): staff é **totalmente ignorado** (sem delete/warn/aviso) e warns antigos do admin são limpos. Ligue `punir_staff` só p/ testar.
- Bot precisa ser admin com *apagar + restringir*; sem permissão ele **avisa** em vez de falhar silencioso.
- `.env`, `*.db` e chaves em `backups/` **nunca** vão pro git. Punições no grupo mostram só motivo + ação + contagem (sem trecho/%); trecho + % + sinais vão só ao privado/ADM — exceção: o `/sinais` (dry-run de admin) mostra nível, motivos, score e % **no grupo**, e o `/aistatus` rotula o 🔴 como "ban direto" (o código nunca bane sem escada).

---

## 16. Logs, backups e troubleshooting

| Sintoma | Causa provável | Solução |
|---|---|---|
| `Falta TELEGRAM_BOT_TOKEN` | `.env` sem token | Preencha e reinicie. |
| Bot não pune | Não é admin / sem permissão / módulo desligado / staff ignorado / whitelist perdoou / sem modelo | Dê admin + permissões → `/reload` → ligue o motor → cheque `punir_staff` → `/sinais` (reply) p/ dry-run → `/aistatus` p/ modelo. |
| `modelo local ausente` (varredura) | sem `.ftz` | `node bin/treinar.js` no servidor (precisa do binário `fasttext`). |
| Logs só no privado, não no grupo ADM | `admin_grupo_id` vazio ou bot fora do grupo ADM | Adicione o bot no grupo ADM → `/chatid` lá → `/setlog ID` no monitorado. |
| Mensagem em russo punida mesmo liberada | alfabeto cirílico com flag marcada (flag vence exceção) | Desligue o cirílico (deixe OFF) e mantenha só a exceção marcada. |
| Emoji sozinho punido | impossível por design | Se puniu, era outro script junto — use `/sinais` p/ ver o motivo. |

- **Logs de moderação:** tabela `events` (`sem_log/delete/aviso/ban/mute/degraded/treino`, `alfabeto_punicao/delete/aviso/ban/mute`, `acesso_saida`, `settings_change`, `whitelist_change`, `regras_change`, `*_falha`) + espelho no grupo ADM (`/setlog`) ou DM dos admins + console (`log/bot.log` via redirect).
- **Backups** (convenção do servidor): `backups/YYYY-MM-DD_HHMMSS/` com `codigo.tar.gz` + `grouphelp.db` + `MANIFEST.md`. Faça antes de atualizar: `mkdir -p backups/$(date +%F_%H%M%S) && tar -czf backups/$(date +%F_%H%M%S)/codigo.tar.gz --exclude=node_modules --exclude=.git .` + `cp db/grouphelp.db backups/.../`.
- **Graph:** `graphify update .` reconstrói o knowledge graph (`graphify-out/`) — AST grátis, sem LLM.

---

## 17. Scripts NPM

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

## 18. Roadmap / ideias

- [x] Suporte trilíngue PT/ES/EN (corpus + regex + salvaguardas) — **pronto em 2026-10-11**.
- [x] OCR Tesseract em imagens para fiscal de alfabetos (`ler_imagens`) — **pronto em 2026-10-17**.
- [x] Expansão do corpus para 4.000.000 de mensagens e otimização de treino em stream (`nice -n 19`) — **pronto em 2026-10-17**.
- [ ] Painel web localhost Material Design 3 (citado na descrição do `package.json`, ainda não presente — hoje tudo é via Telegram).
- [ ] Testes automatizados p/ `normSelecao`, `analisarSinais`, `analisarTexto` e `detectarAlfabetoAtivo`.
- [ ] Rate-limit / antiflood (mensagens repetidas em janela curta).
- [ ] Comando `/stats` (warns + events por grupo/usuário).
- [ ] i18n do painel do Telegram (PT/EN/ES, acompanhando o motor).

---

*Gerado com `buildify` (graphify-first): `graphify update .` → leitura de `bin/`, `app/`, `config/`, `db/` → contagens reais do corpus trilíngue (4.000.000 exemplos) e do último treino (`stats.json`: fusão 99,0% / FP 0,0044%). Após mudar código, rode `graphify update .` de novo.*
