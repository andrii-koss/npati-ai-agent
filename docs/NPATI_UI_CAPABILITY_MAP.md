# NPATI UI Capability Map

**Audit Phase:** Final Full Runtime Verification  
**Target Environments:** `http://localhost:3000` (Web UI), `http://localhost:3001` (Agent API), `http://localhost:4000` (NPATI Core Backend)  
**Browser Engine:** Microsoft Edge (Chromium) via Playwright Automation  
**Evidence Files:**  
- `artifacts/full-runtime-audit/full-audit-run.json` (Full Product User Journey)  
- `artifacts/full-runtime-audit/business-audit-run.json` (Business Context & Memory User Journey)  
- `artifacts/full-runtime-audit/auth-full-verified.json` (14 Authenticated Routes & Pages)  
- `artifacts/full-runtime-audit/full-browser-test-browser-api.json` (Unauthenticated & Fail-Closed Validation)

---

## 1. UI Navigation & Page Architecture

Every page in NPATI Agent is mapped to backend API endpoints and domain services. The table below documents every UI surface, interactive control, associated capability inventory IDs, backend API contract, runtime service, and live verification evidence.

| UI Route | Interactive Control / View | Capabilities Mapped | API Endpoint | Runtime Service | Runtime Effect | Verification Result |
|---|---|---|---|---|---|---|
| `/` | Sign in / Create account modal | Auth, Security, Tenant Identity | `POST /api/auth/login`, `POST /api/auth/register` | NPATI Core Auth Proxy | Creates/authenticates user, stores JWT in localStorage | **PASS** (Registration, Login, Token Refresh, Logout tested live) |
| `/` | Quick Action Cards (01..06) | Startup, Sales, Growth, Content, Ask | N/A (Client Router) | Web Frontend | Routes user to specialized task workflows | **PASS** (Cards render and route cleanly) |
| `/company` | New Company Button & Modal | #274 (`separate_company_page`) | `POST /api/companies` | WorkspaceStore / PostgreSQL | Persists tenant company record with isolated workspace | **PASS** (Company A and B created in browser) |
| `/company` | Agent Drawer & Agent Editor | #264 (`agent_definitions_crud`), #276 (`agent_editor`) | `POST /api/companies/:id/agents`, `PATCH /api/companies/:id/agents/:agentId` | WorkspaceStore | Creates specialist agents (Main, Research, SEO, Blog, Reviewer) | **PASS** (5 agents created and persisted) |
| `/company` | Main Agent Selector | #277 (`main_agent_configuration`) | `PATCH /api/companies/:id/main-agent` | WorkspaceStore | Sets primary orchestrator agent for multi-agent delegation | **PASS** (Persists across browser reloads) |
| `/company` | Web Search / Tool Toggles | #267 (`per-agent_tool_allowlist`), #281 (`per-agent_tools_configuration`) | `PATCH /api/companies/:id/agents/:agentId` | WorkspaceStore / CompanyDelegationRuntime | Updates per-agent tool allowlist in database | **PASS** (Web Search OFF setting persists in DB) |
| `/company` | Upload Knowledge Document | #263, #292, #297, #298 | `POST /api/companies/:id/knowledge/documents` | KnowledgeProcessor / MinIO / pgvector | Uploads file to MinIO, chunks, embeds, indexes vectors | **PASS** (Secret ALPHA-7391 uploaded & retrieved) |
| `/company` | Company Memory Drawer | #299 (`company_memory`) | `POST /api/companies/:id/memory`, `GET /api/companies/:id/memory` | PostgreSQL | Stores persistent facts scoped to company | **PASS** (Company memory CRUD verified) |
| `/company` | Run Company Button & Execution View | #268 (`manager_delegation`), #283 (`omniroute_orchestration`), #285 (`run_reliability`), #306 | `POST /api/companies/:id/runs`, `GET /api/companies/:id/runs/:runId` | CompanyRunQueue / Worker / OmniRouteAdapter | Queues run in Redis, worker executes pipeline, polls to completed | **PASS** (Browser triggered run completed, 5 steps, 8 audits) |
| `/activity` | Run Trace & Tool Audit Log | #268, #283, #285, Observability | `GET /api/companies/:id/runs`, `GET /api/companies/:id/runs/:runId` | CompanyDelegationRuntime / WorkspaceStore | Displays chronological execution timeline, tool calls, and latencies | **PASS** (Verified with real completed runs) |
| `/settings/capabilities` & `/capabilities` | 306 Capability Inspector | All 306 Capabilities | `GET /api/capabilities/inspect` | EffectiveCapabilityResolver / Registry | Live searchable inspector with slice tabs (All, Callable, Runtime, etc.) | **PASS** (Renders all 306 items with slice filters) |
| `/connections` | Infrastructure Connections Monitor | System Integrations (#1..#6, #292, #301) | `GET /api/health` | Agent API Health Checker | Real-time status for OmniRoute, Postgres, Redis, MinIO, Crawl4AI, Backend | **PASS** (All 6 core services report OK status) |
| `/content` | Content Hub & Drafts Viewer | Marketing & Content Production | `GET /api/companies/:id/runs` | Web Frontend / WorkspaceStore | Collects and displays articles, blog drafts, and SEO structures | **PASS** (Renders drafts and structure cards) |
| `/business` | Business Profile & Setup Form | #275 (`business_onboarding`) | `POST /api/businesses`, `GET /api/businesses` | BusinessBrain / WorkspaceStore | Configures business stage, type, industry, offer | **PASS** (Business A & B created and isolated) |
| `/chat` | Context-Aware Chat & Active Context Switcher | Active Context Boundary (#278, #279, #280) | `POST /api/chat`, `GET /api/workspace/context` | HybridRouter / ContextResolver | Switches context between Neutral, Business A, and Business B | **PASS** (Routes correctly to A without B leakage) |
| `/settings/ai` | AI Model & Provider Marketplace | 352 AI Providers (#1) | `GET /api/ai/marketplace`, `GET /api/ai/routing` | OmniRouteAdapter | Displays 352 OmniRoute providers, models, and BYOK settings | **PASS** (Verified with OmniRoute v3.8.50) |
| `/automations` | Scheduled Tasks & Automations | Automations & Scheduler | `GET /api/companies/:id/automations` | AutomationScheduler / Worker | Manages cron-triggered agent routines | **PASS** (Active tasks and schedule cards render) |
| `/skills` | Skills Catalog | Skills (#1..#74) | `GET /api/skills` | SkillsCatalog | Displays available business skills and tool mappings | **PASS** (Displays Startup, Growth, Sales skills) |
| `/memory` | Business Memory View | Business Context Isolation | `GET /api/businesses/:id/memory` | BusinessBrain | Displays facts confirmed for the active business | **PASS** (Memory CRUD and scoped reload verified) |
| `/goals` | Business Goals Tracker | Measurable Outcomes | `GET /api/businesses/:id/goals` | BusinessBrain | Tracks strategic milestones per business | **PASS** (Goals isolated per business workspace) |

---

## 2. Fail-Closed Security & Unauthorized Access Handling

All protected routes and API endpoints were subjected to automated negative security testing (`artifacts/full-runtime-audit/full-browser-test-browser-api.json`):
- Unauthenticated requests to `/api/companies`, `/api/businesses`, and `/api/capabilities/inspect` return `401 Unauthorized`.
- Cross-user requests with valid tokens attempting to access foreign company IDs, agent IDs, knowledge documents, files, or memory return `404 Not Found` / `403 Forbidden`.
- Forged `x-npati-tenant-id` headers are completely ignored; the authenticated user session strictly dictates tenant boundary.
