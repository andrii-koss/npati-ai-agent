# Крок 4 — адаптивний Self-Review

**Тип:** оптимізація + вимірювання. **Зупинка після кроку 4.**
**Дата:** 2026-10-21. **Базується на:** [Етап 0](coding-agent-inventory.md), [Етап 1](coding-agent-performance.md), [Крок 1](step-1-tool-calls.md), [Крок 2](step-2-verification.md), [Крок 3](step-3-omniroute-context.md).

**Що НЕ змінено:** сам review engine (`code-self-review.ts` — та сама одна прохідна модель-виклик, той самий
парсер, той самий бюджет фіксу), Build, Typecheck, Test Integrity, Security Policy, verification/repair cycle.
**Змінені файли:** 1 новий модуль, 4 змінені, 1 новий тест, 1 рядок у `.env.example`.

---

## 1. Коли Self-Review запускається

```
finalizeOrReviewTurn
  ├ stylePreview / verificationDisabled / без змін → beginSelfReviewState() БЕЗ model call
  └ verifyAndDecide() === "passed"
        └ beginSelfReview() → runSelfReviewOnce → engine.chat (messages без tools)   coding-agent-review-coordinator.ts:753
              └ verdict: clean | findings | unavailable
                    ├ findings + blocking → одна fix-ітерація
                    └ unresolved → stop self_review_unresolved
```

Ключові факти:

- review запускається **лише після успішної верифікації** (або на шляху, де верифікація вимкнена, — тоді він і
  раніше не робив model call);
- це один model call без tools; фіксується як `model_call` із `modelPurpose: "self_review"`;
- після невдалої верифікації review теж може виконуватися (коли repair-бюджет вичерпано), але рішення про
  завершення від нього не залежить — ран однаково зупиняється з `verification_failed`. Цю поведінку збережено:
  адаптивне правило ніколи не пропускає review, якщо `verification !== passed`.

---

## 2. Що review реально знаходить (runtime-дані)

Локальна БД, `code_run_states.details.estimate.selfReview`:

| Показник | Значення |
|---|---|
| Ранів із self-review summary | 152 |
| Ранів, де review реально викликав модель (`reviewRuns > 0`) | **109** |
| `findings` (є зауваження) | 52 |
| `clean` | 49 |
| `not_run` | 43 |
| `unresolved` | 5 |
| `unavailable` | 3 |
| Ранів із **blocking** знахідкою | **4** |

Реконструкція змінених шляхів із replay-ledger (3078 tool-call'ів) дає розподіл за класом змін:

| Клас | Ранів | findings | blocking | clean | unresolved |
|---|---|---|---|---|---|
| source / інше | 145 | 50 | **4** | 49 | 5 |
| лише стилі (`css/scss/sass/less`) | 20 | 2 | **0** | 0 | 0 |

Тобто: blocking-знахідки трапляються рідко (4/152) і **в цьому корпусі — виключно у змінах source-файлів**;
style-only рани дали 2 не-blocking зауваження і жодного blocking.

Вартість одного review (Етап 1): 96 викликів, p50 **4 840 мс**, p90 19 818 мс, середнє 7 828 мс.

**Що review дублює:** він не дублює build/typecheck — ті вже пройшли. Він перевіряє те, чого перевірки не бачать:
відповідність початковій цілі, зайві зміни (scope), відсутність тестів, ослаблення тестів, security-евристики.
Саме тому пропуск дозволено лише там, де цих категорій майже немає — у презентаційних змінах.

---

## 3. Адаптивне правило

Новий чистий модуль `code-self-review-risk.ts`:

- `decideSelfReview(input)` (`:86`) повертає `{ decision: "run" | "skip", risk, reason, signals }`;
- `isSecuritySensitivePath(path)` (`:70`) — сегментна перевірка шляхів (`auth`, `session`, `permission`,
  `rbac`, `policy`, `secret`, `credential`, `crypto`, `jwt`, `oauth`, `token`, `key`), файлів (`.env`,
  `Dockerfile`, `docker-compose`, `package.json`, lock-файли, `*.pem/.key/.crt`) і директорій (`migrations`,
  `prisma`, `.github/workflows`, `terraform`, `k8s`, `helm`);
- класифікація типів змін **повторно використовує** `classifyVerificationChange` з Кроку 2 — другого
  класифікатора не створено.

**Рівні ризику:**

| Рівень | Коли |
|---|---|
| `high` | є security-sensitive шлях, dependency-файл, scope guard перевищено, >3 файлів або ≥300 рядків |
| `elevated` | є source/test-файли, був repair, test integrity flagged/unjustified |
| `low` | лише стилі/ассети, верифікація пройшла, без repair/integrity/scope, ≤3 файлів, diff ≤20 000 символів |

**Пропуск** можливий лише коли `risk === "low"` **і** всі умови виконані: `verification === "passed"`,
`!hadRepair`, test integrity чиста, scope не перевищено, розмір у межах. Усі інші випадки — `run`, як раніше.

**Лінії рядків не є критерієм:** одноврядкова зміна в `src/auth/session.ts` дає `high` і review запускається
(це зафіксовано тестом).

**Kill switch:** `NPATI_CODE_SELF_REVIEW_ADAPTIVE=false` (`code-agent-config.ts:66,98,149`) повертає
«перевіряти кожну зміну». Порт `selfReview.adaptive` також може перекрити значення.

**Що записується:** `summary.selfReview.risk` (`low/elevated/high`) і `adaptiveSkip: true`. Пропуск має статус
`not_run` із причиною `adaptive_low_risk_skip` — він **ніколи не виглядає як `clean`**, тому звіт і UI не можуть
показати «review пройдено».

---

## 4. Змінені файли

| Файл | Зміна |
|---|---|
| `apps/agent-api/src/code-self-review-risk.ts` | **новий**: рішення про запуск, рівні ризику, security-шляхи |
| `apps/agent-api/src/code-review-summary.ts` | **новий**: чисті проєкції verdict/report у persisted summary (винесено, щоб координатор лишався під size-guard) |
| `apps/agent-api/src/code-self-review-types.ts` | причина `adaptive_low_risk_skip` |
| `apps/agent-api/src/code-self-review.ts` | `skipReason` у `createSelfReview` — детермінований `not_run` без model call |
| `apps/agent-api/src/coding-agent-review-coordinator.ts` | `selfReviewDecision()` (`:417`), skip-гілка (`:525`), виклик у finalize (`:753`), summary через builders |
| `apps/agent-api/src/code-agent-config.ts` | `selfReviewAdaptive` (default `true`, env kill switch) |
| `apps/agent-api/src/coding-agent-runner-ports.ts` | `selfReview.adaptive` |
| `apps/agent-api/src/coding-agent-runner-contracts.ts` | `risk?`, `adaptiveSkip?` у summary |
| `.env.example` | документований `NPATI_CODE_SELF_REVIEW_ADAPTIVE` |
| `tests/coding-agent-step4-self-review.test.ts` | **новий**, 21 тест |

Розмір файлів: координатор після винесення summary-builders — **780 рядків** (під лімітом 800); нові модулі
винесені окремими файлами, тому size-guard не потребував нових allowance-записів.

---

## 5. Тести

`tests/coding-agent-step4-self-review.test.ts` — 21/21: 14 чистих тестів рішення + 7 сценаріїв у реальному
`CodingAgentRunner` (engine без tools = review-виклик, тому `reviewCalls` — точний підрахунок LLM-review).

| Сценарій | Очікування | Результат |
|---|---|---|
| CSS-правка (verified) | 0 review-викликів, `not_run/adaptive_low_risk_skip`, `risk: low` | ✅ |
| Зміна тексту компонента (`Hero.tsx`) | review запускається, `clean` | ✅ |
| Звичайний баг-фікс (`money.ts`) | review запускається | ✅ |
| Зміна API (`api/routes.ts`) | review запускається | ✅ |
| Авторизація/секрети (`auth/session.ts`) | review запускається, `risk: high` | ✅ |
| Масове редагування (10 файлів) | review запускається, `risk: high` | ✅ |
| Помилка верифікації + repair, далі CSS | review запускається (`elevated`), skip неможливий | ✅ |
| Одноврядкова auth-зміна | `high`, review (лінії не критерій) | ✅ |
| Verification failed / test integrity / scope exceeded | ніколи не skip | ✅ |
| Kill switch | CSS-зміна все одно review | ✅ |

Регресія: **213/213** у 10 файлах (step1–step4, c6-runner, c9-self-review, c9-verification-loop,
c9-runner-verification, chat-website, omniroute-adapter). Typecheck API — passed. `npm run lint`: lint-guard і
XSS passed; наявне падіння size-guard на `apps/web/src/DataStudioSettingsPage.tsx` (файл не змінювався).

---

## 6. До / після (тільки виміряне)

| Метрика | До | Після | Джерело |
|---|---|---|---|
| LLM-review у корпусі | 109 | **107** (−2) | реконструкція шляхів + гейти правила |
| Пропущені blocking-знахідки | — | **0** (у тих 2 ранах blocking = 0) | `details.selfReview.blocking` |
| Час review | p50 4 840 мс, середнє 7 828 мс | −2 виклики ≈ **9.7–15.7 с** на корпус | Етап 1 |
| Токени review | **Не виміряно** | — | usage review-викликів не персиститься окремо |
| Дефекти / хибні успіхи | 4 blocking із 152 | не змінюються: усі 4 — source-рани, які review не пропускає | SQL |
| `risk` / `adaptiveSkip` у summary | немає | є | код |

**Чому ефект у корпусі малий:** 18 із 20 style-only ранів і так ніколи не викликали review (HTML/CSS або
stylePreview-шлях, де верифікація вимкнена). Реально review виконувався лише у 2 style-only ранах — обидва
2 файли, 0 blocking, 0 repair, без scope/integrity-сигналів, тому правило пропустило б їх за умови, що diff
кожного ≤20 000 символів (для двoфайлових CSS-змін це майже напевно, але точний diff тих ранів не збережено).
Це і є вся виміряна економія **в цьому корпусі**; цінність правила — для проєктів, де CSS-зміни проходять повну
верифікацію.

**Оцінка токенів не наводиться:** usage self-review-виклику не зберігається окремо від основного циклу, тому
називати числа було б вигадкою.

---

## 7. Чи безпечний пропуск

**Доказова база обмежена, і це прямо вплинуло на правило:**

- у корпусі style-only рани дали 0 blocking знахідок (0 із 20 ранів; 2 review-прогони з не-blocking findings);
- source-рани дали всі 4 blocking — тому для них пропуск **не** ввімкнено;
- контрфактичного A/B (той самий ран із review і без) немає, тому «пропуск не збільшує дефекти» не доведено
  статистично — доведено лише те, що пропущено 0 blocking знахідок у наявних даних.

Тому правило навмисно вузьке: лише презентаційні зміни, лише після успішної верифікації, без repair,
без test-integrity чи scope-сигналів, ≤3 файлів і малий diff, з kill switch. Для всього іншого поведінка
**не змінена**.

**Ризик, який залишається:** не-blocking зауваження review (наприклад, «змінено не той селектор») для CSS-змін
більше не з'являться в summary. Це прийнятний компроміс лише тому, що такі зауваження не впливають на
завершення; якщо для проєкту вони важливі — `NPATI_CODE_SELF_REVIEW_ADAPTIVE=false`.

**Що збережено за вимогами 7–10:** review після невдалої верифікації та repair, review для source/API/auth/
secrets/dependency/масових змін, залежність завершення від `unresolved`, Build/Typecheck/Test Integrity/
Security Policy не змінювалися.

---

## 8. Що далі (не виконується)

1. Накопичити `risk`/`adaptiveSkip` у нових ранах і перевірити частку хибних успіхів для пропущених змін
   (потрібен корпус, а не один прогін).
2. Розглянути `elevated`-політику (напр. review лише коли verification був «тонким») — лише після вимірювання.
3. Виміряти usage self-review окремо (зараз токени review не персистяться).
