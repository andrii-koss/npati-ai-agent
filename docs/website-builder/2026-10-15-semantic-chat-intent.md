# Semantic chat project routing

The browser previously selected development through keyword rules, while the server
classified the same message independently. Long specifications could become a test,
preview or code-repair request and stop at project selection. Languages outside the
keyword lists and indirect English requests could fall through to research chat.

`chat-project-intent.ts` now asks the user's selected model for a constrained intent
and independent development targets. It receives the original request, authorized
conversation history and presence of project context. Classification has no tools,
a 15-second deadline, enum validation and deterministic fallback. The full original
request remains the execution prompt. Project identifiers and authorization are
resolved by the existing services, never supplied by the classifier.

Both chat transports use the resolver. The browser obtains its development plan
from `POST /chat/development/plan`; process creation validates its own server plan.
A semantic CHAT decision is not overridden by code keywords or a session binding.
Creation selects a new workspace; ordinary edits retain the existing project.

Verification on 2026-10-15:

- 87 focused tests passed, including full NovaShop specification, indirect English
  creation in an existing conversation, Japanese process planning/execution,
  authorization, negative requests, tool selection and research flows.
- Frontend follow-up regression tests passed (2 tests).
- API, web and test TypeScript checks and lint passed.
- Actual connected `deepseek-flash` classified creation correctly in all seven UI
  languages: English, Ukrainian, German, Polish, French, Spanish and Italian.
  Chinese and Arabic creation checks also passed.
- Actual model correctly classified an English explanation-only request as CHAT
  and a German existing-site modification as EDIT_WEBSITE.
- Local Docker API and company-worker rebuilt and healthy on port 13001; both
  server and browser bundles contain the server planning path.

The UI language catalog also needs checking when locales are added; semantic
routing is not restricted to this list. Russian, Portuguese and Japanese requests
are covered by classifier contract tests.

Unrelated existing failure: `chat-entity-mutations.test.ts` / “creates five separate
ideas with one goal and memory per chat turn” reuses the first idea on turn two.
It reproduces with semantic routing disabled and in the original chat implementation
at commit `e8e007b`; this change does not claim a clean run of the entire test suite.
