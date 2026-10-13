# Coding Agent: Global, Company та Sandbox / Data Studio

Дата: 2026-10-13.

Область виконання агента тепер відокремлена від області збереження feature flags.
Параметр Change scope керує режимом виконання, а перемикачі функцій зберігаються для компанії.

- Company — стандартний режим. Підтримані функції, async-операції та три профілі моделей
  увімкнені відразу в явно налаштованих self_hosted і npati_hosted deployments.
  Наявні явні вимкнення та master kill switch зберігають пріоритет.
- Sandbox / Data Studio — керовані файли й дані вибраного проєкту. Mounted folders,
  делегування агентам, зовнішні MCP tools та перенесення/прикріплення даних інших проєктів
  відхиляються на сервері.
- Global — вихідний код NPATI в окремій копії репозиторію. Доступ потребує підтверджених
  прав власника інсталяції/адміністратора та Creator Workspace, прив'язаного до цього checkout.
  Global не змінює захист інших акаунтів або правила роботи із секретами.

Режим зберігається у наявному user-settings store власника компанії. Зміни журналюються,
мають revision check та перевіряються до запуску моделі, у policy engine і при прямому виклику
інструментів. Зміна Company/Sandbox після Global закриває доступ до Creator-проєкту.

## Creator Workspace і Docker

docker-compose.creator.yml — необов'язкове доповнення до docker-compose.dokploy-isolated.yml.
Воно доповнює вже наявні agent-api, company-worker та sandbox-runner bind mount-ом
вихідного коду. Нового сервісу, образу чи окремого контейнера Coding Agent цей файл не додає.

На сервері потрібен окремий checkout NPATI поза data/workspace directories.
NPATI_CREATOR_SOURCE_ROOT має містити його абсолютний шлях. API та runner бачать цей
каталог за однаковим шляхом. Інсталяційні дані не повинні зберігатися всередині checkout:
наявний mounted-folder validator відхиляє такі корені.

У UI після вибору Global кнопка Open Creator Workspace використовує вже наявні Code project,
mounted folder, session, Files, Git і sandbox APIs. Повторне відкриття використовує ті самі
проєкт та сесію. Без checkout режим не показує удаваної готовності.

Редагування файлів NPATI й застосування змін до запущеного сайта — окремі дії:
оновлений інтерфейс потребує звичайної збірки й розгортання.

## Виклики з агентів компанії

CompanyToolRuntime підтримує існуючий інструмент code.agent.spawn для виклику Coding Agent
із task та projectId. Виклик проходить через спільний executor сесій, квоти й чергу;
скасування Company run передається до Coding Agent. Делегування дозволене тільки в Company.
Обмеження призначеного projectId і file scope компанійного агента не можна обійти делегуванням.

## Перевірка

Тести прав, defaults, режимів, Company runtime, mounted workspace, feature flags і
маршрутизації сайта пройшли. Тести frontend, перевірки типів і lint пройшли.
Сервер ai.npati.com, його Docker-конфігурація й контейнери в цій сесії не змінювалися.
Повний живий запуск Global потребує налаштованого source checkout і авторизованого сервера.

## Виправлення для вже налаштованих компаній

Додано одноразову ініціалізацію v1: власнику компанії не потрібно вручну перемикати flags.
При першому відкритті панель викликає POST /companies/:companyId/code/initialize,
який журналює й встановлює master та всі підтримані функції в enabled / ga.
Це застосовує нові defaults також до старих company OFF / internal rows.
Після завершення зберігається marker; наступні ручні вимкнення й kill switch не скидаються
повторним відкриттям сторінки.

Вибір Global доступний власнику компанії. Вибір режиму та право читати/редагувати
вихідний код NPATI — окремі перевірки. Для інсталяції з центральною роллю user можна
явно призначити її справжнього Creator owner через NPATI_CREATOR_OWNER_USER_IDS:
список підтверджених NPATI user IDs через кому. Цей параметр і NPATI_CREATOR_SOURCE_ROOT
передаються наявним контейнерам через docker-compose.creator.yml.
Інші акаунти, API keys і remote tokens не отримують доступу до source checkout.
Коли checkout і доступ власника налаштовані, вибір Global автоматично підключає Creator Workspace.
