// Metadados de link: julga CADA link pelo domínio/TLD/caminho (0 rede, 0 IA).
// Ponto-chave: palavras de aposta/golpe no CAMINHO de um domínio CONFIÁVEL
// (ex.: lance.com.br/sites-de-apostas/…) NÃO tornam o link suspeito.
// Suspeito = TLD ruim, encurtador, IP, punycode, muitos hífens, convite t.me/+,
// ou caminho de aposta/golpe em domínio DESCONHECIDO.
// Regex aprimorada de URL:
// 1. Protocolo explícito (http/https/ftp)
// 2. www. ou t.me/
// 3. IPv4 com exatamente 4 octetos de 0 a 255 (ex: 192.168.1.1)
// 4. Domínios diretos terminados em TLD alfabético de 2+ letras (ex: site.com, bet.ru)
const PROTO_RE = /https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+|t\.me\/[^\s<>"')\]]+/i;
const IP_RE = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?::\d+)?(?:\/[^\s<>"')\]]*)?/i;
const DOMAIN_RE = /\b[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}(?::\d+)?(?:\/[^\s<>"')\]]*)?/i;

export const URL_RE = new RegExp(
  `${PROTO_RE.source}|${IP_RE.source}|${DOMAIN_RE.source}`,
  'gi'
);

export function extrairLinks(texto) {
  const t = String(texto || '').toLowerCase();
  const rawMatches = t.match(URL_RE) || [];
  // Limpa pontuações finais comuns como ponto ou vírgula no final da frase
  const clean = rawMatches.map((m) => m.replace(/[.,;:!?]+$/, '')).filter(Boolean);
  return [...new Set(clean)].slice(0, 10);
}

// Domínios confiáveis (notícia, gov, tech, banco, loja real). *.gov.br entra por sufixo.
const TRUSTED = [
  'gov.br', 'bcb.gov.br', 'ebc.com.br', 'in.gov.br',
  'lance.com.br', 'globo.com', 'g1.globo.com', 'ge.globo.com', 'globoesporte.com', 'uol.com.br',
  'folha.uol.com.br', 'estadao.com.br', 'terra.com.br', 'ig.com.br', 'r7.com', 'noticias.r7.com',
  'abril.com.br', 'veja.abril.com.br', 'exame.com', 'infomoney.com.br', 'valor.globo.com',
  'bbc.com', 'dw.com', 'nexojornal.com.br', 'elpais.com', 'bbc.co.uk', 'reuters.com',
  'wikipedia.org', 'wikimedia.org', 'wiktionary.org',
  'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com',
  'developer.mozilla.org', 'mozilla.org', 'nodejs.org', 'python.org', 'npmjs.com',
  'git-scm.com', 'w3.org', 'w3schools.com', 'react.dev', 'vuejs.org', 'angular.io',
  'rust-lang.org', 'golang.org', 'docker.com', 'kubernetes.io', 'postgresql.org',
  'aws.amazon.com', 'cloud.google.com', 'azure.microsoft.com', 'digitalocean.com',
  'vercel.com', 'netlify.com', 'cloudflare.com', 'medium.com', 'dev.to', 'hashnode.dev',
  'reddit.com', 'youtube.com', 'youtu.be', 'twitch.tv', 'spotify.com', 'soundcloud.com',
  'netflix.com', 'imdb.com', 'instagram.com', 'facebook.com', 'linkedin.com', 'tiktok.com',
  'twitter.com', 'x.com', 'whatsapp.com', 'web.whatsapp.com', 'telegram.org',
  'amazon.com.br', 'amazon.com', 'mercadolivre.com.br', 'magazineluiza.com.br',
  'americanas.com.br', 'shopee.com.br', 'olx.com.br', 'ifood.com.br', 'rappi.com.br',
  'uber.com', 'nubank.com.br', 'itau.com.br', 'bradesco.com.br', 'caixa.gov.br', 'bb.com.br',
  'santander.com.br', 'picpay.com', 'mercadopago.com.br', 'openai.com', 'anthropic.com',
  'huggingface.co', 'kaggle.com', 'arxiv.org', 'scielo.br', 'usp.br', 'unicamp.br', 'ufrj.br',
  'coursera.org', 'udemy.com', 'alura.com.br', 'rocketseat.com.br', 'freecodecamp.org',
  'khanacademy.org', 'google.com', 'maps.google.com', 'docs.google.com', 'drive.google.com',
];
// TLDs usados por golpe com frequência
const SHADY_TLD = new Set(['xyz', 'top', 'vip', 'cc', 'pw', 'click', 'win', 'live', 'online', 'site', 'club', 'space', 'biz', 'tk', 'ml', 'ga', 'cf', 'gq', 'work', 'link', 'shop', 'icu', 'cyber', 'rest', 'monster', 'quest', 'cam', 'surf', 'ru']);
const SHORTENERS = new Set(['bit.ly', 't.ly', 'tinyurl.com', 'is.gd', 'cutt.ly', 'goo.gl', 'ow.ly', 'rb.gy', 'rebrand.ly', 'shorturl.at', 'encurtador.com.br', 'trib.al', 'surl.li']);
// tokens de aposta/golpe no caminho ou no domínio (evita falso positivo por
// substring: 'alphabet' NÃO casa com 'bet'; só o token exato casa).
const STRONG_TOKENS = new Set([
  'aposta', 'apostas', 'apostar', 'apostasesportivas', 'bet', 'bets', 'betting', 'bet365',
  'casino', 'cassino', 'tigrinho', 'tigre', 'fortunetiger', 'fortune', 'tiger', 'blaze',
  'aviator', 'foguetinho', 'baccarat', 'bacara', 'slots', 'slot', 'roletarussa', 'roleta',
  'bonus', 'bonos', 'giros', 'rodadas', 'deposito', 'depositos', 'saque', 'saques',
  'airdrop', 'trader', 'trading', 'forex', 'rendaextra', 'mineracao', 'mining', 'piramide',
  'loteria', 'lottery', 'sorteio', 'rifa', 'jackpot', 'criptomoeda',
]);
const MILD_TOKENS = new Set(['promo', 'promocao', 'offer', 'oferta', 'gift', 'presente', 'winner', 'premio', 'premios', 'gratis', 'free', 'crypto', 'cripto', 'bitcoin', 'dinheiro', 'lucro', 'ganhar', 'invest', 'investimento', 'ganhe', 'ganhos']);
function tokens(s) { return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

function ehConfiado(host) {
  const h = host.toLowerCase();
  if (h.endsWith('.gov.br') || h.endsWith('.gov') || h.endsWith('.edu.br')) return true;
  return TRUSTED.some((d) => h === d || h.endsWith(`.${d}`));
}

// Retorna { url, host, tld, caminho, confiavel, suspeito, motivos[] }
export function metaLink(raw) {
  try {
    const bruto = String(raw || '').trim();
    const comProto = /^https?:\/\//i.test(bruto) ? bruto : `http://${bruto}`;
    const u = new URL(comProto);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    const tld = host.split('.').pop() || '';
    const caminho = `${u.pathname}${u.search}`.toLowerCase();
    const confiavel = ehConfiado(host);
    const motivos = [];
    let suspeito = false;
    const add = (m) => { suspeito = true; if (!motivos.includes(m)) motivos.push(m); };
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) add('IP no lugar de domínio');
    if (host.includes('xn--')) add('domínio disfarçado (punycode)');
    if (SHORTENERS.has(host)) add('link encurtado');
    if (SHADY_TLD.has(tld)) add('domínio suspeito (.tld)');
    if ((host.match(/-/g) || []).length >= 3) add('domínio com muitos hífens');
    if (/t\.me\/\+|t\.me\/joinchat|telegram\.me\/\+/.test(bruto.toLowerCase())) add('convite telegram');
    // caminho/domínio com token de aposta/golpe pune MESMO em domínio conhecido
    // (ex.: notícia lance.com.br/sites-de-apostas/… → punido, como o dono pediu)
    const tkHost = tokens(host);
    const tkPath = tokens(caminho);
    if (tkHost.some((t) => STRONG_TOKENS.has(t)) || tkPath.some((t) => STRONG_TOKENS.has(t))) add('conteúdo de aposta/golpe no link');
    else if ((tkHost.some((t) => MILD_TOKENS.has(t)) || tkPath.some((t) => MILD_TOKENS.has(t))) && SHADY_TLD.has(tld)) add('promoção em domínio ruim');
    return { url: bruto, host, tld, caminho, confiavel, suspeito, motivos };
  } catch {
    return null;
  }
}

// Analisa TODOS os links do texto. Retorna { metas, suspeitos }.
export function analisarLinks(texto) {
  const metas = extrairLinks(texto).map(metaLink).filter(Boolean);
  return { metas, suspeitos: metas.filter((m) => m.suspeito) };
}
