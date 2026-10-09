# Local chat creation: missing Main Agent

The failed local `/chat/stream` request logged `Select an active Main Agent before running the company` from `PostgresWorkspaceStore.createCompanyAgentRun`. The UI received the generic public chat error. Connecting a model works independently of Company delegation, so a successful ordinary chat did not validate this path.

`ensureWebsiteAgent` created or found a qualified builder, but did not assign a Main Agent when the Company lacked one. Project orchestration now assigns that qualified agent before creating the run. An existing active Main Agent is retained; an inactive one produces the explicit `MAIN_AGENT_INACTIVE` response. The regression test starts without a Main Agent and checks creation plus follow-up editing through ordinary streamed chat.

The local runner also reported a successful legacy Docker build while `npati/project-sandbox:local` was subsequently unavailable for execution. The image was rebuilt with BuildKit. The runner image now includes the Buildx plugin and explicitly enables BuildKit for its image builds. The local-only runner Compose file marks locally built images as development/unverified; production image policy remains configured independently in the Dokploy file.

Verification includes the regression suite, API TypeScript/lint, rebuilding the running API/worker/runner, and a signed request to the local runner for readiness and a disposable sandbox creation/destruction. Model-generated store behavior, build and Live Preview still require testing the full user request.

Local results: 19/19 regression tests passed. Signed runner readiness returned all six facts true. A real disposable sandbox was created (HTTP 200) and destroyed (HTTP 200). The 12 application services remain healthy. The locally built image is resolved to its repository digest before admission; the pin is also recorded in the local `.env`. BuildKit writes its configuration under `/tmp/npati-docker`, since the runner root filesystem is read-only. The local testing override starts the runner using the already-built pinned image.

Docker Images contains 14 named images: the 12 application service images plus the Project sandbox and egress images used by generated sites. The readiness proxy and per-Project sandbox containers are runtime resources; they are not duplicate Compose services. The disposable diagnostic sandbox and its proxy/network were removed after verification.
