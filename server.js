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
  sendVerification
} from './emailclient.js';

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');

// service_role ignora a RLS. É por isso que este ficheiro nunca pode
// ser servido ao browser, e por isso que todas as rotas verificam
// quem está a pedir antes de escreverem seja o que for.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    .select('id, email, is_admin')
    .eq('id', user.id)
    .maybeSingle();

  if (error) return { error: 'Could not verify your account.' };

  if (!data || data.is_admin !== true) {
    return {
      error: `You are signed in as ${user.email}, which is not an administrator account.`
    };
  }

  return { user };
}

// O painel principal continua noutro domínio e pode precisar de
// chamar estas rotas — por exemplo para aprovar candidaturas.
const ALLOWED_ORIGINS = [
  'https://drivers.airportlink.app',
  'https://www.airportlink.app',
  'https://airportlink.app',
  /\.filesusr\.com$/,
  /\.wixsite\.com$/
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
    console.warn('CORS blocked:', origin);
    return callback(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '1mb' }));

if (!process.env.CRON_SECRET) {
  console.warn(
    'CRON_SECRET is not set. The portal works, but no partner emails will be sent — ' +
    'they go through the main API and that is the shared secret.'
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
  email: {
    sendPartnerApplicationReceived,
    sendPartnerDecision,
    sendRideConfirmedToPartner,
    sendVerification
  },
  config: {
    defaultCountry: process.env.DEFAULT_PARTNER_COUNTRY || 'PT'
  }
}));

// O portal é uma aplicação de página única: qualquer rota que não
// seja da API devolve o index.html.
app.use(express.static('public', { extensions: ['html'] }));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `No such endpoint: ${req.path}` });
  }
  res.sendFile('index.html', { root: 'public' });
});

app.listen(PORT, () => {
  console.log(`Drivers portal running on ${PORT}`);
});
