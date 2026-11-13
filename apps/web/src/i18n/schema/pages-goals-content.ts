export interface GoalsPageSchema {
    eyebrow: string;
    backToSettings: string;
    title: string;
    heroCopy: string;
    newGoal: string;
    stats: {
      totalGoals: string;
      totalGoalsDesc: string;
      activeOutcomes: string;
      activeOutcomesDesc: string;
      completedGoals: string;
      completedGoalsDesc: string;
      highPriority: string;
      highPriorityDesc: string;
    };
    searchPlaceholder: string;
    searchAria: string;
    clearSearch: string;
    tabs: {
      all: string;
      active: string;
      paused: string;
      completed: string;
    };
    filterByPriority: string;
    priorities: {
      all: string;
      high: string;
      normal: string;
      low: string;
    };
    priorityBadges: {
      high: string;
      normal: string;
      low: string;
    };
    showingGoals: string;
    assignedAgent: string;
    matchingQuery: string;
    table: {
      status: string;
      goalAndOutcome: string;
      progress: string;
      priority: string;
      dueDate: string;
      actions: string;
    };
    statusTooltips: {
      pause: string;
      resume: string;
      reactivate: string;
    };
    statuses: {
      active: string;
      paused: string;
      completed: string;
      cancelled: string;
    };
    editGoalTooltip: string;
    qualitativeGoal: string;
    overdue: string;
    actions: {
      done: string;
      markCompleted: string;
      reopen: string;
      reopenTitle: string;
      edit: string;
      editTitle: string;
      delete: string;
      deleteTitle: string;
    };
    empty: {
      noGoalsTitle: string;
      noGoalsDesc: string;
      createFirstGoal: string;
      noMatchingTitle: string;
      noMatchingDesc: string;
      clearFilters: string;
    };
    drawer: {
      kicker: string;
      editGoal: string;
      newGoal: string;
      close: string;
      objectiveSection: string;
      titleLabel: string;
      titlePlaceholder: string;
      descLabel: string;
      descPlaceholder: string;
      priorityStatusSection: string;
      priorityLabel: string;
      statusLabel: string;
      metricSection: string;
      metricHint: string;
      targetValueLabel: string;
      targetValuePlaceholder: string;
      currentValueLabel: string;
      currentValuePlaceholder: string;
      unitLabel: string;
      unitPlaceholder: string;
      dueDateSection: string;
      deadlineLabel: string;
      cancel: string;
      saving: string;
      saveChanges: string;
      createGoal: string;
    };
    notices: {
      failedToLoad: string;
      titleRequired: string;
      updatedSuccess: string;
      createdSuccess: string;
      failedToSave: string;
      deletedSuccess: string;
      failedToDelete: string;
      statusUpdated: string;
      statusUpdateError: string;
    };
    dialogs: {
      deleteTitle: string;
      deleteMessage: string;
      deleteConfirm: string;
      deleteCancel: string;
    };
};

export interface ContentPageSchema {
    eyebrow: string;
    backToSettings: string;
    title: string;
    heroCopy: string;
    newContentDraft: string;
    newContentPrompt: string;
    tabs: {
      all: string;
      articles: string;
      seoBlueprints: string;
      socialPosts: string;
      briefsPlans: string;
    };
    searchPlaceholder: string;
    searchAria: string;
    clearSearch: string;
    types: {
      article: string;
      seoBlueprint: string;
      socialMedia: string;
      briefPlan: string;
    };
    empty: {
      readyTitle: string;
      readyDesc: string;
      generateFirstDraft: string;
      chatPrompt: string;
      restoreDeleted: string;
      noMatchingTitle: string;
      noMatchingDesc: string;
      resetFilters: string;
      selectDoc: string;
    };
    cards: {
      listAria: string;
      deleteDocumentTitle: string;
      minRead: string;
    };
    viewer: {
      expand: string;
      collapse: string;
      expandTitle: string;
      collapseTitle: string;
      editDocument: string;
      views: {
        preview: string;
        previewTitle: string;
        raw: string;
        rawTitle: string;
      };
      actions: {
        edit: string;
        editTitle: string;
        delete: string;
        deleteTitle: string;
        copy: string;
        copied: string;
        copyTitle: string;
        download: string;
        downloadTitle: string;
        saveChanges: string;
        saveChangesTitle: string;
        cancel: string;
        cancelTitle: string;
      };
      metrics: {
        words: string;
        characters: string;
        readTime: string;
        generatedDate: string;
      };
      editor: {
        titleLabel: string;
        titlePlaceholder: string;
        typeLabel: string;
        bodyLabel: string;
        saveHint: string;
        bodyPlaceholder: string;
      };
      overlay: {
        expand: string;
        collapse: string;
      };
    };
    toast: {
      saved: string;
      saveError: string;
      deleted: string;
      deleteError: string;
    };
    dialogs: {
      deleteTitle: string;
      deleteMessage: string;
      deleteConfirm: string;
      deleteCancel: string;
      thisDocumentFallback: string;
    };
};