// SÓ alfabeto: helpers de staff + permissão do bot para deletar/restringir.
// Removidos: moderate() (era dos comandos ban/mute/kick manuais) e
// permissões fora do escopo (fixar, convidar).
export async function senderIsAdmin(bot, chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(m.status);
  } catch {
    return false;
  }
}

// Admin anônimo fala como o próprio grupo (sender_chat = chat).
// Nesse caso o Telegram esconde o ID real: confiamos que é um admin.
export function isAnonymousAdmin(msg) {
  return !!(msg.sender_chat && String(msg.sender_chat.id) === String(msg.chat.id));
}

export const PERM_LABEL = {
  can_restrict_members: 'Banir usuários',
  can_delete_messages: 'Apagar mensagens',
};

async function botMember(bot, chatId) {
  const me = await bot.getMe();
  try {
    return await bot.getChatMember(chatId, me.id);
  } catch {
    return null;
  }
}

export async function ensureBotPerm(bot, chatId, perm) {
  const m = await botMember(bot, chatId);
  if (!m || !['creator', 'administrator'].includes(m.status)) return { ok: false, reason: 'not_admin' };
  if (m.status === 'creator') return { ok: true };
  if (perm && !m[perm]) return { ok: false, reason: 'no_perm', perm };
  return { ok: true };
}

export async function targetIsStaff(bot, chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(m.status);
  } catch {
    return false;
  }
}

// Traduz erros comuns da API do Telegram para português claro e acionável.
// SÓ escopo alfabeto (deletar/restringir + staff).
const API_PT = [
  [/bot is not an admin/i, 'Bot sem status de administrador neste grupo. Ação não executada.\nAção necessária: grupo > Editar > Administradores > adicionar este bot com todas as permissões.'],
  [/not enough rights to restrict/i, 'Bot sem permissão de restringir membros. Ação não executada.\nAção necessária: grupo > Editar > Administradores > tocar neste bot > ativar "Banir usuários".'],
  [/not enough rights to delete/i, 'Bot sem permissão de apagar mensagens. Ação não executada.\nAção necessária: grupo > Editar > Administradores > tocar neste bot > ativar "Apagar mensagens".'],
  [/user is an administrator/i, 'O alvo é um administrador (staff) e o Telegram proíbe puni-lo.\nSe for o caso, o dono precisa primeiro remover o cargo dele em Editar > Administradores.'],
  [/can't remove chat owner/i, 'Esse é o DONO do grupo: ninguém pode removê-lo ou puni-lo, nem o bot.'],
  [/message to delete not found/i, 'Essa mensagem já foi apagada ou é antiga demais para apagar. Nada a fazer.'],
  [/message can't be deleted/i, 'Essa mensagem não pode ser apagada (muito antiga ou mensagem de serviço do Telegram).'],
];

export function friendlyError(e) {
  const raw = e?.response?.body?.description || e?.message || String(e);
  for (const [re, pt] of API_PT) {
    if (re.test(raw)) return `${pt}\n\nDetalhe técnico: ${raw}`;
  }
  return 'Comando não executado.\n' +
    'Verificar: (1) bot como ADMIN do grupo com a permissão correspondente; ' +
    '(2) o alvo não é admin nem dono.\n' +
    `Detalhe técnico: ${raw}`;
}

// Envolve ação de moderação: exige admin (detectando modo anônimo) + traduz erro da API.
export async function guard(bot, msg, fn, needReplyHint) {
  if (msg.chat.type === 'private') {
    await bot.sendMessage(msg.chat.id, 'Comando disponível apenas dentro do grupo.');
    return;
  }
  const admin = isAnonymousAdmin(msg) || (await senderIsAdmin(bot, msg.chat.id, msg.from.id));
  if (!admin) {
    await bot.sendMessage(msg.chat.id,
      'Ação restrita a administradores. Verificação: não confirmada.\n\n' +
      'Causa comum: modo anônimo (conta oculta pelo Telegram).\n' +
      'Procedimento: selecionar a conta pessoal e repetir o comando.\n\n' +
      'Alternativa: solicitar a execução a um administrador.');
    return;
  }
  try {
    await fn();
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `${friendlyError(e)}${needReplyHint ? `\n${needReplyHint}` : ''}`);
  }
}
