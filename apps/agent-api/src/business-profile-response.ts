import type { CompanyChatLanguage } from "./company-chat-i18n";
import { profileFields, type executeBusinessProfileTool } from "./business-profile-native";
import { businessProfileCardLabels } from "./business-profile-card-i18n";

type Outcome = Awaited<ReturnType<typeof executeBusinessProfileTool>>;
type Copy = { created: string; existing: string; updated: string; goal: string; memory: string; logo: string; incomplete: string; open: string };
const copy: Record<CompanyChatLanguage, Copy> = {
  en: { created: "Business Profile **{name}** was created and verified.", existing: "Business Profile **{name}** already exists; its supplied details were checked and updated.", updated: "Business Profile **{name}** was updated and verified.", goal: "Goal linked", memory: "Memory linked", logo: "Logo linked", incomplete: "Some requested details could not be verified", open: "Open Business Profile" },
  uk: { created: "Бізнес-профіль **{name}** створено й перевірено.", existing: "Бізнес-профіль **{name}** уже існує; надані дані перевірено й оновлено.", updated: "Бізнес-профіль **{name}** оновлено й перевірено.", goal: "Ціль прив’язано", memory: "Пам’ять прив’язано", logo: "Логотип прив’язано", incomplete: "Частину запитаних даних не вдалося перевірити", open: "Відкрити бізнес-профіль" },
  fr: { created: "Le profil d’entreprise **{name}** a été créé et vérifié.", existing: "Le profil d’entreprise **{name}** existe déjà ; les informations fournies ont été vérifiées et mises à jour.", updated: "Le profil d’entreprise **{name}** a été mis à jour et vérifié.", goal: "Objectif lié", memory: "Mémoire liée", logo: "Logo lié", incomplete: "Certaines informations demandées n’ont pas pu être vérifiées", open: "Ouvrir le profil" },
  de: { created: "Das Unternehmensprofil **{name}** wurde erstellt und geprüft.", existing: "Das Unternehmensprofil **{name}** besteht bereits; die Angaben wurden geprüft und aktualisiert.", updated: "Das Unternehmensprofil **{name}** wurde aktualisiert und geprüft.", goal: "Ziel verknüpft", memory: "Speicher verknüpft", logo: "Logo verknüpft", incomplete: "Einige angeforderte Angaben konnten nicht geprüft werden", open: "Profil öffnen" },
  es: { created: "Se creó y verificó el perfil empresarial **{name}**.", existing: "El perfil empresarial **{name}** ya existe; se comprobaron y actualizaron los datos proporcionados.", updated: "Se actualizó y verificó el perfil empresarial **{name}**.", goal: "Objetivo vinculado", memory: "Memoria vinculada", logo: "Logotipo vinculado", incomplete: "No se pudieron verificar algunos datos solicitados", open: "Abrir perfil" },
  it: { created: "Il profilo aziendale **{name}** è stato creato e verificato.", existing: "Il profilo aziendale **{name}** esiste già; i dati forniti sono stati verificati e aggiornati.", updated: "Il profilo aziendale **{name}** è stato aggiornato e verificato.", goal: "Obiettivo collegato", memory: "Memoria collegata", logo: "Logo collegato", incomplete: "Alcuni dati richiesti non sono stati verificati", open: "Apri profilo" },
  pl: { created: "Profil firmy **{name}** został utworzony i sprawdzony.", existing: "Profil firmy **{name}** już istnieje; podane dane sprawdzono i zaktualizowano.", updated: "Profil firmy **{name}** został zaktualizowany i sprawdzony.", goal: "Cel powiązany", memory: "Pamięć powiązana", logo: "Logo powiązane", incomplete: "Nie udało się potwierdzić części danych", open: "Otwórz profil" },
  pt: { created: "O perfil empresarial **{name}** foi criado e verificado.", existing: "O perfil empresarial **{name}** já existe; os dados fornecidos foram verificados e atualizados.", updated: "O perfil empresarial **{name}** foi atualizado e verificado.", goal: "Meta vinculada", memory: "Memória vinculada", logo: "Logo vinculado", incomplete: "Alguns dados solicitados não puderam ser verificados", open: "Abrir perfil" },
  nl: { created: "Bedrijfsprofiel **{name}** is aangemaakt en gecontroleerd.", existing: "Bedrijfsprofiel **{name}** bestaat al; de opgegeven gegevens zijn gecontroleerd en bijgewerkt.", updated: "Bedrijfsprofiel **{name}** is bijgewerkt en gecontroleerd.", goal: "Doel gekoppeld", memory: "Geheugen gekoppeld", logo: "Logo gekoppeld", incomplete: "Sommige gevraagde gegevens konden niet worden gecontroleerd", open: "Profiel openen" },
  tr: { created: "**{name}** işletme profili oluşturuldu ve doğrulandı.", existing: "**{name}** işletme profili zaten var; verilen bilgiler kontrol edilip güncellendi.", updated: "**{name}** işletme profili güncellendi ve doğrulandı.", goal: "Hedef bağlandı", memory: "Bellek bağlandı", logo: "Logo bağlandı", incomplete: "İstenen bazı bilgiler doğrulanamadı", open: "Profili aç" },
  ru: { created: "Бизнес-профиль **{name}** создан и проверен.", existing: "Бизнес-профиль **{name}** уже существует; предоставленные данные проверены и обновлены.", updated: "Бизнес-профиль **{name}** обновлён и проверен.", goal: "Цель связана", memory: "Память связана", logo: "Логотип связан", incomplete: "Часть запрошенных данных не удалось проверить", open: "Открыть профиль" },
  zh: { created: "已创建并核实 **{name}** 的业务资料。", existing: "**{name}** 的业务资料已存在；已核对并更新所提供的信息。", updated: "已更新并核实 **{name}** 的业务资料。", goal: "目标已关联", memory: "记忆已关联", logo: "徽标已关联", incomplete: "部分请求的信息无法核实", open: "打开业务资料" },
  ja: { created: "**{name}** のビジネスプロフィールを作成し、確認しました。", existing: "**{name}** のビジネスプロフィールは既に存在します。提供された情報を確認し、更新しました。", updated: "**{name}** のビジネスプロフィールを更新し、確認しました。", goal: "目標を関連付けました", memory: "メモリを関連付けました", logo: "ロゴを関連付けました", incomplete: "一部の情報を確認できませんでした", open: "プロフィールを開く" },
  ko: { created: "**{name}** 비즈니스 프로필을 만들고 확인했습니다.", existing: "**{name}** 비즈니스 프로필이 이미 있습니다. 제공된 정보를 확인하고 업데이트했습니다.", updated: "**{name}** 비즈니스 프로필을 업데이트하고 확인했습니다.", goal: "목표 연결됨", memory: "메모리 연결됨", logo: "로고 연결됨", incomplete: "요청한 일부 정보를 확인할 수 없습니다", open: "프로필 열기" },
  ar: { created: "تم إنشاء ملف الأعمال **{name}** والتحقق منه.", existing: "ملف الأعمال **{name}** موجود بالفعل؛ تم التحقق من البيانات المقدمة وتحديثها.", updated: "تم تحديث ملف الأعمال **{name}** والتحقق منه.", goal: "تم ربط الهدف", memory: "تم ربط الذاكرة", logo: "تم ربط الشعار", incomplete: "تعذر التحقق من بعض البيانات المطلوبة", open: "فتح الملف" },
  hi: { created: "**{name}** की व्यवसाय प्रोफ़ाइल बनाई और सत्यापित की गई।", existing: "**{name}** की व्यवसाय प्रोफ़ाइल पहले से मौजूद है; दी गई जानकारी जाँचकर अपडेट की गई।", updated: "**{name}** की व्यवसाय प्रोफ़ाइल अपडेट और सत्यापित की गई।", goal: "लक्ष्य जोड़ा गया", memory: "मेमोरी जोड़ी गई", logo: "लोगो जोड़ा गया", incomplete: "कुछ अनुरोधित जानकारी सत्यापित नहीं हो सकी", open: "प्रोफ़ाइल खोलें" },
};
/** The label of the company the new Business Profile was linked to (the company selected in chat). */
const linkedCompanyLabel: Record<CompanyChatLanguage, string> = {
  en: "Linked to company", uk: "Прив’язано до компанії", fr: "Lié à l’entreprise", de: "Mit Unternehmen verknüpft", es: "Vinculado a la empresa",
  it: "Collegato all’azienda", pl: "Powiązano z firmą", pt: "Vinculado à empresa", nl: "Gekoppeld aan bedrijf", tr: "Şirkete bağlandı",
  ru: "Привязан к компании", zh: "已关联到公司", ja: "会社に関連付けました", ko: "회사에 연결됨", ar: "تم الربط بالشركة", hi: "कंपनी से जोड़ा गया",
};

export function businessProfileChatMessage(outcome: Outcome, language: CompanyChatLanguage, createdThisTurn: boolean, missingPlannedFields: string[] = []): string {
  const t = copy[language] ?? copy.en;
  const missing = [...new Set([...outcome.missingFields, ...outcome.missingGoals, ...outcome.missingMemories, ...missingPlannedFields])];
  const complete = outcome.complete && missing.length === 0;
  const state = createdThisTurn ? t.created : outcome.action === "create" && outcome.alreadyExisted ? t.existing : t.updated;
  const label = businessProfileCardLabels(language);
  const escape = (value: string) => value.replace(/```/g, "'''").trim();
  const lines = ["```card:" + label.title + ": " + escape(outcome.businessName)];
  if (complete) lines.push(state.replace("{name}", escape(outcome.businessName)), "");
  for (const field of profileFields) {
    if (missing.includes(field)) continue;
    const value = outcome.savedFields[field];
    if (value) lines.push(`**${label.fields[field]}:** ${escape(value)}`);
  }
  if (outcome.goalIds.length) lines.push("", `**${t.goal}:** ${outcome.goalTitles.map(escape).join("; ") || outcome.goalIds.length}`);
  if (outcome.memoryIds.length) lines.push(`**${t.memory}:** ${outcome.memoryFacts.map(escape).join("; ") || outcome.memoryIds.length}`);
  if (outcome.logoFileId) lines.push(`**${t.logo}**`);
  const linkedCompanyName = (outcome as Outcome & { linkedCompanyName?: string }).linkedCompanyName;
  if (linkedCompanyName) lines.push(`**${linkedCompanyLabel[language] ?? linkedCompanyLabel.en}:** ${escape(linkedCompanyName)}`);
  if (!complete) { const unresolved = missing.map((item) => item in label.fields ? label.fields[item as keyof typeof label.fields] : item === "goal" ? t.goal : item === "memory" ? t.memory : item); lines.push("", `**${t.incomplete}**${unresolved.length ? `: ${unresolved.join(", ")}` : ""}`); }
  lines.push("", `[${t.open}](/settings/business/${encodeURIComponent(outcome.businessId)})`, "```");
  return lines.join("\n");
}
export function summarizeBusinessProfileChat(metadata: Record<string, unknown>[], language: CompanyChatLanguage, plan?: { provided_fields: Record<string, string>; secondary_actions: string[] }) {
  const outcomes = metadata.filter((item) => item.kind === "business_profile" && item.outcome).map((item) => item.outcome as Outcome);
  const latest = outcomes.at(-1);
  if (!latest) return undefined;
  const related = outcomes.filter((item) => item.businessId === latest.businessId);
  const savedFields = Object.assign({}, ...related.map((item) => item.savedFields)) as Record<string, string>;
  const goalIds = [...new Set(related.flatMap((item) => item.goalIds))];
  const memoryIds = [...new Set(related.flatMap((item) => item.memoryIds))];
  const outcome = { ...latest, savedFields, goalIds, memoryIds, goalTitles: [...new Set(related.flatMap((item) => item.goalTitles))], memoryFacts: [...new Set(related.flatMap((item) => item.memoryFacts))] };
  const missing = Object.keys(plan?.provided_fields ?? {}).filter((key) => savedFields[key] === undefined);
  const actions = (plan?.secondary_actions ?? []).join(" ").toLowerCase();
  if (/goal/.test(actions) && !goalIds.length) missing.push("goal");
  if (/memor/.test(actions) && !memoryIds.length) missing.push("memory");
  const createdThisTurn = related.some((item) => item.action === "create" && !item.alreadyExisted);
  return { outcome, createdThisTurn, message: businessProfileChatMessage(outcome, language, createdThisTurn, missing) };
}
