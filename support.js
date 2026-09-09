/**
 * support.js — o call centre
 * ---------------------------------------------------------------
 * As filas dos três públicos, os estados de agente, as métricas do
 * dia, a escalada, os atalhos e as tarefas do cron.
 *
 * Estava tudo dentro do partners.js porque o requireAdmin já lá
 * vivia. O ficheiro chegou a 87 KB com 53 rotas de dois sistemas
 * diferentes, e encontrar uma coisa lá dentro custava mais do que
 * escrevê-la.
 *
 * O que o PORTAL DE MOTORISTAS faz — registo, documentos, frota —
 * ficou no partners.js.
 * ---------------------------------------------------------------
 */

import { Router } from 'express';

export function createSupportRoutes({
  supabase,
  getUserFromRequest,
  requireAdmin,
  // Sem supervisor configurado, ninguém entra nas áreas dele. É o
  // valor seguro: recusar por omissão em vez de deixar passar.
  requireSupervisor = async () => ({ error: 'Supervisor check is not configured.' }),
  // As peças partilhadas com o portal. A MESMA instância nos dois:
  // duas cópias do chatFor seriam duas verdades sobre o que é uma
  // conversa.
  shared,
  email = {},
  config = {}
}) {
  if (!supabase) throw new Error('createSupportRoutes: supabase is required');
  if (!shared) throw new Error('createSupportRoutes: shared is required');

  const { notify, asUser, chatFor, historyFor } = shared;

  const router = Router();


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


  /**
   * O histórico de um parceiro: todos os tickets, do mais recente
   * ao mais antigo.
   *
   * Serve os dois lados. No portal, o parceiro vê as suas conversas
   * anteriores. No painel, o agente vê o que já foi dito antes de
   * responder — a diferença entre "quem é este?" e "vejo que
   * escreveu na semana passada sobre a fatura".
   */



  // ---------- lado do admin ----------

  /**
   * Marca as mensagens do parceiro como lidas.
   *
   * Chamado quando o agente abre a conversa. O parceiro passa a ver
   * que o que escreveu chegou — é daí que vêm as mensagens
   * repetidas quando não há resposta imediata.
   */
  router.post('/api/admin/chat/read', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { data, error } = await supabase.rpc('mark_partner_messages_read', {
      p_chat_id: chat_id
    });

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, marked: data || 0 });
  });


  router.get('/api/admin/chats', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    // Varrer primeiro: sem um trabalhador permanente, é o próprio
    // uso do painel que faz a rotação avançar. Como há sempre um
    // painel aberto quando há agentes ao serviço, funciona.
    try { await supabase.rpc('sweep_chat_offers'); } catch (e) {}
    try { await supabase.rpc('flag_stale_chats'); } catch (e) {}

    const [queueRes, ringingRes, watchRes] = await Promise.all([
      supabase.from('partner_chat_queue').select('*'),
      supabase.from('chat_offers')
        .select('*')
        .eq('agent_id', admin.id)
        .eq('outcome', 'ringing')
        .gt('expires_at', new Date().toISOString())
        .order('offered_at')
        .limit(1),

      // Quem está dentro de cada conversa. Sem isto, dois agentes
      // escrevem ao mesmo tempo sem saber um do outro.
      supabase.from('chat_presence').select('*').eq('chat_kind', 'partner')
    ]);

    if (queueRes.error) return res.status(500).json({ error: queueRes.error.message });

    const porChat = {};
    (watchRes.data || []).forEach((w) => { porChat[w.chat_id] = w.watchers; });

    return res.json({
      chats: (queueRes.data || []).map((c) => ({
        ...c,
        watchers: porChat[c.chat_id] || []
      })),
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
      .select('*')
      .eq('chat_id', req.params.chatId)
      .order('created_at').limit(300);

    if (error) return res.status(500).json({ error: error.message });

    /**
     * Os anexos, numa consulta à parte.
     *
     * Não há chave estrangeira entre partner_messages e
     * support_attachments — o Supabase recusa o join sem ela.
     */
    const { data: anexos } = await supabase
      .from('support_attachments')
      .select('*')
      .eq('chat_id', req.params.chatId);

    const porMsg = {};

    (anexos || []).forEach((a) => {
      if (a.message_id) porMsg[a.message_id] = a;
    });

    await supabase.from('partner_chats')
      .update({ unread_for_admin: 0 })
      .eq('id', req.params.chatId);

    // Cada anexo colado à mensagem dele.
    return res.json({
      messages: (messages || []).map((m) => {
        const a = porMsg[m.id];

        return a
          ? {
              ...m,
              file_path: a.file_path,
              file_name: a.file_name,
              file_type: a.file_type,
              file_size: a.file_size
            }
          : m;
      })
    });
  });


  router.post('/api/admin/chat/send', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, body } = req.body || {};
    if (!chat_id || !String(body || '').trim()) {
      return res.status(400).json({ error: 'Send chat_id and a message.' });
    }

    /**
     * A conversa está mesmo nesta tabela?
     *
     * O painel escolhe a rota pela fonte da conversa, e às vezes
     * engana-se — uma conversa aberta da pesquisa não estava na
     * lista carregada, e a função caía no palpite.
     *
     * O Postgres recusava com "partner_messages_chat_id_fkey", que
     * não diz nada a ninguém. Em vez de recusar, verifica-se: se
     * estiver na outra tabela, diz-se qual.
     */
    const { data: existe } = await supabase
      .from('partner_chats')
      .select('id')
      .eq('id', chat_id)
      .maybeSingle();

    if (!existe) {
      const { data: naOutra } = await supabase
        .from('support_chats')
        .select('id')
        .eq('id', chat_id)
        .maybeSingle();

      if (naOutra) {
        return res.status(409).json({
          error: 'That is a customer conversation.',
          use: '/api/admin/support/send'
        });
      }

      return res.status(404).json({
        error: 'That conversation no longer exists.'
      });
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
        internal
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    /**
     * O anexo vai para a tabela própria.
     *
     * Ia para colunas attachment_path e attachment_name na
     * partner_messages — que podem não existir. O Supabase ignora
     * colunas desconhecidas sem dar erro, e o anexo desaparecia em
     * silêncio: a mensagem chegava com o nome do ficheiro e nada
     * para abrir.
     *
     * É a mesma tabela que o lado dos clientes usa, e o painel já
     * a sabe ler.
     */
    let anexo = null;

    if (req.body.attachment_path && data) {
      const { data: a } = await supabase.from('support_attachments').insert({
        chat_id,
        message_id: data.id,
        file_url: '',
        file_path: req.body.attachment_path,
        file_name: req.body.attachment_name || 'file',
        file_type: req.body.attachment_type || 'application/octet-stream',
        file_size: req.body.attachment_size || null,
        sender_type: 'admin'
      }).select().maybeSingle();

      anexo = a || null;
    }

    return res.json({
      success: true,
      message: data && {
        ...data,
        file_path: anexo ? anexo.file_path : null,
        file_name: anexo ? anexo.file_name : null,
        file_type: anexo ? anexo.file_type : null
      }
    });
  });

  /**
   * Marcar-se ao serviço, e bater o ponto.
   *
   * O painel chama isto de dois em dois minutos enquanto estiver
   * aberto. Sem essa batida, a presença expira sozinha ao fim de
   * três — um separador esquecido aberto diria "online" toda a noite.
   */

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
     * A batida, com a hora do servidor.
     *
     * Escrevia new Date() do browser. Um portátil com o relógio dois
     * minutos atrasado dava-se como ausente a cada batida — e essa
     * era a causa do "fiquei offline sozinho".
     *
     * Agora é o Postgres que carimba, com now().
     */
    const allowed = ['live', 'active', 'escalating', 'follow-up',
                     'training', 'admin', 'break', 'lunch', 'offline'];

    const state = allowed.includes(req.body?.state) ? req.body.state : null;

    try {
      const { data, error } = await asUser(req).rpc('heartbeat', {
        p_state: state,
        p_name: req.body?.display_name || null,
        p_avatar: req.body?.avatar_path || null
      });

      if (error) throw error;

      // O estado completo volta na mesma resposta: o painel não
      // precisa de uma segunda chamada para saber onde ficou.
      const { data: agora } = await asUser(req).rpc('my_presence');

      return res.json({ success: true, ...(data || {}), presence: agora });
    } catch (e) {
      console.error('heartbeat:', e.message);
      return res.status(500).json({ error: e.message });
    }
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

      /**
       * Os anexos, numa consulta à parte.
       *
       * Não há chave estrangeira entre as duas tabelas, e sem ela o
       * Supabase recusa o join: "Could not find a relationship
       * between partner_messages and support_attachments".
       *
       * Duas consultas e uma junção aqui. É o que o lado dos
       * clientes já fazia.
       */
      const { data: anexos } = await supabase
        .from('support_attachments')
        .select('*')
        .eq('chat_id', req.params.id);

      const porMensagem = {};

      (anexos || []).forEach((a) => {
        if (a.message_id) porMensagem[a.message_id] = a;
      });

      const comAnexos = (messages || []).map((m) => {
        const a = porMensagem[m.id];

        return a
          ? {
              ...m,
              file_path: a.file_path,
              file_name: a.file_name,
              file_type: a.file_type,
              file_size: a.file_size
            }
          : m;
      });

      return res.json({ chat, messages: comAnexos });
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

    /**
     * A que trata das duas tabelas.
     *
     * A escalate_chat só conhecia a partner_chats — uma conversa de
     * cliente devolvia "no longer exists", que é o pior tipo de
     * mensagem: diz ao agente que a conversa desapareceu quando ela
     * está ali aberta no ecrã.
     */
    const { data, error } = await asUser(req).rpc('escalate_any_chat', {
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

      /**
       * As duas tabelas.
       *
       * O agent_closed_chats lia só a partner_chat_history — um
       * agente que fechasse dez conversas de clientes via a lista
       * vazia.
       */
      const { data, error } = await supabase.rpc('my_closed_chats', {
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
   * As filas de clientes e de agências.
   *
   * Mesma forma da dos parceiros, para o painel poder tratar as três
   * com o mesmo código. O que muda é a coluna audience.
   */

  /**
   * As filas de clientes e de agências.
   *
   * Mesma forma da dos parceiros, para o painel poder tratar as três
   * com o mesmo código. O que muda é a coluna audience.
   */
  router.get('/api/admin/support-queue', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const publico = req.query.audience === 'agency' ? 'agency' : 'customer';

    try {
      const [fila, cap] = await Promise.all([
        supabase.from('support_chat_queue')
          .select('*')
          .eq('audience', publico)
          .limit(200),
        supabase.rpc('support_capacity')
      ]);

      if (fila.error) throw fila.error;

      const meus = await supabase
        .from('support_chats')
        .select('id')
        .eq('assigned_to', admin.id)
        .eq('status', 'open');

      const vistas = await supabase
        .from('chat_presence').select('*').eq('chat_kind', 'support');

      const dentro = {};
      (vistas.data || []).forEach((w) => { dentro[w.chat_id] = w.watchers; });

      return res.json({
        chats: (fila.data || []).map((c) => ({
          ...c,
          watchers: dentro[c.chat_id] || []
        })),
        capacity: {
          ...((cap.data && cap.data[0]) || {}),
          my_open_chats: (meus.data || []).length
        }
      });
    } catch (err) {
      console.error('support queue:', err.message);
      return res.json({ chats: [], capacity: {} });
    }
  });

  /** Pegar uma conversa de cliente ou de agência. */

  /** Pegar uma conversa de cliente ou de agência. */
  router.post('/api/admin/support/claim', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { data, error } = await asUser(req).rpc('claim_support_chat', {
      p_chat_id: chat_id
    });

    if (error) return res.status(500).json({ error: error.message });

    if (data && data.ok === false) {
      const mensagens = {
        already_taken: 'Somebody else got there first.',
        at_capacity: 'You already have three conversations open. Close one first.'
      };
      return res.status(409).json({ error: mensagens[data.reason] || 'Could not take it.' });
    }

    return res.json({ success: true, ...(data || {}) });
  });

  /** Fechar, com motivo. */

  /** Fechar, com motivo. */
  router.post('/api/admin/support/close', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, reason, note } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { data, error } = await asUser(req).rpc('close_support_chat', {
      p_chat_id: chat_id,
      p_reason: reason || 'resolved',
      p_note: note || null
    });

    if (error) return res.status(500).json({ error: error.message });

    if (data && data.ok === false) {
      return res.status(409).json({
        error: data.reason === 'not_yours'
          ? 'That conversation is not yours to close.'
          : 'Could not close it.'
      });
    }

    return res.json({ success: true, ...(data || {}) });
  });

  /**
   * A fila. Uma só.
   *
   * Havia três rotas — uma por público — e a maior parte dos bugs
   * desta sessão veio daí: uma coisa que estava numa e não na
   * outra.
   *
   * O público passa a ser uma etiqueta na linha, não uma
   * estrutura. A ordem é o tempo de espera, e mais nada.
   */
  router.get('/api/admin/queue', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    try {
      const [fila, contagens, cap, vistas] = await Promise.all([
        supabase.from('unified_queue')
          .select('*')
          // Quem espera há mais tempo primeiro. O urgente tem
          // botão próprio; a fila não o usa para ordenar, senão
          // marcar urgente passaria a ser a forma de furar.
          .order('waiting_since', { ascending: true, nullsFirst: false })
          .limit(200),

        asUser(req).rpc('queue_counts'),
        supabase.rpc('support_capacity'),

        // Quem está a ver o quê, para o painel mostrar os colegas.
        supabase.from('chat_presence').select('*')
      ]);

      if (fila.error) throw fila.error;

      const porChat = {};
      (vistas.data || []).forEach((v) => { porChat[v.chat_id] = v; });

      const chats = (fila.data || []).map((c) => ({
        ...c,
        watchers: porChat[c.chat_id]?.watchers || [],
        mine: c.assigned_to === admin.id
      }));

      return res.json({
        chats,
        counts: contagens.data || {},
        capacity: cap.data || {}
      });
    } catch (err) {
      console.error('queue:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  /** Pegar ou entrar numa conversa, venha de onde vier. */
  router.post('/api/admin/queue/claim', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { data, error } = await asUser(req).rpc('claim_any_chat', {
      p_chat_id: chat_id
    });

    if (error) return res.status(500).json({ error: error.message });

    if (data && data.ok === false) {
      const mensagens = {
        already_taken: 'Somebody else got there first.',
        at_capacity: 'You already have three conversations open.',
        not_found: 'That conversation no longer exists.'
      };

      return res.status(409).json({
        error: mensagens[data.reason] || 'Could not take it.',
        reason: data.reason
      });
    }

    return res.json({ success: true, ...(data || {}) });
  });

  /** Fechar, venha de onde vier. */
  router.post('/api/admin/queue/close', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, reason, note } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { data, error } = await asUser(req).rpc('close_any_chat', {
      p_chat_id: chat_id,
      p_reason: reason || 'resolved',
      p_note: note || null
    });

    if (error) return res.status(500).json({ error: error.message });

    if (data && data.ok === false) {
      return res.status(403).json({ error: 'That conversation is not yours.' });
    }

    /**
     * E o agente entra em follow-up.
     *
     * Depois de fechar há trabalho por fazer: a nota, o email, a
     * reserva a atualizar. Sem isto recebia outra chamada a meio.
     *
     * A função decide se aplica: só de 'live', e só se ele ficou
     * sem conversas abertas.
     */
    await asUser(req).rpc('enter_followup').catch(() => {});

    return res.json({ success: true, ...(data || {}) });
  });

  /**
   * Procurar um ticket, aberto ou fechado.
   *
   * A fila mostra o que está aberto. Um ticket resolvido
   * desaparecia do painel — e um cliente com três conversas
   * anteriores não tinha histórico nenhum aos olhos do agente.
   *
   * Por texto, por estado, por dia. E o texto procura também
   * DENTRO das mensagens: um agente lembra-se do que foi dito, não
   * do número do ticket.
   */
  router.get('/api/admin/tickets', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    try {
      const { data, error } = await supabase.rpc('search_tickets', {
        p_text: req.query.q || null,
        p_status: req.query.status || 'all',
        p_audience: req.query.audience || 'all',
        p_from: req.query.from || null,
        p_to: req.query.to || null,
        p_limit: Math.min(Number(req.query.limit) || 100, 300)
      });

      if (error) throw error;

      return res.json({ tickets: data || [] });
    } catch (err) {
      console.error('tickets:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * O histórico de uma pessoa.
   *
   * É o que o agente devia ver ao abrir um chat: se é a primeira
   * vez ou a quarta. Atender alguém que já ligou três vezes sem o
   * saber é fazê-lo repetir a história.
   */
  router.get('/api/admin/tickets/history', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    if (!req.query.email) return res.json({ tickets: [] });

    const { data } = await supabase.rpc('tickets_for_email', {
      p_email: req.query.email
    });

    return res.json({ tickets: data || [] });
  });

  /**
   * O que há a pagar aos parceiros.
   *
   * Com o IBAN, para se poder transferir sem ir a outro lado. Só
   * supervisores: é dinheiro.
   */
  router.get('/api/admin/payouts', async (req, res) => {
    const { user: admin, error: supError } = await requireSupervisor(req);
    if (!admin) return res.status(403).json({ error: supError || 'Supervisors only.' });

    try {
      const { data, error } = await supabase
        .from('payouts_due')
        .select('*')
        .limit(200);

      if (error) throw error;

      const linhas = data || [];

      return res.json({
        payouts: linhas,
        summary: {
          pending: linhas.filter((p) => p.status === 'pending').length,
          due_amount: linhas
            .filter((p) => p.status !== 'paid')
            .reduce((t, p) => t + Number(p.amount || 0), 0),
          // Um parceiro sem IBAN não se pode pagar, e é melhor
          // sabê-lo antes de tentar.
          missing_iban: linhas.filter((p) => p.missing_iban && p.status !== 'paid').length
        }
      });
    } catch (err) {
      console.error('payouts:', err.message);
      return res.json({ payouts: [], summary: {} });
    }
  });

  /** Marcar um pagamento como feito. */
  router.post('/api/admin/payouts/paid', async (req, res) => {
    const { user: admin, error: supError } = await requireSupervisor(req);
    if (!admin) return res.status(403).json({ error: supError || 'Supervisors only.' });

    const { payout_id, reference, note } = req.body || {};
    if (!payout_id) return res.status(400).json({ error: 'Send payout_id.' });

    const { data, error } = await asUser(req).rpc('mark_payout_paid', {
      p_payout_id: payout_id,
      p_reference: reference || null,
      p_note: note || null
    });

    if (error) return res.status(500).json({ error: error.message });

    if (data && data.ok === false) {
      return res.status(400).json({ error: 'Already paid, or not found.' });
    }

    return res.json({ success: true });
  });

  /**
   * Fechar o mês.
   *
   * Junta as viagens feitas e os extras numa linha por parceiro.
   * Corrido à mão ou pelo cron no dia 1.
   */
  router.post('/api/admin/payouts/close', async (req, res) => {
    const { user: admin, error: supError } = await requireSupervisor(req);
    if (!admin) return res.status(403).json({ error: supError || 'Supervisors only.' });

    const { data, error } = await supabase.rpc('close_payout_period', {
      p_month: req.body?.month || null
    });

    if (error) return res.status(500).json({ error: error.message });

    return res.json(data || { ok: true });
  });

  /**
   * O mapa de cobertura.
   *
   * Cada aeroporto com as viaturas que lá temos, por classe, e a
   * procura dos últimos noventa dias.
   *
   * Uma lista diz quantos parceiros há em cada zona; o mapa mostra
   * que os buracos são geográficos — uma região inteira sem
   * ninguém, e não uma zona isolada.
   */
  router.get('/api/admin/coverage-map', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    try {
      const { data, error } = await supabase
        .from('coverage_map')
        .select('*');

      if (error) throw error;

      const zonas = data || [];

      return res.json({
        zones: zonas,
        summary: {
          full: zonas.filter((z) => z.status === 'full').length,
          partial: zonas.filter((z) => z.status === 'partial').length,
          none: zonas.filter((z) => z.status === 'none').length,

          /**
           * A procura que não se consegue servir.
           *
           * É o número que decide onde recrutar: uma zona sem
           * cobertura e sem procura é um problema teórico.
           */
          demand_uncovered: zonas
            .filter((z) => z.status !== 'full')
            .reduce((t, z) => t + Number(z.bookings_90d || 0), 0)
        }
      });
    } catch (err) {
      console.error('coverage map:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Respondi, agora espero.
   *
   * Diferente de resolver: o ticket continua aberto e o cliente
   * pode responder. Sai é da lista de "a fazer", porque a bola
   * está do lado dele.
   *
   * Sem isto, o agente escolhia entre deixar o ticket na lista
   * para sempre ou fechá-lo antes de o cliente confirmar.
   */
  /**
   * Respondi, espero pelo cliente.
   *
   * Chamava-se /chat/close e colidia com a rota de resolver, que
   * já existia com esse nome — o Express usa a primeira que
   * encontra, e esta nunca era chamada.
   *
   * Dois botões chamados "Close chat" na mesma barra, um deles a
   * dar erro. O nome certo diz o que faz.
   */
  router.post('/api/admin/chat/awaiting-reply', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    try {
      const { data, error } = await asUser(req).rpc('await_customer', {
        p_chat_id: chat_id
      });

      if (error) throw error;

      if (data && data.ok === false) {
        return res.status(400).json({
          error: data.reason === 'not_found'
            ? 'That conversation no longer exists.'
            : 'Could not update it.'
        });
      }

      return res.json({ success: true, ...(data || {}) });
    } catch (e) {
      console.error('mark replied:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  /**
   * Abrir a conta de alguém, em modo leitura.
   *
   * Um agente ao telefone com quem diz "não vejo a minha reserva"
   * precisa de ver o ecrã dele, não os dados. A diferença é entre
   * saber que a reserva existe e perceber porque não aparece.
   *
   * Devolve um código de dez minutos. Não é um token da conta: com
   * um token real, tudo o que o cliente pode fazer o agente também
   * podia — e um clique errado cancela uma reserva a sério.
   */
  router.post('/api/admin/view-as', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { email, kind, reason, chat_id } = req.body || {};

    if (!email) return res.status(400).json({ error: 'Send an email.' });

    try {
      const { data, error } = await asUser(req).rpc('open_view_as', {
        p_email: email,
        p_kind: kind || 'customer',
        p_reason: reason || null,
        p_chat_id: chat_id || null
      });

      if (error) throw error;

      if (data && data.ok === false) {
        const msg = {
          not_allowed: 'Administrator access required.',
          no_email: 'Send an email.',
          too_many: data.message || 'Too many accounts opened this hour.'
        };

        return res.status(400).json({ error: msg[data.reason] || 'Could not open it.' });
      }

      /**
       * O endereço completo, pronto a abrir.
       *
       * O painel só tem de o abrir numa janela nova — não precisa
       * de saber como se monta.
       */
      const base = data.kind === 'partner'
        ? (process.env.DRIVERS_URL || 'https://drivers.airportlink.app')
        : (process.env.SITE_ORIGIN || 'https://www.airportlink.app');

      const caminho = data.kind === 'partner' ? '/'
        : data.kind === 'agency' ? '/agency'
        : '/myaccount';

      return res.json({
        success: true,
        ...data,
        url: `${base}${caminho}?viewas=${data.code}`
      });
    } catch (e) {
      console.error('view as:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });


  /**
   * Os dados da conta, para a página em modo leitura.
   *
   * Sem autenticação de agente: quem tem o código tem acesso, e o
   * código dura dez minutos e foi criado por um agente
   * autenticado.
   *
   * Isto permite que a página do cliente — que não sabe nada de
   * agentes — a chame diretamente.
   */
  router.get('/api/view-as/:code', async (req, res) => {
    try {
      const { data, error } = await supabase.rpc('view_as_data', {
        p_code: req.params.code
      });

      if (error) throw error;

      if (!data || data.ok === false) {
        return res.status(404).json({
          error: 'That link has expired. Ask for a new one.'
        });
      }

      // Registar a página vista, para a auditoria.
      await supabase.rpc('use_view_as', {
        p_code: req.params.code,
        p_page: req.query.page || null
      });

      return res.json(data);
    } catch (e) {
      console.error('view as data:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });


  /** Quem viu a conta de quem. Só supervisores. */
  router.get('/api/admin/view-as-log', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    try {
      const { data, error } = await asUser(req).rpc('view_as_log', {
        p_days: Number(req.query.days) || 7
      });

      if (error) throw error;

      return res.json({ log: data || [] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  /**
   * Procurar parceiros por zona.
   *
   * Com cinquenta parceiros e cinquenta zonas, "quem cobre Faro?"
   * é a pergunta mais frequente que existe — e não havia forma de
   * a fazer no painel.
   */
  router.get('/api/admin/partners/by-zone', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    try {
      const { data, error } = await supabase.rpc('partners_by_zone', {
        p_zone: req.query.zone || null,
        p_status: req.query.status || null
      });

      if (error) throw error;

      return res.json({ partners: data || [] });
    } catch (err) {
      console.error('partners by zone:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * O mapa de cobertura.
   *
   * A peça mais importante disto tudo, e a que ninguém pede.
   *
   * Uma zona onde ninguém se registou vende na mesma. A viagem
   * fica parada e ninguém a recusa — porque ninguém a vê. Isto
   * mostra onde estamos a vender sem servir, antes de o cliente
   * escrever.
   */
  router.get('/api/admin/coverage', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    try {
      const { data, error } = await supabase
        .from('zone_coverage')
        .select('*')
        .limit(200);

      if (error) throw error;

      const zonas = data || [];

      return res.json({
        zones: zonas,
        // O resumo que o painel mostra no topo, sem ter de contar.
        summary: {
          selling_blind: zonas.filter((z) => z.state === 'selling_blind').length,
          thin: zonas.filter((z) => z.state === 'thin').length,
          empty: zonas.filter((z) => z.state === 'empty').length,
          ok: zonas.filter((z) => z.state === 'ok').length
        }
      });
    } catch (err) {
      console.error('coverage:', err.message);
      return res.json({ zones: [], summary: {} });
    }
  });

  /**
   * A cascata de uma reserva: a quem foi oferecida e o que
   * responderam.
   *
   * Quando uma viagem fica sem ninguém, é aqui que se percebe
   * porquê — se ninguém foi ofertado, se todos recusaram, ou se
   * todos ignoraram.
   */
  router.get('/api/admin/booking/:id/offers', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { data } = await supabase
      .from('ride_offers')
      .select('*, driver_partners(trading_name, legal_name)')
      .eq('booking_id', req.params.id)
      .order('rank');

    return res.json({ offers: data || [] });
  });

  /**
   * As disputas abertas.
   *
   * O evento mais caro que existe: o Stripe dá um prazo para
   * responder com provas, e passado sem resposta perde-se por
   * omissão — o valor da viagem mais uma taxa de cerca de 15 euros.
   *
   * Só supervisores: é dinheiro.
   */
  router.get('/api/admin/disputes', async (req, res) => {
    const { user: admin, error: supError } = await requireSupervisor(req);
    if (!admin) return res.status(403).json({ error: supError || 'Supervisors only.' });

    try {
      const { data, error } = await supabase
        .from('open_disputes')
        .select('*')
        .limit(50);

      if (error) throw error;

      return res.json({ disputes: data || [] });
    } catch (err) {
      console.error('disputes:', err.message);
      return res.json({ disputes: [] });
    }
  });

  /**
   * Quantos estão à espera em cada fila.
   *
   * O painel contava só a fila ABERTA e atribuía o número aos
   * motoristas — as outras duas abas mostravam zero mesmo com onze
   * clientes à espera.
   *
   * Uma chamada leve, feita com a fila: três contagens em vez de
   * três listas inteiras.
   */
  router.get('/api/admin/queue-counts', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    try {
      const [parceiros, apoio, escaladas] = await Promise.all([
        supabase.from('partner_chats')
          .select('assigned_to, unread_for_admin', { count: 'exact' })
          .eq('status', 'open'),

        supabase.from('support_chats')
          .select('audience, assigned_to, unread_for_admin')
          .eq('status', 'open'),

        supabase.from('partner_chats')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'open')
          .eq('escalated', true)
      ]);

      const conta = (lista, filtro) => (lista || []).filter(filtro);

      const p = parceiros.data || [];
      const a = apoio.data || [];

      const clientes = a.filter((c) => c.audience === 'customer');
      const agencias = a.filter((c) => c.audience === 'agency');

      // "À espera" é sem dono. O unread não entra: uma conversa
      // aberta sem ninguém está à espera mesmo que a última
      // mensagem já esteja lida.
      const espera = (l) => conta(l, (c) => !c.assigned_to).length;
      const curso = (l) => conta(l, (c) => c.assigned_to).length;

      return res.json({
        drivers: { espera: espera(p), curso: curso(p) },
        customers: { espera: espera(clientes), curso: curso(clientes) },
        agents: { espera: espera(agencias), curso: curso(agencias) },
        escalated: { espera: escaladas.count || 0, curso: 0 }
      });
    } catch (err) {
      console.error('queue counts:', err.message);
      return res.json({});
    }
  });

  /**
   * Quem é o cliente ou a agência, e o que já fez connosco.
   *
   * A coluna da direita pedia o contexto de PARCEIRO para todas as
   * conversas — e nas de cliente respondia "Could not load", porque
   * o id não existe na driver_partners.
   */
  router.get('/api/admin/support-chat/:chatId/context', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    try {
      const { data: chat } = await supabase
        .from('support_chats')
        .select('user_id, email, audience')
        .eq('id', req.params.chatId)
        .maybeSingle();

      if (!chat) return res.json({ context: null });

      // Uma agência tem nome comercial e comissão; um cliente tem
      // reservas. São duas perguntas diferentes.
      const [contacto, agencia, reservas] = await Promise.all([
        supabase.from('contacts')
          .select('full_name, email, phone_number, created_at')
          .eq('email', chat.email)
          .maybeSingle(),

        chat.audience === 'agency'
          ? supabase.from('travel_agents')
              .select('agency_name, commission, status, created_at')
              .eq('id', chat.user_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),

        /**
         * As reservas dele, pelo email.
         *
         * O campo do valor é o price — o amount_paid não existe em
         * lado nenhum, e somá-lo dava sempre zero. Um agente que
         * veja "gastou 0" num cliente com três viagens perde a
         * confiança em tudo o resto do painel.
         *
         * Dez e não cinco: a soma tem de contar as reservas todas,
         * não só as que cabem no ecrã.
         */
        supabase.from('bookings')
          // O id vai junto: sem ele o painel não consegue abrir a
          // reserva a partir daqui.
          // O booking_id junto: a coluna booking_reference está vazia
          // em todas as reservas, e é a única que o agente diz ao
          // telefone.
          .select('id, booking_id, booking_reference, booking_date, pickup, dropoff, status, price, currency')
          .eq('email', chat.email)
          .neq('status', 'cancelled')
          .order('booking_date', { ascending: false })
          .limit(20)
      ]);

      // As conversas anteriores desta pessoa.
      const anteriores = await supabase
        .rpc('tickets_for_email', { p_email: chat.email });

      const ct = contacto.data || {};
      const ag = agencia.data;
      const lista = reservas.data || [];

      return res.json({
        context: {
          audience: chat.audience,
          name: (ag && ag.agency_name) || ct.full_name || chat.email,
          email: chat.email,
          phone: ct.phone_number,
          joined_at: (ag && ag.created_at) || ct.created_at,

          agency_status: ag && ag.status,
          commission: ag && ag.commission,

          // As conversas anteriores. É o que diz ao agente se é a
          // primeira vez ou a quarta — e atender alguém que já
          // ligou três vezes sem o saber é fazê-lo repetir tudo.
          past_chats: (anteriores.data || [])
            .filter((t) => t.chat_id !== req.params.chatId)
            .slice(0, 5),

          bookings_total: lista.length,
          // Só as cinco mais recentes vão para o ecrã; a soma conta
          // todas.
          bookings: lista.slice(0, 5),
          spent: lista.reduce((t, b) => t + Number(b.price || 0), 0),
          currency: lista[0]?.currency || 'EUR'
        }
      });
    } catch (err) {
      console.error('support context:', err.message);
      return res.json({ context: null });
    }
  });

  /**
   * Enviar para um cliente ou uma agência.
   *
   * A rota dos parceiros escreve na partner_messages, que estas
   * conversas não usam. Sem esta, escrever numa conversa de cliente
   * não fazia nada — a mensagem ia para a tabela errada e o gatilho
   * de tempos nunca corria.
   */
  router.post('/api/admin/support/send', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, body } = req.body || {};

    if (!chat_id || !String(body || '').trim()) {
      return res.status(400).json({ error: 'Send chat_id and a message.' });
    }

        /**
     * A conversa está mesmo nesta tabela?
     *
     * O painel escolhe a rota pela fonte da conversa e às vezes
     * engana-se. Em vez de deixar o Postgres recusar com um erro
     * de chave estrangeira, diz-se qual é a certa.
     */
    const { data: existe } = await supabase
      .from('support_chats')
      .select('id')
      .eq('id', chat_id)
      .maybeSingle();

    if (!existe) {
      const { data: naOutra } = await supabase
        .from('partner_chats')
        .select('id')
        .eq('id', chat_id)
        .maybeSingle();

      if (naOutra) {
        return res.status(409).json({
          error: 'That is a partner conversation.',
          use: '/api/admin/chat/send'
        });
      }

      return res.status(404).json({
        error: 'That conversation no longer exists.'
      });
    }

const internal = req.body.internal === true;

    // O nome que o cliente lê vem da presença, não do browser.
    // Assim é o mesmo em todas as conversas.
    const { data: presence } = await supabase
      .from('support_presence')
      .select('display_name, avatar_path')
      .eq('user_id', admin.id)
      .maybeSingle();

    const { data, error } = await supabase.from('support_messages').insert({
      chat_id,
      sender_type: 'admin',
      sender_name: (presence && presence.display_name) || 'Airportlink',
      sender_avatar: presence && presence.avatar_path,
      message: String(body).trim(),
      internal
    }).select().maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    /**
     * O anexo, se houver, numa linha própria.
     *
     * A support_messages não tem colunas de ficheiro. Escrevê-las
     * ali não dava erro — o Supabase ignora colunas que não
     * existem — e o anexo desaparecia em silêncio.
     */
    let anexo = null;

    if (req.body.attachment_path && data) {
      const { data: a } = await supabase.from('support_attachments').insert({
        chat_id,
        message_id: data.id,
        file_url: '',
        file_path: req.body.attachment_path,
        file_name: req.body.attachment_name || 'file',
        file_type: req.body.attachment_type || 'application/octet-stream',
        file_size: req.body.attachment_size || null,
        sender_type: 'admin'
      }).select().maybeSingle();

      anexo = a;
    }

    /**
     * A mensagem volta traduzida.
     *
     * O painel põe-a na conversa sem esperar pelo próximo
     * carregamento — e lê sender e body, que é como a tabela dos
     * parceiros lhes chama. Sem esta tradução vinha undefined e o
     * ecrã dava "Cannot read properties of undefined".
     */
    /**
     * Num ticket, o cliente recebe um email.
     *
     * Ao vivo não: ele está no ecrã e acabou de ler a mensagem.
     * Num ticket fechou o separador e foi-se embora — sem o email,
     * a resposta fica num sítio que ninguém vai ver.
     *
     * As notas internas nunca saem: o cliente não as vê no chat, e
     * não as deve ver no email.
     */
    if (!internal && existe) {
      const { data: conversa } = await supabase
        .from('support_chats')
        .select('id, email, ticket, mode')
        .eq('id', chat_id)
        .maybeSingle();

      if (conversa?.mode === 'ticket' && conversa.email) {
        notify.ticketReply(conversa, String(body).trim(), presence)
          .catch((e) => console.error('ticket reply email:', e.message));
      }
    }

    const message = data && {
      id: data.id,
      chat_id: data.chat_id,
      sender: data.sender_type,
      sender_name: data.sender_name,
      sender_avatar: data.sender_avatar,
      body: data.message,
      internal: data.internal,

      file_path: anexo ? anexo.file_path : null,
      file_url: anexo ? anexo.file_url : null,
      file_name: anexo ? anexo.file_name : null,
      file_type: anexo ? anexo.file_type : null,

      created_at: data.created_at
    };

    return res.json({ success: true, message });
  });

  /**
   * As mensagens de uma conversa de cliente ou de agência.
   *
   * Não existia. O painel chamava a rota dos PARCEIROS para tudo,
   * e nas outras duas filas a conversa não abria — a resposta vinha
   * vazia e o ecrã ficava em branco.
   */
  router.get('/api/admin/support-chat/:chatId', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const chatId = req.params.chatId;

    const [msgs, chat, anexos] = await Promise.all([
      supabase.from('support_messages')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at')
        .limit(400),
      /**
       * Da TABELA, não da fila.
       *
       * A support_chat_queue só tem os abertos — é uma fila, não um
       * arquivo. Um chat resolvido devolvia null, e o painel dizia
       * "conversa não encontrada" a algo que existe e está ali.
       *
       * A tabela tem tudo, aberto ou fechado.
       */
      supabase.from('support_chats')
        .select('*')
        .eq('id', chatId)
        .maybeSingle(),

      /**
       * Os anexos vivem noutra tabela.
       *
       * A support_messages não tem file_path nem file_url — o site
       * do cliente grava a mensagem e depois uma linha na
       * support_attachments a apontar para ela.
       *
       * A rota inventava esses campos na mensagem, e por isso
       * vinham sempre vazios: o anexo existia e o painel nunca o
       * via.
       */
      supabase.from('support_attachments')
        .select('*')
        .eq('chat_id', chatId)
    ]);

    if (msgs.error) return res.status(500).json({ error: msgs.error.message });

    /**
     * As duas tabelas usam nomes diferentes para o mesmo.
     *
     * A partner_messages tem sender e body; a support_messages tem
     * sender_type e message. Traduz-se aqui, uma vez, em vez de o
     * painel ter de saber a diferença em vinte sítios.
     */
    // Cada anexo vai colado à mensagem dele.
    const porMensagem = {};

    (anexos.data || []).forEach((a) => {
      if (a.message_id) porMensagem[a.message_id] = a;
    });

    const messages = (msgs.data || []).map((m) => {
      const anexo = porMensagem[m.id];

      return {
        id: m.id,
        chat_id: m.chat_id,
        sender: m.sender_type,
        sender_name: m.sender_name,
        sender_avatar: m.sender_avatar,
        body: m.message,
        internal: m.internal,

        // O painel lê estes nomes. Vêm da outra tabela.
        file_path: anexo ? anexo.file_path : null,
        file_url: anexo ? anexo.file_url : null,
        file_name: anexo ? anexo.file_name : null,
        file_type: anexo ? anexo.file_type : null,
        file_size: anexo ? anexo.file_size : null,

        created_at: m.created_at,
        read_at: m.read_at
      };
    });

    // Ao abrir, o que o cliente escreveu passa a lido.
    await supabase.from('support_chats')
      .update({ unread_for_admin: 0 })
      .eq('id', chatId);

    /**
     * O painel espera chat_id, a tabela chama-lhe id.
     *
     * A fila renomeava a coluna e o painel aprendeu esse nome.
     * Traduz-se aqui, uma vez, em vez de mudar vinte sítios.
     */
    const conversa = chat.data
      ? { ...chat.data, chat_id: chat.data.id }
      : null;

    return res.json({ messages, chat: conversa });
  });

  /**
   * Dizer que estou nesta conversa.
   *
   * Chamado ao abrir e a cada batida do ponto. Distingue quem
   * ATENDE de quem só LÊ — duas coisas diferentes que o painel
   * mostrava como uma, e o agente não sabia se podia escrever ou
   * se atrapalhava.
   */
  router.post('/api/admin/chat/presence', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, kind, mode } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { error } = await asUser(req).rpc('chat_presence_ping', {
      p_chat_id: chat_id,
      p_kind: kind === 'support' ? 'support' : 'partner',
      p_mode: mode === 'handling' ? 'handling' : 'viewing'
    });

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true });
  });

  /**
   * O trabalho de fundo está a correr?
   *
   * Uma pergunta que o painel faz de vez em quando. Sem ela, um
   * cron parado passa despercebido até alguém notar que ninguém é
   * avisado de nada há três dias.
   */
  router.get('/api/admin/health', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { data, error } = await supabase.rpc('tick_health');

    if (error) return res.json({ healthy: null });

    return res.json(data || { healthy: null });
  });

  /**
   * Quem sou eu, e tudo o que o painel precisa para arrancar.
   *
   * Nome, cargo, avatar, estado, há quanto tempo, preferências e
   * atalhos — numa chamada só. O painel deixa de guardar seja o que
   * for entre sessões: arranca sem saber nada e pergunta.
   *
   * Isso importa com vários agentes. Dois no mesmo computador
   * partilhavam o localStorage, e o segundo a entrar via o nome do
   * primeiro.
   */
  router.get('/api/admin/session', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { data, error } = await asUser(req).rpc('agent_session');

    if (error) return res.status(500).json({ error: error.message });

    if (!data || data.ok === false) {
      return res.status(401).json({ error: 'Session could not be read.' });
    }

    /**
     * A presença vem da fonte única.
     *
     * O agent_session juntava peças de três sítios, e quando
     * discordavam escolhia a mais pessimista. O my_presence
     * responde à pergunta uma vez.
     */
    const { data: presenca } = await asUser(req).rpc('my_presence');

    return res.json({
      ...data,
      presence: presenca || null,

      // O que o painel lê para saber se pode receber conversas.
      state: presenca?.state || data.state,
      present: presenca?.present || false
    });
  });

  /** Guardar uma preferência. Só o que mudou. */
  router.post('/api/admin/prefs', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { audience, brand, sound_on, tab } = req.body || {};

    const { data, error } = await asUser(req).rpc('set_agent_prefs', {
      p_audience: audience || null,
      p_brand: brand || null,
      p_sound_on: typeof sound_on === 'boolean' ? sound_on : null,
      p_tab: tab || null
    });

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, ...(data || {}) });
  });

  /**
   * O nome do agente.
   *
   * Gravado na presença, que é onde a equipa o vê. Sem cópia no
   * browser: mudar o nome num computador muda-o em todos, incluindo
   * no painel do supervisor.
   */
  router.post('/api/admin/name', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { name } = req.body || {};

    const { data, error } = await asUser(req).rpc('set_agent_name', { p_name: name || '' });

    if (error) return res.status(500).json({ error: error.message });

    if (data && data.ok === false) {
      return res.status(400).json({ error: 'A name is needed.' });
    }

    return res.json({ success: true, ...(data || {}) });
  });

  /**
   * Entrar numa conversa que já tem alguém.
   *
   * Não tira nada a ninguém: os dois ficam, os dois podem escrever,
   * e o nome vai em cada mensagem. Um agente que precise de ajuda
   * passa a poder pedi-la sem ter de escalar formalmente.
   */
  router.post('/api/admin/chat/join', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, kind, reason } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { data, error } = await asUser(req).rpc('join_chat', {
      p_chat_id: chat_id,
      p_kind: kind === 'support' ? 'support' : 'partner',
      p_reason: reason || null
    });

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, ...(data || {}) });
  });

  router.post('/api/admin/chat/leave', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    await asUser(req).rpc('leave_chat', { p_chat_id: chat_id });

    return res.json({ success: true });
  });

  /**
   * Tomar conta. Diferente de entrar.
   *
   * Passa a conversa para quem pede. Serve para quando o agente
   * original saiu e não volta — e fica registado quem tirou a quem,
   * porque uma conversa que muda de mãos sem rasto é uma conversa
   * que ninguém sabe explicar depois.
   */
  router.post('/api/admin/chat/takeover', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { chat_id, kind, reason } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'Send chat_id.' });

    const { data, error } = await asUser(req).rpc('take_over_chat', {
      p_chat_id: chat_id,
      p_kind: kind === 'support' ? 'support' : 'partner',
      p_reason: reason || null
    });

    if (error) return res.status(500).json({ error: error.message });

    if (data && data.ok === false) {
      return res.status(409).json({
        error: data.reason === 'at_capacity'
          ? 'You already have three conversations open. Close one first.'
          : 'Could not take it over.'
      });
    }

    return res.json({ success: true, ...(data || {}) });
  });

  /**
   * A fila de escaladas.
   *
   * Só supervisores. Uma conversa escalada sai da fila normal —
   * deixá-la lá significa que um agente a pode pegar outra vez, e o
   * parceiro explica tudo pela terceira vez à mesma pessoa que já
   * não sabia responder.
   */

  /**
   * A fila de escaladas.
   *
   * Só supervisores. Uma conversa escalada sai da fila normal —
   * deixá-la lá significa que um agente a pode pegar outra vez, e o
   * parceiro explica tudo pela terceira vez à mesma pessoa que já
   * não sabia responder.
   */
  router.get('/api/admin/escalations', async (req, res) => {
    const { user: admin, error: supError } = await requireSupervisor(req);
    if (!admin) return res.status(403).json({ error: supError || 'Supervisors only.' });

    try {
      /**
       * As escaladas das duas tabelas.
       *
       * A escalation_queue só tinha as de parceiros. Um supervisor
       * não via as de clientes — e essas são as que têm um cliente
       * do outro lado a perguntar quando é que alguém responde.
       */
      const { data, error } = await supabase
        .from('escalated_chats')
        .select('*')
        .order('escalated_at', { ascending: true })
        .limit(100);

      if (error) throw error;

      return res.json({ chats: data || [] });
    } catch (err) {
      console.error('escalations:', err.message);
      return res.json({ chats: [] });
    }
  });

  /**
   * Um parceiro, por inteiro.
   *
   * O que submeteu, o que falta, os motoristas, as viaturas, as
   * zonas e as últimas reservas. O painel mostrava o nome e o email;
   * tudo o resto estava na base sem ninguém o ver — incluindo se ele
   * já tinha entregado o seguro.
   */

  /**
   * Um parceiro, por inteiro.
   *
   * O que submeteu, o que falta, os motoristas, as viaturas, as
   * zonas e as últimas reservas. O painel mostrava o nome e o email;
   * tudo o resto estava na base sem ninguém o ver — incluindo se ele
   * já tinha entregado o seguro.
   */
  /**
   * Aprovar ou rejeitar um parceiro.
   *
   * Faltava por inteiro — um supervisor via a candidatura e não
   * tinha por onde decidir.
   */
  router.post('/api/admin/partner/decision', async (req, res) => {
    const { user: admin, error: supError } = await requireSupervisor(req);
    if (!admin) return res.status(403).json({ error: supError || 'Supervisors only.' });

    const { partner_id, decision, reason } = req.body || {};

    if (!partner_id || !['approved', 'rejected', 'suspended'].includes(decision)) {
      return res.status(400).json({ error: 'Send partner_id and a valid decision.' });
    }

    /**
     * Uma rejeição sem motivo é uma rejeição que gera uma pergunta.
     *
     * O parceiro lê isto, e escrever uma frase agora poupa a
     * conversa de depois.
     */
    if (decision !== 'approved' && !String(reason || '').trim()) {
      return res.status(400).json({ error: 'Say why. They see this.' });
    }

    const { data: partner } = await supabase
      .from('driver_partners')
      .select('*')
      .eq('id', partner_id)
      .maybeSingle();

    if (!partner) return res.status(404).json({ error: 'Partner not found.' });

    const { error } = await supabase.from('driver_partners').update({
      status: decision,
      decision_reason: reason ? String(reason).trim() : null,
      decided_at: new Date().toISOString(),
      decided_by: admin.id,
      updated_at: new Date().toISOString()
    }).eq('id', partner_id);

    if (error) return res.status(500).json({ error: error.message });

    // O parceiro sabe. Sem esperar: a decisão já está gravada.
    notify.decision(partner, decision, reason || null).catch((e) =>
      console.error('decision email:', e.message));

    return res.json({ success: true });
  });

  router.get('/api/admin/partner/:id/full', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    try {
      const { data, error } = await supabase.rpc('partner_full', {
        p_partner_id: req.params.id
      });

      if (error) throw error;

      if (data && data.ok === false) {
        return res.status(404).json({ error: 'Partner not found.' });
      }

      return res.json(data || {});
    } catch (err) {
      console.error('partner full:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Atalhos: os da casa mais os meus.
   *
   * A RLS já filtra — cada agente vê os públicos e os próprios. Aqui
   * é só devolver o que ela deixar passar.
   */

  /**
   * Atalhos: os da casa mais os meus.
   *
   * A RLS já filtra — cada agente vê os públicos e os próprios. Aqui
   * é só devolver o que ela deixar passar.
   */
  router.get('/api/admin/snippets', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { data, error } = await asUser(req)
      .from('support_snippets')
      .select('*')
      .order('uses', { ascending: false })
      .order('shortcut');

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ snippets: data || [] });
  });


  router.post('/api/admin/snippets', async (req, res) => {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

    const { id, shortcut, title, body, remove, shared } = req.body || {};

    if (remove && id) {
      const { error } = await asUser(req).from('support_snippets').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, removed: true });
    }

    const atalho = String(shortcut || '').trim().replace(/^\/+/, '');

    if (!atalho || !body) {
      return res.status(400).json({ error: 'A shortcut and the text are both needed.' });
    }

    // Partilhar com a equipa é decisão de supervisor. Um atalho da
    // casa aparece a toda a gente, e nem tudo o que serve a uma
    // pessoa serve às outras.
    const dono = shared && admin.isSupervisor ? null : admin.id;

    const linha = {
      shortcut: atalho,
      title: title || atalho,
      body: String(body).trim(),
      owner_id: dono
    };

    if (id) {
      const { error } = await asUser(req)
        .from('support_snippets').update(linha).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, updated: true });
    }

    const { data, error } = await asUser(req)
      .from('support_snippets').insert(linha).select().maybeSingle();

    if (error) {
      return res.status(500).json({
        error: /duplicate|unique/i.test(error.message)
          ? 'You already have a shortcut with that name.'
          : error.message
      });
    }

    return res.json({ success: true, snippet: data });
  });

  /**
   * Quanto tempo hoje em cada estado.
   *
   * Sem agent_id devolve o do próprio; com ele, e sendo supervisor,
   * o de outra pessoa. Por agora todos os administradores podem ver
   * todos — quando houver supervisores a sério, esta é a linha a
   * apertar.
   */

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
    /**
     * As duas tabelas usam palavras diferentes para o mesmo.
     *
     * A partner_chats fecha com 'closed'; a support_chats, que
     * nasceu antes, com 'resolved'. Aceitar só uma delas fazia esta
     * rota recusar metade dos pedidos sem dizer porquê.
     */
    if (['open', 'closed', 'resolved', 'pending'].includes(status)) {
      patch.status = status;
    }

    /**
     * A conversa pode estar em qualquer das duas tabelas.
     *
     * Escrevia só na partner_chats. Numa conversa de cliente o
     * update não encontrava nada — e o Supabase não considera isso
     * um erro: zero linhas alteradas devolve sucesso.
     *
     * Por isso o botão de urgente não fazia "rigorosamente nada" e
     * não dizia porquê.
     */
    let { error, count } = await supabase
      .from('partner_chats')
      .update(patch, { count: 'exact' })
      .eq('id', chat_id);

    if (error) return res.status(500).json({ error: error.message });

    if (!count) {
      ({ error, count } = await supabase
        .from('support_chats')
        .update(patch, { count: 'exact' })
        .eq('id', chat_id));

      if (error) return res.status(500).json({ error: error.message });
    }

    if (!count) {
      return res.status(404).json({ error: 'That conversation no longer exists.' });
    }

    return res.json({ success: true });
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

      /**
       * Os emails das ofertas novas.
       *
       * O sweep_ride_offers avança a cascata, mas o Postgres não
       * envia emails. Sem isto, só o PRIMEIRO parceiro de cada
       * viagem era avisado — os seguintes recebiam a oferta em
       * silêncio e ela expirava sempre.
       */
      try {
        const { data: novas } = await supabase
          .from('ride_offers')
          .select('*, driver_partners(id, email, trading_name), bookings(*)')
          .eq('outcome', 'pending')
          .is('responded_at', null)
          .gt('expires_at', new Date().toISOString())
          .order('offered_at', { ascending: false })
          .limit(20);

        for (const o of novas || []) {
          const parceiro = o.driver_partners;
          const reserva = o.bookings;

          if (!parceiro?.email || !reserva) continue;

          // O sendOnce trava os repetidos: a chave inclui a
          // posição na cascata, por isso cada oferta é avisada uma
          // vez e só uma.
          await notify.rideOffer(parceiro, reserva, {
            rank: o.rank,
            reason: o.match_reason,
            expires_in_minutes: Math.max(1,
              Math.round((new Date(o.expires_at) - Date.now()) / 60000))
          });
        }
      } catch (e) {
        console.error('ride offer emails:', e.message);
      }

      /**
       * Os lembretes, a meio do prazo.
       *
       * A coisa que mais reduz o ignorar. Um parceiro que não
       * respondeu ao primeiro email muitas vezes não o viu — não é
       * que não queira a viagem.
       */
      try {
        const { data: lembrar } = await supabase.rpc('offers_needing_reminder');

        for (const o of lembrar || []) {
          const { data: reserva } = await supabase
            .from('bookings')
            .select('*')
            .eq('id', o.booking_id)
            .maybeSingle();

          if (!reserva || !o.partner_email) continue;

          await notify.rideOfferReminder(
            { id: o.partner_id, email: o.partner_email, trading_name: o.partner_name },
            reserva,
            { minutes_left: o.minutes_left }
          );

          /**
           * Marcar depois de enviar, não antes.
           *
           * Se o email falhar, a oferta fica por lembrar e a
           * próxima passagem tenta outra vez. Marcar antes perderia
           * o lembrete de vez.
           */
          await supabase.rpc('mark_offer_reminded', {
            p_offer_id: o.offer_id,
            // O SMS fica para quando houver: a coluna existe e o
            // caminho está aberto.
            p_sms: false
          });
        }
      } catch (e) {
        console.error('offer reminders:', e.message);
      }

      /**
       * Deixar registo de que correu.
       *
       * Se o cron parar — a conta expira, o segredo muda, o serviço
       * fica em baixo — todo o trabalho de fundo para. E nada avisa:
       * o painel continua a funcionar, por isso ninguém repara.
       *
       * O painel lê isto e mostra um aviso se passarem cinco
       * minutos sem batida.
       */
      try {
        await supabase.rpc('tick_ran', { p_result: resumo });
      } catch (e) {
        console.error('tick_ran failed:', e.message);
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

  return router;
}
