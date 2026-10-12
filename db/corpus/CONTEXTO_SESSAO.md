# DUMP DE CONTEXTO DA SESSÃO — AntiSpamBot
Gerado em: 2026-10-11 (UTC-3). Para continuar o trabalho amanhã sem perder nada.

## 1. O que é o projeto
Bot de moderação para Telegram em `/www/wwwroot/AntiSpamBot` (Node.js ESM, SQLite via better-sqlite3, node-telegram-bot-api). Entrada: `bot.js` → `bin/bot.js`. **100% local: 0 LLM, 0 API key, 0 rede.** Dono reinicia o bot manualmente (eu NÃO reinicio; só preparo o código).

## 2. Decisão arquitetural (definitiva)
Remodel radical feito nesta sessão: **abandonado todo o código LLM** (removidos `app/helpers/ai.js`, `app/controllers/ia_conexao.js`, `antispam_ai.js`, `censurar.js`). `.env` contém **só** `TELEGRAM_BOT_TOKEN`. Motor atual = IA clássica local:
- **fastText** (Meta, open-source MIT, binário via `apt install fasttext`) — `db/fasttext/spam.ftz` (+ `.vec`), treinado no corpus próprio.
- **Regex com pesos** (`app/helpers/sinais.js`, ~40 sinais PT-BR + inglês) com motivos em português.
- **Metadados de link** (`app/helpers/linkmeta.js`): julga cada link por domínio/TLD/caminho (TLD ruim, encurtador, IP, punycode, hífens, `t.me/+`, token de aposta/golpe no caminho **mesmo em domínio legal** — ex.: `lance.com.br/sites-de-apostas/` é punido por decisão do dono).
- **Bayes puro-JS** (`db/bayes.json`) como reserva.
- Fusão em `analisarTexto()` (`app/controllers/semantico.js`): **regras mandam**; o modelo escala e também age sozinho; o modelo **veta** falso positivo do regex (ex.: avisos "não cliquem… é phishing", cidade "Betim").

## 3. Níveis e punição (regras do dono)
- 🟡 baixo = só registra (não pune). 🟠 médio / 🔴 severo = **deleta + warn na escada**.
- **NUNCA ban direto** — tudo sobe warns até a ação final.
- Punição final padrão = **MUTE** (`acao_final: mute`, `max_warns: 3` nos 8 grupos do banco). Botão Final alterna Ban/Mute/Apenas-deletar.
- **🎚 Tolerância** (botões Baixo 50% / Médio 65% / Alto 80% / Personalizar 10–90): % mínima do modelo p/ entrar na escada. Semântica: Baixa = rigorosa (pune mais), Alta = perdoa. `modelo_min` (padrão 90) = barra do modelo sozinho.
- Contagem trava no máximo (nunca "23/5"); warns não acumulam além do teto; zera após punição aplicada.
- Admins ignorados por padrão (chave "Admin no teste" força).
- Whitelist (links/assuntos) = perdão antes de tudo.

## 4. Regras de exibição (exigências do dono)
- **No grupo: SÓ motivo + ação feita + contagem.** Nunca trecho, nunca %. Formato: `@user / Motivo: X / Ação feita: mensagem apagada / Registro 3/5 — faltam 2 para o mute`.
- **Trecho + % + sinais: SÓ no privado (DM) e no log dos ADMs** (grupo via `/setlog`).
- Erros do Telegram traduzidos: bad request → "Usuário não pode ser banido"; sem permissão; alvo admin/dono.
- Falha nunca derruba o resto: avisa só no privado, 1×/hora (`app/helpers/falhas.js` + guards globais em `bin/bot.js`).

## 5. Painel e comandos (estado final)
- Hub (`/settings` no privado): **🔤 Alfabetos** + **🛡 Antispam** + Concluir. Antispam tem: liga/desliga, avisos, Final, aviso no grupo, deletar, warn, admin no teste, 🎚 Tolerância, whitelist, **Retreinar**, voltar. (Disparar e Ver/Editar regras foram removidos do painel.)
- Comandos: `/start /reload /settings /setlog /chatid /perdao /perdaoai /regras /definir_regras <texto> /aistatus /sinais (teste a seco, sem punir) /analise (responde msg: pune se spam + veredito com % no privado) /retreinar`.
- `/aistatus` mostra motor local, sem menção a integração.

## 6. Corpus e treino
- Pasta: `db/corpus/` — `spam.json` + `nao_spam.json` (TREINO), `spam_teste.json` + `nao_spam_teste.json` (TESTE). Formato: `{id, idioma, conteudo, infracao|categoria}`.
- **Contagens em 2026-10-11 ~20:05 (dados NOVOS do dono, ainda NÃO treinados):** spam=29378, nao_spam=30000, spam_teste=29234, nao_spam_teste=29400.
- Treino: `node bin/treinar.js` (lê treino, avalia no teste; gera `db/fasttext/spam.ftz` + `db/bayes.json` + `db/fasttext/stats.json`; apaga o `.bin` gigante). Também via botão Retreinar / `/retreinar`.
- **Modelo em disco AGORA está DESATUALIZADO** (treinado no corpus antigo de 10k+11k; stats.json: P@1/R@1 0,994, fusão 100%/0 FP no teste antigo).
- ⚠️ Existe `db/fasttext/spam.bin` de 808MB de uma rodada antiga — o treino novo o remove sozinho; se faltar disco, apagar manualmente.

## 7. Estado operacional em 2026-10-11 (fim da sessão)
- Bot: **PARADO** (dono reinicia). Último modo no log: `alfabetos+semantico`.
- Pendência Nº 1 (pedido explícito): **retreinar com os dados novos e testar com os dados de teste, buscando o máximo de 100%**.
- Tradutor open-source (Argos) foi **cancelado pelo dono** — ele mesmo traduziu para 3 idiomas.
- Backups em `/www/wwwroot/AntiSpamBot/backups/` (timestampados, código + db).
- Node do bot: `/www/server/nodejs/v24.14.0/bin/node` (o `node` padrão é v20 e NÃO carrega o better-sqlite3). Rodar comandos sempre com o binário v24.
- fastText CLI em `/usr/bin/fasttext`. Binário opencode copiado em `/usr/local/bin/opencode` + auth em `/home/www/.local/share/opencode/` (legado da fase LLM, hoje sem uso pelo bot).
- `graphify-out/` atualizado pela última vez nesta sessão; rodar `graphify update /www/wwwroot/AntiSpamBot` após mudanças.

## 8. Lições/bugs já corrigidos (não reintroduzir)
- Leet só troca dígito colado em letra (`t1gr1nho→tigrinho`, `R$500` intacto); `@$!|+` fora do leet (quebravam `@trader`, `R$`, `+18`).
- Regex `bet` com limite de palavra (cidade "Betim" não casa; `alphabet` não casa com `bet` nos links — tokens exatos).
- URLs fora do leet (dígito de link virava letra: `83746906→beta`).
- Saves em **upsert** (`ON CONFLICT DO UPDATE`) — UPDATE puro perdia dados em grupos antigos sem a linha do módulo.
- Contagem de warns com clamp no máximo; `modelo_min=90` p/ modelo sozinho.
- Domínios confiáveis NÃO isentam caminho de aposta (decisão do dono).
