# Крок 10 — стабілізація локального runtime

Дата: 2026-10-21, Europe/Kiev. Основа: [фактичний звіт Кроку 9](step-9-local-docker-e2e-performance.md). Git HEAD: b545d0cb35885ba51d4cb6c06e1c8aa12cab6a44 + збережене незакомічене дерево Кроків 1–8 та цього кроку.

**Статус: runtime-виправлення реалізовано; захищені live E2E заблоковані штатною автентифікацією. Production readiness: НІ.** Нових успішних AI Chat-прогонів Кроку 10 немає. Результати Кроку 9 не зараховано як нові тести. Mock-моделі використовуються лише в regression fixtures.

## 1. Першопричини та виправлення

| Дефект | Причина | Виправлення та доказ |
|---|---|---|
| MCP discovery degraded | app-company-automations повертав configured integration source, але app.ts не присвоював його змінній runtime getter | Підключено вже наявний source. Composed regression підтверджує binding: порожній repository дає нуль tools, а не source unavailable. Null/unknown tools залишаються fail-closed. Реальне серверне виконання MCP ще не підтверджене. |
| Static self-review втрачав changedFiles | Завершення без build checks обходило review phase; початкові review inputs не містили tracked changes | Використано існуючі runChanges/Workspace Diff та adaptive decision. HTML/CSS/JS зі змінами проходять review навіть без build checks. Зміни без diff дають unavailable/review_diff_unavailable, а не no_changes_to_review. Blocking repair без налаштованих checks зупиняється з self_review_unresolved. |
| stale_approvals | Audit adapter захоплював початковий system workspace; release port захоплювався до ініціалізації | Audit scope походить з immutable approval row, actor/role і tenant store checks збережено. Getter читає чинний release port. Якщо port відсутній, expiry зупиняється до зміни рядків. |
| expire_user_questions | Late-bound reaper port передавався як початкове undefined | Getter через обидва шари wiring читає чинний port; використано існуючий lifecycle service. |
| 12 execution-mode failures | Порожній workspace fixture не реалізував listFiles для manifest detection | Fixture реалізує listFiles; початкові assertions збережено. |
| 5 capability assertions | Старий каталог не враховував code.data.backend.create | Підтверджено manifest v14: 50 code tools, total 398, callable 134, non-callable 264. Оновлено count, ordered IDs і matrix; assertions не вилучалися. |
| Preview restart 502 | Proxy звертався до upstream між stop/start та HTTP readiness; in-memory стан не переживав API restart | Перед stop зберігається building. Тільки starting/restarting/building дають 503 + Retry-After: 1. Readiness deadline збережено. Startup failure зберігає failed; persisted failed повертає 502 також після API restart. Постійні помилки не маскуються. |

Preview regression покриває cross-instance building, startup failure і durable failed. Новий браузерний часовий вимір restart gap не отримано. HMR не додавався.

## 2. Змінені файли цього кроку

Runtime, apps/agent-api/src/:

- app.ts — MCP binding і late-bound lifecycle ports.
- app-code-tool-runtime-wiring.ts, code-ports-wiring.ts — getters та fail-closed expiry.
- approvals-repository.ts, audit-services.ts — audit scope з approval row.
- coding-agent-review-coordinator.ts, coding-agent-review-phases.ts — static review та перевірка repair.
- code-self-review.ts, code-self-review-types.ts — missing diff reason.
- project-preview-service.ts — persisted readiness/failed lifecycle.

Локальна конфігурація: compose.step10.override.yml — тільки API/worker image та існуюча MinIO конфігурація з existing env-file.

Regression, tests/:

- coding-agent-execution-modes; c2/c3/c4-capabilities; c1c-audit-log; c13-mcp-run-path-wiring.
- coding-agent-step10-runtime-wiring (новий), step4-self-review, c9-self-review, project-preview.
- step2-verification, c9-runner-verification, c6-runner, c10-run-checkpoint-link: review fixtures мають diff та окрему no-tools review відповідь без споживання implementation script.
- coding-agent-data-tools: backend fixture містить обов’язкові reason/userMessage.
- coding-agent-e2e/smoke: використовує лише легітимний NPATI_E2E_ACCESS_TOKEN замість ручного підписання JWT. Без сесії preflight явно BLOCKED, suite має nonzero exit; тести не вимкнено.

Назви тестів вище відповідають файлам *.test.ts. Частина цих файлів уже містила зміни Кроків 1–8: їх збережено. Повний git diff не є виключно diff цього кроку. Production compose і віддалений deployment не редагувалися; дублікати discovery/approval/reaper не створювалися.

## 3. Deployment і збереження даних

Docker context desktop-linux, єдиний існуючий project npati-isolated-source-20261011. Перебудовано один runtime image, recreate тільки agent-api та company-worker. Web входить до API image. Інші вісім image IDs та container Created збігаються з inventory Кроку 9: inventory-comparison.json.

| Параметр | До | Після |
|---|---|---|
| API/worker tag | npati-step9-local:20261021 | npati-step10-local:20261021 |
| Image ID | sha256:3003cb7a00c77f10a046cc04856ef0069cefaa7e71fcb4cf1e1f2671c8c8f6d3 | sha256:bd4e380a8d653f00b76d4f0922e3df56ab26730a60c9161c3225950ba6dcbd9a |
| Build label | step9-b545d0c | step10-b545d0c |

Bundled /app/dist/server.js у final image, API та worker має однаковий SHA256: bfdc8be9c13e80fae7321cc67c7087ca89bed0013395693f2ddd69062a9dd542. Image IDs запущених API/worker також збігаються з build. Сам label без hash не є доказом версії незакоміченого коду. Readback: final-deployment.json.

Перед deployment створено новий pg_dump custom format: artifacts/step10-local/npati-agent-before-step10.dump, 8 988 352 bytes, SHA256 d44694c24ac199f8520b477a472f60beb901e62d47401a80c69a3f68e2cc7ace; pg_restore --list підтвердив 766 TOC entries. Restore drill не виконувався. Нових schema migrations немає. Volumes, networks і дані збережено. down -v, prune, reset/clean/stash не виконувалися. Lifecycle expiration — переходи за чинною TTL policy, без видалення рядків або надання дозволів.

Helper compose.ps1 використовує той самий локальний ланцюг overrides, existing env-file та port 13001. Значення secrets не витягувалися з контейнерів і не друкувалися; signing secrets не читалися. Production-файли не змінювалися.

Під час фінального recreate зовнішній PowerShell сприйняв Compose progress на stderr як NativeCommandError і перервав wrapper. Повтор того самого targeted up через captured native streams завершився exit 0; readback підтверджує результат. Обидва логи збережено: deploy-complete.log, deploy-verified.log.

## 4. Штатна автентифікація

Перевірено UI Sign in → Connect NPATI Account, installation start/poll/session та /auth/me. Користувач повідомив про завершення входу, але dedicated тестовий профіль не отримав local access token; локальний UI залишився без authenticated session. Installation status connected означає конфігурацію installation, а не сесію цього браузера.

POST /api/auth/installation/start повернув 201. Після відкриття офіційного verification URL normal poll завершився HTTP 400 INSTALLATION_AUTH_FAILED. POST installation/session без browser session повернув 401. Точну upstream причину pairing failure не встановлено. Валідного server-issued bearer для /auth/me не отримано: auth-status.json.

Ручні JWT, читання signing secrets, обхід middleware, expired token Кроку 9 та чужі browser profiles не використовувалися. Protected E2E залишені Blocked згідно з вимогами користувача. Для продовження потрібна успішна штатна тестова сесія; секрети в чат передавати не потрібно.

## 5. Health та функціональний reaper

Остаточно всі 10 сервісів running/healthy: agent-api, company-worker, sandbox-runner, crawler, browser-use-worker, minio, omniroute, postgres-projects, redis, postgres. /health та Web UI повертають HTTP 200. Database/OmniRoute/Redis/crawler/storage — ok. Hub optional/not_configured; remote Core відповідає 401 на health reachability probe: це не authenticated E2E і не remote write. Артефакт: final-deployment.json.

Sandbox: overall_ready=true, усі readiness flags true, bubblewrap+slirp4netns. Наявний тестовий Next /about внутрішньо повернув HTTP 200 з очікуваним текстом. Це перевірка поточного preview, не новий Chat → Preview run: sandbox-preview-health.json.

**Живий reaper після виправлення:** staleApprovals=37, expiredUserQuestions=2, errors=[]. Наступні цикли — нуль нових expiration, без помилок. DB readback: 37 audit expiration records, actor system / role service, workspace_mismatches=0; два expired user questions, два interrupted runs, pausedRuns=[]. Артефакти: reaper-live.json, lifecycle-db-check.json, lifecycle-final-check.json. Нові approval/deny/cancel сценарії цим не замінюються.

## 6. Перевірки до та після

Крок 9 мав 17 failed assertions (12 fixture + 5 catalog) і smoke preflight failure. Вони виправлені за фактичним контрактом. Початкові запуски Кроку 10 додатково виявили неповні review fixtures і Git timeout/EBUSY під паралельним build/check навантаженням; логи збережено. Після fixture fixes попередній широкий запуск мав 2943 passed / 38 skipped / 0 assertion failures і одну Blocked smoke suite.

| Перевірка | Результат |
|---|---|
| Docker runtime build, API + web | PASS; build-deployed.log |
| Targeted Compose up | PASS, exit 0; deploy-verified.log |
| npm run typecheck | PASS, exit 0; typecheck-complete.log |
| npm run typecheck:tests | PASS, exit 0; typecheck-tests-complete.log |
| npm run audit:code-tools | PASS, 50 tools, manifest v14, checksum 8cc857eeb17be7f185ca5511fee4d7203520eb1098c20c1698d1772dd8722587 |
| Focused runtime regression | 121/121; runtime-after.log |
| Verification fixtures | 98/98; fixture-recheck.log |
| Preview/data/capability subset | 74/74; final-focused.log |
| Final static review safety subset | 49/49; static-final.log |
| Final Security Gate | PASS, 183 suites, 2839 passed / 0 failed / 0 skipped; security-gate-complete.log |
| Broad regression паралельно з build/typecheck | 2939 passed / 5 failed / 38 skipped; 5 Git timeout 10s плюс cleanup EBUSY, smoke Blocked; full-regression-complete.log |
| Broad regression з одним worker | 2944 passed / 38 skipped / 0 failed tests; 197 files passed, 8 skipped, 1 failed suite (live smoke auth Blocked), exit 1; 405.87 s; full-regression-serial.log |

Повна команда: npx vitest run coding-agent sandbox approval git --maxWorkers=1. Timeout та assertions не послаблювалися. Наявні skipIf/live/DB умови не змінювалися. Blocked live smoke дає nonzero exit: повністю зелений загальний suite не заявляється. Security Gate має попередження про placeholder unverified sandbox catalog entries; policy не послаблювалася.

## 7. Обов’язкові E2E Кроку 10

| Сценарій | Live статус | Окрема перевірка |
|---|---|---|
| HTML/CSS/JS creation ×3 | Blocked: auth | Підготовлено real Chat/SSE + browser counter click; не виконано |
| Next.js creation ×3 | Blocked: auth | Наявний Preview HTTP 200 не є creation |
| Large multi-file patch | Blocked: auth | Test-only prompt підготовлено, нового run немає |
| Approval / deny | Blocked: auth | Approval/security regressions |
| Timeout / cancellation | Частково: живий TTL expiry; нові Chat сценарії Blocked | 37 audit expirations, 2 question expirations; lifecycle regressions |
| MCP discovery → permission → approval → consume → execution | Blocked: auth; live cycle не отримано | Source wiring та fail-closed regressions, без реального MCP execution |
| Provider failure | Blocked: live fault не інжектовано | Regression coverage не є live provider fault |
| Malformed/truncated tool call | Blocked: live fault не інжектовано | Existing tool-call regressions |
| Informational routing UA/EN/PT | Blocked: auth | Нових live probes немає |
| Chat → OmniRoute → Sandbox → Preview | Blocked: auth | Окремі health/readiness успішні, повний шлях не підтверджено |

Нових тестових сайтів або scripted implementations не створено; користувацькі сайти не редагувалися. Нових model latency/TTFT/performance вимірів немає. Цифри Кроку 9 не переносяться як before/after цього кроку.

## 8. Блокери та рішення

Потрібно відновити штатний account pairing/test-user session і отримати /auth/me 200, потім завершити всю blocked live матрицю на окремих тестових проєктах. Потрібні реальний MCP сервер та approval consume, deny/cancel/timeout, provider/tool faults і браузерна перевірка Preview restart. Stock smoke також потребує сумісного test-tenant/DB/config.

Runtime-виправлення перевірено regression та живим reaper. Автономність AI у нових runs і відсутність live регресій на всіх сценаріях ще не підтверджено. **Production readiness: НІ.** Production/remote deployment не змінювалися. Комітів не створено; звіт Кроку 9 не переписано.

Локальні gitignored артефакти: artifacts/step10-local/. Не публікувати backup/browser state/config. Значення credentials у звіт не внесено.

