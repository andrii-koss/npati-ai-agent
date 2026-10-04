# NPATI Data Studio + Project Auth — D0 architecture audit

Scope: repository inspection only. The old Website Builder audit predates implemented Project and sandbox modules (docs/website-builder/00-audit.md; packages/workspace/src/types.ts; apps/agent-api/src/app.ts). No runtime change is part of D0.

## Що вже є → де знаходиться → що перевикористати/розширити

| Що вже є | Де знаходиться | Що перевикористати / розширити |
| --- | --- | --- |
| Core Postgres pgvector/pgvector:pg17; volume postgres-data, loopback host port, healthcheck pg_isready, network npati-agent-network; API і worker використовують DATABASE_URL | docker-compose.yml; docker-compose.dokploy.yml | Зберегти Core окремо; додати postgres-projects із власними volume/network і без host port. |
| pg Pool max 10; SQL з параметрами, без ORM/query builder; schema_migrations і numbered transactional migrations при initialize | packages/workspace/package.json; packages/workspace/src/postgres-store.ts | Нову Core migration зареєструвати тут; окремий runner для project DB. Інші repositories створюють додаткові pools, тому обмежити загальну кількість connections (apps/agent-api/src/browser-credentials-repository.ts). |
| vector extension для Company knowledge | packages/workspace/src/migration-014.ts | Project DB у D1 не потребує pgvector; postgres:17 достатній для запланованого SQL. |
| CryptoVault: AES-256-GCM/scrypt, NPATI_ENCRYPTION_KEY, encrypted Company credential fields, owner-scoped resolve | packages/workspace/src/crypto-vault.ts; packages/workspace/src/migration-043.ts; apps/agent-api/src/browser-credentials-repository.ts | Шифрувати connection strings/role passwords у Core, зберігати opaque secret refs у metadata; зробити backend-only resolver, rotation і заборону видачі secret у API/Activity. Master key та process memory лишаються trust boundary. |
| Project під Company: workspace/company/creator, типи website/web_app/landing_page, CRUD з idempotency/revision, файли, checkpoints, deploy | packages/workspace/src/types.ts; packages/workspace/src/migration-054.ts; packages/workspace/src/migration-057.ts; apps/agent-api/src/project-routes.ts; apps/agent-api/src/project-workspace.ts | Додати nullable data_backend_id. ProjectWorkspace нині файлова service, не окрема Core entity. Тип mobile_app ще відсутній. |
| SandboxProvider, scoped Docker runner, network та egress proxy allowlist; terminal environmentReferences резолвляться з Company vault | apps/agent-api/src/sandbox-provider.ts; apps/agent-api/src/docker-sandbox-provider.ts; apps/agent-api/src/sandbox-runner-server.ts; apps/agent-api/src/project-sandbox-service.ts | Sandbox network не має маршруту до project DB; DB credentials і PROJECT_SECRET_KEY ніколи не передавати через environmentReferences. |
| Preview start/status/token та proxy у Fastify | apps/agent-api/src/project-preview-routes.ts; apps/agent-api/src/project-preview-service.ts; apps/agent-api/src/app.ts | Preview origin для CORS Project API; preview token не вважати Project Auth JWT. |
| Capability catalog/matrix/effective resolver, risk/approval з hash payload, expiry та одноразовим consume | packages/shared/src/capability-catalog.ts; packages/shared/src/capability-matrix.ts; packages/shared/src/effective-capabilities.ts; packages/shared/src/risk-approval.ts; apps/agent-api/src/approvals-repository.ts; apps/agent-api/src/company-runtime.ts | Додати Data/Auth groups в catalog і matrix, adapter у apps/agent-api/src/company-tool-runtime.ts, tenant/agent checks і approval для destructive operations. Plaintext secrets не класти в approval payload. |
| Intent Router, project context, Runs/Tasks, Activity/Run Trace | packages/shared/src/hybrid-router.ts; apps/agent-api/src/active-context-resolver.ts; apps/agent-api/src/chat-task-plan.ts; apps/agent-api/src/project-task-graph.ts; apps/agent-api/src/company-runtime.ts; apps/web/src/ActivityPage.tsx; packages/shared/src/run-trace.ts | Розширити наявні routing, run та event types; trace містить IDs/status/redacted diff, а не secrets чи приватні rows. |
| NPATI auth: local dev fallback, NPATI JWT, OIDC dashboard, remote token, NPATI API key → AuthContext user/workspace/permissions; Project routes додатково перевіряють permission | apps/agent-api/src/auth.ts; apps/agent-api/src/security-guardrails-and-tokens.ts; apps/agent-api/src/project-routes.ts; packages/workspace/src/types.ts | Це owner/control-plane auth. Project Auth повинен мати окремі issuer/audience/keys/users у project DB. npati_live_ key не є Project API key. |
| Fastify routes й global CORS webOrigin; React Project/Company/Inspector/Activity pages, forms та ConfirmDialog | apps/agent-api/src/app.ts; apps/agent-api/src/project-routes.ts; apps/web/src/App.tsx; apps/web/src/ProjectPage.tsx; apps/web/src/ProjectSection.tsx; apps/web/src/ConfirmDialog.tsx; apps/web/src/CapabilityInspectorPage.tsx | Control-plane API та UI розширити тут. Public Project API потребує окремого CORS allowlist/rate limit/auth path. |
| SMTP/IMAP Company inbox і background email jobs | apps/agent-api/src/email-transport.ts; apps/agent-api/src/email-worker.ts; apps/agent-api/src/email-inbox-repository.ts | Перевикористати transport, але Project Auth verification/reset потребує окремого transactional sender config, templates і throttling. |
| /admin/backups: in-memory Map із simulatedContent і checksum, не дамп Postgres; Project checkpoints — Git snapshots файлів | apps/agent-api/src/telemetry-backups-and-session-search.ts; apps/agent-api/src/reliability-and-operations-routes.ts; apps/agent-api/src/project-git-service.ts | Не покладатися на це для DB restore; D7 потребує реальні dump/restore і незалежне сховище. |
| NPATI web app; mobile-related backend features, але окремого Expo/React Native app workspace немає | package.json; apps/web/package.json; apps/agent-api/src/mobile-chat-voice-camera.ts; packages/workspace/src/types.ts | Project mobile_app і його Project API — окрема робота D6. |

## Що створити з нуля

DataBackend, environments, DatabaseProvisioner, три role credentials, project migration runner, introspection/fingerprint, access policy compiler, Data Studio UI, public Project API, Project Auth/SDK та project DB backup/restore відсутні у чинних contracts/routes (packages/workspace/src/types.ts; packages/workspace/src/postgres-store.ts; apps/agent-api/src/app.ts; apps/web/src/App.tsx). Core schema_migrations не використовувати як journal project DB (packages/workspace/src/postgres-store.ts).

## Чернетка Docker Compose

Додати сервіс postgres-projects з образом postgres:17, volume postgres-projects-data:/var/lib/postgresql/data, restart unless-stopped, pg_isready healthcheck, expose 5432 без ports, cpus/mem_limit/pids_limit. Окремі NPATI_PROJECTS_POSTGRES_ADMIN_USER/PASSWORD/DB; production values required без development defaults. Internal network npati-projects-db-network підключає тільки DB та backend component, який виконує provision/migrate/API, жоден sandbox/web/crawler. Повторити в Dokploy compose і env examples (docker-compose.yml; docker-compose.dokploy.yml; .env.production.example; apps/agent-api/src/sandbox-runner-server.ts).

Поточні agent-api та company-worker ділять env anchor: його треба розділити, щоб provisioner/admin credentials бачив лише backend NPATI, migrator лише migration engine, runtime лише gateway. Якщо сервіс під profile data-studio, не ставити unconditional depends_on від agent-api: Core boot і звичайний chat мають працювати без project DB, а Data Studio повертає unavailable. Ліміти CPU/RAM/connections конфігуровані, бюджет pools перевірити при scale (docker-compose.yml; docker-compose.scale.yml; packages/workspace/src/postgres-store.ts).

## DataBackend і environments: дизайн та Core migration

Пропозиція: data_backends(id, workspace_id, company_id, name, provider_kind, provider_config_json, status, created_by, revision, created_at, updated_at) з UNIQUE(workspace_id,company_id,id). data_backend_environments(id, workspace_id, company_id, data_backend_id, name dev|prod, database_name, provisioner_secret_ref, migrator_secret_ref, runtime_secret_ref, jwt_key_ref, publishable_key_hash, secret_key_hash, schema_fingerprint, policy_fingerprint, status, timestamps), UNIQUE(data_backend_id,name). Окремі Core records для UI metadata, versioned migration intent та declarative access policies. provider_config_json без credentials (packages/workspace/src/migration-054.ts; packages/workspace/src/crypto-vault.ts; docs/data-studio/PLAN.md).

У наступній numbered Core migration додати projects.data_backend_id NULL з composite FK (workspace_id,company_id,data_backend_id) → data_backends(workspace_id,company_id,id), індекс і заборону cross-company attach. Існуючі Projects лишаються NULL, explicit authorized attach створює зв'язок; багато Projects Company можуть використовувати один backend. Оновити types, Postgres/in-memory stores та service в одній реалізації. DatabaseProvisioner приймає dataBackend + environment, повертає role-scoped handle тільки потрібному backend service, не Project чи агенту (packages/workspace/src/migration-054.ts; packages/workspace/src/types.ts; packages/workspace/src/postgres-store.ts; packages/workspace/src/in-memory-store.ts; docs/data-studio/PLAN.md).

## Метадані, schema truth і policy drift

Рекомендація: фактична структура — introspection project DB (tables/columns/constraints/indexes/RLS flags/policies), _npati_migrations — журнал версій. Core зберігає migration intent, UI metadata і очікуваний canonical schema fingerprint, але не авторитетну копію фактичної структури. До кожного schema write/promote звіряти fingerprint та history; при drift блокувати й показувати diff. Це відповідає окремому project runner і наявному Core journal (packages/workspace/src/postgres-store.ts; docs/data-studio/PLAN.md).

Declarative access policy у Core — джерело істини для наміру/UI. Один server-side compiler генерує GRANT, ENABLE + FORCE ROW LEVEL SECURITY, USING і WITH CHECK як versioned migration. Після застосування introspection pg_policy/pg_class формує policy fingerprint; mismatch означає fail-closed для affected collection до reconciliation. Тести policy compiler: anonymous, authenticated, owner, інший user, owner transfer, service operation. Агент не подає SQL (docs/data-studio/PLAN.md; packages/shared/src/risk-approval.ts; [PostgreSQL 17 RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)).

## Project API: архітектура і runtime RLS

| Підхід | Оцінка |
| --- | --- |
| Модуль в існуючому Fastify API | Рекомендовано для D5: чинний route/deployment/telemetry path, але окремі public routes, pool та credentials; див. apps/agent-api/src/app.ts і apps/agent-api/src/project-routes.ts. |
| Окремий сервіс | Сильніша процесна ізоляція й масштабування public traffic, але новий lifecycle/deployment та дублювання control-plane integration; див. docker-compose.yml і apps/agent-api/src/app.ts. Зовнішній API можна зберегти при майбутньому винесенні. |

Public path через reverse proxy до gateway; publishable key + verified host визначають backend/environment у Core, а не client project_id. CORS allowlist за verified project/preview domains, Vary: Origin, rate limit key/IP/user, bounded pagination/payload/query complexity. Mobile CORS не захищає, тому ключ+JWT+rate limit обов'язкові (apps/agent-api/src/app.ts; apps/agent-api/src/project-preview-routes.ts; docs/data-studio/PLAN.md).

Gateway перевіряє publishable key і Project Auth JWT (issuer/audience/backend/environment/subject), collection/operation, потім бере runtime pool конкретного backend+environment. В одній checkout transaction: BEGIN; параметризований SELECT set_config('npati.user_id', $1, true) та validated role claims; запит із allowlisted+quoted identifiers і parameterized values; COMMIT/ROLLBACK; release. RLS читає current_setting('npati.user_id', true) з default-deny при missing claim. Session SET поза transaction небезпечний для pooling. Runtime role має мінімальні USAGE/table grants, не owner і без SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS. PROJECT_SECRET_KEY тільки server-side, без автоматичного RLS bypass; admin дії окремим owner auth/approval path (docs/data-studio/PLAN.md; packages/workspace/src/postgres-store.ts; [PostgreSQL 17 RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html); [PostgreSQL 17 functions](https://www.postgresql.org/docs/17/functions-admin.html)).

## PostgreSQL 17 для плану

ENABLE/FORCE RLS, default-deny, USING/WITH CHECK, role attributes/GRANT, transaction advisory locks pg_advisory_xact_lock та transaction-local set_config(..., true) підтримуються PostgreSQL 17 ([RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html); [roles](https://www.postgresql.org/docs/17/role-attributes.html); [functions](https://www.postgresql.org/docs/17/functions-admin.html)). pg_dump -Fc і pg_restore стандартні CLI, але dump однієї DB не зберігає cluster roles: role recreation і restore drill окремо ([pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html); [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)). Стандартний postgres:17 придатний для D1 SQL; scheduler, secret manager і pooler доведеться організувати окремо (docker-compose.yml; docs/data-studio/PLAN.md).

## Модель загроз

| Актор | Ризик | Контроль |
| --- | --- | --- |
| AI agent у sandbox | env/file access, DB egress, довільний SQL | Немає DB/secret keys і DB network, лише structured operations + approval; apps/agent-api/src/project-sandbox-service.ts; apps/agent-api/src/docker-sandbox-provider.ts; apps/agent-api/src/company-tool-runtime.ts. |
| Кінцевий користувач сайту | Підміна project/user IDs, publishable key як «секрет», mass assignment | Project JWT, operation policy, RLS, allowlisted columns, rate limit; apps/agent-api/src/auth.ts; apps/agent-api/src/project-routes.ts; docs/data-studio/PLAN.md. |
| Сусідній Project/Company | Підміна backend ID, pool session leak | Composite FK, DB per backend+environment, per-DB roles, transaction-local claims; shared backend навмисно об'єднує дані attached Projects, тому attach high-impact; packages/workspace/src/migration-054.ts; docs/data-studio/PLAN.md. |
| Помилка generated code | Secret у bundle/log/Activity, SQL injection, traffic spike | Лише publishable key у client, redaction, identifier validation+quoting, quotas та runtime grants; apps/agent-api/src/project-sandbox-service.ts; apps/web/src/ActivityPage.tsx; packages/shared/src/risk-approval.ts. |

## Ризики та питання власнику

- agent-api/company-worker ділять env anchor, а terminal підтримує secret references. D1 має розвести credentials і заборонити їхній експорт у sandbox (docker-compose.yml; apps/agent-api/src/project-sandbox-service.ts).
- /admin/backups не виконує DB dump; потрібна окрема реальна стратегія і для Core, і для project DB (apps/agent-api/src/telemetry-backups-and-session-search.ts; apps/agent-api/src/reliability-and-operations-routes.ts).
- Який scope PROJECT_SECRET_KEY: лише server-to-server data під RLS чи admin? Рекомендація: admin тільки окремим NPATI owner auth/approval path (docs/data-studio/PLAN.md; apps/agent-api/src/auth.ts).
- Які production/preview custom domains і Project Auth email sender identity? Це визначає CORS, redirect allowlist та delivery (apps/agent-api/src/project-preview-routes.ts; apps/agent-api/src/email-transport.ts; docs/data-studio/PLAN.md).
- Чи потрібна командна власність Company? Нинішня FK Project прив'язує created_by до Company owner (packages/workspace/src/migration-054.ts; packages/workspace/src/types.ts).

## Уточнений поділ D1–D7

| Крок | Реальна робота |
| --- | --- |
| D1 | Core numbered migration, DataBackend/environment stores/types/FK, DatabaseProvisioner та три ролі, окремий project migration runner/drift API, Compose variants; packages/workspace/src/postgres-store.ts; packages/workspace/src/migration-054.ts; docker-compose.yml; docs/data-studio/PLAN.md. |
| D2 | Collections/fields/relations, structured schema operations, introspection/fingerprint і UI на Project page; apps/web/src/ProjectPage.tsx; apps/agent-api/src/project-routes.ts; docs/data-studio/PLAN.md. |
| D3 | Row CRUD, access policy compiler/RLS, capability groups, approval і Activity; packages/shared/src/capability-catalog.ts; packages/shared/src/capability-matrix.ts; apps/agent-api/src/company-tool-runtime.ts; apps/web/src/ActivityPage.tsx; docs/data-studio/PLAN.md. |
| D4 | Project Auth tables/JWT, verification/reset на SMTP adapter, ізоляція від NPATI auth; apps/agent-api/src/auth.ts; apps/agent-api/src/email-transport.ts; docs/data-studio/PLAN.md. |
| D5 | Public Project API gateway, keys, RLS transaction context, SDK, CORS/rate limit; apps/agent-api/src/app.ts; apps/agent-api/src/project-preview-routes.ts; docs/data-studio/PLAN.md. |
| D6 | mobile_app enum/migration, Expo template/preview через sandbox proxy, SDK secure token storage; packages/workspace/src/types.ts; apps/agent-api/src/sandbox-provider.ts; apps/agent-api/src/project-preview-service.ts; docs/data-studio/PLAN.md. |
| D7 | dev/prod promote/approval, real dump/restore, quotas, external provider, lifecycle/drift remediation; apps/agent-api/src/approvals-repository.ts; apps/agent-api/src/telemetry-backups-and-session-search.ts; docs/data-studio/PLAN.md. |

D1 може спиратися на ці перевірені файли й рішення. D1 не розпочато. current-state.md лишається без змін, бо критерій D0 прямо дозволяє змінити лише 00-audit.md (docs/data-studio/PLAN.md; docs/data-studio/current-state.md).
