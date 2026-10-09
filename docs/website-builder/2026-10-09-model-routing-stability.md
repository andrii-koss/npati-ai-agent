# Website Builder: default model and sandbox readiness

## Reported failure

The request `Створи тестовий сайт інтернет магазин на Next.js, запусти build і Live Preview.` failed before build with `NPATI AI chat failed with HTTP 502: [ollama-cloud/gemma4:31b] Provider returned empty content (reset after 3s)`, while Settings showed an OpenAI model as default.

The supplied runner log separately reported `No such container: npati-egress` during egress checks. Sandbox images built successfully in that log. These are two separate failure paths; the runner log does not establish the upstream provider's reason for returning empty content.

## Model routing fix

The application resolves the selected chat model from the user's Settings preferences. However, agent combo names previously depended only on workspace, company, agent ID and revision. OmniRoute's existing-combo response leaves the existing configuration intact. Changing the Settings default without changing the agent revision therefore reused a route containing the previous model.

Agent route identities now include effective model candidates, system instructions, tools and timeout. Pipeline/Fusion identities include the actual child route identities and judge model. A changed default produces a new route; repeated requests with the same configuration reuse that route. Strict Settings routing retains only the selected model, without adding unrelated provider fallbacks. Run steps record the effective selected model.

Provider HTTP errors and empty-content errors are classified as model failures in the Website Builder, so they are distinguishable from build failures.

## Runner readiness fix

Readiness previously checked a default proxy name that the runner never created. Project proxies have per-run names. Readiness now prepares its own `npati-readiness-egress` proxy and `npati-readiness-net` internal isolated network, using the configured proxy image and allowed hosts. It uses a separate enforcement instance from Project runs. Only a proxy carrying the readiness ownership label may be replaced when its configuration changes.

Enforcement checks snapshot the scope before probing and cache results by scope. A successful check for one Project cannot validate a different Project network. Proxy health checks allow bounded startup retries. Direct internet access and DNS bypass checks still fail closed.

## Validation and deployment

Regression tests cover changing Gemma to OpenAI while retaining an immutable old combo, unchanged agent revisions, repeated route reuse, provider-error classification, readiness setup/reuse/configuration changes, rejection of unmanaged resources, failed setup, and cache isolation between networks. Company runtime tests explicitly configure a Settings default model to exercise the production routing contract.

Local validation passed: 80 targeted tests across model routing, Company runtime, egress/readiness, runner diagnostics and Website Builder; API and test TypeScript checks; lint; agent API build (including the sandbox runner). A live Docker test could not run because the local Docker Desktop Linux daemon is unavailable.

Deploy both the updated agent API and sandbox runner. An existing failed run needs a new request; these changes do not retroactively complete it. Verify the selected model in the new run and the runner's `overall_ready` before testing build and Live Preview. The production run has not been replayed from this workspace.

The log's `runner_store_not_configured` warning is independent: configure the runner's `DATABASE_URL` if persistent image revocations are required. It does not explain the stale Gemma route.
