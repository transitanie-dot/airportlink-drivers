/**
 * airportlink-drivers/public/assets/help-bot.js
 * ---------------------------------------------------------------
 * Respostas automáticas no chat de parceiros. Sem IA.
 *
 * Como funciona: cada tópico tem palavras que o identificam. A
 * mensagem é comparada com todos, e ganha o que tiver mais peso.
 * Se nenhum chegar ao mínimo, o bot não inventa — diz que não
 * percebeu e passa a conversa para a fila.
 *
 * Porquê sem IA: as perguntas de um motorista são repetitivas e as
 * respostas são factos do sistema, não opiniões. Um modelo caro
 * responderia o mesmo, com o risco de inventar uma promessa que nos
 * obriga depois.
 *
 * REGRA DE OURO deste ficheiro: o bot informa, nunca decide. Nada
 * aqui promete dinheiro, autoriza alterações ou responde a
 * reclamações. Esses tópicos existem — mas só para reconhecer o
 * assunto e chamar uma pessoa de imediato.
 * ---------------------------------------------------------------
 */
(function (global) {
  'use strict';

// Sem número de telefone. O apoio é por aqui, e uma resposta que
// manda telefonar para um número que pode não estar atendido é pior
// do que uma que diz claramente o que acontece a seguir.

  /**
   * Assuntos que o bot NUNCA tenta responder.
   *
   * Reconhece-os para chamar uma pessoa mais depressa, não para
   * dizer alguma coisa. Uma resposta automática a "não recebi o meu
   * pagamento" é a pior coisa que este ficheiro poderia fazer.
   */
  var ESCALATE = [
    {
      id: 'money_missing',
      words: ['not paid', 'no payment', 'did not receive', 'havent received', "haven't received",
              'missing payment', 'where is my money', 'not been paid', 'unpaid', 'owe me',
              'wrong amount', 'less than', 'short paid'],
      reply: 'That needs a person to look at your account, not an automatic answer. ' +
        'I have put you in the queue — someone will check the payment run and come back to you.'
    },
    {
      id: 'complaint',
      words: ['complain', 'complaint', 'unfair', 'unacceptable', 'terrible', 'angry',
              'disgusting', 'furious', 'scam', 'lawyer', 'legal action', 'report you'],
      reply: 'I am sorry this has happened. This is not something I should answer automatically — ' +
        'I have put you through to a person who can actually deal with it.'
    },
    {
      id: 'emergency',
      words: ['accident', 'crash', 'emergency', 'police', 'ambulance', 'hospital',
              'broken down', 'breakdown', 'stranded', 'broke down', 'car broke',
              'wont start', 'will not start', 'flat tyre', 'flat tire'],
      reply: 'If anyone is hurt, call the emergency services first.\n\n' +
        'I have flagged this conversation as urgent so it goes to the top of the queue. ' +
        'Tell us what happened and which ride it is, and someone picks it up as a priority.',
      urgent: true
    },
    {
      id: 'passenger_now',
      words: ['passenger is not here', 'cannot find the passenger', 'no show', 'noshow',
              'nobody came', 'not showing up', 'waiting at the airport', 'been waiting'],
      reply: 'Call the number on the ride first — most of these are solved with one call.\n\n' +
        'If there is no answer, tell me the ride reference here. I have flagged this ' +
        'conversation as urgent so someone sees it now.',
      urgent: true
    },
    {
      id: 'cancel_account',
      words: ['close my account', 'delete my account', 'leave airportlink', 'stop working with',
              'cancel my registration', 'remove my company'],
      reply: 'I would rather a person talked to you about that than a bot. ' +
        'You are in the queue — someone will be with you.'
    }
  ];

  /**
   * O que o bot responde bem: factos do sistema.
   *
   * Cada resposta diz o que é verdade hoje. Quando uma regra mudar,
   * muda-se aqui — e é por isso que estão todas neste ficheiro e não
   * espalhadas pelo código.
   */
  var TOPICS = [
    // ---------- dinheiro, mas em geral ----------
    {
      id: 'when_paid',
      words: ['when am i paid', 'when do i get paid', 'payment date', 'payout date',
              'when is payday', 'how often paid', 'monthly payment', 'when will i be paid',
              'payment schedule', 'paid', 'payment', 'payout', 'salary', 'earnings',
              'money', 'how much do i earn', 'wages', 'transfer to my account'],
      reply: 'Once a month. At the start of each month you get a statement by email covering ' +
        'every ride you completed the month before, and the money goes to the account on ' +
        'your Payouts page in the first working days.\n\n' +
        'The fee shown on each ride is what reaches you in full — we take no commission on top.'
    },
    {
      id: 'commission',
      words: ['commission', 'your cut', 'how much do you take', 'do you charge me',
              'percentage', 'fee you take', 'deduction'],
      reply: 'None. The amount you see on a ride before you take it is exactly what is ' +
        'transferred to you.\n\n' +
        'Our margin is in what the passenger pays, which is a separate number you never ' +
        'have to think about.'
    },
    {
      id: 'iban',
      words: ['iban', 'bank account', 'payout details', 'change my bank', 'where to add bank',
              'account number', 'bank details'],
      reply: 'Payouts page in the sidebar. Add or change the IBAN there and it applies to ' +
        'the next payment run.\n\n' +
        'Without an IBAN we cannot pay you, even for rides you have already completed — ' +
        'so it is worth checking it is there.'
    },
    {
      id: 'statement',
      words: ['statement', 'invoice', 'receipt for my rides', 'monthly summary',
              'proof of earnings', 'my earnings'],
      reply: 'The monthly statement arrives by email at the start of each month, with every ' +
        'ride listed and the total due to you.\n\n' +
        'If something on it looks wrong, reply to that email with the reference and it gets ' +
        'checked before the payment run.'
    },

    // ---------- viagens ----------
    {
      id: 'no_rides',
      words: ['no rides', 'nothing showing', 'empty board', 'no work', 'no transfers',
              'board is empty', 'not getting rides', 'no offers', 'why no rides',
              'no jobs', 'nothing available', 'no bookings', 'quiet', 'no clients',
              'when do i get work', 'more work'],
      reply: 'Four possible reasons, and the Available rides page tells you which one applies ' +
        'to you:\n\n' +
        '· Your account is not approved yet\n' +
        '· You have not chosen any airports — rides are matched by pick-up airport\n' +
        '· You have no payout details on file\n' +
        '· There is genuinely nothing at your airports right now\n\n' +
        'Open that page and the message at the top says which it is.'
    },
    {
      id: 'how_claim',
      words: ['how do i take', 'how to accept', 'claim a ride', 'accept a transfer',
              'take a ride', 'book a ride', 'get a job', 'accept', 'claim', 'take a job',
              'how does it work', 'how do rides work'],
      reply: 'Open Available rides and press "Take this ride". First to take it gets it.\n\n' +
        'The passenger name and phone number appear only after it is yours — before that ' +
        'nobody can see them, including you.'
    },
    {
      id: 'release',
      words: ['cancel a ride', 'give back', 'release', 'cannot do the ride', "can't do it",
              'drop a ride', 'return a ride', 'no longer available'],
      reply: 'Open Available rides, find it under "Your rides" and press "Release this ride". ' +
        'Possible until 24 hours before pick-up.\n\n' +
        'Inside 24 hours you cannot release it yourself — write here and someone sorts it ' +
        'out with you. Please do not simply not turn up: there is a passenger at an airport ' +
        'counting on you.\n\n' +
        'Releasing often does affect how much work reaches you, so it is worth being ' +
        'realistic when you take one.'
    },
    {
      id: 'passenger_details',
      words: ['passenger name', 'passenger phone', 'contact the passenger', 'who is the passenger',
              'customer details', 'client phone'],
      reply: 'They appear on the ride as soon as it is yours — name, phone number, and any ' +
        'note they left.\n\n' +
        'Before a ride is claimed nobody sees them. That is deliberate: the passenger gave ' +
        'us their number for the transfer, not for a list.'
    },
    {
      id: 'flight_delay',
      words: ['flight delay', 'flight is late', 'plane delayed', 'landing late',
              'delayed flight', 'flight tracking', 'delayed', 'delay', 'flight',
              'waiting time', 'how long do i wait'],
      reply: 'The flight number is on the ride. Check the actual landing time before you set ' +
        'off and adjust — the passenger is not charged extra for a delay and neither are you ' +
        'penalised for the wait.\n\n' +
        'Airport pick-ups have 60 minutes of free waiting after the flight lands.'
    },
    {
      id: 'meeting_point',
      words: ['where do i meet', 'meeting point', 'where to wait', 'arrivals hall',
              'find the passenger', 'pick up point'],
      reply: 'You agree it with the passenger. Call or message them once the ride is yours — ' +
        'most airports have an obvious arrivals meeting area, but the passenger usually has ' +
        'a preference.\n\n' +
        'Doing this the day before, rather than on the day, prevents almost every problem ' +
        'we see.'
    },

    // ---------- documentos e conta ----------
    {
      id: 'documents',
      words: ['document', 'upload', 'paperwork', 'insurance', 'licence', 'license',
              'certificate', 'registry', 'which documents', 'documents', 'file',
              'attach', 'send documents', 'what do i need', 'requirements'],
      reply: 'Three company documents: your company registry, your insurance, and your ' +
        'passenger transport licence. All on the Documents page.\n\n' +
        'Choose the file and it uploads straight away — there is no second button to press. ' +
        'If one is rejected it turns red with the reason written next to it; upload a new ' +
        'file and your account goes back for review automatically.'
    },
    {
      id: 'doc_expired',
      // Peso acima de 1 porque compete com 'documents': quem escreve
      // "my insurance expired" quer saber da validade, não de como
      // se carrega um ficheiro.
      weight: 1.6,
      words: ['expired', 'expiry', 'expiring', 'out of date', 'renew', 'renewal',
              'document ran out', 'insurance expired', 'licence expired'],
      reply: 'Rides stop reaching you on the expiry date. We warn you 30 days, 7 days and ' +
        '1 day before.\n\n' +
        'Upload the new one on the Documents page and you are back in immediately. Rides you ' +
        'already accepted are not cancelled — please still do those.'
    },
    {
      id: 'approval',
      words: ['how long approval', 'still waiting approval', 'not approved', 'pending',
              'under review', 'when will i be approved', 'application status',
              'approval', 'approved', 'review my account', 'activate my account',
              'go live', 'when can i start', 'account status', 'still waiting',
              'how long', 'verification', 'verify', 'my application'],
      reply: 'We check every account by hand, usually within a few working days.\n\n' +
        'Your Overview page shows exactly which of the five steps are done: documents, ' +
        'a driver, a vehicle, your airports, and payout details. All five have to be ' +
        'complete before we can review it.\n\n' +
        'If something is wrong we tell you which document and why — you will never get a ' +
        'rejection without a reason.'
    },
    {
      id: 'add_driver',
      words: ['add a driver', 'new driver', 'another driver', 'my drivers', 'employee',
              'add vehicle', 'new car', 'new vehicle', 'add a van', 'new van',
              'van', 'vehicle', 'car', 'minibus', 'fleet', 'seats'],
      reply: 'Drivers and Vehicles pages in the sidebar. You can add as many as you like, ' +
        'at any time.\n\n' +
        'A bigger vehicle means bigger groups reach you: a booking for six only appears to ' +
        'companies with a vehicle that seats six.'
    },
    {
      id: 'airports',
      words: ['airport', 'change my area', 'work areas', 'coverage', 'which airports',
              'add an airport', 'my region'],
      reply: 'Work areas page. Search by airport name, city or IATA code and pick as many ' +
        'as you can genuinely serve.\n\n' +
        'This is what decides which rides you see — rides are matched by pick-up airport, ' +
        'not by the cities you wrote when you signed up.'
    },
    {
      id: 'login',
      words: ['cannot log in', "can't sign in", 'password', 'forgot', 'locked out',
              'reset my password', 'login problem', 'email not confirmed'],
      reply: 'Use "Forgot your password" on the sign-in screen and a link arrives by email.\n\n' +
        'If it says your email is not confirmed, open the confirmation link we sent when ' +
        'you registered — check spam if it is not in your inbox.\n\n' +
        'This portal is at drivers.airportlink.app, not the main website. Signing in on the ' +
        'main site will not bring you here.'
    },

    // ---------- básicos ----------
    {
      id: 'greeting',
      words: ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening', 'ola', 'olá'],
      // Curto. Um cumprimento respondido com um parágrafo sobre o
      // que o robô sabe fazer é a forma mais rápida de parecer um
      // robô.
      reply: 'Hello. What do you need?'
    },
    {
      id: 'human',
      words: ['a person', 'a human', 'real person', 'talk to someone', 'speak to someone',
              'agent', 'not a bot', 'operator', 'support team'],
      reply: 'Of course. I have put you in the queue — someone will pick this up.\n\n' +
        'Write what you need in the meantime and they will read it when they arrive.',
      handoff: true
    },
    {
      id: 'thanks',
      words: ['thank', 'thanks', 'obrigado', 'cheers', 'appreciate it', 'perfect', 'great'],
      reply: 'Any time. Anything else?'
    }
  ];

  // ============================================================
  // A ESCOLHA
  // ============================================================

  function normalise(text) {
    return String(text || '')
      .toLowerCase()
      // Acentos fora: "não" e "nao" têm de dar o mesmo resultado.
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Quanto é que um tópico corresponde à mensagem.
   *
   * Uma expressão de várias palavras vale mais do que uma palavra
   * solta: quem escreve "when do i get paid" está claramente a
   * perguntar isso, enquanto "payment" sozinho pode ser qualquer
   * coisa.
   */
  function score(topic, text) {
    var total = 0;

    topic.words.forEach(function (word) {
      var w = normalise(word);
      if (!w) return;

      var words = w.split(' ').length;

      if (words > 1) {
        // Uma expressão inteira vale muito: quem escreve "when do i
        // get paid" está claramente a perguntar isso.
        if (text.indexOf(w) !== -1) total += words * 2;
        return;
      }

      // Palavra solta: só conta como palavra inteira. Sem isto,
      // "expired" apanhava "unexpired" e "hi" apanhava "this".
      if (new RegExp('(^| )' + w + '(s|es|ed|ing)?( |$)').test(text)) {
        total += 2;
      }
    });

    return total * (topic.weight || 1);
  }

  /**
   * Responde, ou admite que não sabe.
   *
   * O mínimo de dois pontos existe para o bot não responder a
   * coincidências. Uma palavra solta a bater num tópico é fraco de
   * mais para arriscar uma resposta errada — e uma resposta errada
   * custa mais do que nenhuma.
   */
  // Quantas seguidas não percebemos. Ver o fundo de answer().
  var misses = 0;

  function answer(message) {
    var text = normalise(message);
    if (!text) return null;

    // Os assuntos que nunca respondemos ganham sempre. Se alguém
    // escreve "não recebi o pagamento de outubro", o tópico do
    // pagamento mensal não pode ganhar.
    for (var i = 0; i < ESCALATE.length; i++) {
      if (score(ESCALATE[i], text) > 0) {
        return {
          id: ESCALATE[i].id,
          reply: ESCALATE[i].reply,
          handoff: true,
          urgent: ESCALATE[i].urgent === true
        };
      }
    }

    var best = null;
    var bestScore = 0;

    TOPICS.forEach(function (topic) {
      var s = score(topic, text);
      if (s > bestScore) { bestScore = s; best = topic; }
    });

    // O mínimo existe para o bot não responder a coincidências. Uma
    // resposta errada custa mais do que nenhuma — mas duas palavras
    // certas já são sinal suficiente.
    if (!best || bestScore < 2) {
      // Não percebemos — mas passar logo para pessoa gasta o tempo
      // de alguém com uma pergunta que provavelmente sabemos
      // responder. Primeiro perguntamos de que se trata.
      //
      // Só à SEGUNDA vez seguida é que passa. Quem escreve duas
      // coisas que não percebemos precisa mesmo de gente.
      misses += 1;

      if (misses >= 2) {
        misses = 0;
        return {
          id: 'unknown_twice',
          reply: 'Still not following, sorry — better a person than more guessing ' +
            'from me.\n\nYou are in the queue. Add anything that helps while you wait.',
          handoff: true
        };
      }

      return {
        id: 'unknown',
        reply: 'I did not catch that one. Which of these is it closest to?\n\n' +
          '· Payments and statements\n' +
          '· Rides — taking, releasing, passengers\n' +
          '· Documents and approval\n' +
          '· Drivers, vehicles or airports\n' +
          '· Signing in\n\n' +
          'Or write "a person" and I put you through straight away.',
        handoff: false
      };
    }

    // Percebeu: o contador de falhas volta a zero.
    misses = 0;

    return {
      id: best.id,
      reply: best.reply,
      handoff: best.handoff === true,
      urgent: false
    };
  }

  /** As perguntas mais comuns, para mostrar como botões. */
  var SUGGESTIONS = [
    { label: 'When am I paid?', topic: 'when_paid' },
    { label: 'No rides showing', topic: 'no_rides' },
    { label: 'Documents', topic: 'documents' },
    { label: 'I cannot do a ride', topic: 'release' },
    { label: 'Talk to a person', topic: 'human' }
  ];

  function byId(id) {
    var found = TOPICS.concat(ESCALATE).find(function (t) { return t.id === id; });
    return found ? { id: found.id, reply: found.reply,
                     handoff: found.handoff === true || ESCALATE.indexOf(found) !== -1 } : null;
  }

  global.AirportlinkHelpBot = {
    answer: answer,
    byId: byId,
    suggestions: SUGGESTIONS,
    topics: TOPICS,
    escalate: ESCALATE
  };
})(window);
