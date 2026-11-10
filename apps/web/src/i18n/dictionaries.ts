import type { SupportedLanguage, TranslationSchema } from "./types";
import { en } from "./locales/en";
import { uk } from "./locales/uk";
import { de } from "./locales/de";
import { fr } from "./locales/fr";
import { es } from "./locales/es";
import { it } from "./locales/it";
import { pl } from "./locales/pl";
import { pt } from "./locales/pt";
import { nl } from "./locales/nl";
import { tr } from "./locales/tr";
import { ru } from "./locales/ru";
import { zh } from "./locales/zh";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { ar } from "./locales/ar";
import { hi } from "./locales/hi";

export const dictionaries: Record<SupportedLanguage, TranslationSchema> = {
  en, uk, de, fr, es, it, pl, pt, nl, tr, ru, zh, ja, ko, ar, hi,
};
