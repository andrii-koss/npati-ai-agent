import type { TranslationSchema } from "../../types";

export const workspace = {
  "goalsPage": {
    "eyebrow": "الإعدادات · الأهداف",
    "backToSettings": "العودة إلى الإعدادات",
    "title": "الأهداف والغايات",
    "heroCopy": "حدّد نتائج قابلة للقياس وأهداف مؤشرات ومعالم ذات أولوية لتوجيه وكلاء الذكاء الاصطناعي المستقلين.",
    "newGoal": "+ هدف جديد",
    "stats": {
      "totalGoals": "إجمالي الأهداف",
      "totalGoalsDesc": "أهداف تجارية محددة",
      "activeOutcomes": "نتائج نشطة",
      "activeOutcomesDesc": "أولويات الوكلاء الجارية",
      "completedGoals": "أهداف مكتملة",
      "completedGoalsDesc": "معالم محققة",
      "highPriority": "أولوية مرتفعة",
      "highPriorityDesc": "أهداف حرجة P1"
    },
    "searchPlaceholder": "تصفية الأهداف بالعنوان أو الوصف أو وحدة القياس...",
    "searchAria": "تصفية الأهداف",
    "clearSearch": "مسح البحث",
    "tabs": {
      "all": "الكل",
      "active": "نشط",
      "paused": "متوقف مؤقتًا",
      "completed": "مكتمل"
    },
    "filterByPriority": "تصفية حسب الأولوية",
    "priorities": {
      "all": "جميع الأولويات",
      "high": "أولوية مرتفعة (P1)",
      "normal": "أولوية عادية (P2)",
      "low": "أولوية منخفضة (P3)"
    },
    "priorityBadges": {
      "high": "مرتفع P1",
      "normal": "عادي P2",
      "low": "منخفض P3"
    },
    "showingGoals": "عرض {count} من {total} أهداف",
    "matchingQuery": " المطابق لـ \"{query}\"",
    "table": {
      "status": "الحالة",
      "goalAndOutcome": "الهدف والنتيجة",
      "progress": "التقدم",
      "priority": "الأولوية",
      "dueDate": "تاريخ الاستحقاق",
      "actions": "الإجراءات"
    },
    "statusTooltips": {
      "pause": "انقر للإيقاف المؤقت",
      "resume": "انقر للاستئناف",
      "reactivate": "انقر لإعادة التفعيل"
    },
    "statuses": {
      "active": "نشط",
      "paused": "متوقف مؤقتًا",
      "completed": "مكتمل",
      "cancelled": "ملغى"
    },
    "editGoalTooltip": "انقر لتعديل الهدف",
    "qualitativeGoal": "هدف نوعي",
    "overdue": "متأخر",
    "actions": {
      "done": "✓ تم",
      "markCompleted": "تحديد الهدف كمكتمل",
      "reopen": "إعادة فتح",
      "reopenTitle": "إعادة فتح الهدف",
      "edit": "تعديل",
      "editTitle": "تعديل معلمات الهدف",
      "delete": "حذف",
      "deleteTitle": "حذف الهدف"
    },
    "empty": {
      "noGoalsTitle": "لم تُضبط أهداف بعد",
      "noGoalsDesc": "حدّد نتائج تجارية ملموسة أو مؤشرات مستهدفة أو معالم استراتيجية ليعطيها وكلاء NPATI الأولوية في التنفيذ المستقل وتوصيات الدردشة.",
      "createFirstGoal": "+ إنشاء أول هدف",
      "noMatchingTitle": "لا توجد أهداف مطابقة",
      "noMatchingDesc": "جرّب تعديل كلمات البحث أو المرشحات للعثور على ما تبحث عنه.",
      "clearFilters": "مسح المرشحات"
    },
    "drawer": {
      "kicker": "الأهداف",
      "editGoal": "تعديل الهدف",
      "newGoal": "هدف جديد",
      "close": "إغلاق",
      "objectiveSection": "غاية الهدف",
      "titleLabel": "عنوان الهدف *",
      "titlePlaceholder": "مثلًا: كسب أول 100 عميل يدفع",
      "descLabel": "الوصف / معايير النجاح",
      "descPlaceholder": "كيف يبدو النجاح؟ ما النتائج المحددة التي يسعى الوكلاء إليها؟",
      "priorityStatusSection": "الأولوية والحالة",
      "priorityLabel": "الأولوية",
      "statusLabel": "الحالة",
      "metricSection": "تتبع المؤشرات (اختياري)",
      "metricHint": "حدّد أهدافًا رقمية إذا أمكن قياس هذا الهدف وتتبعه كميًا.",
      "targetValueLabel": "القيمة المستهدفة",
      "targetValuePlaceholder": "مثلًا: 100",
      "currentValueLabel": "القيمة الحالية",
      "currentValuePlaceholder": "مثلًا: 42",
      "unitLabel": "الوحدة",
      "unitPlaceholder": "مثلًا: دولار، مستخدمون، %",
      "dueDateSection": "تاريخ الاستحقاق المستهدف",
      "deadlineLabel": "الموعد النهائي للمعلم",
      "cancel": "إلغاء",
      "saving": "جارٍ الحفظ...",
      "saveChanges": "حفظ تغييرات الهدف",
      "createGoal": "إنشاء هدف"
    },
    "notices": {
      "failedToLoad": "فشل تحميل الأهداف: {message}",
      "titleRequired": "عنوان الهدف مطلوب",
      "updatedSuccess": "تم تحديث الهدف \"{title}\" بنجاح.",
      "createdSuccess": "تم إنشاء الهدف \"{title}\" بنجاح.",
      "failedToSave": "فشل حفظ الهدف: {message}",
      "deletedSuccess": "تم حذف الهدف \"{title}\".",
      "failedToDelete": "فشل حذف الهدف: {message}",
      "statusUpdated": "تم تحديث حالة الهدف \"{title}\" إلى {status}.",
      "statusUpdateError": "خطأ تحديث الحالة: {message}"
    },
    "dialogs": {
      "deleteTitle": "حذف الهدف؟",
      "deleteMessage": "هل تريد بالتأكيد حذف الهدف \"{title}\"؟",
      "deleteConfirm": "حذف",
      "deleteCancel": "إلغاء"
    }
  },
  "contentPage": {
    "eyebrow": "الإعدادات · مركز المحتوى",
    "backToSettings": "العودة إلى الإعدادات",
    "title": "مركز المحتوى ومكتبة الإنتاج",
    "heroCopy": "راجع المقالات ومخططات SEO ومسودات الشبكات الاجتماعية التي ينشئها الوكلاء المستقلون وعدّلها ونسّقها وصدّرها.",
    "newContentDraft": "+ مسودة محتوى جديدة",
    "newContentPrompt": "أعدّ مسودة مقال تسويقي مؤثر وخطة توزيع اجتماعي لجمهورنا المستهدف.",
    "tabs": {
      "all": "جميع العناصر",
      "articles": "المقالات",
      "seoBlueprints": "مخططات SEO",
      "socialPosts": "منشورات اجتماعية",
      "briefsPlans": "موجزات وخطط"
    },
    "searchPlaceholder": "البحث عن مسودات وكلمات ومواضيع...",
    "searchAria": "البحث في مكتبة المحتوى",
    "clearSearch": "مسح البحث",
    "types": {
      "article": "مقال",
      "seoBlueprint": "مخطط SEO",
      "socialMedia": "وسائل التواصل الاجتماعي",
      "briefPlan": "موجز وخطة"
    },
    "empty": {
      "readyTitle": "مكتبة محتوى الذكاء الاصطناعي جاهزة",
      "readyDesc": "عندما ينفّذ وكلاء الشركة المستقلون موجزات المحتوى أو أبحاث الكلمات أو إنشاء المقالات، تُنظّم جميع مسودات الإنتاج هنا.",
      "generateFirstDraft": "+ إنشاء أول مسودة في الدردشة",
      "chatPrompt": "أعدّ مسودة مقال مدونة محسّن لـ SEO يستهدف عميلنا المثالي مع أهم الخلاصات والأسئلة الشائعة.",
      "restoreDeleted": "استعادة المستندات المحذوفة",
      "noMatchingTitle": "لا توجد مستندات مطابقة",
      "noMatchingDesc": "جرّب تعديل كلمات البحث أو اختيار نوع محتوى مختلف.",
      "resetFilters": "إعادة ضبط المرشحات",
      "selectDoc": "اختر مستندًا من اليسار للقراءة أو التصدير."
    },
    "cards": {
      "listAria": "قائمة المستندات المنشأة",
      "deleteDocumentTitle": "حذف المستند",
      "minRead": "قراءة في نحو {count} دقائق"
    },
    "viewer": {
      "expand": "توسيع",
      "collapse": "طي",
      "expandTitle": "توسيع لقراءة المستند كاملًا",
      "collapseTitle": "طي إلى العرض العادي",
      "editDocument": "تعديل المستند",
      "views": {
        "preview": "معاينة",
        "previewTitle": "عرض قراءة منسق",
        "raw": "ملف .md خام",
        "rawTitle": "مصدر Markdown الخام"
      },
      "actions": {
        "edit": "✎ تعديل",
        "editTitle": "تعديل نص المستند وعنوانه وفئته",
        "delete": "🗑 حذف",
        "deleteTitle": "حذف هذا المستند",
        "copy": "نسخ",
        "copied": "✓ تم النسخ!",
        "copyTitle": "نسخ محتوى Markdown إلى الحافظة",
        "download": "تنزيل .md",
        "downloadTitle": "تنزيل كملف Markdown",
        "saveChanges": "✓ حفظ التغييرات",
        "saveChangesTitle": "حفظ تغييراتك",
        "cancel": "إلغاء",
        "cancelTitle": "إلغاء التعديل"
      },
      "metrics": {
        "words": "كلمات",
        "characters": "أحرف",
        "readTime": "وقت القراءة",
        "generatedDate": "تاريخ الإنشاء"
      },
      "editor": {
        "titleLabel": "عنوان المستند",
        "titlePlaceholder": "أدخل عنوان المستند...",
        "typeLabel": "نوع المحتوى",
        "bodyLabel": "نص المستند (Markdown)",
        "saveHint": "اضغط Ctrl+S للحفظ",
        "bodyPlaceholder": "اكتب أو عدّل نص Markdown هنا..."
      },
      "overlay": {
        "expand": "توسيع لقراءة المستند كاملًا",
        "collapse": "طي إلى العرض العادي"
      }
    },
    "toast": {
      "saved": "تم حفظ التغييرات بنجاح!",
      "saveError": "تعذّر حفظ التغييرات",
      "deleted": "تم حذف المستند",
      "deleteError": "تعذّر حذف المستند"
    },
    "dialogs": {
      "deleteTitle": "حذف المحتوى؟",
      "deleteMessage": "هل تريد بالتأكيد حذف \"{title}\"؟",
      "deleteConfirm": "حذف",
      "deleteCancel": "إلغاء",
      "thisDocumentFallback": "هذا المستند"
    }
  },
  "connectionsPage": {
    "eyebrow": "البنية التحتية والتكاملات",
    "backToSettings": "العودة إلى الإعدادات",
    "title": "الخدمات المتصلة",
    "heroCopy": "راقب سلامة بيئة التشغيل ونقاط الاتصال وحالة محركات التخزين ومحوّلات الذكاء الاصطناعي الداخلية والخدمات المصغرة.",
    "refreshStatus": "تحديث الحالة",
    "checkingStatus": "جارٍ فحص الحالة...",
    "refreshTitle": "فحص نقاط اتصال سلامة الخدمات",
    "lastSuccessfulCheck": "آخر فحص ناجح: {{time}}",
    "noSuccessfulCheck": "لم ينجح أي فحص بعد",
    "checkFailed": "فشل فحص السلامة — الخدمات غير متاحة",
    "searchPlaceholder": "تصفية الخدمات بالاسم أو نقطة الاتصال أو الفئة...",
    "searchAria": "تصفية الخدمات المتصلة",
    "clearSearch": "مسح البحث",
    "tabs": {
      "all": "الكل",
      "internal": "داخلي",
      "storage": "التخزين",
      "provider": "المزوّد",
      "operational": "يعمل"
    },
    "categories": {
      "internal": "محرك داخلي",
      "storage": "تخزين البيانات",
      "provider": "مزوّد سحابي"
    },
    "statuses": {
      "operational": "يعمل",
      "standby": "احتياطي",
      "degraded": "أداء متراجع",
      "down": "متوقف"
    },
    "empty": {
      "title": "لا توجد خدمات مطابقة",
      "description": "جرّب تعديل طلب البحث أو اختيار فئة أخرى.",
      "resetFilters": "إعادة ضبط المرشحات"
    },
    "card": {
      "copy": "نسخ",
      "copied": "✓ تم النسخ",
      "copyTitle": "نسخ سلسلة الاتصال",
      "verifiedFallback": "تم التحقق في شبكة Docker",
      "protocol": "HTTP / TCP"
    },
    "services": {
      "omniroute": {
        "name": "توجيه الذكاء الاصطناعي في NPATI",
        "desc": "تنسيق A2A وتوجيه المجموعات والدمج والمسارات ومحرك التضمينات (v3.8.52).",
        "details": "النواة v3.8.52",
        "versionPrefix": "الإصدار"
      },
      "postgres": {
        "name": "PostgreSQL مع pgvector",
        "desc": "المصدر الموحد لمساحات العمل والشركات ومقاطع المعرفة والتضمينات المتجهية.",
        "details": "امتداد المتجهات نشط"
      },
      "redis": {
        "name": "ذاكرة Redis المؤقتة والتدفقات",
        "desc": "قوائم مهام غير متزامنة وإيجارات وأقفال موزعة وتخزين مؤقت لذاكرة المحادثات.",
        "details": "التخزين المؤقت في الذاكرة نشط"
      },
      "minio": {
        "name": "تخزين MinIO S3",
        "desc": "مخزن مستندات معزول لكل مستأجر لمرفقات معرفة الشركة والملفات الثنائية.",
        "details": "واجهة API متوافقة مع S3"
      },
      "crawler": {
        "name": "زاحف الويب Crawl4AI",
        "desc": "زاحف أبحاث ويب عميقة وتحويل Markdown ومحرك عرض SSR.",
        "details": "مجموعة عمال دون واجهة"
      },
      "coreBackend": {
        "name": "الخادم الأساسي لـ NPATI",
        "desc": "المصدر الموحد للمصادقة وحسابات المستخدمين والفوترة.",
        "details": "بوابة API نشطة"
      },
      "cloudHub": {
        "name": "مركز NPATI السحابي",
        "desc": "مزامنة اختيارية لفهرس السحابة وسجل نماذج مشترك.",
        "details": "اختياري للنشر المحلي"
      }
    }
  },
  "memoryPage": {
    "eyebrow": "سياق النشاط التجاري والمعرفة",
    "backToSettings": "العودة إلى الإعدادات",
    "title": "ذاكرة النشاط التجاري",
    "heroCopy": "نظّم الحقائق الدائمة وملفات الجمهور الموثقة وقواعد نبرة العلامة التجارية والقرارات الاستراتيجية التي يستخدمها NPATI Agent في الدردشات والمهام.",
    "addFactBtn": "+ إضافة حقيقة للذاكرة",
    "addFactTitle": "إضافة حقيقة تجارية أو قرار جديد",
    "searchPlaceholder": "البحث في الذاكرة بالكلمة أو العنوان أو المحتوى أو المصدر...",
    "searchAria": "تصفية عناصر الذاكرة",
    "clearSearch": "مسح البحث",
    "tabs": {
      "all": "جميع العناصر",
      "facts": "حقائق النشاط التجاري",
      "audience": "الجمهور والعميل المثالي",
      "brand": "العلامة التجارية والنبرة",
      "decisions": "القرارات والاستراتيجية",
      "product": "المنتجات والخدمات",
      "other": "أخرى"
    },
    "types": {
      "business_fact": "حقيقة تجارية",
      "audience": "الجمهور والعميل المثالي",
      "brand": "العلامة التجارية والنبرة",
      "decision": "قرار استراتيجي",
      "product": "منتج وخدمة",
      "channel": "قناة تسويق",
      "preference": "تفضيل المستخدم",
      "experiment": "تجربة",
      "result": "نتيجة ومؤشر",
      "other": "معرفة أخرى"
    },
    "sources": {
      "manual": "يدوي",
      "chatConfirmed": "مؤكد في الدردشة",
      "onboarding": "التهيئة الأولية",
      "userVerified": "تحقق منه المستخدم",
      "sourcePrefix": "المصدر"
    },
    "empty": {
      "title": "لا توجد عناصر ذاكرة دائمة بعد",
      "description": "أضف حقائق أساسية عن نشاطك التجاري أو جمهورك أو نبرة علامتك أو القرارات المتفق عليها. سيسترجعها NPATI Agent تلقائيًا أثناء الدردشة دون اختلاق.",
      "addFirstBtn": "+ إضافة أول حقيقة"
    },
    "emptyFiltered": {
      "title": "لا توجد ذكريات مطابقة",
      "description": "جرّب تعديل كلمات البحث أو تغيير مرشحات الفئة.",
      "resetFilters": "إعادة ضبط المرشحات"
    },
    "card": {
      "verified": "✓ تم التحقق",
      "confidenceTooltip": "درجة الثقة: {score}",
      "copy": "نسخ",
      "copied": "✓ تم النسخ",
      "copyTitle": "نسخ محتوى الحقيقة",
      "edit": "تعديل",
      "editTitle": "تعديل حقيقة الذاكرة هذه",
      "delete": "حذف",
      "deleteTitle": "حذف حقيقة الذاكرة هذه",
      "deleteFactTitle": "حذف حقيقة من الذاكرة"
    },
    "drawer": {
      "eyebrow": "معرفة النشاط التجاري",
      "editTitle": "تعديل حقيقة الذاكرة",
      "newTitle": "حقيقة ذاكرة جديدة",
      "closeAria": "إغلاق",
      "categorySection": "الفئة والتصنيف",
      "typeLabel": "نوع الذاكرة *",
      "types": {
        "businessFact": "📌 حقيقة تجارية (قواعد العمل، الأسعار، الحقائق)",
        "audience": "🎯 الجمهور المستهدف والعميل المثالي (الشخصيات، الخصائص، المشكلات)",
        "brand": "✨ العلامة التجارية والنبرة (النبرة، الأسلوب، قواعد التموضع)",
        "decision": "⚖️ قرار استراتيجي (خارطة طريق مؤكدة، اختيارات)",
        "product": "📦 منتج وخدمة (العروض، المواصفات، الميزات)",
        "channel": "📢 قناة تسويق (التوزيع، المنصات)",
        "preference": "⚙️ تفضيل المستخدم (التنسيق، تعليمات الطلبات)",
        "experiment": "🧪 تجربة (اختبارات نمو، فرضيات نشطة)",
        "result": "📈 نتيجة ومؤشر (النتائج، الاستنتاجات المتحقق منها)",
        "other": "📝 معرفة أخرى"
      },
      "detailsSection": "تفاصيل الذاكرة",
      "titleLabel": "العنوان *",
      "titlePlaceholder": "مثلًا: العميل الرئيسي المستهدف: مؤسسو شركات B2B في أوروبا",
      "contentLabel": "محتوى الحقيقة / الإرشادات *",
      "contentPlaceholder": "اذكر الحقائق والأرقام والحدود أو القواعد المؤكدة التي يجب أن يلتزم بها NPATI Agent...",
      "confidenceSection": "مستوى الثقة",
      "confidenceLabel": "مستوى التحقق",
      "confidenceOptions": {
        "high100": "حقيقة مؤكدة (100% - قاعدة مثبتة)",
        "med80": "ثقة مرتفعة (80% - ملاحظات قوية)",
        "low50": "فرضية (50% - قيد الاستكشاف)"
      },
      "cancel": "إلغاء",
      "saving": "جارٍ حفظ الحقيقة...",
      "saveChanges": "حفظ التغييرات",
      "saveFact": "حفظ حقيقة الذاكرة",
      "errors": {
        "titleRequired": "العنوان مطلوب",
        "contentRequired": "وصف محتوى الحقيقة مطلوب",
        "saveFailed": "فشل حفظ عنصر الذاكرة"
      },
      "defaultBusinessName": "نشاطي التجاري"
    },
    "toasts": {
      "copied": "تم نسخ حقيقة الذاكرة إلى الحافظة",
      "updated": "تم تحديث عنصر الذاكرة",
      "saved": "تم حفظ عنصر ذاكرة جديد",
      "deleted": "تم الحذف: \"{title}\"",
      "deleteError": "تعذّر حذف عنصر الذاكرة"
    },
    "dialogs": {
      "deleteTitle": "حذف حقيقة من الذاكرة؟",
      "deleteMessage": "حذف عنصر الذاكرة \"{title}\"؟ لا يمكن التراجع عن ذلك.",
      "deleteConfirm": "حذف",
      "deleteCancel": "إلغاء"
    }
  },
  "skillsPage": {
    "eyebrow": "الإعدادات · المهارات",
    "backToSettings": "العودة إلى الإعدادات",
    "title": "مهارات الوكيل",
    "heroCopy": "استعرض الإمكانات التجارية المدمجة التي يختارها NPATI Agent تلقائيًا لطلباتك.",
    "badgeBuiltin": "فهرس مدمج",
    "stats": {
      "availableSkills": "مهارات متاحة",
      "availableSkillsDesc": "مسارات عمل الوكلاء المسجلة",
      "capabilities": "إمكانات",
      "capabilitiesDesc": "إجراءات متاحة للوكيل",
      "autoValue": "تلقائي",
      "skillSelection": "اختيار المهارة",
      "skillSelectionDesc": "مطابق للطلب والسياق"
    },
    "searchPlaceholder": "البحث عن المهارات والإمكانات...",
    "searchAria": "تصفية المهارات",
    "clearSearch": "مسح البحث",
    "statusShowing": {
      "showing": "عرض",
      "of": "من",
      "skills": "مهارات"
    },
    "errorLoading": "تعذّر تحميل المهارات",
    "empty": {
      "title": "لا توجد مهارات مطابقة",
      "description": "جرّب اسمًا أو وصفًا أو إمكانية أخرى.",
      "clearSearch": "مسح البحث"
    },
    "card": {
      "available": "متاح",
      "builtinType": "مهارة مدمجة"
    },
    "skills": {
      "competitorAnalysis": {
        "name": "تحليل المنافسين",
        "desc": "يعثر على المنافسين المناسبين ويقارن الأدلة العامة بسياق النشاط التجاري الحالي."
      },
      "webResearch": {
        "name": "أبحاث الويب",
        "desc": "يبحث في مصادر الويب العامة ويقرأها عبر حدود أبحاث الويب المحمية في NPATI."
      },
      "businessStartup": {
        "name": "تأسيس نشاط تجاري",
        "desc": "بلورة فكرة نشاط تجاري وجمهوره وعرضه وخطة التحقق الأولى."
      },
      "businessGrowth": {
        "name": "نمو النشاط التجاري",
        "desc": "العثور على فرص عملية لاكتساب العملاء والاحتفاظ بهم والتموضع والنمو."
      },
      "sellProduct": {
        "name": "بيع منتج",
        "desc": "تحويل منتج أو خدمة إلى عرض واضح وخطة مبيعات."
      }
    }
  }
} satisfies Pick<TranslationSchema, "goalsPage" | "contentPage" | "connectionsPage" | "memoryPage" | "skillsPage">;
