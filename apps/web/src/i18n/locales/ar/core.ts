import type { TranslationSchema } from "../../types";

export const core = {
  "executionTrace": {
    "modelResponding": "النموذج يجيب",
    "waitingForModel": "بانتظار استجابة النموذج",
    "generatingCode": "جارٍ إنشاء الشيفرة",
    "suspended_by_flag": "متوقف مؤقتًا: وكيل البرمجة معطل",
    "usage": "رموز النموذج",
    "inputTokens": "الإدخال",
    "outputTokens": "الإخراج",
    "totalTokens": "المجموع",
    "sharedTurn": "مشترك بين {{count}} استدعاءات للأدوات",
    "unavailableTokens": "غير مسجل",
    "operationStatus": "النتيجة",
    "dryRun": "تشغيل تجريبي: لم تُطبّق التغييرات",
    "runningCommand": "جارٍ تنفيذ الأمر: {{command}}",
    "fileUnchanged": "لا توجد تغييرات",
    "fileNotChanged": "تعذّر تغيير الملف",
    "modelCallFailed": "خطأ في النموذج: استجابته تالفة، لذا لم يُنفّذ هذا الإجراء",
    "fileChangedReadAgain": "تغيّر الملف، جارٍ قراءته مجددًا",
    "agentFinished": "أنهى الوكيل العمل",
    "operationsDone": "تم تنفيذ {{count}} عمليات",
    "testsPassed": "ناجح",
    "working": "جارٍ التفكير",
    "creatingProject": "جارٍ إنشاء المشروع",
    "skipped": "تم التخطي",
    "pending": "قيد الانتظار",
    "preparing": "جارٍ التحضير",
    "queued": "في قائمة الانتظار",
    "running": "قيد التشغيل",
    "completed": "مكتمل",
    "failed": "فشل",
    "cancelled": "ملغى",
    "awaiting_approval": "بانتظار الموافقة",
    "unknown": "مسجل",
    "command": "الأمر",
    "file": "الملف",
    "tool": "الأداة",
    "workingDir": "مجلد العمل",
    "project": "المشروع",
    "output": "الإخراج / السجل",
    "copy": "نسخ",
    "copied": "تم النسخ",
    "copyCommand": "نسخ الأمر",
    "copyLog": "نسخ السجل",
    "fullLog": "عرض الإخراج المسجل بالكامل",
    "less": "عرض أقل",
    "limited": "الإخراج محدود ببيئة التشغيل",
    "duration": "المدة",
    "error": "خطأ",
    "viewRun": "عرض التشغيل",
    "exitCode": "رمز الخروج",
    "reading": "جارٍ قراءة الملفات",
    "searching": "جارٍ البحث في الشيفرة",
    "editing": "جارٍ تعديل الملفات",
    "dependencies": "جارٍ تثبيت التبعيات",
    "building": "جارٍ بناء المشروع",
    "testing": "جارٍ الاختبار",
    "browser": "فحص الجودة في المتصفح",
    "sandbox": "بيئة معزولة",
    "preview": "جارٍ بدء المعاينة المباشرة",
    "planning": "التخطيط",
    "executed": "تم تنفيذ الأمر",
    "read": "تمت قراءة الملف",
    "updated": "تم تحديث الملف",
    "created": "تم الإنشاء",
    "modified": "تم التعديل",
    "deleted": "تم الحذف"
  },
  "projectSection": {
    "types": {
      "website": "موقع إلكتروني",
      "webApp": "تطبيق ويب",
      "landingPage": "صفحة هبوط",
      "mobileApp": "تطبيق جوال"
    }
  },
  "common": {
    "save": "حفظ",
    "cancel": "إلغاء",
    "delete": "حذف",
    "edit": "تعديل",
    "close": "إغلاق",
    "confirm": "تأكيد",
    "loading": "جارٍ التحميل…",
    "error": "خطأ",
    "success": "نجاح",
    "search": "بحث",
    "send": "إرسال",
    "copy": "نسخ",
    "copied": "تم النسخ!",
    "back": "رجوع",
    "settings": "الإعدادات",
    "language": "اللغة",
    "languageSelect": "اختيار اللغة",
    "options": "خيارات إضافية",
    "ok": "موافق",
    "notification": "إشعار",
    "deleteConfirmation": "تأكيد الحذف",
    "confirmation": "تأكيد",
    "inputRequired": "الإدخال مطلوب"
  },
  "nav": {
    "chat": "الدردشة",
    "business": "النشاط التجاري",
    "company": "الشركة",
    "settings": "الإعدادات",
    "capabilities": "مستعرض الإمكانات",
    "activity": "النشاط وتتبع التشغيل",
    "automations": "الأتمتة",
    "goals": "الأهداف",
    "content": "المحتوى",
    "connections": "الخدمات المتصلة",
    "memory": "الذاكرة",
    "skills": "المهارات",
    "aiProviders": "مزوّدو الذكاء الاصطناعي"
  },
  "sidebar": {
    "newChat": "+ دردشة جديدة",
    "pinned": "مثبتة",
    "recent": "الأخيرة",
    "noSavedChats": "لا توجد دردشات محفوظة بعد",
    "share": "مشاركة",
    "rename": "إعادة تسمية",
    "pin": "تثبيت",
    "unpin": "إلغاء التثبيت",
    "archive": "أرشفة",
    "deleteChat": "حذف",
    "deleteBusiness": "حذف",
    "setupDraft": "مسودة الإعداد",
    "current": "الحالي",
    "useInChat": "استخدام في الدردشة"
  },
  "dialogs": {
    "deleteChatTitle": "حذف الدردشة؟",
    "deleteChatMessage": "حذف الدردشة «{{title}}»؟ لا يمكن التراجع عن ذلك.",
    "deleteBusinessTitle": "حذف النشاط التجاري؟",
    "deleteBusinessMessage": "حذف النشاط التجاري «{{name}}» ودردشاته وأهدافه وذاكرته؟ لا يمكن التراجع عن ذلك.",
    "renameChatTitle": "إعادة تسمية الدردشة",
    "renameChatMessage": "أدخل عنوانًا جديدًا لهذه الدردشة:",
    "renameBusinessTitle": "إعادة تسمية النشاط التجاري",
    "renameBusinessMessage": "أدخل اسمًا جديدًا لـ «{{name}}»:",
    "copyLinkTitle": "نسخ الرابط",
    "copyLinkMessage": "انسخ رابط {{label}} هذا:",
    "deleteGoalTitle": "حذف الهدف؟",
    "deleteGoalMessage": "هل تريد بالتأكيد حذف الهدف «{{title}}»؟",
    "deleteMemoryTitle": "حذف حقيقة من الذاكرة؟",
    "deleteMemoryMessage": "حذف عنصر الذاكرة «{{title}}»؟ لا يمكن التراجع عن ذلك.",
    "deleteAutomationTitle": "حذف الأتمتة؟",
    "deleteAutomationMessage": "هل تريد بالتأكيد حذف هذه الأتمتة؟",
    "deleteDocumentTitle": "حذف المستند؟",
    "deleteDocumentMessage": "حذف هذا المستند؟",
    "deleteCompanyTitle": "حذف الشركة؟",
    "deleteCompanyMessage": "حذف الشركة «{{name}}» وجميع وكلائها؟",
    "deleteAgentTitle": "حذف الوكيل؟",
    "deleteAgentMessage": "حذف الوكيل «{{name}}»؟",
    "restartSetupTitle": "إعادة إعداد النشاط التجاري من البداية؟",
    "restartSetupMessage": "بدء إعداد النشاط التجاري من جديد؟ ستُحذف المسودة الحالية وسجل دردشتها. لا يمكن التراجع عن ذلك."
  },
  "chat": {
    "emptyTitle": "على ماذا نعمل؟",
    "emptySubtitle": "اسأل NPATI Agent عن أي شيء، أو تبادل الأفكار معه.",
    "placeholder": "اسأل Npati…",
    "businessEmptySubtitle": "سأستخدم سياق {{name}} ولن أختلق الحقائق الناقصة.",
    "businessPlaceholder": "اسأل عن نشاطك التجاري أو أهدافك أو جمهورك أو خطوتك التالية…",
    "workModeLabel": "وضع العمل",
    "workModeChat": "الدردشة",
    "workModeCode": "الشيفرة",
    "codeModeNeedsProject": "يعمل وضع البرمجة على المشروع المحدد. افتح مشروعًا أولًا.",
    "thinking": "جارٍ التفكير",
    "noCompany": "لا توجد شركة",
    "stopGenerating": "إيقاف الإنشاء",
    "showHistory": "عرض سجل التحليل",
    "hideHistory": "إخفاء سجل التحليل",
    "searchingWeb": "جارٍ البحث في الويب: {{query}}",
    "preparingAnswer": "جارٍ إعداد الإجابة مع المصادر…",
    "table": "جدول ({{count}} صفوف)",
    "copyCsv": "نسخ CSV",
    "downloadCsv": "تنزيل Excel / CSV",
    "copyCode": "نسخ الشيفرة",
    "downloadFile": "تنزيل الملف",
    "expandFullscreen": "توسيع إلى ملء الشاشة",
    "collapse": "طي",
    "helpful": "إجابة مفيدة",
    "notHelpful": "إجابة غير مفيدة",
    "regenerate": "إعادة الإنشاء",
    "shareResponse": "مشاركة الإجابة",
    "showFullPrompt": "فتح",
    "collapsePrompt": "إغلاق",
    "copyPrompt": "نسخ",
    "copiedPrompt": "تم النسخ",
    "editPrompt": "تعديل"
  },
  "userMenu": {
    "emailInbox": "البريد الوارد",
    "aiProvider": "مزوّد الذكاء الاصطناعي",
    "company": "الشركة",
    "memory": "الذاكرة",
    "settings": "الإعدادات",
    "signOut": "تسجيل الخروج",
    "signOutIncompleteTitle": "لم يكتمل تسجيل الخروج",
    "signOutIncompleteDesc": "تعذّر تسجيل الخروج من npati.com."
  },
  "settings": {
    "title": "الإعدادات",
    "eyebrow": "مساحة عمل NPATI",
    "description": "إدارة الخدمات والتفضيلات التي يستخدمها NPATI Agent محليًا.",
    "cards": {
      "aiProviders": {
        "title": "مزوّدو الذكاء الاصطناعي",
        "desc": "اربط المزوّدين واستعرض النماذج واختر توجيه الذكاء الاصطناعي."
      },
      "business": {
        "title": "النشاط التجاري",
        "desc": "حلّل فكرة نشاط تجاري والسوق والأهداف والاستراتيجية."
      },
      "company": {
        "title": "الشركة",
        "desc": "أنشئ فريق ذكاء اصطناعي قابلًا للتخصيص ونظّم وكلاءه."
      },
      "capabilities": {
        "title": "مستعرض الإمكانات",
        "desc": "دقّق في 306 إمكانات معتمدة وظهور الأدوات وسياسات المخاطر."
      },
      "activity": {
        "title": "النشاط وتتبع التشغيل",
        "desc": "راجع تتبع التنفيذ المباشر وتفويض الخطوات وقرارات الأدوات."
      },
      "automations": {
        "title": "الأتمتة",
        "desc": "جدوِل مهام cron المتكررة ومهام الوكلاء في الخلفية."
      },
      "email": {
        "title": "البريد الإلكتروني / صندوق وارد ذكي",
        "desc": "عناوين بريد الشركة وIMAP/SMTP وأتمتة البريد الوارد بالذكاء الاصطناعي."
      },
      "goals": {
        "title": "الأهداف",
        "desc": "حدّد نتائج تجارية قابلة للقياس وتابعها."
      },
      "content": {
        "title": "المحتوى",
        "desc": "خطّط لمحتوى جمهورك وأنشئه وأدِره."
      },
      "connections": {
        "title": "الخدمات المتصلة",
        "desc": "راقب سلامة الخدمات ونقاط الاتصال وتكاملات بيئة التشغيل."
      },
      "memory": {
        "title": "الذاكرة",
        "desc": "راجع سياق النشاط التجاري المؤكد وعدّله."
      },
      "skills": {
        "title": "المهارات",
        "desc": "استعرض الإمكانات التي يستطيع NPATI Agent استخدامها."
      }
    }
  },
  "home": {
    "eyebrow": "وكيل الذكاء الاصطناعي لنشاطك التجاري",
    "heading": "ماذا تريد أن تفعل؟",
    "subheading": "اختر نقطة بداية. سنستخدم نشاطك التجاري الحالي وأهدافك والسياق المحفوظ لمساعدتك على اتخاذ الخطوة العملية التالية.",
    "signIn": "تسجيل الدخول",
    "createAccount": "إنشاء حساب",
    "chatEmptyTitle": "على ماذا نعمل؟",
    "chatEmptySubtitle": "اسأل NPATI Agent عن أي شيء، أو تبادل الأفكار معه.",
    "footerPrefix": "NPATI Agent مفتوح المصدر · من تطوير",
    "footerLink": "NPATI",
    "actions": {
      "sellSomething": {
        "title": "بيع شيء ما",
        "desc": "حوّل منتجًا أو خدمة إلى عرض واضح"
      },
      "startBusiness": {
        "title": "بدء نشاط تجاري",
        "desc": "حوّل فكرة إلى اختبار أول عملي"
      },
      "growBusiness": {
        "title": "تنمية نشاطي التجاري",
        "desc": "اعثر على فرصة النمو العملية التالية"
      },
      "improveBusiness": {
        "title": "تحسين نشاطي التجاري",
        "desc": "راجع ما ينجح وما لا ينجح وما ينبغي تحسينه لاحقًا"
      },
      "createContent": {
        "title": "إنشاء محتوى",
        "desc": "خطّط لمحتوى مفيد لجمهورك"
      },
      "askAgent": {
        "title": "اسأل NPATI Agent",
        "desc": "ابدأ بسؤالك الخاص"
      }
    }
  }
} satisfies Pick<TranslationSchema, "executionTrace" | "projectSection" | "common" | "nav" | "sidebar" | "dialogs" | "chat" | "userMenu" | "settings" | "home">;
