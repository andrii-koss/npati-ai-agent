import { describe, expect, it } from "vitest";
import { APPROVAL_LANGUAGES, approvalCopy, approvalToolLabel, messageLanguage } from "../approval-i18n";

describe("confirmation card texts in 16 languages", () => {
  it("has every text in every chat language, and none is left in English by mistake", () => {
    const keys = (value: object): string[] => Object.entries(value).flatMap(([key, item]) => typeof item === "object" ? keys(item).map(child => key + "." + child) : [key]);
    const english = approvalCopy("en");
    for (const language of APPROVAL_LANGUAGES) {
      const copy = approvalCopy(language);
      expect(keys(copy).sort(), language).toEqual(keys(english).sort());
      if (language === "en") continue;
      for (const key of ["permissionTitle", "allow", "reject", "always", "confirmTitle", "approve"] as const) expect(copy[key], `${language}.${key}`).not.toBe(english[key]);
      expect(copy.tool.shell, language).not.toBe(english.tool.shell);
      expect(copy.filesDelete("a.txt"), language).toContain("a.txt");
    }
    expect(approvalCopy("xx")).toBe(english);
    expect(approvalCopy("uk-UA").allow).toBe("Дозволити");
  });

  it.each([
    ["видали файл і зміни ціну", "uk"], ["удали файл и измени цену", "ru"], ["Bitte lösche die Datei", "de"], ["Supprime le fichier, s'il te plaît", "fr"],
    ["Elimina el archivo y cambia el precio", "es"], ["Elimina il file e cambia il prezzo", "it"], ["Usuń plik i zmień cenę", "pl"],
    ["Exclua o arquivo e mude o preço, não o nome", "pt"], ["Verwijder het bestand en maak een nieuwe", "nl"], ["Dosyayı sil ve fiyatı değiştir", "tr"],
    ["删除这个文件", "zh"], ["このファイルを削除して", "ja"], ["이 파일을 삭제해 줘", "ko"], ["احذف هذا الملف", "ar"], ["इस फ़ाइल को हटाएँ", "hi"],
    ["Please delete the file and change the price", "en"],
  ])("reads %s as %s", (text, language) => {
    expect(messageLanguage(text, "en")).toBe(language);
  });

  it("falls back to the given language when a message does not say", () => {
    expect(messageLanguage("ok 123", "de")).toBe("de");
    expect(messageLanguage(undefined, "uk")).toBe("uk");
  });

  it("names common actions in plain words", () => {
    const uk = approvalCopy("uk");
    expect(approvalToolLabel("code.shell.exec", uk)).toBe("Виконати команду в терміналі");
    expect(approvalToolLabel("project.terminal.exec", uk)).toBe("Виконати команду в терміналі");
    expect(approvalToolLabel("code.git.push", uk)).toBe("Записати в git (commit чи push)");
    expect(approvalToolLabel("storage.company_memory", uk)).toBe("Змінити пам'ять компанії");
    expect(approvalToolLabel("something.unknown", uk)).toBe("Виконати цю дію");
  });
});
