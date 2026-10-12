// ============================================================
//  Gescolar — container (versão 2)
//  As páginas vivem no GitHub e só falam com este container.
//  O Bubble guarda os dados (Data API) e verifica contas (workflows signup e login).
//
//  Rotas desta versão:
//    GET  /          estado e versão
//    POST /registo   cria a conta da Direcção + a Escola, devolve a sessão
//    POST /login     entra com email e palavra-passe, devolve a sessão
//    POST /sessao    diz quem é o dono da sessão, a escola e a página dele
//    Direcção (v3): /painel /turmas /turma-guardar /turma-apagar /disciplinas /disciplina-guardar
//                   /disciplina-apagar /disciplinas-modelo /professores /professor-guardar
//                   /professor-apagar /estudantes /matricular
//    Propinas e pagamentos (v4): /propinas-gerar /propinas /pagar /pagar-balcao /pagamento-estado /pagamentos
//                                GET|POST /wh-moz/<MOZ_WEBHOOK_KEY>  — webhook da MozPayment
//    SMS (v4.1): /sms-teste  — e recibo por SMS ao encarregado sempre que um pagamento fica pago
//    Facturas (v4.2): /escola-dados /escola-guardar (logótipo e dados da factura) /recibo (dados da factura-recibo em PDF)
//    Portal das famílias (v4.3): /acesso-codigo /acesso-entrar (entrada por código SMS, sem palavra-passe)
//                                /p/inicio /p/pagar /p/pagamento-estado  ·  /familias-link /familias-convite (Direcção)
//    Horários e comunicados (v4.4): /horarios /horario-guardar · /comunicados /comunicado-guardar /comunicado-apagar
//    Professores e notas (v4.5): entrada do professor por SMS · /prof/inicio /prof/pauta /prof/pauta-guardar
//                                Direcção: /pautas-turma /pauta /pauta-guardar /pautas-publicar · portal: notas em /p/inicio
//    Escolinha (v5.3): avaliação descritiva nas pautas · /prof/diario /prof/diario-guardar · autorizados a recolher
//    Saldo e levantamentos (v5.8): /saldo /levantar (B2C M-Pesa/e-Mola) /sacar-cartao · /pl/saques /pl/saque-estado
//    Inscrições online (v5.7): links públicos personalizados com pagamento · /links /link-guardar /inscricoes-online · /pub/link /pub/inscrever
//    Matrícula (v5.6): SMS de boas-vindas sempre (encarregado e/ou estudante) · no superior o estudante é o titular (sem encarregado)
//    Superior e Técnico (v5.5): pautas semestrais (frequência, exame, recorrência), créditos das cadeiras
//    Primário (v5.4): professor titular da turma (monodocência) · chamada do dia (Tempo 99) · Turma.Professor Titular (text)
//                      (/autorizados /autorizado-guardar /autorizado-apagar · /p/autorizado-guardar /p/autorizado-apagar)
//    Escola de condução 3 (v5.2): /exames /exame-marcar /exame-resultado · /prof/aula-estado · portal com aulas e exames
//    Escola de condução 2 (v5.1): /viaturas /viatura-guardar /viatura-apagar /aulas-praticas /aula-marcar /aula-estado
//    Escola de condução 1 (v5.0): /cursos /curso-guardar /curso-apagar /instruendos /inscrever /inscricao-estado
//    Convites aos professores (v4.10): SMS automático ao registar · /professor-convite /professores-convite
//    Palavra-passe e equipa (v4.9): /senha-pedir /senha-nova (código por SMS) · /equipa /equipa-criar /equipa-estado
//    Assinatura e plataforma (v4.8): /assinatura /assinatura-pagar /assinatura-estado · /pl/resumo /pl/escola /pl/escola-guardar
//                                    /pl/transferencia /pl/transferencia-apagar  (PLATAFORMA_EMAILS)
//    Painel (v4.7): /painel-indicadores — dinheiro, chamadas de hoje, faltas, notas por trimestre
//    Presenças (v4.6): /prof/chamada /prof/chamada-guardar · Direcção: /presencas /chamadas-dia /falta-justificar · portal: faltas
//
//  Variáveis de ambiente:
//    BUBBLE_BASE     https://<app>.bubbleapps.io/version-test/api/1.1/obj   (sem / no fim)
//    BUBBLE_TOKEN    token de admin da Data API
//    SESSION_SECRET  frase longa e aleatória que assina as sessões
//    ORIGENS         endereços das páginas, separados por vírgulas
//    MOZ_EMAIL, MOZ_SENHA, MOZ_WALLET, MOZ_WEBHOOK_KEY, MOZ_CARD_PATH (ver secção PAGAMENTOS)
//    SMS_TOKEN, SMS_ORIGEM (ver secção SMS)
// ============================================================
'use strict';
const express = require('express');
const crypto = require('crypto');

const VERSAO = 'gescolar-proxy 5.19.0';
const PORT = process.env.PORT || 8080;
const BUBBLE_BASE = (process.env.BUBBLE_BASE || '').replace(/\/+$/, '');
const BUBBLE_WF = BUBBLE_BASE.replace(/\/obj$/, '/wf');
const BUBBLE_TOKEN = process.env.BUBBLE_TOKEN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSAO_DIAS = 7;
const ORIGENS = (process.env.ORIGENS || 'https://gescolar.co.mz,https://www.gescolar.co.mz,https://djdesigncreator.github.io')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);

const NIVEIS = { ESC: 'Escolinha', PRI: 'Ensino Primario', SEC: 'Ensino Secundario', TEC: 'Tecnico Profissional', SUP: 'Ensino Superior', CON: 'Escola de Conducao' };
const CODIGO_NIVEL = Object.fromEntries(Object.entries(NIVEIS).map(([k, v]) => [v, k]));
const PAPEIS = { Direccao: 'direccao', Secretaria: 'direccao', Professor: 'professor', Estudante: 'estudante', Encarregado: 'encarregado', Plataforma: 'plataforma' };
const PROVINCIAS = ['Maputo Cidade', 'Maputo Província', 'Gaza', 'Inhambane', 'Sofala', 'Manica', 'Tete', 'Zambézia', 'Nampula', 'Cabo Delgado', 'Niassa'];
const PLANOS = ['Essencial', 'Pro', 'Rede'];
const TESTE_DIAS = Math.max(1, Math.min(90, Number(process.env.TESTE_DIAS || 7)));   // período de teste das escolas novas (por defeito 7 dias)

const app = express();
app.set('trust proxy', true);
// o envio de ficheiros no chat precisa de pedidos maiores; o resto fica com 1 MB
const jsonPequeno = express.json({ limit: '1mb' }), jsonGrande = express.json({ limit: '30mb' });
app.use((req, res, next) => (req.path === '/chat/enviar' ? jsonGrande : jsonPequeno)(req, res, next));

// ---------- CORS ----------
app.use((req, res, next) => {
  const o = (req.headers.origin || '').replace(/\/+$/, '');
  if (o && (ORIGENS.includes(o) || /^https:\/\/[a-z0-9-]+\.gescolar\.co\.mz$/.test(o))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Bubble ----------
async function pedido(url, method, body) {
  if (!BUBBLE_BASE || !BUBBLE_TOKEN) throw new Error('BUBBLE_BASE ou BUBBLE_TOKEN em falta no container');
  const r = await fetch(url, {
    method,
    headers: { 'Authorization': 'Bearer ' + BUBBLE_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = { raw: t }; }
  if (!r.ok) {
    const msg = (d && d.body && d.body.message) || (d && d.message) || t || ('HTTP ' + r.status);
    const err = new Error(method + ' ' + url.replace(BUBBLE_BASE, '').replace(BUBBLE_WF, '/wf') + ': ' + msg);
    err.status = r.status; err.bubble = msg; throw err;
  }
  return d;
}
const bubble = (method, path, body) => pedido(BUBBLE_BASE + path, method, body);
// nome da tabela como aparece no Bubble (o URL da Data API não tem espaços)
const NOME_TABELA = { chamada: 'Chamada', falta: 'Falta', pauta: 'Pauta', horario: 'Horario', propina: 'Propina', pagamento: 'Pagamento', comunicado: 'Comunicado',
  subscricao: 'Subscricao', transferencia: 'Transferencia', cursoconducao: 'Curso Conducao', inscricaoconducao: 'Inscricao Conducao', viatura: 'Viatura',
  aulapratica: 'Aula Pratica', exameconducao: 'Exame Conducao', linkinscricao: 'Link Inscricao', inscricaoonline: 'Inscricao Online', diarioentrada: 'Diario Entrada', autorizadorecolha: 'Autorizado Recolha', perguntacodigo: 'Pergunta Codigo', testecodigo: 'Teste Codigo', aulateorica: 'Aula Teorica', licaocodigo: 'Licao Codigo', chatturma: 'Chat Turma', mensagemchat: 'Mensagem Chat', planoaula: 'Plano Aula',
  turma: 'Turma', disciplina: 'Disciplina', professor: 'Professor', estudante: 'Estudante', encarregado: 'Encarregado', escola: 'Escola' };
const nomeTabela = t => NOME_TABELA[t] || t;
// erro do Bubble ao ler uma lista: quase sempre é a tabela que não existe (404) ou um campo que falta (400)
function erroTabela(tipo, e) {
  if (e && (e.status === 404 || e.status === 400)) {
    const x = new Error('No Bubble falta a tabela «' + nomeTabela(tipo) + '» ou um campo dela. Detalhe: ' + String(e.bubble || e.message).slice(0, 160));
    x.publico = 400; x.tabela = nomeTabela(tipo); return x;
  }
  return e;
}
const workflow = (nome, body) => pedido(BUBBLE_WF + '/' + nome, 'POST', body);
const obter = (tipo, id) => bubble('GET', '/' + tipo + '/' + encodeURIComponent(id)).then(d => d && d.response);
// ao gravar, o Bubble recusa com 400 quando falta um campo ou o tipo não bate certo: dizer qual
function erroGravar(tipo, e) {
  if (e && (e.status === 400 || e.status === 404)) {
    const x = new Error('O Bubble não aceitou gravar na tabela «' + nomeTabela(tipo) + '». Falta criar um campo ou o tipo dele está diferente. Detalhe: ' + String(e.bubble || e.message).slice(0, 200));
    x.publico = 400; x.tabela = nomeTabela(tipo); return x;
  }
  return e;
}
const criar = (tipo, campos) => bubble('POST', '/' + tipo, campos).then(d => d && d.id, e => { throw erroGravar(tipo, e); });
const mudar = (tipo, id, campos) => bubble('PATCH', '/' + tipo + '/' + encodeURIComponent(id), campos).catch(e => { throw erroGravar(tipo, e); });
const apagar = (tipo, id) => bubble('DELETE', '/' + tipo + '/' + encodeURIComponent(id));
async function procurar(tipo, filtros, limite) {
  const q = '?constraints=' + encodeURIComponent(JSON.stringify(filtros || [])) + '&limit=' + (limite || 100);
  let d; try { d = await bubble('GET', '/' + tipo + q); } catch (e) { throw erroTabela(tipo, e); }
  return (d && d.response && d.response.results) || [];
}

// ---------- sessões assinadas ----------
const b64 = s => Buffer.from(s).toString('base64url');
function assinar(dados, dias) {
  const corpo = b64(JSON.stringify(Object.assign({}, dados, { exp: Date.now() + (dias || SESSAO_DIAS) * 864e5 })));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(corpo).digest('base64url');
  return corpo + '.' + sig;
}
function verificar(token) {
  if (!token || !SESSION_SECRET) return null;
  const [corpo, sig] = String(token).split('.');
  if (!corpo || !sig) return null;
  const certo = crypto.createHmac('sha256', SESSION_SECRET).update(corpo).digest('base64url');
  if (sig.length !== certo.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(certo))) return null;
  let d; try { d = JSON.parse(Buffer.from(corpo, 'base64url').toString()); } catch (e) { return null; }
  if (!d || !d.u || !d.exp || d.exp < Date.now()) return null;
  return d;
}
function sessaoDo(req) {
  const h = req.headers.authorization || '';
  return verificar(h.startsWith('Bearer ') ? h.slice(7) : '');
}
// para as rotas seguintes (pautas, propinas…): exige sessão válida
function exigeSessao(req, res, next) {
  const s = sessaoDo(req);
  if (!s) return erro(res, 401, 'A sessão terminou. Entre outra vez.');
  req.sessao = s; next();
}

// ---------- travão contra tentativas repetidas ----------
const tentativas = new Map();
function travao(chave, max, minutos) {
  const agora = Date.now(), jan = minutos * 60e3;
  const lista = (tentativas.get(chave) || []).filter(t => agora - t < jan);
  lista.push(agora); tentativas.set(chave, lista);
  return lista.length > max;
}
setInterval(() => { const agora = Date.now(); for (const [k, v] of tentativas) if (!v.some(t => agora - t < 3600e3)) tentativas.delete(k); }, 600e3).unref();

// ---------- utilidades ----------
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
const soDigitos = v => String(v || '').replace(/\D/g, '');
const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
function slug(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}
function erro(res, status, mensagem) { return res.status(status).json({ ok: false, erro: mensagem }); }

async function resumoEscola(id) {
  if (!id) return null;
  const e = await obter('escola', id).catch(() => null);
  if (!e) return null;
  return {
    id: e._id, nome: e['Nome'], subdominio: e['Subdominio'], estado: e['Estado'], plano: e['Plano'],
    niveis: (e['Niveis'] || []).map(n => CODIGO_NIVEL[n] || n), ano: e['Ano Lectivo'], teste_ate: e['Teste Ate'] || null, valida_ate: e['Valida Ate'] || null,
    situacao: situacaoEscola(e),
    regras: { dia_limite: e['Dia Limite'], multa: e['Multa Percent'], multa_max: e['Multa Max'], aprovacao: e['Nota Aprovacao'], dispensa: e['Nota Dispensa'], formula: e['Formula Media'], admissao: e['Nota Admissao'], peso_exame: e['Peso Exame'] }
  };
}
const PLATAFORMA_EMAILS = (process.env.PLATAFORMA_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
async function abrirSessao(userId, pl) {
  const user = await obter('user', userId);
  if (!user) { const e = new Error('Conta não encontrada.'); e.publico = 404; throw e; }
  if (user['Activo'] === false) { const e = new Error('Esta conta está desactivada. Fale com a escola.'); e.publico = 403; throw e; }
  const papel = user['Papel'] || null;
  const escola = await resumoEscola(user['Escola']);
  if (escola && escola.estado === 'suspensa' && papel !== 'Plataforma' && !pl) { const e = new Error('O acesso desta escola está suspenso. A Direcção deve regularizar a subscrição.'); e.publico = 402; throw e; }
  mudar('user', userId, { 'Ultimo Acesso': new Date().toISOString() }).catch(() => {});
  const plataforma = !!pl || papel === 'Plataforma';
  const token = assinar(Object.assign({ u: userId, e: escola ? escola.id : null, p: papel }, plataforma ? { pl: 1 } : {}));
  return { ok: true, token, nome: user['Nome Completo'] || '', papel, pagina: (papel !== 'Plataforma' && escola) ? (PAPEIS[papel] || 'registo') : (plataforma ? 'plataforma' : (PAPEIS[papel] || 'registo')), escola, plataforma, expira_dias: SESSAO_DIAS };
}

// ============================================================
app.get('/', (req, res) => {
  res.json({ ok: true, versao: VERSAO, bubble: BUBBLE_BASE && BUBBLE_TOKEN ? 'configurado' : 'em falta', sessoes: SESSION_SECRET.length >= 32 ? 'configurado' : 'em falta', mozpayment: (process.env.MOZ_EMAIL && process.env.MOZ_SENHA && process.env.MOZ_WALLET) ? 'configurado' : 'em falta', webhook: process.env.MOZ_WEBHOOK_KEY ? 'configurado' : 'em falta', sms: (process.env.SMS_TOKEN && process.env.SMS_ORIGEM) ? 'configurado' : 'em falta', email: (RESEND_KEY && MAIL_FROM) ? 'resend' : 'bubble (workflow enviar-email)', ia: process.env.OPENAI_API_KEY ? 'configurado' : 'em falta', ficheiros: BUNNY_OK ? ('bunny' + (CDN_TOKEN_KEY ? ' com links que expiram' : ' SEM CDN_TOKEN_KEY')) : 'bubble', hora: new Date().toISOString() });
});

// ============================================================
//  POST /registo
//  { email, password, nome, nuit, provincia, cidade, telefone, email_escola,
//    subdominio, niveis:[...], plano, admin_nome, admin_tel }
// ============================================================
app.post('/registo', async (req, res) => {
  try {
    if (!SESSION_SECRET) return erro(res, 500, 'O servidor ainda não está configurado (SESSION_SECRET).');
    const b = req.body || {};
    const email = txt(b.email, 120).toLowerCase();
    const password = String(b.password || '');
    const nome = txt(b.nome, 120);
    const nuit = soDigitos(b.nuit);
    const provincia = txt(b.provincia, 40);
    const niveis = Array.isArray(b.niveis) ? [...new Set(b.niveis.map(x => String(x).toUpperCase()))].filter(k => NIVEIS[k]) : [];
    const plano = PLANOS.includes(b.plano) ? b.plano : 'Pro';
    const adminNome = txt(b.admin_nome, 120);

    if (travao('registo|' + req.ip, 8, 60)) return erro(res, 429, 'Muitas tentativas seguidas. Espere alguns minutos.');
    if (!emailOk(email)) return erro(res, 400, 'Escreva um email válido.');
    if (password.length < 8) return erro(res, 400, 'A palavra-passe precisa de pelo menos 8 caracteres.');
    if (nome.length < 4) return erro(res, 400, 'Escreva o nome da instituição.');
    if (nuit.length !== 9) return erro(res, 400, 'O NUIT tem 9 dígitos.');
    if (!PROVINCIAS.includes(provincia)) return erro(res, 400, 'Escolha a província.');
    if (!niveis.length) return erro(res, 400, 'Escolha pelo menos um tipo de ensino.');
    if (adminNome.split(/\s+/).length < 2) return erro(res, 400, 'Escreva o nome completo do administrador.');

    // NUIT repetido? (antes de criar a conta, para não deixar contas soltas)
    const mesmoNuit = await procurar('escola', [{ key: 'NUIT', constraint_type: 'equals', value: nuit }], 1);
    if (mesmoNuit.length) return erro(res, 409, 'Já existe uma instituição registada com este NUIT. Contacte o suporte Gescolar.');

    // 1. criar a conta no Bubble
    let userId;
    try {
      const r = await workflow('signup', { email, password });
      userId = r && r.response && r.response.user_id;
    } catch (e) {
      console.error('[registo/signup]', e.message);
      if (e.status === 400) return erro(res, 409, 'Este email já tem conta no Gescolar. Use "Entrar" ou outro email.');
      throw e;
    }
    if (!userId) throw new Error('signup não devolveu user_id — confirme o "Return data from API" no workflow signup');

    // 2. subdomínio livre
    let sub = slug(b.subdominio || nome) || 'escola';
    const iguais = await procurar('escola', [{ key: 'Subdominio', constraint_type: 'equals', value: sub }], 1);
    if (iguais.length) sub = (sub + '-' + crypto.randomBytes(2).toString('hex')).slice(0, 34);

    // 3. criar a Escola
    const hoje = new Date();
    const testeAte = new Date(hoje.getTime() + TESTE_DIAS * 864e5);
    const escolaId = await criar('escola', {
      'Nome': nome, 'NUIT': nuit, 'Provincia': provincia, 'Cidade': txt(b.cidade, 80),
      'Telefone': txt(b.telefone, 30), 'Email': txt(b.email_escola || email, 120), 'Subdominio': sub,
      'Niveis': niveis.map(k => NIVEIS[k]), 'Plano': plano, 'Estado': 'teste', 'Teste Ate': testeAte.toISOString(),
      'Ano Lectivo': String(hoje.getFullYear()), 'Dia Limite': 10, 'Multa Percent': 10, 'Multa Max': 25,
      'Nota Aprovacao': 10, 'Nota Dispensa': 14, 'Formula Media': 'MT = (2 x MACS + ACP) / 3'
    });

    // 4. ligar a conta à escola como Direcção
    await mudar('user', userId, { 'Escola': escolaId, 'Papel': 'Direccao', 'Nome Completo': adminNome, 'Telefone': txt(b.admin_tel, 30), 'Activo': true });

    const s = await abrirSessao(userId);
    s.subdominio = sub; s.teste_ate = testeAte.toISOString().slice(0, 10); s.acesso = linkFamilias(sub);
    // SMS de boas-vindas ao director com o código da escola e os links
    const telAdm = tel9(b.admin_tel), telEsc = tel9(b.telefone);
    const nums = [...new Set([telAdm, telEsc].filter(t => t.length === 9))];
    if (nums.length) {
      const base = PORTAL_URL.replace(/acesso\.html.*$/, '').replace(/^https?:\/\//, '');
      const r = await enviarSMS(nums, 'Gescolar: a escola ' + nome + ' foi criada. Codigo da escola: ' + sub + (SMS_LINKS ? '. Direccao entra em ' + base + 'entrar.html com ' + email + '. Familias, alunos e professores entram em ' + base + 'acesso.html?e=' + sub + ' com o telemovel.'
        : '. A Direccao entra no Gescolar com o email ' + email + '. Familias, alunos e professores entram com o codigo da escola e o numero de telemovel.')).catch(() => ({ ok: false }));
      s.sms = !!r.ok;
    }
    res.json(s);
  } catch (e) {
    console.error('[registo]', e.message);
    erro(res, e.publico || 500, e.publico ? e.message : 'Não foi possível criar a escola agora. Tente de novo dentro de um minuto.');
  }
});

// ============================================================
//  POST /login   { email, password }
// ============================================================
app.post('/login', async (req, res) => {
  try {
    if (!SESSION_SECRET) return erro(res, 500, 'O servidor ainda não está configurado (SESSION_SECRET).');
    const email = txt((req.body || {}).email, 120).toLowerCase();
    const password = String((req.body || {}).password || '');
    if (!emailOk(email) || !password) return erro(res, 400, 'Escreva o email e a palavra-passe.');
    if (travao('login|' + email, 8, 15) || travao('login-ip|' + req.ip, 30, 15)) return erro(res, 429, 'Muitas tentativas. Espere 15 minutos ou recupere a palavra-passe.');

    let userId;
    try {
      const r = await workflow('login', { email, password });
      userId = r && r.response && r.response.user_id;
    } catch (e) {
      if (e.status === 400 || e.status === 401) return erro(res, 401, 'Email ou palavra-passe incorrectos.');
      throw e;
    }
    if (!userId) throw new Error('login não devolveu user_id');
    res.json(await abrirSessao(userId, PLATAFORMA_EMAILS.includes(email)));
  } catch (e) {
    console.error('[login]', e.message);
    erro(res, e.publico || 500, e.publico ? e.message : 'Não foi possível entrar agora. Tente de novo.');
  }
});

// ============================================================
//  POST /sessao   (cabeçalho Authorization: Bearer <token>)
// ============================================================
app.post('/sessao', async (req, res) => {
  const s = sessaoDo(req);
  if (!s) return erro(res, 401, 'A sessão terminou. Entre outra vez.');
  try { res.json(s.t === 'portal' ? await abrirSessaoPortal(s) : await abrirSessao(s.u, s.pl === 1)); }
  catch (e) { console.error('[sessao]', e.message); erro(res, e.publico || 500, e.publico ? e.message : 'Não foi possível confirmar a sessão.'); }
});


// ============================================================
//  ÁREA DA DIRECÇÃO (versão 3)
//  Todas as rotas abaixo exigem sessão de Direcção ou Secretaria.
//  A escola vem SEMPRE da sessão, nunca do corpo do pedido.
// ============================================================
function exigeDireccao(req, res, next) {
  const s = sessaoDo(req);
  if (!s) return erro(res, 401, 'A sessão terminou. Entre outra vez.');
  if (!s.e) return erro(res, 403, 'Esta conta ainda não tem escola.');
  if (s.p !== 'Direccao' && s.p !== 'Secretaria') return erro(res, 403, 'Só a Direcção e a Secretaria podem fazer isto.');
  req.sessao = s; req.escola = s.e; next();
}
const daEscola = (id) => [{ key: 'Escola', constraint_type: 'equals', value: id }];

async function procurarTodos(tipo, filtros, max) {
  const out = []; let cursor = 0; max = max || 2000;
  while (out.length < max) {
    const q = '?constraints=' + encodeURIComponent(JSON.stringify(filtros || [])) + '&limit=100&cursor=' + cursor;
    let d; try { d = await bubble('GET', '/' + tipo + q); } catch (e) { throw erroTabela(tipo, e); }
    const r = (d && d.response) || {};
    const lista = r.results || [];
    out.push(...lista);
    if (!r.remaining || !lista.length) break;
    cursor += lista.length;
  }
  return out;
}
async function daMinhaEscola(tipo, id, escola) {
  const x = await obter(tipo, id).catch(() => null);
  if (!x || x['Escola'] !== escola) { const e = new Error('Registo não encontrado.'); e.publico = 404; throw e; }
  return x;
}
function rota(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error('[' + req.path + ']', e.message); erro(res, e.publico || 500, e.publico ? e.message : 'Não foi possível concluir. Tente de novo.'); }
  };
}
const num = (v, def) => { const n = Number(v); return isFinite(n) ? n : def; };

// ---------- currículo modelo (a escola ajusta depois) ----------
const CURRICULO = {
  ESC: [['Linguagem e comunicação', 'LNG', '#0A64DC', 6], ['Matemática lúdica', 'MLU', '#C2410C', 5], ['Expressão plástica', 'EXP', '#9B3FB5', 5], ['Música e movimento', 'MUS', '#7B4DD6', 5], ['Conhecimento do mundo', 'NAT', '#168A52', 5], ['Brincadeira livre', 'BRI', '#8A6D00', 4]],
  PRI: [['Português', 'POR', '#0A64DC', 7], ['Matemática', 'MAT', '#C2410C', 7], ['Ciências Naturais', 'CN', '#168A52', 4], ['Ciências Sociais', 'CS', '#8A6D00', 4], ['Inglês', 'ING', '#7B4DD6', 2], ['Educação Visual', 'EV', '#9B3FB5', 2], ['Educação Física', 'EF', '#3E7D1E', 2], ['Ofícios', 'OF', '#6B4E2E', 2]],
  SEC: [['Português', 'POR', '#0A64DC', 5], ['Matemática', 'MAT', '#C2410C', 5], ['Inglês', 'ING', '#7B4DD6', 3], ['Física', 'FIS', '#0E7C86', 3], ['Química', 'QUI', '#B4235A', 3], ['Biologia', 'BIO', '#168A52', 3], ['Geografia', 'GEO', '#8A6D00', 2], ['História', 'HIS', '#6B4E2E', 2], ['Educação Física', 'E.FÍS', '#3E7D1E', 2], ['Educação Visual', 'E.VIS', '#9B3FB5', 1], ['TIC', 'TIC', '#0B2A4A', 1], ['Filosofia', 'FIL', '#5A4FCF', 2], ['Francês', 'FRA', '#0E5FA8', 2]]
};

// ---------- painel: contadores e estado do arranque ----------
app.post('/painel', exigeDireccao, rota(async (req, res) => {
  const f = daEscola(req.escola);
  const [escola, turmas, disciplinas, professores, estudantes] = await Promise.all([
    resumoEscola(req.escola), procurarTodos('turma', f), procurarTodos('disciplina', f), procurarTodos('professor', f), procurarTodos('estudante', f)
  ]);
  const act = l => l.filter(x => x['Activa'] !== false && x['Activo'] !== false);
  const t = act(turmas), d = act(disciplinas), p = act(professores), todos = estudantes.filter(x => (x['Estado'] || 'activo') === 'activo');
  const e = todos.filter(x => !String(x['Numero'] || '').startsWith('C'));
  let cursos = 0, instruendos = 0;
  if (escola && (escola.niveis || []).includes('CON')) {
    const [cs, ins] = await Promise.all([procurarTodos('cursoconducao', f), procurarTodos('inscricaoconducao', f)]);
    cursos = cs.filter(c => c['Activo'] !== false).length; instruendos = ins.filter(i => (i['Estado'] || 'activa') === 'activa').length;
  }
  res.json({ ok: true, escola, contagem: { turmas: t.length, disciplinas: d.length, professores: p.length, estudantes: e.length, cursos, instruendos },
    arranque: [
      { id: 'turmas', feito: t.length > 0, n: t.length },
      { id: 'disciplinas', feito: d.length > 0, n: d.length },
      { id: 'professores', feito: p.length > 0, n: p.length },
      { id: 'estudantes', feito: e.length > 0, n: e.length }
    ] });
}));

// ---------- turmas ----------
function turmaOut(t, estudantes) {
  return { id: t._id, nome: t['Nome'], codigo: t['Codigo'] || '', nivel: CODIGO_NIVEL[t['Nivel']] || t['Nivel'] || '', classe: t['Classe'] || '', turno: t['Turno'] || '',
    sala: t['Sala'] || '', capacidade: t['Capacidade'] || 0, propina: t['Propina Mensal'] || 0, director: t['Director Turma'] || null, titular: t['Professor Titular'] || null, disciplinas: t['Disciplinas'] || [],
    estudantes: estudantes ? estudantes.filter(e => e['Turma'] === t._id && (e['Estado'] || 'activo') === 'activo').length : undefined };
}
app.post('/turmas', exigeDireccao, rota(async (req, res) => {
  const f = daEscola(req.escola);
  const [turmas, estudantes] = await Promise.all([procurarTodos('turma', f), procurarTodos('estudante', f)]);
  res.json({ ok: true, turmas: turmas.filter(t => t['Activa'] !== false).map(t => turmaOut(t, estudantes)).sort((a, b) => a.nome.localeCompare(b.nome, 'pt')) });
}));
app.post('/turma-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const nome = txt(b.nome, 80), nivel = String(b.nivel || '').toUpperCase();
  if (nome.length < 2) return erro(res, 400, 'Escreva o nome da turma, por exemplo "10ª Classe A".');
  if (!NIVEIS[nivel]) return erro(res, 400, 'Escolha o nível de ensino da turma.');
  const escola = await resumoEscola(req.escola);
  if (escola && escola.niveis.length && !escola.niveis.includes(nivel)) return erro(res, 400, 'Esta escola não tem o nível escolhido. Acrescente-o nas Definições.');
  let discs = Array.isArray(b.disciplinas) ? b.disciplinas.map(String) : null;
  if (!discs) { // por defeito: todas as disciplinas activas do mesmo nível
    const todas = await procurarTodos('disciplina', daEscola(req.escola));
    discs = todas.filter(d => d['Nivel'] === NIVEIS[nivel] && d['Activa'] !== false).map(d => d._id);
  }
  const campos = { 'Escola': req.escola, 'Nome': nome, 'Codigo': txt(b.codigo, 20) || slug(nome).toUpperCase().replace(/-/g, '').slice(0, 8), 'Nivel': NIVEIS[nivel],
    'Classe': txt(b.classe, 40), 'Turno': txt(b.turno, 20) || 'Manhã', 'Sala': txt(b.sala, 40), 'Capacidade': num(b.capacidade, 40), 'Propina Mensal': num(b.propina, 0),
    'Ano Lectivo': (escola && escola.ano) || String(new Date().getFullYear()), 'Disciplinas': discs, 'Activa': true };
  if (b.director) campos['Director Turma'] = String(b.director);
  if (b.titular !== undefined) {
    const tit = String(b.titular || '');
    if (tit) { const p = await daMinhaEscola('professor', tit, req.escola).catch(() => null); if (!p) return erro(res, 400, 'O professor titular escolhido não é desta escola.'); }
    if (tit || b.id) campos['Professor Titular'] = tit;
  }
  let id = b.id ? String(b.id) : null;
  if (id) { await daMinhaEscola('turma', id, req.escola); await mudar('turma', id, campos); }
  else id = await criar('turma', campos);
  res.json({ ok: true, id });
}));
app.post('/turma-apagar', exigeDireccao, rota(async (req, res) => {
  const id = String((req.body || {}).id || '');
  await daMinhaEscola('turma', id, req.escola);
  const est = await procurarTodos('estudante', [{ key: 'Turma', constraint_type: 'equals', value: id }], 1);
  if (est.length) return erro(res, 409, 'A turma tem estudantes. Transfira-os antes de a apagar.');
  await mudar('turma', id, { 'Activa': false });
  res.json({ ok: true });
}));

// ---------- disciplinas ----------
const discOut = d => ({ id: d._id, nome: d['Nome'], sigla: d['Sigla'] || '', cor: d['Cor'] || '#0A64DC', nivel: CODIGO_NIVEL[d['Nivel']] || d['Nivel'] || '', carga: d['Carga Semanal'] || 0, creditos: d['Creditos'] || 0, descritiva: !!d['Avaliacao Descritiva'] });
app.post('/disciplinas', exigeDireccao, rota(async (req, res) => {
  const l = await procurarTodos('disciplina', daEscola(req.escola));
  res.json({ ok: true, disciplinas: l.filter(d => d['Activa'] !== false).map(discOut).sort((a, b) => (a.nivel + a.nome).localeCompare(b.nivel + b.nome, 'pt')) });
}));
app.post('/disciplina-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, nivel = String(b.nivel || '').toUpperCase(), nome = txt(b.nome, 60);
  if (nome.length < 2) return erro(res, 400, 'Escreva o nome da disciplina.');
  if (!NIVEIS[nivel]) return erro(res, 400, 'Escolha o nível.');
  const campos = { 'Escola': req.escola, 'Nome': nome, 'Sigla': txt(b.sigla, 8).toUpperCase() || nome.slice(0, 3).toUpperCase(), 'Cor': /^#[0-9a-f]{6}$/i.test(b.cor || '') ? b.cor : '#0A64DC',
    'Nivel': NIVEIS[nivel], 'Carga Semanal': num(b.carga, 2), 'Creditos': num(b.creditos, 0), 'Avaliacao Descritiva': nivel === 'ESC' ? true : !!b.descritiva, 'Activa': true };
  let id = b.id ? String(b.id) : null;
  if (id) { await daMinhaEscola('disciplina', id, req.escola); await mudar('disciplina', id, campos); }
  else id = await criar('disciplina', campos);
  res.json({ ok: true, id });
}));
app.post('/disciplina-apagar', exigeDireccao, rota(async (req, res) => {
  const id = String((req.body || {}).id || '');
  await daMinhaEscola('disciplina', id, req.escola);
  await mudar('disciplina', id, { 'Activa': false });
  res.json({ ok: true });
}));
// carrega o currículo modelo de um nível (não repete as que já existem)
app.post('/disciplinas-modelo', exigeDireccao, rota(async (req, res) => {
  const nivel = String((req.body || {}).nivel || '').toUpperCase();
  if (!CURRICULO[nivel]) return erro(res, 400, 'Não há modelo para este nível. Crie as disciplinas uma a uma.');
  const existentes = (await procurarTodos('disciplina', daEscola(req.escola))).filter(d => d['Nivel'] === NIVEIS[nivel] && d['Activa'] !== false).map(d => String(d['Nome']).toLowerCase());
  let criadas = 0;
  for (const [nome, sigla, cor, carga] of CURRICULO[nivel]) {
    if (existentes.includes(nome.toLowerCase())) continue;
    await criar('disciplina', { 'Escola': req.escola, 'Nome': nome, 'Sigla': sigla, 'Cor': cor, 'Nivel': NIVEIS[nivel], 'Carga Semanal': carga, 'Avaliacao Descritiva': nivel === 'ESC', 'Activa': true });
    criadas++;
  }
  res.json({ ok: true, criadas });
}));

// ---------- professores ----------
const profOut = p => ({ id: p._id, nome: p['Nome'], telefone: p['Telefone'] || '', email: p['Email'] || '', disciplinas: p['Disciplinas'] || [], monodocencia: !!p['Monodocencia'], desde: p['Desde'] || null, conta: !!p['Conta'], licenca: p['Licenca Instrutor'] || '' });
app.post('/professores', exigeDireccao, rota(async (req, res) => {
  const l = await procurarTodos('professor', daEscola(req.escola));
  res.json({ ok: true, professores: l.filter(p => p['Activo'] !== false).map(profOut).sort((a, b) => a.nome.localeCompare(b.nome, 'pt')) });
}));
app.post('/professor-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, nome = txt(b.nome, 100);
  if (nome.split(/\s+/).length < 2) return erro(res, 400, 'Escreva o nome e o apelido do professor.');
  const email = txt(b.email, 120).toLowerCase();
  if (email && !emailOk(email)) return erro(res, 400, 'O email do professor não é válido.');
  const campos = { 'Escola': req.escola, 'Nome': nome, 'Telefone': txt(b.telefone, 30), 'Email': email, 'Disciplinas': Array.isArray(b.disciplinas) ? b.disciplinas.map(String) : [],
    'Monodocencia': !!b.monodocencia, 'Desde': num(b.desde, new Date().getFullYear()), 'Activo': true };
  if (b.licenca) campos['Licenca Instrutor'] = txt(b.licenca, 30);
  let id = b.id ? String(b.id) : null, novo = !id;
  if (id) { await daMinhaEscola('professor', id, req.escola); await mudar('professor', id, campos); }
  else id = await criar('professor', campos);
  let c = false;
  if (novo && b.convidar !== false) c = await convidarProfessor(req.escola, Object.assign({ _id: id }, campos)).catch(() => false);
  res.json({ ok: true, id, sms: !!(c && c.sms), email: !!(c && c.email) });
}));
app.post('/professor-apagar', exigeDireccao, rota(async (req, res) => {
  const id = String((req.body || {}).id || '');
  await daMinhaEscola('professor', id, req.escola);
  await mudar('professor', id, { 'Activo': false });
  res.json({ ok: true });
}));

// ---------- estudantes e encarregados ----------
const estOut = (e, encs) => { const en = encs && encs.find(x => x._id === e['Encarregado']); return { id: e._id, numero: e['Numero'], nome: e['Nome'], sexo: e['Sexo'] || '', nascimento: e['Data Nascimento'] || null, turma: e['Turma'] || null, estado: e['Estado'] || 'activo', encarregado: en ? { id: en._id, nome: en['Nome'], telefone: en['Telefone'] || '', parentesco: en['Parentesco'] || '' } : null }; };
app.post('/estudantes', exigeDireccao, rota(async (req, res) => {
  const f = daEscola(req.escola), turma = (req.body || {}).turma;
  const filtros = turma ? f.concat([{ key: 'Turma', constraint_type: 'equals', value: String(turma) }]) : f;
  const [est, encs] = await Promise.all([procurarTodos('estudante', filtros), procurarTodos('encarregado', f)]);
  res.json({ ok: true, estudantes: est.filter(e => (e['Estado'] || 'activo') !== 'apagado').map(e => estOut(e, encs)).sort((a, b) => a.nome.localeCompare(b.nome, 'pt')) });
}));
// matrícula partilhada: Direcção (/matricular) e inscrições online aprovadas
function pub(msg) { const e = new Error(msg); e.publico = 400; return e; }
// encarregado de educação: reutiliza pelo telefone, senão cria. obrigatorio=false → só se o nome ou o telefone vierem preenchidos
async function encarregadoDe(escolaId, b, obrigatorio) {
  const nomeEnc = txt(b.enc_nome, 100), telEnc = tel9(b.enc_telefone);
  if (!nomeEnc && !telEnc) {
    if (obrigatorio) throw pub('Escreva o nome e o telemóvel do encarregado de educação: neste nível de ensino é obrigatório.');
    return { encId: null, encTel: '' };
  }
  if (!telEnc) throw pub('Escreveu o nome do encarregado mas falta o telemóvel dele (ex.: 84 123 4567).' + (obrigatorio ? '' : ' Ou apague o nome para continuar sem encarregado.'));
  if (telEnc.length !== 9 || !/^8[2-7]/.test(telEnc)) throw pub('O telemóvel do encarregado deve ter 9 dígitos e começar por 82 a 87 (ex.: 84 123 4567). Escreveu ' + telEnc.length + ' dígito(s).');
  const encs = await procurarTodos('encarregado', daEscola(escolaId));
  const ja = encs.find(e => tel9(e['Telefone']) === telEnc);
  if (ja) return { encId: ja._id, encTel: ja['Recebe SMS'] === false ? '' : telEnc };
  if (nomeEnc.split(/\s+/).length < 2) throw pub('Escreva o nome completo do encarregado.');
  const encId = await criar('encarregado', { 'Escola': escolaId, 'Nome': nomeEnc, 'Telefone': telEnc.replace(/(\d{2})(\d{3})(\d{4})/, '$1 $2 $3'), 'Email': txt(b.enc_email, 120).toLowerCase(), 'Parentesco': txt(b.enc_parentesco, 30), 'Recebe SMS': true, 'Activo': true });
  return { encId, encTel: telEnc };
}
async function matricularCore(escolaId, b) {
  const nome = txt(b.nome, 100);
  if (nome.split(/\s+/).length < 2) throw pub('Escreva o nome e o apelido do estudante.');
  const turmaId = String(b.turma || '');
  const turma = await daMinhaEscola('turma', turmaId, escolaId);
  const escola = await resumoEscola(escolaId);
  // no ensino superior o estudante é adulto: o telemóvel dele é obrigatório e o encarregado é opcional
  const superior = turma['Nivel'] === NIVEIS.SUP || turma['Nivel'] === 'SUP';
  if (superior && tel9(b.telefone).length !== 9) throw pub('No ensino superior o telemóvel do estudante é obrigatório: é por ele que recebe o acesso e entra no portal.');
  // encarregado: reutiliza pelo telefone, senão cria
  // v5.12: encarregado obrigatório em todos os níveis, excepto no ensino superior (opcional)
  const { encId, encTel } = await encarregadoDe(escolaId, b, !superior);
  // número de estudante: ano-sequência
  const todos = await procurarTodos('estudante', daEscola(escolaId));
  const ano = (escola && escola.ano) || String(new Date().getFullYear());
  const maior = todos.map(e => String(e['Numero'] || '')).filter(n => n.startsWith(ano + '-')).map(n => parseInt(n.split('-')[1], 10) || 0).reduce((a, c) => Math.max(a, c), 0);
  const numero = ano + '-' + String(maior + 1).padStart(4, '0');
  const campos = { 'Escola': escolaId, 'Numero': numero, 'Nome': nome, 'Sexo': b.sexo === 'F' ? 'F' : (b.sexo === 'M' ? 'M' : ''), 'Turma': turma._id, 'Ano Lectivo': ano,
    'Data Matricula': new Date().toISOString(), 'Estado': 'activo', 'Saude Notas': txt(b.saude, 300) };
  if (b.nascimento && !isNaN(Date.parse(b.nascimento))) campos['Data Nascimento'] = new Date(b.nascimento).toISOString();
  if (encId) campos['Encarregado'] = encId;
  const telEst = tel9(b.telefone);
  if (telEst) {
    if (telEst.length !== 9 || !/^8[2-7]/.test(telEst)) throw pub('O telemóvel do estudante deve ter 9 dígitos e começar por 82 a 87 (ex.: 84 123 4567). Escreveu ' + telEst.length + ' dígito(s).');
    campos['Telefone'] = telEst.replace(/(\d{2})(\d{3})(\d{4})/, '$1 $2 $3');
  }
  const id = await criar('estudante', campos);
  // SMS de boas-vindas com o número e o link de acesso (sem palavra-passe: entra com o telemóvel e recebe um código)
  let sms = 0;
  const esc = await obter('escola', escolaId).catch(() => null);
  if (esc) {
    const link = noGescolar(esc['Subdominio']), en = esc['Nome'] || 'A escola', tn = turma['Nome'] || '';
    if (telEst) {
      const r = await enviarSMS([telEst], en + ': ' + (superior ? 'bem-vindo(a), ' + nome.split(/\s+/)[0] + '. Esta inscrito(a) em ' : nome + ' esta matriculado(a) na ') + tn + ' com o numero ' + numero +
        '. Veja notas, horario e propinas ' + link + ' (escolha Estudante e escreva ' + numero + ').').catch(() => ({ ok: false }));
      if (r.ok) sms++;
    }
    if (encTel && encTel !== telEst) {
      const r = await enviarSMS([encTel], en + ': ' + nome + ' foi matriculado(a) na ' + tn + ' com o numero ' + numero +
        '. Veja propinas, recibos e notas e pague por M-Pesa ou e-Mola ' + link + ' (escolha Encarregado e use este numero de telemovel).').catch(() => ({ ok: false }));
      if (r.ok) sms++;
    }
  }
  cachePainel.delete(escolaId);
  return { id, numero, sms };
}
app.post('/matricular', exigeDireccao, rota(async (req, res) => {
  const r = await matricularCore(req.escola, req.body || {});
  res.json(Object.assign({ ok: true }, r));
}));


// ============================================================
//  PAGAMENTOS (versão 4)
//  MozPayment: login → token; M-Pesa / e-Mola (push para o telemóvel); cartão (link de checkout)
//  Carteira única do Gescolar (MOZ_WALLET). O Gescolar separa internamente o que é de cada escola.
//
//  Variáveis:
//    MOZ_EMAIL, MOZ_SENHA      conta MozPayment (nunca no código)
//    MOZ_WALLET                carteira que recebe tudo
//    MOZ_BASE                  https://mozpayment.co.mz/api/1.1/wf   (por defeito)
//    MOZ_CARD_PATH             caminho do cartão: payment (por defeito) ou bankpayment
//    MOZ_WEBHOOK_KEY           chave que faz parte do URL do webhook
// ============================================================
const MOZ_BASE = (process.env.MOZ_BASE || 'https://mozpayment.co.mz/api/1.1/wf').replace(/\/+$/, '');
const MOZ_EMAIL = process.env.MOZ_EMAIL || '';
const MOZ_SENHA = process.env.MOZ_SENHA || '';
const MOZ_WALLET = process.env.MOZ_WALLET || '';
const MOZ_CARD_PATH = (process.env.MOZ_CARD_PATH || 'payment').replace(/^\/+/, '');
const MOZ_WEBHOOK_KEY = process.env.MOZ_WEBHOOK_KEY || '';
const MOZ_MIN = 10;   // a MozPayment não aceita pagamentos abaixo de 10 MT
const MOZ_NUM_258 = /^(1|sim|true|258)$/i.test(String(process.env.MOZ_NUMERO_258 || '').trim());   // 1 = enviar 25884xxxxxxx; vazio = 84xxxxxxx
const numMoz = n9 => (MOZ_NUM_258 ? '258' : '') + n9;
// corpo do pedido C2B (M-Pesa/e-Mola): exactamente estes 5 campos
const corpoC2B = (metodo, valor, n9, nome) => ({ wallet: MOZ_WALLET, payment_method: metodo, amount: String(valor), number: numMoz(n9), name: String(nome || '').slice(0, 80) });

// procura um campo em qualquer nível da resposta (a MozPayment nem sempre devolve no mesmo sítio)
function achar(obj, nomes, prof) {
  if (!obj || typeof obj !== 'object' || (prof || 0) > 4) return undefined;
  for (const n of nomes) if (obj[n] != null && obj[n] !== '') return obj[n];
  for (const k of Object.keys(obj)) { const v = achar(obj[k], nomes, (prof || 0) + 1); if (v != null && v !== '') return v; }
  return undefined;
}
// o link pode vir com ou sem https://, num campo com nome próprio, ou dentro de texto/HTML
const CAMPOS_LINK = ['link', 'url', 'checkout_url', 'checkoutUrl', 'checkout', 'payment_url', 'paymentUrl', 'payment_link', 'redirect_url', 'redirect', 'session_url', 'href'];
function normalLink(v) {
  if (typeof v !== 'string') return undefined;
  v = v.trim().replace(/^["']|["']$/g, '');
  const m = v.match(/https?:\/\/[^\s"'<>]+/i);
  if (m) return m[0];
  if (/^\/\/[^\s]+\.[a-z]{2,}/i.test(v)) return 'https:' + v;
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?$/i.test(v) && v.indexOf('.') > 0 && !/^\d+(\.\d+)*$/.test(v)) return 'https://' + v;
  return undefined;
}
function acharLink(obj, prof) {
  if (typeof obj === 'string') { const m = obj.match(/https?:\/\/[^\s"'<>]+/i); return m ? m[0] : undefined; }
  if (!obj || typeof obj !== 'object' || (prof || 0) > 5) return undefined;
  for (const n of CAMPOS_LINK) { const v = normalLink(obj[n]); if (v) return v; }
  for (const k of Object.keys(obj)) { const v = acharLink(obj[k], (prof || 0) + 1); if (v) return v; }
  return undefined;
}
function sessionDoLink(link) {
  try {
    const u = new URL(link);
    for (const k of ['session_id', 'sessionId', 'session', 'sid', 'checkout_session', 'id']) { const v = u.searchParams.get(k); if (v) return v; }
    const partes = u.pathname.split('/').filter(Boolean); return partes[partes.length - 1] || null;
  } catch (e) { return null; }
}

let MOZ_TOKEN = null, MOZ_TOKEN_ATE = 0;
async function mozLogin(forcar) {
  if (!forcar && MOZ_TOKEN && Date.now() < MOZ_TOKEN_ATE) return MOZ_TOKEN;
  if (!MOZ_EMAIL || !MOZ_SENHA) throw new Error('MOZ_EMAIL ou MOZ_SENHA em falta no container');
  console.log('[moz] login…');
  let r;
  try { r = await fetch(MOZ_BASE + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: MOZ_EMAIL, senha: MOZ_SENHA }), signal: AbortSignal.timeout(25000) }); }
  catch (e) { throw new Error(e.name === 'TimeoutError' ? 'o login na MozPayment não respondeu em 25 segundos' : 'sem ligação à MozPayment (' + e.message + ')'); }
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) { d = { raw: t }; }
  const token = achar(d, ['token', 'access_token', 'accessToken', 'jwt']);
  if (!r.ok || !token) throw new Error('login MozPayment falhou (' + r.status + '): ' + t.slice(0, 200));
  const segs = Number(achar(d, ['expires', 'expires_in'])) || 3600;
  MOZ_TOKEN = String(token); MOZ_TOKEN_ATE = Date.now() + Math.max(300, segs - 120) * 1000;
  return MOZ_TOKEN;
}
async function mozPedido(caminho, corpo) {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const token = await mozLogin(tentativa > 0);
    console.log('[moz] ' + caminho + ' a pedir… ' + JSON.stringify(Object.assign({}, corpo, { wallet: corpo.wallet ? '…' : undefined, carteira: corpo.carteira ? '…' : undefined })));
    let r;
    // o M-Pesa/e-Mola só responde depois de a pessoa pôr o PIN (ou desistir): esperar até 100 s
    try { r = await fetch(MOZ_BASE + '/' + caminho, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(100000) }); }
    catch (e) { const x = new Error(e.name === 'TimeoutError' ? 'a MozPayment não respondeu em 100 segundos' : 'sem ligação à MozPayment (' + e.message + ')'); x.semResposta = true; throw x; }
    const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) { d = { raw: t }; }
    if ((r.status === 401 || r.status === 403) && tentativa === 0) continue;   // token caducado: novo login e repete
    console.log('[moz] ' + caminho + ' → ' + r.status + ' ' + t.slice(0, 1500));
    if (!r.ok) { const e = new Error(achar(d, ['message', 'mensagem', 'error', 'erro']) || ('MozPayment respondeu ' + r.status)); e.moz = d; throw e; }
    // a MozPayment responde 200 mesmo quando falha: ver o cod/status dentro da resposta
    const st = String(achar(d, ['status', 'estado']) || '').toLowerCase(), cod = Number(achar(d, ['cod', 'code', 'codigo', 'status_code']));
    const falhou = /error|erro|fail|falh|invalid|inv[aá]lid|recus|negad|insuf/.test(st) || (isFinite(cod) && cod >= 400);
    if (falhou) { const e = new Error(achar(d, ['message', 'mensagem', 'msg', 'error', 'erro', 'detalhe']) || ('MozPayment: ' + (st || 'cod ' + cod))); e.moz = d; throw e; }
    // erros "escondidos" num campo da resposta, ex.: { status:"success", response:{ valor_invalido:"Valor abaixo de 10MT…" } }
    const procura = o => { if (!o || typeof o !== 'object') return null; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /invalid|erro|error|falh|insufic|recus|negad/i.test(k)) return v; if (v && typeof v === 'object') { const x = procura(v); if (x) return x; } } return null; };
    const escondido = procura(d);
    if (escondido) { const e = new Error(escondido); e.moz = d; throw e; }
    return d;
  }
  throw new Error('A MozPayment recusou o acesso (verifique MOZ_EMAIL e MOZ_SENHA).');
}

// ---------- multas calculadas no momento ----------
function calcPropina(p, regras) {
  const valor = Number(p['Valor'] || 0);
  const estado = p['Estado'] || 'aberta';
  if (estado === 'paga' || estado === 'anulada') return { valor, multa: Number(p['Multa'] || 0), total: Number(p['Total'] || valor), estado, meses_atraso: 0 };
  const venc = p['Vencimento'] ? new Date(p['Vencimento']) : null;
  let meses = 0;
  if (venc && Date.now() > venc.getTime() + 864e5 - 1) meses = Math.max(1, Math.ceil((Date.now() - venc.getTime()) / (30 * 864e5)));
  const pct = (p['Tipo'] || 'propina') === 'propina' && meses ? Math.min(Number(regras.multa_max || 25), Number(regras.multa || 0) * meses) : 0;
  const multa = Math.round(valor * pct / 100);
  return { valor, multa, total: valor + multa, estado: meses ? 'atrasada' : 'aberta', meses_atraso: meses };
}
const MESES_NOME = ['', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// ---------- criação em lote (Bubble bulk) ----------
async function criarEmLote(tipo, lista) {
  let criados = 0;
  for (let i = 0; i < lista.length; i += 500) {
    const fatia = lista.slice(i, i + 500);
    const r = await fetch(BUBBLE_BASE + '/' + tipo + '/bulk', { method: 'POST', headers: { 'Authorization': 'Bearer ' + BUBBLE_TOKEN, 'Content-Type': 'text/plain' }, body: fatia.map(x => JSON.stringify(x)).join('\n') });
    const t = await r.text();
    if (!r.ok) {
      let msg = t; try { const d = JSON.parse(t); msg = (d.body && d.body.message) || d.message || t; } catch (e) {}
      throw erroGravar(tipo, Object.assign(new Error(msg), { status: r.status === 404 ? 404 : 400, bubble: String(msg).slice(0, 200) }));
    }
    const linhas = t.split('\n').filter(Boolean), ok = linhas.filter(l => /"status"\s*:\s*"success"/.test(l)).length;
    criados += ok;
    if (!ok && linhas.length) {   // o Bubble respondeu 200 mas recusou todas as linhas: mostrar o primeiro motivo
      let msg = linhas[0]; try { const d = JSON.parse(linhas[0]); msg = d.message || (d.body && d.body.message) || linhas[0]; } catch (e) {}
      throw erroGravar(tipo, Object.assign(new Error(msg), { status: 400, bubble: String(msg).slice(0, 200) }));
    }
  }
  return criados;
}

// ---------- propinas: gerar, listar ----------
app.post('/propinas-gerar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const de = Math.max(1, Math.min(12, num(b.de, 2))), ate = Math.max(de, Math.min(12, num(b.ate, 11)));
  const escola = await resumoEscola(req.escola);
  const ano = Number((escola && escola.ano) || new Date().getFullYear());
  const dia = Math.max(1, Math.min(28, Number((escola && escola.regras.dia_limite) || 10)));
  const f = daEscola(req.escola);
  let turmas = (await procurarTodos('turma', f)).filter(t => t['Activa'] !== false);
  if (b.turma) turmas = turmas.filter(t => t._id === String(b.turma));
  if (!turmas.length) return erro(res, 400, 'Escolha uma turma.');
  const [estudantes, existentes] = await Promise.all([procurarTodos('estudante', f), procurarTodos('propina', f)]);
  const ja = new Set(existentes.filter(p => (p['Tipo'] || 'propina') === 'propina').map(p => p['Estudante'] + '|' + p['Ano Lectivo'] + '|' + p['Mes']));
  const novas = [];
  let semValor = 0;
  for (const t of turmas) {
    const valor = Number(t['Propina Mensal'] || 0);
    const daTurma = estudantes.filter(e => e['Turma'] === t._id && (e['Estado'] || 'activo') === 'activo');
    if (!valor) { semValor += daTurma.length ? 1 : 0; continue; }
    for (const e of daTurma) for (let m = de; m <= ate; m++) {
      if (ja.has(e._id + '|' + ano + '|' + m)) continue;
      const linha = { 'Escola': req.escola, 'Estudante': e._id, 'Turma': t._id, 'Ano Lectivo': String(ano), 'Tipo': 'propina', 'Mes': m,
        'Descricao': 'Propina de ' + MESES_NOME[m] + ' ' + ano + ' · ' + t['Nome'], 'Valor': valor, 'Vencimento': new Date(Date.UTC(ano, m - 1, dia, 21, 59)).toISOString(),
        'Multa': 0, 'Total': valor, 'Estado': 'aberta' };
      if (e['Encarregado']) linha['Encarregado'] = e['Encarregado'];
      novas.push(linha);
    }
  }
  const criadas = novas.length ? await criarEmLote('propina', novas) : 0;
  res.json({ ok: true, criadas, pedidas: novas.length, turmas_sem_valor: semValor });
}));

app.post('/propinas', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, f = daEscola(req.escola);
  const filtros = b.turma ? f.concat([{ key: 'Turma', constraint_type: 'equals', value: String(b.turma) }]) : f;
  const [escola, props, est, encs] = await Promise.all([resumoEscola(req.escola), procurarTodos('propina', filtros, 6000), procurarTodos('estudante', filtros), procurarTodos('encarregado', f)]);
  const regras = (escola && escola.regras) || {};
  const porEst = {};
  for (const p of props) {
    if (p['Estado'] === 'anulada') continue;
    const c = calcPropina(p, regras);
    (porEst[p['Estudante']] = porEst[p['Estudante']] || []).push({ id: p._id, mes: p['Mes'], descricao: p['Descricao'], tipo: p['Tipo'] || 'propina', vencimento: p['Vencimento'], pago_em: p['Pago Em'] || null, ...c });
  }
  const lista = est.filter(e => (e['Estado'] || 'activo') === 'activo').map(e => {
    const en = encs.find(x => x._id === e['Encarregado']);
    const ps = (porEst[e._id] || []).sort((a, b) => (a.mes || 0) - (b.mes || 0));
    const divida = ps.filter(p => p.estado === 'atrasada').reduce((s, p) => s + p.total, 0);
    return { id: e._id, nome: e['Nome'], numero: e['Numero'], turma: e['Turma'], encarregado: en ? { nome: en['Nome'], telefone: en['Telefone'] || '' } : null, propinas: ps, divida };
  }).sort((a, b) => b.divida - a.divida || a.nome.localeCompare(b.nome, 'pt'));
  const tot = { cobrado: 0, divida: 0, multas: 0, atraso: 0 };
  lista.forEach(e => e.propinas.forEach(p => { if (p.estado === 'paga') tot.cobrado += p.total; if (p.estado === 'atrasada') { tot.divida += p.total; tot.multas += p.multa; } }));
  tot.atraso = lista.filter(e => e.divida > 0).length;
  res.json({ ok: true, estudantes: lista, totais: tot, regras });
}));

// ---------- cobrar ----------
async function prepararCobranca(req, ids) {
  if (!Array.isArray(ids) || !ids.length) { const e = new Error('Escolha pelo menos uma mensalidade.'); e.publico = 400; throw e; }
  const escola = await resumoEscola(req.escola);
  const ps = [];
  for (const id of ids.map(String)) {
    const p = await daMinhaEscola('propina', id, req.escola);
    if (p['Estado'] === 'paga') { const e = new Error('Uma das mensalidades escolhidas já está paga.'); e.publico = 409; throw e; }
    if (p['Estado'] === 'anulada') { const e = new Error('Uma das mensalidades escolhidas foi anulada.'); e.publico = 409; throw e; }
    if (req.educandos && !req.educandos.includes(p['Estudante'])) { const e = new Error('Registo não encontrado.'); e.publico = 404; throw e; }
    if (ps.length && ps[0].p['Estudante'] !== p['Estudante']) { const e = new Error('Cobre as mensalidades de um estudante de cada vez.'); e.publico = 400; throw e; }
    ps.push({ p, c: calcPropina(p, (escola && escola.regras) || {}) });
  }
  const total = ps.reduce((s, x) => s + x.c.total, 0), multa = ps.reduce((s, x) => s + x.c.multa, 0);
  return { escola, ps, total, multa };
}
// ============================================================
//  SMS (Turbo Host)
//  POST https://my.turbo.host/api/international-sms/submit
//  { user_token, origin, message, numbers:[ "2588XXXXXXXX" ] }
//  Variáveis: SMS_TOKEN (user_token), SMS_ORIGEM (origin), SMS_URL (opcional)
//  Todos os números saem com o prefixo 258.
// ============================================================
const SMS_URL = process.env.SMS_URL || 'https://my.turbo.host/api/international-sms/submit';
// ---------- email (v5.16): Resend. O email vai junto com o SMS, para quando o SMS não chega ----------
//    RESEND_KEY   chave da API do Resend (re_…)
//    MAIL_FROM    remetente de um domínio verificado no Resend, ex.: Gescolar <nao-responder@gescolar.co.mz>
const RESEND_KEY = (process.env.RESEND_KEY || '').trim();
const MAIL_FROM = (process.env.MAIL_FROM || '').trim();
const RESEND_URL = process.env.RESEND_URL || 'https://api.resend.com/emails';
const escH = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// corpo do email com a cara do Gescolar; blocos = [{p:'texto'} | {codigo:'123456'} | {botao:'Texto', link:'https://…'} | {nota:'texto'}]
function emailGescolar(escolaNome, titulo, blocos) {
  const corpo = blocos.map(b => b.codigo ? '<div style="font:800 34px/1 Consolas,monospace;letter-spacing:8px;color:#0B2A4A;background:#EEF4FC;border-radius:12px;padding:18px 0;text-align:center;margin:18px 0">' + escH(b.codigo) + '</div>'
    : b.botao ? '<div style="text-align:center;margin:22px 0"><a href="' + escH(b.link) + '" style="display:inline-block;background:#0A64DC;color:#fff;text-decoration:none;font:700 16px Arial,sans-serif;padding:14px 26px;border-radius:10px">' + escH(b.botao) + '</a></div><p style="font:13px/1.5 Arial,sans-serif;color:#5F6B7A;margin:0 0 14px;word-break:break-all">Se o botão não abrir, copie este endereço: ' + escH(b.link) + '</p>'
    : b.nota ? '<p style="font:13px/1.5 Arial,sans-serif;color:#5F6B7A;margin:14px 0 0">' + escH(b.nota) + '</p>'
    : '<p style="font:15px/1.55 Arial,sans-serif;color:#12233A;margin:0 0 12px">' + escH(b.p) + '</p>').join('');
  return '<!doctype html><html><body style="margin:0;background:#F2F5F9;padding:24px 12px"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
    '<div style="background:#0B2A4A;color:#fff;padding:18px 22px;font:800 18px Arial,sans-serif">Gescolar<span style="display:block;font:400 13px Arial,sans-serif;opacity:.8;margin-top:2px">' + escH(escolaNome || '') + '</span></div>' +
    '<div style="padding:24px 22px"><h1 style="font:800 20px/1.3 Arial,sans-serif;color:#0B2A4A;margin:0 0 14px">' + escH(titulo) + '</h1>' + corpo + '</div>' +
    '<div style="padding:14px 22px;background:#F7F9FC;font:12px Arial,sans-serif;color:#8A94A3">Gescolar · gestão escolar em Moçambique · gescolar.co.mz</div></div></body></html>';
}
function textoDeBlocos(titulo, blocos) { return titulo + '\n\n' + blocos.map(b => b.codigo ? 'Código: ' + b.codigo : b.botao ? b.botao + ': ' + b.link : (b.p || b.nota || '')).join('\n\n'); }
// sem Resend, o email sai pelo «Send email» do próprio Bubble: backend workflow «enviar-email» com para, assunto, texto
async function enviarEmailBubble(email, assunto, texto) {
  try {
    const d = await workflow('enviar-email', { para: email, assunto, texto });
    console.log('[email-bubble] ' + email + ' → ' + JSON.stringify(d).slice(0, 120));
    return { ok: true };
  } catch (e) { console.error('[email-bubble] ' + email + ' → ' + e.message); return { ok: false, erro: e.message }; }
}
async function enviarEmail(para, assunto, html, texto) {
  const email = String(para || '').trim().toLowerCase();
  if (!emailOk(email)) return { ok: false, erro: 'email inválido' };
  if (!RESEND_KEY || !MAIL_FROM) return enviarEmailBubble(email, assunto, texto);
  try {
    const r = await fetch(RESEND_URL, { method: 'POST', headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [email], subject: assunto, html, text: texto }), signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    console.log('[email] ' + email + ' → ' + r.status + ' ' + t.slice(0, 200));
    if (!r.ok) { let d = null; try { d = JSON.parse(t); } catch (e) {} return { ok: false, erro: String((d && (d.message || d.error)) || ('o Resend respondeu ' + r.status)).slice(0, 200) }; }
    return { ok: true };
  } catch (e) { console.error('[email]', e.message); return { ok: false, erro: e.message }; }
}
const mascararEmail = e => { const m = String(e || '').match(/^([^@]+)@(.+)$/); return m ? m[1].slice(0, 2) + '***@' + m[2] : ''; };
const SMS_TOKEN = process.env.SMS_TOKEN || '';
const SMS_ORIGEM = process.env.SMS_ORIGEM || '';
// 84 123 4567 / +258 84 123 4567 / 00258841234567  →  258841234567
function numeroSMS(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.indexOf('00258') === 0) d = d.slice(2);
  if (d.length === 9 && d[0] === '8') d = '258' + d;
  return /^2588[2-7]\d{7}$/.test(d) ? d : null;
}
// tira acentos e caracteres especiais para a mensagem caber num SMS normal (160 caracteres)
function textoSMS(m) {
  if (!SMS_LINKS) m = String(m || '').replace(/\b(?:https?:\/\/|www\.)\S+/gi, '').replace(/\s+([.,)])/g, '$1');   // sem links (v5.17)
  return String(m || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/º/g, 'o').replace(/ª/g, 'a').replace(/[^\x20-\x7E\n]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, 459);
}
async function enviarSMS(numeros, mensagem) {
  if (!SMS_TOKEN || !SMS_ORIGEM) return { ok: false, erro: 'SMS_TOKEN ou SMS_ORIGEM em falta no container' };
  const lista = [...new Set((Array.isArray(numeros) ? numeros : [numeros]).map(numeroSMS).filter(Boolean))];
  if (!lista.length) return { ok: false, erro: 'nenhum número válido' };
  const message = textoSMS(mensagem);
  if (!message) return { ok: false, erro: 'mensagem vazia' };
  try {
    const r = await fetch(SMS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ user_token: SMS_TOKEN, origin: SMS_ORIGEM, message, numbers: lista }) });
    const t = await r.text();
    console.log('[sms] ' + lista.join(',') + ' → ' + r.status + ' ' + t.slice(0, 300));
    let d = null; try { d = JSON.parse(t); } catch (e) { d = { raw: t }; }
    const falhou = !r.ok || (d && (d.success === false || d.ok === false || /error|erro|fail|invalid/i.test(String(d.status || ''))));
    if (falhou) return { ok: false, erro: String(achar(d, ['message', 'mensagem', 'error', 'erro']) || ('o serviço de SMS respondeu ' + r.status)).slice(0, 200), numeros: lista };
    return { ok: true, numeros: lista, resposta: d };
  } catch (e) {
    console.error('[sms]', e.message);
    return { ok: false, erro: e.message, numeros: lista };
  }
}
const mt = v => Number(v || 0).toLocaleString('pt-PT', { maximumFractionDigits: 6 }).replace(/\s/g, ' ') + ' MT';
// recibo por SMS: ao encarregado (se aceita SMS) e a quem pagou pelo telemóvel
async function smsRecibo(pag, documento) {
  try {
    const escola = await obter('escola', pag['Escola']).catch(() => null);
    const est = pag['Estudante'] ? await obter('estudante', pag['Estudante']).catch(() => null) : null;
    const enc = pag['Encarregado'] ? await obter('encarregado', pag['Encarregado']).catch(() => null) : null;
    const numeros = [];
    if (enc && enc['Recebe SMS'] !== false && enc['Telefone']) numeros.push(enc['Telefone']);
    if (['mpesa', 'emola'].includes(String(pag['Metodo'] || '').toLowerCase()) && pag['Telefone']) numeros.push(pag['Telefone']);
    if (!numeros.length) return;
    const qtd = (pag['Propinas'] || []).length;
    const msg = (escola ? escola['Nome'] + ': ' : '') + 'recebemos ' + mt(pag['Valor']) +
      (est ? ' de ' + est['Nome'] : '') + (qtd > 1 ? ' (' + qtd + ' mensalidades)' : '') +
      '. Recibo ' + documento + '. Obrigado. Gescolar';
    const r = await enviarSMS(numeros, msg);
    if (!r.ok) console.warn('[sms] recibo ' + documento + ' não enviado: ' + r.erro);
  } catch (e) { console.error('[sms] recibo', e.message); }
}
app.post('/sms-teste', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  if (!numeroSMS(b.numero)) return erro(res, 400, 'Número inválido. Use 9 dígitos, por exemplo 84 123 4567.');
  const escola = await resumoEscola(req.escola);
  const r = await enviarSMS([b.numero], txt(b.mensagem, 300) || ((escola ? escola.nome + ': ' : '') + 'teste de SMS do Gescolar. Se recebeu esta mensagem, esta tudo a funcionar.'));
  if (!r.ok) return erro(res, 502, 'O SMS não foi enviado: ' + r.erro);
  res.json({ ok: true, enviado_para: r.numeros });
}));

async function aplicarPago(pag, extra) {
  const agora = new Date().toISOString();
  const documento = await proximoDocumento(pag['Escola']);
  await mudar('pagamento', pag._id, Object.assign({ 'Estado': 'pago', 'Pago Em': agora, 'Documento': documento }, extra || {}));
  for (const pid of (pag['Propinas'] || [])) {
    const p = await obter('propina', pid).catch(() => null);
    const escola = p ? await resumoEscola(p['Escola']) : null;
    const c = p ? calcPropina(p, (escola && escola.regras) || {}) : { multa: 0, total: 0 };
    await mudar('propina', pid, { 'Estado': 'paga', 'Pago Em': agora, 'Pagamento': pag._id, 'Multa': c.multa, 'Total': c.total }).catch(e => console.error('[pago] propina ' + pid + ': ' + e.message));
  }
  smsRecibo(Object.assign({}, pag, extra || {}), documento);   // não espera: o SMS nunca atrasa o pagamento
  return documento;
}
async function proximoDocumento(escola) {
  const ano = new Date().getFullYear();
  const pagos = await procurarTodos('pagamento', [{ key: 'Escola', constraint_type: 'equals', value: escola }, { key: 'Documento', constraint_type: 'is_not_empty' }]);
  const maior = pagos.map(p => String(p['Documento'] || '')).filter(d => d.indexOf('FR ' + ano + '/') === 0)
    .map(d => parseInt(d.split('/')[1], 10) || 0).reduce((a, c) => Math.max(a, c), 0);
  return 'FR ' + ano + '/' + String(maior + 1).padStart(6, '0');
}

async function cobrarOnline(req, res) {
  const b = req.body || {};
  const metodo = String(b.metodo || '').toLowerCase();
  if (!['mpesa', 'emola', 'cartao'].includes(metodo)) return erro(res, 400, 'Escolha M-Pesa, e-Mola ou cartão.');
  if (!MOZ_WALLET) return erro(res, 500, 'O servidor ainda não tem a carteira configurada (MOZ_WALLET).');
  const { ps, total, multa } = await prepararCobranca(req, b.propinas);
  if (total < MOZ_MIN) return erro(res, 400, 'O valor mínimo para pagar online é ' + MOZ_MIN + ' MT. Este pagamento é de ' + total + ' MT.');
  const est = ps[0].p['Estudante'] ? await obter('estudante', ps[0].p['Estudante']).catch(() => null) : null;
  const nome = txt(b.nome, 80) || (est && est['Nome']) || 'Encarregado';
  const numero = soDigitos(b.numero);
  if (metodo !== 'cartao') {
    if (numero.length !== 9) return erro(res, 400, 'O número tem 9 dígitos, por exemplo 84 123 4567.');
    const pre = numero.slice(0, 2);
    if (metodo === 'mpesa' && !['84', '85'].includes(pre)) return erro(res, 400, 'M-Pesa só funciona com números Vodacom (84 ou 85).');
    if (metodo === 'emola' && !['86', '87'].includes(pre)) return erro(res, 400, 'e-Mola só funciona com números Movitel (86 ou 87).');
  }
  const pagId = await criar('pagamento', { 'Escola': req.escola, 'Estudante': ps[0].p['Estudante'] || undefined, 'Encarregado': ps[0].p['Encarregado'] || undefined,
    'Propinas': ps.map(x => x.p._id), 'Metodo': metodo, 'Telefone': numero, 'Valor': total, 'Multa Incluida': multa, 'Estado': 'pendente' });
  const produto = ps.length === 1 ? (ps[0].p['Descricao'] || 'Propina') : ps.length + ' mensalidades · ' + ((est && est['Nome']) || '');
  try {
    if (metodo === 'cartao') {
      const d = await mozPedido(MOZ_CARD_PATH, { valor: String(total), nome_cliente: nome, carteira: MOZ_WALLET, nome_producto: produto.slice(0, 120) });
      const link = acharLink(d);
      if (!link) throw new Error('sem link na resposta: ' + JSON.stringify(d).slice(0, 220));
      const sessao = String(achar(d, ['session_id', 'sessionId', 'session']) || sessionDoLink(link) || '');
      await mudar('pagamento', pagId, { 'Referencia': sessao, 'Raw': JSON.stringify(d).slice(0, 4000) });
      return res.json({ ok: true, pagamento: pagId, estado: 'pendente', link, total });
    }
    const d = await mozPedido('payment', corpoC2B(metodo, total, numero, nome));
    const idp = achar(d, ['idpayment', 'id_payment', 'idPayment', 'payment_id', 'paymentId', 'reference', 'id']);
    if (!idp) throw new Error('a MozPayment não devolveu a referência do pagamento: ' + JSON.stringify(d).slice(0, 200));
    await mudar('pagamento', pagId, { 'Referencia': String(idp), 'Raw': JSON.stringify(d).slice(0, 4000) });
    res.json({ ok: true, pagamento: pagId, estado: 'pendente', total, mensagem: 'Pedido enviado para o ' + numero.replace(/(\d{2})(\d{3})(\d{4})/, '$1 $2 $3') + '. O encarregado confirma com o PIN.' });
  } catch (e) {
    console.error('[pagar]', e.message);
    if (e.semResposta) {   // pode ter chegado ao telemóvel: o pagamento fica pendente e o webhook ainda o pode confirmar
      await mudar('pagamento', pagId, { 'Raw': String(e.message).slice(0, 2000) }).catch(() => {});
      return res.json({ ok: true, pagamento: pagId, estado: 'pendente', total, mensagem: 'A MozPayment está a demorar a responder. Se o pedido chegou ao telemóvel e for pago, o recibo aparece sozinho.' });
    }
    await mudar('pagamento', pagId, { 'Estado': 'falhado', 'Raw': String(e.message).slice(0, 2000) }).catch(() => {});
    erro(res, 502, 'A MozPayment não aceitou o pedido: ' + String(e.message).slice(0, 300));
  }
}
app.post('/pagar', exigeDireccao, rota(cobrarOnline));

app.post('/pagar-balcao', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const { ps, total, multa } = await prepararCobranca(req, b.propinas);
  const pagId = await criar('pagamento', { 'Escola': req.escola, 'Estudante': ps[0].p['Estudante'] || undefined, 'Encarregado': ps[0].p['Encarregado'] || undefined,
    'Propinas': ps.map(x => x.p._id), 'Metodo': 'balcao', 'Valor': total, 'Multa Incluida': multa, 'Estado': 'pendente', 'Recebido Por': req.sessao.u,
    'Referencia': 'CX-' + Date.now().toString(36).toUpperCase() });
  const pag = await obter('pagamento', pagId);
  const documento = await aplicarPago(pag, { 'Transacao': 'numerario' });
  res.json({ ok: true, pagamento: pagId, estado: 'pago', documento, total });
}));

app.post('/pagamento-estado', exigeDireccao, rota(async (req, res) => {
  const p = await daMinhaEscola('pagamento', String((req.body || {}).id || ''), req.escola);
  res.json({ ok: true, id: p._id, estado: p['Estado'] || 'pendente', documento: p['Documento'] || null, valor: p['Valor'] || 0, metodo: p['Metodo'] || '' });
}));

app.post('/pagamentos', exigeDireccao, rota(async (req, res) => {
  const f = daEscola(req.escola);
  const [pags, est] = await Promise.all([procurarTodos('pagamento', f, 3000), procurarTodos('estudante', f)]);
  res.json({ ok: true, pagamentos: pags.filter(p => p['Estado'] === 'pago').map(p => { const e = est.find(x => x._id === p['Estudante']);
    return { id: p._id, documento: p['Documento'], data: p['Pago Em'], metodo: p['Metodo'], valor: p['Valor'], multa: p['Multa Incluida'] || 0, estudante: e ? e['Nome'] : '', numero: e ? e['Numero'] : '', referencia: p['Referencia'] || '', transacao: p['Transacao'] || '', telefone: p['Telefone'] || '' }; })
    .sort((a, b) => String(b.data).localeCompare(String(a.data))) });
}));

// ============================================================
//  DADOS DA ESCOLA PARA AS FACTURAS (v4.2)
//  Campos novos no Bubble, data type Escola:  Logotipo (text)  ·  Morada (text)
//  O logótipo fica guardado como imagem em texto (data:image/...;base64), pequeno (até 300 KB),
//  para o PDF sair sempre com ele, sem depender de outro servidor.
// ============================================================
const LOGO_MAX = 300 * 1024;
function escolaFactura(e) {
  return { id: e._id, nome: e['Nome'] || '', nuit: e['NUIT'] || '', morada: e['Morada'] || '', cidade: e['Cidade'] || '', provincia: e['Provincia'] || '',
    telefone: e['Telefone'] || '', email: e['Email'] || '', subdominio: e['Subdominio'] || '', logotipo: e['Logotipo'] || '' };
}
app.post('/escola-dados', exigeDireccao, rota(async (req, res) => {
  const e = await obter('escola', req.escola);
  res.json({ ok: true, escola: escolaFactura(e) });
}));
app.post('/escola-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const mud = {};
  if (b.logotipo !== undefined) {
    const l = String(b.logotipo || '');
    if (l && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(l)) return erro(res, 400, 'O logótipo tem de ser uma imagem PNG, JPG ou WEBP.');
    if (l.length > LOGO_MAX) return erro(res, 400, 'O logótipo é demasiado grande. Use uma imagem mais pequena.');
    mud['Logotipo'] = l;
  }
  if (b.morada !== undefined) mud['Morada'] = txt(b.morada, 160);
  if (b.telefone !== undefined) mud['Telefone'] = txt(b.telefone, 30);
  if (b.email !== undefined) {
    const em = txt(b.email, 120).toLowerCase();
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return erro(res, 400, 'O email da escola não parece válido.');
    mud['Email'] = em;
  }
  if (!Object.keys(mud).length) return erro(res, 400, 'Nada para guardar.');
  await mudar('escola', req.escola, mud);
  const e = await obter('escola', req.escola);
  res.json({ ok: true, escola: escolaFactura(e) });
}));

// ---------- factura-recibo ----------
// Quem pode ver: a Direcção/Secretaria da escola do pagamento.
// (Na área do Estudante e do Encarregado, cada um verá só os seus — próxima fase.)
async function dadosRecibo(pag) {
  const [escola, est, enc] = await Promise.all([
    obter('escola', pag['Escola']).catch(() => null),
    pag['Estudante'] ? obter('estudante', pag['Estudante']).catch(() => null) : null,
    pag['Encarregado'] ? obter('encarregado', pag['Encarregado']).catch(() => null) : null
  ]);
  const turma = est && est['Turma'] ? await obter('turma', est['Turma']).catch(() => null) : null;
  const props = await Promise.all((pag['Propinas'] || []).map(id => obter('propina', id).catch(() => null)));
  const linhas = props.filter(Boolean).map(p => {
    const valor = Number(p['Valor'] || 0), multa = Number(p['Multa'] || 0);
    return { descricao: p['Descricao'] || 'Propina', vencimento: p['Vencimento'] || null, valor, multa, total: Number(p['Total'] || (valor + multa)) };
  }).sort((a, b) => String(a.vencimento || '').localeCompare(String(b.vencimento || '')));
  const recebido = pag['Recebido Por'] ? await obter('user', pag['Recebido Por']).catch(() => null) : null;
  return {
    escola: escola ? escolaFactura(escola) : { nome: '' },
    id: pag._id, documento: pag['Documento'] || '', data: pag['Pago Em'] || pag['Created Date'] || null,
    metodo: pag['Metodo'] || '', referencia: pag['Referencia'] || '', transacao: pag['Transacao'] || '', telefone: pag['Telefone'] || '',
    valor: Number(pag['Valor'] || 0), multa: Number(pag['Multa Incluida'] || 0),
    estudante: est ? { nome: est['Nome'] || '', numero: est['Numero'] || '', turma: turma ? (turma['Nome'] || '') : '' } : null,
    encarregado: enc ? { nome: enc['Nome'] || '', telefone: enc['Telefone'] || '', email: enc['Email'] || '' } : null,
    recebido_por: recebido ? (recebido['Nome Completo'] || '') : '',
    linhas
  };
}
app.post('/recibo', exigeQualquer, rota(async (req, res) => {
  const p = await daMinhaEscola('pagamento', String((req.body || {}).id || ''), req.escola);
  if (req.educandos && !req.educandos.includes(p['Estudante'])) return erro(res, 404, 'Registo não encontrado.');
  if (p['Estado'] !== 'pago' || !p['Documento']) return erro(res, 409, 'Este pagamento ainda não está confirmado, por isso ainda não tem factura-recibo.');
  res.json({ ok: true, recibo: await dadosRecibo(p) });
}));

// ============================================================
//  PORTAL DAS FAMÍLIAS (v4.3) — Encarregado e Estudante
//  Entrada sem palavra-passe: código da escola + telemóvel (encarregado) ou número de estudante,
//  e um código de 6 dígitos enviado por SMS. A sessão dura 30 dias.
//  Campo novo no Bubble (opcional): Estudante → Telefone (text), para estudantes com telemóvel próprio.
// ============================================================
const PORTAL_DIAS = 30;
const PORTAL_URL = (process.env.PORTAL_URL || 'https://djdesigncreator.github.io/gescolar-web/acesso.html').replace(/\/+$/, '');
const pedidosAcesso = new Map();
setInterval(() => { const a = Date.now(); for (const [k, v] of pedidosAcesso) if (v.exp < a) pedidosAcesso.delete(k); }, 300e3).unref();
const hashCodigo = c => crypto.createHmac('sha256', SESSION_SECRET || 'x').update(String(c)).digest('hex');
const tel9 = t => soDigitos(t).replace(/^00258/, '').replace(/^258(?=\d{9}$)/, '');
const mascarar = t => { const d = tel9(t); return d.length === 9 ? d.slice(0, 2) + ' *** **' + d.slice(7) : '***'; };
function linkFamilias(sub) { return PORTAL_URL + '?e=' + encodeURIComponent(sub || ''); }
// v5.17: os SMS deixam de levar links (as operadoras bloqueiam SMS com links). SMS_LINKS=sim volta a pô-los.
const SMS_LINKS = /^(sim|1|true)$/i.test(process.env.SMS_LINKS || '');
const noGescolar = sub => SMS_LINKS ? 'em ' + linkFamilias(sub).replace(/^https?:\/\//, '') : 'no Gescolar (codigo da escola: ' + (sub || '') + ')';

async function escolaPorCodigo(codigo) {
  const c = slug(String(codigo || '').replace(/\.gescolar\.co\.mz.*$/i, ''));
  if (!c) return null;
  const l = await procurar('escola', [{ key: 'Subdominio', constraint_type: 'equals', value: c }], 1);
  return l[0] || null;
}
async function educandosDe(s) {
  if (s.p === 'Estudante') return [s.u];
  const l = await procurarTodos('estudante', [{ key: 'Escola', constraint_type: 'equals', value: s.e }, { key: 'Encarregado', constraint_type: 'equals', value: s.u }], 50);
  return l.filter(e => (e['Estado'] || 'activo') === 'activo').map(e => e._id);
}
async function abrirSessaoPortal(s) {
  const tipo = s.p === 'Estudante' ? 'estudante' : s.p === 'Professor' ? 'professor' : 'encarregado';
  const eu = await obter(tipo, s.u).catch(() => null);
  if (!eu || eu['Escola'] !== s.e) { const e = new Error('Conta não encontrada. Entre outra vez.'); e.publico = 401; throw e; }
  if ((tipo === 'encarregado' || tipo === 'professor') && eu['Activo'] === false) { const e = new Error('Este acesso foi desactivado. Fale com a escola.'); e.publico = 403; throw e; }
  if (tipo === 'estudante' && (eu['Estado'] || 'activo') !== 'activo') { const e = new Error('Este estudante já não está activo na escola.'); e.publico = 403; throw e; }
  const escola = await resumoEscola(s.e);
  if (escola && escola.estado === 'suspensa') { const e = new Error('O acesso desta escola está suspenso. Fale com a escola.'); e.publico = 402; throw e; }
  const token = assinar({ u: s.u, e: s.e, p: s.p, t: 'portal' }, PORTAL_DIAS);
  return { ok: true, token, nome: eu['Nome'] || '', papel: s.p, pagina: tipo === 'professor' ? 'professor' : 'portal', escola, expira_dias: PORTAL_DIAS };
}
async function exigePortal(req, res, next) {
  const s = sessaoDo(req);
  if (!s) return erro(res, 401, 'A sessão terminou. Entre outra vez.');
  if (s.t !== 'portal' || !s.e || (s.p !== 'Estudante' && s.p !== 'Encarregado')) return erro(res, 403, 'Esta página é para encarregados e estudantes.');
  try { req.sessao = s; req.escola = s.e; req.educandos = await educandosDe(s); next(); }
  catch (e) { console.error('[portal]', e.message); erro(res, 500, 'Não foi possível concluir. Tente de novo.'); }
}
function exigeQualquer(req, res, next) {
  const s = sessaoDo(req);
  if (s && s.t === 'portal') return exigePortal(req, res, next);
  return exigeDireccao(req, res, next);
}

// 1) pede o código
app.post('/acesso-codigo', rota(async (req, res) => {
  if (!SESSION_SECRET) return erro(res, 500, 'O servidor ainda não está configurado (SESSION_SECRET).');
  const b = req.body || {};
  const tipo = b.tipo === 'estudante' ? 'estudante' : b.tipo === 'professor' ? 'professor' : 'encarregado';
  if (travao('acesso-ip|' + req.ip, 12, 15)) return erro(res, 429, 'Muitos pedidos seguidos. Espere 15 minutos.');
  const esc = await escolaPorCodigo(b.escola);
  if (!esc) return erro(res, 404, 'Não encontrámos essa escola. Confirme o código da escola com a secretaria.');
  if (esc['Estado'] === 'suspensa') return erro(res, 402, 'O acesso desta escola está suspenso. Fale com a escola.');
  let alvo = null, destino = '', emailDestino = '';
  if (tipo === 'professor') {
    const tel = tel9(b.telefone);
    if (tel.length !== 9) return erro(res, 400, 'Escreva o seu número de telemóvel com 9 dígitos.');
    const profs = await procurarTodos('professor', daEscola(esc._id));
    alvo = profs.find(x => tel9(x['Telefone']) === tel && x['Activo'] !== false);
    if (!alvo) return erro(res, 404, 'Este número não está registado como professor nesta escola. Peça à Direcção para confirmar o seu número.');
    destino = tel; emailDestino = alvo['Email'] || '';
  } else if (tipo === 'encarregado') {
    const tel = tel9(b.telefone);
    if (tel.length !== 9) return erro(res, 400, 'Escreva o seu número de telemóvel com 9 dígitos.');
    const encs = await procurarTodos('encarregado', daEscola(esc._id));
    alvo = encs.find(e => tel9(e['Telefone']) === tel && e['Activo'] !== false);
    if (!alvo) return erro(res, 404, 'Este número não está registado como encarregado nesta escola. Peça à secretaria para confirmar o seu número.');
    destino = tel; emailDestino = alvo['Email'] || '';
  } else {
    const num = txt(b.numero, 30).toUpperCase().replace(/\s+/g, '');
    if (!num) return erro(res, 400, 'Escreva o seu número de estudante.');
    const l = await procurar('estudante', [{ key: 'Escola', constraint_type: 'equals', value: esc._id }, { key: 'Numero', constraint_type: 'equals', value: num }], 1);
    alvo = l[0];
    if (!alvo || (alvo['Estado'] || 'activo') !== 'activo') return erro(res, 404, 'Não encontrámos esse número de estudante nesta escola.');
    destino = tel9(alvo['Telefone']);
    const en = alvo['Encarregado'] ? await obter('encarregado', alvo['Encarregado']).catch(() => null) : null;
    if (destino.length !== 9 && en) destino = tel9(en['Telefone']);
    emailDestino = (en && en['Email']) || '';
    if (destino.length !== 9 && !emailOk(emailDestino)) return erro(res, 409, 'Ainda não há telemóvel registado para este estudante. Peça à secretaria para registar o seu número ou o do encarregado.');
  }
  if (travao('acesso|' + alvo._id, 3, 15)) return erro(res, 429, 'Já enviámos vários códigos. Espere 15 minutos e tente de novo.');
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const pedido = crypto.randomBytes(16).toString('hex');
  const blocos = [{ p: 'Use este código para entrar no Gescolar (' + (tipo === 'professor' ? 'Professor' : tipo === 'estudante' ? 'Estudante' : 'Encarregado') + '):' }, { codigo }, { nota: 'O código vale 10 minutos. Não o partilhe com ninguém. Se não pediu este código, ignore este email.' }];
  const [r, m] = await Promise.all([
    destino.length === 9 ? enviarSMS([destino], esc['Nome'] + ': o seu codigo de acesso ao Gescolar e ' + codigo + '. Valido 10 minutos. Nao partilhe este codigo.') : Promise.resolve({ ok: false }),
    emailOk(String(emailDestino).toLowerCase()) ? enviarEmail(emailDestino, 'Código de acesso: ' + codigo, emailGescolar(esc['Nome'], 'O seu código de acesso', blocos), textoDeBlocos('O seu código de acesso', blocos)) : Promise.resolve({ ok: false })]);
  if (!r.ok && !m.ok) return erro(res, 502, 'Não foi possível enviar o código agora. Tente de novo dentro de um minuto.');
  pedidosAcesso.set(pedido, { escola: esc._id, tipo, id: alvo._id, hash: hashCodigo(pedido + codigo), exp: Date.now() + 600e3, tent: 0 });
  res.json({ ok: true, pedido, destino: [r.ok ? mascarar(destino) : '', m.ok ? mascararEmail(emailDestino) : ''].filter(Boolean).join(' e '), sms: r.ok, email: m.ok, escola: esc['Nome'] || '' });
}));
// 2) confirma o código e abre a sessão
app.post('/acesso-entrar', rota(async (req, res) => {
  const b = req.body || {}, chave = String(b.pedido || '');
  const pd = pedidosAcesso.get(chave);
  if (!pd || pd.exp < Date.now()) return erro(res, 410, 'O código expirou. Peça um novo.');
  pd.tent++;
  if (pd.tent > 5) { pedidosAcesso.delete(chave); return erro(res, 429, 'Demasiadas tentativas. Peça um novo código.'); }
  const cod = soDigitos(b.codigo);
  const a = Buffer.from(hashCodigo(chave + cod)), c = Buffer.from(pd.hash);
  if (cod.length !== 6 || a.length !== c.length || !crypto.timingSafeEqual(a, c)) return erro(res, 401, 'Código errado. Confirme o SMS e tente de novo (' + (5 - pd.tent) + ' tentativas restantes).');
  pedidosAcesso.delete(chave);
  res.json(await abrirSessaoPortal({ u: pd.id, e: pd.escola, p: pd.tipo === 'estudante' ? 'Estudante' : pd.tipo === 'professor' ? 'Professor' : 'Encarregado' }));
}));

// tudo o que o portal mostra, num só pedido
app.post('/p/inicio', exigePortal, rota(async (req, res) => {
  const s = req.sessao;
  const [escRaw, eu, escola] = await Promise.all([obter('escola', req.escola), obter(s.p === 'Estudante' ? 'estudante' : 'encarregado', s.u), resumoEscola(req.escola)]);
  const regras = (escola && escola.regras) || {};
  const ests = (await Promise.all(req.educandos.map(id => obter('estudante', id).catch(() => null)))).filter(Boolean);
  const turmaIds = [...new Set(ests.map(e => e['Turma']).filter(Boolean))];
  const turmas = {}; (await Promise.all(turmaIds.map(id => obter('turma', id).catch(() => null)))).filter(Boolean).forEach(t => { turmas[t._id] = t; });
  const cache = {};
  const educandos = await Promise.all(ests.map(async e => {
    const f = [{ key: 'Escola', constraint_type: 'equals', value: req.escola }, { key: 'Estudante', constraint_type: 'equals', value: e._id }];
    const [props, pags] = await Promise.all([procurarTodos('propina', f, 600), procurarTodos('pagamento', f, 600)]);
    const ps = props.filter(p => p['Estado'] !== 'anulada').map(p => ({ id: p._id, mes: p['Mes'], descricao: p['Descricao'], tipo: p['Tipo'] || 'propina', vencimento: p['Vencimento'], pago_em: p['Pago Em'] || null, ...calcPropina(p, regras) }))
      .sort((a, b) => String(a.vencimento || '').localeCompare(String(b.vencimento || '')));
    const t = turmas[e['Turma']];
    return {
      id: e._id, nome: e['Nome'] || '', numero: e['Numero'] || '', turma: t ? (t['Nome'] || '') : '',
      horario: await horarioDaTurma(req.escola, e['Turma'], cache).catch(err => { console.error('[portal] horário', err.message); return null; }),
      faltas: await faltasDoEstudante(req.escola, e._id, cache).catch(err => { console.error('[portal] faltas', err.message); return []; }),
      notas: await notasDoEstudante(req.escola, e, cache).catch(err => { console.error('[portal] notas', err.message); return []; }),
      escolinha: ehESC(t) ? { diario: await diarioDoEstudante(req.escola, e._id).catch(() => []), autorizados: await autorizadosDe(req.escola, [e._id]).catch(() => []) } : null,
      conducao: await conducaoDoEstudante(req.escola, e._id, cache).catch(err => { console.error('[portal] condução', err.message); return null; }),
      comunicados: await comunicadosPara(req.escola, [e['Turma']].filter(Boolean), cache).catch(err => { console.error('[portal] comunicados', err.message); return []; }),
      propinas: ps,
      divida: ps.filter(p => p.estado === 'atrasada').reduce((x, p) => x + p.total, 0),
      em_aberto: ps.filter(p => p.estado !== 'paga').reduce((x, p) => x + p.total, 0),
      recibos: pags.filter(p => p['Estado'] === 'pago' && p['Documento']).map(p => ({ id: p._id, documento: p['Documento'], data: p['Pago Em'], metodo: p['Metodo'], valor: Number(p['Valor'] || 0), multa: Number(p['Multa Incluida'] || 0) }))
        .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')))
    };
  }));
  let telefone = tel9(eu && eu['Telefone']);
  if (telefone.length !== 9 && s.p === 'Estudante' && eu && eu['Encarregado']) { const en = await obter('encarregado', eu['Encarregado']).catch(() => null); telefone = en ? tel9(en['Telefone']) : ''; }
  res.json({ ok: true,
    eu: { nome: (eu && eu['Nome']) || '', papel: s.p, telefone: telefone.length === 9 ? telefone : '' },
    escola: { nome: escRaw['Nome'] || '', logotipo: escRaw['Logotipo'] || '', telefone: escRaw['Telefone'] || '', email: escRaw['Email'] || '', ano: escRaw['Ano Lectivo'] || '', regras: Object.assign({}, regras, { aprovacao: Number(regras.aprovacao || 10), dispensa: Number(regras.dispensa || 14) }) },
    hoje: hojeMZ().data,
    educandos: educandos.sort((a, b) => a.nome.localeCompare(b.nome, 'pt')) });
}));
app.post('/p/pagar', exigePortal, rota(cobrarOnline));
app.post('/p/pagamento-estado', exigePortal, rota(async (req, res) => {
  const p = await daMinhaEscola('pagamento', String((req.body || {}).id || ''), req.escola);
  if (!req.educandos.includes(p['Estudante'])) return erro(res, 404, 'Registo não encontrado.');
  res.json({ ok: true, id: p._id, estado: p['Estado'] || 'pendente', documento: p['Documento'] || null, valor: p['Valor'] || 0, metodo: p['Metodo'] || '' });
}));

// Direcção: link do portal e convite por SMS aos encarregados
app.post('/familias-link', exigeDireccao, rota(async (req, res) => {
  const [esc, encs] = await Promise.all([obter('escola', req.escola), procurarTodos('encarregado', daEscola(req.escola))]);
  const comTel = encs.filter(e => e['Activo'] !== false && e['Recebe SMS'] !== false && tel9(e['Telefone']).length === 9);
  res.json({ ok: true, link: linkFamilias(esc['Subdominio']), codigo: esc['Subdominio'] || '', encarregados: encs.length, com_telefone: comTel.length });
}));
app.post('/familias-convite', exigeDireccao, rota(async (req, res) => {
  if (travao('convite|' + req.escola, 1, 60)) return erro(res, 429, 'O convite já foi enviado há pouco. Pode voltar a enviar daqui a uma hora.');
  const [esc, encs] = await Promise.all([obter('escola', req.escola), procurarTodos('encarregado', daEscola(req.escola))]);
  const nums = [...new Set(encs.filter(e => e['Activo'] !== false && e['Recebe SMS'] !== false).map(e => tel9(e['Telefone'])).filter(t => t.length === 9))];
  if (!nums.length) return erro(res, 400, 'Ainda não há encarregados com telemóvel registado.');
  const link = noGescolar(esc['Subdominio']);
  const msg = (esc['Nome'] || 'A escola') + ': ja pode ver propinas, recibos e notas do seu educando e pagar por M-Pesa ou e-Mola. Entre ' + link + ' com o seu numero de telemovel.';
  let enviados = 0, falhas = 0;
  for (let i = 0; i < nums.length; i += 50) {
    const r = await enviarSMS(nums.slice(i, i + 50), msg);
    if (r.ok) enviados += r.numeros.length; else falhas += nums.slice(i, i + 50).length;
  }
  if (!enviados) return erro(res, 502, 'Não foi possível enviar os SMS agora. Tente mais tarde.');
  res.json({ ok: true, enviados, falhas });
}));

// ============================================================
//  HORÁRIOS (v4.4)
//  Bubble, data type Horario: Escola (Escola) · Turma (text) · Grelha (text) · Publicado (yes/no)
//  Um registo por turma. A grelha é um JSON:
//   { dias:[1..6], tempos:[{i:"07:00",f:"07:45"}], aulas:{ "<dia>-<tempo>": { d:<disciplina>, p:<professor>, s:"sala" } } }
// ============================================================
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIAS_N = ['', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
function lerGrelha(t) { try { const g = JSON.parse(t || ''); return g && typeof g === 'object' ? g : null; } catch (e) { return null; } }
function validarGrelha(g, discIds, profIds) {
  if (!g || typeof g !== 'object') return 'Horário inválido.';
  const dias = Array.isArray(g.dias) ? [...new Set(g.dias.map(Number))].filter(d => d >= 1 && d <= 6).sort() : [];
  if (!dias.length) return 'Escolha os dias de aulas.';
  const tempos = Array.isArray(g.tempos) ? g.tempos : [];
  if (!tempos.length || tempos.length > 14) return 'O horário tem de ter entre 1 e 14 tempos.';
  for (let k = 0; k < tempos.length; k++) {
    const t = tempos[k] || {};
    if (!HORA.test(t.i || '') || !HORA.test(t.f || '') || t.i >= t.f) return 'O ' + (k + 1) + 'º tempo tem horas inválidas (use 07:30 a 08:15).';
    if (k && tempos[k - 1].f > t.i) return 'O ' + (k + 1) + 'º tempo começa antes do anterior acabar.';
  }
  const aulas = {};
  for (const [chave, a] of Object.entries(g.aulas || {})) {
    const m = /^([1-6])-(\d{1,2})$/.exec(chave);
    if (!m || !dias.includes(Number(m[1])) || Number(m[2]) >= tempos.length || !a) continue;
    if (!a.d || !discIds.has(String(a.d))) continue;
    aulas[chave] = { d: String(a.d), p: a.p && profIds.has(String(a.p)) ? String(a.p) : '', s: txt(a.s, 30) };
  }
  return { dias, tempos: tempos.map(t => ({ i: t.i, f: t.f })), aulas };
}
// professor em duas turmas à mesma hora?
function conflitos(grelha, turmaId, outros, nomes) {
  const out = [];
  for (const [chave, a] of Object.entries(grelha.aulas)) {
    if (!a.p) continue;
    const [dia, ti] = chave.split('-').map(Number), t = grelha.tempos[ti];
    for (const o of outros) {
      if (o.turma === turmaId || !o.grelha) continue;
      for (const [ck, b] of Object.entries(o.grelha.aulas || {})) {
        if (b.p !== a.p) continue;
        const [od, oti] = ck.split('-').map(Number), ot = (o.grelha.tempos || [])[oti];
        if (od !== dia || !ot || !(t.i < ot.f && ot.i < t.f)) continue;
        out.push((nomes.prof[a.p] || 'Um professor') + ' já tem aula na turma ' + (nomes.turma[o.turma] || '?') + ' à ' + DIAS_N[dia] + ', ' + ot.i + '–' + ot.f + '.');
      }
    }
  }
  return [...new Set(out)];
}
app.post('/horarios', exigeDireccao, rota(async (req, res) => {
  const f = daEscola(req.escola);
  const [turmas, discs, profs, hs] = await Promise.all([procurarTodos('turma', f), procurarTodos('disciplina', f), procurarTodos('professor', f), procurarTodos('horario', f)]);
  res.json({ ok: true,
    turmas: turmas.filter(t => t['Activa'] !== false).map(t => turmaOut(t)).sort((a, b) => a.nome.localeCompare(b.nome, 'pt')),
    disciplinas: discs.map(discOut).sort((a, b) => a.nome.localeCompare(b.nome, 'pt')),
    professores: profs.filter(p => p['Activo'] !== false).map(p => ({ id: p._id, nome: p['Nome'] || '', disciplinas: p['Disciplinas'] || [] })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt')),
    horarios: hs.map(h => ({ id: h._id, turma: h['Turma'], publicado: !!h['Publicado'], grelha: lerGrelha(h['Grelha']), actualizado: h['Modified Date'] || null })).filter(h => h.grelha) });
}));
app.post('/horario-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, f = daEscola(req.escola);
  const turma = await daMinhaEscola('turma', String(b.turma || ''), req.escola);
  const [discs, profs, hs, turmas] = await Promise.all([procurarTodos('disciplina', f), procurarTodos('professor', f), procurarTodos('horario', f), procurarTodos('turma', f)]);
  const g = validarGrelha(b.grelha, new Set(discs.map(d => d._id)), new Set(profs.map(p => p._id)));
  if (typeof g === 'string') return erro(res, 400, g);
  const nomes = { prof: Object.fromEntries(profs.map(p => [p._id, p['Nome']])), turma: Object.fromEntries(turmas.map(t => [t._id, t['Nome']])) };
  const cf = conflitos(g, turma._id, hs.map(h => ({ turma: h['Turma'], grelha: lerGrelha(h['Grelha']) })), nomes);
  if (cf.length) return res.status(409).json({ ok: false, erro: 'Há professores com aulas sobrepostas.', conflitos: cf.slice(0, 8) });
  const campos = { 'Escola': req.escola, 'Turma': turma._id, 'Grelha': JSON.stringify(g), 'Publicado': !!b.publicado };
  const ja = hs.find(h => h['Turma'] === turma._id);
  const id = ja ? (await mudar('horario', ja._id, campos), ja._id) : await criar('horario', campos);
  res.json({ ok: true, id, grelha: g, publicado: !!b.publicado, aulas: Object.keys(g.aulas).length });
}));
// horário pronto a mostrar (nomes em vez de ids) — usado pelo portal
async function horarioDaTurma(escola, turmaId, cache) {
  if (!turmaId) return null;
  const hs = cache.hs || (cache.hs = await procurarTodos('horario', daEscola(escola)));
  const h = hs.find(x => x['Turma'] === turmaId && x['Publicado']);
  const g = h && lerGrelha(h['Grelha']);
  if (!g) return null;
  if (!cache.disc) {
    const [discs, profs] = await Promise.all([procurarTodos('disciplina', daEscola(escola)), procurarTodos('professor', daEscola(escola))]);
    cache.disc = Object.fromEntries(discs.map(d => [d._id, { nome: d['Nome'] || '', cor: d['Cor'] || '#0A64DC', sigla: d['Sigla'] || '' }]));
    cache.prof = Object.fromEntries(profs.map(p => [p._id, p['Nome'] || '']));
  }
  const aulas = {};
  for (const [k, a] of Object.entries(g.aulas || {})) { const d = cache.disc[a.d]; if (d) aulas[k] = { disciplina: d.nome, sigla: d.sigla, cor: d.cor, professor: cache.prof[a.p] || '', sala: a.s || '' }; }
  return { dias: g.dias, tempos: g.tempos, aulas };
}

// ============================================================
//  COMUNICADOS (v4.4)
//  Bubble, data type Comunicado: Escola (Escola) · Titulo (text) · Texto (text) · Turma (text, vazio = toda a escola)
//                               · Autor (text) · Publicado Em (date) · SMS Enviados (number)
// ============================================================
const comOut = (c, turmas) => ({ id: c._id, titulo: c['Titulo'] || '', texto: c['Texto'] || '', turma: c['Turma'] || '', turma_nome: c['Turma'] ? ((turmas || {})[c['Turma']] || '') : '', autor: c['Autor'] || '', data: c['Publicado Em'] || c['Created Date'] || null, sms: Number(c['SMS Enviados'] || 0) });
app.post('/comunicados', exigeDireccao, rota(async (req, res) => {
  const f = daEscola(req.escola);
  const [cs, turmas] = await Promise.all([procurarTodos('comunicado', f, 500), procurarTodos('turma', f)]);
  const tn = Object.fromEntries(turmas.map(t => [t._id, t['Nome']]));
  res.json({ ok: true, comunicados: cs.map(c => comOut(c, tn)).sort((a, b) => String(b.data || '').localeCompare(String(a.data || ''))) });
}));
app.post('/comunicado-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const titulo = txt(b.titulo, 120), texto = txt(b.texto, 3000);
  if (titulo.length < 3) return erro(res, 400, 'Escreva um título.');
  if (texto.length < 3) return erro(res, 400, 'Escreva o texto do comunicado.');
  let turma = null;
  if (b.turma) turma = await daMinhaEscola('turma', String(b.turma), req.escola);
  const [esc, eu] = await Promise.all([obter('escola', req.escola), obter('user', req.sessao.u).catch(() => null)]);
  const id = await criar('comunicado', { 'Escola': req.escola, 'Titulo': titulo, 'Texto': texto, 'Turma': turma ? turma._id : '', 'Autor': (eu && eu['Nome Completo']) || 'Direcção', 'Publicado Em': new Date().toISOString(), 'SMS Enviados': 0 });
  let sms = 0, aviso = '';
  if (b.sms) {
    if (travao('com-sms|' + req.escola, 6, 60)) aviso = 'O comunicado foi publicado, mas o SMS não foi enviado: limite de 6 envios por hora.';
    else {
      const f = daEscola(req.escola);
      const [ests, encs] = await Promise.all([procurarTodos('estudante', turma ? f.concat([{ key: 'Turma', constraint_type: 'equals', value: turma._id }]) : f), procurarTodos('encarregado', f)]);
      const encIds = new Set(ests.filter(e => (e['Estado'] || 'activo') === 'activo').map(e => e['Encarregado']).filter(Boolean));
      const nums = [...new Set(encs.filter(e => encIds.has(e._id) && e['Activo'] !== false && e['Recebe SMS'] !== false).map(e => tel9(e['Telefone'])).filter(t => t.length === 9))];
      const curto = texto.length > 120 ? texto.slice(0, 117).replace(/\s+\S*$/, '') + '...' : texto;
      const msg = (esc['Nome'] || 'Escola') + ': ' + titulo + '. ' + curto + (texto.length > 120 ? ' Veja tudo ' + noGescolar(esc['Subdominio']) + '.' : '');
      for (let i = 0; i < nums.length; i += 50) { const r = await enviarSMS(nums.slice(i, i + 50), msg); if (r.ok) sms += r.numeros.length; }
      if (sms) await mudar('comunicado', id, { 'SMS Enviados': sms }).catch(() => {});
      else if (!nums.length) aviso = 'O comunicado foi publicado. Não há encarregados com telemóvel para receber o SMS.';
      else aviso = 'O comunicado foi publicado, mas o SMS falhou. Tente mais tarde.';
    }
  }
  res.json({ ok: true, id, sms, aviso });
}));
app.post('/comunicado-apagar', exigeDireccao, rota(async (req, res) => {
  const c = await daMinhaEscola('comunicado', String((req.body || {}).id || ''), req.escola);
  await apagar('comunicado', c._id);
  res.json({ ok: true });
}));
async function comunicadosPara(escola, turmaIds, cache) {
  const cs = cache.cs || (cache.cs = await procurarTodos('comunicado', daEscola(escola), 500));
  return cs.filter(c => !c['Turma'] || turmaIds.includes(c['Turma'])).map(c => comOut(c)).sort((a, b) => String(b.data || '').localeCompare(String(a.data || ''))).slice(0, 30);
}

// ============================================================
//  PROFESSORES E NOTAS (v4.5)
//  Bubble, data type novo Pauta: Escola (Escola) · Turma (text) · Disciplina (text) · Trimestre (number)
//                                · Grelha (text) · Publicado (yes/no) · Actualizado Por (text)
//  Uma pauta por turma × disciplina × trimestre. Grelha JSON:
//   { colunas:[{id:"acs1",tipo:"ACS",nome:"ACS 1"}, …, {id:"acp",tipo:"ACP",nome:"ACP"}], notas:{ <estudante>:{ acs1:14, acp:12.5 } } }
//  Média do trimestre (ensino geral em Moçambique): MT = (2 × MACS + ACP) / 3 ; sem ACP, MT = MACS
// ============================================================
function exigeProfessor(req, res, next) {
  const s = sessaoDo(req);
  if (!s) return erro(res, 401, 'A sessão terminou. Entre outra vez.');
  if (s.t !== 'portal' || s.p !== 'Professor' || !s.e) return erro(res, 403, 'Esta página é para professores.');
  req.sessao = s; req.escola = s.e; next();
}
const r1 = n => Math.round(n * 10) / 10;
const NIVEIS_DESC = { A: 'Adquirido', E: 'Em aquisição', N: 'Não adquirido' };
const ehESC = t => !!t && (t['Nivel'] === NIVEIS.ESC || t['Nivel'] === 'ESC');
function validarDescritiva(g, estIds) {
  const notas = {};
  for (const [est, l] of Object.entries((g && g.notas) || {})) {
    if (!estIds.has(est) || !l || typeof l !== 'object') continue;
    const n = String(l.n || '').toUpperCase(), o = txt(l.o, 400);
    if (n && !NIVEIS_DESC[n]) return 'Use A (adquirido), E (em aquisição) ou N (não adquirido).';
    if (n || o) notas[est] = Object.assign(n ? { n } : {}, o ? { o } : {});
  }
  return { modo: 'descritiva', notas };
}
// ---------- ensino superior e técnico (v5.5): pauta semestral ----------
//  Grelha { modo:'semestral', colunas:[{id,tipo:'F',nome}…, {id:'ex',tipo:'EX'}, {id:'rc',tipo:'RC'}], notas }
//  Frequência = média das avaliações F. Dispensado se freq ≥ dispensa (14); excluído se freq < admissão (10);
//  admitido vai a exame: Final = freq × (1 − p) + exame × p (p = peso do exame, 50% por defeito). A recorrência substitui o exame.
const ehSEM = t => !!t && [NIVEIS.SUP, NIVEIS.TEC, 'SUP', 'TEC'].includes(t['Nivel']);
const PERIODOS = t => ehSEM(t) ? 2 : 3;
function regrasPauta(esc) {
  const r = (esc && esc.regras) || {};
  const pe = Number(r.peso_exame); 
  return { aprovacao: Number(r.aprovacao || 10), dispensa: Number(r.dispensa || 14), admissao: Number(r.admissao || 10), peso_exame: pe > 0 && pe < 100 ? pe : 50 };
}
const PAUTA_SEM = () => ({ modo: 'semestral', colunas: [{ id: 't1', tipo: 'F', nome: 'Teste 1' }, { id: 't2', tipo: 'F', nome: 'Teste 2' }, { id: 'tr1', tipo: 'F', nome: 'Trabalho' },
  { id: 'ex', tipo: 'EX', nome: 'Exame' }, { id: 'rc', tipo: 'RC', nome: 'Recorrência' }], notas: {} });
function mediasSem(g, estId, R) {
  R = R || regrasPauta(null);
  const n = ((g && g.notas) || {})[estId] || {};
  const fs = (g.colunas || []).filter(c => c.tipo === 'F').map(c => n[c.id]).filter(v => typeof v === 'number');
  const freq = fs.length ? r1(fs.reduce((a, b) => a + b, 0) / fs.length) : null;
  const ex = typeof n.ex === 'number' ? n.ex : null, rc = typeof n.rc === 'number' ? n.rc : null;
  const out = { freq, exame: ex, recorrencia: rc, final: null, estado: 'sem', completa: false };
  if (freq === null) return Object.assign(out, { mt: null });
  if (Math.round(freq) >= R.dispensa) Object.assign(out, { estado: 'dispensado', final: freq, completa: true });
  else if (Math.round(freq) < R.admissao) Object.assign(out, { estado: 'excluido', final: freq, completa: true });
  else {
    const e = rc !== null ? rc : ex;
    if (e === null) out.estado = 'admitido';
    else {
      out.final = r1(freq * (1 - R.peso_exame / 100) + e * R.peso_exame / 100);
      out.estado = Math.round(out.final) >= R.aprovacao ? 'aprovado' : (rc !== null ? 'reprovado' : 'recorrencia');
      out.completa = out.estado !== 'recorrencia';
    }
  }
  out.mt = out.final;
  out.aprovado = out.estado === 'dispensado' || out.estado === 'aprovado';
  return out;
}
function validarSemestral(g, estIds) {
  if (!g || typeof g !== 'object') return 'Pauta inválida.';
  const vistos = new Set(['ex', 'rc']), colunas = [];
  for (const c of (Array.isArray(g.colunas) ? g.colunas : [])) {
    const id = String((c && c.id) || '').toLowerCase();
    if (c && (c.tipo === 'EX' || c.tipo === 'RC')) continue;
    if (!/^[a-z0-9]{1,10}$/.test(id) || vistos.has(id)) continue;
    vistos.add(id); colunas.push({ id, tipo: 'F', nome: txt(c.nome, 16) || 'Avaliação' });
  }
  if (!colunas.length) return 'A pauta precisa de pelo menos um teste ou trabalho.';
  if (colunas.length > 8) return 'No máximo 8 avaliações de frequência por semestre.';
  colunas.push({ id: 'ex', tipo: 'EX', nome: 'Exame' }, { id: 'rc', tipo: 'RC', nome: 'Recorrência' });
  const ids = new Set(colunas.map(c => c.id)), notas = {};
  for (const [est, linha] of Object.entries(g.notas || {})) {
    if (!estIds.has(est) || !linha || typeof linha !== 'object') continue;
    const l = {};
    for (const [cid, v] of Object.entries(linha)) {
      if (!ids.has(cid) || v === null || v === '' || v === undefined) continue;
      const n = Number(String(v).replace(',', '.'));
      if (!isFinite(n) || n < 0 || n > 20) return 'As notas vão de 0 a 20. Verifique a nota ' + v + '.';
      l[cid] = r1(n);
    }
    if (Object.keys(l).length) notas[est] = l;
  }
  return Object.assign({ modo: 'semestral', colunas, notas }, lerObs(g.obs, estIds));
}
function mediasPauta(g, estId, R) {
  if (g && g.modo === 'semestral') return mediasSem(g, estId, R);
  if (g && g.modo === 'descritiva') { const l = (g.notas || {})[estId] || {}; return { macs: null, acp: null, mt: null, completa: !!l.n, nivel: l.n || null }; }
  const n = ((g && g.notas) || {})[estId] || {};
  const acs = (g.colunas || []).filter(c => c.tipo === 'ACS').map(c => n[c.id]).filter(v => typeof v === 'number');
  const acpCol = (g.colunas || []).find(c => c.tipo === 'ACP');
  const acp = acpCol && typeof n[acpCol.id] === 'number' ? n[acpCol.id] : null;
  const macs = acs.length ? r1(acs.reduce((a, b) => a + b, 0) / acs.length) : null;
  let mt = null;
  if (macs !== null && acp !== null) mt = r1((2 * macs + acp) / 3);
  else if (macs !== null) mt = macs;
  else if (acp !== null) mt = acp;
  return { macs, acp, mt, completa: macs !== null && acp !== null };
}
function validarPauta(g, estIds) {
  if (!g || typeof g !== 'object') return 'Pauta inválida.';
  const cols = Array.isArray(g.colunas) ? g.colunas : [];
  const vistos = new Set(), colunas = [];
  for (const c of cols) {
    const id = String((c && c.id) || '').toLowerCase();
    if (!/^[a-z0-9]{1,10}$/.test(id) || vistos.has(id)) continue;
    const tipo = c.tipo === 'ACP' ? 'ACP' : 'ACS';
    if (tipo === 'ACP' && colunas.some(x => x.tipo === 'ACP')) continue;
    vistos.add(id); colunas.push({ id, tipo, nome: txt(c.nome, 16) || (tipo === 'ACP' ? 'ACP' : 'ACS') });
  }
  if (!colunas.length) return 'A pauta precisa de pelo menos uma coluna de avaliação.';
  if (colunas.length > 10) return 'No máximo 10 colunas por trimestre.';
  const notas = {}, ids = new Set(colunas.map(c => c.id));
  for (const [est, linha] of Object.entries(g.notas || {})) {
    if (!estIds.has(est) || !linha || typeof linha !== 'object') continue;
    const l = {};
    for (const [cid, v] of Object.entries(linha)) {
      if (!ids.has(cid) || v === null || v === '' || v === undefined) continue;
      const n = Number(String(v).replace(',', '.'));
      if (!isFinite(n) || n < 0 || n > 20) return 'As notas vão de 0 a 20. Verifique a nota ' + v + '.';
      l[cid] = r1(n);
    }
    if (Object.keys(l).length) notas[est] = l;
  }
  return Object.assign({ colunas, notas }, lerObs(g.obs, estIds));
}
// v5.9: apreciação de cada estudante (escrita pelo professor ou sugerida pela IA), guardada na grelha como obs { estudanteId: texto }
function lerObs(obs, estIds) {
  const o = {};
  if (obs && typeof obs === 'object') for (const [est, t] of Object.entries(obs)) { if (!estIds.has(est)) continue; const v = txt(t, 400); if (v) o[est] = v; }
  return Object.keys(o).length ? { obs: o } : {};
}
const PAUTA_NOVA = () => ({ colunas: [{ id: 'acs1', tipo: 'ACS', nome: 'ACS 1' }, { id: 'acs2', tipo: 'ACS', nome: 'ACS 2' }, { id: 'acs3', tipo: 'ACS', nome: 'ACS 3' }, { id: 'acp', tipo: 'ACP', nome: 'ACP' }], notas: {} });
const trimestreOk = t => [1, 2, 3].includes(Number(t));
async function pautaDe(escola, turma, disciplina, trimestre) {
  const l = await procurar('pauta', [{ key: 'Escola', constraint_type: 'equals', value: escola }, { key: 'Turma', constraint_type: 'equals', value: turma },
    { key: 'Disciplina', constraint_type: 'equals', value: disciplina }, { key: 'Trimestre', constraint_type: 'equals', value: Number(trimestre) }], 1);
  return l[0] || null;
}
// quem dá cada disciplina em cada turma: pelo horário; se a disciplina não tem professor no horário, pelas disciplinas do professor
// ---------- monodocência (v5.4) ----------
const TEMPO_DIA = 99;   // chamada única do dia, feita pelo professor titular
function titularActivo(t, profs) {
  const id = t && t['Professor Titular']; if (!id) return null;
  const p = profs.find(x => x._id === id);
  return p && p['Activo'] !== false ? id : null;
}
async function atribuicoes(escola) {
  const f = daEscola(escola);
  const [turmas, profs, hs] = await Promise.all([procurarTodos('turma', f), procurarTodos('professor', f), procurarTodos('horario', f)]);
  const pares = [];  // {turma, disciplina, professores:Set}
  for (const t of turmas.filter(x => x['Activa'] !== false)) {
    const g = lerGrelha((hs.find(h => h['Turma'] === t._id) || {})['Grelha']);
    const doHorario = {};
    if (g) for (const a of Object.values(g.aulas || {})) { if (!a.d) continue; (doHorario[a.d] = doHorario[a.d] || new Set()); if (a.p) doHorario[a.d].add(a.p); }
    const discs = new Set([...(t['Disciplinas'] || []), ...Object.keys(doHorario)]);
    for (const d of discs) {
      // horário manda; sem horário, o titular (primário/escolinha) dá todas; senão, quem tem a disciplina na ficha
      const tit = titularActivo(t, profs);
      let ps = doHorario[d] && doHorario[d].size ? doHorario[d] : tit ? new Set([tit]) : new Set(profs.filter(p => p['Activo'] !== false && (p['Disciplinas'] || []).includes(d)).map(p => p._id));
      pares.push({ turma: t._id, disciplina: d, professores: ps });
    }
  }
  return { turmas, profs, hs, pares };
}
async function dadosPauta(escola, turmaId, discId, tri) {
  const [turma, disc, regrasEsc] = await Promise.all([daMinhaEscola('turma', turmaId, escola), daMinhaEscola('disciplina', discId, escola), resumoEscola(escola)]);
  const ests = (await procurarTodos('estudante', [{ key: 'Escola', constraint_type: 'equals', value: escola }, { key: 'Turma', constraint_type: 'equals', value: turmaId }]))
    .filter(e => (e['Estado'] || 'activo') === 'activo').sort((a, b) => String(a['Nome'] || '').localeCompare(String(b['Nome'] || ''), 'pt'));
  const reg = await pautaDe(escola, turmaId, discId, tri);
  const desc = ehESC(turma), sem = ehSEM(turma);
  if (Number(tri) > PERIODOS(turma)) { const e = new Error('No ensino superior e técnico há só 2 semestres.'); e.publico = 400; throw e; }
  let grelha = (reg && lerGrelha(reg['Grelha'])) || (desc ? { modo: 'descritiva', notas: {} } : sem ? PAUTA_SEM() : PAUTA_NOVA());
  if (desc && grelha.modo !== 'descritiva') grelha = { modo: 'descritiva', notas: {} };
  if (sem && grelha.modo !== 'semestral') grelha = PAUTA_SEM();
  return { turma: { id: turma._id, nome: turma['Nome'] || '' }, disciplina: { id: disc._id, nome: disc['Nome'] || '', cor: disc['Cor'] || '#0A64DC', creditos: Number(disc['Creditos'] || 0) }, trimestre: Number(tri), modo: desc ? 'descritiva' : sem ? 'semestral' : 'numerica',
    estudantes: ests.map(e => ({ id: e._id, nome: e['Nome'] || '', numero: e['Numero'] || '' })), grelha, publicado: !!(reg && reg['Publicado']),
    actualizado: reg ? (reg['Modified Date'] || null) : null, actualizado_por: reg ? (reg['Actualizado Por'] || '') : '',
    regras: regrasPauta(regrasEsc), ia: !!OPENAI_KEY };
}
async function guardarPauta(req, res, quem) {
  const b = req.body || {};
  if (!trimestreOk(b.trimestre)) return erro(res, 400, 'Escolha o trimestre (1, 2 ou 3).');
  const d = await dadosPauta(req.escola, String(b.turma || ''), String(b.disciplina || ''), b.trimestre);
  const ids = new Set(d.estudantes.map(e => e.id));
  const g = d.modo === 'descritiva' ? validarDescritiva(b.grelha, ids) : d.modo === 'semestral' ? validarSemestral(b.grelha, ids) : validarPauta(b.grelha, ids);
  if (typeof g === 'string') return erro(res, 400, g);
  const campos = { 'Escola': req.escola, 'Turma': d.turma.id, 'Disciplina': d.disciplina.id, 'Trimestre': d.trimestre, 'Grelha': JSON.stringify(g), 'Publicado': !!b.publicado, 'Actualizado Por': quem };
  const reg = await pautaDe(req.escola, d.turma.id, d.disciplina.id, d.trimestre);
  if (reg) await mudar('pauta', reg._id, campos); else await criar('pauta', campos);
  const lancadas = Object.keys(g.notas).length;
  res.json({ ok: true, grelha: g, publicado: !!b.publicado, lancadas, total: d.estudantes.length });
}

// ============================================================
//  IA (v5.9) — apreciações de pauta sugeridas pela OpenAI
//  Render: OPENAI_API_KEY (obrigatório) · OPENAI_MODEL (opcional, por defeito gpt-4o-mini) · IA_LIMITE_MES (opcional, por defeito 100)
//  Bubble, campos novos em Escola: IA Mes (text) · IA Usos (number)  — contam os pedidos de cada escola no mês
//  Privacidade: à OpenAI só vão códigos (E1, E2…), notas, faltas e o nome da disciplina e da turma. Nunca nomes nem telefones.
//  A IA só escreve texto: as notas e as médias continuam a ser calculadas pelo servidor, sem IA.
// ============================================================
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const IA_LIMITE = Math.max(0, Number(process.env.IA_LIMITE_MES === undefined || process.env.IA_LIMITE_MES === '' ? 100 : process.env.IA_LIMITE_MES));
const iaMem = new Map();      // reserva, se os campos IA Mes / IA Usos ainda não existirem no Bubble
const iaAgora = new Set();    // um pedido de IA de cada vez por escola
async function iaReservar(escola) {
  const mes = hojeMZ().data.slice(0, 7);
  const e = await obter('escola', escola).catch(() => null);
  let n = e && e['IA Mes'] === mes ? Number(e['IA Usos'] || 0) : 0;
  const m = iaMem.get(escola); if (m && m.mes === mes) n = Math.max(n, m.n);
  if (n >= IA_LIMITE) throw pub('A escola já usou os ' + IA_LIMITE + ' pedidos de IA deste mês. O limite renova no dia 1.');
  return { mes, n };
}
async function iaContar(escola, u) {
  const n = u.n + 1; iaMem.set(escola, { mes: u.mes, n });
  await mudar('escola', escola, { 'IA Mes': u.mes, 'IA Usos': n }).catch(e => console.log('[ia] contador no Bubble:', String(e.message || e).slice(0, 160)));
  return n;
}
async function openaiJSON(sistema, utilizador, maxTokens) {
  if (!OPENAI_KEY) throw pub('A IA ainda não está ligada. Falta a chave OPENAI_API_KEY no Render.');
  let r, d;
  try {
    r = await fetch(process.env.OPENAI_URL || 'https://api.openai.com/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, response_format: { type: 'json_object' }, max_completion_tokens: maxTokens || 4000,
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: utilizador }] }) });
    d = await r.json().catch(() => null);
  } catch (e) { console.log('[ia] sem resposta:', e.message); throw pub('A IA demorou demasiado a responder. Tente de novo.'); }
  if (!r.ok) {
    console.log('[ia]', r.status, JSON.stringify(d).slice(0, 500));
    const m = String((d && d.error && d.error.message) || '');
    throw pub(r.status === 401 ? 'A chave da OpenAI (OPENAI_API_KEY) não é válida.' :
      r.status === 429 ? (/quota|billing|credit/i.test(m) ? 'A conta da OpenAI está sem saldo. Carregue créditos em platform.openai.com.' : 'A OpenAI está com muitos pedidos. Tente daqui a um minuto.') :
      (r.status === 404 || /model/i.test(m)) ? 'O modelo de IA «' + OPENAI_MODEL + '» não está disponível nesta conta (OPENAI_MODEL).' :
      'A IA não respondeu (' + r.status + '). Tente de novo.');
  }
  const t = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  try { return JSON.parse(t); } catch (e) { console.log('[ia] resposta não é JSON:', t.slice(0, 300)); throw pub('A IA respondeu num formato inesperado. Tente de novo.'); }
}
const IA_SISTEMA = 'És um professor experiente de uma escola em Moçambique e escreves as apreciações que acompanham a pauta.\n' +
  'Escreve em português de Moçambique (norma europeia: «trimestre», «actividade», «facto»).\n' +
  'Para cada estudante escreve 1 ou 2 frases, no máximo 220 caracteres, com base APENAS nos dados recebidos.\n' +
  'Regras:\n' +
  '- Tom profissional, construtivo e encorajador. Se há negativas ou muitas faltas, diz com clareza e indica uma coisa concreta a melhorar.\n' +
  '- Não inventes nada que não esteja nos dados (comportamento, família, participação, atitudes).\n' +
  '- Não escrevas nomes nem «o aluno», «a aluna» ou «a criança». Começa com um verbo ou expressão neutra (ex.: «Revela…», «Demonstra…», «Precisa de…», «Bom trimestre:…») e evita adjectivos com género (aplicado/a, esforçado/a).\n' +
  '- Não repitas números de notas; descreve o desempenho.\n' +
  '- Varia a forma das frases de estudante para estudante.\n' +
  'Responde só com JSON no formato {"apreciacoes":{"E1":"texto","E2":"texto"}}, com uma entrada para cada código recebido.';
const IA_ESCOLINHA = '\nNesta turma (escolinha/pré-escolar) as áreas são avaliadas como Adquirido, Em aquisição ou Não adquirido. Escreve para os pais, com linguagem simples e carinhosa, e sugere uma actividade simples para casa quando a área está em aquisição ou não adquirida.';
async function iaApreciacoes(req, res) {
  const b = req.body || {};
  if (!trimestreOk(b.trimestre)) return erro(res, 400, 'Escolha o trimestre.');
  if (iaAgora.has(req.escola)) return erro(res, 429, 'Já há um pedido de IA a ser preparado. Espere uns segundos.');
  iaAgora.add(req.escola);
  try {
    const d = await dadosPauta(req.escola, String(b.turma || ''), String(b.disciplina || ''), b.trimestre);
    const ids = new Set(d.estudantes.map(e => e.id));
    const g = d.modo === 'descritiva' ? validarDescritiva(b.grelha, ids) : d.modo === 'semestral' ? validarSemestral(b.grelha, ids) : validarPauta(b.grelha, ids);
    if (typeof g === 'string') return erro(res, 400, g);
    const R = d.regras, todas = b.todas === true;
    // faltas de cada estudante nesta disciplina (ou na chamada do dia), em todo o ano
    let faltas = {};
    try {
      const fx = await procurarTodos('falta', daEscola(req.escola).concat([{ key: 'Turma', constraint_type: 'equals', value: d.turma.id }]), 20000);
      fx.filter(x => (x['Tipo'] || 'F') === 'F' && (x['Disciplina'] === d.disciplina.id || Number(x['Tempo']) === TEMPO_DIA)).forEach(x => { faltas[x['Estudante']] = (faltas[x['Estudante']] || 0) + 1; });
    } catch (e) { faltas = {}; }
    const ESTADOS = { dispensado: 'dispensado do exame', excluido: 'excluído (frequência insuficiente)', admitido: 'admitido a exame', aprovado: 'aprovado', recorrencia: 'vai à recorrência', reprovado: 'reprovado' };
    const alvo = [];
    d.estudantes.forEach(e => {
      const ja = d.modo === 'descritiva' ? ((g.notas[e.id] || {}).o || '') : ((g.obs || {})[e.id] || '');
      if (ja && !todas) return;
      const l = g.notas[e.id] || {}, x = { faltas: faltas[e.id] || 0 };
      if (d.modo === 'descritiva') { if (!l.n) return; x.nivel = NIVEIS_DESC[l.n]; }
      else if (d.modo === 'semestral') {
        const m = mediasSem(g, e.id, R); if (m.freq === null) return;
        x.avaliacoes = g.colunas.filter(c => c.tipo === 'F' && typeof l[c.id] === 'number').map(c => c.nome + ': ' + l[c.id]);
        x.frequencia = m.freq; if (m.exame !== null) x.exame = m.exame; if (m.recorrencia !== null) x.recorrencia = m.recorrencia; if (m.final !== null) x.final = m.final; x.situacao = ESTADOS[m.estado] || m.estado;
      } else {
        const m = mediasPauta(g, e.id); if (m.mt === null) return;
        x.avaliacoes = g.colunas.filter(c => typeof l[c.id] === 'number').map(c => c.nome + ': ' + l[c.id]);
        x.media_trimestre = m.mt; x.situacao = !m.completa ? 'notas ainda parciais' : Math.round(m.mt) >= R.aprovacao ? 'positiva' : 'negativa';
      }
      alvo.push({ id: e.id, x });
    });
    if (!alvo.length) {
      const algum = d.estudantes.some(e => d.modo === 'descritiva' ? (g.notas[e.id] || {}).n : Object.keys(g.notas[e.id] || {}).length);
      return erro(res, 400, !algum ? 'Lance primeiro as notas: a IA escreve as apreciações a partir delas.' : 'Todos os estudantes com notas já têm apreciação. Use «Reescrever todas» para pedir novas.');
    }
    const uso = await iaReservar(req.escola);
    const periodo = d.modo === 'semestral' ? d.trimestre + 'º semestre' : d.trimestre + 'º trimestre';
    const sistema = IA_SISTEMA + (d.modo === 'descritiva' ? IA_ESCOLINHA : '');
    const out = {};
    for (let i = 0; i < alvo.length; i += 35) {     // turmas grandes vão em partes
      const parte = alvo.slice(i, i + 35);
      const dados = { disciplina: d.disciplina.nome, turma: d.turma.nome, periodo,
        escala: d.modo === 'descritiva' ? 'Adquirido / Em aquisição / Não adquirido' : 'notas de 0 a 20; positiva a partir de ' + R.aprovacao,
        estudantes: Object.fromEntries(parte.map((a, k) => ['E' + (i + k + 1), a.x])) };
      const j = await openaiJSON(sistema, JSON.stringify(dados), 150 * parte.length + 400);
      const ap = (j && j.apreciacoes) || {};
      parte.forEach((a, k) => { const t = txt(ap['E' + (i + k + 1)], 400); if (t) out[a.id] = t; });
    }
    if (!Object.keys(out).length) return erro(res, 502, 'A IA não devolveu apreciações. Tente de novo.');
    const usados = await iaContar(req.escola, uso);
    res.json({ ok: true, apreciacoes: out, pedidos: alvo.length, feitas: Object.keys(out).length, usados, limite: IA_LIMITE });
  } finally { iaAgora.delete(req.escola); }
}
app.post('/prof/ia-apreciacoes', exigeProfessor, rota(async (req, res) => {
  const b = req.body || {};
  if (!await podeLancar(req, String(b.turma || ''), String(b.disciplina || ''))) return erro(res, 403, 'Não dá esta disciplina nesta turma. Fale com a Direcção.');
  await iaApreciacoes(req, res);
}));
app.post('/ia-apreciacoes', exigeDireccao, rota(iaApreciacoes));

// ---------- professor ----------
async function podeLancar(req, turma, disc) {
  const a = await atribuicoes(req.escola);
  const par = a.pares.find(p => p.turma === turma && p.disciplina === disc);
  return !!(par && par.professores.has(req.sessao.u));
}
app.post('/prof/inicio', exigeProfessor, rota(async (req, res) => {
  const eu = await obter('professor', req.sessao.u);
  const [a, discs, escRaw, cs] = await Promise.all([atribuicoes(req.escola), procurarTodos('disciplina', daEscola(req.escola)), obter('escola', req.escola), procurarTodos('comunicado', daEscola(req.escola), 200)]);
  const DM = Object.fromEntries(discs.map(d => [d._id, d])), TM = Object.fromEntries(a.turmas.map(t => [t._id, t]));
  const meus = a.pares.filter(p => p.professores.has(req.sessao.u) && DM[p.disciplina] && TM[p.turma]);
  const ests = await procurarTodos('estudante', daEscola(req.escola));
  const aulas = [];
  for (const h of a.hs) {
    const g = lerGrelha(h['Grelha']); if (!g || !TM[h['Turma']]) continue;
    for (const [k, x] of Object.entries(g.aulas || {})) {
      if (x.p !== req.sessao.u) continue;
      const [dia, ti] = k.split('-').map(Number), t = g.tempos[ti]; if (!t) continue;
      aulas.push({ dia, tempo: ti, i: t.i, f: t.f, turma: TM[h['Turma']]['Nome'] || '', turma_id: h['Turma'], disciplina_id: x.d, disciplina: (DM[x.d] || {})['Nome'] || '', cor: (DM[x.d] || {})['Cor'] || '#0A64DC', sala: x.s || '' });
    }
  }
  aulas.sort((x, y) => x.dia - y.dia || x.i.localeCompare(y.i));
  const hoje = hojeMZ();
  const feitas = (await procurarTodos('chamada', daEscola(req.escola).concat([{ key: 'Data', constraint_type: 'equals', value: hoje.data }]))).map(c => c['Turma'] + '|' + c['Tempo']);
  aulas.forEach(x => { if (x.dia === hoje.dia) x.chamada = feitas.includes(x.turma_id + '|' + x.tempo); });
  res.json({ ok: true, hoje,
    eu: { nome: eu['Nome'] || '', telefone: eu['Telefone'] || '' },
    escola: { nome: escRaw['Nome'] || '', logotipo: escRaw['Logotipo'] || '', ano: escRaw['Ano Lectivo'] || '' },
    turmas: meus.map(p => ({ turma: p.turma, turma_nome: TM[p.turma]['Nome'] || '', esc: ehESC(TM[p.turma]), sem: ehSEM(TM[p.turma]), disciplina: p.disciplina, disciplina_nome: DM[p.disciplina]['Nome'] || '', cor: DM[p.disciplina]['Cor'] || '#0A64DC',
      estudantes: ests.filter(e => e['Turma'] === p.turma && (e['Estado'] || 'activo') === 'activo').length }))
      .sort((x, y) => x.turma_nome.localeCompare(y.turma_nome, 'pt') || x.disciplina_nome.localeCompare(y.disciplina_nome, 'pt')),
    aulas,
    titular: a.turmas.filter(t => t['Activa'] !== false && t['Professor Titular'] === req.sessao.u).map(t => ({ turma: t._id, turma_nome: t['Nome'] || '', esc: ehESC(t),
      estudantes: ests.filter(e => e['Turma'] === t._id && (e['Estado'] || 'activo') === 'activo').length, chamada: hoje.dia !== 0 && feitas.includes(t._id + '|' + TEMPO_DIA) }))
      .sort((x, y) => x.turma_nome.localeCompare(y.turma_nome, 'pt')),
    conducao: await praticasDoInstrutor(req.escola, req.sessao.u).catch(err => { console.error('[prof] condução', err.message); return null; }),
    codigo: (escRaw['Niveis'] || []).includes(NIVEIS.CON),
    comunicados: cs.filter(c => !c['Turma']).map(c => comOut(c)).sort((x, y) => String(y.data || '').localeCompare(String(x.data || ''))).slice(0, 10) });
}));
app.post('/prof/pauta', exigeProfessor, rota(async (req, res) => {
  const b = req.body || {};
  if (!trimestreOk(b.trimestre)) return erro(res, 400, 'Escolha o trimestre (1, 2 ou 3).');
  if (!await podeLancar(req, String(b.turma || ''), String(b.disciplina || ''))) return erro(res, 403, 'Não dá esta disciplina nesta turma. Fale com a Direcção.');
  res.json({ ok: true, pauta: await dadosPauta(req.escola, String(b.turma), String(b.disciplina), b.trimestre) });
}));
app.post('/prof/pauta-guardar', exigeProfessor, rota(async (req, res) => {
  const b = req.body || {};
  if (!await podeLancar(req, String(b.turma || ''), String(b.disciplina || ''))) return erro(res, 403, 'Não dá esta disciplina nesta turma. Fale com a Direcção.');
  const eu = await obter('professor', req.sessao.u).catch(() => null);
  await guardarPauta(req, res, 'Prof. ' + ((eu && eu['Nome']) || ''));
}));

// ---------- Direcção ----------
app.post('/pauta', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  if (!trimestreOk(b.trimestre)) return erro(res, 400, 'Escolha o trimestre (1, 2 ou 3).');
  res.json({ ok: true, pauta: await dadosPauta(req.escola, String(b.turma || ''), String(b.disciplina || ''), b.trimestre) });
}));
app.post('/pauta-guardar', exigeDireccao, rota(async (req, res) => {
  const eu = await obter('user', req.sessao.u).catch(() => null);
  await guardarPauta(req, res, (eu && eu['Nome Completo']) || 'Direcção');
}));
// resumo da turma no trimestre: estudantes × disciplinas com a média
app.post('/pautas-turma', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, tri = Number(b.trimestre);
  if (!trimestreOk(tri)) return erro(res, 400, 'Escolha o trimestre (1, 2 ou 3).');
  const turma = await daMinhaEscola('turma', String(b.turma || ''), req.escola);
  const f = daEscola(req.escola);
  const [a, discs, ests, pautas, esc] = await Promise.all([atribuicoes(req.escola), procurarTodos('disciplina', f),
    procurarTodos('estudante', f.concat([{ key: 'Turma', constraint_type: 'equals', value: turma._id }])),
    procurarTodos('pauta', f.concat([{ key: 'Turma', constraint_type: 'equals', value: turma._id }])), resumoEscola(req.escola)]);
  const DM = Object.fromEntries(discs.map(d => [d._id, d])), PM = Object.fromEntries(a.profs.map(p => [p._id, p['Nome']]));
  const lista = a.pares.filter(p => p.turma === turma._id && DM[p.disciplina]).map(p => {
    const reg = pautas.find(x => x['Disciplina'] === p.disciplina && Number(x['Trimestre']) === tri);
    return { id: p.disciplina, nome: DM[p.disciplina]['Nome'] || '', cor: DM[p.disciplina]['Cor'] || '#0A64DC', professores: [...p.professores].map(id => PM[id]).filter(Boolean),
      existe: !!reg, publicado: !!(reg && reg['Publicado']), grelha: reg ? lerGrelha(reg['Grelha']) : null, actualizado_por: reg ? (reg['Actualizado Por'] || '') : '' };
  }).sort((x, y) => x.nome.localeCompare(y.nome, 'pt'));
  const activos = ests.filter(e => (e['Estado'] || 'activo') === 'activo').sort((x, y) => String(x['Nome'] || '').localeCompare(String(y['Nome'] || ''), 'pt'));
  const R = regrasPauta(esc), semT = ehSEM(turma);
  if (tri > PERIODOS(turma)) return erro(res, 400, 'No ensino superior e técnico há só 2 semestres.');
  res.json({ ok: true, turma: { id: turma._id, nome: turma['Nome'] || '' }, trimestre: tri,
    regras: regrasPauta(esc),
    disciplinas: lista.map(d => ({ id: d.id, nome: d.nome, cor: d.cor, creditos: Number(DM[d.id]['Creditos'] || 0), professores: d.professores, existe: d.existe, publicado: d.publicado, actualizado_por: d.actualizado_por,
      lancadas: d.grelha ? Object.keys(d.grelha.notas || {}).length : 0 })),
    estudantes: activos.map(e => ({ id: e._id, nome: e['Nome'] || '', numero: e['Numero'] || '',
      medias: Object.fromEntries(lista.map(d => [d.id, d.grelha ? (d.grelha.modo === 'descritiva' ? (mediasPauta(d.grelha, e._id).nivel) : mediasPauta(d.grelha, e._id, R).mt) : null])),
      estados: semT ? Object.fromEntries(lista.map(d => [d.id, d.grelha && d.grelha.modo === 'semestral' ? mediasSem(d.grelha, e._id, R).estado : null])) : undefined })),
    modo: ehESC(turma) ? 'descritiva' : semT ? 'semestral' : 'numerica', periodos: PERIODOS(turma) });
}));
app.post('/pautas-publicar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, tri = Number(b.trimestre);
  if (!trimestreOk(tri)) return erro(res, 400, 'Escolha o trimestre (1, 2 ou 3).');
  const turma = await daMinhaEscola('turma', String(b.turma || ''), req.escola);
  const pautas = await procurarTodos('pauta', daEscola(req.escola).concat([{ key: 'Turma', constraint_type: 'equals', value: turma._id }]));
  let n = 0;
  for (const p of pautas.filter(x => Number(x['Trimestre']) === tri && !!x['Publicado'] !== !!b.publicado)) { await mudar('pauta', p._id, { 'Publicado': !!b.publicado }); n++; }
  res.json({ ok: true, alteradas: n });
}));

// ---------- portal: notas publicadas da turma do educando ----------
async function notasDoEstudante(escola, est, cache) {
  if (!est['Turma']) return [];
  const chave = 'p' + est['Turma'];
  const pautas = cache[chave] || (cache[chave] = await procurarTodos('pauta', daEscola(escola).concat([{ key: 'Turma', constraint_type: 'equals', value: est['Turma'] }])));
  if (!cache.discAll) cache.discAll = Object.fromEntries((await procurarTodos('disciplina', daEscola(escola))).map(d => [d._id, d]));
  const out = {};
  for (const p of pautas.filter(x => x['Publicado'])) {
    const g = lerGrelha(p['Grelha']), d = cache.discAll[p['Disciplina']]; if (!g || !d) continue;
    const linha = (g.notas || {})[est._id] || {};
    const m = mediasPauta(g, est._id);
    const o = out[d._id] = out[d._id] || { disciplina: d['Nome'] || '', cor: d['Cor'] || '#0A64DC', trimestres: {} };
    if (g.modo === 'semestral') {
      if (!cache.R) cache.R = regrasPauta(await resumoEscola(escola));
      const m2 = mediasSem(g, est._id, cache.R);
      o.semestral = true; o.creditos = Number(d['Creditos'] || 0);
      o.trimestres[Number(p['Trimestre'])] = { semestral: true, colunas: g.colunas.filter(c => c.tipo === 'F').map(c => ({ nome: c.nome, nota: typeof linha[c.id] === 'number' ? linha[c.id] : null })),
        freq: m2.freq, exame: m2.exame, recorrencia: m2.recorrencia, final: m2.final, estado: m2.estado, aprovado: !!m2.aprovado, mt: m2.final, completa: m2.completa, obs: (g.obs || {})[est._id] || '' };
      continue;
    }
    if (g.modo === 'descritiva') { o.descritiva = true; o.trimestres[Number(p['Trimestre'])] = { descritiva: true, nivel: linha.n || null, nivel_nome: NIVEIS_DESC[linha.n] || '', obs: linha.o || '' }; continue; }
    o.trimestres[Number(p['Trimestre'])] = { colunas: g.colunas.map(c => ({ nome: c.nome, tipo: c.tipo, nota: typeof linha[c.id] === 'number' ? linha[c.id] : null })), macs: m.macs, acp: m.acp, mt: m.mt, completa: m.completa, obs: (g.obs || {})[est._id] || '' };
  }
  return Object.values(out).sort((a, b) => a.disciplina.localeCompare(b.disciplina, 'pt'));
}

// ============================================================
//  PRESENÇAS E FALTAS (v4.6)
//  Bubble, data types novos:
//   Chamada: Escola (Escola) · Turma (text) · Data (text AAAA-MM-DD) · Tempo (number) · Disciplina (text) · Professor (text) · Sumario (text) · Feita Por (text)
//   Falta:   Escola (Escola) · Turma (text) · Estudante (text) · Data (text) · Tempo (number) · Disciplina (text) · Tipo (text: F falta, A atraso, J justificada)
//            · Chamada (text) · SMS (yes/no)
//  Só os ausentes e atrasados criam registo em Falta. Hora de Moçambique (UTC+2).
// ============================================================
function hojeMZ(desvioDias) {
  const d = new Date(Date.now() + 2 * 3600e3 + (desvioDias || 0) * 864e5);
  return { data: d.toISOString().slice(0, 10), dia: d.getUTCDay() };
}
function diaDaSemana(data) { const d = new Date(data + 'T12:00:00Z'); return isNaN(d) ? -1 : d.getUTCDay(); }
const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && diaDaSemana(d) >= 0;
const dmCurto = d => d.slice(8, 10) + '/' + d.slice(5, 7);
// a aula (turma, data, tempo) existe no horário? devolve {disciplina, professor, i, f}
async function aulaDoHorario(escola, turmaId, data, tempo) {
  if (Number(tempo) === TEMPO_DIA) {
    if (diaDaSemana(data) === 0) return null;   // domingo
    const t = await obter('turma', turmaId).catch(() => null);
    if (!t || t['Escola'] !== escola || !t['Professor Titular']) return null;
    return { disciplina: '', professor: t['Professor Titular'], i: '', f: '', dia: true };
  }
  const h = (await procurar('horario', [{ key: 'Escola', constraint_type: 'equals', value: escola }, { key: 'Turma', constraint_type: 'equals', value: turmaId }], 1))[0];
  const g = h && lerGrelha(h['Grelha']); if (!g) return null;
  const a = (g.aulas || {})[diaDaSemana(data) + '-' + Number(tempo)], t = (g.tempos || [])[Number(tempo)];
  return a && t ? { disciplina: a.d, professor: a.p, i: t.i, f: t.f } : null;
}
async function chamadaDe(escola, turma, data, tempo) {
  return (await procurar('chamada', [{ key: 'Escola', constraint_type: 'equals', value: escola }, { key: 'Turma', constraint_type: 'equals', value: turma },
    { key: 'Data', constraint_type: 'equals', value: data }, { key: 'Tempo', constraint_type: 'equals', value: Number(tempo) }], 1))[0] || null;
}
async function dadosChamada(escola, turmaId, data, tempo) {
  const turma = await daMinhaEscola('turma', turmaId, escola);
  const aula = await aulaDoHorario(escola, turmaId, data, tempo);
  if (!aula) { const e = new Error(Number(tempo) === TEMPO_DIA ? 'Esta turma não tem professor titular, ou o dia é domingo.' : 'Não há aula desta turma nesse dia e tempo no horário.'); e.publico = 404; throw e; }
  const [disc, ests, ch] = await Promise.all([aula.dia ? null : obter('disciplina', aula.disciplina).catch(() => null),
    procurarTodos('estudante', [{ key: 'Escola', constraint_type: 'equals', value: escola }, { key: 'Turma', constraint_type: 'equals', value: turmaId }]), chamadaDe(escola, turmaId, data, tempo)]);
  const faltas = ch ? await procurarTodos('falta', [{ key: 'Escola', constraint_type: 'equals', value: escola }, { key: 'Chamada', constraint_type: 'equals', value: ch._id }]) : [];
  return { turma: { id: turma._id, nome: turma['Nome'] || '' }, data, tempo: Number(tempo), i: aula.i, f: aula.f, professor: aula.professor,
    dia: !!aula.dia, disciplina: { id: aula.disciplina, nome: aula.dia ? 'Chamada do dia' : ((disc && disc['Nome']) || ''), cor: (disc && disc['Cor']) || '#0A64DC' },
    estudantes: ests.filter(e => (e['Estado'] || 'activo') === 'activo').sort((a, b) => String(a['Nome'] || '').localeCompare(String(b['Nome'] || ''), 'pt')).map(e => ({ id: e._id, nome: e['Nome'] || '', numero: e['Numero'] || '' })),
    feita: !!ch, chamada_id: ch ? ch._id : null, sumario: ch ? (ch['Sumario'] || '') : '', feita_por: ch ? (ch['Feita Por'] || '') : '',
    marcas: Object.fromEntries(faltas.map(f => [f['Estudante'], f['Tipo'] || 'F'])) };
}
async function guardarChamada(req, res, quem, podeJustificar) {
  const b = req.body || {};
  const d = await dadosChamada(req.escola, String(b.turma || ''), String(b.data || ''), b.tempo);
  const ids = new Set(d.estudantes.map(e => e.id)), novas = {};
  for (const [est, t] of Object.entries(b.marcas || {})) {
    if (!ids.has(est)) continue;
    const tipo = String(t || '').toUpperCase();
    if (tipo === 'F' || tipo === 'A' || (tipo === 'J' && (podeJustificar || d.marcas[est] === 'J'))) novas[est] = tipo;
  }
  // um professor não pode tirar uma justificação que a Direcção deu
  if (!podeJustificar) for (const [est, t] of Object.entries(d.marcas)) if (t === 'J' && !novas[est]) novas[est] = 'J';
  const campos = { 'Escola': req.escola, 'Turma': d.turma.id, 'Data': d.data, 'Tempo': d.tempo, 'Disciplina': d.disciplina.id, 'Professor': d.professor || '', 'Sumario': txt(b.sumario, 1000), 'Feita Por': quem };
  let chId = d.chamada_id;
  if (chId) await mudar('chamada', chId, campos); else chId = await criar('chamada', campos);
  const existentes = await procurarTodos('falta', [{ key: 'Escola', constraint_type: 'equals', value: req.escola }, { key: 'Chamada', constraint_type: 'equals', value: chId }]);
  const avisar = [];
  for (const f of existentes) {
    const n = novas[f['Estudante']];
    if (!n) await apagar('falta', f._id);
    else if (n !== f['Tipo']) await mudar('falta', f._id, { 'Tipo': n });
    if (n === 'F' && !f['SMS']) avisar.push(f);
  }
  for (const [est, tipo] of Object.entries(novas)) {
    if (existentes.some(f => f['Estudante'] === est)) continue;
    const id = await criar('falta', { 'Escola': req.escola, 'Turma': d.turma.id, 'Estudante': est, 'Data': d.data, 'Tempo': d.tempo, 'Disciplina': d.disciplina.id, 'Tipo': tipo, 'Chamada': chId, 'SMS': false });
    if (tipo === 'F') avisar.push({ _id: id, 'Estudante': est });
  }
  let sms = 0;
  if (b.sms && avisar.length && d.data === hojeMZ().data) {
    const esc = await obter('escola', req.escola);
    for (const f of avisar) {
      const est = await obter('estudante', f['Estudante']).catch(() => null);
      const enc = est && est['Encarregado'] ? await obter('encarregado', est['Encarregado']).catch(() => null) : null;
      if (!enc || enc['Recebe SMS'] === false || tel9(enc['Telefone']).length !== 9) continue;
      const r = await enviarSMS([enc['Telefone']], (esc['Nome'] || 'Escola') + ': ' + est['Nome'] + (d.dia ? ' faltou hoje as aulas' : ' faltou hoje a ' + d.disciplina.nome + ' (' + d.i + ')') + '. Se a falta tiver justificacao, contacte a escola.');
      if (r.ok) { sms++; await mudar('falta', f._id, { 'SMS': true }).catch(() => {}); }
    }
  }
  const cont = { F: 0, A: 0, J: 0 }; Object.values(novas).forEach(t => cont[t]++);
  res.json({ ok: true, chamada: chId, presentes: d.estudantes.length - cont.F - cont.J, faltas: cont.F, atrasos: cont.A, justificadas: cont.J, sms });
}

// ---------- professor ----------
app.post('/prof/chamada', exigeProfessor, rota(async (req, res) => {
  const b = req.body || {};
  if (!dataOk(b.data)) return erro(res, 400, 'Data inválida.');
  const d = await dadosChamada(req.escola, String(b.turma || ''), b.data, b.tempo);
  if (d.professor !== req.sessao.u) return erro(res, 403, d.dia ? 'Não é o professor titular desta turma.' : 'Esta aula não é sua no horário.');
  res.json({ ok: true, chamada: d });
}));
app.post('/prof/chamada-guardar', exigeProfessor, rota(async (req, res) => {
  const b = req.body || {};
  if (!dataOk(b.data)) return erro(res, 400, 'Data inválida.');
  if (b.data > hojeMZ().data) return erro(res, 400, 'Não pode fazer a chamada de um dia que ainda não chegou.');
  if (b.data < hojeMZ(-14).data) return erro(res, 400, 'Só pode corrigir chamadas dos últimos 14 dias. Para datas anteriores, fale com a Direcção.');
  const aula = await aulaDoHorario(req.escola, String(b.turma || ''), b.data, b.tempo);
  if (!aula || aula.professor !== req.sessao.u) return erro(res, 403, Number(b.tempo) === TEMPO_DIA ? 'Não é o professor titular desta turma.' : 'Esta aula não é sua no horário.');
  const eu = await obter('professor', req.sessao.u).catch(() => null);
  await guardarChamada(req, res, 'Prof. ' + ((eu && eu['Nome']) || ''), false);
}));

// ---------- Direcção ----------
app.post('/chamadas-dia', exigeDireccao, rota(async (req, res) => {
  const data = dataOk((req.body || {}).data) ? req.body.data : hojeMZ().data, dia = diaDaSemana(data), f = daEscola(req.escola);
  const [turmas, hs, discs, profs, chs, fs] = await Promise.all([procurarTodos('turma', f), procurarTodos('horario', f), procurarTodos('disciplina', f), procurarTodos('professor', f),
    procurarTodos('chamada', f.concat([{ key: 'Data', constraint_type: 'equals', value: data }])), procurarTodos('falta', f.concat([{ key: 'Data', constraint_type: 'equals', value: data }]))]);
  const TM = Object.fromEntries(turmas.filter(t => t['Activa'] !== false).map(t => [t._id, t])), DM = Object.fromEntries(discs.map(d => [d._id, d])), PM = Object.fromEntries(profs.map(p => [p._id, p['Nome']]));
  const aulas = [];
  for (const h of hs) {
    const g = lerGrelha(h['Grelha']); if (!g || !TM[h['Turma']]) continue;
    for (const [k, a] of Object.entries(g.aulas || {})) {
      const [d, ti] = k.split('-').map(Number); if (d !== dia || !g.tempos[ti]) continue;
      const ch = chs.find(c => c['Turma'] === h['Turma'] && Number(c['Tempo']) === ti);
      const fx = ch ? fs.filter(x => x['Chamada'] === ch._id) : [];
      aulas.push({ turma: h['Turma'], turma_nome: TM[h['Turma']]['Nome'] || '', tempo: ti, i: g.tempos[ti].i, f: g.tempos[ti].f, disciplina: (DM[a.d] || {})['Nome'] || '', cor: (DM[a.d] || {})['Cor'] || '#0A64DC',
        professor: PM[a.p] || '', feita: !!ch, faltas: fx.filter(x => x['Tipo'] === 'F').length, atrasos: fx.filter(x => x['Tipo'] === 'A').length, sumario: ch ? (ch['Sumario'] || '') : '' });
    }
  }
  if (dia !== 0) for (const t of Object.values(TM)) {
    if (!t['Professor Titular']) continue;
    const ch = chs.find(c => c['Turma'] === t._id && Number(c['Tempo']) === TEMPO_DIA);
    const fx = ch ? fs.filter(x => x['Chamada'] === ch._id) : [];
    aulas.push({ turma: t._id, turma_nome: t['Nome'] || '', tempo: TEMPO_DIA, dia: true, i: '', f: '', disciplina: 'Chamada do dia', cor: '#5B6B82',
      professor: PM[t['Professor Titular']] || '', feita: !!ch, faltas: fx.filter(x => x['Tipo'] === 'F').length, atrasos: fx.filter(x => x['Tipo'] === 'A').length, sumario: ch ? (ch['Sumario'] || '') : '' });
  }
  aulas.sort((a, b) => a.i.localeCompare(b.i) || a.turma_nome.localeCompare(b.turma_nome, 'pt'));
  res.json({ ok: true, data, dia, aulas });
}));
app.post('/chamada', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  if (!dataOk(b.data)) return erro(res, 400, 'Data inválida.');
  res.json({ ok: true, chamada: await dadosChamada(req.escola, String(b.turma || ''), b.data, b.tempo) });
}));
app.post('/chamada-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  if (!dataOk(b.data) || b.data > hojeMZ().data) return erro(res, 400, 'Data inválida.');
  const eu = await obter('user', req.sessao.u).catch(() => null);
  await guardarChamada(req, res, (eu && eu['Nome Completo']) || 'Direcção', true);
}));
// resumo de assiduidade da turma num período
app.post('/presencas', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const turma = await daMinhaEscola('turma', String(b.turma || ''), req.escola);
  const de = dataOk(b.de) ? b.de : hojeMZ(-30).data, ate = dataOk(b.ate) ? b.ate : hojeMZ().data;
  const f = daEscola(req.escola).concat([{ key: 'Turma', constraint_type: 'equals', value: turma._id }]);
  const [ests, chs, fs, discs] = await Promise.all([procurarTodos('estudante', f), procurarTodos('chamada', f, 5000), procurarTodos('falta', f, 5000), procurarTodos('disciplina', daEscola(req.escola))]);
  const DM = Object.fromEntries(discs.map(d => [d._id, d['Nome']]));
  const ch = chs.filter(c => c['Data'] >= de && c['Data'] <= ate), fx = fs.filter(x => x['Data'] >= de && x['Data'] <= ate);
  const aulas = ch.length;
  res.json({ ok: true, turma: { id: turma._id, nome: turma['Nome'] || '' }, de, ate, aulas,
    estudantes: ests.filter(e => (e['Estado'] || 'activo') === 'activo').sort((a, b) => String(a['Nome'] || '').localeCompare(String(b['Nome'] || ''), 'pt')).map(e => {
      const m = fx.filter(x => x['Estudante'] === e._id);
      const F = m.filter(x => x['Tipo'] === 'F').length, J = m.filter(x => x['Tipo'] === 'J').length, A = m.filter(x => x['Tipo'] === 'A').length;
      return { id: e._id, nome: e['Nome'] || '', numero: e['Numero'] || '', faltas: F, justificadas: J, atrasos: A, presenca: aulas ? Math.round((aulas - F - J) * 100 / aulas) : null,
        lista: m.sort((a, b) => String(b['Data']).localeCompare(String(a['Data'])) || Number(b['Tempo']) - Number(a['Tempo'])).map(x => ({ id: x._id, data: x['Data'], tempo: Number(x['Tempo']), disciplina: Number(x['Tempo']) === TEMPO_DIA ? 'Chamada do dia' : (DM[x['Disciplina']] || ''), tipo: x['Tipo'] || 'F' })) };
    }) });
}));
app.post('/falta-justificar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const x = await daMinhaEscola('falta', String(b.id || ''), req.escola);
  if (x['Tipo'] === 'A') return erro(res, 400, 'Os atrasos não se justificam.');
  await mudar('falta', x._id, { 'Tipo': b.justificar ? 'J' : 'F' });
  res.json({ ok: true, tipo: b.justificar ? 'J' : 'F' });
}));

// ---------- portal: faltas do educando ----------
async function faltasDoEstudante(escola, estId, cache) {
  if (!cache.discAll) cache.discAll = Object.fromEntries((await procurarTodos('disciplina', daEscola(escola))).map(d => [d._id, d]));
  const fs = await procurarTodos('falta', [{ key: 'Escola', constraint_type: 'equals', value: escola }, { key: 'Estudante', constraint_type: 'equals', value: estId }], 1000);
  return fs.map(x => ({ data: x['Data'], tempo: Number(x['Tempo']), disciplina: Number(x['Tempo']) === TEMPO_DIA ? 'Chamada do dia' : ((cache.discAll[x['Disciplina']] || {})['Nome'] || ''), tipo: x['Tipo'] || 'F' }))
    .sort((a, b) => String(b.data).localeCompare(String(a.data)) || b.tempo - a.tempo);
}

// ============================================================
//  PAINEL DA DIRECÇÃO COM NÚMEROS REAIS (v4.7)
//  POST /painel-indicadores   (guarda 60 s em memória por escola; { fresco:true } força)
// ============================================================
const cachePainel = new Map();
app.post('/painel-indicadores', exigeDireccao, rota(async (req, res) => {
  const c = cachePainel.get(req.escola);
  if (c && !(req.body || {}).fresco && Date.now() - c.t < 60e3) return res.json(c.d);
  const f = daEscola(req.escola), hoje = hojeMZ(), mes = hoje.data.slice(0, 7);
  // uma tabela em falta no Bubble não deita o painel abaixo: conta como vazia e avisa
  const faltam = new Set();
  const seg = (p, t, vazio) => p.catch(e => { console.error('[painel] ' + t + ':', e.message); faltam.add(e.tabela || nomeTabela(t)); return vazio || []; });
  const [escola, ests, turmas, props, pags, chsHoje, faltas, pautas, a, discs] = await Promise.all([
    resumoEscola(req.escola), seg(procurarTodos('estudante', f), 'estudante'), seg(procurarTodos('turma', f), 'turma'), seg(procurarTodos('propina', f, 20000), 'propina'), seg(procurarTodos('pagamento', f, 20000), 'pagamento'),
    seg(procurarTodos('chamada', f.concat([{ key: 'Data', constraint_type: 'equals', value: hoje.data }])), 'chamada'), seg(procurarTodos('falta', f, 20000), 'falta'), seg(procurarTodos('pauta', f, 5000), 'pauta'),
    seg(atribuicoes(req.escola), 'horario', { turmas: [], profs: [], hs: [], pares: [] }), seg(procurarTodos('disciplina', f), 'disciplina')]);
  const regras = (escola && escola.regras) || {}, ap = Number(regras.aprovacao || 10);
  const activos = ests.filter(e => (e['Estado'] || 'activo') === 'activo'), EM = Object.fromEntries(ests.map(e => [e._id, e]));
  const TM = Object.fromEntries(turmas.filter(t => t['Activa'] !== false).map(t => [t._id, t])), DM = Object.fromEntries(discs.map(d => [d._id, d]));
  const PM = Object.fromEntries(a.profs.map(p => [p._id, p['Nome'] || '']));
  const dataMZ = iso => iso ? new Date(new Date(iso).getTime() + 2 * 3600e3).toISOString().slice(0, 10) : '';

  // --- dinheiro ---
  const pagos = pags.filter(p => p['Estado'] === 'pago');
  const meses = []; for (let k = 5; k >= 0; k--) { const d = new Date(hoje.data + 'T12:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); meses.push(d.toISOString().slice(0, 7)); }
  const serie = meses.map(m => ({ mes: m, valor: pagos.filter(p => dataMZ(p['Pago Em']).slice(0, 7) === m).reduce((x, p) => x + Number(p['Valor'] || 0), 0) }));
  const doMes = pagos.filter(p => dataMZ(p['Pago Em']).slice(0, 7) === mes);
  const porMetodo = {}; doMes.forEach(p => { const k = p['Metodo'] || 'outro'; porMetodo[k] = (porMetodo[k] || 0) + Number(p['Valor'] || 0); });
  const divida = {}; let atraso = 0, multas = 0, aVencer = 0;
  for (const p of props) {
    if (p['Estado'] === 'anulada' || p['Estado'] === 'paga' || !EM[p['Estudante']] || (EM[p['Estudante']]['Estado'] || 'activo') !== 'activo') continue;
    const cp = calcPropina(p, regras);
    if (cp.estado === 'atrasada') { atraso += cp.total; multas += cp.multa; divida[p['Estudante']] = (divida[p['Estudante']] || 0) + cp.total; }
    else if (String(p['Vencimento'] || '').slice(0, 7) === mes) aVencer += cp.total;
  }
  const devedores = Object.entries(divida).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([id, v]) => ({ id, nome: EM[id]['Nome'] || '', numero: EM[id]['Numero'] || '', turma: (TM[EM[id]['Turma']] || {})['Nome'] || '', divida: v }));
  const ultimos = pagos.slice().sort((x, y) => String(y['Pago Em'] || '').localeCompare(String(x['Pago Em'] || ''))).slice(0, 5)
    .map(p => ({ id: p._id, documento: p['Documento'] || '', data: p['Pago Em'], valor: Number(p['Valor'] || 0), metodo: p['Metodo'] || '', estudante: (EM[p['Estudante']] || {})['Nome'] || '' }));

  // --- hoje: aulas e chamadas ---
  const aulasHoje = [];
  for (const h of a.hs) {
    const g = lerGrelha(h['Grelha']); if (!g || !TM[h['Turma']]) continue;
    for (const [k, x] of Object.entries(g.aulas || {})) {
      const [d, ti] = k.split('-').map(Number); if (d !== hoje.dia || !g.tempos[ti]) continue;
      aulasHoje.push({ turma: TM[h['Turma']]['Nome'] || '', turma_id: h['Turma'], tempo: ti, i: g.tempos[ti].i, f: g.tempos[ti].f, disciplina: (DM[x.d] || {})['Nome'] || '', professor: PM[x.p] || '',
        feita: chsHoje.some(c => c['Turma'] === h['Turma'] && Number(c['Tempo']) === ti) });
    }
  }
  if (hoje.dia >= 1 && hoje.dia <= 5) for (const t of a.turmas) {
    if (t['Activa'] === false || !titularActivo(t, a.profs)) continue;
    aulasHoje.push({ turma: t['Nome'] || '', turma_id: t._id, tempo: TEMPO_DIA, dia: true, i: '08:00', f: '', disciplina: 'Chamada do dia', professor: PM[t['Professor Titular']] || '',
      feita: chsHoje.some(c => c['Turma'] === t._id && Number(c['Tempo']) === TEMPO_DIA) });
  }
  aulasHoje.sort((x, y) => x.i.localeCompare(y.i));
  const agora = new Date(Date.now() + 2 * 3600e3).toISOString().slice(11, 16);
  const atrasadas = aulasHoje.filter(x => !x.feita && x.i <= agora);

  // --- faltas ---
  const d7 = hojeMZ(-6).data, d30 = hojeMZ(-29).data;
  const fx = faltas.filter(x => EM[x['Estudante']]);
  const porDia = []; for (let k = 6; k >= 0; k--) { const d = hojeMZ(-k).data; porDia.push({ data: d, faltas: fx.filter(x => x['Data'] === d && x['Tipo'] === 'F').length }); }
  const cont30 = {}; fx.filter(x => x['Data'] >= d30 && x['Tipo'] === 'F').forEach(x => { cont30[x['Estudante']] = (cont30[x['Estudante']] || 0) + 1; });
  const maisFaltas = Object.entries(cont30).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([id, n]) => ({ id, nome: EM[id]['Nome'] || '', turma: (TM[EM[id]['Turma']] || {})['Nome'] || '', faltas: n }));

  // --- notas do trimestre ---
  const tri = (m => m <= 5 ? 1 : m <= 8 ? 2 : 3)(Number(hoje.data.slice(5, 7)));
  const pt = pautas.filter(p => Number(p['Trimestre']) === tri);
  const pares = a.pares.filter(p => TM[p.turma] && DM[p.disciplina]);
  const semNotas = {}; let comNotas = 0;
  for (const p of pares) {
    const reg = pt.find(x => x['Turma'] === p.turma && x['Disciplina'] === p.disciplina);
    const g = reg && lerGrelha(reg['Grelha']);
    if (g && Object.keys(g.notas || {}).length) { comNotas++; continue; }
    for (const pid of (p.professores.size ? p.professores : new Set(['']))) {
      const k = pid || 'sem'; (semNotas[k] = semNotas[k] || { professor: PM[pid] || 'Sem professor', pendentes: [] }).pendentes.push((DM[p.disciplina]['Nome'] || '') + ' · ' + (TM[p.turma]['Nome'] || ''));
    }
  }
  const aproveitamento = Object.values(TM).map(t => {
    let pos = 0, n = 0;
    for (const reg of pt.filter(x => x['Turma'] === t._id)) { const g = lerGrelha(reg['Grelha']); if (!g) continue; for (const eid of Object.keys(g.notas || {})) { const m = mediasPauta(g, eid); if (m.mt == null) continue; n++; if (Math.round(m.mt) >= ap) pos++; } }
    return { turma: t['Nome'] || '', notas: n, positivas: pos, pct: n ? Math.round(pos * 100 / n) : null };
  }).sort((x, y) => x.turma.localeCompare(y.turma, 'pt'));

  const d = { ok: true, faltam: [...faltam], gerado: new Date().toISOString(), hoje: hoje.data, dia: hoje.dia, mes,
    dinheiro: { recebido_mes: doMes.reduce((x, p) => x + Number(p['Valor'] || 0), 0), recebido_hoje: pagos.filter(p => dataMZ(p['Pago Em']) === hoje.data).reduce((x, p) => x + Number(p['Valor'] || 0), 0),
      pagamentos_mes: doMes.length, em_atraso: atraso, multas, a_vencer: aVencer, estudantes_atraso: Object.keys(divida).length, por_metodo: porMetodo, serie, devedores, ultimos },
    hoje_aulas: { total: aulasHoje.length, feitas: aulasHoje.filter(x => x.feita).length, por_fazer: atrasadas.slice(0, 8), faltas: fx.filter(x => x['Data'] === hoje.data && x['Tipo'] === 'F').length },
    faltas: { semana: fx.filter(x => x['Data'] >= d7 && x['Tipo'] === 'F').length, mes: fx.filter(x => x['Data'] >= d30 && x['Tipo'] === 'F').length, por_dia: porDia, mais_faltas: maisFaltas },
    notas: { trimestre: tri, pares: pares.length, com_notas: comNotas,
      publicadas: pt.filter(x => x['Publicado']).length, aproveitamento, sem_notas: Object.values(semNotas).sort((x, y) => y.pendentes.length - x.pendentes.length).slice(0, 8) },
    estudantes: activos.length };
  if ((escola && escola.niveis || []).includes('CON')) {
    const [vs, aps, ins] = await Promise.all([seg(procurarTodos('viatura', f), 'viatura'), seg(procurarTodos('aulapratica', f, 20000), 'aulapratica'), seg(procurarTodos('inscricaoconducao', f), 'inscricaoconducao')]);
    const hojeA = aps.filter(x => x['Data'] === hoje.data && x['Estado'] !== 'cancelada');
    const alertas = [];
    vs.filter(v => v['Activa'] !== false).forEach(v => { for (const [k, n] of [['Inspecao Ate', 'Inspecção'], ['Seguro Ate', 'Seguro']]) { const dd = diasAte(v[k]); if (dd !== null && dd <= 30) alertas.push({ matricula: v['Matricula'] || '', tipo: n, dias: dd, ate: v[k] }); } });
    const activas = ins.filter(i => (i['Estado'] || 'activa') === 'activa');
    d.conducao = { aulas_hoje: hojeA.length, feitas_hoje: hojeA.filter(x => x['Estado'] === 'feita').length, instruendos: activas.length,
      sem_aula: activas.filter(i => !aps.some(x => x['Inscricao'] === i._id && x['Estado'] === 'marcada' && x['Data'] >= hoje.data)).length,
      alertas: alertas.sort((x, y) => x.dias - y.dias).slice(0, 8) };
  }
  cachePainel.set(req.escola, { t: Date.now(), d });
  res.json(d);
}));

// ============================================================
//  ASSINATURA DO GESCOLAR E ÁREA DA PLATAFORMA (v4.8)
//  Bubble:
//   Escola: campo novo  Valida Ate (date)
//   Subscricao: Escola (Escola) · Plano (text) · Meses (number) · Valor (number) · Metodo (text) · Telefone (text) · Estado (text)
//               · Referencia (text) · Transacao (text) · Raw (text) · Pago Em (date) · Valida Ate (date)
//   Transferencia: Escola (Escola) · Valor (number) · Data (date) · Referencia (text) · Metodo (text) · Notas (text) · Feita Por (text)
//  Render: PLATAFORMA_EMAILS (emails com acesso à área da plataforma, separados por vírgulas)
//          TAXA_PROPINAS_PCT (opcional, % que o Gescolar retém de cada pagamento online; por defeito 7)
//          PRECO_ESSENCIAL, PRECO_PRO (opcionais, MT por mês; por defeito 4900 e 12500)
// ============================================================
const PRECOS = { Essencial: Number(process.env.PRECO_ESSENCIAL || 4900), Pro: Number(process.env.PRECO_PRO || 12500), Rede: 0 };
const LIMITES = { Essencial: 300, Pro: 1000, Rede: 0 };
// v5.13: pagar vários meses de uma vez tem desconto (por defeito 30% em 3, 6 e 12 meses). Render: ASSINATURA_DESCONTO (opcional, %)
const DESCONTO_ASS = Math.max(0, Math.min(90, Number(process.env.ASSINATURA_DESCONTO === undefined || process.env.ASSINATURA_DESCONTO === '' ? 30 : process.env.ASSINATURA_DESCONTO)));
const PERIODOS_ASS = [{ meses: 1, desconto: 0 }, { meses: 3, desconto: DESCONTO_ASS }, { meses: 6, desconto: DESCONTO_ASS }, { meses: 12, desconto: DESCONTO_ASS }];
const valorAssinatura = (plano, meses) => { const p = PERIODOS_ASS.find(x => x.meses === meses) || PERIODOS_ASS[0]; return limpa(PRECOS[plano] * meses * (100 - p.desconto) / 100); };
const TAXA_PROPINAS = Math.max(0, Math.min(50, Number(process.env.TAXA_PROPINAS_PCT === undefined || process.env.TAXA_PROPINAS_PCT === '' ? 7 : process.env.TAXA_PROPINAS_PCT)));   // 7% por defeito em cada pagamento online
// 5.8.6: a taxa é exactamente TAXA_PROPINAS% do valor, sem arredondar (ex.: 15 MT → 1,05 MT; 10,55 MT → 0,7385 MT).
// limpa() só tira o ruído das contas em vírgula flutuante (1.0500000000000003 → 1.05), não arredonda os meticais.
const limpa = n => Number(Number(n || 0).toFixed(6));
const taxaDe = v => limpa(Number(v || 0) * TAXA_PROPINAS / 100);
// Valores em meticais escritos à mão: até 2 casas decimais, com vírgula ou ponto. Nunca arredonda.
const valorMT = x => { const t = String(x == null ? '' : x).replace(/\s/g, '').replace(',', '.'); return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : NaN; };
const TOLERANCIA_DIAS = 7;
function situacaoEscola(e) {
  if (!e) return { estado: 'desconhecida' };
  if (e['Estado'] === 'suspensa') return { estado: 'suspensa', ate: null, dias: null };
  const fim = e['Valida Ate'] || (e['Estado'] === 'teste' ? e['Teste Ate'] : null) || e['Teste Ate'];
  if (!fim) return { estado: e['Estado'] || 'activa', ate: null, dias: null };
  const dias = Math.ceil((new Date(fim).getTime() - Date.now()) / 864e5);
  const base = e['Valida Ate'] ? 'activa' : 'teste';
  return { estado: dias >= 0 ? base : (dias >= -TOLERANCIA_DIAS ? 'tolerancia' : 'expirada'), ate: fim, dias };
}
function somaMeses(iso, meses) { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + meses); return d.toISOString(); }
function novaValidade(e, meses) {
  const fim = e['Valida Ate'] || e['Teste Ate'];
  const base = fim && new Date(fim).getTime() > Date.now() ? fim : new Date().toISOString();
  return somaMeses(base, meses);
}
const subOut = x => ({ id: x._id, plano: x['Plano'] || '', meses: Number(x['Meses'] || 0), valor: Number(x['Valor'] || 0), metodo: x['Metodo'] || '', estado: x['Estado'] || 'pendente', data: x['Pago Em'] || x['Created Date'] || null, valida_ate: x['Valida Ate'] || null, referencia: x['Referencia'] || '' });

app.post('/assinatura', exigeDireccao, rota(async (req, res) => {
  const [e, subs, ests] = await Promise.all([obter('escola', req.escola), procurarTodos('subscricao', daEscola(req.escola), 300), procurarTodos('estudante', daEscola(req.escola))]);
  const plano = e['Plano'] || 'Essencial', activos = ests.filter(x => (x['Estado'] || 'activo') === 'activo').length;
  res.json({ ok: true, plano, preco: PRECOS[plano] || 0, limite: LIMITES[plano] || 0, estudantes: activos, situacao: situacaoEscola(e), tolerancia: TOLERANCIA_DIAS,
    planos: Object.keys(PRECOS).map(k => ({ nome: k, preco: PRECOS[k], limite: LIMITES[k] })), periodos: PERIODOS_ASS,
    historico: subs.map(subOut).sort((a, b) => String(b.data || '').localeCompare(String(a.data || ''))) });
}));
app.post('/assinatura-pagar', exigeSoDireccao, rota(async (req, res) => {
  const b = req.body || {}, metodo = String(b.metodo || '').toLowerCase();
  if (!['mpesa', 'emola', 'cartao'].includes(metodo)) return erro(res, 400, 'Escolha M-Pesa, e-Mola ou cartão.');
  if (!MOZ_WALLET) return erro(res, 500, 'O servidor ainda não tem a carteira configurada (MOZ_WALLET).');
  const meses = [1, 3, 6, 12].includes(Number(b.meses)) ? Number(b.meses) : 1;
  const e = await obter('escola', req.escola);
  const plano = PRECOS[b.plano] !== undefined && b.plano !== 'Rede' ? b.plano : (e['Plano'] || 'Essencial');
  if (plano === 'Rede' || !PRECOS[plano]) return erro(res, 400, 'O plano Rede é combinado com a equipa do Gescolar. Fale connosco.');
  const ests = await procurarTodos('estudante', daEscola(req.escola));
  const activos = ests.filter(x => (x['Estado'] || 'activo') === 'activo').length;
  if (LIMITES[plano] && activos > LIMITES[plano]) return erro(res, 400, 'A escola tem ' + activos + ' estudantes e o plano ' + plano + ' vai até ' + LIMITES[plano] + '. Escolha um plano maior.');
  const valor = valorAssinatura(plano, meses), numero = soDigitos(b.numero).replace(/^258(?=\d{9}$)/, '');
  if (metodo !== 'cartao') {
    if (numero.length !== 9) return erro(res, 400, 'O número tem 9 dígitos, por exemplo 84 123 4567.');
    const pre = numero.slice(0, 2);
    if (metodo === 'mpesa' && !['84', '85'].includes(pre)) return erro(res, 400, 'M-Pesa só funciona com números Vodacom (84 ou 85).');
    if (metodo === 'emola' && !['86', '87'].includes(pre)) return erro(res, 400, 'e-Mola só funciona com números Movitel (86 ou 87).');
  }
  const id = await criar('subscricao', { 'Escola': req.escola, 'Plano': plano, 'Meses': meses, 'Valor': valor, 'Metodo': metodo, 'Telefone': numero, 'Estado': 'pendente' });
  const produto = 'Gescolar ' + plano + ' · ' + meses + (meses === 1 ? ' mês' : ' meses') + ' · ' + (e['Nome'] || '');
  try {
    if (metodo === 'cartao') {
      const d = await mozPedido(MOZ_CARD_PATH, { valor: String(valor), nome_cliente: (e['Nome'] || 'Escola').slice(0, 80), carteira: MOZ_WALLET, nome_producto: produto.slice(0, 120) });
      const link = acharLink(d);
      if (!link) throw new Error('sem link na resposta: ' + JSON.stringify(d).slice(0, 220));
      await mudar('subscricao', id, { 'Referencia': String(achar(d, ['session_id', 'sessionId', 'session']) || sessionDoLink(link) || ''), 'Raw': JSON.stringify(d).slice(0, 4000) });
      return res.json({ ok: true, id, link, total: valor });
    }
    const d = await mozPedido('payment', corpoC2B(metodo, valor, numero, (e['Nome'] || 'Escola').slice(0, 80)));
    const idp = achar(d, ['idpayment', 'id_payment', 'idPayment', 'payment_id', 'paymentId', 'reference', 'id']);
    if (!idp) throw new Error('a MozPayment não devolveu a referência do pagamento: ' + JSON.stringify(d).slice(0, 200));
    await mudar('subscricao', id, { 'Referencia': String(idp), 'Raw': JSON.stringify(d).slice(0, 4000) });
    res.json({ ok: true, id, total: valor, mensagem: 'Pedido enviado para o ' + numero.replace(/(\d{2})(\d{3})(\d{4})/, '$1 $2 $3') + '. Confirme com o PIN.' });
  } catch (err) {
    console.error('[assinatura]', err.message);
    await mudar('subscricao', id, { 'Estado': 'falhado', 'Raw': String(err.message).slice(0, 2000) }).catch(() => {});
    erro(res, 502, 'A MozPayment não aceitou o pedido: ' + String(err.message).slice(0, 300));
  }
}));
app.post('/assinatura-estado', exigeDireccao, rota(async (req, res) => {
  const x = await daMinhaEscola('subscricao', String((req.body || {}).id || ''), req.escola);
  res.json({ ok: true, estado: x['Estado'] || 'pendente', valida_ate: x['Valida Ate'] || null, valor: Number(x['Valor'] || 0) });
}));
// chamado pelo webhook quando a referência é de uma assinatura
async function aplicarSubscricao(x, b, estado) {
  if (x['Estado'] === 'pago') return { ok: true, ja: 'aplicado' };
  const raw = JSON.stringify(b).slice(0, 4000), trx = txt(b.transaction_id, 120);
  const valor = Math.round(Number(String(b.amount || '').replace(',', '.')));
  if (estado === 'pago' && valor !== Math.round(Number(x['Valor'] || 0))) { await mudar('subscricao', x._id, { 'Estado': 'revisao', 'Transacao': trx, 'Raw': raw }); return { ok: true, revisao: true }; }
  if (estado !== 'pago') { await mudar('subscricao', x._id, { 'Estado': estado, 'Transacao': trx, 'Raw': raw }); return { ok: true, estado }; }
  const e = await obter('escola', x['Escola']);
  const ate = novaValidade(e, Number(x['Meses'] || 1));
  await mudar('subscricao', x._id, { 'Estado': 'pago', 'Transacao': trx, 'Raw': raw, 'Pago Em': new Date().toISOString(), 'Valida Ate': ate });
  await mudar('escola', x['Escola'], { 'Valida Ate': ate, 'Estado': 'activa', 'Plano': x['Plano'] || e['Plano'] });
  cachePainel.delete(x['Escola']);
  return { ok: true, estado: 'pago', valida_ate: ate };
}

// ---------- área da plataforma ----------
function exigePlataforma(req, res, next) {
  const s = sessaoDo(req);
  if (!s) return erro(res, 401, 'A sessão terminou. Entre outra vez.');
  if (s.pl !== 1 && s.p !== 'Plataforma') return erro(res, 403, 'Só a equipa do Gescolar tem acesso.');
  req.sessao = s; next();
}
const ONLINE = m => ['mpesa', 'emola', 'cartao'].includes(String(m || '').toLowerCase());
app.post('/pl/resumo', exigePlataforma, rota(async (req, res) => {
  const [escolas, pags, subs, trs0, ests, insc] = await Promise.all([procurarTodos('escola', [], 5000), procurarTodos('pagamento', [], 50000), procurarTodos('subscricao', [], 20000), procurarTodos('transferencia', [], 20000), procurarTodos('estudante', [], 100000),
    procurarTodos('inscricaoonline', [], 50000).catch(() => [])]);
  const trs = trs0.filter(t => contaTransf(t) && t['Estado'] !== 'pedido');
  const pedidos = trs0.filter(t => t['Estado'] === 'pedido');
  const lista = escolas.map(e => {
    const online = pags.filter(p => p['Escola'] === e._id && p['Estado'] === 'pago' && ONLINE(p['Metodo']));
    const insE = insc.filter(i => i['Escola'] === e._id && ['paga', 'matriculada'].includes(i['Estado']) && ONLINE(i['Metodo']));
    const bruto = online.reduce((x, p) => x + Number(p['Valor'] || 0), 0) + insE.reduce((x, i) => x + Number(i['Valor'] || 0), 0), taxa = taxaDe(bruto);
    const transferido = trs.filter(t => t['Escola'] === e._id).reduce((x, t) => x + Number(t['Valor'] || 0), 0);
    const assin = subs.filter(x => x['Escola'] === e._id && x['Estado'] === 'pago');
    return { id: e._id, nome: e['Nome'] || '', subdominio: e['Subdominio'] || '', cidade: e['Cidade'] || '', provincia: e['Provincia'] || '', telefone: e['Telefone'] || '', email: e['Email'] || '', nuit: e['NUIT'] || '',
      plano: e['Plano'] || '', situacao: situacaoEscola(e), criada: e['Created Date'] || null,
      estudantes: ests.filter(x => x['Escola'] === e._id && (x['Estado'] || 'activo') === 'activo').length,
      propinas_online: limpa(bruto), taxa, transferido: limpa(transferido), saldo: limpa(bruto - taxa - transferido), pagamentos: online.length + insE.length,
      saques_pedidos: pedidos.filter(t => t['Escola'] === e._id).reduce((x, t) => x + Number(t['Valor'] || 0), 0),
      assinaturas: assin.reduce((x, s2) => x + Number(s2['Valor'] || 0), 0), ultimo_pagamento: online.map(p => p['Pago Em']).sort().pop() || null };
  }).sort((a, b) => b.saldo - a.saldo || a.nome.localeCompare(b.nome, 'pt'));
  const mes = new Date().toISOString().slice(0, 7);
  res.json({ ok: true, taxa_pct: TAXA_PROPINAS, precos: PRECOS, escolas: lista,
    totais: { escolas: lista.length, activas: lista.filter(x => ['activa', 'tolerancia'].includes(x.situacao.estado)).length, teste: lista.filter(x => x.situacao.estado === 'teste').length,
      estudantes: lista.reduce((x, e) => x + e.estudantes, 0), a_transferir: limpa(lista.reduce((x, e) => x + Math.max(0, e.saldo), 0)),
      propinas_online: limpa(lista.reduce((x, e) => x + e.propinas_online, 0)), assinaturas: lista.reduce((x, e) => x + e.assinaturas, 0),
      assinaturas_mes: subs.filter(x => x['Estado'] === 'pago' && String(x['Pago Em'] || '').slice(0, 7) === mes).reduce((x, s2) => x + Number(s2['Valor'] || 0), 0) } });
}));
app.post('/pl/escola', exigePlataforma, rota(async (req, res) => {
  const id = String((req.body || {}).id || '');
  const e = await obter('escola', id);
  if (!e) return erro(res, 404, 'Escola não encontrada.');
  const f = daEscola(id);
  const [pags, subs, trs, ests] = await Promise.all([procurarTodos('pagamento', f, 20000), procurarTodos('subscricao', f, 500), procurarTodos('transferencia', f, 2000), procurarTodos('estudante', f)]);
  const EM = Object.fromEntries(ests.map(x => [x._id, x['Nome']]));
  const movimentos = pags.filter(p => p['Estado'] === 'pago' && ONLINE(p['Metodo'])).map(p => ({ tipo: 'entrada', data: p['Pago Em'], valor: Number(p['Valor'] || 0), taxa: taxaDe(p['Valor']),
      texto: (EM[p['Estudante']] || '') + ' · ' + (p['Documento'] || ''), metodo: p['Metodo'] || '' }))
    .concat(trs.map(t => ({ tipo: 'transferencia', id: t._id, data: t['Data'] || t['Created Date'], valor: Number(t['Valor'] || 0), texto: [t['Metodo'], t['Referencia'], t['Notas']].filter(Boolean).join(' · '), feita_por: t['Feita Por'] || '' })))
    .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));
  res.json({ ok: true, escola: { id: e._id, nome: e['Nome'] || '', plano: e['Plano'] || '', situacao: situacaoEscola(e), valida_ate: e['Valida Ate'] || null, teste_ate: e['Teste Ate'] || null, estado: e['Estado'] || '' },
    movimentos: movimentos.slice(0, 400), assinaturas: subs.map(subOut).sort((a, b) => String(b.data || '').localeCompare(String(a.data || ''))) });
}));
app.post('/pl/escola-guardar', exigePlataforma, rota(async (req, res) => {
  const b = req.body || {};
  const e = await obter('escola', String(b.id || ''));
  if (!e) return erro(res, 404, 'Escola não encontrada.');
  const mud = {};
  if (b.plano !== undefined) { if (!PLANOS.includes(b.plano)) return erro(res, 400, 'Plano inválido.'); mud['Plano'] = b.plano; }
  if (b.estado !== undefined) { if (!['teste', 'activa', 'suspensa'].includes(b.estado)) return erro(res, 400, 'Estado inválido.'); mud['Estado'] = b.estado; }
  if (b.valida_ate !== undefined) { if (b.valida_ate && isNaN(Date.parse(b.valida_ate))) return erro(res, 400, 'Data inválida.'); if (b.valida_ate) mud['Valida Ate'] = new Date(b.valida_ate + 'T23:59:00Z').toISOString(); }
  if (b.mais_meses) mud['Valida Ate'] = novaValidade(e, Math.max(1, Math.min(24, Number(b.mais_meses) || 1)));
  if (!Object.keys(mud).length) return erro(res, 400, 'Nada para guardar.');
  if (mud['Valida Ate'] && !mud['Estado'] && e['Estado'] !== 'suspensa') mud['Estado'] = 'activa';
  await mudar('escola', e._id, mud);
  cachePainel.delete(e._id);
  res.json({ ok: true, situacao: situacaoEscola(Object.assign({}, e, mud)) });
}));
app.post('/pl/transferencia', exigePlataforma, rota(async (req, res) => {
  const b = req.body || {};
  const e = await obter('escola', String(b.escola || ''));
  if (!e) return erro(res, 404, 'Escola não encontrada.');
  const valor = valorMT(b.valor);
  if (isNaN(valor)) return erro(res, 400, 'Escreva o valor em meticais, com até 2 casas decimais (ex.: 150 ou 150,50).');
  if (!(valor > 0)) return erro(res, 400, 'Escreva o valor transferido.');
  const data = b.data && !isNaN(Date.parse(b.data)) ? new Date(b.data + 'T12:00:00Z').toISOString() : new Date().toISOString();
  const eu = await obter('user', req.sessao.u).catch(() => null);
  const id = await criar('transferencia', { 'Escola': e._id, 'Valor': valor, 'Data': data, 'Referencia': txt(b.referencia, 80), 'Metodo': txt(b.metodo, 40), 'Notas': txt(b.notas, 300), 'Feita Por': (eu && eu['Nome Completo']) || 'Plataforma' });
  if (b.sms && tel9(e['Telefone']).length === 9) enviarSMS([e['Telefone']], 'Gescolar: transferimos ' + mt(valor) + ' para ' + (e['Nome'] || 'a escola') + ' (propinas pagas online)' + (b.referencia ? '. Ref. ' + txt(b.referencia, 40) : '') + '.').catch(() => {});
  res.json({ ok: true, id });
}));
app.post('/pl/transferencia-apagar', exigePlataforma, rota(async (req, res) => {
  const id = String((req.body || {}).id || '');
  const t = await obter('transferencia', id).catch(() => null);
  if (!t) return erro(res, 404, 'Transferência não encontrada.');
  await apagar('transferencia', id);
  res.json({ ok: true });
}));

// ============================================================
//  RECUPERAR PALAVRA-PASSE E EQUIPA DA ESCOLA (v4.9)
//  Bubble, 2 backend workflows novos (ver instruções):
//   senha-temp  (parâmetro email)  → Assign a temp password to a user → Return data: senha = Result of step 1
//   senha-mudar (parâmetro nova; exige autenticação do utilizador) → Update the user's credentials (Password = nova)
//  O workflow login já existente devolve o token do utilizador, usado para chamar senha-mudar em nome dele.
// ============================================================
function linkPagina(nome) { return PORTAL_URL.replace(/[^/]*$/, nome); }
async function wfComo(nome, corpo, tokenUser) {
  const r = await fetch(BUBBLE_WF + '/' + nome, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokenUser }, body: JSON.stringify(corpo || {}) });
  const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = { raw: t }; }
  if (!r.ok) { const e = new Error(nome + ': ' + ((d && d.body && d.body.message) || (d && d.message) || t || r.status)); e.status = r.status; throw e; }
  return d;
}
async function userPorEmail(email) {
  const l = await procurar('user', [{ key: 'email', constraint_type: 'equals', value: email }], 1);
  return l[0] || null;
}
const emailDoUser = u => (u && u['authentication'] && u['authentication']['email'] && u['authentication']['email']['email']) || (u && u['email']) || '';

app.post('/senha-pedir', rota(async (req, res) => {
  const email = txt((req.body || {}).email, 120).toLowerCase();
  if (!emailOk(email)) return erro(res, 400, 'Escreva o email da sua conta.');
  if (travao('senha-ip|' + req.ip, 10, 15) || travao('senha|' + email, 3, 15)) return erro(res, 429, 'Muitos pedidos seguidos. Espere 15 minutos.');
  const u = await userPorEmail(email);
  if (!u) return erro(res, 404, 'Não encontrámos nenhuma conta com este email.');
  if (u['Activo'] === false) return erro(res, 403, 'Esta conta está desactivada. Fale com a Direcção da escola.');
  const tel = tel9(u['Telefone']);
  if (tel.length !== 9) return erro(res, 409, 'Esta conta não tem telemóvel registado. Escreva para geral@gescolar.co.mz a pedir ajuda.');
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0'), pedido = crypto.randomBytes(16).toString('hex');
  const r = await enviarSMS([tel], 'Gescolar: o seu codigo para criar uma nova palavra-passe e ' + codigo + '. Valido 10 minutos. Nao partilhe este codigo.');
  if (!r.ok) return erro(res, 502, 'Não foi possível enviar o SMS agora. Tente de novo dentro de um minuto.');
  pedidosAcesso.set(pedido, { tipo: 'senha', id: u._id, email, hash: hashCodigo(pedido + codigo), exp: Date.now() + 600e3, tent: 0 });
  res.json({ ok: true, pedido, destino: mascarar(tel) });
}));
app.post('/senha-nova', rota(async (req, res) => {
  const b = req.body || {}, chave = String(b.pedido || '');
  const pd = pedidosAcesso.get(chave);
  if (!pd || pd.tipo !== 'senha' || pd.exp < Date.now()) return erro(res, 410, 'O código expirou. Peça um novo.');
  const nova = String(b.password || '');
  if (nova.length < 8) return erro(res, 400, 'A palavra-passe tem de ter pelo menos 8 caracteres.');
  pd.tent++;
  if (pd.tent > 5) { pedidosAcesso.delete(chave); return erro(res, 429, 'Demasiadas tentativas. Peça um novo código.'); }
  const cod = soDigitos(b.codigo), a = Buffer.from(hashCodigo(chave + cod)), c = Buffer.from(pd.hash);
  if (cod.length !== 6 || a.length !== c.length || !crypto.timingSafeEqual(a, c)) return erro(res, 401, 'Código errado (' + (5 - pd.tent) + ' tentativas restantes).');
  try {
    const t = await workflow('senha-temp', { email: pd.email });
    const temp = achar(t, ['senha', 'password', 'temp', 'temp_password']);
    if (!temp) throw new Error('senha-temp não devolveu a senha — confirme o "Return data from API" com a chave senha');
    const l = await workflow('login', { email: pd.email, password: String(temp) });
    const tok = achar(l, ['token']);
    if (!tok) throw new Error('login não devolveu o token do utilizador');
    await wfComo('senha-mudar', { nova }, String(tok));
  } catch (e) {
    console.error('[senha-nova]', e.message);
    return erro(res, 500, 'Não foi possível mudar a palavra-passe agora. Tente de novo ou fale com o suporte.');
  }
  pedidosAcesso.delete(chave);
  res.json(await abrirSessao(pd.id, PLATAFORMA_EMAILS.includes(pd.email)));
}));

// ---------- equipa da escola (só a Direcção) ----------
function exigeSoDireccao(req, res, next) {
  const s = sessaoDo(req);
  if (!s) return erro(res, 401, 'A sessão terminou. Entre outra vez.');
  if (!s.e || s.p !== 'Direccao') return erro(res, 403, 'Só a Direcção pode gerir a equipa.');
  req.sessao = s; req.escola = s.e; next();
}
const userOut = u => ({ id: u._id, nome: u['Nome Completo'] || '', email: emailDoUser(u), telefone: u['Telefone'] || '', papel: u['Papel'] || '', activo: u['Activo'] !== false, ultimo: u['Ultimo Acesso'] || null });
app.post('/equipa', exigeSoDireccao, rota(async (req, res) => {
  const us = await procurarTodos('user', daEscola(req.escola), 200);
  res.json({ ok: true, eu: req.sessao.u, equipa: us.filter(u => ['Direccao', 'Secretaria'].includes(u['Papel'])).map(userOut).sort((a, b) => a.nome.localeCompare(b.nome, 'pt')) });
}));
app.post('/equipa-criar', exigeSoDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const nome = txt(b.nome, 100), email = txt(b.email, 120).toLowerCase(), tel = tel9(b.telefone), papel = b.papel === 'Direccao' ? 'Direccao' : 'Secretaria';
  if (nome.split(/\s+/).length < 2) return erro(res, 400, 'Escreva o nome completo.');
  if (!emailOk(email)) return erro(res, 400, 'O email não parece válido.');
  if (tel.length !== 9) return erro(res, 400, 'O telemóvel tem 9 dígitos. É por ele que a pessoa cria a palavra-passe.');
  if (await userPorEmail(email)) return erro(res, 409, 'Este email já tem conta no Gescolar.');
  let userId;
  try {
    const r = await workflow('signup', { email, password: crypto.randomBytes(18).toString('base64url') });
    userId = r && r.response && r.response.user_id;
  } catch (e) {
    if (e.status === 400) return erro(res, 409, 'Este email já tem conta no Gescolar.');
    throw e;
  }
  if (!userId) throw new Error('signup não devolveu user_id');
  await mudar('user', userId, { 'Escola': req.escola, 'Papel': papel, 'Nome Completo': nome, 'Telefone': tel.replace(/(\d{2})(\d{3})(\d{4})/, '$1 $2 $3'), 'Activo': true });
  const esc = await obter('escola', req.escola).catch(() => null);
  const link = linkPagina('recuperar.html') + '?email=' + encodeURIComponent(email);
  const papelN = papel === 'Direccao' ? 'Direccao' : 'Secretaria', escN = (esc && esc['Nome']) || 'a escola';
  const r = await enviarSMS([tel], 'Gescolar: foi criada a sua conta (' + papelN + ') em ' + escN + (SMS_LINKS ? '. Crie a sua palavra-passe em ' + link.replace(/^https?:\/\//, '') : '. Enviamos para o seu email ' + email + ' o link para criar a palavra-passe.'));
  const blocos = [{ p: 'Foi criada a sua conta (' + (papel === 'Direccao' ? 'Direcção' : 'Secretaria') + ') em ' + escN + ' no Gescolar.' }, { botao: 'Criar a palavra-passe', link }, { p: 'Depois entre no Gescolar com este email (' + email + ') e a palavra-passe que escolher.' }];
  const m = await enviarEmail(email, 'Gescolar: a sua conta em ' + escN, emailGescolar(escN, 'Bem-vindo ao Gescolar', blocos), textoDeBlocos('Bem-vindo ao Gescolar', blocos));
  res.json({ ok: true, id: userId, sms: r.ok, email: m.ok, link });
}));
app.post('/equipa-estado', exigeSoDireccao, rota(async (req, res) => {
  const b = req.body || {}, id = String(b.id || '');
  if (id === req.sessao.u) return erro(res, 400, 'Não pode desactivar a sua própria conta.');
  const u = await obter('user', id).catch(() => null);
  if (!u || u['Escola'] !== req.escola) return erro(res, 404, 'Utilizador não encontrado.');
  await mudar('user', id, { 'Activo': !!b.activo });
  res.json({ ok: true, activo: !!b.activo });
}));

// ============================================================
//  CONVITES AOS PROFESSORES (v4.10)
//  O professor entra em acesso.html?e=<código da escola> → Professor → telemóvel → código SMS.
// ============================================================
// convite por SMS e por email (o que o professor tiver). Devolve { sms, email } ou false se nada saiu
async function convidarProfessor(escolaId, p, escRaw) {
  const tel = tel9(p['Telefone']), mail = String(p['Email'] || '').trim().toLowerCase();
  if (tel.length !== 9 && !emailOk(mail)) return false;
  const esc = escRaw || await obter('escola', escolaId);
  const linkC = linkFamilias(esc['Subdominio']), link = linkC.replace(/^https?:\/\//, '');
  const blocos = [{ p: 'Olá ' + String(p['Nome'] || '').split(' ')[0] + ',' }, { p: (esc['Nome'] || 'A escola') + ' criou o seu acesso de professor no Gescolar. Lá vê as suas turmas e o horário, faz a chamada, lança as notas e conversa com os estudantes no chat da turma.' },
    { botao: 'Entrar no Gescolar', link: linkC },
    { p: tel.length === 9 ? 'Na página, escolha «Professor» e escreva o seu número de telemóvel (' + tel + '). Vai receber um código de 6 números por SMS e neste email.'
      : 'Para entrar, a escola tem de registar o seu número de telemóvel: é com ele que entra. Peça à Direcção para o acrescentar à sua ficha.' },
    { nota: 'Código da escola: ' + (esc['Subdominio'] || '') }];
  const [r, m] = await Promise.all([
    tel.length === 9 ? enviarSMS([tel], (esc['Nome'] || 'A escola') + ': foi registado como professor no Gescolar. Para ver as suas turmas, o horario, fazer a chamada e lancar notas entre ' + noGescolar(esc['Subdominio']) + ', escolha Professor e use este numero.') : Promise.resolve({ ok: false }),
    emailOk(mail) ? enviarEmail(mail, (esc['Nome'] || 'Gescolar') + ': o seu acesso de professor', emailGescolar(esc['Nome'], 'O seu acesso ao Gescolar', blocos), textoDeBlocos('O seu acesso ao Gescolar', blocos)) : Promise.resolve({ ok: false })]);
  return (r.ok || m.ok) ? { sms: r.ok, email: m.ok } : false;
}
app.post('/professor-convite', exigeDireccao, rota(async (req, res) => {
  const p = await daMinhaEscola('professor', String((req.body || {}).id || ''), req.escola);
  if (tel9(p['Telefone']).length !== 9 && !emailOk(String(p['Email'] || '').toLowerCase())) return erro(res, 400, 'Este professor não tem telemóvel nem email registados. Edite-o e acrescente um deles.');
  if (travao('conv-prof|' + p._id, 3, 60)) return erro(res, 429, 'Já enviou o acesso a este professor várias vezes. Tente daqui a uma hora.');
  const c = await convidarProfessor(req.escola, p);
  if (!c) return erro(res, 502, 'O acesso não foi enviado (nem SMS nem email). Tente mais tarde.');
  res.json({ ok: true, sms: c.sms, email: c.email });
}));
app.post('/professores-convite', exigeDireccao, rota(async (req, res) => {
  if (travao('conv-profs|' + req.escola, 1, 60)) return erro(res, 429, 'O convite já foi enviado há pouco. Pode voltar a enviar daqui a uma hora.');
  const [esc, profs] = await Promise.all([obter('escola', req.escola), procurarTodos('professor', daEscola(req.escola))]);
  const alvo = profs.filter(p => p['Activo'] !== false && (tel9(p['Telefone']).length === 9 || emailOk(String(p['Email'] || '').toLowerCase())));
  if (!alvo.length) return erro(res, 400, 'Nenhum professor tem telemóvel ou email registado.');
  let enviados = 0, sms = 0, emails = 0;
  for (const p of alvo) { const c = await convidarProfessor(req.escola, p, esc).catch(() => false); if (c) { enviados++; if (c.sms) sms++; if (c.email) emails++; } }
  res.json({ ok: true, enviados, sms, emails, sem_telefone: profs.filter(p => p['Activo'] !== false).length - alvo.length });
}));

// ============================================================
//  ESCOLA DE CONDUÇÃO · PARTE 1: CURSOS E INSCRIÇÕES (v5.0)
//  O instruendo é um Estudante (sem turma, com telemóvel próprio): assim usa o mesmo portal,
//  as mesmas cobranças (Propina com Tipo "prestacao", sem multa) e os mesmos recibos.
//  Bubble:
//   Curso Conducao:    Escola (Escola) · Categoria (text) · Nome (text) · Preco (number) · Prestacoes (number)
//                      · Aulas Teoricas (number) · Aulas Praticas (number) · Idade Minima (number) · Activo (yes/no)
//   Inscricao Conducao: Escola (Escola) · Estudante (text) · Curso (text) · Categoria (text) · Data Inscricao (date)
//                      · Estado (text: activa | concluida | desistiu) · Preco (number) · Prestacoes (number)
// ============================================================
const CATEGORIAS = {
  A1: { nome: 'Motociclos até 125 cc', idade: 16 }, A: { nome: 'Motociclos', idade: 18 }, B: { nome: 'Ligeiros', idade: 18 },
  BE: { nome: 'Ligeiros com reboque', idade: 18 }, C: { nome: 'Pesados de mercadorias', idade: 18 }, CE: { nome: 'Pesados com reboque', idade: 18 }, D: { nome: 'Pesados de passageiros', idade: 25 }
};
const cursoOut = (c, ins) => ({ id: c._id, categoria: c['Categoria'] || '', nome: c['Nome'] || '', preco: Number(c['Preco'] || 0), prestacoes: Number(c['Prestacoes'] || 1),
  teoricas: Number(c['Aulas Teoricas'] || 0), praticas: Number(c['Aulas Praticas'] || 0), idade: Number(c['Idade Minima'] || (CATEGORIAS[c['Categoria']] || {}).idade || 18), activo: c['Activo'] !== false, extra: Number(c['Preco Aula Extra'] || 0),
  inscritos: ins ? ins.filter(i => i['Curso'] === c._id && (i['Estado'] || 'activa') === 'activa').length : undefined });
app.post('/cursos', exigeDireccao, rota(async (req, res) => {
  const f = daEscola(req.escola);
  const [cs, ins] = await Promise.all([procurarTodos('cursoconducao', f), procurarTodos('inscricaoconducao', f)]);
  res.json({ ok: true, categorias: CATEGORIAS, cursos: cs.filter(c => c['Activo'] !== false).map(c => cursoOut(c, ins)).sort((a, b) => Object.keys(CATEGORIAS).indexOf(a.categoria) - Object.keys(CATEGORIAS).indexOf(b.categoria) || a.nome.localeCompare(b.nome, 'pt')) });
}));
app.post('/curso-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, cat = String(b.categoria || '').toUpperCase();
  if (!CATEGORIAS[cat]) return erro(res, 400, 'Escolha a categoria da carta.');
  const preco = Math.round(Number(b.preco)), prest = Math.round(Number(b.prestacoes || 1));
  if (!(preco > 0)) return erro(res, 400, 'Escreva o preço do curso.');
  if (!(prest >= 1 && prest <= 12)) return erro(res, 400, 'As prestações vão de 1 a 12.');
  const campos = { 'Escola': req.escola, 'Categoria': cat, 'Nome': txt(b.nome, 80) || ('Carta ' + cat + ' · ' + CATEGORIAS[cat].nome), 'Preco': preco, 'Prestacoes': prest,
    'Aulas Teoricas': Math.max(0, Math.round(Number(b.teoricas) || 0)), 'Aulas Praticas': Math.max(0, Math.round(Number(b.praticas) || 0)),
    'Idade Minima': Math.max(CATEGORIAS[cat].idade, Math.round(Number(b.idade) || 0)), 'Activo': true };
  if (b.extra !== undefined && String(b.extra).trim() !== '') { const x = Math.round(Number(String(b.extra).replace(/\s/g, ''))); if (!(x >= 0)) return erro(res, 400, 'Preço da aula extra inválido.'); campos['Preco Aula Extra'] = x; }
  let id = b.id ? String(b.id) : null;
  if (id) { await daMinhaEscola('cursoconducao', id, req.escola); await mudar('cursoconducao', id, campos); } else id = await criar('cursoconducao', campos);
  res.json({ ok: true, id });
}));
app.post('/curso-apagar', exigeDireccao, rota(async (req, res) => {
  const c = await daMinhaEscola('cursoconducao', String((req.body || {}).id || ''), req.escola);
  await mudar('cursoconducao', c._id, { 'Activo': false });
  res.json({ ok: true });
}));
function idadeEm(nasc) { const n = new Date(nasc), h = new Date(); let a = h.getUTCFullYear() - n.getUTCFullYear(); if (h.getUTCMonth() < n.getUTCMonth() || (h.getUTCMonth() === n.getUTCMonth() && h.getUTCDate() < n.getUTCDate())) a--; return a; }
app.post('/instruendos', exigeDireccao, rota(async (req, res) => {
  const f = daEscola(req.escola);
  const [ins, cs, ests, props, esc, aulas, docs, ts, teo] = await Promise.all([procurarTodos('inscricaoconducao', f, 5000), procurarTodos('cursoconducao', f), procurarTodos('estudante', f), procurarTodos('propina', f.concat([{ key: 'Tipo', constraint_type: 'equals', value: 'prestacao' }]), 20000), resumoEscola(req.escola), procurarTodos('aulapratica', f, 20000),
    docsDaEscola(req.escola), procurarTodos('testecodigo', f, 20000).catch(() => []), procurarTodos('aulateorica', f, 5000).catch(() => [])]);
  const teoConta = {}; teo.forEach(t => (lerJSON(t['Presentes'], []) || []).forEach(id => { teoConta[id] = (teoConta[id] || 0) + 1; }));
  const escRawI = await obter('escola', req.escola).catch(() => null);
  const CM = Object.fromEntries(cs.map(c => [c._id, c])), EM = Object.fromEntries(ests.map(e => [e._id, e]));
  const regras = (esc && esc.regras) || {};
  res.json({ ok: true, instruendos: ins.map(i => {
    const e = EM[i['Estudante']] || {}, c = CM[i['Curso']] || {};
    const ps = props.filter(p => p['Estudante'] === i['Estudante'] && p['Estado'] !== 'anulada').map(p => Object.assign({ id: p._id, vencimento: p['Vencimento'], descricao: p['Descricao'] }, calcPropina(p, regras)));
    const pago = ps.filter(p => p.estado === 'paga').reduce((x, p) => x + p.total, 0), total = ps.reduce((x, p) => x + p.total, 0);
    const prox = ps.filter(p => p.estado !== 'paga').sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)))[0];
    return { id: i._id, estudante: i['Estudante'], nome: e['Nome'] || '', numero: e['Numero'] || '', telefone: e['Telefone'] || '', nascimento: e['Data Nascimento'] || null,
      curso: c['Nome'] || '', categoria: i['Categoria'] || c['Categoria'] || '', data: i['Data Inscricao'] || i['Created Date'] || null, estado: i['Estado'] || 'activa',
      preco: Number(i['Preco'] || 0), pago, total, em_atraso: ps.filter(p => p.estado === 'atrasada').reduce((x, p) => x + p.total, 0),
      proxima: prox ? { valor: prox.total, vencimento: prox.vencimento } : null,
      praticas: { feitas: aulas.filter(a => a['Inscricao'] === i._id && a['Estado'] === 'feita').length, marcadas: aulas.filter(a => a['Inscricao'] === i._id && a['Estado'] === 'marcada').length, total: Number(c['Aulas Praticas'] || 0) },
      teoricas: { feitas: teoConta[i._id] || 0, total: Number(c['Aulas Teoricas'] || 0) },
      codigo: Object.assign(resumoCodigo(ts.filter(t => t['Inscricao'] === i._id)), { acesso: i['Codigo Acesso'] || '', acesso_pago: props.some(p => p['Estudante'] === i['Estudante'] && p['Descricao'] === DESC_ACESSO && p['Estado'] === 'paga') }),
      processo: processoOut(i, docs) };
  }).sort((a, b) => String(b.data || '').localeCompare(String(a.data || ''))), documentos: docs, processos: PROCESSO,
    codigo_acesso: { modo: (escRawI && escRawI['Codigo Acesso']) === 'pago' ? 'pago' : 'gratis', preco: Number((escRawI && escRawI['Codigo Preco']) || 0) } });
}));
async function inscreverCore(escolaId, b) {
  const nome = txt(b.nome, 100);
  if (nome.split(/\s+/).length < 2) throw pub('Escreva o nome completo do instruendo.');
  const tel = tel9(b.telefone);
  if (tel.length !== 9) throw pub('O telemóvel tem 9 dígitos. É por ele que o instruendo entra no portal e recebe avisos.');
  if (!b.nascimento || isNaN(Date.parse(b.nascimento))) throw pub('Escreva a data de nascimento: a idade mínima depende da categoria.');
  const c = await daMinhaEscola('cursoconducao', String(b.curso || ''), escolaId);
  if (c['Activo'] === false) throw pub('Este curso já não está activo.');
  const idade = idadeEm(b.nascimento), minima = Number(c['Idade Minima'] || (CATEGORIAS[c['Categoria']] || {}).idade || 18);
  if (idade < minima) throw pub('A carta ' + c['Categoria'] + ' exige pelo menos ' + minima + ' anos. O instruendo tem ' + idade + '.');
  const prest = Math.max(1, Math.min(Number(c['Prestacoes'] || 1), Math.round(Number(b.prestacoes) || Number(c['Prestacoes'] || 1))));
  const preco = Number(c['Preco'] || 0);
  const inicio = b.inicio && !isNaN(Date.parse(b.inicio)) ? new Date(b.inicio + 'T12:00:00Z') : new Date();
  // número do instruendo: C<ano>-0001 (separado dos estudantes)
  const ests = await procurarTodos('estudante', daEscola(escolaId));
  const ano = String(new Date().getFullYear());
  const repetido = ests.find(e => tel9(e['Telefone']) === tel && (e['Estado'] || 'activo') === 'activo' && String(e['Numero'] || '').startsWith('C'));
  const { encId, encTel } = await encarregadoDe(escolaId, b, false);   // v5.12: encarregado opcional na condução
  let estId, numero;
  if (repetido) { estId = repetido._id; numero = repetido['Numero']; if (encId && repetido['Encarregado'] !== encId) await mudar('estudante', estId, { 'Encarregado': encId }).catch(() => {}); }
  else {
    const maior = ests.map(e => String(e['Numero'] || '')).filter(n => n.startsWith('C' + ano + '-')).map(n => parseInt(n.split('-')[1], 10) || 0).reduce((a, x) => Math.max(a, x), 0);
    numero = 'C' + ano + '-' + String(maior + 1).padStart(4, '0');
    const campos = { 'Escola': escolaId, 'Numero': numero, 'Nome': nome, 'Sexo': b.sexo === 'F' ? 'F' : (b.sexo === 'M' ? 'M' : ''), 'Telefone': tel.replace(/(\d{2})(\d{3})(\d{4})/, '$1 $2 $3'),
      'Data Nascimento': new Date(b.nascimento).toISOString(), 'Ano Lectivo': ano, 'Data Matricula': new Date().toISOString(), 'Estado': 'activo' };
    if (encId) campos['Encarregado'] = encId;
    estId = await criar('estudante', campos);
  }
  const insId = await criar('inscricaoconducao', { 'Escola': escolaId, 'Estudante': estId, 'Curso': c._id, 'Categoria': c['Categoria'], 'Data Inscricao': new Date().toISOString(), 'Estado': 'activa', 'Preco': preco, 'Prestacoes': prest });
  // prestações: dividir o preço; a primeira vence no dia da inscrição (ou no início escolhido), as outras de mês a mês
  const base = Math.floor(preco / prest), resto = preco - base * prest, linhas = [];
  for (let k = 0; k < prest; k++) {
    const v = new Date(inicio); v.setUTCMonth(v.getUTCMonth() + k); v.setUTCHours(21, 59, 0, 0);
    const valor = base + (k === 0 ? resto : 0);
    linhas.push({ 'Escola': escolaId, 'Estudante': estId, 'Ano Lectivo': String(v.getUTCFullYear()), 'Tipo': 'prestacao', 'Mes': v.getUTCMonth() + 1,
      'Descricao': 'Carta ' + c['Categoria'] + ' · ' + (prest === 1 ? 'pagamento único' : 'prestação ' + (k + 1) + '/' + prest), 'Valor': valor, 'Vencimento': v.toISOString(), 'Multa': 0, 'Total': valor, 'Estado': 'aberta' });
  }
  await criarEmLote('propina', linhas);
  const esc = await obter('escola', escolaId).catch(() => null);
  let sms = false;
  if (esc) {
    const link = noGescolar(esc['Subdominio']);
    const r = await enviarSMS([tel], (esc['Nome'] || 'A escola') + ': bem-vindo ao curso da carta ' + c['Categoria'] + '. O seu numero e ' + numero + '. Veja aulas, prestacoes e recibos e pague por M-Pesa ou e-Mola ' + link + ' (escolha Estudante).');
    sms = r.ok;
    if (encTel && encTel !== tel) await enviarSMS([encTel], (esc['Nome'] || 'A escola') + ': ' + nome + ' foi inscrito(a) no curso da carta ' + c['Categoria'] + ' com o numero ' + numero + '. Acompanhe aulas e prestacoes e pague por M-Pesa ou e-Mola ' + link + ' (escolha Encarregado e use este numero de telemovel).').catch(() => {});
  }
  cachePainel.delete(escolaId);
  return { id: insId, estudante: estId, numero, prestacoes: prest, sms };
}
app.post('/inscrever', exigeDireccao, rota(async (req, res) => {
  const r = await inscreverCore(req.escola, req.body || {});
  res.json(Object.assign({ ok: true }, r));
}));
app.post('/inscricao-estado', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, estado = String(b.estado || '');
  if (!['activa', 'concluida', 'desistiu'].includes(estado)) return erro(res, 400, 'Estado inválido.');
  const i = await daMinhaEscola('inscricaoconducao', String(b.id || ''), req.escola);
  await mudar('inscricaoconducao', i._id, { 'Estado': estado });
  if (estado === 'desistiu') { // prestações por pagar ficam anuladas
    const ps = await procurarTodos('propina', daEscola(req.escola).concat([{ key: 'Estudante', constraint_type: 'equals', value: i['Estudante'] }, { key: 'Tipo', constraint_type: 'equals', value: 'prestacao' }]));
    for (const p of ps.filter(x => x['Estado'] !== 'paga')) await mudar('propina', p._id, { 'Estado': 'anulada' }).catch(() => {});
  }
  res.json({ ok: true, estado });
}));

// ============================================================
//  ESCOLA DE CONDUÇÃO · PARTE 2: VIATURAS E AULAS PRÁTICAS (v5.1)
//  Bubble:
//   Viatura:      Escola (Escola) · Matricula (text) · Marca Modelo (text) · Categoria (text) · Ano (number)
//                 · Inspecao Ate (date) · Seguro Ate (date) · Activa (yes/no) · Notas (text)
//   Aula Pratica: Escola (Escola) · Estudante (text) · Inscricao (text) · Instrutor (text) · Viatura (text)
//                 · Data (text AAAA-MM-DD) · Inicio (text HH:MM) · Fim (text HH:MM) · Minutos (number)
//                 · Estado (text: marcada | feita | faltou | cancelada) · Notas (text)
// ============================================================
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minDe = h => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
const hhmmDe = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const catCompativel = (viatura, carta) => !viatura || !carta || viatura === carta || (carta === 'A1' && viatura === 'A') || (carta === 'BE' && viatura === 'B') || (carta === 'CE' && viatura === 'C');
function diasAte(iso) { return iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5) : null; }
const viaturaOut = v => ({ id: v._id, matricula: v['Matricula'] || '', modelo: v['Marca Modelo'] || '', categoria: v['Categoria'] || '', ano: v['Ano'] || null,
  inspecao: v['Inspecao Ate'] || null, seguro: v['Seguro Ate'] || null, dias_inspecao: diasAte(v['Inspecao Ate']), dias_seguro: diasAte(v['Seguro Ate']), notas: v['Notas'] || '', activa: v['Activa'] !== false });
app.post('/viaturas', exigeDireccao, rota(async (req, res) => {
  const f = daEscola(req.escola);
  const [vs, aulas] = await Promise.all([procurarTodos('viatura', f), procurarTodos('aulapratica', f, 20000)]);
  res.json({ ok: true, viaturas: vs.filter(v => v['Activa'] !== false).map(v => Object.assign(viaturaOut(v), {
    aulas_feitas: aulas.filter(a => a['Viatura'] === v._id && a['Estado'] === 'feita').length,
    minutos: aulas.filter(a => a['Viatura'] === v._id && a['Estado'] === 'feita').reduce((x, a) => x + Number(a['Minutos'] || 0), 0) })).sort((a, b) => a.matricula.localeCompare(b.matricula)) });
}));
app.post('/viatura-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const mat = txt(b.matricula, 20).toUpperCase().replace(/\s+/g, '-');
  if (mat.length < 5) return erro(res, 400, 'Escreva a matrícula (ex.: AFG-123-MC).');
  const cat = String(b.categoria || '').toUpperCase();
  if (!CATEGORIAS[cat]) return erro(res, 400, 'Escolha a categoria da viatura.');
  const campos = { 'Escola': req.escola, 'Matricula': mat, 'Marca Modelo': txt(b.modelo, 60), 'Categoria': cat, 'Notas': txt(b.notas, 300), 'Activa': true };
  if (b.ano) campos['Ano'] = Math.round(Number(b.ano)) || undefined;
  for (const [k, c] of [['inspecao', 'Inspecao Ate'], ['seguro', 'Seguro Ate']]) if (b[k] && !isNaN(Date.parse(b[k]))) campos[c] = new Date(b[k] + 'T23:59:00Z').toISOString();
  let id = b.id ? String(b.id) : null;
  if (!id) { const ja = (await procurarTodos('viatura', daEscola(req.escola))).find(v => v['Matricula'] === mat && v['Activa'] !== false); if (ja) return erro(res, 409, 'Já existe uma viatura com esta matrícula.'); }
  if (id) { await daMinhaEscola('viatura', id, req.escola); await mudar('viatura', id, campos); } else id = await criar('viatura', campos);
  res.json({ ok: true, id });
}));
app.post('/viatura-apagar', exigeDireccao, rota(async (req, res) => {
  const v = await daMinhaEscola('viatura', String((req.body || {}).id || ''), req.escola);
  await mudar('viatura', v._id, { 'Activa': false });
  res.json({ ok: true });
}));
async function dadosAulas(escola) {
  const f = daEscola(escola);
  const [aulas, profs, vs, ins, ests, cs] = await Promise.all([procurarTodos('aulapratica', f, 20000), procurarTodos('professor', f), procurarTodos('viatura', f), procurarTodos('inscricaoconducao', f), procurarTodos('estudante', f), procurarTodos('cursoconducao', f)]);
  return { aulas, profs, vs, ins, ests, cs, PM: Object.fromEntries(profs.map(p => [p._id, p])), VM: Object.fromEntries(vs.map(v => [v._id, v])), EM: Object.fromEntries(ests.map(e => [e._id, e])), CM: Object.fromEntries(cs.map(c => [c._id, c])), IM: Object.fromEntries(ins.map(i => [i._id, i])) };
}
function aulaOut(a, D) {
  const e = D.EM[a['Estudante']] || {}, p = D.PM[a['Instrutor']] || {}, v = D.VM[a['Viatura']] || {}, i = D.IM[a['Inscricao']] || {};
  return { id: a._id, data: a['Data'], inicio: a['Inicio'], fim: a['Fim'], minutos: Number(a['Minutos'] || 0), estado: a['Estado'] || 'marcada', notas: a['Notas'] || '',
    estudante: a['Estudante'], instruendo: e['Nome'] || '', numero: e['Numero'] || '', telefone: e['Telefone'] || '', categoria: i['Categoria'] || '',
    instrutor_id: a['Instrutor'], instrutor: p['Nome'] || '', viatura_id: a['Viatura'], viatura: v['Matricula'] || '', modelo: v['Marca Modelo'] || '' };
}
function progressoInscricao(i, D) {
  const c = D.CM[i['Curso']] || {}, minhas = D.aulas.filter(a => a['Inscricao'] === i._id);
  return { feitas: minhas.filter(a => a['Estado'] === 'feita').length, faltou: minhas.filter(a => a['Estado'] === 'faltou').length, marcadas: minhas.filter(a => a['Estado'] === 'marcada').length, total: Number(c['Aulas Praticas'] || 0) };
}
app.post('/aulas-praticas', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const de = dataOk(b.de) ? b.de : hojeMZ().data, ate = dataOk(b.ate) ? b.ate : de;
  const D = await dadosAulas(req.escola);
  res.json({ ok: true, de, ate, hoje: hojeMZ().data,
    aulas: D.aulas.filter(a => a['Data'] >= de && a['Data'] <= ate).map(a => aulaOut(a, D)).sort((x, y) => (x.data + x.inicio).localeCompare(y.data + y.inicio)),
    instrutores: D.profs.filter(p => p['Activo'] !== false).map(p => ({ id: p._id, nome: p['Nome'] || '', licenca: p['Licenca Instrutor'] || '' })).sort((x, y) => x.nome.localeCompare(y.nome, 'pt')),
    viaturas: D.vs.filter(v => v['Activa'] !== false).map(viaturaOut),
    inscricoes: D.ins.filter(i => (i['Estado'] || 'activa') === 'activa').map(i => Object.assign({ id: i._id, estudante: i['Estudante'], nome: (D.EM[i['Estudante']] || {})['Nome'] || '', numero: (D.EM[i['Estudante']] || {})['Numero'] || '', categoria: i['Categoria'] || '' }, progressoInscricao(i, D))).sort((x, y) => x.nome.localeCompare(y.nome, 'pt')),
    semana: (() => { const out = []; for (let k = 0; k < 7; k++) { const d = new Date(de + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); const ds = d.toISOString().slice(0, 10); out.push({ data: ds, aulas: D.aulas.filter(a => a['Data'] === ds && a['Estado'] !== 'cancelada').length }); } return out; })() });
}));
async function marcarAula(req, res, b) {
  const D = await dadosAulas(req.escola);
  const i = D.IM[String(b.inscricao || '')];
  if (!i || i['Escola'] !== req.escola) return erro(res, 404, 'Escolha o instruendo.');
  if ((i['Estado'] || 'activa') !== 'activa') return erro(res, 400, 'Esta inscrição já não está em curso.');
  const p = D.PM[String(b.instrutor || '')]; if (!p || p['Escola'] !== req.escola || p['Activo'] === false) return erro(res, 400, 'Escolha o instrutor.');
  const v = D.VM[String(b.viatura || '')]; if (!v || v['Escola'] !== req.escola || v['Activa'] === false) return erro(res, 400, 'Escolha a viatura.');
  if (!dataOk(b.data)) return erro(res, 400, 'Escolha a data.');
  if (b.data < hojeMZ().data) return erro(res, 400, 'Não pode marcar aulas em dias que já passaram.');
  if (!HHMM.test(b.inicio || '')) return erro(res, 400, 'Escolha a hora de início.');
  const dur = Math.max(30, Math.min(240, Math.round(Number(b.duracao) || 60)));
  const ini = minDe(b.inicio), fim = ini + dur;
  if (fim > 22 * 60) return erro(res, 400, 'A aula termina demasiado tarde.');
  if (!catCompativel(v['Categoria'], i['Categoria'])) return erro(res, 400, 'A viatura ' + v['Matricula'] + ' é da categoria ' + v['Categoria'] + ' e o instruendo tira a carta ' + i['Categoria'] + '.');
  if (v['Inspecao Ate'] && new Date(v['Inspecao Ate']).toISOString().slice(0, 10) < b.data) return erro(res, 400, 'A inspecção da viatura ' + v['Matricula'] + ' termina antes desta data. Renove-a primeiro.');
  if (v['Seguro Ate'] && new Date(v['Seguro Ate']).toISOString().slice(0, 10) < b.data) return erro(res, 400, 'O seguro da viatura ' + v['Matricula'] + ' termina antes desta data. Renove-o primeiro.');
  const sobrepoe = D.aulas.filter(a => a['Data'] === b.data && a['Estado'] !== 'cancelada' && a._id !== b.ignorar && minDe(a['Inicio']) < fim && ini < minDe(a['Fim']));
  const c1 = sobrepoe.find(a => a['Instrutor'] === p._id), c2 = sobrepoe.find(a => a['Viatura'] === v._id), c3 = sobrepoe.find(a => a['Estudante'] === i['Estudante']);
  if (c1) return erro(res, 409, p['Nome'] + ' já tem aula das ' + c1['Inicio'] + ' às ' + c1['Fim'] + ' nesse dia.');
  if (c2) return erro(res, 409, 'A viatura ' + v['Matricula'] + ' já está ocupada das ' + c2['Inicio'] + ' às ' + c2['Fim'] + '.');
  if (c3) return erro(res, 409, 'O instruendo já tem aula das ' + c3['Inicio'] + ' às ' + c3['Fim'] + ' nesse dia.');
  const id = await criar('aulapratica', { 'Escola': req.escola, 'Estudante': i['Estudante'], 'Inscricao': i._id, 'Instrutor': p._id, 'Viatura': v._id, 'Data': b.data,
    'Inicio': b.inicio, 'Fim': hhmmDe(fim), 'Minutos': dur, 'Estado': 'marcada', 'Notas': txt(b.notas, 300) });
  // v5.10: depois de esgotadas as aulas do curso, cada aula nova é uma aula extra paga (se o curso tiver preço de aula extra)
  let extra = 0;
  const cur = D.CM[i['Curso']] || {}, incluidas = Number(cur['Aulas Praticas'] || 0), precoExtra = Number(cur['Preco Aula Extra'] || 0);
  const usadas = D.aulas.filter(a => a['Inscricao'] === i._id && ['feita', 'marcada', 'faltou'].includes(a['Estado'])).length;
  if (incluidas > 0 && precoExtra > 0 && usadas >= incluidas) {
    const vz = new Date(b.data + 'T21:59:00Z');
    await criar('propina', { 'Escola': req.escola, 'Estudante': i['Estudante'], 'Ano Lectivo': b.data.slice(0, 4), 'Tipo': 'prestacao', 'Mes': Number(b.data.slice(5, 7)),
      'Descricao': 'Aula prática extra · ' + dmCurto(b.data) + ' ' + b.inicio, 'Valor': precoExtra, 'Vencimento': vz.toISOString(), 'Multa': 0, 'Total': precoExtra, 'Estado': 'aberta' });
    extra = precoExtra;
  }
  let sms = false;
  const e = D.EM[i['Estudante']] || {};
  if (b.sms && tel9(e['Telefone']).length === 9) {
    const esc = await obter('escola', req.escola).catch(() => null);
    const d = new Date(b.data + 'T12:00:00Z'), dia = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'][d.getUTCDay()];
    const r = await enviarSMS([e['Telefone']], ((esc && esc['Nome']) || 'Escola') + ': aula pratica marcada para ' + dia + ' ' + dmCurto(b.data) + ', ' + b.inicio + '-' + hhmmDe(fim) + '. Instrutor ' + (p['Nome'] || '').split(' ')[0] + ', viatura ' + v['Matricula'] + '.' + (extra ? ' Aula extra: ' + extra + ' MT, pague no portal.' : ''));
    sms = r.ok;
  }
  return res.json({ ok: true, id, fim: hhmmDe(fim), sms, extra });
}
app.post('/aula-marcar', exigeDireccao, rota(async (req, res) => marcarAula(req, res, req.body || {})));
app.post('/aula-estado', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, estado = String(b.estado || '');
  if (!['marcada', 'feita', 'faltou', 'cancelada'].includes(estado)) return erro(res, 400, 'Estado inválido.');
  const a = await daMinhaEscola('aulapratica', String(b.id || ''), req.escola);
  if (estado === 'feita' && a['Data'] > hojeMZ().data) return erro(res, 400, 'Esta aula ainda não aconteceu.');
  const mud = { 'Estado': estado }; if (b.notas !== undefined) mud['Notas'] = txt(b.notas, 300);
  await mudar('aulapratica', a._id, mud);
  let sms = false;
  if (estado === 'cancelada' && (a['Estado'] || 'marcada') === 'marcada') {
    // a aula extra que ainda não foi paga deixa de ser devida
    const ps = await procurarTodos('propina', daEscola(req.escola).concat([{ key: 'Estudante', constraint_type: 'equals', value: a['Estudante'] }])).catch(() => []);
    const ref = 'Aula prática extra · ' + dmCurto(a['Data']) + ' ' + a['Inicio'];
    for (const p of ps.filter(x => x['Descricao'] === ref && x['Estado'] !== 'paga')) await mudar('propina', p._id, { 'Estado': 'anulada' }).catch(() => {});
    if (b.sms !== false && a['Data'] >= hojeMZ().data) {
      const [e, esc] = await Promise.all([obter('estudante', a['Estudante']).catch(() => null), obter('escola', req.escola).catch(() => null)]);
      if (e && tel9(e['Telefone']).length === 9) sms = (await enviarSMS([e['Telefone']], ((esc && esc['Nome']) || 'Escola') + ': a sua aula pratica de ' + dmCurto(a['Data']) + ' as ' + a['Inicio'] + ' foi cancelada. A escola vai marcar outra data.')).ok;
    }
  }
  res.json({ ok: true, estado, sms });
}));

// ============================================================
//  ESCOLA DE CONDUÇÃO · PARTE 3: EXAMES, INSTRUTOR E PORTAL (v5.2)
//  Bubble:
//   Exame Conducao: Escola (Escola) · Estudante (text) · Inscricao (text) · Tipo (text: codigo | conducao) · Data (text AAAA-MM-DD)
//                   · Hora (text) · Local (text) · Resultado (text: marcado | aprovado | reprovado | faltou) · Tentativa (number) · Notas (text)
//  Regra: o exame de condução só se marca depois de aprovado no exame de código.
//  Aprovado no exame de condução → a inscrição passa a "concluida" e o instruendo recebe os parabéns por SMS.
// ============================================================
const TIPO_EXAME = { codigo: 'Exame de código', conducao: 'Exame de condução' };
const exameOut = (x, D) => { const e = (D && D.EM[x['Estudante']]) || {}, i = (D && D.IM[x['Inscricao']]) || {};
  return { id: x._id, tipo: x['Tipo'] || 'codigo', tipo_nome: TIPO_EXAME[x['Tipo']] || 'Exame', data: x['Data'] || '', hora: x['Hora'] || '', local: x['Local'] || '', resultado: x['Resultado'] || 'marcado',
    tentativa: Number(x['Tentativa'] || 1), notas: x['Notas'] || '', estudante: x['Estudante'], instruendo: e['Nome'] || '', numero: e['Numero'] || '', categoria: i['Categoria'] || '', inscricao: x['Inscricao'] }; };
app.post('/exames', exigeDireccao, rota(async (req, res) => {
  const [D, xs] = await Promise.all([dadosAulas(req.escola), procurarTodos('exameconducao', daEscola(req.escola), 5000)]);
  const hoje = hojeMZ().data;
  res.json({ ok: true, hoje,
    exames: xs.map(x => exameOut(x, D)).sort((a, b) => (b.data.localeCompare(a.data)) || (b.tentativa - a.tentativa) || b.hora.localeCompare(a.hora)),
    instrutores: taxaPorInstrutor(xs, D),
    inscricoes: D.ins.filter(i => (i['Estado'] || 'activa') === 'activa').map(i => {
      const meus = xs.filter(x => x['Inscricao'] === i._id);
      return Object.assign({ id: i._id, nome: (D.EM[i['Estudante']] || {})['Nome'] || '', numero: (D.EM[i['Estudante']] || {})['Numero'] || '', categoria: i['Categoria'] || '',
        codigo_aprovado: meus.some(x => x['Tipo'] === 'codigo' && x['Resultado'] === 'aprovado') }, progressoInscricao(i, D)); }).sort((a, b) => a.nome.localeCompare(b.nome, 'pt')) });
}));
app.post('/exame-marcar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, tipo = b.tipo === 'conducao' ? 'conducao' : 'codigo';
  const i = await daMinhaEscola('inscricaoconducao', String(b.inscricao || ''), req.escola);
  if ((i['Estado'] || 'activa') !== 'activa') return erro(res, 400, 'Esta inscrição já não está em curso.');
  if (!dataOk(b.data)) return erro(res, 400, 'Escolha a data do exame.');
  if (b.hora && !HHMM.test(b.hora)) return erro(res, 400, 'Hora inválida.');
  const xs = await procurarTodos('exameconducao', daEscola(req.escola).concat([{ key: 'Inscricao', constraint_type: 'equals', value: i._id }]));
  if (xs.some(x => x['Tipo'] === tipo && (x['Resultado'] || 'marcado') === 'marcado')) return erro(res, 409, 'Já há um ' + TIPO_EXAME[tipo].toLowerCase() + ' marcado para este instruendo. Registe primeiro o resultado.');
  if (tipo === 'conducao' && !xs.some(x => x['Tipo'] === 'codigo' && x['Resultado'] === 'aprovado')) return erro(res, 400, 'O instruendo ainda não foi aprovado no exame de código.');
  if (tipo === 'codigo' && xs.some(x => x['Tipo'] === 'codigo' && x['Resultado'] === 'aprovado')) return erro(res, 400, 'O instruendo já foi aprovado no exame de código.');
  if (!b.forcar) {
    const divida = await dividaDe(req.escola, i['Estudante']);
    if (divida > 0) return res.status(409).json({ ok: false, divida, erro: 'O instruendo tem ' + mt(divida) + ' de prestações em atraso.' });
  }
  const tentativa = xs.filter(x => x['Tipo'] === tipo && ['aprovado', 'reprovado', 'faltou'].includes(x['Resultado'])).length + 1;
  const id = await criar('exameconducao', { 'Escola': req.escola, 'Estudante': i['Estudante'], 'Inscricao': i._id, 'Tipo': tipo, 'Data': b.data, 'Hora': b.hora || '', 'Local': txt(b.local, 80), 'Resultado': 'marcado', 'Tentativa': tentativa, 'Notas': txt(b.notas, 300) });
  let sms = false;
  if (b.sms) {
    const [e, esc] = await Promise.all([obter('estudante', i['Estudante']).catch(() => null), obter('escola', req.escola).catch(() => null)]);
    if (e && tel9(e['Telefone']).length === 9) sms = (await enviarSMS([e['Telefone']], ((esc && esc['Nome']) || 'Escola') + ': ' + TIPO_EXAME[tipo].toLowerCase() + ' da carta ' + i['Categoria'] + ' marcado para ' + dmCurto(b.data) + (b.hora ? ' as ' + b.hora : '') + (b.local ? ', ' + txt(b.local, 60) : '') + '. Leve o BI. Boa sorte!')).ok;
  }
  res.json({ ok: true, id, tentativa, sms });
}));
app.post('/exame-resultado', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, r = String(b.resultado || '');
  if (!['marcado', 'aprovado', 'reprovado', 'faltou'].includes(r)) return erro(res, 400, 'Resultado inválido.');
  const x = await daMinhaEscola('exameconducao', String(b.id || ''), req.escola);
  if (r !== 'marcado' && x['Data'] > hojeMZ().data) return erro(res, 400, 'O exame ainda não aconteceu.');
  await mudar('exameconducao', x._id, { 'Resultado': r });
  let concluida = false, sms = false;
  if (x['Tipo'] === 'conducao' && r === 'aprovado') {
    await mudar('inscricaoconducao', x['Inscricao'], { 'Estado': 'concluida' }).catch(() => {});
    concluida = true;
    const [e, esc, i] = await Promise.all([obter('estudante', x['Estudante']).catch(() => null), obter('escola', req.escola).catch(() => null), obter('inscricaoconducao', x['Inscricao']).catch(() => null)]);
    if (e && tel9(e['Telefone']).length === 9) sms = (await enviarSMS([e['Telefone']], ((esc && esc['Nome']) || 'Escola') + ': parabens, ' + String(e['Nome'] || '').split(' ')[0] + '! Foi aprovado no exame de conducao da carta ' + ((i && i['Categoria']) || '') + '. Boa estrada!')).ok;
  }
  cachePainel.delete(req.escola);
  res.json({ ok: true, resultado: r, concluida, sms });
}));

// ---------- instrutor: as suas aulas práticas ----------
async function praticasDoInstrutor(escola, profId) {
  const f = daEscola(escola);
  const aps = (await procurarTodos('aulapratica', f.concat([{ key: 'Instrutor', constraint_type: 'equals', value: profId }]), 5000));
  if (!aps.length) return null;
  const D = await dadosAulas(escola);
  const hoje = hojeMZ().data, ate = hojeMZ(7).data, antes = hojeMZ(-7).data;
  return { hoje, aulas: aps.filter(a => a['Data'] >= antes && a['Data'] <= ate && a['Estado'] !== 'cancelada').map(a => aulaOut(a, D)).sort((x, y) => (x.data + x.inicio).localeCompare(y.data + y.inicio)),
    feitas_mes: aps.filter(a => a['Estado'] === 'feita' && String(a['Data']).slice(0, 7) === hoje.slice(0, 7)).length };
}
app.post('/prof/aula-estado', exigeProfessor, rota(async (req, res) => {
  const b = req.body || {}, estado = String(b.estado || '');
  if (!['feita', 'faltou', 'marcada'].includes(estado)) return erro(res, 400, 'Estado inválido.');
  const a = await daMinhaEscola('aulapratica', String(b.id || ''), req.escola);
  if (a['Instrutor'] !== req.sessao.u) return erro(res, 403, 'Esta aula não é sua.');
  if (a['Estado'] === 'cancelada') return erro(res, 400, 'Esta aula foi cancelada pela escola.');
  if (estado !== 'marcada' && a['Data'] > hojeMZ().data) return erro(res, 400, 'Esta aula ainda não aconteceu.');
  if (a['Data'] < hojeMZ(-7).data) return erro(res, 400, 'Só pode corrigir aulas dos últimos 7 dias. Fale com a escola.');
  const mud = { 'Estado': estado }; if (b.notas !== undefined) mud['Notas'] = txt(b.notas, 300);
  await mudar('aulapratica', a._id, mud);
  res.json({ ok: true, estado });
}));

// ============================================================
//  ESCOLA DE CONDUÇÃO · PARTE 4 (v5.10)
//  Treino do código · lembretes por SMS · processo e documentos · aulas teóricas · regras
//  Bubble, tabelas novas:
//   Pergunta Codigo: Escola (Escola) · Base (text) · Tema (text) · Pergunta (text) · Opcoes (text) · Correcta (number)
//                    · Explicacao (text) · Imagem (text) · Activa (yes/no)
//   Teste Codigo:    Escola (Escola) · Estudante (text) · Inscricao (text) · Data (date) · Acertos (number) · Total (number) · Erradas (text)
//   Aula Teorica:    Escola (Escola) · Data (text) · Inicio (text) · Tema (text) · Instrutor (text) · Presentes (text)
//  Bubble, campos novos:
//   Aula Pratica: Lembrete (yes/no) · Exame Conducao: Lembrete (yes/no)
//   Inscricao Conducao: Documentos (text) · Processo (text) · Licenca Numero (text) · Licenca Validade (date)
//   Curso Conducao: Preco Aula Extra (number) · Escola: Docs Conducao (text)
//  Render (opcionais): LEMBRETES_HORA (por defeito 18) · CODIGO_PRONTO (% para "pronto para o exame", por defeito 80)
// ============================================================

// ---------- treino do código ----------
//  Banco de base do Gescolar: perguntas gerais de segurança e sinalização, sem números de lei (velocidades, taxas de álcool),
//  para a escola completar com as suas. A escola pode esconder qualquer pergunta de base e criar as próprias.
const BANCO_CODIGO = [
  { id: 'g01', t: 'Sinais', i: 'stop', p: 'O que deve fazer perante este sinal?', o: ['Abrandar e passar se não vier ninguém', 'Parar sempre e só avançar quando for seguro', 'Buzinar e seguir'], c: 1, e: 'O sinal STOP obriga a parar sempre, mesmo que não venha ninguém. Só depois de parar avança, quando for seguro.' },
  { id: 'g02', t: 'Sinais', i: 'ceder', p: 'O que indica este sinal?', o: ['Cedência de passagem', 'Proibido parar', 'Fim de prioridade da estrada'], c: 0, e: 'O triângulo invertido de bordo vermelho manda ceder a passagem aos veículos da outra via. Não obriga a parar se a via estiver livre.' },
  { id: 'g03', t: 'Sinais', i: 'sentido_proibido', p: 'O que indica este sinal?', o: ['Estacionamento proibido', 'Sentido proibido: não pode entrar nesta via', 'Estrada com prioridade'], c: 1, e: 'O disco vermelho com uma barra branca horizontal é o sentido proibido. Não pode entrar na via por esse lado.' },
  { id: 'g04', t: 'Sinais', i: 'perigo', p: 'Os sinais triangulares com bordo vermelho, com o vértice para cima, indicam:', o: ['Um perigo à frente', 'Uma obrigação', 'Um serviço (bomba, hospital)'], c: 0, e: 'Os triângulos com bordo vermelho são sinais de perigo: avisam de uma situação que exige atenção redobrada e, normalmente, abrandar.' },
  { id: 'g05', t: 'Sinais', i: 'proibicao', p: 'Os sinais circulares com bordo vermelho indicam, em regra:', o: ['Perigo', 'Proibição', 'Informação turística'], c: 1, e: 'Os sinais redondos com bordo vermelho proíbem alguma coisa: entrar, virar, ultrapassar, estacionar, entre outras.' },
  { id: 'g06', t: 'Regras', p: 'Em Moçambique, os veículos circulam:', o: ['Pela esquerda', 'Pela direita', 'Pelo centro da faixa'], c: 0, e: 'Moçambique tem circulação pela esquerda. Mantenha-se o mais à esquerda possível da sua faixa.' },
  { id: 'g07', t: 'Regras', p: 'Numa estrada com circulação pela esquerda, a ultrapassagem faz-se normalmente:', o: ['Pela direita do veículo que vai ultrapassar', 'Pela esquerda do veículo que vai ultrapassar', 'Por qualquer lado, desde que seja rápido'], c: 0, e: 'Com circulação pela esquerda, ultrapassa-se pela direita, depois de verificar espelhos, sinalizar e confirmar que há espaço e visibilidade.' },
  { id: 'g08', t: 'Regras', p: 'Numa rotunda, em Moçambique, circula-se:', o: ['No sentido dos ponteiros do relógio', 'No sentido contrário aos ponteiros do relógio', 'No sentido que tiver menos trânsito'], c: 0, e: 'Com circulação pela esquerda, contorna-se a rotunda no sentido dos ponteiros do relógio.' },
  { id: 'g09', t: 'Semáforos', i: 'semaforo_vermelho', p: 'Com a luz vermelha acesa, deve:', o: ['Parar antes da linha de paragem', 'Passar devagar se não vier ninguém', 'Buzinar e avançar'], c: 0, e: 'A luz vermelha obriga a parar antes da linha de paragem e esperar pela luz verde.' },
  { id: 'g10', t: 'Semáforos', i: 'semaforo_amarelo', p: 'A luz amarela fixa acende-se quando está a chegar ao semáforo. Deve:', o: ['Acelerar para passar antes do vermelho', 'Parar, a não ser que já esteja tão perto que não consiga parar em segurança', 'Avançar sempre, porque ainda não está vermelho'], c: 1, e: 'O amarelo fixo manda parar. Só pode continuar se já estiver tão perto que uma travagem brusca seria perigosa.' },
  { id: 'g11', t: 'Regras', p: 'Antes de mudar de faixa ou de direcção, deve:', o: ['Sinalizar com o pisca com antecedência e confirmar nos espelhos', 'Sinalizar só depois de mudar', 'Não precisa de sinalizar se não vir ninguém'], c: 0, e: 'Sinalize sempre com antecedência e confirme espelhos e ângulo morto antes de mudar de faixa ou de direcção.' },
  { id: 'g12', t: 'Regras', p: 'Uma linha contínua no meio da estrada significa que:', o: ['Não a pode pisar nem transpor', 'Pode ultrapassar se tiver pressa', 'Indica um lugar de estacionamento'], c: 0, e: 'A linha contínua não pode ser pisada nem transposta. Normalmente marca zonas onde ultrapassar é perigoso.' },
  { id: 'g13', t: 'Regras', p: 'É proibido parar ou estacionar:', o: ['Em curvas e lombas com pouca visibilidade', 'Num parque de estacionamento', 'Numa garagem própria'], c: 0, e: 'Parar em curvas e lombas sem visibilidade obriga os outros a desviar sem ver o que vem, e causa acidentes graves.' },
  { id: 'g14', t: 'Peões', p: 'Um peão está a atravessar na passadeira. Deve:', o: ['Buzinar para ele se apressar', 'Parar e deixá-lo atravessar em segurança', 'Contorná-lo devagar'], c: 1, e: 'Na passadeira, o peão que já está a atravessar tem sempre de ser respeitado: pare e espere que termine.' },
  { id: 'g15', t: 'Regras', p: 'Ouve a sirene de uma ambulância em marcha de urgência atrás de si. Deve:', o: ['Facilitar a passagem, encostando-se quando for seguro', 'Manter a velocidade e a faixa', 'Acelerar para ficar à frente dela'], c: 0, e: 'Os veículos de emergência com sinais luminosos e sonoros ligados têm prioridade. Facilite a passagem sem manobras bruscas.' },
  { id: 'g16', t: 'Segurança', p: 'Quem deve usar o cinto de segurança?', o: ['Só o condutor', 'O condutor e todos os passageiros, nos lugares com cinto', 'Só os passageiros da frente'], c: 1, e: 'O cinto protege todos os ocupantes. Num choque, um passageiro de trás sem cinto pode ferir gravemente quem vai à frente.' },
  { id: 'g17', t: 'Segurança', p: 'Pode segurar o telemóvel na mão enquanto conduz?', o: ['Não', 'Sim, em rectas', 'Sim, se for uma chamada curta'], c: 0, e: 'Segurar o telemóvel tira as mãos e a atenção da condução. É proibido e é uma das grandes causas de acidentes.' },
  { id: 'g18', t: 'Segurança', p: 'O álcool, mesmo em pouca quantidade:', o: ['Melhora os reflexos', 'Aumenta o tempo de reacção e prejudica a condução', 'Não tem efeito se a pessoa tiver comido'], c: 1, e: 'O álcool atrasa as reacções, reduz a visão e dá falsa confiança. A única forma segura é não beber antes de conduzir.' },
  { id: 'g19', t: 'Segurança', p: 'Para que serve a distância de segurança ao veículo da frente?', o: ['Para conseguir parar sem bater se ele travar de repente', 'Para ultrapassar mais depressa', 'Não tem utilidade dentro das cidades'], c: 0, e: 'A distância de segurança dá-lhe tempo para reagir e travar. Deve ser maior com chuva, à noite e a velocidades mais altas.' },
  { id: 'g20', t: 'Segurança', p: 'Com chuva forte, deve:', o: ['Reduzir a velocidade e aumentar a distância de segurança', 'Manter a velocidade, com os máximos ligados', 'Travar a fundo nas curvas'], c: 0, e: 'Com chuva, o piso escorrega e a visibilidade diminui: a distância de travagem aumenta. Abrande e afaste-se do veículo da frente.' },
  { id: 'g21', t: 'Segurança', p: 'Numa viagem longa, começa a sentir sono. O que deve fazer?', o: ['Abrir a janela e continuar', 'Parar num local seguro e descansar', 'Acelerar para chegar mais cedo'], c: 1, e: 'O sono ao volante é muito perigoso. Abrir a janela ou pôr música não resolve: pare num local seguro e descanse.' },
  { id: 'g22', t: 'Segurança', p: 'Pneus muito gastos:', o: ['Aumentam a distância de travagem e o risco de derrapar', 'Não afectam a condução', 'Melhoram a aderência'], c: 0, e: 'Pneus gastos agarram menos ao piso, sobretudo com chuva. Verifique o estado e a pressão com regularidade.' },
  { id: 'g23', t: 'Segurança', p: 'Antes de arrancar com o veículo, deve:', o: ['Verificar os espelhos e o ângulo morto', 'Buzinar para avisar', 'Acelerar a fundo'], c: 0, e: 'Antes de arrancar, confirme espelhos e ângulo morto: peões, motas e bicicletas podem estar escondidos.' },
  { id: 'g24', t: 'Segurança', p: 'Crianças pequenas devem viajar:', o: ['Ao colo de um passageiro da frente', 'Numa cadeira ou sistema de retenção adequado à idade, no banco de trás', 'Soltas no banco de trás'], c: 1, e: 'Ao colo, num choque, a criança é projectada. Use sempre um sistema de retenção adequado, de preferência no banco de trás.' },
  { id: 'g25', t: 'Segurança', p: 'À noite, ao cruzar-se com outro veículo, deve:', o: ['Passar dos máximos para os médios', 'Manter os máximos ligados', 'Desligar as luzes'], c: 0, e: 'Os máximos encandeiam quem vem de frente. Mude para os médios ao cruzar-se ou ao seguir outro veículo de perto.' },
  { id: 'g26', t: 'Segurança', p: 'Vê gado a atravessar a estrada. Deve:', o: ['Abrandar e, se for preciso, parar até a estrada estar livre', 'Buzinar e passar entre os animais', 'Acelerar para passar antes deles'], c: 0, e: 'Os animais têm reacções imprevisíveis. Abrande, pare se for preciso e só avance com a estrada livre.' },
  { id: 'g27', t: 'Avarias', p: 'O carro avariou na estrada. Para avisar os outros condutores, deve:', o: ['Colocar o triângulo de pré-sinalização bem visível, antes do carro', 'Deixar o carro sem qualquer aviso', 'Pôr só o rádio alto'], c: 0, e: 'O triângulo de pré-sinalização avisa os outros com antecedência. Ligue também os quatro piscas e saia do carro pelo lado seguro.' },
  { id: 'g28', t: 'Primeiros socorros', p: 'Chega a um acidente com feridos. A primeira coisa a fazer é:', o: ['Tirar logo os feridos dos carros', 'Sinalizar o local, proteger-se e pedir ajuda', 'Dar água aos feridos'], c: 1, e: 'Primeiro evite um segundo acidente: sinalize e proteja-se. Depois peça ajuda. Não mexa nos feridos sem necessidade.' },
  { id: 'g29', t: 'Primeiros socorros', p: 'Um ferido pode ter uma lesão na coluna. Deve:', o: ['Sentá-lo para respirar melhor', 'Não o mexer, a não ser que haja perigo imediato, como fogo', 'Levantá-lo e levá-lo a andar'], c: 1, e: 'Mexer num ferido com lesão na coluna pode causar paralisia. Só o retire se houver perigo imediato.' },
  { id: 'g30', t: 'Motociclos', p: 'Num motociclo, o capacete deve ser usado por:', o: ['Só o condutor', 'O condutor e o passageiro', 'Ninguém, dentro das cidades'], c: 1, e: 'O capacete protege a cabeça de quem conduz e de quem vai atrás. Use-o sempre, bem apertado.' }
];
const SINAIS_CODIGO = ['stop', 'ceder', 'sentido_proibido', 'perigo', 'proibicao', 'semaforo_vermelho', 'semaforo_amarelo'];
const CODIGO_PRONTO = Math.max(50, Math.min(100, Number(process.env.CODIGO_PRONTO || 80)));
const CODIGO_PERGUNTAS = 20;
const lerJSON = (t, padrao) => { try { const v = JSON.parse(t || ''); return v == null ? padrao : v; } catch (e) { return padrao; } };
async function bancoCodigo(escola) {
  const linhas = await procurarTodos('perguntacodigo', daEscola(escola), 3000).catch(() => []);
  const ocultas = new Set(linhas.filter(x => x['Base'] && x['Activa'] === false).map(x => x['Base']));
  const base = BANCO_CODIGO.map(q => ({ id: q.id, base: true, tema: q.t, pergunta: q.p, opcoes: q.o, correcta: q.c, explicacao: q.e, imagem: q.i || '', activa: !ocultas.has(q.id) }));
  const proprias = linhas.filter(x => !x['Base']).map(x => {
    const o = lerJSON(x['Opcoes'], []);
    return { id: x._id, base: false, tema: x['Tema'] || 'Geral', pergunta: x['Pergunta'] || '', opcoes: Array.isArray(o) ? o.map(String) : [], correcta: Number(x['Correcta'] || 0), explicacao: x['Explicacao'] || '', imagem: x['Imagem'] || '', activa: x['Activa'] !== false };
  }).filter(q => q.opcoes.length >= 2 && q.pergunta);
  return base.concat(proprias);
}
const pctDe = t => Number(t['Total'] || 0) ? Math.round(Number(t['Acertos'] || 0) * 100 / Number(t['Total'])) : 0;
function resumoCodigo(testes) {
  const L = testes.slice().sort((a, b) => String(b['Data'] || b['Created Date'] || '').localeCompare(String(a['Data'] || a['Created Date'] || '')));
  const ult3 = L.slice(0, 3).map(pctDe), media = ult3.length ? Math.round(ult3.reduce((a, b) => a + b, 0) / ult3.length) : null;
  return { testes: L.length, ultimo: L[0] ? { pct: pctDe(L[0]), data: L[0]['Data'] || L[0]['Created Date'] || null } : null, media, pronto: L.length >= 3 && media >= CODIGO_PRONTO, alvo: CODIGO_PRONTO };
}
app.post('/codigo-perguntas', exigeDireccao, rota(async (req, res) => {
  const L = await bancoCodigo(req.escola);
  res.json({ ok: true, perguntas: L, sinais: SINAIS_CODIGO, activas: L.filter(q => q.activa).length, por_teste: CODIGO_PERGUNTAS });
}));
app.post('/codigo-pergunta-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const pergunta = txt(b.pergunta, 400), opcoes = (Array.isArray(b.opcoes) ? b.opcoes : []).map(o => txt(o, 200)).filter(Boolean);
  if (pergunta.length < 8) return erro(res, 400, 'Escreva a pergunta.');
  if (opcoes.length < 2 || opcoes.length > 4) return erro(res, 400, 'Escreva entre 2 e 4 respostas.');
  const correcta = Math.round(Number(b.correcta));
  if (!(correcta >= 0 && correcta < opcoes.length)) return erro(res, 400, 'Escolha qual é a resposta certa.');
  const imagem = txt(b.imagem, 500);
  if (imagem && !SINAIS_CODIGO.includes(imagem) && !/^https:\/\/\S+$/i.test(imagem)) return erro(res, 400, 'A imagem tem de ser um dos sinais da lista ou um endereço que comece por https://');
  const campos = { 'Escola': req.escola, 'Base': '', 'Tema': txt(b.tema, 40) || 'Geral', 'Pergunta': pergunta, 'Opcoes': JSON.stringify(opcoes), 'Correcta': correcta, 'Explicacao': txt(b.explicacao, 600), 'Imagem': imagem, 'Activa': true };
  let id = b.id ? String(b.id) : null;
  if (id) { const x = await daMinhaEscola('perguntacodigo', id, req.escola); if (x['Base']) return erro(res, 400, 'As perguntas de base não se editam: esconda-a e crie uma sua.'); await mudar('perguntacodigo', id, campos); }
  else id = await criar('perguntacodigo', campos);
  res.json({ ok: true, id });
}));
app.post('/codigo-pergunta-estado', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, id = String(b.id || ''), activa = b.activa !== false;
  if (BANCO_CODIGO.some(q => q.id === id)) {
    const ja = (await procurarTodos('perguntacodigo', daEscola(req.escola).concat([{ key: 'Base', constraint_type: 'equals', value: id }]))).filter(x => x['Escola'] === req.escola)[0];
    if (ja) await mudar('perguntacodigo', ja._id, { 'Activa': activa });
    else if (!activa) await criar('perguntacodigo', { 'Escola': req.escola, 'Base': id, 'Activa': false, 'Pergunta': '(pergunta de base escondida)' });
  } else {
    const x = await daMinhaEscola('perguntacodigo', id, req.escola);
    await mudar('perguntacodigo', x._id, { 'Activa': activa });
  }
  res.json({ ok: true, activa });
}));
app.post('/codigo-resultados', exigeDireccao, rota(async (req, res) => {
  const f = daEscola(req.escola);
  const [ins, ests, ts] = await Promise.all([procurarTodos('inscricaoconducao', f), procurarTodos('estudante', f), procurarTodos('testecodigo', f, 20000).catch(() => [])]);
  const EM = Object.fromEntries(ests.map(e => [e._id, e]));
  const mes = hojeMZ().data.slice(0, 7);
  res.json({ ok: true, alvo: CODIGO_PRONTO, testes_mes: ts.filter(t => String(t['Data'] || t['Created Date'] || '').slice(0, 7) === mes).length,
    instruendos: ins.filter(i => (i['Estado'] || 'activa') === 'activa').map(i => Object.assign({ id: i._id, nome: (EM[i['Estudante']] || {})['Nome'] || '', numero: (EM[i['Estudante']] || {})['Numero'] || '', categoria: i['Categoria'] || '' },
      resumoCodigo(ts.filter(t => t['Inscricao'] === i._id)))).sort((a, b) => (b.media == null ? -1 : b.media) - (a.media == null ? -1 : a.media) || a.nome.localeCompare(b.nome, 'pt')) });
}));
async function inscricaoActivaDe(escola, estId) {
  const l = await procurarTodos('inscricaoconducao', daEscola(escola).concat([{ key: 'Estudante', constraint_type: 'equals', value: estId }]));
  return l.filter(i => (i['Estado'] || 'activa') === 'activa')[0] || null;
}
function embaralhar(a) { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; }
app.post('/p/codigo-teste', exigePortal, rota(async (req, res) => {
  const est = String((req.body || {}).estudante || '');
  if (!req.educandos.includes(est)) return erro(res, 403, 'Este instruendo não pertence a esta conta.');
  if (travao('codigo|' + est, 30, 60)) return erro(res, 429, 'Já fez muitos testes na última hora. Descanse um pouco e volte mais tarde.');
  const i = await exigeAcessoCodigo(req, est);
  const L = (await bancoCodigo(req.escola)).filter(q => q.activa);
  if (L.length < 5) return erro(res, 400, 'A escola ainda está a preparar as perguntas do código.');
  const escolhidas = embaralhar(L).slice(0, CODIGO_PERGUNTAS);
  const token = assinar({ u: est, t: 'codigo', i: i._id, q: escolhidas.map(q => q.id) }, 1);
  res.json({ ok: true, token, perguntas: escolhidas.map(q => ({ id: q.id, tema: q.tema, pergunta: q.pergunta, opcoes: q.opcoes, imagem: q.imagem })) });
}));
app.post('/p/codigo-corrigir', exigePortal, rota(async (req, res) => {
  const b = req.body || {}, est = String(b.estudante || '');
  if (!req.educandos.includes(est)) return erro(res, 403, 'Este instruendo não pertence a esta conta.');
  const t = verificar(String(b.token || ''));
  if (!t || t.t !== 'codigo' || t.u !== est || !Array.isArray(t.q)) return erro(res, 400, 'Este teste expirou. Comece um novo.');
  const M = Object.fromEntries((await bancoCodigo(req.escola)).map(q => [q.id, q]));
  const resp = (b.respostas && typeof b.respostas === 'object') ? b.respostas : {};
  const correccao = t.q.map(id => M[id]).filter(Boolean).map(q => {
    const r = resp[q.id], esc = (r === null || r === undefined || r === '') ? null : Number(r);
    return { id: q.id, tema: q.tema, pergunta: q.pergunta, opcoes: q.opcoes, imagem: q.imagem, explicacao: q.explicacao, certa: q.correcta, escolhida: esc, acertou: esc === q.correcta };
  });
  const acertos = correccao.filter(x => x.acertou).length, total = correccao.length;
  let guardado = true;
  try {
    await criar('testecodigo', { 'Escola': req.escola, 'Estudante': est, 'Inscricao': t.i, 'Data': new Date().toISOString(), 'Acertos': acertos, 'Total': total, 'Erradas': JSON.stringify(correccao.filter(x => !x.acertou).map(x => x.id)) });
  } catch (e) { guardado = false; console.error('[codigo] não guardou o teste:', e.message); }
  const ts = await procurarTodos('testecodigo', daEscola(req.escola).concat([{ key: 'Inscricao', constraint_type: 'equals', value: t.i }])).catch(() => []);
  res.json({ ok: true, acertos, total, pct: total ? Math.round(acertos * 100 / total) : 0, correccao, guardado, resumo: resumoCodigo(ts) });
}));


// ---------- lições do código (v5.11) ----------
//  Bubble: Licao Codigo: Escola (Escola) · Base (text) · Tema (text) · Titulo (text) · Texto (text) · Ordem (number) · Activa (yes/no)
//          Escola: Codigo Acesso (text: gratis | pago) · Codigo Preco (number)
//          Inscricao Conducao: Codigo Acesso (text: vazio = como a escola | gratis | pago)
//  Cada lição junta o texto e as perguntas com o mesmo Tema. Só instruendos, instrutores e Direcção de escolas de condução.
//  O Código da Estrada de Moçambique está em revisão: as lições de base não trazem limites nem valores; a escola acrescenta os que estão em vigor.
const LICOES_BASE = [
  { id: 'l01', t: 'Sinais', o: 1, ti: 'Sinais de trânsito: formas e cores', x:
'Os sinais falam pela forma e pela cor. Reconhecer a forma de longe dá-lhe tempo para reagir antes de conseguir ler o símbolo.\n\n' +
'- Triângulo com bordo vermelho e vértice para cima: perigo. Avisa de uma curva, de um cruzamento, de peões, de animais ou de obras. Abrande e prepare-se.\n' +
'- Círculo com bordo vermelho: proibição. Proíbe entrar, virar, ultrapassar, parar ou estacionar, entre outras.\n' +
'- Disco vermelho com barra branca: sentido proibido. Não pode entrar na via por esse lado.\n' +
'- Octógono vermelho com a palavra STOP: paragem obrigatória. Pare sempre, mesmo sem trânsito, e só depois avance com segurança.\n' +
'- Triângulo com o vértice para baixo: cedência de passagem. Deixe passar os veículos da outra via; se estiver livre, não precisa de parar.\n\n' +
'Os sinais de obrigação, de indicação e de informação têm formas e cores próprias. O seu instrutor mostra-lhe os modelos usados em Moçambique.\n\n' +
'Lembre-se: as ordens de um agente de trânsito estão acima dos sinais e das regras gerais. Se o agente mandar avançar com o semáforo vermelho, obedeça ao agente.' },
  { id: 'l02', t: 'Semáforos', o: 2, ti: 'Semáforos', x:
'- Vermelho: pare antes da linha de paragem e espere.\n' +
'- Amarelo fixo: pare. Só pode continuar se já estiver tão perto que uma travagem brusca seria perigosa.\n' +
'- Verde: pode avançar, mas com atenção. O verde não lhe dá o direito de atropelar quem ainda está a atravessar o cruzamento ou a passadeira.\n\n' +
'Quando o semáforo está desligado ou avariado, valem os sinais verticais do cruzamento e as regras de prioridade. Aproxime-se devagar e esteja pronto para parar.\n\n' +
'Nunca acelere para «apanhar» o amarelo: é uma das causas mais comuns de choques nos cruzamentos.' },
  { id: 'l03', t: 'Regras', o: 3, ti: 'Regras de circulação', x:
'Em Moçambique circula-se pela esquerda. Mantenha-se o mais à esquerda possível da sua faixa, deixando espaço para quem ultrapassa.\n\n' +
'Ultrapassagem\n' +
'- Faz-se pela direita do veículo ultrapassado.\n' +
'- Antes: verifique os espelhos e o ângulo morto, confirme que tem visibilidade e espaço, e sinalize com o pisca.\n' +
'- Não ultrapasse em curvas, lombas, passadeiras, cruzamentos ou onde haja linha contínua.\n\n' +
'Rotundas: contornam-se no sentido dos ponteiros do relógio. Sinalize a saída.\n\n' +
'Mudanças de direcção e de faixa: sinalize com antecedência e confirme os espelhos. Sinalizar não lhe dá prioridade: só avança quando for seguro.\n\n' +
'Marcas no pavimento: a linha contínua não pode ser pisada nem transposta; a linha descontínua pode ser transposta quando for seguro.\n\n' +
'Parar e estacionar: é proibido em curvas e lombas sem visibilidade, nas passadeiras, nos cruzamentos e onde os sinais o proíbam.\n\n' +
'Velocidade: ajuste sempre a velocidade às condições da via, do tempo e do trânsito, mesmo abaixo do limite. Os limites de velocidade em vigor são dados pelo seu instrutor, de acordo com o Código da Estrada.' },
  { id: 'l04', t: 'Peões', o: 4, ti: 'Peões e utilizadores vulneráveis', x:
'Peões, ciclistas e motociclistas não têm a protecção de uma carroçaria. Um pequeno toque pode ser fatal.\n\n' +
'- Na passadeira, o peão que está a atravessar tem de ser respeitado: pare e espere que termine.\n' +
'- Junto a escolas, mercados, paragens de chapa e machimbombo, abrande: há pessoas a atravessar fora da passadeira.\n' +
'- Crianças podem correr para a estrada sem olhar. Idosos e pessoas com deficiência atravessam mais devagar.\n' +
'- Ao ultrapassar uma bicicleta, deixe bastante espaço lateral.\n' +
'- À noite, peões com roupa escura são difíceis de ver: reduza a velocidade nas zonas habitadas.' },
  { id: 'l05', t: 'Segurança', o: 5, ti: 'Segurança ao volante', x:
'Cinto e crianças\n' +
'- Todos os ocupantes usam cinto nos lugares que o têm.\n' +
'- Crianças viajam num sistema de retenção adequado à idade, de preferência no banco de trás, nunca ao colo.\n\n' +
'Atenção\n' +
'- Não segure o telemóvel a conduzir.\n' +
'- O álcool e as drogas atrasam as reacções e dão falsa confiança. Se vai conduzir, não beba.\n' +
'- O sono mata: numa viagem longa, pare e descanse.\n\n' +
'Distância e tempo\n' +
'- Mantenha distância de segurança ao veículo da frente: é o que lhe permite travar a tempo.\n' +
'- Com chuva, à noite ou com piso de terra, aumente a distância e reduza a velocidade.\n\n' +
'Luzes: use os médios ao cruzar-se com outro veículo ou ao seguir alguém de perto; os máximos encandeiam.\n\n' +
'Veículo: pneus gastos, travões fracos ou luzes fundidas aumentam o risco. Verifique-os com regularidade.\n\n' +
'Animais na via: abrande e, se for preciso, pare até a estrada estar livre.' },
  { id: 'l06', t: 'Avarias', o: 6, ti: 'Avarias na estrada', x:
'Se o veículo avariar:\n' +
'- Tente tirá-lo da faixa de rodagem.\n' +
'- Ligue os quatro piscas.\n' +
'- Coloque o triângulo de pré-sinalização bem visível, antes do veículo, para avisar quem vem atrás.\n' +
'- Saia pelo lado seguro e afaste os passageiros da estrada.\n' +
'- À noite, torne-se visível. Confirme com o instrutor o equipamento obrigatório no veículo.' },
  { id: 'l07', t: 'Primeiros socorros', o: 7, ti: 'Acidentes e primeiros socorros', x:
'Num acidente, siga a ordem: proteger, alertar, socorrer.\n\n' +
'- Proteger: sinalize o local e proteja-se, para não haver um segundo acidente.\n' +
'- Alertar: peça ajuda. Guarde no telemóvel os números de emergência da sua zona.\n' +
'- Socorrer: não mexa nos feridos sem necessidade. Uma lesão na coluna pode piorar. Só os retire se houver perigo imediato, como fogo.\n\n' +
'Enquanto a ajuda não chega: fale com o ferido, mantenha-o quente e não lhe dê de beber. Num motociclista ferido, não tire o capacete, a não ser que ele não consiga respirar.' },
  { id: 'l08', t: 'Motociclos', o: 8, ti: 'Motociclos', x:
'- O capacete, bem apertado, é para o condutor e para o passageiro.\n' +
'- As motas são difíceis de ver: circule com as luzes ligadas e fique fora do ângulo morto dos carros e camiões.\n' +
'- Não circule entre filas de carros nem faça ultrapassagens arriscadas.\n' +
'- Com chuva ou areia na estrada, trave com suavidade: a mota escorrega com facilidade.\n' +
'- Leve só os passageiros e a carga que a mota pode transportar com segurança.' }
];
async function licoesCodigo(escola) {
  const linhas = await procurarTodos('licaocodigo', daEscola(escola), 500).catch(() => []);
  const ocultas = new Set(linhas.filter(x => x['Base'] && x['Activa'] === false).map(x => x['Base']));
  const base = LICOES_BASE.map(l => ({ id: l.id, base: true, tema: l.t, titulo: l.ti, texto: l.x, ordem: l.o, activa: !ocultas.has(l.id) }));
  const proprias = linhas.filter(x => !x['Base'] && x['Titulo']).map(x => ({ id: x._id, base: false, tema: x['Tema'] || 'Geral', titulo: x['Titulo'] || '', texto: x['Texto'] || '', ordem: Number(x['Ordem'] || 50), activa: x['Activa'] !== false }));
  return base.concat(proprias).sort((a, b) => a.ordem - b.ordem || a.titulo.localeCompare(b.titulo, 'pt'));
}
// material de estudo: lições activas com as perguntas do mesmo tema (com a resposta certa, porque é para estudar)
async function materialCodigo(escola) {
  const [ls, qs] = await Promise.all([licoesCodigo(escola), bancoCodigo(escola)]);
  const activas = qs.filter(q => q.activa), usadas = new Set();
  const licoes = ls.filter(l => l.activa).map(l => {
    const perguntas = activas.filter(q => q.tema.toLowerCase() === l.tema.toLowerCase()); perguntas.forEach(q => usadas.add(q.id));
    return { id: l.id, tema: l.tema, titulo: l.titulo, texto: l.texto, perguntas: perguntas.map(q => ({ id: q.id, pergunta: q.pergunta, opcoes: q.opcoes, correcta: q.correcta, explicacao: q.explicacao, imagem: q.imagem })) };
  });
  const soltas = activas.filter(q => !usadas.has(q.id));
  if (soltas.length) licoes.push({ id: 'outras', tema: 'Outras', titulo: 'Outras perguntas da escola', texto: '', perguntas: soltas.map(q => ({ id: q.id, pergunta: q.pergunta, opcoes: q.opcoes, correcta: q.correcta, explicacao: q.explicacao, imagem: q.imagem })) });
  return licoes;
}
// acesso pago ou gratuito
const DESC_ACESSO = 'Acesso ao treino do código';
function modoAcesso(escRaw, ins) { const m = (ins && ins['Codigo Acesso']) || (escRaw && escRaw['Codigo Acesso']) || 'gratis'; return m === 'pago' ? 'pago' : 'gratis'; }
async function acessoCodigo(escola, ins, escRaw) {
  const e = escRaw || await obter('escola', escola).catch(() => null);
  const preco = Number((e && e['Codigo Preco']) || 0), modo = modoAcesso(e, ins);
  if (modo !== 'pago' || !(preco > 0)) return { livre: true, modo: 'gratis', preco: 0 };
  const ps = await procurarTodos('propina', daEscola(escola).concat([{ key: 'Estudante', constraint_type: 'equals', value: ins['Estudante'] }])).catch(() => []);
  const minhas = ps.filter(p => p['Descricao'] === DESC_ACESSO && p['Estado'] !== 'anulada');
  const paga = minhas.find(p => p['Estado'] === 'paga'), aberta = minhas.find(p => p['Estado'] !== 'paga');
  return { livre: !!paga, modo: 'pago', preco, cobranca: aberta ? aberta._id : null };
}
async function exigeAcessoCodigo(req, est) {
  const i = await inscricaoActivaDe(req.escola, est);
  if (!i) throw pub('O treino do código está disponível durante o curso de condução.');
  const a = await acessoCodigo(req.escola, i);
  if (!a.livre) { const e = new Error('O treino do código desta escola é pago (' + mt(a.preco) + '). Pague o acesso nas Prestações.'); e.publico = 402; throw e; }
  return i;
}
app.post('/codigo-licoes', exigeDireccao, rota(async (req, res) => {
  const [ls, e] = await Promise.all([licoesCodigo(req.escola), obter('escola', req.escola)]);
  res.json({ ok: true, licoes: ls, acesso: { modo: (e && e['Codigo Acesso']) === 'pago' ? 'pago' : 'gratis', preco: Number((e && e['Codigo Preco']) || 0) } });
}));
app.post('/codigo-licao-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const titulo = txt(b.titulo, 120), texto = String(b.texto == null ? '' : b.texto).trim().slice(0, 6000);
  if (titulo.length < 3) return erro(res, 400, 'Escreva o título da lição.');
  if (texto.length < 20) return erro(res, 400, 'Escreva o texto da lição.');
  const campos = { 'Escola': req.escola, 'Base': '', 'Tema': txt(b.tema, 40) || 'Geral', 'Titulo': titulo, 'Texto': texto, 'Ordem': Math.max(1, Math.min(999, Math.round(Number(b.ordem) || 50))), 'Activa': true };
  let id = b.id ? String(b.id) : null;
  if (id) { const x = await daMinhaEscola('licaocodigo', id, req.escola); if (x['Base']) return erro(res, 400, 'As lições de base não se editam: esconda-a e crie uma sua.'); await mudar('licaocodigo', id, campos); }
  else id = await criar('licaocodigo', campos);
  res.json({ ok: true, id });
}));
app.post('/codigo-licao-estado', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, id = String(b.id || ''), activa = b.activa !== false;
  if (LICOES_BASE.some(l => l.id === id)) {
    const ja = (await procurarTodos('licaocodigo', daEscola(req.escola).concat([{ key: 'Base', constraint_type: 'equals', value: id }]))).filter(x => x['Escola'] === req.escola)[0];
    if (ja) await mudar('licaocodigo', ja._id, { 'Activa': activa });
    else if (!activa) await criar('licaocodigo', { 'Escola': req.escola, 'Base': id, 'Activa': false, 'Titulo': '', 'Texto': '' });
  } else { const x = await daMinhaEscola('licaocodigo', id, req.escola); await mudar('licaocodigo', x._id, { 'Activa': activa }); }
  res.json({ ok: true, activa });
}));
app.post('/codigo-acesso-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, modo = b.modo === 'pago' ? 'pago' : 'gratis';
  const preco = Math.round(Number(String(b.preco == null ? '' : b.preco).replace(/\s/g, '')) || 0);
  if (modo === 'pago' && !(preco >= MOZ_MIN)) return erro(res, 400, 'Escreva o preço do acesso (pelo menos ' + MOZ_MIN + ' MT, o mínimo para pagar online).');
  await mudar('escola', req.escola, { 'Codigo Acesso': modo, 'Codigo Preco': modo === 'pago' ? preco : 0 });
  res.json({ ok: true, modo, preco: modo === 'pago' ? preco : 0 });
}));
app.post('/inscricao-codigo-acesso', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, v = ['gratis', 'pago'].includes(b.acesso) ? b.acesso : '';
  const i = await daMinhaEscola('inscricaoconducao', String(b.id || ''), req.escola);
  await mudar('inscricaoconducao', i._id, { 'Codigo Acesso': v });
  // ao passar para gratuito, a cobrança do acesso que ainda não foi paga deixa de ser devida
  if (v === 'gratis') {
    const ps = await procurarTodos('propina', daEscola(req.escola).concat([{ key: 'Estudante', constraint_type: 'equals', value: i['Estudante'] }])).catch(() => []);
    for (const p of ps.filter(x => x['Descricao'] === DESC_ACESSO && x['Estado'] !== 'paga' && x['Estado'] !== 'anulada')) await mudar('propina', p._id, { 'Estado': 'anulada' }).catch(() => {});
  }
  res.json({ ok: true, acesso: await acessoCodigo(req.escola, Object.assign({}, i, { 'Codigo Acesso': v })) });
}));
// portal do instruendo
app.post('/p/codigo-estudo', exigePortal, rota(async (req, res) => {
  const est = String((req.body || {}).estudante || '');
  if (!req.educandos.includes(est)) return erro(res, 403, 'Este instruendo não pertence a esta conta.');
  await exigeAcessoCodigo(req, est);
  res.json({ ok: true, licoes: await materialCodigo(req.escola) });
}));
app.post('/p/codigo-acesso', exigePortal, rota(async (req, res) => {
  const est = String((req.body || {}).estudante || '');
  if (!req.educandos.includes(est)) return erro(res, 403, 'Este instruendo não pertence a esta conta.');
  const i = await inscricaoActivaDe(req.escola, est);
  if (!i) return erro(res, 400, 'O treino do código está disponível durante o curso de condução.');
  const a = await acessoCodigo(req.escola, i);
  if (a.livre) return res.json({ ok: true, livre: true });
  let id = a.cobranca;
  if (!id) {
    const hoje = hojeMZ().data, vz = new Date(hoje + 'T21:59:00Z');
    id = await criar('propina', { 'Escola': req.escola, 'Estudante': est, 'Ano Lectivo': hoje.slice(0, 4), 'Tipo': 'prestacao', 'Mes': Number(hoje.slice(5, 7)), 'Descricao': DESC_ACESSO, 'Valor': a.preco, 'Vencimento': vz.toISOString(), 'Multa': 0, 'Total': a.preco, 'Estado': 'aberta' });
  }
  res.json({ ok: true, livre: false, cobranca: id, preco: a.preco });
}));
// instrutores: o mesmo material, para preparar as aulas
app.post('/prof/codigo-estudo', exigeProfessor, rota(async (req, res) => {
  const e = await resumoEscola(req.escola);
  if (!e || !(e.niveis || []).includes('CON')) return erro(res, 403, 'O treino do código é só para escolas de condução.');
  res.json({ ok: true, licoes: await materialCodigo(req.escola) });
}));

// ---------- processo, documentos e licença de aprendizagem ----------
const DOCS_PADRAO = ['Bilhete de Identidade (BI)', 'Atestado médico', 'Fotografias tipo passe'];
const PROCESSO = { documentos: 'A reunir documentos', submetido: 'Processo entregue no INATRO', licenca: 'Licença de aprendizagem emitida', carta: 'Carta emitida' };
async function docsDaEscola(escola, escRaw) {
  const e = escRaw || await obter('escola', escola).catch(() => null);
  const l = lerJSON(e && e['Docs Conducao'], null);
  return Array.isArray(l) && l.length ? l.map(String) : DOCS_PADRAO.slice();
}
function processoOut(i, docs) {
  const d = lerJSON(i['Documentos'], {}), entregues = docs.filter(n => d && d[n]);
  const val = i['Licenca Validade'] || null;
  return { documentos: Object.fromEntries(docs.map(n => [n, !!(d && d[n])])), docs_entregues: entregues.length, docs_total: docs.length, faltam: docs.filter(n => !(d && d[n])),
    processo: PROCESSO[i['Processo']] ? i['Processo'] : 'documentos', processo_nome: PROCESSO[i['Processo']] || PROCESSO.documentos,
    licenca: { numero: i['Licenca Numero'] || '', validade: val, dias: diasAte(val) } };
}
app.post('/conducao-docs', exigeDireccao, rota(async (req, res) => {
  res.json({ ok: true, documentos: await docsDaEscola(req.escola), padrao: DOCS_PADRAO, processos: PROCESSO });
}));
app.post('/conducao-docs-guardar', exigeDireccao, rota(async (req, res) => {
  const l = [...new Set((Array.isArray((req.body || {}).documentos) ? req.body.documentos : []).map(x => txt(x, 60)).filter(Boolean))];
  if (!l.length) return erro(res, 400, 'Escreva pelo menos um documento.');
  if (l.length > 15) return erro(res, 400, 'No máximo 15 documentos.');
  await mudar('escola', req.escola, { 'Docs Conducao': JSON.stringify(l) });
  res.json({ ok: true, documentos: l });
}));
app.post('/inscricao-processo', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const i = await daMinhaEscola('inscricaoconducao', String(b.id || ''), req.escola);
  const docs = await docsDaEscola(req.escola), entregue = {};
  docs.forEach(n => { if (b.documentos && b.documentos[n]) entregue[n] = true; });
  const mud = { 'Documentos': JSON.stringify(entregue), 'Processo': PROCESSO[b.processo] ? b.processo : 'documentos', 'Licenca Numero': txt(b.licenca_numero, 40) };
  if (b.licenca_validade && !isNaN(Date.parse(b.licenca_validade))) mud['Licenca Validade'] = new Date(b.licenca_validade + 'T23:59:00Z').toISOString();
  await mudar('inscricaoconducao', i._id, mud);
  res.json({ ok: true, processo: processoOut(Object.assign({}, i, mud), docs) });
}));

// ---------- aulas teóricas: presenças ----------
const teoricaOut = (t, D) => { const p = lerJSON(t['Presentes'], []); const ids = Array.isArray(p) ? p : [];
  return { id: t._id, data: t['Data'] || '', inicio: t['Inicio'] || '', tema: t['Tema'] || '', instrutor_id: t['Instrutor'] || '', instrutor: ((D.PM[t['Instrutor']] || {})['Nome']) || '',
    presentes: ids, nomes: ids.map(id => (D.EM[(D.IM[id] || {})['Estudante']] || {})['Nome']).filter(Boolean) }; };
app.post('/teoricas', exigeDireccao, rota(async (req, res) => {
  const [D, ts] = await Promise.all([dadosAulas(req.escola), procurarTodos('aulateorica', daEscola(req.escola), 5000)]);
  const conta = {}; ts.forEach(t => (lerJSON(t['Presentes'], []) || []).forEach(id => { conta[id] = (conta[id] || 0) + 1; }));
  res.json({ ok: true, hoje: hojeMZ().data,
    aulas: ts.map(t => teoricaOut(t, D)).sort((a, b) => (b.data + b.inicio).localeCompare(a.data + a.inicio)).slice(0, 200),
    instrutores: D.profs.filter(p => p['Activo'] !== false).map(p => ({ id: p._id, nome: p['Nome'] || '' })).sort((x, y) => x.nome.localeCompare(y.nome, 'pt')),
    inscricoes: D.ins.filter(i => (i['Estado'] || 'activa') === 'activa').map(i => ({ id: i._id, nome: (D.EM[i['Estudante']] || {})['Nome'] || '', numero: (D.EM[i['Estudante']] || {})['Numero'] || '', categoria: i['Categoria'] || '',
      feitas: conta[i._id] || 0, total: Number((D.CM[i['Curso']] || {})['Aulas Teoricas'] || 0) })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt')) });
}));
app.post('/teorica-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  if (!dataOk(b.data)) return erro(res, 400, 'Escolha a data da aula.');
  if (b.data > hojeMZ().data) return erro(res, 400, 'Registe a aula teórica no dia em que acontece, com quem esteve presente.');
  if (b.inicio && !HHMM.test(b.inicio)) return erro(res, 400, 'Hora inválida.');
  const D = await dadosAulas(req.escola);
  const presentes = [...new Set((Array.isArray(b.presentes) ? b.presentes : []).map(String))].filter(id => D.IM[id] && D.IM[id]['Escola'] === req.escola);
  if (!presentes.length) return erro(res, 400, 'Marque quem esteve presente.');
  if (b.instrutor && !D.PM[String(b.instrutor)]) return erro(res, 400, 'Instrutor inválido.');
  const campos = { 'Escola': req.escola, 'Data': b.data, 'Inicio': b.inicio || '', 'Tema': txt(b.tema, 120), 'Instrutor': b.instrutor ? String(b.instrutor) : '', 'Presentes': JSON.stringify(presentes) };
  let id = b.id ? String(b.id) : null;
  if (id) { await daMinhaEscola('aulateorica', id, req.escola); await mudar('aulateorica', id, campos); } else id = await criar('aulateorica', campos);
  res.json({ ok: true, id, presentes: presentes.length });
}));
app.post('/teorica-apagar', exigeDireccao, rota(async (req, res) => {
  const t = await daMinhaEscola('aulateorica', String((req.body || {}).id || ''), req.escola);
  await apagar('aulateorica', t._id);
  res.json({ ok: true });
}));

// ---------- lembretes automáticos por SMS (véspera da aula prática e do exame) ----------
const LEMBRETES_HORA = Math.max(8, Math.min(21, Number(process.env.LEMBRETES_HORA || 18)));
const lembretesFeitos = new Set();   // protege contra envios repetidos se o campo Lembrete ainda não existir no Bubble
let lembretesAgora = false;
async function lembretesConducao() {
  if (lembretesAgora || !BUBBLE_BASE || !BUBBLE_TOKEN) return;
  const h = new Date(Date.now() + 2 * 3600e3).getUTCHours();
  if (h < LEMBRETES_HORA || h >= 22) return;
  lembretesAgora = true;
  try {
    const amanha = hojeMZ(1).data, dia = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'][new Date(amanha + 'T12:00:00Z').getUTCDay()];
    const [aulas, exames] = await Promise.all([
      procurarTodos('aulapratica', [{ key: 'Data', constraint_type: 'equals', value: amanha }, { key: 'Estado', constraint_type: 'equals', value: 'marcada' }], 5000).catch(() => []),
      procurarTodos('exameconducao', [{ key: 'Data', constraint_type: 'equals', value: amanha }, { key: 'Resultado', constraint_type: 'equals', value: 'marcado' }], 2000).catch(() => [])]);
    if (!aulas.length && !exames.length) return;
    const cache = {}, pega = async (tipo, id) => { const k = tipo + id; if (!(k in cache)) cache[k] = id ? await obter(tipo, id).catch(() => null) : null; return cache[k]; };
    let n = 0;
    for (const a of aulas.filter(x => x['Lembrete'] !== true && !lembretesFeitos.has(x._id))) {
      lembretesFeitos.add(a._id);
      const [esc, e, p, v] = await Promise.all([pega('escola', a['Escola']), pega('estudante', a['Estudante']), pega('professor', a['Instrutor']), pega('viatura', a['Viatura'])]);
      if (!esc || esc['Estado'] === 'suspensa' || !e || tel9(e['Telefone']).length !== 9) continue;
      const r = await enviarSMS([e['Telefone']], (esc['Nome'] || 'Escola') + ': lembrete - amanha (' + dia + ' ' + dmCurto(amanha) + ') tem aula pratica das ' + a['Inicio'] + ' as ' + a['Fim'] + (p ? ' com ' + String(p['Nome'] || '').split(' ')[0] : '') + (v ? ', viatura ' + v['Matricula'] : '') + '. Se nao puder vir, avise a escola.');
      if (r.ok) { n++; await mudar('aulapratica', a._id, { 'Lembrete': true }).catch(() => {}); }
    }
    // agenda do dia seguinte para cada instrutor
    const porInst = {};
    aulas.forEach(a => { if (a['Instrutor']) (porInst[a['Instrutor']] = porInst[a['Instrutor']] || []).push(a); });
    for (const [pid, L] of Object.entries(porInst)) {
      const k = 'inst|' + pid + '|' + amanha; if (lembretesFeitos.has(k)) continue; lembretesFeitos.add(k);
      const p = await pega('professor', pid), esc = await pega('escola', L[0]['Escola']);
      if (!p || !esc || esc['Estado'] === 'suspensa' || tel9(p['Telefone']).length !== 9) continue;
      L.sort((x, y) => String(x['Inicio']).localeCompare(String(y['Inicio'])));
      const r = await enviarSMS([p['Telefone']], (esc['Nome'] || 'Escola') + ': amanha (' + dia + ' ' + dmCurto(amanha) + ') tem ' + L.length + ' aula(s) pratica(s). A primeira e as ' + L[0]['Inicio'] + '. Veja a agenda no Gescolar.');
      if (r.ok) n++;
    }
    for (const x of exames.filter(z => z['Lembrete'] !== true && !lembretesFeitos.has(z._id))) {
      lembretesFeitos.add(x._id);
      const [esc, e] = await Promise.all([pega('escola', x['Escola']), pega('estudante', x['Estudante'])]);
      if (!esc || esc['Estado'] === 'suspensa' || !e || tel9(e['Telefone']).length !== 9) continue;
      const r = await enviarSMS([e['Telefone']], (esc['Nome'] || 'Escola') + ': lembrete - amanha (' + dmCurto(amanha) + ') tem ' + (TIPO_EXAME[x['Tipo']] || 'exame').toLowerCase() + (x['Hora'] ? ' as ' + x['Hora'] : '') + (x['Local'] ? ', ' + String(x['Local']).slice(0, 50) : '') + '. Leve o BI e chegue cedo. Boa sorte!');
      if (r.ok) { n++; await mudar('exameconducao', x._id, { 'Lembrete': true }).catch(() => {}); }
    }
    if (n) console.log('[lembretes] ' + n + ' SMS enviados para ' + amanha);
    if (lembretesFeitos.size > 20000) lembretesFeitos.clear();
  } finally { lembretesAgora = false; }
}
setInterval(() => { lembretesConducao().catch(e => console.error('[lembretes]', e.message)); }, 15 * 60e3);
setTimeout(() => { lembretesConducao().catch(e => console.error('[lembretes]', e.message)); }, 60e3);

// ---------- regras: dívida antes do exame, aula extra e taxa de aprovação por instrutor ----------
async function dividaDe(escola, estId) {
  const [ps, esc] = await Promise.all([procurarTodos('propina', daEscola(escola).concat([{ key: 'Estudante', constraint_type: 'equals', value: estId }])), resumoEscola(escola)]);
  const regras = (esc && esc.regras) || {};
  return ps.filter(p => p['Estado'] !== 'anulada').map(p => calcPropina(p, regras)).filter(c => c.estado === 'atrasada').reduce((x, c) => x + c.total, 0);
}
function taxaPorInstrutor(xs, D) {
  const out = {};
  xs.filter(x => x['Tipo'] === 'conducao' && ['aprovado', 'reprovado'].includes(x['Resultado'])).forEach(x => {
    const conta = {}; D.aulas.filter(a => a['Inscricao'] === x['Inscricao'] && a['Estado'] === 'feita' && a['Instrutor']).forEach(a => { conta[a['Instrutor']] = (conta[a['Instrutor']] || 0) + 1; });
    const pid = Object.keys(conta).sort((a, b) => conta[b] - conta[a])[0]; if (!pid) return;
    const o = out[pid] = out[pid] || { id: pid, nome: (D.PM[pid] || {})['Nome'] || '', exames: 0, aprovados: 0 };
    o.exames++; if (x['Resultado'] === 'aprovado') o.aprovados++;
  });
  return Object.values(out).map(o => Object.assign(o, { taxa: Math.round(o.aprovados * 100 / o.exames) })).sort((a, b) => b.taxa - a.taxa || b.exames - a.exames);
}

// ---------- portal: o percurso do instruendo ----------
async function conducaoDoEstudante(escola, estId, cache) {
  const f = daEscola(escola).concat([{ key: 'Estudante', constraint_type: 'equals', value: estId }]);
  const ins = await procurarTodos('inscricaoconducao', f);
  if (!ins.length) return null;
  const i = ins.filter(x => (x['Estado'] || 'activa') === 'activa')[0] || ins.sort((a, b) => String(b['Created Date'] || '').localeCompare(String(a['Created Date'] || '')))[0];
  const [c, aps, xs, ts, teo, docs] = await Promise.all([obter('cursoconducao', i['Curso']).catch(() => null), procurarTodos('aulapratica', f, 2000), procurarTodos('exameconducao', f, 200),
    procurarTodos('testecodigo', f, 500).catch(() => []), procurarTodos('aulateorica', daEscola(escola), 5000).catch(() => []), docsDaEscola(escola)]);
  const teoFeitas = teo.filter(t => (lerJSON(t['Presentes'], []) || []).includes(i._id)).length;
  if (!cache.profs) cache.profs = Object.fromEntries((await procurarTodos('professor', daEscola(escola))).map(p => [p._id, p['Nome'] || '']));
  if (!cache.vias) cache.vias = Object.fromEntries((await procurarTodos('viatura', daEscola(escola))).map(v => [v._id, v]));
  const minhas = aps.filter(a => a['Inscricao'] === i._id), hoje = hojeMZ().data;
  return { categoria: i['Categoria'] || '', curso: (c && c['Nome']) || '', estado: i['Estado'] || 'activa', teoricas: Number((c && c['Aulas Teoricas']) || 0), teoricas_feitas: teoFeitas,
    codigo: Object.assign(resumoCodigo(ts.filter(t => t['Inscricao'] === i._id)), { acesso: (i['Estado'] || 'activa') === 'activa' ? await acessoCodigo(escola, i).catch(() => ({ livre: true })) : { livre: false, fim: true } }), processo: processoOut(i, docs),
    praticas: { feitas: minhas.filter(a => a['Estado'] === 'feita').length, faltou: minhas.filter(a => a['Estado'] === 'faltou').length, total: Number((c && c['Aulas Praticas']) || 0), minutos: minhas.filter(a => a['Estado'] === 'feita').reduce((x, a) => x + Number(a['Minutos'] || 0), 0) },
    proximas: minhas.filter(a => a['Estado'] === 'marcada' && a['Data'] >= hoje).sort((a, b) => (a['Data'] + a['Inicio']).localeCompare(b['Data'] + b['Inicio'])).slice(0, 10)
      .map(a => ({ data: a['Data'], inicio: a['Inicio'], fim: a['Fim'], instrutor: cache.profs[a['Instrutor']] || '', viatura: (cache.vias[a['Viatura']] || {})['Matricula'] || '', modelo: (cache.vias[a['Viatura']] || {})['Marca Modelo'] || '' })),
    historico: minhas.filter(a => ['feita', 'faltou'].includes(a['Estado'])).sort((a, b) => (b['Data'] + b['Inicio']).localeCompare(a['Data'] + a['Inicio'])).slice(0, 20)
      .map(a => ({ data: a['Data'], inicio: a['Inicio'], estado: a['Estado'], instrutor: cache.profs[a['Instrutor']] || '', notas: a['Notas'] || '' })),
    exames: xs.filter(x => x['Inscricao'] === i._id).map(x => exameOut(x)).sort((a, b) => (b.data.localeCompare(a.data)) || (b.tentativa - a.tentativa) || b.hora.localeCompare(a.hora)) };
}

// ============================================================
//  ESCOLINHA (v5.3): DIÁRIO DA CRIANÇA E AUTORIZADOS A RECOLHER
//  Bubble:
//   Diario Entrada:     Escola (Escola) · Estudante (text) · Turma (text) · Data (text AAAA-MM-DD) · Refeicao (text) · Sesta (text)
//                       · Humor (text) · Actividades (text) · Recado (text) · Feito Por (text)
//   Autorizado Recolha: Escola (Escola) · Estudante (text) · Nome (text) · Parentesco (text) · Telefone (text) · Activo (yes/no) · Criado Por (text)
// ============================================================
const OPC_DIARIO = { refeicao: ['Comeu tudo', 'Comeu metade', 'Comeu pouco', 'Não comeu'], sesta: ['Dormiu bem', 'Dormiu pouco', 'Não dormiu'], humor: ['Bem-disposto', 'Calmo', 'Agitado', 'Choroso', 'Doente'] };
const autOut = a => ({ id: a._id, estudante: a['Estudante'], nome: a['Nome'] || '', parentesco: a['Parentesco'] || '', telefone: a['Telefone'] || '', criado_por: a['Criado Por'] || '' });
async function autorizadosDe(escola, estIds) {
  const l = await procurarTodos('autorizadorecolha', daEscola(escola), 5000);
  return l.filter(a => a['Activo'] !== false && estIds.includes(a['Estudante'])).map(autOut);
}
async function guardarAutorizado(escola, estId, b, quem) {
  const nome = txt(b.nome, 100), tel = tel9(b.telefone);
  if (nome.split(/\s+/).length < 2) { const e = new Error('Escreva o nome completo de quem vai recolher.'); e.publico = 400; throw e; }
  if (tel.length !== 9) { const e = new Error('O telemóvel tem 9 dígitos.'); e.publico = 400; throw e; }
  const actuais = await autorizadosDe(escola, [estId]);
  if (actuais.length >= 8) { const e = new Error('No máximo 8 pessoas autorizadas por criança.'); e.publico = 400; throw e; }
  return criar('autorizadorecolha', { 'Escola': escola, 'Estudante': estId, 'Nome': nome, 'Parentesco': txt(b.parentesco, 30), 'Telefone': tel.replace(/(\d{2})(\d{3})(\d{4})/, '$1 $2 $3'), 'Activo': true, 'Criado Por': quem });
}
// Direcção
app.post('/autorizados', exigeDireccao, rota(async (req, res) => {
  const e = await daMinhaEscola('estudante', String((req.body || {}).estudante || ''), req.escola);
  const enc = e['Encarregado'] ? await obter('encarregado', e['Encarregado']).catch(() => null) : null;
  res.json({ ok: true, estudante: { id: e._id, nome: e['Nome'] || '' }, encarregado: enc ? { nome: enc['Nome'] || '', telefone: enc['Telefone'] || '', parentesco: enc['Parentesco'] || '' } : null, autorizados: await autorizadosDe(req.escola, [e._id]) });
}));
app.post('/autorizado-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const e = await daMinhaEscola('estudante', String(b.estudante || ''), req.escola);
  const eu = await obter('user', req.sessao.u).catch(() => null);
  res.json({ ok: true, id: await guardarAutorizado(req.escola, e._id, b, (eu && eu['Nome Completo']) || 'Direcção') });
}));
app.post('/autorizado-apagar', exigeDireccao, rota(async (req, res) => {
  const a = await daMinhaEscola('autorizadorecolha', String((req.body || {}).id || ''), req.escola);
  await mudar('autorizadorecolha', a._id, { 'Activo': false });
  res.json({ ok: true });
}));
// Encarregado (portal)
function exigeEncarregado(req, res, next) {
  const s = sessaoDo(req);
  if (!s || s.t !== 'portal' || s.p !== 'Encarregado') return erro(res, 403, 'Só o encarregado pode mudar quem recolhe a criança.');
  exigePortal(req, res, next);
}
app.post('/p/autorizado-guardar', exigeEncarregado, rota(async (req, res) => {
  const b = req.body || {}, est = String(b.estudante || '');
  if (!req.educandos.includes(est)) return erro(res, 404, 'Registo não encontrado.');
  const enc = await obter('encarregado', req.sessao.u).catch(() => null);
  res.json({ ok: true, id: await guardarAutorizado(req.escola, est, b, 'Encarregado · ' + ((enc && enc['Nome']) || '')) });
}));
app.post('/p/autorizado-apagar', exigeEncarregado, rota(async (req, res) => {
  const a = await daMinhaEscola('autorizadorecolha', String((req.body || {}).id || ''), req.escola);
  if (!req.educandos.includes(a['Estudante'])) return erro(res, 404, 'Registo não encontrado.');
  await mudar('autorizadorecolha', a._id, { 'Activo': false });
  res.json({ ok: true });
}));
// Educadora (professor.html)
async function turmaDoProfessor(req, turmaId) {
  const a = await atribuicoes(req.escola);
  if (!a.pares.some(p => p.turma === turmaId && p.professores.has(req.sessao.u))) { const e = new Error('Não é educador(a) desta turma.'); e.publico = 403; throw e; }
  return a.turmas.find(t => t._id === turmaId);
}
app.post('/prof/diario', exigeProfessor, rota(async (req, res) => {
  const b = req.body || {}, data = dataOk(b.data) ? b.data : hojeMZ().data;
  const t = await turmaDoProfessor(req, String(b.turma || ''));
  const f = daEscola(req.escola);
  const ests = (await procurarTodos('estudante', f.concat([{ key: 'Turma', constraint_type: 'equals', value: t._id }]))).filter(e => (e['Estado'] || 'activo') === 'activo')
    .sort((x, y) => String(x['Nome'] || '').localeCompare(String(y['Nome'] || ''), 'pt'));
  const [ds, auts, encs] = await Promise.all([procurarTodos('diarioentrada', f.concat([{ key: 'Turma', constraint_type: 'equals', value: t._id }, { key: 'Data', constraint_type: 'equals', value: data }])),
    autorizadosDe(req.escola, ests.map(e => e._id)), procurarTodos('encarregado', f)]);
  const EN = Object.fromEntries(encs.map(x => [x._id, x]));
  res.json({ ok: true, turma: { id: t._id, nome: t['Nome'] || '' }, data, hoje: hojeMZ().data, opcoes: OPC_DIARIO,
    criancas: ests.map(e => { const d = ds.find(x => x['Estudante'] === e._id) || {}, en = EN[e['Encarregado']];
      return { id: e._id, nome: e['Nome'] || '', saude: e['Saude Notas'] || '', encarregado: en ? { nome: en['Nome'] || '', telefone: en['Telefone'] || '', parentesco: en['Parentesco'] || '' } : null,
        autorizados: auts.filter(a => a.estudante === e._id), refeicao: d['Refeicao'] || '', sesta: d['Sesta'] || '', humor: d['Humor'] || '', recado: d['Recado'] || '', actividades: d['Actividades'] || '', feito: !!d._id }; }) });
}));
app.post('/prof/diario-guardar', exigeProfessor, rota(async (req, res) => {
  const b = req.body || {}, data = String(b.data || '');
  if (!dataOk(data) || data > hojeMZ().data || data < hojeMZ(-7).data) return erro(res, 400, 'Só pode escrever o diário de hoje ou dos últimos 7 dias.');
  const t = await turmaDoProfessor(req, String(b.turma || ''));
  const f = daEscola(req.escola);
  const [ests, ds, eu] = await Promise.all([procurarTodos('estudante', f.concat([{ key: 'Turma', constraint_type: 'equals', value: t._id }])),
    procurarTodos('diarioentrada', f.concat([{ key: 'Turma', constraint_type: 'equals', value: t._id }, { key: 'Data', constraint_type: 'equals', value: data }])), obter('professor', req.sessao.u).catch(() => null)]);
  const ids = new Set(ests.map(e => e._id)), act = txt(b.actividades, 600);
  let n = 0;
  for (const [est, l] of Object.entries(b.entradas || {})) {
    if (!ids.has(est) || !l) continue;
    const campos = { 'Escola': req.escola, 'Estudante': est, 'Turma': t._id, 'Data': data, 'Actividades': act, 'Feito Por': (eu && eu['Nome']) || 'Educadora',
      'Refeicao': OPC_DIARIO.refeicao.includes(l.refeicao) ? l.refeicao : '', 'Sesta': OPC_DIARIO.sesta.includes(l.sesta) ? l.sesta : '', 'Humor': OPC_DIARIO.humor.includes(l.humor) ? l.humor : '', 'Recado': txt(l.recado, 400) };
    if (!campos['Refeicao'] && !campos['Sesta'] && !campos['Humor'] && !campos['Recado'] && !act) continue;
    const ja = ds.find(x => x['Estudante'] === est);
    if (ja) await mudar('diarioentrada', ja._id, campos); else await criar('diarioentrada', campos);
    n++;
  }
  res.json({ ok: true, guardados: n });
}));
async function diarioDoEstudante(escola, estId) {
  const l = await procurarTodos('diarioentrada', daEscola(escola).concat([{ key: 'Estudante', constraint_type: 'equals', value: estId }]), 200);
  const de = hojeMZ(-14).data;
  return l.filter(x => x['Data'] >= de).map(x => ({ data: x['Data'], refeicao: x['Refeicao'] || '', sesta: x['Sesta'] || '', humor: x['Humor'] || '', actividades: x['Actividades'] || '', recado: x['Recado'] || '', por: x['Feito Por'] || '' }))
    .sort((a, b) => b.data.localeCompare(a.data));
}


// ============================================================
//  INSCRIÇÕES ONLINE (v5.7)
//  A escola cria links públicos (inscricao.html?e=<escola>&l=<codigo>) com a sua capa, texto, preço, prazo e vagas.
//  O candidato preenche os dados, paga a taxa (M-Pesa, e-Mola ou cartão) e fica na lista da Direcção para matricular.
//  Bubble:
//   Link Inscricao:  Escola (Escola) · Codigo (text) · Titulo (text) · Descricao (text) · Preco (number) · Cor (text) · Capa (text)
//                    · Nivel (text) · Prazo (date) · Vagas (number) · Campos (text, JSON) · Mensagem Final (text) · Contacto (text)
//                    · WhatsApp (text) · Activo (yes/no)
//   Inscricao Online: Escola (Escola) · Link (text) · Nome (text) · Telefone (text) · Nascimento (text) · Encarregado Nome (text)
//                    · Encarregado Telefone (text) · Email (text) · Respostas (text, JSON) · Valor (number) · Metodo (text)
//                    · Estado (text: pendente | paga | falhada | matriculada | recusada) · Referencia (text) · Transacao (text)
//                    · Pago Em (date) · Chave (text) · Estudante (text) · Numero (text)
// ============================================================
const TIPOS_CAMPO = ['texto', 'opcoes', 'simnao'];
const COR_OK = c => /^#[0-9a-f]{6}$/i.test(String(c || ''));
function lerCampos(t) { try { const l = JSON.parse(t || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; } }
function validarCampos(lista) {
  const out = [];
  for (const c of (Array.isArray(lista) ? lista : []).slice(0, 10)) {
    const rotulo = txt(c && c.rotulo, 60); if (!rotulo) continue;
    const tipo = TIPOS_CAMPO.includes(c.tipo) ? c.tipo : 'texto';
    const opcoes = tipo === 'opcoes' ? [...new Set((Array.isArray(c.opcoes) ? c.opcoes : String(c.opcoes || '').split(',')).map(o => txt(o, 40)).filter(Boolean))].slice(0, 12) : [];
    if (tipo === 'opcoes' && opcoes.length < 2) throw pub('A pergunta "' + rotulo + '" precisa de pelo menos 2 opções, separadas por vírgulas.');
    out.push({ id: 'c' + (out.length + 1), rotulo, tipo, opcoes, obrigatorio: !!c.obrigatorio });
  }
  return out;
}
const pedeEncarregado = l => !['SUP', 'CON', NIVEIS.SUP, NIVEIS.CON].includes(l['Nivel']);
function fimDoPrazo(l) { return l['Prazo'] ? new Date(String(l['Prazo']).slice(0, 10) + 'T21:59:59Z') : null; }   // fim do dia em Maputo
async function contarInscritos(escola, link) {
  const l = await procurarTodos('inscricaoonline', daEscola(escola).concat([{ key: 'Link', constraint_type: 'equals', value: link._id }]), 5000);
  const validas = l.filter(i => ['paga', 'matriculada'].includes(i['Estado']) || (!Number(link['Preco']) && i['Estado'] !== 'recusada'));
  return { todas: l, validas: validas.length };
}
function situacaoLink(l, inscritos) {
  if (l['Activo'] === false) return { aberto: false, motivo: 'As inscrições deste link estão fechadas.' };
  const fim = fimDoPrazo(l);
  if (fim && Date.now() > fim.getTime()) return { aberto: false, motivo: 'O prazo de inscrição terminou a ' + String(l['Prazo']).slice(8, 10) + '/' + String(l['Prazo']).slice(5, 7) + '/' + String(l['Prazo']).slice(0, 4) + '.' };
  const vagas = Number(l['Vagas'] || 0);
  if (vagas && inscritos >= vagas) return { aberto: false, motivo: 'As vagas já estão todas preenchidas.' };
  return { aberto: true, restantes: vagas ? vagas - inscritos : null };
}
function linkOut(l, extra) {
  return Object.assign({ id: l._id, codigo: l['Codigo'] || '', titulo: l['Titulo'] || '', descricao: l['Descricao'] || '', preco: Number(l['Preco'] || 0), cor: COR_OK(l['Cor']) ? l['Cor'] : '#0A64DC',
    capa: l['Capa'] || '', nivel: CODIGO_NIVEL[l['Nivel']] || l['Nivel'] || '', prazo: l['Prazo'] ? String(l['Prazo']).slice(0, 10) : '', vagas: Number(l['Vagas'] || 0),
    campos: lerCampos(l['Campos']), mensagem: l['Mensagem Final'] || '', contacto: l['Contacto'] || '', whatsapp: l['WhatsApp'] || '', activo: l['Activo'] !== false,
    encarregado: pedeEncarregado(l) }, extra || {});
}
const inscOut = i => ({ id: i._id, link: i['Link'] || '', nome: i['Nome'] || '', telefone: i['Telefone'] || '', nascimento: i['Nascimento'] || '', enc_nome: i['Encarregado Nome'] || '',
  enc_telefone: i['Encarregado Telefone'] || '', email: i['Email'] || '', respostas: (() => { try { return JSON.parse(i['Respostas'] || '{}'); } catch (e) { return {}; } })(),
  valor: Number(i['Valor'] || 0), metodo: i['Metodo'] || '', estado: i['Estado'] || 'pendente', referencia: i['Referencia'] || '', pago_em: i['Pago Em'] || null,
  criado: i['Created Date'] || null, numero: i['Numero'] || '', estudante: i['Estudante'] || '' });
function linkPublico(sub, codigo) { return PORTAL_URL.replace(/acesso\.html.*$/, '') + 'inscricao.html?e=' + encodeURIComponent(sub || '') + '&l=' + encodeURIComponent(codigo || ''); }

// ---------- Direcção ----------
app.post('/links', exigeDireccao, rota(async (req, res) => {
  const f = daEscola(req.escola);
  const [ls, is, esc] = await Promise.all([procurarTodos('linkinscricao', f), procurarTodos('inscricaoonline', f, 10000), obter('escola', req.escola)]);
  res.json({ ok: true, base: linkPublico(esc['Subdominio'], ''), links: ls.map(l => {
    const d = is.filter(i => i['Link'] === l._id), pagas = d.filter(i => i['Estado'] === 'paga').length, mat = d.filter(i => i['Estado'] === 'matriculada').length;
    const sit = situacaoLink(l, d.filter(i => ['paga', 'matriculada'].includes(i['Estado']) || (!Number(l['Preco']) && i['Estado'] !== 'recusada')).length);
    return linkOut(l, { capa: undefined, tem_capa: !!l['Capa'], url: linkPublico(esc['Subdominio'], l['Codigo']), total: d.length, pagas, matriculadas: mat,
      pendentes: d.filter(i => i['Estado'] === 'pendente').length, aberto: sit.aberto, motivo: sit.motivo || '' });
  }).sort((a, b) => Number(b.activo) - Number(a.activo) || a.titulo.localeCompare(b.titulo, 'pt')) });
}));
app.post('/link', exigeDireccao, rota(async (req, res) => {
  const l = await daMinhaEscola('linkinscricao', String((req.body || {}).id || ''), req.escola);
  res.json({ ok: true, link: linkOut(l) });
}));
app.post('/link-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const titulo = txt(b.titulo, 90);
  if (titulo.length < 4) return erro(res, 400, 'Escreva o título do link, por exemplo "Inscrições 2027 · 8ª Classe".');
  const nivel = String(b.nivel || '').toUpperCase();
  if (nivel && !NIVEIS[nivel]) return erro(res, 400, 'Nível inválido.');
  const preco = Math.max(0, Math.round(num(b.preco, 0)));
  if (preco > 500000) return erro(res, 400, 'O preço parece demasiado alto. Verifique o valor.');
  if (preco && preco < MOZ_MIN) return erro(res, 400, 'A taxa tem de ser 0 (gratuita) ou pelo menos ' + MOZ_MIN + ' MT: é o mínimo para pagar online.');
  const capa = String(b.capa || '');
  if (capa && (!/^data:image\/(png|jpe?g|webp);base64,/.test(capa) || capa.length > 420000)) return erro(res, 400, 'A imagem de capa tem de ser JPG, PNG ou WebP e ter no máximo 300 KB.');
  if (b.prazo && !dataOk(b.prazo)) return erro(res, 400, 'Data limite inválida.');
  const campos = validarCampos(b.campos);
  const campos2 = { 'Escola': req.escola, 'Titulo': titulo, 'Descricao': txt(b.descricao, 2000), 'Preco': preco, 'Cor': COR_OK(b.cor) ? b.cor : '#0A64DC', 'Capa': capa,
    'Nivel': nivel ? NIVEIS[nivel] : '', 'Vagas': Math.max(0, Math.round(num(b.vagas, 0))), 'Campos': JSON.stringify(campos), 'Mensagem Final': txt(b.mensagem, 600),
    'Contacto': txt(b.contacto, 40), 'WhatsApp': tel9(b.whatsapp).length === 9 ? tel9(b.whatsapp) : '', 'Activo': b.activo !== false };
  if (b.prazo) campos2['Prazo'] = new Date(b.prazo + 'T12:00:00Z').toISOString();
  let id = b.id ? String(b.id) : null;
  if (id) { await daMinhaEscola('linkinscricao', id, req.escola); await mudar('linkinscricao', id, campos2); }
  else {
    const todos = await procurarTodos('linkinscricao', daEscola(req.escola));
    let cod = slug(txt(b.codigo, 30) || titulo).slice(0, 24) || 'inscricao';
    while (todos.some(l => l['Codigo'] === cod)) cod = cod.replace(/-\d{3}$/, '') + '-' + (100 + Math.floor(Math.random() * 900));
    campos2['Codigo'] = cod;
    id = await criar('linkinscricao', campos2);
  }
  const l = await obter('linkinscricao', id), esc = await obter('escola', req.escola);
  res.json({ ok: true, id, codigo: l['Codigo'], url: linkPublico(esc['Subdominio'], l['Codigo']) });
}));
app.post('/link-estado', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const l = await daMinhaEscola('linkinscricao', String(b.id || ''), req.escola);
  await mudar('linkinscricao', l._id, { 'Activo': !!b.activo });
  res.json({ ok: true, activo: !!b.activo });
}));
app.post('/inscricoes-online', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const f = daEscola(req.escola).concat(b.link ? [{ key: 'Link', constraint_type: 'equals', value: String(b.link) }] : []);
  const l = await procurarTodos('inscricaoonline', f, 10000);
  res.json({ ok: true, inscricoes: l.map(inscOut).sort((x, y) => String(y.pago_em || y.criado || '').localeCompare(String(x.pago_em || x.criado || ''))) });
}));
app.post('/inscricao-online-matricular', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const i = await daMinhaEscola('inscricaoonline', String(b.id || ''), req.escola);
  if (i['Estado'] === 'matriculada') return erro(res, 400, 'Esta inscrição já foi matriculada (nº ' + (i['Numero'] || '') + ').');
  if (i['Estado'] !== 'paga') return erro(res, 400, 'Só pode matricular inscrições pagas.');
  let r;
  if (b.curso) {   // escola de condução: inscreve no curso escolhido
    r = await inscreverCore(req.escola, { curso: String(b.curso), nome: i['Nome'], telefone: i['Telefone'] || i['Encarregado Telefone'], nascimento: i['Nascimento'],
      enc_nome: i['Telefone'] ? i['Encarregado Nome'] : '', enc_telefone: i['Telefone'] ? i['Encarregado Telefone'] : '' });
    r = { id: r.estudante, numero: r.numero, sms: r.sms ? 1 : 0 };
  } else {
    if (!b.turma) return erro(res, 400, 'Escolha a turma.');
    r = await matricularCore(req.escola, { nome: i['Nome'], turma: String(b.turma), nascimento: i['Nascimento'], telefone: i['Telefone'],
      enc_nome: i['Encarregado Nome'], enc_telefone: i['Encarregado Telefone'], enc_email: i['Email'] });
  }
  await mudar('inscricaoonline', i._id, { 'Estado': 'matriculada', 'Estudante': r.id || '', 'Numero': r.numero || '' });
  res.json({ ok: true, numero: r.numero, sms: r.sms });
}));
app.post('/inscricao-online-recusar', exigeDireccao, rota(async (req, res) => {
  const i = await daMinhaEscola('inscricaoonline', String((req.body || {}).id || ''), req.escola);
  if (i['Estado'] === 'matriculada') return erro(res, 400, 'Esta inscrição já foi matriculada.');
  await mudar('inscricaoonline', i._id, { 'Estado': 'recusada' });
  res.json({ ok: true });
}));

// ---------- página pública ----------
async function linkDaEscola(sub, codigo) {
  const esc = await escolaPorCodigo(sub);
  if (!esc) return {};
  const l = (await procurar('linkinscricao', daEscola(esc._id).concat([{ key: 'Codigo', constraint_type: 'equals', value: slug(codigo) }]), 1))[0];
  return { esc, l };
}
app.post('/pub/link', rota(async (req, res) => {
  const b = req.body || {};
  if (travao('pub-link|' + req.ip, 60, 10)) return erro(res, 429, 'Muitos pedidos seguidos. Espere alguns minutos.');
  const { esc, l } = await linkDaEscola(b.escola, b.link);
  if (!esc || !l) return erro(res, 404, 'Este link de inscrição não existe. Confirme o endereço com a escola.');
  const n = await contarInscritos(esc._id, l), sit = situacaoLink(l, n.validas);
  res.json({ ok: true, escola: { nome: esc['Nome'] || '', logotipo: esc['Logotipo'] || '', telefone: esc['Telefone'] || '', email: esc['Email'] || '', morada: esc['Morada'] || '' },
    link: linkOut(l), aberto: sit.aberto, motivo: sit.motivo || '', restantes: sit.restantes == null ? null : sit.restantes });
}));
async function confirmarInscricaoSMS(i, l, esc) {
  const tel = tel9(i['Encarregado Telefone']) || tel9(i['Telefone']);
  if (tel.length !== 9) return false;
  const r = await enviarSMS([tel], (esc['Nome'] || 'A escola') + ': inscricao de ' + i['Nome'] + ' em "' + (l['Titulo'] || '') + '" recebida' +
    (Number(i['Valor']) ? ' e paga (' + Number(i['Valor']) + ' MT)' : '') + '. A escola vai contacta-lo para a matricula.').catch(() => ({ ok: false }));
  return !!r.ok;
}
app.post('/pub/inscrever', rota(async (req, res) => {
  const b = req.body || {};
  if (travao('pub-insc|' + req.ip, 8, 30)) return erro(res, 429, 'Muitas inscrições seguidas a partir desta ligação. Espere meia hora.');
  const { esc, l } = await linkDaEscola(b.escola, b.link);
  if (!esc || !l) return erro(res, 404, 'Este link de inscrição não existe.');
  const n = await contarInscritos(esc._id, l), sit = situacaoLink(l, n.validas);
  if (!sit.aberto) return erro(res, 400, sit.motivo);
  const nome = txt(b.nome, 100);
  if (nome.split(/\s+/).length < 2) return erro(res, 400, 'Escreva o nome completo do candidato.');
  const tel = tel9(b.telefone), telEnc = tel9(b.enc_telefone);
  const comEnc = pedeEncarregado(l);
  if (tel && (tel.length !== 9 || !/^8[2-7]/.test(tel))) return erro(res, 400, 'O telemóvel do candidato deve ter 9 dígitos (ex.: 84 123 4567).');
  const encDado = !!(txt(b.enc_nome, 100) || telEnc);
  if (comEnc || encDado) {   // obrigatório nos outros níveis; no superior e na condução só se for preenchido
    if (txt(b.enc_nome, 100).split(/\s+/).length < 2) return erro(res, 400, 'Escreva o nome completo do encarregado de educação.');
    if (telEnc.length !== 9 || !/^8[2-7]/.test(telEnc)) return erro(res, 400, 'O telemóvel do encarregado deve ter 9 dígitos (ex.: 84 123 4567).');
  }
  if (!comEnc && tel.length !== 9) return erro(res, 400, 'Escreva o seu telemóvel: é por ele que a escola o contacta.');
  if (b.nascimento && !dataOk(b.nascimento)) return erro(res, 400, 'Data de nascimento inválida.');
  const email = txt(b.email, 120).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return erro(res, 400, 'O email não parece válido.');
  const respostas = {};
  for (const c of lerCampos(l['Campos'])) {
    let v = (b.respostas || {})[c.id];
    v = c.tipo === 'simnao' ? (v === true || v === 'sim' ? 'Sim' : v === false || v === 'nao' ? 'Não' : '') : txt(v, 300);
    if (c.tipo === 'opcoes' && v && !c.opcoes.includes(v)) return erro(res, 400, 'Escolha uma opção válida em "' + c.rotulo + '".');
    if (c.obrigatorio && !v) return erro(res, 400, 'Responda a "' + c.rotulo + '".');
    if (v) respostas[c.rotulo] = v;
  }
  const preco = Number(l['Preco'] || 0);
  const metodo = String(b.metodo || '').toLowerCase(), numero = tel9(b.numero);
  if (preco && preco < MOZ_MIN) return erro(res, 400, 'Esta inscrição ainda não pode ser paga online: o valor mínimo é ' + MOZ_MIN + ' MT. Contacte a escola.');
  if (preco) {
    if (!['mpesa', 'emola', 'cartao'].includes(metodo)) return erro(res, 400, 'Escolha como vai pagar: M-Pesa, e-Mola ou cartão.');
    if (!MOZ_WALLET) return erro(res, 500, 'A escola ainda não pode receber pagamentos online.');
    if (metodo !== 'cartao') {
      if (numero.length !== 9) return erro(res, 400, 'Escreva o número que vai pagar, com 9 dígitos.');
      if (metodo === 'mpesa' && !['84', '85'].includes(numero.slice(0, 2))) return erro(res, 400, 'M-Pesa só funciona com números Vodacom (84 ou 85).');
      if (metodo === 'emola' && !['86', '87'].includes(numero.slice(0, 2))) return erro(res, 400, 'e-Mola só funciona com números Movitel (86 ou 87).');
    }
    if (travao('pub-insc-tel|' + (numero || tel || telEnc), 4, 30)) return erro(res, 429, 'Já houve vários pedidos para este número. Espere meia hora.');
  }
  const chave = require('crypto').randomBytes(12).toString('hex');
  const fmt = t => t ? t.replace(/(\d{2})(\d{3})(\d{4})/, '$1 $2 $3') : '';
  const campos = { 'Escola': esc._id, 'Link': l._id, 'Nome': nome, 'Telefone': fmt(tel), 'Nascimento': b.nascimento || '', 'Encarregado Nome': (comEnc || encDado) ? txt(b.enc_nome, 100) : '',
    'Encarregado Telefone': (comEnc || encDado) ? fmt(telEnc) : '', 'Email': email, 'Respostas': JSON.stringify(respostas), 'Valor': preco, 'Metodo': preco ? metodo : 'gratis',
    'Estado': preco ? 'pendente' : 'paga', 'Chave': chave };
  if (!preco) campos['Pago Em'] = new Date().toISOString();
  const id = await criar('inscricaoonline', campos);
  if (!preco) { const i = await obter('inscricaoonline', id); await confirmarInscricaoSMS(i, l, esc); return res.json({ ok: true, id, chave, estado: 'paga' }); }
  const produto = ('Inscricao ' + (l['Titulo'] || '') + ' · ' + nome).slice(0, 120);
  try {
    if (metodo === 'cartao') {
      const d = await mozPedido(MOZ_CARD_PATH, { valor: String(preco), nome_cliente: nome, carteira: MOZ_WALLET, nome_producto: produto });
      const link = acharLink(d);
      if (!link) throw new Error('sem link na resposta');
      const sessao = String(achar(d, ['session_id', 'sessionId', 'session']) || sessionDoLink(link) || '');
      await mudar('inscricaoonline', id, { 'Referencia': sessao });
      return res.json({ ok: true, id, chave, estado: 'pendente', checkout: link });
    }
    const d = await mozPedido('payment', corpoC2B(metodo, preco, numero, nome));
    const idp = achar(d, ['idpayment', 'id_payment', 'idPayment', 'payment_id', 'paymentId', 'reference', 'id']);
    if (!idp) throw new Error('a MozPayment não devolveu a referência do pagamento: ' + JSON.stringify(d).slice(0, 200));
    await mudar('inscricaoonline', id, { 'Referencia': String(idp) });
    res.json({ ok: true, id, chave, estado: 'pendente' });
  } catch (e) {
    console.error('[inscricao] pagamento', e.message);
    if (e.semResposta) return res.json({ ok: true, id, chave, estado: 'pendente' });
    await mudar('inscricaoonline', id, { 'Estado': 'falhada' }).catch(() => {});
    erro(res, 502, 'O pagamento não foi iniciado: ' + String(e.message).slice(0, 200) + '. Tente de novo.');
  }
}));
app.post('/pub/inscricao-estado', rota(async (req, res) => {
  const b = req.body || {};
  const i = await obter('inscricaoonline', String(b.id || '')).catch(() => null);
  if (!i || !b.chave || i['Chave'] !== String(b.chave)) return erro(res, 404, 'Inscrição não encontrada.');
  res.json({ ok: true, estado: i['Estado'] === 'matriculada' ? 'paga' : (i['Estado'] || 'pendente'), nome: i['Nome'] || '', valor: Number(i['Valor'] || 0) });
}));
// chamado pelo webhook da MozPayment
async function aplicarInscricao(i, b, estado) {
  if (['paga', 'matriculada'].includes(i['Estado'])) return { ok: true, ja: 'aplicado' };
  const valor = Math.round(Number(String(b.amount || '').replace(',', '.')));
  if (estado === 'pago' && valor !== Math.round(Number(i['Valor'] || 0))) { console.warn('[webhook] inscrição: valor diferente'); await mudar('inscricaoonline', i._id, { 'Transacao': txt(b.transaction_id, 120) }); return { ok: true, revisao: true }; }
  if (estado !== 'pago') { await mudar('inscricaoonline', i._id, { 'Estado': 'falhada', 'Transacao': txt(b.transaction_id, 120) }); return { ok: true, estado }; }
  await mudar('inscricaoonline', i._id, { 'Estado': 'paga', 'Pago Em': new Date().toISOString(), 'Transacao': txt(b.transaction_id, 120) });
  const [l, esc] = await Promise.all([obter('linkinscricao', i['Link']).catch(() => ({})), obter('escola', i['Escola']).catch(() => ({}))]);
  await confirmarInscricaoSMS(i, l, esc);
  return { ok: true, estado: 'paga' };
}


// ============================================================
//  SALDO E LEVANTAMENTOS DA ESCOLA (v5.8)
//  O dinheiro pago online (propinas e inscrições) fica na carteira do Gescolar na MozPayment.
//  Cada escola vê o saldo por canal e levanta:
//   · M-Pesa → B2C  POST /wf/b2c-mpesa-imale  { carteira, valor, numero, secret_id, payment_metodo:"mpesa" }
//   · e-Mola → B2C  POST /wf/b2c-emola-imale  { carteira, valor, numero, secret_id, payment_metodo:"emola" }
//   · Cartão → não há B2C: a escola pede o saque e a Plataforma paga e marca como feito.
//  Mínimo 100 MT por levantamento. Pede a palavra-passe de quem levanta.
//  Render: MOZ_SECRET_ID (o secret_id da MozPayment) · LEVANTAMENTO_MIN (opcional, por defeito 100)
//  Bubble, campos novos em Transferencia: Canal (text) · Estado (text: pedido | pendente | concluida | falhada) · Numero (text)
//                                         · Pedido Por (text) · Raw (text)
// ============================================================
const MOZ_SECRET_ID = process.env.MOZ_SECRET_ID || '';
const LEV_MIN = Math.max(1, Number(process.env.LEVANTAMENTO_MIN || 100));
const CANAIS = { mpesa: 'M-Pesa', emola: 'e-Mola', cartao: 'Visa / Mastercard' };
const B2C = { mpesa: 'b2c-mpesa-imale', emola: 'b2c-emola-imale' };
const levando = new Set();   // uma operação de cada vez por escola
const contaTransf = t => !['falhada', 'cancelada'].includes(t['Estado'] || 'concluida');
async function saldoDaEscola(escola) {
  const f = daEscola(escola);
  const [pags, ins, trs] = await Promise.all([procurarTodos('pagamento', f, 50000), procurarTodos('inscricaoonline', f, 20000).catch(() => []), procurarTodos('transferencia', f, 5000)]);
  const C = {};
  for (const k of Object.keys(CANAIS)) C[k] = { canal: k, nome: CANAIS[k], entrou: 0, taxa: 0, saiu: 0, disponivel: 0, pagamentos: 0 };
  const soma = (canal, v) => { const c = C[canal]; if (!c || !(v > 0)) return; c.entrou = limpa(c.entrou + v); c.taxa = limpa(c.taxa + taxaDe(v)); c.pagamentos++; };
  pags.filter(p => p['Estado'] === 'pago').forEach(p => soma(String(p['Metodo'] || '').toLowerCase(), Number(p['Valor'] || 0)));
  ins.filter(i => ['paga', 'matriculada'].includes(i['Estado'])).forEach(i => soma(String(i['Metodo'] || '').toLowerCase(), Number(i['Valor'] || 0)));
  let antigas = 0;
  trs.filter(contaTransf).forEach(t => { const c = C[t['Canal']]; if (c) c.saiu = limpa(c.saiu + Number(t['Valor'] || 0)); else antigas = limpa(antigas + Number(t['Valor'] || 0)); });
  for (const k of ['cartao', 'mpesa', 'emola']) {   // transferências antigas (sem canal) abatem primeiro ao cartão
    const c = C[k], livre = c.entrou - c.taxa - c.saiu, tira = Math.min(Math.max(0, livre), antigas);
    c.saiu = limpa(c.saiu + tira); antigas = limpa(antigas - tira); c.disponivel = Math.max(0, limpa(c.entrou - c.taxa - c.saiu));
  }
  const historico = trs.map(t => ({ id: t._id, canal: t['Canal'] || 'manual', canal_nome: CANAIS[t['Canal']] || 'Transferência', valor: Number(t['Valor'] || 0), numero: t['Numero'] || '',
    estado: t['Estado'] || 'concluida', referencia: t['Referencia'] || '', data: t['Data'] || t['Created Date'] || null, por: t['Pedido Por'] || t['Feita Por'] || '', notas: t['Notas'] || '' }))
    .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));
  return { canais: Object.values(C), historico, taxa_pct: TAXA_PROPINAS };
}
async function confirmarSenha(req, senha) {
  const u = await obter('user', req.sessao.u).catch(() => null);
  const email = emailDoUser(u);
  if (!u || !email) throw pub('Não foi possível confirmar a sua conta.');
  if (!senha) throw pub('Escreva a sua palavra-passe para confirmar.');
  const chave = 'lev-senha|' + req.sessao.u, agora = Date.now();
  if ((tentativas.get(chave) || []).filter(t => agora - t < 15 * 60e3).length >= 5) { const e = new Error('Muitas tentativas erradas. Espere 15 minutos.'); e.publico = 429; throw e; }
  try { const r = await workflow('login', { email, password: String(senha) }); if (!r || !r.response || r.response.user_id !== req.sessao.u) throw new Error('outro'); }
  catch (e) { travao(chave, 5, 15); throw pub('A palavra-passe não está certa.'); }   // só as erradas contam
  return u;
}
app.post('/saldo', exigeSoDireccao, rota(async (req, res) => {
  const [s, esc] = await Promise.all([saldoDaEscola(req.escola), obter('escola', req.escola)]);
  res.json(Object.assign({ ok: true, minimo: LEV_MIN, b2c: !!MOZ_SECRET_ID, telefone: tel9(esc['Telefone']) }, s));
}));
app.post('/levantar', exigeSoDireccao, rota(async (req, res) => {
  const b = req.body || {}, canal = String(b.canal || '');
  if (!B2C[canal]) return erro(res, 400, 'Escolha M-Pesa ou e-Mola.');
  if (!MOZ_SECRET_ID || !MOZ_WALLET) return erro(res, 500, 'Os levantamentos ainda não estão configurados no servidor (MOZ_SECRET_ID).');
  const valor = valorMT(b.valor);
  if (isNaN(valor)) return erro(res, 400, 'Escreva o valor em meticais, com até 2 casas decimais (ex.: 150 ou 150,50).');
  if (!(valor >= LEV_MIN)) return erro(res, 400, 'O valor mínimo de cada levantamento é ' + LEV_MIN + ' MT.');
  const numero = tel9(b.numero);
  if (numero.length !== 9) return erro(res, 400, 'Escreva o número que vai receber, com 9 dígitos.');
  if (canal === 'mpesa' && !['84', '85'].includes(numero.slice(0, 2))) return erro(res, 400, 'M-Pesa só envia para números Vodacom (84 ou 85).');
  if (canal === 'emola' && !['86', '87'].includes(numero.slice(0, 2))) return erro(res, 400, 'e-Mola só envia para números Movitel (86 ou 87).');
  if (levando.has(req.escola)) return erro(res, 409, 'Já está um levantamento em curso. Espere que termine.');
  const u = await confirmarSenha(req, b.senha);
  levando.add(req.escola);
  try {
    const s = await saldoDaEscola(req.escola), c = s.canais.find(x => x.canal === canal);
    if (valor > c.disponivel) return erro(res, 400, 'O saldo disponível em ' + CANAIS[canal] + ' é ' + mt(c.disponivel) + '.');
    const quem = u['Nome Completo'] || 'Direcção';
    const id = await criar('transferencia', { 'Escola': req.escola, 'Valor': valor, 'Data': new Date().toISOString(), 'Canal': canal, 'Estado': 'pendente', 'Numero': numero,
      'Metodo': CANAIS[canal] + ' (levantamento)', 'Pedido Por': quem, 'Feita Por': quem });
    let d;
    try { d = await mozPedido(B2C[canal], { carteira: MOZ_WALLET, valor: String(valor), numero: numMoz(numero), secret_id: MOZ_SECRET_ID, payment_metodo: canal }); }
    catch (e) {
      console.error('[levantar]', e.message);
      if (e.semResposta) {   // pode ter saído: fica pendente (continua a contar) até a Plataforma confirmar
        await mudar('transferencia', id, { 'Raw': String(e.message).slice(0, 2000) }).catch(() => {});
        return res.json({ ok: true, id, estado: 'pendente', mensagem: 'A MozPayment está a demorar a responder. O levantamento fica pendente; confirme no telemóvel se o dinheiro chegou.' });
      }
      await mudar('transferencia', id, { 'Estado': 'falhada', 'Raw': String(e.message).slice(0, 2000) }).catch(() => {});
      return erro(res, 502, 'O levantamento não foi feito: ' + String(e.message).slice(0, 200));
    }
    const st = String(achar(d, ['status', 'estado']) || '').toLowerCase();
    const falhou = ['failed', 'falhou', 'error', 'erro', 'rejected', 'cancelled'].some(x => st.includes(x));
    const ref = String(achar(d, ['transaction_id', 'transactionId', 'idpayment', 'id_payment', 'reference', 'referencia', 'id']) || '');
    await mudar('transferencia', id, { 'Estado': falhou ? 'falhada' : 'concluida', 'Referencia': ref, 'Raw': JSON.stringify(d).slice(0, 4000) });
    if (falhou) return erro(res, 502, 'A MozPayment recusou o levantamento: ' + (achar(d, ['message', 'mensagem', 'erro']) || st));
    const esc = await obter('escola', req.escola).catch(() => null);
    if (esc && tel9(esc['Telefone']).length === 9) enviarSMS([esc['Telefone']], 'Gescolar: levantamento de ' + mt(valor) + ' por ' + CANAIS[canal] + ' para o ' + numero + ' feito por ' + quem + '.').catch(() => {});
    res.json({ ok: true, id, estado: 'concluida', referencia: ref });
  } finally { levando.delete(req.escola); }
}));
app.post('/sacar-cartao', exigeSoDireccao, rota(async (req, res) => {
  const b = req.body || {};
  const valor = valorMT(b.valor);
  if (isNaN(valor)) return erro(res, 400, 'Escreva o valor em meticais, com até 2 casas decimais (ex.: 150 ou 150,50).');
  if (!(valor >= LEV_MIN)) return erro(res, 400, 'O valor mínimo de cada saque é ' + LEV_MIN + ' MT.');
  const destino = txt(b.destino, 200);
  if (destino.length < 6) return erro(res, 400, 'Escreva para onde enviar: banco e NIB, ou número M-Pesa / e-Mola.');
  if (levando.has(req.escola)) return erro(res, 409, 'Já está uma operação em curso. Espere que termine.');
  const u = await confirmarSenha(req, b.senha);
  levando.add(req.escola);
  try {
    const s = await saldoDaEscola(req.escola), c = s.canais.find(x => x.canal === 'cartao');
    if (valor > c.disponivel) return erro(res, 400, 'O saldo disponível de pagamentos com cartão é ' + mt(c.disponivel) + '.');
    const quem = u['Nome Completo'] || 'Direcção';
    const id = await criar('transferencia', { 'Escola': req.escola, 'Valor': valor, 'Data': new Date().toISOString(), 'Canal': 'cartao', 'Estado': 'pedido', 'Metodo': 'Saque de cartão',
      'Notas': 'Enviar para: ' + destino, 'Pedido Por': quem, 'Feita Por': quem });
    res.json({ ok: true, id, estado: 'pedido' });
  } finally { levando.delete(req.escola); }
}));
// Plataforma: pedidos de saque por pagar e levantamentos pendentes
app.post('/pl/saques', exigePlataforma, rota(async (req, res) => {
  const [trs, escolas] = await Promise.all([procurarTodos('transferencia', [], 20000), procurarTodos('escola', [], 5000)]);
  const EN = Object.fromEntries(escolas.map(e => [e._id, e['Nome'] || '']));
  res.json({ ok: true, saques: trs.filter(t => ['pedido', 'pendente'].includes(t['Estado'])).map(t => ({ id: t._id, escola: t['Escola'], escola_nome: EN[t['Escola']] || '', canal: t['Canal'] || '',
    canal_nome: CANAIS[t['Canal']] || '', valor: Number(t['Valor'] || 0), estado: t['Estado'], numero: t['Numero'] || '', notas: t['Notas'] || '', por: t['Pedido Por'] || '', data: t['Data'] || t['Created Date'] || null }))
    .sort((a, b) => String(a.data || '').localeCompare(String(b.data || ''))) });
}));
app.post('/pl/saque-estado', exigePlataforma, rota(async (req, res) => {
  const b = req.body || {};
  const t = await obter('transferencia', String(b.id || '')).catch(() => null);
  if (!t) return erro(res, 404, 'Pedido não encontrado.');
  if (!['concluida', 'falhada'].includes(b.estado)) return erro(res, 400, 'Estado inválido.');
  const eu = await obter('user', req.sessao.u).catch(() => null);
  await mudar('transferencia', t._id, { 'Estado': b.estado, 'Referencia': txt(b.referencia, 80) || t['Referencia'] || '', 'Feita Por': (eu && eu['Nome Completo']) || 'Plataforma' });
  const e = await obter('escola', t['Escola']).catch(() => null);
  if (b.estado === 'concluida' && e && tel9(e['Telefone']).length === 9) enviarSMS([e['Telefone']], 'Gescolar: o saque de ' + mt(Number(t['Valor'] || 0)) + ' foi pago' + (b.referencia ? '. Ref. ' + txt(b.referencia, 40) : '') + '.').catch(() => {});
  res.json({ ok: true });
}));

// ============================================================
//  WEBHOOK DA MOZPAYMENT
//  POST /wh-moz/<MOZ_WEBHOOK_KEY>
//  { transaction_id, reference, status, payment_method, wallet, amount, phone, client_name, product_name, reason, timestamp }
//  O "reason" traz o idpayment (M-Pesa/e-Mola) ou o session_id (cartão) que guardámos em Pagamento.Referencia.
// ============================================================
function chaveCerta(c) {
  if (!MOZ_WEBHOOK_KEY || !c) return false;
  const a = Buffer.from(String(c)), b = Buffer.from(MOZ_WEBHOOK_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function estadoMoz(s) {
  s = String(s || '').trim().toUpperCase();
  if (['PAID', 'SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'APPROVED', 'PAGO'].includes(s)) return 'pago';
  if (['FAILED', 'FAIL', 'ERROR', 'DECLINED', 'CANCELLED', 'CANCELED', 'REJECTED', 'FALHADO'].includes(s)) return 'falhado';
  if (['EXPIRED', 'TIMEOUT', 'EXPIRADO'].includes(s)) return 'expirado';
  return 'pendente';
}
app.get('/wh-moz/:chave', (req, res) => {
  if (!chaveCerta(req.params.chave)) return res.sendStatus(404);
  res.json({ ok: true, servico: 'gescolar', webhook: 'activo' });
});
app.post('/wh-moz/:chave', async (req, res) => {
  if (!chaveCerta(req.params.chave)) return res.sendStatus(404);
  const b = req.body || {};
  const estado = estadoMoz(b.status);
  const candidatos = [b.reason, b.reference, b.transaction_id].map(x => txt(x, 120)).filter(Boolean);
  console.log('[webhook] reason=' + (b.reason || '') + ' reference=' + (b.reference || '') + ' status=' + b.status + ' metodo=' + (b.payment_method || '') + ' valor=' + (b.amount || ''));
  try {
    if (MOZ_WALLET && b.wallet && String(b.wallet) !== MOZ_WALLET) { console.warn('[webhook] carteira diferente: ' + b.wallet); return res.json({ ok: true, ignorado: 'carteira' }); }
    let p = null;
    for (const c of candidatos) { const l = await procurar('pagamento', [{ key: 'Referencia', constraint_type: 'equals', value: c }], 1); if (l[0]) { p = l[0]; break; } }
    if (!p) {
      for (const c of candidatos) { const l = await procurar('subscricao', [{ key: 'Referencia', constraint_type: 'equals', value: c }], 1); if (l[0]) return res.json(await aplicarSubscricao(l[0], b, estado)); }
      for (const c of candidatos) { const l = await procurar('inscricaoonline', [{ key: 'Referencia', constraint_type: 'equals', value: c }], 1).catch(() => []); if (l[0]) return res.json(await aplicarInscricao(l[0], b, estado)); }
      console.warn('[webhook] referência desconhecida: ' + candidatos.join(' / ')); return res.json({ ok: true, ignorado: 'referência desconhecida' });
    }
    if (p['Estado'] === 'pago') return res.json({ ok: true, ja: 'aplicado' });
    const raw = JSON.stringify(b).slice(0, 4000);
    const valor = Math.round(Number(String(b.amount || '').replace(',', '.')));
    if (estado === 'pago' && valor !== Math.round(Number(p['Valor'] || 0))) {
      console.warn('[webhook] valor diferente: esperado=' + p['Valor'] + ' recebido=' + b.amount);
      await mudar('pagamento', p._id, { 'Estado': 'revisao', 'Transacao': txt(b.transaction_id, 120), 'Raw': raw });
      return res.json({ ok: true, revisao: true });
    }
    if (estado !== 'pago') {
      await mudar('pagamento', p._id, { 'Estado': estado, 'Transacao': txt(b.transaction_id, 120), 'Raw': raw });
      return res.json({ ok: true, estado });
    }
    const documento = await aplicarPago(p, { 'Transacao': txt(b.transaction_id, 120), 'Raw': raw, 'Telefone': txt(b.phone, 30) || p['Telefone'] || '' });
    res.json({ ok: true, estado: 'pago', documento });
  } catch (e) {
    console.error('[webhook]', e.message);
    res.status(500).json({ ok: false });
  }
});

// ============================================================
//  CHAT DA TURMA (v5.14)
//  O professor cria um chat numa turma onde dá aulas. Os estudantes da turma conversam e enviam ficheiros.
//  Os encarregados só lêem (se o professor deixar). A Direcção vê todos, pode apagar mensagens e fechar chats.
//  Ficheiros: no Bunny Storage (zona própria do Gescolar, links que expiram) até CHAT_MAX_MB (por defeito 5 MB).
//  Sem as variáveis do Bunny, ficam no armazenamento do Bubble (/fileupload), como na 5.14.
//  Tabelas: Chat Turma (Escola, Turma, Professor, Nome, Encarregados, So Professor, Activo, Ultima, Ultimo Texto, Mensagens)
//           Mensagem Chat (Escola, Chat, Autor, Autor Nome, Papel, Texto, Ficheiro URL, Ficheiro Nome, Ficheiro Tipo, Tamanho, Apagada)
// ============================================================
const CHAT_MAX_MB = Math.max(1, Math.min(20, Number(process.env.CHAT_MAX_MB || 5)));
const CHAT_TIPOS = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  txt: 'text/plain', csv: 'text/csv', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', mp4: 'video/mp4' };
const PAPEL_CHAT = { professor: 'Professor', estudante: 'Estudante', encarregado: 'Encarregado', direccao: 'Direcção' };
const BUBBLE_UPLOAD = BUBBLE_BASE.replace(/\/api\/1\.1\/obj$/, '/fileupload');

async function exigeChat(req, res, next) {
  const s = sessaoDo(req);
  if (!s) return erro(res, 401, 'A sessão terminou. Entre outra vez.');
  if (!s.e) return erro(res, 403, 'Esta conta ainda não tem escola.');
  req.sessao = s; req.escola = s.e;
  try {
    if (s.t === 'portal') {
      if (s.p === 'Professor') req.papelChat = 'professor';
      else if (s.p === 'Estudante' || s.p === 'Encarregado') { req.papelChat = s.p === 'Estudante' ? 'estudante' : 'encarregado'; req.educandos = await educandosDe(s); }
      else return erro(res, 403, 'Sem acesso ao chat.');
    } else if (s.p === 'Direccao' || s.p === 'Secretaria') req.papelChat = 'direccao';
    else return erro(res, 403, 'Sem acesso ao chat.');
    next();
  } catch (e) { console.error('[chat]', e.message); erro(res, 500, 'Não foi possível concluir. Tente de novo.'); }
}
// turmas onde o professor dá aulas (pelo horário, pelas disciplinas ou como titular)
async function turmasDoProfessor(escola, prof) {
  const a = await atribuicoes(escola), DM = {};
  const discs = await procurarTodos('disciplina', daEscola(escola));
  discs.forEach(d => { DM[d._id] = d['Nome'] || ''; });
  const T = {};
  for (const t of a.turmas.filter(x => x['Activa'] !== false)) {
    const minhas = a.pares.filter(p => p.turma === t._id && p.professores.has(prof)).map(p => DM[p.disciplina]).filter(Boolean);
    const titular = t['Professor Titular'] === prof;
    if (minhas.length || titular) T[t._id] = { id: t._id, nome: t['Nome'] || '', disciplinas: minhas.sort((x, y) => x.localeCompare(y, 'pt')), titular };
  }
  return T;
}
// turmas dos educandos (portal); com estudante, só a turma desse educando
async function turmasDoPortal(req, estudante) {
  let ids = req.educandos || [];
  if (estudante) { if (!ids.includes(estudante)) { const e = new Error('Estudante não encontrado.'); e.publico = 404; throw e; } ids = [estudante]; }
  const ests = (await Promise.all(ids.map(id => obter('estudante', id).catch(() => null)))).filter(e => e && e['Escola'] === req.escola && e['Turma']);
  return [...new Set(ests.map(e => e['Turma']))];
}
function chatOut(c, extra) {
  return Object.assign({ id: c._id, nome: c['Nome'] || '', turma: c['Turma'] || '', professor: c['Professor'] || '',
    encarregados: c['Encarregados'] !== false, so_professor: c['So Professor'] === true, activo: c['Activo'] !== false,
    ultima: c['Ultima'] || c['Created Date'] || null, ultimo_texto: c['Ultimo Texto'] || '', mensagens: Number(c['Mensagens'] || 0) }, extra || {});
}
// carrega o chat e diz o que esta pessoa pode fazer nele
async function abrirChat(req, id) {
  const c = await obter('chatturma', String(id || '')).catch(() => null);
  const nao = () => { const e = new Error('Chat não encontrado.'); e.publico = 404; return e; };
  if (!c || c['Escola'] !== req.escola) throw nao();
  const p = req.papelChat, activo = c['Activo'] !== false, u = req.sessao.u;
  if (p === 'direccao') return { c, ler: true, escrever: activo, gerir: true };
  if (p === 'professor') {
    if (c['Professor'] !== u) throw nao();
    return { c, ler: true, escrever: activo, gerir: true };
  }
  if (!activo) throw nao();
  const turmas = await turmasDoPortal(req);
  if (!turmas.includes(c['Turma'])) throw nao();
  if (p === 'encarregado' && c['Encarregados'] === false) throw nao();
  return { c, ler: true, escrever: p === 'estudante' && c['So Professor'] !== true, gerir: false };
}
function msgOut(m, req, gerir) {
  const meu = m['Autor'] === req.sessao.u && (m['Papel'] || '') === req.papelChat;
  if (m['Apagada']) return { id: m._id, apagada: true, data: m['Created Date'], mod: m['Modified Date'] };
  return { id: m._id, autor: m['Autor Nome'] || '', papel: m['Papel'] || '', papel_nome: PAPEL_CHAT[m['Papel']] || '', eu: meu,
    texto: m['Texto'] || '', data: m['Created Date'], mod: m['Modified Date'],
    ficheiro: m['Ficheiro URL'] ? { url: linkFicheiro(m['Ficheiro URL']), nome: m['Ficheiro Nome'] || 'ficheiro', tipo: m['Ficheiro Tipo'] || '', tamanho: Number(m['Tamanho'] || 0) } : null,
    pode_apagar: meu || !!gerir };
}
// mensagens: as últimas (ou as mais antigas que «antes»), ou as mudadas depois de «depois» (para actualizar o ecrã)
async function mensagensDo(escola, chat, op) {
  const f = daEscola(escola).concat([{ key: 'Chat', constraint_type: 'equals', value: chat }]);
  if (op.depois) f.push({ key: 'Modified Date', constraint_type: 'greater than', value: op.depois });
  if (op.antes) f.push({ key: 'Created Date', constraint_type: 'less than', value: op.antes });
  const q = '?constraints=' + encodeURIComponent(JSON.stringify(f)) + '&limit=' + (op.limite || 60) + '&sort_field=' + encodeURIComponent(op.depois ? 'Modified Date' : 'Created Date') + '&descending=' + (op.depois ? 'false' : 'true');
  let d; try { d = await bubble('GET', '/mensagemchat' + q); } catch (e) { throw erroTabela('mensagemchat', e); }
  const r = (d && d.response) || {};
  const l = r.results || [];
  return { lista: l.sort((x, y) => String(x['Created Date']).localeCompare(String(y['Created Date']))), mais: !op.depois && !!r.remaining };
}
// envia o ficheiro para o armazenamento do Bubble e devolve o endereço
// ---------- Bunny Storage (v5.15): ficheiros do chat numa storage zone só do Gescolar ----------
//    STORAGE_ZONE      nome da storage zone (ex.: gescolar)
//    STORAGE_PASSWORD  password da storage zone (FTP & API Access → Password)
//    STORAGE_HOST      storage.bunnycdn.com (Falkenstein) ou o da região, ex.: jh.storage.bunnycdn.com
//    CDN_HOST          hostname da pull zone ligada à storage zone (ex.: gescolar.b-cdn.net)
//    CDN_TOKEN_KEY     Security → Token Authentication → Url Token Authentication Key (os links passam a expirar)
const STORAGE_ZONE = (process.env.STORAGE_ZONE || '').trim();
const STORAGE_PASSWORD = (process.env.STORAGE_PASSWORD || '').trim();
const STORAGE_HOST = (process.env.STORAGE_HOST || 'storage.bunnycdn.com').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const CDN_HOST = (process.env.CDN_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const CDN_TOKEN_KEY = (process.env.CDN_TOKEN_KEY || '').trim();
const BUNNY_OK = !!(STORAGE_ZONE && STORAGE_PASSWORD && CDN_HOST);
const LINK_HORAS = 24;   // cada link de ficheiro vale 24 horas; ao abrir o chat outra vez gera-se um novo
const caminhoUrl = c => c.split('/').map(encodeURIComponent).join('/');
async function guardarFicheiroBunny(caminho, base64) {
  const r = await fetch('https://' + STORAGE_HOST + '/' + STORAGE_ZONE + caminhoUrl(caminho), { method: 'PUT', headers: { 'AccessKey': STORAGE_PASSWORD, 'Content-Type': 'application/octet-stream' }, body: Buffer.from(base64, 'base64'), signal: AbortSignal.timeout(60000) })
    .catch(e => { console.error('[bunny] envio', e.message); throw pub('Não foi possível guardar o ficheiro. Tente outra vez.'); });
  if (!r.ok) { console.error('[bunny] envio', r.status, (await r.text().catch(() => '')).slice(0, 200)); throw pub(r.status === 401 ? 'O armazenamento recusou o ficheiro: confira STORAGE_ZONE, STORAGE_PASSWORD e STORAGE_HOST no Render.' : 'Não foi possível guardar o ficheiro (' + r.status + '). Tente outra vez.'); }
  return caminho;
}
async function apagarFicheiroBunny(caminho) {
  if (!BUNNY_OK || !caminho || !caminho.startsWith('/')) return;
  const r = await fetch('https://' + STORAGE_HOST + '/' + STORAGE_ZONE + caminhoUrl(caminho), { method: 'DELETE', headers: { 'AccessKey': STORAGE_PASSWORD }, signal: AbortSignal.timeout(20000) }).catch(e => ({ ok: false, status: e.message }));
  if (!r.ok && r.status !== 404) console.error('[bunny] apagar', r.status);
}
// link para abrir o ficheiro: com CDN_TOKEN_KEY é assinado e expira (Token Authentication do Bunny)
function linkFicheiro(guardado) {
  if (!guardado) return '';
  if (!guardado.startsWith('/')) return guardado;          // ficheiros antigos guardados no Bubble (5.14)
  const path = caminhoUrl(guardado), base = 'https://' + CDN_HOST + path;
  if (!CDN_TOKEN_KEY) return base;
  const expira = Math.floor(Date.now() / 1000) + LINK_HORAS * 3600;
  const token = crypto.createHash('sha256').update(CDN_TOKEN_KEY + path + expira).digest('base64').replace(/\n/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return base + '?token=' + token + '&expires=' + expira;
}
async function guardarFicheiroBubble(nome, base64) {
  if (!BUBBLE_UPLOAD || !BUBBLE_TOKEN) throw pub('O servidor ainda não está configurado (BUBBLE_BASE).');
  const r = await fetch(BUBBLE_UPLOAD, { method: 'POST', headers: { 'Authorization': 'Bearer ' + BUBBLE_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nome, contents: base64, private: false }) });
  const t = (await r.text()).trim();
  if (!r.ok) { console.error('[chat] fileupload', r.status, t.slice(0, 200)); throw pub('O Bubble não aceitou o ficheiro (' + r.status + '). Tente outra vez ou envie um ficheiro mais pequeno.'); }
  let url = t; try { const j = JSON.parse(t); if (typeof j === 'string') url = j; else if (j && (j.url || j.response)) url = j.url || j.response; } catch (e) {}
  url = String(url || '').replace(/^"+|"+$/g, '').trim();
  if (url.startsWith('//')) url = 'https:' + url;
  if (!/^https:\/\//.test(url)) { console.error('[chat] fileupload resposta', t.slice(0, 200)); throw pub('O Bubble não devolveu o endereço do ficheiro.'); }
  return url;
}
function nomeFicheiroLimpo(n) {
  const s = String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').replace(/^\.+/, '');
  return (s || 'ficheiro').slice(-80);
}

// lista de chats (cada papel vê os seus)
app.post('/chat/lista', exigeChat, rota(async (req, res) => {
  const b = req.body || {}, p = req.papelChat, f = daEscola(req.escola);
  if (p === 'professor') {
    const [T, cs] = await Promise.all([turmasDoProfessor(req.escola, req.sessao.u), procurarTodos('chatturma', f.concat([{ key: 'Professor', constraint_type: 'equals', value: req.sessao.u }]), 300)]);
    const chats = cs.filter(c => c['Activo'] !== false).map(c => chatOut(c, { turma_nome: (T[c['Turma']] || {}).nome || 'Turma', pode_gerir: true, pode_escrever: true }));
    return res.json({ ok: true, papel: p, pode_criar: true, max_mb: CHAT_MAX_MB, turmas: Object.values(T).sort((x, y) => x.nome.localeCompare(y.nome, 'pt')), chats: ordenarChats(chats) });
  }
  if (p === 'direccao') {
    const [cs, ts, ps] = await Promise.all([procurarTodos('chatturma', f, 1000), procurarTodos('turma', f), procurarTodos('professor', f)]);
    const TN = Object.fromEntries(ts.map(t => [t._id, t['Nome'] || ''])), PN = Object.fromEntries(ps.map(x => [x._id, x['Nome'] || '']));
    const chats = cs.map(c => chatOut(c, { turma_nome: TN[c['Turma']] || 'Turma', professor_nome: PN[c['Professor']] || '', pode_gerir: true, pode_escrever: c['Activo'] !== false }));
    return res.json({ ok: true, papel: p, pode_criar: false, max_mb: CHAT_MAX_MB, chats: ordenarChats(chats) });
  }
  const turmas = await turmasDoPortal(req, b.estudante ? String(b.estudante) : '');
  if (!turmas.length) return res.json({ ok: true, papel: p, pode_criar: false, max_mb: CHAT_MAX_MB, chats: [] });
  const listas = await Promise.all(turmas.map(t => procurarTodos('chatturma', f.concat([{ key: 'Turma', constraint_type: 'equals', value: t }]), 100)));
  const todos = [].concat(...listas).filter(c => c['Activo'] !== false && (p === 'estudante' || c['Encarregados'] !== false));
  const tIds = [...new Set(todos.map(c => c['Turma']))], pIds = [...new Set(todos.map(c => c['Professor']).filter(Boolean))];
  const [ts, ps] = await Promise.all([Promise.all(tIds.map(id => obter('turma', id).catch(() => null))), Promise.all(pIds.map(id => obter('professor', id).catch(() => null)))]);
  const TN = {}, PN = {}; ts.filter(Boolean).forEach(t => { TN[t._id] = t['Nome'] || ''; }); ps.filter(Boolean).forEach(x => { PN[x._id] = x['Nome'] || ''; });
  const chats = todos.map(c => chatOut(c, { turma_nome: TN[c['Turma']] || 'Turma', professor_nome: PN[c['Professor']] || '', pode_gerir: false, pode_escrever: p === 'estudante' && c['So Professor'] !== true }));
  res.json({ ok: true, papel: p, pode_criar: false, max_mb: CHAT_MAX_MB, chats: ordenarChats(chats) });
}));
function ordenarChats(l) { return l.sort((x, y) => (y.activo - x.activo) || String(y.ultima || '').localeCompare(String(x.ultima || ''))); }

// professor cria ou muda um chat
app.post('/chat/guardar', exigeChat, rota(async (req, res) => {
  const b = req.body || {}, p = req.papelChat;
  if (p !== 'professor' && p !== 'direccao') return erro(res, 403, 'Só o professor pode criar chats.');
  const nome = txt(b.nome, 80);
  if (nome.length < 2) return erro(res, 400, 'Dê um nome ao chat, por exemplo «10ª A · Matemática».');
  const campos = { 'Nome': nome, 'Encarregados': b.encarregados !== false, 'So Professor': b.so_professor === true };
  if (b.id) {
    const x = await abrirChat(req, b.id);
    if (!x.gerir) return erro(res, 403, 'Só o professor deste chat pode mudá-lo.');
    if (p === 'direccao' && typeof b.activo === 'boolean') campos['Activo'] = b.activo;
    await mudar('chatturma', x.c._id, campos);
    return res.json({ ok: true, id: x.c._id });
  }
  if (p !== 'professor') return erro(res, 403, 'Os chats são criados pelos professores.');
  const T = await turmasDoProfessor(req.escola, req.sessao.u), turma = String(b.turma || '');
  if (!T[turma]) return erro(res, 403, 'Só pode criar chats nas turmas onde dá aulas.');
  const meus = await procurarTodos('chatturma', daEscola(req.escola).concat([{ key: 'Professor', constraint_type: 'equals', value: req.sessao.u }]), 300);
  if (meus.filter(c => c['Activo'] !== false).length >= 40) return erro(res, 400, 'Já tem 40 chats abertos. Feche os que já não usa.');
  const id = await criar('chatturma', Object.assign(campos, { 'Escola': req.escola, 'Turma': turma, 'Professor': req.sessao.u, 'Activo': true, 'Ultima': new Date().toISOString(), 'Mensagens': 0, 'Ultimo Texto': '' }));
  res.json({ ok: true, id });
}));
// fechar (professor ou Direcção) — o chat sai da lista dos estudantes; a Direcção pode reabrir
app.post('/chat/fechar', exigeChat, rota(async (req, res) => {
  const b = req.body || {}, x = await abrirChat(req, b.id);
  if (!x.gerir) return erro(res, 403, 'Só o professor deste chat pode fechá-lo.');
  const abrir = req.papelChat === 'direccao' && b.reabrir === true;
  await mudar('chatturma', x.c._id, { 'Activo': abrir });
  res.json({ ok: true, activo: abrir });
}));

app.post('/chat/mensagens', exigeChat, rota(async (req, res) => {
  const b = req.body || {}, x = await abrirChat(req, b.chat);
  const iso = v => { const d = new Date(String(v || '')); return isNaN(d) ? '' : d.toISOString(); };
  const depois = iso(b.depois), antes = iso(b.antes);
  const r = await mensagensDo(req.escola, x.c._id, { depois, antes, limite: depois ? 100 : 60 });
  let marca = depois || '';
  r.lista.forEach(m => { if (String(m['Modified Date'] || '') > marca) marca = m['Modified Date']; });
  res.json({ ok: true, chat: chatOut(x.c, { pode_escrever: x.escrever, pode_gerir: x.gerir }), mensagens: r.lista.map(m => msgOut(m, req, x.gerir)), mais: r.mais, marca: marca || '2000-01-01T00:00:00.000Z', max_mb: CHAT_MAX_MB });
}));

app.post('/chat/enviar', exigeChat, rota(async (req, res) => {
  const b = req.body || {}, x = await abrirChat(req, b.chat);
  if (!x.escrever) return erro(res, 403, x.c['Activo'] === false ? 'Este chat está fechado.' : req.papelChat === 'encarregado' ? 'Os encarregados podem ler o chat, mas não escrever.' : 'Neste chat só o professor escreve.');
  if (travao('chat:' + req.sessao.u, 20, 1)) return erro(res, 429, 'Muitas mensagens seguidas. Espere um minuto.');
  const texto = txt(b.texto, 2000);
  const campos = { 'Escola': req.escola, 'Chat': x.c._id, 'Autor': req.sessao.u, 'Papel': req.papelChat, 'Texto': texto, 'Apagada': false };
  const fx = b.ficheiro;
  if (!texto && !(fx && fx.dados)) return erro(res, 400, 'Escreva uma mensagem ou escolha um ficheiro.');
  if (fx && fx.dados) {
    const nome = nomeFicheiroLimpo(fx.nome), ext = (nome.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    const tipo = ext && CHAT_TIPOS[ext.toLowerCase()];
    if (!tipo) return erro(res, 400, 'Este tipo de ficheiro não é aceite. Envie PDF, imagens, Word, Excel, PowerPoint, texto ou áudio.');
    const dados = String(fx.dados).replace(/^data:[^,]*,/, '').replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(dados)) return erro(res, 400, 'O ficheiro chegou estragado. Tente outra vez.');
    const bytes = Math.floor(dados.length * 3 / 4) - (dados.endsWith('==') ? 2 : dados.endsWith('=') ? 1 : 0);
    if (bytes > CHAT_MAX_MB * 1048576) return erro(res, 400, 'O ficheiro tem mais de ' + CHAT_MAX_MB + ' MB.');
    if (bytes < 1) return erro(res, 400, 'O ficheiro está vazio.');
    if (travao('chatfx:' + req.escola, 300, 60)) return erro(res, 429, 'A escola enviou muitos ficheiros na última hora. Tente mais tarde.');
    campos['Ficheiro URL'] = BUNNY_OK
      ? await guardarFicheiroBunny('/' + req.escola + '/chat/' + x.c._id + '/' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex') + '/' + nome, dados)
      : await guardarFicheiroBubble(nome, dados);
    Object.assign(campos, { 'Ficheiro Nome': nome, 'Ficheiro Tipo': tipo, 'Tamanho': bytes });
  }
  const tabela = { professor: 'professor', estudante: 'estudante', encarregado: 'encarregado' }[req.papelChat];
  const eu = tabela ? await obter(tabela, req.sessao.u).catch(() => null) : await obter('user', req.sessao.u).catch(() => null);
  campos['Autor Nome'] = txt((eu && (eu['Nome'] || eu['Nome Completo'])) || PAPEL_CHAT[req.papelChat], 80);
  const id = await criar('mensagemchat', campos);
  const resumo = (campos['Autor Nome'].split(' ')[0] + ': ' + (texto || '📎 ' + (campos['Ficheiro Nome'] || 'ficheiro'))).slice(0, 120);
  await mudar('chatturma', x.c._id, { 'Ultima': new Date().toISOString(), 'Ultimo Texto': resumo, 'Mensagens': Number(x.c['Mensagens'] || 0) + 1 }).catch(e => console.error('[chat] resumo', e.message));
  const m = await obter('mensagemchat', id).catch(() => null);
  res.json({ ok: true, mensagem: m ? msgOut(m, req, x.gerir) : { id, eu: true, texto, data: new Date().toISOString() } });
}));

app.post('/chat/apagar', exigeChat, rota(async (req, res) => {
  const b = req.body || {};
  const m = await obter('mensagemchat', String(b.id || '')).catch(() => null);
  if (!m || m['Escola'] !== req.escola) return erro(res, 404, 'Mensagem não encontrada.');
  const x = await abrirChat(req, m['Chat']);
  const meu = m['Autor'] === req.sessao.u && m['Papel'] === req.papelChat;
  if (!meu && !x.gerir) return erro(res, 403, 'Só pode apagar as suas mensagens.');
  await mudar('mensagemchat', m._id, { 'Apagada': true, 'Texto': '', 'Ficheiro URL': '' });
  if (m['Ficheiro URL']) await apagarFicheiroBunny(m['Ficheiro URL']);
  res.json({ ok: true });
}));

// ============================================================
//  IMPORTAR ESTUDANTES POR EXCEL (v5.18)
//  A página lê o Excel (modelo do Gescolar) e manda as linhas. Primeiro com testar:true (só valida, mostra os erros
//  linha a linha), depois sem testar para gravar. Os encarregados são reutilizados pelo telemóvel ou criados.
// ============================================================
async function criarEmLoteIds(tipo, lista) {
  const ids = [];
  for (let i = 0; i < lista.length; i += 200) {
    const fatia = lista.slice(i, i + 200);
    const r = await fetch(BUBBLE_BASE + '/' + tipo + '/bulk', { method: 'POST', headers: { 'Authorization': 'Bearer ' + BUBBLE_TOKEN, 'Content-Type': 'text/plain' }, body: fatia.map(x => JSON.stringify(x)).join('\n') });
    const t = await r.text();
    if (!r.ok) {
      let msg = t; try { const d = JSON.parse(t); msg = (d.body && d.body.message) || d.message || t; } catch (e) {}
      throw erroGravar(tipo, Object.assign(new Error(msg), { status: r.status === 404 ? 404 : 400, bubble: String(msg).slice(0, 200) }));
    }
    const linhas = t.split('\n').filter(Boolean);
    fatia.forEach((x, k) => { let id = null; try { const d = JSON.parse(linhas[k] || '{}'); if (d.status === 'success') id = d.id; else if (k === 0 && !ids.length && d.message) console.error('[lote] ' + tipo + ': ' + d.message); } catch (e) {} ids.push(id); });
  }
  return ids;
}
const normNome = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ºª]+/g, ' ').trim();
// aceita AAAA-MM-DD, DD/MM/AAAA, DD-MM-AAAA ou DD.MM.AAAA
function dataValida(iso) { const d = new Date(iso + 'T12:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === iso && +iso.slice(0, 4) > 1900 ? iso : null; }
function dataImport(v) {
  const s = String(v || '').trim(); if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return dataValida(m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0'));
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/); if (m) return dataValida(m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'));
  return null;
}
app.post('/importar-estudantes', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, testar = b.testar !== false, comSMS = b.sms === true;
  const linhas = Array.isArray(b.linhas) ? b.linhas.slice(0, 1000) : [];
  if (!linhas.length) return erro(res, 400, 'O ficheiro não tem estudantes. Preencha a folha «Estudantes» do modelo a partir da linha 2.');
  if (!testar && travao('importar|' + req.escola, 40, 60)) return erro(res, 429, 'Muitas importações seguidas. Espere um pouco.');
  const f = daEscola(req.escola);
  const [turmas, ests, encs, escola] = await Promise.all([procurarTodos('turma', f), procurarTodos('estudante', f), procurarTodos('encarregado', f), resumoEscola(req.escola)]);
  const TN = {}; turmas.filter(t => t['Activa'] !== false).forEach(t => { TN[normNome(t['Nome'])] = t; TN[t._id] = t; });
  const jaNaTurma = new Set(ests.filter(e => (e['Estado'] || 'activo') !== 'apagado').map(e => e['Turma'] + '|' + normNome(e['Nome'])));
  const encPorTel = {}; encs.forEach(e => { const t = tel9(e['Telefone']); if (t.length === 9) encPorTel[t] = e; });
  const novosEnc = {};   // telefone → {nome, email, parentesco}
  const vistos = new Set(), resultado = [], validas = [];
  linhas.forEach((l, i) => {
    const n = Number(l.linha) || i + 2, erros = [];
    const nome = txt(l.nome, 100).replace(/\s+/g, ' ');
    if (nome.split(' ').filter(Boolean).length < 2) erros.push('falta o nome e o apelido do estudante');
    const turma = TN[String(l.turma || '')] || TN[normNome(l.turma)];
    if (!turma) erros.push(l.turma ? 'a turma «' + txt(l.turma, 40) + '» não existe (veja a folha Turmas)' : 'falta a turma');
    const superior = turma && (turma['Nivel'] === NIVEIS.SUP || turma['Nivel'] === 'SUP');
    const sexo = String(l.sexo || '').trim().toUpperCase().charAt(0);
    if (sexo && sexo !== 'M' && sexo !== 'F') erros.push('sexo deve ser M ou F');
    const nasc = dataImport(l.nascimento);
    if (nasc === null) erros.push('data de nascimento inválida (use DD/MM/AAAA)');
    const telE = tel9(l.telefone);
    if (String(l.telefone || '').trim() && (telE.length !== 9 || !/^8[2-7]/.test(telE))) erros.push('telemóvel do estudante inválido');
    if (superior && telE.length !== 9) erros.push('no ensino superior o telemóvel do estudante é obrigatório');
    const encNome = txt(l.enc_nome, 100).replace(/\s+/g, ' '), telEnc = tel9(l.enc_telefone), encEmail = txt(l.enc_email, 120).toLowerCase();
    let enc = null;
    if (encNome || String(l.enc_telefone || '').trim()) {
      if (telEnc.length !== 9 || !/^8[2-7]/.test(telEnc)) erros.push('telemóvel do encarregado inválido (9 dígitos, começa por 82 a 87)');
      else if (encPorTel[telEnc]) enc = { id: encPorTel[telEnc]._id, tel: encPorTel[telEnc]['Recebe SMS'] === false ? '' : telEnc };
      else if (novosEnc[telEnc]) enc = { novo: telEnc, tel: telEnc };
      else if (encNome.split(' ').filter(Boolean).length < 2) erros.push('falta o nome completo do encarregado');
      else enc = { novo: telEnc, tel: telEnc, nome: encNome };
      if (encEmail && !emailOk(encEmail)) erros.push('email do encarregado inválido');
    } else if (turma && !superior) erros.push('encarregado obrigatório neste nível (nome e telemóvel)');
    const chave = turma ? turma._id + '|' + normNome(nome) : '';
    if (turma && nome && jaNaTurma.has(chave)) erros.push('já está matriculado nesta turma');
    else if (chave && vistos.has(chave)) erros.push('repetido no ficheiro');
    if (chave) vistos.add(chave);
    if (erros.length) { resultado.push({ linha: n, nome, ok: false, erro: erros.join('; ') }); return; }
    if (enc && enc.nome) novosEnc[telEnc] = { nome: encNome, email: encEmail, parentesco: txt(l.enc_parentesco, 30) };
    validas.push({ n, nome, turma, superior, sexo, nasc, telE, enc });
    resultado.push({ linha: n, nome, ok: true, turma: turma['Nome'] || '', novo_encarregado: !!(enc && enc.novo) });
  });
  const resumo = { total: linhas.length, validas: validas.length, com_erro: linhas.length - validas.length, novos_encarregados: Object.keys(novosEnc).length };
  if (testar || !validas.length) return res.json({ ok: true, testar: true, resumo, linhas: resultado });
  // 1) encarregados novos
  const telsNovos = Object.keys(novosEnc);
  const idsEnc = await criarEmLoteIds('encarregado', telsNovos.map(t => ({ 'Escola': req.escola, 'Nome': novosEnc[t].nome, 'Telefone': t.replace(/(\d{2})(\d{3})(\d{4})/, '$1 $2 $3'), 'Email': novosEnc[t].email, 'Parentesco': novosEnc[t].parentesco, 'Recebe SMS': true, 'Activo': true })));
  const encId = {}; telsNovos.forEach((t, k) => { encId[t] = idsEnc[k]; });
  // 2) estudantes, com número ano-sequência
  const ano = (escola && escola.ano) || String(new Date().getFullYear());
  let maior = ests.map(e => String(e['Numero'] || '')).filter(x => x.startsWith(ano + '-')).map(x => parseInt(x.split('-')[1], 10) || 0).reduce((a, c) => Math.max(a, c), 0);
  const agora = new Date().toISOString();
  const lote = validas.map(v => {
    v.numero = ano + '-' + String(++maior).padStart(4, '0');
    const c = { 'Escola': req.escola, 'Numero': v.numero, 'Nome': v.nome, 'Sexo': v.sexo || '', 'Turma': v.turma._id, 'Ano Lectivo': ano, 'Data Matricula': agora, 'Estado': 'activo' };
    if (v.nasc) c['Data Nascimento'] = new Date(v.nasc + 'T12:00:00Z').toISOString();
    if (v.telE.length === 9) c['Telefone'] = v.telE.replace(/(\d{2})(\d{3})(\d{4})/, '$1 $2 $3');
    const eid = v.enc ? (v.enc.id || encId[v.enc.novo]) : null; if (eid) c['Encarregado'] = eid;
    return c;
  });
  const idsEst = await criarEmLoteIds('estudante', lote);
  let criados = 0, sms = 0;
  const esc = comSMS ? await obter('escola', req.escola).catch(() => null) : null;
  for (let k = 0; k < validas.length; k++) {
    const v = validas[k], r = resultado.find(x => x.linha === v.n);
    if (!idsEst[k]) { r.ok = false; r.erro = 'o Bubble não gravou esta linha'; continue; }
    criados++; r.numero = v.numero;
    if (esc) {
      const link = noGescolar(esc['Subdominio']), en = esc['Nome'] || 'A escola', tn = v.turma['Nome'] || '';
      if (v.telE.length === 9 && (await enviarSMS([v.telE], en + ': ' + (v.superior ? 'bem-vindo(a), ' + v.nome.split(' ')[0] + '. Esta inscrito(a) em ' : v.nome + ' esta matriculado(a) na ') + tn + ' com o numero ' + v.numero + '. Veja notas, horario e propinas ' + link + ' (escolha Estudante e escreva ' + v.numero + ').')).ok) sms++;
      if (v.enc && v.enc.tel && v.enc.tel !== v.telE && (await enviarSMS([v.enc.tel], en + ': ' + v.nome + ' foi matriculado(a) na ' + tn + ' com o numero ' + v.numero + '. Veja propinas, recibos e notas e pague por M-Pesa ou e-Mola ' + link + ' (escolha Encarregado e use este numero de telemovel).')).ok) sms++;
    }
  }
  cachePainel.delete(req.escola);
  res.json({ ok: true, testar: false, resumo: Object.assign(resumo, { criados, sms }), linhas: resultado });
}));

// ============================================================
//  PLANOS DE AULA (v5.18) — modelo usado nas escolas moçambicanas
//  Cabeçalho (unidade temática, tema, objectivos, meios, métodos…) e as quatro funções didácticas:
//  Introdução e Motivação · Mediação e Assimilação · Domínio e Consolidação · Controlo e Avaliação.
//  O professor faz (à mão ou com rascunho da IA, opcional), submete; a Direcção dá o visto ou devolve com comentário.
//  Bubble: Plano Aula — Escola (Escola), Professor, Turma, Disciplina, Data, Tema, Estado, Dados, Comentario, Visto Por (text), Visto Em, Submetido Em (date)
// ============================================================
const FUNCOES_DIDACTICAS = ['Introdução e Motivação', 'Mediação e Assimilação', 'Domínio e Consolidação', 'Controlo e Avaliação'];
const ESTADOS_PLANO = { rascunho: 'Rascunho', submetido: 'Submetido', aprovado: 'Aprovado', devolvido: 'Devolvido' };
function lerDadosPlano(d) {
  d = d && typeof d === 'object' ? d : {};
  const t = (k, m) => txt(d[k], m || 600);
  const dur = Math.max(10, Math.min(300, Math.round(Number(d.duracao) || 45)));
  const fases = FUNCOES_DIDACTICAS.map((f, i) => { const x = (Array.isArray(d.fases) ? d.fases[i] : null) || {};
    return { funcao: f, tempo: Math.max(0, Math.min(300, Math.round(Number(x.tempo) || 0))), conteudo: txt(x.conteudo, 1500), professor: txt(x.professor, 1500), aluno: txt(x.aluno, 1500), metodos: txt(x.metodos, 300), meios: txt(x.meios, 300) }; });
  return { trimestre: Math.max(0, Math.min(3, Number(d.trimestre) || 0)), licao: txt(d.licao, 10), unidade: t('unidade', 200), tema: t('tema', 200), tipo: t('tipo', 80), duracao: dur,
    objectivos: t('objectivos', 1500), competencias: t('competencias', 1000), meios: t('meios', 400), metodos: t('metodos', 400), bibliografia: t('bibliografia', 600), observacoes: t('observacoes', 1000), fases };
}
function planoOut(p, N) {
  N = N || {};
  return { id: p._id, professor: p['Professor'] || '', professor_nome: (N.prof || {})[p['Professor']] || '', turma: p['Turma'] || '', turma_nome: (N.turma || {})[p['Turma']] || '', classe: (N.classe || {})[p['Turma']] || '',
    disciplina: p['Disciplina'] || '', disciplina_nome: (N.disc || {})[p['Disciplina']] || '', data: p['Data'] || '', tema: p['Tema'] || '', estado: p['Estado'] || 'rascunho',
    comentario: p['Comentario'] || '', visto_por: p['Visto Por'] || '', visto_em: p['Visto Em'] || null, submetido_em: p['Submetido Em'] || null, actualizado: p['Modified Date'] || null,
    dados: N.semDados ? undefined : lerDadosPlano(lerJSON(p['Dados'], {})) };
}
async function nomesPlanos(escola) {
  const f = daEscola(escola);
  const [ts, ds, ps, esc] = await Promise.all([procurarTodos('turma', f), procurarTodos('disciplina', f), procurarTodos('professor', f), obter('escola', escola).catch(() => null)]);
  const N = { turma: {}, classe: {}, disc: {}, prof: {}, escola: (esc && esc['Nome']) || '', logotipo: (esc && esc['Logotipo']) || '' };
  ts.forEach(t => { N.turma[t._id] = t['Nome'] || ''; N.classe[t._id] = t['Classe'] || ''; }); ds.forEach(d => { N.disc[d._id] = d['Nome'] || ''; }); ps.forEach(p => { N.prof[p._id] = p['Nome'] || ''; });
  return N;
}
function validarSubmissao(d) {
  if (!d.tema) return 'Escreva o tema da aula.';
  if (!d.objectivos) return 'Escreva os objectivos da aula.';
  const vazias = d.fases.filter(f => !f.conteudo && !f.professor && !f.aluno).map(f => f.funcao);
  if (vazias.length) return 'Preencha as funções didácticas: falta ' + vazias.join(', ') + '.';
  return null;
}
// professor: os seus planos e as turmas/disciplinas que dá
app.post('/prof/planos', exigeProfessor, rota(async (req, res) => {
  const [a, N, ps] = await Promise.all([atribuicoes(req.escola), nomesPlanos(req.escola), procurarTodos('planoaula', daEscola(req.escola).concat([{ key: 'Professor', constraint_type: 'equals', value: req.sessao.u }]), 1000)]);
  const pares = a.pares.filter(p => p.professores.has(req.sessao.u) && N.turma[p.turma] && N.disc[p.disciplina])
    .map(p => ({ turma: p.turma, turma_nome: N.turma[p.turma], classe: N.classe[p.turma], disciplina: p.disciplina, disciplina_nome: N.disc[p.disciplina] }))
    .sort((x, y) => x.turma_nome.localeCompare(y.turma_nome, 'pt') || x.disciplina_nome.localeCompare(y.disciplina_nome, 'pt'));
  res.json({ ok: true, escola: N.escola, logotipo: N.logotipo, professor: N.prof[req.sessao.u] || '', ia: !!OPENAI_KEY, pares,
    planos: ps.map(p => planoOut(p, Object.assign({ semDados: true }, N))).sort((x, y) => String(y.data).localeCompare(String(x.data)) || String(y.actualizado).localeCompare(String(x.actualizado))) });
}));
app.post('/prof/plano', exigeProfessor, rota(async (req, res) => {
  const p = await daMinhaEscola('planoaula', String((req.body || {}).id || ''), req.escola);
  if (p['Professor'] !== req.sessao.u) return erro(res, 404, 'Plano não encontrado.');
  res.json({ ok: true, plano: planoOut(p, await nomesPlanos(req.escola)) });
}));
app.post('/prof/plano-guardar', exigeProfessor, rota(async (req, res) => {
  const b = req.body || {}, turma = String(b.turma || ''), disc = String(b.disciplina || '');
  if (!await podeLancar(req, turma, disc)) return erro(res, 403, 'Só pode fazer planos das disciplinas e turmas onde dá aulas.');
  const data = dataImport(b.data); if (!data) return erro(res, 400, 'Escolha a data da aula.');
  const d = lerDadosPlano(b.dados);
  if (b.submeter) { const e = validarSubmissao(d); if (e) return erro(res, 400, e); }
  const campos = { 'Turma': turma, 'Disciplina': disc, 'Data': data, 'Tema': d.tema || 'Sem tema', 'Dados': JSON.stringify(d) };
  if (b.submeter) Object.assign(campos, { 'Estado': 'submetido', 'Submetido Em': new Date().toISOString() });
  let id = b.id ? String(b.id) : '';
  if (id) {
    const p = await daMinhaEscola('planoaula', id, req.escola);
    if (p['Professor'] !== req.sessao.u) return erro(res, 404, 'Plano não encontrado.');
    if (p['Estado'] === 'aprovado') return erro(res, 409, 'Este plano já tem o visto da Direcção e não pode ser mudado. Faça uma cópia.');
    if (!b.submeter && p['Estado'] === 'submetido') campos['Estado'] = 'rascunho';   // mexeu depois de submeter: volta a rascunho até submeter outra vez
    await mudar('planoaula', id, campos);
  } else {
    if (travao('plano|' + req.sessao.u, 60, 60)) return erro(res, 429, 'Muitos planos seguidos. Espere um pouco.');
    id = await criar('planoaula', Object.assign({ 'Escola': req.escola, 'Professor': req.sessao.u, 'Estado': b.submeter ? 'submetido' : 'rascunho', 'Comentario': '' }, campos));
  }
  res.json({ ok: true, id, estado: campos['Estado'] || (b.submeter ? 'submetido' : 'rascunho') });
}));
app.post('/prof/plano-apagar', exigeProfessor, rota(async (req, res) => {
  const p = await daMinhaEscola('planoaula', String((req.body || {}).id || ''), req.escola);
  if (p['Professor'] !== req.sessao.u) return erro(res, 404, 'Plano não encontrado.');
  if (p['Estado'] === 'aprovado') return erro(res, 409, 'Um plano com o visto da Direcção não pode ser apagado.');
  await apagar('planoaula', p._id);
  res.json({ ok: true });
}));
// rascunho com IA (opcional): o professor revê e corrige tudo antes de guardar
const IA_PLANO = 'És um professor experiente em Moçambique e preparas planos de aula no modelo usado nas escolas moçambicanas (MINEDH).\n' +
  'Escreve em português de Moçambique (norma europeia: «actividade», «objectivo», «facto»).\n' +
  'Responde só com JSON neste formato:\n' +
  '{"objectivos":"…","competencias":"…","meios":"…","metodos":"…","bibliografia":"…","fases":[{"tempo":5,"conteudo":"…","professor":"…","aluno":"…","metodos":"…","meios":"…"}, …4 fases]}\n' +
  'As 4 fases são, por esta ordem: Introdução e Motivação; Mediação e Assimilação; Domínio e Consolidação; Controlo e Avaliação.\n' +
  'Regras:\n' +
  '- A soma dos tempos das 4 fases é igual à duração da aula.\n' +
  '- Objectivos específicos, mensuráveis, cada um numa linha começada por «- » e por um verbo no infinitivo (identificar, explicar, resolver…).\n' +
  '- Actividades do professor e do aluno concretas, em frases curtas, uma por linha começada por «- ».\n' +
  '- Usa meios simples que existem numa escola moçambicana (quadro, giz, livro do aluno, cartazes, objectos do dia-a-dia).\n' +
  '- Adequa ao nível da classe indicada e ao programa de ensino de Moçambique. Não inventes números de página nem títulos de livros: na bibliografia escreve só «Livro do aluno da X.ª classe» e «Programa de Ensino da disciplina».\n' +
  '- Não escrevas nomes de pessoas.';
app.post('/prof/plano-ia', exigeProfessor, rota(async (req, res) => {
  const b = req.body || {}, turma = String(b.turma || ''), disc = String(b.disciplina || '');
  if (!await podeLancar(req, turma, disc)) return erro(res, 403, 'Só pode fazer planos das disciplinas e turmas onde dá aulas.');
  const tema = txt(b.tema, 200); if (tema.length < 3) return erro(res, 400, 'Escreva primeiro o tema da aula.');
  if (travao('plano-ia|' + req.sessao.u, 10, 60)) return erro(res, 429, 'Muitos pedidos à IA seguidos. Espere um pouco.');
  const u = await iaReservar(req.escola);
  const [t, d] = await Promise.all([obter('turma', turma), obter('disciplina', disc)]);
  const dur = Math.max(10, Math.min(300, Math.round(Number(b.duracao) || 45)));
  const pedido = 'Disciplina: ' + (d['Nome'] || '') + '\nClasse: ' + (t['Classe'] || t['Nome'] || '') + ' (nível: ' + (t['Nivel'] || '') + ')\n' +
    (b.unidade ? 'Unidade temática: ' + txt(b.unidade, 200) + '\n' : '') + 'Tema da aula: ' + tema + '\n' + (b.tipo ? 'Tipo de aula: ' + txt(b.tipo, 80) + '\n' : '') + 'Duração: ' + dur + ' minutos';
  const r = await openaiJSON(IA_PLANO, pedido, 3500);
  const usados = await iaContar(req.escola, u);
  const dados = lerDadosPlano(Object.assign({}, r, { tema, unidade: b.unidade, tipo: b.tipo, duracao: dur }));
  res.json({ ok: true, dados, usados, limite: IA_LIMITE });
}));
// Direcção: ver, dar o visto ou devolver
app.post('/planos', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, f = daEscola(req.escola).concat(b.estado && ESTADOS_PLANO[b.estado] ? [{ key: 'Estado', constraint_type: 'equals', value: b.estado }] : []);
  const [N, ps] = await Promise.all([nomesPlanos(req.escola), procurarTodos('planoaula', f, 2000)]);
  const L = ps.filter(p => b.estado ? true : p['Estado'] !== 'rascunho').map(p => planoOut(p, Object.assign({ semDados: true }, N)))
    .sort((x, y) => (x.estado === 'submetido' ? 0 : 1) - (y.estado === 'submetido' ? 0 : 1) || String(y.submetido_em || y.data).localeCompare(String(x.submetido_em || x.data)));
  res.json({ ok: true, escola: N.escola, logotipo: N.logotipo, planos: L, por_ver: ps.filter(p => p['Estado'] === 'submetido').length });
}));
app.post('/plano', exigeDireccao, rota(async (req, res) => {
  const p = await daMinhaEscola('planoaula', String((req.body || {}).id || ''), req.escola);
  res.json({ ok: true, plano: planoOut(p, await nomesPlanos(req.escola)) });
}));
app.post('/plano-visto', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, decisao = b.decisao === 'aprovado' ? 'aprovado' : b.decisao === 'devolvido' ? 'devolvido' : '';
  if (!decisao) return erro(res, 400, 'Escolha: dar o visto ou devolver.');
  const p = await daMinhaEscola('planoaula', String(b.id || ''), req.escola);
  if (p['Estado'] === 'rascunho') return erro(res, 409, 'Este plano ainda é um rascunho do professor.');
  const comentario = txt(b.comentario, 800);
  if (decisao === 'devolvido' && comentario.length < 3) return erro(res, 400, 'Escreva ao professor o que deve corrigir.');
  const eu = await obter('user', req.sessao.u).catch(() => null);
  await mudar('planoaula', p._id, { 'Estado': decisao, 'Comentario': comentario, 'Visto Por': (eu && eu['Nome Completo']) || 'Direcção', 'Visto Em': new Date().toISOString() });
  res.json({ ok: true, estado: decisao });
}));

// ============================================================
//  COBRANÇAS POR SMS (v5.19)
//  Automático (se a escola ligar): aviso X dias antes de vencer e avisos depois do atraso
//  (no dia seguinte e depois de 7 em 7 dias, no máximo 3). Um SMS por destinatário, juntando os educandos.
//  Botão «Avisar devedores»: a Direcção manda quando quiser (uma vez por dia).
//  Bubble: Escola → Cobranca Auto (yes/no), Cobranca Dias (number)
//          Propina → Aviso Antes (date), Avisos Atraso (number), Ultimo Aviso (date)
// ============================================================
const COBRANCA_HORA = Math.max(6, Math.min(20, Number(process.env.COBRANCA_HORA || 9)));   // hora de Maputo a partir da qual saem os avisos
const COBRANCA_MAX = 3, COBRANCA_INTERVALO = 7;
const mtSMS = v => Number(v || 0).toLocaleString('pt-PT', { maximumFractionDigits: 2 }).replace(/\s/g, ' ') + ' MT';
const dataMZ = iso => new Date(new Date(iso).getTime() + 2 * 3600e3).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const listaNomes = l => l.length <= 1 ? (l[0] || '') : l.slice(0, -1).join(', ') + ' e ' + l[l.length - 1];
// junta as propinas por telefone de destino (encarregado que aceita SMS; senão o próprio estudante)
async function destinosCobranca(escolaId, propinas) {
  const f = daEscola(escolaId);
  const [ests, encs] = await Promise.all([procurarTodos('estudante', f), procurarTodos('encarregado', f)]);
  const EM = Object.fromEntries(ests.map(e => [e._id, e])), NM = Object.fromEntries(encs.map(e => [e._id, e]));
  const grupos = {};
  for (const x of propinas) {
    const e = EM[x.p['Estudante']]; if (!e || (e['Estado'] || 'activo') !== 'activo') continue;
    const en = NM[e['Encarregado']];
    let tel = en && en['Activo'] !== false && en['Recebe SMS'] !== false ? tel9(en['Telefone']) : '';
    if (tel.length !== 9) tel = tel9(e['Telefone']);
    if (tel.length !== 9) continue;
    (grupos[tel] = grupos[tel] || { tel, itens: [] }).itens.push(Object.assign({ nome: String(e['Nome'] || '').split(/\s+/)[0] }, x));
  }
  return Object.values(grupos);
}
function smsAntes(esc, g) {
  const nomes = [...new Set(g.itens.map(i => i.nome))], total = g.itens.reduce((s, i) => s + i.c.total, 0), venc = g.itens.map(i => i.venc).sort()[0];
  const tipo = g.itens.every(i => (i.p['Tipo'] || 'propina') === 'prestacao') ? 'a prestacao' : (g.itens.length > 1 ? 'as propinas' : 'a propina');
  const mes = g.itens.length === 1 && g.itens[0].p['Mes'] ? ' de ' + MESES_NOME[g.itens[0].p['Mes']] : '';
  return (esc['Nome'] || 'A escola') + ': lembrete - ' + tipo + mes + ' de ' + listaNomes(nomes) + ' (' + mtSMS(total) + ') vence' + (g.itens.length > 1 ? 'm' : '') + ' a ' + dmCurto(venc) +
    '. Pague ' + noGescolar(esc['Subdominio']) + ' por M-Pesa ou e-Mola, ou na secretaria.';
}
function smsAtraso(esc, g) {
  const nomes = [...new Set(g.itens.map(i => i.nome))], total = g.itens.reduce((s, i) => s + i.c.total, 0), multa = g.itens.reduce((s, i) => s + i.c.multa, 0);
  return (esc['Nome'] || 'A escola') + ': ' + listaNomes(nomes) + ' tem ' + (g.itens.length > 1 ? g.itens.length + ' pagamentos' : 'um pagamento') + ' em atraso: ' + mtSMS(total) + (multa ? ' (inclui multa)' : '') +
    '. Pague ' + noGescolar(esc['Subdominio']) + ' por M-Pesa ou e-Mola, ou na secretaria. Se ja pagou, ignore esta mensagem.';
}
async function propinasEmAberto(escolaId) {
  const esc = await obter('escola', escolaId);
  const regras = (await resumoEscola(escolaId) || {}).regras || {};
  const ps = (await procurarTodos('propina', daEscola(escolaId), 20000)).filter(p => p['Estado'] !== 'paga' && p['Estado'] !== 'anulada' && p['Vencimento']);
  return { esc, lista: ps.map(p => ({ p, c: calcPropina(p, regras), venc: dataMZ(p['Vencimento']) })) };
}
let cobrancasDia = '', cobrancasAgora = false;
async function cobrancasAutomaticas() {
  if (cobrancasAgora || !BUBBLE_BASE || !BUBBLE_TOKEN || !SMS_TOKEN) return;
  const agora = new Date(Date.now() + 2 * 3600e3), hoje = agora.toISOString().slice(0, 10);
  if (agora.getUTCHours() < COBRANCA_HORA || cobrancasDia === hoje) return;
  cobrancasAgora = true;
  try {
    const escolas = (await procurarTodos('escola', [{ key: 'Cobranca Auto', constraint_type: 'equals', value: true }], 2000)).filter(e => e['Estado'] !== 'suspensa');
    let n = 0;
    for (const e of escolas) {
      try {
        const dias = Math.max(1, Math.min(15, Number(e['Cobranca Dias'] || 3)));
        const { esc, lista } = await propinasEmAberto(e._id);
        const antes = lista.filter(x => x.c.estado === 'aberta' && !x.p['Aviso Antes'] && diasEntre(hoje, x.venc) >= 0 && diasEntre(hoje, x.venc) <= dias);
        const atraso = lista.filter(x => x.c.estado === 'atrasada' && Number(x.p['Avisos Atraso'] || 0) < COBRANCA_MAX && diasEntre(x.venc, hoje) >= 1 &&
          (!x.p['Ultimo Aviso'] || diasEntre(dataMZ(x.p['Ultimo Aviso']), hoje) >= COBRANCA_INTERVALO));
        for (const g of await destinosCobranca(e._id, antes)) {
          if ((await enviarSMS([g.tel], smsAntes(esc, g))).ok) n++;
          for (const i of g.itens) await mudar('propina', i.p._id, { 'Aviso Antes': new Date().toISOString() }).catch(() => {});
        }
        for (const g of await destinosCobranca(e._id, atraso)) {
          if ((await enviarSMS([g.tel], smsAtraso(esc, g))).ok) n++;
          for (const i of g.itens) await mudar('propina', i.p._id, { 'Avisos Atraso': Number(i.p['Avisos Atraso'] || 0) + 1, 'Ultimo Aviso': new Date().toISOString() }).catch(() => {});
        }
      } catch (err) { console.error('[cobrancas] escola ' + e._id + ':', err.message); }
    }
    cobrancasDia = hoje;
    console.log('[cobrancas] ' + hoje + ': ' + n + ' SMS em ' + escolas.length + ' escola(s)');
  } catch (err) { console.error('[cobrancas]', err.message); }
  finally { cobrancasAgora = false; }
}
setInterval(() => { cobrancasAutomaticas(); }, 15 * 60e3);
setTimeout(() => { cobrancasAutomaticas(); }, 90e3);

// estado e definições (página Propinas da Direcção)
app.post('/cobranca', exigeDireccao, rota(async (req, res) => {
  const { esc, lista } = await propinasEmAberto(req.escola);
  const atraso = lista.filter(x => x.c.estado === 'atrasada'), g = await destinosCobranca(req.escola, atraso);
  res.json({ ok: true, auto: esc['Cobranca Auto'] === true, dias: Number(esc['Cobranca Dias'] || 3), hora: COBRANCA_HORA, sms: !!(SMS_TOKEN && SMS_ORIGEM),
    devedores: g.length, valor: atraso.reduce((s, x) => s + x.c.total, 0), sem_telefone: new Set(atraso.map(x => x.p['Estudante'])).size - new Set([].concat(...g.map(z => z.itens.map(i => i.p['Estudante'])))).size,
    exemplo: g[0] ? smsAtraso(esc, g[0]) : '' });
}));
app.post('/cobranca-guardar', exigeDireccao, rota(async (req, res) => {
  const b = req.body || {}, dias = Math.max(1, Math.min(15, Math.round(Number(b.dias) || 3)));
  await mudar('escola', req.escola, { 'Cobranca Auto': b.auto === true, 'Cobranca Dias': dias });
  res.json({ ok: true, auto: b.auto === true, dias });
}));
app.post('/avisar-devedores', exigeDireccao, rota(async (req, res) => {
  if (!SMS_TOKEN || !SMS_ORIGEM) return erro(res, 500, 'O SMS ainda não está configurado no servidor.');
  if (travao('devedores|' + req.escola, 1, 20 * 60)) return erro(res, 429, 'Os devedores já foram avisados hoje. Pode voltar a avisar amanhã.');
  const { esc, lista } = await propinasEmAberto(req.escola);
  const atraso = lista.filter(x => x.c.estado === 'atrasada');
  const grupos = await destinosCobranca(req.escola, atraso);
  if (!grupos.length) return res.json({ ok: true, enviados: 0, destinatarios: 0 });
  let enviados = 0;
  for (const g of grupos) {
    if ((await enviarSMS([g.tel], smsAtraso(esc, g))).ok) enviados++;
    for (const i of g.itens) await mudar('propina', i.p._id, { 'Ultimo Aviso': new Date().toISOString() }).catch(() => {});
  }
  res.json({ ok: true, enviados, destinatarios: grupos.length });
}));

app.use((req, res) => erro(res, 404, 'Rota não encontrada.'));
app.listen(PORT, () => console.log(VERSAO + ' a ouvir na porta ' + PORT));
