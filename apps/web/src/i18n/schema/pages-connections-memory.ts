export interface ConnectionsPageSchema {
    eyebrow: string;
    backToSettings: string;
    title: string;
    heroCopy: string;
    refreshStatus: string;
    checkingStatus: string;
    refreshTitle: string;
    lastSuccessfulCheck: string;
    noSuccessfulCheck: string;
    checkFailed: string;
    searchPlaceholder: string;
    searchAria: string;
    clearSearch: string;
    tabs: {
      all: string;
      internal: string;
      storage: string;
      provider: string;
      operational: string;
    };
    categories: {
      internal: string;
      storage: string;
      provider: string;
    };
    statuses: {
      operational: string;
      standby: string;
      degraded: string;
      down: string;
    };
    empty: {
      title: string;
      description: string;
      resetFilters: string;
    };
    card: {
      copy: string;
      copied: string;
      copyTitle: string;
      verifiedFallback: string;
      protocol: string;
    };
    services: {
      omniroute: {
        name: string;
        desc: string;
        details: string;
        versionPrefix: string;
      };
      postgres: {
        name: string;
        desc: string;
        details: string;
      };
      redis: {
        name: string;
        desc: string;
        details: string;
      };
      minio: {
        name: string;
        desc: string;
        details: string;
      };
      crawler: {
        name: string;
        desc: string;
        details: string;
      };
      coreBackend: {
        name: string;
        desc: string;
        details: string;
      };
      cloudHub: {
        name: string;
        desc: string;
        details: string;
      };
    };
};

export interface MemoryPageSchema {
    eyebrow: string;
    backToSettings: string;
    title: string;
    heroCopy: string;
    addFactBtn: string;
    addFactTitle: string;
    searchPlaceholder: string;
    searchAria: string;
    clearSearch: string;
    tabs: {
      all: string;
      facts: string;
      audience: string;
      brand: string;
      decisions: string;
      product: string;
      other: string;
    };
    types: {
      business_fact: string;
      audience: string;
      brand: string;
      decision: string;
      product: string;
      channel: string;
      preference: string;
      experiment: string;
      result: string;
      other: string;
    };
    sources: {
      manual: string;
      chatConfirmed: string;
      onboarding: string;
      userVerified: string;
      sourcePrefix: string;
    };
    empty: {
      title: string;
      description: string;
      addFirstBtn: string;
    };
    emptyFiltered: {
      title: string;
      description: string;
      resetFilters: string;
    };
    card: {
      verified: string;
      confidenceTooltip: string;
      copy: string;
      copied: string;
      copyTitle: string;
      edit: string;
      editTitle: string;
      delete: string;
      deleteTitle: string;
      deleteFactTitle: string;
    };
    drawer: {
      eyebrow: string;
      editTitle: string;
      newTitle: string;
      closeAria: string;
      categorySection: string;
      typeLabel: string;
      types: {
        businessFact: string;
        audience: string;
        brand: string;
        decision: string;
        product: string;
        channel: string;
        preference: string;
        experiment: string;
        result: string;
        other: string;
      };
      detailsSection: string;
      titleLabel: string;
      titlePlaceholder: string;
      contentLabel: string;
      contentPlaceholder: string;
      confidenceSection: string;
      confidenceLabel: string;
      confidenceOptions: {
        high100: string;
        med80: string;
        low50: string;
      };
      cancel: string;
      saving: string;
      saveChanges: string;
      saveFact: string;
      errors: {
        titleRequired: string;
        contentRequired: string;
        saveFailed: string;
      };
      defaultBusinessName: string;
    };
    toasts: {
      copied: string;
      updated: string;
      saved: string;
      deleted: string;
      deleteError: string;
    };
    dialogs: {
      deleteTitle: string;
      deleteMessage: string;
      deleteConfirm: string;
      deleteCancel: string;
    };
};

export interface SkillsPageSchema {
    eyebrow: string;
    backToSettings: string;
    title: string;
    heroCopy: string;
    badgeBuiltin: string;
    stats: {
      availableSkills: string;
      availableSkillsDesc: string;
      capabilities: string;
      capabilitiesDesc: string;
      autoValue: string;
      skillSelection: string;
      skillSelectionDesc: string;
    };
    searchPlaceholder: string;
    searchAria: string;
    clearSearch: string;
    statusShowing: {
      showing: string;
      of: string;
      skills: string;
    };
    errorLoading: string;
    empty: {
      title: string;
      description: string;
      clearSearch: string;
    };
    card: {
      available: string;
      builtinType: string;
    };
    skills: {
      competitorAnalysis: {
        name: string;
        desc: string;
      };
      webResearch: {
        name: string;
        desc: string;
      };
      businessStartup: {
        name: string;
        desc: string;
      };
      businessGrowth: {
        name: string;
        desc: string;
      };
      sellProduct: {
        name: string;
        desc: string;
      };
    };
};