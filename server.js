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
const VERSION = '1.48.0'; // 14/10/2026 - visual livre: a descrição da pessoa manda, sem receitas por sector

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
8. Telemóvel primeiro. A maioria dos clientes vê no telemóvel: tem de ficar impecável a 360px de largura, com menu próprio para telemóvel, botões fáceis de tocar (mínimo 44px) e nada a sair do ecrã.
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
function pontoDePartidaVisual() {
  return `\nPONTO DE PARTIDA SORTEADO (usa só se a descrição da pessoa não disser nada sobre o visual - se disser, ignora isto por completo): estilo "${sortear(ESTILOS_SORTEIO)}"; hero "${sortear(HEROS_SORTEIO)}". Adapta-o ao negócio. Se não fizer sentido nenhum para este negócio, escolhe outra direcção, mas nunca o clichê do sector.`;
}

const GUIA_TIPO = {
  'E-commerce': 'Esta é uma loja online ao estilo dos grandes marketplaces (Amazon, Shein, Jumia): o protagonista são os PRODUTOS, com pouca informação à volta. Desenha só: (1) um cabeçalho compacto e elegante com o logótipo/nome da loja e um menu curto (ex: Início, Produtos, Contacto), que pode ficar fixo no topo; (2) logo a seguir ao cabeçalho, a div obrigatória da loja (ver instrução abaixo) - NÃO ponhas nenhum hero, banner ou capa antes dela, porque a capa em carrossel, a pesquisa, as categorias, os destaques e os produtos aparecem automaticamente dentro dessa div; (3) depois dela, uma faixa curta de confiança com 3 ou 4 pontos (ex: entrega rápida, pagamento seguro, apoio por WhatsApp), cada um com um ícone SVG; (4) a secção de contacto e um rodapé compacto com contactos e redes sociais. Nada de textos longos, sobre nós extensos ou testemunhos - a loja vai directa aos produtos. NÃO desenhes produtos, preços, carrinho, pesquisa, categorias nem capa - é tudo tratado automaticamente.',
  'Checkout': 'Esta é uma página de venda directa de uma loja pequena, focada nos produtos. Desenha só: (1) um cabeçalho compacto com o logótipo/nome; (2) logo a seguir, a div obrigatória da loja (ver instrução abaixo) - sem hero nem capa antes dela, porque a capa, os produtos, o carrinho e o pagamento aparecem automaticamente lá dentro; (3) uma faixa curta com 3 razões para comprar (com ícones SVG); (4) a secção de contacto e um rodapé compacto. Textos curtos e directos. NÃO desenhes produtos, carrinho, nem botões de compra ou pagamento - é tudo tratado automaticamente.',
  'Landing Page': 'Landing page para apresentar o negócio e levar a uma acção (contactar, comprar, reservar, inscrever-se). Secções possíveis - escolhe as que fazem sentido para a descrição, pela ordem que conta melhor a história: hero, benefícios, como funciona, sobre, serviços ou preços, depoimentos, perguntas frequentes, chamada para acção, contacto e rodapé. Se a pessoa pedir uma página simples ou curta, fica-te por 3 ou 4 secções muito bem feitas. Se não disser nada, desenvolve o suficiente para convencer, com textos com substância (explica cada benefício, não só títulos soltos).',
  'Portefólio': 'Portefólio pessoal ou profissional. Obrigatório: apresentação com o nome e o que a pessoa faz, a zona dos trabalhos (ver instrução abaixo) e o contacto. Opcional, conforme a descrição: sobre com percurso, serviços, clientes, processo de trabalho, prémios, uma citação. A forma é livre e segue a descrição: pode ser uma página minimal só com nome, trabalhos e contacto, ou uma página rica e editorial. NÃO desenhes trabalhos reais nem a grelha deles - isso é tratado à parte, automaticamente.',
  'Blog': 'Página inicial de um blog. Obrigatório: o nome do blog ou do autor, uma frase sobre o que o blog aborda, a zona dos artigos (ver instrução abaixo) e o contacto. Opcional, conforme a descrição: sobre quem escreve, temas principais, subscrição, redes sociais. Pode ser leve e minimal, ao estilo de um caderno, ou uma capa de revista. NÃO desenhes artigos reais nem a grelha deles - isso é tratado à parte, automaticamente.',
  'Galeria': 'Site de fotógrafo, videógrafo ou de qualquer pessoa que mostra o seu trabalho em imagens. Obrigatório: o nome, a zona dos álbuns (ver instrução abaixo) e o contacto. Opcional, conforme a descrição: hero, sobre, serviços ou pacotes, testemunhos, processo de trabalho. O estilo segue a descrição e não um molde: pode ser branco e silencioso para as fotos falarem sozinhas, cheio de cor e energia, escuro e cinematográfico, revista de moda, documental e cru, romântico e suave. As fotos são as protagonistas. NÃO desenhes álbuns, fotos ou vídeos falsos nem o visualizador - os álbuns a sério aparecem sozinhos, tratados à parte.'
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
  const instrucaoContacto = `\nINSTRUÇÃO OBRIGATÓRIA: nesta página tens de incluir, algures dentro do <body>, exactamente esta div vazia, sem nada lá dentro: <div id="daniel-ia-contacto"></div> - é ali que o formulário de contacto a sério (nome, email, mensagem, já ligado para enviar a mensagem ao dono do site) vai aparecer sozinho, gerido por um sistema à parte. Não escrevas tu nenhum formulário, nem campos de nome/email/mensagem, nem botão de enviar - só essa div vazia, bem posicionada na página (por exemplo, numa secção com título "Contacto" ou "Fala connosco").`;

  const systemPrompt = `Você é o motor de geração de sites da Daniel IA, uma plataforma moçambicana.
Gera APENAS um ficheiro HTML completo e válido (doctype, head, body), com todo o CSS e JavaScript embutidos no mesmo ficheiro (nada de ficheiros externos, excepto fontes do Google Fonts se quiseres).
Não escrevas nenhuma explicação antes ou depois do código. Não uses blocos de markdown (não escrevas \`\`\`html nem \`\`\`). A resposta deve começar directamente com <!DOCTYPE html>.
O site deve ser responsivo, moderno e profissional, em português (de Moçambique, tom local mas correcto).
${DIRECAO_DE_ARTE}${pontoDePartidaVisual()}
IMPORTANTE: o site tem de parecer acabado e profissional - nunca com ar de esqueleto, com caixas vazias ou textos de enchimento. Acabado não quer dizer comprido: o tamanho e a quantidade de secções seguem a descrição. Se a pessoa pedir simples, curto ou minimal, respeita (poucas secções, muito bem feitas). Se não disser nada, desenvolve o suficiente para aquele negócio, com textos com substância.
${guia}${instrucaoLoja}${instrucaoGaleria}${instrucaoPortfolio}${instrucaoBlog}${instrucaoContacto}`;

  const textoPedido = `Nome do negócio: ${nome}
Tipo de projecto: ${tipo}
${instrucaoLogo}${instrucaoImagens}
Descrição pedida pela pessoa: ${prompt}`;

  // Se houver imagens anexadas, mandamo-las a sério para a API (não só o
  // URL em texto) - só assim a IA consegue "ver" o que está nelas, seja
  // para copiar um estilo ou para usar como conteúdo. Sem imagens, o
  // pedido continua a ser simplesmente texto, como sempre foi.
  let userContent = textoPedido;
  if (imagensUrls && imagensUrls.length) {
    userContent = [{ type: 'text', text: textoPedido }];
    imagensUrls.forEach(url => userContent.push({ type: 'image_url', image_url: { url } }));
  }

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

  html = injectarLojaSeNecessario(html, ehLoja, siteId);
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

  const selo = `\n<a id="daniel-ia-marca-dagua" href="https://daniel-ia.pro" target="_blank" rel="noopener" style="position:fixed;bottom:16px;right:16px;z-index:999999;display:inline-flex;align-items:center;gap:8px;background:rgba(15,5,24,0.92);color:#F6F2FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12.5px;font-weight:500;line-height:1;padding:8px 14px 8px 10px;border-radius:999px;text-decoration:none;border:1px solid rgba(137,200,4,0.35);box-shadow:0 8px 24px rgba(67,9,96,0.45);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);"><svg viewBox="111 492.5 250 250" width="16" height="16" aria-hidden="true" style="display:block;flex-shrink:0;"><path fill="#FFFFFF" d="M148.0 738.1C142.7 737.4 139.2 736.1 135.6 733.7C128.3 728.8 123.9 721.8 122.6 713.1C122.1 709.4 122.1 707.5 122.7 704.0C123.8 697.6 126.3 692.6 130.6 688.3C133.2 685.6 136.0 683.8 141.9 680.7C150.6 676.1 156.0 672.8 160.9 669.2C172.2 660.9 180.7 651.9 187.8 640.6C188.3 639.9 188.8 639.4 189.0 639.4C189.4 639.4 189.5 702.5 189.0 705.6C187.7 714.1 184.5 720.7 178.6 726.7C172.9 732.7 168.0 735.6 160.8 737.5C158.3 738.2 157.3 738.3 154.1 738.4C151.7 738.4 149.5 738.4 148.0 738.1ZM183.5 737.9C183.5 737.7 184.1 737.1 184.9 736.6C189.2 733.9 194.3 728.3 197.4 723.0C202.1 715.1 203.7 708.5 203.7 698.0C203.7 694.3 203.8 692.7 204.1 692.4C204.3 692.1 206.1 692.0 222.0 691.9C238.3 691.8 239.9 691.8 243.0 691.3C254.0 689.6 263.9 685.6 273.4 679.0C281.6 673.4 288.9 665.8 294.0 657.5C298.3 650.5 301.7 642.5 303.3 635.4C306.8 619.6 305.5 604.6 299.3 589.3C296.5 582.2 293.0 576.6 286.9 569.6C282.9 564.8 279.8 562.0 274.4 558.1C264.1 550.6 251.7 545.8 240.8 545.0C238.8 544.8 228.4 544.8 215.6 544.8L193.8 544.9L192.7 545.6C191.4 546.5 190.1 548.2 189.7 549.4C189.5 550.1 189.4 555.5 189.4 571.2C189.4 582.6 189.3 592.1 189.2 592.2C188.9 592.4 188.0 591.4 188.0 590.9C188.0 590.0 185.1 584.4 182.5 580.6C179.3 575.7 171.4 568.0 165.1 563.7C161.4 561.2 152.2 556.2 143.4 551.9C134.1 547.4 130.6 544.8 127.0 540.0C124.6 536.8 123.4 533.6 122.6 529.1C122.2 526.2 122.2 523.9 122.6 520.6C123.1 517.2 123.8 514.9 125.2 512.1C128.5 505.5 134.2 500.8 141.6 498.7C146.7 497.2 146.0 497.2 196.5 497.3C246.4 497.4 244.5 497.4 253.4 498.8C268.8 501.2 287.7 509.1 301.3 518.9C312.8 527.0 323.6 538.1 330.9 549.1C335.2 555.5 337.8 560.2 340.5 566.0C344.7 575.1 347.2 582.3 349.5 592.4C351.4 600.7 352.0 605.8 352.2 615.9C352.4 628.3 351.3 638.6 348.6 648.9C345.6 660.5 339.4 674.8 333.6 684.0C323.4 700.1 309.0 713.7 292.2 723.3C282.4 728.9 271.5 733.1 261.5 735.3C248.6 738.2 247.4 738.2 211.8 738.2C186.7 738.2 183.5 738.2 183.5 737.9Z"/><circle fill="#89C804" cx="149.1" cy="612.7" r="29.7"/></svg><span>Feito com <strong style="font-weight:800;color:#FFFFFF;">Daniel <span style="color:#89C804;">IA</span></strong></span></a>\n`;
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

// Para o Contacto: ao contrário dos outros, aplica-se a TODOS os sites,
// seja qual for o tipo - garante a div do formulário (defesa, caso a IA
// se tenha esquecido dela) e injecta sempre o módulo fixo antes de
// </body>. Mesmo princípio de injectarLojaSeNecessario, só que sem
// nenhuma condição de tipo e para "daniel-ia-contacto" e
// "contacto-form.js".
function injectarContactoSeNecessario(html, siteId) {
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

  // Aplica-se a TODOS os sites, seja qual for o tipo.
  const instrucaoContacto = `\nATENÇÃO: esta página tem de continuar a ter, exactamente como está, a div <div id="daniel-ia-contacto"></div> e os dois <script> antes de </body> que carregam o módulo de contacto (window.DANIEL_IA_SITE_ID e contacto-form.js). Não apagues nem modifiques essa div nem esses scripts, e não escrevas tu nenhum formulário de contacto a sério - isso continua a ser tratado à parte, automaticamente.`;

  const instrucaoMarca = `\nSe existir, perto de </body>, um elemento <a id="daniel-ia-marca-dagua">...</a> (um selo "Feito com Daniel IA"), não o apagues nem o modifiques - isso é gerido à parte, automaticamente.`;

  const systemPrompt = `Você é o motor de edição de sites da Daniel IA, uma plataforma moçambicana.
Vais receber o código HTML completo de um site já existente, e um pedido de alteração.
A tua tarefa é devolver o ficheiro HTML completo (doctype, head, body), já com a alteração pedida aplicada, mantendo tudo o resto exactamente igual ao original - mesma estrutura, mesmo estilo visual, mesmo conteúdo que não foi pedido para mudar.
Não escrevas nenhuma explicação antes ou depois do código. Não uses blocos de markdown (não escrevas \`\`\`html nem \`\`\`). A resposta deve começar directamente com <!DOCTYPE html>.
IMPORTANTE: o site tem de continuar acabado e profissional depois da alteração - nunca partido, vazio ou com ar de esqueleto. Se a alteração implicar reescrever ou ampliar alguma secção, capricha nela. Se a pessoa pedir para simplificar ou tirar coisas, faz isso mesmo, sem voltar a encher.
${DIRECAO_DE_ARTE}
NA EDIÇÃO: mantém a identidade visual que o site já tem, mas tudo o que mudares ou acrescentares tem de seguir este padrão de qualidade. Se o :root ainda não tiver as fichas --dia-*, acrescenta-as com os valores que o site já usa (sem mudar o visual). Se o pedido mudar cores ou tipos de letra, actualiza também as fichas.${instrucaoLoja}${instrucaoGaleria}${instrucaoPortfolio}${instrucaoBlog}${instrucaoContacto}${instrucaoMarca}`;

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
  Daniel IA - módulo fixo da loja v2 (montra completa estilo marketplace)
  ---------------------------------------------------------------------
  Servido pelo container em /loja-cart.js e carregado por TODOS os sites de
  E-commerce/Checkout. A IA desenha só o cabeçalho e o rodapé do site e
  deixa uma div com id="daniel-ia-produtos". Este módulo monta ali:
    - a capa (carrossel até 3 imagens, ou uma capa gerada com a marca)
    - a pesquisa e as categorias
    - os produtos em destaque
    - o catálogo por categoria, com preço antigo e desconto
    - a página de cada produto, o carrinho e o checkout
  O checkout adapta-se ao modo da loja: pagamentos Daniel IA (M-Pesa,
  e-Mola, cartão), pagamento manual para os números do dono, encomenda
  pelo WhatsApp, ou encomenda simples (chega ao dono por email).
  As cores, tipos e cantos vêm das fichas --dia-* do próprio site.

  Cada página gerada define, antes de carregar este ficheiro:
    window.DANIEL_IA_SITE_ID = 'xxxxx';
*/
(function(){
  'use strict';

  var CONTAINER_URL = 'https://mc-8oxfde5o71.bunny.run';
  var SITE_ID = window.DANIEL_IA_SITE_ID || '';
  if (!SITE_ID) {
    console.error('Daniel IA: falta window.DANIEL_IA_SITE_ID nesta página - o módulo da loja não pode arrancar.');
    return;
  }

  var CART_KEY = 'daniel_ia_carrinho_' + SITE_ID;
  var produtos = [];
  var loja = { nome: '', capa: [], modo: 'pedido', metodos: [], manual: null, whatsapp: '' };
  var carrinho = lerCarrinho();
  var filtro = { categoria: '', texto: '' };
  var slideActual = 0;
  var temporizadorCapa = null;

  // ======================================================
  // Utilitários
  // ======================================================
  function $(id){ return document.getElementById(id); }
  function esc(t){
    return String(t == null ? '' : t)
      .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
      .split('"').join('&quot;').split("'").join('&#39;');
  }
  function mzn(v){ return Number(v || 0).toLocaleString('pt-PT') + ' MZN'; }
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
  var ICONES = {
    carrinho: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1.4"/><circle cx="19" cy="21" r="1.4"/><path d="M2.5 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.3a2 2 0 0 0 2-1.5L22 7H6.2"/></svg>',
    lupa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    mais: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    fechar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
    seta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
    estrela: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>',
    whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.7a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.2-.2-.5-.3z"/></svg>',
    certo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    copiar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    caixa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><line x1="12" y1="13" x2="12" y2="21"/></svg>'
  };

  // ======================================================
  // Carrinho (guardado no browser de quem compra)
  // ======================================================
  function lerCarrinho(){
    try { var d = localStorage.getItem(CART_KEY); return d ? JSON.parse(d) : {}; } catch (e) { return {}; }
  }
  function guardarCarrinho(){
    try { localStorage.setItem(CART_KEY, JSON.stringify(carrinho)); } catch (e) {}
  }
  function limparCarrinho(){ carrinho = {}; guardarCarrinho(); }
  function itensDoCarrinho(){
    return Object.keys(carrinho).filter(function(id){ return carrinho[id] > 0; }).map(function(id){
      var p = produtoPorId(id);
      return p ? { produto: p, quantidade: carrinho[id] } : null;
    }).filter(function(x){ return x; });
  }
  function adicionar(id, qtd){
    carrinho[id] = (carrinho[id] || 0) + (qtd || 1);
    guardarCarrinho();
    renderCarrinho();
    var b = $('dia-carrinho-botao');
    if (b) { b.classList.remove('dia-pulo'); void b.offsetWidth; b.classList.add('dia-pulo'); }
    var p = produtoPorId(id);
    toast((p ? p.nome : 'Produto') + ' adicionado ao carrinho');
  }

  var temporizadorToast = null;
  function toast(texto){
    var t = $('dia-toast');
    if (!t) return;
    t.innerHTML = ICONES.certo + '<span>' + esc(texto) + '</span>';
    t.classList.add('dia-visivel');
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(function(){ t.classList.remove('dia-visivel'); }, 2200);
  }

  // ======================================================
  // Estilos
  // ======================================================
  function injectarEstilos(){
    var css = [
      '.dia-loja,.dia-carrinho-botao,.dia-painel-carrinho,.dia-overlay,.dia-toast{--_p:var(--dia-primaria,#111);--_pt:var(--dia-primaria-texto,#fff);--_r:var(--dia-raio,14px);--_ft:var(--dia-fonte-titulos,inherit);}',
      '.dia-loja{--_p:var(--dia-primaria,currentColor);--_s:var(--dia-superficie,color-mix(in srgb,currentColor 4%,transparent));--_t:var(--dia-texto,currentColor);--_ts:var(--dia-texto-suave,color-mix(in srgb,currentColor 62%,transparent));--_b:var(--dia-borda,color-mix(in srgb,currentColor 13%,transparent));--_f:var(--dia-fundo,Canvas);color:var(--_t);font-family:inherit;}',
      '.dia-loja *{box-sizing:border-box;}',
      /* capa */
      '.dia-capa{position:relative;border-radius:calc(var(--_r) + 8px);overflow:hidden;height:clamp(230px,44vw,480px);margin-bottom:22px;isolation:isolate;background:color-mix(in srgb,var(--_p) 18%,transparent);}',
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
      '.dia-capa-seta svg{width:18px;height:18px;}',
      '.dia-capa-seta.dia-esq{left:14px;}.dia-capa-seta.dia-esq svg{transform:rotate(180deg);}',
      '.dia-capa-seta.dia-dir{right:14px;}',
      /* barra: pesquisa + categorias */
      '.dia-barra{display:flex;flex-direction:column;gap:12px;padding:2px 0 6px;margin-bottom:6px;}',
      '.dia-pesquisa{display:flex;align-items:center;gap:10px;background:var(--_s);border:1px solid var(--_b);border-radius:999px;padding:0 16px;height:48px;transition:border-color .2s ease,box-shadow .2s ease;}',
      '.dia-pesquisa:focus-within{border-color:var(--_p);box-shadow:0 0 0 4px color-mix(in srgb,var(--_p) 16%,transparent);}',
      '.dia-pesquisa svg{width:19px;height:19px;color:var(--_ts);flex-shrink:0;}',
      '.dia-pesquisa input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--_t);font-size:15px;font-family:inherit;height:100%;}',
      '.dia-pesquisa input::placeholder{color:var(--_ts);}',
      '.dia-categorias{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px;}',
      '.dia-categorias::-webkit-scrollbar{display:none;}',
      '.dia-chip{flex-shrink:0;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--_b);background:var(--_s);color:var(--_t);border-radius:999px;padding:8px 15px;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s ease;white-space:nowrap;}',
      '.dia-chip small{font-weight:600;opacity:.6;font-size:11.5px;}',
      '.dia-chip:hover{border-color:color-mix(in srgb,var(--_p) 55%,transparent);}',
      '.dia-chip.dia-activo{background:var(--dia-primaria,currentColor);color:var(--dia-primaria-texto,var(--_f));border-color:transparent;}',
      /* secções */
      '.dia-seccao{margin:26px 0 8px;}',
      '.dia-seccao-topo{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px;}',
      '.dia-seccao-titulo{font-family:var(--_ft);font-weight:800;font-size:clamp(20px,2.4vw,26px);letter-spacing:-.02em;margin:0;display:flex;align-items:center;gap:8px;}',
      '.dia-seccao-titulo svg{width:20px;height:20px;color:var(--_p);}',
      '.dia-ver-todos{background:none;border:none;color:var(--_ts);font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:4px;}',
      '.dia-ver-todos:hover{color:var(--_t);}',
      '.dia-ver-todos svg{width:14px;height:14px;}',
      '.dia-fila{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(200px,230px);gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;padding:4px 2px 14px;scrollbar-width:thin;}',
      '.dia-fila > *{scroll-snap-align:start;}',
      '.dia-grelha{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;}',
      '@media (max-width:560px){.dia-grelha{grid-template-columns:1fr 1fr;gap:10px;}.dia-fila{grid-auto-columns:minmax(160px,46%);}}',
      /* cartão de produto */
      '.dia-produto-card{position:relative;display:flex;flex-direction:column;background:var(--_s);border:1px solid var(--_b);border-radius:var(--_r);overflow:hidden;cursor:pointer;transition:transform .25s ease,box-shadow .25s ease,border-color .25s ease;}',
      '.dia-produto-card:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--_p) 40%,transparent);box-shadow:0 22px 40px -22px color-mix(in srgb,var(--_p) 70%,transparent);}',
      '.dia-produto-media{position:relative;aspect-ratio:1/1;overflow:hidden;background:color-mix(in srgb,currentColor 6%,transparent);}',
      '.dia-produto-img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .5s ease;}',
      '.dia-produto-card:hover .dia-produto-img{transform:scale(1.05);}',
      '.dia-produto-vazio{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--_ts);}',
      '.dia-produto-vazio svg{width:38%;height:38%;opacity:.45;}',
      '.dia-badge{position:absolute;top:10px;left:10px;background:#E11D48;color:#fff;font-size:12px;font-weight:800;padding:4px 9px;border-radius:999px;letter-spacing:.01em;box-shadow:0 6px 14px rgba(225,29,72,.35);}',
      '.dia-badge-destaque{position:absolute;top:10px;right:10px;width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.92);color:#F59E0B;display:flex;align-items:center;justify-content:center;}',
      '.dia-badge-destaque svg{width:15px;height:15px;}',
      '.dia-produto-corpo{padding:12px 12px 14px;display:flex;flex-direction:column;gap:6px;flex:1;}',
      '.dia-produto-cat{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--_ts);}',
      '.dia-produto-nome{font-family:var(--_ft);font-weight:700;font-size:14.5px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em;}',
      '.dia-produto-precos{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:auto;padding-right:44px;}',
      '.dia-produto-preco{font-weight:800;font-size:17px;letter-spacing:-.01em;}',
      '.dia-produto-antigo{font-size:12.5px;color:var(--_ts);text-decoration:line-through;}',
      '.dia-btn-add{position:absolute;right:10px;bottom:10px;width:38px;height:38px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:var(--dia-primaria,transparent);color:var(--dia-primaria-texto,currentColor);box-shadow:inset 0 0 0 1.5px var(--_p),0 8px 18px -8px color-mix(in srgb,var(--_p) 80%,transparent);transition:transform .2s ease;}',
      '.dia-btn-add:hover{transform:scale(1.1) rotate(90deg);}',
      '.dia-btn-add svg{width:18px;height:18px;}',
      '.dia-vazio{text-align:center;padding:50px 20px;color:var(--_ts);font-size:14.5px;}',
      '.dia-vazio svg{width:46px;height:46px;opacity:.5;margin-bottom:10px;}',
      '.dia-esqueleto{border-radius:var(--_r);aspect-ratio:3/4;background:linear-gradient(90deg,color-mix(in srgb,currentColor 5%,transparent) 25%,color-mix(in srgb,currentColor 11%,transparent) 50%,color-mix(in srgb,currentColor 5%,transparent) 75%);background-size:200% 100%;animation:dia-brilho 1.4s linear infinite;}',
      '@keyframes dia-brilho{from{background-position:200% 0;}to{background-position:-200% 0;}}',
      /* botão flutuante + toast */
      '.dia-carrinho-botao{position:fixed;right:18px;bottom:18px;z-index:99998;display:flex;align-items:center;gap:10px;background:var(--_p);color:var(--_pt);border:none;border-radius:999px;padding:14px 20px 14px 18px;font-size:14.5px;font-weight:800;cursor:pointer;box-shadow:0 16px 36px -10px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.12);font-family:inherit;transition:transform .2s ease;}',
      '.dia-carrinho-botao:hover{transform:translateY(-2px);}',
      '.dia-carrinho-botao svg{width:20px;height:20px;}',
      '.dia-contagem{min-width:22px;height:22px;border-radius:999px;background:var(--_pt);color:var(--_p);font-size:12px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;}',
      '.dia-pulo{animation:dia-pulo .5s cubic-bezier(.3,1.6,.5,1);}',
      '@keyframes dia-pulo{0%{transform:scale(1);}40%{transform:scale(1.15);}100%{transform:scale(1);}}',
      '.dia-toast{position:fixed;left:50%;bottom:86px;z-index:100001;transform:translate(-50%,20px);opacity:0;pointer-events:none;display:flex;align-items:center;gap:10px;background:#111;color:#fff;padding:12px 18px;border-radius:999px;font-size:14px;font-weight:600;box-shadow:0 14px 34px rgba(0,0,0,.3);transition:all .3s cubic-bezier(.2,.8,.2,1);max-width:calc(100vw - 32px);font-family:inherit;}',
      '.dia-toast.dia-visivel{opacity:1;transform:translate(-50%,0);}',
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
      '.dia-btn-sec:hover{border-color:var(--_p);}',
      '.dia-carrinho-vazio{text-align:center;color:var(--_ts);padding:60px 10px;font-size:14px;}',
      '.dia-carrinho-vazio svg{width:52px;height:52px;opacity:.4;margin-bottom:12px;}',
      /* janelas (produto e checkout) */
      '.dia-overlay{--_f:var(--dia-fundo,Canvas);--_t:var(--dia-texto,CanvasText);--_ts:var(--dia-texto-suave,color-mix(in srgb,var(--_t) 60%,transparent));--_b:var(--dia-borda,color-mix(in srgb,var(--_t) 13%,transparent));position:fixed;inset:0;background:rgba(8,8,12,.6);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);z-index:100002;display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit;animation:dia-surgir .2s ease;}',
      '.dia-modal{position:relative;background:var(--_f);color:var(--_t);border-radius:calc(var(--_r) + 8px);width:100%;max-width:440px;max-height:92vh;overflow-y:auto;box-shadow:0 40px 90px rgba(0,0,0,.4);animation:dia-subir .32s cubic-bezier(.2,.8,.2,1);}',
      '.dia-modal-corpo{padding:26px;}',
      '.dia-modal .dia-icone-btn.dia-fechar{position:absolute;top:14px;right:14px;z-index:3;background:color-mix(in srgb,var(--_f) 80%,transparent);}',
      '@keyframes dia-surgir{from{opacity:0;}to{opacity:1;}}',
      '@keyframes dia-subir{from{opacity:0;transform:translateY(20px) scale(.98);}to{opacity:1;transform:none;}}',
      '.dia-detalhe{max-width:880px;display:grid;grid-template-columns:1.05fr 1fr;}',
      '.dia-detalhe-media{background:color-mix(in srgb,var(--_t) 6%,transparent);min-height:320px;position:relative;}',
      '.dia-detalhe-media img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.dia-detalhe-info{padding:30px 28px;display:flex;flex-direction:column;gap:12px;}',
      '.dia-detalhe-nome{font-family:var(--_ft);font-weight:800;font-size:clamp(22px,3vw,30px);line-height:1.15;letter-spacing:-.02em;margin:0;}',
      '.dia-detalhe-precos{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}',
      '.dia-detalhe-preco{font-size:28px;font-weight:800;letter-spacing:-.02em;}',
      '.dia-detalhe-poupa{font-size:12.5px;font-weight:800;color:#E11D48;background:rgba(225,29,72,.1);padding:4px 9px;border-radius:999px;}',
      '.dia-detalhe-desc{color:var(--_ts);font-size:14.5px;line-height:1.7;white-space:pre-wrap;margin:4px 0 6px;}',
      '.dia-detalhe-qtd{display:flex;align-items:center;gap:12px;font-size:13px;font-weight:700;color:var(--_ts);}',
      '.dia-detalhe-qtd .dia-qtd button{width:38px;height:38px;}',
      '@media (max-width:720px){.dia-overlay{align-items:flex-end;padding:0;}.dia-modal{max-height:94vh;border-radius:calc(var(--_r) + 8px) calc(var(--_r) + 8px) 0 0;}.dia-detalhe{grid-template-columns:1fr;}.dia-detalhe-media{min-height:0;aspect-ratio:1/1;}}',
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
      '.dia-estado-pagamento{text-align:center;padding:16px 0 6px;}',
      '.dia-estado-pagamento p{color:var(--_ts);font-size:14px;line-height:1.6;margin:8px 0 0;}',
      '.dia-ok{width:72px;height:72px;border-radius:50%;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;background:rgba(34,197,94,.14);color:#16A34A;animation:dia-pulo .6s cubic-bezier(.3,1.6,.5,1);}',
      '.dia-ok svg{width:34px;height:34px;}',
      '.dia-ref{display:inline-block;font-weight:800;letter-spacing:.06em;background:color-mix(in srgb,var(--_t) 7%,transparent);padding:6px 12px;border-radius:999px;margin-top:10px;}',
      '.dia-spinner{width:34px;height:34px;border-radius:50%;border:3px solid var(--_b);border-top-color:var(--_p);animation:dia-girar .8s linear infinite;margin:0 auto 14px;}',
      '@keyframes dia-girar{to{transform:rotate(360deg);}}',
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
    if (!alvo) {
      console.error('Daniel IA: falta uma div com id="daniel-ia-produtos" nesta página - os produtos não têm onde aparecer.');
      return false;
    }
    var esqueletos = '';
    for (var i = 0; i < 8; i++) esqueletos += '<div class="dia-esqueleto"></div>';
    alvo.innerHTML = ''
      + '<div class="dia-loja">'
      + '<div class="dia-capa" id="dia-capa"></div>'
      + '<div class="dia-barra">'
      + '<label class="dia-pesquisa">' + ICONES.lupa + '<input type="search" id="dia-pesquisa" placeholder="Pesquisar produtos" autocomplete="off"></label>'
      + '<div class="dia-categorias" id="dia-categorias"></div>'
      + '</div>'
      + '<div id="dia-destaques"></div>'
      + '<div id="dia-catalogo"><div class="dia-grelha">' + esqueletos + '</div></div>'
      + '</div>';

    var botao = document.createElement('button');
    botao.id = 'dia-carrinho-botao';
    botao.className = 'dia-carrinho-botao';
    botao.setAttribute('aria-label', 'Abrir carrinho');
    botao.innerHTML = ICONES.carrinho + '<span>Carrinho</span><span class="dia-contagem" id="dia-carrinho-contagem">0</span>';
    document.body.appendChild(botao);

    var fundo = document.createElement('div');
    fundo.className = 'dia-fundo-escuro';
    fundo.id = 'dia-fundo-escuro';
    document.body.appendChild(fundo);

    var painel = document.createElement('aside');
    painel.id = 'dia-painel-carrinho';
    painel.className = 'dia-painel-carrinho';
    painel.innerHTML = ''
      + '<div class="dia-painel-cabeca"><strong>O teu carrinho</strong><button class="dia-icone-btn" id="dia-fechar-painel" aria-label="Fechar">' + ICONES.fechar + '</button></div>'
      + '<div id="dia-itens-carrinho"></div>'
      + '<div class="dia-painel-rodape" id="dia-painel-rodape">'
      + '<div class="dia-total"><span>Total</span><strong id="dia-total-carrinho">0 MZN</strong></div>'
      + '<button id="dia-btn-finalizar" class="dia-btn-principal" disabled>Finalizar compra</button>'
      + '</div>';
    document.body.appendChild(painel);

    var t = document.createElement('div');
    t.className = 'dia-toast';
    t.id = 'dia-toast';
    document.body.appendChild(t);

    botao.addEventListener('click', abrirPainel);
    fundo.addEventListener('click', fecharPainel);
    $('dia-fechar-painel').addEventListener('click', fecharPainel);
    $('dia-btn-finalizar').addEventListener('click', function(){ fecharPainel(); abrirCheckout(); });
    $('dia-pesquisa').addEventListener('input', function(){
      filtro.texto = this.value;
      renderCatalogo();
    });
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

  // ======================================================
  // Capa (carrossel)
  // ======================================================
  function renderCapa(){
    var capa = $('dia-capa');
    if (!capa) return;
    var slides = loja.capa || [];
    // Sites antigos podem ter a loja a meio da página, depois do hero do
    // próprio site - aí uma capa gerada ficaria repetida. Sem imagens de
    // capa e com a loja já lá em baixo, não mostramos capa nenhuma.
    if (!slides.length && capa.getBoundingClientRect().top + window.pageYOffset > window.innerHeight * 1.1) {
      capa.style.display = 'none';
      return;
    }
    if (!slides.length) {
      capa.innerHTML = '<div class="dia-capa-gerada"></div>'
        + '<div class="dia-slide-texto"><h2 class="dia-slide-titulo">' + esc(loja.nome || 'A nossa loja') + '</h2>'
        + '<p class="dia-slide-sub">' + (produtos.length ? esc(produtos.length + ' produtos à tua espera. Escolhe, encomenda e recebe.') : 'Descobre os nossos produtos.') + '</p>'
        + '<button class="dia-slide-btn" data-ir-catalogo>Ver produtos ' + ICONES.seta + '</button></div>';
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
        html += '<button class="dia-capa-seta dia-esq" aria-label="Anterior">' + ICONES.seta + '</button>'
          + '<button class="dia-capa-seta dia-dir" aria-label="Seguinte">' + ICONES.seta + '</button>'
          + '<div class="dia-capa-pontos">' + slides.map(function(s, i){
            return '<button class="dia-ponto' + (i === 0 ? ' dia-activo' : '') + '" data-i="' + i + '" aria-label="Imagem ' + (i + 1) + '"></button>';
          }).join('') + '</div>';
      }
      capa.innerHTML = html;
      if (slides.length > 1) ligarCarrossel(capa, slides.length);
    }
    Array.prototype.forEach.call(capa.querySelectorAll('[data-ir-catalogo]'), function(b){
      b.addEventListener('click', function(){
        var alvo = $('dia-destaques').firstChild ? $('dia-destaques') : $('dia-catalogo');
        alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function ligarCarrossel(capa, total){
    function irPara(i){
      slideActual = (i + total) % total;
      Array.prototype.forEach.call(capa.querySelectorAll('.dia-slide'), function(el, j){ el.classList.toggle('dia-activo', j === slideActual); });
      Array.prototype.forEach.call(capa.querySelectorAll('.dia-ponto'), function(el, j){ el.classList.toggle('dia-activo', j === slideActual); });
    }
    function reiniciar(){
      clearInterval(temporizadorCapa);
      temporizadorCapa = setInterval(function(){ irPara(slideActual + 1); }, 5500);
    }
    capa.querySelector('.dia-esq').addEventListener('click', function(){ irPara(slideActual - 1); reiniciar(); });
    capa.querySelector('.dia-dir').addEventListener('click', function(){ irPara(slideActual + 1); reiniciar(); });
    Array.prototype.forEach.call(capa.querySelectorAll('.dia-ponto'), function(el){
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
  // Categorias, destaques e catálogo
  // ======================================================
  function categorias(){
    var mapa = {}, ordem = [];
    produtos.forEach(function(p){
      var c = p.categoria || 'Outros';
      if (!mapa[c]) { mapa[c] = 0; ordem.push(c); }
      mapa[c]++;
    });
    // "Outros" vai sempre para o fim
    ordem.sort(function(a, b){ return (a === 'Outros') - (b === 'Outros'); });
    return ordem.map(function(c){ return { nome: c, total: mapa[c] }; });
  }

  function renderCategorias(){
    var el = $('dia-categorias');
    if (!el) return;
    var cats = categorias();
    if (cats.length < 2) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = 'flex';
    var html = '<button class="dia-chip' + (!filtro.categoria ? ' dia-activo' : '') + '" data-cat="">Tudo <small>' + produtos.length + '</small></button>';
    html += cats.map(function(c){
      return '<button class="dia-chip' + (filtro.categoria === c.nome ? ' dia-activo' : '') + '" data-cat="' + esc(c.nome) + '">' + esc(c.nome) + ' <small>' + c.total + '</small></button>';
    }).join('');
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll('.dia-chip'), function(b){
      b.addEventListener('click', function(){
        filtro.categoria = b.getAttribute('data-cat');
        renderCategorias();
        renderCatalogo();
        var cat = $('dia-catalogo');
        if (cat && cat.getBoundingClientRect().top < 0) cat.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function cartao(p){
    var d = desconto(p);
    return '<article class="dia-produto-card" data-id="' + esc(p.id) + '" tabindex="0">'
      + '<div class="dia-produto-media">'
      + (p.imagem ? '<img class="dia-produto-img" src="' + esc(p.imagem) + '" alt="' + esc(p.nome) + '" loading="lazy">' : '<div class="dia-produto-vazio">' + ICONES.caixa + '</div>')
      + (d > 0 ? '<span class="dia-badge">-' + d + '%</span>' : '')
      + (p.destaque ? '<span class="dia-badge-destaque" title="Em destaque">' + ICONES.estrela + '</span>' : '')
      + '</div>'
      + '<div class="dia-produto-corpo">'
      + (p.categoria ? '<div class="dia-produto-cat">' + esc(p.categoria) + '</div>' : '')
      + '<div class="dia-produto-nome">' + esc(p.nome) + '</div>'
      + '<div class="dia-produto-precos"><span class="dia-produto-preco">' + mzn(p.preco) + '</span>'
      + (d > 0 ? '<s class="dia-produto-antigo">' + mzn(p.preco_antigo) + '</s>' : '') + '</div>'
      + '</div>'
      + '<button class="dia-btn-add" data-add="' + esc(p.id) + '" aria-label="Adicionar ' + esc(p.nome) + ' ao carrinho">' + ICONES.mais + '</button>'
      + '</article>';
  }

  function ligarCartoes(raiz){
    Array.prototype.forEach.call(raiz.querySelectorAll('.dia-produto-card'), function(card){
      card.addEventListener('click', function(e){
        var add = e.target.closest ? e.target.closest('[data-add]') : null;
        if (add) { e.stopPropagation(); adicionar(add.getAttribute('data-add'), 1); return; }
        abrirProduto(card.getAttribute('data-id'));
      });
      card.addEventListener('keydown', function(e){
        if (e.key === 'Enter') abrirProduto(card.getAttribute('data-id'));
      });
    });
  }

  function renderDestaques(){
    var el = $('dia-destaques');
    if (!el) return;
    var lista = produtos.filter(function(p){ return p.destaque; });
    if (!lista.length || filtro.texto || filtro.categoria) { el.innerHTML = ''; return; }
    el.innerHTML = '<section class="dia-seccao"><div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + ICONES.estrela + 'Em destaque</h3></div>'
      + '<div class="dia-fila">' + lista.map(cartao).join('') + '</div></section>';
    ligarCartoes(el);
  }

  function renderCatalogo(){
    var el = $('dia-catalogo');
    if (!el) return;
    renderDestaques();
    if (!produtos.length) {
      el.innerHTML = '<div class="dia-vazio">' + ICONES.caixa + '<div>Ainda não há produtos à venda aqui.</div></div>';
      return;
    }
    var texto = normalizar(filtro.texto.trim());
    var lista = produtos.filter(function(p){
      if (filtro.categoria && (p.categoria || 'Outros') !== filtro.categoria) return false;
      if (texto && normalizar(p.nome + ' ' + (p.categoria || '') + ' ' + (p.descricao || '')).indexOf(texto) === -1) return false;
      return true;
    });

    if (!lista.length) {
      el.innerHTML = '<div class="dia-vazio">' + ICONES.lupa + '<div>Nenhum produto encontrado' + (filtro.texto ? ' para "' + esc(filtro.texto.trim()) + '"' : '') + '.</div></div>';
      return;
    }

    // Sem filtros e com várias categorias: uma secção por categoria (estilo
    // marketplace). Com filtro ou pesquisa: uma grelha só com os resultados.
    var cats = categorias();
    if (!texto && !filtro.categoria && cats.length > 1) {
      el.innerHTML = cats.map(function(c){
        var daCat = lista.filter(function(p){ return (p.categoria || 'Outros') === c.nome; });
        return '<section class="dia-seccao"><div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + esc(c.nome) + '</h3>'
          + (daCat.length > 4 ? '<button class="dia-ver-todos" data-cat="' + esc(c.nome) + '">Ver todos ' + ICONES.seta + '</button>' : '')
          + '</div><div class="dia-grelha">' + daCat.slice(0, 8).map(cartao).join('') + '</div></section>';
      }).join('');
      Array.prototype.forEach.call(el.querySelectorAll('.dia-ver-todos'), function(b){
        b.addEventListener('click', function(){
          filtro.categoria = b.getAttribute('data-cat');
          renderCategorias();
          renderCatalogo();
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    } else {
      var titulo = filtro.categoria || (texto ? 'Resultados' : 'Produtos');
      el.innerHTML = '<section class="dia-seccao"><div class="dia-seccao-topo"><h3 class="dia-seccao-titulo">' + esc(titulo) + '</h3>'
        + '<span class="dia-ver-todos" style="cursor:default">' + lista.length + ' produto' + (lista.length === 1 ? '' : 's') + '</span></div>'
        + '<div class="dia-grelha">' + lista.map(cartao).join('') + '</div></section>';
    }
    ligarCartoes(el);
  }

  // ======================================================
  // Janelas (produto e checkout)
  // ======================================================
  function abrirJanela(html, classeExtra){
    fecharJanela();
    var overlay = document.createElement('div');
    overlay.className = 'dia-overlay';
    overlay.id = 'dia-janela';
    overlay.innerHTML = '<div class="dia-modal ' + (classeExtra || '') + '" role="dialog" aria-modal="true">'
      + '<button class="dia-icone-btn dia-fechar" aria-label="Fechar">' + ICONES.fechar + '</button>' + html + '</div>';
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

  function abrirProduto(id){
    var p = produtoPorId(id);
    if (!p) return;
    var d = desconto(p);
    var qtd = 1;
    var j = abrirJanela(''
      + '<div class="dia-detalhe-media">' + (p.imagem ? '<img src="' + esc(p.imagem) + '" alt="' + esc(p.nome) + '">' : '<div class="dia-produto-vazio">' + ICONES.caixa + '</div>')
      + (d > 0 ? '<span class="dia-badge">-' + d + '%</span>' : '') + '</div>'
      + '<div class="dia-detalhe-info">'
      + (p.categoria ? '<div class="dia-produto-cat">' + esc(p.categoria) + '</div>' : '')
      + '<h3 class="dia-detalhe-nome">' + esc(p.nome) + '</h3>'
      + '<div class="dia-detalhe-precos"><span class="dia-detalhe-preco">' + mzn(p.preco) + '</span>'
      + (d > 0 ? '<s class="dia-produto-antigo">' + mzn(p.preco_antigo) + '</s><span class="dia-detalhe-poupa">Poupas ' + mzn(p.preco_antigo - p.preco) + '</span>' : '') + '</div>'
      + (p.descricao ? '<p class="dia-detalhe-desc">' + esc(p.descricao) + '</p>' : '')
      + '<div class="dia-detalhe-qtd">Quantidade <div class="dia-qtd"><button data-q="-1" aria-label="Menos">−</button><span id="dia-det-qtd">1</span><button data-q="1" aria-label="Mais">+</button></div></div>'
      + '<button class="dia-btn-principal" id="dia-det-add">' + ICONES.carrinho + ' Adicionar ao carrinho</button>'
      + '<button class="dia-btn-sec" id="dia-det-comprar">Comprar agora</button>'
      + '</div>', 'dia-detalhe');
    Array.prototype.forEach.call(j.querySelectorAll('[data-q]'), function(b){
      b.addEventListener('click', function(){
        qtd = Math.max(1, Math.min(99, qtd + Number(b.getAttribute('data-q'))));
        $('dia-det-qtd').textContent = qtd;
      });
    });
    $('dia-det-add').addEventListener('click', function(){ adicionar(p.id, qtd); fecharJanela(); });
    $('dia-det-comprar').addEventListener('click', function(){ adicionar(p.id, qtd); fecharJanela(); abrirCheckout(); });
  }

  // ======================================================
  // Carrinho (painel)
  // ======================================================
  function renderCarrinho(){
    var itens = itensDoCarrinho();
    var contagem = itens.reduce(function(t, i){ return t + i.quantidade; }, 0);
    var elC = $('dia-carrinho-contagem');
    if (elC) elC.textContent = contagem;
    var cont = $('dia-itens-carrinho');
    if (!cont) return;
    var total = 0;
    if (!itens.length) {
      cont.innerHTML = '<div class="dia-carrinho-vazio">' + ICONES.carrinho + '<div>O teu carrinho está vazio.</div></div>';
    } else {
      cont.innerHTML = itens.map(function(i){
        var sub = i.produto.preco * i.quantidade;
        total += sub;
        return '<div class="dia-item-carrinho">'
          + (i.produto.imagem ? '<img class="dia-item-img" src="' + esc(i.produto.imagem) + '" alt="">' : '<div class="dia-item-img"></div>')
          + '<div class="dia-item-info"><div class="dia-item-nome">' + esc(i.produto.nome) + '</div>'
          + '<div class="dia-item-linha"><div class="dia-qtd"><button data-menos="' + esc(i.produto.id) + '" aria-label="Menos">−</button><span>' + i.quantidade + '</span><button data-mais="' + esc(i.produto.id) + '" aria-label="Mais">+</button></div>'
          + '<span class="dia-item-preco">' + mzn(sub) + '</span></div>'
          + '<button class="dia-remover" data-remover="' + esc(i.produto.id) + '">Remover</button></div></div>';
      }).join('');
    }
    $('dia-total-carrinho').textContent = mzn(total);
    $('dia-btn-finalizar').disabled = !itens.length;
    Array.prototype.forEach.call(cont.querySelectorAll('[data-mais]'), function(b){
      b.addEventListener('click', function(){ var id = b.getAttribute('data-mais'); carrinho[id] = Math.min(99, (carrinho[id] || 0) + 1); guardarCarrinho(); renderCarrinho(); });
    });
    Array.prototype.forEach.call(cont.querySelectorAll('[data-menos]'), function(b){
      b.addEventListener('click', function(){ var id = b.getAttribute('data-menos'); carrinho[id] = (carrinho[id] || 0) - 1; if (carrinho[id] <= 0) delete carrinho[id]; guardarCarrinho(); renderCarrinho(); });
    });
    Array.prototype.forEach.call(cont.querySelectorAll('[data-remover]'), function(b){
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
    var total = itens.reduce(function(t, i){ return t + i.produto.preco * i.quantidade; }, 0);
    var qtd = itens.reduce(function(t, i){ return t + i.quantidade; }, 0);
    var modo = loja.modo;

    var blocoModo = '';
    var textoBotao = 'Confirmar encomenda';
    var classeBotao = 'dia-btn-principal';
    var iconeBotao = '';
    if (modo === 'daniel') {
      var nomesMetodos = { mpesa: ['M-Pesa', 'Vodacom'], emola: ['e-Mola', 'Movitel'], cartao: ['Cartão', 'Visa / Mastercard'] };
      blocoModo = '<div class="dia-campo"><label>Como queres pagar?</label><div class="dia-metodos">'
        + loja.metodos.map(function(m){ return '<div class="dia-metodo" data-metodo="' + m + '">' + nomesMetodos[m][0] + '<small>' + nomesMetodos[m][1] + '</small></div>'; }).join('')
        + '</div></div>';
      textoBotao = 'Pagar ' + mzn(total);
    } else if (modo === 'manual' && loja.manual) {
      blocoModo = '<div class="dia-pagar-para"><p>Depois de confirmares, paga directamente à loja para um destes números, com a referência que te vamos dar:</p>'
        + (loja.manual.mpesa ? '<div class="dia-numero"><span>M-Pesa <b>' + esc(loja.manual.mpesa) + '</b></span></div>' : '')
        + (loja.manual.emola ? '<div class="dia-numero"><span>e-Mola <b>' + esc(loja.manual.emola) + '</b></span></div>' : '')
        + (loja.manual.titular ? '<p style="margin:10px 0 0">Em nome de <b>' + esc(loja.manual.titular) + '</b></p>' : '')
        + '</div>';
    } else if (modo === 'whatsapp') {
      textoBotao = 'Encomendar pelo WhatsApp';
      classeBotao += ' dia-wa';
      iconeBotao = ICONES.whatsapp;
    } else {
      textoBotao = 'Enviar encomenda';
    }

    var j = abrirJanela('<div class="dia-modal-corpo">'
      + '<h3>Finalizar compra</h3>'
      + '<p class="dia-modal-sub">' + (modo === 'whatsapp' ? 'Preenche os teus dados e enviamos a encomenda para o WhatsApp da loja.' : (modo === 'pedido' ? 'A loja recebe a tua encomenda e contacta-te para combinar o pagamento e a entrega.' : 'Só falta isto para receberes a tua encomenda.')) + '</p>'
      + '<div id="dia-checkout-form">'
      + '<div class="dia-resumo"><span>' + qtd + ' artigo' + (qtd === 1 ? '' : 's') + '</span><strong>' + mzn(total) + '</strong></div>'
      + '<div class="dia-campo"><label for="dia-cliente-nome">O teu nome</label><input type="text" id="dia-cliente-nome" maxlength="100" autocomplete="name"></div>'
      + '<div class="dia-campo"><label for="dia-cliente-telefone">Telefone' + (modo === 'daniel' ? ' (o mesmo da carteira, para M-Pesa/e-Mola)' : '') + '</label><input type="tel" id="dia-cliente-telefone" maxlength="20" placeholder="84 123 4567" autocomplete="tel"></div>'
      + '<div class="dia-campo"><label for="dia-cliente-email">Email (opcional, para receberes a confirmação)</label><input type="email" id="dia-cliente-email" maxlength="150" autocomplete="email"></div>'
      + '<div class="dia-campo"><label for="dia-cliente-notas">Morada de entrega / notas (opcional)</label><textarea id="dia-cliente-notas" rows="2" maxlength="500"></textarea></div>'
      + blocoModo
      + '<button class="' + classeBotao + '" id="dia-btn-pagar">' + iconeBotao + '<span>' + textoBotao + '</span></button>'
      + '<div class="dia-msg-erro" id="dia-checkout-erro"></div>'
      + '</div>'
      + '<div id="dia-checkout-estado" style="display:none"></div>'
      + '</div>');

    metodoSeleccionado = '';
    Array.prototype.forEach.call(j.querySelectorAll('.dia-metodo'), function(el){
      el.addEventListener('click', function(){
        Array.prototype.forEach.call(j.querySelectorAll('.dia-metodo'), function(x){ x.classList.remove('seleccionado'); });
        el.classList.add('seleccionado');
        metodoSeleccionado = el.getAttribute('data-metodo');
      });
    });
    $('dia-btn-pagar').addEventListener('click', function(){ confirmar(itens, modo, textoBotao); });
  }

  function confirmar(itens, modo, textoBotao){
    var nome = $('dia-cliente-nome').value.trim();
    var telefone = $('dia-cliente-telefone').value.trim();
    var email = $('dia-cliente-email').value.trim();
    var notas = $('dia-cliente-notas').value.trim();
    var elErro = $('dia-checkout-erro');
    elErro.textContent = '';
    if (nome.length < 2) { elErro.textContent = 'Escreve o teu nome.'; return; }
    if (soDigitos(telefone).length < 9) { elErro.textContent = 'Escreve o teu número de telefone.'; return; }
    if (email && !emailValido(email)) { elErro.textContent = 'Esse email não parece válido - podes deixá-lo em branco.'; return; }
    if (modo === 'daniel' && !metodoSeleccionado) { elErro.textContent = 'Escolhe como queres pagar.'; return; }

    var btn = $('dia-btn-pagar');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'A processar...';

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
      itens: itens.map(function(i){ return { produto_id: i.produto.id, quantidade: i.quantidade }; })
    }).then(function(r){
      if (r.status !== 'success') throw new Error(r.message || 'Não foi possível criar a encomenda.');
      var enc = r.response;
      if (enc.modo === 'daniel') {
        return post('/loja-pagar', { encomenda_id: enc.encomenda_id, metodo: metodoSeleccionado }).then(function(rp){
          if (rp.status !== 'success') throw new Error(rp.message || 'Não foi possível iniciar o pagamento.');
          if (rp.response.tipo === 'cartao') { window.location.href = rp.response.checkout_url; return; }
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
      elErro.textContent = erro.message || 'Algo correu mal. Tenta novamente.';
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
      + '<h3>Encomenda enviada!</h3><div class="dia-ref">' + esc(enc.referencia) + '</div>';
    if (enc.modo === 'manual' && enc.manual) {
      html += '<p>Para concluir, paga <b>' + mzn(enc.valor_total) + '</b> com a referência <b>' + esc(enc.referencia) + '</b>:</p>'
        + (enc.manual.mpesa ? '<div class="dia-numero"><span>M-Pesa <b>' + esc(enc.manual.mpesa) + '</b></span><button class="dia-copiar" data-copiar="' + esc(enc.manual.mpesa) + '">' + ICONES.copiar + 'Copiar</button></div>' : '')
        + (enc.manual.emola ? '<div class="dia-numero"><span>e-Mola <b>' + esc(enc.manual.emola) + '</b></span><button class="dia-copiar" data-copiar="' + esc(enc.manual.emola) + '">' + ICONES.copiar + 'Copiar</button></div>' : '')
        + (enc.manual.titular ? '<p>Em nome de <b>' + esc(enc.manual.titular) + '</b>. A loja confirma o pagamento e prepara a tua encomenda.</p>' : '<p>A loja confirma o pagamento e prepara a tua encomenda.</p>');
      if (enc.whatsapp_url) html += '<a class="dia-btn-principal dia-wa" style="margin-top:16px;text-decoration:none" href="' + esc(enc.whatsapp_url) + '" target="_blank" rel="noopener">' + ICONES.whatsapp + '<span>Enviar comprovativo no WhatsApp</span></a>';
    } else if (enc.modo === 'whatsapp') {
      html += '<p>Abrimos o WhatsApp com a tua encomenda já escrita - só tens de carregar em enviar.</p>'
        + '<a class="dia-btn-principal dia-wa" style="margin-top:16px;text-decoration:none" href="' + esc(enc.whatsapp_url) + '" target="_blank" rel="noopener">' + ICONES.whatsapp + '<span>Abrir o WhatsApp outra vez</span></a>';
    } else {
      html += '<p>A loja recebeu a tua encomenda e vai contactar-te em breve para combinar o pagamento e a entrega.</p>';
    }
    html += '<button class="dia-btn-sec" data-fechar-final>Continuar a comprar</button></div>';
    var el = mostrarEstado(html);
    el.querySelector('[data-fechar-final]').addEventListener('click', fecharJanela);
    Array.prototype.forEach.call(el.querySelectorAll('[data-copiar]'), function(b){
      b.addEventListener('click', function(){
        var v = b.getAttribute('data-copiar');
        try { navigator.clipboard.writeText(v); } catch (e) {}
        b.innerHTML = ICONES.certo + 'Copiado';
      });
    });
  }

  function esperarPagamento(encomendaId, referencia){
    var el = mostrarEstado('<div class="dia-estado-pagamento"><div class="dia-spinner"></div><h3>Confirma no teu telemóvel</h3>'
      + '<p id="dia-estado-texto">Enviámos o pedido de pagamento para o teu número. Introduz o PIN para confirmar.</p></div>');
    var tentativas = 0;
    function verificar(){
      post('/loja-estado', { encomenda_id: encomendaId }).then(function(r){
        if (r.status === 'success' && r.response.estado === 'Pago') {
          el.innerHTML = '<div class="dia-estado-pagamento"><div class="dia-ok">' + ICONES.certo + '</div><h3>Pagamento confirmado!</h3>'
            + '<div class="dia-ref">' + esc(referencia) + '</div><p>Obrigado pela tua compra. A loja já recebeu a tua encomenda.</p>'
            + '<button class="dia-btn-sec" data-fechar-final>Continuar a comprar</button></div>';
          el.querySelector('[data-fechar-final]').addEventListener('click', fecharJanela);
          return;
        }
        tentativas++;
        if (tentativas >= 25) {
          var t = $('dia-estado-texto');
          if (t) t.textContent = 'Ainda não recebemos a confirmação. Se já pagaste, aguarda - a loja recebe a encomenda assim que o pagamento chegar.';
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
  function iniciar(){
    injectarEstilos();
    if (!montarUI()) return;
    renderCarrinho();
    post('/loja-produtos', { site_id: SITE_ID }).then(function(r){
      if (r.status !== 'success') throw new Error();
      produtos = r.response.produtos || [];
      if (r.response.loja) loja = r.response.loja;
      renderCapa();
      renderCategorias();
      renderCatalogo();
      renderCarrinho();
    }).catch(function(){
      renderCapa();
      $('dia-catalogo').innerHTML = '<div class="dia-vazio">Não foi possível carregar os produtos. Recarrega a página.</div>';
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
      return d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'long', year: 'numeric' });
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

// Módulo fixo do Formulário de Contacto - ao contrário dos outros
// módulos (loja/galeria/portefólio/blog), este é injectado em TODOS os
// sites gerados, seja qual for o tipo (ver injectarContactoSeNecessario
// mais acima). A IA nunca escreve este formulário - só deixa a div
// com id="daniel-ia-contacto" onde este módulo o desenha a sério.
const CONTACTO_FORM_JS = `/*
  Daniel IA - módulo fixo do Formulário de Contacto
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

  var CONTAINER_URL = 'https://mc-8oxfde5o71.bunny.run';
  var SITE_ID = window.DANIEL_IA_SITE_ID || '';

  if (!SITE_ID) {
    console.error('Daniel IA: falta window.DANIEL_IA_SITE_ID nesta página - o formulário de contacto não pode arrancar.');
    return;
  }

  function injectarEstilos(){
    var css = ''
      + '.dic-caixa{--_s:var(--dia-superficie,color-mix(in srgb,currentColor 5%,transparent));--_t:var(--dia-texto,currentColor);--_ts:var(--dia-texto-suave,color-mix(in srgb,currentColor 62%,transparent));--_b:var(--dia-borda,color-mix(in srgb,currentColor 13%,transparent));--_r:var(--dia-raio,14px);--_ft:var(--dia-fonte-titulos,inherit);--_p:var(--dia-primaria,currentColor);background:var(--_s);border:1px solid var(--_b);border-radius:calc(var(--_r) + 4px);padding:30px;color:var(--_t);font-family:inherit;}'
      + '.dic-titulo{font-family:var(--_ft);font-weight:800;font-size:22px;letter-spacing:-.02em;color:var(--_t);margin:0 0 6px 0;}'
      + '.dic-sub{font-size:14px;color:var(--_ts);margin:0 0 22px 0;line-height:1.55;}'
      + '.dic-campo{margin-bottom:14px;}'
      + '.dic-label{display:block;font-size:12.5px;font-weight:700;color:var(--_ts);margin-bottom:7px;}'
      + '.dic-input,.dic-textarea{width:100%;box-sizing:border-box;background:color-mix(in srgb,currentColor 4%,transparent);border:1px solid var(--_b);border-radius:calc(var(--_r) - 4px);padding:13px 14px;color:var(--_t);font-size:15px;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s,background .15s;}'
      + '.dic-input:focus,.dic-textarea:focus{border-color:var(--_p);box-shadow:0 0 0 3px color-mix(in srgb,var(--_p) 22%,transparent);background:transparent;}'
      + '.dic-textarea{resize:vertical;min-height:120px;}'
      + '.dic-botao{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--dia-primaria,transparent);color:var(--dia-primaria-texto,currentColor);border:none;border-radius:calc(var(--_r) - 4px);padding:14px 26px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:inset 0 0 0 1.5px var(--_p),0 14px 28px -16px color-mix(in srgb,var(--_p) 70%,transparent);transition:transform .15s ease,filter .15s ease;}'
      + '.dic-botao:hover{filter:brightness(1.1);transform:translateY(-1px);}'
      + '.dic-botao:disabled{opacity:.6;cursor:default;transform:none;}'
      + '.dic-msg{font-size:14px;margin-top:14px;padding:12px 14px;border-radius:calc(var(--_r) - 4px);display:none;line-height:1.5;}'
      + '.dic-msg.dic-sucesso{display:block;background:rgba(122,196,35,.12);color:inherit;border:1px solid rgba(122,196,35,.4);}'
      + '.dic-msg.dic-erro{display:block;background:rgba(214,69,69,.1);color:inherit;border:1px solid rgba(214,69,69,.4);}'
      + '@media (prefers-reduced-motion:reduce){.dic-input,.dic-textarea,.dic-botao{transition:none !important;animation:none !important;}}';
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
      + '<div class="dic-caixa">'
      + '<p class="dic-titulo">Fale connosco</p>'
      + '<p class="dic-sub">Preenche o formulário e entraremos em contacto.</p>'
      + '<form id="dic-form">'
      + '<div class="dic-campo">'
      + '<label class="dic-label" for="dic-nome">Nome</label>'
      + '<input class="dic-input" id="dic-nome" name="nome" type="text" required maxlength="120">'
      + '</div>'
      + '<div class="dic-campo">'
      + '<label class="dic-label" for="dic-email">Email</label>'
      + '<input class="dic-input" id="dic-email" name="email" type="email" required maxlength="160">'
      + '</div>'
      + '<div class="dic-campo">'
      + '<label class="dic-label" for="dic-mensagem">Mensagem</label>'
      + '<textarea class="dic-textarea" id="dic-mensagem" name="mensagem" required maxlength="2000"></textarea>'
      + '</div>'
      + '<button class="dic-botao" id="dic-enviar" type="submit">Enviar mensagem</button>'
      + '<div class="dic-msg" id="dic-msg"></div>'
      + '</form>'
      + '</div>';
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
        mostrarMensagem('erro', 'Preenche todos os campos.');
        return;
      }
      if (!validarEmail(email)) {
        mostrarMensagem('erro', 'Introduz um email válido.');
        return;
      }

      botao.disabled = true;
      botao.textContent = 'A enviar...';
      mostrarMensagem('', '');

      fetch(CONTAINER_URL + '/contacto-enviar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: SITE_ID, nome: nome, email_remetente: email, mensagem: mensagem })
      }).then(function(r){ return r.json(); })
        .then(function(r){
          botao.disabled = false;
          botao.textContent = 'Enviar mensagem';
          if (r.status === 'success') {
            mostrarMensagem('sucesso', 'Mensagem enviada. Entraremos em contacto em breve.');
            form.reset();
          } else {
            mostrarMensagem('erro', (r.message || 'Não foi possível enviar a mensagem.'));
          }
        })
        .catch(function(){
          botao.disabled = false;
          botao.textContent = 'Enviar mensagem';
          mostrarMensagem('erro', 'Não foi possível ligar ao servidor.');
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

    if (!owner || !nome || !tipo || !prompt) {
      return res.json({ status: 'error', message: 'Faltam dados: nome, tipo e prompt são obrigatórios.' });
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
    const planId = await garantirPlano(owner, user);
    if (!planId) {
      return res.json({ status: 'error', message: 'A tua conta não tem nenhum plano atribuído, e não encontrei nenhum plano Free para atribuir automaticamente.' });
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
        tokens_incluidos: tokensIncluidos
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

    return res.json({ status: 'success', response: { produtos: produtos.map(produtoParaLista), loja } });
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

    const produtoId = await bubbleCreate('produto', dados);
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

    await bubblePatch('produto', produto_id, dados);
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
      // Sem pagamento online: o dono recebe já a encomenda por email.
      avisarEncomenda(site, encomendaId, modo, cfg);
      if (modo === 'manual') {
        resposta.manual = { mpesa: cfg.mpesa, emola: cfg.emola, titular: cfg.titular };
      }
      if (cfg.whatsapp) {
        const linhas = itensCalculados.map(i => '• ' + i.quantidade + 'x ' + i.nome + ' - ' + (i.preco_unitario * i.quantidade).toLocaleString('pt-PT') + ' MZN');
        const texto = 'Olá! Quero fazer esta encomenda (' + referencia + '):\n\n' + linhas.join('\n')
          + '\n\nTotal: ' + valorTotal.toLocaleString('pt-PT') + ' MZN'
          + '\n\nNome: ' + String(cliente_nome).trim()
          + '\nTelefone: ' + String(cliente_telefone).trim()
          + (notas ? '\nMorada/notas: ' + notas : '');
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
        nome_producto: 'Assinatura Daniel IA',
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

    return res.json({ status: 'success', response: { tipo: 'cartao', checkout_url: checkoutUrl } });

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
    return res.json({
      status: 'success',
      response: { estado: assinatura['Estado'], valor_mzn: assinatura['Valor MZN'] }
    });
  } catch (erro) {
    console.error('Erro em /assinatura-estado:', erro);
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
var APP_URL_JS = ${JSON.stringify(APP_URL)};
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
  if (!ASSINATURA_ID) {
    mostrarEstado('erro', 'Não encontrámos a tua assinatura', 'Volta ao dashboard e tenta novamente.');
    return;
  }
  fetch('/assinatura-estado', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assinatura_id: ASSINATURA_ID })
  }).then(function(r){ return r.json(); })
    .then(function(r){
      if (r.status === 'success' && r.response.estado === 'Pago') {
        mostrarEstado('pago', 'Pagamento confirmado!', 'O teu plano já está actualizado.');
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

    const codigo = gerarCodigo();
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
    console.error('Erro em /signup-code:', erro);
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

    if (usuario['Token Confirmado']) {
      // já estava confirmado antes, sem mal nenhum - mas ainda assim dá-lhe
      // uma sessão nova, para o caso de ter chegado aqui sem token (ex:
      // clicou duas vezes seguidas no botão de confirmar).
      const tokenExistente = await criarTokenSessao(owner).catch(() => null);
      return res.json({ status: 'success', token: tokenExistente });
    }

    const codigoCerto = String(usuario['Token'] || '').trim().toUpperCase();
    const codigoRecebido = String(code || '').trim().toUpperCase();
    if (!codigoCerto || codigoRecebido !== codigoCerto) {
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

app.post('/sessao-criar', async (req, res) => {
  try {
    const { owner, key } = req.body;
    if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
      return res.json({ status: 'error', message: 'Não autorizado.' });
    }
    if (!owner) {
      return res.json({ status: 'error', message: 'Falta o owner.' });
    }

    const token = await criarTokenSessao(owner);
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
    if (!ADMIN_SECRET || req.body.key !== ADMIN_SECRET) {
      return res.json({ status: 'error', message: 'Não autorizado.' });
    }
    await verificarAvisosExpiracao();
    return res.json({ status: 'success', message: 'Verificação feita - ver os logs do container para detalhes.' });
  } catch (erro) {
    return res.json({ status: 'error', message: 'Falhou: ' + erro.message });
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
    if (!chaveAdminValida(req.body.key)) {
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

// ---- Admin: uma imagem decifrada ----
app.post('/admin-kyc-imagem', async (req, res) => {
  try {
    if (!chaveAdminValida(req.body.key)) {
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
    if (!chaveAdminValida(req.body.key)) {
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
    imagem: p['Imagem URL'] || ''
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
function templateEmailEncomendaCliente(nomeLoja, encomenda, modo, cfg) {
  const ref = referenciaEncomenda(encomenda._id);
  const total = Number(encomenda['Valor Total'] || 0).toLocaleString('pt-PT') + ' MZN';
  const primeiro = escaparHtml(String(encomenda['Cliente Nome'] || '').split(' ')[0]);
  const paragrafos = [`Recebemos a tua encomenda <strong>${escaparHtml(ref)}</strong> em ${escaparHtml(nomeLoja)}, no valor de <strong>${escaparHtml(total)}</strong>.`];
  if (modo === 'manual') {
    const formas = [];
    if (cfg.mpesa) formas.push('M-Pesa: <strong>' + escaparHtml(cfg.mpesa) + '</strong>');
    if (cfg.emola) formas.push('e-Mola: <strong>' + escaparHtml(cfg.emola) + '</strong>');
    paragrafos.push('Para concluir, envia o pagamento para ' + formas.join(' ou ') + (cfg.titular ? ' (em nome de ' + escaparHtml(cfg.titular) + ')' : '') + ', com a referência <strong>' + escaparHtml(ref) + '</strong>.');
    paragrafos.push('A loja confirma o pagamento e prepara a tua encomenda.');
  } else {
    paragrafos.push('A loja vai contactar-te em breve para combinar o pagamento e a entrega.');
  }
  return templateEmailKyc('Encomenda ' + ref, `Olá, ${primeiro}.`, paragrafos,
    cfg.whatsapp ? { texto: 'Falar com a loja no WhatsApp', url: 'https://wa.me/' + cfg.whatsapp + '?text=' + encodeURIComponent('Olá! Sobre a encomenda ' + ref) } : null);
}

async function avisarEncomenda(site, encomendaId, modo, cfg) {
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
      await enviarEmail(encomenda['Cliente Email'], `Recebemos a tua encomenda - ${nomeLoja}`,
        templateEmailEncomendaCliente(nomeLoja, encomenda, modo, cfg));
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
        modo_efectivo: modo,
        kyc_estado: kyc ? (kyc['Estado'] || 'Pendente') : 'Nenhum'
      }
    });
  } catch (erro) {
    console.error('Erro em /loja-config-ler:', erro);
    return res.json({ status: 'error', message: 'Não foi possível carregar as definições da loja.' });
  }
});

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

const PAGINA_ADMIN_KYC = "<!DOCTYPE html>\n<html lang=\"pt\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<meta name=\"robots\" content=\"noindex, nofollow\">\n<title>KYC · Daniel IA</title>\n<link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2216%22%20fill%3D%22%23430960%22%2F%3E%3Cg%20transform%3D%22translate%2811.52%2011.52%29%20scale%280.16384%29%20translate%28-111%20-492.5%29%22%3E%3Cpath%20fill%3D%22%23FFFFFF%22%20d%3D%22M148.0%20738.1C142.7%20737.4%20139.2%20736.1%20135.6%20733.7C128.3%20728.8%20123.9%20721.8%20122.6%20713.1C122.1%20709.4%20122.1%20707.5%20122.7%20704.0C123.8%20697.6%20126.3%20692.6%20130.6%20688.3C133.2%20685.6%20136.0%20683.8%20141.9%20680.7C150.6%20676.1%20156.0%20672.8%20160.9%20669.2C172.2%20660.9%20180.7%20651.9%20187.8%20640.6C188.3%20639.9%20188.8%20639.4%20189.0%20639.4C189.4%20639.4%20189.5%20702.5%20189.0%20705.6C187.7%20714.1%20184.5%20720.7%20178.6%20726.7C172.9%20732.7%20168.0%20735.6%20160.8%20737.5C158.3%20738.2%20157.3%20738.3%20154.1%20738.4C151.7%20738.4%20149.5%20738.4%20148.0%20738.1ZM183.5%20737.9C183.5%20737.7%20184.1%20737.1%20184.9%20736.6C189.2%20733.9%20194.3%20728.3%20197.4%20723.0C202.1%20715.1%20203.7%20708.5%20203.7%20698.0C203.7%20694.3%20203.8%20692.7%20204.1%20692.4C204.3%20692.1%20206.1%20692.0%20222.0%20691.9C238.3%20691.8%20239.9%20691.8%20243.0%20691.3C254.0%20689.6%20263.9%20685.6%20273.4%20679.0C281.6%20673.4%20288.9%20665.8%20294.0%20657.5C298.3%20650.5%20301.7%20642.5%20303.3%20635.4C306.8%20619.6%20305.5%20604.6%20299.3%20589.3C296.5%20582.2%20293.0%20576.6%20286.9%20569.6C282.9%20564.8%20279.8%20562.0%20274.4%20558.1C264.1%20550.6%20251.7%20545.8%20240.8%20545.0C238.8%20544.8%20228.4%20544.8%20215.6%20544.8L193.8%20544.9L192.7%20545.6C191.4%20546.5%20190.1%20548.2%20189.7%20549.4C189.5%20550.1%20189.4%20555.5%20189.4%20571.2C189.4%20582.6%20189.3%20592.1%20189.2%20592.2C188.9%20592.4%20188.0%20591.4%20188.0%20590.9C188.0%20590.0%20185.1%20584.4%20182.5%20580.6C179.3%20575.7%20171.4%20568.0%20165.1%20563.7C161.4%20561.2%20152.2%20556.2%20143.4%20551.9C134.1%20547.4%20130.6%20544.8%20127.0%20540.0C124.6%20536.8%20123.4%20533.6%20122.6%20529.1C122.2%20526.2%20122.2%20523.9%20122.6%20520.6C123.1%20517.2%20123.8%20514.9%20125.2%20512.1C128.5%20505.5%20134.2%20500.8%20141.6%20498.7C146.7%20497.2%20146.0%20497.2%20196.5%20497.3C246.4%20497.4%20244.5%20497.4%20253.4%20498.8C268.8%20501.2%20287.7%20509.1%20301.3%20518.9C312.8%20527.0%20323.6%20538.1%20330.9%20549.1C335.2%20555.5%20337.8%20560.2%20340.5%20566.0C344.7%20575.1%20347.2%20582.3%20349.5%20592.4C351.4%20600.7%20352.0%20605.8%20352.2%20615.9C352.4%20628.3%20351.3%20638.6%20348.6%20648.9C345.6%20660.5%20339.4%20674.8%20333.6%20684.0C323.4%20700.1%20309.0%20713.7%20292.2%20723.3C282.4%20728.9%20271.5%20733.1%20261.5%20735.3C248.6%20738.2%20247.4%20738.2%20211.8%20738.2C186.7%20738.2%20183.5%20738.2%20183.5%20737.9Z%22%2F%3E%3Ccircle%20fill%3D%22%2389C804%22%20cx%3D%22149.1%22%20cy%3D%22612.7%22%20r%3D%2229.7%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Sora:wght@600;700;800&family=JetBrains+Mono:wght@500&display=swap\" rel=\"stylesheet\">\n<style>\n  :root{\n    --bg:#07030C;--card:#110A1B;--card-alt:#170E25;--border:#2A1B3D;--text:#F6F2FB;--text-dim:#A89BBA;\n    --lime:#89C804;--lime-bright:#B4F02B;--purple:#430960;--purple-bright:#A35BE0;--on-accent:#140620;\n    --error:#FF5C7A;--warning:#F5A623;\n    --grad-accent:linear-gradient(135deg,#C8F84A 0%,#89C804 100%);\n  }\n  *{box-sizing:border-box;}\n  body{margin:0;min-height:100vh;color:var(--text);font-family:\"Manrope\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;\n    background:radial-gradient(1100px 600px at 10% -14%, rgba(67,9,96,.9), rgba(67,9,96,0) 62%),\n      radial-gradient(800px 500px at 108% 6%, rgba(137,200,4,.10), rgba(137,200,4,0) 60%),#07030C;background-attachment:fixed;}\n  button,input,textarea{font-family:inherit;}\n  h1,h2,h3{font-family:\"Sora\",\"Manrope\",sans-serif;letter-spacing:-.025em;margin:0;}\n  .topo{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 28px;border-bottom:1px solid rgba(255,255,255,.08);\n    background:rgba(17,10,27,.6);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);position:sticky;top:0;z-index:10;}\n  .brand-logo{height:28px;width:auto;display:block;}\n  .brand-logo .bl-ink{fill:#FFFFFF;}\n  .brand-logo .bl-lime{fill:var(--lime);}\n  .etiqueta{font-family:\"JetBrains Mono\",monospace;font-size:12px;color:var(--lime);letter-spacing:.14em;}\n  .main{max-width:1100px;margin:0 auto;padding:32px 24px 80px;}\n  .caixa-chave{max-width:420px;margin:12vh auto 0;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:30px;}\n  .caixa-chave p{color:var(--text-dim);font-size:14px;line-height:1.6;margin:8px 0 20px;}\n  input[type=password],textarea{width:100%;background:var(--card-alt);border:1px solid var(--border);color:var(--text);border-radius:11px;padding:12px 14px;font-size:14px;outline:none;}\n  input:focus,textarea:focus{border-color:var(--lime);}\n  .btn{border:none;border-radius:11px;padding:11px 18px;font-size:13.5px;font-weight:700;cursor:pointer;transition:transform .15s,opacity .15s;}\n  .btn:disabled{opacity:.5;cursor:default;}\n  .btn-principal{background:var(--grad-accent);color:var(--on-accent);box-shadow:0 8px 24px rgba(137,200,4,.25);}\n  .btn-principal:hover:not(:disabled){transform:translateY(-1px);}\n  .btn-sec{background:transparent;color:var(--text);border:1px solid var(--border);}\n  .btn-sec:hover{border-color:var(--lime);}\n  .btn-perigo{background:rgba(255,92,122,.12);color:var(--error);border:1px solid rgba(255,92,122,.35);}\n  .erro{color:var(--error);font-size:13px;margin-top:12px;min-height:18px;}\n  .cabecalho{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px;}\n  .cabecalho p{color:var(--text-dim);margin:6px 0 0;font-size:14px;}\n  .tabs{display:flex;gap:6px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:4px;}\n  .tab{background:transparent;border:none;color:var(--text-dim);padding:8px 14px;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;}\n  .tab.activa{background:var(--card-alt);color:var(--text);box-shadow:inset 0 0 0 1px rgba(137,200,4,.35);}\n  .vazio{color:var(--text-dim);text-align:center;padding:60px 0;font-size:14px;}\n  .pedido{background:rgba(17,10,27,.7);border:1px solid var(--border);border-radius:18px;padding:22px;margin-bottom:16px;}\n  .pedido-topo{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;}\n  .pedido h3{font-size:18px;}\n  .dados{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:8px;font-size:13px;color:var(--text-dim);}\n  .dados b{color:var(--text);font-weight:600;font-family:\"JetBrains Mono\",monospace;font-size:12.5px;}\n  .pill{display:inline-block;font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:999px;border:1px solid var(--border);}\n  .pill.Pendente{color:var(--warning);border-color:rgba(245,166,35,.35);background:rgba(245,166,35,.1);}\n  .pill.Aprovado{color:var(--lime);border-color:rgba(137,200,4,.35);background:rgba(137,200,4,.1);}\n  .pill.Rejeitado{color:var(--error);border-color:rgba(255,92,122,.35);background:rgba(255,92,122,.1);}\n  .fotos{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px;}\n  .foto{background:var(--card-alt);border:1px solid var(--border);border-radius:12px;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;\n    overflow:hidden;position:relative;color:var(--text-dim);font-size:12.5px;}\n  .foto img{width:100%;height:100%;object-fit:contain;cursor:zoom-in;background:#000;}\n  .foto .rotulo{position:absolute;left:8px;top:8px;font-family:\"JetBrains Mono\",monospace;font-size:10.5px;letter-spacing:.08em;\n    background:rgba(7,3,12,.75);color:var(--lime);padding:3px 7px;border-radius:6px;}\n  .accoes{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px;align-items:center;}\n  .rejeitar-caixa{display:none;margin-top:14px;}\n  .rejeitar-caixa.aberta{display:block;}\n  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;}\n  .chip{background:var(--card-alt);border:1px solid var(--border);color:var(--text-dim);border-radius:999px;padding:6px 11px;font-size:12px;cursor:pointer;}\n  .chip:hover{color:var(--text);border-color:var(--purple-bright);}\n  .motivo{color:var(--error);font-size:13px;margin-top:10px;}\n  .zoom{position:fixed;inset:0;background:rgba(7,3,12,.92);display:none;align-items:center;justify-content:center;z-index:100;cursor:zoom-out;padding:24px;}\n  .zoom.aberto{display:flex;}\n  .zoom img{max-width:100%;max-height:100%;border-radius:10px;}\n  @media (max-width:700px){.fotos{grid-template-columns:1fr;}.topo{padding:12px 16px;}}\n</style>\n</head>\n<body>\n<div class=\"topo\">\n  <svg class=\"brand-logo\" viewBox=\"112 489 1060 257\" role=\"img\" aria-label=\"Daniel IA\" xmlns=\"http://www.w3.org/2000/svg\"><path class=\"bl-ink\" d=\"M148.0 738.1C142.7 737.4 139.2 736.1 135.6 733.7C128.3 728.8 123.9 721.8 122.6 713.1C122.1 709.4 122.1 707.5 122.7 704.0C123.8 697.6 126.3 692.6 130.6 688.3C133.2 685.6 136.0 683.8 141.9 680.7C150.6 676.1 156.0 672.8 160.9 669.2C172.2 660.9 180.7 651.9 187.8 640.6C188.3 639.9 188.8 639.4 189.0 639.4C189.4 639.4 189.5 702.5 189.0 705.6C187.7 714.1 184.5 720.7 178.6 726.7C172.9 732.7 168.0 735.6 160.8 737.5C158.3 738.2 157.3 738.3 154.1 738.4C151.7 738.4 149.5 738.4 148.0 738.1ZM183.5 737.9C183.5 737.7 184.1 737.1 184.9 736.6C189.2 733.9 194.3 728.3 197.4 723.0C202.1 715.1 203.7 708.5 203.7 698.0C203.7 694.3 203.8 692.7 204.1 692.4C204.3 692.1 206.1 692.0 222.0 691.9C238.3 691.8 239.9 691.8 243.0 691.3C254.0 689.6 263.9 685.6 273.4 679.0C281.6 673.4 288.9 665.8 294.0 657.5C298.3 650.5 301.7 642.5 303.3 635.4C306.8 619.6 305.5 604.6 299.3 589.3C296.5 582.2 293.0 576.6 286.9 569.6C282.9 564.8 279.8 562.0 274.4 558.1C264.1 550.6 251.7 545.8 240.8 545.0C238.8 544.8 228.4 544.8 215.6 544.8L193.8 544.9L192.7 545.6C191.4 546.5 190.1 548.2 189.7 549.4C189.5 550.1 189.4 555.5 189.4 571.2C189.4 582.6 189.3 592.1 189.2 592.2C188.9 592.4 188.0 591.4 188.0 590.9C188.0 590.0 185.1 584.4 182.5 580.6C179.3 575.7 171.4 568.0 165.1 563.7C161.4 561.2 152.2 556.2 143.4 551.9C134.1 547.4 130.6 544.8 127.0 540.0C124.6 536.8 123.4 533.6 122.6 529.1C122.2 526.2 122.2 523.9 122.6 520.6C123.1 517.2 123.8 514.9 125.2 512.1C128.5 505.5 134.2 500.8 141.6 498.7C146.7 497.2 146.0 497.2 196.5 497.3C246.4 497.4 244.5 497.4 253.4 498.8C268.8 501.2 287.7 509.1 301.3 518.9C312.8 527.0 323.6 538.1 330.9 549.1C335.2 555.5 337.8 560.2 340.5 566.0C344.7 575.1 347.2 582.3 349.5 592.4C351.4 600.7 352.0 605.8 352.2 615.9C352.4 628.3 351.3 638.6 348.6 648.9C345.6 660.5 339.4 674.8 333.6 684.0C323.4 700.1 309.0 713.7 292.2 723.3C282.4 728.9 271.5 733.1 261.5 735.3C248.6 738.2 247.4 738.2 211.8 738.2C186.7 738.2 183.5 738.2 183.5 737.9Z\"/><circle class=\"bl-lime\" cx=\"149.1\" cy=\"612.7\" r=\"29.7\"/><path class=\"bl-ink\" d=\"M583.7 695.1C577.0 694.2 572.3 692.2 567.6 688.5C561.0 683.2 557.4 673.0 558.6 663.1C559.4 656.8 561.1 652.6 564.5 648.3C567.6 644.6 571.5 642.0 577.4 639.7C580.8 638.4 581.6 638.1 585.4 637.3C591.0 636.0 596.6 635.5 608.5 635.3C614.7 635.2 619.0 635.1 619.2 634.9C619.4 634.8 619.5 633.9 619.5 632.5C619.5 625.7 617.7 621.5 613.8 618.7C610.5 616.5 606.0 615.2 601.4 615.2C598.3 615.2 596.0 615.8 593.1 617.1C589.4 618.9 587.1 621.5 585.5 625.7C584.8 627.6 584.5 627.8 583.1 627.7C581.5 627.5 576.4 626.8 574.1 626.5C572.5 626.2 566.0 625.3 564.0 625.1C562.2 624.9 562.0 624.8 562.0 624.1C562.0 623.1 563.0 619.4 563.8 617.0C565.5 612.6 568.3 608.5 571.9 605.4C573.6 603.9 576.3 602.0 576.7 602.0C576.8 602.0 577.0 601.8 577.2 601.7C578.0 600.9 581.6 599.2 584.1 598.4C590.2 596.3 595.4 595.5 602.5 595.5C616.5 595.5 627.3 599.3 635.0 607.0C639.5 611.5 641.5 615.3 643.3 622.5L643.9 624.9L643.9 659.2L643.9 693.6L632.7 693.7C622.5 693.7 621.5 693.7 621.0 693.3C620.5 692.9 620.5 692.6 620.5 687.1C620.4 684.0 620.4 681.2 620.3 681.1C620.1 680.4 619.5 680.8 617.7 683.1C615.1 686.3 614.3 687.2 612.5 688.6C609.1 691.3 605.3 693.1 600.4 694.5C596.9 695.4 588.4 695.8 583.7 695.1ZM853.4 695.1C849.2 694.6 845.0 693.5 840.4 691.6C832.6 688.3 826.5 683.4 822.1 676.7C820.0 673.5 817.6 669.2 816.8 667.1C815.3 663.1 814.4 659.3 813.7 654.6C813.3 651.3 813.2 650.1 813.3 644.1C813.4 637.0 813.6 635.6 814.9 630.6C815.5 628.4 816.9 624.2 817.5 622.9C820.4 616.5 823.3 612.2 827.7 608.0C833.0 602.8 839.6 599.2 847.5 597.1C859.0 594.2 871.8 595.1 881.2 599.7C889.1 603.5 895.4 609.2 899.6 616.4C902.9 622.0 905.4 630.2 906.0 637.2C906.1 638.8 906.2 642.6 906.2 645.5C906.2 650.1 906.2 651.0 905.9 651.3C905.6 651.5 899.0 651.6 872.4 651.5C840.3 651.5 839.3 651.5 838.9 652.0C838.5 652.4 838.5 652.7 838.8 654.9C839.2 658.9 840.9 663.5 842.9 666.3C846.2 670.7 852.0 674.2 858.0 675.3C860.2 675.7 864.7 675.6 867.0 675.2C871.8 674.1 876.0 671.7 878.7 668.4C879.7 667.1 881.3 664.3 881.6 663.3C881.8 662.2 882.1 662.2 889.6 664.2C900.7 667.0 903.5 667.8 903.8 668.3C904.2 668.9 902.1 673.8 899.8 677.4C897.5 681.0 892.8 685.8 889.1 688.2C885.3 690.7 879.8 693.0 874.4 694.2C869.4 695.4 859.5 695.8 853.4 695.1ZM430.3 693.3C429.9 692.5 429.9 561.5 430.3 561.1C430.7 560.7 482.3 560.6 487.3 561.0C492.7 561.4 498.2 562.6 505.7 565.2C508.2 566.0 513.4 568.4 514.9 569.4C515.3 569.7 516.6 570.5 517.8 571.3C526.0 576.6 531.8 583.4 536.7 593.1C540.0 599.7 541.8 605.0 543.2 612.9C545.1 623.1 544.8 638.6 542.4 647.9C539.5 659.3 533.8 669.5 526.3 676.8C522.2 680.7 521.1 681.7 517.5 683.8C510.6 687.9 504.6 690.3 496.7 692.0C488.9 693.6 489.4 693.6 458.6 693.7C430.8 693.8 430.5 693.8 430.3 693.3ZM663.9 693.4C663.4 693.1 663.4 692.2 663.4 645.6C663.4 598.5 663.4 598.2 663.9 597.8C664.3 597.5 666.0 597.5 675.9 597.5C683.0 597.6 687.5 597.7 687.7 597.9C687.9 598.1 688.0 599.4 688.1 604.2C688.2 611.5 688.2 611.5 690.3 608.6C695.1 601.8 703.7 596.8 712.4 595.8C715.6 595.4 720.8 595.4 723.9 595.9C732.9 597.2 741.5 602.4 746.0 609.2C748.5 613.0 749.9 616.2 751.1 621.0C752.6 626.6 752.5 625.9 752.6 660.7C752.7 692.0 752.7 692.8 752.3 693.2C751.8 693.7 751.2 693.7 740.0 693.7C729.3 693.8 728.1 693.7 727.7 693.3C727.3 692.9 727.2 691.9 727.2 664.8C727.2 646.1 727.2 635.7 727.0 633.8C726.4 627.8 724.1 623.2 720.6 620.7C717.2 618.4 713.5 617.2 709.0 617.2C703.2 617.2 698.2 619.4 694.2 623.7C691.3 626.8 689.4 631.5 688.8 637.3C688.6 638.9 688.5 648.8 688.5 666.5C688.5 681.6 688.4 693.3 688.3 693.4C688.2 693.4 682.7 693.6 676.2 693.6C666.2 693.8 664.3 693.7 663.9 693.4ZM772.1 693.3C771.8 693.0 771.8 687.9 771.8 645.5C771.8 603.7 771.8 598.0 772.1 597.8C772.4 597.5 775.2 597.5 784.5 597.5C795.8 597.6 796.6 597.7 796.9 598.1C797.2 598.5 797.2 606.7 797.2 645.8C797.3 688.7 797.2 693.0 796.9 693.4C796.5 693.7 795.1 693.8 784.5 693.7C774.1 693.7 772.5 693.7 772.1 693.3ZM922.8 693.4C922.4 693.0 922.2 561.6 922.6 561.1C922.8 560.8 924.9 560.8 935.1 560.7C943.9 560.7 947.4 560.8 947.6 561.0C948.2 561.4 948.1 692.4 947.6 693.2L947.2 693.8L935.1 693.8C925.6 693.8 923.0 693.7 922.8 693.4ZM604.4 675.8C608.3 674.7 611.3 672.9 614.3 669.8C617.0 667.0 618.6 663.7 619.2 660.0C619.6 657.4 619.7 652.3 619.3 652.0C618.4 651.5 604.6 651.6 600.2 652.1C597.6 652.5 593.5 653.3 592.1 653.8C587.7 655.3 584.6 657.9 583.5 661.2C582.7 663.4 582.9 668.0 583.7 669.9C584.9 672.5 587.0 674.4 590.1 675.5C592.5 676.3 593.8 676.5 598.2 676.4C601.5 676.3 602.8 676.2 604.4 675.8ZM486.9 670.3C495.8 668.6 501.6 665.8 506.8 660.4C510.0 657.1 513.1 652.2 514.4 648.1C515.5 645.1 516.7 639.3 517.1 635.6C517.6 631.5 517.5 622.1 517.0 618.5C514.5 601.5 506.4 590.5 492.7 586.0C487.4 584.3 485.4 584.0 474.9 583.7C462.7 583.4 456.6 583.5 456.2 584.0C456.1 584.2 456.0 600.8 456.0 627.4C456.0 661.5 456.1 670.5 456.3 670.7C456.6 671.0 459.5 671.0 470.4 670.9C482.9 670.8 484.4 670.8 486.9 670.3ZM882.0 634.8C882.3 634.3 882.1 633.0 881.4 630.3C880.3 626.3 877.5 622.1 874.0 619.4C868.1 614.8 858.4 613.9 851.3 617.2C847.5 619.0 844.6 621.6 842.4 625.0C841.1 627.0 840.5 628.3 839.6 631.1C838.9 633.4 838.8 634.9 839.3 635.1C839.5 635.2 849.1 635.2 860.7 635.2C881.2 635.2 881.7 635.2 882.0 634.8ZM782.2 583.2C778.2 582.6 774.0 579.9 771.9 576.5C769.8 573.2 769.3 567.7 770.6 563.1C773.2 554.3 784.5 550.4 792.5 555.5C795.7 557.6 798.2 561.2 799.0 564.8C799.5 566.9 799.2 571.7 798.5 573.6C797.3 576.9 794.3 580.4 791.2 581.8C788.5 583.1 785.0 583.7 782.2 583.2Z\"/><path class=\"bl-lime\" d=\"M999.8 693.4C999.4 692.9 999.4 561.8 999.8 561.2C1000.1 560.8 1001.4 560.8 1012.7 560.7C1019.6 560.7 1025.3 560.8 1025.5 560.9C1025.7 561.0 1025.8 580.3 1025.8 626.8C1025.8 683.3 1025.7 692.7 1025.4 693.1C1025.1 693.6 1024.6 693.6 1012.6 693.7C1002.0 693.8 1000.0 693.7 999.8 693.4ZM1039.6 693.6C1039.4 693.5 1039.2 693.2 1039.2 693.0C1039.2 692.5 1041.1 686.8 1041.5 685.9C1041.6 685.6 1041.9 684.9 1042.1 684.2C1042.3 683.6 1043.0 681.7 1043.6 679.9C1045.8 673.7 1046.5 671.6 1047.5 668.8C1048.0 667.2 1048.9 664.6 1049.5 663.0C1050.1 661.4 1050.7 659.5 1051.0 658.8C1051.3 658.0 1051.9 656.1 1052.5 654.5C1053.5 651.9 1054.1 650.2 1056.5 643.2C1056.9 642.1 1058.0 638.9 1059.0 636.1C1061.4 629.1 1063.3 623.7 1065.6 617.1C1066.3 615.3 1067.1 612.9 1067.5 611.6C1067.9 610.4 1068.7 608.4 1069.1 607.2C1069.6 606.1 1070.3 603.9 1070.8 602.5C1071.3 601.1 1072.4 597.9 1073.2 595.5C1074.1 593.1 1075.2 590.0 1075.6 588.6C1076.1 587.2 1076.8 585.3 1077.2 584.4C1077.6 583.4 1078.2 581.6 1078.6 580.4C1079.5 577.4 1080.3 575.0 1081.1 572.9C1082.3 569.7 1082.8 568.4 1083.6 565.9C1084.6 562.9 1085.4 561.1 1085.7 560.9C1085.9 560.8 1093.2 560.7 1102.0 560.7C1116.7 560.7 1118.1 560.8 1118.5 561.2C1118.8 561.4 1119.0 561.7 1119.0 561.9C1119.0 562.1 1119.7 564.2 1120.5 566.7C1121.3 569.1 1122.1 571.5 1122.2 572.0C1122.4 572.8 1123.6 576.1 1125.3 580.8C1125.6 581.5 1126.2 583.4 1126.7 585.0C1127.3 586.6 1128.4 589.8 1129.2 592.1C1130.0 594.5 1131.2 597.8 1131.7 599.5C1132.3 601.2 1133.1 603.5 1133.5 604.5C1135.0 608.5 1138.0 617.1 1140.0 622.9C1141.1 626.2 1142.6 630.7 1143.4 632.9C1144.1 635.1 1145.8 639.9 1147.1 643.6C1148.4 647.3 1150.1 652.2 1150.9 654.4C1152.3 658.3 1154.8 665.7 1160.6 682.6C1162.2 687.3 1163.7 691.5 1163.9 692.1C1164.2 692.7 1164.2 693.1 1164.1 693.3C1163.9 693.6 1160.9 693.6 1150.4 693.7C1137.8 693.8 1137.1 693.8 1136.6 693.3C1136.2 693.0 1135.3 690.7 1133.4 684.9C1132.0 680.5 1130.2 675.2 1129.6 673.2C1128.9 671.3 1128.0 668.6 1127.6 667.4C1127.3 666.1 1126.8 664.7 1126.5 664.2L1126.1 663.4L1123.6 663.2C1122.2 663.1 1111.2 663.0 1099.1 663.0C1077.3 663.0 1077.0 663.0 1076.5 663.5C1076.2 663.8 1076.0 664.2 1076.0 664.4C1076.0 664.7 1073.0 673.9 1071.3 678.9C1070.4 681.4 1069.4 684.3 1068.9 685.8C1068.6 686.6 1068.0 688.4 1067.6 689.6C1066.7 692.7 1066.5 693.2 1066.2 693.4C1065.8 693.6 1040.1 693.8 1039.6 693.6ZM1119.4 641.6C1119.6 641.2 1118.2 636.6 1116.2 631.1C1115.4 628.6 1114.6 626.1 1112.0 618.1C1109.8 611.4 1108.3 606.4 1107.1 602.6C1106.5 600.4 1105.4 596.9 1104.7 594.9C1104.0 592.8 1103.2 590.2 1102.9 589.1C1102.5 587.6 1102.3 587.1 1101.9 587.0C1101.3 586.9 1101.0 587.4 1101.0 588.4C1101.0 588.8 1100.2 591.4 1099.2 594.3C1097.2 600.3 1092.6 613.9 1091.6 617.1C1090.7 620.0 1089.0 625.3 1086.9 631.5C1084.4 638.7 1083.6 641.5 1084.0 641.8C1084.2 641.9 1092.2 642.0 1101.8 642.0C1117.3 642.0 1119.3 642.0 1119.4 641.6Z\"/></svg>\n  <span class=\"etiqueta\">// PAINEL KYC</span>\n</div>\n\n<div class=\"main\">\n  <div class=\"caixa-chave\" id=\"vista-chave\">\n    <h2>Acesso restrito</h2>\n    <p>Escreve a chave de administração (a mesma ADMIN_SECRET das variáveis do container). Fica guardada só nesta aba.</p>\n    <input type=\"password\" id=\"chave\" placeholder=\"Chave de administração\" autocomplete=\"off\">\n    <div style=\"margin-top:14px;\"><button class=\"btn btn-principal\" id=\"btn-entrar\" style=\"width:100%;\">Entrar</button></div>\n    <div class=\"erro\" id=\"erro-chave\"></div>\n  </div>\n\n  <div id=\"vista-painel\" style=\"display:none;\">\n    <div class=\"cabecalho\">\n      <div>\n        <h1>Verificações de identidade</h1>\n        <p id=\"resumo\">A carregar...</p>\n      </div>\n      <div class=\"tabs\">\n        <button class=\"tab activa\" data-estado=\"Pendente\">Pendentes</button>\n        <button class=\"tab\" data-estado=\"Aprovado\">Aprovados</button>\n        <button class=\"tab\" data-estado=\"Rejeitado\">Rejeitados</button>\n      </div>\n    </div>\n    <div id=\"lista\"></div>\n    <div style=\"text-align:center;margin-top:24px;\"><button class=\"btn btn-sec\" id=\"btn-sair\">Sair do painel</button></div>\n  </div>\n</div>\n\n<div class=\"zoom\" id=\"zoom\"><img id=\"zoom-img\" alt=\"\"></div>\n\n<script>\n(function(){\n  'use strict';\n  var chave = '';\n  var estadoActual = 'Pendente';\n  try { chave = sessionStorage.getItem('dia_admin_kyc') || ''; } catch (e) {}\n\n  function post(caminho, dados){\n    dados.key = chave;\n    return fetch(caminho, {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify(dados)\n    }).then(function(r){ return r.json(); });\n  }\n\n  function esc(t){\n    return String(t == null ? '' : t).replace(/[&<>\"']/g, function(c){\n      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c];\n    });\n  }\n\n  function data(iso){\n    if (!iso) return '—';\n    var d = new Date(iso);\n    if (isNaN(d.getTime())) return '—';\n    return d.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });\n  }\n\n  var elChave = document.getElementById('chave');\n  var elErroChave = document.getElementById('erro-chave');\n  var elLista = document.getElementById('lista');\n  var elResumo = document.getElementById('resumo');\n\n  function entrar(){\n    chave = elChave.value.trim();\n    if (!chave) { elErroChave.textContent = 'Escreve a chave.'; return; }\n    carregar(true);\n  }\n  document.getElementById('btn-entrar').addEventListener('click', entrar);\n  elChave.addEventListener('keydown', function(e){ if (e.key === 'Enter') entrar(); });\n\n  document.getElementById('btn-sair').addEventListener('click', function(){\n    try { sessionStorage.removeItem('dia_admin_kyc'); } catch (e) {}\n    chave = '';\n    elChave.value = '';\n    document.getElementById('vista-painel').style.display = 'none';\n    document.getElementById('vista-chave').style.display = 'block';\n  });\n\n  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function(tab){\n    tab.addEventListener('click', function(){\n      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function(t){ t.classList.remove('activa'); });\n      tab.classList.add('activa');\n      estadoActual = tab.getAttribute('data-estado');\n      carregar(false);\n    });\n  });\n\n  function carregar(daChave){\n    elResumo.textContent = 'A carregar...';\n    elLista.innerHTML = '';\n    post('/admin-kyc-lista', { estado: estadoActual }).then(function(r){\n      if (r.status !== 'success') {\n        if (daChave || r.message === 'Chave inválida.') {\n          elErroChave.textContent = r.message || 'Não foi possível entrar.';\n          document.getElementById('vista-painel').style.display = 'none';\n          document.getElementById('vista-chave').style.display = 'block';\n          try { sessionStorage.removeItem('dia_admin_kyc'); } catch (e) {}\n        } else {\n          elResumo.textContent = r.message || 'Erro ao carregar.';\n        }\n        return;\n      }\n      try { sessionStorage.setItem('dia_admin_kyc', chave); } catch (e) {}\n      elErroChave.textContent = '';\n      document.getElementById('vista-chave').style.display = 'none';\n      document.getElementById('vista-painel').style.display = 'block';\n      var pedidos = r.response.pedidos || [];\n      var nomes = { Pendente: 'pendente', Aprovado: 'aprovado', Rejeitado: 'rejeitado' };\n      elResumo.textContent = pedidos.length + ' pedido' + (pedidos.length === 1 ? '' : 's') + ' ' + nomes[estadoActual] + (pedidos.length === 1 ? '' : 's') + '.';\n      if (!pedidos.length) {\n        elLista.innerHTML = '<div class=\"vazio\">Nada por aqui.</div>';\n        return;\n      }\n      pedidos.forEach(function(p){ elLista.appendChild(cartao(p)); });\n    }).catch(function(){\n      elErroChave.textContent = 'Não foi possível ligar ao servidor.';\n    });\n  }\n\n  var MOTIVOS = [\n    'A selfie está desfocada ou escura.',\n    'O B.I. está ilegível.',\n    'A selfie não corresponde à foto do B.I.',\n    'O B.I. está fora do prazo de validade.',\n    'Os dados escritos não batem certo com o B.I.'\n  ];\n\n  function cartao(p){\n    var el = document.createElement('div');\n    el.className = 'pedido';\n    var html = ''\n      + '<div class=\"pedido-topo\"><div>'\n      + '<h3>' + esc(p.nome) + '</h3>'\n      + '<div class=\"dados\">'\n      + '<span>B.I. <b>' + esc(p.numero_bi) + '</b></span>'\n      + '<span>Tel. <b>' + esc(p.telefone) + '</b></span>'\n      + '<span>Email <b>' + esc(p.email || '—') + '</b></span>'\n      + '<span>Enviado <b>' + esc(data(p.enviado)) + '</b></span>'\n      + (p.revisto ? '<span>Revisto <b>' + esc(data(p.revisto)) + '</b></span>' : '')\n      + '</div></div>'\n      + '<div><span class=\"pill ' + esc(p.estado) + '\">' + esc(p.estado) + '</span></div></div>'\n      + (p.motivo ? '<div class=\"motivo\">Motivo: ' + esc(p.motivo) + '</div>' : '')\n      + '<div class=\"fotos\">'\n      + '<div class=\"foto\" data-tipo=\"selfie\"><span class=\"rotulo\">SELFIE</span>A carregar...</div>'\n      + '<div class=\"foto\" data-tipo=\"frente\"><span class=\"rotulo\">B.I. FRENTE</span>A carregar...</div>'\n      + '<div class=\"foto\" data-tipo=\"verso\"><span class=\"rotulo\">B.I. VERSO</span>A carregar...</div>'\n      + '</div>';\n    if (p.estado === 'Pendente') {\n      html += '<div class=\"accoes\">'\n        + '<button class=\"btn btn-principal\" data-acao=\"aprovar\">Aprovar</button>'\n        + '<button class=\"btn btn-perigo\" data-acao=\"rejeitar\">Rejeitar</button>'\n        + '<span class=\"erro\" data-erro></span></div>'\n        + '<div class=\"rejeitar-caixa\"><div class=\"chips\">'\n        + MOTIVOS.map(function(m){ return '<button class=\"chip\" type=\"button\">' + esc(m) + '</button>'; }).join('')\n        + '</div><textarea rows=\"3\" placeholder=\"Motivo da rejeição (vai por email ao cliente)\"></textarea>'\n        + '<div class=\"accoes\"><button class=\"btn btn-perigo\" data-acao=\"confirmar-rejeicao\">Confirmar rejeição</button>'\n        + '<button class=\"btn btn-sec\" data-acao=\"cancelar\">Cancelar</button></div></div>';\n    }\n    el.innerHTML = html;\n\n    Array.prototype.forEach.call(el.querySelectorAll('.foto'), function(caixa){\n      var tipo = caixa.getAttribute('data-tipo');\n      post('/admin-kyc-imagem', { id: p.id, tipo: tipo }).then(function(r){\n        var rotulo = caixa.querySelector('.rotulo').outerHTML;\n        if (r.status !== 'success') { caixa.innerHTML = rotulo + esc(r.message || 'Erro'); return; }\n        caixa.innerHTML = rotulo + '<img alt=\"' + tipo + '\">';\n        var img = caixa.querySelector('img');\n        img.src = r.response.data;\n        img.addEventListener('click', function(){\n          document.getElementById('zoom-img').src = img.src;\n          document.getElementById('zoom').classList.add('aberto');\n        });\n      }).catch(function(){ caixa.lastChild.textContent = 'Erro de ligação'; });\n    });\n\n    if (p.estado === 'Pendente') {\n      var caixaRej = el.querySelector('.rejeitar-caixa');\n      var txt = caixaRej.querySelector('textarea');\n      var elErro = el.querySelector('[data-erro]');\n      Array.prototype.forEach.call(caixaRej.querySelectorAll('.chip'), function(chip){\n        chip.addEventListener('click', function(){ txt.value = chip.textContent; txt.focus(); });\n      });\n      el.querySelector('[data-acao=\"rejeitar\"]').addEventListener('click', function(){ caixaRej.classList.add('aberta'); txt.focus(); });\n      el.querySelector('[data-acao=\"cancelar\"]').addEventListener('click', function(){ caixaRej.classList.remove('aberta'); });\n\n      function decidir(decisao, motivo, botao){\n        botao.disabled = true;\n        elErro.textContent = '';\n        post('/admin-kyc-decidir', { id: p.id, decisao: decisao, motivo: motivo }).then(function(r){\n          if (r.status !== 'success') { botao.disabled = false; elErro.textContent = r.message || 'Erro.'; return; }\n          el.style.transition = 'opacity .3s';\n          el.style.opacity = '0';\n          setTimeout(function(){ carregar(false); }, 320);\n        }).catch(function(){ botao.disabled = false; elErro.textContent = 'Erro de ligação.'; });\n      }\n      el.querySelector('[data-acao=\"aprovar\"]').addEventListener('click', function(){\n        if (!window.confirm('Aprovar a verificação de ' + p.nome + '?')) return;\n        decidir('Aprovado', '', this);\n      });\n      el.querySelector('[data-acao=\"confirmar-rejeicao\"]').addEventListener('click', function(){\n        decidir('Rejeitado', txt.value.trim(), this);\n      });\n    }\n    return el;\n  }\n\n  document.getElementById('zoom').addEventListener('click', function(){ this.classList.remove('aberto'); });\n\n  if (chave) { elChave.value = chave; carregar(true); }\n})();\n</script>\n</body>\n</html>\n";

app.listen(PORT, () => {
  console.log(`daniel-ia-proxy v${VERSION} a correr na porta ${PORT}`);
});
