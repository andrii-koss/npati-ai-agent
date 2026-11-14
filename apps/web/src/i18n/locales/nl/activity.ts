import type { TranslationSchema } from "../../types";

export const activity = {
  "capabilityInspector": {
    "eyebrow": "Bestuur en beveiliging",
    "title": "Functie-inspecteur",
    "backAria": "Terug naar instellingen",
    "modelProfiles": {
      "title": "Modelprofielen: conservatief alternatief.",
      "emptyHint": "Er is geen code.model_profile.<id>-vlag ingeschakeld voor deze context. Daarom gebruikt elke uitvoering het conservatieve profiel (één hulpmiddelaanroep tegelijk, automatisch gedetecteerde hulpmiddelaanroepen), ook wanneer het model overeenkomt met een van de {{count}} registerprofielen. Schakel de vlaggen in van de profielen die deze implementatie toestaat om de uitrol te starten."
    },
    "heroCopy": "Verken en controleer de 306 canonieke mogelijkheden van NPATI Agent. Controleer de grenzen van de Effective Capability Resolver, zichtbaarheid van hulpmiddelen en risicobeleid in de daadwerkelijke uitvoeromgeving.",
    "stats": {
      "totalLabel": "totaal aantal mogelijkheden",
      "totalDesc": "Geverifieerde canonieke ID's 1..306",
      "agentCallableLabel": "aanroepbaar door agenten",
      "agentCallableDesc": "Via Resolver beschikbaar voor modellen",
      "runtimeOnlyLabel": "interne uitvoeromgeving",
      "runtimeOnlyDesc": "Geïsoleerde enginebewerkingen",
      "requiresApprovalLabel": "goedkeuring vereist",
      "requiresApprovalDesc": "Beveiligingspoort met menselijke controle"
    },
    "slices": {
      "all": "Alles",
      "agentCallable": "Aanroepbaar door agenten",
      "runtimeOnly": "Alleen uitvoeromgeving",
      "userVisible": "Zichtbaar voor gebruikers",
      "automatic": "Automatisch",
      "allowed": "Toegestaan",
      "requiresApproval": "Goedkeuring vereist"
    },
    "controls": {
      "searchPlaceholder": "Filter mogelijkheden op naam, ID of domein...",
      "searchAriaLabel": "Mogelijkheden filteren",
      "clearSearch": "Zoekopdracht wissen",
      "showing": "{{start}}–{{end}} van {{total}} mogelijkheden weergegeven",
      "matching": "komt overeen met \"{{term}}\"",
      "copied": "✓ {{id}} gekopieerd",
      "perPage": "Per pagina:",
      "allCount": "Alles ({{total}})"
    },
    "table": {
      "colId": "ID",
      "sortId": "Sorteren op ID",
      "colName": "Naam",
      "sortName": "Sorteren op naam",
      "colCanonicalId": "Canonieke ID",
      "sortCanonicalId": "Sorteren op canonieke ID",
      "colDomain": "Domein",
      "sortDomain": "Sorteren op domein",
      "colType": "Type",
      "sortType": "Sorteren op type",
      "colCallable": "Aanroepbaar",
      "colRisk": "Risico",
      "sortRisk": "Sorteren op risico",
      "colStatus": "Status",
      "sortStatus": "Sorteren op status",
      "copyTooltip": "Klik om de canonieke ID te kopiëren",
      "empty": "Geen mogelijkheden voldoen aan het geselecteerde filter.",
      "prev": "← Vorige",
      "next": "Volgende →"
    },
    "callable": {
      "callable": "Aanroepbaar",
      "internal": "Intern"
    },
    "risks": {
      "low": "Laag",
      "medium": "Gemiddeld",
      "high": "Hoog",
      "critical": "Kritiek"
    },
    "statuses": {
      "verified": "Geverifieerd",
      "partial": "Gedeeltelijk",
      "notImplemented": "Niet geïmplementeerd",
      "blocked": "Geblokkeerd",
      "allowed": "Toegestaan",
      "denied": "Geweigerd",
      "unavailable": "Niet beschikbaar",
      "requiresApproval": "Goedkeuring nodig"
    },
    "types": {
      "runtime": "Uitvoeromgeving",
      "config": "Configuratie",
      "orchestr": "Coördinatie",
      "tool": "Hulpmiddel",
      "article": "Artikel",
      "secOps": "Beveiligingsbeheer"
    },
    "connectedServices": "Verbonden diensten",
    "errorLoad": "Kan mogelijkheden niet laden",
    "integrations": {
      "kicker": "Geverifieerde productintegraties",
      "title": "Geïmplementeerde berichtenkanalen",
      "manage": "Integraties beheren",
      "sharedRuntime": "Gedeelde NPATI Agent-uitvoeromgeving",
      "loading": "Integratiestatus laden...",
      "notice": "De integratiestatus is beschikbaar wanneer de Agent API verbonden is."
    }
  },
  "activity": {
    "eyebrow": "Waarneembaarheid en controle",
    "title": "Activiteit en uitvoeringsspoor",
    "backAria": "Terug naar instellingen",
    "heroCopy": "Gedetailleerd realtime uitvoeringsspoor, delegatiestappen, hulpmiddelaanroepen, vertragingen en beveiligingsbeslissingen voor uitvoeringen van bedrijfsagenten.",
    "stats": {
      "totalRuns": "Totaal aantal uitvoeringen",
      "totalRunsDesc": "Vastgelegde agentuitvoeringen",
      "completed": "Voltooid",
      "completedDesc": "Geslaagd zonder fouten",
      "inProgress": "Bezig / In wachtrij",
      "inProgressDesc": "Actieve agentwerklasten",
      "securityDecisions": "Beveiligingsbeslissingen",
      "securityDecisionsDesc": "Gecontroleerde hulpmiddelcontroles"
    },
    "controls": {
      "companyLabel": "Bedrijf:",
      "all": "Alles",
      "completed": "Voltooid",
      "running": "Bezig",
      "failed": "Mislukt",
      "searchPlaceholder": "Zoek uitvoeringen op taak of ID...",
      "searchAriaLabel": "Uitvoeringen zoeken",
      "clearSearch": "Zoekopdracht wissen",
      "refresh": "Vernieuwen",
      "refreshing": "Vernieuwen...",
      "refreshTitle": "Uitvoeringen vernieuwen"
    },
    "dispatch": {
      "title": "Taak naar bedrijfsagent verzenden",
      "subtitle": "Start een autonome taak met meerdere agenten en bekijk realtime uitvoeringssporen",
      "modeLabel": "Uitvoeringsmodus:",
      "modes": {
        "auto": "Automatische coördinatie (adaptief)",
        "pipeline": "Pijplijn (meerdere agenten)",
        "single": "Eén agent (snel)",
        "fusion": "Fusie (meerdere modellen)"
      },
      "placeholderWithCompany": "Voer een taak in voor agenten van {{name}} (bijv. 'Analyseer het aanbod en de prijzen van concurrenten')...",
      "placeholderDefault": "Voer een taakprompt in voor bedrijfsagenten...",
      "dispatchTask": "Taak verzenden",
      "dispatching": "Verzenden...",
      "presetsLabel": "Voorinstellingen:",
      "presets": {
        "marketAuditLabel": "Markt- en concurrentieonderzoek",
        "marketAuditPrompt": "Voer uitgebreid concurrentieonderzoek en een analyse van marktpositionering uit",
        "securityAuditLabel": "Beveiliging en mogelijkheden verifiëren",
        "securityAuditPrompt": "Controleer bedrijfsrechten voor hulpmiddelen, API-toegangsregels en beveiligingspoorten",
        "growthRoadmapLabel": "Strategisch groeiplan",
        "growthRoadmapPrompt": "Stel een ideaal klantprofiel en een uitvoerbaar groeiplan voor 90 dagen op"
      },
      "dispatchedNotice": "Uitvoering verzonden: {{id}} ({{status}})",
      "dispatchFailed": "Kan agentuitvoering niet verzenden"
    },
    "empty": {
      "noCompaniesTitle": "Geen bedrijven gevonden",
      "noCompaniesCopy": "Activiteit en uitvoeringsspoor volgt uitvoeringen met meerdere agenten binnen een AI-bedrijf.",
      "createCompanyBtn": "AI-bedrijf maken",
      "noRunsTitle": "Nog geen uitvoeringen vastgelegd",
      "presetsTitle": "Taakvoorinstellingen en startscenario's",
      "noRunsCopy": "Dit bedrijf heeft geen verzonden agentuitvoeringen. Gebruik de taakverzender hierboven of kies een voorinstelling voor realtime uitvoeringssporen, delegatiestappen en beveiligingscontroles van hulpmiddelen.",
      "presetsCopy": "Kies hieronder een voorinstelling of voer hierboven een aangepaste taak in voor realtime uitvoeringssporen, delegatiestappen en beveiligingscontroles van hulpmiddelen.",
      "dispatchPresetBtn": "Verzenden: {{label}} →",
      "viewTraceBtn": "Uitvoeringsgeschiedenis en spoor bekijken ({{count}}) →"
    },
    "sidebar": {
      "recentExecutions": "Recente uitvoeringen ({{count}})",
      "backToPresets": "← 3 voorinstellingen",
      "noFilteredRuns": "Geen uitvoeringen voldoen aan de huidige filtercriteria.",
      "clearFiltersBtn": "Filters wissen"
    },
    "trace": {
      "backToPresetsAria": "Terug naar voorinstellingen",
      "modePrefix": "Modus: {{mode}}",
      "comboPrefix": "Combinatie: {{name}}",
      "runIdLabel": "Uitvoerings-ID:",
      "copy": "Kopiëren",
      "copied": "Gekopieerd",
      "copyRunIdTitle": "Uitvoerings-ID kopiëren",
      "startedLabel": "Gestart:",
      "completedLabel": "Voltooid:",
      "durationLabel": "Duur:",
      "finalOutput": "Definitief uitvoerresultaat",
      "copyResultTitle": "Resultaat kopiëren",
      "executionFault": "Uitvoeringsfout",
      "completionReportTitle": "Voltooiingsrapport van achtergrondtaak",
      "attemptSummary": "Poging {{attempt}} · {{tokens}} tokens · ${{cost}} · {{duration}}s",
      "timelineTitle": "Tijdlijn van achtergronduitvoering ({{count}})",
      "timelineDesc": "Blijvende werktoewijzingen, nieuwe pogingen en definitieve voltooiingsgebeurtenissen",
      "attemptLabel": "Poging {{attempt}}",
      "synchronousNotice": "Deze uitvoering was synchroon; er zijn geen achtergrondwerkergebeurtenissen uitgezonden.",
      "delegationTitle": "Delegatiepijplijn van agenten ({{count}})",
      "delegationDesc": "Rolcoördinatie en overdrachten tussen meerdere agenten",
      "agentPrefix": "Agent: {{id}}",
      "modelPrefix": "Model:",
      "lanePrefix": "Baan: {{lane}}",
      "noStepsNotice": "Geen delegatiestappen vastgelegd voor deze taak met één beurt.",
      "toolsTitle": "Hulpmiddeluitvoeringen en beveiligingspoorten ({{count}})",
      "toolsDesc": "Controles door de canonieke functieresolver en veiligheidscontroles",
      "policyReason": "Beleidsreden:",
      "noToolsNotice": "Er zijn geen externe hulpmiddelen aangeroepen tijdens deze uitvoering.",
      "selectRunTitle": "Selecteer een uitvoering om te bekijken",
      "selectRunCopy": "Kies een uitvoering in het linkerpaneel om de tijdlijn, delegatiestappen en beveiligingscontroles te bekijken."
    },
    "errors": {
      "loadRunsFailed": "Kan activiteit niet laden",
      "loadRunDetailsFailed": "Kan uitvoeringsgegevens niet laden"
    }
  },
  "automations": {
    "eyebrow": "Instellingen · Automatiseringen",
    "title": "Automatiseringen en geplande taken",
    "backAria": "Terug naar instellingen",
    "heroCopy": "Configureer periodieke achtergrondtriggers, terugkerende cron-taken en autonome agenttaken voor je bedrijf.",
    "selectCompanyAria": "Bedrijf selecteren",
    "newAutomationBtn": "+ Nieuwe automatisering",
    "stats": {
      "total": "totaal aantal automatiseringen",
      "totalDesc": "Geplande AI-achtergrondtaken",
      "active": "actieve triggers",
      "activeDesc": "Actieve cron-schema's",
      "paused": "gepauzeerde schema's",
      "pausedDesc": "Stand-by / inactieve triggers",
      "assignedAgents": "toegewezen agenten",
      "assignedAgentsDesc": "Geconfigureerde agentuitvoerders"
    },
    "controls": {
      "searchPlaceholder": "Filter automatiseringen op naam, beschrijving, prompt, cron...",
      "searchAriaLabel": "Automatiseringen filteren",
      "clearSearch": "Zoekopdracht wissen",
      "tabAll": "Alles",
      "tabActive": "Actief",
      "tabPaused": "Gepauzeerd"
    },
    "showingStatus": "{{count}} van {{total}} automatiseringen weergegeven",
    "matchingQuery": "komt overeen met \"{{query}}\"",
    "empty": {
      "noAutomationsTitle": "Geen automatiseringen geconfigureerd",
      "noAutomationsDesc": "Plan autonome cron-achtergrondtaken, periodiek marktonderzoek of dagelijkse agentworkflows voor dit bedrijf.",
      "createFirstBtn": "+ Eerste automatisering maken",
      "noMatchingTitle": "Geen overeenkomende automatiseringen",
      "noMatchingDesc": "Pas je zoekopdracht of statusfilter aan om te vinden wat je zoekt.",
      "clearFiltersBtn": "Filters wissen"
    },
    "table": {
      "colStatus": "Status",
      "colTask": "Taak en instructies",
      "colSchedule": "Planning (Cron)",
      "colAssignedAgent": "Toegewezen agent",
      "colActions": "Acties",
      "statusActive": "ACTIEF",
      "statusPaused": "GEPAUZEERD",
      "clickToPause": "Klik om te pauzeren",
      "clickToActivate": "Klik om te activeren",
      "promptPrefix": "Prompt:",
      "nextRunPrefix": "Volgende:",
      "mainAgent": "Hoofdagent",
      "runNow": "▶ Nu uitvoeren",
      "running": "Uitvoeren...",
      "runNowTitle": "Deze automatisering direct uitvoeren",
      stop: "Stoppen",
      stopTitle: "Lopende uitvoering stoppen",
      "history": "Geschiedenis",
      "historyTitle": "Uitvoeringsgeschiedenis bekijken",
      "edit": "Bewerken",
      "editTitle": "Automatiseringsinstellingen bewerken",
      "delete": "Verwijderen",
      "deleteTitle": "Automatisering verwijderen"
    },
    "presets": {
      "daily9": "Dagelijks om 09:00",
      "daily18": "Dagelijks om 18:00",
      "mondays9": "Maandags om 09:00",
      "fridays17": "Vrijdags om 17:00",
      "hourly": "Elk uur",
      "daily0": "Dagelijks om 00:00"
    },
    "editor": {
      "kicker": "Automatiseringen",
      "editTitle": "Automatisering bewerken",
      "newTitle": "Nieuwe automatisering",
      "taskParamsHeading": "Taakparameters",
      "taskNameLabel": "Taaknaam",
      "taskNamePlaceholder": "Bijv. dagelijkse concurrentieanalyse",
      "descLabel": "Beschrijving",
      "descPlaceholder": "Wat deze automatisering bereikt",
      "assignedAgentLabel": "Toegewezen agent",
      "mainAgentDefault": "Hoofdagent (standaard)",
      "schedulePresetsLabel": "Planningsvoorinstellingen",
      "cronExpressionLabel": "Cron-expressie (5 velden: minuut uur dag maand weekdag)",
      "cronPlaceholder": "0 9 * * *",
      "agentPromptLabel": "Agentprompt",
      "agentPromptPlaceholder": "Beschrijf het precieze doel en de stappen die de agent moet uitvoeren...",
      "saveBtn": "Automatisering opslaan",
      "savingBtn": "Opslaan...",
      "deleteBtn": "Verwijderen",
      "cancelBtn": "Annuleren"
    },
    "history": {
      "kicker": "Uitvoeringsgeschiedenis",
      "loading": "Uitvoeringsgeschiedenis laden...",
      "noRuns": "Nog geen uitvoeringen vastgelegd.",
      "duration": "Duur:",
      "finalResult": "✓ Definitief resultaat:",
      "error": "Fout:"
    },
    "dialogs": {
      "deleteTitle": "Automatisering verwijderen?",
      "deleteMessage": "Weet u zeker dat u deze automatisering wilt verwijderen?",
      "deleteConfirm": "Verwijderen",
      "deleteCancel": "Annuleren"
    },
    "notifications": {
      "runInitiated": "Uitvoering gestart voor \"{{name}}\".",
      stopped: "Uitvoering van ‘{{name}}’ gestopt.",
      "resultReceived": "Resultaat ontvangen!",
      "runError": "Uitvoeringsfout: {{error}}"
    }
  }
} satisfies Pick<TranslationSchema, "capabilityInspector" | "activity" | "automations">;
