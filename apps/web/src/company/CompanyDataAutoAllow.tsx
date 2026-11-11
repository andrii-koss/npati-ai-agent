import { useEffect, useState } from "react";
import { api } from "../business-workspace-shared";
import { useTranslation } from "../i18n";

export type DataAutoAllowView = { autoAllow: boolean; revision: number; canChange: boolean };

export const dataAutoAllowPath = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/chat/data-auto-allow`;

export async function saveDataAutoAllow(companyId: string, autoAllow: boolean, expectedRevision: number) {
  return api<DataAutoAllowView>(dataAutoAllowPath(companyId), { method: "PUT", body: JSON.stringify({ autoAllow, expectedRevision }) });
}

type SettingCopy = { title: string; label: string; on: string; off: string; readOnly: string };
const copy: Record<string, SettingCopy> = {
  en: { title: "Confirmations in chat", label: "Let the agents act without asking for confirmation",
    on: "On: database changes, terminal commands, file deletes, risky agent tools and deleting a site from the chat run without a confirmation. A deleted site cannot be restored. Writing to git and deleting the whole company still ask. Every action is written to the audit log.",
    off: "Off: the chat asks before database changes, terminal commands, file deletes, risky agent tools and deleting a site.",
    readOnly: "Only the company owner or an admin can change this." },
  uk: { title: "Підтвердження в чаті", label: "Дозволяти агентам діяти без підтвердження",
    on: "Увімкнено: зміни бази даних, команди в терміналі, видалення файлів, ризиковані інструменти агентів і видалення сайту з чату виконуються без підтвердження. Видалений сайт не відновити. Запис у git і видалення всієї компанії і далі питають. Кожна дія записується в журнал аудиту.",
    off: "Вимкнено: чат питає перед змінами бази даних, командами в терміналі, видаленням файлів, ризикованими інструментами агентів і видаленням сайту.",
    readOnly: "Змінити це може лише власник компанії або адміністратор." },
  ru: { title: "Подтверждения в чате", label: "Разрешать агентам действовать без подтверждения",
    on: "Включено: изменения базы данных, команды в терминале, удаление файлов, рискованные инструменты агентов и удаление сайта из чата выполняются без подтверждения. Удалённый сайт не восстановить. Запись в git и удаление всей компании по-прежнему спрашивают. Каждое действие записывается в журнал аудита.",
    off: "Выключено: чат спрашивает перед изменениями базы данных, командами в терминале, удалением файлов, рискованными инструментами агентов и удалением сайта.",
    readOnly: "Изменить это может только владелец компании или администратор." },
  de: { title: "Bestätigungen im Chat", label: "Agenten ohne Rückfrage handeln lassen",
    on: "An: Datenbankänderungen, Terminalbefehle, Dateilöschungen, riskante Agentenwerkzeuge und das Löschen einer Website aus dem Chat laufen ohne Bestätigung. Eine gelöschte Website lässt sich nicht wiederherstellen. Git-Schreibvorgänge und das Löschen des ganzen Unternehmens fragen weiterhin. Jede Aktion wird im Audit-Protokoll erfasst.",
    off: "Aus: Der Chat fragt vor Datenbankänderungen, Terminalbefehlen, Dateilöschungen, riskanten Agentenwerkzeugen und dem Löschen einer Website.",
    readOnly: "Nur der Unternehmensinhaber oder ein Administrator kann das ändern." },
  fr: { title: "Confirmations dans le chat", label: "Laisser les agents agir sans demander de confirmation",
    on: "Activé : les modifications de la base de données, les commandes du terminal, les suppressions de fichiers, les outils risqués des agents et la suppression d'un site depuis le chat se font sans confirmation. Un site supprimé ne peut pas être restauré. Les écritures git et la suppression de toute l'entreprise demandent toujours. Chaque action est inscrite au journal d'audit.",
    off: "Désactivé : le chat demande avant les modifications de la base de données, les commandes du terminal, les suppressions de fichiers, les outils risqués des agents et la suppression d'un site.",
    readOnly: "Seul le propriétaire de l'entreprise ou un administrateur peut modifier ceci." },
  es: { title: "Confirmaciones en el chat", label: "Dejar que los agentes actúen sin pedir confirmación",
    on: "Activado: los cambios en la base de datos, los comandos de terminal, el borrado de archivos, las herramientas arriesgadas de los agentes y el borrado de un sitio desde el chat se hacen sin confirmación. Un sitio borrado no se puede recuperar. Las escrituras en git y el borrado de toda la empresa siguen preguntando. Cada acción queda en el registro de auditoría.",
    off: "Desactivado: el chat pregunta antes de cambios en la base de datos, comandos de terminal, borrado de archivos, herramientas arriesgadas de los agentes y el borrado de un sitio.",
    readOnly: "Solo el dueño de la empresa o un administrador puede cambiarlo." },
  it: { title: "Conferme nella chat", label: "Lascia che gli agenti agiscano senza chiedere conferma",
    on: "Attivo: modifiche al database, comandi nel terminale, eliminazione di file, strumenti rischiosi degli agenti ed eliminazione di un sito dalla chat avvengono senza conferma. Un sito eliminato non si può recuperare. Le scritture su git e l'eliminazione dell'intera azienda chiedono ancora. Ogni azione è registrata nel registro di audit.",
    off: "Disattivo: la chat chiede prima di modifiche al database, comandi nel terminale, eliminazione di file, strumenti rischiosi degli agenti ed eliminazione di un sito.",
    readOnly: "Solo il proprietario dell'azienda o un amministratore può cambiarlo." },
  pl: { title: "Potwierdzenia w czacie", label: "Pozwól agentom działać bez pytania o potwierdzenie",
    on: "Włączone: zmiany w bazie danych, polecenia w terminalu, usuwanie plików, ryzykowne narzędzia agentów i usuwanie strony z czatu odbywają się bez potwierdzenia. Usuniętej strony nie da się przywrócić. Zapis do git i usunięcie całej firmy nadal pytają. Każda czynność trafia do dziennika audytu.",
    off: "Wyłączone: czat pyta przed zmianami w bazie danych, poleceniami w terminalu, usuwaniem plików, ryzykownymi narzędziami agentów i usunięciem strony.",
    readOnly: "Zmienić to może tylko właściciel firmy lub administrator." },
  pt: { title: "Confirmações no chat", label: "Deixar os agentes agirem sem pedir confirmação",
    on: "Ligado: alterações no banco de dados, comandos no terminal, exclusão de arquivos, ferramentas arriscadas dos agentes e exclusão de um site pelo chat acontecem sem confirmação. Um site excluído não pode ser restaurado. Gravações no git e a exclusão da empresa inteira continuam perguntando. Cada ação fica no registro de auditoria.",
    off: "Desligado: o chat pergunta antes de alterações no banco de dados, comandos no terminal, exclusão de arquivos, ferramentas arriscadas dos agentes e exclusão de um site.",
    readOnly: "Só o dono da empresa ou um administrador pode mudar isto." },
  nl: { title: "Bevestigingen in de chat", label: "Agenten laten handelen zonder om bevestiging te vragen",
    on: "Aan: databasewijzigingen, terminalopdrachten, het verwijderen van bestanden, risicovolle agenthulpmiddelen en het verwijderen van een site vanuit de chat gebeuren zonder bevestiging. Een verwijderde site is niet te herstellen. Schrijven naar git en het verwijderen van het hele bedrijf vragen nog steeds. Elke actie komt in het auditlogboek.",
    off: "Uit: de chat vraagt vóór databasewijzigingen, terminalopdrachten, het verwijderen van bestanden, risicovolle agenthulpmiddelen en het verwijderen van een site.",
    readOnly: "Alleen de eigenaar van het bedrijf of een beheerder kan dit wijzigen." },
  tr: { title: "Sohbetteki onaylar", label: "Ajanların onay sormadan hareket etmesine izin ver",
    on: "Açık: veritabanı değişiklikleri, terminal komutları, dosya silme, riskli ajan araçları ve sohbetten site silme onaysız yapılır. Silinen site geri getirilemez. Git'e yazma ve tüm şirketin silinmesi yine sorar. Her işlem denetim günlüğüne yazılır.",
    off: "Kapalı: sohbet veritabanı değişikliklerinden, terminal komutlarından, dosya silmeden, riskli ajan araçlarından ve site silmeden önce sorar.",
    readOnly: "Bunu yalnızca şirket sahibi veya bir yönetici değiştirebilir." },
  zh: { title: "聊天中的确认", label: "允许智能体无需确认直接执行",
    on: "已开启：数据库更改、终端命令、删除文件、高风险的智能体工具以及在聊天中删除网站都无需确认。删除的网站无法恢复。写入 git 和删除整个公司仍会询问。每个操作都会记入审计日志。",
    off: "已关闭：在数据库更改、终端命令、删除文件、高风险的智能体工具和删除网站之前，聊天会先询问。",
    readOnly: "只有公司所有者或管理员可以更改此项。" },
  ja: { title: "チャットでの確認", label: "エージェントが確認なしで実行できるようにする",
    on: "オン：データベースの変更、ターミナルのコマンド、ファイルの削除、リスクのあるエージェントツール、チャットからのサイト削除を確認なしで実行します。削除したサイトは復元できません。git への書き込みと会社全体の削除は引き続き確認します。すべての操作は監査ログに記録されます。",
    off: "オフ：データベースの変更、ターミナルのコマンド、ファイルの削除、リスクのあるエージェントツール、サイトの削除の前にチャットが確認します。",
    readOnly: "これを変更できるのは会社のオーナーまたは管理者だけです。" },
  ko: { title: "채팅 확인", label: "에이전트가 확인 없이 실행하도록 허용",
    on: "켜짐: 데이터베이스 변경, 터미널 명령, 파일 삭제, 위험한 에이전트 도구, 채팅에서의 사이트 삭제가 확인 없이 실행됩니다. 삭제된 사이트는 복구할 수 없습니다. git 쓰기와 회사 전체 삭제는 계속 묻습니다. 모든 작업은 감사 로그에 기록됩니다.",
    off: "꺼짐: 데이터베이스 변경, 터미널 명령, 파일 삭제, 위험한 에이전트 도구, 사이트 삭제 전에 채팅이 묻습니다.",
    readOnly: "회사 소유자나 관리자만 변경할 수 있습니다." },
  ar: { title: "التأكيدات في المحادثة", label: "السماح للوكلاء بالتنفيذ دون طلب تأكيد",
    on: "مفعّل: تتم تغييرات قاعدة البيانات وأوامر الطرفية وحذف الملفات وأدوات الوكلاء الخطرة وحذف موقع من المحادثة دون تأكيد. لا يمكن استعادة الموقع المحذوف. الكتابة إلى git وحذف الشركة بالكامل لا يزالان يطلبان التأكيد. يُسجَّل كل إجراء في سجل التدقيق.",
    off: "متوقف: تسأل المحادثة قبل تغييرات قاعدة البيانات وأوامر الطرفية وحذف الملفات وأدوات الوكلاء الخطرة وحذف موقع.",
    readOnly: "لا يمكن تغيير هذا إلا لمالك الشركة أو المسؤول." },
  hi: { title: "चैट में पुष्टि", label: "एजेंटों को बिना पुष्टि पूछे काम करने दें",
    on: "चालू: डेटाबेस बदलाव, टर्मिनल कमांड, फ़ाइलें हटाना, जोखिम वाले एजेंट टूल और चैट से साइट हटाना बिना पुष्टि के होते हैं। हटाई गई साइट वापस नहीं आती। git में लिखना और पूरी कंपनी हटाना अब भी पूछते हैं। हर कार्य ऑडिट लॉग में दर्ज होता है।",
    off: "बंद: डेटाबेस बदलाव, टर्मिनल कमांड, फ़ाइलें हटाने, जोखिम वाले एजेंट टूल और साइट हटाने से पहले चैट पूछता है।",
    readOnly: "इसे केवल कंपनी का स्वामी या व्यवस्थापक बदल सकता है।" },
};

/** The company setting shown in the company drawer; it saves on its own, apart from the company form. */
export function CompanyDataAutoAllow({ companyId }: { companyId: string }) {
  const { language } = useTranslation();
  const t = copy[String(language).slice(0, 2)] ?? copy.en!;
  const [view, setView] = useState<DataAutoAllowView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<DataAutoAllowView>(dataAutoAllowPath(companyId)).then(value => { if (active) setView(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [companyId]);
  if (!view) return null;
  async function toggle(next: boolean) {
    if (!view) return;
    setSaving(true); setError("");
    try { setView(await saveDataAutoAllow(companyId, next, view.revision)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    setSaving(false);
  }
  return (
    <section data-testid="company-data-auto-allow">
      <h3>{t.title}</h3>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input type="checkbox" checked={view.autoAllow} disabled={!view.canChange || saving} onChange={event => void toggle(event.target.checked)} style={{ width: "auto", marginTop: 3 }} />
        <span>{t.label}</span>
      </label>
      <small>{view.autoAllow ? t.on : t.off}{view.canChange ? "" : " " + t.readOnly}</small>
      {error ? <div role="alert">{error}</div> : null}
    </section>
  );
}
