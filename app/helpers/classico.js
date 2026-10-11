// Motor clássico local (0 LLM, 0 rede): fastText binário primeiro, Bayes puro-JS de reserva.
// Treino: node bin/treinar.js (gera db/fasttext/spam.bin + db/bayes.json).
// Conservador: Bayes só condena com prob >= 0.9 (zero FP no holdout).
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// .ftz (quantizado, leve) primeiro; .bin (cheio) como reserva
const FTZ = join(root, 'db', 'fasttext', 'spam.ftz');
const BIN = join(root, 'db', 'fasttext', 'spam.bin');
const BAYES_PATH = join(root, 'db', 'bayes.json');
const STATS_PATH = join(root, 'db', 'fasttext', 'stats.json');
const PROB_BAYES_MIN = 0.9;

let bayes = null;
let nq = 0;

export function reload() { bayes = null; }
function modeloPath() {
  try { if (existsSync(FTZ)) return FTZ; } catch {}
  return BIN;
}
export function temModelo() { try { return existsSync(FTZ) || existsSync(BIN); } catch { return false; } }
export function statsModelo() {
  try { return JSON.parse(readFileSync(STATS_PATH, 'utf-8')); } catch { return null; }
}

function carregarBayes() {
  if (bayes) return bayes;
  try { bayes = JSON.parse(readFileSync(BAYES_PATH, 'utf-8')); } catch { bayes = null; }
  return bayes;
}

const tok = (s) => String(s || '').toLowerCase().split(/[^a-zà-ú0-9]+/u).filter((w) => w.length > 1);

function probBayes(texto) {
  const m = carregarBayes();
  if (!m) return 0;
  let ls = Math.log(m.ns / (m.ns + m.nh)), lh = Math.log(m.nh / (m.ns + m.nh));
  for (const w of new Set(tok(texto))) {
    ls += Math.log(((m.ts[w] || 0) + 1) / (m.ns + m.vocab));
    lh += Math.log(((m.th[w] || 0) + 1) / (m.nh + m.vocab));
  }
  return 1 / (1 + Math.exp(lh - ls));
}

function probFasttext(texto) {
  const tmp = `/tmp/ftq-${process.pid}-${(++nq)}.txt`;
  try {
    writeFileSync(tmp, String(texto || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500) + '\n');
    const out = execFileSync('fasttext', ['predict-prob', modeloPath(), tmp, '1'], { encoding: 'utf-8', timeout: 8000 }).trim();
    const m = out.match(/__label__(\w+)\s+([\d.]+)/);
    if (!m) return null;
    // predict-prob devolve a prob. do RÓTULO previsto: converte p/ P(spam)
    const pRotulo = Number(m[2]);
    const pSpam = m[1] === 'spam' ? pRotulo : 1 - pRotulo;
    return { spam: pSpam >= 0.5, prob: pSpam };
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// Retorna { origem:'fasttext'|'bayes'|'off', prob, spam }
export function classificar(texto) {
  if (temModelo()) {
    const f = probFasttext(texto);
    if (f) return { origem: 'fasttext', prob: f.prob, spam: f.spam };
  }
  if (carregarBayes()) {
    const p = probBayes(texto);
    return { origem: 'bayes', prob: p, spam: p >= PROB_BAYES_MIN };
  }
  return { origem: 'off', prob: 0, spam: false };
}
