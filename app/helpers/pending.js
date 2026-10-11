// Mapa simples de edições de texto pendentes (painel privado → próxima msg).
// chave `${chatId}:${userId}` → { gid, tipo, em }
const pendentes = new Map();

export function setPendente(chatId, userId, item) {
  pendentes.set(`${chatId}:${userId}`, { ...item, em: Date.now() });
}
export function getPendente(chatId, userId) {
  const p = pendentes.get(`${chatId}:${userId}`);
  if (!p) return null;
  if (Date.now() - p.em > 5 * 60 * 1000) { pendentes.delete(`${chatId}:${userId}`); return null; }
  return p;
}
export function clearPendente(chatId, userId) {
  pendentes.delete(`${chatId}:${userId}`);
}
