#!/usr/bin/env node
// bin/treinar — treina o motor clássico (0 LLM) a partir de db/corpus/spam.json + nao_spam.json.
//   1) holdout estratificado 20% (120 msgs) 2) fasttext supervised → db/fasttext/spam.bin
//   3) avalia: precisão geral + falsos positivos no ham (meta: 0)
//   4) treina Bayes puro-JS (fallback) → db/bayes.json 5) stats → db/fasttext/stats.json
// Uso: node bin/treinar.js  (ou /retreinar no Telegram)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);

const spam = JSON.parse(readFileSync(join(root, 'db', 'corpus', 'spam.json'), 'utf-8'));
const ham = JSON.parse(readFileSync(join(root, 'db', 'corpus', 'nao_spam.json'), 'utf-8'));
const L = (x) => norm(x.conteudo);
const train = [], test = [];
spam.forEach((x, i) => ((i % 5 === 4 ? test : train).push({ label: '__label__spam', text: L(x) })));
ham.forEach((x, i) => ((i % 5 === 4 ? test : train).push({ label: '__label__ham', text: L(x) })));
const linha = (r) => `${r.label} ${r.text}\n`;
writeFileSync('/tmp/ft_train.txt', train.map(linha).join(''));
writeFileSync('/tmp/ft_test.txt', test.map(linha).join(''));
console.log(`Treino: ${train.length} | Teste: ${test.length} (spam-teste: ${test.filter((t) => t.label === '__label__spam').length})`);

mkdirSync(join(root, 'db', 'fasttext'), { recursive: true });
execFileSync('fasttext', ['supervised', '-input', '/tmp/ft_train.txt', '-output', join(root, 'db', 'fasttext', 'spam'),
  '-dim', '64', '-epoch', '30', '-wordNgrams', '2', '-minCount', '1', '-lr', '0.5',
  '-minn', '3', '-maxn', '6'], { stdio: 'inherit' });

// quantiza: .ftz leve (MB) com a mesma precisão — é o que o bot usa p/ prever
const bin = join(root, 'db', 'fasttext', 'spam.bin');
execFileSync('fasttext', ['quantize', '-output', join(root, 'db', 'fasttext', 'spam'), '-input', bin], { stdio: 'inherit' });
const ftz = join(root, 'db', 'fasttext', 'spam.ftz');

// avaliação geral (no .ftz, igual ao bot)
const out = execFileSync('fasttext', ['test', ftz, '/tmp/ft_test.txt'], { encoding: 'utf-8' });
console.log('fasttext test (.ftz):', out.trim());

// falsos positivos no ham (o que NUNCA pode acontecer: ham legítimo punido)
writeFileSync('/tmp/ft_test_ham.txt', test.filter((t) => t.label === '__label__ham').map((t) => t.text + '\n').join(''));
const predHam2 = execFileSync('fasttext', ['predict-prob', ftz, '/tmp/ft_test_ham.txt', '1'], { encoding: 'utf-8' });
const fp = predHam2.trim().split('\n').filter((l) => l.startsWith('__label__spam')).length;
const nHam = test.filter((t) => t.label === '__label__ham').length;
console.log(`Falsos positivos no ham: ${fp}/${nHam}`);

// ---- Bayes puro-JS (fallback, sem dependências) ----
const tok = (s) => norm(s).split(/[^a-zà-ú0-9]+/u).filter((w) => w.length > 1);
const m = { ns: 0, nh: 0, ts: {}, th: {}, vocab: 0 };
const conta = (texto, spamQ) => {
  if (spamQ) m.ns++; else m.nh++;
  for (const w of new Set(tok(texto))) {
    if (spamQ) m.ts[w] = (m.ts[w] || 0) + 1; else m.th[w] = (m.th[w] || 0) + 1;
  }
};
train.forEach((r) => conta(r.text, r.label === '__label__spam'));
m.vocab = new Set([...Object.keys(m.ts), ...Object.keys(m.th)]).size;
writeFileSync(join(root, 'db', 'bayes.json'), JSON.stringify(m));
// acurácia do Bayes no holdout
const bayesProb = (texto) => {
  let ls = Math.log(m.ns / (m.ns + m.nh)), lh = Math.log(m.nh / (m.ns + m.nh));
  for (const w of new Set(tok(texto))) {
    ls += Math.log((((m.ts[w] || 0) + 1) / (m.ns + m.vocab)));
    lh += Math.log((((m.th[w] || 0) + 1) / (m.nh + m.vocab)));
  }
  return 1 / (1 + Math.exp(lh - ls));
};
let okB = 0, fpB = 0;
test.forEach((t) => {
  const p = bayesProb(t.text);
  const dizSpam = p >= 0.5;
  if ((t.label === '__label__spam') === dizSpam) okB++;
  if (t.label === '__label__ham' && dizSpam) fpB++;
});
console.log(`Bayes holdout: ${okB}/${test.length} | FP ham: ${fpB}`);

const stats = { em: new Date().toISOString(), nSpam: spam.length, nHam: ham.length, treino: train.length, teste: test.length, fpHam: fp, bayesAcc: `${okB}/${test.length}`, bayesFp: fpB, fasttextTest: out.trim() };
writeFileSync(join(root, 'db', 'fasttext', 'stats.json'), JSON.stringify(stats, null, 2));
console.log('STATS:', JSON.stringify(stats));
// o bot usa o .ftz: remove o .bin gigante (512MB) p/ poupar disco da VPS
try {
  const { unlinkSync, existsSync } = await import('node:fs');
  if (existsSync(ftz)) { unlinkSync(bin); console.log('binário .bin removido (bot usa .ftz)'); }
} catch {}
