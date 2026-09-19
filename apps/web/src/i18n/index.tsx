import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from "react";
import type { SupportedLanguage, TranslationSchema, LanguageInfo } from "./types";
import { SUPPORTED_LANGUAGES } from "./types";
import { en } from "./locales/en";
import { uk } from "./locales/uk";
import { de } from "./locales/de";
import { fr } from "./locales/fr";
import { es } from "./locales/es";
import { it } from "./locales/it";
import { pl } from "./locales/pl";

const dictionaries: Record<SupportedLanguage, TranslationSchema> = {
  en,
  uk,
  de,
  fr,
  es,
  it,
  pl,
};

const STORAGE_KEY = "npati_language";

interface I18nContextType {
  language: SupportedLanguage;
  languageInfo: LanguageInfo;
  supportedLanguages: LanguageInfo[];
  changeLanguage: (lang: SupportedLanguage) => void;
  t: (path: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | null>(null);

function getInitialLanguage(): SupportedLanguage {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as SupportedLanguage | null;
    if (saved && dictionaries[saved]) {
      return saved;
    }
  } catch {
    // ignore
  }
  return "en";
}

function getNestedValue(obj: any, path: string): string | undefined {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<SupportedLanguage>(getInitialLanguage);

  const changeLanguage = useCallback((newLang: SupportedLanguage) => {
    if (dictionaries[newLang]) {
      setLanguage(newLang);
      try {
        localStorage.setItem(STORAGE_KEY, newLang);
      } catch {
        // ignore
      }
    }
  }, []);

  const languageInfo =
    SUPPORTED_LANGUAGES.find((item) => item.code === language) || SUPPORTED_LANGUAGES[0]!;

  const t = useCallback(
    (path: string, params?: Record<string, string | number>): string => {
      const currentDict = dictionaries[language];
      let template = getNestedValue(currentDict, path);

      // Fallback to English if missing in current language
      if (!template && language !== "en") {
        template = getNestedValue(dictionaries.en, path);
      }

      if (!template) {
        return path;
      }

      if (params) {
        for (const [key, val] of Object.entries(params)) {
          template = template.replace(new RegExp(`{{${key}}}`, "g"), String(val));
        }
      }

      return template;
    },
    [language]
  );

  return (
    <I18nContext.Provider
      value={{
        language,
        languageInfo,
        supportedLanguages: SUPPORTED_LANGUAGES,
        changeLanguage,
        t,
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useTranslation must be used within an I18nProvider");
  }
  return context;
}

export { SUPPORTED_LANGUAGES };
export type { SupportedLanguage };
