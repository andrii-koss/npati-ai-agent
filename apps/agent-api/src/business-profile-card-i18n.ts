import type { CompanyChatLanguage } from "./company-chat-i18n";
import { profileFields } from "./business-profile-native";

// Order: card title, then one label for each profileFields entry.
const rows = {
  en: ["Business Profile", "Business name", "Business type", "Stage", "Industry", "Niche", "Country", "Market", "Team", "Presence", "Business model", "Website", "Legal company name", "Contact email", "Contact phone", "Postal address", "What the business does", "Products or services", "Target audience", "Registration details"],
  uk: ["Бізнес-профіль", "Назва бізнесу", "Тип бізнесу", "Стадія", "Галузь", "Ніша", "Країна", "Ринок", "Команда", "Присутність", "Бізнес-модель", "Вебсайт", "Юридична назва", "Контактна пошта", "Телефон", "Поштова адреса", "Чим займається бізнес", "Продукти або послуги", "Цільова аудиторія", "Реєстраційні дані"],
  fr: ["Profil d’entreprise", "Nom de l’entreprise", "Type d’entreprise", "Stade", "Secteur", "Niche", "Pays", "Marché", "Équipe", "Présence", "Modèle économique", "Site web", "Raison sociale", "E-mail de contact", "Téléphone", "Adresse postale", "Activité de l’entreprise", "Produits ou services", "Public cible", "Données d’immatriculation"],
  de: ["Unternehmensprofil", "Unternehmensname", "Unternehmensart", "Phase", "Branche", "Nische", "Land", "Markt", "Team", "Präsenz", "Geschäftsmodell", "Website", "Rechtlicher Firmenname", "Kontakt-E-Mail", "Telefonnummer", "Postanschrift", "Geschäftstätigkeit", "Produkte oder Dienstleistungen", "Zielgruppe", "Registrierungsdaten"],
  es: ["Perfil empresarial", "Nombre del negocio", "Tipo de negocio", "Etapa", "Sector", "Nicho", "País", "Mercado", "Equipo", "Presencia", "Modelo de negocio", "Sitio web", "Razón social", "Correo de contacto", "Teléfono", "Dirección postal", "Actividad del negocio", "Productos o servicios", "Público objetivo", "Datos de registro"],
  it: ["Profilo aziendale", "Nome dell’azienda", "Tipo di attività", "Fase", "Settore", "Nicchia", "Paese", "Mercato", "Team", "Presenza", "Modello di business", "Sito web", "Ragione sociale", "Email di contatto", "Telefono", "Indirizzo postale", "Attività dell’azienda", "Prodotti o servizi", "Pubblico di riferimento", "Dati di registrazione"],
  pl: ["Profil firmy", "Nazwa firmy", "Rodzaj działalności", "Etap", "Branża", "Nisza", "Kraj", "Rynek", "Zespół", "Obecność", "Model biznesowy", "Strona internetowa", "Nazwa prawna", "E-mail kontaktowy", "Telefon", "Adres pocztowy", "Czym zajmuje się firma", "Produkty lub usługi", "Grupa docelowa", "Dane rejestracyjne"],
  pt: ["Perfil empresarial", "Nome da empresa", "Tipo de negócio", "Estágio", "Setor", "Nicho", "País", "Mercado", "Equipe", "Presença", "Modelo de negócios", "Site", "Razão social", "E-mail de contato", "Telefone", "Endereço postal", "Atividade da empresa", "Produtos ou serviços", "Público-alvo", "Dados de registro"],
  nl: ["Bedrijfsprofiel", "Bedrijfsnaam", "Bedrijfstype", "Fase", "Branche", "Niche", "Land", "Markt", "Team", "Aanwezigheid", "Bedrijfsmodel", "Website", "Juridische bedrijfsnaam", "Contact-e-mail", "Telefoonnummer", "Postadres", "Bedrijfsactiviteiten", "Producten of diensten", "Doelgroep", "Registratiegegevens"],
  tr: ["İşletme profili", "İşletme adı", "İşletme türü", "Aşama", "Sektör", "Niş", "Ülke", "Pazar", "Ekip", "Varlık", "İş modeli", "Web sitesi", "Resmî şirket adı", "İletişim e-postası", "Telefon", "Posta adresi", "İşletmenin faaliyetleri", "Ürünler veya hizmetler", "Hedef kitle", "Tescil bilgileri"],
  ru: ["Бизнес-профиль", "Название бизнеса", "Тип бизнеса", "Этап", "Отрасль", "Ниша", "Страна", "Рынок", "Команда", "Присутствие", "Бизнес-модель", "Веб-сайт", "Юридическое название", "Контактная почта", "Телефон", "Почтовый адрес", "Чем занимается бизнес", "Продукты или услуги", "Целевая аудитория", "Регистрационные данные"],
  zh: ["企业资料", "企业名称", "企业类型", "阶段", "行业", "细分领域", "国家", "市场", "团队", "业务覆盖", "商业模式", "网站", "法定公司名称", "联系邮箱", "联系电话", "邮寄地址", "业务介绍", "产品或服务", "目标客户", "注册信息"],
  ja: ["事業プロフィール", "事業名", "事業の種類", "ステージ", "業種", "専門分野", "国", "市場", "チーム", "展開形態", "ビジネスモデル", "ウェブサイト", "法人名", "連絡先メール", "電話番号", "郵送先住所", "事業内容", "製品・サービス", "対象顧客", "登録情報"],
  ko: ["비즈니스 프로필", "비즈니스 이름", "사업 유형", "단계", "산업", "전문 분야", "국가", "시장", "팀", "운영 형태", "비즈니스 모델", "웹사이트", "법인명", "연락처 이메일", "전화번호", "우편 주소", "사업 내용", "제품 또는 서비스", "대상 고객", "등록 정보"],
  ar: ["الملف التجاري", "اسم النشاط التجاري", "نوع النشاط", "المرحلة", "القطاع", "المجال المتخصص", "البلد", "السوق", "الفريق", "نطاق الحضور", "نموذج العمل", "الموقع الإلكتروني", "الاسم القانوني للشركة", "البريد الإلكتروني للتواصل", "رقم الهاتف", "العنوان البريدي", "نشاط الشركة", "المنتجات أو الخدمات", "الجمهور المستهدف", "بيانات التسجيل"],
  hi: ["व्यवसाय प्रोफ़ाइल", "व्यवसाय का नाम", "व्यवसाय का प्रकार", "चरण", "उद्योग", "विशिष्ट क्षेत्र", "देश", "बाज़ार", "टीम", "उपस्थिति", "व्यवसाय मॉडल", "वेबसाइट", "कानूनी कंपनी का नाम", "संपर्क ईमेल", "फ़ोन नंबर", "डाक पता", "व्यवसाय क्या करता है", "उत्पाद या सेवाएँ", "लक्षित ग्राहक", "पंजीकरण विवरण"],
} satisfies Record<CompanyChatLanguage, readonly string[]>;

export function businessProfileCardLabels(language: CompanyChatLanguage) {
  const row = rows[language];
  return {
    title: row[0]!,
    fields: Object.fromEntries(profileFields.map((field, index) => [field, row[index + 1]!])) as Record<(typeof profileFields)[number], string>,
  };
}

export { rows as businessProfileCardLabelRows };