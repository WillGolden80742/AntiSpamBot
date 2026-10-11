// Whitelist compartilhada (Antispam AI + Censurar): links e assuntos permitidos furam a IA.
// Checagem determinística ANTES da IA (economiza call) + vai no prompt como exceção.
// settings.whitelist = { links: ['dominio.com'], assuntos: ['aviso da moderação'] }
import { db } from '../../config/database.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { logEvent } from '../models/group.js';

export function getWhitelist(gid) {
  try {
    const row = db.prepare('SELECT data FROM settings WHERE group_id = ? AND module = ?').get(String(gid), 'whitelist');
    const d = row ? JSON.parse(row.data) : {};
    return {
      links: Array.isArray(d.links) ? d.links.filter((s) => typeof s === 'string' && s.trim()).slice(0, 200) : [],
      assuntos: Array.isArray(d.assuntos) ? d.assuntos.filter((s) => typeof s === 'string' && s.trim()).slice(0, 200) : [],
    };
  } catch {
    return { links: [], assuntos: [] };
  }
}

export function saveWhitelist(gid, wl) {
  const data = JSON.stringify({
    links: [...new Set((wl.links || []).map((s) => String(s).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 120)).filter(Boolean))].slice(0, 200),
    assuntos: [...new Set((wl.assuntos || []).map((s) => String(s).trim().slice(0, 120)).filter(Boolean))].slice(0, 200),
  });
  db.prepare(`INSERT INTO settings (group_id, module, data, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(group_id, module) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(String(gid), 'whitelist', data, new Date().toISOString());
  logEvent('whitelist_change', gid, null, {});
}

function extrairDominios(texto) {
  const t = String(texto || '').toLowerCase();
  const out = new Set();
  const re = /(?:https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/gi;
  let m;
  while ((m = re.exec(t))) {
    out.add(m[0].replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  }
  return [...out];
}

// Retorna { permitido:bool, motivo:'' } — link OU assunto permitido libera.
export function ehPermitido(texto, wl) {
  const t = String(texto || '');
  const doms = extrairDominios(t);
  for (const d of doms) {
    if ((wl.links || []).some((l) => d === l || d.endsWith(`.${l}`))) {
      return { permitido: true, motivo: `link permitido: ${d}` };
    }
  }
  const low = t.toLowerCase();
  for (const a of (wl.assuntos || [])) {
    if (a && low.includes(String(a).toLowerCase())) {
      return { permitido: true, motivo: `assunto permitido: ${a}` };
    }
  }
  return { permitido: false, motivo: '' };
}

export function trechoPrompt(wl) {
  const partes = [];
  if (wl.links?.length) partes.push(`Links/dominios SEMPRE permitidos (nunca sinalize por conter): ${wl.links.join(', ')}`);
  if (wl.assuntos?.length) partes.push(`Assuntos SEMPRE permitidos (nunca sinalize): ${wl.assuntos.join(' | ')}`);
  return partes.join('\n');
}

// ---- painel (Telegram) ----
export function painelWhitelist(gid) {
  const wl = getWhitelist(gid);
  const links = wl.links.length ? wl.links.map((l, i) => `${i + 1}. ${l}`).join('\n') : '(nenhum)';
  const assuntos = wl.assuntos.length ? wl.assuntos.map((a, i) => `${i + 1}. ${a}`).join('\n') : '(nenhum)';
  const head =
    `✅ <b>Whitelist</b> — links e assuntos que o Antispam sempre perdoa.\n\n` +
    `🔗 <b>Links permitidos (${wl.links.length})</b>\n${links}\n\n` +
    `💬 <b>Assuntos permitidos (${wl.assuntos.length})</b>\n${assuntos}\n\n` +
    `Toque em ❌ para remover um item, ou adicione novos abaixo.`;
  const rows = [];
  wl.links.slice(0, 10).forEach((l, i) => rows.push([{ text: `❌ link: ${l}`, callback_data: `wl_rm_link:${gid}:${i}` }]));
  wl.assuntos.slice(0, 10).forEach((a, i) => rows.push([{ text: `❌ assunto: ${String(a).slice(0, 24)}`, callback_data: `wl_rm_assunto:${gid}:${i}` }]));
  rows.push([{ text: '➕ Adicionar link', callback_data: `wl_add_link:${gid}` },
             { text: '➕ Adicionar assunto', callback_data: `wl_add_assunto:${gid}` }]);
  rows.push([{ text: '⬅️ Voltar p/ Antispam', callback_data: `ai:${gid}` }]);
  return { text: head, reply_markup: { inline_keyboard: rows } };
}

export function removerWlItem(gid, tipo, idx) {
  const wl = getWhitelist(gid);
  const i = Number(idx);
  if (tipo === 'link' && wl.links[i]) wl.links.splice(i, 1);
  if (tipo === 'assunto' && wl.assuntos[i]) wl.assuntos.splice(i, 1);
  saveWhitelist(gid, wl);
  logEvent('whitelist_change', gid, null, { removeu: tipo });
}

export { DEFAULT_SETTINGS };
