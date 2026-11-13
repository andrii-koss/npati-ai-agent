export interface ProjectSectionSchema {
    types: {
      website: string;
      webApp: string;
      landingPage: string;
      mobileApp: string;
    };
};

export interface CommonSchema {
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
    ok: string;
    notification: string;
    deleteConfirmation: string;
    confirmation: string;
    inputRequired: string;
};

export interface NavSchema {
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

export interface SidebarSchema {
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

export interface DialogsSchema {
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

export interface ChatSchema {
    emptyTitle: string;
    emptySubtitle: string;
    placeholder: string;
    businessEmptySubtitle: string;
    businessPlaceholder: string;
    workModeLabel: string;
    workModeChat: string;
    workModeCode: string;
    codeModeNeedsProject: string;
    thinking: string;
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
    showFullPrompt: string;
    collapsePrompt: string;
    copyPrompt: string;
    copiedPrompt: string;
    editPrompt: string;
};

export interface UserMenuSchema {
    emailInbox: string;
    aiProvider: string;
    company: string;
    memory: string;
    settings: string;
    signOut: string;
    signOutIncompleteTitle: string;
    signOutIncompleteDesc: string;
};

export interface SettingsSchema {
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
      email: { title: string; desc: string };
      goals: { title: string; desc: string };
      content: { title: string; desc: string };
      connections: { title: string; desc: string };
      memory: { title: string; desc: string };
      skills: { title: string; desc: string };
    };
};

export interface HomeSchema {
    eyebrow: string;
    heading: string;
    subheading: string;
    signIn: string;
    createAccount: string;
    chatEmptyTitle: string;
    chatEmptySubtitle: string;
    footerPrefix: string;
    footerLink: string;
    actions: {
      buildWebsite: { title: string; desc: string };
      buildApplication: { title: string; desc: string };
      connectDatabase: { title: string; desc: string };
      improveProject: { title: string; desc: string };
      researchBusiness: { title: string; desc: string };
      automateWork: { title: string; desc: string };
    };
};