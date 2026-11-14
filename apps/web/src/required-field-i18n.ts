import type { SupportedLanguage } from "./i18n/types";

/** Browser-native validation uses the browser language, which can differ from the selected UI locale. */
export const requiredFieldMessage: Record<SupportedLanguage, string> = {
  en: "Please fill out this field.",
  uk: "Будь ласка, заповніть це поле.",
  de: "Bitte fülle dieses Feld aus.",
  fr: "Veuillez remplir ce champ.",
  es: "Por favor, completa este campo.",
  it: "Compila questo campo.",
  pl: "Wypełnij to pole.",
  pt: "Preencha este campo.",
  nl: "Vul dit veld in.",
  tr: "Lütfen bu alanı doldurun.",
  ru: "Пожалуйста, заполните это поле.",
  zh: "请填写此字段。",
  ja: "この項目を入力してください。",
  ko: "이 항목을 입력해 주세요.",
  ar: "يرجى ملء هذا الحقل.",
  hi: "कृपया यह फ़ील्ड भरें।",
};
