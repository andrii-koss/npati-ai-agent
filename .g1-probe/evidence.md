# G1 п.2–4 — сирі виводи перевірок (пісочниця агента)

Тут зібрані **точні** виводи, на які посилається § 7.7 звіту `docs/coding-agent/security-gate-report.md`.
`vitest` у пісочниці агента не запускається (`esbuild` → `spawn EPERM`), тому DB-набори тут лише доводять, що
вони **виконуються** й повідомляють помилку тіла, а справжній прогін на PostgreSQL — за власником.

## 1. Гейт-скрипти

```
$ node scripts/run-security-gate.mjs --list | Measure-Object -Line
  150

$ node scripts/run-security-gate.mjs --db --list
tests/coding-agent-c1c-audit-postgres.test.ts

$ node scripts/run-security-gate.mjs --db            # без DATABASE_URL
[security-gate:db] database-backed suites (SECURITY_GATE_DB_TESTS): 1 configured
[security-gate:db] FAILED: DATABASE_URL is required. This gate proves database-level guarantees and is never
[security-gate:db] skipped or silently reduced to zero executed tests; set DATABASE_URL (PostgreSQL with the
[security-gate:db] pgvector extension, the same image as docker-compose.yml) and run it again.
[security-gate:db] notice: the verdict artifact could not be written (EPERM: ... 'artifacts\security-gate-db-report.json'); the verdict is unaffected
[security-gate:db] FAILED
exit=1

$ node scripts/upgrade-gate.mjs                      # exit=0
[3/5] Checking Database Migration Integrity (files, registration, chain continuity)...
  • Migrations : 86 file(s) in packages/workspace/src, 86 registered version(s), 001_business_workspace .. 086_project_mounted_folders
  • Registration: packages/workspace/src/postgres-store.ts (one SELECT guard + one INSERT per version)
  ✓ every migration file has a version guard and a schema_migrations registration; no duplicate, no gap in 001..086
  • Database half deferred: `npm run gate:upgrade:db` runs it (requires DATABASE_URL, never skipped)

$ node scripts/upgrade-gate.mjs --db                 # без DATABASE_URL, exit=1
  • Database half: running the chain twice on a clean database (upgrade path + idempotency)...
[upgrade-gate:db] FAILED: DATABASE_URL is required. ...
[upgrade-gate:db] FAILED
  RELEASE GATE STATUS: FAILED (Check errors above)

$ node scripts/migration-registry-check.mjs          # exit=0
[migration-registry] files=86 registered=86 first=001_business_workspace last=086_project_mounted_folders issues=0
[migration-registry] OK

$ node scripts/mutation-controls-check.mjs           # exit=0
[mutation-controls] rows=3 decoy=2 cosmetic=1 ok=true issues=0
```

## 2. Невакуумність і документ

```
$ node .g1-probe/registry-nonvacuous.mjs             # exit=0
unmutated repository            : ok=true issues=0 codes=[]
one INSERT row removed (086)    : ok=false issues=1 codes=[migration_registration_insert_missing]
one SELECT guard renamed (085)  : ok=false issues=2 codes=[migration_registration_guard_missing,migration_registration_insert_missing]
one INSERT row duplicated (084) : ok=false issues=1 codes=[migration_registration_duplicate_insert]
one migration file removed (042): ok=false issues=2 codes=[migration_file_missing,migration_chain_gap]
one extra migration file (087)  : ok=false issues=1 codes=[migration_file_unregistered]
the 001-003 loop insert removed : ok=false issues=4 codes=[migration_registration_loop_unpaired,...]

$ node .g1-probe/doc-size-claims.mjs                 # exit=0
GATE_SIZE (SECURITY_GATE_TESTS) = 150
DB list (SECURITY_GATE_DB_TESTS) = 1
missingShapes = []
sizeClaims (5):
  canonical sentence ... = 150
  `--list` row = 150
  bold number after an arrow = 150
  suites= = 150
  present= = 150
missingClaims = [{"shape":"missing=","value":0}]
VERDICT: the document agrees with the hermetic list
```

## 3. Контракт `auth.ts` (реальний провайдер)

```
$ node --experimental-transform-types --no-warnings .g1-probe/auth-retry-contract.mjs    # exit=0
OK   retry contract: initialize calls: 2 (expected 2)
OK   retry contract: reported failures: 1 (expected 1)
OK   retry contract: first report has no negative cache: null (expected null)
OK   retry contract: workspace initialized after the success: true (expected true)
OK   single flight: initialize calls: 1 (expected 1)
OK   single flight: one workspace: 1 (expected 1)
OK   negative cache: initialize calls: 2 (expected 2)
OK   negative cache: reported attempts: 1,2 (expected 1,2)
OK   negative cache: a reason is carried: true (expected true)
OK   negative cache: retryAfter is set: number (expected number)
PROBE: all properties hold
```

## 4. Доказ, що маскування зникло (DB-набір із недосяжною БД)

```
$ $env:NPATI_SECURITY_GATE_DB="1"; $env:DATABASE_URL="postgres://postgres:postgres@127.0.0.1:55432/npati_g1_none?connect_timeout=1"
$ node --experimental-transform-types --no-warnings ./artifacts/c5b-policy-probe/run.mjs tests/coding-agent-c1c-audit-postgres.test.ts
harness: suites=1 tests=3 passed=0 failed=3
  ✗ ... > rejects UPDATE and DELETE under the application role even while that role holds the privileges
    connect ECONNREFUSED 127.0.0.1:55432
[cleanup also failed] Error: connect ECONNREFUSED 127.0.0.1:55432
  ✗ ... > rejects a rogue INSERT that would fork the chain under the application role
    connect ECONNREFUSED 127.0.0.1:55432
[cleanup also failed] Error: connect ECONNREFUSED 127.0.0.1:55432
  ✗ ... > detects a raw out-of-band edit through verifyChain (simulated by disabling the trigger)
    connect ECONNREFUSED 127.0.0.1:55432
[cleanup also failed] Error: connect ECONNREFUSED 127.0.0.1:55432
exit=1

# те саме для другого DB-набору:
$ ... run.mjs tests/coding-agent-g1-migrations-postgres.test.ts
harness: suites=1 tests=2 passed=0 failed=2      (ті самі дві помилки в кожному тесті)

# без маркера (як у `npm test`) набір не виконується, і харнес каже чому:
$ ... run.mjs tests/coding-agent-c1c-audit-postgres.test.ts
harness: FAILED TO LOAD tests/coding-agent-c1c-audit-postgres.test.ts
  Error: ...: this is a database-backed suite and the runner in use has no `describe.skip`.
  Run it through its own gate, which requires DATABASE_URL and is never skipped:
  `npm run security-gate:db` (audit journal) or `npm run gate:upgrade:db` (migration chain).
```

## 5. Харнес на регресійних наборах (дозволяючий оракул)

```
c4a-security-gate + c14-policy-phase-and-gate-size-guard   suites=4  tests=19 passed=19 failed=0
c14-ci-and-lint-gates                                      suites=3  tests=21 passed=21 failed=0
c15-mount-sandbox                                          suites=5  tests=20 passed=20 failed=0
c10-route-auth-wiring                                      suites=2  tests=8  passed=8  failed=0
c13-capability-catalog-audit + c14-attack-catalogue +
  c14-mutation-branch-controls + c5b-policy-rbac +
  c5a-rbac-foundation                                      suites=23 tests=95 passed=95 failed=0
npati-backend-auth                                         suites=1  tests=19 passed=19 failed=0
c1c-audit-log + c6a-migration-safety + c6a-reaper +
  c1a-flags + c14-known-failures                           suites=22 tests=86 passed=84 failed=2
     (обидва: `expect.stringContaining is not a function` — шім його не має; файл не змінювався)
c1-foundation + c15-mounted-workspace +
  c14-gate-mutation-sensitivity + c9-test-integrity        suites=11 tests=50 passed=49 failed=1
     (`c15-mounted-workspace`: ENOTEMPTY при видаленні тимчасового каталогу з Windows-junction; файл не змінювався)
upgrade-compatibility-and-release-gate                     suites=6  tests=35 passed=31 failed=4
     (усі 4 — шімові обмеження: vi.stubGlobal, vi.fn().mockImplementation, resolves.not; нові тести реєстру пройшли)
production-p01-security + session-stream-routes            suites=8  tests=12 passed=8  failed=4
     (усі 4 — toThrow("рядок"), який шім не підтримує; файли не змінювалися)
```

Пін порядку «guard до vitest» (`tests/coding-agent-c14-mutation-branch-controls.test.ts`) перевірено чисельно:

```
guardAt=97553  vitestAt=98691  ordered=true      # indexOf("validateMutationControls(") < indexOf('vitestBin, "run"')
```
