// Hub enxuto: 2 motores (Alfabetos + Antispam). Regras e Whitelist moram no Antispam.
export function settingsKeyboard(gid) {
  return {
    inline_keyboard: [
      [{ text: '🔤 Alfabetos', callback_data: `mod_alfa:${gid}` }],
      [{ text: '🛡 Antispam', callback_data: `ai:${gid}` }],
      [{ text: '✅ Concluir', callback_data: `done:${gid}` }],
    ],
  };
}

// Print 2: grupos vinculados exibem ↗
export function manageKeyboard(groups) {
  if (!groups.length) {
    return { inline_keyboard: [[{ text: 'Nenhum grupo — envie /reload no grupo', callback_data: 'noop' }]] };
  }
  return { inline_keyboard: groups.map((g) => [
    { text: g.title, callback_data: `open:${g.id}` },
  ]) };
}

// null quando não há username (chamador envia sem botão)
export function openPrivateKeyboard(username) {
  if (!username) return null;
  return { inline_keyboard: [[{ text: 'Abrir em chat privado', url: `https://t.me/${username}?start=settings` }]] };
}

// Texto do Print 2 — Gerenciar configurações
export function manageText(botUsername) {
  return 'Gerenciar configurações\n' +
    'Selecione o grupo para configurar.\n\n' +
    'Grupo não listado (requisito: conta com cargo de admin):\n' +
    '• Envie /reload no grupo e tente novamente.\n' +
    `• Verifique se existe exatamente esse bot no grupo: @${botUsername}\n` +
    '• Envie /settings no grupo e pressione "Abrir em chat privado"';
}
