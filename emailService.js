/**
 * airportlink-api/emailService.js
 * ---------------------------------------------------------------
 * Envio de emails transacionais através do Resend.
 *
 * Três decisões que valem a pena explicar:
 *
 * 1. A proteção contra duplicados está na BASE DE DADOS, não aqui.
 *    O Stripe repete webhooks quando não recebe resposta rápida; um
 *    registo em memória perder-se-ia no primeiro reinício. A chave
 *    única na email_log é o que garante que ninguém recebe duas
 *    confirmações da mesma reserva.
 *
 * 2. Um email que falha NUNCA quebra o que o desencadeou. Se a
 *    confirmação não sair, a reserva continua paga e válida. Todas
 *    as funções apanham os seus próprios erros.
 *
 * 3. O fornecedor está isolado numa função. Trocar de Resend para
 *    outro é reescrever deliver(), e mais nada.
 * ---------------------------------------------------------------
 */

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * O remetente.
 *
 * Aceita os dois nomes porque o servidor já usa EMAIL_FROM_BOOKINGS,
 * e esse é o melhor nome: deixa espaço para um EMAIL_FROM_PARTNERS
 * quando os motoristas tiverem os seus próprios emails, sem que os
 * dois se confundam.
 *
 * O domínio TEM de ser mail.airportlink.app — é esse que está
 * verificado no Resend. Enviar da raiz falha, porque a raiz não tem
 * os registos de autenticação.
 */
const FROM = process.env.EMAIL_FROM_BOOKINGS
  || process.env.EMAIL_FROM
  || 'Airportlink <bookings@mail.airportlink.app>';

const REPLY_TO = process.env.EMAIL_REPLY_TO || 'support@airportlink.app';
const SITE = process.env.SITE_ORIGIN || 'https://www.airportlink.app';

// O portal dos motoristas vive noutro domínio: sessões diferentes,
// páginas diferentes.
const DRIVERS_URL = process.env.DRIVERS_URL || 'https://drivers.airportlink.app';

// Para onde vão os avisos internos: viagem sem parceiro, cobrança
// falhada em definitivo, candidatura nova.
const OPS = process.env.EMAIL_OPERATIONS || null;

/**
 * Um aviso para dentro de casa. Não tem chave de idempotência porque
 * não é para o cliente: se chegarem dois avisos de que uma viagem
 * não tem motorista, ninguém se incomoda. Perder um é que era mau.
 */
export async function notifyOps(subject, lines, override) {
  const to = override || OPS;
  if (!to) return { sent: false, reason: 'no-ops-address' };

  try {
    const html = wrap({
      preheader: subject,
      heading: subject,
      blocks: [{ html: lines.map((l) => esc(l)).join('<br>') }]
    });

    const id = await deliver({ to, subject: `[ops] ${subject}`, html });
    return { sent: true, id };
  } catch (error) {
    // A mensagem do Resend é o que diz o que se passa: domínio não
    // verificado, chave inválida, remetente errado. Engoli-la era
    // deixar-te sem forma de descobrir.
    console.error('[email] ops notice failed:', error.message);
    return { sent: false, reason: error.message };
  }
}

let supabase = null;

/**
 * Como avisar quando um email falha.
 *
 * Injetada de fora em vez de importada: o emailService não deve
 * saber que existe Telegram. Se um dia o alarme for por outro
 * canal, muda-se num sítio.
 */
let avisarFalha = null;

export function setEmailAlarm(fn) {
  avisarFalha = fn;
}

/**
 * Quando ligada, o sendOnce não regista nem verifica duplicados.
 * Só a pré-visualização a usa.
 */
let previewMode = false;

/** Chamado uma vez pelo server.js, para não haver dois clientes. */
export function initEmail(client) {
  supabase = client;
}

// ============================================================
// APRESENTAÇÃO
// ============================================================

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(amount, currency) {
  const value = Number(amount || 0);
  const code = String(currency || 'EUR').toUpperCase();
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

function longDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

function shortTime(timeStr) {
  return timeStr ? String(timeStr).slice(0, 5) : '';
}

/**
 * O invólucro de todos os emails.
 *
 * Tabelas e estilos em linha, de propósito. O Outlook ignora
 * stylesheets e trata flexbox como se não existisse — é feio de
 * escrever mas é o que aparece igual em todo o lado.
 */
/**
 * O molde de todos os emails.
 *
 * O "cta" aceita href OU url, de propósito.
 *
 * O molde sempre leu cta.href. Metade dos emails foi escrita com
 * cta.url — e nesses o href saía vazio: o botão aparecia bonito e
 * não ia a lado nenhum.
 *
 * Dez emails estiveram assim, e ninguém reparou porque um botão
 * morto não dá erro. Aceitar os dois nomes custa nove caracteres
 * e resolve todos de uma vez.
 */
function wrap({ preheader, heading, intro, blocks = [], cta, footNote, signOff }) {
  const rows = blocks.map((b) => {
    if (b.type === 'facts') {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="border-collapse:separate;border-spacing:0 8px;margin:8px 0 4px">
        ${b.items.filter((i) => i.value).map((i) => `
        <tr>
          <td style="padding:10px 14px;background:#F3F4F0;border-radius:10px 0 0 10px;
            font:600 11px/1.4 'IBM Plex Mono',monospace;letter-spacing:.08em;
            text-transform:uppercase;color:#606A7B;width:38%">${esc(i.label)}</td>
          <td style="padding:10px 14px;background:#F3F4F0;border-radius:0 10px 10px 0;
            font:500 15px/1.5 Arial,sans-serif;color:#141A28">${esc(i.value)}</td>
        </tr>`).join('')}
      </table>`;
    }

    if (b.type === 'route') {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="margin:14px 0;border:1px solid #E2E5E0;border-radius:14px">
        <tr><td style="padding:16px 18px">
          <div style="font:600 10px/1.4 'IBM Plex Mono',monospace;letter-spacing:.1em;
            text-transform:uppercase;color:#0F766E;margin-bottom:4px">Pick-up</div>
          <div style="font:500 15px/1.5 Arial,sans-serif;color:#141A28;margin-bottom:14px">${esc(b.from)}</div>
          <div style="font:600 10px/1.4 'IBM Plex Mono',monospace;letter-spacing:.1em;
            text-transform:uppercase;color:#606A7B;margin-bottom:4px">Drop-off</div>
          <div style="font:500 15px/1.5 Arial,sans-serif;color:#141A28">${esc(b.to)}</div>
        </td></tr></table>`;
    }

    /**
     * Uma citação: o que o agente escreveu.
     *
     * Recuada e em cinzento, para se ler como uma mensagem e não
     * como texto nosso. O cliente reconhece a diferença sem ter de
     * pensar nela.
     */
    if (b.type === 'quote') {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="margin:16px 0"><tr>
        <td style="padding:14px 18px;background:#F7F7F4;
                   border-left:3px solid #0D9488;border-radius:0 10px 10px 0;
                   font-size:15px;line-height:1.6;color:#1A1A17;
                   white-space:pre-wrap">${esc(b.text || '')}</td>
      </tr></table>`;
    }

    if (b.type === 'note') {
      const colours = {
        ok: ['#ECFDF5', '#A7F3D0', '#065F46'],
        warn: ['#FDF6E7', '#F0D9A8', '#8A5A12'],
        bad: ['#FFF1F2', '#FDA29B', '#B42318']
      };
      const [bg, border, text] = colours[b.tone] || colours.ok;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="margin:14px 0"><tr><td style="padding:14px 16px;background:${bg};
        border:1px solid ${border};border-radius:12px;font:400 14px/1.6 Arial,sans-serif;
        color:${text}">${b.html || esc(b.text || '')}</td></tr></table>`;
    }

    /**
     * O text é escapado; o html não.
     *
     * Os blocos foram escritos com "html" e usados com "text" —
     * três emails mostravam "undefined" onde devia estar a nota.
     *
     * Aceitar os dois resolve, e a diferença é intencional: quem
     * passa html quer etiquetas lá dentro e é responsável por
     * elas; quem passa text quer texto e não quer pensar nisso.
     */
    return `<p style="margin:0 0 14px;font:400 15px/1.65 Arial,sans-serif;color:#3B4354">${b.html || esc(b.text || '')}</p>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#E8EBE7">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E8EBE7">
<tr><td align="center" style="padding:28px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="max-width:560px;background:#FBFBF8;border-radius:18px;overflow:hidden">

    <tr><td style="padding:20px 26px;background:#141A28">
      <span style="font:800 18px/1 Arial,sans-serif;letter-spacing:-.5px;color:#FFFFFF">AIRPORT<span style="color:#E8A33D">LINK</span></span>
    </td></tr>

    <tr><td style="padding:28px 26px 8px">
      <h1 style="margin:0 0 12px;font:700 23px/1.2 Arial,sans-serif;
        letter-spacing:-.5px;color:#141A28">${esc(heading)}</h1>
      ${intro ? intro.split('\n\n').map((par) =>
        `<p style="margin:0 0 16px;font:400 15px/1.65 Arial,sans-serif;color:#3B4354">${esc(par)}</p>`
      ).join('') : ''}
      ${rows}
      ${cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px">
        <tr><td style="background:#0F766E;border-radius:12px">
          <a href="${esc(cta.href || cta.url || '')}" style="display:inline-block;padding:14px 26px;
            font:600 12px/1 'IBM Plex Mono',monospace;letter-spacing:.09em;
            text-transform:uppercase;color:#FFFFFF;text-decoration:none">${esc(cta.label)}</a>
        </td></tr></table>` : ''}
    </td></tr>

    <tr><td style="padding:18px 26px 26px">
      ${signOff ? `<p style="margin:0 0 18px;font:400 14px/1.6 Arial,sans-serif;color:#2A3342">${esc(signOff)}</p>` : ''}
      ${footNote ? `<p style="margin:0 0 14px;font:400 13px/1.6 Arial,sans-serif;color:#606A7B">${footNote}</p>` : ''}
      <div style="border-top:1px solid #E2E5E0;padding-top:16px;
        font:400 12px/1.7 Arial,sans-serif;color:#8A93A3">
        Questions? Reply to this email or open a chat at
        <a href="${SITE}/support" style="color:#0F766E">airportlink.app/support</a>.<br>
        Airportlink &middot; private airport transfers
      </div>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
}

// ============================================================
// ENVIO
// ============================================================

/**
 * A única função que fala com o fornecedor. Trocar de Resend para
 * outro é reescrever isto e mais nada.
 */
async function deliver({ to, subject, html, replyTo }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const response = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject,
      html,
      reply_to: replyTo || REPLY_TO
    })
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Resend returned a non-JSON response (HTTP ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(data.message || data.error || `Resend HTTP ${response.status}`);
  }

  return data.id || null;
}

/**
 * Envia uma vez e só uma.
 *
 * A chave única na email_log é o cadeado: se já lá estiver, o insert
 * falha e desistimos. Fazer a verificação antes do insert não
 * chegaria — entre a verificação e a escrita cabe outro webhook.
 */
async function sendOnce({ key, template, to, subject, html, bookingId, replyTo }) {
  if (!to) {
    console.warn(`[email] ${template}: no recipient, skipped`);
    return { sent: false, reason: 'no-recipient' };
  }

  if (previewMode) {
    try {
      const providerId = await deliver({ to, subject, html, replyTo });
      console.log(`[email] preview ${template} -> ${to}`);
      return { sent: true, id: providerId };
    } catch (error) {
      console.error(`[email] preview ${template} failed:`, error.message);
      return { sent: false, reason: error.message };
    }
  }

  if (!supabase) {
    console.error('[email] initEmail was never called');
    return { sent: false, reason: 'not-initialised' };
  }

  const { data: row, error: claimError } = await supabase
    .from('email_log')
    .insert({
      idempotency_key: key,
      template,
      recipient: to,
      subject,
      booking_id: bookingId || null,
      status: 'queued'
    })
    .select('id')
    .maybeSingle();

  if (claimError) {
    // 23505 é violação de unicidade: já foi enviado. Não é um erro,
    // é exatamente o que queremos que aconteça.
    if (claimError.code === '23505') {
      console.log(`[email] ${template} already sent for ${key}`);
      return { sent: false, reason: 'duplicate' };
    }
    console.error('[email] could not claim:', claimError.message);
    return { sent: false, reason: 'claim-failed' };
  }

  try {
    const providerId = await deliver({ to, subject, html, replyTo });

    await supabase.from('email_log').update({
      status: 'sent',
      provider_id: providerId,
      sent_at: new Date().toISOString(),
      attempts: 1
    }).eq('id', row.id);

    console.log(`[email] ${template} -> ${to}`);
    return { sent: true, id: providerId };
  } catch (error) {
    await supabase.from('email_log').update({
      status: 'failed',
      error: String(error.message).slice(0, 500),
      attempts: 1
    }).eq('id', row.id);

    console.error(`[email] ${template} failed:`, error.message);

    /**
     * E as operações sabem.
     *
     * Um email que não chega é invisível: o cliente não recebe a
     * confirmação, o parceiro não recebe a oferta, e a única marca
     * é uma linha na consola do Render.
     *
     * O sendRideOffer é o pior caso — sem ele a cascata pára e a
     * viagem fica sem motorista sem ninguém dar por isso.
     */
    if (avisarFalha) {
      avisarFalha(`email: ${template}`,
        `${error.message}\n\nTo: ${to}` +
        (bookingId ? `\nBooking: ${bookingId}` : '')
      ).catch(() => {});
    }
    return { sent: false, reason: 'send-failed', error: error.message };
  }
}

/**
 * A referência que se diz ao telefone.
 *
 * A coluna booking_reference está vazia em todas as reservas — 32
 * de 32. O que se vê no painel vem do booking_id, que tem o
 * "AL2633934" e o "-R" nas voltas.
 *
 * Esta função escolhe a que existir. Enquanto a coluna morta não
 * for removida, comparar por ela falha em silêncio.
 */
function reference(booking) {
  if (!booking) return '';

  return booking.booking_id
    || booking.booking_reference
    || String(booking.id || '').slice(0, 8);
}

// ============================================================
// OS EMAILS
//
// Cada um apanha os seus próprios erros: se a confirmação não sair,
// a reserva continua paga e válida. Nunca deixar um email partir o
// que o desencadeou.
// ============================================================

/** Pago na reserva. O mais importante de todos. */
export async function sendBookingConfirmation(booking, passwordLink, returnLeg) {
  try {
    const ref = reference(booking);

    const html = wrap({
      preheader: `Your transfer on ${longDate(booking.booking_date)} is confirmed.`,
      heading: returnLeg ? 'Both transfers are confirmed' : 'Your transfer is confirmed',
      intro: returnLeg
        ? `Everything is booked, ${esc(booking.full_name || 'there')}. Two transfers, ` +
          'each with its own driver and its own confirmation.'
        : `Everything is booked, ${esc(booking.full_name || 'there')}. Here is what will happen.`,
      blocks: [
        returnLeg
          ? { html: '<strong style="color:#0F766E;font-size:11px;letter-spacing:.1em;' +
              'text-transform:uppercase">Outbound</strong>' }
          : { html: '' },

        { type: 'facts', items: [
          { label: 'Reference', value: ref },
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) },
          { label: 'Passengers', value: booking.passengers },
          { label: 'Flight', value: booking.flight_number },
          { label: returnLeg ? 'This leg' : 'Paid',
            value: money(booking.price, booking.currency) },

          /**
           * O suplemento noturno, aqui e não na calculadora.
           *
           * Antes de comprar, o cliente vê o preço e decide —
           * explicar a mecânica convida a discutir uma regra que
           * não vai mudar.
           *
           * No recibo é o contrário: é onde se procura quando se
           * quer perceber um valor, e uma linha a dizer porquê
           * evita um email a perguntar.
           */
          { label: 'Night surcharge',
            value: booking.night_surcharge
              ? '20% (pick-up between 22:55 and 06:00)'
              : null }
        ]},
        { type: 'route', from: booking.pickup, to: booking.dropoff },

        // A volta é uma reserva própria: referência própria, motorista
        // próprio, cancelável sozinha. Mostrá-la como um bloco à parte
        // é o que faz isso ficar claro.
        returnLeg
          ? { html: '<strong style="color:#0F766E;font-size:11px;letter-spacing:.1em;' +
              'text-transform:uppercase">Return</strong>' }
          : { html: '' },

        returnLeg
          ? { type: 'facts', items: [
              { label: 'Reference', value: reference(returnLeg) },
              { label: 'Date', value: longDate(returnLeg.booking_date) },
              { label: 'Pick-up time', value: shortTime(returnLeg.booking_time) },
              { label: 'This leg', value: money(returnLeg.price, returnLeg.currency) }
            ]}
          : { html: '' },

        returnLeg
          ? { type: 'route', from: returnLeg.pickup, to: returnLeg.dropoff }
          : { html: '' },

        returnLeg
          ? { type: 'note', tone: 'ok', html:
              '<strong>Paid in total: ' +
              esc(money(Number(booking.price || 0) + Number(returnLeg.price || 0),
                        booking.currency)) + '</strong><br>' +
              'One payment, two transfers. Each has its own driver and can be cancelled ' +
              'on its own without affecting the other.' }
          : { html: '' },
        { type: 'note', tone: 'ok', html:
          '<strong>Free cancellation until 24 hours before pick-up.</strong><br>' +
          'Cancel from your account and the full amount goes back to your card, automatically.' },
        { html: 'The day before your trip we will send you the driver&rsquo;s name, ' +
          'phone number and vehicle. If you gave us a flight number, we track it.' },

        // Quem reservou sem conta tem uma à espera, criada com o
        // email da reserva. Dizemo-lo abertamente: criar uma conta a
        // alguém e não avisar é o género de coisa que irrita com
        // razão.
        passwordLink
          ? { type: 'note', tone: 'warn', html:
              '<strong>We set up an account for you.</strong><br>' +
              'It holds this booking, the receipt and the cancel button. ' +
              'Choose a password below and it is yours &mdash; or ignore this and ' +
              'just reply to us if you need anything.' }
          : { html: '' }
      ].filter((b) => b.html !== ''),
      cta: passwordLink
        ? { href: passwordLink, label: 'Choose a password' }
        : { href: `${SITE}/myaccount`, label: returnLeg ? 'See my trips' : 'See my trip' }
    });

    return await sendOnce({
      key: `booking_confirmed:${ref}`,
      template: 'booking_confirmed',
      to: booking.passenger_email || booking.email,
      subject: returnLeg
        ? `Both transfers confirmed — ${longDate(booking.booking_date)} and ${longDate(returnLeg.booking_date)}`
        : `Transfer confirmed — ${longDate(booking.booking_date)} at ${shortTime(booking.booking_time)}`,
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] confirmation build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/** Reservado sem pagar: o cartão ficou guardado. */
export async function sendCardSaved(booking, chargeAt, returnLeg) {
  try {
    const ref = reference(booking);
    const when = chargeAt
      ? new Date(chargeAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
      : '48 hours before pick-up';

    const html = wrap({
      preheader: `Booked. We charge ${money(booking.price, booking.currency)} on ${when}.`,
      heading: 'Your transfer is booked',
      intro: 'Nothing has been charged yet. Your card is saved securely with Stripe and we will ' +
        'take the fare shortly before you travel.',
      blocks: [
        { type: 'facts', items: [
          { label: 'Reference', value: ref },
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) },
          { label: 'Passengers', value: booking.passengers },
          { label: 'Flight', value: booking.flight_number },
          { label: 'Vehicle', value: booking.vehicle_type },
          { label: 'To be charged', value: money(booking.price, booking.currency) },
          { label: 'Charge date', value: when }
        ]},
        { type: 'route', from: booking.pickup, to: booking.dropoff },
        { html: booking.flight_number
          ? `We track flight ${esc(booking.flight_number)}.`
          : 'The day before your trip we send the driver&rsquo;s name, phone number and vehicle.' },
        { type: 'note', tone: 'warn', html:
          `<strong>We charge ${esc(money(booking.price, booking.currency))} on ${esc(when)}.</strong><br>` +
          'Cancel before then and nothing is ever taken from your card. ' +
          'Make sure the card is still valid on that date.' }
      ],
      cta: { href: `${SITE}/myaccount`, label: 'See my trip' }
    });

    return await sendOnce({
      key: `card_saved:${ref}`,
      template: 'card_saved',
      to: booking.passenger_email || booking.email,
      subject: `Transfer booked — payment on ${when}`,
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] card saved build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/** A cobrança agendada correu bem. */
export async function sendChargeSucceeded(booking) {
  try {
    const ref = reference(booking);

    const html = wrap({
      preheader: `We have taken ${money(booking.price, booking.currency)} for your transfer.`,
      heading: 'Payment received',
      intro: 'Your transfer is fully paid and confirmed.',
      blocks: [
        { type: 'facts', items: [
          { label: 'Reference', value: ref },
          { label: 'Charged', value: money(booking.price, booking.currency) },
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) }
        ]},
        { type: 'route', from: booking.pickup, to: booking.dropoff },
        { html: 'We will send the driver&rsquo;s details the day before you travel.' }
      ],
      cta: { href: `${SITE}/myaccount`, label: 'See my trip' }
    });

    return await sendOnce({
      key: `charge_succeeded:${ref}`,
      template: 'charge_succeeded',
      to: booking.passenger_email || booking.email,
      subject: `Payment received — transfer on ${longDate(booking.booking_date)}`,
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] charge success build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/**
 * A cobrança falhou. A chave inclui o número da tentativa: cada uma
 * é um email novo, senão a segunda e a terceira ficavam em silêncio.
 */
export async function sendChargeFailed(booking, { attempt, willRetry }) {
  try {
    const ref = reference(booking);

    const html = wrap({
      preheader: 'We could not take payment for your transfer.',
      heading: 'We could not take your payment',
      intro: `Your card was declined for the transfer on ${longDate(booking.booking_date)}.`,
      blocks: [
        { type: 'facts', items: [
          { label: 'Reference', value: ref },
          { label: 'Amount', value: money(booking.price, booking.currency) },
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) }
        ]},
        { type: 'note', tone: willRetry ? 'warn' : 'bad', html: willRetry
          ? '<strong>We will try again in a few hours.</strong><br>' +
            'Check that the card is still valid and has funds available. If it will not work, ' +
            'reply to this email and we will send you a payment link.'
          : '<strong>This was our last attempt, so the booking has been cancelled.</strong><br>' +
            'No money was taken. If you still need the transfer, please book again ' +
            'or reply to this email.' },
        { html: willRetry
          ? 'Your booking is still held for now.'
          : 'We are sorry to do this, but we cannot send a driver to a trip that has not been paid.' }
      ],
      cta: { href: `${SITE}/myaccount`, label: willRetry ? 'Check my booking' : 'Book again' }
    });

    return await sendOnce({
      key: `charge_failed:${ref}:${attempt}`,
      template: 'charge_failed',
      to: booking.passenger_email || booking.email,
      subject: willRetry
        ? 'Payment problem with your transfer'
        : 'Your transfer has been cancelled — payment failed',
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] charge failed build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/** Cancelamento, com ou sem reembolso. */
export async function sendCancellation(booking, { refunded, amount }) {
  try {
    const ref = reference(booking);

    const html = wrap({
      preheader: 'Your transfer has been cancelled.',
      heading: 'Your transfer is cancelled',
      intro: `The transfer on ${longDate(booking.booking_date)} has been cancelled as you asked.`,
      blocks: [
        { type: 'facts', items: [
          { label: 'Reference', value: ref },
          { label: 'Was booked for', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) }
        ]},
        { type: 'note', tone: 'ok', html: refunded
          ? `<strong>${esc(money(amount, booking.currency))} is on its way back to your card.</strong><br>` +
            'We have issued the refund. Your bank usually takes 5 to 10 working days to show it.'
          : '<strong>Nothing was charged.</strong><br>' +
            'Your card was saved but never used, and we have now removed it.' },
        { html: 'If you need another transfer, we are here.' }
      ],
      cta: { href: `${SITE}/#book`, label: 'Book another transfer' }
    });

    return await sendOnce({
      key: `cancelled:${ref}`,
      template: 'cancelled',
      to: booking.passenger_email || booking.email,
      subject: `Transfer cancelled — ${ref}`,
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] cancellation build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

// ============================================================
// CLIENTE — ANTES DA VIAGEM
// ============================================================

/**
 * O motorista, na véspera.
 *
 * É o email que mais reduz chamadas ao suporte. Quem sabe o nome, o
 * telefone e a matrícula não liga a perguntar se está tudo bem.
 */
export async function sendDriverDetails(booking, driver, vehicle) {
  try {
    const ref = reference(booking);

    const html = wrap({
      preheader: `Your driver tomorrow: ${driver.full_name}.`,
      heading: 'Your driver for tomorrow',
      intro: `Everything is arranged for your transfer on ${longDate(booking.booking_date)}.`,
      blocks: [
        { type: 'facts', items: [
          { label: 'Driver', value: driver.full_name },
          { label: 'Phone', value: driver.phone },
          { label: 'Vehicle', value: vehicle
            ? `${vehicle.make} ${vehicle.model}` : null },
          { label: 'Plate', value: vehicle ? vehicle.plate : null },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) },
          { label: 'Reference', value: ref }
        ]},
        { type: 'route', from: booking.pickup, to: booking.dropoff },
        { type: 'note', tone: 'ok', html: booking.flight_number
          ? `<strong>We are tracking flight ${esc(booking.flight_number)}.</strong><br>` +
            'If it lands late the driver waits, and you are not charged for it. ' +
            'They will contact you with the exact meeting point.'
          : '<strong>Your driver will be waiting at the pick-up point.</strong><br>' +
            'If you cannot find each other, call the number above.' },
        { html: 'Save this driver&rsquo;s number to your phone now &mdash; it is much easier ' +
          'than looking for this email while carrying luggage.' }
      ],
      cta: { href: `${SITE}/myaccount`, label: 'See my trip' }
    });

    return await sendOnce({
      key: `driver_details:${ref}`,
      template: 'driver_details',
      to: booking.passenger_email || booking.email,
      subject: `Your driver tomorrow — ${driver.full_name}`,
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] driver details build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

// ============================================================
// PARCEIROS DE MOTORISTAS
// ============================================================

export async function sendPartnerApplicationReceived(partner) {
  try {
    const html = wrap({
      preheader: 'We have your application and are reviewing it.',
      heading: 'We have your application',
      intro: `Thank you, ${esc(partner.contact_name || 'there')}. ` +
        `${esc(partner.legal_name)} is now in the queue.`,
      blocks: [
        { type: 'note', tone: 'ok', html:
          '<strong>Your portal is at drivers.airportlink.app</strong><br>' +
          'Bookmark it. That is where your rides, documents, vehicles and payouts live &mdash; ' +
          'not on the main website. Sign in with the email and password you just chose.' },
        { html: 'We check every submission by hand, usually within a few working days. ' +
          'If a document is wrong or missing we tell you exactly which one and why &mdash; ' +
          'you will never get a rejection without a reason.' },
        { type: 'note', tone: 'warn', html:
          '<strong>You can carry on in the meantime.</strong><br>' +
          'Add your drivers, vehicles and service airports now, and you will be ready ' +
          'to take rides the moment we approve you.' }
      ],
      cta: { href: 'https://drivers.airportlink.app', label: 'Open my dashboard' }
    });

    return await sendOnce({
      key: `partner_received:${partner.id}`,
      template: 'partner_received',
      to: partner.email,
      subject: 'Your Airportlink partner application',
      html
    });
  } catch (error) {
    console.error('[email] partner received build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/** Verificado, aprovado ou recusado. Um email, três desfechos. */
export async function sendPartnerDecision(partner, decision, reason) {
  try {
    const copy = {
      verified: {
        heading: 'Your documents are accepted',
        intro: 'We have checked your paperwork and everything is in order.',
        tone: 'ok',
        note: '<strong>A few steps left before rides reach you.</strong><br>' +
          'Add a driver, a vehicle, the airports you serve and your payout details. ' +
          'Your dashboard shows exactly what is missing.',
        cta: 'Finish setting up',
        subject: 'Your documents are accepted'
      },
      approved: {
        heading: 'You are live',
        intro: 'Your company is approved and transfers at your airports are now visible to you.',
        tone: 'ok',
        note: '<strong>Take the rides that fit your day.</strong><br>' +
          'The fee shown on each ride is what reaches your account in full. ' +
          'We take no commission on top of it.<br><br>' +
          'Everything happens at <strong>drivers.airportlink.app</strong> &mdash; ' +
          'the ride board, your documents, your vehicles and your monthly statement.',
        cta: 'See available rides',
        subject: 'You are live on Airportlink'
      },
      rejected: {
        heading: 'We cannot approve your application',
        intro: 'We reviewed your submission and cannot take it forward as it stands.',
        tone: 'bad',
        note: reason
          ? '<strong>Reason</strong><br>' + esc(reason)
          : '<strong>Reason</strong><br>Please contact us and we will explain.',
        cta: 'Contact us',
        subject: 'About your Airportlink application'
      },
      suspended: {
        heading: 'Your account is paused',
        intro: 'You are not receiving rides at the moment.',
        tone: 'bad',
        note: reason
          ? '<strong>Reason</strong><br>' + esc(reason)
          : '<strong>Reason</strong><br>Please contact us and we will explain.',
        cta: 'Open my dashboard',
        subject: 'Your Airportlink account is paused'
      }
    }[decision];

    if (!copy) return { sent: false, reason: 'unknown-decision' };

    const html = wrap({
      preheader: copy.subject,
      heading: copy.heading,
      intro: copy.intro,
      blocks: [{ type: 'note', tone: copy.tone, html: copy.note }],
      cta: { href: 'https://drivers.airportlink.app', label: copy.cta }
    });

    // A chave inclui a decisão: um parceiro passa por verified e
    // depois por approved, e os dois emails têm de sair.
    return await sendOnce({
      key: `partner_${decision}:${partner.id}`,
      template: `partner_${decision}`,
      to: partner.email,
      subject: copy.subject,
      html
    });
  } catch (error) {
    console.error('[email] partner decision build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/** Uma viagem que o parceiro acabou de aceitar. */
/**
 * Uma viagem oferecida, com prazo.
 *
 * A cascata oferece a um parceiro de cada vez e dá-lhe minutos
 * para responder. Sem este email, o parceiro não sabe que tem uma
 * oferta — ela expira sempre, e cada viagem percorre a lista
 * inteira sem ninguém responder.
 *
 * É o email que faz a atribuição automática funcionar de todo.
 */
export async function sendRideOffer(partner, booking, offer) {
  try {
    const ref = reference(booking);
    const minutos = offer?.expires_in_minutes || 15;

    /**
     * Não se diz quanto o cliente pagou.
     *
     * O parceiro vê o que RECEBE. A margem é nossa e mostrá-la
     * convida a conversas que não levam a lado nenhum.
     */
    const html = wrap({
      preheader: `A transfer for ${longDate(booking.booking_date)}. ` +
        `You have ${minutos} minutes to take it.`,

      heading: 'A transfer for you',

      intro: `This one went to you first${offer?.reason
        ? ` because you ${offer.reason.split(',')[0]}`
        : ''}. ` +
        `Take it within ${minutos} minutes and it is yours. ` +
        `After that it goes to the next partner.`,

      blocks: [
        { type: 'facts', items: [
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) },
          { label: 'Passengers', value: booking.passengers },
          { label: 'Vehicle', value: offer?.vehicle_class || '—' },
          { label: 'You receive', value: money(booking.driver_payout, booking.currency) }
        ]},

        { type: 'route', from: booking.pickup, to: booking.dropoff },

        { type: 'note', text:
          'The passenger name and phone appear once you take the ride. ' +
          'Declining costs you nothing — it just passes it on faster. ' +
          'Ignoring it is what counts against you.' }
      ],

      cta: {
        label: 'Open the ride',
        url: `${SITE}/drivers#ride-${booking.id}`
      },

      footNote: `Reference ${ref}`
    });

    /**
     * A chave inclui o parceiro E a posição na cascata.
     *
     * Sem a posição, um parceiro que recebesse a mesma viagem duas
     * vezes — porque a primeira expirou e a lista deu a volta — não
     * receberia o segundo email.
     */
    return await sendOnce({
      key: `ride_offer:${ref}:${partner.id}:${offer?.rank || 1}`,
      template: 'ride_offer',
      to: partner.email,
      subject: `Transfer offer — ${longDate(booking.booking_date)} — ${minutos} min to reply`,
      html
    });
  } catch (error) {
    console.error('sendRideOffer failed:', error);
    return { ok: false, reason: error.message };
  }
}


/**
 * Um empurrão a meio do prazo.
 *
 * A coisa que mais reduz o ignorar, e a mais barata. Um parceiro
 * que não respondeu ao primeiro email muitas vezes não o viu — não
 * é que não queira a viagem.
 *
 * Um só por oferta: dois lembretes em quinze minutos são spam, e
 * ensinam a ignorar os dois.
 */
/**
 * O lembrete ao cliente, 24 horas antes.
 *
 * Alguém que reservou há três semanas não recebe nada até o
 * motorista aparecer. Esse silêncio é o que gera as chamadas de
 * "confirmam que está tudo bem?" — e a ansiedade de quem chega a
 * um país estrangeiro de madrugada.
 *
 * Também é a última oportunidade de apanhar um erro: uma morada
 * errada, um voo mudado, um número de telefone que já não serve.
 */
/**
 * O motorista chegou.
 *
 * A etapa que mais reduz chamadas: "onde está o meu motorista?"
 * deixa de fazer sentido quando ele já avisou.
 *
 * Curto de propósito. É lido num aeroporto, com bagagem numa mão e
 * o telemóvel na outra — só o que faz falta para o encontrar.
 */
/**
 * A viagem mudou depois de ele a aceitar.
 *
 * O parceiro aceitou uma viagem num dia e num percurso. Se
 * qualquer dos dois mudar, recebe outra coisa — e deve poder
 * devolvê-la sem penalização.
 *
 * O email diz o que era e o que passou a ser. Sem isso ele teria de
 * comparar duas coisas de cabeça, e é assim que se falha uma
 * recolha.
 */
export async function sendRideChanged(partner, booking, mudanca) {
  try {
    const ref = reference(booking);

    const linhas = [];

    if (mudanca?.date_changed) {
      linhas.push({ label: 'Date was', value: longDate(mudanca.old_date) });
      linhas.push({ label: 'Date now', value: longDate(booking.booking_date) });
    }

    if (mudanca?.route_changed) {
      if (mudanca.old_pickup !== booking.pickup) {
        linhas.push({ label: 'Pick-up was', value: mudanca.old_pickup });
        linhas.push({ label: 'Pick-up now', value: booking.pickup });
      }

      if (mudanca.old_dropoff !== booking.dropoff) {
        linhas.push({ label: 'Drop-off was', value: mudanca.old_dropoff });
        linhas.push({ label: 'Drop-off now', value: booking.dropoff });
      }
    }

    const html = wrap({
      preheader: 'A ride you accepted has changed.',
      heading: 'A ride you accepted has changed',

      /**
       * O prazo, logo no início.
       *
       * Sem ele, o email pede uma decisão sem dizer quando — e uma
       * decisão sem prazo adia-se. A viagem ficava parada até
       * alguém reparar, e "alguém reparar" costuma ser o cliente a
       * escrever no dia.
       */
      intro: 'The passenger changed their booking. Here is what moved.\n\n' +
        'You have 2 hours to confirm you can still do it. After that it ' +
        'goes back to the queue and somebody else takes it.',

      blocks: [
        { type: 'facts', items: linhas },

        { type: 'facts', items: [
          { label: 'Pick-up time', value: shortTime(booking.booking_time) },
          { label: 'Passengers', value: booking.passengers },
          { label: 'You receive', value: money(booking.driver_payout, booking.currency) }
        ]},

        { type: 'note', text:
          'Handing this back does not count against you. You accepted one ' +
          'thing and this is another — that is on us, not you. ' +
          'Doing nothing also loses you the ride, so it is worth a look now.' }
      ],

      cta: {
        label: 'Confirm or hand it back',
        url: `${SITE}/drivers#ride-${booking.id}`
      },

      footNote: `Reference ${ref}`
    });

    return await sendOnce({
      // A hora entra na chave: uma segunda alteração deve avisar
      // outra vez.
      key: `ride_changed:${ref}:${Date.now()}`,
      template: 'ride_changed',
      to: partner.email,
      subject: `Changed — confirm within 2 hours — ${longDate(booking.booking_date)}`,
      html
    });
  } catch (error) {
    console.error('sendRideChanged failed:', error);
    return { sent: false, reason: error.message };
  }
}


/**
 * Um agente respondeu a um ticket.
 *
 * Só nos tickets: no modo ao vivo o cliente está no ecrã, e um
 * email a dizer o que ele acabou de ler é ruído.
 *
 * Num ticket é o contrário — ele fechou o separador e foi-se
 * embora. Sem o email, a resposta fica num sítio que ninguém vai
 * ver.
 */
export async function sendTicketReply(chat, mensagem, agente, opcoes) {
  try {
    if (!chat?.email) return { sent: false, reason: 'no-email' };

    const o = opcoes || {};

    /**
     * O primeiro nome, quando o temos.
     *
     * "Hi Bronagh" lê-se como uma pessoa a escrever a outra. "Dear
     * customer" lê-se como um sistema — e um sistema não merece
     * resposta.
     *
     * Só o primeiro: o nome completo numa saudação soa a carta do
     * banco.
     */
    const nome = String(chat.full_name || chat.name || '')
      .trim().split(/\s+/)[0];

    const saudacao = nome && nome.length > 1 ? `Hi ${nome},` : 'Hello,';

    /**
     * Quem escreveu, e de onde.
     *
     * Uma mensagem que vem do motorista não é a mesma coisa que
     * uma resposta do apoio. Dizer de quem é poupa a pergunta — e
     * torna a citação compreensível.
     */
    /**
     * De quem é a mensagem, do ponto de vista de quem a lê.
     *
     * Um parceiro que receba "uma mensagem do seu motorista" fica
     * confuso — o motorista é dele. Para ele, o que interessa
     * saber é que veio do cliente.
     *
     * É a mesma mensagem, lida dos dois lados: o cliente quer
     * saber que veio do motorista, o motorista quer saber que veio
     * do cliente.
     */
    const deQuem = o.toPartner
      ? (o.fromCustomer
          ? 'Please see below, a message from the passenger:'
          : 'We are writing to you about a ride:')

      : (o.fromDriver
          ? 'Please see below, a direct message from your driver:'
          : (o.fromPartner
              ? 'Please see below, a message from the transport company:'
              : (o.outbound
                  ? 'We are writing to you about your booking:'
                  : `${agente?.display_name || 'Our team'} replied to your message:`)));

    const html = wrap({
      preheader: o.toPartner
        ? 'A message about a ride.'
        : (o.outbound ? 'A message about your booking.'
                      : 'We replied to your message.'),

      heading: o.toPartner
        ? 'About a ride'
        : (o.outbound ? 'About your booking' : 'We replied'),

      intro: `${saudacao}\n\n${deQuem}`,

      blocks: [
        {
          type: 'quote',
          text: String(mensagem || '').slice(0, 1500)
        },

        {
          /**
           * Como responder, numa linha.
           *
           * O botão está mesmo acima. Explicá-lo em três frases
           * fazia parecer complicado uma coisa que é um clique.
           */
          type: 'note',
          text: 'You can reply by clicking the button above.'
        }
      ],

      cta: {
        label: 'Reply to this message',

        /**
         * O parceiro responde no portal dele, não no site.
         *
         * São dois sítios diferentes com duas sessões diferentes.
         * Mandar um parceiro para /support é mandá-lo para uma
         * página onde não tem conta.
         */
        url: o.toPartner
          ? `${DRIVERS_URL}/?chat=${chat.id}`
          : `${SITE}/support?chat=${chat.id}`
      },

      /**
       * A assinatura, como numa carta.
       *
       * "The Airportlink Ops team" diz que há pessoas do outro
       * lado. É o que faz a diferença entre um email que se
       * responde e um que se arquiva.
       */
      signOff: 'The Airportlink — Ops team',

      footNote: chat.ticket ? `Reference ${chat.ticket}` : null
    });

    return await sendOnce({
      /**
       * A hora entra na chave.
       *
       * Cada resposta é um email — não é uma confirmação que se
       * manda uma vez. Sem isto, a segunda resposta num ticket
       * nunca saía.
       */
      key: `ticket_reply:${chat.id}:${Date.now()}`,
      template: 'ticket_reply',
      to: chat.email,
      subject: chat.ticket
        ? `Re: your message (${chat.ticket})`
        : 'We replied to your message',
      html
    });
  } catch (error) {
    console.error('sendTicketReply failed:', error);
    return { sent: false, reason: error.message };
  }
}


/**
 * O link para apagar a conta.
 *
 * Um passo a mais entre o pedido e o apagar. É de propósito: um
 * botão que apaga tudo a um clique é um botão que se carrega por
 * engano, e isto não tem volta.
 *
 * E confirma que o email é mesmo da pessoa — sem isso, bastava
 * saber o endereço de alguém para lhe fechar a conta.
 */
/**
 * A palavra-passe mudou.
 *
 * Se não foi ele, é assim que fica a saber — e ainda vai a tempo
 * de recuperar a conta. Uma mudança em silêncio é a última coisa
 * que um dono de conta quer.
 */
/**
 * Confirmar o email, para um parceiro que acabou de se registar.
 *
 * Sem isto, ele regista-se e não recebe nada: o admin.createUser
 * não manda email, ao contrário do signUp. Não consegue entrar, e
 * não entrando não envia os documentos.
 *
 * Era por isso que havia registos e nenhuma conta chegava a ser
 * validada.
 *
 * O email diz o que vem a seguir. "Confirma o teu email" sozinho
 * não motiva ninguém; "confirma e envia três documentos para
 * começares a receber viagens" motiva.
 */
export async function sendVerifyPartner({ email, name, company }) {
  try {
    if (!email) return { sent: false, reason: 'no-email' };

    const primeiro = String(name || '').trim().split(/\s+/)[0];

    const portal = (process.env.DRIVERS_URL
      || 'https://drivers.airportlink.app') + '/';

    const html = wrap({
      preheader: 'Your partner account is ready.',
      heading: 'Your account is ready',

      intro: `${primeiro && primeiro.length > 1 ? 'Hi ' + primeiro + ',' : 'Hello,'}\n\n` +
             `Your Airportlink partner account for ` +
             `${company ? esc(company) : 'your company'} is active. ` +
             'Sign in with the email and password you chose when you ' +
             'registered.',

      blocks: [
        {
          type: 'note',
          text: 'There are three documents to upload before you can ' +
                'start: your operating licence, your insurance, and a ' +
                'driver licence. We check them within one working day, ' +
                'and you receive your first rides as soon as they are ' +
                'approved.'
        }
      ],

      /**
       * O botão vai para a página de entrada, não para um link
       * mágico.
       *
       * Um magiclink expira em uma hora. Quem abre o email à noite
       * e clica de manhã encontra-o morto — e a mensagem do
       * Supabase não explica nada.
       *
       * A página de entrada não expira, e quem se esqueceu da
       * palavra-passe tem lá o "esqueci-me".
       */
      cta: {
        label: 'Sign in to the partner portal',
        url: portal
      },

      signOff: 'The Airportlink — Ops team',

      footNote: 'Forgot your password? There is a link on the sign-in ' +
                'page, and it works right away.'
    });

    return await sendOnce({
      key: `verifypartner:${email}:${new Date().toISOString().slice(0, 10)}`,
      template: 'verify_partner',
      to: email,
      subject: 'Your Airportlink partner account is ready',
      html
    });
  } catch (error) {
    console.error('sendVerifyPartner failed:', error);
    return { sent: false, reason: error.message };
  }
}


/**
 * Confirmar o email, para um cliente.
 *
 * Mais curto do que o do parceiro: não há documentos a enviar nem
 * aprovação a esperar. Um clique e está feito.
 */
export async function sendVerifyCustomer({ email, name }) {
  try {
    if (!email) return { sent: false, reason: 'no-email' };

    const primeiro = String(name || '').trim().split(/\s+/)[0];

    const html = wrap({
      preheader: 'Your account is ready.',
      heading: 'Your account is ready',

      intro: `${primeiro && primeiro.length > 1 ? 'Hi ' + primeiro + ',' : 'Hello,'}\n\n` +
             'Your Airportlink account is active. Sign in with the email ' +
             'and password you chose, and you can book, see your trips, ' +
             'and change a booking without writing to anyone.',

      /**
       * Para a página de entrada, não para um link mágico.
       *
       * Um magiclink expira em uma hora. Esta página não expira, e
       * quem se esqueceu da palavra-passe tem lá o "esqueci-me".
       */
      cta: {
        label: 'Sign in',
        url: `${SITE}/login`
      },

      signOff: 'The Airportlink — Ops team',

      footNote: 'Forgot your password? There is a link on the sign-in page.'
    });

    return await sendOnce({
      key: `verifycustomer:${email}:${new Date().toISOString().slice(0, 10)}`,
      template: 'verify_customer',
      to: email,
      subject: 'Your Airportlink account is ready',
      html
    });
  } catch (error) {
    console.error('sendVerifyCustomer failed:', error);
    return { sent: false, reason: error.message };
  }
}


/**
 * Um link para entrar, a quem ficou de fora.
 *
 * Para os parceiros que se registaram durante o período em que o
 * email de confirmação não saía. A conta existe, o email já foi
 * confirmado à mão — o que falta é uma forma de entrar.
 *
 * O email não menciona o problema. Quem se registou há três
 * semanas já não se lembra do que esperava — e uma explicação
 * sobre uma falha nossa dá-lhe uma razão para duvidar antes de
 * ter começado.
 *
 * Diz o que interessa: a conta existe, define a palavra-passe,
 * e estes são os documentos.
 */
export async function sendPartnerAccessLink({ email, name, company }) {
  try {
    if (!email) return { sent: false, reason: 'no-email' };

    const primeiro = String(name || '').trim().split(/\s+/)[0];

    const portal = (process.env.DRIVERS_URL
      || 'https://drivers.airportlink.app') + '/';

    const html = wrap({
      preheader: 'Set a password and sign in.',
      heading: 'Your account is waiting',

      intro: `${primeiro && primeiro.length > 1 ? 'Hi ' + primeiro + ',' : 'Hello,'}\n\n` +
             `Your Airportlink partner account for ` +
             `${company ? esc(company) : 'your company'} is active and ` +
             'ready to use. Set a password to sign in for the first time.',

      blocks: [
        {
          type: 'note',
          text: 'Once you are in, there are three documents to upload: ' +
                'your operating licence, your insurance, and a driver ' +
                'licence. We check them within one working day, and you ' +
                'receive your first rides as soon as they are approved.'
        }
      ],

      /**
       * Para o "esqueci-me", com o email já preenchido.
       *
       * Não é um link mágico: esses expiram em uma hora, e quem
       * abre o email à noite e clica de manhã encontra-o morto.
       *
       * A página de recuperação não expira. O parceiro escreve o
       * email — já lá está — e recebe um link novo na hora.
       *
       * Este email é só para quem se registou há semanas e nunca
       * recebeu nada. Quem se regista hoje sabe a palavra-passe
       * que acabou de escolher, e recebe outro email.
       */
      cta: {
        label: 'Set my password',
        href: portal + '?forgot=' + encodeURIComponent(email)
      },

      signOff: 'The Airportlink — Ops team',

      footNote: 'The button takes you to the sign-in page, where you can ' +
                'set a password with the email you registered.'
    });

    return await sendOnce({
      key: `access:${email}:${new Date().toISOString().slice(0, 10)}`,
      template: 'partner_access',
      to: email,
      subject: 'Set a password for your Airportlink account',
      html
    });
  } catch (error) {
    console.error('sendPartnerAccessLink failed:', error);
    return { sent: false, reason: error.message };
  }
}


export async function sendPasswordChanged(email) {
  try {
    if (!email) return { sent: false, reason: 'no-email' };

    const html = wrap({
      preheader: 'Your password was changed.',
      heading: 'Your password was changed',

      intro: 'This is a confirmation that the password on your ' +
             'Airportlink account was just changed.',

      blocks: [
        {
          type: 'note',
          tone: 'warn',
          text: 'If this was not you, write to us right away. ' +
                'Someone else may have access to your account.'
        }
      ],

      cta: {
        label: 'Contact support',
        url: `${SITE}/support`
      },

      signOff: 'The Airportlink — Ops team'
    });

    return await sendOnce({
      /**
       * A hora entra na chave.
       *
       * Alguém que mude a password duas vezes no mesmo dia deve
       * receber dois avisos — o segundo é o que diz que algo está
       * errado.
       */
      key: `pwchange:${email}:${Date.now()}`,
      template: 'password_changed',
      to: email,
      subject: 'Your Airportlink password was changed',
      html
    });
  } catch (error) {
    console.error('sendPasswordChanged failed:', error);
    return { sent: false, reason: error.message };
  }
}


export async function sendDeletionConfirm({ email, token }) {
  try {
    if (!email || !token) return { sent: false, reason: 'missing' };

    const link = `${SITE}/api/account/delete-confirm?token=${token}`;

    const html = wrap({
      preheader: 'Confirm you want to close your account.',
      heading: 'Close your account?',

      intro: 'Someone asked to close the Airportlink account for this ' +
             'email address. If it was you, confirm below.',

      blocks: [
        {
          type: 'note',
          tone: 'warn',
          text: 'This cannot be undone. Your name, phone number and ' +
                'addresses are removed. Past bookings are kept without ' +
                'your details, because tax law requires it.'
        },

        {
          type: 'note',
          text: 'If it was not you, ignore this email. Nothing happens ' +
                'without the button below, and the link stops working ' +
                'in 24 hours.'
        }
      ],

      cta: {
        label: 'Yes, close my account',
        url: link
      }
    });

    return await sendOnce({
      /**
       * A hora entra na chave.
       *
       * Um pedido novo depois de um expirado tem de mandar email
       * outra vez. Sem isto, quem deixasse o primeiro expirar não
       * conseguia pedir de novo.
       */
      key: `deletion:${email}:${Date.now()}`,
      template: 'deletion_confirm',
      to: email,
      subject: 'Confirm closing your Airportlink account',
      html
    });
  } catch (error) {
    console.error('sendDeletionConfirm failed:', error);
    return { sent: false, reason: error.message };
  }
}


export async function sendDriverArrived(booking, driver) {
  try {
    const ref = reference(booking);

    const html = wrap({
      preheader: 'Your driver is here.',
      heading: 'Your driver has arrived',

      intro: driver?.name
        ? `${driver.name} is waiting for you.`
        : 'Your driver is waiting for you.',

      blocks: [
        { type: 'facts', items: [
          { label: 'Driver', value: driver?.name },
          { label: 'Phone', value: driver?.phone },
          { label: 'Vehicle', value: driver?.vehicle },
          { label: 'Plate', value: driver?.plate }
        ]},

        /**
         * O código, outra vez.
         *
         * Já foi no lembrete de 24 horas, mas esse email tem um dia
         * e está enterrado na caixa. Aqui está à mão, no momento em
         * que faz falta.
         */
        { type: 'note', text:
          `Your pick-up code is ${booking.pickup_code}. ` +
          'Give it to the driver — it is how we confirm the trip happened.' }
      ],

      footNote: `Reference ${ref}`
    });

    return await sendOnce({
      key: `driver_arrived:${ref}`,
      template: 'driver_arrived',
      to: booking.email,
      bookingId: booking.id,
      subject: 'Your driver is here',
      html
    });
  } catch (error) {
    console.error('sendDriverArrived failed:', error);
    return { sent: false, reason: error.message };
  }
}


export async function sendTripReminder(booking, driver) {
  try {
    const ref = reference(booking);

    /**
     * O motorista, se já estiver escolhido.
     *
     * Quando está, o lembrete vale o dobro: saber o nome e a
     * matrícula antes de chegar tira a parte pior de uma chegada
     * nocturna.
     */
    const temMotorista = Boolean(driver?.name || booking.manual_driver_name);

    const nome = driver?.name || booking.manual_driver_name;
    const telefone = driver?.phone || booking.manual_driver_phone;
    const carro = driver?.vehicle || booking.manual_vehicle;
    const matricula = driver?.plate || booking.manual_vehicle_plate;

    const html = wrap({
      preheader: `Your transfer is tomorrow at ${shortTime(booking.booking_time)}.`,

      heading: 'Your transfer is tomorrow',

      intro: temMotorista
        ? 'Everything is set. Here is who is picking you up and where to find them.'
        : 'Everything is set. We send your driver\'s name and plate the evening ' +
          'before, so keep an eye out for that one.',

      blocks: [
        { type: 'facts', items: [
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) },
          { label: 'Passengers', value: booking.passengers },
          { label: 'Flight', value: booking.flight_number },
          { label: 'Reference', value: ref }
        ]},

        { type: 'route', from: booking.pickup, to: booking.dropoff },

        ...(temMotorista ? [{ type: 'facts', items: [
          { label: 'Driver', value: nome },
          { label: 'Phone', value: telefone },
          { label: 'Vehicle', value: carro },
          { label: 'Plate', value: matricula }
        ]}] : []),

        /**
         * O que fazer se alguma coisa mudou.
         *
         * É a razão de este email existir a 24 horas e não a 2: dá
         * tempo de corrigir. Um voo que mudou descoberto na véspera
         * resolve-se; descoberto no dia, não.
         */
        /**
         * O código de recolha.
         *
         * O motorista pede-o à chegada. Serve para duas coisas: o
         * cliente saber que é o carro certo, e nós termos prova de
         * que a viagem aconteceu.
         *
         * Numa disputa, um código que só o cliente tinha e o
         * motorista escreveu no local é a prova mais forte que
         * existe — porque o testemunho é dele, não nosso.
         */
        ...(booking.pickup_code ? [{ type: 'note', text:
          `Your pick-up code is ${booking.pickup_code}. The driver will ask ` +
          'for it. Do not give it to anyone else.' }] : []),

        { type: 'note', text:
          'Flight changed? Different address? Reply to this email and we ' +
          'move it — there is still time. After midnight tonight it gets ' +
          'harder, and on the day it may not be possible.' }
      ],

      cta: {
        label: 'See your booking',
        url: `${SITE}/myaccount`
      },

      footNote: booking.pickup && booking.pickup.toLowerCase().includes('airport')
        ? 'Your driver tracks the flight. A delay is not a problem — they wait.'
        : null
    });

    return await sendOnce({
      key: `trip_reminder:${ref}`,
      template: 'trip_reminder',
      to: booking.email,
      bookingId: booking.id,
      subject: `Tomorrow at ${shortTime(booking.booking_time)} — your transfer`,
      html
    });
  } catch (error) {
    console.error('sendTripReminder failed:', error);
    return { sent: false, reason: error.message };
  }
}


export async function sendRideOfferReminder(partner, booking, offer) {
  try {
    const ref = reference(booking);
    const minutos = offer?.minutes_left || 5;

    const html = wrap({
      preheader: `${minutos} minutes left on that transfer.`,

      heading: `${minutos} minutes left`,

      intro: 'This one is still yours if you want it. After that it goes ' +
        'to the next partner and you will not see it again.',

      blocks: [
        { type: 'facts', items: [
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) },
          { label: 'Passengers', value: booking.passengers },
          { label: 'You receive', value: money(booking.driver_payout, booking.currency) }
        ]},

        { type: 'route', from: booking.pickup, to: booking.dropoff },

        /**
         * Dizer o que fazer se não quiser.
         *
         * Um parceiro que ignora muitas vezes prefere não recusar
         * formalmente. Dizer-lhe que recusar não custa nada é o que
         * transforma um ignorar num não — que serve toda a gente,
         * porque passa a viagem ao seguinte mais depressa.
         */
        { type: 'note', text:
          'Cannot do this one? Decline it — it costs you nothing and gets ' +
          'it to somebody else faster. Letting it run out is the only thing ' +
          'that counts against you.' }
      ],

      cta: {
        label: 'Take it or pass',
        url: `${SITE}/drivers#ride-${booking.id}`
      },

      footNote: `Reference ${ref}`
    });

    return await sendOnce({
      key: `ride_offer_reminder:${ref}:${partner.id}:${offer?.rank || 1}`,
      template: 'ride_offer_reminder',
      to: partner.email,
      subject: `${minutos} min left — transfer on ${longDate(booking.booking_date)}`,
      html
    });
  } catch (error) {
    console.error('sendRideOfferReminder failed:', error);
    return { ok: false, reason: error.message };
  }
}


export async function sendRideConfirmedToPartner(partner, booking) {
  try {
    const ref = reference(booking);

    const html = wrap({
      preheader: `Ride confirmed for ${longDate(booking.booking_date)}.`,
      heading: 'Ride confirmed',
      intro: 'This transfer is now yours. Here is everything you need.',
      blocks: [
        { type: 'facts', items: [
          { label: 'Reference', value: ref },
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) },
          { label: 'Passengers', value: booking.passengers },
          { label: 'Flight', value: booking.flight_number },
          { label: 'You receive', value: money(booking.driver_payout, booking.currency) }
        ]},
        { type: 'route', from: booking.pickup, to: booking.dropoff },
        { type: 'facts', items: [
          { label: 'Passenger', value: booking.passenger_name || booking.full_name },
          { label: 'Phone', value: booking.passenger_phone || booking.phone },
          { label: 'Notes', value: booking.notes }
        ]},
        { type: 'note', tone: 'warn', html:
          '<strong>You can release this ride until 24 hours before pick-up.</strong><br>' +
          'After that the passenger is counting on you. If something goes wrong, ' +
          'call us rather than leaving them waiting.' }
      ],
      cta: { href: 'https://drivers.airportlink.app', label: 'See my rides' }
    });

    return await sendOnce({
      key: `ride_confirmed:${ref}:${partner.id}`,
      template: 'ride_confirmed',
      to: partner.email,
      subject: `Ride confirmed — ${longDate(booking.booking_date)} at ${shortTime(booking.booking_time)}`,
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] ride confirmed build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/**
 * Um documento a expirar.
 *
 * A chave inclui a data de validade: quando o documento é
 * substituído, a data muda e o aviso do seguinte volta a poder sair.
 */
export async function sendDocumentExpiring(partner, doc, daysLeft) {
  try {
    const expired = daysLeft <= 0;

    const html = wrap({
      preheader: expired
        ? 'A document has expired and your rides are paused.'
        : `${doc.label} expires in ${daysLeft} days.`,
      heading: expired ? 'Your rides are paused' : 'A document is about to expire',
      intro: expired
        ? `${esc(doc.label)} expired on ${longDate(doc.expires_on)}, so we have stopped ` +
          'sending you rides.'
        : `${esc(doc.label)} expires on ${longDate(doc.expires_on)}.`,
      blocks: [
        { type: 'note', tone: expired ? 'bad' : 'warn', html: expired
          ? '<strong>Upload the new document and you are back in immediately.</strong><br>' +
            'Rides you already accepted are not affected &mdash; please still do them.'
          : '<strong>Upload the new one before that date and nothing changes.</strong><br>' +
            'If it expires, rides stop reaching you until it is replaced.' }
      ],
      cta: { href: 'https://drivers.airportlink.app', label: 'Upload it now' }
    });

    return await sendOnce({
      key: `doc_expiry:${doc.id}:${doc.expires_on}:${expired ? 'gone' : daysLeft}`,
      template: expired ? 'document_expired' : 'document_expiring',
      to: partner.email,
      subject: expired
        ? `Rides paused — ${doc.label} has expired`
        : `${doc.label} expires in ${daysLeft} days`,
      html
    });
  } catch (error) {
    console.error('[email] document expiry build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

// ============================================================
// AGÊNCIAS DE VIAGENS
// ============================================================

export async function sendAgentDecision(agent, decision, reason) {
  try {
    const copy = {
      approved: {
        heading: 'Your trade account is open',
        intro: `${esc(agent.agency_name)} is approved. Your rate is applied automatically ` +
          'from now on, on every booking you make while signed in.',
        tone: 'ok',
        note: `<strong>${esc(agent.commission)}% off every transfer.</strong><br>` +
          'You also get a longer cancellation window and one statement a month ' +
          'instead of a card charge per booking.<br><br>' +
          '<strong>Nothing new to learn.</strong> Sign in where you always did &mdash; ' +
          'your account now has an Agency tab with your bookings, your statement and ' +
          'your saved travellers. The trade rate comes off automatically whenever you ' +
          'book while signed in.',
        cta: 'Open my dashboard',
        subject: 'Your Airportlink trade account is open'
      },
      rejected: {
        heading: 'We cannot open a trade account',
        intro: 'We reviewed your application and cannot take it forward as it stands.',
        tone: 'bad',
        note: reason
          ? '<strong>Reason</strong><br>' + esc(reason)
          : '<strong>Reason</strong><br>Please contact us and we will explain.',
        cta: 'Contact us',
        subject: 'About your Airportlink trade application'
      }
    }[decision];

    if (!copy) return { sent: false, reason: 'unknown-decision' };

    const html = wrap({
      preheader: copy.subject,
      heading: copy.heading,
      intro: copy.intro,
      blocks: [
        { type: 'note', tone: copy.tone, html: copy.note },
        decision === 'approved'
          ? { html: 'Your travellers deal with the driver directly &mdash; we never contact ' +
              'your clients about anything except the transfer they are on.' }
          : { html: '' }
      ].filter((b) => b.html !== ''),
      cta: { href: `${SITE}/travelagents`, label: copy.cta }
    });

    return await sendOnce({
      key: `agent_${decision}:${agent.id}`,
      template: `agent_${decision}`,
      to: agent.email,
      subject: copy.subject,
      html
    });
  } catch (error) {
    console.error('[email] agent decision build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

// ============================================================
// VERIFICAÇÃO DE EMAIL
// ============================================================

/**
 * Confirmar o endereço.
 *
 * NOTA: a confirmação de email, a recuperação de password e o aviso
 * de password alterada passaram para o Supabase, configurado com o
 * SMTP do Resend. Gerar os links à mão era trabalho a mais e uma
 * coisa a menos a funcionar sozinha.
 *
 * Isto fica para o caso de um dia se querer um email de boas-vindas
 * com desenho próprio, separado da confirmação. Não é usado.
 */
export async function sendVerifyEmail(person, link, { blocking }) {
  try {
    const html = wrap({
      preheader: 'Confirm your email address.',
      heading: blocking ? 'Confirm your email to continue' : 'Confirm your email',
      intro: blocking
        ? `Almost there, ${esc(person.name || 'there')}. We need to know this address ` +
          'reaches you before your account is active.'
        : `Welcome, ${esc(person.name || 'there')}. Confirming your address means you will ` +
          'get your booking details and receipts without them landing in spam.',
      blocks: [
        blocking
          ? { type: 'note', tone: 'warn', html:
              '<strong>Your account is not active until you confirm.</strong><br>' +
              'The link works for 24 hours. After that, ask for a new one from the sign-in page.' }
          : { type: 'note', tone: 'ok', html:
              '<strong>Your bookings work either way.</strong><br>' +
              'Confirming just makes sure our emails reach you. The link works for 24 hours.' },
        { html: 'If you did not create an account with us, ignore this email. ' +
          'Nothing happens until someone clicks the link.' }
      ],
      cta: { href: link, label: 'Confirm my email' },
      footNote: 'Button not working? Copy this address into your browser:<br>' +
        `<span style="word-break:break-all;color:#0F766E">${esc(link)}</span>`
    });

    return await sendOnce({
      key: `verify:${person.email}:${Date.now().toString().slice(0, 8)}`,
      template: 'verify_email',
      to: person.email,
      subject: blocking ? 'Confirm your email to activate your account' : 'Confirm your email',
      html
    });
  } catch (error) {
    console.error('[email] verify build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

// ============================================================
// PRÉ-VISUALIZAÇÃO
// ============================================================

/**
 * Todos os modelos, para um endereço, com dados inventados.
 *
 * Existe porque rever emails um a um obriga a provocar cada
 * acontecimento: pagar, cancelar, deixar uma cobrança falhar. Uma
 * revisão de texto não devia custar isso.
 *
 * Ignora a proteção contra duplicados de propósito — quer-se poder
 * correr isto vinte vezes seguidas enquanto se acerta uma frase.
 */
export async function previewAll(to) {
  const booking = {
    id: '00000000-0000-0000-0000-000000000000',
    booking_reference: 'AL-PREVIEW',
    booking_date: new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10),
    booking_time: '08:05:00',
    pickup: 'Porto Airport (OPO), Vila Nova da Telha, Portugal',
    dropoff: 'Avenida dos Aliados, Porto, Portugal',
    passengers: 3,
    flight_number: 'TP1949',
    price: 68.4,
    currency: 'EUR',
    driver_payout: 48,
    full_name: 'Ricardo Machado',
    email: to,
    passenger_email: to,
    passenger_name: 'Ricardo Machado',
    passenger_phone: '+351 912 345 678',
    notes: 'One large suitcase and a child seat.'
  };

  const partner = {
    id: '00000000-0000-0000-0000-000000000001',
    email: to,
    legal_name: 'Porto Executive Transfers Lda',
    contact_name: 'Ricardo'
  };

  const agent = {
    id: '00000000-0000-0000-0000-000000000002',
    email: to,
    agency_name: 'Douro Travel',
    commission: 12
  };

  const driver = { full_name: 'Miguel Ferreira', phone: '+351 913 000 111' };
  const vehicle = { make: 'Mercedes-Benz', model: 'V-Class', plate: 'AA-00-BB' };

  const chargeAt = new Date(Date.now() + 7 * 864e5).toISOString();

  const jobs = [
    ['booking_confirmed', () => sendBookingConfirmation(booking)],
    ['card_saved',        () => sendCardSaved(booking, chargeAt)],
    ['charge_succeeded',  () => sendChargeSucceeded(booking)],
    ['charge_failed',     () => sendChargeFailed(booking, { attempt: 1, willRetry: true })],
    ['charge_abandoned',  () => sendChargeFailed(booking, { attempt: 3, willRetry: false })],
    ['cancelled_refund',  () => sendCancellation(booking, { refunded: true, amount: 68.4 })],
    ['cancelled_free',    () => sendCancellation(booking, { refunded: false, amount: 0 })],
    ['driver_details',    () => sendDriverDetails(booking, driver, vehicle)],
    ['partner_received',  () => sendPartnerApplicationReceived(partner)],
    ['partner_verified',  () => sendPartnerDecision(partner, 'verified')],
    ['partner_approved',  () => sendPartnerDecision(partner, 'approved')],
    ['partner_rejected',  () => sendPartnerDecision(partner, 'rejected', 'The insurance certificate had expired.')],
    ['ride_confirmed',    () => sendRideConfirmedToPartner(partner, booking)],
    ['document_expiring', () => sendDocumentExpiring(partner, {
        id: 'preview', label: 'Insurance',
        expires_on: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)
      }, 7)],
    ['document_expired',  () => sendDocumentExpiring(partner, {
        id: 'preview2', label: 'Passenger transport licence',
        expires_on: new Date(Date.now() - 864e5).toISOString().slice(0, 10)
      }, 0)],
    ['agent_approved',    () => sendAgentDecision(agent, 'approved')],
    ['agent_rejected',    () => sendAgentDecision(agent, 'rejected', 'We could not verify the agency registration.')],
    ['verify_blocking',   () => sendVerifyEmail({ email: to, name: 'Ricardo' },
                                `${SITE}/login?preview=1`, { blocking: true })],
    ['verify_soft',       () => sendVerifyEmail({ email: to, name: 'Ricardo' },
                                `${SITE}/login?preview=1`, { blocking: false })],
    ['partner_statement', () => sendPartnerStatement(
        { ...partner, payout_iban: 'PT50000201231234567890154' },
        new Date().toISOString().slice(0, 7),
        [booking, { ...booking, booking_reference: 'AL-PREV2', driver_payout: 62 }],
        110)],
    ['agent_statement',   () => sendAgentStatement(
        agent,
        new Date().toISOString().slice(0, 7),
        [{ ...booking, agent_reference: 'PROC-4417' },
         { ...booking, booking_reference: 'AL-PREV2', agent_reference: 'PROC-4418' }],
        { paid: 120.4, gross: 136.8 })]
  ];

  const results = [];

  for (const [name, run] of jobs) {
    try {
      // Sem chave de idempotência: uma pré-visualização tem de poder
      // correr vinte vezes seguidas enquanto se acerta uma frase.
      previewMode = true;
      const r = await run();
      results.push({ template: name, sent: r.sent, reason: r.reason || null });
    } catch (error) {
      results.push({ template: name, sent: false, reason: error.message });
    } finally {
      previewMode = false;
    }

    // O Resend limita a dois por segundo no plano gratuito. Sem esta
    // pausa, metade dos emails vinha de volta com "rate limited".
    await new Promise((r) => setTimeout(r, 600));
  }

  return results;
}

// ============================================================
// EXTRATOS MENSAIS
// ============================================================

/** Uma tabela de linhas, para os extratos. */
function statementTable(headers, rows, alignRight) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="border-collapse:collapse;margin:14px 0;font:400 13px/1.5 Arial,sans-serif">
    <tr>${headers.map((h, i) => `<th style="padding:9px 10px;text-align:${
      alignRight.includes(i) ? 'right' : 'left'};border-bottom:2px solid #E2E5E0;
      font:600 10px/1.4 Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;
      color:#606A7B">${esc(h)}</th>`).join('')}</tr>
    ${rows.map((r) => `<tr>${r.map((c, i) => `<td style="padding:9px 10px;
      text-align:${alignRight.includes(i) ? 'right' : 'left'};
      border-bottom:1px solid #EFF1EE;color:#141A28">${c}</td>`).join('')}</tr>`).join('')}
  </table>`;
}

/**
 * O extrato do parceiro.
 *
 * É o email mais importante do mês para ele: é como sabe quanto vai
 * receber. Se não sair, ele escreve — e escrever a quinze parceiros
 * é a diferença entre uma manhã e um dia.
 */
export async function sendPartnerStatement(partner, month, rides, total) {
  try {
    const label = new Date(month + '-01T12:00:00')
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const rows = rides.slice(0, 60).map((r) => [
      esc(r.booking_reference || r.booking_id || ''),
      esc(String(r.booking_date || '').slice(5)) + ' ' +
        esc(String(r.booking_time || '').slice(0, 5)),
      esc(String(r.pickup || '').slice(0, 26)),
      `<strong>${esc(money(r.driver_payout, r.currency))}</strong>`
    ]);

    const html = wrap({
      preheader: `${label}: ${rides.length} rides, ${money(total, 'EUR')}.`,
      heading: `Your ${label} statement`,
      intro: `You completed ${rides.length} transfer${rides.length === 1 ? '' : 's'} ` +
        `in ${label}.`,
      blocks: [
        { type: 'facts', items: [
          { label: 'Rides completed', value: rides.length },
          { label: 'Total due to you', value: money(total, 'EUR') },
          { label: 'Paid to', value: partner.payout_iban
            ? '••••' + String(partner.payout_iban).slice(-4)
            : null }
        ]},

        rides.length
          ? { html: statementTable(
              ['Reference', 'When', 'From', 'You receive'], rows, [3]) }
          : { html: 'No completed rides this month.' },

        rides.length > 60
          ? { html: `Showing the first 60 of ${rides.length}. ` +
              'The full list is in your dashboard.' }
          : { html: '' },

        { type: 'note', tone: 'ok', html:
          '<strong>The fee on each ride is what reaches you.</strong><br>' +
          'We take no commission on top of it. Payment goes to the account on your ' +
          'payouts page within the first working days of the month.' },

        partner.payout_iban
          ? { html: '' }
          : { type: 'note', tone: 'bad', html:
              '<strong>We have no account on file for you.</strong><br>' +
              'Add your payout details in the dashboard or we cannot pay this.' },

        { html: 'Something not right? Reply to this email with the reference and we ' +
          'will look at it before the payment run.' }
      ].filter((b) => b.html !== ''),
      cta: { href: 'https://drivers.airportlink.app', label: 'Open my dashboard' }
    });

    return await sendOnce({
      key: `partner_statement:${partner.id}:${month}`,
      template: 'partner_statement',
      to: partner.email,
      subject: `${label} statement — ${money(total, 'EUR')} due to you`,
      html
    });
  } catch (error) {
    console.error('[email] partner statement build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/**
 * O extrato da agência.
 *
 * Não é uma fatura a pagar: cada reserva já foi cobrada ao cartão no
 * momento. É um resumo para a contabilidade, e diz isso claramente —
 * senão alguém paga duas vezes.
 */
export async function sendAgentStatement(agent, month, bookings, totals) {
  try {
    const label = new Date(month + '-01T12:00:00')
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const rows = bookings.slice(0, 60).map((b) => [
      esc(reference(b)) +
        (b.agent_reference
          ? `<br><span style="color:#606A7B;font-size:11px">${esc(b.agent_reference)}</span>`
          : ''),
      esc(String(b.booking_date || '').slice(5)),
      esc(String(b.passenger_name || '').slice(0, 22)),
      `<strong>${esc(money(b.price, b.currency))}</strong>`
    ]);

    const html = wrap({
      preheader: `${label}: ${bookings.length} transfers, ${money(totals.paid, 'EUR')}.`,
      heading: `Your ${label} statement`,
      intro: `${esc(agent.agency_name || 'Your agency')} booked ${bookings.length} ` +
        `transfer${bookings.length === 1 ? '' : 's'} in ${label}.`,
      blocks: [
        { type: 'facts', items: [
          { label: 'Transfers', value: bookings.length },
          { label: 'You paid', value: money(totals.paid, 'EUR') },
          { label: 'Public price', value: money(totals.gross, 'EUR') },
          { label: 'You saved', value: money(totals.gross - totals.paid, 'EUR') },
          { label: 'Your rate', value: `${agent.commission || 12}%` }
        ]},

        bookings.length
          ? { html: statementTable(
              ['Reference', 'Date', 'Passenger', 'You paid'], rows, [3]) }
          : { html: 'No transfers booked this month.' },

        // A confusão mais provável, dita à partida.
        { type: 'note', tone: 'ok', html:
          '<strong>Nothing to pay.</strong><br>' +
          'Each transfer was charged to your card when you booked it. This is a summary ' +
          'for your records, not an invoice.' },

        { html: 'The full list, with the option to download it as a spreadsheet, ' +
          'is in the Agency tab of your account.' }
      ],
      cta: { href: `${SITE}/myaccount`, label: 'Open my account' }
    });

    return await sendOnce({
      key: `agent_statement:${agent.id}:${month}`,
      template: 'agent_statement',
      to: agent.email,
      subject: `${label} statement — ${bookings.length} transfer${bookings.length === 1 ? '' : 's'}`,
      html
    });
  } catch (error) {
    console.error('[email] agent statement build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}
