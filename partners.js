/**
 * partners.js — backend da rede de parceiros de motoristas
 * ---------------------------------------------------------------
 * Tudo o que diz respeito a empresas de motoristas vive aqui: o
 * registo, os documentos, a frota, as zonas, a agenda e a revisão
 * pelo administrador.
 *
 * As dependências entram por parâmetro em vez de serem importadas.
 * Assim este módulo não sabe nada sobre como o servidor foi montado,
 * e pode ser testado sozinho.
 * ---------------------------------------------------------------
 */

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';

export function createPartnerRoutes({
  supabase,
  getUserFromRequest,
  requireAdmin,
  // Sem supervisor configurado, ninguém entra nas áreas dele. É o
  // valor seguro: recusar por omissão em vez de deixar passar.
  requireSupervisor = async () => ({ error: 'Supervisor check is not configured.' }),
  email = {},
  config = {}
}) {
  if (!supabase) throw new Error('createPartnerRoutes: supabase is required');
  if (!getUserFromRequest) throw new Error('createPartnerRoutes: getUserFromRequest is required');
  if (!requireAdmin) throw new Error('createPartnerRoutes: requireAdmin is required');

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
    verify: email.sendVerification || (async () => {}),
    // Sem função de escalada configurada, o aviso fica no registo.
    // O painel continua a mostrá-lo — o email é o segundo caminho,
    // para quando ninguém tem o painel aberto.
    escalation: email.sendSupportEscalation || (async () => {})
  };

  const router = Router();

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

      return res.json({
        available: available.data || [],
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
  router.post('/api/admin/partner/review', async (req, res) => {
    try {
      const { user: admin, error: adminError } = await requireAdmin(req);
      if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

      const { partner_id, decision, reason } = req.body || {};

      // 'verified' deixou de existir como decisão: havia duas e
      // passou a haver uma. Continua aceite para não partir um
      // pedido antigo, mas é tratado como 'approved'.
      const allowed = ['approved', 'rejected', 'action_required', 'in_review', 'suspended', 'verified'];

      if (!partner_id || !allowed.includes(decision)) {
        return res.status(400).json({
          error: 'Missing partner_id or invalid decision.',
          allowed: allowed.filter((d) => d !== 'verified')
        });
      }

      const finalDecision = decision === 'verified' ? 'approved' : decision;

      const update = {
        status: finalDecision,
        rejection_reason: finalDecision === 'rejected' ? (reason || null) : null,
        review_notes: reason || null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: admin.id,
        updated_at: new Date().toISOString()
      };

      if (finalDecision === 'approved') {
        update.verified_at = new Date().toISOString();
        update.activated_at = new Date().toISOString();
      }

      const { data, error } = await supabase.from('driver_partners')
        .update(update).eq('id', partner_id)
        .select('id, email, legal_name, status').single();

      if (error) throw error;

      // Aprovar a empresa ativa os motoristas e veículos que estavam à
      // espera dela. Sem isto, um parceiro aprovado continuava sem
      // poder receber viagens.
      if (finalDecision === 'approved') {
        await supabase.from('drivers').update({ status: 'active' })
          .eq('partner_id', partner_id).eq('status', 'pending');
        await supabase.from('partner_vehicles').update({ status: 'active' })
          .eq('partner_id', partner_id).eq('status', 'pending');
        await supabase.from('compliance_documents').update({
          status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: admin.id
        }).eq('partner_id', partner_id).eq('status', 'pending');
      }

      console.log('Partner reviewed:', { by: admin.email, partner: data.email, decision });

      // O email não pode partir a decisão: já está gravada.
      await notify.decision(data, decision, reason);

      return res.json({ success: true, partner: data });
    } catch (error) {
      console.error('admin/partner/review error:', error);
      return res.status(500).json({ error: 'Could not update the application.' });
    }
  });

  // ============================================================
  // CHAT
  //
  // Tabelas próprias, separadas do apoio a clientes: um parceiro
  // escreve sobre dinheiro e viagens em curso, um cliente sobre uma
  // reserva. Prioridades diferentes, e nenhum deve poder ver o outro.
  // ============================================================

  /** A conversa do parceiro, criada na primeira vez que faz falta. */
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

  /**
   * O histórico de um parceiro: todos os tickets, do mais recente
   * ao mais antigo.
   *
   * Serve os dois lados. No portal, o parceiro vê as suas conversas
   * anteriores. No painel, o agente vê o que já foi dito antes de
   * responder — a diferença entre "quem é este?" e "vejo que
   * escreveu na semana passada sobre a fatura".
   */
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

  router.get('/api/admin/chats', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    // Varrer primeiro: sem um trabalhador permanente, é o próprio
    // uso do painel que faz a rotação avançar. Como há sempre um
    // painel aberto quando há agentes ao serviço, funciona.
    try { await supabase.rpc('sweep_chat_offers'); } catch (e) {}
    try { await supabase.rpc('flag_stale_chats'); } catch (e) {}

    const [queueRes, ringingRes] = await Promise.all([
      supabase.from('partner_chat_queue').select('*'),
      supabase.from('chat_offers')
        .select('*')
        .eq('agent_id', admin.id)
        .eq('outcome', 'ringing')
        .gt('expires_at', new Date().toISOString())
        .order('offered_at')
        .limit(1)
    ]);

    if (queueRes.error) return res.status(500).json({ error: queueRes.error.message });

    return res.json({
      chats: queueRes.data || [],
      // A que está a tocar AGORA neste agente. É isto que faz o
      // painel mostrar a chamada a entrar.
      ringing: (ringingRes.data && ringingRes.data[0]) || null
    });
  });

  /**
   * Pedir para tocar.
   *
   * Se há alguém à espera e este agente está livre, cria a oferta
   * agora. Existe porque a oferta é criada quando a mensagem chega —
   * e se nessa altura ninguém estava em Live, ninguém a recebeu.
   * Sem isto, o parceiro ficava na fila e o painel calado.
   */
  router.post('/api/admin/chat/ring', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { data: waiting } = await supabase
      .from('partner_chats')
      .select('id')
      .eq('status', 'open')
      .is('assigned_to', null)
      .not('waiting_since', 'is', null)
      .order('waiting_since')
      .limit(1);

    if (!waiting || !waiting.length) {
      return res.json({ ok: false, reason: 'nobody_waiting' });
    }

    const { data, error } = await supabase.rpc('offer_chat', { p_chat_id: waiting[0].id });
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ ok: true, ...(data || {}) });
  });

  /** Não atendeu: passa ao seguinte e fica no registo. */
  router.post('/api/admin/chat/pass', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, declined } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { data, error } = await asUser(req).rpc('pass_chat', {
      p_chat_id: chat_id,
      p_declined: declined === true
    });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, ...(data || {}) });
  });

  /** O registo de quem atendeu e quem deixou passar. */
  router.get('/api/admin/chat-log', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const [logRes, statsRes] = await Promise.all([
      supabase.from('chat_offer_log').select('*').limit(120),
      supabase.from('agent_response_stats').select('*')
    ]);

    return res.json({
      log: logRes.data || [],
      stats: statsRes.data || []
    });
  });

  /** O contexto do parceiro por trás de uma conversa. */
  router.get('/api/admin/chat/:chatId/context', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { data: chat } = await supabase
      .from('partner_chats').select('partner_id').eq('id', req.params.chatId).maybeSingle();

    if (!chat) return res.status(404).json({ error: 'No such conversation.' });

    const [ctxRes, ridesRes] = await Promise.all([
      supabase.from('partner_context').select('*').eq('partner_id', chat.partner_id).maybeSingle(),
      // As próximas viagens: quem escreve costuma escrever sobre uma
      // delas, e tê-las à vista poupa o agente de ir procurar.
      supabase.from('bookings')
        .select('booking_id, booking_reference, booking_date, booking_time, pickup, dropoff, ' +
                'passengers, driver_payout, currency, status')
        .eq('assigned_partner_id', chat.partner_id)
        .neq('status', 'cancelled')
        .gte('booking_date', new Date().toISOString().slice(0, 10))
        .order('booking_date')
        .limit(5)
    ]);

    return res.json({
      context: ctxRes.data || null,
      upcoming: ridesRes.data || []
    });
  });

  router.get('/api/admin/chat/:chatId', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    // Sem filtro de internal: o admin vê as notas, que é para isso
    // que elas existem.
    const { data: messages, error } = await supabase
      .from('partner_messages')
      .select('*').eq('chat_id', req.params.chatId)
      .order('created_at').limit(300);

    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('partner_chats')
      .update({ unread_for_admin: 0 })
      .eq('id', req.params.chatId);

    return res.json({ messages: messages || [] });
  });

  router.post('/api/admin/chat/send', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, body } = req.body || {};
    if (!chat_id || !String(body || '').trim()) {
      return res.status(400).json({ error: 'Send chat_id and a message.' });
    }

    const internal = req.body.internal === true;

    // O nome de apresentação é o que o parceiro lê. Guardado na
    // presença para ser o mesmo em todas as conversas, em vez de
    // depender do que o browser mandar de cada vez.
    let displayName = req.body.sender_name;

    if (!displayName && !internal) {
      const { data: presence } = await supabase
        .from('support_presence')
        .select('display_name')
        .eq('user_id', admin.id)
        .maybeSingle();

      displayName = presence?.display_name || admin.email.split('@')[0];
    }

    // O avatar vai na mensagem, não é lido da presença ao mostrar.
    // Um agente que mude de fotografia não deve reescrever o
    // passado — tal como o nome já não reescreve.
    let avatar = null;

    if (!internal) {
      const { data: pres } = await supabase
        .from('support_presence')
        .select('avatar_path')
        .eq('user_id', admin.id)
        .maybeSingle();

      avatar = pres?.avatar_path || null;
    }

    const { data, error } = await supabase
      .from('partner_messages')
      .insert({
        chat_id,
        sender: 'admin',
        sender_id: admin.id,
        sender_name: displayName || admin.email.split('@')[0],
        sender_avatar: avatar,
        body: String(body).trim(),
        internal,
        attachment_path: req.body.attachment_path || null,
        attachment_name: req.body.attachment_name || null
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, message: data });
  });

  /**
   * Marcar-se ao serviço, e bater o ponto.
   *
   * O painel chama isto de dois em dois minutos enquanto estiver
   * aberto. Sem essa batida, a presença expira sozinha ao fim de
   * três — um separador esquecido aberto diria "online" toda a noite.
   */
  router.post('/api/admin/presence', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    /**
     * Oito estados, não um interruptor.
     *
     * Quem vai almoçar não fica offline: fica em pausa, e continua
     * a contar como pessoa ao serviço. E "duas horas em break" é
     * uma coisa diferente de "duas horas em formação" — distinguir
     * é o que torna o relatório do dia útil.
     *
     * Só live e active recebem chats novos. O escalating fica de
     * fora de propósito: quem está a resolver um caso com o
     * supervisor não deve ser interrompido.
     */
    const allowed = ['live', 'active', 'escalating', 'follow-up',
                     'training', 'admin', 'break', 'offline'];
    const state = allowed.includes(req.body?.state) ? req.body.state : null;

    const patch = {
      user_id: admin.id,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    /**
     * O nome NÃO entra em todas as batidas.
     *
     * Este upsert corre de dois em dois minutos. Se puséssemos aqui
     * `display_name: req.body.display_name || email`, uma batida sem
     * corpo apagava o nome escolhido e punha o email no lugar — de
     * dois em dois minutos, para sempre.
     *
     * Só se escreve quando vem um nome no pedido. Se não vier, a
     * coluna fica como está. E se ainda não existir linha nenhuma,
     * o email serve de valor inicial.
     */
    const enviado = String(req.body?.display_name || '').trim();

    if (enviado) {
      patch.display_name = enviado;
    } else {
      const { data: atual } = await supabase
        .from('support_presence')
        .select('display_name')
        .eq('user_id', admin.id)
        .maybeSingle();

      if (!atual?.display_name) {
        patch.display_name = admin.email.split('@')[0];
      }
    }

    /**
     * Mudar de estado passa pela função do Postgres.
     *
     * Ela fecha o período anterior, abre o novo e atualiza a
     * presença — três escritas que têm de acontecer juntas. Feitas
     * daqui uma a uma, uma falha a meio deixava um período aberto
     * para sempre e o relatório do dia passava a mentir.
     *
     * Sem 'state' no corpo é só a batida do ponto, e essa continua
     * a ser um upsert simples: não muda o estado de quem entretanto
     * foi almoçar.
     */
    if (state) {
      const { data, error: rpcError } = await supabase.rpc('set_agent_state', {
        p_user_id: admin.id,
        p_state: state,
        p_display_name: enviado || null,
        p_automatic: Boolean(req.body?.automatic)
      });

      if (rpcError) return res.status(500).json({ error: rpcError.message });

      /**
       * A função pode recusar a mudança.
       *
       * Sair de serviço com conversas abertas deixa pessoas à espera
       * de quem já não está lá — e as conversas não voltam à fila
       * sozinhas, ficam com o nome dele para sempre.
       *
       * A recusa vem com a razão e a contagem, para o painel poder
       * dizer o que fazer em vez de só dizer que não.
       */
      if (data && data.ok === false) {
        return res.status(409).json({
          error: data.message || 'That change was refused.',
          reason: data.reason,
          open_chats: data.open_chats
        });
      }

      return res.json({ success: true, state, ...(data || {}) });
    }

    const { error } = await supabase.from('support_presence')
      .upsert(patch, { onConflict: 'user_id' });

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, state });
  });

  /** O nome que o parceiro vê quando este agente responde. */
  /**
   * Diz que versão deste ficheiro está a correr.
   *
   * Existe porque "corrigi e continua igual" é quase sempre uma
   * versão antiga em produção, e não havia forma de o confirmar
   * sem adivinhar.
   */
  /**
   * Quem está autenticado, e com que cargo.
   *
   * O painel precisa disto antes de desenhar o menu: o separador de
   * finanças só aparece a supervisores. A garantia real está nas
   * rotas, não aqui — isto é só para não mostrar portas fechadas.
   */
  router.get('/api/admin/me', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    return res.json({
      id: admin.id,
      email: admin.email,
      role: admin.role,
      is_supervisor: admin.isSupervisor
    });
  });

  router.get('/api/admin/version', async (req, res) => {
    const { user, error } = await requireAdmin(req);
    if (error) return res.status(403).json({ error });

    return res.json({
      version: '2026-09-01-tickets',
      features: ['tickets', 'history', 'snippets', 'name-persist', 'claim-own']
    });
  });

  /**
   * O avatar do agente.
   *
   * O ficheiro sobe do browser para o storage; aqui só se guarda a
   * referência. A função no Postgres verifica que o caminho começa
   * pelo uuid de quem pede — sem isso, alguém podia apontar o seu
   * registo para o ficheiro de outra pessoa.
   *
   * Enviar path a null limpa e volta às iniciais.
   */
  router.post('/api/admin/avatar', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const caminho = req.body?.path === null ? null : String(req.body?.path || '').trim();

    if (caminho && !caminho.startsWith(admin.id + '/')) {
      return res.status(400).json({ error: 'That path does not belong to you.' });
    }

    try {
      const { error } = await supabase.rpc('set_agent_avatar', {
        p_user_id: admin.id,
        p_path: caminho || null
      });

      if (error) throw error;

      return res.json({ success: true, avatar_path: caminho || null });
    } catch (err) {
      console.error('avatar error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/display-name', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const name = String(req.body?.display_name || '').trim();

    if (name.length < 2 || name.length > 40) {
      return res.status(400).json({ error: 'Use between 2 and 40 characters.' });
    }

    const { error } = await supabase.from('support_presence').upsert({
      user_id: admin.id,
      display_name: name,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, display_name: name });
  });

  /** O dia de cada agente: tempo em cada estado e chamadas. */
  router.get('/api/admin/agent-day', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    // Marcar as paradas antes de reportar: assim o relatório e as
    // notas do chat contam a mesma história.
    try { await supabase.rpc('flag_stale_chats'); } catch (e) {}

    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    const from = new Date();
    from.setDate(from.getDate() - days + 1);

    const { data, error } = await supabase
      .from('agent_day')
      .select('*')
      .gte('day', from.toISOString().slice(0, 10));

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ days, rows: data || [] });
  });

  // ============================================================
  // O RELÓGIO DO APOIO
  //
  // Chamado de minuto a minuto por um cron externo:
  //
  //   POST https://<drivers>/api/tasks/support-tick
  //   cabeçalho: x-cron-secret: <CRON_SECRET>
  //
  // Existe porque a rotação das ofertas só avançava quando alguém
  // abria o painel. Sem painel aberto — de madrugada, ao almoço —
  // uma conversa ficava pendurada sem ninguém saber.
  // ============================================================
  router.post('/api/tasks/support-tick', async (req, res) => {
    if (!process.env.CRON_SECRET) {
      return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
    }
    if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const { data, error } = await supabase.rpc('support_tick');
      if (error) throw error;

      const resumo = data || {};
      const avisos = resumo.warnings || [];

      // Só escreve nos registos quando aconteceu alguma coisa. Um
      // cron de minuto a minuto que regista sempre torna os
      // registos ilegíveis e esconde o que interessa.
      if (resumo.closed_no_agent > 0) {
        console.warn('Support: closed', resumo.closed_no_agent,
          'chat(s) with nobody available.');
      }

      // A escalada ao supervisor é a única que sai daqui por email:
      // as de 3 e 5 minutos aparecem no painel do agente, e mandar
      // email de cada uma seria ruído.
      const escaladas = avisos.filter((a) => a.level === 3);

      for (const e of escaladas) {
        console.warn('Support escalation:', {
          chat: e.chat_id, partner: e.partner_name, minutes: e.waiting_minutes
        });

        try {
          await notify.escalation(e);
        } catch (err) {
          console.error('Escalation email failed:', err.message);
        }
      }

      return res.json({ ok: true, ...resumo });
    } catch (error) {
      console.error('support-tick error:', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  /**
   * O histórico de um parceiro, para quem está a atendê-lo.
   *
   * É a diferença entre responder às cegas e responder a alguém
   * cuja última conversa foi sobre a mesma coisa há três dias.
   */
  router.get('/api/admin/partner/:id/history', async (req, res) => {
    const { user, error } = await requireAdmin(req);
    if (error) return res.status(403).json({ error });

    try {
      const historia = await historyFor(req.params.id, 50);
      return res.json({ history: historia });
    } catch (err) {
      console.error('admin history error:', err.message);
      return res.status(500).json({ error: 'Could not load the history.' });
    }
  });

  /**
   * As mensagens de uma conversa antiga, incluindo notas internas.
   *
   * O agente vê as notas que ficaram; o parceiro nunca as vê. É por
   * isso que este endpoint existe separado do do parceiro em vez de
   * partilharem código.
   */
  router.get('/api/admin/chat/:id/full', async (req, res) => {
    const { user, error } = await requireAdmin(req);
    if (error) return res.status(403).json({ error });

    try {
      const { data: chat } = await supabase
        .from('partner_chat_history')
        .select('*')
        .eq('chat_id', req.params.id)
        .maybeSingle();

      if (!chat) return res.status(404).json({ error: 'Conversation not found.' });

      const { data: messages } = await supabase
        .from('partner_messages')
        .select('*')
        .eq('chat_id', req.params.id)
        .order('created_at')
        .limit(500);

      return res.json({ chat, messages: messages || [] });
    } catch (err) {
      console.error('admin chat full error:', err.message);
      return res.status(500).json({ error: 'Could not load that conversation.' });
    }
  });

  /**
   * As respostas rápidas.
   *
   * Partilhadas por toda a equipa de propósito: se cada agente
   * tiver as suas, a voz da empresa desfaz-se em cinco vozes
   * diferentes conforme quem atende.
   */
  router.get('/api/admin/snippets', async (req, res) => {
    const { user, error } = await requireAdmin(req);
    if (error) return res.status(403).json({ error });

    try {
      const { data, error: err } = await supabase
        .from('support_snippets')
        .select('*')
        .eq('active', true)
        .order('sort_order');

      if (err) throw err;

      return res.json({ snippets: data || [] });
    } catch (err) {
      console.error('snippets error:', err.message);
      // Sem respostas rápidas o painel funciona na mesma. Devolver
      // lista vazia é melhor do que partir a abertura do separador.
      return res.json({ snippets: [] });
    }
  });

  router.get('/api/admin/team', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { data, error } = await supabase.from('support_team').select('*');
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ team: data || [] });
  });

  /**
   * Pegar uma conversa.
   *
   * O limite está DENTRO da função no Postgres. Verificar aqui e
   * escrever a seguir deixava espaço para dois agentes pegarem a
   * terceira conversa ao mesmo tempo.
   */
  router.post('/api/admin/chat/claim', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    // Com o token do administrador, não com service_role: a função
    // usa auth.uid() para saber quem está a pegar.
    /**
     * Já é dele? Então não há nada a pegar.
     *
     * O claim_chat olha só para o assigned_to estar preenchido e
     * responde 'already_taken' — mesmo quando quem pede é o dono.
     * Isso acontecia sempre depois de recarregar a página: a oferta
     * ainda no ecrã, um clique em atender, e o painel a dizer que
     * outro agente tinha ficado com ela.
     */
    const { data: atual } = await supabase
      .from('partner_chats')
      .select('assigned_to, status')
      .eq('id', chat_id)
      .maybeSingle();

    if (atual?.assigned_to === admin.id) {
      return res.json({ success: true, already_mine: true });
    }

    const { data, error } = await asUser(req).rpc('claim_chat', { p_chat_id: chat_id });

    if (error) return res.status(500).json({ error: error.message });

    if (!data?.ok) {
      const reasons = {
        at_capacity: `You already have ${data?.open || 2} chats open. ` +
          'Close one before taking another — two at a time is the limit for a reason.',
        already_taken: 'Someone else got to that one first.',
        on_break: 'You are on a break. Set yourself to Live to take new chats — ' +
          'the ones you already have still work.',
        not_admin: 'Administrator access required.'
      };
      return res.status(409).json({ error: reasons[data?.reason] || 'Could not take that chat.' });
    }

    return res.json({ success: true, ...data });
  });

  router.post('/api/admin/chat/release', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, close } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { data, error } = await asUser(req).rpc('release_chat',
      { p_chat_id: chat_id, p_close: close === true });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, ...data });
  });

  /**
   * Fechar uma conversa, com motivo.
   *
   * Era um botão sem pergunta: "resolvido" e "o parceiro
   * desapareceu" contavam o mesmo no relatório, e não são a mesma
   * coisa de todo.
   */
  router.post('/api/admin/chat/close', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, reason, note } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { data, error } = await asUser(req).rpc('close_chat', {
      p_chat_id: chat_id,
      p_reason: reason || 'resolved',
      p_note: note || null
    });

    if (error) return res.status(500).json({ error: error.message });

    if (data && data.ok === false) {
      const mensagens = {
        not_yours: 'That conversation is not yours to close.',
        not_found: 'That conversation no longer exists.'
      };
      return res.status(409).json({ error: mensagens[data.reason] || 'Could not close it.' });
    }

    return res.json({ success: true, ...(data || {}) });
  });

  /**
   * Escalar. NÃO é fechar.
   *
   * A conversa continua aberta e passa para outra pessoa. Fechar
   * por não saber responder seria a pior saída: o parceiro fica sem
   * resposta e o problema desaparece do relatório.
   */
  router.post('/api/admin/chat/escalate', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, note, to } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { data, error } = await asUser(req).rpc('escalate_chat', {
      p_chat_id: chat_id,
      p_note: note || '',
      p_to: to || null
    });

    if (error) return res.status(500).json({ error: error.message });

    if (data && data.ok === false) {
      const mensagens = {
        note_required: 'Say what the supervisor needs to know. Escalating without ' +
          'context means whoever picks it up starts from nothing.',
        not_yours: 'That conversation is not yours to escalate.',
        not_found: 'That conversation no longer exists.'
      };
      return res.status(400).json({ error: mensagens[data.reason] || 'Could not escalate.' });
    }

    return res.json({ success: true, ...(data || {}) });
  });

  /**
   * As conversas que este agente fechou.
   *
   * A fila só traz as abertas e as das últimas 24 horas — uma
   * conversa fechada ontem desaparecia do separador "completed".
   */
  router.get('/api/admin/chats/closed', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    try {
      const alvo = req.query.agent_id && admin.isSupervisor
        ? req.query.agent_id
        : admin.id;

      const { data, error } = await supabase.rpc('agent_closed_chats', {
        p_user_id: alvo,
        p_days: Math.min(180, Number(req.query.days) || 30)
      });

      if (error) throw error;

      return res.json({ chats: data || [] });
    } catch (err) {
      console.error('closed chats:', err.message);
      return res.json({ chats: [] });
    }
  });

  /**
   * Quanto tempo hoje em cada estado.
   *
   * Sem agent_id devolve o do próprio; com ele, e sendo supervisor,
   * o de outra pessoa. Por agora todos os administradores podem ver
   * todos — quando houver supervisores a sério, esta é a linha a
   * apertar.
   */
  router.get('/api/admin/my-day', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    try {
      /**
       * Um só pedido para os tempos e as métricas.
       *
       * Eram dois, e cada chamada custa cerca de dois segundos de
       * latência. Vão para a mesma barra do painel, por isso não há
       * razão para os separar.
       *
       * Um agente vê o seu dia; um supervisor vê o de qualquer um.
       */
      const alvo = req.query.agent_id && admin.isSupervisor
        ? req.query.agent_id
        : admin.id;

      /**
       * O dia e o fuso vêm do browser.
       *
       * O current_date do Postgres é UTC. Às 23h45 no Brasil já são
       * 02h45 em UTC, e o painel mostrava tudo a zero enquanto o
       * agente ainda estava a trabalhar.
       *
       * O offset é em minutos face a UTC, com o sinal do
       * getTimezoneOffset invertido — o browser dá +180 para UTC-3,
       * e nós queremos -180.
       */
      const offset = Number.isFinite(Number(req.query.offset))
        ? Math.max(-840, Math.min(840, Number(req.query.offset)))
        : 0;

      const { data, error } = await supabase.rpc('agent_day_summary', {
        p_user_id: alvo,
        p_day: req.query.day || null,
        p_offset: offset
      });

      if (error) throw error;

      return res.json(data || { states: {}, metrics: {} });
    } catch (err) {
      console.error('my-day error:', err.message);
      // Lista vazia e não erro: o painel mostra o resto na mesma, e
      // um relatório em falta não deve tirar o agente de serviço.
      return res.json({ states: [], total_seconds: 0 });
    }
  });

  router.get('/api/admin/capacity', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const [capRes, mineRes] = await Promise.all([
      supabase.rpc('support_capacity'),
      supabase.from('partner_chats')
        .select('id').eq('assigned_to', admin.id).eq('status', 'open')
    ]);

    return res.json({
      ...((capRes.data && capRes.data[0]) || {}),
      my_open_chats: (mineRes.data || []).length
    });
  });

  router.post('/api/admin/chat/flag', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, urgent, status } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const patch = { updated_at: new Date().toISOString() };
    if (typeof urgent === 'boolean') patch.urgent = urgent;
    if (status === 'open' || status === 'closed') patch.status = status;

    const { error } = await supabase.from('partner_chats').update(patch).eq('id', chat_id);
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true });
  });

  return router;
}
