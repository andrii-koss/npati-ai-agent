# NPATI Coding Agent — next optimisation stage: measured results

Branch `feat/code-run-discipline`, 2026-10-22/23. Local isolated Docker stack (shared sandbox runner), models
`deepseek/deepseek-flash` and `ollama-cloud/gemma4:31b`. Measured with `scripts/measure-coding-scenarios.mjs`
(each invocation creates its own Company; raw events in `artifacts/measure/`, not committed).

## Commits

| Stage | Commit | Change |
|---|---|---|
| 1 | `5d684c5` | One central visual check; a repair only on concrete findings; repair sees the failed screenshot; no re-check after a no-change repair; repeated screenshot without a write answered from run state |
| 1 | `4090760` | Visual differences graded `major`/`minor` (approved by the owner): pass = Browser QA ok, all 5 scores ≥ 0.8, no major difference; minor ones are reported, never repaired |
| 2 | `18d6894` | Prepared `node_modules` profiles built from the same lockfiles the chat scaffold writes (Next.js, React + Vite, Vue 3 + Vite) |
| 3 | `4ed8298` | Tool-less fallback (provider rejects forced `tool_choice`) fetches the named page first |
| 3 | `fee0f62` | A failed `web_fetch`/`web_search` tells the model no content was retrieved |
| 3 | `4515ac1` | Read-only request naming an external URL is web research in chat; unreachable page → fixed localized error built in code |
| 3 | `1796968` | `REVIEW_PROJECT` + external URL no longer ends in the project-pipeline stub |

## Stage 1 — Visual QA (S3, design from a photo)

Cause of 392 → 634 s (previous stage): each repair ran ~8 turns with 3 model screenshots and never saw the screenshot
that failed. After `5d684c5` the model screenshots dropped to 0–4 per scenario, but the pass rate stayed 0/6: the
vision reviewer (`deepseek/deepseek-flash`) scored 0.85–0.98 on all criteria and still listed 5–8 pixel-level
"differences" ("1 px lower", "137 vs 143 px") every run, while the rule required an empty list.

| Run set | DeepSeek S3 | Gemma S3 |
|---|---|---|
| baseline (prev. stage, 1 run) | 392 s ✓ | ≥ 949 s ✗ |
| after (prev. stage, 1 run) | 634 s ✓ | 373 s ✗ |
| `5d684c5`, 3 runs | 597 ✗ · 626 ✗ · 803 ✗ | 576 ✗ · 367 ✗ · 440 ✗ |
| `4090760`, 3 runs | **542 ✓ · 338 ✓ · 314 ✓** | 426 ✗ · **149 ✓** · 325 ✗ |

- `visual_acceptance=passed`: 4/6 (was 0/6). DeepSeek 3/3, mean 398 s (baseline 392 s, one run).
- Both Gemma failures: Browser QA found 1 browser console error on the generated page (a real functional failure;
  visual major differences: 0). The QA service stores only the count of console errors (deliberate redaction), so a
  repair cannot see the message — see recommendations.
- Tokens per S3 still vary widely (128k–649k); repairs 0–2.

## Stage 2 — project preparation before the agent starts

Cause: the image already bakes prepared `node_modules`, but its profiles use version ranges, while the chat scaffold
writes exact versions and a stored lockfile (`project-framework-locks.json`). No chat-created project ever matched, so
each new project ran a full `npm ci` (≈115 MB into an empty per-project cache). Copying the prepared modules takes
≈5.5 s in the sandbox.

Isolation: each project still gets its own writable copy (`cp -R`, no shared writable modules); the lockfile stays the
project's own; any dependency change falls back to `npm ci` as before; the per-project npm cache is unchanged (no
cache shared between projects). Runtime image grows 4.05 → 4.72 GB.

| Metric (S1, message → runner started) | before (6 runs) | after (10 runs) |
|---|---|---|
| runner start | 36–72 s | 4–14 s |
| S1 total | 123–431 s | 69–149 s (one outlier 451 s, model time) |

"Cold" (dependencies differ from the scaffold) behaves exactly as before (`npm ci`); "warm" is every chat-created
Next.js/Vite project.

## Stage 3 — "проаналізуй сайт https://…"

Cause (agent-api log): for a direct URL the native path forces `tool_choice=web_fetch`; DeepSeek in thinking mode
rejects it (HTTP 400) and the tool-less fallback answered from memory. Gemma received the failed fetch and still
described example.com from memory; in a bound project the request without "нічого не змінюй" went to a review run
that inspected the project files instead of the URL.

Live results after `1796968` (local stack):

| Request | DeepSeek | Gemma |
|---|---|---|
| UK, example.com, "нічого не змінюй" | ✓ clear error | ✓ clear error |
| EN, example.com | ✓ clear error | ✓ clear error |
| UK, unreachable `.invalid` host | ✓ clear error | ✓ declines (domain rejected before fetch), no invented analysis |

- **BLOCKED**: analysis of real fetched content on this stack — Web Research egress has no hostname allowlist
  ("No hostname allowlist is configured, so no host is reachable"); configuration was not changed. Covered by unit
  tests only (`tests/chat-tool-production-flow.test.ts`).
- Read-only: when a URL request is routed to the Coding Agent it is `REVIEW_CODE` with `readOnly: true`; external-URL
  analysis now stays in chat (no project writes possible).

## Quality checks

- `npm run typecheck` (all workspaces) and `typecheck:tests`: clean.
- `npm run lint`: fails only on the existing size-guard entry `apps/web/src/DataStudioSettingsPage.tsx` (unchanged).
- Full `vitest run`: 5523 tests, 5468 passed, **11 failed = the same 11 known failures** (agent-api onboarding goal,
  data-studio-d7, minio-startup, object-storage, per-request-no-memory, project-intent-router ×5,
  stage-2-auth-cors-preview) plus the known `coding-agent-e2e/smoke` file error. No new failures.
- Not changed: production, RBAC, approval policies, sandbox isolation, secret checks, feature flags.

## Recommendations (not implemented)

1. Pass a bounded, sanitised console-error message to the visual repair (now only the count is stored).
2. A separate, stronger vision model as reviewer (today the same model builds and judges).
3. A model profile for `gemma4:31b` (runs fall back to `conservative-default`: `no_matching_profile`).
4. Optional system steps behind flags, measured one by one: LLM intent classifier only when the deterministic router
   is unsure, one reference analysis instead of two, self-review only for risky changes, `tsc` + preview check
   instead of a full `next build` for small edits.
