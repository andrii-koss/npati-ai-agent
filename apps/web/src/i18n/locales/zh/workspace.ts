import type { TranslationSchema } from "../../types";

export const workspace = {
  "goalsPage": {
    "eyebrow": "设置 · 目标",
    "backToSettings": "返回设置",
    "title": "目标与任务",
    "heroCopy": "定义可衡量的成果、指标目标和优先里程碑，使自主 AI 智能体与目标保持一致。",
    "newGoal": "+ 新建目标",
    "stats": {
      "totalGoals": "个目标总数",
      "totalGoalsDesc": "已定义的业务目标",
      "activeOutcomes": "个进行中的成果",
      "activeOutcomesDesc": "智能体当前优先事项",
      "completedGoals": "个已完成目标",
      "completedGoalsDesc": "已达成的里程碑",
      "highPriority": "高优先级",
      "highPriorityDesc": "关键 P1 目标"
    },
    "searchPlaceholder": "按标题、描述或指标单位筛选目标…",
    "searchAria": "筛选目标",
    "clearSearch": "清除搜索",
    "tabs": {
      "all": "全部",
      "active": "启用",
      "paused": "已暂停",
      "completed": "已完成"
    },
    "filterByPriority": "按优先级筛选",
    "priorities": {
      "all": "所有优先级",
      "high": "高优先级（P1）",
      "normal": "普通优先级（P2）",
      "low": "低优先级（P3）"
    },
    "priorityBadges": {
      "high": "高 P1",
      "normal": "普通 P2",
      "low": "低 P3"
    },
    "showingGoals": "显示 {count} / {total} 个目标",
    "matchingQuery": " 匹配“{query}”",
    "table": {
      "status": "状态",
      "goalAndOutcome": "目标与成果",
      "progress": "进度",
      "priority": "优先级",
      "dueDate": "截止日期",
      "actions": "操作"
    },
    "statusTooltips": {
      "pause": "点击暂停",
      "resume": "点击恢复",
      "reactivate": "点击重新启用"
    },
    "statuses": {
      "active": "已启用",
      "paused": "已暂停",
      "completed": "已完成",
      "cancelled": "已取消"
    },
    "editGoalTooltip": "点击编辑目标",
    "qualitativeGoal": "定性目标",
    "overdue": "已逾期",
    "actions": {
      "done": "✓ 完成",
      "markCompleted": "将目标标记为已完成",
      "reopen": "重新打开",
      "reopenTitle": "重新打开目标",
      "edit": "编辑",
      "editTitle": "编辑目标参数",
      "delete": "删除",
      "deleteTitle": "删除目标"
    },
    "empty": {
      "noGoalsTitle": "尚未配置目标",
      "noGoalsDesc": "定义具体业务成果、指标目标或战略里程碑，让 NPATI 智能体在自主执行和聊天建议中优先考虑。",
      "createFirstGoal": "+ 创建首个目标",
      "noMatchingTitle": "没有匹配的目标",
      "noMatchingDesc": "尝试调整搜索词或筛选条件，以找到所需内容。",
      "clearFilters": "清除筛选"
    },
    "drawer": {
      "kicker": "目标",
      "editGoal": "编辑目标",
      "newGoal": "新目标",
      "close": "关闭",
      "objectiveSection": "目标内容",
      "titleLabel": "目标标题 *",
      "titlePlaceholder": "例如：获得首批 100 位付费客户",
      "descLabel": "描述 / 成功标准",
      "descPlaceholder": "成功意味着什么？智能体要争取哪些具体成果？",
      "priorityStatusSection": "优先级与状态",
      "priorityLabel": "优先级",
      "statusLabel": "状态",
      "metricSection": "指标跟踪（可选）",
      "metricHint": "如果此目标可以量化衡量和跟踪，请指定数值目标。",
      "targetValueLabel": "目标值",
      "targetValuePlaceholder": "例如：100",
      "currentValueLabel": "当前值",
      "currentValuePlaceholder": "例如：42",
      "unitLabel": "单位",
      "unitPlaceholder": "例如：美元、用户、%",
      "dueDateSection": "目标截止日期",
      "deadlineLabel": "里程碑截止日期",
      "cancel": "取消",
      "saving": "正在保存…",
      "saveChanges": "保存目标更改",
      "createGoal": "创建目标"
    },
    "notices": {
      "failedToLoad": "无法加载目标：{message}",
      "titleRequired": "需要填写目标标题",
      "updatedSuccess": "目标“{title}”已成功更新。",
      "createdSuccess": "目标“{title}”已成功创建。",
      "failedToSave": "无法保存目标：{message}",
      "deletedSuccess": "目标“{title}”已删除。",
      "failedToDelete": "无法删除目标：{message}",
      "statusUpdated": "目标“{title}”状态已更新为 {status}。",
      "statusUpdateError": "状态更新错误：{message}"
    },
    "dialogs": {
      "deleteTitle": "删除目标？",
      "deleteMessage": "确定要删除目标“{title}”吗？",
      "deleteConfirm": "删除",
      "deleteCancel": "取消"
    }
  },
  "contentPage": {
    "eyebrow": "设置 · 内容中心",
    "backToSettings": "返回设置",
    "title": "内容中心与制作库",
    "heroCopy": "查看、编辑、排版和导出自主智能体生成的文章、SEO 方案与社交草稿。",
    "newContentDraft": "+ 新建内容草稿",
    "newContentPrompt": "为我们的目标受众起草有影响力的营销文章和社交传播计划。",
    "tabs": {
      "all": "所有条目",
      "articles": "文章",
      "seoBlueprints": "SEO 方案",
      "socialPosts": "社交帖子",
      "briefsPlans": "简报与计划"
    },
    "searchPlaceholder": "搜索草稿、关键词、主题…",
    "searchAria": "搜索内容库",
    "clearSearch": "清除搜索",
    "types": {
      "article": "文章",
      "seoBlueprint": "SEO 方案",
      "socialMedia": "社交媒体",
      "briefPlan": "简报与计划"
    },
    "empty": {
      "readyTitle": "您的 AI 内容库已就绪",
      "readyDesc": "公司自主智能体执行内容简报、关键词研究或文章创建任务后，所有生成的制作草稿将整理在此处。",
      "generateFirstDraft": "+ 在聊天中生成首份草稿",
      "chatPrompt": "起草面向我们理想客户画像的 SEO 博文，包含关键要点和常见问题。",
      "restoreDeleted": "恢复已删除文档",
      "noMatchingTitle": "没有匹配的文档",
      "noMatchingDesc": "尝试调整搜索词或选择其他内容类型筛选。",
      "resetFilters": "重置筛选",
      "selectDoc": "从左侧选择文档以阅读或导出。"
    },
    "cards": {
      "listAria": "生成的文档列表",
      "deleteDocumentTitle": "删除文档",
      "minRead": "阅读约需 {count} 分钟"
    },
    "viewer": {
      "expand": "展开",
      "collapse": "折叠",
      "expandTitle": "展开以阅读完整文档",
      "collapseTitle": "折叠为标准视图",
      "editDocument": "编辑文档",
      "views": {
        "preview": "预览",
        "previewTitle": "格式化阅读视图",
        "raw": "原始 .md",
        "rawTitle": "原始 Markdown 源码"
      },
      "actions": {
        "edit": "✎ 编辑",
        "editTitle": "编辑文档正文、标题和类别",
        "delete": "🗑 删除",
        "deleteTitle": "删除此文档",
        "copy": "复制",
        "copied": "✓ 已复制！",
        "copyTitle": "将 Markdown 内容复制到剪贴板",
        "download": "下载 .md",
        "downloadTitle": "下载为 Markdown 文件",
        "saveChanges": "✓ 保存更改",
        "saveChangesTitle": "保存您的更改",
        "cancel": "取消",
        "cancelTitle": "取消编辑"
      },
      "metrics": {
        "words": "字词",
        "characters": "字符",
        "readTime": "阅读时间",
        "generatedDate": "生成日期"
      },
      "editor": {
        "titleLabel": "文档标题",
        "titlePlaceholder": "输入文档标题…",
        "typeLabel": "内容类型",
        "bodyLabel": "文档正文（Markdown）",
        "saveHint": "按 Ctrl+S 保存",
        "bodyPlaceholder": "在此编写或编辑 Markdown 文档正文…"
      },
      "overlay": {
        "expand": "展开以阅读完整文档",
        "collapse": "折叠为标准视图"
      }
    },
    "toast": {
      "saved": "更改已成功保存！",
      "saveError": "无法保存更改",
      "deleted": "文档已删除",
      "deleteError": "无法删除文档"
    },
    "dialogs": {
      "deleteTitle": "删除内容？",
      "deleteMessage": "确定要删除“{title}”吗？",
      "deleteConfirm": "删除",
      "deleteCancel": "取消",
      "thisDocumentFallback": "此文档"
    }
  },
  "connectionsPage": {
    "eyebrow": "基础设施与集成",
    "backToSettings": "返回设置",
    "title": "已连接的服务",
    "heroCopy": "监控所有存储引擎、内部 AI 适配器和系统微服务的运行健康状态、端点和状态。",
    "refreshStatus": "刷新状态",
    "checkingStatus": "正在检查状态…",
    "refreshTitle": "探测服务健康端点",
    "lastSuccessfulCheck": "上次成功检查：{{time}}",
    "noSuccessfulCheck": "尚无成功检查",
    "checkFailed": "健康检查失败 — 服务不可用",
    "searchPlaceholder": "按名称、端点或类别筛选服务…",
    "searchAria": "筛选已连接服务",
    "clearSearch": "清除搜索",
    "tabs": {
      "all": "全部",
      "internal": "内部",
      "storage": "存储",
      "provider": "提供商",
      "operational": "正常运行"
    },
    "categories": {
      "internal": "内部引擎",
      "storage": "数据存储",
      "provider": "云提供商"
    },
    "statuses": {
      "operational": "正常运行",
      "standby": "待机",
      "degraded": "性能下降",
      "down": "已停止"
    },
    "empty": {
      "title": "没有匹配的服务",
      "description": "尝试调整搜索词或选择其他类别筛选。",
      "resetFilters": "重置筛选"
    },
    "card": {
      "copy": "复制",
      "copied": "✓ 已复制",
      "copyTitle": "复制连接字符串",
      "verifiedFallback": "已在 Docker 网络中验证",
      "protocol": "HTTP / TCP"
    },
    "services": {
      "omniroute": {
        "name": "NPATI AI 路由",
        "desc": "A2A 协调、组合路由、融合、流水线和嵌入引擎（v3.8.52）。",
        "details": "v3.8.52 核心",
        "versionPrefix": "版本"
      },
      "postgres": {
        "name": "带 pgvector 的 PostgreSQL",
        "desc": "工作区、公司、知识片段和向量嵌入的唯一可信数据源。",
        "details": "向量扩展已启用"
      },
      "redis": {
        "name": "Redis 缓存与流",
        "desc": "异步任务队列、租约、分布式锁和对话记忆缓存。",
        "details": "内存缓存已启用"
      },
      "minio": {
        "name": "MinIO S3 存储",
        "desc": "按租户隔离的文档存储，用于公司知识附件和二进制资源。",
        "details": "兼容 S3 的 API"
      },
      "crawler": {
        "name": "Crawl4AI 网页爬虫",
        "desc": "用于深度网络研究的爬虫、Markdown 转换和 SSR 渲染引擎。",
        "details": "无头工作进程池"
      },
      "coreBackend": {
        "name": "NPATI 核心后端",
        "desc": "身份验证、用户账户和计费的唯一可信数据源。",
        "details": "API 网关已启用"
      },
      "cloudHub": {
        "name": "NPATI 云中心",
        "desc": "可选的云目录同步和共享模型注册表。",
        "details": "本地部署可选"
      }
    }
  },
  "memoryPage": {
    "eyebrow": "业务上下文与知识",
    "backToSettings": "返回设置",
    "title": "业务记忆",
    "heroCopy": "维护 NPATI Agent 在所有聊天和任务中使用的持久事实、已验证受众档案、品牌语气规则和战略决策。",
    "addFactBtn": "+ 添加记忆事实",
    "addFactTitle": "添加新的业务事实或决策",
    "searchPlaceholder": "按关键词、标题、事实内容或来源搜索记忆…",
    "searchAria": "筛选记忆条目",
    "clearSearch": "清除搜索",
    "tabs": {
      "all": "所有条目",
      "facts": "业务事实",
      "audience": "受众与理想客户画像",
      "brand": "品牌与语气",
      "decisions": "决策与策略",
      "product": "产品与服务",
      "other": "其他"
    },
    "types": {
      "business_fact": "业务事实",
      "audience": "受众与理想客户画像",
      "brand": "品牌与语气",
      "decision": "战略决策",
      "product": "产品与服务",
      "channel": "营销渠道",
      "preference": "用户偏好",
      "experiment": "实验",
      "result": "结果与指标",
      "other": "其他知识"
    },
    "sources": {
      "manual": "手动",
      "chatConfirmed": "聊天已确认",
      "onboarding": "入门设置",
      "userVerified": "用户已验证",
      "sourcePrefix": "来源"
    },
    "empty": {
      "title": "尚无持久记忆条目",
      "description": "添加关于业务、目标受众、品牌语调或已商定决策的核心事实。NPATI Agent 将在聊天推理中自动回忆这些信息，避免编造。",
      "addFirstBtn": "+ 添加首条事实"
    },
    "emptyFiltered": {
      "title": "没有匹配的记忆",
      "description": "尝试调整搜索关键词或切换类别筛选。",
      "resetFilters": "重置筛选"
    },
    "card": {
      "verified": "✓ 已验证",
      "confidenceTooltip": "置信度分数：{score}",
      "copy": "复制",
      "copied": "✓ 已复制",
      "copyTitle": "复制事实内容",
      "edit": "编辑",
      "editTitle": "编辑此记忆事实",
      "delete": "删除",
      "deleteTitle": "删除此记忆事实",
      "deleteFactTitle": "删除记忆事实"
    },
    "drawer": {
      "eyebrow": "业务知识",
      "editTitle": "编辑记忆事实",
      "newTitle": "新记忆事实",
      "closeAria": "关闭",
      "categorySection": "类别与分类",
      "typeLabel": "记忆类型 *",
      "types": {
        "businessFact": "📌 业务事实（运营规则、定价、事实）",
        "audience": "🎯 目标受众与理想客户画像（人物画像、人口特征、痛点）",
        "brand": "✨ 品牌与语气（语调、风格、定位规则）",
        "decision": "⚖️ 战略决策（已确认路线图、选择）",
        "product": "📦 产品与服务（产品组合、规格、功能）",
        "channel": "📢 营销渠道（传播、平台）",
        "preference": "⚙️ 用户偏好（格式、提示指令）",
        "experiment": "🧪 实验（增长测试、活跃假设）",
        "result": "📈 结果与指标（成果、已验证发现）",
        "other": "📝 其他知识"
      },
      "detailsSection": "记忆详情",
      "titleLabel": "标题 *",
      "titlePlaceholder": "例如：主要目标客户：欧洲 B2B 创始人",
      "contentLabel": "事实内容 / 指南 *",
      "contentPlaceholder": "详细说明 NPATI Agent 必须遵守的已验证事实、数字、边界或规则…",
      "confidenceSection": "置信度等级",
      "confidenceLabel": "验证级别",
      "confidenceOptions": {
        "high100": "已验证事实（100% — 真实规则）",
        "med80": "高置信度（80% — 充分观察）",
        "low50": "假设（50% — 探索中）"
      },
      "cancel": "取消",
      "saving": "正在保存事实…",
      "saveChanges": "保存更改",
      "saveFact": "保存记忆事实",
      "errors": {
        "titleRequired": "需要填写标题",
        "contentRequired": "需要填写事实内容描述",
        "saveFailed": "无法保存记忆条目"
      },
      "defaultBusinessName": "我的业务"
    },
    "toasts": {
      "copied": "记忆事实已复制到剪贴板",
      "updated": "记忆条目已更新",
      "saved": "新记忆条目已保存",
      "deleted": "已删除：“{title}”",
      "deleteError": "无法删除记忆条目"
    },
    "dialogs": {
      "deleteTitle": "删除记忆事实？",
      "deleteMessage": "删除记忆条目“{title}”？此操作无法撤销。",
      "deleteConfirm": "删除",
      "deleteCancel": "取消"
    }
  },
  "skillsPage": {
    "eyebrow": "设置 · 技能",
    "backToSettings": "返回设置",
    "title": "智能体技能",
    "heroCopy": "浏览 NPATI Agent 为您的请求自动选择的内置业务能力。",
    "badgeBuiltin": "内置目录",
    "stats": {
      "availableSkills": "项可用技能",
      "availableSkillsDesc": "已注册的智能体工作流",
      "capabilities": "项能力",
      "capabilitiesDesc": "智能体可用的操作",
      "autoValue": "自动",
      "skillSelection": "技能选择",
      "skillSelectionDesc": "匹配请求与上下文"
    },
    "searchPlaceholder": "搜索技能和能力…",
    "searchAria": "筛选技能",
    "clearSearch": "清除搜索",
    "statusShowing": {
      "showing": "显示",
      "of": "共",
      "skills": "项技能"
    },
    "errorLoading": "无法加载技能",
    "empty": {
      "title": "没有匹配的技能",
      "description": "尝试其他名称、描述或能力。",
      "clearSearch": "清除搜索"
    },
    "card": {
      "available": "可用",
      "builtinType": "内置技能"
    },
    "skills": {
      "competitorAnalysis": {
        "name": "竞争对手分析",
        "desc": "寻找相关竞争对手，将公开证据与当前业务上下文进行比较。"
      },
      "webResearch": {
        "name": "网络研究",
        "desc": "通过受保护的 NPATI Web Research 边界搜索和读取公开网络来源。"
      },
      "businessStartup": {
        "name": "业务创业",
        "desc": "构建业务创意、受众、销售方案和首次验证计划。"
      },
      "businessGrowth": {
        "name": "业务增长",
        "desc": "寻找切实可行的获客、留存、定位和增长机会。"
      },
      "sellProduct": {
        "name": "销售产品",
        "desc": "将产品或服务转化为清晰的销售方案和销售计划。"
      }
    }
  }
} satisfies Pick<TranslationSchema, "goalsPage" | "contentPage" | "connectionsPage" | "memoryPage" | "skillsPage">;
