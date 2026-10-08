# G1 п.2 — D1: сирі виводи та доказова база (пісочниця агента)

`vitest` у пісочниці не запускається (`esbuild` → `spawn EPERM`), тому тут зібрано **точні** виводи, на які
посилається звіт. Усе виміряно на живій БД гейта (`postgres://postgres:postgres@127.0.0.1:55432/npati_dbgate`,
контейнер `npati-g1-pg`, PostgreSQL 17.11) через **справжні** `PostgresWorkspaceStore`, `AuditLogService` і
`audit-chain.ts`.

## 0. Правка

`packages/workspace/src/postgres-store.ts:121-127` — `auditEntryColumns` (спільний список колонок для
`appendAuditEntry` RETURNING, `listAuditEntries`, `verifyAuditChain`, `systemAuditChains`):

```
  sequence::int AS "sequence",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
```

Шлях **запису** не змінювався (`git diff` не має жодного хунка в `appendAuditEntry`).

## 1. Байтова рівність (`.g1-probe/d1-audit-roundtrip.out.txt`, розділ 1)

```
samples: 20016
session TimeZone=Etc/UTC:          {"formatted_equals_hashed_string":true,"mismatches":0,"naive_cast_equals_hashed_string":0}
session TimeZone=America/New_York: {"formatted_equals_hashed_string":true,"mismatches":0,"naive_cast_equals_hashed_string":0}
session TimeZone=Asia/Tokyo:       {"formatted_equals_hashed_string":true,"mismatches":0,"naive_cast_equals_hashed_string":0}
microsecond input (cannot be produced by toISOString): {"input":"2026-10-08T13:51:09.288123Z","formatted":"2026-10-08T13:51:09.288Z"}
```

## 2. Дефект і його друга половина (розділ 3–4)

```
pre-fix row types as `pg` returned them: {"createdAt":"object (a Date)","sequence":"string",
  "canonicalJsonOfCreatedAt":"{}","canonicalJsonOfSequence":"\"1\""}
pre-fix verifyAuditEntries: {"ok":false,"entryCount":2,"brokenAtSequence":"1",
  "reason":"entry_hash does not match the entry content","headHash":null}

half-fixed row types: {"createdAt":"string","sequence":"string", ...}
half-fixed verifyAuditEntries: {"ok":false,"entryCount":2,"brokenAtSequence":"1",
  "reason":"entry_hash does not match the entry content","headHash":null}
```

## 3. Після правки (розділ 5)

```
store.verifyAuditChain: {"ok":true,"entryCount":2,"brokenAtSequence":null,"reason":null,
  "headHash":"998aff1614d2bae0be173480798529b0a343209f16d54ba52d040c324f9f5ce8"}
AuditLogService.verify: {"ok":true,"entryCount":2,"brokenAtSequence":null,"reason":null,
  "headHash":"998aff1614d2bae0be173480798529b0a343209f16d54ba52d040c324f9f5ce8",
  "anchorMismatch":false,"alert":null}
headHash equals the hash returned when entry 2 was appended: true
metadata round-tripped byte for byte: true
recomputed hash == stored hash (per row): [...] "equal":true  (обидва рядки)
```

## 4. Невакуумність (розділ 6–7)

```
trigger enabled -> the same UPDATE is refused by the append-only trigger: audit_log is append-only (attempted UPDATE)
metadata tampered on sequence 1: {"ok":false,"entryCount":2,"brokenAtSequence":1,
  "reason":"entry_hash does not match the entry content","alert":"CRITICAL: ... at sequence 1"}
metadata restored: {"ok":true,...,"brokenAtSequence":null,"headHash":"998aff16..."}
actor tampered on sequence 2: {"ok":false,"brokenAtSequence":2,"reason":"entry_hash does not match the entry content"}
actor restored: {"ok":true,...,"brokenAtSequence":null,"headHash":"998aff16..."}
privileged write after a detected break: Error: Audit chain is broken for this company; privileged operations are blocked pending investigation
```

## 5. Наявні ланцюги, записані ДО правки (`.g1-probe/d1-existing-chains.out.txt`)

```
company 6ea20c6d-b3c5-4d4c-988d-8abd2f5a4965  rows=1  written=2026-10-08T13:51:09.288Z
  recomputed hash == stored hash: [ { sequence: 1, action: 'roundtrip', recomputedEqualsStored: true } ]
  verifyAuditEntries: { ok: true, entryCount: 1, brokenAtSequence: null, headHash: 'eff3e3580056...' }
company aef25162-9ec3-4820-9d29-7b9d65e4b0d6  rows=2  written=2026-10-08T13:51:28.494Z..13:51:28.537Z
  recomputed hash == stored hash: [ seq 1 true, seq 2 true ]
  verifyAuditEntries: { ok: true, entryCount: 2, brokenAtSequence: null, headHash: 'ee1c96940c0f...' }
```

## 6. Хто такі решта 3 компанії-залишки (`.g1-probe/d1-leftover-linkage.out.txt`)

```
58a2e226…, b38c0e76…, d1a1d2fb…: links [{sequence:2, prevHashEqualsPreviousEntryHash:false}], chainShapeIsReachable:false
second INSERT with prev_hash != head: audit_log chain violation: prev_hash does not match the current head
second INSERT with prev_hash == head: accepted
```

Тобто ці три «ланцюги» — рукописні фікстури з розірваним `prev_hash` (усі 9 рядків мають
`payload_hash = 'x'`), які тригер `audit_log_chain_guard` не пропустив би. Вони не є ланцюгами, які може
створити шлях запису, і падають незалежно від типу читача. **Не видаляв**: це залишки попередніх прогонів
власника (13:50:05–13:51:28), не мої. Прибрано лише 20 рядків, створених цією сесією
(`.g1-probe/d1-cleanup.out.txt`, поріг `created_at >= 2026-10-08T13:52:00Z`).

## 7. Реальний DB-набір через харнес (`.g1-probe/d1-suite-run.out.txt`)

```
$ node --experimental-transform-types ./artifacts/c5b-policy-probe/run.mjs tests/coding-agent-c1c-audit-postgres.test.ts
harness: suites=1 tests=3 passed=3 failed=0            # exit=0   (з правкою)

# невакуумність самого тесту — тимчасово повернутий старий читач:
harness: suites=1 tests=3 passed=0 failed=3            # exit=1   (повний відкат)
  ✗ ... expected [{"sequence":"1","sequenceType":"string","createdAtType":"object"}] to equal
        [{"sequence":1,"sequenceType":"number","createdAtType":"string"}]
  ✗ ... expected "2" to be 2
harness: suites=1 tests=3 passed=0 failed=3            # exit=1   (виправлено лише created_at)
  ✗ ... expected [{"sequence":"1","sequenceType":"string","createdAtType":"string"}] to equal
        [{"sequence":1,"sequenceType":"number","createdAtType":"string"}]
        (той самий reason, той самий brokenAtSequence — тому половина правки не проходить)
```

Хеш файлу стора після відкату й відновлення: `0D6459EEB50D0A20A36909D4CDF3BEAC4A47B1D131845B8E7B263B3DFC82AFF0`.

## 8. Сусідні набори (`.g1-probe/d1-related-suites.out.txt`)

```
$ ... run.mjs tests/coding-agent-g1-migrations-postgres.test.ts
harness: suites=1 tests=2 passed=2 failed=0
$ ... run.mjs tests/coding-agent-c1c-audit-log.test.ts
2 падіння, обидва `expect.stringContaining is not a function` — обмеження шіма, файл не змінювався
(той самий результат зафіксовано в evidence.md §5 до цієї правки)
```

## 9. Ані правка, ані типи не змінили решту

```
$ npm run typecheck          exit=0
$ npm run typecheck:tests    exit=0
$ npm run lint               exit=0   ([lint] OK, [web-xss] OK)
$ node scripts/migration-registry-check.mjs   exit=0  (files=86 registered=86 issues=0)
$ node --check <кожен .mjs у .g1-probe>       exit=0
```
