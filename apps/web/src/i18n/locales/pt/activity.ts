import type { TranslationSchema } from "../../types";

export const activity = {
  "capabilityInspector": {
    "eyebrow": "Governança e segurança",
    "title": "Inspetor de recursos",
    "backAria": "Voltar às configurações",
    "modelProfiles": {
      "title": "Perfis de modelo: alternativa conservadora.",
      "emptyHint": "Nenhuma opção code.model_profile.<id> está ativada neste contexto; por isso, todas as execuções usam o perfil conservador (uma chamada de ferramenta por vez e detecção automática de chamadas), mesmo quando o modelo corresponde a um dos {{count}} perfis do registro. Ative as opções dos perfis permitidos nesta implantação para iniciar a adoção."
    },
    "heroCopy": "Explore e audite os 306 recursos canônicos do NPATI Agent. Verifique os limites do resolvedor efetivo de recursos, a visibilidade das ferramentas e as políticas de risco no ambiente real de execução.",
    "stats": {
      "totalLabel": "recursos no total",
      "totalDesc": "IDs canônicos de 1 a 306 verificados",
      "agentCallableLabel": "acionáveis por agentes",
      "agentCallableDesc": "Expostos aos modelos pelo resolvedor",
      "runtimeOnlyLabel": "execução interna",
      "runtimeOnlyDesc": "Operações isoladas do mecanismo",
      "requiresApprovalLabel": "exigem aprovação",
      "requiresApprovalDesc": "Verificação de segurança com participação humana"
    },
    "slices": {
      "all": "Todos",
      "agentCallable": "Acionável por agente",
      "runtimeOnly": "Somente execução interna",
      "userVisible": "Visível ao usuário",
      "automatic": "Automático",
      "allowed": "Permitido",
      "requiresApproval": "Exige aprovação"
    },
    "controls": {
      "searchPlaceholder": "Filtrar recursos por nome, ID ou domínio...",
      "searchAriaLabel": "Filtrar recursos",
      "clearSearch": "Limpar pesquisa",
      "showing": "Mostrando {{start}}–{{end}} de {{total}} recursos",
      "matching": "correspondentes a \"{{term}}\"",
      "copied": "✓ {{id}} copiado",
      "perPage": "Por página:",
      "allCount": "Todos ({{total}})"
    },
    "table": {
      "colId": "ID",
      "sortId": "Ordenar por ID",
      "colName": "Nome",
      "sortName": "Ordenar por nome",
      "colCanonicalId": "ID canônico",
      "sortCanonicalId": "Ordenar por ID canônico",
      "colDomain": "Domínio",
      "sortDomain": "Ordenar por domínio",
      "colType": "Tipo",
      "sortType": "Ordenar por tipo",
      "colCallable": "Acionável",
      "colRisk": "Risco",
      "sortRisk": "Ordenar por risco",
      "colStatus": "Status",
      "sortStatus": "Ordenar por status",
      "copyTooltip": "Clique para copiar o ID canônico",
      "empty": "Nenhum recurso corresponde ao filtro selecionado.",
      "prev": "← Anterior",
      "next": "Próximo →"
    },
    "callable": {
      "callable": "Acionável",
      "internal": "Interno"
    },
    "risks": {
      "low": "Baixa",
      "medium": "Média",
      "high": "Alta",
      "critical": "Crítica"
    },
    "statuses": {
      "verified": "Verificado",
      "partial": "Parcial",
      "notImplemented": "Não implementado",
      "blocked": "Bloqueado",
      "allowed": "Permitido",
      "denied": "Negado",
      "unavailable": "Indisponível",
      "requiresApproval": "Aprovação necessária"
    },
    "types": {
      "runtime": "Ambiente de execução",
      "config": "Configuração",
      "orchestr": "Orquestração",
      "tool": "Ferramenta",
      "article": "Artigo",
      "secOps": "Operações de segurança"
    },
    "connectedServices": "Serviços conectados",
    "errorLoad": "Falha ao carregar os recursos",
    "integrations": {
      "kicker": "Integrações verificadas do produto",
      "title": "Canais de mensagens implementados",
      "manage": "Gerenciar integrações",
      "sharedRuntime": "Ambiente compartilhado do NPATI Agent",
      "loading": "Carregando status das integrações...",
      "notice": "O status das integrações está disponível quando a API do agente está conectada."
    }
  },
  "activity": {
    "eyebrow": "Observabilidade e auditoria",
    "title": "Atividade e rastreamento de execuções",
    "backAria": "Voltar às configurações",
    "heroCopy": "Rastreamento detalhado em tempo real, etapas de delegação, chamadas de ferramentas, latências e decisões de segurança das execuções dos agentes da empresa.",
    "stats": {
      "totalRuns": "Total de execuções",
      "totalRunsDesc": "Execuções de agentes registradas",
      "completed": "Concluído",
      "completedDesc": "Bem-sucedidas e sem falhas",
      "inProgress": "Em andamento / Na fila",
      "inProgressDesc": "Cargas de trabalho de agentes ativos",
      "securityDecisions": "Decisões de segurança",
      "securityDecisionsDesc": "Verificações de ferramentas auditadas"
    },
    "controls": {
      "companyLabel": "Empresa:",
      "all": "Todos",
      "completed": "Concluído",
      "running": "Em execução",
      "failed": "Falhou",
      "searchPlaceholder": "Pesquisar execuções por tarefa ou ID...",
      "searchAriaLabel": "Pesquisar execuções",
      "clearSearch": "Limpar pesquisa",
      "refresh": "Atualizar",
      "refreshing": "Atualizando...",
      "refreshTitle": "Atualizar execuções"
    },
    "dispatch": {
      "title": "Enviar tarefa aos agentes da empresa",
      "subtitle": "Inicie uma tarefa autônoma com vários agentes e inspecione os rastreamentos em tempo real",
      "modeLabel": "Modo de execução:",
      "modes": {
        "auto": "Orquestração automática (adaptativa)",
        "pipeline": "Fluxo sequencial (vários agentes)",
        "single": "Agente único (rápido)",
        "fusion": "Fusão (vários modelos)"
      },
      "placeholderWithCompany": "Digite uma tarefa para os agentes de {{name}} (ex.: 'Analisar ofertas e preços dos concorrentes')...",
      "placeholderDefault": "Digite as instruções da tarefa para os agentes da empresa...",
      "dispatchTask": "Enviar tarefa",
      "dispatching": "Enviando tarefa...",
      "presetsLabel": "Predefinições:",
      "presets": {
        "marketAuditLabel": "Auditoria de mercado e concorrentes",
        "marketAuditPrompt": "Realizar uma pesquisa abrangente de concorrentes e analisar o posicionamento de mercado",
        "securityAuditLabel": "Verificação de segurança e recursos",
        "securityAuditPrompt": "Auditar permissões de ferramentas da empresa, regras de acesso à API e verificações de segurança",
        "growthRoadmapLabel": "Plano estratégico de crescimento",
        "growthRoadmapPrompt": "Sintetizar o perfil de cliente ideal e um plano de crescimento prático de 90 dias"
      },
      "dispatchedNotice": "Execução enviada: {{id}} ({{status}})",
      "dispatchFailed": "Falha ao enviar a execução do agente"
    },
    "empty": {
      "noCompaniesTitle": "Nenhuma empresa encontrada",
      "noCompaniesCopy": "A atividade e o rastreamento acompanham as execuções com vários agentes iniciadas no contexto de uma empresa de IA.",
      "createCompanyBtn": "Criar empresa de IA",
      "noRunsTitle": "Nenhuma execução registrada ainda",
      "presetsTitle": "Tarefas predefinidas e cenários iniciais",
      "noRunsCopy": "Esta empresa não tem execuções de agentes iniciadas. Use o envio de tarefas acima ou selecione uma predefinição para gerar rastreamentos em tempo real, etapas de delegação e auditorias de segurança de ferramentas.",
      "presetsCopy": "Selecione uma predefinição abaixo ou digite uma tarefa personalizada acima para gerar rastreamentos em tempo real, etapas de delegação e auditorias de segurança de ferramentas.",
      "dispatchPresetBtn": "Enviar: {{label}} →",
      "viewTraceBtn": "Ver histórico e rastreamento de execuções ({{count}}) →"
    },
    "sidebar": {
      "recentExecutions": "Execuções recentes ({{count}})",
      "backToPresets": "← 3 predefinições",
      "noFilteredRuns": "Nenhuma execução corresponde aos filtros atuais.",
      "clearFiltersBtn": "Limpar filtros"
    },
    "trace": {
      "backToPresetsAria": "Voltar às predefinições",
      "modePrefix": "Modo: {{mode}}",
      "comboPrefix": "Combinação: {{name}}",
      "runIdLabel": "ID da execução:",
      "copy": "Copiar",
      "copied": "Copiado",
      "copyRunIdTitle": "Copiar ID da execução",
      "startedLabel": "Iniciado:",
      "completedLabel": "Concluído:",
      "durationLabel": "Duração:",
      "finalOutput": "Resultado final",
      "copyResultTitle": "Copiar resultado",
      "executionFault": "Falha de execução",
      "completionReportTitle": "Relatório de conclusão em segundo plano",
      "attemptSummary": "Tentativa {{attempt}} · {{tokens}} tokens · ${{cost}} · {{duration}}s",
      "timelineTitle": "Linha do tempo de execução em segundo plano ({{count}})",
      "timelineDesc": "Reservas persistentes de tarefas, novas tentativas e eventos de conclusão dos processos de trabalho",
      "attemptLabel": "Tentativa {{attempt}}",
      "synchronousNotice": "Esta execução ocorreu de forma síncrona; nenhum evento de processo em segundo plano foi emitido.",
      "delegationTitle": "Fluxo de delegação de agentes ({{count}})",
      "delegationDesc": "Coordenação de funções e transferências entre vários agentes",
      "agentPrefix": "Agente: {{id}}",
      "modelPrefix": "Modelo:",
      "lanePrefix": "Via: {{lane}}",
      "noStepsNotice": "Nenhuma etapa de delegação registrada para esta tarefa de um único turno.",
      "toolsTitle": "Execuções de ferramentas e verificações de segurança ({{count}})",
      "toolsDesc": "Verificações do resolvedor de recursos canônicos e auditorias de segurança",
      "policyReason": "Motivo da política:",
      "noToolsNotice": "Nenhuma chamada de ferramenta externa foi acionada nesta execução.",
      "selectRunTitle": "Selecione uma execução para inspecionar",
      "selectRunCopy": "Escolha uma execução no painel esquerdo para revisar sua linha do tempo, etapas de delegação e auditorias de segurança."
    },
    "errors": {
      "loadRunsFailed": "Falha ao carregar a atividade",
      "loadRunDetailsFailed": "Falha ao carregar os detalhes da execução"
    }
  },
  "automations": {
    "eyebrow": "Configurações · Automações",
    "title": "Automações e tarefas agendadas",
    "backAria": "Voltar às configurações",
    "heroCopy": "Configure acionadores periódicos em segundo plano, tarefas cron recorrentes e tarefas autônomas de agentes para sua empresa.",
    "selectCompanyAria": "Selecionar empresa",
    "newAutomationBtn": "+ Nova automação",
    "stats": {
      "total": "automações no total",
      "totalDesc": "Tarefas de IA agendadas em segundo plano",
      "active": "acionadores ativos",
      "activeDesc": "Agendamentos cron em execução",
      "paused": "agendamentos pausados",
      "pausedDesc": "Acionadores em espera / inativos",
      "assignedAgents": "agentes atribuídos",
      "assignedAgentsDesc": "Executores de agentes configurados"
    },
    "controls": {
      "searchPlaceholder": "Filtrar automações por nome, descrição, instrução, cron...",
      "searchAriaLabel": "Filtrar automações",
      "clearSearch": "Limpar pesquisa",
      "tabAll": "Todos",
      "tabActive": "Ativo",
      "tabPaused": "Pausado"
    },
    "showingStatus": "Mostrando {{count}} de {{total}} automações",
    "matchingQuery": "correspondentes a \"{{query}}\"",
    "empty": {
      "noAutomationsTitle": "Nenhuma automação configurada",
      "noAutomationsDesc": "Agende tarefas cron autônomas em segundo plano, auditorias periódicas de mercado ou fluxos diários de agentes para esta empresa.",
      "createFirstBtn": "+ Criar primeira automação",
      "noMatchingTitle": "Nenhuma automação correspondente",
      "noMatchingDesc": "Ajuste a pesquisa ou o filtro de status para encontrar o que procura.",
      "clearFiltersBtn": "Limpar filtros"
    },
    "table": {
      "colStatus": "Status",
      "colTask": "Tarefa e instruções",
      "colSchedule": "Agendamento (cron)",
      "colAssignedAgent": "Agente atribuído",
      "colActions": "Ações",
      "statusActive": "ATIVO",
      "statusPaused": "PAUSADO",
      "clickToPause": "Clique para pausar",
      "clickToActivate": "Clique para ativar",
      "promptPrefix": "Instrução:",
      "nextRunPrefix": "Próxima:",
      "mainAgent": "Agente principal",
      "runNow": "▶ Executar agora",
      "running": "Executando...",
      "runNowTitle": "Executar esta automação imediatamente",
      stop: "Parar",
      stopTitle: "Parar a execução em andamento",
      "history": "Histórico",
      "historyTitle": "Ver histórico de execuções",
      "edit": "Editar",
      "editTitle": "Editar configurações da automação",
      "delete": "Excluir",
      "deleteTitle": "Excluir automação"
    },
    "presets": {
      "daily9": "Diariamente às 09:00",
      "daily18": "Diariamente às 18:00",
      "mondays9": "Segundas-feiras às 09:00",
      "fridays17": "Sextas-feiras às 17:00",
      "hourly": "A cada hora",
      "daily0": "Diariamente às 00:00"
    },
    "editor": {
      "kicker": "Automações",
      "editTitle": "Editar automação",
      "newTitle": "Nova automação",
      "taskParamsHeading": "Parâmetros da tarefa",
      "taskNameLabel": "Nome da tarefa",
      "taskNamePlaceholder": "Ex.: análise diária de concorrentes",
      "descLabel": "Descrição",
      "descPlaceholder": "O que esta automação realiza",
      "assignedAgentLabel": "Agente atribuído",
      "mainAgentDefault": "Agente principal (padrão)",
      "schedulePresetsLabel": "Agendamentos predefinidos",
      "cronExpressionLabel": "Expressão cron (5 campos: minuto hora dia mês dia da semana)",
      "cronPlaceholder": "0 9 * * *",
      "agentPromptLabel": "Instrução do agente",
      "agentPromptPlaceholder": "Descreva o objetivo exato e as etapas que o agente deve executar...",
      "saveBtn": "Salvar automação",
      "savingBtn": "Salvando...",
      "deleteBtn": "Excluir",
      "cancelBtn": "Cancelar"
    },
    "history": {
      "kicker": "Histórico de execuções",
      "loading": "Carregando histórico de execuções...",
      "noRuns": "Nenhuma execução registrada ainda.",
      "duration": "Duração:",
      "finalResult": "✓ Resultado final:",
      "error": "Erro:"
    },
    "dialogs": {
      "deleteTitle": "Excluir automação?",
      "deleteMessage": "Tem certeza de que deseja excluir esta automação?",
      "deleteConfirm": "Excluir",
      "deleteCancel": "Cancelar"
    },
    "notifications": {
      "runInitiated": "Execução iniciada para \"{{name}}\".",
      stopped: "A execução de «{{name}}» foi parada.",
      "resultReceived": "Resultado recebido!",
      "runError": "Erro de execução: {{error}}"
    }
  }
} satisfies Pick<TranslationSchema, "capabilityInspector" | "activity" | "automations">;
