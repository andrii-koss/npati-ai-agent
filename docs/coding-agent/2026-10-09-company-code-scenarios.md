# Coding через компанію та окремих агентів: перевірка

Дата: 2026-10-09. Стан після self-hosted activation fixes.

## Локальний Docker

Повторна перевірка: `npati-agent-api`, `npati-agent-company-worker`, `npati-agent-web` — healthy.
Ці три сервіси вже перезібрані й оновлені попереднім виправленням, доступні на localhost.
У цьому аудиті код runtime, конфігурація компаній користувача та схема sandbox-контейнерів не змінювалися.

## Що означає Change scope

Це область запису флага, а не перемикач між самостійним Coding Agent і Company Run.
Global означає застосування налаштування до всіх компаній у відповідному workspace.
Company означає запис для вибраної компанії. Вибір Company не вимикає інші компанії.
Код-проєкти та сесії навіть із глобальними флагами мають companyId.

Self-hosted default тепер enabled. Щоб дозволити Coding Agent лише компанії A наявним механізмом,
потрібно залишити глобальний master увімкненим і явно вимкнути master для компаній B/C.
Нова компанія знову успадкує enabled. Глобальний master off є kill switch:
company on не може його обійти. Отже, автоматичний режим «лише дозволені компанії» ще не реалізовано.

Джерело: `feature-flags.ts`, applicableRows/resolve; `CodeFlagsPanel.tsx`, toggleFlag.
Додано два тести цих властивостей у `coding-agent-self-hosted-defaults.test.ts`.

## Агент компанії може редагувати проєкт

Так: `CompanyPage.tsx` надає Project Read, Project Write, Terminal, Preview, Git, Deploy.
Назва ролі Developer сама не надає доступу — потрібні відповідні tools і активний агент.
Code Mode / Exec виконує ізольований JavaScript і не є дозволом редагувати репозиторій.

`CompanyDelegationRuntime.tools` перевіряє tools агента; `CompanyToolRuntime.projectFiles` повторно
перевіряє агента й передає companyId/projectId у ProjectWorkspace. Тести підтвердили створення й
редагування файлів через Company Run, відмову агенту без tools, tenant isolation та approval видалення.

Проте це окремий CompanyDelegationRuntime з `project.files.*`, а не CodingAgentRunner із його
сесіями та повним coding loop. Company runtime не отримує FeatureFlagService; його capability resolver
не отримує code flags. Тому code.read/code.write/master у Settings → Code не можна вважати
універсальним контролем цього старого шляху. Дозволи агента тут контролюються його tools.

## Агент A для сайту, агент B для мобільного застосунку

Компанія підтримує кількох агентів і окремі website/mobile_app проєкти. Є task-level scope:
allowedProjectId блокує звернення до іншого проєкту; allowedProjectPaths обмежує файлові задачі.
Це працює, коли scope заданий запуску. Він не є постійним агентським allowlist проєктів.

Постійне призначення A → тільки website project, B → тільки mobile project не реалізоване:

- Project/ProjectInput не зберігають agent assignment або allowed agent IDs.
- ProjectOrchestrator вибирає агента за tools, роллю та інструкціями.
- ensureMobileAppAgent спочатку викликає той самий selectProjectAgent, що й вебсайт; якщо знайде
  розробника сайту, поверне його. canBuildMobileApp дорівнює canBuildWebsite за дозволами.
- Отже, сама назва/роль Mobile developer не гарантує вибір саме агента B і не забороняє йому інший проєкт.

## Що потрібно для повного сценарію

1. Окремий режим доступності Global / Selected companies із коректним default для нових компаній,
   зберігаючи справжній глобальний kill switch.
2. Явна делегація Company agent → CodingAgentRunner із company/project/session/model та перевіркою
   company flags і tools перед запуском.
3. Збережене призначення агентів до проєктів, UI вибору та enforcement на всіх файлових/terminal/Git entry points.
4. Вибір мобільного спеціаліста за типом реального проєкту, а не лише спільними файловими tools.

## Перевірки

- 5 файлів, 52 passed: company-runtime, company-tool-runtime, project-multi-agent, C1a flags,
  self-hosted defaults (до додавання двох сценаріїв).
- 2 файли, 12 passed: self-hosted defaults (8) та project-files-integration (4).
- Жива модель й користувацькі проєкти для редагування не запускалися; висновки про runtime paths
  ґрунтуються на коді та інтеграційних тестах із підставною моделлю.

Висновок: Company file editing підтримується. Строге обмеження «тільки ця компанія, тільки цей агент,
тільки цей проєкт» через описані елементи UI наразі не гарантоване.
