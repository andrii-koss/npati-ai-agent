# NPATI: план закриття незавершених capabilities після чесного аудиту

Оновлено: 2026-09-13. Джерело істини: `packages/shared/src/capability-matrix.ts` після аудиту #1-#306.

## Поточний стан

- `VERIFIED_EXISTING`: 157 пунктів.
- `PARTIALLY_IMPLEMENTED`: 56 пунктів.
- `NOT_IMPLEMENTED`: 93 пунктів.
- Разом незавершених: 149 пунктів.
- Уже `VERIFIED_EXISTING` пункти сюди не включені або позначені як закриті.
- Позначки нижче: `P` — частково реалізовано, `N` — не реалізовано, `V` — верифіковано.
> Повторний аудит 2026-09-13: unit-тест окремого helper або синтетичної відповіді не є production-сертифікацією. `Verified` потребує реального runtime wiring та live Docker E2E там, де capability взаємодіє з мережею, БД, браузером, файлами або зовнішнім провайдером.

## Коли пункт можна чесно змінити на Verified

Capability стає `VERIFIED_EXISTING` тільки коли одночасно виконано все:

1. Є production-код у реальному API/worker/UI шляху, а не окремий демонстраційний клас.
2. Є tenant/user/company scope, auth, allowlist і approval там, де функція читає приватні дані або змінює стан.
3. Стан зберігається у PostgreSQL/Redis/MinIO та переживає restart, якщо функція не є навмисно ephemeral.
4. Помилки, timeout, cancellation, retry, idempotency та cleanup перевірені для відповідного типу функції.
5. Є unit + integration + негативні тести; mock не є доказом доступності зовнішнього провайдера.
6. Є live E2E на production-подібному Docker stack з увімкненим strict auth.
7. Подія видима в Activity/Run Trace, а секрети й PII не потрапляють у logs/audit.
8. Capability Inspector показує фактичний runtime-стан, а не статичну обіцянку.

## Правило проти дублікатів

Не створювати окремий сервіс для кожної назви зі списку. Один production-компонент закриває споріднені ID. Наприклад, один Policy Engine закриває allow/deny, approvals, scopes і sandbox policy; один Retrieval Engine — embeddings, vector/keyword search, rerank та memory injection; один Channel Framework — Telegram, group chat, sender auth і thread binding.

## Порядок реалізації

### P0.1 — Єдиний Security, Policy та Safe Tool Execution [У РОБОТІ — 7/8 VERIFIED, 1 PARTIAL]

**Статус після реалізації:** 7/8 сертифіковано (`#35`, `#38`, `#57`, `#61`, `#62`, `#221`, `#260`). `#60` чесно залишається `PARTIALLY_IMPLEMENTED`, доки OCR/vision engine не розпізнаватиме прихований текст без переданого `ocrText`.
- **#35 `API key auth`**: P → `VERIFIED_EXISTING` — PostgreSQL persistence, SHA-256 lookup hash, AES-GCM encrypted secret, deny-by-default scopes, контроль делегування wildcard, негайна revocation, company/tenant isolation та restart перевірені реальним Docker E2E.
- **#38 `AES-256-GCM at rest`**: P → `VERIFIED_EXISTING` — AES-256-GCM з унікальними salt/IV і authenticated tag; production без явного ключа не стартує, слабкий ключ відхиляється, ротація секретів перевірена integration-тестом, ciphertext і restart — live Docker E2E.
- **#57 `Moderations`**: N → `VERIFIED_EXISTING` — `POST /ai/moderations` викликає справжній OmniRoute `/api/v1/moderations`, повертає provider categories/scores, валідовує batch і працює fail-closed без runtime provider. Unit та live Docker E2E пройдені.
- **#60 `Vision bridge guardrail`**: N → `PARTIALLY_IMPLEMENTED` — реальний parser видаляє JPEG EXIF/APP13/comment та PNG eXIf/tEXt/zTXt/iTXt, перевіряє формат/розміри й блокує prompt injection у `ocrText` та vision output. Потрібен production OCR/vision engine для автоматичного читання прихованого тексту з пікселів.
- **#61 `OIDC dashboard gate`**: N -> `VERIFIED_EXISTING` (`OidcDashboardGate`, endpoint `POST /auth/oidc/login`, валідація issuer/aud/exp).
- **#62 `Scoped remote access tokens`**: N → `VERIFIED_EXISTING` — HMAC token містить tenant/company/user/scopes, має TTL 60–86400 секунд та optional IP allowlist; signature, scope escalation, cross-company access і restart перевірені fail-closed у live Docker.
- **#221 `Device tracking per API key`**: N → `VERIFIED_EXISTING` — кожна успішна API-key автентифікація атомарно оновлює `last_used_at` і durable device telemetry у PostgreSQL; стабільний device ID дедуплікує повторні запити, metadata обмежена за розміром, більше 5 пристроїв дає anomaly, помилка запису працює fail-closed. Tenant/company/key isolation і restart перевірені live Docker E2E.
- **#260 `Tenant-scoped AI model/routing preferences`**: P → `VERIFIED_EXISTING` — прибрано fallback і mirror на `dev-workspace`; PostgreSQL preferences ізольовані за workspace/user та зберігаються після restart. Legacy import працює лише для точного локального `dev-workspace/dev-user` scope.

**Тести та runtime-верифікація:**
- Unit/Integration для #35: `tests/production-p01-security.test.ts`, `tests/api-key-route-authorization.test.ts`, `tests/security-auth-vault-scopes.test.ts`.
- Unit/Integration для #61: `tests/production-p01-security.test.ts` (10/10 passed, включно з RS256/JWKS і tampered-signature).
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Live Docker E2E для #35/#221: `scripts/verify-production-api-key-auth.mjs` — persistence/restart, revocation після restart, scope validation/delegation, encrypted-at-rest перевірка та company/tenant isolation.
- Live Docker E2E для #38/#62/#260: `scripts/verify-production-api-key-auth.mjs` — ciphertext at rest, explicit Docker secrets, tenant/company/IP/scope binding, tamper rejection та persistence після restart.
- Live Docker E2E для #61: `scripts/verify-production-oidc.mjs` (5/5: valid signature, tampered claims, wrong issuer, expired token, `alg=none`). Старий агрегований P0.1 script не є доказом для інших 7 пунктів.
- Live Docker E2E для #57/#60: реальний `/ai/moderations` підтвердив `omni-moderation-latest` і provider scores; `/media/images/understand` підтвердив sanitization та `400 VISUAL_PROMPT_INJECTION`. #60 лишається Partial через відсутність production OCR із пікселів.

### P0.2 — Company Knowledge і довготривала пам'ять агента [#72 І #78 ЧЕСНО ЗАКРИТО]

**Статус після реалізації:** 3 з 6 capabilities сертифіковано; 2 залишаються `PARTIALLY_IMPLEMENTED`, 1 — `NOT_IMPLEMENTED`.

Пункти блоку:
- **#64 `storage.embeddings`**: `VERIFIED_EXISTING` — `POST /ai/embeddings` використовує справжній OmniRoute `/api/v1/embeddings`, перевіряє кількість, finite values та однакову dimensionality, нормалізує вектори для pgvector і працює fail-closed без synthetic production fallback. Live Docker: `openai/text-embedding-3-small`, 1536-d, L2 norm ≈ 1.0.
- **#65 `ai.rerank`**: `PARTIALLY_IMPLEMENTED` — production `POST /ai/rerank` викликає лише справжній OmniRoute rerank adapter, валідовує `topN`/`minScore` і працює fail-closed. Live catalog не має активної rerank-моделі, тому повертається явний `503 RERANK_UNAVAILABLE`; локальний lexical heuristic більше не видається за cross-encoder.
- **#72 `system.context_compaction`**: `VERIFIED_EXISTING` — model-backed hierarchical compaction підключено до production neutral і business chat. Старі репліки стискає реальна вибрана модель, останні 6 реплік лишаються без змін; при помилці summarizer повна історія зберігається без втрат. Результат містить `contextCompaction` telemetry.
- **#78 `storage.automatic_memory_extraction`**: `VERIFIED_EXISTING` — після company chat JSON і SSE сервер очікує завершення extraction та PostgreSQL persistence перед фінальною відповіддю. Зберігаються лише явні факти користувача з confidence/provenance metadata, працюють deduplication, audit trail та суворий `noMemory`; відповіді моделі не можуть стати пам’яттю.
- **#80 `storage.memory_rerank`**: `NOT_IMPLEMENTED` — наявний `MemoryRerankEngine` і endpoint виконують лише детерміноване temporal/lexical сортування кандидатів. Це корисний diagnostic scaffold, але не повноцінний semantic/model rerank; тому пункт не сертифіковано.
- **#302 `storage.omniroute_rerank_integration`**: `PARTIALLY_IMPLEMENTED` — один adapter path підключений до API та Company Knowledge. За відсутності live rerank-моделі Company Knowledge чесно лишається на PostgreSQL hybrid ordering без synthetic rerank score.

**Тести та runtime-верифікація:**
- Unit/Integration: `tests/production-p02-knowledge-memory.test.ts` (14/14 passed).
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 entries; 157 `VERIFIED_EXISTING`, 56 `PARTIALLY_IMPLEMENTED`, 93 `NOT_IMPLEMENTED`).
- Live Docker E2E: `scripts/verify-production-p02-knowledge-memory.mjs` перевіряє real OmniRoute embeddings, чесний rerank fail-closed, model-backed compaction усередині `/chat`, awaited automatic memory у JSON/SSE, `noMemory`, PostgreSQL persistence та очищення ізольованих test data.

### P0.3 — Runtime reliability, streaming, observability і scale [#22 І #23 ЧЕСНО ЗАКРИТО]

**Пункти:**
- **#22 `system.adaptive_admission_queue`**: `VERIFIED_EXISTING` — production admission queue реально обгортає спільний `AIEngine`: `/chat`, `/chat/stream`, `/api/chat`, `/api/generate` та Company Agent. Є глобальна й per-tenant паралельність, пріоритети (`critical-orchestration`, `enterprise`, `pro`, `free`), queue timeout, cancellation, bounded queue, free-tier shedding і HTTP 429 з `Retry-After`. Рівень визначається сервером з auth scope, а не недовіреним заголовком клієнта. Захищена телеметрія: `GET /runtime/admission`; `/queue/status` залишено як сумісний alias.
- **#23 `system.self-healing_auto-combo`**: `VERIFIED_EXISTING` — реальний production `AIEngine` виконує primary → configured fallback/`auto` для retryable 404/408/409/429/5xx, quota, timeout і network failures, не приховуючи 401/403. Для non-stream і stream fallback не дублює вже виданий текст; cancellation передається провайдеру. Результат містить `routingStrategy: "self-healing-fallback"` і `failoverCount`; конфігурація fallback ізольована між tenant і зберігається після restart.
- **#44 `system.isolated_group_sessions`**: `PARTIALLY_IMPLEMENTED` — є CRUD і persistence сесій, але немає реального group-agent виконання у chat orchestration.
- **#46 `system.session_tools`**: `PARTIALLY_IMPLEMENTED` — є registry API, але session tools не застосовуються у фактичному tool execution.
- **#124 `system.evaluation_framework`**: `PARTIALLY_IMPLEMENTED` — evaluation helper працює, але немає production E2E на реальних agent runs і persisted evaluation results.
- **#176 `system.semantic_cache`**: `PARTIALLY_IMPLEMENTED` — є process-local semantic cache API, але він не підключений до production AI inference path.
- **#189 `system.atomic_rpm_rolling_leases`**: `PARTIALLY_IMPLEMENTED` — лізи атомарні лише в одному Node process, без Redis/PostgreSQL і без provider routing integration.
- **#190 `security.quota-share_routing`**: `PARTIALLY_IMPLEMENTED` — decision endpoint існує, але quota-share не керує production AI router.
- **#197 `system.compression_presets`**: `PARTIALLY_IMPLEMENTED` — compression helper працює окремо, але не вбудований у реальний chat context pipeline.
- **#198 `system.adaptive_context_budget`**: `PARTIALLY_IMPLEMENTED` — budget evaluator є окремим endpoint, але не керує production context assembly.
- **#199 `system.per-request_compression_override`**: `PARTIALLY_IMPLEMENTED` — override resolver існує, але заголовок не застосовується у production chat requests.
- **#200 `system.output_styles`**: `PARTIALLY_IMPLEMENTED` — style helper існує, але вибраний стиль не застосовується до реальної відповіді агента.
- **#201 `system.compression_eval_harness`**: `PARTIALLY_IMPLEMENTED` — метрики compression helper обчислюються, але немає production corpus, regression dataset і Docker quality gate.
- **#202 `system.cache_stats_flush`**: `PARTIALLY_IMPLEMENTED` — stats та flush охоплюють demo process-local caches, а не реальний provider/agent cache.
- **#205 `browser.database_backups`**: `NOT_IMPLEMENTED` — snapshot створюється з переданого simulatedContent і не є backup PostgreSQL.
- **#207 `research.session_search`**: `PARTIALLY_IMPLEMENTED` — є ручний in-memory index API, але chat sessions автоматично не індексуються.
- **#208 `system.session_pruning`**: `PARTIALLY_IMPLEMENTED` — prune обробляє переданий масив, а не видаляє persisted sessions за retention policy.

**Тести та runtime-верифікація:**
- Unit/Integration для #22/#23: `tests/production-admission-self-healing.test.ts` (5/5 passed: capacity, priority, timeout/cancel, 503 fallback, no fallback on 401, streaming safety) та повязані P0.3 regression suites.
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 entries; 153 `VERIFIED_EXISTING`, 57 `PARTIALLY_IMPLEMENTED`, 96 `NOT_IMPLEMENTED`).
- Live Docker E2E для #22/#23: `scripts/verify-production-admission-self-healing.mjs` — auth guard, реальний primary HTTP 503 → fallback, `failoverCount=1`, bounded burst з HTTP 429, runtime metrics, tenant isolation і повторна перевірка після restart (усі перевірки passed).

### P1.1 — Browser automation [ПОВЕРНУТО В РОБОТУ — production browser не реалізовано]

Пункти:
- **#149 `browser.managed_browser_profile`**: `PARTIALLY_IMPLEMENTED` — є in-memory registry профілів, але профіль не запускає ізольований браузер.
- **#150 `browser.browser_tab_control`**: `PARTIALLY_IMPLEMENTED` — є in-memory модель вкладок, але немає керування Chrome/CDP.
- **#151 `browser.browser_clicktype`**: `PARTIALLY_IMPLEMENTED` — policy guard працює, але click/type не виконується у DOM браузера.
- **#152 `browser.browser_dragselect`**: `PARTIALLY_IMPLEMENTED` — policy guard працює, але drag/select не виконується у браузері.
- **#153 `browser.browser_snapshots`**: `PARTIALLY_IMPLEMENTED` — парситься переданий HTML, а не snapshot живої browser page.
- **#154 `browser.browser_screenshots`**: `NOT_IMPLEMENTED` — повертається base64 службового рядка, а не PNG/JPEG screenshot.
- **#155 `browser.browser_pdf_capture`**: `NOT_IMPLEMENTED` — повертається текстовий placeholder, а не валідний browser-rendered PDF.
- **#156 `browser.browser_downloads`**: `PARTIALLY_IMPLEMENTED` — ведеться лише metadata download, файл реально не завантажується.
- **#157 `browser.multi-profile_browser`**: `PARTIALLY_IMPLEMENTED` — ведеться metadata instance, реальний browser process не запускається.
- **#158 `browser.attach_real_chrome`**: `NOT_IMPLEMENTED` — CDP session і browser version вигадуються, WebSocket connection не створюється.

**Блок P1.1 не завершено:** наявні API-каркаси та guardrails, але немає реального Playwright/CDP browser runtime.

**Безпекові механізми (Security Guardrails):**
- **SSRF Guard**: `BrowserSecurityGuard.validateUrl()` блокує хмарні метадані (`169.254.169.254`), приватні підмережі (RFC 1918), loopback адреси, внутрішні сервіси Docker (`postgres`, `redis`, `omniroute`, `minio`, `npati-agent-api`) та небезпечні схеми (`file://`, `data://`, `javascript://`). Для CDP дозволено лише localhost при явному дозволі, хмарні метадані блокуються безумовно.
- **Download Quarantine**: блокування завантаження виконуваних та потенційно шкідливих файлів із поверненням статусу `quarantined` та HTTP 403 `DOWNLOAD_QUARANTINED`.
- **Destructive Action Risk Guard**: `BrowserSecurityGuard.checkActionRisk()` вимагає явного `approved: true` для дій із селекторами видалення, оплати або скидання налаштувань у кліках, введенні, drag-and-drop та виборі опцій.

**Аудит #149-#158:**
- Наявні старі unit-тести перевіряють лише API-каркаси та guardrails. Реального Playwright/CDP production E2E немає; вони не є доказом `Verified`.
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 entries; 153 `VERIFIED_EXISTING`, 57 `PARTIALLY_IMPLEMENTED`, 96 `NOT_IMPLEMENTED`).

### P1.2 — Multimodal Tools [ПОВЕРНУТО В РОБОТУ — synthetic adapters не сертифіковані]

Пункти:
- **#58 `system.image_generation`**: `PARTIALLY_IMPLEMENTED` — є API-каркас і валідація, але provider не підключений, типовий результат є вигаданим URL.
- **#59 `system.ocr`**: `NOT_IMPLEMENTED` — код читає буфер як UTF-8 текст і не виконує OCR пікселів зображення.
- **#141 `communications.image_understanding`**: `NOT_IMPLEMENTED` — аналіз і detected objects жорстко задані та не залежать від зображення.
- **#142 `files.document_inputoutput`**: `PARTIALLY_IMPLEMENTED` — text, CSV і JSON працюють, але PDF/DOCX лише декодуються як UTF-8 без справжнього parser.
- **#143 `system.modality_bridge`**: `PARTIALLY_IMPLEMENTED` — bridge-каркас є, але він залежить від нереалізованих OCR та multimodal provider adapters.
- **#145 `communications.image_generationediting`**: `NOT_IMPLEMENTED` — редагування не створює файл, а повертає вигаданий storage URL.
- **#147 `communications.audio_translation`**: `NOT_IMPLEMENTED` — переклад є фіксованим текстом без STT або translation provider.
- **#148 `communications.video_understanding`**: `NOT_IMPLEMENTED` — сцени та відповідь жорстко задані, відео не завантажується і не аналізується.
- **#235 `system.video_generation`**: `PARTIALLY_IMPLEMENTED` — є job lifecycle, але video provider не викликається і повертається вигаданий CDN URL.
- **#246 `communications.video_generation`**: `PARTIALLY_IMPLEMENTED` — використовує той самий незавершений video job scaffold без media artifact.
- **#247 `communications.music_generation`**: `NOT_IMPLEMENTED` — audio не генерується, повертається вигаданий CDN URL.
- **#248 `communications.talk_realtime_speech`**: `NOT_IMPLEMENTED` — обробляється simulatedUserSpeech і числовий розмір аудіо без realtime audio transport/provider.
- **#249 `communications.voice_call`**: `NOT_IMPLEMENTED` — створюється лише in-memory call record, SIP/Twilio дзвінок не виконується.
- **#254 `communications.mobile_voice`**: `PARTIALLY_IMPLEMENTED` — audio frames лише рахуються in-memory, немає mobile transport, STT/TTS або codec pipeline.

**Провайдерна валідація та помилки:**
- Ендпоінт `GET /media/providers` повертає каталог доступних генераторів та рушіїв.
- Непідтримувані провайдери повертають явні статус-коди 400 (`UNSUPPORTED_PROVIDER`, `UNSUPPORTED_VIDEO_ENGINE`, `UNSUPPORTED_OPERATION`) без використання фіктивних synthetic results.
- Вхідні промпти підлягають автоматичній модерації через `ContentModerationEngine` із блокуванням prompt injection і шкідливого контенту (код `CONTENT_MODERATION_FLAGGED`).

**Аудит блоку P1.2:**
- Старі unit-тести перевіряють validation і synthetic adapters. До підключення реальних media providers та перевірки артефактів це не production certification.
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 entries; 153 `VERIFIED_EXISTING`, 57 `PARTIALLY_IMPLEMENTED`, 96 `NOT_IMPLEMENTED`).

### P1.3 — Automations, triggers і durable tasks [ПОВЕРНУТО В РОБОТУ]

Пункти:
- **#128 `system.webhooks`**: `PARTIALLY_IMPLEMENTED` — `IntegrationsRepository` та `registerIntegrationsRoutes` для реєстрації вебхуків компанії із захистом `PromptInjectionGuard`, генерацією секретів і прив'язкою до агентів. Ендпоінти: `GET /companies/:companyId/webhooks`, `POST /companies/:companyId/webhooks`, `DELETE /companies/:companyId/webhooks/:webhookId`.
- **#129 `system.automations_scheduler`**: `NOT_IMPLEMENTED` — `AutomationScheduler` та `CompanyAutomationsRepository` для планування автоматизацій, перевірки розкладу, взяття завдань в обробку (`claimDueAutomations`) та оновлення `nextRunAt`. Ендпоінти: `GET /companies/:companyId/automations`, `POST /companies/:companyId/automations`, `PATCH /companies/:companyId/automations/:automationId`.
- **#130 `system.cron_jobs`**: `PARTIALLY_IMPLEMENTED` — валідація стандартних 5-позиційних Cron-виразів (`isValidCronExpression`), обчислення наступної дати виконання (`computeNextCronDate`) з урахуванням таймзони та автоматичний розрахунок черги.
- **#131 `system.background_tasks_ledger`**: `PARTIALLY_IMPLEMENTED` — стійкий леджер запусків фонових завдань (`company_automation_runs`) з фіксацією станів (`pending`, `running`, `completed`, `failed`), тривалості у мілісекундах (`durationMs`) та результату виконання. Ендпоінти: `POST /companies/:companyId/automations/:automationId/run`, `GET /companies/:companyId/automations/:automationId/runs`.
- **#133 `system.task_flow`**: `PARTIALLY_IMPLEMENTED` — `TaskFlowEngine` для декларативного опису та виконання багатоетапних конвеєрів завдань з кроками дії (`action`), умовами розгалуження (`condition`), збереженням контексту та аудитом шляху виконання (`executionPath`). Ендпоінти: `POST /companies/:companyId/flows`, `POST /companies/:companyId/flows/:flowId/run`.
- **#134 `system.standing_orders`**: `NOT_IMPLEMENTED` — `StandingOrdersManager` для реєстрації та виконання постійних регламентних наказів компанії (standing orders) із перевіркою порогових умов (наприклад, баланс, бюджет, статус) при надходженні бізнес-подій. Ендпоінти: `POST /companies/:companyId/standing-orders`, `POST /companies/:companyId/standing-orders/evaluate`.
- **#135 `system.webhooks_ingress`**: `PARTIALLY_IMPLEMENTED` — публічний безпечний інгрес вхідних вебхуків (`/api/v1/webhooks/:secret`) із валідацією секрету, маскуванням конфіденційних даних (`CredentialMasker`), перевіркою ін'єкцій (`PromptInjectionGuard`) та автоматичною передачею в обробку агенту компанії (`triggerRun`).
- **#136 `communications.imap_email_trigger`**: `NOT_IMPLEMENTED` — `ImapEmailTrigger` для парсингу вхідних листів, санітизації вмісту, вилучення метаданих відправника і теми та конвертації електронного листа в структуроване завдання для агента (`taskPrompt`). Ендпоінт: `POST /companies/:companyId/inbound-email`.
- **#137 `system.webhook_retries`**: `NOT_IMPLEMENTED` — `WebhookRetryDeliveryEngine` з експоненційним бекоффом при невдалих спробах відправки вебхука, ізоляцією помилок та автоматичним переміщенням вичерпаних повідомлень у чергу Dead Letter Queue (DLQ) із можливістю повторного відтворення. Ендпоінти: `POST /companies/:companyId/webhooks/dispatch`, `POST /companies/:companyId/webhooks/dlq/:dlqId/replay`.
- **#138 `system.one-shot_reminders`**: `NOT_IMPLEMENTED` — `OneShotReminderService` для планування разових нагадувань на конкретний час (`targetAt`), перевірки черги настання нагадувань (`checkDueReminders`) та скасування завдань. Ендпоінти: `POST /companies/:companyId/reminders`, `GET /companies/:companyId/reminders/due`, `DELETE /companies/:companyId/reminders/:reminderId`.
- **#140 `system.lifecycle_hooks`**: `NOT_IMPLEMENTED` — `AgentLifecycleHookManager` для реєстрації пріоритетних хуків життєвого циклу агента (`before_agent_run`, `after_agent_run`, `on_agent_error`, `on_context_compact`, `before_tool_call`, `after_tool_call`) та синхронного/асинхронного сповіщення. Ендпоінти: `POST /companies/:companyId/lifecycle-hooks`, `POST /companies/:companyId/lifecycle-hooks/emit`.

**Тести та runtime-верифікація:**
- Unit/Integration: `tests/production-p13-automations.test.ts` (12/12 passed).
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 entries; 153 `VERIFIED_EXISTING`, 57 `PARTIALLY_IMPLEMENTED`, 96 `NOT_IMPLEMENTED`).
- Live Docker E2E: `scripts/verify-production-p13-automations.mjs` (12/12 live checks passed на реальному Docker API: auth guards, webhooks registration & public ingress, automations scheduler & cron jobs, background ledger, task flow multi-step execution, standing orders evaluation, IMAP inbound email conversion, webhook retries & DLQ replay, one-shot reminders scheduling/due queue, lifecycle hooks priority emission, capability inspect).

### P1.4 — Multi-agent, MCP та A2A control plane [ПОВЕРНУТО В РОБОТУ]

Пункти:
- **#94 `orchestration.cost-optimized`**: `NOT_IMPLEMENTED` — стратегія вибору найдешевшої моделі на основі обсягу промпта та очікуваного виходу з точним розрахунком економії у відсотках. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#95 `orchestration.context-optimized`**: `NOT_IMPLEMENTED` — динамічна маршрутизація за розміром контекстного вікна (1M для масивних промптів >100k токенів, 200k для середніх, compact/fast для коротких запитів). Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#96 `orchestration.cache-optimized`**: `NOT_IMPLEMENTED` — маршрутизація з урахуванням кешування промптів (prompt caching discounts), активація `cacheControlEnabled` та розрахунок економії витрат. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#97 `orchestration.lkgp`**: `NOT_IMPLEMENTED` — `LkgpStrategyManager` для швидкого шляху (fast-path) до останнього перевіреного стабільного провайдера (Last Known Good Provider), фіксація успіхів та автоматичний фолбек при 2+ послідовних збоях. Ендпоінти: `POST /orchestration/lkgp/record`, `GET /orchestration/lkgp/resolve`.
- **#103 `orchestration.a2a_protocol_v03`**: `PARTIALLY_IMPLEMENTED` — стандартний протокол A2A v0.3: валідація версії `0.3`, перевірка обов'язкових полів endpoints (`agentId`, `companyId`), формування correlationId/traceId та зворотних конвертів `task_result`. Ендпоінти: `POST /a2a/envelope/create`, `POST /a2a/envelope/validate`, `POST /a2a/envelope/response`.
- **#104 `orchestration.a2a_smart_routing`**: `PARTIALLY_IMPLEMENTED` — `A2ASmartRouter` для вибору оптимального агента за відповідністю спеціалізації (`coding`, `research`, `math`, `writing`, `qa`, `general`), поточним навантаженням та затримкою. Ендпоінти: `POST /a2a/router/register`, `POST /a2a/router/route`.
- **#105 `orchestration.a2a_health_report`**: `NOT_IMPLEMENTED` — `A2AHealthRegistry` для агрегації хартбітів агентів (CPU, пам'ять, помилки), детекції деградації (>85% CPU або >10% error rate) та офлайн-таймаутів (>30 с). Ендпоінти: `POST /a2a/health/heartbeat`, `GET /a2a/health/report`.
- **#106 `system.omniconductor`**: `NOT_IMPLEMENTED` — `OmniConductor` для виконання складних багатоагентних DAG-конвеєрів із паралельним запуском незалежних вузлів, автоматичним виявленням циклів/дедлоків (`OMNICONDUCTOR_DAG_DEADLOCK`) та агрегацією результатів. Ендпоінт: `POST /a2a/conductor/execute`.
- **#112 `system.isolated_vs_forked_context`**: `NOT_IMPLEMENTED` — `ContextLifecycleManager` для створення ізольованих пісочниць без витоку пам'яті батьківського агента та форкованих контекстів із копіюванням при записі (copy-on-write), локальними мутаціями та явним злиттям (`mergeContext`). Ендпоінти: `POST /orchestration/context/isolated`, `POST /orchestration/context/fork`, `POST /orchestration/context/mutate`, `POST /orchestration/context/merge`, `GET /orchestration/context/:contextId`.
- **#113 `system.agent_send_session_messaging`**: `NOT_IMPLEMENTED` — `MultiAgentMessageBus` для прямої передачі повідомлень між агентами, персональних інбоксів, підтвердження доставки (delivery ack), широкомовного розсилання сесії (session broadcast) та історії. Ендпоінти: `POST /orchestration/messages/send`, `POST /orchestration/messages/broadcast`, `GET /orchestration/messages/inbox/:agentId`, `POST /orchestration/messages/mark-delivered`, `GET /orchestration/messages/history/:sessionId`.
- **#120 `security.a2a_quota_management`**: `NOT_IMPLEMENTED` — `A2AQuotaManager` для встановлення та контролю лімітів токенів, фінансового бюджету та глибини рекурсії делегування sub-agents. Ендпоінти: `POST /a2a/quota/budget`, `POST /a2a/quota/check`, `POST /a2a/quota/record`.
- **#121 `orchestration.a2a_provider_discovery`**: `NOT_IMPLEMENTED` — `A2AProviderDiscovery` для реєстрації профілів агентів та пошуку колег за ключовими навичками з фільтрацією за `minHealth` і ранжуванням за затримкою. Ендпоінти: `POST /a2a/discovery/register`, `GET /a2a/discovery`.
- **#122 `orchestration.a2a_cost_analysis`**: `NOT_IMPLEMENTED` — `A2ACostAnalyzer` для фіксації делегованих викликів і підсумкового розрахунку дерева витрат (сумарні токени, вартість у USD, деталізація по кожному агенту). Ендпоінти: `POST /a2a/costs/record`, `GET /a2a/costs/analyze/:traceId`.
- **#123 `orchestration.a2a_list_capabilities`**: `NOT_IMPLEMENTED` — каталог доступних A2A та orchestration можливостей платформи. Ендпоінт: `GET /a2a/capabilities`.
- **#125 `system.nested_sub-agents`**: `NOT_IMPLEMENTED` — `NestedSubagentManager` для безпечної ієрархії вкладених субагентів з обмеженням глибини (`maxDepth`), захистом від рекурсивних циклів (`RECURSIVE_CYCLE_DETECTED`), контролем ескалації привілеїв інструментів (`SubagentToolPolicyGuard`) та автоматичним поширенням скасування (cancellation propagation) по всьому піддереву. Ендпоінти: `POST /orchestration/subagents/spawn`, `POST /orchestration/subagents/:agentId/cancel`, `GET /orchestration/subagents/:agentId/tree`.
- **#127 `system.swarm`**: `NOT_IMPLEMENTED` — `SwarmOrchestrator` для клієнтських мультиагентних процедур з динамічною передачею керування (handoffs) на основі намірів запиту. Ендпоінти: `POST /orchestration/swarm/register`, `POST /orchestration/swarm/turn`.
- **#177 `orchestration.priority`**: `NOT_IMPLEMENTED` — маршрутизація за списком пріоритетів із прозорим фолбеком на резервні провайдери. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#178 `orchestration.fill-first`**: `NOT_IMPLEMENTED` — маршрутизація до 90% насичення первинного провайдера з переливанням надлишку на наступний. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#179 `orchestration.weighted`**: `NOT_IMPLEMENTED` — ймовірнісний розподіл трафіку відповідно до заданих вагових коефіцієнтів. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#180 `orchestration.round-robin`**: `NOT_IMPLEMENTED` — циклічний рівномірний розподіл запитів між доступними провайдерами. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#181 `orchestration.p2c`**: `NOT_IMPLEMENTED` — алгоритм Power of Two Random Choices із вибором кращого кандидата за активними запитами та затримкою. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#182 `orchestration.least-used`**: `NOT_IMPLEMENTED` — маршрутизація до кандидата з мінімальним числом активних з'єднань. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#183 `browser.random`**: `NOT_IMPLEMENTED` — рівномірний псевдовипадковий вибір серед здорових провайдерів. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#184 `browser.strict-random`**: `NOT_IMPLEMENTED` — криптографічно стійкий вибір через CSPRNG без систематичного зсуву. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#185 `orchestration.headroom`**: `NOT_IMPLEMENTED` — маршрутизація до провайдера з найбільшим запасом пропускної здатності (headroom buffer). Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#186 `orchestration.reset-window`**: `NOT_IMPLEMENTED` — пріоритет провайдерам, чиє вікно рейт-ліміту скинулося або скинеться найшвидше. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#187 `orchestration.reset-aware`**: `NOT_IMPLEMENTED` — маршрутизація на основі експоненційної кривої відновлення лімітів після скидання. Ендпоінт: `POST /orchestration/resolve-strategy`.
- **#188 `orchestration.context-relay`**: `NOT_IMPLEMENTED` — міжпровайдерна естафета сесій із підбором моделі з контекстним вікном, здатним увібрати накопичену історію діалогу. Ендпоінт: `POST /orchestration/resolve-strategy`.

**Архітектурні інваріанти та безпека:**
- Єдиний Orchestration Strategy Registry (`RoutingStrategiesManager` / `RoutingStrategyEngine`) та Fastify router (`registerA2AControlPlaneRoutes`) без дублювання базових Auto/Pipeline/Fusion роутерів.
- Непідтримувані стратегії та невалідні конверти відхиляються з явним статусом 400 (`INVALID_ROUTING_STRATEGY`, `INVALID_A2A_ENVELOPE`).
- Перевищення квоти, перевищення ліміту глибини рекурсії та цикли делегування негайно блокуються з кодами `A2A_QUOTA_EXCEEDED`, `NESTED_SUBAGENT_DEPTH_EXCEEDED`, `RECURSIVE_CYCLE_DETECTED`.

**Тести та runtime-верифікація:**
- Unit/Integration: `tests/production-p14-orchestration-a2a.test.ts` (28/28 passed).
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 entries; 153 `VERIFIED_EXISTING`, 57 `PARTIALLY_IMPLEMENTED`, 96 `NOT_IMPLEMENTED`).
- Revalidation Audit: `node scripts/revalidate-306-capabilities.mjs` (306/306 verified).
- Upgrade Gate: `node scripts/upgrade-gate.mjs` (5/5 checks green).
- Live Docker E2E: `scripts/verify-production-p14-orchestration-a2a.mjs` (18/18 live checks passed на реальному Docker API: auth guards, 16-strategy catalog, strategy resolution, invalid strategy rejection, LKGP record/resolve, A2A v0.3 envelope create/validate/response, smart routing, health registry/report, OmniConductor DAG workflow execution, quota management & limit enforcement, provider discovery, cost analysis tree rollup, list capabilities, agent send & inbox delivery ack, context isolation & copy-on-write fork & explicit merge, nested sub-agents with depth/cycle protection & cancellation propagation, swarm routines with dynamic intent handoff).

### P2.1 — Coding agents, ACP і local/cloud harnesses

Пункти: #161 `Tool Search` (P), #162 `File tools` (P), #163 `Coding CLI gateway` (N), #164 `omniroute run` (N), #165 `Cloud-agent providers` (P), #167 `Native Codex runtime` (N), #168 `ACP sessions` (N), #169 `Claude Code via ACP` (N), #170 `omniroute configure` (P), #171 `Cursor via ACP` (N), #172 `GitHub Copilot via ACP` (N), #173 `Gemini CLI via ACP` (N), #174 `OpenCode via ACP` (N), #175 `Other ACP harnesses` (N), #236 `Remote CLI contexts` (N).

Що реалізувати: один ACP Session Manager і adapter contract для harnesses; process sandbox, workspace mount policy, streaming stdout/stderr, approvals, cancellation, session resume, credential broker і capability probing. Кожен CLI — тонкий adapter, не новий orchestration engine.

Verified gate: real installed CLI smoke/E2E per adapter, missing CLI/auth failure, concurrent isolated workspaces, cancel/kill tree, no host secret leakage та audited file/process changes.

### P2.2 — Channels і plugin framework

Пункти: #50 `DM allowlists & pairing` (P), #55 `Channel sender authorization` (N), #117 `MCP client registry` (P), #223 `Plugins` (P), #225 `Channel docking / thread binding` (N), #226 `Plugin hooks` (P), #227 `Internal hooks` (N), #228 `Telegram` (N), #229 `X search` (N), #230 `Official channel plugins` (N), #231 `External channel plugins` (N), #232 `Group chat` (N), #233 `Mention activation` (N).

Що реалізувати: signed plugin manifest/permissions, install-enable-disable-upgrade lifecycle, scoped MCP registry, normalized inbound/outbound Channel Adapter, sender allowlist/pairing, thread binding, group mention policy, webhook verification та secret vault.

Verified gate: Telegram real bot E2E, spoofed sender/replay negatives, group mention behavior, thread resume after restart, plugin permission denial, version migration/rollback. X search залишається provider adapter у цьому framework.

### P2.3 — Routing, compression і response optimization

Пункти: #194 `Relevance` (N), #195 `Aggressive` (N), #196 `LLMLingua-2` (N), #212 `CCR` (N), #213 `Lite` (N), #214 `Responses Tool Output` (N), #215 `Headroom` (N), #217 `Ultra` (N), #218 `OmniGlyph` (N).

Що реалізувати: один versioned Compression/Response Pipeline з presets, token accounting, tool-output preservation, adaptive headroom та provider/model compatibility. Алгоритми, яких немає у runtime, не позначати реалізованими через однаково названий config.

Verified gate: golden semantic-preservation corpus, tool JSON round-trip, multilingual/code/table cases, latency/cost/quality comparison, per-request override та safe fallback без втрати інструкцій.

### P2.4 — Infrastructure, deployment і model extensions

Пункти: #209 `Custom/self-hosted models` (P), #222 `Version manager` (N), #234 `OmniRoute Radar` (P), #237 `MITM / TPROXY` (P), #238 `Proxy system` (P), #239 `Embedded Bifrost & Mux` (P), #240 `Relay deployers` (P), #241 `Docker / Podman / Bun / Nix` (P), #245 `ClawHub` (N).

Що реалізувати: health-checked adapter/deployer registry, explicit install state, signed versions, upgrade/rollback, proxy lifecycle, custom endpoint validation, secrets isolation та capability discovery. MITM/TPROXY має бути opt-in і заборонений без admin approval.

Verified gate: чисте встановлення кожного заявленого runtime, restart/upgrade/rollback, network failure, port conflict, invalid image/signature та uninstall cleanup. Не вважати наявність vendor-коду production wiring.

### P3.1 — Advanced memory features

Пункти: #73 `USER.md user model` (V), #74 `MEMORY.md long-term memory` (V), #77 `Automatic memory flush` (V), #79 `FTS5 keyword search` (N), #81 `Typed decay` (V), #83 `Daily memory notes` (V), #85 `Standing intents` (V), #86 `Memory Wiki` (V), #87 `Dreaming` (V), #88 `Action-sensitive memory` (V), #219 `Qdrant support` (V), #220 `int8 vector quantization` (N), #242 `Multiple memory engines` (P), #243 `Memory import` (P).

Виконано 2026-09-14: #77, #81, #83 і #85 переведено у Verified після unit/integration перевірок та production Docker E2E (scripts/verify-production-durable-memory-features.mjs): реальний chat compaction записує факти в PostgreSQL з дедуплікацією; typed decay metadata проходить production API і retrieval; daily notes мають idempotency; standing intents мають keyword matching та optimistic revision; усі дані переживають restart і ізольовані між tenant. #79 лишається Not implemented: Node SQLite у фактичному runtime повертає "no such module: fts5", а PostgreSQL FTS не перейменовується на FTS5.

Закрито 2026-09-14: #86, #87, #88 і #219 пройшли production Docker E2E (`scripts/verify-production-advanced-memory.mjs`). Wiki має PostgreSQL CRUD, backlinks, revision control, tenant isolation та agent retrieval; Dreaming створює idempotent durable cycle і консолідовану wiki-сторінку; action rules мають CRUD/revisions та інжектуються до delegation planning і planned-tool retrieval; optional Qdrant працює як реальний контейнер із tenant filters, restart persistence і delete cleanup. Qdrant-only retrieval доведено після контрольованого видалення тестових pgvector chunks.

Що реалізувати: стабільний MemoryProvider contract; PostgreSQL залишається default, Qdrant — optional adapter; import із dry-run/dedup/provenance; typed TTL/decay; daily notes; standing intents; user model; action-sensitive write policy. FTS5 потрібен лише SQLite adapter і не повинен дублювати PostgreSQL FTS.

Verified gate: однаковий conformance suite для кожного engine, migration/import rollback, deterministic decay clock, privacy deletion, no-memory enforcement, vector quantization quality threshold і restart consistency.

Закрито 2026-09-13:
- **#73 `USER.md user model`**: `VERIFIED_EXISTING` — revisioned USER.md зберігається у PostgreSQL-backed user settings, ізольований за workspace/user, інжектується у neutral, Business і Company chat та повністю вимикається через `noMemory`.
- **#74 `MEMORY.md long-term memory`**: `VERIFIED_EXISTING` — revisioned MEMORY.md зберігається у чинному `companies.memory`, захищений company/tenant scope, інжектується в Company Agent і видаляється разом із компанією.
- Unit/Integration: `tests/production-memory-documents.test.ts`. Live Docker E2E: `scripts/verify-production-memory-documents.mjs` — PostgreSQL uniqueness, optimistic concurrency, cross-tenant denial, API restart, реальний neutral/company inference, `noMemory` та cleanup.

### P3.2 — Mobile та desktop companions

Пункти: #250 `macOS companion` (N), #251 `iOS node pairing` (N), #252 `Android node pairing` (N), #253 `Mobile chat` (P), #255 `Camera access` (N), #256 `Screen recording` (N), #257 `Location access` (N), #258 `Device commands` (N), #259 `Linux companion / inline media` (P).

Що реалізувати: versioned Device Node protocol, QR/pairing із short-lived keys, revocation, foreground/background lifecycle, explicit OS permission prompts, encrypted transport, offline queue та device command allowlist. Web responsive UI не є mobile companion.

Verified gate: реальні iOS/Android/macOS/Linux builds, pair/revoke/re-pair, denied OS permissions, background reconnect, camera/location/screen consent, lost-device token revocation і cross-user isolation.

## Рекомендований порядок релізів

1. Release A: P0.1 Security + P0.2 Knowledge/Memory.
2. Release B: P0.3 Reliability/Streaming/Observability/Scale.
3. Release C: P1.1 Browser + P1.3 Automations.
4. Release D: P1.2 Multimodal + P1.4 Multi-agent/A2A.
5. Release E: P2.1 Coding/ACP + P2.2 Channels/Plugins.
6. Release F: P2.3 Optimization + P2.4 Infrastructure.
7. Release G: P3.1 Advanced Memory + P3.2 Companions.

## Наступні 10 конкретних задач

1. Підключити й live-перевірити rerank provider; закрити #65 і #302 одним adapter path.
2. ✅ Завершено: #67-#69 production memory scope/injection та #82 per-request no-memory.
3. 🟡 Частково: #70, #71, #75 і #76 завершено одним PostgreSQL hybrid retrieval; #80 очікує live rerank provider.
4. ✅ Завершено: централізовані redaction/guardrails #31-#34.
5. ✅ Завершено: deny-by-default MCP/tool policy #40, #48, #102, route tiers #39, durable human approvals #54 та Exec approvals #49.
6. ✅ Завершено: один production-шлях Code Mode / isolated Exec закриває #47, #53, #63, #159, #160 і #244 без дублювання runtime.
7. ✅ Завершено: SSE streaming/cancellation/response chunking #42 і #224.
8. ✅ Завершено: Org Chart pagination >100 — #286.
9. ✅ Завершено: unified cost/usage/audit trace #25, #27, #29, #191, #203 та durable background audit/completion reporting #56, #114.
10. ✅ Завершено: distributed authenticated 10k session certification, Redis session dedup і cleanup — #192 та #290.

## Журнал попередніх змін (не є доказом поточного статусу)

- 2026-09-13 — **Відкликання хибної P1.1 browser-сертифікації:** повторний аудит довів, що endpoints керують in-memory metadata та synthetic payloads, а не реальним Playwright/CDP браузером. #149-#153 і #156-#157 повернено в `PARTIALLY_IMPLEMENTED`; #154, #155 і #158 — у `NOT_IMPLEMENTED`. Старі unit/E2E сценарії не є доказом production browser runtime.

- 2026-09-11 — #192 `Session-Dedup`, #290 `10 000 concurrent session capacity`: production API отримав JWT-authenticated SSE session leases у Redis з atomic acquire/renew/release, TTL після crash, tenant/user isolation і глобальним dedup між API replicas. Той самий registry захищає `chat/stream` від однакового `streamId` на різних репліках. Реальна мережева сертифікація відкрила 10 000 одночасних з'єднань через дві API-репліки, пройшла heartbeat, отримала 0 помилок, `409` для дубля, `401` без токена та 0 залишкових lease після disconnect. Стару in-process Map-імітацію замінено чесним load gate.

- 2026-09-11 — #56 `Background task auditability`, #114 `Background completion reporting`: Company Redis worker записує ідемпотентні `queued/claimed/started/retry_scheduled/completed/failed/cancelled` події у PostgreSQL. Run details та окремий authenticated report endpoint повертають terminal report із result/error, attempt, worker, tokens, cost і duration; Activity автоматично оновлює активний run та показує durable timeline. Strict-auth E2E перевірив зупинений worker, recovery, завершення, cross-company denial і збереження після restart API/worker.

- 2026-09-11 — #25 `Cost telemetry headers`, #27 `Usage analytics`, #29 `Audit trail`, #191 `Routing transparency`, #203 `Cache-hit savings telemetry`: один production inference trace нормалізує usage та upstream headers, записує модель/провайдера/стратегію/токени/cost/latency/cache/failover у PostgreSQL, повертає `X-NPATI-*` headers і показує незмінні `ai.inference` події у Run Trace. Якщо провайдер не повертає ціну, використовується явно позначена оцінка; cache savings не вигадуються. Strict-auth Docker E2E перевірив реальний Company run, analytics/audit і збереження після restart.

- 2026-09-11 — #286 `Company agents pagination + bounded Org Chart`: Company UI завантажує агентів сторінками по 60, запитує edges лише для поточної сторінки, дедуплікує агентів/зв'язки та не перевищує серверний ліміт 100 ID. API повертає явний HTTP 400 для завеликого фільтра, а PostgreSQL та in-memory store повертають також міжсторінкові зв'язки. Regression test перевіряє 121 агента, сторінки `60/60/1`, міжсторінковий edge і bounded-запити; strict-auth browser E2E перевіряє завантаження всіх трьох сторінок у `/company`.

- 2026-09-10 — #39 `Route guard tiers`, #54 `Human approvals`: Company runtime API застосовує tenant-bound free/pro/enterprise rate tiers і HTTP 429; high-risk tool створює PostgreSQL approval із TTL та exact payload binding, зупиняє run без retry storm, переживає restart і продовжується через authenticated `/runs/:runId/resume`. Atomic consume блокує replay; Activity tool audit фіксує deny/allow/result. #49 залишається Partial до isolated Exec.
- 2026-09-10 — #40 `MCP authorization scopes`, #48 `Tool allow/deny policy`, #102 `MCP scoped permissions`: реальний `/company-api/mcp/call` вимагає Company API key із `mcp:read`, перевіряє tenant/company ownership і revocation, а Company MCP runtime дозволяє лише явний read-only safe allowlist. Live OmniRoute MCP E2E підтверджує успішний health call та блокування missing-scope, unsafe-tool і revoked-key запитів.
- 2026-09-10 — #31 `Prompt-injection guard`, #32 `PII masker`, #33 `Credential masking`, #34 `Custom guardrails`: єдиний SecurityPolicyEngine захищає JSON/SSE/Company API, planning, retrieved documents/memory, tool inputs/results і final model calls; versioned Company policy зберігається у PostgreSQL, має optimistic revision та cleanup. Live E2E підтверджує user/document injection block, PII/credential redaction, custom term, restart recovery і чисті container logs.
- 2026-09-10 — #67 `Memory scoped by API key`, #68 `Optional sessionId scoping`, #69 `Memory injection`: PostgreSQL-backed scoped memory, deny-by-default API-key scopes, вкладена ізоляція однакового `sessionId` між ключами, idempotent writes, soft delete, cleanup компанії, natural-language FTS retrieval та реальна ін’єкція у Company model call. Strict-auth E2E підтверджує restart recovery, cross-key read/delete denial і `no-memory` bypass.
- 2026-09-10 — #296 `File delete and orphan cleanup`: єдиний cleanup path, post-delete MinIO verification, pending retry, failed/succeeded audit та strict-auth Docker restart-recovery E2E.
- 2026-09-10 — #306 `NPATI-004 end-to-end production validation`: strict Bearer auth, Excel/MinIO/embeddings/retrieval, concurrent idempotency, restart recovery, cancellation, tenant/company isolation і Main Agent → specialist pipeline.
- 2026-09-10 — #84 `Memory get` і #299 `Company memory`: scoped repository get, agent-callable list/search/get/create/update/delete, окремі write permissions, per-agent allowlist, Run Trace audit та strict-auth Main Agent live get.
- 2026-09-10 — #82 `Per-request no-memory`: user-facing Private request, payload/header API flags, memory/history/file persistence bypass у JSON + SSE chat, Company Knowledge/Memory prompt isolation та audited fail-closed denial для memory/files tools.
- 2026-09-10 — #70 `Vector semantic search`, #71 `Hybrid memory retrieval`, #75 `Semantic memory search`, #76 `Hybrid keyword + vector search`: єдиний production Company Knowledge path на pgvector + PostgreSQL FTS/GIN + reciprocal-rank fusion, keyword fallback при відмові embeddings, релевантна Company Memory, явне Knowledge permission UI та повний strict-auth E2E `Excel/TXT → Ready → Company chat → grounded answer` із cross-company isolation.

## Контроль актуальності

Перед кожним release автоматично порівнювати цей файл із `CAPABILITY_MATRIX`: кожний `PARTIALLY_IMPLEMENTED` або `NOT_IMPLEMENTED` ID має бути рівно в одному епіку; `VERIFIED_EXISTING` не повинен залишатися у backlog. Після зміни статусу обов'язково додати regression expectation і live `/capabilities/inspect` перевірку.

## Виконано 2026-09-11

- Live strict-auth E2E `node scripts/verify-chat-streaming.mjs` підтверджує, що основний WebChat викликає `/api/chat/stream`, отримує та рендерить відповідь реального підключеного провайдера; перевірочний запит працює у `noMemory` режимі й не забруднює історію.
- Завершено #42 `Streaming responses` і #224 `Response chunking`: OmniRoute adapter читає справжні Chat Completions та Responses API SSE-дельти, підтримує fallback до початку потоку, timeout/cancellation і не ріже Unicode surrogate pairs. `/chat/stream` передає впорядковані `delta` події, WebChat показує відповідь поступово та має кнопку `Stop`; складні Company/Business результати доставляються bounded частинами без дублювання фінального тексту.
- Виправлено cancellation propagation після ручної перевірки: `Stop` тепер перериває не лише browser fetch, а й активний Business model call або Company runtime. Після disconnect assistant result не записується у conversation history, а Company run завершується `RUN_CANCELLED` без результату; це доведено real HTTP disconnect та Company runtime regression tests.
- #65 і #302 чесно залишені `PARTIALLY_IMPLEMENTED`: production adapter та retrieval wiring існують, але live OmniRoute catalog у поточному середовищі повернув 0 rerank-моделей, а Jina/Cohere/Voyage credential не налаштований.

- Завершено: #47 `Sandboxing`, #49 `Exec approvals`, #53 `Sandbox + host separation`, #63 `Auto reviewer for exec`, #159 `Exec`.
- Company Agent може отримати `Exec`. JavaScript виконується у новій QuickJS WebAssembly VM з обмеженнями пам'яті, часу та обсягу відповіді, без Node globals, файлової системи хоста, environment, module loader і мережевого API.
- Кожний Exec автоматично перевіряється, вимагає durable human approval з exact payload binding, споживає approval лише один раз і записує результат у Company Run Trace.
- `tests/production-wasm-exec.test.ts` перевіряє реальне WASM-виконання, ізоляцію хоста/мережі, timeout, блокування reviewer до approval, точну прив'язку approval та replay denial.
- #160 `Process control` також завершено: кожний execution має ID, реєстр active executions, worker termination за AbortSignal і cleanup після завершення.
- #244 `Code Mode` завершено через той самий production Exec path: окремий режим у Agent Editor, code validation, обмежений JavaScript runtime та Run Trace — без другого дубльованого executor.

- 2026-09-13 — #38, #62, #260: production secrets зроблено обов’язковими, remote tokens прив’язано до tenant/company із fail-closed policy, AI preferences очищено від cross-workspace dev fallback; 40/40 targeted tests і live Docker E2E пройшли.
