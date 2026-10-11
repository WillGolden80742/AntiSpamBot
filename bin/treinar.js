#!/usr/bin/env node
// bin/treinar — treina o motor clássico (0 LLM) com TREINO e TESTE separados:
//   treino:  db/corpus/spam.json       + db/corpus/nao_spam.json
//   teste:   db/corpus/spam_teste.json + db/corpus/nao_spam_teste.json
// Passos: 1) fasttext supervised (só no treino) 2) quantiza (.ftz)
//         3) avalia P@1/R@1 no teste  4) falsos positivos no ham de teste
//         5) recall REAL do bot (fusão regras+modelo) no teste
//         6) Bayes de reserva  7) stats → db/fasttext/stats.json
// Uso: node bin/treinar.js  (ou /retreinar no Telegram)
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analisarSinais } from '../app/helpers/sinais.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = join(root, 'db', 'corpus');
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);
const ler = (f) => JSON.parse(readFileSync(join(corpus, f), 'utf-8'));
const texto = (x) => norm(x.conteudo);

// ---- carrega treino e teste (arquivos separados) ----
let trainSpam, trainHam, testSpam, testHam;
try {
  trainSpam = ler('spam.json'); trainHam = ler('nao_spam.json');
} catch (e) { console.error('Falta corpus de treino (spam.json / nao_spam.json):', e.message); process.exit(1); }
try {
  testSpam = ler('spam_teste.json'); testHam = ler('nao_spam_teste.json');
} catch {
  // fallback: sem arquivos de teste, faz holdout 20% do treino
  testSpam = trainSpam.filter((_, i) => i % 5 === 4);
  testHam = trainHam.filter((_, i) => i % 5 === 4);
  trainSpam = trainSpam.filter((_, i) => i % 5 !== 4);
  trainHam = trainHam.filter((_, i) => i % 5 !== 4);
  console.log('(sem *_teste.json — usando holdout 20%)');
}
const linha = (label, t) => `${label} ${t}\n`;
const trainTxt = [...trainSpam.map((x) => linha('__label__spam', texto(x))), ...trainHam.map((x) => linha('__label__ham', texto(x)))].join('');
writeFileSync('/tmp/ft_train.txt', trainTxt);
writeFileSync('/tmp/ft_test.txt', [...testSpam.map((x) => linha('__label__spam', texto(x))), ...testHam.map((x) => linha('__label__ham', texto(x)))].join(''));
writeFileSync('/tmp/ft_test_spam.txt', testSpam.map((x) => texto(x)).join('\n') + '\n');
writeFileSync('/tmp/ft_test_ham.txt', testHam.map((x) => texto(x)).join('\n') + '\n');
console.log(`Treino: ${trainSpam.length + trainHam.length} (spam ${trainSpam.length} / ham ${trainHam.length}) | Teste: ${testSpam.length + testHam.length} (spam ${testSpam.length} / ham ${testHam.length})`);

// ---- treina fasttext (só no treino) e quantiza ----
mkdirSync(join(root, 'db', 'fasttext'), { recursive: true });
const bin = join(root, 'db', 'fasttext', 'spam.bin');
const ftz = join(root, 'db', 'fasttext', 'spam.ftz');
execFileSync('fasttext', ['supervised', '-input', '/tmp/ft_train.txt', '-output', join(root, 'db', 'fasttext', 'spam'),
  '-dim', '100', '-epoch', '100', '-wordNgrams', '2', '-minCount', '1', '-lr', '0.7', '-minn', '3', '-maxn', '6'], { stdio: 'inherit' });
execFileSync('fasttext', ['quantize', '-output', join(root, 'db', 'fasttext', 'spam'), '-input', bin], { stdio: 'inherit' });

// ---- avaliação fasttext no TESTE ----
const out = execFileSync('fasttext', ['test', ftz, '/tmp/ft_test.txt'], { encoding: 'utf-8' });
console.log('fasttext test (.ftz):', out.trim());

// ---- probabilidades do modelo no teste ----
const probSpam = (arquivo) => execFileSync('fasttext', ['predict-prob', ftz, arquivo, '1'], { encoding: 'utf-8' })
  .trim().split('\n').map((l) => { const m = l.match(/__label__(\w+)\s+([\d.]+)/); if (!m) return 0; const p = Number(m[2]); return m[1] === 'spam' ? p : 1 - p; });
const spP = probSpam('/tmp/ft_test_spam.txt');
const hmP = probSpam('/tmp/ft_test_ham.txt');

// ---- recall REAL do bot (fusão regras + modelo) — mesma lógica do semantico.js ----
const TOL = 65;
function nivelFusao(t, pct) {
  const s = analisarSinais(t, 3, 6);
  if (s.nivel === 'severo' || s.nivel === 'medio') return pct < 15 ? 'baixo' : s.nivel; // modelo veta FP do regex
  if (s.score >= 1) return pct > TOL ? 'medio' : 'baixo';
  if (pct > 90) return 'medio';
  if (pct >= 50) return 'baixo';
  return null;
}
let pega = 0, pune = 0, fpPune = 0, fpLog = 0, escapou = [];
testSpam.forEach((x, i) => { const n = nivelFusao(texto(x), Math.round(spP[i] * 100)); if (n) pega++; if (n === 'medio' || n === 'severo') pune++; else if (!n) escapou.push(x.conteudo.slice(0, 70)); });
testHam.forEach((x, i) => { const n = nivelFusao(texto(x), Math.round(hmP[i] * 100)); if (n === 'medio' || n === 'severo') fpPune++; else if (n) fpLog++; });
const pctPega = testSpam.length ? Math.round((pega / testSpam.length) * 1000) / 10 : 0;
console.log(`FUSÃO no teste → SPAM pego: ${pega}/${testSpam.length} (${pctPega}%) | punido: ${pune} | escapou: ${escapou.length}`);
console.log(`FUSÃO no teste → HAM punido (FP): ${fpPune}/${testHam.length} | só log 🟡: ${fpLog}`);
escapou.slice(0, 8).forEach((e) => console.log('   escapoU:', e));

// ---- Bayes puro-JS (reserva) — treina no TREINO, avalia no TESTE ----
const tok = (s) => norm(s).split(/[^a-zà-ú0-9]+/u).filter((w) => w.length > 1);
const m = { ns: 0, nh: 0, ts: {}, th: {}, vocab: 0 };
const conta = (t, spamQ) => { if (spamQ) m.ns++; else m.nh++; for (const w of new Set(tok(t))) { if (spamQ) m.ts[w] = (m.ts[w] || 0) + 1; else m.th[w] = (m.th[w] || 0) + 1; } };
trainSpam.forEach((x) => conta(texto(x), true));
trainHam.forEach((x) => conta(texto(x), false));
m.vocab = new Set([...Object.keys(m.ts), ...Object.keys(m.th)]).size;
writeFileSync(join(root, 'db', 'bayes.json'), JSON.stringify(m));
const bayesProb = (t) => { let ls = Math.log(m.ns / (m.ns + m.nh)), lh = Math.log(m.nh / (m.ns + m.nh)); for (const w of new Set(tok(t))) { ls += Math.log(((m.ts[w] || 0) + 1) / (m.ns + m.vocab)); lh += Math.log(((m.th[w] || 0) + 1) / (m.nh + m.vocab)); } return 1 / (1 + Math.exp(lh - ls)); };
let okB = 0, fpB = 0;
[...testSpam.map((x) => [texto(x), true]), ...testHam.map((x) => [texto(x), false])].forEach(([t, isSpam]) => { const diz = bayesProb(t) >= 0.5; if (diz === isSpam) okB++; if (!isSpam && diz) fpB++; });
console.log(`Bayes teste: ${okB}/${testSpam.length + testHam.length} | FP ham: ${fpB}`);

// ---- stats ----
const stats = {
  em: new Date().toISOString(),
  treino: { spam: trainSpam.length, ham: trainHam.length, total: trainSpam.length + trainHam.length },
  teste: { spam: testSpam.length, ham: testHam.length, total: testSpam.length + testHam.length },
  fasttextTest: out.trim(),
  fusao: { spamPego: pega, spamTotal: testSpam.length, pct: pctPega, escapou: escapou.length, hamPunido: fpPune, hamLog: fpLog },
  bayes: { acerto: okB, total: testSpam.length + testHam.length, fpHam: fpB },
  nSpam: trainSpam.length, nHam: trainHam.length, fpHam: fpPune,
};
writeFileSync(join(root, 'db', 'fasttext', 'stats.json'), JSON.stringify(stats, null, 2));
console.log('STATS:', JSON.stringify(stats));
try { if (existsSync(ftz)) { unlinkSync(bin); console.log('binário .bin removido (bot usa .ftz)'); } } catch {}
