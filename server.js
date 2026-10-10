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
const VERSION = '1.15.0';

// Remove um "http://" ou "https://" que já esteja no valor, para nunca
// ficarmos com "https://https://..." ao montarmos o URL
function semProtocolo(valor) {
  return clean(valor).replace(/^https?:\/\//i, '');
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
  'E-commerce': 'Cria uma loja online com uma grelha de produtos de exemplo coerentes com o prompt (nome, preço em MZN, imagem via placeholder de cor), botões "Adicionar ao carrinho" (só visuais, sem funcionar de verdade por agora), e rodapé com contactos.',
  'Checkout': 'Cria uma página de checkout para um único produto ou serviço descrito no prompt: resumo da compra, campos de nome/telefone/email, e botões de pagamento (M-Pesa, e-Mola, Cartão) só visuais por agora, sem processar pagamento real.',
  'Landing Page': 'Cria uma landing page de uma página: secção hero com título forte, benefícios/funcionalidades, depoimentos fictícios coerentes, chamada para acção clara, e rodapé com contactos.',
  'Portefólio': 'Cria um portefólio pessoal/profissional: secção "sobre", grelha de projectos/trabalhos de exemplo coerentes com o prompt, e secção de contacto.',
  'Blog': 'Cria uma página inicial de blog: cabeçalho com o nome do negócio, e uma grelha de artigos de exemplo (título, resumo curto, data), coerentes com o tema do prompt.'
};

async function gerarComOpenAI({ nome, tipo, prompt, logoUrl }) {
  const guia = GUIA_TIPO[tipo] || GUIA_TIPO['Landing Page'];
  const instrucaoLogo = logoUrl
    ? `A pessoa forneceu um logótipo. Usa exactamente esta imagem no cabeçalho: ${logoUrl}`
    : `A pessoa não forneceu logótipo. Cria um wordmark simples em texto com o nome do negócio, bem estilizado.`;

  const systemPrompt = `Você é o motor de geração de sites da Daniel.ia, uma plataforma moçambicana.
Gera APENAS um ficheiro HTML completo e válido (doctype, head, body), com todo o CSS e JavaScript embutidos no mesmo ficheiro (nada de ficheiros externos, excepto fontes do Google Fonts se quiseres).
Não escrevas nenhuma explicação antes ou depois do código. Não uses blocos de markdown (não escrevas \`\`\`html nem \`\`\`). A resposta deve começar directamente com <!DOCTYPE html>.
O site deve ser responsivo, moderno e profissional, em português (de Moçambique, tom local mas correcto).
${guia}`;

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

  return { html, tokens };
}

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
    const { html, tokens } = await gerarComOpenAI({ nome, tipo, prompt, logoUrl });

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
    const checkoutUrl = jsonCartao.url || jsonCartao.checkout_url ||
      (jsonCartao.response && (jsonCartao.response.url || jsonCartao.response.checkout_url)) || '';
    const sessionId = jsonCartao.session_id || (jsonCartao.response && jsonCartao.response.session_id) || '';
    if (!checkoutUrl) {
      throw new Error('A MozPayment não devolveu nenhum link de checkout: ' + JSON.stringify(jsonCartao));
    }

    await bubblePatch('encomenda', encomenda_id, {
      'Metodo': 'cartao',
      'ID Pagamento': String(sessionId)
    });

    return res.json({ status: 'success', response: { tipo: 'cartao', checkout_url: checkoutUrl } });

  } catch (erro) {
    console.error('Erro em /loja-pagar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível iniciar o pagamento. Tenta novamente.' });
  }
});

// ---- Webhook da MozPayment (loja/checkout da Daniel.ia) ----
// Endereço secreto (em vez de assinatura, que a MozPayment não confirmou
// se envia) - só quem souber este URL exacto pode chamá-lo. É este URL
// que deves entregar à MozPayment para a carteira 1791654840450x516696877833912300.
// Por agora só regista o que chega, para confirmarmos a forma real do
// payload antes de ligarmos a lógica que marca a encomenda como paga.
app.post('/wh-loja-mz9k3f7xq2', async (req, res) => {
  console.log('Webhook da MozPayment (loja) recebido:', JSON.stringify(req.body));
  // Responder sempre 200 rapidamente - é o que a generalidade dos serviços
  // de pagamento espera, mesmo que ainda não façamos nada com os dados.
  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`daniel-ia-proxy v${VERSION} a correr na porta ${PORT}`);
});
