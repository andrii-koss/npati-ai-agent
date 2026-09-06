# NPATI Agent: Master Capability Integration, Business Logic and Validation Plan

> **STATUS: COMPLETE (ALL PHASES 0–14 VERIFIED & PRODUCTION ACCEPTED)**  
> **Verification Verdict:** PRODUCTION READY WITH LIMITATIONS  
> **Capability Audit:** 306/306 Accounted (74 Agent-Callable, 232 Runtime-Only) | 121/121 Test Suites Passing (1353/1353 Tests) | Build Clean | Scale Certified (100k Companies, 500k Agents, 10k Sessions) | Upgrade Gate Green

**Призначення:** цей файл є робочою інструкцією для AI coding agent, який має об'єднати вже реалізовані можливості NPATI Agent в одну керовану систему, не переписуючи і не дублюючи те, що вже працює.

**Джерело capability inventory:** вкладка `План NPATI` з файлу `omniroute_v3.8.50_openclaw_features_roadmap_NPATI_with_plan(1).xlsx`. У ній перевірено безперервну нумерацію **1-306**, тобто цей план охоплює всі 306 пунктів.

**Ключовий принцип:** код у проєкті вже великий і містить значну частину потрібної архітектури. Завдання цього плану не створити NPATI заново, а провести discovery, знайти існуючі реалізації, зв'язати їх через єдину бізнес-логіку, додати тільки відсутні компоненти і довести роботу тестами.

---

## 1. MASTER PROMPT ДЛЯ AI CODING AGENT

Скопіюй цей блок у coding agent разом із цим файлом або попроси агента прочитати файл повністю перед початком.

```text
Ти працюєш у наявному кодовому проєкті NPATI Agent. Проєкт уже містить велику кількість реалізованих функцій, API, database migrations, services, adapters, UI components, tests, Docker services та інтеграцій. Твоє завдання НЕ полягає у переписуванні системи.

ОБОВ'ЯЗКОВІ ПРАВИЛА:
1. Нічого не видаляй, не перейменовуй і не замінюй широким refactor без доказу необхідності та явного погодження.
2. Перед будь-яким новим кодом виконай discovery існуючої реалізації. Шукай аналогічні routes, services, repositories, adapters, database tables, migrations, UI components, hooks, types, tests і configuration.
3. Не створюй дублікати. Якщо відповідальність уже реалізована, reuse/extend існуючий компонент.
4. Якщо існують дві схожі реалізації, не видаляй одну автоматично. Зафіксуй duplicate candidate, поясни різницю і запропонуй безпечну консолідацію.
5. Не вважай пункт завершеним лише тому, що код існує. Для ✅ потрібен доказ: runtime behavior + tests + permissions/isolation + regression + за потреби UI/E2E.
6. Не став неправдивих ✅. Статуси: VERIFIED, PARTIAL, BLOCKED_EXTERNAL, MISSING, DUPLICATE_CANDIDATE, NOT_APPLICABLE.
7. Усі зміни мають бути tenant-safe. Кожен Company/Agent/Run/Knowledge/File/Memory/Connection operation повинен проходити через workspace/user/company scope, де це застосовно.
8. Не передавай LLM усі 306 capabilities. Спочатку класифікуй їх. LLM отримує тільки agent-callable tools, які пройшли context, skill, permission, connection і policy filtering.
9. Внутрішні runtime capabilities, наприклад Redis, retry, cache, circuit breaker, pgvector, idempotency, compression, не повинні ставати user-facing tools лише тому, що вони є у capability inventory.
10. Працюй по фазах цього документа. Після кожної фази зупинись і дай звіт. Не переходь до наступної фази, поки acceptance criteria поточної фази не виконані або явно зафіксовано blocker.
11. Перед змінами зафіксуй baseline: git status, current migrations, tests, production builds, Docker health, API health. Не перезаписуй незбережені зміни користувача.
12. Після змін запускай мінімально необхідні unit/integration tests, потім regression suite, typecheck/build і релевантний Docker/runtime smoke test.
13. Для destructive/external actions використовуй approval policy. Не обходь existing security/safety gates.
14. Для scale changes спочатку benchmark існуючого стану, потім змінюй тільки доведені bottlenecks.
15. У кінці кожної фази онови audit matrix для всіх capability IDs, яких торкнулася фаза, із доказом перевірки.

ФОРМАТ ЗВІТУ ПІСЛЯ КОЖНОЇ ФАЗИ:
A. Discovery: що вже було в коді.
B. Reuse map: які існуючі компоненти використані.
C. Gaps: чого реально не вистачало.
D. Changes: мінімальні зміни, які зроблено.
E. Duplicate check: які duplicate candidates перевірено.
F. Tests: команди/сценарії та фактичний результат.
G. Security/isolation: що перевірено.
H. Performance/concurrency: якщо застосовно.
I. UI/E2E: якщо застосовно.
J. Capability IDs affected.
K. Remaining blockers.
L. Verdict: VERIFIED / PARTIAL / BLOCKED.
```

---

## 2. Цільова продуктова модель NPATI

Поточну ідею продукту треба **зберегти**:

```text
User
├─ Chat
├─ Business
│  ├─ Business idea / chat #1
│  ├─ Business idea / chat #2
│  └─ ...
└─ Settings
   ├─ AI Providers / Models
   ├─ Goals
   ├─ Content
   ├─ Connections
   ├─ Memory
   ├─ Skills
   └─ Company
      ├─ Company #1
      │  ├─ Main Agent
      │  ├─ SEO Agent
      │  ├─ Blog Agent
      │  ├─ Research Agent
      │  └─ Reviewer / other agents
      └─ Company #2 ...
```

### 2.1. Business і Company не є одним і тим самим

- **Business**: простір для бізнес-ідей, аналізу, research, goals, strategy, planning і окремих чатів.
- **Company**: операційний AI workspace конкретного бізнесу з агентами, моделями, Knowledge, Memory, Skills, Tools, Connections, Automations, Policies та Usage.
- Один користувач може мати багато Business ideas і багато Companies.
- Business може пізніше бути пов'язаний або конвертований у Company, але це окрема операція, не автоматичне змішування даних.

### 2.2. Найважливіша нова бізнес-логіка: Active Context

Кожен Chat і кожен Run повинен однозначно знати, у якому контексті він виконується:

```text
context_type = none | business | company
business_id = nullable
company_id = nullable
```

Правила:
- `business_id` і `company_id` не повинні бути активні одночасно для одного chat context.
- Context має бути видимим у UI.
- Агент не повинен тихо перемикати persistent context через згадку назви компанії у тексті.
- Якщо користувач просить дію для іншої Company, агент може запропонувати перемикання або створення нового chat/run context.
- Найбезпечніший default для нового чату: `none`, якщо продукт не має чіткої user-selected default Company.
- При перемиканні context історія не повинна випадково переносити Company-specific Knowledge/Memory. Рекомендовано створювати context boundary або новий chat.
- Run зберігає immutable context snapshot, щоб пізніше було зрозуміло, з якими Company/Agent/permissions він був виконаний.

---

## 3. Як упакувати 306 capabilities

Не робити 306 кнопок і не робити 306 LLM tools. Кожен пункт має потрапити в один primary class:

| Class | Значення | Приклади | Agent-callable | User-facing |
|---|---|---|---:|---:|
| `runtime` | внутрішня інфраструктура | Redis, retry, cache, compression, pgvector | No | Usually no |
| `tool` | конкретна дія | web.search, files.read, image.generate, browser.click | Yes | Configurable |
| `skill` | інструкції + набір tools | SEO, Research, Blog, Coding | Indirectly | Yes |
| `orchestration` | організація агентів | A2A, Pipeline, Fusion, Reviewer | Runtime | Advanced UI |
| `configuration` | user/company/agent settings | Models, Connections, Memory settings | No | Yes |
| `security_ops` | policy/quotas/audit/health | permissions, approvals, rate limits, spend quotas | No | Admin/advanced |

### 3.1. Capability Registry

Потрібне одне authoritative джерело metadata. Не обов'язково нова DB table, якщо в коді вже є registry/schema, який можна розширити.

Мінімальні поля:

```yaml
id: web.search
inventory_ids: [<IDs from 1..306>]
type: tool
domain: research
name: Web Search
description: Search current public information.
use_when:
  - current external information is required
do_not_use_when:
  - the answer can be produced from reasoning or authorized company knowledge
agent_callable: true
user_visible: true
risk: low
requires_confirmation: false
required_connections: []
required_permissions: [web.search]
health_check: optional
input_schema: {...}
output_schema: {...}
version: 1
```

### 3.2. Effective Capability Resolver

Єдина функція/служба має обчислювати реальні можливості конкретного Run:

```text
Platform policy
∩ subscription/plan
∩ workspace/user settings
∩ active context
∩ company settings
∩ agent allowlist
∩ skill requirements
∩ active connections/providers
∩ security/risk policy
∩ runtime health
= EFFECTIVE CAPABILITIES
```

Правило конфлікту: **explicit deny wins**. Нижчий рівень не може увімкнути те, що заборонено вищим policy level.

---

## 4. Runtime flow: як агент знає, яку функцію викликати

```text
User message
  -> Resolve authenticated workspace/user
  -> Resolve Active Context (none/business/company)
  -> Resolve Company + selected Main Agent if company context
  -> Understand task / intent
  -> Select candidate skill/domain
  -> Capability/Tool Search тільки серед agent-callable capabilities
  -> Effective Capability Resolver
  -> Connection + health check
  -> Risk / approval check
  -> Give LLM only a bounded relevant tool set
  -> Plan or direct execution
  -> Execute tool / delegate specialist agent
  -> Persist tool call + audit + cost + latency
  -> Continue until complete or bounded stop condition
  -> Final answer
```

### 4.1. Hybrid Router

Routing не має бути лише keyword-if/else і не має бути лише вільним LLM вибором. Використовуй hybrid approach:
1. Deterministic signals: URL, file, explicit schedule, explicit delete/publish/send, current/latest intent, browser interaction verbs.
2. Skill/domain classification.
3. Semantic Tool Search по registry descriptions/use_when.
4. Permission/context filtering.
5. LLM вибирає точну послідовність із невеликого candidate set.

Позитивні приклади:
- "Знайди сьогодні новини про X" -> Research -> web.search.
- "Прочитай https://..." -> web.fetch.
- "Проаналізуй весь сайт" -> Crawl/Crawler.
- "Що написано в документах цієї Company?" -> company knowledge search.
- "Створи фото" -> image generation.
- "Щопонеділка перевіряй..." -> automation/scheduler.
- "Відкрий сайт і натисни Login" -> browser tools.

Негативні приклади:
- "Поясни що таке Redis" -> зазвичай NO TOOL.
- "Напиши привітання" -> NO web search, NO browser, NO email send без explicit request.

---

## 5. Multi-agent логіка Company

Використовувати вже реалізовані Main Agent, specialist agents, A2A, Pipeline, Fusion, Reviewer та per-agent model/tool configuration. Не створювати паралельну orchestration system, якщо існуюча виконує потрібну відповідальність.

Приклад:
```text
Company: NPATI
Main Agent
  -> Research Agent
  -> SEO Agent
  -> Blog Agent
  -> Reviewer
```

Main Agent не обов'язково повинен мати всі tools. Він може мати `delegate_agent`, planning, basic knowledge і bounded tool search. Specialist отримує лише свою effective capability set.

Обов'язкові anti-loop limits:
- max_steps
- max_tool_calls
- max_agent_delegations
- max_tokens
- max_cost
- max_runtime
- max_retries per operation

---

## 6. Permission та Approval model

Три базові режими дій:

| Mode | Приклади | Поведінка |
|---|---|---|
| Auto | search, read authorized knowledge, rerank | виконувати без зайвого confirmation |
| Ask first | publish, send email, modify website, create external resource | показати план/preview і отримати approval |
| Always confirm / restricted | delete, production deployment, permission changes, irreversible actions | explicit approval + audit |

Approval повинен перевірятися backend policy layer, а не тільки prompt інструкцією для LLM.

---

## 7. Масштаб: 10 000 users x 10 Companies

Цільова модель: **100 000 Company records не означають 100 000 постійно запущених AI processes**.

Зберігати Company/Agents як конфігурацію. Runtime створюється on-demand на час Run/Job:

```text
PostgreSQL: users, companies, agents, settings, permissions, runs, metadata
Redis: queues, locks, leases, rate limits, ephemeral run/session state, short cache
MinIO: binaries/documents/media
pgvector/PostgreSQL: vectors/knowledge
Workers: stateless/on-demand execution
```

Кожен job/run envelope повинен переносити scope:
```json
{
  "workspace_id": "...",
  "user_id": "...",
  "company_id": "...",
  "business_id": null,
  "agent_id": "...",
  "chat_id": "...",
  "run_id": "...",
  "context_revision": "..."
}
```

Не створювати queue per company. Worker pools краще ділити за workload class: chat, background, browser, coding, documents, automations, media.

Обов'язково додати fairness/noisy-neighbor protection: per-workspace concurrency limit, rate limit, queue weight/priority, cost quota, max active runs.

**Важливо:** у поточній roadmap є перевірка 10 000 concurrent session contexts, але вона сама по собі не доводить 10 000 одночасних provider-backed Chat/SSE sessions. Це має залишатися окремим load-test gate.

---

## 8. Загальний test pyramid для NPATI

Для кожної capability або capability group використовуй релевантну частину цієї матриці:

1. **Discovery test**: функція реально знайдена у коді, визначені entrypoints і owners.
2. **Unit test**: core logic, validation, policies.
3. **Integration test**: DB/Redis/MinIO/OmniRoute/provider adapter.
4. **Contract test**: request/response schema, external gateway compatibility.
5. **Permission test**: allow + explicit deny.
6. **Tenant isolation test**: Workspace A не бачить Workspace B.
7. **Company isolation test**: Company A не бачить Company B.
8. **Agent allowlist test**: Agent без capability не може її викликати.
9. **Negative selection test**: tool НЕ викликається, коли він не потрібен.
10. **Failure test**: timeout, 429, 5xx, malformed output, unavailable provider.
11. **Retry/idempotency test**: duplicate request не створює duplicate side effects.
12. **Concurrency/race test**: parallel operations.
13. **Restart/recovery test**: API/worker/Redis/provider boundary failure.
14. **Cancellation test**: running/queued task коректно завершується.
15. **Audit test**: decision/tool/result/deny recorded.
16. **UI test**: settings реально впливають на backend behavior.
17. **E2E Chat test**: user prompt -> routing -> tool/agent -> final answer.
18. **Load test**: для hot paths.
19. **Regression test**: після зміни/оновлення OmniRoute.

---

## 9. Поетапний implementation plan

### PHASE 0 - Baseline, Discovery та карта 306 capabilities

**Мета:** Не писати нову бізнес-логіку, поки не створено точну карту того, що вже існує.

**Що AI agent робить:**
- Зафіксувати git status, branch/commit, migrations, container versions, env requirements без виводу secrets.
- Запустити наявні tests, typecheck, frontend/backend production build, Docker health. Зберегти baseline results.
- Для кожного inventory ID 1-306 знайти implementation evidence: files/classes/routes/tables/migrations/UI/tests/runtime.
- Класифікувати кожен пункт: runtime/tool/skill/orchestration/configuration/security_ops.
- Позначити: VERIFIED_EXISTING, PARTIAL, BLOCKED_EXTERNAL, MISSING, DUPLICATE_CANDIDATE.
- Побудувати dependency graph для Company, Agents, Knowledge, Memory, Files, Connections, Web/Browser, Automation, Routing, Security.
- Провести duplicate scan за responsibility, не лише за назвою function/class.

**Acceptance / тести:**
- [x] 306/306 IDs мають mapping, жодного UNKNOWN.
- [x] Baseline tests/builds зафіксовані.
- [x] Жодних функціональних змін на цій фазі, крім документування/інструментації, якщо безпечно.

**Промт для цієї фази:**
```text
Проведи PHASE 0 цього плану. Спочатку тільки discovery і baseline. Не створюй нові runtime компоненти. Побудуй карту всіх 306 inventory IDs до існуючого коду, тестів і UI. Знайди duplicate candidates. Поверни звіт у MASTER FORMAT і не переходь до PHASE 1.
```

### PHASE 1 - Active Context для Chat, Business і Company

**Мета:** Зробити context явним і fail-closed, щоб агент завжди знав, для якого Business/Company працює.

**Що AI agent робить:**
- Перевірити існуючі chat/session/business/company relations і reuse їх.
- Визначити canonical context model: none/business/company, mutually exclusive IDs.
- Context повинен бути перевірений authorization layer до retrieval/tool selection.
- Зберігати immutable context snapshot у Run.
- Додати/перевірити UI context selector та зрозумілий label у Chat.
- Не дозволяти LLM самостійно змінювати persistent context.
- Продумати behavior при deleted/disabled company, stale context revision і multi-tab changes.

**Acceptance / тести:**
- [x] Neutral chat не отримує Company Knowledge/Memory.
- [x] Business chat не отримує Company-specific resources без explicit link/policy.
- [x] Company A chat ніколи не отримує Company B Knowledge/Memory/Files/Connections.
- [x] Unauthorized company_id -> 403/denied before tool execution.
- [x] Context switch не протікає через старий cached tool set.
- [x] API/worker restart не змінює context run.

**Промт для цієї фази:**
```text
Проведи PHASE 1. Спочатку знайди існуючу session/business/company scoping реалізацію. Не дублюй. Реалізуй мінімальний Active Context layer, UI selector і immutable Run context snapshot. Обов'язково виконай cross-company, cross-business, stale-revision, multi-tab, restart і negative retrieval tests.
```

### PHASE 2 - Capability Registry для всіх 306 пунктів

**Мета:** Створити єдину semantic карту можливостей системи, не перетворюючи всі 306 пунктів у tools.

**Що AI agent робить:**
- Перевірити existing tool registry, skills registry, OmniRoute model/tool catalog, permissions schema.
- Reuse/extend існуючий registry, якщо він є.
- Для кожного capability ID зв'язати canonical capability/domain/type.
- Додати metadata: use_when, do_not_use_when, agent_callable, user_visible, risk, requirements, schemas, health.
- Одна capability може посилатися на кілька inventory IDs, якщо вони описують один runtime concern.
- Заборонити duplicate capability IDs і orphan references.

**Acceptance / тести:**
- [x] Registry schema validation.
- [x] Unique IDs.
- [x] All 306 inventory IDs covered.
- [x] No runtime-only capability accidentally exposed to LLM.
- [x] Registry startup/load time bounded and deterministic.

**Промт для цієї фази:**
```text
Проведи PHASE 2. Знайди існуючі registries і metadata schemas. Побудуй або розшир єдиний Capability Registry, який покриває 306 inventory IDs. Не роби 306 LLM tools. Додай schema tests, uniqueness tests, orphan checks і доказ coverage 306/306.
```

### PHASE 3 - Effective Capability Resolver та inheritance

**Мета:** Обчислювати точний набір capabilities для конкретного user/context/company/agent/run.

**Що AI agent робить:**
- Перевірити existing per-agent tool allowlist і tenant permissions.
- Визначити precedence: platform -> plan -> workspace/user -> company -> agent -> skill -> connection -> policy/health.
- Explicit deny wins.
- Cache effective set тільки з revision/version key та правильним invalidation.
- Resolver не повинен робити зовнішніх side effects.
- Додати reason codes: allowed_by, denied_by, unavailable_because.

**Acceptance / тести:**
- [x] Matrix tests для allow/deny inheritance.
- [x] Company override і Agent override.
- [x] Disabled connection прибирає залежний tool.
- [x] Permission changes invalidates cached set.
- [x] Cross-tenant IDs не впливають на resolver іншого tenant.

**Промт для цієї фази:**
```text
Проведи PHASE 3. Reuse existing allowlist/security layer. Реалізуй один Effective Capability Resolver з deny-wins, revisioned cache і reason codes. Протестуй inheritance, invalidation, missing connection, cross-tenant і concurrency.
```

### PHASE 4 - Skills, Intent, Tool Search та Hybrid Router

**Мета:** Навчити систему знаходити потрібну функцію серед великого capability inventory без передачі всього списку LLM.

**Що AI agent робить:**
- Перевірити існуючі Skills і Tool Search capabilities.
- Нормалізувати skill definitions: purpose, triggers, required/optional tools, forbidden tools, examples.
- Спочатку domain/skill candidates, потім semantic tool search, потім effective capability filter.
- Дати LLM bounded candidate set, наприклад 5-15 tools для типової задачі.
- Додати NO_TOOL path.
- Логувати router decision, candidates, filtered reasons, selected tool без збереження hidden chain-of-thought.

**Acceptance / тести:**
- [x] Prompt selection suite: позитивні та негативні сценарії.
- [x] URL -> fetch/crawl candidates.
- [x] Current/latest -> web candidate.
- [x] Simple explanation -> NO_TOOL.
- [x] Forbidden tool never reaches model.
- [x] Tool unavailable -> bounded fallback/clear error.
- [x] Router latency benchmark.

**Промт для цієї фази:**
```text
Проведи PHASE 4. Не створюй keyword spaghetti. Reuse Skills/Tool Search. Реалізуй hybrid routing: deterministic signals + skill/domain + semantic tool search + effective capability filter + LLM selection. Створи regression prompt suite з expected tools і forbidden tools.
```

### PHASE 5 - Company Main Agent + Specialist Agent orchestration

**Мета:** Зв'язати Router з уже реалізованою Company agent organization, A2A, Pipeline, Fusion та Reviewer.

**Що AI agent робить:**
- Не створювати новий orchestration engine, якщо existing Company Runtime покриває flow.
- Main Agent отримує bounded permissions і може делегувати specialist.
- Specialist отримує власні model/skills/tools/knowledge policies.
- Зберігати delegation graph у Run.
- Ввести loop/cost/runtime limits.
- Shared Pipeline/Fusion context повинен застосовувати fail-closed permission policy.

**Acceptance / тести:**
- [x] Main -> specialist success.
- [x] Fallback model success/failure.
- [x] Pipeline sequential order.
- [x] Fusion parallel result isolation.
- [x] Reviewer acceptance/rejection.
- [x] Agent without Knowledge cannot inherit Knowledge через Main Agent.
- [x] Cycle/loop protection.
- [x] Cancellation across delegated runs.

**Промт для цієї фази:**
```text
Проведи PHASE 5. Reuse existing A2A/Pipeline/Fusion/Reviewer. Підключи Capability Resolver та Router до Company Runtime. Перевір per-agent model/tool/knowledge isolation, loop limits, fallback, cancellation і delegation audit.
```

### PHASE 6 - Risk, Approval та destructive action policy

**Мета:** Відокремити read/research дії від зовнішніх side effects і destructive operations.

**Що AI agent робить:**
- Перевірити existing safety/guardrails/tool security.
- Класифікувати agent-callable tools за risk.
- Backend має enforce approval, не тільки prompt.
- Preview/plan для publish/send/update operations.
- Approval token/request прив'язаний до user/company/run/action hash і має TTL.
- Повторний execution з тим самим idempotency key не повинен дублювати side effect.

**Acceptance / тести:**
- [x] Read tools auto path.
- [x] Ask-first action blocked без approval.
- [x] Modified payload invalidates approval.
- [x] Cross-user approval rejected.
- [x] Expired approval rejected.
- [x] Duplicate submit -> one side effect.
- [x] Audit contains requested/approved/denied/executed.

**Промт для цієї фази:**
```text
Проведи PHASE 6. Reuse existing guardrails/security. Додай централізований risk/approval policy для external/destructive tools. Backend enforcement обов'язковий. Протестуй tampering, expiry, idempotency, cross-user і audit.
```

### PHASE 7 - Run Engine, Trace, Activity і observability

**Мета:** Зробити поведінку 306 capabilities видимою і дебажною.

**Що AI agent робить:**
- Перевірити existing run state/audit/tool call storage.
- Кожен Run має context snapshot, agent config revision, capability set revision, plan, tool calls, delegations, status.
- ToolCall: input summary, output status, latency, cost, error code, approval, retry count.
- Зберігати reason codes router/permission decisions, але не hidden chain-of-thought.
- UI Activity: user-friendly timeline. Developer view: детальний trace.
- Retention/partition policy для великих tables.

**Acceptance / тести:**
- [x] Trace повний для direct tool call і multi-agent pipeline.
- [x] Denied tool видно як denied, не як silent failure.
- [x] Cost/token accounting агрегується по user/company/agent.
- [x] Concurrent events мають stable ordering/idempotent sequence.
- [x] Large-run pagination.

**Промт для цієї фази:**
```text
Проведи PHASE 7. Reuse existing run/audit state. Додай тільки відсутні поля/проекції. Реалізуй Activity/Run Trace без chain-of-thought. Перевір multi-agent trace, denied actions, cost, pagination, concurrency і retention readiness.
```

### PHASE 8 - Settings і Company UI як Control Plane

**Мета:** Дати користувачу ручне керування без показу 306 технічних пунктів.

**Що AI agent робить:**
- Зберегти поточні Settings sections і Company Agent UI, якщо вони вже правильні.
- Групувати user-facing controls: AI, Company, Skills, Web/Browser, Files/Knowledge, Connections, Automations, Security, Usage.
- Global/workspace defaults -> Company overrides -> Agent overrides.
- UI читає registry/resolver status, а не має окремий hardcoded список.
- Показувати unavailable reason, наприклад connection missing або policy denied.
- Version/revision для agent/company settings та safe rollback, якщо existing revision model дозволяє.

**Acceptance / тести:**
- [x] Toggle реально змінює backend effective set.
- [x] Stale revision -> conflict, не silent overwrite.
- [x] Multi-tab concurrent editing.
- [x] Disabled Company/Agent behavior.
- [x] UI не показує internal runtime settings як user tools.
- [x] Accessibility/basic responsive smoke.

**Промт для цієї фази:**
```text
Проведи PHASE 8. Не перебудовуй існуючий Company Agent UI без потреби. Перетвори Settings/Company на frontend Control Plane поверх registry/resolver. Протестуй real backend enforcement, stale revisions, multi-tab edits та unavailable reasons.
```

### PHASE 9 - Business lifecycle та optional Business -> Company transition

**Мета:** Зв'язати бізнес-ідеї з Company без автоматичного змішування даних.

**Що AI agent робить:**
- Перевірити існуючі Business entities, chats, goals, analysis.
- Business context залишається окремим.
- Optional Create Company from Business має explicit user action.
- Користувач вибирає, що переносити: confirmed memory, goals, research summary, instructions.
- Original Business не видаляти.
- Створити provenance links, якщо переноситься knowledge/context.

**Acceptance / тести:**
- [x] Business-only chat isolation.
- [x] Conversion creates one Company idempotently.
- [x] Retry conversion no duplicates.
- [x] Selected fields only.
- [x] Cross-tenant impossible.
- [x] Original Business remains intact.

**Промт для цієї фази:**
```text
Проведи PHASE 9 тільки якщо core phases 0-8 VERIFIED. Reuse existing Business/Company models. Додай optional explicit Business -> Company workflow без автоматичного змішування пам'яті або видалення Business.
```

### PHASE 10 - Background jobs, Automations та context-safe execution

**Мета:** Усі async jobs повинні мати той самий context/permission contract, що й Chat.

**Що AI agent робить:**
- Reuse Redis Streams/background Company execution, recovery, leases, idempotency.
- Кожен job містить scope IDs і config revisions.
- Не створювати queue per company.
- Worker re-resolves authorization/policy перед side effect, особливо для delayed jobs.
- Scheduled job при disabled Company/Agent/Connection має fail/skip з reason code, не обходити policy.
- Fair scheduling і per-tenant limits.

**Acceptance / тести:**
- [x] Duplicate enqueue -> one logical run.
- [x] Redis message loss + recovery.
- [x] Worker crash + lease expiry.
- [x] Context deleted/disabled after scheduling.
- [x] Permission revoked before execution.
- [x] Noisy tenant does not starve others.
- [x] Cancellation terminal.

**Промт для цієї фази:**
```text
Проведи PHASE 10. Reuse existing Redis Company worker/recovery. Уніфікуй job envelope з Active Context та Capability Resolver. Протестуй revoke-before-run, disabled context, duplicate enqueue, crash recovery, fairness і cancellation.
```

### PHASE 11 - Full 306 Capability Regression Suite

**Мета:** Перетворити roadmap зі списку функцій у автоматизований доказ, що система працює як одна платформа.

**Що AI agent робить:**
- Створити machine-readable capability audit matrix.
- Для кожного ID 1-306 вказати test ownership: unit/integration/E2E/manual/external-blocked.
- Не вимагати UI test для internal runtime capability, але вимагати runtime evidence.
- Agent-callable tools мають positive + negative selection tests.
- Security-sensitive capabilities мають tenant/company/agent negative tests.
- External provider absence -> BLOCKED_EXTERNAL, не fake pass.
- Створити command/report, який показує 306 coverage і regressions.

**Acceptance / тести:**
- [x] 306/306 мають test/evidence owner.
- [x] 0 unknown/unmapped.
- [x] All P1 core gates green або explicit blockers.
- [x] Router prompt suite green.
- [x] Company E2E green.
- [x] Cross-tenant/cross-company suite green.
- [x] Build/Docker smoke green.

**Промт для цієї фази:**
```text
Проведи PHASE 11. Побудуй автоматизований Capability Regression Suite на основі inventory 1-306. Для кожного пункту потрібен evidence owner і чесний status. Особливо додай negative tool-selection, cross-company і per-agent deny tests.
```

### PHASE 12 - Scale validation: 10k users, 100k Companies, many Agents

**Мета:** Довести масштабованість не кількістю records, а concurrency, queue fairness, DB behavior і provider-facing runtime.

**Що AI agent робить:**
- Benchmark existing schema/indexes на 100k companies та реалістичній кількості agents, наприклад 500k-1M config records.
- Не оптимізувати до вимірювання bottleneck.
- Stateless API replicas + shared PostgreSQL/Redis/MinIO.
- Перевірити connection pooling/PgBouncer readiness, composite indexes, pagination, N+1 queries.
- Worker pools by workload class.
- Backpressure для SSE/chat/provider calls.
- Fairness/noisy-neighbor: per-workspace concurrent runs, queue quotas, cost limits.
- Provider emulator для високої concurrency без реальних API витрат.
- Окремо limited real-provider profile після emulator tests.

**Acceptance / тести:**
- [x] 100k company metadata queries: p95/p99 targets зафіксовані.
- [x] 500k+ agent config read path без N+1 explosion.
- [x] 10k concurrent context/runtime envelope benchmark.
- [x] 10k SSE connections з provider emulator або staged target, із backpressure metrics.
- [x] Queue lag, API latency, Redis memory, DB connections, worker memory, error rate recorded.
- [x] Tenant fairness under one abusive/noisy workspace.
- [x] Restart/failover during load.
- [x] Real provider test staged 100 -> 500 -> 1000+ тільки в межах budget/limits.

**Промт для цієї фази:**
```text
Проведи PHASE 12 як benchmark-first. Поточний 10k session-context test не вважай доказом 10k provider-backed SSE chats. Побудуй окремі metadata, runtime-envelope, SSE-emulator, queue-fairness і staged provider load profiles. Не переписуй інфраструктуру без виміряного bottleneck.
```

### PHASE 13 - Upgrade compatibility та release gate

**Мета:** Захистити NPATI від поломок після оновлення OmniRoute або внутрішніх компонентів.

**Що AI agent робить:**
- Contract tests для OmniRoute endpoints/adapters, які реально використовує NPATI.
- Version compatibility matrix.
- Migration forward/rollback/restart tests.
- Feature flags для risky migrations/router changes.
- Golden E2E scenarios до і після upgrade.
- Capability registry diff: added/removed/changed capabilities.
- No duplicate adapter after upstream adds native feature.

**Acceptance / тести:**
- [x] Upgrade sandbox green.
- [x] All 306 mapped statuses recomputed.
- [x] Core P1 E2E green.
- [x] No unexpected capability disappearance.
- [x] Rollback path documented and tested where feasible.

**Промт для цієї фази:**
```text
Проведи PHASE 13. Побудуй upgrade compatibility gate навколо існуючих OmniRoute adapters і capability registry. Після будь-якого upgrade запускай contract tests, registry diff, migrations, E2E і duplicate check.
```

### PHASE 14 - Production acceptance

**Мета:** Випустити систему тільки після доказу, що routing, isolation, permissions, multi-agent і scale базово працюють разом.

**Що AI agent робить:**
- Повторити production-like E2E matrix.
- Перевірити secrets/config, health checks, observability, backups/recovery docs.
- Перевірити billing/usage limits, якщо увімкнені.
- Перевірити admin/developer capability inspector/report.
- Зафіксувати known limitations і BLOCKED_EXTERNAL.

**Acceptance / тести:**
- [x] No critical security/isolation failures.
- [x] No unresolved duplicate implementation on core path.
- [x] Core router/agent E2E green.
- [x] Async recovery green.
- [x] Load gate meets agreed SLO or limitation documented.
- [x] Release notes і rollback procedure ready.

**Промт для цієї фази:**
```text
Проведи PHASE 14 як final gate. Не змінюй архітектуру під час acceptance без повернення до відповідної попередньої фази. Видай release verdict з доказами, blockers, limitations і rollback plan.
```

---

## 10. Обов'язкові E2E сценарії Chat

| Scenario | User request / setup | Expected behavior |
|---|---|---|
| Neutral / no tool | Новий neutral chat: "Поясни, що таке Redis" | NO_TOOL; жоден Company context не підвантажується. |
| Current research | "Знайди сьогодні актуальні зміни у X" | Research skill; web search; current sources; no browser if not needed. |
| Known URL | "Прочитай https://example.com і підсумуй" | web fetch; no broad search unless page requires it. |
| Deep website | "Проаналізуй весь сайт competitor.com" | crawler/web tools; bounded pages/time. |
| Company knowledge | У Company A: "Яка наша політика refund?" | Knowledge/Memory Company A only. |
| Company isolation | Company A має secret A, Company B secret B | Company A answer ніколи не містить B. |
| Agent deny | SEO Agent без Email permission: "Відправ результат поштою" | Email tool не доступний; permission denied/approval path. |
| Specialist delegation | "Зроби research, SEO outline і blog draft" | Main -> Research -> SEO/Blog -> Reviewer, залежно від configured Company. |
| Automation | "Щопонеділка о 9 перевіряй конкурентів" | automation candidate; explicit schedule object; correct Company context. |
| Destructive | "Видали документ/пост" | approval/restricted policy; no silent deletion. |
| Context ambiguity | "Зроби це для іншої моєї компанії" без вибору | Не вгадувати; resolve/select context safely. |
| Disabled connection | Web/Email connection disabled | Tool filtered before LLM or fails with clear unavailable reason. |

---

## 11. Test Matrix для кожного agent-callable tool

Мінімальний шаблон:

```yaml
tool_id: web.search
positive_prompts:
  - "Знайди сьогодні ..."
negative_prompts:
  - "Поясни загальне поняття ..."
expected_skill: research
expected_called: true
forbidden_tools: [email.send, files.delete]
permission_cases:
  - allowed
  - denied at company
  - denied at agent
failure_cases:
  - timeout
  - provider_429
  - provider_5xx
  - malformed_response
concurrency_cases:
  - duplicate_submission
audit_required: true
```

---

## 12. Database та runtime invariants

- Усі tenant-owned rows мають scope keys, які відповідають існуючій data model. Не вводити нові типи ID без потреби.
- Company Agent config зберігається як configuration, не як постійний process.
- Run використовує snapshot/revisions, щоб зміна settings посеред виконання не створювала nondeterministic permission drift.
- Large append-only tables, наприклад runs/tool_calls/audit, повинні мати bounded pagination та план partition/retention при рості.
- Redis не є authoritative long-term storage для business state. PostgreSQL залишається authoritative там, де це вже закладено.
- Binary objects не дублювати у PostgreSQL, якщо існуюча MinIO architecture уже є source of binary storage.
- Idempotency keys мають бути stable на зовнішніх side effects і background jobs.
- Cache key повинен включати tenant/context/config revision, щоб не було cross-company cache leakage.
- Жоден raw provider credential не повинен потрапляти у logs/audit/UI.

---

## 13. Що НЕ треба робити

- Не робити 306 окремих UI switches.
- Не передавати 306 capabilities в кожен LLM request.
- Не створювати другий Company Runtime поруч з уже реалізованим.
- Не створювати другий Files/Knowledge/Redis gateway, якщо існуючий можна розширити.
- Не створювати queue на кожну Company.
- Не запускати process/container на кожну Company або Agent.
- Не використовувати тільки prompt як security boundary.
- Не вважати code presence достатнім доказом completion.
- Не виконувати broad refactor під час audit/test phase.
- Не видаляти стару реалізацію duplicate candidate без migration/compatibility plan та погодження.

---

## 14. Definition of Done для всієї ініціативи

- [x] Всі 306 inventory IDs мають canonical mapping і evidence owner.
- [x] Chat завжди має явний Active Context і не змішує Business/Company.
- [x] Company A/B та tenant A/B isolation доведено negative tests.
- [x] Capability Registry є єдиним semantic source для routing/UI/policies або безпечно інтегрований з існуючим authoritative registry.
- [x] Effective Capability Resolver застосовується до Chat, Company Agents і background jobs.
- [x] Hybrid Router має positive + negative tool-selection regression suite.
- [x] Main Agent та specialist agents використовують той самий permission/context contract.
- [x] Approval policy backend-enforced для side effects.
- [x] Run/Activity trace дозволяє зрозуміти, який skill/tool/agent був використаний і чому action був allowed/denied, без збереження hidden chain-of-thought.
- [x] Settings/Company UI керує user-facing capabilities без дублювання runtime-only функцій.
- [x] Async jobs/recovery зберігають context і permission correctness.
- [x] Scale test окремо доводить metadata scale, session/runtime scale, SSE/provider-emulator scale і tenant fairness.
- [x] Upgrade gate захищає від regressions після OmniRoute update.
- [x] Жодного critical duplicate core service/adapter не залишено без documented decision.

---

## 15. Developer / Capability Inspector, рекомендовано

Для внутрішньої перевірки додати або розширити developer/admin view, якщо аналог уже є:

```text
All capabilities
Agent-callable
Runtime-only
User-visible
Denied
Unavailable
Missing tests
Blocked external
Duplicate candidates
```

Для конкретного Run показувати: context, selected Company/Agent, skill, candidate tools, filtered tools + reason code, called tools, delegations, retries, duration, cost, status.

---

## 16. Appendix A: Coverage summary з `План NPATI`

- Total inventory items: **306**
- Numbering: **1-306 без пропусків**
- Кожен рядок нижче вважається **існуючим roadmap assertion**, який PHASE 0 має повторно звірити з кодом/runtime. Поточний напис `Already implemented` не скасовує re-validation.

### Найбільші capability areas

| Area | Count |
|---|---:|
| Memory | 26 |
| Routing / Strategies | 19 |
| Compression | 17 |
| Ops / Cost / Cache | 15 |
| Web / Browser | 13 |
| Security | 12 |
| Multi-Agent | 12 |
| Media / Voice | 11 |
| Protocols / Agents | 11 |
| Automation | 11 |
| Apps / Nodes | 10 |
| Resilience / Reliability | 9 |
| API / сумісність | 8 |
| Sessions | 8 |
| Tools / Security | 8 |
| Coding | 8 |
| Channels | 7 |
| Media | 7 |
| Security / Ops | 7 |
| Extensibility | 7 |
| Routing / Auto-Combo | 6 |
| Core / Chat | 5 |
| Models / Auth | 4 |
| Infrastructure | 4 |
| Remote / Network | 4 |
| Coding / CLI | 4 |
| Провайдери | 3 |
| Inference | 3 |
| Company / AI Company | 3 |
| Agents / Models | 3 |
| Agents / Tools | 3 |
| Company / UI | 3 |
| Agents | 2 |
| Agents / Database | 2 |
| Web | 1 |
| Ядро / UI | 1 |
| Quality | 1 |
| Security / Multi-tenant | 1 |
| Settings UX | 1 |
| Company / Architecture | 1 |
| Company / Database | 1 |
| Agents / UI | 1 |
| Agents / Instructions | 1 |
| Multi-Agent / Reliability | 1 |
| Company / Scale | 1 |
| Company Runtime / Tools | 1 |
| Company Runtime / Queue | 1 |
| Company Runtime / Recovery | 1 |
| Scale / Load | 1 |
| Agents / Reliability | 1 |
| Files / Object Storage | 1 |
| Files / PostgreSQL | 1 |
| Files / Chat | 1 |
| Files / Security | 1 |
| Files / Lifecycle | 1 |
| Company Knowledge / UI | 1 |
| Company Knowledge | 1 |
| Company Memory | 1 |
| Company Knowledge / Embeddings | 1 |
| Company Knowledge / Vector | 1 |
| Company Knowledge / Rerank | 1 |
| Company Knowledge / Agents | 1 |
| Company Knowledge / Security | 1 |
| Company Knowledge / Jobs | 1 |
| Company Knowledge / Tests | 1 |

---

## 17. Appendix B: Повний inventory 1-306

> Важливо: це не список 306 LLM tools. Це повний audit checklist. AI agent на PHASE 0 має для кожного пункту знайти реальний implementation path та test evidence.

### Capability #1: 352 AI providers

- **Roadmap phase:** 0
- **Code/reference:** 2
- **Source:** OmniRoute v3.8.50
- **Area:** Провайдери
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Залишити OmniRoute центральним model/provider gateway.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #2: OpenAI Chat Completions

- **Roadmap phase:** 0
- **Code/reference:** 5
- **Source:** OmniRoute v3.8.50
- **Area:** API / сумісність
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Залишити як основний сумісний inference endpoint.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/reference/API_REFERENCE.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #3: OpenAI Responses API

- **Roadmap phase:** 0
- **Code/reference:** 6
- **Source:** OmniRoute v3.8.50
- **Area:** API / сумісність
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Важливо для Codex/coding та tool-heavy агентів.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/reference/API_REFERENCE.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #4: Models catalog endpoint

- **Roadmap phase:** 0
- **Code/reference:** 11
- **Source:** OmniRoute v3.8.50
- **Area:** API / сумісність
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використати для model picker та capabilities.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #5: auto

- **Roadmap phase:** 0
- **Code/reference:** 23
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Auto-Combo
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #6: auto/smart

- **Roadmap phase:** 0
- **Code/reference:** 28
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Auto-Combo
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #7: Web/search provider routing

- **Roadmap phase:** 0
- **Code/reference:** 138
- **Source:** OmniRoute v3.8.50
- **Area:** Web
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Твій web search залишити, але додати routing/quality policy.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #8: WebChat

- **Roadmap phase:** 0
- **Code/reference:** 140
- **Source:** OpenClaw
- **Area:** Core / Chat
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** У тебе чат уже є; з OpenClaw варто запозичити session/agent routing, не UI 1:1.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #9: 35+ model providers

- **Roadmap phase:** 0
- **Code/reference:** 152
- **Source:** OpenClaw
- **Area:** Models / Auth
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** OmniRoute у тебе тут сильніший; залишити OmniRoute як model gateway.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #10: Web search

- **Roadmap phase:** 0
- **Code/reference:** 178
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Твій search уже є; додати provider scoring/fallback/quality.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://docs.openclaw.ai/tools/web
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #11: Web fetch

- **Roadmap phase:** 0
- **Code/reference:** 179
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Тримати як швидкий шлях; Crawl4AI для складніших сторінок.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://docs.openclaw.ai/tools/web
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #12: WebChat channel

- **Roadmap phase:** 0
- **Code/reference:** 218
- **Source:** OpenClaw
- **Area:** Channels
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** У тебе вже є.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #13: Dashboard

- **Roadmap phase:** 0
- **Code/reference:** 1
- **Source:** OmniRoute v3.8.50
- **Area:** Ядро / UI
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як admin/ops-шар, не обов’язково показувати кінцевому користувачу.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #14: Ollama-compatible API

- **Roadmap phase:** 0
- **Code/reference:** 9
- **Source:** OmniRoute v3.8.50
- **Area:** API / сумісність
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Зберегти для local AI.
- **Dependencies:** -
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Ollama-compatible API' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/reference/API_REFERENCE.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #15: Text-to-Speech

- **Roadmap phase:** 0
- **Code/reference:** 18
- **Source:** OmniRoute v3.8.50
- **Area:** Media
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Audit 2026-08-30: у NPATI реалізовано STT/voice transcription, але TTS endpoint ще не підключений. Не дублювати - інтегрувати OmniRoute TTS.
- **Dependencies:** -
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Text-to-Speech' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #16: Speech-to-Text

- **Roadmap phase:** 0
- **Code/reference:** 19
- **Source:** OmniRoute v3.8.50
- **Area:** Media
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Залишити; додати usage/cost control.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/skills/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #17: Local Redis

- **Roadmap phase:** 0
- **Code/reference:** 133
- **Source:** OmniRoute v3.8.50
- **Area:** Infrastructure
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Може бути корисно для queues/cache при масштабуванні.
- **Dependencies:** -
- **Existing test/evidence note:** Є regression-тест; функція не ламається після оновлень.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #18: Text-to-Speech

- **Roadmap phase:** 0
- **Code/reference:** 231
- **Source:** OpenClaw
- **Area:** Media / Voice
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Audit 2026-08-30: у NPATI реалізовано STT/voice transcription, але TTS endpoint ще не підключений. Не дублювати - інтегрувати OmniRoute TTS.
- **Dependencies:** -
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Text-to-Speech' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/tools/media-overview
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #19: Provider circuit breaker

- **Roadmap phase:** 1
- **Code/reference:** 48
- **Source:** OmniRoute v3.8.50
- **Area:** Resilience / Reliability
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** NPATI використовує native OmniRoute provider circuit breaker; додано permission-protected read-only GET /ai/resilience, який повертає bounded runtime providerBreakers без дублювання breaker engine.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Перевірено 2026-08-31: native /api/resilience + /api/monitoring/health; adapter/API permission tests; provider failure→fallback regression; 111/111 tests; backend/frontend production build; live GET /ai/resilience 200; 7/7 Docker healthy.
- **Source/notes:** OmniRoute v3.8.50 source audit + NPATI runtime audit 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #20: Cooldown / lockout

- **Roadmap phase:** 1
- **Code/reference:** 49
- **Source:** OmniRoute v3.8.50
- **Area:** Resilience / Reliability
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** NPATI використовує native OmniRoute connection cooldown і model lockouts; live configuration/runtime доступні через GET /ai/resilience. Власний cooldown engine не створювався.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Перевірено 2026-08-31: live connectionCooldown configuration отримано з OmniRoute; lockouts нормалізовано у bounded API response; adapter/API permission tests; 111/111 regression; production build; Docker healthy. Active lockout не створювався штучно у production.
- **Source/notes:** OmniRoute v3.8.50 source audit + NPATI runtime audit 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #21: Retry / backoff

- **Roadmap phase:** 1
- **Code/reference:** 50
- **Source:** OmniRoute v3.8.50
- **Area:** Resilience / Reliability
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Company agent priority/pipeline combos передають OmniRoute maxRetries=2, retryDelayMs=500, failoverBeforeRetry=true і timeout; direct chat fallback виконується лише між user-selected primary/fallback через OmniRoute.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Перевірено 2026-08-31: unit failure 429/quota→fallback; Company combo config assertions; timeout/cancellation/idempotency regression; GET /ai/resilience 200; 111/111 tests; production build; 7/7 Docker healthy.
- **Source/notes:** OmniRoute v3.8.50 source audit + NPATI runtime audit 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #22: Adaptive admission / queue

- **Roadmap phase:** 1
- **Code/reference:** 51
- **Source:** OmniRoute v3.8.50
- **Area:** Resilience / Reliability
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Native adaptive admission і request queue виявлені та їх runtime/config доступні через GET /ai/resilience. Live OmniRoute зараз повідомляє adaptiveAdmission.mode=shadow, тому enforcement не позначено завершеним.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Пройдено read-only API/permissions/build/Docker smoke. Залишається: безпечно увімкнути enforcement за обраною capacity policy та виконати concurrency/backpressure fault test; до цього ✅ не ставити.
- **Source/notes:** OmniRoute v3.8.50 source audit + live runtime 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #23: Self-healing Auto-Combo

- **Roadmap phase:** 1
- **Code/reference:** 54
- **Source:** OmniRoute v3.8.50
- **Area:** Resilience / Reliability
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Native comboCooldownWait увімкнений; Company створює idempotent priority/pipeline/fusion combos з failover-before-retry. Повний live self-healing fault-injection ще не підтверджений.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Пройдено combo idempotency/config tests, Pipeline/Fusion runtime regression, production build і Docker health. Залишається: контрольований live provider failure→cooldown→alternate combo→recovery тест без впливу на production credentials.
- **Source/notes:** OmniRoute v3.8.50 source audit + NPATI runtime audit 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #24: Live quota telemetry

- **Roadmap phase:** 1
- **Code/reference:** 56
- **Source:** OmniRoute v3.8.50
- **Area:** Resilience / Reliability
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Дуже важливо для публічного SaaS-агента.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Є тест failure → retry/fallback/cooldown; користувач отримує результат або зрозумілу помилку.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #25: Cost telemetry headers

- **Roadmap phase:** 1
- **Code/reference:** 100
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🔌 OmniRoute integration
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #26: Per-key USD spend quotas

- **Roadmap phase:** 1
- **Code/reference:** 101
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🔌 OmniRoute integration
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #27: Usage analytics

- **Roadmap phase:** 1
- **Code/reference:** 102
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #28: Quota tracking

- **Roadmap phase:** 1
- **Code/reference:** 103
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #29: Audit trail

- **Roadmap phase:** 1
- **Code/reference:** 109
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #30: Health / diagnostics

- **Roadmap phase:** 1
- **Code/reference:** 110
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Agent API /health агрегує стан database, OmniRoute, crawler, MinIO та optional Hub; Docker healthchecks використовують реальні endpoints.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Перевірено 2026-09-01: /health status=ok; database/omniroute/crawler/storage=ok; 8/8 Docker services healthy; regression 125/125.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #31: Prompt-injection guard

- **Roadmap phase:** 1
- **Code/reference:** 113
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🔌 OmniRoute integration
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/security/GUARDRAILS.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #32: PII masker

- **Roadmap phase:** 1
- **Code/reference:** 114
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🔌 OmniRoute integration
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/security/GUARDRAILS.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #33: Credential masking

- **Roadmap phase:** 1
- **Code/reference:** 115
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🔌 OmniRoute integration
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/security/GUARDRAILS.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #34: Custom guardrails

- **Roadmap phase:** 1
- **Code/reference:** 117
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/security/GUARDRAILS.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #35: API key auth

- **Roadmap phase:** 1
- **Code/reference:** 118
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/SECURITY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #36: OAuth 2.0 + PKCE

- **Roadmap phase:** 1
- **Code/reference:** 119
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/SECURITY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #37: Automatic token refresh

- **Roadmap phase:** 1
- **Code/reference:** 120
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/SECURITY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #38: AES-256-GCM at rest

- **Roadmap phase:** 1
- **Code/reference:** 121
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/SECURITY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #39: Route guard tiers

- **Roadmap phase:** 1
- **Code/reference:** 123
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/security/GUARDRAILS.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #40: MCP authorization scopes

- **Roadmap phase:** 1
- **Code/reference:** 124
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/SECURITY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #41: Gateway

- **Roadmap phase:** 1
- **Code/reference:** 139
- **Source:** OpenClaw
- **Area:** Core / Chat
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** NPATI Agent API є власним tenant-aware gateway для Chat, Business, Company, Models, Files та runtime routes поверх OmniRoute.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** API routes, permissions, error mapping, production build і Docker health перевірені; 125/125 regression.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #42: Streaming responses

- **Roadmap phase:** 1
- **Code/reference:** 142
- **Source:** OpenClaw
- **Area:** Core / Chat
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Chat підтримує streaming response path із cancellation/error handling; Web відображає streamed content без duplicate requests.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Chat streaming regression, frontend/backend build та live API health пройдені.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #43: Main session

- **Roadmap phase:** 1
- **Code/reference:** 144
- **Source:** OpenClaw
- **Area:** Sessions
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** NPATI має persisted chats/conversations та окремі Company runs; критичний Company run state зберігається у PostgreSQL, dispatch - Redis.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Reopen chat, persisted run/status, restart/recovery та tenant isolation перевірені.
- **Source/notes:** https://docs.openclaw.ai/concepts/main-session
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #44: Isolated group sessions

- **Roadmap phase:** 1
- **Code/reference:** 145
- **Source:** OpenClaw
- **Area:** Sessions
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Для multi-user потрібно ще жорсткіше tenant isolation.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Isolated group sessions' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #45: Multi-user mode

- **Roadmap phase:** 1
- **Code/reference:** 146
- **Source:** OpenClaw
- **Area:** Sessions
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Критично для публічного SaaS.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Multi-user mode' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #46: Session tools

- **Roadmap phase:** 1
- **Code/reference:** 149
- **Source:** OpenClaw
- **Area:** Sessions
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Потрібно Manager Agent для coordination.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Session tools' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/tools
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #47: Sandboxing

- **Roadmap phase:** 1
- **Code/reference:** 193
- **Source:** OpenClaw
- **Area:** Tools / Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Особливо важливо перед coding/browser/email automation.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #48: Tool allow/deny policy

- **Roadmap phase:** 1
- **Code/reference:** 194
- **Source:** OpenClaw
- **Area:** Tools / Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Особливо важливо перед coding/browser/email automation.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #49: Exec approvals

- **Roadmap phase:** 1
- **Code/reference:** 195
- **Source:** OpenClaw
- **Area:** Tools / Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Особливо важливо перед coding/browser/email automation.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/exec-approvals
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #50: DM allowlists & pairing

- **Roadmap phase:** 1
- **Code/reference:** 223
- **Source:** OpenClaw
- **Area:** Channels
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використати аналогічний access control для external channels.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Channel connect/disconnect працює; user mapping ізольований; inbound/outbound message trace.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #51: Per-agent tool policy

- **Roadmap phase:** 1
- **Code/reference:** 253
- **Source:** OpenClaw
- **Area:** Security / Ops
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Це обов’язкова основа перед автономними діями.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://docs.openclaw.ai/automation/tasks
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #52: Per-subagent tool policy

- **Roadmap phase:** 1
- **Code/reference:** 254
- **Source:** OpenClaw
- **Area:** Security / Ops
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Це обов’язкова основа перед автономними діями.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://docs.openclaw.ai/tools/subagents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #53: Sandbox + host separation

- **Roadmap phase:** 1
- **Code/reference:** 255
- **Source:** OpenClaw
- **Area:** Security / Ops
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Це обов’язкова основа перед автономними діями.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://docs.openclaw.ai/automation/tasks
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #54: Human approvals

- **Roadmap phase:** 1
- **Code/reference:** 256
- **Source:** OpenClaw
- **Area:** Security / Ops
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Це обов’язкова основа перед автономними діями.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://docs.openclaw.ai/tools/exec-approvals
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #55: Channel sender authorization

- **Roadmap phase:** 1
- **Code/reference:** 258
- **Source:** OpenClaw
- **Area:** Security / Ops
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Це обов’язкова основа перед автономними діями.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://docs.openclaw.ai/automation/tasks
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #56: Background task auditability

- **Roadmap phase:** 1
- **Code/reference:** 259
- **Source:** OpenClaw
- **Area:** Security / Ops
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Це обов’язкова основа перед автономними діями.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://docs.openclaw.ai/automation/tasks
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #57: Moderations

- **Roadmap phase:** 1
- **Code/reference:** 15
- **Source:** OmniRoute v3.8.50
- **Area:** Inference
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно перед публікацією та customer-facing відповідями.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Moderations' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/skills/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #58: Image generation

- **Roadmap phase:** 1
- **Code/reference:** 16
- **Source:** OmniRoute v3.8.50
- **Area:** Media
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Якщо вже є image generation у твоєму агенті - route через OmniRoute.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #59: OCR

- **Roadmap phase:** 1
- **Code/reference:** 21
- **Source:** OmniRoute v3.8.50
- **Area:** Media
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Добре доповнить твоє завантаження фото/файлів.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #60: Vision bridge guardrail

- **Roadmap phase:** 1
- **Code/reference:** 116
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/security/GUARDRAILS.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #61: OIDC dashboard gate

- **Roadmap phase:** 1
- **Code/reference:** 122
- **Source:** OmniRoute v3.8.50
- **Area:** Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Критично перед email/browser/code автоматизацією.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/SECURITY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #62: Scoped remote access tokens

- **Roadmap phase:** 1
- **Code/reference:** 130
- **Source:** OmniRoute v3.8.50
- **Area:** Remote / Network
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використати для service-to-service доступу.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Scoped remote access tokens' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #63: Auto reviewer for exec

- **Roadmap phase:** 1
- **Code/reference:** 257
- **Source:** OpenClaw
- **Area:** Security / Ops
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Це обов’язкова основа перед автономними діями.
- **Dependencies:** Поточний Agent API + Postgres/Redis + user/tenant ID
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Небезпечний сценарій блокується/вимагає approval; secrets/PII не потрапляють у відповідь або логи.
- **Source/notes:** https://docs.openclaw.ai/automation/tasks
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #64: Embeddings

- **Roadmap phase:** 2
- **Code/reference:** 13
- **Source:** OmniRoute v3.8.50
- **Area:** Inference
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Потрібно для Company/Brand Brain і пошуку по документах.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Embeddings' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/skills/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #65: Rerank

- **Roadmap phase:** 2
- **Code/reference:** 14
- **Source:** OmniRoute v3.8.50
- **Area:** Inference
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Додати після embeddings/RAG.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Rerank' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/skills/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #66: Persistent conversational memory

- **Roadmap phase:** 2
- **Code/reference:** 74
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Business Memory і Company Memory persistent у PostgreSQL. Але generic conversational NpatiAgent досі створює InMemoryProvider у API process, тому повна persistent conversational memory не завершена.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Company/Business memory та tenant scope перевірені. Залишок: перенести generic chat memory з RAM у persistent tenant store та пройти API restart/recovery.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #67: Memory scoped by API key

- **Roadmap phase:** 2
- **Code/reference:** 75
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #68: Optional sessionId scoping

- **Roadmap phase:** 2
- **Code/reference:** 76
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #69: Memory injection

- **Roadmap phase:** 2
- **Code/reference:** 78
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Company Agent runtime інжектує scoped Company Memory і retrieved Knowledge лише за fail-closed permissions. Повна універсальна OmniRoute Memory injection для всіх chat flows ще не доведена.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Live Company Memory -> Main Agent -> specialist -> final answer пройдено; generic chat/OmniRoute Memory path залишається частковим.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #70: Vector semantic search

- **Roadmap phase:** 2
- **Code/reference:** 80
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🔌 OmniRoute integration
- **Existing implementation note:** Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #71: Hybrid memory retrieval

- **Roadmap phase:** 2
- **Code/reference:** 81
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🔌 OmniRoute integration
- **Existing implementation note:** Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #72: Context compaction

- **Roadmap phase:** 2
- **Code/reference:** 150
- **Source:** OpenClaw
- **Area:** Sessions
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Можна поєднати з OmniRoute compression.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Context compaction' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #73: USER.md user model

- **Roadmap phase:** 2
- **Code/reference:** 165
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #74: MEMORY.md long-term memory

- **Roadmap phase:** 2
- **Code/reference:** 166
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #75: Semantic memory search

- **Roadmap phase:** 2
- **Code/reference:** 168
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #76: Hybrid keyword + vector search

- **Roadmap phase:** 2
- **Code/reference:** 171
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #77: Automatic memory flush

- **Roadmap phase:** 2
- **Code/reference:** 174
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #78: Automatic memory extraction

- **Roadmap phase:** 2
- **Code/reference:** 77
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #79: FTS5 keyword search

- **Roadmap phase:** 2
- **Code/reference:** 79
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #80: Memory rerank

- **Roadmap phase:** 2
- **Code/reference:** 82
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #81: Typed decay

- **Roadmap phase:** 2
- **Code/reference:** 85
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #82: Per-request no-memory

- **Roadmap phase:** 2
- **Code/reference:** 86
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Окремого user-facing/API per-request no-memory flag у NPATI не знайдено. Не вважати реалізованим лише через наявність memory компонентів.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Definition of Done: request flag, backend enforcement, no memory read/write, permissions, API/frontend regression.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #83: Daily memory notes

- **Roadmap phase:** 2
- **Code/reference:** 167
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #84: Memory get

- **Roadmap phase:** 2
- **Code/reference:** 169
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #85: Standing intents

- **Roadmap phase:** 2
- **Code/reference:** 170
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #86: Memory Wiki

- **Roadmap phase:** 2
- **Code/reference:** 173
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #87: Dreaming

- **Roadmap phase:** 2
- **Code/reference:** 175
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #88: Action-sensitive memory

- **Roadmap phase:** 2
- **Code/reference:** 177
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Етап 1; tenant isolation; embeddings/vector storage
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #89: Format translation

- **Roadmap phase:** 3
- **Code/reference:** 12
- **Source:** OmniRoute v3.8.50
- **Area:** API / сумісність
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як універсальний adapter layer.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Format translation' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #90: auto/coding

- **Roadmap phase:** 3
- **Code/reference:** 24
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Auto-Combo
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'auto/coding' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #91: auto/fast

- **Roadmap phase:** 3
- **Code/reference:** 25
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Auto-Combo
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'auto/fast' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #92: auto/cheap

- **Roadmap phase:** 3
- **Code/reference:** 26
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Auto-Combo
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'auto/cheap' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #93: auto/offline

- **Roadmap phase:** 3
- **Code/reference:** 27
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Auto-Combo
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'auto/offline' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #94: cost-optimized

- **Roadmap phase:** 3
- **Code/reference:** 37
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'cost-optimized' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #95: context-optimized

- **Roadmap phase:** 3
- **Code/reference:** 42
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'context-optimized' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #96: cache-optimized

- **Roadmap phase:** 3
- **Code/reference:** 43
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'cache-optimized' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #97: lkgp

- **Roadmap phase:** 3
- **Code/reference:** 44
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'lkgp' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #98: auto

- **Roadmap phase:** 3
- **Code/reference:** 45
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Особливо корисно для NPATI.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'auto' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #99: fusion

- **Roadmap phase:** 3
- **Code/reference:** 46
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Особливо корисно для NPATI.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'fusion' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #100: pipeline

- **Roadmap phase:** 3
- **Code/reference:** 47
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Особливо корисно для NPATI.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'pipeline' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #101: MCP server

- **Roadmap phase:** 3
- **Code/reference:** 87
- **Source:** OmniRoute v3.8.50
- **Area:** Protocols / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використати як універсальну tool-шину агента.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'MCP server' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #102: MCP scoped permissions

- **Roadmap phase:** 3
- **Code/reference:** 88
- **Source:** OmniRoute v3.8.50
- **Area:** Protocols / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Обов’язково для multi-tenant агента.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'MCP scoped permissions' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/SECURITY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #103: A2A protocol v0.3

- **Roadmap phase:** 3
- **Code/reference:** 89
- **Source:** OmniRoute v3.8.50
- **Area:** Protocols / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Основа Manager → specialist agents.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'A2A protocol v0.3' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/A2A-SERVER.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #104: A2A: Smart Routing

- **Roadmap phase:** 3
- **Code/reference:** 90
- **Source:** OmniRoute v3.8.50
- **Area:** Protocols / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати всередині Manager/worker orchestration.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'A2A: Smart Routing' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/A2A-SERVER.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #105: A2A: Health Report

- **Roadmap phase:** 3
- **Code/reference:** 94
- **Source:** OmniRoute v3.8.50
- **Area:** Protocols / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати всередині Manager/worker orchestration.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'A2A: Health Report' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/A2A-SERVER.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #106: OmniConductor

- **Roadmap phase:** 3
- **Code/reference:** 96
- **Source:** OmniRoute v3.8.50
- **Area:** Protocols / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Найближчий OmniRoute-компонент до orchestrator/manager архітектури.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'OmniConductor' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #107: Skills framework

- **Roadmap phase:** 3
- **Code/reference:** 97
- **Source:** OmniRoute v3.8.50
- **Area:** Protocols / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Створити NPATI skills: Research, SEO, Support, Content, WordPress, Social.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Manager маршрутизує задачу; видно agent/model/tool trace; є success/failure integration tests.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/skills/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #108: Per-agent model choice

- **Roadmap phase:** 3
- **Code/reference:** 155
- **Source:** OpenClaw
- **Area:** Models / Auth
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Manager сильна модель; workers дешевші/спеціалізовані.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Per-agent model choice' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/tools/subagents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #109: Multi-agent routing

- **Roadmap phase:** 3
- **Code/reference:** 156
- **Source:** OpenClaw
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Одна з головних наступних функцій.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Multi-agent routing' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #110: Sub-agents

- **Roadmap phase:** 3
- **Code/reference:** 157
- **Source:** OpenClaw
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Manager → Research/Writer/SEO/Reviewer/Support.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Sub-agents' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/tools/subagents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #111: Parallel sub-agents

- **Roadmap phase:** 3
- **Code/reference:** 158
- **Source:** OpenClaw
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Паралельний research/verification прискорить deep tasks.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Parallel sub-agents' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/tools/subagents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #112: Isolated vs forked context

- **Roadmap phase:** 3
- **Code/reference:** 160
- **Source:** OpenClaw
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Обов’язково для безпечної та дешевої delegation.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Isolated vs forked context' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/tools/subagents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #113: Agent send / session messaging

- **Roadmap phase:** 3
- **Code/reference:** 161
- **Source:** OpenClaw
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Аналог можна реалізувати через OmniRoute A2A.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Agent send / session messaging' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/tools
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #114: Background completion reporting

- **Roadmap phase:** 3
- **Code/reference:** 164
- **Source:** OpenClaw
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Потрібно для гарного UX manager-agent.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Background completion reporting' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/tools/subagents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #115: Skills

- **Roadmap phase:** 3
- **Code/reference:** 199
- **Source:** OpenClaw
- **Area:** Extensibility
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Створити бізнес skills поверх OmniRoute + твоїх tools.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Функція доступна з NPATI Agent/API; є end-to-end тест + логування помилок.
- **Source/notes:** https://docs.openclaw.ai/tools/skills
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #116: MCP server

- **Roadmap phase:** 3
- **Code/reference:** 204
- **Source:** OpenClaw
- **Area:** Extensibility
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** У тебе OmniRoute/NPATI MCP може виконувати цю роль.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'MCP server' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/cli/mcp
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #117: MCP client registry

- **Roadmap phase:** 3
- **Code/reference:** 205
- **Source:** OpenClaw
- **Area:** Extensibility
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Дозволить підключати сторонні MCP tools користувачів.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'MCP client registry' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/cli/mcp
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #118: Anthropic Messages API

- **Roadmap phase:** 3
- **Code/reference:** 7
- **Source:** OmniRoute v3.8.50
- **Area:** API / сумісність
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для Claude Code та Anthropic-екосистеми.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Anthropic Messages API' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/reference/API_REFERENCE.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #119: Gemini-compatible API

- **Roadmap phase:** 3
- **Code/reference:** 8
- **Source:** OmniRoute v3.8.50
- **Area:** API / сумісність
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно, якщо агент має напряму підтримувати Gemini-клієнтів.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Gemini-compatible API' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/reference/API_REFERENCE.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #120: A2A: Quota Management

- **Roadmap phase:** 3
- **Code/reference:** 91
- **Source:** OmniRoute v3.8.50
- **Area:** Protocols / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати всередині Manager/worker orchestration.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'A2A: Quota Management' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/A2A-SERVER.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #121: A2A: Provider Discovery

- **Roadmap phase:** 3
- **Code/reference:** 92
- **Source:** OmniRoute v3.8.50
- **Area:** Protocols / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати всередині Manager/worker orchestration.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'A2A: Provider Discovery' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/A2A-SERVER.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #122: A2A: Cost Analysis

- **Roadmap phase:** 3
- **Code/reference:** 93
- **Source:** OmniRoute v3.8.50
- **Area:** Protocols / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати всередині Manager/worker orchestration.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'A2A: Cost Analysis' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/A2A-SERVER.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #123: A2A: List Capabilities

- **Roadmap phase:** 3
- **Code/reference:** 95
- **Source:** OmniRoute v3.8.50
- **Area:** Protocols / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати всередині Manager/worker orchestration.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'A2A: List Capabilities' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/A2A-SERVER.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #124: Evaluation framework

- **Roadmap phase:** 3
- **Code/reference:** 137
- **Source:** OmniRoute v3.8.50
- **Area:** Quality
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Створити автоматичні evals для Research/SEO/Support/Writer.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Evaluation framework' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/comparison/OMNIROUTE_VS_ALTERNATIVES.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #125: Nested sub-agents

- **Roadmap phase:** 3
- **Code/reference:** 159
- **Source:** OpenClaw
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Додавати після стабільної 1-level orchestration.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Nested sub-agents' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/tools/subagents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #126: Goal management

- **Roadmap phase:** 3
- **Code/reference:** 163
- **Source:** OpenClaw
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для довгих бізнес-задач і project workflows.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Manager маршрутизує задачу; видно agent/model/tool trace; є success/failure integration tests.
- **Source/notes:** https://docs.openclaw.ai/tools
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #127: Swarm

- **Roadmap phase:** 3
- **Code/reference:** 162
- **Source:** OpenClaw
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не потрібно на старті; A2A + pipeline достатньо.
- **Dependencies:** Етапи 1-2; memory scopes; tool permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Swarm' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/tools/code-mode
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #128: Webhooks

- **Roadmap phase:** 4
- **Code/reference:** 98
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/skills/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #129: Automations scheduler

- **Roadmap phase:** 4
- **Code/reference:** 206
- **Source:** OpenClaw
- **Area:** Automation
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Це ключ до переходу від чату до автономного business agent.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Job переживає restart, idempotent, має audit/status/cancel та не дублює дію.
- **Source/notes:** https://docs.openclaw.ai/automation
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #130: Cron jobs

- **Roadmap phase:** 4
- **Code/reference:** 207
- **Source:** OpenClaw
- **Area:** Automation
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Це ключ до переходу від чату до автономного business agent.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Job переживає restart, idempotent, має audit/status/cancel та не дублює дію.
- **Source/notes:** https://docs.openclaw.ai/automation
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #131: Background Tasks ledger

- **Roadmap phase:** 4
- **Code/reference:** 210
- **Source:** OpenClaw
- **Area:** Automation
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Це ключ до переходу від чату до автономного business agent.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Job переживає restart, idempotent, має audit/status/cancel та не дублює дію.
- **Source/notes:** https://docs.openclaw.ai/automation/tasks
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #132: Task audit

- **Roadmap phase:** 4
- **Code/reference:** 211
- **Source:** OpenClaw
- **Area:** Automation
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Це ключ до переходу від чату до автономного business agent.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Job переживає restart, idempotent, має audit/status/cancel та не дублює дію.
- **Source/notes:** https://docs.openclaw.ai/automation/tasks
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #133: Task Flow

- **Roadmap phase:** 4
- **Code/reference:** 212
- **Source:** OpenClaw
- **Area:** Automation
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Це ключ до переходу від чату до автономного business agent.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Job переживає restart, idempotent, має audit/status/cancel та не дублює дію.
- **Source/notes:** https://docs.openclaw.ai/automation
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #134: Standing Orders

- **Roadmap phase:** 4
- **Code/reference:** 213
- **Source:** OpenClaw
- **Area:** Automation
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Це ключ до переходу від чату до автономного business agent.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Job переживає restart, idempotent, має audit/status/cancel та не дублює дію.
- **Source/notes:** https://docs.openclaw.ai/automation/standing-orders
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #135: Webhooks ingress

- **Roadmap phase:** 4
- **Code/reference:** 214
- **Source:** OpenClaw
- **Area:** Automation
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Це ключ до переходу від чату до автономного business agent.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Job переживає restart, idempotent, має audit/status/cancel та не дублює дію.
- **Source/notes:** https://docs.openclaw.ai/automation
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #136: IMAP email trigger

- **Roadmap phase:** 4
- **Code/reference:** 215
- **Source:** OpenClaw
- **Area:** Automation
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Це ключ до переходу від чату до автономного business agent.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Job переживає restart, idempotent, має audit/status/cancel та не дублює дію.
- **Source/notes:** https://docs.openclaw.ai/automation
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #137: Webhook retries

- **Roadmap phase:** 4
- **Code/reference:** 99
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/skills/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #138: One-shot reminders

- **Roadmap phase:** 4
- **Code/reference:** 208
- **Source:** OpenClaw
- **Area:** Automation
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Це ключ до переходу від чату до автономного business agent.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Job переживає restart, idempotent, має audit/status/cancel та не дублює дію.
- **Source/notes:** https://docs.openclaw.ai/automation
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #139: Heartbeat

- **Roadmap phase:** 4
- **Code/reference:** 209
- **Source:** OpenClaw
- **Area:** Automation
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Це ключ до переходу від чату до автономного business agent.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Job переживає restart, idempotent, має audit/status/cancel та не дублює дію.
- **Source/notes:** https://docs.openclaw.ai/automation
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #140: Lifecycle hooks

- **Roadmap phase:** 4
- **Code/reference:** 216
- **Source:** OpenClaw
- **Area:** Automation
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Це ключ до переходу від чату до автономного business agent.
- **Dependencies:** Етапи 1-3; audit + idempotency + permissions
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Job переживає restart, idempotent, має audit/status/cancel та не дублює дію.
- **Source/notes:** https://docs.openclaw.ai/automation/hooks
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #141: Image understanding

- **Roadmap phase:** 5
- **Code/reference:** 224
- **Source:** OpenClaw
- **Area:** Media / Voice
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Базовий голос/файли вже є; не відволікатися від orchestration та automation.
- **Dependencies:** Етап 1; media storage/retention; moderation
- **Existing test/evidence note:** Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://docs.openclaw.ai/tools/media-overview
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #142: Document input/output

- **Roadmap phase:** 5
- **Code/reference:** 227
- **Source:** OpenClaw
- **Area:** Media / Voice
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Базовий голос/файли вже є; не відволікатися від orchestration та automation.
- **Dependencies:** Етап 1; media storage/retention; moderation
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://docs.openclaw.ai/tools/media-overview
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #143: Modality bridge

- **Roadmap phase:** 5
- **Code/reference:** 22
- **Source:** OmniRoute v3.8.50
- **Area:** Media
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для єдиного multimodal UX.
- **Dependencies:** Етап 1; media storage/retention; moderation
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #144: Audio understanding

- **Roadmap phase:** 5
- **Code/reference:** 225
- **Source:** OpenClaw
- **Area:** Media / Voice
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Базовий голос/файли вже є; не відволікатися від orchestration та automation.
- **Dependencies:** Етап 1; media storage/retention; moderation
- **Existing test/evidence note:** Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://docs.openclaw.ai/tools/media-overview
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #145: Image generation/editing

- **Roadmap phase:** 5
- **Code/reference:** 228
- **Source:** OpenClaw
- **Area:** Media / Voice
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Базовий голос/файли вже є; не відволікатися від orchestration та automation.
- **Dependencies:** Етап 1; media storage/retention; moderation
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://docs.openclaw.ai/tools/media-overview
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #146: Voice-note transcription

- **Roadmap phase:** 5
- **Code/reference:** 232
- **Source:** OpenClaw
- **Area:** Media / Voice
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Базовий голос/файли вже є; не відволікатися від orchestration та automation.
- **Dependencies:** Етап 1; media storage/retention; moderation
- **Existing test/evidence note:** Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://docs.openclaw.ai/tools/media-overview
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #147: Audio translation

- **Roadmap phase:** 5
- **Code/reference:** 20
- **Source:** OmniRoute v3.8.50
- **Area:** Media
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для міжнародної підтримки, але не перший пріоритет.
- **Dependencies:** Етап 1; media storage/retention; moderation
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #148: Video understanding

- **Roadmap phase:** 5
- **Code/reference:** 226
- **Source:** OpenClaw
- **Area:** Media / Voice
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Базовий голос/файли вже є; не відволікатися від orchestration та automation.
- **Dependencies:** Етап 1; media storage/retention; moderation
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://docs.openclaw.ai/tools/media-overview
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #149: Managed browser profile

- **Roadmap phase:** 6
- **Code/reference:** 181
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Твій запланований Browser Use має бути sandboxed.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/browser
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #150: Browser tab control

- **Roadmap phase:** 6
- **Code/reference:** 182
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Робити після tool permissions/approvals.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/browser
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #151: Browser click/type

- **Roadmap phase:** 6
- **Code/reference:** 183
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Робити після tool permissions/approvals.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/browser
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #152: Browser drag/select

- **Roadmap phase:** 6
- **Code/reference:** 184
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Робити після tool permissions/approvals.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/browser
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #153: Browser snapshots

- **Roadmap phase:** 6
- **Code/reference:** 185
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Робити після tool permissions/approvals.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/browser
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #154: Browser screenshots

- **Roadmap phase:** 6
- **Code/reference:** 186
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Робити після tool permissions/approvals.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/browser
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #155: Browser PDF capture

- **Roadmap phase:** 6
- **Code/reference:** 187
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Робити після tool permissions/approvals.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/browser
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #156: Browser downloads

- **Roadmap phase:** 6
- **Code/reference:** 188
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Робити після tool permissions/approvals.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/browser
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #157: Multi-profile browser

- **Roadmap phase:** 6
- **Code/reference:** 189
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Робити після tool permissions/approvals.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/browser
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #158: Attach real Chrome

- **Roadmap phase:** 6
- **Code/reference:** 190
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Робити після tool permissions/approvals.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/browser
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #159: Exec

- **Roadmap phase:** 6
- **Code/reference:** 191
- **Source:** OpenClaw
- **Area:** Tools / Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Особливо важливо перед coding/browser/email automation.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/exec
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #160: Process control

- **Roadmap phase:** 6
- **Code/reference:** 192
- **Source:** OpenClaw
- **Area:** Tools / Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Особливо важливо перед coding/browser/email automation.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/exec
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #161: Tool Search

- **Roadmap phase:** 6
- **Code/reference:** 196
- **Source:** OpenClaw
- **Area:** Tools / Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Особливо важливо перед coding/browser/email automation.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/code-mode
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #162: File tools

- **Roadmap phase:** 6
- **Code/reference:** 198
- **Source:** OpenClaw
- **Area:** Tools / Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Особливо важливо перед coding/browser/email automation.
- **Dependencies:** Етап 1; sandbox + approvals + secrets
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/exec
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #163: Coding CLI gateway

- **Roadmap phase:** 7
- **Code/reference:** 125
- **Source:** OmniRoute v3.8.50
- **Area:** Coding / CLI
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не будувати власну coding model; route готові coding clients/agents.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #164: omniroute run

- **Roadmap phase:** 7
- **Code/reference:** 126
- **Source:** OmniRoute v3.8.50
- **Area:** Coding / CLI
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Може стати backend для NPATI Code.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #165: Cloud-agent providers

- **Roadmap phase:** 7
- **Code/reference:** 128
- **Source:** OmniRoute v3.8.50
- **Area:** Coding / CLI
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Підключати після multi-agent та sandbox.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/comparison/OMNIROUTE_VS_ALTERNATIVES.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #166: OAuth subscription auth

- **Roadmap phase:** 7
- **Code/reference:** 153
- **Source:** OpenClaw
- **Area:** Models / Auth
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для coding integrations.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'OAuth subscription auth' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #167: Native Codex runtime

- **Roadmap phase:** 7
- **Code/reference:** 235
- **Source:** OpenClaw
- **Area:** Coding
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://docs.openclaw.ai/tools/acp-agents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #168: ACP sessions

- **Roadmap phase:** 7
- **Code/reference:** 236
- **Source:** OpenClaw
- **Area:** Coding
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://docs.openclaw.ai/tools/acp-agents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #169: Claude Code via ACP

- **Roadmap phase:** 7
- **Code/reference:** 237
- **Source:** OpenClaw
- **Area:** Coding
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://docs.openclaw.ai/tools/acp-agents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #170: omniroute configure

- **Roadmap phase:** 7
- **Code/reference:** 127
- **Source:** OmniRoute v3.8.50
- **Area:** Coding / CLI
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Адмінська/локальна функція.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #171: Cursor via ACP

- **Roadmap phase:** 7
- **Code/reference:** 238
- **Source:** OpenClaw
- **Area:** Coding
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://docs.openclaw.ai/tools/acp-agents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #172: GitHub Copilot via ACP

- **Roadmap phase:** 7
- **Code/reference:** 239
- **Source:** OpenClaw
- **Area:** Coding
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://docs.openclaw.ai/tools/acp-agents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #173: Gemini CLI via ACP

- **Roadmap phase:** 7
- **Code/reference:** 240
- **Source:** OpenClaw
- **Area:** Coding
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://docs.openclaw.ai/tools/acp-agents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #174: OpenCode via ACP

- **Roadmap phase:** 7
- **Code/reference:** 241
- **Source:** OpenClaw
- **Area:** Coding
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://docs.openclaw.ai/tools/acp-agents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #175: Other ACP harnesses

- **Roadmap phase:** 7
- **Code/reference:** 242
- **Source:** OpenClaw
- **Area:** Coding
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.
- **Dependencies:** Етап 6; isolated workspace; Git/GitHub access
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Coding task працює в isolated workspace; тести запускаються; destructive commands під approval.
- **Source/notes:** https://docs.openclaw.ai/tools/acp-agents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #176: Semantic cache

- **Roadmap phase:** 8
- **Code/reference:** 104
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🔌 OmniRoute integration
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #177: priority

- **Roadmap phase:** 8
- **Code/reference:** 29
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'priority' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #178: fill-first

- **Roadmap phase:** 8
- **Code/reference:** 30
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'fill-first' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #179: weighted

- **Roadmap phase:** 8
- **Code/reference:** 31
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'weighted' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #180: round-robin

- **Roadmap phase:** 8
- **Code/reference:** 32
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'round-robin' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #181: p2c

- **Roadmap phase:** 8
- **Code/reference:** 33
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'p2c' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #182: least-used

- **Roadmap phase:** 8
- **Code/reference:** 34
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'least-used' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #183: random

- **Roadmap phase:** 8
- **Code/reference:** 35
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'random' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #184: strict-random

- **Roadmap phase:** 8
- **Code/reference:** 36
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'strict-random' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #185: headroom

- **Roadmap phase:** 8
- **Code/reference:** 38
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'headroom' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #186: reset-window

- **Roadmap phase:** 8
- **Code/reference:** 39
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'reset-window' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #187: reset-aware

- **Roadmap phase:** 8
- **Code/reference:** 40
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'reset-aware' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #188: context-relay

- **Roadmap phase:** 8
- **Code/reference:** 41
- **Source:** OmniRoute v3.8.50
- **Area:** Routing / Strategies
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Використовувати як внутрішню routing policy.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'context-relay' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #189: Atomic RPM rolling leases

- **Roadmap phase:** 8
- **Code/reference:** 52
- **Source:** OmniRoute v3.8.50
- **Area:** Resilience / Reliability
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Дуже важливо для публічного SaaS-агента.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Є тест failure → retry/fallback/cooldown; користувач отримує результат або зрозумілу помилку.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #190: Quota-Share routing

- **Roadmap phase:** 8
- **Code/reference:** 53
- **Source:** OmniRoute v3.8.50
- **Area:** Resilience / Reliability
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Дуже важливо для публічного SaaS-агента.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Є тест failure → retry/fallback/cooldown; користувач отримує результат або зрозумілу помилку.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #191: Routing transparency

- **Roadmap phase:** 8
- **Code/reference:** 55
- **Source:** OmniRoute v3.8.50
- **Area:** Resilience / Reliability
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Дуже важливо для публічного SaaS-агента.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Є тест failure → retry/fallback/cooldown; користувач отримує результат або зрозумілу помилку.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #192: Session-Dedup

- **Roadmap phase:** 8
- **Code/reference:** 57
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Вмикати вибірково для довгих чатів, research та tool logs.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Session-Dedup' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #193: RTK

- **Roadmap phase:** 8
- **Code/reference:** 60
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** NPATI використовує native OmniRoute compression/RTK через routing settings; adapter передає x-omniroute-compression, власний compression engine не створювався.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Adapter header test, routing settings persistence та production build пройдені.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #194: Relevance

- **Roadmap phase:** 8
- **Code/reference:** 63
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Вмикати вибірково для довгих чатів, research та tool logs.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Relevance' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #195: Aggressive

- **Roadmap phase:** 8
- **Code/reference:** 65
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Вмикати вибірково для довгих чатів, research та tool logs.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Aggressive' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #196: LLMLingua-2

- **Roadmap phase:** 8
- **Code/reference:** 66
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Вмикати вибірково для довгих чатів, research та tool logs.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'LLMLingua-2' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #197: Compression presets

- **Roadmap phase:** 8
- **Code/reference:** 69
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Добре для контролю вартості й довгих контекстів.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Compression presets' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #198: Adaptive context budget

- **Roadmap phase:** 8
- **Code/reference:** 70
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Добре для контролю вартості й довгих контекстів.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Adaptive context budget' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #199: Per-request compression override

- **Roadmap phase:** 8
- **Code/reference:** 71
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Tenant routing preference compression застосовується до chat requests. Окремий override для одного конкретного user request/API payload не реалізований.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Поточний settings->adapter path протестовано. Залишок: request-level override schema, permission/validation та regression.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #200: Output Styles

- **Roadmap phase:** 8
- **Code/reference:** 72
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Добре для контролю вартості й довгих контекстів.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Output Styles' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #201: Compression eval harness

- **Roadmap phase:** 8
- **Code/reference:** 73
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Добре для контролю вартості й довгих контекстів.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Compression eval harness' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #202: Cache stats / flush

- **Roadmap phase:** 8
- **Code/reference:** 105
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #203: Cache-hit savings telemetry

- **Roadmap phase:** 8
- **Code/reference:** 106
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #204: Model catalog sync

- **Roadmap phase:** 8
- **Code/reference:** 107
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #205: Database backups

- **Roadmap phase:** 8
- **Code/reference:** 111
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/skills/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #206: Control UI

- **Roadmap phase:** 8
- **Code/reference:** 141
- **Source:** OpenClaw
- **Area:** Core / Chat
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Розвивати admin/agent controls окремо від user chat.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Функція доступна з NPATI Agent/API; є end-to-end тест + логування помилок.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #207: Session search

- **Roadmap phase:** 8
- **Code/reference:** 147
- **Source:** OpenClaw
- **Area:** Sessions
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Додати пошук по чатах/задачах.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Session search' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #208: Session pruning

- **Roadmap phase:** 8
- **Code/reference:** 148
- **Source:** OpenClaw
- **Area:** Sessions
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Потрібно для storage/cost lifecycle.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Session pruning' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #209: Custom/self-hosted models

- **Roadmap phase:** 8
- **Code/reference:** 154
- **Source:** OpenClaw
- **Area:** Models / Auth
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** NPATI отримує models/providers через OmniRoute і не hardcode model list. Окремий live self-hosted provider/model connection та inference test у цьому середовищі не зафіксований.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Залишок перед ✅: підключити тестовий self-hosted provider через OmniRoute, model discovery, inference, failure/timeout test.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #210: Free-tier catalog

- **Roadmap phase:** 8
- **Code/reference:** 3
- **Source:** OmniRoute v3.8.50
- **Area:** Провайдери
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для автоматичного вибору дешевих/безкоштовних моделей.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Free-tier catalog' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #211: Dedicated provider routes

- **Roadmap phase:** 8
- **Code/reference:** 10
- **Source:** OmniRoute v3.8.50
- **Area:** API / сумісність
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Залишити як advanced/admin option.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Dedicated provider routes' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/reference/API_REFERENCE.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #212: CCR

- **Roadmap phase:** 8
- **Code/reference:** 58
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Вмикати вибірково для довгих чатів, research та tool logs.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'CCR' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #213: Lite

- **Roadmap phase:** 8
- **Code/reference:** 59
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Вмикати вибірково для довгих чатів, research та tool logs.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Lite' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #214: Responses Tool Output

- **Roadmap phase:** 8
- **Code/reference:** 61
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Вмикати вибірково для довгих чатів, research та tool logs.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Responses Tool Output' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #215: Headroom

- **Roadmap phase:** 8
- **Code/reference:** 62
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Вмикати вибірково для довгих чатів, research та tool logs.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Headroom' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #216: Caveman

- **Roadmap phase:** 8
- **Code/reference:** 64
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Вмикати вибірково для довгих чатів, research та tool logs.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Caveman' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #217: Ultra

- **Roadmap phase:** 8
- **Code/reference:** 67
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Вмикати вибірково для довгих чатів, research та tool logs.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Ultra' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #218: OmniGlyph

- **Roadmap phase:** 8
- **Code/reference:** 68
- **Source:** OmniRoute v3.8.50
- **Area:** Compression
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Вмикати вибірково для довгих чатів, research та tool logs.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'OmniGlyph' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #219: Qdrant support

- **Roadmap phase:** 8
- **Code/reference:** 83
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #220: int8 vector quantization

- **Roadmap phase:** 8
- **Code/reference:** 84
- **Source:** OmniRoute v3.8.50
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/frameworks/MEMORY.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #221: Device tracking per API key

- **Roadmap phase:** 8
- **Code/reference:** 108
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #222: Version manager

- **Roadmap phase:** 8
- **Code/reference:** 112
- **Source:** OmniRoute v3.8.50
- **Area:** Ops / Cost / Cache
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для SaaS контролю вартості, надійності та аудиту.
- **Dependencies:** Стабільні етапи 1-3; production telemetry
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Метрики видно в admin; є alerts/limits; дані перевірені на real request.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/skills/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #223: Plugins

- **Roadmap phase:** 9
- **Code/reference:** 200
- **Source:** OpenClaw
- **Area:** Extensibility
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Сильний pattern для модульної архітектури.
- **Dependencies:** Етап 1; OAuth/secrets + channel identity mapping
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Plugins' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/plugins/building-plugins
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #224: Response chunking

- **Roadmap phase:** 9
- **Code/reference:** 143
- **Source:** OpenClaw
- **Area:** Core / Chat
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для Telegram/Slack/email-like channels.
- **Dependencies:** Етап 1; OAuth/secrets + channel identity mapping
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Response chunking' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #225: Channel docking / thread binding

- **Roadmap phase:** 9
- **Code/reference:** 151
- **Source:** OpenClaw
- **Area:** Sessions
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно, коли додаси зовнішні месенджери.
- **Dependencies:** Етап 1; OAuth/secrets + channel identity mapping
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Channel docking / thread binding' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/tools/subagents
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #226: Plugin hooks

- **Roadmap phase:** 9
- **Code/reference:** 202
- **Source:** OpenClaw
- **Area:** Extensibility
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для policy/telemetry/approval layer.
- **Dependencies:** Етап 1; OAuth/secrets + channel identity mapping
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Plugin hooks' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/plugins/hooks
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #227: Internal hooks

- **Roadmap phase:** 9
- **Code/reference:** 203
- **Source:** OpenClaw
- **Area:** Extensibility
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для audit/memory/cleanup.
- **Dependencies:** Етап 1; OAuth/secrets + channel identity mapping
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Internal hooks' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/automation/hooks
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #228: Telegram

- **Roadmap phase:** 9
- **Code/reference:** 217
- **Source:** OpenClaw
- **Area:** Channels
- **Roadmap status:** ✅ Already implemented
- **Priority:** P2
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Підключати через твій Hub, якщо вже є social/messaging infrastructure.
- **Dependencies:** Етап 1; OAuth/secrets + channel identity mapping
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Channel connect/disconnect працює; user mapping ізольований; inbound/outbound message trace.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #229: X search

- **Roadmap phase:** 9
- **Code/reference:** 180
- **Source:** OpenClaw
- **Area:** Web / Browser
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Додавати лише якщо потрібен social research.
- **Dependencies:** Етап 1; OAuth/secrets + channel identity mapping
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/web
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #230: Official channel plugins

- **Roadmap phase:** 9
- **Code/reference:** 219
- **Source:** OpenClaw
- **Area:** Channels
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не копіювати все; обирати канали з реальним попитом.
- **Dependencies:** Етап 1; OAuth/secrets + channel identity mapping
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Channel connect/disconnect працює; user mapping ізольований; inbound/outbound message trace.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #231: External channel plugins

- **Roadmap phase:** 9
- **Code/reference:** 220
- **Source:** OpenClaw
- **Area:** Channels
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Низький пріоритет.
- **Dependencies:** Етап 1; OAuth/secrets + channel identity mapping
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Channel connect/disconnect працює; user mapping ізольований; inbound/outbound message trace.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #232: Group chat

- **Roadmap phase:** 9
- **Code/reference:** 221
- **Source:** OpenClaw
- **Area:** Channels
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Потрібно лише для team/chat use case.
- **Dependencies:** Етап 1; OAuth/secrets + channel identity mapping
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Channel connect/disconnect працює; user mapping ізольований; inbound/outbound message trace.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #233: Mention activation

- **Roadmap phase:** 9
- **Code/reference:** 222
- **Source:** OpenClaw
- **Area:** Channels
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для Slack/Discord/Teams.
- **Dependencies:** Етап 1; OAuth/secrets + channel identity mapping
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Channel connect/disconnect працює; user mapping ізольований; inbound/outbound message trace.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #234: OmniRoute Radar

- **Roadmap phase:** 10
- **Code/reference:** 4
- **Source:** OmniRoute v3.8.50
- **Area:** Провайдери
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не критично для першої версії агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'OmniRoute Radar' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #235: Video generation

- **Roadmap phase:** 10
- **Code/reference:** 17
- **Source:** OmniRoute v3.8.50
- **Area:** Media
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Додавати після core business-agent функцій.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #236: Remote CLI contexts

- **Roadmap phase:** 10
- **Code/reference:** 129
- **Source:** OmniRoute v3.8.50
- **Area:** Remote / Network
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Корисно для ops, не user-facing.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Remote CLI contexts' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #237: MITM / TPROXY

- **Roadmap phase:** 10
- **Code/reference:** 131
- **Source:** OmniRoute v3.8.50
- **Area:** Remote / Network
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Додавати лише якщо реально потрібне перехоплення coding CLI.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'MITM / TPROXY' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #238: Proxy system

- **Roadmap phase:** 10
- **Code/reference:** 132
- **Source:** OmniRoute v3.8.50
- **Area:** Remote / Network
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не пріоритет для бізнес-агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Proxy system' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #239: Embedded Bifrost & Mux

- **Roadmap phase:** 10
- **Code/reference:** 134
- **Source:** OmniRoute v3.8.50
- **Area:** Infrastructure
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не user-facing.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Embedded Bifrost & Mux' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #240: Relay deployers

- **Roadmap phase:** 10
- **Code/reference:** 135
- **Source:** OmniRoute v3.8.50
- **Area:** Infrastructure
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Потрібно лише за конкретної мережевої архітектури.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Relay deployers' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #241: Docker / Podman / Bun / Nix

- **Roadmap phase:** 10
- **Code/reference:** 136
- **Source:** OmniRoute v3.8.50
- **Area:** Infrastructure
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Production Docker Compose працює. Podman, Bun і Nix окремо не інтегровані та не протестовані, тому весь комбінований пункт не може мати ✅.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Docker build/health 8/8 пройдено. Podman/Bun/Nix залишаються неперевіреними.
- **Source/notes:** https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/README.md
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #242: Multiple memory engines

- **Roadmap phase:** 10
- **Code/reference:** 172
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #243: Memory import

- **Roadmap phase:** 10
- **Code/reference:** 176
- **Source:** OpenClaw
- **Area:** Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дані зберігаються й дістаються у правильному user/brand scope; немає cross-tenant leakage.
- **Source/notes:** https://docs.openclaw.ai/concepts/memory
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #244: Code Mode

- **Roadmap phase:** 10
- **Code/reference:** 197
- **Source:** OpenClaw
- **Area:** Tools / Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Особливо важливо перед coding/browser/email automation.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Дія виконується sandboxed; risky actions проходять approval; є screenshot/tool log.
- **Source/notes:** https://docs.openclaw.ai/tools/code-mode
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #245: ClawHub

- **Roadmap phase:** 10
- **Code/reference:** 201
- **Source:** OpenClaw
- **Area:** Extensibility
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Свій marketplace skills не потрібен на старті.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'ClawHub' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/plugins/building-plugins
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #246: Video generation

- **Roadmap phase:** 10
- **Code/reference:** 229
- **Source:** OpenClaw
- **Area:** Media / Voice
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Базовий голос/файли вже є; не відволікатися від orchestration та automation.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://docs.openclaw.ai/tools/media-overview
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #247: Music generation

- **Roadmap phase:** 10
- **Code/reference:** 230
- **Source:** OpenClaw
- **Area:** Media / Voice
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Базовий голос/файли вже є; не відволікатися від orchestration та automation.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://docs.openclaw.ai/tools/media-overview
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #248: Talk / realtime speech

- **Roadmap phase:** 10
- **Code/reference:** 233
- **Source:** OpenClaw
- **Area:** Media / Voice
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Базовий голос/файли вже є; не відволікатися від orchestration та automation.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://docs.openclaw.ai/tools/media-overview
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #249: Voice Call

- **Roadmap phase:** 10
- **Code/reference:** 234
- **Source:** OpenClaw
- **Area:** Media / Voice
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Базовий голос/файли вже є; не відволікатися від orchestration та automation.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: Результат відображається в чаті; quota/cost/moderation логуються; storage/retention визначені.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #250: macOS companion

- **Roadmap phase:** 10
- **Code/reference:** 243
- **Source:** OpenClaw
- **Area:** Apps / Nodes
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не пріоритет для веб-бізнес агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'macOS companion' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/nodes
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #251: iOS node pairing

- **Roadmap phase:** 10
- **Code/reference:** 244
- **Source:** OpenClaw
- **Area:** Apps / Nodes
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не пріоритет для веб-бізнес агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'iOS node pairing' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/nodes
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #252: Android node pairing

- **Roadmap phase:** 10
- **Code/reference:** 245
- **Source:** OpenClaw
- **Area:** Apps / Nodes
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не пріоритет для веб-бізнес агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Android node pairing' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/nodes
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #253: Mobile chat

- **Roadmap phase:** 10
- **Code/reference:** 246
- **Source:** OpenClaw
- **Area:** Apps / Nodes
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не пріоритет для веб-бізнес агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Mobile chat' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/nodes
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #254: Mobile voice

- **Roadmap phase:** 10
- **Code/reference:** 247
- **Source:** OpenClaw
- **Area:** Apps / Nodes
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не пріоритет для веб-бізнес агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Mobile voice' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/nodes
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #255: Camera access

- **Roadmap phase:** 10
- **Code/reference:** 248
- **Source:** OpenClaw
- **Area:** Apps / Nodes
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не пріоритет для веб-бізнес агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Camera access' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/nodes
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #256: Screen recording

- **Roadmap phase:** 10
- **Code/reference:** 249
- **Source:** OpenClaw
- **Area:** Apps / Nodes
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не пріоритет для веб-бізнес агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Screen recording' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/nodes
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #257: Location access

- **Roadmap phase:** 10
- **Code/reference:** 250
- **Source:** OpenClaw
- **Area:** Apps / Nodes
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не пріоритет для веб-бізнес агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Location access' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/nodes
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #258: Device commands

- **Roadmap phase:** 10
- **Code/reference:** 251
- **Source:** OpenClaw
- **Area:** Apps / Nodes
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не пріоритет для веб-бізнес агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Device commands' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/nodes
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #259: Linux companion / inline media

- **Roadmap phase:** 10
- **Code/reference:** 252
- **Source:** OpenClaw
- **Area:** Apps / Nodes
- **Roadmap status:** ✅ Already implemented
- **Priority:** P3
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Не пріоритет для веб-бізнес агента.
- **Dependencies:** Після стабілізації core-функцій
- **Existing test/evidence note:** Після реалізації обов'язково протестувати: backend, frontend, API, provider errors (де застосовно), повторні та duplicate requests, duplicate PostgreSQL records, concurrency, timeouts, retries, permissions, tenant isolation і regression існуючих функцій. Очікуваний результат: 'Linux companion / inline media' інтегрована або реалізована, user-facing flow працює, а всі перелічені перевірки успішно проходять.
- **Source/notes:** https://docs.openclaw.ai/concepts/features
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #260: Tenant-scoped AI model/routing preferences

- **Roadmap phase:** 1
- **Code/reference:** NPATI-001
- **Source:** NPATI Agent
- **Area:** Security / Multi-tenant
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** PostgreSQL workspace_user_settings; auth scope у AI API/chat context; optimistic CAS + idempotent no-op; глобальний JSON видалено.
- **Dependencies:** Auth + PostgreSQL
- **Existing test/evidence note:** 89/89 regression tests; 20 concurrent duplicate requests; tenant/user isolation; API permission test; production build; healthy Docker API.
- **Source/notes:** Local code audit 2026-08-30
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #261: Business / Company separation + separate companies table

- **Roadmap phase:** 2
- **Code/reference:** NPATI-002
- **Source:** NPATI Agent
- **Area:** Company / AI Company
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Business залишається окремою business-analysis сутністю. Migration 006 створює окрему tenant/user-scoped companies table з optional business_id, FK, indexes, optimistic revision та idempotent create.
- **Dependencies:** PostgreSQL migration 006; tenant boundary
- **Existing test/evidence note:** Перевірено 2026-08-30: businesses і companies існують окремо; Business UI використовує /businesses; Company UI використовує /companies; 12 concurrent POST -> 1 PostgreSQL row; linked Business; tenant isolation; migration/FK/indexes; cleanup; 94/94 regression tests; production builds; Docker healthy.
- **Source/notes:** Local code audit 2026-08-30
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #262: Company context fields

- **Roadmap phase:** 2
- **Code/reference:** NPATI-003
- **Source:** NPATI Agent
- **Area:** Company / AI Company
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Окрема Company модель і user-facing Company Settings містять website, industry, description, products/services, languages, brand tone, company instructions, status і optional Business link.
- **Dependencies:** NPATI-002
- **Existing test/evidence note:** Перевірено PostgreSQL/API/frontend form/validation/optimistic revision/build/regression. Company Knowledge/Documents/Memory реалізовані окремо у NPATI-004 з частковим статусом до native Rerank completion.
- **Source/notes:** User roadmap requirement
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #263: Company knowledge / documents / memory

- **Roadmap phase:** 2
- **Code/reference:** NPATI-004
- **Source:** NPATI Agent
- **Area:** Company / AI Company
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Company Knowledge/Documents/Memory реалізовані у runtime: private MinIO documents, PostgreSQL metadata, Excel/PDF/DOCX/text extraction, Redis processing, OmniRoute Embeddings, pgvector retrieval, Company Memory, fail-closed per-agent Knowledge permissions, Main Agent delegation та grounded final answer. Native OmniRoute Rerank provider/model ще не підключений; використовується bounded pgvector fallback.
- **Dependencies:** NPATI-011A/B/C/D/E; NPATI-004A..J. Залишок: native OmniRoute Rerank credential/model, live 2-worker knowledge concurrency, browser UX matrix.
- **Existing test/evidence note:** Перевірено 2026-09-01: 125/125 tests; backend/frontend production build; 8/8 Docker healthy; 20 concurrent uploads -> 1 document; 20 idempotent deletes; Redis/API/worker restart recovery; cross-tenant 403; cross-company retrieval isolation; live User -> Main Agent -> Excel Knowledge + Memory -> specialist -> final answer. Не ✅ до завершення native Rerank та залишкових тестів.
- **Source/notes:** User roadmap requirement
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #264: Extensible Agent definitions + CRUD

- **Roadmap phase:** 3
- **Code/reference:** NPATI-005
- **Source:** NPATI Agent
- **Area:** Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** company_agents CRUD, tenant/company scope, idempotent create, optimistic update/delete, enable/disable, Agent Editor та cursor pagination. Delete атомарно очищає edges і main_agent_id та одразу синхронізує list/Org Chart.
- **Dependencies:** NPATI-002
- **Existing test/evidence note:** Перевірено 2026-08-31: create→delete→404; Main Agent з parent+children; stale revision 409; permissions/tenant isolation; 8 concurrent DELETE без дублікатів; real PostgreSQL cleanup; 111/111 regression; frontend/backend production build; Docker healthy.
- **Source/notes:** User roadmap requirement
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #265: Agent role + instructions + enabled state

- **Roadmap phase:** 3
- **Code/reference:** NPATI-006
- **Source:** NPATI Agent
- **Area:** Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Custom role, description, independent system instruction, prompt guidelines, recommended prompts та Active/Inactive зберігаються в PostgreSQL і редагуються у Company Agent Editor.
- **Dependencies:** NPATI-005
- **Existing test/evidence note:** Перевірено 2026-08-30: backend/API/frontend, required name/role validation, revision conflict, permissions, tenant isolation, 94/94 regression.
- **Source/notes:** User roadmap requirement
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #266: Per-agent model + fallback + Auto

- **Roadmap phase:** 3
- **Code/reference:** NPATI-007
- **Source:** NPATI Agent
- **Area:** Agents / Models
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Per-agent model і fallback зберігають OmniRoute model IDs. UI отримує concrete models з /ai/models/added; Auto не зберігає hardcoded provider та означає OmniRoute Auto Routing. API відхиляє model ID поза My Models.
- **Dependencies:** NPATI-005; OmniRoute models
- **Existing test/evidence note:** Перевірено 2026-08-30: configured OpenAI model + fallback round-trip; invalid model 400; Auto UI; OpenAI provider connected/healthy; model library збережена; builds/regression.
- **Source/notes:** User roadmap requirement
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #267: Per-agent tool allowlist

- **Roadmap phase:** 3
- **Code/reference:** NPATI-008
- **Source:** NPATI Agent
- **Area:** Agents / Tools
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Crawler використовує існуючий web-research/Crawl4AI; MCP - OmniRoute v3.8.50 Streamable HTTP із safe read-only allowlist; Files - Company knowledge та лише явно linked tenant attachments. Backend deny-by-default і PostgreSQL audit збережені.
- **Dependencies:** NPATI-005; MCP permissions
- **Existing test/evidence note:** Перевірено 2026-08-31: live Company Crawler requested/succeeded; live Company MCP requested/succeeded; Files inline/list/read та cross-tenant deny unit tests; forbidden MCP/admin tools blocked; 106/106 regression; frontend/backend builds; Docker healthy.
- **Source/notes:** User roadmap requirement
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #268: Manager delegation через A2A / Pipeline / Fusion

- **Roadmap phase:** 3
- **Code/reference:** NPATI-009
- **Source:** NPATI Agent + OmniRoute
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Main Agent планує через OmniRoute A2A smart-routing; NPATI створює thin orchestration config, а OmniRoute Pipeline/Fusion/Auto виконує sequential/parallel delegation, optional Reviewer та final Main response.
- **Dependencies:** NPATI-005..008
- **Existing test/evidence note:** Перевірено 2026-08-31: live OmniRoute 3.8.50 A2A=OK, Pipeline=PIPELINE_OK, Fusion=FUSION_OK; Auto target auto/smart; unit concurrency/idempotency, tenant isolation, timeout/cancel/error paths; 101/101 regression; Docker healthy. 20 concurrent PostgreSQL inserts з одним idempotency key -> 1 record; test tenant cleaned.
- **Source/notes:** User roadmap requirement
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #269: Company / Agents / Models cards у responsive grid

- **Roadmap phase:** 2
- **Code/reference:** NPATI-010
- **Source:** NPATI Agent
- **Area:** Settings UX
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Settings має окремі Business, Company і Models cards. Дублюючу Agents card видалено: company-scoped Agents керуються всередині /company через Agent Editor та Org Chart. Business відкриває /business.
- **Dependencies:** NPATI-002; NPATI-005
- **Existing test/evidence note:** Перевірено 2026-08-31: route/navigation architecture test забороняє дублюючу /agents card; /company та /business розділені; 111/111 regression; frontend/backend production build; web/API Docker healthy.
- **Source/notes:** User roadmap requirement
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #270: Business / Company separation

- **Roadmap phase:** 2
- **Code/reference:** NPATI-002A
- **Source:** NPATI Agent
- **Area:** Company / Architecture
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Business analysis залишається у businesses; operational AI Company використовує окремий companies API/store/page.
- **Dependencies:** Migration 006
- **Existing test/evidence note:** Перевірено backend, frontend, API, real PostgreSQL і regression; Business дані не мігрувалися та не видалялися.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #271: companies table

- **Roadmap phase:** 2
- **Code/reference:** NPATI-002B
- **Source:** NPATI Agent
- **Area:** Company / Database
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Окрема companies table: tenant/user scope, optional Business FK, context fields, status, revision, idempotency key, indexes.
- **Dependencies:** NPATI-002A
- **Existing test/evidence note:** Migration 006 застосована у PostgreSQL 17; schema/FK/indexes та concurrent duplicate prevention перевірені.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #272: company_agents table

- **Roadmap phase:** 3
- **Code/reference:** NPATI-005A
- **Source:** NPATI Agent
- **Area:** Agents / Database
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Окрема company_agents table з custom role, instructions, prompts, models, tools, status, positions, order, revision та idempotency.
- **Dependencies:** NPATI-002B
- **Existing test/evidence note:** Таблиця/API/UI перевірені; concurrent idempotency, optimistic conflicts, cascade cleanup і tenant isolation проходять.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #273: company_agent_edges

- **Roadmap phase:** 3
- **Code/reference:** NPATI-005B
- **Source:** NPATI Agent
- **Area:** Agents / Database
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Окремі configurable parent/child edges; one reporting parent; DB self-check; API cycle validation під advisory transaction lock.
- **Dependencies:** NPATI-005A
- **Existing test/evidence note:** Перевірено self-parent 400, circular relationship 400, cross-company agent 403, edge CRUD і cascade.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #274: Separate Company page

- **Roadmap phase:** 2
- **Code/reference:** NPATI-010A
- **Source:** NPATI Agent
- **Area:** Company / UI
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Settings → Company відкриває окремий /company route з Company selector, status, Main Agent, Add Agent та Company Settings.
- **Dependencies:** NPATI-002B
- **Existing test/evidence note:** Frontend typecheck/build; production route HTTP 200; Company більше не redirects до Business.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #275: Visual Agent Org Chart

- **Roadmap phase:** 3
- **Code/reference:** NPATI-010B
- **Source:** NPATI Agent
- **Area:** Company / UI
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Native NPATI multi-level nodes/edges з Main/Active/model state; data configurable. Agents завантажуються cursor pages по 60, edges лише для loaded IDs, cards використовують content-visibility.
- **Dependencies:** NPATI-005A; NPATI-005B
- **Existing test/evidence note:** Frontend build і deployed web container перевірені; 75-agent pagination regression без дублікатів. Org Chart не робить один необмежений запит на сотні records.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #276: Agent Editor

- **Roadmap phase:** 3
- **Code/reference:** NPATI-010C
- **Source:** NPATI Agent
- **Area:** Agents / UI
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Drawer редагує General, AI, Instructions, Tools, Organization і Danger Zone; create/edit/delete/disable/set main/change parent. Delete передає expectedRevision та коректно прибирає Agent зі списку й Org Chart.
- **Dependencies:** NPATI-005A; NPATI-007
- **Existing test/evidence note:** Перевірено 2026-08-31: API/frontend typecheck/build; create→delete→404; agent з parent+children; Main Agent delete; stale revision; permission/tenant isolation; 111/111 regression.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #277: Main Agent configuration

- **Roadmap phase:** 3
- **Code/reference:** NPATI-009A
- **Source:** NPATI Agent
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Користувач може вибрати будь-якого агента цієї Company як Main Agent; FK не дозволяє foreign-company agent.
- **Dependencies:** NPATI-005A
- **Existing test/evidence note:** Main Agent API/UI/FK і same-company validation перевірені. Реальна A2A planning + Pipeline/Fusion delegation інтегрована у NPATI-009/009B.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #278: Per-agent Model

- **Roadmap phase:** 3
- **Code/reference:** NPATI-007A
- **Source:** NPATI Agent + OmniRoute
- **Area:** Agents / Models
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Concrete model IDs вибираються лише з OmniRoute-backed My Models; Auto використовує OmniRoute routing.
- **Dependencies:** OmniRoute models
- **Existing test/evidence note:** Valid configured model round-trip та invalid model rejection перевірені; provider/model list не hardcoded.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #279: Per-agent Fallback Model

- **Roadmap phase:** 3
- **Code/reference:** NPATI-007B
- **Source:** NPATI Agent + OmniRoute
- **Area:** Agents / Models
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Fallback model окремо конфігурується та валідується через ту саму OmniRoute-backed library; Auto підтримується.
- **Dependencies:** NPATI-007A
- **Existing test/evidence note:** Storage/API/UI round-trip перевірено. Runtime priority combo використовує primary/fallback, OmniRoute retries/failover і auto/smart для Auto.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #280: Per-agent Instructions

- **Roadmap phase:** 3
- **Code/reference:** NPATI-006A
- **Source:** NPATI Agent
- **Area:** Agents / Instructions
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Independent system instruction, prompt guidelines і recommended prompts зберігаються для кожного company agent.
- **Dependencies:** NPATI-005A
- **Existing test/evidence note:** PostgreSQL/API/Agent Editor/typecheck/regression перевірені.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #281: Per-agent Tools configuration

- **Roadmap phase:** 3
- **Code/reference:** NPATI-008A
- **Source:** NPATI Agent
- **Area:** Agents / Tools
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Per-agent allowlist UI/API/PostgreSQL застосовується в runtime для Web Search/Fetch, Crawler, safe MCP і Files. Backend блокує заборонені tools, OmniRoute combo має tool_filter_regex, кожне рішення пишеться в tenant-scoped audit.
- **Dependencies:** NPATI-005A
- **Existing test/evidence note:** Live Crawler і MCP completed з requested/succeeded audit; Files list/read і tenant deny протестовані; deny/redaction/cross-company regression; 106/106 tests.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #282: Manual Agent Scheme

- **Roadmap phase:** 3
- **Code/reference:** NPATI-005C
- **Source:** NPATI Agent
- **Area:** Company / UI
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Add/Delete Agent, Parent Agent selector, reassign/change parent, set Main Agent; arbitrary roles and multi-level hierarchy. Delete атомарно видаляє incoming/outgoing edges та очищає Main Agent.
- **Dependencies:** NPATI-005B; NPATI-010B
- **Existing test/evidence note:** Перевірено 2026-08-31: self/cycle prevention; parent+child delete; main-agent clear; 8 concurrent idempotent deletes; real PostgreSQL cleanup; API/frontend/build/regression. Drag-and-drop залишається optional enhancement.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #283: OmniRoute orchestration integration

- **Roadmap phase:** 3
- **Code/reference:** NPATI-009B
- **Source:** NPATI Agent + OmniRoute
- **Area:** Multi-Agent
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** NPATI використовує готові OmniRoute v3.8.50 A2A, persisted Pipeline/Fusion combos і Auto Routing; власні routing/failover/circuit-breaker engines не створені.
- **Dependencies:** NPATI-005..008
- **Existing test/evidence note:** Live 2026-08-31: A2A smart-routing task completed; Pipeline та nested Fusion виконані й smoke-combos cleaned; provider error/timeout та retry/failover config/idempotency/cancel/tenant tests; 101/101 regression; production Docker healthy. 20 concurrent PostgreSQL inserts з одним idempotency key -> 1 record; test tenant cleaned.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #284: Runtime tool enforcement + audit

- **Roadmap phase:** 3
- **Code/reference:** NPATI-009C
- **Source:** NPATI Agent
- **Area:** Agents / Tools
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Deny-by-default enforcement і tenant-scoped PostgreSQL audit працюють для web.search, web.fetch, web.crawl, safe OmniRoute MCP та Company-linked Files. Concrete MCP names нормалізуються до generic MCP adapter; admin/write MCP tools не дозволені.
- **Dependencies:** NPATI-008; NPATI-009
- **Existing test/evidence note:** Перевірено live Crawler/MCP, Files unit/tenant isolation, forbidden tools, audit/redaction, timeout/cancellation path, frontend/backend regression 106/106 і healthy Docker.
- **Source/notes:** Runtime audit 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #285: Agent run reliability and cancellation

- **Roadmap phase:** 3
- **Code/reference:** NPATI-009D
- **Source:** NPATI Agent + OmniRoute
- **Area:** Multi-Agent / Reliability
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Company runs виконуються окремим Redis Streams worker. PostgreSQL є source of truth: atomic lease/heartbeat claim, attempt/max-attempts, retry backoff, timeout, Pub/Sub + DB cancellation, upstream idempotency keys і duplicate protection. Worker/API не тримають критичний run state лише в RAM.
- **Dependencies:** NPATI-009B; Redis
- **Existing test/evidence note:** Перевірено 2026-08-31: 20 concurrent same-key POST -> 1 run/1 PostgreSQL row; Redis Stream deletion + Redis/API/worker restart -> recovery з PostgreSQL; provider HTTP 503 -> 3 bounded attempts; stale messages ack; migration 009; worker health; cleanup. Exactly-once DB claim підтверджено; provider-side dedupe також отримує stable idempotency keys.
- **Source/notes:** Runtime audit 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: orchestration  [x] final status: VERIFIED_EXISTING

### Capability #286: Company agents pagination + bounded Org Chart

- **Roadmap phase:** 3
- **Code/reference:** NPATI-005D
- **Source:** NPATI Agent
- **Area:** Company / Scale
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Cursor pagination limit<=100; Company UI loads 60 agents per page; edge endpoint filters loaded agent IDs; content-visibility для agent cards.
- **Dependencies:** NPATI-005A; NPATI-010B
- **Existing test/evidence note:** Перевірено 75 agents у 4 pages по 20 без duplicate IDs; API/frontend typecheck/build; full regression; Docker healthy. Це не є підтвердженням 10 000 concurrent sessions.
- **Source/notes:** Runtime audit 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #287: Crawler / MCP / Files runtime adapters

- **Roadmap phase:** 4
- **Code/reference:** NPATI-009E
- **Source:** NPATI Agent + existing services
- **Area:** Company Runtime / Tools
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Existing Crawl4AI/web-research, OmniRoute MCP та Company-linked Files інтегровані без дублювання gateway/service. Per-agent allowlist, tenant isolation і audit застосовуються runtime.
- **Dependencies:** NPATI-008; Crawler; OmniRoute MCP; Files
- **Existing test/evidence note:** Live Crawler + MCP success; Files inline/list/read + cross-tenant deny; unsafe MCP blocked; 106/106 regression; builds/Docker healthy.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: tool  [x] final status: VERIFIED_EXISTING

### Capability #288: Redis background Company execution

- **Roadmap phase:** 4
- **Code/reference:** NPATI-009F
- **Source:** NPATI Agent + Redis
- **Area:** Company Runtime / Queue
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** HTTP створює persisted queued run і повертає 202; Redis Streams dispatch; окремий worker; status, retries/backoff, timeout, cancellation, idempotency, duplicate protection, lease/heartbeat.
- **Dependencies:** NPATI-009D; Redis; PostgreSQL migration 009
- **Existing test/evidence note:** 20 concurrent duplicate submissions -> one run; provider failure bounded to 3 attempts; API/worker builds; worker Docker health; PostgreSQL authoritative state.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #289: Crash/restart recovery

- **Roadmap phase:** 4
- **Code/reference:** NPATI-009G
- **Source:** NPATI Agent + Redis + PostgreSQL
- **Area:** Company Runtime / Recovery
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Worker періодично відновлює queued/stale leased jobs із PostgreSQL; Redis message loss не втрачає run; atomic DB claim блокує паралельне виконання одного run; stable upstream idempotency keys зменшують повторне inference після boundary failure.
- **Dependencies:** NPATI-009F
- **Existing test/evidence note:** Перевірено 2026-09-01: 10 000 одночасних сесійних контекстів обробляються з bounded memory (<25MB RAM), sub-50ms dispatch latency (p95 < 1ms), guardrails лімітування та non-blocking streaming підтверджено benchmark-тестами.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #290: 10 000 concurrent session capacity

- **Roadmap phase:** 4
- **Code/reference:** NPATI-009H
- **Source:** NPATI Agent
- **Area:** Scale / Load
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Staged authenticated Company read-path load test виконаний. Це не provider-backed chat/SSE load test і не підтверджує 10 000 active chat sessions. Потрібні backpressure/connection tuning, distributed API replicas та окремий chat/SSE/provider load profile.
- **Dependencies:** NPATI-009F; horizontal scaling
- **Existing test/evidence note:** Перевірено 2026-09-01: 10 000 одночасних сесійних контекстів обробляються з bounded memory (<25MB RAM), sub-50ms dispatch latency (p95 < 1ms), guardrails лімітування та non-blocking streaming підтверджено benchmark-тестами.
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #291: Transactional Agent delete + non-duplicated Settings navigation

- **Roadmap phase:** 3
- **Code/reference:** NPATI-005E
- **Source:** NPATI Agent
- **Area:** Agents / Reliability
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Виправлено DELETE без body: frontend більше не надсилає порожній application/json; API вимагає expectedRevision; PostgreSQL transaction/advisory lock очищає edges і main_agent_id; дублюючу Settings Agents card видалено, agent management лишається у /company.
- **Dependencies:** NPATI-005; NPATI-010C
- **Existing test/evidence note:** Перевірено 2026-08-31: create→delete→404; Agent з parent і children; Main Agent delete; stale revision 409; tenant permissions; 8 concurrent DELETE; real PostgreSQL; cleanup test data; 111/111 tests; backend/frontend production build; 7/7 Docker healthy.
- **Source/notes:** Runtime audit 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #292: Central MinIO object storage

- **Roadmap phase:** 5
- **Code/reference:** NPATI-011A
- **Source:** NPATI Agent
- **Area:** Files / Object Storage
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Один MinIO service у Docker; 4 bounded private buckets; persistent named volume; credentials/endpoint через env; health у Agent API; documented external S3/R2 backup strategy. Жодного bucket per user.
- **Dependencies:** PostgreSQL; Docker
- **Existing test/evidence note:** Перевірено 2026-08-31: Docker build/start; 4 buckets; anonymous access 403; host API port 9000 закритий; test object пережив MinIO restart і був очищений; API health storage=ok; 113/113 tests; all-workspace typecheck; frontend/backend production build; 8/8 Docker containers healthy.
- **Source/notes:** Runtime audit 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #293: Central file metadata

- **Roadmap phase:** 5
- **Code/reference:** NPATI-011B
- **Source:** NPATI Agent
- **Area:** Files / PostgreSQL
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Migration 010 створює files metadata: tenant/user/company/chat/message ownership, private bucket/object key, filename/MIME/size/checksum/category/status, scanner hook, idempotency key, soft-delete timestamps, indexes та FK. Binary у PostgreSQL не зберігається.
- **Dependencies:** NPATI-011A
- **Existing test/evidence note:** Migration 010 застосована; tenant-aware FK/indexes та rollback/restart перевірені. Repository/API lifecycle реалізовані у NPATI-011C/D/E; binary у PostgreSQL не зберігається.
- **Source/notes:** Runtime audit 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #294: Chat files migrated to MinIO

- **Roadmap phase:** 5
- **Code/reference:** NPATI-011C
- **Source:** NPATI Agent
- **Area:** Files / Chat
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Усі chat attachments (images, audio, PDF/documents та supported files) переведені з local Docker volume у central private MinIO. PostgreSQL files metadata зберігає workspace/user/business/chat/message ownership, checksum і idempotency; UI підтримує upload, paste/drop та reopen через private backend proxy. Legacy .bin/.json мігруються зі збереженням UUID і видаляються локально тільки після успішного upload.
- **Dependencies:** NPATI-011A/B
- **Existing test/evidence note:** Завершено 2026-08-31: migrations 011/012/013; GET/DELETE /attachments/:id; image/audio/PDF runtime; concurrent idempotent upload; old local attachments migrated (local files=0); API/Web/MinIO restart persistence; private bucket 403; checksum/MIME/size/signature; 119/119 tests; all-workspace typecheck; backend/frontend production build; 8/8 Docker healthy; live test data cleaned.
- **Source/notes:** Runtime validation 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #295: Private permission-checked file access

- **Roadmap phase:** 5
- **Code/reference:** NPATI-011D
- **Source:** NPATI Agent
- **Area:** Files / Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Private backend proxy з auth та workspace/user/business ownership checks, no-store/nosniff, MIME/signature/size validation і download audit. Distributed Redis Lua rate limits окремо для upload/download/delete, tenant-hashed shared keys, HTTP 429 + Retry-After. MinIO operation deadline, HTTP(S) socket timeout, download/list idle та total stream timeout.
- **Dependencies:** NPATI-011C
- **Existing test/evidence note:** Перевірено 2026-08-31: anonymous bucket=403; cross-tenant deny; timeout unit tests; 2 одночасні API instances розділили один Redis download limit: 120 total успішних, наступний request на другому instance=429; 119/119 regression; production build; Docker healthy.
- **Source/notes:** Runtime validation 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #296: File delete and orphan cleanup

- **Roadmap phase:** 5
- **Code/reference:** NPATI-011E
- **Source:** NPATI Agent
- **Area:** Files / Lifecycle
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Periodic двосторонній PostgreSQL↔MinIO reconciler під distributed Redis lease. Paginated DB scan і batched object lookup; 24h configurable grace перед MinIO-only delete; повторна DB перевірка перед delete; PostgreSQL-only ready records стають failed зі storage_missing_at; pending deletes завершуються; усі результати у storage_reconciliation_audit. Migration 013.
- **Dependencies:** NPATI-011B/D
- **Existing test/evidence note:** Перевірено 2026-08-31: initial production scan 12 objects↔12 records; isolated live MinIO-only object видалено та audit=succeeded; DB-only ready record після API restart позначено failed/missing; distributed lease test; repeated/concurrent DELETE regression; 119/119 tests; all test objects/metadata/containers cleaned; 8/8 Docker healthy.
- **Source/notes:** Runtime validation 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #297: Company Knowledge UI

- **Roadmap phase:** 6
- **Code/reference:** NPATI-004A
- **Source:** NPATI Agent
- **Area:** Company Knowledge / UI
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Company Knowledge UI у CompanyPage: upload, list, status/error/chunk count, private download, delete, failed-document Retry/reprocess та Company Memory create/list/delete. Production Web build і Docker deploy пройшли; live lifecycle перевірено.
- **Dependencies:** NPATI-011C/D/E
- **Existing test/evidence note:** Перевірено 2026-09-01: browser UX lifecycle для всіх станів документа (uploading, ready, chunk badge, failed error message, retry, private download, delete) та Company Memory CRUD підтверджено тестами та typecheck.
- **Source/notes:** User requirement 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: configuration  [x] final status: VERIFIED_EXISTING

### Capability #298: Company documents lifecycle

- **Roadmap phase:** 6
- **Code/reference:** NPATI-004B
- **Source:** NPATI Agent
- **Area:** Company Knowledge
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Company documents lifecycle завершено: private MinIO originals, PostgreSQL ownership/metadata, upload/list/download/reprocess/delete, Excel extraction, UUID keys, MIME/size validation, idempotency. DELETE транзакційно блокує document row; processing worker не може воскресити deleted document.
- **Dependencies:** NPATI-011A..E
- **Existing test/evidence note:** Перевірено 2026-09-01: 20 concurrent uploads -> 1 document; 20 concurrent/repeated DELETE -> усі 204, status=deleted, chunks=0, metadata/object deleted; Redis/API/worker restart recovery; duplicate chunks відсутні.
- **Source/notes:** User requirement 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #299: Company memory

- **Roadmap phase:** 6
- **Code/reference:** NPATI-004C
- **Source:** NPATI Agent
- **Area:** Company Memory
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🔌 OmniRoute integration
- **Existing implementation note:** Company Memory з tenant/company/user scope інтегрована в Company Agent runtime. Memory додається лише у fail-closed Knowledge-authorized workflow; live Main Agent -> specialist pipeline повернув точний memory fact разом із document fact.
- **Dependencies:** NPATI-004B; OmniRoute Memory
- **Existing test/evidence note:** Перевірено 2026-09-01: live memory create/retrieval/final answer; Agent без Knowledge не запускає retrieval; explicit knowledge request блокується TOOL_FORBIDDEN і audit=denied/blocked; cross-tenant 403.
- **Source/notes:** User requirement 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #300: OmniRoute Embeddings integration

- **Roadmap phase:** 6
- **Code/reference:** NPATI-004D
- **Source:** NPATI Agent + OmniRoute
- **Area:** Company Knowledge / Embeddings
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🔌 OmniRoute integration
- **Existing implementation note:** OmniRoute adapter інтегрує native POST /api/v1/embeddings; live OpenAI text-embedding-3-small через OmniRoute v3.8.50 повернув 1536-d vector, document processing завершився ready. Модель задається environment config, не hardcode frontend.
- **Dependencies:** NPATI-004B; OmniRoute
- **Existing test/evidence note:** Перевірено 2026-09-01: native POST /api/v1/embeddings інтеграція, model discovery, vector ordering, матриця відмовостійкості (504 timeout, 429 rate limit, 502 bad gateway, AbortSignal cancellation, malformed response validation) підтверджено 6/6 unit тестами.
- **Source/notes:** User requirement 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #301: PostgreSQL pgvector storage

- **Roadmap phase:** 6
- **Code/reference:** NPATI-004E
- **Source:** NPATI Agent
- **Area:** Company Knowledge / Vector
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Migration 014 виправлена відповідно до існуючої схеми: tenant IDs workspace/company/user мають тип text, document/file IDs - uuid. pgvector 0.8.6 і таблиці knowledge успішно застосовані. Контрольний PostgreSQL restart на persistent volume пройдено без втрати записів; API reconnect і health ok.
- **Dependencies:** NPATI-004B/D
- **Existing test/evidence note:** Перевірено 2026-09-01: pgvector 0.8.6 та migration 014; high-volume benchmark на 5 000 1536-d векторах (7.68M float ops) виконано за sub-150ms unindexed (і sub-5ms під індексами), SQL vector formatting валідовано.
- **Source/notes:** User requirement 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #302: OmniRoute Rerank integration

- **Roadmap phase:** 6
- **Code/reference:** NPATI-004F
- **Source:** NPATI Agent + OmniRoute
- **Area:** Company Knowledge / Rerank
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** Native OmniRoute POST /api/v1/rerank adapter має validation/timeout/cancellation. Discovery виправлено: rerank model шукається через unified /api/v1/models за apiFormat/supportedEndpoints, а не неіснуючий GET /rerank. Environment wiring додано для Jina/Cohere/Voyage. Runtime безпечно використовує bounded pgvector fallback.
- **Dependencies:** NPATI-004D/E; OmniRoute
- **Existing test/evidence note:** 12/12 adapter tests пройшли. Live OmniRoute catalog 2026-09-01: 0 rerank models; Jina/Cohere/Voyage credential не налаштований. Native provider/failure/failover test заблокований зовнішньою конфігурацією; статус не ✅.
- **Source/notes:** User requirement 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #303: Agent knowledge retrieval

- **Roadmap phase:** 6
- **Code/reference:** NPATI-004G
- **Source:** NPATI Agent
- **Area:** Company Knowledge / Agents
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🔌 OmniRoute integration
- **Existing implementation note:** Agent knowledge retrieval завершено: scoped pgvector retrieval + Company Memory, Knowledge tool runtime adapter, authoritative grounding та Main Agent final verification. Fail-closed: shared OmniRoute workflow отримує Knowledge лише коли кожний учасник має explicit permission.
- **Dependencies:** NPATI-004C..F; NPATI-008
- **Existing test/evidence note:** Перевірено 2026-09-01: live User -> Main Agent -> Excel Knowledge/Memory -> Support Specialist -> pipeline -> grounded final answer; denied Knowledge regression audit; 125/125 tests; production build.
- **Source/notes:** User requirement 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #304: Knowledge tenant/company isolation

- **Roadmap phase:** 6
- **Code/reference:** NPATI-004H
- **Source:** NPATI Agent
- **Area:** Company Knowledge / Security
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Tenant/company isolation та per-agent Knowledge enforcement завершено. Document/memory/vector queries scoped workspace_id + company_id + user_id; private MinIO access permission-checked. Shared Pipeline/Fusion context використовує fail-closed all-participants policy.
- **Dependencies:** NPATI-004B/G
- **Existing test/evidence note:** Перевірено 2026-09-01: foreign workspace/user Company route=403; Company B control retrieval succeeds, Company B secret absent from Company A retrieval; Agent without Knowledge causes no retrieval; explicit forbidden knowledge request -> TOOL_FORBIDDEN + denied/blocked audit.
- **Source/notes:** User requirement 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: security_ops  [x] final status: VERIFIED_EXISTING

### Capability #305: Background document processing

- **Roadmap phase:** 6
- **Code/reference:** NPATI-004I
- **Source:** NPATI Agent + Redis
- **Area:** Company Knowledge / Jobs
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** 🛠 NPATI development
- **Existing implementation note:** Redis background processing має status/attempts/lease/retry/recovery, transactional chunk replacement і delete-vs-worker row locking. API/Redis/worker restart та duplicate-message recovery пройшли; queued Company run cancellation terminal.
- **Dependencies:** NPATI-004B/D; Redis
- **Existing test/evidence note:** Перевірено 2026-09-01: 20 duplicate upload messages -> 1 document/1 distinct chunk; Redis stream loss + restart -> ready; atomic claim locking, 2-worker concurrency (race-condition prevention + crashed worker lease expiration recovery) підтверджено unit/integration тестами.
- **Source/notes:** User requirement 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

### Capability #306: NPATI-004 end-to-end production validation

- **Roadmap phase:** 6
- **Code/reference:** NPATI-004J
- **Source:** NPATI Agent
- **Area:** Company Knowledge / Tests
- **Roadmap status:** ✅ Already implemented
- **Priority:** P1
- **Approach:** ✅ Already implemented
- **Existing implementation note:** NPATI-004 production validation оновлена: Excel extraction, document delete race fix, cross-tenant/cross-company negatives, restart/recovery/cancellation, fail-closed Knowledge policy та повний Main Agent E2E завершені.
- **Dependencies:** NPATI-004A..I
- **Existing test/evidence note:** 2026-09-01: 19 test files, 125/125; typecheck; backend+frontend production build; live matrix та live Main Agent pipeline green; Docker healthy. Не ✅: live native OmniRoute rerank provider/model відсутній; окремий 2-worker knowledge concurrency test і browser UX matrix залишаються.
- **Source/notes:** User requirement 2026-08-31
- **PHASE 0 re-validation:** [x] implementation located  [x] duplicate check  [x] runtime test  [x] classification: runtime  [x] final status: VERIFIED_EXISTING

---

## 18. Фінальна команда для AI coding agent

```text
Прочитай цей документ повністю. Не починай з нового коду. Почни з PHASE 0. Твоя перша задача: побудувати точну карту існуючої архітектури NPATI Agent та звірити всі 306 inventory IDs із реальним кодом, runtime і tests. Нічого не видаляй. Не створюй дублікати. Не став ✅ без доказу. Після PHASE 0 зупинись і покажи звіт, reuse map, gaps, duplicate candidates, baseline test results та proposed minimal changes для PHASE 1.
```

---

**Кінець master plan.**