'use strict';

/*
 * Regra central: este arquivo não calcula nenhum valor financeiro.
 * Tudo o que aparece nas telas é o texto que a planilha exibe, lido na hora.
 * Dados financeiros ficam só na memória e somem quando o app fecha.
 */

const config = window.APP_CONFIG || {};
const CHAVE_SESSAO = 'gastos.sessao';
const VALIDADE_LEITURA_MS = 15000;
const TEMPO_LIMITE_MS = 45000;
const TITULOS = { novo: 'Novo gasto', resumo: 'Resumo do mês', limites: 'Limite dos cartões' };

const $ = (id) => document.getElementById(id);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const estado = {
  sessao: lerSessao(),
  email: '',
  tela: 'novo',
  dados: null,
  lidoEmMs: 0,
  erroCarga: '',
  carregando: false,
  seqCarga: 0,
  centavos: 0,
  forma: '',
  quem: '',
  pendente: null,
  salvando: false,
};

/* ---------- Utilidades ---------- */

function lerSessao() {
  try { return localStorage.getItem(CHAVE_SESSAO) || ''; } catch (e) { return ''; }
}

function gravarSessao(valor) {
  estado.sessao = valor;
  try {
    if (valor) localStorage.setItem(CHAVE_SESSAO, valor);
    else localStorage.removeItem(CHAVE_SESSAO);
  } catch (e) { /* segue só na memória */ }
}

function el(tag, props, ...filhos) {
  const n = document.createElement(tag);
  Object.entries(props || {}).forEach(([k, v]) => {
    if (k === 'class') n.className = v;
    else if (k === 'on') Object.entries(v).forEach(([ev, fn]) => n.addEventListener(ev, fn));
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  });
  filhos.flat().forEach((f) => { if (f !== null && f !== undefined) n.append(f); });
  return n;
}

function hojeLocal() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function novoId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function api(corpo) {
  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), TEMPO_LIMITE_MS);
  try {
    // text/plain evita a checagem CORS que o Apps Script não atende.
    const r = await fetch(config.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(corpo),
      redirect: 'follow',
      cache: 'no-store',
      credentials: 'omit',
      signal: controle.signal,
    });
    if (!r.ok) throw new Error('rede');
    const dados = await r.json();
    if (dados.codigo === 'SESSAO') {
      sairDaSessao('Sua sessão terminou. Entre novamente.');
    }
    return dados;
  } finally {
    clearTimeout(limite);
  }
}

/* ---------- Login ---------- */

function mostrarEntrada(mensagem) {
  $('app').hidden = true;
  $('tela-entrada').hidden = false;
  const erro = $('erro-login');
  erro.hidden = !mensagem;
  erro.textContent = mensagem || '';
  iniciarGoogle();
}

let googlePronto = false;
function iniciarGoogle(tentativa = 0) {
  if (googlePronto) return;
  if (!window.google || !google.accounts || !google.accounts.id) {
    if (tentativa > 50) {
      mostrarErroLogin('Não consegui abrir o login do Google. Verifique a internet.');
      return;
    }
    setTimeout(() => iniciarGoogle(tentativa + 1), 200);
    return;
  }
  google.accounts.id.initialize({
    client_id: config.CLIENT_ID,
    callback: aoEntrarNoGoogle,
    auto_select: false,
    cancel_on_tap_outside: false,
    use_fedcm_for_button: true,
  });
  google.accounts.id.renderButton($('botao-google'), {
    theme: 'filled_blue',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    locale: 'pt-BR',
    width: 280,
  });
  googlePronto = true;
}

function mostrarErroLogin(texto) {
  const erro = $('erro-login');
  erro.textContent = texto;
  erro.hidden = false;
}

async function aoEntrarNoGoogle(resposta) {
  mostrarErroLogin('Entrando…');
  try {
    const r = await api({ acao: 'login', idToken: resposta.credential });
    if (!r.ok) {
      mostrarErroLogin(r.mensagem || 'Não foi possível entrar.');
      return;
    }
    gravarSessao(r.sessao);
    estado.email = r.email;
    $('erro-login').hidden = true;
    abrirApp();
  } catch (e) {
    mostrarErroLogin('Sem conexão com o servidor. Tente de novo.');
  }
}

function sairDaSessao(mensagem) {
  gravarSessao('');
  estado.dados = null;
  estado.lidoEmMs = 0;
  estado.email = '';
  estado.pendente = null;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
  mostrarEntrada(mensagem);
}

/* ---------- Navegação e carga ---------- */

function abrirApp() {
  $('tela-entrada').hidden = true;
  $('app').hidden = false;
  $('data').value = hojeLocal();
  irPara('novo');
  carregar(true);
}

function irPara(tela) {
  estado.tela = tela;
  $('titulo').textContent = TITULOS[tela];
  ['novo', 'resumo', 'limites'].forEach((t) => { $(`v-${t}`).hidden = t !== tela; });
  document.querySelectorAll('.navegacao button').forEach((b) => {
    if (b.dataset.tela === tela) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  if (tela !== 'novo') {
    if (Date.now() - estado.lidoEmMs > VALIDADE_LEITURA_MS) carregar(true);
    else renderizarLeituras();
  }
}

async function carregar(limpar) {
  if (!estado.sessao) return;
  const seq = ++estado.seqCarga;
  estado.carregando = true;
  estado.erroCarga = '';
  if (limpar) {
    // Nunca deixa um número antigo na tela enquanto busca o novo.
    estado.lidoEmMs = 0;
    if (estado.dados) { estado.dados.resumo = null; estado.dados.limites = null; }
  }
  renderizarLeituras();
  try {
    const r = await api({ acao: 'carregar', sessao: estado.sessao });
    if (seq !== estado.seqCarga || !estado.sessao) return;
    if (!r.ok) {
      estado.erroCarga = r.mensagem || 'Não foi possível ler a planilha.';
      estado.dados = estado.dados ? { ...estado.dados, resumo: null, limites: null } : null;
    } else {
      estado.dados = r;
      estado.email = r.email;
      estado.lidoEmMs = Date.now();
      $('btn-conta').textContent = (r.email[0] || '?').toUpperCase();
      renderizarFormulario();
    }
  } catch (e) {
    if (seq !== estado.seqCarga) return;
    estado.erroCarga = 'Sem conexão. Os valores não foram exibidos para não mostrar nada desatualizado.';
    estado.lidoEmMs = 0;
    if (estado.dados) estado.dados = { ...estado.dados, resumo: null, limites: null };
  } finally {
    if (seq === estado.seqCarga) {
      estado.carregando = false;
      renderizarLeituras();
      atualizarBotaoSalvar();
    }
  }
}

/* ---------- Formulário ---------- */

function renderizarFormulario() {
  const secao = estado.dados && estado.dados.listas;
  if (!secao || !secao.ok) {
    if (secao) mostrarErroForm(secao.mensagem);
    return;
  }
  const { formas, pessoas, categorias } = secao.dados;

  if (!formas.some((f) => f.nome === estado.forma)) estado.forma = '';
  if (!pessoas.includes(estado.quem)) {
    estado.quem = pessoas.includes('Casal') ? 'Casal' : pessoas[0];
  }

  $('formas').replaceChildren(...formas.map((f) => el('button', {
    type: 'button',
    textContent: f.nome,
    'aria-pressed': String(f.nome === estado.forma),
    on: { click: () => { estado.forma = f.nome; limparErroForm(); renderizarFormulario(); } },
  })));

  $('pessoas').replaceChildren(...pessoas.map((p) => el('button', {
    type: 'button',
    textContent: p,
    'aria-pressed': String(p === estado.quem),
    on: { click: () => { estado.quem = p; renderizarFormulario(); } },
  })));

  const sel = $('categoria');
  const atual = sel.value;
  sel.replaceChildren(
    el('option', { value: '', textContent: 'Automática' }),
    ...categorias.map((c) => el('option', { value: c.nome, textContent: c.nome })),
  );
  sel.value = categorias.some((c) => c.nome === atual) ? atual : '';

  atualizarAvisos();
}

function atualizarAvisos() {
  const l = estado.dados && estado.dados.listas && estado.dados.listas.dados;
  if (!l) return;
  const forma = l.formas.find((f) => f.nome === estado.forma);
  const cat = l.categorias.find((c) => c.nome === $('categoria').value);
  $('aviso-credito').hidden = !(forma && forma.credito);
  $('aviso-investimento').hidden = !(cat && cat.investimento);
}

function atualizarBotaoSalvar() {
  const listasOk = !!(estado.dados && estado.dados.listas && estado.dados.listas.ok);
  const b = $('btn-salvar');
  b.disabled = estado.salvando || !listasOk;
  if (estado.salvando) b.textContent = 'Gravando e conferindo…';
  else if (estado.pendente) b.textContent = 'Tentar de novo';
  else if (!listasOk && estado.carregando) b.textContent = 'Lendo a planilha…';
  else if (!listasOk) b.textContent = 'Planilha indisponível';
  else b.textContent = 'Salvar gasto';
  $('campos').disabled = estado.salvando || !!estado.pendente;
  $('pendente').hidden = !estado.pendente || estado.salvando || $('dlg-confirma').open;
}

function mostrarErroForm(texto) {
  const e = $('erro-form');
  e.textContent = texto;
  e.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function limparErroForm() { $('erro-form').hidden = true; }

function montarGasto() {
  if (estado.centavos <= 0) return { erro: 'Digite o valor do gasto.', foco: 'valor' };
  const descricao = $('descricao').value.trim();
  if (!descricao) return { erro: 'Escreva uma descrição.', foco: 'descricao' };
  if (!estado.forma) return { erro: 'Escolha a forma de pagamento.' };
  if (!$('data').value) return { erro: 'Escolha a data.', foco: 'data' };
  return {
    gasto: {
      data: $('data').value,
      descricao,
      centavos: estado.centavos,
      quem: estado.quem,
      forma: estado.forma,
      categoria: $('categoria').value,
    },
  };
}

async function aoSalvar(ev) {
  ev.preventDefault();
  if (estado.salvando) return;
  limparErroForm();

  if (!estado.pendente) {
    const m = montarGasto();
    if (m.erro) {
      mostrarErroForm(m.erro);
      if (m.foco) $(m.foco).focus();
      return;
    }
    estado.pendente = { idPedido: novoId(), gasto: m.gasto, confirmacoes: [] };
  }
  await enviarPendente();
}

async function enviarPendente() {
  estado.salvando = true;
  atualizarBotaoSalvar();
  let r;
  try {
    r = await api({ acao: 'salvar', sessao: estado.sessao, ...estado.pendente });
  } catch (e) {
    // Resultado desconhecido: mantém o mesmo id para a repetição não duplicar.
    estado.salvando = false;
    atualizarBotaoSalvar();
    return;
  }
  estado.salvando = false;

  if (r.ok) {
    estado.pendente = null;
    atualizarBotaoSalvar();
    mostrarRecibo(r);
    limparFormulario();
    estado.lidoEmMs = 0;
    carregar(true);
    return;
  }

  if (r.codigo === 'CONFIRMAR') {
    pedirConfirmacao(r);
    atualizarBotaoSalvar();
    return;
  }

  // O servidor respondeu com recusa: nada ficou gravado.
  estado.pendente = null;
  atualizarBotaoSalvar();
  if (r.codigo !== 'SESSAO') mostrarErroForm(r.mensagem || 'Não foi possível gravar.');
}

function pedirConfirmacao(r) {
  $('confirma-texto').textContent = r.mensagem;
  estado.confirmacaoAtual = r.confirmacao;
  $('dlg-confirma').showModal();
}

function mostrarRecibo(r) {
  $('recibo-valor').textContent = r.valor;
  const linha = (rotulo, valor) => el('div', null, el('dt', { textContent: rotulo }), el('dd', { textContent: valor }));
  $('recibo-dados').replaceChildren(
    linha('Conta em', r.mes),
    linha('Categoria', r.categoria),
    ...r.partes.map((p) => linha(`Parte ${p.nome}`, p.valor)),
    linha('Linha da planilha', String(r.linha)),
  );
  $('dlg-recibo').showModal();
}

function limparFormulario() {
  estado.centavos = 0;
  estado.forma = '';
  $('valor').value = brl.format(0);
  $('descricao').value = '';
  $('categoria').value = '';
  $('data').value = hojeLocal();
  renderizarFormulario();
}

/* ---------- Resumo e cartões ---------- */

const classeSinal = (t) => (String(t).trim().startsWith('-') ? 'neg' : 'pos');

function rodapeLeitura() {
  const hora = estado.dados && estado.dados.lidoEm
    ? new Date(estado.dados.lidoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : '';
  return el('div', { class: 'lido' },
    el('span', { textContent: hora ? `Lido da planilha às ${hora}` : '' }),
    el('button', { type: 'button', textContent: 'Atualizar', on: { click: () => carregar(true) } }));
}

function blocoErro(texto) {
  return [
    el('p', { class: 'erro', role: 'alert', textContent: texto }),
    el('div', { class: 'lido' },
      el('span'),
      el('button', { type: 'button', textContent: 'Tentar de novo', on: { click: () => carregar(true) } })),
  ];
}

const esqueleto = () => [el('div', { class: 'carregando' }), el('div', { class: 'carregando' })];

function renderizarLeituras() {
  atualizarBotaoSalvar();
  renderizarSecao($('v-resumo'), 'resumo', desenharResumo);
  renderizarSecao($('v-limites'), 'limites', desenharLimites);
}

function renderizarSecao(alvo, chave, desenhar) {
  if (estado.carregando) { alvo.replaceChildren(...esqueleto()); return; }
  if (estado.erroCarga) { alvo.replaceChildren(...blocoErro(estado.erroCarga)); return; }
  const secao = estado.dados && estado.dados[chave];
  if (!secao) { alvo.replaceChildren(...esqueleto()); return; }
  if (!secao.ok) { alvo.replaceChildren(...blocoErro(secao.mensagem)); return; }
  alvo.replaceChildren(...desenhar(secao.dados), rodapeLeitura());
}

function desenharResumo(d) {
  const periodo = d.periodo.replace(/^\S+\s/, '');
  const mes = d.seletor && !d.seletor.includes('Mês atual')
    ? `Mês escolhido na planilha: ${d.seletor} · ${periodo}`
    : `${periodo}${d.situacao ? ` · ${d.situacao}` : ''}`;

  const principal = el('div', { class: 'cartao' },
    el('div', { class: 'saldo-rotulo', textContent: 'Saldo do casal' }),
    el('div', { class: `saldo-valor ${classeSinal(d.casal.saldo)}`, textContent: d.casal.saldo }),
    el('div', { class: 'par' },
      el('div', null, el('span', { textContent: 'Entradas' }), el('strong', { textContent: d.casal.entradas })),
      el('div', null, el('span', { textContent: 'Saídas' }), el('strong', { textContent: d.casal.saidas }))),
    d.mensagem ? el('p', { class: 'mensagem', textContent: d.mensagem }) : null);

  const pessoas = d.pessoas.map((p) => el('div', { class: 'cartao' },
    el('div', { class: 'pessoa-nome' },
      el('span', { textContent: p.nome }),
      el('b', { class: classeSinal(p.saldo), textContent: p.saldo })),
    el('div', { class: 'par' },
      el('div', null, el('span', { textContent: 'Entradas' }), el('strong', { textContent: p.entradas })),
      el('div', null, el('span', { textContent: 'Saídas' }), el('strong', { textContent: p.saidas })))));

  return [el('p', { class: 'mes', textContent: mes }), principal, ...pessoas];
}

function desenharLimites(d) {
  const cartoes = d.cartoes.map((c) => {
    const m = /(\d+)\s*%/.exec(c.uso);
    const pct = m ? Math.min(100, Number(m[1])) : 0;
    const cor = c.uso.includes('🔴') ? 'vermelho' : c.uso.includes('🟡') ? 'amarelo' : '';
    return el('article', { class: 'cartao' },
      el('div', { class: 'cartao-topo' },
        el('h2', { textContent: c.nome.replace(/^Crédito\s+/, '') }),
        el('span', { class: 'cartao-uso', textContent: c.uso })),
      el('div', { class: 'barra', role: 'img', 'aria-label': `Uso do limite: ${pct}%` },
        el('i', { class: cor, style: `width:${pct}%` })),
      el('div', { class: 'par' },
        el('div', null, el('span', { textContent: 'Usado' }), el('strong', { textContent: c.usado })),
        el('div', null, el('span', { textContent: 'Disponível' }), el('strong', { textContent: c.disponivel }))),
      el('div', { class: 'fatura' },
        el('span', { textContent: c.vence ? `Próxima fatura · vence ${c.vence}` : 'Próxima fatura' }),
        el('b', { textContent: c.proximaFatura })));
  });
  return [
    d.total ? el('p', { class: 'total-cartoes', textContent: d.total.replace(/^💳\s*/, '') }) : null,
    ...cartoes,
  ].filter(Boolean);
}

/* ---------- Eventos ---------- */

$('valor').addEventListener('input', (e) => {
  const digitos = e.target.value.replace(/\D/g, '').slice(0, 8);
  estado.centavos = Number(digitos || 0);
  e.target.value = brl.format(estado.centavos / 100);
  limparErroForm();
});
$('valor').addEventListener('focus', (e) => {
  const fim = e.target.value.length;
  requestAnimationFrame(() => e.target.setSelectionRange(fim, fim));
});

$('categoria').addEventListener('change', atualizarAvisos);
$('form').addEventListener('submit', aoSalvar);

document.querySelectorAll('.navegacao button').forEach((b) => {
  b.addEventListener('click', () => irPara(b.dataset.tela));
});

$('btn-descartar').addEventListener('click', () => {
  estado.pendente = null;
  atualizarBotaoSalvar();
  mostrarErroForm('Confira na planilha se o gasto entrou antes de lançar de novo.');
});

$('btn-outro').addEventListener('click', () => {
  $('dlg-recibo').close();
  $('valor').focus();
});

$('btn-confirma-sim').addEventListener('click', () => {
  $('dlg-confirma').close();
  estado.pendente.confirmacoes.push(estado.confirmacaoAtual);
  enviarPendente();
});
$('btn-confirma-nao').addEventListener('click', () => {
  $('dlg-confirma').close();
  estado.pendente = null;
  atualizarBotaoSalvar();
});
$('dlg-confirma').addEventListener('cancel', (e) => e.preventDefault());

$('btn-conta').addEventListener('click', () => {
  $('conta-email').textContent = estado.email;
  $('dlg-conta').showModal();
});
$('btn-conta-fechar').addEventListener('click', () => $('dlg-conta').close());
$('btn-sair').addEventListener('click', () => sairDaSessao());

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && estado.sessao && !$('app').hidden) {
    if (Date.now() - estado.lidoEmMs > VALIDADE_LEITURA_MS) carregar(true);
    const hoje = hojeLocal();
    if (!estado.pendente && !$('descricao').value && estado.centavos === 0) $('data').value = hoje;
  }
});

/* ---------- Início ---------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

if (!config.CLIENT_ID || !config.API_URL) {
  $('tela-entrada').hidden = false;
  mostrarErroLogin('App ainda não configurado. Siga o guia de instalação.');
} else if (estado.sessao) {
  abrirApp();
} else {
  mostrarEntrada();
}
