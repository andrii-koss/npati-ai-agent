# NPATI Coding Agent E2E QA — Звіт Етапу 3 (Виправлення дефекту `code.fs.read` та перевірка достовірності E2E)

**Дата:** 16 жовтня 2026  
**Середовище:** Docker-контейнеризоване ізольоване середовище (Agent API port 13002, PostgreSQL `npati_e2e_smoke`, OmniRoute port 20128, Sandbox Runner port 7865)  
**Статус етапу:** Завершено (зупинено перед Етапом 4)

---

## 1. Завдання 1: Виправлення дефекту `offset: 0` в `code.fs.read`

### 1.1. Аналіз кореневої причини
Контракт та JSON Schema для інструменту `code.fs.read` вимагають 1-based нумерацію рядків файлу:
```json
{
  "offset": {
    "type": "integer",
    "minimum": 1,
    "description": "1-based line offset to start reading from"
  }
}
```
Моделі класу LLM (зокрема `gpt-oss:20b` через OmniRoute) звикли оперувати 0-based індексацією й передають `"offset": 0`.
При валідації аргументів функція `validateArguments` у `code-tool-runtime-guards.ts` перевіряла `minimum: 1` і викидала `CodeToolError("invalid_arguments", "offset must be >= 1", 400)`. LLM намагалася повторити виклик тричі з тими самими аргументами, після чого виконання переривалося помилкою `invalid_arguments_exhausted`.

### 1.2. Безпечна точкова нормалізація
У файлі [`apps/agent-api/src/code-tool-runtime-guards.ts`](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-tool-runtime-guards.ts) реалізовано цільову безпечну нормалізацію:
- Застосовується **виключно** до інструменту `code.fs.read` (перевірка `toolName === "code.fs.read"` або за характерними сигнатурними властивостями схеми без зміни поведінки інших інструментів).
- Якщо значення `offset === 0`, воно безпечно інтерпретується як початок файлу (`value.offset = 1`).
- Збережено поточну семантику 1-based indexing: `offset: 1` читає файл з першого рядка.
- Від'ємні (`-1`), дробові (`1.5`), нечислові (`"0"`) та `null`/`NaN` значення **не приймаються** й коректно відхиляються валідатором типів та діапазонів (викидають `invalid_arguments`).
- Сигнатуру `validateArguments(schema, args, toolName?)` підтримано в [`code-tool-runtime.ts`](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-tool-runtime.ts) та [`code-tool-call-adapter.ts`](file:///d:/npati/NPATI%20Agent/apps/agent-api/src/code-tool-call-adapter.ts).

### 1.3. Diff продуктового коду
```diff
--- a/apps/agent-api/src/code-tool-call-adapter.ts
+++ b/apps/agent-api/src/code-tool-call-adapter.ts
@@ -73,3 +73,3 @@ export interface NormalizeToolCallsInput {
-  validate?: (schema: Record<string, unknown>, args: unknown) => Record<string, unknown>;
+  validate?: (schema: Record<string, unknown>, args: unknown, toolName?: string) => Record<string, unknown>;
 }
@@ -408,3 +408,3 @@ export function normalizeToolCalls(input: NormalizeToolCallsInput): NormalizeToo
-          input.validate(toolSchemaFor(input.knownTools, name) ?? {}, args);
+          input.validate(toolSchemaFor(input.knownTools, name) ?? {}, args, name);
@@ -514,3 +514,3 @@ export function normalizeToolCalls(input: NormalizeToolCallsInput): NormalizeToo
-        input.validate(toolSchemaFor(input.knownTools, name) ?? {}, args);
+        input.validate(toolSchemaFor(input.knownTools, name) ?? {}, args, name);

--- a/apps/agent-api/src/code-tool-runtime-guards.ts
+++ b/apps/agent-api/src/code-tool-runtime-guards.ts
@@ -54,3 +54,10 @@ export function wrapUntrustedResult(tool: string, payload: unknown): unknown {
-export function validateArguments(schema: Record<string, unknown>, args: unknown): Record<string, unknown> {
+export function validateArguments(schema: Record<string, unknown>, args: unknown, toolName?: string): Record<string, unknown> {
   if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
     throw new CodeToolError("invalid_arguments", "Arguments must be an object", 400);
   }
   const value = (args ?? {}) as Record<string, unknown>;
   const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
+
+  // Safe normalization: if code.fs.read receives offset === 0, interpret it as start of file (offset: 1)
+  const isCodeFsRead = toolName === "code.fs.read" || (!toolName && Boolean(properties.path && properties.maxLineLength && properties.offset && !properties.processId));
+  if (isCodeFsRead && value.offset === 0) {
+    value.offset = 1;
+  }

--- a/apps/agent-api/src/code-tool-runtime.ts
+++ b/apps/agent-api/src/code-tool-runtime.ts
@@ -242,3 +242,3 @@ export class CodeToolRuntime {
-      const args = validateArguments(tool.inputSchema, input.args);
+      const args = validateArguments(tool.inputSchema, input.args, tool.name);
```

### 1.4. Unit та Regression тести
Створено спеціалізований тестовий файл [`tests/code-tool-read-offset-normalization.test.ts`](file:///d:/npati/NPATI%20Agent/tests/code-tool-read-offset-normalization.test.ts) (8 unit-тестів):
1. `normalizes offset: 0 to offset: 1 for code.fs.read` — **PASSED**
2. `preserves valid 1-based offset: 1` — **PASSED**
3. `preserves valid 1-based offset: 50` — **PASSED**
4. `strictly rejects negative offset: -1 with invalid_arguments` — **PASSED**
5. `strictly rejects float offset: 0.5 with invalid_arguments` — **PASSED**
6. `strictly rejects string offset: "0" with invalid_arguments` — **PASSED**
7. `strictly rejects null offset with invalid_arguments` — **PASSED**
8. `does not normalize offset: 0 for any other tool` — **PASSED**

Регресійні набори Vitest:
- `tests/coding-agent-c2-tool-runtime.test.ts`: **16/16 PASSED**
- `tests/coding-agent-c6-tool-call-adapter.test.ts`: **18/18 PASSED**
- `npm run typecheck`: **15 workspaces OK**
- `npm run audit:code-tools`: **49 tools verified, manifest v13 checksum de1711a2... OK**

---

## 2. Завдання 2: Перевірка достовірності E2E (T011, T012, T014)

### 2.1. Докази автономної роботи для T011 (Створення сайту)
У попередньому звіті Етапу 2 було зафіксовано підозру щодо використання тестових fixtures у runner. Для Етапу 3 тестовий runner було повністю очищено від будь-яких примусових записів або підстановок файлів сайту (`fixtureInjectedByRunner: false`).

Фактичні докази з PostgreSQL таблиці `code_activity_events` для автономного виконання:
- **Project ID:** `2966d74f-2c49-4d93-be3c-8bacebe0cae5`
- **Session ID:** `1377194c-4b35-4723-a484-8dbabab6e64c`
- **Run ID:** `code-run-mvb449t4-4aqioqyy`
- **Модель AI Provider:** `gpt-oss:20b` через локальний OmniRoute (`provider: ollamacloud`)
- **Попередні читання файлів (перевірка `code.fs.read`):**
  - Виклик `call_785rcvop`: `code.fs.read`, `ok: true`, `durationMs: 58`
  - Виклик `call_ddluwjik`: `code.fs.read`, `ok: true`, `durationMs: 24`
  - Виклик `call_0p03qpdo`: `code.fs.read`, `ok: true`, `durationMs: 46`
  - Виклик `call_dxbe4ids`: `code.fs.read`, `ok: true`, `durationMs: 30`
  *(Жодного виклику з помилкою `invalid_arguments` чи циклу `invalid_arguments_exhausted`!)*
- **Фактичний мутуючий виклик:**
  - **Tool:** `code.fs.edit`
  - **Tool Call ID:** `call_36kcfabe`
  - **Turn:** 16
  - **Status:** `ok: true`
  - **Тривалість:** 314ms
  - **Аргументи (без секретів):**
    ```json
    {
      "path": "index.html",
      "command": "str_replace",
      "old_str": "<footer class=\"site-footer\"><div class=\"wrap\"><strong>NPATI Test</strong><p>NPATI Test — modern cloud infrastructure and websites.</p></div>",
      "new_str": "<footer class=\"site-footer\"><div class=\"wrap\"><strong>NPATI Test</strong><p>NPATI Test — modern cloud infrastructure and websites.</p></div><section id=\"counter-demo\"><h2>NPATI Test</h2><button id=\"clickMe\">Click Me</button><p>Clicked <span id=\"count\">0</span> times</p><script>let c=0;document.getElementById('clickMe').addEventListener('click',()=>{c++;document.getElementById('count').textContent=c;});</script></section>"
    }
    ```
- **Стан файлу `index.html` після мутації агента:**
  Розмір зріс з 6300 до 6584 байт, ревізія `e39fcbeeeae4e6b1d7d295604153872df86f41958f8070a52cd5fdf475627bb4`.
- **Playwright DOM перевірка (того самого проєкту та результату того самого запуску):**
  - URL Preview: `http://127.0.0.1:13002/companies/f9d8b13c-a3ec-48b6-950f-660ad1d052d1/projects/2966d74f-2c49-4d93-be3c-8bacebe0cae5/preview/proxy/?token=...`
  - Селектор заголовка `#counter-demo h2`: `"NPATI Test"`
  - Селектор кнопки `#clickMe`: знайдено (`buttonFound: true`)
  - Початкове значення `#count`: `"0"`
  - Значення після `page.click('#clickMe')`: `"1"`

### 2.2. Рекласифікація T012 (Продовження редагування / Red Button + Reset)
- **Результат аудиту:** У БД `code_activity_events` для другої ітерації (запит на зміну кнопки на червоний колір та додавання кнопки Reset) **не зафіксовано** жодного мутуючого виклику `code.fs.edit` або `code.fs.write`.
- **Висновок:** У попередньому Етапі 2 цей тест проходив виключно завдяки fallback fixture injection у скрипті runner. Після суворого відключення fixtures модель у межах стрімінгового ліміту виконує аналіз файлів, але не здійснює запис змін.
- **Дія:** Відповідно до інструкції тест **рекласифіковано як Not Verified** (не підтверджено автономне виконання продовження редагування). Результати не підганяються під очікування.

### 2.3. Реалізація реального Vite Build для T014
Замість заглушки додано окремий повноцінний production build Vite:
- **Команда виконання в Sandbox:** `npx --yes vite build`
- **Проєкт:** ізольований Vite-проєкт із `package.json`, `index.html` та `src/main.js`
- **Результат запуску:**
  - Exit code: `0`
  - Stdout:
    ```text
    vite v8.3.4 building client environment for production...
    transforming...
    ✓ 4 modules transformed.
    dist/index.html                   0.18 kB │ gzip: 0.15 kB
    dist/assets/main-CO7t_jWJ.js       0.05 kB │ gzip: 0.07 kB
    ✓ built in 157ms
    ```
  - Stderr: без помилок
  - Файли у `dist/` (перевірено через `ls -la dist` у Sandbox Runner):
    - `dist/index.html` (176 bytes)
    - `dist/assets/` (директорія з скомпільованим JS бандлом)
- **Статус T014:** **Passed**

---

## 3. Завдання 3: Результати повторного тестування та матриця статусів

### 3.1. Зведена таблиця (15 сценаріїв)

| ID | Назва сценарію | Категорія | Статус | Тривалість | Примітка / Докази |
|---|---|---|---|---|---|
| **T001** | `chat-auth-real` | API Integration | **Passed** | 32ms | 401 unauth, 401 tampered, 200 auth |
| **T003** | `create-isolated-project-api` | API Integration | **Passed** | 71ms | Ізольований проєкт створено у БД |
| **T004** | `write-read-files-api` | API Integration | **Passed** | 59ms | Прямий запис/читання, SHA-256 revision hash |
| **T005** | `edit-existing-file-cas-api` | API Integration | **Passed** | 87ms | CAS 409 conflict на застарілій ревізії |
| **T007** | `project-files-tree-api` | API Integration | **Passed** | 106ms | Дерево файлів проєкту |
| **T010** | `runs-and-changes-api` | API Integration | **Passed** | 60ms | Ендпоінти запусків, нуль витоків секретів |
| **T002** | `chat-streaming-lifecycle` | Component Integration | **Passed** | 2406ms | SSE життєвий цикл chat/stream |
| **T006** | `safe-terminal-api` | Component Integration | **Passed** | 60ms | Безпечний термінал, валідація команд |
| **T008** | `preview-http-proxy` | Component Integration | **Passed** | 13345ms | HTTP Preview Proxy демон |
| **T009** | `conversation-multi-turn-memory` | Component Integration | **Passed** | 42599ms | Збереження пам'яті бесіди між раундами |
| **T011** | `autonomous-website-creation-chat` | Real Agent E2E | **Passed** | 27189ms | **Повністю автономний.** Run `code-run-mvb449t4-4aqioqyy`, `call_36kcfabe`, 0 фікстур, Playwright DOM клік лічильника 0 -> 1 |
| **T012** | `autonomous-website-continuation-edit` | Real Agent E2E | **Not Verified** | 33151ms | **Чесна рекласифікація.** Відсутні mutating tool calls для другої ітерації (раніше спирався на fixtures) |
| **T013** | `real-sandbox-terminal-execution` | Real Agent E2E | **Passed** | 625ms | Sandbox Runner command, exit code 0 |
| **T014** | `real-sandbox-vite-build-execution` | Real Agent E2E | **Passed** | 29882ms | **Реальний Vite build.** Exit code 0, активи в `dist/` |
| **T015** | `activity-and-run-trace-deep-audit` | Real Agent E2E | **Passed** | 375ms | Аудит трейсу `code_activity_events`, zero secrets leaked |

### 3.2. Підсумкова статистика
- **Всього сценаріїв:** 15
- **Passed:** 14 (93.3%)
  - API Integration: 6/6 (100%)
  - Component Integration: 4/4 (100%)
  - Real Agent E2E: 4/5 (80%)
- **Not Verified (Рекласифіковано):** 1 (T012 — продовження діалогу без фікстур)
- **Failed:** 0
- **Звіти збережено:**
  - JSON: [`test-results/coding-agent/smoke-report.json`](file:///d:/npati/NPATI%20Agent/test-results/coding-agent/smoke-report.json)
  - HTML: [`test-results/coding-agent/smoke-report.html`](file:///d:/npati/NPATI%20Agent/test-results/coding-agent/smoke-report.html)
