# NPATI Coding Agent — E2E звіт про розгортання фреймворків

**Дата:** 20 жовтня 2026  
**Середовище:** локальний self-hosted NPATI, `http://127.0.0.1:13001/chat`; shared Sandbox Runner; agent-api і company-worker з кодом `chat-runtime-fix-20261019-r32` (оновлено через `docker cp` + restart); runner image `npati-isolated-source-20261011-sandbox-runner:framework-20261020`; PHP 8.3.35 і Composer 2.10.2 у runner  
**Модель:** `deepseek-flash` через OmniRoute  
**Метод:** реальні запити в UI `/chat` через Playwright, не прямі API-скрипти створення проєктів. Кожен PASS вимагає: створення проєкту → install → production build/verify → Live Preview → Browser QA → редагування того самого проєкту → повторна перевірка зміненого preview.

> **Підсумок (після нового прогону 16:00–16:18):** мета **15/15 PASS не досягнута**, але кількість підтверджених PASS збільшено до **5**: React + Vite, Vue 3 + Vite, SvelteKit, FastAPI і **Astro**. Nuxt цього разу дійшов до Live Preview і edit того самого проєкту, але Browser QA падає на Vue hydration (`Context conflict` / `beforeEach`), тому Nuxt — PARTIAL. Express/Fastify/NestJS після bounded retry зупинені без PASS; HTML/CSS і Flask — PARTIAL. Angular, Remix, Django, Laravel — NOT TESTED/BLOCKED. Я не позначав неперевірені прогони як PASS.

---

## 1. Що реально перевірено в контейнерах

| Компонент | Перевірка | Результат |
|---|---|---|
| `agent-api` | `/api/auth/me`, `/api/chat/development/processes`, `/preview/status` | працює, healthy |
| `company-worker` | новий `dist` доставлено, restart, healthy | працює |
| `sandbox-runner` | `/health`, PHP, Composer, `/projects` (85 проєктів збережено) | healthy |
| Runner image | `php -v` → PHP 8.3.35; `composer --version` → 2.10.2 | працює |
| Code consistency | API/Worker — `chat-runtime-fix-20261019-r32`; runner — той самий `dist` у `framework-20261020` | узгоджено |
| Docker project | `npati-isolated-source-20261011`; випадково створений `npatiagent` прибрано | OK |
| Production | не змінювався | OK |

---

## 2. Системні виправлення

### 2.1. `code.verify.run` більше не зависає після успішного build

**Причина:** `SharedProjectRuntimeProvider.collect()` чекав лише `close`. Svelte/Vite/esbuild залишали дочірній процес, який тримав stdout/stderr, тому `close` не наставав, хоча команда вже завершилася. Це давало `running` назавжди і потім хибний `step_limit`.

**Виправлення** (`apps/agent-api/src/shared-project-runtime-provider.ts`):
- `exit` тепер є достатньою ознакою завершення; після нього — обмежений drain 150 ms;
- група процесів убивається на `exit`/timeout;
- жорсткий ceiling 2 s після timeout, навіть якщо `exit` не прийшов;
- stdout/stderr обмежуються під час запису, без O(n²) `Buffer.concat`;
- `stdout/stderr/exitCode/durationMs` повертаються навіть при timeout.

**Підтвердження:** SvelteKit Run `6ce4aa90-336f-4276-bc95-8b0713c433f1` — `code.verify.run` завершився, build exit 0, preview стартував; FastAPI/Flask також пройшли verify без зависання.

### 2.2. Verifier більше не робить зайвий `npm install`

`codeVerifyRunnerPort` раніше безумовно виконував `npm install` перед build/typecheck, навіть для Python/PHP. Це додавало хвилини й ламало backend-проєкти. Тепер verifier виконує лише налаштовані `toolchain.verifyCommands`, передає `timeoutMs` і зберігає `exitCode`, `stdout`, `stderr`, `timedOut`, `durationMs`, `command` у результаті.

### 2.3. Preview авторизація для внутрішніх переходів

Додано project-scoped **HttpOnly** cookie `_npati_preview_<project8>` з `Path=/api/companies/.../preview/proxy`, `SameSite=Lax`, `Max-Age=900`, `Secure` за HTTPS. Token більше не потрібен у кожному URL; cookie не передається upstream-застосунку. Це виправляє втрату `?token=` при переході на `hosting.html` тощо.

Файл: `apps/agent-api/src/project-preview-service.ts`; тест: `tests/project-preview.test.ts` (37 PASS).

### 2.4. Синхронізація workspace

До exclusion додано `.venv`, `venv`, `vendor`, `.svelte-kit`, `.angular`, `out`, `.parcel-cache`, `tmp`, `temp`. Це прибирає `Project symlink denied` на Python `.venv` і symlink-циклах Svelte/Nuxt output.

### 2.5. Framework detection і scaffold

- `packages/shared/src/project-intent.ts` — 15 канонічних назв і `extractFramework`.
- `apps/agent-api/src/project-framework-scaffold.ts` — deterministic starters для 15 технологій.
- `chat-development.ts` — `kind: "api"` для backend; виправлено false-positive «Додай головну сторінку».
- **Нове:** фраза «Не створюй новий проєкт — редагуй цей самий проєкт» більше не створює новий проєкт, навіть якщо в тексті згадано framework у назві H1. Це був реальний дефект: edit-запит створював новий FastAPI/Express/Flask проєкт.
- Nuxt starter запінено на `nuxt 3.17.7`, `vue 3.5.13`, `vue-router 4.5.1`, щоб прибрати `Context conflict` / `beforeEach undefined` з vue-router 4.6.4.

### 2.6. Shell policy: рання відмова замість нескінченного approval

`code.shell.exec` з pipe/redirect/`$()`/`;` раніше створював `approval_required`, який chat-run не міг задовольнити, і процес висів. Тепер такі команди відхиляються як retryable `invalid_arguments` з підказкою використати `code.verify.run`. Це не послаблює політику: навпаки, усуває шлях, де агент чекає approval замість виправлення команди.

Також `sessionMode` тепер передається з canonical `CodeSession` у tool context, а не губиться між UI та policy engine.

### 2.7. Activity trace

`compactProgress` обмежує старі процеси metadata-only, але останні 8 зберігають command/stdout/stderr/exitCode. Додано `verification_timeout`, `command`, `exitCode` у projection. JSONB більше не роздувається до 10 MB.

### 2.8. Edit-запит більше не створює другий проєкт

Було два шари: deterministic `planChatDevelopment` і semantic `resolveProjectIntent`. Навіть після виправлення deterministic планера semantic resolver бачив у назві H1 («NPATI FastAPI E2E») новий framework і повертав `CREATE_*`. Тепер `ChatDevelopmentService.plan` перевіряє явну заборону («не створюй новий проєкт», «редагуй цей самий проєкт») **до** semantic resolver і повертає `[]`. Додано regression test у `tests/chat-development.test.ts` (28 PASS).

### 2.9. Astro starter і profile install

Astro `health.astro` містив невалідний JSON-фрагмент, через що агент витрачав ходи на його переписування і дійшов до `step_limit`. Замінено на валідний `src/pages/health.json.ts` (`GET` → JSON). Astro dependency pinned до `5.7.13`, щоб збігтися з `/opt/npati-project-toolchain/astro`; `npm install` тепер використовує project-owned profile copy без registry. Також прибрано `--legacy-peer-deps` для Nuxt/Remix: він обходив profile і залишав symlink-цикли. Нові попередження в prompt забороняють чіпати `/health` і вимагають зупинятися після першого успішного edit.

### 2.10. Nuxt: окремий статус, не PASS

Після чистого install і `NITRO_PORT`/`NITRO_HOST` Nuxt preview справді стартує (`node .output/server/index.mjs`, HTTP-ready). Але Browser QA ловить `Context conflict` і `beforeEach`, а після edit preview віддає старий build — це залишковий дефект, не системний PASS. Nuxt позначено PARTIAL, не PASS.

---

## 3. Результати E2E (15 технологій)

| # | Framework | Результат | Що підтверджено | Що не підтверджено |
|---|---|---|---|---|
| 1 | React + Vite | **PASS** | Chat, build, preview, Browser QA, edit, verify | — |
| 2 | Vue 3 + Vite | **PASS** | Chat, build, preview, Browser QA, edit, verify | — |
| 3 | Nuxt | **PARTIAL** | Chat, install, production build, preview, edit того самого проєкту, title/H1/section змінені | Browser QA: 4 console errors, `Context conflict`, `Cannot read properties of undefined (reading 'beforeEach')`, counter 0→0; ініціальний preview після edit віддавав старий build |
| 4 | SvelteKit | **PASS** | Chat, install, build exit 0, preview, counter 0→1, edit title/section | — |
| 5 | Astro | **PASS** | Chat, profile install, build exit 0, preview, Browser QA 0 errors, counter 0→1, edit title/section того самого проєкту | — |
| 6 | Angular | **NOT TESTED** | Проєкт і install стартували | Install >10 хв, прогін скасовано; E2E не завершено |
| 7 | Remix / React Router | **NOT TESTED** | — | — |
| 8 | Express | **FAIL** | Chat, install, build, preview | Після нового прогону агент пішов у довгий цикл інспекцій; E2E зупинено на bounded retry, фінальний edit не підтверджено |
| 9 | Fastify | **NOT COMPLETED** | Chat, install, agent стартував | Прогін зупинено після bounded retry; Browser QA/edit не завершені |
| 10 | NestJS | **NOT COMPLETED** | Chat, install, agent стартував | Прогін зупинено після bounded retry; Browser QA/edit не завершені |
| 11 | FastAPI | **PASS** | Chat, install, verify, preview, Browser QA 0 errors, edit title/section, same project | — |
| 12 | Django | **NOT TESTED** | — | — |
| 13 | Flask | **PARTIAL** | Chat, install, verify, preview, counter 0→1, edit title/section | Початковий H1/title був «API-сервіс», а не «NPATI Flask Test»; initialQa.passed=false |
| 14 | Laravel | **BLOCKED** | PHP/Composer тепер є в runner | Повний E2E не запускався; Laravel scaffold/install не перевірені |
| 15 | HTML/CSS | **PARTIAL** | Chat, preview, edit title/section, cookie auth | 4 внутрішні посилання (`hosting.html`, `domains.html`, `pricing.html`, `contact.html`) → 404; counter не знайдено |

### Підтверджені PASS — деталі

#### React + Vite
- Run: `33922cb8-8995-484b-b44e-dfb25cf00590`
- Повний сценарій: створення, install, build, preview, QA, edit, повторна перевірка.
- Evidence: `scratch/framework-e2e/react-vite.json`, screenshots.

#### Vue 3 + Vite
- Run: `c1dd62a3-b3fe-4078-beea-c2950758a8c8`
- Повний сценарій; counter працює.
- Evidence: `scratch/framework-e2e/vue-3-vite.json`.

#### SvelteKit
- Process: `71344209-da54-457b-920c-629d3baabb47`
- Run: `6ce4aa90-336f-4276-bc95-8b0713c433f1`
- Project: `1a3d421b-100e-41a7-aa96-98edcf433e02`
- Build: `npm run build` exit 0, duration 24 s; preview `node build/index.js`
- Browser QA: HTTP 200, title `NPATI SvelteKit Test`, 0 console/page errors, 0 broken links, counter `0 → 1`
- Edit: title/H1 → `NPATI SvelteKit E2E`, section `Оновлено через NPATI Chat`; edited preview HTTP 200
- Evidence: `scratch/framework-e2e/sveltekit.json`, `scratch/framework-e2e/sveltekit-initial.png`, `sveltekit-edited.png`

#### FastAPI
- Process: `585ca4cf-1e29-4baf-9065-033b262b09e1`
- Run: `eaa79fa2-7071-451e-b60e-e0baa4ba0c6c`
- Project: `b3cdd7bb-186a-47de-af8d-1c9c5b9a3036`
- Install у `.venv`; `code.verify.run`; preview `uvicorn main:app --port 3102`
- Browser QA: HTTP 200, title `NPATI FastAPI Test`, 0 console/page errors, 0 broken links
- Edit того самого проєкту: `NPATI FastAPI E2E` + section; `waitForEditedPreview` підтвердив зміну HTML
- Evidence: `scratch/framework-e2e/fastapi.json`, screenshots

### PARTIAL — деталі

#### HTML/CSS
- Project: `7910c9f2-c49d-4e14-aecf-29013a76fe75`
- Run: `code-inbox-5fce5550-b720-408a-badb-9a13e87be5dc`
- Створення та edit пройшли; title edited = `NPATI HTML/CSS E2E`, section present.
- `initialQa.brokenLinks`: 4 × HTTP 404 на сторінки, яких немає в проєкті; `interaction.attempted=false` (немає `#counter`).
- Це не 401: cookie-виправлення працює, але цільових сторінок реально немає. Тому PARTIAL, не PASS.
- Evidence: `scratch/framework-e2e/html-css.json`.

#### Flask
- Project: `2a1fcc3d-f2ed-4ba0-95ae-c8fc47fcf029`
- Run: `352bf75b-be69-4ba7-be1f-15b22d82db3a`
- Build/verify, preview, counter `0 → 1`, edit title/section — успішно.
- Але initial title/H1 залишився `API-сервіс` (initialQa.passed=false). Потрібно виправити starter/H1 на етапі створення, а не тільки під час edit.
- Evidence: `scratch/framework-e2e/flask.json`.

### FAIL — деталі

#### Nuxt
- Project: `b4bdc184-da7b-4b2b-a699-7595c771a279`
- Process: `21d5d0f3-8cfd-45e9-9346-0d77d57e0598`
- Run: `78da593a-9e11-4a1d-a7bd-436ee5ed171c`
- Після чистого install (без explicit `vue`/`vue-router`) і `NITRO_PORT`/`NITRO_HOST` preview стартує: `node .output/server/index.mjs`, `lastBuildStatus=ready`, HTTP 200.
- Edits: title/H1/section у `nuxt.config.ts` і `pages/index.vue`, edit виконано в тому самому проєкті (semantic veto спрацював).
- **Не PASS:** Browser QA initial — 4 console errors (`Context conflict`, `Cannot read properties of undefined (reading 'beforeEach')`, hydration mismatch), counter `0 → 0`; після edit preview віддавав старий H1 `NPATI Nuxt Test`, а не `NPATI Nuxt E2E` (build/preview publication defect). Позначено PARTIAL.

#### Express
- Project: `0bba883e-8759-40b2-9d42-1c49e6cb4756`
- Останній прогін: install і agent стартували, але агент пішов у довгий цикл інспекцій; після bounded retry процес зупинено без фінального Browser QA/edit. Це FAIL, не PASS.
- Попередній прогін (`59af9c35...`, run `e3f58974...`) упав на `OmniRoute HTTP 503` під час edit — зовнішній provider-збій.

#### Astro
- Project: `9277b7a6-8941-4c8b-8ae8-7350272e616c`
- Process: `8aebf3b1-894e-4849-87a5-a97f7494efba`
- Run: `16a605d0-b91f-4f38-b5e1-36efa271ba06`
- Profile install (`Prepared dependencies: astro … no registry download`), `npm run build` exit 0, preview `astro preview` HTTP 200.
- Browser QA: title `NPATI Astro Test`, 0 console/page errors, 0 broken links, counter `0 → 1`.
- Edit того самого проєкту: title/H1 `NPATI Astro E2E`, section `Оновлено через NPATI Chat`; edited HTML 200, `titleOk=true`, `sectionOk=true`.
- Evidence: `scratch/framework-e2e/astro.json`, screenshots.

#### Angular
- Project: `e9495f50-3afe-43fc-ace5-a304cb9f4644`
- Run: `072f226f-e1f7-45f5-ab9a-898b473fc714` (cancelled)
- `npm install` понад 10 хв; прогін скасовано, щоб не тримати слоти. E2E не завершено.

---

## 4. Паралельне виконання

Було запущено 4 проєкти одночасно (Nuxt, Express, FastAPI, Flask). Ізоляція sandbox/UID/port збереглася, але:
- install/build конкурували за CPU (npm install >5 хв, `nuxt build` >1 хв);
- OmniRoute повернув 503 для одного запиту при 4 активних процесах;
- FastAPI і Flask завершили preview незалежно, Nuxt — ні.

Повторний прогін 3× (Nuxt + Astro + Express) підтвердив resource contention: Astro пройшов повний PASS, Nuxt дійшов до preview/edit, Express не завершив E2E.

**Висновок:** одночасність трьох проєктів технічно не доведена як безпечна для SLA; потрібен окремий прогін 3× одночасно з фіксацією CPU/RAM/портів і без стороннього навантаження. Поточна ознака — resource contention, не порушення ізоляції.

---

## 5. Тести та перевірки коду

| Команда | Результат |
|---|---|
| `npm run typecheck --workspace @npati/agent-api` | PASS |
| `npm run typecheck --workspace @npati/shared` | PASS |
| `npx vitest run tests/framework-deployment-support.test.ts tests/project-preview.test.ts tests/chat-development.test.ts` | **105 PASS** |
| `npm run build --workspace @npati/agent-api` | PASS |
| `npm run build --workspace @npati/web` | PASS |

Додані тести:
- 15 framework scaffolds / detection / build commands;
- SvelteKit `+page.svelte` та Astro `[slug].astro` як literal paths;
- preview HttpOnly cookie auth для внутрішньої навігації;
- edit-запит «Не створюй новий проєкт» не створює новий target.

---

## 6. Залишкові блокери та наступні дії

1. **Nuxt hydration/edit publication** — preview стартує, але `Context conflict`/`beforeEach` і старий build після edit; прибрати дублювання Vue runtime (перевірити `npm ls vue` всередині проєкту) і переконатися, що `nuxt build` пише новий `.output` перед preview.
2. **Express/Fastify/NestJS** — агенти йдуть у довгі цикли інспекцій; потрібен bounded no-progress guard і повторний повний E2E (Express edit після 503 вже не є єдиним блокером).
3. **Astro** — PASS підтверджено; залишити regression на валідний `health.json.ts`, щоб агент не переписував health endpoint.
4. **Angular** — прискорити install (profile/shared cache) і завершити E2E.
5. **Flask** — starter H1/title має бути `NPATI <Framework> Test` на етапі створення, не тільки після edit.
6. **HTML/CSS** — або створити реальні `hosting/domains/pricing/contact` сторінки, або прибрати ці посилання; додати `#counter` у starter.
7. **Remix, Fastify, NestJS, Django, Laravel** — повний E2E не виконано; Laravel тепер має PHP/Composer, але потребує окремого прогону.
8. **Паралельність 3×** — окремий контрольований тест із метриками CPU/RAM/port і без сторонніх прогонів. У новому прогоні 3 проєкти (Nuxt/Astro/Express) конкурували за CPU; Nuxt/Astro дійшли до preview, Express — ні.

---

## 7. Висновок

Системні причини, які блокували більшість фреймворків, були знайдені й виправлені: зависання `collect()` після build, зайвий `npm install` у verifier, втрата session mode, approval-deadlock на shell-метасимволах, preview token на внутрішніх переходах, `.venv`/symlink sync, false-positive створення нового проєкту під час edit, Nuxt hydration через несумісний vue-router.

Це дало **5 повних реальних PASS** (React, Vue, SvelteKit, FastAPI, Astro) і **3 PARTIAL** (HTML/CSS, Flask, Nuxt). Express/Fastify/NestJS не завершили E2E після bounded retry; Angular/Remix/Django/Laravel — NOT TESTED/BLOCKED. Твердження «15/15 PASS» було б неправдивим.

Нові підтвердження цього прогону: Astro process `8aebf3b1-894e-4849-87a5-a97f7494efba`, run `16a605d0-b91f-4f38-b5e1-36efa271ba06`, Browser QA 0 errors, counter 0→1, edit того самого проєкту; Nuxt preview HTTP-ready і edit того самого проєкту, але hydration QA — FAIL. Regression suite: 105 PASS.
