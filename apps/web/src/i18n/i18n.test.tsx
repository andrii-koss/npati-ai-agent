// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dictionaries } from "./dictionaries";
import { I18nProvider, executionTraceText, useTranslation } from "./index";
import { SUPPORTED_LANGUAGES } from "./types";
import { LanguageSwitcher } from "../LanguageSwitcher";

const addedLanguages = ["pt", "nl", "tr", "ru", "zh", "ja", "ko", "ar", "hi"] as const;

function flatten(value: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof item === "string" ? [[path, item]] : Object.entries(flatten(item, path));
  }));
}

function placeholders(value: string) {
  return (value.match(/\{\{?\w+\}?\}/g) ?? []).sort();
}

describe("interface language catalogues", () => {
  it("offers exactly the same sixteen languages as the chat", () => {
    const chatSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../agent-api/src/company-chat-i18n.ts"), "utf8");
    const chatLanguageType = chatSource.match(/export type CompanyChatLanguage = ([^;]+);/)![1]!;
    const chatLanguages = Array.from(chatLanguageType.matchAll(/"([a-z]+)"/g), match => match[1]);
    expect(SUPPORTED_LANGUAGES.map(item => item.code).sort()).toEqual(chatLanguages.sort());
    expect(SUPPORTED_LANGUAGES).toHaveLength(16);
    expect(new Set(SUPPORTED_LANGUAGES.map(item => item.code)).size).toBe(16);
    expect(Object.keys(dictionaries).sort()).toEqual(SUPPORTED_LANGUAGES.map(item => item.code).sort());
  });

  it("keeps every added locale file within the 800-line limit", () => {
    for (const language of addedLanguages) {
      const localesDirectory = join(dirname(fileURLToPath(import.meta.url)), "locales");
      const directory = join(localesDirectory, language);
      const files = [join(localesDirectory, `${language}.ts`),
        ...readdirSync(directory).map(name => join(directory, name))];
      for (const file of files) {
        const lines = readFileSync(file, "utf8").trimEnd().split(/\r?\n/).length;
        expect(lines, file).toBeLessThanOrEqual(800);
      }
    }
  });

  for (const language of addedLanguages) {
    it(`${language}: covers every English key and preserves template variables`, () => {
      const reference = flatten(dictionaries.en);
      const translated = flatten(dictionaries[language]);
      expect(Object.keys(translated).sort()).toEqual(Object.keys(reference).sort());
      for (const [path, value] of Object.entries(reference)) {
        expect(translated[path]?.trim(), `${language}:${path}`).toBeTruthy();
        expect(placeholders(translated[path]!), `${language}:${path}`).toEqual(placeholders(value));
        expect(translated[path]!.match(/<\/?strong>/g) ?? [], `${language}:${path} markup`)
          .toEqual(value.match(/<\/?strong>/g) ?? []);
        if (value.length > 40) {
          expect(translated[path], `${language}:${path} must not retain an English sentence`).not.toBe(value);
        }
      }
      // Technical labels may stay the same, but an English copy is not a translation.
      const localized = Object.keys(reference).filter(path => translated[path] !== reference[path]);
      expect(localized.length / Object.keys(reference).length).toBeGreaterThan(0.8);
    });
  }

  it("resolves new request activity labels without changing interface preferences", () => {
    localStorage.setItem("npati_language", "uk");
    for (const language of addedLanguages) {
      // This key is absent from the older request-only dictionaries.
      expect(executionTraceText(language, "modelResponding")).toBe(dictionaries[language].executionTrace.modelResponding);
    }
    expect(localStorage.getItem("npati_language")).toBe("uk");
    expect(executionTraceText("unknown", "modelResponding")).toBe(dictionaries.en.executionTrace.modelResponding);
    expect(executionTraceText("unknown", "missing")).toBe("missing");
  });
});

describe("language selection", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function Screen() {
    const { t } = useTranslation();
    return <><LanguageSwitcher variant="settings" /><output>{t("common.save")}</output></>;
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
    document.documentElement.lang = "";
    document.documentElement.dir = "";
  });

  it("switches all sixteen languages and persists the choice, including Arabic direction", async () => {
    await act(async () => root.render(<I18nProvider><Screen /></I18nProvider>));
    const buttons = host.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons).toHaveLength(16);
    for (const [index, language] of SUPPORTED_LANGUAGES.entries()) {
      await act(async () => buttons[index]!.click());
      expect(host.querySelector("output")?.textContent).toBe(dictionaries[language.code].common.save);
      expect(localStorage.getItem("npati_language")).toBe(language.code);
      expect(document.documentElement.lang).toBe(language.code);
      expect(document.documentElement.dir).toBe(language.code === "ar" ? "rtl" : "ltr");
    }
  });

  it("restores a saved new language on mount", async () => {
    localStorage.setItem("npati_language", "ja");
    await act(async () => root.render(<I18nProvider><Screen /></I18nProvider>));
    expect(host.querySelector("output")?.textContent).toBe(dictionaries.ja.common.save);
    expect(document.documentElement.lang).toBe("ja");
  });

  it("translates the language picker label and lists all sixteen options", async () => {
    localStorage.setItem("npati_language", "ja");
    await act(async () => root.render(<I18nProvider><LanguageSwitcher /></I18nProvider>));
    const trigger = host.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.getAttribute("aria-label")).toBe(dictionaries.ja.common.languageSelect);
    await act(async () => trigger.click());
    expect(document.querySelector(".npati-language-dropdown-header")).toBeNull();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(16);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    const dutch = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find(option => option.textContent?.includes("Nederlands"))!;
    await act(async () => {
      dutch.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      dutch.click();
    });
    expect(localStorage.getItem("npati_language")).toBe("nl");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it.each(["invalid", "__proto__", "constructor"])("falls back to English for unsupported saved language %s", async (saved) => {
    localStorage.setItem("npati_language", saved);
    await act(async () => root.render(<I18nProvider><Screen /></I18nProvider>));
    expect(host.querySelector("output")?.textContent).toBe(dictionaries.en.common.save);
    expect(document.documentElement.lang).toBe("en");
  });
});

// V6 step 11: half of the locales write placeholders as {count}; the Goals page showed "Showing {count} of {total} goals"
// and Goals/Content/Memory notices showed {title} and {message} raw.
describe("placeholders", () => {
  it("fills single- and double-brace placeholders in every language", async () => {
    const seen: string[] = [];
    function Probe() {
      const { t } = useTranslation();
      seen.push(t("goalsPage.showingGoals", { count: 3, total: 7 }), t("goalsPage.notices.createdSuccess", { title: "V6TEST $& goal" }),
        t("contentPage.cards.minRead", { count: 2 }), t("memoryPage.card.confidenceTooltip", { score: "0.9" }));
      return null;
    }
    for (const language of SUPPORTED_LANGUAGES) {
      localStorage.setItem("npati_language", language.code);
      const host = document.createElement("div"); const root = createRoot(host);
      await act(async () => root.render(<I18nProvider><Probe /></I18nProvider>));
      await act(async () => root.unmount());
    }
    expect(seen.length).toBeGreaterThanOrEqual(64);
    for (const text of seen) expect(text).not.toMatch(/\{\{?(count|total|title|score)\}?\}/);
    expect(seen.filter(text => text.includes("V6TEST $& goal")).length).toBeGreaterThanOrEqual(16);
    localStorage.clear();
  });
});
