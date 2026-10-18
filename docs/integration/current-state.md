# NPATI Website Integration — Current State

- **Current stage:** S6 Scenarios B/D, Documentation & Final Report Completed
- **Approved stage:** S6
- **Completed stages:** 
  - S1 Autonomous E2E Audit (`stage-1-report.md`)
  - S2 Signup/Login & Preview Fixes (`stage-2-report.md`)
  - S3 Network Isolation & Security Hardening (`stage-3-report.md`)
  - S4 MinIO Media Integration (`stage-4-report.md` - 30/30 checks passed)
  - S5 Delete Website Lifecycle & Soft Delete (`stage-5-report.md` - 12/12 requirements passed)
  - S6 Scenarios B/D, Documentation & Final Report (`stage-6-report.md` - 10/10 consolidated checks passed)
- **Repository / commit / worktree:** commit `2bd5ff6`+, branch `main`
- **Last updated:** 2026-10-18

## Source of truth
- Existing repo `docs/coding-agent/PLAN.md` (updated with REQ-INT-01..10)
- Existing repo `docs/data-studio/PLAN.md` (updated with REQ-DS-01..07)
- Existing repo `docs/coding-agent/plan-verification-matrix.md` (73 Stage 6 rows verified, 1790 total verified)
- Stage reports: `stage-1-report.md` through `stage-6-report.md`

## Findings and confirmed behavior
- **Scenario B Confirmed (Website + Data Studio):**
  - Project databases `db_<backendId>_dev` and `db_<backendId>_prod` provisioned in isolated `postgres-projects` container.
  - Tables `products`, `_npati_auth_users`, `orders`, `order_items`, `carts`, `cart_items` initialized and verified.
  - Seeded products accessible via Project API Gateway with valid `X-Project-Key`.
- **Scenario D Confirmed (Autonomous Agent Chat Flow):**
  - Next.js store structure created via real tool calls (`code.fs.write`, `code.fs.edit`).
  - Project built cleanly with `npm run build` in sandbox runner.
  - Live Preview proxy running on port 3061 via signed token bridge.
  - Headless Chromium Playwright browser test executed:
    - Homepage loaded (`preview-initial-load.png`)
    - Customer registration (`preview-signup-success.png`, customer added to `_npati_auth_users`)
    - Cart interaction (`preview-cart-items.png`)
    - Checkout and order placement (`preview-order-success.png`, order added to `orders` table)
  - Second-turn chat modification ("Преміум колекція 2026") applied to the same project (`preview-updated-catalog.png`) with 0 data loss and unchanged Project ID.
- **Security & Tenant Isolation Confirmed:**
  - Sandbox container has ZERO direct TCP/SQL connection to NPATI Core PostgreSQL (`postgres:5432` / `172.24.0.8`).
  - Preview Token minted for Project A rejected on Project B with HTTP 403 `token_scope_denied`.
  - Non-authorized visitor attempts to execute Data Studio schema mutation DDL rejected with HTTP 403 `BUSINESS_ACCESS_DENIED`.
  - API Gateway rejects unauthenticated collection requests with HTTP 401 `MISSING_API_KEY`.
  - User production project `715009ee-a7bf-4999-bce2-053d207b7af5` verified 100% untouched in PostgreSQL with status `previewing`.

## Tests run (exact commands and results)
- `node scratch/run-stage-6-consolidated-suite.cjs`: Exit code 0 (10/10 passed, 100%)
- `node scratch/run-playwright-tests.cjs`: Exit code 0 (Playwright browser signup/cart/order flow passed)
- `node scratch/send-message-2-and-verify.cjs`: Exit code 0 (Second-turn edit passed)
- `node scratch/test-stage-4-targeted-verification.cjs`: Exit code 0 (30/30 passed, 100%)
- `node scratch/test-stage-3-targeted-verification.cjs`: Exit code 0 (3/3 passed, 100%)
- `node scratch/test-lifecycle-cleanup.cjs`: Exit code 0 (7/7 passed, 100%)

## Files changed in Stage 6
- `docs/coding-agent/PLAN.md` (added formal specification REQ-INT-01..10)
- `docs/data-studio/PLAN.md` (added formal specification REQ-DS-01..07)
- `docs/coding-agent/plan-verification-matrix.md` (verified 73 Stage 6 requirements, updated counts)
- `docs/integration/current-state.md` (updated)
- `docs/integration/stage-6-report.md` (created comprehensive final integration report)

## Risks / blockers
- None. All integration scenarios and security boundaries verified with factual command evidence on live running containers.

## Next action
- STOP. Await explicit user review and confirmation of Stage 6 completion.

