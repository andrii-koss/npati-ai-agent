import type { TranslationSchema } from "../../types";

export const workspace = {
  "goalsPage": {
    "eyebrow": "Configurações · Metas",
    "backToSettings": "Voltar às configurações",
    "title": "Metas e objetivos",
    "heroCopy": "Defina resultados mensuráveis, metas de indicadores e marcos prioritários para alinhar os agentes autônomos de IA.",
    "newGoal": "+ Nova meta",
    "stats": {
      "totalGoals": "metas no total",
      "totalGoalsDesc": "Objetivos do negócio definidos",
      "activeOutcomes": "resultados em andamento",
      "activeOutcomesDesc": "Prioridades de agentes em andamento",
      "completedGoals": "metas concluídas",
      "completedGoalsDesc": "Marcos alcançados",
      "highPriority": "alta prioridade",
      "highPriorityDesc": "Objetivos críticos P1"
    },
    "searchPlaceholder": "Filtrar metas por título, descrição ou unidade de medida...",
    "searchAria": "Filtrar metas",
    "clearSearch": "Limpar pesquisa",
    "tabs": {
      "all": "Todos",
      "active": "Ativo",
      "paused": "Pausado",
      "completed": "Concluído"
    },
    "filterByPriority": "Filtrar por prioridade",
    "priorities": {
      "all": "Todas as prioridades",
      "high": "Alta prioridade (P1)",
      "normal": "Prioridade normal (P2)",
      "low": "Baixa prioridade (P3)"
    },
    "priorityBadges": {
      "high": "Alta P1",
      "normal": "Normal P2",
      "low": "Baixa P3"
    },
    "showingGoals": "Mostrando {count} de {total} metas",
    assignedAgent: "Agente responsável",
    "matchingQuery": " correspondentes a \"{query}\"",
    "table": {
      "status": "Status",
      "goalAndOutcome": "Meta e resultado",
      "progress": "Progresso",
      "priority": "Prioridade",
      "dueDate": "Prazo",
      "actions": "Ações"
    },
    "statusTooltips": {
      "pause": "Clique para pausar",
      "resume": "Clique para retomar",
      "reactivate": "Clique para reativar"
    },
    "statuses": {
      "active": "ATIVO",
      "paused": "PAUSADO",
      "completed": "CONCLUÍDO",
      "cancelled": "CANCELADO"
    },
    "editGoalTooltip": "Clique para editar a meta",
    "qualitativeGoal": "Meta qualitativa",
    "overdue": "Atrasada",
    "actions": {
      "done": "✓ Concluída",
      "markCompleted": "Marcar meta como concluída",
      "reopen": "Reabrir",
      "reopenTitle": "Reabrir meta",
      "edit": "Editar",
      "editTitle": "Editar parâmetros da meta",
      "delete": "Excluir",
      "deleteTitle": "Excluir meta"
    },
    "empty": {
      "noGoalsTitle": "Nenhuma meta configurada ainda",
      "noGoalsDesc": "Defina resultados concretos de negócios, metas de indicadores ou marcos estratégicos para os agentes NPATI priorizarem na execução autônoma e nas recomendações da conversa.",
      "createFirstGoal": "+ Criar primeira meta",
      "noMatchingTitle": "Nenhuma meta correspondente",
      "noMatchingDesc": "Ajuste os termos da pesquisa ou os filtros para encontrar o que procura.",
      "clearFilters": "Limpar filtros"
    },
    "drawer": {
      "kicker": "Metas",
      "editGoal": "Editar meta",
      "newGoal": "Nova meta",
      "close": "Fechar",
      "objectiveSection": "Objetivo da meta",
      "titleLabel": "Título da meta *",
      "titlePlaceholder": "Ex.: conquistar os primeiros 100 clientes pagantes",
      "descLabel": "Descrição / Critérios de sucesso",
      "descPlaceholder": "Como é o sucesso? Quais resultados específicos os agentes buscam?",
      "priorityStatusSection": "Prioridade e status",
      "priorityLabel": "Prioridade",
      "statusLabel": "Status",
      "metricSection": "Acompanhamento de indicadores (opcional)",
      "metricHint": "Informe valores numéricos se esta meta puder ser medida e acompanhada quantitativamente.",
      "targetValueLabel": "Valor-alvo",
      "targetValuePlaceholder": "Ex.: 100",
      "currentValueLabel": "Valor atual",
      "currentValuePlaceholder": "Ex.: 42",
      "unitLabel": "Unidade",
      "unitPlaceholder": "Ex.: $, usuários, %",
      "dueDateSection": "Data prevista de conclusão",
      "deadlineLabel": "Prazo do marco",
      "cancel": "Cancelar",
      "saving": "Salvando...",
      "saveChanges": "Salvar alterações da meta",
      "createGoal": "Criar meta"
    },
    "notices": {
      "failedToLoad": "Falha ao carregar metas: {message}",
      "titleRequired": "O título da meta é obrigatório",
      "updatedSuccess": "Meta \"{title}\" atualizada com sucesso.",
      "createdSuccess": "Meta \"{title}\" criada com sucesso.",
      "failedToSave": "Falha ao salvar meta: {message}",
      "deletedSuccess": "Meta \"{title}\" excluída.",
      "failedToDelete": "Falha ao excluir meta: {message}",
      "statusUpdated": "Status da meta \"{title}\" atualizado para {status}.",
      "statusUpdateError": "Erro ao atualizar status: {message}"
    },
    "dialogs": {
      "deleteTitle": "Excluir meta?",
      "deleteMessage": "Tem certeza de que deseja excluir a meta \"{title}\"?",
      "deleteConfirm": "Excluir",
      "deleteCancel": "Cancelar"
    }
  },
  "contentPage": {
    "eyebrow": "Configurações · Central de conteúdo",
    "backToSettings": "Voltar às configurações",
    "title": "Central de conteúdo e biblioteca de produção",
    "heroCopy": "Revise, edite, formate e exporte artigos, planos de SEO e rascunhos para redes sociais gerados por agentes autônomos.",
    "newContentDraft": "+ Novo rascunho de conteúdo",
    "newContentPrompt": "Elabore um artigo de marketing de alto impacto e um plano de distribuição nas redes sociais para nosso público-alvo.",
    "tabs": {
      "all": "Todos os itens",
      "articles": "Artigos",
      "seoBlueprints": "Planos de SEO",
      "socialPosts": "Publicações em redes sociais",
      "briefsPlans": "Resumos e planos"
    },
    "searchPlaceholder": "Pesquisar rascunhos, palavras-chave, temas...",
    "searchAria": "Pesquisar biblioteca de conteúdo",
    "clearSearch": "Limpar pesquisa",
    "types": {
      "article": "Artigo",
      "seoBlueprint": "Plano de SEO",
      "socialMedia": "Redes sociais",
      "briefPlan": "Resumo e plano"
    },
    "empty": {
      "readyTitle": "Sua biblioteca de conteúdo de IA está pronta",
      "readyDesc": "Quando os agentes autônomos da empresa executarem tarefas de planejamento de conteúdo, pesquisa de palavras-chave ou criação de artigos, todos os rascunhos gerados serão organizados aqui.",
      "generateFirstDraft": "+ Gerar primeiro rascunho na conversa",
      "chatPrompt": "Elabore um artigo de blog otimizado para SEO e direcionado ao nosso cliente ideal, com conclusões principais e perguntas frequentes.",
      "restoreDeleted": "Restaurar documentos excluídos",
      "noMatchingTitle": "Nenhum documento correspondente",
      "noMatchingDesc": "Ajuste os termos da pesquisa ou selecione outro filtro de tipo de conteúdo.",
      "resetFilters": "Redefinir filtros",
      "selectDoc": "Selecione um documento à esquerda para ler ou exportar."
    },
    "cards": {
      "listAria": "Lista de documentos gerados",
      "deleteDocumentTitle": "Excluir documento",
      "minRead": "~{count} min de leitura"
    },
    "viewer": {
      "expand": "Expandir",
      "collapse": "Recolher",
      "expandTitle": "Expandir para ler o documento completo",
      "collapseTitle": "Recolher para a visualização padrão",
      "editDocument": "Editar documento",
      "views": {
        "preview": "Prévia",
        "previewTitle": "Visualização de leitura formatada",
        "raw": ".md bruto",
        "rawTitle": "Código-fonte Markdown bruto"
      },
      "actions": {
        "edit": "✎ Editar",
        "editTitle": "Editar texto, título e categoria do documento",
        "delete": "🗑 Excluir",
        "deleteTitle": "Excluir este documento",
        "copy": "Copiar",
        "copied": "✓ Copiado!",
        "copyTitle": "Copiar conteúdo Markdown para a área de transferência",
        "download": "Baixar .md",
        "downloadTitle": "Baixar como arquivo Markdown",
        "saveChanges": "✓ Salvar alterações",
        "saveChangesTitle": "Salvar suas alterações",
        "cancel": "Cancelar",
        "cancelTitle": "Cancelar edição"
      },
      "metrics": {
        "words": "palavras",
        "characters": "caracteres",
        "readTime": "tempo de leitura",
        "generatedDate": "data de geração"
      },
      "editor": {
        "titleLabel": "Título do documento",
        "titlePlaceholder": "Digite o título do documento...",
        "typeLabel": "Tipo de conteúdo",
        "bodyLabel": "Texto do documento (Markdown)",
        "saveHint": "Pressione Ctrl+S para salvar",
        "bodyPlaceholder": "Escreva ou edite o texto do documento Markdown aqui..."
      },
      "overlay": {
        "expand": "Expandir para ler o documento completo",
        "collapse": "Recolher para a visualização padrão"
      }
    },
    "toast": {
      "saved": "Alterações salvas com sucesso!",
      "saveError": "Não foi possível salvar as alterações",
      "deleted": "Documento excluído",
      "deleteError": "Não foi possível excluir o documento"
    },
    "dialogs": {
      "deleteTitle": "Excluir conteúdo?",
      "deleteMessage": "Tem certeza de que deseja excluir \"{title}\"?",
      "deleteConfirm": "Excluir",
      "deleteCancel": "Cancelar",
      "thisDocumentFallback": "este documento"
    }
  },
  "connectionsPage": {
    "eyebrow": "Infraestrutura e integrações",
    "backToSettings": "Voltar às configurações",
    "title": "Serviços conectados",
    "heroCopy": "Monitore a integridade do ambiente de execução, endpoints e status de todos os mecanismos de armazenamento, adaptadores internos de IA e microsserviços do sistema.",
    "refreshStatus": "Atualizar status",
    "checkingStatus": "Verificando status...",
    "refreshTitle": "Consultar endpoints de integridade dos serviços",
    "lastSuccessfulCheck": "Última verificação bem-sucedida: {{time}}",
    "noSuccessfulCheck": "Ainda não houve verificação bem-sucedida",
    "checkFailed": "Falha na verificação de integridade — os serviços estão indisponíveis",
    "searchPlaceholder": "Filtrar serviços por nome, endpoint ou categoria...",
    "searchAria": "Filtrar serviços conectados",
    "clearSearch": "Limpar pesquisa",
    "tabs": {
      "all": "Todos",
      "internal": "Interno",
      "storage": "Armazenamento",
      "provider": "Provedor",
      "operational": "Operacional"
    },
    "categories": {
      "internal": "Mecanismo interno",
      "storage": "Armazenamento de dados",
      "provider": "Provedor de nuvem"
    },
    "statuses": {
      "operational": "Operacional",
      "standby": "Em espera",
      "degraded": "Degradado",
      "down": "Fora do ar"
    },
    "empty": {
      "title": "Nenhum serviço correspondente",
      "description": "Ajuste a pesquisa ou selecione outro filtro de categoria.",
      "resetFilters": "Redefinir filtros"
    },
    "card": {
      "copy": "Copiar",
      "copied": "✓ Copiado",
      "copyTitle": "Copiar string de conexão",
      "verifiedFallback": "Verificado na rede Docker",
      "protocol": "HTTP / TCP"
    },
    "services": {
      "omniroute": {
        "name": "Roteamento de IA NPATI",
        "desc": "Orquestração A2A, roteamento combinado, fusão, fluxo sequencial e mecanismo de vetores semânticos (v3.8.52).",
        "details": "Núcleo v3.8.52",
        "versionPrefix": "Versão"
      },
      "postgres": {
        "name": "PostgreSQL com pgvector",
        "desc": "Fonte única de verdade para espaços de trabalho, empresas, fragmentos de conhecimento e vetores semânticos.",
        "details": "Extensão vetorial ativa"
      },
      "redis": {
        "name": "Cache e fluxos Redis",
        "desc": "Filas assíncronas de tarefas, concessões, bloqueios distribuídos e cache da memória das conversas.",
        "details": "Cache em memória ativo"
      },
      "minio": {
        "name": "Armazenamento S3 MinIO",
        "desc": "Repositório de documentos isolado por locatário para anexos de conhecimento da empresa e arquivos binários.",
        "details": "API compatível com S3"
      },
      "crawler": {
        "name": "Rastreador web Crawl4AI",
        "desc": "Rastreador de pesquisa aprofundada na web, conversão Markdown e mecanismo de renderização SSR.",
        "details": "Conjunto de processos sem interface gráfica"
      },
      "coreBackend": {
        "name": "Backend principal NPATI",
        "desc": "Fonte única de verdade para autenticação, contas de usuários e cobrança.",
        "details": "Gateway de API ativo"
      },
      "cloudHub": {
        "name": "Central de nuvem NPATI",
        "desc": "Sincronização opcional do catálogo na nuvem e registro compartilhado de modelos.",
        "details": "Opcional para implantação local"
      }
    }
  },
  "memoryPage": {
    "eyebrow": "Contexto e conhecimento do negócio",
    "backToSettings": "Voltar às configurações",
    "title": "Memória do negócio",
    "heroCopy": "Organize fatos persistentes, perfis de público verificados, regras de voz da marca e decisões estratégicas que o NPATI Agent usa em todas as conversas e tarefas.",
    "addFactBtn": "+ Adicionar fato à memória",
    "addFactTitle": "Adicionar um novo fato ou decisão do negócio",
    "searchPlaceholder": "Pesquisar memória por palavra-chave, título, conteúdo do fato ou fonte...",
    "searchAria": "Filtrar itens de memória",
    "clearSearch": "Limpar pesquisa",
    "tabs": {
      "all": "Todos os itens",
      "facts": "Fatos do negócio",
      "audience": "Público e cliente ideal",
      "brand": "Marca e voz",
      "decisions": "Decisões e estratégia",
      "product": "Produtos e serviços",
      "other": "Outro"
    },
    "types": {
      "business_fact": "Fato do negócio",
      "audience": "Público e cliente ideal",
      "brand": "Marca e voz",
      "decision": "Decisão estratégica",
      "product": "Produto e serviço",
      "channel": "Canal de marketing",
      "preference": "Preferência do usuário",
      "experiment": "Experimento",
      "result": "Resultado e indicador",
      "other": "Outros conhecimentos"
    },
    "sources": {
      "manual": "Manual",
      "chatConfirmed": "Confirmado na conversa",
      "onboarding": "Configuração inicial",
      "userVerified": "Verificado pelo usuário",
      "sourcePrefix": "Fonte"
    },
    "empty": {
      "title": "Ainda não há itens de memória persistente",
      "description": "Adicione fatos fundamentais do negócio, público-alvo, tom da marca ou decisões acordadas. O NPATI Agent os recuperará automaticamente durante as conversas, sem inventar informações.",
      "addFirstBtn": "+ Adicionar primeiro fato"
    },
    "emptyFiltered": {
      "title": "Nenhuma memória correspondente",
      "description": "Ajuste as palavras-chave da pesquisa ou mude os filtros de categoria.",
      "resetFilters": "Redefinir filtros"
    },
    "card": {
      "verified": "✓ Verificado",
      "confidenceTooltip": "Pontuação de confiança: {score}",
      "copy": "Copiar",
      "copied": "✓ Copiado",
      "copyTitle": "Copiar conteúdo do fato",
      "edit": "Editar",
      "editTitle": "Editar este fato da memória",
      "delete": "Excluir",
      "deleteTitle": "Excluir este fato da memória",
      "deleteFactTitle": "Excluir fato da memória"
    },
    "drawer": {
      "eyebrow": "Conhecimento do negócio",
      "editTitle": "Editar fato da memória",
      "newTitle": "Novo fato da memória",
      "closeAria": "Fechar",
      "categorySection": "Categoria e classificação",
      "typeLabel": "Tipo de memória *",
      "types": {
        "businessFact": "📌 Fato do negócio (regras operacionais, preços, fatos)",
        "audience": "🎯 Público-alvo e cliente ideal (perfis, dados demográficos, dores)",
        "brand": "✨ Marca e voz (tom, voz, regras de posicionamento)",
        "decision": "⚖️ Decisão estratégica (plano confirmado, escolhas)",
        "product": "📦 Produto e serviço (ofertas, especificações, recursos)",
        "channel": "📢 Canal de marketing (distribuição, plataformas)",
        "preference": "⚙️ Preferência do usuário (formato, instruções de prompts)",
        "experiment": "🧪 Experimento (testes de crescimento, hipóteses ativas)",
        "result": "📈 Resultado e indicador (resultados, descobertas verificadas)",
        "other": "📝 Outros conhecimentos"
      },
      "detailsSection": "Detalhes da memória",
      "titleLabel": "Título *",
      "titlePlaceholder": "Ex.: cliente-alvo principal: fundadores B2B na Europa",
      "contentLabel": "Conteúdo do fato / Diretrizes *",
      "contentPlaceholder": "Detalhe os fatos verificados, números, limites ou regras que o NPATI Agent deve seguir...",
      "confidenceSection": "Nível de confiança",
      "confidenceLabel": "Nível de verificação",
      "confidenceOptions": {
        "high100": "Fato verificado (100% - regra comprovada)",
        "med80": "Alta confiança (80% - fortemente observado)",
        "low50": "Hipótese (50% - em investigação)"
      },
      "cancel": "Cancelar",
      "saving": "Salvando fato...",
      "saveChanges": "Salvar alterações",
      "saveFact": "Salvar fato da memória",
      "errors": {
        "titleRequired": "O título é obrigatório",
        "contentRequired": "A descrição do conteúdo do fato é obrigatória",
        "saveFailed": "Falha ao salvar o item de memória"
      },
      "defaultBusinessName": "Meu negócio"
    },
    "toasts": {
      "copied": "Fato da memória copiado para a área de transferência",
      "updated": "Item de memória atualizado",
      "saved": "Novo item de memória salvo",
      "deleted": "Excluído: \"{title}\"",
      "deleteError": "Não foi possível excluir o item de memória"
    },
    "dialogs": {
      "deleteTitle": "Excluir fato da memória?",
      "deleteMessage": "Excluir o item de memória \"{title}\"? Esta ação não pode ser desfeita.",
      "deleteConfirm": "Excluir",
      "deleteCancel": "Cancelar"
    }
  },
  "skillsPage": {
    "eyebrow": "Configurações · Habilidades",
    "backToSettings": "Voltar às configurações",
    "title": "Habilidades do agente",
    "heroCopy": "Explore os recursos de negócio integrados que o NPATI Agent seleciona automaticamente para seus pedidos.",
    "badgeBuiltin": "Catálogo integrado",
    "stats": {
      "availableSkills": "habilidades disponíveis",
      "availableSkillsDesc": "Fluxos de trabalho de agentes registrados",
      "capabilities": "recursos",
      "capabilitiesDesc": "Ações disponíveis para o agente",
      "autoValue": "Automático",
      "skillSelection": "seleção de habilidades",
      "skillSelectionDesc": "Correspondentes ao pedido e ao contexto"
    },
    "searchPlaceholder": "Pesquisar habilidades e recursos...",
    "searchAria": "Filtrar habilidades",
    "clearSearch": "Limpar pesquisa",
    "statusShowing": {
      "showing": "Mostrando",
      "of": "de",
      "skills": "habilidades"
    },
    "errorLoading": "Não foi possível carregar as habilidades",
    "empty": {
      "title": "Nenhuma habilidade correspondente",
      "description": "Tente outro nome, descrição ou recurso.",
      "clearSearch": "Limpar pesquisa"
    },
    "card": {
      "available": "Disponível",
      "builtinType": "Habilidade integrada"
    },
    "skills": {
      "competitorAnalysis": {
        "name": "Análise de concorrentes",
        "desc": "Encontra concorrentes relevantes e compara evidências públicas com o contexto atual do negócio."
      },
      "webResearch": {
        "name": "Pesquisa na web",
        "desc": "Pesquisa e lê fontes públicas da web por meio do ambiente protegido de pesquisa NPATI."
      },
      "businessStartup": {
        "name": "Abertura de negócio",
        "desc": "Estruture uma ideia de negócio, público, oferta e primeiro plano de validação."
      },
      "businessGrowth": {
        "name": "Crescimento do negócio",
        "desc": "Encontre oportunidades práticas de aquisição, retenção, posicionamento e crescimento."
      },
      "sellProduct": {
        "name": "Vender produto",
        "desc": "Transforme um produto ou serviço em uma oferta clara e um plano de vendas."
      }
    }
  }
} satisfies Pick<TranslationSchema, "goalsPage" | "contentPage" | "connectionsPage" | "memoryPage" | "skillsPage">;
