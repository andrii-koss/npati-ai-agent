import { CircleHelp } from "lucide-react";
import { useContext } from "react";
import { I18nContextRef } from "./i18n";
import type { SupportedLanguage } from "./i18n/types";

export const PAGE_GUIDES = {
  ai: "how-to-connect-ai-providers-in-npati-ai-agent",
  integrations: "how-to-connect-telegram-whatsapp-discord-and-slack-to-npati-ai-agent",
  business: "how-to-create-a-business-profile-in-npati-ai-agent",
  company: "how-to-create-an-ai-company-and-agents-in-npati-ai-agent",
  capabilities: "how-to-use-capability-inspector-in-npati-ai-agent",
  activity: "how-to-use-activity-and-run-trace-in-npati-ai-agent",
  automations: "how-to-create-automations-in-npati-ai-agent",
  email: "how-to-set-up-email-and-ai-inbox-in-npati-ai-agent",
  goals: "how-to-create-business-goals-in-npati-ai-agent",
  content: "how-to-manage-ai-content-in-npati-ai-agent",
  connections: "how-to-check-connected-services-in-npati-ai-agent",
  memory: "how-to-use-business-memory-in-npati-ai-agent",
  skills: "how-to-use-skills-in-npati-ai-agent",
} as const;

const labels: Record<SupportedLanguage, string> = {
  en: "Open instructions (new tab)", uk: "Відкрити інструкцію (нова вкладка)",
  de: "Anleitung öffnen (neuer Tab)", fr: "Ouvrir le guide (nouvel onglet)",
  es: "Abrir la guía (nueva pestaña)", it: "Apri la guida (nuova scheda)",
  pl: "Otwórz instrukcję (nowa karta)", pt: "Abrir instruções (nova aba)",
  nl: "Handleiding openen (nieuw tabblad)", tr: "Kılavuzu aç (yeni sekme)",
  ru: "Открыть инструкцию (новая вкладка)", zh: "打开使用指南（新标签页）",
  ja: "ガイドを開く（新しいタブ）", ko: "사용 안내 열기 (새 탭)",
  ar: "فتح الدليل (علامة تبويب جديدة)", hi: "निर्देश खोलें (नया टैब)",
};

export function PageGuideLink({ guide }: { guide: keyof typeof PAGE_GUIDES }) {
  const language = useContext(I18nContextRef)?.language ?? "en";
  const label = labels[language] ?? labels.en;
  return <a className="page-guide-link" href={`https://en.npati.com/${PAGE_GUIDES[guide]}/`}
    target="_blank" rel="noopener noreferrer" aria-label={label} title={label}>
    <CircleHelp size={20} strokeWidth={1.8} aria-hidden="true" />
  </a>;
}
