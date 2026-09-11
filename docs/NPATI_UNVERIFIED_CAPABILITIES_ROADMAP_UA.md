# NPATI: план закриття незавершених capabilities після чесного аудиту

Оновлено: 2026-09-11. Джерело істини: `packages/shared/src/capability-matrix.ts` після аудиту #1-#306.

## Поточний стан

- `PARTIALLY_IMPLEMENTED`: 51 пункт.
- `NOT_IMPLEMENTED`: 122 пункти.
- Разом у цьому backlog: 173 пункти.
- Уже `VERIFIED_EXISTING` пункти сюди не включені.
- Позначки нижче: `P` — частково реалізовано, `N` — не реалізовано.

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

### P0.1 — Єдиний Security, Policy та Safe Tool Execution

Найвищий пріоритет: без цього небезпечно додавати browser, exec, channels і autonomous workflows.

Пункти, які ще залишилися: #35 `API key auth` (P), #38 `AES-256-GCM at rest` (P), #57 `Moderations` (N), #60 `Vision bridge guardrail` (N), #61 `OIDC dashboard gate` (N), #62 `Scoped remote access tokens` (N), #221 `Device tracking per API key` (N), #260 `Tenant-scoped AI model/routing preferences` (P).

Що реалізувати: один Effective Policy Engine для API, agent tools, MCP, exec і media; deny-by-default scopes; short-lived scoped tokens; encrypted secret vault із rotation; PII/credential redaction до logs і model calls; isolated container runner без host filesystem/network за замовчуванням; approval lifecycle із TTL, one-time token та audit.

Verified gate: cross-tenant, prompt-injection, token replay, path traversal, SSRF, command injection, secret leakage, denied-tool і approval-bypass тести; реальний sandbox escape suite; live OIDC/API-key flow.

### P0.2 — Company Knowledge і довготривала пам'ять агента

Це найкорисніша функція для бізнес-агента після базового chat/model routing.

Пункти: #64 `Embeddings` (P), #65 `Rerank` (P), #72 `Context compaction` (P), #78 `Automatic memory extraction` (N), #80 `Memory rerank` (N), #302 `OmniRoute Rerank integration` (P).

Що реалізувати: один scoped Retrieval Engine на PostgreSQL FTS + pgvector; reciprocal-rank fusion; підключена production rerank-модель; callable `memory.get/search/create/update` з окремими read/write permissions; `no-memory` прапорець; контрольований extractor із provenance; token-budget compaction.

Verified gate: точні факти з Excel/PDF/DOCX/TXT, hybrid search і rerank на живому endpoint; zero-result/fallback; cross-company/user negatives; delete-vs-worker race; restart; callable memory read/write audit; E2E Main Agent -> specialist із strict auth.

### P0.3 — Runtime reliability, streaming, observability і scale

Пункти: #22 `Adaptive admission / queue` (P), #23 `Self-healing Auto-Combo` (P), #25 `Cost telemetry headers` (N), #27 `Usage analytics` (P), #29 `Audit trail` (P), #44 `Isolated group sessions` (P), #46 `Session tools` (N), #56 `Background task auditability` (N), #114 `Background completion reporting` (P), #124 `Evaluation framework` (N), #176 `Semantic cache` (N), #189 `Atomic RPM rolling leases` (N), #190 `Quota-Share routing` (N), #191 `Routing transparency` (P), #192 `Session-Dedup` (N), #197 `Compression presets` (P), #198 `Adaptive context budget` (N), #199 `Per-request compression override` (N), #200 `Output Styles` (N), #201 `Compression eval harness` (N), #202 `Cache stats / flush` (P), #203 `Cache-hit savings telemetry` (N), #205 `Database backups` (N), #207 `Session search` (N), #208 `Session pruning` (N), #286 `Company agents pagination + bounded Org Chart` (P), #290 `10 000 concurrent session capacity` (P).

Що реалізувати: Redis admission з tenant fairness/backpressure; справжнє SSE streaming із reconnect/cancel; єдиний immutable Run Trace; provider/model/cost/token/cache telemetry; semantic cache з tenant keys; atomic quota leases; backup/restore drill; cursor-based session search/pruning; сторінкова Org Chart без >100 edge request; distributed 10k connection profile, а не `Map` simulation.

Verified gate: k6/Artillery тест 10k authenticated WebSocket/SSE/chat sessions на кількох API replicas, provider emulator із backpressure, crash/recovery і zero duplicate execution; restore backup у чисту БД; усі витрати пояснюються Run Trace.

### P1.1 — Browser automation

Пункти: #149 `Managed browser profile` (N), #150 `Browser tab control` (N), #151 `Browser click/type` (N), #152 `Browser drag/select` (N), #153 `Browser snapshots` (N), #154 `Browser screenshots` (N), #155 `Browser PDF capture` (N), #156 `Browser downloads` (N), #157 `Multi-profile browser` (N), #158 `Attach real Chrome` (N).

Що реалізувати: один Playwright/CDP Browser Worker з ізольованими encrypted profiles, deterministic snapshot refs, tab lifecycle, click/type/drag/select, downloads quarantine, screenshots/PDF, domain policy, SSRF protection та approval для небезпечних дій.

Verified gate: live сайти, popup/iframe/download, timeout/cancel, profile isolation, malicious download і cross-tenant tests; кожна дія присутня у Run Trace.

### P1.2 — Multimodal tools

Пункти: #58 `Image generation` (N), #59 `OCR` (N), #141 `Image understanding` (P), #142 `Document input/output` (P), #143 `Modality bridge` (P), #145 `Image generation/editing` (N), #147 `Audio translation` (N), #148 `Video understanding` (N), #235 `Video generation` (P), #246 `Video generation` (P), #247 `Music generation` (P), #248 `Talk / realtime speech` (N), #249 `Voice Call` (N), #254 `Mobile voice` (P).

Що реалізувати: один Media Tool Gateway з provider discovery, upload/result persistence у MinIO, async jobs, progress/cancel, MIME/signature validation, moderation та cost limits. Обидва пункти про image generation мають використовувати один image-сервіс, а обидва пункти про video generation — один video-сервіс.

Verified gate: реальні image edit/OCR/audio translation/video generation/understanding/realtime voice calls; binary artifacts відкриваються після restart; unsupported provider повертає явну помилку, не synthetic result.

### P1.3 — Automations, triggers і durable tasks

Пункти: #128 `Webhooks` (P), #129 `Automations scheduler` (N), #130 `Cron jobs` (P), #131 `Background Tasks ledger` (P), #133 `Task Flow` (P), #134 `Standing Orders` (N), #135 `Webhooks ingress` (P), #136 `IMAP email trigger` (N), #137 `Webhook retries` (N), #138 `One-shot reminders` (N), #140 `Lifecycle hooks` (N).

Що реалізувати: один durable Automation Engine у PostgreSQL + Redis із cron/one-shot scheduling, signed webhook ingress/outbound delivery, retry/DLQ, IMAP cursor/idempotency, standing orders, lifecycle hooks, tenant quotas, cancellation та task ledger.

Verified gate: clock/restart/timezone/DST tests, duplicate webhook/email suppression, signature/replay protection, retry exhaustion у DLQ, UI/API create-pause-resume-delete і повний Run Trace.

### P1.4 — Multi-agent, MCP та A2A control plane

Пункти: #94 `cost-optimized` (N), #95 `context-optimized` (N), #96 `cache-optimized` (N), #97 `lkgp` (N), #103 `A2A protocol v0.3` (P), #104 `A2A: Smart Routing` (P), #105 `A2A: Health Report` (N), #106 `OmniConductor` (N), #112 `Isolated vs forked context` (N), #113 `Agent send / session messaging` (N), #120 `A2A: Quota Management` (N), #121 `A2A: Provider Discovery` (N), #122 `A2A: Cost Analysis` (N), #123 `A2A: List Capabilities` (N), #125 `Nested sub-agents` (N), #127 `Swarm` (N), #177 `priority` (N), #178 `fill-first` (N), #179 `weighted` (N), #180 `round-robin` (N), #181 `p2c` (N), #182 `least-used` (N), #183 `random` (N), #184 `strict-random` (N), #185 `headroom` (N), #186 `reset-window` (N), #187 `reset-aware` (N), #188 `context-relay` (N).

Що реалізувати: один Orchestration Strategy Registry поверх OmniRoute, а не окремі routers; versioned A2A envelopes, capability/provider discovery, health/quota/cost snapshots, context fork/isolation, durable agent messaging, bounded nested depth/fan-out, cancellation propagation та deterministic strategy tests.

Verified gate: multi-process A2A interoperability, malformed/untrusted peer negatives, quota exhaustion, provider failure, nested cancellation, cycle protection і порівняльні routing metrics. Не дублювати вже робочі Auto/Pipeline/Fusion.

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
8. Виправити Org Chart pagination >100: #286.
9. Реалізувати unified cost/usage/audit trace: #25, #27, #29, #56, #114, #191, #203.
10. Запустити distributed authenticated 10k session certification і лише після цього закрити #290.

## Завершені кроки

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
- #65 і #302 чесно залишені `PARTIALLY_IMPLEMENTED`: production adapter та retrieval wiring існують, але live OmniRoute catalog у поточному середовищі повернув 0 rerank-моделей, а Jina/Cohere/Voyage credential не налаштований.

- Завершено: #47 `Sandboxing`, #49 `Exec approvals`, #53 `Sandbox + host separation`, #63 `Auto reviewer for exec`, #159 `Exec`.
- Company Agent може отримати `Exec`. JavaScript виконується у новій QuickJS WebAssembly VM з обмеженнями пам'яті, часу та обсягу відповіді, без Node globals, файлової системи хоста, environment, module loader і мережевого API.
- Кожний Exec автоматично перевіряється, вимагає durable human approval з exact payload binding, споживає approval лише один раз і записує результат у Company Run Trace.
- `tests/production-wasm-exec.test.ts` перевіряє реальне WASM-виконання, ізоляцію хоста/мережі, timeout, блокування reviewer до approval, точну прив'язку approval та replay denial.
- #160 `Process control` також завершено: кожний execution має ID, реєстр active executions, worker termination за AbortSignal і cleanup після завершення.
- #244 `Code Mode` завершено через той самий production Exec path: окремий режим у Agent Editor, code validation, обмежений JavaScript runtime та Run Trace — без другого дубльованого executor.
