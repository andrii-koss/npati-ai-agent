# E2E QA Test Matrix — candidate scenarios

> Planned scenarios, NOT executed. E0 maps each case to real supported architecture. Smoke/Regression/Full selection may be refined without losing coverage.

| ID | Category | Scenario | Default suite | State | Evidence |
|---|---|---|---|---|---|
| T001 | Smoke | `chat-auth-real` | Smoke | Not Verified | — |
| T002 | Smoke | `chat-streaming-termination` | Smoke | Not Verified | — |
| T003 | Smoke | `create-small-project` | Smoke | Not Verified | — |
| T004 | Smoke | `create-file` | Smoke | Not Verified | — |
| T005 | Smoke | `edit-existing-file` | Smoke | Not Verified | — |
| T006 | Smoke | `safe-terminal` | Smoke | Not Verified | — |
| T007 | Smoke | `small-build` | Smoke | Not Verified | — |
| T008 | Smoke | `preview-http` | Smoke | Not Verified | — |
| T009 | Smoke | `same-chat-second-turn` | Smoke | Not Verified | — |
| T010 | Smoke | `trace-minimum` | Smoke | Not Verified | — |
| T011 | Coding | `nextjs-create-pages` | Regression | Not Verified | — |
| T012 | Coding | `nextjs-red-theme` | Regression | Not Verified | — |
| T013 | Coding | `nextjs-search-products` | Regression | Not Verified | — |
| T014 | Coding | `nextjs-cart-detail` | Regression | Not Verified | — |
| T015 | Coding | `nextjs-refactor-preserve` | Regression | Not Verified | — |
| T016 | Coding | `vite-create-app` | Regression | Not Verified | — |
| T017 | Coding | `node-api-endpoint` | Regression | Not Verified | — |
| T018 | Coding | `python-app-if-supported` | Regression | Not Verified | — |
| T019 | Coding | `multifile-rename` | Regression | Not Verified | — |
| T020 | Coding | `bugfix-ts-error` | Regression | Not Verified | — |
| T021 | Coding | `dependency-install` | Regression | Not Verified | — |
| T022 | Coding | `rollback-checkpoint` | Regression | Not Verified | — |
| T023 | Interaction | `real-browser-login` | Regression | Not Verified | — |
| T024 | Interaction | `real-browser-chat-stream` | Regression | Not Verified | — |
| T025 | Interaction | `DOM-navigation` | Regression | Not Verified | — |
| T026 | Interaction | `DOM-search` | Regression | Not Verified | — |
| T027 | Interaction | `DOM-cart` | Regression | Not Verified | — |
| T028 | Interaction | `DOM-contact-form` | Regression | Not Verified | — |
| T029 | Interaction | `browser-console` | Regression | Not Verified | — |
| T030 | Interaction | `browser-accessibility-basics` | Regression | Not Verified | — |
| T031 | Context | `long-prompt-instructions` | Regression | Not Verified | — |
| T032 | Context | `second-turn-same-project` | Regression | Not Verified | — |
| T033 | Context | `UA-reply-language` | Regression | Not Verified | — |
| T034 | Context | `EN-reply-language` | Regression | Not Verified | — |
| T035 | Context | `PT-reply-language` | Regression | Not Verified | — |
| T036 | Context | `refresh-chat` | Regression | Not Verified | — |
| T037 | Context | `SSE-reconnect` | Regression | Not Verified | — |
| T038 | Context | `context-compaction` | Regression | Not Verified | — |
| T039 | Context | `session-resume` | Regression | Not Verified | — |
| T040 | Trace | `tool-call-correlation` | Full | Not Verified | — |
| T041 | Trace | `stderr-exit-code` | Full | Not Verified | — |
| T042 | Trace | `build-failure-trace` | Full | Not Verified | — |
| T043 | Trace | `preview-failure-trace` | Full | Not Verified | — |
| T044 | Trace | `trace-refresh-persistence` | Full | Not Verified | — |
| T045 | Trace | `retry-events` | Full | Not Verified | — |
| T046 | Trace | `approval-trace` | Full | Not Verified | — |
| T047 | Trace | `loop-no-progress` | Full | Not Verified | — |
| T048 | Recovery | `provider-429` | Full | Not Verified | — |
| T049 | Recovery | `provider-502` | Full | Not Verified | — |
| T050 | Recovery | `provider-model-mismatch` | Full | Not Verified | — |
| T051 | Recovery | `terminal-timeout` | Full | Not Verified | — |
| T052 | Recovery | `worker-restart` | Full | Not Verified | — |
| T053 | Recovery | `duplicate-message` | Full | Not Verified | — |
| T054 | Recovery | `cancel-during-build` | Full | Not Verified | — |
| T055 | Recovery | `approval-denied` | Full | Not Verified | — |
| T056 | Recovery | `child-agent-resume` | Full | Not Verified | — |
| T057 | Recovery | `preview-crash` | Full | Not Verified | — |
| T058 | Security | `project-isolation` | Full | Not Verified | — |
| T059 | Security | `tenant-boundary` | Full | Not Verified | — |
| T060 | Security | `path-traversal-denied` | Full | Not Verified | — |
| T061 | Security | `approval-bypass-denied` | Full | Not Verified | — |
| T062 | Security | `secret-redaction` | Full | Not Verified | — |
| T063 | Security | `sandbox-host-escape-denied` | Full | Not Verified | — |
| T064 | Security | `fault-injection-prod-off` | Full | Not Verified | — |
| T065 | Concurrency | `two-projects-parallel` | Full | Not Verified | — |
| T066 | Concurrency | `simultaneous-file-edits` | Full | Not Verified | — |
| T067 | Concurrency | `orphan-cleanup` | Full | Not Verified | — |
| T068 | Concurrency | `budget-hard-stop` | Full | Not Verified | — |
| T069 | Concurrency | `report-negative-fixture` | Full | Not Verified | — |

## Rules
Each test includes positive/negative expected outcome assertions, budget, run status, user/project isolation and cleanup. A blocked unsupported Python path must be recorded, not silently faked.
