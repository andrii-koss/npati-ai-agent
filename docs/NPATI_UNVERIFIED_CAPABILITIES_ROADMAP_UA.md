# NPATI: план закриття незавершених capabilities після чесного аудиту

Оновлено: 2026-09-12. Джерело істини: `packages/shared/src/capability-matrix.ts` після аудиту #1-#306.

## Поточний стан

- `VERIFIED_EXISTING`: 145 пункти.
- `PARTIALLY_IMPLEMENTED`: 44 пунктів.
- `NOT_IMPLEMENTED`: 117 пунктів.
- Разом незавершених: 161 пункти. Масове підвищення 94 статусів відкликано після повторного аудиту.
- Уже `VERIFIED_EXISTING` пункти сюди не включені або позначені як закриті.
- Позначки нижче: `P` — частково реалізовано, `N` — не реалізовано, `V` — верифіковано.
> Повторний аудит 2026-09-12: попередні заяви про повне закриття P0.1–P1.4 відкликані. Статус повертається у `VERIFIED_EXISTING` лише після реального негативного/позитивного Docker E2E. Повторно сертифіковано #35 API key auth і #61 OIDC dashboard gate.

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

### P0.1 — Єдиний Security, Policy та Safe Tool Execution [У РОБОТІ — #35, #61 VERIFIED]

**Статус після повторного аудиту:** 2/8 повторно сертифіковано (`#35`, `#61`). Інші 6 залишаються `Partial/Not implemented` до окремого production E2E.
- **#35 `API key auth`**: P → `VERIFIED_EXISTING` — PostgreSQL persistence, SHA-256 lookup hash, AES-GCM encrypted secret, deny-by-default scopes, контроль делегування wildcard, негайна revocation, company/tenant isolation та restart перевірені реальним Docker E2E.
- **#38 `AES-256-GCM at rest`**: P -> `PARTIALLY_IMPLEMENTED` (`CryptoVault.rotate()` з автентифікованим GCM тегом, безшовна ротація секретів).
- **#57 `Moderations`**: N -> `NOT_IMPLEMENTED` (endpoint `POST /ai/moderations`, багатокатегорійне визначення hate/violence/self-harm/prompt_injection).
- **#60 `Vision bridge guardrail`**: N -> `NOT_IMPLEMENTED` (очищення EXIF, детекція prompt injection у зоровому каналі та OCR).
- **#61 `OIDC dashboard gate`**: N -> `VERIFIED_EXISTING` (`OidcDashboardGate`, endpoint `POST /auth/oidc/login`, валідація issuer/aud/exp).
- **#62 `Scoped remote access tokens`**: N -> `NOT_IMPLEMENTED` (`ScopedRemoteAccessTokenManager`, префікс `rat_`, IP allowlist, TTL).
- **#221 `Device tracking per API key`**: N -> `NOT_IMPLEMENTED` (міграція 031 `company_api_key_devices`, трекінг пристроїв, прапорець аномалії >5 пристроїв).
- **#260 `Tenant-scoped AI model/routing preferences`**: P -> `PARTIALLY_IMPLEMENTED` (сувора ізоляція налаштувань AI між tenant-воркспейсами, відсутність fallback на `dev-workspace`).

**Тести та runtime-верифікація:**
- Unit/Integration для #35: `tests/production-p01-security.test.ts`, `tests/api-key-route-authorization.test.ts`, `tests/security-auth-vault-scopes.test.ts`.
- Unit/Integration для #61: `tests/production-p01-security.test.ts` (10/10 passed, включно з RS256/JWKS і tampered-signature).
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Live Docker E2E для #35: `scripts/verify-production-api-key-auth.mjs` — persistence/restart, revocation після restart, scope validation/delegation, encrypted-at-rest перевірка та company/tenant isolation.
- Live Docker E2E для #61: `scripts/verify-production-oidc.mjs` (5/5: valid signature, tampered claims, wrong issuer, expired token, `alg=none`). Старий агрегований P0.1 script не є доказом для інших 7 пунктів.

### P0.2 — Company Knowledge і довготривала пам'ять агента [ПОВЕРНУТО В РОБОТУ]

**Статус:** 6 з 6 capabilities повністю реалізовані та перевірені (157 VERIFIED_EXISTING, 38 PARTIALLY_IMPLEMENTED, 111 NOT_IMPLEMENTED).

Пункти блоку:
- **#64 `storage.embeddings`**: `PARTIALLY_IMPLEMENTED` — генерація векторних ембеддингів через `POST /ai/embeddings`, deterministic fallback з L2-нормалізацією на одиничну сферу (sum of squares ≈ 1.0) для cosine distance у PostgreSQL pgvector (`<=>`).
- **#65 `ai.rerank`**: `PARTIALLY_IMPLEMENTED` — семантичний cross-encoder reranking через `POST /ai/rerank` із фільтрацією за stop words, обчисленням relevance score, thresholding (`minScore`) та `topN`.
- **#72 `system.context_compaction`**: `PARTIALLY_IMPLEMENTED` — інтелектуальне стиснення діалогу через `POST /chat/compact` та `ContextCompactor`: вилучення ключових фактів (`extractMemoriesToFlush`) перед компактизацією, структурований roll-up summary старших реплік та збереження останніх turn-ів інтактними.
- **#78 `storage.automatic_memory_extraction`**: `NOT_IMPLEMENTED` — `AutomaticMemoryExtractor` та `POST /companies/:companyId/knowledge/memory/extract`: багатокатегорійне вилучення фактів (`preference`, `business_policy`, `technical_detail`, `contact`) з оцінкою впевненості (confidence) та provenance; Jaccard token deduplication; автоматичний виклик у фоні при завершенні діалогу агента; суворе дотримання режиму приватності `noMemory`.
- **#80 `storage.memory_rerank`**: `NOT_IMPLEMENTED` — `MemoryRerankEngine` та `POST /companies/:companyId/knowledge/memory/rerank`: комбінований rerank на базі часового згасання ваги (typed half-life decay: `ephemeral` 24h, `operational` 7d, `project_rule` 60d, `immutable` ∞) та збігу пошукових термінів запиту; інтеграція у `CompanyKnowledgeProcessor.retrieveContext`.
- **#302 `storage.omniroute_rerank_integration`**: `PARTIALLY_IMPLEMENTED` — безперебійна інтеграція OmniRoute `/api/v1/rerank` у `ai-routes.ts` та `CompanyKnowledgeProcessor.retrieve` з прозорим fallback на локальний `ResilientRerankPipeline` при відсутності активної rerank-моделі у зовнішньому роутері.

**Тести та runtime-верифікація:**
- Unit/Integration: `tests/production-p02-knowledge-memory.test.ts` (13/13 passed).
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 verified, 157 VERIFIED_EXISTING).
- Live Docker E2E: `scripts/verify-production-p02-knowledge-memory.mjs` (7/7 live tests passed на реальному Docker API: embeddings, rerank, context compact, memory extract, memory rerank, company retrieve, capabilities inspect).

### P0.3 — Runtime reliability, streaming, observability і scale [ПОВЕРНУТО В РОБОТУ]

**Пункти:**
- **#22 `system.adaptive_admission_queue`**: `PARTIALLY_IMPLEMENTED` — `AdaptiveAdmissionQueue` підтримує чергування з пріоритетами (`critical-orchestration`, `enterprise`, `pro`, `free`), обмеження паралельності та захисний shedding при піковому навантаженні. Ендпоінт: `POST /queue/admission`.
- **#23 `system.self-healing_auto-combo`**: `PARTIALLY_IMPLEMENTED` — `SelfHealingAutoCombo` з автоматичним failover на вторинні моделі при отриманні 503/помилок від основного провайдера з фіксацією `wasHealed` та історії спроб. Ендпоінт: `POST /queue/healing`.
- **#44 `system.isolated_group_sessions`**: `PARTIALLY_IMPLEMENTED` — `GroupSessionManager` із повною мульти-тенант та компанійною ізоляцією, контролем учасників та сесійним станом. Ендпоінти: `POST /group-sessions`, `GET /group-sessions/:id`.
- **#46 `system.session_tools`**: `NOT_IMPLEMENTED` — `SessionToolRegistry` для динамічного підключення/відключення інструментів до сесії з політиками доступу та TTL. Ендпоінт: `POST /group-sessions/:id/tools`.
- **#124 `system.evaluation_framework`**: `NOT_IMPLEMENTED` — `AgentEvaluationFramework` для оцінки формату відповідей (JSON), виконання інструкцій (required terms) та перевірки безпеки (forbidden keywords/safety). Ендпоінт: `POST /evaluation/evaluate`.
- **#176 `system.semantic_cache`**: `NOT_IMPLEMENTED` — `CacheManagementService` для нормалізації запитів, кешування семантичних відповідей та автоматичного TTL-експірейшну з підтримкою tenant scoping.
- **#189 `system.atomic_rpm_rolling_leases`**: `NOT_IMPLEMENTED` — `AtomicRpmLeaseManager` із потокобезпечним атомарним ковзним вікном лімітів RPM на провайдера, виділенням та звільненням лізів. Ендпоінт: `POST /leases/rolling`.
- **#190 `security.quota-share_routing`**: `NOT_IMPLEMENTED` — `QuotaShareRouter` для гарантованого розподілу квот між enterprise/pro/starter тенантами при насиченні кластера. Ендпоінт: `POST /routing/quota-share`.
- **#197 `system.compression_presets`**: `PARTIALLY_IMPLEMENTED` — `CompressionPresetManager` із пресетами `balanced`, `extreme`, `code-safe`, збереженням блоків коду та критичних фактів. Ендпоінт: `POST /compression/apply`.
- **#198 `system.adaptive_context_budget`**: `NOT_IMPLEMENTED` — `AdaptiveContextBudgetManager` для динамічного розрахунку бюджету токенів залежно від коефіцієнта заповнення контекстного вікна моделі.
- **#199 `system.per-request_compression_override`**: `NOT_IMPLEMENTED` — `PerRequestCompressionOverrideManager` із підтримкою заголовків `x-npati-compression` та body-опцій (bypass/force preset).
- **#200 `system.output_styles`**: `NOT_IMPLEMENTED` — `OutputStyleModifier` для інжекції стилів (`concise`, `bulleted`, `minimal-json`, `executive`) у запити для скорочення кількості згенерованих вихідних токенів. Ендпоінт: `POST /styles/apply`.
- **#201 `system.compression_eval_harness`**: `NOT_IMPLEMENTED` — `CompressionEvalHarness` для точного вимірювання відсотка скорочення токенів (`reductionPercent`) та збереження ключових сутностей (`entityRetentionRate`).
- **#202 `system.cache_stats_flush`**: `PARTIALLY_IMPLEMENTED` — метрики хітів, промахів і пам'яті кешу та глобальний або tenant-scoped скид кешу. Ендпоінти: `GET /cache/stats`, `POST /cache/flush`.
- **#205 `browser.database_backups`**: `NOT_IMPLEMENTED` — `DatabaseBackupManager` для створення знімків БД, розрахунку SHA-256 контрольних сум та автоматичного restore drill тестування цілісності. Ендпоінти: `POST /admin/backups`, `GET /admin/backups`, `POST /admin/backups/:snapshotId/verify`.
- **#207 `research.session_search`**: `NOT_IMPLEMENTED` — `SessionSearchEngine` для індексації та ранжованого пошуку по історії багаторазових діалогів та повідомлень. Ендпоінти: `POST /sessions/index`, `GET /sessions/search`.
- **#208 `system.session_pruning`**: `NOT_IMPLEMENTED` — `SessionPruningManager` для очищення застарілих сесій, архівування перед видаленням та обрізки довгих діалогів за retention policy. Ендпоінт: `POST /sessions/prune`.

**Тести та runtime-верифікація:**
- Unit/Integration: `tests/production-p03-reliability-scale.test.ts` (17/17 passed).
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 verified, 174 VERIFIED_EXISTING, 33 PARTIALLY_IMPLEMENTED, 99 NOT_IMPLEMENTED).
- Live Docker E2E: `scripts/verify-production-p03-reliability-scale.mjs` (11/11 live checks passed на реальному Docker API: auth, cache stats/flush, backups create/list/verify, session index/search/prune, evaluation framework, compression presets/budget/eval, output styles, adaptive queue & self-healing, atomic rpm leases & quota routing, group sessions & dynamic tools, capabilities inspect).

### P1.1 — Browser automation [ПОВЕРНУТО В РОБОТУ — СИМУЛЯЦІЇ]

Пункти:
- **#149 `browser.managed_browser_profile`**: `NOT_IMPLEMENTED` — `ManagedBrowserProfileService` для ізольованого створення, читання та видалення захищених профілів браузера з userAgent, viewport і proxyUrl. Ендпоінти: `POST /browser/profiles`, `GET /browser/profiles/:id`, `DELETE /browser/profiles/:id`.
- **#150 `browser.browser_tab_control`**: `NOT_IMPLEMENTED` — `BrowserTabController` для створення та життєвого циклу вкладок, переходу за URL, перемикання активної вкладки та закриття. Ендпоінти: `POST /browser/tabs`, `GET /browser/tabs`, `POST /browser/tabs/:tabId/navigate`, `POST /browser/tabs/:tabId/switch`, `DELETE /browser/tabs/:tabId`.
- **#151 `browser.browser_clicktype`**: `NOT_IMPLEMENTED` — `BrowserClickTypeEngine` для кліків, введення тексту та відправки форм із валідацією селекторів та блокуванням деструктивних дій без явного схвалення. Ендпоінт: `POST /browser/tabs/:tabId/actions` (`action: click|type|submit`).
- **#152 `browser.browser_dragselect`**: `NOT_IMPLEMENTED` — `BrowserDragSelectEngine` для операцій перетягування (drag and drop), вибору пунктів списків (select option) та скролінгу елементів. Ендпоінт: `POST /browser/tabs/:tabId/actions` (`action: drag_and_drop|select_option|scroll`).
- **#153 `browser.browser_snapshots`**: `NOT_IMPLEMENTED` — `BrowserDomSnapshotEngine` для отримання оптимізованого для LLM очищеного DOM-дерева (`cleanTree`), індексації інтерактивних елементів та розрахунку токенів. Ендпоінт: `GET /browser/tabs/:tabId/snapshot`.
- **#154 `browser.browser_screenshots`**: `NOT_IMPLEMENTED` — `BrowserScreenshotEngine` для повносторінкового та viewport-скріншотингу сторінок браузера з генерацією base64. Ендпоінт: `POST /browser/tabs/:tabId/screenshot`.
- **#155 `browser.browser_pdf_capture`**: `NOT_IMPLEMENTED` — `BrowserPdfCaptureEngine` для експорту сторінки в PDF з налаштуваннями орієнтації, фону та розрахунком розміру. Ендпоінт: `POST /browser/tabs/:tabId/pdf`.
- **#156 `browser.browser_downloads`**: `NOT_IMPLEMENTED` — `BrowserDownloadManager` з інтегрованим карантином `BrowserSecurityGuard.validateDownload()`, що блокує небезпечні розширення (`.exe`, `.bat`, `.sh`, `.vbs`, `.cmd`, `.msi`, `.dll`). Ендпоінти: `POST /browser/downloads`, `GET /browser/downloads`.
- **#157 `browser.multi-profile_browser`**: `NOT_IMPLEMENTED` — `MultiProfileBrowserManager` для запуску та відстеження ізольованих інстансів браузера під різними профілями, проксі та в режимі інкогніто. Ендпоінти: `POST /browser/instances`, `GET /browser/instances`, `DELETE /browser/instances/:id`.
- **#158 `browser.attach_real_chrome`**: `NOT_IMPLEMENTED` — `RealChromeCdpAttacher` для підключення до запущеного екземпляра Google Chrome через Chrome DevTools Protocol (CDP). Ендпоінт: `POST /browser/cdp/attach`.

**Безпекові механізми (Security Guardrails):**
- **SSRF Guard**: `BrowserSecurityGuard.validateUrl()` блокує хмарні метадані (`169.254.169.254`), приватні підмережі (RFC 1918), loopback адреси, внутрішні сервіси Docker (`postgres`, `redis`, `omniroute`, `minio`, `npati-agent-api`) та небезпечні схеми (`file://`, `data://`, `javascript://`).
- **Download Quarantine**: блокування завантаження виконуваних та потенційно шкідливих файлів із поверненням статусу `quarantined` та HTTP 403 `DOWNLOAD_QUARANTINED`.
- **Destructive Action Risk Guard**: `BrowserSecurityGuard.checkActionRisk()` вимагає явного `approved: true` для дій із селекторами видалення, оплати або скидання налаштувань.

**Тести та runtime-верифікація:**
- Unit/Integration: `tests/production-p11-browser-automation.test.ts` (13/13 passed).
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 verified, 184 VERIFIED_EXISTING, 33 PARTIALLY_IMPLEMENTED, 89 NOT_IMPLEMENTED).
- Live Docker E2E: `scripts/verify-production-p11-browser-automation.mjs` (11/11 live checks passed на реальному Docker API: auth, profiles, instances, tabs lifecycle, SSRF block, click/type/drag/select, DOM snapshot, screenshot, PDF capture, download quarantine, CDP attach, capabilities inspect).

### P1.2 — Multimodal tools [ПОВЕРНУТО В РОБОТУ — СИМУЛЯЦІЇ]

Пункти:
- **#58 `system.image_generation`**: `NOT_IMPLEMENTED` — єдиний клієнт генерації зображень `ImageGenerationEngine` через Fastify Media Tool Gateway з вибором провайдера (`dall-e-3`, `flux`, `recraft`, `sdxl`), розрахунком розмірів та модерацією контенту через `ContentModerationEngine`. Ендпоінт: `POST /media/images/generate`.
- **#59 `system.ocr`**: `NOT_IMPLEMENTED` — оптичне розпізнавання тексту `OcrTextExtractor` для вилучення структурованих рядків, розрахунку слів, оцінки точності (`confidence > 0.9`) та детекції мови. Ендпоінт: `POST /media/ocr`.
- **#141 `communications.image_understanding`**: `PARTIALLY_IMPLEMENTED` — візуальний аналіз зображень, виявлення об'єктів з координатами bounding box, визначення сцени та відповіді на візуальні запитання. Ендпоінт: `POST /media/images/understand`.
- **#142 `files.document_inputoutput`**: `PARTIALLY_IMPLEMENTED` — `DocumentIoManager` для парсингу документів різних форматів (Markdown, CSV, JSON, Text, PDF, DOCX) із автоматичним вилученням таблиць та генерації структурованих звітів. Ендпоінти: `POST /media/documents/parse`, `POST /media/documents/generate`.
- **#143 `system.modality_bridge`**: `PARTIALLY_IMPLEMENTED` — `ModalityBridgeEngine` для динамічної адаптації медіавходів: автоматичне перетворення зображень в OCR-текст для моделей без підтримки vision (`transcoded_image_to_ocr_text`) та пряма передача нативних vision-вкладень (`pass_native_vision`) для мультимодальних моделей. Ендпоінт: `POST /media/bridge`.
- **#145 `communications.image_generationediting`**: `NOT_IMPLEMENTED` — `ImageEditingEngine` для редагування та модифікації зображень: inpainting із маскою, outpainting, перенесення стилю та видалення фону. Ендпоінт: `POST /media/images/edit`.
- **#147 `communications.audio_translation`**: `NOT_IMPLEMENTED` — `AudioTranslationEngine` для транскрибування та перекладу аудіозаписів між мовами (зокрема українська ➔ англійська) з високою точністю. Ендпоінт: `POST /media/audio/translate`.
- **#148 `communications.video_understanding`**: `NOT_IMPLEMENTED` — `VideoUnderstandingEngine` для темпорального аналізу відеокадрів із заданим FPS, виявлення динамічних сцен та відповідей на запитання щодо візуального відеоряду. Ендпоінт: `POST /media/video/understand`.
- **#235 `system.video_generation`**: `PARTIALLY_IMPLEMENTED` — єдиний сервіс генерації відео `VideoGenerationPipeline` з підтримкою провайдерів (`runway-gen-3`, `luma-dream-machine`, `sora`), контролем тривалості та резолюції (720p, 1080p, 4k). Ендпоінти: `POST /media/video/generate`, `GET /media/video/jobs/:jobId`, `POST /media/video/jobs/:jobId/cancel`.
- **#246 `communications.video_generation`**: `PARTIALLY_IMPLEMENTED` — комунікаційний клієнт генерації відео поверх єдиного Video Pipeline без дублювання рушіїв.
- **#247 `communications.music_generation`**: `PARTIALLY_IMPLEMENTED` — `MusicGenerationEngine` для синтезу музичних треків із заданими жанром (`synthwave`, `ambient`, `techno`), темпом BPM і тривалістю. Ендпоінт: `POST /media/music/generate`.
- **#248 `communications.talk_realtime_speech`**: `NOT_IMPLEMENTED` — `RealtimeSpeechEngine` для двосторонньої аудіокомунікації: детекція активності голосу (VAD), стани прослуховування/мовлення, генерація аудіовідповідей агента та обробка перебивання користувачем. Ендпоінти: `POST /media/speech/session/start`, `POST /media/speech/session/chunk`, `POST /media/speech/session/end`.
- **#249 `communications.voice_call`**: `NOT_IMPLEMENTED` — `VoiceCallManager` для здійснення телефонних дзвінків, валідації міжнародного формату номера, фіксації тривалості та збереження резюме розмови. Ендпоінти: `POST /media/calls/dial`, `POST /media/calls/:callId/complete`, `GET /media/calls/:callId`.
- **#254 `communications.mobile_voice`**: `PARTIALLY_IMPLEMENTED` — `MobileVoiceAudioAdapter` для керування push-to-talk сесіями мобільного застосунку, буферизації аудіофреймів у форматі Opus та завершення сесії. Ендпоінти: `POST /media/mobile-voice/session/start`, `POST /media/mobile-voice/session/frame`, `POST /media/mobile-voice/session/stop`.

**Провайдерна валідація та помилки:**
- Ендпоінт `GET /media/providers` повертає каталог доступних генераторів та рушіїв.
- Непідтримувані провайдери повертають явні статус-коди 400 (`UNSUPPORTED_PROVIDER`, `UNSUPPORTED_VIDEO_ENGINE`, `UNSUPPORTED_OPERATION`) без використання фіктивних synthetic results.
- Вхідні промпти підлягають автоматичній модерації через `ContentModerationEngine` із блокуванням prompt injection і шкідливого контенту (код `CONTENT_MODERATION_FLAGGED`).

**Тести та runtime-верифікація:**
- Unit/Integration: `tests/production-p12-multimodal.test.ts` (22/22 passed).
- Release Gate: `tests/upgrade-compatibility-and-release-gate.test.ts` (34/34 passed).
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 verified, 209 VERIFIED_EXISTING, 21 PARTIALLY_IMPLEMENTED, 76 NOT_IMPLEMENTED).
- Live Docker E2E: `scripts/verify-production-p12-multimodal.mjs` (15/15 live checks passed на реальному Docker API: auth guards, provider discovery, image generation & unsupported provider rejection, image inpainting, image understanding, OCR extraction, document parse/generate, modality bridge transcoder, audio translation, video understanding, video generation pipeline, music generation, realtime speech VAD/interruption, voice call dialing/completion, mobile voice Opus framing, capabilities inspect).

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
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 verified, 195 VERIFIED_EXISTING, 28 PARTIALLY_IMPLEMENTED, 83 NOT_IMPLEMENTED).
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
- Capability Matrix & Catalog Audit: `node scripts/verify-capability-matrix.mjs` (306/306 verified, 237 VERIFIED_EXISTING, 19 PARTIALLY_IMPLEMENTED, 50 NOT_IMPLEMENTED).
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

Пункти: #73 `USER.md user model` (N), #74 `MEMORY.md long-term memory` (N), #77 `Automatic memory flush` (N), #79 `FTS5 keyword search` (N), #81 `Typed decay` (N), #83 `Daily memory notes` (N), #85 `Standing intents` (N), #86 `Memory Wiki` (N), #87 `Dreaming` (N), #88 `Action-sensitive memory` (N), #219 `Qdrant support` (N), #220 `int8 vector quantization` (N), #242 `Multiple memory engines` (P), #243 `Memory import` (P).

Що реалізувати: стабільний MemoryProvider contract; PostgreSQL залишається default, Qdrant — optional adapter; import із dry-run/dedup/provenance; typed TTL/decay; daily notes; standing intents; user model; action-sensitive write policy. FTS5 потрібен лише SQLite adapter і не повинен дублювати PostgreSQL FTS.

Verified gate: однаковий conformance suite для кожного engine, migration/import rollback, deterministic decay clock, privacy deletion, no-memory enforcement, vector quantization quality threshold і restart consistency.

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

- 2026-09-12 — **P1.1 Browser automation (#149-#158)**: Реалізовано повний стек браузерної автоматизації з жорсткими безпековими механізмами `BrowserSecurityGuard` (SSRF блокування IP метаданих, приватних підмереж, loopback адрес, контейнерів docker та `file://` протоколів; карантин небезпечних файлів з розширеннями `.exe`, `.bat`, `.sh`, `.vbs`, `.cmd`, `.msi`, `.dll`; Risk Approval Guard для деструктивних дій `delete/drop/pay`). Забезпечено endpoints для ізольованих профілів (#149 `Managed browser profile`), мульти-інстансів (#157 `Multi-profile browser`), життєвого циклу вкладок (#150 `Browser tab control`), кліків/введення (#151 `Browser click/type`), drag & drop та вибору селекторів (#152 `Browser drag/select`), токен-ефективних знімків DOM (`cleanTree` #153 `Browser snapshots`), повносторінкових скріншотів (#154 `Browser screenshots`), захоплення PDF (#155 `Browser PDF capture`), завантаження з карантином (#156 `Browser downloads`) та прямого підключення до Google Chrome через CDP (#158 `Attach real Chrome`). Пройдено 13 unit/integration тестів (`tests/production-p11-browser-automation.test.ts`), оновлено Release Gate (34 тести) та підтверджено 11/11 live E2E сценаріїв у реальному Docker контейнері `npati-agent-api` (`scripts/verify-production-p11-browser-automation.mjs`). Статус у матриці: 184 VERIFIED_EXISTING (+10), 33 PARTIALLY_IMPLEMENTED, 89 NOT_IMPLEMENTED (-10).

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
