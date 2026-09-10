/**
 * airportlink-drivers/server.js
 * ---------------------------------------------------------------
 * Serviço próprio do portal de motoristas: serve o index.html e a
 * API dos parceiros na mesma origem.
 *
 * Estar na mesma origem que a página tem duas consequências boas: o
 * CORS deixa de existir para este fluxo, e a sessão do Supabase fica
 * isolada da do site principal — um parceiro autenticado aqui não
 * interfere com uma sessão de cliente ou de administrador.
 * ---------------------------------------------------------------
 */

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { createShared } from './support-shared.js';

/**
 * Os avisos do Telegram.
 *
 * Vivem na API principal, mas o ficheiro é partilhado — as
 * variáveis de ambiente são as mesmas nos dois serviços.
 */
import {
  telegramNewChat,
  telegramNewAccount,
  telegramNewAgency,
  telegramNewPartner
} from './telegram.js';
import { createPartnerRoutes } from './partners.js';
import { createSupportRoutes } from './support.js';
// Os emails são pedidos à API principal, onde o emailService vive.
// Este serviço não tem cópia nenhuma dele nem chaves do Resend.
import {
  sendPartnerApplicationReceived,
  sendPartnerDecision,
  sendRideConfirmedToPartner,
  sendVerification,
  sendSupportEscalation,
  // A oferta de viagem com prazo. É o email que faz a atribuição
  // automática funcionar: sem ele o parceiro não sabe que tem uma
  // viagem à espera.
  sendRideOffer,
  sendRideOfferReminder
} from './emailclient.js';

const app = express();

/**
 * O IP verdadeiro, atrás do proxy.
 *
 * O Render põe o endereço do visitante no x-forwarded-for e o seu
 * próprio no req.ip. Sem esta linha, o limitador via todos os
 * pedidos como vindos do mesmo sítio — e bloqueava toda a gente
 * ao mesmo tempo, ou ninguém.
 *
 * O 1 diz "confia num proxy". Confiar em todos deixaria alguém
 * forjar o cabeçalho e contornar o limite.
 */
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');

/**
 * A chave certa, ou não arranca.
 *
 * Com a chave publicável aqui, o serviço sobe e parece funcionar —
 * mas o registo falha com "requires a valid Bearer token", o upload
 * de documentos com "permission denied", e o chat não abre. Três
 * sintomas diferentes da mesma causa, e horas a persegui-los.
 *
 * Falhar no arranque com uma mensagem clara custa um deploy. Não
 * falhar custou uma tarde.
 */
if (process.env.SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_publishable_')) {
  throw new Error(
    '\n\n  SUPABASE_SERVICE_ROLE_KEY contains the PUBLISHABLE key.\n\n' +
    '  Sign-ups, document uploads and chat will all fail with different\n' +
    '  error messages that do not name the real cause.\n\n' +
    '  Fix: Supabase > Settings > API Keys > copy the SECRET key\n' +
    '  (it starts with sb_secret_) into this variable on Render.\n'
  );
}

// service_role ignora a RLS. É por isso que este ficheiro nunca pode
// ser servido ao browser, e por isso que todas as rotas verificam
// quem está a pedir antes de escreverem seja o que for.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

/**
 * Confirma no arranque que a chave é mesmo de administração.
 *
 * O formato antigo das chaves é um JWT, e nesse caso o prefixo acima
 * não apanha nada. Uma chamada de administração responde de imediato
 * se a chave não serve.
 */
(async function checkKey() {
  try {
    const { error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });

    if (error) {
      console.error(
        '\n  SUPABASE_SERVICE_ROLE_KEY is not an admin key: ' + error.message +
        '\n  Sign-ups and uploads will fail. Copy the SECRET key from Supabase.\n'
      );
      return;
    }

    console.log('Supabase admin key ok');
  } catch (error) {
    console.error('Supabase key check failed:', error.message);
  }
})();

/**
 * Identidade a partir do JWT enviado pelo browser. O token é
 * validado no servidor do Supabase — não confiamos no que o cliente
 * diz que é.
 */
async function getUserFromRequest(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  return data.user;
}

/**
 * Devolve { user } ou { error }. A distinção importa: "não estás
 * autenticado" e "esta conta não é administrador" pedem ações
 * diferentes de quem está do outro lado.
 */
async function requireAdmin(req) {
  const user = await getUserFromRequest(req);

  if (!user) {
    return { error: 'Not signed in. Your session may have expired.' };
  }

  const { data, error } = await supabase
    .from('contacts')
    .select('id, email, is_admin, role')
    .eq('id', user.id)
    .maybeSingle();

  if (error) return { error: 'Could not verify your account.' };

  if (!data || data.is_admin !== true) {
    return {
      error: `You are signed in as ${user.email}, which is not an administrator account.`
    };
  }

  /**
   * O cargo viaja com o utilizador.
   *
   * Dois níveis: agent vê o apoio, supervisor vê tudo. O is_admin
   * continua a ser a porta de entrada; o cargo decide o que se vê
   * lá dentro.
   */
  user.role = data.role || 'agent';
  user.isSupervisor = user.role === 'supervisor';

  return { user };
}

/**
 * Só supervisores.
 *
 * A verificação está aqui e não no painel: esconder um separador
 * no browser não protege nada, porque quem quiser chama a rota
 * diretamente.
 */
async function requireSupervisor(req) {
  const { user, error } = await requireAdmin(req);

  if (error) return { error };

  if (!user.isSupervisor) {
    return { error: 'This area is for supervisors only.' };
  }

  return { user };
}

// O painel principal continua noutro domínio e pode precisar de
// chamar estas rotas — por exemplo para aprovar candidaturas.
const ALLOWED_ORIGINS = [
  'https://drivers.airportlink.app',
  'https://www.airportlink.app',
  'https://airportlink.app',
  // O call centre. Vive noutra origem e chama as rotas de admin
  // daqui — sem esta linha, o browser recusa cada pedido antes
  // sequer de o enviar.
  'https://support.airportlink.app',
  /\.filesusr\.com$/,
  /\.wixsite\.com$/,
  // O domínio provisório do Render, até o domínio próprio estar
  // apontado. Uma vez lá, esta linha pode sair.
  /^callcentre[a-z0-9-]*\.onrender\.com$/
];

function originAllowed(origin) {
  if (!origin) return true;

  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }

  return ALLOWED_ORIGINS.some((rule) =>
    rule instanceof RegExp ? rule.test(host) : rule === origin
  );
}

app.use(cors({
  origin(origin, callback) {
    if (originAllowed(origin)) return callback(null, true);

    // A mensagem diz o que fazer, não só o que falhou. Um "CORS
    // blocked" sozinho manda quem lê à procura no sítio errado —
    // e a origem bloqueada aparece só no browser, não aqui.
    console.warn(
      'CORS blocked: ' + origin + '\n' +
      '  If this is a service of ours, add it to ALLOWED_ORIGINS in server.js.'
    );

    return callback(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  // O x-cron-secret NÃO entra aqui de propósito. É um segredo de
  // servidor para servidor: se o browser o pudesse enviar, qualquer
  // página conseguiria disparar as tarefas internas. O cron-job.org
  // não passa por CORS, por isso não precisa desta lista.
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '1mb' }));

if (!process.env.CRON_SECRET) {
  console.warn(
    'CRON_SECRET is not set. The portal works, but no partner emails will be sent — ' +
    'they go through the main API and that is the shared secret. The support tick ' +
    'will also refuse to run.'
  );
}

/**
 * Os erros vão para o canal de alarmes.
 *
 * Este serviço não tem Telegram — e não deve ter: duas cópias das
 * credenciais é um sítio a mais onde podem vazar. Manda o alarme
 * para a API principal, que trata do resto.
 *
 * Sem isto, um erro no portal de motoristas ou no call centre só
 * aparecia na consola do Render, onde ninguém olha.
 */
/**
 * ---------------------------------------------------------------
 * OS CABEÇALHOS DE SEGURANÇA
 *
 * Escritos à mão em vez do helmet: seis linhas contra uma
 * dependência de 90 KB, e cada uma explicada.
 * ---------------------------------------------------------------
 */
app.use((req, res, next) => {
  // Só HTTPS, e o browser lembra-se por um ano.
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // O browser não adivinha o tipo do ficheiro: um upload com HTML
  // dentro não é servido como página.
  res.set('X-Content-Type-Options', 'nosniff');

  // Ninguém nos põe num iframe para sobrepor botões invisíveis.
  res.set('X-Frame-Options', 'DENY');

  // O endereço não viaja para sites externos.
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Nada de câmara, microfone ou localização — não usamos nenhum.
  res.set('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(self)');

  next();
});


/**
 * ---------------------------------------------------------------
 * UM LIMITE POR ENDEREÇO
 *
 * Duas rotas aqui são públicas: o registo de parceiro e a pesquisa
 * de aeroportos. A segunda é chamada a cada tecla escrita, e sem
 * limite um script enche a base de linhas ou gasta a ligação.
 *
 * Um Map em memória, sem dependências. Não é proteção contra um
 * ataque a sério — é contra o caso comum: um script, um bot, um
 * botão carregado vinte vezes.
 * ---------------------------------------------------------------
 */
const janelas = new Map();

function limitar(nome, req, res, { max, segundos }) {
  // O IP real, atrás do proxy do Render.
  const ip = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0].trim() || req.ip || 'sem-ip';

  const chave = `${nome}:${ip}`;
  const agora = Date.now();

  let j = janelas.get(chave);

  if (!j || agora > j.ate) {
    j = { contagem: 0, ate: agora + segundos * 1000 };
    janelas.set(chave, j);
  }

  j.contagem += 1;

  if (j.contagem > max) {
    const faltam = Math.ceil((j.ate - agora) / 1000);

    res.set('Retry-After', String(faltam));

    res.status(429).json({
      error: 'Too many requests. Wait a moment and try again.',
      retry_after_seconds: faltam
    });

    return true;
  }

  return false;
}

// A memória não cresce sem fim.
setInterval(() => {
  const agora = Date.now();
  for (const [k, j] of janelas) if (agora > j.ate) janelas.delete(k);
}, 60000).unref();


/**
 * As duas rotas públicas.
 *
 * Feito aqui e não em cada uma: elas vivem no partners.js, que é
 * montado como router — e um middleware antes dele apanha as duas
 * sem lhes tocar.
 */
app.use((req, res, next) => {
  if (req.path === '/api/partner/signup') {
    /**
     * Três registos por hora.
     *
     * Ninguém se regista três vezes numa hora sem ser por engano.
     * Cada tentativa cria uma linha e manda um email.
     */
    if (limitar('signup', req, res, { max: 3, segundos: 3600 })) return;
  }

  if (req.path === '/api/partner/airports') {
    /**
     * Sessenta pesquisas por minuto.
     *
     * É chamada a cada tecla, com um quarto de segundo de espera
     * entre elas. Sessenta dá para escrever à vontade e para
     * mudar de ideias.
     */
    if (limitar('airports', req, res, { max: 60, segundos: 60 })) return;
  }

  next();
});


app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();

  const jsonOriginal = res.json.bind(res);

  res.json = (body) => {
    try {
      const codigo = res.statusCode;

      /**
       * 5xx sempre; 400 só onde importa.
       *
       * Um 401 é uma sessão expirada e um 404 é um endereço
       * errado — nenhum dos dois é um problema nosso, e avisá-los
       * encheria o canal.
       */
      const critico = /ride|offer|payout|chat|partner|booking/.test(req.path);

      /**
       * As rotas que batem sozinhas não alarmam.
       *
       * A presença e o tick correm de poucos em poucos segundos.
       * Quando o Render adormece, a primeira chamada de cada uma
       * dá 504 — e o canal enchia-se de avisos sobre uma coisa que
       * se resolve sozinha ao acordar.
       *
       * O que importa saber é que o serviço adormeceu, e isso o
       * ping já diz. Vinte alarmes a dizer o mesmo não dizem mais.
       */
      const bateSozinha = /\/(presence|tick|health|ping|heartbeat)/.test(req.path);

      /**
       * E o 504 é do proxy, não nosso.
       *
       * Um Gateway Timeout é o Render a acordar ou a rede a
       * falhar. O código nem chegou a correr — avisar sobre ele é
       * avisar sobre o tempo.
       */
      const daInfraestrutura = codigo === 502 || codigo === 503 || codigo === 504;

      if (bateSozinha || daInfraestrutura) {
        return jsonOriginal(body);
      }

      /**
       * Um 400 de validação não é um erro nosso.
       *
       * Um parceiro que escreva um telefone com três dígitos e
       * seja recusado é o código a funcionar. Avisar sobre isso é
       * avisar que as verificações existem.
       */
      /**
       * A resposta diz se é validação.
       *
       * Comparar o texto da mensagem funcionava até alguém mudar
       * uma palavra — e depois o canal enchia-se outra vez, sem
       * ninguém perceber porquê.
       *
       * Um campo na resposta é explícito: quem escreve a
       * validação decide, e não há regex a adivinhar.
       */
      const validacao = codigo === 400 && body?.field_error === true;

      if (validacao) {
        return jsonOriginal(body);
      }

      if (codigo >= 500 || (codigo === 400 && critico)) {
        avisarOps(`${req.method} ${req.path}`,
          body?.error || `HTTP ${codigo}`);
      }
    } catch (e) {
      // Um alarme que falha não deve travar a resposta.
    }

    return jsonOriginal(body);
  };

  next();
});


/** Mandar um alarme à API principal. */
function avisarOps(tarefa, erro, detalhe) {
  const url = process.env.MAIN_API_URL;
  const segredo = process.env.CRON_SECRET;

  if (!url || !segredo) return;

  fetch(url + '/api/internal/alarm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': segredo
    },
    body: JSON.stringify({ task: tarefa, error: erro, detail: detalhe })
  }).catch(() => {
    // Se nem o alarme chega, o registo é o que resta.
    console.error('[alarm] could not reach main API:', tarefa, erro);
  });
}


// O ping do cron-job.org aponta aqui para o serviço não adormecer.
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'drivers', time: new Date().toISOString() });
});

/**
 * As peças partilhadas, criadas UMA vez.
 *
 * O portal e o call centre usam ambos o chatFor e o asUser. Cada um
 * a criar a sua cópia seriam duas verdades sobre o que é uma
 * conversa — e um dia divergiam sem ninguém dar por isso.
 */
const emailFns = {
  sendPartnerApplicationReceived,
  sendPartnerDecision,
  sendRideConfirmedToPartner,
  sendVerification,
  // A escalada ao supervisor quando um parceiro espera dez minutos
  // por resposta. Pedida pelo /api/tasks/support-tick, não por uma
  // ação de ninguém.
  sendSupportEscalation,
  sendRideOffer,
  sendRideOfferReminder
};

const shared = createShared({
  supabase,
  getUserFromRequest,
  email: emailFns,

  /**
   * Os avisos do Telegram.
   *
   * Um email de "conversa nova" chega a uma caixa que ninguém
   * vigia ao domingo. O canal está no telemóvel de quem está de
   * serviço.
   */
  telegram: {
    newChat: telegramNewChat,
    newAccount: telegramNewAccount,
    newAgency: telegramNewAgency,
    newPartner: telegramNewPartner
  },

  config: {
    defaultCountry: process.env.DEFAULT_PARTNER_COUNTRY || 'PT'
  }
});


// O portal de motoristas: registo, documentos, frota, agenda.
app.use(createPartnerRoutes({
  supabase,
  getUserFromRequest,
  requireAdmin,
  shared,
  email: emailFns,
  config: {
    defaultCountry: process.env.DEFAULT_PARTNER_COUNTRY || 'PT',
    // Para avisar o calendário quando um parceiro aceita uma
    // viagem. As credenciais do Google vivem na API principal.
    apiUrl: process.env.MAIN_API_URL || 'https://airportlink.onrender.com',
    cronSecret: process.env.CRON_SECRET
  }
}));

// O call centre: filas, estados de agente, métricas, escalada.
app.use(createSupportRoutes({
  supabase,
  getUserFromRequest,
  requireAdmin,
  requireSupervisor,
  shared,
  email: emailFns,
  config: {
    defaultCountry: process.env.DEFAULT_PARTNER_COUNTRY || 'PT'
  }
}));

// O portal é uma aplicação de página única: qualquer rota que não
// seja da API devolve o index.html.
app.use(express.static('public', { extensions: ['html'] }));

/**
 * Um ficheiro estático em falta tem de dar 404, não a página.
 *
 * Sem isto, um pedido a /assets/help-bot.js que não existe recebe o
 * index.html — e o browser tenta interpretar HTML como JavaScript,
 * dando "Unexpected token '<'". O erro não nomeia o ficheiro em
 * falta, e perde-se meia hora a perceber que é só um ficheiro que
 * não foi publicado.
 */
app.use((req, res, next) => {
  // Middleware em vez de app.get com expressão regular: o Express 5
  // mudou a sintaxe das rotas e um padrão inválido rebenta no
  // arranque — o serviço nem sobe, e o browser vê 502.
  if (req.method !== 'GET') return next();

  if (/\.(js|css|map|png|jpg|jpeg|svg|webp|ico|json|txt|woff2?)$/.test(req.path)) {
    console.warn('Static file not found:', req.path);
    return res.status(404).type('text/plain').send('Not found: ' + req.path);
  }

  return next();
});

/**
 * Tudo o resto vai para o portal.
 *
 * Middleware em vez de app.get('*'): o Express 5 removeu o asterisco
 * como padrão de rota e rebenta no ARRANQUE com "Missing parameter
 * name". O serviço nem sobe, e do lado do browser vê-se 502 — que
 * não aponta para lado nenhum.
 *
 * Um middleware sem caminho funciona nas duas versões.
 */
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `No such endpoint: ${req.path}` });
  }

  res.sendFile('index.html', { root: 'public' });
});

/**
 * O último apanhador, depois de todas as rotas.
 *
 * Um erro que escape a uma rota sai como HTML sem cabeçalhos de
 * CORS, e o browser mostra "Failed to fetch" — que não diz nada
 * sobre a causa.
 */
app.use((err, req, res, next) => {
  console.error('[erro não tratado]', req.method, req.path, err);

  avisarOps(`${req.method} ${req.path}`, `Unhandled: ${err.message}`);

  if (res.headersSent) return next(err);

  const origin = req.headers.origin;

  if (origin && typeof originAllowed === 'function' && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  return res.status(500).json({
    error: 'Something went wrong on our side. Please try again.'
  });
});


app.listen(PORT, () => {
  console.log(`Drivers portal running on ${PORT}`);
});
