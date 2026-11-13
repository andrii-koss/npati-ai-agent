import { ptExecutionTrace, additionalExecutionTrace } from "./locales/request-execution";
import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from "react";
import type { SupportedLanguage, LanguageInfo } from "./types";
import { SUPPORTED_LANGUAGES } from "./types";
import { dictionaries } from "./dictionaries";

const STORAGE_KEY = "npati_language";

interface I18nContextType {
  language: SupportedLanguage;
  languageInfo: LanguageInfo;
  supportedLanguages: LanguageInfo[];
  changeLanguage: (lang: SupportedLanguage) => void;
  t: (path: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | null>(null);

/**
 * The context itself, for a consumer that must be renderable **outside** a provider.
 *
 * `useTranslation` throws outside its provider, which is right for a page and wrong for a presentational panel
 * this repository's Node-only web test project renders directly (no jsdom, no provider harness). Reading the
 * context with `useContext` is always called, so such a component can fall back to an injected resolver without
 * ever making a hook call conditional.
 */
export const I18nContextRef = I18nContext;

function getInitialLanguage(): SupportedLanguage {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as SupportedLanguage | null;
    if (saved && Object.hasOwn(dictionaries, saved)) {
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

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  }, [language]);

  const changeLanguage = useCallback((newLang: SupportedLanguage) => {
    if (Object.hasOwn(dictionaries, newLang)) {
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
          // Half of the locales write placeholders as {name}; Goals, Content and Memory showed them raw (V6 step 11).
          // Double braces first, so {{name}} never becomes {value}.
          template = template.replace(new RegExp(`{{${key}}}`, "g"), () => String(val)).replace(new RegExp(`{${key}}`, "g"), () => String(val));
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

/** Reuse the same dictionaries for request-language activity without changing UI preferences. */
export function executionTraceText(language: string, key: string) {
  const requestText = language === "pt" ? ptExecutionTrace[key] : additionalExecutionTrace[language]?.[key];
  return requestText ?? dictionaries[language as SupportedLanguage]?.executionTrace[key] ?? dictionaries.en.executionTrace[key] ?? key;
}
