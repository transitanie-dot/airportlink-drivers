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
import { createPartnerRoutes } from './partners.js';
// Os emails são pedidos à API principal, onde o emailService vive.
// Este serviço não tem cópia nenhuma dele nem chaves do Resend.
import {
  sendPartnerApplicationReceived,
  sendPartnerDecision,
  sendRideConfirmedToPartner,
  sendVerification,
  sendSupportEscalation
} from './emailclient.js';

const app = express();
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

// O ping do cron-job.org aponta aqui para o serviço não adormecer.
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'drivers', time: new Date().toISOString() });
});

app.use(createPartnerRoutes({
  supabase,
  getUserFromRequest,
  requireAdmin,
  requireSupervisor,
  email: {
    sendPartnerApplicationReceived,
    sendPartnerDecision,
    sendRideConfirmedToPartner,
    sendVerification,
    // A escalada ao supervisor quando um parceiro espera dez
    // minutos por resposta. Pedida pelo /api/tasks/support-tick,
    // não por uma ação de ninguém.
    sendSupportEscalation
  },
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

app.listen(PORT, () => {
  console.log(`Drivers portal running on ${PORT}`);
});
