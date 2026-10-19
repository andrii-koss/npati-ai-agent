# PLAN verification progress — 2026-10-19

**Incomplete audit.** Continue the existing2960-clause [matrix](plan-verification-matrix.md). Current totals: 2057 Verified, 664 Partial, 5 Broken, 17 Missing, 210 Not Verified, 7 Blocked, 0 Unassessed. Independently reassessed across the continuation series: 1451. This batch rechecked442 unique clauses in14 logical sections;47 unique changed Verified contracts were recertified in50 actions.

Latest [PLAN-wide continuation](2026-10-19-plan-wide-continuation.md): actual Linux55/55, actual shared supervisor15/15, PostgreSQL9/9, official DB gate9/9, hermetic gate183 suites/2779 passed/0 failed/0 skipped. API/test typecheck, root build and lint pass. Model-profile documentation command27/27. These are scoped fixtures and scripted-model API/DB integration; no live-model/Preview/browser/admitted-image certificate.

| Stage | Total | Verified | Partial | Broken | Missing | Not Verified | Blocked | Unassessed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GLOBAL | 699 | 279 | 252 | 0 | 1 | 167 | 0 | 0 |
| C0 | 188 | 183 | 0 | 0 | 0 | 5 | 0 | 0 |
| C1 | 100 | 86 | 0 | 0 | 0 | 14 | 0 | 0 |
| C1c | 82 | 74 | 0 | 0 | 1 | 7 | 0 | 0 |
| C1a | 150 | 51 | 86 | 0 | 2 | 11 | 0 | 0 |
| C1b | 70 | 26 | 35 | 2 | 1 | 2 | 4 | 0 |
| C2 | 58 | 38 | 20 | 0 | 0 | 0 | 0 | 0 |
| C3 | 72 | 62 | 3 | 3 | 1 | 3 | 0 | 0 |
| C4 | 112 | 89 | 23 | 0 | 0 | 0 | 0 | 0 |
| C4a | 92 | 85 | 5 | 0 | 2 | 0 | 0 | 0 |
| C4b | 85 | 85 | 0 | 0 | 0 | 0 | 0 | 0 |
| C5 | 68 | 63 | 1 | 0 | 4 | 0 | 0 | 0 |
| C5a | 117 | 60 | 55 | 0 | 2 | 0 | 0 | 0 |
| C5b | 84 | 82 | 2 | 0 | 0 | 0 | 0 | 0 |
| C6 | 99 | 65 | 34 | 0 | 0 | 0 | 0 | 0 |
| C6a | 113 | 90 | 20 | 0 | 3 | 0 | 0 | 0 |
| C6b | 84 | 84 | 0 | 0 | 0 | 0 | 0 | 0 |
| C7 | 66 | 50 | 16 | 0 | 0 | 0 | 0 | 0 |
| G1 | 145 | 56 | 85 | 0 | 0 | 1 | 3 | 0 |
| R1 | 140 | 140 | 0 | 0 | 0 | 0 | 0 | 0 |
| C8 | 42 | 38 | 4 | 0 | 0 | 0 | 0 | 0 |
| C9 | 48 | 48 | 0 | 0 | 0 | 0 | 0 | 0 |
| C10 | 44 | 30 | 14 | 0 | 0 | 0 | 0 | 0 |
| C11 | 48 | 48 | 0 | 0 | 0 | 0 | 0 | 0 |
| C12 | 42 | 42 | 0 | 0 | 0 | 0 | 0 | 0 |
| C13 | 35 | 31 | 4 | 0 | 0 | 0 | 0 | 0 |
| C14 | 54 | 49 | 5 | 0 | 0 | 0 | 0 | 0 |
| C15 | 23 | 23 | 0 | 0 | 0 | 0 | 0 | 0 |

## Remaining exact scope

Not Verified by stage: {"GLOBAL":167,"C0":5,"C1":14,"C1c":7,"C1a":11,"C1b":2,"C3":3,"G1":1}. All903 non-Verified rows remain in open-obligations.json; every Broken/Missing/Blocked ID is in plan-priority-open-register.json. Counts after each logical section are saved in plan-section-progress.json.

Next unresolved: C1.L0244.01 — ЗАВДАННЯ: розширити Project/Workspace для довільного коду. Continue early project/contract and global requirements; do not restart the confirmed stages. C3 remains open on cleanup ownership, stale API generation and mutation/legacy writer isolation. Optional atomic-task mode is absent; owner risk/sign-off and image CI decisions are blocked, not fabricated.

Docker recovered after the initial unavailable checkpoint; current owned Linux and PostgreSQL fixtures completed and cleanup is recorded. One shared Sandbox with logical project isolation remains the architecture. Production, security profiles, approval rules and CI triggers were not changed. Host Node22.13.1 remains below the supported22.22.2 floor.

Earlier C3 checkpoints retain their historical results. Latest prefixes: plan-accept-, plan-wide-db-, plan-wide-linux-shared. Do not rerun one-shot review scripts on an advanced ledger.
