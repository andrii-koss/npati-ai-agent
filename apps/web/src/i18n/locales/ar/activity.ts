import type { TranslationSchema } from "../../types";

export const activity = {
  "capabilityInspector": {
    "eyebrow": "الحوكمة والأمان",
    "title": "مستعرض الإمكانات",
    "backAria": "العودة إلى الإعدادات",
    "modelProfiles": {
      "title": "ملفات النماذج: الوضع الاحتياطي المحافظ.",
      "emptyHint": "لم تُفعّل أي علامة code.model_profile.<id> لهذا السياق، لذا يستخدم كل تشغيل الملف المحافظ (استدعاء أداة واحدة كل مرة مع اكتشاف تلقائي لدعم الأدوات)، حتى عندما يطابق النموذج أحد ملفات السجل البالغ عددها {{count}}. فعّل علامات الملفات المسموح بها في هذا النشر لبدء الإتاحة."
    },
    "heroCopy": "استكشف ودقّق في 306 إمكانات معتمدة لدى NPATI Agent. تحقّق من حدود محلّل الإمكانات الفعّال وظهور الأدوات وسياسات المخاطر في بيئة التشغيل الفعلية.",
    "stats": {
      "totalLabel": "إجمالي الإمكانات",
      "totalDesc": "المعرّفات المعتمدة 1..306 المتحقق منها",
      "agentCallableLabel": "قابل للاستدعاء من الوكيل",
      "agentCallableDesc": "متاح للنماذج عبر المحلّل",
      "runtimeOnlyLabel": "بيئة التشغيل الداخلية",
      "runtimeOnlyDesc": "عمليات محرك معزولة",
      "requiresApprovalLabel": "يتطلب موافقة",
      "requiresApprovalDesc": "بوابة أمان بمشاركة بشرية"
    },
    "slices": {
      "all": "الكل",
      "agentCallable": "متاح للوكيل",
      "runtimeOnly": "لبيئة التشغيل فقط",
      "userVisible": "مرئي للمستخدم",
      "automatic": "تلقائي",
      "allowed": "مسموح",
      "requiresApproval": "يتطلب موافقة"
    },
    "controls": {
      "searchPlaceholder": "تصفية الإمكانات بالاسم أو المعرّف أو المجال...",
      "searchAriaLabel": "تصفية الإمكانات",
      "clearSearch": "مسح البحث",
      "showing": "عرض {{start}}–{{end}} من {{total}} إمكانات",
      "matching": "المطابق لـ \"{{term}}\"",
      "copied": "✓ تم نسخ {{id}}",
      "perPage": "لكل صفحة:",
      "allCount": "الكل ({{total}})"
    },
    "table": {
      "colId": "المعرّف",
      "sortId": "ترتيب حسب المعرّف",
      "colName": "الاسم",
      "sortName": "ترتيب حسب الاسم",
      "colCanonicalId": "المعرّف المعتمد",
      "sortCanonicalId": "ترتيب حسب المعرّف المعتمد",
      "colDomain": "المجال",
      "sortDomain": "ترتيب حسب المجال",
      "colType": "النوع",
      "sortType": "ترتيب حسب النوع",
      "colCallable": "قابل للاستدعاء",
      "colRisk": "المخاطر",
      "sortRisk": "ترتيب حسب المخاطر",
      "colStatus": "الحالة",
      "sortStatus": "ترتيب حسب الحالة",
      "copyTooltip": "انقر لنسخ المعرّف المعتمد",
      "empty": "لا توجد إمكانات تطابق المرشح المحدد.",
      "prev": "← السابق",
      "next": "التالي →"
    },
    "callable": {
      "callable": "قابل للاستدعاء",
      "internal": "داخلي"
    },
    "risks": {
      "low": "منخفض",
      "medium": "متوسط",
      "high": "مرتفع",
      "critical": "حرج"
    },
    "statuses": {
      "verified": "تم التحقق",
      "partial": "جزئي",
      "notImplemented": "غير مطبق",
      "blocked": "محظور",
      "allowed": "مسموح",
      "denied": "مرفوض",
      "unavailable": "غير متاح",
      "requiresApproval": "تلزم موافقة"
    },
    "types": {
      "runtime": "بيئة التشغيل",
      "config": "التهيئة",
      "orchestr": "التنسيق",
      "tool": "الأداة",
      "article": "مقال",
      "secOps": "عمليات الأمان"
    },
    "connectedServices": "الخدمات المتصلة",
    "errorLoad": "فشل تحميل الإمكانات",
    "integrations": {
      "kicker": "تكاملات المنتج المتحقق منها",
      "title": "قنوات المراسلة المطبقة",
      "manage": "إدارة التكاملات",
      "sharedRuntime": "بيئة تشغيل NPATI Agent المشتركة",
      "loading": "جارٍ تحميل حالة التكامل...",
      "notice": "تتوفر حالة التكامل عند الاتصال بـ Agent API."
    }
  },
  "activity": {
    "eyebrow": "المراقبة والتدقيق",
    "title": "النشاط وتتبع التشغيل",
    "backAria": "العودة إلى الإعدادات",
    "heroCopy": "تتبع مفصّل مباشر للتنفيذ وخطوات التفويض واستدعاءات الأدوات وأزمنة الاستجابة وقرارات الأمان في تشغيل وكلاء الشركة.",
    "stats": {
      "totalRuns": "إجمالي مرات التشغيل",
      "totalRunsDesc": "عمليات الوكلاء المسجلة",
      "completed": "مكتمل",
      "completedDesc": "ناجح دون أعطال",
      "inProgress": "قيد التنفيذ / في الانتظار",
      "inProgressDesc": "مهام الوكلاء النشطة",
      "securityDecisions": "قرارات الأمان",
      "securityDecisionsDesc": "فحوصات الأدوات المدققة"
    },
    "controls": {
      "companyLabel": "الشركة:",
      "all": "الكل",
      "completed": "مكتمل",
      "running": "قيد التشغيل",
      "failed": "فشل",
      "searchPlaceholder": "البحث عن التشغيل بالمهمة أو المعرّف...",
      "searchAriaLabel": "البحث عن التشغيل",
      "clearSearch": "مسح البحث",
      "refresh": "تحديث",
      "refreshing": "جارٍ التحديث...",
      "refreshTitle": "تحديث مرات التشغيل"
    },
    "dispatch": {
      "title": "إرسال مهمة إلى وكلاء الشركة",
      "subtitle": "ابدأ تنفيذ مهمة مستقلة متعددة الوكلاء وراجع التتبع المباشر",
      "modeLabel": "وضع التنفيذ:",
      "modes": {
        "auto": "تنسيق تلقائي (تكيفي)",
        "pipeline": "مسار متسلسل (متعدد الوكلاء)",
        "single": "وكيل واحد (سريع)",
        "fusion": "دمج (متعدد النماذج)"
      },
      "placeholderWithCompany": "أدخل مهمة لوكلاء {{name}} (مثل «حلّل عروض المنافسين وأسعارهم»)...",
      "placeholderDefault": "أدخل تعليمات المهمة لوكلاء الشركة...",
      "dispatchTask": "إرسال المهمة",
      "dispatching": "جارٍ الإرسال...",
      "presetsLabel": "الإعدادات المسبقة:",
      "presets": {
        "marketAuditLabel": "تدقيق السوق والمنافسين",
        "marketAuditPrompt": "إجراء بحث شامل عن المنافسين وتحليل التموضع في السوق",
        "securityAuditLabel": "التحقق من الأمان والإمكانات",
        "securityAuditPrompt": "تدقيق صلاحيات أدوات الشركة وقواعد الوصول إلى API وبوابات الأمان",
        "growthRoadmapLabel": "خارطة طريق للنمو الاستراتيجي",
        "growthRoadmapPrompt": "إعداد ملف العميل المستهدف وخارطة نمو عملية لمدة 90 يومًا"
      },
      "dispatchedNotice": "تم إرسال التشغيل: {{id}} ({{status}})",
      "dispatchFailed": "فشل إرسال تشغيل الوكيل"
    },
    "empty": {
      "noCompaniesTitle": "لم يُعثر على شركات",
      "noCompaniesCopy": "يتتبع «النشاط وتتبع التشغيل» العمليات متعددة الوكلاء المرسلة ضمن سياق شركة ذكاء اصطناعي.",
      "createCompanyBtn": "إنشاء شركة ذكاء اصطناعي",
      "noRunsTitle": "لم تُسجّل مرات تشغيل بعد",
      "presetsTitle": "مهام جاهزة وسيناريوهات البداية",
      "noRunsCopy": "لم تُرسل مهام للوكلاء في هذه الشركة. استخدم مرسل المهام أعلاه أو اختر إعدادًا مسبقًا لإنشاء تتبع مباشر وخطوات تفويض وتدقيق لأمان الأدوات.",
      "presetsCopy": "اختر إعدادًا مسبقًا أدناه أو أدخل مهمة مخصصة أعلاه لإنشاء تتبع مباشر وخطوات تفويض وتدقيق لأمان الأدوات.",
      "dispatchPresetBtn": "إرسال: {{label}} →",
      "viewTraceBtn": "عرض سجل التنفيذ والتتبع ({{count}}) →"
    },
    "sidebar": {
      "recentExecutions": "عمليات التنفيذ الأخيرة ({{count}})",
      "backToPresets": "← 3 إعدادات مسبقة",
      "noFilteredRuns": "لا توجد عمليات تطابق المرشحات الحالية.",
      "clearFiltersBtn": "مسح المرشحات"
    },
    "trace": {
      "backToPresetsAria": "العودة إلى الإعدادات المسبقة",
      "modePrefix": "الوضع: {{mode}}",
      "comboPrefix": "المجموعة: {{name}}",
      "runIdLabel": "معرّف التشغيل:",
      "copy": "نسخ",
      "copied": "تم النسخ",
      "copyRunIdTitle": "نسخ معرّف التشغيل",
      "startedLabel": "بدأ:",
      "completedLabel": "اكتمل:",
      "durationLabel": "المدة:",
      "finalOutput": "الناتج النهائي",
      "copyResultTitle": "نسخ النتيجة",
      "executionFault": "عطل في التنفيذ",
      "completionReportTitle": "تقرير اكتمال العمل في الخلفية",
      "attemptSummary": "المحاولة {{attempt}} · {{tokens}} رموز · ${{cost}} · {{duration}} ث",
      "timelineTitle": "التسلسل الزمني للتنفيذ في الخلفية ({{count}})",
      "timelineDesc": "تسجيلات استلام العامل الدائمة وإعادة المحاولات وأحداث الاكتمال النهائي",
      "attemptLabel": "المحاولة {{attempt}}",
      "synchronousNotice": "نُفّذت هذه العملية بشكل متزامن؛ لم تصدر أحداث عامل خلفية.",
      "delegationTitle": "مسار تفويض الوكلاء ({{count}})",
      "delegationDesc": "تنسيق الأدوار والتسليم بين عدة وكلاء",
      "agentPrefix": "الوكيل: {{id}}",
      "modelPrefix": "النموذج:",
      "lanePrefix": "المسار: {{lane}}",
      "noStepsNotice": "لم تُسجّل خطوات تفويض لهذه المهمة أحادية الجولة.",
      "toolsTitle": "تنفيذ الأدوات وبوابات سياسة الأمان ({{count}})",
      "toolsDesc": "فحوصات محلّل الإمكانات المعتمدة وتدقيق الأمان",
      "policyReason": "سبب السياسة:",
      "noToolsNotice": "لم تُستدعَ أدوات خارجية خلال هذه العملية.",
      "selectRunTitle": "اختر عملية للفحص",
      "selectRunCopy": "اختر تشغيلًا من اللوحة اليسرى لمراجعة تسلسله الزمني وخطوات التفويض وتدقيق الأمان."
    },
    "errors": {
      "loadRunsFailed": "فشل تحميل النشاط",
      "loadRunDetailsFailed": "فشل تحميل تفاصيل التشغيل"
    }
  },
  "automations": {
    "eyebrow": "الإعدادات · الأتمتة",
    "title": "الأتمتة والمهام المجدولة",
    "backAria": "العودة إلى الإعدادات",
    "heroCopy": "اضبط المشغلات الخلفية الدورية ومهام cron المتكررة ومهام الوكلاء المستقلة لشركتك.",
    "selectCompanyAria": "اختيار شركة",
    "newAutomationBtn": "+ أتمتة جديدة",
    "stats": {
      "total": "إجمالي الأتمتة",
      "totalDesc": "مهام ذكاء اصطناعي مجدولة في الخلفية",
      "active": "مشغلات نشطة",
      "activeDesc": "جداول cron قيد التشغيل",
      "paused": "جداول متوقفة مؤقتًا",
      "pausedDesc": "مشغلات احتياطية / غير نشطة",
      "assignedAgents": "وكلاء معيّنون",
      "assignedAgentsDesc": "منفذو الوكلاء المضبوطون"
    },
    "controls": {
      "searchPlaceholder": "تصفية الأتمتة بالاسم أو الوصف أو الطلب أو cron...",
      "searchAriaLabel": "تصفية الأتمتة",
      "clearSearch": "مسح البحث",
      "tabAll": "الكل",
      "tabActive": "نشط",
      "tabPaused": "متوقف مؤقتًا"
    },
    "showingStatus": "عرض {{count}} من {{total}} أتمتة",
    "matchingQuery": "المطابق لـ \"{{query}}\"",
    "empty": {
      "noAutomationsTitle": "لا توجد أتمتة مضبوطة",
      "noAutomationsDesc": "جدوِل مهام cron مستقلة في الخلفية أو مراجعات سوق دورية أو مسارات عمل يومية للوكلاء في هذه الشركة.",
      "createFirstBtn": "+ إنشاء أول أتمتة",
      "noMatchingTitle": "لا توجد أتمتة مطابقة",
      "noMatchingDesc": "جرّب تعديل طلب البحث أو حالة المرشح للعثور على ما تبحث عنه.",
      "clearFiltersBtn": "مسح المرشحات"
    },
    "table": {
      "colStatus": "الحالة",
      "colTask": "المهمة والتعليمات",
      "colSchedule": "الجدول (Cron)",
      "colAssignedAgent": "الوكيل المعيّن",
      "colActions": "الإجراءات",
      "statusActive": "نشط",
      "statusPaused": "متوقف مؤقتًا",
      "clickToPause": "انقر للإيقاف المؤقت",
      "clickToActivate": "انقر للتفعيل",
      "promptPrefix": "الطلب:",
      "nextRunPrefix": "التالي:",
      "mainAgent": "الوكيل الرئيسي",
      "runNow": "▶ تشغيل الآن",
      "running": "جارٍ التشغيل...",
      "runNowTitle": "تشغيل هذه الأتمتة فورًا",
      "history": "السجل",
      "historyTitle": "عرض سجل التنفيذ",
      "edit": "تعديل",
      "editTitle": "تعديل إعدادات الأتمتة",
      "delete": "حذف",
      "deleteTitle": "حذف الأتمتة"
    },
    "presets": {
      "daily9": "يوميًا الساعة 09:00",
      "daily18": "يوميًا الساعة 18:00",
      "mondays9": "كل إثنين الساعة 09:00",
      "fridays17": "كل جمعة الساعة 17:00",
      "hourly": "كل ساعة",
      "daily0": "يوميًا الساعة 00:00"
    },
    "editor": {
      "kicker": "الأتمتة",
      "editTitle": "تعديل الأتمتة",
      "newTitle": "أتمتة جديدة",
      "taskParamsHeading": "معلمات المهمة",
      "taskNameLabel": "اسم المهمة",
      "taskNamePlaceholder": "مثلًا: تحليل يومي للمنافسين",
      "descLabel": "الوصف",
      "descPlaceholder": "ما الذي تنجزه هذه الأتمتة",
      "assignedAgentLabel": "الوكيل المعيّن",
      "mainAgentDefault": "الوكيل الرئيسي (الافتراضي)",
      "schedulePresetsLabel": "جداول جاهزة",
      "cronExpressionLabel": "تعبير Cron (5 حقول: الدقيقة الساعة اليوم الشهر يوم الأسبوع)",
      "cronPlaceholder": "0 9 * * *",
      "agentPromptLabel": "طلب الوكيل",
      "agentPromptPlaceholder": "صِف الهدف الدقيق والخطوات التي ينبغي للوكيل تنفيذها...",
      "saveBtn": "حفظ الأتمتة",
      "savingBtn": "جارٍ الحفظ...",
      "deleteBtn": "حذف",
      "cancelBtn": "إلغاء"
    },
    "history": {
      "kicker": "سجل التشغيل",
      "loading": "جارٍ تحميل سجل التشغيل...",
      "noRuns": "لم تُسجّل مرات تشغيل بعد.",
      "duration": "المدة:",
      "finalResult": "✓ النتيجة النهائية:",
      "error": "خطأ:"
    },
    "dialogs": {
      "deleteTitle": "حذف الأتمتة؟",
      "deleteMessage": "هل تريد بالتأكيد حذف هذه الأتمتة؟",
      "deleteConfirm": "حذف",
      "deleteCancel": "إلغاء"
    },
    "notifications": {
      "runInitiated": "بدأ التشغيل لـ \"{{name}}\".",
      "resultReceived": "تم استلام النتيجة!",
      "runError": "خطأ في التشغيل: {{error}}"
    }
  }
} satisfies Pick<TranslationSchema, "capabilityInspector" | "activity" | "automations">;
