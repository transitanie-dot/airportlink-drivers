/**
 * airportlink-drivers/emailclient.js
 * ---------------------------------------------------------------
 * O serviço de drivers não envia emails: pede-os à API principal.
 *
 * A razão é simples. O emailService.js — com os modelos, o
 * invólucro HTML e a proteção contra duplicados — vive lá. Duplicá-lo
 * aqui obrigaria a manter duas cópias em sincronia, e a primeira vez
 * que alguém corrigisse uma frase num lado e não no outro os
 * parceiros passariam a receber duas versões do mesmo email.
 *
 * Também significa que este serviço não precisa da chave do Resend.
 * Uma chave a menos exposta é uma chave a menos que se pode perder.
 *
 * A autenticação é o CRON_SECRET partilhado entre os dois serviços.
 * ---------------------------------------------------------------
 */

const MAIN_API = process.env.MAIN_API_URL || 'https://airportlink.onrender.com';

/**
 * Pede um email à API principal.
 *
 * NUNCA lança. Um email que não sai não pode partir o que o pediu:
 * uma candidatura submetida continua submetida, uma viagem aceite
 * continua aceite. O erro fica nos registos e a vida segue.
 */
async function pedirEmail(template, payload) {
  if (!process.env.CRON_SECRET) {
    console.warn(`[email] CRON_SECRET missing — ${template} not sent`);
    return { sent: false, reason: 'no-secret' };
  }

  try {
    const res = await fetch(`${MAIN_API}/api/internal/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': process.env.CRON_SECRET
      },
      body: JSON.stringify({ template, payload })
    });

    const texto = await res.text();
    let data;

    try {
      data = JSON.parse(texto);
    } catch {
      // A API principal a acordar devolve HTML, não JSON. Dizer isso
      // é mais útil do que um erro de parsing sem contexto.
      console.error(`[email] ${template}: main API returned non-JSON (HTTP ${res.status})`);
      return { sent: false, reason: 'bad-response' };
    }

    if (!res.ok) {
      console.error(`[email] ${template} refused:`, data.error || res.status);
      return { sent: false, reason: data.error || `HTTP ${res.status}` };
    }

    console.log(`[email] ${template} requested`);
    return data;
  } catch (error) {
    console.error(`[email] ${template} request failed:`, error.message);
    return { sent: false, reason: error.message };
  }
}

// ============================================================
// OS EMAILS QUE ESTE SERVIÇO PEDE
//
// As assinaturas são as que o partners.js usa. Mudá-las aqui
// obriga a mudar lá também.
// ============================================================

/** Candidatura de parceiro submetida e a aguardar revisão. */
export async function sendPartnerApplicationReceived(partner) {
  if (!partner?.email) {
    console.warn('[email] partner_received: no email on the partner row');
    return { sent: false, reason: 'no-recipient' };
  }

  return pedirEmail('partner_received', { partner });
}

/**
 * A decisão sobre uma candidatura.
 *
 * `decision` é 'approved', 'rejected', 'suspended' ou 'verified'.
 * O `reason` só é usado nas duas negativas.
 */
export async function sendPartnerDecision(partner, decision, reason) {
  if (!partner?.email) {
    console.warn('[email] partner_decision: no email on the partner row');
    return { sent: false, reason: 'no-recipient' };
  }

  return pedirEmail('partner_decision', { partner, decision, reason });
}

/** Uma viagem que o parceiro acabou de aceitar. */
export async function sendRideConfirmedToPartner(partner, booking) {
  if (!partner?.email || !booking) {
    console.warn('[email] ride_confirmed: missing partner or booking');
    return { sent: false, reason: 'missing-data' };
  }

  return pedirEmail('ride_confirmed', { partner, booking });
}

/**
 * O email de confirmação de endereço.
 *
 * O link só pode ser gerado pela API principal: é ela que tem o
 * cliente Supabase com a chave de administração.
 */
export async function sendVerification(email, name, kind) {
  if (!email) {
    console.warn('[email] verify: no address');
    return { sent: false, reason: 'no-recipient' };
  }

  return pedirEmail('verify_email', { email, name, kind: kind || 'partner' });
}

/**
 * Um parceiro à espera há dez minutos com um agente atribuído.
 *
 * Vai para o endereço de operações e não para o agente: ele já viu
 * o aviso no painel aos três e aos cinco minutos. Este email existe
 * precisamente para o caso de não estar a ver o painel de todo.
 *
 * Chamado pelo /api/tasks/support-tick, não por uma ação de
 * ninguém — é a única coisa neste ficheiro que ninguém pediu.
 */
export async function sendSupportEscalation(aviso) {
  return pedirEmail('support_escalation', {
    chat_id: aviso.chat_id,
    partner_name: aviso.partner_name,
    waiting_minutes: aviso.waiting_minutes,
    agent_id: aviso.agent_id
  });
}
