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
      internal,
      file_path: req.body.attachment_path || null,
      file_url: req.body.attachment_name || null
    }).select().maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    /**
     * A mensagem volta traduzida.
     *
     * O painel põe-a na conversa sem esperar pelo próximo
     * carregamento — e lê sender e body, que é como a tabela dos
     * parceiros lhes chama. Sem esta tradução vinha undefined e o
     * ecrã dava "Cannot read properties of undefined".
     */
    const message = data && {
      id: data.id,
      chat_id: data.chat_id,
      sender: data.sender_type,
      sender_name: data.sender_name,
      sender_avatar: data.sender_avatar,
      body: data.message,
      internal: data.internal,
      file_url: data.file_url,
      file_path: data.file_path,
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

    const [msgs, chat] = await Promise.all([
      supabase.from('support_messages')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at')
        .limit(400),
      supabase.from('support_chat_queue')
        .select('*')
        .eq('chat_id', chatId)
        .maybeSingle()
    ]);

    if (msgs.error) return res.status(500).json({ error: msgs.error.message });

    /**
     * As duas tabelas usam nomes diferentes para o mesmo.
     *
     * A partner_messages tem sender e body; a support_messages tem
     * sender_type e message. Traduz-se aqui, uma vez, em vez de o
     * painel ter de saber a diferença em vinte sítios.
     */
    const messages = (msgs.data || []).map((m) => ({
      id: m.id,
      chat_id: m.chat_id,
      sender: m.sender_type,
      sender_name: m.sender_name,
      sender_avatar: m.sender_avatar,
      body: m.message,
      internal: m.internal,
      file_url: m.file_url,
      file_path: m.file_path,
      created_at: m.created_at,
      read_at: m.read_at
    }));

    // Ao abrir, o que o cliente escreveu passa a lido.
    await supabase.from('support_chats')
      .update({ unread_for_admin: 0 })
      .eq('id', chatId);

    return res.json({ messages, chat: chat.data || null });
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

    return res.json(data);
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
      const { data, error } = await supabase
        .from('escalation_queue')
        .select('*')
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

    const { error } = await supabase.from('partner_chats').update(patch).eq('id', chat_id);
    if (error) return res.status(500).json({ error: error.message });

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
