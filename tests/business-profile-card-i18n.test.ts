import { describe, expect, it } from "vitest";
import type { CompanyChatLanguage } from "../apps/agent-api/src/company-chat-i18n";
import { profileFields } from "../apps/agent-api/src/business-profile-native";
import { businessProfileCardLabels, businessProfileCardLabelRows } from "../apps/agent-api/src/business-profile-card-i18n";
import { businessProfileChatMessage } from "../apps/agent-api/src/business-profile-response";

const languages: CompanyChatLanguage[] = ["en", "uk", "fr", "de", "es", "it", "pl", "pt", "nl", "tr", "ru", "zh", "ja", "ko", "ar", "hi"];
const titles: Record<CompanyChatLanguage, string> = {
  en: "Business Profile", uk: "Бізнес-профіль", fr: "Profil d’entreprise", de: "Unternehmensprofil",
  es: "Perfil empresarial", it: "Profilo aziendale", pl: "Profil firmy", pt: "Perfil empresarial",
  nl: "Bedrijfsprofiel", tr: "İşletme profili", ru: "Бизнес-профиль", zh: "企业资料",
  ja: "事業プロフィール", ko: "비즈니스 프로필", ar: "الملف التجاري", hi: "व्यवसाय प्रोफ़ाइल",
};

describe("Business Profile card localization", () => {
  it.each(languages)("renders all profile field labels and the card title in %s", (language) => {
    const labels = businessProfileCardLabels(language);
    expect(businessProfileCardLabelRows[language]).toHaveLength(profileFields.length + 1);
    expect(labels.title).toBe(titles[language]);
    expect(Object.keys(labels.fields)).toEqual([...profileFields]);
    expect(Object.values(labels.fields).every((value) => Boolean(value?.trim()))).toBe(true);
    if (language !== "en") expect(labels.fields.name).not.toBe("Business name");

    const outcome = {
      complete: true, action: "create" as const, alreadyExisted: false,
      businessId: "business-1", businessName: "NovaScale Labs",
      savedFields: Object.fromEntries(profileFields.map((field) => [field, "Value"])),
      goalIds: [], memoryIds: [], goalTitles: [], memoryFacts: [], logoFileId: null,
      missingFields: [], missingGoals: [], missingMemories: [],
    };
    const card = businessProfileChatMessage(outcome, language, true);

    expect(card).toContain(`\`\`\`card:${titles[language]}: NovaScale Labs`);
    for (const field of profileFields) expect(card).toContain(`**${labels.fields[field]}:** Value`);
    expect(card).toContain("[");
    const partial = businessProfileChatMessage({ ...outcome, complete: false, missingFields: ["contactEmail"] }, language, true);
    expect(partial).toContain(labels.fields.contactEmail);
    expect(partial).not.toContain("contactEmail");
  });
});