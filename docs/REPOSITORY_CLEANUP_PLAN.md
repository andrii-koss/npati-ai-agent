# NPATI Agent — Repository Cleanup Plan (Dry Run)

**Date:** 2026-09-06  
**Status:** DRY RUN COMPLETED — READY FOR EXECUTION  
**Objective:** Establish a pristine, production-ready repository structure by removing one-off audit artifacts, temporary screenshots, PDFs, obsolete scripts, and test data, while strictly preserving all production code, reusable tests, permanent verification scripts, and canonical documentation.

---

## 1. Classification Methodology & Safeguards

Each candidate item is classified into one of the following mutually exclusive categories:
- **`KEEP_PRODUCTION`**: Required for production runtime, build, or Docker deployment.
- **`KEEP_TEST`**: Reusable unit, integration, E2E, benchmark, or regression test/script.
- **`KEEP_DOCUMENTATION`**: Permanent architecture, operational, or release documentation.
- **`MOVE_DOCUMENTATION`**: Documentation to be organized into canonical `docs/`.
- **`TEMPORARY_DELETE`**: Empty scratch folders or temporary working artifacts.
- **`GENERATED_ARTIFACT_DELETE`**: Ephemeral test outputs (screenshots, PDFs, text downloads, JSON traces).
- **`ONE_TIME_SCRIPT_DELETE`**: Single-use audit/patching scripts with zero external or npm references.
- **`UNKNOWN_DO_NOT_DELETE`**: Any file where usage is uncertain (preserved unconditionally).

### Pre-Deletion Verification Checklist
- [x] Package.json scripts & dependencies checked
- [x] Imports and TypeScript build paths checked
- [x] Test suite files (`tests/*.test.ts`) checked
- [x] Docker & CI files checked
- [x] Database migrations & schema references checked
- [x] Runtime & dynamic imports checked

---

## 2. Inventory & Classification Matrix

### A. Root Files & Documentation

| Path | Classification | Reason | References | Action |
|---|---|---|---|---|
| `NPATI_AGENT_CAPABILITY_INTEGRATION_MASTER_PLAN.md` | `MOVE_DOCUMENTATION` | Primary 306-capability integration master plan | Reference in audit reports | Copy/Move to `docs/` |
| `FINAL_MASTER_PLAN_COMPLETION_REPORT.md` | `MOVE_DOCUMENTATION` | Final 14-phase completion report | Reference in audit reports | Copy/Move to `docs/` |
| `RELEASE_NOTES.md` | `KEEP_DOCUMENTATION` | Standard repository root release notes | Standard repository file | KEEP in root & sync to `docs/` |
| `README.md` | `KEEP_PRODUCTION` | Main repository entrypoint | Developer guide | KEEP |
| `THIRD_PARTY_NOTICES.md` | `KEEP_PRODUCTION` | Open-source license attribution | Legal / compliance | KEEP |
| `omniroute_v3.8.50_openclaw_features_roadmap_NPATI_with_plan.xlsx` | `KEEP_DOCUMENTATION` | Source-of-truth Excel workbook for 306 capabilities | Referenced by audit scripts | KEEP |
| `Промпт для створення фундаменту NPATI Agent.md` | `MOVE_DOCUMENTATION` | Original Ukrainian foundation prompt with encoding issue | Historical architecture | Move to `docs/FOUNDATION_PROMPT.md` |
| `scratch_original/` | `TEMPORARY_DELETE` | Empty temporary directory | None | DELETE |

---

### B. Artifacts (`artifacts/`)

| Path | Classification | Reason | References | Action |
|---|---|---|---|---|
| `artifacts/agent-gate/agent-download.txt` | `GENERATED_ARTIFACT_DELETE` | Temporary download file from Playwright gate | None | DELETE |
| `artifacts/agent-gate/agent-gate-report.pdf` | `GENERATED_ARTIFACT_DELETE` | Temporary PDF capture from Playwright gate | None | DELETE |
| `artifacts/agent-gate/agent-gate-screenshot.png` | `GENERATED_ARTIFACT_DELETE` | Temporary PNG capture from Playwright gate | None | DELETE |
| `artifacts/agent-gate/agent-gate-trace.json` | `GENERATED_ARTIFACT_DELETE` | Ephemeral execution trace (evidence compiled into `docs/`) | None | DELETE |
| `artifacts/agent-gate/test-company-doc.md` | `GENERATED_ARTIFACT_DELETE` | Temporary input file for document IO test | None | DELETE |
| `artifacts/tools-inventory-analysis.json` | `GENERATED_ARTIFACT_DELETE` | Intermediate JSON dump of 74 callable items | None | DELETE |
| `artifacts/real-runtime-verification/` (all files) | `GENERATED_ARTIFACT_DELETE` | Provisional test captures (PDF, PNG, text, JSON) | None | DELETE |
| `artifacts/full-runtime-audit/` (all files) | `GENERATED_ARTIFACT_DELETE` | 60+ temporary audit screenshots, logs, and JSON outputs | None | DELETE |
| `artifacts/.gitkeep` | `KEEP_PRODUCTION` | Placeholder to preserve directory structure | Git tracking | KEEP |

---

### C. Scripts (`scripts/`)

| Path | Classification | Reason | References | Action |
|---|---|---|---|---|
| `scripts/generate-omniroute-provider-catalog.mjs` | `KEEP_PRODUCTION` | Generates AI provider catalog on build | `package.json: catalog:generate, build` | KEEP |
| `scripts/verify-capability-matrix.mjs` | `KEEP_PRODUCTION` | Audits capability matrix compliance | `package.json: audit:capabilities` | KEEP |
| `scripts/scale-benchmark.mjs` | `KEEP_TEST` | Reusable scale & load benchmarking engine | `package.json: benchmark:scale` | KEEP |
| `scripts/run-scale-certification.mjs` | `KEEP_TEST` | Reusable SLO & load certification runner | `package.json: cert:scale` | KEEP |
| `scripts/upgrade-gate.mjs` | `KEEP_TEST` | Reusable release & upgrade regression gate | `package.json: gate:upgrade` | KEEP |
| `scripts/revalidate-306-capabilities.mjs` | `KEEP_TEST` | Reusable 306-capability revalidation suite | `package.json: revalidate:306` | KEEP |
| `scripts/execute-agent-mediated-gate.mjs` | `KEEP_TEST` | Reusable agent-mediated tool gate against real Docker services | None (reusable testing asset) | KEEP |
| `scripts/load-company-read.mjs` | `KEEP_TEST` | Reusable company read load test | None (reusable benchmark) | KEEP |
| `scripts/verify-company-recovery.mjs` | `KEEP_TEST` | Reusable company recovery verification | None (reusable verification) | KEEP |
| `scripts/verify-npati-004.mjs` | `KEEP_TEST` | Reusable schema & migration verification | None (reusable verification) | KEEP |
| `scripts/verify-npati-004-e2e.mjs` | `KEEP_TEST` | Reusable migration-004 E2E verification | None (reusable verification) | KEEP |
| `scripts/analyze-tools-inventory.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off extraction of 74 tools | No code references | DELETE |
| `scripts/apply-registry-cleanup.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off matrix flag updater (already applied) | No code references | DELETE |
| `scripts/build-tool-test-matrix.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off code generator for tool matrix | No code references | DELETE |
| `scripts/fix-blocked-required-connections.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off catalog patcher (already applied) | No code references | DELETE |
| `scripts/format-callable-tools.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off console table formatter | No code references | DELETE |
| `scripts/generate-clean-runtime-artifacts.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off generator for audit docs (docs now canonical) | No code references | DELETE |
| `scripts/generate-final-audit-artifacts.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off generator for obsolete audit outputs | No code references | DELETE |
| `scripts/runtime-audit-auth-regression.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off audit check script | No code references | DELETE |
| `scripts/runtime-audit-authenticated.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off audit check script | No code references | DELETE |
| `scripts/runtime-audit-browser.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off browser audit script | No code references | DELETE |
| `scripts/runtime-audit-business.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off audit business seeder | No code references | DELETE |
| `scripts/runtime-audit-discovery.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off discovery counter | No code references | DELETE |
| `scripts/runtime-audit-fix-api-keys.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off fix script | No code references | DELETE |
| `scripts/runtime-audit-fix-auth-ui.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off fix script | No code references | DELETE |
| `scripts/runtime-audit-fix-auth.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off fix script | No code references | DELETE |
| `scripts/runtime-audit-fix-company-ui.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off fix script | No code references | DELETE |
| `scripts/runtime-audit-maintenance.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off maintenance script | No code references | DELETE |
| `scripts/runtime-audit-product.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off product scenario script | No code references | DELETE |
| `scripts/runtime-audit-reports.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off report generator | No code references | DELETE |
| `scripts/test-categorization.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off prototype classification tester | No code references | DELETE |
| `scripts/test-clean-callable-list.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off prototype filter tester | No code references | DELETE |
| `scripts/test-prototypes.mjs` | `ONE_TIME_SCRIPT_DELETE` | One-off prototype tester for downloads/reminders | No code references | DELETE |
| `scripts/verify-real-agent-tools.mjs` | `ONE_TIME_SCRIPT_DELETE` | Provisional verification superseded by agent gate | No code references | DELETE |

---

### D. Automated Tests (`tests/`)

All **123 test files** in `tests/` are classified as **`KEEP_TEST`**.  
None of them will be deleted. They form the canonical automated test suite (1049 tests).

---

### E. Test Database & Storage Records to Clean

Only records matching audit-specific prefixes/IDs will be removed. All `dev-user` and production data will remain strictly untouched.

| Target Resource | Specific Test Record Identifier | Action |
|---|---|---|
| PostgreSQL `users` | 26 audit users (`WHERE external_subject LIKE 'npati:%' AND id != 'dev-user'`) | DELETE (Cascades to child companies, agents, runs) |
| PostgreSQL `businesses` | 9 audit businesses (`WHERE owner_user_id != 'dev-user'`) | DELETE (Cascaded) |
| PostgreSQL `companies` | 14 audit companies (`WHERE user_id != 'dev-user'`) | DELETE (Cascaded) |
| PostgreSQL `company_memories` | 10 audit memories (`WHERE user_id != 'dev-user'`) | DELETE (Cascaded) |
| PostgreSQL `files` | 8 audit files (`runtime-audit-secret.txt`, `WHERE user_id != 'dev-user'`) | DELETE (Cascaded) |
| MinIO `npati-company-knowledge` | 8 audit objects (`workspace/*/knowledge/*`) | DELETE via S3 API / mc |
| Redis | Transient keys have naturally expired; heartbeat/queues intact | KEEP queues intact |

---

## 3. Post-Cleanup Verification Commands

Following the execution of this plan, the following validation commands must pass with zero errors:
1. `npm test` (all 123 test files green)
2. `npm run typecheck` (zero TypeScript errors)
3. `npm run build` (successful compilation of `@npati/agent-api` and `@npati/web`)
4. `npm run audit:capabilities` (306/306 capability matrix verified)
5. `npm run revalidate:306` (8-state revalidation passed)
6. `npm run gate:upgrade` (production upgrade gate verified)
7. `npm run cert:scale` (scale certification SLO verified)
