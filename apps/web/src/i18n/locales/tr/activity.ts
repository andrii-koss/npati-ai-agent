import type { TranslationSchema } from "../../types";

export const activity = {
  "capabilityInspector": {
    "eyebrow": "Yönetişim ve güvenlik",
    "title": "Yetenek denetçisi",
    "backAria": "Ayarlara dön",
    "modelProfiles": {
      "title": "Model profilleri: temkinli yedek yaklaşım.",
      "emptyHint": "Bu bağlamda hiçbir code.model_profile.<id> bayrağı etkin olmadığından, model {{count}} kayıtlı profilden biriyle eşleşse bile her çalıştırma temkinli profili kullanır (bir kerede tek araç çağrısı, otomatik algılanan araç çağırma desteği). Kullanıma almayı başlatmak için bu dağıtımın izin verdiği profillerin bayraklarını etkinleştirin."
    },
    "heroCopy": "NPATI Agent'ın 306 standart yeteneğini keşfedin ve denetleyin. Gerçek çalışma ortamında Effective Capability Resolver sınırlarını, araç görünürlüğünü ve risk politikalarını doğrulayın.",
    "stats": {
      "totalLabel": "toplam yetenek",
      "totalDesc": "Doğrulanmış 1..306 standart kimlik",
      "agentCallableLabel": "ajan tarafından çağrılabilir",
      "agentCallableDesc": "Resolver üzerinden modellere sunulur",
      "runtimeOnlyLabel": "dahili çalışma ortamı",
      "runtimeOnlyDesc": "Yalıtılmış motor işlemleri",
      "requiresApprovalLabel": "onay gerektirir",
      "requiresApprovalDesc": "İnsan denetimli güvenlik kontrolü"
    },
    "slices": {
      "all": "Tümü",
      "agentCallable": "Ajan tarafından çağrılabilir",
      "runtimeOnly": "Yalnızca çalışma ortamı",
      "userVisible": "Kullanıcıya görünür",
      "automatic": "Otomatik",
      "allowed": "İzin verildi",
      "requiresApproval": "Onay gerekli"
    },
    "controls": {
      "searchPlaceholder": "Yetenekleri ada, kimliğe veya alana göre filtrele...",
      "searchAriaLabel": "Yetenekleri filtrele",
      "clearSearch": "Aramayı temizle",
      "showing": "{{total}} yetenekten {{start}}–{{end}} arası gösteriliyor",
      "matching": "“{{term}}” ile eşleşen",
      "copied": "✓ {{id}} kopyalandı",
      "perPage": "Sayfa başına:",
      "allCount": "Tümü ({{total}})"
    },
    "table": {
      "colId": "Kimlik",
      "sortId": "Kimliğe göre sırala",
      "colName": "Ad",
      "sortName": "Ada göre sırala",
      "colCanonicalId": "Standart kimlik",
      "sortCanonicalId": "Standart kimliğe göre sırala",
      "colDomain": "Alan",
      "sortDomain": "Alana göre sırala",
      "colType": "Tür",
      "sortType": "Türe göre sırala",
      "colCallable": "Çağrılabilir",
      "colRisk": "Risk",
      "sortRisk": "Riske göre sırala",
      "colStatus": "Durum",
      "sortStatus": "Duruma göre sırala",
      "copyTooltip": "Standart kimliği kopyalamak için tıklayın",
      "empty": "Seçilen filtreyle eşleşen yetenek yok.",
      "prev": "← Önceki",
      "next": "Sonraki →"
    },
    "callable": {
      "callable": "Çağrılabilir",
      "internal": "Dahili"
    },
    "risks": {
      "low": "Düşük",
      "medium": "Orta",
      "high": "Yüksek",
      "critical": "Kritik"
    },
    "statuses": {
      "verified": "Doğrulandı",
      "partial": "Kısmi",
      "notImplemented": "Uygulanmadı",
      "blocked": "Engellendi",
      "allowed": "İzin verildi",
      "denied": "Reddedildi",
      "unavailable": "Kullanılamıyor",
      "requiresApproval": "Onay gerekli"
    },
    "types": {
      "runtime": "Çalışma ortamı",
      "config": "Yapılandırma",
      "orchestr": "Koordinasyon",
      "tool": "Araç",
      "article": "Makale",
      "secOps": "Güvenlik operasyonları"
    },
    "connectedServices": "Bağlı hizmetler",
    "errorLoad": "Yetenekler yüklenemedi",
    "integrations": {
      "kicker": "Doğrulanmış ürün entegrasyonları",
      "title": "Uygulanmış mesajlaşma kanalları",
      "manage": "Entegrasyonları yönet",
      "sharedRuntime": "Paylaşılan NPATI Agent çalışma ortamı",
      "loading": "Entegrasyon durumu yükleniyor...",
      "notice": "Entegrasyon durumu Agent API bağlandığında kullanılabilir."
    }
  },
  "activity": {
    "eyebrow": "Gözlemlenebilirlik ve denetim",
    "title": "Etkinlik ve çalıştırma izi",
    "backAria": "Ayarlara dön",
    "heroCopy": "Şirket ajanlarının çalıştırmaları boyunca ayrıntılı gerçek zamanlı yürütme izi, görev devirleri, araç çağrıları, gecikmeler ve güvenlik kararları.",
    "stats": {
      "totalRuns": "Toplam çalıştırma",
      "totalRunsDesc": "Kaydedilmiş ajan yürütmeleri",
      "completed": "Tamamlandı",
      "completedDesc": "Hatasız başarı",
      "inProgress": "Devam ediyor / Sırada",
      "inProgressDesc": "Etkin ajan iş yükleri",
      "securityDecisions": "Güvenlik kararları",
      "securityDecisionsDesc": "Denetlenen araç kontrolleri"
    },
    "controls": {
      "companyLabel": "Şirket:",
      "all": "Tümü",
      "completed": "Tamamlandı",
      "running": "Çalışıyor",
      "failed": "Başarısız",
      "searchPlaceholder": "Çalıştırmaları göreve veya kimliğe göre ara...",
      "searchAriaLabel": "Çalıştırmaları ara",
      "clearSearch": "Aramayı temizle",
      "refresh": "Yenile",
      "refreshing": "Yenileniyor...",
      "refreshTitle": "Çalıştırmaları yenile"
    },
    "dispatch": {
      "title": "Şirket ajanı görevi gönder",
      "subtitle": "Otonom çok ajanlı görev yürütmesini başlatın ve gerçek zamanlı izleri inceleyin",
      "modeLabel": "Yürütme modu:",
      "modes": {
        "auto": "Otomatik koordinasyon (uyarlanabilir)",
        "pipeline": "İşlem hattı (çok ajanlı)",
        "single": "Tek ajan (hızlı)",
        "fusion": "Birleştirme (çok modelli)"
      },
      "placeholderWithCompany": "{{name}} ajanları için görev girin (ör. 'Rakip tekliflerini ve fiyatlandırmayı analiz et')...",
      "placeholderDefault": "Şirket ajanları için görev istemi girin...",
      "dispatchTask": "Görevi gönder",
      "dispatching": "Gönderiliyor...",
      "presetsLabel": "Hazır ayarlar:",
      "presets": {
        "marketAuditLabel": "Pazar ve rakip denetimi",
        "marketAuditPrompt": "Kapsamlı rakip araştırması ve pazar konumlandırma analizi yapın",
        "securityAuditLabel": "Güvenlik ve yetenek doğrulaması",
        "securityAuditPrompt": "Şirket araç izinlerini, API erişim kurallarını ve güvenlik kontrollerini denetleyin",
        "growthRoadmapLabel": "Stratejik büyüme yol haritası",
        "growthRoadmapPrompt": "İdeal hedef müşteri profilini ve uygulanabilir 90 günlük büyüme yol haritasını oluşturun"
      },
      "dispatchedNotice": "Çalıştırma gönderildi: {{id}} ({{status}})",
      "dispatchFailed": "Ajan çalıştırması gönderilemedi"
    },
    "empty": {
      "noCompaniesTitle": "Şirket bulunamadı",
      "noCompaniesCopy": "Etkinlik ve çalıştırma izi, yapay zekâ şirketi bağlamında gönderilen çok ajanlı çalıştırmaları izler.",
      "createCompanyBtn": "Yapay zekâ şirketi oluştur",
      "noRunsTitle": "Henüz çalıştırma kaydı yok",
      "presetsTitle": "Görev hazır ayarları ve başlangıç senaryoları",
      "noRunsCopy": "Bu şirkette gönderilmiş ajan çalıştırması yok. Gerçek zamanlı yürütme izleri, görev devirleri ve araç güvenlik denetimleri oluşturmak için yukarıdaki görev göndericisini kullanın veya bir hazır ayar seçin.",
      "presetsCopy": "Gerçek zamanlı yürütme izleri, görev devirleri ve araç güvenlik denetimleri oluşturmak için aşağıdan bir hazır ayar seçin veya yukarıya özel bir görev girin.",
      "dispatchPresetBtn": "Gönder: {{label}} →",
      "viewTraceBtn": "Yürütme geçmişini ve izini görüntüle ({{count}}) →"
    },
    "sidebar": {
      "recentExecutions": "Son yürütmeler ({{count}})",
      "backToPresets": "← 3 hazır ayar",
      "noFilteredRuns": "Geçerli filtre ölçütleriyle eşleşen çalıştırma yok.",
      "clearFiltersBtn": "Filtreleri temizle"
    },
    "trace": {
      "backToPresetsAria": "Hazır ayarlara dön",
      "modePrefix": "Mod: {{mode}}",
      "comboPrefix": "Kombinasyon: {{name}}",
      "runIdLabel": "Çalıştırma kimliği:",
      "copy": "Kopyala",
      "copied": "Kopyalandı",
      "copyRunIdTitle": "Çalıştırma kimliğini kopyala",
      "startedLabel": "Başlangıç:",
      "completedLabel": "Tamamlanma:",
      "durationLabel": "Süre:",
      "finalOutput": "Son çıktı",
      "copyResultTitle": "Sonucu kopyala",
      "executionFault": "Yürütme hatası",
      "completionReportTitle": "Arka plan tamamlanma raporu",
      "attemptSummary": "Deneme {{attempt}} · {{tokens}} token · ${{cost}} · {{duration}} sn",
      "timelineTitle": "Arka plan yürütme zaman çizelgesi ({{count}})",
      "timelineDesc": "Kalıcı çalışan sahiplenmeleri, yeniden denemeler ve nihai tamamlanma olayları",
      "attemptLabel": "Deneme {{attempt}}",
      "synchronousNotice": "Bu çalıştırma eşzamanlı yürütüldü; arka plan çalışanı olayı üretilmedi.",
      "delegationTitle": "Ajan görev devri hattı ({{count}})",
      "delegationDesc": "Çok ajanlı rol koordinasyonu ve devirler",
      "agentPrefix": "Ajan: {{id}}",
      "modelPrefix": "Model:",
      "lanePrefix": "Hat: {{lane}}",
      "noStepsNotice": "Bu tek turlu görev için görev devri adımı kaydedilmedi.",
      "toolsTitle": "Araç yürütmeleri ve güvenlik politikası kontrolleri ({{count}})",
      "toolsDesc": "Standart yetenek çözümleyici kontrolleri ve güvenlik denetimleri",
      "policyReason": "Politika gerekçesi:",
      "noToolsNotice": "Bu çalıştırma sırasında harici araç çağrısı tetiklenmedi.",
      "selectRunTitle": "İncelemek için bir çalıştırma seçin",
      "selectRunCopy": "Zaman çizelgesini, görev devirlerini ve güvenlik denetimlerini incelemek için sol panelden bir çalıştırma seçin."
    },
    "errors": {
      "loadRunsFailed": "Etkinlik yüklenemedi",
      "loadRunDetailsFailed": "Çalıştırma ayrıntıları yüklenemedi"
    }
  },
  "automations": {
    "eyebrow": "Ayarlar · Otomasyonlar",
    "title": "Otomasyonlar ve zamanlanmış görevler",
    "backAria": "Ayarlara dön",
    "heroCopy": "Şirketiniz için düzenli arka plan tetikleyicilerini, yinelenen cron işlerini ve otonom ajan görevlerini yapılandırın.",
    "selectCompanyAria": "Şirket seçin",
    "newAutomationBtn": "+ Yeni otomasyon",
    "stats": {
      "total": "toplam otomasyon",
      "totalDesc": "Zamanlanmış yapay zekâ arka plan işleri",
      "active": "etkin tetikleyici",
      "activeDesc": "Çalışan canlı cron planları",
      "paused": "duraklatılmış plan",
      "pausedDesc": "Beklemede / etkin olmayan tetikleyiciler",
      "assignedAgents": "atanmış ajan",
      "assignedAgentsDesc": "Yapılandırılmış ajan yürütücüleri"
    },
    "controls": {
      "searchPlaceholder": "Otomasyonları ad, açıklama, istem, cron ile filtrele...",
      "searchAriaLabel": "Otomasyonları filtrele",
      "clearSearch": "Aramayı temizle",
      "tabAll": "Tümü",
      "tabActive": "Etkin",
      "tabPaused": "Duraklatıldı"
    },
    "showingStatus": "{{total}} otomasyondan {{count}} tanesi gösteriliyor",
    "matchingQuery": "“{{query}}” ile eşleşen",
    "empty": {
      "noAutomationsTitle": "Otomasyon yapılandırılmadı",
      "noAutomationsDesc": "Bu şirket için otonom cron arka plan görevleri, düzenli pazar denetimleri veya günlük ajan iş akışları planlayın.",
      "createFirstBtn": "+ İlk otomasyonu oluştur",
      "noMatchingTitle": "Eşleşen otomasyon yok",
      "noMatchingDesc": "Aradığınızı bulmak için arama sorgusunu veya durum filtresini değiştirmeyi deneyin.",
      "clearFiltersBtn": "Filtreleri temizle"
    },
    "table": {
      "colStatus": "Durum",
      "colTask": "Görev ve talimatlar",
      "colSchedule": "Zamanlama (Cron)",
      "colAssignedAgent": "Atanan ajan",
      "colActions": "İşlemler",
      "statusActive": "ETKİN",
      "statusPaused": "DURAKLATILDI",
      "clickToPause": "Duraklatmak için tıklayın",
      "clickToActivate": "Etkinleştirmek için tıklayın",
      "promptPrefix": "İstem:",
      "nextRunPrefix": "Sonraki:",
      "mainAgent": "Ana ajan",
      "runNow": "▶ Şimdi çalıştır",
      "running": "Çalışıyor...",
      "runNowTitle": "Bu otomasyonu hemen çalıştır",
      "history": "Geçmiş",
      "historyTitle": "Çalıştırma geçmişini görüntüle",
      "edit": "Düzenle",
      "editTitle": "Otomasyon ayarlarını düzenle",
      "delete": "Sil",
      "deleteTitle": "Otomasyonu sil"
    },
    "presets": {
      "daily9": "Her gün 09:00",
      "daily18": "Her gün 18:00",
      "mondays9": "Pazartesi günleri 09:00",
      "fridays17": "Cuma günleri 17:00",
      "hourly": "Saatlik",
      "daily0": "Her gün 00:00"
    },
    "editor": {
      "kicker": "Otomasyonlar",
      "editTitle": "Otomasyonu düzenle",
      "newTitle": "Yeni otomasyon",
      "taskParamsHeading": "Görev parametreleri",
      "taskNameLabel": "Görev adı",
      "taskNamePlaceholder": "Ör. Günlük rakip analizi",
      "descLabel": "Açıklama",
      "descPlaceholder": "Bu otomasyonun gerçekleştirdikleri",
      "assignedAgentLabel": "Atanan ajan",
      "mainAgentDefault": "Ana ajan (varsayılan)",
      "schedulePresetsLabel": "Zamanlama hazır ayarları",
      "cronExpressionLabel": "Cron ifadesi (5 alan: dakika saat gün ay haftanın günü)",
      "cronPlaceholder": "0 9 * * *",
      "agentPromptLabel": "Ajan istemi",
      "agentPromptPlaceholder": "Ajanın gerçekleştirmesi gereken kesin amacı ve adımları açıklayın...",
      "saveBtn": "Otomasyonu kaydet",
      "savingBtn": "Kaydediliyor...",
      "deleteBtn": "Sil",
      "cancelBtn": "İptal"
    },
    "history": {
      "kicker": "Çalıştırma geçmişi",
      "loading": "Çalıştırma geçmişi yükleniyor...",
      "noRuns": "Henüz çalıştırma kaydı yok.",
      "duration": "Süre:",
      "finalResult": "✓ Sonuç:",
      "error": "Hata:"
    },
    "dialogs": {
      "deleteTitle": "Otomasyon silinsin mi?",
      "deleteMessage": "Bu otomasyonu silmek istediğinizden emin misiniz?",
      "deleteConfirm": "Sil",
      "deleteCancel": "İptal"
    },
    "notifications": {
      "runInitiated": "“{{name}}” için çalıştırma başlatıldı.",
      "resultReceived": "Sonuç alındı!",
      "runError": "Çalıştırma hatası: {{error}}"
    }
  }
} satisfies Pick<TranslationSchema, "capabilityInspector" | "activity" | "automations">;
