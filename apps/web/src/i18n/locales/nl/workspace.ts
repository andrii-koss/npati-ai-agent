import type { TranslationSchema } from "../../types";

export const workspace = {
  "goalsPage": {
    "eyebrow": "Instellingen · Doelen",
    "backToSettings": "Terug naar instellingen",
    "title": "Doelen en doelstellingen",
    "heroCopy": "Definieer meetbare resultaten, streefwaarden en prioritaire mijlpalen voor de afstemming van autonome AI-agenten.",
    "newGoal": "+ Nieuw doel",
    "stats": {
      "totalGoals": "totaal aantal doelen",
      "totalGoalsDesc": "Gedefinieerde ondernemingsdoelen",
      "activeOutcomes": "actieve resultaten",
      "activeOutcomesDesc": "Lopende agentprioriteiten",
      "completedGoals": "voltooide doelen",
      "completedGoalsDesc": "Bereikte mijlpalen",
      "highPriority": "hoge prioriteit",
      "highPriorityDesc": "Kritieke P1-doelstellingen"
    },
    "searchPlaceholder": "Filter doelen op titel, beschrijving of meeteenheid...",
    "searchAria": "Doelen filteren",
    "clearSearch": "Zoekopdracht wissen",
    "tabs": {
      "all": "Alles",
      "active": "Actief",
      "paused": "Gepauzeerd",
      "completed": "Voltooid"
    },
    "filterByPriority": "Filteren op prioriteit",
    "priorities": {
      "all": "Alle prioriteiten",
      "high": "Hoge prioriteit (P1)",
      "normal": "Normale prioriteit (P2)",
      "low": "Lage prioriteit (P3)"
    },
    "priorityBadges": {
      "high": "Hoog P1",
      "normal": "Normaal P2",
      "low": "Laag P3"
    },
    "showingGoals": "{count} van {total} doelen weergegeven",
    "matchingQuery": " overeenkomend met \"{query}\"",
    "table": {
      "status": "Status",
      "goalAndOutcome": "Doel en resultaat",
      "progress": "Voortgang",
      "priority": "Prioriteit",
      "dueDate": "Einddatum",
      "actions": "Acties"
    },
    "statusTooltips": {
      "pause": "Klik om te pauzeren",
      "resume": "Klik om te hervatten",
      "reactivate": "Klik om opnieuw te activeren"
    },
    "statuses": {
      "active": "ACTIEF",
      "paused": "GEPAUZEERD",
      "completed": "VOLTOOID",
      "cancelled": "GEANNULEERD"
    },
    "editGoalTooltip": "Klik om doel te bewerken",
    "qualitativeGoal": "Kwalitatief doel",
    "overdue": "Te laat",
    "actions": {
      "done": "✓ Gereed",
      "markCompleted": "Doel als voltooid markeren",
      "reopen": "Heropenen",
      "reopenTitle": "Doel heropenen",
      "edit": "Bewerken",
      "editTitle": "Doelparameters bewerken",
      "delete": "Verwijderen",
      "deleteTitle": "Doel verwijderen"
    },
    "empty": {
      "noGoalsTitle": "Nog geen doelen geconfigureerd",
      "noGoalsDesc": "Definieer concrete ondernemingsresultaten, meetbare streefwaarden of strategische mijlpalen die NPATI-agenten kunnen prioriteren bij autonome uitvoering en chataanbevelingen.",
      "createFirstGoal": "+ Eerste doel maken",
      "noMatchingTitle": "Geen overeenkomende doelen",
      "noMatchingDesc": "Pas je zoektermen of filterselectie aan om te vinden wat je zoekt.",
      "clearFilters": "Filters wissen"
    },
    "drawer": {
      "kicker": "Doelen",
      "editGoal": "Doel bewerken",
      "newGoal": "Nieuw doel",
      "close": "Sluiten",
      "objectiveSection": "Doelstelling",
      "titleLabel": "Doeltitel *",
      "titlePlaceholder": "Bijv. de eerste 100 betalende klanten werven",
      "descLabel": "Beschrijving / succescriteria",
      "descPlaceholder": "Hoe ziet succes eruit? Welke specifieke resultaten proberen agenten te bereiken?",
      "priorityStatusSection": "Prioriteit en status",
      "priorityLabel": "Prioriteit",
      "statusLabel": "Status",
      "metricSection": "Meetwaarden bijhouden (optioneel)",
      "metricHint": "Geef numerieke streefwaarden op als dit doel kwantitatief kan worden gemeten en gevolgd.",
      "targetValueLabel": "Streefwaarde",
      "targetValuePlaceholder": "Bijv. 100",
      "currentValueLabel": "Huidige waarde",
      "currentValuePlaceholder": "Bijv. 42",
      "unitLabel": "Eenheid",
      "unitPlaceholder": "Bijv. $, gebruikers, %",
      "dueDateSection": "Beoogde einddatum",
      "deadlineLabel": "Deadline voor mijlpaal",
      "cancel": "Annuleren",
      "saving": "Opslaan...",
      "saveChanges": "Doelwijzigingen opslaan",
      "createGoal": "Doel maken"
    },
    "notices": {
      "failedToLoad": "Kan doelen niet laden: {message}",
      "titleRequired": "Doeltitel is vereist",
      "updatedSuccess": "Doel \"{title}\" bijgewerkt.",
      "createdSuccess": "Doel \"{title}\" gemaakt.",
      "failedToSave": "Kan doel niet opslaan: {message}",
      "deletedSuccess": "Doel \"{title}\" verwijderd.",
      "failedToDelete": "Kan doel niet verwijderen: {message}",
      "statusUpdated": "Status van doel \"{title}\" bijgewerkt naar {status}.",
      "statusUpdateError": "Fout bij statusupdate: {message}"
    },
    "dialogs": {
      "deleteTitle": "Doel verwijderen?",
      "deleteMessage": "Weet je zeker dat je doel \"{title}\" wilt verwijderen?",
      "deleteConfirm": "Verwijderen",
      "deleteCancel": "Annuleren"
    }
  },
  "contentPage": {
    "eyebrow": "Instellingen · Inhoudshub",
    "backToSettings": "Terug naar instellingen",
    "title": "Inhoudshub en productiebibliotheek",
    "heroCopy": "Bekijk, bewerk, formatteer en exporteer artikelen, SEO-plannen en sociale concepten die door autonome agenten zijn gegenereerd.",
    "newContentDraft": "+ Nieuw inhoudsconcept",
    "newContentPrompt": "Stel een krachtig marketingartikel en een sociaal distributieplan voor onze doelgroep op.",
    "tabs": {
      "all": "Alle items",
      "articles": "Artikelen",
      "seoBlueprints": "SEO-plannen",
      "socialPosts": "Sociale berichten",
      "briefsPlans": "Briefings en plannen"
    },
    "searchPlaceholder": "Zoek concepten, trefwoorden, onderwerpen...",
    "searchAria": "Inhoudsbibliotheek doorzoeken",
    "clearSearch": "Zoekopdracht wissen",
    "types": {
      "article": "Artikel",
      "seoBlueprint": "SEO-plan",
      "socialMedia": "Sociale media",
      "briefPlan": "Briefing en plan"
    },
    "empty": {
      "readyTitle": "Je AI-inhoudsbibliotheek is klaar",
      "readyDesc": "Wanneer autonome bedrijfsagenten inhoudsbriefings, trefwoordonderzoek of artikeltaken uitvoeren, worden alle gegenereerde productieconcepten hier georganiseerd.",
      "generateFirstDraft": "+ Eerste concept genereren in chat",
      "chatPrompt": "Stel een SEO-blogbericht op voor ons ideale klantprofiel met belangrijke inzichten en veelgestelde vragen.",
      "restoreDeleted": "Verwijderde documenten herstellen",
      "noMatchingTitle": "Geen overeenkomende documenten",
      "noMatchingDesc": "Pas je zoektermen aan of selecteer een ander filter voor het inhoudstype.",
      "resetFilters": "Filters herstellen",
      "selectDoc": "Selecteer links een document om te lezen of te exporteren."
    },
    "cards": {
      "listAria": "Lijst met gegenereerde documenten",
      "deleteDocumentTitle": "Document verwijderen",
      "minRead": "~{count} min leestijd"
    },
    "viewer": {
      "expand": "Uitvouwen",
      "collapse": "Inklappen",
      "expandTitle": "Uitvouwen om het volledige document te lezen",
      "collapseTitle": "Samenvouwen naar standaardweergave",
      "editDocument": "Document bewerken",
      "views": {
        "preview": "Voorbeeld",
        "previewTitle": "Opgemaakte leesweergave",
        "raw": "Ruwe .md",
        "rawTitle": "Ruwe Markdown-bron"
      },
      "actions": {
        "edit": "✎ Bewerken",
        "editTitle": "Documenttekst, titel en categorie bewerken",
        "delete": "🗑 Verwijderen",
        "deleteTitle": "Dit document verwijderen",
        "copy": "Kopiëren",
        "copied": "✓ Gekopieerd!",
        "copyTitle": "Markdown-inhoud naar klembord kopiëren",
        "download": ".md downloaden",
        "downloadTitle": "Als Markdown-bestand downloaden",
        "saveChanges": "✓ Wijzigingen opslaan",
        "saveChangesTitle": "Je wijzigingen opslaan",
        "cancel": "Annuleren",
        "cancelTitle": "Bewerken annuleren"
      },
      "metrics": {
        "words": "woorden",
        "characters": "tekens",
        "readTime": "leestijd",
        "generatedDate": "generatiedatum"
      },
      "editor": {
        "titleLabel": "Documenttitel",
        "titlePlaceholder": "Voer documenttitel in...",
        "typeLabel": "Inhoudstype",
        "bodyLabel": "Documenttekst (Markdown)",
        "saveHint": "Druk op Ctrl+S om op te slaan",
        "bodyPlaceholder": "Schrijf of bewerk hier de Markdown-documenttekst..."
      },
      "overlay": {
        "expand": "Uitvouwen om het volledige document te lezen",
        "collapse": "Samenvouwen naar standaardweergave"
      }
    },
    "toast": {
      "saved": "Wijzigingen opgeslagen!",
      "saveError": "Kan wijzigingen niet opslaan",
      "deleted": "Document verwijderd",
      "deleteError": "Kan document niet verwijderen"
    },
    "dialogs": {
      "deleteTitle": "Inhoud verwijderen?",
      "deleteMessage": "Weet je zeker dat je \"{title}\" wilt verwijderen?",
      "deleteConfirm": "Verwijderen",
      "deleteCancel": "Annuleren",
      "thisDocumentFallback": "dit document"
    }
  },
  "connectionsPage": {
    "eyebrow": "Infrastructuur en integraties",
    "backToSettings": "Terug naar instellingen",
    "title": "Verbonden diensten",
    "heroCopy": "Bewaak de werking, endpoints en status van alle opslagengines, interne AI-adapters en systeemmicroservices.",
    "refreshStatus": "Status vernieuwen",
    "checkingStatus": "Status controleren...",
    "refreshTitle": "Gezondheidseindpunten van diensten testen",
    "lastSuccessfulCheck": "Laatste geslaagde controle: {{time}}",
    "noSuccessfulCheck": "Nog geen geslaagde controle",
    "checkFailed": "Gezondheidscontrole mislukt — diensten zijn niet beschikbaar",
    "searchPlaceholder": "Filter diensten op naam, endpoint of categorie...",
    "searchAria": "Verbonden diensten filteren",
    "clearSearch": "Zoekopdracht wissen",
    "tabs": {
      "all": "Alles",
      "internal": "Intern",
      "storage": "Opslag",
      "provider": "Provider",
      "operational": "Operationeel"
    },
    "categories": {
      "internal": "Interne engine",
      "storage": "Gegevensopslag",
      "provider": "Cloudprovider"
    },
    "statuses": {
      "operational": "Operationeel",
      "standby": "Stand-by",
      "degraded": "Verminderde werking",
      "down": "Uitgevallen"
    },
    "empty": {
      "title": "Geen overeenkomende diensten",
      "description": "Pas je zoekopdracht aan of kies een ander categoriefilter.",
      "resetFilters": "Filters herstellen"
    },
    "card": {
      "copy": "Kopiëren",
      "copied": "✓ Gekopieerd",
      "copyTitle": "Verbindingsreeks kopiëren",
      "verifiedFallback": "Geverifieerd in Docker-netwerk",
      "protocol": "HTTP / TCP"
    },
    "services": {
      "omniroute": {
        "name": "NPATI AI-routering",
        "desc": "A2A-coördinatie, combinatieroutering, fusie, pijplijn en embeddingengine (v3.8.52).",
        "details": "v3.8.52-kern",
        "versionPrefix": "Versie"
      },
      "postgres": {
        "name": "PostgreSQL met pgvector",
        "desc": "Centrale bron voor werkruimten, bedrijven, kennisfragmenten en vectorembeddings.",
        "details": "Vectorextensie actief"
      },
      "redis": {
        "name": "Redis-cache en streams",
        "desc": "Asynchrone taakwachtrijen, leases, gedistribueerde vergrendelingen en gespreksgeheugencache.",
        "details": "Geheugencache actief"
      },
      "minio": {
        "name": "MinIO S3-opslag",
        "desc": "Per tenant geïsoleerde documentopslag voor bedrijfskennisbijlagen en binaire bestanden.",
        "details": "S3-compatibele API"
      },
      "crawler": {
        "name": "Crawl4AI-webcrawler",
        "desc": "Crawler voor diepgaand webonderzoek, Markdown-conversie en SSR-renderingengine.",
        "details": "Pool van headless werkers"
      },
      "coreBackend": {
        "name": "NPATI-kernbackend",
        "desc": "Centrale bron voor verificatie, gebruikersaccounts en facturering.",
        "details": "API-gateway actief"
      },
      "cloudHub": {
        "name": "NPATI-cloudhub",
        "desc": "Optionele synchronisatie van cloudcatalogus en gedeeld modelregister.",
        "details": "Optioneel voor lokale implementatie"
      }
    }
  },
  "memoryPage": {
    "eyebrow": "Ondernemingscontext en kennis",
    "backToSettings": "Terug naar instellingen",
    "title": "Ondernemingsgeheugen",
    "heroCopy": "Beheer blijvende feiten, geverifieerde doelgroep-profielen, merkstemregels en strategische beslissingen die NPATI Agent in alle chats en taken gebruikt.",
    "addFactBtn": "+ Geheugenfeit toevoegen",
    "addFactTitle": "Een nieuw ondernemingsfeit of een beslissing toevoegen",
    "searchPlaceholder": "Zoek geheugen op trefwoord, titel, feitinhoud of bron...",
    "searchAria": "Geheugenitems filteren",
    "clearSearch": "Zoekopdracht wissen",
    "tabs": {
      "all": "Alle items",
      "facts": "Ondernemingsfeiten",
      "audience": "Doelgroep en ideaal klantprofiel",
      "brand": "Merk en stem",
      "decisions": "Beslissingen en strategie",
      "product": "Producten en diensten",
      "other": "Overig"
    },
    "types": {
      "business_fact": "Ondernemingsfeit",
      "audience": "Doelgroep en ideaal klantprofiel",
      "brand": "Merk en stem",
      "decision": "Strategische beslissing",
      "product": "Product en dienst",
      "channel": "Marketingkanaal",
      "preference": "Gebruikersvoorkeur",
      "experiment": "Experiment",
      "result": "Resultaat en meetwaarde",
      "other": "Overige kennis"
    },
    "sources": {
      "manual": "Handmatig",
      "chatConfirmed": "Bevestigd in chat",
      "onboarding": "Introductie",
      "userVerified": "Geverifieerd door gebruiker",
      "sourcePrefix": "Bron"
    },
    "empty": {
      "title": "Nog geen blijvende geheugenitems",
      "description": "Voeg kernfeiten over je onderneming, doelgroep, merktoon of afgesproken beslissingen toe. NPATI Agent haalt deze automatisch terug bij het redeneren in chats zonder feiten te verzinnen.",
      "addFirstBtn": "+ Eerste feit toevoegen"
    },
    "emptyFiltered": {
      "title": "Geen overeenkomend geheugen",
      "description": "Pas je zoekwoorden aan of wissel van categoriefilter.",
      "resetFilters": "Filters herstellen"
    },
    "card": {
      "verified": "✓ Geverifieerd",
      "confidenceTooltip": "Betrouwbaarheidsscore: {score}",
      "copy": "Kopiëren",
      "copied": "✓ Gekopieerd",
      "copyTitle": "Feitinhoud kopiëren",
      "edit": "Bewerken",
      "editTitle": "Dit geheugenfeit bewerken",
      "delete": "Verwijderen",
      "deleteTitle": "Dit geheugenfeit verwijderen",
      "deleteFactTitle": "Geheugenfeit verwijderen"
    },
    "drawer": {
      "eyebrow": "Ondernemingskennis",
      "editTitle": "Geheugenfeit bewerken",
      "newTitle": "Nieuw geheugenfeit",
      "closeAria": "Sluiten",
      "categorySection": "Categorie en classificatie",
      "typeLabel": "Geheugentype *",
      "types": {
        "businessFact": "📌 Ondernemingsfeit (ondernemingsregels, prijzen, feiten)",
        "audience": "🎯 Doelgroep en ideaal klantprofiel (persona's, demografie, pijnpunten)",
        "brand": "✨ Merk en stem (toon, stem, positioneringsregels)",
        "decision": "⚖️ Strategische beslissing (bevestigd plan, keuzes)",
        "product": "📦 Product en dienst (aanbod, specificaties, functies)",
        "channel": "📢 Marketingkanaal (distributie, platforms)",
        "preference": "⚙️ Gebruikersvoorkeur (formaat, promptinstructies)",
        "experiment": "🧪 Experiment (groeitests, actieve hypotheses)",
        "result": "📈 Resultaat en meetwaarde (uitkomsten, geverifieerde bevindingen)",
        "other": "📝 Overige kennis"
      },
      "detailsSection": "Geheugengegevens",
      "titleLabel": "Titel *",
      "titlePlaceholder": "Bijv. primaire doelgroep: B2B-oprichters in Europa",
      "contentLabel": "Feitinhoud / richtlijnen *",
      "contentPlaceholder": "Beschrijf de geverifieerde feiten, cijfers, grenzen of regels waaraan NPATI Agent zich moet houden...",
      "confidenceSection": "Betrouwbaarheidsniveau",
      "confidenceLabel": "Verificatieniveau",
      "confidenceOptions": {
        "high100": "Geverifieerd feit (100% - vaststaande basisregel)",
        "med80": "Hoge betrouwbaarheid (80% - sterk waargenomen)",
        "low50": "Hypothese (50% - in onderzoek)"
      },
      "cancel": "Annuleren",
      "saving": "Feit opslaan...",
      "saveChanges": "Wijzigingen opslaan",
      "saveFact": "Geheugenfeit opslaan",
      "errors": {
        "titleRequired": "Titel is vereist",
        "contentRequired": "Beschrijving van feitinhoud is vereist",
        "saveFailed": "Kan geheugenitem niet opslaan"
      },
      "defaultBusinessName": "Mijn onderneming"
    },
    "toasts": {
      "copied": "Geheugenfeit naar klembord gekopieerd",
      "updated": "Geheugenitem bijgewerkt",
      "saved": "Nieuw geheugenitem opgeslagen",
      "deleted": "Verwijderd: \"{title}\"",
      "deleteError": "Kan geheugenitem niet verwijderen"
    },
    "dialogs": {
      "deleteTitle": "Geheugenfeit verwijderen?",
      "deleteMessage": "Geheugenitem \"{title}\" verwijderen? Dit kan niet ongedaan worden gemaakt.",
      "deleteConfirm": "Verwijderen",
      "deleteCancel": "Annuleren"
    }
  },
  "skillsPage": {
    "eyebrow": "Instellingen · Vaardigheden",
    "backToSettings": "Terug naar instellingen",
    "title": "Agentvaardigheden",
    "heroCopy": "Bekijk de ingebouwde ondernemingsmogelijkheden die NPATI Agent automatisch voor je verzoeken selecteert.",
    "badgeBuiltin": "Ingebouwde catalogus",
    "stats": {
      "availableSkills": "beschikbare vaardigheden",
      "availableSkillsDesc": "Geregistreerde agentworkflows",
      "capabilities": "mogelijkheden",
      "capabilitiesDesc": "Beschikbare acties voor de agent",
      "autoValue": "Automatisch",
      "skillSelection": "vaardigheidsselectie",
      "skillSelectionDesc": "Afgestemd op verzoek en context"
    },
    "searchPlaceholder": "Zoek vaardigheden en mogelijkheden...",
    "searchAria": "Vaardigheden filteren",
    "clearSearch": "Zoekopdracht wissen",
    "statusShowing": {
      "showing": "Weergegeven",
      "of": "van",
      "skills": "vaardigheden"
    },
    "errorLoading": "Kan vaardigheden niet laden",
    "empty": {
      "title": "Geen overeenkomende vaardigheden",
      "description": "Probeer een andere naam, beschrijving of mogelijkheid.",
      "clearSearch": "Zoekopdracht wissen"
    },
    "card": {
      "available": "Beschikbaar",
      "builtinType": "Ingebouwde vaardigheid"
    },
    "skills": {
      "competitorAnalysis": {
        "name": "Concurrentieanalyse",
        "desc": "Vindt relevante concurrenten en vergelijkt openbaar bewijs met de huidige ondernemingscontext."
      },
      "webResearch": {
        "name": "Webonderzoek",
        "desc": "Zoekt en leest openbare webbronnen binnen de beveiligde grenzen van NPATI Web Research."
      },
      "businessStartup": {
        "name": "Ondernemingsstart",
        "desc": "Geef vorm aan een ondernemingsidee, doelgroep, aanbod en eerste validatieplan."
      },
      "businessGrowth": {
        "name": "Ondernemingsgroei",
        "desc": "Vind praktische kansen voor klantenwerving, behoud, positionering en groei."
      },
      "sellProduct": {
        "name": "Product verkopen",
        "desc": "Zet een product of dienst om in een duidelijk aanbod en verkoopplan."
      }
    }
  }
} satisfies Pick<TranslationSchema, "goalsPage" | "contentPage" | "connectionsPage" | "memoryPage" | "skillsPage">;
