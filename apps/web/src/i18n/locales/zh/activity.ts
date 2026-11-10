import type { TranslationSchema } from "../../types";

export const activity = {
  "capabilityInspector": {
    "eyebrow": "治理与安全",
    "title": "能力检查器",
    "backAria": "返回设置",
    "modelProfiles": {
      "title": "模型配置：保守备用模式。",
      "emptyHint": "此上下文未启用任何 code.model_profile.<id> 标志，因此所有运行均使用保守配置（每次调用一个工具，自动检测工具调用支持），即使模型与 {{count}} 个注册配置之一匹配。请启用此部署允许的配置标志，以开始逐步启用。"
    },
    "heroCopy": "探索并审查 NPATI Agent 的 306 项标准能力。在实际运行环境中验证 Effective Capability Resolver 的边界、工具可见性和风险策略。",
    "stats": {
      "totalLabel": "项能力总数",
      "totalDesc": "已验证的标准 ID 1..306",
      "agentCallableLabel": "可供智能体调用",
      "agentCallableDesc": "通过 Resolver 向模型提供",
      "runtimeOnlyLabel": "内部运行环境",
      "runtimeOnlyDesc": "隔离的引擎操作",
      "requiresApprovalLabel": "需要批准",
      "requiresApprovalDesc": "人工参与的安全检查"
    },
    "slices": {
      "all": "全部",
      "agentCallable": "智能体可调用",
      "runtimeOnly": "仅运行环境",
      "userVisible": "用户可见",
      "automatic": "自动",
      "allowed": "已允许",
      "requiresApproval": "需要批准"
    },
    "controls": {
      "searchPlaceholder": "按名称、ID 或领域筛选能力…",
      "searchAriaLabel": "筛选能力",
      "clearSearch": "清除搜索",
      "showing": "显示 {{start}}–{{end}} / {{total}} 项能力",
      "matching": "匹配“{{term}}”",
      "copied": "✓ 已复制 {{id}}",
      "perPage": "每页：",
      "allCount": "全部（{{total}}）"
    },
    "table": {
      "colId": "ID",
      "sortId": "按 ID 排序",
      "colName": "名称",
      "sortName": "按名称排序",
      "colCanonicalId": "标准 ID",
      "sortCanonicalId": "按标准 ID 排序",
      "colDomain": "领域",
      "sortDomain": "按领域排序",
      "colType": "类型",
      "sortType": "按类型排序",
      "colCallable": "可调用",
      "colRisk": "风险",
      "sortRisk": "按风险排序",
      "colStatus": "状态",
      "sortStatus": "按状态排序",
      "copyTooltip": "点击复制标准 ID",
      "empty": "没有符合所选筛选条件的能力。",
      "prev": "← 上一页",
      "next": "下一页 →"
    },
    "callable": {
      "callable": "可调用",
      "internal": "内部"
    },
    "risks": {
      "low": "低",
      "medium": "中",
      "high": "高",
      "critical": "严重"
    },
    "statuses": {
      "verified": "已验证",
      "partial": "部分",
      "notImplemented": "未实现",
      "blocked": "已阻止",
      "allowed": "已允许",
      "denied": "已拒绝",
      "unavailable": "不可用",
      "requiresApproval": "需批准"
    },
    "types": {
      "runtime": "运行环境",
      "config": "配置",
      "orchestr": "协调",
      "tool": "工具",
      "article": "文章",
      "secOps": "安全运维"
    },
    "connectedServices": "已连接的服务",
    "errorLoad": "无法加载能力",
    "integrations": {
      "kicker": "已验证的产品集成",
      "title": "已实现的消息渠道",
      "manage": "管理集成",
      "sharedRuntime": "共享 NPATI Agent 运行环境",
      "loading": "正在加载集成状态…",
      "notice": "连接 Agent API 后可查看集成状态。"
    }
  },
  "activity": {
    "eyebrow": "可观测性与审计",
    "title": "活动与运行跟踪",
    "backAria": "返回设置",
    "heroCopy": "实时详细查看公司智能体运行中的执行跟踪、委派步骤、工具调用、延迟与安全决策。",
    "stats": {
      "totalRuns": "运行总数",
      "totalRunsDesc": "已记录的智能体执行",
      "completed": "已完成",
      "completedDesc": "成功且无故障",
      "inProgress": "进行中 / 已排队",
      "inProgressDesc": "活跃智能体任务",
      "securityDecisions": "安全决策",
      "securityDecisionsDesc": "已审计的工具检查"
    },
    "controls": {
      "companyLabel": "公司：",
      "all": "全部",
      "completed": "已完成",
      "running": "运行中",
      "failed": "失败",
      "searchPlaceholder": "按任务或 ID 搜索运行…",
      "searchAriaLabel": "搜索运行",
      "clearSearch": "清除搜索",
      "refresh": "刷新",
      "refreshing": "正在刷新…",
      "refreshTitle": "刷新运行"
    },
    "dispatch": {
      "title": "分派公司智能体任务",
      "subtitle": "触发自主多智能体任务执行，并查看实时跟踪",
      "modeLabel": "执行模式：",
      "modes": {
        "auto": "自动协调（自适应）",
        "pipeline": "流水线（多智能体）",
        "single": "单智能体（快速）",
        "fusion": "融合（多模型）"
      },
      "placeholderWithCompany": "输入 {{name}} 智能体的任务（例如“分析竞争对手的产品与定价”）…",
      "placeholderDefault": "输入公司智能体任务提示…",
      "dispatchTask": "分派任务",
      "dispatching": "正在分派…",
      "presetsLabel": "预设：",
      "presets": {
        "marketAuditLabel": "市场与竞争对手审查",
        "marketAuditPrompt": "全面研究竞争对手并分析市场定位",
        "securityAuditLabel": "安全与能力验证",
        "securityAuditPrompt": "审查公司工具权限、API 访问规则和安全检查",
        "growthRoadmapLabel": "战略增长路线图",
        "growthRoadmapPrompt": "综合理想客户画像，并制定可执行的 90 天增长路线图"
      },
      "dispatchedNotice": "运行已分派：{{id}}（{{status}}）",
      "dispatchFailed": "无法分派智能体运行"
    },
    "empty": {
      "noCompaniesTitle": "未找到公司",
      "noCompaniesCopy": "活动与运行跟踪用于追踪 AI 公司上下文中分派的多智能体运行。",
      "createCompanyBtn": "创建 AI 公司",
      "noRunsTitle": "尚无运行记录",
      "presetsTitle": "任务预设与入门场景",
      "noRunsCopy": "此公司尚未分派智能体运行。使用上方任务分派器或选择预设，以生成实时执行跟踪、委派步骤和工具安全审计。",
      "presetsCopy": "选择下方预设或在上方输入自定义任务，以生成实时执行跟踪、委派步骤和工具安全审计。",
      "dispatchPresetBtn": "分派：{{label}} →",
      "viewTraceBtn": "查看执行历史与跟踪（{{count}}）→"
    },
    "sidebar": {
      "recentExecutions": "最近执行（{{count}}）",
      "backToPresets": "← 3 个预设",
      "noFilteredRuns": "没有符合当前筛选条件的运行。",
      "clearFiltersBtn": "清除筛选"
    },
    "trace": {
      "backToPresetsAria": "返回预设",
      "modePrefix": "模式：{{mode}}",
      "comboPrefix": "组合：{{name}}",
      "runIdLabel": "运行 ID：",
      "copy": "复制",
      "copied": "已复制",
      "copyRunIdTitle": "复制运行 ID",
      "startedLabel": "开始时间：",
      "completedLabel": "完成时间：",
      "durationLabel": "耗时：",
      "finalOutput": "最终输出结果",
      "copyResultTitle": "复制结果",
      "executionFault": "执行故障",
      "completionReportTitle": "后台完成报告",
      "attemptSummary": "第 {{attempt}} 次尝试 · {{tokens}} 个令牌 · ${{cost}} · {{duration}} 秒",
      "timelineTitle": "后台执行时间线（{{count}}）",
      "timelineDesc": "持久工作进程任务领取、重试和最终完成事件",
      "attemptLabel": "第 {{attempt}} 次尝试",
      "synchronousNotice": "此运行以同步方式执行，未产生后台工作进程事件。",
      "delegationTitle": "智能体委派流水线（{{count}}）",
      "delegationDesc": "多智能体角色协调与任务交接",
      "agentPrefix": "智能体：{{id}}",
      "modelPrefix": "模型：",
      "lanePrefix": "通道：{{lane}}",
      "noStepsNotice": "此单轮任务未记录委派步骤。",
      "toolsTitle": "工具执行与安全策略检查（{{count}}）",
      "toolsDesc": "标准能力解析器检查与安全审计",
      "policyReason": "策略原因：",
      "noToolsNotice": "此次运行未触发外部工具调用。",
      "selectRunTitle": "选择要检查的运行",
      "selectRunCopy": "从左侧面板选择运行，以查看其时间线、委派步骤和安全审计。"
    },
    "errors": {
      "loadRunsFailed": "无法加载活动",
      "loadRunDetailsFailed": "无法加载运行详情"
    }
  },
  "automations": {
    "eyebrow": "设置 · 自动化",
    "title": "自动化与计划任务",
    "backAria": "返回设置",
    "heroCopy": "为公司配置周期性后台触发器、定期 cron 作业和自主智能体任务。",
    "selectCompanyAria": "选择公司",
    "newAutomationBtn": "+ 新建自动化",
    "stats": {
      "total": "个自动化总数",
      "totalDesc": "已计划的 AI 后台作业",
      "active": "个活跃触发器",
      "activeDesc": "正在运行的 cron 计划",
      "paused": "个已暂停计划",
      "pausedDesc": "待机 / 未启用的触发器",
      "assignedAgents": "个已分配智能体",
      "assignedAgentsDesc": "已配置的智能体执行器"
    },
    "controls": {
      "searchPlaceholder": "按名称、描述、提示、cron 筛选…",
      "searchAriaLabel": "筛选自动化",
      "clearSearch": "清除搜索",
      "tabAll": "全部",
      "tabActive": "启用",
      "tabPaused": "已暂停"
    },
    "showingStatus": "显示 {{count}} / {{total}} 个自动化",
    "matchingQuery": "匹配“{{query}}”",
    "empty": {
      "noAutomationsTitle": "尚未配置自动化",
      "noAutomationsDesc": "为此公司安排自主 cron 后台任务、定期市场审查或每日智能体工作流。",
      "createFirstBtn": "+ 创建首个自动化",
      "noMatchingTitle": "没有匹配的自动化",
      "noMatchingDesc": "尝试调整搜索词或状态筛选以找到所需内容。",
      "clearFiltersBtn": "清除筛选"
    },
    "table": {
      "colStatus": "状态",
      "colTask": "任务与指令",
      "colSchedule": "计划（Cron）",
      "colAssignedAgent": "已分配的智能体",
      "colActions": "操作",
      "statusActive": "已启用",
      "statusPaused": "已暂停",
      "clickToPause": "点击暂停",
      "clickToActivate": "点击启用",
      "promptPrefix": "提示：",
      "nextRunPrefix": "下次运行：",
      "mainAgent": "主智能体",
      "runNow": "▶ 立即运行",
      "running": "正在运行…",
      "runNowTitle": "立即运行此自动化",
      "history": "历史",
      "historyTitle": "查看运行执行历史",
      "edit": "编辑",
      "editTitle": "编辑自动化设置",
      "delete": "删除",
      "deleteTitle": "删除自动化"
    },
    "presets": {
      "daily9": "每天 09:00",
      "daily18": "每天 18:00",
      "mondays9": "每周一 09:00",
      "fridays17": "每周五 17:00",
      "hourly": "每小时",
      "daily0": "每天 00:00"
    },
    "editor": {
      "kicker": "自动化",
      "editTitle": "编辑自动化",
      "newTitle": "新自动化",
      "taskParamsHeading": "任务参数",
      "taskNameLabel": "任务名称",
      "taskNamePlaceholder": "例如：每日竞争对手分析",
      "descLabel": "描述",
      "descPlaceholder": "此自动化要完成的内容",
      "assignedAgentLabel": "已分配的智能体",
      "mainAgentDefault": "主智能体（默认）",
      "schedulePresetsLabel": "计划预设",
      "cronExpressionLabel": "Cron 表达式（5 个字段：分 时 日 月 星期）",
      "cronPlaceholder": "0 9 * * *",
      "agentPromptLabel": "智能体提示",
      "agentPromptPlaceholder": "描述智能体应执行的具体目标和步骤…",
      "saveBtn": "保存自动化",
      "savingBtn": "正在保存…",
      "deleteBtn": "删除",
      "cancelBtn": "取消"
    },
    "history": {
      "kicker": "运行历史",
      "loading": "正在加载运行历史…",
      "noRuns": "尚无运行记录。",
      "duration": "耗时：",
      "finalResult": "✓ 最终结果：",
      "error": "错误："
    },
    "dialogs": {
      "deleteTitle": "删除自动化？",
      "deleteMessage": "确定要删除此自动化吗？",
      "deleteConfirm": "删除",
      "deleteCancel": "取消"
    },
    "notifications": {
      "runInitiated": "已启动“{{name}}”运行。",
      "resultReceived": "已收到结果！",
      "runError": "运行错误：{{error}}"
    }
  }
} satisfies Pick<TranslationSchema, "capabilityInspector" | "activity" | "automations">;
