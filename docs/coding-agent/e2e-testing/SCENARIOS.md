# Scenario authoring and assertion contract

**This is a specification, not executable E2E code.** E0 must choose supported format/library based on actual repo.

Example conceptual schema:
```yaml
id: T011
version: 1
suite: regression
category: Coding
preconditions:
  isolated_environment: true
  supported_stack: nextjs
chat_steps:
  - text: "Створи інтернет-магазин на Next.js із Home, Products, Cart і Contact. Запусти build та Live Preview."
    asserts: [project_created, expected_routes, build_success, preview_2xx]
  - text: "Зміни основний колір на червоний і додай пошук товарів."
    asserts: [same_project, previous_routes_retained, search_works, build_success]
  - text: "Додай сторінку деталей товару та кнопку Add to Cart."
    asserts: [same_project, detail_route, cart_persists, build_success]
  - text: "Перевір усі сторінки та виправ помилки."
    asserts: [browser_navigation, no_critical_console_errors, build_success]
  - text: "Оптимізуй код без зміни існуючого дизайну."
    asserts: [same_project, no_regression, build_success, ui_snapshot_with_tolerance]
assertions:
  trace_correlated: true
  no_cross_project_writes: true
  no_unbounded_retry: true
  completion_is_terminal: true
retry_policy:
  max_retries: 2
cleanup: always
```

## Objective verifications
- File checks must use workspace-specific actual path and file hash/contents.
- Build: exit code 0 and no hidden failed build; positive HTTP from actual preview after ready signal.
- Browser: test navigation/search/cart action semantics using stable semantic locators; no exact markup if unnecessary.
- Trace: compare backend source-of-truth events vs API and rendered Activity UI, allow legitimate asynchronous ordering via explicit tolerances.
- LLM tool calls: allow valid alternatives; never assert fixed number of steps except where safety/loop thresholds require it.
- Unknown environment, costs or port: Blocked, do not guess.

## Failure taxonomy
NPATI_BUG, TEST_BUG, PROVIDER_FAILURE, INFRA_FAILURE, MODEL_VARIANCE, CONFIG_FAILURE, SAFETY_BLOCKED; keep raw error and redacted evidence. Negative-fixture tests pass only when the system correctly detects and reports the intentional failure.
