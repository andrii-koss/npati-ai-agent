import type { TranslationSchema } from "../../types";

export const workspace = {
  "goalsPage": {
    "eyebrow": "Ayarlar · Hedefler",
    "backToSettings": "Ayarlara dön",
    "title": "Hedefler ve amaçlar",
    "heroCopy": "Otonom yapay zekâ ajanlarını yönlendirmek için ölçülebilir sonuçlar, metrik hedefleri ve öncelikli kilometre taşları tanımlayın.",
    "newGoal": "+ Yeni hedef",
    "stats": {
      "totalGoals": "toplam hedef",
      "totalGoalsDesc": "Tanımlanmış işletme hedefleri",
      "activeOutcomes": "etkin sonuç",
      "activeOutcomesDesc": "Devam eden ajan öncelikleri",
      "completedGoals": "tamamlanan hedef",
      "completedGoalsDesc": "Ulaşılan kilometre taşları",
      "highPriority": "yüksek öncelik",
      "highPriorityDesc": "Kritik P1 amaçları"
    },
    "searchPlaceholder": "Hedefleri başlık, açıklama veya ölçü birimine göre filtrele...",
    "searchAria": "Hedefleri filtrele",
    "clearSearch": "Aramayı temizle",
    "tabs": {
      "all": "Tümü",
      "active": "Etkin",
      "paused": "Duraklatıldı",
      "completed": "Tamamlandı"
    },
    "filterByPriority": "Önceliğe göre filtrele",
    "priorities": {
      "all": "Tüm öncelikler",
      "high": "Yüksek öncelik (P1)",
      "normal": "Normal öncelik (P2)",
      "low": "Düşük öncelik (P3)"
    },
    "priorityBadges": {
      "high": "Yüksek P1",
      "normal": "Normal P2",
      "low": "Düşük P3"
    },
    "showingGoals": "{total} hedeften {count} tanesi gösteriliyor",
    "matchingQuery": " “{query}” ile eşleşen",
    "table": {
      "status": "Durum",
      "goalAndOutcome": "Hedef ve sonuç",
      "progress": "İlerleme",
      "priority": "Öncelik",
      "dueDate": "Son tarih",
      "actions": "İşlemler"
    },
    "statusTooltips": {
      "pause": "Duraklatmak için tıklayın",
      "resume": "Sürdürmek için tıklayın",
      "reactivate": "Yeniden etkinleştirmek için tıklayın"
    },
    "statuses": {
      "active": "ETKİN",
      "paused": "DURAKLATILDI",
      "completed": "TAMAMLANDI",
      "cancelled": "İPTAL EDİLDİ"
    },
    "editGoalTooltip": "Hedefi düzenlemek için tıklayın",
    "qualitativeGoal": "Nitel hedef",
    "overdue": "Süresi geçmiş",
    "actions": {
      "done": "✓ Bitti",
      "markCompleted": "Hedefi tamamlandı olarak işaretle",
      "reopen": "Yeniden aç",
      "reopenTitle": "Hedefi yeniden aç",
      "edit": "Düzenle",
      "editTitle": "Hedef parametrelerini düzenle",
      "delete": "Sil",
      "deleteTitle": "Hedefi sil"
    },
    "empty": {
      "noGoalsTitle": "Henüz hedef yapılandırılmadı",
      "noGoalsDesc": "NPATI ajanlarının otonom yürütme ve sohbet önerilerinde öncelik vermesi için somut işletme sonuçları, metrik hedefleri veya stratejik kilometre taşları tanımlayın.",
      "createFirstGoal": "+ İlk hedefi oluştur",
      "noMatchingTitle": "Eşleşen hedef yok",
      "noMatchingDesc": "Aradığınızı bulmak için arama terimlerini veya filtre seçimini değiştirmeyi deneyin.",
      "clearFilters": "Filtreleri temizle"
    },
    "drawer": {
      "kicker": "Hedefler",
      "editGoal": "Hedefi düzenle",
      "newGoal": "Yeni hedef",
      "close": "Kapat",
      "objectiveSection": "Hedefin amacı",
      "titleLabel": "Hedef başlığı *",
      "titlePlaceholder": "Ör. İlk 100 ödeme yapan müşteriyi edinmek",
      "descLabel": "Açıklama / Başarı ölçütleri",
      "descPlaceholder": "Başarı neye benziyor? Ajanlar hangi belirli sonuçlara ulaşmaya çalışıyor?",
      "priorityStatusSection": "Öncelik ve durum",
      "priorityLabel": "Öncelik",
      "statusLabel": "Durum",
      "metricSection": "Metrik takibi (isteğe bağlı)",
      "metricHint": "Bu hedef nicel olarak ölçülüp izlenebiliyorsa sayısal hedefler belirtin.",
      "targetValueLabel": "Hedef değer",
      "targetValuePlaceholder": "Ör. 100",
      "currentValueLabel": "Geçerli değer",
      "currentValuePlaceholder": "Ör. 42",
      "unitLabel": "Birim",
      "unitPlaceholder": "Ör. $, kullanıcı, %",
      "dueDateSection": "Hedef son tarihi",
      "deadlineLabel": "Kilometre taşı son tarihi",
      "cancel": "İptal",
      "saving": "Kaydediliyor...",
      "saveChanges": "Hedef değişikliklerini kaydet",
      "createGoal": "Hedef oluştur"
    },
    "notices": {
      "failedToLoad": "Hedefler yüklenemedi: {message}",
      "titleRequired": "Hedef başlığı gereklidir",
      "updatedSuccess": "“{title}” hedefi başarıyla güncellendi.",
      "createdSuccess": "“{title}” hedefi başarıyla oluşturuldu.",
      "failedToSave": "Hedef kaydedilemedi: {message}",
      "deletedSuccess": "“{title}” hedefi silindi.",
      "failedToDelete": "Hedef silinemedi: {message}",
      "statusUpdated": "“{title}” hedefinin durumu {status} olarak güncellendi.",
      "statusUpdateError": "Durum güncelleme hatası: {message}"
    },
    "dialogs": {
      "deleteTitle": "Hedef silinsin mi?",
      "deleteMessage": "“{title}” hedefini silmek istediğinizden emin misiniz?",
      "deleteConfirm": "Sil",
      "deleteCancel": "İptal"
    }
  },
  "contentPage": {
    "eyebrow": "Ayarlar · İçerik merkezi",
    "backToSettings": "Ayarlara dön",
    "title": "İçerik merkezi ve üretim kütüphanesi",
    "heroCopy": "Otonom ajanların oluşturduğu makaleleri, SEO planlarını ve sosyal medya taslaklarını inceleyin, düzenleyin, biçimlendirin ve dışa aktarın.",
    "newContentDraft": "+ Yeni içerik taslağı",
    "newContentPrompt": "Hedef kitlemiz için etkili bir pazarlama makalesi ve sosyal medya dağıtım planı hazırlayın.",
    "tabs": {
      "all": "Tüm öğeler",
      "articles": "Makaleler",
      "seoBlueprints": "SEO planları",
      "socialPosts": "Sosyal medya gönderileri",
      "briefsPlans": "Özetler ve planlar"
    },
    "searchPlaceholder": "Taslak, anahtar kelime veya konu ara...",
    "searchAria": "İçerik kütüphanesinde ara",
    "clearSearch": "Aramayı temizle",
    "types": {
      "article": "Makale",
      "seoBlueprint": "SEO planı",
      "socialMedia": "Sosyal medya",
      "briefPlan": "Özet ve plan"
    },
    "empty": {
      "readyTitle": "Yapay zekâ içerik kütüphaneniz hazır",
      "readyDesc": "Otonom şirket ajanları içerik özetleri, anahtar kelime araştırması veya makale oluşturma görevlerini yürüttüğünde, üretilen tüm taslaklar burada düzenlenir.",
      "generateFirstDraft": "+ Sohbette ilk taslağı oluştur",
      "chatPrompt": "İdeal müşteri profilimize yönelik, önemli çıkarımlar ve SSS içeren bir SEO blog yazısı hazırlayın.",
      "restoreDeleted": "Silinen belgeleri geri yükle",
      "noMatchingTitle": "Eşleşen belge yok",
      "noMatchingDesc": "Arama terimlerinizi değiştirmeyi veya farklı bir içerik türü filtresi seçmeyi deneyin.",
      "resetFilters": "Filtreleri sıfırla",
      "selectDoc": "Okumak veya dışa aktarmak için soldan bir belge seçin."
    },
    "cards": {
      "listAria": "Oluşturulan belgeler listesi",
      "deleteDocumentTitle": "Belgeyi sil",
      "minRead": "~{count} dk okuma"
    },
    "viewer": {
      "expand": "Genişlet",
      "collapse": "Daralt",
      "expandTitle": "Belgenin tamamını okumak için genişlet",
      "collapseTitle": "Standart görünüme daralt",
      "editDocument": "Belgeyi düzenle",
      "views": {
        "preview": "Önizleme",
        "previewTitle": "Biçimlendirilmiş okuma görünümü",
        "raw": "Ham .md",
        "rawTitle": "Ham Markdown kaynağı"
      },
      "actions": {
        "edit": "✎ Düzenle",
        "editTitle": "Belge metnini, başlığını ve kategorisini düzenle",
        "delete": "🗑 Sil",
        "deleteTitle": "Bu belgeyi sil",
        "copy": "Kopyala",
        "copied": "✓ Kopyalandı!",
        "copyTitle": "Markdown içeriğini panoya kopyala",
        "download": ".md indir",
        "downloadTitle": "Markdown dosyası olarak indir",
        "saveChanges": "✓ Değişiklikleri kaydet",
        "saveChangesTitle": "Değişikliklerinizi kaydedin",
        "cancel": "İptal",
        "cancelTitle": "Düzenlemeyi iptal et"
      },
      "metrics": {
        "words": "kelime",
        "characters": "karakter",
        "readTime": "okuma süresi",
        "generatedDate": "oluşturulma tarihi"
      },
      "editor": {
        "titleLabel": "Belge başlığı",
        "titlePlaceholder": "Belge başlığı girin...",
        "typeLabel": "İçerik türü",
        "bodyLabel": "Belge metni (Markdown)",
        "saveHint": "Kaydetmek için Ctrl+S tuşlarına basın",
        "bodyPlaceholder": "Markdown belge metnini buraya yazın veya düzenleyin..."
      },
      "overlay": {
        "expand": "Belgenin tamamını okumak için genişlet",
        "collapse": "Standart görünüme daralt"
      }
    },
    "toast": {
      "saved": "Değişiklikler başarıyla kaydedildi!",
      "saveError": "Değişiklikler kaydedilemedi",
      "deleted": "Belge silindi",
      "deleteError": "Belge silinemedi"
    },
    "dialogs": {
      "deleteTitle": "İçerik silinsin mi?",
      "deleteMessage": "“{title}” öğesini silmek istediğinizden emin misiniz?",
      "deleteConfirm": "Sil",
      "deleteCancel": "İptal",
      "thisDocumentFallback": "bu belge"
    }
  },
  "connectionsPage": {
    "eyebrow": "Altyapı ve entegrasyonlar",
    "backToSettings": "Ayarlara dön",
    "title": "Bağlı hizmetler",
    "heroCopy": "Tüm depolama motorlarının, dahili yapay zekâ adaptörlerinin ve sistem mikro hizmetlerinin çalışma sağlığını, uç noktalarını ve durumunu izleyin.",
    "refreshStatus": "Durumu yenile",
    "checkingStatus": "Durum kontrol ediliyor...",
    "refreshTitle": "Hizmet sağlık uç noktalarını yokla",
    "lastSuccessfulCheck": "Son başarılı kontrol: {{time}}",
    "noSuccessfulCheck": "Henüz başarılı kontrol yok",
    "checkFailed": "Sağlık kontrolü başarısız — hizmetler kullanılamıyor",
    "searchPlaceholder": "Hizmetleri ada, uç noktaya veya kategoriye göre filtrele...",
    "searchAria": "Bağlı hizmetleri filtrele",
    "clearSearch": "Aramayı temizle",
    "tabs": {
      "all": "Tümü",
      "internal": "Dahili",
      "storage": "Depolama",
      "provider": "Sağlayıcı",
      "operational": "Çalışır durumda"
    },
    "categories": {
      "internal": "Dahili motor",
      "storage": "Veri depolama",
      "provider": "Bulut sağlayıcısı"
    },
    "statuses": {
      "operational": "Çalışır durumda",
      "standby": "Beklemede",
      "degraded": "Performansı düşük",
      "down": "Çalışmıyor"
    },
    "empty": {
      "title": "Eşleşen hizmet yok",
      "description": "Arama sorgusunu değiştirmeyi veya farklı bir kategori filtresi seçmeyi deneyin.",
      "resetFilters": "Filtreleri sıfırla"
    },
    "card": {
      "copy": "Kopyala",
      "copied": "✓ Kopyalandı",
      "copyTitle": "Bağlantı dizesini kopyala",
      "verifiedFallback": "Docker ağında doğrulandı",
      "protocol": "HTTP / TCP"
    },
    "services": {
      "omniroute": {
        "name": "NPATI yapay zekâ yönlendirmesi",
        "desc": "A2A koordinasyonu, birleşik yönlendirme, birleştirme, işlem hattı ve gömme motoru (v3.8.52).",
        "details": "v3.8.52 çekirdeği",
        "versionPrefix": "Sürüm"
      },
      "postgres": {
        "name": "pgvector ile PostgreSQL",
        "desc": "Çalışma alanları, şirketler, bilgi parçaları ve vektör gömmeleri için tek güvenilir veri kaynağı.",
        "details": "Vektör uzantısı etkin"
      },
      "redis": {
        "name": "Redis önbelleği ve akışları",
        "desc": "Eşzamansız görev kuyrukları, kiralamalar, dağıtılmış kilitler ve konuşma belleği önbelleği.",
        "details": "Bellek içi önbellek etkin"
      },
      "minio": {
        "name": "MinIO S3 depolaması",
        "desc": "Şirket bilgi ekleri ve ikili varlıklar için kiracıya göre yalıtılmış belge deposu.",
        "details": "S3 uyumlu API"
      },
      "crawler": {
        "name": "Crawl4AI web tarayıcısı",
        "desc": "Derin web araştırma tarayıcısı, Markdown dönüşümü ve SSR işleme motoru.",
        "details": "Başsız çalışan havuzu"
      },
      "coreBackend": {
        "name": "NPATI çekirdek arka ucu",
        "desc": "Kimlik doğrulama, kullanıcı hesapları ve faturalandırma için tek güvenilir veri kaynağı.",
        "details": "API ağ geçidi etkin"
      },
      "cloudHub": {
        "name": "NPATI bulut merkezi",
        "desc": "İsteğe bağlı bulut katalog eşitlemesi ve paylaşılan model kayıt sistemi.",
        "details": "Yerel dağıtım için isteğe bağlı"
      }
    }
  },
  "memoryPage": {
    "eyebrow": "İşletme bağlamı ve bilgi",
    "backToSettings": "Ayarlara dön",
    "title": "İşletme belleği",
    "heroCopy": "NPATI Agent'ın tüm sohbetlerde ve görevlerde kullandığı kalıcı bilgileri, doğrulanmış kitle profillerini, marka sesi kurallarını ve stratejik kararları düzenleyin.",
    "addFactBtn": "+ Bellek bilgisi ekle",
    "addFactTitle": "Yeni bir işletme bilgisi veya karar ekleyin",
    "searchPlaceholder": "Belleği anahtar kelime, başlık, bilgi içeriği veya kaynağa göre ara...",
    "searchAria": "Bellek öğelerini filtrele",
    "clearSearch": "Aramayı temizle",
    "tabs": {
      "all": "Tüm öğeler",
      "facts": "İşletme bilgileri",
      "audience": "Kitle ve ideal müşteri profili",
      "brand": "Marka ve ses",
      "decisions": "Kararlar ve strateji",
      "product": "Ürünler ve hizmetler",
      "other": "Diğer"
    },
    "types": {
      "business_fact": "İşletme bilgisi",
      "audience": "Kitle ve ideal müşteri profili",
      "brand": "Marka ve ses",
      "decision": "Stratejik karar",
      "product": "Ürün ve hizmet",
      "channel": "Pazarlama kanalı",
      "preference": "Kullanıcı tercihi",
      "experiment": "Deney",
      "result": "Sonuç ve metrik",
      "other": "Diğer bilgiler"
    },
    "sources": {
      "manual": "Elle",
      "chatConfirmed": "Sohbette doğrulandı",
      "onboarding": "Başlangıç kurulumu",
      "userVerified": "Kullanıcı doğruladı",
      "sourcePrefix": "Kaynak"
    },
    "empty": {
      "title": "Henüz kalıcı bellek öğesi yok",
      "description": "İşletmeniz, hedef kitleniz, marka tonunuz veya alınan kararlarla ilgili temel bilgileri ekleyin. NPATI Agent bunları sohbet akıl yürütmesinde bilgi uydurmadan otomatik olarak hatırlar.",
      "addFirstBtn": "+ İlk bilgiyi ekle"
    },
    "emptyFiltered": {
      "title": "Eşleşen bellek yok",
      "description": "Arama anahtar kelimelerini veya kategori filtrelerini değiştirmeyi deneyin.",
      "resetFilters": "Filtreleri sıfırla"
    },
    "card": {
      "verified": "✓ Doğrulandı",
      "confidenceTooltip": "Güven puanı: {score}",
      "copy": "Kopyala",
      "copied": "✓ Kopyalandı",
      "copyTitle": "Bilgi içeriğini kopyala",
      "edit": "Düzenle",
      "editTitle": "Bu bellek bilgisini düzenle",
      "delete": "Sil",
      "deleteTitle": "Bu bellek bilgisini sil",
      "deleteFactTitle": "Bellek bilgisini sil"
    },
    "drawer": {
      "eyebrow": "İşletme bilgisi",
      "editTitle": "Bellek bilgisini düzenle",
      "newTitle": "Yeni bellek bilgisi",
      "closeAria": "Kapat",
      "categorySection": "Kategori ve sınıflandırma",
      "typeLabel": "Bellek türü *",
      "types": {
        "businessFact": "📌 İşletme bilgisi (çalışma kuralları, fiyatlandırma, bilgiler)",
        "audience": "🎯 Hedef kitle ve ideal müşteri profili (personalar, demografi, sorunlar)",
        "brand": "✨ Marka ve ses (ton, ses, konumlandırma kuralları)",
        "decision": "⚖️ Stratejik karar (doğrulanmış yol haritası, seçimler)",
        "product": "📦 Ürün ve hizmet (sunulanlar, özellikler, işlevler)",
        "channel": "📢 Pazarlama kanalı (dağıtım, platformlar)",
        "preference": "⚙️ Kullanıcı tercihi (biçim, istem talimatları)",
        "experiment": "🧪 Deney (büyüme testleri, etkin hipotezler)",
        "result": "📈 Sonuç ve metrik (çıktılar, doğrulanmış bulgular)",
        "other": "📝 Diğer bilgiler"
      },
      "detailsSection": "Bellek ayrıntıları",
      "titleLabel": "Başlık *",
      "titlePlaceholder": "Ör. Ana hedef müşteri: Avrupa'daki B2B kurucuları",
      "contentLabel": "Bilgi içeriği / Yönergeler *",
      "contentPlaceholder": "NPATI Agent'ın uyması gereken doğrulanmış bilgileri, sayıları, sınırları veya kuralları ayrıntılandırın...",
      "confidenceSection": "Güven düzeyi",
      "confidenceLabel": "Doğrulama düzeyi",
      "confidenceOptions": {
        "high100": "Doğrulanmış bilgi (%100 - Kesin doğru kural)",
        "med80": "Yüksek güven (%80 - Güçlü gözlem)",
        "low50": "Hipotez (%50 - Araştırılıyor)"
      },
      "cancel": "İptal",
      "saving": "Bilgi kaydediliyor...",
      "saveChanges": "Değişiklikleri kaydet",
      "saveFact": "Bellek bilgisini kaydet",
      "errors": {
        "titleRequired": "Başlık gereklidir",
        "contentRequired": "Bilgi içeriği açıklaması gereklidir",
        "saveFailed": "Bellek öğesi kaydedilemedi"
      },
      "defaultBusinessName": "İşletmem"
    },
    "toasts": {
      "copied": "Bellek bilgisi panoya kopyalandı",
      "updated": "Bellek öğesi güncellendi",
      "saved": "Yeni bellek öğesi kaydedildi",
      "deleted": "Silindi: “{title}”",
      "deleteError": "Bellek öğesi silinemedi"
    },
    "dialogs": {
      "deleteTitle": "Bellek bilgisi silinsin mi?",
      "deleteMessage": "“{title}” bellek öğesi silinsin mi? Bu işlem geri alınamaz.",
      "deleteConfirm": "Sil",
      "deleteCancel": "İptal"
    }
  },
  "skillsPage": {
    "eyebrow": "Ayarlar · Beceriler",
    "backToSettings": "Ayarlara dön",
    "title": "Ajan becerileri",
    "heroCopy": "NPATI Agent'ın istekleriniz için otomatik seçtiği yerleşik işletme yeteneklerini inceleyin.",
    "badgeBuiltin": "Yerleşik katalog",
    "stats": {
      "availableSkills": "kullanılabilir beceri",
      "availableSkillsDesc": "Kayıtlı ajan iş akışları",
      "capabilities": "yetenek",
      "capabilitiesDesc": "Ajana sunulan işlemler",
      "autoValue": "Otomatik",
      "skillSelection": "beceri seçimi",
      "skillSelectionDesc": "İstek ve bağlamla eşleştirilir"
    },
    "searchPlaceholder": "Becerileri ve yetenekleri ara...",
    "searchAria": "Becerileri filtrele",
    "clearSearch": "Aramayı temizle",
    "statusShowing": {
      "showing": "Gösterilen",
      "of": "/",
      "skills": "beceri"
    },
    "errorLoading": "Beceriler yüklenemedi",
    "empty": {
      "title": "Eşleşen beceri yok",
      "description": "Başka bir ad, açıklama veya yetenek deneyin.",
      "clearSearch": "Aramayı temizle"
    },
    "card": {
      "available": "Kullanılabilir",
      "builtinType": "Yerleşik beceri"
    },
    "skills": {
      "competitorAnalysis": {
        "name": "Rakip analizi",
        "desc": "İlgili rakipleri bulur ve kamuya açık kanıtları geçerli işletme bağlamıyla karşılaştırır."
      },
      "webResearch": {
        "name": "Web araştırması",
        "desc": "Korumalı NPATI Web Research sınırı üzerinden kamuya açık web kaynaklarını arar ve okur."
      },
      "businessStartup": {
        "name": "İşletme başlangıcı",
        "desc": "Bir iş fikrini, kitleyi, teklifi ve ilk doğrulama planını şekillendirin."
      },
      "businessGrowth": {
        "name": "İşletme büyümesi",
        "desc": "Uygulanabilir müşteri edinme, elde tutma, konumlandırma ve büyüme fırsatları bulun."
      },
      "sellProduct": {
        "name": "Ürün satışı",
        "desc": "Bir ürünü veya hizmeti anlaşılır bir teklife ve satış planına dönüştürün."
      }
    }
  }
} satisfies Pick<TranslationSchema, "goalsPage" | "contentPage" | "connectionsPage" | "memoryPage" | "skillsPage">;
