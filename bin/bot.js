#!/usr/bin/env node
// bin/bot — alfabetos (línguas) + antispam semântico (links, 0 IA) + whitelist + trava de dono.
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { registerCommands } from '../app/controllers/commands.js';
import { registerCallbacks } from '../app/controllers/callbacks.js';
import { registerAlfabetos } from '../app/controllers/alfabetos.js';
import { registerSemantico } from '../app/controllers/semantico.js';
import { registerAcesso } from '../app/controllers/acesso.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('Falta TELEGRAM_BOT_TOKEN no .env'); process.exit(1); }

// Isolamento global: nenhuma falha assíncrona derruba o bot — só loga.
// (cada módulo já se isola e avisa no privado; isto é a última rede.)
process.on('unhandledRejection', (e) => console.error('[bot] unhandledRejection isolada:', e?.message || e));
process.on('uncaughtException', (e) => console.error('[bot] uncaughtException isolada:', e?.message || e));

const bot = new TelegramBot(token, { polling: true });
registerCommands(bot);
registerCallbacks(bot);
registerAlfabetos(bot);
registerSemantico(bot);
registerAcesso(bot);
bot.getMe().then((me) => console.log(`Bot online como @${me.username} | MODO: alfabetos+semantico | trava de dono | DB: db/grouphelp.db`));
