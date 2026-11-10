import type { TranslationSchema } from "../../types";

export const activity = {
  "capabilityInspector": {
    "eyebrow": "शासन और सुरक्षा",
    "title": "क्षमता निरीक्षक",
    "backAria": "सेटिंग्स पर वापस जाएँ",
    "modelProfiles": {
      "title": "मॉडल प्रोफ़ाइल: सुरक्षित वैकल्पिक मोड।",
      "emptyHint": "इस संदर्भ में कोई code.model_profile.<id> फ़्लैग चालू नहीं है, इसलिए हर रन सुरक्षित प्रोफ़ाइल इस्तेमाल करता है (एक बार में एक टूल कॉल, टूल कॉलिंग की स्वचालित पहचान), भले ही मॉडल {{count}} रजिस्ट्री प्रोफ़ाइल में से किसी से मिले। रोलआउट शुरू करने के लिए इस तैनाती में अनुमत प्रोफ़ाइल के फ़्लैग चालू करें।"
    },
    "heroCopy": "NPATI Agent की 306 मानक क्षमताएँ देखें और जाँचें। वास्तविक रनटाइम में Effective Capability Resolver की सीमाएँ, टूल दृश्यता और जोखिम नीतियाँ जाँचें।",
    "stats": {
      "totalLabel": "कुल क्षमताएँ",
      "totalDesc": "सत्यापित 1..306 मानक ID",
      "agentCallableLabel": "एजेंट द्वारा कॉल योग्य",
      "agentCallableDesc": "Resolver से मॉडल को उपलब्ध",
      "runtimeOnlyLabel": "आंतरिक रनटाइम",
      "runtimeOnlyDesc": "अलग इंजन कार्रवाइयाँ",
      "requiresApprovalLabel": "मंज़ूरी चाहिए",
      "requiresApprovalDesc": "मानवीय समीक्षा वाला सुरक्षा चरण"
    },
    "slices": {
      "all": "सभी",
      "agentCallable": "एजेंट के लिए उपलब्ध",
      "runtimeOnly": "सिर्फ़ रनटाइम",
      "userVisible": "उपयोगकर्ता को दिखाई देता है",
      "automatic": "स्वचालित",
      "allowed": "अनुमत",
      "requiresApproval": "मंज़ूरी चाहिए"
    },
    "controls": {
      "searchPlaceholder": "नाम, ID या क्षेत्र से क्षमताएँ छाँटें...",
      "searchAriaLabel": "क्षमताएँ छाँटें",
      "clearSearch": "खोज साफ़ करें",
      "showing": "{{total}} में से {{start}}–{{end}} क्षमताएँ दिख रही हैं",
      "matching": "\"{{term}}\" से मिलते परिणाम",
      "copied": "✓ {{id}} कॉपी हुआ",
      "perPage": "प्रति पेज:",
      "allCount": "सभी ({{total}})"
    },
    "table": {
      "colId": "ID",
      "sortId": "ID से क्रमबद्ध करें",
      "colName": "नाम",
      "sortName": "नाम से क्रमबद्ध करें",
      "colCanonicalId": "मानक ID",
      "sortCanonicalId": "मानक ID से क्रमबद्ध करें",
      "colDomain": "क्षेत्र",
      "sortDomain": "क्षेत्र से क्रमबद्ध करें",
      "colType": "प्रकार",
      "sortType": "प्रकार से क्रमबद्ध करें",
      "colCallable": "कॉल योग्य",
      "colRisk": "जोखिम",
      "sortRisk": "जोखिम से क्रमबद्ध करें",
      "colStatus": "स्थिति",
      "sortStatus": "स्थिति से क्रमबद्ध करें",
      "copyTooltip": "मानक ID कॉपी करने के लिए क्लिक करें",
      "empty": "चुने फ़िल्टर से कोई क्षमता नहीं मिली।",
      "prev": "← पिछला",
      "next": "अगला →"
    },
    "callable": {
      "callable": "कॉल योग्य",
      "internal": "आंतरिक"
    },
    "risks": {
      "low": "कम",
      "medium": "मध्यम",
      "high": "उच्च",
      "critical": "गंभीर"
    },
    "statuses": {
      "verified": "सत्यापित",
      "partial": "आंशिक",
      "notImplemented": "लागू नहीं",
      "blocked": "अवरुद्ध",
      "allowed": "अनुमत",
      "denied": "अस्वीकृत",
      "unavailable": "उपलब्ध नहीं",
      "requiresApproval": "मंज़ूरी ज़रूरी"
    },
    "types": {
      "runtime": "रनटाइम",
      "config": "कॉन्फ़िगरेशन",
      "orchestr": "संयोजन",
      "tool": "टूल",
      "article": "लेख",
      "secOps": "सुरक्षा संचालन"
    },
    "connectedServices": "जुड़ी सेवाएँ",
    "errorLoad": "क्षमताएँ लोड नहीं हुईं",
    "integrations": {
      "kicker": "सत्यापित उत्पाद इंटीग्रेशन",
      "title": "लागू संदेश चैनल",
      "manage": "इंटीग्रेशन प्रबंधित करें",
      "sharedRuntime": "साझा NPATI Agent रनटाइम",
      "loading": "इंटीग्रेशन की स्थिति लोड हो रही है...",
      "notice": "Agent API जुड़ने पर इंटीग्रेशन की स्थिति उपलब्ध होती है।"
    }
  },
  "activity": {
    "eyebrow": "निगरानी और ऑडिट",
    "title": "गतिविधि और रन ट्रेस",
    "backAria": "सेटिंग्स पर वापस जाएँ",
    "heroCopy": "कंपनी एजेंट रन में लाइव विस्तृत रन ट्रेस, सौंपे कदम, टूल कॉल, विलंब और सुरक्षा फ़ैसले।",
    "stats": {
      "totalRuns": "कुल रन",
      "totalRunsDesc": "दर्ज एजेंट रन",
      "completed": "पूरा हुआ",
      "completedDesc": "बिना त्रुटि सफल",
      "inProgress": "चल रहा / कतार में",
      "inProgressDesc": "सक्रिय एजेंट कार्य",
      "securityDecisions": "सुरक्षा फ़ैसले",
      "securityDecisionsDesc": "ऑडिट की गई टूल जाँच"
    },
    "controls": {
      "companyLabel": "कंपनी:",
      "all": "सभी",
      "completed": "पूरा हुआ",
      "running": "चल रहा है",
      "failed": "विफल",
      "searchPlaceholder": "कार्य या ID से रन खोजें...",
      "searchAriaLabel": "रन खोजें",
      "clearSearch": "खोज साफ़ करें",
      "refresh": "रीफ़्रेश करें",
      "refreshing": "रीफ़्रेश हो रहा है...",
      "refreshTitle": "रन रीफ़्रेश करें"
    },
    "dispatch": {
      "title": "कंपनी एजेंट को कार्य भेजें",
      "subtitle": "कई एजेंट वाला स्वचालित कार्य शुरू करें और लाइव ट्रेस देखें",
      "modeLabel": "रन मोड:",
      "modes": {
        "auto": "स्वचालित संयोजन (अनुकूलनीय)",
        "pipeline": "पाइपलाइन (कई एजेंट)",
        "single": "एक एजेंट (तेज़)",
        "fusion": "फ़्यूज़न (कई मॉडल)"
      },
      "placeholderWithCompany": "{{name}} के एजेंट के लिए कार्य लिखें (जैसे 'प्रतिस्पर्धियों के प्रस्ताव और कीमतें जाँचें')...",
      "placeholderDefault": "कंपनी एजेंट के लिए कार्य का प्रॉम्प्ट लिखें...",
      "dispatchTask": "कार्य भेजें",
      "dispatching": "भेजा जा रहा है...",
      "presetsLabel": "तैयार विकल्प:",
      "presets": {
        "marketAuditLabel": "बाज़ार और प्रतिस्पर्धी ऑडिट",
        "marketAuditPrompt": "प्रतिस्पर्धियों पर विस्तृत शोध और बाज़ार स्थिति का विश्लेषण करें",
        "securityAuditLabel": "सुरक्षा और क्षमता सत्यापन",
        "securityAuditPrompt": "कंपनी टूल की अनुमति, API पहुँच नियम और सुरक्षा चरण जाँचें",
        "growthRoadmapLabel": "रणनीतिक विकास की कार्ययोजना",
        "growthRoadmapPrompt": "लक्षित ग्राहक की प्रोफ़ाइल और 90 दिन की व्यावहारिक विकास योजना बनाएँ"
      },
      "dispatchedNotice": "रन भेजा गया: {{id}} ({{status}})",
      "dispatchFailed": "एजेंट रन भेजना विफल"
    },
    "empty": {
      "noCompaniesTitle": "कोई कंपनी नहीं मिली",
      "noCompaniesCopy": "गतिविधि और रन ट्रेस AI कंपनी संदर्भ में भेजे गए कई एजेंट वाले रन दर्ज करता है।",
      "createCompanyBtn": "AI कंपनी बनाएँ",
      "noRunsTitle": "अभी कोई रन दर्ज नहीं है",
      "presetsTitle": "तैयार कार्य और शुरुआती परिदृश्य",
      "noRunsCopy": "इस कंपनी में कोई एजेंट रन नहीं भेजा गया। लाइव ट्रेस, सौंपे कदम और सुरक्षा ऑडिट बनाने के लिए ऊपर कार्य भेजें या तैयार विकल्प चुनें।",
      "presetsCopy": "लाइव ट्रेस, सौंपे कदम और टूल सुरक्षा ऑडिट बनाने के लिए नीचे तैयार विकल्प चुनें या ऊपर अपना कार्य लिखें।",
      "dispatchPresetBtn": "भेजें: {{label}} →",
      "viewTraceBtn": "रन इतिहास और ट्रेस देखें ({{count}}) →"
    },
    "sidebar": {
      "recentExecutions": "हाल के रन ({{count}})",
      "backToPresets": "← 3 तैयार विकल्प",
      "noFilteredRuns": "मौजूदा फ़िल्टर से कोई रन नहीं मिला।",
      "clearFiltersBtn": "फ़िल्टर साफ़ करें"
    },
    "trace": {
      "backToPresetsAria": "तैयार विकल्पों पर लौटें",
      "modePrefix": "मोड: {{mode}}",
      "comboPrefix": "संयोजन: {{name}}",
      "runIdLabel": "रन ID:",
      "copy": "कॉपी करें",
      "copied": "कॉपी हुआ",
      "copyRunIdTitle": "रन ID कॉपी करें",
      "startedLabel": "शुरू हुआ:",
      "completedLabel": "पूरा हुआ:",
      "durationLabel": "अवधि:",
      "finalOutput": "अंतिम आउटपुट",
      "copyResultTitle": "परिणाम कॉपी करें",
      "executionFault": "रन में त्रुटि",
      "completionReportTitle": "बैकग्राउंड कार्य पूरा होने की रिपोर्ट",
      "attemptSummary": "कोशिश {{attempt}} · {{tokens}} टोकन · ${{cost}} · {{duration}} सेकंड",
      "timelineTitle": "बैकग्राउंड रन की समयरेखा ({{count}})",
      "timelineDesc": "स्थायी वर्कर क्लेम, दोबारा कोशिश और अंतिम समापन घटनाएँ",
      "attemptLabel": "कोशिश {{attempt}}",
      "synchronousNotice": "यह रन सीधे चला था; बैकग्राउंड वर्कर की घटनाएँ जारी नहीं हुईं।",
      "delegationTitle": "एजेंट कार्य वितरण पाइपलाइन ({{count}})",
      "delegationDesc": "कई एजेंट की भूमिकाओं और कार्य हस्तांतरण का संयोजन",
      "agentPrefix": "एजेंट: {{id}}",
      "modelPrefix": "मॉडल:",
      "lanePrefix": "लेन: {{lane}}",
      "noStepsNotice": "इस एक दौर वाले कार्य में सौंपे गए कदम दर्ज नहीं हैं।",
      "toolsTitle": "टूल रन और सुरक्षा नीति चरण ({{count}})",
      "toolsDesc": "मानक क्षमता Resolver की जाँच और सुरक्षा ऑडिट",
      "policyReason": "नीति का कारण:",
      "noToolsNotice": "इस रन में बाहरी टूल कॉल नहीं हुए।",
      "selectRunTitle": "जाँचने के लिए रन चुनें",
      "selectRunCopy": "समयरेखा, सौंपे कदम और सुरक्षा ऑडिट देखने के लिए बाएँ पैनल से रन चुनें।"
    },
    "errors": {
      "loadRunsFailed": "गतिविधि लोड नहीं हुई",
      "loadRunDetailsFailed": "रन विवरण लोड नहीं हुआ"
    }
  },
  "automations": {
    "eyebrow": "सेटिंग्स · ऑटोमेशन",
    "title": "ऑटोमेशन और शेड्यूल किए कार्य",
    "backAria": "सेटिंग्स पर वापस जाएँ",
    "heroCopy": "कंपनी के लिए नियमित बैकग्राउंड ट्रिगर, दोहराए जाने वाले cron कार्य और स्वचालित एजेंट कार्य सेट करें।",
    "selectCompanyAria": "कंपनी चुनें",
    "newAutomationBtn": "+ नया ऑटोमेशन",
    "stats": {
      "total": "कुल ऑटोमेशन",
      "totalDesc": "शेड्यूल किए गए बैकग्राउंड AI कार्य",
      "active": "सक्रिय ट्रिगर",
      "activeDesc": "सक्रिय cron शेड्यूल",
      "paused": "रुके हुए शेड्यूल",
      "pausedDesc": "तैयार / निष्क्रिय ट्रिगर",
      "assignedAgents": "नियुक्त एजेंट",
      "assignedAgentsDesc": "कॉन्फ़िगर किए एजेंट रनर"
    },
    "controls": {
      "searchPlaceholder": "नाम, विवरण, प्रॉम्प्ट या cron से ऑटोमेशन छाँटें...",
      "searchAriaLabel": "ऑटोमेशन छाँटें",
      "clearSearch": "खोज साफ़ करें",
      "tabAll": "सभी",
      "tabActive": "सक्रिय",
      "tabPaused": "रुका हुआ"
    },
    "showingStatus": "{{total}} में से {{count}} ऑटोमेशन दिख रहे हैं",
    "matchingQuery": "\"{{query}}\" से मिलते परिणाम",
    "empty": {
      "noAutomationsTitle": "कोई ऑटोमेशन सेट नहीं है",
      "noAutomationsDesc": "इस कंपनी के लिए स्वचालित बैकग्राउंड cron कार्य, नियमित बाज़ार ऑडिट या रोज़ाना एजेंट वर्कफ़्लो शेड्यूल करें।",
      "createFirstBtn": "+ पहला ऑटोमेशन बनाएँ",
      "noMatchingTitle": "कोई ऑटोमेशन नहीं मिला",
      "noMatchingDesc": "मनचाहे परिणाम के लिए खोज या स्थिति फ़िल्टर बदलें।",
      "clearFiltersBtn": "फ़िल्टर साफ़ करें"
    },
    "table": {
      "colStatus": "स्थिति",
      "colTask": "कार्य और निर्देश",
      "colSchedule": "शेड्यूल (Cron)",
      "colAssignedAgent": "नियुक्त एजेंट",
      "colActions": "कार्रवाइयाँ",
      "statusActive": "सक्रिय",
      "statusPaused": "रुका हुआ",
      "clickToPause": "रोकने के लिए क्लिक करें",
      "clickToActivate": "चालू करने के लिए क्लिक करें",
      "promptPrefix": "प्रॉम्प्ट:",
      "nextRunPrefix": "अगला:",
      "mainAgent": "मुख्य एजेंट",
      "runNow": "▶ अभी चलाएँ",
      "running": "चल रहा है...",
      "runNowTitle": "यह ऑटोमेशन तुरंत चलाएँ",
      "history": "इतिहास",
      "historyTitle": "रन इतिहास देखें",
      "edit": "संपादित करें",
      "editTitle": "ऑटोमेशन सेटिंग्स बदलें",
      "delete": "हटाएँ",
      "deleteTitle": "ऑटोमेशन हटाएँ"
    },
    "presets": {
      "daily9": "रोज़ 09:00 बजे",
      "daily18": "रोज़ 18:00 बजे",
      "mondays9": "हर सोमवार 09:00 बजे",
      "fridays17": "हर शुक्रवार 17:00 बजे",
      "hourly": "हर घंटे",
      "daily0": "रोज़ 00:00 बजे"
    },
    "editor": {
      "kicker": "ऑटोमेशन",
      "editTitle": "ऑटोमेशन बदलें",
      "newTitle": "नया ऑटोमेशन",
      "taskParamsHeading": "कार्य पैरामीटर",
      "taskNameLabel": "कार्य का नाम",
      "taskNamePlaceholder": "जैसे, रोज़ाना प्रतिस्पर्धी विश्लेषण",
      "descLabel": "विवरण",
      "descPlaceholder": "यह ऑटोमेशन क्या करता है",
      "assignedAgentLabel": "नियुक्त एजेंट",
      "mainAgentDefault": "मुख्य एजेंट (डिफ़ॉल्ट)",
      "schedulePresetsLabel": "तैयार शेड्यूल",
      "cronExpressionLabel": "Cron अभिव्यक्ति (5 फ़ील्ड: मिनट घंटा दिन महीना सप्ताह का दिन)",
      "cronPlaceholder": "0 9 * * *",
      "agentPromptLabel": "एजेंट प्रॉम्प्ट",
      "agentPromptPlaceholder": "सटीक उद्देश्य और एजेंट के किए जाने वाले कदम लिखें...",
      "saveBtn": "ऑटोमेशन सहेजें",
      "savingBtn": "सहेजा जा रहा है...",
      "deleteBtn": "हटाएँ",
      "cancelBtn": "रद्द करें"
    },
    "history": {
      "kicker": "रन इतिहास",
      "loading": "रन इतिहास लोड हो रहा है...",
      "noRuns": "अभी कोई रन दर्ज नहीं है।",
      "duration": "अवधि:",
      "finalResult": "✓ अंतिम परिणाम:",
      "error": "त्रुटि:"
    },
    "dialogs": {
      "deleteTitle": "ऑटोमेशन हटाएँ?",
      "deleteMessage": "क्या आप यह ऑटोमेशन हटाना चाहते हैं?",
      "deleteConfirm": "हटाएँ",
      "deleteCancel": "रद्द करें"
    },
    "notifications": {
      "runInitiated": "\"{{name}}\" का रन शुरू हुआ।",
      "resultReceived": "परिणाम मिला!",
      "runError": "रन त्रुटि: {{error}}"
    }
  }
} satisfies Pick<TranslationSchema, "capabilityInspector" | "activity" | "automations">;
