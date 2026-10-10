# Async Coding Agent — Step 3: tracked process execution

Дата: 2026-10-10. Основа: [implementation plan](../../../docs/coding-agent/async-harness-implementation-plan.md), крок 3. **Крок 3 завершено.** Opt-in шлях підключено до чинних CodeProcessManager, CodeShellRuntime, ProjectSandboxService і canonical executors. Flag `code.async_processes` залишається off за замовчуванням, також на self-hosted.

## Повторний аудит кроків 1 і 2

Перевірено store transitions, PostgreSQL locks, runner boundaries, executor/wake/cleanup wiring, routes/RBAC, chat SSE identity, UI submission guards, retry identity, draft generation та snapshot refresh. Кроки 1–2 реалізовані в межах [Step 1](async-inbox-step-1.md) і [Step 2](async-inbox-step-2.md). Зберігаються їхні межі: текстовий inbox, cutoff перед C9, process-local hints, sessionStorage reconnect pointer, queued results у Code Workspace; unattended authenticated dispatch після host restart і browser end-to-end proof не додані.

Виправлено submit dedup: нові messages мають immutable SHA-256 fingerprint початкових {authorId,text,mode}. Інший mode під тим самим requestId — conflict. Retry після pending edit повертає той самий message із відредагованим текстом, не скасовуючи edit. Для історичних записів без fingerprint збережено старий text/author fallback: відновити початковий mode/text після edit неможливо. Це additive JSON field без нової inbox migration. Обидва inbox backend suites додано до стандартного tests typecheck; виправлено array access types і fixture description без послаблення assertions.

## Реалізований контракт

- Additive `code.shell.exec_async@1` запускає tracked process від початку; foreground — bounded wait того самого handle. Timeout повертає version 1 `running-process-receipt`, explicit background повертає handle; terminal-before-timeout повертає `foreground-result`. Parent може продовжити loop. `code.shell.process.wait@1` збирає bounded output/status; waitTimeoutMs=0 читає поточний стан. Старий `code.shell.exec` і його schema/result збережено.
- Shared shell path зберігає policy, classification, approvals, allowed environment та actor permissions перед dispatch. Foreground-only secret leases/secretRefs відхиляються до запуску; promotable command не успадковує ці credentials. Потрібні `code.async_processes`, `code.background_runs` та реальна capability backend.
- WorkspaceStore має memory/PostgreSQL adapters і незалежну migration 089 після 088. Project row serializes reserve/claim/update/cleanup; tenant-scoped executionKey використовує справжній C6a runId і model toolCallId. Stable operationId/processId, immutable payload hash, owner/generation CAS, startedRevision, sandbox id та revision/hash snapshot зберігаються до provider dispatch. Logical uniqueness забезпечено locked project transaction, а не окремим SQL unique index на JSON executionKey.
- Capacity резервується до await; changed payload під тим самим logical call — conflict. Retry, takeover та authenticated restart recovery повертають ту саму identity без другого spawn. Preparing timeout/cancellation не публікують phantom process; late dispatch перевіряє fence/cancel intent і чинний live C6a lease. Terminal parent допускає settlement уже запущеного producer, але не новий dispatch. Dispatch із невідомим результатом лишається unknown_outcome до reconciliation.
- Lifecycle journal: accepted/preparing/started/promoted/output/settled/cancel_requested/owner_replaced. Events містять metadata; bounded output зберігається окремо з classification/retention scope. Local subscribe встановлюється до snapshot/reconcile; provider observation робиться на сервері без model polling loop чи другого execution scheduler.
- Output — bounded tail 64 000 UTF-16 units із абсолютними earliest/next cursors та explicit truncated/lossy; повторні snapshots не дублюють delta. UI/model можуть передавати незалежні offsets. Legacy line logs adapter збережено; якщо durable tail втратив prefix і line cursor неможливо відновити, повертається `process_output_cursor_lost` із переходом до нового wait API.
- Success потребує реального terminal exit 0; failed/timed_out мають фактичний exit, stopped — окремий lifecycle із nullable exit. Process completion не є verification proof. Scoped list/logs/wait/stop перевіряють authenticated company/project/session; foreign handles недоступні. Controls доступні для drain також після flag rollback.
- Docker provider має durable markers, kernel flock, stable UUID, cancel tombstone до spawn, власну process group, bounded output reader та terminal reconciliation після API restart. Alive child group не оголошується settled. Missing handle після tombstone — lost, непідтверджений outcome не стає success. Shared runtime та старі remote backends без capability залишають legacy exec і не рекламують promotion.
- Active/unknown/preparing descriptor утримує sandbox. Cleanup fence атомарно виключає accepted start проти destroy/inactivity/retention. Provider failure звільняє fence для retry; pinned sandbox не рахується destroyed. Revision-guarded terminal sync не перезаписує concurrent canonical edits. Щоб наступний upload не знищив workspace активного producer, project допускає лише один preparing/dispatched tracked producer; наступний start отримує busy. Foreground upload теж відхиляється, доки tracked producer active.
- Retention та project/session erasure враховують `code_process_projects`: active producer блокує destructive erasure; session erasure не видаляє sibling operations. Referenced C6a run rows зберігаються, доки process active.

Manifest 10 додає два tools до 37 попередніх. Versions 1–9 і їхні checksums frozen; catalog/matrix тепер мають 387 capabilities, 123 callable. Exact parity/count assertions оновлено.

## Межі експлуатації

PostgreSQL забезпечує crash durability; InMemory adapter призначений для development/test і не переживає host restart. Після restart reconciliation запускає authenticated wait/retry/control; unattended dispatch або completion delivery тут не додані. Local listeners є live hints, durable journal — authoritative state.

Непідтверджена смерть producer, sandbox identity mismatch або workspace sync conflict зберігають pin; потрібне підтверджене reconciliation/cancel. Crash у момент destructive cleanup залишає durable cleanup fence fail-closed; автоматичне unsafe clearing не реалізовано. Після settlement sandbox звільняє наступний чинний cleanup/reaper pass.

До кроку 4 результати збираються через explicit wait/collect. Completion outbox → inbox, admission receipts, UI completion delivery та finalization barrier належать наступним крокам плану.

## Перевірки

- 27 hermetic async-process tests: same-handle promotion, early/nonzero completion, capacity, bounded/cumulative output, preparation timeout, cancel/start/settle races, restart reconciliation без replay, takeover/lease fencing, secret denial, scope isolation, disabled backend/legacy regression та cleanup pin/fence.
- Sandbox lifecycle: 10 tests, включно з pinned inactivity/destroy/retention і retry після provider failure. Фінальний lifecycle/process прогін: 2 files / 37 passed. Catalog/inspector/C2/C3/provider regressions: 6 files / 48 passed.
- Реальний Docker acceptance: 1 passed, без skips; один producer для повторного stable id, nonzero exit, 70 000-character output із bounded tail, cancel-before-start, confirmed process-group stop та foreign scope denial. Використано ізольований test container; наявний stack не змінено.
- Реальний PostgreSQL DB gate: 2 suites / 4 passed, без skips. Upgrade із уже застосованої 088, idempotent 089, concurrent pools dedup/conflict, takeover fence, live lease при dispatch, store restart, active erasure block і sibling-preserving session erasure. Fixture використовує committed identity незалежно від того, який pool виграв reserve; припущення про порядок завершення запитів прибрано.
- Фінальний security gate: 157 suites / 2289 passed, failed=0, skipped=0; schema/image/dataset/catalog guards passed. До gate входить regression live lease перед dispatch та settlement після terminal parent.
- Повний послідовний npm test: 392 files, 4431 passed / 12 failed / 16 skipped. Усі 12 FAIL headers збігаються з baseline Step 2: added=0, removed=0; proof у `artifacts/async-process-step3-baseline-comparison.json`. Новий Docker suite opt-in і пропускається в default full run; окремий реальний Docker acceptance пройдено. Full suite не оголошується зеленим.
- Попередні паралельні full/gate прогони дали додаткові timeout/scan failures; їх збережено як `*-contended.log`. Послідовний повтор без зміни timeout чи assertions відтворив лише baseline failures і дав green security gate.
- Workspace/API/test typechecks, lint, schema/catalog audits та API build пройдено; фінальні API build і gate виконано після live-lease refinement.

Логи: `artifacts/async-process-step3-{gate,db-gate,docker,lifecycle-final,regressions,typecheck,tests-typecheck,lint,schema-audit,capability-audit,api-build,full-test}.log`.
