/**
 * airportlink-drivers/emailclient.js
 * ---------------------------------------------------------------
 * Pede à API principal que envie os emails, em vez de os enviar.
 *
 * Porquê assim, e não uma cópia do emailService:
 *
 * Duas cópias do mesmo ficheiro em dois serviços divergem sempre.
 * Basta corrigir uma frase num deles e esquecer o outro, e a partir
 * daí metade dos parceiros recebe o texto antigo — sem erro nenhum,
 * sem aviso nenhum. É o género de bug que se descobre por acaso ao
 * fim de meses.
 *
 * Assim o emailService existe num sítio só. Este ficheiro tem
 * quarenta linhas e nunca precisa de mudar quando um email muda.
 *
 * Também deixa de ser preciso ter as chaves do Resend neste serviço.
 * ---------------------------------------------------------------
 */

const API = process.env.MAIN_API_URL || 'https://airportlink.onrender.com';
const SECRET = process.env.CRON_SECRET;

/**
 * Um pedido à rota interna.
 *
 * Nunca lança. Um email que falha não pode partir o que o
 * desencadeou: se a candidatura de um parceiro foi gravada, o
 * parceiro está registado, com ou sem email de confirmação.
 */
async function send(template, payload) {
  if (!SECRET) {
    console.warn(`[email] CRON_SECRET missing, ${template} not sent`);
    return { sent: false, reason: 'no-secret' };
  }

  try {
    const response = await fetch(`${API}/api/internal/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': SECRET
      },
      body: JSON.stringify({ template, payload })
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      // A API pode estar a acordar e devolver HTML. Sem isto, o erro
      // seria "Unexpected token '<'", que não ajuda ninguém.
      console.error(`[email] ${template}: non-JSON reply (HTTP ${response.status})`);
      return { sent: false, reason: 'bad-reply' };
    }

    if (!response.ok || data.error) {
      console.error(`[email] ${template} failed:`, data.error || response.status);
      return { sent: false, reason: data.error || `HTTP ${response.status}` };
    }

    console.log(`[email] ${template} requested`);
    return { sent: Boolean(data.sent), ...data };
  } catch (error) {
    console.error(`[email] ${template} could not reach the API:`, error.message);
    return { sent: false, reason: 'unreachable' };
  }
}

// As três que o portal dos motoristas dispara. As assinaturas são
// iguais às do emailService, para o partners.js não saber a
// diferença entre uma implementação e a outra.

export async function sendPartnerApplicationReceived(partner) {
  return send('partner_received', { partner });
}

export async function sendPartnerDecision(partner, decision, reason) {
  return send('partner_decision', { partner, decision, reason });
}

export async function sendRideConfirmedToPartner(partner, booking) {
  return send('ride_confirmed', { partner, booking });
}

/**
 * O link de confirmação é gerado pela API principal, que tem o
 * cliente com service_role e o emailService. Este serviço só pede.
 */
export async function sendVerification(email, name, kind) {
  return send('verify_email', { email, name, kind });
}
