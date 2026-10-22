# Крок 7 — аудит 51 падіння Security Gate

**Тип:** виключно аудит. Нічого не виправлено, security policy / gates / sandbox / код / тести не змінювалися.
**Дата:** 2026-10-21. **Після:** [Крок 6](step-6-final-performance.md).

---

## 0. Метод і докази

| Джерело | Що містить |
|---|---|
| `artifacts/gate-after.json` | фінальний прогін gate: **2787 passed / 51 failed**, 183 suites |
| `artifacts/gate-failing-current.json` | 11 файлів із 51 падінням, повні assertion-повідомлення (робоче дерево) |
| `artifacts/gate-failing-head.json` | ті самі 11 файлів на **чистому HEAD** (`git stash -u`): **51 failed / 221** |
| `artifacts/gate-failing-messages.txt` | текст помилок для кожного тесту |

**Порівняння HEAD ↔ робоче дерево:** набори падінь **побайтово ідентичні** (51 = 51, `Compare-Object` → порожньо).
Отже жодне з 51 падіння не внесене Кроками 1–6 — і саме тому нижче кожне класифікується по суті, а не
«pre-existing, отже нешкідливо».

---

## 1. Групи першопричин

| Група | Тестів | Першопричина | Категорія |
|---|---|---|---|
| **A. Manifest/catalog pins** | 15 | HEAD-коміт `b545d0c` додав 50-й інструмент `code.data.backend.create` і підняв manifest до **v14**, але не оновив `TOOL_SCHEMA_MANIFEST_VERSION` (13), `STATIC_CATALOG_BASELINE.total` (397) і піни в тестах | Configuration Mismatch |
| **B. C13 MCP runtime overlay** | 24 | У gate-середовищі discovery дає **порожній overlay** (`runtime_mcp_manifest_unavailable`): MCP-інструмент не потрапляє в каталог, модельний виклик не виконується, approval-пауза не настає | Not Verified |
| **C. Semantic intent** | 9 | Коміт `chat-5` додав детермінований short-circuit для CREATE_* (`chat-project-intent.ts:72-76`), який обходить семантичний класифікатор | Test Defect (7) + Configuration Mismatch (2 із реальним ризиком) |
| **D. Preflight cancellation** | 2 | Той самий short-circuit: «Build a website…» більше не викликає провайдера, тест чекає на нього → timeout 10 с | Test Defect (похідна від C) |
| **E. C6 cancellation telemetry** | 1 | Скасування під час першого model call не емітує `planning/completed`; тест цього очікує | Test Defect |

---

## 2. Група A — 15 падінь: manifest/catalog pins

**Причина.** `CODE_TOOL_MANIFEST_VERSION = 14` (`code-tool-registry.ts`), published JSON `manifestVersion: 14`,
50 tools. У `packages/shared/src/capability-catalog-audit-types.ts`:
`TOOL_SCHEMA_MANIFEST_VERSION = 13` і `STATIC_CATALOG_BASELINE = { total: 397, agentCallable: 133, runtimeOnly: 264 }`.
Каталог уже містить **398** записів. Тобто один коміт (`b545d0c HTML/CSSPreview-2`) додав
`code.data.backend.create` і не оновив жоден із трьох пінів.

| # | Файл / тест | Очікувано → фактично |
|---|---|---|
| 12 | `c11-git-workflow` › publishes the git tools in v8… | `CODE_TOOL_MANIFEST_VERSION === 13` → **14** |
| 13 | `c12-subagent-workflow` › publishes it in manifest v9… | 13 → **14** |
| 51 | `c9-plan-tool` › publishes the planning tools… | 13 → **14** |
| 14 | `c13-capability-catalog-audit` › reads the exported arrays… | `checkStaticCatalogIntegrity().ok === true` → **false** (`static_catalog_total_pin`: 398 vs 397) |
| 15 | › resolves the four separate checks… | `report.ok === true` → **false** (staticManifestParity: v13 vs v14) |
| 16 | › fails when a capability is pushed… | 398 (очік. 397) → **399** |
| 17 | › fails when a capability is removed… | 396 → **397** |
| 18 | › fails when pushed into CAPABILITY_MATRIX… | 398 → **399** |
| 19 | › fails the combined Inspector view… | 398 → **399** |
| 20 | › keeps the static count independent… | 397 → **398** |
| 21 | › shows both sources… | 397 → **398** |
| 22 | › keeps the checks separate… | `report.ok` false |
| 23 | › matches the published manifest v9… | v13 → **v14** (37 code tools → 38) |
| 24 | › negative control: pushed tool missing… | версія/parity → fail |
| 49 | `c13-mcp-runtime-capabilities` › keeps the static counts… | 397 → **398** |

**Це не runtime-уязвимість, але й не «ніщо».** Піни існують, щоб змусити рев'ю кожної нової capability. Новий
`code.data.backend.create` має `agentCallable: true`, `risk: "medium"`, **`requiresConfirmation: false`** у каталозі
(він входить до `CODE_WRITE_TOOLS`, тож під write-флагом). Гейт «закричав», але замість рев'ю піни лишилися
старими — сигнал не був оброблений. Ризик: **середній (governance)**, пріоритет **P1**.

**Рекомендація:** переглянути нову capability (risk/approval), оновити `TOOL_SCHEMA_MANIFEST_VERSION` до 14,
`STATIC_CATALOG_BASELINE` до 398/134/264 (після підтвердження розподілу) і піни в C9/C11/C12. Це механічна,
але **усвідомлена** дія — не «щоб зеленило».

---

## 3. Група B — 24 падіння: C13 MCP

| # | Файл / тест | Очікувано → фактично |
|---|---|---|
| 25 | `c13-mcp-approval-flow` › pauses the run on approval_required… | `waiting_for_user` → **`completed`** |
| 26–35 | › hashes the same material…, refuses second use…, refuses another tool…, asks once per call…, owner/admin downgrade…, rejected record…, timed-out wait…, cancelled wait…, restart…, schema hash… | «run reported no pending approval» → **pendingApprovals порожній** |
| 36 | `c13-mcp-run-path-wiring` › discovers before the model-visible tool list… | індекс discovery `-1` (не викликався) |
| 37 | `c13-mcp-run-path` › keeps the default fail-closed… | `dialled === false` → **undefined** (виклику не було) |
| 38–41 | › executes through the Integration…, refuses credential…, bounds oversized…, injected instruction… | 2 повідомлення замість 3; `result.data`/`truncated` → **undefined** |
| 42 | › refuses a replay against a changed schema… | `runtime_mcp_manifest_changed` → **`runtime_mcp_manifest_unavailable`** |
| 43 | › does not move the static catalog… | 385 static + N → інші числа (каталог виріс) |
| 44–47 | › negative controls (no Integration, disabled, discovery throws, flag off) | очікувані коди → інші/порожні |
| 48 | › C14 replay with arguments_hash… | replay не відбувся (немає manifest) |

**Що доведено:**

- Механізм паузи **працює**: `approvalPauseFrom` (`coding-agent-tool-waves.ts:84-104,568-573`) + `runState.markWaitingForUser`
  → статус `waiting_for_user`. Це підтверджено Кроком 6, сценарій 11 (той самий runner, `approval_required` →
  `waiting_for_user`, 0 verify, 0 review).
- У gate-середовищі **discovery повертає порожній overlay**: `runtime_mcp_manifest_unavailable`, MCP-інструмент
  відсутній у каталозі, модельний виклик не доходить до runtime, тому approval-пауза не настає. Це **fail-closed**
  (немає інструмента → немає виклику → немає дії), але **шлях «discovered tool → approval → consume → execute»
  не покритий жодним зеленим тестом**.

**Ризик:** безпека виконання не порушена (fail-closed), але **approval-контроль MCP не верифікований** — а це саме
той контроль, який відрізняє MCP від довільного tool-виклику. Якщо MCP увімкнено у проді, це **P0**; якщо
вимкнено флагом `code.mcp` — P2 до ввімкнення.

**Що потрібно:** з'ясувати, чому discovery порожній саме в harness (найімовірніше — застарілий test-double:
`configuredIntegrationsFrom`/policy-store контракт змінився після `64026c2`), і зробити suite зеленим **до**
ввімкнення MCP. Не «оновити очікування», а довести, що discovery + approval працюють end-to-end.

---

## 4. Група C — 9 падінь: semantic intent

**Причина.** `chat-project-intent.ts:72-76`:

```ts
if (["CREATE_WEBSITE","CREATE_PROJECT"].includes(deterministic.intent) && planTargets.length > 0)
  return { decision: deterministic, targets: planTargets, source: "deterministic" };
```

Класифікатор більше не викликається для очевидних creation-запитів (`chat-5`).

| # | Тест | Очікувано → фактично | Оцінка |
|---|---|---|---|
| 1 | finishes cancellation even when provider ignores signal | `chat` called once → **0** | Test Defect |
| 2 | propagates cancellation to the provider… | rejects → **resolves** | Test Defect |
| 3 | redacts credentials… | `chat` called once → **0** | Test Defect |
| 6 | preserves full specifications… | `mock.calls[0][0]` → **undefined** | Test Defect |
| 7–9 | rejects invalid or uncertain model decisions (×3) | `chat` called once → **0** | Test Defect |
| **4** | **respects non-execution: «How do I create a website?»** | **CHAT → CREATE_WEBSITE** | **реальний ризик** |
| **5** | **«Review this example prompt: create a store and fix bugs»** | **CHAT → CREATE_WEBSITE** | **реальний ризик** |

Тести 4–5 — не косметика: `chat-stream-routes.ts:151-157` бере `semantic.decision`, а `:180` для CREATE_WEBSITE
**створює проєкт** і запускає ран. Детермінований класифікатор не має евристики питань (інструкція семантичного
класифікатора, `chat-project-intent.ts:24`, прямо каже, що питання → CHAT, але її більше не питають).
Тобто питання на кшталт «як створити сайт?» може створити проєкт і запустити агента — **не security bypass, але
реальний поведінковий дефект** (зайві витрати, несподівані зміни).

**Ризик:** середній; **P1**. Виправлення: не пропускати семантичний крок, коли текст є питанням/порадою
(наприклад, перевірка `?`/питальних конструкцій або повернення до семантичного класифікатора для CREATE_* без
явного імператива), і оновити тести 1–3,6–9 під новий швидкий шлях.

---

## 5. Група D — 2 падіння: preflight cancellation

| # | Тест | Очікувано → фактично |
|---|---|---|
| 10 | cancels provider preflight before SSE headers… | провайдер входив у виклик → **timeout 10 000 мс** (`f.started` ніколи) |
| 11 | propagates client disconnect while routing pending… | те саме |

Обидва тести посилають `"Build a website with a gallery"` і чекають, що route викличе `engine.chat` (preflight).
Через short-circuit із групи C провайдер не викликається, `await f.started` висить → timeout. Це **не регресія
cancellation-механізму**, але властивість «cancellation до SSE-заголовків» тепер **не верифікована** (тест не
доходить до перевірок). Ризик: низький для безпеки, **P2**; після фіксу C тести знову перевірять те, що мали.

---

## 6. Група E — 1 падіння: C6 telemetry

| # | Тест | Очікувано → фактично |
|---|---|---|
| 50 | does not execute model tool calls that resolve after cancellation | `events.some(planning && completed) === true` → **false** |

Токени (18) і `model_call/completed` збережені, статус `cancelled`, tool calls 0 — але подія `planning/completed`
не емітується, бо ран скасовано посеред першого model call. Це узгоджено з «не завершувати етап, який не
завершився», але тест очікує завершення. Ризик: **низький** (лише телеметрія Activity), **P3**.

---

## 7. Чи приховують однакові падіння реальні проблеми?

**Так, у трьох місцях:**

1. **MCP approval (24 тести).** Те, що вони червоні і на HEAD, не означає «нічого не сталося»: воно означає, що
   approval-шлях не верифікований. Fail-closed робить це безпечним *зараз*, але ввімкнення MCP без зеленого
   end-to-end тесту — це реліз неперевіреного контролю.
2. **Semantic routing (2 тести).** «Pre-existing» тут = «поведінковий дефект з коміту chat-5», а не «застарілий
   тест». Питання може запустити створення проєкту.
3. **Pins (15 тестів).** Гейт перестав виконувати свою функцію: нова capability додана без оновлення пінів, тобто
   рев'ю, яке піни мали форсувати, не відбулося.

**Де однаковість справді безпечна:** C6 telemetry (1) і D (2) — їхні перевірки не виконуються/не стосуються
контролю доступу; після фіксу C вони, найімовірніше, позеленіють.

---

## 8. Блокери релізу

| Група | Блокує production? | Чому |
|---|---|---|
| B (MCP) — якщо `code.mcp` увімкнено | **ТАК (P0)** | approval-шлях не верифікований; fail-closed зараз, але контроль не доведений |
| B — якщо MCP вимкнено флагом | Ні (P2) | інструменти не discovery-яться, виклик неможливий |
| C (routing) | **ТАК (P1)** | питання може створити проєкт і запустити ран |
| A (pins) | **ТАК для gate (P1)** | security gate — release control; 15 червоних тестів означають, що гейт не може служити доказом |
| D (preflight) | Ні (P2) | похідна від C; після фіксу C перевіряється знову |
| E (telemetry) | Ні (P3) | Activity-подія, не контроль |

---

## 9. Висновок

**Release Blocked.**

Обґрунтування: (1) security gate — це release control, і він червоний (51/51 ідентичні HEAD, тобто Кроки 1–6 не
винні, але й не виправляють); (2) MCP approval-контроль не має жодного зелёного end-to-end тесту — fail-closed
зараз, але це не доведений контроль; (3) semantic short-circuit може запускати створення проєкту на питання.

Шлях до **Conditionally Ready** (без зміни security policy):

1. P1: оновити три піни (manifest 14, catalog 398) **після** явного рев'ю `code.data.backend.create`
   (risk/approval) — це робить групу A зеленою і повертає гейту сенс.
2. P1: відновити семантичний крок для питальних/порадних формулювань (група C) і оновити 7 тестів під новий
   швидкий шлях; група D позеленіє автоматично.
3. P0/P2: або зробити C13 MCP suite зеленим (знайти причину порожнього overlay в harness і довести
   discovery→approval→execute), або тримати `code.mcp` вимкненим і зафіксувати це як відомий стан.
4. P3: узгодити очікування C6 telemetry (емітити `planning/failed` при скасуванні або оновити тест).

Після 1–3 gate має бути зеленим **без** жодного послаблення політики; доти реліз вважається заблокованим.
