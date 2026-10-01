# NPATI Website Builder — аудит архітектури (крок 0)

Це аудит фактичного коду, а не опис уже реалізованого Website Builder. Tenant `workspaceId` у NPATI означає наявний простір користувача; майбутній `ProjectWorkspace` є окремою сутністю (`packages/workspace/src/types.ts`).

## Що вже є → де знаходиться → що перевикористати/розширити

| Що вже є | Файли | Що перевикористати / розширити |
| --- | --- | --- |
| Company: owner `userId`, `workspaceId`, business link, профіль, knowledge/memory, `mainAgentId`, статус і revision | `packages/workspace/src/types.ts`, `packages/workspace/src/migration-006.ts`, `packages/workspace/src/postgres-store.ts` | Project зберігати під Company; виклик `getCompany` / `assertCompany` з AuthContext до кожної project-дії. |
| CRUD Company й агентів, Main Agent, parent → child | `apps/agent-api/src/workspace-routes.ts`, `packages/workspace/src/postgres-store.ts`, `packages/workspace/src/migration-006.ts` | Шляхи `/companies/:companyId/...`, idempotency key, `expectedRevision`; edge має FK у межах Company та одного parent на child. |
| Company UI: редактори, org chart, agent activity, Run Company | `apps/web/src/CompanyPage.tsx` | Додати Projects у поточну сторінку, використовувати її форми/API helper. |
| Agent: role, description, systemInstruction, promptGuidelines, modelId, fallbackModelId, tools, isActive | `packages/workspace/src/types.ts`, `apps/agent-api/src/company-runtime.ts`, `apps/web/src/CompanyPage.tsx` | Вибирати за роллю, описом, tools і активністю; не за name. Ієрархію зберігає окрема таблиця edges. |
| Company Knowledge: документи/chunks/retrieval; Company Memory: durable та scoped records | `apps/agent-api/src/company-knowledge.ts`, `apps/agent-api/src/company-knowledge-routes.ts`, `apps/agent-api/src/scoped-memory.ts`, `packages/workspace/src/migration-014.ts`, `packages/workspace/src/migration-023.ts` | Передавати релевантний Company context; Project context і source files зберігати окремо. |
| Run Company `auto/single/pipeline/fusion`: Main Agent планує через A2A, відбирає active agents, запускає combo, виконує tools | `apps/agent-api/src/company-runtime.ts`, `apps/agent-api/src/company-runtime-routes.ts`, `packages/workspace/src/types.ts` | Один execution engine; website run прив'язати до Project. Auto визначає mode з плану, інші режими лишаються чинними. |
| Run, agent steps, tool audit, background events, completion report | `packages/workspace/src/migration-007.ts`, `packages/workspace/src/migration-009.ts`, `packages/workspace/src/migration-030.ts`, `packages/workspace/src/postgres-store.ts`, `packages/workspace/src/types.ts` | `createCompanyAgentRun` створює durable run, `replaceCompanyAgentRunSteps` пише делегування, `getCompanyAgentRun` збирає trace. |
| Redis Streams queue: claim, lease, heartbeat, retry/recovery, tenant concurrency; knowledge worker | `apps/agent-api/src/company-run-queue.ts`, `apps/agent-api/src/company-knowledge-queue.ts`, `apps/agent-api/src/worker.ts`, `docker-compose.yml` | Project execution проводити через Company run queue. |
| Durable approval: request, approve/reject, expiry, payload hash, одноразове consume; run resume | `apps/agent-api/src/approvals-repository.ts`, `apps/agent-api/src/approvals-routes.ts`, `apps/agent-api/src/company-runtime.ts`, `apps/agent-api/src/company-runtime-routes.ts`, `packages/workspace/src/migration-016.ts`, `packages/workspace/src/migration-028.ts` | Для нового tool використовувати request/consumeApproved з прив'язкою user/company/run/agent/tool/payload; перевіряти також прямий API виклик. |
| Activity і Run Trace: runs, steps, tool audit, background events | `apps/web/src/ActivityPage.tsx`, `packages/shared/src/run-trace.ts`, `packages/workspace/src/types.ts`, `packages/workspace/src/migration-030.ts` | Додати event union, persistence constraint/emitters та UI разом; Activity читає `/companies/:companyId/runs` і `/runs/:runId`. |
| Capability registry, catalog, matrix, EffectiveCapabilityResolver, Inspector | `packages/shared/src/capabilities.ts`, `packages/shared/src/capability-catalog.ts`, `packages/shared/src/capability-matrix.ts`, `packages/shared/src/effective-capabilities.ts`, `packages/shared/src/capability-inspector.ts`, `apps/web/src/CapabilityInspectorPage.tsx` | Definition: `id, inventoryIds, type, domain, risk, agentCallable, requiresConfirmation, requiredPermissions, requiredConnections, version`; dot-separated ID, наприклад `browser.web_fetch`. Реєструвати у catalog **і** matrix, runtime adapter; `project` треба додати в union domain. `requiresConfirmation` — фактичне поле approval. |
| Tool path: agent.tools → capability canExecute → risk/approval → CompanyToolRuntime.execute → tool audit | `apps/agent-api/src/company-runtime.ts`, `apps/agent-api/src/company-tool-runtime.ts`, `packages/shared/src/effective-capabilities.ts`, `packages/shared/src/risk-approval.ts` | Для Project tool повторити server-side tenant та agent permission check перед дією; front-end ID і paths недовірені. |
| Intent routing: `HybridRouter` за сигналами message; ActiveContextResolver; structured chat planning | `packages/shared/src/hybrid-router.ts`, `apps/agent-api/src/active-context-resolver.ts`, `apps/agent-api/src/chat-task-plan.ts`, `apps/agent-api/src/app.ts` | HybridRouter повертає candidate tools/no-tool, але не готовий website-intent enum і не бере conversation history напряму. Chat path у app.ts враховує попередні messages; крок 5 розширює цей шлях. |
| AI: OmniRoute model/fallback, preferences, usage/cost | `packages/omniroute-adapter/src/omniroute-engine.ts`, `apps/agent-api/src/ai-preferences.ts`, `apps/agent-api/src/company-runtime.ts`, `apps/agent-api/src/cost-telemetry.ts` | Користуватися model/fallback, telemetry і чинними обмеженнями, без прив'язки до одного provider. |
| File metadata/authorization/quota, MinIO object storage та безпечні object keys | `apps/agent-api/src/file-metadata.ts`, `apps/agent-api/src/chat-file-service.ts`, `apps/agent-api/src/object-storage.ts`, `packages/workspace/src/migration-010.ts` | Застосувати для артефактів; blob storage не є редагованою source directory з revision. |
| Integrations: Company webhooks/MCP; GitHub repository adapter не знайдено | `apps/agent-api/src/integrations-routes.ts`, `apps/agent-api/src/integrations-repository.ts`, `apps/agent-api/src/coding-cli-and-file-tools.ts` | GitHub clone/push потребує окремого adapter і secret flow; generic `git` CLI metadata не дає інтеграції. |
| Часткові Files/Terminal/Sandbox: attachments, QuickJS WASM exec, temporary host-process sandbox | `apps/agent-api/src/chat-file-service.ts`, `apps/agent-api/src/wasm-exec-sandbox.ts`, `apps/agent-api/src/tool-sandbox.ts` | QuickJS лише JS без host FS/network; temporary process не є ізольованим Project build runner. Project preview/proxy тут немає. |
| PostgreSQL migration registry та in-memory store | `packages/workspace/src/postgres-store.ts`, `packages/workspace/src/migration-001.ts`, `packages/workspace/src/migration-053.ts`, `packages/workspace/src/in-memory-store.ts` | Нова numbered migration, реєстрація в `schema_migrations`, оновлення store contract; повного автоматичного rollback API немає. |
| Fastify API й React Router | `apps/agent-api/src/app.ts`, `apps/agent-api/src/workspace-routes.ts`, `apps/agent-api/src/auth.ts`, `apps/web/src/App.tsx` | Routes реєструвати в app.ts; перевіряти auth scopes. App.tsx має `/company`, `/settings/company`, `/activity`, `/settings/activity`, `/settings/capabilities`; Project route додати туди. |
| Vitest, typecheck, build | `package.json`, `apps/web/package.json`, `apps/agent-api/package.json`, `tests/chat-entity-mutations.test.ts`, `tests/company-runtime.test.ts` | Root scripts: `typecheck`, `test`, `build`; root `lint` script немає. |

## Чого немає

- Project CRUD, tenant-bound Project route/UI, active Project context (`packages/workspace/src/types.ts`, `apps/web/src/App.tsx`, `apps/agent-api/src/active-context-resolver.ts`).
- ProjectWorkspace з file tree, revision, symlink/path traversal checks та project permissions (`apps/agent-api/src/object-storage.ts`, `apps/agent-api/src/company-tool-runtime.ts`).
- SandboxProvider для package install/build, процесів та preview proxy (`apps/agent-api/src/wasm-exec-sandbox.ts`, `apps/agent-api/src/tool-sandbox.ts`, `docker-compose.yml`).
- Структуровані ProjectTask із dependencies і checkpoint snapshots (`packages/workspace/src/migration-007.ts`, `packages/workspace/src/types.ts`).
- GitHub repository connection/clone/push у Company integrations (`apps/agent-api/src/integrations-routes.ts`, `apps/agent-api/src/integrations-repository.ts`).

## Project, ProjectRun, ProjectTask, Checkpoint

**Рекомендація: перевикористати `company_agent_runs`; не створювати `project_runs`.** У кроці 1 додати `projects` з tenant/company FK та nullable `project_id` у `company_agent_runs`. `ProjectRun` є view/типом існуючого Run за перевіреним Project. Nullable залишає звичайні Company runs чинними; run ID, queue, retry, modes, telemetry та Activity уже існують (`packages/workspace/src/migration-007.ts`, `apps/agent-api/src/company-run-queue.ts`, `apps/web/src/ActivityPage.tsx`). Project ID із запиту перевіряти через Company ownership і run binding (`packages/workspace/src/postgres-store.ts`).

`company_agent_run_steps` описує **делегування агентів**, не довільні tasks: має `UNIQUE(run_id, agent_id)`, `step_order/lane/role/status/model_id`. Один агент може виконати багато ProjectTask. Для MVP кроку 5 використати run/tool event trace там, де достатньо; коли потрібен окремий task lifecycle, додати `project_tasks` з FK до існуючого run. Для dependencies/parallelism у кроці 8 ця таблиця потрібна, але execution engine лишається Company runtime (`packages/workspace/src/migration-007.ts`, `apps/agent-api/src/company-runtime.ts`, `docs/website-builder/PLAN.md`).

Checkpoint — snapshot/revision workspace, а не AI run step. Окрему `project_checkpoints` з project ID і optional run ID додати в кроці 6, разом із restore semantics; не раніше (`packages/workspace/src/migration-007.ts`, `docs/website-builder/PLAN.md`).

## SandboxProvider: варіанти для поточної інфраструктури

Поточний Compose запускає API, Company worker, PostgreSQL, Redis і MinIO; Docker socket не змонтований у API (`docker-compose.yml`). QuickJS worker не запускає package manager (`apps/agent-api/src/wasm-exec-sandbox.ts`).

| Варіант | Плюси | Мінуси |
| --- | --- | --- |
| Docker на **окремому runner host** за внутрішнім API | Знайома Compose інфраструктура, процесна ізоляція, host відокремлений від API/DB (`docker-compose.yml`, `apps/agent-api/src/worker.ts`) | Новий service/host, network і lifecycle. |
| Docker на тому ж host через окремий runner service | Простіший локальний MVP (`docker-compose.yml`) | Компрометація daemon/host загрожує API/DB; конкуренція за ресурси. |
| Керований віддалений runner | Краща інфраструктурна ізоляція та scale | Новий provider, credentials і витрати; готового adapter немає (`apps/agent-api/src/integrations-repository.ts`). |

**MVP: Docker на окремому runner host через provider interface.** Вимоги: непривілейований UID/GID; no privileged/root, CPU/RAM/**disk**/PIDs limits, read-only base image; mount тільки workspace цього Project; ніяких host secrets або Docker socket у контейнері; egress deny-by-default із реальним allowlist registry domains; timeout і output caps. API/worker не отримує Docker socket; runner автентифікує запити і звіряє Company/Project/Sandbox. Це ціль кроку 3, не гарантія поточного коду (`docker-compose.yml`, `apps/agent-api/src/wasm-exec-sandbox.ts`).

## Ризики й відкриті питання

- `workspaceId` уже tenant key. ProjectWorkspace/FK мають однозначно відрізнятись, і всі IDs перевіряються на сервері (`packages/workspace/src/types.ts`, `packages/workspace/src/postgres-store.ts`).
- Company ownership наразі прив'язаний до одного `userId`. Чи потрібна командна співпраця над Project? Це впливає на ACL (`packages/workspace/src/postgres-store.ts`).
- Де буде окремий runner host, які registry domains дозволені, який ліміт disk/time/concurrent sandboxes на tenant? Поточні queue limits не обмежують project disk (`docker-compose.yml`, `apps/agent-api/src/company-run-queue.ts`).
- Approval зберігає payload у DB і видає через API. Команди, env та credentials слід редагувати **до** approval, trace і Activity (`apps/agent-api/src/approvals-repository.ts`, `apps/agent-api/src/approvals-routes.ts`, `apps/web/src/ActivityPage.tsx`).
- Catalog і matrix різні файли; capability має отримати metadata, executable adapter та inspector evidence синхронно (`packages/shared/src/capability-catalog.ts`, `packages/shared/src/capability-matrix.ts`, `apps/agent-api/src/company-runtime.ts`).
- Для GitHub потрібні credential flow і обмежені scopes; чинні integrations — webhooks/MCP, vault є окремо (`apps/agent-api/src/integrations-repository.ts`, `packages/workspace/src/crypto-vault.ts`).

## Уточнений поділ кроків 1–5

| Крок | Реальні модулі |
| --- | --- |
| 1 Project | Numbered migration і реєстрація в `packages/workspace/src/postgres-store.ts`; контракти `packages/workspace/src/types.ts`, `in-memory-store.ts`; Company-scoped routes у `apps/agent-api/src/workspace-routes.ts` або сусідньому модулі, реєстрація в `app.ts`; UI `apps/web/src/CompanyPage.tsx`, `App.tsx`; tenant tests у `tests/` (`docs/website-builder/PLAN.md`). |
| 2 Files | ProjectWorkspace service із path/revision guards поверх `apps/agent-api/src/object-storage.ts` / `file-metadata.ts` або ізольованої директорії; tool adapter `company-tool-runtime.ts`, guard `company-runtime.ts`; catalog/matrix `packages/shared/src/`; Project Files UI (`docs/website-builder/PLAN.md`). |
| 3 Sandbox | Provider і окремий runner service; terminal adapter у `company-tool-runtime.ts`, approvals у `company-runtime.ts` / `approvals-repository.ts`; lifecycle через `company-run-queue.ts`; terminal UI. QuickJS/host process не годяться для build (`docs/website-builder/PLAN.md`, `apps/agent-api/src/wasm-exec-sandbox.ts`). |
| 4 Preview | Sandbox process, authenticated proxy у Fastify, preview/changes у Project UI, lifecycle у project service, capability catalog/matrix (`docs/website-builder/PLAN.md`, `apps/agent-api/src/app.ts`, `packages/shared/src/capabilities.ts`). |
| 5 Intent/Trace | Розширити `apps/agent-api/src/app.ts`, `chat-task-plan.ts`, `active-context-resolver.ts`, `packages/shared/src/hybrid-router.ts`; project binding у `company-runtime.ts`; event types у `packages/workspace/src/types.ts` і migration; `apps/web/src/ActivityPage.tsx`, Project card і link в `App.tsx` (`docs/website-builder/PLAN.md`). |

`docs/website-builder/current-state.md` не оновлено: критерій кроку 0 дозволяє змінювати лише цей файл (`docs/website-builder/PLAN.md`).

