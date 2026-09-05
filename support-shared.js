/**
 * support-shared.js — as peças que as duas metades usam
 * ---------------------------------------------------------------
 * O partners.js tinha 87 KB e 53 rotas: o portal de motoristas e o
 * call centre inteiro no mesmo ficheiro. Cresceu assim porque cada
 * rota nova ia parar onde o requireAdmin já estava — e o nome
 * deixou de descrever o conteúdo.
 *
 * Está agora dividido em três:
 *
 *   support-shared.js   isto: o que ambos usam
 *   partners.js         o portal: registo, documentos, frota
 *   support.js          o call centre: filas, estados, métricas
 *
 * Nada mudou de comportamento. É o mesmo código noutros ficheiros.
 * ---------------------------------------------------------------
 */

import { createClient } from '@supabase/supabase-js';


/**
 * As peças comuns, criadas uma vez e passadas às duas metades.
 *
 * Recebe as dependências em vez de as importar: assim este módulo
 * não sabe nada sobre como o servidor está montado, e testá-lo não
 * obriga a levantar meia aplicação.
 */
export function createShared({
  supabase,
  getUserFromRequest,
  // As funções de email. O notify usa-as, e ele é partilhado pelas
  // duas metades — daí viverem aqui e não em cada uma.
  email = {},
  config = {}
}) {
  if (!supabase) throw new Error('createShared: supabase is required');
  if (!getUserFromRequest) throw new Error('createShared: getUserFromRequest is required');

  // As funções de email vêm por injeção, não por import: o
  // emailService vive no outro serviço, e importá-lo daqui obrigaria
  // a manter duas cópias. Sem elas o portal funciona na mesma —
  // apenas não avisa ninguém.
  /**
   * Um cliente que age como o utilizador do pedido.
   *
   * O terceiro argumento do .rpc() do supabase-js são opções de
   * contagem, NÃO cabeçalhos — passar Authorization ali é ignorado
   * em silêncio. O resultado era auth.uid() a null dentro da função,
   * is_admin() a devolver falso, e "Administrator access required"
   * a um administrador autenticado.
   *
   * Um cliente próprio com o token no cabeçalho global resolve.
   */
  function asUser(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

    return createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false }
      }
    );
  }

  const notify = {
    received: email.sendPartnerApplicationReceived || (async () => {}),
    decision: email.sendPartnerDecision || (async () => {}),
    ride: email.sendRideConfirmedToPartner || (async () => {}),
    // A oferta com prazo. Sem ela, o parceiro não sabe que tem uma
    // viagem à espera e a cascata expira sempre.
    rideOffer: email.sendRideOffer || (async () => {}),
    // O empurrão a meio do prazo, que é o que mais reduz o
    // ignorar.
    rideOfferReminder: email.sendRideOfferReminder || (async () => {}),
    verify: email.sendVerification || (async () => {}),
    // Sem função de escalada configurada, o aviso fica no registo.
    // O painel continua a mostrá-lo — o email é o segundo caminho,
    // para quando ninguém tem o painel aberto.
    escalation: email.sendSupportEscalation || (async () => {})
  };

  /**
   * Os requisitos do país do parceiro. Se ainda não tivermos uma
   * lista para esse país, devolvemos a genérica ('GEN') em vez de
   * nada — um parceiro em Itália tem de conseguir candidatar-se
   * antes de nós termos mapeado a legislação italiana.
   */
  function requirementsFor(all, country) {
    const local = all.filter((r) => r.country === country);
    return local.length ? local : all.filter((r) => r.country === 'GEN');
  }

  // ============================================================
  // REDE DE PARCEIROS DE MOTORISTAS
  //
  // Modelo Blacklane: o parceiro é uma EMPRESA licenciada. Ela traz os
  // seus motoristas e veículos, e é responsável pela conformidade de
  // cada um. Nada aqui é escrito pelo browser — o estado da
  // candidatura, a aprovação de documentos e a atribuição de viagens
  // passam todos por este servidor.
  // ============================================================

  const DEFAULT_COUNTRY = config.defaultCountry || 'PT';

  // Estados em que o parceiro ainda pode editar a ficha da empresa.
  // Durante a revisão fecha: senão alguém trocava a empresa por baixo
  // de uma candidatura já submetida.
  const PARTNER_EDITABLE_STATUSES = ['draft', 'rejected', 'verified', 'approved'];

  /**
   * Garante que existe linha de empresa para este utilizador.
   *
   * Uma conta pode ficar sem ela: o registo cria conta e empresa em
   * dois passos, e se o segundo falhar — ou se a conta foi criada
   * por outro caminho — fica um utilizador que consegue entrar mas
   * não consegue fazer nada. Sem esta linha falha o upload de
   * documentos, falha o chat, e o painel de administração conta
   * zero parceiros.
   *
   * Criar em rascunho é melhor do que devolver erro: o parceiro
   * continua o registo de onde estava, em vez de bater contra uma
   * parede sem explicação.
   */
  async function ensurePartnerRow(user) {
    const { data: existing } = await supabase
      .from('driver_partners')
      .select('id')
      .eq('id', user.id)
      .maybeSingle();

    if (existing) return existing;

    const meta = user.user_metadata || {};

    const { data, error } = await supabase
      .from('driver_partners')
      .insert({
        id: user.id,
        email: user.email,
        contact_name: meta.full_name || null,
        legal_name: meta.company_name || null,
        country: config.defaultCountry || 'PT',
        status: 'draft'
      })
      .select('id')
      .single();

    if (error) {
      // Corrida entre dois separadores: alguém criou entretanto.
      if (error.code === '23505') {
        const { data: retry } = await supabase
          .from('driver_partners').select('id').eq('id', user.id).maybeSingle();
        return retry || null;
      }

      console.error('ensurePartnerRow failed:', error.code, error.message);
      return null;
    }

    console.log('Recovered partner row for', user.email);
    return data;
  }

  async function loadPartnerState(userId) {
    const [partner, zones, drivers, vehicles, documents, requirements, allZones, compliance, airports] =
      await Promise.all([
        supabase.from('driver_partners').select('*').eq('id', userId).maybeSingle(),
        supabase.from('partner_zones').select('zone_code').eq('partner_id', userId),
        supabase.from('drivers').select('*').eq('partner_id', userId).neq('status', 'removed').order('created_at'),
        supabase.from('partner_vehicles').select('*').eq('partner_id', userId).neq('status', 'removed').order('created_at'),
        supabase.from('compliance_documents').select('*').eq('partner_id', userId).order('uploaded_at', { ascending: false }),
        supabase.from('document_requirements').select('*').eq('active', true).order('sort_order'),
        supabase.from('service_zones').select('*').eq('active', true).order('sort_order'),
        supabase.from('partner_compliance').select('*').eq('partner_id', userId).maybeSingle(),
        supabase.from('airports').select('*').eq('active', true).order('city')
      ]);

    const country = partner.data?.country || DEFAULT_COUNTRY;
    const allRequirements = requirements.data || [];

    return {
      partner: partner.data || null,
      zones: (zones.data || []).map((z) => z.zone_code),
      drivers: drivers.data || [],
      vehicles: vehicles.data || [],
      documents: documents.data || [],
      requirements: requirementsFor(allRequirements, country),
      serviceZones: allZones.data || [],
      airports: airports.data || [],
      compliance: compliance.data || null
    };
  }

  async function chatFor(partnerId, subject, topic, brand) {
    // Uma função do Postgres, não duas consultas daqui.
    //
    // Antes havia um índice único no partner_id e o parceiro tinha
    // uma conversa para sempre. Agora tem tickets: muitos ao longo
    // do tempo, um só aberto de cada vez. O índice passou a parcial,
    // e a corrida entre dois separadores tem de ser resolvida dentro
    // da mesma transação — daí a função.
    /**
     * O p_brand vai sempre, mesmo com uma marca só.
     *
     * O Supabase resolve a função pelo NOME e pelos argumentos que
     * lhe damos, não pela assinatura. Chamá-la com três quando ela
     * tem quatro dá "could not find the function in the schema
     * cache" — mesmo com o quarto a ter valor por omissão.
     *
     * Quando houver mais marcas, este valor passa a vir do pedido.
     */
    let { data, error } = await supabase.rpc('open_partner_chat', {
      p_partner_id: partnerId,
      p_subject: subject || null,
      p_topic: topic || 'general',
      p_brand: brand || 'airportlink'
    });

    /**
     * Se a base ainda não tiver a versão com marca, tenta sem ela.
     *
     * O SQL das marcas pode não ter corrido, e o chat não deve parar
     * por isso — foi exatamente o que aconteceu: o servidor pedia
     * três argumentos, a função tinha quatro, e ninguém conseguia
     * abrir conversa nenhuma.
     */
    if (error && /schema cache|does not exist|could not find/i.test(error.message)) {
      console.warn('open_partner_chat: retrying without brand.');

      ({ data, error } = await supabase.rpc('open_partner_chat', {
        p_partner_id: partnerId,
        p_subject: subject || null,
        p_topic: topic || 'general'
      }));
    }

    if (error) {
      console.error('open_partner_chat failed:', error.code, error.message);
      throw new Error(
        error.code === '42501'
          ? 'The drivers service does not have permission to open a chat. ' +
            'This usually means SUPABASE_SERVICE_ROLE_KEY holds the publishable key.'
          : error.message
      );
    }

    // A função devolve a linha inteira. O Supabase embrulha o
    // resultado num array quando o tipo de retorno é uma tabela.
    return Array.isArray(data) ? data[0] : data;
  }

  async function historyFor(partnerId, limit = 30) {
    const { data, error } = await supabase
      .from('partner_chat_history')
      .select('*')
      .eq('partner_id', partnerId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('history query failed:', error.message);
      return [];
    }

    return data || [];
  }


  return {
    notify,
    asUser,
    requirementsFor,
    ensurePartnerRow,
    loadPartnerState,
    chatFor,
    historyFor
  };
}
