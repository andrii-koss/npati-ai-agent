import { expect, it } from "vitest";
import { messageLanguage } from "../approval-i18n";

// V6 step 14: the 16-language chat requests; a Portuguese one with "preço" was read as French.
const requests: Record<string, string> = {
  en: "Create a database for the website «S» with a products table: name and price.",
  uk: "Створи базу даних для сайту «S» з таблицею товарів: назва і ціна.",
  ru: "Создай базу данных для сайта «S» с таблицей товаров: название и цена.",
  de: "Erstelle eine Datenbank für die Website «S» mit einer Produkttabelle: Name und Preis.",
  fr: "Crée une base de données pour le site «S» avec une table de produits : nom et prix.",
  es: "Crea una base de datos para el sitio «S» con una tabla de productos: nombre y precio.",
  it: "Crea un database per il sito «S» con una tabella prodotti: nome e prezzo.",
  pl: "Stwórz bazę danych dla strony «S» z tabelą produktów: nazwa i cena.",
  pt: "Cria uma base de dados para o site «S» com uma tabela de produtos: nome e preço.",
  nl: "Maak een database voor de website «S» met een producttabel: naam en prijs.",
  tr: "«S» sitesi için ürünler tablosu olan bir veritabanı oluştur: ad ve fiyat.",
  zh: "为网站«S»创建一个数据库，包含产品表：名称和价格。",
  ja: "ウェブサイト«S»のために商品テーブル（名前と価格）を持つデータベースを作成してください。",
  ko: "웹사이트 «S»을 위해 상품 테이블(이름과 가격)이 있는 데이터베이스를 만들어 주세요.",
  ar: "أنشئ قاعدة بيانات للموقع «S» مع جدول منتجات: الاسم والسعر.",
  hi: "वेबसाइट «S» के लिए उत्पादों की तालिका (नाम और कीमत) वाला डेटाबेस बनाओ।",
};
for (const [language, text] of Object.entries(requests)) it(`reads ${language}`, () => expect(messageLanguage(text, "en")).toBe(language));
it("still reads French with ç", () => expect(messageLanguage("Ça marche, crée une page pour la boulangerie.", "en")).toBe("fr"));
// "site" is French, Portuguese and English alike: a French question tied with English and took the project's language.
it("reads a French question without accents", () => expect(messageLanguage("Quel est le titre actuel du site «V6TEST14 Poly AR Site» ?", "hi")).toBe("fr"));
it("still reads an English question about a site", () => expect(messageLanguage("What heading is on the website «S» now?", "hi")).toBe("en"));
