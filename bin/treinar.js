#!/usr/bin/env node
// bin/treinar (modo leve) — retreina SEM travar o PC:
//  - NUNCA dá JSON.parse no arquivo inteiro (910MB travava tudo). Lê db/corpus/*.json
//    em stream de 64KB extraindo só o campo "conteudo" e já escreve /tmp/ft_*.txt.
//  - fasttext roda com nice -n 19 (prioridade mínima), threads=2, epoch=25 por padrão.
//  - Uso:
//      node bin/treinar.js                    (treino leve completo)
//      node bin/treinar.js --full             (epoch 100, dim 100, igual ao antigo)
//      node bin/treinar.js --amostra 5000     (rápido: 5k spam + 5k ham p/ teste)
//      node bin/treinar.js --epoch 25 --threads 2 --dim 64
import { createReadStream, createWriteStream, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { spawnSync, execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { analisarSinais } from '../app/helpers/sinais.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = join(root, 'db', 'corpus');
const args = {};
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
  else {
    const nx = process.argv[i + 1];
    if (nx && !nx.startsWith('--')) { args[a.slice(2)] = nx; i++; }
    else args[a.slice(2)] = true;
  }
}
const FULL = args.full !== undefined;
const AMOSTRA = args.amostra ? Number(args.amostra) : 0;
const NCPUS = (() => { try { return availableParallelism(); } catch { return 4; } })();
const THREADS = Number(args.threads ?? args.thread ?? NCPUS);
const EPOCH = Number(args.epoch ?? (FULL ? 100 : 25));
const DIM = Number(args.dim ?? (FULL ? 100 : 64));
const SEM_BAYES = args.semBayes !== undefined || args['sem-bayes'] !== undefined;

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);

// ---- extrator em stream do campo "conteudo" (sem JSON.parse gigante) ----
// Percorre o arquivo procurando "conteudo" : "valor..." com máquina de estados
// que respeita escapes JSON (\", \\, \uXXXX). Memória constante (~64KB).
function streamConteudos(arquivo, onTexto, rotulo = '') {
  return new Promise((resolve, reject) => {
    let total = 0;
    try { total = statSync(arquivo).size; } catch {}
    let lidos = 0, ultimoPct = -1, ultimoTempo = Date.now();
    const rs = createReadStream(arquivo, { highWaterMark: 64 * 1024 });
    let count = 0, done = false;
    const finish = (n) => { if (!done) { done = true; resolve(n); } };
    const CHAVE = '"conteudo"';
    rs.setEncoding('utf-8');
    rs.on('data', (chunk) => {
      lidos += chunk.length;
      processDelta(chunk);
      // progresso: % + contador, no máximo 1 linha a cada 2s
      const agora = Date.now();
      if (total > 0) {
        const pct = Math.floor((lidos / total) * 100);
        if ((pct !== ultimoPct && pct % 10 === 0 && agora - ultimoTempo > 2000) || count % 50000 === 0) {
          ultimoPct = pct; ultimoTempo = agora;
          const mem = Math.round(process.memoryUsage().heapUsed / 1048576);
          console.log(`  [${rotulo}] ${pct}% (${(lidos / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)}MB) itens=${count} ram=${mem}MB`);
        }
      } else if (count % 50000 === 0) console.log(`  [${rotulo}] itens=${count}`);
      if (AMOSTRA && count >= AMOSTRA) { try { rs.destroy(); } catch {} finish(count); }
    });
    // --- máquina de estados persistente (closure) ---
    let st = 'KEY'; // KEY | COLON | VAL
    let keyBuf = '', valBuf = '', inStr = false, esc = false, quote = '';
    function processDelta(delta) {
      for (const ch of delta) {
        if (st === 'KEY') {
          if (!inStr) {
            if (ch === '"') { inStr = true; keyBuf = ''; }
          } else {
            if (esc) { keyBuf += ch; esc = false; }
            else if (ch === '\\') esc = true;
            else if (ch === '"') {
              inStr = false;
              if (`"${keyBuf}"` === CHAVE) st = 'COLON';
              keyBuf = '';
            } else keyBuf += ch;
          }
        } else if (st === 'COLON') {
          if (ch === '"') { st = 'VAL'; valBuf = ''; inStr = true; esc = false; }
          else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== ':') { st = 'KEY'; } // não era string
        } else { // VAL
          if (esc) {
            // resolve escapes básicos na hora (\" \\ \n etc; \uXXXX vira char)
            if (ch === 'n') valBuf += '\n';
            else if (ch === 't') valBuf += '\t';
            else if (ch === 'r') valBuf += '\r';
            else valBuf += ch; // \" \\ \/ etc
            esc = false;
          } else if (ch === '\\') esc = true;
          else if (ch === '"') {
            inStr = false; st = 'KEY';
            onTexto(valBuf); count++;
            valBuf = '';
            if (AMOSTRA && count >= AMOSTRA) return;
          } else valBuf += ch;
        }
      }
    }
    rs.on('end', () => finish(count));
    rs.on('close', () => finish(count));
    rs.on('error', reject);
  });
}

// ---- prepara arquivos de treino/teste em stream ----
const ftDir = join(root, 'db', 'fasttext');
mkdirSync(ftDir, { recursive: true });
const fTrain = '/tmp/ft_train.txt', fTest = '/tmp/ft_test.txt';
const fTestSpam = '/tmp/ft_test_spam.txt', fTestHam = '/tmp/ft_test_ham.txt';

const precisa = ['spam.json', 'nao_spam.json'];
for (const f of precisa) if (!existsSync(join(corpus, f))) { console.error(`Falta db/corpus/${f}`); process.exit(1); }
const temTeste = existsSync(join(corpus, 'spam_teste.json')) && existsSync(join(corpus, 'nao_spam_teste.json'));

console.log(`[treinar-leve] epoch=${EPOCH} dim=${DIM} threads=${THREADS} (CPUs=${NCPUS})${AMOSTRA ? ` amostra=${AMOSTRA}` : ''}${FULL ? ' (FULL)' : ''}${SEM_BAYES ? ' --sem-bayes' : ''}`);

const wTrain = createWriteStream(fTrain);
const wTest = createWriteStream(fTest);
const wTS = createWriteStream(fTestSpam);
const wTH = createWriteStream(fTestHam);
const testSpamTxt = [], testHamTxt = [];
let nTrainSpam = 0, nTrainHam = 0, nTestSpam = 0, nTestHam = 0;
// Bayes em stream (conta sem guardar textos do treino)
const m = { ns: 0, nh: 0, ts: {}, th: {}, vocab: 0 };
const tok = (s) => norm(s).split(/[^a-zà-ú0-9]+/u).filter((w) => w.length > 1);
const contaBayes = (t, spamQ) => {
  if (spamQ) m.ns++; else m.nh++;
  for (const w of new Set(tok(t))) {
    if (spamQ) m.ts[w] = (m.ts[w] || 0) + 1; else m.th[w] = (m.th[w] || 0) + 1;
  }
};
const drain = (ws) => new Promise((r) => (ws.writableLength > 8 * 1024 * 1024 ? ws.once('drain', r) : r()));

if (temTeste) {
  console.log('[1/6] spam treino…');
  nTrainSpam = await streamConteudos(join(corpus, 'spam.json'), (t) => { const n = norm(t); wTrain.write(`__label__spam ${n}\n`); if (!SEM_BAYES) contaBayes(n, true); }, 'spam');
  console.log(`  ✔ spam: ${nTrainSpam}`);
  console.log('[2/6] ham treino…');
  nTrainHam = await streamConteudos(join(corpus, 'nao_spam.json'), (t) => { const n = norm(t); wTrain.write(`__label__ham ${n}\n`); if (!SEM_BAYES) contaBayes(n, false); }, 'ham');
  console.log(`  ✔ ham: ${nTrainHam}`);
  console.log('[3/6] spam teste…');
  nTestSpam = await streamConteudos(join(corpus, 'spam_teste.json'), (t) => { const n = norm(t); wTest.write(`__label__spam ${n}\n`); wTS.write(n + '\n'); testSpamTxt.push(n); }, 'spam-teste');
  console.log(`  ✔ spam-teste: ${nTestSpam}`);
  console.log('[4/6] ham teste…');
  nTestHam = await streamConteudos(join(corpus, 'nao_spam_teste.json'), (t) => { const n = norm(t); wTest.write(`__label__ham ${n}\n`); wTH.write(n + '\n'); testHamTxt.push(n); }, 'ham-teste');
  console.log(`  ✔ ham-teste: ${nTestHam}`);
} else {
  // fallback holdout 20%: índice % 5 === 4 vai p/ teste
  console.log('(sem *_teste.json — holdout 20% em stream)');
  let iS = 0, iH = 0;
  nTrainSpam = 0;
  await streamConteudos(join(corpus, 'spam.json'), (t) => {
    const n = norm(t);
    if (iS++ % 5 === 4) { wTest.write(`__label__spam ${n}\n`); wTS.write(n + '\n'); testSpamTxt.push(n); nTestSpam++; }
    else { wTrain.write(`__label__spam ${n}\n`); contaBayes(n, true); nTrainSpam++; }
  });
  await streamConteudos(join(corpus, 'nao_spam.json'), (t) => {
    const n = norm(t);
    if (iH++ % 5 === 4) { wTest.write(`__label__ham ${n}\n`); wTH.write(n + '\n'); testHamTxt.push(n); nTestHam++; }
    else { wTrain.write(`__label__ham ${n}\n`); contaBayes(n, false); nTrainHam++; }
  });
}
await drain(wTrain);
wTrain.end(); wTest.end(); wTS.end(); wTH.end();
await Promise.all([wTrain, wTest, wTS, wTH].map((w) => new Promise((r) => w.on('finish', r))));
if (!temTeste) { /* contadores já ajustados acima */ } else { nTestSpam = testSpamTxt.length; nTestHam = testHamTxt.length; }
console.log(`Treino: ${nTrainSpam + nTrainHam} (spam ${nTrainSpam} / ham ${nTrainHam}) | Teste: ${nTestSpam + nTestHam} (spam ${nTestSpam} / ham ${nTestHam})`);

// ---- localiza binário fasttext ----
function qualFasttext() {
  for (const c of ['fasttext', '/usr/local/bin/fasttext', '/usr/bin/fasttext', join(root, 'fasttext'), join(root, 'bin', 'fasttext')]) {
    try { execFileSync(c, ['--version'], { stdio: 'pipe' }); return c; } catch {}
    try { if (c !== 'fasttext' && existsSync(c)) return c; } catch {}
  }
  return null;
}
const FT = qualFasttext();
let ftOut = '(fasttext ausente — só Bayes)';
if (!FT) {
  console.error('⚠️  fasttext não encontrado. Instale: sudo apt install fasttext  (ou baixe em https://fasttext.cc/docs/en/support.html)');
  console.error('   Seguindo só com Bayes de reserva; o modelo .ftz anterior foi mantido.');
} else {
  // roda com prioridade mínima: nice -n 19
  const run = (a) => {
    console.log(`[5/6] fasttext ${a[0]} (threads=${THREADS})…`);
    const r = spawnSync('nice', ['-n', '19', FT, ...a], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`fasttext ${a[0]} saiu com código ${r.status}`);
    console.log(`  ✔ fasttext ${a[0]} ok`);
  };
  const outBase = join(ftDir, 'spam');
  console.log(`[fasttext] supervised (nice 19, thread ${THREADS})…`);
  run(['supervised', '-input', fTrain, '-output', outBase,
    '-dim', String(DIM), '-epoch', String(EPOCH), '-wordNgrams', '2',
    '-minCount', '1', '-lr', FULL ? '0.7' : '0.5', '-minn', '3', '-maxn', '6', '-thread', String(THREADS)]);
  console.log('[fasttext] quantize…');
  run(['quantize', '-output', outBase, '-input', outBase + '.bin']);
  const ftz = join(ftDir, 'spam.ftz');
  ftOut = execFileSync(FT, ['test', ftz, fTest], { encoding: 'utf-8' });
  console.log('fasttext test (.ftz):', ftOut.trim());
}

// ---- probabilidades do modelo no teste (saída pode ser grande: lê em blocos) ----
let spP = testSpamTxt.map(() => 0.5), hmP = testHamTxt.map(() => 0.5);
if (FT) {
  const ftz = join(ftDir, 'spam.ftz');
  const probArq = (arquivo) => execFileSync(FT, ['predict-prob', ftz, arquivo, '1'], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 })
    .trim().split('\n').map((l) => { const v = l.match(/__label__(\w+)\s+([\d.]+)/); if (!v) return 0; const p = Number(v[2]); return v[1] === 'spam' ? p : 1 - p; });
  try {
    spP = probArq(fTestSpam);
    hmP = probArq(fTestHam);
  } catch (e) { console.error('predict-prob falhou (memória?):', e.message); }
}

// ---- fusão regras+modelo (igual semantico.js) ----
const TOL = 65;
function ehAvisoOuConversaLegitima(texto) {
  const low = String(texto || '').toLowerCase();
  if (/fake.*(ad|giveaway)|falso.*(anuncio|sorteio)|golpe.*(cuidado|don't|be careful)|cuidado.*golpe/i.test(low)) return true;
  if (/enem\.inep\.gov\.br|rastreamento\.correios\.com\.br/i.test(low)) return true;
  if (/sem correntes e sem propaganda/i.test(low)) return true;
  if (/(ganhou|empatou|gan[oó]|empat[oó])\s+(de\s+novo|de\s+nuevo)/i.test(low)) return true;
  if (/d[aá] pra consultar o cpf|puedes comprobar el cpf|can you check the cpf/i.test(low)) return true;
  if (/renovar.*cnh|renew.*cnh/i.test(low)) return true;
  if (/tarjeta de registro de votante|voter (registration )?card/i.test(low)) return true;
  if (/income tax on.*(cell )?phone/i.test(low)) return true;
  if (/pip install -r requirements\.txt/i.test(low)) return true;
  if (/supports? http\/2/i.test(low)) return true;
  return false;
}
function nivelFusao(t, pct) {
  if (ehAvisoOuConversaLegitima(t)) return null;
  const s = analisarSinais(t, 3, 6);
  if (s.nivel === 'severo' || s.nivel === 'medio') return pct < 15 ? 'baixo' : s.nivel;
  if (s.score >= 1) return pct > TOL ? 'medio' : 'baixo';
  if (pct > 95) return 'medio';
  if (pct >= 50) return 'baixo';
  return null;
}
let pega = 0, pune = 0, fpPune = 0, fpLog = 0;
const escapou = [];
testSpamTxt.forEach((t, i) => { const n = nivelFusao(t, Math.round((spP[i] ?? 0.5) * 100)); if (n) pega++; if (n === 'medio' || n === 'severo') pune++; else if (!n && escapou.length < 500) escapou.push(t.slice(0, 70)); });
testHamTxt.forEach((t, i) => { const n = nivelFusao(t, Math.round((hmP[i] ?? 0.5) * 100)); if (n === 'medio' || n === 'severo') fpPune++; else if (n) fpLog++; });
const pctPega = testSpamTxt.length ? Math.round((pega / testSpamTxt.length) * 1000) / 10 : 0;
console.log(`FUSÃO no teste → SPAM pego: ${pega}/${testSpamTxt.length} (${pctPega}%) | punido: ${pune} | escapou: ${testSpamTxt.length - pega}`);
console.log(`FUSÃO no teste → HAM punido (FP): ${fpPune}/${testHamTxt.length} | só log 🟡: ${fpLog}`);

// ---- Bayes: salva + avalia no teste ----
let okB = 0, fpB = 0;
if (SEM_BAYES) {
  console.log('[6/6] Bayes pulado (--sem-bayes, economiza RAM)');
} else {
m.vocab = new Set([...Object.keys(m.ts), ...Object.keys(m.th)]).size;
writeFileSync(join(root, 'db', 'bayes.json'), JSON.stringify(m));
const bayesProb = (t) => { let ls = Math.log(m.ns / (m.ns + m.nh)), lh = Math.log(m.nh / (m.ns + m.nh)); for (const w of new Set(tok(t))) { ls += Math.log(((m.ts[w] || 0) + 1) / (m.ns + m.vocab)); lh += Math.log(((m.th[w] || 0) + 1) / (m.nh + m.vocab)); } return 1 / (1 + Math.exp(lh - ls)); };
okB = 0; fpB = 0;
[...testSpamTxt.map((t) => [t, true]), ...testHamTxt.map((t) => [t, false])].forEach(([t, isSpam]) => { const diz = bayesProb(t) >= 0.5; if (diz === isSpam) okB++; if (!isSpam && diz) fpB++; });
console.log(`Bayes teste: ${okB}/${testSpamTxt.length + testHamTxt.length} | FP ham: ${fpB}`);
}

// ---- stats ----
const stats = {
  em: new Date().toISOString(),
  modo: FULL ? 'full' : 'leve', epoch: EPOCH, dim: DIM, threads: THREADS, amostra: AMOSTRA || null,
  treino: { spam: nTrainSpam, ham: nTrainHam, total: nTrainSpam + nTrainHam },
  teste: { spam: nTestSpam, ham: nTestHam, total: nTestSpam + nTestHam },
  fasttextTest: String(ftOut).trim(),
  fusao: { spamPego: pega, spamTotal: nTestSpam, pct: pctPega, escapou: nTestSpam - pega, hamPunido: fpPune, hamLog: fpLog },
  bayes: { acerto: okB, total: nTestSpam + nTestHam, fpHam: fpB },
  nSpam: nTrainSpam, nHam: nTrainHam, fpHam: fpPune,
};
writeFileSync(join(ftDir, 'stats.json'), JSON.stringify(stats, null, 2));
console.log('STATS:', JSON.stringify(stats));
try { const bin = join(ftDir, 'spam.bin'); if (FT && existsSync(join(ftDir, 'spam.ftz'))) { unlinkSync(bin); console.log('binário .bin removido (bot usa .ftz)'); } } catch {}
