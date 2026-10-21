# NPATI Coding Agent — Framework Deployment Chat E2E

Дати прогону: 20–21 жовтня 2026. Адреса: http://localhost:13001/chat. Нижче наведено фактичні результати Chat E2E та повторних перевірок.

## Метод і межі

Запити створення й редагування надсилає Playwright через видимий composer звичайного чату. API використовувалися для читання стану й Activity/Terminal, зупинки власних ресурсів та діагностики. Після фактичних Chat-сценаріїв штатний `/preview/start` відновлював лише власні явно зупинені Preview для повторної QA; це не зараховується як нове створення чи редагування через чат. Діагностичні `curl` і `composer diagnose` запускалися в тому самому Sandbox лише після справжніх Laravel failures. Створення файлів, install, build і запуск сервера виконуються NPATI. Прямого завантаження готових тестових сайтів у workspace немає. QA відкриває кнопку Preview в чаті та перевіряє iframe.

Послідовність: React/Vite → Vue/Vite → Nuxt → SvelteKit → Astro → Angular → Remix → Express → Fastify → NestJS → FastAPI → Django → Flask → Laravel → HTML/CSS/JS. Початковий ліміт створення — 360 с, редагування — 240 с. Повторні прогони після конкретного виправлення записуються окремо; необмежених автоматичних повторів немає. Наявні користувацькі проєкти не зупиняються і не видаляються. Production та глобальні дозволи термінала не змінювалися.

## Архітектура до тестів

- `packages/shared/src/project-intent.ts` визначає framework/intent; `chat-development-service.ts` готує окремий проєкт, canonical workspace, сесію та run. `project-framework-scaffold.ts` містить framework starters; HTML/CSS використовує наявний static Website adapter. Це наявність реалізації, не доказ працездатності.
- `coding-agent-runner.ts` оркеструє модель, native tool calls, checkpoint/history, cancellation та перевірки; `coding-agent-tool-waves.ts` збирає результати інструментів і дає обмежене виправлення аргументів без повтору успішних записів.
- `code-toolchain-detector.ts` визначає package manager і verify commands із manifest/Makefile. `project-sandbox-service.ts` синхронізує canonical workspace та runner. Install, production build/backend verify і запуск Preview — системні етапи після реалізації.
- `SharedProjectRuntimeProvider` використовує один supervisor/container і логічні Sandbox на проєкт. Каталоги `/projects/<projectId>`, окремі UID, environment/home/tmp, вільні порти, namespace launcher і firewall зберігають ізоляцію. Новий логічний sandboxId не означає новий Docker container.
- `terminal-command-policy.ts`, `code-shell-classifier.ts` і Code Policy Engine зберігають fail-closed політики. Pipes/chaining у `code.shell.exec` відхиляються; вимикати їх заради тестів не потрібно.
- `project-preview-service.ts` визначає dev/production entrypoint, підставляє виділений порт, перевіряє readiness і проксіює сторінку/ресурси. Авторизація — signed token та scoped HttpOnly cookie. Автоматичний restart має максимум 3 спроби; repair verification loop також обмежений. HTML/CSS code projects тепер відкривають runner Preview, а не raw srcDoc.
- Activity, replay, run state і project terminal events зберігають результати інструментів та команд. Browser QA підтримується runtime, але окрема зовнішня перевірка iframe потрібна для перевірки самого UI та Proxy.
- Перед тестами знайдено scaffolding та runtime branches усіх 15; Python і PHP залежать від установлених runtime/пакетів, Angular/SvelteKit/Remix — від залежностей та build adapters. Підтримку підтвердить тільки поточна таблиця результатів. Старий звіт мав неперевірені та часткові технології; це не підстава присвоювати новий PASS.

## Поточні результати

Оновлено: 2026-10-21T06:42:55.384Z. Підсумок підтверджених сценаріїв.

| Framework | Project Creation | Dependencies | Build | Runtime | Live Preview | Browser QA | Edit Test | Result |
|---|---|---|---|---|---|---|---|---|
| React + Vite | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Vue 3 + Vite | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Nuxt | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| SvelteKit | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Astro | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Angular | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Remix | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Express | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Fastify | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| NestJS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| FastAPI | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Django | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Flask | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Laravel | PASS | FAIL | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | BLOCKED |
| HTML/CSS | PASS | PASS | NOT TESTED | PASS | PASS | PASS | PASS | PASS |

## Докази поточного прогону

### React + Vite — PASS

- Project: `6dbc1cab-8fde-48f6-bf0a-93164bb04e92`; каталог `/projects/6dbc1cab-8fde-48f6-bf0a-93164bb04e92`.
- Create: [Activity / 9b3921e2-b31c-4956-b893-d05b0550da16](http://localhost:13001/activity?runId=9b3921e2-b31c-4956-b893-d05b0550da16).
- Edit: [Activity / code-run-mvh42rrm-b1v1drgm](http://localhost:13001/activity?runId=code-run-mvh42rrm-b1v1drgm).
- Evidence: [react-vite.json](../../artifacts/framework-chat-e2e-current/react-vite.json); screenshots `react-vite-initial.png`, `react-vite-edited.png`, `react-vite-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles undefined, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Edit QA: HTTP 200, H1/title true, section true, styles undefined, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Activity UI: HTTP 200, rendered run ID code-run-mvh42rrm-b1v1drgm, state completed, events 20/20, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `npm install`; status completed, exit 0, duration 51774 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 7899 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 7841 ms.
- Terminal: `npm install`; status completed, exit 0, duration 2158 ms.
- Terminal: `npm install`; status completed, exit 0, duration 1806 ms.
- Terminal: `npm install`; status completed, exit 0, duration 1363 ms.
- activity: 102 Activity events, 9 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 53 Activity events, 5 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### Vue 3 + Vite — PASS

- Project: `6f790da5-c65c-4ce0-b4ef-f8053cf3885a`; каталог `/projects/6f790da5-c65c-4ce0-b4ef-f8053cf3885a`.
- Create: [Activity / 95688bbf-1999-482b-beb7-c4f5694596e2](http://localhost:13001/activity?runId=95688bbf-1999-482b-beb7-c4f5694596e2).
- Edit: [Activity / code-run-mvh48cmr-qf3vrfyv](http://localhost:13001/activity?runId=code-run-mvh48cmr-qf3vrfyv).
- Evidence: [vue-3-vite.json](../../artifacts/framework-chat-e2e-current/vue-3-vite.json); screenshots `vue-3-vite-initial.png`, `vue-3-vite-edited.png`, `vue-3-vite-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles undefined, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Edit QA: HTTP 200, H1/title true, section true, styles undefined, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Activity UI: HTTP 200, rendered run ID code-run-mvh48cmr-qf3vrfyv, state completed, events 20/20, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `npm install`; status completed, exit 0, duration 29607 ms.
- Terminal: `npm install`; status completed, exit 0, duration 1645 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 6515 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 5663 ms.
- Terminal: `npm install`; status completed, exit 0, duration 2080 ms.
- activity: 93 Activity events, 7 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 53 Activity events, 5 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### Nuxt — PASS

- Project: `ff996536-a4f4-4b0e-a2b0-7719558a05e0`; каталог `/projects/ff996536-a4f4-4b0e-a2b0-7719558a05e0`.
- Create: [Activity / 156c6e91-53f5-4d13-b5a6-4a68d8e7104e](http://localhost:13001/activity?runId=156c6e91-53f5-4d13-b5a6-4a68d8e7104e).
- Edit: [Activity / code-run-mvh4fq49-2vvmc13k](http://localhost:13001/activity?runId=code-run-mvh4fq49-2vvmc13k).
- Evidence: [nuxt.json](../../artifacts/framework-chat-e2e-current/nuxt.json); screenshots `nuxt-initial.png`, `nuxt-edited.png`, `nuxt-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles undefined, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Edit QA: HTTP 200, H1/title true, section true, styles undefined, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Activity UI: HTTP 200, rendered run ID code-run-mvh4fq49-2vvmc13k, state completed, events 20/20, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `npm install`; status completed, exit 0, duration 130924 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 32980 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 33246 ms.
- Terminal: `npm install`; status completed, exit 0, duration 4717 ms.
- activity: 71 Activity events, 6 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 49 Activity events, 5 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### SvelteKit — PASS

- Project: `d6607a1a-d559-4600-83e2-1c1a2d31d31c`; каталог `/projects/d6607a1a-d559-4600-83e2-1c1a2d31d31c`.
- Create: [Activity / 880c730e-e6f0-442a-aaff-f0568683af50](http://localhost:13001/activity?runId=880c730e-e6f0-442a-aaff-f0568683af50).
- Edit: [Activity / code-run-mvh4md4c-c8l5katz](http://localhost:13001/activity?runId=code-run-mvh4md4c-c8l5katz).
- Evidence: [sveltekit.json](../../artifacts/framework-chat-e2e-current/sveltekit.json); screenshots `sveltekit-initial.png`, `sveltekit-edited.png`, `sveltekit-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles undefined, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Edit QA: HTTP 200, H1/title true, section true, styles undefined, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Activity UI: HTTP 200, rendered run ID code-run-mvh4md4c-c8l5katz, state completed, events 18/18, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `npm install`; status completed, exit 0, duration 27856 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 28013 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 21138 ms.
- Terminal: `npm install`; status completed, exit 0, duration 2049 ms.
- activity: 97 Activity events, 8 provider attempts, 0 provider failures, 1 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 45 Activity events, 5 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### Astro — PASS

- Project: `dfb50ead-6132-417c-93e4-802026bfb87d`; каталог `/projects/dfb50ead-6132-417c-93e4-802026bfb87d`.
- Create: [Activity / 191d2c1d-1ef8-49ec-b906-f1c0865710b3](http://localhost:13001/activity?runId=191d2c1d-1ef8-49ec-b906-f1c0865710b3).
- Edit: [Activity / code-run-mvh4s63g-teck9x59](http://localhost:13001/activity?runId=code-run-mvh4s63g-teck9x59).
- Evidence: [astro.json](../../artifacts/framework-chat-e2e-current/astro.json); screenshots `astro-initial.png`, `astro-edited.png`, `astro-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles undefined, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Edit QA: HTTP 200, H1/title true, section true, styles undefined, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Activity UI: HTTP 200, rendered run ID code-run-mvh4s63g-teck9x59, state completed, events 18/18, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `npm install`; status completed, exit 0, duration 13910 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 10039 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 10088 ms.
- Terminal: `npm install`; status completed, exit 0, duration 8286 ms.
- activity: 76 Activity events, 7 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 48 Activity events, 5 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### Angular — PASS

- Project: `0db94534-33ac-4091-8ec9-c4f3b273686b`; каталог `/projects/0db94534-33ac-4091-8ec9-c4f3b273686b`.
- Create: [Activity / e797408b-a5cb-4399-a5cf-0450c0f68158](http://localhost:13001/activity?runId=e797408b-a5cb-4399-a5cf-0450c0f68158).
- Edit: [Activity / code-run-mvhogpd9-gndhh485](http://localhost:13001/activity?runId=code-run-mvhogpd9-gndhh485).
- Evidence: [angular.json](../../artifacts/framework-chat-e2e-current/angular.json); screenshots `angular-initial.png`, `angular-edited.png`, `angular-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Edit QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Activity UI: HTTP 200, rendered run ID code-run-mvhogpd9-gndhh485, state completed, events 28/28, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `npm install`; status completed, exit 0, duration 119401 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 22255 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 15497 ms.
- Terminal: `npm install`; status completed, exit 0, duration 4783 ms.
- activity: 87 Activity events, 6 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 78 Activity events, 7 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### Remix — PASS

- Project: `322cfb94-be5f-44d5-a0fe-4c1d08f90f30`; каталог `/projects/322cfb94-be5f-44d5-a0fe-4c1d08f90f30`.
- Create: [Activity / 9f4707d3-5209-4f1d-b7a7-893003ce948c](http://localhost:13001/activity?runId=9f4707d3-5209-4f1d-b7a7-893003ce948c).
- Edit: [Activity / code-run-mvhpn07i-6exzcaxe](http://localhost:13001/activity?runId=code-run-mvhpn07i-6exzcaxe).
- Evidence: [remix.json](../../artifacts/framework-chat-e2e-current/remix.json); screenshots `remix-initial.png`, `remix-edited.png`, `remix-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Edit QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Activity UI: HTTP 200, rendered run ID code-run-mvhpn07i-6exzcaxe, state completed, events 21/21, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `npm install`; status completed, exit 0, duration 30022 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 7855 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 7595 ms.
- activity: 84 Activity events, 7 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 52 Activity events, 5 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### Express — PASS

- Project: `e853664d-dfe8-4575-9dcf-37d78d7b4bfd`; каталог `/projects/e853664d-dfe8-4575-9dcf-37d78d7b4bfd`.
- Create: [Activity / d29dd3d5-afea-4029-bee8-b4de67c8cd05](http://localhost:13001/activity?runId=d29dd3d5-afea-4029-bee8-b4de67c8cd05).
- Edit: [Activity / code-run-mvhna84j-3s8vlj22](http://localhost:13001/activity?runId=code-run-mvhna84j-3s8vlj22).
- Evidence: [express.json](../../artifacts/framework-chat-e2e-current/express.json); screenshots `express-initial.png`, `express-edited.png`, `express-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"Express\"}","ok":true}.
- Edit QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"Express\"}","ok":true}.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"Express\"}","ok":true}.
- Activity UI: HTTP 200, rendered run ID code-run-mvhna84j-3s8vlj22, state completed, events 29/29, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `npm install`; status completed, exit 0, duration 9956 ms.
- Terminal: `npm install`; status completed, exit 0, duration 1504 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 4080 ms.
- Terminal: `cat src/server.ts`; status completed, exit 0, duration 192 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 2857 ms.
- Terminal: `npm install`; status completed, exit 0, duration 2512 ms.
- activity: 90 Activity events, 8 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 81 Activity events, 9 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### Fastify — PASS

- Project: `a9e128ed-eb44-459a-8d0d-56fbecce9650`; каталог `/projects/a9e128ed-eb44-459a-8d0d-56fbecce9650`.
- Create: [Activity / eaa9df27-bb23-4f78-b622-188222e438e6](http://localhost:13001/activity?runId=eaa9df27-bb23-4f78-b622-188222e438e6).
- Edit: [Activity / code-run-mvhoohxn-mwqh93pa](http://localhost:13001/activity?runId=code-run-mvhoohxn-mwqh93pa).
- Evidence: [fastify.json](../../artifacts/framework-chat-e2e-current/fastify.json); screenshots `fastify-initial.png`, `fastify-edited.png`, `fastify-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"Fastify\"}","ok":true}.
- Edit QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"Fastify\"}","ok":true}.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"Fastify\"}","ok":true}.
- Activity UI: HTTP 200, rendered run ID code-run-mvhoohxn-mwqh93pa, state completed, events 20/20, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `npm install`; status completed, exit 0, duration 10507 ms.
- Terminal: `npm install --no-audit --no-fund`; status completed, exit 0, duration 1407 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 7925 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 6724 ms.
- activity: 84 Activity events, 6 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 54 Activity events, 6 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### NestJS — PASS

- Project: `331533a4-2bed-4217-91db-0225d8677a7a`; каталог `/projects/331533a4-2bed-4217-91db-0225d8677a7a`.
- Create: [Activity / 887ae426-4f7c-4baf-a2b2-ddd3c5bf9dd6](http://localhost:13001/activity?runId=887ae426-4f7c-4baf-a2b2-ddd3c5bf9dd6).
- Edit: [Activity / code-run-mvhpy2ut-n0ryekrh](http://localhost:13001/activity?runId=code-run-mvhpy2ut-n0ryekrh).
- Evidence: [nestjs.json](../../artifacts/framework-chat-e2e-current/nestjs.json); screenshots `nestjs-initial.png`, `nestjs-edited.png`, `nestjs-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":false,"passed":false}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"NestJS\"}","ok":true}.
- Edit QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":false,"passed":false}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"NestJS\"}","ok":true}.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":false,"passed":false}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"NestJS\"}","ok":true}.
- Activity UI: HTTP 200, rendered run ID code-run-mvhpy2ut-n0ryekrh, state completed, events 16/16, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `npm install`; status completed, exit 0, duration 56347 ms.
- Terminal: `npm ci --no-audit --no-fund`; status completed, exit 0, duration 36189 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 12455 ms.
- Terminal: `npm install`; status completed, exit 0, duration 1663 ms.
- Terminal: `npm run build`; status completed, exit 0, duration 8095 ms.
- activity: 108 Activity events, 10 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 35 Activity events, 4 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### FastAPI — PASS

- Project: `418118a5-1e7d-4521-b0ec-0e97442c9a1b`; каталог `/projects/418118a5-1e7d-4521-b0ec-0e97442c9a1b`.
- Create: [Activity / 00532a6e-4965-40b5-a675-0ffe877840a1](http://localhost:13001/activity?runId=00532a6e-4965-40b5-a675-0ffe877840a1).
- Edit: [Activity / code-run-mvhq03hb-p2b088th](http://localhost:13001/activity?runId=code-run-mvhq03hb-p2b088th).
- Evidence: [fastapi.json](../../artifacts/framework-chat-e2e-current/fastapi.json); screenshots `fastapi-initial.png`, `fastapi-edited.png`, `fastapi-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":false,"passed":false}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"FastAPI\"}","ok":true}.
- Edit QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":false,"passed":false}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"FastAPI\"}","ok":true}.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":false,"passed":false}, health {"status":200,"body":"{\"status\":\"ok\",\"framework\":\"FastAPI\"}","ok":true}.
- Activity UI: HTTP 200, rendered run ID code-run-mvhq03hb-p2b088th, state completed, events 17/17, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `Approved command (bff877488618)`; status completed, exit 0, duration 10565 ms.
- Terminal: `Approved command (712b38633bc1)`; status completed, exit 0, duration 84617 ms.
- Terminal: `Approved command (d1121e35fa7a)`; status completed, exit 0, duration 408 ms.
- Terminal: `Approved command (d1121e35fa7a)`; status completed, exit 0, duration 294 ms.
- activity: 80 Activity events, 7 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 40 Activity events, 4 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### Django — PASS

- Project: `1a745e48-2c07-4cef-8271-d4eb98e035c6`; каталог `/projects/1a745e48-2c07-4cef-8271-d4eb98e035c6`.
- Create: [Activity / 0810d6ef-1a63-4e61-90ee-217f878958b9](http://localhost:13001/activity?runId=0810d6ef-1a63-4e61-90ee-217f878958b9).
- Edit: [Activity / code-run-mvhosun2-rx9ah97h](http://localhost:13001/activity?runId=code-run-mvhosun2-rx9ah97h).
- Evidence: [django.json](../../artifacts/framework-chat-e2e-current/django.json); screenshots `django-initial.png`, `django-edited.png`, `django-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":false,"passed":false}, health {"status":200,"body":"{\"status\": \"ok\", \"framework\": \"Django\"}","ok":true}.
- Edit QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":false,"passed":false}, health {"status":200,"body":"{\"status\": \"ok\", \"framework\": \"Django\"}","ok":true}.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":false,"passed":false}, health {"status":200,"body":"{\"status\": \"ok\", \"framework\": \"Django\"}","ok":true}.
- Activity UI: HTTP 200, rendered run ID code-run-mvhosun2-rx9ah97h, state completed, events 31/31, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `Approved command (bff877488618)`; status completed, exit 0, duration 7408 ms.
- Terminal: `Approved command (712b38633bc1)`; status completed, exit 0, duration 14649 ms.
- Terminal: `Approved command (d1121e35fa7a)`; status completed, exit 0, duration 707 ms.
- Terminal: `Approved command (d1121e35fa7a)`; status completed, exit 0, duration 923 ms.
- activity: 82 Activity events, 6 provider attempts, 0 provider failures, 1 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 79 Activity events, 8 provider attempts, 0 provider failures, 1 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### Flask — PASS

- Project: `26c7bd04-2156-4ca1-a059-2ac192b9da92`; каталог `/projects/26c7bd04-2156-4ca1-a059-2ac192b9da92`.
- Create: [Activity / 0ec063bb-8d23-4095-9093-63b6169ba81b](http://localhost:13001/activity?runId=0ec063bb-8d23-4095-9093-63b6169ba81b).
- Edit: [Activity / code-run-mvhnzci5-6a6xsmdo](http://localhost:13001/activity?runId=code-run-mvhnzci5-6a6xsmdo).
- Evidence: [flask.json](../../artifacts/framework-chat-e2e-current/flask.json); screenshots `flask-initial.png`, `flask-edited.png`, `flask-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health {"status":200,"body":"{\"framework\":\"Flask\",\"status\":\"ok\"}\n","ok":true}.
- Edit QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health {"status":200,"body":"{\"framework\":\"Flask\",\"status\":\"ok\"}\n","ok":true}.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health {"status":200,"body":"{\"framework\":\"Flask\",\"status\":\"ok\"}\n","ok":true}.
- Activity UI: HTTP 200, rendered run ID code-run-mvhnzci5-6a6xsmdo, state completed, events 21/21, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- Terminal: `Approved command (bff877488618)`; status completed, exit 0, duration 8582 ms.
- Terminal: `Approved command (712b38633bc1)`; status completed, exit 0, duration 20442 ms.
- Terminal: `Approved command (d1121e35fa7a)`; status completed, exit 0, duration 353 ms.
- Terminal: `Approved command (d1121e35fa7a)`; status completed, exit 0, duration 676 ms.
- activity: 112 Activity events, 10 provider attempts, 0 provider failures, 3 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 54 Activity events, 6 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### Laravel — BLOCKED

- Project: `01868bb4-df37-45d3-9b6c-896017d8f119`; каталог `/projects/01868bb4-df37-45d3-9b6c-896017d8f119`.
- Create: [Activity / 05da1240-8fed-4fe0-991f-da35c2a2267b](http://localhost:13001/activity?runId=05da1240-8fed-4fe0-991f-da35c2a2267b).
- Evidence: [laravel.json](../../artifacts/framework-chat-e2e-current/laravel.json); screenshots `laravel-initial.png`, `laravel-edited.png`, `laravel-final.png` для виконаних етапів.
- Activity UI: HTTP 200, rendered run ID 05da1240-8fed-4fe0-991f-da35c2a2267b, state failed, events 4/4, Terminal/Errors selectors checked; result PASS.
- Помилка: Error: creation failed: Sandbox command failed: sent tapfd=7 for tap0.
- Причина BLOCKED: Laravel 13: two bounded real Chat install attempts ended with Composer curl error 28 at repo.packagist.org/packages.json (connection timeout 10001 ms), exit 100. A later diagnostic curl and Composer connectivity check reached that registry successfully, so a permanent Packagist outage is not established. Composer diagnose also confirmed HTTP 403 for the separate packagist.org audit endpoint under the current allowlist. Build, application runtime, /health, Preview and edit were not reached; no security checks were disabled.
- Terminal: `composer install --no-interaction --prefer-dist`; status failed, exit 100, duration 40943 ms, code `command_failed`.
- activity: 0 Activity events, 0 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 0 Activity events, 0 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

### HTML/CSS — PASS

- Project: `d9affe80-29ca-45eb-95ea-16b2b9087284`; каталог `/projects/d9affe80-29ca-45eb-95ea-16b2b9087284`.
- Create: [Activity / 4f62b684-ea73-4ab8-9db8-ca5ec435b82c](http://localhost:13001/activity?runId=4f62b684-ea73-4ab8-9db8-ca5ec435b82c).
- Edit: [Activity / code-run-mvhpsftc-jkoq34uc](http://localhost:13001/activity?runId=code-run-mvhpsftc-jkoq34uc).
- Evidence: [html-css.json](../../artifacts/framework-chat-e2e-current/html-css.json); screenshots `html-css-initial.png`, `html-css-edited.png`, `html-css-final.png` для виконаних етапів.
- Initial QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Edit QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Final QA: HTTP 200, H1/title true, section true, styles true, console errors 0, runtime errors 0, broken links 0, overflow false, interaction {"attempted":true,"passed":true,"before":"0","after":"1"}, health undefined.
- Activity UI: HTTP 200, rendered run ID code-run-mvhpsftc-jkoq34uc, state completed, events 18/18, Terminal/Errors selectors checked; result PASS.
- Редагування використовує той самий Project ID: true.
- activity: 86 Activity events, 8 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.
- editActivity: 44 Activity events, 4 provider attempts, 0 provider failures, 0 tool failures; retry records 0. Повні помилки й результати збережено в JSON.

## Попередні спроби та переривання

- Angular: FAIL; project `88a912d2-a9ef-4cbf-bef6-bd820563985c`; [Run 78915006-e83d-4efa-8408-4765c9601751](http://localhost:13001/activity?runId=78915006-e83d-4efa-8408-4765c9601751); Error: creation failed: Preview server did not become HTTP-ready. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/angular.json).
- Django: FAIL; project `9acf3657-c9f2-48f9-9bb7-455d9f158679`; [Run 2fde95d2-f873-46c2-9ed3-082164b979aa](http://localhost:13001/activity?runId=2fde95d2-f873-46c2-9ed3-082164b979aa); Error: creation failed: Protected file content. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/django.json).
- FastAPI: FAIL; project `418118a5-1e7d-4521-b0ec-0e97442c9a1b`; [Run 00532a6e-4965-40b5-a675-0ffe877840a1](http://localhost:13001/activity?runId=00532a6e-4965-40b5-a675-0ffe877840a1); Error: initial Browser QA failed. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/fastapi.json).
- Fastify: PASS; project `08eced16-cdff-4f51-9a33-e7f401ac3003`; [Run f7c9cf65-c547-451d-8637-c4bce3fbb71f](http://localhost:13001/activity?runId=f7c9cf65-c547-451d-8637-c4bce3fbb71f); functional run retained before starter correction. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/fastify.json).
- HTML/CSS: FAIL; project `d9affe80-29ca-45eb-95ea-16b2b9087284`; [Run 4f62b684-ea73-4ab8-9db8-ca5ec435b82c](http://localhost:13001/activity?runId=4f62b684-ea73-4ab8-9db8-ca5ec435b82c); Error: initial Browser QA failed. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/html-css-selector.json).
- HTML/CSS: FAIL; project `cc68b04f-b84d-4447-a817-f176a110c3b0`; [Run 611fa6eb-30bd-44ae-b449-f5291345ea71](http://localhost:13001/activity?runId=611fa6eb-30bd-44ae-b449-f5291345ea71); Error: initial Browser QA failed. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/html-css.json).
- Laravel: FAIL; project `f72ad19f-4b6f-4021-ba84-9d4f591b07f7`; [Run c6ce584f-4e30-4d53-8f44-73df2fc5b129](http://localhost:13001/activity?runId=c6ce584f-4e30-4d53-8f44-73df2fc5b129); Error: creation failed: Sandbox command failed: sent tapfd=7 for tap0. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/laravel-advisory-block.json).
- Laravel: FAIL; project `64f13d2b-d2a0-4479-8761-c23db46916e3`; [Run 883f6174-911b-4094-b973-574dd06711b6](http://localhost:13001/activity?runId=883f6174-911b-4094-b973-574dd06711b6); Error: creation failed: Sandbox command failed: sent tapfd=7 for tap0. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/laravel-packagist-timeout.json).
- Laravel: BLOCKED; project `5787e60f-b842-4d74-842b-c4e5b77fcf58`; [Run 1020633d-060b-4bcf-8c60-5669cab09da5](http://localhost:13001/activity?runId=1020633d-060b-4bcf-8c60-5669cab09da5); Configured shared Sandbox ALLOWED_HOSTS omits repo.packagist.org. Composer CONNECT is denied with HTTP 403. No security or global network policy was relaxed.. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/laravel.json).
- NestJS: FAIL; project `331533a4-2bed-4217-91db-0225d8677a7a`; [Run 887ae426-4f7c-4baf-a2b2-ddd3c5bf9dd6](http://localhost:13001/activity?runId=887ae426-4f7c-4baf-a2b2-ddd3c5bf9dd6); Error: initial Browser QA failed. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/nestjs.json).
- Remix: FAIL; project `f90f1426-fb05-4fc5-87a3-25df07e91c14`; [Run 363b7e9a-acfb-4b16-a2b5-0d4b27c2fda1](http://localhost:13001/activity?runId=363b7e9a-acfb-4b16-a2b5-0d4b27c2fda1); Error: initial Browser QA failed. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/remix-after-esm-fix.json).
- Remix: FAIL; project `c11a518b-962f-43b7-9ee0-4891c24caa26`; [Run 5366b87b-df67-450d-8a4e-566877535d81](http://localhost:13001/activity?runId=5366b87b-df67-450d-8a4e-566877535d81); Error: creation failed: self_review_unresolved. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/remix-review-finding.json).
- Remix: FAIL; project `a44c6152-0b86-4c6b-b1b8-65b50c7ea78f`; [Run cd59fca8-aaf1-4527-b5fe-da1f0645e0ab](http://localhost:13001/activity?runId=cd59fca8-aaf1-4527-b5fe-da1f0645e0ab); Error: initial Browser QA failed. [Evidence](../../artifacts/framework-chat-e2e-current/attempts/remix.json).
- Angular: BLOCKED; project `12184da4-cff3-46cd-826c-c1fda3a74a50`; run not yet captured; Host/Docker stopped during dependency installation; recovered process interrupted before session started. [Evidence](../../artifacts/framework-chat-e2e-current/host-interruption/angular.json).

## Підсумок і значення статусів

**14 PASS, 1 BLOCKED (Laravel). Усі 15 отримали реальну спробу через Send у чаті.** Для кожного PASS збережені окремі create/edit Run ID, той самий Project ID, початкова/оновлена сторінки та фінальна Browser QA. Рядок Remix відповідає React Router Framework із SSR. Nuxt, SvelteKit і React Router також перевірені за HTML, який повертає сервер до виконання JavaScript.

Для HTML/CSS/JavaScript немає компілятора, manifest залежностей чи production build-команди. Тому **Build = NOT TESTED**, а не вигаданий успішний build. Статичний результат перевірено через справжній сервер і Proxy: стилі, виконання JavaScript, лічильник, посилання, мобільна ширина та зміни після другого повідомлення. Dependencies PASS тут означає, що зовнішніх пакетних залежностей немає. Це не твердження про виконаний `npm install`.

PASS описує перевірений smoke-сценарій у цьому середовищі. Це не гарантія проходження довільного наступного запиту моделі, production-навантаження чи функцій магазину, яких немає в тестовому завданні.

## Реальні дефекти та виконані виправлення

1. **Помилковий terminal lifecycle.** Успішні Preview отримували `preview_start_failed`, а невдалий start міг відображатися як running. `project-sandbox-service.ts` тепер використовує фактичний `raw.status`; errorCode додається для failed/timed_out. [Реальний запис після виправлення](../../artifacts/framework-chat-e2e-current/trace-fix-real-evidence.json).
2. **Зупинка після втрати локальної session map.** До виправлення stop міг повертати 200/stopped із живим listener. Повторно використано наявний `stopRecordedPreview`, включно з dev/production командами та фактичним портом. Невдалий stop більше не приховує помилку й не стирає metadata. [До](../../artifacts/framework-chat-e2e-current/isolation-cold-api-stop-before-fix.json), [після](../../artifacts/framework-chat-e2e-current/isolation-cold-api-stop-after-fix.json).
3. **Angular: `serve` не підтримує `--port`.** Production build був успішний, але `npm run start -- --port …` завершувався `ARG_UNKNOWN_OPTION`. Детектор передає чинний serve script нормалізатору, який підставляє `-l`. Повний повторний Chat create/edit — PASS.
4. **React Router: відсутній `isbot`.** Framework запускав додаткове встановлення під час build і втрачав dev tooling. Залежність додано до існуючого starter.
5. **React Router: ресурси та basename Preview.** Inline ESM imports зверталися до `/assets/…` поза Proxy; після виправлення ресурсів router ще неправильно трактував шлях проксі. Наявний browser bridge/HTML transform тепер узгоджує module URLs, asset manifest і SSR context basename. Стилі, SSR, hydration та лічильник підтверджені фінальним create/edit. [Початкові 404](../../artifacts/framework-chat-e2e-current/remix-module-diagnostic.json).
6. **Project API links.** Реальний клік на `/api/info` відкривав API NPATI. Навігація посилань тепер залишається в Preview; службові SDK fetch до API платформи зберігають свою поведінку. [Клік до виправлення](../../artifacts/framework-chat-e2e-current/nestjs-navigation-before-fix.json). NestJS/FastAPI після виправлення пройшли QA та same-chat edit.
7. **Fastify starter.** HTML усередині довгого escaped JS-рядка спричинив помилкове редагування з `TS1002: Unterminated string literal`. HTML винесено в `index.html`, а manifest узгоджено з ESM/top-level await. Один повний цикл скоротився приблизно з 7 хв 44 с до 3 хв 6 с; це порівняння двох прогонів, не контрольований benchmark.
8. **Django starter.** Фіксований `SECRET_KEY` блокувався штатним secret-content захистом під час синхронізації. Використано env або криптографічно випадковий локальний ключ. Захист не вимикався; регресія також перевіряє, що hardcoded secret залишається недоступним. Повний Chat create/edit — PASS.
9. **Self-review втрачав попередній patch того самого файла.** Reviewer хибно повідомляв про відсутній title, який уже був у `meta`. `boundedDiff` використовує наявні turn summaries і зберігає послідовні patch. Ліміт одного self-review/fix та verification gate збережено. [Конкретний finding](../../artifacts/framework-chat-e2e-current/remix-self-review.json); після виправлення Remix create/edit — PASS.
10. **Статичний шаблон.** Виправлено відсутні цілі pricing/hero посилань у наявному component registry. Шаблон та adapter збережено; новий дубль шаблону не створювався.
11. **Laravel starter/config.** Додано офіційний `repo.packagist.org` до Docker allowlist. Composer відхилив Laravel 11 через advisories; starter оновлено до Laravel 13 з PHP target 8.3.0, без `--ignore-platform-reqs` або вимкнення advisory blocking. Сумісність Laravel 13 із PHP 8.3 підтверджена [офіційними release notes](https://laravel.com/framework/docs/releases). Остаточний результат лишається BLOCKED, див. нижче.
12. **404 favicon хост-інтерфейсу.** Додано SVG favicon та декларацію в NPATI document head. Збережено чинні frontend JS/CSS bundles локального Docker. [Спостереження до виправлення](../../artifacts/framework-chat-e2e-current/host-favicon-before-fix.json); фінальна React QA має 0 console errors, favicon повертає HTTP 200.

Детектор framework/команди переміщено в `project-preview-stack.ts` зі збереженням public re-exports. Це перенесення існуючих функцій, а не другий detector. Source-size guard пройдено без послаблення baseline.

## Laravel: точна межа підтвердження

- Перша реальна спроба: Composer CONNECT 403 до `repo.packagist.org`; конфігурацію виправлено.
- Наступна: Composer відхилив `laravel/framework ^11.0` через advisories `PKSA-d5tc-s1qs-h781`, `PKSA-3r5d-mb8f-1qw9`, `PKSA-m5cs-t1y6-qpcs`, `PKSA-mdq4-51ck-6kdq`; starter оновлено.
- Дві обмежені Laravel 13 Chat-спроби: `curl error 28`, connect timeout **10001 ms** для `repo.packagist.org/packages.json`; Composer **exit 100**. Це завершення Composer, а не успішний install чи NPATI build.
- Пізніші `curl` і `composer diagnose` в тому самому UID/network sandbox досягли реєстру. Тому загальний постійний outage Packagist не доведено. `composer diagnose` додатково зафіксував 403 для окремого audit endpoint `packagist.org/api/security-advisories/` та відсутні Composer self-update pubkeys.
- [Діагностичний curl](../../artifacts/framework-chat-e2e-current/laravel-packagist-diagnostic.json), [Composer diagnose](../../artifacts/framework-chat-e2e-current/laravel-composer-diagnostic.json), повний stderr/exit/duration — у `laravel.json` і попередніх attempts.
- **Laravel application build, runtime, `/health`, Live Preview та edit не досягнуті.** Робочий curl до registry не зараховано як успішний Laravel тест. Потрібне подальше налаштування Composer transport/audit у середовищі та окрема перевірка доставки приватного APP_KEY після install.

## Activity, Run Trace та повторні перевірки

[Activity UI QA](../../artifacts/framework-chat-e2e-current/activity-ui-qa.json) містить **15 перевірок реального `/activity?runId=…`**: правильний run ID, state, події, вкладки Terminal Logs та Errors & Warnings. Для 14 застосунків останній edit run завершений; Laravel показує failed preparation і помилку встановлення. Успішна перевірка UI Laravel означає видимість помилки, а не працездатність Laravel.

Code Activity, Development Process і Project Terminal — наявні джерела даних. До запуску моделі підготовка відображається як `coding_setup`; відсутність model events на цьому етапі не підмінялася фіктивними model calls. Повні Activity сторінки зібрано з пагінацією; stdout/stderr та exit codes залишено в terminal evidence. Відхилені політикою інструменти й попередні помилки не вилучалися.

Виправлено також недоліки harness: поновлення короткоживучої auth-сесії, реальні кліки через navigation bridge замість прямого GET raw href, вибір кнопки замість секції `#counter`, відновлення власних явно зупинених Preview для діагностики. Pre-submit HTTP 401 не зараховані як framework tests. Попередні знімки збережені в `before-runtime-fixes`, `harness-auth-expired`, `host-interruption` та `attempts`.

## Ізоляція та остаточний стан ресурсів

[Остаточний аудит](../../artifacts/framework-chat-e2e-current/runtime-final-audit.json):

- **124 попередні проєкти, 167 контрольних файлів: 0 змін.** Це перевірка збережених baseline hashes, а не твердження про повне хешування всіх файлів усіх проєктів.
- 30 власних тестових проєктів з урахуванням історії виправлень; 154 логічні runtime entries загалом. Унікальні UID й порти; **0 конфліктів**. Директорії збережено, користувацькі проєкти не видалялися.
- **0 власних активних OS-процесів, 0 відкритих тестових портів.** Логічні UID/port reservations збережені разом із проєктами; мережеві listeners звільнені.
- Зупинка Angular залишила Fastify доступним із HTTP 200 та правильним вмістом: [реальна перевірка](../../artifacts/framework-chat-e2e-current/isolation-after-framework-fixes.json).
- Один спільний runner, **4 CPU / 4 GiB**, зі збереженими named volumes. Новий Docker container для кожного сайта не створювався. Один контрольований recreate runner застосував registry config після доказу **0 власних і 0 сторонніх project-процесів**: [guard](../../artifacts/framework-chat-e2e-current/before-runner-update.json).
- Між частинами прогону Docker/host був зупинений ззовні. Angular install перервано й збережено окремо; неперервний uptime старих Preview через цю зовнішню зупинку не заявляється.
- Після штатної зупинки лишилися 25 stale network socket каталогів launcher. Після перевірки власних UID та відсутності процесів видалено лише їхні порожні Unix sockets і каталоги, без recursive delete: [cleanup](../../artifacts/framework-chat-e2e-current/network-temp-cleanup.json). Остаточно їх **0**. Автоматичне прибирання IPC після примусових зупинок залишається окремим удосконаленням runtime.
- API, worker і runner healthy. Хеш `/app/dist/server.js` збігається з перевіреним локальним build; API/worker використовують той самий image. Fingerprints і source hashes записані в аудиті.

## Перевірки коду та залишкові ризики

**235 тестів у 12 файлах — PASS**, API build — PASS, API/shared typecheck — PASS, source-size guard — PASS. Це regression/unit перевірки; вони не використовуються замість Chat E2E для присвоєння PASS фреймворкам.

Подальша підтримка потрібна Laravel/Composer у цьому середовищі та автоматичному прибиранню stale IPC. Час перших install залежить від мережі й доступних prepared profiles; model tools/self-review можуть додавати кроки, тому швидкість не гарантована. Django/Flask/PHP Preview-сервери й мінімальні test backends не сертифіковані як production deployment. Міграції реальних БД, auth, оплати, навантаження та довготривала стабільність до цього smoke-прогону не входять.
