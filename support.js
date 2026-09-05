import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
// O cliente e as funções de identidade vivem no supabaseclient.js.
// Antes esse ficheiro era um segundo servidor com uma cópia antiga
// da lógica; agora é o módulo partilhado que o nome sempre prometeu.
import {
  supabase,
  getUserFromRequest,
  getApprovedAgent,
  requireAdmin,
  checkConnection,
  DEFAULT_AGENT_COMMISSION
} from './supabaseclient.js';
import {
  initEmail,
  sendBookingConfirmation,
  sendCardSaved,
  sendChargeSucceeded,
  sendChargeFailed,
  sendCancellation,
  sendDriverDetails,
  sendAgentDecision,
  sendDocumentExpiring,
  sendPartnerApplicationReceived,
  sendPartnerDecision,
  sendRideConfirmedToPartner,
  previewAll,
  sendPartnerStatement,
  sendAgentStatement,
  notifyOps
} from './emailService.js';
import { createPartnerRoutes } from './partners.js';

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required');
if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is required');
if (!process.env.GOOGLE_SERVER_API_KEY) throw new Error('GOOGLE_SERVER_API_KEY is required');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
initEmail(supabase);

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.airportlink.app';
const FREE_CANCELLATION_HOURS = Number(process.env.FREE_CANCELLATION_HOURS || 24);

// Os agentes têm uma janela mais generosa. É uma das condições do
// programa de parceria e não custa dinheiro.
const AGENT_CANCELLATION_HOURS = Number(process.env.AGENT_CANCELLATION_HOURS || 12);

const FX_MARGIN = Number(process.env.FX_MARGIN || 0.02);

const FALLBACK_RATES = {
  EUR: 1.0,
  USD: 1.168,
  GBP: 0.856,
  BRL: 6.02,
  CAD: 1.608,
  AUD: 1.639,
  CHF: 0.936,
  JPY: 185.7,
  NOK: 10.95,
  SEK: 11.04,
  DKK: 7.46,
  NZD: 1.953,
  MXN: 19.76,
  ZAR: 18.8,
  AED: 4.29,
  SAR: 4.38
};

const SUPPORTED_CURRENCIES = Object.keys(FALLBACK_RATES);
const USD_PEGS = { AED: 3.6725, SAR: 3.75 };
const ZERO_DECIMAL_CURRENCIES = ['JPY'];

let ratesCache = {
  rates: { ...FALLBACK_RATES },
  fetchedAt: 0,
  source: 'fallback'
};

const RATES_TTL_MS = 6 * 60 * 60 * 1000;

async function loadExchangeRates() {
  if (Date.now() - ratesCache.fetchedAt < RATES_TTL_MS) {
    return ratesCache;
  }

  try {
    const response = await fetch(
      'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
      { signal: AbortSignal.timeout(8000) }
    );

    if (!response.ok) {
      throw new Error(`ECB HTTP ${response.status}`);
    }

    const xml = await response.text();
    const parsed = { EUR: 1.0 };
    const pattern = /currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g;

    let match;
    while ((match = pattern.exec(xml)) !== null) {
      parsed[match[1]] = parseFloat(match[2]);
    }

    if (!parsed.USD) {
      throw new Error('ECB response missing USD');
    }

    for (const [code, peg] of Object.entries(USD_PEGS)) {
      parsed[code] = parsed.USD * peg;
    }

    const rates = {};
    for (const code of SUPPORTED_CURRENCIES) {
      rates[code] = parsed[code] || FALLBACK_RATES[code];
    }

    ratesCache = {
      rates,
      fetchedAt: Date.now(),
      source: 'ecb'
    };

    console.log('Exchange rates updated from ECB');
  } catch (error) {
    console.error('ECB rates error, keeping previous values:', error.message);

    ratesCache = {
      rates: ratesCache.rates,
      fetchedAt: Date.now() - RATES_TTL_MS + 15 * 60 * 1000,
      source: ratesCache.source === 'ecb' ? 'ecb-stale' : 'fallback'
    };
  }

  return ratesCache;
}

function convertFromEUR(amountEUR, currency, rates) {
  const rate = rates[currency];

  if (!rate) {
    return null;
  }

  return amountEUR * rate * (currency === 'EUR' ? 1 : 1 + FX_MARGIN);
}

/**
 * As classes de veículo, com o multiplicador de cada uma.
 *
 * A classe vem do browser mas o multiplicador vem DAQUI: quem
 * manipular o pedido escolhe no máximo um carro maior, nunca um
 * preço menor.
 */
/**
 * As classes, com o multiplicador de Portugal.
 *
 * As combinações estavam ABAIXO do custo das viaturas que enviam:
 * uma Van+Sedan é literalmente uma van (1,70) mais um sedan (1,00),
 * ou seja 2,70 — e cobrava-se 2,50. Duas vans são 3,40 e cobrava-se
 * 3,20. Cada uma dessas reservas dava prejuízo garantido.
 *
 * Agora ficam 5-6% acima da soma das partes, para pagar o segundo
 * motorista, o segundo regresso vazio e a coordenação entre viaturas.
 * Continua muito abaixo dos 24% que a Transfeero cobra em Espanha.
 */
const VEHICLE_CLASSES = {
  sedan:     { id: 'sedan',     mult: 1.0,  seats: 3 },
  premium:   { id: 'premium',   mult: 1.47, seats: 4 },
  van:       { id: 'van',       mult: 1.7,  seats: 8 },
  van_sedan: { id: 'van_sedan', mult: 2.85, seats: 12 },
  two_vans:  { id: 'two_vans',  mult: 3.6,  seats: 16 }
};

/**
 * A classe pedida, ou a mais barata em que o grupo cabe.
 *
 * Também é a rede de segurança: 6 pessoas num "sedan" sobem para a
 * van — nunca se vende um carro onde o grupo não cabe.
 */
function resolveVehicleClass(requested, passengers) {
  const pax = Math.max(1, Math.min(16, parseInt(passengers || '1', 10) || 1));
  const wanted = VEHICLE_CLASSES[String(requested || '').toLowerCase()];

  if (wanted && pax <= wanted.seats) return wanted;

  for (const c of ['sedan', 'van', 'van_sedan', 'two_vans']) {
    if (pax <= VEHICLE_CLASSES[c].seats) return VEHICLE_CLASSES[c];
  }
  return VEHICLE_CLASSES.two_vans;
}

function toStripeAmount(amount, currencyCode) {
  const code = (currencyCode || 'EUR').toUpperCase();

  return ZERO_DECIMAL_CURRENCIES.includes(code)
    ? Math.round(amount)
    : Math.round(amount * 100);
}

// Inverso do toStripeAmount: converte o que vem do Stripe (unidades
// menores) para a unidade que guardamos na base de dados.
function fromStripeAmount(amount, currencyCode) {
  const code = (currencyCode || 'EUR').toUpperCase();

  return ZERO_DECIMAL_CURRENCIES.includes(code)
    ? Number(amount)
    : Number(amount) / 100;
}

/**
 * As zonas de Portugal, cada uma com a sua tabela.
 *
 * Vêm do estudo da concorrência de 28/08/2026 (19 rotas medidas,
 * km confirmados no site deles), a 2% abaixo:
 *   Faro erro 1,6% · Porto 4,4% · Lisboa 6,8%.
 * O fallback é a média das três — serve Madeira e Açores até serem
 * medidos. Cada cidade tem MESMO tabela própria: o Porto custa 51%
 * mais por km do que Lisboa; uma fórmula nacional falhava sempre.
 */
const PT_ZONES = {
  lisbon: { base: 23.23, perKm: 0.909,
    words: ['lisbon', 'lisboa', 'cascais', 'sintra', 'estoril', 'setubal',
            'setúbal', 'ericeira', 'obidos', 'óbidos', 'nazare', 'nazaré',
            'evora', 'évora', 'fatima', 'fátima', 'peniche', 'sesimbra'] },
  porto:  { base: 7.14, perKm: 1.401,
    words: ['porto', 'oporto', 'matosinhos', 'gaia', 'braga', 'guimaraes',
            'guimarães', 'aveiro', 'espinho', 'viana do castelo', 'povoa',
            'póvoa', 'coimbra'] },
  faro:   { base: 4.45, perKm: 1.116,
    words: ['faro', 'albufeira', 'lagos', 'portimao', 'portimão', 'vilamoura',
            'quarteira', 'tavira', 'sagres', 'carvoeiro', 'alvor', 'olhao',
            'olhão', 'monte gordo', 'algarve', 'almancil', 'quinta do lago'] }
};

const PT_FALLBACK = { base: 11.61, perKm: 1.142 };

/**
 * Espanha — estudo de 29/08/2026.
 *
 * Madrid e Barcelona têm tabela própria. Málaga serve de fórmula
 * para toda a restante Espanha: das três, é a que tem o preço por km
 * mais moderado, o que a torna a base segura para aeroportos ainda
 * não medidos.
 *
 * Calibradas para NUNCA ficarem acima deles. O desvio real vai de 0
 * a -10% conforme a rota: a fórmula deles não é uma reta perfeita, e
 * uma reta única não consegue seguir-lhes o preço a menos de 5% em
 * todas as distâncias ao mesmo tempo.
 *
 * Duas coisas que Portugal não tinha:
 *  - HÁ suplemento de aeroporto (~10%), já embutido na base.
 *  - As classes grandes custam mais: eles cobram 3,39x e 3,80x onde
 *    nós cobrávamos 2,50x e 3,20x. Duas viaturas são duas viaturas.
 */
const ES_ZONES = {
  madrid: { base: 39.87, perKm: 1.3316, premium: 1.516,
    van: 1.508, van_sedan: 3.737, two_vans: 4.189,
    words: ['madrid', 'barajas', 'alcala', 'alcalá', 'toledo', 'segovia',
            'aranjuez', 'avila', 'ávila', 'chinchon', 'chinchón'] },
  barcelona: { base: 29.04, perKm: 1.3106, premium: 1.426,
    van: 1.455, van_sedan: 3.605, two_vans: 4.041,
    words: ['barcelona', 'prat', 'rambla', 'sitges', 'girona', 'lloret',
            'tossa', 'andorra', 'figueres', 'tarragona', 'salou', 'reus'] }
};

/** Málaga: a tabela dela serve toda a Espanha que não seja Madrid nem
 *  Barcelona, incluindo a própria Málaga. */
const ES_FALLBACK = { base: 39.76, perKm: 1.2843, premium: 1.530,
  van: 1.484, van_sedan: 3.678, two_vans: 4.123 };

/**
 * As cidades espanholas que não são Madrid nem Barcelona.
 *
 * Não têm tabela própria — usam a de Málaga. Servem só para o site
 * reconhecer que a rota é em Espanha quando o país não vem escrito
 * na morada, que é quase sempre.
 */
const ES_WORDS = [
  'malaga', 'málaga', 'torremolinos', 'marbella', 'nerja', 'granada',
  'fuengirola', 'benalmadena', 'benalmádena', 'estepona', 'ronda', 'mijas',
  'puerto banus', 'puerto banús', 'sevilla', 'seville', 'valencia', 'alicante',
  'benidorm', 'torrevieja', 'murcia', 'palma', 'mallorca', 'ibiza', 'menorca',
  'tenerife', 'gran canaria', 'las palmas', 'lanzarote', 'fuerteventura',
  'bilbao', 'san sebastian', 'san sebastián', 'santander', 'vigo', 'coruna',
  'coruña', 'santiago de compostela', 'zaragoza', 'almeria', 'almería',
  'jerez', 'cadiz', 'cádiz', 'cordoba', 'córdoba', 'oviedo', 'gijon', 'gijón'
];

/**
 * Em Espanha cada zona tem os seus multiplicadores.
 *
 * Estão calibrados para as classes acima do Sedan ficarem entre 0% e
 * 10% ACIMA da Transfeero — o Premium a partir de 10%. O cálculo
 * parte do ponto onde o nosso Sedan mais desce face ao deles, para
 * que nem a rota mais desfavorável caia abaixo do preço deles.
 */

/**
 * Rotas com preço próprio.
 *
 * O Sitges custa-lhes o dobro do que a fórmula de Barcelona prevê —
 * destino de resort, procura alta. Uma fórmula não apanha isto, e
 * publicá-lo a metade do preço deles seria vender a perder.
 */
const ES_ROUTE_PRICES = {
  'barcelona|sitges': { sedan: 128.56, premium: 175.57 }
};

/**
 * Itália — estudo de 02/09/2026.
 *
 * Roma é a base nacional: seis rotas medidas de 8 a 234 km.
 * O Sedan fica sempre ABAIXO deles, o Premium sempre ACIMA.
 *
 * Duas coisas que Portugal e Espanha não tinham:
 *
 * 1. Em quatro cidades — Veneza, Florença, Milão e Cagliari — eles
 *    NÃO oferecem sedan de todo. É decisão comercial: a procura
 *    permite cobrar premium a toda a gente. O nosso sedan sai a 15%
 *    abaixo do premium deles, e é a nossa maior vantagem no país:
 *    em Florença são 36 euros de diferença numa rota de 40 km.
 *
 * 2. O Premium tem FÓRMULA PRÓPRIA, não um multiplicador.
 *    O sedan e o premium deles não crescem ao mesmo ritmo — em Roma
 *    o rácio vai de 1,22 aos 8 km a 1,09 aos 234. Um multiplicador
 *    fixo é a média de duas curvas diferentes e falha nas pontas: ou
 *    ficávamos 38% acima nas longas, ou abaixo deles nas curtas.
 *
 * Cada cidade tem MESMO tabela própria. Florença cobra 2,74 €/km no
 * premium contra 1,64 de Roma — 67% acima. Uma fórmula nacional
 * falharia por larga margem.
 */
const IT_ZONES = {
  /**
   * Roma: 46,25 + 1,51/km, e não os 53,65 + 1,49 da regressão.
   *
   * A tabela deles em Roma NÃO é uma reta: o preço por km vai de
   * 7,99 aos 8 km a 1,80 aos 234. Uma reta por mínimos quadrados
   * ficava 2,7% ACIMA deles nas curtas, que é o oposto do que se
   * quer.
   *
   * Esta é escolhida para nunca passar de -5%, custe o que custar
   * nas médias — aos 34 km chega a -15%. É o preço de garantir que
   * não somos mais caros em rota nenhuma.
   */
  rome: { base: 46.25, perKm: 1.5100,
    premiumBase: 76.75, premiumKm: 1.9500,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['rome', 'roma', 'fiumicino', 'ciampino', 'ostia', 'civitavecchia',
            'frascati', 'tivoli', 'anzio', 'castel gandolfo', 'orvieto',
            'viterbo', 'latina'] },

  bologna: { base: 65.03, perKm: 1.6083,
    premiumBase: 85.25, premiumKm: 2.1050,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['bologna', 'bolonha', 'modena', 'ferrara', 'rimini', 'parma',
            'ravenna', 'riccione', 'cesena', 'forli', 'forlì'] },

  naples: { base: 58.96, perKm: 1.5028,
    premiumBase: 81.25, premiumKm: 2.1300,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['naples', 'napoli', 'nápoles', 'pompeii', 'pompei', 'sorrento',
            'salerno', 'amalfi', 'positano', 'ravello', 'caserta',
            'herculaneum', 'ercolano', 'vesuvio'] },

  palermo: { base: 43.24, perKm: 1.2041,
    premiumBase: 71.75, premiumKm: 1.9800,
    van: 1.586, van_sedan: 3.462, two_vans: 3.978,
    words: ['palermo', 'cefalu', 'cefalù', 'trapani', 'agrigento', 'mondello',
            'monreale', 'marsala', 'erice', 'sciacca'] },

  // ---------- as quatro sem sedan do lado deles ----------

  venice: { base: 58.93, perKm: 1.5475,
    premiumBase: 71.50, premiumKm: 1.8550,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['venice', 'venezia', 'veneza', 'mestre', 'piazzale roma', 'padua',
            'padova', 'verona', 'treviso', 'vicenza', 'lido di jesolo',
            'jesolo'] },

  florence: { base: 114.54, perKm: 2.3303,
    premiumBase: 138.25, premiumKm: 2.7900,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['florence', 'firenze', 'florença', 'fiesole', 'siena', 'pisa',
            'lucca', 'san gimignano', 'arezzo', 'chianti', 'montepulciano',
            'cortona', 'volterra'] },

  milan: { base: 64.86, perKm: 1.5628,
    premiumBase: 89.25, premiumKm: 1.8150,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['milan', 'milano', 'milão', 'malpensa', 'linate', 'bergamo',
            'como', 'lake como', 'lago di como', 'turin', 'torino', 'brescia',
            'monza', 'varese', 'stresa', 'maggiore'] },

  cagliari: { base: 38.97, perKm: 1.6212,
    premiumBase: 46.75, premiumKm: 1.9500,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['cagliari', 'villasimius', 'chia', 'oristano', 'pula', 'costa rei',
            'sardinia', 'sardegna', 'olbia', 'alghero', 'costa smeralda'] }
};

/**
 * Roma serve toda a Itália não medida.
 *
 * AVISO: Roma é cidade cara. Palermo mostra que o sul corre cerca de
 * 30% mais barato. Abrir Bari, Catânia ou Lamezia com esta tabela
 * põe-nos acima do mercado — essas merecem estudo próprio.
 */
const IT_FALLBACK = { base: 46.25, perKm: 1.5100,
  premiumBase: 76.75, premiumKm: 1.9500,
  van: 1.304, van_sedan: 3.462, two_vans: 3.846 };

/**
 * Cidades italianas sem tabela própria.
 *
 * Servem só para o site reconhecer que a rota é em Itália quando o
 * país não vem escrito na morada, que é quase sempre.
 */
const IT_WORDS = [
  'italy', 'italia', 'itália', 'genoa', 'genova', 'bari', 'catania',
  'taormina', 'siracusa', 'syracuse', 'lamezia', 'tropea', 'brindisi',
  'lecce', 'alberobello', 'matera', 'perugia', 'assisi', 'ancona',
  'trieste', 'udine', 'bolzano', 'trento', 'garda', 'sirmione',
  'cinque terre', 'la spezia', 'portofino', 'sanremo', 'capri', 'ischia',
  'elba', 'livorno', 'grosseto', 'pescara'
];

/** A zona, pelo texto das moradas. Palavra inteira sempre: "aeroporto"
 *  contém "porto", e sem isso "Aeroporto de Faro" caía na zona do Porto. */
function detectZone(zones, fallback, pickupText, dropoffText) {
  for (const text of [pickupText, dropoffText]) {
    const t = String(text || '').toLowerCase();
    for (const z of Object.values(zones)) {
      if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return z;
    }
  }
  return fallback;
}

/** Espanha ou Portugal, pelo texto das moradas. */
function detectCountry(pickupText, dropoffText) {
  const t = (String(pickupText || '') + ' ' + String(dropoffText || '')).toLowerCase();

  if (/\b(spain|espa(n|ñ)a|espanha)\b/.test(t)) return 'ES';
  if (/\b(portugal)\b/.test(t)) return 'PT';
  if (/\b(italy|italia|itália)\b/.test(t)) return 'IT';

  // Sem o país escrito, decide-se pelas cidades conhecidas.
  //
  // A Itália vem ANTES de Espanha por causa de nomes repetidos:
  // Verona e Como existem nas duas listas de palavras, e Sardenha
  // tem cidades com nome parecido a espanholas. Sem esta ordem, uma
  // rota de Milão para Como caía na tabela de Barcelona.
  for (const z of Object.values(IT_ZONES)) {
    if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return 'IT';
  }
  if (IT_WORDS.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return 'IT';

  for (const z of Object.values(ES_ZONES)) {
    if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return 'ES';
  }
  if (ES_WORDS.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return 'ES';
  for (const z of Object.values(PT_ZONES)) {
    if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return 'PT';
  }
  return null;
}

/** Uma rota com preço combinado, se existir. */
function routeOverride(zoneName, dropoffText) {
  const t = String(dropoffText || '').toLowerCase();
  for (const [key, price] of Object.entries(ES_ROUTE_PRICES)) {
    const [zone, dest] = key.split('|');
    if (zone === zoneName && new RegExp('\\b' + dest + '\\b').test(t)) return price;
  }
  return null;
}

function computePriceEUR(distanceKm, passengers, isPortugalRoute, opts) {
  const o = opts || {};
  const vehicle = resolveVehicleClass(o.vehicleClass, passengers);

  const country = detectCountry(o.pickupText, o.dropoffText) ||
    (isPortugalRoute ? 'PT' : null);

  if (country === 'ES') {
    let zoneName = null;
    for (const [name, z] of Object.entries(ES_ZONES)) {
      const t = (String(o.pickupText || '') + ' ' + String(o.dropoffText || '')).toLowerCase();
      if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) { zoneName = name; break; }
    }

    const zone = zoneName ? ES_ZONES[zoneName] : ES_FALLBACK;

    // Rota com preço combinado ganha à fórmula.
    const fixed = zoneName ? routeOverride(zoneName, o.dropoffText) : null;
    if (fixed) {
      if (vehicle.id === 'sedan') return fixed.sedan;
      if (vehicle.id === 'premium') return fixed.premium;
      return fixed.sedan * (zone[vehicle.id] || vehicle.mult);
    }

    const mult = vehicle.id === 'sedan' ? 1 : (zone[vehicle.id] || vehicle.mult);

    return Math.max(24, (zone.base + distanceKm * zone.perKm) * mult);
  }

  if (country === 'IT') {
    let zoneName = null;
    const t = (String(o.pickupText || '') + ' ' + String(o.dropoffText || '')).toLowerCase();

    for (const [name, z] of Object.entries(IT_ZONES)) {
      if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) { zoneName = name; break; }
    }

    const zone = zoneName ? IT_ZONES[zoneName] : IT_FALLBACK;
    const sedan = zone.base + distanceKm * zone.perKm;

    // O premium tem reta própria: o sedan e o premium deles não
    // crescem ao mesmo ritmo, e um multiplicador falharia nas
    // pontas.
    if (vehicle.id === 'premium') {
      return Math.max(24, zone.premiumBase + distanceKm * zone.premiumKm);
    }

    if (vehicle.id === 'sedan') return Math.max(24, sedan);

    // As classes maiores continuam a sair do sedan.
    return Math.max(24, sedan * (zone[vehicle.id] || vehicle.mult));
  }

  if (country === 'PT') {
    const zone = detectZone(PT_ZONES, PT_FALLBACK, o.pickupText, o.dropoffText);
    return Math.max(24, (zone.base + distanceKm * zone.perKm) * vehicle.mult);
  }

  // Sem país estudado, a fórmula antiga.
  return Math.max(25, (20 + distanceKm * 3.5) * 1.3 * vehicle.mult);
}

/**
 * O aeroporto da recolha, a partir do texto que o cliente escreveu.
 *
 * É o que liga uma reserva aos parceiros que a podem fazer, por isso
 * é calculado aqui e guardado — não adivinhado depois. Procura o
 * código IATA como palavra isolada, e só depois o nome da cidade,
 * porque "Porto" aparece em "Porto Santo" e em "Portofino".
 */
let airportCache = { rows: [], at: 0 };

async function findPickupAirport(pickupText) {
  const text = String(pickupText || '');
  if (!text) return { iata: null, city: null };

  if (Date.now() - airportCache.at > 60 * 60 * 1000) {
    const { data } = await supabase.from('airports')
      .select('iata, name, city, country').eq('active', true);
    airportCache = { rows: data || [], at: Date.now() };
  }

  const upper = text.toUpperCase();
  const lower = text.toLowerCase();

  const byCode = airportCache.rows.find((a) =>
    new RegExp(`\\b${a.iata}\\b`).test(upper));
  if (byCode) return { iata: byCode.iata, city: byCode.city };

  const byName = airportCache.rows.find((a) =>
    lower.includes(a.name.toLowerCase()));
  if (byName) return { iata: byName.iata, city: byName.city };

  // A cidade só conta se o texto também disser que é um aeroporto.
  // Sem isso, um hotel em Lisboa virava recolha no aeroporto.
  if (/airport|aeroporto|a[ée]roport|flughafen|aeropuerto/i.test(text)) {
    const byCity = airportCache.rows.find((a) =>
      lower.includes(a.city.toLowerCase()));
    if (byCity) return { iata: byCity.iata, city: byCity.city };
  }

  return { iata: null, city: null };
}

/**
 * O país, a partir do texto da morada. O Google devolve o país no
 * fim da descrição, por isso olhamos para a última parte.
 *
 * Deliberadamente simples: serve para distinguir uma viagem interna
 * de uma transfronteiriça, que é a distinção que os regimes fiscais
 * fazem. Não serve para determinar imposto sozinho.
 */
const COUNTRY_NAMES = {
  'portugal': 'PT', 'spain': 'ES', 'españa': 'ES', 'france': 'FR', 'italy': 'IT',
  'italia': 'IT', 'germany': 'DE', 'deutschland': 'DE', 'netherlands': 'NL',
  'belgium': 'BE', 'united kingdom': 'GB', 'uk': 'GB', 'england': 'GB',
  'scotland': 'GB', 'wales': 'GB', 'ireland': 'IE', 'switzerland': 'CH',
  'austria': 'AT', 'greece': 'GR', 'croatia': 'HR', 'poland': 'PL',
  'czechia': 'CZ', 'czech republic': 'CZ', 'hungary': 'HU', 'denmark': 'DK',
  'sweden': 'SE', 'norway': 'NO', 'finland': 'FI', 'iceland': 'IS',
  'luxembourg': 'LU', 'malta': 'MT', 'cyprus': 'CY', 'turkey': 'TR',
  'morocco': 'MA', 'united states': 'US', 'usa': 'US', 'canada': 'CA',
  'mexico': 'MX', 'brazil': 'BR', 'brasil': 'BR'
};

function guessCountry(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return null;

  const tail = value.split(',').pop().trim();
  if (COUNTRY_NAMES[tail]) return COUNTRY_NAMES[tail];

  const found = Object.keys(COUNTRY_NAMES).find((name) => value.includes(name));
  return found ? COUNTRY_NAMES[found] : null;
}

async function getDistanceAndDuration(pickup, dropoff) {
  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');

  url.searchParams.set('origin', pickup);
  url.searchParams.set('destination', dropoff);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('key', process.env.GOOGLE_SERVER_API_KEY);

  const response = await fetch(url.toString());
  const data = await response.json();

  if (data.status !== 'OK' || !data.routes?.[0]?.legs?.[0]) {
    throw new Error(`Could not calculate route: ${data.status}`);
  }

  const leg = data.routes[0].legs[0];

  return {
    distanceKm: leg.distance.value / 1000,
    durationMinutes: Math.round(leg.duration.value / 60),
    isPortugalRoute:
      (pickup || '').toLowerCase().includes('portugal') &&
      (dropoff || '').toLowerCase().includes('portugal')
  };
}

// ============================================================
// RESERVAR AGORA, PAGAR DEPOIS
//
// O Stripe não devolve a comissão num reembolso. Guardar o cartão e
// cobrar 48 horas antes faz com que a maioria dos cancelamentos
// aconteça antes de haver cobrança nenhuma — e aí não há comissão a
// perder.
//
// As regras vivem na base de dados, não aqui: os limiares vão mudar
// com o ticket médio e não quero um deploy por causa disso.
// ============================================================

let rulesCache = { rules: null, at: 0 };

async function getPaymentRules() {
  if (rulesCache.rules && Date.now() - rulesCache.at < 5 * 60 * 1000) {
    return rulesCache.rules;
  }

  const { data } = await supabase.from('payment_rules').select('*').eq('id', 1).maybeSingle();

  const rules = data || {
    min_hours_for_later: 72,
    charge_lead_hours: 48,
    max_value_for_later: 300,
    max_km_for_later: 150,
    agents_always_later: true,
    max_charge_attempts: 3,
    retry_interval_hours: 8
  };

  rulesCache = { rules, at: Date.now() };
  return rules;
}

function hoursUntil(dateStr, timeStr) {
  const at = new Date(`${dateStr}T${timeStr || '00:00'}`);
  if (!Number.isFinite(at.getTime())) return NaN;
  return (at.getTime() - Date.now()) / 36e5;
}

/**
 * Pode esta reserva ser paga depois?
 *
 * Devolve sempre o motivo, e não só um sim ou não: o calculador
 * mostra-o ao cliente, e "não disponível" sem explicação parece uma
 * avaria.
 */
async function payLaterEligibility({ dateStr, timeStr, priceEUR, distanceKm, isAgent }) {
  const rules = await getPaymentRules();
  const hours = hoursUntil(dateStr, timeStr);

  if (isAgent && rules.agents_always_later) {
    return { allowed: true, reason: null, rules };
  }

  // As razões dizem o número concreto. "Não disponível" sem
  // explicação parece uma avaria; "a recolha é dentro de 72 horas"
  // é uma regra que se percebe e que a pessoa pode contornar
  // escolhendo outra data.
  if (!Number.isFinite(hours)) {
    return {
      allowed: false,
      reason: 'Pick a date and time first.',
      rules
    };
  }

  if (hours < rules.min_hours_for_later) {
    return {
      allowed: false,
      reason: `Pick-up is in about ${Math.round(hours)} hours. Paying later needs at least ` +
        `${rules.min_hours_for_later} hours' notice, so this one is paid now.`,
      rules
    };
  }

  if (Number(priceEUR) > Number(rules.max_value_for_later)) {
    return {
      allowed: false,
      reason: 'Transfers above our higher-value threshold are paid at booking.',
      rules
    };
  }

  if (Number(distanceKm) > Number(rules.max_km_for_later)) {
    return {
      allowed: false,
      reason: `This route is about ${Math.round(distanceKm)} km. Journeys over ` +
        `${rules.max_km_for_later} km are paid at booking.`,
      rules
    };
  }

  return { allowed: true, reason: null, rules };
}

// ============================================================
// IDENTIDADE E AGENTES
//
// A margem do agente é SEMPRE calculada aqui, a partir do JWT. Se
// viesse do browser, qualquer pessoa reclamava 12% de desconto.
// ============================================================

const ALLOWED_ORIGINS = [
  SITE_ORIGIN,
  'https://airportlink.app',
  'https://www.theepictours.com',
  /\.filesusr\.com$/,
  /\.wixsite\.com$/,
  /\.editorx\.io$/
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
    if (originAllowed(origin)) {
      return callback(null, true);
    }

    console.warn('CORS blocked:', origin);
    return callback(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  // O x-cron-secret está aqui só para as rotas de diagnóstico
  // poderem ser chamadas do browser. Não abre nada: sem o valor
  // certo, a rota responde 403 na mesma.
  allowedHeaders: ['Content-Type', 'Authorization', 'Stripe-Signature', 'x-cron-secret']
}));

app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('Backend is running');
});

// Rede de parceiros de motoristas. Vive em partners.js para este
// ficheiro não crescer sem fim; as dependências vão por parâmetro.
app.use(createPartnerRoutes({
  supabase,
  getUserFromRequest,
  requireAdmin,
  config: {
    defaultCountry: process.env.DEFAULT_PARTNER_COUNTRY || 'PT'
  }
}));

app.get('/health', async (req, res) => {
  const { source, fetchedAt } = await loadExchangeRates();

  res.json({
    ok: true,
    time: new Date().toISOString(),
    ratesSource: source,
    ratesAgeSeconds: Math.round((Date.now() - fetchedAt) / 1000)
  });
});

app.get('/api/exchange-rates', async (req, res) => {
  const { rates, source } = await loadExchangeRates();
  const withMargin = {};

  for (const [code, rate] of Object.entries(rates)) {
    withMargin[code] = code === 'EUR' ? 1 : rate * (1 + FX_MARGIN);
  }

  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    base: 'EUR',
    source,
    rates: withMargin
  });
});

// O calculador pergunta aqui se pode mostrar a opção de pagar
// depois. A decisão é sempre repetida no checkout — isto é só para a
// interface, e nunca é o que decide se se cobra ou não.
/**
 * Quem tem de confirmar o email antes de a conta funcionar.
 *
 * Motoristas e agências: sim. Têm acesso a dinheiro e a dados de
 * terceiros, e ninguém está a meio de uma compra quando se regista.
 *
 * Clientes: não. O Supabase recusa o login enquanto o email não
 * estiver confirmado, e no calculador a conta é criada a meio da
 * reserva — bloquear aí obrigava a pessoa a sair, ir ao email e
 * recomeçar a reserva do zero. Um cliente já se verifica de outra
 * forma: paga com um cartão.
 *
 * Para mudar, é só pôr 'customer' a true. Mas lê o parágrafo acima
 * antes de o fazeres.
 */
const VERIFY_REQUIRED = {
  customer: false,
  partner: true,
  agent: true
};

/**
 * A conta de quem reservou sem se registar.
 *
 * Criamos uma na mesma, com o email da reserva, e mandamos-lhe um
 * link para escolher password. Assim ninguém é obrigado a registar-se
 * a meio de uma compra — que é onde se perdem clientes — mas quem
 * voltar encontra o histórico à espera.
 *
 * Devolve o link, ou null se a conta já existia (aí a pessoa já sabe
 * entrar e mandar-lhe um link de password seria estranho).
 */
async function ensureGuestAccount(email, name, phone) {
  if (!email) return null;

  try {
    const { data: existing } = await supabase
      .from('contacts')
      .select('id')
      .ilike('email', email)
      .maybeSingle();

    if (existing?.id) return { userId: existing.id, link: null };

    // Password aleatória que ninguém vai usar: a pessoa entra pelo
    // link, e uma password vazia não é permitida.
    const { data: created, error } = await supabase.auth.admin.createUser({
      email,
      password: crypto.randomUUID() + crypto.randomUUID(),
      email_confirm: true,
      user_metadata: { full_name: name || '', created_via: 'guest_booking' }
    });

    if (error || !created?.user) {
      console.error('guest account failed:', error?.message);
      return null;
    }

    await supabase.from('contacts').upsert({
      id: created.user.id,
      email,
      full_name: name || null,
      phone_number: phone || null,
      is_admin: false
    }, { onConflict: 'email' });

    const { data: linkData } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: `${SITE_ORIGIN}/resetpassword` }
    });

    console.log('Guest account created for', email);

    return {
      userId: created.user.id,
      link: linkData?.properties?.action_link || null
    };
  } catch (error) {
    console.error('ensureGuestAccount error:', error);
    return null;
  }
}

/**
 * A confirmação de email é enviada pelo SUPABASE, não por aqui.
 *
 * Configurado em Authentication > Emails com o SMTP do Resend, sai
 * do mesmo domínio e com o mesmo aspeto, e trata também da
 * recuperação de password e do aviso de password alterada — três
 * emails que teríamos de escrever e manter.
 *
 * Basta criar a conta com email_confirm a false: o Supabase envia
 * sozinho. Esta função existe para o registo de parceiros a poder
 * chamar sem saber disto.
 */
async function sendVerification(email, name, kind) {
  // Nada a fazer: o Supabase já enviou quando a conta foi criada.
  console.log(`[email] verification for ${email} (${kind}) handled by Supabase`);
  return { sent: true, by: 'supabase' };
}

app.post('/api/payment-options', async (req, res) => {
  try {
    const { booking } = req.body || {};
    if (!booking) return res.status(400).json({ error: 'Missing booking' });

    const requester = await getUserFromRequest(req);
    const agent = await getApprovedAgent(requester);

    let distanceKm = Number(booking.distance_km) || 0;
    if (!distanceKm && booking.pickup && booking.dropoff) {
      try {
        ({ distanceKm } = await getDistanceAndDuration(booking.pickup, booking.dropoff));
      } catch (e) {
        distanceKm = 0;
      }
    }

    const result = await payLaterEligibility({
      dateStr: booking.booking_date || booking.date,
      timeStr: booking.booking_time || booking.time,
      priceEUR: booking.price_eur || 0,
      distanceKm,
      isAgent: Boolean(agent)
    });

    return res.json({
      pay_later: result.allowed,
      reason: result.reason,
      charge_lead_hours: result.rules.charge_lead_hours,
      is_agent: Boolean(agent)
    });
  } catch (error) {
    console.error('payment-options error:', error);
    // Perante a dúvida, só pagar já. Nunca o contrário — mas com
    // uma explicação, senão o cartão fica cinzento sem motivo.
    return res.json({
      pay_later: false,
      reason: 'We could not check the payment options right now, so this booking is paid at checkout.',
      charge_lead_hours: 48
    });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, preferred_languages } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email and password are required.'
      });
    }

    if (String(password).length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters.'
      });
    }

    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email,
        password,
        // Para clientes marcamos como confirmado: o Supabase recusa
        // o login enquanto não estiver, e isso partia a reserva a
        // meio. O email de confirmação sai na mesma, a pedir e não
        // a exigir.
        email_confirm: !VERIFY_REQUIRED.customer,
        user_metadata: { full_name: name }
      });

    if (authError || !authData?.user) {
      console.error('Auth error:', authError);

      return res.status(400).json({
        success: false,
        message: authError?.message || 'Could not create account.'
      });
    }

    const { error: contactError } = await supabase
      .from('contacts')
      .upsert({
        id: authData.user.id,
        full_name: name,
        email,
        phone_number: phone || null,
        // Preferência, não garantia. No máximo duas: mais do que isso
        // deixa de ser uma preferência e passa a ser uma lista de desejos.
        preferred_languages: Array.isArray(preferred_languages) && preferred_languages.length
          ? preferred_languages.slice(0, 2)
          : null,
        is_admin: false
      }, {
        onConflict: 'email'
      });

    if (contactError) {
      console.error('Contacts upsert error:', contactError);

      return res.status(500).json({
        success: false,
        message: 'Account created but profile setup failed. Please contact support.'
      });
    }

    // A confirmação sai depois de a conta existir. Se falhar, a
    // conta continua boa — o email é um extra, não um requisito.
    await sendVerification(email, name, 'customer');

    return res.json({ success: true });
  } catch (error) {
    console.error('Register error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Could not create account.'
    });
  }
});

app.post('/api/create-checkout-session', async (req, res) => {
  const { booking } = req.body;

  if (!booking || !booking.pickup || !booking.dropoff || !booking.email) {
    return res.status(400).json({
      error: 'Missing pickup, dropoff or email'
    });
  }

  /**
   * O telefone é obrigatório, e a verificação tem de estar AQUI.
   *
   * O checkout já o exigia, mas uma reserva chegou sem ele — o que
   * significa que há outro caminho até esta rota, ou que alguém a
   * chamou diretamente.
   *
   * Sem número, o motorista não tem como avisar que chegou, nem
   * como encontrar quem espera num aeroporto com três saídas. É a
   * diferença entre uma viagem e uma reclamação.
   */
  const digitos = String(booking.phone_number || booking.passenger_phone || '')
    .replace(/\D/g, '');

  if (digitos.length < 6) {
    return res.status(400).json({
      error: 'A phone number is needed. The driver uses it to reach you on the day.'
    });
  }

  // O nome também: o motorista tem de saber por quem espera.
  if (String(booking.full_name || booking.passenger_name || '').trim().length < 2) {
    return res.status(400).json({ error: 'A name is needed for the booking.' });
  }

  const passengers = parseInt(booking.passengers, 10) || 1;
  const currency = (booking.currency || 'EUR').toUpperCase();
  const { rates } = await loadExchangeRates();

  if (!rates[currency]) {
    return res.status(400).json({ error: 'Unsupported currency' });
  }

  let distanceKm;
  let durationMinutes;
  let isPortugalRoute;

  try {
    ({
      distanceKm,
      durationMinutes,
      isPortugalRoute
    } = await getDistanceAndDuration(booking.pickup, booking.dropoff));
  } catch (error) {
    console.error('Directions error:', error);

    return res.status(400).json({
      error: 'Could not calculate the route for this pickup/dropoff.'
    });
  }

  const priceEUR = computePriceEUR(
    distanceKm,
    passengers,
    isPortugalRoute,
    {
      vehicleClass: booking.vehicle_class,
      pickupText: booking.pickup,
      dropoffText: booking.dropoff
    }
  );

  // Se quem pede for um agente aprovado, aplica-se a margem dele.
  // O browser não tem palavra nenhuma nisto.
  const requester = await getUserFromRequest(req);
  const agent = await getApprovedAgent(requester);
  const commission = agent ? agent.commission : 0;
  const netPriceEUR = priceEUR * (1 - commission / 100);

  const grossInCurrency = convertFromEUR(priceEUR, currency, rates);
  const priceInCurrency = convertFromEUR(netPriceEUR, currency, rates);

  // A volta é a mesma rota ao contrário, noutra data. Vem como um
  // objeto à parte porque cada perna é uma reserva independente.
  const ret = booking.return_leg && booking.return_leg.date
    ? {
        date: booking.return_leg.date,
        time: booking.return_leg.time,
        pickup: booking.return_leg.pickup || booking.dropoff,
        dropoff: booking.return_leg.dropoff || booking.pickup
      }
    : null;

  // A volta percorre a mesma distância, por isso custa o mesmo antes
  // de descontos. O desconto de ida e volta vem da configuração e é
  // zero por omissão: um desconto é decisão comercial, não um valor
  // a inventar no código.
  const rules = await getPaymentRules();
  const returnDiscount = ret ? Number(rules.return_discount_pct || 0) : 0;

  const returnPriceEUR = ret
    ? priceEUR * (1 - returnDiscount / 100)
    : 0;
  const returnNetEUR = returnPriceEUR * (1 - commission / 100);

  const totalNetEUR = netPriceEUR + returnNetEUR;
  const totalInCurrency = convertFromEUR(totalNetEUR, currency, rates);

  const amount = toStripeAmount(totalInCurrency, currency);

  // A folga é verificada aqui também. O limite no browser é uma
  // cortesia; esta é a regra.
  const BOOKING_BUFFER_MINUTES = 30;
  const pickupDate = booking.booking_date || booking.date;
  const pickupTime = booking.booking_time || booking.time || '00:00';
  const pickupAt = new Date(`${pickupDate}T${pickupTime}`);

  if (Number.isFinite(pickupAt.getTime()) &&
      pickupAt.getTime() < Date.now() + BOOKING_BUFFER_MINUTES * 60000) {
    return res.status(400).json({
      error: `We need at least ${BOOKING_BUFFER_MINUTES} minutes to arrange a driver. ` +
             'Please choose a later pick-up time.'
    });
  }

  const pickupAirport = await findPickupAirport(booking.pickup);

  // A taxa fica registada na reserva. Converter mais tarde com a taxa
  // do dia em que se lê o relatório dava números diferentes a cada
  // consulta, e nenhum deles seria o que realmente aconteceu.
  // País de recolha e de destino, a partir do texto. Grosseiro mas
  // suficiente: serve para separar viagens internas de transfronteiriças,
  // que é a distinção que quase todos os regimes fazem.
  const countryFrom = guessCountry(booking.pickup);
  const countryTo = guessCountry(booking.dropoff);

  const rateData = await loadExchangeRates();
  const fxRate = Number((rateData.rates || {})[String(currency).toUpperCase()] || 1);

  const phoneCode = booking.phone_code || booking.phoneCode || '';
  const phoneNumber = booking.phone_number || booking.phoneNumber || '';

  const fullPhone = (phoneCode || phoneNumber)
    ? `+${phoneCode}${phoneNumber ? ` ${phoneNumber}` : ''}`.trim()
    : '';

  const metadata = {
    email: booking.email || '',
    user_id: booking.user_id || '',
    full_name: booking.full_name || booking.fullName || '',
    phone_code: phoneCode,
    phone_number: phoneNumber,
    phone: fullPhone,
    currency,
    notes: booking.notes || '',
    flight_number: booking.flight_number || booking.flightNumber || '',
    pickup: booking.pickup || '',
    dropoff: booking.dropoff || '',
    booking_date: booking.booking_date || booking.date || '',
    booking_time: booking.booking_time || booking.time || '',
    passengers: String(passengers),
    price: String(priceInCurrency.toFixed(2)),
    distance_km: String(distanceKm.toFixed(1)),
    duration_minutes: String(durationMinutes),
    status: 'paid',
    booked_by: agent ? agent.id : '',
    agent_commission_pct: agent ? String(commission) : '',
    agent_gross_price: agent ? String(grossInCurrency.toFixed(2)) : '',
    price_eur: String(priceEUR.toFixed(2)),
    fx_rate: String(fxRate),
    // O grupo é gerado aqui e viaja nos metadados. Gerá-lo no
    // webhook daria grupos diferentes se ele chegasse duas vezes.
    trip_group_id: ret ? crypto.randomUUID() : '',
    return_date: ret ? ret.date : '',
    return_time: ret ? ret.time || '' : '',
    return_pickup: ret ? ret.pickup : '',
    return_dropoff: ret ? ret.dropoff : '',
    return_price: ret ? String(convertFromEUR(returnNetEUR, currency, rates).toFixed(2)) : '',
    return_price_eur: ret ? String(returnNetEUR.toFixed(2)) : '',
    country_from: countryFrom || '',
    country_to: countryTo || '',
    // Só faz sentido numa reserva de agência, e só o servidor sabe
    // se quem reserva é mesmo uma. Vem do JWT, não do que o browser
    // diz que é.
    agent_reference: agent ? String(booking.agent_reference || '').slice(0, 60) : '',
    passenger_name: booking.passenger_name || '',
    passenger_email: booking.passenger_email || '',
    passenger_phone: booking.passenger_phone || '',
    pickup_airport: pickupAirport.iata || '',
    pickup_city: pickupAirport.city || '',
    preferred_languages: Array.isArray(booking.preferred_languages)
      ? booking.preferred_languages.slice(0, 2).join(',')
      : ''
  };

  // O cliente pediu pagar depois? Só se as regras deixarem. A
  // decisão é tomada AQUI, não no browser: um pedido forjado com
  // payment_mode 'later' cai na mesma nesta verificação.
  const wantsLater = booking.payment_mode === 'later';
  const eligibility = await payLaterEligibility({
    dateStr: metadata.booking_date,
    timeStr: metadata.booking_time,
    priceEUR,
    distanceKm,
    isAgent: Boolean(agent)
  });

  const payLater = wantsLater && eligibility.allowed;

  if (wantsLater && !eligibility.allowed) {
    return res.status(400).json({
      error: eligibility.reason || 'This booking has to be paid at checkout.'
    });
  }

  metadata.payment_mode = payLater ? 'later' : 'now';

  if (payLater) {
    const pickupAt = new Date(`${metadata.booking_date}T${metadata.booking_time || '00:00'}`);
    metadata.charge_at = new Date(
      pickupAt.getTime() - eligibility.rules.charge_lead_hours * 36e5
    ).toISOString();
  }

  try {
    const parts = [
      `${passengers} passengers`,
      `${distanceKm.toFixed(1)} km`,
      `${durationMinutes} min`
    ];

    if (metadata.flight_number) {
      parts.push(`Flight ${metadata.flight_number}`);
    }

    let session;

    if (payLater) {
      // mode 'setup' guarda o cartão sem cobrar nada. O cliente vê a
      // página do Stripe, autentica o cartão se o banco exigir, e não
      // sai dinheiro nenhum da conta dele hoje.
      session = await stripe.checkout.sessions.create({
        mode: 'setup',
        payment_method_types: ['card'],
        customer_email: booking.email,
        success_url: `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_ORIGIN}/?cancel=true`,
        metadata,
        setup_intent_data: { metadata }
      });
    } else {
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        // Uma linha por perna. O cliente vê as duas na página do
        // Stripe em vez de um total que não sabe de onde vem.
        line_items: ret
          ? [
              {
                price_data: {
                  currency: currency.toLowerCase(),
                  product_data: {
                    name: `Outbound: ${booking.pickup} to ${booking.dropoff}`,
                    description: `${metadata.booking_date} · ${parts.join(', ')}`
                  },
                  unit_amount: toStripeAmount(priceInCurrency, currency)
                },
                quantity: 1
              },
              {
                price_data: {
                  currency: currency.toLowerCase(),
                  product_data: {
                    name: `Return: ${ret.pickup} to ${ret.dropoff}`,
                    description: `${ret.date} · ${passengers} passengers` +
                      (returnDiscount ? ` · ${returnDiscount}% return discount` : '')
                  },
                  unit_amount: toStripeAmount(
                    convertFromEUR(returnNetEUR, currency, rates), currency)
                },
                quantity: 1
              }
            ]
          : [{
              price_data: {
                currency: currency.toLowerCase(),
                product_data: {
                  name: `Transfer: ${booking.pickup} to ${booking.dropoff}`,
                  description: parts.join(', ')
                },
                unit_amount: amount
              },
              quantity: 1
            }],
        success_url: `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_ORIGIN}/?cancel=true`,
        customer_email: booking.email,
        metadata,
        payment_intent_data: { metadata }
      });
    }

    return res.json({
      url: session.url,
      sessionId: session.id,
      payment_mode: payLater ? 'later' : 'now',
      charge_at: metadata.charge_at || null,
      agent: agent
        ? { commission, agency_name: agent.agency_name }
        : null
    });
  } catch (error) {
    console.error('Stripe error:', error);

    return res.status(500).json({
      error: error.message
    });
  }
});

/**
 * Completa uma reserva a partir da sessão do Stripe.
 *
 * Não substitui o webhook: é o que garante que um webhook falhado
 * não deixa um cliente pago e sem confirmação. Só toca no que
 * estiver em falta.
 */
async function repairBookingFromSession(session) {
  if (!session || session.payment_status !== 'paid') return;

  const metadata = session.metadata || {};
  if (!metadata.email && !metadata.passenger_email) return;

  const { data: existing } = await supabase
    .from('bookings')
    .select('*')
    .eq('stripe_checkout_session_id', session.id)
    .maybeSingle();

  // Já está completa: nada a fazer. O price_eur é a marca de que
  // passou pelo webhook novo.
  if (existing && existing.price_eur !== null && existing.booking_reference) {
    return;
  }

  console.warn('[confirm] incomplete booking, repairing:', session.id);

  const patch = {
    booking_reference: existing?.booking_reference || metadata.booking_reference || null,
    price_eur: metadata.price_eur ? Number(metadata.price_eur) : null,
    fx_rate: metadata.fx_rate ? Number(metadata.fx_rate) : null,
    fx_rate_at: new Date().toISOString(),
    pickup_airport: metadata.pickup_airport || null,
    pickup_city: metadata.pickup_city || null,
    country_from: metadata.country_from || null,
    country_to: metadata.country_to || null,
    cross_border: metadata.country_from && metadata.country_to
      ? metadata.country_from !== metadata.country_to
      : null,
    flight_number: metadata.flight_number || null,
    passenger_name: metadata.passenger_name || null,
    passenger_email: metadata.passenger_email || null,
    passenger_phone: metadata.passenger_phone || null,
    agent_reference: metadata.agent_reference || null,
    payment_mode: metadata.payment_mode || 'now',
    updated_at: new Date().toISOString()
  };

  let booking = existing;

  if (existing) {
    const { data } = await supabase
      .from('bookings')
      .update(patch)
      .eq('id', existing.id)
      .select()
      .single();

    booking = data || existing;
  } else {
    // Nem sequer existe: o webhook não correu de todo.
    const { data, error } = await supabase
      .from('bookings')
      .upsert({
        ...patch,
        stripe_checkout_session_id: session.id,
        full_name: metadata.full_name || null,
        email: metadata.email || null,
        phone: metadata.phone || null,
        pickup: metadata.pickup || null,
        dropoff: metadata.dropoff || null,
        booking_date: metadata.booking_date || null,
        booking_time: metadata.booking_time || null,
        passengers: Number(metadata.passengers || 1),
        price: metadata.price ? Number(metadata.price) : null,
        currency: metadata.currency || 'EUR',
        distance_km: metadata.distance_km ? Number(metadata.distance_km) : null,
        duration_minutes: metadata.duration_minutes ? Number(metadata.duration_minutes) : null,
        notes: metadata.notes || null,
        status: 'paid',
        payment_status: 'paid'
      }, { onConflict: 'stripe_checkout_session_id' })
      .select()
      .single();

    if (error) {
      console.error('[confirm] could not create booking:', error.message);
      return;
    }

    booking = data;

    await notifyOps('A booking was saved by the fallback, not the webhook', [
      `Session: ${session.id}`,
      `Customer: ${metadata.full_name} (${metadata.email})`,
      '',
      'The Stripe webhook did not create this booking. Check that the endpoint in',
      'Stripe points at https://airportlink.onrender.com/api/stripe-webhook',
      'and that it is returning 200.'
    ]);
  }

  if (!booking) return;

  // A email_log trata dos duplicados: se o webhook chegar depois e
  // tentar enviar, é descartado.
  const result = await sendBookingConfirmation(booking, null, null);

  console.log('[confirm] confirmation email:', {
    booking: booking.booking_id || booking.id,
    sent: result.sent,
    reason: result.reason || null
  });
}

app.post('/api/confirm-payment', async (req, res) => {
  const { session_id } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    const paymentIntent = typeof session.payment_intent === 'string'
      ? await stripe.paymentIntents.retrieve(
          session.payment_intent,
          { expand: ['latest_charge'] }
        )
      : null;

    const charge = paymentIntent?.latest_charge || null;

    // ---------- rede de segurança ----------
    //
    // Esta rota corre quando o cliente volta do Stripe. Se o webhook
    // não tiver corrido — endereço errado, serviço em baixo, evento
    // perdido — a reserva ou não existe ou está incompleta, e o
    // cliente nunca receberia confirmação.
    //
    // Aqui completamos o que faltar e enviamos o email. A email_log
    // impede que saia duas vezes se o webhook aparecer depois.
    try {
      await repairBookingFromSession(session);
    } catch (error) {
      console.error('[confirm] repair failed:', error.message);
    }

    return res.json({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email:
        session.customer_email ||
        session.customer_details?.email ||
        null,
      amount_total: session.amount_total || null,
      currency: session.currency || null,
      receipt_url: charge?.receipt_url || null,
      payment_method_type: charge?.payment_method_details?.type || null
    });
  } catch (error) {
    console.error('Confirm payment error:', error);

    return res.status(500).json({
      error: error.message
    });
  }
});

app.post('/api/cancel-booking', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Not signed in' });
    }

    const { booking_id } = req.body;

    if (!booking_id) {
      return res.status(400).json({ error: 'Missing booking_id' });
    }

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', booking_id)
      .maybeSingle();

    if (bookingError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const owns =
      booking.user_id === user.id ||
      booking.booked_by === user.id ||
      String(booking.email || '').toLowerCase() ===
        String(user.email || '').toLowerCase();

    if (!owns) {
      return res.status(403).json({
        error: 'This booking is not yours'
      });
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({
        error: 'This booking is already cancelled'
      });
    }

    const pickupAt = new Date(
      `${booking.booking_date}T${booking.booking_time || '00:00'}`
    );

    const hoursUntil = (pickupAt.getTime() - Date.now()) / 36e5;

    if (!Number.isFinite(hoursUntil)) {
      return res.status(400).json({
        error: 'This booking has no valid pick-up time. Please contact support.'
      });
    }

    // Reserva com pagamento adiado e ainda por cobrar: cancela-se sem
    // mais nada. Não há dinheiro a devolver, nem comissão a perder —
    // é exatamente para isto que o pagar depois existe.
    const notYetCharged = booking.payment_mode === 'later' && !booking.charged_at;

    if (notYetCharged) {
      const { error: cancelError } = await supabase.from('bookings').update({
        status: 'cancelled',
        payment_status: 'cancelled_before_charge',
        charge_at: null,
        assigned_partner_id: null,
        assigned_driver_id: null,
        assigned_vehicle_id: null,
        assigned_at: null,
        updated_at: new Date().toISOString()
      }).eq('id', booking_id);

      if (cancelError) {
        console.error('Cancel (uncharged) error:', cancelError);
        return res.status(500).json({ error: 'Could not cancel. Please contact support.' });
      }

      // O cartão guardado deixa de fazer falta. Apagá-lo do Stripe é
      // o mínimo: guardar cartões de reservas canceladas é risco sem
      // proveito nenhum.
      if (booking.stripe_payment_method_id) {
        try {
          await stripe.paymentMethods.detach(booking.stripe_payment_method_id);
        } catch (error) {
          console.warn('Could not detach card:', error.message);
        }
      }

      await sendCancellation(booking, { refunded: false, amount: 0 });

      return res.json({ success: true, refunded: false, charged: false });
    }

    // Agentes têm 12 horas em vez de 24, mas só nas reservas que
    // eles próprios fizeram.
    const agent = await getApprovedAgent(user);
    const windowHours = (agent && booking.booked_by === user.id)
      ? AGENT_CANCELLATION_HOURS
      : FREE_CANCELLATION_HOURS;

    if (hoursUntil < windowHours) {
      return res.status(400).json({
        error:
          `Free cancellation closes ${windowHours} hours before pick-up. ` +
          'Please contact support.'
      });
    }

    let refundId = null;

    if (booking.stripe_payment_intent_id) {
      try {
        const refund = await stripe.refunds.create({
          payment_intent: booking.stripe_payment_intent_id,
          reason: 'requested_by_customer'
        });

        refundId = refund.id;
      } catch (error) {
        console.error('Refund error:', error);

        return res.status(502).json({
          error: 'We could not process the refund automatically. Please contact support.'
        });
      }
    }

    const { error: updateError } = await supabase
      .from('bookings')
      .update({
        status: 'cancelled',
        payment_status: refundId ? 'refunded' : booking.payment_status,
        refunded_amount: refundId ? Number(booking.price || 0) : booking.refunded_amount,
        // Também em euros: sem isto o relatório mensal não sabe
        // quanto foi devolvido numa reserva feita em libras.
        refunded_amount_eur: refundId && booking.fx_rate
          ? Number((Number(booking.price || 0) / Number(booking.fx_rate)).toFixed(2))
          : booking.refunded_amount_eur,
        refunded_at: refundId ? new Date().toISOString() : booking.refunded_at,
        refund_reason: refundId ? 'Cancelled by customer within the free window' : booking.refund_reason,
        updated_at: new Date().toISOString()
      })
      .eq('id', booking_id);

    if (updateError) {
      console.error('Cancel update error:', updateError);

      return res.status(500).json({
        error:
          'The refund was issued but the booking status could not be updated. ' +
          'Please contact support.'
      });
    }

    await sendCancellation(booking, {
      refunded: Boolean(refundId),
      amount: Number(booking.price || 0)
    });

    return res.json({
      success: true,
      refunded: Boolean(refundId)
    });
  } catch (error) {
    console.error('Cancel booking error:', error);

    return res.status(500).json({
      error: 'Something went wrong. Please contact support.'
    });
  }
});

// ============================================================
// REEMBOLSO MANUAL (ADMIN)
//
// Para os casos fora da janela de cancelamento automático, onde a
// decisão é comercial e tem de ser de uma pessoa. Aceita reembolso
// parcial e não obriga a cancelar a reserva — às vezes devolve-se
// uma diferença sem anular o transfer.
// ============================================================
app.post('/api/admin/refund', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);

    if (!admin) {
      return res.status(403).json({ error: adminError || 'Administrator access required.' });
    }

    /**
     * Reembolsar é decisão de supervisor.
     *
     * É a única ação do painel que tira dinheiro da conta sem
     * possibilidade de a desfazer. Esconder o botão não protegia
     * nada: esta rota chama-se da consola do browser.
     */
    const { data: quem } = await supabase
      .from('contacts')
      .select('role')
      .eq('id', admin.id)
      .maybeSingle();

    if (!quem || quem.role !== 'supervisor') {
      return res.status(403).json({
        error: 'Refunds are for supervisors. Ask one to do it, or escalate the ' +
          'conversation so it stays on record.'
      });
    }

    const { booking_id, amount, cancel_booking, reason } = req.body || {};

    if (!booking_id) {
      return res.status(400).json({ error: 'Missing booking_id' });
    }

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', booking_id)
      .maybeSingle();

    if (bookingError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!booking.stripe_payment_intent_id) {
      return res.status(400).json({
        error: 'This booking has no Stripe payment on file. Nothing to refund here.'
      });
    }

    const currency = booking.currency || 'EUR';

    // amount_total vem do Stripe em unidades menores e é a fonte de
    // verdade do que foi realmente cobrado. O price é o que
    // mostrámos, que pode divergir por arredondamento.
    const paidMajor = booking.amount_total
      ? fromStripeAmount(booking.amount_total, currency)
      : Number(booking.price || 0);

    const alreadyMajor = Number(booking.refunded_amount || 0);
    const remainingMajor = Number((paidMajor - alreadyMajor).toFixed(2));

    if (remainingMajor <= 0) {
      return res.status(400).json({
        error: 'This booking has already been fully refunded.'
      });
    }

    let refundMajor = remainingMajor;

    if (amount !== undefined && amount !== null && amount !== '') {
      const requested = Number(amount);

      if (!Number.isFinite(requested) || requested <= 0) {
        return res.status(400).json({ error: 'Refund amount must be a positive number.' });
      }

      if (requested > remainingMajor + 0.001) {
        return res.status(400).json({
          error: `Only ${remainingMajor.toFixed(2)} ${currency} is left to refund on this booking.`
        });
      }

      refundMajor = requested;
    }

    const refundMinor = toStripeAmount(refundMajor, currency);

    if (refundMinor <= 0) {
      return res.status(400).json({ error: 'Refund amount is too small to process.' });
    }

    let refund;

    try {
      refund = await stripe.refunds.create({
        payment_intent: booking.stripe_payment_intent_id,
        amount: refundMinor,
        reason: 'requested_by_customer',
        metadata: {
          issued_by: admin.email,
          booking_id: String(booking.id),
          note: (reason || '').slice(0, 400)
        }
      });
    } catch (error) {
      console.error('Admin refund error:', error);

      return res.status(502).json({
        error: error.message || 'Stripe refused the refund.'
      });
    }

    const totalRefunded = Number((alreadyMajor + refundMajor).toFixed(2));
    const fullyRefunded = totalRefunded >= paidMajor - 0.001;

    const update = {
      refunded_amount: totalRefunded,
      refunded_amount_eur: booking.fx_rate
        ? Number((totalRefunded / Number(booking.fx_rate)).toFixed(2))
        : totalRefunded,
      refunded_at: new Date().toISOString(),
      refunded_by: admin.id,
      refund_reason: reason || null,
      payment_status: fullyRefunded ? 'refunded' : 'partially_refunded',
      updated_at: new Date().toISOString()
    };

    if (cancel_booking) {
      update.status = 'cancelled';
    }

    const { error: updateError } = await supabase
      .from('bookings')
      .update(update)
      .eq('id', booking_id);

    if (updateError) {
      console.error('Refund update error:', updateError);

      // O dinheiro já saiu. Não devolvemos erro genérico: quem está
      // no painel precisa de saber que o Stripe fez a parte dele.
      return res.status(500).json({
        error: `Stripe issued refund ${refund.id}, but the booking record could not be updated. ` +
               'Please fix the booking manually.'
      });
    }

    console.log('Manual refund issued:', {
      by: admin.email,
      booking: booking.booking_id || booking.id,
      amount: refundMajor,
      currency,
      cancelled: Boolean(cancel_booking)
    });

    return res.json({
      success: true,
      refund_id: refund.id,
      refunded_now: refundMajor,
      refunded_total: totalRefunded,
      remaining: Number((paidMajor - totalRefunded).toFixed(2)),
      currency,
      fully_refunded: fullyRefunded
    });
  } catch (error) {
    console.error('admin/refund error:', error);

    return res.status(500).json({ error: 'Something went wrong issuing the refund.' });
  }
});

// ============================================================
// PROGRAMA DE AGENTES
// ============================================================

app.get('/api/agent/me', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Not signed in' });
    }

    const { data, error } = await supabase
      .from('travel_agents')
      .select(
        'id, email, contact_name, representative_role, legal_name, agency_name, ' +
        'agency_vat, agency_country, agency_website, agency_phone, note, ' +
        'status, commission, applied_at'
      )
      .eq('id', user.id)
      .maybeSingle();

    if (error) throw error;

    // Sem linha na tabela significa que nunca se candidatou. Não
    // existe estado 'none' guardado — a ausência é o estado.
    return res.json({
      email: user.email,
      status: data?.status || 'none',
      commission: data?.status === 'approved'
        ? Number(data.commission || DEFAULT_AGENT_COMMISSION)
        : null,
      agency_name: data?.agency_name || null,
      cancellation_hours: AGENT_CANCELLATION_HOURS,
      profile: data || null
    });
  } catch (error) {
    console.error('agent/me error:', error);

    return res.status(500).json({
      error: 'Could not load your agent status.'
    });
  }
});

// Cria SEMPRE o estado 'pending'. A aprovação é manual e só o
// service role a pode escrever, porque a coluna está revogada ao
// papel authenticated.
app.post('/api/agent/apply', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Please sign in first.' });
    }

    const {
      legal_name,
      agency_name,
      agency_vat,
      agency_country,
      agency_website,
      agency_phone,
      representative_name,
      representative_role,
      note,
      full_name
    } = req.body || {};

    if (!legal_name || !agency_country || !agency_phone || !representative_name) {
      return res.status(400).json({
        error: 'Registered company name, country, phone and representative name are required.'
      });
    }

    const { data: existing } = await supabase
      .from('travel_agents')
      .select('status')
      .eq('id', user.id)
      .maybeSingle();

    if (existing?.status === 'approved') {
      return res.status(400).json({
        error: 'Your agency is already approved.'
      });
    }

    if (existing?.status === 'pending') {
      return res.status(400).json({
        error: 'Your application is already under review.'
      });
    }

    // O agente continua a ser uma pessoa: garantimos a linha em
    // contacts, porque bookings.email aponta para lá.
    const { error: contactError } = await supabase
      .from('contacts')
      .upsert({
        id: user.id,
        email: user.email,
        full_name: representative_name || full_name || user.user_metadata?.full_name || null,
        is_admin: false
      }, {
        onConflict: 'email'
      });

    if (contactError) throw contactError;

    // O status e a commission ficam nos valores por omissão da
    // tabela: 'pending' e 12. Nunca vêm do pedido.
    const { error } = await supabase
      .from('travel_agents')
      .upsert({
        id: user.id,
        email: user.email,
        contact_name: representative_name || full_name || null,
        representative_role: representative_role || null,
        legal_name,
        // Sem nome comercial, o comercial é o legal.
        agency_name: agency_name || legal_name,
        agency_vat: agency_vat || null,
        agency_country,
        agency_website: agency_website || null,
        agency_phone,
        note: note || null,
        status: 'pending',
        applied_at: new Date().toISOString(),
        commission: DEFAULT_AGENT_COMMISSION,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'id'
      });

    if (error) throw error;

    return res.json({ success: true, status: 'pending' });
  } catch (error) {
    console.error('agent/apply error:', error);

    return res.status(500).json({
      error: 'Could not submit your application. Please try again.'
    });
  }
});

// Aprovação e recusa.
//
// Passa pelo servidor porque o SQL revoga o update das colunas
// agent_status e agent_commission ao papel authenticated — e o
// admin também é authenticated, por isso não conseguiria escrever
// a partir do browser. Uma revogação de coluna não distingue papéis.
app.post('/api/agent/review', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);

    if (!admin) {
      return res.status(403).json({ error: adminError || 'Administrator access required.' });
    }

    const { agent_id, decision, commission } = req.body || {};

    if (!agent_id || !['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Missing agent_id or invalid decision.' });
    }

    const update = {
      status: decision,
      reviewed_at: new Date().toISOString(),
      reviewed_by: admin.id,
      updated_at: new Date().toISOString()
    };

    if (decision === 'approved') {
      const pct = Number(commission);
      update.commission = Number.isFinite(pct) && pct > 0 && pct < 100
        ? pct
        : DEFAULT_AGENT_COMMISSION;
    }

    const { data, error } = await supabase
      .from('travel_agents')
      .update(update)
      .eq('id', agent_id)
      .select('id, email, agency_name, status, commission')
      .single();

    if (error) throw error;

    console.log('Agent reviewed:', {
      by: admin.email,
      agent: data.email,
      decision,
      commission: data.commission
    });

    // O email não pode partir a decisão: a agência já está aprovada
    // na base de dados quando chegamos aqui.
    if (decision === 'approved' || decision === 'rejected') {
      await sendAgentDecision(data, decision, req.body.reason);
    }

    return res.json({ success: true, agent: data });
  } catch (error) {
    console.error('agent/review error:', error);

    return res.status(500).json({
      error: 'Could not update the application.'
    });
  }
});

// Edição dos dados da agência.
//
// Passa pelo servidor porque travel_agents não tem política de UPDATE
// para o papel authenticated. A lista de campos é branca de propósito:
// status e commission nunca são aceites, venham como vierem no pedido.
app.post('/api/agent/profile', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Not signed in' });
    }

    const { data: existing } = await supabase
      .from('travel_agents')
      .select('id, status')
      .eq('id', user.id)
      .maybeSingle();

    if (!existing) {
      return res.status(404).json({ error: 'No partner account found.' });
    }

    const {
      legal_name,
      agency_name,
      agency_vat,
      agency_country,
      agency_phone,
      agency_website,
      contact_name,
      representative_role
    } = req.body || {};

    if (!legal_name || !agency_country || !agency_phone || !contact_name) {
      return res.status(400).json({
        error: 'Registered company name, country, phone and representative name are required.'
      });
    }

    const { data, error } = await supabase
      .from('travel_agents')
      .update({
        legal_name,
        agency_name: agency_name || legal_name,
        agency_vat: agency_vat || null,
        agency_country,
        agency_phone,
        agency_website: agency_website || null,
        contact_name,
        representative_role: representative_role || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id)
      .select('id, email, contact_name, representative_role, legal_name, agency_name, agency_vat, agency_country, agency_phone, agency_website, status, commission')
      .single();

    if (error) throw error;

    // O nome de contacto também vive na contacts, que é a ficha da
    // pessoa. Mantemos as duas alinhadas.
    if (contact_name) {
      await supabase.from('contacts')
        .update({ full_name: contact_name })
        .eq('id', user.id);
    }

    return res.json({ success: true, profile: data });
  } catch (error) {
    console.error('agent/profile error:', error);

    return res.status(500).json({
      error: 'Could not save your agency details.'
    });
  }
});

// Extrato mensal consolidado. O agente paga viagem a viagem; isto é
// o documento único para a contabilidade dele.
app.get('/api/agent/statement', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Not signed in' });
    }

    const agent = await getApprovedAgent(user);

    if (!agent) {
      return res.status(403).json({ error: 'Your agency is not approved yet.' });
    }

    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
      ? String(req.query.month)
      : new Date().toISOString().slice(0, 7);

    const start = `${month}-01`;
    const endDate = new Date(start);
    endDate.setMonth(endDate.getMonth() + 1);
    const end = endDate.toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from('bookings')
      .select(
        'id, booking_id, booking_reference, booking_date, booking_time, ' +
        'pickup, dropoff, passengers, price, agent_gross_price, ' +
        'agent_commission_pct, currency, status, full_name, ' +
        'passenger_name, flight_number'
      )
      .eq('booked_by', user.id)
      .gte('booking_date', start)
      .lt('booking_date', end)
      .order('booking_date', { ascending: true });

    if (error) throw error;

    const rows = data || [];
    const billable = rows.filter((row) => row.status !== 'cancelled');

    const net = billable.reduce(
      (sum, row) => sum + (Number(row.price) || 0),
      0
    );

    const gross = billable.reduce(
      (sum, row) => sum + (Number(row.agent_gross_price) || Number(row.price) || 0),
      0
    );

    return res.json({
      month,
      agency_name: agent.agency_name,
      agent_email: agent.email,
      commission: agent.commission,
      currency: billable[0]?.currency || 'EUR',
      bookings: rows,
      totals: {
        count: billable.length,
        gross: Number(gross.toFixed(2)),
        net: Number(net.toFixed(2)),
        saved: Number((gross - net).toFixed(2))
      }
    });
  } catch (error) {
    console.error('agent/statement error:', error);

    return res.status(500).json({
      error: 'Could not build your statement.'
    });
  }
});

/**
 * O webhook está bem configurado?
 *
 * Uma pergunta que hoje só se responde fazendo um pagamento a
 * sério e vendo o que acontece. Isto responde-a em dois segundos.
 *
 * Protegida pelo x-cron-secret: o prefixo de uma chave é pouco,
 * mas não é nada, e não há razão para o deixar aberto.
 */
app.get('/api/stripe-webhook/health', (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const segredos = String(process.env.STRIPE_WEBHOOK_SECRET || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  return res.json({
    secrets_configured: segredos.length,
    // Chega para comparar com o que o Stripe mostra, sem revelar
    // a chave.
    prefixes: segredos.map((x) => x.slice(0, 12) + '...'),
    looks_valid: segredos.every((x) => x.startsWith('whsec_')),
    stripe_key_mode: String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live')
      ? 'live'
      : 'test'
  });
});

app.post('/api/stripe-webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).send('Missing Stripe signature');
  }

  let event;

  /**
   * Um segredo por endpoint, e pode haver mais do que um.
   *
   * O Stripe assina cada evento com o segredo DO ENDPOINT que o
   * recebe. Se houver dois — o de teste e o de produção, ou um
   * criado por engano — cada um tem o seu, e o que está no Render
   * só valida os eventos de um deles.
   *
   * A mensagem "No signatures found matching" diz exatamente isso:
   * o corpo chegou bem, a assinatura é válida, mas foi feita com
   * outra chave.
   *
   * STRIPE_WEBHOOK_SECRET aceita agora vários separados por
   * vírgula. Tenta-se cada um até algum bater.
   */
  const segredos = String(process.env.STRIPE_WEBHOOK_SECRET || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  if (!segredos.length) {
    console.error('Webhook: STRIPE_WEBHOOK_SECRET is not set.');
    return res.status(500).send('Webhook secret not configured');
  }

  let ultimoErro = null;

  for (const segredo of segredos) {
    try {
      event = await stripe.webhooks.constructEventAsync(req.body, signature, segredo);
      break;
    } catch (error) {
      ultimoErro = error;
    }
  }

  if (!event) {
    /**
     * Diagnóstico no registo, não na resposta.
     *
     * O Stripe mostra o que respondermos, e uma resposta com
     * detalhes da chave seria visível a quem tiver acesso ao painel
     * dele. Nos registos do Render fica só para quem gere o
     * serviço.
     */
    console.error('Webhook signature failed.', {
      secrets_configured: segredos.length,
      // Só os primeiros caracteres: chega para confirmar QUAL é
      // sem o revelar.
      secret_prefix: segredos.map((x) => x.slice(0, 12)),
      body_is_buffer: Buffer.isBuffer(req.body),
      body_length: req.body && req.body.length,
      error: ultimoErro && ultimoErro.message
    });

    return res.status(400).send(`Webhook Error: ${ultimoErro && ultimoErro.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};
    const payLater = metadata.payment_mode === 'later' || session.mode === 'setup';

    // Em modo setup não há cobrança: o que interessa é o cartão que
    // ficou guardado, para o podermos usar mais tarde sem o cliente
    // estar presente.
    let savedPaymentMethod = null;
    let setupIntentId = null;

    if (payLater && typeof session.setup_intent === 'string') {
      try {
        const si = await stripe.setupIntents.retrieve(session.setup_intent);
        setupIntentId = si.id;
        savedPaymentMethod = typeof si.payment_method === 'string'
          ? si.payment_method
          : si.payment_method?.id || null;
      } catch (error) {
        console.error('SetupIntent retrieve error:', error);
      }
    }

    let charge = null;

    // O que o Stripe depositou, em euros, já líquido de comissão.
    // O price_eur é o valor cotado à taxa do BCE; este é o que
    // aparece no extrato. Os dois têm de existir: um para reportar
    // receita, outro para bater com o banco.
    let settlement = { eur: null, fee: null, rate: null, id: null };

    if (typeof session.payment_intent === 'string') {
      try {
        // Expandimos até ao balance_transaction numa só chamada: é
        // aí que está o valor líquido em euros e a comissão.
        const paymentIntent = await stripe.paymentIntents.retrieve(
          session.payment_intent,
          { expand: ['latest_charge.balance_transaction'] }
        );

        charge = paymentIntent.latest_charge || null;

        const bt = charge && charge.balance_transaction;
        if (bt && typeof bt === 'object') {
          const factor = ZERO_DECIMAL_CURRENCIES
            .includes(String(bt.currency).toUpperCase()) ? 1 : 100;

          settlement = {
            eur: Number((bt.net / factor).toFixed(2)),
            fee: Number((bt.fee / factor).toFixed(2)),
            rate: bt.exchange_rate || null,
            id: bt.id
          };
        }
      } catch (error) {
        console.error('PaymentIntent retrieve error:', error);
      }
    }

    let userId = metadata.user_id || null;
    let passwordLink = null;

    if (!userId && metadata.email) {
      // Isolado num try próprio: se falhar, a reserva continua a ser
      // criada e a confirmação continua a sair. Antes, um erro aqui
      // abortava o processador e o cliente ficava com a reserva paga
      // e sem email nenhum.
      try {
        const guest = await ensureGuestAccount(
          metadata.email,
          metadata.full_name,
          [metadata.phone_code, metadata.phone_number].filter(Boolean).join(' ')
        );

        if (guest) {
          userId = guest.userId;
          passwordLink = guest.link;
        }
      } catch (error) {
        console.error('[webhook] guest account step failed, carrying on:', error.message);
      }
    }

    const bookingRow = {
      user_id: userId,
      full_name: metadata.full_name || null,
      phone_code: metadata.phone_code || null,
      phone_number: metadata.phone_number || null,
      phone: metadata.phone || null,
      currency: metadata.currency || session.currency || null,
      notes: metadata.notes || null,
      flight_number: metadata.flight_number || null,
      pickup: metadata.pickup || null,
      dropoff: metadata.dropoff || null,
      booking_date: metadata.booking_date || null,
      booking_time: metadata.booking_time || null,
      passengers: metadata.passengers
        ? parseInt(metadata.passengers, 10)
        : null,
      price: metadata.price ? Number(metadata.price) : null,
      distance_km: metadata.distance_km
        ? Number(metadata.distance_km)
        : null,
      duration_minutes: metadata.duration_minutes
        ? parseInt(metadata.duration_minutes, 10)
        : null,
      booked_by: metadata.booked_by || null,
      agent_commission_pct: metadata.agent_commission_pct
        ? Number(metadata.agent_commission_pct)
        : null,
      agent_gross_price: metadata.agent_gross_price
        ? Number(metadata.agent_gross_price)
        : null,
      passenger_name: metadata.passenger_name || null,
      passenger_email: metadata.passenger_email || null,
      passenger_phone: metadata.passenger_phone || null,
      agent_reference: metadata.agent_reference || null,
      pickup_airport: metadata.pickup_airport || null,
      pickup_city: metadata.pickup_city || null,
      trip_group_id: metadata.trip_group_id || null,
      leg: metadata.trip_group_id ? 1 : null,
      country_from: metadata.country_from || null,
      country_to: metadata.country_to || null,
      // Onde a viagem acontece decide, em vários regimes fiscais,
      // onde o imposto é devido. Guardamos mesmo antes de usar.
      cross_border: Boolean(metadata.country_from && metadata.country_to &&
        metadata.country_from !== metadata.country_to),
      price_eur: metadata.price_eur ? Number(metadata.price_eur) : null,
      fx_rate: metadata.fx_rate ? Number(metadata.fx_rate) : null,
      fx_rate_at: new Date().toISOString(),
      settled_eur: settlement.eur,
      stripe_fee_eur: settlement.fee,
      stripe_fx_rate: settlement.rate,
      balance_transaction_id: settlement.id,
      preferred_languages: metadata.preferred_languages
        ? metadata.preferred_languages.split(',').filter(Boolean)
        : null,
      status: payLater ? 'confirmed' : (metadata.status || session.payment_status || 'paid'),
      payment_status: payLater ? 'card_saved' : (session.payment_status || null),
      payment_mode: payLater ? 'later' : 'now',
      charge_at: payLater ? (metadata.charge_at || null) : null,
      stripe_payment_method_id: savedPaymentMethod,
      stripe_setup_intent_id: setupIntentId,
      amount_total: payLater ? null : (session.amount_total || null),
      stripe_customer_id: typeof session.customer === 'string'
        ? session.customer
        : null,
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent || null,
      receipt_url: charge?.receipt_url || null,
      payment_method_type: charge?.payment_method_details?.type || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      email:
        metadata.email ||
        session.customer_details?.email ||
        session.customer_email ||
        null
    };

    const { data: savedBooking, error: upsertError } = await supabase
      .from('bookings')
      .upsert(bookingRow, {
        onConflict: 'stripe_checkout_session_id'
      })
      .select()
      .single();

    if (upsertError) {
      console.error('Supabase upsert error:', upsertError);

      return res.status(500).send(
        `Supabase error: ${upsertError.message}`
      );
    }

    // ---------- a perna de regresso ----------
    //
    // Uma reserva completa e independente: pode ir para outro
    // parceiro, ter outro motorista e ser cancelada sozinha. O que
    // as liga é o trip_group_id.
    let returnBooking = null;

    // Também isolado: a ida está paga, e um erro aqui não pode
    // impedir a confirmação de sair.
    try {
    if (metadata.trip_group_id && metadata.return_date) {
      const returnAirport = await findPickupAirport(metadata.return_pickup);

      const returnRow = {
        ...bookingRow,
        booking_id: `${bookingRow.booking_id}-R`,
        booking_reference: bookingRow.booking_reference
          ? `${bookingRow.booking_reference}-R`
          : null,
        leg: 2,
        pickup: metadata.return_pickup,
        dropoff: metadata.return_dropoff,
        booking_date: metadata.return_date,
        booking_time: metadata.return_time || null,
        pickup_airport: returnAirport.iata || null,
        pickup_city: returnAirport.city || null,
        price: metadata.return_price ? Number(metadata.return_price) : bookingRow.price,
        price_eur: metadata.return_price_eur
          ? Number(metadata.return_price_eur)
          : bookingRow.price_eur,
        // O voo é o da chegada. Na volta o cliente está a partir, e
        // um número de voo errado faria o motorista esperar por um
        // avião que não vem.
        flight_number: null,
        // Uma cobrança só, registada na ida. Duplicar aqui daria dois
        // débitos para uma compra.
        stripe_checkout_session_id: `${session.id}-R`,
        settled_eur: null,
        stripe_fee_eur: null,
        balance_transaction_id: null,
        // A volta é mais tarde: tem a sua própria janela de cobrança.
        charge_at: payLater
          ? new Date(
              new Date(`${metadata.return_date}T${metadata.return_time || '00:00'}`).getTime()
              - 48 * 36e5
            ).toISOString()
          : null
      };

      const { data: savedReturn, error: returnError } = await supabase
        .from('bookings')
        .upsert(returnRow, { onConflict: 'stripe_checkout_session_id' })
        .select()
        .single();

      if (returnError) {
        // A ida está paga e gravada. Falhar aqui não pode desfazer
        // isso — mas alguém tem de saber que falta uma perna.
        console.error('Return leg failed:', returnError);

        await notifyOps('Return leg was not created', [
          `Outbound: ${bookingRow.booking_reference || bookingRow.booking_id}`,
          `Customer: ${bookingRow.full_name} (${bookingRow.email})`,
          `Return: ${metadata.return_pickup} to ${metadata.return_dropoff}`,
          `On ${metadata.return_date} at ${metadata.return_time || '(no time)'}`,
          `Error: ${returnError.message}`,
          '',
          'The customer paid for both legs. Create the return by hand.'
        ]);
      } else {
        returnBooking = savedReturn;

        await Promise.all([
          supabase.from('bookings')
            .update({ paired_booking_id: savedReturn.id })
            .eq('id', savedBooking.id),
          supabase.from('bookings')
            .update({ paired_booking_id: savedBooking.id })
            .eq('id', savedReturn.id)
        ]);

        console.log('Return leg created:', savedReturn.booking_id);
      }
    }
    } catch (error) {
      console.error('[webhook] return leg step failed, carrying on:', error.message);
    }

    // Dois emails diferentes: quem pagou já recebe a confirmação,
    // quem só guardou o cartão recebe a data em que será cobrado.
    // Mandar a mesma coisa aos dois faria alguém pensar que já pagou.
    // Um email para a viagem toda, não um por perna. Dois emails
    // para uma compra fariam o cliente pensar que reservou duas vezes.
    //
    // O resultado fica no log, para se perceber sem adivinhar se o
    // email saiu, foi descartado por duplicado, ou falhou.
    try {
      const emailResult = payLater
        ? await sendCardSaved(savedBooking, bookingRow.charge_at, returnBooking)
        : await sendBookingConfirmation(savedBooking, passwordLink, returnBooking);

      console.log('[webhook] confirmation email:', {
        booking: savedBooking.booking_id || savedBooking.id,
        to: savedBooking.passenger_email || savedBooking.email,
        mode: payLater ? 'card_saved' : 'booking_confirmed',
        sent: emailResult.sent,
        reason: emailResult.reason || null
      });

      // Um cliente que pagou e não recebeu confirmação é um
      // telefonema garantido. Melhor saberes tu primeiro.
      if (!emailResult.sent && emailResult.reason !== 'duplicate') {
        await notifyOps('A customer did not get their confirmation', [
          `Booking: ${savedBooking.booking_reference || savedBooking.booking_id}`,
          `Customer: ${savedBooking.full_name} (${savedBooking.email})`,
          `Reason: ${emailResult.reason || 'unknown'}`,
          '',
          'They have paid and the booking exists. Send it by hand.'
        ]);
      }
    } catch (error) {
      console.error('[webhook] confirmation email threw:', error);
    }
  }

  // ============================================================
  // OS OUTROS EVENTOS
  //
  // O webhook só tratava o checkout.session.completed. Faltavam os
  // três que custam dinheiro: um pagamento que falha depois de
  // aprovado, um reembolso feito no painel do Stripe, e uma disputa
  // — que é perdida por omissão se ninguém responder em sete dias.
  // ============================================================

  /**
   * Já tratámos este evento?
   *
   * O Stripe reenvia até receber 200. Se a nossa resposta se perder
   * na rede, ele volta — e sem esta verificação um reembolso de 50
   * euros era registado duas vezes.
   */
  const jaTratado = async (extra = {}) => {
    try {
      const { data } = await supabase.rpc('payment_event_seen', {
        p_event_id: event.id,
        p_type: event.type,
        p_booking_id: extra.booking_id || null,
        p_intent: extra.intent || null,
        p_amount: extra.amount != null ? extra.amount / 100 : null,
        p_currency: extra.currency || null,
        p_payload: event.data.object
      });

      return data === true;
    } catch (e) {
      // Falhar aqui não deve travar o tratamento: repetir um
      // reembolso no registo é menos grave do que ignorar uma
      // disputa.
      console.error('[webhook] seen check failed:', e.message);
      return false;
    }
  };

  const marcarFeito = (erro) =>
    supabase.rpc('payment_event_done', {
      p_event_id: event.id,
      p_error: erro || null
    }).catch(() => {});

  /** A reserva a que este pagamento pertence. */
  const reservaDoIntent = async (intentId) => {
    if (!intentId) return null;

    const { data } = await supabase
      .from('bookings')
      .select('*')
      .eq('stripe_payment_intent_id', intentId)
      .maybeSingle();

    return data;
  };

  // ---------- pagamento falhado ----------
  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    const booking = await reservaDoIntent(intent.id);

    if (await jaTratado({
      booking_id: booking?.id,
      intent: intent.id,
      amount: intent.amount,
      currency: intent.currency
    })) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      const motivo = intent.last_payment_error?.message || 'The payment was declined.';

      if (booking) {
        await supabase.from('bookings').update({
          payment_status: 'failed',
          last_charge_error: motivo,
          updated_at: new Date().toISOString()
        }).eq('id', booking.id);

        /**
         * O cliente tem de saber, e depressa.
         *
         * Um pagamento que falha silenciosamente é uma viagem que
         * ninguém vai fazer — e o cliente só descobre no aeroporto.
         */
        try {
          /**
           * O sendChargeFailed espera { attempt, willRetry }.
           *
           * Este caminho é diferente do charge-due: aqui o Stripe
           * já recusou, e não há tentativa automática a seguir — o
           * cliente tem de vir mudar o cartão.
           */
          await sendChargeFailed(booking, { attempt: 1, willRetry: false });
        } catch (e) {
          console.error('[webhook] charge-failed email:', e.message);
        }
      }

      await notifyOps('Payment failed', [
        `Intent: ${intent.id}`,
        booking
          ? `Booking: ${booking.booking_reference || booking.id}`
          : 'No booking found for this intent.',
        `Amount: ${(intent.amount / 100).toFixed(2)} ${String(intent.currency).toUpperCase()}`,
        `Reason: ${motivo}`
      ]);

      await marcarFeito();
    } catch (e) {
      await marcarFeito(e.message);
      console.error('[webhook] payment_failed:', e.message);
    }

    return res.json({ received: true });
  }

  // ---------- reembolso ----------
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const booking = await reservaDoIntent(charge.payment_intent);

    if (await jaTratado({
      booking_id: booking?.id,
      intent: charge.payment_intent,
      amount: charge.amount_refunded,
      currency: charge.currency
    })) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      const devolvido = charge.amount_refunded / 100;
      const total = charge.amount / 100;
      const parcial = charge.amount_refunded < charge.amount;

      if (booking) {
        /**
         * Um reembolso pode vir do painel do Stripe, sem passar por
         * aqui. Sem este evento, a reserva ficava "paga" na nossa
         * base e reembolsada no Stripe — e os números deixavam de
         * bater sem ninguém perceber porquê.
         */
        await supabase.from('bookings').update({
          refunded_amount: devolvido,
          refunded_at: new Date().toISOString(),
          payment_status: parcial ? 'partially_refunded' : 'refunded',
          // Um reembolso total cancela a viagem. Um parcial não:
          // pode ser um desconto acordado depois da reserva.
          status: parcial ? booking.status : 'cancelled',
          updated_at: new Date().toISOString()
        }).eq('id', booking.id);
      }

      await notifyOps(parcial ? 'Partial refund' : 'Refund', [
        booking
          ? `Booking: ${booking.booking_reference || booking.id}`
          : 'No booking found.',
        `Refunded: ${devolvido.toFixed(2)} of ${total.toFixed(2)} ` +
          String(charge.currency).toUpperCase(),
        booking && parcial ? 'The booking is still active.' : '',
        'Made in the Stripe dashboard or by our own refund route.'
      ].filter(Boolean));

      await marcarFeito();
    } catch (e) {
      await marcarFeito(e.message);
      console.error('[webhook] charge.refunded:', e.message);
    }

    return res.json({ received: true });
  }

  // ---------- disputa ----------
  if (event.type === 'charge.dispute.created' ||
      event.type === 'charge.dispute.updated' ||
      event.type === 'charge.dispute.closed') {
    const dispute = event.data.object;
    const booking = await reservaDoIntent(dispute.payment_intent);

    if (await jaTratado({
      booking_id: booking?.id,
      intent: dispute.payment_intent,
      amount: dispute.amount,
      currency: dispute.currency
    })) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      // O prazo vem em segundos desde 1970.
      const prazo = dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000)
        : null;

      const aberta = event.type === 'charge.dispute.created';
      const fechada = event.type === 'charge.dispute.closed';

      if (booking) {
        await supabase.from('bookings').update({
          dispute_status: dispute.status,
          dispute_reason: dispute.reason,
          dispute_amount: dispute.amount / 100,
          dispute_due_by: prazo ? prazo.toISOString() : null,
          dispute_opened_at: aberta
            ? new Date().toISOString()
            : booking.dispute_opened_at,
          updated_at: new Date().toISOString()
        }).eq('id', booking.id);
      }

      /**
       * Uma disputa é o evento mais caro que existe.
       *
       * O Stripe dá um prazo para responder com provas. Passado sem
       * resposta, perde-se por omissão — e além do valor da viagem
       * cobram uma taxa de disputa que ronda os 15 euros.
       *
       * Por isso o email é diferente dos outros: diz o prazo em
       * dias, e diz o que fazer.
       */
      const dias = prazo
        ? Math.max(0, Math.ceil((prazo - Date.now()) / 86400000))
        : null;

      const titulo = fechada
        ? `Dispute ${dispute.status}`
        : aberta
          ? 'DISPUTE OPENED — action needed'
          : `Dispute updated: ${dispute.status}`;

      await notifyOps(titulo, [
        booking
          ? `Booking: ${booking.booking_reference || booking.id}`
          : 'No booking found for this charge.',
        booking ? `Customer: ${booking.full_name} (${booking.email})` : '',
        booking ? `Trip: ${booking.pickup} to ${booking.dropoff} on ${booking.booking_date}` : '',
        `Amount: ${(dispute.amount / 100).toFixed(2)} ${String(dispute.currency).toUpperCase()}`,
        `Reason given: ${dispute.reason}`,
        `Status: ${dispute.status}`,
        '',
        fechada
          ? (dispute.status === 'won'
              ? 'We kept the money.'
              : 'The money is gone, plus the dispute fee.')
          : dias != null
            ? `RESPOND WITHIN ${dias} DAY${dias === 1 ? '' : 'S'}. ` +
              'Without a reply the dispute is lost by default, and the ' +
              'dispute fee is charged on top of the amount.'
            : 'Check the deadline in the Stripe dashboard.',
        '',
        aberta
          ? 'Evidence to send: the booking confirmation email, the driver ' +
            'assignment, and anything showing the trip happened.'
          : '',
        `https://dashboard.stripe.com/disputes/${dispute.id}`
      ].filter(Boolean));

      await marcarFeito();
    } catch (e) {
      await marcarFeito(e.message);
      console.error('[webhook] dispute:', e.message);
    }

    return res.json({ received: true });
  }

  /**
   * Os que não tratamos ficam registados na mesma.
   *
   * Quando um dia alguém perguntar "porque é que este pagamento
   * está assim", o registo responde — mesmo para eventos que nunca
   * chegámos a programar.
   */
  if (event.type !== 'checkout.session.completed') {
    await jaTratado().catch(() => {});
    await marcarFeito();
  }

  return res.json({ received: true });
});

// ============================================================
// COBRANÇA AGENDADA
//
// Chamado de hora a hora por um cron externo. Não é uma rota pública:
// exige um segredo no cabeçalho, senão qualquer pessoa disparava
// cobranças no teu Stripe.
//
// cron-job.org → POST https://airportlink.onrender.com/api/tasks/charge-due
//                cabeçalho: x-cron-secret: <CRON_SECRET>
// ============================================================
/**
 * Testar o email sem fazer uma reserva.
 *
 * Existe porque diagnosticar "não recebi nada" através de uma
 * reserva real mistura três coisas que podem falhar: o Stripe, o
 * webhook e o email. Isto testa só a última.
 *
 * Protegido pelo mesmo segredo do cron: não é uma rota pública.
 */
app.post('/api/tasks/test-email', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const to = (req.body && req.body.to) || process.env.EMAIL_OPERATIONS;
  if (!to) {
    return res.status(400).json({ error: 'Send { "to": "you@example.com" } or set EMAIL_OPERATIONS.' });
  }

  const checks = {
    resend_key: Boolean(process.env.RESEND_API_KEY),
    from: process.env.EMAIL_FROM_BOOKINGS || process.env.EMAIL_FROM || '(default)',
    reply_to: process.env.EMAIL_REPLY_TO || '(default)',
    email_log_table: null,
    delivered: false,
    error: null
  };

  // A email_log existe? É a causa mais provável de nada sair: sem a
  // tabela, o registo falha e o envio é abandonado antes de começar.
  try {
    const { error } = await supabase.from('email_log').select('id').limit(1);
    checks.email_log_table = error ? `MISSING — ${error.message}` : 'ok';
  } catch (error) {
    checks.email_log_table = `MISSING — ${error.message}`;
  }

  // Envio direto, sem passar pelo registo: queremos saber se o
  // Resend aceita, separado de tudo o resto.
  try {
    const result = await notifyOps('Test email', [
      'If you are reading this, Resend is working.',
      `Sent at ${new Date().toISOString()}`,
      `From: ${checks.from}`
    ], to);
    checks.delivered = result.sent;
    if (!result.sent) checks.error = result.reason || 'unknown';
  } catch (error) {
    checks.error = error.message;
  }

  console.log('[email] test run:', checks);

  return res.json({ to, ...checks });
});

/**
 * O correio de todos os dias.
 *
 * Uma só chamada trata do que depende do calendário: os detalhes do
 * motorista na véspera, os documentos a expirar, e o aviso interno
 * das viagens que ninguém quis.
 *
 * Corre uma vez por dia, de manhã. Não de hora a hora: um lembrete
 * que chega às três da manhã é pior do que nenhum.
 *
 * cron-job.org → POST /api/tasks/daily-emails, às 09:15
 */
/**
 * Envio de emails para o serviço dos motoristas.
 *
 * O emailService vive aqui e só aqui. O outro serviço pede a esta
 * rota em vez de ter uma cópia do ficheiro — duas cópias divergem
 * sempre, e no dia em que divergem um dos dois manda o texto antigo.
 *
 * A proteção é o CRON_SECRET, mas não é só isso: os modelos são uma
 * LISTA FECHADA. Quem tivesse o segredo não poderia mandar um email
 * qualquer a partir do nosso domínio — apenas disparar um destes
 * três, que são inofensivos fora de contexto.
 */
const INTERNAL_TEMPLATES = {
  partner_received: (p) => sendPartnerApplicationReceived(p.partner),
  partner_decision: (p) => sendPartnerDecision(p.partner, p.decision, p.reason),
  ride_confirmed: (p) => sendRideConfirmedToPartner(p.partner, p.booking),
  // O link de confirmação só pode ser gerado aqui: é este serviço
  // que tem o cliente com service_role.
  verify_email: (p) => sendVerification(p.email, p.name, p.kind || 'partner'),

  /**
   * Um parceiro à espera há dez minutos com um agente atribuído.
   *
   * Vai para o endereço de operações e não para o agente: o agente
   * já viu o aviso no painel duas vezes. Este email existe para o
   * caso de ele não estar a ver o painel de todo.
   */
  support_escalation: async (p) => {
    const nome = p.partner_name || 'A partner';
    const min = p.waiting_minutes || 10;

    await notifyOps(`${nome} has been waiting ${min} minutes for a reply`, [
      `Partner: ${nome}`,
      `Waiting: ${min} minutes since their last message`,
      'The conversation is assigned to an agent — it is not sitting in the queue.',
      'Somebody took it and has not answered.',
      `Chat: ${p.chat_id || '(unknown)'}`
    ]);

    return { sent: true };
  }
};

app.post('/api/internal/email', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    console.warn('internal/email called with a bad secret');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { template, payload } = req.body || {};
  const handler = INTERNAL_TEMPLATES[template];

  if (!handler) {
    return res.status(400).json({
      error: `Unknown template: ${template}`,
      allowed: Object.keys(INTERNAL_TEMPLATES)
    });
  }

  try {
    const result = await handler(payload || {});
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('internal/email error:', error);
    return res.status(500).json({ error: 'Could not send that email.' });
  }
});

/**
 * Todos os modelos de email, de uma vez, para um endereço.
 *
 * Rever um email a um obriga a provocar cada acontecimento: pagar,
 * cancelar, deixar uma cobrança falhar. Uma revisão de texto não
 * devia custar isso.
 *
 * Demora cerca de doze segundos: há uma pausa entre cada um porque
 * o Resend limita a dois por segundo no plano gratuito.
 */
app.post('/api/tasks/preview-emails', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const to = (req.body && req.body.to) || process.env.EMAIL_OPERATIONS;
  if (!to) {
    return res.status(400).json({ error: 'Send { "to": "you@example.com" }.' });
  }

  const results = await previewAll(to);
  const sent = results.filter((r) => r.sent).length;

  console.log(`[email] preview: ${sent}/${results.length} sent to ${to}`);

  return res.json({ to, sent, total: results.length, results });
});

/**
 * Envia os dados do motorista de uma viagem.
 *
 * Usada pelo cron e pelo botão do admin. A ordem importa: um
 * motorista posto à mão ganha sempre ao do parceiro, porque foi
 * posto à mão precisamente quando o do parceiro não servia.
 */
async function sendDriverDetailsFor(ride) {
  let driver = null;
  let vehicle = null;

  if (ride.manual_driver_name) {
    driver = {
      full_name: ride.manual_driver_name,
      phone: ride.manual_driver_phone || ''
    };
    vehicle = ride.manual_vehicle
      ? {
          make: ride.manual_vehicle,
          model: '',
          plate: ride.manual_vehicle_plate || ''
        }
      : null;
  } else if (ride.assigned_partner_id) {
    const [driverRes, vehicleRes] = await Promise.all([
      supabase.from('drivers').select('*')
        .eq('partner_id', ride.assigned_partner_id)
        .eq('status', 'active').order('created_at').limit(1).maybeSingle(),
      supabase.from('partner_vehicles').select('*')
        .eq('partner_id', ride.assigned_partner_id)
        .eq('status', 'active')
        .gte('seats', ride.passengers || 1)
        .order('seats').limit(1).maybeSingle()
    ]);

    driver = driverRes.data;
    vehicle = vehicleRes.data;
  }

  if (!driver) {
    // Sem motorista não há email. É um problema real, porque a
    // viagem é amanhã e o cliente não sabe quem o vai buscar.
    await notifyOps('Ride tomorrow with no driver', [
      `Reference: ${ride.booking_reference || ride.booking_id}`,
      `Route: ${ride.pickup} to ${ride.dropoff}`,
      `Pick-up: ${ride.booking_date} ${String(ride.booking_time || '').slice(0, 5)}`,
      ride.assigned_partner_id
        ? 'A partner took this ride but has no active driver on file.'
        : 'Nobody has taken this ride.',
      '',
      'Add a driver by hand in the admin, or put the email on hold.'
    ]);

    return { sent: false, reason: 'no-driver' };
  }

  const result = await sendDriverDetails(ride, driver, vehicle);

  if (result.sent) {
    await supabase.from('bookings').update({
      driver_details_sent_at: new Date().toISOString()
    }).eq('id', ride.id);
  }

  return result;
}

/**
 * Suster, libertar, ou pôr um motorista à mão.
 *
 * Uma rota para as três coisas porque são a mesma decisão vista de
 * ângulos diferentes: quem vai buscar o cliente amanhã.
 */
app.post('/api/admin/ride-driver', async (req, res) => {
  const { user: admin, error: adminError } = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

  const { booking_id, action, driver, reason } = req.body || {};

  if (!booking_id || !['hold', 'release', 'manual', 'send'].includes(action)) {
    return res.status(400).json({
      error: 'Send booking_id and action: hold, release, manual or send.'
    });
  }

  try {
    if (action === 'hold') {
      await supabase.from('bookings').update({
        driver_email_hold: true,
        driver_email_hold_reason: reason || null,
        updated_at: new Date().toISOString()
      }).eq('id', booking_id);

      return res.json({ success: true, held: true });
    }

    if (action === 'release') {
      await supabase.from('bookings').update({
        driver_email_hold: false,
        driver_email_hold_reason: null,
        updated_at: new Date().toISOString()
      }).eq('id', booking_id);

      return res.json({ success: true, held: false });
    }

    if (action === 'manual') {
      if (!driver?.name || !driver?.phone) {
        return res.status(400).json({
          error: 'A name and a phone number are the minimum — the passenger calls that number.'
        });
      }

      await supabase.from('bookings').update({
        manual_driver_name: driver.name,
        manual_driver_phone: driver.phone,
        manual_vehicle: driver.vehicle || null,
        manual_vehicle_plate: driver.plate || null,
        manual_driver_note: driver.note || null,
        // Pôr um motorista à mão levanta a retenção: a razão para a
        // suspender era não haver motorista, e agora há.
        driver_email_hold: false,
        driver_email_hold_reason: null,
        updated_at: new Date().toISOString()
      }).eq('id', booking_id);

      console.log('Manual driver set:', { by: admin.email, booking: booking_id });

      return res.json({ success: true });
    }

    // send
    const { data: ride } = await supabase.from('bookings')
      .select('*').eq('id', booking_id).maybeSingle();

    if (!ride) return res.status(404).json({ error: 'That booking no longer exists.' });

    // O envio manual ignora a marca de já enviado: às vezes é
    // preciso reenviar porque o motorista mudou.
    await supabase.from('bookings').update({
      driver_details_sent_at: null
    }).eq('id', booking_id);

    const result = await sendDriverDetailsFor({ ...ride, driver_details_sent_at: null });

    if (!result.sent) {
      return res.status(400).json({
        error: result.reason === 'no-driver'
          ? 'There is no driver for this ride yet. Add one by hand first.'
          : (result.reason || 'Could not send.')
      });
    }

    return res.json({ success: true, sent: true });
  } catch (error) {
    console.error('admin/ride-driver error:', error);
    return res.status(500).json({ error: 'Could not update that ride.' });
  }
});

/**
 * Os extratos do mês passado.
 *
 * Corre uma vez por mês, no dia 1. Se correr duas vezes não faz mal:
 * a chave de idempotência inclui o mês, e o segundo envio é
 * descartado antes de sair.
 *
 * cron-job.org → POST /api/tasks/monthly-statements
 *                dia 1 de cada mês, 09:30
 *
 * Aceita { "month": "2026-07" } para reenviar um mês concreto —
 * útil quando alguém pede o extrato de há três meses.
 */
app.post('/api/tasks/monthly-statements', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Por omissão, o mês passado: no dia 1 é esse que interessa.
  let month = req.body && req.body.month;

  if (!month) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    month = d.toISOString().slice(0, 7);
  }

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must look like 2026-07.' });
  }

  const from = `${month}-01`;
  const to = new Date(month + '-01T12:00:00');
  to.setMonth(to.getMonth() + 1);
  const until = to.toISOString().slice(0, 10);

  const out = { month, partners: 0, agents: 0, skipped: 0, errors: [] };

  // ---------- parceiros ----------
  try {
    const { data: rides, error } = await supabase
      .from('bookings')
      .select('id, booking_id, booking_reference, pickup, dropoff, booking_date, ' +
              'booking_time, driver_payout, driver_payout_eur, currency, assigned_partner_id')
      .not('assigned_partner_id', 'is', null)
      .neq('status', 'cancelled')
      .gte('booking_date', from)
      .lt('booking_date', until)
      .order('booking_date');

    if (error) throw error;

    const byPartner = new Map();

    for (const ride of (rides || [])) {
      if (!byPartner.has(ride.assigned_partner_id)) {
        byPartner.set(ride.assigned_partner_id, []);
      }
      byPartner.get(ride.assigned_partner_id).push(ride);
    }

    for (const [partnerId, list] of byPartner) {
      const { data: partner } = await supabase
        .from('driver_partners')
        .select('id, email, legal_name, trading_name, payout_iban, status')
        .eq('id', partnerId).maybeSingle();

      if (!partner?.email) {
        out.skipped += 1;
        continue;
      }

      // Em euros, à taxa do dia de cada viagem — nunca à de hoje.
      const total = list.reduce((t, r) =>
        t + Number(r.driver_payout_eur || r.driver_payout || 0), 0);

      const result = await sendPartnerStatement(partner, month, list, total);
      if (result.sent) out.partners += 1;

      if (!partner.payout_iban) {
        await notifyOps('Partner with no IBAN has money owed', [
          `Partner: ${partner.legal_name} (${partner.email})`,
          `Month: ${month}`,
          `Rides: ${list.length}`,
          `Owed: EUR ${total.toFixed(2)}`,
          '',
          'They cannot be paid until they add payout details.'
        ]);
      }
    }
  } catch (error) {
    out.errors.push('partners: ' + error.message);
  }

  // ---------- agências ----------
  try {
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('id, booking_id, booking_reference, booking_date, passenger_name, ' +
              'price, price_eur, agent_gross_price, currency, agent_reference, booked_by')
      .not('booked_by', 'is', null)
      .neq('status', 'cancelled')
      .gte('booking_date', from)
      .lt('booking_date', until)
      .order('booking_date');

    if (error) throw error;

    const byAgent = new Map();

    for (const b of (bookings || [])) {
      if (!byAgent.has(b.booked_by)) byAgent.set(b.booked_by, []);
      byAgent.get(b.booked_by).push(b);
    }

    for (const [agentId, list] of byAgent) {
      const { data: agent } = await supabase
        .from('travel_agents')
        .select('id, email, agency_name, commission, status')
        .eq('id', agentId).maybeSingle();

      if (!agent?.email) {
        out.skipped += 1;
        continue;
      }

      const paid = list.reduce((t, b) => t + Number(b.price_eur || b.price || 0), 0);
      const gross = list.reduce((t, b) =>
        t + Number(b.agent_gross_price || b.price_eur || b.price || 0), 0);

      const result = await sendAgentStatement(agent, month, list, { paid, gross });
      if (result.sent) out.agents += 1;
    }
  } catch (error) {
    out.errors.push('agents: ' + error.message);
  }

  console.log('[monthly-statements]', out);

  // Um resumo para ti, para saberes que correu sem ires aos logs.
  await notifyOps(`Statements sent for ${month}`, [
    `${out.partners} partner statement(s)`,
    `${out.agents} agency statement(s)`,
    out.skipped ? `${out.skipped} skipped (no email on file)` : '',
    out.errors.length ? 'Errors: ' + out.errors.join(' · ') : ''
  ].filter(Boolean));

  return res.json({ ok: true, ...out });
});

app.post('/api/tasks/daily-emails', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const out = {
    driver_details: 0, held: 0, no_driver: 0,
    expiring: 0, expired: 0, unclaimed: 0, errors: []
  };

  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  // ---------- 1. o motorista, na véspera ----------
  try {
    // Sem filtro por assigned_partner_id: uma viagem com motorista
    // manual pode não ter parceiro nenhum, e é precisamente essa que
    // interessa não esquecer.
    const { data: rides } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_date', day(1))
      .neq('status', 'cancelled')
      .is('driver_details_sent_at', null);

    for (const ride of (rides || [])) {
      if (ride.driver_email_hold) {
        out.held += 1;
        continue;
      }

      const result = await sendDriverDetailsFor(ride);

      if (result.sent) out.driver_details += 1;
      else if (result.reason === 'no-driver') out.no_driver += 1;
    }
  } catch (error) {
    out.errors.push('driver_details: ' + error.message);
  }

  // ---------- 2. documentos a expirar ----------
  try {
    const { data: docs } = await supabase
      .from('compliance_documents')
      .select('*, driver_partners!inner(id, email, legal_name, status)')
      .not('expires_on', 'is', null)
      .lte('expires_on', day(30));

    for (const doc of (docs || [])) {
      const partner = doc.driver_partners;
      if (!partner || partner.status === 'rejected') continue;

      const daysLeft = Math.round(
        (new Date(doc.expires_on).getTime() - Date.now()) / 864e5
      );

      // Avisamos aos 30, aos 7, e no dia em que expira. Todos os
      // dias seria assédio; só uma vez seria fácil de perder.
      if (![30, 7, 1].includes(daysLeft) && daysLeft > 0) continue;

      const result = await sendDocumentExpiring(partner, doc, daysLeft);
      if (result.sent) {
        if (daysLeft <= 0) out.expired += 1;
        else out.expiring += 1;
      }
    }
  } catch (error) {
    out.errors.push('expiring: ' + error.message);
  }

  // ---------- 3. viagens que ninguém quis ----------
  try {
    const { data: orphans } = await supabase
      .from('unclaimed_rides')
      .select('*')
      .lte('hours_to_pickup', 48);

    if ((orphans || []).length) {
      out.unclaimed = orphans.length;

      await notifyOps(`${orphans.length} ride(s) with no partner`, [
        'These are within 48 hours of pick-up and nobody has taken them.',
        '',
        ...orphans.map((r) =>
          `${r.booking_reference || r.booking_id} — ${r.pickup_airport || 'NO AIRPORT'} — ` +
          `${r.booking_date} ${String(r.booking_time || '').slice(0, 5)} — ` +
          `${Math.round(r.hours_to_pickup)}h left — ` +
          `${r.partners_that_can_see_it} partner(s) can see it`),
        '',
        'Where the airport is missing, the pick-up text did not match any airport ' +
        'and the ride cannot reach anyone.'
      ]);
    }
  } catch (error) {
    out.errors.push('unclaimed: ' + error.message);
  }

  console.log('[daily-emails]', out);
  return res.json({ ok: true, ...out });
});

app.post('/api/tasks/charge-due', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    console.warn('charge-due called with a bad secret');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const rules = await getPaymentRules();
  const results = { checked: 0, charged: 0, failed: 0, abandoned: 0, skipped: 0 };

  try {
    const { data: due, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('payment_mode', 'later')
      .is('charged_at', null)
      .neq('status', 'cancelled')
      .lte('charge_at', new Date().toISOString())
      .lt('charge_attempts', rules.max_charge_attempts)
      .limit(50);

    if (error) throw error;

    for (const booking of (due || [])) {
      results.checked += 1;

      // Uma tentativa falhada volta a ser elegível só depois do
      // intervalo. Sem isto, o cron de hora a hora queimava as três
      // tentativas em três horas.
      if (booking.charge_attempts > 0 && booking.updated_at) {
        const since = (Date.now() - new Date(booking.updated_at).getTime()) / 36e5;
        if (since < rules.retry_interval_hours) {
          results.skipped += 1;
          continue;
        }
      }

      if (!booking.stripe_payment_method_id || !booking.stripe_customer_id) {
        results.skipped += 1;
        continue;
      }

      const attemptNo = (booking.charge_attempts || 0) + 1;
      const currency = booking.currency || 'EUR';
      const amount = toStripeAmount(Number(booking.price || 0), currency);

      try {
        const intent = await stripe.paymentIntents.create({
          amount,
          currency: currency.toLowerCase(),
          customer: booking.stripe_customer_id,
          payment_method: booking.stripe_payment_method_id,
          // off_session: o cliente não está no site. O banco pode
          // recusar por isso mesmo, e é esse o caso que tratamos abaixo.
          off_session: true,
          confirm: true,
          metadata: {
            booking_id: String(booking.booking_id || booking.id),
            scheduled_charge: 'true'
          }
        });

        await supabase.from('bookings').update({
          charged_at: new Date().toISOString(),
          charge_attempts: attemptNo,
          payment_status: 'paid',
          status: 'paid',
          amount_total: intent.amount,
          stripe_payment_intent_id: intent.id,
          last_charge_error: null,
          updated_at: new Date().toISOString()
        }).eq('id', booking.id);

        await supabase.from('charge_attempts').insert({
          booking_id: booking.id, attempt_no: attemptNo, outcome: 'succeeded',
          amount: Number(booking.price || 0), currency, stripe_id: intent.id
        });

        results.charged += 1;
        console.log('Scheduled charge succeeded:', booking.booking_id || booking.id);
        await sendChargeSucceeded(booking);
      } catch (error) {
        const code = error.code || error.decline_code || 'unknown';
        const needsCustomer = code === 'authentication_required';
        const giveUp = attemptNo >= rules.max_charge_attempts;

        await supabase.from('charge_attempts').insert({
          booking_id: booking.id, attempt_no: attemptNo,
          outcome: needsCustomer ? 'requires_action' : 'failed',
          amount: Number(booking.price || 0), currency,
          error_code: code, error_message: error.message
        });

        await supabase.from('bookings').update({
          charge_attempts: attemptNo,
          last_charge_error: `${code}: ${error.message}`,
          payment_status: giveUp ? 'charge_abandoned' : 'charge_failed',
          // Desistir cancela a reserva: manter uma viagem por pagar
          // significa mandar um motorista a um serviço que ninguém
          // pagou. Melhor libertá-lo com antecedência.
          status: giveUp ? 'cancelled' : booking.status,
          assigned_partner_id: giveUp ? null : booking.assigned_partner_id,
          updated_at: new Date().toISOString()
        }).eq('id', booking.id);

        await sendChargeFailed(booking, { attempt: attemptNo, willRetry: !giveUp });

        if (giveUp) {
          results.abandoned += 1;
          console.error('Charge abandoned, booking cancelled:', booking.booking_id || booking.id, code);

          // Um aviso para dentro: alguém tem de saber que uma reserva
          // foi cancelada por não haver pagamento, sobretudo se já
          // tinha motorista atribuído.
          await notifyOps('Booking cancelled — payment failed', [
            `Reference: ${booking.booking_reference || booking.booking_id}`,
            `Customer: ${booking.full_name || ''} (${booking.email})`,
            `Pick-up: ${booking.booking_date} ${String(booking.booking_time || '').slice(0, 5)}`,
            `Route: ${booking.pickup} to ${booking.dropoff}`,
            `Amount: ${booking.currency} ${booking.price}`,
            `Last error: ${code} — ${error.message}`,
            booking.assigned_partner_id
              ? 'A partner had already taken this ride and has been released.'
              : 'No partner had taken it.'
          ]);
        } else {
          results.failed += 1;
          console.warn('Charge failed, will retry:', booking.booking_id || booking.id, code);
        }
      }
    }

    return res.json({ ok: true, ...results });
  } catch (error) {
    console.error('charge-due error:', error);
    return res.status(500).json({ error: 'Charge run failed.', ...results });
  }
});

app.listen(PORT, async () => {
  // Uma leitura qualquer confirma que a chave é a certa. Mais vale
  // descobrir aqui do que na primeira reserva, com um cliente à
  // espera e um "permission denied" no log.
  await checkConnection();

  console.log(`Server running on ${PORT}`);
  await loadExchangeRates();
});
