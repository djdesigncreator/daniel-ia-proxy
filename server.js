const express = require('express');
const crypto = require('crypto');

// Limpa variáveis de ambiente - remove espaços, aspas e barras a mais
function clean(value) {
  if (!value) return '';
  return value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\/+$/, '');
}

const PORT = process.env.PORT || 8080;
const VERSION = '1.60.0'; // 19/10/2026 - sites com várias páginas, fotografias reais (Pexels + IA), editor visual, quiz antes do checkout

// Quantas imagens a pessoa pode anexar a um único pedido de criação ou
// edição (para além do logótipo, que é um campo à parte). É um limite de
// quantidade, não de tamanho - o tamanho de cada uma continua sujeito ao
// espaço que sobra no plano (verificarEspaco).
const MAX_IMAGENS_POR_PEDIDO = 5;

// Remove um "http://" ou "https://" que já esteja no valor, para nunca
// ficarmos com "https://https://..." ao montarmos o URL
function semProtocolo(valor) {
  return clean(valor).replace(/^https?:\/\//i, '');
}

// Escapa texto antes de o colocarmos dentro de HTML montado à mão no
// servidor (como a página /loja-obrigado) - evita que um nome de loja com
// caracteres especiais (<, >, ", etc.) parta a página.
function escaparHtml(texto) {
  return String(texto == null ? '' : texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Bubble ----
const BUBBLE_BASE = clean(process.env.BUBBLE_BASE);
const BUBBLE_TOKEN = clean(process.env.BUBBLE_TOKEN);

// ---- Bunny Storage / CDN ----
const STORAGE_ZONE = clean(process.env.STORAGE_ZONE);
const STORAGE_PASSWORD = clean(process.env.STORAGE_PASSWORD);
const STORAGE_HOST = semProtocolo(process.env.STORAGE_HOST) || 'storage.bunnycdn.com';
const CDN_HOST = semProtocolo(process.env.CDN_HOST);
// Chave de API da CONTA Bunny (Account Settings > API) - diferente da
// STORAGE_PASSWORD. Serve só para limpar a cache da CDN depois de editarmos
// um site (reescrevemos o mesmo caminho, e sem purga a versão antiga podia
// continuar a aparecer até a cache expirar sozinha).
const BUNNY_API_KEY = clean(process.env.BUNNY_API_KEY);

// ---- OpenAI ----
const OPENAI_API_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_MODEL = clean(process.env.OPENAI_MODEL) || 'gpt-5.6-sol';
const OPENAI_REASONING_EFFORT = clean(process.env.OPENAI_REASONING_EFFORT) || 'low';
// Modelo para tarefas pequenas (arrumar a loja). Se não existir, usa o principal.
const OPENAI_MODEL_RAPIDO = clean(process.env.OPENAI_MODEL_RAPIDO) || '';
// Subido de 16000 para 32000 a 12/10/2026: com a instrução "capricha
// sempre, nunca curto" (pedida depois), o raciocínio interno do modelo
// passou a gastar o tecto todo antes de sobrar espaço para o HTML visível,
// voltando a dar "resposta vazia" (ver erro "A OpenAI devolveu uma
// resposta vazia ou demasiado curta" nos logs). 32000 dá folga de sobra
// tanto para o raciocínio como para um HTML completo e bem desenvolvido.
const OPENAI_MAX_TOKENS = parseInt(clean(process.env.OPENAI_MAX_TOKENS), 10) || 32000;

// ---- MozPayment ----
// Credenciais da conta MozPayment da Daniel IA (diferente da carteira do
// projecto Bag Security). Nunca aparecem em nenhum HTML gerado nem são
// devolvidas a nenhuma página - ficam só aqui no container.
const MOZPAYMENT_EMAIL = clean(process.env.MOZPAYMENT_EMAIL);
const MOZPAYMENT_SENHA = clean(process.env.MOZPAYMENT_SENHA);
const MOZPAYMENT_WALLET = clean(process.env.MOZPAYMENT_WALLET);

// Endereço público deste container - usado para montar o "return_url" que
// damos à MozPayment nos pagamentos por cartão (para onde o cliente volta
// depois de pagar).
const SELF_URL = clean(process.env.SELF_URL) || 'https://mc-8oxfde5o71.bunny.run';

// Endereço do dashboard da app Daniel IA - usado para onde a pessoa volta
// depois de assinar um plano (ver /assinatura-obrigado).
const APP_URL = clean(process.env.APP_URL) || 'https://daniel-ia.pro/dashboard';
// Endereço da página de planos - só para o botão do email de aviso de
// expiração (ver templateEmailAvisoExpiracao). Mesma base do APP_URL.
const PLANOS_URL = APP_URL.replace(/\/dashboard\/?$/, '/planos');

// ---- Chave para as rotas administrativas/de debug (ex: disparar os avisos
// de expiração na hora, fora do ciclo automático) - nunca exposta ao
// dashboard, só para chamadas manuais tuas. Define-a nas variáveis de
// ambiente do container antes de usares essas rotas.
const ADMIN_SECRET = clean(process.env.ADMIN_SECRET);

// ---- Resend (email transaccional - código de confirmação do cadastro) ----
const RESEND_KEY = clean(process.env.RESEND_KEY);
// MAIL_FROM pode vir só como endereço ("naoresponder@daniel-ia.pro") ou já
// formatado ("Daniel IA <naoresponder@daniel-ia.pro>") - aceitamos os dois.
const MAIL_FROM = clean(process.env.MAIL_FROM) || 'naoresponder@daniel-ia.pro';

// ---- Bunny Stream (vídeo da Galeria) ----
// Video Library própria da conta Bunny do Daniel IA, separada da storage
// zone/pull zone usadas para fotos e ficheiros dos sites. Vídeo não sobe
// em base64 (ficaria grande demais) - sobe directamente do browser para o
// Bunny Stream por TUS (upload com retoma), e este container só autoriza
// o upload e depois consulta o estado da conversão.
const STREAM_LIBRARY = clean(process.env.STREAM_LIBRARY);
const STREAM_KEY = clean(process.env.STREAM_KEY);
const STREAM_CDN = semProtocolo(process.env.STREAM_CDN);

const app = express();

// ======================================================
// SEGURANÇA (15/10/2026)
// ======================================================
// Camadas, por esta ordem:
//  1. Cabeçalhos de segurança em todas as respostas.
//  2. CORS: as rotas da conta (privadas) só aceitam pedidos vindos das
//     páginas do Daniel IA. As rotas públicas (lojas, galerias, blogs e
//     formulários dos sites gerados, que vivem noutros domínios) continuam
//     abertas a qualquer origem.
//  3. Limites de pedidos por IP e por conta (anti força bruta e anti spam).
//  4. Validação dos ids que chegam no corpo (impede injectar caminhos ou
//     parâmetros na Data API do Bubble, que usamos com token de admin).
//  5. Sessão obrigatória (owner + token) em todas as rotas da conta - já
//     não basta saber o id de alguém para mexer na conta dele.
// Interruptor de emergência no Bunny: SESSAO_MODO=aviso deixa passar os
// pedidos sem sessão válida (só regista no log). Por omissão é obrigatória.
app.disable('x-powered-by');
app.set('trust proxy', true);

const SESSAO_MODO = (clean(process.env.SESSAO_MODO) || 'obrigatoria').toLowerCase();
const ORIGENS_PERMITIDAS = new Set(
  ['https://app.daniel-ia.pro', 'https://daniel-ia.pro', 'https://www.daniel-ia.pro', 'https://daniel-ia.bubbleapps.io', SELF_URL]
    .concat(String(process.env.ORIGENS_EXTRA || '').split(','))
    .map(o => String(o || '').trim().replace(/\/+$/, ''))
    .filter(Boolean)
);

// Rotas da conta: exigem sessão e só aceitam as origens do Daniel IA.
const ROTAS_PRIVADAS = new Set([
  '/dominio-configurar', '/dominio-cloudflare-auto', '/dominio-verificar',
  '/generate', '/editar', '/generate-status', '/escolher-variante', '/novas-variantes', '/trocar-variante',
  '/admin-entrar', '/admin-resumo', '/admin-utilizadores', '/admin-utilizador', '/admin-atribuir-plano', '/admin-tokens', '/admin-terminar-sessoes', '/admin-sites', '/admin-pagamentos', '/admin-registo', '/account', '/meus-sites',
  '/loja-produto-criar', '/loja-meus-produtos', '/loja-produto-editar',
  '/portfolio-trabalho-criar', '/portfolio-meus-trabalhos', '/portfolio-trabalho-editar',
  '/blog-post-criar', '/blog-meus-posts', '/blog-post-editar', '/contacto-guardar',
  '/galeria-album-criar', '/galeria-meus-albuns', '/galeria-album-editar', '/galeria-album-media',
  '/galeria-foto-adicionar', '/galeria-video-iniciar', '/galeria-video-estado', '/galeria-media-apagar',
  '/assinatura-iniciar', '/assinatura-pagar', '/assinatura-estado', '/recarga-iniciar',
  '/admin-planos', '/admin-plano-guardar', '/admin-pacote-guardar', '/admin-pacotes-sugeridos', '/admin-tokens-extra',
  '/loja-config-ler', '/loja-config-guardar', '/loja-montra-guardar', '/loja-categorias', '/loja-categorias-guardar', '/loja-categoria-renomear', '/loja-categoria-remover', '/loja-avaliacoes-gerir', '/loja-avaliacao-decidir', '/loja-organizar', '/loja-organizar-aplicar',
  '/kyc-estado', '/kyc-enviar', '/sair'
]);
// Sem sessão (ainda não há conta entrada), mas só a partir das nossas
// páginas - ou sem Origin nenhuma (chamadas servidor-a-servidor do Bubble).
const ROTAS_SO_ORIGEM = new Set([
  '/signup-code', '/verify-code', '/entrar', '/conta-wf', '/sessao-criar', '/plan-warnings-teste-7hq2fx',
  '/admin-kyc-lista', '/admin-kyc-imagem', '/admin-kyc-decidir'
]);
const ROTAS_ADMIN = new Set(['/sessao-criar', '/plan-warnings-teste-7hq2fx', '/admin-kyc-lista', '/admin-kyc-imagem', '/admin-kyc-decidir']);

function ipDe(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || (req.socket && req.socket.remoteAddress) || 'desconhecido';
}

// ---- 1. Cabeçalhos ----
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // As páginas de "obrigado" do cartão abrem DENTRO da janela de pagamento
  // (o checkout fica embutido na app e nas lojas), por isso podem ser
  // mostradas noutra página. Tudo o resto continua proibido de embutir.
  if (req.path === '/assinatura-obrigado' || req.path === '/loja-obrigado') {
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  } else {
    res.setHeader('X-Frame-Options', 'DENY');
  }
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ---- 2. CORS ----
app.use((req, res, next) => {
  const origem = String(req.headers.origin || '').replace(/\/+$/, '');
  const fechada = ROTAS_PRIVADAS.has(req.path) || ROTAS_SO_ORIGEM.has(req.path);
  if (fechada) {
    if (origem && !ORIGENS_PERMITIDAS.has(origem)) {
      console.warn('[seguranca] origem recusada', origem, 'em', req.path, 'IP', ipDe(req));
      return res.status(403).json({ status: 'error', message: 'Pedido não autorizado.' });
    }
    if (origem) {
      res.header('Access-Control-Allow-Origin', origem);
      res.header('Vary', 'Origin');
    }
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- 3. Limites de pedidos (memória do container) ----
const baldesLimite = new Map();
function contar(chave, max, janelaMs) {
  const agora = Date.now();
  let b = baldesLimite.get(chave);
  if (!b || b.fim <= agora) { b = { n: 0, fim: agora + janelaMs }; baldesLimite.set(chave, b); }
  b.n++;
  return b.n <= max;
}
function excedido(chave, max) {
  const b = baldesLimite.get(chave);
  return !!(b && b.fim > Date.now() && b.n >= max);
}
setInterval(() => {
  const agora = Date.now();
  for (const [k, b] of baldesLimite) if (b.fim <= agora) baldesLimite.delete(k);
}, 60 * 1000).unref();

const MIN = 60 * 1000;
// [quem, máximo, janela]. quem: ip | owner | email | site
const LIMITES = {
  '/entrar': [['ip', 20, 15 * MIN]],
  // Sem limite por IP: o workflow do Bubble chama esta rota sempre do
  // mesmo IP (o do Bubble), e bloquearia todos os registos novos.
  '/signup-code': [['owner', 6, 60 * MIN]],
  '/verify-code': [['owner', 12, 15 * MIN], ['ip', 40, 15 * MIN]],
  '/contacto-enviar': [['ip', 5, 10 * MIN], ['site', 40, 60 * MIN]],
  '/loja-encomenda': [['ip', 15, 10 * MIN]],
  '/loja-pagar': [['ip', 10, 10 * MIN]],
  '/loja-avaliar': [['ip', 5, 60 * MIN]],
  '/loja-montra-guardar': [['owner', 40, 10 * MIN]],
  '/loja-categorias-guardar': [['owner', 40, 10 * MIN]],
  '/loja-categoria-renomear': [['owner', 40, 10 * MIN]],
  '/loja-categoria-remover': [['owner', 40, 10 * MIN]],
  '/loja-organizar': [['owner', 12, 60 * MIN]],
  '/loja-organizar-aplicar': [['owner', 30, 10 * MIN]],
  '/generate': [['owner', 10, 10 * MIN], ['ip', 20, 10 * MIN]],
  '/escolher-variante': [['owner', 20, 10 * MIN]],
  '/admin-entrar': [['owner', 60, 10 * MIN], ['ip', 60, 10 * MIN]],
  '/admin-atribuir-plano': [['owner', 60, 10 * MIN]],
  '/novas-variantes': [['owner', 6, 60 * MIN]],
  '/trocar-variante': [['owner', 30, 10 * MIN]],
  '/editar': [['owner', 15, 10 * MIN]],
  '/kyc-enviar': [['owner', 5, 60 * MIN], ['ip', 10, 60 * MIN]],
  '/dominio-cloudflare-auto': [['owner', 10, 60 * MIN]],
  '/dominio-configurar': [['owner', 20, 60 * MIN]],
  '/galeria-foto-adicionar': [['owner', 150, 10 * MIN]],
  '/sessao-criar': [['ip', 120, 15 * MIN]],
  '/admin-kyc-lista': [['ip', 60, 15 * MIN]],
  '/admin-kyc-imagem': [['ip', 200, 15 * MIN]],
  '/admin-kyc-decidir': [['ip', 60, 15 * MIN]],
  '/plan-warnings-teste-7hq2fx': [['ip', 10, 60 * MIN]],
  '/assinatura-confirmacao': [['ip', 150, 10 * MIN]],
  '/recarga-iniciar': [['owner', 20, 10 * MIN]],
  '/admin-plano-guardar': [['owner', 60, 10 * MIN]],
  '/admin-pacote-guardar': [['owner', 60, 10 * MIN]],
  '/admin-tokens-extra': [['owner', 60, 10 * MIN]]
};
const MSG_LIMITE = 'Demasiados pedidos. Espera um pouco e tenta outra vez.';
function recusarLimite(res, req, regra) {
  console.warn('[seguranca] limite atingido', req.path, regra, 'IP', ipDe(req));
  return res.status(429).json({ status: 'error', codigo: 'limite', message: MSG_LIMITE });
}

app.use((req, res, next) => {
  const ip = ipDe(req);
  // Limite geral por IP, generoso - só trava abuso a sério.
  if (!contar('geral:' + ip, 400, MIN)) return recusarLimite(res, req, 'geral');
  // Chave de admin errada vezes demais: IP bloqueado 30 minutos.
  if (ROTAS_ADMIN.has(req.path) && excedido('admin-falha:' + ip, 10)) return recusarLimite(res, req, 'admin-falhas');
  next();
});

app.use(express.json({ limit: '15mb' })); // 15mb para caber um logótipo em base64

// JSON partido não mostra a pilha de erro do Express a ninguém.
app.use((erro, req, res, next) => {
  if (erro && (erro.type === 'entity.parse.failed' || erro.type === 'entity.too.large')) {
    return res.status(400).json({ status: 'error', message: 'Pedido inválido.' });
  }
  next(erro);
});

app.use((req, res, next) => {
  const regras = LIMITES[req.path];
  if (!regras) return next();
  const corpo = req.body || {};
  const ip = ipDe(req);
  for (const [quem, max, janela] of regras) {
    let valor = ip;
    if (quem === 'owner') valor = String(corpo.owner || '');
    if (quem === 'site') valor = String(corpo.site_id || '');
    if (quem === 'email') valor = String(corpo.email || '').toLowerCase();
    if (!valor) continue;
    if (!contar(req.path + ':' + quem + ':' + valor, max, janela)) return recusarLimite(res, req, quem);
  }
  next();
});

// ---- 4. Ids válidos ----
// Os ids do Bubble são só números, letras e "x". Qualquer coisa com "/",
// "?", "&", espaços ou objectos é recusada antes de chegar à Data API.
const ID_VALIDO = /^[A-Za-z0-9_-]{1,64}$/;
const CAMPOS_ID = ['owner', 'user_id', 'site_id', 'produto_id', 'album_id', 'media_id', 'post_id', 'trabalho_id',
  'encomenda_id', 'assinatura_id', 'plano_id', 'pacote_id', 'generation_id', 'avaliacao_id', 'id'];
app.use((req, res, next) => {
  const corpo = req.body;
  if (corpo && typeof corpo === 'object') {
    for (const campo of CAMPOS_ID) {
      const v = corpo[campo];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string' || !ID_VALIDO.test(v)) {
        console.warn('[seguranca] id inválido em', req.path, campo, 'IP', ipDe(req));
        return res.status(400).json({ status: 'error', message: 'Pedido inválido.' });
      }
    }
    if (corpo.token !== undefined && (typeof corpo.token !== 'string' || corpo.token.length > 200)) {
      return res.status(400).json({ status: 'error', message: 'Pedido inválido.' });
    }
  }
  next();
});

// ---- 5. Sessão obrigatória nas rotas da conta ----
// Sessões válidas ficam 60 s em memória, para não ir ao Bubble em cada
// pedido. Ao sair (/sair) ou ao entrar noutra vez, a cache é limpa.
const cacheSessoes = new Map();
function esquecerSessoes(owner) {
  for (const k of cacheSessoes.keys()) if (k.indexOf(owner + ':') === 0) cacheSessoes.delete(k);
}
app.use(async (req, res, next) => {
  if (!ROTAS_PRIVADAS.has(req.path) || req.method !== 'POST') return next();
  if (SESSAO_MODO === 'desligada') return next();
  const { owner, token } = req.body || {};
  const chave = owner + ':' + token;
  const emCache = cacheSessoes.get(chave);
  if (owner && token && emCache && emCache > Date.now()) return next();
  const usuario = await validarSessao(owner, token);
  if (usuario) {
    cacheSessoes.set(chave, Date.now() + 60 * 1000);
    return next();
  }
  if (SESSAO_MODO === 'aviso') {
    console.warn('[seguranca] pedido sem sessão válida (modo aviso, deixado passar):', req.path, 'IP', ipDe(req));
    return next();
  }
  console.warn('[seguranca] pedido sem sessão válida recusado:', req.path, 'IP', ipDe(req));
  return res.json({ status: 'error', codigo: 'sessao', message: 'A tua sessão expirou. Entra outra vez na tua conta.' });
});

// ======================================================
// Helpers - Bubble Data API
// ======================================================

function idSeguro(id) {
  const t = String(id == null ? '' : id);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(t)) throw new Error('id inválido');
  return encodeURIComponent(t);
}

async function bubbleGet(tipo, id) {
  const res = await fetch(`${BUBBLE_BASE}/${tipo}/${idSeguro(id)}`, {
    headers: { Authorization: `Bearer ${BUBBLE_TOKEN}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error('bubbleGet falhou: ' + JSON.stringify(json));
  return json.response;
}

async function bubbleCount(tipo, constraints) {
  const url = `${BUBBLE_BASE}/${tipo}?constraints=${encodeURIComponent(JSON.stringify(constraints))}&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${BUBBLE_TOKEN}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error('bubbleCount falhou: ' + JSON.stringify(json));
  const count = json.response.count || 0;
  const remaining = json.response.remaining || 0;
  return count + remaining;
}

async function bubbleList(tipo, constraints, sortField, descending) {
  const params = new URLSearchParams();
  params.set('constraints', JSON.stringify(constraints));
  if (sortField) {
    params.set('sort_field', sortField);
    params.set('descending', descending ? 'true' : 'false');
  }
  params.set('limit', '100');
  const url = `${BUBBLE_BASE}/${tipo}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${BUBBLE_TOKEN}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error('bubbleList falhou: ' + JSON.stringify(json));
  return json.response.results || [];
}

async function bubbleCreate(tipo, dados) {
  const res = await fetch(`${BUBBLE_BASE}/${tipo}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BUBBLE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(dados)
  });
  const json = await res.json();
  if (!res.ok) throw new Error('bubbleCreate falhou: ' + JSON.stringify(json));
  return json.id;
}

async function bubblePatch(tipo, id, dados) {
  const res = await fetch(`${BUBBLE_BASE}/${tipo}/${idSeguro(id)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${BUBBLE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(dados)
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error('bubblePatch falhou: ' + JSON.stringify(json));
  }
}

async function bubbleDelete(tipo, id) {
  const res = await fetch(`${BUBBLE_BASE}/${tipo}/${idSeguro(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${BUBBLE_TOKEN}` }
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error('bubbleDelete falhou: ' + JSON.stringify(json));
  }
}

// ======================================================
// Helper - garantir que a conta tem um plano
// ======================================================
// Contas que ficaram sem Plan atribuído (ex: registaram-se antes de os
// Planos terem sido criados na base Live) já não ficam bloqueadas para
// sempre com o erro "A tua conta não tem nenhum plano atribuído" - esta
// função atribui o plano Free automaticamente da primeira vez que
// encontrar isso, em vez de a pessoa ter de ser corrigida à mão no Bubble.
// Devolve o id do plano (o que já estava, ou o Free atribuído agora), ou
// null se mesmo assim não houver nenhum plano Free activo na base de dados
// (caso que o chamador deve tratar como erro real).
async function garantirPlano(owner, user) {
  if (user['Plan']) return user['Plan'];

  // Busca todos os planos activos e procura o "Free" aqui no código (em vez
  // de pedir ao Bubble para filtrar pelo nome) - é a mesma comparação que já
  // usamos noutros sítios (ex: para decidir a marca de água), por isso
  // sabemos que esta forma de identificar o Free funciona.
  const planosActivos = await bubbleList('plan', [
    { key: 'Is Active', constraint_type: 'equals', value: true }
  ]);
  const planoFree = planosActivos.find(p => String(p['Name'] || '').trim().toLowerCase() === 'free');
  if (!planoFree) {
    console.error('garantirPlano: não encontrei nenhum plano "Free" activo para atribuir a ' + owner + ' (planos activos encontrados: ' + planosActivos.map(p => p['Name']).join(', ') + ')');
    return null;
  }

  await bubblePatch('user', owner, {
    'Plan': planoFree._id,
    'Plan Started': new Date().toISOString()
  });
  console.log('garantirPlano: conta ' + owner + ' não tinha plano - atribuí o Free (' + planoFree._id + ') automaticamente.');
  return planoFree._id;
}

// ======================================================
// Helpers - Email (Resend) e código de confirmação
// ======================================================

// Código de 8 caracteres (0-9, A-F) - fácil de ler e de escrever no
// telemóvel, com espaço suficiente para não haver colisões práticas.
function gerarCodigo() {
  return crypto.randomBytes(6).toString('hex').toUpperCase().slice(0, 8);
}

// Formata uma data em português (ex: "12 de Novembro de 2026") sem
// depender do Node ter o pacote completo de ICU instalado (ao contrário
// de toLocaleDateString, que no servidor nem sempre está disponível).
function formatarDataPt(data) {
  var meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  return data.getDate() + ' de ' + meses[data.getMonth()] + ' de ' + data.getFullYear();
}

// Envia um email pelo Resend, usando o domínio verificado daniel-ia.pro.
// replyTo é opcional - usado pelo formulário de contacto, para o dono do
// site conseguir responder directamente à pessoa que escreveu, sem o
// Daniel IA ficar no meio da conversa.
async function enviarEmail(destinatario, assunto, html, replyTo) {
  if (!RESEND_KEY) throw new Error('Falta a variável RESEND_KEY no container.');
  const remetente = MAIL_FROM.includes('<') ? MAIL_FROM : `Daniel IA <${MAIL_FROM}>`;
  const corpo = {
    from: remetente,
    to: [destinatario],
    subject: assunto,
    html
  };
  if (replyTo) corpo.reply_to = replyTo;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(corpo)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('enviarEmail falhou: ' + JSON.stringify(json));
  return json;
}

// Email formatado (HTML com estilos inline, compatível com Gmail/Outlook)
// para o código de confirmação do cadastro - mesma identidade visual do
// resto do Daniel IA (gradiente roxo->índigo, cartão claro).
function templateEmailCodigo(nome, codigo) {
  const primeiroNome = escaparHtml(String(nome || '').trim().split(' ')[0] || '');
  const saudacao = primeiroNome ? `Olá, ${primeiroNome}.` : 'Olá.';
  const codigoEspacado = escaparHtml(String(codigo).split('').join(' '));
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>O teu código - Daniel IA</title>
</head>
<body style="margin:0;padding:0;background:#F4F0F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F0F8;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:460px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #EAE2F2;">
<tr>
<td bgcolor="#430960" style="background:#430960;background-image:linear-gradient(135deg,#5A0F80 0%,#2E0644 100%);padding:28px 32px 24px 32px;text-align:center;border-bottom:4px solid #89C804;">
<img src="https://app.daniel-ia.pro/marca/daniel-ia-logo-email.png" width="168" alt="Daniel IA" style="display:inline-block;width:168px;max-width:100%;height:auto;border:0;outline:none;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;">
</td>
</tr>
<tr>
<td style="padding:36px 32px 28px 32px;">
<p style="margin:0 0 4px 0;color:#1A0A27;font-size:18px;font-weight:700;">${saudacao}</p>
<p style="margin:0 0 28px 0;color:#6F5E81;font-size:14px;line-height:1.6;">Usa o código abaixo para confirmares o teu email e activares a tua conta no Daniel IA. Este código expira em 15 minutos.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="background:#F7F2FB;border:1px solid #EAE2F2;border-radius:12px;padding:20px;">
<span style="font-family:'Courier New',Courier,monospace;font-size:28px;font-weight:700;letter-spacing:6px;color:#430960;">${codigoEspacado}</span>
</td></tr>
</table>
<p style="margin:24px 0 0 0;color:#9A8CAB;font-size:12.5px;line-height:1.6;">Se não pediste esta conta, ignora este email - ninguém mais consegue entrar sem este código.</p>
</td>
</tr>
<tr>
<td style="padding:18px 32px;background:#FAF8FC;border-top:1px solid #EAE2F2;text-align:center;">
<p style="margin:0;color:#B3A7C2;font-size:11.5px;">Daniel IA · daniel-ia.pro</p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Email formatado (HTML com estilos inline) para avisar o dono de um site
// que alguém escreveu pelo formulário de contacto do site. Mesma
// identidade visual dos outros emails - a diferença é que o "Responder"
// num cliente de email normal vai direito para a pessoa que escreveu
// (ver reply_to em enviarEmail), nunca para o Daniel IA.
function templateEmailContacto(nomeSite, nomeRemetente, emailRemetente, mensagem) {
  const nomeSiteEsc = escaparHtml(String(nomeSite || 'o teu site').trim());
  const nomeRemetenteEsc = escaparHtml(String(nomeRemetente || '').trim());
  const emailRemetenteEsc = escaparHtml(String(emailRemetente || '').trim());
  const mensagemEsc = escaparHtml(String(mensagem || '').trim()).replace(/\n/g, '<br>');
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nova mensagem de contacto - Daniel IA</title>
</head>
<body style="margin:0;padding:0;background:#F4F0F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F0F8;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:460px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #EAE2F2;">
<tr>
<td bgcolor="#430960" style="background:#430960;background-image:linear-gradient(135deg,#5A0F80 0%,#2E0644 100%);padding:28px 32px 24px 32px;text-align:center;border-bottom:4px solid #89C804;">
<img src="https://app.daniel-ia.pro/marca/daniel-ia-logo-email.png" width="168" alt="Daniel IA" style="display:inline-block;width:168px;max-width:100%;height:auto;border:0;outline:none;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;">
</td>
</tr>
<tr>
<td style="padding:36px 32px 28px 32px;">
<p style="margin:0 0 4px 0;color:#1A0A27;font-size:18px;font-weight:700;">Nova mensagem de contacto</p>
<p style="margin:0 0 24px 0;color:#6F5E81;font-size:14px;line-height:1.6;">Alguém escreveu pelo formulário de contacto de <strong>${nomeSiteEsc}</strong>. Para responder, basta usar o botão "Responder" do teu email - vai directo para esta pessoa.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="background:#F7F2FB;border:1px solid #EAE2F2;border-radius:12px;padding:18px 20px;">
<p style="margin:0 0 10px 0;color:#1A0A27;font-size:14px;"><strong>Nome:</strong> ${nomeRemetenteEsc}</p>
<p style="margin:0 0 14px 0;color:#1A0A27;font-size:14px;"><strong>Email:</strong> ${emailRemetenteEsc}</p>
<p style="margin:0;color:#3B2C4A;font-size:14px;line-height:1.6;">${mensagemEsc}</p>
</td></tr>
</table>
</td>
</tr>
<tr>
<td style="padding:18px 32px;background:#FAF8FC;border-top:1px solid #EAE2F2;text-align:center;">
<p style="margin:0;color:#B3A7C2;font-size:11.5px;">Daniel IA · daniel-ia.pro</p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Email formatado (HTML com estilos inline) para confirmar que uma
// assinatura de plano foi paga e aplicada - mesma identidade visual do
// email do código de confirmação.
function templateEmailAssinatura(nome, nomePlano, valorMzn, expiraEm) {
  const primeiroNome = escaparHtml(String(nome || '').trim().split(' ')[0] || '');
  const saudacao = primeiroNome ? `Olá, ${primeiroNome}.` : 'Olá.';
  const plano = escaparHtml(nomePlano || '');
  const valorFormatado = escaparHtml(Number(valorMzn || 0).toLocaleString('pt-PT') + ' MZN');
  const dataFormatada = escaparHtml(formatarDataPt(expiraEm));
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Assinatura confirmada - Daniel IA</title>
</head>
<body style="margin:0;padding:0;background:#F4F0F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F0F8;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:460px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #EAE2F2;">
<tr>
<td bgcolor="#430960" style="background:#430960;background-image:linear-gradient(135deg,#5A0F80 0%,#2E0644 100%);padding:28px 32px 24px 32px;text-align:center;border-bottom:4px solid #89C804;">
<img src="https://app.daniel-ia.pro/marca/daniel-ia-logo-email.png" width="168" alt="Daniel IA" style="display:inline-block;width:168px;max-width:100%;height:auto;border:0;outline:none;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;">
</td>
</tr>
<tr>
<td style="padding:36px 32px 28px 32px;">
<p style="margin:0 0 4px 0;color:#1A0A27;font-size:18px;font-weight:700;">${saudacao}</p>
<p style="margin:0 0 24px 0;color:#6F5E81;font-size:14px;line-height:1.6;">O teu pagamento foi confirmado e a tua assinatura já está activa. Obrigado por confiares no Daniel IA.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F2FB;border:1px solid #EAE2F2;border-radius:12px;">
<tr>
<td style="padding:18px 20px;border-bottom:1px solid #EAE2F2;">
<span style="display:block;color:#9A8CAB;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Plano</span>
<span style="display:block;color:#1A0A27;font-size:16px;font-weight:700;">${plano}</span>
</td>
</tr>
<tr>
<td style="padding:18px 20px;border-bottom:1px solid #EAE2F2;">
<span style="display:block;color:#9A8CAB;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Valor pago</span>
<span style="display:block;color:#1A0A27;font-size:16px;font-weight:700;">${valorFormatado}</span>
</td>
</tr>
<tr>
<td style="padding:18px 20px;">
<span style="display:block;color:#9A8CAB;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Válido até</span>
<span style="display:block;color:#1A0A27;font-size:16px;font-weight:700;">${dataFormatada}</span>
</td>
</tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
<tr><td align="center">
<a href="${APP_URL}" style="display:inline-block;background:#89C804;color:#1A0A27;font-weight:800;text-decoration:none;font-size:14px;font-weight:600;padding:13px 28px;border-radius:10px;">Ir para o dashboard</a>
</td></tr>
</table>
</td>
</tr>
<tr>
<td style="padding:18px 32px;background:#FAF8FC;border-top:1px solid #EAE2F2;text-align:center;">
<p style="margin:0;color:#B3A7C2;font-size:11.5px;">Daniel IA · daniel-ia.pro</p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Nome amigável do método de pagamento, para mostrar nos recibos.
function formatarMetodoPagamento(metodo) {
  const mapa = { mpesa: 'M-Pesa', emola: 'e-Mola', cartao: 'Cartão (Visa/Mastercard)' };
  return mapa[String(metodo || '').toLowerCase()] || (metodo || '-');
}

// Email formatado (HTML com estilos inline) - recibo de pagamento da
// assinatura de um plano da própria Daniel IA. Diferente do
// templateEmailAssinatura (que dá as boas-vindas ao plano novo): este é
// só o comprovativo do pagamento em si, com referência e método.
function templateEmailReciboAssinatura(nome, nomePlano, valorMzn, metodo, referencia, dataPagamento) {
  const primeiroNome = escaparHtml(String(nome || '').trim().split(' ')[0] || '');
  const saudacao = primeiroNome ? `Olá, ${primeiroNome}.` : 'Olá.';
  const plano = escaparHtml(nomePlano || '');
  const valorFormatado = escaparHtml(Number(valorMzn || 0).toLocaleString('pt-PT') + ' MZN');
  const metodoFormatado = escaparHtml(formatarMetodoPagamento(metodo));
  const referenciaFormatada = escaparHtml(String(referencia || '-'));
  const dataFormatada = escaparHtml(formatarDataPt(dataPagamento));
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Recibo de pagamento - Daniel IA</title>
</head>
<body style="margin:0;padding:0;background:#F4F0F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F0F8;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:460px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #EAE2F2;">
<tr>
<td bgcolor="#430960" style="background:#430960;background-image:linear-gradient(135deg,#5A0F80 0%,#2E0644 100%);padding:28px 32px 24px 32px;text-align:center;border-bottom:4px solid #89C804;">
<img src="https://app.daniel-ia.pro/marca/daniel-ia-logo-email.png" width="168" alt="Daniel IA" style="display:inline-block;width:168px;max-width:100%;height:auto;border:0;outline:none;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;">
</td>
</tr>
<tr>
<td style="padding:36px 32px 28px 32px;">
<p style="margin:0 0 4px 0;color:#1A0A27;font-size:18px;font-weight:700;">${saudacao}</p>
<p style="margin:0 0 24px 0;color:#6F5E81;font-size:14px;line-height:1.6;">Aqui está o recibo do teu pagamento. Guarda este email para a tua referência.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F2FB;border:1px solid #EAE2F2;border-radius:12px;">
<tr>
<td style="padding:16px 20px;border-bottom:1px solid #EAE2F2;">
<span style="display:block;color:#9A8CAB;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Plano</span>
<span style="display:block;color:#1A0A27;font-size:15px;font-weight:700;">${plano}</span>
</td>
</tr>
<tr>
<td style="padding:16px 20px;border-bottom:1px solid #EAE2F2;">
<span style="display:block;color:#9A8CAB;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Valor pago</span>
<span style="display:block;color:#1A0A27;font-size:15px;font-weight:700;">${valorFormatado}</span>
</td>
</tr>
<tr>
<td style="padding:16px 20px;border-bottom:1px solid #EAE2F2;">
<span style="display:block;color:#9A8CAB;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Método</span>
<span style="display:block;color:#1A0A27;font-size:15px;font-weight:700;">${metodoFormatado}</span>
</td>
</tr>
<tr>
<td style="padding:16px 20px;border-bottom:1px solid #EAE2F2;">
<span style="display:block;color:#9A8CAB;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Referência</span>
<span style="display:block;color:#1A0A27;font-size:15px;font-weight:700;">${referenciaFormatada}</span>
</td>
</tr>
<tr>
<td style="padding:16px 20px;">
<span style="display:block;color:#9A8CAB;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Data do pagamento</span>
<span style="display:block;color:#1A0A27;font-size:15px;font-weight:700;">${dataFormatada}</span>
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td style="padding:18px 32px;background:#FAF8FC;border-top:1px solid #EAE2F2;text-align:center;">
<p style="margin:0;color:#B3A7C2;font-size:11.5px;">Daniel IA · daniel-ia.pro</p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Email formatado (HTML com estilos inline) - recibo de pagamento de uma
// compra numa loja gerada pela Daniel IA (E-commerce/Checkout de um
// cliente). Enviado ao comprador final, não ao dono da loja. "itens" é a
// lista já calculada (nome, preco_unitario, quantidade) guardada em
// "Produtos Json" na Encomenda.
function templateEmailReciboLoja(nomeCliente, nomeLoja, itens, valorTotal, metodo, referencia, dataPagamento) {
  const primeiroNome = escaparHtml(String(nomeCliente || '').trim().split(' ')[0] || '');
  const saudacao = primeiroNome ? `Olá, ${primeiroNome}.` : 'Olá.';
  const loja = escaparHtml(nomeLoja || 'a loja');
  const valorFormatado = escaparHtml(Number(valorTotal || 0).toLocaleString('pt-PT') + ' MZN');
  const metodoFormatado = escaparHtml(formatarMetodoPagamento(metodo));
  const referenciaFormatada = escaparHtml(String(referencia || '-'));
  const dataFormatada = escaparHtml(formatarDataPt(dataPagamento));

  const linhasItens = (Array.isArray(itens) ? itens : []).map(item => {
    const nomeItem = escaparHtml(item.nome || '');
    const qtd = Number(item.quantidade || 1);
    const precoUnit = Number(item.preco_unitario || 0);
    const subtotal = escaparHtml((precoUnit * qtd).toLocaleString('pt-PT') + ' MZN');
    return `<tr>
<td style="padding:10px 0;border-bottom:1px solid #EAE2F2;color:#1A0A27;font-size:13.5px;">${nomeItem} <span style="color:#9A8CAB;">x${qtd}</span></td>
<td style="padding:10px 0;border-bottom:1px solid #EAE2F2;color:#1A0A27;font-size:13.5px;font-weight:700;text-align:right;">${subtotal}</td>
</tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Recibo de compra - ${loja}</title>
</head>
<body style="margin:0;padding:0;background:#F4F0F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F0F8;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:460px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #EAE2F2;">
<tr>
<td bgcolor="#430960" style="background:#430960;background-image:linear-gradient(135deg,#5A0F80 0%,#2E0644 100%);padding:28px 32px 24px 32px;text-align:center;border-bottom:4px solid #89C804;">
<span style="display:inline-block;color:#ffffff;font-size:19px;font-weight:700;letter-spacing:-0.02em;">${loja}</span>
</td>
</tr>
<tr>
<td style="padding:36px 32px 28px 32px;">
<p style="margin:0 0 4px 0;color:#1A0A27;font-size:18px;font-weight:700;">${saudacao}</p>
<p style="margin:0 0 24px 0;color:#6F5E81;font-size:14px;line-height:1.6;">Obrigado pela tua compra. Aqui está o recibo, para a tua referência.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
${linhasItens}
<tr>
<td style="padding:14px 0 0 0;color:#1A0A27;font-size:15px;font-weight:800;">Total</td>
<td style="padding:14px 0 0 0;color:#1A0A27;font-size:15px;font-weight:800;text-align:right;">${valorFormatado}</td>
</tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F2FB;border:1px solid #EAE2F2;border-radius:12px;">
<tr>
<td style="padding:14px 20px;border-bottom:1px solid #EAE2F2;">
<span style="display:block;color:#9A8CAB;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;">Método</span>
<span style="display:block;color:#1A0A27;font-size:14px;font-weight:700;">${metodoFormatado}</span>
</td>
</tr>
<tr>
<td style="padding:14px 20px;border-bottom:1px solid #EAE2F2;">
<span style="display:block;color:#9A8CAB;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;">Referência</span>
<span style="display:block;color:#1A0A27;font-size:14px;font-weight:700;">${referenciaFormatada}</span>
</td>
</tr>
<tr>
<td style="padding:14px 20px;">
<span style="display:block;color:#9A8CAB;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;">Data</span>
<span style="display:block;color:#1A0A27;font-size:14px;font-weight:700;">${dataFormatada}</span>
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td style="padding:18px 32px;background:#FAF8FC;border-top:1px solid #EAE2F2;text-align:center;">
<p style="margin:0;color:#B3A7C2;font-size:11.5px;">Enviado via Daniel IA · daniel-ia.pro</p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Email formatado (HTML com estilos inline) - avisa que um plano pago
// está prestes a expirar, para a pessoa renovar antes de perder acesso.
function templateEmailAvisoExpiracao(nome, nomePlano, dataExpira, diasRestantes) {
  const primeiroNome = escaparHtml(String(nome || '').trim().split(' ')[0] || '');
  const saudacao = primeiroNome ? `Olá, ${primeiroNome}.` : 'Olá.';
  const plano = escaparHtml(nomePlano || 'o teu plano');
  const dataFormatada = escaparHtml(formatarDataPt(dataExpira));
  const fraseDias = diasRestantes <= 0
    ? 'expira hoje'
    : diasRestantes === 1
      ? 'expira amanhã'
      : `expira daqui a ${diasRestantes} dias`;
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>O teu plano está a expirar - Daniel IA</title>
</head>
<body style="margin:0;padding:0;background:#F4F0F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F0F8;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:460px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #EAE2F2;">
<tr>
<td bgcolor="#430960" style="background:#430960;background-image:linear-gradient(135deg,#5A0F80 0%,#2E0644 100%);padding:28px 32px 24px 32px;text-align:center;border-bottom:4px solid #89C804;">
<img src="https://app.daniel-ia.pro/marca/daniel-ia-logo-email.png" width="168" alt="Daniel IA" style="display:inline-block;width:168px;max-width:100%;height:auto;border:0;outline:none;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;">
</td>
</tr>
<tr>
<td style="padding:36px 32px 28px 32px;">
<p style="margin:0 0 4px 0;color:#1A0A27;font-size:18px;font-weight:700;">${saudacao}</p>
<p style="margin:0 0 24px 0;color:#6F5E81;font-size:14px;line-height:1.6;">O teu plano <strong>${plano}</strong> ${fraseDias}. Renova antes dessa data para não perderes o acesso às funcionalidades pagas.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF8EB;border:1px solid #F2DFAF;border-radius:12px;">
<tr>
<td style="padding:18px 20px;">
<span style="display:block;color:#A66A00;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Data de expiração</span>
<span style="display:block;color:#7A4E00;font-size:16px;font-weight:700;">${dataFormatada}</span>
</td>
</tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
<tr><td align="center">
<a href="${PLANOS_URL}" style="display:inline-block;background:#89C804;color:#1A0A27;font-weight:800;text-decoration:none;font-size:14px;font-weight:600;padding:13px 28px;border-radius:10px;">Renovar agora</a>
</td></tr>
</table>
</td>
</tr>
<tr>
<td style="padding:18px 32px;background:#FAF8FC;border-top:1px solid #EAE2F2;text-align:center;">
<p style="margin:0;color:#B3A7C2;font-size:11.5px;">Daniel IA · daniel-ia.pro</p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ======================================================
// Helpers - Bunny Storage
// ======================================================

async function uploadParaBunny(caminho, buffer, contentType) {
  const url = `https://${STORAGE_HOST}/${STORAGE_ZONE}/${caminho}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      AccessKey: STORAGE_PASSWORD,
      'Content-Type': contentType || 'application/octet-stream'
    },
    body: buffer
  });
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error('Upload para o Bunny falhou: ' + res.status + ' ' + texto);
  }
  // A Pull Zone não está ligada directamente à raiz da storage zone, por
  // isso o caminho servido pela CDN tem de incluir o nome da zona
  // (confirmado a testar: só funcionou com /daniel-ia/ no meio do URL).
  return `https://${CDN_HOST}/${STORAGE_ZONE}/${caminho}`;
}

// ======================================================
// Helpers - API da Bunny (usados pela secção de domínio personalizado abaixo)
// ======================================================

let bunnyStorageZoneIdCache = null;

async function bunnyApi(metodo, caminho, corpo) {
  const res = await fetch('https://api.bunny.net' + caminho, {
    method: metodo,
    headers: Object.assign(
      { AccessKey: BUNNY_API_KEY },
      corpo ? { 'Content-Type': 'application/json' } : {}
    ),
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const texto = await res.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch (e) { /* resposta vazia, ex: no delete */ }
  if (!res.ok) {
    throw new Error('Bunny API devolveu ' + res.status + ': ' + texto);
  }
  return json;
}

async function obterIdStorageZone() {
  if (bunnyStorageZoneIdCache) return bunnyStorageZoneIdCache;
  const zonas = await bunnyApi('GET', '/storagezone');
  const zona = (zonas || []).find(z => z.Name === STORAGE_ZONE);
  if (!zona) throw new Error('Não encontrei nenhuma storage zone chamada "' + STORAGE_ZONE + '" nesta conta Bunny.');
  bunnyStorageZoneIdCache = zona.Id;
  return zona.Id;
}

// ======================================================
// Domínio personalizado por site
// ======================================================
// Uma Pull Zone nova por domínio, com uma Edge Rule "Change Origin URL" a
// apontar sempre para o endereço público da CDN do site, ligada ao Site
// no Bubble.

// Limpa um texto de domínio escrito pela pessoa: tira espaços, "http(s)://"
// e uma barra final, se vierem por engano.
function limparDominio(valor) {
  return String(valor || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

// Só letras/números/pontos/hífens, pelo menos um ponto no meio - sem ser
// perfeito, chega para rejeitar texto claramente errado (com espaços,
// barras, @, etc.) antes de irmos incomodar a API da Bunny.
function dominioParecevalido(dominio) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(dominio);
}

// Confere se o site existe, pertence a este owner, já está pronto, e se o
// plano actual permite domínio próprio. Partilhado por /dominio-configurar
// e /dominio-cloudflare-auto, que fazem exactamente as mesmas verificações
// antes de mexerem em Pull Zones. Devolve { erro } ou { site }.
async function validarSiteParaDominio(owner, site_id) {
  const site = await bubbleGet('site', site_id);
  if (!site) {
    return { erro: 'Projecto não encontrado.' };
  }
  if (site['Owner'] !== owner) {
    return { erro: 'Este projecto não te pertence.' };
  }
  if (site['Status'] !== 'Pronto' || !site['CDN URL']) {
    return { erro: 'Este projecto ainda não está pronto.' };
  }

  const user = await bubbleGet('user', owner);
  if (!user) {
    return { erro: 'Utilizador não encontrado.' };
  }
  const planId = await garantirPlano(owner, user);
  const plano = planId ? await bubbleGet('plan', planId) : null;
  if (!plano || !plano['Permite Dominio']) {
    return { erro: 'O teu plano actual não inclui domínio próprio. Muda de plano para usares esta funcionalidade.' };
  }

  return { site };
}

// Cria (ou reaproveita) a Pull Zone deste site na Bunny, garante a regra de
// origem certa, e grava tudo no Site. Partilhado por /dominio-configurar e
// /dominio-cloudflare-auto - a única diferença entre as duas rotas é COMO
// o CNAME é criado depois (à mão vs. automaticamente pela Cloudflare).
async function prepararPullZoneDominio(site, site_id, dominioLimpo) {
  // Já tinha uma Pull Zone configurada para este site (ex: a pessoa está
  // a tentar outra vez) - reaproveita em vez de criar outra a mais.
  let pullZoneId = site['Dominio Pull Zone Id'];
  let hostnameCdn = site['Dominio Hostname'];
  const nomePullZone = 'dominio-' + site_id;

  if (!pullZoneId) {
    const storageZoneId = await obterIdStorageZone();

    let pullZone;
    try {
      pullZone = await bunnyApi('POST', '/pullzone', {
        Name: nomePullZone,
        OriginType: 2,
        StorageZoneId: storageZoneId
      });
    } catch (erroCriar) {
      // Já existe uma Pull Zone com este nome - provavelmente um pedido
      // duplicado (ex: reenvio automático) chegou a criá-la mesmo agora.
      // Em vez de falhar, vamos buscá-la e continuar a partir dela.
      if (String(erroCriar && erroCriar.message || '').includes('name_taken')) {
        const resultadoBusca = await bunnyApi('GET', '/pullzone?search=' + encodeURIComponent(nomePullZone) + '&perPage=20');
        const listaZonas = (resultadoBusca && resultadoBusca.Items) || (Array.isArray(resultadoBusca) ? resultadoBusca : []);
        pullZone = listaZonas.find(z => z.Name === nomePullZone);
        if (!pullZone) throw erroCriar;
      } else {
        throw erroCriar;
      }
    }

    pullZoneId = pullZone.Id;
    hostnameCdn = (pullZone.Hostnames && pullZone.Hostnames[0] && pullZone.Hostnames[0].Value) || null;
    if (!hostnameCdn) {
      throw new Error('A Pull Zone foi criada mas a Bunny não devolveu nenhum endereço .b-cdn.net.');
    }
  }

  // Garante sempre a regra certa a apontar para este site - mesmo que a
  // Pull Zone já existisse de uma tentativa anterior (addOrUpdate é
  // seguro de repetir, não cria regras a mais).
  await bunnyApi('POST', '/pullzone/' + pullZoneId + '/edgerules/addOrUpdate', {
    ActionType: 2, // Change Origin URL
    ActionParameter1: site['CDN URL'],
    Triggers: [{ Type: 0, PatternMatches: ['*'], PatternMatchingType: 0 }],
    TriggerMatchingType: 0,
    Enabled: true,
    OrderIndex: 0,
    Description: 'Domínio personalizado - sempre este site'
  });

  await bubblePatch('site', site_id, {
    'Dominio Personalizado': dominioLimpo,
    'Dominio Pull Zone Id': String(pullZoneId),
    'Dominio Hostname': hostnameCdn,
    'Dominio Estado': 'Pendente'
  });
  if (siteMultiPagina(site)) {
    await regrasDominioPaginas(Object.assign({}, site, { 'Dominio Pull Zone Id': String(pullZoneId) }))
      .catch(erro => console.error('Regras do domínio (várias páginas):', erro.message || erro));
  }

  return { pullZoneId, hostnameCdn };
}

// Chamada mínima à API da Cloudflare, no mesmo espírito do bunnyApi acima -
// o token nunca é guardado em lado nenhum, só é usado nesta chamada e
// descartado logo a seguir.
async function cloudflareApi(metodo, caminho, token, corpo) {
  const res = await fetch('https://api.cloudflare.com/client/v4' + caminho, {
    method: metodo,
    headers: Object.assign(
      { Authorization: 'Bearer ' + token },
      corpo ? { 'Content-Type': 'application/json' } : {}
    ),
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const mensagens = ((json.errors || []).map(e => e.message).join('; ')) || ('Cloudflare API devolveu ' + res.status);
    throw new Error(mensagens);
  }
  return json.result;
}

// Encontra, de entre as zonas a que este token tem acesso, a que corresponde
// ao domínio indicado - tenta o domínio completo primeiro e vai encurtando
// (ex: "loja.exemplo.com" -> "exemplo.com" -> "com"), porque não sabemos à
// partida onde acaba o domínio registável (ex: ".co.mz" é só um sufixo,
// nunca o domínio todo de ninguém).
async function encontrarZonaCloudflare(token, dominioLimpo) {
  const zonas = await cloudflareApi('GET', '/zones?per_page=50', token);
  const partes = dominioLimpo.split('.');
  for (let i = 0; i < partes.length - 1; i++) {
    const candidato = partes.slice(i).join('.');
    const zona = (zonas || []).find(z => z.name === candidato);
    if (zona) return zona;
  }
  return null;
}

// Cria o registo CNAME na Cloudflare - ou, se já existir um com este nome,
// actualiza-o em vez de duplicar. "proxied: false" é propositado: queremos
// DNS apontado directo para a Bunny, nunca a passar pelo proxy da
// Cloudflare (senão o certificado SSL grátis da Bunny deixa de bater certo).
async function criarOuActualizarCnameCloudflare(token, zonaId, nomeRegisto, valorCname) {
  const existentes = await cloudflareApi(
    'GET',
    '/zones/' + zonaId + '/dns_records?type=CNAME&name=' + encodeURIComponent(nomeRegisto),
    token
  );
  const corpo = { type: 'CNAME', name: nomeRegisto, content: valorCname, ttl: 1, proxied: false };
  if (existentes && existentes.length > 0) {
    return await cloudflareApi('PUT', '/zones/' + zonaId + '/dns_records/' + existentes[0].id, token, corpo);
  }
  return await cloudflareApi('POST', '/zones/' + zonaId + '/dns_records', token, corpo);
}

// Passo 1: a pessoa mete o domínio dela e clicamos em "Configurar". Cria a
// Pull Zone e a regra na Bunny, grava tudo no Site, e devolve o hostname
// .b-cdn.net para ela criar o CNAME no sítio onde comprou o domínio.
app.post('/dominio-configurar', async (req, res) => {
  try {
    const { owner, site_id, dominio } = req.body;
    if (!owner || !site_id || !dominio) {
      return res.json({ status: 'error', message: 'Faltam dados: site_id e dominio são obrigatórios.' });
    }
    if (!BUNNY_API_KEY) {
      return res.json({ status: 'error', message: 'A variável BUNNY_API_KEY não está configurada neste container.' });
    }

    const dominioLimpo = limparDominio(dominio);
    if (!dominioParecevalido(dominioLimpo)) {
      return res.json({ status: 'error', message: 'Esse domínio não parece válido. Exemplo do formato esperado: lojamaputo.co.mz' });
    }

    const validacao = await validarSiteParaDominio(owner, site_id);
    if (validacao.erro) {
      return res.json({ status: 'error', message: validacao.erro });
    }

    const { hostnameCdn } = await prepararPullZoneDominio(validacao.site, site_id, dominioLimpo);

    return res.json({
      status: 'success',
      response: {
        dominio: dominioLimpo,
        cname_valor: hostnameCdn,
        instrucao: 'No sítio onde geriste o domínio "' + dominioLimpo + '", cria um registo CNAME com o nome "@" (ou "www", conforme o que quiseres usar) a apontar para "' + hostnameCdn + '". Depois de guardares, volta aqui e clica em Verificar.'
      }
    });

  } catch (erro) {
    console.error('Erro em /dominio-configurar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível configurar o domínio. Tenta novamente.' });
  }
});

// Igual ao /dominio-configurar acima, mas em vez de pedir à pessoa para
// criar o CNAME à mão, usa um token de API da Cloudflare (que ela cola no
// dashboard, "Edit zone DNS", só para essa zona) para criar o registo
// sozinha, e já tenta activar o domínio logo a seguir. O token nunca é
// guardado - só passa por esta chamada e é descartado.
app.post('/dominio-cloudflare-auto', async (req, res) => {
  try {
    const { owner, site_id, dominio, cloudflare_token } = req.body;
    if (!owner || !site_id || !dominio || !cloudflare_token) {
      return res.json({ status: 'error', message: 'Faltam dados: site_id, dominio e o token da Cloudflare são obrigatórios.' });
    }
    if (!BUNNY_API_KEY) {
      return res.json({ status: 'error', message: 'A variável BUNNY_API_KEY não está configurada neste container.' });
    }

    const dominioLimpo = limparDominio(dominio);
    if (!dominioParecevalido(dominioLimpo)) {
      return res.json({ status: 'error', message: 'Esse domínio não parece válido. Exemplo do formato esperado: lojamaputo.co.mz' });
    }

    const validacao = await validarSiteParaDominio(owner, site_id);
    if (validacao.erro) {
      return res.json({ status: 'error', message: validacao.erro });
    }

    const { pullZoneId, hostnameCdn } = await prepararPullZoneDominio(validacao.site, site_id, dominioLimpo);

    let zona;
    try {
      zona = await encontrarZonaCloudflare(cloudflare_token, dominioLimpo);
    } catch (erroZonas) {
      console.error('Erro a listar zonas Cloudflare:', erroZonas);
      return res.json({ status: 'error', message: 'Não consegui ligar à Cloudflare com esse token. Confirma que o copiaste correctamente e que ainda não expirou.' });
    }
    if (!zona) {
      return res.json({ status: 'error', message: 'Não encontrei, nessa conta Cloudflare, nenhuma zona que corresponda a "' + dominioLimpo + '". Confirma que o domínio já está adicionado na Cloudflare e que o token tem acesso a essa zona.' });
    }

    try {
      await criarOuActualizarCnameCloudflare(cloudflare_token, zona.id, dominioLimpo, hostnameCdn);
    } catch (erroRegisto) {
      console.error('Erro a criar registo CNAME na Cloudflare:', erroRegisto);
      return res.json({ status: 'error', message: 'A Cloudflare recusou criar o registo DNS: ' + String(erroRegisto && erroRegisto.message || erroRegisto) });
    }

    // Associar o hostname à Pull Zone e tentar emitir o certificado logo -
    // o DNS da Cloudflare costuma ficar disponível quase de imediato, mas
    // se ainda não tiver propagado isto falha e dizemos para tentar
    // "Verificar" daqui a pouco, exactamente como no fluxo manual.
    try {
      await bunnyApi('POST', '/pullzone/' + pullZoneId + '/addHostname', { Hostname: dominioLimpo });
    } catch (erroHostname) {
      console.error('Erro ao associar hostname em /dominio-cloudflare-auto:', erroHostname);
    }

    try {
      await bunnyApi('GET', '/pullzone/loadFreeCertificate?hostname=' + encodeURIComponent(dominioLimpo));
      await bubblePatch('site', site_id, { 'Dominio Estado': 'Activo' });
      return res.json({
        status: 'success',
        response: {
          dominio: dominioLimpo,
          cname_valor: hostnameCdn,
          activo: true,
          mensagem: 'O domínio "' + dominioLimpo + '" foi ligado automaticamente pela Cloudflare e já está com HTTPS activo.'
        }
      });
    } catch (erroCertificado) {
      console.error('Certificado ainda não emitido em /dominio-cloudflare-auto:', erroCertificado);
      return res.json({
        status: 'success',
        response: {
          dominio: dominioLimpo,
          cname_valor: hostnameCdn,
          activo: false,
          mensagem: 'O registo DNS foi criado na Cloudflare automaticamente. Pode demorar uns minutos a propagar - tenta "Verificar" daqui a pouco.'
        }
      });
    }

  } catch (erro) {
    console.error('Erro em /dominio-cloudflare-auto:', erro);
    return res.json({ status: 'error', message: 'Não foi possível configurar automaticamente. Tenta novamente, ou usa o CNAME manual abaixo.' });
  }
});

// Passo 2: depois de ela ter criado o CNAME lá fora, clica em "Verificar".
// Tentamos ligar o domínio à Pull Zone e activar o certificado SSL grátis -
// isto só funciona mesmo se o CNAME já estiver a apontar correctamente
// (a Bunny valida isso sozinha ao tentar emitir o certificado), por isso
// esta rota pode ser chamada várias vezes sem problema, enquanto a pessoa
// espera o DNS propagar.
app.post('/dominio-verificar', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    if (!owner || !site_id) {
      return res.json({ status: 'error', message: 'Falta o site_id.' });
    }
    if (!BUNNY_API_KEY) {
      return res.json({ status: 'error', message: 'A variável BUNNY_API_KEY não está configurada neste container.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site) {
      return res.json({ status: 'error', message: 'Projecto não encontrado.' });
    }
    if (site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    }
    const pullZoneId = site['Dominio Pull Zone Id'];
    const dominio = site['Dominio Personalizado'];
    if (!pullZoneId || !dominio) {
      return res.json({ status: 'error', message: 'Ainda não configuraste nenhum domínio para este projecto.' });
    }

    // Associar o hostname à Pull Zone - se já estiver associado de uma
    // tentativa anterior, a Bunny não costuma reclamar por repetirmos.
    try {
      await bunnyApi('POST', '/pullzone/' + pullZoneId + '/addHostname', { Hostname: dominio });
    } catch (erroHostname) {
      console.error('Erro ao associar hostname em /dominio-verificar:', erroHostname);
    }

    // Tentar emitir o certificado SSL grátis - isto é que falha mesmo se o
    // CNAME ainda não estiver a apontar bem, por isso é o teste real.
    try {
      await bunnyApi('GET', '/pullzone/loadFreeCertificate?hostname=' + encodeURIComponent(dominio));
    } catch (erroCertificado) {
      console.error('Certificado ainda não emitido em /dominio-verificar:', erroCertificado);
      return res.json({
        status: 'success',
        response: {
          activo: false,
          mensagem: 'O domínio ainda não está a apontar correctamente, ou o DNS ainda não propagou. Isto pode demorar entre alguns minutos a algumas horas depois de criares o CNAME. Tenta "Verificar" outra vez daqui a pouco.'
        }
      });
    }

    await bubblePatch('site', site_id, { 'Dominio Estado': 'Activo' });

    return res.json({
      status: 'success',
      response: {
        activo: true,
        mensagem: 'O domínio "' + dominio + '" já está ligado e com HTTPS activo.'
      }
    });

  } catch (erro) {
    console.error('Erro em /dominio-verificar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível verificar o domínio. Tenta novamente.' });
  }
});

// Limpa a cache da CDN para um URL específico. Usado depois de editar um
// site (reescrevemos o mesmo ficheiro no mesmo caminho) para a pessoa ver
// a alteração de imediato, em vez de continuar a ver a versão antiga até a
// cache expirar sozinha. Se a BUNNY_API_KEY não estiver configurada, não
// falha a edição por causa disso - só avisa na consola do container.
async function purgeCacheBunny(url) {
  if (!BUNNY_API_KEY) {
    console.error('BUNNY_API_KEY não configurada - não foi possível limpar a cache da CDN para ' + url);
    return;
  }
  try {
    const purgeUrl = 'https://api.bunny.net/purge?url=' + encodeURIComponent(url) + '&async=false';
    const res = await fetch(purgeUrl, {
      method: 'POST',
      headers: { AccessKey: BUNNY_API_KEY }
    });
    if (!res.ok) {
      const texto = await res.text().catch(() => '');
      console.error('Purga da cache Bunny falhou: ' + res.status + ' ' + texto);
    }
  } catch (erro) {
    console.error('Erro a tentar purgar a cache Bunny:', erro);
  }
}

// ======================================================
// Helpers - Controlo de espaço (armazenamento)
// ======================================================
// Um só medidor por conta, para tudo o que a pessoa carrega: logótipo,
// fotos de Trabalhos/Posts/Galeria e vídeos da Galeria. Os ficheiros HTML
// dos sites gerados pela IA não entram nesta conta - são pequenos e geridos
// à parte pelo limite de "Sites Limit" do plano.

// Verifica se a conta ainda tem espaço para mais "bytesNovos". Nunca lança
// erro - devolve sempre { ok, message? }, para ser fácil de usar no início
// de cada rota, tal como já fazemos com a verificação de tokens.
async function verificarEspaco(owner, bytesNovos) {
  const user = await bubbleGet('user', owner);
  if (!user) return { ok: false, message: 'Utilizador não encontrado.' };
  const planId = await garantirPlano(owner, user);
  if (!planId) return { ok: false, message: 'A tua conta não tem nenhum plano atribuído, e não encontrei nenhum plano Free para atribuir automaticamente.' };
  const plano = await bubbleGet('plan', planId);
  const usado = user['Storage Used Bytes'] || 0;
  const limite = plano['Storage Limit Bytes'] || 0;
  if (usado + bytesNovos > limite) {
    return { ok: false, message: 'Atingiste o limite de espaço do teu plano. Apaga alguns ficheiros ou muda de plano para continuares a carregar.' };
  }
  return { ok: true };
}

// Soma bytes ao total usado pela conta - chamar só depois de um upload com
// sucesso.
async function somarEspacoUsado(owner, bytes) {
  if (!bytes) return;
  try {
    const user = await bubbleGet('user', owner);
    if (!user) return;
    const usado = user['Storage Used Bytes'] || 0;
    await bubblePatch('user', owner, { 'Storage Used Bytes': usado + bytes });
  } catch (erro) {
    console.error('Erro a somar espaço usado:', erro);
  }
}

// Subtrai bytes do total usado (ficheiro apagado). Nunca deixa ficar
// negativo. Nunca falha a operação de apagar por causa disto - só avisa.
async function subtrairEspacoUsado(owner, bytes) {
  if (!bytes) return;
  try {
    const user = await bubbleGet('user', owner);
    if (!user) return;
    const usado = user['Storage Used Bytes'] || 0;
    await bubblePatch('user', owner, { 'Storage Used Bytes': Math.max(0, usado - bytes) });
  } catch (erro) {
    console.error('Erro a subtrair espaço usado:', erro);
  }
}

// Extrai e sobe para o Bunny uma imagem enviada em base64 (data URL),
// devolvendo o URL da CDN já pronto para guardar. Usado nos Trabalhos do
// Portefólio, nos Posts do Blog e nas fotos da Galeria, onde a pessoa
// carrega a imagem a sério em vez de colar um link. Verifica sempre o
// espaço disponível antes de subir, e soma o espaço usado depois.
// Devolve { url, erro } - url vem vazio e erro preenchido tanto quando o
// texto não é uma imagem base64 válida como quando não há espaço.
async function uploadImagemBase64(pasta, owner, dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return { url: '', erro: '' };
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');

  const espaco = await verificarEspaco(owner, buffer.length);
  if (!espaco.ok) {
    return { url: '', erro: espaco.message };
  }

  const extensao = mime.split('/')[1].replace('+xml', '').replace('jpeg', 'jpg');
  const caminho = `${pasta}/${owner}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extensao}`;
  const url = await uploadParaBunny(caminho, buffer, mime);
  await somarEspacoUsado(owner, buffer.length);
  return { url, erro: '', bytes: buffer.length };
}

// Sobe várias imagens em base64 de uma vez só, para anexar a um pedido de
// criação ou edição (ex: fotos de produtos, imagens para a galeria). Uma
// de cada vez, nunca em paralelo - cada chamada a uploadImagemBase64 lê o
// espaço já actualizado pela anterior, por isso o total fica sempre
// correcto mesmo com várias imagens seguidas. Pára logo na primeira que
// falhar (normalmente por falta de espaço) e devolve esse erro - preferível
// a subir só metade das imagens pedidas e não dizer quais ficaram de fora.
// Devolve { urls, erro }.
async function uploadMultiplasImagensBase64(pasta, owner, dataUrls) {
  const urls = [];
  const lista = (dataUrls || []).slice(0, MAX_IMAGENS_POR_PEDIDO);
  for (const dataUrl of lista) {
    const resultado = await uploadImagemBase64(pasta, owner, dataUrl);
    if (resultado.erro) {
      return { urls, erro: resultado.erro };
    }
    if (resultado.url) urls.push(resultado.url);
  }
  return { urls, erro: '' };
}

// ======================================================
// Helpers - Bunny Stream (vídeo da Galeria)
// ======================================================

// Cria o "espaço" do vídeo no Bunny Stream antes do upload - devolve o
// video_id (guid) que depois é usado tanto para autorizar o upload por TUS
// como para consultar o estado da conversão.
async function criarVideoBunnyStream(titulo) {
  const res = await fetch(`https://video.bunnycdn.com/library/${STREAM_LIBRARY}/videos`, {
    method: 'POST',
    headers: {
      AccessKey: STREAM_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title: titulo || 'video' })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.guid) {
    throw new Error('Não foi possível criar o vídeo no Bunny Stream: ' + JSON.stringify(json));
  }
  return json.guid;
}

// Assinatura exigida pelo Bunny para autorizar um upload por TUS sem expor
// a STREAM_KEY ao browser: sha256(library_id + api_key + expira + video_id).
function assinaturaTusBunny(videoId, expira) {
  const base = STREAM_LIBRARY + STREAM_KEY + expira + videoId;
  return crypto.createHash('sha256').update(base).digest('hex');
}

// Consulta o estado da conversão de um vídeo. Estados do Bunny Stream:
// 0 Criado, 1 Enviado, 2 A processar, 3 A converter, 4 Pronto,
// 5 Erro, 6 Falha no envio.
async function estadoVideoBunnyStream(videoId) {
  const res = await fetch(`https://video.bunnycdn.com/library/${STREAM_LIBRARY}/videos/${videoId}`, {
    headers: { AccessKey: STREAM_KEY }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error('Não foi possível consultar o estado do vídeo: ' + JSON.stringify(json));
  }
  return json;
}

// Apaga um vídeo do Bunny Stream (usado quando a pessoa remove um vídeo da
// galeria). Nunca deixa a remoção do registo falhar por causa disto - só
// avisa na consola se o Bunny recusar.
async function apagarVideoBunnyStream(videoId) {
  try {
    await fetch(`https://video.bunnycdn.com/library/${STREAM_LIBRARY}/videos/${videoId}`, {
      method: 'DELETE',
      headers: { AccessKey: STREAM_KEY }
    });
  } catch (erro) {
    console.error('Erro a apagar vídeo do Bunny Stream:', erro);
  }
}

// ======================================================
// Helper - MozPayment
// ======================================================
// Confirmado a testar: o login devolve
//   { status: 'success', response: { token, user_id, expires } }
// onde "expires" vem em segundos (1 ano, na prática não expira).
// Por isso guardamos o token em memória e só voltamos a fazer login
// quando ele estiver perto de expirar (ou ainda não tivermos nenhum).

async function mozpaymentLogin() {
  if (!MOZPAYMENT_EMAIL || !MOZPAYMENT_SENHA) {
    throw new Error('Faltam as variáveis MOZPAYMENT_EMAIL / MOZPAYMENT_SENHA no container.');
  }
  const res = await fetch('https://mozpayment.co.mz/api/1.1/wf/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: MOZPAYMENT_EMAIL, senha: MOZPAYMENT_SENHA })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error('Login na MozPayment falhou: ' + res.status + ' ' + JSON.stringify(json));
  }
  return json;
}

// Cache do token em memória (apaga-se se o container reiniciar, mas aí
// basta fazer login outra vez automaticamente - sem problema).
let mozTokenCache = { token: '', expiraEm: 0 };

async function mozpaymentToken() {
  const agora = Date.now();
  // Margem de segurança de 1 dia antes do fim real do prazo.
  if (mozTokenCache.token && agora < mozTokenCache.expiraEm - 86400000) {
    return mozTokenCache.token;
  }
  const login = await mozpaymentLogin();
  const token = login && login.response && login.response.token;
  if (!token) {
    throw new Error('A MozPayment não devolveu nenhum token no login: ' + JSON.stringify(login));
  }
  const expiresSegundos = (login.response && login.response.expires) || 3600;
  mozTokenCache = { token, expiraEm: agora + expiresSegundos * 1000 };
  return token;
}

// ======================================================
// Helper - OpenAI
// ======================================================

// ======================================================
// Direcção de arte - padrão de qualidade visual de TODOS os sites gerados
// ======================================================
// Regra da casa (14/10/2026): nada do que a plataforma gera pode ter ar de
// template genérico. Cada site tem de parecer desenhado por um estúdio,
// com uma identidade própria tirada do próprio negócio. Este bloco entra no
// pedido à IA tanto na criação como na edição.
//
// As fichas --dia-* no :root são o que liga o site aos módulos automáticos
// (produtos/carrinho, galeria, portefólio, blog, contacto): esses módulos
// lêem estas variáveis e ficam com as cores, tipos e cantos do próprio
// site, em vez de aparecerem com um visual à parte.
// ======================================================
// Idioma dos sites gerados: pt (por omissão), en, fr ou es
// ======================================================
// O idioma escolhido fica gravado no próprio HTML, em <html lang="..">.
// Os módulos fixos (loja, galeria, portefólio, blog, contacto) e o selo
// lêem esse atributo e mostram os seus textos no mesmo idioma - assim não
// precisamos de nenhum campo novo no Bubble.
const IDIOMAS_SITE = {
  pt: { nome: 'português', instrucao: 'Todo o texto do site é em português de Moçambique (tom local mas correcto), mesmo que a descrição tenha sido escrita noutra língua.' },
  en: { nome: 'inglês', instrucao: 'All text on the website must be in natural, fluent English (the person may have written the description in another language - translate the meaning, do not leave any other language on the page). Prices stay in MZN.' },
  fr: { nome: 'francês', instrucao: "Tout le texte du site doit être en français naturel et soigné (la personne a peut-être écrit la description dans une autre langue - traduis le sens, ne laisse aucun mot d'une autre langue sur la page). Les prix restent en MZN." },
  es: { nome: 'espanhol', instrucao: 'Todo el texto del sitio debe estar en español natural y cuidado (la persona puede haber escrito la descripción en otro idioma - traduce el sentido, no dejes palabras de otro idioma en la página). Los precios se mantienen en MZN.' }
};
function normalizarIdioma(v) {
  const l = String(v || '').toLowerCase().slice(0, 2);
  return IDIOMAS_SITE[l] ? l : 'pt';
}
function idiomaDoHtml(html) {
  const m = /<html[^>]*\slang=["']?([a-zA-Z]{2})/i.exec(html || '');
  return m && IDIOMAS_SITE[m[1].toLowerCase()] ? m[1].toLowerCase() : '';
}
function fixarIdiomaHtml(html, idioma) {
  const l = normalizarIdioma(idioma);
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b([^>]*)>/i, (tudo, attrs) => {
      const semLang = attrs.replace(/\slang=("[^"]*"|'[^']*'|[^\s>]+)/i, '');
      return '<html lang="' + l + '"' + semLang + '>';
    });
  }
  return html;
}

const DIRECAO_DE_ARTE = `
PADRÃO VISUAL (obrigatório - nenhum site pode parecer um modelo repetido nem ter ar de "feito por IA"):
0. A DESCRIÇÃO DA PESSOA MANDA. Lê-a com atenção antes de tudo e segue o que ela pede sobre estilo, cores, ambiente, quantidade de secções e tom. Se pedir algo simples, minimalista, limpo ou "só o essencial", faz um site simples a sério: poucas secções, muito espaço, uma ou duas cores, tipografia limpa - simples mas acabado com cuidado, nunca pobre. Se pedir algo ousado, colorido, divertido, escuro, clássico, luxuoso ou futurista, vai a fundo nessa direcção. Se der cores, referências ou um exemplo, usa-os. Só quando a descrição não disser nada sobre o visual é que decides tu, a partir do negócio e do público.
1. Nada de receitas por sector. Um fotógrafo não tem de ser preto e dourado, um restaurante não tem de ser castanho, uma clínica não tem de ser azul e branco. Evita o primeiro clichê que vem à cabeça para aquele sector. Dois sites do mesmo tipo de negócio com descrições diferentes têm de sair claramente diferentes: estrutura, cores, letras e composição.
2. Direcção de arte própria. Decide uma identidade e compromete-te com ela em todo o site (por exemplo: claro e arejado, editorial de revista, minimal suíço, artesanal e orgânico, tropical vibrante, luxo escuro, cinematográfico, tecnológico, retro, brutalista colorido, lúdico e arredondado).
3. Tipografia com personalidade. Usa duas fontes do Google Fonts que combinem (uma de títulos com carácter, uma de texto muito legível), carregadas no <head>, escolhidas para esta identidade - não repitas sempre as mesmas. Títulos com tamanho fluido (clamp), boa hierarquia e espaçamento de letras ajustado. Nunca só Arial/Helvetica/sistema.
4. Paleta intencional. Uma cor dominante, uma cor de destaque e neutros afinados, tirados da descrição, do negócio ou do logótipo, se existir. Contraste de texto sempre legível (nível AA). Evita o degradê roxo-azul genérico, a não ser que a pessoa o peça.
5. Composição com ritmo. A estrutura e a ordem das secções saem da descrição e do negócio, não de um molde fixo. Hero memorável e à medida (pode ser só tipográfico, de ecrã inteiro, dividido, em mosaico, minimalista...), nunca um bloco centrado banal. Varia as secções: largura total, grelhas assimétricas, sobreposições, números ou palavras gigantes, faixas de cor, cartões. Não empilhes secções todas iguais e centradas.
6. Detalhe e acabamento. Ícones em SVG inline desenhados por ti (nunca emojis como ícones). Estados de hover e foco em botões, links e cartões. Transições suaves e revelação das secções ao fazer scroll (IntersectionObserver), respeitando prefers-reduced-motion - num site simples, movimento discreto. Texturas, formas, padrões ou ilustrações em SVG/CSS só quando servirem a identidade. Cantos, sombras e espaçamentos consistentes.
7. Imagens. Usa as imagens que a pessoa forneceu. Nunca inventes URLs de imagens externas (ficam partidas). Quando faltarem imagens, cria composições bonitas em CSS/SVG (formas, degradês, padrões, ilustrações simples) em vez de caixas cinzentas vazias.
8. Telemóvel primeiro (OBRIGATÓRIO). A maioria dos clientes vê no telemóvel: o site tem de ficar impecável a 360px, 768px e 1280px de largura. Regras: escreve o CSS a pensar primeiro no telemóvel e usa @media (min-width:...) para ecrãs maiores; títulos com clamp() que nunca passem de 11vw no telemóvel; grelhas e colunas viram 1 coluna (ou 2 cartões pequenos) abaixo de 640px; nenhuma largura fixa maior que o ecrã (usa max-width:100% e minmax(0,1fr)); imagens com max-width:100% e height:auto; menu próprio para telemóvel (botão de 3 linhas que abre e fecha de verdade, com JavaScript); botões e links fáceis de tocar (mínimo 44px de altura); espaçamentos laterais de 16 a 20px no telemóvel; textos com pelo menos 15px; nada a sair do ecrã nem barra de deslocamento horizontal; elementos decorativos posicionados de forma absoluta escondidos ou reduzidos no telemóvel.
9. Fichas de tema obrigatórias. No CSS, dentro de :root, define SEMPRE estas variáveis com os valores da tua paleta (os sistemas automáticos do site - produtos, carrinho, galeria, portefólio, blog e contacto - usam-nas para ficarem com o mesmo visual do resto do site):
   --dia-primaria (cor dos botões principais), --dia-primaria-texto (texto em cima da primária, com bom contraste), --dia-fundo (fundo da página), --dia-superficie (fundo de cartões), --dia-texto (texto principal), --dia-texto-suave (texto secundário), --dia-borda (linhas e bordas), --dia-raio (raio dos cantos: 0px para um visual recto e editorial, 4 a 10px para sóbrio, 16px ou mais para arredondado e amigável), --dia-fonte-titulos e --dia-fonte-texto (as famílias de letra que escolheste).
Antes de responder, revê o resultado como um director de arte exigente: confirma que respeita o que a pessoa descreveu (se pediu simples, não carregues; se pediu impacto, não fiques tímido) e que não parece genérico, vazio ou desalinhado.`;

// Os modelos de IA tendem a cair sempre no mesmo visual para o mesmo
// sector (ex: fotógrafo = preto e dourado). Quando a pessoa não diz nada
// sobre o estilo, sorteamos um ponto de partida diferente em cada geração,
// para que dois sites parecidos no pedido não saiam iguais. Se a descrição
// falar do visual, a IA ignora o sorteio.
const ESTILOS_SORTEIO = [
  'claro e arejado: fundo quase branco, muito espaço, tipografia fina e elegante',
  'editorial de revista: títulos serifados enormes, grelha assimétrica, legendas pequenas',
  'cores vivas em blocos sólidos, letras grossas e confiantes',
  'escuro e cinematográfico, contraste forte, uma cor de destaque intensa',
  'minimal suíço: grelha rígida, uma só cor de destaque, tipografia sem serifa',
  'quente e artesanal: tons de terra, texturas suaves, formas orgânicas',
  'lúdico e arredondado: cores alegres, cantos muito redondos, formas soltas',
  'tecnológico: linhas finas, pormenores em letra monoespaçada, detalhes geométricos',
  'retro anos 70: cores quentes, formas redondas, títulos com carácter',
  'brutalista colorido: bordas grossas, sombras duras, cores directas',
  'tropical moçambicano: cores do mar, da areia e da natureza, padrões inspirados em capulanas',
  'pastel suave e sereno: tons calmos, muito espaço, detalhes delicados'
];
const HEROS_SORTEIO = [
  'composição a ocupar o ecrã inteiro com o título por cima',
  'só tipografia: título gigante, sem imagem',
  'ecrã dividido em duas colunas assimétricas',
  'mosaico de formas ou imagens com o título encaixado no meio',
  'minimalista: título discreto e muito espaço à volta',
  'título com uma faixa de texto em movimento por baixo'
];
function sortear(lista) {
  return lista[Math.floor(Math.random() * lista.length)];
}

// ======================================================
// Estúdio de layouts (1.55.0): 3 versões do mesmo site, cada uma com uma
// direcção de arte própria, geradas em paralelo. A pessoa compara e
// escolhe; só o escolhido conta nos tokens do plano dela.
// Cada família garante contraste entre as 3: uma clara, uma escura ou
// intensa, uma vibrante.
// ======================================================
const DIRECOES_LAYOUT = {
  claro: [
    { id: 'editorial', nome: 'Editorial', resumo: 'Revista elegante, títulos grandes e muito espaço',
      prompt: 'editorial de revista: fundo claro (branco-papel ou creme), títulos serifados enormes com carácter, grelha assimétrica, legendas pequenas em maiúsculas espaçadas, linhas finas a separar secções, composições grandes e números de secção' },
    { id: 'suico', nome: 'Minimal suíço', resumo: 'Grelha rigorosa, uma cor forte, nada a mais',
      prompt: 'minimal suíço: fundo branco, grelha rígida e visível no alinhamento, uma só cor de destaque forte e saturada, tipografia sem serifa geométrica em pesos contrastantes, muito espaço negativo, sem sombras' },
    { id: 'sereno', nome: 'Sereno', resumo: 'Tons suaves, curvas leves e muita calma',
      prompt: 'pastel sereno: fundo claro com tons suaves (salva, areia, lavanda ou pêssego), cantos muito arredondados, tipografia elegante e leve, formas orgânicas desfocadas em fundo, ritmo calmo' },
    { id: 'luminoso', nome: 'Luminoso', resumo: 'Claro, fresco e com um brilho de cor',
      prompt: 'claro e luminoso: fundo quase branco, um degradê suave e fresco como acento, cartões flutuantes com sombras longas e leves, tipografia moderna com títulos pesados, detalhes em vidro (backdrop-filter)' }
  ],
  escuro: [
    { id: 'cinema', nome: 'Cinematográfico', resumo: 'Escuro, contraste forte e um brilho de cor',
      prompt: 'escuro e cinematográfico: fundo quase preto, contraste forte, uma única cor de destaque intensa que brilha, títulos enormes e condensados, secções de ecrã inteiro, revelações dramáticas ao fazer scroll' },
    { id: 'luxo', nome: 'Luxo nocturno', resumo: 'Profundo, sofisticado, detalhes metálicos',
      prompt: 'luxo nocturno: fundos profundos (preto-azulado, verde-garrafa ou bordeaux muito escuro), detalhes metálicos discretos (dourado, champanhe ou cobre), serifas finas e altas, muito espaço, linhas finíssimas, ritmo lento e sofisticado' },
    { id: 'tecno', nome: 'Tecnológico', resumo: 'Linhas finas, grelhas e detalhes de código',
      prompt: 'tecnológico: fundo escuro com grelha subtil, linhas finas, pormenores em letra monoespaçada (etiquetas, números, coordenadas), uma cor néon de destaque, cartões com bordas de 1px e brilho nas arestas' }
  ],
  vibrante: [
    { id: 'blocos', nome: 'Blocos de cor', resumo: 'Cores sólidas, letras grossas e confiança',
      prompt: 'blocos de cor: secções em cores sólidas e saturadas que alternam, letras grossas e confiantes, botões grandes, composição em blocos rectangulares, alto contraste' },
    { id: 'brutal', nome: 'Brutalista', resumo: 'Bordas grossas, sombras duras e atitude',
      prompt: 'brutalista colorido: bordas pretas grossas, sombras duras deslocadas (sem desfoque), cores directas, tipografia pesada, elementos ligeiramente rodados, autocolantes e etiquetas' },
    { id: 'tropical', nome: 'Tropical', resumo: 'Mar, areia e padrões de capulana',
      prompt: 'tropical moçambicano: cores do mar, da areia, do sol e da natureza, padrões geométricos inspirados em capulanas desenhados em SVG, formas onduladas entre secções, energia quente e acolhedora' },
    { id: 'ludico', nome: 'Lúdico', resumo: 'Alegre, redondo e cheio de energia',
      prompt: 'lúdico e arredondado: cores alegres, cantos muito redondos, formas soltas e flutuantes, tipografia redonda e amigável, pequenos movimentos divertidos' },
    { id: 'retro', nome: 'Retro 70', resumo: 'Calor, curvas e títulos com carácter',
      prompt: 'retro anos 70: laranjas, castanhos, mostarda e creme, formas redondas e faixas curvas, títulos com muito carácter (serifa gorda ou display arredondada), grão subtil' },
    { id: 'artesanal', nome: 'Artesanal', resumo: 'Tons de terra, texturas e formas orgânicas',
      prompt: 'quente e artesanal: tons de terra, texturas suaves (papel, grão), formas orgânicas desenhadas à mão em SVG, tipografia com carácter humano, sensação de feito com cuidado' }
  ]
};
const ESTRUTURAS_LAYOUT = [
  'estrutura clássica mas refinada: secções bem separadas, ritmo regular e hierarquia clara',
  'grelha "bento": cartões de tamanhos diferentes encaixados, informação em mosaico',
  'narrativa em faixas de largura total que alternam fundo e cor, como capítulos',
  'composição assimétrica: colunas desencontradas, sobreposições e elementos que saem da grelha',
  'escala gigante: números e palavras enormes como elemento gráfico, poucas secções muito fortes'
];
const HEROS_LAYOUT = [
  'hero de ecrã inteiro com o título por cima de uma composição',
  'hero só tipográfico: título gigante, sem imagem',
  'hero dividido em duas colunas assimétricas',
  'hero em mosaico de formas ou imagens com o título encaixado',
  'hero com uma faixa de texto em movimento contínuo'
];
const ESTILOS_CARTAO_LOJA = ['suave', 'moldura', 'minimal'];
// Lojas (1.59.0): as 3 versões de uma loja já não mudam só as cores - cada
// uma recebe um TEMA com uma estrutura de loja própria. O módulo da loja
// (loja-cart.js) lê o tema numa <meta> e monta a capa, as categorias, as
// faixas e os cartões de produto de forma diferente; a IA desenha o
// cabeçalho, as faixas e o rodapé a condizer.
const TEMAS_LOJA = [
  { id: 'mercado', nome: 'Mercado', cartao: 'moldura',
    resumo: 'Marketplace cheio de vida: mosaico de banners, ofertas da semana e categorias em destaque',
    prompt: 'MERCADO (como os grandes marketplaces): cabeçalho em duas linhas - uma barra fina no topo, na cor mais escura da paleta, com uma frase curta de aviso (ex: entrega em todo o país) e, por baixo, a linha principal com o logótipo, um menu curto e um ícone de ajuda/WhatsApp; fundo claro e limpo para os produtos brilharem (a montra automática traz um mosaico de banners, categorias em círculos, uma faixa escura de ofertas da semana e grelhas de 5 produtos); depois da div da loja, uma faixa larga e colorida a convidar a seguir a loja no WhatsApp e nas redes (título forte, texto curto, botão), e um rodapé escuro em 4 colunas.' },
  { id: 'editorial', nome: 'Editorial', cartao: 'minimal',
    resumo: 'Revista de decoração: título gigante, fotos grandes e muito espaço',
    prompt: 'EDITORIAL (como uma revista de decoração ou uma marca de luxo): cabeçalho minimalista numa só linha, com o nome da loja em maiúsculas espaçadas à esquerda e um menu pequeno em maiúsculas à direita, com uma linha fina por baixo; muito espaço vazio e poucas cores (a montra automática abre com um título gigante centrado, filtros discretos e fotos grandes); depois da div da loja, uma secção "sobre" em duas colunas assimétricas com um título GIGANTE em maiúsculas à esquerda (2 a 4 palavras sobre a marca) e um parágrafo curto à direita com um botão discreto; rodapé com o nome da loja enorme, a ocupar a largura toda.' },
  { id: 'tech', nome: 'Tecnologia', cartao: 'suave',
    resumo: 'Arrumado e eficiente: barra de cor, categorias com ícones e filas de produtos',
    prompt: 'TECNOLOGIA (como as grandes lojas de electrónica): por cima, uma linha fina com contactos; por baixo, uma barra de navegação sólida na cor primária com o logótipo, o menu e o telefone de apoio; visual arrumado e eficiente, cantos médios (a montra automática traz uma capa dividida com um produto em destaque, categorias em quadrados e filas de produtos); depois da div da loja, uma faixa com 4 garantias em linha (ícone SVG + título + frase curta) e um rodapé claro em colunas com contactos e redes.' },
  { id: 'moda', nome: 'Moda', cartao: 'minimal',
    resumo: 'Jovem e atrevido: letras pesadas, faixas de cor e fotos ao alto',
    prompt: 'MODA (como uma marca jovem de roupa e estilo): cabeçalho leve com o logótipo em letras pesadas e um botão em forma de pílula; tipografia display muito grossa e confiante, uma cor de destaque forte e alegre (a montra automática traz uma capa tipográfica enorme, uma faixa de categorias em movimento e fotos de produto ao alto); depois da div da loja, uma faixa grande na cor de destaque a convidar para a comunidade (título ENORME em maiúsculas, texto curto, botão preto) e um rodapé preto.' },
  { id: 'catalogo', nome: 'Catálogo', cartao: 'suave',
    resumo: 'Loja grande com filtros ao lado: categorias, preço, avaliação e ordenar',
    prompt: 'CATÁLOGO (como as lojas grandes com filtros ao lado): por cima, uma linha fina com telefone e email; por baixo, o cabeçalho com o logótipo, o menu (Início, Loja, Contacto) e ícones; logo a seguir, uma faixa clara e baixa com o título da página centrado (ex: "Loja") e o caminho "Início / Loja" em letra pequena (a montra automática traz um banner de promoção, filtros na coluna da esquerda - categorias, preço, avaliação - e a grelha de produtos com ordenar e vista em lista); depois da div da loja, uma faixa com 3 vantagens em linha (entrega, pagamento seguro, apoio) com ícones, uma faixa curta de newsletter ou WhatsApp e um rodapé claro em 4 colunas.' },
  { id: 'vitrine', nome: 'Vitrine', cartao: 'minimal',
    resumo: 'Um produto de cada vez em grande, com o preço ao lado e miniaturas para trocar',
    prompt: 'VITRINE (como uma marca que mostra cada produto como uma peça única): cabeçalho em três blocos - à esquerda um quadrado na cor escura com o ícone do menu, ao centro o logótipo em letra elegante ou manuscrita sobre um fundo cinzento muito claro, à direita um quadrado na cor de destaque; muito branco, linhas finas e poucas cores (a montra automática mostra um produto enorme ao centro, o preço num cartão escuro ao lado, miniaturas para trocar de produto e uma faixa escura "Preços desde"); depois da div da loja, um rodapé claro e minimal com links em duas colunas e os ícones das redes à direita.' },
  { id: 'bento', nome: 'Bento', cartao: 'suave',
    resumo: 'Mosaico colorido em tons pastel, cantos muito redondos e muita alegria',
    prompt: 'BENTO PASTEL (como uma loja criativa de design): fundo claro com formas orgânicas desfocadas em tons pastel (pêssego, menta, lilás, manteiga), cabeçalho com o logótipo e o menu em pílulas (botões redondos de fundo branco), uma cor de destaque alegre (laranja, coral ou turquesa) e cantos muito redondos em tudo (a montra automática traz um mosaico de cartões pastel de tamanhos diferentes, categorias em pílulas e produtos sobre fundos pastel); depois da div da loja, uma faixa curta de newsletter em forma de pílula e um rodapé leve.' },
  { id: 'fresco', nome: 'Fresco', cartao: 'suave', nicho: /mercearia|supermercad|minimercad|frut|legum|verdur|horta|org[aâ]nic|talho|carne|peixe|padaria|\bp[aã](o|es)\b|bebida|grocery|cesta|agro|hortifruti|cantina/i,
    resumo: 'Mercearia e supermercado: capa com oferta, selo de desconto e botão Adicionar em cada produto',
    prompt: 'FRESCO (como os supermercados e mercearias online modernos): por cima, uma barra fina na cor primária com uma frase de entrega (ex: entrega no mesmo dia em Maputo); por baixo, o cabeçalho branco com o logótipo, uma caixa de pesquisa larga com cantos redondos ao centro, e à direita o telefone/WhatsApp e o carrinho; uma cor primária fresca (verde-folha, laranja ou vermelho-tomate) sobre fundos muito claros, cantos médios, ícones de linha (a montra automática traz uma capa dividida com a oferta da semana e um selo de desconto, categorias em cartões com foto, uma fila "Melhores ofertas" e cartões de produto com o botão Adicionar a toda a largura); depois da div da loja, uma faixa em 4 colunas com vantagens (entrega rápida, produtos frescos, pagamento M-Pesa/e-Mola, apoio no WhatsApp) com ícones SVG, uma faixa colorida a convidar para o WhatsApp com as ofertas da semana e um rodapé claro em 4 colunas com horário de funcionamento.' },
  { id: 'sabor', nome: 'Sabor', cartao: 'suave', nicho: /restaura|comida|refei[cç]|pizza|hamb[uú]rg|burger|lanch|takeaway|take-away|entrega de comida|caf[eé]|pastelaria|bolo|doce|churrasc|grelhad|frango|marisco|sushi|\bchef\b|snack|\bbar\b|\bpetiscos?\b/i,
    resumo: 'Restaurante e comida: capa escura e quente, prato em destaque e os mais pedidos',
    prompt: 'SABOR (como os restaurantes e marcas de comida com encomenda online): cabeçalho escuro e quente (castanho-café, quase preto) com o logótipo à esquerda, o menu ao centro em letras claras e, à direita, um botão em forma de pílula na cor de destaque "Encomendar" e o telefone; uma cor de destaque apetitosa (laranja, vermelho-tomate ou amarelo-mostarda), títulos com uma palavra em letra manuscrita/script na cor de destaque, fotografias de comida grandes e cantos redondos (a montra automática traz uma capa escura com o prato em destaque num círculo, um cartão com o preço, a nota das avaliações, categorias em cartões e a fila "Os mais pedidos"); depois da div da loja, uma faixa com o horário, a zona de entrega e o tempo médio de entrega em 3 colunas com ícones, uma faixa em fundo escuro com uma frase forte e o botão do WhatsApp para encomendar, e um rodapé escuro em 3 colunas com morada, horário e redes.' }
];
function baralhar(lista) {
  const a = lista.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// Os 3 estilos de loja para um negócio: primeiro os que o plano sugeriu,
// depois os de nicho cujo ramo aparece no pedido, e o resto ao acaso.
function temasParaNegocio(texto, sugeridos) {
  const ids = [];
  const juntar = id => { if (id && ids.length < 3 && !ids.includes(id) && TEMAS_LOJA.some(t => t.id === id)) ids.push(id); };
  (Array.isArray(sugeridos) ? sugeridos : []).forEach(juntar);
  TEMAS_LOJA.filter(t => t.nicho && t.nicho.test(String(texto || ''))).forEach(t => juntar(t.id));
  baralhar(TEMAS_LOJA.filter(t => !t.nicho)).forEach(t => juntar(t.id));
  return ids;
}
function aplicarTemasSugeridos(direcoes, ids) {
  direcoes.forEach((d, i) => {
    const t = TEMAS_LOJA.find(x => x.id === ids[i]);
    if (!t) return;
    Object.assign(d, { tema: t.id, temaPrompt: t.prompt, nome: t.nome + ' · ' + (d.nomeBase || d.nome), resumo: t.resumo, cartao: t.cartao });
  });
  return direcoes;
}
function escolherDirecoes(tipo) {
  const familias = baralhar(['claro', 'escuro', 'vibrante']);
  const estruturas = baralhar(ESTRUTURAS_LAYOUT);
  const heros = baralhar(HEROS_LAYOUT);
  // Os estilos de nicho (mercearia, restaurante) só entram quando o negócio
  // é desse ramo - quem decide é temasParaNegocio, depois do plano.
  const temas = tipo === 'E-commerce' ? baralhar(TEMAS_LOJA.filter(t => !t.nicho)) : [];
  return familias.map((f, i) => {
    const d = baralhar(DIRECOES_LAYOUT[f])[0];
    const base = { id: d.id, nome: d.nome, nomeBase: d.nome, resumo: d.resumo, prompt: d.prompt, familia: f, estrutura: estruturas[i], hero: heros[i], cartao: ESTILOS_CARTAO_LOJA[i] };
    const t = temas[i];
    if (t) Object.assign(base, { tema: t.id, temaPrompt: t.prompt, nome: t.nome + ' · ' + d.nome, resumo: t.resumo, cartao: t.cartao });
    return base;
  });
}
function instrucaoDirecao(direcao, outras, tipo) {
  if (direcao.referencia) return instrucaoReferencia(direcao, tipo, false);
  const ehLoja = (tipo === 'E-commerce' || tipo === 'Checkout');
  return `\nVERSÃO ${direcao.n} DE 3: a pessoa vai ver três versões do site lado a lado e escolher uma. Esta versão tem de ser CLARAMENTE diferente das outras - nas cores, nas letras, na composição e no ambiente.
DIRECÇÃO DE ARTE DESTA VERSÃO: ${direcao.prompt}.
${ehLoja ? (direcao.temaPrompt ? `ESTRUTURA DA LOJA NESTA VERSÃO - ${direcao.temaPrompt} As cores e as letras seguem a direcção de arte acima.` : 'ESTRUTURA: é uma loja, por isso a estrutura das secções é a do guia acima. A diferença está no cabeçalho, nas cores, nas letras, na faixa de confiança, no contacto e no rodapé.') : `ESTRUTURA: ${direcao.estrutura}. HERO: ${direcao.hero}.`}
As outras duas versões seguem "${outras.join('" e "')}" - não te aproximes delas.
Se a descrição da pessoa pedir um estilo, cores ou ambiente concretos, isso MANDA: mantém o que ela pediu e usa esta direcção só para variar a composição, a tipografia e o ritmo.`;
}
// ======================================================
// Referência (1.59.0): criar um site ou uma loja PARECIDOS com uma imagem
// ------------------------------------------------------
// A pessoa carrega um print de um site, de uma loja ou de um design. Antes
// de gerar, a IA estuda a imagem (cores, letras, cabeçalho, capa, secções,
// cartões, rodapé) e, nas lojas, escolhe os 3 temas de loja mais
// parecidos. As 3 versões partem todas da imagem, com graus diferentes de
// semelhança: fiel, parecida e inspirada. Copia-se sempre o estilo, nunca o
// conteúdo nem a marca de outra empresa.
// ======================================================
const MAX_REFERENCIA_CHARS = 8 * 1024 * 1024;
const NIVEIS_REFERENCIA = [
  { id: 'fiel', nome: 'Fiel à imagem', resumo: 'O mais parecido possível com a tua imagem' },
  { id: 'parecida', nome: 'Parecida', resumo: 'O mesmo estilo, com outra composição' },
  { id: 'inspirada', nome: 'Inspirada', resumo: 'Parte da tua imagem e dá-lhe um toque novo' }
];
const NIVEL_REFERENCIA_TEXTO = {
  fiel: 'FIEL: o mais parecido possível com a imagem - as mesmas cores (usa os valores da análise nas variáveis --dia-*), o mesmo tipo de letra (ou o mais parecido do Google Fonts), a mesma disposição do cabeçalho, da capa e das secções, as mesmas proporções, cantos, sombras e espaçamentos. Quem puser as duas lado a lado tem de reconhecer o estilo de imediato.',
  parecida: 'PARECIDA: as mesmas cores, o mesmo tipo de letra e o mesmo ambiente da imagem, mas a composição muda um pouco (outra capa, outra ordem das faixas, outro cabeçalho dentro do mesmo espírito). Continua claramente "da mesma família" da imagem.',
  inspirada: 'INSPIRADA: parte da imagem (a paleta, o ambiente e um ou dois pormenores marcantes) e dá-lhe um toque novo - pode trocar a cor de destaque por outra da mesma família, usar outra tipografia que combine e uma composição mais livre. Nota-se a inspiração, mas não é uma cópia.'
};
function referenciaValida(dataUrl) {
  return typeof dataUrl === 'string' && dataUrl.length <= MAX_REFERENCIA_CHARS
    && /^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(dataUrl);
}
function textoCurto(t, max) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, max || 240); }
function limparAnaliseReferencia(o, tipo) {
  o = (o && typeof o === 'object') ? o : {};
  const cor = c => { const v = String(c || '').trim(); return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v.toUpperCase() : ''; };
  const cores = {};
  ['fundo', 'superficie', 'primaria', 'destaque', 'texto'].forEach(k => { const v = cor(o.cores && o.cores[k]); if (v) cores[k] = v; });
  const lista = (l, n, max) => (Array.isArray(l) ? l : []).map(x => textoCurto(x, max)).filter(Boolean).slice(0, n);
  const a = {
    e_site: o.e_site !== false,
    resumo: textoCurto(o.resumo, 220),
    ambiente: ['claro', 'escuro', 'vibrante'].includes(o.ambiente) ? o.ambiente : 'claro',
    cores,
    tipografia: textoCurto(o.tipografia), cantos: textoCurto(o.cantos, 120), cabecalho: textoCurto(o.cabecalho),
    capa: textoCurto(o.capa), produtos: textoCurto(o.produtos), categorias: textoCurto(o.categorias), rodape: textoCurto(o.rodape),
    secoes: lista(o.secoes, 12, 120), detalhes: lista(o.detalhes, 6, 160), temas: []
  };
  if (tipo === 'E-commerce') {
    const ids = TEMAS_LOJA.map(t => t.id);
    const escolhidos = [...new Set((Array.isArray(o.temas) ? o.temas : []).map(x => String(x || '').trim().toLowerCase()).filter(x => ids.includes(x)))];
    baralhar(ids).forEach(id => { if (escolhidos.length < 3 && !escolhidos.includes(id)) escolhidos.push(id); });
    a.temas = escolhidos.slice(0, 3);
  }
  return a;
}
function analiseReferenciaVazia(tipo) { return limparAnaliseReferencia({}, tipo); }
const SISTEMA_REFERENCIA = 'És director de arte e estudas imagens de sites e lojas online para recriar o estilo delas noutra marca. '
  + 'Respondes só com um objecto JSON válido, sem texto à volta.';
async function analisarReferencia(dataUrl, tipo) {
  if (!OPENAI_API_KEY) throw new Error('Sem OPENAI_API_KEY');
  const ehLoja = tipo === 'E-commerce';
  const pedido = [
    'A pessoa quer ' + (ehLoja ? 'uma loja online' : 'um site') + ' PARECIDO com esta imagem: o mesmo estilo, mas com outro negócio, outro nome e outro conteúdo.',
    'Descreve o que é preciso para recriar o ESTILO, não o conteúdo. Nunca copies nomes de marcas, slogans ou textos da imagem.',
    'Escreve em português, frases curtas e concretas (ex: "cabeçalho em 3 blocos: quadrado escuro com o menu à esquerda, logótipo manuscrito ao centro, quadrado azul à direita").',
    'Formato exacto: {"e_site":true,"resumo":"uma frase","ambiente":"claro|escuro|vibrante","cores":{"fundo":"#RRGGBB","superficie":"#RRGGBB","primaria":"#RRGGBB","destaque":"#RRGGBB","texto":"#RRGGBB"},'
      + '"tipografia":"...","cantos":"...","cabecalho":"...","capa":"...","secoes":["de cima para baixo"],"produtos":"como aparecem os produtos ou cartões","categorias":"...","detalhes":["pormenores marcantes"],"rodape":"..."'
      + (ehLoja ? ',"temas":["id","id","id"]' : '') + '}',
    '"e_site": false se a imagem não for um site, uma loja ou um design de página (ex: uma fotografia) - nesse caso descreve só o ambiente e as cores, e deixa as outras chaves vazias.',
    ehLoja ? 'Em "temas", escolhe os 3 temas de loja (ids diferentes) mais parecidos com a imagem, do mais parecido para o menos:\n' + TEMAS_LOJA.map(t => '- ' + t.id + ': ' + t.resumo).join('\n') : ''
  ].filter(Boolean).join('\n');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL_RAPIDO || OPENAI_MODEL,
        reasoning_effort: 'low',
        max_completion_tokens: 5000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SISTEMA_REFERENCIA },
          { role: 'user', content: [{ type: 'text', text: pedido }, { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] }
        ]
      })
    });
    const json = await res.json();
    if (!res.ok) throw new Error('OpenAI falhou: ' + ((json.error && json.error.message) || res.status));
    const texto = String((json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '').trim();
    const m = texto.match(/\{[\s\S]*\}/);
    const analise = limparAnaliseReferencia(JSON.parse(m ? m[0] : texto), tipo);
    return { analise, tokens: (json.usage && json.usage.total_tokens) || 0 };
  } finally {
    clearTimeout(t);
  }
}
// As 3 versões a partir da imagem (analise = null enquanto ainda não foi estudada).
function direcoesDaReferencia(tipo, analise) {
  const familia = (analise && analise.ambiente) || 'claro';
  const estruturas = baralhar(ESTRUTURAS_LAYOUT);
  const heros = baralhar(HEROS_LAYOUT);
  const temas = (tipo === 'E-commerce' && analise && analise.temas && analise.temas.length === 3) ? analise.temas : null;
  return NIVEIS_REFERENCIA.map((nv, i) => {
    const base = { id: 'ref-' + nv.id, nome: nv.nome, resumo: nv.resumo, prompt: '', familia, estrutura: estruturas[i], hero: heros[i],
      cartao: ESTILOS_CARTAO_LOJA[i], referencia: nv.id, analise: analise || null };
    const t = temas && TEMAS_LOJA.find(x => x.id === temas[i]);
    if (t) Object.assign(base, { tema: t.id, temaPrompt: t.prompt, nome: nv.nome + ' · ' + t.nome, cartao: t.cartao });
    return base;
  });
}
function textoAnaliseReferencia(a) {
  if (!a || (!a.resumo && !Object.keys(a.cores || {}).length)) {
    return '- Olha com atenção para a imagem e tira dela as cores, as letras, a disposição, os cantos, as sombras e o ambiente.';
  }
  const linhas = [];
  if (!a.e_site) linhas.push('A imagem não é um site: usa-a só como referência de ambiente e de cores.');
  if (a.resumo) linhas.push('Resumo: ' + a.resumo);
  const c = a.cores || {};
  const cs = ['fundo', 'superficie', 'primaria', 'destaque', 'texto'].filter(k => c[k]).map(k => k + ' ' + c[k]);
  if (cs.length) linhas.push('Cores: ' + cs.join(', '));
  [['tipografia', 'Letras'], ['cantos', 'Cantos'], ['cabecalho', 'Cabeçalho'], ['capa', 'Capa'], ['produtos', 'Produtos e cartões'], ['categorias', 'Categorias'], ['rodape', 'Rodapé']]
    .forEach(([k, n]) => { if (a[k]) linhas.push(n + ': ' + a[k]); });
  if (a.secoes && a.secoes.length) linhas.push('Secções, de cima para baixo: ' + a.secoes.join(' → '));
  if (a.detalhes && a.detalhes.length) linhas.push('Pormenores marcantes: ' + a.detalhes.join('; '));
  return linhas.map(l => '- ' + l).join('\n');
}
function instrucaoReferencia(direcao, tipo, unica) {
  const ehLoja = (tipo === 'E-commerce' || tipo === 'Checkout');
  const nivel = NIVEL_REFERENCIA_TEXTO[direcao.referencia] ? direcao.referencia : 'fiel';
  const cabeca = unica
    ? 'A PESSOA QUER UM SITE PARECIDO COM A IMAGEM DE REFERÊNCIA (é a última imagem do pedido).'
    : `VERSÃO ${direcao.n} DE 3 - A PESSOA QUER UM SITE PARECIDO COM A IMAGEM DE REFERÊNCIA (é a última imagem do pedido). As três versões partem dessa imagem, com graus diferentes de semelhança: fiel, parecida e inspirada.`;
  let estrutura;
  if (ehLoja) {
    estrutura = direcao.temaPrompt
      ? `ESTRUTURA DA LOJA: a montra automática desta versão é a do tema mais parecido com a imagem - ${direcao.temaPrompt} Mas o cabeçalho, as faixas e o rodapé seguem PRIMEIRO a imagem de referência, e as cores e as letras são as da imagem.`
      : 'ESTRUTURA DA LOJA: as secções são as do guia acima; o cabeçalho, as faixas, as cores, as letras e o rodapé seguem a imagem de referência.';
  } else {
    estrutura = nivel === 'fiel' || !direcao.estrutura
      ? 'ESTRUTURA: segue a ordem e a disposição das secções da imagem, adaptadas ao que este negócio precisa.'
      : `ESTRUTURA: ${direcao.estrutura}, dentro do espírito da imagem. HERO: ${direcao.hero}.`;
  }
  return `\n${cabeca}
NÍVEL DESTA VERSÃO - ${NIVEL_REFERENCIA_TEXTO[nivel]}
O QUE A IMAGEM TEM (estudada antes):
${textoAnaliseReferencia(direcao.analise)}
REGRAS DA REFERÊNCIA: copia o ESTILO (cores, letras, disposição, proporções, cantos, sombras, ritmo e ambiente), nunca o CONTEÚDO. Não uses o nome, o logótipo, os textos, os slogans, as fotografias nem a marca da empresa que aparece na imagem - o nome, os textos e a oferta são os do negócio desta pessoa, escritos de raiz. Onde a imagem tem fotografias, usa composições tuas (formas, degradês, ilustrações em SVG) ou as imagens que a pessoa anexou.
${estrutura}
Se a descrição da pessoa pedir algo concreto (cores, secções, tom), isso MANDA sobre a imagem.`;
}
// Paleta e letras de uma versão, lidas das fichas --dia-* do próprio HTML.
function resumoVisual(html) {
  const raiz = (/:root\s*\{([^}]*)\}/i.exec(html) || [])[1] || '';
  const v = nome => { const m = new RegExp('--dia-' + nome + '\\s*:\\s*([^;]+);', 'i').exec(raiz); return m ? m[1].trim() : ''; };
  const cor = c => /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i.test(c) ? c : '';
  const paleta = [v('fundo'), v('superficie'), v('primaria'), v('texto'), v('borda')].map(cor).filter(Boolean);
  const fonte = c => (String(c || '').split(',')[0] || '').replace(/["']/g, '').trim().slice(0, 40);
  const fontes = [fonte(v('fonte-titulos')), fonte(v('fonte-texto'))].filter((f, i, a) => f && !/^(var\(|sans-serif|serif|system)/i.test(f) && a.indexOf(f) === i);
  return { paleta: [...new Set(paleta)].slice(0, 5), fontes };
}
// Loja: cada versão sugere o estilo dos cartões da montra automática.
function marcarEstiloLoja(html, cartao, tema) {
  let meta = `<meta name="daniel-ia-estilo-loja" content="${cartao}">`;
  if (tema && TEMAS_LOJA.some(t => t.id === tema)) meta += `\n<meta name="daniel-ia-tema-loja" content="${tema}">`;
  html = html.replace(/\s*<meta name="daniel-ia-(estilo|tema)-loja"[^>]*>/gi, '');
  return /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>\n${meta}`) : meta + html;
}
// Na edição, a IA pode apagar as <meta> da loja - voltamos a pô-las.
function manterMetasLoja(antes, depois) {
  const cartao = (/<meta name="daniel-ia-estilo-loja" content="([a-z]+)"/i.exec(antes || '') || [])[1];
  const tema = (/<meta name="daniel-ia-tema-loja" content="([a-z]+)"/i.exec(antes || '') || [])[1];
  if (!cartao && !tema) return depois;
  return marcarEstiloLoja(depois, cartao || 'suave', tema);
}

function pontoDePartidaVisual() {
  return `\nPONTO DE PARTIDA SORTEADO (usa só se a descrição da pessoa não disser nada sobre o visual - se disser, ignora isto por completo): estilo "${sortear(ESTILOS_SORTEIO)}"; hero "${sortear(HEROS_SORTEIO)}". Adapta-o ao negócio. Se não fizer sentido nenhum para este negócio, escolhe outra direcção, mas nunca o clichê do sector.`;
}

const GUIA_TIPO = {
  'E-commerce': 'Esta é uma loja online ao estilo dos grandes marketplaces (Amazon, Shein, Jumia): o protagonista são os PRODUTOS, com pouca informação à volta. Desenha só: (1) um cabeçalho compacto e elegante com o logótipo/nome da loja e um menu curto (ex: Início, Produtos, Contacto), que pode ficar fixo no topo; (2) logo a seguir ao cabeçalho, a div obrigatória da loja (ver instrução abaixo) - NÃO ponhas nenhum hero, banner ou capa antes dela, porque a capa em carrossel, a pesquisa, as categorias, os destaques e os produtos aparecem automaticamente dentro dessa div; (3) depois dela, uma faixa curta de confiança com 3 ou 4 pontos (ex: entrega rápida, pagamento seguro, apoio por WhatsApp), cada um com um ícone SVG; (4) um contacto curto e discreto junto ao rodapé (segue a instrução do contacto) e um rodapé compacto com contactos e redes sociais. Nada de textos longos, sobre nós extensos ou testemunhos - a loja vai directa aos produtos. NÃO desenhes produtos, preços, carrinho, pesquisa, categorias nem capa - é tudo tratado automaticamente.',
  'Checkout': 'Esta é uma página de venda directa de uma loja pequena, focada nos produtos. Desenha só: (1) um cabeçalho compacto com o logótipo/nome; (2) logo a seguir, a div obrigatória da loja (ver instrução abaixo) - sem hero nem capa antes dela, porque a capa, os produtos, o carrinho e o pagamento aparecem automaticamente lá dentro; (3) uma faixa curta com 3 razões para comprar (com ícones SVG); (4) um contacto curto e discreto junto ao rodapé (segue a instrução do contacto) e um rodapé compacto. Textos curtos e directos. NÃO desenhes produtos, carrinho, nem botões de compra ou pagamento - é tudo tratado automaticamente.',
  'Landing Page': 'Landing page para apresentar o negócio e levar a uma acção (contactar, comprar, reservar, inscrever-se). Secções possíveis - escolhe as que fazem sentido para a descrição, pela ordem que conta melhor a história: hero, benefícios, como funciona, sobre, serviços ou preços, depoimentos, perguntas frequentes, chamada para acção, contacto e rodapé. Se a pessoa pedir uma página simples ou curta, fica-te por 3 ou 4 secções muito bem feitas. Se não disser nada, desenvolve o suficiente para convencer, com textos com substância (explica cada benefício, não só títulos soltos).',
  'Portefólio': 'Portefólio pessoal ou profissional. Obrigatório: apresentação com o nome e o que a pessoa faz, a zona dos trabalhos (ver instrução abaixo) e o contacto. Opcional, conforme a descrição: sobre com percurso, serviços, clientes, processo de trabalho, prémios, uma citação. A forma é livre e segue a descrição: pode ser uma página minimal só com nome, trabalhos e contacto, ou uma página rica e editorial. NÃO desenhes trabalhos reais nem a grelha deles - isso é tratado à parte, automaticamente.',
  'Blog': 'Página inicial de um blog. Obrigatório: o nome do blog ou do autor, uma frase sobre o que o blog aborda, a zona dos artigos (ver instrução abaixo) e o contacto. Opcional, conforme a descrição: sobre quem escreve, temas principais, subscrição, redes sociais. Pode ser leve e minimal, ao estilo de um caderno, ou uma capa de revista. NÃO desenhes artigos reais nem a grelha deles - isso é tratado à parte, automaticamente.',
  'Galeria': 'Site de fotógrafo, videógrafo ou de qualquer pessoa que mostra o seu trabalho em imagens. Obrigatório: o nome, a zona dos álbuns (ver instrução abaixo) e o contacto. Opcional, conforme a descrição: hero, sobre, serviços ou pacotes, testemunhos, processo de trabalho. O estilo segue a descrição e não um molde: pode ser branco e silencioso para as fotos falarem sozinhas, cheio de cor e energia, escuro e cinematográfico, revista de moda, documental e cru, romântico e suave. As fotos são as protagonistas. NÃO desenhes álbuns, fotos ou vídeos falsos nem o visualizador - os álbuns a sério aparecem sozinhos, tratados à parte.'
};


// ---- Gerações com a OpenAI: fila e tempo máximo (1.55.0) ----
// O estúdio de layouts faz 3 gerações por cliente. Para muitos clientes ao
// mesmo tempo não esgotarem os limites da OpenAI, no máximo
// GERACOES_EM_PARALELO correm juntas; as outras esperam a vez. Cada uma tem
// um tempo máximo, para nenhuma versão ficar presa para sempre.
const GERACOES_EM_PARALELO = parseInt(clean(process.env.GERACOES_EM_PARALELO), 10) || 12;
const GERACAO_TEMPO_MAX_MS = 6 * 60 * 1000;
let geracoesActivas = 0;
const filaGeracoes = [];
function pedirVez() {
  if (geracoesActivas < GERACOES_EM_PARALELO) { geracoesActivas++; return Promise.resolve(); }
  return new Promise(resolve => filaGeracoes.push(resolve));
}
function largarVez() {
  const proximo = filaGeracoes.shift();
  if (proximo) proximo(); else geracoesActivas = Math.max(0, geracoesActivas - 1);
}
async function fetchGeracao(url, opcoes) {
  await pedirVez();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), GERACAO_TEMPO_MAX_MS);
  try {
    return await fetch(url, Object.assign({}, opcoes, { signal: ctrl.signal }));
  } catch (erro) {
    if (erro && erro.name === 'AbortError') throw new Error('A OpenAI demorou mais de 6 minutos a responder.');
    throw erro;
  } finally {
    clearTimeout(t);
    largarVez();
  }
}

async function gerarComOpenAI({ nome, tipo, prompt, logoUrl, imagensUrls, siteId, mostrarMarcaDeAgua, idioma, direcao, outrasDirecoes, referencia, paginas, fotos, quiz }) {
  const multiPagina = Array.isArray(paginas) && paginas.length > 1;
  const lingua = normalizarIdioma(idioma);
  const guia = GUIA_TIPO[tipo] || GUIA_TIPO['Landing Page'];
  const ehLoja = (tipo === 'E-commerce' || tipo === 'Checkout');
  const ehGaleria = (tipo === 'Galeria');
  const ehPortfolio = (tipo === 'Portefólio');
  const ehBlog = (tipo === 'Blog');
  const instrucaoLogo = logoUrl
    ? `A pessoa forneceu um logótipo. Usa exactamente esta imagem no cabeçalho: ${logoUrl}`
    : `A pessoa não forneceu logótipo. Cria um wordmark simples em texto com o nome do negócio, bem estilizado.`;

  // Imagens que a pessoa anexou ao pedido - duas razões possíveis para
  // existirem, e a IA tem de olhar bem para elas (são enviadas como
  // imagem a sério à API, não só o URL em texto) para distinguir qual é:
  // 1) referência de estilo - a pessoa pede para o site ficar "parecido"
  //    ou "como" uma imagem (ex: um print de outro site, um design) -
  //    aí a IA copia o estilo visual (cores, disposição, tipografia),
  //    nunca o conteúdo/marca de outra empresa que apareça na imagem;
  // 2) conteúdo a sério - fotos de produtos, da equipa, do espaço, etc,
  //    para usar directamente no site.
  // Se não houver nenhuma imagem, esta instrução fica de fora do pedido.
  const instrucaoImagens = (imagensUrls && imagensUrls.length)
    ? `\nA pessoa anexou ${imagensUrls.length} imagem(ns) a este pedido - estão incluídas a seguir, na ordem em que aparecem. Olha bem para cada uma antes de decidires o que fazer: se o pedido disser para o site ficar "assim", "como esta imagem" ou "neste estilo", usa essa imagem como referência visual e desenha o site nesse mesmo estilo (cores, disposição, tipografia, sensação geral) - nunca copies texto, logótipos ou marca de outra empresa que apareça nela, só o estilo. Se a imagem for antes conteúdo (foto de um produto, da equipa, do espaço, de um trabalho), usa-a directamente no site, no sítio onde fizer sentido.`
    : '';

  // Para E-commerce/Checkout, a IA nunca escreve a lógica de produtos,
  // carrinho ou pagamento - isso é sempre o mesmo módulo testado por nós
  // (LOJA_CART_JS), injectado depois. A única coisa que a IA tem de
  // garantir é deixar esta div vazia algures na página.
  const instrucaoLoja = ehLoja
    ? `\nINSTRUÇÃO OBRIGATÓRIA: nesta página tens de incluir, logo a seguir ao cabeçalho, exactamente esta div vazia, sem nada lá dentro: <div id="daniel-ia-produtos"></div> - dentro de um contentor com a mesma largura máxima e margens laterais do resto do conteúdo (ex: max-width 1240px, padding lateral 16 a 24px), sem título por cima. É ali que aparecem sozinhos, geridos por um sistema à parte, a capa da loja em carrossel, a pesquisa, as categorias, os produtos em destaque, o catálogo, a página de cada produto, o carrinho e o pagamento. Não escrevas tu nada disso.`
    : '';

  // Para a Galeria, o mesmo princípio do Loja: a IA nunca desenha álbuns,
  // fotos ou vídeos a sério, nem o visualizador - isso é sempre o mesmo
  // módulo testado por nós (GALERIA_VIEWER_JS), injectado depois.
  const instrucaoGaleria = ehGaleria
    ? `\nINSTRUÇÃO OBRIGATÓRIA: nesta página tens de incluir, algures dentro do <body>, exactamente esta div vazia, sem nada lá dentro: <div id="daniel-ia-galeria"></div> - é ali que os álbuns a sério (com as fotos e vídeos reais, e o visualizador deles) vão aparecer sozinhos, geridos por um sistema à parte. Não escrevas tu nenhum álbum, foto ou vídeo falso - só essa div vazia, bem posicionada na página (por exemplo, numa secção com título "Os nossos trabalhos" ou "Álbuns").`
    : '';

  // Para o Portefólio, o mesmo princípio: a IA nunca desenha trabalhos a
  // sério - isso é sempre o mesmo módulo testado por nós
  // (PORTFOLIO_VIEWER_JS), injectado depois.
  const instrucaoPortfolio = ehPortfolio
    ? `\nINSTRUÇÃO OBRIGATÓRIA: nesta página tens de incluir, algures dentro do <body>, exactamente esta div vazia, sem nada lá dentro: <div id="daniel-ia-portfolio"></div> - é ali que os trabalhos/projectos a sério vão aparecer sozinhos, geridos por um sistema à parte. Não escrevas tu nenhum trabalho/projecto falso - só essa div vazia, bem posicionada na página (por exemplo, numa secção com título "Trabalhos" ou "Projectos").`
    : '';

  // Para o Blog, o mesmo princípio: a IA nunca desenha artigos a sério -
  // isso é sempre o mesmo módulo testado por nós (BLOG_VIEWER_JS),
  // injectado depois.
  const instrucaoBlog = ehBlog
    ? `\nINSTRUÇÃO OBRIGATÓRIA: nesta página tens de incluir, algures dentro do <body>, exactamente esta div vazia, sem nada lá dentro: <div id="daniel-ia-blog"></div> - é ali que os artigos a sério vão aparecer sozinhos, geridos por um sistema à parte. Não escrevas tu nenhum artigo falso - só essa div vazia, bem posicionada na página (por exemplo, numa secção com título "Artigos" ou "Blog").`
    : '';

  // Para TODOS os tipos de site (não só alguns): a IA nunca escreve o
  // formulário de contacto a sério - isso é sempre o mesmo módulo testado
  // por nós (CONTACTO_FORM_JS), injectado depois, que manda a mensagem
  // por email para o endereço que o dono do site escolher.
  const instrucaoContacto = multiPagina ? INSTRUCAO_CONTACTO_MULTI : `\nINSTRUÇÃO OBRIGATÓRIA: nesta página tens de incluir, algures dentro do <body>, exactamente esta div vazia, sem nada lá dentro: <div id="daniel-ia-contacto"></div> - é ali que o formulário de contacto a sério (nome, email, mensagem, já ligado para enviar a mensagem ao dono do site) vai aparecer sozinho, gerido por um sistema à parte. Não escrevas tu nenhum formulário, nem campos de nome/email/mensagem, nem botão de enviar - só essa div vazia. A secção de contacto tem de ser CURTA e discreta, perto do rodapé: no máximo um título pequeno numa linha e os contactos (telefone, WhatsApp, email, morada) ao lado, com a div em baixo. Nada de secções de contacto enormes, imagens grandes ou textos longos à volta. O formulário aparece sozinho, fechado e compacto (abre com um botão) - não lhe ponhas outro título grande por cima.`;

  const systemPrompt = `Você é o motor de geração de sites da Daniel IA, uma plataforma moçambicana.
Gera APENAS um ficheiro HTML completo e válido (doctype, head, body), com todo o CSS e JavaScript embutidos no mesmo ficheiro (nada de ficheiros externos, excepto fontes do Google Fonts se quiseres).
Não escrevas nenhuma explicação antes ou depois do código. Não uses blocos de markdown (não escrevas \`\`\`html nem \`\`\`). A resposta deve começar directamente com <!DOCTYPE html>.
O site deve ser responsivo, moderno e profissional.
IDIOMA DO SITE: ${IDIOMAS_SITE[lingua].instrucao} A tag de abertura tem de ser <html lang="${lingua}">. As instruções que recebes estão em português, mas o texto visível do site segue sempre o idioma do site.
${DIRECAO_DE_ARTE}${direcao ? instrucaoDirecao(direcao, outrasDirecoes || [], tipo) : (referencia ? instrucaoReferencia({ referencia: 'fiel', analise: null }, tipo, true) : pontoDePartidaVisual())}
IMPORTANTE: o site tem de parecer acabado, profissional e RICO - nunca com ar de esqueleto, com caixas vazias, pouca informação ou textos de enchimento. Se a pessoa pedir simples, curto ou minimal, respeita (poucas secções, muito bem feitas). Se não disser nada, o site é completo e cheio de informação útil, como o de uma marca líder do sector (ver SITE RICO E VIVO).
${guia}${padroesDoTipo(tipo)}${instrucaoRiqueza(tipo)}${instrucaoPaginas(paginas, tipo)}${quiz ? INSTRUCAO_QUIZ : ''}${instrucaoLoja}${instrucaoGaleria}${instrucaoPortfolio}${instrucaoBlog}${instrucaoContacto}`;

  const textoPedido = `Nome do negócio: ${nome}
Tipo de projecto: ${tipo}
Idioma do site: ${IDIOMAS_SITE[lingua].nome}
${instrucaoLogo}${instrucaoImagens}${instrucaoFotos(fotos)}${referencia ? '\nIMAGEM DE REFERÊNCIA: a ÚLTIMA imagem deste pedido é a referência de estilo que a pessoa escolheu (segue as instruções da referência). Não é conteúdo para pôr no site.' : ''}
Descrição pedida pela pessoa: ${prompt}`;

  // Se houver imagens anexadas, mandamo-las a sério para a API (não só o
  // URL em texto) - só assim a IA consegue "ver" o que está nelas, seja
  // para copiar um estilo ou para usar como conteúdo. Sem imagens, o
  // pedido continua a ser simplesmente texto, como sempre foi.
  let userContent = textoPedido;
  if ((imagensUrls && imagensUrls.length) || (referencia && referencia.url)) {
    userContent = [{ type: 'text', text: textoPedido }];
    (imagensUrls || []).forEach(url => userContent.push({ type: 'image_url', image_url: { url } }));
    if (referencia && referencia.url) {
      userContent.push({ type: 'text', text: 'IMAGEM DE REFERÊNCIA (estilo a seguir):' });
      userContent.push({ type: 'image_url', image_url: { url: referencia.url, detail: 'high' } });
    }
  }

  const res = await fetchGeracao('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      reasoning_effort: OPENAI_REASONING_EFFORT,
      max_completion_tokens: OPENAI_MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ]
    })
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error('OpenAI falhou: ' + JSON.stringify(json));
  }

  let html = (json.choices[0].message.content || '').trim();

  // Defesa: se a IA mesmo assim devolver com blocos markdown, limpamos
  html = html.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const tokens = (json.usage && json.usage.total_tokens) || 0;

  // Defesa: se por algum motivo (ex: o raciocínio gastou todo o orçamento
  // de tokens) não sobrar HTML nenhum, falha de forma clara em vez de
  // guardar um ficheiro vazio.
  if (!html || html.length < 100) {
    throw new Error('A OpenAI devolveu uma resposta vazia ou demasiado curta. Tokens gastos: ' + tokens);
  }

  html = fixarIdiomaHtml(html, lingua);
  if (multiPagina) html = prepararCasca(html, paginas);
  html = aplicarRedeResponsiva(html);
  html = injectarLojaSeNecessario(html, ehLoja, siteId);
  html = injectarQuizSeNecessario(html, ehLoja, siteId);
  html = injectarGaleriaSeNecessario(html, ehGaleria, siteId);
  html = injectarPortfolioSeNecessario(html, ehPortfolio, siteId);
  html = injectarBlogSeNecessario(html, ehBlog, siteId);
  html = injectarContactoSeNecessario(html, siteId);
  html = aplicarMarcaDeAgua(html, mostrarMarcaDeAgua);

  return { html, tokens };
}

// Mostra ou remove o selo "Feito com Daniel IA" no canto do site, segundo o
// plano do dono (só o Free tem marca de água). Remove sempre primeiro
// qualquer selo que já exista e só volta a pô-lo se for preciso - assim,
// se a pessoa subir de plano e depois editar o site, o selo desaparece
// sozinho na próxima vez que o ficheiro for reescrito.
function aplicarMarcaDeAgua(html, mostrar) {
  html = html.replace(/\s*<a[^>]*id=["']daniel-ia-marca-dagua["'][^>]*>[\s\S]*?<\/a>/i, '');
  if (!mostrar) return html;
  const feitoCom = { pt: 'Feito com', en: 'Made with', fr: 'Créé avec', es: 'Hecho con' }[idiomaDoHtml(html) || 'pt'];

  const selo = `\n<a id="daniel-ia-marca-dagua" href="https://daniel-ia.pro" target="_blank" rel="noopener" style="position:fixed;bottom:16px;right:16px;z-index:999999;display:inline-flex;align-items:center;gap:8px;background:rgba(15,5,24,0.92);color:#F6F2FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12.5px;font-weight:500;line-height:1;padding:8px 14px 8px 10px;border-radius:999px;text-decoration:none;border:1px solid rgba(137,200,4,0.35);box-shadow:0 8px 24px rgba(67,9,96,0.45);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);"><svg viewBox="111 492.5 250 250" width="16" height="16" aria-hidden="true" style="display:block;flex-shrink:0;"><path fill="#FFFFFF" d="M148.0 738.1C142.7 737.4 139.2 736.1 135.6 733.7C128.3 728.8 123.9 721.8 122.6 713.1C122.1 709.4 122.1 707.5 122.7 704.0C123.8 697.6 126.3 692.6 130.6 688.3C133.2 685.6 136.0 683.8 141.9 680.7C150.6 676.1 156.0 672.8 160.9 669.2C172.2 660.9 180.7 651.9 187.8 640.6C188.3 639.9 188.8 639.4 189.0 639.4C189.4 639.4 189.5 702.5 189.0 705.6C187.7 714.1 184.5 720.7 178.6 726.7C172.9 732.7 168.0 735.6 160.8 737.5C158.3 738.2 157.3 738.3 154.1 738.4C151.7 738.4 149.5 738.4 148.0 738.1ZM183.5 737.9C183.5 737.7 184.1 737.1 184.9 736.6C189.2 733.9 194.3 728.3 197.4 723.0C202.1 715.1 203.7 708.5 203.7 698.0C203.7 694.3 203.8 692.7 204.1 692.4C204.3 692.1 206.1 692.0 222.0 691.9C238.3 691.8 239.9 691.8 243.0 691.3C254.0 689.6 263.9 685.6 273.4 679.0C281.6 673.4 288.9 665.8 294.0 657.5C298.3 650.5 301.7 642.5 303.3 635.4C306.8 619.6 305.5 604.6 299.3 589.3C296.5 582.2 293.0 576.6 286.9 569.6C282.9 564.8 279.8 562.0 274.4 558.1C264.1 550.6 251.7 545.8 240.8 545.0C238.8 544.8 228.4 544.8 215.6 544.8L193.8 544.9L192.7 545.6C191.4 546.5 190.1 548.2 189.7 549.4C189.5 550.1 189.4 555.5 189.4 571.2C189.4 582.6 189.3 592.1 189.2 592.2C188.9 592.4 188.0 591.4 188.0 590.9C188.0 590.0 185.1 584.4 182.5 580.6C179.3 575.7 171.4 568.0 165.1 563.7C161.4 561.2 152.2 556.2 143.4 551.9C134.1 547.4 130.6 544.8 127.0 540.0C124.6 536.8 123.4 533.6 122.6 529.1C122.2 526.2 122.2 523.9 122.6 520.6C123.1 517.2 123.8 514.9 125.2 512.1C128.5 505.5 134.2 500.8 141.6 498.7C146.7 497.2 146.0 497.2 196.5 497.3C246.4 497.4 244.5 497.4 253.4 498.8C268.8 501.2 287.7 509.1 301.3 518.9C312.8 527.0 323.6 538.1 330.9 549.1C335.2 555.5 337.8 560.2 340.5 566.0C344.7 575.1 347.2 582.3 349.5 592.4C351.4 600.7 352.0 605.8 352.2 615.9C352.4 628.3 351.3 638.6 348.6 648.9C345.6 660.5 339.4 674.8 333.6 684.0C323.4 700.1 309.0 713.7 292.2 723.3C282.4 728.9 271.5 733.1 261.5 735.3C248.6 738.2 247.4 738.2 211.8 738.2C186.7 738.2 183.5 738.2 183.5 737.9Z"/><circle fill="#89C804" cx="149.1" cy="612.7" r="29.7"/></svg><span>${feitoCom} <strong style="font-weight:800;color:#FFFFFF;">Daniel <span style="color:#89C804;">IA</span></strong></span></a>\n`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, selo + '</body>');
  }
  return html + selo;
}

// Rede de segurança para telemóvel (1.59.0): umas poucas regras no início
// do <head> (o CSS do próprio site continua a mandar) que evitam os erros
// clássicos - página a fugir para o lado, imagens maiores do que o ecrã,
// palavras compridas a partir a grelha e o zoom do iPhone nos campos.
const CSS_RESPONSIVO = '<style id="daniel-ia-responsivo">html{-webkit-text-size-adjust:100%;text-size-adjust:100%;overflow-x:clip}body{overflow-x:clip;overflow-wrap:break-word}img,video{max-width:100%;height:auto}h1,h2{overflow-wrap:anywhere}input,select,textarea,table{max-width:100%}pre{white-space:pre-wrap}@media (max-width:640px){input,select,textarea{font-size:16px}}</style>';
function aplicarRedeResponsiva(html) {
  html = html.replace(/\s*<style id="daniel-ia-responsivo">[\s\S]*?<\/style>/i, '');
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, '<head$1>\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  }
  return /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, '<head$1>\n' + CSS_RESPONSIVO) : CSS_RESPONSIVO + html;
}

// Para E-commerce/Checkout: garante a div dos produtos (defesa, caso a IA
// se tenha esquecido dela) e injecta sempre o módulo fixo da loja antes de
// </body>. Chamado tanto na criação como na edição de um site - nunca
// depende do que a IA escreveu, é sempre reaplicado por cima.
function injectarLojaSeNecessario(html, ehLoja, siteId) {
  if (!ehLoja) return html;

  // Sites com várias páginas: a div só existe nas páginas da loja, mas o
  // script vai para todas (o carrinho funciona em todas as páginas).
  if (!/id=["']daniel-ia-produtos["']/.test(html) && !paginasMulti(html)) {
    html = html.replace(
      /<\/body>/i,
      '<div id="daniel-ia-produtos" style="max-width:1100px;margin:40px auto;padding:0 20px;"></div>\n</body>'
    );
  }

  // Só injecta os scripts se ainda não estiverem lá - importante na edição,
  // onde o HTML que entra aqui já pode trazer os scripts da versão
  // anterior (reinjectá-los duplicaria a inicialização do carrinho).
  if (!/loja-cart\.js/.test(html)) {
    const scriptLoja = `\n<script>window.DANIEL_IA_SITE_ID = ${JSON.stringify(siteId || '')};</script>\n<script src="${SELF_URL}/loja-cart.js"></script>\n`;
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, scriptLoja + '</body>');
    } else {
      html += scriptLoja;
    }
  }
  return html;
}

// Para a Galeria: garante a div dos álbuns (defesa, caso a IA se tenha
// esquecido dela) e injecta sempre o módulo fixo do visualizador antes de
// </body>. Chamado tanto na criação como na edição de um site - nunca
// depende do que a IA escreveu, é sempre reaplicado por cima. Espelha
// exactamente injectarLojaSeNecessario, só que para "daniel-ia-galeria" e
// "galeria-viewer.js".
function injectarGaleriaSeNecessario(html, ehGaleria, siteId) {
  if (!ehGaleria) return html;
  if (paginasMulti(html) && !/id=["']daniel-ia-galeria["']/.test(html)) return html;

  if (!/id=["']daniel-ia-galeria["']/.test(html)) {
    html = html.replace(
      /<\/body>/i,
      '<div id="daniel-ia-galeria" style="max-width:1100px;margin:40px auto;padding:0 20px;"></div>\n</body>'
    );
  }

  if (!/galeria-viewer\.js/.test(html)) {
    const scriptGaleria = `\n<script>window.DANIEL_IA_SITE_ID = ${JSON.stringify(siteId || '')};</script>\n<script src="${SELF_URL}/galeria-viewer.js"></script>\n`;
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, scriptGaleria + '</body>');
    } else {
      html += scriptGaleria;
    }
  }
  return html;
}

// Para o Portefólio: garante a div dos trabalhos (defesa, caso a IA se
// tenha esquecido dela) e injecta sempre o módulo fixo do visualizador
// antes de </body>. Espelha exactamente injectarGaleriaSeNecessario, só
// que para "daniel-ia-portfolio" e "portfolio-viewer.js".
function injectarPortfolioSeNecessario(html, ehPortfolio, siteId) {
  if (!ehPortfolio) return html;
  if (paginasMulti(html) && !/id=["']daniel-ia-portfolio["']/.test(html)) return html;

  if (!/id=["']daniel-ia-portfolio["']/.test(html)) {
    html = html.replace(
      /<\/body>/i,
      '<div id="daniel-ia-portfolio" style="max-width:1100px;margin:40px auto;padding:0 20px;"></div>\n</body>'
    );
  }

  if (!/portfolio-viewer\.js/.test(html)) {
    const scriptPortfolio = `\n<script>window.DANIEL_IA_SITE_ID = ${JSON.stringify(siteId || '')};</script>\n<script src="${SELF_URL}/portfolio-viewer.js"></script>\n`;
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, scriptPortfolio + '</body>');
    } else {
      html += scriptPortfolio;
    }
  }
  return html;
}

// Para o Blog: garante a div dos artigos (defesa, caso a IA se tenha
// esquecido dela) e injecta sempre o módulo fixo do visualizador antes
// de </body>. Espelha exactamente injectarPortfolioSeNecessario, só que
// para "daniel-ia-blog" e "blog-viewer.js".
function injectarBlogSeNecessario(html, ehBlog, siteId) {
  if (!ehBlog) return html;
  if (paginasMulti(html) && !/id=["']daniel-ia-blog["']/.test(html)) return html;

  if (!/id=["']daniel-ia-blog["']/.test(html)) {
    html = html.replace(
      /<\/body>/i,
      '<div id="daniel-ia-blog" style="max-width:1100px;margin:40px auto;padding:0 20px;"></div>\n</body>'
    );
  }

  if (!/blog-viewer\.js/.test(html)) {
    const scriptBlog = `\n<script>window.DANIEL_IA_SITE_ID = ${JSON.stringify(siteId || '')};</script>\n<script src="${SELF_URL}/blog-viewer.js"></script>\n`;
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, scriptBlog + '</body>');
    } else {
      html += scriptBlog;
    }
  }
  return html;
}

// Para o Contacto: ao contrário dos outros, aplica-se a TODOS os sites,
// seja qual for o tipo - garante a div do formulário (defesa, caso a IA
// se tenha esquecido dela) e injecta sempre o módulo fixo antes de
// </body>. Mesmo princípio de injectarLojaSeNecessario, só que sem
// nenhuma condição de tipo e para "daniel-ia-contacto" e
// "contacto-form.js".
function injectarContactoSeNecessario(html, siteId) {
  if (paginasMulti(html) && !/id=["']daniel-ia-contacto["']/.test(html)) return html;
  if (!/id=["']daniel-ia-contacto["']/.test(html)) {
    html = html.replace(
      /<\/body>/i,
      '<div id="daniel-ia-contacto" style="max-width:700px;margin:40px auto;padding:0 20px;"></div>\n</body>'
    );
  }

  if (!/contacto-form\.js/.test(html)) {
    const scriptContacto = `\n<script>window.DANIEL_IA_SITE_ID = ${JSON.stringify(siteId || '')};</script>\n<script src="${SELF_URL}/contacto-form.js"></script>\n`;
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, scriptContacto + '</body>');
    } else {
      html += scriptContacto;
    }
  }
  return html;
}

// Pede à OpenAI para aplicar uma alteração a um site já gerado, em vez de
// criar um site do zero. Recebe o HTML actual completo e devolve o HTML
// completo já alterado - a IA tem de reescrever o ficheiro todo (nunca um
// pedaço), porque é isso que depois sobe para o Bunny no lugar do antigo.
async function editarComOpenAI({ nome, tipo, prompt, htmlAtual, imagensUrls, siteId, mostrarMarcaDeAgua }) {
  const ehLoja = (tipo === 'E-commerce' || tipo === 'Checkout');
  const ehGaleria = (tipo === 'Galeria');
  const ehPortfolio = (tipo === 'Portefólio');
  const ehBlog = (tipo === 'Blog');

  // Mesma lógica de gerarComOpenAI: imagens novas que a pessoa anexou a
  // este pedido de edição - mandadas a sério para a API (ver userContent
  // mais abaixo), não só o URL em texto, para a IA conseguir distinguir
  // entre referência de estilo ("faz como esta imagem") e conteúdo a
  // sério (uma foto para usar no site).
  const instrucaoImagens = (imagensUrls && imagensUrls.length)
    ? `\nA pessoa anexou ${imagensUrls.length} imagem(ns) nova(s) a este pedido de alteração - estão incluídas a seguir. Olha bem para cada uma: se o pedido disser para ficar "como esta imagem" ou seguir o estilo dela, aplica esse estilo visual (cores, disposição, tipografia) ao site, sem copiar texto, logótipos ou marca de outra empresa que apareça nela. Se for conteúdo (uma foto para usar no site), usa-a onde fizer sentido.`
    : '';

  const instrucaoLoja = ehLoja && (!paginasMulti(htmlAtual) || /id=["']daniel-ia-produtos["']/.test(htmlAtual))
    ? `\nATENÇÃO: esta página é uma loja. Tem de continuar a existir, exactamente como está, a div <div id="daniel-ia-produtos"></div> e os dois <script> antes de </body> que carregam o módulo da loja (window.DANIEL_IA_SITE_ID e loja-cart.js). Não apagues nem modifiques essa div nem esses scripts, e não escrevas tu produtos, carrinho ou botões de compra - isso continua a ser tratado à parte, automaticamente.`
    : '';

  const instrucaoGaleria = ehGaleria
    ? `\nATENÇÃO: esta página é uma galeria. Tem de continuar a existir, exactamente como está, a div <div id="daniel-ia-galeria"></div> e os dois <script> antes de </body> que carregam o módulo da galeria (window.DANIEL_IA_SITE_ID e galeria-viewer.js). Não apagues nem modifiques essa div nem esses scripts, e não escrevas tu álbuns, fotos ou vídeos a sério - isso continua a ser tratado à parte, automaticamente.`
    : '';

  const instrucaoPortfolio = ehPortfolio
    ? `\nATENÇÃO: esta página é um portefólio. Tem de continuar a existir, exactamente como está, a div <div id="daniel-ia-portfolio"></div> e os dois <script> antes de </body> que carregam o módulo do portefólio (window.DANIEL_IA_SITE_ID e portfolio-viewer.js). Não apagues nem modifiques essa div nem esses scripts, e não escrevas tu trabalhos/projectos a sério - isso continua a ser tratado à parte, automaticamente.`
    : '';

  const instrucaoBlog = ehBlog
    ? `\nATENÇÃO: esta página é um blog. Tem de continuar a existir, exactamente como está, a div <div id="daniel-ia-blog"></div> e os dois <script> antes de </body> que carregam o módulo do blog (window.DANIEL_IA_SITE_ID e blog-viewer.js). Não apagues nem modifiques essa div nem esses scripts, e não escrevas tu artigos a sério - isso continua a ser tratado à parte, automaticamente.`
    : '';

  // Aplica-se a TODOS os sites, seja qual for o tipo.
  const instrucaoContacto = (paginasMulti(htmlAtual) && !/id=["']daniel-ia-contacto["']/.test(htmlAtual)) ? '' : `\nATENÇÃO: esta página tem de continuar a ter, exactamente como está, a div <div id="daniel-ia-contacto"></div> e os dois <script> antes de </body> que carregam o módulo de contacto (window.DANIEL_IA_SITE_ID e contacto-form.js). Não apagues nem modifiques essa div nem esses scripts, e não escrevas tu nenhum formulário de contacto a sério - isso continua a ser tratado à parte, automaticamente.`;

  const instrucaoMarca = `\nSe existir, perto de </body>, um elemento <a id="daniel-ia-marca-dagua">...</a> (um selo "Feito com Daniel IA"), não o apagues nem o modifiques - isso é gerido à parte, automaticamente.`;

  const linguaActual = idiomaDoHtml(htmlAtual) || 'pt';
  const instrucaoIdioma = `\nIDIOMA: este site está em ${IDIOMAS_SITE[linguaActual].nome} (<html lang="${linguaActual}">). Mantém todo o texto nesse idioma, mesmo que o pedido de alteração esteja escrito em português - traduz para ${IDIOMAS_SITE[linguaActual].nome} qualquer texto novo. Só mudes de idioma se o pedido disser claramente para traduzir o site; nesse caso traduz o site todo e actualiza o atributo lang da tag <html> (pt, en, fr ou es).`;

  const systemPrompt = `Você é o motor de edição de sites da Daniel IA, uma plataforma moçambicana.
Vais receber o código HTML completo de um site já existente, e um pedido de alteração.
A tua tarefa é devolver o ficheiro HTML completo (doctype, head, body), já com a alteração pedida aplicada, mantendo tudo o resto exactamente igual ao original - mesma estrutura, mesmo estilo visual, mesmo conteúdo que não foi pedido para mudar.
Não escrevas nenhuma explicação antes ou depois do código. Não uses blocos de markdown (não escrevas \`\`\`html nem \`\`\`). A resposta deve começar directamente com <!DOCTYPE html>.
IMPORTANTE: o site tem de continuar acabado e profissional depois da alteração - nunca partido, vazio ou com ar de esqueleto. Se a alteração implicar reescrever ou ampliar alguma secção, capricha nela. Se a pessoa pedir para simplificar ou tirar coisas, faz isso mesmo, sem voltar a encher.
${DIRECAO_DE_ARTE}
NA EDIÇÃO: mantém a identidade visual que o site já tem, mas tudo o que mudares ou acrescentares tem de seguir este padrão de qualidade. Se o :root ainda não tiver as fichas --dia-*, acrescenta-as com os valores que o site já usa (sem mudar o visual). Se o pedido mudar cores ou tipos de letra, actualiza também as fichas.${paginasMulti(htmlAtual) ? INSTRUCAO_EDICAO_MULTI : ''}${instrucaoIdioma}${instrucaoLoja}${instrucaoGaleria}${instrucaoPortfolio}${instrucaoBlog}${instrucaoContacto}${instrucaoMarca}`;

  const textoPedido = `Nome do negócio: ${nome}
Tipo de projecto: ${tipo}
Pedido de alteração: ${prompt}${instrucaoImagens}

Código HTML actual completo:
${htmlAtual}`;

  // Mesma lógica de gerarComOpenAI: com imagens anexadas, mandamo-las a
  // sério para a API em vez de só o URL em texto.
  let userContent = textoPedido;
  if (imagensUrls && imagensUrls.length) {
    userContent = [{ type: 'text', text: textoPedido }];
    imagensUrls.forEach(url => userContent.push({ type: 'image_url', image_url: { url } }));
  }

  const res = await fetchGeracao('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      reasoning_effort: OPENAI_REASONING_EFFORT,
      max_completion_tokens: OPENAI_MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ]
    })
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error('OpenAI falhou: ' + JSON.stringify(json));
  }

  let html = (json.choices[0].message.content || '').trim();
  html = html.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const tokens = (json.usage && json.usage.total_tokens) || 0;

  if (!html || html.length < 100) {
    throw new Error('A OpenAI devolveu uma resposta vazia ou demasiado curta. Tokens gastos: ' + tokens);
  }

  html = injectarLojaSeNecessario(html, ehLoja, siteId);
  html = injectarGaleriaSeNecessario(html, ehGaleria, siteId);
  html = injectarPortfolioSeNecessario(html, ehPortfolio, siteId);
  html = injectarBlogSeNecessario(html, ehBlog, siteId);
  html = injectarContactoSeNecessario(html, siteId);
  html = fixarIdiomaHtml(html, idiomaDoHtml(html) || linguaActual);
  html = aplicarRedeResponsiva(html);
  if (ehLoja) html = manterMetasLoja(htmlAtual, html);
  html = aplicarMarcaDeAgua(html, mostrarMarcaDeAgua);

  return { html, tokens };
}

// ======================================================
// Script fixo da loja (carrinho + checkout), servido directamente
// ======================================================
// Guardado aqui como texto para ser servido por /loja-cart.js. É este
// ficheiro que todos os sites de E-commerce/Checkout gerados carregam -
// nunca é a IA a escrever esta lógica.
const LOJA_CART_JS = `/*
  Daniel IA - módulo fixo da loja v3 (montra por blocos, estilo marketplace)
  -------------------------------------------------------------------------
  Servido pelo container em /loja-cart.js e carregado por TODOS os sites de
  E-commerce/Checkout. A IA desenha só o cabeçalho e o rodapé do site e deixa
  uma div com id="daniel-ia-produtos". Este módulo monta ali a montra que o
  dono escolheu no "Gerir loja", bloco a bloco:
    anuncio    - faixa de aviso (ex: entrega grátis)
    capa       - carrossel até 3 imagens
    categorias - círculos ou cartões com imagem
    fila       - fila deslizante (novidades, promoções, mais vendidos,
                 destaques ou uma categoria)
    banners    - 1 a 3 banners que levam a uma categoria, produto ou link
    oferta     - oferta relâmpago com contagem decrescente
    catalogo   - todos os produtos, por categoria
    vistos     - vistos recentemente (guardado no browser do cliente)
  Página de produto com várias fotos (zoom e deslizar), opções com preço e
  stock próprios, avaliações e "também vais gostar". Carrinho e checkout
  adaptados ao modo de pagamento da loja. Cores, letras e cantos vêm das
  fichas --dia-* do próprio site; textos no idioma do <html lang>.

  Cada página gerada define, antes de carregar este ficheiro:
    window.DANIEL_IA_SITE_ID = 'xxxxx';
*/
(function(){
  'use strict';
  // ---- Idioma do site (lido do <html lang>): pt, en, fr ou es ----
  var DIA_LANG = (function(){
    var l = String(document.documentElement.getAttribute('lang') || 'pt').toLowerCase().slice(0, 2);
    return (l === 'en' || l === 'fr' || l === 'es') ? l : 'pt';
  })();
  var DIA_LOCALE = { pt: 'pt-PT', en: 'en-GB', fr: 'fr-FR', es: 'es-ES' }[DIA_LANG];
  var DIA_TXT = {"en": {"{nome} adicionado ao carrinho": "{nome} added to cart", "Pesquisar produtos": "Search products", "Abrir carrinho": "Open cart", "Carrinho": "Cart", "O teu carrinho": "Your cart", "Total": "Total", "Finalizar compra": "Checkout", "A nossa loja": "Our store", "{n} produtos à tua espera. Escolhe, encomenda e recebe.": "{n} products waiting for you. Choose, order and receive.", "Descobre os nossos produtos.": "Discover our products.", "Ver produtos": "Shop now", "Imagem {n}": "Image {n}", "Outros": "Other", "Tudo": "All", "Em destaque": "Featured", "Adicionar {nome} ao carrinho": "Add {nome} to cart", "Ainda não há produtos à venda aqui.": "No products for sale here yet.", "Nenhum produto encontrado para \\"{t}\\".": "No products found for \\"{t}\\".", "Nenhum produto encontrado.": "No products found.", "Ver todos": "See all", "Resultados": "Results", "Produtos": "Products", "{n} produto": "{n} product", "{n} produtos": "{n} products", "Poupas {v}": "You save {v}", "Quantidade": "Quantity", "Menos": "Less", "Mais": "More", "Adicionar ao carrinho": "Add to cart", "Comprar agora": "Buy now", "O teu carrinho está vazio.": "Your cart is empty.", "Remover": "Remove", "Confirmar encomenda": "Confirm order", "Cartão": "Card", "Como queres pagar?": "How would you like to pay?", "Pagar {v}": "Pay {v}", "Depois de confirmares, paga directamente à loja para um destes números, com a referência que te vamos dar:": "After confirming, pay the store directly to one of these numbers, using the reference we'll give you:", "Em nome de": "Account holder:", "A loja confirma o pagamento e prepara a tua encomenda.": "The store will confirm the payment and prepare your order.", "Encomendar pelo WhatsApp": "Order via WhatsApp", "Enviar encomenda": "Send order", "Preenche os teus dados e enviamos a encomenda para o WhatsApp da loja.": "Fill in your details and we'll send the order to the store's WhatsApp.", "A loja recebe a tua encomenda e contacta-te para combinar o pagamento e a entrega.": "The store receives your order and will contact you to arrange payment and delivery.", "Só falta isto para receberes a tua encomenda.": "Just this and your order is on its way.", "{n} artigo": "{n} item", "{n} artigos": "{n} items", "O teu nome": "Your name", "Telefone": "Phone", "(o mesmo da carteira, para M-Pesa/e-Mola)": "(the same as your M-Pesa/e-Mola wallet)", "Email (opcional, para receberes a confirmação)": "Email (optional, to receive the confirmation)", "Morada de entrega / notas (opcional)": "Delivery address / notes (optional)", "Escreve o teu nome.": "Please enter your name.", "Escreve o teu número de telefone.": "Please enter your phone number.", "Esse email não parece válido - podes deixá-lo em branco.": "That email doesn't look valid - you can leave it blank.", "Escolhe como queres pagar.": "Choose how you want to pay.", "A processar...": "Processing...", "Não foi possível criar a encomenda.": "Could not create the order.", "Não foi possível iniciar o pagamento.": "Could not start the payment.", "Algo correu mal. Tenta novamente.": "Something went wrong. Please try again.", "Encomenda enviada!": "Order sent!", "Para concluir, paga {v} com a referência {r}:": "To complete, pay {v} using the reference {r}:", "Copiar": "Copy", "Enviar comprovativo no WhatsApp": "Send proof of payment on WhatsApp", "Abrimos o WhatsApp com a tua encomenda já escrita - só tens de carregar em enviar.": "We opened WhatsApp with your order already written - just tap send.", "Abrir o WhatsApp outra vez": "Open WhatsApp again", "A loja recebeu a tua encomenda e vai contactar-te em breve para combinar o pagamento e a entrega.": "The store has received your order and will contact you soon to arrange payment and delivery.", "Continuar a comprar": "Continue shopping", "Copiado": "Copied", "Confirma no teu telemóvel": "Confirm on your phone", "Enviámos o pedido de pagamento para o teu número. Introduz o PIN para confirmar.": "We sent the payment request to your number. Enter your PIN to confirm.", "Pagamento confirmado!": "Payment confirmed!", "Obrigado pela tua compra. A loja já recebeu a tua encomenda.": "Thank you for your purchase. The store has received your order.", "Ainda não recebemos a confirmação. Se já pagaste, aguarda - a loja recebe a encomenda assim que o pagamento chegar.": "We haven't received the confirmation yet. If you've already paid, please wait - the store gets the order as soon as the payment arrives.", "Não foi possível carregar os produtos. Recarrega a página.": "Could not load the products. Please reload the page.", "Fechar": "Close", "Anterior": "Previous", "Seguinte": "Next", "{n} de 5 estrelas": "{n} out of 5 stars", "Esgotado": "Sold out", "Só restam {n} unidades.": "Only {n} left.", "Só restam {n} unidades": "Only {n} left", "Só resta 1 unidade": "Only 1 left", "Novidades": "New arrivals", "Promoções": "Deals", "Mais vendidos": "Best sellers", "Novo": "New", "desde": "from", "Categorias": "Categories", "Oferta relâmpago": "Flash deal", "Termina em": "Ends in", "dias": "days", "h": "h", "min": "min", "seg": "sec", "Todos os produtos": "All products", "Vistos recentemente": "Recently viewed", "Limpar": "Clear", "Opção": "Option", "Em stock": "In stock", "Escolhe uma opção.": "Choose an option.", "Também vais gostar": "You may also like", "Avaliações": "Reviews", "{n} avaliação": "{n} review", "{n} avaliações": "{n} reviews", "Escrever avaliação": "Write a review", "Ainda sem avaliações. Sê o primeiro a avaliar!": "No reviews yet. Be the first to review!", "A tua nota": "Your rating", "Comentário (opcional)": "Comment (optional)", "Enviar avaliação": "Submit review", "Escolhe de 1 a 5 estrelas.": "Choose 1 to 5 stars.", "Não foi possível enviar a avaliação.": "Could not submit the review.", "Obrigado! A tua avaliação aparece depois de a loja a aprovar.": "Thank you! Your review will appear once the store approves it.", "Só restam {n} de \\"{nome}\\".": "Only {n} of \\"{nome}\\" left.", "\\"{nome}\\" está esgotado.": "\\"{nome}\\" is sold out.", "Escolhe uma opção para \\"{nome}\\".": "Choose an option for \\"{nome}\\".", "Só resta 1 de \\"{nome}\\".": "Only 1 of \\"{nome}\\" left.", "Mais produtos": "More products", "Produto {n}": "Product {n}", "Os teus produtos reais aparecem aqui, com fotos, preços e opções.": "Your real products appear here, with photos, prices and options.", "Pré-visualização: aqui o cliente juntaria o produto ao carrinho.": "Preview: here the customer would add the product to the cart.", "Pré-visualização com produtos de exemplo - os teus aparecem aqui.": "Preview with sample products - yours will appear here.", "Clássicos": "Classics", "Edição limitada": "Limited edition", "Recomendado para ti": "Recommended for you", "Categoria": "Category", "Promoção": "Sale", "Até {n}% de desconto": "Up to {n}% off", "Ver ofertas": "See deals", "Colecção": "Collection", "Explorar categorias": "Browse categories", "Compra por categoria": "Shop by category", "Ofertas da semana": "Weekly best deals", "Mais recentes": "Newest", "Preço mais baixo": "Lowest price", "Preço mais alto": "Highest price", "Ordenar": "Sort by", "Mostrar mais": "Show more", "A mostrar {a} de {b}": "Showing {a} of {b}", "Pagamento recebido. A confirmar...": "Payment received. Confirming...", "Pagamento seguro": "Secure payment", "O banco abre o pagamento numa janela segura. Paga e volta para aqui - esta página confirma sozinha.": "Your bank opens the payment in a secure window. Pay and come back here - this page confirms it automatically.", "Abrir pagamento seguro": "Open secure payment", "Não aparece? Abrir numa janela nova": "Not showing? Open in a new window", "À espera da confirmação do pagamento...": "Waiting for payment confirmation...", "Ainda à espera. Se já pagaste, a confirmação pode demorar um pouco.": "Still waiting. If you've already paid, confirmation may take a moment.", "Adicionar": "Add", "Preços desde": "Prices from", "Ver tudo": "See all", "Destaque": "Featured", "Ver produto": "View product", "Filtros": "Filters", "Preço": "Price", "Mínimo": "Minimum", "Máximo": "Maximum", "Mostrar só": "Show only", "4 estrelas ou mais": "4 stars & up", "Em promoção": "On sale", "Limpar filtros": "Clear filters", "Ver resultados": "See results", "Vista em grelha": "Grid view", "Vista em lista": "List view", "Ver todos os produtos": "See all products", "{n} produtos, com filtros por categoria e preço": "{n} products, with filters by category and price", "Este produto já não está disponível.": "This product is no longer available.", "Início": "Home", "Loja": "Shop", "Melhores ofertas para ti": "Best deals for you", "Os mais pedidos": "Most ordered", "Entrega rápida": "Fast delivery", "Bons preços": "Great prices", "Qualidade garantida": "Guaranteed quality", "Até": "Up to", "Fresco": "Fresh", "Saboroso": "Tasty", "Rápido": "Fast", "Encomendar agora": "Order now", "Ingredientes frescos": "Fresh ingredients"}, "fr": {"{nome} adicionado ao carrinho": "{nome} ajouté au panier", "Pesquisar produtos": "Rechercher des produits", "Abrir carrinho": "Ouvrir le panier", "Carrinho": "Panier", "O teu carrinho": "Votre panier", "Total": "Total", "Finalizar compra": "Finaliser l'achat", "A nossa loja": "Notre boutique", "{n} produtos à tua espera. Escolhe, encomenda e recebe.": "{n} produits vous attendent. Choisissez, commandez et recevez.", "Descobre os nossos produtos.": "Découvrez nos produits.", "Ver produtos": "Voir les produits", "Imagem {n}": "Image {n}", "Outros": "Autres", "Tudo": "Tout", "Em destaque": "En vedette", "Adicionar {nome} ao carrinho": "Ajouter {nome} au panier", "Ainda não há produtos à venda aqui.": "Aucun produit en vente pour le moment.", "Nenhum produto encontrado para \\"{t}\\".": "Aucun produit trouvé pour « {t} ».", "Nenhum produto encontrado.": "Aucun produit trouvé.", "Ver todos": "Tout voir", "Resultados": "Résultats", "Produtos": "Produits", "{n} produto": "{n} produit", "{n} produtos": "{n} produits", "Poupas {v}": "Vous économisez {v}", "Quantidade": "Quantité", "Menos": "Moins", "Mais": "Plus", "Adicionar ao carrinho": "Ajouter au panier", "Comprar agora": "Acheter maintenant", "O teu carrinho está vazio.": "Votre panier est vide.", "Remover": "Retirer", "Confirmar encomenda": "Confirmer la commande", "Cartão": "Carte", "Como queres pagar?": "Comment souhaitez-vous payer ?", "Pagar {v}": "Payer {v}", "Depois de confirmares, paga directamente à loja para um destes números, com a referência que te vamos dar:": "Après confirmation, payez directement la boutique sur l'un de ces numéros, avec la référence que nous vous donnerons :", "Em nome de": "Au nom de", "A loja confirma o pagamento e prepara a tua encomenda.": "La boutique confirmera le paiement et préparera votre commande.", "Encomendar pelo WhatsApp": "Commander via WhatsApp", "Enviar encomenda": "Envoyer la commande", "Preenche os teus dados e enviamos a encomenda para o WhatsApp da loja.": "Remplissez vos coordonnées et nous enverrons la commande sur le WhatsApp de la boutique.", "A loja recebe a tua encomenda e contacta-te para combinar o pagamento e a entrega.": "La boutique reçoit votre commande et vous contactera pour convenir du paiement et de la livraison.", "Só falta isto para receberes a tua encomenda.": "Plus que cette étape pour recevoir votre commande.", "{n} artigo": "{n} article", "{n} artigos": "{n} articles", "O teu nome": "Votre nom", "Telefone": "Téléphone", "(o mesmo da carteira, para M-Pesa/e-Mola)": "(le même que votre portefeuille M-Pesa/e-Mola)", "Email (opcional, para receberes a confirmação)": "E-mail (facultatif, pour recevoir la confirmation)", "Morada de entrega / notas (opcional)": "Adresse de livraison / remarques (facultatif)", "Escreve o teu nome.": "Veuillez saisir votre nom.", "Escreve o teu número de telefone.": "Veuillez saisir votre numéro de téléphone.", "Esse email não parece válido - podes deixá-lo em branco.": "Cet e-mail ne semble pas valide - vous pouvez le laisser vide.", "Escolhe como queres pagar.": "Choisissez votre moyen de paiement.", "A processar...": "Traitement en cours...", "Não foi possível criar a encomenda.": "Impossible de créer la commande.", "Não foi possível iniciar o pagamento.": "Impossible de lancer le paiement.", "Algo correu mal. Tenta novamente.": "Une erreur s'est produite. Veuillez réessayer.", "Encomenda enviada!": "Commande envoyée !", "Para concluir, paga {v} com a referência {r}:": "Pour finaliser, payez {v} avec la référence {r} :", "Copiar": "Copier", "Enviar comprovativo no WhatsApp": "Envoyer la preuve de paiement sur WhatsApp", "Abrimos o WhatsApp com a tua encomenda já escrita - só tens de carregar em enviar.": "Nous avons ouvert WhatsApp avec votre commande déjà rédigée - il ne reste qu'à appuyer sur envoyer.", "Abrir o WhatsApp outra vez": "Rouvrir WhatsApp", "A loja recebeu a tua encomenda e vai contactar-te em breve para combinar o pagamento e a entrega.": "La boutique a bien reçu votre commande et vous contactera bientôt pour convenir du paiement et de la livraison.", "Continuar a comprar": "Continuer mes achats", "Copiado": "Copié", "Confirma no teu telemóvel": "Confirmez sur votre téléphone", "Enviámos o pedido de pagamento para o teu número. Introduz o PIN para confirmar.": "Nous avons envoyé la demande de paiement à votre numéro. Saisissez votre code PIN pour confirmer.", "Pagamento confirmado!": "Paiement confirmé !", "Obrigado pela tua compra. A loja já recebeu a tua encomenda.": "Merci pour votre achat. La boutique a bien reçu votre commande.", "Ainda não recebemos a confirmação. Se já pagaste, aguarda - a loja recebe a encomenda assim que o pagamento chegar.": "Nous n'avons pas encore reçu la confirmation. Si vous avez déjà payé, patientez - la boutique reçoit la commande dès l'arrivée du paiement.", "Não foi possível carregar os produtos. Recarrega a página.": "Impossible de charger les produits. Veuillez recharger la page.", "Fechar": "Fermer", "Anterior": "Précédent", "Seguinte": "Suivant", "{n} de 5 estrelas": "{n} sur 5 étoiles", "Esgotado": "Épuisé", "Só restam {n} unidades.": "Plus que {n} en stock.", "Só restam {n} unidades": "Plus que {n} en stock", "Só resta 1 unidade": "Plus que 1 en stock", "Novidades": "Nouveautés", "Promoções": "Promotions", "Mais vendidos": "Meilleures ventes", "Novo": "Nouveau", "desde": "à partir de", "Categorias": "Catégories", "Oferta relâmpago": "Vente flash", "Termina em": "Se termine dans", "dias": "jours", "h": "h", "min": "min", "seg": "s", "Todos os produtos": "Tous les produits", "Vistos recentemente": "Vus récemment", "Limpar": "Effacer", "Opção": "Option", "Em stock": "En stock", "Escolhe uma opção.": "Choisissez une option.", "Também vais gostar": "Vous aimerez aussi", "Avaliações": "Avis", "{n} avaliação": "{n} avis", "{n} avaliações": "{n} avis", "Escrever avaliação": "Écrire un avis", "Ainda sem avaliações. Sê o primeiro a avaliar!": "Pas encore d'avis. Soyez le premier à donner votre avis !", "A tua nota": "Votre note", "Comentário (opcional)": "Commentaire (facultatif)", "Enviar avaliação": "Envoyer l'avis", "Escolhe de 1 a 5 estrelas.": "Choisissez de 1 à 5 étoiles.", "Não foi possível enviar a avaliação.": "Impossible d'envoyer l'avis.", "Obrigado! A tua avaliação aparece depois de a loja a aprovar.": "Merci ! Votre avis apparaîtra après validation par la boutique.", "Só restam {n} de \\"{nome}\\".": "Plus que {n} « {nome} » en stock.", "\\"{nome}\\" está esgotado.": "« {nome} » est épuisé.", "Escolhe uma opção para \\"{nome}\\".": "Choisissez une option pour « {nome} ».", "Só resta 1 de \\"{nome}\\".": "Plus qu'un « {nome} » en stock.", "Mais produtos": "Plus de produits", "Produto {n}": "Produit {n}", "Os teus produtos reais aparecem aqui, com fotos, preços e opções.": "Vos vrais produits apparaissent ici, avec photos, prix et options.", "Pré-visualização: aqui o cliente juntaria o produto ao carrinho.": "Aperçu : ici, le client ajouterait le produit au panier.", "Pré-visualização com produtos de exemplo - os teus aparecem aqui.": "Aperçu avec des produits d'exemple - les vôtres apparaîtront ici.", "Clássicos": "Classiques", "Edição limitada": "Édition limitée", "Recomendado para ti": "Recommandé pour vous", "Categoria": "Catégorie", "Promoção": "Promo", "Até {n}% de desconto": "Jusqu'à -{n} %", "Ver ofertas": "Voir les offres", "Colecção": "Collection", "Explorar categorias": "Explorer les catégories", "Compra por categoria": "Acheter par catégorie", "Ofertas da semana": "Offres de la semaine", "Mais recentes": "Plus récents", "Preço mais baixo": "Prix le plus bas", "Preço mais alto": "Prix le plus élevé", "Ordenar": "Trier", "Mostrar mais": "Voir plus", "A mostrar {a} de {b}": "Affichage de {a} sur {b}", "Pagamento recebido. A confirmar...": "Paiement reçu. Confirmation...", "Pagamento seguro": "Paiement sécurisé", "O banco abre o pagamento numa janela segura. Paga e volta para aqui - esta página confirma sozinha.": "Votre banque ouvre le paiement dans une fenêtre sécurisée. Payez puis revenez ici - cette page le confirme automatiquement.", "Abrir pagamento seguro": "Ouvrir le paiement sécurisé", "Não aparece? Abrir numa janela nova": "Rien ne s'affiche ? Ouvrir dans une nouvelle fenêtre", "À espera da confirmação do pagamento...": "En attente de la confirmation du paiement...", "Ainda à espera. Se já pagaste, a confirmação pode demorar um pouco.": "Toujours en attente. Si vous avez déjà payé, la confirmation peut prendre un moment.", "Adicionar": "Ajouter", "Preços desde": "Prix à partir de", "Ver tudo": "Tout voir", "Destaque": "À la une", "Ver produto": "Voir le produit", "Filtros": "Filtres", "Preço": "Prix", "Mínimo": "Minimum", "Máximo": "Maximum", "Mostrar só": "Afficher seulement", "4 estrelas ou mais": "4 étoiles et plus", "Em promoção": "En promotion", "Limpar filtros": "Effacer les filtres", "Ver resultados": "Voir les résultats", "Vista em grelha": "Vue en grille", "Vista em lista": "Vue en liste", "Ver todos os produtos": "Voir tous les produits", "{n} produtos, com filtros por categoria e preço": "{n} produits, avec des filtres par catégorie et prix", "Este produto já não está disponível.": "Ce produit n'est plus disponible.", "Início": "Accueil", "Loja": "Boutique", "Melhores ofertas para ti": "Les meilleures offres pour vous", "Os mais pedidos": "Les plus commandés", "Entrega rápida": "Livraison rapide", "Bons preços": "Bons prix", "Qualidade garantida": "Qualité garantie", "Até": "Jusqu'à", "Fresco": "Frais", "Saboroso": "Savoureux", "Rápido": "Rapide", "Encomendar agora": "Commander", "Ingredientes frescos": "Ingrédients frais"}, "es": {"{nome} adicionado ao carrinho": "{nome} añadido al carrito", "Pesquisar produtos": "Buscar productos", "Abrir carrinho": "Abrir carrito", "Carrinho": "Carrito", "O teu carrinho": "Tu carrito", "Total": "Total", "Finalizar compra": "Finalizar compra", "A nossa loja": "Nuestra tienda", "{n} produtos à tua espera. Escolhe, encomenda e recebe.": "{n} productos te esperan. Elige, pide y recibe.", "Descobre os nossos produtos.": "Descubre nuestros productos.", "Ver produtos": "Ver productos", "Imagem {n}": "Imagen {n}", "Outros": "Otros", "Tudo": "Todo", "Em destaque": "Destacados", "Adicionar {nome} ao carrinho": "Añadir {nome} al carrito", "Ainda não há produtos à venda aqui.": "Todavía no hay productos a la venta.", "Nenhum produto encontrado para \\"{t}\\".": "No se encontraron productos para \\"{t}\\".", "Nenhum produto encontrado.": "No se encontraron productos.", "Ver todos": "Ver todos", "Resultados": "Resultados", "Produtos": "Productos", "{n} produto": "{n} producto", "{n} produtos": "{n} productos", "Poupas {v}": "Ahorras {v}", "Quantidade": "Cantidad", "Menos": "Menos", "Mais": "Más", "Adicionar ao carrinho": "Añadir al carrito", "Comprar agora": "Comprar ahora", "O teu carrinho está vazio.": "Tu carrito está vacío.", "Remover": "Quitar", "Confirmar encomenda": "Confirmar pedido", "Cartão": "Tarjeta", "Como queres pagar?": "¿Cómo quieres pagar?", "Pagar {v}": "Pagar {v}", "Depois de confirmares, paga directamente à loja para um destes números, com a referência que te vamos dar:": "Después de confirmar, paga directamente a la tienda a uno de estos números, con la referencia que te daremos:", "Em nome de": "A nombre de", "A loja confirma o pagamento e prepara a tua encomenda.": "La tienda confirmará el pago y preparará tu pedido.", "Encomendar pelo WhatsApp": "Pedir por WhatsApp", "Enviar encomenda": "Enviar pedido", "Preenche os teus dados e enviamos a encomenda para o WhatsApp da loja.": "Rellena tus datos y enviaremos el pedido al WhatsApp de la tienda.", "A loja recebe a tua encomenda e contacta-te para combinar o pagamento e a entrega.": "La tienda recibe tu pedido y te contactará para acordar el pago y la entrega.", "Só falta isto para receberes a tua encomenda.": "Solo falta esto para recibir tu pedido.", "{n} artigo": "{n} artículo", "{n} artigos": "{n} artículos", "O teu nome": "Tu nombre", "Telefone": "Teléfono", "(o mesmo da carteira, para M-Pesa/e-Mola)": "(el mismo de tu billetera M-Pesa/e-Mola)", "Email (opcional, para receberes a confirmação)": "Correo (opcional, para recibir la confirmación)", "Morada de entrega / notas (opcional)": "Dirección de entrega / notas (opcional)", "Escreve o teu nome.": "Escribe tu nombre.", "Escreve o teu número de telefone.": "Escribe tu número de teléfono.", "Esse email não parece válido - podes deixá-lo em branco.": "Ese correo no parece válido - puedes dejarlo en blanco.", "Escolhe como queres pagar.": "Elige cómo quieres pagar.", "A processar...": "Procesando...", "Não foi possível criar a encomenda.": "No se pudo crear el pedido.", "Não foi possível iniciar o pagamento.": "No se pudo iniciar el pago.", "Algo correu mal. Tenta novamente.": "Algo salió mal. Inténtalo de nuevo.", "Encomenda enviada!": "¡Pedido enviado!", "Para concluir, paga {v} com a referência {r}:": "Para terminar, paga {v} con la referencia {r}:", "Copiar": "Copiar", "Enviar comprovativo no WhatsApp": "Enviar comprobante por WhatsApp", "Abrimos o WhatsApp com a tua encomenda já escrita - só tens de carregar em enviar.": "Abrimos WhatsApp con tu pedido ya escrito - solo tienes que pulsar enviar.", "Abrir o WhatsApp outra vez": "Abrir WhatsApp otra vez", "A loja recebeu a tua encomenda e vai contactar-te em breve para combinar o pagamento e a entrega.": "La tienda ha recibido tu pedido y te contactará pronto para acordar el pago y la entrega.", "Continuar a comprar": "Seguir comprando", "Copiado": "Copiado", "Confirma no teu telemóvel": "Confirma en tu móvil", "Enviámos o pedido de pagamento para o teu número. Introduz o PIN para confirmar.": "Enviamos la solicitud de pago a tu número. Introduce tu PIN para confirmar.", "Pagamento confirmado!": "¡Pago confirmado!", "Obrigado pela tua compra. A loja já recebeu a tua encomenda.": "Gracias por tu compra. La tienda ya recibió tu pedido.", "Ainda não recebemos a confirmação. Se já pagaste, aguarda - a loja recebe a encomenda assim que o pagamento chegar.": "Todavía no hemos recibido la confirmación. Si ya pagaste, espera - la tienda recibe el pedido en cuanto llegue el pago.", "Não foi possível carregar os produtos. Recarrega a página.": "No se pudieron cargar los productos. Recarga la página.", "Fechar": "Cerrar", "Anterior": "Anterior", "Seguinte": "Siguiente", "{n} de 5 estrelas": "{n} de 5 estrellas", "Esgotado": "Agotado", "Só restam {n} unidades.": "Solo quedan {n} unidades.", "Só restam {n} unidades": "Solo quedan {n} unidades", "Só resta 1 unidade": "Solo queda 1 unidad", "Novidades": "Novedades", "Promoções": "Ofertas", "Mais vendidos": "Más vendidos", "Novo": "Nuevo", "desde": "desde", "Categorias": "Categorías", "Oferta relâmpago": "Oferta relámpago", "Termina em": "Termina en", "dias": "días", "h": "h", "min": "min", "seg": "seg", "Todos os produtos": "Todos los productos", "Vistos recentemente": "Vistos recientemente", "Limpar": "Borrar", "Opção": "Opción", "Em stock": "En stock", "Escolhe uma opção.": "Elige una opción.", "Também vais gostar": "También te gustará", "Avaliações": "Reseñas", "{n} avaliação": "{n} reseña", "{n} avaliações": "{n} reseñas", "Escrever avaliação": "Escribir una reseña", "Ainda sem avaliações. Sê o primeiro a avaliar!": "Aún no hay reseñas. ¡Sé el primero en opinar!", "A tua nota": "Tu valoración", "Comentário (opcional)": "Comentario (opcional)", "Enviar avaliação": "Enviar reseña", "Escolhe de 1 a 5 estrelas.": "Elige de 1 a 5 estrellas.", "Não foi possível enviar a avaliação.": "No se pudo enviar la reseña.", "Obrigado! A tua avaliação aparece depois de a loja a aprovar.": "¡Gracias! Tu reseña aparecerá cuando la tienda la apruebe.", "Só restam {n} de \\"{nome}\\".": "Solo quedan {n} de \\"{nome}\\".", "\\"{nome}\\" está esgotado.": "\\"{nome}\\" está agotado.", "Escolhe uma opção para \\"{nome}\\".": "Elige una opción para \\"{nome}\\".", "Só resta 1 de \\"{nome}\\".": "Solo queda 1 de \\"{nome}\\".", "Mais produtos": "Más productos", "Produto {n}": "Producto {n}", "Os teus produtos reais aparecem aqui, com fotos, preços e opções.": "Tus productos reales aparecen aquí, con fotos, precios y opciones.", "Pré-visualização: aqui o cliente juntaria o produto ao carrinho.": "Vista previa: aquí el cliente añadiría el producto al carrito.", "Pré-visualização com produtos de exemplo - os teus aparecem aqui.": "Vista previa con productos de ejemplo - los tuyos aparecerán aquí.", "Clássicos": "Clásicos", "Edição limitada": "Edición limitada", "Recomendado para ti": "Recomendado para ti", "Categoria": "Categoría", "Promoção": "Oferta", "Até {n}% de desconto": "Hasta {n}% de descuento", "Ver ofertas": "Ver ofertas", "Colecção": "Colección", "Explorar categorias": "Explorar categorías", "Compra por categoria": "Compra por categoría", "Ofertas da semana": "Ofertas de la semana", "Mais recentes": "Más recientes", "Preço mais baixo": "Precio más bajo", "Preço mais alto": "Precio más alto", "Ordenar": "Ordenar", "Mostrar mais": "Mostrar más", "A mostrar {a} de {b}": "Mostrando {a} de {b}", "Pagamento recebido. A confirmar...": "Pago recibido. Confirmando...", "Pagamento seguro": "Pago seguro", "O banco abre o pagamento numa janela segura. Paga e volta para aqui - esta página confirma sozinha.": "Tu banco abre el pago en una ventana segura. Paga y vuelve aquí: esta página lo confirma sola.", "Abrir pagamento seguro": "Abrir pago seguro", "Não aparece? Abrir numa janela nova": "¿No aparece? Abrir en una ventana nueva", "À espera da confirmação do pagamento...": "Esperando la confirmación del pago...", "Ainda à espera. Se já pagaste, a confirmação pode demorar um pouco.": "Seguimos esperando. Si ya pagaste, la confirmación puede tardar un poco.", "Adicionar": "Añadir", "Preços desde": "Precios desde", "Ver tudo": "Ver todo", "Destaque": "Destacado", "Ver produto": "Ver producto", "Filtros": "Filtros", "Preço": "Precio", "Mínimo": "Mínimo", "Máximo": "Máximo", "Mostrar só": "Mostrar solo", "4 estrelas ou mais": "4 estrellas o más", "Em promoção": "En oferta", "Limpar filtros": "Borrar filtros", "Ver resultados": "Ver resultados", "Vista em grelha": "Vista en cuadrícula", "Vista em lista": "Vista en lista", "Ver todos os produtos": "Ver todos los productos", "{n} produtos, com filtros por categoria e preço": "{n} productos, con filtros por categoría y precio", "Este produto já não está disponível.": "Este producto ya no está disponible.", "Início": "Inicio", "Loja": "Tienda", "Melhores ofertas para ti": "Las mejores ofertas para ti", "Os mais pedidos": "Los más pedidos", "Entrega rápida": "Entrega rápida", "Bons preços": "Buenos precios", "Qualidade garantida": "Calidad garantizada", "Até": "Hasta", "Fresco": "Fresco", "Saboroso": "Sabroso", "Rápido": "Rápido", "Encomendar agora": "Pedir ahora", "Ingredientes frescos": "Ingredientes frescos"}};
  function tx(s, v){
    var d = DIA_TXT[DIA_LANG];
    var r = (d && d[s]) || s;
    if (v) { for (var k in v) { r = r.split('{' + k + '}').join(String(v[k])); } }
    return r;
  }
  var CONTAINER_URL = 'https://mc-8oxfde5o71.bunny.run';
  var SITE_ID = window.DANIEL_IA_SITE_ID || '';
  if (!SITE_ID) {
    console.error('Daniel IA: falta window.DANIEL_IA_SITE_ID nesta página - o módulo da loja não pode arrancar.');
    return;
  }

  var CART_KEY = 'daniel_ia_carrinho_' + SITE_ID;
  var VISTOS_KEY = 'daniel_ia_vistos_' + SITE_ID;
  // ---- Lojas com várias páginas (1.60.0) ----
  // index.html (montra), loja.html (todos os produtos com filtros) e
  // produto.html?id=... (cada produto na sua página). Nas versões do estúdio
  // (pré-visualização) as páginas ainda não existem: fica tudo na mesma página.
  function metaDe(n){ var m = document.querySelector('meta[name="' + n + '"]'); return m ? (m.getAttribute('content') || '') : ''; }
  var MULTI = !!metaDe('daniel-ia-paginas');
  var PAGINA = (metaDe('daniel-ia-pagina') || 'inicio').toLowerCase();
  var NAVEGAR = MULTI && !/[?&]dia_previa=1/.test(window.location.search) && !/\\/v\\d+\\.html$/i.test(window.location.pathname);
  var EM_PAGINA_PRODUTO = false;
  function paramUrl(n){ try { return new URLSearchParams(window.location.search).get(n) || ''; } catch (e) { return ''; } }
  function irParaPagina(ficheiro, params){
    var q = [];
    Object.keys(params || {}).forEach(function(k){ if (params[k]) q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k])); });
    window.location.href = ficheiro + (q.length ? '?' + q.join('&') : '');
  }
  var produtos = [];
  var loja = { nome: '', capa: [], modo: 'pedido', metodos: [], manual: null, whatsapp: '', montra: null };
  var carrinho = lerCarrinho();
  var filtro = { categoria: '', texto: '' };
  var temporizadores = [];
  var OUTROS = tx('Outros');
  var MONTRA_PADRAO = {
    estilo: { cartao: 'suave', colunas: 4 },
    blocos: [
      { id: 'capa', tipo: 'capa', activo: true },
      { id: 'cats', tipo: 'categorias', activo: true, formato: 'circulos', imagens: {} },
      { id: 'dest', tipo: 'fila', activo: true, fonte: 'destaques' },
      { id: 'promo', tipo: 'fila', activo: true, fonte: 'promocoes' },
      { id: 'cat', tipo: 'catalogo', activo: true },
      { id: 'vistos', tipo: 'vistos', activo: true }
    ]
  };

  // ======================================================
  // Utilitários
  // ======================================================
  function $(id){ return document.getElementById(id); }
  function esc(t){
    return String(t == null ? '' : t)
      .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
      .split('"').join('&quot;').split("'").join('&#39;');
  }
  function mzn(v){ return Number(v || 0).toLocaleString(DIA_LOCALE) + ' MZN'; }
  function desconto(p){
    if (!p.preco_antigo || p.preco_antigo <= p.preco) return 0;
    return Math.round((1 - p.preco / p.preco_antigo) * 100);
  }
  function post(caminho, corpo){
    return fetch(CONTAINER_URL + caminho, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    }).then(function(r){ return r.json(); });
  }
  function soDigitos(t){
    var s = String(t || ''), r = '';
    for (var i = 0; i < s.length; i++) { if (s[i] >= '0' && s[i] <= '9') r += s[i]; }
    return r;
  }
  function emailValido(e){
    var a = e.indexOf('@');
    return a > 0 && e.indexOf('.', a) > a + 1 && e.indexOf(' ') === -1;
  }
  function normalizar(t){
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function produtoPorId(id){
    for (var i = 0; i < produtos.length; i++) { if (produtos[i].id === id) return produtos[i]; }
    return null;
  }
  function cada(lista, fn){ Array.prototype.forEach.call(lista, fn); }
  // "Novo" só nos mais recentes (cerca de 1/4 da loja, criados há menos de
  // 21 dias) - numa loja acabada de abrir, se todos fossem novos o selo perdia sentido.
  var novosCache = { lista: null, ids: {} };
  function eNovo(p){
    if (novosCache.lista !== produtos) {
      var limite = Date.now() - 21 * 24 * 3600 * 1000;
      var quantos = Math.max(2, Math.round(produtos.length / 4));
      var ids = {};
      produtos.map(function(x){ return { id: x.id, t: Date.parse(x.criado || '') }; })
        .filter(function(x){ return !isNaN(x.t) && x.t > limite; })
        .sort(function(a, b){ return b.t - a.t; })
        .slice(0, quantos)
        .forEach(function(x){ ids[x.id] = true; });
      novosCache = { lista: produtos, ids: ids };
    }
    return !!novosCache.ids[p.id];
  }
  // Fundo desfocado feito com a própria foto: a foto aparece inteira (sem
  // cortes) e todas as fotos da loja ficam com o mesmo formato.
  function fundoDe(src){
    var u = String(src || '').replace(/["\\\\\\n\\r]/g, function(c){ return encodeURIComponent(c); });
    return '<span class="dia-img-fundo" style="background-image:url(&quot;' + esc(u) + '&quot;)"></span>';
  }
  function imagemDe(p){ return (p.imagens && p.imagens[0]) || p.imagem || ''; }
  // Preço e stock de uma opção (ou do produto, sem opções).
  function precoDe(p, vi){ var v = (vi !== null && vi !== undefined && p.variantes) ? p.variantes[vi] : null; return v ? v.preco : p.preco; }
  function stockDe(p, vi){
    if (p.variantes && p.variantes.length) {
      if (vi === null || vi === undefined) return p.stock;
      var v = p.variantes[vi];
      return v ? (v.stock === null || v.stock === undefined ? null : v.stock) : 0;
    }
    return (p.stock === null || p.stock === undefined) ? null : p.stock;
  }
  function precoMinimo(p){
    if (!p.variantes || !p.variantes.length) return p.preco;
    return p.variantes.reduce(function(m, v){ return Math.min(m, v.preco); }, Infinity);
  }
  function temPrecosDiferentes(p){
    if (!p.variantes || p.variantes.length < 2) return false;
    var a = p.variantes[0].preco;
    return p.variantes.some(function(v){ return v.preco !== a; });
  }
  function estrelas(media){
    var html = '';
    for (var i = 1; i <= 5; i++) {
      var cheio = media >= i ? 100 : (media > i - 1 ? Math.round((media - i + 1) * 100) : 0);
      html += '<span class="dia-estrela"><span style="width:' + cheio + '%"></span></span>';
    }
    return '<span class="dia-estrelas" aria-label="' + esc(tx('{n} de 5 estrelas', { n: media })) + '">' + html + '</span>';
  }

  var ICONES = {
    cadeado: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    carrinho: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1.4"/><circle cx="19" cy="21" r="1.4"/><path d="M2.5 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.3a2 2 0 0 0 2-1.5L22 7H6.2"/></svg>',
    lupa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    mais: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    fechar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
    seta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
    estrela: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>',
    whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.7a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.2-.2-.5-.3z"/></svg>',
    certo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    copiar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    caixa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><line x1="12" y1="13" x2="12" y2="21"/></svg>',
    raio: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 2 4 13.5h6.5L9.5 22 20 9.5h-6.6z"/></svg>',
    megafone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    relogio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
    olho: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
  };

  // ======================================================
  // Carrinho (guardado no browser de quem compra)
  // Chave de cada linha: id do produto, ou id::opção.
  // ======================================================
  function lerCarrinho(){
    try { var d = localStorage.getItem(CART_KEY); return d ? JSON.parse(d) : {}; } catch (e) { return {}; }
  }
  function guardarCarrinho(){
    try { localStorage.setItem(CART_KEY, JSON.stringify(carrinho)); } catch (e) {}
  }
  function limparCarrinho(){ carrinho = {}; guardarCarrinho(); }
  function chaveDe(id, vi){ return (vi === null || vi === undefined) ? id : id + '::' + vi; }
  function itensDoCarrinho(){
    return Object.keys(carrinho).filter(function(k){ return carrinho[k] > 0; }).map(function(k){
      var partes = k.split('::');
      var p = produtoPorId(partes[0]);
      if (!p) return null;
      var vi = partes.length > 1 ? parseInt(partes[1], 10) : null;
      var temOpcoes = p.variantes && p.variantes.length;
      if (temOpcoes && (vi === null || !p.variantes[vi])) return null;
      if (!temOpcoes) vi = null;
      return {
        chave: k, produto: p, variante: vi, quantidade: carrinho[k],
        preco: precoDe(p, vi),
        nome: p.nome + (vi !== null ? ' (' + p.variantes[vi].nome + ')' : '')
      };
    }).filter(function(x){ return x; });
  }
  function adicionar(id, vi, qtd){
    if (PREVIA && String(id).indexOf('exemplo') === 0) { toast(tx('Pré-visualização: aqui o cliente juntaria o produto ao carrinho.')); return false; }
    var p = produtoPorId(id);
    if (!p) return false;
    if (p.variantes && p.variantes.length && (vi === null || vi === undefined)) { abrirProduto(id); return false; }
    var chave = chaveDe(id, vi);
    var limite = stockDe(p, vi);
    var novo = (carrinho[chave] || 0) + (qtd || 1);
    if (limite !== null && novo > limite) {
      toast(limite === 0 ? tx('Esgotado') : tx('Só restam {n} unidades.', { n: limite }), true);
      return false;
    }
    carrinho[chave] = Math.min(99, novo);
    guardarCarrinho();
    renderCarrinho();
    var b = $('dia-carrinho-botao');
    if (b) { b.classList.remove('dia-pulo'); void b.offsetWidth; b.classList.add('dia-pulo'); }
    toast(tx('{nome} adicionado ao carrinho', { nome: p.nome }));
    return true;
  }

  var temporizadorToast = null;
  function toast(texto, aviso){
    var t = $('dia-toast');
    if (!t) return;
    t.innerHTML = (aviso ? '' : ICONES.certo) + '<span>' + esc(texto) + '</span>';
    t.classList.toggle('dia-aviso', !!aviso);
    t.classList.add('dia-visivel');
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(function(){ t.classList.remove('dia-visivel'); }, 2400);
  }

  // Vistos recentemente (no browser de quem visita)
  function lerVistos(){ try { return JSON.parse(localStorage.getItem(VISTOS_KEY) || '[]') || []; } catch (e) { return []; } }
  function marcarVisto(id){
    var l = lerVistos().filter(function(x){ return x !== id; });
    l.unshift(id);
    try { localStorage.setItem(VISTOS_KEY, JSON.stringify(l.slice(0, 16))); } catch (e) {}
  }

  // ======================================================
  // Estilos
  // ======================================================
  function injectarEstilos(){
    var css = [
      '.dia-loja,.dia-carrinho-botao,.dia-painel-carrinho,.dia-overlay,.dia-toast{--_p:var(--dia-primaria,#111);--_pt:var(--dia-primaria-texto,#fff);--_r:var(--dia-raio,14px);--_ft:var(--dia-fonte-titulos,inherit);}',
      '.dia-loja{--_p:var(--dia-primaria,currentColor);--_s:var(--dia-superficie,color-mix(in srgb,currentColor 4%,transparent));--_t:var(--dia-texto,currentColor);--_ts:var(--dia-texto-suave,color-mix(in srgb,currentColor 62%,transparent));--_b:var(--dia-borda,color-mix(in srgb,currentColor 13%,transparent));--_f:var(--dia-fundo,Canvas);color:var(--_t);font-family:inherit;}',
      '.dia-loja *,.dia-overlay,.dia-overlay *,.dia-painel-carrinho,.dia-painel-carrinho *,.dia-carrinho-botao,.dia-toast{box-sizing:border-box;}',
      '.dia-bloco{margin:0 0 30px;}',
      '.dia-bloco:empty{display:none;}',
      /* anúncio */
      '.dia-anuncio{display:flex;align-items:center;justify-content:center;gap:10px;text-align:center;padding:11px 18px;border-radius:calc(var(--_r) - 2px);font-size:14px;font-weight:700;line-height:1.4;}',
      '.dia-anuncio svg{width:18px;height:18px;flex-shrink:0;}',
      '.dia-cor-primaria{background:var(--_p);color:var(--_pt);}',
      '.dia-cor-escuro{background:#111;color:#fff;}',
      '.dia-cor-destaque{background:linear-gradient(90deg,#F59E0B,#E11D48);color:#fff;}',
      /* capa */
      '.dia-capa{position:relative;border-radius:calc(var(--_r) + 8px);overflow:hidden;height:clamp(230px,44vw,480px);isolation:isolate;background:color-mix(in srgb,var(--_p) 18%,transparent);}',
      '.dia-slide{position:absolute;inset:0;opacity:0;transition:opacity .9s ease;}',
      '.dia-slide.dia-activo{opacity:1;z-index:1;}',
      '.dia-slide img{width:100%;height:100%;object-fit:cover;transform:scale(1.06);transition:transform 6s ease;}',
      '.dia-slide.dia-activo img{transform:scale(1);}',
      '.dia-slide::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.62) 0%,rgba(0,0,0,.25) 55%,rgba(0,0,0,0) 100%);}',
      '.dia-slide-texto{position:absolute;z-index:2;left:clamp(20px,5vw,56px);bottom:clamp(26px,6vw,64px);right:20px;max-width:560px;color:#fff;}',
      '.dia-slide-titulo{font-family:var(--_ft);font-weight:800;font-size:clamp(26px,4.6vw,52px);line-height:1.05;letter-spacing:-.025em;margin:0 0 10px;text-shadow:0 2px 24px rgba(0,0,0,.35);}',
      '.dia-slide-sub{font-size:clamp(14px,1.6vw,18px);line-height:1.5;opacity:.92;margin:0 0 18px;max-width:440px;}',
      '.dia-slide-btn{display:inline-flex;align-items:center;gap:8px;background:#fff;color:#111;border:none;border-radius:999px;padding:12px 22px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;transition:transform .2s ease,box-shadow .2s ease;}',
      '.dia-slide-btn:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(0,0,0,.3);}',
      '.dia-slide-btn svg{width:16px;height:16px;}',
      '.dia-capa-gerada{position:absolute;inset:0;background:radial-gradient(circle at 85% 20%,color-mix(in srgb,var(--_p) 70%,#fff) 0%,transparent 45%),linear-gradient(135deg,var(--_p) 0%,color-mix(in srgb,var(--_p) 55%,#000) 100%);}',
      '.dia-capa-gerada::before{content:"";position:absolute;width:62%;aspect-ratio:1;right:-12%;top:-30%;border-radius:50%;border:2px solid rgba(255,255,255,.18);box-shadow:0 0 0 40px rgba(255,255,255,.05),0 0 0 90px rgba(255,255,255,.035);}',
      '.dia-capa-pontos{position:absolute;z-index:3;left:0;right:0;bottom:16px;display:flex;justify-content:center;gap:7px;}',
      '.dia-ponto{width:8px;height:8px;border-radius:999px;border:none;background:rgba(255,255,255,.5);cursor:pointer;padding:0;transition:width .3s ease,background .3s ease;}',
      '.dia-ponto.dia-activo{width:26px;background:#fff;}',
      '.dia-capa-seta{position:absolute;z-index:3;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:50%;border:none;background:rgba(255,255,255,.85);color:#111;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s ease;}',
      '.dia-capa:hover .dia-capa-seta{opacity:1;}',
      '.dia-capa-seta svg,.dia-fila-seta svg,.dia-gal-seta svg{width:18px;height:18px;}',
      '.dia-capa-seta.dia-esq{left:14px;}.dia-esq svg{transform:rotate(180deg);}',
      '.dia-capa-seta.dia-dir{right:14px;}',
      /* barra: pesquisa + categorias */
      '.dia-barra{position:sticky;top:0;z-index:20;display:flex;flex-direction:column;gap:10px;padding:10px 0;margin:-6px 0 18px;background:linear-gradient(var(--_f) 72%,color-mix(in srgb,var(--_f) 0%,transparent));}',
      '.dia-pesquisa{display:flex;align-items:center;gap:10px;background:var(--_s);border:1px solid var(--_b);border-radius:999px;padding:0 6px 0 16px;height:50px;transition:border-color .2s ease,box-shadow .2s ease;}',
      '.dia-pesquisa:focus-within{border-color:var(--_p);box-shadow:0 0 0 4px color-mix(in srgb,var(--_p) 16%,transparent);}',
      '.dia-pesquisa > svg{width:19px;height:19px;color:var(--_ts);flex-shrink:0;}',
      '.dia-pesquisa input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--_t);font-size:15px;font-family:inherit;height:100%;}',
      '.dia-pesquisa input::placeholder{color:var(--_ts);}',
      '.dia-limpar{border:none;background:color-mix(in srgb,var(--_t) 8%,transparent);color:var(--_t);border-radius:999px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;display:none;}',
      '.dia-filtrando .dia-limpar{display:inline-flex;}',
      '.dia-categorias{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px;}',
      '.dia-categorias::-webkit-scrollbar{display:none;}',
      '.dia-chip{flex-shrink:0;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--_b);background:var(--_s);color:var(--_t);border-radius:999px;padding:8px 15px;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s ease;white-space:nowrap;}',
      '.dia-chip small{font-weight:600;opacity:.6;font-size:11.5px;}',
      '.dia-chip:hover{border-color:color-mix(in srgb,var(--_p) 55%,transparent);}',
      '.dia-chip.dia-activo{background:var(--dia-primaria,currentColor);color:var(--dia-primaria-texto,var(--_f));border-color:transparent;}',
      '.dia-filtrando #dia-montra{display:none;}',
      '#dia-resultados{display:none;}',
      '.dia-filtrando #dia-resultados{display:block;}',
      /* secções e filas */
      '.dia-seccao-topo{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;}',
      '.dia-seccao-titulo{font-family:var(--_ft);font-weight:800;font-size:clamp(20px,2.4vw,26px);letter-spacing:-.02em;margin:0;display:flex;align-items:center;gap:8px;}',
      '.dia-seccao-titulo svg{width:20px;height:20px;color:var(--_p);}',
      '.dia-topo-accoes{display:flex;align-items:center;gap:8px;}',
      '.dia-ver-todos{background:none;border:none;color:var(--_ts);font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}',
      '.dia-ver-todos:hover{color:var(--_t);}',
      '.dia-ver-todos svg{width:14px;height:14px;}',
      '.dia-fila-seta{width:36px;height:36px;border-radius:50%;border:1px solid var(--_b);background:var(--_s);color:var(--_t);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:border-color .2s ease;}',
      '.dia-fila-seta:hover{border-color:var(--_p);}',
      '.dia-fila{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(190px,220px);gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;padding:4px 2px 12px;scrollbar-width:none;}',
      '.dia-fila::-webkit-scrollbar{display:none;}',
      '.dia-fila > *{scroll-snap-align:start;}',
      '.dia-grelha{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;}',
      '.dia-cols-3 .dia-grelha{grid-template-columns:repeat(3,minmax(0,1fr));}',
      '.dia-cols-5 .dia-grelha{grid-template-columns:repeat(5,minmax(0,1fr));}',
      '.dia-cols-6 .dia-grelha{grid-template-columns:repeat(6,minmax(0,1fr));gap:14px;}',
      '@media (max-width:1100px){.dia-cols-6 .dia-grelha,.dia-cols-5 .dia-grelha{grid-template-columns:repeat(4,minmax(0,1fr));}}',
      '@media (max-width:860px){.dia-loja .dia-grelha{grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;}}',
      '@media (max-width:560px){.dia-loja .dia-grelha{grid-template-columns:1fr 1fr;gap:10px;}.dia-fila{grid-auto-columns:minmax(150px,44%);gap:10px;}.dia-fila-seta{display:none;}.dia-bloco{margin-bottom:24px;}}',
      /* categorias com imagem */
      '.dia-cat-circulos{display:flex;gap:18px;overflow-x:auto;scrollbar-width:none;padding:4px 2px 8px;}',
      '.dia-cat-circulos::-webkit-scrollbar{display:none;}',
      '.dia-cat-circulo{flex-shrink:0;width:96px;display:flex;flex-direction:column;align-items:center;gap:8px;background:none;border:none;color:var(--_t);cursor:pointer;font-family:inherit;font-size:13px;font-weight:700;text-align:center;}',
      '.dia-cat-circulo .dia-cat-img{width:84px;height:84px;border-radius:50%;overflow:hidden;background:color-mix(in srgb,var(--_p) 14%,transparent);box-shadow:0 0 0 2px var(--_f),0 0 0 4px color-mix(in srgb,var(--_p) 35%,transparent);transition:transform .25s ease,box-shadow .25s ease;display:flex;align-items:center;justify-content:center;}',
      '.dia-cat-circulo:hover .dia-cat-img{transform:translateY(-3px);box-shadow:0 0 0 2px var(--_f),0 0 0 4px var(--_p);}',
      '.dia-cat-img img{width:100%;height:100%;object-fit:cover;}',
      '.dia-cat-letra{font-family:var(--_ft);font-weight:800;font-size:28px;color:var(--_p);}',
      '.dia-cat-cartoes{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px;}',
      '.dia-cat-cartao{position:relative;aspect-ratio:4/3;border-radius:var(--_r);overflow:hidden;border:none;padding:0;cursor:pointer;background:color-mix(in srgb,var(--_p) 18%,transparent);font-family:inherit;isolation:isolate;}',
      '.dia-cat-cartao img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:transform .5s ease;z-index:-1;}',
      '.dia-cat-cartao:hover img{transform:scale(1.06);}',
      '.dia-cat-cartao::after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,rgba(0,0,0,.7),rgba(0,0,0,0) 60%);z-index:-1;}',
      '.dia-cat-cartao span{position:absolute;left:14px;right:14px;bottom:12px;color:#fff;font-family:var(--_ft);font-weight:800;font-size:17px;text-align:left;}',
      '.dia-cat-cartao small{display:block;font-family:inherit;font-weight:600;font-size:12px;opacity:.85;}',
      /* banners */
      '.dia-banners{display:grid;gap:14px;}',
      '.dia-banners.dia-n1{grid-template-columns:1fr;}',
      '.dia-banners.dia-n2{grid-template-columns:1fr 1fr;}',
      '.dia-banners.dia-n3{grid-template-columns:1fr 1fr 1fr;}',
      '.dia-banner{position:relative;display:block;border-radius:calc(var(--_r) + 4px);overflow:hidden;border:none;padding:0;cursor:pointer;text-align:left;font-family:inherit;background:color-mix(in srgb,var(--_p) 14%,transparent);isolation:isolate;}',
      '.dia-n1 .dia-banner{aspect-ratio:21/7;}.dia-n2 .dia-banner{aspect-ratio:16/9;}.dia-n3 .dia-banner{aspect-ratio:4/5;}',
      '.dia-banner img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;transition:transform .6s ease;}',
      '.dia-banner:hover img{transform:scale(1.04);}',
      '.dia-banner.dia-com-texto::after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(0deg,rgba(0,0,0,.65),rgba(0,0,0,0) 65%);}',
      '.dia-banner-texto{position:absolute;left:clamp(14px,3vw,26px);right:14px;bottom:clamp(12px,2.6vw,22px);color:#fff;}',
      '.dia-banner-texto b{display:block;font-family:var(--_ft);font-weight:800;font-size:clamp(17px,2.2vw,26px);line-height:1.15;letter-spacing:-.02em;}',
      '.dia-banner-texto span{display:block;font-size:13.5px;opacity:.9;margin-top:4px;}',
      '@media (max-width:640px){.dia-banners.dia-n2,.dia-banners.dia-n3{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;}.dia-banners::-webkit-scrollbar{display:none;}.dia-n2 .dia-banner,.dia-n3 .dia-banner{flex:0 0 82%;scroll-snap-align:start;aspect-ratio:4/3;}.dia-n1 .dia-banner{aspect-ratio:16/9;}}',
      /* oferta relâmpago */
      '.dia-oferta{border-radius:calc(var(--_r) + 8px);padding:20px 20px 8px;background:radial-gradient(circle at 100% 0%,color-mix(in srgb,#F59E0B 35%,transparent),transparent 45%),linear-gradient(135deg,color-mix(in srgb,var(--_p) 92%,#000),color-mix(in srgb,var(--_p) 60%,#000));color:#fff;}',
      '.dia-oferta-topo{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px;}',
      '.dia-oferta-titulo{display:flex;align-items:center;gap:10px;font-family:var(--_ft);font-weight:800;font-size:clamp(20px,2.6vw,28px);letter-spacing:-.02em;margin:0;}',
      '.dia-oferta-titulo svg{width:26px;height:26px;color:#FCD34D;filter:drop-shadow(0 0 10px rgba(252,211,77,.6));animation:dia-brilhar 1.6s ease-in-out infinite;}',
      '@keyframes dia-brilhar{50%{transform:scale(1.12);}}',
      '.dia-contagem-reg{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;opacity:.95;}',
      '.dia-contagem-reg b{min-width:42px;text-align:center;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:7px 6px 5px;font-size:18px;font-variant-numeric:tabular-nums;line-height:1;}',
      '.dia-contagem-reg b small{display:block;font-size:9.5px;font-weight:700;opacity:.75;margin-top:3px;letter-spacing:.06em;text-transform:uppercase;}',
      '.dia-oferta .dia-produto-card{color:var(--_t);}',
      '.dia-oferta .dia-fila-seta{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.25);color:#fff;}',
      /* cartão de produto */
      '.dia-produto-card{position:relative;display:flex;flex-direction:column;background:var(--_s);border:1px solid var(--_b);border-radius:var(--_r);overflow:hidden;cursor:pointer;transition:transform .25s ease,box-shadow .25s ease,border-color .25s ease;}',
      '.dia-produto-card:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--_p) 40%,transparent);box-shadow:0 22px 40px -22px color-mix(in srgb,var(--_p) 70%,transparent);}',
      '.dia-oferta .dia-produto-card{background:var(--_f);}',
      '.dia-cartao-moldura .dia-produto-card{background:var(--_f);border:1.5px solid color-mix(in srgb,var(--_t) 22%,transparent);padding:8px;}',
      '.dia-cartao-moldura .dia-produto-media{border-radius:calc(var(--_r) - 6px);}',
      '.dia-cartao-moldura .dia-produto-corpo{padding:10px 4px 6px;}',
      '.dia-cartao-minimal .dia-produto-card{background:transparent;border:none;overflow:visible;}',
      '.dia-cartao-minimal .dia-produto-card:hover{box-shadow:none;}',
      '.dia-cartao-minimal .dia-produto-media{border-radius:var(--_r);}',
      '.dia-cartao-minimal .dia-produto-corpo{padding:10px 2px 4px;}',
      '.dia-cartao-minimal .dia-btn-add{bottom:auto;top:calc(100% - 128px);}',
      '.dia-produto-media{position:relative;aspect-ratio:1/1;overflow:hidden;background:color-mix(in srgb,currentColor 6%,transparent);}',
      '.dia-produto-img{position:relative;width:100%;height:100%;object-fit:contain;display:block;transition:transform .5s ease,opacity .4s ease;}',
      '.dia-img-fundo{position:absolute;inset:-14%;background-size:cover;background-position:center;filter:blur(24px) saturate(1.2);opacity:.6;pointer-events:none;}',
      '.dia-produto-img.dia-segunda{position:absolute;inset:0;opacity:0;}',
      '.dia-produto-card:hover .dia-produto-img{transform:scale(1.05);}',
      '.dia-produto-card:hover .dia-produto-img.dia-segunda{opacity:1;}',
      '.dia-demo-arte{position:absolute;inset:0;overflow:hidden;}',
      '.dia-demo-arte i{position:absolute;left:22%;top:20%;width:56%;height:56%;border-radius:32% 46% 40% 34%;background:color-mix(in srgb,var(--_p) 70%,#fff);box-shadow:0 22px 40px -18px color-mix(in srgb,var(--_p) 80%,#000);}',
      '.dia-demo-0{background:linear-gradient(150deg,color-mix(in srgb,var(--_p) 14%,var(--_s)),color-mix(in srgb,var(--_p) 30%,var(--_s)));}',
      '.dia-demo-1{background:linear-gradient(200deg,color-mix(in srgb,var(--_t) 8%,var(--_s)),color-mix(in srgb,var(--_t) 18%,var(--_s)));}',
      '.dia-demo-1 i{border-radius:50%;background:color-mix(in srgb,var(--_t) 70%,var(--_s));}',
      '.dia-demo-2{background:linear-gradient(120deg,color-mix(in srgb,var(--_p) 24%,var(--_s)),color-mix(in srgb,var(--_p) 8%,var(--_s)));}',
      '.dia-demo-2 i{border-radius:14px;transform:rotate(-8deg);background:var(--_p);}',
      '.dia-demo-3{background:color-mix(in srgb,var(--_t) 6%,var(--_s));}',
      '.dia-demo-3 i{border-radius:50% 50% 12px 12px;height:62%;background:color-mix(in srgb,var(--_p) 45%,var(--_t));}',
      '.dia-modo-previa .dia-carrinho-botao{display:none !important;}',
      '.dia-previa{display:flex;align-items:center;justify-content:center;gap:8px;margin:0 0 16px;padding:10px 14px;border-radius:999px;font-size:13px;font-weight:700;background:color-mix(in srgb,var(--_p) 12%,transparent);color:var(--_t);border:1px dashed color-mix(in srgb,var(--_p) 45%,transparent);text-align:center;}',
      '.dia-produto-vazio{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--_ts);}',
      '.dia-produto-vazio svg{width:38%;height:38%;opacity:.45;}',
      '.dia-badges{position:absolute;top:10px;left:10px;display:flex;flex-direction:column;align-items:flex-start;gap:5px;z-index:2;}',
      '.dia-badge{background:#E11D48;color:#fff;font-size:12px;font-weight:800;padding:4px 9px;border-radius:999px;letter-spacing:.01em;box-shadow:0 6px 14px rgba(225,29,72,.35);}',
      '.dia-badge.dia-novo{background:#111;box-shadow:none;}',
      '.dia-badge-destaque{position:absolute;top:10px;right:10px;z-index:2;width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.92);color:#F59E0B;display:flex;align-items:center;justify-content:center;}',
      '.dia-badge-destaque svg{width:15px;height:15px;}',
      '.dia-esgotado-capa{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--_f) 55%,transparent);}',
      '.dia-esgotado-capa span{background:#111;color:#fff;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:7px 12px;border-radius:999px;}',
      '.dia-produto-corpo{padding:12px 12px 14px;display:flex;flex-direction:column;gap:6px;flex:1;}',
      '.dia-produto-cat{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--_ts);}',
      '.dia-produto-nome{font-family:var(--_ft);font-weight:700;font-size:14.5px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em;}',
      '.dia-produto-aval{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--_ts);}',
      '.dia-estrelas{display:inline-flex;gap:1px;}',
      '.dia-estrela{position:relative;width:13px;height:13px;background:color-mix(in srgb,currentColor 22%,transparent);-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3Cpath d=%27M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3Cpath d=%27M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z%27/%3E%3C/svg%3E") center/contain no-repeat;}',
      '.dia-estrela span{position:absolute;inset:0 auto 0 0;background:#F59E0B;}',
      '.dia-produto-precos{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:auto;padding-right:44px;}',
      '.dia-produto-preco{font-weight:800;font-size:17px;letter-spacing:-.01em;white-space:nowrap;}',
      '@media (max-width:560px){.dia-produto-preco{font-size:15px;}}',
      '.dia-produto-preco small{font-size:11.5px;font-weight:700;color:var(--_ts);margin-right:3px;}',
      '.dia-produto-antigo{font-size:12.5px;color:var(--_ts);text-decoration:line-through;}',
      '.dia-btn-add{position:absolute;right:10px;bottom:10px;z-index:3;width:38px;height:38px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:var(--dia-primaria,transparent);color:var(--dia-primaria-texto,currentColor);box-shadow:inset 0 0 0 1.5px var(--_p),0 8px 18px -8px color-mix(in srgb,var(--_p) 80%,transparent);transition:transform .2s ease;}',
      '.dia-btn-add:hover{transform:scale(1.1) rotate(90deg);}',
      '.dia-btn-add svg{width:18px;height:18px;}',
      '.dia-vazio{text-align:center;padding:50px 20px;color:var(--_ts);font-size:14.5px;}',
      '.dia-vazio svg{width:46px;height:46px;opacity:.5;margin-bottom:10px;}',
      '.dia-esqueleto{border-radius:var(--_r);aspect-ratio:3/4;background:linear-gradient(90deg,color-mix(in srgb,currentColor 5%,transparent) 25%,color-mix(in srgb,currentColor 11%,transparent) 50%,color-mix(in srgb,currentColor 5%,transparent) 75%);background-size:200% 100%;animation:dia-brilho 1.4s linear infinite;}',
      '@keyframes dia-brilho{from{background-position:200% 0;}to{background-position:-200% 0;}}',
      /* botão flutuante + toast */
      '.dia-com-selo .dia-carrinho-botao{bottom:68px !important;}',
      '.dia-carrinho-botao{position:fixed;right:18px;bottom:18px;z-index:99998;display:flex;align-items:center;gap:10px;background:var(--_p);color:var(--_pt);border:none;border-radius:999px;padding:14px 20px 14px 18px;font-size:14.5px;font-weight:800;cursor:pointer;box-shadow:0 16px 36px -10px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.12);font-family:inherit;transition:transform .2s ease;}',
      '.dia-carrinho-botao:hover{transform:translateY(-2px);}',
      '.dia-carrinho-botao svg{width:20px;height:20px;}',
      '.dia-contagem{min-width:22px;height:22px;border-radius:999px;background:var(--_pt);color:var(--_p);font-size:12px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;}',
      '.dia-pulo{animation:dia-pulo .5s cubic-bezier(.3,1.6,.5,1);}',
      '@keyframes dia-pulo{0%{transform:scale(1);}40%{transform:scale(1.15);}100%{transform:scale(1);}}',
      '.dia-toast{position:fixed;left:50%;bottom:86px;z-index:100003;transform:translate(-50%,20px);opacity:0;pointer-events:none;display:flex;align-items:center;gap:10px;background:#111;color:#fff;padding:12px 18px;border-radius:999px;font-size:14px;font-weight:600;box-shadow:0 14px 34px rgba(0,0,0,.3);transition:all .3s cubic-bezier(.2,.8,.2,1);max-width:calc(100vw - 32px);font-family:inherit;}',
      '.dia-toast.dia-visivel{opacity:1;transform:translate(-50%,0);}',
      '.dia-toast.dia-aviso{background:#B91C1C;}',
      '.dia-toast svg{width:18px;height:18px;color:#4ADE80;flex-shrink:0;}',
      '.dia-toast span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      /* painel do carrinho */
      '.dia-painel-carrinho{--_f:var(--dia-fundo,Canvas);--_t:var(--dia-texto,CanvasText);--_ts:var(--dia-texto-suave,color-mix(in srgb,var(--_t) 60%,transparent));--_b:var(--dia-borda,color-mix(in srgb,var(--_t) 13%,transparent));position:fixed;top:0;right:0;width:400px;max-width:94vw;height:100%;background:var(--_f);color:var(--_t);z-index:100000;transform:translateX(105%);visibility:hidden;transition:transform .38s cubic-bezier(.2,.8,.2,1),visibility 0s linear .38s;display:flex;flex-direction:column;font-family:inherit;}',
      '.dia-painel-carrinho.aberto{transform:none;visibility:visible;box-shadow:-30px 0 70px rgba(0,0,0,.3);transition:transform .38s cubic-bezier(.2,.8,.2,1);}',
      '.dia-fundo-escuro{position:fixed;inset:0;background:rgba(0,0,0,.45);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);z-index:99999;opacity:0;pointer-events:none;transition:opacity .3s ease;}',
      '.dia-fundo-escuro.aberto{opacity:1;pointer-events:auto;}',
      '.dia-painel-cabeca{display:flex;align-items:center;justify-content:space-between;padding:20px;border-bottom:1px solid var(--_b);}',
      '.dia-painel-cabeca strong{font-family:var(--_ft);font-size:19px;letter-spacing:-.01em;}',
      '.dia-icone-btn{width:38px;height:38px;border-radius:50%;border:none;background:color-mix(in srgb,var(--_t) 8%,transparent);color:var(--_t);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s ease;flex-shrink:0;}',
      '.dia-icone-btn:hover{background:color-mix(in srgb,var(--_t) 16%,transparent);}',
      '.dia-icone-btn svg{width:18px;height:18px;}',
      '#dia-itens-carrinho{flex:1;overflow-y:auto;padding:8px 20px;}',
      '.dia-item-carrinho{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--_b);}',
      '.dia-item-img{width:64px;height:64px;border-radius:12px;object-fit:cover;flex-shrink:0;background:color-mix(in srgb,var(--_t) 7%,transparent);}',
      '.dia-item-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;}',
      '.dia-item-nome{font-weight:700;font-size:14px;line-height:1.3;}',
      '.dia-item-linha{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.dia-qtd{display:inline-flex;align-items:center;border:1px solid var(--_b);border-radius:999px;overflow:hidden;}',
      '.dia-qtd button{width:30px;height:30px;border:none;background:transparent;color:inherit;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit;}',
      '.dia-qtd button:hover{background:color-mix(in srgb,var(--_t) 8%,transparent);}',
      '.dia-qtd span{min-width:26px;text-align:center;font-weight:800;font-size:13.5px;}',
      '.dia-item-preco{font-weight:800;font-size:14px;}',
      '.dia-remover{background:none;border:none;color:var(--_ts);font-size:12px;cursor:pointer;text-decoration:underline;font-family:inherit;padding:0;align-self:flex-start;}',
      '.dia-remover:hover{color:#D64545;}',
      '.dia-painel-rodape{padding:16px 20px 20px;border-top:1px solid var(--_b);}',
      '.dia-total{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;font-size:14px;color:var(--_ts);}',
      '.dia-total strong{font-size:22px;color:var(--_t);letter-spacing:-.02em;}',
      '.dia-btn-principal{width:100%;display:flex;align-items:center;justify-content:center;gap:9px;background:var(--_p);color:var(--_pt);border:none;border-radius:calc(var(--_r) - 2px);padding:16px;font-size:15.5px;font-weight:800;cursor:pointer;font-family:inherit;box-shadow:0 14px 28px -12px color-mix(in srgb,var(--_p) 75%,transparent);transition:transform .15s ease,filter .15s ease;}',
      '.dia-btn-principal:hover:not(:disabled){filter:brightness(1.08);}',
      '.dia-btn-principal:active:not(:disabled){transform:scale(.98);}',
      '.dia-btn-principal:disabled{opacity:.45;cursor:default;box-shadow:none;}',
      '.dia-btn-principal svg{width:20px;height:20px;}',
      '.dia-btn-principal.dia-wa{background:#25D366;color:#fff;box-shadow:0 14px 28px -12px rgba(37,211,102,.7);}',
      '.dia-btn-sec{width:100%;margin-top:10px;background:transparent;color:inherit;border:1px solid var(--_b);border-radius:calc(var(--_r) - 2px);padding:14px;font-size:14.5px;font-weight:700;cursor:pointer;font-family:inherit;}',
      '.dia-btn-sec:hover:not(:disabled){border-color:var(--_p);}',
      '.dia-btn-sec:disabled{opacity:.45;cursor:default;}',
      '.dia-carrinho-vazio{text-align:center;color:var(--_ts);padding:60px 10px;font-size:14px;}',
      '.dia-carrinho-vazio svg{width:52px;height:52px;opacity:.4;margin-bottom:12px;}',
      /* janelas */
      '.dia-overlay{--_f:var(--dia-fundo,Canvas);--_t:var(--dia-texto,CanvasText);--_ts:var(--dia-texto-suave,color-mix(in srgb,var(--_t) 60%,transparent));--_b:var(--dia-borda,color-mix(in srgb,var(--_t) 13%,transparent));--_s:var(--dia-superficie,color-mix(in srgb,var(--_t) 4%,transparent));position:fixed;inset:0;background:rgba(8,8,12,.6);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);z-index:100002;display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit;animation:dia-surgir .2s ease;}',
      '.dia-modal{position:relative;background:var(--_f);color:var(--_t);border-radius:calc(var(--_r) + 8px);width:100%;max-width:440px;max-height:92vh;overflow-y:auto;box-shadow:0 40px 90px rgba(0,0,0,.4);animation:dia-subir .32s cubic-bezier(.2,.8,.2,1);}',
      '.dia-modal-corpo{padding:26px;}',
      '.dia-modal .dia-icone-btn.dia-fechar{position:sticky;top:14px;float:right;margin:14px 14px -52px 0;z-index:5;background:color-mix(in srgb,var(--_f) 85%,transparent);}',
      '@keyframes dia-surgir{from{opacity:0;}to{opacity:1;}}',
      '@keyframes dia-subir{from{opacity:0;transform:translateY(20px) scale(.98);}to{opacity:1;transform:none;}}',
      /* página do produto */
      '.dia-detalhe{max-width:1000px;}',
      '.dia-detalhe-topo{display:grid;grid-template-columns:1.1fr 1fr;}',
      '.dia-galeria{position:relative;background:color-mix(in srgb,var(--_t) 5%,transparent);}',
      '.dia-gal-trilho{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;aspect-ratio:1/1;}',
      '.dia-gal-trilho::-webkit-scrollbar{display:none;}',
      '.dia-gal-foto{flex:0 0 100%;scroll-snap-align:start;overflow:hidden;position:relative;cursor:zoom-in;}',
      '.dia-gal-foto img{position:relative;width:100%;height:100%;object-fit:contain;display:block;transition:transform .2s ease;}',
      '.dia-gal-foto.dia-zoom img{transform:scale(2.1);}',
      '.dia-gal-seta{position:absolute;top:calc(50% - 40px);z-index:2;width:40px;height:40px;border-radius:50%;border:none;background:rgba(255,255,255,.9);color:#111;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 16px rgba(0,0,0,.18);}',
      '.dia-gal-seta.dia-esq{left:12px;}.dia-gal-seta.dia-dir{right:12px;}',
      '.dia-gal-miniaturas{display:flex;gap:8px;padding:10px;overflow-x:auto;scrollbar-width:none;}',
      '.dia-gal-miniaturas button{flex:0 0 58px;height:58px;border-radius:10px;overflow:hidden;border:2px solid transparent;padding:0;cursor:pointer;background:none;opacity:.65;transition:opacity .2s,border-color .2s;}',
      '.dia-gal-miniaturas button.dia-activo{border-color:var(--_p);opacity:1;}',
      '.dia-gal-miniaturas img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.dia-detalhe-info{padding:30px 28px;display:flex;flex-direction:column;gap:12px;}',
      '.dia-detalhe-nome{font-family:var(--_ft);font-weight:800;font-size:clamp(22px,3vw,30px);line-height:1.15;letter-spacing:-.02em;margin:0;padding-right:40px;}',
      '.dia-detalhe-aval{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--_ts);background:none;border:none;padding:0;cursor:pointer;font-family:inherit;width:max-content;}',
      '.dia-detalhe-aval .dia-estrela{width:16px;height:16px;}',
      '.dia-detalhe-precos{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}',
      '.dia-detalhe-preco{font-size:28px;font-weight:800;letter-spacing:-.02em;}',
      '.dia-detalhe-poupa{font-size:12.5px;font-weight:800;color:#E11D48;background:rgba(225,29,72,.1);padding:4px 9px;border-radius:999px;}',
      '.dia-opcoes-titulo{font-size:12.5px;font-weight:800;color:var(--_ts);letter-spacing:.04em;text-transform:uppercase;}',
      '.dia-opcoes{display:flex;flex-wrap:wrap;gap:8px;}',
      '.dia-opcao{border:1.5px solid var(--_b);background:transparent;color:var(--_t);border-radius:calc(var(--_r) - 4px);padding:10px 14px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;transition:border-color .15s,background .15s;}',
      '.dia-opcao:hover:not(:disabled){border-color:color-mix(in srgb,var(--_p) 60%,transparent);}',
      '.dia-opcao.dia-activo{border-color:var(--_p);background:color-mix(in srgb,var(--_p) 12%,transparent);}',
      '.dia-opcao:disabled{opacity:.4;text-decoration:line-through;cursor:not-allowed;}',
      '.dia-stock{font-size:13px;font-weight:700;display:flex;align-items:center;gap:7px;}',
      '.dia-stock::before{content:"";width:8px;height:8px;border-radius:50%;background:#16A34A;}',
      '.dia-stock.dia-pouco{color:#C2410C;}.dia-stock.dia-pouco::before{background:#F97316;}',
      '.dia-stock.dia-nada{color:#B91C1C;}.dia-stock.dia-nada::before{background:#DC2626;}',
      '.dia-detalhe-desc{color:var(--_ts);font-size:14.5px;line-height:1.7;white-space:pre-wrap;margin:4px 0 6px;}',
      '.dia-detalhe-qtd{display:flex;align-items:center;gap:12px;font-size:13px;font-weight:700;color:var(--_ts);}',
      '.dia-detalhe-qtd .dia-qtd button{width:38px;height:38px;}',
      '.dia-msg-opcao{font-size:13px;color:#B91C1C;font-weight:700;min-height:0;}',
      '.dia-detalhe-baixo{padding:8px 28px 30px;border-top:1px solid var(--_b);}',
      '.dia-detalhe-baixo .dia-bloco{margin:24px 0 0;}',
      /* avaliações */
      '.dia-aval-resumo{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px;}',
      '.dia-aval-media{font-family:var(--_ft);font-size:38px;font-weight:800;letter-spacing:-.03em;line-height:1;}',
      '.dia-aval-resumo .dia-estrela{width:18px;height:18px;}',
      '.dia-aval-resumo small{display:block;color:var(--_ts);font-size:12.5px;margin-top:3px;}',
      '.dia-aval-lista{display:flex;flex-direction:column;gap:12px;}',
      '.dia-aval{background:var(--_s);border:1px solid var(--_b);border-radius:calc(var(--_r) - 2px);padding:14px 16px;}',
      '.dia-aval-cabeca{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;font-size:13.5px;}',
      '.dia-aval-cabeca small{color:var(--_ts);font-size:12px;}',
      '.dia-aval p{margin:6px 0 0;font-size:14px;line-height:1.6;color:var(--_t);}',
      '.dia-aval-form{background:var(--_s);border:1px solid var(--_b);border-radius:calc(var(--_r) - 2px);padding:16px;margin-top:12px;}',
      '.dia-escolher-estrelas{display:flex;gap:4px;margin-bottom:12px;}',
      '.dia-escolher-estrelas button{background:none;border:none;padding:2px;cursor:pointer;color:color-mix(in srgb,var(--_t) 25%,transparent);}',
      '.dia-escolher-estrelas button.dia-activo{color:#F59E0B;}',
      '.dia-escolher-estrelas svg{width:30px;height:30px;}',
      '@media (max-width:760px){.dia-overlay{align-items:flex-end;padding:0;}.dia-modal{max-height:94vh;border-radius:calc(var(--_r) + 8px) calc(var(--_r) + 8px) 0 0;}.dia-detalhe-topo{grid-template-columns:1fr;}.dia-detalhe-info{padding:22px 18px;}.dia-detalhe-baixo{padding:6px 18px 26px;}.dia-gal-seta{display:none;}}',
      /* checkout */
      '.dia-modal h3{font-family:var(--_ft);font-size:21px;letter-spacing:-.02em;margin:0 0 4px;}',
      '.dia-modal-sub{color:var(--_ts);font-size:13.5px;margin:0 0 18px;}',
      '.dia-resumo{display:flex;justify-content:space-between;align-items:center;background:color-mix(in srgb,var(--_t) 5%,transparent);border-radius:calc(var(--_r) - 4px);padding:12px 14px;margin-bottom:18px;font-size:13.5px;}',
      '.dia-resumo strong{font-size:17px;}',
      '.dia-campo{margin-bottom:12px;}',
      '.dia-campo label{display:block;font-size:12.5px;color:var(--_ts);margin-bottom:6px;font-weight:700;}',
      '.dia-campo input,.dia-campo textarea{width:100%;background:transparent;color:var(--_t);border:1px solid var(--_b);border-radius:calc(var(--_r) - 4px);padding:13px 14px;font-size:15px;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s;resize:vertical;}',
      '.dia-campo input:focus,.dia-campo textarea:focus{border-color:var(--_p);box-shadow:0 0 0 3px color-mix(in srgb,var(--_p) 20%,transparent);}',
      '.dia-metodos{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px;}',
      '.dia-metodo{border:1.5px solid var(--_b);border-radius:calc(var(--_r) - 4px);padding:14px 6px;cursor:pointer;font-size:13px;font-weight:800;text-align:center;transition:all .15s ease;}',
      '.dia-metodo small{display:block;font-weight:600;font-size:11px;color:var(--_ts);margin-top:3px;}',
      '.dia-metodo:hover{border-color:color-mix(in srgb,var(--_p) 55%,transparent);}',
      '.dia-metodo.seleccionado{border-color:var(--_p);background:color-mix(in srgb,var(--_p) 10%,transparent);}',
      '.dia-pagar-para{border:1px dashed var(--_b);border-radius:calc(var(--_r) - 4px);padding:14px;margin-bottom:16px;}',
      '.dia-pagar-para p{margin:0 0 10px;font-size:13px;color:var(--_ts);line-height:1.5;}',
      '.dia-numero{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--_t) 5%,transparent);margin-top:8px;font-size:14px;}',
      '.dia-numero b{font-size:16px;letter-spacing:.02em;}',
      '.dia-copiar{display:inline-flex;align-items:center;gap:5px;background:none;border:1px solid var(--_b);color:inherit;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;}',
      '.dia-copiar svg{width:13px;height:13px;}',
      '.dia-msg-erro{color:#D64545;font-size:13px;margin-top:10px;line-height:1.4;}',
      '.dia-msg-erro:empty{display:none;}',
      '.dia-msg-ok{color:#16A34A;font-size:13.5px;font-weight:700;margin-top:10px;line-height:1.4;}',
      '.dia-estado-pagamento{text-align:center;padding:16px 0 6px;}',
      '.dia-estado-pagamento p{color:var(--_ts);font-size:14px;line-height:1.6;margin:8px 0 0;}',
      '.dia-ok{width:72px;height:72px;border-radius:50%;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;background:rgba(34,197,94,.14);color:#16A34A;animation:dia-pulo .6s cubic-bezier(.3,1.6,.5,1);}',
      '.dia-ok svg{width:34px;height:34px;}',
      '.dia-ref{display:inline-block;font-weight:800;letter-spacing:.06em;background:color-mix(in srgb,var(--_t) 7%,transparent);padding:6px 12px;border-radius:999px;margin-top:10px;}',
      '.dia-spinner{width:34px;height:34px;border-radius:50%;border:3px solid var(--_b);border-top-color:var(--_p);animation:dia-girar .8s linear infinite;margin:0 auto 14px;}',
      '@keyframes dia-girar{to{transform:rotate(360deg);}}',
      ".dia-add-txt{display:none;}.dia-modal.dia-modal-cartao{max-width:560px;}.dia-cartao-pag{display:flex;flex-direction:column;gap:12px;}.dia-cartao-topo{display:flex;align-items:center;gap:12px;padding-right:40px;}.dia-cartao-topo b{display:block;font-size:15px;}.dia-cartao-topo small{display:block;font-size:12px;color:var(--_ts);margin-top:2px;}.dia-cartao-topo strong{margin-left:auto;font-size:16px;white-space:nowrap;}.dia-cartao-ic{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--_p) 14%,transparent);color:var(--_p);flex-shrink:0;}.dia-cartao-ic svg{width:19px;height:19px;}.dia-cartao-palco{position:relative;height:min(620px,62vh);border-radius:calc(var(--_r) - 2px);overflow:hidden;background:#fff;border:1px solid var(--_b);}.dia-cartao-palco iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;}.dia-cartao-carregar{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;z-index:1;transition:opacity .3s ease;}.dia-cartao-palco.dia-carregado .dia-cartao-carregar{opacity:0;pointer-events:none;}.dia-cartao-link{font-size:12.5px;color:var(--_ts);text-align:center;}.dia-cartao-fora{text-align:center;padding:20px 10px;border:1px dashed var(--_b);border-radius:calc(var(--_r) - 2px);}.dia-cartao-fora p{color:var(--_ts);font-size:14px;line-height:1.55;margin:0 0 14px;}.dia-cartao-estado{display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px;color:var(--_ts);margin:0;text-align:center;}.dia-cartao-estado i{width:8px;height:8px;border-radius:50%;background:#F59E0B;flex-shrink:0;animation:dia-brilhar 1.4s ease-in-out infinite;}@media (max-width:760px){.dia-cartao-palco{height:68vh;}}.dia-tema-mercado .dia-bloco{margin-bottom:34px;}.dia-mosaico{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(0,1fr);gap:14px;}.dia-mos-so{grid-template-columns:1fr;}.dia-mos-grande{position:relative;min-height:clamp(270px,34vw,430px);border-radius:calc(var(--_r) + 10px);overflow:hidden;background:linear-gradient(135deg,color-mix(in srgb,var(--_p) 12%,var(--_f)),color-mix(in srgb,var(--_p) 28%,var(--_f)));display:flex;align-items:center;isolation:isolate;color:var(--_t);}.dia-mos-foto{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;}.dia-mos-grande.dia-com-foto::after{content:\\"\\";position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,rgba(0,0,0,.62),rgba(0,0,0,.08) 72%);}.dia-mos-grande.dia-com-foto{color:#fff;}.dia-mos-arte{position:absolute;right:4%;top:8%;bottom:8%;width:44%;z-index:-1;display:flex;align-items:center;justify-content:center;}.dia-mos-arte img{max-width:100%;max-height:100%;object-fit:contain;filter:drop-shadow(0 30px 40px rgba(0,0,0,.22));}.dia-mos-arte .dia-demo-arte{background:none;}.dia-mos-texto{position:relative;padding:clamp(22px,4vw,48px);max-width:58%;}.dia-mos-eti{display:inline-block;font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;background:var(--_f);color:var(--_t);padding:6px 11px;border-radius:999px;margin-bottom:14px;}.dia-com-foto .dia-mos-eti{background:rgba(255,255,255,.94);color:#111;}.dia-mos-texto h2{font-family:var(--_ft);font-weight:800;font-size:clamp(26px,3.6vw,46px);line-height:1.05;letter-spacing:-.03em;margin:0 0 10px;}.dia-mos-texto p{font-size:clamp(13.5px,1.3vw,16px);line-height:1.5;margin:0 0 18px;opacity:.85;}.dia-mos-btn{display:inline-flex;align-items:center;gap:8px;background:var(--_p);color:var(--_pt);border:none;border-radius:999px;padding:12px 20px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;min-height:44px;}.dia-mos-btn svg,.dia-mos-link svg{width:15px;height:15px;}.dia-mos-lado{display:grid;grid-template-rows:1fr 1fr;gap:14px;}.dia-mos-telha{position:relative;display:flex;flex-direction:column;border:none;border-radius:calc(var(--_r) + 10px);padding:18px;cursor:pointer;text-align:left;font-family:inherit;color:var(--_t);overflow:hidden;min-height:150px;transition:transform .25s ease;isolation:isolate;}.dia-mos-telha:hover{transform:translateY(-3px);}.dia-mos-t0{background:color-mix(in srgb,#F59E0B 18%,var(--_f));}.dia-mos-t1{background:color-mix(in srgb,var(--_p) 13%,var(--_f));}.dia-mos-telha-txt{display:flex;flex-direction:column;gap:5px;max-width:60%;flex:1;}.dia-mos-telha-txt small{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.65;}.dia-mos-telha-txt b{font-family:var(--_ft);font-size:clamp(17px,1.8vw,22px);line-height:1.15;letter-spacing:-.02em;}.dia-mos-link{margin-top:auto;padding-top:10px;display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:800;color:var(--_p);}.dia-mos-telha-arte{position:absolute;right:-4%;bottom:-6%;width:50%;aspect-ratio:1;z-index:-1;display:flex;align-items:center;justify-content:center;}.dia-mos-telha-arte img{width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 18px 24px rgba(0,0,0,.2));}.dia-mos-telha-arte .dia-demo-arte{background:none;}.dia-tema-mercado .dia-seccao-titulo{position:relative;padding-bottom:9px;}.dia-tema-mercado .dia-seccao-titulo::after{content:\\"\\";position:absolute;left:0;bottom:0;width:40px;height:3px;border-radius:3px;background:var(--_p);}.dia-tema-mercado .dia-produto-card{background:var(--_f);border:1px solid var(--_b);border-radius:calc(var(--_r) - 2px);padding:8px;}.dia-tema-mercado .dia-produto-media{border-radius:calc(var(--_r) - 6px);background:color-mix(in srgb,var(--_t) 4%,transparent);}.dia-tema-mercado .dia-produto-corpo{padding:10px 4px 8px;gap:4px;}.dia-tema-mercado .dia-produto-nome{font-size:13.5px;font-weight:600;font-family:inherit;}.dia-tema-mercado .dia-produto-precos{padding-right:0;}.dia-tema-mercado .dia-btn-add{position:static;width:auto;height:40px;margin:2px 0 0;border-radius:calc(var(--_r) - 6px);gap:6px;font-weight:800;font-size:13px;font-family:inherit;box-shadow:none;}.dia-tema-mercado .dia-btn-add:hover{transform:none;filter:brightness(1.08);}.dia-tema-mercado .dia-btn-add svg{width:16px;height:16px;}.dia-tema-mercado .dia-add-txt{display:inline;}.dia-banda{border-radius:calc(var(--_r) + 12px);padding:clamp(18px,3vw,32px);background:radial-gradient(circle at 92% 0%,color-mix(in srgb,var(--_p) 55%,transparent),transparent 42%),color-mix(in srgb,var(--_p) 22%,#0c0c0f);color:#fff;}.dia-banda-topo{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:18px;}.dia-banda-titulo{display:flex;align-items:center;gap:10px;margin:0;font-family:var(--_ft);font-weight:800;font-size:clamp(20px,2.6vw,28px);letter-spacing:-.02em;}.dia-banda-titulo svg{width:24px;height:24px;color:#FCD34D;}.dia-banda-tabs{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;max-width:100%;}.dia-banda-tabs::-webkit-scrollbar{display:none;}.dia-banda-tab{flex-shrink:0;border:1px solid rgba(255,255,255,.24);background:transparent;color:#fff;border-radius:999px;padding:9px 15px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;}.dia-banda-tab.dia-activo{background:#FCD34D;color:#111;border-color:transparent;}.dia-banda-grelha{--_t:#16161a;--_ts:#6b6b74;--_b:#e7e7ea;--_s:#ffffff;--_f:#ffffff;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;}.dia-banda-grelha .dia-produto-card{color:var(--_t);}@media (max-width:1100px){.dia-banda-grelha{grid-template-columns:repeat(4,minmax(0,1fr));}.dia-banda-grelha > :nth-child(n+9){display:none;}}@media (max-width:860px){.dia-mosaico{grid-template-columns:1fr;}.dia-mos-lado{grid-template-rows:none;grid-template-columns:1fr 1fr;}.dia-banda-grelha{grid-template-columns:repeat(3,minmax(0,1fr));}.dia-banda-grelha > :nth-child(n+7){display:none;}}@media (max-width:560px){.dia-mos-grande{align-items:flex-start;min-height:340px;}.dia-mos-texto{max-width:none;padding:24px 20px;}.dia-mos-grande:not(.dia-com-foto) .dia-mos-texto{padding-bottom:150px;}.dia-mos-arte{width:56%;top:auto;height:44%;right:4%;bottom:4%;}.dia-mos-lado{gap:10px;}.dia-mos-telha{min-height:176px;padding:14px;}.dia-mos-telha-txt{max-width:100%;}.dia-mos-telha-txt b{font-size:16px;}.dia-mos-telha-arte{width:56%;right:-8%;bottom:-10%;opacity:.95;}.dia-banda-grelha{grid-auto-flow:column;grid-template-columns:none;grid-auto-columns:46%;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;padding-bottom:4px;}.dia-banda-grelha::-webkit-scrollbar{display:none;}.dia-banda-grelha > *{scroll-snap-align:start;}.dia-banda-grelha > :nth-child(n+7){display:flex;}}.dia-tema-editorial .dia-bloco{margin-bottom:48px;}.dia-tema-editorial .dia-categorias{display:none !important;}.dia-ed-capa{text-align:center;padding:clamp(26px,6vw,74px) 0 clamp(14px,3vw,28px);}.dia-ed-eti{display:inline-block;font-size:12px;letter-spacing:.26em;text-transform:uppercase;color:var(--_ts);margin-bottom:18px;}.dia-ed-titulo{font-family:var(--_ft);font-weight:500;text-transform:uppercase;font-size:clamp(36px,8.4vw,120px);line-height:.95;letter-spacing:-.035em;margin:0 auto;max-width:16ch;overflow-wrap:anywhere;}.dia-ed-sub{max-width:520px;margin:20px auto 0;color:var(--_ts);font-size:clamp(14px,1.4vw,17px);line-height:1.6;}.dia-ed-foto{margin-top:clamp(24px,4vw,46px);border-radius:var(--_r);overflow:hidden;aspect-ratio:21/9;}.dia-ed-foto img{width:100%;height:100%;object-fit:cover;display:block;}.dia-ed-barra{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:14px 0;border-top:1px solid var(--_b);border-bottom:1px solid var(--_b);margin-bottom:28px;}.dia-ed-tabs{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;max-width:100%;}.dia-ed-tabs::-webkit-scrollbar{display:none;}.dia-ed-tab{flex-shrink:0;background:none;border:none;border-radius:999px;padding:9px 15px;font-size:12.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--_ts);cursor:pointer;font-family:inherit;white-space:nowrap;min-height:40px;}.dia-ed-tab:hover{color:var(--_t);}.dia-ed-tab.dia-activo{background:var(--_t);color:var(--_f);}.dia-ed-ordem{display:flex;align-items:center;gap:10px;font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--_ts);}.dia-ed-ordem select{border:1px solid var(--_b);background:transparent;color:var(--_t);border-radius:999px;padding:10px 14px;font-size:13px;font-family:inherit;letter-spacing:0;text-transform:none;outline:none;min-height:40px;}.dia-ed-mais{display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:38px;}.dia-ed-mais-btn{background:none;border:none;font-family:var(--_ft);font-size:clamp(20px,2.4vw,30px);font-weight:500;color:var(--_t);cursor:pointer;padding:6px 4px;border-bottom:1.5px solid currentColor;}.dia-ed-mais small{font-size:12px;color:var(--_ts);letter-spacing:.04em;}.dia-tema-editorial .dia-ed-grelha{row-gap:36px;}.dia-tema-editorial .dia-produto-card{background:none;border:none;border-radius:0;overflow:visible;}.dia-tema-editorial .dia-produto-card:hover{transform:none;box-shadow:none;}.dia-tema-editorial .dia-produto-media{aspect-ratio:4/5;border-radius:max(2px,calc(var(--_r) - 8px));}.dia-tema-editorial .dia-produto-img{object-fit:cover;}.dia-tema-editorial .dia-img-fundo{display:none;}.dia-tema-editorial .dia-produto-corpo{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:4px 14px;padding:14px 0 4px;}.dia-tema-editorial .dia-produto-cat,.dia-tema-editorial .dia-produto-aval{display:none;}.dia-tema-editorial .dia-produto-nome{font-family:inherit;font-weight:600;font-size:12.5px;letter-spacing:.07em;text-transform:uppercase;min-height:0;}.dia-tema-editorial .dia-produto-precos{margin:0;padding:0;justify-content:flex-end;}.dia-tema-editorial .dia-produto-preco{font-size:14px;font-weight:600;}.dia-tema-editorial .dia-btn-add{top:12px;right:12px;bottom:auto;width:38px;height:38px;background:var(--_f);color:var(--_t);box-shadow:0 6px 16px rgba(0,0,0,.14);opacity:0;transition:opacity .2s ease;}.dia-tema-editorial .dia-produto-card:hover .dia-btn-add,.dia-tema-editorial .dia-btn-add:focus{opacity:1;}@media (hover:none){.dia-tema-editorial .dia-btn-add{opacity:1;}}.dia-tema-editorial .dia-seccao-titulo{font-family:inherit;font-weight:600;font-size:13px;letter-spacing:.18em;text-transform:uppercase;}.dia-tema-editorial .dia-badge{border-radius:2px;box-shadow:none;}@media (max-width:560px){.dia-ed-barra{flex-direction:column;align-items:stretch;}.dia-ed-ordem{justify-content:space-between;}.dia-tema-editorial .dia-produto-corpo{grid-template-columns:1fr;}.dia-tema-editorial .dia-produto-precos{justify-content:flex-start;}.dia-tema-editorial .dia-ed-grelha{row-gap:24px;}.dia-ed-foto{aspect-ratio:4/3;}}.dia-tc-capa{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);align-items:center;gap:clamp(16px,3vw,40px);border-radius:calc(var(--_r) + 8px);padding:clamp(22px,4vw,52px);background:linear-gradient(120deg,color-mix(in srgb,var(--_p) 9%,var(--_f)),color-mix(in srgb,var(--_p) 22%,var(--_f)));overflow:hidden;position:relative;color:var(--_t);}.dia-tc-pill{display:inline-flex;align-items:center;gap:6px;background:var(--_f);color:var(--_p);font-size:12px;font-weight:800;padding:7px 12px;border-radius:999px;margin-bottom:16px;box-shadow:0 6px 16px -8px rgba(0,0,0,.3);}.dia-tc-pill svg{width:14px;height:14px;}.dia-tc-texto h2{font-family:var(--_ft);font-weight:800;font-size:clamp(28px,4vw,52px);line-height:1.04;letter-spacing:-.03em;margin:0 0 12px;overflow-wrap:anywhere;}.dia-tc-texto p{color:var(--_ts);font-size:clamp(14px,1.4vw,17px);line-height:1.55;margin:0 0 22px;max-width:460px;}.dia-tc-btn{display:inline-flex;align-items:center;gap:8px;background:var(--_p);color:var(--_pt);border:none;border-radius:calc(var(--_r) - 2px);padding:13px 22px;font-weight:800;font-size:14.5px;cursor:pointer;font-family:inherit;min-height:46px;}.dia-tc-btn svg{width:16px;height:16px;}.dia-tc-arte{position:relative;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;}.dia-tc-arte::before{content:\\"\\";position:absolute;width:80%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--_p) 34%,transparent),transparent 70%);}.dia-tc-prod{position:relative;width:100%;height:100%;border:none;background:none;padding:0;cursor:pointer;}.dia-tc-prod img{width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 30px 36px rgba(0,0,0,.22));transition:transform .5s ease;}.dia-tc-prod:hover img{transform:scale(1.04) rotate(-1deg);}.dia-tc-foto{position:relative;width:100%;height:100%;object-fit:cover;border-radius:var(--_r);}.dia-tc-arte .dia-demo-arte{width:80%;height:80%;left:10%;top:10%;background:none;}.dia-tc-desc{position:absolute;top:6%;right:6%;width:68px;height:68px;border-radius:50%;background:#E11D48;color:#fff;font-weight:800;font-size:17px;display:flex;align-items:center;justify-content:center;transform:rotate(12deg);box-shadow:0 10px 24px rgba(225,29,72,.35);}.dia-cat-icones{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(96px,128px);gap:12px;overflow-x:auto;scrollbar-width:none;padding:2px 2px 8px;}.dia-cat-icones::-webkit-scrollbar{display:none;}.dia-cat-icone{display:flex;flex-direction:column;align-items:center;gap:9px;background:none;border:none;cursor:pointer;color:var(--_t);font-family:inherit;padding:0;}.dia-cat-quad{width:100%;max-width:124px;aspect-ratio:1;border-radius:calc(var(--_r) + 2px);border:1px solid var(--_b);background:var(--_s);display:flex;align-items:center;justify-content:center;overflow:hidden;transition:border-color .2s ease,transform .2s ease;}.dia-cat-quad img{width:74%;height:74%;object-fit:contain;}.dia-cat-icone:hover .dia-cat-quad{border-color:var(--_p);transform:translateY(-3px);}.dia-cat-nome{font-size:12.5px;font-weight:700;text-align:center;line-height:1.3;}.dia-tema-tech .dia-seccao-titulo{padding-left:12px;border-left:4px solid var(--_p);font-size:clamp(18px,2.1vw,22px);}.dia-tema-tech .dia-produto-card{background:var(--_f);border:1px solid var(--_b);}.dia-tema-tech .dia-produto-media{background:var(--_s);margin:8px 8px 0;border-radius:calc(var(--_r) - 4px);}.dia-tema-tech .dia-produto-img{padding:8%;}.dia-tema-tech .dia-img-fundo{display:none;}.dia-tema-tech .dia-produto-cat{color:var(--_p);}.dia-tema-tech .dia-produto-preco{color:var(--_p);font-size:18px;}.dia-tema-tech .dia-btn-add{border-radius:calc(var(--_r) - 4px);width:40px;height:40px;}.dia-tema-tech .dia-badge.dia-novo{background:var(--_p);color:var(--_pt);}@media (max-width:560px){.dia-tema-tech .dia-produto-preco{font-size:15px;}.dia-tema-tech .dia-produto-precos{padding-right:40px;}}@media (max-width:760px){.dia-tc-capa{grid-template-columns:1fr;}.dia-tc-arte{aspect-ratio:16/10;max-height:260px;}.dia-cat-icones{grid-auto-columns:84px;}}.dia-md-capa{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);align-items:center;gap:clamp(22px,4vw,60px);padding:clamp(14px,3vw,32px) 0;}.dia-md-titulo{font-family:var(--_ft);font-weight:900;text-transform:uppercase;font-size:clamp(40px,7.4vw,104px);line-height:.94;letter-spacing:-.04em;margin:0 0 18px;overflow-wrap:anywhere;}.dia-md-titulo mark{background:linear-gradient(transparent 56%,color-mix(in srgb,var(--_p) 72%,transparent) 56%,color-mix(in srgb,var(--_p) 72%,transparent) 92%,transparent 92%);color:inherit;padding:0 .06em;}.dia-md-texto p{font-size:clamp(14px,1.4vw,17px);line-height:1.55;color:var(--_ts);margin:0 0 24px;max-width:420px;}.dia-md-btn{display:inline-flex;align-items:center;gap:10px;background:var(--_t);color:var(--_f);border:none;border-radius:999px;padding:15px 26px;font-weight:800;font-size:13.5px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;font-family:inherit;min-height:48px;}.dia-md-btn svg{width:16px;height:16px;}.dia-md-arte{position:relative;aspect-ratio:4/5;max-height:560px;justify-self:center;width:100%;max-width:440px;}.dia-md-arte > img{position:relative;width:100%;height:100%;object-fit:cover;border-radius:calc(var(--_r) + 14px);z-index:1;display:block;}.dia-md-arte .dia-demo-arte{border-radius:calc(var(--_r) + 14px);z-index:1;}.dia-md-forma{position:absolute;width:62%;aspect-ratio:1;border-radius:50%;background:var(--_p);top:-6%;right:-8%;z-index:0;}.dia-md-forma2{width:34%;border-radius:calc(var(--_r) + 6px);top:auto;right:auto;bottom:-5%;left:-7%;background:var(--_t);opacity:.9;transform:rotate(-10deg);}.dia-md-faixa{overflow:hidden;background:var(--_p);color:var(--_pt);border-radius:calc(var(--_r) + 6px);padding:16px 0;}.dia-md-pista{display:flex;width:max-content;align-items:center;animation:dia-desliza 30s linear infinite;}.dia-md-faixa:hover .dia-md-pista{animation-play-state:paused;}.dia-md-copia{display:flex;align-items:center;}.dia-md-item{background:none;border:none;color:inherit;font-family:var(--_ft);font-weight:900;font-size:clamp(20px,2.8vw,34px);text-transform:uppercase;letter-spacing:-.02em;cursor:pointer;padding:4px 22px;white-space:nowrap;}.dia-md-item:hover{text-decoration:underline;text-underline-offset:6px;}.dia-md-sep svg{width:18px;height:18px;display:block;opacity:.85;}@keyframes dia-desliza{to{transform:translateX(-50%);}}@media (prefers-reduced-motion:reduce){.dia-md-faixa{overflow-x:auto;}.dia-md-copia{display:none;}}.dia-tema-moda .dia-seccao-titulo{font-weight:900;text-transform:uppercase;font-size:clamp(22px,3vw,34px);letter-spacing:-.02em;background:linear-gradient(transparent 60%,color-mix(in srgb,var(--_p) 55%,transparent) 60%);display:inline-flex;padding:0 .1em;}.dia-tema-moda .dia-produto-card{background:none;border:none;overflow:visible;}.dia-tema-moda .dia-produto-card:hover{box-shadow:none;}.dia-tema-moda .dia-produto-media{aspect-ratio:3/4;border-radius:calc(var(--_r) + 12px);}.dia-tema-moda .dia-produto-img{object-fit:cover;}.dia-tema-moda .dia-img-fundo{display:none;}.dia-tema-moda .dia-produto-corpo{padding:14px 4px 4px;}.dia-tema-moda .dia-produto-nome{font-weight:800;text-transform:uppercase;letter-spacing:.01em;min-height:0;}.dia-tema-moda .dia-produto-precos{padding-right:0;}.dia-tema-moda .dia-btn-add{top:12px;right:12px;bottom:auto;background:var(--_f);color:var(--_t);box-shadow:0 8px 20px rgba(0,0,0,.18);}.dia-tema-moda .dia-fila{grid-auto-columns:minmax(220px,270px);}.dia-tema-moda .dia-badge{border-radius:6px;}@media (max-width:760px){.dia-md-capa{grid-template-columns:1fr;}.dia-md-arte{max-width:300px;width:84%;}.dia-md-forma{right:-4%;top:-4%;}.dia-md-forma2{left:-4%;}.dia-md-titulo{font-size:clamp(38px,11vw,66px);}}@media (max-width:560px){.dia-tema-moda .dia-fila{grid-auto-columns:minmax(160px,62%);}.dia-md-faixa{padding:12px 0;}}.dia-ct-capa{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.7fr);align-items:center;min-height:clamp(170px,20vw,230px);border-radius:calc(var(--_r) + 6px);overflow:hidden;background:linear-gradient(110deg,color-mix(in srgb,var(--_p) 10%,var(--_f)),color-mix(in srgb,var(--_p) 24%,var(--_f)));color:var(--_t);isolation:isolate;}.dia-ct-capa.dia-com-foto{color:#fff;grid-template-columns:1fr;}.dia-ct-foto{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;}.dia-ct-capa.dia-com-foto::after{content:\\"\\";position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,rgba(0,0,0,.62),rgba(0,0,0,0) 75%);}.dia-ct-texto{padding:clamp(18px,3.4vw,40px);}.dia-ct-eti{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--_p);margin-bottom:8px;}.dia-com-foto .dia-ct-eti{color:#fff;opacity:.92;}.dia-ct-texto h2{font-family:var(--_ft);font-weight:800;font-size:clamp(24px,3.2vw,40px);line-height:1.05;letter-spacing:-.02em;margin:0 0 6px;}.dia-ct-texto p{margin:0 0 16px;font-size:14px;opacity:.82;}.dia-ct-btn{display:inline-flex;align-items:center;gap:8px;background:var(--_p);color:var(--_pt);border:none;border-radius:calc(var(--_r) - 4px);padding:11px 18px;font-weight:800;font-size:13.5px;cursor:pointer;font-family:inherit;min-height:44px;}.dia-ct-btn svg{width:15px;height:15px;}.dia-ct-arte{position:relative;height:100%;min-height:170px;}.dia-ct-arte img{position:absolute;left:6%;top:8%;width:88%;height:84%;object-fit:contain;filter:drop-shadow(0 20px 26px rgba(0,0,0,.2));}.dia-ct-arte .dia-demo-arte{background:none;}.dia-tema-catalogo .dia-categorias{display:none !important;}.dia-ft{display:grid;grid-template-columns:250px minmax(0,1fr);gap:26px;align-items:start;}.dia-ft-lado{position:sticky;top:12px;display:flex;flex-direction:column;gap:14px;}.dia-ft-lado-topo{display:none;}.dia-ft-grupo{background:var(--_s);border:1px solid var(--_b);border-radius:calc(var(--_r) + 2px);padding:16px;}.dia-ft-grupo h4{margin:0 0 12px;font-family:var(--_ft);font-size:15px;font-weight:800;}.dia-ft-cats{display:flex;flex-direction:column;gap:2px;}.dia-ft-cat{display:flex;justify-content:space-between;align-items:center;gap:10px;background:none;border:none;color:var(--_t);font-family:inherit;font-size:14px;padding:9px 10px;border-radius:calc(var(--_r) - 4px);cursor:pointer;text-align:left;min-height:40px;}.dia-ft-cat small{font-size:12px;color:var(--_ts);background:color-mix(in srgb,var(--_t) 6%,transparent);border-radius:999px;padding:2px 8px;}.dia-ft-cat:hover{background:color-mix(in srgb,var(--_t) 5%,transparent);}.dia-ft-cat.dia-activo{background:color-mix(in srgb,var(--_p) 14%,transparent);font-weight:800;}.dia-ft-duplo{position:relative;height:28px;}.dia-ft-duplo::before{content:\\"\\";position:absolute;left:0;right:0;top:12px;height:4px;border-radius:4px;background:color-mix(in srgb,var(--_t) 12%,transparent);}.dia-ft-trilho{position:absolute;top:12px;height:4px;border-radius:4px;background:var(--_p);}.dia-ft-duplo input{position:absolute;left:0;top:4px;width:100%;margin:0;background:none;pointer-events:none;-webkit-appearance:none;appearance:none;height:20px;}.dia-ft-duplo input::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:20px;height:20px;border-radius:50%;background:var(--_f);border:3px solid var(--_p);cursor:pointer;position:relative;z-index:2;}.dia-ft-duplo input::-moz-range-thumb{pointer-events:auto;width:16px;height:16px;border-radius:50%;background:var(--_f);border:3px solid var(--_p);cursor:pointer;}.dia-ft-duplo input::-webkit-slider-runnable-track{background:none;}.dia-ft-duplo input::-moz-range-track{background:none;}.dia-ft-valores{display:flex;justify-content:space-between;font-size:12.5px;font-weight:700;color:var(--_ts);margin-top:6px;}.dia-ft-ver{display:flex;align-items:center;gap:10px;font-size:14px;padding:6px 0;cursor:pointer;min-height:36px;}.dia-ft-ver input{width:18px;height:18px;accent-color:var(--dia-primaria,currentColor);flex-shrink:0;}.dia-ft-limpar{background:none;border:1px dashed var(--_b);color:var(--_ts);border-radius:calc(var(--_r) - 4px);padding:11px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;}.dia-ft-ver-res{display:none;}.dia-ft-barra{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--_b);}.dia-ft-conta{font-size:13.5px;color:var(--_ts);font-weight:700;margin-right:auto;}.dia-ft-abrir{display:none;align-items:center;gap:8px;border:1px solid var(--_b);background:var(--_s);color:var(--_t);border-radius:999px;padding:10px 16px;font-weight:800;font-size:13.5px;cursor:pointer;font-family:inherit;min-height:42px;}.dia-ft-abrir svg{width:16px;height:16px;}.dia-ft-vista{display:flex;gap:4px;}.dia-ft-vista button{width:40px;height:40px;border-radius:10px;border:1px solid var(--_b);background:transparent;color:var(--_ts);cursor:pointer;display:flex;align-items:center;justify-content:center;}.dia-ft-vista button svg{width:17px;height:17px;}.dia-ft-vista button.dia-activo{background:var(--dia-primaria,currentColor);color:var(--dia-primaria-texto,var(--_f));border-color:transparent;}.dia-loja .dia-ft-grelha.dia-ft-em-lista{grid-template-columns:1fr;}.dia-ft-em-lista .dia-produto-card{flex-direction:row;align-items:stretch;}.dia-ft-em-lista .dia-produto-media{width:clamp(110px,22%,200px);flex-shrink:0;aspect-ratio:1/1;}.dia-ft-em-lista .dia-produto-corpo{justify-content:center;}.dia-tema-catalogo .dia-produto-card{background:var(--_f);border:1px solid var(--_b);border-radius:calc(var(--_r) + 6px);}.dia-tema-catalogo .dia-produto-media{margin:8px 8px 0;border-radius:calc(var(--_r) + 2px);background:color-mix(in srgb,var(--_t) 5%,transparent);}.dia-tema-catalogo .dia-ft-em-lista .dia-produto-media{margin:8px;}.dia-tema-catalogo .dia-produto-corpo{align-items:center;text-align:center;}.dia-tema-catalogo .dia-ft-em-lista .dia-produto-corpo{align-items:flex-start;text-align:left;}.dia-tema-catalogo .dia-produto-precos{padding-right:0;justify-content:center;}.dia-tema-catalogo .dia-ft-em-lista .dia-produto-precos{justify-content:flex-start;}.dia-tema-catalogo .dia-produto-preco{border:1.5px solid color-mix(in srgb,var(--_p) 60%,transparent);color:var(--_p);border-radius:999px;padding:4px 12px;font-size:15px;}.dia-tema-catalogo .dia-btn-add{top:16px;right:16px;bottom:auto;background:var(--_f);color:var(--_t);box-shadow:0 6px 16px rgba(0,0,0,.12);}.dia-ft-portal{display:none;}@media (max-width:1100px){.dia-ft{grid-template-columns:220px minmax(0,1fr);}}@media (max-width:860px){.dia-ft{grid-template-columns:1fr;}.dia-ft > .dia-ft-lado{display:none;}.dia-ft-abrir{display:inline-flex;}.dia-ft-barra .dia-ed-ordem > span{display:none;}.dia-ft-portal{display:block;position:fixed;inset:0;z-index:100001;}.dia-ft-fundo{position:absolute;inset:0;background:rgba(0,0,0,.45);opacity:0;transition:opacity .3s ease;}.dia-ft-portal .dia-ft-lado{position:absolute;left:0;right:0;bottom:0;top:auto;max-height:86vh;overflow-y:auto;background:var(--_f);color:var(--_t);padding:18px 16px 20px;border-radius:20px 20px 0 0;box-shadow:0 -20px 60px rgba(0,0,0,.3);transform:translateY(105%);transition:transform .35s cubic-bezier(.2,.8,.2,1);}.dia-ft-portal.dia-ft-aberto .dia-ft-lado{transform:none;}.dia-ft-portal.dia-ft-aberto .dia-ft-fundo{opacity:1;}.dia-ft-lado-topo{display:flex;justify-content:space-between;align-items:center;font-size:17px;}.dia-ft-fechar{width:38px;height:38px;border-radius:50%;border:none;background:color-mix(in srgb,var(--_t) 8%,transparent);color:var(--_t);display:flex;align-items:center;justify-content:center;cursor:pointer;}.dia-ft-fechar svg{width:16px;height:16px;}.dia-ft-ver-res{display:block;background:var(--dia-primaria,#111);color:var(--dia-primaria-texto,#fff);border:none;border-radius:calc(var(--_r) - 4px);padding:14px;font-weight:800;font-size:14.5px;cursor:pointer;font-family:inherit;}}.dia-vt{display:flex;flex-direction:column;gap:18px;}.dia-vt-palco{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.6fr) minmax(0,.8fr);align-items:center;gap:clamp(14px,3vw,40px);min-height:clamp(300px,36vw,460px);padding:clamp(10px,2vw,24px) 0;}.dia-vt-eti{font-family:var(--_ft);font-style:italic;font-size:clamp(22px,2.4vw,30px);color:var(--_t);display:block;margin-bottom:2px;}.dia-vt-texto h2{font-family:var(--_ft);font-weight:500;font-size:clamp(24px,2.8vw,38px);line-height:1.1;color:var(--_p);margin:0 0 12px;letter-spacing:-.01em;overflow-wrap:anywhere;}.dia-vt-texto p{font-size:14px;color:var(--_ts);line-height:1.55;margin:0 0 16px;}.dia-vt-ver{background:none;border:none;border-bottom:1.5px solid currentColor;color:var(--_t);font-weight:700;font-size:13px;padding:4px 0;cursor:pointer;font-family:inherit;letter-spacing:.04em;}.dia-vt-foto{background:none;border:none;padding:0;cursor:pointer;height:clamp(240px,30vw,400px);display:flex;align-items:center;justify-content:center;position:relative;width:100%;}.dia-vt-foto img{max-width:100%;max-height:100%;object-fit:contain;filter:drop-shadow(0 28px 30px rgba(0,0,0,.18));animation:dia-vt-entra .5s ease;}.dia-vt-foto .dia-demo-arte{background:none;}@keyframes dia-vt-entra{from{opacity:0;transform:translateX(18px);}to{opacity:1;transform:none;}}.dia-vt-preco{justify-self:end;display:flex;flex-direction:column;align-items:stretch;min-width:170px;}.dia-vt-nome{background:color-mix(in srgb,var(--_t) 90%,var(--_p));color:#fff;font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:9px 14px;text-align:center;}.dia-vt-caixa{display:flex;align-items:stretch;background:var(--_s);border:1px solid var(--_b);}.dia-vt-caixa b{flex:1;padding:12px 14px;font-size:19px;font-weight:800;white-space:nowrap;}.dia-vt-add{width:48px;border:none;background:var(--dia-primaria,#111);color:var(--dia-primaria-texto,#fff);cursor:pointer;display:flex;align-items:center;justify-content:center;}.dia-vt-add svg{width:18px;height:18px;}.dia-vt-preco s{font-size:12.5px;color:var(--_ts);margin-top:6px;text-align:right;}.dia-vt-fila{display:flex;align-items:center;gap:10px;border-top:1px solid var(--_b);border-bottom:1px solid var(--_b);padding:16px 0;}.dia-vt-seta{width:40px;height:40px;flex-shrink:0;border:none;background:none;color:var(--_p);cursor:pointer;display:flex;align-items:center;justify-content:center;}.dia-vt-seta svg{width:22px;height:22px;}.dia-vt-minis{display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;flex:1;scroll-snap-type:x mandatory;}.dia-vt-minis::-webkit-scrollbar{display:none;}.dia-vt-mini{flex:0 0 clamp(110px,15%,170px);display:flex;flex-direction:column;align-items:center;gap:6px;background:none;border:none;border-radius:var(--_r);padding:8px;cursor:pointer;color:var(--_ts);font-family:inherit;font-size:12.5px;scroll-snap-align:start;transition:background .2s ease;min-width:0;}.dia-vt-mini.dia-activo{background:color-mix(in srgb,var(--_p) 10%,transparent);color:var(--_t);font-weight:700;}.dia-vt-mini-img{position:relative;width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;}.dia-vt-mini-img img{max-width:100%;max-height:100%;object-fit:contain;}.dia-vt-mini > span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}.dia-vt-faixa{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);align-items:stretch;}.dia-vt-desde{background:color-mix(in srgb,var(--_t) 90%,var(--_p));color:#fff;padding:22px 24px;display:flex;flex-direction:column;gap:4px;}.dia-vt-desde span{font-weight:700;color:color-mix(in srgb,var(--_p) 45%,#fff);font-size:14px;}.dia-vt-desde b{font-size:clamp(26px,3vw,34px);font-weight:800;}.dia-vt-desde small{opacity:.7;font-size:12px;}.dia-vt-cats{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:18px 22px;background:var(--_s);border:1px solid var(--_b);border-left:none;}.dia-vt-cats > span{color:var(--_ts);font-size:14px;}.dia-vt-cat{border:1.5px solid var(--_b);background:var(--_f);color:var(--_t);border-radius:999px;padding:9px 15px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;}.dia-vt-cat:hover{border-color:var(--_p);}.dia-vt-tudo{margin-left:auto;background:none;border:none;color:var(--_p);font-weight:800;font-size:13.5px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-family:inherit;min-height:40px;}.dia-vt-tudo svg{width:15px;height:15px;}.dia-tema-vitrine .dia-produto-card{background:none;border:none;overflow:visible;}.dia-tema-vitrine .dia-produto-card:hover{box-shadow:none;}.dia-tema-vitrine .dia-produto-media{background:none;}.dia-tema-vitrine .dia-img-fundo{display:none;}.dia-tema-vitrine .dia-produto-corpo{align-items:center;text-align:center;}.dia-tema-vitrine .dia-produto-precos{padding-right:0;justify-content:center;}.dia-tema-vitrine .dia-produto-cat{display:none;}.dia-tema-vitrine .dia-btn-add{top:10px;right:10px;bottom:auto;border-radius:0;}.dia-tema-vitrine .dia-seccao-titulo{font-weight:500;font-size:clamp(20px,2.2vw,26px);}@media (max-width:860px){.dia-vt-palco{grid-template-columns:1fr 1fr;}.dia-vt-texto{grid-column:1/-1;}.dia-vt-preco{justify-self:stretch;align-self:center;min-width:0;}.dia-vt-faixa{grid-template-columns:1fr;}.dia-vt-cats{border-left:1px solid var(--_b);}}@media (max-width:560px){.dia-vt-palco{grid-template-columns:1fr;}.dia-vt-foto{height:240px;}.dia-vt-seta{display:none;}.dia-vt-mini{flex-basis:38%;}.dia-vt-tudo{margin-left:0;}}.dia-bento{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-auto-rows:minmax(170px,auto);gap:14px;}.dia-bt-grande{grid-column:span 2;grid-row:span 2;position:relative;border-radius:28px;overflow:hidden;background:linear-gradient(140deg,color-mix(in srgb,var(--_p) 22%,#fff),#FFE3D3);color:#1d1d1f;display:flex;align-items:flex-end;padding:clamp(20px,3vw,34px);isolation:isolate;min-height:clamp(320px,36vw,440px);}.dia-bt-poucos .dia-bt-grande{grid-row:span 1;}.dia-bt-foto{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;}.dia-bt-grande:has(.dia-bt-foto){color:#fff;}.dia-bt-grande:has(.dia-bt-foto)::after{content:\\"\\";position:absolute;inset:0;z-index:-1;background:linear-gradient(0deg,rgba(0,0,0,.6),rgba(0,0,0,0) 65%);}.dia-bt-bolha{position:absolute;width:62%;aspect-ratio:1;border-radius:50%;right:-14%;top:-18%;background:var(--_p);opacity:.85;z-index:-1;}.dia-bt-bolha.dia-b2{width:34%;right:auto;left:-8%;top:auto;bottom:24%;background:#7FD3C3;opacity:.7;}.dia-bt-eti{display:inline-block;background:#fff;color:#1d1d1f;border-radius:999px;padding:6px 12px;font-size:11.5px;font-weight:800;margin-bottom:12px;}.dia-bt-texto h2{font-family:var(--_ft);font-weight:800;font-size:clamp(28px,3.6vw,48px);line-height:1.02;letter-spacing:-.03em;margin:0 0 10px;overflow-wrap:anywhere;}.dia-bt-texto p{margin:0 0 18px;font-size:14.5px;opacity:.82;max-width:380px;}.dia-bt-btn{display:inline-flex;align-items:center;gap:8px;background:#1d1d1f;color:#fff;border:none;border-radius:999px;padding:13px 22px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;min-height:46px;}.dia-bt-btn svg{width:15px;height:15px;}.dia-bt-telha{position:relative;border:none;border-radius:28px;overflow:hidden;cursor:pointer;padding:16px;text-align:left;display:flex;flex-direction:column;justify-content:flex-end;font-family:inherit;color:#1d1d1f;min-height:170px;transition:transform .25s ease;}.dia-bt-telha:hover{transform:translateY(-3px);}.dia-bt-t1{grid-column:span 2;background:#DDF2EC;}.dia-bt-t2{background:#ECE6FF;}.dia-bt-t3{background:#FFF1C9;}.dia-bt-arte{position:absolute;left:10%;right:10%;top:10%;bottom:34%;display:flex;align-items:center;justify-content:center;}.dia-bt-t1 .dia-bt-arte{left:42%;right:8%;top:8%;bottom:8%;}.dia-bt-arte img{max-width:100%;max-height:100%;object-fit:contain;filter:drop-shadow(0 16px 20px rgba(0,0,0,.18));}.dia-bt-arte .dia-demo-arte{background:none;}.dia-bt-info{position:relative;display:flex;flex-direction:column;gap:2px;background:rgba(255,255,255,.78);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-radius:16px;padding:9px 12px;max-width:100%;}.dia-bt-t1 .dia-bt-info{max-width:52%;}.dia-bt-info b{font-size:14px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.dia-bt-info small{font-size:13px;font-weight:800;color:#1d1d1f;opacity:.75;}.dia-cat-pilulas{display:flex;gap:10px;flex-wrap:wrap;}.dia-cat-pilula{display:inline-flex;align-items:center;gap:10px;background:var(--_s);border:1px solid var(--_b);border-radius:999px;padding:6px 16px 6px 6px;font-weight:800;font-size:14px;color:var(--_t);cursor:pointer;font-family:inherit;transition:transform .2s ease,border-color .2s ease;}.dia-cat-pilula:hover{transform:translateY(-2px);border-color:var(--_p);}.dia-cat-ava{width:38px;height:38px;border-radius:50%;overflow:hidden;background:color-mix(in srgb,var(--_p) 20%,#fff);display:flex;align-items:center;justify-content:center;font-weight:800;color:var(--_p);flex-shrink:0;}.dia-cat-ava img{width:100%;height:100%;object-fit:cover;}.dia-cat-pilula small{font-weight:700;color:var(--_ts);font-size:12px;}.dia-tema-bento .dia-produto-card{background:none;border:none;overflow:visible;}.dia-tema-bento .dia-produto-card:hover{box-shadow:none;}.dia-tema-bento .dia-produto-media{border-radius:26px;}.dia-tema-bento .dia-img-fundo{display:none;}.dia-tema-bento .dia-grelha > :nth-child(5n+1) .dia-produto-media,.dia-tema-bento .dia-fila > :nth-child(5n+1) .dia-produto-media{background:#FFE5D6;}.dia-tema-bento .dia-grelha > :nth-child(5n+2) .dia-produto-media,.dia-tema-bento .dia-fila > :nth-child(5n+2) .dia-produto-media{background:#DDF2EC;}.dia-tema-bento .dia-grelha > :nth-child(5n+3) .dia-produto-media,.dia-tema-bento .dia-fila > :nth-child(5n+3) .dia-produto-media{background:#ECE6FF;}.dia-tema-bento .dia-grelha > :nth-child(5n+4) .dia-produto-media,.dia-tema-bento .dia-fila > :nth-child(5n+4) .dia-produto-media{background:#FFF1C9;}.dia-tema-bento .dia-grelha > :nth-child(5n+5) .dia-produto-media,.dia-tema-bento .dia-fila > :nth-child(5n+5) .dia-produto-media{background:color-mix(in srgb,var(--_p) 16%,#fff);}.dia-tema-bento .dia-produto-img{padding:6%;}.dia-tema-bento .dia-produto-corpo{padding:12px 6px 4px;}.dia-tema-bento .dia-btn-add{border-radius:999px;}.dia-tema-bento .dia-seccao-titulo{font-size:clamp(22px,2.6vw,30px);}@media (max-width:860px){.dia-bento{grid-template-columns:1fr 1fr;}.dia-bt-grande{grid-column:1/-1;grid-row:auto;min-height:320px;}.dia-bt-t1{grid-column:1/-1;}}@media (max-width:560px){.dia-bt-telha{min-height:180px;border-radius:22px;}.dia-bt-grande{border-radius:22px;}.dia-bt-t1 .dia-bt-info{max-width:60%;}}",
      ".dia-tema-fresco .dia-bloco{margin-bottom:34px;}.dia-tema-fresco .dia-seccao-titulo{font-size:clamp(20px,2.4vw,26px);}.dia-fr{position:relative;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:clamp(18px,4vw,48px);align-items:center;padding:clamp(22px,4vw,48px);border-radius:calc(var(--_r) + 14px);background:linear-gradient(135deg,color-mix(in srgb,var(--_p) 9%,var(--_f)) 0%,var(--_f) 70%);border:1px solid color-mix(in srgb,var(--_p) 14%,var(--_b));overflow:hidden;}.dia-fr::after{content:\\"\\";position:absolute;right:-12%;top:-30%;width:55%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--_p) 16%,transparent),transparent 65%);pointer-events:none;}.dia-fr-texto{position:relative;z-index:1;}.dia-fr-eti{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;background:color-mix(in srgb,var(--_p) 12%,transparent);color:var(--_p);font-size:12.5px;font-weight:800;letter-spacing:.02em;}.dia-fr-eti svg{width:14px;height:14px;}.dia-fr h2{font-family:var(--_ft);font-size:clamp(32px,5.2vw,62px);line-height:1.03;letter-spacing:-.03em;margin:16px 0 12px;color:var(--_t);}.dia-fr h2 em{font-style:normal;color:var(--_p);display:block;}.dia-fr p{color:var(--_ts);font-size:clamp(15px,1.5vw,17px);line-height:1.6;margin:0 0 22px;max-width:460px;}.dia-fr-btns{display:flex;flex-wrap:wrap;gap:10px;}.dia-fr-btn,.dia-fr-btn2{display:inline-flex;align-items:center;gap:9px;min-height:50px;padding:0 22px;border-radius:calc(var(--_r) - 2px);font:800 15px/1 inherit;font-family:inherit;cursor:pointer;border:none;}.dia-fr-btn{background:var(--_p);color:var(--_pt);box-shadow:0 14px 28px -14px color-mix(in srgb,var(--_p) 80%,transparent);}.dia-fr-btn2{background:var(--_f);color:var(--_t);box-shadow:inset 0 0 0 1px var(--_b);}.dia-fr-btn svg,.dia-fr-btn2 svg{width:16px;height:16px;}.dia-fr-vant{display:flex;flex-wrap:wrap;gap:10px 18px;margin-top:22px;}.dia-fr-vant span{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--_t);}.dia-fr-vant i{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:color-mix(in srgb,var(--_p) 12%,var(--_f));color:var(--_p);}.dia-fr-vant svg{width:17px;height:17px;}.dia-fr-arte{position:relative;z-index:1;aspect-ratio:1/0.9;display:grid;place-items:center;}.dia-fr-circulo{position:absolute;width:86%;aspect-ratio:1;border-radius:50%;background:color-mix(in srgb,var(--_p) 15%,var(--_f));}.dia-fr-arte img{position:relative;max-width:82%;max-height:100%;object-fit:contain;filter:drop-shadow(0 24px 30px rgba(0,0,0,.18));}.dia-fr-foto .dia-fr-arte img{width:92%;height:92%;object-fit:cover;border-radius:calc(var(--_r) + 18px);max-width:none;}.dia-fr-arte .dia-demo-arte{position:relative;width:76%;aspect-ratio:1;border-radius:50%;}.dia-fr-selo{position:absolute;left:4%;top:8%;width:clamp(86px,12vw,112px);aspect-ratio:1;border-radius:50%;background:var(--_f);border:3px solid var(--_p);display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;box-shadow:0 14px 30px -12px rgba(0,0,0,.25);color:var(--_t);transform:rotate(-8deg);}.dia-fr-selo b{font-family:var(--_ft);font-size:clamp(24px,3.2vw,32px);color:var(--_p);margin:3px 0;}.dia-fr-selo small{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;}.dia-tema-fresco .dia-produto-card{background:var(--_f);border:1px solid var(--_b);border-radius:calc(var(--_r) + 2px);padding:10px;}.dia-tema-fresco .dia-produto-media{border-radius:var(--_r);background:color-mix(in srgb,var(--_p) 6%,var(--_f));}.dia-tema-fresco .dia-produto-img{object-fit:contain;padding:8%;}.dia-tema-fresco .dia-produto-corpo{padding:10px 4px 8px;gap:4px;}.dia-tema-fresco .dia-produto-nome{font-size:14px;font-weight:700;font-family:inherit;}.dia-tema-fresco .dia-produto-preco{color:var(--_p);font-size:17px;}.dia-tema-fresco .dia-produto-precos{padding-right:0;}.dia-tema-fresco .dia-badge{background:var(--_p);color:var(--_pt);border-radius:8px;}.dia-tema-fresco .dia-btn-add{position:static;width:auto;height:42px;margin:2px 0 0;border-radius:calc(var(--_r) - 4px);gap:7px;font-weight:800;font-size:13.5px;font-family:inherit;box-shadow:none;}.dia-tema-fresco .dia-btn-add:hover{transform:none;filter:brightness(1.08);}.dia-tema-fresco .dia-btn-add svg{width:16px;height:16px;}.dia-tema-fresco .dia-add-txt{display:inline;}.dia-tema-fresco .dia-cat-cartao{background:var(--_f);border:1px solid var(--_b);border-radius:calc(var(--_r) + 2px);}.dia-tema-sabor .dia-bloco{margin-bottom:38px;}.dia-sb{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:clamp(18px,4vw,40px);align-items:center;padding:clamp(26px,5vw,60px);border-radius:calc(var(--_r) + 18px);background:radial-gradient(120% 120% at 85% 20%,color-mix(in srgb,var(--_p) 38%,#1a0f08) 0%,#140b06 55%,#0d0704 100%);color:#fff;overflow:hidden;}.dia-sb::before{content:\\"\\";position:absolute;inset:auto -10% -40% auto;width:60%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--_p) 40%,transparent),transparent 60%);opacity:.6;}.dia-sb-texto{position:relative;z-index:1;}.dia-sb-eti{display:inline-flex;align-items:center;gap:10px;font-size:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.75);}.dia-sb-eti i{width:5px;height:5px;border-radius:50%;background:var(--_p);display:inline-block;}.dia-sb h2{font-family:var(--_ft);font-size:clamp(34px,5.6vw,66px);line-height:1;letter-spacing:-.02em;margin:16px 0 14px;color:#fff;}.dia-sb h2 em{font-family:\\"Brush Script MT\\",\\"Segoe Script\\",\\"Lucida Handwriting\\",cursive;font-weight:400;font-style:normal;color:var(--_p);font-size:1.12em;letter-spacing:0;}.dia-sb p{color:rgba(255,255,255,.78);font-size:clamp(15px,1.5vw,17px);line-height:1.6;margin:0 0 24px;max-width:440px;}.dia-sb-btn{display:inline-flex;align-items:center;gap:9px;min-height:52px;padding:0 26px;border-radius:999px;background:var(--_p);color:var(--_pt);border:none;font:800 15px/1 inherit;font-family:inherit;cursor:pointer;box-shadow:0 16px 30px -12px color-mix(in srgb,var(--_p) 90%,transparent);}.dia-sb-btn svg{width:16px;height:16px;}.dia-sb-garantias{display:flex;flex-wrap:wrap;gap:10px 22px;margin-top:26px;padding-top:20px;border-top:1px solid rgba(255,255,255,.14);}.dia-sb-garantias span{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:rgba(255,255,255,.88);}.dia-sb-garantias svg{width:18px;height:18px;color:var(--_p);}.dia-sb-arte{position:relative;z-index:1;aspect-ratio:1;display:grid;place-items:center;}.dia-sb-anel{position:absolute;width:92%;aspect-ratio:1;border-radius:50%;border:1.5px dashed color-mix(in srgb,var(--_p) 60%,transparent);animation:dia-sb-gira 40s linear infinite;}@keyframes dia-sb-gira{to{transform:rotate(360deg);}}.dia-sb-prato{position:relative;width:78%;aspect-ratio:1;border-radius:50%;overflow:hidden;box-shadow:0 30px 60px -20px rgba(0,0,0,.7);background:rgba(255,255,255,.06);}.dia-sb-prato img{width:100%;height:100%;object-fit:cover;}.dia-sb-prato .dia-demo-arte{width:100%;height:100%;}.dia-sb-preco{position:absolute;left:0;bottom:12%;display:flex;flex-direction:column;align-items:flex-start;gap:3px;max-width:62%;padding:12px 16px;border-radius:16px;background:#fff;color:#1a1a1a;border:none;cursor:pointer;text-align:left;font-family:inherit;box-shadow:0 18px 40px -14px rgba(0,0,0,.6);}.dia-sb-preco small{font-size:12px;font-weight:700;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}.dia-sb-preco b{font-family:var(--_ft);font-size:20px;color:var(--_p);}.dia-sb-nota{position:absolute;right:4%;top:10%;display:inline-flex;align-items:center;gap:6px;padding:9px 13px;border-radius:999px;background:rgba(255,255,255,.95);color:#1a1a1a;font-weight:800;font-size:14px;box-shadow:0 12px 30px -12px rgba(0,0,0,.5);}.dia-sb-nota svg{width:15px;height:15px;color:#F5A623;}.dia-tema-sabor .dia-produto-card{background:var(--_f);border:1px solid var(--_b);border-radius:calc(var(--_r) + 4px);overflow:hidden;box-shadow:0 18px 40px -30px rgba(0,0,0,.35);}.dia-tema-sabor .dia-produto-media{border-radius:0;}.dia-tema-sabor .dia-produto-corpo{padding:14px 14px 12px;gap:5px;}.dia-tema-sabor .dia-produto-nome{font-size:15.5px;font-weight:800;}.dia-tema-sabor .dia-produto-preco{font-size:17px;}.dia-tema-sabor .dia-btn-add{position:static;width:calc(100% - 28px);height:42px;margin:0 14px 14px;border-radius:999px;gap:7px;font-weight:800;font-size:13.5px;font-family:inherit;box-shadow:none;}.dia-tema-sabor .dia-btn-add:hover{transform:none;filter:brightness(1.08);}.dia-tema-sabor .dia-btn-add svg{width:16px;height:16px;}.dia-tema-sabor .dia-add-txt{display:inline;}.dia-tema-sabor .dia-cat-cartao{border-radius:calc(var(--_r) + 6px);background:color-mix(in srgb,var(--_p) 10%,var(--_f));border:none;}@media (max-width:760px){.dia-fr,.dia-sb{grid-template-columns:1fr;}.dia-fr-arte{order:-1;max-width:340px;width:100%;margin:0 auto;}.dia-sb-arte{max-width:320px;width:100%;margin:6px auto 0;}.dia-fr h2 em{display:inline;}.dia-fr-selo{left:0;top:2%;}.dia-sb-preco{left:-4px;}}@media (prefers-reduced-motion:reduce){.dia-sb-anel{animation:none;}}",
      ".dia-ver-loja{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px;border:1px solid var(--_b);border-radius:calc(var(--_r) + 6px);background:color-mix(in srgb,var(--_t) 3%,var(--_f));color:var(--_t);text-decoration:none;transition:border-color .2s,transform .2s}.dia-ver-loja:hover{border-color:var(--_p);transform:translateY(-2px)}.dia-ver-loja b{display:block;font-family:var(--_ft);font-size:clamp(18px,2.4vw,24px);letter-spacing:-.01em}.dia-ver-loja small{display:block;color:var(--_ts);font-size:14px;margin-top:4px}.dia-ver-loja i{flex:0 0 52px;height:52px;border-radius:50%;display:grid;place-items:center;background:var(--_p);color:var(--_pt)}.dia-ver-loja i svg{width:20px;height:20px}.dia-migalhas{display:flex;flex-wrap:wrap;gap:8px;font-size:13px;color:var(--_ts);margin:0 0 14px}.dia-migalhas a{color:inherit;text-decoration:none}.dia-migalhas a:hover{color:var(--_p)}.dia-pagina-produto{background:var(--_f);border:1px solid var(--_b);border-radius:calc(var(--_r) + 8px);overflow:hidden}@media (min-width:900px){.dia-pagina-produto .dia-galeria{position:sticky;top:84px;align-self:start}}.dia-loja.dia-loja-pagina-loja .dia-categorias{display:none!important}.dia-pagina-produto.dia-detalhe{max-width:none}.dia-btn-auto{display:inline-flex;width:auto;margin-top:14px;padding:0 22px;text-decoration:none;align-items:center}@media (min-width:900px){html.dia-carrinho-no-cabecalho .dia-carrinho-botao{display:none!important}}[data-dia-carrinho-contagem][data-vazio=\\"1\\"]{opacity:.6}",
      '@media (prefers-reduced-motion:reduce){.dia-loja *,.dia-modal,.dia-overlay,.dia-painel-carrinho,.dia-carrinho-botao,.dia-toast{animation:none !important;transition:none !important;}}'
    ];
    var style = document.createElement('style');
    style.setAttribute('data-daniel-ia', 'loja');
    style.textContent = css.join('');
    document.head.appendChild(style);
  }

  // ======================================================
  // Montagem
  // ======================================================
  function montarUI(){
    var alvo = $('daniel-ia-produtos');
    if (!alvo && !MULTI) {
      console.error('Daniel IA: falta uma div com id="daniel-ia-produtos" nesta página - os produtos não têm onde aparecer.');
      return false;
    }
    if (alvo) {
      var esqueletos = '';
      for (var i = 0; i < 8; i++) esqueletos += '<div class="dia-esqueleto"></div>';
      alvo.innerHTML = '<div class="dia-loja" id="dia-loja">'
        + '<div id="dia-montra"><div class="dia-grelha">' + esqueletos + '</div></div>'
        + '<div id="dia-resultados"></div>'
        + '</div>';
    }

    var botao = document.createElement('button');
    botao.id = 'dia-carrinho-botao';
    botao.className = 'dia-carrinho-botao';
    botao.setAttribute('aria-label', tx('Abrir carrinho'));
    botao.innerHTML = ICONES.carrinho + '<span>' + tx('Carrinho') + '</span><span class="dia-contagem" id="dia-carrinho-contagem">0</span>';
    document.body.appendChild(botao);

    var fundo = document.createElement('div');
    fundo.className = 'dia-fundo-escuro';
    fundo.id = 'dia-fundo-escuro';
    document.body.appendChild(fundo);

    var painel = document.createElement('aside');
    painel.id = 'dia-painel-carrinho';
    painel.className = 'dia-painel-carrinho';
    painel.innerHTML = ''
      + '<div class="dia-painel-cabeca"><strong>' + tx('O teu carrinho') + '</strong><button class="dia-icone-btn" id="dia-fechar-painel" aria-label="' + tx('Fechar') + '">' + ICONES.fechar + '</button></div>'
      + '<div id="dia-itens-carrinho"></div>'
      + '<div class="dia-painel-rodape" id="dia-painel-rodape">'
      + '<div class="dia-total"><span>' + tx('Total') + '</span><strong id="dia-total-carrinho">0 MZN</strong></div>'
      + '<button id="dia-btn-finalizar" class="dia-btn-principal" disabled>' + tx('Finalizar compra') + '</button>'
      + '</div>';
    document.body.appendChild(painel);

    var t = document.createElement('div');
    t.className = 'dia-toast';
    t.id = 'dia-toast';
    document.body.appendChild(t);

    botao.addEventListener('click', abrirPainel);
    // Carrinho desenhado no cabeçalho do site (data-dia-carrinho).
    var noCabecalho = document.querySelectorAll('[data-dia-carrinho]');
    if (noCabecalho.length) {
      document.documentElement.classList.add('dia-carrinho-no-cabecalho');
      cada(noCabecalho, function(b){ b.addEventListener('click', function(e){ e.preventDefault(); abrirPainel(); }); });
    }
    fundo.addEventListener('click', fecharPainel);
    $('dia-fechar-painel').addEventListener('click', fecharPainel);
    $('dia-btn-finalizar').addEventListener('click', function(){ fecharPainel(); abrirCheckout(); });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape') { fecharPainel(); fecharJanela(); }
    });
    return true;
  }

  function abrirPainel(){
    $('dia-painel-carrinho').classList.add('aberto');
    $('dia-fundo-escuro').classList.add('aberto');
  }
  function fecharPainel(){
    var p = $('dia-painel-carrinho');
    if (p) p.classList.remove('aberto');
    var f = $('dia-fundo-escuro');
    if (f) f.classList.remove('aberto');
  }

  function marcarSelo(){
    var com = !!document.getElementById('daniel-ia-marca-dagua');
    document.documentElement.classList.toggle('dia-com-selo', com);
  }
  window.addEventListener('load', marcarSelo);

  // Cada versão do estúdio de layouts sugere um estilo de cartões (meta no
  // HTML). Vale enquanto o dono não escolher o seu na montra.
  function estiloSugerido(){
    var m = document.querySelector('meta[name="daniel-ia-estilo-loja"]');
    var v = m ? m.getAttribute('content') : '';
    return /^(suave|moldura|minimal)$/.test(v || '') ? v : '';
  }
  function montra(){
    if (NAVEGAR && PAGINA === 'loja') {
      var mm = loja.montra || {};
      return { blocos: [{ id: 'ft', tipo: 'filtros' }, { id: 'vistos', tipo: 'vistos' }], estilo: { cartao: (mm.estilo && mm.estilo.cartao) || estiloSugerido() || 'suave', colunas: 4 }, tema: temaLoja(), padrao: true };
    }
    var base = montraBase();
    if (NAVEGAR && produtos.length > LOJA_PEQUENA) {
      var blocos = base.blocos.filter(function(b){ return b && ['catalogo', 'colecao', 'filtros'].indexOf(b.tipo) === -1; });
      var iv = -1;
      blocos.forEach(function(b, i){ if (b.tipo === 'vistos' && iv < 0) iv = i; });
      blocos.splice(iv < 0 ? blocos.length : iv, 0, { id: 'verloja', tipo: 'ver_loja' });
      base = { blocos: blocos, estilo: base.estilo, tema: base.tema, padrao: base.padrao };
    }
    return base;
  }
  function montraBase(){
    var m = (loja.montra && loja.montra.blocos && loja.montra.blocos.length) ? loja.montra : MONTRA_PADRAO;
    var padrao = (m === MONTRA_PADRAO || !!m.padrao);
    var tema = temaLoja();
    var sug = estiloSugerido();
    var estilo = { cartao: (m.estilo && m.estilo.cartao) || 'suave', colunas: (m.estilo && m.estilo.colunas) || 4 };
    if (padrao && sug) estilo.cartao = sug;
    if (padrao && tema && MONTRAS_TEMA[tema]) {
      estilo.colunas = MONTRAS_TEMA[tema].colunas;
      return { blocos: MONTRAS_TEMA[tema].blocos, estilo: estilo, tema: tema, padrao: true };
    }
    return { blocos: m.blocos, estilo: estilo, tema: tema, padrao: padrao };
  }

  // ======================================================
  // Dados para os blocos
  // ======================================================
  // ======================================================
  // Arrumação automática: a loja fica arrumada mesmo que o dono não a arrume
  //   - esgotados no fim; destaques, mais vendidos e com foto primeiro
  //   - destaques com limite (cerca de 1/4 da loja)
  //   - loja pequena: sem filas, só a grelha (nada de repetir)
  //   - filas só com produtos suficientes para encher
  //   - o catálogo não repete o que as filas de cima já mostraram
  // ======================================================
  var LOJA_PEQUENA = 8;
  var SEM_REPETIR_ATE = 30;
  var mostrados = {};
  function ordenar(lista){
    return lista.slice().sort(function(a, b){
      var ea = a.esgotado ? 1 : 0, eb = b.esgotado ? 1 : 0;
      if (ea !== eb) return ea - eb;
      var da = a.destaque ? 1 : 0, db = b.destaque ? 1 : 0;
      if (da !== db) return db - da;
      var va = a.vendidos || 0, vb = b.vendidos || 0;
      if (va !== vb) return vb - va;
      var fa = imagemDe(a) ? 1 : 0, fb = imagemDe(b) ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return String(b.criado || '').localeCompare(String(a.criado || ''));
    });
  }
  function limiteDestaques(){ return Math.max(4, Math.ceil(produtos.length / 4)); }
  function disponiveis(lista){ return lista.filter(function(p){ return !p.esgotado; }); }
  function marcarMostrados(lista){ lista.forEach(function(p){ mostrados[p.id] = true; }); }

  function configCategorias(){ return (loja.montra && loja.montra.categorias) || []; }
  function categorias(){
    var mapa = {}, ordem = [];
    var cfg = {};
    configCategorias().forEach(function(c, i){ cfg[String(c.nome).toLowerCase()] = { i: i, imagem: c.imagem || '' }; });
    produtos.forEach(function(p){
      var c = p.categoria || OUTROS;
      if (!mapa[c]) { mapa[c] = { nome: c, total: 0, imagem: '' }; ordem.push(c); }
      mapa[c].total++;
      if (!mapa[c].imagem && imagemDe(p)) mapa[c].imagem = imagemDe(p);
    });
    ordem.forEach(function(c){ var k = cfg[c.toLowerCase()]; if (k && k.imagem) mapa[c].imagem = k.imagem; });
    ordem.sort(function(a, b){
      if ((a === OUTROS) !== (b === OUTROS)) return (a === OUTROS) - (b === OUTROS);
      var ca = cfg[a.toLowerCase()], cb = cfg[b.toLowerCase()];
      if (ca && cb) return ca.i - cb.i;
      if (ca || cb) return ca ? -1 : 1;
      return mapa[b].total - mapa[a].total || a.localeCompare(b);
    });
    return ordem.map(function(c){ return mapa[c]; });
  }
  function temCategorias(cats){ return cats.some(function(c){ return c.nome !== OUTROS; }); }
  function listaDaFonte(fonte, categoria){
    var l = disponiveis(produtos);
    if (fonte === 'novidades') return l.sort(function(a, b){ return String(b.criado).localeCompare(String(a.criado)); }).slice(0, 14);
    if (fonte === 'promocoes') return l.filter(function(p){ return desconto(p) > 0; }).sort(function(a, b){ return desconto(b) - desconto(a); }).slice(0, 14);
    if (fonte === 'mais_vendidos') return l.filter(function(p){ return p.vendidos > 0; }).sort(function(a, b){ return b.vendidos - a.vendidos; }).slice(0, 14);
    if (fonte === 'categoria') return ordenar(produtos.filter(function(p){ return (p.categoria || OUTROS) === categoria; })).slice(0, 14);
    return ordenar(l.filter(function(p){ return p.destaque; })).slice(0, Math.min(14, limiteDestaques()));
  }
  function tituloDaFonte(b){
    if (b.titulo) return b.titulo;
    return {
      novidades: tx('Novidades'), promocoes: tx('Promoções'), mais_vendidos: tx('Mais vendidos'),
      destaques: tx('Em destaque'), categoria: b.categoria || tx('Produtos')
    }[b.fonte] || tx('Produtos');
  }

  // ======================================================
  // Cartão de produto
  // ======================================================
  function cartao(p){
    var d = desconto(p);
    var img = imagemDe(p);
    var segunda = p.imagens && p.imagens[1];
    var badges = (d > 0 ? '<span class="dia-badge">-' + d + '%</span>' : '') + (eNovo(p) ? '<span class="dia-badge dia-novo">' + tx('Novo') + '</span>' : '');
    var preco = temPrecosDiferentes(p)
      ? '<span class="dia-produto-preco"><small>' + tx('desde') + '</small>' + mzn(precoMinimo(p)) + '</span>'
      : '<span class="dia-produto-preco">' + mzn(p.preco) + '</span>';
    var aval = p.avaliacao && p.avaliacao.total
      ? '<div class="dia-produto-aval">' + estrelas(p.avaliacao.media) + '<span>(' + p.avaliacao.total + ')</span></div>' : '';
    return '<article class="dia-produto-card" data-id="' + esc(p.id) + '" tabindex="0">'
      + '<div class="dia-produto-media">'
      + (img ? fundoDe(img) + '<img class="dia-produto-img" src="' + esc(img) + '" alt="' + esc(p.nome) + '" loading="lazy">'
        : (p.demo ? '<div class="dia-demo-arte dia-demo-' + (Number(String(p.id).slice(7)) % 4) + '"><i></i></div>' : '<div class="dia-produto-vazio">' + ICONES.caixa + '</div>'))
      + (segunda ? '<img class="dia-produto-img dia-segunda" src="' + esc(segunda) + '" alt="" loading="lazy">' : '')
      + (badges ? '<div class="dia-badges">' + badges + '</div>' : '')
      + (p.destaque ? '<span class="dia-badge-destaque" title="' + esc(tx('Em destaque')) + '">' + ICONES.estrela + '</span>' : '')
      + (p.esgotado ? '<div class="dia-esgotado-capa"><span>' + tx('Esgotado') + '</span></div>' : '')
      + '</div>'
      + '<div class="dia-produto-corpo">'
      + (p.categoria ? '<div class="dia-produto-cat">' + esc(p.categoria) + '</div>' : '')
      + '<div class="dia-produto-nome">' + esc(p.nome) + '</div>'
      + aval
      + '<div class="dia-produto-precos">' + preco
      + (d > 0 ? '<s class="dia-produto-antigo">' + mzn(p.preco_antigo) + '</s>' : '') + '</div>'
      + '</div>'
      + (p.esgotado ? '' : '<button class="dia-btn-add" data-add="' + esc(p.id) + '" aria-label="' + esc(tx('Adicionar {nome} ao carrinho', { nome: p.nome })) + '">' + ICONES.mais + '<span class="dia-add-txt">' + tx('Adicionar') + '</span></button>')
      + '</article>';
  }

  function ligarCartoes(raiz){
    cada(raiz.querySelectorAll('.dia-produto-card'), function(card){
      card.addEventListener('click', function(e){
        var add = e.target.closest ? e.target.closest('[data-add]') : null;
        if (add) { e.stopPropagation(); adicionar(add.getAttribute('data-add'), null, 1); return; }
        abrirProduto(card.getAttribute('data-id'));
      });
      card.addEventListener('keydown', function(e){
        if (e.key === 'Enter') abrirProduto(card.getAttribute('data-id'));
      });
    });
  }

  function seccaoComFila(titulo, icone, lista, extra){
    var id = 'dia-f-' + Math.random().toString(36).slice(2, 8);
    return '<div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + (icone || '') + esc(titulo) + '</h3>'
      + '<div class="dia-topo-accoes">' + (extra || '')
      + '<button class="dia-fila-seta dia-esq" data-rolar="' + id + '" data-dir="-1" aria-label="' + tx('Anterior') + '">' + ICONES.seta + '</button>'
      + '<button class="dia-fila-seta dia-dir" data-rolar="' + id + '" data-dir="1" aria-label="' + tx('Seguinte') + '">' + ICONES.seta + '</button></div></div>'
      + '<div class="dia-fila" id="' + id + '">' + lista.map(cartao).join('') + '</div>';
  }
  function ligarSetas(raiz){
    cada(raiz.querySelectorAll('[data-rolar]'), function(b){
      b.addEventListener('click', function(){
        var f = $(b.getAttribute('data-rolar'));
        if (f) f.scrollBy({ left: Number(b.getAttribute('data-dir')) * f.clientWidth * 0.85, behavior: 'smooth' });
      });
    });
  }

  // ======================================================
  // Blocos da montra
  // ======================================================
  var RENDER = {
    anuncio: function(b, el){
      if (!b.texto) return false;
      el.innerHTML = '<div class="dia-anuncio dia-cor-' + esc(b.cor || 'primaria') + '">' + ICONES.megafone + '<span>' + esc(b.texto) + '</span></div>';
    },
    capa: function(b, el){ return (temaActual && CAPAS_TEMA[temaActual]) ? CAPAS_TEMA[temaActual](el) : renderCapa(el); },
    categorias: function(b, el){
      var cats = categorias();
      if (!temCategorias(cats)) return false;
      if (temaActual && b.formato !== 'cartoes') return categoriasTema(cats, el);
      var imgs = b.imagens || {};
      var titulo = b.titulo || tx('Categorias');
      var corpo;
      if (b.formato === 'cartoes') {
        corpo = '<div class="dia-cat-cartoes">' + cats.map(function(c){
          var im = imgs[c.nome] || c.imagem;
          return '<button class="dia-cat-cartao" data-cat="' + esc(c.nome) + '">' + (im ? '<img src="' + esc(im) + '" alt="" loading="lazy">' : '')
            + '<span>' + esc(c.nome) + '<small>' + tx(c.total === 1 ? '{n} produto' : '{n} produtos', { n: c.total }) + '</small></span></button>';
        }).join('') + '</div>';
      } else {
        corpo = '<div class="dia-cat-circulos">' + cats.map(function(c){
          var im = imgs[c.nome] || c.imagem;
          return '<button class="dia-cat-circulo" data-cat="' + esc(c.nome) + '"><span class="dia-cat-img">'
            + (im ? '<img src="' + esc(im) + '" alt="" loading="lazy">' : '<span class="dia-cat-letra">' + esc(c.nome.charAt(0).toUpperCase()) + '</span>')
            + '</span>' + esc(c.nome) + '</button>';
        }).join('') + '</div>';
      }
      el.innerHTML = '<div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + esc(titulo) + '</h3></div>' + corpo;
      cada(el.querySelectorAll('[data-cat]'), function(x){
        x.addEventListener('click', function(){ filtrarCategoria(x.getAttribute('data-cat')); });
      });
    },
    fila: function(b, el){
      if (produtos.length < LOJA_PEQUENA) return false;
      var lista = listaDaFonte(b.fonte, b.categoria);
      if (lista.length < (b.fonte === 'categoria' ? 3 : 4)) return false;
      marcarMostrados(lista);
      var verTodos = b.fonte === 'categoria' && b.categoria
        ? '<button class="dia-ver-todos" data-ver-cat="' + esc(b.categoria) + '">' + tx('Ver todos') + ' ' + ICONES.seta + '</button>' : '';
      var icone = b.fonte === 'destaques' ? ICONES.estrela : (b.fonte === 'promocoes' ? ICONES.raio : '');
      el.innerHTML = seccaoComFila(tituloDaFonte(b), icone, lista, verTodos);
      ligarCartoes(el); ligarSetas(el);
      var vt = el.querySelector('[data-ver-cat]');
      if (vt) vt.addEventListener('click', function(){ filtrarCategoria(vt.getAttribute('data-ver-cat')); });
    },
    banners: function(b, el){
      var itens = (b.itens || []).filter(function(i){ return i.imagem; });
      if (!itens.length) return false;
      el.innerHTML = '<div class="dia-banners dia-n' + itens.length + '">' + itens.map(function(i, n){
        var texto = i.titulo || i.sub;
        return '<button class="dia-banner' + (texto ? ' dia-com-texto' : '') + '" data-banner="' + n + '">'
          + '<img src="' + esc(i.imagem) + '" alt="' + esc(i.titulo || '') + '" loading="lazy">'
          + (texto ? '<span class="dia-banner-texto">' + (i.titulo ? '<b>' + esc(i.titulo) + '</b>' : '') + (i.sub ? '<span>' + esc(i.sub) + '</span>' : '') + '</span>' : '')
          + '</button>';
      }).join('') + '</div>';
      cada(el.querySelectorAll('[data-banner]'), function(x){
        x.addEventListener('click', function(){ irPara((itens[Number(x.getAttribute('data-banner'))] || {}).destino); });
      });
    },
    oferta: function(b, el){
      var fim = Date.parse(b.termina || '');
      if (isNaN(fim) || fim <= Date.now()) return false;
      var lista = b.fonte === 'escolher'
        ? (b.produtos || []).map(produtoPorId).filter(function(p){ return p; })
        : listaDaFonte('promocoes');
      lista = disponiveis(lista);
      if (!lista.length) return false;
      marcarMostrados(lista);
      var id = 'dia-cd-' + Math.random().toString(36).slice(2, 8);
      var topo = '<div class="dia-oferta-topo"><h3 class="dia-oferta-titulo">' + ICONES.raio + esc(b.titulo || tx('Oferta relâmpago')) + '</h3>'
        + '<div class="dia-contagem-reg" id="' + id + '"></div></div>';
      var fila = seccaoComFila('', '', lista, '');
      el.innerHTML = '<div class="dia-oferta">' + topo + fila.replace('<div class="dia-seccao-topo"><h3 class="dia-seccao-titulo"></h3>', '<div class="dia-seccao-topo" style="justify-content:flex-end;margin:-8px 0 8px"><span></span>') + '</div>';
      ligarCartoes(el); ligarSetas(el);
      function tic(){
        var c = $(id);
        if (!c) return;
        var resta = Math.max(0, fim - Date.now());
        if (resta <= 0) { renderMontra(); return; }
        var s = Math.floor(resta / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
        function caixa(v, r){ return '<b>' + (v < 10 ? '0' : '') + v + '<small>' + r + '</small></b>'; }
        c.innerHTML = '<span>' + tx('Termina em') + '</span>' + (d ? caixa(d, tx('dias')) : '') + caixa(h, tx('h')) + caixa(m, tx('min')) + caixa(ss, tx('seg'));
      }
      tic();
      temporizadores.push(setInterval(tic, 1000));
    },
    catalogo: function(b, el){
      if (!produtos.length) {
        el.innerHTML = '<div class="dia-vazio">' + ICONES.caixa + '<div>' + tx('Ainda não há produtos à venda aqui.') + '</div></div>';
        return;
      }
      var cats = categorias();
      // Numa loja pequena ou média, o que as filas de cima já mostraram não se repete aqui.
      var semRepetir = produtos.length <= SEM_REPETIR_ATE;
      var resto = ordenar(produtos).filter(function(p){ return !semRepetir || !mostrados[p.id]; });
      if (!resto.length) return false;
      var cortou = resto.length < produtos.length;
      if (cats.length > 1) {
        var seccoes = cats.map(function(c){
          var todosDaCat = produtos.filter(function(p){ return (p.categoria || OUTROS) === c.nome; });
          var daCat = resto.filter(function(p){ return (p.categoria || OUTROS) === c.nome; });
          if (!daCat.length) return '';
          return '<section class="dia-bloco"><div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + esc(c.nome) + '</h3>'
            + (todosDaCat.length > Math.min(8, daCat.length) ? '<button class="dia-ver-todos" data-ver-cat="' + esc(c.nome) + '">' + tx('Ver todos') + ' ' + ICONES.seta + '</button>' : '')
            + '</div><div class="dia-grelha">' + daCat.slice(0, 8).map(cartao).join('') + '</div></section>';
        }).join('');
        el.innerHTML = (b.titulo ? '<div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + esc(b.titulo) + '</h3></div>' : '') + seccoes;
      } else {
        el.innerHTML = '<div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + esc(b.titulo || (cortou ? tx('Mais produtos') : tx('Todos os produtos'))) + '</h3></div>'
          + '<div class="dia-grelha">' + resto.map(cartao).join('') + '</div>';
      }
      ligarCartoes(el);
      cada(el.querySelectorAll('[data-ver-cat]'), function(x){
        x.addEventListener('click', function(){ filtrarCategoria(x.getAttribute('data-ver-cat')); });
      });
    },
    vistos: function(b, el){
      var lista = lerVistos().map(produtoPorId).filter(function(p){ return p; }).slice(0, 12);
      if (!lista.length) return false;
      el.innerHTML = seccaoComFila(b.titulo || tx('Vistos recentemente'), ICONES.olho, lista, '');
      ligarCartoes(el); ligarSetas(el);
    }
  };

  // ======================================================
  // Temas de loja (1.59.0): cada versão do estúdio traz uma ESTRUTURA de
  // loja própria - não só cores. O tema vem numa <meta> do site (ou do
  // "Gerir loja") e muda a capa, as categorias, as faixas e os cartões.
  //   mercado   - marketplace: mosaico de banners, círculos, ofertas da semana
  //   editorial - revista: título gigante, filtros discretos, fotos grandes
  //   tech      - electrónica: capa dividida, categorias em quadrados, filas
  //   moda      - jovem: capa tipográfica, faixa de categorias, fotos ao alto
  // ======================================================
  var TEMAS = ['mercado', 'editorial', 'tech', 'moda'];
  var temaActual = '';
  var montraEhPadrao = true;
  function temaLoja(){
    var e = (loja.montra && loja.montra.estilo) || {};
    if (e.tema === 'classico') return '';
    if (TEMAS.indexOf(e.tema) !== -1) return e.tema;
    var m = document.querySelector('meta[name="daniel-ia-tema-loja"]');
    var v = m ? m.getAttribute('content') : '';
    return TEMAS.indexOf(v) !== -1 ? v : '';
  }
  var MONTRAS_TEMA = {
    mercado: { colunas: 5, blocos: [
      { id: 'capa', tipo: 'capa' }, { id: 'cats', tipo: 'categorias' }, { id: 'dest', tipo: 'fila', fonte: 'destaques' },
      { id: 'banda', tipo: 'banda' }, { id: 'novos', tipo: 'fila', fonte: 'novidades' }, { id: 'cat', tipo: 'catalogo' }, { id: 'vistos', tipo: 'vistos' }
    ] },
    editorial: { colunas: 4, blocos: [
      { id: 'capa', tipo: 'capa' }, { id: 'col', tipo: 'colecao' }, { id: 'vistos', tipo: 'vistos' }
    ] },
    tech: { colunas: 4, blocos: [
      { id: 'capa', tipo: 'capa' }, { id: 'cats', tipo: 'categorias' }, { id: 'dest', tipo: 'fila', fonte: 'destaques', titulo: tx('Recomendado para ti') },
      { id: 'novos', tipo: 'fila', fonte: 'novidades' }, { id: 'vend', tipo: 'fila', fonte: 'mais_vendidos' }, { id: 'cat', tipo: 'catalogo' }, { id: 'vistos', tipo: 'vistos' }
    ] },
    moda: { colunas: 3, blocos: [
      { id: 'capa', tipo: 'capa' }, { id: 'cats', tipo: 'categorias' }, { id: 'novos', tipo: 'fila', fonte: 'novidades' },
      { id: 'promo', tipo: 'fila', fonte: 'promocoes' }, { id: 'cat', tipo: 'catalogo' }, { id: 'vistos', tipo: 'vistos' }
    ] }
  };

  function dadosCapa(){
    var s = (loja.capa || [])[0] || {};
    var destaque = ordenar(disponiveis(produtos)).filter(function(p){ return imagemDe(p); })[0] || null;
    return {
      imagem: s.imagem || '',
      titulo: s.titulo || loja.nome || tx('A nossa loja'),
      sub: s.subtitulo || (produtos.length ? tx('{n} produtos à tua espera. Escolhe, encomenda e recebe.', { n: produtos.length }) : tx('Descobre os nossos produtos.')),
      botao: s.botao || tx('Ver produtos'),
      produto: destaque
    };
  }
  function maiorDesconto(){ return produtos.reduce(function(m, p){ return p.esgotado ? m : Math.max(m, desconto(p)); }, 0); }
  function arteDe(img, demoN, classe){
    if (img) return '<img class="' + (classe || '') + '" src="' + esc(img) + '" alt="" loading="lazy">';
    return '<div class="dia-demo-arte dia-demo-' + ((demoN || 0) % 4) + '"><i></i></div>';
  }
  function ligarCapaTema(el){
    cada(el.querySelectorAll('[data-ir-catalogo]'), function(b){
      b.addEventListener('click', function(){
        if (NAVEGAR && PAGINA !== 'loja') { irParaPagina('loja.html'); return; }
        var alvo = document.querySelector('.dia-bloco-colecao, .dia-bloco-fila, .dia-bloco-banda, .dia-bloco-catalogo') || $('dia-montra');
        alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    cada(el.querySelectorAll('[data-accao]'), function(b){
      b.addEventListener('click', function(){
        var a = b.getAttribute('data-accao'), v = b.getAttribute('data-valor');
        if (a === 'cat') filtrarCategoria(v);
        else if (a === 'prod') abrirProduto(v);
        else {
          var alvo = document.querySelector('.dia-bloco-banda, .dia-bloco-fila, .dia-bloco-catalogo');
          if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }

  var CAPAS_TEMA = {
    // Mosaico: um banner grande e dois mais pequenos (promoção e categorias)
    mercado: function(el){
      var d = dadosCapa();
      var cats = categorias().filter(function(c){ return c.nome !== OUTROS; });
      var porImagem = ordenar(disponiveis(produtos));
      var promo = maiorDesconto();
      var promoProd = disponiveis(produtos).filter(function(p){ return desconto(p) === promo && promo > 0; })[0];
      function telhaCat(c, n){ return c ? { eti: tx('Categoria'), titulo: c.nome, link: tx(c.total === 1 ? '{n} produto' : '{n} produtos', { n: c.total }), img: c.imagem, demo: n, accao: 'cat', valor: c.nome } : null; }
      function telhaProd(p, n){ return p ? { eti: tx('Em destaque'), titulo: p.nome, link: mzn(precoMinimo(p)), img: imagemDe(p), demo: n, accao: 'prod', valor: p.id } : null; }
      var telhas = [];
      if (promoProd) telhas.push({ eti: tx('Promoção'), titulo: tx('Até {n}% de desconto', { n: promo }), link: tx('Ver ofertas'), img: imagemDe(promoProd), demo: 1, accao: 'promo', valor: '' });
      cats.slice(0, 2).forEach(function(c, i){ if (telhas.length < 2) telhas.push(telhaCat(c, i + 2)); });
      porImagem.slice(1, 3).forEach(function(p, i){ if (telhas.length < 2) telhas.push(telhaProd(p, i + 1)); });
      var grande = '<div class="dia-mos-grande' + (d.imagem ? ' dia-com-foto' : '') + '">'
        + (d.imagem ? '<img class="dia-mos-foto" src="' + esc(d.imagem) + '" alt="">' : '<div class="dia-mos-arte">' + arteDe(d.produto && imagemDe(d.produto), 0) + '</div>')
        + '<div class="dia-mos-texto"><span class="dia-mos-eti">' + esc(tx('Novidades')) + '</span><h2>' + esc(d.titulo) + '</h2><p>' + esc(d.sub) + '</p>'
        + '<button class="dia-mos-btn" data-ir-catalogo>' + esc(d.botao) + ' ' + ICONES.seta + '</button></div></div>';
      var htmlTelhas = telhas.map(function(t, i){
        return '<button class="dia-mos-telha dia-mos-t' + i + '" data-accao="' + t.accao + '" data-valor="' + esc(t.valor) + '">'
          + '<span class="dia-mos-telha-txt"><small>' + esc(t.eti) + '</small><b>' + esc(t.titulo) + '</b><span class="dia-mos-link">' + esc(t.link) + ' ' + ICONES.seta + '</span></span>'
          + '<span class="dia-mos-telha-arte">' + arteDe(t.img, t.demo) + '</span></button>';
      }).join('');
      el.innerHTML = '<div class="dia-mosaico' + (telhas.length ? '' : ' dia-mos-so') + '">' + grande + (telhas.length ? '<div class="dia-mos-lado">' + htmlTelhas + '</div>' : '') + '</div>';
      ligarCapaTema(el);
    },
    // Revista: título gigante centrado, uma linha de apoio e foto larga
    editorial: function(el){
      var d = dadosCapa();
      var eti = (loja.nome && d.titulo !== loja.nome) ? loja.nome : tx('Colecção');
      el.innerHTML = '<div class="dia-ed-capa"><span class="dia-ed-eti">' + esc(eti) + '</span>'
        + '<h2 class="dia-ed-titulo">' + esc(d.titulo) + '</h2><p class="dia-ed-sub">' + esc(d.sub) + '</p>'
        + (d.imagem ? '<div class="dia-ed-foto"><img src="' + esc(d.imagem) + '" alt=""></div>' : '')
        + '</div>';
    },
    // Electrónica: texto à esquerda, produto em destaque à direita
    tech: function(el){
      var d = dadosCapa();
      var p = d.produto, desc = p ? desconto(p) : 0;
      var arte = d.imagem ? '<img class="dia-tc-foto" src="' + esc(d.imagem) + '" alt="">'
        : (p ? '<button class="dia-tc-prod" data-accao="prod" data-valor="' + esc(p.id) + '"><img src="' + esc(imagemDe(p)) + '" alt="' + esc(p.nome) + '"></button>' : arteDe('', 2));
      el.innerHTML = '<div class="dia-tc-capa"><div class="dia-tc-texto"><span class="dia-tc-pill">' + ICONES.raio + esc(tx('Novidades')) + '</span>'
        + '<h2>' + esc(d.titulo) + '</h2><p>' + esc(d.sub) + '</p>'
        + '<button class="dia-tc-btn" data-ir-catalogo>' + esc(d.botao) + ' ' + ICONES.seta + '</button></div>'
        + '<div class="dia-tc-arte">' + arte + (!d.imagem && desc > 0 ? '<span class="dia-tc-desc">-' + desc + '%</span>' : '') + '</div></div>';
      ligarCapaTema(el);
    },
    // Moda: título enorme com uma palavra marcada e foto ao alto
    moda: function(el){
      var d = dadosCapa();
      var palavras = String(d.titulo).split(/\\s+/).filter(Boolean);
      var maior = 0;
      palavras.forEach(function(w, i){ if (w.length > palavras[maior].length) maior = i; });
      var titulo = palavras.map(function(w, i){ return i === maior ? '<mark>' + esc(w) + '</mark>' : esc(w); }).join(' ');
      var img = d.imagem || (d.produto && imagemDe(d.produto)) || '';
      el.innerHTML = '<div class="dia-md-capa"><div class="dia-md-texto"><h2 class="dia-md-titulo">' + titulo + '</h2><p>' + esc(d.sub) + '</p>'
        + '<button class="dia-md-btn" data-ir-catalogo>' + esc(d.botao) + ' ' + ICONES.seta + '</button></div>'
        + '<div class="dia-md-arte"><span class="dia-md-forma"></span><span class="dia-md-forma dia-md-forma2"></span>'
        + (img ? '<img src="' + esc(img) + '" alt="">' : arteDe('', 3)) + '</div></div>';
      ligarCapaTema(el);
    }
  };

  // Categorias no formato de cada tema
  function categoriasTema(cats, el){
    var formato = { mercado: 'circulos', tech: 'icones', moda: 'faixa', editorial: 'cartoes', bento: 'pilulas', vitrine: 'cartoes', catalogo: 'cartoes', fresco: 'cartoes', sabor: 'cartoes' }[temaActual] || 'circulos';
    var corpo;
    if (formato === 'pilulas') {
      corpo = '<div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + esc(tx('Compra por categoria')) + '</h3></div><div class="dia-cat-pilulas">' + cats.map(function(c){
        return '<button class="dia-cat-pilula" data-cat="' + esc(c.nome) + '"><span class="dia-cat-ava">' + (c.imagem ? '<img src="' + esc(c.imagem) + '" alt="" loading="lazy">' : esc(c.nome.charAt(0).toUpperCase())) + '</span>'
          + '<span>' + esc(c.nome) + '</span><small>' + c.total + '</small></button>';
      }).join('') + '</div>';
    } else if (formato === 'icones') {
      corpo = '<div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + esc(tx('Explorar categorias')) + '</h3></div><div class="dia-cat-icones">' + cats.map(function(c){
        return '<button class="dia-cat-icone" data-cat="' + esc(c.nome) + '"><span class="dia-cat-quad">'
          + (c.imagem ? '<img src="' + esc(c.imagem) + '" alt="" loading="lazy">' : '<span class="dia-cat-letra">' + esc(c.nome.charAt(0).toUpperCase()) + '</span>')
          + '</span><span class="dia-cat-nome">' + esc(c.nome) + '</span></button>';
      }).join('') + '</div>';
    } else if (formato === 'faixa') {
      var itens = cats.map(function(c){ return '<button class="dia-md-item" data-cat="' + esc(c.nome) + '">' + esc(c.nome) + '</button><span class="dia-md-sep">' + ICONES.estrela + '</span>'; }).join('');
      var rep = cats.length < 6 ? itens + itens : itens;
      corpo = '<div class="dia-md-faixa"><div class="dia-md-pista">' + rep + '<span class="dia-md-copia" aria-hidden="true">' + rep + '</span></div></div>';
    } else if (formato === 'cartoes') {
      corpo = '<div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + esc(tx('Categorias')) + '</h3></div><div class="dia-cat-cartoes">' + cats.map(function(c){
        return '<button class="dia-cat-cartao" data-cat="' + esc(c.nome) + '">' + (c.imagem ? '<img src="' + esc(c.imagem) + '" alt="" loading="lazy">' : '')
          + '<span>' + esc(c.nome) + '<small>' + tx(c.total === 1 ? '{n} produto' : '{n} produtos', { n: c.total }) + '</small></span></button>';
      }).join('') + '</div>';
    } else {
      corpo = '<div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + esc(tx('Compra por categoria')) + '</h3></div><div class="dia-cat-circulos">' + cats.map(function(c){
        return '<button class="dia-cat-circulo" data-cat="' + esc(c.nome) + '"><span class="dia-cat-img">'
          + (c.imagem ? '<img src="' + esc(c.imagem) + '" alt="" loading="lazy">' : '<span class="dia-cat-letra">' + esc(c.nome.charAt(0).toUpperCase()) + '</span>')
          + '</span>' + esc(c.nome) + '</button>';
      }).join('') + '</div>';
    }
    el.innerHTML = corpo;
    cada(el.querySelectorAll('[data-cat]'), function(x){
      x.addEventListener('click', function(){ filtrarCategoria(x.getAttribute('data-cat')); });
    });
  }

  // Ofertas da semana (mercado): faixa escura com separadores por categoria
  RENDER.banda = function(b, el){
    var base = disponiveis(produtos);
    if (base.length < 5) return false;
    var cats = categorias().filter(function(c){ return c.nome !== OUTROS; }).slice(0, 6);
    var quantos = base.length >= 15 ? 10 : 5;
    var cat = '';
    function lista(){
      var l = cat ? base.filter(function(p){ return (p.categoria || OUTROS) === cat; }) : base;
      var promo = l.filter(function(p){ return desconto(p) > 0; }).sort(function(a, c){ return desconto(c) - desconto(a); });
      var resto = ordenar(l).filter(function(p){ return promo.indexOf(p) === -1; });
      return promo.concat(resto).slice(0, quantos);
    }
    el.innerHTML = '<div class="dia-banda"><div class="dia-banda-topo"><h3 class="dia-banda-titulo">' + ICONES.raio + esc(b.titulo || tx('Ofertas da semana')) + '</h3>'
      + (cats.length ? '<div class="dia-banda-tabs"><button class="dia-banda-tab dia-activo" data-tab="">' + tx('Tudo') + '</button>'
        + cats.map(function(c){ return '<button class="dia-banda-tab" data-tab="' + esc(c.nome) + '">' + esc(c.nome) + '</button>'; }).join('') + '</div>' : '')
      + '</div><div class="dia-banda-grelha"></div></div>';
    var grelha = el.querySelector('.dia-banda-grelha');
    function desenhar(){
      grelha.innerHTML = lista().map(cartao).join('');
      ligarCartoes(grelha);
      cada(el.querySelectorAll('.dia-banda-tab'), function(t){ t.classList.toggle('dia-activo', t.getAttribute('data-tab') === cat); });
    }
    cada(el.querySelectorAll('.dia-banda-tab'), function(t){
      t.addEventListener('click', function(){ cat = t.getAttribute('data-tab'); desenhar(); });
    });
    marcarMostrados(lista());
    desenhar();
  };

  // Colecção (editorial): separadores, ordenar e "mostrar mais"
  RENDER.colecao = function(b, el){
    if (!produtos.length) {
      el.innerHTML = '<div class="dia-vazio">' + ICONES.caixa + '<div>' + tx('Ainda não há produtos à venda aqui.') + '</div></div>';
      return;
    }
    var cats = categorias().filter(function(c){ return c.nome !== OUTROS; });
    var est = { cat: '', ordem: 'destaques', limite: 8 };
    var ordens = [['destaques', tx('Em destaque')], ['recentes', tx('Mais recentes')], ['preco_asc', tx('Preço mais baixo')], ['preco_desc', tx('Preço mais alto')]];
    el.innerHTML = '<div class="dia-ed-col"><div class="dia-ed-barra">'
      + (cats.length ? '<div class="dia-ed-tabs"><button class="dia-ed-tab dia-activo" data-tab="">' + tx('Tudo') + '</button>'
        + cats.map(function(c){ return '<button class="dia-ed-tab" data-tab="' + esc(c.nome) + '">' + esc(c.nome) + '</button>'; }).join('') + '</div>' : '<span></span>')
      + '<label class="dia-ed-ordem"><span>' + tx('Ordenar') + '</span><select>' + ordens.map(function(o){ return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>'; }).join('') + '</select></label></div>'
      + '<div class="dia-grelha dia-ed-grelha"></div><div class="dia-ed-mais"></div></div>';
    var grelha = el.querySelector('.dia-ed-grelha'), mais = el.querySelector('.dia-ed-mais');
    function lista(){
      var l = est.cat ? produtos.filter(function(p){ return (p.categoria || OUTROS) === est.cat; }) : produtos.slice();
      if (est.ordem === 'recentes') return l.sort(function(a, c){ return String(c.criado).localeCompare(String(a.criado)); });
      if (est.ordem === 'preco_asc') return l.sort(function(a, c){ return precoMinimo(a) - precoMinimo(c); });
      if (est.ordem === 'preco_desc') return l.sort(function(a, c){ return precoMinimo(c) - precoMinimo(a); });
      return ordenar(l);
    }
    function desenhar(){
      var l = lista();
      grelha.innerHTML = l.slice(0, est.limite).map(cartao).join('');
      ligarCartoes(grelha);
      var mostra = Math.min(est.limite, l.length);
      mais.innerHTML = (l.length > est.limite ? '<button class="dia-ed-mais-btn">' + tx('Mostrar mais') + '</button>' : '')
        + (l.length ? '<small>' + tx('A mostrar {a} de {b}', { a: mostra, b: l.length }) + '</small>' : '');
      var bm = mais.querySelector('.dia-ed-mais-btn');
      if (bm) bm.addEventListener('click', function(){ est.limite += 8; desenhar(); });
      cada(el.querySelectorAll('.dia-ed-tab'), function(t){ t.classList.toggle('dia-activo', t.getAttribute('data-tab') === est.cat); });
    }
    cada(el.querySelectorAll('.dia-ed-tab'), function(t){
      t.addEventListener('click', function(){ est.cat = t.getAttribute('data-tab'); est.limite = 8; desenhar(); });
    });
    el.querySelector('.dia-ed-ordem select').addEventListener('change', function(){ est.ordem = this.value; desenhar(); });
    desenhar();
  };

  // ======================================================
  // Pagamento com cartão DENTRO da loja (1.59.0): o checkout abre aqui,
  // numa janela, e a página confirma sozinha - o cliente nunca sai.
  // ======================================================
  var cartaoEmCurso = null;
  var ORIGEM_CONTAINER = CONTAINER_URL.replace(/\\/+$/, '');
  window.addEventListener('message', function(e){
    if (e.origin !== ORIGEM_CONTAINER || !e.data || e.data.daniel !== 'pagamento' || !cartaoEmCurso) return;
    var t = $('dia-estado-texto');
    if (t) t.textContent = tx('Pagamento recebido. A confirmar...');
    cartaoEmCurso.verificarJa();
  });
  function pagarComCartao(enc, resp){
    var modal = document.querySelector('#dia-janela .dia-modal');
    if (modal) modal.classList.add('dia-modal-cartao');
    var fora = resp.embutivel === false;
    var el = mostrarEstado('<div class="dia-cartao-pag">'
      + '<div class="dia-cartao-topo"><span class="dia-cartao-ic">' + ICONES.cadeado + '</span><div><b>' + tx('Pagamento seguro') + '</b><small>Visa · Mastercard</small></div><strong>' + mzn(enc.valor_total) + '</strong></div>'
      + (fora
        ? '<div class="dia-cartao-fora"><p>' + tx('O banco abre o pagamento numa janela segura. Paga e volta para aqui - esta página confirma sozinha.') + '</p>'
          + '<a class="dia-btn-principal" style="text-decoration:none" href="' + esc(resp.checkout_url) + '" target="_blank" rel="noopener"><span>' + tx('Abrir pagamento seguro') + '</span></a></div>'
        : '<div class="dia-cartao-palco"><div class="dia-cartao-carregar"><div class="dia-spinner"></div></div></div>'
          + '<a class="dia-cartao-link" href="' + esc(resp.checkout_url) + '" target="_blank" rel="noopener">' + tx('Não aparece? Abrir numa janela nova') + '</a>')
      + '<p class="dia-cartao-estado"><i></i><span id="dia-estado-texto">' + tx('À espera da confirmação do pagamento...') + '</span></p></div>');
    if (!fora) {
      var palco = el.querySelector('.dia-cartao-palco');
      var fr = document.createElement('iframe');
      fr.title = tx('Pagamento seguro');
      fr.setAttribute('allow', 'payment');
      fr.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox');
      fr.addEventListener('load', function(){ palco.classList.add('dia-carregado'); });
      fr.src = resp.checkout_url;
      palco.appendChild(fr);
    }
    var tentativas = 0, temporizador = null, parado = false;
    function verificar(){
      if (parado || !$('dia-janela')) { parado = true; cartaoEmCurso = null; return; }
      post('/loja-estado', { encomenda_id: enc.encomenda_id }).then(function(r){
        if (parado) return;
        if (r.status === 'success' && r.response.estado === 'Pago') {
          parado = true; cartaoEmCurso = null;
          if (modal) modal.classList.remove('dia-modal-cartao');
          el.innerHTML = '<div class="dia-estado-pagamento"><div class="dia-ok">' + ICONES.certo + '</div><h3>' + tx('Pagamento confirmado!') + '</h3>'
            + '<div class="dia-ref">' + esc(enc.referencia) + '</div><p>' + tx('Obrigado pela tua compra. A loja já recebeu a tua encomenda.') + '</p>'
            + '<button class="dia-btn-sec" data-fechar-final>' + tx('Continuar a comprar') + '</button></div>';
          el.querySelector('[data-fechar-final]').addEventListener('click', function(){ fecharJanela(); recarregarProdutos(); });
          return;
        }
        seguinte();
      }).catch(seguinte);
    }
    function seguinte(){
      if (parado) return;
      tentativas++;
      if (tentativas === 60) { var t = $('dia-estado-texto'); if (t) t.textContent = tx('Ainda à espera. Se já pagaste, a confirmação pode demorar um pouco.'); }
      if (tentativas < 400) temporizador = setTimeout(verificar, 3000);
    }
    cartaoEmCurso = { verificarJa: function(){ clearTimeout(temporizador); verificar(); } };
    temporizador = setTimeout(verificar, 5000);
  }

  // ======================================================
  // Mais 3 estilos (1.59.0): catálogo com filtros, vitrine e bento
  // ======================================================
  TEMAS.push('catalogo', 'vitrine', 'bento');
  MONTRAS_TEMA.catalogo = { colunas: 3, blocos: [ { id: 'capa', tipo: 'capa' }, { id: 'filt', tipo: 'filtros' }, { id: 'vistos', tipo: 'vistos' } ] };
  MONTRAS_TEMA.vitrine = { colunas: 4, blocos: [ { id: 'capa', tipo: 'capa' }, { id: 'cat', tipo: 'catalogo' }, { id: 'vistos', tipo: 'vistos' } ] };
  MONTRAS_TEMA.bento = { colunas: 4, blocos: [
    { id: 'capa', tipo: 'capa' }, { id: 'cats', tipo: 'categorias' }, { id: 'dest', tipo: 'fila', fonte: 'destaques' }, { id: 'cat', tipo: 'catalogo' }, { id: 'vistos', tipo: 'vistos' }
  ] };

  // Catálogo: banner de promoção, baixo e largo
  CAPAS_TEMA.catalogo = function(el){
    var d = dadosCapa();
    var promo = maiorDesconto();
    var img = d.imagem || (d.produto && imagemDe(d.produto)) || '';
    el.innerHTML = '<div class="dia-ct-capa' + (d.imagem ? ' dia-com-foto' : '') + '">'
      + (d.imagem ? '<img class="dia-ct-foto" src="' + esc(d.imagem) + '" alt="">' : '')
      + '<div class="dia-ct-texto"><span class="dia-ct-eti">' + esc(promo ? tx('Promoção') : tx('Novidades')) + '</span>'
      + '<h2>' + esc(promo ? tx('Até {n}% de desconto', { n: promo }) : d.titulo) + '</h2><p>' + esc(promo ? d.titulo : d.sub) + '</p>'
      + '<button class="dia-ct-btn" data-ir-catalogo>' + esc(d.botao) + ' ' + ICONES.seta + '</button></div>'
      + (!d.imagem ? '<div class="dia-ct-arte">' + arteDe(img, 1) + '</div>' : '')
      + '</div>';
    ligarCapaTema(el);
  };

  // Vitrine: um produto em grande, preço ao lado, miniaturas para trocar e faixa "preços desde"
  var vitrineIdx = 0;
  CAPAS_TEMA.vitrine = function(el){
    var lista = ordenar(disponiveis(produtos)).slice(0, 10);
    var d = dadosCapa();
    if (!lista.length) return CAPAS_TEMA.editorial(el);
    if (vitrineIdx >= lista.length) vitrineIdx = 0;
    var minimo = Math.min.apply(null, disponiveis(produtos).map(precoMinimo));
    var cats = categorias().filter(function(c){ return c.nome !== OUTROS; }).slice(0, 6);
    el.innerHTML = '<div class="dia-vt"><div class="dia-vt-palco"></div>'
      + (lista.length > 1 ? '<div class="dia-vt-fila"><button class="dia-vt-seta dia-esq" data-vt="-1" aria-label="' + tx('Anterior') + '">' + ICONES.seta + '</button>'
        + '<div class="dia-vt-minis">' + lista.map(function(p, i){
          return '<button class="dia-vt-mini" data-i="' + i + '"><span class="dia-vt-mini-img">' + arteDe(imagemDe(p), i) + '</span><span>' + esc(p.nome) + '</span></button>';
        }).join('') + '</div><button class="dia-vt-seta dia-dir" data-vt="1" aria-label="' + tx('Seguinte') + '">' + ICONES.seta + '</button></div>' : '')
      + '<div class="dia-vt-faixa"><div class="dia-vt-desde"><span>' + tx('Preços desde') + '</span><b>' + mzn(minimo) + '</b><small>' + esc(tx(produtos.length === 1 ? '{n} produto' : '{n} produtos', { n: produtos.length })) + '</small></div>'
      + '<div class="dia-vt-cats">' + (cats.length ? cats.map(function(c){ return '<button class="dia-vt-cat" data-cat="' + esc(c.nome) + '">' + esc(c.nome) + '</button>'; }).join('') : '<span>' + esc(d.sub) + '</span>')
      + '<button class="dia-vt-tudo" data-ir-catalogo>' + tx('Ver tudo') + ' ' + ICONES.seta + '</button></div></div></div>';
    function mostrar(){
      var p = lista[vitrineIdx];
      var desc = desconto(p);
      el.querySelector('.dia-vt-palco').innerHTML = '<div class="dia-vt-texto"><span class="dia-vt-eti">' + esc(tx('Destaque')) + '</span><h2>' + esc(p.nome) + '</h2>'
        + (p.descricao ? '<p>' + esc(String(p.descricao).slice(0, 140)) + '</p>' : '<p>' + esc(p.categoria || loja.nome || '') + '</p>')
        + '<button class="dia-vt-ver" data-accao="prod" data-valor="' + esc(p.id) + '">' + tx('Ver produto') + '</button></div>'
        + '<button class="dia-vt-foto" data-accao="prod" data-valor="' + esc(p.id) + '">' + arteDe(imagemDe(p), vitrineIdx) + '</button>'
        + '<div class="dia-vt-preco"><span class="dia-vt-nome">' + esc(p.categoria || tx('Destaque')) + '</span><div class="dia-vt-caixa"><b>' + mzn(precoMinimo(p)) + '</b>'
        + (p.esgotado ? '' : '<button class="dia-vt-add" data-add-vt="' + esc(p.id) + '" aria-label="' + esc(tx('Adicionar {nome} ao carrinho', { nome: p.nome })) + '">' + ICONES.mais + '</button>') + '</div>'
        + (desc > 0 ? '<s>' + mzn(p.preco_antigo) + '</s>' : '') + '</div>';
      cada(el.querySelectorAll('.dia-vt-mini'), function(m){ m.classList.toggle('dia-activo', Number(m.getAttribute('data-i')) === vitrineIdx); });
      var add = el.querySelector('[data-add-vt]');
      if (add) add.addEventListener('click', function(){ adicionar(add.getAttribute('data-add-vt'), null, 1); });
      cada(el.querySelectorAll('.dia-vt-palco [data-accao]'), function(b){ b.addEventListener('click', function(){ abrirProduto(b.getAttribute('data-valor')); }); });
    }
    cada(el.querySelectorAll('.dia-vt-mini'), function(m){ m.addEventListener('click', function(){ vitrineIdx = Number(m.getAttribute('data-i')); mostrar(); }); });
    cada(el.querySelectorAll('[data-vt]'), function(b){ b.addEventListener('click', function(){ vitrineIdx = (vitrineIdx + Number(b.getAttribute('data-vt')) + lista.length) % lista.length; mostrar(); }); });
    cada(el.querySelectorAll('.dia-vt-cat'), function(b){ b.addEventListener('click', function(){ filtrarCategoria(b.getAttribute('data-cat')); }); });
    ligarCapaTema(el.querySelector('.dia-vt-faixa'));
    mostrar();
  };

  // Bento: mosaico de cartões pastel de tamanhos diferentes
  CAPAS_TEMA.bento = function(el){
    var d = dadosCapa();
    var l = ordenar(disponiveis(produtos)).slice(0, 3);
    var telhas = l.map(function(p, i){
      return '<button class="dia-bt-telha dia-bt-t' + (i + 1) + '" data-accao="prod" data-valor="' + esc(p.id) + '"><span class="dia-bt-arte">' + arteDe(imagemDe(p), i + 1) + '</span>'
        + '<span class="dia-bt-info"><b>' + esc(p.nome) + '</b><small>' + mzn(precoMinimo(p)) + '</small></span></button>';
    }).join('');
    el.innerHTML = '<div class="dia-bento' + (l.length < 3 ? ' dia-bt-poucos' : '') + '"><div class="dia-bt-grande">'
      + (d.imagem ? '<img class="dia-bt-foto" src="' + esc(d.imagem) + '" alt="">' : '<span class="dia-bt-bolha"></span><span class="dia-bt-bolha dia-b2"></span>')
      + '<div class="dia-bt-texto"><span class="dia-bt-eti">' + esc(loja.nome || tx('Novidades')) + '</span><h2>' + esc(d.titulo) + '</h2><p>' + esc(d.sub) + '</p>'
      + '<button class="dia-bt-btn" data-ir-catalogo>' + esc(d.botao) + ' ' + ICONES.seta + '</button></div></div>' + telhas + '</div>';
    ligarCapaTema(el);
  };

  // Catálogo com filtros ao lado (categorias, preço, avaliação, promoções, stock)
  // ======================================================
  // Mais 2 estilos (1.60.0): fresco (mercearia, supermercado, orgânicos)
  // e sabor (restaurante, comida e entregas)
  // ======================================================
  TEMAS.push('fresco', 'sabor');
  MONTRAS_TEMA.fresco = { colunas: 5, blocos: [
    { id: 'capa', tipo: 'capa' }, { id: 'cats', tipo: 'categorias' }, { id: 'promo', tipo: 'fila', fonte: 'promocoes', titulo: tx('Melhores ofertas para ti') },
    { id: 'dest', tipo: 'fila', fonte: 'destaques' }, { id: 'cat', tipo: 'catalogo' }, { id: 'vistos', tipo: 'vistos' }
  ] };
  MONTRAS_TEMA.sabor = { colunas: 4, blocos: [
    { id: 'capa', tipo: 'capa' }, { id: 'cats', tipo: 'categorias' }, { id: 'vend', tipo: 'fila', fonte: 'mais_vendidos', titulo: tx('Os mais pedidos') },
    { id: 'cat', tipo: 'catalogo' }, { id: 'vistos', tipo: 'vistos' }
  ] };
  var IC3 = {
    entrega: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
    etiqueta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1.5"/></svg>',
    escudo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
    folha: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 4 13c0-6 7-10 16-10 0 9-4 16-10 16"/><path d="M4 20c4-4 7-7 12-11"/></svg>'
  };
  function tituloEmDestaque(t, ultimaSo){
    var p = String(t || '').trim().split(/\\s+/);
    if (p.length < 2) return esc(t);
    var corte = ultimaSo ? p.length - 1 : Math.ceil(p.length / 2);
    return esc(p.slice(0, corte).join(' ')) + ' <em>' + esc(p.slice(corte).join(' ')) + '</em>';
  }
  function irParaOfertas(){
    var alvo = document.querySelector('.dia-bloco-fila') || document.querySelector('.dia-bloco-catalogo');
    if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Fresco: capa dividida com destaque de cor, selo de desconto e 3 vantagens
  CAPAS_TEMA.fresco = function(el){
    var d = dadosCapa();
    var promo = maiorDesconto();
    var img = d.imagem || (d.produto && imagemDe(d.produto)) || '';
    el.innerHTML = '<div class="dia-fr' + (d.imagem ? ' dia-fr-foto' : '') + '">'
      + '<div class="dia-fr-texto"><span class="dia-fr-eti">' + IC3.folha + esc(loja.nome || tx('Novidades')) + '</span>'
      + '<h2>' + tituloEmDestaque(d.titulo) + '</h2><p>' + esc(d.sub) + '</p>'
      + '<div class="dia-fr-btns"><button class="dia-fr-btn" data-ir-catalogo>' + esc(d.botao) + ' ' + ICONES.seta + '</button>'
      + (promo ? '<button class="dia-fr-btn2" data-ir-ofertas>' + ICONES.estrela + esc(tx('Ver ofertas')) + '</button>' : '') + '</div>'
      + '<div class="dia-fr-vant">'
      + [[IC3.entrega, tx('Entrega rápida')], [IC3.etiqueta, tx('Bons preços')], [IC3.escudo, tx('Qualidade garantida')]].map(function(v){ return '<span><i>' + v[0] + '</i>' + esc(v[1]) + '</span>'; }).join('')
      + '</div></div>'
      + '<div class="dia-fr-arte"><span class="dia-fr-circulo"></span>' + (img ? '<img src="' + esc(img) + '" alt="">' : arteDe('', 2))
      + (promo ? '<span class="dia-fr-selo"><small>' + esc(tx('Até')) + '</small><b>' + promo + '%</b><small>OFF</small></span>' : '') + '</div>'
      + '</div>';
    ligarCapaTema(el);
    var o = el.querySelector('[data-ir-ofertas]');
    if (o) o.addEventListener('click', irParaOfertas);
  };

  // Sabor: capa escura e quente, palavra em letra de destaque, prato em grande com cartão de preço
  CAPAS_TEMA.sabor = function(el){
    var d = dadosCapa();
    var p = d.produto;
    var img = d.imagem || (p && imagemDe(p)) || '';
    var s = (loja.capa || [])[0] || {};
    var avaliados = produtos.filter(function(x){ return x.avaliacao && x.avaliacao.total; });
    var media = avaliados.length ? avaliados.reduce(function(t, x){ return t + x.avaliacao.media; }, 0) / avaliados.length : 0;
    el.innerHTML = '<div class="dia-sb">'
      + '<div class="dia-sb-texto"><span class="dia-sb-eti">' + esc(tx('Fresco')) + ' <i></i> ' + esc(tx('Saboroso')) + ' <i></i> ' + esc(tx('Rápido')) + '</span>'
      + '<h2>' + tituloEmDestaque(d.titulo, true) + '</h2><p>' + esc(d.sub) + '</p>'
      + '<button class="dia-sb-btn" data-ir-catalogo>' + esc(s.botao || tx('Encomendar agora')) + ' ' + ICONES.seta + '</button>'
      + '<div class="dia-sb-garantias">' + [[IC3.folha, tx('Ingredientes frescos')], [IC3.entrega, tx('Entrega rápida')], [IC3.escudo, tx('Pagamento seguro')]].map(function(v){ return '<span>' + v[0] + esc(v[1]) + '</span>'; }).join('') + '</div></div>'
      + '<div class="dia-sb-arte"><span class="dia-sb-anel"></span><span class="dia-sb-prato">' + (img ? '<img src="' + esc(img) + '" alt="">' : arteDe('', 3)) + '</span>'
      + (p ? '<button class="dia-sb-preco" data-accao="prod" data-valor="' + esc(p.id) + '"><small>' + esc(p.nome) + '</small><b>' + mzn(precoMinimo(p)) + '</b></button>' : '')
      + (media ? '<span class="dia-sb-nota">' + ICONES.estrela + media.toLocaleString(DIA_LOCALE, { maximumFractionDigits: 1 }) + '</span>' : '')
      + '</div></div>';
    ligarCapaTema(el);
  };
  RENDER.ver_loja = function(b, el){
    if (!produtos.length) return false;
    el.innerHTML = '<a class="dia-ver-loja" href="loja.html"><span><b>' + esc(tx('Ver todos os produtos')) + '</b><small>' + esc(tx('{n} produtos, com filtros por categoria e preço', { n: produtos.length })) + '</small></span><i>' + ICONES.seta + '</i></a>';
  };
  RENDER.filtros = function(b, el){
    if (!produtos.length) {
      el.innerHTML = '<div class="dia-vazio">' + ICONES.caixa + '<div>' + tx('Ainda não há produtos à venda aqui.') + '</div></div>';
      return;
    }
    var cats = categorias();
    var precos = produtos.map(precoMinimo);
    var pMin = Math.floor(Math.min.apply(null, precos)), pMax = Math.ceil(Math.max.apply(null, precos));
    var catUrl = (NAVEGAR && PAGINA === 'loja') ? paramUrl('cat').toLowerCase() : '';
    var catInicial = '';
    cats.forEach(function(c){ if (catUrl && String(c.nome).toLowerCase() === catUrl) catInicial = c.nome; });
    var est = { cat: catInicial, de: pMin, ate: pMax, estrelas: false, promo: false, stock: false, ordem: 'destaques', lista: false, limite: 12 };
    var temAval = produtos.some(function(p){ return p.avaliacao && p.avaliacao.total; });
    var temPromo = produtos.some(function(p){ return desconto(p) > 0; });
    var ordens = [['destaques', tx('Em destaque')], ['recentes', tx('Mais recentes')], ['preco_asc', tx('Preço mais baixo')], ['preco_desc', tx('Preço mais alto')]];
    el.innerHTML = '<div class="dia-ft">'
      + '<aside class="dia-ft-lado"><div class="dia-ft-lado-topo"><b>' + tx('Filtros') + '</b><button class="dia-ft-fechar" aria-label="' + tx('Fechar') + '">' + ICONES.fechar + '</button></div>'
      + (temCategorias(cats) ? '<div class="dia-ft-grupo"><h4>' + tx('Categorias') + '</h4><div class="dia-ft-cats"><button class="dia-ft-cat dia-activo" data-fcat=""><span>' + tx('Tudo') + '</span><small>' + produtos.length + '</small></button>'
        + cats.map(function(c){ return '<button class="dia-ft-cat" data-fcat="' + esc(c.nome) + '"><span>' + esc(c.nome) + '</span><small>' + c.total + '</small></button>'; }).join('') + '</div></div>' : '')
      + (pMax > pMin ? '<div class="dia-ft-grupo"><h4>' + tx('Preço') + '</h4><div class="dia-ft-duplo"><input type="range" min="' + pMin + '" max="' + pMax + '" value="' + pMin + '" data-fde aria-label="' + tx('Mínimo') + '"><input type="range" min="' + pMin + '" max="' + pMax + '" value="' + pMax + '" data-fate aria-label="' + tx('Máximo') + '"><i class="dia-ft-trilho"></i></div>'
        + '<div class="dia-ft-valores"><span data-fval-de></span><span data-fval-ate></span></div></div>' : '')
      + '<div class="dia-ft-grupo"><h4>' + tx('Mostrar só') + '</h4>'
      + (temAval ? '<label class="dia-ft-ver"><input type="checkbox" data-fest><span>' + estrelas(4) + ' ' + tx('4 estrelas ou mais') + '</span></label>' : '')
      + (temPromo ? '<label class="dia-ft-ver"><input type="checkbox" data-fpromo><span>' + tx('Em promoção') + '</span></label>' : '')
      + '<label class="dia-ft-ver"><input type="checkbox" data-fstock><span>' + tx('Em stock') + '</span></label></div>'
      + '<button class="dia-ft-limpar" data-flimpar>' + tx('Limpar filtros') + '</button>'
      + '<button class="dia-ft-ver-res" data-fver>' + tx('Ver resultados') + '</button></aside>'
      + '<div class="dia-ft-corpo"><div class="dia-ft-barra"><button class="dia-ft-abrir" data-fabrir>' + ICONES.lupa + '<span>' + tx('Filtros') + '</span></button><span class="dia-ft-conta" data-fconta></span>'
      + '<label class="dia-ed-ordem"><span>' + tx('Ordenar') + '</span><select data-fordem>' + ordens.map(function(o){ return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>'; }).join('') + '</select></label>'
      + '<div class="dia-ft-vista"><button class="dia-activo" data-fvista="grelha" aria-label="' + tx('Vista em grelha') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></button>'
      + '<button data-fvista="lista" aria-label="' + tx('Vista em lista') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg></button></div></div>'
      + '<div class="dia-grelha dia-ft-grelha"></div><div class="dia-ed-mais"></div></div></div>';
    var raiz = el.querySelector('.dia-ft'), grelha = el.querySelector('.dia-ft-grelha'), mais = el.querySelector('.dia-ed-mais');
    var portal = null;
    function q(s){ return el.querySelector(s) || (portal && portal.querySelector(s)); }
    function qa(s){ return Array.prototype.slice.call(el.querySelectorAll(s)).concat(portal ? Array.prototype.slice.call(portal.querySelectorAll(s)) : []); }
    function lista(){
      var l = produtos.filter(function(p){
        if (est.cat && (p.categoria || OUTROS) !== est.cat) return false;
        var pr = precoMinimo(p);
        if (pr < est.de || pr > est.ate) return false;
        if (est.estrelas && !(p.avaliacao && p.avaliacao.media >= 4)) return false;
        if (est.promo && !(desconto(p) > 0)) return false;
        if (est.stock && p.esgotado) return false;
        return true;
      });
      if (est.ordem === 'recentes') return l.sort(function(a, c){ return String(c.criado).localeCompare(String(a.criado)); });
      if (est.ordem === 'preco_asc') return l.sort(function(a, c){ return precoMinimo(a) - precoMinimo(c); });
      if (est.ordem === 'preco_desc') return l.sort(function(a, c){ return precoMinimo(c) - precoMinimo(a); });
      return ordenar(l);
    }
    function desenhar(){
      var l = lista();
      grelha.classList.toggle('dia-ft-em-lista', est.lista);
      grelha.innerHTML = l.length ? l.slice(0, est.limite).map(cartao).join('') : '<div class="dia-vazio" style="grid-column:1/-1">' + ICONES.lupa + '<div>' + tx('Nenhum produto encontrado.') + '</div></div>';
      ligarCartoes(grelha);
      q('[data-fconta]').textContent = tx(l.length === 1 ? '{n} produto' : '{n} produtos', { n: l.length });
      mais.innerHTML = l.length > est.limite ? '<button class="dia-ed-mais-btn">' + tx('Mostrar mais') + '</button><small>' + tx('A mostrar {a} de {b}', { a: est.limite, b: l.length }) + '</small>' : '';
      var bm = mais.querySelector('button');
      if (bm) bm.addEventListener('click', function(){ est.limite += 12; desenhar(); });
      qa('[data-fcat]').forEach(function(x){ x.classList.toggle('dia-activo', x.getAttribute('data-fcat') === est.cat); });
      var de = q('[data-fval-de]'), ate = q('[data-fval-ate]');
      if (de) { de.textContent = mzn(est.de); ate.textContent = mzn(est.ate); }
      var tr = q('.dia-ft-trilho');
      if (tr && pMax > pMin) { tr.style.left = ((est.de - pMin) / (pMax - pMin) * 100) + '%'; tr.style.right = (100 - (est.ate - pMin) / (pMax - pMin) * 100) + '%'; }
      var n = (est.cat ? 1 : 0) + (est.de > pMin || est.ate < pMax ? 1 : 0) + (est.estrelas ? 1 : 0) + (est.promo ? 1 : 0) + (est.stock ? 1 : 0);
      q('[data-fabrir] span').textContent = n ? tx('Filtros') + ' (' + n + ')' : tx('Filtros');
    }
    cada(el.querySelectorAll('[data-fcat]'), function(x){ x.addEventListener('click', function(){ est.cat = x.getAttribute('data-fcat'); est.limite = 12; desenhar(); }); });
    var rDe = q('[data-fde]'), rAte = q('[data-fate]');
    if (rDe) {
      rDe.addEventListener('input', function(){ est.de = Math.min(Number(rDe.value), est.ate); rDe.value = est.de; desenhar(); });
      rAte.addEventListener('input', function(){ est.ate = Math.max(Number(rAte.value), est.de); rAte.value = est.ate; desenhar(); });
    }
    [['[data-fest]', 'estrelas'], ['[data-fpromo]', 'promo'], ['[data-fstock]', 'stock']].forEach(function(x){
      var c = q(x[0]); if (c) c.addEventListener('change', function(){ est[x[1]] = c.checked; desenhar(); });
    });
    q('[data-fordem]').addEventListener('change', function(){ est.ordem = this.value; desenhar(); });
    cada(el.querySelectorAll('[data-fvista]'), function(v){
      v.addEventListener('click', function(){
        est.lista = v.getAttribute('data-fvista') === 'lista';
        cada(el.querySelectorAll('[data-fvista]'), function(x){ x.classList.toggle('dia-activo', x === v); });
        desenhar();
      });
    });
    q('[data-flimpar]').addEventListener('click', function(){
      est.cat = ''; est.de = pMin; est.ate = pMax; est.estrelas = est.promo = est.stock = false;
      if (rDe) { rDe.value = pMin; rAte.value = pMax; }
      qa('.dia-ft-ver input').forEach(function(c){ c.checked = false; });
      desenhar();
    });
    // No telemóvel os filtros abrem por baixo, numa janela posta no <body>
    // (assim nenhuma animação do site os prende dentro da página).
    function abrirLado(sim){
      var lado = q('.dia-ft-lado');
      if (sim && !portal) {
        var tema = (($('dia-loja') || {}).className || '').match(/dia-tema-[a-z]+/);
        portal = document.createElement('div');
        portal.className = 'dia-loja dia-ft-portal ' + (tema ? tema[0] : '');
        portal.innerHTML = '<div class="dia-ft-fundo"></div>';
        portal.appendChild(lado);
        document.body.appendChild(portal);
        portal.querySelector('.dia-ft-fundo').addEventListener('click', function(){ abrirLado(false); });
        setTimeout(function(){ if (portal) portal.classList.add('dia-ft-aberto'); }, 20);
        document.body.style.overflow = 'hidden';
      } else if (!sim && portal) {
        raiz.insertBefore(lado, raiz.firstChild);
        portal.remove(); portal = null;
        document.body.style.overflow = '';
      }
    }
    q('[data-fabrir]').addEventListener('click', function(){ abrirLado(true); });
    q('.dia-ft-fechar').addEventListener('click', function(){ abrirLado(false); });
    q('[data-fver]').addEventListener('click', function(){ abrirLado(false); });
    desenhar();
  };

  function irPara(destino){
    if (!destino || !destino.valor) return;
    if (destino.tipo === 'categoria') filtrarCategoria(destino.valor);
    else if (destino.tipo === 'produto') abrirProduto(destino.valor);
    else if (destino.tipo === 'url' && /^https?:\\/\\//.test(destino.valor)) window.open(destino.valor, '_blank', 'noopener');
  }

  function renderMontra(){
    temporizadores.forEach(clearInterval);
    temporizadores = [];
    mostrados = {};
    marcarSelo();
    if (NAVEGAR && PAGINA === 'produto') { renderPaginaProduto(); return; }
    var m = montra();
    var raiz = $('dia-loja');
    if (!raiz) return;
    temaActual = m.tema || '';
    montraEhPadrao = !!m.padrao;
    var estilo = m.estilo || {};
    raiz.className = 'dia-loja dia-cartao-' + (estilo.cartao || 'suave') + ' dia-cols-' + (estilo.colunas || 4) + (temaActual ? ' dia-tema-' + temaActual : '') + (filtrando() ? ' dia-filtrando' : '') + (NAVEGAR ? ' dia-loja-pagina-' + PAGINA : '');
    var el = $('dia-montra');
    el.innerHTML = '';
    if (PREVIA && produtos.length && produtos[0].demo) {
      var aviso = document.createElement('div');
      aviso.className = 'dia-previa';
      aviso.textContent = tx('Pré-visualização com produtos de exemplo - os teus aparecem aqui.');
      el.appendChild(aviso);
    }
    var barraPosta = false;
    m.blocos.forEach(function(b){
      if (!b || b.activo === false || !RENDER[b.tipo]) return;
      var div = document.createElement('section');
      div.className = 'dia-bloco dia-bloco-' + b.tipo;
      el.appendChild(div);
      var r = RENDER[b.tipo](b, div);
      if (r === false) { div.remove(); return; }
      // A pesquisa fica logo a seguir à capa (ou ao início, se não houver capa).
      if (b.tipo === 'capa' && !barraPosta) { el.appendChild(barra()); barraPosta = true; }
    });
    if (!barraPosta) el.insertBefore(barra(), el.firstChild && el.firstChild.classList.contains('dia-bloco-anuncio') ? el.firstChild.nextSibling : el.firstChild);
    if (filtrando()) renderResultados();
  }

  // ---- Pesquisa e filtros ----
  function filtrando(){ return !!(filtro.texto.trim() || filtro.categoria); }
  var barraEl = null;
  function barra(){
    if (!barraEl) {
      barraEl = document.createElement('div');
      barraEl.className = 'dia-barra';
      barraEl.innerHTML = '<label class="dia-pesquisa">' + ICONES.lupa
        + '<input type="search" id="dia-pesquisa" placeholder="' + esc(tx('Pesquisar produtos')) + '" autocomplete="off">'
        + '<button type="button" class="dia-limpar" id="dia-limpar">' + tx('Limpar') + '</button></label>'
        + '<div class="dia-categorias" id="dia-categorias"></div>';
      barraEl.querySelector('#dia-pesquisa').addEventListener('input', function(){
        filtro.texto = this.value;
        aplicarFiltro();
      });
      barraEl.querySelector('#dia-limpar').addEventListener('click', function(e){
        e.preventDefault();
        filtro.texto = ''; filtro.categoria = '';
        barraEl.querySelector('#dia-pesquisa').value = '';
        aplicarFiltro();
      });
    }
    renderChips();
    return barraEl;
  }
  function renderChips(){
    var el = barraEl && barraEl.querySelector('#dia-categorias');
    if (!el) return;
    var cats = categorias();
    if (!temCategorias(cats)) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML = '<button class="dia-chip' + (!filtro.categoria ? ' dia-activo' : '') + '" data-cat="">' + tx('Tudo') + ' <small>' + produtos.length + '</small></button>'
      + cats.map(function(c){
        return '<button class="dia-chip' + (filtro.categoria === c.nome ? ' dia-activo' : '') + '" data-cat="' + esc(c.nome) + '">' + esc(c.nome) + ' <small>' + c.total + '</small></button>';
      }).join('');
    cada(el.querySelectorAll('.dia-chip'), function(b){
      b.addEventListener('click', function(){ filtrarCategoria(b.getAttribute('data-cat')); });
    });
  }
  function filtrarCategoria(c){
    if (NAVEGAR && PAGINA !== 'loja' && c) { irParaPagina('loja.html', { cat: c }); return; }
    filtro.categoria = c || '';
    aplicarFiltro();
    var raiz = $('dia-loja');
    if (raiz && raiz.getBoundingClientRect().top < 0) raiz.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function aplicarFiltro(){
    var raiz = $('dia-loja');
    if (!raiz) return;
    raiz.classList.toggle('dia-filtrando', filtrando());
    renderChips();
    if (filtrando()) {
      // A barra passa para cima dos resultados enquanto se filtra.
      var res = $('dia-resultados');
      if (barraEl.parentNode !== res) res.insertBefore(barraEl, res.firstChild);
      renderResultados();
    } else {
      renderMontra();
    }
  }
  function renderResultados(){
    var res = $('dia-resultados');
    var corpo = res.querySelector('.dia-corpo-res');
    if (!corpo) { corpo = document.createElement('div'); corpo.className = 'dia-corpo-res'; res.appendChild(corpo); }
    if (barraEl.parentNode !== res) res.insertBefore(barraEl, res.firstChild);
    var texto = normalizar(filtro.texto.trim());
    var lista = produtos.filter(function(p){
      if (filtro.categoria && (p.categoria || OUTROS) !== filtro.categoria) return false;
      if (texto && normalizar(p.nome + ' ' + (p.categoria || '') + ' ' + (p.descricao || '') + ' ' + (p.variantes || []).map(function(v){ return v.nome; }).join(' ')).indexOf(texto) === -1) return false;
      return true;
    });
    if (!lista.length) {
      corpo.innerHTML = '<div class="dia-vazio">' + ICONES.lupa + '<div>' + (filtro.texto ? esc(tx('Nenhum produto encontrado para "{t}".', { t: filtro.texto.trim() })) : tx('Nenhum produto encontrado.')) + '</div></div>';
      return;
    }
    var titulo = filtro.categoria || tx('Resultados');
    corpo.innerHTML = '<div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + esc(titulo) + '</h3>'
      + '<span class="dia-ver-todos" style="cursor:default">' + tx(lista.length === 1 ? '{n} produto' : '{n} produtos', { n: lista.length }) + '</span></div>'
      + '<div class="dia-grelha">' + ordenar(lista).map(cartao).join('') + '</div>';
    ligarCartoes(corpo);
  }

  // ---- Capa (carrossel) ----
  var slideActual = 0, temporizadorCapa = null;
  function renderCapa(capa){
    capa.innerHTML = '';
    var slides = loja.capa || [];
    var c = document.createElement('div');
    c.className = 'dia-capa';
    capa.appendChild(c);
    if (!slides.length) {
      // Sites antigos podem ter a loja a meio da página, depois do hero do
      // próprio site - aí uma capa gerada ficaria repetida.
      if (capa.getBoundingClientRect().top + window.pageYOffset > window.innerHeight * 1.1) return false;
      c.innerHTML = '<div class="dia-capa-gerada"></div>'
        + '<div class="dia-slide-texto"><h2 class="dia-slide-titulo">' + esc(loja.nome || tx('A nossa loja')) + '</h2>'
        + '<p class="dia-slide-sub">' + (produtos.length ? esc(tx('{n} produtos à tua espera. Escolhe, encomenda e recebe.', { n: produtos.length })) : tx('Descobre os nossos produtos.')) + '</p>'
        + '<button class="dia-slide-btn" data-ir-catalogo>' + tx('Ver produtos') + ' ' + ICONES.seta + '</button></div>';
    } else {
      var html = slides.map(function(s, i){
        var temTexto = s.titulo || s.subtitulo || s.botao;
        return '<div class="dia-slide' + (i === 0 ? ' dia-activo' : '') + '">'
          + '<img src="' + esc(s.imagem) + '" alt="' + esc(s.titulo || loja.nome) + '"' + (i === 0 ? '' : ' loading="lazy"') + '>'
          + (temTexto ? '<div class="dia-slide-texto">'
            + (s.titulo ? '<h2 class="dia-slide-titulo">' + esc(s.titulo) + '</h2>' : '')
            + (s.subtitulo ? '<p class="dia-slide-sub">' + esc(s.subtitulo) + '</p>' : '')
            + (s.botao ? '<button class="dia-slide-btn" data-ir-catalogo>' + esc(s.botao) + ' ' + ICONES.seta + '</button>' : '')
            + '</div>' : '')
          + '</div>';
      }).join('');
      if (slides.length > 1) {
        html += '<button class="dia-capa-seta dia-esq" aria-label="' + tx('Anterior') + '">' + ICONES.seta + '</button>'
          + '<button class="dia-capa-seta dia-dir" aria-label="' + tx('Seguinte') + '">' + ICONES.seta + '</button>'
          + '<div class="dia-capa-pontos">' + slides.map(function(s, i){
            return '<button class="dia-ponto' + (i === 0 ? ' dia-activo' : '') + '" data-i="' + i + '" aria-label="' + tx('Imagem {n}', { n: i + 1 }) + '"></button>';
          }).join('') + '</div>';
      }
      c.innerHTML = html;
      if (slides.length > 1) ligarCarrossel(c, slides.length);
    }
    cada(c.querySelectorAll('[data-ir-catalogo]'), function(b){
      b.addEventListener('click', function(){
        var alvo = document.querySelector('.dia-bloco-fila, .dia-bloco-catalogo') || $('dia-montra');
        alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }
  function ligarCarrossel(capa, total){
    slideActual = 0;
    function irPara(i){
      slideActual = (i + total) % total;
      cada(capa.querySelectorAll('.dia-slide'), function(el, j){ el.classList.toggle('dia-activo', j === slideActual); });
      cada(capa.querySelectorAll('.dia-ponto'), function(el, j){ el.classList.toggle('dia-activo', j === slideActual); });
    }
    function reiniciar(){
      clearInterval(temporizadorCapa);
      temporizadorCapa = setInterval(function(){ irPara(slideActual + 1); }, 5500);
    }
    capa.querySelector('.dia-capa-seta.dia-esq').addEventListener('click', function(){ irPara(slideActual - 1); reiniciar(); });
    capa.querySelector('.dia-capa-seta.dia-dir').addEventListener('click', function(){ irPara(slideActual + 1); reiniciar(); });
    cada(capa.querySelectorAll('.dia-ponto'), function(el){
      el.addEventListener('click', function(){ irPara(Number(el.getAttribute('data-i'))); reiniciar(); });
    });
    var inicioX = null;
    capa.addEventListener('touchstart', function(e){ inicioX = e.touches[0].clientX; }, { passive: true });
    capa.addEventListener('touchend', function(e){
      if (inicioX === null) return;
      var dx = e.changedTouches[0].clientX - inicioX;
      if (Math.abs(dx) > 40) { irPara(slideActual + (dx < 0 ? 1 : -1)); reiniciar(); }
      inicioX = null;
    });
    reiniciar();
  }

  // ======================================================
  // Janelas (produto e checkout)
  // ======================================================
  function abrirJanela(html, classeExtra){
    if (EM_PAGINA_PRODUTO) {
      var aqui = $('dia-montra');
      aqui.innerHTML = '<div class="dia-pagina-produto ' + (classeExtra || '') + '">' + html + '</div>';
      return aqui.firstChild;
    }
    fecharJanela();
    var overlay = document.createElement('div');
    overlay.className = 'dia-overlay';
    overlay.id = 'dia-janela';
    overlay.innerHTML = '<div class="dia-modal ' + (classeExtra || '') + '" role="dialog" aria-modal="true">'
      + '<button class="dia-icone-btn dia-fechar" aria-label="' + tx('Fechar') + '">' + ICONES.fechar + '</button>' + html + '</div>';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    overlay.addEventListener('click', function(e){ if (e.target === overlay) fecharJanela(); });
    overlay.querySelector('.dia-fechar').addEventListener('click', fecharJanela);
    return overlay;
  }
  function fecharJanela(){
    var j = $('dia-janela');
    if (j) j.remove();
    document.body.style.overflow = '';
  }

  // ---- Página do produto ----
  function abrirProduto(id){
    if (NAVEGAR && !EM_PAGINA_PRODUTO) { irParaPagina('produto.html', { id: id }); return; }
    return abrirProdutoJanela(id);
  }
  function renderPaginaProduto(){
    var raiz = $('dia-loja');
    if (!raiz) return;
    var tema = temaLoja();
    raiz.className = 'dia-loja dia-loja-pagina-produto' + (tema ? ' dia-tema-' + tema : '');
    var el = $('dia-montra');
    var id = paramUrl('id');
    var p = id ? produtoPorId(id) : null;
    if (!p) {
      el.innerHTML = '<div class="dia-vazio">' + ICONES.caixa + '<div>' + esc(tx('Este produto já não está disponível.')) + '</div><a class="dia-btn-principal dia-btn-auto" href="loja.html">' + esc(tx('Ver todos os produtos')) + '</a></div>';
      return;
    }
    EM_PAGINA_PRODUTO = true;
    try { abrirProdutoJanela(id); } finally { EM_PAGINA_PRODUTO = false; }
    var mig = document.createElement('nav');
    mig.className = 'dia-migalhas';
    mig.setAttribute('aria-label', 'breadcrumb');
    mig.innerHTML = '<a href="index.html">' + esc(tx('Início')) + '</a><span>/</span><a href="loja.html">' + esc(tx('Loja')) + '</a>'
      + (p.categoria ? '<span>/</span><a href="loja.html?cat=' + encodeURIComponent(p.categoria) + '">' + esc(p.categoria) + '</a>' : '');
    el.insertBefore(mig, el.firstChild);
    try { document.title = p.nome + (loja.nome ? ' · ' + loja.nome : ''); } catch (e) {}
  }
  function abrirProdutoJanela(id){
    var p = produtoPorId(id);
    if (!p) return;
    marcarVisto(id);
    var temOpcoes = p.variantes && p.variantes.length;
    var vi = null;
    if (temOpcoes) {
      var disponiveis = p.variantes.map(function(v, i){ return (v.stock === null || v.stock > 0) ? i : -1; }).filter(function(i){ return i >= 0; });
      if (p.variantes.length === 1 && disponiveis.length) vi = 0;
    }
    var qtd = 1;
    var imagens = (p.imagens && p.imagens.length) ? p.imagens : (p.imagem ? [p.imagem] : []);

    var galeria = '<div class="dia-galeria">'
      + (imagens.length ? '<div class="dia-gal-trilho" id="dia-gal">' + imagens.map(function(src){
        return '<div class="dia-gal-foto">' + fundoDe(src) + '<img src="' + esc(src) + '" alt="' + esc(p.nome) + '"></div>';
      }).join('') + '</div>' : '<div class="dia-gal-trilho"><div class="dia-gal-foto"><div class="dia-produto-vazio">' + ICONES.caixa + '</div></div></div>')
      + (imagens.length > 1 ? '<button class="dia-gal-seta dia-esq" data-gal="-1" aria-label="' + tx('Anterior') + '">' + ICONES.seta + '</button><button class="dia-gal-seta dia-dir" data-gal="1" aria-label="' + tx('Seguinte') + '">' + ICONES.seta + '</button>'
        + '<div class="dia-gal-miniaturas">' + imagens.map(function(src, i){
          return '<button data-mini="' + i + '"' + (i === 0 ? ' class="dia-activo"' : '') + ' aria-label="' + tx('Imagem {n}', { n: i + 1 }) + '"><img src="' + esc(src) + '" alt=""></button>';
        }).join('') + '</div>' : '')
      + '</div>';

    var aval = p.avaliacao && p.avaliacao.total
      ? '<button class="dia-detalhe-aval" data-ir-aval>' + estrelas(p.avaliacao.media) + '<span>' + p.avaliacao.media.toLocaleString(DIA_LOCALE) + ' · ' + tx(p.avaliacao.total === 1 ? '{n} avaliação' : '{n} avaliações', { n: p.avaliacao.total }) + '</span></button>' : '';

    var opcoes = temOpcoes ? '<div class="dia-opcoes-titulo">' + tx('Opção') + '</div><div class="dia-opcoes">' + p.variantes.map(function(v, i){
      var esgotada = v.stock !== null && v.stock <= 0;
      return '<button class="dia-opcao" data-opcao="' + i + '"' + (esgotada ? ' disabled title="' + esc(tx('Esgotado')) + '"' : '') + '>' + esc(v.nome) + '</button>';
    }).join('') + '</div>' : '';

    var j = abrirJanela('<div class="dia-detalhe-topo">' + galeria
      + '<div class="dia-detalhe-info">'
      + (p.categoria ? '<div class="dia-produto-cat">' + esc(p.categoria) + '</div>' : '')
      + '<h3 class="dia-detalhe-nome">' + esc(p.nome) + '</h3>'
      + aval
      + '<div class="dia-detalhe-precos" id="dia-det-precos"></div>'
      + opcoes
      + '<div class="dia-stock" id="dia-det-stock"></div>'
      + '<div class="dia-detalhe-qtd">' + tx('Quantidade') + ' <div class="dia-qtd"><button data-q="-1" aria-label="' + tx('Menos') + '">−</button><span id="dia-det-qtd">1</span><button data-q="1" aria-label="' + tx('Mais') + '">+</button></div></div>'
      + '<div class="dia-msg-opcao" id="dia-det-msg"></div>'
      + '<button class="dia-btn-principal" id="dia-det-add">' + ICONES.carrinho + ' ' + tx('Adicionar ao carrinho') + '</button>'
      + '<button class="dia-btn-sec" id="dia-det-comprar">' + tx('Comprar agora') + '</button>'
      + (p.descricao ? '<p class="dia-detalhe-desc">' + esc(p.descricao) + '</p>' : '')
      + '</div></div>'
      + '<div class="dia-detalhe-baixo"><section class="dia-bloco" id="dia-det-aval"></section><section class="dia-bloco" id="dia-det-rel"></section></div>', 'dia-detalhe');

    function actualizar(){
      var preco = precoDe(p, vi);
      var d = desconto(p);
      var antigo = (vi === null || p.variantes[vi].preco === p.preco) && d > 0;
      $('dia-det-precos').innerHTML = (temOpcoes && vi === null && temPrecosDiferentes(p)
          ? '<span class="dia-detalhe-preco"><small style="font-size:14px;font-weight:700;margin-right:6px">' + tx('desde') + '</small>' + mzn(precoMinimo(p)) + '</span>'
          : '<span class="dia-detalhe-preco">' + mzn(preco) + '</span>')
        + (antigo ? '<s class="dia-produto-antigo">' + mzn(p.preco_antigo) + '</s><span class="dia-detalhe-poupa">' + tx('Poupas {v}', { v: mzn(p.preco_antigo - p.preco) }) + '</span>' : '');
      var st = stockDe(p, vi);
      var el = $('dia-det-stock');
      if (temOpcoes && vi === null) { el.className = 'dia-stock'; el.style.display = 'none'; }
      else if (st === 0) { el.style.display = ''; el.className = 'dia-stock dia-nada'; el.textContent = tx('Esgotado'); }
      else if (st !== null && st <= 5) { el.style.display = ''; el.className = 'dia-stock dia-pouco'; el.textContent = tx(st === 1 ? 'Só resta 1 unidade' : 'Só restam {n} unidades', { n: st }); }
      else { el.style.display = ''; el.className = 'dia-stock'; el.textContent = tx('Em stock'); }
      var semStock = (vi !== null || !temOpcoes) && st === 0;
      $('dia-det-add').disabled = semStock;
      $('dia-det-comprar').disabled = semStock;
      if (st !== null && qtd > st) { qtd = Math.max(1, st); $('dia-det-qtd').textContent = qtd; }
      cada(j.querySelectorAll('[data-opcao]'), function(b){ b.classList.toggle('dia-activo', Number(b.getAttribute('data-opcao')) === vi); });
    }
    actualizar();

    cada(j.querySelectorAll('[data-opcao]'), function(b){
      b.addEventListener('click', function(){ vi = Number(b.getAttribute('data-opcao')); $('dia-det-msg').textContent = ''; actualizar(); });
    });
    cada(j.querySelectorAll('[data-q]'), function(b){
      b.addEventListener('click', function(){
        var st = stockDe(p, vi);
        var max = st === null ? 99 : Math.max(1, st);
        qtd = Math.max(1, Math.min(max, qtd + Number(b.getAttribute('data-q'))));
        $('dia-det-qtd').textContent = qtd;
      });
    });
    function confirmarOpcao(){
      if (temOpcoes && vi === null) { $('dia-det-msg').textContent = tx('Escolhe uma opção.'); return false; }
      return true;
    }
    $('dia-det-add').addEventListener('click', function(){ if (confirmarOpcao() && adicionar(p.id, vi, qtd)) fecharJanela(); });
    $('dia-det-comprar').addEventListener('click', function(){ if (confirmarOpcao() && adicionar(p.id, vi, qtd)) { fecharJanela(); abrirCheckout(); } });
    var irAval = j.querySelector('[data-ir-aval]');
    if (irAval) irAval.addEventListener('click', function(){ $('dia-det-aval').scrollIntoView({ behavior: 'smooth', block: 'start' }); });

    ligarGaleria(j);
    renderAvaliacoes(p);
    var rel = produtos.filter(function(x){ return x.id !== p.id && p.categoria && x.categoria === p.categoria; });
    if (rel.length < 4) rel = rel.concat(produtos.filter(function(x){ return x.id !== p.id && rel.indexOf(x) === -1; }));
    rel = rel.slice(0, 10);
    var relEl = $('dia-det-rel');
    if (rel.length) {
      relEl.innerHTML = seccaoComFila(tx('Também vais gostar'), '', rel, '');
      ligarSetas(relEl);
      cada(relEl.querySelectorAll('.dia-produto-card'), function(card){
        card.addEventListener('click', function(e){
          var add = e.target.closest ? e.target.closest('[data-add]') : null;
          if (add) { e.stopPropagation(); adicionar(add.getAttribute('data-add'), null, 1); return; }
          abrirProduto(card.getAttribute('data-id'));
        });
      });
    } else relEl.remove();
  }

  function ligarGaleria(j){
    var trilho = j.querySelector('#dia-gal');
    if (!trilho) return;
    var total = trilho.children.length;
    function actual(){ return Math.round(trilho.scrollLeft / Math.max(1, trilho.clientWidth)); }
    function ir(i){ i = (i + total) % total; trilho.scrollTo({ left: i * trilho.clientWidth, behavior: 'smooth' }); }
    cada(j.querySelectorAll('[data-gal]'), function(b){ b.addEventListener('click', function(){ ir(actual() + Number(b.getAttribute('data-gal'))); }); });
    cada(j.querySelectorAll('[data-mini]'), function(b){ b.addEventListener('click', function(){ ir(Number(b.getAttribute('data-mini'))); }); });
    trilho.addEventListener('scroll', function(){
      var a = actual();
      cada(j.querySelectorAll('[data-mini]'), function(b){ b.classList.toggle('dia-activo', Number(b.getAttribute('data-mini')) === a); });
    }, { passive: true });
    // Zoom ao passar o rato (computador); no telemóvel desliza.
    cada(trilho.querySelectorAll('.dia-gal-foto'), function(f){
      var img = f.querySelector('img');
      if (!img) return;
      f.addEventListener('mousemove', function(e){
        var r = f.getBoundingClientRect();
        img.style.transformOrigin = ((e.clientX - r.left) / r.width * 100) + '% ' + ((e.clientY - r.top) / r.height * 100) + '%';
      });
      f.addEventListener('mouseenter', function(){ if (window.matchMedia('(hover:hover)').matches) f.classList.add('dia-zoom'); });
      f.addEventListener('mouseleave', function(){ f.classList.remove('dia-zoom'); });
    });
  }

  // ---- Avaliações ----
  function renderAvaliacoes(p){
    var el = $('dia-det-aval');
    if (!el) return;
    var resumo = p.avaliacao || { media: 0, total: 0 };
    var nota = 0;
    el.innerHTML = '<div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + tx('Avaliações') + '</h3>'
      + '<button class="dia-ver-todos" id="dia-aval-escrever">' + tx('Escrever avaliação') + ' ' + ICONES.seta + '</button></div>'
      + (resumo.total ? '<div class="dia-aval-resumo"><span class="dia-aval-media">' + resumo.media.toLocaleString(DIA_LOCALE) + '</span><div>' + estrelas(resumo.media)
        + '<small>' + tx(resumo.total === 1 ? '{n} avaliação' : '{n} avaliações', { n: resumo.total }) + '</small></div></div>' : '')
      + '<div class="dia-aval-lista" id="dia-aval-lista">' + (resumo.total ? '<div class="dia-spinner"></div>' : '<p class="dia-modal-sub" style="margin:0">' + tx('Ainda sem avaliações. Sê o primeiro a avaliar!') + '</p>') + '</div>'
      + '<div id="dia-aval-form-caixa"></div>';
    $('dia-aval-escrever').addEventListener('click', function(){
      var caixa = $('dia-aval-form-caixa');
      if (caixa.innerHTML) { caixa.innerHTML = ''; return; }
      caixa.innerHTML = '<div class="dia-aval-form">'
        + '<div class="dia-escolher-estrelas" role="radiogroup" aria-label="' + esc(tx('A tua nota')) + '">' + [1, 2, 3, 4, 5].map(function(n){
          return '<button type="button" data-nota="' + n + '" aria-label="' + esc(tx('{n} de 5 estrelas', { n: n })) + '">' + ICONES.estrela + '</button>';
        }).join('') + '</div>'
        + '<div class="dia-campo"><label for="dia-aval-nome">' + tx('O teu nome') + '</label><input type="text" id="dia-aval-nome" maxlength="60" autocomplete="name"></div>'
        + '<div class="dia-campo"><label for="dia-aval-texto">' + tx('Comentário (opcional)') + '</label><textarea id="dia-aval-texto" rows="3" maxlength="600"></textarea></div>'
        + '<button class="dia-btn-principal" id="dia-aval-enviar">' + tx('Enviar avaliação') + '</button>'
        + '<div class="dia-msg-erro" id="dia-aval-erro"></div></div>';
      cada(caixa.querySelectorAll('[data-nota]'), function(b){
        b.addEventListener('click', function(){
          nota = Number(b.getAttribute('data-nota'));
          cada(caixa.querySelectorAll('[data-nota]'), function(x){ x.classList.toggle('dia-activo', Number(x.getAttribute('data-nota')) <= nota); });
        });
      });
      $('dia-aval-enviar').addEventListener('click', function(){
        var btn = this;
        var nome = $('dia-aval-nome').value.trim();
        if (!nota) { $('dia-aval-erro').textContent = tx('Escolhe de 1 a 5 estrelas.'); return; }
        if (nome.length < 2) { $('dia-aval-erro').textContent = tx('Escreve o teu nome.'); return; }
        btn.disabled = true;
        post('/loja-avaliar', { site_id: SITE_ID, produto_id: p.id, nome: nome, estrelas: nota, comentario: $('dia-aval-texto').value.trim() }).then(function(r){
          if (r.status !== 'success') throw new Error((DIA_LANG === 'pt' && r.message) || tx('Não foi possível enviar a avaliação.'));
          caixa.innerHTML = '<div class="dia-msg-ok">' + tx('Obrigado! A tua avaliação aparece depois de a loja a aprovar.') + '</div>';
        }).catch(function(erro){
          btn.disabled = false;
          $('dia-aval-erro').textContent = erro.message || tx('Algo correu mal. Tenta novamente.');
        });
      });
    });
    if (!resumo.total) return;
    post('/loja-avaliacoes', { site_id: SITE_ID, produto_id: p.id }).then(function(r){
      var lista = (r.status === 'success' && r.response.avaliacoes) || [];
      var caixa = $('dia-aval-lista');
      if (!caixa) return;
      caixa.innerHTML = lista.map(function(a){
        var data = '';
        try { data = a.data ? new Date(a.data).toLocaleDateString(DIA_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; } catch (e) {}
        return '<div class="dia-aval"><div class="dia-aval-cabeca"><strong>' + esc(a.nome) + '</strong><small>' + esc(data) + '</small></div>'
          + estrelas(a.estrelas) + (a.comentario ? '<p>' + esc(a.comentario) + '</p>' : '') + '</div>';
      }).join('');
    }).catch(function(){ var c = $('dia-aval-lista'); if (c) c.innerHTML = ''; });
  }

  // ======================================================
  // Carrinho (painel)
  // ======================================================
  function renderCarrinho(){
    var itens = itensDoCarrinho();
    var contagem = itens.reduce(function(t, i){ return t + i.quantidade; }, 0);
    var elC = $('dia-carrinho-contagem');
    if (elC) elC.textContent = contagem;
    cada(document.querySelectorAll('[data-dia-carrinho-contagem]'), function(x){ x.textContent = contagem; x.setAttribute('data-vazio', contagem ? '0' : '1'); });
    var cont = $('dia-itens-carrinho');
    if (!cont) return;
    var total = 0;
    if (!itens.length) {
      cont.innerHTML = '<div class="dia-carrinho-vazio">' + ICONES.carrinho + '<div>' + tx('O teu carrinho está vazio.') + '</div></div>';
    } else {
      cont.innerHTML = itens.map(function(i){
        var sub = i.preco * i.quantidade;
        total += sub;
        var img = imagemDe(i.produto);
        return '<div class="dia-item-carrinho">'
          + (img ? '<img class="dia-item-img" src="' + esc(img) + '" alt="">' : '<div class="dia-item-img"></div>')
          + '<div class="dia-item-info"><div class="dia-item-nome">' + esc(i.nome) + '</div>'
          + '<div class="dia-item-linha"><div class="dia-qtd"><button data-menos="' + esc(i.chave) + '" aria-label="' + tx('Menos') + '">−</button><span>' + i.quantidade + '</span><button data-mais="' + esc(i.chave) + '" aria-label="' + tx('Mais') + '">+</button></div>'
          + '<span class="dia-item-preco">' + mzn(sub) + '</span></div>'
          + '<button class="dia-remover" data-remover="' + esc(i.chave) + '">' + tx('Remover') + '</button></div></div>';
      }).join('');
    }
    $('dia-total-carrinho').textContent = mzn(total);
    $('dia-btn-finalizar').disabled = !itens.length;
    cada(cont.querySelectorAll('[data-mais]'), function(b){
      b.addEventListener('click', function(){
        var k = b.getAttribute('data-mais'), partes = k.split('::');
        adicionar(partes[0], partes.length > 1 ? Number(partes[1]) : null, 1);
      });
    });
    cada(cont.querySelectorAll('[data-menos]'), function(b){
      b.addEventListener('click', function(){ var k = b.getAttribute('data-menos'); carrinho[k] = (carrinho[k] || 0) - 1; if (carrinho[k] <= 0) delete carrinho[k]; guardarCarrinho(); renderCarrinho(); });
    });
    cada(cont.querySelectorAll('[data-remover]'), function(b){
      b.addEventListener('click', function(){ delete carrinho[b.getAttribute('data-remover')]; guardarCarrinho(); renderCarrinho(); });
    });
  }

  // ======================================================
  // Checkout - adapta-se ao modo da loja
  // ======================================================
  var metodoSeleccionado = '';

  function abrirCheckout(){
    var itens = itensDoCarrinho();
    if (!itens.length) return;
    var total = itens.reduce(function(t, i){ return t + i.preco * i.quantidade; }, 0);
    var qtd = itens.reduce(function(t, i){ return t + i.quantidade; }, 0);
    var modo = loja.modo;

    var blocoModo = '';
    var textoBotao = tx('Confirmar encomenda');
    var classeBotao = 'dia-btn-principal';
    var iconeBotao = '';
    if (modo === 'daniel') {
      var nomesMetodos = { mpesa: ['M-Pesa', 'Vodacom'], emola: ['e-Mola', 'Movitel'], cartao: [tx('Cartão'), 'Visa / Mastercard'] };
      blocoModo = '<div class="dia-campo"><label>' + tx('Como queres pagar?') + '</label><div class="dia-metodos">'
        + loja.metodos.map(function(m){ return '<div class="dia-metodo" data-metodo="' + m + '">' + nomesMetodos[m][0] + '<small>' + nomesMetodos[m][1] + '</small></div>'; }).join('')
        + '</div></div>';
      textoBotao = tx('Pagar {v}', { v: mzn(total) });
    } else if (modo === 'manual' && loja.manual) {
      blocoModo = '<div class="dia-pagar-para"><p>' + tx('Depois de confirmares, paga directamente à loja para um destes números, com a referência que te vamos dar:') + '</p>'
        + (loja.manual.mpesa ? '<div class="dia-numero"><span>M-Pesa <b>' + esc(loja.manual.mpesa) + '</b></span></div>' : '')
        + (loja.manual.emola ? '<div class="dia-numero"><span>e-Mola <b>' + esc(loja.manual.emola) + '</b></span></div>' : '')
        + (loja.manual.titular ? '<p style="margin:10px 0 0">' + tx('Em nome de') + ' <b>' + esc(loja.manual.titular) + '</b></p>' : '')
        + '</div>';
    } else if (modo === 'whatsapp') {
      textoBotao = tx('Encomendar pelo WhatsApp');
      classeBotao += ' dia-wa';
      iconeBotao = ICONES.whatsapp;
    } else {
      textoBotao = tx('Enviar encomenda');
    }

    var j = abrirJanela('<div class="dia-modal-corpo">'
      + '<h3>' + tx('Finalizar compra') + '</h3>'
      + '<p class="dia-modal-sub">' + (modo === 'whatsapp' ? tx('Preenche os teus dados e enviamos a encomenda para o WhatsApp da loja.') : (modo === 'pedido' ? tx('A loja recebe a tua encomenda e contacta-te para combinar o pagamento e a entrega.') : tx('Só falta isto para receberes a tua encomenda.'))) + '</p>'
      + '<div id="dia-checkout-form">'
      + '<div class="dia-resumo"><span>' + tx(qtd === 1 ? '{n} artigo' : '{n} artigos', { n: qtd }) + '</span><strong>' + mzn(total) + '</strong></div>'
      + '<div class="dia-campo"><label for="dia-cliente-nome">' + tx('O teu nome') + '</label><input type="text" id="dia-cliente-nome" maxlength="100" autocomplete="name"></div>'
      + '<div class="dia-campo"><label for="dia-cliente-telefone">' + tx('Telefone') + (modo === 'daniel' ? ' ' + tx('(o mesmo da carteira, para M-Pesa/e-Mola)') : '') + '</label><input type="tel" id="dia-cliente-telefone" maxlength="20" placeholder="84 123 4567" autocomplete="tel"></div>'
      + '<div class="dia-campo"><label for="dia-cliente-email">' + tx('Email (opcional, para receberes a confirmação)') + '</label><input type="email" id="dia-cliente-email" maxlength="150" autocomplete="email"></div>'
      + '<div class="dia-campo"><label for="dia-cliente-notas">' + tx('Morada de entrega / notas (opcional)') + '</label><textarea id="dia-cliente-notas" rows="2" maxlength="500"></textarea></div>'
      + blocoModo
      + '<button class="' + classeBotao + '" id="dia-btn-pagar">' + iconeBotao + '<span>' + textoBotao + '</span></button>'
      + '<div class="dia-msg-erro" id="dia-checkout-erro"></div>'
      + '</div>'
      + '<div id="dia-checkout-estado" style="display:none"></div>'
      + '</div>');

    metodoSeleccionado = '';
    cada(j.querySelectorAll('.dia-metodo'), function(el){
      el.addEventListener('click', function(){
        cada(j.querySelectorAll('.dia-metodo'), function(x){ x.classList.remove('seleccionado'); });
        el.classList.add('seleccionado');
        metodoSeleccionado = el.getAttribute('data-metodo');
      });
    });
    $('dia-btn-pagar').addEventListener('click', function(){ confirmar(itens, modo, textoBotao); });
  }

  function mensagemDeErro(r, padrao){
    if (r && r.codigo === 'stock') {
      return r.disponivel ? tx(r.disponivel === 1 ? 'Só resta 1 de "{nome}".' : 'Só restam {n} de "{nome}".', { n: r.disponivel, nome: r.nome || '' }) : tx('"{nome}" está esgotado.', { nome: r.nome || '' });
    }
    if (r && r.codigo === 'opcao') return tx('Escolhe uma opção para "{nome}".', { nome: r.nome || '' });
    return (DIA_LANG === 'pt' && r && r.message) || padrao;
  }

  function confirmar(itens, modo, textoBotao){
    var nome = $('dia-cliente-nome').value.trim();
    var telefone = $('dia-cliente-telefone').value.trim();
    var email = $('dia-cliente-email').value.trim();
    var notas = $('dia-cliente-notas').value.trim();
    var elErro = $('dia-checkout-erro');
    elErro.textContent = '';
    if (nome.length < 2) { elErro.textContent = tx('Escreve o teu nome.'); return; }
    if (soDigitos(telefone).length < 9) { elErro.textContent = tx('Escreve o teu número de telefone.'); return; }
    if (email && !emailValido(email)) { elErro.textContent = tx('Esse email não parece válido - podes deixá-lo em branco.'); return; }
    if (modo === 'daniel' && !metodoSeleccionado) { elErro.textContent = tx('Escolhe como queres pagar.'); return; }

    var btn = $('dia-btn-pagar');
    btn.disabled = true;
    btn.querySelector('span').textContent = tx('A processar...');

    // Para o WhatsApp abrir sem ser bloqueado como pop-up, abrimos já uma
    // janela em branco no próprio clique e só depois lhe damos o endereço.
    var janelaWa = null;
    if (modo === 'whatsapp') {
      try { janelaWa = window.open('', '_blank'); } catch (e) { janelaWa = null; }
    }

    post('/loja-encomenda', {
      site_id: SITE_ID,
      cliente_nome: nome,
      cliente_telefone: telefone,
      cliente_email: email,
      notas: notas,
      idioma: DIA_LANG,
      itens: itens.map(function(i){ return { produto_id: i.produto.id, variante: i.variante, quantidade: i.quantidade }; })
    }).then(function(r){
      if (r.status !== 'success') throw new Error(mensagemDeErro(r, tx('Não foi possível criar a encomenda.')));
      var enc = r.response;
      if (enc.modo === 'daniel') {
        return post('/loja-pagar', { encomenda_id: enc.encomenda_id, metodo: metodoSeleccionado }).then(function(rp){
          if (rp.status !== 'success') throw new Error((DIA_LANG === 'pt' && rp.message) || tx('Não foi possível iniciar o pagamento.'));
          if (rp.response.tipo === 'cartao') { limparCarrinho(); renderCarrinho(); pagarComCartao(enc, rp.response); return; }
          limparCarrinho(); renderCarrinho();
          esperarPagamento(enc.encomenda_id, enc.referencia);
        });
      }
      limparCarrinho(); renderCarrinho();
      if (enc.modo === 'whatsapp' && enc.whatsapp_url) {
        if (janelaWa) { janelaWa.location.href = enc.whatsapp_url; } else { window.location.href = enc.whatsapp_url; }
      } else if (janelaWa) {
        janelaWa.close();
      }
      mostrarSucesso(enc);
    }).catch(function(erro){
      if (janelaWa) { try { janelaWa.close(); } catch (e) {} }
      btn.disabled = false;
      btn.querySelector('span').textContent = textoBotao;
      elErro.textContent = erro.message || tx('Algo correu mal. Tenta novamente.');
    });
  }

  function mostrarEstado(html){
    $('dia-checkout-form').style.display = 'none';
    var el = $('dia-checkout-estado');
    el.style.display = 'block';
    el.innerHTML = html;
    return el;
  }

  function mostrarSucesso(enc){
    var html = '<div class="dia-estado-pagamento"><div class="dia-ok">' + ICONES.certo + '</div>'
      + '<h3>' + tx('Encomenda enviada!') + '</h3><div class="dia-ref">' + esc(enc.referencia) + '</div>';
    if (enc.modo === 'manual' && enc.manual) {
      html += '<p>' + tx('Para concluir, paga {v} com a referência {r}:', { v: '<b>' + mzn(enc.valor_total) + '</b>', r: '<b>' + esc(enc.referencia) + '</b>' }) + '</p>'
        + (enc.manual.mpesa ? '<div class="dia-numero"><span>M-Pesa <b>' + esc(enc.manual.mpesa) + '</b></span><button class="dia-copiar" data-copiar="' + esc(enc.manual.mpesa) + '">' + ICONES.copiar + tx('Copiar') + '</button></div>' : '')
        + (enc.manual.emola ? '<div class="dia-numero"><span>e-Mola <b>' + esc(enc.manual.emola) + '</b></span><button class="dia-copiar" data-copiar="' + esc(enc.manual.emola) + '">' + ICONES.copiar + tx('Copiar') + '</button></div>' : '')
        + (enc.manual.titular ? '<p>' + tx('Em nome de') + ' <b>' + esc(enc.manual.titular) + '</b>. ' + tx('A loja confirma o pagamento e prepara a tua encomenda.') + '</p>' : '<p>' + tx('A loja confirma o pagamento e prepara a tua encomenda.') + '</p>');
      if (enc.whatsapp_url) html += '<a class="dia-btn-principal dia-wa" style="margin-top:16px;text-decoration:none" href="' + esc(enc.whatsapp_url) + '" target="_blank" rel="noopener">' + ICONES.whatsapp + '<span>' + tx('Enviar comprovativo no WhatsApp') + '</span></a>';
    } else if (enc.modo === 'whatsapp') {
      html += '<p>' + tx('Abrimos o WhatsApp com a tua encomenda já escrita - só tens de carregar em enviar.') + '</p>'
        + '<a class="dia-btn-principal dia-wa" style="margin-top:16px;text-decoration:none" href="' + esc(enc.whatsapp_url) + '" target="_blank" rel="noopener">' + ICONES.whatsapp + '<span>' + tx('Abrir o WhatsApp outra vez') + '</span></a>';
    } else {
      html += '<p>' + tx('A loja recebeu a tua encomenda e vai contactar-te em breve para combinar o pagamento e a entrega.') + '</p>';
    }
    html += '<button class="dia-btn-sec" data-fechar-final>' + tx('Continuar a comprar') + '</button></div>';
    var el = mostrarEstado(html);
    // O stock mudou com esta encomenda: actualizar a montra já, por trás.
    recarregarProdutos().catch(function(){});
    el.querySelector('[data-fechar-final]').addEventListener('click', function(){ fecharJanela(); });
    cada(el.querySelectorAll('[data-copiar]'), function(b){
      b.addEventListener('click', function(){
        var v = b.getAttribute('data-copiar');
        try { navigator.clipboard.writeText(v); } catch (e) {}
        b.innerHTML = ICONES.certo + tx('Copiado');
      });
    });
  }

  function esperarPagamento(encomendaId, referencia){
    var el = mostrarEstado('<div class="dia-estado-pagamento"><div class="dia-spinner"></div><h3>' + tx('Confirma no teu telemóvel') + '</h3>'
      + '<p id="dia-estado-texto">' + tx('Enviámos o pedido de pagamento para o teu número. Introduz o PIN para confirmar.') + '</p></div>');
    var tentativas = 0;
    function verificar(){
      post('/loja-estado', { encomenda_id: encomendaId }).then(function(r){
        if (r.status === 'success' && r.response.estado === 'Pago') {
          el.innerHTML = '<div class="dia-estado-pagamento"><div class="dia-ok">' + ICONES.certo + '</div><h3>' + tx('Pagamento confirmado!') + '</h3>'
            + '<div class="dia-ref">' + esc(referencia) + '</div><p>' + tx('Obrigado pela tua compra. A loja já recebeu a tua encomenda.') + '</p>'
            + '<button class="dia-btn-sec" data-fechar-final>' + tx('Continuar a comprar') + '</button></div>';
          el.querySelector('[data-fechar-final]').addEventListener('click', function(){ fecharJanela(); recarregarProdutos(); });
          return;
        }
        tentativas++;
        if (tentativas >= 25) {
          var t = $('dia-estado-texto');
          if (t) t.textContent = tx('Ainda não recebemos a confirmação. Se já pagaste, aguarda - a loja recebe a encomenda assim que o pagamento chegar.');
          return;
        }
        setTimeout(verificar, 3000);
      }).catch(function(){
        tentativas++;
        if (tentativas < 25) setTimeout(verificar, 3000);
      });
    }
    verificar();
  }

  // ======================================================
  // Arranque
  // ======================================================
  // ---- Pré-visualização (estúdio de layouts): produtos de exemplo ----
  var PREVIA = /[?&]dia_previa=1/.test(window.location.search);
  function produtosDeExemplo(){
    var precos = [1500, 2900, 850, 4200, 1250, 3600, 990, 2450];
    var antigos = [0, 3500, 0, 0, 1600, 0, 1300, 0];
    return precos.map(function(preco, i){
      return {
        id: 'exemplo' + i, demo: true, nome: tx('Produto {n}', { n: i + 1 }), preco: preco, preco_antigo: antigos[i],
        categoria: [tx('Clássicos'), tx('Novidades'), tx('Edição limitada')][i % 3], destaque: i < 4, descricao: tx('Os teus produtos reais aparecem aqui, com fotos, preços e opções.'),
        imagem: '', imagens: [], variantes: [], stock: null, esgotado: false, vendidos: 8 - i,
        criado: new Date(Date.now() - i * 86400000).toISOString(), avaliacao: { media: i % 2 ? 4.5 : 0, total: i % 2 ? 12 - i : 0 }
      };
    });
  }
  function recarregarProdutos(){
    return post('/loja-produtos', { site_id: SITE_ID }).then(function(r){
      if (r.status !== 'success') throw new Error();
      produtos = r.response.produtos || [];
      if (PREVIA && !produtos.length) produtos = produtosDeExemplo();
      if (r.response.loja) loja = r.response.loja;
      var ocultas = {};
      configCategorias().forEach(function(c){ if (c.oculta) ocultas[String(c.nome).toLowerCase()] = true; });
      produtos = produtos.filter(function(p){ return !ocultas[String(p.categoria || '').toLowerCase()]; });
      // "Roupa" e "roupa" são a mesma categoria: fica a grafia da configuração ou a mais usada.
      var grafias = {}, canon = {};
      produtos.forEach(function(p){ var c = String(p.categoria || '').trim(); if (!c) return; var k = c.toLowerCase(); grafias[k] = grafias[k] || {}; grafias[k][c] = (grafias[k][c] || 0) + 1; });
      Object.keys(grafias).forEach(function(k){ var g = grafias[k]; canon[k] = Object.keys(g).sort(function(a, b){ return g[b] - g[a]; })[0]; });
      configCategorias().forEach(function(c){ var k = String(c.nome).toLowerCase(); if (canon[k]) canon[k] = c.nome; });
      produtos.forEach(function(p){ var c = String(p.categoria || '').trim(); p.categoria = c ? (canon[c.toLowerCase()] || c) : ''; });
      renderMontra();
      renderCarrinho();
    });
  }
  function iniciar(){
    injectarEstilos();
    if (PREVIA) document.documentElement.classList.add('dia-modo-previa');
    if (!montarUI()) return;
    renderCarrinho();
    recarregarProdutos().catch(function(){
      $('dia-montra').innerHTML = '<div class="dia-vazio">' + tx('Não foi possível carregar os produtos. Recarrega a página.') + '</div>';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
`;

// ======================================================
// Script fixo do visualizador da Galeria, servido directamente
// ======================================================
// Guardado aqui como texto para ser servido por /galeria-viewer.js. É
// este ficheiro que todos os sites de Galeria gerados carregam - nunca é
// a IA a escrever esta lógica. Espelha o mesmo padrão do LOJA_CART_JS:
// uma div vazia com id="daniel-ia-galeria", preenchida sozinha com os
// álbuns a sério (grelha de capas) e um lightbox para ver as fotos e
// vídeos de cada álbum, com transições suaves e vídeo por HLS (hls.js,
// carregado só se for mesmo preciso).
const GALERIA_VIEWER_JS = `/*
  Daniel IA - módulo fixo da Galeria (álbuns + visualizador)
  ---------------------------------------------------------------------
  Este ficheiro é servido pelo próprio container em /galeria-viewer.js e
  é carregado por TODOS os sites de Galeria gerados pela IA. A IA nunca
  escreve esta lógica - só desenha a aparência do site e deixa uma div
  com id="daniel-ia-galeria" onde este módulo mostra os álbuns a sério.

  Cada página gerada define, antes de carregar este ficheiro:
    window.DANIEL_IA_SITE_ID = 'xxxxx';
*/
(function(){
  'use strict';

  // ---- Idioma do site (lido do <html lang>): pt, en, fr ou es ----
  var DIA_LANG = (function(){
    var l = String(document.documentElement.getAttribute('lang') || 'pt').toLowerCase().slice(0, 2);
    return (l === 'en' || l === 'fr' || l === 'es') ? l : 'pt';
  })();
  var DIA_LOCALE = { pt: 'pt-PT', en: 'en-GB', fr: 'fr-FR', es: 'es-ES' }[DIA_LANG];
  var DIA_TXT = {"en": {"A carregar álbuns...": "Loading albums...", "Ainda não há álbuns aqui.": "No albums here yet.", "Sem ficheiros": "No files", "{n} ficheiro": "{n} file", "{n} ficheiros": "{n} files", "Não foi possível abrir este álbum.": "Could not open this album.", "Ainda não há fotos ou vídeos neste álbum.": "No photos or videos in this album yet.", "Não foi possível carregar os álbuns.": "Could not load the albums.", "Seguinte": "Next", "Fechar": "Close", "Não foi possível ligar ao servidor.": "Could not connect to the server.", "Anterior": "Previous", "Pré-visualização: os teus álbuns aparecem aqui.": "Preview: your albums will appear here."}, "fr": {"A carregar álbuns...": "Chargement des albums...", "Ainda não há álbuns aqui.": "Aucun album pour le moment.", "Sem ficheiros": "Aucun fichier", "{n} ficheiro": "{n} fichier", "{n} ficheiros": "{n} fichiers", "Não foi possível abrir este álbum.": "Impossible d'ouvrir cet album.", "Ainda não há fotos ou vídeos neste álbum.": "Aucune photo ni vidéo dans cet album pour le moment.", "Não foi possível carregar os álbuns.": "Impossible de charger les albums.", "Seguinte": "Suivant", "Fechar": "Fermer", "Não foi possível ligar ao servidor.": "Impossible de se connecter au serveur.", "Anterior": "Précédent", "Pré-visualização: os teus álbuns aparecem aqui.": "Aperçu : vos albums apparaîtront ici."}, "es": {"A carregar álbuns...": "Cargando álbumes...", "Ainda não há álbuns aqui.": "Todavía no hay álbumes.", "Sem ficheiros": "Sin archivos", "{n} ficheiro": "{n} archivo", "{n} ficheiros": "{n} archivos", "Não foi possível abrir este álbum.": "No se pudo abrir este álbum.", "Ainda não há fotos ou vídeos neste álbum.": "Todavía no hay fotos ni vídeos en este álbum.", "Não foi possível carregar os álbuns.": "No se pudieron cargar los álbumes.", "Seguinte": "Siguiente", "Fechar": "Cerrar", "Não foi possível ligar ao servidor.": "No se pudo conectar con el servidor.", "Anterior": "Anterior", "Pré-visualização: os teus álbuns aparecem aqui.": "Vista previa: tus álbumes aparecerán aquí."}};
  function tx(s, v){
    var d = DIA_TXT[DIA_LANG];
    var r = (d && d[s]) || s;
    if (v) { for (var k in v) { r = r.split('{' + k + '}').join(String(v[k])); } }
    return r;
  }

  var CONTAINER_URL = 'https://mc-8oxfde5o71.bunny.run';
  var SITE_ID = window.DANIEL_IA_SITE_ID || '';

  if (!SITE_ID) {
    console.error('Daniel IA: falta window.DANIEL_IA_SITE_ID nesta página - o visualizador da galeria não pode arrancar.');
    return;
  }

  var mediaAtual = [];
  var albumActual = null;
  var indiceAtual = 0;
  var hlsInstancia = null;

  // ======================================================
  // Texto seguro para dentro de HTML
  // ======================================================
  function escaparHtml(t){
    var d = document.createElement('div');
    d.textContent = (t == null ? '' : String(t));
    return d.innerHTML;
  }
  function escaparAtributo(t){
    return escaparHtml(t).replace(/"/g, '&quot;');
  }

  // ======================================================
  // Estilos (isolados com o prefixo "dig-" para não colidir com o CSS
  // que a IA desenhou para o resto do site)
  // ======================================================
  function injectarEstilos(){
    var css = ''
      + '.dig-grelha{--_s:var(--dia-superficie,color-mix(in srgb,currentColor 5%,transparent));--_t:var(--dia-texto,currentColor);--_ts:var(--dia-texto-suave,color-mix(in srgb,currentColor 62%,transparent));--_b:var(--dia-borda,color-mix(in srgb,currentColor 13%,transparent));--_r:var(--dia-raio,14px);--_ft:var(--dia-fonte-titulos,inherit);display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:20px;margin:0;padding:0;}'
      + '.dig-album-card{cursor:pointer;border-radius:var(--_r);overflow:hidden;background:color-mix(in srgb,currentColor 8%,transparent);position:relative;font-family:inherit;isolation:isolate;transition:transform .35s cubic-bezier(.2,.8,.2,1),box-shadow .35s ease;}'
      + '.dig-album-card:hover{transform:translateY(-5px);box-shadow:0 26px 50px -22px rgba(0,0,0,.65);}'
      + '.dig-album-card::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px rgba(255,255,255,.09);pointer-events:none;}'
      + '.dig-album-capa{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:color-mix(in srgb,currentColor 10%,transparent);transition:transform .7s cubic-bezier(.2,.8,.2,1);}'
      + '.dig-album-card:hover .dig-album-capa{transform:scale(1.07);}'
      + '.dig-album-capa-vazia{display:flex;align-items:center;justify-content:center;color:var(--_ts);font-size:13px;}'
      + '.dig-album-info{position:absolute;left:0;right:0;bottom:0;padding:46px 18px 16px;background:linear-gradient(to top,rgba(0,0,0,.85),rgba(0,0,0,0));}'
      + '.dig-album-titulo{font-family:var(--_ft);color:#fff;font-weight:700;font-size:16.5px;letter-spacing:-.01em;margin-bottom:3px;}'
      + '.dig-album-meta{color:rgba(255,255,255,.76);font-size:12px;letter-spacing:.02em;}'
      + '.dig-vazio{color:var(--_ts);font-size:13px;}'
      + '.dig-lightbox{position:fixed;inset:0;background:rgba(6,6,10,.94);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);z-index:100000;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .3s ease;font-family:inherit;}'
      + '.dig-lightbox.dig-aberto{opacity:1;pointer-events:auto;}'
      + '.dig-lightbox-topo{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:18px 20px;color:#eee;z-index:2;background:linear-gradient(to bottom,rgba(0,0,0,.5),rgba(0,0,0,0));}'
      + '.dig-lightbox-titulo-album{font-family:var(--dia-fonte-titulos,inherit);font-size:15px;font-weight:700;color:#fff;}'
      + '.dig-lightbox-contador{font-size:12px;color:rgba(255,255,255,.65);margin-top:2px;letter-spacing:.04em;}'
      + '.dig-lightbox-fechar{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.14);color:#fff;font-size:20px;line-height:1;width:40px;height:40px;border-radius:50%;cursor:pointer;transition:background .15s,transform .15s;}'
      + '.dig-lightbox-fechar:hover{background:rgba(255,255,255,.22);transform:rotate(90deg);}'
      + '.dig-lightbox-palco{width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:70px 76px;box-sizing:border-box;position:relative;}'
      + '.dig-lightbox-conteudo{max-width:100%;max-height:100%;opacity:0;transform:scale(.97);transition:opacity .25s ease,transform .25s ease;display:flex;align-items:center;justify-content:center;}'
      + '.dig-lightbox-conteudo.dig-visivel{opacity:1;transform:scale(1);}'
      + '.dig-lightbox-conteudo img,.dig-lightbox-conteudo video{max-width:100%;max-height:80vh;border-radius:10px;display:block;background:#000;box-shadow:0 30px 80px rgba(0,0,0,.6);}'
      + '.dig-lightbox-spinner{width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.18);border-top-color:#fff;animation:dig-girar .8s linear infinite;}'
      + '@keyframes dig-girar{to{transform:rotate(360deg);}}'
      + '.dig-lightbox-seta{position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.14);color:#fff;width:48px;height:48px;border-radius:50%;font-size:20px;cursor:pointer;z-index:2;transition:background .15s;}'
      + '.dig-lightbox-seta:hover{background:rgba(255,255,255,.24);}'
      + '.dig-lightbox-seta.dig-esquerda{left:16px;}'
      + '.dig-lightbox-seta.dig-direita{right:16px;}'
      + '.dig-lightbox-vazio{color:#ccc;font-size:14px;text-align:center;}'
      + '@media(max-width:640px){.dig-lightbox-palco{padding:70px 14px;}.dig-lightbox-seta{width:40px;height:40px;font-size:17px;}.dig-lightbox-seta.dig-esquerda{left:6px;}.dig-lightbox-seta.dig-direita{right:6px;}}'
      + '@media (prefers-reduced-motion:reduce){.dig-album-card,.dig-album-capa,.dig-lightbox,.dig-lightbox-conteudo{transition:none !important;animation:none !important;}}';
    var style = document.createElement('style');
    style.setAttribute('data-daniel-ia', 'galeria');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ======================================================
  // Grelha de álbuns
  // ======================================================
  function montarGrelha(){
    var alvo = document.getElementById('daniel-ia-galeria');
    if (!alvo) {
      console.error('Daniel IA: falta uma div com id="daniel-ia-galeria" nesta página - os álbuns não têm onde aparecer.');
      return null;
    }
    alvo.innerHTML = '<div id="dig-grelha" class="dig-grelha"><p class="dig-vazio">' + tx('A carregar álbuns...') + '</p></div>';
    return document.getElementById('dig-grelha');
  }

  function renderGrelha(albuns){
    var grelha = document.getElementById('dig-grelha');
    if (!grelha) return;
    if (!albuns || albuns.length === 0) {
      if (/[?&]dia_previa=1/.test(window.location.search)) {
        // Pré-visualização (estúdio de layouts): mosaico de exemplo com as cores do site.
        var tons = [14, 26, 8, 20, 32, 11];
        var mosaico = '';
        for (var i = 0; i < 6; i++) {
          mosaico += '<div style="aspect-ratio:4/3;border-radius:var(--dia-raio,12px);background:linear-gradient(' + (130 + i * 40) + 'deg,color-mix(in srgb,var(--dia-primaria,#888) ' + tons[i % 6] + '%,var(--dia-superficie,#fff)),color-mix(in srgb,var(--dia-primaria,#888) ' + (tons[i % 6] + 18) + '%,var(--dia-superficie,#fff)));border:1px solid var(--dia-borda,rgba(0,0,0,.08));"></div>';
        }
        grelha.innerHTML = mosaico + '<p class="dig-vazio" style="grid-column:1/-1;opacity:.75">' + tx('Pré-visualização: os teus álbuns aparecem aqui.') + '</p>';
        return;
      }
      grelha.innerHTML = '<p class="dig-vazio">' + tx('Ainda não há álbuns aqui.') + '</p>';
      return;
    }
    grelha.innerHTML = albuns.map(function(a){
      var capa = a.capa
        ? '<img class="dig-album-capa" src="' + escaparAtributo(a.capa) + '" alt="' + escaparAtributo(a.titulo) + '">'
        : '<div class="dig-album-capa dig-album-capa-vazia">' + tx('Sem ficheiros') + '</div>';
      return ''
        + '<div class="dig-album-card" data-id="' + a.id + '">'
        + capa
        + '<div class="dig-album-info">'
        + '<div class="dig-album-titulo">' + escaparHtml(a.titulo) + '</div>'
        + '<div class="dig-album-meta">' + tx(a.total_media === 1 ? '{n} ficheiro' : '{n} ficheiros', { n: a.total_media }) + '</div>'
        + '</div>'
        + '</div>';
    }).join('');

    grelha.querySelectorAll('.dig-album-card').forEach(function(cartao){
      cartao.addEventListener('click', function(){
        abrirAlbum(cartao.getAttribute('data-id'));
      });
    });
  }

  // ======================================================
  // Lightbox
  // ======================================================
  var lightboxEl = null;

  function montarLightbox(){
    if (lightboxEl) return lightboxEl;
    var el = document.createElement('div');
    el.className = 'dig-lightbox';
    el.id = 'dig-lightbox';
    el.innerHTML = ''
      + '<div class="dig-lightbox-topo">'
      + '<div><div class="dig-lightbox-titulo-album" id="dig-titulo-album"></div><div class="dig-lightbox-contador" id="dig-contador"></div></div>'
      + '<button class="dig-lightbox-fechar" id="dig-fechar" aria-label="' + tx('Fechar') + '">&times;</button>'
      + '</div>'
      + '<button class="dig-lightbox-seta dig-esquerda" id="dig-anterior" aria-label="' + tx('Anterior') + '">&#8249;</button>'
      + '<div class="dig-lightbox-palco" id="dig-palco"></div>'
      + '<button class="dig-lightbox-seta dig-direita" id="dig-seguinte" aria-label="' + tx('Seguinte') + '">&#8250;</button>';
    document.body.appendChild(el);
    lightboxEl = el;

    document.getElementById('dig-fechar').addEventListener('click', fecharLightbox);
    el.addEventListener('click', function(e){
      if (e.target === el) fecharLightbox();
    });
    document.getElementById('dig-anterior').addEventListener('click', function(){ navegar(-1); });
    document.getElementById('dig-seguinte').addEventListener('click', function(){ navegar(1); });

    document.addEventListener('keydown', function(e){
      if (!lightboxEl.classList.contains('dig-aberto')) return;
      if (e.key === 'Escape') fecharLightbox();
      if (e.key === 'ArrowLeft') navegar(-1);
      if (e.key === 'ArrowRight') navegar(1);
    });

    var toqueInicioX = null;
    el.addEventListener('touchstart', function(e){
      toqueInicioX = e.touches[0].clientX;
    }, { passive: true });
    el.addEventListener('touchend', function(e){
      if (toqueInicioX == null) return;
      var delta = e.changedTouches[0].clientX - toqueInicioX;
      toqueInicioX = null;
      if (Math.abs(delta) < 40) return;
      navegar(delta > 0 ? -1 : 1);
    }, { passive: true });

    return el;
  }

  function abrirAlbum(albumId){
    var el = montarLightbox();
    el.classList.add('dig-aberto');
    document.body.style.overflow = 'hidden';
    document.getElementById('dig-titulo-album').textContent = '';
    document.getElementById('dig-contador').textContent = '';
    mostrarPalco('<div class="dig-lightbox-spinner"></div>', false);

    fetch(CONTAINER_URL + '/galeria-album-publico', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: SITE_ID, album_id: albumId })
    }).then(function(r){ return r.json(); })
      .then(function(r){
        if (r.status !== 'success') {
          mostrarPalco('<p class="dig-lightbox-vazio">' + escaparHtml((DIA_LANG === 'pt' && r.message) || tx('Não foi possível abrir este álbum.')) + '</p>', true);
          return;
        }
        albumActual = r.response.album;
        mediaAtual = r.response.media || [];
        indiceAtual = 0;
        document.getElementById('dig-titulo-album').textContent = albumActual.titulo || '';
        if (mediaAtual.length === 0) {
          document.getElementById('dig-contador').textContent = '';
          mostrarPalco('<p class="dig-lightbox-vazio">' + tx('Ainda não há fotos ou vídeos neste álbum.') + '</p>', true);
          return;
        }
        mostrarMediaAtual();
      })
      .catch(function(){
        mostrarPalco('<p class="dig-lightbox-vazio">' + tx('Não foi possível ligar ao servidor.') + '</p>', true);
      });
  }

  function fecharLightbox(){
    if (!lightboxEl) return;
    lightboxEl.classList.remove('dig-aberto');
    document.body.style.overflow = '';
    pararVideoActual();
  }

  function pararVideoActual(){
    if (hlsInstancia) {
      try { hlsInstancia.destroy(); } catch (e) {}
      hlsInstancia = null;
    }
    var palco = document.getElementById('dig-palco');
    if (palco) {
      var video = palco.querySelector('video');
      if (video) { try { video.pause(); } catch (e) {} }
    }
  }

  function mostrarPalco(htmlInterno, visivelJa){
    var palco = document.getElementById('dig-palco');
    if (!palco) return;
    palco.innerHTML = '<div class="dig-lightbox-conteudo' + (visivelJa ? ' dig-visivel' : '') + '" id="dig-conteudo">' + htmlInterno + '</div>';
    if (!visivelJa) {
      requestAnimationFrame(function(){
        var conteudo = document.getElementById('dig-conteudo');
        if (conteudo) conteudo.classList.add('dig-visivel');
      });
    }
  }

  function navegar(direcao){
    if (mediaAtual.length === 0) return;
    pararVideoActual();
    indiceAtual = (indiceAtual + direcao + mediaAtual.length) % mediaAtual.length;
    var conteudo = document.getElementById('dig-conteudo');
    if (conteudo) conteudo.classList.remove('dig-visivel');
    setTimeout(mostrarMediaAtual, 160);
  }

  function mostrarMediaAtual(){
    var item = mediaAtual[indiceAtual];
    if (!item) return;
    document.getElementById('dig-contador').textContent = (indiceAtual + 1) + ' / ' + mediaAtual.length;

    if (item.tipo === 'video') {
      mostrarPalco(''
        + '<video id="dig-video" controls playsinline poster="' + escaparAtributo(item.thumbnail || '') + '"></video>', false);
      var video = document.getElementById('dig-video');
      carregarVideo(video, item.url);
    } else {
      mostrarPalco('<img src="' + escaparAtributo(item.url) + '" alt="">', false);
    }
  }

  function carregarVideo(video, url){
    if (!video || !url) return;
    var suportaNativo = video.canPlayType('application/vnd.apple.mpegurl');
    if (suportaNativo) {
      video.src = url;
      return;
    }
    carregarHlsJs(function(){
      if (!window.Hls || !window.Hls.isSupported()) {
        video.src = url;
        return;
      }
      var hls = new window.Hls();
      hls.loadSource(url);
      hls.attachMedia(video);
      hlsInstancia = hls;
    });
  }

  var hlsScriptPedido = false;
  function carregarHlsJs(callback){
    if (window.Hls) { callback(); return; }
    if (hlsScriptPedido) {
      var tentativas = 0;
      var esperar = setInterval(function(){
        tentativas++;
        if (window.Hls || tentativas > 40) {
          clearInterval(esperar);
          callback();
        }
      }, 100);
      return;
    }
    hlsScriptPedido = true;
    var script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js';
    script.onload = callback;
    script.onerror = function(){
      console.error('Daniel IA: não foi possível carregar o leitor de vídeo.');
      callback();
    };
    document.head.appendChild(script);
  }

  // ======================================================
  // Arranque
  // ======================================================
  function iniciar(){
    injectarEstilos();
    if (!montarGrelha()) return;

    fetch(CONTAINER_URL + '/galeria-albuns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: SITE_ID })
    }).then(function(r){ return r.json(); })
      .then(function(r){
        if (r.status === 'success') {
          renderGrelha(r.response.albuns || []);
        } else {
          var grelha = document.getElementById('dig-grelha');
          if (grelha) grelha.innerHTML = '<p class="dig-vazio">' + tx('Não foi possível carregar os álbuns.') + '</p>';
        }
      })
      .catch(function(){
        var grelha = document.getElementById('dig-grelha');
        if (grelha) grelha.innerHTML = '<p class="dig-vazio">' + tx('Não foi possível ligar ao servidor.') + '</p>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
`;

// ======================================================
// Script fixo do visualizador do Portefólio, servido directamente
// ======================================================
// Guardado aqui como texto para ser servido por /portfolio-viewer.js. É
// este ficheiro que todos os sites de Portefólio gerados carregam - nunca
// é a IA a escrever esta lógica. Mais simples que a Galeria: não há
// álbuns dentro de álbuns, só uma grelha de trabalhos, e um modal com a
// descrição completa (e um link "Ver projecto", se o dono tiver posto um).
const PORTFOLIO_VIEWER_JS = `/*
  Daniel IA - módulo fixo do Portefólio (grelha de trabalhos)
  ---------------------------------------------------------------------
  Este ficheiro é servido pelo próprio container em /portfolio-viewer.js
  e é carregado por TODOS os sites de Portefólio gerados pela IA. A IA
  nunca escreve esta lógica - só desenha a aparência do site e deixa uma
  div com id="daniel-ia-portfolio" onde este módulo mostra os trabalhos
  a sério.

  Cada página gerada define, antes de carregar este ficheiro:
    window.DANIEL_IA_SITE_ID = 'xxxxx';
*/
(function(){
  'use strict';

  // ---- Idioma do site (lido do <html lang>): pt, en, fr ou es ----
  var DIA_LANG = (function(){
    var l = String(document.documentElement.getAttribute('lang') || 'pt').toLowerCase().slice(0, 2);
    return (l === 'en' || l === 'fr' || l === 'es') ? l : 'pt';
  })();
  var DIA_LOCALE = { pt: 'pt-PT', en: 'en-GB', fr: 'fr-FR', es: 'es-ES' }[DIA_LANG];
  var DIA_TXT = {"en": {"A carregar trabalhos...": "Loading projects...", "Ainda não há trabalhos aqui.": "No projects here yet.", "Ver projecto": "View project", "Não foi possível carregar os trabalhos.": "Could not load the projects.", "Sem imagem": "No image", "Fechar": "Close", "Não foi possível ligar ao servidor.": "Could not connect to the server.", "Pré-visualização: os teus trabalhos aparecem aqui.": "Preview: your work will appear here."}, "fr": {"A carregar trabalhos...": "Chargement des projets...", "Ainda não há trabalhos aqui.": "Aucun projet pour le moment.", "Ver projecto": "Voir le projet", "Não foi possível carregar os trabalhos.": "Impossible de charger les projets.", "Sem imagem": "Pas d'image", "Fechar": "Fermer", "Não foi possível ligar ao servidor.": "Impossible de se connecter au serveur.", "Pré-visualização: os teus trabalhos aparecem aqui.": "Aperçu : vos réalisations apparaîtront ici."}, "es": {"A carregar trabalhos...": "Cargando proyectos...", "Ainda não há trabalhos aqui.": "Todavía no hay proyectos.", "Ver projecto": "Ver proyecto", "Não foi possível carregar os trabalhos.": "No se pudieron cargar los proyectos.", "Sem imagem": "Sin imagen", "Fechar": "Cerrar", "Não foi possível ligar ao servidor.": "No se pudo conectar con el servidor.", "Pré-visualização: os teus trabalhos aparecem aqui.": "Vista previa: tus trabajos aparecerán aquí."}};
  function tx(s, v){
    var d = DIA_TXT[DIA_LANG];
    var r = (d && d[s]) || s;
    if (v) { for (var k in v) { r = r.split('{' + k + '}').join(String(v[k])); } }
    return r;
  }

  var CONTAINER_URL = 'https://mc-8oxfde5o71.bunny.run';
  var SITE_ID = window.DANIEL_IA_SITE_ID || '';

  if (!SITE_ID) {
    console.error('Daniel IA: falta window.DANIEL_IA_SITE_ID nesta página - o portefólio não pode arrancar.');
    return;
  }

  var trabalhosCache = [];

  function escaparHtml(t){
    var d = document.createElement('div');
    d.textContent = (t == null ? '' : String(t));
    return d.innerHTML;
  }
  function escaparAtributo(t){
    return escaparHtml(t).replace(/"/g, '&quot;');
  }

  function injectarEstilos(){
    var css = ''
      + '.dip-grelha{--_s:var(--dia-superficie,color-mix(in srgb,currentColor 5%,transparent));--_t:var(--dia-texto,currentColor);--_ts:var(--dia-texto-suave,color-mix(in srgb,currentColor 62%,transparent));--_b:var(--dia-borda,color-mix(in srgb,currentColor 13%,transparent));--_r:var(--dia-raio,14px);--_ft:var(--dia-fonte-titulos,inherit);display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:22px;margin:0;padding:0;}'
      + '.dip-card{cursor:pointer;border-radius:var(--_r);overflow:hidden;background:var(--_s);border:1px solid var(--_b);color:var(--_t);font-family:inherit;transition:transform .35s cubic-bezier(.2,.8,.2,1),box-shadow .35s ease,border-color .35s ease;}'
      + '.dip-card:hover{transform:translateY(-5px);box-shadow:0 26px 50px -24px rgba(0,0,0,.55);border-color:color-mix(in srgb,currentColor 24%,transparent);}'
      + '.dip-card-img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:color-mix(in srgb,currentColor 8%,transparent);transition:transform .7s cubic-bezier(.2,.8,.2,1);}'
      + '.dip-card:hover .dip-card-img{transform:scale(1.06);}'
      + '.dip-card-img-vazia{display:flex;align-items:center;justify-content:center;color:var(--_ts);font-size:13px;}'
      + '.dip-card-corpo{padding:18px;}'
      + '.dip-card-titulo{font-family:var(--_ft);font-weight:700;font-size:16px;letter-spacing:-.01em;margin-bottom:6px;color:var(--_t);}'
      + '.dip-card-desc{font-size:13.5px;color:var(--_ts);line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}'
      + '.dip-vazio{color:var(--_ts);font-size:13px;}'
      + '.dip-overlay{--_f:var(--dia-fundo,#121218);--_t:var(--dia-texto,#fff);--_ts:var(--dia-texto-suave,rgba(255,255,255,.72));--_r:var(--dia-raio,14px);--_ft:var(--dia-fonte-titulos,inherit);--_p:var(--dia-primaria,#fff);position:fixed;inset:0;background:rgba(6,6,10,.72);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);z-index:100000;display:flex;align-items:center;justify-content:center;padding:24px;opacity:0;pointer-events:none;transition:opacity .25s ease;font-family:inherit;}'
      + '.dip-overlay.dip-aberto{opacity:1;pointer-events:auto;}'
      + '.dip-modal{background:var(--_f);color:var(--_t);border-radius:calc(var(--_r) + 8px);max-width:660px;width:100%;max-height:88vh;overflow-y:auto;position:relative;transform:translateY(14px) scale(.98);opacity:0;transition:opacity .3s ease,transform .3s cubic-bezier(.2,.8,.2,1);box-shadow:0 40px 90px rgba(0,0,0,.5);}'
      + '.dip-overlay.dip-aberto .dip-modal{transform:none;opacity:1;}'
      + '.dip-modal-img{width:100%;max-height:380px;object-fit:cover;display:block;background:color-mix(in srgb,var(--_t) 8%,transparent);}'
      + '.dip-modal-corpo{padding:26px;}'
      + '.dip-modal-titulo{font-family:var(--_ft);font-weight:800;font-size:22px;letter-spacing:-.02em;color:var(--_t);margin-bottom:12px;}'
      + '.dip-modal-desc{font-size:14.5px;color:var(--_ts);line-height:1.7;white-space:pre-wrap;}'
      + '.dip-modal-link{display:inline-flex;align-items:center;gap:6px;margin-top:18px;color:var(--_p);font-size:14px;font-weight:700;text-decoration:none;border-bottom:2px solid currentColor;padding-bottom:2px;}'
      + '.dip-fechar{position:absolute;top:14px;right:14px;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.18);color:#fff;font-size:20px;line-height:1;width:38px;height:38px;border-radius:50%;cursor:pointer;z-index:2;transition:background .15s,transform .15s;}'
      + '.dip-fechar:hover{background:rgba(0,0,0,.7);transform:rotate(90deg);}'
      + '@media (prefers-reduced-motion:reduce){.dip-card,.dip-card-img,.dip-overlay,.dip-modal{transition:none !important;animation:none !important;}}';
    var style = document.createElement('style');
    style.setAttribute('data-daniel-ia', 'portfolio');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function montarGrelha(){
    var alvo = document.getElementById('daniel-ia-portfolio');
    if (!alvo) {
      console.error('Daniel IA: falta uma div com id="daniel-ia-portfolio" nesta página - os trabalhos não têm onde aparecer.');
      return null;
    }
    alvo.innerHTML = '<div id="dip-grelha" class="dip-grelha"><p class="dip-vazio">' + tx('A carregar trabalhos...') + '</p></div>';
    return document.getElementById('dip-grelha');
  }

  function renderGrelha(trabalhos){
    var grelha = document.getElementById('dip-grelha');
    if (!grelha) return;
    if (!trabalhos || trabalhos.length === 0) {
      if (/[?&]dia_previa=1/.test(window.location.search)) {
        // Pré-visualização (estúdio de layouts): mosaico de exemplo com as cores do site.
        var tons = [14, 26, 8, 20, 32, 11];
        var mosaico = '';
        for (var i = 0; i < 6; i++) {
          mosaico += '<div style="aspect-ratio:4/3;border-radius:var(--dia-raio,12px);background:linear-gradient(' + (130 + i * 40) + 'deg,color-mix(in srgb,var(--dia-primaria,#888) ' + tons[i % 6] + '%,var(--dia-superficie,#fff)),color-mix(in srgb,var(--dia-primaria,#888) ' + (tons[i % 6] + 18) + '%,var(--dia-superficie,#fff)));border:1px solid var(--dia-borda,rgba(0,0,0,.08));"></div>';
        }
        grelha.innerHTML = mosaico + '<p class="dip-vazio" style="grid-column:1/-1;opacity:.75">' + tx('Pré-visualização: os teus trabalhos aparecem aqui.') + '</p>';
        return;
      }
      grelha.innerHTML = '<p class="dip-vazio">' + tx('Ainda não há trabalhos aqui.') + '</p>';
      return;
    }
    grelha.innerHTML = trabalhos.map(function(t){
      var imagem = t.imagem
        ? '<img class="dip-card-img" src="' + escaparAtributo(t.imagem) + '" alt="' + escaparAtributo(t.titulo) + '">'
        : '<div class="dip-card-img dip-card-img-vazia">' + tx('Sem imagem') + '</div>';
      return ''
        + '<div class="dip-card" data-id="' + t.id + '">'
        + imagem
        + '<div class="dip-card-corpo">'
        + '<div class="dip-card-titulo">' + escaparHtml(t.titulo) + '</div>'
        + (t.descricao ? '<div class="dip-card-desc">' + escaparHtml(t.descricao) + '</div>' : '')
        + '</div>'
        + '</div>';
    }).join('');

    grelha.querySelectorAll('.dip-card').forEach(function(cartao){
      cartao.addEventListener('click', function(){
        var trabalho = trabalhosCache.filter(function(t){ return t.id === cartao.getAttribute('data-id'); })[0];
        if (trabalho) abrirTrabalho(trabalho);
      });
    });
  }

  var overlayEl = null;

  function montarOverlay(){
    if (overlayEl) return overlayEl;
    var el = document.createElement('div');
    el.className = 'dip-overlay';
    el.id = 'dip-overlay';
    document.body.appendChild(el);
    overlayEl = el;
    el.addEventListener('click', function(e){
      if (e.target === el) fecharTrabalho();
    });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && overlayEl.classList.contains('dip-aberto')) fecharTrabalho();
    });
    return el;
  }

  function abrirTrabalho(trabalho){
    var el = montarOverlay();
    var imagem = trabalho.imagem
      ? '<img class="dip-modal-img" src="' + escaparAtributo(trabalho.imagem) + '" alt="' + escaparAtributo(trabalho.titulo) + '">'
      : '';
    var link = trabalho.link
      ? '<a class="dip-modal-link" href="' + escaparAtributo(trabalho.link) + '" target="_blank" rel="noopener">' + tx('Ver projecto') + ' &#8594;</a>'
      : '';
    el.innerHTML = ''
      + '<div class="dip-modal">'
      + '<button class="dip-fechar" id="dip-fechar" aria-label="' + tx('Fechar') + '">&times;</button>'
      + imagem
      + '<div class="dip-modal-corpo">'
      + '<div class="dip-modal-titulo">' + escaparHtml(trabalho.titulo) + '</div>'
      + (trabalho.descricao ? '<div class="dip-modal-desc">' + escaparHtml(trabalho.descricao) + '</div>' : '')
      + link
      + '</div>'
      + '</div>';
    document.getElementById('dip-fechar').addEventListener('click', fecharTrabalho);
    el.classList.add('dip-aberto');
    document.body.style.overflow = 'hidden';
  }

  function fecharTrabalho(){
    if (!overlayEl) return;
    overlayEl.classList.remove('dip-aberto');
    document.body.style.overflow = '';
  }

  function iniciar(){
    injectarEstilos();
    if (!montarGrelha()) return;

    fetch(CONTAINER_URL + '/portfolio-trabalhos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: SITE_ID })
    }).then(function(r){ return r.json(); })
      .then(function(r){
        if (r.status === 'success') {
          trabalhosCache = r.response.trabalhos || [];
          renderGrelha(trabalhosCache);
        } else {
          var grelha = document.getElementById('dip-grelha');
          if (grelha) grelha.innerHTML = '<p class="dip-vazio">' + tx('Não foi possível carregar os trabalhos.') + '</p>';
        }
      })
      .catch(function(){
        var grelha = document.getElementById('dip-grelha');
        if (grelha) grelha.innerHTML = '<p class="dip-vazio">' + tx('Não foi possível ligar ao servidor.') + '</p>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
`;

// ======================================================
// Script fixo do visualizador do Blog, servido directamente
// ======================================================
// Guardado aqui como texto para ser servido por /blog-viewer.js. É este
// ficheiro que todos os sites de Blog gerados carregam - nunca é a IA a
// escrever esta lógica. Mesmo padrão do Portefólio: grelha de cartões
// (imagem, data, título, resumo) e, ao clicar, um "artigo" num overlay
// com a imagem grande e o conteúdo completo.
const BLOG_VIEWER_JS = `/*
  Daniel IA - módulo fixo do Blog (grelha de artigos)
  ---------------------------------------------------------------------
  Este ficheiro é servido pelo próprio container em /blog-viewer.js e é
  carregado por TODOS os sites de Blog gerados pela IA. A IA nunca
  escreve esta lógica - só desenha a aparência do site e deixa uma div
  com id="daniel-ia-blog" onde este módulo mostra os artigos a sério.

  Cada página gerada define, antes de carregar este ficheiro:
    window.DANIEL_IA_SITE_ID = 'xxxxx';
*/
(function(){
  'use strict';

  // ---- Idioma do site (lido do <html lang>): pt, en, fr ou es ----
  var DIA_LANG = (function(){
    var l = String(document.documentElement.getAttribute('lang') || 'pt').toLowerCase().slice(0, 2);
    return (l === 'en' || l === 'fr' || l === 'es') ? l : 'pt';
  })();
  var DIA_LOCALE = { pt: 'pt-PT', en: 'en-GB', fr: 'fr-FR', es: 'es-ES' }[DIA_LANG];
  var DIA_TXT = {"en": {"A carregar artigos...": "Loading articles...", "Ainda não há artigos aqui.": "No articles here yet.", "Não foi possível carregar os artigos.": "Could not load the articles.", "Sem imagem": "No image", "Fechar": "Close", "Não foi possível ligar ao servidor.": "Could not connect to the server.", "Pré-visualização: os teus artigos aparecem aqui.": "Preview: your articles will appear here."}, "fr": {"A carregar artigos...": "Chargement des articles...", "Ainda não há artigos aqui.": "Aucun article pour le moment.", "Não foi possível carregar os artigos.": "Impossible de charger les articles.", "Sem imagem": "Pas d'image", "Fechar": "Fermer", "Não foi possível ligar ao servidor.": "Impossible de se connecter au serveur.", "Pré-visualização: os teus artigos aparecem aqui.": "Aperçu : vos articles apparaîtront ici."}, "es": {"A carregar artigos...": "Cargando artículos...", "Ainda não há artigos aqui.": "Todavía no hay artículos.", "Não foi possível carregar os artigos.": "No se pudieron cargar los artículos.", "Sem imagem": "Sin imagen", "Fechar": "Cerrar", "Não foi possível ligar ao servidor.": "No se pudo conectar con el servidor.", "Pré-visualização: os teus artigos aparecem aqui.": "Vista previa: tus artículos aparecerán aquí."}};
  function tx(s, v){
    var d = DIA_TXT[DIA_LANG];
    var r = (d && d[s]) || s;
    if (v) { for (var k in v) { r = r.split('{' + k + '}').join(String(v[k])); } }
    return r;
  }

  var CONTAINER_URL = 'https://mc-8oxfde5o71.bunny.run';
  var SITE_ID = window.DANIEL_IA_SITE_ID || '';

  if (!SITE_ID) {
    console.error('Daniel IA: falta window.DANIEL_IA_SITE_ID nesta página - o blog não pode arrancar.');
    return;
  }

  var postsCache = [];

  function escaparHtml(t){
    var d = document.createElement('div');
    d.textContent = (t == null ? '' : String(t));
    return d.innerHTML;
  }
  function escaparAtributo(t){
    return escaparHtml(t).replace(/"/g, '&quot;');
  }
  function formatarData(iso){
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString(DIA_LOCALE, { day: '2-digit', month: 'long', year: 'numeric' });
    } catch (e) { return ''; }
  }

  function injectarEstilos(){
    var css = ''
      + '.dib-grelha{--_s:var(--dia-superficie,color-mix(in srgb,currentColor 5%,transparent));--_t:var(--dia-texto,currentColor);--_ts:var(--dia-texto-suave,color-mix(in srgb,currentColor 62%,transparent));--_b:var(--dia-borda,color-mix(in srgb,currentColor 13%,transparent));--_r:var(--dia-raio,14px);--_ft:var(--dia-fonte-titulos,inherit);display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px;margin:0;padding:0;}'
      + '.dib-card{cursor:pointer;border-radius:var(--_r);overflow:hidden;background:var(--_s);border:1px solid var(--_b);color:var(--_t);font-family:inherit;transition:transform .35s cubic-bezier(.2,.8,.2,1),box-shadow .35s ease,border-color .35s ease;}'
      + '.dib-card:hover{transform:translateY(-5px);box-shadow:0 26px 50px -24px rgba(0,0,0,.5);border-color:color-mix(in srgb,currentColor 24%,transparent);}'
      + '.dib-card-img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:color-mix(in srgb,currentColor 8%,transparent);transition:transform .7s cubic-bezier(.2,.8,.2,1);}'
      + '.dib-card:hover .dib-card-img{transform:scale(1.06);}'
      + '.dib-card-img-vazia{display:flex;align-items:center;justify-content:center;color:var(--_ts);font-size:13px;}'
      + '.dib-card-corpo{padding:20px;}'
      + '.dib-card-data{font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--_ts);margin-bottom:8px;}'
      + '.dib-card-titulo{font-family:var(--_ft);font-weight:800;font-size:18px;line-height:1.3;letter-spacing:-.015em;margin-bottom:8px;color:var(--_t);}'
      + '.dib-card-resumo{font-size:13.5px;color:var(--_ts);line-height:1.6;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}'
      + '.dib-vazio{color:var(--_ts);font-size:13px;}'
      + '.dib-overlay{--_f:var(--dia-fundo,#121218);--_t:var(--dia-texto,#fff);--_ts:var(--dia-texto-suave,rgba(255,255,255,.72));--_r:var(--dia-raio,14px);--_ft:var(--dia-fonte-titulos,inherit);--_p:var(--dia-primaria,#fff);position:fixed;inset:0;background:rgba(6,6,10,.75);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);z-index:100000;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow-y:auto;opacity:0;pointer-events:none;transition:opacity .25s ease;font-family:inherit;}'
      + '.dib-overlay.dib-aberto{opacity:1;pointer-events:auto;}'
      + '.dib-artigo{background:var(--_f);color:var(--_t);border-radius:calc(var(--_r) + 8px);max-width:740px;width:100%;position:relative;transform:translateY(16px);opacity:0;transition:opacity .3s ease,transform .3s cubic-bezier(.2,.8,.2,1);margin-bottom:40px;box-shadow:0 40px 90px rgba(0,0,0,.5);}'
      + '.dib-overlay.dib-aberto .dib-artigo{transform:none;opacity:1;}'
      + '.dib-artigo-img{width:100%;max-height:400px;object-fit:cover;display:block;background:color-mix(in srgb,var(--_t) 8%,transparent);border-radius:calc(var(--_r) + 8px) calc(var(--_r) + 8px) 0 0;}'
      + '.dib-artigo-corpo{padding:34px 34px 40px;}'
      + '.dib-artigo-data{font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--_ts);margin-bottom:12px;}'
      + '.dib-artigo-titulo{font-family:var(--_ft);font-weight:800;font-size:clamp(24px,4vw,32px);color:var(--_t);margin-bottom:20px;line-height:1.2;letter-spacing:-.02em;}'
      + '.dib-artigo-conteudo{font-size:16px;color:var(--_ts);line-height:1.85;white-space:pre-wrap;}'
      + '.dib-fechar{position:absolute;top:14px;right:14px;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.18);color:#fff;font-size:20px;line-height:1;width:38px;height:38px;border-radius:50%;cursor:pointer;z-index:2;transition:background .15s,transform .15s;}'
      + '.dib-fechar:hover{background:rgba(0,0,0,.7);transform:rotate(90deg);}'
      + '@media(max-width:640px){.dib-artigo-corpo{padding:24px 20px 30px;}}'
      + '@media (prefers-reduced-motion:reduce){.dib-card,.dib-card-img,.dib-overlay,.dib-artigo{transition:none !important;animation:none !important;}}';
    var style = document.createElement('style');
    style.setAttribute('data-daniel-ia', 'blog');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function montarGrelha(){
    var alvo = document.getElementById('daniel-ia-blog');
    if (!alvo) {
      console.error('Daniel IA: falta uma div com id="daniel-ia-blog" nesta página - os artigos não têm onde aparecer.');
      return null;
    }
    alvo.innerHTML = '<div id="dib-grelha" class="dib-grelha"><p class="dib-vazio">' + tx('A carregar artigos...') + '</p></div>';
    return document.getElementById('dib-grelha');
  }

  function renderGrelha(posts){
    var grelha = document.getElementById('dib-grelha');
    if (!grelha) return;
    if (!posts || posts.length === 0) {
      if (/[?&]dia_previa=1/.test(window.location.search)) {
        // Pré-visualização (estúdio de layouts): mosaico de exemplo com as cores do site.
        var tons = [14, 26, 8, 20, 32, 11];
        var mosaico = '';
        for (var i = 0; i < 3; i++) {
          mosaico += '<div style="aspect-ratio:16/10;border-radius:var(--dia-raio,12px);background:linear-gradient(' + (130 + i * 40) + 'deg,color-mix(in srgb,var(--dia-primaria,#888) ' + tons[i % 6] + '%,var(--dia-superficie,#fff)),color-mix(in srgb,var(--dia-primaria,#888) ' + (tons[i % 6] + 18) + '%,var(--dia-superficie,#fff)));border:1px solid var(--dia-borda,rgba(0,0,0,.08));"></div>';
        }
        grelha.innerHTML = mosaico + '<p class="dib-vazio" style="grid-column:1/-1;opacity:.75">' + tx('Pré-visualização: os teus artigos aparecem aqui.') + '</p>';
        return;
      }
      grelha.innerHTML = '<p class="dib-vazio">' + tx('Ainda não há artigos aqui.') + '</p>';
      return;
    }
    grelha.innerHTML = posts.map(function(p){
      var imagem = p.imagem
        ? '<img class="dib-card-img" src="' + escaparAtributo(p.imagem) + '" alt="' + escaparAtributo(p.titulo) + '">'
        : '<div class="dib-card-img dib-card-img-vazia">' + tx('Sem imagem') + '</div>';
      var dataFormatada = formatarData(p.data);
      return ''
        + '<div class="dib-card" data-id="' + p.id + '">'
        + imagem
        + '<div class="dib-card-corpo">'
        + (dataFormatada ? '<div class="dib-card-data">' + escaparHtml(dataFormatada) + '</div>' : '')
        + '<div class="dib-card-titulo">' + escaparHtml(p.titulo) + '</div>'
        + (p.resumo ? '<div class="dib-card-resumo">' + escaparHtml(p.resumo) + '</div>' : '')
        + '</div>'
        + '</div>';
    }).join('');

    grelha.querySelectorAll('.dib-card').forEach(function(cartao){
      cartao.addEventListener('click', function(){
        var post = postsCache.filter(function(p){ return p.id === cartao.getAttribute('data-id'); })[0];
        if (post) abrirArtigo(post);
      });
    });
  }

  var overlayEl = null;

  function montarOverlay(){
    if (overlayEl) return overlayEl;
    var el = document.createElement('div');
    el.className = 'dib-overlay';
    el.id = 'dib-overlay';
    document.body.appendChild(el);
    overlayEl = el;
    el.addEventListener('click', function(e){
      if (e.target === el) fecharArtigo();
    });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && overlayEl.classList.contains('dib-aberto')) fecharArtigo();
    });
    return el;
  }

  function abrirArtigo(post){
    var el = montarOverlay();
    var imagem = post.imagem
      ? '<img class="dib-artigo-img" src="' + escaparAtributo(post.imagem) + '" alt="' + escaparAtributo(post.titulo) + '">'
      : '';
    var dataFormatada = formatarData(post.data);
    el.innerHTML = ''
      + '<div class="dib-artigo">'
      + '<button class="dib-fechar" id="dib-fechar" aria-label="' + tx('Fechar') + '">&times;</button>'
      + imagem
      + '<div class="dib-artigo-corpo">'
      + (dataFormatada ? '<div class="dib-artigo-data">' + escaparHtml(dataFormatada) + '</div>' : '')
      + '<div class="dib-artigo-titulo">' + escaparHtml(post.titulo) + '</div>'
      + '<div class="dib-artigo-conteudo">' + escaparHtml(post.conteudo || post.resumo || '') + '</div>'
      + '</div>'
      + '</div>';
    document.getElementById('dib-fechar').addEventListener('click', fecharArtigo);
    el.classList.add('dib-aberto');
    el.scrollTop = 0;
    document.body.style.overflow = 'hidden';
  }

  function fecharArtigo(){
    if (!overlayEl) return;
    overlayEl.classList.remove('dib-aberto');
    document.body.style.overflow = '';
  }

  function iniciar(){
    injectarEstilos();
    if (!montarGrelha()) return;

    fetch(CONTAINER_URL + '/blog-posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: SITE_ID })
    }).then(function(r){ return r.json(); })
      .then(function(r){
        if (r.status === 'success') {
          postsCache = r.response.posts || [];
          renderGrelha(postsCache);
        } else {
          var grelha = document.getElementById('dib-grelha');
          if (grelha) grelha.innerHTML = '<p class="dib-vazio">' + tx('Não foi possível carregar os artigos.') + '</p>';
        }
      })
      .catch(function(){
        var grelha = document.getElementById('dib-grelha');
        if (grelha) grelha.innerHTML = '<p class="dib-vazio">' + tx('Não foi possível ligar ao servidor.') + '</p>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
`;

// Módulo fixo do Formulário de Contacto - ao contrário dos outros
// módulos (loja/galeria/portefólio/blog), este é injectado em TODOS os
// sites gerados, seja qual for o tipo (ver injectarContactoSeNecessario
// mais acima). A IA nunca escreve este formulário - só deixa a div
// com id="daniel-ia-contacto" onde este módulo o desenha a sério.
const CONTACTO_FORM_JS = `/*
  Daniel IA - módulo fixo do Formulário de Contacto
  (1.59.0: compacto - uma linha com um botão; o formulário abre ao carregar)
  ---------------------------------------------------------------------
  Este ficheiro é servido pelo próprio container em /contacto-form.js e
  é carregado por TODOS os sites gerados pela IA, seja qual for o tipo.
  A IA nunca escreve este formulário - só deixa uma div com
  id="daniel-ia-contacto" onde este módulo desenha o formulário a sério
  e trata do envio.

  Cada página gerada define, antes de carregar este ficheiro:
    window.DANIEL_IA_SITE_ID = 'xxxxx';
*/
(function(){
  'use strict';

  // ---- Idioma do site (lido do <html lang>): pt, en, fr ou es ----
  var DIA_LANG = (function(){
    var l = String(document.documentElement.getAttribute('lang') || 'pt').toLowerCase().slice(0, 2);
    return (l === 'en' || l === 'fr' || l === 'es') ? l : 'pt';
  })();
  var DIA_LOCALE = { pt: 'pt-PT', en: 'en-GB', fr: 'fr-FR', es: 'es-ES' }[DIA_LANG];
  var DIA_TXT = {"en": {"Fale connosco": "Get in touch", "Preenche o formulário e entraremos em contacto.": "Fill in the form and we'll get back to you.", "Nome": "Name", "Email": "Email", "Mensagem": "Message", "Enviar mensagem": "Send message", "Preenche todos os campos.": "Please fill in all fields.", "Introduz um email válido.": "Please enter a valid email.", "A enviar...": "Sending...", "Mensagem enviada. Entraremos em contacto em breve.": "Message sent. We'll be in touch soon.", "Não foi possível enviar a mensagem.": "Could not send the message.", "Não foi possível ligar ao servidor.": "Could not connect to the server.", "Tens alguma pergunta?": "Have a question?", "Escreve-nos e respondemos por email.": "Write to us and we'll reply by email.", "O teu nome": "Your name", "O teu email": "Your email", "A tua mensagem": "Your message", "Fechar": "Close"}, "fr": {"Fale connosco": "Contactez-nous", "Preenche o formulário e entraremos em contacto.": "Remplissez le formulaire et nous vous recontacterons.", "Nome": "Nom", "Email": "E-mail", "Mensagem": "Message", "Enviar mensagem": "Envoyer le message", "Preenche todos os campos.": "Veuillez remplir tous les champs.", "Introduz um email válido.": "Veuillez saisir une adresse e-mail valide.", "A enviar...": "Envoi en cours...", "Mensagem enviada. Entraremos em contacto em breve.": "Message envoyé. Nous vous répondrons bientôt.", "Não foi possível enviar a mensagem.": "Impossible d'envoyer le message.", "Não foi possível ligar ao servidor.": "Impossible de se connecter au serveur.", "Tens alguma pergunta?": "Une question ?", "Escreve-nos e respondemos por email.": "Écrivez-nous, nous répondrons par e-mail.", "O teu nome": "Votre nom", "O teu email": "Votre e-mail", "A tua mensagem": "Votre message", "Fechar": "Fermer"}, "es": {"Fale connosco": "Contáctanos", "Preenche o formulário e entraremos em contacto.": "Rellena el formulario y te contactaremos.", "Nome": "Nombre", "Email": "Correo", "Mensagem": "Mensaje", "Enviar mensagem": "Enviar mensaje", "Preenche todos os campos.": "Rellena todos los campos.", "Introduz um email válido.": "Introduce un correo válido.", "A enviar...": "Enviando...", "Mensagem enviada. Entraremos em contacto em breve.": "Mensaje enviado. Te responderemos pronto.", "Não foi possível enviar a mensagem.": "No se pudo enviar el mensaje.", "Não foi possível ligar ao servidor.": "No se pudo conectar con el servidor.", "Tens alguma pergunta?": "¿Tienes alguna pregunta?", "Escreve-nos e respondemos por email.": "Escríbenos y te respondemos por correo.", "O teu nome": "Tu nombre", "O teu email": "Tu correo", "A tua mensagem": "Tu mensaje", "Fechar": "Cerrar"}};
  function tx(s, v){
    var d = DIA_TXT[DIA_LANG];
    var r = (d && d[s]) || s;
    if (v) { for (var k in v) { r = r.split('{' + k + '}').join(String(v[k])); } }
    return r;
  }

  var CONTAINER_URL = 'https://mc-8oxfde5o71.bunny.run';
  var SITE_ID = window.DANIEL_IA_SITE_ID || '';

  if (!SITE_ID) {
    console.error('Daniel IA: falta window.DANIEL_IA_SITE_ID nesta página - o formulário de contacto não pode arrancar.');
    return;
  }

  function injectarEstilos(){
    var css = ''
      + '.dic-caixa{--_s:var(--dia-superficie,color-mix(in srgb,currentColor 5%,transparent));--_t:var(--dia-texto,currentColor);--_ts:var(--dia-texto-suave,color-mix(in srgb,currentColor 62%,transparent));--_b:var(--dia-borda,color-mix(in srgb,currentColor 13%,transparent));--_r:var(--dia-raio,14px);--_p:var(--dia-primaria,currentColor);width:100%;margin:0;background:var(--_s);border:1px solid var(--_b);border-radius:calc(var(--_r) + 4px);padding:14px 16px;color:var(--_t);font-family:inherit;box-sizing:border-box;}'
      + '.dic-caixa *{box-sizing:border-box;}'
      + '.dic-barra{display:flex;align-items:center;gap:14px;flex-wrap:wrap;}'
      + '.dic-ic{width:40px;height:40px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--_p) 14%,transparent);color:var(--_p);}'
      + '.dic-ic svg{width:19px;height:19px;}'
      + '.dic-txt{flex:1;min-width:170px;line-height:1.35;}'
      + '.dic-txt b{display:block;font-size:15px;color:var(--_t);}'
      + '.dic-txt span{display:block;font-size:13px;color:var(--_ts);}'
      + '.dic-abrir{display:inline-flex;align-items:center;gap:8px;background:var(--dia-primaria,transparent);color:var(--dia-primaria-texto,currentColor);border:none;border-radius:999px;padding:11px 18px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;min-height:44px;box-shadow:inset 0 0 0 1.5px var(--_p);transition:filter .15s ease;}'
      + '.dic-abrir:hover{filter:brightness(1.1);}'
      + '.dic-aberta .dic-abrir{background:transparent;color:var(--_t);box-shadow:inset 0 0 0 1px var(--_b);}'
      + '.dic-pagina .dic-abrir{display:none;}.dic-pagina{padding:clamp(18px,3vw,28px);}.dic-pagina .dic-txt b{font-size:18px;}'
      + '#dic-form{display:none;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid var(--_b);}'
      + '.dic-aberta #dic-form{display:grid;}'
      + '.dic-input,.dic-textarea{width:100%;background:color-mix(in srgb,currentColor 4%,transparent);border:1px solid var(--_b);border-radius:calc(var(--_r) - 4px);padding:11px 13px;color:var(--_t);font-size:16px;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s;}'
      + '.dic-input:focus,.dic-textarea:focus{border-color:var(--_p);box-shadow:0 0 0 3px color-mix(in srgb,var(--_p) 22%,transparent);}'
      + '.dic-textarea{grid-column:1/-1;resize:vertical;min-height:84px;}'
      + '.dic-fim{grid-column:1/-1;display:flex;align-items:center;gap:12px;flex-wrap:wrap;}'
      + '.dic-botao{display:inline-flex;align-items:center;justify-content:center;background:var(--dia-primaria,transparent);color:var(--dia-primaria-texto,currentColor);border:none;border-radius:999px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;min-height:44px;box-shadow:inset 0 0 0 1.5px var(--_p);}'
      + '.dic-botao:disabled{opacity:.6;cursor:default;}'
      + '.dic-msg{font-size:13.5px;padding:9px 12px;border-radius:calc(var(--_r) - 4px);display:none;line-height:1.45;flex:1;min-width:180px;}'
      + '.dic-msg.dic-sucesso{display:block;background:rgba(122,196,35,.12);color:inherit;border:1px solid rgba(122,196,35,.4);}'
      + '.dic-msg.dic-erro{display:block;background:rgba(214,69,69,.1);color:inherit;border:1px solid rgba(214,69,69,.4);}'
      + '.dic-oculto{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}'
      + '@media (max-width:560px){#dic-form{grid-template-columns:1fr;}.dic-abrir{width:100%;justify-content:center;}}'
      + '@media (prefers-reduced-motion:reduce){.dic-input,.dic-textarea,.dic-botao,.dic-abrir{transition:none !important;}}';
    var style = document.createElement('style');
    style.setAttribute('data-daniel-ia', 'contacto');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function montarFormulario(){
    var alvo = document.getElementById('daniel-ia-contacto');
    if (!alvo) {
      console.error('Daniel IA: falta uma div com id="daniel-ia-contacto" nesta página - o formulário não tem onde aparecer.');
      return null;
    }
    alvo.innerHTML = ''
      + '<div class="dic-caixa" id="dic-caixa">'
      + '<div class="dic-barra"><span class="dic-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg></span>'
      + '<div class="dic-txt"><b>' + tx('Tens alguma pergunta?') + '</b><span>' + tx('Escreve-nos e respondemos por email.') + '</span></div>'
      + '<button type="button" class="dic-abrir" id="dic-abrir" aria-expanded="false" aria-controls="dic-form">' + tx('Enviar mensagem') + '</button></div>'
      + '<form id="dic-form">'
      + '<label class="dic-oculto" for="dic-nome">' + tx('Nome') + '</label>'
      + '<input class="dic-input" id="dic-nome" name="nome" type="text" required maxlength="120" placeholder="' + tx('O teu nome') + '" autocomplete="name">'
      + '<label class="dic-oculto" for="dic-email">' + tx('Email') + '</label>'
      + '<input class="dic-input" id="dic-email" name="email" type="email" required maxlength="160" placeholder="' + tx('O teu email') + '" autocomplete="email">'
      + '<label class="dic-oculto" for="dic-mensagem">' + tx('Mensagem') + '</label>'
      + '<textarea class="dic-textarea" id="dic-mensagem" name="mensagem" required maxlength="2000" rows="3" placeholder="' + tx('A tua mensagem') + '"></textarea>'
      + '<div class="dic-fim"><button class="dic-botao" id="dic-enviar" type="submit">' + tx('Enviar mensagem') + '</button><div class="dic-msg" id="dic-msg"></div></div>'
      + '</form>'
      + '</div>';
    var caixa = document.getElementById('dic-caixa'), abrir = document.getElementById('dic-abrir');
    abrir.addEventListener('click', function(){
      var aberta = !caixa.classList.contains('dic-aberta');
      caixa.classList.toggle('dic-aberta', aberta);
      abrir.setAttribute('aria-expanded', aberta ? 'true' : 'false');
      abrir.textContent = aberta ? tx('Fechar') : tx('Enviar mensagem');
      if (aberta) document.getElementById('dic-nome').focus();
    });
    // Página de contacto (sites com várias páginas): o formulário já vem aberto.
    var meta = document.querySelector('meta[name="daniel-ia-pagina"]');
    if ((meta && meta.getAttribute('content') === 'contacto') || alvo.hasAttribute('data-aberto')) {
      caixa.classList.add('dic-aberta', 'dic-pagina');
      document.getElementById('dic-mensagem').setAttribute('rows', '6');
    }
    return document.getElementById('dic-form');
  }

  function mostrarMensagem(tipo, texto){
    var msg = document.getElementById('dic-msg');
    if (!msg) return;
    if (!tipo) {
      msg.style.display = 'none';
      msg.className = 'dic-msg';
      return;
    }
    msg.className = 'dic-msg dic-' + tipo;
    msg.textContent = texto;
    msg.style.display = 'block';
  }

  // Validação simples sem expressões regulares (mais fácil de confirmar
  // que está correcta à vista): tem de haver um "@" que não seja o
  // primeiro carácter, e depois dele um "." mais à frente, sem espaços.
  function validarEmail(email){
    if (!email || email.indexOf(' ') !== -1) return false;
    var pos = email.indexOf('@');
    if (pos < 1 || pos !== email.lastIndexOf('@')) return false;
    var resto = email.slice(pos + 1);
    return resto.indexOf('.') > 0 && resto.lastIndexOf('.') < resto.length - 1;
  }

  function iniciar(){
    injectarEstilos();
    var form = montarFormulario();
    if (!form) return;

    form.addEventListener('submit', function(e){
      e.preventDefault();
      var nome = document.getElementById('dic-nome').value.trim();
      var email = document.getElementById('dic-email').value.trim();
      var mensagem = document.getElementById('dic-mensagem').value.trim();
      var botao = document.getElementById('dic-enviar');

      if (!nome || !email || !mensagem) {
        mostrarMensagem('erro', tx('Preenche todos os campos.'));
        return;
      }
      if (!validarEmail(email)) {
        mostrarMensagem('erro', tx('Introduz um email válido.'));
        return;
      }

      botao.disabled = true;
      botao.textContent = tx('A enviar...');
      mostrarMensagem('', '');

      fetch(CONTAINER_URL + '/contacto-enviar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: SITE_ID, nome: nome, email_remetente: email, mensagem: mensagem })
      }).then(function(r){ return r.json(); })
        .then(function(r){
          botao.disabled = false;
          botao.textContent = tx('Enviar mensagem');
          if (r.status === 'success') {
            mostrarMensagem('sucesso', tx('Mensagem enviada. Entraremos em contacto em breve.'));
            form.reset();
          } else {
            mostrarMensagem('erro', ((DIA_LANG === 'pt' && r.message) || tx('Não foi possível enviar a mensagem.')));
          }
        })
        .catch(function(){
          botao.disabled = false;
          botao.textContent = tx('Enviar mensagem');
          mostrarMensagem('erro', tx('Não foi possível ligar ao servidor.'));
        });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
`;

// ======================================================
// Rotas
// ======================================================

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'daniel-ia-proxy',
    version: VERSION,
    time: new Date().toISOString()
  });
});

// Serve o módulo fixo da loja. Cacheável por pouco tempo, para podermos
// corrigir ou melhorar o carrinho/checkout para TODOS os sites de uma só
// vez, sem precisar de regenerar nada.
app.get('/loja-cart.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  return res.send(LOJA_CART_JS);
});

// Serve o módulo fixo da Galeria (álbuns + visualizador). Mesmo princípio
// do /loja-cart.js acima.
app.get('/galeria-viewer.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  return res.send(GALERIA_VIEWER_JS);
});

// Serve o módulo fixo do Portefólio (grelha de trabalhos). Mesmo
// princípio do /loja-cart.js acima.
app.get('/portfolio-viewer.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  return res.send(PORTFOLIO_VIEWER_JS);
});

// Serve o módulo fixo do Blog (grelha de artigos). Mesmo princípio do
// /loja-cart.js acima.
app.get('/blog-viewer.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  return res.send(BLOG_VIEWER_JS);
});

// Serve o módulo fixo do Formulário de Contacto. Ao contrário dos outros,
// este carrega em TODOS os sites gerados (ver injectarContactoSeNecessario).
app.get('/contacto-form.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  return res.send(CONTACTO_FORM_JS);
});

// Nota sobre os nomes dos campos nas chamadas ao Bubble: têm de ser
// EXACTAMENTE como aparecem no editor do Bubble (maiúsculas e espaços
// incluídos) - a Data API não os converte para minúsculas.

app.post('/generate', async (req, res) => {
  try {
    const { owner, nome, tipo, prompt, logo_data_url, imagens_data_url } = req.body;
    const idioma = normalizarIdioma(req.body.idioma);

    if (!owner || !nome || !tipo || !prompt) {
      return res.json({ status: 'error', message: 'Faltam dados: nome, tipo e prompt são obrigatórios.' });
    }
    // Imagem de referência (opcional): criar parecido com ela.
    const referencia_data_url = req.body.referencia_data_url ? String(req.body.referencia_data_url) : '';
    // Quiz antes do checkout (só lojas e páginas de venda).
    const quizPedido = (tipo === 'Checkout' || tipo === 'E-commerce') && req.body.quiz && req.body.quiz.ativo === true
      ? { descricao: textoCurto(req.body.quiz.descricao, 800) } : null;
    // Por omissão os sites têm várias páginas; "uma página só" é escolha da pessoa.
    const umaPagina = req.body.uma_pagina === true;
    if (referencia_data_url && !referenciaValida(referencia_data_url)) {
      return res.json({ status: 'error', message: 'A imagem de referência não é válida. Usa um JPG, PNG ou WEBP com menos de 6 MB.' });
    }

    // ---- 1. Carregar utilizador e plano ----
    const user = await bubbleGet('user', owner);
    if (!user) {
      return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    }

    const planId = await garantirPlano(owner, user);
    if (!planId) {
      return res.json({ status: 'error', message: 'A tua conta não tem nenhum plano atribuído, e não encontrei nenhum plano Free para atribuir automaticamente.' });
    }
    const plano = await bubbleGet('plan', planId);
    const mostrarMarcaDeAgua = String(plano['Name'] || '').trim().toLowerCase() === 'free';

    // ---- 2. Verificar limite de projectos ----
    const sitesExistentes = await bubbleCount('site', [{ key: 'Owner', constraint_type: 'equals', value: owner }]);
    if (sitesExistentes >= (plano['Sites Limit'] || 0)) {
      return res.json({ status: 'error', message: `O teu plano "${plano['Name']}" permite até ${plano['Sites Limit']} projecto(s). Já atingiste esse limite.` });
    }

    // ---- 3. Verificar limite de tokens do mês ----
    const tokensUsados = user['Tokens Usados Mes'] || 0;
    const tokensIncluidos = plano['Tokens Incluidos'] || 0;
    if (semTokens(user, plano)) {
      return res.json({ status: 'error', codigo: 'tokens', message: MSG_SEM_TOKENS });
    }

    // ---- 4. Registar já o Site e a Generation, com estado "A gerar" ----
    // Respondemos de imediato à página - o trabalho pesado (OpenAI + upload)
    // corre a seguir, em segundo plano, porque demora mais do que o tempo
    // que o Bunny deixa um pedido ficar à espera (daí o 504 que estávamos a ver).
    const siteId = await bubbleCreate('site', {
      'Owner': owner,
      'Nome': nome,
      'Tipo': tipo,
      'Prompt Original': prompt,
      'Status': 'A gerar',
      'Created Date': new Date().toISOString()
    });

    const generationId = await bubbleCreate('generation', {
      'Site': siteId,
      'Prompt': prompt,
      'Status': 'A gerar',
      'Tentativas': 1,
      'Created Date': new Date().toISOString()
    });

    const variantes = Number(req.body.variantes) === 3 ? 3 : 1;
    res.json({
      status: 'success',
      response: { site_id: siteId, generation_id: generationId, variantes }
    });

    // ---- 5. Trabalho pesado, sem bloquear a resposta ----
    if (variantes === 3) {
      processarVariantes({ owner, nome, tipo, prompt, logo_data_url, imagens_data_url, referencia_data_url, siteId, generationId, mostrarMarcaDeAgua, idioma, quiz: quizPedido, pago: !mostrarMarcaDeAgua, umaPagina })
        .catch(erro => console.error('Erro em processarVariantes:', erro));
      return;
    }
    processarGeracao({ owner, nome, tipo, prompt, logo_data_url, imagens_data_url, referencia_data_url, siteId, generationId, tokensUsados, mostrarMarcaDeAgua, idioma, quiz: quizPedido, pago: !mostrarMarcaDeAgua, umaPagina })
      .catch(erro => console.error('Erro em processarGeracao:', erro));

  } catch (erro) {
    console.error('Erro em /generate:', erro);
    return res.json({ status: 'error', message: 'Não foi possível iniciar a geração. Tenta novamente.' });
  }
});


// Guarda o estado das 3 versões no Site ('Variantes Json'), um pedido de
// cada vez por site (as 3 gerações acabam em alturas diferentes).
const filaVariantes = new Map();
function guardarVariantes(siteId, estado) {
  const anterior = filaVariantes.get(siteId) || Promise.resolve();
  const proximo = anterior.catch(() => {}).then(async () => {
    // Junta o que outras partes já escreveram (versão escolhida, páginas).
    const site = await bubbleGet('site', siteId).catch(() => null);
    const actual = lerJsonSeguro(site && site['Variantes Json'], null);
    const final = Object.assign({}, estado);
    if (actual && actual.slug === estado.slug) {
      if (actual.escolhida) final.escolhida = actual.escolhida;
      if (actual.cobrado) final.cobrado = true;
      if (actual.paginas) final.paginas = actual.paginas;
    }
    return bubblePatch('site', siteId, { 'Variantes Json': JSON.stringify(final) });
  })
    .catch(erro => console.error('Não foi possível guardar as variantes:', erro.message || erro));
  filaVariantes.set(siteId, proximo);
  return proximo;
}

async function processarVariantes({ owner, nome, tipo, prompt, logo_data_url, imagens_data_url, referencia_data_url, siteId, generationId, mostrarMarcaDeAgua, idioma, manterSite, logoExistente, quiz, pago, umaPagina }) {
  const slug = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const comReferencia = !!referencia_data_url;
  const direcoes = comReferencia ? direcoesDaReferencia(tipo, null) : escolherDirecoes(tipo);
  let tokensReferencia = 0;
  // Mudar de layout: reaproveita as páginas, as fotos e o quiz do site.
  const siteAntes = manterSite ? await bubbleGet('site', siteId).catch(() => null) : null;
  const anterior = siteAntes ? (lerJsonSeguro(siteAntes['Variantes Json'], {}) || {}) : null;
  const quizAntes = siteAntes ? quizDoSite(siteAntes) : null;
  let quizAtivo = !!(quizAntes && quizAntes.ativo);
  const estado = {
    slug, logo: logoExistente || '', generation_id: generationId, escolhida: null, inicio: new Date().toISOString(),
    modo: manterSite ? 'mudar' : 'criar', cobrado: false,
    variantes: direcoes.map((d, i) => ({
      n: i + 1, estado: 'a gerar', caminho: '', url: '', tokens: 0,
      direcao: { id: d.id, nome: d.nome, resumo: d.resumo, familia: d.familia, tema: d.tema || '' }, paleta: [], fontes: [], segundos: 0
    }))
  };
  if (comReferencia) estado.referencia = { estado: 'a analisar', resumo: '' };
  if (anterior && anterior.paginas) estado.paginas = anterior.paginas;
  estado.preparacao = 'a preparar';
  try {
    // Logótipo e imagens: carregados uma vez só, para as 3 versões.
    if (logo_data_url) {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(logo_data_url);
      if (match) {
        const buffer = Buffer.from(match[2], 'base64');
        const espacoLogo = await verificarEspaco(owner, buffer.length);
        if (espacoLogo.ok) {
          const extensao = match[1].split('/')[1].replace('+xml', '').replace('jpeg', 'jpg');
          estado.logo = await uploadParaBunny(`logos/${owner}-${Date.now()}.${extensao}`, buffer, match[1]);
          await somarEspacoUsado(owner, buffer.length);
        }
      }
    }
    let imagensUrls = [];
    if (imagens_data_url && imagens_data_url.length) {
      const r = await uploadMultiplasImagensBase64('imagens-pedido', owner, imagens_data_url);
      if (r.erro) throw new Error('Não foi possível enviar as imagens anexadas: ' + r.erro);
      imagensUrls = r.urls;
    }
    await guardarVariantes(siteId, estado);

    // Preparação, em paralelo e uma vez só para as 3 versões: a imagem de
    // referência, o plano das páginas, as fotografias e o quiz.
    const tarefaReferencia = comReferencia
      ? analisarReferencia(referencia_data_url, tipo).catch(erro => { console.error('Não foi possível estudar a imagem de referência:', erro.message || erro); return null; })
      : Promise.resolve(null);
    const tarefaPlano = (async () => {
      if (anterior && Array.isArray(anterior.plano_paginas) && anterior.plano_paginas.length > 1) {
        return { paginas: anterior.plano_paginas, fotos: anterior.fotos || [], temas: anterior.temas_sugeridos || [], tokens: 0 };
      }
      const plan = await planearSite({ tipo, nome, prompt, idioma, pago: pago !== false, comFotos: true, umaPagina: !!(umaPagina || (anterior && anterior.uma_pagina)) });
      const fts = await prepararFotos({ owner, slug, pedidos: plan.fotos });
      return { paginas: plan.paginas, fotos: fts.fotos, temas: plan.temas || [], tokens: (plan.tokens || 0) + (fts.tokens || 0) };
    })().catch(erro => { console.error('Plano e fotos falharam:', erro.message || erro); return { paginas: [], fotos: [], tokens: 0 }; });
    const tarefaQuiz = (quiz && !manterSite)
      ? gerarQuizIA({ nome, tipo, prompt, descricao: quiz.descricao, idioma })
        .then(r => guardarQuizNoSite(siteId, r.quiz).then(() => r))
        .catch(erro => { console.error('O quiz não foi criado:', erro.message || erro); return null; })
      : Promise.resolve(null);
    const [refR, planoR, quizR] = await Promise.all([tarefaReferencia, tarefaPlano, tarefaQuiz]);
    tokensReferencia = (refR ? refR.tokens || 0 : 0) + (planoR.tokens || 0) + (quizR ? quizR.tokens || 0 : 0);
    if (quizR) quizAtivo = true;
    if (comReferencia) {
      const analise = (refR && refR.analise) || analiseReferenciaVazia(tipo);
      direcoesDaReferencia(tipo, analise).forEach((d, i) => {
        direcoes[i] = d;
        estado.variantes[i].direcao = { id: d.id, nome: d.nome, resumo: d.resumo, familia: d.familia, tema: d.tema || '' };
      });
      estado.referencia = { estado: 'pronta', resumo: analise.resumo || '' };
    } else if (tipo === 'E-commerce') {
      // Os 3 estilos de loja que servem ESTE negócio (sugeridos pelo plano;
      // sem plano, pelas palavras do pedido). Ao mudar, baralha a ordem.
      const ids = temasParaNegocio(nome + ' ' + prompt, planoR.temas);
      estado.temas_sugeridos = ids;
      aplicarTemasSugeridos(direcoes, manterSite ? baralhar(ids) : ids);
      direcoes.forEach((d, i) => {
        estado.variantes[i].direcao = { id: d.id, nome: d.nome, resumo: d.resumo, familia: d.familia, tema: d.tema || '' };
      });
    }
    if (planoR.paginas && planoR.paginas.length > 1) estado.plano_paginas = planoR.paginas;
    if (umaPagina || (anterior && anterior.uma_pagina)) estado.uma_pagina = true;
    estado.fotos = planoR.fotos || [];
    estado.preparacao = 'pronta';
    await guardarVariantes(siteId, estado);

    const ehLoja = (tipo === 'E-commerce' || tipo === 'Checkout');
    const t0 = Date.now();
    await Promise.all(direcoes.map(async (d, i) => {
      const v = estado.variantes[i];
      try {
        const outras = direcoes.filter((_, j) => j !== i).map(x => x.nome);
        let { html, tokens } = await gerarComOpenAI({
          nome, tipo, prompt, logoUrl: estado.logo, imagensUrls, siteId, mostrarMarcaDeAgua, idioma,
          direcao: Object.assign({ n: i + 1 }, d), outrasDirecoes: outras,
          referencia: comReferencia ? { url: referencia_data_url } : null,
          paginas: estado.plano_paginas || null, fotos: estado.fotos || [], quiz: quizAtivo
        });
        tokens += tokensReferencia;
        if (ehLoja) html = marcarEstiloLoja(html, d.cartao, d.tema);
        const caminho = `sites/${owner}/${slug}/v${i + 1}.html`;
        const url = await uploadParaBunny(caminho, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
        const visual = resumoVisual(html);
        Object.assign(v, { estado: 'pronto', caminho, url, tokens, paleta: visual.paleta, fontes: visual.fontes, segundos: Math.round((Date.now() - t0) / 1000) });
      } catch (erro) {
        console.error(`Versão ${i + 1} falhou:`, erro.message || erro);
        Object.assign(v, { estado: 'erro', segundos: Math.round((Date.now() - t0) / 1000) });
      }
      await guardarVariantes(siteId, estado);
    }));

    // Mudar de layout: o site continua no ar como estava; só fica a escolha.
    if (manterSite) {
      if (!estado.variantes.some(v => v.estado === 'pronto')) await bubblePatch('generation', generationId, { 'Status': 'Erro' }).catch(() => {});
      return;
    }
    // Se a pessoa já escolheu uma versão entretanto, o site já está pronto.
    const site = await bubbleGet('site', siteId);
    if (!site || site['Status'] !== 'A gerar') return;
    const prontas = estado.variantes.filter(v => v.estado === 'pronto').length;
    await bubblePatch('site', siteId, { 'Status': prontas ? 'A escolher' : 'Erro' });
    if (!prontas) await bubblePatch('generation', generationId, { 'Status': 'Erro' }).catch(() => {});
  } catch (erro) {
    console.error('Erro em processarVariantes:', erro);
    estado.variantes.forEach(v => { if (v.estado === 'a gerar') v.estado = 'erro'; });
    await guardarVariantes(siteId, estado);
    if (!manterSite) await bubblePatch('site', siteId, { 'Status': 'Erro' }).catch(() => {});
    await bubblePatch('generation', generationId, { 'Status': 'Erro' }).catch(() => {});
  }
}

// Plano pago? (o Free vê as 3 versões, mas só usa a que escolheu ao criar)
async function temPlanoPago(owner) {
  const user = await bubbleGet('user', owner);
  if (!user) return false;
  const planId = await garantirPlano(owner, user);
  const plano = planId ? await bubbleGet('plan', planId).catch(() => null) : null;
  return !!plano && String(plano['Name'] || '').trim().toLowerCase() !== 'free';
}
const MSG_SO_PAGO = 'Mudar de layout faz parte dos planos pagos. Sobe de plano para usares as outras versões.';

// ======================================================
// Tokens (1.59.0): os do plano (por mês) + os recarregados
// ------------------------------------------------------
// Cada plano traz os seus tokens do mês. Quando acabam, a pessoa pode
// recarregar (pacotes pagos à parte) - esses ficam no campo "Tokens Extra"
// do User e não expiram. Gasta-se primeiro o que o plano traz e só depois
// os recarregados.
// ======================================================
const MSG_SEM_TOKENS = 'Os tokens do teu plano acabaram. Recarrega tokens para continuar a criar e editar.';
function saldoTokens(user, plano) {
  const incluidos = Math.max(0, Number(plano && plano['Tokens Incluidos']) || 0);
  const usados = Math.max(0, Number(user && user['Tokens Usados Mes']) || 0);
  const extra = Math.max(0, Number(user && user['Tokens Extra']) || 0);
  return { incluidos, usados, extra, livres: Math.max(0, incluidos - usados) + extra };
}
function semTokens(user, plano) { return saldoTokens(user, plano).livres <= 0; }
function patchCobrarTokens(user, plano, tokens) {
  const s = saldoTokens(user, plano);
  const doMes = Math.min(tokens, Math.max(0, s.incluidos - s.usados));
  const resto = tokens - doMes;
  const doExtra = Math.min(resto, s.extra);
  const sobra = resto - doExtra; // passou do que havia: fica registado no mês
  const dados = { 'Tokens Usados Mes': s.usados + doMes + sobra };
  if (doExtra > 0) dados['Tokens Extra'] = s.extra - doExtra;
  return dados;
}
async function cobrarTokens(owner, tokens) {
  tokens = Math.max(0, Math.round(Number(tokens) || 0));
  if (!tokens) return;
  const user = await bubbleGet('user', owner);
  if (!user) return;
  const plano = user['Plan'] ? await bubbleGet('plan', user['Plan']).catch(() => null) : null;
  await bubblePatch('user', owner, patchCobrarTokens(user, plano, tokens));
}
function milhares(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

// ======================================================
// Mudar de layout (1.56.0)
// ------------------------------------------------------
// Para sites já criados (incluindo os de antes do estúdio): gera 3 versões
// novas enquanto o site continua no ar, e troca o visual escrevendo no
// MESMO ficheiro (o link e o domínio não mudam). Produtos, montra,
// avaliações, pagamentos e contacto ficam guardados à parte e não se
// perdem. Alterações feitas com o botão Editar ficam no HTML antigo.
// Tokens: só a primeira versão posta no ar de cada lote conta no plano.
// ======================================================
app.post('/novas-variantes', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    if (site['Status'] !== 'Pronto' || !site['CDN URL'] || !site['Bunny Path']) return res.json({ status: 'error', message: 'Este projecto ainda não está pronto.' });
    const anterior = lerJsonSeguro(site['Variantes Json'], null);
    if (anterior && Array.isArray(anterior.variantes) && anterior.variantes.some(v => v.estado === 'a gerar')
        && anterior.inicio && Date.now() - Date.parse(anterior.inicio) < 15 * 60 * 1000) {
      return res.json({ status: 'error', message: 'Já estamos a desenhar versões novas para este projecto.' });
    }
    const user = await bubbleGet('user', owner);
    if (!user) return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    const planId = await garantirPlano(owner, user);
    const plano = planId ? await bubbleGet('plan', planId) : null;
    if (!plano) return res.json({ status: 'error', message: 'A tua conta não tem nenhum plano atribuído.' });
    if (semTokens(user, plano)) {
      return res.json({ status: 'error', codigo: 'tokens', message: MSG_SEM_TOKENS });
    }
    const mostrarMarcaDeAgua = String(plano['Name'] || '').trim().toLowerCase() === 'free';
    if (mostrarMarcaDeAgua) return res.json({ status: 'error', codigo: 'plano', message: MSG_SO_PAGO });
    // O idioma do site está no HTML publicado.
    let idioma = 'pt';
    try { const r = await fetch(site['CDN URL']); if (r.ok) idioma = idiomaDoHtml(await r.text()) || 'pt'; } catch (e) {}
    const prompt = site['Prompt Original'] || site['Nome'] || '';
    const generationId = await bubbleCreate('generation', {
      'Site': site_id, 'Prompt': 'Mudar de layout: ' + prompt, 'Status': 'A gerar', 'Tentativas': 1, 'Created Date': new Date().toISOString()
    });
    res.json({ status: 'success', response: { site_id } });
    processarVariantes({
      owner, nome: site['Nome'] || '', tipo: site['Tipo'] || 'Landing Page', prompt, logo_data_url: '', imagens_data_url: [],
      siteId: site_id, generationId, mostrarMarcaDeAgua, idioma, manterSite: true, logoExistente: site['Logo URL'] || '', pago: true
    }).catch(erro => console.error('Erro em processarVariantes (mudar):', erro));
  } catch (erro) {
    console.error('Erro em /novas-variantes:', erro);
    return res.json({ status: 'error', message: 'Não foi possível começar as versões novas. Tenta novamente.' });
  }
});

app.post('/trocar-variante', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const n = parseInt(req.body.variante, 10);
    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    if (site['Status'] !== 'Pronto' || !site['Bunny Path']) return res.json({ status: 'error', message: 'Este projecto ainda não está pronto.' });
    const e = lerJsonSeguro(site['Variantes Json'], null);
    if (!e || !Array.isArray(e.variantes)) return res.json({ status: 'error', message: 'Este projecto não tem versões para escolher.' });
    const v = e.variantes.find(x => x.n === n);
    if (!v || v.estado !== 'pronto' || !v.caminho) return res.json({ status: 'error', message: 'Esta versão ainda não está pronta.' });
    if (e.escolhida === n) return res.json({ status: 'success', response: { cdn_url: site['CDN URL'], escolhida: n } });
    if (!(await temPlanoPago(owner))) return res.json({ status: 'error', codigo: 'plano', message: MSG_SO_PAGO });

    const html = await descarregarDoBunny(v.caminho);
    await uploadParaBunny(site['Bunny Path'], html, 'text/html; charset=utf-8');
    await purgeCacheBunny(site['CDN URL']).catch(() => {});
    if (!e.cobrado) {
      await cobrarTokens(owner, v.tokens || 0);
      if (e.generation_id) await bubblePatch('generation', e.generation_id, { 'Status': 'Pronto', 'Tokens Usados': v.tokens || 0 }).catch(() => {});
      e.cobrado = true;
    }
    e.escolhida = n;
    await bubblePatch('site', site_id, { 'Variantes Json': JSON.stringify(e) });
    // As outras páginas são escritas outra vez com o visual novo.
    if (Array.isArray(e.plano_paginas) && e.plano_paginas.length > 1) construirPaginas(site_id, { regenerar: true });
    return res.json({ status: 'success', response: { cdn_url: site['CDN URL'], escolhida: n } });
  } catch (erro) {
    console.error('Erro em /trocar-variante:', erro);
    return res.json({ status: 'error', message: 'Não foi possível trocar o layout. Tenta novamente.' });
  }
});

// O que a página pode ver das versões (sem caminhos internos nem tokens).
function variantesPublicas(site) {
  const e = lerJsonSeguro(site && site['Variantes Json'], null);
  if (!e || !Array.isArray(e.variantes)) return null;
  return {
    escolhida: e.escolhida || null,
    modo: e.modo || 'criar',
    preparacao: e.preparacao || '',
    referencia: e.referencia ? (e.referencia.estado || 'pronta') : '',
    variantes: e.variantes.map(v => ({
      n: v.n, estado: v.estado, url: v.estado === 'pronto' ? v.url : '', direcao: v.direcao || {},
      paleta: v.paleta || [], fontes: v.fontes || [], segundos: v.segundos || 0
    }))
  };
}

// A pessoa escolhe uma versão: passa a ser o site, e só ela conta nos tokens.
app.post('/escolher-variante', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const n = parseInt(req.body.variante, 10);
    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    const e = lerJsonSeguro(site['Variantes Json'], null);
    if (!e || !Array.isArray(e.variantes)) return res.json({ status: 'error', message: 'Este projecto não tem versões para escolher.' });
    if (e.modo === 'mudar') return res.json({ status: 'error', message: 'Pedido inválido.' });
    if (e.escolhida) {
      if (e.escolhida === n && site['CDN URL']) return res.json({ status: 'success', response: { cdn_url: site['CDN URL'], tipo: site['Tipo'] } });
      return res.json({ status: 'error', message: 'Já escolheste uma versão para este projecto.' });
    }
    const v = e.variantes.find(x => x.n === n);
    if (!v || v.estado !== 'pronto' || !v.caminho) return res.json({ status: 'error', message: 'Esta versão ainda não está pronta.' });

    const html = await descarregarDoBunny(v.caminho);
    const caminhoSite = `sites/${owner}/${e.slug}/index.html`;
    const cdnUrl = await uploadParaBunny(caminhoSite, html, 'text/html; charset=utf-8');
    e.escolhida = n;
    e.cobrado = true;
    await bubblePatch('site', site_id, { 'Variantes Json': JSON.stringify(e) });
    if (e.generation_id) {
      await bubblePatch('generation', e.generation_id, { 'Status': 'Pronto', 'Tokens Usados': v.tokens || 0 }).catch(() => {});
    }
    await cobrarTokens(owner, v.tokens || 0);
    await bubblePatch('site', site_id, { 'Status': 'Pronto', 'Bunny Path': caminhoSite, 'CDN URL': cdnUrl, 'Logo URL': e.logo || '' });
    // Sites com várias páginas: as outras páginas nascem agora, em fundo.
    if (Array.isArray(e.plano_paginas) && e.plano_paginas.length > 1) construirPaginas(site_id, {});
    const outrasProntas = e.variantes.filter(x => x.n !== n && x.estado === 'pronto').length;
    return res.json({ status: 'success', response: { cdn_url: cdnUrl, tipo: site['Tipo'], plano_pago: await temPlanoPago(owner).catch(() => false), outras_prontas: outrasProntas } });
  } catch (erro) {
    console.error('Erro em /escolher-variante:', erro);
    return res.json({ status: 'error', message: 'Não foi possível escolher esta versão. Tenta novamente.' });
  }
});

async function processarGeracao({ owner, nome, tipo, prompt, logo_data_url, imagens_data_url, referencia_data_url, siteId, generationId, tokensUsados, mostrarMarcaDeAgua, idioma, quiz, pago, umaPagina }) {
  try {
    // ---- Logótipo (opcional) ----
    // Esta função já corre depois de termos respondido ao pedido (ver nota
    // sobre /generate ser assíncrono), por isso nunca falha a geração toda
    // por causa do logótipo - se não houver espaço, segue sem logótipo (a
    // IA usa um wordmark em texto, ver gerarComOpenAI) em vez de travar.
    let logoUrl = '';
    if (logo_data_url) {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(logo_data_url);
      if (match) {
        const mime = match[1];
        const base64 = match[2];
        const buffer = Buffer.from(base64, 'base64');
        const espacoLogo = await verificarEspaco(owner, buffer.length);
        if (espacoLogo.ok) {
          const extensao = mime.split('/')[1].replace('+xml', '').replace('jpeg', 'jpg');
          const caminhoLogo = `logos/${owner}-${Date.now()}.${extensao}`;
          logoUrl = await uploadParaBunny(caminhoLogo, buffer, mime);
          await somarEspacoUsado(owner, buffer.length);
        } else {
          console.error('Logótipo não enviado por falta de espaço:', espacoLogo.message);
        }
      }
    }

    // ---- Imagens anexadas ao pedido (opcional) ----
    // Ao contrário do logótipo, estas foram pedidas explicitamente pela
    // pessoa para entrarem no site - se o envio falhar (normalmente por
    // falta de espaço), é melhor travar a geração toda e dizer porquê do
    // que gerar um site sem as imagens que a pessoa esperava ver lá.
    let imagensUrls = [];
    if (imagens_data_url && imagens_data_url.length) {
      const resultadoImagens = await uploadMultiplasImagensBase64('imagens-pedido', owner, imagens_data_url);
      if (resultadoImagens.erro) {
        throw new Error('Não foi possível enviar as imagens anexadas: ' + resultadoImagens.erro);
      }
      imagensUrls = resultadoImagens.urls;
    }

    // ---- Plano das páginas, fotografias e quiz (1.60.0) ----
    const siteSlug = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [planoR, quizR] = await Promise.all([
      (async () => {
        const plan = await planearSite({ tipo, nome, prompt, idioma, pago: pago !== false, comFotos: true, umaPagina: !!umaPagina });
        const fts = await prepararFotos({ owner, slug: siteSlug, pedidos: plan.fotos });
        return { paginas: plan.paginas, fotos: fts.fotos, tokens: (plan.tokens || 0) + (fts.tokens || 0) };
      })().catch(erro => { console.error('Plano e fotos falharam:', erro.message || erro); return { paginas: [], fotos: [], tokens: 0 }; }),
      quiz ? gerarQuizIA({ nome, tipo, prompt, descricao: quiz.descricao, idioma })
        .then(r => guardarQuizNoSite(siteId, r.quiz).then(() => r))
        .catch(erro => { console.error('O quiz não foi criado:', erro.message || erro); return null; }) : Promise.resolve(null)
    ]);
    const planoPaginas = planoR.paginas && planoR.paginas.length > 1 ? planoR.paginas : [];

    // ---- Gerar o HTML com a OpenAI ----
    const gerado = await gerarComOpenAI({ nome, tipo, prompt, logoUrl, imagensUrls, siteId, mostrarMarcaDeAgua, idioma, referencia: referencia_data_url ? { url: referencia_data_url } : null, paginas: planoPaginas, fotos: planoR.fotos, quiz: !!quizR });
    const html = gerado.html;
    const tokens = gerado.tokens + (planoR.tokens || 0) + (quizR ? quizR.tokens || 0 : 0);

    // ---- Guardar o HTML no Bunny Storage ----
    const caminhoSite = `sites/${owner}/${siteSlug}/index.html`;
    const cdnUrl = await uploadParaBunny(caminhoSite, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');

    // ---- Actualizar a Generation ----
    // (de propósito ANTES de marcar o Site como "Pronto" - se isto falhar,
    // o catch mais abaixo marca tudo como "Erro" sem nunca termos chegado
    // a dizer que o Site estava pronto)
    await bubblePatch('generation', generationId, {
      'Status': 'Pronto',
      'Tokens Usados': tokens
    });

    // ---- Actualizar os tokens usados do utilizador ----
    await cobrarTokens(owner, tokens);

    // ---- Só agora marcamos o Site como "Pronto" ----
    // Chegar aqui significa que a Generation e o User já foram actualizados
    // com sucesso, por isso esta é a última coisa que pode falhar.
    const fimSite = {
      'Status': 'Pronto',
      'Bunny Path': caminhoSite,
      'CDN URL': cdnUrl,
      'Logo URL': logoUrl
    };
    if (planoPaginas.length) fimSite['Variantes Json'] = JSON.stringify({ plano_paginas: planoPaginas, fotos: planoR.fotos || [] });
    else if (umaPagina) fimSite['Variantes Json'] = JSON.stringify({ uma_pagina: true, fotos: planoR.fotos || [] });
    await bubblePatch('site', siteId, fimSite);
    if (planoPaginas.length) construirPaginas(siteId, {});

  } catch (erro) {
    console.error('Erro em processarGeracao:', erro);
    await bubblePatch('site', siteId, { 'Status': 'Erro' }).catch(() => {});
    await bubblePatch('generation', generationId, { 'Status': 'Erro' }).catch(() => {});
  }
}

// ======================================================
// Editar um site já gerado
// ======================================================
// Mesma lógica assíncrona do /generate (responde logo, trabalha a seguir),
// mas em vez de criar um Site novo, lê o HTML já publicado, pede à IA para
// aplicar só a alteração pedida, e volta a publicar no MESMO caminho do
// Bunny (o link não muda) - depois limpa a cache da CDN para a alteração
// aparecer já.
//
// Regra especial do plano Free (decidida com o utilizador): a primeira
// edição de um site consome SEMPRE todos os tokens que restarem no mês,
// mesmo que a IA tenha gastado menos do que isso - não há segunda edição
// grátis. Nos planos pagos, cada edição soma só o que foi gasto a sério,
// tal como a criação.
app.post('/editar', async (req, res) => {
  try {
    const { owner, site_id, prompt, imagens_data_url } = req.body;
    const pagina = typeof req.body.pagina === 'string' && /^[a-z]{2,20}$/.test(req.body.pagina) ? req.body.pagina : 'inicio';
    if (!owner || !site_id || !prompt) {
      return res.json({ status: 'error', message: 'Faltam dados: site_id e prompt são obrigatórios.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site) {
      return res.json({ status: 'error', message: 'Projecto não encontrado.' });
    }
    if (site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    }
    if (site['Status'] !== 'Pronto') {
      return res.json({ status: 'error', message: 'Este projecto ainda não está pronto para ser editado. Espera a geração terminar.' });
    }
    if (!site['CDN URL'] || !site['Bunny Path']) {
      return res.json({ status: 'error', message: 'Este projecto não tem nenhum ficheiro gerado para editar.' });
    }

    const user = await bubbleGet('user', owner);
    if (!user) {
      return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    }
    const planId = await garantirPlano(owner, user);
    if (!planId) {
      return res.json({ status: 'error', message: 'A tua conta não tem nenhum plano atribuído, e não encontrei nenhum plano Free para atribuir automaticamente.' });
    }
    const plano = await bubbleGet('plan', planId);

    const tokensUsados = user['Tokens Usados Mes'] || 0;
    const tokensIncluidos = plano['Tokens Incluidos'] || 0;
    if (semTokens(user, plano)) {
      return res.json({ status: 'error', codigo: 'tokens', message: MSG_SEM_TOKENS });
    }

    // Esta vai ser a primeira edição deste site se só existir, até agora,
    // a Generation da criação original (nunca criámos uma segunda).
    const geracoesExistentes = await bubbleCount('generation', [
      { key: 'Site', constraint_type: 'equals', value: site_id }
    ]);
    const ehPrimeiraEdicao = geracoesExistentes <= 1;
    const ehPlanoFree = String(plano['Name'] || '').trim().toLowerCase() === 'free';

    const generationId = await bubbleCreate('generation', {
      'Site': site_id,
      'Prompt': prompt,
      'Status': 'A gerar',
      'Tentativas': 1,
      'Created Date': new Date().toISOString()
    });

    await bubblePatch('site', site_id, { 'Status': 'A gerar' });

    res.json({
      status: 'success',
      response: { generation_id: generationId }
    });

    processarEdicao({ owner, site_id, site, prompt, imagens_data_url, generationId, tokensUsados, tokensIncluidos, ehPrimeiraEdicao, ehPlanoFree, pagina })
      .catch(erro => console.error('Erro em processarEdicao:', erro));

  } catch (erro) {
    console.error('Erro em /editar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível iniciar a edição. Tenta novamente.' });
  }
});

async function processarEdicao({ owner, site_id, site, prompt, imagens_data_url, generationId, tokensUsados, tokensIncluidos, ehPrimeiraEdicao, ehPlanoFree, pagina }) {
  try {
    // ---- Ler a página agora mesmo (directamente do Bunny, sem cache) ----
    const htmlAtual = (await lerPaginaDoSite(site, pagina || 'inicio')).html;

    // ---- Imagens anexadas a este pedido de edição (opcional) ----
    // Mesma regra do processarGeracao: pedidas explicitamente pela pessoa,
    // por isso falham a edição toda em vez de ficarem de fora em silêncio.
    let imagensUrls = [];
    if (imagens_data_url && imagens_data_url.length) {
      const resultadoImagens = await uploadMultiplasImagensBase64('imagens-pedido', owner, imagens_data_url);
      if (resultadoImagens.erro) {
        throw new Error('Não foi possível enviar as imagens anexadas: ' + resultadoImagens.erro);
      }
      imagensUrls = resultadoImagens.urls;
    }

    // ---- Pedir à IA para aplicar a alteração ----
    const { html, tokens } = await editarComOpenAI({
      nome: site['Nome'],
      tipo: site['Tipo'],
      prompt,
      htmlAtual,
      imagensUrls,
      siteId: site_id,
      mostrarMarcaDeAgua: ehPlanoFree
    });

    // ---- Publicar no MESMO caminho (o link não muda). Num site com várias
    // páginas, o cabeçalho, o rodapé e o CSS passam para todas. ----
    await guardarPaginaDoSite(site, pagina || 'inicio', html);
    const cdnUrl = site['CDN URL'];

    await bubblePatch('generation', generationId, {
      'Status': 'Pronto',
      'Tokens Usados': tokens
    });

    // ---- Tokens: regra especial do plano Free ----
    if (ehPlanoFree && ehPrimeiraEdicao) {
      await bubblePatch('user', owner, { 'Tokens Usados Mes': Math.max(tokensIncluidos, tokensUsados) });
    } else {
      await cobrarTokens(owner, tokens);
    }

    // ---- Site volta a "Pronto", com o mesmo link ----
    await bubblePatch('site', site_id, {
      'Status': 'Pronto',
      'CDN URL': cdnUrl
    });

  } catch (erro) {
    console.error('Erro em processarEdicao:', erro);
    // O site antigo continua válido - só a tentativa de edição falhou -
    // por isso volta a "Pronto" em vez de "Erro" (que pareceria ter
    // destruído o site inteiro).
    await bubblePatch('site', site_id, { 'Status': 'Pronto' }).catch(() => {});
    await bubblePatch('generation', generationId, { 'Status': 'Erro' }).catch(() => {});
  }
}

// Usada por duas páginas: "criar" (só manda site_id) e o modal "Editar"
// do dashboard (manda também generation_id). A diferença importa porque,
// numa edição, o Site volta sempre a "Pronto" mesmo que a IA tenha
// falhado (ver nota em processarEdicao - o site antigo continua válido).
// Por isso, quando vem generation_id, devolvemos também o estado dessa
// tentativa em concreto (geracao_estado), que é o único sítio onde um
// "Erro" de edição fica registado.
app.post('/generate-status', async (req, res) => {
  try {
    const { site_id, generation_id } = req.body;
    if (!site_id) {
      return res.json({ status: 'error', message: 'Falta o site_id.' });
    }
    const site = await bubbleGet('site', site_id);
    if (!site) {
      return res.json({ status: 'error', message: 'Projecto não encontrado.' });
    }
    if (SESSAO_MODO === 'obrigatoria' && site['Owner'] !== req.body.owner) {
      return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    }

    const response = {
      estado: site['Status'],
      cdn_url: site['CDN URL'] || '',
      nome: site['Nome'] || '',
      tipo: site['Tipo'] || ''
    };
    // Recuperação: se o servidor reiniciou a meio, as versões ficariam a
    // "gerar" para sempre. Passados 15 minutos, as que faltam contam como
    // falhadas e a pessoa escolhe entre as que ficaram prontas.
    const bruto = lerJsonSeguro(site['Variantes Json'], null);
    const presas = bruto && Array.isArray(bruto.variantes) && bruto.variantes.some(v => v.estado === 'a gerar');
    if (presas && (site['Status'] === 'A gerar' || bruto.modo === 'mudar') && bruto.inicio && Date.now() - Date.parse(bruto.inicio) > 15 * 60 * 1000) {
      bruto.variantes.forEach(v => { if (v.estado === 'a gerar') v.estado = 'erro'; });
      const prontas = bruto.variantes.some(v => v.estado === 'pronto');
      site['Variantes Json'] = JSON.stringify(bruto);
      const mudancas = { 'Variantes Json': site['Variantes Json'] };
      if (bruto.modo !== 'mudar') { site['Status'] = prontas ? 'A escolher' : 'Erro'; mudancas['Status'] = site['Status']; }
      response.estado = site['Status'];
      await bubblePatch('site', site_id, mudancas).catch(() => {});
    }
    const variantes = variantesPublicas(site);
    if (variantes) response.variantes = variantes;
    const paginasPub = estadoPublicoPaginas(lerJsonSeguro(site['Variantes Json'], null), site);
    if (paginasPub) response.paginas = paginasPub;
    if (req.body.owner && site['Owner'] === req.body.owner) response.plano_pago = await temPlanoPago(req.body.owner).catch(() => false);

    if (generation_id) {
      const generation = await bubbleGet('generation', generation_id);
      response.geracao_estado = generation ? generation['Status'] : '';
    }

    return res.json({ status: 'success', response });
  } catch (erro) {
    console.error('Erro em /generate-status:', erro);
    return res.json({ status: 'error', message: 'Não foi possível consultar o estado.' });
  }
});

// Dados da conta para o dashboard (nome, plano, tokens usados/incluídos).
// Antes, o dashboard chamava um backend workflow do Bubble ("account")
// que lia o Current User - mas essa página corre dentro de uma iframe
// isolada, e a sessão do Bubble nem sempre fica disponível aí (confirmado
// a 12/10/2026: "/account" falhava com "Não foi possível carregar os
// dados da conta", mesmo com o login a funcionar e o /meus-sites, que já
// recebe o owner explícito, a funcionar bem). Esta rota resolve o mesmo
// problema da mesma forma que todas as outras - recebe o owner
// directamente, sem depender de nenhuma sessão.
app.post('/account', async (req, res) => {
  try {
    const { owner } = req.body;
    if (!owner) {
      return res.json({ status: 'error', message: 'Falta o owner.' });
    }

    const user = await bubbleGet('user', owner);
    if (!user) {
      return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    }

    let nomePlano = '';
    let tokensIncluidos = 0;
    const planIdConta = await garantirPlano(owner, user);
    if (planIdConta) {
      try {
        const plano = await bubbleGet('plan', planIdConta);
        if (plano) {
          nomePlano = plano['Name'] || '';
          tokensIncluidos = plano['Tokens Incluidos'] || 0;
        }
      } catch (erroPlano) {
        // Plano referenciado mas não encontrado (ex.: existe só na versão
        // de testes, não na Live) - não deixa cair o resto da conta.
        console.error('Erro a ler o plano em /account:', erroPlano);
      }
    }

    return res.json({
      status: 'success',
      response: {
        nome: user['Full Name'] || '',
        plano: nomePlano,
        tokens_usados: user['Tokens Usados Mes'] || 0,
        tokens_incluidos: tokensIncluidos,
        tokens_extra: Math.max(0, Number(user['Tokens Extra']) || 0)
      }
    });
  } catch (erro) {
    console.error('Erro em /account:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os dados da conta.' });
  }
});

app.post('/meus-sites', async (req, res) => {
  try {
    const { owner } = req.body;
    if (!owner) {
      return res.json({ status: 'error', message: 'Falta o owner.' });
    }

    const sites = await bubbleList(
      'site',
      [{ key: 'Owner', constraint_type: 'equals', value: owner }],
      'Created Date',
      true
    );

    const lista = sites.map(s => ({
      id: s._id,
      nome: s['Nome'],
      tipo: s['Tipo'],
      estado: s['Status'],
      cdn_url: s['CDN URL'] || '',
      criado: s['Created Date'],
      dominio: s['Dominio Personalizado'] || '',
      dominio_estado: s['Dominio Estado'] || '',
      dominio_hostname: s['Dominio Hostname'] || '',
      email_contacto: s['Email Contacto'] || ''
    }));

    return res.json({ status: 'success', response: { sites: lista } });
  } catch (erro) {
    console.error('Erro em /meus-sites:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os teus projectos.' });
  }
});

// ======================================================
// Rotas - Loja (E-commerce / Checkout)
// ======================================================

// Lista os produtos activos de uma loja. Pública (sem owner) porque é
// chamada pela própria página do site gerado, onde quem visita não está
// necessariamente autenticado - qualquer pessoa pode ver os produtos à
// venda, é esse o objectivo de uma loja.
app.post('/loja-produtos', async (req, res) => {
  try {
    const { site_id } = req.body;
    if (!site_id) {
      return res.json({ status: 'error', message: 'Falta o site_id.' });
    }

    const [site, produtos] = await Promise.all([
      bubbleGet('site', site_id).catch(() => null),
      bubbleList(
        'produto',
        [
          { key: 'Site', constraint_type: 'equals', value: site_id },
          { key: 'Is Active', constraint_type: 'equals', value: true }
        ],
        'Created Date',
        false
      )
    ]);

    // Dados da montra: capa, modo de pagamento efectivo e contactos
    // públicos (números de pagamento manual / WhatsApp são públicos por
    // natureza - os clientes precisam deles).
    let loja = { nome: '', capa: [], modo: 'pedido', metodos: [], manual: null, whatsapp: '' };
    if (site) {
      const { modo, cfg } = await modoEfectivoLoja(site);
      loja = {
        nome: site['Nome'] || '',
        capa: capaLoja(site),
        modo: modo,
        metodos: modo === 'daniel' ? ['mpesa', 'emola', 'cartao'] : [],
        manual: modo === 'manual' ? { mpesa: cfg.mpesa, emola: cfg.emola, titular: cfg.titular } : null,
        whatsapp: cfg.whatsapp
      };
    }

    if (site) loja.montra = montraLoja(site);
    const resumo = await resumoAvaliacoes(site_id);
    const lista = produtos.map(p => Object.assign(produtoParaLista(p), { avaliacao: resumo[p._id] || { media: 0, total: 0 } }));
    return res.json({ status: 'success', response: { produtos: lista, loja } });
  } catch (erro) {
    console.error('Erro em /loja-produtos:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os produtos.' });
  }
});

// Cria um novo produto numa loja. Esta rota não é pública como a anterior -
// exige o "owner" (quem está a pedir) e confirma que esse owner é mesmo o
// dono do Site antes de criar nada, para ninguém poder adicionar produtos
// a uma loja que não é sua.
app.post('/loja-produto-criar', async (req, res) => {
  try {
    const { owner, site_id, nome, preco, descricao, imagem_url, imagem_data_url, categoria, preco_antigo, destaque } = req.body;

    if (!owner || !site_id || !nome || preco === undefined || preco === null || preco === '') {
      return res.json({ status: 'error', message: 'Faltam dados: site_id, nome e preco são obrigatórios.' });
    }

    const precoNum = Number(preco);
    if (isNaN(precoNum) || precoNum <= 0) {
      return res.json({ status: 'error', message: 'O preço tem de ser um número maior que zero.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para adicionar produtos a este projecto.' });
    }

    const dados = {
      'Site': site_id,
      'Nome': String(nome).trim().slice(0, 120),
      'Preco MZN': precoNum,
      'Descricao': descricao || '',
      'Imagem URL': imagem_url || '',
      'Is Active': true
    };
    // Campos da loja v2 (categoria, promoção, destaque) - todos opcionais.
    if (categoria !== undefined) dados['Categoria'] = String(categoria || '').trim().slice(0, 40);
    if (destaque !== undefined) dados['Destaque'] = !!destaque;
    if (preco_antigo !== undefined) {
      const antigo = Number(preco_antigo) || 0;
      dados['Preco Antigo MZN'] = antigo > 0 ? antigo : 0;
    }
    if (imagem_data_url) {
      const up = await uploadImagemBase64('produtos', owner, imagem_data_url);
      if (up.erro) return res.json({ status: 'error', message: up.erro });
      dados['Imagem URL'] = up.url;
    }
    // Loja v3: fotos por ordem (a primeira é a principal), opções e stock.
    if (Array.isArray(req.body.fotos) || req.body.variantes !== undefined || req.body.stock !== undefined) {
      const base = (typeof produto !== 'undefined' && produto) ? produto : null;
      const extra = extraProduto(base || {});
      if (Array.isArray(req.body.fotos)) {
        const urls = [];
        for (const f of req.body.fotos.slice(0, 6)) {
          if (typeof f !== 'string') continue;
          if (f.indexOf('data:image/') === 0) {
            const up = await uploadImagemBase64('produtos', owner, f);
            if (up.erro) return res.json({ status: 'error', message: up.erro });
            if (up.url) urls.push(up.url);
          } else if (/^https:\/\/[^\s"'<>]+$/.test(f)) {
            urls.push(f.slice(0, 600));
          }
        }
        dados['Imagem URL'] = urls[0] || '';
        extra.imagens = urls.slice(1);
      }
      if (req.body.variantes !== undefined) {
        extra.variantes = extraProduto({ 'Extra Json': JSON.stringify({ variantes: Array.isArray(req.body.variantes) ? req.body.variantes : [] }) }).variantes;
      }
      if (req.body.stock !== undefined) {
        extra.stock = numeroOuNulo(req.body.stock);
      }
      dados['Extra Json'] = JSON.stringify(extra);
    }

    const produtoId = await bubbleCreate('produto', dados);
    // Sem categoria? A IA escolhe uma, por trás (o dono não espera por isso).
    if (!dados['Categoria']) categorizarEmFundo(site_id, produtoId);
    return res.json({ status: 'success', response: { produto_id: produtoId } });
  } catch (erro) {
    console.error('Erro em /loja-produto-criar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível criar o produto.' });
  }
});

// Lista TODOS os produtos de uma loja (activos e inactivos), para o dono
// gerir - ao contrário de /loja-produtos, que só mostra os activos e é
// pública. Esta exige o owner e confirma que é mesmo o dono do Site.
app.post('/loja-meus-produtos', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    if (!owner || !site_id) {
      return res.json({ status: 'error', message: 'Faltam dados: owner e site_id são obrigatórios.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para ver os produtos deste projecto.' });
    }

    const produtos = await bubbleList(
      'produto',
      [{ key: 'Site', constraint_type: 'equals', value: site_id }],
      'Created Date',
      true
    );

    const lista = produtos.map(p => Object.assign(produtoParaLista(p), {
      preco_antigo: Number(p['Preco Antigo MZN']) || 0,
      activo: !!p['Is Active']
    }));

    return res.json({ status: 'success', response: { produtos: lista } });
  } catch (erro) {
    console.error('Erro em /loja-meus-produtos:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os produtos.' });
  }
});

// Edita um produto existente (incluindo activar/desactivar). Só o dono do
// Site a que o produto pertence pode editá-lo.
app.post('/loja-produto-editar', async (req, res) => {
  try {
    const { owner, produto_id, nome, preco, descricao, imagem_url, imagem_data_url, activo, categoria, preco_antigo, destaque } = req.body;
    if (!owner || !produto_id) {
      return res.json({ status: 'error', message: 'Faltam dados: produto_id é obrigatório.' });
    }

    const produto = await bubbleGet('produto', produto_id);
    if (!produto) {
      return res.json({ status: 'error', message: 'Produto não encontrado.' });
    }

    const site = await bubbleGet('site', produto['Site']);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para editar este produto.' });
    }

    const dados = {};
    if (nome !== undefined) dados['Nome'] = String(nome).trim().slice(0, 120);
    if (descricao !== undefined) dados['Descricao'] = descricao;
    if (imagem_url !== undefined) dados['Imagem URL'] = imagem_url;
    if (activo !== undefined) dados['Is Active'] = !!activo;
    if (preco !== undefined) {
      const precoNum = Number(preco);
      if (isNaN(precoNum) || precoNum <= 0) {
        return res.json({ status: 'error', message: 'O preço tem de ser um número maior que zero.' });
      }
      dados['Preco MZN'] = precoNum;
    }
    // Campos da loja v2 (categoria, promoção, destaque) - todos opcionais.
    if (categoria !== undefined) dados['Categoria'] = String(categoria || '').trim().slice(0, 40);
    if (destaque !== undefined) dados['Destaque'] = !!destaque;
    if (preco_antigo !== undefined) {
      const antigo = Number(preco_antigo) || 0;
      dados['Preco Antigo MZN'] = antigo > 0 ? antigo : 0;
    }
    if (imagem_data_url) {
      const up = await uploadImagemBase64('produtos', owner, imagem_data_url);
      if (up.erro) return res.json({ status: 'error', message: up.erro });
      dados['Imagem URL'] = up.url;
    }
    // Loja v3: fotos por ordem (a primeira é a principal), opções e stock.
    if (Array.isArray(req.body.fotos) || req.body.variantes !== undefined || req.body.stock !== undefined) {
      const base = (typeof produto !== 'undefined' && produto) ? produto : null;
      const extra = extraProduto(base || {});
      if (Array.isArray(req.body.fotos)) {
        const urls = [];
        for (const f of req.body.fotos.slice(0, 6)) {
          if (typeof f !== 'string') continue;
          if (f.indexOf('data:image/') === 0) {
            const up = await uploadImagemBase64('produtos', owner, f);
            if (up.erro) return res.json({ status: 'error', message: up.erro });
            if (up.url) urls.push(up.url);
          } else if (/^https:\/\/[^\s"'<>]+$/.test(f)) {
            urls.push(f.slice(0, 600));
          }
        }
        dados['Imagem URL'] = urls[0] || '';
        extra.imagens = urls.slice(1);
      }
      if (req.body.variantes !== undefined) {
        extra.variantes = extraProduto({ 'Extra Json': JSON.stringify({ variantes: Array.isArray(req.body.variantes) ? req.body.variantes : [] }) }).variantes;
      }
      if (req.body.stock !== undefined) {
        extra.stock = numeroOuNulo(req.body.stock);
      }
      dados['Extra Json'] = JSON.stringify(extra);
    }

    await bubblePatch('produto', produto_id, dados);
    const categoriaFinal = dados['Categoria'] !== undefined ? dados['Categoria'] : String(produto['Categoria'] || '').trim();
    if (!categoriaFinal && (dados['Is Active'] !== undefined ? dados['Is Active'] : produto['Is Active'])) categorizarEmFundo(produto['Site'], produto_id);
    return res.json({ status: 'success', response: { imagem: dados['Imagem URL'] !== undefined ? dados['Imagem URL'] : (produto['Imagem URL'] || '') } });
  } catch (erro) {
    console.error('Erro em /loja-produto-editar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível actualizar o produto.' });
  }
});

// ======================================================
// Portefólio - Trabalhos reais (upload de imagens, geridos pelo dono)
// ======================================================
// Mesmo espírito dos Produtos da loja: a IA nunca inventa os trabalhos no
// site gerado, só desenha a casca e deixa uma div vazia - os trabalhos a
// sério vêm sempre destas rotas, geridos pelo dono numa página própria.

// Lista pública dos trabalhos activos de um site - é esta rota que o
// módulo fixo do portefólio (injectado no site gerado) chama.
app.post('/portfolio-trabalhos', async (req, res) => {
  try {
    const { site_id } = req.body;
    if (!site_id) {
      return res.json({ status: 'error', message: 'Falta o site_id.' });
    }

    const trabalhos = await bubbleList(
      'trabalho',
      [
        { key: 'Site', constraint_type: 'equals', value: site_id },
        { key: 'Is Active', constraint_type: 'equals', value: true }
      ],
      'Created Date',
      false
    );

    const lista = trabalhos.map(t => ({
      id: t._id,
      titulo: t['Titulo'],
      descricao: t['Descricao'] || '',
      imagem: t['Imagem URL'] || '',
      link: t['Link'] || ''
    }));

    return res.json({ status: 'success', response: { trabalhos: lista } });
  } catch (erro) {
    console.error('Erro em /portfolio-trabalhos:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os trabalhos.' });
  }
});

// Cria um trabalho novo. A imagem pode vir de duas formas: `imagem_data_url`
// (upload real, em base64 - sobe para o Bunny) ou `imagem_url` (um link já
// existente, para quem preferir colar um). Se vierem os dois, o upload
// ganha.
app.post('/portfolio-trabalho-criar', async (req, res) => {
  try {
    const { owner, site_id, titulo, descricao, link, imagem_url, imagem_data_url } = req.body;

    if (!owner || !site_id || !titulo) {
      return res.json({ status: 'error', message: 'Faltam dados: site_id e titulo são obrigatórios.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para adicionar trabalhos a este projecto.' });
    }

    let imagemFinal = imagem_url || '';
    if (imagem_data_url) {
      const resultadoUpload = await uploadImagemBase64('trabalhos', owner, imagem_data_url);
      if (resultadoUpload.erro) {
        return res.json({ status: 'error', message: resultadoUpload.erro });
      }
      if (resultadoUpload.url) imagemFinal = resultadoUpload.url;
    }

    const trabalhoId = await bubbleCreate('trabalho', {
      'Site': site_id,
      'Titulo': titulo,
      'Descricao': descricao || '',
      'Link': link || '',
      'Imagem URL': imagemFinal,
      'Is Active': true,
      'Created Date': new Date().toISOString()
    });

    return res.json({ status: 'success', response: { trabalho_id: trabalhoId } });
  } catch (erro) {
    console.error('Erro em /portfolio-trabalho-criar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível criar o trabalho.' });
  }
});

// Lista TODOS os trabalhos de um site (activos e inactivos), para o dono
// gerir - ao contrário de /portfolio-trabalhos, que só mostra os activos.
app.post('/portfolio-meus-trabalhos', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    if (!owner || !site_id) {
      return res.json({ status: 'error', message: 'Faltam dados: owner e site_id são obrigatórios.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para ver os trabalhos deste projecto.' });
    }

    const trabalhos = await bubbleList(
      'trabalho',
      [{ key: 'Site', constraint_type: 'equals', value: site_id }],
      'Created Date',
      true
    );

    const lista = trabalhos.map(t => ({
      id: t._id,
      titulo: t['Titulo'],
      descricao: t['Descricao'] || '',
      imagem: t['Imagem URL'] || '',
      link: t['Link'] || '',
      activo: !!t['Is Active']
    }));

    return res.json({ status: 'success', response: { trabalhos: lista } });
  } catch (erro) {
    console.error('Erro em /portfolio-meus-trabalhos:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os trabalhos.' });
  }
});

// Edita um trabalho existente (incluindo activar/desactivar e trocar a
// imagem). Só o dono do site pode editar.
app.post('/portfolio-trabalho-editar', async (req, res) => {
  try {
    const { owner, trabalho_id, titulo, descricao, link, imagem_url, imagem_data_url, activo } = req.body;
    if (!owner || !trabalho_id) {
      return res.json({ status: 'error', message: 'Faltam dados: trabalho_id é obrigatório.' });
    }

    const trabalho = await bubbleGet('trabalho', trabalho_id);
    if (!trabalho) {
      return res.json({ status: 'error', message: 'Trabalho não encontrado.' });
    }

    const site = await bubbleGet('site', trabalho['Site']);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para editar este trabalho.' });
    }

    const dados = {};
    if (titulo !== undefined) dados['Titulo'] = titulo;
    if (descricao !== undefined) dados['Descricao'] = descricao;
    if (link !== undefined) dados['Link'] = link;
    if (activo !== undefined) dados['Is Active'] = !!activo;
    if (imagem_data_url) {
      const resultadoUpload = await uploadImagemBase64('trabalhos', owner, imagem_data_url);
      if (resultadoUpload.erro) {
        return res.json({ status: 'error', message: resultadoUpload.erro });
      }
      if (resultadoUpload.url) dados['Imagem URL'] = resultadoUpload.url;
    } else if (imagem_url !== undefined) {
      dados['Imagem URL'] = imagem_url;
    }

    await bubblePatch('trabalho', trabalho_id, dados);
    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /portfolio-trabalho-editar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível actualizar o trabalho.' });
  }
});

// ======================================================
// Blog - Posts reais (upload de imagens, geridos pelo dono)
// ======================================================

// Lista pública dos posts activos de um site - é esta rota que o módulo
// fixo do blog (injectado no site gerado) chama.
app.post('/blog-posts', async (req, res) => {
  try {
    const { site_id } = req.body;
    if (!site_id) {
      return res.json({ status: 'error', message: 'Falta o site_id.' });
    }

    const posts = await bubbleList(
      'post',
      [
        { key: 'Site', constraint_type: 'equals', value: site_id },
        { key: 'Is Active', constraint_type: 'equals', value: true }
      ],
      'Created Date',
      true
    );

    const lista = posts.map(p => ({
      id: p._id,
      titulo: p['Titulo'],
      resumo: p['Resumo'] || '',
      conteudo: p['Conteudo'] || '',
      imagem: p['Imagem URL'] || '',
      data: p['Created Date'] || ''
    }));

    return res.json({ status: 'success', response: { posts: lista } });
  } catch (erro) {
    console.error('Erro em /blog-posts:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os artigos.' });
  }
});

// Cria um artigo novo. Mesma lógica de imagem dos Trabalhos: upload real
// (imagem_data_url) ou link colado (imagem_url).
app.post('/blog-post-criar', async (req, res) => {
  try {
    const { owner, site_id, titulo, resumo, conteudo, imagem_url, imagem_data_url } = req.body;

    if (!owner || !site_id || !titulo || !conteudo) {
      return res.json({ status: 'error', message: 'Faltam dados: site_id, titulo e conteudo são obrigatórios.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para adicionar artigos a este projecto.' });
    }

    let imagemFinal = imagem_url || '';
    if (imagem_data_url) {
      const resultadoUpload = await uploadImagemBase64('posts', owner, imagem_data_url);
      if (resultadoUpload.erro) {
        return res.json({ status: 'error', message: resultadoUpload.erro });
      }
      if (resultadoUpload.url) imagemFinal = resultadoUpload.url;
    }

    const postId = await bubbleCreate('post', {
      'Site': site_id,
      'Titulo': titulo,
      'Resumo': resumo || '',
      'Conteudo': conteudo,
      'Imagem URL': imagemFinal,
      'Is Active': true,
      'Created Date': new Date().toISOString()
    });

    return res.json({ status: 'success', response: { post_id: postId } });
  } catch (erro) {
    console.error('Erro em /blog-post-criar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível criar o artigo.' });
  }
});

// Lista TODOS os posts de um site (activos e inactivos), para o dono gerir.
app.post('/blog-meus-posts', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    if (!owner || !site_id) {
      return res.json({ status: 'error', message: 'Faltam dados: owner e site_id são obrigatórios.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para ver os artigos deste projecto.' });
    }

    const posts = await bubbleList(
      'post',
      [{ key: 'Site', constraint_type: 'equals', value: site_id }],
      'Created Date',
      true
    );

    const lista = posts.map(p => ({
      id: p._id,
      titulo: p['Titulo'],
      resumo: p['Resumo'] || '',
      conteudo: p['Conteudo'] || '',
      imagem: p['Imagem URL'] || '',
      activo: !!p['Is Active']
    }));

    return res.json({ status: 'success', response: { posts: lista } });
  } catch (erro) {
    console.error('Erro em /blog-meus-posts:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os artigos.' });
  }
});

// Edita um artigo existente (incluindo activar/desactivar e trocar a
// imagem). Só o dono do site pode editar.
app.post('/blog-post-editar', async (req, res) => {
  try {
    const { owner, post_id, titulo, resumo, conteudo, imagem_url, imagem_data_url, activo } = req.body;
    if (!owner || !post_id) {
      return res.json({ status: 'error', message: 'Faltam dados: post_id é obrigatório.' });
    }

    const post = await bubbleGet('post', post_id);
    if (!post) {
      return res.json({ status: 'error', message: 'Artigo não encontrado.' });
    }

    const site = await bubbleGet('site', post['Site']);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para editar este artigo.' });
    }

    const dados = {};
    if (titulo !== undefined) dados['Titulo'] = titulo;
    if (resumo !== undefined) dados['Resumo'] = resumo;
    if (conteudo !== undefined) dados['Conteudo'] = conteudo;
    if (activo !== undefined) dados['Is Active'] = !!activo;
    if (imagem_data_url) {
      const resultadoUpload = await uploadImagemBase64('posts', owner, imagem_data_url);
      if (resultadoUpload.erro) {
        return res.json({ status: 'error', message: resultadoUpload.erro });
      }
      if (resultadoUpload.url) dados['Imagem URL'] = resultadoUpload.url;
    } else if (imagem_url !== undefined) {
      dados['Imagem URL'] = imagem_url;
    }

    await bubblePatch('post', post_id, dados);
    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /blog-post-editar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível actualizar o artigo.' });
  }
});

// ======================================================
// Formulário de Contacto - aplica-se a TODOS os sites gerados, seja
// qual for o tipo (ver injectarContactoSeNecessario mais acima)
// ======================================================

// Rota PÚBLICA - chamada pelo contacto-form.js de dentro do site gerado,
// sem login nenhum (quem escreve é um visitante do site, não um
// utilizador do Daniel IA). Descobre para que email mandar: primeiro o
// "Email Contacto" configurado no projecto, senão o email da conta do
// dono do site.
app.post('/contacto-enviar', async (req, res) => {
  try {
    const { site_id, nome, email_remetente, mensagem } = req.body;

    if (!site_id || !nome || !email_remetente || !mensagem) {
      return res.json({ status: 'error', message: 'Faltam dados: nome, email e mensagem são obrigatórios.' });
    }
    if (String(nome).length > 120 || String(email_remetente).length > 160 || String(mensagem).length > 2000) {
      return res.json({ status: 'error', message: 'Um dos campos é demasiado longo.' });
    }
    if (email_remetente.indexOf('@') < 1) {
      return res.json({ status: 'error', message: 'O email não é válido.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site) {
      return res.json({ status: 'error', message: 'Projecto não encontrado.' });
    }

    let emailDestino = site['Email Contacto'] || '';
    if (!emailDestino) {
      const dono = await bubbleGet('user', site['Owner']);
      emailDestino =
        (dono && dono.email) ||
        (dono && dono.authentication && dono.authentication.email && dono.authentication.email.email) ||
        '';
    }

    if (!emailDestino) {
      console.error('Erro em /contacto-enviar: site sem Email Contacto e sem email de conta (site ' + site_id + ').');
      return res.json({ status: 'error', message: 'Este site ainda não tem um email de contacto configurado.' });
    }

    const nomeSite = site['Nome'] || 'o teu site';
    await enviarEmail(
      emailDestino,
      'Nova mensagem de ' + nome + ' - ' + nomeSite,
      templateEmailContacto(nomeSite, nome, email_remetente, mensagem),
      email_remetente
    );

    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /contacto-enviar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível enviar a mensagem.' });
  }
});

// Rota AUTENTICADA (owner) - chamada do dashboard, para o dono do
// projecto configurar/alterar para que email quer receber as mensagens
// de contacto deste site. Enviar email_contacto: '' limpa o campo
// (passa a usar o email da conta como fallback, ver /contacto-enviar).
app.post('/contacto-guardar', async (req, res) => {
  try {
    const { owner, site_id, email_contacto } = req.body;
    if (!owner || !site_id) {
      return res.json({ status: 'error', message: 'Faltam dados: site_id é obrigatório.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para alterar este projecto.' });
    }

    const emailLimpo = String(email_contacto || '').trim();
    if (emailLimpo && emailLimpo.indexOf('@') < 1) {
      return res.json({ status: 'error', message: 'O email não é válido.' });
    }

    await bubblePatch('site', site_id, { 'Email Contacto': emailLimpo });
    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /contacto-guardar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível guardar o email de contacto.' });
  }
});

// ======================================================
// Galeria - Álbuns e Media (fotos + vídeo) para fotógrafos/videógrafos
// ======================================================

// Lista os álbuns ACTIVOS de um site, com uma "capa" cada (o primeiro
// ficheiro do álbum) - usado na página pública que os clientes do
// fotógrafo vão ver.
app.post('/galeria-albuns', async (req, res) => {
  try {
    const { site_id } = req.body;
    if (!site_id) {
      return res.json({ status: 'error', message: 'Falta o site_id.' });
    }

    const albuns = await bubbleList(
      'album',
      [
        { key: 'Site', constraint_type: 'equals', value: site_id },
        { key: 'Is Active', constraint_type: 'equals', value: true }
      ],
      'Created Date',
      true
    );

    const lista = [];
    for (const a of albuns) {
      const medias = await bubbleList(
        'media',
        [{ key: 'Album', constraint_type: 'equals', value: a._id }],
        'Ordem',
        false
      );
      const capaMedia = medias.find(m => m['Status'] === 'Pronto') || null;
      lista.push({
        id: a._id,
        titulo: a['Titulo'],
        descricao: a['Descricao'] || '',
        capa: capaMedia ? (capaMedia['Tipo'] === 'video' ? (capaMedia['Thumbnail URL'] || '') : (capaMedia['URL'] || '')) : '',
        total_media: medias.length
      });
    }

    return res.json({ status: 'success', response: { albuns: lista } });
  } catch (erro) {
    console.error('Erro em /galeria-albuns:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os álbuns.' });
  }
});

// Mostra o conteúdo de UM álbum para quem visita o site (sem login,
// usada pelo galeria-viewer.js) - só álbuns activos, e só ficheiros já
// prontos (fotos e vídeos ainda "A processar" ou "Erro" não aparecem ao
// público). Equivalente, para a Galeria, ao que /galeria-album-media já
// faz para o dono.
app.post('/galeria-album-publico', async (req, res) => {
  try {
    const { site_id, album_id } = req.body;
    if (!site_id || !album_id) {
      return res.json({ status: 'error', message: 'Faltam dados: site_id e album_id são obrigatórios.' });
    }

    const album = await bubbleGet('album', album_id);
    if (!album || album['Site'] !== site_id || !album['Is Active']) {
      return res.json({ status: 'error', message: 'Álbum não encontrado.' });
    }

    const medias = await bubbleList(
      'media',
      [{ key: 'Album', constraint_type: 'equals', value: album_id }],
      'Ordem',
      false
    );

    const lista = medias
      .filter(m => m['Status'] === 'Pronto')
      .map(m => ({
        id: m._id,
        tipo: m['Tipo'],
        url: m['URL'] || '',
        thumbnail: m['Thumbnail URL'] || '',
        ordem: m['Ordem'] || 0
      }));

    return res.json({
      status: 'success',
      response: {
        album: { id: album._id, titulo: album['Titulo'], descricao: album['Descricao'] || '' },
        media: lista
      }
    });
  } catch (erro) {
    console.error('Erro em /galeria-album-publico:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar este álbum.' });
  }
});

// Cria um álbum novo (ex: "Casamento Ana & Jorge"). Só o dono do site.
app.post('/galeria-album-criar', async (req, res) => {
  try {
    const { owner, site_id, titulo, descricao } = req.body;
    if (!owner || !site_id || !titulo) {
      return res.json({ status: 'error', message: 'Faltam dados: site_id e titulo são obrigatórios.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para adicionar álbuns a este projecto.' });
    }

    const albumId = await bubbleCreate('album', {
      'Site': site_id,
      'Titulo': titulo,
      'Descricao': descricao || '',
      'Is Active': true,
      'Created Date': new Date().toISOString()
    });

    return res.json({ status: 'success', response: { album_id: albumId } });
  } catch (erro) {
    console.error('Erro em /galeria-album-criar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível criar o álbum.' });
  }
});

// Lista TODOS os álbuns de um site (activos e inactivos), com o número de
// ficheiros em cada um - para o dono gerir.
app.post('/galeria-meus-albuns', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    if (!owner || !site_id) {
      return res.json({ status: 'error', message: 'Faltam dados: owner e site_id são obrigatórios.' });
    }

    const site = await bubbleGet('site', site_id);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para ver os álbuns deste projecto.' });
    }

    const albuns = await bubbleList(
      'album',
      [{ key: 'Site', constraint_type: 'equals', value: site_id }],
      'Created Date',
      true
    );

    const lista = [];
    for (const a of albuns) {
      const total = await bubbleCount('media', [{ key: 'Album', constraint_type: 'equals', value: a._id }]);
      lista.push({
        id: a._id,
        titulo: a['Titulo'],
        descricao: a['Descricao'] || '',
        activo: !!a['Is Active'],
        total_media: total
      });
    }

    // Espaço usado pela conta toda (não só a Galeria - ver nota nos
    // helpers de espaço), para mostrar um medidor nesta página.
    const user = await bubbleGet('user', owner);
    const plano = user && user['Plan'] ? await bubbleGet('plan', user['Plan']) : null;
    const espaco = {
      usado_bytes: user ? (user['Storage Used Bytes'] || 0) : 0,
      limite_bytes: plano ? (plano['Storage Limit Bytes'] || 0) : 0
    };

    return res.json({ status: 'success', response: { albuns: lista, espaco: espaco } });
  } catch (erro) {
    console.error('Erro em /galeria-meus-albuns:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os álbuns.' });
  }
});

// Edita um álbum existente (título, descrição, activar/desactivar). Só o
// dono do site.
app.post('/galeria-album-editar', async (req, res) => {
  try {
    const { owner, album_id, titulo, descricao, activo } = req.body;
    if (!owner || !album_id) {
      return res.json({ status: 'error', message: 'Faltam dados: album_id é obrigatório.' });
    }

    const album = await bubbleGet('album', album_id);
    if (!album) {
      return res.json({ status: 'error', message: 'Álbum não encontrado.' });
    }
    const site = await bubbleGet('site', album['Site']);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para editar este álbum.' });
    }

    const dados = {};
    if (titulo !== undefined) dados['Titulo'] = titulo;
    if (descricao !== undefined) dados['Descricao'] = descricao;
    if (activo !== undefined) dados['Is Active'] = !!activo;

    await bubblePatch('album', album_id, dados);
    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /galeria-album-editar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível actualizar o álbum.' });
  }
});

// Lista as fotos/vídeos de um álbum, ordenados - para o dono gerir dentro
// do álbum.
app.post('/galeria-album-media', async (req, res) => {
  try {
    const { owner, album_id } = req.body;
    if (!owner || !album_id) {
      return res.json({ status: 'error', message: 'Faltam dados: owner e album_id são obrigatórios.' });
    }

    const album = await bubbleGet('album', album_id);
    if (!album) {
      return res.json({ status: 'error', message: 'Álbum não encontrado.' });
    }
    const site = await bubbleGet('site', album['Site']);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para ver este álbum.' });
    }

    const medias = await bubbleList(
      'media',
      [{ key: 'Album', constraint_type: 'equals', value: album_id }],
      'Ordem',
      false
    );

    const lista = medias.map(m => ({
      id: m._id,
      tipo: m['Tipo'],
      url: m['URL'] || '',
      thumbnail: m['Thumbnail URL'] || '',
      status: m['Status'] || '',
      ordem: m['Ordem'] || 0
    }));

    return res.json({
      status: 'success',
      response: {
        album: {
          id: album._id,
          site_id: album['Site'],
          titulo: album['Titulo'],
          descricao: album['Descricao'] || '',
          activo: !!album['Is Active']
        },
        media: lista
      }
    });
  } catch (erro) {
    console.error('Erro em /galeria-album-media:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os ficheiros deste álbum.' });
  }
});

// Adiciona uma foto a um álbum - upload a sério (ficheiro -> base64 ->
// Bunny Storage), tal como os Trabalhos do Portefólio e os Posts do Blog.
app.post('/galeria-foto-adicionar', async (req, res) => {
  try {
    const { owner, album_id, imagem_data_url } = req.body;
    if (!owner || !album_id || !imagem_data_url) {
      return res.json({ status: 'error', message: 'Faltam dados: album_id e imagem_data_url são obrigatórios.' });
    }

    const album = await bubbleGet('album', album_id);
    if (!album) {
      return res.json({ status: 'error', message: 'Álbum não encontrado.' });
    }
    const site = await bubbleGet('site', album['Site']);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para adicionar fotos a este álbum.' });
    }

    const resultadoUpload = await uploadImagemBase64('galeria', owner, imagem_data_url);
    if (resultadoUpload.erro) {
      return res.json({ status: 'error', message: resultadoUpload.erro });
    }
    if (!resultadoUpload.url) {
      return res.json({ status: 'error', message: 'Essa imagem não é válida.' });
    }

    const total = await bubbleCount('media', [{ key: 'Album', constraint_type: 'equals', value: album_id }]);
    const mediaId = await bubbleCreate('media', {
      'Album': album_id,
      'Tipo': 'foto',
      'URL': resultadoUpload.url,
      'Status': 'Pronto',
      'Ordem': total,
      'Tamanho Bytes': resultadoUpload.bytes || 0,
      'Created Date': new Date().toISOString()
    });

    return res.json({ status: 'success', response: { media_id: mediaId } });
  } catch (erro) {
    console.error('Erro em /galeria-foto-adicionar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível adicionar a foto.' });
  }
});

// Inicia o envio de um vídeo: cria o espaço no Bunny Stream, regista já o
// registo de Media (Status "A processar") e devolve tudo o que a página
// precisa para fazer o upload por TUS directamente para o Bunny (o
// ficheiro de vídeo nunca passa por este container).
app.post('/galeria-video-iniciar', async (req, res) => {
  try {
    const { owner, album_id, titulo } = req.body;
    if (!owner || !album_id) {
      return res.json({ status: 'error', message: 'Falta o album_id.' });
    }
    if (!STREAM_LIBRARY || !STREAM_KEY || !STREAM_CDN) {
      return res.json({ status: 'error', message: 'O envio de vídeo ainda não está configurado neste servidor.' });
    }

    const album = await bubbleGet('album', album_id);
    if (!album) {
      return res.json({ status: 'error', message: 'Álbum não encontrado.' });
    }
    const site = await bubbleGet('site', album['Site']);
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para adicionar vídeos a este álbum.' });
    }

    // Só sabemos o tamanho real do vídeo depois do envio terminar (o
    // ficheiro sobe directamente do browser para o Bunny, nunca passa por
    // aqui), por isso este é só um portão: se a conta já estiver sem
    // espaço, nem deixa começar. O espaço é mesmo somado mais tarde, em
    // /galeria-video-estado, quando soubermos o tamanho a sério.
    const espaco = await verificarEspaco(owner, 0);
    if (!espaco.ok) {
      return res.json({ status: 'error', message: espaco.message });
    }

    const videoId = await criarVideoBunnyStream(titulo || album['Titulo'] || 'video');
    const expira = Math.floor(Date.now() / 1000) + 3600; // 1 hora para completar o upload
    const assinatura = assinaturaTusBunny(videoId, expira);

    const total = await bubbleCount('media', [{ key: 'Album', constraint_type: 'equals', value: album_id }]);
    const mediaId = await bubbleCreate('media', {
      'Album': album_id,
      'Tipo': 'video',
      'URL': '',
      'Bunny Video ID': videoId,
      'Thumbnail URL': '',
      'Status': 'A processar',
      'Ordem': total,
      'Created Date': new Date().toISOString()
    });

    return res.json({
      status: 'success',
      response: {
        media_id: mediaId,
        video_id: videoId,
        library_id: STREAM_LIBRARY,
        signature: assinatura,
        expire: expira,
        tus_endpoint: 'https://video.bunnycdn.com/tusupload'
      }
    });
  } catch (erro) {
    console.error('Erro em /galeria-video-iniciar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível iniciar o envio do vídeo.' });
  }
});

// Consulta o estado da conversão de um vídeo e actualiza o registo de
// Media quando terminar (ou falhar). A página de gestão chama isto de
// poucos em poucos segundos enquanto o vídeo não estiver "Pronto".
app.post('/galeria-video-estado', async (req, res) => {
  try {
    const { owner, media_id } = req.body;
    if (!owner || !media_id) {
      return res.json({ status: 'error', message: 'Falta o media_id.' });
    }

    const media = await bubbleGet('media', media_id);
    if (!media) {
      return res.json({ status: 'error', message: 'Vídeo não encontrado.' });
    }
    const album = await bubbleGet('album', media['Album']);
    const site = album ? await bubbleGet('site', album['Site']) : null;
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para ver este vídeo.' });
    }

    if (media['Status'] === 'Pronto' || media['Status'] === 'Erro') {
      return res.json({
        status: 'success',
        response: { estado: media['Status'], url: media['URL'] || '', thumbnail: media['Thumbnail URL'] || '' }
      });
    }

    const videoId = media['Bunny Video ID'];
    const infoVideo = await estadoVideoBunnyStream(videoId);

    let novoEstado = 'A processar';
    const dados = {};
    if (infoVideo.status === 4) {
      novoEstado = 'Pronto';
      dados['Status'] = 'Pronto';
      dados['URL'] = `https://${STREAM_CDN}/${videoId}/playlist.m3u8`;
      dados['Thumbnail URL'] = `https://${STREAM_CDN}/${videoId}/thumbnail.jpg`;
      // Só agora sabemos o tamanho real do vídeo (o Bunny devolve-o depois
      // de pronto) - é agora que entra na conta do espaço usado.
      const bytesVideo = infoVideo.storageSize || 0;
      dados['Tamanho Bytes'] = bytesVideo;
      await somarEspacoUsado(owner, bytesVideo);
    } else if (infoVideo.status === 5 || infoVideo.status === 6) {
      novoEstado = 'Erro';
      dados['Status'] = 'Erro';
    }
    if (Object.keys(dados).length > 0) {
      await bubblePatch('media', media_id, dados);
    }

    return res.json({
      status: 'success',
      response: {
        estado: novoEstado,
        progresso: infoVideo.encodeProgress || 0,
        url: dados['URL'] || '',
        thumbnail: dados['Thumbnail URL'] || ''
      }
    });
  } catch (erro) {
    console.error('Erro em /galeria-video-estado:', erro);
    return res.json({ status: 'error', message: 'Não foi possível consultar o estado do vídeo.' });
  }
});

// Apaga uma foto ou vídeo. Para vídeo, apaga também do Bunny Stream.
app.post('/galeria-media-apagar', async (req, res) => {
  try {
    const { owner, media_id } = req.body;
    if (!owner || !media_id) {
      return res.json({ status: 'error', message: 'Falta o media_id.' });
    }

    const media = await bubbleGet('media', media_id);
    if (!media) {
      return res.json({ status: 'error', message: 'Ficheiro não encontrado.' });
    }
    const album = await bubbleGet('album', media['Album']);
    const site = album ? await bubbleGet('site', album['Site']) : null;
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para apagar este ficheiro.' });
    }

    if (media['Tipo'] === 'video' && media['Bunny Video ID']) {
      await apagarVideoBunnyStream(media['Bunny Video ID']);
    }
    await subtrairEspacoUsado(owner, media['Tamanho Bytes'] || 0);
    await bubbleDelete('media', media_id);

    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /galeria-media-apagar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível apagar o ficheiro.' });
  }
});

// Cria uma encomenda. O passo mais importante aqui, por segurança: o valor
// total NUNCA vem do que o browser envia - é sempre recalculado aqui, a
// partir dos preços reais guardados nos registos de Produto. Assim,
// ninguém consegue alterar o preço antes de pagar.
app.post('/loja-encomenda', async (req, res) => {
  try {
    const { site_id, cliente_nome, cliente_telefone, cliente_email, itens } = req.body;
    const notas = String(req.body.notas || '').trim().slice(0, 500);
    const idiomaCliente = normalizarIdioma(req.body.idioma);

    if (!site_id || !cliente_nome || !cliente_telefone || !Array.isArray(itens) || itens.length === 0) {
      return res.json({ status: 'error', message: 'Faltam dados: site_id, cliente_nome, cliente_telefone e itens são obrigatórios.' });
    }
    // Email é opcional - só serve para mandar o recibo, se a pessoa o
    // der. Validação simples, nunca bloqueia a compra por causa disto.
    const emailValido = cliente_email && /\S+@\S+\.\S+/.test(String(cliente_email).trim());

    // Buscar os produtos realmente activos desta loja - a fonte da verdade
    // para os preços é sempre esta, nunca o que vier do pedido.
    const produtosAtivos = await bubbleList(
      'produto',
      [
        { key: 'Site', constraint_type: 'equals', value: site_id },
        { key: 'Is Active', constraint_type: 'equals', value: true }
      ]
    );
    const porId = {};
    produtosAtivos.forEach(p => { porId[p._id] = p; });

    let valorTotal = 0;
    const itensCalculados = [];
    const pedidoPorChave = {};
    for (const item of itens.slice(0, 50)) {
      const produto = porId[item && item.produto_id];
      if (!produto) {
        return res.json({ status: 'error', message: 'Um dos produtos já não está disponível nesta loja.' });
      }
      const quantidade = Math.max(1, Math.min(99, parseInt(item.quantidade, 10) || 1));
      const extra = extraProduto(produto);
      let precoUnitario = Number(produto['Preco MZN']) || 0;
      let nomeItem = produto['Nome'];
      let varIdx = null;
      if (extra.variantes.length) {
        varIdx = parseInt(item.variante, 10);
        const v = extra.variantes[varIdx];
        if (isNaN(varIdx) || !v) {
          return res.json({ status: 'error', codigo: 'opcao', nome: produto['Nome'], message: 'Escolhe uma opção para "' + produto['Nome'] + '".' });
        }
        if (v.preco > 0) precoUnitario = v.preco;
        nomeItem = produto['Nome'] + ' (' + v.nome + ')';
      }
      // Stock: soma as quantidades do mesmo produto/opção no pedido.
      const disponivel = varIdx !== null ? extra.variantes[varIdx].stock : extra.stock;
      const chave = produto._id + ':' + varIdx;
      pedidoPorChave[chave] = (pedidoPorChave[chave] || 0) + quantidade;
      if (disponivel !== null && pedidoPorChave[chave] > disponivel) {
        return res.json({
          status: 'error', codigo: 'stock', nome: nomeItem, disponivel,
          message: disponivel === 0 ? '"' + nomeItem + '" está esgotado.' : 'Só restam ' + disponivel + ' de "' + nomeItem + '".'
        });
      }
      valorTotal += precoUnitario * quantidade;
      itensCalculados.push({
        produto_id: produto._id,
        nome: nomeItem,
        preco_unitario: precoUnitario,
        quantidade,
        variante: varIdx
      });
    }

    if (valorTotal <= 0) {
      return res.json({ status: 'error', message: 'O valor da encomenda tem de ser maior que zero.' });
    }

    // Modo efectivo da loja: decide se a encomenda fica à espera de um
    // pagamento online (Daniel IA) ou se é registada já como recebida.
    const site = await bubbleGet('site', site_id);
    if (!site) {
      return res.json({ status: 'error', message: 'Loja não encontrada.' });
    }
    const { modo, cfg } = await modoEfectivoLoja(site);
    const estadoInicial = modo === 'daniel' ? 'Pendente' : (modo === 'manual' ? 'Aguarda pagamento' : 'Encomenda recebida');

    const encomendaId = await bubbleCreate('encomenda', {
      'Site': site_id,
      'Produtos Json': JSON.stringify(itensCalculados),
      'Cliente Nome': String(cliente_nome).trim().slice(0, 100),
      'Cliente Telefone': String(cliente_telefone).trim().slice(0, 20),
      'Cliente Email': emailValido ? String(cliente_email).trim() : '',
      'Valor Total': valorTotal,
      'Metodo': modo === 'daniel' ? '' : modo,
      'ID Pagamento': '',
      'Estado': estadoInicial,
      'Transaction ID': '',
      'Webhook Processado': false,
      'Notas': notas
    });

    const referencia = referenciaEncomenda(encomendaId);
    const resposta = { encomenda_id: encomendaId, valor_total: valorTotal, modo, referencia };

    if (modo !== 'daniel') {
      // Sem pagamento online: o stock desconta já, e o dono recebe a
      // encomenda por email. (Com pagamento online, desconta quando o
      // pagamento é confirmado - ver o webhook.)
      await baixarStock(itensCalculados);
      avisarEncomenda(site, encomendaId, modo, cfg, idiomaCliente);
      if (modo === 'manual') {
        resposta.manual = { mpesa: cfg.mpesa, emola: cfg.emola, titular: cfg.titular };
      }
      if (cfg.whatsapp) {
        const W = TEXTOS_WHATSAPP_ENCOMENDA[idiomaCliente];
        const linhas = itensCalculados.map(i => '• ' + i.quantidade + 'x ' + i.nome + ' - ' + (i.preco_unitario * i.quantidade).toLocaleString('pt-PT') + ' MZN');
        const texto = W.ola + ' (' + referencia + '):\n\n' + linhas.join('\n')
          + '\n\n' + W.total + ': ' + valorTotal.toLocaleString('pt-PT') + ' MZN'
          + '\n\n' + W.nome + ': ' + String(cliente_nome).trim()
          + '\n' + W.telefone + ': ' + String(cliente_telefone).trim()
          + (notas ? '\n' + W.notas + ': ' + notas : '');
        resposta.whatsapp_url = 'https://wa.me/' + cfg.whatsapp + '?text=' + encodeURIComponent(texto);
      }
    }

    return res.json({ status: 'success', response: resposta });
  } catch (erro) {
    console.error('Erro em /loja-encomenda:', erro);
    return res.json({ status: 'error', message: 'Não foi possível criar a encomenda.' });
  }
});

// Inicia o pagamento de uma encomenda já criada - M-Pesa, e-Mola ou Cartão.
// Nunca recebe nem usa nenhum valor vindo do browser: o montante e o nome
// do cliente vêm sempre do registo da Encomenda, já calculados e
// guardados em /loja-encomenda.
app.post('/loja-pagar', async (req, res) => {
  try {
    const { encomenda_id, metodo } = req.body;

    if (!encomenda_id || !metodo) {
      return res.json({ status: 'error', message: 'Faltam dados: encomenda_id e metodo são obrigatórios.' });
    }
    const metodosValidos = ['mpesa', 'emola', 'cartao'];
    if (!metodosValidos.includes(metodo)) {
      return res.json({ status: 'error', message: 'Método de pagamento inválido.' });
    }

    const encomenda = await bubbleGet('encomenda', encomenda_id);
    if (!encomenda) {
      return res.json({ status: 'error', message: 'Encomenda não encontrada.' });
    }
    if (encomenda['Estado'] !== 'Pendente') {
      return res.json({ status: 'error', message: 'Esta encomenda já foi paga ou já não está disponível para pagamento.' });
    }

    // Pagamentos pela conta do Daniel IA só para lojas com KYC aprovado.
    const sitePagar = await bubbleGet('site', encomenda['Site']).catch(() => null);
    const modoPagar = sitePagar ? (await modoEfectivoLoja(sitePagar)).modo : 'pedido';
    if (modoPagar !== 'daniel') {
      return res.json({ status: 'error', message: 'Esta loja não aceita pagamentos online neste momento.' });
    }

    const valor = encomenda['Valor Total'];
    const telefone = encomenda['Cliente Telefone'];
    const nome = encomenda['Cliente Nome'];
    const token = await mozpaymentToken();

    // ---- M-Pesa / e-Mola ----
    if (metodo === 'mpesa' || metodo === 'emola') {
      const respMoz = await fetch('https://mozpayment.co.mz/api/1.1/wf/payment', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: MOZPAYMENT_WALLET,
          payment_method: metodo,
          amount: String(valor),
          number: telefone,
          name: nome
        })
      });
      const jsonMoz = await respMoz.json().catch(() => ({}));
      if (!respMoz.ok) {
        throw new Error('Pedido de pagamento falhou: ' + respMoz.status + ' ' + JSON.stringify(jsonMoz));
      }
      // Procuramos o identificador em vários campos possíveis - a
      // documentação nem sempre bate certo com a resposta real.
      const idPagamento = jsonMoz.idpayment || jsonMoz.id_payment ||
        (jsonMoz.response && (jsonMoz.response.idpayment || jsonMoz.response.id_payment)) || '';
      if (!idPagamento) {
        throw new Error('A MozPayment não devolveu nenhum idpayment: ' + JSON.stringify(jsonMoz));
      }

      await bubblePatch('encomenda', encomenda_id, {
        'Metodo': metodo,
        'ID Pagamento': String(idPagamento)
      });

      return res.json({ status: 'success', response: { tipo: 'mobile', idpayment: String(idPagamento) } });
    }

    // ---- Cartão (Visa / Mastercard) ----
    const returnUrl = `${SELF_URL}/loja-obrigado?encomenda_id=${encomenda_id}`;
    const respCartao = await fetch('https://mozpayment.co.mz/api/1.1/wf/bankpayment', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valor: String(valor),
        nome_cliente: nome,
        carteira: MOZPAYMENT_WALLET,
        nome_producto: 'Encomenda Daniel IA',
        return_url: returnUrl
      })
    });
    const jsonCartao = await respCartao.json().catch(() => ({}));
    if (!respCartao.ok) {
      throw new Error('Pedido de pagamento por cartão falhou: ' + respCartao.status + ' ' + JSON.stringify(jsonCartao));
    }
    // Confirmado a testar: a MozPayment devolve o link em "payment_url",
    // dentro de "response" - e o session_id vem só como parâmetro desse
    // link, não como campo separado.
    const checkoutUrl = jsonCartao.payment_url || jsonCartao.url || jsonCartao.checkout_url ||
      (jsonCartao.response && (jsonCartao.response.payment_url || jsonCartao.response.url || jsonCartao.response.checkout_url)) || '';
    if (!checkoutUrl) {
      throw new Error('A MozPayment não devolveu nenhum link de checkout: ' + JSON.stringify(jsonCartao));
    }

    let sessionId = jsonCartao.session_id || (jsonCartao.response && jsonCartao.response.session_id) || '';
    if (!sessionId) {
      try {
        sessionId = new URL(checkoutUrl).searchParams.get('session_id') || '';
      } catch (e) {
        // Se o link vier numa forma inesperada, seguimos sem session_id.
      }
    }
    // Se mesmo assim não conseguirmos extrair o session_id, guardamos o
    // link completo - é melhor termos algum identificador do que nenhum.
    const identificador = sessionId || checkoutUrl;

    await bubblePatch('encomenda', encomenda_id, {
      'Metodo': 'cartao',
      'ID Pagamento': String(identificador)
    });

    return res.json({ status: 'success', response: { tipo: 'cartao', checkout_url: checkoutUrl, embutivel: await checkoutEmbutivel(checkoutUrl) } });

  } catch (erro) {
    console.error('Erro em /loja-pagar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível iniciar o pagamento. Tenta novamente.' });
  }
});

// Consulta o estado de uma encomenda - usada pela página de checkout para
// ir verificando se o pagamento já foi confirmado pelo webhook.
app.post('/loja-estado', async (req, res) => {
  try {
    const { encomenda_id } = req.body;
    if (!encomenda_id) {
      return res.json({ status: 'error', message: 'Falta o encomenda_id.' });
    }
    const encomenda = await bubbleGet('encomenda', encomenda_id);
    if (!encomenda) {
      return res.json({ status: 'error', message: 'Encomenda não encontrada.' });
    }
    return res.json({
      status: 'success',
      response: {
        estado: encomenda['Estado'],
        valor_total: encomenda['Valor Total']
      }
    });
  } catch (erro) {
    console.error('Erro em /loja-estado:', erro);
    return res.json({ status: 'error', message: 'Não foi possível consultar o estado.' });
  }
});

// Página de "obrigado" para onde o cliente volta depois de pagar com
// cartão (é o "return_url" que damos à MozPayment em /loja-pagar). Não
// precisa de nenhuma página no Bubble - o próprio container devolve o
// HTML directamente. Vai consultando /loja-estado sozinha, até o webhook
// confirmar o pagamento, e depois volta para a loja.
app.get('/loja-obrigado', async (req, res) => {
  const encomendaId = String(req.query.encomenda_id || '');
  let nomeLoja = 'a loja';
  let cdnUrl = '';

  if (encomendaId) {
    try {
      const encomenda = await bubbleGet('encomenda', encomendaId);
      if (encomenda && encomenda['Site']) {
        const site = await bubbleGet('site', encomenda['Site']);
        if (site) {
          nomeLoja = site['Nome'] || nomeLoja;
          cdnUrl = site['CDN URL'] || '';
        }
      }
    } catch (erro) {
      console.error('Erro ao carregar dados para /loja-obrigado:', erro);
    }
  }

  const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Obrigado</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&family=Sora:wght@700&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#07030C;
    --card:#110A1B;
    --border:#2A1B3D;
    --text:#F6F2FB;
    --text-dim:#A89BBA;
    --accent-1:#B4F02B;
    --accent-2:#89C804;
    --success:#89C804;
    --error:#FF5C7A;
    --warning:#F5A623;
  }
  *{box-sizing:border-box;}
  body{
    margin:0;
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    font-family:"Manrope",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:radial-gradient(900px 520px at 15% -12%, rgba(67,9,96,0.9), rgba(67,9,96,0) 62%),radial-gradient(700px 420px at 105% 105%, rgba(137,200,4,0.10), rgba(137,200,4,0) 60%),var(--bg);
    color:var(--text);
    padding:24px;
  }
  .caixa{
    background:var(--card);
    border:1px solid var(--border);
    border-radius:16px;
    padding:40px 32px;
    max-width:380px;
    width:100%;
    text-align:center;
  }
  .icone{
    width:56px;height:56px;
    border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    margin:0 auto 20px auto;
  }
  .icone.a-confirmar{background:rgba(245,166,35,0.14);}
  .icone.pago{background:rgba(137,200,4,0.14);}
  .icone.erro{background:rgba(255,92,122,0.14);}
  .spinner{
    width:24px;height:24px;
    border-radius:50%;
    border:3px solid var(--border);
    border-top-color:var(--warning);
    animation:girar .8s linear infinite;
  }
  @keyframes girar{to{transform:rotate(360deg);}}
  h1{font-size:18px;margin:0 0 8px 0;font-family:"Sora","Manrope",sans-serif;letter-spacing:-0.02em;}
  p{font-size:13px;color:var(--text-dim);margin:0 0 24px 0;line-height:1.5;}
  .btn{
    display:inline-block;
    background:linear-gradient(135deg,#C8F84A 0%,#89C804 100%);
    color:#140620;
    box-shadow:0 8px 24px rgba(137,200,4,0.30);
    border:none;
    border-radius:10px;
    padding:11px 22px;
    font-size:13px;
    font-weight:600;
    cursor:pointer;
    text-decoration:none;
  }
</style>
</head>
<body>
  <div class="caixa">
    <div class="icone a-confirmar" id="icone">
      <div class="spinner"></div>
    </div>
    <h1 id="titulo">A confirmar o teu pagamento...</h1>
    <p id="texto">Isto demora só alguns segundos. Não feches esta página.</p>
    <a class="btn" id="btn-voltar" href="${escaparHtml(cdnUrl || '#')}" style="display:none;">Voltar a ${escaparHtml(nomeLoja)}</a>
  </div>

<script>
var ENCOMENDA_ID = ${JSON.stringify(encomendaId)};
var EMBUTIDA = false;
try { EMBUTIDA = window.self !== window.top; } catch (e) { EMBUTIDA = true; }
function avisarPai(estado){ try { window.parent.postMessage({ daniel: 'pagamento', estado: estado }, '*'); } catch (e) {} }
if (EMBUTIDA) {
  avisarPai('voltou');
  var estiloEmb = document.createElement('style');
  estiloEmb.textContent = 'body{background:transparent!important;padding:16px!important;min-height:0!important;}body>svg{display:none!important;}#btn-voltar{display:none!important;}.caixa{border:none!important;background:transparent!important;}';
  document.head.appendChild(estiloEmb);
}
var CDN_URL = ${JSON.stringify(cdnUrl)};
var tentativas = 0;
var MAX_TENTATIVAS = 40;

function mostrarEstado(tipo, titulo, texto){
  var icone = document.getElementById('icone');
  icone.className = 'icone ' + tipo;
  if (tipo !== 'a-confirmar') {
    icone.innerHTML = '';
  }
  document.getElementById('titulo').textContent = titulo;
  document.getElementById('texto').textContent = texto;
  if (tipo === 'pago') {
    document.getElementById('btn-voltar').style.display = 'inline-block';
  }
}

function verificar(){
  if (!ENCOMENDA_ID) {
    mostrarEstado('erro', 'Não encontrámos a tua encomenda', 'Volta à loja e tenta novamente.');
    return;
  }
  fetch('/loja-estado', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encomenda_id: ENCOMENDA_ID })
  }).then(function(r){ return r.json(); })
    .then(function(r){
      if (r.status === 'success' && r.response.estado === 'Pago') {
        mostrarEstado('pago', 'Pagamento confirmado!', 'Obrigado pela tua compra.');
        if (EMBUTIDA) { avisarPai('pago'); return; }
        if (CDN_URL) {
          setTimeout(function(){ window.location.href = CDN_URL; }, 4000);
        }
        return;
      }
      tentativas++;
      if (tentativas >= MAX_TENTATIVAS) {
        mostrarEstado('erro', 'Ainda a processar', 'O pagamento pode ainda estar a ser confirmado. Verifica mais tarde ou contacta a loja.');
        return;
      }
      setTimeout(verificar, 3000);
    })
    .catch(function(){
      tentativas++;
      if (tentativas >= MAX_TENTATIVAS) {
        mostrarEstado('erro', 'Não foi possível confirmar', 'Verifica a tua ligação e tenta novamente mais tarde.');
        return;
      }
      setTimeout(verificar, 3000);
    });
}

verificar();
</script>
</body>
</html>`;

  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
});

// ---- Webhook da MozPayment (loja/checkout da Daniel IA) ----
// Endereço secreto (em vez de assinatura, que a MozPayment não confirmou
// se envia) - só quem souber este URL exacto pode chamá-lo.
//
// Regras de confirmação, segundo a documentação da MozPayment:
//   - "status" tem de ser exactamente "completed"
//   - "reason" tem de bater certo com o identificador que nós próprios
//     criámos e guardámos em "ID Pagamento" (idpayment para M-Pesa/e-Mola,
//     session_id para cartão) - nunca confiamos num pagamento para uma
//     encomenda que não criámos nós.
// Além disso, confirmamos que o valor recebido bate certo com o valor
// guardado, e usamos "Webhook Processado" para nunca aplicar o mesmo
// pagamento duas vezes (idempotência), mesmo que a MozPayment reenvie o
// mesmo aviso.
app.post('/wh-loja-mz9k3f7xq2', async (req, res) => {
  console.log('Webhook da MozPayment (loja) recebido:', JSON.stringify(req.body));
  // Responder já 200 - é o que a generalidade dos serviços de pagamento
  // espera, mesmo que o processamento a seguir ainda demore um pouco.
  res.sendStatus(200);

  try {
    const body = req.body || {};
    const status = String(body.status || '').trim().toLowerCase();
    const identificador = body.reason || body.payment_id || body.idpayment || body.session_id || '';

    if (status !== 'completed') {
      console.log('Webhook ignorado - status não é "completed":', status);
      return;
    }
    if (!identificador) {
      console.log('Webhook ignorado - sem identificador ("reason") para encontrar a encomenda.');
      return;
    }

    const encomendas = await bubbleList('encomenda', [
      { key: 'ID Pagamento', constraint_type: 'equals', value: String(identificador) }
    ]);

    if (!encomendas || encomendas.length === 0) {
      console.log('Webhook ignorado - nenhuma encomenda encontrada com este identificador:', identificador);
      return;
    }

    const encomenda = encomendas[0];

    if (encomenda['Webhook Processado']) {
      console.log('Webhook ignorado - esta encomenda já tinha sido processada:', encomenda._id);
      return;
    }

    const valorRecebido = Number(body.amount);
    const valorEsperado = Number(encomenda['Valor Total']);
    if (!isNaN(valorRecebido) && Math.abs(valorRecebido - valorEsperado) > 0.01) {
      console.log('Webhook suspeito - valor não bate certo. Esperado:', valorEsperado, 'Recebido:', valorRecebido);
      return;
    }

    await bubblePatch('encomenda', encomenda._id, {
      'Estado': 'Pago',
      'Transaction ID': String(body.transaction_id || ''),
      'Webhook Processado': true
    });

    console.log('Encomenda marcada como paga:', encomenda._id);
    await baixarStock(lerJsonSeguro(encomenda['Produtos Json'], []));

    // Avisar o dono da loja (não bloqueia nada se falhar).
    try {
      const siteDono = encomenda['Site'] ? await bubbleGet('site', encomenda['Site']) : null;
      if (siteDono) avisarEncomenda(siteDono, encomenda._id, 'daniel', configLoja(siteDono));
    } catch (e) {
      console.error('Aviso ao dono falhou:', e.message);
    }

    // ---- Recibo por email ao comprador (não bloqueia nem desfaz nada se falhar) ----
    try {
      const emailCliente = encomenda['Cliente Email'];
      if (emailCliente) {
        const site = encomenda['Site'] ? await bubbleGet('site', encomenda['Site']) : null;
        const nomeLoja = (site && site['Nome']) || 'a tua loja';
        let itens = [];
        try { itens = JSON.parse(encomenda['Produtos Json'] || '[]'); } catch (e) { itens = []; }
        await enviarEmail(
          emailCliente,
          `O teu recibo - ${nomeLoja}`,
          templateEmailReciboLoja(
            encomenda['Cliente Nome'],
            nomeLoja,
            itens,
            encomenda['Valor Total'],
            encomenda['Metodo'],
            identificador,
            new Date()
          )
        );
      }
    } catch (erroEmail) {
      console.error('Encomenda paga, mas o email de recibo falhou:', erroEmail);
    }
  } catch (erro) {
    console.error('Erro ao processar webhook da loja:', erro);
  }
});

// ======================================================
// Assinatura de planos pagos da própria Daniel IA
// ======================================================
// Mesmo padrão exacto do pagamento das lojas (/loja-pagar, /loja-estado,
// /loja-obrigado, webhook) - só que aqui quem paga é o próprio dono da
// conta Daniel IA, para subir de plano, e no fim quem é actualizado é o
// seu User (campo Plan), não um Site.
//
// Data type nova no Bubble, "Assinatura": User, Plano, Valor MZN, Metodo,
// ID Pagamento, Estado (Pendente/Pago), Transaction ID, Webhook Processado,
// Created Date - exactamente os mesmos papéis dos campos de "Encomenda".
// Pressupõe que o tipo Plan tem um campo "Price MZN" (number) com o preço
// mensal - se esse campo ainda não existir no Bubble, cria-o antes de usar
// esta rota.

// Lista os planos activos, para a pessoa escolher a quem quer mudar.
app.post('/planos', async (req, res) => {
  try {
    const planos = await bubbleList('plan', [
      { key: 'Is Active', constraint_type: 'equals', value: true }
    ]);
    const lista = planos.map(p => ({
      id: p._id,
      nome: p['Name'],
      preco_mzn: p['Price MZN'] || 0,
      sites_limit: p['Sites Limit'] || 0,
      tokens_incluidos: p['Tokens Incluidos'] || 0,
      max_colaboradores: p['Max Colaboradores'] || 0,
      permite_dominio: !!p['Permite Dominio']
    }));
    return res.json({ status: 'success', response: { planos: lista } });
  } catch (erro) {
    console.error('Erro em /planos:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os planos.' });
  }
});

// Regista a intenção de mudar de plano. Se o plano escolhido for grátis
// (0 MZN, ex: voltar para o Free), aplica-se logo, sem precisar de
// nenhum pagamento. Se for pago, cria a Assinatura "Pendente" para
// /assinatura-pagar iniciar o pagamento a sério.
app.post('/assinatura-iniciar', async (req, res) => {
  try {
    const { owner, plano_id } = req.body;
    if (!owner || !plano_id) {
      return res.json({ status: 'error', message: 'Faltam dados: owner e plano_id são obrigatórios.' });
    }

    const user = await bubbleGet('user', owner);
    if (!user) {
      return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    }
    const plano = await bubbleGet('plan', plano_id);
    if (!plano || !plano['Is Active']) {
      return res.json({ status: 'error', message: 'Este plano não está disponível.' });
    }

    const valor = plano['Price MZN'] || 0;

    // Plano grátis - aplica-se de imediato, sem pagamento nenhum.
    if (valor <= 0) {
      const agora = new Date();
      const expira = new Date(agora.getTime() + 30 * 24 * 60 * 60 * 1000);
      await bubblePatch('user', owner, {
        'Plan': plano_id,
        'Plan Started': agora.toISOString(),
        'Plan Expires': expira.toISOString(),
        'Aviso Enviado': false
      });
      return res.json({ status: 'success', response: { gratis: true, nome_plano: plano['Name'] } });
    }

    const assinaturaId = await bubbleCreate('assinatura', {
      'User': owner,
      'Plano': plano_id,
      'Valor MZN': valor,
      'Metodo': '',
      'ID Pagamento': '',
      'Estado': 'Pendente',
      'Transaction ID': '',
      'Webhook Processado': false,
      'Created Date': new Date().toISOString()
    });

    return res.json({
      status: 'success',
      response: { gratis: false, assinatura_id: assinaturaId, valor_mzn: valor, nome_plano: plano['Name'] }
    });
  } catch (erro) {
    console.error('Erro em /assinatura-iniciar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível iniciar a mudança de plano.' });
  }
});

// Inicia o pagamento de uma assinatura já criada - M-Pesa, e-Mola ou
// Cartão. Espelha /loja-pagar quase campo a campo; a única diferença é
// que o M-Pesa/e-Mola precisam de um número de telefone que aqui vem do
// corpo do pedido (a conta Daniel IA não tem necessariamente um
// telefone guardado), em vez de vir de um formulário de cliente anónimo.
app.post('/assinatura-pagar', async (req, res) => {
  try {
    const { assinatura_id, metodo, telefone } = req.body;

    if (!assinatura_id || !metodo) {
      return res.json({ status: 'error', message: 'Faltam dados: assinatura_id e metodo são obrigatórios.' });
    }
    const metodosValidos = ['mpesa', 'emola', 'cartao'];
    if (!metodosValidos.includes(metodo)) {
      return res.json({ status: 'error', message: 'Método de pagamento inválido.' });
    }
    if ((metodo === 'mpesa' || metodo === 'emola') && !telefone) {
      return res.json({ status: 'error', message: 'Falta o número de telefone para M-Pesa/e-Mola.' });
    }

    const assinatura = await bubbleGet('assinatura', assinatura_id);
    if (!assinatura) {
      return res.json({ status: 'error', message: 'Assinatura não encontrada.' });
    }
    if (assinatura['Estado'] !== 'Pendente') {
      return res.json({ status: 'error', message: 'Esta assinatura já foi paga ou já não está disponível para pagamento.' });
    }
    if (req.body.owner && assinatura['User'] !== req.body.owner) {
      return res.json({ status: 'error', message: 'Assinatura não encontrada.' });
    }

    const user = await bubbleGet('user', assinatura['User']);
    if (!user) {
      return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    }

    const valor = assinatura['Valor MZN'];
    const nome = user['Full Name'] || 'Cliente Daniel IA';
    const token = await mozpaymentToken();

    // ---- M-Pesa / e-Mola ----
    if (metodo === 'mpesa' || metodo === 'emola') {
      const respMoz = await fetch('https://mozpayment.co.mz/api/1.1/wf/payment', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: MOZPAYMENT_WALLET,
          payment_method: metodo,
          amount: String(valor),
          number: telefone,
          name: nome
        })
      });
      const jsonMoz = await respMoz.json().catch(() => ({}));
      if (!respMoz.ok) {
        throw new Error('Pedido de pagamento falhou: ' + respMoz.status + ' ' + JSON.stringify(jsonMoz));
      }
      const idPagamento = jsonMoz.idpayment || jsonMoz.id_payment ||
        (jsonMoz.response && (jsonMoz.response.idpayment || jsonMoz.response.id_payment)) || '';
      if (!idPagamento) {
        throw new Error('A MozPayment não devolveu nenhum idpayment: ' + JSON.stringify(jsonMoz));
      }

      await bubblePatch('assinatura', assinatura_id, {
        'Metodo': metodo,
        'ID Pagamento': String(idPagamento)
      });

      return res.json({ status: 'success', response: { tipo: 'mobile', idpayment: String(idPagamento) } });
    }

    // ---- Cartão (Visa / Mastercard) ----
    const returnUrl = `${SELF_URL}/assinatura-obrigado?assinatura_id=${assinatura_id}`;
    const respCartao = await fetch('https://mozpayment.co.mz/api/1.1/wf/bankpayment', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valor: String(valor),
        nome_cliente: nome,
        carteira: MOZPAYMENT_WALLET,
        nome_producto: assinatura['Tipo'] === 'Recarga' ? 'Recarga de tokens Daniel IA' : 'Assinatura Daniel IA',
        return_url: returnUrl
      })
    });
    const jsonCartao = await respCartao.json().catch(() => ({}));
    if (!respCartao.ok) {
      throw new Error('Pedido de pagamento por cartão falhou: ' + respCartao.status + ' ' + JSON.stringify(jsonCartao));
    }
    const checkoutUrl = jsonCartao.payment_url || jsonCartao.url || jsonCartao.checkout_url ||
      (jsonCartao.response && (jsonCartao.response.payment_url || jsonCartao.response.url || jsonCartao.response.checkout_url)) || '';
    if (!checkoutUrl) {
      throw new Error('A MozPayment não devolveu nenhum link de checkout: ' + JSON.stringify(jsonCartao));
    }

    let sessionId = jsonCartao.session_id || (jsonCartao.response && jsonCartao.response.session_id) || '';
    if (!sessionId) {
      try {
        sessionId = new URL(checkoutUrl).searchParams.get('session_id') || '';
      } catch (e) {
        // Se o link vier numa forma inesperada, seguimos sem session_id.
      }
    }
    const identificador = sessionId || checkoutUrl;

    await bubblePatch('assinatura', assinatura_id, {
      'Metodo': 'cartao',
      'ID Pagamento': String(identificador)
    });

    return res.json({ status: 'success', response: { tipo: 'cartao', checkout_url: checkoutUrl, embutivel: await checkoutEmbutivel(checkoutUrl) } });

  } catch (erro) {
    console.error('Erro em /assinatura-pagar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível iniciar o pagamento. Tenta novamente.' });
  }
});

// Consulta o estado de uma assinatura - usada pela página de espera para
// ir verificando se o pagamento já foi confirmado pelo webhook.
app.post('/assinatura-estado', async (req, res) => {
  try {
    const { assinatura_id } = req.body;
    if (!assinatura_id) {
      return res.json({ status: 'error', message: 'Falta o assinatura_id.' });
    }
    const assinatura = await bubbleGet('assinatura', assinatura_id);
    if (!assinatura) {
      return res.json({ status: 'error', message: 'Assinatura não encontrada.' });
    }
    if (req.body.owner && assinatura['User'] !== req.body.owner) {
      return res.json({ status: 'error', message: 'Assinatura não encontrada.' });
    }
    return res.json({
      status: 'success',
      response: {
        estado: assinatura['Estado'], valor_mzn: assinatura['Valor MZN'],
        tipo: assinatura['Tipo'] === 'Recarga' ? 'recarga' : 'plano', tokens: Number(assinatura['Tokens']) || 0
      }
    });
  } catch (erro) {
    console.error('Erro em /assinatura-estado:', erro);
    return res.json({ status: 'error', message: 'Não foi possível consultar o estado.' });
  }
});

// A página de "obrigado" (que abre dentro da janela do cartão, sem sessão)
// só precisa de saber se já está pago - mais nada sai daqui.
app.post('/assinatura-confirmacao', async (req, res) => {
  try {
    const assinatura = await bubbleGet('assinatura', req.body.assinatura_id).catch(() => null);
    if (!assinatura) return res.json({ status: 'error', message: 'Não encontrado.' });
    return res.json({ status: 'success', response: { estado: assinatura['Estado'] === 'Pago' ? 'Pago' : 'Pendente' } });
  } catch (erro) {
    return res.json({ status: 'error', message: 'Não foi possível consultar o estado.' });
  }
});

// Página de "obrigado" para onde a pessoa volta depois de pagar a
// assinatura com cartão (é o "return_url" que damos à MozPayment em
// /assinatura-pagar). Espelha /loja-obrigado - só que no fim volta para
// o dashboard da Daniel IA, não para um site.
app.get('/assinatura-obrigado', async (req, res) => {
  const assinaturaId = String(req.query.assinatura_id || '');

  const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Obrigado</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2216%22%20fill%3D%22%23430960%22%2F%3E%3Cg%20transform%3D%22translate%2811.52%2011.52%29%20scale%280.16384%29%20translate%28-111%20-492.5%29%22%3E%3Cpath%20fill%3D%22%23FFFFFF%22%20d%3D%22M148.0%20738.1C142.7%20737.4%20139.2%20736.1%20135.6%20733.7C128.3%20728.8%20123.9%20721.8%20122.6%20713.1C122.1%20709.4%20122.1%20707.5%20122.7%20704.0C123.8%20697.6%20126.3%20692.6%20130.6%20688.3C133.2%20685.6%20136.0%20683.8%20141.9%20680.7C150.6%20676.1%20156.0%20672.8%20160.9%20669.2C172.2%20660.9%20180.7%20651.9%20187.8%20640.6C188.3%20639.9%20188.8%20639.4%20189.0%20639.4C189.4%20639.4%20189.5%20702.5%20189.0%20705.6C187.7%20714.1%20184.5%20720.7%20178.6%20726.7C172.9%20732.7%20168.0%20735.6%20160.8%20737.5C158.3%20738.2%20157.3%20738.3%20154.1%20738.4C151.7%20738.4%20149.5%20738.4%20148.0%20738.1ZM183.5%20737.9C183.5%20737.7%20184.1%20737.1%20184.9%20736.6C189.2%20733.9%20194.3%20728.3%20197.4%20723.0C202.1%20715.1%20203.7%20708.5%20203.7%20698.0C203.7%20694.3%20203.8%20692.7%20204.1%20692.4C204.3%20692.1%20206.1%20692.0%20222.0%20691.9C238.3%20691.8%20239.9%20691.8%20243.0%20691.3C254.0%20689.6%20263.9%20685.6%20273.4%20679.0C281.6%20673.4%20288.9%20665.8%20294.0%20657.5C298.3%20650.5%20301.7%20642.5%20303.3%20635.4C306.8%20619.6%20305.5%20604.6%20299.3%20589.3C296.5%20582.2%20293.0%20576.6%20286.9%20569.6C282.9%20564.8%20279.8%20562.0%20274.4%20558.1C264.1%20550.6%20251.7%20545.8%20240.8%20545.0C238.8%20544.8%20228.4%20544.8%20215.6%20544.8L193.8%20544.9L192.7%20545.6C191.4%20546.5%20190.1%20548.2%20189.7%20549.4C189.5%20550.1%20189.4%20555.5%20189.4%20571.2C189.4%20582.6%20189.3%20592.1%20189.2%20592.2C188.9%20592.4%20188.0%20591.4%20188.0%20590.9C188.0%20590.0%20185.1%20584.4%20182.5%20580.6C179.3%20575.7%20171.4%20568.0%20165.1%20563.7C161.4%20561.2%20152.2%20556.2%20143.4%20551.9C134.1%20547.4%20130.6%20544.8%20127.0%20540.0C124.6%20536.8%20123.4%20533.6%20122.6%20529.1C122.2%20526.2%20122.2%20523.9%20122.6%20520.6C123.1%20517.2%20123.8%20514.9%20125.2%20512.1C128.5%20505.5%20134.2%20500.8%20141.6%20498.7C146.7%20497.2%20146.0%20497.2%20196.5%20497.3C246.4%20497.4%20244.5%20497.4%20253.4%20498.8C268.8%20501.2%20287.7%20509.1%20301.3%20518.9C312.8%20527.0%20323.6%20538.1%20330.9%20549.1C335.2%20555.5%20337.8%20560.2%20340.5%20566.0C344.7%20575.1%20347.2%20582.3%20349.5%20592.4C351.4%20600.7%20352.0%20605.8%20352.2%20615.9C352.4%20628.3%20351.3%20638.6%20348.6%20648.9C345.6%20660.5%20339.4%20674.8%20333.6%20684.0C323.4%20700.1%20309.0%20713.7%20292.2%20723.3C282.4%20728.9%20271.5%20733.1%20261.5%20735.3C248.6%20738.2%20247.4%20738.2%20211.8%20738.2C186.7%20738.2%20183.5%20738.2%20183.5%20737.9Z%22%2F%3E%3Ccircle%20fill%3D%22%2389C804%22%20cx%3D%22149.1%22%20cy%3D%22612.7%22%20r%3D%2229.7%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&family=Sora:wght@700&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#07030C;
    --card:#110A1B;
    --border:#2A1B3D;
    --text:#F6F2FB;
    --text-dim:#A89BBA;
    --accent-1:#B4F02B;
    --accent-2:#89C804;
    --success:#89C804;
    --error:#FF5C7A;
    --warning:#F5A623;
  }
  *{box-sizing:border-box;}
  body{
    margin:0;
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    font-family:"Manrope",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:radial-gradient(900px 520px at 15% -12%, rgba(67,9,96,0.9), rgba(67,9,96,0) 62%),radial-gradient(700px 420px at 105% 105%, rgba(137,200,4,0.10), rgba(137,200,4,0) 60%),var(--bg);
    color:var(--text);
    padding:24px;
  }
  .caixa{
    background:var(--card);
    border:1px solid var(--border);
    border-radius:16px;
    padding:40px 32px;
    max-width:380px;
    width:100%;
    text-align:center;
  }
  .icone{
    width:56px;height:56px;
    border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    margin:0 auto 20px auto;
  }
  .icone.a-confirmar{background:rgba(245,166,35,0.14);}
  .icone.pago{background:rgba(137,200,4,0.14);}
  .icone.erro{background:rgba(255,92,122,0.14);}
  .spinner{
    width:24px;height:24px;
    border-radius:50%;
    border:3px solid var(--border);
    border-top-color:var(--warning);
    animation:girar .8s linear infinite;
  }
  @keyframes girar{to{transform:rotate(360deg);}}
  h1{font-size:18px;margin:0 0 8px 0;font-family:"Sora","Manrope",sans-serif;letter-spacing:-0.02em;}
  p{font-size:13px;color:var(--text-dim);margin:0 0 24px 0;line-height:1.5;}
  .btn{
    display:inline-block;
    background:linear-gradient(135deg,#C8F84A 0%,#89C804 100%);
    color:#140620;
    box-shadow:0 8px 24px rgba(137,200,4,0.30);
    border:none;
    border-radius:10px;
    padding:11px 22px;
    font-size:13px;
    font-weight:600;
    cursor:pointer;
    text-decoration:none;
  }
</style>
</head>
<body>
  <svg viewBox="112 489 1060 257" role="img" aria-label="Daniel IA" style="position:fixed;top:28px;left:50%;transform:translateX(-50%);height:28px;width:auto;"><path fill="#FFFFFF" d="M148.0 738.1C142.7 737.4 139.2 736.1 135.6 733.7C128.3 728.8 123.9 721.8 122.6 713.1C122.1 709.4 122.1 707.5 122.7 704.0C123.8 697.6 126.3 692.6 130.6 688.3C133.2 685.6 136.0 683.8 141.9 680.7C150.6 676.1 156.0 672.8 160.9 669.2C172.2 660.9 180.7 651.9 187.8 640.6C188.3 639.9 188.8 639.4 189.0 639.4C189.4 639.4 189.5 702.5 189.0 705.6C187.7 714.1 184.5 720.7 178.6 726.7C172.9 732.7 168.0 735.6 160.8 737.5C158.3 738.2 157.3 738.3 154.1 738.4C151.7 738.4 149.5 738.4 148.0 738.1ZM183.5 737.9C183.5 737.7 184.1 737.1 184.9 736.6C189.2 733.9 194.3 728.3 197.4 723.0C202.1 715.1 203.7 708.5 203.7 698.0C203.7 694.3 203.8 692.7 204.1 692.4C204.3 692.1 206.1 692.0 222.0 691.9C238.3 691.8 239.9 691.8 243.0 691.3C254.0 689.6 263.9 685.6 273.4 679.0C281.6 673.4 288.9 665.8 294.0 657.5C298.3 650.5 301.7 642.5 303.3 635.4C306.8 619.6 305.5 604.6 299.3 589.3C296.5 582.2 293.0 576.6 286.9 569.6C282.9 564.8 279.8 562.0 274.4 558.1C264.1 550.6 251.7 545.8 240.8 545.0C238.8 544.8 228.4 544.8 215.6 544.8L193.8 544.9L192.7 545.6C191.4 546.5 190.1 548.2 189.7 549.4C189.5 550.1 189.4 555.5 189.4 571.2C189.4 582.6 189.3 592.1 189.2 592.2C188.9 592.4 188.0 591.4 188.0 590.9C188.0 590.0 185.1 584.4 182.5 580.6C179.3 575.7 171.4 568.0 165.1 563.7C161.4 561.2 152.2 556.2 143.4 551.9C134.1 547.4 130.6 544.8 127.0 540.0C124.6 536.8 123.4 533.6 122.6 529.1C122.2 526.2 122.2 523.9 122.6 520.6C123.1 517.2 123.8 514.9 125.2 512.1C128.5 505.5 134.2 500.8 141.6 498.7C146.7 497.2 146.0 497.2 196.5 497.3C246.4 497.4 244.5 497.4 253.4 498.8C268.8 501.2 287.7 509.1 301.3 518.9C312.8 527.0 323.6 538.1 330.9 549.1C335.2 555.5 337.8 560.2 340.5 566.0C344.7 575.1 347.2 582.3 349.5 592.4C351.4 600.7 352.0 605.8 352.2 615.9C352.4 628.3 351.3 638.6 348.6 648.9C345.6 660.5 339.4 674.8 333.6 684.0C323.4 700.1 309.0 713.7 292.2 723.3C282.4 728.9 271.5 733.1 261.5 735.3C248.6 738.2 247.4 738.2 211.8 738.2C186.7 738.2 183.5 738.2 183.5 737.9Z"/><circle fill="#89C804" cx="149.1" cy="612.7" r="29.7"/><path fill="#FFFFFF" d="M583.7 695.1C577.0 694.2 572.3 692.2 567.6 688.5C561.0 683.2 557.4 673.0 558.6 663.1C559.4 656.8 561.1 652.6 564.5 648.3C567.6 644.6 571.5 642.0 577.4 639.7C580.8 638.4 581.6 638.1 585.4 637.3C591.0 636.0 596.6 635.5 608.5 635.3C614.7 635.2 619.0 635.1 619.2 634.9C619.4 634.8 619.5 633.9 619.5 632.5C619.5 625.7 617.7 621.5 613.8 618.7C610.5 616.5 606.0 615.2 601.4 615.2C598.3 615.2 596.0 615.8 593.1 617.1C589.4 618.9 587.1 621.5 585.5 625.7C584.8 627.6 584.5 627.8 583.1 627.7C581.5 627.5 576.4 626.8 574.1 626.5C572.5 626.2 566.0 625.3 564.0 625.1C562.2 624.9 562.0 624.8 562.0 624.1C562.0 623.1 563.0 619.4 563.8 617.0C565.5 612.6 568.3 608.5 571.9 605.4C573.6 603.9 576.3 602.0 576.7 602.0C576.8 602.0 577.0 601.8 577.2 601.7C578.0 600.9 581.6 599.2 584.1 598.4C590.2 596.3 595.4 595.5 602.5 595.5C616.5 595.5 627.3 599.3 635.0 607.0C639.5 611.5 641.5 615.3 643.3 622.5L643.9 624.9L643.9 659.2L643.9 693.6L632.7 693.7C622.5 693.7 621.5 693.7 621.0 693.3C620.5 692.9 620.5 692.6 620.5 687.1C620.4 684.0 620.4 681.2 620.3 681.1C620.1 680.4 619.5 680.8 617.7 683.1C615.1 686.3 614.3 687.2 612.5 688.6C609.1 691.3 605.3 693.1 600.4 694.5C596.9 695.4 588.4 695.8 583.7 695.1ZM853.4 695.1C849.2 694.6 845.0 693.5 840.4 691.6C832.6 688.3 826.5 683.4 822.1 676.7C820.0 673.5 817.6 669.2 816.8 667.1C815.3 663.1 814.4 659.3 813.7 654.6C813.3 651.3 813.2 650.1 813.3 644.1C813.4 637.0 813.6 635.6 814.9 630.6C815.5 628.4 816.9 624.2 817.5 622.9C820.4 616.5 823.3 612.2 827.7 608.0C833.0 602.8 839.6 599.2 847.5 597.1C859.0 594.2 871.8 595.1 881.2 599.7C889.1 603.5 895.4 609.2 899.6 616.4C902.9 622.0 905.4 630.2 906.0 637.2C906.1 638.8 906.2 642.6 906.2 645.5C906.2 650.1 906.2 651.0 905.9 651.3C905.6 651.5 899.0 651.6 872.4 651.5C840.3 651.5 839.3 651.5 838.9 652.0C838.5 652.4 838.5 652.7 838.8 654.9C839.2 658.9 840.9 663.5 842.9 666.3C846.2 670.7 852.0 674.2 858.0 675.3C860.2 675.7 864.7 675.6 867.0 675.2C871.8 674.1 876.0 671.7 878.7 668.4C879.7 667.1 881.3 664.3 881.6 663.3C881.8 662.2 882.1 662.2 889.6 664.2C900.7 667.0 903.5 667.8 903.8 668.3C904.2 668.9 902.1 673.8 899.8 677.4C897.5 681.0 892.8 685.8 889.1 688.2C885.3 690.7 879.8 693.0 874.4 694.2C869.4 695.4 859.5 695.8 853.4 695.1ZM430.3 693.3C429.9 692.5 429.9 561.5 430.3 561.1C430.7 560.7 482.3 560.6 487.3 561.0C492.7 561.4 498.2 562.6 505.7 565.2C508.2 566.0 513.4 568.4 514.9 569.4C515.3 569.7 516.6 570.5 517.8 571.3C526.0 576.6 531.8 583.4 536.7 593.1C540.0 599.7 541.8 605.0 543.2 612.9C545.1 623.1 544.8 638.6 542.4 647.9C539.5 659.3 533.8 669.5 526.3 676.8C522.2 680.7 521.1 681.7 517.5 683.8C510.6 687.9 504.6 690.3 496.7 692.0C488.9 693.6 489.4 693.6 458.6 693.7C430.8 693.8 430.5 693.8 430.3 693.3ZM663.9 693.4C663.4 693.1 663.4 692.2 663.4 645.6C663.4 598.5 663.4 598.2 663.9 597.8C664.3 597.5 666.0 597.5 675.9 597.5C683.0 597.6 687.5 597.7 687.7 597.9C687.9 598.1 688.0 599.4 688.1 604.2C688.2 611.5 688.2 611.5 690.3 608.6C695.1 601.8 703.7 596.8 712.4 595.8C715.6 595.4 720.8 595.4 723.9 595.9C732.9 597.2 741.5 602.4 746.0 609.2C748.5 613.0 749.9 616.2 751.1 621.0C752.6 626.6 752.5 625.9 752.6 660.7C752.7 692.0 752.7 692.8 752.3 693.2C751.8 693.7 751.2 693.7 740.0 693.7C729.3 693.8 728.1 693.7 727.7 693.3C727.3 692.9 727.2 691.9 727.2 664.8C727.2 646.1 727.2 635.7 727.0 633.8C726.4 627.8 724.1 623.2 720.6 620.7C717.2 618.4 713.5 617.2 709.0 617.2C703.2 617.2 698.2 619.4 694.2 623.7C691.3 626.8 689.4 631.5 688.8 637.3C688.6 638.9 688.5 648.8 688.5 666.5C688.5 681.6 688.4 693.3 688.3 693.4C688.2 693.4 682.7 693.6 676.2 693.6C666.2 693.8 664.3 693.7 663.9 693.4ZM772.1 693.3C771.8 693.0 771.8 687.9 771.8 645.5C771.8 603.7 771.8 598.0 772.1 597.8C772.4 597.5 775.2 597.5 784.5 597.5C795.8 597.6 796.6 597.7 796.9 598.1C797.2 598.5 797.2 606.7 797.2 645.8C797.3 688.7 797.2 693.0 796.9 693.4C796.5 693.7 795.1 693.8 784.5 693.7C774.1 693.7 772.5 693.7 772.1 693.3ZM922.8 693.4C922.4 693.0 922.2 561.6 922.6 561.1C922.8 560.8 924.9 560.8 935.1 560.7C943.9 560.7 947.4 560.8 947.6 561.0C948.2 561.4 948.1 692.4 947.6 693.2L947.2 693.8L935.1 693.8C925.6 693.8 923.0 693.7 922.8 693.4ZM604.4 675.8C608.3 674.7 611.3 672.9 614.3 669.8C617.0 667.0 618.6 663.7 619.2 660.0C619.6 657.4 619.7 652.3 619.3 652.0C618.4 651.5 604.6 651.6 600.2 652.1C597.6 652.5 593.5 653.3 592.1 653.8C587.7 655.3 584.6 657.9 583.5 661.2C582.7 663.4 582.9 668.0 583.7 669.9C584.9 672.5 587.0 674.4 590.1 675.5C592.5 676.3 593.8 676.5 598.2 676.4C601.5 676.3 602.8 676.2 604.4 675.8ZM486.9 670.3C495.8 668.6 501.6 665.8 506.8 660.4C510.0 657.1 513.1 652.2 514.4 648.1C515.5 645.1 516.7 639.3 517.1 635.6C517.6 631.5 517.5 622.1 517.0 618.5C514.5 601.5 506.4 590.5 492.7 586.0C487.4 584.3 485.4 584.0 474.9 583.7C462.7 583.4 456.6 583.5 456.2 584.0C456.1 584.2 456.0 600.8 456.0 627.4C456.0 661.5 456.1 670.5 456.3 670.7C456.6 671.0 459.5 671.0 470.4 670.9C482.9 670.8 484.4 670.8 486.9 670.3ZM882.0 634.8C882.3 634.3 882.1 633.0 881.4 630.3C880.3 626.3 877.5 622.1 874.0 619.4C868.1 614.8 858.4 613.9 851.3 617.2C847.5 619.0 844.6 621.6 842.4 625.0C841.1 627.0 840.5 628.3 839.6 631.1C838.9 633.4 838.8 634.9 839.3 635.1C839.5 635.2 849.1 635.2 860.7 635.2C881.2 635.2 881.7 635.2 882.0 634.8ZM782.2 583.2C778.2 582.6 774.0 579.9 771.9 576.5C769.8 573.2 769.3 567.7 770.6 563.1C773.2 554.3 784.5 550.4 792.5 555.5C795.7 557.6 798.2 561.2 799.0 564.8C799.5 566.9 799.2 571.7 798.5 573.6C797.3 576.9 794.3 580.4 791.2 581.8C788.5 583.1 785.0 583.7 782.2 583.2Z"/><path fill="#89C804" d="M999.8 693.4C999.4 692.9 999.4 561.8 999.8 561.2C1000.1 560.8 1001.4 560.8 1012.7 560.7C1019.6 560.7 1025.3 560.8 1025.5 560.9C1025.7 561.0 1025.8 580.3 1025.8 626.8C1025.8 683.3 1025.7 692.7 1025.4 693.1C1025.1 693.6 1024.6 693.6 1012.6 693.7C1002.0 693.8 1000.0 693.7 999.8 693.4ZM1039.6 693.6C1039.4 693.5 1039.2 693.2 1039.2 693.0C1039.2 692.5 1041.1 686.8 1041.5 685.9C1041.6 685.6 1041.9 684.9 1042.1 684.2C1042.3 683.6 1043.0 681.7 1043.6 679.9C1045.8 673.7 1046.5 671.6 1047.5 668.8C1048.0 667.2 1048.9 664.6 1049.5 663.0C1050.1 661.4 1050.7 659.5 1051.0 658.8C1051.3 658.0 1051.9 656.1 1052.5 654.5C1053.5 651.9 1054.1 650.2 1056.5 643.2C1056.9 642.1 1058.0 638.9 1059.0 636.1C1061.4 629.1 1063.3 623.7 1065.6 617.1C1066.3 615.3 1067.1 612.9 1067.5 611.6C1067.9 610.4 1068.7 608.4 1069.1 607.2C1069.6 606.1 1070.3 603.9 1070.8 602.5C1071.3 601.1 1072.4 597.9 1073.2 595.5C1074.1 593.1 1075.2 590.0 1075.6 588.6C1076.1 587.2 1076.8 585.3 1077.2 584.4C1077.6 583.4 1078.2 581.6 1078.6 580.4C1079.5 577.4 1080.3 575.0 1081.1 572.9C1082.3 569.7 1082.8 568.4 1083.6 565.9C1084.6 562.9 1085.4 561.1 1085.7 560.9C1085.9 560.8 1093.2 560.7 1102.0 560.7C1116.7 560.7 1118.1 560.8 1118.5 561.2C1118.8 561.4 1119.0 561.7 1119.0 561.9C1119.0 562.1 1119.7 564.2 1120.5 566.7C1121.3 569.1 1122.1 571.5 1122.2 572.0C1122.4 572.8 1123.6 576.1 1125.3 580.8C1125.6 581.5 1126.2 583.4 1126.7 585.0C1127.3 586.6 1128.4 589.8 1129.2 592.1C1130.0 594.5 1131.2 597.8 1131.7 599.5C1132.3 601.2 1133.1 603.5 1133.5 604.5C1135.0 608.5 1138.0 617.1 1140.0 622.9C1141.1 626.2 1142.6 630.7 1143.4 632.9C1144.1 635.1 1145.8 639.9 1147.1 643.6C1148.4 647.3 1150.1 652.2 1150.9 654.4C1152.3 658.3 1154.8 665.7 1160.6 682.6C1162.2 687.3 1163.7 691.5 1163.9 692.1C1164.2 692.7 1164.2 693.1 1164.1 693.3C1163.9 693.6 1160.9 693.6 1150.4 693.7C1137.8 693.8 1137.1 693.8 1136.6 693.3C1136.2 693.0 1135.3 690.7 1133.4 684.9C1132.0 680.5 1130.2 675.2 1129.6 673.2C1128.9 671.3 1128.0 668.6 1127.6 667.4C1127.3 666.1 1126.8 664.7 1126.5 664.2L1126.1 663.4L1123.6 663.2C1122.2 663.1 1111.2 663.0 1099.1 663.0C1077.3 663.0 1077.0 663.0 1076.5 663.5C1076.2 663.8 1076.0 664.2 1076.0 664.4C1076.0 664.7 1073.0 673.9 1071.3 678.9C1070.4 681.4 1069.4 684.3 1068.9 685.8C1068.6 686.6 1068.0 688.4 1067.6 689.6C1066.7 692.7 1066.5 693.2 1066.2 693.4C1065.8 693.6 1040.1 693.8 1039.6 693.6ZM1119.4 641.6C1119.6 641.2 1118.2 636.6 1116.2 631.1C1115.4 628.6 1114.6 626.1 1112.0 618.1C1109.8 611.4 1108.3 606.4 1107.1 602.6C1106.5 600.4 1105.4 596.9 1104.7 594.9C1104.0 592.8 1103.2 590.2 1102.9 589.1C1102.5 587.6 1102.3 587.1 1101.9 587.0C1101.3 586.9 1101.0 587.4 1101.0 588.4C1101.0 588.8 1100.2 591.4 1099.2 594.3C1097.2 600.3 1092.6 613.9 1091.6 617.1C1090.7 620.0 1089.0 625.3 1086.9 631.5C1084.4 638.7 1083.6 641.5 1084.0 641.8C1084.2 641.9 1092.2 642.0 1101.8 642.0C1117.3 642.0 1119.3 642.0 1119.4 641.6Z"/></svg>
  <div class="caixa">
    <div class="icone a-confirmar" id="icone">
      <div class="spinner"></div>
    </div>
    <h1 id="titulo">A confirmar o teu pagamento...</h1>
    <p id="texto">Isto demora só alguns segundos. Não feches esta página.</p>
    <a class="btn" id="btn-voltar" href="${escaparHtml(APP_URL)}" style="display:none;">Ir para o dashboard</a>
  </div>

<script>
var ASSINATURA_ID = ${JSON.stringify(assinaturaId)};
var EMBUTIDA = false;
try { EMBUTIDA = window.self !== window.top; } catch (e) { EMBUTIDA = true; }
function avisarPai(estado){ try { window.parent.postMessage({ daniel: 'pagamento', estado: estado }, '*'); } catch (e) {} }
if (EMBUTIDA) {
  avisarPai('voltou');
  var estiloEmb = document.createElement('style');
  estiloEmb.textContent = 'body{background:transparent!important;padding:16px!important;min-height:0!important;}body>svg{display:none!important;}#btn-voltar{display:none!important;}.caixa{border:none!important;background:transparent!important;}';
  document.head.appendChild(estiloEmb);
}
var APP_URL_JS = ${JSON.stringify(APP_URL)};
var tentativas = 0;
var MAX_TENTATIVAS = 40;

function mostrarEstado(tipo, titulo, texto){
  var icone = document.getElementById('icone');
  icone.className = 'icone ' + tipo;
  if (tipo !== 'a-confirmar') {
    icone.innerHTML = '';
  }
  document.getElementById('titulo').textContent = titulo;
  document.getElementById('texto').textContent = texto;
  if (tipo === 'pago') {
    document.getElementById('btn-voltar').style.display = 'inline-block';
  }
}

function verificar(){
  if (!ASSINATURA_ID) {
    mostrarEstado('erro', 'Não encontrámos a tua assinatura', 'Volta ao dashboard e tenta novamente.');
    return;
  }
  fetch('/assinatura-confirmacao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assinatura_id: ASSINATURA_ID })
  }).then(function(r){ return r.json(); })
    .then(function(r){
      if (r.status === 'success' && r.response.estado === 'Pago') {
        mostrarEstado('pago', 'Pagamento confirmado!', 'A tua conta já está actualizada.');
        if (EMBUTIDA) { avisarPai('pago'); return; }
        setTimeout(function(){ window.location.href = APP_URL_JS; }, 4000);
        return;
      }
      tentativas++;
      if (tentativas >= MAX_TENTATIVAS) {
        mostrarEstado('erro', 'Ainda a processar', 'O pagamento pode ainda estar a ser confirmado. Verifica mais tarde no dashboard.');
        return;
      }
      setTimeout(verificar, 3000);
    })
    .catch(function(){
      tentativas++;
      if (tentativas >= MAX_TENTATIVAS) {
        mostrarEstado('erro', 'Não foi possível confirmar', 'Verifica a tua ligação e tenta novamente mais tarde.');
        return;
      }
      setTimeout(verificar, 3000);
    });
}

verificar();
</script>
</body>
</html>`;

  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
});

// ---- Webhook da MozPayment (assinatura de plano da Daniel IA) ----
// Endereço secreto, mesma lógica de segurança do webhook da loja: só
// aplica um pagamento a uma Assinatura "Pendente" que o próprio
// container criou, com o valor a bater certo, e nunca duas vezes
// (idempotência via "Webhook Processado").
app.post('/wh-assinatura-dk7x2mq9pw', async (req, res) => {
  console.log('Webhook da MozPayment (assinatura) recebido:', JSON.stringify(req.body));
  res.sendStatus(200);

  try {
    const body = req.body || {};
    const status = String(body.status || '').trim().toLowerCase();
    const identificador = body.reason || body.payment_id || body.idpayment || body.session_id || '';

    if (status !== 'completed') {
      console.log('Webhook ignorado - status não é "completed":', status);
      return;
    }
    if (!identificador) {
      console.log('Webhook ignorado - sem identificador ("reason") para encontrar a assinatura.');
      return;
    }

    const assinaturas = await bubbleList('assinatura', [
      { key: 'ID Pagamento', constraint_type: 'equals', value: String(identificador) }
    ]);

    if (!assinaturas || assinaturas.length === 0) {
      console.log('Webhook ignorado - nenhuma assinatura encontrada com este identificador:', identificador);
      return;
    }

    const assinatura = assinaturas[0];

    if (assinatura['Webhook Processado']) {
      console.log('Webhook ignorado - esta assinatura já tinha sido processada:', assinatura._id);
      return;
    }

    const valorRecebido = Number(body.amount);
    const valorEsperado = Number(assinatura['Valor MZN']);
    if (!isNaN(valorRecebido) && Math.abs(valorRecebido - valorEsperado) > 0.01) {
      console.log('Webhook suspeito - valor não bate certo. Esperado:', valorEsperado, 'Recebido:', valorRecebido);
      return;
    }

    await bubblePatch('assinatura', assinatura._id, {
      'Estado': 'Pago',
      'Transaction ID': String(body.transaction_id || ''),
      'Webhook Processado': true
    });

    // ---- Recarga de tokens (1.59.0): soma aos tokens extra e fica por aqui ----
    if (assinatura['Tipo'] === 'Recarga') {
      await aplicarRecarga(assinatura);
      return;
    }

    // ---- Aplica o plano novo ao utilizador ----
    const agora = new Date();
    const expira = new Date(agora.getTime() + 30 * 24 * 60 * 60 * 1000);
    await bubblePatch('user', assinatura['User'], {
      'Plan': assinatura['Plano'],
      'Plan Started': agora.toISOString(),
      'Plan Expires': expira.toISOString(),
      'Tokens Usados Mes': 0,
      'Aviso Enviado': false
    });

    console.log('Assinatura paga e plano actualizado:', assinatura._id);

    // ---- Email de confirmação (não deixa o webhook falhar se o email falhar) ----
    try {
      const usuario = await bubbleGet('user', assinatura['User']);
      const emailDestino =
        usuario.email ||
        (usuario.authentication && usuario.authentication.email && usuario.authentication.email.email) ||
        '';
      const plano = await bubbleGet('plan', assinatura['Plano']);
      if (emailDestino) {
        const nomePlano = plano ? plano['Name'] : assinatura['Plano'];
        await enviarEmail(
          emailDestino,
          'Assinatura confirmada - Daniel IA',
          templateEmailAssinatura(usuario['Full Name'], nomePlano, assinatura['Valor MZN'], expira)
        );
        await enviarEmail(
          emailDestino,
          'O teu recibo - Daniel IA',
          templateEmailReciboAssinatura(
            usuario['Full Name'],
            nomePlano,
            assinatura['Valor MZN'],
            assinatura['Metodo'],
            identificador,
            agora
          )
        );
      }
    } catch (erroEmail) {
      console.error('Assinatura aplicada, mas o email de confirmação/recibo falhou:', erroEmail);
    }
  } catch (erro) {
    console.error('Erro ao processar webhook da assinatura:', erro);
  }
});

// ======================================================
// Confirmação de email por código (cadastro)
// ======================================================

// Gera um código novo, grava-o no User e envia-o por email (Resend).
// Chamado pelo backend workflow `signup` do Bubble logo a seguir a criar
// a conta, e também pelo botão "Reenviar código" do ecrã de confirmação.
app.post('/signup-code', async (req, res) => {
  try {
    const { owner } = req.body;
    if (!owner) {
      return res.json({ status: 'error', message: 'Falta o owner.' });
    }

    const usuario = await bubbleGet('user', owner);
    if (!usuario) {
      return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    }

    const emailDestino =
      usuario.email ||
      (usuario.authentication && usuario.authentication.email && usuario.authentication.email.email) ||
      '';
    if (!emailDestino) {
      return res.json({ status: 'error', message: 'Esta conta não tem email associado.' });
    }

    // Segurança: antes, qualquer pessoa podia chamar isto com o id de outra
    // conta e voltar a pô-la como "não confirmada". Conta já confirmada
    // fica como está (e não recebe email nenhum).
    if (usuario['Token Confirmado']) {
      return res.json({ status: 'success' });
    }

    const codigo = gerarCodigo();
    baldesLimite.delete('codigo-falha:' + owner);
    const expira = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    await bubblePatch('user', owner, {
      'Token': codigo,
      'Token Confirmado': false,
      'Token Expires': expira.toISOString()
    });

    await enviarEmail(
      emailDestino,
      'O teu código de confirmação - Daniel IA',
      templateEmailCodigo(usuario['Full Name'], codigo)
    );

    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /signup-code (se for "enviarEmail falhou", ver o domínio de envio na Resend):', erro && erro.message ? erro.message : erro);
    return res.json({ status: 'error', message: 'Não foi possível enviar o código. Tenta novamente.' });
  }
});

// Confirma o código que a pessoa escreveu contra o que está gravado no
// User. Marca "Token Confirmado" a true se bater certo e ainda não tiver
// expirado.
app.post('/verify-code', async (req, res) => {
  try {
    const { owner, code } = req.body;
    if (!owner || !code) {
      return res.json({ status: 'error', message: 'Falta o owner ou o código.' });
    }

    const usuario = await bubbleGet('user', owner);
    if (!usuario) {
      return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    }

    // Segurança (15/10/2026): antes, uma conta já confirmada recebia uma
    // sessão nova SEM verificar o código - bastava saber o id da conta para
    // entrar nela. Agora o código tem sempre de bater certo (e dentro do
    // prazo), e há um limite de tentativas erradas por conta.
    if (excedido('codigo-falha:' + owner, 8)) {
      return res.json({ status: 'error', message: 'Demasiadas tentativas. Pede um código novo.' });
    }

    const codigoCerto = String(usuario['Token'] || '').trim().toUpperCase();
    const codigoRecebido = String(code || '').trim().toUpperCase();
    const a = Buffer.from(codigoRecebido), b = Buffer.from(codigoCerto);
    if (!codigoCerto || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      contar('codigo-falha:' + owner, 8, 30 * 60 * 1000);
      return res.json({ status: 'error', message: 'Código incorrecto.' });
    }

    const expiraEm = usuario['Token Expires'] ? new Date(usuario['Token Expires']) : null;
    if (!expiraEm || isNaN(expiraEm.getTime()) || expiraEm.getTime() < Date.now()) {
      return res.json({ status: 'error', message: 'Este código expirou. Pede um novo.' });
    }

    await bubblePatch('user', owner, { 'Token Confirmado': true });

    // A confirmação do código é o momento em que a conta passa a estar
    // "entrada" a sério - por isso já lhe damos aqui um token de sessão
    // verdadeiro, em vez de mandar a pessoa fazer login outra vez a
    // seguir. O dashboard vai usar este token em todos os pedidos
    // seguintes (ver /sessao-criar, mais abaixo, para o mesmo mecanismo
    // usado pelo login feito no Bubble).
    const token = await criarTokenSessao(owner).catch((erro) => {
      console.error('Não foi possível criar sessão após /verify-code:', erro);
      return null;
    });

    return res.json({ status: 'success', token: token });
  } catch (erro) {
    console.error('Erro em /verify-code:', erro);
    return res.json({ status: 'error', message: 'Não foi possível confirmar o código. Tenta novamente.' });
  }
});

// ======================================================
// Sessão (autenticação a sério)
// ======================================================
// Até aqui, qualquer rota que recebesse um "owner" confiava nele sem mais
// nada - bastava alguém saber o unique id de outra conta para se fazer
// passar por ela. Esta secção resolve isso: dá a cada login/confirmação
// um token de sessão aleatório (64 caracteres, nunca adivinhável), grava-o
// no User, e cada rota que mexe em dados de uma conta passa a exigir esse
// token em vez de confiar só no owner.
//
// Campos novos no Bubble antes disto funcionar: tipo User, campo
// "Token Sessao" (text) e "Token Sessao Expira" (date).
//
// Esta rota só pode ser chamada pelo próprio Bubble (workflows de login,
// signup e verify-code), nunca directamente pelo browser - por isso exige
// a mesma ADMIN_SECRET usada no /plan-warnings-teste-7hq2fx. Define essa
// chave também no API Connector do Bubble, como um "Private key" do
// corpo do pedido (nunca Private no cabeçalho, para não ires parar à
// mesma armadilha de outra vez).
const SESSAO_DIAS_VALIDADE = 90;

// Gera um token de sessão novo para este owner e grava-o no Bubble. Partilhada
// por duas chamadoras: a rota /sessao-criar (chamada de fora, pelo Bubble, por
// isso protegida por ADMIN_SECRET) e /verify-code (chamada aqui dentro do
// próprio servidor, já depois de confirmar que o owner é quem diz ser - não
// precisa de chave outra vez). Lança erro se o owner não existir; quem chama
// decide o que fazer com isso.
async function criarTokenSessao(owner) {
  const usuario = await bubbleGet('user', owner);
  if (!usuario) {
    throw new Error('Utilizador não encontrado.');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + SESSAO_DIAS_VALIDADE * 24 * 60 * 60 * 1000);

  await bubblePatch('user', owner, {
    'Token Sessao': token,
    'Token Sessao Expira': expira.toISOString()
  });

  return token;
}

// ---- Entrar (login feito pelo container) ----
// A página de login manda o email e a password para aqui; o container
// chama o mesmo workflow "login" do Bubble que a página chamava antes
// e, se o Bubble aceitar, devolve o id da conta e um token de sessão
// nosso. Assim o token já não depende de nenhum passo extra configurado
// no Bubble. Tentativas erradas contam por email e por IP.
const BUBBLE_WF_BASE = clean(process.env.BUBBLE_WF_BASE) || String(BUBBLE_BASE || '').replace(/\/obj\/?$/, '/wf');
app.post('/entrar', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const pass = (req.body || {}).pass;
    if (!email || typeof pass !== 'string' || !pass || email.length > 160 || pass.length > 200) {
      return res.json({ status: 'error', message: 'Preenche o email e a password.' });
    }
    const ip = ipDe(req);
    if (excedido('login-falha:' + email, 6) || excedido('login-falha-ip:' + ip, 25)) {
      return res.status(429).json({ status: 'error', codigo: 'limite', message: 'Demasiadas tentativas. Espera 15 minutos e tenta outra vez.' });
    }

    let resposta;
    try {
      const r = await fetch(BUBBLE_WF_BASE + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pass })
      });
      resposta = await r.json();
    } catch (e) {
      console.error('Erro a chamar o login do Bubble:', e.message);
      return res.json({ status: 'error', codigo: 'indisponivel', message: 'Não foi possível ligar ao servidor. Tenta novamente.' });
    }

    if (!resposta || resposta.status !== 'success') {
      contar('login-falha:' + email, 6, 15 * MIN);
      contar('login-falha-ip:' + ip, 25, 15 * MIN);
      return res.json({ status: 'error', message: 'Email ou password incorrectos.' });
    }
    const r = resposta.response || {};
    const owner = r.user_id || r.owner || r.user || r.id || '';
    if (!owner || !ID_VALIDO.test(String(owner))) {
      console.error('Login do Bubble sem user_id reconhecível. Chaves recebidas:', Object.keys(r));
      return res.json({ status: 'error', codigo: 'indisponivel', message: 'Não foi possível entrar. Tenta novamente.' });
    }
    baldesLimite.delete('login-falha:' + email);
    const token = await criarTokenSessao(String(owner));
    esquecerSessoes(String(owner));
    return res.json({ status: 'success', response: { owner: String(owner), token } });
  } catch (erro) {
    console.error('Erro em /entrar:', erro);
    return res.json({ status: 'error', codigo: 'indisponivel', message: 'Não foi possível entrar. Tenta novamente.' });
  }
});

// ---- Criar conta e recuperar password pelo container ----
// As páginas chamavam os workflows do Bubble directamente pelo domínio
// (daniel-ia.pro/api/1.1/wf/...). Se o domínio falhar ou o browser bloquear
// o pedido, a pessoa via "Não foi possível ligar ao servidor". Agora o
// container chama o Bubble pelo mesmo endereço que já usa para tudo o resto
// (BUBBLE_BASE) e devolve a resposta à página. Só estes workflows passam
// por aqui (o login tem a rota /entrar, com bloqueio de tentativas).
const WORKFLOWS_CONTA = {
  'signup': { campos: { nome: 120, email: 160, pass: 200 }, limiteIp: [5, 60 * MIN] },
  'forgot-password': { campos: { email: 160 }, limiteIp: [6, 60 * MIN], limiteEmail: [3, 60 * MIN] },
  'reset-password': { campos: { token: 300, newpass: 200 }, limiteIp: [10, 60 * MIN] }
};
app.post('/conta-wf', async (req, res) => {
  const nome = String((req.body || {}).wf || '');
  const regra = WORKFLOWS_CONTA[nome];
  if (!regra) {
    return res.json({ status: 'error', codigo: 'indisponivel', message: 'Pedido inválido.' });
  }
  const recebidos = (req.body && typeof req.body.dados === 'object' && req.body.dados) || {};
  const dados = {};
  for (const [campo, max] of Object.entries(regra.campos)) {
    const v = recebidos[campo];
    if (typeof v !== 'string' || !v || v.length > max) {
      return res.json({ status: 'error', message: 'Preenche todos os campos.' });
    }
    dados[campo] = campo === 'email' ? v.trim().toLowerCase() : v;
  }
  const ip = ipDe(req);
  if (!contar('conta-wf:' + nome + ':ip:' + ip, regra.limiteIp[0], regra.limiteIp[1])) {
    return res.status(429).json({ status: 'error', codigo: 'limite', message: MSG_LIMITE });
  }
  if (regra.limiteEmail && !contar('conta-wf:' + nome + ':email:' + dados.email, regra.limiteEmail[0], regra.limiteEmail[1])) {
    return res.status(429).json({ status: 'error', codigo: 'limite', message: MSG_LIMITE });
  }

  let resposta;
  try {
    const r = await fetch(BUBBLE_WF_BASE + '/' + nome, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados)
    });
    const texto = await r.text();
    try { resposta = JSON.parse(texto); } catch (e) {
      console.error('Workflow ' + nome + ' do Bubble devolveu algo que não é JSON (HTTP ' + r.status + '):', texto.slice(0, 200));
      return res.json({ status: 'error', codigo: 'indisponivel', message: 'Não foi possível ligar ao servidor. Tenta novamente.' });
    }
  } catch (e) {
    console.error('Erro a chamar o workflow ' + nome + ' do Bubble:', e.message);
    return res.json({ status: 'error', codigo: 'indisponivel', message: 'Não foi possível ligar ao servidor. Tenta novamente.' });
  }

  if (resposta && resposta.status === 'success') {
    return res.json({ status: 'success', response: resposta.response || {} });
  }
  // Erros do Bubble vêm em formatos diferentes (ex: email já registado).
  const corpo = (resposta && resposta.body) || {};
  const msg = resposta && (resposta.message || corpo.message);
  console.warn('Workflow ' + nome + ' recusado pelo Bubble:', JSON.stringify(resposta).slice(0, 300));
  return res.json({ status: 'error', message: msg ? String(msg).slice(0, 200) : 'Não foi possível concluir. Verifica os dados e tenta novamente.' });
});

// ---- Sair: o token deixa de valer em todo o lado ----
app.post('/sair', async (req, res) => {
  try {
    const { owner } = req.body || {};
    if (owner) {
      await bubblePatch('user', owner, { 'Token Sessao': '', 'Token Sessao Expira': new Date(0).toISOString() });
      esquecerSessoes(owner);
    }
    return res.json({ status: 'success' });
  } catch (erro) {
    return res.json({ status: 'success' });
  }
});

app.post('/sessao-criar', async (req, res) => {
  try {
    const { owner, key } = req.body;
    if (!chaveAdminValida(key)) {
      contar('admin-falha:' + ipDe(req), 10, 30 * 60 * 1000);
      return res.json({ status: 'error', message: 'Não autorizado.' });
    }
    if (!owner) {
      return res.json({ status: 'error', message: 'Falta o owner.' });
    }

    const token = await criarTokenSessao(owner);
    esquecerSessoes(owner);
    return res.json({ status: 'success', token: token });
  } catch (erro) {
    console.error('Erro em /sessao-criar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível criar a sessão. Tenta novamente.' });
  }
});

// Confere se um par owner+token corresponde a uma sessão válida e ainda
// dentro do prazo. Devolve o utilizador (já carregado, para não teres de
// o voltar a pedir à Data API) quando está tudo certo, ou null quando não
// está - a rota que chamar isto decide o que responder ao browser nesse
// caso (ver exemplo de uso mais abaixo).
async function validarSessao(owner, token) {
  try {
    if (!owner || !token) return null;
    const usuario = await bubbleGet('user', owner);
    if (!usuario) return null;

    const tokenCerto = usuario['Token Sessao'];
    if (!tokenCerto || tokenCerto !== token) return null;

    const expiraEm = usuario['Token Sessao Expira'] ? new Date(usuario['Token Sessao Expira']) : null;
    if (!expiraEm || isNaN(expiraEm.getTime()) || expiraEm.getTime() < Date.now()) return null;

    return usuario;
  } catch (erro) {
    console.error('Erro em validarSessao:', erro);
    return null;
  }
}

// ======================================================
// Aviso de expiração de plano
// ======================================================
// Em vez de depender de um workflow agendado no Bubble (o que obrigaria a
// instalar o plugin API Connector só para isto), o próprio container
// verifica sozinho quem tem um plano PAGO a expirar em breve e manda o
// aviso por Resend. Idempotente - o campo "Aviso Enviado" no User impede
// avisos repetidos; só é limpo de novo quando a assinatura é renovada
// (ver /wh-assinatura-dk7x2mq9pw).
//
// Campo novo no Bubble antes disto funcionar: tipo User, campo
// "Aviso Enviado" (yes/no).
const DIAS_AVISO_EXPIRACAO = 3;

async function verificarAvisosExpiracao() {
  try {
    const agora = new Date();
    const limite = new Date(agora.getTime() + DIAS_AVISO_EXPIRACAO * 24 * 60 * 60 * 1000);

    const utilizadores = await bubbleList('user', [
      { key: 'Plan Expires', constraint_type: 'greater than', value: agora.toISOString() },
      { key: 'Plan Expires', constraint_type: 'less than', value: limite.toISOString() },
      { key: 'Aviso Enviado', constraint_type: 'not equal', value: true }
    ]);

    console.log(`Verificação de avisos de expiração: ${utilizadores.length} conta(s) dentro da janela de ${DIAS_AVISO_EXPIRACAO} dias.`);

    for (const usuario of utilizadores) {
      try {
        const emailDestino =
          usuario.email ||
          (usuario.authentication && usuario.authentication.email && usuario.authentication.email.email) ||
          '';
        if (!emailDestino || !usuario['Plan']) continue;

        const plano = await bubbleGet('plan', usuario['Plan']);
        if (!plano || !(plano['Price MZN'] > 0)) continue; // plano grátis - nunca avisa

        const dataExpira = new Date(usuario['Plan Expires']);
        const diasRestantes = Math.max(0, Math.ceil((dataExpira.getTime() - agora.getTime()) / (24 * 60 * 60 * 1000)));

        await enviarEmail(
          emailDestino,
          'O teu plano está prestes a expirar - Daniel IA',
          templateEmailAvisoExpiracao(usuario['Full Name'], plano['Name'], dataExpira, diasRestantes)
        );
        await bubblePatch('user', usuario._id, { 'Aviso Enviado': true });
        console.log('Aviso de expiração enviado:', usuario._id);
      } catch (erroUsuario) {
        console.error('Falhou o aviso de expiração para', usuario._id, erroUsuario);
      }
    }
  } catch (erro) {
    console.error('Erro ao verificar avisos de expiração:', erro);
  }
}

// Corre pouco depois do arranque (dá tempo às variáveis de ambiente
// ficarem disponíveis) e depois repete a cada 24 horas, sozinho.
setTimeout(verificarAvisosExpiracao, 60 * 1000);
setInterval(verificarAvisosExpiracao, 24 * 60 * 60 * 1000);

// Rota para testares a verificação na hora, sem esperar pelo ciclo
// automático - endereço pouco óbvio de propósito, mesmo padrão dos
// webhooks, MAS agora também exige a ADMIN_SECRET (antes não exigia nada,
// e qualquer pessoa que descobrisse o endereço conseguia disparar avisos
// de expiração para todos os utilizadores à vontade). Devolve quantas
// contas foram avisadas desta vez.
app.post('/plan-warnings-teste-7hq2fx', async (req, res) => {
  try {
    if (!chaveAdminValida(req.body.key)) {
      contar('admin-falha:' + ipDe(req), 10, 30 * 60 * 1000);
      return res.json({ status: 'error', message: 'Não autorizado.' });
    }
    await verificarAvisosExpiracao();
    return res.json({ status: 'success', message: 'Verificação feita - ver os logs do container para detalhes.' });
  } catch (erro) {
    console.error('Erro em /plan-warnings:', erro);
    return res.json({ status: 'error', message: 'Não foi possível fazer a verificação.' });
  }
});

// ======================================================
// KYC - verificação de identidade (14/10/2026)
// ======================================================
// Quem quiser cobrar pelos meios de pagamento do Daniel IA (a nossa conta
// MozPayment) tem de verificar a identidade primeiro: selfie tirada na
// hora pela câmara do telemóvel + B.I. frente e verso, também pela câmara.
// Depois aprovamos ou rejeitamos à mão, na página /admin-kyc.
//
// As fotos são dados pessoais sensíveis, por isso NUNCA ficam legíveis no
// Bunny: são cifradas aqui (AES-256-GCM) antes de subir, com a chave
// KYC_ENC_KEY que só existe nas variáveis do container. Mesmo que alguém
// descubra o caminho do ficheiro na CDN, só encontra bytes sem sentido.
// Só a página de admin (com a ADMIN_SECRET) consegue pedir ao container
// para as decifrar e mostrar.
//
// Antes disto funcionar:
//   - Bubble: data type "KYC" com os campos Owner, Nome Completo,
//     Numero BI, Telefone, Estado, Selfie, BI Frente, BI Verso, Motivo
//     (todos text) e Revisto Em (date). Exposto na Data API, SEM nenhuma
//     permissão para "Everyone else" nas Privacy Rules.
//   - Bunny (variáveis do container): KYC_ENC_KEY (64 caracteres
//     hexadecimais) e, opcional, ADMIN_EMAIL (recebe um aviso a cada
//     pedido novo).
const KYC_ENC_KEY = clean(process.env.KYC_ENC_KEY);
const ADMIN_EMAIL = clean(process.env.ADMIN_EMAIL);
const KYC_ADMIN_URL = SELF_URL + '/admin-kyc';
const KYC_APP_URL = 'https://app.daniel-ia.pro/kyc/';

function chaveKyc() {
  if (!KYC_ENC_KEY || !/^[0-9a-fA-F]{64}$/.test(KYC_ENC_KEY)) {
    throw new Error('Falta a variável KYC_ENC_KEY no container (tem de ter 64 caracteres hexadecimais).');
  }
  return Buffer.from(KYC_ENC_KEY, 'hex');
}

// Formato guardado: [12 bytes IV][16 bytes tag][dados cifrados]
function cifrarKyc(buffer) {
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', chaveKyc(), iv);
  const cifrado = Buffer.concat([cifra.update(buffer), cifra.final()]);
  return Buffer.concat([iv, cifra.getAuthTag(), cifrado]);
}

function decifrarKyc(buffer) {
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const dados = buffer.subarray(28);
  const decifra = crypto.createDecipheriv('aes-256-gcm', chaveKyc(), iv);
  decifra.setAuthTag(tag);
  return Buffer.concat([decifra.update(dados), decifra.final()]);
}

async function descarregarDoBunny(caminho) {
  const res = await fetch(`https://${STORAGE_HOST}/${STORAGE_ZONE}/${caminho}`, {
    headers: { AccessKey: STORAGE_PASSWORD }
  });
  if (!res.ok) throw new Error('Download do Bunny falhou: ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// Só aceita JPEG em data URL, com tamanho razoável - a página do KYC
// tira a foto da câmara e converte-a sempre para JPEG antes de enviar.
function imagemKycDeDataUrl(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buffer = Buffer.from(m[1], 'base64');
  if (buffer.length < 15 * 1024 || buffer.length > 4 * 1024 * 1024) return null;
  if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;
  return buffer;
}

async function guardarImagemKyc(owner, nome, buffer) {
  const caminho = `kyc/${owner}/${Date.now()}-${crypto.randomBytes(12).toString('hex')}-${nome}.bin`;
  await uploadParaBunny(caminho, cifrarKyc(buffer), 'application/octet-stream');
  return caminho;
}

// O pedido mais recente desta conta (ou null se nunca pediu).
async function kycDoOwner(owner) {
  const lista = await bubbleList(
    'kyc',
    [{ key: 'Owner', constraint_type: 'equals', value: owner }],
    'Created Date',
    true
  );
  return lista[0] || null;
}

// Para usar mais tarde na loja: só quem tem KYC aprovado pode cobrar
// pelos pagamentos do Daniel IA.
async function kycAprovado(owner) {
  const kyc = await kycDoOwner(owner).catch(() => null);
  return !!(kyc && kyc['Estado'] === 'Aprovado');
}

// O KYC mexe em documentos de identidade - exige sempre sessão válida
// (owner + token), nunca só o owner.
async function exigirSessao(req, res) {
  const { owner, token } = req.body || {};
  const usuario = await validarSessao(owner, token);
  if (!usuario) {
    res.json({ status: 'error', codigo: 'sessao', message: 'A tua sessão expirou. Entra outra vez na tua conta.' });
    return null;
  }
  return usuario;
}

function chaveAdminValida(chave) {
  if (!ADMIN_SECRET || typeof chave !== 'string') return false;
  const a = Buffer.from(chave);
  const b = Buffer.from(ADMIN_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function emailDoUsuario(usuario) {
  return (usuario && (usuario.email ||
    (usuario.authentication && usuario.authentication.email && usuario.authentication.email.email))) || '';
}

// Email simples na identidade Daniel IA (mesmo cabeçalho dos outros).
function templateEmailKyc(titulo, saudacao, paragrafos, botao) {
  const corpo = paragrafos.map(p => (p.indexOf('<table') === 0 || p.indexOf('<span') === 0)
    ? '<div style="margin:0 0 14px 0;">' + p + '</div>'
    : `<p style="margin:0 0 14px 0;color:#6F5E81;font-size:14px;line-height:1.6;">${p}</p>`).join('\n');
  const btn = botao
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-top:12px;">
<a href="${escaparHtml(botao.url)}" style="display:inline-block;background:#89C804;color:#1A0A27;font-weight:800;text-decoration:none;font-size:14px;padding:13px 28px;border-radius:10px;">${escaparHtml(botao.texto)}</a>
</td></tr></table>`
    : '';
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escaparHtml(titulo)} - Daniel IA</title>
</head>
<body style="margin:0;padding:0;background:#F4F0F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F0F8;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:460px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #EAE2F2;">
<tr>
<td bgcolor="#430960" style="background:#430960;background-image:linear-gradient(135deg,#5A0F80 0%,#2E0644 100%);padding:28px 32px 24px 32px;text-align:center;border-bottom:4px solid #89C804;">
<img src="https://app.daniel-ia.pro/marca/daniel-ia-logo-email.png" width="168" alt="Daniel IA" style="display:inline-block;width:168px;max-width:100%;height:auto;border:0;outline:none;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;">
</td>
</tr>
<tr>
<td style="padding:36px 32px 28px 32px;">
<p style="margin:0 0 6px 0;color:#1A0A27;font-size:18px;font-weight:700;">${saudacao}</p>
${corpo}
${btn}
</td>
</tr>
<tr>
<td style="padding:18px 32px;background:#FAF8FC;border-top:1px solid #EAE2F2;text-align:center;">
<p style="margin:0;color:#B3A7C2;font-size:11.5px;">Daniel IA · daniel-ia.pro</p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ---- Estado do KYC da própria conta ----
app.post('/kyc-estado', async (req, res) => {
  try {
    const usuario = await exigirSessao(req, res);
    if (!usuario) return;
    const kyc = await kycDoOwner(req.body.owner);
    return res.json({
      status: 'success',
      response: {
        estado: kyc ? (kyc['Estado'] || 'Pendente') : 'Nenhum',
        motivo: kyc ? (kyc['Motivo'] || '') : '',
        enviado: kyc ? kyc['Created Date'] : null
      }
    });
  } catch (erro) {
    console.error('Erro em /kyc-estado:', erro);
    return res.json({ status: 'error', message: 'Não foi possível ver o estado da verificação.' });
  }
});

// ---- Enviar o pedido de KYC ----
app.post('/kyc-enviar', async (req, res) => {
  try {
    const usuario = await exigirSessao(req, res);
    if (!usuario) return;
    const owner = req.body.owner;

    const nome = String(req.body.nome || '').trim().replace(/\s+/g, ' ');
    const numeroBi = String(req.body.numero_bi || '').trim().toUpperCase().replace(/\s+/g, '');
    const telefone = String(req.body.telefone || '').replace(/[^0-9+]/g, '');
    if (nome.length < 5 || nome.length > 120) {
      return res.json({ status: 'error', message: 'Escreve o teu nome completo, igual ao do B.I.' });
    }
    if (!/^[0-9A-Z]{8,20}$/.test(numeroBi)) {
      return res.json({ status: 'error', message: 'O número do B.I. não parece válido.' });
    }
    if (!/^\+?[0-9]{9,15}$/.test(telefone)) {
      return res.json({ status: 'error', message: 'O número de telefone não parece válido.' });
    }

    const anterior = await kycDoOwner(owner);
    if (anterior && anterior['Estado'] === 'Pendente') {
      return res.json({ status: 'error', message: 'Já tens um pedido em análise. Avisamos-te por email assim que for revisto.' });
    }
    if (anterior && anterior['Estado'] === 'Aprovado') {
      return res.json({ status: 'error', message: 'A tua identidade já está verificada.' });
    }

    const selfie = imagemKycDeDataUrl(req.body.selfie);
    const biFrente = imagemKycDeDataUrl(req.body.bi_frente);
    const biVerso = imagemKycDeDataUrl(req.body.bi_verso);
    if (!selfie || !biFrente || !biVerso) {
      return res.json({ status: 'error', message: 'Faltam fotos ou alguma ficou inválida. Tira-as outra vez.' });
    }

    const [caminhoSelfie, caminhoFrente, caminhoVerso] = await Promise.all([
      guardarImagemKyc(owner, 'selfie', selfie),
      guardarImagemKyc(owner, 'bi-frente', biFrente),
      guardarImagemKyc(owner, 'bi-verso', biVerso)
    ]);

    await bubbleCreate('kyc', {
      'Owner': owner,
      'Nome Completo': nome,
      'Numero BI': numeroBi,
      'Telefone': telefone,
      'Estado': 'Pendente',
      'Selfie': caminhoSelfie,
      'BI Frente': caminhoFrente,
      'BI Verso': caminhoVerso,
      'Motivo': ''
    });

    const emailCliente = emailDoUsuario(usuario);
    const primeiroNome = escaparHtml(nome.split(' ')[0]);
    if (emailCliente) {
      enviarEmail(emailCliente, 'Recebemos a tua verificação - Daniel IA', templateEmailKyc(
        'Verificação recebida', `Olá, ${primeiroNome}.`,
        ['Recebemos a tua selfie e o teu B.I. A nossa equipa vai rever os documentos e avisamos-te por email assim que estiver feito.',
         'Normalmente demora menos de 24 horas úteis.']
      )).catch(e => console.error('Email KYC (cliente) falhou:', e.message));
    }
    if (ADMIN_EMAIL) {
      enviarEmail(ADMIN_EMAIL, 'Novo pedido de KYC - ' + nome, templateEmailKyc(
        'Novo pedido de KYC', 'Novo pedido de verificação',
        [`<strong>${escaparHtml(nome)}</strong> (B.I. ${escaparHtml(numeroBi)}, tel. ${escaparHtml(telefone)}) enviou os documentos.`],
        { texto: 'Abrir painel de KYC', url: KYC_ADMIN_URL }
      )).catch(e => console.error('Email KYC (admin) falhou:', e.message));
    }

    return res.json({ status: 'success', response: { estado: 'Pendente' } });
  } catch (erro) {
    console.error('Erro em /kyc-enviar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível enviar a verificação. Tenta novamente.' });
  }
});

// ---- Admin: lista de pedidos ----
app.post('/admin-kyc-lista', async (req, res) => {
  try {
    if (!(await adminAutorizado(req))) {
      contar('admin-falha:' + ipDe(req), 10, 30 * 60 * 1000);
      return res.json({ status: 'error', message: 'Chave inválida.' });
    }
    const estado = ['Pendente', 'Aprovado', 'Rejeitado'].includes(req.body.estado) ? req.body.estado : 'Pendente';
    const pedidos = await bubbleList(
      'kyc',
      [{ key: 'Estado', constraint_type: 'equals', value: estado }],
      'Created Date',
      estado !== 'Pendente' // pendentes: os mais antigos primeiro
    );
    const lista = await Promise.all(pedidos.map(async k => {
      const dono = await bubbleGet('user', k['Owner']).catch(() => null);
      return {
        id: k._id,
        nome: k['Nome Completo'] || '',
        numero_bi: k['Numero BI'] || '',
        telefone: k['Telefone'] || '',
        email: emailDoUsuario(dono),
        estado: k['Estado'] || '',
        motivo: k['Motivo'] || '',
        enviado: k['Created Date'],
        revisto: k['Revisto Em'] || null
      };
    }));
    return res.json({ status: 'success', response: { pedidos: lista } });
  } catch (erro) {
    console.error('Erro em /admin-kyc-lista:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os pedidos.' });
  }
});

// ======================================================
// Painel de administração (1.58.0)
// ------------------------------------------------------
// Entra com a sessão normal da app (owner + token) e só se o email da conta
// estiver em ADMIN_EMAILS (variável do container, separada por vírgulas).
// Sem a variável, vale só nikayia2026@gmail.com. Cada acção fica registada.
// ======================================================
const ADMIN_EMAILS = (clean(process.env.ADMIN_EMAILS) || 'nikayia2026@gmail.com')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
function ehAdmin(usuario) {
  const email = String(emailDoUsuario(usuario) || '').trim().toLowerCase();
  return !!email && ADMIN_EMAILS.includes(email);
}
async function adminAutorizado(req) {
  if (chaveAdminValida(req.body && req.body.key)) return true;
  const { owner, token } = req.body || {};
  const usuario = await validarSessao(owner, token);
  return !!usuario && ehAdmin(usuario);
}
async function exigirAdmin(req, res) {
  const usuario = await validarSessao((req.body || {}).owner, (req.body || {}).token);
  if (!usuario || !ehAdmin(usuario)) {
    contar('admin-falha:' + ipDe(req), 10, 30 * 60 * 1000);
    console.warn('[admin] acesso recusado', (req.body || {}).owner, 'IP', ipDe(req), req.path);
    res.json({ status: 'error', codigo: 'admin', message: 'Acesso reservado à administração.' });
    return null;
  }
  return usuario;
}
// Registo das acções (memória do container; também vai para os logs do Bunny).
const registoAdmin = [];
function registar(admin, accao, detalhe) {
  const linha = { quando: new Date().toISOString(), quem: emailDoUsuario(admin) || admin._id, accao, detalhe: String(detalhe || '').slice(0, 300) };
  registoAdmin.unshift(linha);
  if (registoAdmin.length > 300) registoAdmin.pop();
  console.log('[admin]', linha.quem, accao, linha.detalhe);
}
// Listas completas (o bubbleList normal pára nos 100), com cache curta.
async function bubbleListTodos(tipo, constraints, max) {
  const todos = [];
  let cursor = 0;
  for (let volta = 0; volta < 60; volta++) {
    const params = new URLSearchParams();
    params.set('constraints', JSON.stringify(constraints || []));
    params.set('sort_field', 'Created Date');
    params.set('descending', 'true');
    params.set('limit', '100');
    params.set('cursor', String(cursor));
    const res = await fetch(`${BUBBLE_BASE}/${tipo}?${params.toString()}`, { headers: { Authorization: `Bearer ${BUBBLE_TOKEN}` } });
    const json = await res.json();
    if (!res.ok) throw new Error('bubbleListTodos falhou: ' + JSON.stringify(json));
    const r = json.response || {};
    const lote = r.results || [];
    todos.push(...lote);
    cursor += lote.length;
    if (!lote.length || !r.remaining || todos.length >= (max || 5000)) break;
  }
  return todos;
}
const cacheAdmin = new Map();
async function listaAdmin(tipo, forcar) {
  const c = cacheAdmin.get(tipo);
  if (!forcar && c && c.ate > Date.now()) return c.dados;
  const dados = await bubbleListTodos(tipo, []);
  cacheAdmin.set(tipo, { dados, ate: Date.now() + 30 * 1000 });
  return dados;
}
function limparCacheAdmin() { cacheAdmin.clear(); }
function nomePlanoDe(planos, id) { const p = planos.find(x => x._id === id); return p ? (p['Name'] || '') : ''; }
function diasAtras(n) { return Date.now() - n * 86400000; }
function depoisDe(data, ms) { const t = Date.parse(data || ''); return !isNaN(t) && t >= ms; }

app.post('/admin-entrar', async (req, res) => {
  try {
    const usuario = await validarSessao(req.body.owner, req.body.token);
    if (!usuario || !ehAdmin(usuario)) return res.json({ status: 'success', response: { admin: false } });
    return res.json({ status: 'success', response: { admin: true, email: emailDoUsuario(usuario), nome: usuario['Full Name'] || '', versao: VERSION } });
  } catch (erro) {
    return res.json({ status: 'success', response: { admin: false } });
  }
});

app.post('/admin-resumo', async (req, res) => {
  try {
    if (!(await exigirAdmin(req, res))) return;
    const forcar = !!req.body.actualizar;
    const [users, sites, planos, kycs, assinaturas, encomendas] = await Promise.all([
      listaAdmin('user', forcar), listaAdmin('site', forcar), listaAdmin('plan', forcar),
      listaAdmin('kyc', forcar), listaAdmin('assinatura', forcar), listaAdmin('encomenda', forcar)
    ]);
    const conta = (lista, fn) => lista.reduce((m, x) => { const k = fn(x) || '—'; m[k] = (m[k] || 0) + 1; return m; }, {});
    const pagas30 = assinaturas.filter(a => a['Estado'] === 'Pago' && depoisDe(a['Created Date'], diasAtras(30)));
    const enc30 = encomendas.filter(e => depoisDe(e['Created Date'], diasAtras(30)));
    const encPagas30 = enc30.filter(e => e['Estado'] === 'Pago');
    const ultimoKyc = {};
    kycs.forEach(k => { if (!ultimoKyc[k['Owner']]) ultimoKyc[k['Owner']] = k; });
    return res.json({ status: 'success', response: {
      utilizadores: {
        total: users.length,
        novos7: users.filter(u => depoisDe(u['Created Date'], diasAtras(7))).length,
        novos30: users.filter(u => depoisDe(u['Created Date'], diasAtras(30))).length,
        por_plano: conta(users, u => nomePlanoDe(planos, u['Plan']) || 'Sem plano')
      },
      sites: {
        total: sites.length,
        novos7: sites.filter(x => depoisDe(x['Created Date'], diasAtras(7))).length,
        por_tipo: conta(sites, x => x['Tipo']),
        por_estado: conta(sites, x => x['Status'])
      },
      kyc: { pendentes: Object.values(ultimoKyc).filter(k => k['Estado'] === 'Pendente').length, aprovados: Object.values(ultimoKyc).filter(k => k['Estado'] === 'Aprovado').length },
      receita: { assinaturas30: pagas30.reduce((t, a) => t + (Number(a['Valor MZN']) || 0), 0), n_assinaturas30: pagas30.length },
      lojas: { encomendas30: enc30.length, pagas30: encPagas30.length, volume30: encPagas30.reduce((t, e) => t + (Number(e['Valor Total']) || 0), 0) },
      tokens_mes: users.reduce((t, u) => t + (Number(u['Tokens Usados Mes']) || 0), 0),
      geracoes: { activas: geracoesActivas, em_fila: filaGeracoes.length, maximo: GERACOES_EM_PARALELO },
      sistema: {
        versao: VERSION, ligado_ha_min: Math.round(process.uptime() / 60), sessao_modo: SESSAO_MODO,
        config: {
          openai: !!OPENAI_API_KEY, resend: !!clean(process.env.RESEND_KEY), bunny_api: !!clean(process.env.BUNNY_API_KEY),
          stream: !!clean(process.env.STREAM_KEY), mozpayment: !!clean(process.env.MOZPAYMENT_EMAIL), kyc_cifra: !!clean(process.env.KYC_ENC_KEY),
          admin_secret: !!ADMIN_SECRET, admin_emails: ADMIN_EMAILS.length
        },
        cartao: estadoCartaoEmbutir
      },
      planos: planos.map(p => ({ id: p._id, nome: p['Name'] || '', preco: Number(p['Price MZN']) || 0, tokens: Number(p['Tokens Incluidos']) || 0, sites: Number(p['Sites Limit']) || 0, activo: !!p['Is Active'] }))
        .sort((a, b) => a.preco - b.preco)
    } });
  } catch (erro) {
    console.error('Erro em /admin-resumo:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar o resumo.' });
  }
});

function utilizadorParaAdmin(u, planos, sitesPorDono, kycPorDono) {
  const plano = planos.find(p => p._id === u['Plan']);
  const k = kycPorDono[u._id];
  return {
    id: u._id, nome: u['Full Name'] || '', email: emailDoUsuario(u) || '',
    plano_id: u['Plan'] || '', plano: plano ? (plano['Name'] || '') : '', plano_expira: u['Plan Expires'] || '',
    tokens_usados: Number(u['Tokens Usados Mes']) || 0, tokens_incluidos: plano ? (Number(plano['Tokens Incluidos']) || 0) : 0,
    tokens_extra: Math.max(0, Number(u['Tokens Extra']) || 0),
    sites: sitesPorDono[u._id] || 0, kyc: k ? (k['Estado'] || 'Pendente') : 'Nenhum', criado: u['Created Date'] || ''
  };
}

app.post('/admin-utilizadores', async (req, res) => {
  try {
    if (!(await exigirAdmin(req, res))) return;
    const [users, sites, planos, kycs] = await Promise.all([listaAdmin('user', !!req.body.actualizar), listaAdmin('site'), listaAdmin('plan'), listaAdmin('kyc')]);
    const sitesPorDono = {}; sites.forEach(x => { sitesPorDono[x['Owner']] = (sitesPorDono[x['Owner']] || 0) + 1; });
    const kycPorDono = {}; kycs.forEach(k => { if (!kycPorDono[k['Owner']]) kycPorDono[k['Owner']] = k; });
    const termo = String(req.body.pesquisa || '').trim().toLowerCase().slice(0, 80);
    const planoFiltro = String(req.body.plano_id || '');
    let lista = users.map(u => utilizadorParaAdmin(u, planos, sitesPorDono, kycPorDono));
    if (termo) lista = lista.filter(u => (u.nome + ' ' + u.email + ' ' + u.id).toLowerCase().includes(termo));
    if (planoFiltro) lista = lista.filter(u => u.plano_id === planoFiltro);
    return res.json({ status: 'success', response: { total: lista.length, utilizadores: lista.slice(0, 300) } });
  } catch (erro) {
    console.error('Erro em /admin-utilizadores:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os utilizadores.' });
  }
});

app.post('/admin-utilizador', async (req, res) => {
  try {
    if (!(await exigirAdmin(req, res))) return;
    const u = await bubbleGet('user', req.body.user_id);
    if (!u) return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    const [planos, sites, kycs, assinaturas] = await Promise.all([
      listaAdmin('plan'),
      bubbleList('site', [{ key: 'Owner', constraint_type: 'equals', value: u._id }], 'Created Date', true),
      bubbleList('kyc', [{ key: 'Owner', constraint_type: 'equals', value: u._id }], 'Created Date', true),
      bubbleList('assinatura', [{ key: 'User', constraint_type: 'equals', value: u._id }], 'Created Date', true)
    ]);
    const base = utilizadorParaAdmin(u, planos, { [u._id]: sites.length }, { [u._id]: kycs[0] });
    return res.json({ status: 'success', response: Object.assign(base, {
      plano_inicio: u['Plan Started'] || '',
      sessao_activa: !!u['Token Sessao'] && depoisDe(u['Token Sessao Expira'], Date.now()),
      sites_lista: sites.map(x => ({ id: x._id, nome: x['Nome'] || '', tipo: x['Tipo'] || '', estado: x['Status'] || '', url: x['CDN URL'] || '', criado: x['Created Date'] || '' })),
      assinaturas: assinaturas.slice(0, 20).map(a => ({ plano: rotuloAssinatura(planos, a), recarga: a['Tipo'] === 'Recarga', valor: Number(a['Valor MZN']) || 0, metodo: a['Metodo'] || '', estado: a['Estado'] || '', criado: a['Created Date'] || '' }))
    }) });
  } catch (erro) {
    console.error('Erro em /admin-utilizador:', erro);
    return res.json({ status: 'error', message: 'Não foi possível abrir este utilizador.' });
  }
});

// Atribuir um plano à mão (ex: pagou em dinheiro ou por transferência).
app.post('/admin-atribuir-plano', async (req, res) => {
  try {
    const admin = await exigirAdmin(req, res);
    if (!admin) return;
    const u = await bubbleGet('user', req.body.user_id);
    const plano = await bubbleGet('plan', req.body.plano_id).catch(() => null);
    if (!u) return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    if (!plano) return res.json({ status: 'error', message: 'Plano não encontrado.' });
    const dias = Math.min(3650, Math.max(1, parseInt(req.body.dias, 10) || 30));
    const valor = Math.max(0, Math.round((Number(req.body.valor) || 0) * 100) / 100);
    const agora = new Date();
    const expira = new Date(agora.getTime() + dias * 86400000);
    const dados = { 'Plan': plano._id, 'Plan Started': agora.toISOString(), 'Plan Expires': expira.toISOString(), 'Aviso Enviado': false };
    if (req.body.repor_tokens) dados['Tokens Usados Mes'] = 0;
    await bubblePatch('user', u._id, dados);
    // Fica um registo de assinatura para as contas (método "Manual").
    await bubbleCreate('assinatura', {
      'User': u._id, 'Plano': plano._id, 'Valor MZN': valor, 'Metodo': 'Manual', 'ID Pagamento': '',
      'Estado': 'Pago', 'Transaction ID': 'admin:' + (emailDoUsuario(admin) || admin._id) + (req.body.nota ? ' - ' + textoLimpo(req.body.nota, 120) : ''),
      'Webhook Processado': true, 'Created Date': agora.toISOString()
    }).catch(e => console.error('Registo de assinatura manual falhou:', e.message));
    limparCacheAdmin();
    registar(admin, 'Plano atribuído', `${emailDoUsuario(u) || u._id} -> ${plano['Name']} (${dias} dias, ${valor} MZN)`);
    const email = emailDoUsuario(u);
    if (req.body.avisar && email) {
      enviarEmail(email, 'O teu plano ' + (plano['Name'] || '') + ' está activo - Daniel IA', templateEmailKyc(
        'Plano activado', 'Olá' + (u['Full Name'] ? ', ' + escaparHtml(String(u['Full Name']).split(' ')[0]) : '') + '!',
        [`O teu plano <strong>${escaparHtml(plano['Name'] || '')}</strong> já está activo, até ${expira.toLocaleDateString('pt-PT')}.`, 'Obrigado por confiares no Daniel IA.'],
        { texto: 'Ir para o dashboard', url: APP_URL })).catch(e => console.error('Email de plano manual falhou:', e.message));
    }
    return res.json({ status: 'success', response: { plano: plano['Name'] || '', expira: expira.toISOString() } });
  } catch (erro) {
    console.error('Erro em /admin-atribuir-plano:', erro);
    return res.json({ status: 'error', message: 'Não foi possível atribuir o plano.' });
  }
});

app.post('/admin-tokens', async (req, res) => {
  try {
    const admin = await exigirAdmin(req, res);
    if (!admin) return;
    const u = await bubbleGet('user', req.body.user_id);
    if (!u) return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    const valor = Math.max(0, parseInt(req.body.usados, 10) || 0);
    await bubblePatch('user', u._id, { 'Tokens Usados Mes': valor });
    limparCacheAdmin();
    registar(admin, 'Tokens do mês', `${emailDoUsuario(u) || u._id}: ${Number(u['Tokens Usados Mes']) || 0} -> ${valor}`);
    return res.json({ status: 'success', response: { tokens_usados: valor } });
  } catch (erro) {
    console.error('Erro em /admin-tokens:', erro);
    return res.json({ status: 'error', message: 'Não foi possível mudar os tokens.' });
  }
});

app.post('/admin-terminar-sessoes', async (req, res) => {
  try {
    const admin = await exigirAdmin(req, res);
    if (!admin) return;
    const u = await bubbleGet('user', req.body.user_id);
    if (!u) return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    if (u._id === admin._id) return res.json({ status: 'error', message: 'Para saíres da tua própria conta, usa o botão Sair.' });
    await bubblePatch('user', u._id, { 'Token Sessao': '', 'Token Sessao Expira': new Date(0).toISOString() });
    esquecerSessoes(u._id);
    registar(admin, 'Sessões terminadas', emailDoUsuario(u) || u._id);
    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /admin-terminar-sessoes:', erro);
    return res.json({ status: 'error', message: 'Não foi possível terminar as sessões.' });
  }
});

app.post('/admin-sites', async (req, res) => {
  try {
    if (!(await exigirAdmin(req, res))) return;
    const [sites, users] = await Promise.all([listaAdmin('site', !!req.body.actualizar), listaAdmin('user')]);
    const emailPorId = {}; users.forEach(u => { emailPorId[u._id] = emailDoUsuario(u) || ''; });
    const termo = String(req.body.pesquisa || '').trim().toLowerCase().slice(0, 80);
    const tipo = String(req.body.tipo || ''), estado = String(req.body.estado || '');
    let lista = sites.map(x => ({ id: x._id, nome: x['Nome'] || '', tipo: x['Tipo'] || '', estado: x['Status'] || '', url: x['CDN URL'] || '',
      dono_id: x['Owner'] || '', dono_email: emailPorId[x['Owner']] || '', dominio: x['Dominio'] || '', criado: x['Created Date'] || '' }));
    if (termo) lista = lista.filter(x => (x.nome + ' ' + x.dono_email + ' ' + x.dominio).toLowerCase().includes(termo));
    if (tipo) lista = lista.filter(x => x.tipo === tipo);
    if (estado) lista = lista.filter(x => x.estado === estado);
    return res.json({ status: 'success', response: { total: lista.length, sites: lista.slice(0, 300) } });
  } catch (erro) {
    console.error('Erro em /admin-sites:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os sites.' });
  }
});

app.post('/admin-pagamentos', async (req, res) => {
  try {
    if (!(await exigirAdmin(req, res))) return;
    const forcar = !!req.body.actualizar;
    const [assinaturas, encomendas, users, planos, sites] = await Promise.all([
      listaAdmin('assinatura', forcar), listaAdmin('encomenda', forcar), listaAdmin('user'), listaAdmin('plan'), listaAdmin('site')
    ]);
    const emailPorId = {}; users.forEach(u => { emailPorId[u._id] = emailDoUsuario(u) || ''; });
    const sitePorId = {}; sites.forEach(x => { sitePorId[x._id] = x['Nome'] || ''; });
    return res.json({ status: 'success', response: {
      assinaturas: assinaturas.slice(0, 150).map(a => ({ email: emailPorId[a['User']] || '', plano: rotuloAssinatura(planos, a), recarga: a['Tipo'] === 'Recarga', valor: Number(a['Valor MZN']) || 0,
        metodo: a['Metodo'] || '', estado: a['Estado'] || '', criado: a['Created Date'] || '' })),
      encomendas: encomendas.slice(0, 150).map(e => ({ loja: sitePorId[e['Site']] || '', cliente: e['Cliente Nome'] || '', valor: Number(e['Valor Total']) || 0,
        metodo: e['Metodo'] || '', estado: e['Estado'] || '', criado: e['Created Date'] || '' }))
    } });
  } catch (erro) {
    console.error('Erro em /admin-pagamentos:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os pagamentos.' });
  }
});

// ======================================================
// Cartão embutido (1.59.0)
// ------------------------------------------------------
// O checkout do cartão abre DENTRO da página (app e lojas), numa janela
// por cima, e a página fica à espera da confirmação - a pessoa nunca sai.
// Algumas páginas de pagamento proíbem ser mostradas dentro de outra
// (cabeçalhos X-Frame-Options / frame-ancestors). Verificamos isso aqui,
// no servidor, e a página mostra um botão para abrir à parte nesses casos.
// CARTAO_EMBUTIR no Bunny: "sim" força embutir, "nao" nunca embute,
// vazio = verifica sozinho (recomendado).
// ======================================================
const CARTAO_EMBUTIR = (clean(process.env.CARTAO_EMBUTIR) || 'auto').toLowerCase();
const cacheEmbutir = new Map();
let estadoCartaoEmbutir = { verificado: false, embutivel: null, origem: '', quando: '', modo: CARTAO_EMBUTIR };
function cabecalhosDeixamEmbutir(h) {
  const xfo = String(h.get('x-frame-options') || '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return false;
  const csp = String(h.get('content-security-policy') || '').toLowerCase();
  const m = csp.match(/frame-ancestors([^;]*)/);
  if (m && !m[1].trim().split(/\s+/).includes('*')) return false;
  return true;
}
async function checkoutEmbutivel(url) {
  if (CARTAO_EMBUTIR === 'sim') return true;
  if (CARTAO_EMBUTIR === 'nao') return false;
  let origem = '';
  try { origem = new URL(url).origin; } catch (e) { return false; }
  const c = cacheEmbutir.get(origem);
  if (c && c.ate > Date.now()) return c.ok;
  let ok = true;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (DanielIA verificar checkout)' } });
    clearTimeout(t);
    ok = cabecalhosDeixamEmbutir(r.headers);
    try { if (r.body && r.body.cancel) r.body.cancel(); } catch (e) {}
  } catch (e) {
    ok = true; // sem resposta a tempo: tentamos embutir; a página tem sempre o botão alternativo
  }
  cacheEmbutir.set(origem, { ok, ate: Date.now() + 10 * 60 * 1000 });
  estadoCartaoEmbutir = { verificado: true, embutivel: ok, origem, quando: new Date().toISOString(), modo: CARTAO_EMBUTIR };
  if (!ok) console.warn('[cartao] a página de pagamento de', origem, 'não deixa ser embutida - a app mostra o botão para abrir à parte.');
  return ok;
}

// ======================================================
// Recargas de tokens (1.59.0)
// ------------------------------------------------------
// Pacotes no tipo "Pacote" do Bubble (Name, Tokens, Price MZN, Is Active,
// Sort Order), geridos no painel de administração. Cada compra é uma
// Assinatura com Tipo "Recarga" - usa o mesmo pagamento (M-Pesa, e-Mola,
// cartão) e o mesmo webhook dos planos.
// ======================================================
function pacoteParaLista(p) {
  return { id: p._id, nome: p['Name'] || '', tokens: Number(p['Tokens']) || 0, preco_mzn: Number(p['Price MZN']) || 0,
    activo: !!p['Is Active'], ordem: Number(p['Sort Order']) || 0 };
}
function ordenarPacotes(a, b) { return (a.ordem - b.ordem) || (a.tokens - b.tokens); }
function rotuloAssinatura(planos, a) {
  if (a['Tipo'] === 'Recarga') return 'Recarga · ' + milhares(a['Tokens']) + ' tokens';
  return nomePlanoDe(planos, a['Plano']);
}

app.post('/pacotes', async (req, res) => {
  try {
    const lista = (await bubbleList('pacote', [{ key: 'Is Active', constraint_type: 'equals', value: true }]).catch(() => []))
      .map(pacoteParaLista).filter(p => p.tokens > 0 && p.preco_mzn > 0).sort(ordenarPacotes);
    return res.json({ status: 'success', response: { pacotes: lista } });
  } catch (erro) {
    console.error('Erro em /pacotes:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar as recargas.' });
  }
});

app.post('/recarga-iniciar', async (req, res) => {
  try {
    const { owner, pacote_id } = req.body;
    if (!owner || !pacote_id) return res.json({ status: 'error', message: 'Escolhe um pacote de tokens.' });
    const user = await bubbleGet('user', owner);
    if (!user) return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    const pacote = await bubbleGet('pacote', pacote_id).catch(() => null);
    const tokens = pacote ? Math.round(Number(pacote['Tokens']) || 0) : 0;
    const valor = pacote ? Math.round((Number(pacote['Price MZN']) || 0) * 100) / 100 : 0;
    if (!pacote || !pacote['Is Active'] || tokens <= 0 || valor <= 0) {
      return res.json({ status: 'error', message: 'Este pacote já não está disponível.' });
    }
    const assinaturaId = await bubbleCreate('assinatura', {
      'User': owner, 'Valor MZN': valor, 'Metodo': '', 'ID Pagamento': '', 'Estado': 'Pendente',
      'Transaction ID': '', 'Webhook Processado': false, 'Tipo': 'Recarga', 'Tokens': tokens, 'Pacote': pacote._id,
      'Created Date': new Date().toISOString()
    });
    return res.json({ status: 'success', response: { assinatura_id: assinaturaId, tokens, valor_mzn: valor } });
  } catch (erro) {
    console.error('Erro em /recarga-iniciar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível iniciar a recarga.' });
  }
});

async function aplicarRecarga(assinatura) {
  const user = await bubbleGet('user', assinatura['User']);
  if (!user) return;
  const tokens = Math.max(0, Math.round(Number(assinatura['Tokens']) || 0));
  const novo = Math.max(0, Number(user['Tokens Extra']) || 0) + tokens;
  await bubblePatch('user', user._id, { 'Tokens Extra': novo });
  console.log('Recarga paga e aplicada:', assinatura._id, '+' + tokens, 'tokens');
  try {
    const email = emailDoUsuario(user);
    if (email) {
      await enviarEmail(email, 'Recarga de tokens confirmada - Daniel IA', templateEmailKyc(
        'Recarga confirmada', 'Olá' + (user['Full Name'] ? ', ' + escaparHtml(String(user['Full Name']).split(' ')[0]) : '') + '!',
        [`Recebemos o teu pagamento de <strong>${escaparHtml(milhares(assinatura['Valor MZN']))} MZN</strong>.`,
          `Juntámos <strong>${escaparHtml(milhares(tokens))} tokens</strong> à tua conta. Tens agora ${escaparHtml(milhares(novo))} tokens recarregados, que não expiram e são usados depois dos tokens do teu plano.`],
        { texto: 'Ir para o dashboard', url: APP_URL }));
    }
  } catch (erroEmail) {
    console.error('Recarga aplicada, mas o email falhou:', erroEmail.message);
  }
}

// ======================================================
// Painel: planos e pacotes de recarga (1.59.0)
// ======================================================
function numeroEntre(v, min, max) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}
function planoParaAdmin(p, contas) {
  return { id: p._id, nome: p['Name'] || '', preco: Number(p['Price MZN']) || 0, tokens: Number(p['Tokens Incluidos']) || 0,
    sites: Number(p['Sites Limit']) || 0, colaboradores: Number(p['Max Colaboradores']) || 0, dominio: !!p['Permite Dominio'],
    espaco_mb: Math.round((Number(p['Storage Limit Bytes']) || 0) / 1048576),
    activo: !!p['Is Active'], contas: contas || 0 };
}

app.post('/admin-planos', async (req, res) => {
  try {
    if (!(await exigirAdmin(req, res))) return;
    const [planos, users] = await Promise.all([listaAdmin('plan', true), listaAdmin('user')]);
    let pacotes = null;
    try { pacotes = await listaAdmin('pacote', true); } catch (e) { pacotes = null; }
    const porPlano = {};
    users.forEach(u => { porPlano[u['Plan']] = (porPlano[u['Plan']] || 0) + 1; });
    return res.json({ status: 'success', response: {
      planos: planos.map(p => planoParaAdmin(p, porPlano[p._id])).sort((a, b) => a.preco - b.preco),
      pacotes: pacotes ? pacotes.map(pacoteParaLista).sort(ordenarPacotes) : [],
      pacotes_ok: !!pacotes
    } });
  } catch (erro) {
    console.error('Erro em /admin-planos:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar os planos.' });
  }
});

app.post('/admin-plano-guardar', async (req, res) => {
  try {
    const admin = await exigirAdmin(req, res);
    if (!admin) return;
    const b = req.body;
    const nome = textoLimpo(b.nome, 40);
    if (nome.length < 2) return res.json({ status: 'error', message: 'Dá um nome ao plano.' });
    const preco = numeroEntre(b.preco, 0, 1000000);
    const tokens = numeroEntre(b.tokens, 0, 1000000000);
    const sites = numeroEntre(b.sites, 0, 100000);
    const colab = numeroEntre(b.colaboradores || 0, 0, 1000);
    const espacoMb = (b.espaco_mb === undefined || b.espaco_mb === null || b.espaco_mb === '') ? null : numeroEntre(b.espaco_mb, 0, 10000000);
    if (preco === null || tokens === null || sites === null || colab === null) return res.json({ status: 'error', message: 'Confirma os números do plano.' });
    const todos = await listaAdmin('plan', true);
    const igual = todos.find(p => String(p['Name'] || '').trim().toLowerCase() === nome.toLowerCase() && p._id !== b.plano_id);
    if (igual) return res.json({ status: 'error', message: 'Já existe um plano com o nome "' + nome + '".' });
    const dados = {
      'Name': nome, 'Price MZN': Math.round(preco * 100) / 100, 'Tokens Incluidos': Math.round(tokens), 'Sites Limit': Math.round(sites),
      'Max Colaboradores': Math.round(colab), 'Permite Dominio': !!b.dominio, 'Is Active': !!b.activo
    };
    // Espaço para fotos e vídeos: sem isto, quem está no plano não consegue carregar imagens.
    if (espacoMb !== null) dados['Storage Limit Bytes'] = Math.round(espacoMb * 1048576);
    else if (!b.plano_id) dados['Storage Limit Bytes'] = 1024 * 1048576;
    let id = b.plano_id;
    if (id) {
      const antes = todos.find(p => p._id === id);
      if (!antes) return res.json({ status: 'error', message: 'Plano não encontrado.' });
      if (String(antes['Name'] || '').trim().toLowerCase() === 'free' && nome.toLowerCase() !== 'free') {
        return res.json({ status: 'error', message: 'O plano Free tem de continuar a chamar-se "Free" - é por esse nome que o sistema o reconhece.' });
      }
      if (String(antes['Name'] || '').trim().toLowerCase() === 'free' && !dados['Is Active']) {
        return res.json({ status: 'error', message: 'O plano Free tem de ficar activo - é o plano de quem acaba de criar conta.' });
      }
      await bubblePatch('plan', id, dados);
      registar(admin, 'Plano editado', `${nome}: ${dados['Price MZN']} MZN, ${dados['Tokens Incluidos']} tokens, ${dados['Sites Limit']} sites${dados['Is Active'] ? '' : ' (inactivo)'}`);
    } else {
      id = await bubbleCreate('plan', dados);
      registar(admin, 'Plano criado', `${nome}: ${dados['Price MZN']} MZN, ${dados['Tokens Incluidos']} tokens, ${dados['Sites Limit']} sites`);
    }
    limparCacheAdmin();
    return res.json({ status: 'success', response: { id } });
  } catch (erro) {
    console.error('Erro em /admin-plano-guardar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível guardar o plano.' });
  }
});

app.post('/admin-pacote-guardar', async (req, res) => {
  try {
    const admin = await exigirAdmin(req, res);
    if (!admin) return;
    const b = req.body;
    const tokens = numeroEntre(b.tokens, 1, 1000000000);
    const preco = numeroEntre(b.preco, 1, 1000000);
    const ordem = numeroEntre(b.ordem || 0, 0, 1000);
    if (tokens === null || preco === null || ordem === null) return res.json({ status: 'error', message: 'Confirma os tokens e o preço do pacote.' });
    const nome = textoLimpo(b.nome, 40) || (milhares(tokens) + ' tokens');
    const dados = { 'Name': nome, 'Tokens': Math.round(tokens), 'Price MZN': Math.round(preco * 100) / 100, 'Is Active': !!b.activo, 'Sort Order': Math.round(ordem) };
    let id = b.pacote_id;
    if (id) {
      await bubblePatch('pacote', id, dados);
      registar(admin, 'Recarga editada', `${nome}: ${dados['Tokens']} tokens por ${dados['Price MZN']} MZN${dados['Is Active'] ? '' : ' (inactiva)'}`);
    } else {
      id = await bubbleCreate('pacote', dados);
      registar(admin, 'Recarga criada', `${nome}: ${dados['Tokens']} tokens por ${dados['Price MZN']} MZN`);
    }
    limparCacheAdmin();
    return res.json({ status: 'success', response: { id } });
  } catch (erro) {
    console.error('Erro em /admin-pacote-guardar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível guardar o pacote. Confirma que o tipo "Pacote" já existe no Bubble.' });
  }
});

// Três pacotes para começar (editáveis depois). Só se ainda não houver nenhum.
app.post('/admin-pacotes-sugeridos', async (req, res) => {
  try {
    const admin = await exigirAdmin(req, res);
    if (!admin) return;
    let existentes = [];
    try { existentes = await listaAdmin('pacote', true); } catch (e) {
      return res.json({ status: 'error', message: 'Cria primeiro o tipo "Pacote" no Bubble.' });
    }
    if (existentes.length) return res.json({ status: 'error', message: 'Já tens pacotes criados.' });
    const sugeridos = [
      { 'Name': 'Recarga pequena', 'Tokens': 50000, 'Price MZN': 350, 'Is Active': true, 'Sort Order': 1 },
      { 'Name': 'Recarga média', 'Tokens': 150000, 'Price MZN': 900, 'Is Active': true, 'Sort Order': 2 },
      { 'Name': 'Recarga grande', 'Tokens': 500000, 'Price MZN': 2500, 'Is Active': true, 'Sort Order': 3 }
    ];
    for (const p of sugeridos) await bubbleCreate('pacote', p);
    limparCacheAdmin();
    registar(admin, 'Recargas sugeridas criadas', '50 000 / 150 000 / 500 000 tokens');
    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /admin-pacotes-sugeridos:', erro);
    return res.json({ status: 'error', message: 'Não foi possível criar os pacotes.' });
  }
});

// Dar (ou acertar) tokens recarregados a uma pessoa - ex: pagou por fora.
app.post('/admin-tokens-extra', async (req, res) => {
  try {
    const admin = await exigirAdmin(req, res);
    if (!admin) return;
    const u = await bubbleGet('user', req.body.user_id);
    if (!u) return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    const valor = numeroEntre(req.body.valor, -1000000000, 1000000000);
    if (valor === null) return res.json({ status: 'error', message: 'Escreve quantos tokens.' });
    const antes = Math.max(0, Number(u['Tokens Extra']) || 0);
    const novo = req.body.modo === 'definir' ? Math.max(0, Math.round(valor)) : Math.max(0, antes + Math.round(valor));
    await bubblePatch('user', u._id, { 'Tokens Extra': novo });
    limparCacheAdmin();
    registar(admin, 'Tokens recarregados', `${emailDoUsuario(u) || u._id}: ${antes} -> ${novo}` + (req.body.nota ? ' - ' + textoLimpo(req.body.nota, 120) : ''));
    return res.json({ status: 'success', response: { tokens_extra: novo } });
  } catch (erro) {
    console.error('Erro em /admin-tokens-extra:', erro);
    return res.json({ status: 'error', message: 'Não foi possível mudar os tokens. Confirma que o campo "Tokens Extra" já existe no User.' });
  }
});

app.post('/admin-registo', async (req, res) => {
  if (!(await exigirAdmin(req, res))) return;
  return res.json({ status: 'success', response: { registo: registoAdmin.slice(0, 200) } });
});

// ---- Admin: uma imagem decifrada ----
app.post('/admin-kyc-imagem', async (req, res) => {
  try {
    if (!(await adminAutorizado(req))) {
      contar('admin-falha:' + ipDe(req), 10, 30 * 60 * 1000);
      return res.json({ status: 'error', message: 'Chave inválida.' });
    }
    const campos = { selfie: 'Selfie', frente: 'BI Frente', verso: 'BI Verso' };
    const campo = campos[req.body.tipo];
    if (!campo || !req.body.id) {
      return res.json({ status: 'error', message: 'Pedido inválido.' });
    }
    const kyc = await bubbleGet('kyc', req.body.id);
    if (!kyc || !kyc[campo]) {
      return res.json({ status: 'error', message: 'Imagem não encontrada.' });
    }
    const imagem = decifrarKyc(await descarregarDoBunny(kyc[campo]));
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'success', response: { data: 'data:image/jpeg;base64,' + imagem.toString('base64') } });
  } catch (erro) {
    console.error('Erro em /admin-kyc-imagem:', erro);
    return res.json({ status: 'error', message: 'Não foi possível abrir a imagem.' });
  }
});

// ---- Admin: aprovar ou rejeitar ----
app.post('/admin-kyc-decidir', async (req, res) => {
  try {
    if (!(await adminAutorizado(req))) {
      contar('admin-falha:' + ipDe(req), 10, 30 * 60 * 1000);
      return res.json({ status: 'error', message: 'Chave inválida.' });
    }
    const { id, decisao } = req.body;
    const motivo = String(req.body.motivo || '').trim().slice(0, 500);
    if (!id || !['Aprovado', 'Rejeitado'].includes(decisao)) {
      return res.json({ status: 'error', message: 'Pedido inválido.' });
    }
    if (decisao === 'Rejeitado' && motivo.length < 5) {
      return res.json({ status: 'error', message: 'Escreve o motivo da rejeição - o cliente vai recebê-lo por email.' });
    }
    const kyc = await bubbleGet('kyc', id);
    if (!kyc) return res.json({ status: 'error', message: 'Pedido não encontrado.' });

    const quemDecide = await validarSessao(req.body.owner, req.body.token).catch(() => null);
    if (quemDecide) registar(quemDecide, 'KYC ' + decisao.toLowerCase(), (kyc['Nome Completo'] || id) + (motivo ? ' - ' + motivo : ''));
    await bubblePatch('kyc', id, {
      'Estado': decisao,
      'Motivo': decisao === 'Rejeitado' ? motivo : '',
      'Revisto Em': new Date().toISOString()
    });

    const dono = await bubbleGet('user', kyc['Owner']).catch(() => null);
    const emailCliente = emailDoUsuario(dono);
    const primeiroNome = escaparHtml(String(kyc['Nome Completo'] || '').split(' ')[0]);
    if (emailCliente) {
      const html = decisao === 'Aprovado'
        ? templateEmailKyc('Identidade verificada', `Parabéns, ${primeiroNome}!`,
            ['A tua identidade foi verificada. Já podes activar os pagamentos do Daniel IA (M-Pesa, e-Mola e cartão) nas tuas lojas.'],
            { texto: 'Ir para o dashboard', url: APP_URL })
        : templateEmailKyc('Verificação não aprovada', `Olá, ${primeiroNome}.`,
            ['Não conseguimos aprovar a tua verificação de identidade.',
             `<strong>Motivo:</strong> ${escaparHtml(motivo)}`,
             'Podes tentar outra vez quando quiseres.'],
            { texto: 'Tentar outra vez', url: KYC_APP_URL });
      enviarEmail(emailCliente,
        decisao === 'Aprovado' ? 'A tua identidade foi verificada - Daniel IA' : 'A tua verificação precisa de atenção - Daniel IA',
        html).catch(e => console.error('Email KYC (decisão) falhou:', e.message));
    }
    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /admin-kyc-decidir:', erro);
    return res.json({ status: 'error', message: 'Não foi possível guardar a decisão.' });
  }
});

// ---- Admin: a página ----
// Não leva dados nenhuns dentro: pede a chave, guarda-a só nesta aba
// (sessionStorage) e vai buscar tudo por POST. A chave nunca vai no URL,
// por isso não fica no histórico do browser nem nos logs.
app.get('/admin-kyc', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  return res.send(PAGINA_ADMIN_KYC);
});

// ======================================================
// Loja v2 (14/10/2026) - capa, categorias, destaques, promoções e os três
// modos de receber: pagamentos Daniel IA, pagamento manual, ou WhatsApp
// ======================================================
// Campos novos no Bubble antes disto funcionar:
//   Produto:   Categoria (text), Preco Antigo MZN (number), Destaque (yes/no)
//   Site:      Loja Capa Json (text), Loja Config Json (text)
//   Encomenda: Notas (text)
//
// Loja Config Json guarda { modo, whatsapp, mpesa, emola, titular, email }.
// modo: "daniel"  - M-Pesa, e-Mola e cartão pela conta MozPayment do Daniel
//                   IA. SÓ funciona se o dono tiver o KYC aprovado.
//       "manual"  - o cliente paga directamente para os números do dono e
//                   o dono confirma (a loja só mostra os números).
//       "whatsapp"- sem pagamento no site: a encomenda abre no WhatsApp do
//                   dono, já escrita, e chega também por email.
// Se o modo escolhido não puder funcionar (ex: "daniel" sem KYC aprovado,
// ou WhatsApp sem número), a loja passa sozinha para "pedido": a encomenda
// é registada e chega ao dono por email, e o dono contacta o cliente.
// Em TODOS os modos, cada encomenda chega por email ao dono.

function lerJsonSeguro(texto, padrao) {
  try {
    const v = JSON.parse(texto || '');
    return v == null ? padrao : v;
  } catch (e) {
    return padrao;
  }
}

function soDigitos(texto) {
  return String(texto || '').replace(/[^0-9]/g, '');
}

// Número para o wa.me: só dígitos, com o indicativo de Moçambique se a
// pessoa escreveu o número local (9 dígitos a começar por 8).
function numeroWhatsApp(texto) {
  let n = soDigitos(texto);
  if (n.length === 9 && n[0] === '8') n = '258' + n;
  return n.length >= 9 && n.length <= 15 ? n : '';
}

function configLoja(site) {
  const c = lerJsonSeguro(site && site['Loja Config Json'], {}) || {};
  return {
    modo: ['daniel', 'manual', 'whatsapp'].includes(c.modo) ? c.modo : 'daniel',
    whatsapp: numeroWhatsApp(c.whatsapp),
    mpesa: soDigitos(c.mpesa).slice(0, 12),
    emola: soDigitos(c.emola).slice(0, 12),
    titular: String(c.titular || '').trim().slice(0, 80),
    email: /\S+@\S+\.\S+/.test(String(c.email || '')) ? String(c.email).trim().slice(0, 150) : ''
  };
}

function capaLoja(site) {
  const lista = lerJsonSeguro(site && site['Loja Capa Json'], []);
  return (Array.isArray(lista) ? lista : []).filter(s => s && s.imagem).slice(0, 3).map(s => ({
    imagem: String(s.imagem),
    titulo: String(s.titulo || '').slice(0, 80),
    subtitulo: String(s.subtitulo || '').slice(0, 140),
    botao: String(s.botao || '').slice(0, 30)
  }));
}

// O KYC é consultado em cada visita à loja - guardamos o resultado 60s em
// memória para não fazer um pedido ao Bubble por cada cliente.
const cacheKycLoja = new Map();
async function kycAprovadoCache(owner) {
  const agora = Date.now();
  const c = cacheKycLoja.get(owner);
  if (c && agora - c.t < 60000) return c.v;
  const v = await kycAprovado(owner);
  cacheKycLoja.set(owner, { v, t: agora });
  return v;
}

async function modoEfectivoLoja(site) {
  const cfg = configLoja(site);
  let modo = cfg.modo;
  const alternativa = cfg.whatsapp ? 'whatsapp' : 'pedido';
  if (modo === 'daniel' && !(await kycAprovadoCache(site['Owner']))) modo = alternativa;
  if (modo === 'manual' && !cfg.mpesa && !cfg.emola) modo = alternativa;
  if (modo === 'whatsapp' && !cfg.whatsapp) modo = 'pedido';
  return { modo, cfg };
}

async function emailDonoLoja(site, cfg) {
  if (cfg && cfg.email) return cfg.email;
  const dono = await bubbleGet('user', site['Owner']).catch(() => null);
  return emailDoUsuario(dono);
}

function referenciaEncomenda(id) {
  return 'ENC-' + String(id || '').replace(/[^0-9a-z]/gi, '').slice(-6).toUpperCase();
}

// ======================================================
// Loja v3 (15/10/2026): várias fotos, opções (variantes), stock,
// avaliações e montra por blocos.
// ======================================================
// Campo novo no Produto: "Extra Json" (text) =
//   { imagens: [links extra], variantes: [{nome, preco, stock}], stock, vendidos }
// Campo novo no Site: "Loja Blocos Json" (text) = { blocos: [...], estilo: {...} }
// Tipo novo: "Avaliacao" (Site, Produto, Nome, Estrelas, Comentario, Aprovada)
function numeroOuNulo(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return null;
  return Math.max(0, Math.floor(Number(v)));
}
function extraProduto(p) {
  const e = lerJsonSeguro(p && p['Extra Json'], {}) || {};
  return {
    imagens: (Array.isArray(e.imagens) ? e.imagens : [])
      .filter(u => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u)).slice(0, 8),
    variantes: (Array.isArray(e.variantes) ? e.variantes : [])
      .filter(v => v && String(v.nome || '').trim())
      .slice(0, 30)
      .map(v => ({
        nome: String(v.nome).trim().slice(0, 60),
        preco: Number(v.preco) > 0 ? Math.round(Number(v.preco) * 100) / 100 : 0,
        stock: numeroOuNulo(v.stock)
      })),
    stock: numeroOuNulo(e.stock),
    vendidos: Math.max(0, Math.floor(Number(e.vendidos) || 0))
  };
}

// Stock total: com opções, soma o stock de cada uma (se alguma não tiver
// limite, o produto também não tem). Sem opções, o stock do produto.
function stockTotal(extra) {
  if (!extra.variantes.length) return extra.stock;
  let total = 0;
  for (const v of extra.variantes) {
    if (v.stock === null) return null;
    total += v.stock;
  }
  return total;
}

// Desconta o stock e soma as vendas depois de uma encomenda (ou de um
// pagamento confirmado). Nunca deixa o stock abaixo de zero.
async function baixarStock(itens) {
  const porProduto = {};
  for (const i of itens || []) {
    if (!i || !i.produto_id) continue;
    (porProduto[i.produto_id] = porProduto[i.produto_id] || []).push(i);
  }
  for (const id of Object.keys(porProduto)) {
    try {
      const p = await bubbleGet('produto', id);
      if (!p) continue;
      const extra = extraProduto(p);
      for (const i of porProduto[id]) {
        const q = Math.max(0, parseInt(i.quantidade, 10) || 0);
        const vi = (i.variante === null || i.variante === undefined || i.variante === '') ? null : parseInt(i.variante, 10);
        if (vi !== null && extra.variantes[vi]) {
          if (extra.variantes[vi].stock !== null) extra.variantes[vi].stock = Math.max(0, extra.variantes[vi].stock - q);
        } else if (extra.stock !== null) {
          extra.stock = Math.max(0, extra.stock - q);
        }
        extra.vendidos += q;
      }
      await bubblePatch('produto', id, { 'Extra Json': JSON.stringify(extra) });
    } catch (e) {
      console.error('Stock não actualizado para o produto', id, e.message);
    }
  }
}

// ---- Montra por blocos ----
const TIPOS_BLOCO = ['anuncio', 'capa', 'categorias', 'fila', 'banners', 'oferta', 'catalogo', 'vistos', 'banda', 'colecao', 'filtros'];
const FONTES_FILA = ['novidades', 'promocoes', 'mais_vendidos', 'destaques', 'categoria'];
function textoLimpo(v, max) { return String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, max); }
function linkImagem(v) { const t = String(v || ''); return /^https:\/\/[^\s"'<>]+$/.test(t) ? t.slice(0, 600) : ''; }
function limparDestino(d) {
  d = d || {};
  const tipo = ['categoria', 'produto', 'url'].includes(d.tipo) ? d.tipo : 'nada';
  let valor = textoLimpo(d.valor, 300);
  if (tipo === 'url' && !/^https?:\/\/[^\s"'<>]+$/.test(valor)) valor = '';
  if (tipo === 'produto' && !/^[A-Za-z0-9_-]{1,64}$/.test(valor)) valor = '';
  return { tipo: valor ? tipo : 'nada', valor };
}
function limparBloco(b) {
  if (!b || !TIPOS_BLOCO.includes(b.tipo)) return null;
  const base = {
    id: String(b.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 16) || Math.random().toString(36).slice(2, 10),
    tipo: b.tipo,
    activo: b.activo !== false
  };
  switch (b.tipo) {
    case 'anuncio':
      return Object.assign(base, { texto: textoLimpo(b.texto, 140), cor: ['primaria', 'escuro', 'destaque'].includes(b.cor) ? b.cor : 'primaria' });
    case 'capa':
      return base;
    case 'categorias': {
      const imagens = {};
      if (b.imagens && typeof b.imagens === 'object') {
        Object.keys(b.imagens).slice(0, 40).forEach(k => { const u = linkImagem(b.imagens[k]); if (u) imagens[textoLimpo(k, 40)] = u; });
      }
      return Object.assign(base, { titulo: textoLimpo(b.titulo, 60), formato: b.formato === 'cartoes' ? 'cartoes' : 'circulos', imagens });
    }
    case 'fila':
      return Object.assign(base, { titulo: textoLimpo(b.titulo, 60), fonte: FONTES_FILA.includes(b.fonte) ? b.fonte : 'destaques', categoria: textoLimpo(b.categoria, 40) });
    case 'banners': {
      const itens = (Array.isArray(b.itens) ? b.itens : []).slice(0, 3).map(i => ({
        imagem: linkImagem(i && i.imagem),
        titulo: textoLimpo(i && i.titulo, 60),
        sub: textoLimpo(i && i.sub, 100),
        destino: limparDestino(i && i.destino)
      })).filter(i => i.imagem);
      return Object.assign(base, { itens });
    }
    case 'oferta': {
      const t = new Date(b.termina);
      return Object.assign(base, {
        titulo: textoLimpo(b.titulo, 60),
        termina: isNaN(t.getTime()) ? '' : t.toISOString(),
        fonte: b.fonte === 'escolher' ? 'escolher' : 'promocoes',
        produtos: (Array.isArray(b.produtos) ? b.produtos : []).filter(x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x)).slice(0, 24)
      });
    }
    default:
      return Object.assign(base, { titulo: textoLimpo(b.titulo, 60) });
  }
}
const MONTRA_PADRAO = [
  { id: 'capa', tipo: 'capa', activo: true },
  { id: 'cats', tipo: 'categorias', activo: true, titulo: '', formato: 'circulos', imagens: {} },
  { id: 'dest', tipo: 'fila', activo: true, titulo: '', fonte: 'destaques', categoria: '' },
  { id: 'promo', tipo: 'fila', activo: true, titulo: '', fonte: 'promocoes', categoria: '' },
  { id: 'cat', tipo: 'catalogo', activo: true, titulo: '' },
  { id: 'vistos', tipo: 'vistos', activo: true, titulo: '' }
];
function limparEstilo(e) {
  e = e || {};
  const colunas = Math.min(6, Math.max(3, parseInt(e.colunas, 10) || 4));
  const tema = ['mercado', 'editorial', 'tech', 'moda', 'catalogo', 'vitrine', 'bento', 'fresco', 'sabor', 'classico'].includes(e.tema) ? e.tema : '';
  return { cartao: ['suave', 'moldura', 'minimal'].includes(e.cartao) ? e.cartao : 'suave', colunas, tema };
}
// Categorias configuradas pelo dono (1.59.0): ordem, imagem e se aparecem.
// Ficam no mesmo campo da montra ("Loja Blocos Json"), em "categorias".
function limparCategoriasCfg(lista) {
  const vistas = {};
  return (Array.isArray(lista) ? lista : []).slice(0, 60).map(c => ({
    nome: textoLimpo(c && c.nome, 40),
    imagem: linkImagem(c && c.imagem),
    oculta: !!(c && c.oculta)
  })).filter(c => {
    const k = c.nome.toLowerCase();
    if (!c.nome || vistas[k]) return false;
    vistas[k] = true;
    return true;
  });
}
function montraLoja(site) {
  const m = lerJsonSeguro(site && site['Loja Blocos Json'], null);
  const categorias = limparCategoriasCfg(m && m.categorias);
  const blocos = m && Array.isArray(m.blocos) ? m.blocos.slice(0, 30).map(limparBloco).filter(Boolean) : [];
  if (!blocos.length) return { blocos: MONTRA_PADRAO.map(b => Object.assign({}, b)), estilo: limparEstilo(m && m.estilo), padrao: true, categorias };
  return { blocos, estilo: limparEstilo(m.estilo), padrao: false, categorias };
}

// Média e total das avaliações aprovadas, por produto.
async function resumoAvaliacoes(siteId) {
  const lista = await bubbleList('avaliacao', [
    { key: 'Site', constraint_type: 'equals', value: siteId },
    { key: 'Aprovada', constraint_type: 'equals', value: true }
  ]).catch(() => []);
  const r = {};
  for (const a of lista) {
    const id = a['Produto'];
    const e = Math.min(5, Math.max(1, Number(a['Estrelas']) || 0));
    if (!id || !e) continue;
    r[id] = r[id] || { soma: 0, total: 0 };
    r[id].soma += e;
    r[id].total++;
  }
  const saida = {};
  Object.keys(r).forEach(id => { saida[id] = { media: Math.round(r[id].soma / r[id].total * 10) / 10, total: r[id].total }; });
  return saida;
}

function produtoParaLista(p) {
  const preco = Number(p['Preco MZN']) || 0;
  const antigo = Number(p['Preco Antigo MZN']) || 0;
  return {
    id: p._id,
    nome: p['Nome'],
    preco: preco,
    preco_antigo: antigo > preco ? antigo : 0,
    categoria: String(p['Categoria'] || '').trim(),
    destaque: !!p['Destaque'],
    descricao: p['Descricao'] || '',
    imagem: p['Imagem URL'] || '',
    ...(function () {
      const extra = extraProduto(p);
      const imagens = [p['Imagem URL'] || ''].concat(extra.imagens).filter((u, i, a) => u && a.indexOf(u) === i);
      const stock = stockTotal(extra);
      return {
        imagens,
        variantes: extra.variantes.map(v => ({ nome: v.nome, preco: v.preco > 0 ? v.preco : preco, stock: v.stock })),
        stock,
        esgotado: stock === 0,
        vendidos: extra.vendidos,
        criado: p['Created Date'] || ''
      };
    })()
  };
}

// Email ao dono com a encomenda (todos os modos).
function templateEmailEncomendaDono(nomeLoja, encomenda, itens, modo, cfg) {
  const ref = referenciaEncomenda(encomenda._id);
  const total = Number(encomenda['Valor Total'] || 0).toLocaleString('pt-PT') + ' MZN';
  const estados = {
    daniel: 'Paga pelo Daniel IA (' + formatarMetodoPagamento(encomenda['Metodo']) + ')',
    manual: 'À espera do pagamento manual - confirma no teu M-Pesa/e-Mola antes de enviar',
    whatsapp: 'Recebida pelo WhatsApp - combina o pagamento com o cliente',
    pedido: 'Recebida - contacta o cliente para combinar o pagamento'
  };
  const linhas = itens.map(i => `<tr>
<td style="padding:9px 0;border-bottom:1px solid #EAE2F2;color:#1A0A27;font-size:13.5px;">${escaparHtml(i.nome)} <span style="color:#9A8CAB;">x${Number(i.quantidade || 1)}</span></td>
<td style="padding:9px 0;border-bottom:1px solid #EAE2F2;color:#1A0A27;font-size:13.5px;font-weight:700;text-align:right;">${escaparHtml((Number(i.preco_unitario) * Number(i.quantidade || 1)).toLocaleString('pt-PT'))} MZN</td>
</tr>`).join('');
  const linhaDado = (rotulo, valor) => valor ? `<p style="margin:0 0 6px 0;color:#1A0A27;font-size:13.5px;"><span style="color:#9A8CAB;">${rotulo}:</span> ${escaparHtml(valor)}</p>` : '';
  const telLimpo = numeroWhatsApp(encomenda['Cliente Telefone']);
  return templateEmailKyc(
    'Nova encomenda ' + ref,
    `Nova encomenda em ${escaparHtml(nomeLoja)}`,
    [
      `<strong>${escaparHtml(ref)}</strong> · ${escaparHtml(total)}<br><span style="color:#430960;font-weight:700;">${escaparHtml(estados[modo] || estados.pedido)}</span>`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${linhas}
<tr><td style="padding:12px 0 0 0;color:#1A0A27;font-size:15px;font-weight:800;">Total</td><td style="padding:12px 0 0 0;color:#1A0A27;font-size:15px;font-weight:800;text-align:right;">${escaparHtml(total)}</td></tr></table>`,
      '<span style="display:block;margin-top:6px;"></span>'
        + linhaDado('Cliente', encomenda['Cliente Nome'])
        + linhaDado('Telefone', encomenda['Cliente Telefone'])
        + linhaDado('Email', encomenda['Cliente Email'])
        + linhaDado('Morada / notas', encomenda['Notas'])
    ],
    telLimpo ? { texto: 'Falar com o cliente no WhatsApp', url: 'https://wa.me/' + telLimpo } : null
  );
}

// Email ao cliente a confirmar que a encomenda foi recebida (modos sem
// pagamento online - no modo "daniel" o recibo continua a ir no webhook).
const TEXTOS_WHATSAPP_ENCOMENDA = {
  pt: { ola: 'Olá! Quero fazer esta encomenda', total: 'Total', nome: 'Nome', telefone: 'Telefone', notas: 'Morada/notas' },
  en: { ola: "Hello! I'd like to place this order", total: 'Total', nome: 'Name', telefone: 'Phone', notas: 'Address/notes' },
  fr: { ola: 'Bonjour ! Je souhaite passer cette commande', total: 'Total', nome: 'Nom', telefone: 'Téléphone', notas: 'Adresse/remarques' },
  es: { ola: '¡Hola! Quiero hacer este pedido', total: 'Total', nome: 'Nombre', telefone: 'Teléfono', notas: 'Dirección/notas' }
};

// Email ao cliente, no idioma do site onde comprou.
const TEXTOS_EMAIL_CLIENTE = {
  pt: {
    assunto: (loja) => `Recebemos a tua encomenda - ${loja}`,
    titulo: (ref) => 'Encomenda ' + ref,
    ola: (n) => `Olá, ${n}.`,
    recebemos: (ref, loja, total) => `Recebemos a tua encomenda <strong>${ref}</strong> em ${loja}, no valor de <strong>${total}</strong>.`,
    pagar: (formas, titular, ref) => 'Para concluir, envia o pagamento para ' + formas.join(' ou ') + (titular ? ' (em nome de ' + titular + ')' : '') + ', com a referência <strong>' + ref + '</strong>.',
    confirma: 'A loja confirma o pagamento e prepara a tua encomenda.',
    contacta: 'A loja vai contactar-te em breve para combinar o pagamento e a entrega.',
    botao: 'Falar com a loja no WhatsApp',
    whats: (ref) => 'Olá! Sobre a encomenda ' + ref
  },
  en: {
    assunto: (loja) => `We received your order - ${loja}`,
    titulo: (ref) => 'Order ' + ref,
    ola: (n) => `Hello, ${n}.`,
    recebemos: (ref, loja, total) => `We received your order <strong>${ref}</strong> at ${loja}, for a total of <strong>${total}</strong>.`,
    pagar: (formas, titular, ref) => 'To complete it, send the payment to ' + formas.join(' or ') + (titular ? ' (account holder: ' + titular + ')' : '') + ', using the reference <strong>' + ref + '</strong>.',
    confirma: 'The store will confirm the payment and prepare your order.',
    contacta: 'The store will contact you soon to arrange payment and delivery.',
    botao: 'Chat with the store on WhatsApp',
    whats: (ref) => 'Hello! About order ' + ref
  },
  fr: {
    assunto: (loja) => `Nous avons reçu votre commande - ${loja}`,
    titulo: (ref) => 'Commande ' + ref,
    ola: (n) => `Bonjour ${n},`,
    recebemos: (ref, loja, total) => `Nous avons bien reçu votre commande <strong>${ref}</strong> chez ${loja}, d'un montant de <strong>${total}</strong>.`,
    pagar: (formas, titular, ref) => 'Pour finaliser, envoyez le paiement à ' + formas.join(' ou ') + (titular ? ' (au nom de ' + titular + ')' : '') + ', avec la référence <strong>' + ref + '</strong>.',
    confirma: 'La boutique confirmera le paiement et préparera votre commande.',
    contacta: 'La boutique vous contactera bientôt pour convenir du paiement et de la livraison.',
    botao: 'Contacter la boutique sur WhatsApp',
    whats: (ref) => 'Bonjour ! À propos de la commande ' + ref
  },
  es: {
    assunto: (loja) => `Hemos recibido tu pedido - ${loja}`,
    titulo: (ref) => 'Pedido ' + ref,
    ola: (n) => `Hola, ${n}.`,
    recebemos: (ref, loja, total) => `Hemos recibido tu pedido <strong>${ref}</strong> en ${loja}, por un total de <strong>${total}</strong>.`,
    pagar: (formas, titular, ref) => 'Para terminar, envía el pago a ' + formas.join(' o ') + (titular ? ' (a nombre de ' + titular + ')' : '') + ', con la referencia <strong>' + ref + '</strong>.',
    confirma: 'La tienda confirmará el pago y preparará tu pedido.',
    contacta: 'La tienda te contactará pronto para acordar el pago y la entrega.',
    botao: 'Hablar con la tienda por WhatsApp',
    whats: (ref) => '¡Hola! Sobre el pedido ' + ref
  }
};

function templateEmailEncomendaCliente(nomeLoja, encomenda, modo, cfg, idioma) {
  const T = TEXTOS_EMAIL_CLIENTE[normalizarIdioma(idioma)];
  const ref = referenciaEncomenda(encomenda._id);
  const total = Number(encomenda['Valor Total'] || 0).toLocaleString('pt-PT') + ' MZN';
  const primeiro = escaparHtml(String(encomenda['Cliente Nome'] || '').split(' ')[0]);
  const paragrafos = [T.recebemos(escaparHtml(ref), escaparHtml(nomeLoja), escaparHtml(total))];
  if (modo === 'manual') {
    const formas = [];
    if (cfg.mpesa) formas.push('M-Pesa: <strong>' + escaparHtml(cfg.mpesa) + '</strong>');
    if (cfg.emola) formas.push('e-Mola: <strong>' + escaparHtml(cfg.emola) + '</strong>');
    paragrafos.push(T.pagar(formas, cfg.titular ? escaparHtml(cfg.titular) : '', escaparHtml(ref)));
    paragrafos.push(T.confirma);
  } else {
    paragrafos.push(T.contacta);
  }
  return templateEmailKyc(T.titulo(ref), T.ola(primeiro), paragrafos,
    cfg.whatsapp ? { texto: T.botao, url: 'https://wa.me/' + cfg.whatsapp + '?text=' + encodeURIComponent(T.whats(ref)) } : null);
}

async function avisarEncomenda(site, encomendaId, modo, cfg, idioma) {
  try {
    const encomenda = await bubbleGet('encomenda', encomendaId);
    if (!encomenda) return;
    const itens = lerJsonSeguro(encomenda['Produtos Json'], []);
    const nomeLoja = site['Nome'] || 'a tua loja';
    const emailDono = await emailDonoLoja(site, cfg);
    if (emailDono) {
      await enviarEmail(emailDono, `Nova encomenda ${referenciaEncomenda(encomendaId)} - ${nomeLoja}`,
        templateEmailEncomendaDono(nomeLoja, encomenda, itens, modo, cfg));
    }
    if (modo !== 'daniel' && encomenda['Cliente Email']) {
      await enviarEmail(encomenda['Cliente Email'], TEXTOS_EMAIL_CLIENTE[normalizarIdioma(idioma)].assunto(nomeLoja),
        templateEmailEncomendaCliente(nomeLoja, encomenda, modo, cfg, idioma));
    }
  } catch (erro) {
    console.error('Aviso de encomenda por email falhou:', erro.message);
  }
}

// ---- Dono: ler as definições da loja ----
app.post('/loja-config-ler', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const site = site_id ? await bubbleGet('site', site_id) : null;
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para ver esta loja.' });
    }
    const cfg = configLoja(site);
    const kyc = await kycDoOwner(owner).catch(() => null);
    const { modo } = await modoEfectivoLoja(site);
    return res.json({
      status: 'success',
      response: {
        nome: site['Nome'] || '',
        cdn_url: site['CDN URL'] || '',
        config: cfg,
        capa: capaLoja(site),
        montra: montraLoja(site),
        tema_site: await temaDoSite(site),
        modo_efectivo: modo,
        kyc_estado: kyc ? (kyc['Estado'] || 'Pendente') : 'Nenhum'
      }
    });
  } catch (erro) {
    console.error('Erro em /loja-config-ler:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar as definições da loja.' });
  }
});

// Tema de loja escrito no HTML publicado (cada versão do estúdio tem o seu).
async function temaDoSite(site) {
  try {
    if (!site || !site['Bunny Path']) return '';
    const html = (await descarregarDoBunny(site['Bunny Path'])).toString('utf8');
    const m = /<meta name="daniel-ia-tema-loja" content="([a-z]+)"/i.exec(html);
    return m && TEMAS_LOJA.some(t => t.id === m[1]) ? m[1] : '';
  } catch (e) {
    return '';
  }
}

// ---- Dono: guardar as definições da loja (capa + pagamentos) ----
// Cada slide da capa pode trazer "imagem" (link já guardado) ou
// "imagem_data_url" (imagem nova, que sobe aqui para o Bunny).
app.post('/loja-config-guardar', async (req, res) => {
  try {
    const { owner, site_id, config, capa } = req.body;
    const site = site_id ? await bubbleGet('site', site_id) : null;
    if (!site || site['Owner'] !== owner) {
      return res.json({ status: 'error', message: 'Não tens permissão para alterar esta loja.' });
    }
    const dados = {};

    if (config) {
      const c = {
        modo: ['daniel', 'manual', 'whatsapp'].includes(config.modo) ? config.modo : 'daniel',
        whatsapp: String(config.whatsapp || '').trim(),
        mpesa: String(config.mpesa || '').trim(),
        emola: String(config.emola || '').trim(),
        titular: String(config.titular || '').trim(),
        email: String(config.email || '').trim()
      };
      if (c.modo === 'daniel' && !(await kycAprovado(owner))) {
        return res.json({ status: 'error', codigo: 'kyc', message: 'Para usares os pagamentos do Daniel IA tens de verificar a tua identidade primeiro.' });
      }
      if (c.modo === 'whatsapp' && !numeroWhatsApp(c.whatsapp)) {
        return res.json({ status: 'error', message: 'Escreve o número de WhatsApp da loja.' });
      }
      if (c.modo === 'manual' && !soDigitos(c.mpesa) && !soDigitos(c.emola)) {
        return res.json({ status: 'error', message: 'Escreve pelo menos um número (M-Pesa ou e-Mola) para os clientes pagarem.' });
      }
      if (c.email && !/\S+@\S+\.\S+/.test(c.email)) {
        return res.json({ status: 'error', message: 'O email para receber encomendas não parece válido.' });
      }
      dados['Loja Config Json'] = JSON.stringify(c);
      cacheKycLoja.delete(owner);
    }

    if (Array.isArray(capa)) {
      const slides = [];
      for (const s of capa.slice(0, 3)) {
        if (!s) continue;
        let imagem = String(s.imagem || '');
        if (s.imagem_data_url) {
          const up = await uploadImagemBase64('loja-capa', owner, s.imagem_data_url);
          if (up.erro) return res.json({ status: 'error', message: up.erro });
          imagem = up.url;
        }
        if (!imagem) continue;
        slides.push({
          imagem,
          titulo: String(s.titulo || '').trim().slice(0, 80),
          subtitulo: String(s.subtitulo || '').trim().slice(0, 140),
          botao: String(s.botao || '').trim().slice(0, 30)
        });
      }
      dados['Loja Capa Json'] = JSON.stringify(slides);
    }

    if (Object.keys(dados).length) await bubblePatch('site', site_id, dados);
    const actualizado = await bubbleGet('site', site_id);
    const { modo } = await modoEfectivoLoja(actualizado);
    return res.json({ status: 'success', response: { capa: capaLoja(actualizado), config: configLoja(actualizado), modo_efectivo: modo } });
  } catch (erro) {
    console.error('Erro em /loja-config-guardar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível guardar as definições da loja.' });
  }
});

// ======================================================
// Loja v3 - montra por blocos e avaliações
// ======================================================
async function siteDoDono(owner, siteId) {
  const site = siteId ? await bubbleGet('site', siteId).catch(() => null) : null;
  return site && site['Owner'] === owner ? site : null;
}

// Guardar a montra. Imagens novas (banners e categorias) chegam em base64
// e sobem aqui para o Bunny.
app.post('/loja-montra-guardar', async (req, res) => {
  try {
    const { owner, site_id, montra } = req.body;
    const site = await siteDoDono(owner, site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para alterar esta loja.' });
    if (!montra || !Array.isArray(montra.blocos)) return res.json({ status: 'error', message: 'Pedido inválido.' });

    let envios = 0;
    async function subir(valor) {
      if (typeof valor !== 'string' || valor.indexOf('data:image/') !== 0) return valor;
      if (++envios > 12) throw Object.assign(new Error('demasiadas'), { utilizador: 'Demasiadas imagens de uma vez. Guarda e depois continua.' });
      const up = await uploadImagemBase64('loja-montra', owner, valor);
      if (up.erro) throw Object.assign(new Error(up.erro), { utilizador: up.erro });
      return up.url;
    }
    const blocos = [];
    for (const b of montra.blocos.slice(0, 30)) {
      if (!b || typeof b !== 'object') continue;
      const copia = Object.assign({}, b);
      if (copia.tipo === 'banners' && Array.isArray(copia.itens)) {
        copia.itens = [];
        for (const i of b.itens.slice(0, 3)) {
          if (!i) continue;
          copia.itens.push(Object.assign({}, i, { imagem: await subir(i.imagem_data_url || i.imagem) }));
        }
      }
      if (copia.tipo === 'categorias' && copia.imagens && typeof copia.imagens === 'object') {
        const imgs = {};
        for (const k of Object.keys(b.imagens).slice(0, 40)) imgs[k] = await subir(b.imagens[k]);
        copia.imagens = imgs;
      }
      const limpo = limparBloco(copia);
      if (limpo) blocos.push(limpo);
    }
    const blocosAntes = lerJsonSeguro(site['Loja Blocos Json'], {}) || {};
    const valor = { blocos, estilo: limparEstilo(montra.estilo), categorias: limparCategoriasCfg(blocosAntes.categorias) };
    if (blocosAntes.quiz) valor.quiz = blocosAntes.quiz;
    await bubblePatch('site', site_id, { 'Loja Blocos Json': JSON.stringify(valor) });
    return res.json({ status: 'success', response: { montra: montraLoja({ 'Loja Blocos Json': JSON.stringify(valor) }) } });
  } catch (erro) {
    if (erro && erro.utilizador) return res.json({ status: 'error', message: erro.utilizador });
    console.error('Erro em /loja-montra-guardar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível guardar a montra.' });
  }
});

// ======================================================
// Categorias da loja (1.59.0) - um sítio só para as configurar
// ------------------------------------------------------
// As categorias nascem dos produtos (campo "Categoria"). Aqui o dono
// ordena-as, põe uma imagem, esconde, cria novas (ainda sem produtos),
// muda o nome (muda em todos os produtos) ou apaga (os produtos ficam
// sem categoria). A configuração fica em "Loja Blocos Json".categorias.
// ======================================================
async function produtosDaLoja(siteId) {
  return bubbleListTodos('produto', [{ key: 'Site', constraint_type: 'equals', value: siteId }], 3000);
}
function categoriasDaLoja(produtosLoja, cfg) {
  const mapa = {};
  produtosLoja.forEach(p => {
    const nome = String(p['Categoria'] || '').trim();
    if (!nome) return;
    const k = nome.toLowerCase();
    if (!mapa[k]) mapa[k] = { nome, total: 0, imagem_auto: '', grafias: {} };
    mapa[k].total++;
    mapa[k].grafias[nome] = (mapa[k].grafias[nome] || 0) + 1;
    mapa[k].nome = Object.keys(mapa[k].grafias).sort((x, y) => mapa[k].grafias[y] - mapa[k].grafias[x])[0];
    if (!mapa[k].imagem_auto) mapa[k].imagem_auto = linkImagem(p['Imagem URL'] || p['Image URL'] || '') || (extraProduto(p).imagens[0] || '');
  });
  const lista = [];
  cfg.forEach(c => {
    const k = c.nome.toLowerCase();
    const m = mapa[k];
    lista.push({ nome: c.nome, total: m ? m.total : 0, imagem: c.imagem, imagem_auto: m ? m.imagem_auto : '', oculta: c.oculta });
    delete mapa[k];
  });
  Object.values(mapa).sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome))
    .forEach(m => lista.push({ nome: m.nome, total: m.total, imagem: '', imagem_auto: m.imagem_auto, oculta: false }));
  const semCategoria = produtosLoja.filter(p => !String(p['Categoria'] || '').trim()).length;
  return { lista, semCategoria };
}
async function guardarCategoriasCfg(site, cfg) {
  const m = lerJsonSeguro(site['Loja Blocos Json'], {}) || {};
  m.categorias = limparCategoriasCfg(cfg);
  if (!Array.isArray(m.blocos)) m.blocos = [];
  await bubblePatch('site', site._id, { 'Loja Blocos Json': JSON.stringify(m) });
  return m.categorias;
}

app.post('/loja-categorias', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const site = await siteDoDono(owner, site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para ver esta loja.' });
    const cfg = limparCategoriasCfg((lerJsonSeguro(site['Loja Blocos Json'], {}) || {}).categorias);
    const r = categoriasDaLoja(await produtosDaLoja(site_id), cfg);
    return res.json({ status: 'success', response: { categorias: r.lista, sem_categoria: r.semCategoria } });
  } catch (erro) {
    console.error('Erro em /loja-categorias:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar as categorias.' });
  }
});

// Guarda a ordem, as imagens e o que fica escondido (e as categorias novas).
app.post('/loja-categorias-guardar', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const site = await siteDoDono(owner, site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para alterar esta loja.' });
    const entrada = Array.isArray(req.body.categorias) ? req.body.categorias.slice(0, 60) : [];
    let envios = 0;
    const cfg = [];
    for (const c of entrada) {
      if (!c || !textoLimpo(c.nome, 40)) continue;
      let imagem = c.imagem || '';
      if (typeof c.imagem_data_url === 'string' && c.imagem_data_url.indexOf('data:image/') === 0) {
        if (++envios > 12) return res.json({ status: 'error', message: 'Demasiadas imagens de uma vez. Guarda e depois continua.' });
        const up = await uploadImagemBase64('loja-categorias', owner, c.imagem_data_url);
        if (up.erro) return res.json({ status: 'error', message: up.erro });
        imagem = up.url;
      }
      cfg.push({ nome: c.nome, imagem, oculta: !!c.oculta });
    }
    await guardarCategoriasCfg(site, cfg);
    const r = categoriasDaLoja(await produtosDaLoja(site_id), limparCategoriasCfg(cfg));
    return res.json({ status: 'success', response: { categorias: r.lista, sem_categoria: r.semCategoria } });
  } catch (erro) {
    console.error('Erro em /loja-categorias-guardar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível guardar as categorias.' });
  }
});

// Muda o nome de uma categoria em todos os produtos (se o nome novo já
// existir, as duas juntam-se numa só).
app.post('/loja-categoria-renomear', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const de = textoLimpo(req.body.de, 40), para = textoLimpo(req.body.para, 40);
    if (!de || !para) return res.json({ status: 'error', message: 'Escreve o nome novo da categoria.' });
    const site = await siteDoDono(owner, site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para alterar esta loja.' });
    const lista = await produtosDaLoja(site_id);
    const alvo = lista.filter(p => String(p['Categoria'] || '').trim().toLowerCase() === de.toLowerCase());
    for (const p of alvo) await bubblePatch('produto', p._id, { 'Categoria': para });
    const cfgAntes = limparCategoriasCfg((lerJsonSeguro(site['Loja Blocos Json'], {}) || {}).categorias);
    const jaExiste = cfgAntes.some(c => c.nome.toLowerCase() === para.toLowerCase() && c.nome.toLowerCase() !== de.toLowerCase());
    const cfg = jaExiste
      ? cfgAntes.filter(c => c.nome.toLowerCase() !== de.toLowerCase())
      : cfgAntes.map(c => c.nome.toLowerCase() === de.toLowerCase() ? Object.assign({}, c, { nome: para }) : c);
    await guardarCategoriasCfg(site, cfg);
    const r = categoriasDaLoja(await produtosDaLoja(site_id), limparCategoriasCfg(cfg));
    return res.json({ status: 'success', response: { mudados: alvo.length, categorias: r.lista, sem_categoria: r.semCategoria } });
  } catch (erro) {
    console.error('Erro em /loja-categoria-renomear:', erro);
    return res.json({ status: 'error', message: 'Não foi possível mudar o nome da categoria.' });
  }
});

// Apaga uma categoria: os produtos continuam à venda, só ficam sem categoria.
app.post('/loja-categoria-remover', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const nome = textoLimpo(req.body.nome, 40);
    const site = await siteDoDono(owner, site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para alterar esta loja.' });
    const lista = await produtosDaLoja(site_id);
    const alvo = lista.filter(p => String(p['Categoria'] || '').trim().toLowerCase() === nome.toLowerCase());
    for (const p of alvo) await bubblePatch('produto', p._id, { 'Categoria': '' });
    const cfg = limparCategoriasCfg((lerJsonSeguro(site['Loja Blocos Json'], {}) || {}).categorias).filter(c => c.nome.toLowerCase() !== nome.toLowerCase());
    await guardarCategoriasCfg(site, cfg);
    const r = categoriasDaLoja(await produtosDaLoja(site_id), cfg);
    return res.json({ status: 'success', response: { mudados: alvo.length, categorias: r.lista, sem_categoria: r.semCategoria } });
  } catch (erro) {
    console.error('Erro em /loja-categoria-remover:', erro);
    return res.json({ status: 'error', message: 'Não foi possível apagar a categoria.' });
  }
});

// Cliente deixa uma avaliação (fica à espera de aprovação do dono).
app.post('/loja-avaliar', async (req, res) => {
  try {
    const { site_id, produto_id } = req.body;
    const nome = textoLimpo(req.body.nome, 60);
    const comentario = textoLimpo(req.body.comentario, 600);
    const estrelas = parseInt(req.body.estrelas, 10);
    if (!site_id || !produto_id || nome.length < 2 || !(estrelas >= 1 && estrelas <= 5)) {
      return res.json({ status: 'error', codigo: 'dados', message: 'Escreve o teu nome e escolhe as estrelas.' });
    }
    const produto = await bubbleGet('produto', produto_id).catch(() => null);
    if (!produto || produto['Site'] !== site_id || !produto['Is Active']) {
      return res.json({ status: 'error', message: 'Produto não encontrado.' });
    }
    await bubbleCreate('avaliacao', {
      'Site': site_id, 'Produto': produto_id, 'Nome': nome, 'Estrelas': estrelas, 'Comentario': comentario, 'Aprovada': false
    });
    // Aviso ao dono (não bloqueia nada se falhar).
    (async () => {
      try {
        const site = await bubbleGet('site', site_id);
        const email = await emailDonoLoja(site, configLoja(site));
        if (!email) return;
        const estrelasTexto = '★★★★★'.slice(0, estrelas) + '☆☆☆☆☆'.slice(0, 5 - estrelas);
        await enviarEmail(email, 'Nova avaliação para aprovar - ' + (site['Nome'] || 'a tua loja'),
          templateEmailKyc('Nova avaliação', 'Olá.', [
            'Um cliente avaliou <strong>' + escaparHtml(produto['Nome']) + '</strong> na tua loja:',
            '<span style="font-size:20px;color:#F59E0B;letter-spacing:2px;">' + estrelasTexto + '</span>',
            '<strong>' + escaparHtml(nome) + '</strong>' + (comentario ? ': "' + escaparHtml(comentario) + '"' : ''),
            'A avaliação só aparece na loja depois de a aprovares.'
          ], { texto: 'Ver avaliações', url: 'https://app.daniel-ia.pro/produtos/?site=' + encodeURIComponent(site_id) + '#p-avaliacoes' }));
      } catch (e) { console.error('Aviso de avaliação falhou:', e.message); }
    })();
    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /loja-avaliar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível enviar a avaliação.' });
  }
});

// Avaliações aprovadas de um produto (público).
app.post('/loja-avaliacoes', async (req, res) => {
  try {
    const { site_id, produto_id } = req.body;
    if (!site_id || !produto_id) return res.json({ status: 'error', message: 'Pedido inválido.' });
    const lista = await bubbleList('avaliacao', [
      { key: 'Site', constraint_type: 'equals', value: site_id },
      { key: 'Produto', constraint_type: 'equals', value: produto_id },
      { key: 'Aprovada', constraint_type: 'equals', value: true }
    ], 'Created Date', true);
    return res.json({ status: 'success', response: { avaliacoes: lista.slice(0, 50).map(a => ({
      nome: a['Nome'] || '', estrelas: Number(a['Estrelas']) || 0, comentario: a['Comentario'] || '', data: a['Created Date'] || ''
    })) } });
  } catch (erro) {
    console.error('Erro em /loja-avaliacoes:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar as avaliações.' });
  }
});

// Dono: todas as avaliações da loja (por aprovar e aprovadas).
app.post('/loja-avaliacoes-gerir', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const site = await siteDoDono(owner, site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para ver esta loja.' });
    const [lista, produtos] = await Promise.all([
      bubbleList('avaliacao', [{ key: 'Site', constraint_type: 'equals', value: site_id }], 'Created Date', true),
      bubbleList('produto', [{ key: 'Site', constraint_type: 'equals', value: site_id }])
    ]);
    const nomes = {};
    produtos.forEach(p => { nomes[p._id] = p['Nome']; });
    return res.json({ status: 'success', response: { avaliacoes: lista.map(a => ({
      id: a._id, produto_id: a['Produto'], produto: nomes[a['Produto']] || '', nome: a['Nome'] || '',
      estrelas: Number(a['Estrelas']) || 0, comentario: a['Comentario'] || '', aprovada: !!a['Aprovada'], data: a['Created Date'] || ''
    })) } });
  } catch (erro) {
    console.error('Erro em /loja-avaliacoes-gerir:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar as avaliações.' });
  }
});

// Dono: aprovar ou apagar uma avaliação.
app.post('/loja-avaliacao-decidir', async (req, res) => {
  try {
    const { owner, site_id, avaliacao_id, accao } = req.body;
    const site = await siteDoDono(owner, site_id);
    if (!site || !avaliacao_id) return res.json({ status: 'error', message: 'Não tens permissão para alterar esta loja.' });
    const a = await bubbleGet('avaliacao', avaliacao_id).catch(() => null);
    if (!a || a['Site'] !== site_id) return res.json({ status: 'error', message: 'Avaliação não encontrada.' });
    if (accao === 'aprovar') await bubblePatch('avaliacao', avaliacao_id, { 'Aprovada': true });
    else if (accao === 'apagar') await bubbleDelete('avaliacao', avaliacao_id);
    else return res.json({ status: 'error', message: 'Pedido inválido.' });
    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /loja-avaliacao-decidir:', erro);
    return res.json({ status: 'error', message: 'Não foi possível guardar.' });
  }
});


// ======================================================
// Loja: arrumação automática (1.54.0)
// ------------------------------------------------------
// A loja tem de ficar arrumada mesmo quando o dono não a arruma:
//   - produto sem categoria -> a IA escolhe uma (em fundo, aos lotes)
//   - /loja-organizar       -> analisa a loja e propõe correcções
//                              (categorias, nomes, destaques a mais,
//                              nomes repetidos, produtos sem foto)
//   - /loja-organizar-aplicar -> aplica só o que o dono aprovou
// ======================================================
async function pedirJsonIA(sistema, pedido, maxTokens) {
  if (!OPENAI_API_KEY) throw new Error('Sem OPENAI_API_KEY');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL_RAPIDO || OPENAI_MODEL,
        reasoning_effort: 'low',
        max_completion_tokens: maxTokens || 6000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: pedido }]
      })
    });
    const json = await res.json();
    if (!res.ok) throw new Error('OpenAI falhou: ' + ((json.error && json.error.message) || res.status));
    const texto = String((json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '').trim();
    const m = texto.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : texto);
  } finally {
    clearTimeout(t);
  }
}

function nomeNormal(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

const SISTEMA_ARRUMAR = 'És um especialista em lojas online em Moçambique e arrumas catálogos de produtos. '
  + 'Respondes só com um objecto JSON válido, sem texto à volta.';

// Pede à IA categorias (para os ids indicados) e, se pedido, nomes corrigidos.
async function sugestoesIA(produtos, idsSemCategoria, comNomes) {
  const existentes = [...new Set(produtos.map(p => String(p['Categoria'] || '').trim()).filter(Boolean))];
  const lista = produtos.slice(0, 120).map(p => ({
    id: p._id,
    nome: String(p['Nome'] || '').slice(0, 120),
    categoria: String(p['Categoria'] || '').trim(),
    descricao: String(p['Descricao'] || '').replace(/\s+/g, ' ').slice(0, 140)
  }));
  const regras = [
    'Loja com estes produtos (JSON abaixo). Categorias que a loja já usa: ' + (existentes.length ? existentes.join(', ') : 'nenhuma') + '.',
    '1) "categorias": dá uma categoria a CADA produto destes ids: ' + JSON.stringify(idsSemCategoria) + '.',
    '   - Reaproveita as categorias existentes quando servirem.',
    '   - Nomes curtos (1 a 3 palavras), com a primeira letra maiúscula, na MESMA língua dos nomes dos produtos (ex: "Electrodomésticos", "Mobiliário", "Escritório").',
    '   - A loja inteira deve ficar com 3 a 8 categorias no total. Junta produtos parecidos; nunca uma categoria por produto.',
    '   - Usa o português de Moçambique/Portugal quando os nomes estiverem em português.'
  ];
  if (comNomes) {
    regras.push(
      '2) "nomes": só para produtos com problemas óbvios no nome: acentos em falta (Sofa -> Sofá), maiúsculas erradas (Tv Led -> TV LED, tudo em minúsculas ou tudo em MAIÚSCULAS), erros de escrita.',
      '   - Mantém marcas, modelos e o sentido. Não acrescentes palavras de marketing. Não traduzas.',
      '   - Se dois produtos têm o mesmo nome e a descrição diz o que os distingue (capacidade, tipo, tamanho), propõe nomes que os distingam usando SÓ essa informação.',
      '   - Não incluas os produtos cujo nome já está bem.'
    );
  }
  regras.push('Formato exacto: {"categorias":{"<id>":"Categoria"}' + (comNomes ? ',"nomes":{"<id>":"Nome corrigido"}' : '') + '}');
  regras.push('PRODUTOS: ' + JSON.stringify(lista));
  const r = await pedirJsonIA(SISTEMA_ARRUMAR, regras.join('\n'), comNomes ? 8000 : 4000);
  const ids = new Set(produtos.map(p => p._id));
  const categorias = {}, nomes = {};
  Object.entries((r && r.categorias) || {}).forEach(([id, c]) => {
    const v = textoLimpo(c, 40);
    if (ids.has(id) && v) categorias[id] = v;
  });
  Object.entries((r && r.nomes) || {}).forEach(([id, n]) => {
    const v = textoLimpo(n, 120);
    if (ids.has(id) && v.length >= 2) nomes[id] = v;
  });
  return { categorias, nomes };
}

// Categoria automática em fundo, aos lotes por loja (espera 4 s para juntar
// vários produtos criados de seguida num só pedido à IA).
const filaCategorias = new Map();
function categorizarEmFundo(siteId, produtoId) {
  if (!OPENAI_API_KEY || !siteId || !produtoId) return;
  let f = filaCategorias.get(siteId);
  if (!f) { f = { ids: new Set(), timer: null }; filaCategorias.set(siteId, f); }
  f.ids.add(produtoId);
  clearTimeout(f.timer);
  f.timer = setTimeout(async () => {
    filaCategorias.delete(siteId);
    try {
      const produtos = await bubbleList('produto', [{ key: 'Site', constraint_type: 'equals', value: siteId }]);
      const alvo = produtos.filter(p => f.ids.has(p._id) && !String(p['Categoria'] || '').trim()).map(p => p._id);
      if (!alvo.length) return;
      const { categorias } = await sugestoesIA(produtos, alvo, false);
      for (const id of alvo) {
        if (categorias[id]) await bubblePatch('produto', id, { 'Categoria': categorias[id] });
      }
    } catch (erro) {
      console.error('Categoria automática falhou:', erro.message || erro);
    }
  }, 4000);
}

function limiteDestaques(total) { return Math.max(4, Math.ceil(total / 4)); }

app.post('/loja-organizar', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const site = await siteDoDono(owner, site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para alterar esta loja.' });
    const todos = await bubbleList('produto', [{ key: 'Site', constraint_type: 'equals', value: site_id }], 'Created Date', true);
    const activos = todos.filter(p => p['Is Active']);
    const resposta = { total: activos.length, categorias: [], nomes: [], destaques_a_mais: [], limite_destaques: limiteDestaques(activos.length), repetidos: [], sem_foto: [], ia_falhou: false };
    if (!activos.length) return res.json({ status: 'success', response: resposta });

    // 1) IA: categorias em falta e nomes a corrigir
    const semCategoria = activos.filter(p => !String(p['Categoria'] || '').trim()).map(p => p._id);
    try {
      const ia = await sugestoesIA(activos, semCategoria, true);
      resposta.categorias = semCategoria.filter(id => ia.categorias[id]).map(id => {
        const p = activos.find(x => x._id === id);
        return { id, nome: p['Nome'] || '', sugestao: ia.categorias[id] };
      });
      resposta.nomes = Object.keys(ia.nomes).map(id => {
        const p = activos.find(x => x._id === id);
        return { id, atual: p['Nome'] || '', sugestao: ia.nomes[id] };
      }).filter(n => n.sugestao !== n.atual);
    } catch (erro) {
      console.error('Erro na IA de /loja-organizar:', erro.message || erro);
      resposta.ia_falhou = true;
    }

    // 2) Destaques a mais: fica o limite, pelos que mais vendem e mais recentes
    const destaques = activos.filter(p => p['Destaque']);
    if (destaques.length > resposta.limite_destaques) {
      const ordem = destaques.slice().sort((a, b) => {
        const va = extraProduto(a).vendidos || 0, vb = extraProduto(b).vendidos || 0;
        if (vb !== va) return vb - va;
        return String(b['Created Date'] || '').localeCompare(String(a['Created Date'] || ''));
      });
      resposta.destaques_a_mais = ordem.slice(resposta.limite_destaques).map(p => ({ id: p._id, nome: p['Nome'] || '' }));
      resposta.total_destaques = destaques.length;
    }

    // 3) Nomes repetidos (que a IA não resolveu) e produtos sem foto
    const grupos = {};
    activos.forEach(p => {
      const nomeFinal = (resposta.nomes.find(n => n.id === p._id) || {}).sugestao || p['Nome'];
      const k = nomeNormal(nomeFinal);
      (grupos[k] = grupos[k] || []).push({ id: p._id, nome: p['Nome'] || '', preco: Number(p['Preco MZN']) || 0 });
    });
    resposta.repetidos = Object.values(grupos).filter(g => g.length > 1);
    resposta.sem_foto = activos.filter(p => !p['Imagem URL']).map(p => ({ id: p._id, nome: p['Nome'] || '' }));
    return res.json({ status: 'success', response: resposta });
  } catch (erro) {
    console.error('Erro em /loja-organizar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível analisar a loja.' });
  }
});

app.post('/loja-organizar-aplicar', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const site = await siteDoDono(owner, site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para alterar esta loja.' });
    const alteracoes = Array.isArray(req.body.alteracoes) ? req.body.alteracoes.slice(0, 200) : [];
    if (!alteracoes.length) return res.json({ status: 'error', message: 'Pedido inválido.' });
    const produtos = await bubbleList('produto', [{ key: 'Site', constraint_type: 'equals', value: site_id }]);
    const daLoja = new Set(produtos.map(p => p._id));
    let aplicadas = 0;
    for (const a of alteracoes) {
      if (!a || typeof a.produto_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.produto_id) || !daLoja.has(a.produto_id)) continue;
      const dados = {};
      if (typeof a.categoria === 'string' && textoLimpo(a.categoria, 40)) dados['Categoria'] = textoLimpo(a.categoria, 40);
      if (typeof a.nome === 'string' && textoLimpo(a.nome, 120).length >= 2) dados['Nome'] = textoLimpo(a.nome, 120);
      if (typeof a.destaque === 'boolean') dados['Destaque'] = a.destaque;
      if (!Object.keys(dados).length) continue;
      await bubblePatch('produto', a.produto_id, dados);
      aplicadas++;
    }
    return res.json({ status: 'success', response: { aplicadas } });
  } catch (erro) {
    console.error('Erro em /loja-organizar-aplicar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível aplicar as correcções.' });
  }
});

const PAGINA_ADMIN_KYC = "<!DOCTYPE html>\n<html lang=\"pt\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<meta name=\"robots\" content=\"noindex, nofollow\">\n<title>KYC · Daniel IA</title>\n<link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2216%22%20fill%3D%22%23430960%22%2F%3E%3Cg%20transform%3D%22translate%2811.52%2011.52%29%20scale%280.16384%29%20translate%28-111%20-492.5%29%22%3E%3Cpath%20fill%3D%22%23FFFFFF%22%20d%3D%22M148.0%20738.1C142.7%20737.4%20139.2%20736.1%20135.6%20733.7C128.3%20728.8%20123.9%20721.8%20122.6%20713.1C122.1%20709.4%20122.1%20707.5%20122.7%20704.0C123.8%20697.6%20126.3%20692.6%20130.6%20688.3C133.2%20685.6%20136.0%20683.8%20141.9%20680.7C150.6%20676.1%20156.0%20672.8%20160.9%20669.2C172.2%20660.9%20180.7%20651.9%20187.8%20640.6C188.3%20639.9%20188.8%20639.4%20189.0%20639.4C189.4%20639.4%20189.5%20702.5%20189.0%20705.6C187.7%20714.1%20184.5%20720.7%20178.6%20726.7C172.9%20732.7%20168.0%20735.6%20160.8%20737.5C158.3%20738.2%20157.3%20738.3%20154.1%20738.4C151.7%20738.4%20149.5%20738.4%20148.0%20738.1ZM183.5%20737.9C183.5%20737.7%20184.1%20737.1%20184.9%20736.6C189.2%20733.9%20194.3%20728.3%20197.4%20723.0C202.1%20715.1%20203.7%20708.5%20203.7%20698.0C203.7%20694.3%20203.8%20692.7%20204.1%20692.4C204.3%20692.1%20206.1%20692.0%20222.0%20691.9C238.3%20691.8%20239.9%20691.8%20243.0%20691.3C254.0%20689.6%20263.9%20685.6%20273.4%20679.0C281.6%20673.4%20288.9%20665.8%20294.0%20657.5C298.3%20650.5%20301.7%20642.5%20303.3%20635.4C306.8%20619.6%20305.5%20604.6%20299.3%20589.3C296.5%20582.2%20293.0%20576.6%20286.9%20569.6C282.9%20564.8%20279.8%20562.0%20274.4%20558.1C264.1%20550.6%20251.7%20545.8%20240.8%20545.0C238.8%20544.8%20228.4%20544.8%20215.6%20544.8L193.8%20544.9L192.7%20545.6C191.4%20546.5%20190.1%20548.2%20189.7%20549.4C189.5%20550.1%20189.4%20555.5%20189.4%20571.2C189.4%20582.6%20189.3%20592.1%20189.2%20592.2C188.9%20592.4%20188.0%20591.4%20188.0%20590.9C188.0%20590.0%20185.1%20584.4%20182.5%20580.6C179.3%20575.7%20171.4%20568.0%20165.1%20563.7C161.4%20561.2%20152.2%20556.2%20143.4%20551.9C134.1%20547.4%20130.6%20544.8%20127.0%20540.0C124.6%20536.8%20123.4%20533.6%20122.6%20529.1C122.2%20526.2%20122.2%20523.9%20122.6%20520.6C123.1%20517.2%20123.8%20514.9%20125.2%20512.1C128.5%20505.5%20134.2%20500.8%20141.6%20498.7C146.7%20497.2%20146.0%20497.2%20196.5%20497.3C246.4%20497.4%20244.5%20497.4%20253.4%20498.8C268.8%20501.2%20287.7%20509.1%20301.3%20518.9C312.8%20527.0%20323.6%20538.1%20330.9%20549.1C335.2%20555.5%20337.8%20560.2%20340.5%20566.0C344.7%20575.1%20347.2%20582.3%20349.5%20592.4C351.4%20600.7%20352.0%20605.8%20352.2%20615.9C352.4%20628.3%20351.3%20638.6%20348.6%20648.9C345.6%20660.5%20339.4%20674.8%20333.6%20684.0C323.4%20700.1%20309.0%20713.7%20292.2%20723.3C282.4%20728.9%20271.5%20733.1%20261.5%20735.3C248.6%20738.2%20247.4%20738.2%20211.8%20738.2C186.7%20738.2%20183.5%20738.2%20183.5%20737.9Z%22%2F%3E%3Ccircle%20fill%3D%22%2389C804%22%20cx%3D%22149.1%22%20cy%3D%22612.7%22%20r%3D%2229.7%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Sora:wght@600;700;800&family=JetBrains+Mono:wght@500&display=swap\" rel=\"stylesheet\">\n<style>\n  :root{\n    --bg:#07030C;--card:#110A1B;--card-alt:#170E25;--border:#2A1B3D;--text:#F6F2FB;--text-dim:#A89BBA;\n    --lime:#89C804;--lime-bright:#B4F02B;--purple:#430960;--purple-bright:#A35BE0;--on-accent:#140620;\n    --error:#FF5C7A;--warning:#F5A623;\n    --grad-accent:linear-gradient(135deg,#C8F84A 0%,#89C804 100%);\n  }\n  *{box-sizing:border-box;}\n  body{margin:0;min-height:100vh;color:var(--text);font-family:\"Manrope\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;\n    background:radial-gradient(1100px 600px at 10% -14%, rgba(67,9,96,.9), rgba(67,9,96,0) 62%),\n      radial-gradient(800px 500px at 108% 6%, rgba(137,200,4,.10), rgba(137,200,4,0) 60%),#07030C;background-attachment:fixed;}\n  button,input,textarea{font-family:inherit;}\n  h1,h2,h3{font-family:\"Sora\",\"Manrope\",sans-serif;letter-spacing:-.025em;margin:0;}\n  .topo{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 28px;border-bottom:1px solid rgba(255,255,255,.08);\n    background:rgba(17,10,27,.6);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);position:sticky;top:0;z-index:10;}\n  .brand-logo{height:28px;width:auto;display:block;}\n  .brand-logo .bl-ink{fill:#FFFFFF;}\n  .brand-logo .bl-lime{fill:var(--lime);}\n  .etiqueta{font-family:\"JetBrains Mono\",monospace;font-size:12px;color:var(--lime);letter-spacing:.14em;}\n  .main{max-width:1100px;margin:0 auto;padding:32px 24px 80px;}\n  .caixa-chave{max-width:420px;margin:12vh auto 0;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:30px;}\n  .caixa-chave p{color:var(--text-dim);font-size:14px;line-height:1.6;margin:8px 0 20px;}\n  input[type=password],textarea{width:100%;background:var(--card-alt);border:1px solid var(--border);color:var(--text);border-radius:11px;padding:12px 14px;font-size:14px;outline:none;}\n  input:focus,textarea:focus{border-color:var(--lime);}\n  .btn{border:none;border-radius:11px;padding:11px 18px;font-size:13.5px;font-weight:700;cursor:pointer;transition:transform .15s,opacity .15s;}\n  .btn:disabled{opacity:.5;cursor:default;}\n  .btn-principal{background:var(--grad-accent);color:var(--on-accent);box-shadow:0 8px 24px rgba(137,200,4,.25);}\n  .btn-principal:hover:not(:disabled){transform:translateY(-1px);}\n  .btn-sec{background:transparent;color:var(--text);border:1px solid var(--border);}\n  .btn-sec:hover{border-color:var(--lime);}\n  .btn-perigo{background:rgba(255,92,122,.12);color:var(--error);border:1px solid rgba(255,92,122,.35);}\n  .erro{color:var(--error);font-size:13px;margin-top:12px;min-height:18px;}\n  .cabecalho{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px;}\n  .cabecalho p{color:var(--text-dim);margin:6px 0 0;font-size:14px;}\n  .tabs{display:flex;gap:6px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:4px;}\n  .tab{background:transparent;border:none;color:var(--text-dim);padding:8px 14px;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;}\n  .tab.activa{background:var(--card-alt);color:var(--text);box-shadow:inset 0 0 0 1px rgba(137,200,4,.35);}\n  .vazio{color:var(--text-dim);text-align:center;padding:60px 0;font-size:14px;}\n  .pedido{background:rgba(17,10,27,.7);border:1px solid var(--border);border-radius:18px;padding:22px;margin-bottom:16px;}\n  .pedido-topo{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;}\n  .pedido h3{font-size:18px;}\n  .dados{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:8px;font-size:13px;color:var(--text-dim);}\n  .dados b{color:var(--text);font-weight:600;font-family:\"JetBrains Mono\",monospace;font-size:12.5px;}\n  .pill{display:inline-block;font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:999px;border:1px solid var(--border);}\n  .pill.Pendente{color:var(--warning);border-color:rgba(245,166,35,.35);background:rgba(245,166,35,.1);}\n  .pill.Aprovado{color:var(--lime);border-color:rgba(137,200,4,.35);background:rgba(137,200,4,.1);}\n  .pill.Rejeitado{color:var(--error);border-color:rgba(255,92,122,.35);background:rgba(255,92,122,.1);}\n  .fotos{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px;}\n  .foto{background:var(--card-alt);border:1px solid var(--border);border-radius:12px;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;\n    overflow:hidden;position:relative;color:var(--text-dim);font-size:12.5px;}\n  .foto img{width:100%;height:100%;object-fit:contain;cursor:zoom-in;background:#000;}\n  .foto .rotulo{position:absolute;left:8px;top:8px;font-family:\"JetBrains Mono\",monospace;font-size:10.5px;letter-spacing:.08em;\n    background:rgba(7,3,12,.75);color:var(--lime);padding:3px 7px;border-radius:6px;}\n  .accoes{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px;align-items:center;}\n  .rejeitar-caixa{display:none;margin-top:14px;}\n  .rejeitar-caixa.aberta{display:block;}\n  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;}\n  .chip{background:var(--card-alt);border:1px solid var(--border);color:var(--text-dim);border-radius:999px;padding:6px 11px;font-size:12px;cursor:pointer;}\n  .chip:hover{color:var(--text);border-color:var(--purple-bright);}\n  .motivo{color:var(--error);font-size:13px;margin-top:10px;}\n  .zoom{position:fixed;inset:0;background:rgba(7,3,12,.92);display:none;align-items:center;justify-content:center;z-index:100;cursor:zoom-out;padding:24px;}\n  .zoom.aberto{display:flex;}\n  .zoom img{max-width:100%;max-height:100%;border-radius:10px;}\n  @media (max-width:700px){.fotos{grid-template-columns:1fr;}.topo{padding:12px 16px;}}\n</style>\n</head>\n<body>\n<div class=\"topo\">\n  <svg class=\"brand-logo\" viewBox=\"112 489 1060 257\" role=\"img\" aria-label=\"Daniel IA\" xmlns=\"http://www.w3.org/2000/svg\"><path class=\"bl-ink\" d=\"M148.0 738.1C142.7 737.4 139.2 736.1 135.6 733.7C128.3 728.8 123.9 721.8 122.6 713.1C122.1 709.4 122.1 707.5 122.7 704.0C123.8 697.6 126.3 692.6 130.6 688.3C133.2 685.6 136.0 683.8 141.9 680.7C150.6 676.1 156.0 672.8 160.9 669.2C172.2 660.9 180.7 651.9 187.8 640.6C188.3 639.9 188.8 639.4 189.0 639.4C189.4 639.4 189.5 702.5 189.0 705.6C187.7 714.1 184.5 720.7 178.6 726.7C172.9 732.7 168.0 735.6 160.8 737.5C158.3 738.2 157.3 738.3 154.1 738.4C151.7 738.4 149.5 738.4 148.0 738.1ZM183.5 737.9C183.5 737.7 184.1 737.1 184.9 736.6C189.2 733.9 194.3 728.3 197.4 723.0C202.1 715.1 203.7 708.5 203.7 698.0C203.7 694.3 203.8 692.7 204.1 692.4C204.3 692.1 206.1 692.0 222.0 691.9C238.3 691.8 239.9 691.8 243.0 691.3C254.0 689.6 263.9 685.6 273.4 679.0C281.6 673.4 288.9 665.8 294.0 657.5C298.3 650.5 301.7 642.5 303.3 635.4C306.8 619.6 305.5 604.6 299.3 589.3C296.5 582.2 293.0 576.6 286.9 569.6C282.9 564.8 279.8 562.0 274.4 558.1C264.1 550.6 251.7 545.8 240.8 545.0C238.8 544.8 228.4 544.8 215.6 544.8L193.8 544.9L192.7 545.6C191.4 546.5 190.1 548.2 189.7 549.4C189.5 550.1 189.4 555.5 189.4 571.2C189.4 582.6 189.3 592.1 189.2 592.2C188.9 592.4 188.0 591.4 188.0 590.9C188.0 590.0 185.1 584.4 182.5 580.6C179.3 575.7 171.4 568.0 165.1 563.7C161.4 561.2 152.2 556.2 143.4 551.9C134.1 547.4 130.6 544.8 127.0 540.0C124.6 536.8 123.4 533.6 122.6 529.1C122.2 526.2 122.2 523.9 122.6 520.6C123.1 517.2 123.8 514.9 125.2 512.1C128.5 505.5 134.2 500.8 141.6 498.7C146.7 497.2 146.0 497.2 196.5 497.3C246.4 497.4 244.5 497.4 253.4 498.8C268.8 501.2 287.7 509.1 301.3 518.9C312.8 527.0 323.6 538.1 330.9 549.1C335.2 555.5 337.8 560.2 340.5 566.0C344.7 575.1 347.2 582.3 349.5 592.4C351.4 600.7 352.0 605.8 352.2 615.9C352.4 628.3 351.3 638.6 348.6 648.9C345.6 660.5 339.4 674.8 333.6 684.0C323.4 700.1 309.0 713.7 292.2 723.3C282.4 728.9 271.5 733.1 261.5 735.3C248.6 738.2 247.4 738.2 211.8 738.2C186.7 738.2 183.5 738.2 183.5 737.9Z\"/><circle class=\"bl-lime\" cx=\"149.1\" cy=\"612.7\" r=\"29.7\"/><path class=\"bl-ink\" d=\"M583.7 695.1C577.0 694.2 572.3 692.2 567.6 688.5C561.0 683.2 557.4 673.0 558.6 663.1C559.4 656.8 561.1 652.6 564.5 648.3C567.6 644.6 571.5 642.0 577.4 639.7C580.8 638.4 581.6 638.1 585.4 637.3C591.0 636.0 596.6 635.5 608.5 635.3C614.7 635.2 619.0 635.1 619.2 634.9C619.4 634.8 619.5 633.9 619.5 632.5C619.5 625.7 617.7 621.5 613.8 618.7C610.5 616.5 606.0 615.2 601.4 615.2C598.3 615.2 596.0 615.8 593.1 617.1C589.4 618.9 587.1 621.5 585.5 625.7C584.8 627.6 584.5 627.8 583.1 627.7C581.5 627.5 576.4 626.8 574.1 626.5C572.5 626.2 566.0 625.3 564.0 625.1C562.2 624.9 562.0 624.8 562.0 624.1C562.0 623.1 563.0 619.4 563.8 617.0C565.5 612.6 568.3 608.5 571.9 605.4C573.6 603.9 576.3 602.0 576.7 602.0C576.8 602.0 577.0 601.8 577.2 601.7C578.0 600.9 581.6 599.2 584.1 598.4C590.2 596.3 595.4 595.5 602.5 595.5C616.5 595.5 627.3 599.3 635.0 607.0C639.5 611.5 641.5 615.3 643.3 622.5L643.9 624.9L643.9 659.2L643.9 693.6L632.7 693.7C622.5 693.7 621.5 693.7 621.0 693.3C620.5 692.9 620.5 692.6 620.5 687.1C620.4 684.0 620.4 681.2 620.3 681.1C620.1 680.4 619.5 680.8 617.7 683.1C615.1 686.3 614.3 687.2 612.5 688.6C609.1 691.3 605.3 693.1 600.4 694.5C596.9 695.4 588.4 695.8 583.7 695.1ZM853.4 695.1C849.2 694.6 845.0 693.5 840.4 691.6C832.6 688.3 826.5 683.4 822.1 676.7C820.0 673.5 817.6 669.2 816.8 667.1C815.3 663.1 814.4 659.3 813.7 654.6C813.3 651.3 813.2 650.1 813.3 644.1C813.4 637.0 813.6 635.6 814.9 630.6C815.5 628.4 816.9 624.2 817.5 622.9C820.4 616.5 823.3 612.2 827.7 608.0C833.0 602.8 839.6 599.2 847.5 597.1C859.0 594.2 871.8 595.1 881.2 599.7C889.1 603.5 895.4 609.2 899.6 616.4C902.9 622.0 905.4 630.2 906.0 637.2C906.1 638.8 906.2 642.6 906.2 645.5C906.2 650.1 906.2 651.0 905.9 651.3C905.6 651.5 899.0 651.6 872.4 651.5C840.3 651.5 839.3 651.5 838.9 652.0C838.5 652.4 838.5 652.7 838.8 654.9C839.2 658.9 840.9 663.5 842.9 666.3C846.2 670.7 852.0 674.2 858.0 675.3C860.2 675.7 864.7 675.6 867.0 675.2C871.8 674.1 876.0 671.7 878.7 668.4C879.7 667.1 881.3 664.3 881.6 663.3C881.8 662.2 882.1 662.2 889.6 664.2C900.7 667.0 903.5 667.8 903.8 668.3C904.2 668.9 902.1 673.8 899.8 677.4C897.5 681.0 892.8 685.8 889.1 688.2C885.3 690.7 879.8 693.0 874.4 694.2C869.4 695.4 859.5 695.8 853.4 695.1ZM430.3 693.3C429.9 692.5 429.9 561.5 430.3 561.1C430.7 560.7 482.3 560.6 487.3 561.0C492.7 561.4 498.2 562.6 505.7 565.2C508.2 566.0 513.4 568.4 514.9 569.4C515.3 569.7 516.6 570.5 517.8 571.3C526.0 576.6 531.8 583.4 536.7 593.1C540.0 599.7 541.8 605.0 543.2 612.9C545.1 623.1 544.8 638.6 542.4 647.9C539.5 659.3 533.8 669.5 526.3 676.8C522.2 680.7 521.1 681.7 517.5 683.8C510.6 687.9 504.6 690.3 496.7 692.0C488.9 693.6 489.4 693.6 458.6 693.7C430.8 693.8 430.5 693.8 430.3 693.3ZM663.9 693.4C663.4 693.1 663.4 692.2 663.4 645.6C663.4 598.5 663.4 598.2 663.9 597.8C664.3 597.5 666.0 597.5 675.9 597.5C683.0 597.6 687.5 597.7 687.7 597.9C687.9 598.1 688.0 599.4 688.1 604.2C688.2 611.5 688.2 611.5 690.3 608.6C695.1 601.8 703.7 596.8 712.4 595.8C715.6 595.4 720.8 595.4 723.9 595.9C732.9 597.2 741.5 602.4 746.0 609.2C748.5 613.0 749.9 616.2 751.1 621.0C752.6 626.6 752.5 625.9 752.6 660.7C752.7 692.0 752.7 692.8 752.3 693.2C751.8 693.7 751.2 693.7 740.0 693.7C729.3 693.8 728.1 693.7 727.7 693.3C727.3 692.9 727.2 691.9 727.2 664.8C727.2 646.1 727.2 635.7 727.0 633.8C726.4 627.8 724.1 623.2 720.6 620.7C717.2 618.4 713.5 617.2 709.0 617.2C703.2 617.2 698.2 619.4 694.2 623.7C691.3 626.8 689.4 631.5 688.8 637.3C688.6 638.9 688.5 648.8 688.5 666.5C688.5 681.6 688.4 693.3 688.3 693.4C688.2 693.4 682.7 693.6 676.2 693.6C666.2 693.8 664.3 693.7 663.9 693.4ZM772.1 693.3C771.8 693.0 771.8 687.9 771.8 645.5C771.8 603.7 771.8 598.0 772.1 597.8C772.4 597.5 775.2 597.5 784.5 597.5C795.8 597.6 796.6 597.7 796.9 598.1C797.2 598.5 797.2 606.7 797.2 645.8C797.3 688.7 797.2 693.0 796.9 693.4C796.5 693.7 795.1 693.8 784.5 693.7C774.1 693.7 772.5 693.7 772.1 693.3ZM922.8 693.4C922.4 693.0 922.2 561.6 922.6 561.1C922.8 560.8 924.9 560.8 935.1 560.7C943.9 560.7 947.4 560.8 947.6 561.0C948.2 561.4 948.1 692.4 947.6 693.2L947.2 693.8L935.1 693.8C925.6 693.8 923.0 693.7 922.8 693.4ZM604.4 675.8C608.3 674.7 611.3 672.9 614.3 669.8C617.0 667.0 618.6 663.7 619.2 660.0C619.6 657.4 619.7 652.3 619.3 652.0C618.4 651.5 604.6 651.6 600.2 652.1C597.6 652.5 593.5 653.3 592.1 653.8C587.7 655.3 584.6 657.9 583.5 661.2C582.7 663.4 582.9 668.0 583.7 669.9C584.9 672.5 587.0 674.4 590.1 675.5C592.5 676.3 593.8 676.5 598.2 676.4C601.5 676.3 602.8 676.2 604.4 675.8ZM486.9 670.3C495.8 668.6 501.6 665.8 506.8 660.4C510.0 657.1 513.1 652.2 514.4 648.1C515.5 645.1 516.7 639.3 517.1 635.6C517.6 631.5 517.5 622.1 517.0 618.5C514.5 601.5 506.4 590.5 492.7 586.0C487.4 584.3 485.4 584.0 474.9 583.7C462.7 583.4 456.6 583.5 456.2 584.0C456.1 584.2 456.0 600.8 456.0 627.4C456.0 661.5 456.1 670.5 456.3 670.7C456.6 671.0 459.5 671.0 470.4 670.9C482.9 670.8 484.4 670.8 486.9 670.3ZM882.0 634.8C882.3 634.3 882.1 633.0 881.4 630.3C880.3 626.3 877.5 622.1 874.0 619.4C868.1 614.8 858.4 613.9 851.3 617.2C847.5 619.0 844.6 621.6 842.4 625.0C841.1 627.0 840.5 628.3 839.6 631.1C838.9 633.4 838.8 634.9 839.3 635.1C839.5 635.2 849.1 635.2 860.7 635.2C881.2 635.2 881.7 635.2 882.0 634.8ZM782.2 583.2C778.2 582.6 774.0 579.9 771.9 576.5C769.8 573.2 769.3 567.7 770.6 563.1C773.2 554.3 784.5 550.4 792.5 555.5C795.7 557.6 798.2 561.2 799.0 564.8C799.5 566.9 799.2 571.7 798.5 573.6C797.3 576.9 794.3 580.4 791.2 581.8C788.5 583.1 785.0 583.7 782.2 583.2Z\"/><path class=\"bl-lime\" d=\"M999.8 693.4C999.4 692.9 999.4 561.8 999.8 561.2C1000.1 560.8 1001.4 560.8 1012.7 560.7C1019.6 560.7 1025.3 560.8 1025.5 560.9C1025.7 561.0 1025.8 580.3 1025.8 626.8C1025.8 683.3 1025.7 692.7 1025.4 693.1C1025.1 693.6 1024.6 693.6 1012.6 693.7C1002.0 693.8 1000.0 693.7 999.8 693.4ZM1039.6 693.6C1039.4 693.5 1039.2 693.2 1039.2 693.0C1039.2 692.5 1041.1 686.8 1041.5 685.9C1041.6 685.6 1041.9 684.9 1042.1 684.2C1042.3 683.6 1043.0 681.7 1043.6 679.9C1045.8 673.7 1046.5 671.6 1047.5 668.8C1048.0 667.2 1048.9 664.6 1049.5 663.0C1050.1 661.4 1050.7 659.5 1051.0 658.8C1051.3 658.0 1051.9 656.1 1052.5 654.5C1053.5 651.9 1054.1 650.2 1056.5 643.2C1056.9 642.1 1058.0 638.9 1059.0 636.1C1061.4 629.1 1063.3 623.7 1065.6 617.1C1066.3 615.3 1067.1 612.9 1067.5 611.6C1067.9 610.4 1068.7 608.4 1069.1 607.2C1069.6 606.1 1070.3 603.9 1070.8 602.5C1071.3 601.1 1072.4 597.9 1073.2 595.5C1074.1 593.1 1075.2 590.0 1075.6 588.6C1076.1 587.2 1076.8 585.3 1077.2 584.4C1077.6 583.4 1078.2 581.6 1078.6 580.4C1079.5 577.4 1080.3 575.0 1081.1 572.9C1082.3 569.7 1082.8 568.4 1083.6 565.9C1084.6 562.9 1085.4 561.1 1085.7 560.9C1085.9 560.8 1093.2 560.7 1102.0 560.7C1116.7 560.7 1118.1 560.8 1118.5 561.2C1118.8 561.4 1119.0 561.7 1119.0 561.9C1119.0 562.1 1119.7 564.2 1120.5 566.7C1121.3 569.1 1122.1 571.5 1122.2 572.0C1122.4 572.8 1123.6 576.1 1125.3 580.8C1125.6 581.5 1126.2 583.4 1126.7 585.0C1127.3 586.6 1128.4 589.8 1129.2 592.1C1130.0 594.5 1131.2 597.8 1131.7 599.5C1132.3 601.2 1133.1 603.5 1133.5 604.5C1135.0 608.5 1138.0 617.1 1140.0 622.9C1141.1 626.2 1142.6 630.7 1143.4 632.9C1144.1 635.1 1145.8 639.9 1147.1 643.6C1148.4 647.3 1150.1 652.2 1150.9 654.4C1152.3 658.3 1154.8 665.7 1160.6 682.6C1162.2 687.3 1163.7 691.5 1163.9 692.1C1164.2 692.7 1164.2 693.1 1164.1 693.3C1163.9 693.6 1160.9 693.6 1150.4 693.7C1137.8 693.8 1137.1 693.8 1136.6 693.3C1136.2 693.0 1135.3 690.7 1133.4 684.9C1132.0 680.5 1130.2 675.2 1129.6 673.2C1128.9 671.3 1128.0 668.6 1127.6 667.4C1127.3 666.1 1126.8 664.7 1126.5 664.2L1126.1 663.4L1123.6 663.2C1122.2 663.1 1111.2 663.0 1099.1 663.0C1077.3 663.0 1077.0 663.0 1076.5 663.5C1076.2 663.8 1076.0 664.2 1076.0 664.4C1076.0 664.7 1073.0 673.9 1071.3 678.9C1070.4 681.4 1069.4 684.3 1068.9 685.8C1068.6 686.6 1068.0 688.4 1067.6 689.6C1066.7 692.7 1066.5 693.2 1066.2 693.4C1065.8 693.6 1040.1 693.8 1039.6 693.6ZM1119.4 641.6C1119.6 641.2 1118.2 636.6 1116.2 631.1C1115.4 628.6 1114.6 626.1 1112.0 618.1C1109.8 611.4 1108.3 606.4 1107.1 602.6C1106.5 600.4 1105.4 596.9 1104.7 594.9C1104.0 592.8 1103.2 590.2 1102.9 589.1C1102.5 587.6 1102.3 587.1 1101.9 587.0C1101.3 586.9 1101.0 587.4 1101.0 588.4C1101.0 588.8 1100.2 591.4 1099.2 594.3C1097.2 600.3 1092.6 613.9 1091.6 617.1C1090.7 620.0 1089.0 625.3 1086.9 631.5C1084.4 638.7 1083.6 641.5 1084.0 641.8C1084.2 641.9 1092.2 642.0 1101.8 642.0C1117.3 642.0 1119.3 642.0 1119.4 641.6Z\"/></svg>\n  <span class=\"etiqueta\">// PAINEL KYC</span>\n</div>\n\n<div class=\"main\">\n  <div class=\"caixa-chave\" id=\"vista-chave\">\n    <h2>Acesso restrito</h2>\n    <p>Escreve a chave de administração (a mesma ADMIN_SECRET das variáveis do container). Fica guardada só nesta aba.</p>\n    <input type=\"password\" id=\"chave\" placeholder=\"Chave de administração\" autocomplete=\"off\">\n    <div style=\"margin-top:14px;\"><button class=\"btn btn-principal\" id=\"btn-entrar\" style=\"width:100%;\">Entrar</button></div>\n    <div class=\"erro\" id=\"erro-chave\"></div>\n  </div>\n\n  <div id=\"vista-painel\" style=\"display:none;\">\n    <div class=\"cabecalho\">\n      <div>\n        <h1>Verificações de identidade</h1>\n        <p id=\"resumo\">A carregar...</p>\n      </div>\n      <div class=\"tabs\">\n        <button class=\"tab activa\" data-estado=\"Pendente\">Pendentes</button>\n        <button class=\"tab\" data-estado=\"Aprovado\">Aprovados</button>\n        <button class=\"tab\" data-estado=\"Rejeitado\">Rejeitados</button>\n      </div>\n    </div>\n    <div id=\"lista\"></div>\n    <div style=\"text-align:center;margin-top:24px;\"><button class=\"btn btn-sec\" id=\"btn-sair\">Sair do painel</button></div>\n  </div>\n</div>\n\n<div class=\"zoom\" id=\"zoom\"><img id=\"zoom-img\" alt=\"\"></div>\n\n<script>\n(function(){\n  'use strict';\n  var chave = '';\n  var estadoActual = 'Pendente';\n  try { chave = sessionStorage.getItem('dia_admin_kyc') || ''; } catch (e) {}\n\n  function post(caminho, dados){\n    dados.key = chave;\n    return fetch(caminho, {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify(dados)\n    }).then(function(r){ return r.json(); });\n  }\n\n  function esc(t){\n    return String(t == null ? '' : t).replace(/[&<>\"']/g, function(c){\n      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c];\n    });\n  }\n\n  function data(iso){\n    if (!iso) return '—';\n    var d = new Date(iso);\n    if (isNaN(d.getTime())) return '—';\n    return d.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });\n  }\n\n  var elChave = document.getElementById('chave');\n  var elErroChave = document.getElementById('erro-chave');\n  var elLista = document.getElementById('lista');\n  var elResumo = document.getElementById('resumo');\n\n  function entrar(){\n    chave = elChave.value.trim();\n    if (!chave) { elErroChave.textContent = 'Escreve a chave.'; return; }\n    carregar(true);\n  }\n  document.getElementById('btn-entrar').addEventListener('click', entrar);\n  elChave.addEventListener('keydown', function(e){ if (e.key === 'Enter') entrar(); });\n\n  document.getElementById('btn-sair').addEventListener('click', function(){\n    try { sessionStorage.removeItem('dia_admin_kyc'); } catch (e) {}\n    chave = '';\n    elChave.value = '';\n    document.getElementById('vista-painel').style.display = 'none';\n    document.getElementById('vista-chave').style.display = 'block';\n  });\n\n  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function(tab){\n    tab.addEventListener('click', function(){\n      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function(t){ t.classList.remove('activa'); });\n      tab.classList.add('activa');\n      estadoActual = tab.getAttribute('data-estado');\n      carregar(false);\n    });\n  });\n\n  function carregar(daChave){\n    elResumo.textContent = 'A carregar...';\n    elLista.innerHTML = '';\n    post('/admin-kyc-lista', { estado: estadoActual }).then(function(r){\n      if (r.status !== 'success') {\n        if (daChave || r.message === 'Chave inválida.') {\n          elErroChave.textContent = r.message || 'Não foi possível entrar.';\n          document.getElementById('vista-painel').style.display = 'none';\n          document.getElementById('vista-chave').style.display = 'block';\n          try { sessionStorage.removeItem('dia_admin_kyc'); } catch (e) {}\n        } else {\n          elResumo.textContent = r.message || 'Erro ao carregar.';\n        }\n        return;\n      }\n      try { sessionStorage.setItem('dia_admin_kyc', chave); } catch (e) {}\n      elErroChave.textContent = '';\n      document.getElementById('vista-chave').style.display = 'none';\n      document.getElementById('vista-painel').style.display = 'block';\n      var pedidos = r.response.pedidos || [];\n      var nomes = { Pendente: 'pendente', Aprovado: 'aprovado', Rejeitado: 'rejeitado' };\n      elResumo.textContent = pedidos.length + ' pedido' + (pedidos.length === 1 ? '' : 's') + ' ' + nomes[estadoActual] + (pedidos.length === 1 ? '' : 's') + '.';\n      if (!pedidos.length) {\n        elLista.innerHTML = '<div class=\"vazio\">Nada por aqui.</div>';\n        return;\n      }\n      pedidos.forEach(function(p){ elLista.appendChild(cartao(p)); });\n    }).catch(function(){\n      elErroChave.textContent = 'Não foi possível ligar ao servidor.';\n    });\n  }\n\n  var MOTIVOS = [\n    'A selfie está desfocada ou escura.',\n    'O B.I. está ilegível.',\n    'A selfie não corresponde à foto do B.I.',\n    'O B.I. está fora do prazo de validade.',\n    'Os dados escritos não batem certo com o B.I.'\n  ];\n\n  function cartao(p){\n    var el = document.createElement('div');\n    el.className = 'pedido';\n    var html = ''\n      + '<div class=\"pedido-topo\"><div>'\n      + '<h3>' + esc(p.nome) + '</h3>'\n      + '<div class=\"dados\">'\n      + '<span>B.I. <b>' + esc(p.numero_bi) + '</b></span>'\n      + '<span>Tel. <b>' + esc(p.telefone) + '</b></span>'\n      + '<span>Email <b>' + esc(p.email || '—') + '</b></span>'\n      + '<span>Enviado <b>' + esc(data(p.enviado)) + '</b></span>'\n      + (p.revisto ? '<span>Revisto <b>' + esc(data(p.revisto)) + '</b></span>' : '')\n      + '</div></div>'\n      + '<div><span class=\"pill ' + esc(p.estado) + '\">' + esc(p.estado) + '</span></div></div>'\n      + (p.motivo ? '<div class=\"motivo\">Motivo: ' + esc(p.motivo) + '</div>' : '')\n      + '<div class=\"fotos\">'\n      + '<div class=\"foto\" data-tipo=\"selfie\"><span class=\"rotulo\">SELFIE</span>A carregar...</div>'\n      + '<div class=\"foto\" data-tipo=\"frente\"><span class=\"rotulo\">B.I. FRENTE</span>A carregar...</div>'\n      + '<div class=\"foto\" data-tipo=\"verso\"><span class=\"rotulo\">B.I. VERSO</span>A carregar...</div>'\n      + '</div>';\n    if (p.estado === 'Pendente') {\n      html += '<div class=\"accoes\">'\n        + '<button class=\"btn btn-principal\" data-acao=\"aprovar\">Aprovar</button>'\n        + '<button class=\"btn btn-perigo\" data-acao=\"rejeitar\">Rejeitar</button>'\n        + '<span class=\"erro\" data-erro></span></div>'\n        + '<div class=\"rejeitar-caixa\"><div class=\"chips\">'\n        + MOTIVOS.map(function(m){ return '<button class=\"chip\" type=\"button\">' + esc(m) + '</button>'; }).join('')\n        + '</div><textarea rows=\"3\" placeholder=\"Motivo da rejeição (vai por email ao cliente)\"></textarea>'\n        + '<div class=\"accoes\"><button class=\"btn btn-perigo\" data-acao=\"confirmar-rejeicao\">Confirmar rejeição</button>'\n        + '<button class=\"btn btn-sec\" data-acao=\"cancelar\">Cancelar</button></div></div>';\n    }\n    el.innerHTML = html;\n\n    Array.prototype.forEach.call(el.querySelectorAll('.foto'), function(caixa){\n      var tipo = caixa.getAttribute('data-tipo');\n      post('/admin-kyc-imagem', { id: p.id, tipo: tipo }).then(function(r){\n        var rotulo = caixa.querySelector('.rotulo').outerHTML;\n        if (r.status !== 'success') { caixa.innerHTML = rotulo + esc(r.message || 'Erro'); return; }\n        caixa.innerHTML = rotulo + '<img alt=\"' + tipo + '\">';\n        var img = caixa.querySelector('img');\n        img.src = r.response.data;\n        img.addEventListener('click', function(){\n          document.getElementById('zoom-img').src = img.src;\n          document.getElementById('zoom').classList.add('aberto');\n        });\n      }).catch(function(){ caixa.lastChild.textContent = 'Erro de ligação'; });\n    });\n\n    if (p.estado === 'Pendente') {\n      var caixaRej = el.querySelector('.rejeitar-caixa');\n      var txt = caixaRej.querySelector('textarea');\n      var elErro = el.querySelector('[data-erro]');\n      Array.prototype.forEach.call(caixaRej.querySelectorAll('.chip'), function(chip){\n        chip.addEventListener('click', function(){ txt.value = chip.textContent; txt.focus(); });\n      });\n      el.querySelector('[data-acao=\"rejeitar\"]').addEventListener('click', function(){ caixaRej.classList.add('aberta'); txt.focus(); });\n      el.querySelector('[data-acao=\"cancelar\"]').addEventListener('click', function(){ caixaRej.classList.remove('aberta'); });\n\n      function decidir(decisao, motivo, botao){\n        botao.disabled = true;\n        elErro.textContent = '';\n        post('/admin-kyc-decidir', { id: p.id, decisao: decisao, motivo: motivo }).then(function(r){\n          if (r.status !== 'success') { botao.disabled = false; elErro.textContent = r.message || 'Erro.'; return; }\n          el.style.transition = 'opacity .3s';\n          el.style.opacity = '0';\n          setTimeout(function(){ carregar(false); }, 320);\n        }).catch(function(){ botao.disabled = false; elErro.textContent = 'Erro de ligação.'; });\n      }\n      el.querySelector('[data-acao=\"aprovar\"]').addEventListener('click', function(){\n        if (!window.confirm('Aprovar a verificação de ' + p.nome + '?')) return;\n        decidir('Aprovado', '', this);\n      });\n      el.querySelector('[data-acao=\"confirmar-rejeicao\"]').addEventListener('click', function(){\n        decidir('Rejeitado', txt.value.trim(), this);\n      });\n    }\n    return el;\n  }\n\n  document.getElementById('zoom').addEventListener('click', function(){ this.classList.remove('aberto'); });\n\n  if (chave) { elChave.value = chave; carregar(true); }\n})();\n</script>\n</body>\n</html>\n";


// ======================================================
// Biblioteca de padrões profissionais (1.60.0)
// ------------------------------------------------------
// Tirada de dezenas de referências de nível alto (agências, portefólios,
// galerias, lojas de mercearia, moda, tecnologia, restaurantes e entregas).
// Não são moldes: são peças que a IA combina conforme a direcção de arte.
// ======================================================
const PADROES_GERAIS = `
BIBLIOTECA DE PADRÕES PROFISSIONAIS (combina as peças que servem a esta direcção de arte - nunca todas, nunca sempre as mesmas):
- Hero com promessa clara: título de 2 a 3 linhas com UMA palavra ou expressão em destaque (cor de destaque, degradê no texto, sublinhado desenhado, itálico serifado ou letra manuscrita), frase de apoio curta, 2 botões (principal sólido com seta + secundário em contorno), e prova social logo por baixo (avatares sobrepostos em círculo + estrelas + "500+ clientes") ou 3 micro-benefícios com ícone (entrega, qualidade, apoio).
- Composição visual do hero com profundidade: foto grande recortada (arco, círculo, cantos assimétricos) sobre uma forma de cor; 2 ou 3 cartões flutuantes por cima com sombra suave (uma métrica "+320%", uma avaliação "4,9 ★", uma etiqueta "Disponível", um preço "desde 900 MZN"); pequenos elementos decorativos (estrelas de 4 pontas, anéis, pontos, rabiscos em SVG).
- Faixa de confiança: logótipos ou nomes de clientes/parceiros em cinzento discreto, ou uma faixa escura com 4 números grandes (projectos, clientes, anos, satisfação) com ícones.
- Faixa em movimento: palavras-chave do negócio a deslizar continuamente, separadas por um símbolo (✦, ●, estrela), em fundo escuro ou na cor de destaque.
- Serviços: cartões com ícone em pastilha colorida, título, texto curto e "Saber mais →"; OU lista numerada (01., 02., 03.) em acordeão, com o item aberto em fundo escuro, etiquetas em pílula e uma imagem.
- Resultados/casos: cartões com imagem, etiqueta do sector e uma métrica enorme (+180%, 3x).
- Testemunhos: cartões com aspas grandes na cor de destaque, texto, foto redonda, nome, função e estrelas; em grelha de 3 ou carrossel com pontos.
- Preços: 3 colunas com o plano do meio destacado (fundo na cor principal, etiqueta "Popular", ligeiramente maior), lista de vantagens com visto, preço grande em MZN, botão em cada coluna.
- Perguntas frequentes: acordeão em 2 colunas, com + / − e transição suave.
- Chamada final: bloco largo com cantos muito arredondados na cor forte, título grande, frase e botão; pode ter uma foto a sair do bloco.
- Rodapé completo: logótipo e frase, 3 a 4 colunas de links, contactos, redes em ícones redondos, newsletter numa pílula (campo + botão com seta) e linha final com direitos e links legais; métodos de pagamento (M-Pesa, e-Mola, Visa) quando é uma loja.
- Detalhes que dão acabamento: etiquetas pequenas em pílula por cima dos títulos de secção ("— Os nossos serviços"), títulos de secção com um traço ou estrela decorativa, botões com ícone de seta dentro de um círculo, cartões que sobem 2-4px no hover, sombras longas e suaves, uma segunda cor usada com parcimónia.`;

const PADROES_TIPO = {
  'Portefólio': `
PADRÕES DE PORTEFÓLIO DE TOPO: hero centrado com "Olá, eu sou" + nome enorme (o apelido na cor de destaque, em itálico ou com rabisco), a profissão e a cidade; a foto da pessoa recortada sobre uma forma orgânica ou um círculo de cor (se houver foto), com selos flutuantes à volta ("150+ avaliações 4,9", "10 anos de experiência", "Disponível para projectos" com ponto verde a pulsar), pílulas com as competências, um botão circular com texto a rodar ("contrata-me • contrata-me •") e os ícones das redes; faixa preta com as competências em movimento; serviços em lista numerada em acordeão; números em cartões (anos, projectos, clientes, prémios) ou barras/anéis de percentagem; processo em passos numerados; ferramentas em grelha de ícones; testemunhos; chamada final "Vamos criar algo juntos".`,
  'Galeria': `
PADRÕES DE GALERIA DE TOPO: branco e silencioso, as fotos são as protagonistas; etiqueta em pílula ("As nossas histórias"), título gigante e frase curta alinhada à direita; mosaico "bento" de fotos com cantos arredondados, alturas diferentes e espaços finos e iguais (uma foto grande em 2 colunas, verticais ao lado); legendas discretas; secção de serviços ou pacotes com preços; testemunhos de clientes; chamada para marcar sessão. Cores tiradas das próprias fotos.`,
  'Landing Page': `
PADRÕES DE SITE DE NEGÓCIO DE TOPO: agência/serviços (hero com promessa + prova social + composição com cartões flutuantes, logótipos de clientes, serviços em cartões, faixa escura de números, resultados, testemunhos, preços com plano destacado, FAQ, chamada final); restaurante/comida (hero escuro com foto grande do prato, uma palavra em letra manuscrita na cor quente, botão "Encomendar agora", ícones de garantias - ingredientes frescos, entrega rápida, higiene - , menu popular em cartões com foto, preço e botão "Adicionar", faixa curva "Com fome? Nós entregamos"); app/produto digital (mockups de telemóvel desenhados em HTML/CSS com ecrãs do produto, funcionalidades em cartões, passos "como funciona").`,
  'E-commerce': `
PADRÕES DE LOJA DE TOPO (só no que tu desenhas - cabeçalho, faixas e rodapé): barra fina de anúncio no topo ("Entrega em todo o país", "Pagamento por M-Pesa e e-Mola"); cabeçalho com logótipo, menu, pesquisa ou ícone de pesquisa, conta e carrinho com contagem numa bolinha; depois da montra, faixa de 4 vantagens com ícones em pastilhas (entrega, devoluções, pagamento seguro, apoio por WhatsApp) e uma frase cada; faixa de comunidade/recompensas em fundo escuro ou na cor de destaque com botão; newsletter em pílula; rodapé de 4 colunas com métodos de pagamento.`,
  'Checkout': `
PADRÕES DE PÁGINA DE VENDA DE TOPO: cabeçalho mínimo; promessa forte; prova social (estrelas, número de clientes); a oferta; garantias com ícones (pagamento seguro, entrega, apoio); perguntas frequentes curtas; urgência honesta (stock ou prazo reais, nunca falsos).`,
  'Blog': `
PADRÕES DE BLOG DE TOPO: capa de revista com o artigo em destaque grande, categorias em pílulas, autor com foto redonda e uma frase, subscrição da newsletter numa caixa elegante, tipografia de leitura confortável (16-19px, linhas de 60-75 caracteres).`
};
function padroesDoTipo(tipo) {
  return PADROES_GERAIS + (PADROES_TIPO[tipo] || '');
}

function paginasMulti(html) { return /<meta\s+name=["']daniel-ia-paginas["']/i.test(String(html || '')); }
const INSTRUCAO_EDICAO_MULTI = `\nSITE COM VÁRIAS PÁGINAS: esta é uma das páginas do site. Mantém a estrutura <header data-dia="cabecalho">, <main data-dia="conteudo"> e <footer data-dia="rodape"> como filhos directos do <body>, os links do menu para as outras páginas (.html) e as <meta name="daniel-ia-..."> do <head>. O cabeçalho, o rodapé e o CSS do <head> são partilhados por todas as páginas: se o pedido for sobre o conteúdo desta página, muda só o <main>; se for sobre o cabeçalho, o rodapé, as cores ou as letras, a mudança passa sozinha para as outras páginas.`;
const QUIZ_JS = "/*\n  Daniel IA - quiz antes do checkout (1.60.0)\n  -------------------------------------------\n  Perguntas com pontos, uma de cada vez. No fim mostra a pontuação e o\n  resultado, e só então revela o checkout (se o dono assim quiser).\n  Servido em /quiz.js. Lê a configuração em /quiz-ler.\n  Usa as fichas --dia-* do próprio site; textos no idioma do <html lang>.\n*/\n(function(){\n  'use strict';\n  var CONTAINER_URL = '__SELF_URL__';\n  var SITE_ID = window.DANIEL_IA_SITE_ID || '';\n  if (!SITE_ID || window.__danielQuiz) return;\n  window.__danielQuiz = true;\n  var meta = document.querySelector('meta[name=\"daniel-ia-pagina\"]');\n  var pagina = meta ? (meta.getAttribute('content') || 'inicio') : 'inicio';\n  if (pagina !== 'inicio') return;\n  var LANG = (document.documentElement.lang || 'pt').slice(0, 2).toLowerCase();\n  var T = {\n    pt: { comecar: 'Começar', perguntas: '{n} perguntas', resultadoHora: 'resultado na hora', pergunta: 'Pergunta {a} de {b}', pts: 'pts', voltar: 'Voltar', quaseLa: 'Quase lá!', ondeMandar: 'Deixa o teu contacto para receberes o resultado e a oferta.', nome: 'O teu nome', contacto: 'WhatsApp ou email', verResultado: 'Ver o meu resultado', semContacto: 'Ver sem deixar contacto', faltaNome: 'Escreve o teu nome e um contacto.', calcular: 'A calcular o teu resultado...', pontuacao: 'A tua pontuação', verOferta: 'Ver a oferta', refazer: 'Refazer o quiz', bloqueado: 'A oferta aparece no fim do quiz.', jaFeito: 'Já fizeste o quiz', verResultadoDe: 'O teu resultado: {r}' },\n    en: { comecar: 'Start', perguntas: '{n} questions', resultadoHora: 'instant result', pergunta: 'Question {a} of {b}', pts: 'pts', voltar: 'Back', quaseLa: 'Almost there!', ondeMandar: 'Leave your contact to receive your result and the offer.', nome: 'Your name', contacto: 'WhatsApp or email', verResultado: 'See my result', semContacto: 'See it without leaving a contact', faltaNome: 'Write your name and a contact.', calcular: 'Calculating your result...', pontuacao: 'Your score', verOferta: 'See the offer', refazer: 'Take the quiz again', bloqueado: 'The offer appears at the end of the quiz.', jaFeito: 'You already took the quiz', verResultadoDe: 'Your result: {r}' },\n    fr: { comecar: 'Commencer', perguntas: '{n} questions', resultadoHora: 'résultat immédiat', pergunta: 'Question {a} sur {b}', pts: 'pts', voltar: 'Retour', quaseLa: 'Presque fini !', ondeMandar: 'Laissez votre contact pour recevoir votre résultat et l’offre.', nome: 'Votre nom', contacto: 'WhatsApp ou e-mail', verResultado: 'Voir mon résultat', semContacto: 'Voir sans laisser de contact', faltaNome: 'Écrivez votre nom et un contact.', calcular: 'Calcul de votre résultat...', pontuacao: 'Votre score', verOferta: 'Voir l’offre', refazer: 'Refaire le quiz', bloqueado: 'L’offre apparaît à la fin du quiz.', jaFeito: 'Vous avez déjà fait le quiz', verResultadoDe: 'Votre résultat : {r}' },\n    es: { comecar: 'Empezar', perguntas: '{n} preguntas', resultadoHora: 'resultado al instante', pergunta: 'Pregunta {a} de {b}', pts: 'pts', voltar: 'Volver', quaseLa: '¡Casi listo!', ondeMandar: 'Deja tu contacto para recibir tu resultado y la oferta.', nome: 'Tu nombre', contacto: 'WhatsApp o email', verResultado: 'Ver mi resultado', semContacto: 'Ver sin dejar contacto', faltaNome: 'Escribe tu nombre y un contacto.', calcular: 'Calculando tu resultado...', pontuacao: 'Tu puntuación', verOferta: 'Ver la oferta', refazer: 'Repetir el quiz', bloqueado: 'La oferta aparece al final del quiz.', jaFeito: 'Ya hiciste el quiz', verResultadoDe: 'Tu resultado: {r}' }\n  };\n  var L = T[LANG] || T.pt;\n  function tx(k, v){ var s = L[k] || T.pt[k] || k; if (v) Object.keys(v).forEach(function(n){ s = s.replace('{' + n + '}', v[n]); }); return s; }\n  function esc(t){ return String(t == null ? '' : t).replace(/[&<>\"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]; }); }\n  var CHAVE = 'daniel_ia_quiz_' + SITE_ID;\n  function lerFeito(){ try { var d = JSON.parse(localStorage.getItem(CHAVE) || 'null'); return d && Date.now() - d.t < 14 * 86400000 ? d : null; } catch (e) { return null; } }\n  function guardarFeito(d){ try { localStorage.setItem(CHAVE, JSON.stringify(d)); } catch (e) {} }\n\n  var CSS = ''\n    + 'html.dia-quiz-bloqueado #daniel-ia-produtos,html.dia-quiz-bloqueado [data-dia-depois-quiz]{display:none!important}'\n    + '.dq{--q-p:var(--dia-primaria,#111);--q-pt:var(--dia-primaria-texto,#fff);--q-f:var(--dia-fundo,#fff);--q-s:var(--dia-superficie,#f6f6f6);--q-t:var(--dia-texto,#111);--q-ts:var(--dia-texto-suave,#666);--q-b:var(--dia-borda,rgba(0,0,0,.1));--q-r:var(--dia-raio,16px);'\n    + 'max-width:720px;margin:clamp(20px,4vw,48px) auto;padding:0 16px;box-sizing:border-box;text-align:left;font-family:var(--dia-fonte-texto,inherit);color:var(--q-t)}'\n    + '.dq *{box-sizing:border-box}'\n    + '.dq-cartao{position:relative;background:var(--q-f);border:1px solid var(--q-b);border-radius:calc(var(--q-r) + 8px);padding:clamp(22px,4vw,40px);box-shadow:0 24px 60px -30px rgba(0,0,0,.35);overflow:hidden}'\n    + '.dq-cartao::before{content:\"\";position:absolute;inset:0 0 auto 0;height:5px;background:linear-gradient(90deg,var(--q-p),color-mix(in srgb,var(--q-p) 45%,#fff))}'\n    + '.dq-etiqueta{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;letter-spacing:.04em;padding:6px 12px;border-radius:999px;background:color-mix(in srgb,var(--q-p) 12%,transparent);color:var(--q-p)}'\n    + '.dq-etiqueta svg{width:14px;height:14px}'\n    + '.dq h2{font-family:var(--dia-fonte-titulos,inherit);font-size:clamp(26px,4.4vw,40px);line-height:1.08;letter-spacing:-.02em;margin:16px 0 10px}'\n    + '.dq h3{font-family:var(--dia-fonte-titulos,inherit);font-size:clamp(20px,3.2vw,28px);line-height:1.18;margin:18px 0 6px}'\n    + '.dq p{margin:0;color:var(--q-ts);font-size:16px;line-height:1.6}'\n    + '.dq-meta{display:flex;flex-wrap:wrap;gap:14px;margin:18px 0 26px;color:var(--q-ts);font-size:14px}.dq-meta span{display:inline-flex;align-items:center;gap:6px}.dq-meta svg{width:16px;height:16px;color:var(--q-p)}'\n    + '.dq-btn{appearance:none;border:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:52px;padding:0 26px;border-radius:999px;background:var(--q-p);color:var(--q-pt);font:700 16px/1 var(--dia-fonte-texto,inherit);transition:transform .15s,box-shadow .2s;box-shadow:0 12px 26px -12px color-mix(in srgb,var(--q-p) 70%,transparent)}'\n    + '.dq-btn:hover{transform:translateY(-1px)}.dq-btn:disabled{opacity:.55;cursor:default;transform:none}.dq-btn svg{width:18px;height:18px}'\n    + '.dq-ligacao{appearance:none;background:none;border:0;color:var(--q-ts);font:600 14px/1 var(--dia-fonte-texto,inherit);cursor:pointer;padding:10px 4px;display:inline-flex;align-items:center;gap:6px}.dq-ligacao:hover{color:var(--q-t)}.dq-ligacao svg{width:15px;height:15px}'\n    + '.dq-topo{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13.5px;font-weight:700;color:var(--q-ts)}'\n    + '.dq-pts{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:var(--q-s);color:var(--q-t);font-variant-numeric:tabular-nums}.dq-pts svg{width:14px;height:14px;color:var(--q-p)}'\n    + '.dq-barra{display:flex;gap:5px;margin-top:12px}.dq-barra i{flex:1;height:6px;border-radius:99px;background:var(--q-s);overflow:hidden;position:relative}.dq-barra i.feita::after,.dq-barra i.actual::after{content:\"\";position:absolute;inset:0;background:var(--q-p);border-radius:inherit}.dq-barra i.actual::after{opacity:.45}'\n    + '.dq-img{margin:16px 0 4px;border-radius:var(--q-r);overflow:hidden;aspect-ratio:16/8;background:var(--q-s)}.dq-img img{width:100%;height:100%;object-fit:cover;display:block}'\n    + '.dq-opcoes{display:grid;gap:10px;margin-top:20px}'\n    + '.dq-op{appearance:none;width:100%;text-align:left;display:flex;align-items:center;gap:14px;padding:14px 16px;min-height:58px;border-radius:var(--q-r);border:1.5px solid var(--q-b);background:var(--q-f);color:var(--q-t);font:600 16px/1.35 var(--dia-fonte-texto,inherit);cursor:pointer;transition:border-color .15s,background .15s,transform .12s}'\n    + '.dq-op:hover{border-color:color-mix(in srgb,var(--q-p) 60%,var(--q-b));transform:translateX(2px)}'\n    + '.dq-op b{flex:0 0 32px;height:32px;border-radius:10px;display:grid;place-items:center;background:var(--q-s);font-size:13px;color:var(--q-ts)}'\n    + '.dq-op.escolhida{border-color:var(--q-p);background:color-mix(in srgb,var(--q-p) 9%,var(--q-f))}.dq-op.escolhida b{background:var(--q-p);color:var(--q-pt)}'\n    + '.dq-mais{position:absolute;pointer-events:none;font:800 18px/1 var(--dia-fonte-titulos,inherit);color:var(--q-p);animation:dqSobe .9s ease-out forwards}'\n    + '@keyframes dqSobe{from{opacity:0;transform:translateY(6px)}20%{opacity:1}to{opacity:0;transform:translateY(-34px)}}'\n    + '.dq-ecra{animation:dqEntra .35s ease-out}@keyframes dqEntra{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}'\n    + '.dq-campos{display:grid;gap:10px;margin:20px 0 18px}.dq-campos input{width:100%;min-height:52px;padding:0 16px;border-radius:var(--q-r);border:1.5px solid var(--q-b);background:var(--q-f);color:var(--q-t);font:500 16px var(--dia-fonte-texto,inherit);outline:none}.dq-campos input:focus{border-color:var(--q-p)}'\n    + '.dq-erro{color:#C0392B;font-size:14px;font-weight:600;min-height:20px;margin-bottom:6px}'\n    + '.dq-calc{display:grid;place-items:center;text-align:center;padding:40px 0}.dq-calc i{width:46px;height:46px;border-radius:50%;border:4px solid var(--q-s);border-top-color:var(--q-p);animation:dqGira .8s linear infinite;margin-bottom:16px}@keyframes dqGira{to{transform:rotate(360deg)}}'\n    + '.dq-res{display:grid;grid-template-columns:auto 1fr;gap:clamp(18px,4vw,34px);align-items:center}'\n    + '.dq-anel{position:relative;width:clamp(130px,26vw,170px);aspect-ratio:1}.dq-anel svg{width:100%;height:100%;transform:rotate(-90deg)}.dq-anel circle{fill:none;stroke-width:10}.dq-anel .fundo{stroke:var(--q-s)}.dq-anel .valor{stroke:var(--q-p);stroke-linecap:round;transition:stroke-dashoffset 1.4s cubic-bezier(.2,.8,.2,1)}'\n    + '.dq-anel div{position:absolute;inset:0;display:grid;place-content:center;text-align:center}.dq-anel strong{font:800 clamp(30px,6vw,42px)/1 var(--dia-fonte-titulos,inherit);font-variant-numeric:tabular-nums}.dq-anel small{font-size:10px;color:var(--q-ts);margin:4px auto 0;text-transform:uppercase;letter-spacing:.05em;max-width:78%;line-height:1.25}'\n    + '.dq-res h3{margin-top:6px}.dq-accoes{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-top:20px}'\n    + '.dq-cadeado{display:flex;align-items:center;gap:10px;margin-top:22px;padding:12px 14px;border-radius:var(--q-r);background:var(--q-s);font-size:14px;color:var(--q-ts)}.dq-cadeado svg{width:18px;height:18px;flex:0 0 18px;color:var(--q-p)}'\n    + '.dq-feito{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 18px;border:1px solid var(--q-b);border-radius:calc(var(--q-r) + 4px);background:var(--q-f)}.dq-feito b{font-family:var(--dia-fonte-titulos,inherit)}'\n    + '@media (max-width:560px){.dq-res{grid-template-columns:1fr;justify-items:center;text-align:center}.dq-accoes{justify-content:center}.dq-btn{width:100%}}'\n    + '@media (prefers-reduced-motion:reduce){.dq-ecra,.dq-mais{animation:none}.dq-anel .valor{transition:none}}';\n  var IC = {\n    relogio: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3 2\"/></svg>',\n    lista: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M9 6h11M9 12h11M9 18h11\"/><path d=\"M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2\"/></svg>',\n    seta: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5 12h14M13 6l6 6-6 6\"/></svg>',\n    voltar: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M19 12H5M11 18l-6-6 6-6\"/></svg>',\n    estrela: '<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z\"/></svg>',\n    cadeado: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><rect x=\"4\" y=\"11\" width=\"16\" height=\"10\" rx=\"2\"/><path d=\"M8 11V7a4 4 0 0 1 8 0v4\"/></svg>',\n    brilho: '<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z\"/></svg>'\n  };\n\n  var Q = null, raiz = null, cartao = null;\n  var idx = 0, respostas = [], pontos = 0, nome = '', contacto = '';\n  function maxPontos(){ return Q.perguntas.reduce(function(s, p){ return s + Math.max.apply(null, p.opcoes.map(function(o){ return o.pontos; }).concat([0])); }, 0); }\n  function resultadoDe(pts){\n    var r = null;\n    (Q.resultados || []).forEach(function(x){ if (pts >= x.min) r = x; });\n    return r || (Q.resultados || [])[0] || { titulo: '', texto: '', botao: '' };\n  }\n  function ecra(html){ cartao.innerHTML = '<div class=\"dq-ecra\">' + html + '</div>'; }\n\n  function intro(){\n    ecra('<span class=\"dq-etiqueta\">' + IC.brilho + esc(Q.etiqueta || 'Quiz') + '</span>'\n      + '<h2>' + esc(Q.titulo) + '</h2>' + (Q.subtitulo ? '<p>' + esc(Q.subtitulo) + '</p>' : '')\n      + '<div class=\"dq-meta\"><span>' + IC.lista + esc(tx('perguntas', { n: Q.perguntas.length })) + '</span><span>' + IC.relogio + esc(tx('resultadoHora')) + '</span></div>'\n      + '<button class=\"dq-btn\" data-q=\"iniciar\">' + esc(Q.botao_iniciar || tx('comecar')) + IC.seta + '</button>'\n      + (Q.bloquear ? '<div class=\"dq-cadeado\">' + IC.cadeado + '<span>' + esc(tx('bloqueado')) + '</span></div>' : ''));\n    cartao.querySelector('[data-q=\"iniciar\"]').addEventListener('click', function(){ idx = 0; respostas = []; pontos = 0; pergunta(); });\n  }\n  function pergunta(){\n    var p = Q.perguntas[idx], letras = 'ABCDEF';\n    var barra = Q.perguntas.map(function(_, i){ return '<i class=\"' + (i < idx ? 'feita' : (i === idx ? 'actual' : '')) + '\"></i>'; }).join('');\n    ecra('<div class=\"dq-topo\"><span>' + esc(tx('pergunta', { a: idx + 1, b: Q.perguntas.length })) + '</span>'\n      + (Q.mostrar_pontos ? '<span class=\"dq-pts\">' + IC.estrela + '<span data-q=\"pts\">' + pontos + '</span> ' + esc(tx('pts')) + '</span>' : '') + '</div>'\n      + '<div class=\"dq-barra\">' + barra + '</div>'\n      + (p.imagem ? '<div class=\"dq-img\"><img src=\"' + esc(p.imagem) + '\" alt=\"\"></div>' : '')\n      + '<h3>' + esc(p.texto) + '</h3>' + (p.ajuda ? '<p>' + esc(p.ajuda) + '</p>' : '')\n      + '<div class=\"dq-opcoes\">' + p.opcoes.map(function(o, i){ return '<button class=\"dq-op\" data-op=\"' + i + '\"><b>' + letras[i] + '</b><span>' + esc(o.texto) + '</span></button>'; }).join('') + '</div>'\n      + (idx > 0 ? '<div style=\"margin-top:14px\"><button class=\"dq-ligacao\" data-q=\"voltar\">' + IC.voltar + esc(tx('voltar')) + '</button></div>' : ''));\n    var ocupado = false;\n    Array.prototype.forEach.call(cartao.querySelectorAll('.dq-op'), function(b){\n      b.addEventListener('click', function(){\n        if (ocupado) return; ocupado = true;\n        var o = p.opcoes[Number(b.getAttribute('data-op'))];\n        b.classList.add('escolhida');\n        respostas[idx] = Number(b.getAttribute('data-op'));\n        pontos += o.pontos;\n        if (Q.mostrar_pontos && o.pontos > 0) {\n          var m = document.createElement('span'); m.className = 'dq-mais'; m.textContent = '+' + o.pontos;\n          var rc = b.getBoundingClientRect(), rr = cartao.getBoundingClientRect();\n          m.style.left = (rc.right - rr.left - 56) + 'px'; m.style.top = (rc.top - rr.top + 10) + 'px';\n          cartao.appendChild(m);\n          var el = cartao.querySelector('[data-q=\"pts\"]'); if (el) el.textContent = pontos;\n        }\n        setTimeout(function(){\n          idx++;\n          if (idx < Q.perguntas.length) pergunta();\n          else if (Q.captar !== 'nao') captura();\n          else calcular();\n        }, 520);\n      });\n    });\n    var v = cartao.querySelector('[data-q=\"voltar\"]');\n    if (v) v.addEventListener('click', function(){\n      idx--;\n      var ant = Q.perguntas[idx].opcoes[respostas[idx]];\n      if (ant) pontos -= ant.pontos;\n      respostas.length = idx;\n      pergunta();\n    });\n  }\n  function captura(){\n    ecra('<span class=\"dq-etiqueta\">' + IC.brilho + esc(tx('quaseLa')) + '</span><h3>' + esc(tx('ondeMandar')) + '</h3>'\n      + '<div class=\"dq-campos\"><input type=\"text\" maxlength=\"80\" autocomplete=\"name\" placeholder=\"' + esc(tx('nome')) + '\" data-q=\"nome\">'\n      + '<input type=\"text\" maxlength=\"120\" autocomplete=\"tel\" placeholder=\"' + esc(tx('contacto')) + '\" data-q=\"contacto\"></div>'\n      + '<div class=\"dq-erro\" data-q=\"erro\"></div>'\n      + '<div class=\"dq-accoes\" style=\"margin-top:0\"><button class=\"dq-btn\" data-q=\"ver\">' + esc(tx('verResultado')) + IC.seta + '</button>'\n      + (Q.captar === 'opcional' ? '<button class=\"dq-ligacao\" data-q=\"saltar\">' + esc(tx('semContacto')) + '</button>' : '') + '</div>');\n    var iN = cartao.querySelector('[data-q=\"nome\"]'), iC = cartao.querySelector('[data-q=\"contacto\"]');\n    iN.focus();\n    cartao.querySelector('[data-q=\"ver\"]').addEventListener('click', function(){\n      nome = iN.value.trim(); contacto = iC.value.trim();\n      if (nome.length < 2 || contacto.length < 6) { cartao.querySelector('[data-q=\"erro\"]').textContent = tx('faltaNome'); return; }\n      calcular();\n    });\n    var s = cartao.querySelector('[data-q=\"saltar\"]');\n    if (s) s.addEventListener('click', function(){ nome = ''; contacto = ''; calcular(); });\n  }\n  function enviar(){\n    try {\n      fetch(CONTAINER_URL + '/quiz-responder', { method: 'POST', headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ site_id: SITE_ID, respostas: respostas, nome: nome, contacto: contacto }) }).catch(function(){});\n    } catch (e) {}\n  }\n  function calcular(){\n    enviar();\n    ecra('<div class=\"dq-calc\"><i></i><p>' + esc(tx('calcular')) + '</p></div>');\n    setTimeout(resultado, 1300);\n  }\n  function resultado(){\n    var max = Math.max(1, maxPontos());\n    var r = resultadoDe(pontos);\n    guardarFeito({ t: Date.now(), pontos: pontos, titulo: r.titulo });\n    var C = 2 * Math.PI * 54, pct = Math.max(0, Math.min(1, pontos / max));\n    ecra('<div class=\"dq-res\"><div class=\"dq-anel\"><svg viewBox=\"0 0 120 120\"><circle class=\"fundo\" cx=\"60\" cy=\"60\" r=\"54\"/><circle class=\"valor\" cx=\"60\" cy=\"60\" r=\"54\" stroke-dasharray=\"' + C.toFixed(1) + '\" stroke-dashoffset=\"' + C.toFixed(1) + '\"/></svg>'\n      + '<div><strong data-q=\"num\">0</strong><small>' + esc(tx('pontuacao')) + '</small></div></div>'\n      + '<div><span class=\"dq-etiqueta\">' + IC.brilho + esc(Q.etiqueta || 'Quiz') + '</span><h3>' + esc(r.titulo) + '</h3>' + (r.texto ? '<p>' + esc(r.texto) + '</p>' : '')\n      + '<div class=\"dq-accoes\"><button class=\"dq-btn\" data-q=\"oferta\">' + esc(r.botao || Q.cta || tx('verOferta')) + IC.seta + '</button><button class=\"dq-ligacao\" data-q=\"refazer\">' + esc(tx('refazer')) + '</button></div></div></div>');\n    var anel = cartao.querySelector('.valor');\n    requestAnimationFrame(function(){ requestAnimationFrame(function(){ anel.style.strokeDashoffset = (C * (1 - pct)).toFixed(1); }); });\n    var num = cartao.querySelector('[data-q=\"num\"]'), t0 = null;\n    function contar(t){ if (!t0) t0 = t; var k = Math.min(1, (t - t0) / 1200); num.textContent = Math.round(pontos * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(contar); }\n    requestAnimationFrame(contar);\n    desbloquear(false);\n    cartao.querySelector('[data-q=\"oferta\"]').addEventListener('click', function(){ desbloquear(true); });\n    cartao.querySelector('[data-q=\"refazer\"]').addEventListener('click', function(){ idx = 0; respostas = []; pontos = 0; pergunta(); });\n  }\n  function desbloquear(rolar){\n    document.documentElement.classList.remove('dia-quiz-bloqueado');\n    if (!rolar) return;\n    var alvo = document.getElementById('daniel-ia-produtos') || document.querySelector('[data-dia-depois-quiz]');\n    if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });\n  }\n  function jaFeito(d){\n    ecra('<div class=\"dq-feito\"><div><small style=\"color:var(--q-ts)\">' + esc(tx('jaFeito')) + '</small><br><b>' + esc(tx('verResultadoDe', { r: d.titulo || (d.pontos + ' ' + tx('pts')) })) + '</b></div>'\n      + '<div class=\"dq-accoes\" style=\"margin-top:0\"><button class=\"dq-btn\" data-q=\"oferta\">' + esc(Q.cta || tx('verOferta')) + IC.seta + '</button><button class=\"dq-ligacao\" data-q=\"refazer\">' + esc(tx('refazer')) + '</button></div></div>');\n    cartao.classList.add('dq-cartao-feito');\n    cartao.querySelector('[data-q=\"oferta\"]').addEventListener('click', function(){ desbloquear(true); });\n    cartao.querySelector('[data-q=\"refazer\"]').addEventListener('click', function(){ cartao.classList.remove('dq-cartao-feito'); intro(); });\n  }\n\n  function arrancar(){\n    raiz = document.getElementById('daniel-ia-quiz');\n    if (!raiz) {\n      var loja = document.getElementById('daniel-ia-produtos');\n      if (!loja) return;\n      raiz = document.createElement('div');\n      raiz.id = 'daniel-ia-quiz';\n      loja.parentNode.insertBefore(raiz, loja);\n    }\n    var previa = /[?&]dia_previa=1/.test(location.search) || /\\/v\\d+\\.html$/.test(location.pathname);\n    fetch(CONTAINER_URL + '/quiz-ler', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site_id: SITE_ID, previa: previa }) })\n      .then(function(r){ return r.json(); })\n      .then(function(r){\n        Q = r && r.status === 'success' && r.response && r.response.quiz;\n        if (!Q || !Q.ativo || !Q.perguntas || !Q.perguntas.length) { raiz.style.display = 'none'; return; }\n        var st = document.createElement('style'); st.setAttribute('data-daniel-ia', 'quiz'); st.textContent = CSS; document.head.appendChild(st);\n        raiz.innerHTML = '<section class=\"dq\"><div class=\"dq-cartao\"></div></section>';\n        cartao = raiz.querySelector('.dq-cartao');\n        var feito = lerFeito();\n        if (Q.bloquear && !feito) document.documentElement.classList.add('dia-quiz-bloqueado');\n        if (feito) jaFeito(feito); else intro();\n      })\n      .catch(function(){ raiz.style.display = 'none'; });\n  }\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar); else arrancar();\n})();\n".replace('__SELF_URL__', SELF_URL);

// ======================================================
// 1.60.0 - Sites com várias páginas, fotografias reais e editor visual
// ------------------------------------------------------
// Antes, cada site era uma página única. Agora:
//   - antes de desenhar, a IA planeia as páginas do site (Início, Sobre,
//     Serviços, Contacto, Loja, Produto...) e escolhe as fotografias;
//   - as fotos vêm do Pexels (grátis) e, quando falta alguma, são geradas
//     pela IA de imagens da OpenAI;
//   - as 3 versões do estúdio desenham só a página inicial, já com o menu
//     a apontar para as outras páginas;
//   - quando a pessoa escolhe uma versão, as outras páginas são criadas em
//     fundo a partir da inicial: o cabeçalho, o rodapé e o CSS são sempre
//     os da inicial ("casca"); cada página só tem o seu <main> próprio;
//   - o conteúdo de cada página fica guardado em _paginas.json, na pasta
//     do site, para as páginas poderem ser montadas outra vez sempre que
//     a inicial muda (edição com IA, editor visual, outro layout).
// ======================================================
const PEXELS_API_KEY = clean(process.env.PEXELS_API_KEY);
// Pixabay: alternativa grátis ao Pexels (o Pexels pausou as chaves novas).
const PIXABAY_API_KEY = clean(process.env.PIXABAY_API_KEY);
const FOTOS_IA = (clean(process.env.FOTOS_IA) || 'sim').toLowerCase() !== 'nao';
const OPENAI_IMAGE_MODEL = clean(process.env.OPENAI_IMAGE_MODEL) || 'gpt-image-1';
const FOTOS_IA_MAX = Math.max(0, parseInt(clean(process.env.FOTOS_IA_MAX), 10) || 3);
const TOKENS_POR_FOTO_IA = Math.max(0, parseInt(clean(process.env.TOKENS_POR_FOTO_IA), 10) || 3000);
const PAGINAS_IA_MAX_FREE = 3;
const PAGINAS_IA_MAX = 6;

const PAGINAS_CATALOGO = {
  inicio: {}, loja: { modulo: 'loja' }, produto: { modulo: 'produto', menu: false },
  trabalhos: { modulo: 'portfolio' }, albuns: { modulo: 'galeria' }, artigos: { modulo: 'blog' },
  sobre: {}, servicos: {}, precos: {}, menu: {}, reservas: {}, galeria: {}, equipa: {}, perguntas: {}, processo: {}, testemunhos: {},
  contacto: { modulo: 'contacto' }
};
const NOMES_PAGINAS = {
  inicio: { pt: ['Início', 'Início'], en: ['Home', 'Home'], fr: ['Accueil', 'Accueil'], es: ['Inicio', 'Inicio'] },
  loja: { pt: ['Loja', 'Loja'], en: ['Shop', 'Shop'], fr: ['Boutique', 'Boutique'], es: ['Tienda', 'Tienda'] },
  produto: { pt: ['Produto', 'Produto'], en: ['Product', 'Product'], fr: ['Produit', 'Produit'], es: ['Producto', 'Producto'] },
  trabalhos: { pt: ['Trabalhos', 'Trabalhos'], en: ['Work', 'Work'], fr: ['Réalisations', 'Réalisations'], es: ['Trabajos', 'Trabajos'] },
  albuns: { pt: ['Álbuns', 'Álbuns'], en: ['Albums', 'Albums'], fr: ['Albums', 'Albums'], es: ['Álbumes', 'Álbumes'] },
  artigos: { pt: ['Artigos', 'Artigos'], en: ['Articles', 'Articles'], fr: ['Articles', 'Articles'], es: ['Artículos', 'Artículos'] },
  sobre: { pt: ['Sobre', 'Sobre nós'], en: ['About', 'About us'], fr: ['À propos', 'À propos'], es: ['Nosotros', 'Sobre nosotros'] },
  servicos: { pt: ['Serviços', 'Serviços'], en: ['Services', 'Services'], fr: ['Services', 'Services'], es: ['Servicios', 'Servicios'] },
  precos: { pt: ['Preços', 'Preços'], en: ['Pricing', 'Pricing'], fr: ['Tarifs', 'Tarifs'], es: ['Precios', 'Precios'] },
  menu: { pt: ['Menu', 'Menu'], en: ['Menu', 'Menu'], fr: ['Carte', 'La carte'], es: ['Menú', 'Menú'] },
  reservas: { pt: ['Reservas', 'Reservas'], en: ['Bookings', 'Bookings'], fr: ['Réservations', 'Réservations'], es: ['Reservas', 'Reservas'] },
  galeria: { pt: ['Galeria', 'Galeria'], en: ['Gallery', 'Gallery'], fr: ['Galerie', 'Galerie'], es: ['Galería', 'Galería'] },
  equipa: { pt: ['Equipa', 'A nossa equipa'], en: ['Team', 'Our team'], fr: ['Équipe', 'Notre équipe'], es: ['Equipo', 'Nuestro equipo'] },
  perguntas: { pt: ['Perguntas', 'Perguntas frequentes'], en: ['FAQ', 'Frequently asked questions'], fr: ['FAQ', 'Questions fréquentes'], es: ['Preguntas', 'Preguntas frecuentes'] },
  processo: { pt: ['Como funciona', 'Como funciona'], en: ['How it works', 'How it works'], fr: ['Comment ça marche', 'Comment ça marche'], es: ['Cómo funciona', 'Cómo funciona'] },
  testemunhos: { pt: ['Clientes', 'O que dizem os clientes'], en: ['Reviews', 'What our clients say'], fr: ['Avis', 'Ce que disent nos clients'], es: ['Opiniones', 'Lo que dicen los clientes'] },
  contacto: { pt: ['Contacto', 'Contacto'], en: ['Contact', 'Contact'], fr: ['Contact', 'Contact'], es: ['Contacto', 'Contacto'] }
};
const RESUMOS_PAGINAS = {
  inicio: 'a montra do site: o que o negócio faz, os destaques de cada página e as chamadas para acção',
  loja: 'todos os produtos, com filtros por categoria, preço e avaliação',
  produto: 'a página de cada produto',
  trabalhos: 'todos os trabalhos e projectos',
  albuns: 'todos os álbuns de fotos e vídeos',
  artigos: 'todos os artigos do blog',
  sobre: 'a história, a missão, os valores, os números e o que torna o negócio diferente',
  servicos: 'cada serviço em detalhe, com benefícios, para quem é e como funciona',
  precos: 'os planos ou pacotes com preços em MZN, o que inclui cada um e perguntas sobre pagamento',
  menu: 'o menu completo por categorias, com pratos, descrições curtas e preços em MZN',
  reservas: 'como reservar, horários, condições e chamada para reservar por WhatsApp ou contacto',
  galeria: 'uma galeria de imagens do espaço, dos trabalhos ou dos produtos',
  equipa: 'as pessoas da equipa, com funções e uma frase de cada',
  perguntas: 'as perguntas frequentes em acordeão, agrupadas por tema',
  processo: 'como funciona passo a passo (do primeiro contacto à entrega), prazos, o que a pessoa recebe e garantias',
  testemunhos: 'depoimentos de clientes por tipo de serviço ou produto, resultados, números e uma chamada para acção',
  contacto: 'os contactos (telefone, WhatsApp, email, morada, horário), um mapa desenhado e o formulário'
};
const PAGINAS_TIPO = {
  'E-commerce': { fixas: ['inicio', 'loja', 'produto', 'sobre', 'contacto'], opcionais: ['processo', 'perguntas', 'testemunhos'] },
  // Página de venda (1.60.0): também com várias páginas; a oferta fica na inicial.
  'Checkout': { fixas: ['inicio', 'sobre', 'perguntas', 'contacto'], opcionais: ['processo', 'testemunhos', 'servicos', 'equipa'] },
  'Landing Page': { fixas: ['inicio', 'sobre', 'contacto'], opcionais: ['servicos', 'processo', 'precos', 'menu', 'reservas', 'galeria', 'equipa', 'testemunhos', 'perguntas'] },
  'Portefólio': { fixas: ['inicio', 'trabalhos', 'sobre', 'contacto'], opcionais: ['servicos', 'processo', 'precos', 'testemunhos'] },
  'Galeria': { fixas: ['inicio', 'albuns', 'sobre', 'contacto'], opcionais: ['servicos', 'precos', 'processo', 'testemunhos'] },
  'Blog': { fixas: ['inicio', 'artigos', 'sobre', 'contacto'], opcionais: ['servicos', 'perguntas'] }
};
function ficheiroDaPagina(slug) { return slug === 'inicio' ? 'index.html' : slug + '.html'; }
function paginaBase(slug, idioma) {
  const nomes = (NOMES_PAGINAS[slug] || NOMES_PAGINAS.sobre)[normalizarIdioma(idioma)];
  const cat = PAGINAS_CATALOGO[slug] || {};
  return {
    slug, ficheiro: ficheiroDaPagina(slug), nav: nomes[0], titulo: nomes[1], subtitulo: '',
    resumo: RESUMOS_PAGINAS[slug] || '', modulo: cat.modulo || '', menu: cat.menu !== false,
    ia: slug !== 'inicio' && (!cat.modulo || cat.modulo === 'contacto')
  };
}
function siteMultiPagina(site) {
  const e = lerJsonSeguro(site && site['Variantes Json'], null);
  return !!(e && Array.isArray(e.plano_paginas) && e.plano_paginas.length > 1);
}
function planoDoSite(site) {
  const e = lerJsonSeguro(site && site['Variantes Json'], null);
  return (e && Array.isArray(e.plano_paginas)) ? e.plano_paginas : [];
}

// Chamada à IA que devolve JSON e os tokens gastos.
async function chamarJsonIA(sistema, conteudo, maxTokens) {
  if (!OPENAI_API_KEY) throw new Error('Sem OPENAI_API_KEY');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL_RAPIDO || OPENAI_MODEL,
      reasoning_effort: 'low',
      max_completion_tokens: maxTokens || 6000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sistema }, { role: 'user', content: conteudo }]
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error('OpenAI falhou: ' + ((json.error && json.error.message) || res.status));
  const texto = String((json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '').trim();
  const m = texto.match(/\{[\s\S]*\}/);
  return { dados: JSON.parse(m ? m[0] : texto), tokens: (json.usage && json.usage.total_tokens) || 0 };
}

// ---- Plano do site: páginas e fotografias ----
const SISTEMA_PLANO = 'És arquitecto de informação e director de arte de sites profissionais. '
  + 'Planeias as páginas de um site e as fotografias de que ele precisa. Respondes só com um objecto JSON válido.';
function limparPlanoPaginas(dados, tipo, idioma, pago) {
  const regras = PAGINAS_TIPO[tipo] || PAGINAS_TIPO['Landing Page'];
  const maxIA = pago ? PAGINAS_IA_MAX : PAGINAS_IA_MAX_FREE;
  const pedidas = (dados && Array.isArray(dados.paginas) ? dados.paginas : []).filter(p => p && typeof p === 'object');
  const porSlug = {};
  pedidas.forEach(p => { const s = String(p.slug || '').toLowerCase().trim(); if (PAGINAS_CATALOGO[s] && !porSlug[s]) porSlug[s] = p; });
  let slugs = regras.fixas.slice();
  regras.opcionais.forEach(s => { if (porSlug[s]) slugs.splice(slugs.indexOf('contacto') >= 0 ? slugs.indexOf('contacto') : slugs.length, 0, s); });
  // Respeita a ordem que a IA propôs para as opcionais (o contacto fica sempre no fim).
  const ordemIA = pedidas.map(p => String(p.slug || '').toLowerCase());
  const fixas = slugs.filter(s => regras.fixas.includes(s));
  const opc = slugs.filter(s => !regras.fixas.includes(s)).sort((a, b) => ordemIA.indexOf(a) - ordemIA.indexOf(b));
  slugs = fixas.filter(s => s !== 'contacto').concat(opc).concat(fixas.includes('contacto') ? ['contacto'] : []);
  // Limite de páginas escritas pela IA (o contacto conta e fica sempre).
  let contaIA = 0;
  slugs = slugs.filter(s => {
    const b = paginaBase(s, idioma);
    if (!b.ia) return true;
    if (s === 'contacto') return true;
    const limite = maxIA - (slugs.includes('contacto') ? 1 : 0);
    if (contaIA < limite) { contaIA++; return true; }
    return false;
  });
  return slugs.map(s => {
    const b = paginaBase(s, idioma);
    const p = porSlug[s] || {};
    const nav = textoCurto(p.nav, 22);
    const titulo = textoCurto(p.titulo, 60);
    return Object.assign(b, {
      nav: nav || b.nav,
      titulo: titulo || b.titulo,
      subtitulo: textoCurto(p.subtitulo, 140),
      resumo: textoCurto(p.resumo, 400) || b.resumo
    });
  });
}
function limparPedidosFotos(dados, tipo) {
  const lista = (dados && Array.isArray(dados.fotos) ? dados.fotos : []).filter(f => f && f.consulta);
  const max = (tipo === 'E-commerce' || tipo === 'Checkout') ? 3 : 6;
  return lista.slice(0, max).map((f, i) => ({
    uso: textoCurto(f.uso, 40).toLowerCase().replace(/[^a-z0-9à-ú-]+/gi, '-') || ('foto-' + (i + 1)),
    consulta: textoCurto(f.consulta, 100),
    descricao: textoCurto(f.descricao, 220),
    orientacao: ['paisagem', 'retrato', 'quadrada'].includes(f.orientacao) ? f.orientacao : 'paisagem'
  }));
}
async function planearSite({ tipo, nome, prompt, idioma, pago, comFotos, umaPagina }) {
  const regras = PAGINAS_TIPO[tipo] || PAGINAS_TIPO['Landing Page'];
  const lingua = normalizarIdioma(idioma);
  const pedido = [
    `Negócio: ${nome}. Tipo de site: ${tipo}. Idioma do site: ${IDIOMAS_SITE[lingua].nome}.`,
    `Descrição pedida pela pessoa: ${textoCurto(prompt, 1500)}`,
    umaPagina ? 'A pessoa escolheu um site de UMA página só: devolve "paginas": [{"slug":"inicio"}].' : `Páginas obrigatórias: ${regras.fixas.join(', ')}. Opcionais: ${regras.opcionais.join(', ') || 'nenhuma'}. O site deve ser RICO e completo: escolhe sempre pelo menos 2 opcionais que sirvam ESTE negócio (até ${(pago ? PAGINAS_IA_MAX : PAGINAS_IA_MAX_FREE)} páginas de conteúdo no total, contando com as obrigatórias que não são da loja, dos trabalhos, dos álbuns ou dos artigos).`,
    'Ex: um restaurante quer "menu" e "reservas"; uma agência quer "servicos" e "precos"; uma clínica quer "servicos" e "equipa".',
    'Para cada página: "nav" (1 ou 2 palavras para o menu), "titulo" (título da página), "subtitulo" (uma frase curta) e "resumo" (em português: que secções e conteúdos leva, concretos para este negócio). Os textos "nav", "titulo" e "subtitulo" são no idioma do site.',
    comFotos ? `Fotografias: 3 a ${(tipo === 'E-commerce' || tipo === 'Checkout') ? 3 : 6} fotos reais de que o site precisa (capa, sobre, serviços, ambiente...). Para cada uma: "uso" (onde entra, ex: capa, sobre, servico-1), "consulta" (3 a 6 palavras em INGLÊS para procurar num banco de fotos, concretas e visuais, ex: "african woman baker kneading bread"; quando houver pessoas, prefere pessoas africanas/moçambicanas; nunca marcas), "descricao" (em português, a foto ideal, para gerar com IA se não houver) e "orientacao" (paisagem, retrato ou quadrada).` : 'Fotografias: devolve "fotos": [].',
    tipo === 'E-commerce' ? 'Estilos de loja: em "temas", escolhe os 3 estilos (ids diferentes) que melhor servem ESTE negócio, do melhor para o menos bom. Os estilos de nicho (fresco = mercearia/supermercado, sabor = restaurante/comida) só se o negócio for mesmo desse ramo:\n' + TEMAS_LOJA.map(t => '- ' + t.id + ': ' + t.resumo).join('\n') : '',
    'Formato exacto: {"paginas":[{"slug":"sobre","nav":"...","titulo":"...","subtitulo":"...","resumo":"..."}],"fotos":[{"uso":"capa","consulta":"...","descricao":"...","orientacao":"paisagem"}]' + (tipo === 'E-commerce' ? ',"temas":["id1","id2","id3"]' : '') + '}'
  ].filter(Boolean).join('\n');
  try {
    const r = await chamarJsonIA(SISTEMA_PLANO, pedido, 5000);
    const temas = (r.dados && Array.isArray(r.dados.temas) ? r.dados.temas : []).map(x => String(x || '').toLowerCase().trim()).filter((x, i, a) => TEMAS_LOJA.some(t => t.id === x) && a.indexOf(x) === i).slice(0, 3);
    return { paginas: umaPagina ? [paginaBase('inicio', lingua)] : limparPlanoPaginas(r.dados, tipo, lingua, pago), fotos: comFotos ? limparPedidosFotos(r.dados, tipo) : [], temas: tipo === 'E-commerce' ? temas : [], tokens: r.tokens };
  } catch (erro) {
    console.error('Plano do site falhou (sigo com as páginas base):', erro.message || erro);
    const consulta = String(prompt || nome || '').split(/\s+/).slice(0, 6).join(' ');
    return {
      paginas: umaPagina ? [paginaBase('inicio', lingua)] : limparPlanoPaginas({}, tipo, lingua, pago),
      fotos: comFotos && consulta ? [{ uso: 'capa', consulta, descricao: consulta, orientacao: 'paisagem', locale: 'pt-BR' }, { uso: 'sobre', consulta, descricao: consulta, orientacao: 'paisagem', locale: 'pt-BR' }] : [],
      tokens: 0
    };
  }
}

// ---- Fotografias: Pexels primeiro, IA de imagens quando falta ----
async function procurarFotoPexels(consulta, orientacao, usados, locale) {
  if (!PEXELS_API_KEY || !consulta) return null;
  const params = new URLSearchParams({ query: consulta, per_page: '10', orientation: { paisagem: 'landscape', retrato: 'portrait', quadrada: 'square' }[orientacao] || 'landscape' });
  if (locale) params.set('locale', locale);
  const r = await fetch('https://api.pexels.com/v1/search?' + params.toString(), { headers: { Authorization: PEXELS_API_KEY }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('Pexels respondeu ' + r.status);
  const j = await r.json();
  const lista = (j.photos || []).filter(f => f && f.src && !usados.has(f.id));
  if (!lista.length) return null;
  const f = lista[Math.floor(Math.random() * Math.min(3, lista.length))];
  usados.add(f.id);
  return { url: f.src.large2x || f.src.large || f.src.original, credito: f.photographer || '', id: f.id };
}
// Pixabay: as respostas ficam guardadas 24 h (regra da API) e as fotos são
// sempre copiadas para o Bunny (a Pixabay não deixa usar os links deles).
const cachePixabay = new Map();
async function procurarFotoPixabay(consulta, orientacao, usados) {
  if (!PIXABAY_API_KEY || !consulta) return null;
  const params = new URLSearchParams({
    key: PIXABAY_API_KEY, q: String(consulta).slice(0, 100), image_type: 'photo', safesearch: 'true', per_page: '20',
    orientation: { paisagem: 'horizontal', retrato: 'vertical' }[orientacao] || 'all', min_width: '1000'
  });
  const chave = params.toString();
  let hits;
  const guardado = cachePixabay.get(chave);
  if (guardado && Date.now() - guardado.em < 24 * 3600 * 1000) hits = guardado.hits;
  else {
    const r = await fetch('https://pixabay.com/api/?' + chave, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('Pixabay respondeu ' + r.status);
    const j = await r.json();
    hits = Array.isArray(j.hits) ? j.hits : [];
    if (cachePixabay.size > 500) cachePixabay.clear();
    cachePixabay.set(chave, { em: Date.now(), hits });
  }
  const lista = hits.filter(f => f && f.largeImageURL && !usados.has('pb' + f.id));
  if (!lista.length) return null;
  const f = lista[Math.floor(Math.random() * Math.min(3, lista.length))];
  usados.add('pb' + f.id);
  return { url: f.largeImageURL, credito: f.user || '', id: f.id };
}
async function gerarFotoIA(descricao, orientacao) {
  if (!FOTOS_IA || !OPENAI_API_KEY || !descricao) return null;
  const size = orientacao === 'retrato' ? '1024x1536' : orientacao === 'quadrada' ? '1024x1024' : '1536x1024';
  const corpo = { model: OPENAI_IMAGE_MODEL, prompt: descricao + '. Fotografia profissional e realista, luz natural bonita, composição limpa, sem texto, sem letras, sem logótipos, sem marcas de água.', size, quality: 'medium', n: 1, output_format: 'jpeg', output_compression: 85 };
  async function pedir(c) {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST', signal: AbortSignal.timeout(150000),
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(c)
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, j };
  }
  let { ok, j } = await pedir(corpo);
  if (!ok && /output_(format|compression)/i.test(JSON.stringify(j))) {
    delete corpo.output_format; delete corpo.output_compression;
    ({ ok, j } = await pedir(corpo));
  }
  if (!ok) throw new Error('Imagem IA falhou: ' + ((j.error && j.error.message) || 'erro'));
  const d = j.data && j.data[0];
  if (d && d.b64_json) return { buffer: Buffer.from(d.b64_json, 'base64'), mime: corpo.output_format ? 'image/jpeg' : 'image/png' };
  if (d && d.url) {
    const rr = await fetch(d.url, { signal: AbortSignal.timeout(30000) });
    if (rr.ok) return { buffer: Buffer.from(await rr.arrayBuffer()), mime: rr.headers.get('content-type') || 'image/png' };
  }
  return null;
}
// Prepara as fotos e sobe-as para a pasta do site. Nunca falha a geração:
// o que não ficar pronto em 80 segundos fica de fora.
async function prepararFotos({ owner, slug, pedidos }) {
  if (!pedidos || !pedidos.length) return { fotos: [], tokens: 0 };
  const usados = new Set();
  const prontas = [];
  let iaUsadas = 0, tokens = 0;
  const trabalho = Promise.all(pedidos.map(async (p, i) => {
    try {
      let dados = null, fonte = '', credito = '';
      try {
        const f = await procurarFotoPexels(p.consulta, p.orientacao, usados, p.locale);
        if (f) {
          const r = await fetch(f.url, { signal: AbortSignal.timeout(25000) });
          if (r.ok) { dados = { buffer: Buffer.from(await r.arrayBuffer()), mime: 'image/jpeg' }; fonte = 'pexels'; credito = f.credito; }
        }
      } catch (e) { console.error('Pexels:', e.message || e); }
      if (!dados) {
        try {
          const f = await procurarFotoPixabay(p.consulta, p.orientacao, usados);
          if (f) {
            const r = await fetch(f.url, { signal: AbortSignal.timeout(25000) });
            if (r.ok) { dados = { buffer: Buffer.from(await r.arrayBuffer()), mime: /\.png(\?|$)/i.test(f.url) ? 'image/png' : 'image/jpeg' }; fonte = 'pixabay'; credito = f.credito; }
          }
        } catch (e) { console.error('Pixabay:', e.message || e); }
      }
      if (!dados && iaUsadas < FOTOS_IA_MAX) {
        iaUsadas++;
        dados = await gerarFotoIA(p.descricao || p.consulta, p.orientacao);
        if (dados) { fonte = 'ia'; tokens += TOKENS_POR_FOTO_IA; }
      }
      if (!dados || !dados.buffer || dados.buffer.length < 2000) return;
      const ext = /png/.test(dados.mime) ? 'png' : 'jpg';
      const url = await uploadParaBunny(`sites/${owner}/${slug}/fotos/${i + 1}-${p.uso}.${ext}`, dados.buffer, dados.mime);
      prontas.push({ ordem: i, uso: p.uso, url, descricao: p.descricao || p.consulta, orientacao: p.orientacao, fonte, credito });
    } catch (erro) {
      console.error('Foto "' + p.uso + '" falhou:', erro.message || erro);
    }
  }));
  await Promise.race([trabalho, new Promise(r => setTimeout(r, 80000))]);
  return { fotos: prontas.slice().sort((a, b) => a.ordem - b.ordem).map(f => { const c = Object.assign({}, f); delete c.ordem; return c; }), tokens };
}
function instrucaoFotos(fotos) {
  if (!fotos || !fotos.length) return '';
  return '\nFOTOGRAFIAS DESTE SITE (fotos reais, já preparadas - usa-as, são parte do padrão profissional; estes são os únicos URLs de imagens externas permitidos, além das imagens que a pessoa anexou):'
    + fotos.map((f, i) => `\n${i + 1}) [${f.uso}] ${f.url} - ${f.descricao || ''} (${f.orientacao || 'paisagem'})`).join('')
    + '\nUsa-as grandes e bem enquadradas: <img> com object-fit:cover e alt descritivo, cantos e sombras a condizer com o site, sobreposições e cartões flutuantes por cima (números, avaliações, etiquetas), recortes em formas (arco, círculo, cantos assimétricos) quando servir a identidade. Cada foto no máximo uma vez por página.';
}

// ---- Sites ricos e sempre diferentes (1.60.0) ----
// Cada versão recebe uma mão-cheia de padrões de secção sorteados de uma
// biblioteca grande, para nunca sair duas vezes o mesmo molde.
const PADROES_SECCAO = [
  'faixa de números grandes animados (anos, clientes, entregas, cidades), com uma legenda curta por baixo de cada um',
  'grelha "bento" com cartões de tamanhos diferentes: um grande com foto e 3 a 4 pequenos com ícone e texto',
  'linha do tempo horizontal (vertical no telemóvel) com os passos do processo numerados',
  'secção em duas colunas: foto grande com cantos assimétricos de um lado e lista de vantagens com ícones do outro, com um cartão flutuante por cima da foto (número ou avaliação)',
  'depoimentos em cartões com aspas grandes desenhadas, estrelas, nome e cidade; um deles em destaque maior',
  'tabela de comparação "connosco vs. sem nós" com vistos e cruzes em SVG',
  'acordeão de perguntas frequentes em duas colunas, com um cartão de contacto ao lado',
  'faixa larga em cor forte com uma frase enorme e um botão, com formas decorativas em SVG',
  'cartões de serviço com ícone, título, 2 frases, uma lista curta de "inclui" e um link "Saber mais"',
  'galeria em mosaico (masonry) com legendas que aparecem ao passar o rato',
  'secção "para quem é": 3 a 4 perfis de cliente em cartões, cada um com o problema e a solução',
  'faixa de texto em movimento contínuo com palavras-chave do negócio separadas por um símbolo',
  'secção de garantias e confiança: selos desenhados em SVG (pagamento seguro, entrega, garantia, apoio) com uma frase cada',
  'cartões de preços com um plano em destaque, lista do que inclui e botão; preços em MZN',
  'secção "antes e depois" ou problema → solução em duas colunas contrastantes',
  'equipa ou fundador: foto (ou monograma desenhado) com citação pessoal e assinatura',
  'mapa estilizado desenhado em SVG com as zonas de entrega ou atendimento e uma lista de cidades',
  'cartões com efeito de vidro (glassmorphism) sobre um fundo com gradiente e formas desfocadas',
  'secção de destaque com um número gigante como fundo gráfico e texto por cima',
  'abas (tabs) em CSS/JS simples para mostrar categorias de serviços ou de menu sem sair da página',
  'carrossel horizontal com scroll-snap de cartões (serviços, projectos ou depoimentos), com setas',
  'chamada final de ecrã inteiro com fundo em foto escurecida, título forte e dois botões (principal e WhatsApp)',
  'lista de "o que recebes" com vistos grandes e um cartão lateral fixo (sticky) com o resumo e o botão',
  'faixa de passos em círculos ligados por uma linha tracejada animada',
  'secção editorial com um título gigante à esquerda e parágrafos em duas colunas à direita, com uma citação em destaque',
  'cartões que se viram (flip) ou se expandem ao passar o rato para mostrar detalhes',
  'secção de horário e localização com um relógio/ícone desenhado, dias da semana em grelha e o estado "Aberto agora"',
  'barra de logótipos ou parceiros desenhados como monogramas em SVG (sem marcas reais), em movimento lento'
];
function sortearPadroesSeccao(n) {
  const a = PADROES_SECCAO.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
function instrucaoRiqueza(tipo) {
  const extra = {
    'E-commerce': 'Loja: depois da div da loja, junta 4 a 6 secções ricas (vantagens e entregas, como comprar passo a passo, a marca com link para sobre.html, depoimentos, perguntas rápidas, uma faixa para encomendar no WhatsApp). Os produtos continuam a ser os protagonistas.',
    'Checkout': 'Página de venda COMPLETA (como as melhores páginas de venda): depois da div da loja, desenvolve a venda com 6 a 9 secções - a promessa, os benefícios explicados, para quem é, como funciona, o que a pessoa recebe, garantia, depoimentos, perguntas frequentes e uma chamada final com um botão que leva de volta à oferta (href="#daniel-ia-produtos"). Isto substitui a regra de "textos curtos" do guia.',
  }[tipo] || 'A página inicial tem no mínimo 8 secções diferentes entre o hero e o rodapé.';
  return `\nSITE RICO E VIVO (regra base, a não ser que a descrição peça algo simples ou curto - aí manda a descrição):
- Nada de sites "mortos" ou pobres: cada secção tem informação concreta e útil para este negócio (o que faz, como, para quem, quanto custa em MZN quando faz sentido, prazos, zonas, horários, garantias, passos, exemplos). Parágrafos com substância, listas, números e detalhes - nunca frases genéricas de enchimento.
- ${extra}
- Varia a forma das secções: nunca duas secções seguidas com o mesmo desenho (ex: três grelhas de cartões iguais seguidas).
- Depoimentos: escreve-os como exemplos realistas que o dono vai trocar pelos verdadeiros - só o primeiro nome e a cidade, sem empresas nem números inventados como se fossem factos.
- Interacção: hover nos cartões, contadores animados, acordeões, abas ou carrosséis onde fizer sentido (sempre com o conteúdo visível sem JavaScript).
PADRÕES DE SECÇÃO SORTEADOS PARA ESTA VERSÃO (usa pelo menos 4 deles, adaptados ao negócio, para esta versão ser diferente das outras e de qualquer site anterior):
${sortearPadroesSeccao(6).map(x => '- ' + x).join('\n')}`;
}

// ---- Instruções para as páginas ----
function instrucaoPaginas(paginas, tipo) {
  if (!Array.isArray(paginas) || paginas.length < 2) return '';
  const menu = paginas.filter(p => p.menu !== false);
  const lista = menu.map(p => `${p.nav} (${p.ficheiro})`).join(', ');
  const outras = paginas.filter(p => p.slug !== 'inicio' && p.menu !== false).map(p => `- ${p.titulo} (${p.ficheiro}): ${p.resumo}`).join('\n');
  const ehLoja = tipo === 'E-commerce';
  return `\nSITE COM VÁRIAS PÁGINAS (não é uma página única nem uma "single page"): o site tem estas páginas no menu, por esta ordem: ${lista}.
Estás a desenhar a PÁGINA INICIAL (index.html). As outras são criadas depois, a partir desta.
NAVEGAÇÃO:
- O menu do cabeçalho (no computador e no menu de telemóvel) tem EXACTAMENTE estes links, por esta ordem, com o href igual ao nome do ficheiro (ex: href="sobre.html"). Nunca âncoras "#" no menu. O logótipo leva a index.html.
- Botões e chamadas para acção levam às páginas certas (ex: "Ver todos os serviços" -> servicos.html, "Fala connosco" -> contacto.html).
- A inicial é a montra do site: uma secção forte para cada página importante, com um resumo apelativo e o link "Ver mais" para a página dela. Não ponhas o conteúdo completo de todas as páginas na inicial.
- O link da página actual é marcado sozinho com aria-current="page": estiliza-o no CSS com o seletor [aria-current="page"].${ehLoja ? '\n- Loja: no cabeçalho põe também um botão de carrinho com o atributo data-dia-carrinho (ícone SVG de saco ou carrinho) e, dentro dele, <span data-dia-carrinho-contagem>0</span> numa bolinha - o sistema da loja liga-o sozinho. Um link "Loja" leva a loja.html.' : ''}
O que vai em cada página (para os resumos e os links da inicial):
${outras}
ESTRUTURA OBRIGATÓRIA DO HTML (as outras páginas são montadas a partir desta):
- Filhos directos do <body>, por esta ordem: <header data-dia="cabecalho">...</header>, <main data-dia="conteudo">...</main>, <footer data-dia="rodape">...</footer>; os <script> vêm depois do footer.
- O cabeçalho e o rodapé servem para todas as páginas: nada lá dentro pode depender da inicial. O rodapé tem os links das páginas, os contactos e as redes.
- Todo o CSS no <head>. Os estilos de botões, títulos, etiquetas, cartões, grelhas e secções são genéricos e reutilizáveis (classes como .btn, .seccao, .titulo-seccao, .cartao, .grelha), porque as outras páginas usam as mesmas classes.
- O JavaScript (menu de telemóvel, animações, contadores) funciona em qualquer página: verifica sempre se os elementos existem antes de os usar. Animações de entrada nunca podem deixar conteúdo escondido se o JavaScript falhar (o conteúdo é visível por omissão; o JS só acrescenta a animação).`;
}
const INSTRUCAO_CONTACTO_MULTI = `\nCONTACTO (site com várias páginas): o formulário de contacto fica na página Contacto (contacto.html). Nesta página NÃO ponhas a div do formulário nem nenhum formulário. Mostra os contactos no rodapé e, no fim da inicial, uma chamada curta e elegante que leva a contacto.html.`;

// ---- Estrutura: cabeçalho, conteúdo e rodapé marcados ----
// Encontra o fim do elemento que abre em "inicio" (conta aberturas e fechos
// da mesma tag, para aguentar elementos aninhados).
function fimDoElemento(html, inicio, tag) {
  const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
  re.lastIndex = inicio;
  let nivel = 0, m;
  while ((m = re.exec(html))) {
    if (m[1]) { nivel--; if (nivel === 0) return m.index + m[0].length; }
    else if (!/\/>$/.test(m[0])) nivel++;
  }
  return -1;
}
function marcarEstrutura(html) {
  if (!/<header\b[^>]*data-dia=["']cabecalho["']/i.test(html)) {
    html = html.replace(/<header\b(?![^>]*data-dia)/i, '<header data-dia="cabecalho"');
  }
  if (!/<footer\b[^>]*data-dia=["']rodape["']/i.test(html)) {
    const re = /<footer\b(?![^>]*data-dia)/gi; let m, ultimo = -1;
    while ((m = re.exec(html))) ultimo = m.index;
    if (ultimo >= 0) html = html.slice(0, ultimo) + '<footer data-dia="rodape"' + html.slice(ultimo + 7);
  }
  if (!/<main\b[^>]*data-dia=["']conteudo["']/i.test(html)) {
    if (/<main\b/i.test(html)) {
      html = html.replace(/<main\b/i, '<main data-dia="conteudo"');
    } else {
      const ih = html.search(/<header\b[^>]*data-dia=["']cabecalho["']/i);
      const fh = ih >= 0 ? fimDoElemento(html, ih, 'header') : -1;
      const ifo = html.search(/<footer\b[^>]*data-dia=["']rodape["']/i);
      const corpo = html.search(/<body\b[^>]*>/i);
      const inicio = fh > 0 ? fh : (corpo >= 0 ? corpo + html.slice(corpo).indexOf('>') + 1 : -1);
      let fim = ifo;
      if (!(fim > inicio)) {
        // Sem rodapé: o conteúdo vai até aos scripts do fim do <body>.
        const fimBody = html.search(/<\/body>/i);
        const antes = fimBody > 0 ? html.slice(0, fimBody) : html;
        const finais = /(\s*<script\b[\s\S]*?<\/script>\s*)+$/i.exec(antes);
        fim = finais ? finais.index : antes.length;
      }
      if (inicio > 0 && fim > inicio) html = html.slice(0, inicio) + '\n<main data-dia="conteudo">' + html.slice(inicio, fim) + '</main>\n' + html.slice(fim);
    }
  }
  return html;
}
function partesDoHtml(html) {
  const m = /<main\b[^>]*data-dia=["']conteudo["'][^>]*>/i.exec(html);
  if (!m) return null;
  const fim = fimDoElemento(html, m.index, 'main');
  if (fim < 0) return null;
  return { antes: html.slice(0, m.index), main: html.slice(m.index, fim), depois: html.slice(fim) };
}
function definirTitulo(html, titulo) {
  const t = escaparHtml(titulo);
  return /<title\b[^>]*>[\s\S]*?<\/title>/i.test(html) ? html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '<title>' + t + '</title>') : html.replace(/<\/head>/i, '<title>' + t + '</title>\n</head>');
}
function tituloDoHtml(html) { const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html || ''); return m ? m[1].trim() : ''; }
function definirMeta(html, nome, valor) {
  const re = new RegExp('\\s*<meta\\s+name=["\']' + nome + '["\'][^>]*>', 'gi');
  html = html.replace(re, '');
  if (valor === null || valor === undefined || valor === '') return html;
  const tag = `<meta name="${nome}" content="${escaparHtml(valor)}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>\n${tag}`) : tag + html;
}
function metaDoHtml(html, nome) {
  const m = new RegExp('<meta\\s+name=["\']' + nome + '["\']\\s+content=["\']([^"\']*)["\']', 'i').exec(html || '');
  return m ? m[1] : '';
}
function descricaoDoHtml(html) { return metaDoHtml(html, 'description'); }
function semEstiloPagina(html) { return html.replace(/\s*<style\b[^>]*data-dia=["']pagina["'][^>]*>[\s\S]*?<\/style>/gi, ''); }

// A "casca": a inicial com a estrutura marcada, as metas das páginas e o
// script da navegação.
function prepararCasca(html, plano) {
  html = marcarEstrutura(html);
  html = semEstiloPagina(html);
  html = definirMeta(html, 'daniel-ia-paginas', plano.filter(p => p.menu !== false).map(p => p.ficheiro).join(' '));
  html = definirMeta(html, 'daniel-ia-pagina', 'inicio');
  return injectarNavSeNecessario(html);
}
function injectarNavSeNecessario(html) {
  if (/site-nav\.js/.test(html) || !/name=["']daniel-ia-paginas["']/.test(html)) return html;
  const s = `\n<script src="${SELF_URL}/site-nav.js" defer></script>\n`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, s + '</body>') : html + s;
}

const CSS_PAGINA_MODULO = '.dia-pg-largura{max-width:1240px;margin:0 auto;padding:0 clamp(16px,4vw,32px);box-sizing:border-box}'
  + '.dia-pg-topo{padding:clamp(36px,6vw,76px) 0 clamp(22px,3vw,34px);background:var(--dia-superficie,#f6f6f6);border-bottom:1px solid var(--dia-borda,rgba(0,0,0,.08));margin-bottom:clamp(20px,3vw,36px)}'
  + '.dia-pg-migalhas{display:flex;flex-wrap:wrap;gap:8px;font-size:13px;color:var(--dia-texto-suave,#666);margin-bottom:12px}.dia-pg-migalhas a{color:inherit;text-decoration:none}.dia-pg-migalhas a:hover{color:var(--dia-primaria,inherit)}'
  + '.dia-pg-titulo{font-family:var(--dia-fonte-titulos,inherit);font-size:clamp(32px,5.4vw,60px);line-height:1.04;letter-spacing:-.02em;margin:0;color:var(--dia-texto,#111)}'
  + '.dia-pg-sub{margin:12px 0 0;color:var(--dia-texto-suave,#666);font-size:clamp(15px,1.6vw,18px);max-width:640px;line-height:1.55}'
  + '.dia-pg-corpo{padding-bottom:clamp(44px,6vw,90px)}.dia-pg-produto{padding-top:clamp(16px,3vw,32px);padding-bottom:clamp(44px,6vw,90px)}';
function mainDePaginaModulo(p, idioma) {
  const casa = NOMES_PAGINAS.inicio[normalizarIdioma(idioma)][0];
  const divs = { loja: 'daniel-ia-produtos', produto: 'daniel-ia-produtos', portfolio: 'daniel-ia-portfolio', galeria: 'daniel-ia-galeria', blog: 'daniel-ia-blog' };
  const div = `<div id="${divs[p.modulo] || 'daniel-ia-produtos'}"></div>`;
  if (p.modulo === 'produto') return `<main data-dia="conteudo"><div class="dia-pg-largura dia-pg-produto">${div}</div></main>`;
  return `<main data-dia="conteudo"><section class="dia-pg-topo"><div class="dia-pg-largura"><nav class="dia-pg-migalhas" aria-label="breadcrumb"><a href="index.html">${escaparHtml(casa)}</a><span>/</span><span>${escaparHtml(p.titulo)}</span></nav><h1 class="dia-pg-titulo">${escaparHtml(p.titulo)}</h1>${p.subtitulo ? `<p class="dia-pg-sub">${escaparHtml(p.subtitulo)}</p>` : ''}</div></section><div class="dia-pg-largura dia-pg-corpo">${div}</div></main>`;
}

// Monta uma página: a casca com o <main> da página no lugar do da inicial.
function montarPagina(casca, pagina, frag, nomeSite) {
  const p = partesDoHtml(casca);
  if (!p) throw new Error('A página inicial não tem a estrutura <main data-dia="conteudo">.');
  let html = p.antes + frag.main + p.depois;
  html = definirTitulo(html, `${frag.titulo || pagina.titulo} · ${nomeSite}`);
  html = definirMeta(html, 'description', frag.descricao || pagina.subtitulo || '');
  html = semEstiloPagina(html);
  if (frag.estilo) html = html.replace(/<\/head>/i, `<style data-dia="pagina">${frag.estilo}</style>\n</head>`);
  html = definirMeta(html, 'daniel-ia-pagina', pagina.slug);
  return html;
}
// Depois de montar: módulos que esta página precisa (o contacto e o quiz
// só existem nalgumas páginas).
function completarPagina(html, siteId, tipo) {
  const ehLoja = tipo === 'E-commerce' || tipo === 'Checkout';
  html = injectarLojaSeNecessario(html, ehLoja, siteId);
  html = injectarGaleriaSeNecessario(html, tipo === 'Galeria', siteId);
  html = injectarPortfolioSeNecessario(html, tipo === 'Portefólio', siteId);
  html = injectarBlogSeNecessario(html, tipo === 'Blog', siteId);
  html = injectarContactoSeNecessario(html, siteId);
  // O quiz só corre na página inicial.
  html = html.replace(/\s*<script\b[^>]*quiz\.js[^>]*><\/script>/gi, '');
  return injectarNavSeNecessario(html);
}

// ---- Uma página nova escrita pela IA (só o <main>) ----
function cssDaCasca(html) {
  const head = (/<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html) || [])[1] || '';
  const blocos = [];
  head.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (t, attrs, css) => {
    if (/daniel-ia-responsivo|data-dia=["']pagina|data-daniel-ia/i.test(attrs)) return t;
    blocos.push(css.trim());
    return t;
  });
  return blocos.join('\n').slice(0, 60000);
}
function fontesDaCasca(html) {
  const links = [];
  String(html).replace(/<link\b[^>]*fonts\.googleapis[^>]*>/gi, t => { links.push(t); return t; });
  return links.join('\n');
}
function extrairMainDaResposta(texto, slug) {
  let t = String(texto || '').replace(/^```(html)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let estilo = '';
  t = t.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (tudo, css) => { estilo += css.trim() + '\n'; return ''; });
  let main = '';
  const ini = t.search(/<main\b/i);
  if (ini >= 0) {
    const fim = fimDoElemento(t, ini, 'main');
    main = fim > 0 ? t.slice(ini, fim) : t.slice(ini) + '</main>';
  } else {
    const corpo = (/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(t) || [])[1] || t;
    main = '<main data-dia="conteudo">' + corpo + '</main>';
  }
  main = main
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<(header|footer)\b[^>]*data-dia[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<main\b[^>]*>/i, `<main data-dia="conteudo" class="pg-${slug}">`);
  return { main, estilo: estilo.trim().slice(0, 40000) };
}
async function gerarPaginaIA({ casca, pagina, plano, nome, tipo, prompt, idioma, fotos }) {
  const lingua = normalizarIdioma(idioma);
  const css = cssDaCasca(casca);
  const p = partesDoHtml(casca);
  const exemplo = p ? p.main.slice(0, 14000) : '';
  const cab = ((/<header\b[\s\S]*?<\/header>/i.exec(casca) || [])[0] || '').slice(0, 5000);
  const ehContacto = pagina.slug === 'contacto';
  const sistema = `És o motor de páginas da Daniel IA, uma plataforma moçambicana de sites profissionais.
Vais criar UMA página de um site que já existe. O cabeçalho, o rodapé, as fontes e o CSS do site já existem e são reutilizados - tu escreves só o conteúdo desta página.
RESPOSTA: só um <style data-dia="pagina">...</style> (opcional, só com CSS novo) seguido de <main data-dia="conteudo">...</main>. Nada antes nem depois, sem markdown, sem <html>, <head>, <body>, <header>, <footer> nem <script>.
${DIRECAO_DE_ARTE}
REGRAS DESTA PÁGINA:
- A página tem de parecer do mesmo site da inicial: usa as MESMAS classes, fichas --dia-*, botões, títulos, etiquetas, cartões, espaçamentos e cantos do CSS existente. CSS novo só para componentes novos, sempre com o prefixo .pg-${pagina.slug} (o <main> já tem essa classe).
- Abre com um topo de página forte (título da página, uma frase e, se fizer sentido, uma foto ou composição), depois 5 a 8 secções com conteúdo real, concreto e com substância para este negócio (números, passos, listas, preços em MZN quando fizer sentido, exemplos; nunca "lorem ipsum" nem textos de enchimento), com formas diferentes entre si, e fecha com uma chamada para acção que leva a outra página.
- Padrões de secção sorteados para esta página (usa pelo menos 2, adaptados): ${sortearPadroesSeccao(4).join(' | ')}.
- Links internos com o nome do ficheiro (ex: href="contacto.html"). Páginas do site: ${plano.filter(x => x.menu !== false).map(x => `${x.nav} = ${x.ficheiro}`).join(', ')}.
- Responsiva a 360, 768 e 1280 px; nada a sair do ecrã.
- Pode usar as mesmas classes de animação da inicial (o mesmo script corre aqui), mas o conteúdo nunca pode ficar invisível sem JavaScript.${ehContacto ? '\n- PÁGINA DE CONTACTO: inclui exactamente <div id="daniel-ia-contacto"></div> (o formulário a sério aparece lá dentro, já aberto) ao lado ou abaixo de cartões com telefone, WhatsApp, email, morada e horário, e um mapa estilizado desenhado em SVG/CSS (nunca um iframe). Não escrevas tu nenhum formulário.' : ''}
IDIOMA: ${IDIOMAS_SITE[lingua].instrucao}${instrucaoFotos(fotos)}`;
  const pedido = `Nome do negócio: ${nome}
Tipo de site: ${tipo}
Descrição do negócio: ${textoCurto(prompt, 1500)}
PÁGINA A CRIAR: ${pagina.titulo} (${pagina.ficheiro})${pagina.subtitulo ? ' - ' + pagina.subtitulo : ''}
O que leva: ${pagina.resumo}

CSS do site (reutiliza estas classes):
${css}

Cabeçalho do site (só para referência, não o repitas):
${cab}

Início da página inicial (imita o estilo das secções):
${exemplo}`;
  const res = await fetchGeracao('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      reasoning_effort: OPENAI_REASONING_EFFORT,
      max_completion_tokens: Math.min(OPENAI_MAX_TOKENS, 24000),
      messages: [{ role: 'system', content: sistema }, { role: 'user', content: pedido }]
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error('OpenAI falhou: ' + JSON.stringify(json).slice(0, 300));
  const texto = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  const tokens = (json.usage && json.usage.total_tokens) || 0;
  const r = extrairMainDaResposta(texto, pagina.slug);
  if (r.main.replace(/<[^>]+>/g, '').trim().length < 80) throw new Error('A página "' + pagina.slug + '" veio vazia.');
  if (ehContacto && !/id=["']daniel-ia-contacto["']/.test(r.main)) {
    r.main = r.main.replace(/<\/main>\s*$/i, '<section class="pg-contacto-form"><div class="dia-pg-largura"><div id="daniel-ia-contacto"></div></div></section></main>');
    r.estilo += '\n' + CSS_PAGINA_MODULO;
  }
  return { fragmento: { main: r.main, estilo: r.estilo, titulo: pagina.titulo, descricao: pagina.subtitulo || '' }, tokens };
}

// ---- Fragmentos guardados (_paginas.json, na pasta do site) ----
function pastaDoSite(site) { return String(site['Bunny Path'] || '').replace(/[^/]+$/, ''); }
function cdnPastaDoSite(site) { return String(site['CDN URL'] || '').replace(/[^/]+$/, ''); }
async function lerFragmentos(site) {
  try { return JSON.parse((await descarregarDoBunny(pastaDoSite(site) + '_paginas.json')).toString('utf8')) || {}; }
  catch (e) { return {}; }
}
async function guardarFragmentos(site, dados) {
  await uploadParaBunny(pastaDoSite(site) + '_paginas.json', Buffer.from(JSON.stringify(dados), 'utf8'), 'application/json; charset=utf-8');
}
// Mexe no "Variantes Json" de um site sempre na fila (lê o mais recente).
function mudarEstadoSite(siteId, fn) {
  const anterior = filaVariantes.get(siteId) || Promise.resolve();
  const proximo = anterior.catch(() => {}).then(async () => {
    const site = await bubbleGet('site', siteId);
    const e = lerJsonSeguro(site && site['Variantes Json'], {}) || {};
    const r = fn(e) || e;
    await bubblePatch('site', siteId, { 'Variantes Json': JSON.stringify(r) });
    return r;
  }).catch(erro => console.error('Não foi possível guardar o estado do site:', erro.message || erro));
  filaVariantes.set(siteId, proximo);
  return proximo;
}
function estadoPublicoPaginas(e, site) {
  if (!e || !Array.isArray(e.plano_paginas) || e.plano_paginas.length < 2) return null;
  const est = (e.paginas && e.paginas.lista) || [];
  const cdn = site ? cdnPastaDoSite(site) : '';
  return {
    estado: (e.paginas && e.paginas.estado) || 'por construir',
    lista: e.plano_paginas.map(p => {
      const s = est.find(x => x.slug === p.slug);
      return { slug: p.slug, ficheiro: p.ficheiro, nav: p.nav, titulo: p.titulo, menu: p.menu !== false, estado: p.slug === 'inicio' ? 'pronto' : ((s && s.estado) || 'por construir'), url: cdn ? cdn + p.ficheiro : '' };
    })
  };
}

// ---- Construir (ou montar outra vez) as páginas de um site ----
const filaPaginas = new Map();
function construirPaginas(siteId, opcoes) {
  const anterior = filaPaginas.get(siteId) || Promise.resolve();
  const proximo = anterior.catch(() => {}).then(() => construirPaginasAgora(siteId, opcoes || {}))
    .catch(erro => console.error('Erro a construir as páginas de ' + siteId + ':', erro.message || erro));
  filaPaginas.set(siteId, proximo);
  return proximo;
}
async function emParalelo(lista, max, fn) {
  let i = 0;
  const trabalhadores = Array.from({ length: Math.min(max, lista.length) }, async () => {
    while (i < lista.length) { const k = i++; await fn(lista[k], k); }
  });
  await Promise.all(trabalhadores);
}
// opcoes.regenerar: a IA escreve outra vez as páginas (ex: outro layout)
// opcoes.soMontar: não chama a IA - só monta com o que já existe
async function construirPaginasAgora(siteId, opcoes) {
  const site = await bubbleGet('site', siteId);
  if (!site || !site['Bunny Path'] || !site['CDN URL']) return;
  const estado = lerJsonSeguro(site['Variantes Json'], {}) || {};
  const plano = Array.isArray(estado.plano_paginas) ? estado.plano_paginas : [];
  if (plano.length < 2) return;
  const tipo = site['Tipo'] || 'Landing Page';
  const nome = site['Nome'] || '';
  const pasta = pastaDoSite(site);
  let casca = (await descarregarDoBunny(site['Bunny Path'])).toString('utf8');
  const cascaPreparada = prepararCasca(casca, plano);
  if (cascaPreparada !== casca) {
    casca = cascaPreparada;
    await uploadParaBunny(site['Bunny Path'], Buffer.from(casca, 'utf8'), 'text/html; charset=utf-8');
    await purgeCacheBunny(site['CDN URL']);
  }
  if (!partesDoHtml(casca)) {
    console.error('Páginas de ' + siteId + ': a inicial não tem <main> - fica com uma página só.');
    await mudarEstadoSite(siteId, e => { e.paginas = { estado: 'erro', lista: [] }; return e; });
    return;
  }
  const idioma = idiomaDoHtml(casca) || 'pt';
  const guardados = await lerFragmentos(site);
  const frags = Object.assign({}, guardados.fragmentos || {});
  const trabalho = plano.filter(p => p.slug !== 'inicio');
  const lista = trabalho.map(p => ({ slug: p.slug, estado: 'a construir' }));
  await mudarEstadoSite(siteId, e => { e.paginas = { estado: 'a construir', lista, inicio: new Date().toISOString() }; return e; });
  let tokens = 0, falhas = 0;
  await emParalelo(trabalho, 3, async (p) => {
    const item = lista.find(x => x.slug === p.slug);
    try {
      let frag = !opcoes.regenerar ? frags[p.slug] : null;
      if (!frag && p.modulo && p.modulo !== 'contacto') {
        frag = { main: mainDePaginaModulo(p, idioma), estilo: CSS_PAGINA_MODULO, titulo: p.titulo, descricao: p.subtitulo || '' };
      }
      if (!frag) {
        if (opcoes.soMontar) { item.estado = 'por construir'; return; }
        const r = await gerarPaginaIA({ casca, pagina: p, plano, nome, tipo, prompt: site['Prompt Original'] || '', idioma, fotos: estado.fotos || [] });
        tokens += r.tokens;
        frag = r.fragmento;
      }
      frags[p.slug] = frag;
      const html = completarPagina(montarPagina(casca, p, frag, nome), siteId, tipo);
      const url = await uploadParaBunny(pasta + p.ficheiro, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
      await purgeCacheBunny(url);
      item.estado = 'pronto';
    } catch (erro) {
      falhas++;
      item.estado = 'erro';
      console.error('Página "' + p.slug + '" de ' + siteId + ' falhou:', erro.message || erro);
    }
    await mudarEstadoSite(siteId, e => { e.paginas = { estado: 'a construir', lista, inicio: (e.paginas && e.paginas.inicio) || '' }; return e; });
  });
  await guardarFragmentos(site, { versao: 1, idioma, fragmentos: frags, actualizado: new Date().toISOString() });
  if (tokens && opcoes.cobrar !== false) await cobrarTokens(site['Owner'], tokens);
  await mudarEstadoSite(siteId, e => { e.paginas = { estado: falhas ? 'com erros' : 'pronto', lista, fim: new Date().toISOString() }; return e; });
  if (site['Dominio Pull Zone Id']) await regrasDominioPaginas(site).catch(erro => console.error('Regras do domínio:', erro.message || erro));
}

// ---- Domínio próprio com várias páginas ----
// A regra antiga mandava TODOS os caminhos para a inicial. Agora:
//   "/"                 -> index.html
//   "/sobre.html?x=1"   -> a mesma página da pasta do site
async function regrasDominioPaginas(site) {
  const id = site['Dominio Pull Zone Id'];
  if (!id || !BUNNY_API_KEY || !site['CDN URL']) return;
  const pasta = cdnPastaDoSite(site);
  const zona = await bunnyApi('GET', '/pullzone/' + id);
  for (const r of (zona && zona.EdgeRules) || []) {
    if (/^Domínio personalizado/.test(r.Description || '') && r.Guid) await bunnyApi('DELETE', `/pullzone/${id}/edgerules/${r.Guid}`);
  }
  await bunnyApi('POST', `/pullzone/${id}/edgerules/addOrUpdate`, {
    ActionType: 2, ActionParameter1: pasta.replace(/\/$/, '') + '{{path}}',
    Triggers: [{ Type: 0, PatternMatches: ['*/'], PatternMatchingType: 2 }], TriggerMatchingType: 0,
    Enabled: true, Description: 'Domínio personalizado - páginas do site'
  });
  await bunnyApi('POST', `/pullzone/${id}/edgerules/addOrUpdate`, {
    ActionType: 2, ActionParameter1: pasta + 'index.html',
    Triggers: [{ Type: 0, PatternMatches: ['*/'], PatternMatchingType: 0 }], TriggerMatchingType: 0,
    Enabled: true, Description: 'Domínio personalizado - página inicial'
  });
  await bunnyApi('POST', `/pullzone/${id}/purgeCache`).catch(() => {});
}

// ---- Guardar uma página editada (editor visual ou IA) ----
// Se o site tem várias páginas: o cabeçalho, o rodapé e o CSS mudam em
// todas; o <main> só na página editada.
async function lerPaginaDoSite(site, slug) {
  const plano = planoDoSite(site);
  const p = slug && slug !== 'inicio' ? plano.find(x => x.slug === slug) : null;
  if (slug && slug !== 'inicio' && !p) throw Object.assign(new Error('pagina'), { utilizador: 'Esta página não existe neste site.' });
  const caminho = p ? pastaDoSite(site) + p.ficheiro : site['Bunny Path'];
  return { pagina: p, caminho, html: (await descarregarDoBunny(caminho)).toString('utf8') };
}
async function guardarPaginaDoSite(site, slug, htmlNovo) {
  const siteId = site._id;
  const plano = planoDoSite(site);
  const multi = plano.length > 1;
  const tipo = site['Tipo'] || 'Landing Page';
  if (!multi || !slug || slug === 'inicio') {
    const html = multi ? prepararCasca(htmlNovo, plano) : htmlNovo;
    const url = await uploadParaBunny(site['Bunny Path'], Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
    await purgeCacheBunny(url);
    if (multi) await construirPaginas(siteId, { soMontar: true });
    return url;
  }
  const p = plano.find(x => x.slug === slug);
  if (!p) throw Object.assign(new Error('pagina'), { utilizador: 'Esta página não existe neste site.' });
  const partesNovo = partesDoHtml(marcarEstrutura(htmlNovo));
  if (!partesNovo) throw Object.assign(new Error('estrutura'), { utilizador: 'A página perdeu a estrutura (cabeçalho, conteúdo e rodapé). Não foi guardada.' });
  // 1. O conteúdo desta página
  const estiloPagina = ((/<style\b[^>]*data-dia=["']pagina["'][^>]*>([\s\S]*?)<\/style>/i.exec(htmlNovo) || [])[1] || '').trim();
  const guardados = await lerFragmentos(site);
  const frags = Object.assign({}, guardados.fragmentos || {});
  const tituloNovo = tituloDoHtml(htmlNovo).replace(/\s*·\s*[^·]*$/, '').trim();
  frags[slug] = { main: partesNovo.main, estilo: estiloPagina, titulo: tituloNovo || p.titulo, descricao: descricaoDoHtml(htmlNovo) || (frags[slug] && frags[slug].descricao) || '' };
  await guardarFragmentos(site, Object.assign({}, guardados, { fragmentos: frags, actualizado: new Date().toISOString() }));
  // 2. O que é comum (cabeçalho, rodapé, CSS) passa para a inicial
  const inicial = (await descarregarDoBunny(site['Bunny Path'])).toString('utf8');
  const partesInicial = partesDoHtml(marcarEstrutura(inicial));
  if (partesInicial) {
    let casca = semEstiloPagina(partesNovo.antes) + partesInicial.main + partesNovo.depois;
    casca = definirTitulo(casca, tituloDoHtml(inicial) || site['Nome'] || '');
    casca = definirMeta(casca, 'description', descricaoDoHtml(inicial));
    casca = prepararCasca(casca, plano);
    const urlIni = await uploadParaBunny(site['Bunny Path'], Buffer.from(casca, 'utf8'), 'text/html; charset=utf-8');
    await purgeCacheBunny(urlIni);
  }
  // 3. Todas as páginas montadas outra vez com a casca nova
  await construirPaginas(siteId, { soMontar: true });
  return cdnPastaDoSite(site) + p.ficheiro;
}

// ---- Script da navegação (todas as páginas de sites com várias páginas) ----
const SITE_NAV_JS = `(function(){
  var f = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (!/\\.html?$/.test(f)) f = 'index.html';
  var previa = /^v\\d+\\.html$/.test(f) || /[?&]dia_previa=1/.test(location.search);
  var lang = (document.documentElement.lang || 'pt').slice(0, 2);
  var AVISO = { pt: 'As outras páginas ficam prontas quando escolheres esta versão.', en: 'The other pages are built when you choose this version.', fr: 'Les autres pages sont créées quand vous choisissez cette version.', es: 'Las otras páginas se crean cuando eliges esta versión.' };
  function aviso(){
    var t = document.getElementById('dia-nav-aviso');
    if (!t) {
      t = document.createElement('div'); t.id = 'dia-nav-aviso';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;background:#140620;color:#fff;font:600 14px/1.4 system-ui,-apple-system,sans-serif;padding:12px 18px;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.3);max-width:90vw;text-align:center;transition:opacity .3s';
      document.body.appendChild(t);
    }
    t.textContent = AVISO[lang] || AVISO.pt; t.style.opacity = '1';
    clearTimeout(t._f); t._f = setTimeout(function(){ t.style.opacity = '0'; }, 2600);
  }
  var links = document.querySelectorAll('a[href]');
  for (var i = 0; i < links.length; i++) (function(a){
    var h = a.getAttribute('href') || '';
    if (/^(https?:|mailto:|tel:|#|javascript:|\\/\\/)/i.test(h)) return;
    var alvo = h.split(/[?#]/)[0].split('/').pop().toLowerCase();
    if (!/\\.html?$/.test(alvo)) return;
    var actual = alvo === f || (previa && alvo === 'index.html');
    if (actual) { a.setAttribute('aria-current', 'page'); a.classList.add('dia-activo'); }
    if (previa) a.addEventListener('click', function(e){ e.preventDefault(); if (!actual) aviso(); });
  })(links[i]);
})();`;
app.get('/site-nav.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  return res.send(SITE_NAV_JS);
});

// ======================================================
// Rotas do editor visual (1.60.0)
// ======================================================
['/site-paginas', '/site-pagina-ler', '/site-pagina-guardar', '/editor-imagem', '/editar-bloco', '/editar-bloco-estado', '/site-paginas-criar']
  .forEach(r => ROTAS_PRIVADAS.add(r));
Object.assign(LIMITES, {
  '/site-pagina-guardar': [['owner', 60, 10 * MIN]],
  '/editor-imagem': [['owner', 60, 10 * MIN]],
  '/editar-bloco': [['owner', 20, 10 * MIN]],
  '/site-paginas-criar': [['owner', 4, 60 * MIN]]
});

app.post('/site-paginas', async (req, res) => {
  try {
    const site = await siteDoDono(req.body.owner, req.body.site_id);
    if (!site) return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    const e = lerJsonSeguro(site['Variantes Json'], {}) || {};
    const pub = estadoPublicoPaginas(e, site);
    const paginas = pub ? pub.lista : [{ slug: 'inicio', ficheiro: String(site['Bunny Path'] || '').split('/').pop() || 'index.html', nav: 'Início', titulo: 'Início', menu: true, estado: 'pronto', url: site['CDN URL'] || '' }];
    return res.json({ status: 'success', response: {
      nome: site['Nome'] || '', tipo: site['Tipo'] || '', estado_site: site['Status'] || '', cdn_url: site['CDN URL'] || '',
      multi: !!pub, estado_paginas: pub ? pub.estado : ((e.paginas && e.paginas.estado) || ''), paginas,
      fotos: (Array.isArray(e.fotos) ? e.fotos : []).map(f => ({ url: f.url, descricao: f.descricao || '' })).slice(0, 12),
      pode_criar_paginas: !pub && site['Status'] === 'Pronto' && !!site['Bunny Path']
    } });
  } catch (erro) {
    console.error('Erro em /site-paginas:', erro);
    return res.json({ status: 'error', message: 'Não foi possível ler as páginas.' });
  }
});

app.post('/site-pagina-ler', async (req, res) => {
  try {
    const site = await siteDoDono(req.body.owner, req.body.site_id);
    if (!site) return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    if (!site['Bunny Path']) return res.json({ status: 'error', message: 'Este projecto ainda não tem páginas.' });
    const r = await lerPaginaDoSite(site, String(req.body.pagina || 'inicio'));
    return res.json({ status: 'success', response: { html: r.html, base: cdnPastaDoSite(site) } });
  } catch (erro) {
    if (erro.utilizador) return res.json({ status: 'error', message: erro.utilizador });
    console.error('Erro em /site-pagina-ler:', erro);
    return res.json({ status: 'error', message: 'Não foi possível abrir esta página.' });
  }
});

// Limpa o HTML que vem do editor: tira as marcas do editor e não deixa
// entrar scripts, eventos ou iframes que não estavam já na página.
function decodificarAtributo(v) {
  return String(v || '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&');
}
function atributoDe(tag, nome) {
  const m = new RegExp('\\s' + nome + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  return m ? decodificarAtributo(m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4])) : '';
}
function limparHtmlDoEditor(novo, original) {
  let html = String(novo || '');
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  // O que a página já tinha (só isso pode ficar): scripts, iframes e eventos.
  const scriptsTexto = new Set(), scriptsSrc = new Set(), iframes = new Set(), eventos = new Set(), jsLinks = new Set();
  String(original || '').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (t, attrs, corpo) => {
    const src = atributoDe('<s' + attrs + '>', 'src');
    if (src) scriptsSrc.add(src); else scriptsTexto.add(norm(corpo));
    return t;
  });
  String(original || '').replace(/<iframe\b[^>]*>/gi, t => { iframes.add(atributoDe(t, 'src')); return t; });
  String(original || '').replace(/\s(on[a-z]+)\s*=\s*("([^"]*)"|'([^']*)')/gi, (t, n, v, a, b) => { eventos.add(n.toLowerCase() + '=' + norm(decodificarAtributo(a !== undefined ? a : b))); return t; });
  String(original || '').replace(/\s(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, (t, n, v) => { jsLinks.add(norm(decodificarAtributo(v.slice(1, -1)))); return t; });
  html = html.replace(/\s+contenteditable=("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+spellcheck=("false"|'false'|false)/gi, '')
    .replace(/\s+data-ed-[a-z0-9-]+=("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+data-ed-[a-z0-9-]+(?=[\s>])/gi, '')
    .replace(/<base\b[^>]*data-ed[^>]*>/gi, '')
    .replace(/<style\b[^>]*id=["']dia-ed-[^"']*["'][^>]*>[\s\S]*?<\/style>/gi, '');
  html = html.replace(/\sclass=(["'])([^"']*)\1/gi, (t, q, v) => {
    const limpo = v.split(/\s+/).filter(c => c && !/^dia-ed-/.test(c)).join(' ');
    return limpo ? ` class=${q}${limpo}${q}` : '';
  });
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (t, attrs, corpo) => {
    const src = atributoDe('<s' + attrs + '>', 'src');
    return (src ? scriptsSrc.has(src) : scriptsTexto.has(norm(corpo))) ? t : '';
  });
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, t => iframes.has(atributoDe(t, 'src')) ? t : '');
  html = html.replace(/\s(on[a-z]+)\s*=\s*("([^"]*)"|'([^']*)')/gi, (t, n, v, a, b) => eventos.has(n.toLowerCase() + '=' + norm(decodificarAtributo(a !== undefined ? a : b))) ? t : '');
  html = html.replace(/\s(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, (t, n, v) => jsLinks.has(norm(decodificarAtributo(v.slice(1, -1)))) ? t : '');
  if (!/^\s*<!doctype/i.test(html)) html = '<!DOCTYPE html>\n' + html;
  return html;
}

app.post('/site-pagina-guardar', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const slug = String(req.body.pagina || 'inicio');
    const site = await siteDoDono(owner, site_id);
    if (!site) return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    if (site['Status'] !== 'Pronto') return res.json({ status: 'error', message: 'Espera o site acabar de ser gerado antes de guardar.' });
    const novo = String(req.body.html || '');
    if (novo.length < 200 || novo.length > 3 * 1024 * 1024 || !/<html\b/i.test(novo) || !/<body\b/i.test(novo)) {
      return res.json({ status: 'error', message: 'A página veio incompleta. Não foi guardada.' });
    }
    const actual = await lerPaginaDoSite(site, slug);
    const tipo = site['Tipo'] || 'Landing Page';
    let html = limparHtmlDoEditor(novo, actual.html);
    html = manterMetasLoja(actual.html, html);
    const ehLoja = tipo === 'E-commerce' || tipo === 'Checkout';
    html = injectarLojaSeNecessario(html, ehLoja, site_id);
    html = injectarGaleriaSeNecessario(html, tipo === 'Galeria', site_id);
    html = injectarPortfolioSeNecessario(html, tipo === 'Portefólio', site_id);
    html = injectarBlogSeNecessario(html, tipo === 'Blog', site_id);
    html = injectarContactoSeNecessario(html, site_id);
    html = injectarQuizSeNecessario(html, ehLoja, site_id);
    html = aplicarRedeResponsiva(html);
    html = aplicarMarcaDeAgua(html, !(await temPlanoPago(owner)));
    const url = await guardarPaginaDoSite(site, slug, html);
    return res.json({ status: 'success', response: { url } });
  } catch (erro) {
    if (erro.utilizador) return res.json({ status: 'error', message: erro.utilizador });
    console.error('Erro em /site-pagina-guardar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível guardar. Tenta outra vez.' });
  }
});

app.post('/editor-imagem', async (req, res) => {
  try {
    const site = await siteDoDono(req.body.owner, req.body.site_id);
    if (!site) return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    const dados = String(req.body.imagem_data_url || '');
    if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(dados) || dados.length > 8 * 1024 * 1024) {
      return res.json({ status: 'error', message: 'Escolhe uma imagem JPG, PNG ou WEBP com menos de 6 MB.' });
    }
    const r = await uploadImagemBase64('sites-editor', req.body.owner, dados);
    if (r.erro) return res.json({ status: 'error', message: r.erro });
    if (!r.url) return res.json({ status: 'error', message: 'Não foi possível ler a imagem.' });
    return res.json({ status: 'success', response: { url: r.url } });
  } catch (erro) {
    console.error('Erro em /editor-imagem:', erro);
    return res.json({ status: 'error', message: 'Não foi possível enviar a imagem.' });
  }
});

// ---- Mudar só um bloco com a IA (em fundo; a página pergunta o estado) ----
const trabalhosBloco = new Map();
setInterval(() => {
  const limite = Date.now() - 30 * 60 * 1000;
  for (const [k, t] of trabalhosBloco) if (t.criado < limite) trabalhosBloco.delete(k);
}, 5 * 60 * 1000).unref();
async function editarBlocoIA({ blocoHtml, pedido, casca, idioma, nome, tipo, fotos }) {
  const lingua = normalizarIdioma(idioma);
  const sistema = `És o motor de edição de blocos da Daniel IA. Recebes o HTML de UMA secção de um site e um pedido de alteração.
Devolve só essa secção já alterada: o mesmo elemento de topo (a mesma tag e as mesmas classes de topo), sem markdown, sem explicações, sem <html>, <head>, <body> nem <script>.
Mantém o estilo do site: usa as classes e as fichas --dia-* do CSS que recebes. Se precisares de CSS novo, põe um único <style> como primeiro filho da secção, com seletores que comecem pelo seletor da própria secção.
O resultado tem de continuar profissional, acabado e responsivo (360, 768, 1280 px). Mantém tudo o que o pedido não manda mudar.
Não mexas em divs com id que começa por "daniel-ia-" (são sistemas automáticos) - mantém-nas exactamente como estão.
IDIOMA: ${IDIOMAS_SITE[lingua].instrucao}${instrucaoFotos(fotos)}`;
  const conteudo = `Negócio: ${nome} (${tipo})
PEDIDO: ${pedido}

CSS do site:
${cssDaCasca(casca).slice(0, 40000)}

SECÇÃO A ALTERAR:
${blocoHtml}`;
  const res = await fetchGeracao('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_MODEL, reasoning_effort: OPENAI_REASONING_EFFORT, max_completion_tokens: 16000, messages: [{ role: 'system', content: sistema }, { role: 'user', content: conteudo }] })
  });
  const json = await res.json();
  if (!res.ok) throw new Error('OpenAI falhou: ' + JSON.stringify(json).slice(0, 300));
  let html = String((json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '').trim();
  html = html.replace(/^```(html)?\s*/i, '').replace(/```\s*$/i, '').trim().replace(/<script\b[\s\S]*?<\/script>/gi, '');
  if (!/^<[a-z]/i.test(html) || html.replace(/<[^>]+>/g, '').trim().length < 2) throw new Error('A IA devolveu um bloco vazio.');
  return { html, tokens: (json.usage && json.usage.total_tokens) || 0 };
}
app.post('/editar-bloco', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const pedido = textoCurto(req.body.pedido, 900);
    const bloco = String(req.body.bloco_html || '');
    const site = await siteDoDono(owner, site_id);
    if (!site) return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    if (pedido.length < 3) return res.json({ status: 'error', message: 'Escreve o que queres mudar neste bloco.' });
    if (bloco.length < 10 || bloco.length > 200000) return res.json({ status: 'error', message: 'Este bloco é demasiado grande para mudar de uma vez. Escolhe uma parte mais pequena.' });
    const user = await bubbleGet('user', owner);
    const planId = await garantirPlano(owner, user);
    const plano = planId ? await bubbleGet('plan', planId) : null;
    if (!plano || semTokens(user, plano)) return res.json({ status: 'error', codigo: 'tokens', message: MSG_SEM_TOKENS });
    const id = crypto.randomBytes(9).toString('hex');
    trabalhosBloco.set(id, { owner, estado: 'a trabalhar', criado: Date.now() });
    res.json({ status: 'success', response: { trabalho_id: id } });
    (async () => {
      const t = trabalhosBloco.get(id);
      try {
        const actual = await lerPaginaDoSite(site, String(req.body.pagina || 'inicio'));
        const e = lerJsonSeguro(site['Variantes Json'], {}) || {};
        const r = await editarBlocoIA({ blocoHtml: bloco, pedido, casca: actual.html, idioma: idiomaDoHtml(actual.html) || 'pt', nome: site['Nome'] || '', tipo: site['Tipo'] || '', fotos: e.fotos || [] });
        await cobrarTokens(owner, r.tokens);
        Object.assign(t, { estado: 'pronto', html: r.html });
      } catch (erro) {
        console.error('Erro em /editar-bloco:', erro.message || erro);
        Object.assign(t, { estado: 'erro', erro: 'A IA não conseguiu mudar este bloco. Tenta descrever de outra forma.' });
      }
    })();
  } catch (erro) {
    console.error('Erro em /editar-bloco:', erro);
    return res.json({ status: 'error', message: 'Não foi possível começar. Tenta outra vez.' });
  }
});
app.post('/editar-bloco-estado', (req, res) => {
  const t = trabalhosBloco.get(String(req.body.trabalho_id || ''));
  if (!t || t.owner !== req.body.owner) return res.json({ status: 'error', message: 'Este pedido já não existe. Tenta outra vez.' });
  return res.json({ status: 'success', response: { estado: t.estado, html: t.html || '', erro: t.erro || '' } });
});

// ---- Transformar um site antigo (uma página só) num site com várias páginas ----
async function reescreverMenuIA({ cabecalho, plano, idioma }) {
  const sistema = 'És o motor de edição de blocos da Daniel IA. Recebes o <header> de um site e a lista das páginas novas. Devolve só o <header> completo alterado, sem markdown e sem explicações.';
  const conteudo = `As páginas do site passam a ser: ${plano.filter(p => p.menu !== false).map(p => `${p.nav} (${p.ficheiro})`).join(', ')}.
Muda o menu (no computador e no telemóvel) para ter exactamente estes links, por esta ordem, com href igual ao nome do ficheiro. O logótipo leva a index.html. Botões do cabeçalho que apontavam para "#contacto" ou parecido passam a levar a contacto.html (se existir). Mantém tudo o resto igual (classes, estrutura, estilo), os textos no idioma ${IDIOMAS_SITE[normalizarIdioma(idioma)].nome} e o atributo data-dia="cabecalho" no <header>.

${cabecalho}`;
  const res = await fetchGeracao('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_MODEL_RAPIDO || OPENAI_MODEL, reasoning_effort: 'low', max_completion_tokens: 8000, messages: [{ role: 'system', content: sistema }, { role: 'user', content: conteudo }] })
  });
  const json = await res.json();
  if (!res.ok) throw new Error('OpenAI falhou: ' + JSON.stringify(json).slice(0, 300));
  let html = String((json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '').trim();
  html = html.replace(/^```(html)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const ini = html.search(/<header\b/i);
  const fim = ini >= 0 ? fimDoElemento(html, ini, 'header') : -1;
  if (ini < 0 || fim < 0) throw new Error('A IA não devolveu o cabeçalho.');
  html = html.slice(ini, fim);
  if (!/data-dia=["']cabecalho["']/.test(html)) html = html.replace(/<header\b/i, '<header data-dia="cabecalho"');
  return { html, tokens: (json.usage && json.usage.total_tokens) || 0 };
}
app.post('/site-paginas-criar', async (req, res) => {
  try {
    const { owner, site_id } = req.body;
    const site = await siteDoDono(owner, site_id);
    if (!site) return res.json({ status: 'error', message: 'Este projecto não te pertence.' });
    if (siteMultiPagina(site)) return res.json({ status: 'error', message: 'Este site já tem várias páginas.' });
    if (site['Status'] !== 'Pronto' || !site['Bunny Path']) return res.json({ status: 'error', message: 'Este projecto ainda não está pronto.' });
    const user = await bubbleGet('user', owner);
    const planId = await garantirPlano(owner, user);
    const plano = planId ? await bubbleGet('plan', planId) : null;
    if (!plano || semTokens(user, plano)) return res.json({ status: 'error', codigo: 'tokens', message: MSG_SEM_TOKENS });
    const pago = String(plano['Name'] || '').trim().toLowerCase() !== 'free';
    await mudarEstadoSite(site_id, e => { e.paginas = { estado: 'a planear', lista: [] }; return e; });
    res.json({ status: 'success', response: { site_id } });
    (async () => {
      try {
        let html = (await descarregarDoBunny(site['Bunny Path'])).toString('utf8');
        const idioma = idiomaDoHtml(html) || 'pt';
        const plan = await planearSite({ tipo: site['Tipo'] || 'Landing Page', nome: site['Nome'] || '', prompt: site['Prompt Original'] || site['Nome'] || '', idioma, pago, comFotos: false });
        html = marcarEstrutura(html);
        if (!partesDoHtml(html)) throw new Error('sem estrutura');
        const ih = html.search(/<header\b[^>]*data-dia=["']cabecalho["']/i);
        const fh = ih >= 0 ? fimDoElemento(html, ih, 'header') : -1;
        let tokens = plan.tokens;
        if (ih >= 0 && fh > ih) {
          const menu = await reescreverMenuIA({ cabecalho: html.slice(ih, fh), plano: plan.paginas, idioma });
          tokens += menu.tokens;
          html = html.slice(0, ih) + menu.html + html.slice(fh);
        }
        // O formulário de contacto passa para a página Contacto.
        html = html.replace(/<div\b[^>]*id=["']daniel-ia-contacto["'][^>]*>\s*<\/div>/i, '');
        html = prepararCasca(html, plan.paginas);
        await uploadParaBunny(site['Bunny Path'], Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
        await purgeCacheBunny(site['CDN URL']);
        await cobrarTokens(owner, tokens);
        await mudarEstadoSite(site_id, e => { e.plano_paginas = plan.paginas; return e; });
        await construirPaginas(site_id, {});
      } catch (erro) {
        console.error('Erro a criar as páginas de ' + site_id + ':', erro.message || erro);
        await mudarEstadoSite(site_id, e => { e.paginas = { estado: 'erro', lista: [] }; delete e.plano_paginas; return e; });
      }
    })();
  } catch (erro) {
    console.error('Erro em /site-paginas-criar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível começar. Tenta outra vez.' });
  }
});

// ======================================================
// Quiz antes do checkout (1.60.0)
// ------------------------------------------------------
// Perguntas com pontos; no fim aparece o resultado e só então o checkout.
// A configuração fica no "Loja Blocos Json" do site (chave "quiz"), ao
// lado da montra e das categorias. As respostas ficam num ficheiro JSON no
// Bunny (quiz/<site>.json), sem precisar de mais nada no Bubble.
// ======================================================
['/quiz-config', '/quiz-guardar', '/quiz-gerar', '/quiz-respostas'].forEach(r => ROTAS_PRIVADAS.add(r));
Object.assign(LIMITES, {
  '/quiz-responder': [['ip', 20, 10 * MIN], ['site', 400, 60 * MIN]],
  '/quiz-guardar': [['owner', 60, 10 * MIN]],
  '/quiz-gerar': [['owner', 12, 60 * MIN]]
});
function inteiroEntre(v, min, max, padrao) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
}
function limparQuiz(q) {
  q = (q && typeof q === 'object') ? q : {};
  const perguntas = (Array.isArray(q.perguntas) ? q.perguntas : []).slice(0, 15).map(p => {
    p = p && typeof p === 'object' ? p : {};
    return {
      texto: textoLimpo(p.texto, 220),
      ajuda: textoLimpo(p.ajuda, 220),
      imagem: linkImagem(p.imagem),
      opcoes: (Array.isArray(p.opcoes) ? p.opcoes : []).slice(0, 6).map(o => ({ texto: textoLimpo(o && o.texto, 140), pontos: inteiroEntre(o && o.pontos, -100, 100, 0) })).filter(o => o.texto)
    };
  }).filter(p => p.texto && p.opcoes.length >= 2);
  const resultados = (Array.isArray(q.resultados) ? q.resultados : []).slice(0, 6).map(r => ({
    min: inteiroEntre(r && r.min, -1000, 10000, 0),
    titulo: textoLimpo(r && r.titulo, 100),
    texto: textoLimpo(r && r.texto, 600),
    botao: textoLimpo(r && r.botao, 40)
  })).filter(r => r.titulo).sort((a, b) => a.min - b.min);
  return {
    ativo: q.ativo === true && perguntas.length > 0,
    bloquear: q.bloquear !== false,
    mostrar_pontos: q.mostrar_pontos !== false,
    captar: ['nao', 'opcional', 'obrigatorio'].includes(q.captar) ? q.captar : 'opcional',
    etiqueta: textoLimpo(q.etiqueta, 40),
    titulo: textoLimpo(q.titulo, 140),
    subtitulo: textoLimpo(q.subtitulo, 300),
    botao_iniciar: textoLimpo(q.botao_iniciar, 40),
    cta: textoLimpo(q.cta, 40),
    perguntas,
    resultados
  };
}
function quizDoSite(site) {
  const m = lerJsonSeguro(site && site['Loja Blocos Json'], {}) || {};
  return m.quiz ? limparQuiz(m.quiz) : null;
}
async function guardarQuizNoSite(siteId, quiz) {
  const site = await bubbleGet('site', siteId);
  const m = lerJsonSeguro(site && site['Loja Blocos Json'], {}) || {};
  m.quiz = limparQuiz(quiz);
  await bubblePatch('site', siteId, { 'Loja Blocos Json': JSON.stringify(m) });
  return m.quiz;
}
function injectarQuizSeNecessario(html, ehLoja, siteId) {
  if (!ehLoja || /quiz\.js/.test(html)) return html;
  const pagina = metaDoHtml(html, 'daniel-ia-pagina');
  if (pagina && pagina !== 'inicio') return html;
  const s = `\n<script src="${SELF_URL}/quiz.js" defer></script>\n`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, s + '</body>') : html + s;
}
const INSTRUCAO_QUIZ = `\nQUIZ ANTES DO CHECKOUT: esta página abre com um quiz de perguntas com pontos; só no fim aparece a oferta. Logo a seguir ao cabeçalho (antes da div da loja), põe exactamente <div id="daniel-ia-quiz"></div>, numa secção com fundo suave e um título curto por cima a convidar a responder (ex: "Descobre em 1 minuto o ideal para ti"). O quiz a sério aparece sozinho lá dentro - não escrevas tu perguntas nem botões. As secções de benefícios e garantias ficam depois da div da loja.`;

const SISTEMA_QUIZ = 'És especialista em funis de venda com quiz (como os quizzes de marketing do Brasil): perguntas curtas e envolventes que fazem a pessoa pensar no problema dela, '
  + 'dão pontos e no fim mostram um resultado que leva naturalmente à oferta. Respondes só com um objecto JSON válido.';
async function gerarQuizIA({ nome, tipo, prompt, descricao, idioma, produtos }) {
  const lingua = normalizarIdioma(idioma);
  const pedido = [
    `Negócio: ${nome} (${tipo}). Idioma do quiz: ${IDIOMAS_SITE[lingua].nome} - todos os textos nesse idioma.`,
    `Sobre o negócio e a oferta: ${textoCurto(prompt, 1200)}`,
    descricao ? `O que o dono quer no quiz: ${textoCurto(descricao, 800)}` : '',
    produtos && produtos.length ? `Produtos à venda: ${produtos.slice(0, 12).join('; ')}` : '',
    'Cria 5 a 7 perguntas, cada uma com 3 ou 4 opções curtas. Cada opção vale de 0 a 10 pontos: mais pontos = mais a pessoa precisa/combina com a oferta.',
    'Cria 3 resultados (faixas de pontuação, "min" é a pontuação mínima de cada faixa, a primeira com min 0), do menos ao mais, cada um com título forte, um texto de 1 a 3 frases que liga o resultado à oferta e o texto do botão (ex: "Ver a minha oferta").',
    'Também: "etiqueta" (ex: "Quiz de 1 minuto"), "titulo" (chamativo, uma pergunta ou promessa), "subtitulo" (uma frase), "botao_iniciar", "cta" (botão final por omissão).',
    'Sê honesto: nada de promessas de saúde, dinheiro fácil ou resultados garantidos.',
    'Formato exacto: {"etiqueta":"...","titulo":"...","subtitulo":"...","botao_iniciar":"...","cta":"...","perguntas":[{"texto":"...","opcoes":[{"texto":"...","pontos":0}]}],"resultados":[{"min":0,"titulo":"...","texto":"...","botao":"..."}]}'
  ].filter(Boolean).join('\n');
  const r = await chamarJsonIA(SISTEMA_QUIZ, pedido, 6000);
  const quiz = limparQuiz(Object.assign({}, r.dados, { ativo: true, bloquear: true, mostrar_pontos: true, captar: 'opcional' }));
  if (!quiz.perguntas.length) throw new Error('O quiz veio sem perguntas.');
  return { quiz, tokens: r.tokens };
}

// ---- Rotas ----
app.post('/quiz-ler', async (req, res) => {
  try {
    const site = await bubbleGet('site', req.body.site_id).catch(() => null);
    const quiz = site ? quizDoSite(site) : null;
    return res.json({ status: 'success', response: { quiz: quiz && quiz.ativo ? quiz : null } });
  } catch (erro) {
    return res.json({ status: 'success', response: { quiz: null } });
  }
});
app.post('/quiz-config', async (req, res) => {
  try {
    const site = await siteDoDono(req.body.owner, req.body.site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para ver esta loja.' });
    const respostas = await lerRespostasQuiz(site._id);
    return res.json({ status: 'success', response: { quiz: quizDoSite(site), total_respostas: respostas.length, cdn_url: site['CDN URL'] || '', tipo: site['Tipo'] || '' } });
  } catch (erro) {
    console.error('Erro em /quiz-config:', erro);
    return res.json({ status: 'error', message: 'Não foi possível ler o quiz.' });
  }
});
app.post('/quiz-guardar', async (req, res) => {
  try {
    const site = await siteDoDono(req.body.owner, req.body.site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para alterar esta loja.' });
    const q = limparQuiz(req.body.quiz);
    if (req.body.quiz && req.body.quiz.ativo === true && !q.perguntas.length) return res.json({ status: 'error', message: 'O quiz precisa de pelo menos uma pergunta com duas opções.' });
    if (q.ativo && !q.resultados.length) return res.json({ status: 'error', message: 'Junta pelo menos um resultado.' });
    const quiz = await guardarQuizNoSite(site._id, q);
    // Sites antigos: o quiz precisa do script na página inicial.
    if (quiz.ativo && site['Bunny Path']) {
      const html = (await descarregarDoBunny(site['Bunny Path'])).toString('utf8');
      const tipo = site['Tipo'] || '';
      const novo = injectarQuizSeNecessario(html, tipo === 'E-commerce' || tipo === 'Checkout', site._id);
      if (novo !== html) {
        const url = await uploadParaBunny(site['Bunny Path'], Buffer.from(novo, 'utf8'), 'text/html; charset=utf-8');
        await purgeCacheBunny(url);
      }
    }
    return res.json({ status: 'success', response: { quiz } });
  } catch (erro) {
    console.error('Erro em /quiz-guardar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível guardar o quiz.' });
  }
});
app.post('/quiz-gerar', async (req, res) => {
  try {
    const { owner } = req.body;
    const site = await siteDoDono(owner, req.body.site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para alterar esta loja.' });
    const user = await bubbleGet('user', owner);
    const planId = await garantirPlano(owner, user);
    const plano = planId ? await bubbleGet('plan', planId) : null;
    if (!plano || semTokens(user, plano)) return res.json({ status: 'error', codigo: 'tokens', message: MSG_SEM_TOKENS });
    const produtos = (await produtosDaLoja(site._id).catch(() => [])).map(p => `${p['Nome']} (${Number(p['Preco MZN']) || 0} MZN)`);
    const html = site['Bunny Path'] ? (await descarregarDoBunny(site['Bunny Path']).catch(() => Buffer.from(''))).toString('utf8') : '';
    const r = await gerarQuizIA({ nome: site['Nome'] || '', tipo: site['Tipo'] || '', prompt: site['Prompt Original'] || '', descricao: textoCurto(req.body.descricao, 800), idioma: idiomaDoHtml(html) || 'pt', produtos });
    await cobrarTokens(owner, r.tokens);
    return res.json({ status: 'success', response: { quiz: r.quiz } });
  } catch (erro) {
    console.error('Erro em /quiz-gerar:', erro.message || erro);
    return res.json({ status: 'error', message: 'A IA não conseguiu criar o quiz agora. Tenta outra vez.' });
  }
});

// ---- Respostas (ficheiro JSON no Bunny, uma fila por site) ----
const filaQuiz = new Map();
async function lerRespostasQuiz(siteId) {
  try { const l = JSON.parse((await descarregarDoBunny(`quiz/${siteId}.json`)).toString('utf8')); return Array.isArray(l) ? l : []; }
  catch (e) { return []; }
}
function juntarRespostaQuiz(siteId, resposta) {
  const anterior = filaQuiz.get(siteId) || Promise.resolve();
  const proximo = anterior.catch(() => {}).then(async () => {
    const lista = await lerRespostasQuiz(siteId);
    lista.unshift(resposta);
    await uploadParaBunny(`quiz/${siteId}.json`, Buffer.from(JSON.stringify(lista.slice(0, 5000)), 'utf8'), 'application/json; charset=utf-8');
  });
  filaQuiz.set(siteId, proximo);
  return proximo;
}
app.post('/quiz-responder', async (req, res) => {
  try {
    const site = await bubbleGet('site', req.body.site_id).catch(() => null);
    const quiz = site ? quizDoSite(site) : null;
    if (!quiz || !quiz.ativo) return res.json({ status: 'error', message: 'Quiz indisponível.' });
    const escolhas = (Array.isArray(req.body.respostas) ? req.body.respostas : []).slice(0, quiz.perguntas.length).map(v => parseInt(v, 10));
    let pontos = 0;
    const detalhe = quiz.perguntas.map((p, i) => {
      const o = Number.isInteger(escolhas[i]) ? p.opcoes[escolhas[i]] : null;
      if (o) pontos += o.pontos;
      return o ? o.texto : '';
    });
    let resultado = '';
    quiz.resultados.forEach(r => { if (pontos >= r.min) resultado = r.titulo; });
    await juntarRespostaQuiz(site._id, {
      data: new Date().toISOString(),
      nome: textoLimpo(req.body.nome, 80),
      contacto: textoLimpo(req.body.contacto, 120),
      pontos, resultado, respostas: detalhe,
      completo: detalhe.every(Boolean)
    });
    return res.json({ status: 'success', response: { pontos, resultado } });
  } catch (erro) {
    console.error('Erro em /quiz-responder:', erro);
    return res.json({ status: 'error', message: 'Não foi possível registar a resposta.' });
  }
});
app.post('/quiz-respostas', async (req, res) => {
  try {
    const site = await siteDoDono(req.body.owner, req.body.site_id);
    if (!site) return res.json({ status: 'error', message: 'Não tens permissão para ver esta loja.' });
    const lista = await lerRespostasQuiz(site._id);
    return res.json({ status: 'success', response: { respostas: lista.slice(0, 1000), total: lista.length } });
  } catch (erro) {
    console.error('Erro em /quiz-respostas:', erro);
    return res.json({ status: 'error', message: 'Não foi possível ler as respostas.' });
  }
});
app.get('/quiz.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  return res.send(QUIZ_JS);
});

app.listen(PORT, () => {
  console.log(`daniel-ia-proxy v${VERSION} a correr na porta ${PORT}`);
});
