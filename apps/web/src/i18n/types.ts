export type SupportedLanguage =
  | "en" | "uk" | "de" | "fr" | "es" | "it" | "pl"
  | "pt" | "nl" | "tr" | "ru" | "zh" | "ja" | "ko" | "ar" | "hi";

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
  { code: "pt", name: "Portuguese", nativeName: "Português", flag: "🇵🇹" },
  { code: "nl", name: "Dutch", nativeName: "Nederlands", flag: "🇳🇱" },
  { code: "tr", name: "Turkish", nativeName: "Türkçe", flag: "🇹🇷" },
  { code: "ru", name: "Russian", nativeName: "Русский", flag: "🇷🇺" },
  { code: "zh", name: "Chinese", nativeName: "中文", flag: "🇨🇳" },
  { code: "ja", name: "Japanese", nativeName: "日本語", flag: "🇯🇵" },
  { code: "ko", name: "Korean", nativeName: "한국어", flag: "🇰🇷" },
  { code: "ar", name: "Arabic", nativeName: "العربية", flag: "🇸🇦" },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी", flag: "🇮🇳" },
];


import type {
  ProjectSectionSchema,
  CommonSchema,
  NavSchema,
  SidebarSchema,
  DialogsSchema,
  ChatSchema,
  UserMenuSchema,
  SettingsSchema,
  HomeSchema,
  AiMarketplaceSchema,
  BusinessSettingsSchema,
  CompanySettingsSchema,
  ActivitySchema,
  AutomationsSchema,
  EmailSettingsSchema,
  EmailInboxSchema,
  GoalsPageSchema,
  ContentPageSchema,
  ConnectionsPageSchema,
  MemoryPageSchema,
  SkillsPageSchema,
  IntegrationsPageSchema,
  CodeMetricsSchema,
} from "./schema";

export * from "./schema";

export interface TranslationSchema {
  executionTrace: Record<string, string>;
  projectSection: ProjectSectionSchema;
  common: CommonSchema;
  nav: NavSchema;
  sidebar: SidebarSchema;
  dialogs: DialogsSchema;
  chat: ChatSchema;
  userMenu: UserMenuSchema;
  settings: SettingsSchema;
  home: HomeSchema;
  aiMarketplace: AiMarketplaceSchema;
  businessSettings: BusinessSettingsSchema;
  companySettings: CompanySettingsSchema;
  capabilityInspector: {
    eyebrow: string;
    title: string;
    backAria: string;
    heroCopy: string;
    /**
     * C14 (owner decision 2): the model-profile fallback warning. `emptyHint` takes `{{count}}` — the number of
     * profiles in the registry that no `code.model_profile.<id>` flag has enabled.
     */
    modelProfiles: {
      title: string;
      emptyHint: string;
    };
    stats: {
      totalLabel: string;
      totalDesc: string;
      agentCallableLabel: string;
      agentCallableDesc: string;
      runtimeOnlyLabel: string;
      runtimeOnlyDesc: string;
      requiresApprovalLabel: string;
      requiresApprovalDesc: string;
    };
    slices: {
      all: string;
      agentCallable: string;
      runtimeOnly: string;
      userVisible: string;
      automatic: string;
      allowed: string;
      requiresApproval: string;
    };
    controls: {
      searchPlaceholder: string;
      searchAriaLabel: string;
      clearSearch: string;
      showing: string;
      matching: string;
      copied: string;
      perPage: string;
      allCount: string;
    };
    table: {
      colId: string;
      sortId: string;
      colName: string;
      sortName: string;
      colCanonicalId: string;
      sortCanonicalId: string;
      colDomain: string;
      sortDomain: string;
      colType: string;
      sortType: string;
      colCallable: string;
      colRisk: string;
      sortRisk: string;
      colStatus: string;
      sortStatus: string;
      copyTooltip: string;
      empty: string;
      prev: string;
      next: string;
    };
    callable: {
      callable: string;
      internal: string;
    };
    risks: {
      low: string;
      medium: string;
      high: string;
      critical: string;
    };
    statuses: {
      verified: string;
      partial: string;
      notImplemented: string;
      blocked: string;
      allowed: string;
      denied: string;
      unavailable: string;
      requiresApproval: string;
    };
    types: {
      runtime: string;
      config: string;
      orchestr: string;
      tool: string;
      article: string;
      secOps: string;
    };
    connectedServices: string;
    errorLoad: string;
    integrations: {
      kicker: string;
      title: string;
      manage: string;
      sharedRuntime: string;
      loading: string;
      notice: string;
    };
  };
  activity: ActivitySchema;
  automations: AutomationsSchema;
  emailSettings: EmailSettingsSchema;
  emailInbox: EmailInboxSchema;
  goalsPage: GoalsPageSchema;
  contentPage: ContentPageSchema;
  connectionsPage: ConnectionsPageSchema;
  memoryPage: MemoryPageSchema;
  skillsPage: SkillsPageSchema;
  integrationsPage: IntegrationsPageSchema;
  codeInbox: { completion: string; workspace: string; accepted: string; title: string; queue: string; steer: string; textOnly: string; dispatchError: string; idle: string; reserved: string; running: string; sealed: string; settled: string; pending: string; claimed: string; };
  codeMetrics: CodeMetricsSchema;
}
