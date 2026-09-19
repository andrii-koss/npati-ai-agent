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
    languageTitle: string;
    languageDesc: string;
  };
}
