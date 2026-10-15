export interface ActivitySchema {
    eyebrow: string;
    title: string;
    backAria: string;
    heroCopy: string;
    stats: {
      totalRuns: string;
      totalRunsDesc: string;
      completed: string;
      completedDesc: string;
      inProgress: string;
      inProgressDesc: string;
      securityDecisions: string;
      securityDecisionsDesc: string;
    };
    controls: {
      companyLabel: string;
      all: string;
      completed: string;
      running: string;
      failed: string;
      searchPlaceholder: string;
      searchAriaLabel: string;
      clearSearch: string;
      refresh: string;
      refreshing: string;
      refreshTitle: string;
    };
    dispatch: {
      title: string;
      subtitle: string;
      modeLabel: string;
      modes: {
        auto: string;
        pipeline: string;
        single: string;
        fusion: string;
      };
      placeholderWithCompany: string;
      placeholderDefault: string;
      dispatchTask: string;
      dispatching: string;
      presetsLabel: string;
      presets: {
        marketAuditLabel: string;
        marketAuditPrompt: string;
        securityAuditLabel: string;
        securityAuditPrompt: string;
        growthRoadmapLabel: string;
        growthRoadmapPrompt: string;
      };
      dispatchedNotice: string;
      dispatchFailed: string;
    };
    empty: {
      noCompaniesTitle: string;
      noCompaniesCopy: string;
      createCompanyBtn: string;
      noRunsTitle: string;
      presetsTitle: string;
      noRunsCopy: string;
      presetsCopy: string;
      dispatchPresetBtn: string;
      viewTraceBtn: string;
    };
    sidebar: {
      recentExecutions: string;
      backToPresets: string;
      noFilteredRuns: string;
      clearFiltersBtn: string;
    };
    trace: {
      backToPresetsAria: string;
      modePrefix: string;
      comboPrefix: string;
      runIdLabel: string;
      copy: string;
      copied: string;
      copyRunIdTitle: string;
      startedLabel: string;
      completedLabel: string;
      durationLabel: string;
      finalOutput: string;
      copyResultTitle: string;
      executionFault: string;
      completionReportTitle: string;
      attemptSummary: string;
      timelineTitle: string;
      timelineDesc: string;
      attemptLabel: string;
      synchronousNotice: string;
      delegationTitle: string;
      delegationDesc: string;
      agentPrefix: string;
      modelPrefix: string;
      lanePrefix: string;
      noStepsNotice: string;
      toolsTitle: string;
      toolsDesc: string;
      policyReason: string;
      noToolsNotice: string;
      selectRunTitle: string;
      selectRunCopy: string;
    };
    errors: {
      loadRunsFailed: string;
      loadRunDetailsFailed: string;
    };
};