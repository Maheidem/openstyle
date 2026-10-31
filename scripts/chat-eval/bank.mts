// bank.mts: the fictional word banks of the chat eval corpus (spec 8.2). All
// names, companies and projects are invented. A pair is [English, Portuguese].
// `gist` is a paraphrase with no word of the subject: it makes the concept
// queries of the retrieval eval (7.4.6, "concept questions").

export type L = readonly [en: string, pt: string];

export interface Vendor {
  name: string;
  /** How an ASR engine spells it. */
  asr: string;
}
export interface Subject {
  s: L;
  gist?: L;
}
export interface Metric {
  m: L;
  unit: L;
}
export interface Decision {
  topic: L;
  choice: L;
  alt: L;
  gist: L;
}

export interface FolderBank {
  /** Short name used in titles. */
  short: string;
  vendors: Vendor[];
  quote: Subject[];
  date: Subject[];
  metric: Metric[];
  decision: Decision[];
  assign: L[];
  openq: L[];
  approve: L[];
  propose: L[];
  /** What a vendor confirms ("will be ready by <date>"). */
  vendorRole: L[];
  filler: L[];
}

export const GENERIC_OPEN: L[] = [
  ["Okay, let's get started.", "Certo, vamos começar."],
  ["Hi everyone, can you all hear me?", "Oi pessoal, vocês estão me ouvindo?"],
  ["Thanks for joining, this should be a short one.", "Obrigado por entrar, essa deve ser rápida."],
  ["Let me share my screen first.", "Deixa eu compartilhar a tela primeiro."],
  ["We have a full agenda today, so let's move.", "A pauta está cheia hoje, então vamos andando."],
];
export const GENERIC_MID: L[] = [
  ["Can you repeat that, please?", "Pode repetir, por favor?"],
  ["That makes sense to me.", "Isso faz sentido para mim."],
  ["I think we are aligned on that.", "Acho que estamos alinhados nisso."],
  ["Let me check my notes for a second.", "Deixa eu olhar minhas anotações um segundo."],
  ["Sorry, my connection dropped for a moment.", "Desculpa, minha conexão caiu por um momento."],
  ["Let's take that offline after the call.", "Vamos resolver isso fora da reunião."],
  ["Who else wants to add something here?", "Alguém mais quer acrescentar algo aqui?"],
  ["I will send a short summary after this meeting.", "Vou mandar um resumo curto depois da reunião."],
  ["Good point, I had not thought about that.", "Boa observação, eu não tinha pensado nisso."],
  ["Let's keep this part brief.", "Vamos ser breves nessa parte."],
  ["Does anyone have a question on this?", "Alguém tem dúvida sobre isso?"],
  ["Right, moving on to the next topic.", "Certo, passando para o próximo assunto."],
  ["I agree, but we should not rush it.", "Concordo, mas não devemos ter pressa."],
  ["Can someone take notes for this part?", "Alguém pode anotar essa parte?"],
  ["We talked about this last week as well.", "Nós falamos disso semana passada também."],
  ["It depends on what the team can handle.", "Depende do que o time consegue absorver."],
  ["I will look into it and get back to you.", "Vou verificar e te respondo."],
  ["Honestly, that is the hard part.", "Sinceramente, essa é a parte difícil."],
];
export const GENERIC_CLOSE: L[] = [
  ["Okay, that is all from my side.", "Certo, é só isso da minha parte."],
  ["Thanks everyone, talk to you next week.", "Obrigado a todos, falamos semana que vem."],
  ["Let's stop here, we are out of time.", "Vamos parar por aqui, acabou o tempo."],
  ["Good, I will close the meeting now.", "Bom, vou encerrar a reunião agora."],
];

export const FOLDER_BANKS: Record<string, FolderBank> = {
  atlas: {
    short: "Atlas Migration",
    vendors: [
      { name: "Kestrel Hosting", asr: "Kessel Hosting" },
      { name: "Brightwater Networks", asr: "Bright Water Networks" },
      { name: "Orlenwick Systems", asr: "Orlenvic Systems" },
      { name: "Teluride Backup", asr: "Telluride Backup" },
    ],
    quote: [
      { s: ["the storage cluster", "o cluster de armazenamento"] },
      { s: ["the network gateway", "o gateway de rede"] },
      { s: ["the backup appliance", "o appliance de backup"] },
      { s: ["the monitoring licenses", "as licenças de monitoramento"] },
    ],
    date: [
      { s: ["the cutover", "a virada para a nuvem"], gist: ["the day the old servers go dark", "o dia em que os servidores antigos são desligados"] },
      { s: ["the code freeze", "o congelamento de código"], gist: ["when nobody may merge new changes any more", "quando ninguém mais pode integrar mudanças"] },
      { s: ["the rollback test", "o teste de rollback"], gist: ["the rehearsal of going back if the switch fails", "o ensaio de voltar atrás se a troca falhar"] },
      { s: ["the data export", "a exportação de dados"], gist: ["when the customer records leave the old database", "quando os registros de clientes saem do banco antigo"] },
      { s: ["the security review", "a revisão de segurança"], gist: ["the check by the people who hunt for weak spots", "a checagem de quem procura pontos fracos"] },
    ],
    metric: [
      { m: ["p95 latency", "a latência p95"], unit: ["milliseconds", "milissegundos"] },
      { m: ["replication lag", "o atraso de replicação"], unit: ["seconds", "segundos"] },
      { m: ["the error rate", "a taxa de erro"], unit: ["percent", "por cento"] },
    ],
    decision: [
      { topic: ["the first service to move", "o primeiro serviço a migrar"], choice: ["billing", "cobrança"], alt: ["reporting", "relatórios"], gist: ["which part goes to the cloud before the rest", "qual parte vai para a nuvem antes das outras"] },
      { topic: ["the database engine", "o motor do banco de dados"], choice: ["Postgres", "Postgres"], alt: ["MySQL", "MySQL"], gist: ["what technology will store the tables", "qual tecnologia vai guardar as tabelas"] },
      { topic: ["the cutover window", "a janela da virada"], choice: ["Sunday night", "domingo à noite"], alt: ["Saturday morning", "sábado de manhã"], gist: ["the time of the week when users will notice least", "o momento da semana em que os usuários menos percebem"] },
      { topic: ["the rollout style", "o estilo de lançamento"], choice: ["phased", "em fases"], alt: ["big bang", "tudo de uma vez"], gist: ["whether we switch all at once or step by step", "se trocamos tudo de uma vez ou aos poucos"] },
    ],
    assign: [
      ["write the rollback plan", "escrever o plano de rollback"],
      ["tune the replication settings", "ajustar a replicação"],
      ["draft the customer notice", "redigir o aviso aos clientes"],
      ["order the extra network cards", "comprar as placas de rede extras"],
      ["run the load test", "rodar o teste de carga"],
    ],
    openq: [
      ["whether the old reporting tool can still read the new tables", "se a ferramenta antiga de relatórios ainda lê as novas tabelas"],
      ["who pays for the month when both systems run", "quem paga o mês em que os dois sistemas rodam"],
      ["if the legal team must approve where the data lives", "se o jurídico precisa aprovar onde os dados ficam"],
    ],
    approve: [
      ["the cutover checklist", "o checklist da virada"],
      ["the capacity plan", "o plano de capacidade"],
      ["the migration budget", "o orçamento da migração"],
    ],
    propose: [
      ["a pilot with two small customers", "um piloto com dois clientes pequenos"],
      ["a status page for the whole company", "uma página de status para a empresa toda"],
      ["a second backup site in another region", "um segundo site de backup em outra região"],
    ],
    vendorRole: [
      ["the new network links", "os novos links de rede"],
      ["the staging environment", "o ambiente de homologação"],
    ],
    filler: [
      ["The old servers are getting slow, everyone sees it.", "Os servidores antigos estão lentos, todo mundo percebe."],
      ["The support team asked how the move affects tickets.", "O suporte perguntou como a mudança afeta os chamados."],
      ["We should test with a copy of real data.", "Devemos testar com uma cópia de dados reais."],
      ["Documentation for the new setup is still thin.", "A documentação do novo ambiente ainda está fraca."],
      ["Night work is hard on the on-call people.", "Trabalho à noite pesa para quem está de plantão."],
      ["The dashboards need new alert rules.", "Os painéis precisam de novas regras de alerta."],
    ],
  },
  harbor: {
    short: "Harbor Pricing",
    vendors: [
      { name: "Marlin Analytics", asr: "Marlon Analytics" },
      { name: "Quillon Payments", asr: "Quilon Payments" },
      { name: "Fenwick Research", asr: "Fenwich Research" },
      { name: "Sable Consulting", asr: "Saber Consulting" },
    ],
    quote: [
      { s: ["the pricing study", "o estudo de preços"] },
      { s: ["the billing integration", "a integração de cobrança"] },
      { s: ["the customer survey", "a pesquisa com clientes"] },
      { s: ["the invoice templates", "os modelos de fatura"] },
    ],
    date: [
      { s: ["the price announcement", "o anúncio dos preços"], gist: ["the day customers hear what things will cost", "o dia em que os clientes saberão quanto custa"] },
      { s: ["the renewal deadline", "o prazo de renovação"], gist: ["the last day old contracts can continue as they are", "o último dia em que contratos antigos seguem iguais"] },
      { s: ["the sales training", "o treinamento de vendas"], gist: ["when the sellers learn the new offer", "quando os vendedores aprendem a nova oferta"] },
      { s: ["the pilot start", "o início do piloto"], gist: ["when the first small group begins to try it", "quando o primeiro grupo pequeno começa a testar"] },
      { s: ["the board review", "a revisão da diretoria"], gist: ["the meeting where the executives give a yes or no", "a reunião em que os executivos dizem sim ou não"] },
    ],
    metric: [
      { m: ["the churn rate", "a taxa de cancelamento"], unit: ["percent", "por cento"] },
      { m: ["the average deal size", "o tamanho médio dos contratos"], unit: ["thousand dollars", "mil reais"] },
      { m: ["the trial conversion", "a conversão dos testes"], unit: ["percent", "por cento"] },
    ],
    decision: [
      { topic: ["the entry plan", "o plano de entrada"], choice: ["Starter", "Starter"], alt: ["Lite", "Lite"], gist: ["what the cheapest offer will be called", "como a oferta mais barata vai se chamar"] },
      { topic: ["the discount policy", "a política de desconto"], choice: ["annual only", "só no anual"], alt: ["every plan", "todos os planos"], gist: ["who gets a lower price and who does not", "quem paga menos e quem não paga"] },
      { topic: ["the currency display", "a exibição da moeda"], choice: ["local currency", "moeda local"], alt: ["dollars only", "só dólares"], gist: ["in what money the price tag is shown", "em que dinheiro a etiqueta de preço aparece"] },
      { topic: ["the free trial length", "a duração do teste grátis"], choice: ["fourteen days", "quatorze dias"], alt: ["thirty days", "trinta dias"], gist: ["how long a newcomer can try without paying", "por quanto tempo um novato testa sem pagar"] },
    ],
    assign: [
      ["update the price page", "atualizar a página de preços"],
      ["model the discount cases", "modelar os casos de desconto"],
      ["email the top accounts", "mandar e-mail para as contas principais"],
      ["review the contract wording", "revisar o texto dos contratos"],
      ["build the comparison table", "montar a tabela comparativa"],
    ],
    openq: [
      ["whether small teams will accept a yearly contract", "se equipes pequenas aceitam contrato anual"],
      ["how the competitor will react to the new tiers", "como o concorrente vai reagir aos novos níveis"],
      ["if tax changes the price shown in some countries", "se imposto muda o preço exibido em alguns países"],
    ],
    approve: [
      ["the price list", "a lista de preços"],
      ["the discount matrix", "a matriz de descontos"],
      ["the launch email", "o e-mail de lançamento"],
    ],
    propose: [
      ["a loyalty bonus for long customers", "um bônus de fidelidade para clientes antigos"],
      ["a calculator on the website", "uma calculadora no site"],
      ["a two-month price lock", "um congelamento de preço por dois meses"],
    ],
    vendorRole: [
      ["the survey results", "os resultados da pesquisa"],
      ["the payment sandbox", "o ambiente de testes de pagamento"],
    ],
    filler: [
      ["Sales keeps asking for one more plan.", "Vendas pede sempre mais um plano."],
      ["The finance team wants fewer exceptions.", "O financeiro quer menos exceções."],
      ["Customers compare us with two other tools.", "Os clientes nos comparam com outras duas ferramentas."],
      ["The old page has too many columns.", "A página antiga tem colunas demais."],
      ["We should explain the change in simple words.", "Devemos explicar a mudança em palavras simples."],
      ["Support expects a wave of questions.", "O suporte espera uma onda de perguntas."],
    ],
  },
  mobile: {
    short: "Mobile Relaunch",
    vendors: [
      { name: "Zephyr Studios", asr: "Zefir Studios" },
      { name: "Lumen Testing", asr: "Lumin Testing" },
      { name: "Ironbark Labs", asr: "Iron Bark Labs" },
      { name: "Pelican Analytics", asr: "Pelicano Analytics" },
    ],
    quote: [
      { s: ["the icon redesign", "o redesenho do ícone"] },
      { s: ["the beta test service", "o serviço de testes beta"] },
      { s: ["the push notification plan", "o plano de notificações"] },
      { s: ["the app store screenshots", "as capturas para a loja de apps"] },
    ],
    date: [
      { s: ["the store submission", "o envio para a loja"], gist: ["the day we hand the app to the reviewers of the shop", "o dia em que entregamos o app aos revisores da loja"] },
      { s: ["the beta start", "o início do beta"], gist: ["when outside testers get the first build", "quando testadores de fora recebem a primeira versão"] },
      { s: ["the feature freeze", "o congelamento de funcionalidades"], gist: ["after this day we only fix bugs", "depois desse dia só corrigimos erros"] },
      { s: ["the press embargo", "o embargo de imprensa"], gist: ["when journalists may finally write about it", "quando jornalistas podem finalmente escrever sobre isso"] },
      { s: ["the public launch", "o lançamento público"], gist: ["the day everybody can download it", "o dia em que qualquer pessoa pode baixar"] },
    ],
    metric: [
      { m: ["the crash-free rate", "a taxa sem falhas"], unit: ["percent", "por cento"] },
      { m: ["the cold start time", "o tempo de abertura a frio"], unit: ["milliseconds", "milissegundos"] },
      { m: ["the beta signups", "as inscrições no beta"], unit: ["people", "pessoas"] },
    ],
    decision: [
      { topic: ["the first platform", "a primeira plataforma"], choice: ["iPhone", "iPhone"], alt: ["Android", "Android"], gist: ["which phone family gets the new version first", "qual família de celular recebe a versão nova primeiro"] },
      { topic: ["the default theme", "o tema padrão"], choice: ["dark mode", "modo escuro"], alt: ["light mode", "modo claro"], gist: ["how the screen looks when you open it the first time", "como a tela aparece na primeira abertura"] },
      { topic: ["the sign-in method", "o método de login"], choice: ["passkeys", "passkeys"], alt: ["passwords", "senhas"], gist: ["how people prove who they are at the door", "como as pessoas provam quem são na entrada"] },
      { topic: ["the onboarding length", "o tamanho do onboarding"], choice: ["three screens", "três telas"], alt: ["five screens", "cinco telas"], gist: ["how many welcome pages a newcomer sees", "quantas páginas de boas-vindas um novato vê"] },
    ],
    assign: [
      ["fix the login crash", "corrigir a falha no login"],
      ["record the demo video", "gravar o vídeo de demonstração"],
      ["write the release notes", "escrever as notas de versão"],
      ["recruit the beta testers", "recrutar os testadores beta"],
      ["update the privacy text", "atualizar o texto de privacidade"],
    ],
    openq: [
      ["whether older phones can still run the new camera", "se celulares antigos ainda rodam a câmera nova"],
      ["how we get reviews from the first week", "como conseguir avaliações na primeira semana"],
      ["if the widget fits into the first release", "se o widget cabe na primeira versão"],
    ],
    approve: [
      ["the onboarding flow", "o fluxo de onboarding"],
      ["the store description", "a descrição na loja"],
      ["the release candidate", "a versão candidata"],
    ],
    propose: [
      ["a referral reward for early users", "uma recompensa por indicação para os primeiros usuários"],
      ["a quiet launch in one country", "um lançamento discreto em um país"],
      ["weekly builds for the testers", "versões semanais para os testadores"],
    ],
    vendorRole: [
      ["the first test devices", "os primeiros aparelhos de teste"],
      ["the final artwork", "a arte final"],
    ],
    filler: [
      ["The new design feels much lighter.", "O novo design parece muito mais leve."],
      ["Users complained about the old menu.", "Usuários reclamaram do menu antigo."],
      ["We need more photos for the store page.", "Precisamos de mais fotos para a página da loja."],
      ["Battery use looks better on the new build.", "O uso de bateria está melhor na versão nova."],
      ["The animation is nice but a bit slow.", "A animação é bonita mas um pouco lenta."],
      ["Accessibility labels are still missing on two screens.", "Faltam rótulos de acessibilidade em duas telas."],
    ],
  },
  audit: {
    short: "Vendor Audit",
    vendors: [
      { name: "Quillon & Pratt", asr: "Quilon and Pratt" },
      { name: "Harrow Compliance", asr: "Harro Compliance" },
      { name: "Nimbus Escrow", asr: "Nimbos Escrow" },
      { name: "Vantage Certify", asr: "Vantagem Certify" },
    ],
    quote: [
      { s: ["the audit tool licenses", "as licenças da ferramenta de auditoria"] },
      { s: ["the evidence archive", "o arquivo de evidências"] },
      { s: ["the staff training", "o treinamento da equipe"] },
      { s: ["the risk scoring service", "o serviço de pontuação de risco"] },
    ],
    date: [
      { s: ["the evidence deadline", "o prazo das evidências"], gist: ["the day all the proof papers must be handed in", "o dia em que todos os comprovantes devem ser entregues"] },
      { s: ["the on-site visit", "a visita presencial"], gist: ["when the inspectors come to the office", "quando os inspetores vêm ao escritório"] },
      { s: ["the remediation deadline", "o prazo de correção"], gist: ["the last day to fix the problems that were found", "o último dia para consertar os problemas encontrados"] },
      { s: ["the final report", "o relatório final"], gist: ["when the written verdict is due", "quando o parecer escrito é entregue"] },
      { s: ["the contract renewal", "a renovação do contrato"], gist: ["when the agreement with the supplier starts over", "quando o acordo com o fornecedor recomeça"] },
    ],
    metric: [
      { m: ["the open findings", "as pendências abertas"], unit: ["items", "itens"] },
      { m: ["the evidence requests", "os pedidos de evidência"], unit: ["requests", "pedidos"] },
      { m: ["the supplier score", "a nota do fornecedor"], unit: ["points", "pontos"] },
    ],
    decision: [
      { topic: ["the audit scope", "o escopo da auditoria"], choice: ["payments only", "só pagamentos"], alt: ["all systems", "todos os sistemas"], gist: ["how wide the inspectors may look", "quão longe os inspetores podem olhar"] },
      { topic: ["the lead auditor", "o auditor líder"], choice: ["external", "externo"], alt: ["internal", "interno"], gist: ["whether an outsider or one of us runs the checks", "se um estranho ou um de nós conduz as checagens"] },
      { topic: ["the evidence format", "o formato das evidências"], choice: ["PDF exports", "exportações em PDF"], alt: ["screenshots", "capturas de tela"], gist: ["in what shape we hand over the proof", "em que forma entregamos os comprovantes"] },
      { topic: ["the sample size", "o tamanho da amostra"], choice: ["ten percent", "dez por cento"], alt: ["twenty percent", "vinte por cento"], gist: ["what share of the cases gets checked", "que fatia dos casos é verificada"] },
    ],
    assign: [
      ["collect the access logs", "reunir os logs de acesso"],
      ["close the old findings", "fechar as pendências antigas"],
      ["brief the new supplier", "orientar o novo fornecedor"],
      ["prepare the interview list", "preparar a lista de entrevistas"],
      ["update the risk register", "atualizar o registro de riscos"],
    ],
    openq: [
      ["whether the backup supplier also needs an audit", "se o fornecedor de backup também precisa de auditoria"],
      ["who signs the final statement", "quem assina a declaração final"],
      ["if old tickets count as valid proof", "se chamados antigos valem como comprovante"],
    ],
    approve: [
      ["the audit plan", "o plano de auditoria"],
      ["the evidence index", "o índice de evidências"],
      ["the findings summary", "o resumo das pendências"],
    ],
    propose: [
      ["a shared folder for all proof papers", "uma pasta compartilhada para todos os comprovantes"],
      ["a monthly check instead of a yearly one", "uma checagem mensal em vez de anual"],
      ["a score card for each supplier", "um boletim para cada fornecedor"],
    ],
    vendorRole: [
      ["the interview schedule", "o cronograma de entrevistas"],
      ["the draft statement", "o rascunho da declaração"],
    ],
    filler: [
      ["Some papers are in the old shared drive.", "Alguns documentos estão no drive antigo."],
      ["The auditors are strict but fair.", "Os auditores são rígidos mas justos."],
      ["Two suppliers did not answer our mail yet.", "Dois fornecedores ainda não responderam ao e-mail."],
      ["We should name one owner per finding.", "Devemos nomear um responsável por pendência."],
      ["The checklist from last year is a good start.", "O checklist do ano passado é um bom começo."],
      ["Legal wants to read the final text first.", "O jurídico quer ler o texto final primeiro."],
    ],
  },
  ops: {
    short: "Team sync",
    vendors: [
      { name: "Cobalt Catering", asr: "Cobalto Catering" },
      { name: "Larkspur Travel", asr: "Larkspar Travel" },
    ],
    quote: [
      { s: ["the offsite venue", "o local do encontro da equipe"] },
      { s: ["the new standing desks", "as novas mesas reguláveis"] },
      { s: ["the team lunch", "o almoço da equipe"] },
      { s: ["the conference tickets", "os ingressos da conferência"] },
    ],
    date: [
      { s: ["the offsite", "o encontro da equipe"], gist: ["the trip where the whole group meets away from the office", "a viagem em que o grupo todo se reúne fora do escritório"] },
      { s: ["the hiring decision", "a decisão de contratação"], gist: ["when we tell the candidate yes or no", "quando damos ao candidato um sim ou um não"] },
      { s: ["the performance reviews", "as avaliações de desempenho"], gist: ["the round of yearly feedback talks", "a rodada anual de conversas de feedback"] },
      { s: ["the office move", "a mudança de escritório"], gist: ["the day we carry the boxes to the new floor", "o dia em que levamos as caixas para o novo andar"] },
    ],
    metric: [
      { m: ["the open positions", "as vagas abertas"], unit: ["roles", "vagas"] },
      { m: ["the team satisfaction score", "a nota de satisfação da equipe"], unit: ["points", "pontos"] },
      { m: ["the monthly travel spend", "o gasto mensal com viagens"], unit: ["hundred dollars", "centenas de reais"] },
    ],
    decision: [
      { topic: ["the meeting day", "o dia da reunião"], choice: ["Thursday", "quinta-feira"], alt: ["Monday", "segunda-feira"], gist: ["which weekday the group gathers", "em que dia da semana o grupo se reúne"] },
      { topic: ["the remote policy", "a política de trabalho remoto"], choice: ["two days at home", "dois dias em casa"], alt: ["fully remote", "totalmente remoto"], gist: ["how often people may stay away from the office", "com que frequência as pessoas podem ficar fora do escritório"] },
      { topic: ["the budget owner", "o responsável pelo orçamento"], choice: ["finance", "financeiro"], alt: ["the team lead", "a liderança"], gist: ["who watches the spending", "quem vigia os gastos"] },
      { topic: ["the onboarding buddy", "o padrinho de integração"], choice: ["one per hire", "um por contratado"], alt: ["a shared pool", "um grupo comum"], gist: ["how newcomers get a friendly guide", "como novatos ganham um guia amigável"] },
    ],
    assign: [
      ["book the offsite rooms", "reservar as salas do encontro"],
      ["send the survey link", "enviar o link da pesquisa"],
      ["clean up the shared calendar", "organizar o calendário compartilhado"],
      ["order the welcome kits", "pedir os kits de boas-vindas"],
      ["plan the farewell party", "planejar a festa de despedida"],
    ],
    openq: [
      ["whether the new office has enough meeting rooms", "se o novo escritório tem salas de reunião suficientes"],
      ["who covers the holiday support shift", "quem cobre o plantão de feriado"],
      ["if the offsite fits the yearly budget", "se o encontro cabe no orçamento anual"],
    ],
    approve: [
      ["the travel policy", "a política de viagens"],
      ["the job post", "o anúncio da vaga"],
      ["the offsite agenda", "a agenda do encontro"],
    ],
    propose: [
      ["a no-meeting afternoon each week", "uma tarde sem reuniões por semana"],
      ["a mentoring program for new hires", "um programa de mentoria para novos contratados"],
      ["a shared reading hour on Fridays", "uma hora de leitura coletiva às sextas"],
    ],
    vendorRole: [
      ["the group booking", "a reserva do grupo"],
      ["the menu options", "as opções de cardápio"],
    ],
    filler: [
      ["People like the idea but worry about the cost.", "As pessoas gostam da ideia mas se preocupam com o custo."],
      ["The calendar is full until the end of the month.", "A agenda está cheia até o fim do mês."],
      ["Last year went better than expected.", "No ano passado foi melhor que o esperado."],
      ["Some of us can not travel in that week.", "Alguns de nós não podem viajar naquela semana."],
      ["We should ask the quiet people too.", "Devemos perguntar também aos mais quietos."],
      ["The new tool will save us some time.", "A ferramenta nova vai nos poupar algum tempo."],
    ],
  },
};
