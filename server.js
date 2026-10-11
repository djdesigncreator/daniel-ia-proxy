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
const VERSION = '1.30.0';

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

// ---- Bunny Stream (vídeo da Galeria) ----
// Video Library própria da conta Bunny do Daniel.ia, separada da storage
// zone/pull zone usadas para fotos e ficheiros dos sites. Vídeo não sobe
// em base64 (ficaria grande demais) - sobe directamente do browser para o
// Bunny Stream por TUS (upload com retoma), e este container só autoriza
// o upload e depois consulta o estado da conversão.
const STREAM_LIBRARY = clean(process.env.STREAM_LIBRARY);
const STREAM_KEY = clean(process.env.STREAM_KEY);
const STREAM_CDN = semProtocolo(process.env.STREAM_CDN);

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

async function bubbleDelete(tipo, id) {
  const res = await fetch(`${BUBBLE_BASE}/${tipo}/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${BUBBLE_TOKEN}` }
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error('bubbleDelete falhou: ' + JSON.stringify(json));
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
  const planId = user['Plan'];
  if (!planId) return { ok: false, message: 'A tua conta não tem nenhum plano atribuído.' };
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

const GUIA_TIPO = {
  'E-commerce': 'Desenha a aparência de uma loja online: cabeçalho com o nome do negócio, uma secção de apresentação curta, e rodapé com contactos. NÃO desenhes produtos, carrinho, nem botões de compra - isso é tratado à parte, automaticamente (ver instrução obrigatória abaixo).',
  'Checkout': 'Desenha a aparência de uma página de loja/checkout simples e directa, focada num negócio pequeno: cabeçalho com o nome do negócio, uma frase curta de apresentação, e rodapé com contactos. NÃO desenhes produtos, carrinho, nem botões de compra ou pagamento - isso é tratado à parte, automaticamente (ver instrução obrigatória abaixo).',
  'Landing Page': 'Cria uma landing page de uma página: secção hero com título forte, benefícios/funcionalidades, depoimentos fictícios coerentes, chamada para acção clara, e rodapé com contactos.',
  'Portefólio': 'Cria um portefólio pessoal/profissional: secção "sobre", e secção de contacto. NÃO desenhes trabalhos/projectos reais nem a grelha deles - isso é tratado à parte, automaticamente.',
  'Blog': 'Cria uma página inicial de blog: cabeçalho com o nome do negócio. NÃO desenhes artigos reais nem a grelha deles - isso é tratado à parte, automaticamente.',
  'Galeria': 'Cria a aparência de um site de fotógrafo/videógrafo profissional: cabeçalho com o nome, uma frase curta de apresentação, uma grelha de álbuns de exemplo (cada um com um título de trabalho, tipo "Casamento Ana & Jorge"), e secção de contacto. NÃO desenhes fotos/vídeos reais nem o visualizador dos álbuns - isso é tratado à parte, automaticamente.'
};

async function gerarComOpenAI({ nome, tipo, prompt, logoUrl, imagensUrls, siteId, mostrarMarcaDeAgua }) {
  const guia = GUIA_TIPO[tipo] || GUIA_TIPO['Landing Page'];
  const ehLoja = (tipo === 'E-commerce' || tipo === 'Checkout');
  const ehGaleria = (tipo === 'Galeria');
  const ehPortfolio = (tipo === 'Portefólio');
  const ehBlog = (tipo === 'Blog');
  const instrucaoLogo = logoUrl
    ? `A pessoa forneceu um logótipo. Usa exactamente esta imagem no cabeçalho: ${logoUrl}`
    : `A pessoa não forneceu logótipo. Cria um wordmark simples em texto com o nome do negócio, bem estilizado.`;

  // Imagens que a pessoa anexou ao pedido (fotos de produtos, da equipa,
  // do espaço, etc. - nada a ver com o logótipo, que é tratado à parte
  // acima). A IA usa-as nos sítios que fizerem sentido para o tipo de
  // site e para o que foi pedido; se não houver nenhuma, a secção fica
  // de fora do prompt por completo.
  const instrucaoImagens = (imagensUrls && imagensUrls.length)
    ? `\nA pessoa anexou ${imagensUrls.length} imagem(ns) a este pedido, para usares no site onde fizer sentido (ex: fotos de produtos, da equipa, do espaço, de trabalhos). Usa exactamente estes URLs, cada um no máximo uma vez:\n${imagensUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}`
    : '';

  // Para E-commerce/Checkout, a IA nunca escreve a lógica de produtos,
  // carrinho ou pagamento - isso é sempre o mesmo módulo testado por nós
  // (LOJA_CART_JS), injectado depois. A única coisa que a IA tem de
  // garantir é deixar esta div vazia algures na página.
  const instrucaoLoja = ehLoja
    ? `\nINSTRUÇÃO OBRIGATÓRIA: nesta página tens de incluir, algures dentro do <body>, exactamente esta div vazia, sem nada lá dentro: <div id="daniel-ia-produtos"></div> - é ali que os produtos a sério, o carrinho de compras e o pagamento vão aparecer sozinhos, geridos por um sistema à parte. Não escrevas tu nenhum produto, preço, botão "comprar" ou "adicionar ao carrinho" - só essa div vazia, bem posicionada na página (por exemplo, numa secção com título "Os nossos produtos" ou "A nossa loja").`
    : '';

  // Para a Galeria, o mesmo princípio do Loja: a IA nunca desenha álbuns,
  // fotos ou vídeos a sério, nem o visualizador - isso é sempre o mesmo
  // módulo testado por nós (GALERIA_VIEWER_JS), injectado depois.
  const instrucaoGaleria = ehGaleria
    ? `\nINSTRUÇÃO OBRIGATÓRIA: nesta página tens de incluir, algures dentro do <body>, exactamente esta div vazia, sem nada lá dentro: <div id="daniel-ia-galeria"></div> - é ali que os álbuns a sério (com as fotos e vídeos reais, e o visualizador deles) vão aparecer sozinhos, geridos por um sistema à parte. Não escrevas tu nenhum álbum, foto ou vídeo falso para além dos exemplos pedidos acima - só essa div vazia, bem posicionada na página (por exemplo, numa secção com título "Os nossos trabalhos" ou "Álbuns").`
    : '';

  // Para o Portefólio, o mesmo princípio: a IA nunca desenha trabalhos a
  // sério - isso é sempre o mesmo módulo testado por nós
  // (PORTFOLIO_VIEWER_JS), injectado depois.
  const instrucaoPortfolio = ehPortfolio
    ? `\nINSTRUÇÃO OBRIGATÓRIA: nesta página tens de incluir, algures dentro do <body>, exactamente esta div vazia, sem nada lá dentro: <div id="daniel-ia-portfolio"></div> - é ali que os trabalhos/projectos a sério vão aparecer sozinhos, geridos por um sistema à parte. Não escrevas tu nenhum trabalho/projecto falso para além dos exemplos pedidos acima - só essa div vazia, bem posicionada na página (por exemplo, numa secção com título "Trabalhos" ou "Projectos").`
    : '';

  // Para o Blog, o mesmo princípio: a IA nunca desenha artigos a sério -
  // isso é sempre o mesmo módulo testado por nós (BLOG_VIEWER_JS),
  // injectado depois.
  const instrucaoBlog = ehBlog
    ? `\nINSTRUÇÃO OBRIGATÓRIA: nesta página tens de incluir, algures dentro do <body>, exactamente esta div vazia, sem nada lá dentro: <div id="daniel-ia-blog"></div> - é ali que os artigos a sério vão aparecer sozinhos, geridos por um sistema à parte. Não escrevas tu nenhum artigo falso - só essa div vazia, bem posicionada na página (por exemplo, numa secção com título "Artigos" ou "Blog").`
    : '';

  const systemPrompt = `Você é o motor de geração de sites da Daniel.ia, uma plataforma moçambicana.
Gera APENAS um ficheiro HTML completo e válido (doctype, head, body), com todo o CSS e JavaScript embutidos no mesmo ficheiro (nada de ficheiros externos, excepto fontes do Google Fonts se quiseres).
Não escrevas nenhuma explicação antes ou depois do código. Não uses blocos de markdown (não escrevas \`\`\`html nem \`\`\`). A resposta deve começar directamente com <!DOCTYPE html>.
O site deve ser responsivo, moderno e profissional, em português (de Moçambique, tom local mas correcto).
${guia}${instrucaoLoja}${instrucaoGaleria}${instrucaoPortfolio}${instrucaoBlog}`;

  const userPrompt = `Nome do negócio: ${nome}
Tipo de projecto: ${tipo}
${instrucaoLogo}${instrucaoImagens}
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

  html = injectarLojaSeNecessario(html, ehLoja, siteId);
  html = injectarGaleriaSeNecessario(html, ehGaleria, siteId);
  html = injectarPortfolioSeNecessario(html, ehPortfolio, siteId);
  html = injectarBlogSeNecessario(html, ehBlog, siteId);
  html = aplicarMarcaDeAgua(html, mostrarMarcaDeAgua);

  return { html, tokens };
}

// Mostra ou remove o selo "Feito com Daniel.ia" no canto do site, segundo o
// plano do dono (só o Free tem marca de água). Remove sempre primeiro
// qualquer selo que já exista e só volta a pô-lo se for preciso - assim,
// se a pessoa subir de plano e depois editar o site, o selo desaparece
// sozinho na próxima vez que o ficheiro for reescrito.
function aplicarMarcaDeAgua(html, mostrar) {
  html = html.replace(/\s*<a[^>]*id=["']daniel-ia-marca-dagua["'][^>]*>[\s\S]*?<\/a>/i, '');
  if (!mostrar) return html;

  const selo = `\n<a id="daniel-ia-marca-dagua" href="https://daniel-ia.com" target="_blank" rel="noopener" style="position:fixed;bottom:16px;right:16px;z-index:999999;display:inline-flex;align-items:center;gap:6px;background:#0A0A12;color:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:500;padding:8px 14px;border-radius:999px;text-decoration:none;box-shadow:0 4px 16px rgba(0,0,0,0.25);">⚡ Feito com <strong>Daniel.ia</strong></a>\n`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, selo + '</body>');
  }
  return html + selo;
}

// Para E-commerce/Checkout: garante a div dos produtos (defesa, caso a IA
// se tenha esquecido dela) e injecta sempre o módulo fixo da loja antes de
// </body>. Chamado tanto na criação como na edição de um site - nunca
// depende do que a IA escreveu, é sempre reaplicado por cima.
function injectarLojaSeNecessario(html, ehLoja, siteId) {
  if (!ehLoja) return html;

  if (!/id=["']daniel-ia-produtos["']/.test(html)) {
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
  // este pedido de edição, para a IA usar onde fizer sentido.
  const instrucaoImagens = (imagensUrls && imagensUrls.length)
    ? `\nA pessoa anexou ${imagensUrls.length} imagem(ns) nova(s) a este pedido de alteração, para usares no site onde fizer sentido. Usa exactamente estes URLs, cada um no máximo uma vez:\n${imagensUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}`
    : '';

  const instrucaoLoja = ehLoja
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

  const instrucaoMarca = `\nSe existir, perto de </body>, um elemento <a id="daniel-ia-marca-dagua">...</a> (um selo "Feito com Daniel.ia"), não o apagues nem o modifiques - isso é gerido à parte, automaticamente.`;

  const systemPrompt = `Você é o motor de edição de sites da Daniel.ia, uma plataforma moçambicana.
Vais receber o código HTML completo de um site já existente, e um pedido de alteração.
A tua tarefa é devolver o ficheiro HTML completo (doctype, head, body), já com a alteração pedida aplicada, mantendo tudo o resto exactamente igual ao original - mesma estrutura, mesmo estilo visual, mesmo conteúdo que não foi pedido para mudar.
Não escrevas nenhuma explicação antes ou depois do código. Não uses blocos de markdown (não escrevas \`\`\`html nem \`\`\`). A resposta deve começar directamente com <!DOCTYPE html>.${instrucaoLoja}${instrucaoGaleria}${instrucaoPortfolio}${instrucaoBlog}${instrucaoMarca}`;

  const userPrompt = `Nome do negócio: ${nome}
Tipo de projecto: ${tipo}
Pedido de alteração: ${prompt}${instrucaoImagens}

Código HTML actual completo:
${htmlAtual}`;

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
  html = html.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const tokens = (json.usage && json.usage.total_tokens) || 0;

  if (!html || html.length < 100) {
    throw new Error('A OpenAI devolveu uma resposta vazia ou demasiado curta. Tokens gastos: ' + tokens);
  }

  html = injectarLojaSeNecessario(html, ehLoja, siteId);
  html = injectarGaleriaSeNecessario(html, ehGaleria, siteId);
  html = injectarPortfolioSeNecessario(html, ehPortfolio, siteId);
  html = injectarBlogSeNecessario(html, ehBlog, siteId);
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
  Daniel.ia - módulo fixo da Galeria (álbuns + visualizador)
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

  var CONTAINER_URL = 'https://mc-8oxfde5o71.bunny.run';
  var SITE_ID = window.DANIEL_IA_SITE_ID || '';

  if (!SITE_ID) {
    console.error('Daniel.ia: falta window.DANIEL_IA_SITE_ID nesta página - o visualizador da galeria não pode arrancar.');
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
      + '.dig-grelha{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px;margin:0;padding:0;}'
      + '.dig-album-card{cursor:pointer;border-radius:14px;overflow:hidden;background:#15151b;position:relative;font-family:inherit;}'
      + '.dig-album-capa{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#1f1f27;transition:transform .35s ease;}'
      + '.dig-album-card:hover .dig-album-capa{transform:scale(1.04);}'
      + '.dig-album-capa-vazia{display:flex;align-items:center;justify-content:center;color:#777;font-size:13px;}'
      + '.dig-album-info{position:absolute;left:0;right:0;bottom:0;padding:14px 16px;background:linear-gradient(to top,rgba(0,0,0,.78),rgba(0,0,0,0));}'
      + '.dig-album-titulo{color:#fff;font-weight:700;font-size:15px;margin-bottom:2px;}'
      + '.dig-album-meta{color:#d6d6de;font-size:12px;}'
      + '.dig-vazio{color:#777;font-size:13px;}'
      + '.dig-lightbox{position:fixed;inset:0;background:rgba(6,6,10,.96);z-index:100000;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .25s ease;font-family:inherit;}'
      + '.dig-lightbox.dig-aberto{opacity:1;pointer-events:auto;}'
      + '.dig-lightbox-topo{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:18px 20px;color:#eee;z-index:2;}'
      + '.dig-lightbox-titulo-album{font-size:14px;font-weight:600;color:#fff;}'
      + '.dig-lightbox-contador{font-size:12px;color:#aaa;margin-top:2px;}'
      + '.dig-lightbox-fechar{background:rgba(255,255,255,.08);border:none;color:#fff;font-size:20px;line-height:1;width:38px;height:38px;border-radius:50%;cursor:pointer;}'
      + '.dig-lightbox-fechar:hover{background:rgba(255,255,255,.18);}'
      + '.dig-lightbox-palco{width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:70px 70px;box-sizing:border-box;position:relative;}'
      + '.dig-lightbox-conteudo{max-width:100%;max-height:100%;opacity:0;transform:scale(.97);transition:opacity .22s ease,transform .22s ease;display:flex;align-items:center;justify-content:center;}'
      + '.dig-lightbox-conteudo.dig-visivel{opacity:1;transform:scale(1);}'
      + '.dig-lightbox-conteudo img,.dig-lightbox-conteudo video{max-width:100%;max-height:78vh;border-radius:6px;display:block;background:#000;}'
      + '.dig-lightbox-spinner{width:32px;height:32px;border-radius:50%;border:3px solid rgba(255,255,255,.2);border-top-color:#fff;animation:dig-girar .8s linear infinite;}'
      + '@keyframes dig-girar{to{transform:rotate(360deg);}}'
      + '.dig-lightbox-seta{position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.08);border:none;color:#fff;width:46px;height:46px;border-radius:50%;font-size:20px;cursor:pointer;z-index:2;}'
      + '.dig-lightbox-seta:hover{background:rgba(255,255,255,.2);}'
      + '.dig-lightbox-seta.dig-esquerda{left:14px;}'
      + '.dig-lightbox-seta.dig-direita{right:14px;}'
      + '.dig-lightbox-vazio{color:#ccc;font-size:14px;text-align:center;}'
      + '@media(max-width:640px){.dig-lightbox-palco{padding:70px 16px;}.dig-lightbox-seta{width:38px;height:38px;font-size:17px;}.dig-lightbox-seta.dig-esquerda{left:6px;}.dig-lightbox-seta.dig-direita{right:6px;}}';
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
      console.error('Daniel.ia: falta uma div com id="daniel-ia-galeria" nesta página - os álbuns não têm onde aparecer.');
      return null;
    }
    alvo.innerHTML = '<div id="dig-grelha" class="dig-grelha"><p class="dig-vazio">A carregar álbuns...</p></div>';
    return document.getElementById('dig-grelha');
  }

  function renderGrelha(albuns){
    var grelha = document.getElementById('dig-grelha');
    if (!grelha) return;
    if (!albuns || albuns.length === 0) {
      grelha.innerHTML = '<p class="dig-vazio">Ainda não há álbuns aqui.</p>';
      return;
    }
    grelha.innerHTML = albuns.map(function(a){
      var capa = a.capa
        ? '<img class="dig-album-capa" src="' + escaparAtributo(a.capa) + '" alt="' + escaparAtributo(a.titulo) + '">'
        : '<div class="dig-album-capa dig-album-capa-vazia">Sem ficheiros</div>';
      return ''
        + '<div class="dig-album-card" data-id="' + a.id + '">'
        + capa
        + '<div class="dig-album-info">'
        + '<div class="dig-album-titulo">' + escaparHtml(a.titulo) + '</div>'
        + '<div class="dig-album-meta">' + a.total_media + (a.total_media === 1 ? ' ficheiro' : ' ficheiros') + '</div>'
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
      + '<button class="dig-lightbox-fechar" id="dig-fechar" aria-label="Fechar">&times;</button>'
      + '</div>'
      + '<button class="dig-lightbox-seta dig-esquerda" id="dig-anterior" aria-label="Anterior">&#8249;</button>'
      + '<div class="dig-lightbox-palco" id="dig-palco"></div>'
      + '<button class="dig-lightbox-seta dig-direita" id="dig-seguinte" aria-label="Seguinte">&#8250;</button>';
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
          mostrarPalco('<p class="dig-lightbox-vazio">' + escaparHtml(r.message || 'Não foi possível abrir este álbum.') + '</p>', true);
          return;
        }
        albumActual = r.response.album;
        mediaAtual = r.response.media || [];
        indiceAtual = 0;
        document.getElementById('dig-titulo-album').textContent = albumActual.titulo || '';
        if (mediaAtual.length === 0) {
          document.getElementById('dig-contador').textContent = '';
          mostrarPalco('<p class="dig-lightbox-vazio">Ainda não há fotos ou vídeos neste álbum.</p>', true);
          return;
        }
        mostrarMediaAtual();
      })
      .catch(function(){
        mostrarPalco('<p class="dig-lightbox-vazio">Não foi possível ligar ao servidor.</p>', true);
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
      console.error('Daniel.ia: não foi possível carregar o leitor de vídeo.');
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
          if (grelha) grelha.innerHTML = '<p class="dig-vazio">Não foi possível carregar os álbuns.</p>';
        }
      })
      .catch(function(){
        var grelha = document.getElementById('dig-grelha');
        if (grelha) grelha.innerHTML = '<p class="dig-vazio">Não foi possível ligar ao servidor.</p>';
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
  Daniel.ia - módulo fixo do Portefólio (grelha de trabalhos)
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

  var CONTAINER_URL = 'https://mc-8oxfde5o71.bunny.run';
  var SITE_ID = window.DANIEL_IA_SITE_ID || '';

  if (!SITE_ID) {
    console.error('Daniel.ia: falta window.DANIEL_IA_SITE_ID nesta página - o portefólio não pode arrancar.');
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
      + '.dip-grelha{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:22px;margin:0;padding:0;}'
      + '.dip-card{cursor:pointer;border-radius:14px;overflow:hidden;background:#15151b;font-family:inherit;}'
      + '.dip-card-img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#1f1f27;transition:transform .35s ease;}'
      + '.dip-card:hover .dip-card-img{transform:scale(1.04);}'
      + '.dip-card-img-vazia{display:flex;align-items:center;justify-content:center;color:#777;font-size:13px;}'
      + '.dip-card-corpo{padding:16px;}'
      + '.dip-card-titulo{font-weight:700;font-size:15px;margin-bottom:6px;color:#fff;}'
      + '.dip-card-desc{font-size:13px;color:#b9b9c2;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}'
      + '.dip-vazio{color:#777;font-size:13px;}'
      + '.dip-overlay{position:fixed;inset:0;background:rgba(6,6,10,.92);z-index:100000;display:flex;align-items:center;justify-content:center;padding:24px;opacity:0;pointer-events:none;transition:opacity .22s ease;font-family:inherit;}'
      + '.dip-overlay.dip-aberto{opacity:1;pointer-events:auto;}'
      + '.dip-modal{background:#15151b;border-radius:16px;max-width:620px;width:100%;max-height:88vh;overflow-y:auto;position:relative;transform:scale(.97);opacity:0;transition:opacity .22s ease,transform .22s ease;}'
      + '.dip-overlay.dip-aberto .dip-modal{transform:scale(1);opacity:1;}'
      + '.dip-modal-img{width:100%;max-height:360px;object-fit:cover;display:block;background:#1f1f27;}'
      + '.dip-modal-corpo{padding:22px;}'
      + '.dip-modal-titulo{font-weight:700;font-size:19px;color:#fff;margin-bottom:10px;}'
      + '.dip-modal-desc{font-size:14px;color:#c6c6cf;line-height:1.6;white-space:pre-wrap;}'
      + '.dip-modal-link{display:inline-block;margin-top:16px;color:#fff;font-size:13px;font-weight:600;text-decoration:underline;}'
      + '.dip-fechar{position:absolute;top:14px;right:14px;background:rgba(255,255,255,.1);border:none;color:#fff;font-size:20px;line-height:1;width:36px;height:36px;border-radius:50%;cursor:pointer;z-index:2;}'
      + '.dip-fechar:hover{background:rgba(255,255,255,.2);}';
    var style = document.createElement('style');
    style.setAttribute('data-daniel-ia', 'portfolio');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function montarGrelha(){
    var alvo = document.getElementById('daniel-ia-portfolio');
    if (!alvo) {
      console.error('Daniel.ia: falta uma div com id="daniel-ia-portfolio" nesta página - os trabalhos não têm onde aparecer.');
      return null;
    }
    alvo.innerHTML = '<div id="dip-grelha" class="dip-grelha"><p class="dip-vazio">A carregar trabalhos...</p></div>';
    return document.getElementById('dip-grelha');
  }

  function renderGrelha(trabalhos){
    var grelha = document.getElementById('dip-grelha');
    if (!grelha) return;
    if (!trabalhos || trabalhos.length === 0) {
      grelha.innerHTML = '<p class="dip-vazio">Ainda não há trabalhos aqui.</p>';
      return;
    }
    grelha.innerHTML = trabalhos.map(function(t){
      var imagem = t.imagem
        ? '<img class="dip-card-img" src="' + escaparAtributo(t.imagem) + '" alt="' + escaparAtributo(t.titulo) + '">'
        : '<div class="dip-card-img dip-card-img-vazia">Sem imagem</div>';
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
      ? '<a class="dip-modal-link" href="' + escaparAtributo(trabalho.link) + '" target="_blank" rel="noopener">Ver projecto &#8594;</a>'
      : '';
    el.innerHTML = ''
      + '<div class="dip-modal">'
      + '<button class="dip-fechar" id="dip-fechar" aria-label="Fechar">&times;</button>'
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
          if (grelha) grelha.innerHTML = '<p class="dip-vazio">Não foi possível carregar os trabalhos.</p>';
        }
      })
      .catch(function(){
        var grelha = document.getElementById('dip-grelha');
        if (grelha) grelha.innerHTML = '<p class="dip-vazio">Não foi possível ligar ao servidor.</p>';
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
  Daniel.ia - módulo fixo do Blog (grelha de artigos)
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

  var CONTAINER_URL = 'https://mc-8oxfde5o71.bunny.run';
  var SITE_ID = window.DANIEL_IA_SITE_ID || '';

  if (!SITE_ID) {
    console.error('Daniel.ia: falta window.DANIEL_IA_SITE_ID nesta página - o blog não pode arrancar.');
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
      return d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'long', year: 'numeric' });
    } catch (e) { return ''; }
  }

  function injectarEstilos(){
    var css = ''
      + '.dib-grelha{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px;margin:0;padding:0;}'
      + '.dib-card{cursor:pointer;border-radius:14px;overflow:hidden;background:#15151b;font-family:inherit;}'
      + '.dib-card-img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#1f1f27;transition:transform .35s ease;}'
      + '.dib-card:hover .dib-card-img{transform:scale(1.04);}'
      + '.dib-card-img-vazia{display:flex;align-items:center;justify-content:center;color:#777;font-size:13px;}'
      + '.dib-card-corpo{padding:18px;}'
      + '.dib-card-data{font-size:12px;color:#8a8a94;margin-bottom:6px;text-transform:capitalize;}'
      + '.dib-card-titulo{font-weight:700;font-size:16px;margin-bottom:8px;color:#fff;}'
      + '.dib-card-resumo{font-size:13px;color:#b9b9c2;line-height:1.55;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}'
      + '.dib-vazio{color:#777;font-size:13px;}'
      + '.dib-overlay{position:fixed;inset:0;background:rgba(6,6,10,.94);z-index:100000;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow-y:auto;opacity:0;pointer-events:none;transition:opacity .22s ease;font-family:inherit;}'
      + '.dib-overlay.dib-aberto{opacity:1;pointer-events:auto;}'
      + '.dib-artigo{background:#15151b;border-radius:16px;max-width:720px;width:100%;position:relative;transform:translateY(10px);opacity:0;transition:opacity .22s ease,transform .22s ease;margin-bottom:40px;}'
      + '.dib-overlay.dib-aberto .dib-artigo{transform:translateY(0);opacity:1;}'
      + '.dib-artigo-img{width:100%;max-height:360px;object-fit:cover;display:block;background:#1f1f27;border-radius:16px 16px 0 0;}'
      + '.dib-artigo-corpo{padding:30px;}'
      + '.dib-artigo-data{font-size:12px;color:#8a8a94;margin-bottom:10px;text-transform:capitalize;}'
      + '.dib-artigo-titulo{font-weight:700;font-size:24px;color:#fff;margin-bottom:18px;line-height:1.3;}'
      + '.dib-artigo-conteudo{font-size:15px;color:#c6c6cf;line-height:1.75;white-space:pre-wrap;}'
      + '.dib-fechar{position:absolute;top:14px;right:14px;background:rgba(255,255,255,.1);border:none;color:#fff;font-size:20px;line-height:1;width:36px;height:36px;border-radius:50%;cursor:pointer;z-index:2;}'
      + '.dib-fechar:hover{background:rgba(255,255,255,.2);}';
    var style = document.createElement('style');
    style.setAttribute('data-daniel-ia', 'blog');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function montarGrelha(){
    var alvo = document.getElementById('daniel-ia-blog');
    if (!alvo) {
      console.error('Daniel.ia: falta uma div com id="daniel-ia-blog" nesta página - os artigos não têm onde aparecer.');
      return null;
    }
    alvo.innerHTML = '<div id="dib-grelha" class="dib-grelha"><p class="dib-vazio">A carregar artigos...</p></div>';
    return document.getElementById('dib-grelha');
  }

  function renderGrelha(posts){
    var grelha = document.getElementById('dib-grelha');
    if (!grelha) return;
    if (!posts || posts.length === 0) {
      grelha.innerHTML = '<p class="dib-vazio">Ainda não há artigos aqui.</p>';
      return;
    }
    grelha.innerHTML = posts.map(function(p){
      var imagem = p.imagem
        ? '<img class="dib-card-img" src="' + escaparAtributo(p.imagem) + '" alt="' + escaparAtributo(p.titulo) + '">'
        : '<div class="dib-card-img dib-card-img-vazia">Sem imagem</div>';
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
      + '<button class="dib-fechar" id="dib-fechar" aria-label="Fechar">&times;</button>'
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
          if (grelha) grelha.innerHTML = '<p class="dib-vazio">Não foi possível carregar os artigos.</p>';
        }
      })
      .catch(function(){
        var grelha = document.getElementById('dib-grelha');
        if (grelha) grelha.innerHTML = '<p class="dib-vazio">Não foi possível ligar ao servidor.</p>';
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

// Nota sobre os nomes dos campos nas chamadas ao Bubble: têm de ser
// EXACTAMENTE como aparecem no editor do Bubble (maiúsculas e espaços
// incluídos) - a Data API não os converte para minúsculas.

app.post('/generate', async (req, res) => {
  try {
    const { owner, nome, tipo, prompt, logo_data_url, imagens_data_url } = req.body;

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
    const mostrarMarcaDeAgua = String(plano['Name'] || '').trim().toLowerCase() === 'free';

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
    processarGeracao({ owner, nome, tipo, prompt, logo_data_url, imagens_data_url, siteId, generationId, tokensUsados, mostrarMarcaDeAgua })
      .catch(erro => console.error('Erro em processarGeracao:', erro));

  } catch (erro) {
    console.error('Erro em /generate:', erro);
    return res.json({ status: 'error', message: 'Não foi possível iniciar a geração. Tenta novamente.' });
  }
});

async function processarGeracao({ owner, nome, tipo, prompt, logo_data_url, imagens_data_url, siteId, generationId, tokensUsados, mostrarMarcaDeAgua }) {
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

    // ---- Gerar o HTML com a OpenAI ----
    const { html, tokens } = await gerarComOpenAI({ nome, tipo, prompt, logoUrl, imagensUrls, siteId, mostrarMarcaDeAgua });

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
    const planId = user['Plan'];
    if (!planId) {
      return res.json({ status: 'error', message: 'A tua conta não tem nenhum plano atribuído.' });
    }
    const plano = await bubbleGet('plan', planId);

    const tokensUsados = user['Tokens Usados Mes'] || 0;
    const tokensIncluidos = plano['Tokens Incluidos'] || 0;
    if (tokensUsados >= tokensIncluidos) {
      return res.json({ status: 'error', message: 'Já atingiste o limite de tokens de IA incluídos no teu plano este mês.' });
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

    processarEdicao({ owner, site_id, site, prompt, imagens_data_url, generationId, tokensUsados, tokensIncluidos, ehPrimeiraEdicao, ehPlanoFree })
      .catch(erro => console.error('Erro em processarEdicao:', erro));

  } catch (erro) {
    console.error('Erro em /editar:', erro);
    return res.json({ status: 'error', message: 'Não foi possível iniciar a edição. Tenta novamente.' });
  }
});

async function processarEdicao({ owner, site_id, site, prompt, imagens_data_url, generationId, tokensUsados, tokensIncluidos, ehPrimeiraEdicao, ehPlanoFree }) {
  try {
    // ---- Ler o HTML publicado agora mesmo ----
    const respAtual = await fetch(site['CDN URL']);
    if (!respAtual.ok) {
      throw new Error('Não foi possível ler o ficheiro actual do site (HTTP ' + respAtual.status + ').');
    }
    const htmlAtual = await respAtual.text();

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

    // ---- Publicar no MESMO caminho (o link não muda) ----
    const caminhoSite = site['Bunny Path'];
    const cdnUrl = await uploadParaBunny(caminhoSite, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
    await purgeCacheBunny(cdnUrl);

    await bubblePatch('generation', generationId, {
      'Status': 'Pronto',
      'Tokens Usados': tokens
    });

    // ---- Tokens: regra especial do plano Free ----
    const novoTotalTokens = (ehPlanoFree && ehPrimeiraEdicao)
      ? tokensIncluidos
      : tokensUsados + tokens;
    await bubblePatch('user', owner, { 'Tokens Usados Mes': novoTotalTokens });

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

    const response = {
      estado: site['Status'],
      cdn_url: site['CDN URL'] || ''
    };

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
