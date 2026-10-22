# Крок 9 — локальний Docker, реальні E2E та продуктивність

Дата: 2026-10-21, Europe/Kiev. Git HEAD: `b545d0cb35885ba51d4cb6c06e1c8aa12cab6a44` + незакомічене робоче дерево Кроків 1–8.

**Статус: частково виконано, до production не готово.** Наявний локальний стек оновлено; 10 додаткових реальних чат-прогонів завершено. У БД підтверджено ще 5 попередніх прогонів Кроку 9. Security Gate зелений, але ширший regression-набір має 17 невдалих тестів і одну suite з невдалим preflight. Частина обов’язкових E2E заблокована автентифікацією та MCP wiring. Заміни реальних AI-викликів mocks у чат-прогонах не було.

Попередню редакцію звіту збережено в `artifacts/step9-local/report-prior.md`. Наведені нижче факти замінюють її висновок про відсутність регресій та умовну production-готовність.

## 1. Локальний стек, збереження даних і deployment

Docker context: `desktop-linux`. Єдиний запущений Compose-проєкт: `npati-isolated-source-20261011`. На початку цієї перевірки API/worker уже працювали на `npati-step9-local:20261021`, image `e8fb58feb33b8a6375f525507bf862bf0822ed34ab899f9be25ffcbaa2ef8281`. Повторна збірка з поточного repo root успішна, API і worker recreate у цьому самому проєкті.

| Параметр | До повторного оновлення | Після |
|---|---|---|
| API / worker image | e8fb58fe… | 3003cb7a… |
| Повний поточний image ID | — | sha256:3003cb7a00c77f10a046cc04856ef0069cefaa7e71fcb4cf1e1f2671c8c8f6d3 |
| NPATI_BUILD_COMMIT | step9-b545d0c | step9-b545d0c |
| SHA256 bundled dist/server.js | d42fda7827d96167b5b354099a3a88665ad8a2a2a90b952f17546ef316c6bd7e | той самий у rebuild, API та worker |
| Source context | репозиторій + uncommitted changes | той самий; build API/web stages CACHED |
| Інші 8 сервісів | працювали | образи та контейнери не перебудовувалися |
| Volumes / networks | 11 named volumes, 4 networks | збережені |

BuildKit повторно створив manifest/attestation при тотожному build-контенті. Старий manifest після retag недоступний через image inspect; його RootFS не порівнювався. Тотожність bundled коду перевірено SHA256. Поточні API/worker image IDs точно відповідають rebuild. Сам build label без hash не вважається доказом версії незакоміченого коду.

Історичне оновлення з `npati-direct-startup-local:20261021` описане в попередній редакції та `build.log`; у цій сесії спостерігався вже Step9 image. Це не видається за новий вимір «до оптимізацій».

Поточні сервіси (повні IDs, mounts, env names і мережі — `inventory-recheck.json`):

| Сервіс | Образ / версія | SHA256 prefix | Health |
|---|---|---|---|
| company-worker | npati-step9-local:20261021 | 3003cb7a00c77f10… | healthy |
| agent-api | npati-step9-local:20261021 | 3003cb7a00c77f10… | healthy |
| sandbox-runner | npati-project-creation-runtime-local:20261021 | 0a3b726dd7049bdc… | healthy |
| crawler | npati-agent-crawler:0.9.2 | 69849fda6e18fc40… | healthy |
| browser-use-worker | npati-isolated-source-20261011-browser-use-worker | e164b72fe523141b… | healthy |
| minio | dappros/minio@sha256:624bad2fe79a8613aa3c5c9b765ebcab365080b8445cf1b05c357cc7753725f0 | 624bad2fe79a8613… | healthy |
| omniroute | docker.io/diegosouzapw/omniroute:3.8.50 | 085c57adf499a8aa… | healthy |
| postgres-projects | postgres:17 | 2d2b8998d31037bf… | healthy |
| redis | redis:7-alpine | 858f009f9709ce57… | healthy |
| postgres | pgvector/pgvector:pg17 | ac08538c6f8b9904… | healthy |

Окремого web-контейнера немає: `/app/web` з Docker web-build обслуговує agent-api на `127.0.0.1:13001`. API веде Chat/SSE, intent routing, runtime, verification і preview proxy; company-worker обробляє company/knowledge queue (concurrency=2). OmniRoute 3.8.50 маршрутизує живі запити до `deepseek/deepseek-flash` (provider ds). PostgreSQL pgvector pg17 зберігає control-plane і traces; postgres-projects 17 — дані сайтів. Sandbox працює в shared runtime, ізоляція `bubblewrap+slirp4netns`, без потреби Docker socket у runtime.

Жоден із цих API/worker контейнерів не має bind mount локального source: код запечений у image. Перебудова sandbox-runner не була потрібна: Кроки 1–8 не змінювали його runtime-код. Інвентар також містить раніше зупинений допоміжний code-monitor; його не запускали й не змінювали.

Named volumes: agent-data, postgres-data, postgres-projects-data, postgres-projects-snapshots, project-runtime-workspaces, project-runtime-state, omniroute-data, redis-data, minio-data, crawler-state, browser-use-state (усі з префіксом Compose-проєкту). Networks: npati-agent, npati-projects-db, npati-sandbox-control, npati-sandbox-egress. Дані PostgreSQL, sites/workspaces, snapshots, object storage та OmniRoute accounts збережено.

Використано наявний ланцюг `docker-compose.dokploy-isolated.yml` + 6 локальних overrides із artifacts + `compose.step9.override.yml`. Назва базового файла містить Dokploy, але target — перевірений локальний Docker Desktop; production-файли та віддалений deployment не редагувалися. Копії Compose-файлів — `config-snapshot/`. Існуючий helper бере чинні env контейнерів без друку їхніх значень. Env включає DATABASE_URL, OMNIROUTE_BASE_URL/API_KEY, sandbox secret, encryption/remote-token secrets, MinIO credentials та NPATI_* runtime limits; повний перелік назв у inventory. Секретні значення у цей звіт не внесено.

Резервні копії були створені до попереднього deployment; у цій сесії перевірено gzip-цілісність та SHA256:

| Backup | Стиснуто | Розпаковано | CREATE TABLE |
|---|---:|---:|---:|
| npati_agent-before-step9.sql.gz | 8 451 798 B | 61 209 473 B | 118 |
| db_ada2745e…_dev-before-step9.sql.gz | 2 849 B | 20 396 B | 11 |
| db_ada2745e…_prod-before-step9.sql.gz | 527 B | 997 B | 0 |

Деталі — `backup-validation.json`. Restore drill не виконувався. Міграцій у змінах Кроків 1–8 немає; нові міграції вручну не застосовувалися. Тестові TS/build-файли змінювалися через звичайний Project Files API, а виправлялися через Chat → реальний AI → sandbox. Існуючий користувацький сайт 868242c3… не редагувався; використовувалися лише створені Кроком 9 Sunrise Coffee (56cca2e2…) та Nordic Bread (7ad985a0…). Destructive Docker-команд, reset/clean/stash і комітів не було. Source/test-файли Кроків 1–8 не переписувалися. Patch і source hashes збережено локально.

## 2. Health і runtime після recreate

| Перевірка | Факт |
|---|---|
| Усі 10 Compose-сервісів | running / healthy |
| GET /health | 200; agent, database, omniroute, redis, crawler, storage — ok |
| Hub | not_configured, optional local integration |
| coreBackend | health читає remote endpoint і отримує 401; ніяких remote writes |
| company-worker | queue ready, commit step9-b545d0c, concurrency=2 |
| Sandbox /health | overall_ready=true, усі readiness flags true |
| Web UI GET / | 200, SPA shell 588 B |
| Coding runtime / native tools | 10 нових завершених реальних Chat/SSE runs |
| Activity / trace | SSE delta та persisted model/tool events; UI-відображення у браузері не перевірялося |
| Live Preview | фінальний внутрішній HTTP 200 на 5 routes, актуальний очікуваний текст |

Артефакти: `health-final.json`, `sandbox-health-final.json`, `web-final.json`, `preview-internal-final.json`, `log-review-final.json`. Healthy не означає, що всі бізнес-функції працюють: MCP та reaper мають помилки нижче.

## 3. Кожен обов’язковий E2E-сценарій

| № | Сценарій | Результат і межі доказу |
|---|---|---|
| 1 | Новий HTML/CSS/JS сайт | Частково: попередній реальний Sunrise Coffee run завершено, 2 HTML/CSS файли, до 18 038 символів аргументів. Нові три HTML/JS counter прогони не стартували: 401 TOKEN_EXPIRED; JS interaction не перевірено. |
| 2 | Новий Next.js сайт | Попередній реальний Nordic Bread run: completed, 8 files, 137.158 с run, production build passed. Три повтори створення не виконано. |
| 3 | Один CSS стиль | 3/3 нових real runs completed; styles.css змінено, static preview port 3123 reused. |
| 4 | React/Next компонент | 3/3 completed; H1 Morning → Afternoon → Evening, кожного разу новий build + self-review. |
| 5 | TypeScript error | Seed app/step9-type/page.tsx містив string = 42; реальний Chat виправив, build passed, фінальний route 200 із Step9 type repaired. |
| 6 | Build error | Seed app/step9-build/page.tsx імпортував missing-step9-module; Chat виправив, build passed, route 200 із Step9 build repaired. |
| 7 | Нова сторінка | Український page-uk: /about + link на home; 2 files, build passed, route 200. |
| 8 | Повторне редагування | Послідовні CSS та Next.js runs у тих самих тестових проєктах; контекст збережено. |
| 9 | Великий multi-file Patch/Diff | Частково: patch-pt створив 3 компоненти й змінив /about, 4 files; великий тест 8 × 30 FAQ підготовлено, але не виконано після TOKEN_EXPIRED. Не прирівнюється до large-argument stress test. |
| 10 | Malformed/truncated Tool Call | В нових живих runs таких подій немає; навмисна fault injection наживо не виконана. Partial rejection/loop tests проходять у regression; це не real fault E2E. |
| 11 | AI Provider failure | Наживо не інжектувалася. 401 remote-token expiry — auth failure, не provider failure. Unit/gate coverage не замінює живий сценарій. |
| 12 | Approval-required operation | Підготовлено нешкідливий node console.log; не виконано через expired token. Approval tests пройшли в gate; reaper має окремий defect. |
| 13 | UA / EN / PT routing | EN edits, UA page addition та PT patch completed у правильному test project. Нові три informational language probes не виконано. |
| 14 | How do I create a website? | У попередньому звіті зафіксовано advice без нового project (1→1). Raw result цього probe не збережено окремо; у цій сесії не повторено через auth blocker. Не подається як новий перевірений pass. |
| 15 | Реальний MCP discovery → approval → consume → execution | BLOCKED: app.ts source залишається null; runtime records mcp_integration_source_unavailable. Реального серверного approval consume/execution не було. |

Основний шлях у завершених runs: POST /chat/stream → intent routing → Coding Agent → OmniRoute → native tools → sandbox → verification/self-review → result/Preview. Mocks є лише в окремих regression-тестах; їхні мілісекунди не враховані як швидкість AI.

## 4. Вимірювання нових реальних прогонів

Модель усіх rows: deepseek/deepseek-flash, provider ds — та сама назва моделі, що в baseline. AI Calls включають self-review; Tool Calls включають автоматичну verification. Token count — сума persisted model-step usage, без незафіксованих review tokens. First tool — оцінка старту першої виконаної дії за timestamp completion мінус duration; початок відліку — run.started_at. First delta та Chat wall рахуються від client POST. Усі часові поля таблиці — секунди.

| Run | Chat wall / Run wall | First useful tool | First delta | AI / Tools | Tokens | Model incl review | TTFT p50 / p90 | Verify | Self-review | Files |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| css-1 | 25.238 / 20.258 | 3.378 | 5.600 | 4 / 4 | 57166 | 12.699 | 1.742 / 2.742 | 0.000 | 0.000 | 1 |
| css-2 | 25.719 / 19.949 | 4.538 | 6.289 | 4 / 3 | 52308 | 11.619 | 2.119 / 2.146 | 0.000 | 0.000 | 1 |
| css-3 | 16.272 / 12.136 | 3.885 | 6.497 | 4 / 3 | 55549 | 8.325 | 1.793 / 2.136 | 0.000 | 0.000 | 1 |
| component-1 | 50.884 / 44.696 | 2.073 | 3.800 | 4 / 3 | 41162 | 10.256 | 1.417 / 1.530 | 32.202 | 4.324 | 1 |
| component-2 | 45.245 / 38.644 | 1.968 | 3.492 | 4 / 3 | 40914 | 6.008 | 1.428 / 1.475 | 30.520 | 1.380 | 1 |
| component-3 | 49.893 / 43.547 | 2.394 | 4.148 | 4 / 3 | 41348 | 6.562 | 1.386 / 1.742 | 34.679 | 1.300 | 1 |
| page-uk | 63.324 / 57.274 | 3.036 | 5.219 | 6 / 7 | 117411 | 17.421 | 1.390 / 2.043 | 36.253 | 3.045 | 2 |
| patch-pt | 61.008 / 53.934 | 2.750 | 4.334 | 6 / 7 | 121603 | 20.256 | 1.354 / 1.572 | 29.680 | 3.441 | 4 |
| fix-typescript | 58.498 / 51.779 | 2.151 | 3.910 | 5 / 3 | 50546 | 10.268 | 1.406 / 1.811 | 38.814 | 1.538 | 1 |
| fix-build | 57.944 / 50.381 | 2.780 | 3.543 | 6 / 4 | 63279 | 11.883 | 1.492 / 1.589 | 35.684 | 1.889 | 1 |

Кожен row має completed; результати й повні відредаговані SSE-події — `<label>.json`. TTFT кожного модельного ходу та всі tool outcomes — `metrics-current.json`. Повторних аргументів у цих runs і rejected calls не зафіксовано (не означає відсутності проблем на всіх входах).

Для Next.js result містить Preview running на тому самому port 3144. Це верхня межа часу заявленої готовності: до Chat wall відповідного row. Точний момент готовності HTTP proxy не інструментовано. Фінальний внутрішній HTTP перевірено окремо; час «до first 200» у повному browser proxy E2E не виміряний. Cache-hit і cached tokens не персистуються у доступному usage; не виміряно. Не можна переносити відсоток cache hit із попередніх кроків на ці runs.

### p50 / p90 та baseline

Метод: nearest-rank; n=3, тому p90 фактично максимум із трьох, статистично слабка оцінка. Baseline взято з [coding-agent-performance.md](coding-agent-performance.md). Порівняння **неконтрольоване**: історична суміш задач/образів проти нових простих prompts, різний розмір diff і warmed runtime; CSS-прогони частково перетиналися із build/check навантаженням. Модельний alias однаковий, точна версія upstream моделі не зафіксована.

| Метрика, секунди | Baseline p50 / p90 | Після p50 / p90 | Інтерпретація |
|---|---:|---:|---|
| CSS Run wall | 32.659 / немає | 19.949 / 20.258 | Спостережувана медіана нижча на 38.9%; не доказ причинного прискорення |
| CSS Chat wall | немає | 25.238 / 25.719 | Окремий client timing |
| Next component Run wall | 55.968 / немає (framework proxy) | 43.547 / 44.696 | Спостережувана медіана нижча на 22.2%; proxy baseline |
| Next component Chat wall | немає | 49.893 / 50.884 | Усі 3 edits completed |
| CSS first useful tool | загальна вибірка 4.800 / 30.975 | 3.885 / 4.538 | Вибірки різні |
| Component first useful tool | загальна вибірка 4.800 / 30.975 | 2.073 / 2.394 | Вибірки різні |
| CSS model TTFT | один історичний run 1.471 / 24.323 | 1.892 / 2.327 | Не плутати із first client delta |
| Component model TTFT | той самий історичний run | 1.417 / 1.742 | 9 основних model calls |
| Component build time | 12.676 / немає (framework proxy) | 32.202 / 34.679 | Повний build лишився дорогим; прискорення build не доведено |
| Component self-review | загалом 4.840 / 19.818 | 1.380 / 4.324 | Різні задачі, n=3 |

Baseline не містить сценарних p90 для CSS і component; вони не вигадувалися і не замінювалися загальним p90. Висновок про загальне гарантоване прискорення агента неможливий. Успішний Next.js creation 137.158 с не порівнюється з 296.510 с історичного HTML/CSS store як «один сценарій» — це різні задачі.

## 5. Що доведено щодо оптимізацій

| Ділянка | Живий доказ | Обмеження |
|---|---|---|
| Native Tool Calling | виконані model toolCalls, великі попередні аргументи до 18 038 chars без truncation | колишній патологічний output-token режим не відтворений; fallback лише regression |
| Partial calls / loop detection | нових rejected немає; tests проходять | відсутність інциденту не є fault-injection тестом |
| Verification | 3 component + page + patch пройшли обов’язковий build | fingerprint invalidation у живому negative-case окремо не інжектувалася |
| Reuse | TS/build fix runs: verificationRuns=1, reused=true після model-initiated successful build | source code/test assertions обмежують reuse fingerprint; окремий live stale-fingerprint case не виконаний |
| Repair | TS і missing-import виправлено та зібрано | модель виправила до першого невдалого build; automatic failed-build repair loop наживо не продемонстрований |
| Self-review | Next edits: elevated, clean, 1 run; creation high risk clean | статичний шлях має дефект changedFiles=0; kill switch лише tests |
| OmniRoute | provider ds, модель deepseek-flash, usage і TTFT є | cache hits, wire-level schemas/token limits/reasoning окремо не записані; tests перевіряють контракт |
| Streaming / Activity | delta-події збережено в кожному новому row, один terminal result | відсутність дублювання у rendered UI не перевірена браузером |
| Static Preview reuse | CSS runs повторно використовують port 3123 | API recreate пізніше скинув in-memory session; HMR не вимагався |
| Tenant / permissions | gate suites проходять; expired token реально відхилено 401 | live cross-tenant negative probe та approval cycle не виконані |

## 6. 576 історичних Tool Calls: незалежна реконструкція

Джерело: остання версія replay bundle на run, created_at < 2026-10-21T18:00:00Z, 202 bundles. Ключ повтору — tool name + argumentsHash усередині одного run. Усього **184 групи, 576 входжень, 392 повтори після першого**. 576 не означає 576 зайвих дій.

| Клас / ознака | Повторів | Значення |
|---|---:|---|
| Між сусідніми повтореннями є успішна file mutation | 81 | Потенційно корисне перечитування / повторна verification після змін |
| Між сусідніми повтореннями немає записаної file mutation | 311 | Кандидати на дублювання; не доведено зайвість кожного |
| Попередній ідентичний call завершився не ok | 18 | Error recovery / retry, перетинається з двома попередніми класами |
| Між повторами був verify | 69 | Можливе перечитування після diagnostics; overlap |
| Між повторами завершився self-review | 1 | Підтверджено за activity timestamps; overlap |
| В одному turn | 0 | Такого дублювання немає |

Розподіл повторів: read 306, verify 35, list 21, write 12, edit 5, shell.exec 3, deps.add 3, tree 2, apply_patch 2, grep 1, process.start 1, process.list 1 = 392.

Сума recorded tool duration повторних викликів: **1284.498 с**; із них без записаної mutation **671.089 с**. Це інструментальний час усієї історичної вибірки, не wall-time економія: model latency, dependency state, parallelism і необхідність перевірок тут не атрибутовані. Повтори після mutation не видалялися.

У записаній історії немає model attempts >1; це відсутність evidence для transport retry, а не доказ, що provider ніколи не повторював запит. Є 6 runs зі stopReason=provider_error, 2 loop_detected, 3 self_review_unavailable. Вивести всі дублікати з provider failure без request-level wire traces неможливо. Після успішних читань незмінного state доцільно дослідити повторне формування контексту моделлю. Через помилки 18 повторів можуть бути потрібними. Після verify/review частина повторів є діагностичною. Стару оцінку «222 без mutation / 170 після mutation» замінено: вона класифікувала групи цілком, тут mutation перевіряється між кожною парою сусідніх однакових викликів.

## 7. Реальні дефекти та помилки середовища

1. **MCP integration source не під’єднаний.** app.ts оголошує mcpIntegrationSourceForRuntime=null і передає getter в code-engine wiring; повернений app-company-automations.ts source не присвоюється. Runtime discovery щоразу degraded/skipped, хоча code.mcp увімкнено. Це wiring defect, а не просто відсутній MCP server. Правила не обходилися, ручну підміну manifest не виконували.
2. **Static self-review втрачає changedFiles.** CSS/HTML summary містить filesChanged=1/2, а selfReview.inputs.changedFiles=0 → not_run/no_changes_to_review. Таке пояснення пропуску некоректне; live adaptive low-risk policy не можна вважати перевіреною.
3. **Reaper lifecycle degraded.** code_reaper_step_failed: stale_approvals → Approval expiry requires the audit journal; expire_user_questions → code_ask_user_reaper_not_ready. Service health зелений попри цей функціональний дефект.
4. **Live Preview transient failures.** Після Next edits у логах API/runtime є preview_upstream_failed/HTTP 502, потім кінцевий HTTP 200. Джерело — тимчасова недоступність upstream під час build/restart; повний часовий зв’язок і кількість видимих UI збоїв не інструментовані. Також code_run_sandbox_release_unavailable. HMR відсутній і не був критерієм успіху.
5. **Scope guard noise.** app/page.tsx і styles.css позначаються unrelated для відповідних точкових редагувань. Warning advisory, не блокував завершення.
6. **Regression fixtures/catalog expectations.** 12 execution-mode tests створюють CodeService з порожнім workspace {} as never, тому manifest detection падає до перевірки assertions. Окремий run відтворив 12/12. Ще 5 assertions у c2/c3/c4 capability suites очікують 49 при manifest v14 / 50. Tests не вимикалися, expectations не послаблювалися. CodeService і execution-mode test не відрізняються від HEAD; причинність від Кроків 1–8 не доведена.
7. **Stock smoke harness не налаштований на цей стек.** beforeAll fetch health не досягає configured target; suite очікує окремий smoke tenant/DB/config. Його failed preflight не видається за провал реального ручного Chat suite чи за успіх пропущених tests.
8. **Expired test auth.** Новий create-html POST отримав 401 INVALID_REMOTE_TOKEN / TOKEN_EXPIRED до model call. Поновлення шляхом читання signing secret і випуску bearer token відхилив автоматичний approval review як credential probing/authentication bypass. Дія не виконана, дозволи не розширювалися. Для решти protected E2E потрібна штатна нова тестова сесія; сценарії не оголошено пройденими.

## 8. Фінальні перевірки

| Команда / перевірка | Результат |
|---|---|
| Docker compose build agent-api (API + web) | PASS; build-recheck.log |
| npm run typecheck | PASS, exit 0; typecheck-current.log |
| npm run security-gate | PASS, 183 suites, 2838 passed / 0 failed / 0 skipped; security-gate-current.log |
| npm run audit:code-tools | PASS, 50 tools, manifest v14, checksum 8cc857eeb17be7f185ca5511fee4d7203520eb1098c20c1698d1772dd8722587 |
| Step1–6 focused regression | PASS, 6 files, 66 tests; step1-6-current.log |
| npx vitest run coding-agent sandbox approval git | FAIL: 205 files, 192 passed / 5 failed / 8 skipped; tests 2920 passed / 17 failed / 38 skipped; regression-current.log |
| Isolated execution-modes reproduction | FAIL, 12/12; execution-modes-recheck.log |
| Sandbox / approval / Git subsets | Інші відповідні gate/regression suites пройшли; загальний набір не зелений |
| Real Chat → Agent → Sandbox → Preview | 10 нових completed, попередні 5 підтверджено БД; повна матриця 15 сценаріїв не завершена |

Security Gate має 6 попереджень про placeholder unverified sandbox image catalog entries. У цьому shared runtime Docker images не потрібні; ці warnings не перетворюються на дозвіл production deployment unverified images. Existing skipIf/live/DB умови в regression не змінювалися.

## 9. Висновки та наступні дії в межах Кроку 9

- **Локальні Docker-сервіси працюють:** так, усі 10 running/healthy; MCP і reaper функціонально degraded.
- **Поточний код Кроків 1–8 застосовано:** так, rebuild із робочого дерева, API/worker на перевіреному image, bundled hash збігається; незакомічені зміни збережено.
- **Наскільки прискорився агент:** у непорівнянних історичних вибірках CSS run p50 32.659 → 19.949 с (−38.9%), component proxy 55.968 → 43.547 с (−22.2%). Це спостереження, не контрольована оцінка загального ефекту. Build залишається головним витратним етапом Next.js edits.
- **Автономність AI збережено:** у завершених runs модель сама читала, змінювала і перевіряла код; scripted implementation або mock AI не використовувалися. Всі неперевірені шляхи окремо позначені.
- **Відсутність регресій:** не підтверджена; є 17 test failures і виявлені runtime defects. Приписувати їх усі оптимізаціям без контрольного старого дерева неправильно.
- **Production readiness:** **НІ**. Production не змінювався.

Для завершення Кроку 9: відновити штатну тестову автентифікацію; виправити MCP source wiring і static review inputs; перевірити audit-backed reaper; узгодити test fixtures/catalog invariants; завершити HTML/JS ×3, Next creation ×3, large patch, approval, live provider/tool failure, MCP і інформаційний routing; повторити критичні checks після виправлень. Для подальшої оптимізації дослідити 311 повторів без записаної mutation, build 30–39 с на дрібну зміну та Preview restart gap. Не прибирати необхідну verification або security review заради числа.

## 10. Відтворення та ідентифікатори

Локальні утиліти: `chat-suite.mjs` (POST/SSE), `repair-suite.mjs` (test-only seeds), `large-patch.mjs`, `collect-metrics.cjs` (тільки SELECT), `verify-backups.mjs`. Protected suite потребує валідної штатної тестової авторизації. Не використовувати expired token чи ручний випуск через signing secret. Артефакти можуть містити тестовий контент; не публікувати backup/token/config artifacts. Токени з нових SSE-артефактів redacted.

| Run ID | Test project | Terminal | Max argument chars |
|---|---|---|---:|
| code-run-mvig4ssw-ltpyn32t | 56cca2e2-3e39-4624-99f4-9f93a954408f | completed | 18038 |
| code-run-mvig72tl-ihaik8xx | 56cca2e2-3e39-4624-99f4-9f93a954408f | completed | 2665 |
| code-run-mvig8jli-vfiyuuxq | 54a211ca-ede0-4c47-af62-6627e93bd2bb | completed | 3147 |
| code-run-mvigbdyz-5konc16u | 7ad985a0-d024-4773-a6b6-eaf68754a9a3 | completed | 14962 |
| code-run-mvigmo1f-zwm4btrh | 56cca2e2-3e39-4624-99f4-9f93a954408f | completed | 469 |
| code-run-mvih0agt-382fgmxo | 56cca2e2-3e39-4624-99f4-9f93a954408f | completed | 420 |
| code-run-mvih0tpf-hnhc7gm0 | 56cca2e2-3e39-4624-99f4-9f93a954408f | completed | 97 |
| code-run-mvih1dy0-ga0i9b7l | 56cca2e2-3e39-4624-99f4-9f93a954408f | completed | 227 |
| code-run-mvih3bmq-naijx4ij | 7ad985a0-d024-4773-a6b6-eaf68754a9a3 | completed | 232 |
| code-run-mvih4eu4-1x7w3j4h | 7ad985a0-d024-4773-a6b6-eaf68754a9a3 | completed | 143 |
| code-run-mvih5dz1-52cfq0lx | 7ad985a0-d024-4773-a6b6-eaf68754a9a3 | completed | 143 |
| code-run-mvih6gyc-svwq5ubo | 7ad985a0-d024-4773-a6b6-eaf68754a9a3 | completed | 2948 |
| code-run-mvih7t9x-itwnogqk | 7ad985a0-d024-4773-a6b6-eaf68754a9a3 | completed | 1634 |
| code-run-mvih9d0e-4mc8wgko | 7ad985a0-d024-4773-a6b6-eaf68754a9a3 | completed | 277 |
| code-run-mvihaluk-k95uqh98 | 7ad985a0-d024-4773-a6b6-eaf68754a9a3 | completed | 191 |
