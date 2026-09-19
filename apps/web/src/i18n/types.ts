export type SupportedLanguage = "en" | "uk" | "de" | "fr" | "es" | "it" | "pl";

export interface LanguageInfo {
  code: SupportedLanguage;
  name: string;
  nativeName: string;
  flag: string;
}

export const SUPPORTED_LANGUAGES: LanguageInfo[] = [
  { code: "en", name: "English", nativeName: "English", flag: "🇬🇧" },
  { code: "uk", name: "Ukrainian", nativeName: "Українська", flag: "🇺🇦" },
  { code: "de", name: "German", nativeName: "Deutsch", flag: "🇩🇪" },
  { code: "fr", name: "French", nativeName: "Français", flag: "🇫🇷" },
  { code: "es", name: "Spanish", nativeName: "Español", flag: "🇪🇸" },
  { code: "it", name: "Italian", nativeName: "Italiano", flag: "🇮🇹" },
  { code: "pl", name: "Polish", nativeName: "Polski", flag: "🇵🇱" },
];

export interface TranslationSchema {
  common: {
    save: string;
    cancel: string;
    delete: string;
    edit: string;
    close: string;
    confirm: string;
    loading: string;
    error: string;
    success: string;
    search: string;
    send: string;
    copy: string;
    copied: string;
    back: string;
    settings: string;
    language: string;
    languageSelect: string;
    options: string;
  };
  nav: {
    chat: string;
    business: string;
    company: string;
    settings: string;
    capabilities: string;
    activity: string;
    automations: string;
    goals: string;
    content: string;
    connections: string;
    memory: string;
    skills: string;
    aiProviders: string;
  };
  sidebar: {
    newChat: string;
    pinned: string;
    recent: string;
    noSavedChats: string;
    share: string;
    rename: string;
    pin: string;
    unpin: string;
    archive: string;
    deleteChat: string;
    deleteBusiness: string;
    setupDraft: string;
    current: string;
    useInChat: string;
  };
  dialogs: {
    deleteChatTitle: string;
    deleteChatMessage: string;
    deleteBusinessTitle: string;
    deleteBusinessMessage: string;
    renameChatTitle: string;
    renameChatMessage: string;
    renameBusinessTitle: string;
    renameBusinessMessage: string;
    copyLinkTitle: string;
    copyLinkMessage: string;
    deleteGoalTitle: string;
    deleteGoalMessage: string;
    deleteMemoryTitle: string;
    deleteMemoryMessage: string;
    deleteAutomationTitle: string;
    deleteAutomationMessage: string;
    deleteDocumentTitle: string;
    deleteDocumentMessage: string;
    deleteCompanyTitle: string;
    deleteCompanyMessage: string;
    deleteAgentTitle: string;
    deleteAgentMessage: string;
    restartSetupTitle: string;
    restartSetupMessage: string;
  };
  chat: {
    placeholder: string;
    noCompany: string;
    stopGenerating: string;
    showHistory: string;
    hideHistory: string;
    searchingWeb: string;
    preparingAnswer: string;
    table: string;
    copyCsv: string;
    downloadCsv: string;
    copyCode: string;
    downloadFile: string;
    expandFullscreen: string;
    collapse: string;
    helpful: string;
    notHelpful: string;
    regenerate: string;
    shareResponse: string;
  };
  settings: {
    title: string;
    eyebrow: string;
    description: string;
    cards: {
      aiProviders: { title: string; desc: string };
      business: { title: string; desc: string };
      company: { title: string; desc: string };
      capabilities: { title: string; desc: string };
      activity: { title: string; desc: string };
      automations: { title: string; desc: string };
      goals: { title: string; desc: string };
      content: { title: string; desc: string };
      connections: { title: string; desc: string };
      memory: { title: string; desc: string };
      skills: { title: string; desc: string };
    };
  };
  home: {
    eyebrow: string;
    heading: string;
    subheading: string;
    signIn: string;
    createAccount: string;
    chatEmptyTitle: string;
    chatEmptySubtitle: string;
    actions: {
      sellSomething: { title: string; desc: string };
      startBusiness: { title: string; desc: string };
      growBusiness: { title: string; desc: string };
      improveBusiness: { title: string; desc: string };
      createContent: { title: string; desc: string };
      askAgent: { title: string; desc: string };
    };
  };
  aiMarketplace: {
    eyebrow: string;
    title: string;
    description: string;
    stats: {
      providersAvailable: string;
      modelsAvailable: string;
      providersConnected: string;
      modelsAdded: string;
    };
    routing: {
      kicker: string;
      manualTitle: string;
      autoTitle: string;
      manualDesc: string;
      autoDesc: string;
      automatic: string;
      recommended: string;
      manual: string;
      useDefault: string;
      addModelFirst: string;
      preferFreeTitle: string;
      preferFreeDesc: string;
      fallbackTitle: string;
      fallbackDesc: string;
      balanceTitle: string;
      balanceDesc: string;
      compressionTitle: string;
      compressionDesc: string;
      statusCircuitBreakers: string;
      statusGuardrails: string;
      statusCapabilities: string;
    };
    budget: {
      kicker: string;
      monthlyBudget: string;
      warningPercent: string;
      stopPaid: string;
      save: string;
      note: string;
    };
    myModels: {
      kicker: string;
      heading: string;
      addedCount: string;
      emptyTitle: string;
      emptyDesc: string;
      defaultBadge: string;
      setDefault: string;
      remove: string;
    };
    explore: {
      kicker: string;
      heading: string;
      searchPlaceholder: string;
      showingProviders: string;
      loadMore: string;
      noConnectedTitle: string;
      noConnectedDesc: string;
      noFoundTitle: string;
      noFoundDesc: string;
      exploreProviders: string;
      engineUnavailable: string;
      engineErrorPrefix: string;
      retry: string;
      loadingProviders: string;
    };
    tabs: {
      all: string;
      recommended: string;
      free: string;
      connected: string;
    };
    filters: {
      allTypes: string;
      cloud: string;
      local: string;
      allAuth: string;
      allCosts: string;
      allCapabilities: string;
    };
    labels: {
      apiKey: string;
      oauth: string;
      none: string;
      local: string;
      webSession: string;
      other: string;
      free: string;
      freeTier: string;
      paid: string;
      unknown: string;
      service: string;
      experimental: string;
    };
    actions: {
      manage: string;
      viewSetup: string;
      signIn: string;
      addSession: string;
      configure: string;
      connect: string;
    };
    cards: {
      registryModels: string;
      localAi: string;
      defaultProviderDesc: string;
    };
    capabilities: {
      text: string;
      imageToText: string;
      reasoning: string;
      tools: string;
      vision: string;
      webFetch: string;
      webSearch: string;
      embeddings: string;
      audio: string;
      video: string;
      rerank: string;
      code: string;
    };
    categories: {
      apiKey: string;
      oauth: string;
      noAuth: string;
      webSession: string;
      local: string;
      cloud: string;
      upstreamProxy: string;
      system: string;
    };
    providers: {
      gemini: { desc: string };
      openai: { desc: string };
      groq: { desc: string };
      mistral: { desc: string };
      anthropic: { desc: string };
      ollamaLocal: { desc: string };
      openCode: { desc: string };
      openRouter: { desc: string };
      deepseek: { desc: string };
    };
    drawer: {
      kicker: string;
      overview: string;
      models: string;
      setup: string;
      status: string;
      type: string;
      setupTitle: string;
      registryModels: string;
      localStatus: string;
      browseModels: string;
      testConnection: string;
      refreshModels: string;
      disconnect: string;
      noAuthNote: string;
      serverUrl: string;
      apiKey: string;
      sessionToken: string;
      connectProvider: string;
      credentialSecurity: string;
      searchModels: string;
      showingModels: string;
      loadingModels: string;
      noModelsTitle: string;
      noModelsDescConnected: string;
      noModelsDescNotConnected: string;
      addToNpati: string;
      added: string;
      connectFirst: string;
    };
  };
}
