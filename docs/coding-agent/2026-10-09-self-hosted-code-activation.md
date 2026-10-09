# Self-hosted Coding Agent: початкове ввімкнення і права адміністратора

Дата: 2026-10-09. Уточнення попереднього [аудиту](2026-10-09-end-to-end-audit.md).

## Причина

Авторизація центрального NPATI повертала роль `user`. Локальний API не визначав власника інсталяції,
тому відхиляв зміни флагів як `flag_admin_required`. Одночасно відсутність записів флагів означала
вимкнений Coding Agent — користувач мусив вручну налаштовувати rollout після інсталяції.

## Зміни

- `NPATI_DEPLOYMENT_TYPE=self_hosted`: Coding Agent і всі підтримувані підфункції увімкнені глобально
  за замовчуванням. Значення повертаються як `source: self_hosted_default`, `stage: ga`.
  Явні налаштування й kill switch мають пріоритет. Для `npati_hosted` збережено попередній rollout.
- Перший власник прив'язується до `user.id` підтвердженої центральної installation session і зберігається
  в `installation-auth.json`. Для вже авторизованої інсталяції прив'язка відновлюється автоматично
  під час першого перевіреного JWT-запиту. Logout/disconnect не передає власність іншому акаунту.
- Локальний власник отримує роль `owner` та адміністративні права. API keys і remote tokens не отримують
  ці права автоматично. Окреме право `code.prod.operate` залишається окремим дозволом.
- `Change scope` початково вибраний як `Global`. Панель показує також resume/rewind/fork/export і профілі моделей.
- Створена сесія відкриває Workspace; наявну сесію можна відкрити у Workspace або активувати для чату.
  Архівні сесії можна переглядати без активації.
- Workspace завантажує справжній режим сесії, має поле завдання та запуск через спільний backend run executor.
  Під час запуску оновлює події, файли, зміни, використання та очікувані дозволи.
- Спільний executor передає основну модель з AI Settings у CodingAgentRunner для Workspace та чату.
- Видалено чотири старі quarantine-записи `company-runtime`: весь файл уже проходить тести.

## Перевірка локального Docker-стека

Перезібрано й оновлено існуючі `agent-api`, `company-worker`, `web`; усі три healthy.
Сторінка `http://localhost:3000/settings/code` повертає HTTP 200.

Перевірка через центральну installation session та локальний API:

```json
{"centralSession":200,"companies":200,"flags":200,"master":{"enabled":true,"scope":"global","stage":"ga","source":"self_hosted_default"},"enabledFeatures":20,"totalFeatures":20,"installationOwnerBound":true,"ownerAdminVerified":true}
```

Перевірка адміністративного маршруту використала навмисно невалідний ключ: API пройшов role check і
відхилив ключ з `invalid_flag_key`, не змінюючи флагів. Ключі й токени не записувалися у звіт.

`npm run typecheck`, lint, Docker-збірки API/web пройшли. Початкові вебтести: 76 passed;
додано ще 2 перевірки глобального scope та доступних флагів, обидві пройшли.
Фінальні цільові auth/default/quarantine перевірки: 29 passed; auth/runtime regression: 39 passed.

Повний прогін `vitest run`: **4342 passed / 16 failed / 14 skipped**. Він почався до виправлення
застарілого quarantine-запису й виконувався одночасно з Docker-збіркою. Повторний прогін шести
відповідних файлів після збірки: **70 passed / 1 failed**. C14 quarantine, Git worktrees,
Website Builder, model-routing website regression і long-business-profile пройшли повторно.
Залишився збій spreadsheet follow-up у `agent-api.test.ts`; інші червоні сценарії повного прогону
стосуються company orchestration, company/chat memory та durable approvals/WASM. Вони не приховані
новими quarantine-записами. Повний репозиторій не оголошено зеленим.

Артефакти: `artifacts/self-hosted-full-test-report.json`, `artifacts/self-hosted-full-recheck-report.json`,
`artifacts/self-hosted-final-regression-report.json`, `artifacts/self-hosted-auth-regression-report.json`.

## Як перевірити в чаті

1. Оновити `/settings/code`. Обрати свою компанію і створити Code project або обрати наявний.
2. Створити сесію `plan` для перевірки читання або `ask` для змін із підтвердженням.
3. Натиснути `Open in chat` у списку сесій або `Continue in chat` у Workspace.
4. Написати: «Проаналізуй файли цього проєкту. Назви три конкретні проблеми з посиланнями на файли.
   Нічого не змінюй». Перевірити run, інструменти та Activity.
5. Для `ask`: «Додай тест для знайденої помилки, виправ її і запусти відповідні тести».
   Перевірити запит дозволу, diff та результати команд.

Підключена модель, Git credentials та зовнішній MCP-сервер потребують своїх дійсних налаштувань;
увімкнення флагів не створює ці credentials. Реальний запуск моделі з редагуванням користувацького
репозиторію під час цієї перевірки не виконувався. Решта непідтверджених пунктів попереднього аудиту
(зокрема повна UI-інтеграція plan/ask_user та resume/rewind/fork) не оголошені завершеними.
