const express = require('express');

// Limpa variáveis de ambiente - remove espaços, aspas e barras a mais
function clean(value) {
  if (!value) return '';
  return value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\/+$/, '');
}

const PORT = process.env.PORT || 8080;
const VERSION = '1.20.0';

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

// ---- OpenAI ----
const OPENAI_API_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_MODEL = clean(process.env.OPENAI_MODEL) || 'gpt-5.6-sol';
const OPENAI_REASONING_EFFORT = clean(process.env.OPENAI_REASONING_EFFORT) || 'low';
const OPENAI_MAX_TOKENS = parseInt(clean(process.env.OPENAI_MAX_TOKENS), 10) || 16000;

// ---- MozPayment ----
// Credenciais da conta MozPayment da Daniel.ia (diferente da carteira do
// projecto Bag Security). Nunca aparecem em nenhum HTML gerado nem são
// devolvidas a nenhuma página - ficam só aqui no container.
const MOZPAYMENT_EMAIL = clean(process.env.MOZPAYMENT_EMAIL);
const MOZPAYMENT_SENHA = clean(process.env.MOZPAYMENT_SENHA);
const MOZPAYMENT_WALLET = clean(process.env.MOZPAYMENT_WALLET);

// Endereço público deste container - usado para montar o "return_url" que
// damos à MozPayment nos pagamentos por cartão (para onde o cliente volta
// depois de pagar).
const SELF_URL = clean(process.env.SELF_URL) || 'https://mc-8oxfde5o71.bunny.run';

const app = express();

// ---- CORS ----
// Sem isto, o browser bloqueia qualquer fetch() feito a partir das páginas
// do Bubble (daniel-ia.bubbleapps.io ou, mais tarde, bag-security.com) para
// este container, que vive noutro domínio (bunny.run).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '15mb' })); // 15mb para caber um logótipo em base64

// ======================================================
// Helpers - Bubble Data API
// ======================================================

async function bubbleGet(tipo, id) {
  const res = await fetch(`${BUBBLE_BASE}/${tipo}/${id}`, {
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
  const res = await fetch(`${BUBBLE_BASE}/${tipo}/${id}`, {
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

const GUIA_TIPO = {
  'E-commerce': 'Desenha a aparência de uma loja online: cabeçalho com o nome do negócio, uma secção de apresentação curta, e rodapé com contactos. NÃO desenhes produtos, carrinho, nem botões de compra - isso é tratado à parte, automaticamente (ver instrução obrigatória abaixo).',
  'Checkout': 'Desenha a aparência de uma página de loja/checkout simples e directa, focada num negócio pequeno: cabeçalho com o nome do negócio, uma frase curta de apresentação, e rodapé com contactos. NÃO desenhes produtos, carrinho, nem botões de compra ou pagamento - isso é tratado à parte, automaticamente (ver instrução obrigatória abaixo).',
  'Landing Page': 'Cria uma landing page de uma página: secção hero com título forte, benefícios/funcionalidades, depoimentos fictícios coerentes, chamada para acção clara, e rodapé com contactos.',
  'Portefólio': 'Cria um portefólio pessoal/profissional: secção "sobre", grelha de projectos/trabalhos de exemplo coerentes com o prompt, e secção de contacto.',
  'Blog': 'Cria uma página inicial de blog: cabeçalho com o nome do negócio, e uma grelha de artigos de exemplo (título, resumo curto, data), coerentes com o tema do prompt.'
};

async function gerarComOpenAI({ nome, tipo, prompt, logoUrl, siteId }) {
  const guia = GUIA_TIPO[tipo] || GUIA_TIPO['Landing Page'];
  const ehLoja = (tipo === 'E-commerce' || tipo === 'Checkout');
  const instrucaoLogo = logoUrl
    ? `A pessoa forneceu um logótipo. Usa exactamente esta imagem no cabeçalho: ${logoUrl}`
    : `A pessoa não forneceu logótipo. Cria um wordmark simples em texto com o nome do negócio, bem estilizado.`;

  // Para E-commerce/Checkout, a IA nunca escreve a lógica de produtos,
  // carrinho ou pagamento - isso é sempre o mesmo módulo testado por nós
  // (LOJA_CART_JS), injectado depois. A única coisa que a IA tem de
  // garantir é deixar esta div vazia algures na página.
  const instrucaoLoja = ehLoja
    ? `\nINSTRUÇÃO OBRIGATÓRIA: nesta página tens de incluir, algures dentro do <body>, exactamente esta div vazia, sem nada lá dentro: <div id="daniel-ia-produtos"></div> - é ali que os produtos a sério, o carrinho de compras e o pagamento vão aparecer sozinhos, geridos por um sistema à parte. Não escrevas tu nenhum produto, preço, botão "comprar" ou "adicionar ao carrinho" - só essa div vazia, bem posicionada na página (por exemplo, numa secção com título "Os nossos produtos" ou "A nossa loja").`
    : '';

  const systemPrompt = `Você é o motor de geração de sites da Daniel.ia, uma plataforma moçambicana.
Gera APENAS um ficheiro HTML completo e válido (doctype, head, body), com todo o CSS e JavaScript embutidos no mesmo ficheiro (nada de ficheiros externos, excepto fontes do Google Fonts se quiseres).
Não escrevas nenhuma explicação antes ou depois do código. Não uses blocos de markdown (não escrevas \`\`\`html nem \`\`\`). A resposta deve começar directamente com <!DOCTYPE html>.
O site deve ser responsivo, moderno e profissional, em português (de Moçambique, tom local mas correcto).
${guia}${instrucaoLoja}`;

  const userPrompt = `Nome do negócio: ${nome}
Tipo de projecto: ${tipo}
${instrucaoLogo}
Descrição pedida pela pessoa: ${prompt}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
        { role: 'user', content: userPrompt }
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

  // Para E-commerce/Checkout: garante a div dos produtos (defesa, caso a IA
  // se tenha esquecido) e injecta sempre o módulo fixo da loja antes de
  // </body>. Isto acontece sempre, nunca depende do que a IA escreveu.
  if (ehLoja) {
    if (!/id=["']daniel-ia-produtos["']/.test(html)) {
      html = html.replace(
        /<\/body>/i,
        '<div id="daniel-ia-produtos" style="max-width:1100px;margin:40px auto;padding:0 20px;"></div>\n</body>'
      );
    }
    const scriptLoja = `\n<script>window.DANIEL_IA_SITE_ID = ${JSON.stringify(siteId || '')};</script>\n<script src="${SELF_URL}/loja-cart.js"></script>\n`;
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, scriptLoja + '</body>');
    } else {
      html += scriptLoja;
    }
  }

  return { html, tokens };
}

// ======================================================
// Script fixo da loja (carrinho + checkout), servido directamente
// ======================================================
// Guardado aqui como texto para ser servido por /loja-cart.js. É este
// ficheiro que todos os sites de E-commerce/Checkout gerados carregam -
// nunca é a IA a escrever esta lógica.
const LOJA_CART_JS = `/*
  Daniel.ia - módulo fixo de loja (produtos, carrinho e checkout real)
  ---------------------------------------------------------------------
  Este ficheiro é servido pelo próprio container em /loja-cart.js e é
  carregado por TODOS os sites de E-commerce/Checkout gerados pela IA.
  A IA nunca escreve esta lógica - só desenha a aparência do site e deixa
  uma div com id="daniel-ia-produtos" onde este módulo mostra os produtos
  a sério, o carrinho, e o checkout ligado à MozPayment.

  Cada página gerada define, antes de carregar este ficheiro:
    window.DANIEL_IA_SITE_ID = 'xxxxx';
*/
(function(){
  'use strict';

  var CONTAINER_URL = 'https://mc-8oxfde5o71.bunny.run';
  var SITE_ID = window.DANIEL_IA_SITE_ID || '';

  if (!SITE_ID) {
    console.error('Daniel.ia: falta window.DANIEL_IA_SITE_ID nesta página - o módulo da loja não pode arrancar.');
    return;
  }

  var CART_KEY = 'daniel_ia_carrinho_' + SITE_ID;
  var produtosCache = [];
  var carrinho = lerCarrinho();

  // ======================================================
  // Carrinho (guardado no browser de quem está a comprar)
  // ======================================================
  function lerCarrinho(){
    try {
      var dados = localStorage.getItem(CART_KEY);
      return dados ? JSON.parse(dados) : {};
    } catch (e) { return {}; }
  }
  function guardarCarrinho(){
    try { localStorage.setItem(CART_KEY, JSON.stringify(carrinho)); } catch (e) {}
  }
  function limparCarrinho(){
    carrinho = {};
    guardarCarrinho();
  }

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
  // Estilos (isolados com o prefixo "dia-" para não colidir com o CSS
  // que a IA desenhou para o resto do site)
  // ======================================================
  function injectarEstilos(){
    var css = ''
      + '.dia-grelha{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:18px;margin:0;padding:0;}'
      + '.dia-produto-card{background:#fff;border:1px solid #e4e4e8;border-radius:14px;padding:14px;display:flex;flex-direction:column;font-family:inherit;}'
      + '.dia-produto-img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:10px;margin-bottom:10px;background:#f1f1f4;}'
      + '.dia-produto-img-vazia{display:flex;align-items:center;justify-content:center;}'
      + '.dia-produto-nome{font-weight:700;font-size:14px;margin-bottom:4px;color:#111;}'
      + '.dia-produto-preco{font-weight:700;font-size:14px;margin-bottom:10px;color:#111;}'
      + '.dia-btn-add{margin-top:auto;background:#111;color:#fff;border:none;border-radius:8px;padding:10px 12px;font-size:13px;font-weight:600;cursor:pointer;}'
      + '.dia-btn-add:hover{opacity:.88;}'
      + '.dia-vazio{color:#777;font-size:13px;}'
      + '.dia-carrinho-botao{position:fixed;right:20px;bottom:20px;z-index:99998;background:#111;color:#fff;border-radius:999px;padding:14px 18px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.25);font-family:inherit;}'
      + '.dia-painel-carrinho{position:fixed;top:0;right:-380px;width:360px;max-width:92vw;height:100%;background:#fff;box-shadow:-8px 0 24px rgba(0,0,0,.18);z-index:99999;transition:right .25s;display:flex;flex-direction:column;font-family:inherit;color:#111;}'
      + '.dia-painel-carrinho.aberto{right:0;}'
      + '.dia-painel-cabeca{display:flex;align-items:center;justify-content:space-between;padding:18px;border-bottom:1px solid #eee;}'
      + '.dia-painel-cabeca button{background:none;border:none;font-size:22px;cursor:pointer;line-height:1;color:#111;}'
      + '#dia-itens-carrinho{flex:1;overflow-y:auto;padding:14px 18px;}'
      + '.dia-item-carrinho{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;}'
      + '.dia-remover{background:none;border:none;color:#c0392b;font-size:12px;cursor:pointer;text-decoration:underline;}'
      + '.dia-total{padding:14px 18px;font-weight:700;font-size:15px;border-top:1px solid #eee;}'
      + '.dia-btn-principal{margin:0 18px 18px 18px;background:#111;color:#fff;border:none;border-radius:10px;padding:13px;font-size:14px;font-weight:700;cursor:pointer;}'
      + '.dia-btn-principal:disabled{opacity:.4;cursor:default;}'
      + '.dia-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit;}'
      + '.dia-modal{background:#fff;border-radius:16px;padding:26px;max-width:380px;width:100%;color:#111;max-height:90vh;overflow-y:auto;}'
      + '.dia-modal h3{margin:0 0 16px 0;font-size:17px;}'
      + '.dia-campo{margin-bottom:12px;}'
      + '.dia-campo label{display:block;font-size:12px;color:#666;margin-bottom:5px;font-weight:600;}'
      + '.dia-campo input{width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:8px;padding:10px 12px;font-size:14px;font-family:inherit;}'
      + '.dia-metodos{display:flex;flex-direction:column;gap:8px;margin-bottom:14px;}'
      + '.dia-metodo{border:1px solid #ddd;border-radius:10px;padding:12px;cursor:pointer;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;}'
      + '.dia-metodo.seleccionado{border-color:#111;background:#f7f7f7;}'
      + '.dia-msg-erro{color:#c0392b;font-size:12px;margin-top:8px;}'
      + '.dia-estado-pagamento{text-align:center;padding:10px 0;}'
      + '.dia-spinner{width:28px;height:28px;border-radius:50%;border:3px solid #e4e4e8;border-top-color:#111;animation:dia-girar .8s linear infinite;margin:0 auto 14px auto;}'
      + '@keyframes dia-girar{to{transform:rotate(360deg);}}'
      + '.dia-fechar-modal{background:none;border:none;color:#777;font-size:12px;cursor:pointer;text-decoration:underline;margin-top:10px;}';
    var style = document.createElement('style');
    style.setAttribute('data-daniel-ia', 'loja');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ======================================================
  // Montagem da UI (grelha + botão flutuante + painel do carrinho)
  // ======================================================
  function montarUI(){
    var alvo = document.getElementById('daniel-ia-produtos');
    if (!alvo) {
      console.error('Daniel.ia: falta uma div com id="daniel-ia-produtos" nesta página - os produtos não têm onde aparecer.');
      return;
    }
    alvo.innerHTML = '<div id="dia-grelha" class="dia-grelha"><p class="dia-vazio">A carregar produtos...</p></div>';

    var botaoCarrinho = document.createElement('div');
    botaoCarrinho.id = 'dia-carrinho-botao';
    botaoCarrinho.className = 'dia-carrinho-botao';
    botaoCarrinho.innerHTML = 'Carrinho (<span id="dia-carrinho-contagem">0</span>)';
    document.body.appendChild(botaoCarrinho);

    var painel = document.createElement('div');
    painel.id = 'dia-painel-carrinho';
    painel.className = 'dia-painel-carrinho';
    painel.innerHTML = ''
      + '<div class="dia-painel-cabeca"><strong>O teu carrinho</strong><button id="dia-fechar-painel">&times;</button></div>'
      + '<div id="dia-itens-carrinho"></div>'
      + '<div id="dia-total-carrinho" class="dia-total"></div>'
      + '<button id="dia-btn-finalizar" class="dia-btn-principal" disabled>Finalizar compra</button>';
    document.body.appendChild(painel);

    botaoCarrinho.addEventListener('click', function(){
      painel.classList.add('aberto');
    });
    document.getElementById('dia-fechar-painel').addEventListener('click', function(){
      painel.classList.remove('aberto');
    });
    document.getElementById('dia-btn-finalizar').addEventListener('click', abrirCheckout);
  }

  function renderGrelha(){
    var grelha = document.getElementById('dia-grelha');
    if (!grelha) return;
    if (produtosCache.length === 0) {
      grelha.innerHTML = '<p class="dia-vazio">Ainda não há produtos à venda aqui.</p>';
      return;
    }
    grelha.innerHTML = produtosCache.map(function(p){
      return ''
        + '<div class="dia-produto-card">'
        + (p.imagem ? '<img src="' + escaparAtributo(p.imagem) + '" class="dia-produto-img" alt="' + escaparAtributo(p.nome) + '">' : '<div class="dia-produto-img dia-produto-img-vazia"></div>')
        + '<div class="dia-produto-nome">' + escaparHtml(p.nome) + '</div>'
        + '<div class="dia-produto-preco">' + Number(p.preco).toLocaleString('pt-PT') + ' MZN</div>'
        + '<button class="dia-btn-add" data-id="' + p.id + '">Adicionar ao carrinho</button>'
        + '</div>';
    }).join('');

    var botoes = grelha.querySelectorAll('.dia-btn-add');
    botoes.forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-id');
        carrinho[id] = (carrinho[id] || 0) + 1;
        guardarCarrinho();
        renderCarrinho();
        var textoOriginal = btn.textContent;
        btn.textContent = 'Adicionado!';
        setTimeout(function(){ btn.textContent = textoOriginal; }, 1200);
      });
    });
  }

  function itensDoCarrinho(){
    return Object.keys(carrinho)
      .filter(function(id){ return carrinho[id] > 0; })
      .map(function(id){
        var produto = produtosCache.filter(function(p){ return p.id === id; })[0];
        return produto ? { produto: produto, quantidade: carrinho[id] } : null;
      })
      .filter(function(x){ return x; });
  }

  function renderCarrinho(){
    var itens = itensDoCarrinho();
    var contagem = itens.reduce(function(total, item){ return total + item.quantidade; }, 0);
    var elContagem = document.getElementById('dia-carrinho-contagem');
    if (elContagem) elContagem.textContent = contagem;

    var container = document.getElementById('dia-itens-carrinho');
    var elTotal = document.getElementById('dia-total-carrinho');
    var btnFinalizar = document.getElementById('dia-btn-finalizar');
    if (!container) return;

    if (itens.length === 0) {
      container.innerHTML = '<p class="dia-vazio">O carrinho está vazio.</p>';
      elTotal.textContent = '';
      btnFinalizar.disabled = true;
      return;
    }

    var total = 0;
    container.innerHTML = itens.map(function(item){
      var subtotal = item.produto.preco * item.quantidade;
      total += subtotal;
      return ''
        + '<div class="dia-item-carrinho">'
        + '<div>' + escaparHtml(item.produto.nome) + ' x' + item.quantidade + '</div>'
        + '<div>' + subtotal.toLocaleString('pt-PT') + ' MZN<br><button class="dia-remover" data-id="' + item.produto.id + '">Remover</button></div>'
        + '</div>';
    }).join('');
    elTotal.textContent = 'Total: ' + total.toLocaleString('pt-PT') + ' MZN';
    btnFinalizar.disabled = false;

    container.querySelectorAll('.dia-remover').forEach(function(btn){
      btn.addEventListener('click', function(){
        delete carrinho[btn.getAttribute('data-id')];
        guardarCarrinho();
        renderCarrinho();
      });
    });
  }

  // ======================================================
  // Checkout (nome, telefone, método, e o pagamento a sério)
  // ======================================================
  var metodoSeleccionado = '';

  function abrirCheckout(){
    var itens = itensDoCarrinho();
    if (itens.length === 0) return;

    var overlay = document.createElement('div');
    overlay.className = 'dia-overlay';
    overlay.id = 'dia-overlay-checkout';
    overlay.innerHTML = ''
      + '<div class="dia-modal">'
      + '<h3>Finalizar compra</h3>'
      + '<div id="dia-checkout-form">'
      + '<div class="dia-campo"><label>O teu nome</label><input type="text" id="dia-cliente-nome" maxlength="100"></div>'
      + '<div class="dia-campo"><label>Telefone</label><input type="text" id="dia-cliente-telefone" maxlength="20" placeholder="84xxxxxxx"></div>'
      + '<div class="dia-campo"><label>Método de pagamento</label>'
      + '<div class="dia-metodos">'
      + '<div class="dia-metodo" data-metodo="mpesa">M-Pesa</div>'
      + '<div class="dia-metodo" data-metodo="emola">e-Mola</div>'
      + '<div class="dia-metodo" data-metodo="cartao">Cartão (Visa / Mastercard)</div>'
      + '</div></div>'
      + '<button class="dia-btn-principal" id="dia-btn-pagar" style="margin:0;width:100%;">Pagar</button>'
      + '<div class="dia-msg-erro" id="dia-checkout-erro"></div>'
      + '</div>'
      + '<div id="dia-checkout-estado" style="display:none"></div>'
      + '<button class="dia-fechar-modal" id="dia-fechar-checkout">Fechar</button>'
      + '</div>';
    document.body.appendChild(overlay);

    metodoSeleccionado = '';
    overlay.querySelectorAll('.dia-metodo').forEach(function(el){
      el.addEventListener('click', function(){
        overlay.querySelectorAll('.dia-metodo').forEach(function(x){ x.classList.remove('seleccionado'); });
        el.classList.add('seleccionado');
        metodoSeleccionado = el.getAttribute('data-metodo');
      });
    });

    document.getElementById('dia-fechar-checkout').addEventListener('click', function(){
      overlay.remove();
    });

    document.getElementById('dia-btn-pagar').addEventListener('click', function(){
      iniciarPagamento(overlay, itens);
    });
  }

  function iniciarPagamento(overlay, itens){
    var nome = document.getElementById('dia-cliente-nome').value.trim();
    var telefone = document.getElementById('dia-cliente-telefone').value.trim();
    var elErro = document.getElementById('dia-checkout-erro');
    elErro.textContent = '';

    if (!nome) { elErro.textContent = 'Escreve o teu nome.'; return; }
    if (!telefone) { elErro.textContent = 'Escreve o teu telefone.'; return; }
    if (!metodoSeleccionado) { elErro.textContent = 'Escolhe um método de pagamento.'; return; }

    var btnPagar = document.getElementById('dia-btn-pagar');
    btnPagar.disabled = true;
    btnPagar.textContent = 'A processar...';

    var itensParaEnviar = itens.map(function(item){
      return { produto_id: item.produto.id, quantidade: item.quantidade };
    });

    fetch(CONTAINER_URL + '/loja-encomenda', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_id: SITE_ID,
        cliente_nome: nome,
        cliente_telefone: telefone,
        itens: itensParaEnviar
      })
    }).then(function(r){ return r.json(); })
      .then(function(rEncomenda){
        if (rEncomenda.status !== 'success') {
          throw new Error(rEncomenda.message || 'Não foi possível criar a encomenda.');
        }
        var encomendaId = rEncomenda.response.encomenda_id;
        return fetch(CONTAINER_URL + '/loja-pagar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ encomenda_id: encomendaId, metodo: metodoSeleccionado })
        }).then(function(r){ return r.json(); })
          .then(function(rPagar){
            if (rPagar.status !== 'success') {
              throw new Error(rPagar.message || 'Não foi possível iniciar o pagamento.');
            }
            return { encomendaId: encomendaId, pagamento: rPagar.response };
          });
      })
      .then(function(resultado){
        if (resultado.pagamento.tipo === 'cartao') {
          // Pagamento por cartão: sai desta página para a MozPayment, e
          // volta automaticamente à loja depois (via /loja-obrigado).
          window.location.href = resultado.pagamento.checkout_url;
          return;
        }
        // M-Pesa / e-Mola: fica aqui a aguardar a confirmação no telemóvel.
        limparCarrinho();
        renderCarrinho();
        mostrarEstadoPagamento(overlay, resultado.encomendaId);
      })
      .catch(function(erro){
        btnPagar.disabled = false;
        btnPagar.textContent = 'Pagar';
        elErro.textContent = erro.message || 'Algo correu mal. Tenta novamente.';
      });
  }

  function mostrarEstadoPagamento(overlay, encomendaId){
    document.getElementById('dia-checkout-form').style.display = 'none';
    var elEstado = document.getElementById('dia-checkout-estado');
    elEstado.style.display = 'block';
    elEstado.innerHTML = ''
      + '<div class="dia-estado-pagamento">'
      + '<div class="dia-spinner"></div>'
      + '<div id="dia-estado-texto">Confirma o pagamento no teu telemóvel...</div>'
      + '</div>';

    var tentativas = 0;
    var MAX_TENTATIVAS = 20;

    function verificar(){
      fetch(CONTAINER_URL + '/loja-estado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encomenda_id: encomendaId })
      }).then(function(r){ return r.json(); })
        .then(function(r){
          if (r.status === 'success' && r.response.estado === 'Pago') {
            elEstado.innerHTML = '<div class="dia-estado-pagamento"><strong>Pagamento confirmado!</strong><br>Obrigado pela tua compra.</div>';
            return;
          }
          tentativas++;
          if (tentativas >= MAX_TENTATIVAS) {
            elEstado.innerHTML = '<div class="dia-estado-pagamento">Ainda não recebemos a confirmação. Se já pagaste, aguarda mais um pouco - vais receber a confirmação normalmente.</div>';
            return;
          }
          setTimeout(verificar, 3000);
        })
        .catch(function(){
          tentativas++;
          if (tentativas >= MAX_TENTATIVAS) {
            elEstado.innerHTML = '<div class="dia-estado-pagamento">Não foi possível confirmar o pagamento agora. Verifica mais tarde.</div>';
            return;
          }
          setTimeout(verificar, 3000);
        });
    }
    verificar();
  }

  // ======================================================
  // Arranque
  // ======================================================
  function iniciar(){
    injectarEstilos();
    montarUI();
    renderCarrinho();

    fetch(CONTAINER_URL + '/loja-produtos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: SITE_ID })
    }).then(function(r){ return r.json(); })
      .then(function(r){
        if (r.status === 'success') {
          produtosCache = r.response.produtos || [];
          renderGrelha();
          renderCarrinho();
        } else {
          var grelha = document.getElementById('dia-grelha');
          if (grelha) grelha.innerHTML = '<p class="dia-vazio">Não foi possível carregar os produtos.</p>';
        }
      })
      .catch(function(){
        var grelha = document.getElementById('dia-grelha');
        if (grelha) grelha.innerHTML = '<p class="dia-vazio">Não foi possível ligar ao servidor.</p>';
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

// Nota sobre os nomes dos campos nas chamadas ao Bubble: têm de ser
// EXACTAMENTE como aparecem no editor do Bubble (maiúsculas e espaços
// incluídos) - a Data API não os converte para minúsculas.

app.post('/generate', async (req, res) => {
  try {
    const { owner, nome, tipo, prompt, logo_data_url } = req.body;

    if (!owner || !nome || !tipo || !prompt) {
      return res.json({ status: 'error', message: 'Faltam dados: nome, tipo e prompt são obrigatórios.' });
    }

    // ---- 1. Carregar utilizador e plano ----
    const user = await bubbleGet('user', owner);
    if (!user) {
      return res.json({ status: 'error', message: 'Utilizador não encontrado.' });
    }

    const planId = user['Plan'];
    if (!planId) {
      return res.json({ status: 'error', message: 'A tua conta não tem nenhum plano atribuído.' });
    }
    const plano = await bubbleGet('plan', planId);

    // ---- 2. Verificar limite de projectos ----
    const sitesExistentes = await bubbleCount('site', [{ key: 'Owner', constraint_type: 'equals', value: owner }]);
    if (sitesExistentes >= (plano['Sites Limit'] || 0)) {
      return res.json({ status: 'error', message: `O teu plano "${plano['Name']}" permite até ${plano['Sites Limit']} projecto(s). Já atingiste esse limite.` });
    }

    // ---- 3. Verificar limite de tokens do mês ----
    const tokensUsados = user['Tokens Usados Mes'] || 0;
    const tokensIncluidos = plano['Tokens Incluidos'] || 0;
    if (tokensUsados >= tokensIncluidos) {
      return res.json({ status: 'error', message: 'Já atingiste o limite de tokens de IA incluídos no teu plano este mês.' });
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

    res.json({
      status: 'success',
      response: { site_id: siteId, generation_id: generationId }
    });

    // ---- 5. Trabalho pesado, sem bloquear a resposta ----
    processarGeracao({ owner, nome, tipo, prompt, logo_data_url, siteId, generationId, tokensUsados })
      .catch(erro => console.error('Erro em processarGeracao:', erro));

  } catch (erro) {
    console.error('Erro em /generate:', erro);
    return res.json({ status: 'error', message: 'Não foi possível iniciar a geração. Tenta novamente.' });
  }
});

async function processarGeracao({ owner, nome, tipo, prompt, logo_data_url, siteId, generationId, tokensUsados }) {
  try {
    // ---- Logótipo (opcional) ----
    let logoUrl = '';
    if (logo_data_url) {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(logo_data_url);
      if (match) {
        const mime = match[1];
        const base64 = match[2];
        const buffer = Buffer.from(base64, 'base64');
        const extensao = mime.split('/')[1].replace('+xml', '').replace('jpeg', 'jpg');
        const caminhoLogo = `logos/${owner}-${Date.now()}.${extensao}`;
        logoUrl = await uploadParaBunny(caminhoLogo, buffer, mime);
      }
    }

    // ---- Gerar o HTML com a OpenAI ----
    const { html, tokens } = await gerarComOpenAI({ nome, tipo, prompt, logoUrl, siteId });

    // ---- Guardar o HTML no Bunny Storage ----
    const siteSlug = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    await bubblePatch('user', owner, {
      'Tokens Usados Mes': tokensUsados + tokens
    });

    // ---- Só agora marcamos o Site como "Pronto" ----
    // Chegar aqui significa que a Generation e o User já foram actualizados
    // com sucesso, por isso esta é a última coisa que pode falhar.
    await bubblePatch('site', siteId, {
      'Status': 'Pronto',
      'Bunny Path': caminhoSite,
      'CDN URL': cdnUrl,
      'Logo URL': logoUrl
    });

  } catch (erro) {
    console.error('Erro em processarGeracao:', erro);
    await bubblePatch('site', siteId, { 'Status': 'Erro' }).catch(() => {});
    await bubblePatch('generation', generationId, { 'Status': 'Erro' }).catch(() => {});
  }
}

app.post('/generate-status', async (req, res) => {
  try {
    const { site_id } = req.body;
    if (!site_id) {
      return res.json({ status: 'error', message: 'Falta o site_id.' });
    }
    const site = await bubbleGet('site', site_id);
    if (!site) {
      return res.json({ status: 'error', message: 'Projecto não encontrado.' });
    }
    return res.json({
      status: 'success',
      response: {
        estado: site['Status'],
        cdn_url: site['CDN URL'] || ''
      }
    });
  } catch (erro) {
    console.error('Erro em /generate-status:', erro);
    return res.json({ status: 'error', message: 'Não foi possível consultar o estado.' });
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
      criado: s['Created Date']
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

    const produtos = await bubbleList(
      'produto',
      [
        { key: 'Site', constraint_type: 'equals', value: site_id },
        { key: 'Is Active', constraint_type: 'equals', value: true }
      ],
      'Created Date',
      false
    );

    const lista = produtos.map(p => ({
      id: p._id,
      nome: p['Nome'],
      preco: p['Preco MZN'],
      descricao: p['Descricao'] || '',
      imagem: p['Imagem URL'] || ''
    }));

    return res.json({ status: 'success', response: { produtos: lista } });
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
    const { owner, site_id, nome, preco, descricao, imagem_url } = req.body;

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

    const produtoId = await bubbleCreate('produto', {
      'Site': site_id,
      'Nome': nome,
      'Preco MZN': precoNum,
      'Descricao': descricao || '',
      'Imagem URL': imagem_url || '',
      'Is Active': true
    });

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

    const lista = produtos.map(p => ({
      id: p._id,
      nome: p['Nome'],
      preco: p['Preco MZN'],
      descricao: p['Descricao'] || '',
      imagem: p['Imagem URL'] || '',
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
    const { owner, produto_id, nome, preco, descricao, imagem_url, activo } = req.body;
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
    if (nome !== undefined) dados['Nome'] = nome;
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

    await bubblePatch('produto', produto_id, dados);
    return res.json({ status: 'success' });
  } catch (erro) {
    console.error('Erro em /loja-produto-editar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível actualizar o produto.' });
  }
});

// Cria uma encomenda. O passo mais importante aqui, por segurança: o valor
// total NUNCA vem do que o browser envia - é sempre recalculado aqui, a
// partir dos preços reais guardados nos registos de Produto. Assim,
// ninguém consegue alterar o preço antes de pagar.
app.post('/loja-encomenda', async (req, res) => {
  try {
    const { site_id, cliente_nome, cliente_telefone, itens } = req.body;

    if (!site_id || !cliente_nome || !cliente_telefone || !Array.isArray(itens) || itens.length === 0) {
      return res.json({ status: 'error', message: 'Faltam dados: site_id, cliente_nome, cliente_telefone e itens são obrigatórios.' });
    }

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
    for (const item of itens) {
      const produto = porId[item.produto_id];
      if (!produto) {
        return res.json({ status: 'error', message: 'Um dos produtos já não está disponível nesta loja.' });
      }
      const quantidade = Math.max(1, parseInt(item.quantidade, 10) || 1);
      const precoUnitario = produto['Preco MZN'];
      valorTotal += precoUnitario * quantidade;
      itensCalculados.push({
        produto_id: produto._id,
        nome: produto['Nome'],
        preco_unitario: precoUnitario,
        quantidade
      });
    }

    if (valorTotal <= 0) {
      return res.json({ status: 'error', message: 'O valor da encomenda tem de ser maior que zero.' });
    }

    const encomendaId = await bubbleCreate('encomenda', {
      'Site': site_id,
      'Produtos Json': JSON.stringify(itensCalculados),
      'Cliente Nome': cliente_nome,
      'Cliente Telefone': cliente_telefone,
      'Valor Total': valorTotal,
      'Metodo': '',
      'ID Pagamento': '',
      'Estado': 'Pendente',
      'Transaction ID': '',
      'Webhook Processado': false
    });

    return res.json({ status: 'success', response: { encomenda_id: encomendaId, valor_total: valorTotal } });
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
        nome_producto: 'Encomenda Daniel.ia',
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

    return res.json({ status: 'success', response: { tipo: 'cartao', checkout_url: checkoutUrl } });

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
<style>
  :root{
    --bg:#0A0A12;
    --card:#14141F;
    --border:#24243A;
    --text:#F5F5F7;
    --text-dim:#9699B0;
    --accent-1:#A855F7;
    --accent-2:#6366F1;
    --success:#22C55E;
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
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:var(--bg);
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
  .icone.pago{background:rgba(34,197,94,0.14);}
  .icone.erro{background:rgba(255,92,122,0.14);}
  .spinner{
    width:24px;height:24px;
    border-radius:50%;
    border:3px solid var(--border);
    border-top-color:var(--warning);
    animation:girar .8s linear infinite;
  }
  @keyframes girar{to{transform:rotate(360deg);}}
  h1{font-size:18px;margin:0 0 8px 0;}
  p{font-size:13px;color:var(--text-dim);margin:0 0 24px 0;line-height:1.5;}
  .btn{
    display:inline-block;
    background:linear-gradient(135deg,var(--accent-1),var(--accent-2));
    color:#fff;
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
var CDN_URL = ${JSON.stringify(cdnUrl)};
var tentativas = 0;
var MAX_TENTATIVAS = 15;

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

// ---- Webhook da MozPayment (loja/checkout da Daniel.ia) ----
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
  } catch (erro) {
    console.error('Erro ao processar webhook da loja:', erro);
  }
});

app.listen(PORT, () => {
  console.log(`daniel-ia-proxy v${VERSION} a correr na porta ${PORT}`);
});
