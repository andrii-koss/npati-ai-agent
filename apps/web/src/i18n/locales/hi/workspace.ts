import type { TranslationSchema } from "../../types";

export const workspace = {
  "goalsPage": {
    "eyebrow": "सेटिंग्स · लक्ष्य",
    "backToSettings": "सेटिंग्स पर वापस जाएँ",
    "title": "लक्ष्य और उद्देश्य",
    "heroCopy": "स्वचालित AI एजेंट को दिशा देने के लिए मापने योग्य परिणाम, मीट्रिक लक्ष्य और अहम पड़ाव तय करें।",
    "newGoal": "+ नया लक्ष्य",
    "stats": {
      "totalGoals": "कुल लक्ष्य",
      "totalGoalsDesc": "तय व्यावसायिक लक्ष्य",
      "activeOutcomes": "सक्रिय परिणाम",
      "activeOutcomesDesc": "एजेंट की जारी प्राथमिकताएँ",
      "completedGoals": "पूरे हुए लक्ष्य",
      "completedGoalsDesc": "हासिल किए पड़ाव",
      "highPriority": "उच्च प्राथमिकता",
      "highPriorityDesc": "अहम P1 उद्देश्य"
    },
    "searchPlaceholder": "शीर्षक, विवरण या मीट्रिक इकाई से लक्ष्य छाँटें...",
    "searchAria": "लक्ष्य छाँटें",
    "clearSearch": "खोज साफ़ करें",
    "tabs": {
      "all": "सभी",
      "active": "सक्रिय",
      "paused": "रुका हुआ",
      "completed": "पूरा हुआ"
    },
    "filterByPriority": "प्राथमिकता से छाँटें",
    "priorities": {
      "all": "सभी प्राथमिकताएँ",
      "high": "उच्च प्राथमिकता (P1)",
      "normal": "सामान्य प्राथमिकता (P2)",
      "low": "कम प्राथमिकता (P3)"
    },
    "priorityBadges": {
      "high": "उच्च P1",
      "normal": "सामान्य P2",
      "low": "कम P3"
    },
    "showingGoals": "{total} में से {count} लक्ष्य दिख रहे हैं",
    assignedAgent: "ज़िम्मेदार एजेंट",
    "matchingQuery": " \"{query}\" से मिलते परिणाम",
    "table": {
      "status": "स्थिति",
      "goalAndOutcome": "लक्ष्य और परिणाम",
      "progress": "प्रगति",
      "priority": "प्राथमिकता",
      "dueDate": "अंतिम तारीख",
      "actions": "कार्रवाइयाँ"
    },
    "statusTooltips": {
      "pause": "रोकने के लिए क्लिक करें",
      "resume": "फिर शुरू करने के लिए क्लिक करें",
      "reactivate": "फिर चालू करने के लिए क्लिक करें"
    },
    "statuses": {
      "active": "सक्रिय",
      "paused": "रुका हुआ",
      "completed": "पूरा हुआ",
      "cancelled": "रद्द"
    },
    "editGoalTooltip": "लक्ष्य बदलने के लिए क्लिक करें",
    "qualitativeGoal": "गुणात्मक लक्ष्य",
    "overdue": "समय सीमा पार",
    "actions": {
      "done": "✓ पूरा",
      "markCompleted": "लक्ष्य पूरा चिह्नित करें",
      "reopen": "फिर खोलें",
      "reopenTitle": "लक्ष्य फिर खोलें",
      "edit": "संपादित करें",
      "editTitle": "लक्ष्य पैरामीटर बदलें",
      "delete": "हटाएँ",
      "deleteTitle": "लक्ष्य हटाएँ"
    },
    "empty": {
      "noGoalsTitle": "अभी लक्ष्य सेट नहीं हैं",
      "noGoalsDesc": "स्पष्ट व्यावसायिक परिणाम, मीट्रिक लक्ष्य या रणनीतिक पड़ाव तय करें जिन्हें NPATI एजेंट स्वचालित रन और चैट सुझावों में प्राथमिकता दें।",
      "createFirstGoal": "+ पहला लक्ष्य बनाएँ",
      "noMatchingTitle": "कोई लक्ष्य नहीं मिला",
      "noMatchingDesc": "मनचाहे परिणाम के लिए खोज शब्द या फ़िल्टर बदलें।",
      "clearFilters": "फ़िल्टर साफ़ करें"
    },
    "drawer": {
      "kicker": "लक्ष्य",
      "editGoal": "लक्ष्य बदलें",
      "newGoal": "नया लक्ष्य",
      "close": "बंद करें",
      "objectiveSection": "लक्ष्य का उद्देश्य",
      "titleLabel": "लक्ष्य शीर्षक *",
      "titlePlaceholder": "जैसे, पहले 100 भुगतान करने वाले ग्राहक पाएँ",
      "descLabel": "विवरण / सफलता के मानदंड",
      "descPlaceholder": "सफलता कैसी होगी? एजेंट किन खास परिणामों के लिए काम कर रहे हैं?",
      "priorityStatusSection": "प्राथमिकता और स्थिति",
      "priorityLabel": "प्राथमिकता",
      "statusLabel": "स्थिति",
      "metricSection": "मीट्रिक ट्रैकिंग (वैकल्पिक)",
      "metricHint": "अगर लक्ष्य मापा और गिना जा सकता है, तो संख्यात्मक मान तय करें।",
      "targetValueLabel": "लक्षित मान",
      "targetValuePlaceholder": "जैसे 100",
      "currentValueLabel": "मौजूदा मान",
      "currentValuePlaceholder": "जैसे 42",
      "unitLabel": "इकाई",
      "unitPlaceholder": "जैसे $, उपयोगकर्ता, %",
      "dueDateSection": "लक्षित अंतिम तारीख",
      "deadlineLabel": "पड़ाव की समय सीमा",
      "cancel": "रद्द करें",
      "saving": "सहेजा जा रहा है...",
      "saveChanges": "लक्ष्य के बदलाव सहेजें",
      "createGoal": "लक्ष्य बनाएँ"
    },
    "notices": {
      "failedToLoad": "लक्ष्य लोड नहीं हुए: {message}",
      "titleRequired": "लक्ष्य का शीर्षक ज़रूरी है",
      "updatedSuccess": "लक्ष्य \"{title}\" सफलतापूर्वक अपडेट हुआ।",
      "createdSuccess": "लक्ष्य \"{title}\" सफलतापूर्वक बनाया गया।",
      "failedToSave": "लक्ष्य सहेजना विफल: {message}",
      "deletedSuccess": "लक्ष्य \"{title}\" हटाया गया।",
      "failedToDelete": "लक्ष्य हटाना विफल: {message}",
      "statusUpdated": "लक्ष्य \"{title}\" की स्थिति {status} हुई।",
      "statusUpdateError": "स्थिति अपडेट त्रुटि: {message}"
    },
    "dialogs": {
      "deleteTitle": "लक्ष्य हटाएँ?",
      "deleteMessage": "क्या लक्ष्य \"{title}\" हटाएँ?",
      "deleteConfirm": "हटाएँ",
      "deleteCancel": "रद्द करें"
    }
  },
  "contentPage": {
    "eyebrow": "सेटिंग्स · कंटेंट हब",
    "backToSettings": "सेटिंग्स पर वापस जाएँ",
    "title": "कंटेंट हब और निर्माण लाइब्रेरी",
    "heroCopy": "स्वचालित एजेंट के बनाए लेख, SEO योजनाएँ और सोशल ड्राफ़्ट देखें, संपादित करें, फ़ॉर्मैट करें और एक्सपोर्ट करें।",
    "newContentDraft": "+ नया कंटेंट ड्राफ़्ट",
    "newContentPrompt": "हमारे लक्षित दर्शकों के लिए असरदार मार्केटिंग लेख और सोशल वितरण योजना का ड्राफ़्ट बनाएँ।",
    "tabs": {
      "all": "सभी आइटम",
      "articles": "लेख",
      "seoBlueprints": "SEO योजनाएँ",
      "socialPosts": "सोशल पोस्ट",
      "briefsPlans": "ब्रीफ़ और योजनाएँ"
    },
    "searchPlaceholder": "ड्राफ़्ट, कीवर्ड, विषय खोजें...",
    "searchAria": "कंटेंट लाइब्रेरी खोजें",
    "clearSearch": "खोज साफ़ करें",
    "types": {
      "article": "लेख",
      "seoBlueprint": "SEO योजना",
      "socialMedia": "सोशल मीडिया",
      "briefPlan": "ब्रीफ़ और योजना"
    },
    "empty": {
      "readyTitle": "आपकी AI कंटेंट लाइब्रेरी तैयार है",
      "readyDesc": "कंपनी के स्वचालित एजेंट कंटेंट ब्रीफ़, कीवर्ड शोध या लेख निर्माण करते हैं, तो सभी बने ड्राफ़्ट यहाँ व्यवस्थित होते हैं।",
      "generateFirstDraft": "+ चैट में पहला ड्राफ़्ट बनाएँ",
      "chatPrompt": "हमारे आदर्श ग्राहक के लिए मुख्य बिंदुओं और FAQ वाला SEO ब्लॉग पोस्ट का ड्राफ़्ट बनाएँ।",
      "restoreDeleted": "हटाए दस्तावेज़ वापस लाएँ",
      "noMatchingTitle": "कोई दस्तावेज़ नहीं मिला",
      "noMatchingDesc": "खोज शब्द बदलें या अलग कंटेंट प्रकार चुनें।",
      "resetFilters": "फ़िल्टर रीसेट करें",
      "selectDoc": "पढ़ने या एक्सपोर्ट करने के लिए बाईं ओर से दस्तावेज़ चुनें।"
    },
    "cards": {
      "listAria": "बनाए दस्तावेज़ों की सूची",
      "deleteDocumentTitle": "दस्तावेज़ हटाएँ",
      "minRead": "लगभग {count} मिनट पढ़ने का समय"
    },
    "viewer": {
      "expand": "फैलाएँ",
      "collapse": "समेटें",
      "expandTitle": "पूरा दस्तावेज़ पढ़ने के लिए फैलाएँ",
      "collapseTitle": "सामान्य दृश्य में समेटें",
      "editDocument": "दस्तावेज़ बदलें",
      "views": {
        "preview": "पूर्वावलोकन",
        "previewTitle": "फ़ॉर्मैट किया पठन दृश्य",
        "raw": "कच्चा .md",
        "rawTitle": "कच्चा Markdown स्रोत"
      },
      "actions": {
        "edit": "✎ संपादित करें",
        "editTitle": "दस्तावेज़ का टेक्स्ट, शीर्षक और श्रेणी बदलें",
        "delete": "🗑 हटाएँ",
        "deleteTitle": "यह दस्तावेज़ हटाएँ",
        "copy": "कॉपी करें",
        "copied": "✓ कॉपी हुआ!",
        "copyTitle": "Markdown सामग्री क्लिपबोर्ड पर कॉपी करें",
        "download": ".md डाउनलोड करें",
        "downloadTitle": "Markdown फ़ाइल डाउनलोड करें",
        "saveChanges": "✓ बदलाव सहेजें",
        "saveChangesTitle": "अपने बदलाव सहेजें",
        "cancel": "रद्द करें",
        "cancelTitle": "संपादन रद्द करें"
      },
      "metrics": {
        "words": "शब्द",
        "characters": "अक्षर",
        "readTime": "पढ़ने का समय",
        "generatedDate": "निर्माण तारीख"
      },
      "editor": {
        "titleLabel": "दस्तावेज़ शीर्षक",
        "titlePlaceholder": "दस्तावेज़ शीर्षक लिखें...",
        "typeLabel": "कंटेंट प्रकार",
        "bodyLabel": "दस्तावेज़ टेक्स्ट (Markdown)",
        "saveHint": "सहेजने के लिए Ctrl+S दबाएँ",
        "bodyPlaceholder": "यहाँ Markdown दस्तावेज़ लिखें या बदलें..."
      },
      "overlay": {
        "expand": "पूरा दस्तावेज़ पढ़ने के लिए फैलाएँ",
        "collapse": "सामान्य दृश्य में समेटें"
      }
    },
    "toast": {
      "saved": "बदलाव सफलतापूर्वक सहेजे गए!",
      "saveError": "बदलाव सहेजे नहीं गए",
      "deleted": "दस्तावेज़ हटाया गया",
      "deleteError": "दस्तावेज़ हटाया नहीं गया"
    },
    "dialogs": {
      "deleteTitle": "कंटेंट हटाएँ?",
      "deleteMessage": "क्या \"{title}\" हटाएँ?",
      "deleteConfirm": "हटाएँ",
      "deleteCancel": "रद्द करें",
      "thisDocumentFallback": "यह दस्तावेज़"
    }
  },
  "connectionsPage": {
    "eyebrow": "बुनियादी ढाँचा और इंटीग्रेशन",
    "backToSettings": "सेटिंग्स पर वापस जाएँ",
    "title": "जुड़ी सेवाएँ",
    "heroCopy": "रनटाइम स्थिति, एंडपॉइंट और सभी स्टोरेज इंजन, आंतरिक AI अडैप्टर व सिस्टम माइक्रोसर्विस की स्थिति देखें।",
    "refreshStatus": "स्थिति रीफ़्रेश करें",
    "checkingStatus": "स्थिति जाँची जा रही है...",
    "refreshTitle": "सेवाओं के स्थिति एंडपॉइंट जाँचें",
    "lastSuccessfulCheck": "आखिरी सफल जाँच: {{time}}",
    "noSuccessfulCheck": "अभी कोई जाँच सफल नहीं हुई",
    "checkFailed": "स्थिति जाँच विफल — सेवाएँ उपलब्ध नहीं",
    "searchPlaceholder": "नाम, एंडपॉइंट या श्रेणी से सेवाएँ छाँटें...",
    "searchAria": "जुड़ी सेवाएँ छाँटें",
    "clearSearch": "खोज साफ़ करें",
    "tabs": {
      "all": "सभी",
      "internal": "आंतरिक",
      "storage": "स्टोरेज",
      "provider": "प्रदाता",
      "operational": "कार्यरत"
    },
    "categories": {
      "internal": "आंतरिक इंजन",
      "storage": "डेटा स्टोरेज",
      "provider": "क्लाउड प्रदाता"
    },
    "statuses": {
      "operational": "कार्यरत",
      "standby": "तैयार",
      "degraded": "कमज़ोर स्थिति",
      "down": "बंद"
    },
    "empty": {
      "title": "कोई सेवा नहीं मिली",
      "description": "खोज बदलें या अलग श्रेणी का फ़िल्टर चुनें।",
      "resetFilters": "फ़िल्टर रीसेट करें"
    },
    "card": {
      "copy": "कॉपी करें",
      "copied": "✓ कॉपी हुआ",
      "copyTitle": "कनेक्शन स्ट्रिंग कॉपी करें",
      "verifiedFallback": "Docker नेटवर्क में सत्यापित",
      "protocol": "HTTP / TCP"
    },
    "services": {
      "omniroute": {
        "name": "NPATI AI रूटिंग",
        "desc": "A2A संयोजन, कॉम्बो रूटिंग, फ़्यूज़न, पाइपलाइन और एम्बेडिंग इंजन (v3.8.52)।",
        "details": "v3.8.52 कोर",
        "versionPrefix": "संस्करण"
      },
      "postgres": {
        "name": "pgvector के साथ PostgreSQL",
        "desc": "कार्यक्षेत्र, कंपनियाँ, नॉलेज खंड और वेक्टर एम्बेडिंग का एकमात्र विश्वसनीय स्रोत।",
        "details": "वेक्टर एक्सटेंशन सक्रिय"
      },
      "redis": {
        "name": "Redis कैश और स्ट्रीम",
        "desc": "असिंक्रोनस कार्य कतार, लीज़, वितरित लॉक और बातचीत मेमोरी कैश।",
        "details": "इन-मेमोरी कैश सक्रिय"
      },
      "minio": {
        "name": "MinIO S3 स्टोरेज",
        "desc": "कंपनी नॉलेज अटैचमेंट और बाइनरी फ़ाइलों के लिए हर टेनेंट का अलग दस्तावेज़ स्टोर।",
        "details": "S3 अनुकूल API"
      },
      "crawler": {
        "name": "Crawl4AI वेब क्रॉलर",
        "desc": "गहरे वेब शोध का क्रॉलर, Markdown रूपांतरण और SSR रेंडर इंजन।",
        "details": "हेडलेस वर्कर पूल"
      },
      "coreBackend": {
        "name": "NPATI मुख्य बैकएंड",
        "desc": "प्रमाणीकरण, उपयोगकर्ता खाते और बिलिंग का एकमात्र विश्वसनीय स्रोत।",
        "details": "API गेटवे सक्रिय"
      },
      "cloudHub": {
        "name": "NPATI क्लाउड हब",
        "desc": "वैकल्पिक क्लाउड कैटलॉग सिंक और साझा मॉडल रजिस्ट्री।",
        "details": "स्थानीय तैनाती के लिए वैकल्पिक"
      }
    }
  },
  "memoryPage": {
    "eyebrow": "व्यावसायिक संदर्भ और नॉलेज",
    "backToSettings": "सेटिंग्स पर वापस जाएँ",
    "title": "व्यवसाय मेमोरी",
    "heroCopy": "स्थायी तथ्य, सत्यापित दर्शक प्रोफ़ाइल, ब्रांड लहजे के नियम और रणनीतिक फ़ैसले व्यवस्थित करें जिन्हें NPATI Agent सभी चैट व कार्यों में इस्तेमाल करता है।",
    "addFactBtn": "+ मेमोरी तथ्य जोड़ें",
    "addFactTitle": "नया व्यावसायिक तथ्य या फ़ैसला जोड़ें",
    "searchPlaceholder": "कीवर्ड, शीर्षक, तथ्य या स्रोत से मेमोरी खोजें...",
    "searchAria": "मेमोरी आइटम छाँटें",
    "clearSearch": "खोज साफ़ करें",
    "tabs": {
      "all": "सभी आइटम",
      "facts": "व्यावसायिक तथ्य",
      "audience": "दर्शक और आदर्श ग्राहक",
      "brand": "ब्रांड और लहजा",
      "decisions": "फ़ैसले और रणनीति",
      "product": "उत्पाद और सेवाएँ",
      "other": "अन्य"
    },
    "types": {
      "business_fact": "व्यावसायिक तथ्य",
      "audience": "दर्शक और आदर्श ग्राहक",
      "brand": "ब्रांड और लहजा",
      "decision": "रणनीतिक फ़ैसला",
      "product": "उत्पाद और सेवा",
      "channel": "मार्केटिंग चैनल",
      "preference": "उपयोगकर्ता प्राथमिकता",
      "experiment": "प्रयोग",
      "result": "परिणाम और मीट्रिक",
      "other": "अन्य नॉलेज"
    },
    "sources": {
      "manual": "मैन्युअल",
      "chatConfirmed": "चैट में पुष्ट",
      "onboarding": "शुरुआती सेटअप",
      "userVerified": "उपयोगकर्ता ने सत्यापित किया",
      "sourcePrefix": "स्रोत"
    },
    "empty": {
      "title": "अभी स्थायी मेमोरी आइटम नहीं हैं",
      "description": "अपने व्यवसाय, दर्शकों, ब्रांड लहजे या तय फ़ैसलों के मुख्य तथ्य जोड़ें। NPATI Agent चैट में उन्हें अपने आप याद रखेगा और तथ्य नहीं गढ़ेगा।",
      "addFirstBtn": "+ पहला तथ्य जोड़ें"
    },
    "emptyFiltered": {
      "title": "कोई मेमोरी नहीं मिली",
      "description": "खोज शब्द या श्रेणी फ़िल्टर बदलें।",
      "resetFilters": "फ़िल्टर रीसेट करें"
    },
    "card": {
      "verified": "✓ सत्यापित",
      "confidenceTooltip": "विश्वास स्कोर: {score}",
      "copy": "कॉपी करें",
      "copied": "✓ कॉपी हुआ",
      "copyTitle": "तथ्य की सामग्री कॉपी करें",
      "edit": "संपादित करें",
      "editTitle": "यह मेमोरी तथ्य बदलें",
      "delete": "हटाएँ",
      "deleteTitle": "यह मेमोरी तथ्य हटाएँ",
      "deleteFactTitle": "मेमोरी तथ्य हटाएँ"
    },
    "drawer": {
      "eyebrow": "व्यावसायिक नॉलेज",
      "editTitle": "मेमोरी तथ्य बदलें",
      "newTitle": "नया मेमोरी तथ्य",
      "closeAria": "बंद करें",
      "categorySection": "श्रेणी और वर्गीकरण",
      "typeLabel": "मेमोरी प्रकार *",
      "types": {
        "businessFact": "📌 व्यावसायिक तथ्य (संचालन नियम, मूल्य, तथ्य)",
        "audience": "🎯 लक्षित दर्शक और आदर्श ग्राहक (प्रोफ़ाइल, जनसांख्यिकी, समस्याएँ)",
        "brand": "✨ ब्रांड और लहजा (स्वर, शैली, स्थिति नियम)",
        "decision": "⚖️ रणनीतिक फ़ैसला (पुष्ट कार्ययोजना, विकल्प)",
        "product": "📦 उत्पाद और सेवा (प्रस्ताव, विवरण, सुविधाएँ)",
        "channel": "📢 मार्केटिंग चैनल (वितरण, प्लेटफ़ॉर्म)",
        "preference": "⚙️ उपयोगकर्ता प्राथमिकता (फ़ॉर्मैट, प्रॉम्प्ट निर्देश)",
        "experiment": "🧪 प्रयोग (विकास परीक्षण, सक्रिय धारणाएँ)",
        "result": "📈 परिणाम और मीट्रिक (नतीजे, सत्यापित निष्कर्ष)",
        "other": "📝 अन्य नॉलेज"
      },
      "detailsSection": "मेमोरी विवरण",
      "titleLabel": "शीर्षक *",
      "titlePlaceholder": "जैसे मुख्य लक्षित ग्राहक: यूरोप के B2B संस्थापक",
      "contentLabel": "तथ्य सामग्री / दिशानिर्देश *",
      "contentPlaceholder": "वे पुष्ट तथ्य, संख्याएँ, सीमाएँ या नियम लिखें जिनका NPATI Agent पालन करे...",
      "confidenceSection": "विश्वास स्तर",
      "confidenceLabel": "सत्यापन स्तर",
      "confidenceOptions": {
        "high100": "सत्यापित तथ्य (100% - निश्चित आधार)",
        "med80": "उच्च विश्वास (80% - ठोस अवलोकन)",
        "low50": "परिकल्पना (50% - जाँच जारी)"
      },
      "cancel": "रद्द करें",
      "saving": "तथ्य सहेजा जा रहा है...",
      "saveChanges": "बदलाव सहेजें",
      "saveFact": "मेमोरी तथ्य सहेजें",
      "errors": {
        "titleRequired": "शीर्षक ज़रूरी है",
        "contentRequired": "तथ्य की सामग्री का विवरण ज़रूरी है",
        "saveFailed": "मेमोरी आइटम सहेजना विफल"
      },
      "defaultBusinessName": "मेरा व्यवसाय"
    },
    "toasts": {
      "copied": "मेमोरी तथ्य क्लिपबोर्ड पर कॉपी हुआ",
      "updated": "मेमोरी आइटम अपडेट हुआ",
      "saved": "नया मेमोरी आइटम सहेजा गया",
      "deleted": "हटाया गया: \"{title}\"",
      "deleteError": "मेमोरी आइटम हटाया नहीं गया"
    },
    "dialogs": {
      "deleteTitle": "मेमोरी का तथ्य हटाएँ?",
      "deleteMessage": "मेमोरी आइटम \"{title}\" हटाएँ? इसे वापस नहीं लिया जा सकेगा।",
      "deleteConfirm": "हटाएँ",
      "deleteCancel": "रद्द करें"
    }
  },
  "skillsPage": {
    "eyebrow": "सेटिंग्स · कौशल",
    "backToSettings": "सेटिंग्स पर वापस जाएँ",
    "title": "एजेंट कौशल",
    "heroCopy": "अपने अनुरोधों के लिए NPATI Agent की अपने आप चुनी जाने वाली अंतर्निहित व्यावसायिक क्षमताएँ देखें।",
    "badgeBuiltin": "अंतर्निहित कैटलॉग",
    "stats": {
      "availableSkills": "उपलब्ध कौशल",
      "availableSkillsDesc": "दर्ज एजेंट वर्कफ़्लो",
      "capabilities": "क्षमताएँ",
      "capabilitiesDesc": "एजेंट की उपलब्ध कार्रवाइयाँ",
      "autoValue": "स्वचालित",
      "skillSelection": "कौशल चयन",
      "skillSelectionDesc": "अनुरोध और संदर्भ के अनुकूल"
    },
    "searchPlaceholder": "कौशल और क्षमताएँ खोजें...",
    "searchAria": "कौशल छाँटें",
    "clearSearch": "खोज साफ़ करें",
    "statusShowing": {
      "showing": "दिखाए जा रहे हैं",
      "of": "में से",
      "skills": "कौशल"
    },
    "errorLoading": "कौशल लोड नहीं हुए",
    "empty": {
      "title": "कोई कौशल नहीं मिला",
      "description": "दूसरा नाम, विवरण या क्षमता आज़माएँ।",
      "clearSearch": "खोज साफ़ करें"
    },
    "card": {
      "available": "उपलब्ध",
      "builtinType": "अंतर्निहित कौशल"
    },
    "skills": {
      "competitorAnalysis": {
        "name": "प्रतिस्पर्धी विश्लेषण",
        "desc": "प्रासंगिक प्रतिस्पर्धियों को खोजकर सार्वजनिक प्रमाण की तुलना मौजूदा व्यावसायिक संदर्भ से करता है।"
      },
      "webResearch": {
        "name": "वेब शोध",
        "desc": "NPATI की सुरक्षित वेब शोध सीमा के भीतर सार्वजनिक वेब स्रोत खोजता और पढ़ता है।"
      },
      "businessStartup": {
        "name": "व्यवसाय शुरुआत",
        "desc": "व्यवसाय का विचार, दर्शक, प्रस्ताव और पहली सत्यापन योजना बनाएँ।"
      },
      "businessGrowth": {
        "name": "व्यवसाय विकास",
        "desc": "ग्राहक पाने, बनाए रखने, बाज़ार में पहचान और विकास के व्यावहारिक अवसर खोजें।"
      },
      "sellProduct": {
        "name": "उत्पाद बेचें",
        "desc": "उत्पाद या सेवा को स्पष्ट प्रस्ताव और बिक्री योजना में बदलें।"
      }
    }
  }
} satisfies Pick<TranslationSchema, "goalsPage" | "contentPage" | "connectionsPage" | "memoryPage" | "skillsPage">;
