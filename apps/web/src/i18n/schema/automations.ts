export interface AutomationsSchema {
    eyebrow: string;
    title: string;
    backAria: string;
    heroCopy: string;
    selectCompanyAria: string;
    newAutomationBtn: string;
    stats: {
      total: string;
      totalDesc: string;
      active: string;
      activeDesc: string;
      paused: string;
      pausedDesc: string;
      assignedAgents: string;
      assignedAgentsDesc: string;
    };
    controls: {
      searchPlaceholder: string;
      searchAriaLabel: string;
      clearSearch: string;
      tabAll: string;
      tabActive: string;
      tabPaused: string;
    };
    showingStatus: string;
    matchingQuery: string;
    empty: {
      noAutomationsTitle: string;
      noAutomationsDesc: string;
      createFirstBtn: string;
      noMatchingTitle: string;
      noMatchingDesc: string;
      clearFiltersBtn: string;
    };
    table: {
      colStatus: string;
      colTask: string;
      colSchedule: string;
      colAssignedAgent: string;
      colActions: string;
      statusActive: string;
      statusPaused: string;
      clickToPause: string;
      clickToActivate: string;
      promptPrefix: string;
      nextRunPrefix: string;
      mainAgent: string;
      runNow: string;
      running: string;
      runNowTitle: string;
      history: string;
      historyTitle: string;
      edit: string;
      editTitle: string;
      delete: string;
      deleteTitle: string;
    };
    presets: {
      daily9: string;
      daily18: string;
      mondays9: string;
      fridays17: string;
      hourly: string;
      daily0: string;
    };
    editor: {
      kicker: string;
      editTitle: string;
      newTitle: string;
      taskParamsHeading: string;
      taskNameLabel: string;
      taskNamePlaceholder: string;
      descLabel: string;
      descPlaceholder: string;
      assignedAgentLabel: string;
      mainAgentDefault: string;
      schedulePresetsLabel: string;
      cronExpressionLabel: string;
      cronPlaceholder: string;
      agentPromptLabel: string;
      agentPromptPlaceholder: string;
      saveBtn: string;
      savingBtn: string;
      deleteBtn: string;
      cancelBtn: string;
    };
    history: {
      kicker: string;
      loading: string;
      noRuns: string;
      duration: string;
      finalResult: string;
      error: string;
    };
    dialogs: {
      deleteTitle: string;
      deleteMessage: string;
      deleteConfirm: string;
      deleteCancel: string;
    };
    notifications: {
      runInitiated: string;
      resultReceived: string;
      runError: string;
    };
};