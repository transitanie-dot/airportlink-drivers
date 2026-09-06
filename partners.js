/**
 * partners.js — o portal de motoristas
 * ---------------------------------------------------------------
 * Tudo o que uma empresa de motoristas faz na conta dela: o
 * registo, os documentos, a frota, as zonas, a agenda e o chat com
 * o apoio.
 *
 * O que o CALL CENTRE faz — as filas, os estados de agente, as
 * métricas — mudou para o support.js. Estava aqui porque o
 * requireAdmin já cá vivia, e o ficheiro chegou a 87 KB com 53
 * rotas de dois sistemas diferentes.
 *
 * As dependências entram por parâmetro em vez de serem importadas.
 * Assim este módulo não sabe nada sobre como o servidor está
 * montado.
 * ---------------------------------------------------------------
 */

import { Router } from 'express';


export function createPartnerRoutes({
  supabase,
  getUserFromRequest,
  requireAdmin,
  // As peças partilhadas com o call centre. Vêm de fora para as
  // duas metades usarem a MESMA instância — duas cópias do chatFor
  // seriam duas verdades sobre o que é uma conversa.
  shared,
  email = {},
  config = {}
}) {
  if (!supabase) throw new Error('createPartnerRoutes: supabase is required');
  if (!shared) throw new Error('createPartnerRoutes: shared is required');

  const {
    notify,
    asUser,
    ensurePartnerRow,
    loadPartnerState,
    chatFor,
    historyFor
  } = shared;

  const DEFAULT_COUNTRY = config.defaultCountry || 'PT';
  const PARTNER_EDITABLE_STATUSES = ['draft', 'rejected', 'verified', 'approved'];

  const router = Router();


  /**
   * Registo completo: conta e empresa numa só chamada.
   *
   * Feito assim porque o questionário recolhe tudo antes de existir
   * sessão. Se fossem duas chamadas, um erro na segunda deixava uma
   * conta órfã sem empresa — e a pessoa não conseguia recomeçar nem
   * continuar.
   */
  router.post('/api/partner/signup', async (req, res) => {
    const b = req.body || {};
    let createdUserId = null;

    try {
      if (!b.email || !b.password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }
      if (String(b.password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      }
      if (!b.legal_name || !b.contact_name || !b.contact_phone || !b.country) {
        return res.status(400).json({
          error: 'Company name, contact name, phone and country are required.'
        });
      }

      // Ao contrário dos clientes, aqui a confirmação é exigida. Um
      // parceiro vai ter acesso a dados de passageiros e a receber
      // dinheiro, e ninguém está a meio de uma compra ao registar-se
      // — o atrito custa pouco e vale a pena.
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: b.email,
        password: b.password,
        email_confirm: false,
        user_metadata: { full_name: b.contact_name, partner: true }
      });

      if (authError || !authData?.user) {
        return res.status(400).json({
          error: authError?.message || 'Could not create the account.'
        });
      }

      createdUserId = authData.user.id;

      await supabase.from('contacts').upsert({
        id: createdUserId,
        email: b.email,
        full_name: b.contact_name,
        phone_number: b.contact_phone,
        is_admin: false
      }, { onConflict: 'email' });

      const cities = Array.isArray(b.operating_cities)
        ? b.operating_cities.map((c) => String(c).trim()).filter(Boolean).slice(0, 40)
        : null;

      const fleetSize = parseInt(b.fleet_size, 10);

      const { error: partnerError } = await supabase.from('driver_partners').insert({
        id: createdUserId,
        email: b.email,
        legal_name: b.legal_name,
        trading_name: b.trading_name || null,
        vat_number: b.vat_number || '',
        country: b.country,
        registered_address: b.registered_address || null,
        city: b.city || null,
        postal_code: b.postal_code || null,
        contact_name: b.contact_name,
        contact_role: b.contact_role || null,
        contact_phone: b.contact_phone,
        emergency_phone: b.emergency_phone || null,
        operating_cities: cities && cities.length ? cities : null,
        operating_airports: Array.isArray(b.operating_airports) && b.operating_airports.length
          ? b.operating_airports.map((a) => String(a).toUpperCase()).slice(0, 120)
          : null,
        fleet_size: Number.isFinite(fleetSize) ? fleetSize : null,
        owner_drives: typeof b.owner_drives === 'boolean' ? b.owner_drives : null,
        heard_from: b.heard_from || null,
        status: 'draft'
      });

      if (partnerError) throw partnerError;

      console.log('Partner signed up:', { email: b.email, country: b.country });

      await notify.verify(b.email, b.contact_name, 'partner');

      return res.json({
        success: true,
        // O portal precisa de saber que não pode entrar já: com
        // email_confirm a false, o signInWithPassword é recusado.
        verification_required: true
      });
    } catch (error) {
      console.error('partner/signup error:', error);

      // Se a empresa falhou depois de a conta existir, desfazemos a
      // conta. Caso contrário a pessoa fica com um email registado
      // que não consegue usar nem reutilizar.
      if (createdUserId) {
        try {
          await supabase.auth.admin.deleteUser(createdUserId);
          console.log('Rolled back orphan account for', b.email);
        } catch (cleanupError) {
          console.error('Could not roll back account:', cleanupError.message);
        }
      }

      return res.status(500).json({
        error: 'Could not complete your registration. Please try again.'
      });
    }
  });

  // ============================================================
  // QUADRO DE VIAGENS
  //
  // O parceiro vê as viagens por atribuir dos aeroportos que serve, e
  // pega a que quiser. A corrida entre dois parceiros é resolvida
  // dentro do claim_ride, no Postgres — não aqui.
  // ============================================================

  // ============================================================
  // QUADRO DE VIAGENS
  //
  // O parceiro vê as viagens por atribuir dos aeroportos que serve, e
  // pega a que quiser. A corrida entre dois parceiros é resolvida
  // dentro do claim_ride, no Postgres — não aqui.
  // ============================================================
  router.get('/api/partner/rides', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const [available, mine, partner] = await Promise.all([
        // A vista já filtra por aeroporto e esconde os dados do
        // passageiro: só aparecem depois de a viagem ser pegada.
        supabase.from('available_rides').select('*')
          .order('booking_date', { ascending: true }).limit(120),
        supabase.from('bookings')
          .select('id, booking_id, booking_reference, pickup, dropoff, booking_date, booking_time, passengers, flight_number, notes, driver_payout, currency, status, passenger_name, passenger_phone, full_name, phone, preferred_languages, claimed_at')
          .eq('assigned_partner_id', user.id)
          .order('booking_date', { ascending: true }),
        supabase.from('driver_partners')
          .select('status, operating_airports, payout_iban').eq('id', user.id).maybeSingle()
      ]);

      if (available.error) throw available.error;
      if (mine.error) throw mine.error;

      /**
       * As ofertas dirigidas a mim, com o tempo que falta.
       *
       * Uma viagem oferecida é diferente de uma no quadro aberto:
       * tem prazo, e é minha durante esse tempo. Sem isto, o portal
       * mostrava as duas iguais e o parceiro não sabia que tinha
       * minutos contados.
       */
      const { data: ofertas } = await supabase
        .from('ride_offers')
        .select('booking_id, expires_at, match_reason, rank')
        .eq('partner_id', user.id)
        .eq('outcome', 'pending')
        .gt('expires_at', new Date().toISOString());

      const porReserva = {};

      (ofertas || []).forEach((o) => {
        porReserva[o.booking_id] = {
          minutes_left: Math.max(1,
            Math.round((new Date(o.expires_at) - Date.now()) / 60000)),
          reason: o.match_reason,
          rank: o.rank
        };
      });

      // As ofertas aparecem na lista de disponíveis, marcadas.
      const disponiveis = (available.data || []).map((r) => ({
        ...r,
        offer: porReserva[r.id] || null
      }));

      // E as que só existem como oferta — ainda não estão no quadro
      // aberto — entram na mesma lista.
      const jaListadas = new Set(disponiveis.map((r) => r.id));
      const soOferta = Object.keys(porReserva).filter((id) => !jaListadas.has(id));

      if (soOferta.length) {
        const { data: extra } = await supabase
          .from('bookings')
          .select('*')
          .in('id', soOferta);

        (extra || []).forEach((r) => {
          disponiveis.unshift({ ...r, offer: porReserva[r.id] });
        });
      }

      return res.json({
        // As ofertas primeiro: são as que têm relógio a correr.
        available: disponiveis.sort((a, b) =>
          (b.offer ? 1 : 0) - (a.offer ? 1 : 0)),
        mine: mine.data || [],
        airports: partner.data?.operating_airports || [],
        ready: partner.data?.status === 'approved' && Boolean(partner.data?.payout_iban)
      });
    } catch (error) {
      console.error('partner/rides error:', error);
      return res.status(500).json({ error: 'Could not load the ride board.' });
    }
  });


  router.post('/api/partner/rides/claim', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const { ride_id } = req.body || {};
      if (!ride_id) return res.status(400).json({ error: 'Missing ride_id' });

      // A função claim_ride existe no Postgres para quem chamar com o
      // JWT do parceiro. Aqui o cliente usa a service_role e não tem
      // auth.uid(), por isso fazemos as mesmas verificações e o mesmo
      // update condicional.
      const partnerRes = await supabase.from('driver_partners')
        .select('*').eq('id', user.id).maybeSingle();
      const partner = partnerRes.data;

      if (!partner || partner.status !== 'approved') {
        return res.status(403).json({ error: 'Your partner account is not active yet.' });
      }
      if (!partner.payout_iban) {
        return res.status(400).json({ error: 'Add your payout details before taking rides.' });
      }

      const [driversRes, vehiclesRes, rideRes] = await Promise.all([
        supabase.from('drivers').select('id').eq('partner_id', user.id).eq('status', 'active'),
        supabase.from('partner_vehicles').select('id, seats').eq('partner_id', user.id).eq('status', 'active'),
        supabase.from('bookings').select('*').eq('id', ride_id).maybeSingle()
      ]);

      const ride = rideRes.data;
      if (!ride) return res.status(404).json({ error: 'That ride no longer exists.' });

      if (!(driversRes.data || []).length) {
        return res.status(400).json({ error: 'Add at least one active driver first.' });
      }

      const seats = Math.max(0, ...(vehiclesRes.data || []).map((v) => v.seats || 0));
      if (seats < (ride.passengers || 1)) {
        return res.status(400).json({ error: 'None of your vehicles seats that many passengers.' });
      }

      const airports = partner.operating_airports || [];
      if (!ride.pickup_airport || airports.indexOf(ride.pickup_airport) === -1) {
        return res.status(400).json({ error: 'That ride is outside your service airports.' });
      }

      // A condição is null dentro do update é o que impede dois
      // parceiros de ficarem com a mesma viagem. Um IF antes do
      // update não chegava: entre o IF e o update cabe outro pedido.
      const { data: claimed, error: claimError } = await supabase
        .from('bookings')
        .update({
          assigned_partner_id: user.id,
          assigned_at: new Date().toISOString(),
          claimed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', ride_id)
        .is('assigned_partner_id', null)
        .select('id')
        .maybeSingle();

      if (claimError) throw claimError;

      if (!claimed) {
        return res.status(409).json({ error: 'Another partner took that ride first.' });
      }

      console.log('Ride claimed:', { partner: partner.email, ride: ride.booking_id || ride.id });

      // O parceiro leva a viagem por email: no dia, não vai ter o
      // portal aberto.
      await notify.ride(partner, ride);

      return res.json({ success: true });
    } catch (error) {
      console.error('rides/claim error:', error);
      return res.status(500).json({ error: 'Could not take that ride.' });
    }
  });


  /**
   * Aceitar uma viagem oferecida.
   *
   * Diferente do claim: aquele é o quadro aberto, este é a oferta
   * dirigida. Aceita se tiver oferta válida OU se a viagem já
   * passou ao quadro aberto — que é o que acontece quando ninguém
   * da cascata a quis.
   */
  /**
   * Dizer à API principal que a viagem tem motorista.
   *
   * O calendário vive lá — é onde estão as credenciais do Google.
   * Este serviço só avisa; a API trata do resto.
   */
  async function avisarCalendario(bookingId, partnerId) {
    if (!config.apiUrl || !config.cronSecret) return;

    try {
      await fetch(config.apiUrl + '/api/internal/calendar-sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': config.cronSecret
        },
        body: JSON.stringify({ booking_id: bookingId, partner_id: partnerId })
      });
    } catch (e) {
      // Uma falha aqui não desfaz a aceitação. O evento fica
      // turquesa até alguém reparar, e isso é um problema de cor,
      // não de operação.
      console.error('calendar sync:', e.message);
    }
  }

  router.post('/api/partner/rides/accept', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const { booking_id } = req.body || {};
      if (!booking_id) return res.status(400).json({ error: 'Send booking_id.' });

      const { data, error } = await asUser(req).rpc('accept_ride_offer', {
        p_booking_id: booking_id
      });

      if (error) throw error;

      if (data && data.ok === false) {
        const mensagens = {
          already_taken: 'Somebody else took this one.',
          not_offered: 'This ride is not open to you.'
        };
        return res.status(409).json({ error: mensagens[data.reason] || 'Could not accept.' });
      }

      /**
       * A viagem passa a azul escuro na agenda.
       *
       * É o que faz o calendário contar a história sem ninguém lhe
       * tocar: turquesa é uma viagem por resolver, azul é uma
       * resolvida. Um mês visto de relance diz onde faltou
       * cobertura.
       *
       * Sem esperar pela resposta: o parceiro já aceitou e não deve
       * ficar à espera do Google.
       */
      avisarCalendario(booking_id, user.id).catch(() => {});

      return res.json({ success: true });
    } catch (error) {
      console.error('rides/accept:', error);
      return res.status(500).json({ error: 'Could not accept the ride.' });
    }
  });

  /**
   * Recusar, com motivo opcional.
   *
   * Recusar NÃO penaliza. Se penalizasse, ensinávamos os parceiros
   * a aceitar tudo e a cancelar depois — muito pior para o cliente.
   *
   * O que conta contra é ignorar, e isso mede-se sozinho.
   */
  router.post('/api/partner/rides/decline', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const { booking_id, reason } = req.body || {};
      if (!booking_id) return res.status(400).json({ error: 'Send booking_id.' });

      const { data, error } = await asUser(req).rpc('decline_ride_offer', {
        p_booking_id: booking_id,
        p_reason: reason || null
      });

      if (error) throw error;

      if (data && data.ok === false) {
        return res.status(409).json({ error: 'That offer is no longer open.' });
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('rides/decline:', error);
      return res.status(500).json({ error: 'Could not decline the ride.' });
    }
  });

  /**
   * Como estou a portar-me.
   *
   * A taxa de conclusão e a de resposta, com o semáforo. Um número
   * que o parceiro vê muda o comportamento dele; escondido, não
   * muda nada.
   */
  /**
   * As últimas dez ofertas, e quantas ignorei.
   *
   * "Ignoraste 3 das últimas 10" muda mais o comportamento do que
   * qualquer penalização — e sem ensinar ninguém a aceitar tudo
   * para depois cancelar.
   *
   * Dez e não noventa dias: um número que se pode corrigir esta
   * semana move mais do que um que demora três meses a mudar.
   */
  router.get('/api/partner/recent-offers', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const { data } = await asUser(req).rpc('partner_recent_offers', {
        p_partner_id: user.id
      });

      return res.json(data || { show: false });
    } catch (error) {
      return res.json({ show: false });
    }
  });

  router.get('/api/partner/standing', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const { data } = await supabase
        .from('partner_reputation')
        .select('*')
        .eq('partner_id', user.id)
        .maybeSingle();

      return res.json(data || { standing: 'new', completion_rate: 100, response_rate: 100 });
    } catch (error) {
      return res.json({ standing: 'new' });
    }
  });

  router.post('/api/partner/rides/release', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const { ride_id, reason } = req.body || {};
      if (!ride_id) return res.status(400).json({ error: 'Missing ride_id' });

      const { data: ride } = await supabase.from('bookings')
        .select('*').eq('id', ride_id).maybeSingle();

      if (!ride || ride.assigned_partner_id !== user.id) {
        return res.status(403).json({ error: 'That ride is not yours.' });
      }

      const pickupAt = new Date(`${ride.booking_date}T${ride.booking_time || '00:00'}`);
      const hoursLeft = (pickupAt.getTime() - Date.now()) / 36e5;

      if (!Number.isFinite(hoursLeft) || hoursLeft < 24) {
        return res.status(400).json({
          error: 'Less than 24 hours to pick-up. Contact support — do not leave the passenger waiting.'
        });
      }

      const { error } = await supabase.from('bookings').update({
        assigned_partner_id: null,
        assigned_driver_id: null,
        assigned_vehicle_id: null,
        assigned_at: null,
        claimed_at: null,
        released_count: (ride.released_count || 0) + 1,
        notes: (ride.notes || '') + (reason ? `\n[released] ${reason}` : ''),
        updated_at: new Date().toISOString()
      }).eq('id', ride_id);

      if (error) throw error;

      console.warn('Ride released:', {
        partner: user.email,
        ride: ride.booking_id || ride.id,
        times: (ride.released_count || 0) + 1
      });

      return res.json({ success: true });
    } catch (error) {
      console.error('rides/release error:', error);
      return res.status(500).json({ error: 'Could not release that ride.' });
    }
  });


  router.get('/api/partner/me', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      // A porta de entrada do portal. Se a linha de empresa faltar,
      // é aqui que se repara — antes de qualquer outra coisa falhar
      // por causa dela.
      await ensurePartnerRow(user);

      const state = await loadPartnerState(user.id);

      return res.json({
        email: user.email,
        status: state.partner?.status || 'none',
        ...state
      });
    } catch (error) {
      console.error('partner/me error:', error);
      return res.status(500).json({ error: 'Could not load your partner account.' });
    }
  });

  // Dados da empresa. Cria o registo em rascunho na primeira gravação.

  // Dados da empresa. Cria o registo em rascunho na primeira gravação.
  router.post('/api/partner/company', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const b = req.body || {};

      if (!b.legal_name || !b.vat_number || !b.contact_name || !b.contact_phone) {
        return res.status(400).json({
          error: 'Legal name, VAT number, contact name and contact phone are required.'
        });
      }

      const { data: existing } = await supabase
        .from('driver_partners').select('status').eq('id', user.id).maybeSingle();

      if (existing && !PARTNER_EDITABLE_STATUSES.includes(existing.status)) {
        // Depois de submetida, a candidatura fecha para edição. Sem
        // isto, alguém trocava a empresa depois de aprovada.
        return res.status(400).json({
          error: 'Your application is under review and cannot be edited right now.'
        });
      }

      // Só gravamos estas listas quando vêm no pedido. Sem isto, um
      // ecrã que não as recolhe apagava-as ao gravar o resto.
      const cities = Array.isArray(b.operating_cities)
        ? b.operating_cities.map((c) => String(c).trim()).filter(Boolean).slice(0, 60)
        : undefined;

      const airports = Array.isArray(b.operating_airports)
        ? b.operating_airports
            .map((a) => String(a).trim().toUpperCase())
            .filter((a) => /^[A-Z]{3}$/.test(a))
            .slice(0, 120)
        : undefined;

      const { error } = await supabase.from('driver_partners').upsert({
        id: user.id,
        email: user.email,
        legal_name: b.legal_name,
        trading_name: b.trading_name || null,
        vat_number: b.vat_number,
        country: b.country || DEFAULT_COUNTRY,
        registered_address: b.registered_address || null,
        city: b.city || null,
        postal_code: b.postal_code || null,
        contact_name: b.contact_name,
        contact_role: b.contact_role || null,
        contact_phone: b.contact_phone,
        emergency_phone: b.emergency_phone || null,
        payout_iban: b.payout_iban || null,
        payout_holder: b.payout_holder || null,
        bank_details_at: b.payout_iban ? new Date().toISOString() : null,
        ...(cities !== undefined ? { operating_cities: cities.length ? cities : null } : {}),
        ...(airports !== undefined ? { operating_airports: airports.length ? airports : null } : {}),
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });

      if (error) throw error;

      // A empresa também é uma pessoa com email no sistema.
      await supabase.from('contacts').upsert({
        id: user.id, email: user.email, full_name: b.contact_name, is_admin: false
      }, { onConflict: 'email' });

      return res.json({ success: true, state: await loadPartnerState(user.id) });
    } catch (error) {
      console.error('partner/company error:', error);
      return res.status(500).json({ error: 'Could not save your company details.' });
    }
  });


  router.post('/api/partner/zones', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const zones = Array.isArray(req.body?.zones) ? req.body.zones : [];
      if (!zones.length) return res.status(400).json({ error: 'Select at least one service zone.' });

      await supabase.from('partner_zones').delete().eq('partner_id', user.id);

      const { error } = await supabase.from('partner_zones')
        .insert(zones.map((z) => ({ partner_id: user.id, zone_code: z })));

      if (error) throw error;

      return res.json({ success: true, state: await loadPartnerState(user.id) });
    } catch (error) {
      console.error('partner/zones error:', error);
      return res.status(500).json({ error: 'Could not save your service zones.' });
    }
  });


  router.post('/api/partner/driver', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const b = req.body || {};
      if (!b.full_name || !b.phone) {
        return res.status(400).json({ error: 'Driver name and phone are required.' });
      }

      const row = {
        partner_id: user.id,
        full_name: b.full_name,
        phone: b.phone,
        email: b.email || null,
        date_of_birth: b.date_of_birth || null,
        languages: Array.isArray(b.languages) ? b.languages : null,
        updated_at: new Date().toISOString()
      };

      if (b.id) {
        const { error } = await supabase.from('drivers').update(row)
          .eq('id', b.id).eq('partner_id', user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('drivers').insert(row);
        if (error) throw error;
      }

      return res.json({ success: true, state: await loadPartnerState(user.id) });
    } catch (error) {
      console.error('partner/driver error:', error);
      return res.status(500).json({ error: 'Could not save the driver.' });
    }
  });


  router.post('/api/partner/vehicle', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const b = req.body || {};
      if (!b.make || !b.model || !b.plate || !b.seats) {
        return res.status(400).json({ error: 'Make, model, plate and seats are required.' });
      }

      const seats = parseInt(b.seats, 10);
      if (!Number.isFinite(seats) || seats < 1 || seats > 16) {
        return res.status(400).json({ error: 'Seats must be between 1 and 16.' });
      }

      const row = {
        partner_id: user.id,
        make: b.make, model: b.model,
        year: b.year ? parseInt(b.year, 10) : null,
        colour: b.colour || null,
        plate: b.plate,
        seats,
        luggage: b.luggage ? parseInt(b.luggage, 10) : null,
        vehicle_class: b.vehicle_class || 'standard',
        updated_at: new Date().toISOString()
      };

      if (b.id) {
        const { error } = await supabase.from('partner_vehicles').update(row)
          .eq('id', b.id).eq('partner_id', user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('partner_vehicles').insert(row);
        if (error) throw error;
      }

      return res.json({ success: true, state: await loadPartnerState(user.id) });
    } catch (error) {
      console.error('partner/vehicle error:', error);
      if (String(error.message || '').includes('partner_vehicles_plate_idx')) {
        return res.status(400).json({ error: 'You already have a vehicle with that plate.' });
      }
      return res.status(500).json({ error: 'Could not save the vehicle.' });
    }
  });

  // O ficheiro sobe do browser para o Storage; aqui só registamos a
  // referência. O estado fica 'pending' até um administrador o aprovar.

  // O ficheiro sobe do browser para o Storage; aqui só registamos a
  // referência. O estado fica 'pending' até um administrador o aprovar.
  router.post('/api/partner/document', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const b = req.body || {};
      if (!b.requirement_code || !b.file_path) {
        return res.status(400).json({ error: 'Missing document reference.' });
      }

      const { data: requirement } = await supabase
        .from('document_requirements').select('*').eq('code', b.requirement_code).maybeSingle();

      if (!requirement) return res.status(400).json({ error: 'Unknown document type.' });

      if (requirement.requires_expiry && !b.expires_on) {
        return res.status(400).json({ error: `${requirement.label} needs an expiry date.` });
      }

      // Substitui a versão anterior do mesmo documento para a mesma
      // entidade: o histórico útil é a validade, não os PDFs antigos.
      let stale = supabase.from('compliance_documents').delete()
        .eq('partner_id', user.id).eq('requirement_code', b.requirement_code);
      stale = b.driver_id ? stale.eq('driver_id', b.driver_id) : stale.is('driver_id', null);
      stale = b.vehicle_id ? stale.eq('vehicle_id', b.vehicle_id) : stale.is('vehicle_id', null);
      await stale;

      // Sem linha de empresa, a chave estrangeira recusa o
      // documento — e o erro era "Could not register the document",
      // que não dizia nada a ninguém.
      const company = await ensurePartnerRow(user);

      if (!company) {
        return res.status(500).json({
          error: 'We could not link this document to your company. ' +
                 'Reload the page and try again — if it keeps happening, tell us in the chat.'
        });
      }

      const { error } = await supabase.from('compliance_documents').insert({
        partner_id: user.id,
        driver_id: b.driver_id || null,
        vehicle_id: b.vehicle_id || null,
        requirement_code: b.requirement_code,
        file_path: b.file_path,
        file_name: b.file_name || null,
        issued_on: b.issued_on || null,
        expires_on: b.expires_on || null,
        status: 'pending'
      });

      if (error) throw error;

      // O documento antigo foi apagado acima, e com ele o motivo da
      // recusa — que se referia ao ficheiro antigo. Se a conta estava
      // à espera de correção, volta à fila de revisão assim que
      // deixar de haver documentos recusados.
      const state = await loadPartnerState(user.id);

      if (state.partner?.status === 'action_required') {
        const stillRejected = state.documents.some((d) => d.status === 'rejected');

        if (!stillRejected) {
          await supabase.from('driver_partners').update({
            status: 'in_review',
            submitted_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }).eq('id', user.id);

          return res.json({ success: true, state: await loadPartnerState(user.id) });
        }
      }

      return res.json({ success: true, state });
    } catch (error) {
      console.error('partner/document error:', error.code, error.message);
      // A mensagem real do Postgres. "Could not register the
      // document" não diz a ninguém o que fazer a seguir, e este é
      // exatamente o género de erro que se diagnostica pela causa.
      return res.status(500).json({
        error: error.message || 'Could not register the document.'
      });
    }
  });

  // Submeter para revisão. Só aceita candidaturas completas — é o que
  // evita revisões a meio e devoluções sucessivas.
  // Submeter para verificação.
  //
  // Exige apenas os TRÊS documentos de entrada e os dados da empresa.
  // Motoristas, veículos, zonas e IBAN ficam para a fase de ativação,
  // já dentro do painel: pedir tudo à porta afasta metade dos
  // candidatos, e um parceiro verificado é mais fácil de acompanhar do
  // que um candidato que desistiu a meio.

  // Submeter para revisão. Só aceita candidaturas completas — é o que
  // evita revisões a meio e devoluções sucessivas.
  // Submeter para verificação.
  //
  // Exige apenas os TRÊS documentos de entrada e os dados da empresa.
  // Motoristas, veículos, zonas e IBAN ficam para a fase de ativação,
  // já dentro do painel: pedir tudo à porta afasta metade dos
  // candidatos, e um parceiro verificado é mais fácil de acompanhar do
  // que um candidato que desistiu a meio.
  router.post('/api/partner/submit', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const state = await loadPartnerState(user.id);
      const missing = [];

      if (!state.partner) {
        return res.status(400).json({ error: 'Fill in your company details first.' });
      }
      if (!state.partner.legal_name) missing.push('your registered company name');
      if (!state.partner.contact_phone) missing.push('a contact phone number');
      if (!req.body?.contract_accepted && !state.partner.contract_accepted_at) {
        missing.push('the partner agreement');
      }

      // Os cinco passos, não só os documentos. Uma só revisão no fim
      // é melhor para os dois lados: o parceiro não fica meio
      // aprovado sem poder trabalhar, e tu decides uma vez em vez de
      // duas.
      state.requirements
        .filter((r) => r.mandatory && r.scope === 'company' && r.stage === 'signup')
        .forEach((r) => {
          const doc = state.documents.find((d) =>
            d.requirement_code === r.code && !d.driver_id && !d.vehicle_id);

          if (!doc) missing.push(r.label);
          else if (doc.status === 'rejected') {
            missing.push(`${r.label} — ${doc.rejection_reason || 'needs replacing'}`);
          }
        });

      if (!state.drivers.some((d) => d.status === 'active')) {
        missing.push('at least one active driver');
      }
      if (!state.vehicles.some((v) => v.status === 'active')) {
        missing.push('at least one active vehicle');
      }
      if (!(state.partner.operating_airports || []).length) {
        missing.push('the airports you serve');
      }
      if (!state.partner.payout_iban) {
        missing.push('your payout details');
      }

      if (missing.length) {
        return res.status(400).json({
          error: 'A few things are still missing before we can review your account.',
          missing
        });
      }

      const { error } = await supabase.from('driver_partners').update({
        status: 'in_review',
        submitted_at: new Date().toISOString(),
        contract_accepted_at: state.partner.contract_accepted_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', user.id);

      if (error) throw error;

      // state.partner é o que temos aqui, e já tem o email e o nome.
      await notify.received(state.partner);

      return res.json({ success: true, state: await loadPartnerState(user.id) });
    } catch (error) {
      console.error('partner/submit error:', error);
      return res.status(500).json({ error: 'Could not submit your application.' });
    }
  });

  // Agenda. Guardamos só as exceções: por omissão o parceiro está
  // disponível, e marcar 365 dias por ano para dizer "sim" seria
  // trabalho inútil para ele e para a base de dados.

  // Agenda. Guardamos só as exceções: por omissão o parceiro está
  // disponível, e marcar 365 dias por ano para dizer "sim" seria
  // trabalho inútil para ele e para a base de dados.
  router.post('/api/partner/availability', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const { day, available, note } = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) {
        return res.status(400).json({ error: 'Invalid date.' });
      }

      if (available) {
        const { error } = await supabase.from('partner_availability')
          .delete().eq('partner_id', user.id).eq('day', day);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('partner_availability').upsert({
          partner_id: user.id, day, status: 'unavailable',
          note: note || null, updated_at: new Date().toISOString()
        }, { onConflict: 'partner_id,day' });
        if (error) throw error;
      }

      const { data } = await supabase.from('partner_availability')
        .select('day, status, note').eq('partner_id', user.id)
        .gte('day', new Date().toISOString().slice(0, 10));

      return res.json({ success: true, availability: data || [] });
    } catch (error) {
      console.error('partner/availability error:', error);
      return res.status(500).json({ error: 'Could not update your calendar.' });
    }
  });


  router.get('/api/partner/availability', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

      const { data, error } = await supabase.from('partner_availability')
        .select('day, status, note').eq('partner_id', user.id);

      if (error) throw error;
      return res.json({ availability: data || [] });
    } catch (error) {
      console.error('partner/availability get error:', error);
      return res.status(500).json({ error: 'Could not load your calendar.' });
    }
  });

  // Revisão pelo admin.

  router.get('/api/partner/chat', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in.' });

      // O chat está aberto a qualquer conta autenticada, incluindo
      // quem está a meio do registo — que é precisamente quem mais
      // precisa de ajuda. Se faltar a linha de empresa, cria-se.
      await ensurePartnerRow(user);

      // Um assunto vindo do portal abre um ticket com título. Sem
      // ele, continua a servir a conversa aberta que houver.
      const chat = await chatFor(user.id, req.query.subject, req.query.topic);
      if (!chat) return res.status(500).json({ error: 'Could not open your chat.' });

      const [messagesRes, capacityRes, agenteRes] = await Promise.all([
        supabase.from('partner_messages')
          .select('*').eq('chat_id', chat.id)
          // Aqui também, além da RLS. Duas barreiras: se uma falhar
          // por engano numa migração, a outra segura.
          .eq('internal', false)
          .order('created_at').limit(200),
        supabase.rpc('support_capacity'),

        // Quem está a atender, se houver alguém. Vai na mesma volta
        // que o resto: uma consulta a mais em série custaria outra
        // ida ao servidor.
        chat.assigned_to
          ? supabase.from('support_presence')
              .select('display_name, avatar_path')
              .eq('user_id', chat.assigned_to)
              .maybeSingle()
          : Promise.resolve({ data: null })
      ]);

      const capacity = (capacityRes.data && capacityRes.data[0]) || {};
      const agente = agenteRes?.data || null;

      // Ao abrir, o que o admin escreveu passa a lido. Não o
      // contrário: o admin marca as dele quando abre a conversa.
      if (chat.unread_for_partner > 0) {
        await supabase.from('partner_chats')
          .update({ unread_for_partner: 0 })
          .eq('id', chat.id);
      }

      // O histórico vai junto: o portal mostra as conversas
      // anteriores ao lado da atual, sem um segundo pedido.
      const history = await historyFor(user.id, 20);

      return res.json({
        chat,
        messages: messagesRes.data || [],
        history: history.filter((h) => h.chat_id !== chat.id),
        // O parceiro precisa de saber três coisas diferentes: se há
        // alguém, se já está a ser atendido, e há quanto tempo
        // espera. Uma só bandeira "online" não distinguia nada disso.
        support: {
          agents_online: capacity.agents_online || 0,
          free_slots: capacity.free_slots || 0,
          waiting: capacity.waiting || 0,
          assigned: Boolean(chat.assigned_to),
          // Quem está do outro lado, com nome e fotografia.
          //
          // O portal mostrava "Airportlink" mesmo com um agente
          // atribuído — falar com uma pessoa é diferente de falar
          // com uma marca, e o nome já estava em cada mensagem.
          agent_name: agente?.display_name || null,
          agent_avatar: agente?.avatar_path || null,
          waiting_minutes: chat.waiting_since
            ? Math.round((Date.now() - new Date(chat.waiting_since).getTime()) / 60000)
            : 0
        }
      });
    } catch (error) {
      console.error('partner/chat error:', error);
      return res.status(500).json({ error: error.message || 'Could not load your chat.' });
    }
  });

  /**
   * Uma conversa antiga do próprio parceiro.
   *
   * Só de leitura: para responder tem de usar a conversa aberta,
   * ou reabrir esta. Sem isto, o portal mostrava a lista mas não
   * deixava abrir nenhuma.
   */

  /**
   * Uma conversa antiga do próprio parceiro.
   *
   * Só de leitura: para responder tem de usar a conversa aberta,
   * ou reabrir esta. Sem isto, o portal mostrava a lista mas não
   * deixava abrir nenhuma.
   */
  router.get('/api/partner/chat/:id', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in.' });

      const { data: chat } = await supabase
        .from('partner_chats')
        .select('*')
        .eq('id', req.params.id)
        // A verificação que interessa: é dele ou não é.
        .eq('partner_id', user.id)
        .maybeSingle();

      if (!chat) return res.status(404).json({ error: 'Conversation not found.' });

      const { data: messages } = await supabase
        .from('partner_messages')
        .select('*')
        .eq('chat_id', chat.id)
        .eq('internal', false)
        .order('created_at')
        .limit(300);

      return res.json({ chat, messages: messages || [] });
    } catch (error) {
      console.error('partner/chat/:id error:', error);
      return res.status(500).json({ error: 'Could not load that conversation.' });
    }
  });

  /**
   * Reabrir uma conversa fechada.
   *
   * Até 14 dias depois de fechada, e só se não houver outra aberta.
   * As regras estão no Postgres para valerem venha o pedido de onde
   * vier.
   */

  /**
   * Reabrir uma conversa fechada.
   *
   * Até 14 dias depois de fechada, e só se não houver outra aberta.
   * As regras estão no Postgres para valerem venha o pedido de onde
   * vier.
   */
  router.post('/api/partner/chat/reopen', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in.' });

      const { data: chat } = await supabase
        .from('partner_chats')
        .select('id')
        .eq('id', req.body?.chat_id)
        .eq('partner_id', user.id)
        .maybeSingle();

      if (!chat) return res.status(404).json({ error: 'Conversation not found.' });

      const { data: ok } = await supabase.rpc('reopen_partner_chat', {
        p_chat_id: chat.id
      });

      if (!ok) {
        return res.status(409).json({
          error: 'That conversation cannot be reopened. Start a new one instead.'
        });
      }

      return res.json({ ok: true, chat_id: chat.id });
    } catch (error) {
      console.error('reopen error:', error);
      return res.status(500).json({ error: 'Could not reopen that conversation.' });
    }
  });


  router.post('/api/partner/chat/send', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in.' });

      const body = String(req.body?.body || '').trim();
      const attachmentPath = req.body?.attachment_path || null;

      if (!body && !attachmentPath) {
        return res.status(400).json({ error: 'Write something first.' });
      }

      if (body.length > 4000) {
        return res.status(400).json({ error: 'That message is too long.' });
      }

      await ensurePartnerRow(user);

      const chat = await chatFor(user.id);
      if (!chat) return res.status(500).json({ error: 'Could not open your chat.' });

      const { data: partner } = await supabase
        .from('driver_partners')
        .select('legal_name, trading_name, contact_name')
        .eq('id', user.id).maybeSingle();

      const { data, error } = await supabase
        .from('partner_messages')
        .insert({
          chat_id: chat.id,
          sender: 'partner',
          sender_id: user.id,
          sender_name: partner?.trading_name || partner?.legal_name || null,
          body: body || null,
          attachment_path: attachmentPath,
          attachment_name: req.body?.attachment_name || null
        })
        .select()
        .single();

      if (error) throw error;

      // Toca a alguém. O gatilho no Postgres já pôs a conversa em
      // espera; isto escolhe quem atende e arranca os 30 segundos.
      try { await supabase.rpc('offer_chat', { p_chat_id: chat.id }); } catch (e) {
        console.error('offer_chat failed:', e.message);
      }

      return res.json({ success: true, message: data });
    } catch (error) {
      console.error('partner/chat/send error:', error);
      return res.status(500).json({
        error: error.message || 'Your message did not send. Try again.'
      });
    }
  });


  router.post('/api/partner/chat/close', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in.' });

      const chat = await chatFor(user.id);
      if (!chat) return res.status(400).json({ error: 'No conversation to close.' });

      const { data, error } = await asUser(req).rpc('close_chat_as_partner', {
        p_chat_id: chat.id
      });

      if (error) throw error;
      if (!data?.ok) return res.status(400).json({ error: 'Could not close that conversation.' });

      return res.json({ success: true });
    } catch (error) {
      console.error('partner/chat/close error:', error);
      return res.status(500).json({ error: error.message || 'Could not close the conversation.' });
    }
  });

  // ---------- lado do admin ----------

  /**
   * Marca as mensagens do parceiro como lidas.
   *
   * Chamado quando o agente abre a conversa. O parceiro passa a ver
   * que o que escreveu chegou — é daí que vêm as mensagens
   * repetidas quando não há resposta imediata.
   */

  return router;
}
