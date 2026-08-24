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

export function createPartnerRoutes({
  supabase,
  getUserFromRequest,
  requireAdmin,
  config = {}
}) {
  if (!supabase) throw new Error('createPartnerRoutes: supabase is required');
  if (!getUserFromRequest) throw new Error('createPartnerRoutes: getUserFromRequest is required');
  if (!requireAdmin) throw new Error('createPartnerRoutes: requireAdmin is required');

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

  async function loadPartnerState(userId) {
    const [partner, zones, drivers, vehicles, documents, requirements, allZones, compliance] =
      await Promise.all([
        supabase.from('driver_partners').select('*').eq('id', userId).maybeSingle(),
        supabase.from('partner_zones').select('zone_code').eq('partner_id', userId),
        supabase.from('drivers').select('*').eq('partner_id', userId).neq('status', 'removed').order('created_at'),
        supabase.from('partner_vehicles').select('*').eq('partner_id', userId).neq('status', 'removed').order('created_at'),
        supabase.from('compliance_documents').select('*').eq('partner_id', userId).order('uploaded_at', { ascending: false }),
        supabase.from('document_requirements').select('*').eq('active', true).order('sort_order'),
        supabase.from('service_zones').select('*').eq('active', true).order('sort_order'),
        supabase.from('partner_compliance').select('*').eq('partner_id', userId).maybeSingle()
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

      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: b.email,
        password: b.password,
        email_confirm: true,
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
        fleet_size: Number.isFinite(fleetSize) ? fleetSize : null,
        owner_drives: typeof b.owner_drives === 'boolean' ? b.owner_drives : null,
        heard_from: b.heard_from || null,
        status: 'draft'
      });

      if (partnerError) throw partnerError;

      console.log('Partner signed up:', { email: b.email, country: b.country });

      return res.json({ success: true });
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

  router.get('/api/partner/me', async (req, res) => {
    try {
      const user = await getUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });

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

      return res.json({ success: true, state: await loadPartnerState(user.id) });
    } catch (error) {
      console.error('partner/document error:', error);
      return res.status(500).json({ error: 'Could not register the document.' });
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
      if (!state.partner.vat_number) missing.push('your VAT number');
      if (!state.partner.contact_phone) missing.push('a contact phone number');
      if (!req.body?.contract_accepted && !state.partner.contract_accepted_at) {
        missing.push('the partner agreement');
      }

      state.requirements
        .filter((r) => r.mandatory && r.scope === 'company' && r.stage === 'signup')
        .forEach((r) => {
          const has = state.documents.some((d) =>
            d.requirement_code === r.code && !d.driver_id && !d.vehicle_id);
          if (!has) missing.push(r.label);
        });

      if (missing.length) {
        return res.status(400).json({
          error: 'A few things are still missing before we can verify you.',
          missing
        });
      }

      const { error } = await supabase.from('driver_partners').update({
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        contract_accepted_at: state.partner.contract_accepted_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', user.id);

      if (error) throw error;

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

      if (!partner_id ||
          !['verified', 'approved', 'rejected', 'in_review', 'suspended'].includes(decision)) {
        return res.status(400).json({ error: 'Missing partner_id or invalid decision.' });
      }

      const update = {
        status: decision,
        rejection_reason: decision === 'rejected' ? (reason || null) : null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: admin.id,
        updated_at: new Date().toISOString()
      };

      // 'verified' = os três documentos de entrada foram aceites.
      // 'approved' = está tudo completo e pode receber viagens.
      if (decision === 'verified') update.verified_at = new Date().toISOString();
      if (decision === 'approved') update.activated_at = new Date().toISOString();

      const { data, error } = await supabase.from('driver_partners')
        .update(update).eq('id', partner_id)
        .select('id, email, legal_name, status').single();

      if (error) throw error;

      // Aprovar a empresa ativa os motoristas e veículos que estavam à
      // espera dela. Sem isto, um parceiro aprovado continuava sem
      // poder receber viagens.
      if (decision === 'verified' || decision === 'approved') {
        await supabase.from('drivers').update({ status: 'active' })
          .eq('partner_id', partner_id).eq('status', 'pending');
        await supabase.from('partner_vehicles').update({ status: 'active' })
          .eq('partner_id', partner_id).eq('status', 'pending');
        await supabase.from('compliance_documents').update({
          status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: admin.id
        }).eq('partner_id', partner_id).eq('status', 'pending');
      }

      console.log('Partner reviewed:', { by: admin.email, partner: data.email, decision });

      return res.json({ success: true, partner: data });
    } catch (error) {
      console.error('admin/partner/review error:', error);
      return res.status(500).json({ error: 'Could not update the application.' });
    }
  });

  return router;
}
