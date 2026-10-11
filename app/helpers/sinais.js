// Sinais semânticos via regex com pesos → níveis baixo/médio/severo. 0 IA, 0 rede.
// Cada sinal carrega o MOTIVO em português (o "o que fez de errado" sem LLM).
// Anti-ofuscação: minúsculas, sem acento, leet (t1gr1nho→tigrinho), repetições colapsadas.
// Links: julgados por METADADOS (domínio/TLD/caminho) em linkmeta.js — ver analisarSinais.
import { extrairLinks as _extrairLinks, analisarLinks, URL_RE } from './linkmeta.js';
export const extrairLinks = _extrairLinks;
export function normalizar(s) {
  let t = String(s || '').toLowerCase();
  try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch {}
  // leet SEM @ e $: eles quebrariam os regex de menção (/@trader/) e dinheiro (/r\$/)
  // e SÓ troca dígito que está colado em letra (t1gr1nho→tigrinho), sem estragar
  // números soltos (R$500 continua R$500, não vira "r$soo").
  const leet = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '!': 'i', '|': 'i', '+': 't' };
  t = t.replace(/(?<=[a-z])[0134578]|[0134578](?=[a-z])/g, (c) => leet[c] || c);
  t = t.replace(/[!|+]/g, (c) => leet[c] || c);
  t = t.replace(/[\u200b-\u200f\ufeff]/g, '');
  t = t.replace(/(.)\1{3,}/g, '$1$1');
  return t;
}

// Domínios que NUNCA são golpe: se algum aparece, os sinais de phishing/golpe
// social (phish:true) são ignorados — ex.: "Receita Federal: https://www.gov.br/…".
const DOMINIOS_OK = [
  'gov.br', 'bcb.gov.br', 'ebc.com.br', 'wikipedia.org', 'github.com', 'stackoverflow.com',
  'python.org', 'mozilla.org', 'git-scm.com', 'nodejs.org', 'react.dev', 'code.visualstudio.com',
  'postgresql.org', 'docker.com', 'google.com', 'youtube.com', 'youtu.be', 'instagram.com',
  'facebook.com', 'spotify.com', 'netflix.com', 'imdb.com', 'maps.google.com',
  'g1.globo.com', 'bbc.com', 'folha.uol.com.br', 'dw.com', 'nexojornal.com.br',
  'elpais.com', 'ev.org.br', 'dominiopublico.gov.br',
];
function temDominioOk(norm) {
  return DOMINIOS_OK.some((d) => norm.includes(d));
}

// peso 4 = golpe certeiro | 2 = suspeito | 1 = fraco. limiares no config do grupo.
const SINAIS = [
  // ---- peso 4: casa de apostas ----
  { re: /tigrinho|fortune.?tiger|tigre da fortuna/, peso: 4, motivo: "casa de apostas: 'tigrinho'" },
  { re: /aviator|foguetinho|jetx|spaceman|crash/, peso: 4, motivo: "casa de apostas: jogo crash" },
  { re: /cassino|casino|\bbets?\b|bet[0-9]|betano|betfair|bet365|betnacional|bet\.?com|casa de aposta|aposta esportiva|mines/, peso: 4, motivo: 'casa de apostas' },
  // ---- peso 4: pirâmide / golpe de dinheiro ----
  { re: /renda extra|ganhar.*por dia|renda.*celular|trabalhe de casa/, peso: 4, motivo: 'pirâmide: renda fácil' },
  { re: /dobr[eo].*(dinheiro|bitcoin|investimento|capital)|retorno.*%.*dia|lucro garantido/, peso: 4, motivo: 'pirâmide: lucro garantido' },
  { re: /indique.*(amigos?|pessoas?).*(ganhe|saque|bonus)|traga.*amigos?|convide.*ganhe/, peso: 4, motivo: 'pirâmide: indique e ganhe' },
  { re: /earn \$?\d+.*(a day|daily|per day)|work from home|make money (online|fast|at home)|passive income|crypto giveaway/, peso: 4, motivo: 'pirâmide: renda fácil' },
  // ---- peso 4: phishing (só contam sem domínio confiável junto) ----
  { re: /conta.*bloquead|atualize.*(dados|cadastro)|confirme.*dados|conta.*suspens/, peso: 4, motivo: 'phishing: conta bloqueada', phish: true },
  { re: /receita federal|regularize.*cpf|correios.*taxa|encomenda.*retida|objeto.*retido/, peso: 4, motivo: 'phishing: taxa falsa', phish: true },
  { re: /beneficio.*(suspenso|bloqueado)|valores a receber|banco central/, peso: 4, motivo: 'phishing: benefício', phish: true },
  // ---- peso 4: golpe social / cripto (idem) ----
  { re: /emprestimo.*negativado|saque.*fgts|bolsa familia.*desbloque|auxilio.*liberado|consignado.*sem consulta/, peso: 4, motivo: 'golpe: benefício falso', phish: true },
  { re: /airdrop|staking.*%|carteira.*sincroniz|cripto.*lucro/, peso: 4, motivo: 'golpe: cripto', phish: true },
  // ---- peso 3-4: adulto / malware / vendas falsas ----
  { re: /vazad|onlyfans|pack.*18|conteudo adulto|fotos quentes|acompanhantes/, peso: 4, motivo: 'conteúdo adulto' },
  { re: /whatsapp gb|gbwhatsapp|quem visitou seu perfil|internet gratis.*(baixa|app|download)/, peso: 3, motivo: 'malware: app falso' },
  { re: /\.apk\b|baixe.*apk|apk.*liberado/, peso: 3, motivo: 'malware: APK' },
  { re: /cnh sem prova|seguidores baratos|conta.*vitalicia|diploma sem/, peso: 3, motivo: 'golpe: venda falsa' },
  // ---- peso 3: falso depoimento de lucro + perfil trader ----
  { re: /saquei|saque.*lucro|sacar.*lucro|lucro.*(saquei|sacar|retirada)/, peso: 3, motivo: 'golpe: falso lucro' },
  { re: /@\w*(trading|trader|forex|invest|sinais|bet|tigrinho|cassino)\w*|trading|forex/, peso: 2, motivo: 'golpe: trader' },
  // ---- peso 2: dinheiro / robô / divulgação ----
  { re: /r\$\s?\d|pix.*(saque|receb)|deposito minimo|saque.*(imediato|na hora)/, peso: 2, motivo: 'dinheiro fácil' },
  { re: /bonus.*(200|300|100)%|giros gratis|rodadas gratis|deposito.*dobrado/, peso: 2, motivo: 'bônus de aposta' },
  { re: /sinais.*(vip|grupo)|robo.*(aposta|trader|sinais)|assertividade.*%|taxa.*acerto.*%/, peso: 2, motivo: 'robô de sinais' },
  { re: /entra no meu grupo|meu canal|me segue|siga.*perfil|divulgo.*canal|promocao imperdivel/, peso: 2, motivo: 'divulgação' },
  { re: /trabalhe.*casa|vaga.*(copiar|colar|digitar)|ganhar.*sem sair de casa/, peso: 2, motivo: 'falsa vaga' },
  { re: /emprestimo.*aprovado|credito.*liberado|limite.*liberado/, peso: 2, motivo: 'crédito falso' },
  { re: /iphone.*999|preco.*metade|oferta.*so hoje/, peso: 2, motivo: 'oferta falsa' },
  // ---- peso 1: fracos ----
  // (link genérico NÃO conta sozinho: só link suspeito dispara — encurtador,
  //  domínio estranho ou t.me, já tratados acima)
  { re: /so hoje|ultimas vagas|corra|nao perca|acaba.*hoje/, peso: 1, motivo: 'urgência' },
  { re: /💰|🤑|💸|💵/, peso: 1, motivo: 'emoji de dinheiro' },
];

function temCaps(texto) {
  const letras = String(texto || '').replace(/[^A-Za-zÀ-Úà-ú]/g, '');
  if (letras.length < 20) return false;
  const caps = (letras.match(/[A-ZÀ-Ú]/g) || []).length;
  return caps / letras.length > 0.6;
}

// Retorna { score, nivel: 'severo'|'medio'|'baixo'|null, motivos: [...] }
export function analisarSinais(texto, limiarMedio = 3, limiarSevero = 6) {
  const low = String(texto || '').toLowerCase();
  // leet FORA das URLs: dígito de link virava letra ("83746906"→"beta") e falsava aposta
  const norm = normalizar(low.replace(URL_RE, ' '));
  const confiavel = temDominioOk(low);
  let score = 0;
  const motivos = [];
  for (const s of SINAIS) {
    try {
      if (s.phish && confiavel) continue; // link oficial junto = não é golpe
      if (s.re.test(s.url ? low : norm)) { score += s.peso; if (!motivos.includes(s.motivo)) motivos.push(s.motivo); }
    } catch {}
  }
  if (temCaps(texto)) { score += 1; motivos.push('caixa alta'); }
  if (/(.)\1{4,}/.test(String(texto || '').toLowerCase())) { score += 1; motivos.push('caracteres repetidos'); }
  // Metadados dos links: cada link suspeito vira um sinal forte.
  const links = analisarLinks(texto);
  for (const l of links.suspeitos) {
    score += 4;
    const m = `link suspeito: ${l.host} (${l.motivos[0] || 'suspeito'})`;
    if (!motivos.includes(m)) motivos.push(m);
  }
  if (links.metas.length >= 3) { score += 1; motivos.push('múltiplos links'); }
  const nivel = score >= limiarSevero ? 'severo' : score >= limiarMedio ? 'medio' : score >= 1 ? 'baixo' : null;
  return { score, nivel, motivos, links };
}

export const TOTAL_SINAIS = SINAIS.length;
