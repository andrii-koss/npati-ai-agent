export type ChatMutationProgressTarget = { url: string; domain: string; title: string };
export type ChatMutationContext = "none" | "business" | "company";
export type ChatMutationOperation = "create" | "update" | "delete";

/**
 * The installation the user is on: ai.npati.com, a self-hosted domain or localhost. Progress steps name its own pages,
 * never a fixed host.
 */
function installationOrigin(): URL {
  try {
    if (typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null") return new URL(window.location.origin);
  } catch {
    // An unusual location (sandboxed frame) falls back below.
  }
  return new URL("http://localhost");
}

function settingsTarget(path: string, title: string): ChatMutationProgressTarget {
  const origin = installationOrigin();
  return { url: new URL(path, origin).toString(), domain: origin.host, title };
}

const targets: Array<{ path: string; title: string; pattern: RegExp }> = [
  {
    path: "/settings/business", title: "Business settings",
    pattern: /(?:б[іи]знес(?:[\s-]*(?:іде|иде))?|\bbusiness(?:\s+idea)?\b|id[eé]e\s+d['’]?entreprise|gesch[aä]ftsidee|idea\s+de\s+negocio|idea\s+imprenditoriale|pomysł\s+na\s+biznes|ideia\s+de\s+neg[oó]cio|businessidee|iş\s+fikri|商业想法|ビジネスアイデア|비즈니스\s*아이디어|فكرة\s+عمل|व्यवसाय\s+विचार)/iu,
  },
  {
    path: "/settings/goals", title: "Business goals",
    pattern: /(?:ціл|цел|\bgoals?\b|objectifs?|ziele?|objetivos?|obiettiv[oi]|\bcel(?:e|ów|u)?\b|\bmetas?\b|doel(?:en)?|hedef(?:ler)?|目标|目標|목표|هدف|أهداف|लक्ष्य)/iu,
  },
  {
    path: "/settings/company", title: "Company settings",
    pattern: /(?:компан|агент|\bcompan(?:y|ies)\b|\bagents?\b|(?<!d['’])entreprise|soci[eé]t[eé]|unternehmen|firma|agenten?|empresa|compa[ñn][ií]a|agentes?|azienda|societ[aà]|agenti|firmę|sp[oó]łk|agentów|empresa|companhia|agentes?|bedrijf|onderneming|agenten?|şirket|firma|ajan|公司|企业|智能体|会社|企業|エージェント|회사|기업|에이전트|شركة|مؤسسة|وكيل|وكلاء|कंपनी|एजेंट)/iu,
  },
  {
    path: "/settings/activity", title: "Activity & Run Trace",
    pattern: /(?:активн|журнал\s+виконан|трасуван|activity|run\s+trace|execution\s+trace|activit[eé]|aktivit[aä]t|actividad|attivit[aà]|aktywno|atividade|activiteit|etkinlik|активност|活动|実行履歴|활동|النشاط|गतिविधि)/iu,
  },
  {
    path: "/settings/automations", title: "Automations",
    pattern: /(?:автоматизац|запланован\p{L}*\s+завдан|automation|scheduled\s+tasks?|automatisation|automatisierung|automatizaci[oó]n|automazione|automatyzac|automa[çc][aã]o|automatisering|otomasyon|автоматизац|自动化|自動化|자동화|الأتمتة|स्वचालन)/iu,
  },
  {
    path: "/settings/content", title: "Content Hub",
    pattern: /(?:контент|\bcontent\b|contenu|inhalt|contenido|contenuto|treści|conte[uú]do|inhoud|içerik|内容|콘텐츠|المحتوى|सामग्री)/iu,
  },
  {
    path: "/settings/memory", title: "Business Memory",
    pattern: /(?:пам(?:'|’)?ят|памят|мемор|\bmemory\b|m[eé]moire|ged[aä]chtnis|memoria|pami[eę][ćc]|mem[oó]ria|geheugen|hafıza|记忆|メモリ|메모리|الذاكرة|मेमोरी|स्मृति)/iu,
  },
];

function explicitMutationProgressTargets(message: string): ChatMutationProgressTarget[] {
  return targets
    .map((target, order) => {
      const match = target.pattern.exec(message);
      target.pattern.lastIndex = 0;
      return match ? { target, index: match.index, order } : undefined;
    })
    .filter((item): item is { target: { path: string; title: string; pattern: RegExp }; index: number; order: number } => Boolean(item))
    .sort((left, right) => left.index - right.index || left.order - right.order)
    .map(({ target }) => settingsTarget(target.path, target.title));
}

export function mutationProgressTargets(message: string, context: ChatMutationContext): ChatMutationProgressTarget[] {
  let found = explicitMutationProgressTargets(message);
  const goalForExistingBusiness = /(?:ціл\p{L}*|цел\p{L}*|goals?|objectifs?|ziele?|objetivos?|obiettiv\p{L}*|cel\p{L}*|metas?|doel\p{L}*|hedef\p{L}*|目标|目標|목표|هدف|أهداف|लक्ष्य)[\s\S]{0,50}(?:для|for|pour|f[uü]r|para|per|dla|voor|için|для|为|の|위한|لـ|के\s+लिए)[\s\S]{0,50}(?:б[іи]знес|business|entreprise|gesch[aä]ft|negocio|azienda|biznes|neg[oó]cio|bedrijf|iş|业务|ビジネス|비즈니스|عمل|व्यवसाय)/iu.test(message);
  if (goalForExistingBusiness) found = found.filter((target) => new URL(target.url).pathname !== "/settings/business");
  if (found.length) return found;
  if (context === "company") return [settingsTarget("/settings/company", "Company settings")];
  if (context === "business") return [settingsTarget("/settings/business", "Business settings")];
  return [settingsTarget("/settings", "Settings")];
}

export function detectChatMutationOperation(message: string, context: ChatMutationContext): ChatMutationOperation | null {
  // Project operations report actual pipeline stages, not company-setting links.
  if (/(?:Next\.js|Live Preview|\b(?:website|mobile app)\b|сайт|застосунок)/iu.test(message) && !/(?:налаштуван|settings)/iu.test(message)) return null;
  // A selected company is context, not evidence that its settings are being changed.
  if (!explicitMutationProgressTargets(message).length) return null;
  if (/(?:видал|приб|удал|\bdelete\b|\bremove\b|supprim|l[oö]sch|elimin|usuń|exclu|verwijder|\bsil\b|删除|削除|삭제|احذف|إزالة|हटाएँ|हटाओ)/iu.test(message)) return "delete";
  if (/(?:створ|дод|созда|добав|\bcreate\b|\badd\b|cr[eé]|ajout|erstell|hinzuf|crear|a[ñn]ad|agreg|creare|aggiung|utw[oó]rz|stw[oó]rz|dodaj|cri(?:ar|e)|adicion|\bmaak\b|voeg|oluştur|\bekle\b|创建|添加|作成|追加|만들|생성|추가|أنشئ|إنشاء|أضف|बनाएँ|बनाओ|जोड़ें)/iu.test(message)) return "create";
  if (/(?:заповн|змін|онов|редаг|налашт|признач|нада|измен|обнов|редакт|настро|назнач|\bfill\b|\bchange\b|\bupdate\b|\bedit\b|configur|assign|\bset\b|modif|aktualis|änder|cambiar|actualiz|modifica|aggiorn|zmień|zaktualiz|altere|atualiz|wijzig|güncelle|değiştir|修改|更新|変更|수정|업데이트|عدّل|حدّث|बदलें|अपडेट)/iu.test(message)) return "update";
  return null;
}
