// Auto-generated canonical Capability Catalog covering all 306 inventory items
import type { CapabilityDefinition } from "./capabilities";

export const CAPABILITY_CATALOG: CapabilityDefinition[] = [
  {
    "id": "ai.352_ai_providers",
    "inventoryIds": [
      1
    ],
    "type": "runtime",
    "domain": "ai",
    "name": "352 AI providers",
    "description": "Залишити OmniRoute центральним model/provider gateway.",
    "useWhen": [
      "Internal system execution requires 352 AI providers"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.openai_chat_completions",
    "inventoryIds": [
      2
    ],
    "type": "runtime",
    "domain": "system",
    "name": "OpenAI Chat Completions",
    "description": "Залишити як основний сумісний inference endpoint.",
    "useWhen": [
      "Internal system execution requires OpenAI Chat Completions"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.openai_responses_api",
    "inventoryIds": [
      3
    ],
    "type": "runtime",
    "domain": "system",
    "name": "OpenAI Responses API",
    "description": "Важливо для Codex/coding та tool-heavy агентів.",
    "useWhen": [
      "Internal system execution requires OpenAI Responses API"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "ai.models_catalog_endpoint",
    "inventoryIds": [
      4
    ],
    "type": "configuration",
    "domain": "ai",
    "name": "Models catalog endpoint",
    "description": "Використати для model picker та capabilities.",
    "useWhen": [
      "Internal system execution requires Models catalog endpoint"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.auto",
    "inventoryIds": [
      5
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "auto",
    "description": "Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.",
    "useWhen": [
      "Internal system execution requires auto"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.autosmart",
    "inventoryIds": [
      6
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "auto/smart",
    "description": "Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.",
    "useWhen": [
      "Internal system execution requires auto/smart"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "research.websearch_provider_routing",
    "inventoryIds": [
      7
    ],
    "type": "runtime",
    "domain": "research",
    "name": "Web/search provider routing",
    "description": "Твій web search залишити, але додати routing/quality policy.",
    "useWhen": [
      "User asks to execute or inspect Web/search provider routing"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "research:execute"
    ],
    "version": 1
  },
  {
    "id": "system.webchat",
    "inventoryIds": [
      8
    ],
    "type": "runtime",
    "domain": "system",
    "name": "WebChat",
    "description": "User-facing NPATI WebChat UI with persisted conversations and workspace-aware agent routing.",
    "useWhen": [
      "Internal system execution requires WebChat"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.35_model_providers",
    "inventoryIds": [
      9
    ],
    "type": "configuration",
    "domain": "ai",
    "name": "OmniRoute provider catalog",
    "description": "Dynamic OmniRoute provider catalog used by Settings and model routing; the count is discovered at runtime rather than hard-coded.",
    "useWhen": [
      "Internal system execution requires 35+ model providers"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "research.web_search",
    "inventoryIds": [
      10
    ],
    "type": "tool",
    "domain": "research",
    "name": "Web search",
    "description": "Твій search уже є; додати provider scoring/fallback/quality.",
    "useWhen": [
      "User asks to execute or inspect Web search"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "research:execute"
    ],
    "version": 1
  },
  {
    "id": "browser.web_fetch",
    "inventoryIds": [
      11
    ],
    "type": "tool",
    "domain": "browser",
    "name": "Web fetch",
    "description": "Тримати як швидкий шлях; Crawl4AI для складніших сторінок.",
    "useWhen": [
      "User asks to execute or inspect Web fetch"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [
      "crawler"
    ],
    "requiredPermissions": [
      "browser:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.webchat_channel",
    "inventoryIds": [
      12
    ],
    "type": "runtime",
    "domain": "communications",
    "name": "WebChat transport channel",
    "description": "Authenticated backend transport for WebChat messages, streaming progress, conversation persistence, and agent responses.",
    "useWhen": [
      "User asks to execute or inspect WebChat channel"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "system.dashboard",
    "inventoryIds": [
      13
    ],
    "type": "configuration",
    "domain": "system",
    "name": "Connected Services",
    "description": "Workspace operations and connected services with live service health, business summary, and links to runtime diagnostics.",
    "useWhen": [
      "Internal system execution requires Connected Services"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.ollama-compatible_api",
    "inventoryIds": [
      14
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Ollama-compatible API",
    "description": "Authenticated Ollama-compatible /api/tags, /api/generate, /api/chat and /api/version endpoints backed by OmniRoute.",
    "useWhen": [
      "Internal system execution requires Ollama-compatible API"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.text-to-speech",
    "inventoryIds": [
      15
    ],
    "type": "tool",
    "domain": "system",
    "name": "Text-to-Speech",
    "description": "Real text-to-speech through OmniRoute /api/v1/audio/speech with authenticated NPATI API and agent-tool adapters.",
    "useWhen": [
      "User asks to execute or inspect Text-to-Speech"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.speech-to-text",
    "inventoryIds": [
      16
    ],
    "type": "tool",
    "domain": "system",
    "name": "Speech-to-Text",
    "description": "Залишити; додати usage/cost control.",
    "useWhen": [
      "User asks to execute or inspect Speech-to-Text"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.local_redis",
    "inventoryIds": [
      17
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Local Redis",
    "description": "Може бути корисно для queues/cache при масштабуванні.",
    "useWhen": [
      "Internal system execution requires Local Redis"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "communications.text-to-speech",
    "inventoryIds": [
      18
    ],
    "type": "runtime",
    "domain": "communications",
    "name": "Text-to-Speech",
    "description": "Audit 2026-08-30: у NPATI реалізовано STT/voice transcription, але TTS endpoint ще не підключений. Не дублювати - інтегрувати OmniRoute TTS.",
    "useWhen": [
      "User asks to execute or inspect Text-to-Speech"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "ai.provider_circuit_breaker",
    "inventoryIds": [
      19
    ],
    "type": "runtime",
    "domain": "ai",
    "name": "Provider circuit breaker",
    "description": "NPATI використовує native OmniRoute provider circuit breaker; додано permission-protected read-only GET /ai/resilience, який повертає bounded runtime providerBreakers без дублювання breaker engine.",
    "useWhen": [
      "Internal system execution requires Provider circuit breaker"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.cooldown_lockout",
    "inventoryIds": [
      20
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Cooldown / lockout",
    "description": "NPATI використовує native OmniRoute connection cooldown і model lockouts; live configuration/runtime доступні через GET /ai/resilience. Власний cooldown engine не створювався.",
    "useWhen": [
      "Internal system execution requires Cooldown / lockout"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.retry_backoff",
    "inventoryIds": [
      21
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Retry / backoff",
    "description": "Company agent priority/pipeline combos передають OmniRoute maxRetries=2, retryDelayMs=500, failoverBeforeRetry=true і timeout; direct chat fallback виконується лише між user-selected primary/fallback через OmniRoute.",
    "useWhen": [
      "Internal system execution requires Retry / backoff"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.adaptive_admission_queue",
    "inventoryIds": [
      22
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Adaptive admission / queue",
    "description": "Production admission queue обмежує глобальну й per-tenant паралельність для реальних AI chat/generate/Company запитів, пріоритезує системні та платні рівні, скидає надлишкове навантаження через HTTP 429 і надає захищену runtime-телеметрію.",
    "useWhen": [
      "Internal system execution requires Adaptive admission / queue"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.self-healing_auto-combo",
    "inventoryIds": [
      23
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Self-healing Auto-Combo",
    "description": "Production AI engine автоматично переходить від недоступної основної моделі до налаштованого fallback лише для retryable 404/408/409/429/5xx, quota, timeout і network failures; auth 401/403 не приховуються. Failover відображається в routing/cost telemetry.",
    "useWhen": [
      "Internal system execution requires Self-healing Auto-Combo"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.live_quota_telemetry",
    "inventoryIds": [
      24
    ],
    "type": "runtime",
    "domain": "security",
    "name": "Live quota telemetry",
    "description": "Дуже важливо для публічного SaaS-агента.",
    "useWhen": [
      "Internal system execution requires Live quota telemetry"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.cost_telemetry_headers",
    "inventoryIds": [
      25
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Cost telemetry headers",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Cost telemetry headers"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.per-key_usd_spend_quotas",
    "inventoryIds": [
      26
    ],
    "type": "runtime",
    "domain": "security",
    "name": "Per-key USD spend quotas",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Per-key USD spend quotas"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "critical",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.usage_analytics",
    "inventoryIds": [
      27
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Usage analytics",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Usage analytics"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.quota_tracking",
    "inventoryIds": [
      28
    ],
    "type": "runtime",
    "domain": "security",
    "name": "Quota tracking",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Quota tracking"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.audit_trail",
    "inventoryIds": [
      29
    ],
    "type": "security_ops",
    "domain": "system",
    "name": "Audit trail",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Audit trail"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.health_diagnostics",
    "inventoryIds": [
      30
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Health / diagnostics",
    "description": "Agent API /health агрегує стан database, OmniRoute, crawler, MinIO та optional Hub; Docker healthchecks використовують реальні endpoints.",
    "useWhen": [
      "Internal system execution requires Health / diagnostics"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.prompt-injection_guard",
    "inventoryIds": [
      31
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Prompt-injection guard",
    "description": "Центральний policy engine блокує instruction override у user input, Company fields, retrieved documents/memory та tool evidence до model call.",
    "useWhen": [
      "Internal system execution requires Prompt-injection guard"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.pii_masker",
    "inventoryIds": [
      32
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "PII masker",
    "description": "Email, phone, payment card, IBAN і tax identifiers маскуються перед JSON/SSE model calls, tool execution та audit summaries.",
    "useWhen": [
      "Internal system execution requires PII masker"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.credential_masking",
    "inventoryIds": [
      33
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Credential masking",
    "description": "API keys, JWT, GitHub/AWS tokens, passwords і connection strings маскуються перед model/tool calls, Run Trace та Fastify logs.",
    "useWhen": [
      "Internal system execution requires Credential masking"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.custom_guardrails",
    "inventoryIds": [
      34
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Custom guardrails",
    "description": "Versioned Company policy у PostgreSQL керує injection block, PII/credential redaction, blocked terms і input limit з optimistic revision.",
    "useWhen": [
      "Internal system execution requires Custom guardrails"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.api_key_auth",
    "inventoryIds": [
      35
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "API key auth",
    "description": "Production MCP виклики вимагають явного API-key scope mcp:read; відсутній scope, відкликаний ключ і cross-tenant контекст блокуються до звернення до OmniRoute.",
    "useWhen": [
      "Internal system execution requires API key auth"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "critical",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.oauth_20_pkce",
    "inventoryIds": [
      36
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "OAuth 2.0 + PKCE",
    "description": "Критично перед email/browser/code автоматизацією.",
    "useWhen": [
      "Internal system execution requires OAuth 2.0 + PKCE"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.automatic_token_refresh",
    "inventoryIds": [
      37
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Automatic token refresh",
    "description": "Критично перед email/browser/code автоматизацією.",
    "useWhen": [
      "Internal system execution requires Automatic token refresh"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "critical",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.aes-256-gcm_at_rest",
    "inventoryIds": [
      38
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "AES-256-GCM at rest",
    "description": "AES-256-GCM with unique salt and IV plus authenticated tag; production requires an explicit 32+ character key and encrypted API-key secrets support rotation.",
    "useWhen": [
      "Internal system execution requires AES-256-GCM at rest"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.route_guard_tiers",
    "inventoryIds": [
      39
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Route guard tiers",
    "description": "Критично перед email/browser/code автоматизацією.",
    "useWhen": [
      "Internal system execution requires Route guard tiers"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.mcp_authorization_scopes",
    "inventoryIds": [
      40
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "MCP authorization scopes",
    "description": "Критично перед email/browser/code автоматизацією.",
    "useWhen": [
      "Internal system execution requires MCP authorization scopes"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.gateway",
    "inventoryIds": [
      41
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Gateway",
    "description": "NPATI Agent API є власним tenant-aware gateway для Chat, Business, Company, Models, Files та runtime routes поверх OmniRoute.",
    "useWhen": [
      "Internal system execution requires Gateway"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.streaming_responses",
    "inventoryIds": [
      42
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Streaming responses",
    "description": "Chat читає upstream OmniRoute SSE, передає впорядковані дельти у WebChat і скасовує provider request після Stop або від'єднання клієнта.",
    "useWhen": [
      "Internal system execution requires Streaming responses"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.main_session",
    "inventoryIds": [
      43
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Main session",
    "description": "NPATI має persisted chats/conversations та окремі Company runs; критичний Company run state зберігається у PostgreSQL, dispatch - Redis.",
    "useWhen": [
      "Internal system execution requires Main session"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.isolated_group_sessions",
    "inventoryIds": [
      44
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Isolated group sessions",
    "description": "Для multi-user потрібно ще жорсткіше tenant isolation.",
    "useWhen": [
      "Internal system execution requires Isolated group sessions"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.multi-user_mode",
    "inventoryIds": [
      45
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Multi-user mode",
    "description": "Критично для публічного SaaS.",
    "useWhen": [
      "Internal system execution requires Multi-user mode"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.session_tools",
    "inventoryIds": [
      46
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Session tools",
    "description": "Потрібно Manager Agent для coordination.",
    "useWhen": [
      "Internal system execution requires Session tools"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.sandboxing",
    "inventoryIds": [
      47
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Sandboxing",
    "description": "Company Agent runtime і Company MCP API працюють deny-by-default: дозволяються лише tools із agent allowlist та безпечного runtime allowlist; невідомі й адміністративні MCP tools блокуються та не виконуються.",
    "useWhen": [
      "Internal system execution requires Sandboxing"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.tool_allowdeny_policy",
    "inventoryIds": [
      48
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Tool allow/deny policy",
    "description": "Особливо важливо перед coding/browser/email automation.",
    "useWhen": [
      "Internal system execution requires Tool allow/deny policy"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.exec_approvals",
    "inventoryIds": [
      49
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Exec approvals",
    "description": "Особливо важливо перед coding/browser/email automation.",
    "useWhen": [
      "Internal system execution requires Exec approvals"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "communications.dm_allowlists_pairing",
    "inventoryIds": [
      50
    ],
    "type": "configuration",
    "domain": "communications",
    "name": "DM allowlists & pairing",
    "description": "Використати аналогічний access control для external channels.",
    "useWhen": [
      "User asks to execute or inspect DM allowlists & pairing"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; user/admin configuration only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "security.per-agent_tool_policy",
    "inventoryIds": [
      51
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Per-agent tool policy",
    "description": "Це обов’язкова основа перед автономними діями.",
    "useWhen": [
      "Internal system execution requires Per-agent tool policy"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.per-subagent_tool_policy",
    "inventoryIds": [
      52
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Per-subagent tool policy",
    "description": "Це обов’язкова основа перед автономними діями.",
    "useWhen": [
      "Internal system execution requires Per-subagent tool policy"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.sandbox_host_separation",
    "inventoryIds": [
      53
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Sandbox + host separation",
    "description": "Це обов’язкова основа перед автономними діями.",
    "useWhen": [
      "Internal system execution requires Sandbox + host separation"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.human_approvals",
    "inventoryIds": [
      54
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Human approvals",
    "description": "Це обов’язкова основа перед автономними діями.",
    "useWhen": [
      "Internal system execution requires Human approvals"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "communications.channel_sender_authorization",
    "inventoryIds": [
      55
    ],
    "type": "security_ops",
    "domain": "communications",
    "name": "Channel sender authorization",
    "description": "Це обов’язкова основа перед автономними діями.",
    "useWhen": [
      "Internal system execution requires Channel sender authorization"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "browser.background_task_auditability",
    "inventoryIds": [
      56
    ],
    "type": "security_ops",
    "domain": "browser",
    "name": "Background task auditability",
    "description": "Це обов’язкова основа перед автономними діями.",
    "useWhen": [
      "Internal system execution requires Background task auditability"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "ai.moderations",
    "inventoryIds": [
      57
    ],
    "type": "runtime",
    "domain": "ai",
    "name": "Moderations",
    "description": "Production moderation через OmniRoute /api/v1/moderations із реальними категоріями та оцінками; API працює fail-closed без provider endpoint.",
    "useWhen": [
      "Internal system execution requires Moderations"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.image_generation",
    "inventoryIds": [
      58
    ],
    "type": "tool",
    "domain": "system",
    "name": "Image generation",
    "description": "Якщо вже є image generation у твоєму агенті - route через OmniRoute.",
    "useWhen": [
      "User asks to execute or inspect Image generation"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "image_provider"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.ocr",
    "inventoryIds": [
      59
    ],
    "type": "tool",
    "domain": "system",
    "name": "OCR",
    "description": "Добре доповнить твоє завантаження фото/файлів.",
    "useWhen": [
      "User asks to execute or inspect OCR"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "security.vision_bridge_guardrail",
    "inventoryIds": [
      60
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Vision bridge guardrail",
    "description": "Очищає EXIF та текстові metadata з JPEG/PNG і блокує prompt injection у переданому або розпізнаному OCR-тексті. Автоматичний production OCR/vision analysis ще частковий.",
    "useWhen": [
      "Internal system execution requires Vision bridge guardrail"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.oidc_dashboard_gate",
    "inventoryIds": [
      61
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "OIDC dashboard gate",
    "description": "Критично перед email/browser/code автоматизацією.",
    "useWhen": [
      "Internal system execution requires OIDC dashboard gate"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.scoped_remote_access_tokens",
    "inventoryIds": [
      62
    ],
    "type": "runtime",
    "domain": "security",
    "name": "Scoped remote access tokens",
    "description": "Short-lived HMAC-signed service tokens bound to tenant, company, scopes and optional IP allowlist; TTL and delegated scopes are enforced fail-closed.",
    "useWhen": [
      "Internal system execution requires Scoped remote access tokens"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "critical",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.auto_reviewer_for_exec",
    "inventoryIds": [
      63
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Auto reviewer for exec",
    "description": "Це обов’язкова основа перед автономними діями.",
    "useWhen": [
      "Internal system execution requires Auto reviewer for exec"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.embeddings",
    "inventoryIds": [
      64
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Embeddings",
    "description": "Справжні OmniRoute embeddings для Company Knowledge і pgvector; production API валідовує та нормалізує вектори й не використовує synthetic fallback.",
    "useWhen": [
      "Internal system execution requires Embeddings"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "ai.rerank",
    "inventoryIds": [
      65
    ],
    "type": "runtime",
    "domain": "ai",
    "name": "Rerank",
    "description": "Calls the configured production OmniRoute rerank model and fails closed with RERANK_UNAVAILABLE when no real reranker is active.",
    "useWhen": [
      "Internal system execution requires Rerank"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.persistent_conversational_memory",
    "inventoryIds": [
      66
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Persistent conversational memory",
    "description": "Business Memory і Company Memory persistent у PostgreSQL. Але generic conversational NpatiAgent досі створює InMemoryProvider у API process, тому повна persistent conversational memory не завершена.",
    "useWhen": [
      "Internal system execution requires Persistent conversational memory"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.memory_scoped_by_api_key",
    "inventoryIds": [
      67
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Memory scoped by API key",
    "description": "PostgreSQL-backed Company Memory ізолюється за tenant, company та точним API key; key scopes deny-by-default, cross-key читання і видалення блокуються.",
    "useWhen": [
      "Internal system execution requires Memory scoped by API key"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "critical",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.optional_sessionid_scoping",
    "inventoryIds": [
      68
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Optional sessionId scoping",
    "description": "Опційний sessionId звужує пам'ять усередині API key scope; однаковий sessionId різних ключів не перетинає межу, а стан переживає restart.",
    "useWhen": [
      "Internal system execution requires Optional sessionId scoping"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.memory_injection",
    "inventoryIds": [
      69
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Memory injection",
    "description": "JSON, SSE та Company API chat інжектують лише релевантну дозволену пам'ять у model call; no-memory повністю обходить retrieval та injection.",
    "useWhen": [
      "Internal system execution requires Memory injection"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "research.vector_semantic_search",
    "inventoryIds": [
      70
    ],
    "type": "runtime",
    "domain": "research",
    "name": "Vector semantic search",
    "description": "Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.",
    "useWhen": [
      "Internal system execution requires Vector semantic search"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.hybrid_memory_retrieval",
    "inventoryIds": [
      71
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Hybrid memory retrieval",
    "description": "Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.",
    "useWhen": [
      "Internal system execution requires Hybrid memory retrieval"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.context_compaction",
    "inventoryIds": [
      72
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Context compaction",
    "description": "Compacts long production chat histories with the selected AI model, preserves recent turns, and keeps the full history if summarization fails.",
    "useWhen": [
      "Internal system execution requires Context compaction"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.usermd_user_model",
    "inventoryIds": [
      73
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "USER.md user model",
    "description": "Revisioned USER.md profiles persist in PostgreSQL user settings, are isolated by workspace/user, survive restart, respect noMemory, and are injected as authorized data into neutral, Business, and Company chat.",
    "useWhen": [
      "Internal system execution requires USER.md user model"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.memorymd_long-term_memory",
    "inventoryIds": [
      74
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "MEMORY.md long-term memory",
    "description": "Revisioned MEMORY.md documents persist inside the existing PostgreSQL Company memory record, enforce tenant/company authorization, survive restart, respect noMemory, and ground Company Agent execution.",
    "useWhen": [
      "Internal system execution requires MEMORY.md long-term memory"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "research.semantic_memory_search",
    "inventoryIds": [
      75
    ],
    "type": "runtime",
    "domain": "research",
    "name": "Semantic memory search",
    "description": "Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.",
    "useWhen": [
      "Internal system execution requires Semantic memory search"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "research.hybrid_keyword_vector_search",
    "inventoryIds": [
      76
    ],
    "type": "runtime",
    "domain": "research",
    "name": "Hybrid keyword + vector search",
    "description": "Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.",
    "useWhen": [
      "Internal system execution requires Hybrid keyword + vector search"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "critical",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.automatic_memory_flush",
    "inventoryIds": [
      77
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Automatic memory flush",
    "description": "At a successful production business-chat compaction boundary, extracts only explicit user facts from discarded turns and durably stores them in tenant-scoped PostgreSQL Business Memory with duplicate protection; noMemory disables writes.",
    "useWhen": [
      "Internal system execution requires Automatic memory flush"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.automatic_memory_extraction",
    "inventoryIds": [
      78
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Automatic memory extraction",
    "description": "Extracts explicit user-authored company facts after successful JSON/SSE runs and durably persists provenance metadata while honoring noMemory.",
    "useWhen": [
      "Internal system execution requires Automatic memory extraction"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "research.fts5_keyword_search",
    "inventoryIds": [
      79
    ],
    "type": "runtime",
    "domain": "research",
    "name": "FTS5 keyword search",
    "description": "Real SQLite FTS5/BM25 keyword backend with WAL persistence, Unicode tokenization, tenant/company/user filters, restart persistence, and document deletion cleanup; integrated into Company Knowledge retrieval.",
    "useWhen": [
      "Internal system execution requires FTS5 keyword search"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "critical",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.memory_rerank",
    "inventoryIds": [
      80
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Memory rerank",
    "description": "Побудувати поверх цього User Memory + Company/Brand Brain з tenant isolation.",
    "useWhen": [
      "Internal system execution requires Memory rerank"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.typed_decay",
    "inventoryIds": [
      81
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Typed decay",
    "description": "Persists an explicit memory type and base weight and applies type-specific half-life decay during production Company Memory retrieval; immutable facts do not decay.",
    "useWhen": [
      "Internal system execution requires Typed decay"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.per-request_no-memory",
    "inventoryIds": [
      82
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Per-request no-memory",
    "description": "Production /chat and /chat/stream support a user-facing Private request plus noMemory/ephemeral payload flags and x-npati-no-memory header. Business Memory, conversation history, message/file persistence and research-job persistence are bypassed. Company runs remove Knowledge/Memory from prompts and deny memory/files tools with audited reasonCode no_memory.",
    "useWhen": [
      "Internal system execution requires Per-request no-memory"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.daily_memory_notes",
    "inventoryIds": [
      83
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Daily memory notes",
    "description": "Durable tenant- and company-scoped PostgreSQL daily notes with date grouping, required idempotency keys, authenticated read/write routes, and restart persistence.",
    "useWhen": [
      "Internal system execution requires Daily memory notes"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.memory_get",
    "inventoryIds": [
      84
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Memory get",
    "description": "Взяти ідею шарів пам’яті; реалізувати tenant + brand scopes.",
    "useWhen": [
      "Internal system execution requires Memory get"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.standing_intents",
    "inventoryIds": [
      85
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Standing intents",
    "description": "Durable tenant- and company-scoped PostgreSQL standing intents with keyword matching, lifecycle states, idempotent create, optimistic revision updates, and restart persistence.",
    "useWhen": [
      "Internal system execution requires Standing intents"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.memory_wiki",
    "inventoryIds": [
      86
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Memory Wiki",
    "description": "Durable PostgreSQL Company Memory Wiki with normalized hierarchical paths, tags, wikilink backlinks, optimistic revisions, tenant isolation, lifecycle APIs, restart persistence, and authorized agent retrieval.",
    "useWhen": [
      "Internal system execution requires Memory Wiki"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.dreaming",
    "inventoryIds": [
      87
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Dreaming",
    "description": "Runs an idempotent durable consolidation cycle over real Company Memories, applies typed decay and exact deduplication, records the cycle in PostgreSQL, and writes a consolidated Memory Wiki page.",
    "useWhen": [
      "Internal system execution requires Dreaming"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.action-sensitive_memory",
    "inventoryIds": [
      88
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Action-sensitive memory",
    "description": "Durable company-scoped action rules with idempotent CRUD, revisions and risk metadata; matching rules are injected before delegation planning and retrieved again using planned tool names.",
    "useWhen": [
      "Internal system execution requires Action-sensitive memory"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.format_translation",
    "inventoryIds": [
      89
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Format translation",
    "description": "Використовувати як універсальний adapter layer.",
    "useWhen": [
      "Internal system execution requires Format translation"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.autocoding",
    "inventoryIds": [
      90
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "auto/coding",
    "description": "Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.",
    "useWhen": [
      "Internal system execution requires auto/coding"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.autofast",
    "inventoryIds": [
      91
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "auto/fast",
    "description": "Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.",
    "useWhen": [
      "Internal system execution requires auto/fast"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.autocheap",
    "inventoryIds": [
      92
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "auto/cheap",
    "description": "Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.",
    "useWhen": [
      "Internal system execution requires auto/cheap"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.autooffline",
    "inventoryIds": [
      93
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "auto/offline",
    "description": "Зробити автоматичний model router замість ручного вибору моделі для кожної задачі.",
    "useWhen": [
      "Internal system execution requires auto/offline"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.cost-optimized",
    "inventoryIds": [
      94
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "cost-optimized",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires cost-optimized"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.context-optimized",
    "inventoryIds": [
      95
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "context-optimized",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires context-optimized"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.cache-optimized",
    "inventoryIds": [
      96
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "cache-optimized",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires cache-optimized"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.lkgp",
    "inventoryIds": [
      97
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "lkgp",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires lkgp"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.auto_98",
    "inventoryIds": [
      98
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "auto",
    "description": "Особливо корисно для NPATI.",
    "useWhen": [
      "Internal system execution requires auto"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.fusion",
    "inventoryIds": [
      99
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "fusion",
    "description": "Особливо корисно для NPATI.",
    "useWhen": [
      "Internal system execution requires fusion"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.pipeline",
    "inventoryIds": [
      100
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "pipeline",
    "description": "Особливо корисно для NPATI.",
    "useWhen": [
      "Internal system execution requires pipeline"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.mcp_server",
    "inventoryIds": [
      101
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "MCP server",
    "description": "Використати як універсальну tool-шину агента.",
    "useWhen": [
      "Internal system execution requires MCP server"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.mcp_scoped_permissions",
    "inventoryIds": [
      102
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "MCP scoped permissions",
    "description": "MCP permissions застосовуються в реальному multi-tenant Company API: scoped API key, Company ownership, read-only MCP action classification, revocation та safe-tool allowlist.",
    "useWhen": [
      "Internal system execution requires MCP scoped permissions"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.a2a_protocol_v03",
    "inventoryIds": [
      103
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "A2A protocol v0.3",
    "description": "Основа Manager → specialist agents.",
    "useWhen": [
      "Internal system execution requires A2A protocol v0.3"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.a2a_smart_routing",
    "inventoryIds": [
      104
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "A2A: Smart Routing",
    "description": "Використовувати всередині Manager/worker orchestration.",
    "useWhen": [
      "Internal system execution requires A2A: Smart Routing"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.a2a_health_report",
    "inventoryIds": [
      105
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "A2A: Health Report",
    "description": "Використовувати всередині Manager/worker orchestration.",
    "useWhen": [
      "Internal system execution requires A2A: Health Report"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.omniconductor",
    "inventoryIds": [
      106
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "OmniConductor",
    "description": "Найближчий OmniRoute-компонент до orchestrator/manager архітектури.",
    "useWhen": [
      "Internal system execution requires OmniConductor"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.skills_framework",
    "inventoryIds": [
      107
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "Skills framework",
    "description": "Створити NPATI skills: Research, SEO, Support, Content, WordPress, Social.",
    "useWhen": [
      "Internal system execution requires Skills framework"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.per-agent_model_choice",
    "inventoryIds": [
      108
    ],
    "type": "configuration",
    "domain": "security",
    "name": "Per-agent model choice",
    "description": "Manager сильна модель; workers дешевші/спеціалізовані.",
    "useWhen": [
      "Internal system execution requires Per-agent model choice"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.multi-agent_routing",
    "inventoryIds": [
      109
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "Multi-agent routing",
    "description": "Одна з головних наступних функцій.",
    "useWhen": [
      "Internal system execution requires Multi-agent routing"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.sub-agents",
    "inventoryIds": [
      110
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "Sub-agents",
    "description": "Manager → Research/Writer/SEO/Reviewer/Support.",
    "useWhen": [
      "Internal system execution requires Sub-agents"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.parallel_sub-agents",
    "inventoryIds": [
      111
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "Parallel sub-agents",
    "description": "Паралельний research/verification прискорить deep tasks.",
    "useWhen": [
      "Internal system execution requires Parallel sub-agents"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.isolated_vs_forked_context",
    "inventoryIds": [
      112
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "Isolated vs forked context",
    "description": "Обов’язково для безпечної та дешевої delegation.",
    "useWhen": [
      "Internal system execution requires Isolated vs forked context"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.agent_send_session_messaging",
    "inventoryIds": [
      113
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "Agent send / session messaging",
    "description": "Аналог можна реалізувати через OmniRoute A2A.",
    "useWhen": [
      "Internal system execution requires Agent send / session messaging"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.background_completion_reporting",
    "inventoryIds": [
      114
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "Background completion reporting",
    "description": "Потрібно для гарного UX manager-agent.",
    "useWhen": [
      "Internal system execution requires Background completion reporting"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.skills",
    "inventoryIds": [
      115
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Skills",
    "description": "Створити бізнес skills поверх OmniRoute + твоїх tools.",
    "useWhen": [
      "Internal system execution requires Skills"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.mcp_server_116",
    "inventoryIds": [
      116
    ],
    "type": "runtime",
    "domain": "system",
    "name": "MCP server",
    "description": "У тебе OmniRoute/NPATI MCP може виконувати цю роль.",
    "useWhen": [
      "Internal system execution requires MCP server"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.mcp_client_registry",
    "inventoryIds": [
      117
    ],
    "type": "runtime",
    "domain": "system",
    "name": "MCP client registry",
    "description": "Дозволить підключати сторонні MCP tools користувачів.",
    "useWhen": [
      "Internal system execution requires MCP client registry"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.anthropic_messages_api",
    "inventoryIds": [
      118
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Anthropic Messages API",
    "description": "Корисно для Claude Code та Anthropic-екосистеми.",
    "useWhen": [
      "Internal system execution requires Anthropic Messages API"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.gemini-compatible_api",
    "inventoryIds": [
      119
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Gemini-compatible API",
    "description": "Корисно, якщо агент має напряму підтримувати Gemini-клієнтів.",
    "useWhen": [
      "Internal system execution requires Gemini-compatible API"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.a2a_quota_management",
    "inventoryIds": [
      120
    ],
    "type": "orchestration",
    "domain": "security",
    "name": "A2A: Quota Management",
    "description": "Використовувати всередині Manager/worker orchestration.",
    "useWhen": [
      "Internal system execution requires A2A: Quota Management"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.a2a_provider_discovery",
    "inventoryIds": [
      121
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "A2A: Provider Discovery",
    "description": "Використовувати всередині Manager/worker orchestration.",
    "useWhen": [
      "Internal system execution requires A2A: Provider Discovery"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.a2a_cost_analysis",
    "inventoryIds": [
      122
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "A2A: Cost Analysis",
    "description": "Використовувати всередині Manager/worker orchestration.",
    "useWhen": [
      "Internal system execution requires A2A: Cost Analysis"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.a2a_list_capabilities",
    "inventoryIds": [
      123
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "A2A: List Capabilities",
    "description": "Використовувати всередині Manager/worker orchestration.",
    "useWhen": [
      "Internal system execution requires A2A: List Capabilities"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.evaluation_framework",
    "inventoryIds": [
      124
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Evaluation framework",
    "description": "Створити автоматичні evals для Research/SEO/Support/Writer.",
    "useWhen": [
      "Internal system execution requires Evaluation framework"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.nested_sub-agents",
    "inventoryIds": [
      125
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "Nested sub-agents",
    "description": "Додавати після стабільної 1-level orchestration.",
    "useWhen": [
      "Internal system execution requires Nested sub-agents"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "business.goal_management",
    "inventoryIds": [
      126
    ],
    "type": "orchestration",
    "domain": "business",
    "name": "Goal management",
    "description": "Корисно для довгих бізнес-задач і project workflows.",
    "useWhen": [
      "Internal system execution requires Goal management"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.swarm",
    "inventoryIds": [
      127
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "Swarm",
    "description": "Не потрібно на старті; A2A + pipeline достатньо.",
    "useWhen": [
      "Internal system execution requires Swarm"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.webhooks",
    "inventoryIds": [
      128
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Webhooks",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Webhooks"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.automations_scheduler",
    "inventoryIds": [
      129
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Automations scheduler",
    "description": "Це ключ до переходу від чату до автономного business agent.",
    "useWhen": [
      "User asks to execute or inspect Automations scheduler"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.cron_jobs",
    "inventoryIds": [
      130
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Cron jobs",
    "description": "Це ключ до переходу від чату до автономного business agent.",
    "useWhen": [
      "User asks to execute or inspect Cron jobs"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.background_tasks_ledger",
    "inventoryIds": [
      131
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Background Tasks ledger",
    "description": "Це ключ до переходу від чату до автономного business agent.",
    "useWhen": [
      "User asks to execute or inspect Background Tasks ledger"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.task_audit",
    "inventoryIds": [
      132
    ],
    "type": "security_ops",
    "domain": "system",
    "name": "Task audit",
    "description": "Це ключ до переходу від чату до автономного business agent.",
    "useWhen": [
      "Internal system execution requires Task audit"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.task_flow",
    "inventoryIds": [
      133
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "Task Flow",
    "description": "Це ключ до переходу від чату до автономного business agent.",
    "useWhen": [
      "User asks to execute or inspect Task Flow"
    ],
    "doNotUseWhen": [
      "Internal orchestration only; handled by flow router, not directly callable tool"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.standing_orders",
    "inventoryIds": [
      134
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Standing Orders",
    "description": "Це ключ до переходу від чату до автономного business agent.",
    "useWhen": [
      "User asks to execute or inspect Standing Orders"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.webhooks_ingress",
    "inventoryIds": [
      135
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Webhooks ingress",
    "description": "Це ключ до переходу від чату до автономного business agent.",
    "useWhen": [
      "User asks to execute or inspect Webhooks ingress"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.imap_email_trigger",
    "inventoryIds": [
      136
    ],
    "type": "tool",
    "domain": "communications",
    "name": "IMAP email trigger",
    "description": "Це ключ до переходу від чату до автономного business agent.",
    "useWhen": [
      "User asks to execute or inspect IMAP email trigger"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [
      "imap"
    ],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "system.webhook_retries",
    "inventoryIds": [
      137
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Webhook retries",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Webhook retries"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.one-shot_reminders",
    "inventoryIds": [
      138
    ],
    "type": "tool",
    "domain": "system",
    "name": "One-shot reminders",
    "description": "Це ключ до переходу від чату до автономного business agent.",
    "useWhen": [
      "User asks to execute or inspect One-shot reminders"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.heartbeat",
    "inventoryIds": [
      139
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Heartbeat",
    "description": "Це ключ до переходу від чату до автономного business agent.",
    "useWhen": [
      "User asks to execute or inspect Heartbeat"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.lifecycle_hooks",
    "inventoryIds": [
      140
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Lifecycle hooks",
    "description": "Це ключ до переходу від чату до автономного business agent.",
    "useWhen": [
      "User asks to execute or inspect Lifecycle hooks"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.image_understanding",
    "inventoryIds": [
      141
    ],
    "type": "tool",
    "domain": "communications",
    "name": "Image understanding",
    "description": "Базовий голос/файли вже є; не відволікатися від orchestration та automation.",
    "useWhen": [
      "User asks to execute or inspect Image understanding"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "files.document_inputoutput",
    "inventoryIds": [
      142
    ],
    "type": "tool",
    "domain": "files",
    "name": "Document input/output",
    "description": "Базовий голос/файли вже є; не відволікатися від orchestration та automation.",
    "useWhen": [
      "User asks to execute or inspect Document input/output"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "files:execute"
    ],
    "version": 1
  },
  {
    "id": "system.modality_bridge",
    "inventoryIds": [
      143
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Modality bridge",
    "description": "Корисно для єдиного multimodal UX.",
    "useWhen": [
      "User asks to execute or inspect Modality bridge"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.audio_understanding",
    "inventoryIds": [
      144
    ],
    "type": "tool",
    "domain": "communications",
    "name": "Audio understanding",
    "description": "Базовий голос/файли вже є; не відволікатися від orchestration та automation.",
    "useWhen": [
      "User asks to execute or inspect Audio understanding"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.image_generationediting",
    "inventoryIds": [
      145
    ],
    "type": "tool",
    "domain": "communications",
    "name": "Image generation/editing",
    "description": "Базовий голос/файли вже є; не відволікатися від orchestration та automation.",
    "useWhen": [
      "User asks to execute or inspect Image generation/editing"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [
      "image_provider"
    ],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.voice-note_transcription",
    "inventoryIds": [
      146
    ],
    "type": "runtime",
    "domain": "communications",
    "name": "Voice-note transcription",
    "description": "Базовий голос/файли вже є; не відволікатися від orchestration та automation.",
    "useWhen": [
      "User asks to execute or inspect Voice-note transcription"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.audio_translation",
    "inventoryIds": [
      147
    ],
    "type": "tool",
    "domain": "communications",
    "name": "Audio translation",
    "description": "Корисно для міжнародної підтримки, але не перший пріоритет.",
    "useWhen": [
      "User asks to execute or inspect Audio translation"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.video_understanding",
    "inventoryIds": [
      148
    ],
    "type": "tool",
    "domain": "communications",
    "name": "Video understanding",
    "description": "Базовий голос/файли вже є; не відволікатися від orchestration та automation.",
    "useWhen": [
      "User asks to execute or inspect Video understanding"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "browser.managed_browser_profile",
    "inventoryIds": [
      149
    ],
    "type": "runtime",
    "domain": "browser",
    "name": "Managed browser profile",
    "description": "Твій запланований Browser Use має бути sandboxed.",
    "useWhen": [
      "User asks to execute or inspect Managed browser profile"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "browser:execute"
    ],
    "version": 1
  },
  {
    "id": "browser.browser_tab_control",
    "inventoryIds": [
      150
    ],
    "type": "tool",
    "domain": "browser",
    "name": "Browser tab control",
    "description": "Робити після tool permissions/approvals.",
    "useWhen": [
      "User asks to execute or inspect Browser tab control"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "browser:execute"
    ],
    "version": 1
  },
  {
    "id": "browser.browser_clicktype",
    "inventoryIds": [
      151
    ],
    "type": "tool",
    "domain": "browser",
    "name": "Browser click/type",
    "description": "Робити після tool permissions/approvals.",
    "useWhen": [
      "User asks to execute or inspect Browser click/type"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [
      "browser:execute"
    ],
    "version": 1
  },
  {
    "id": "browser.browser_dragselect",
    "inventoryIds": [
      152
    ],
    "type": "runtime",
    "domain": "browser",
    "name": "Browser drag/select",
    "description": "Робити після tool permissions/approvals.",
    "useWhen": [
      "User asks to execute or inspect Browser drag/select"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "browser:execute"
    ],
    "version": 1
  },
  {
    "id": "browser.browser_snapshots",
    "inventoryIds": [
      153
    ],
    "type": "runtime",
    "domain": "browser",
    "name": "Browser snapshots",
    "description": "Робити після tool permissions/approvals.",
    "useWhen": [
      "User asks to execute or inspect Browser snapshots"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "browser:execute"
    ],
    "version": 1
  },
  {
    "id": "browser.browser_screenshots",
    "inventoryIds": [
      154
    ],
    "type": "tool",
    "domain": "browser",
    "name": "Browser screenshots",
    "description": "Робити після tool permissions/approvals.",
    "useWhen": [
      "User asks to execute or inspect Browser screenshots"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "browser:execute"
    ],
    "version": 1
  },
  {
    "id": "browser.browser_pdf_capture",
    "inventoryIds": [
      155
    ],
    "type": "tool",
    "domain": "browser",
    "name": "Browser PDF capture",
    "description": "Робити після tool permissions/approvals.",
    "useWhen": [
      "User asks to execute or inspect Browser PDF capture"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "browser:execute"
    ],
    "version": 1
  },
  {
    "id": "browser.browser_downloads",
    "inventoryIds": [
      156
    ],
    "type": "tool",
    "domain": "browser",
    "name": "Browser downloads",
    "description": "Робити після tool permissions/approvals.",
    "useWhen": [
      "User asks to execute or inspect Browser downloads"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "browser:execute"
    ],
    "version": 1
  },
  {
    "id": "browser.multi-profile_browser",
    "inventoryIds": [
      157
    ],
    "type": "runtime",
    "domain": "browser",
    "name": "Multi-profile browser",
    "description": "Робити після tool permissions/approvals.",
    "useWhen": [
      "User asks to execute or inspect Multi-profile browser"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "browser:execute"
    ],
    "version": 1
  },
  {
    "id": "browser.attach_real_chrome",
    "inventoryIds": [
      158
    ],
    "type": "runtime",
    "domain": "browser",
    "name": "Attach real Chrome",
    "description": "Робити після tool permissions/approvals.",
    "useWhen": [
      "User asks to execute or inspect Attach real Chrome"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "browser:execute"
    ],
    "version": 1
  },
  {
    "id": "security.exec",
    "inventoryIds": [
      159
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Exec",
    "description": "Особливо важливо перед coding/browser/email automation.",
    "useWhen": [
      "Internal system execution requires Exec"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.process_control",
    "inventoryIds": [
      160
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Process control",
    "description": "Особливо важливо перед coding/browser/email automation.",
    "useWhen": [
      "Internal system execution requires Process control"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "research.tool_search",
    "inventoryIds": [
      161
    ],
    "type": "security_ops",
    "domain": "research",
    "name": "Tool Search",
    "description": "Особливо важливо перед coding/browser/email automation.",
    "useWhen": [
      "Internal system execution requires Tool Search"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "files.file_tools",
    "inventoryIds": [
      162
    ],
    "type": "security_ops",
    "domain": "files",
    "name": "File tools",
    "description": "Особливо важливо перед coding/browser/email automation.",
    "useWhen": [
      "Internal system execution requires File tools"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.coding_cli_gateway",
    "inventoryIds": [
      163
    ],
    "type": "tool",
    "domain": "system",
    "name": "Coding CLI gateway",
    "description": "Не будувати власну coding model; route готові coding clients/agents.",
    "useWhen": [
      "User asks to execute or inspect Coding CLI gateway"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "ai.omniroute_run",
    "inventoryIds": [
      164
    ],
    "type": "orchestration",
    "domain": "ai",
    "name": "omniroute run",
    "description": "Може стати backend для NPATI Code.",
    "useWhen": [
      "User asks to execute or inspect omniroute run"
    ],
    "doNotUseWhen": [
      "Internal orchestration only; handled by flow router, not directly callable tool"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "ai:execute"
    ],
    "version": 1
  },
  {
    "id": "ai.cloud-agent_providers",
    "inventoryIds": [
      165
    ],
    "type": "runtime",
    "domain": "ai",
    "name": "Cloud-agent providers",
    "description": "Підключати після multi-agent та sandbox.",
    "useWhen": [
      "User asks to execute or inspect Cloud-agent providers"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "ai:execute"
    ],
    "version": 1
  },
  {
    "id": "security.oauth_subscription_auth",
    "inventoryIds": [
      166
    ],
    "type": "configuration",
    "domain": "security",
    "name": "OAuth subscription auth",
    "description": "Корисно для coding integrations.",
    "useWhen": [
      "Internal system execution requires OAuth subscription auth"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.native_codex_runtime",
    "inventoryIds": [
      167
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Native Codex runtime",
    "description": "Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.",
    "useWhen": [
      "User asks to execute or inspect Native Codex runtime"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.acp_sessions",
    "inventoryIds": [
      168
    ],
    "type": "runtime",
    "domain": "system",
    "name": "ACP sessions",
    "description": "Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.",
    "useWhen": [
      "User asks to execute or inspect ACP sessions"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.claude_code_via_acp",
    "inventoryIds": [
      169
    ],
    "type": "tool",
    "domain": "system",
    "name": "Claude Code via ACP",
    "description": "Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.",
    "useWhen": [
      "User asks to execute or inspect Claude Code via ACP"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "claude_code"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "ai.omniroute_configure",
    "inventoryIds": [
      170
    ],
    "type": "configuration",
    "domain": "ai",
    "name": "omniroute configure",
    "description": "Адмінська/локальна функція.",
    "useWhen": [
      "User asks to execute or inspect omniroute configure"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; user/admin configuration only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "ai:execute"
    ],
    "version": 1
  },
  {
    "id": "system.cursor_via_acp",
    "inventoryIds": [
      171
    ],
    "type": "tool",
    "domain": "system",
    "name": "Cursor via ACP",
    "description": "Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.",
    "useWhen": [
      "User asks to execute or inspect Cursor via ACP"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "cursor"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.github_copilot_via_acp",
    "inventoryIds": [
      172
    ],
    "type": "tool",
    "domain": "system",
    "name": "GitHub Copilot via ACP",
    "description": "Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.",
    "useWhen": [
      "User asks to execute or inspect GitHub Copilot via ACP"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "copilot"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.gemini_cli_via_acp",
    "inventoryIds": [
      173
    ],
    "type": "tool",
    "domain": "system",
    "name": "Gemini CLI via ACP",
    "description": "Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.",
    "useWhen": [
      "User asks to execute or inspect Gemini CLI via ACP"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [
      "gemini_cli"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.opencode_via_acp",
    "inventoryIds": [
      174
    ],
    "type": "tool",
    "domain": "system",
    "name": "OpenCode via ACP",
    "description": "Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.",
    "useWhen": [
      "User asks to execute or inspect OpenCode via ACP"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "opencode"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.other_acp_harnesses",
    "inventoryIds": [
      175
    ],
    "type": "tool",
    "domain": "system",
    "name": "Other ACP harnesses",
    "description": "Після multi-agent + sandbox можна додати NPATI Code як orchestration над готовими coding agents.",
    "useWhen": [
      "User asks to execute or inspect Other ACP harnesses"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "acp_harness"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.semantic_cache",
    "inventoryIds": [
      176
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Semantic cache",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Semantic cache"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.priority",
    "inventoryIds": [
      177
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "priority",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires priority"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.fill-first",
    "inventoryIds": [
      178
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "fill-first",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires fill-first"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.weighted",
    "inventoryIds": [
      179
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "weighted",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires weighted"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.round-robin",
    "inventoryIds": [
      180
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "round-robin",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires round-robin"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.p2c",
    "inventoryIds": [
      181
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "p2c",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires p2c"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.least-used",
    "inventoryIds": [
      182
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "least-used",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires least-used"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "browser.random",
    "inventoryIds": [
      183
    ],
    "type": "orchestration",
    "domain": "browser",
    "name": "random",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires random"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "browser.strict-random",
    "inventoryIds": [
      184
    ],
    "type": "orchestration",
    "domain": "browser",
    "name": "strict-random",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires strict-random"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.headroom",
    "inventoryIds": [
      185
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "headroom",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires headroom"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.reset-window",
    "inventoryIds": [
      186
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "reset-window",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires reset-window"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.reset-aware",
    "inventoryIds": [
      187
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "reset-aware",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires reset-aware"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.context-relay",
    "inventoryIds": [
      188
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "context-relay",
    "description": "Використовувати як внутрішню routing policy.",
    "useWhen": [
      "Internal system execution requires context-relay"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.atomic_rpm_rolling_leases",
    "inventoryIds": [
      189
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Atomic RPM rolling leases",
    "description": "Дуже важливо для публічного SaaS-агента.",
    "useWhen": [
      "Internal system execution requires Atomic RPM rolling leases"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.quota-share_routing",
    "inventoryIds": [
      190
    ],
    "type": "runtime",
    "domain": "security",
    "name": "Quota-Share routing",
    "description": "Дуже важливо для публічного SaaS-агента.",
    "useWhen": [
      "Internal system execution requires Quota-Share routing"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.routing_transparency",
    "inventoryIds": [
      191
    ],
    "type": "runtime",
    "domain": "orchestration",
    "name": "Routing transparency",
    "description": "Дуже важливо для публічного SaaS-агента.",
    "useWhen": [
      "Internal system execution requires Routing transparency"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.session-dedup",
    "inventoryIds": [
      192
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Session-Dedup",
    "description": "Вмикати вибірково для довгих чатів, research та tool logs.",
    "useWhen": [
      "Internal system execution requires Session-Dedup"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.rtk",
    "inventoryIds": [
      193
    ],
    "type": "runtime",
    "domain": "system",
    "name": "RTK",
    "description": "NPATI використовує native OmniRoute compression/RTK через routing settings; adapter передає x-omniroute-compression, власний compression engine не створювався.",
    "useWhen": [
      "Internal system execution requires RTK"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.relevance",
    "inventoryIds": [
      194
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Relevance",
    "description": "Вмикати вибірково для довгих чатів, research та tool logs.",
    "useWhen": [
      "Internal system execution requires Relevance"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.aggressive",
    "inventoryIds": [
      195
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Aggressive",
    "description": "Вмикати вибірково для довгих чатів, research та tool logs.",
    "useWhen": [
      "Internal system execution requires Aggressive"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.llmlingua-2",
    "inventoryIds": [
      196
    ],
    "type": "runtime",
    "domain": "system",
    "name": "LLMLingua-2",
    "description": "Вмикати вибірково для довгих чатів, research та tool logs.",
    "useWhen": [
      "Internal system execution requires LLMLingua-2"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.compression_presets",
    "inventoryIds": [
      197
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Compression presets",
    "description": "Добре для контролю вартості й довгих контекстів.",
    "useWhen": [
      "Internal system execution requires Compression presets"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.adaptive_context_budget",
    "inventoryIds": [
      198
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Adaptive context budget",
    "description": "Добре для контролю вартості й довгих контекстів.",
    "useWhen": [
      "Internal system execution requires Adaptive context budget"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.per-request_compression_override",
    "inventoryIds": [
      199
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Per-request compression override",
    "description": "Tenant routing preference compression застосовується до chat requests. Окремий override для одного конкретного user request/API payload не реалізований.",
    "useWhen": [
      "Internal system execution requires Per-request compression override"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.output_styles",
    "inventoryIds": [
      200
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Output Styles",
    "description": "Добре для контролю вартості й довгих контекстів.",
    "useWhen": [
      "Internal system execution requires Output Styles"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.compression_eval_harness",
    "inventoryIds": [
      201
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Compression eval harness",
    "description": "Добре для контролю вартості й довгих контекстів.",
    "useWhen": [
      "Internal system execution requires Compression eval harness"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.cache_stats_flush",
    "inventoryIds": [
      202
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Cache stats / flush",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Cache stats / flush"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.cache-hit_savings_telemetry",
    "inventoryIds": [
      203
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Cache-hit savings telemetry",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Cache-hit savings telemetry"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "ai.model_catalog_sync",
    "inventoryIds": [
      204
    ],
    "type": "configuration",
    "domain": "ai",
    "name": "Model catalog sync",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Model catalog sync"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "browser.database_backups",
    "inventoryIds": [
      205
    ],
    "type": "runtime",
    "domain": "browser",
    "name": "Database backups",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Database backups"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.control_ui",
    "inventoryIds": [
      206
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Control UI",
    "description": "Розвивати admin/agent controls окремо від user chat.",
    "useWhen": [
      "Internal system execution requires Control UI"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "research.session_search",
    "inventoryIds": [
      207
    ],
    "type": "runtime",
    "domain": "research",
    "name": "Session search",
    "description": "Додати пошук по чатах/задачах.",
    "useWhen": [
      "Internal system execution requires Session search"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.session_pruning",
    "inventoryIds": [
      208
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Session pruning",
    "description": "Потрібно для storage/cost lifecycle.",
    "useWhen": [
      "Internal system execution requires Session pruning"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.customself-hosted_models",
    "inventoryIds": [
      209
    ],
    "type": "configuration",
    "domain": "security",
    "name": "Custom/self-hosted models",
    "description": "NPATI отримує models/providers через OmniRoute і не hardcode model list. Окремий live self-hosted provider/model connection та inference test у цьому середовищі не зафіксований.",
    "useWhen": [
      "Internal system execution requires Custom/self-hosted models"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.free-tier_catalog",
    "inventoryIds": [
      210
    ],
    "type": "configuration",
    "domain": "system",
    "name": "Free-tier catalog",
    "description": "Корисно для автоматичного вибору дешевих/безкоштовних моделей.",
    "useWhen": [
      "Internal system execution requires Free-tier catalog"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "ai.dedicated_provider_routes",
    "inventoryIds": [
      211
    ],
    "type": "runtime",
    "domain": "ai",
    "name": "Dedicated provider routes",
    "description": "Залишити як advanced/admin option.",
    "useWhen": [
      "Internal system execution requires Dedicated provider routes"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.ccr",
    "inventoryIds": [
      212
    ],
    "type": "runtime",
    "domain": "system",
    "name": "CCR",
    "description": "Вмикати вибірково для довгих чатів, research та tool logs.",
    "useWhen": [
      "Internal system execution requires CCR"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.lite",
    "inventoryIds": [
      213
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Lite",
    "description": "Вмикати вибірково для довгих чатів, research та tool logs.",
    "useWhen": [
      "Internal system execution requires Lite"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.responses_tool_output",
    "inventoryIds": [
      214
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Responses Tool Output",
    "description": "Вмикати вибірково для довгих чатів, research та tool logs.",
    "useWhen": [
      "Internal system execution requires Responses Tool Output"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.headroom",
    "inventoryIds": [
      215
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Headroom",
    "description": "Вмикати вибірково для довгих чатів, research та tool logs.",
    "useWhen": [
      "Internal system execution requires Headroom"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.caveman",
    "inventoryIds": [
      216
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Caveman",
    "description": "Вмикати вибірково для довгих чатів, research та tool logs.",
    "useWhen": [
      "Internal system execution requires Caveman"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.ultra",
    "inventoryIds": [
      217
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Ultra",
    "description": "Вмикати вибірково для довгих чатів, research та tool logs.",
    "useWhen": [
      "Internal system execution requires Ultra"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.omniglyph",
    "inventoryIds": [
      218
    ],
    "type": "runtime",
    "domain": "system",
    "name": "OmniGlyph",
    "description": "Вмикати вибірково для довгих чатів, research та tool logs.",
    "useWhen": [
      "Internal system execution requires OmniGlyph"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.qdrant_support",
    "inventoryIds": [
      219
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Qdrant support",
    "description": "Optional real Qdrant vector backend alongside authoritative PostgreSQL pgvector, with mandatory workspace/company/user filters, collision-safe point IDs, Docker persistence, Qdrant-only retrieval fallback, and document-delete cleanup.",
    "useWhen": [
      "Internal system execution requires Qdrant support"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.int8_vector_quantization",
    "inventoryIds": [
      220
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "int8 vector quantization",
    "description": "Native Qdrant scalar int8 quantization is enabled on the production collection with cosine distance, persisted configuration, and live Docker validation.",
    "useWhen": [
      "Internal system execution requires int8 vector quantization"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.device_tracking_per_api_key",
    "inventoryIds": [
      221
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Device tracking per API key",
    "description": "Atomically records devices and request counts for each Company API key in PostgreSQL, isolates telemetry by tenant/company/key, and flags use by more than five devices.",
    "useWhen": [
      "Internal system execution requires Device tracking per API key"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "critical",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.version_manager",
    "inventoryIds": [
      222
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Version manager",
    "description": "Корисно для SaaS контролю вартості, надійності та аудиту.",
    "useWhen": [
      "Internal system execution requires Version manager"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.plugins",
    "inventoryIds": [
      223
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Plugins",
    "description": "Сильний pattern для модульної архітектури.",
    "useWhen": [
      "Internal system execution requires Plugins"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.response_chunking",
    "inventoryIds": [
      224
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Response chunking",
    "description": "Великі model deltas та готові orchestration-відповіді діляться на bounded Unicode-safe SSE chunks перед доставкою.",
    "useWhen": [
      "Internal system execution requires Response chunking"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "communications.channel_docking_thread_binding",
    "inventoryIds": [
      225
    ],
    "type": "runtime",
    "domain": "communications",
    "name": "Channel docking / thread binding",
    "description": "Корисно, коли додаси зовнішні месенджери.",
    "useWhen": [
      "Internal system execution requires Channel docking / thread binding"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.plugin_hooks",
    "inventoryIds": [
      226
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Plugin hooks",
    "description": "Корисно для policy/telemetry/approval layer.",
    "useWhen": [
      "Internal system execution requires Plugin hooks"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.internal_hooks",
    "inventoryIds": [
      227
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Internal hooks",
    "description": "Корисно для audit/memory/cleanup.",
    "useWhen": [
      "Internal system execution requires Internal hooks"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "communications.telegram",
    "inventoryIds": [
      228
    ],
    "type": "tool",
    "domain": "communications",
    "name": "Telegram",
    "description": "Підключати через твій Hub, якщо вже є social/messaging infrastructure.",
    "useWhen": [
      "User asks to execute or inspect Telegram"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [
      "telegram"
    ],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "research.x_search",
    "inventoryIds": [
      229
    ],
    "type": "tool",
    "domain": "research",
    "name": "X search",
    "description": "Додавати лише якщо потрібен social research.",
    "useWhen": [
      "User asks to execute or inspect X search"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "x_api"
    ],
    "requiredPermissions": [
      "research:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.official_channel_plugins",
    "inventoryIds": [
      230
    ],
    "type": "runtime",
    "domain": "communications",
    "name": "Official channel plugins",
    "description": "Не копіювати все; обирати канали з реальним попитом.",
    "useWhen": [
      "User asks to execute or inspect Official channel plugins"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.external_channel_plugins",
    "inventoryIds": [
      231
    ],
    "type": "runtime",
    "domain": "communications",
    "name": "External channel plugins",
    "description": "Низький пріоритет.",
    "useWhen": [
      "User asks to execute or inspect External channel plugins"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.group_chat",
    "inventoryIds": [
      232
    ],
    "type": "orchestration",
    "domain": "communications",
    "name": "Group chat",
    "description": "Потрібно лише для team/chat use case.",
    "useWhen": [
      "User asks to execute or inspect Group chat"
    ],
    "doNotUseWhen": [
      "Internal orchestration only; handled by flow router, not directly callable tool"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.mention_activation",
    "inventoryIds": [
      233
    ],
    "type": "orchestration",
    "domain": "communications",
    "name": "Mention activation",
    "description": "Корисно для Slack/Discord/Teams.",
    "useWhen": [
      "User asks to execute or inspect Mention activation"
    ],
    "doNotUseWhen": [
      "Internal orchestration only; handled by flow router, not directly callable tool"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "ai.omniroute_radar",
    "inventoryIds": [
      234
    ],
    "type": "runtime",
    "domain": "ai",
    "name": "OmniRoute Radar",
    "description": "Не критично для першої версії агента.",
    "useWhen": [
      "Internal system execution requires OmniRoute Radar"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.video_generation",
    "inventoryIds": [
      235
    ],
    "type": "tool",
    "domain": "system",
    "name": "Video generation",
    "description": "Додавати після core business-agent функцій.",
    "useWhen": [
      "User asks to execute or inspect Video generation"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "video_provider"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.remote_cli_contexts",
    "inventoryIds": [
      236
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Remote CLI contexts",
    "description": "Корисно для ops, не user-facing.",
    "useWhen": [
      "Internal system execution requires Remote CLI contexts"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.mitm_tproxy",
    "inventoryIds": [
      237
    ],
    "type": "runtime",
    "domain": "system",
    "name": "MITM / TPROXY",
    "description": "Додавати лише якщо реально потрібне перехоплення coding CLI.",
    "useWhen": [
      "Internal system execution requires MITM / TPROXY"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.proxy_system",
    "inventoryIds": [
      238
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Proxy system",
    "description": "Не пріоритет для бізнес-агента.",
    "useWhen": [
      "Internal system execution requires Proxy system"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.embedded_bifrost_mux",
    "inventoryIds": [
      239
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Embedded Bifrost & Mux",
    "description": "Не user-facing.",
    "useWhen": [
      "Internal system execution requires Embedded Bifrost & Mux"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.relay_deployers",
    "inventoryIds": [
      240
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Relay deployers",
    "description": "Потрібно лише за конкретної мережевої архітектури.",
    "useWhen": [
      "Internal system execution requires Relay deployers"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.docker_podman_bun_nix",
    "inventoryIds": [
      241
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Docker / Podman / Bun / Nix",
    "description": "Production Docker Compose працює. Podman, Bun і Nix окремо не інтегровані та не протестовані, тому весь комбінований пункт не може мати ✅.",
    "useWhen": [
      "Internal system execution requires Docker / Podman / Bun / Nix"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.multiple_memory_engines",
    "inventoryIds": [
      242
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Multiple memory engines",
    "description": "One production memory-engine registry coordinates authoritative PostgreSQL pgvector, optional Qdrant int8 vectors, and persistent SQLite FTS5 through a shared health/index/search/delete contract.",
    "useWhen": [
      "Internal system execution requires Multiple memory engines"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.memory_import",
    "inventoryIds": [
      243
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "Memory import",
    "description": "Authenticated transactional Company Memory import supports Markdown and structured JSON, dry-run preview, deterministic hash deduplication, provenance, idempotency, tenant isolation, restart persistence, and whole-batch rollback.",
    "useWhen": [
      "Internal system execution requires Memory import"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.code_mode",
    "inventoryIds": [
      244
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Code Mode",
    "description": "Особливо важливо перед coding/browser/email automation.",
    "useWhen": [
      "Internal system execution requires Code Mode"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.clawhub",
    "inventoryIds": [
      245
    ],
    "type": "runtime",
    "domain": "system",
    "name": "ClawHub",
    "description": "Свій marketplace skills не потрібен на старті.",
    "useWhen": [
      "Internal system execution requires ClawHub"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "communications.video_generation",
    "inventoryIds": [
      246
    ],
    "type": "runtime",
    "domain": "communications",
    "name": "Video generation",
    "description": "Базовий голос/файли вже є; не відволікатися від orchestration та automation.",
    "useWhen": [
      "User asks to execute or inspect Video generation"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.music_generation",
    "inventoryIds": [
      247
    ],
    "type": "tool",
    "domain": "communications",
    "name": "Music generation",
    "description": "Базовий голос/файли вже є; не відволікатися від orchestration та automation.",
    "useWhen": [
      "User asks to execute or inspect Music generation"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [
      "music_provider"
    ],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.talk_realtime_speech",
    "inventoryIds": [
      248
    ],
    "type": "tool",
    "domain": "communications",
    "name": "Talk / realtime speech",
    "description": "Базовий голос/файли вже є; не відволікатися від orchestration та automation.",
    "useWhen": [
      "User asks to execute or inspect Talk / realtime speech"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.voice_call",
    "inventoryIds": [
      249
    ],
    "type": "tool",
    "domain": "communications",
    "name": "Voice Call",
    "description": "Базовий голос/файли вже є; не відволікатися від orchestration та automation.",
    "useWhen": [
      "User asks to execute or inspect Voice Call"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [
      "twilio_sip"
    ],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "system.macos_companion",
    "inventoryIds": [
      250
    ],
    "type": "tool",
    "domain": "system",
    "name": "macOS companion",
    "description": "Не пріоритет для веб-бізнес агента.",
    "useWhen": [
      "User asks to execute or inspect macOS companion"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "macos_daemon"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.ios_node_pairing",
    "inventoryIds": [
      251
    ],
    "type": "tool",
    "domain": "system",
    "name": "iOS node pairing",
    "description": "Не пріоритет для веб-бізнес агента.",
    "useWhen": [
      "User asks to execute or inspect iOS node pairing"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "ios_node"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.android_node_pairing",
    "inventoryIds": [
      252
    ],
    "type": "tool",
    "domain": "system",
    "name": "Android node pairing",
    "description": "Не пріоритет для веб-бізнес агента.",
    "useWhen": [
      "User asks to execute or inspect Android node pairing"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "android_node"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.mobile_chat",
    "inventoryIds": [
      253
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Mobile chat",
    "description": "Не пріоритет для веб-бізнес агента.",
    "useWhen": [
      "User asks to execute or inspect Mobile chat"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "communications.mobile_voice",
    "inventoryIds": [
      254
    ],
    "type": "tool",
    "domain": "communications",
    "name": "Mobile voice",
    "description": "Не пріоритет для веб-бізнес агента.",
    "useWhen": [
      "User asks to execute or inspect Mobile voice"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "medium",
    "requiresConfirmation": false,
    "requiredConnections": [
      "mobile_device"
    ],
    "requiredPermissions": [
      "communications:execute"
    ],
    "version": 1
  },
  {
    "id": "system.camera_access",
    "inventoryIds": [
      255
    ],
    "type": "tool",
    "domain": "system",
    "name": "Camera access",
    "description": "Не пріоритет для веб-бізнес агента.",
    "useWhen": [
      "User asks to execute or inspect Camera access"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "camera_hardware"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.screen_recording",
    "inventoryIds": [
      256
    ],
    "type": "tool",
    "domain": "system",
    "name": "Screen recording",
    "description": "Не пріоритет для веб-бізнес агента.",
    "useWhen": [
      "User asks to execute or inspect Screen recording"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "screen_capture"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.location_access",
    "inventoryIds": [
      257
    ],
    "type": "tool",
    "domain": "system",
    "name": "Location access",
    "description": "Не пріоритет для веб-бізнес агента.",
    "useWhen": [
      "User asks to execute or inspect Location access"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "gps_hardware"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.device_commands",
    "inventoryIds": [
      258
    ],
    "type": "tool",
    "domain": "system",
    "name": "Device commands",
    "description": "Не пріоритет для веб-бізнес агента.",
    "useWhen": [
      "User asks to execute or inspect Device commands"
    ],
    "doNotUseWhen": [
      "Context does not permit access or unauthorized for this tenant"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [
      "companion_device"
    ],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "system.linux_companion_inline_media",
    "inventoryIds": [
      259
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Linux companion / inline media",
    "description": "Не пріоритет для веб-бізнес агента.",
    "useWhen": [
      "User asks to execute or inspect Linux companion / inline media"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "security.tenant-scoped_ai_modelrouting_preference",
    "inventoryIds": [
      260
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Tenant-scoped AI model/routing preferences",
    "description": "PostgreSQL workspace_user_settings with strict workspace and user scope, optimistic CAS and restart persistence; legacy dev import is limited to the exact local dev scope without fallback or mirroring.",
    "useWhen": [
      "Internal system execution requires Tenant-scoped AI model/routing preferences"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "browser.business_company_separation_separate_com",
    "inventoryIds": [
      261
    ],
    "type": "runtime",
    "domain": "browser",
    "name": "Business / Company separation + separate companies table",
    "description": "Business залишається окремою business-analysis сутністю. Migration 006 створює окрему tenant/user-scoped companies table з optional business_id, FK, indexes, optimistic revision та idempotent create.",
    "useWhen": [
      "Internal system execution requires Business / Company separation + separate companies table"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "business.company_context_fields",
    "inventoryIds": [
      262
    ],
    "type": "runtime",
    "domain": "business",
    "name": "Company context fields",
    "description": "Окрема Company модель і user-facing Company Settings містять website, industry, description, products/services, languages, brand tone, company instructions, status і optional Business link.",
    "useWhen": [
      "Internal system execution requires Company context fields"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "files.company_knowledge_documents_memory",
    "inventoryIds": [
      263
    ],
    "type": "runtime",
    "domain": "files",
    "name": "Company knowledge / documents / memory",
    "description": "Company Knowledge/Documents/Memory реалізовані у runtime: private MinIO documents, PostgreSQL metadata, Excel/PDF/DOCX/text extraction, Redis processing, OmniRoute Embeddings, pgvector retrieval, Company Memory, fail-closed per-agent Knowledge permissions, Main Agent delegation та grounded final answer. Native OmniRoute Rerank provider/model ще не підключений; використовується bounded pgvector fallback.",
    "useWhen": [
      "Internal system execution requires Company knowledge / documents / memory"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.extensible_agent_definitions_crud",
    "inventoryIds": [
      264
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Extensible Agent definitions + CRUD",
    "description": "company_agents CRUD, tenant/company scope, idempotent create, optimistic update/delete, enable/disable, Agent Editor та cursor pagination. Delete атомарно очищає edges і main_agent_id та одразу синхронізує list/Org Chart.",
    "useWhen": [
      "Internal system execution requires Extensible Agent definitions + CRUD"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.agent_role_instructions_enabled_state",
    "inventoryIds": [
      265
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Agent role + instructions + enabled state",
    "description": "Custom role, description, independent system instruction, prompt guidelines, recommended prompts та Active/Inactive зберігаються в PostgreSQL і редагуються у Company Agent Editor.",
    "useWhen": [
      "Internal system execution requires Agent role + instructions + enabled state"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "ai.per-agent_model_fallback_auto",
    "inventoryIds": [
      266
    ],
    "type": "runtime",
    "domain": "ai",
    "name": "Per-agent model + fallback + Auto",
    "description": "Per-agent model і fallback зберігають OmniRoute model IDs. UI отримує concrete models з /ai/models/added; Auto не зберігає hardcoded provider та означає OmniRoute Auto Routing. API відхиляє model ID поза My Models.",
    "useWhen": [
      "Internal system execution requires Per-agent model + fallback + Auto"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.per-agent_tool_allowlist",
    "inventoryIds": [
      267
    ],
    "type": "configuration",
    "domain": "system",
    "name": "Per-agent tool allowlist",
    "description": "Crawler використовує існуючий web-research/Crawl4AI; MCP - OmniRoute v3.8.50 Streamable HTTP із safe read-only allowlist; Files - Company knowledge та лише явно linked tenant attachments. Backend deny-by-default і PostgreSQL audit збережені.",
    "useWhen": [
      "User asks to execute or inspect Per-agent tool allowlist"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; user/admin configuration only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "orchestration.manager_delegation_a2a_pipeline_fusion",
    "inventoryIds": [
      268
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "Manager delegation через A2A / Pipeline / Fusion",
    "description": "Main Agent планує через OmniRoute A2A smart-routing; NPATI створює thin orchestration config, а OmniRoute Pipeline/Fusion/Auto виконує sequential/parallel delegation, optional Reviewer та final Main response.",
    "useWhen": [
      "Internal system execution requires Manager delegation через A2A / Pipeline / Fusion"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "business.company_agents_models_cards_responsive_g",
    "inventoryIds": [
      269
    ],
    "type": "configuration",
    "domain": "business",
    "name": "Company / Agents / Models cards у responsive grid",
    "description": "Settings має окремі Business, Company і Models cards. Дублюючу Agents card видалено: company-scoped Agents керуються всередині /company через Agent Editor та Org Chart. Business відкриває /business.",
    "useWhen": [
      "Internal system execution requires Company / Agents / Models cards у responsive grid"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "business.business_company_separation",
    "inventoryIds": [
      270
    ],
    "type": "runtime",
    "domain": "business",
    "name": "Business / Company separation",
    "description": "Business analysis залишається у businesses; operational AI Company використовує окремий companies API/store/page.",
    "useWhen": [
      "Internal system execution requires Business / Company separation"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "browser.companies_table",
    "inventoryIds": [
      271
    ],
    "type": "runtime",
    "domain": "browser",
    "name": "companies table",
    "description": "Окрема companies table: tenant/user scope, optional Business FK, context fields, status, revision, idempotency key, indexes.",
    "useWhen": [
      "Internal system execution requires companies table"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "browser.company_agents_table",
    "inventoryIds": [
      272
    ],
    "type": "runtime",
    "domain": "browser",
    "name": "company_agents table",
    "description": "Окрема company_agents table з custom role, instructions, prompts, models, tools, status, positions, order, revision та idempotency.",
    "useWhen": [
      "Internal system execution requires company_agents table"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "browser.company_agent_edges",
    "inventoryIds": [
      273
    ],
    "type": "runtime",
    "domain": "browser",
    "name": "company_agent_edges",
    "description": "Окремі configurable parent/child edges; one reporting parent; DB self-check; API cycle validation під advisory transaction lock.",
    "useWhen": [
      "Internal system execution requires company_agent_edges"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "business.separate_company_page",
    "inventoryIds": [
      274
    ],
    "type": "configuration",
    "domain": "business",
    "name": "Separate Company page",
    "description": "Settings → Company відкриває окремий /company route з Company selector, status, Main Agent, Add Agent та Company Settings.",
    "useWhen": [
      "Internal system execution requires Separate Company page"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "business.visual_agent_org_chart",
    "inventoryIds": [
      275
    ],
    "type": "configuration",
    "domain": "business",
    "name": "Visual Agent Org Chart",
    "description": "Native NPATI multi-level nodes/edges з Main/Active/model state; data configurable. Agents завантажуються cursor pages по 60, edges лише для loaded IDs, cards використовують content-visibility.",
    "useWhen": [
      "Internal system execution requires Visual Agent Org Chart"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.agent_editor",
    "inventoryIds": [
      276
    ],
    "type": "configuration",
    "domain": "system",
    "name": "Agent Editor",
    "description": "Drawer редагує General, AI, Instructions, Tools, Organization і Danger Zone; create/edit/delete/disable/set main/change parent. Delete передає expectedRevision та коректно прибирає Agent зі списку й Org Chart.",
    "useWhen": [
      "Internal system execution requires Agent Editor"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.main_agent_configuration",
    "inventoryIds": [
      277
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "Main Agent configuration",
    "description": "Користувач може вибрати будь-якого агента цієї Company як Main Agent; FK не дозволяє foreign-company agent.",
    "useWhen": [
      "Internal system execution requires Main Agent configuration"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "ai.per-agent_model",
    "inventoryIds": [
      278
    ],
    "type": "runtime",
    "domain": "ai",
    "name": "Per-agent Model",
    "description": "Concrete model IDs вибираються лише з OmniRoute-backed My Models; Auto використовує OmniRoute routing.",
    "useWhen": [
      "Internal system execution requires Per-agent Model"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "ai.per-agent_fallback_model",
    "inventoryIds": [
      279
    ],
    "type": "runtime",
    "domain": "ai",
    "name": "Per-agent Fallback Model",
    "description": "Fallback model окремо конфігурується та валідується через ту саму OmniRoute-backed library; Auto підтримується.",
    "useWhen": [
      "Internal system execution requires Per-agent Fallback Model"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.per-agent_instructions",
    "inventoryIds": [
      280
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Per-agent Instructions",
    "description": "Independent system instruction, prompt guidelines і recommended prompts зберігаються для кожного company agent.",
    "useWhen": [
      "Internal system execution requires Per-agent Instructions"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.per-agent_tools_configuration",
    "inventoryIds": [
      281
    ],
    "type": "configuration",
    "domain": "system",
    "name": "Per-agent Tools configuration",
    "description": "Per-agent allowlist UI/API/PostgreSQL застосовується в runtime для Web Search/Fetch, Crawler, safe MCP і Files. Backend блокує заборонені tools, OmniRoute combo має tool_filter_regex, кожне рішення пишеться в tenant-scoped audit.",
    "useWhen": [
      "User asks to execute or inspect Per-agent Tools configuration"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; user/admin configuration only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "system:execute"
    ],
    "version": 1
  },
  {
    "id": "business.manual_agent_scheme",
    "inventoryIds": [
      282
    ],
    "type": "configuration",
    "domain": "business",
    "name": "Manual Agent Scheme",
    "description": "Add/Delete Agent, Parent Agent selector, reassign/change parent, set Main Agent; arbitrary roles and multi-level hierarchy. Delete атомарно видаляє incoming/outgoing edges та очищає Main Agent.",
    "useWhen": [
      "Internal system execution requires Manual Agent Scheme"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "orchestration.omniroute_orchestration_integration",
    "inventoryIds": [
      283
    ],
    "type": "orchestration",
    "domain": "orchestration",
    "name": "OmniRoute orchestration integration",
    "description": "NPATI використовує готові OmniRoute v3.8.50 A2A, persisted Pipeline/Fusion combos і Auto Routing; власні routing/failover/circuit-breaker engines не створені.",
    "useWhen": [
      "Internal system execution requires OmniRoute orchestration integration"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.runtime_tool_enforcement_audit",
    "inventoryIds": [
      284
    ],
    "type": "security_ops",
    "domain": "system",
    "name": "Runtime tool enforcement + audit",
    "description": "Deny-by-default enforcement і tenant-scoped PostgreSQL audit працюють для web.search, web.fetch, web.crawl, safe OmniRoute MCP та Company-linked Files. Concrete MCP names нормалізуються до generic MCP adapter; admin/write MCP tools не дозволені.",
    "useWhen": [
      "Internal system execution requires Runtime tool enforcement + audit"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.agent_run_reliability_and_cancellation",
    "inventoryIds": [
      285
    ],
    "type": "orchestration",
    "domain": "system",
    "name": "Agent run reliability and cancellation",
    "description": "Company runs виконуються окремим Redis Streams worker. PostgreSQL є source of truth: atomic lease/heartbeat claim, attempt/max-attempts, retry backoff, timeout, Pub/Sub + DB cancellation, upstream idempotency keys і duplicate protection. Worker/API не тримають критичний run state лише в RAM.",
    "useWhen": [
      "Internal system execution requires Agent run reliability and cancellation"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "business.company_agents_pagination_bounded_org_ch",
    "inventoryIds": [
      286
    ],
    "type": "runtime",
    "domain": "business",
    "name": "Company agents pagination + bounded Org Chart",
    "description": "Cursor pagination limit<=100; Company UI loads 60 agents per page; edge endpoint filters loaded agent IDs; content-visibility для agent cards.",
    "useWhen": [
      "Internal system execution requires Company agents pagination + bounded Org Chart"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "research.crawler_mcp_files_runtime_adapters",
    "inventoryIds": [
      287
    ],
    "type": "runtime",
    "domain": "research",
    "name": "Crawler / MCP / Files runtime adapters",
    "description": "Existing Crawl4AI/web-research, OmniRoute MCP та Company-linked Files інтегровані без дублювання gateway/service. Per-agent allowlist, tenant isolation і audit застосовуються runtime.",
    "useWhen": [
      "User asks to execute or inspect Crawler / MCP / Files runtime adapters"
    ],
    "doNotUseWhen": [
      "Internal runtime execution only; not exposed to LLM agents as tools"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [
      "research:execute"
    ],
    "version": 1
  },
  {
    "id": "business.redis_background_company_execution",
    "inventoryIds": [
      288
    ],
    "type": "runtime",
    "domain": "business",
    "name": "Redis background Company execution",
    "description": "HTTP створює persisted queued run і повертає 202; Redis Streams dispatch; окремий worker; status, retries/backoff, timeout, cancellation, idempotency, duplicate protection, lease/heartbeat.",
    "useWhen": [
      "Internal system execution requires Redis background Company execution"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "business.crashrestart_recovery",
    "inventoryIds": [
      289
    ],
    "type": "runtime",
    "domain": "business",
    "name": "Crash/restart recovery",
    "description": "Worker періодично відновлює queued/stale leased jobs із PostgreSQL; Redis message loss не втрачає run; atomic DB claim блокує паралельне виконання одного run; stable upstream idempotency keys зменшують повторне inference після boundary failure.",
    "useWhen": [
      "Internal system execution requires Crash/restart recovery"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.10_000_concurrent_session_capacity",
    "inventoryIds": [
      290
    ],
    "type": "runtime",
    "domain": "system",
    "name": "10 000 concurrent session capacity",
    "description": "Staged authenticated Company read-path load test виконаний. Це не provider-backed chat/SSE load test і не підтверджує 10 000 active chat sessions. Потрібні backpressure/connection tuning, distributed API replicas та окремий chat/SSE/provider load profile.",
    "useWhen": [
      "Internal system execution requires 10 000 concurrent session capacity"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "system.transactional_agent_delete_non-duplicate",
    "inventoryIds": [
      291
    ],
    "type": "runtime",
    "domain": "system",
    "name": "Transactional Agent delete + non-duplicated Settings navigation",
    "description": "Виправлено DELETE без body: frontend більше не надсилає порожній application/json; API вимагає expectedRevision; PostgreSQL transaction/advisory lock очищає edges і main_agent_id; дублюючу Settings Agents card видалено, agent management лишається у /company.",
    "useWhen": [
      "Internal system execution requires Transactional Agent delete + non-duplicated Settings navigation"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "critical",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "files.central_minio_object_storage",
    "inventoryIds": [
      292
    ],
    "type": "runtime",
    "domain": "files",
    "name": "Central MinIO object storage",
    "description": "Один MinIO service у Docker; 4 bounded private buckets; persistent named volume; credentials/endpoint через env; health у Agent API; documented external S3/R2 backup strategy. Жодного bucket per user.",
    "useWhen": [
      "Internal system execution requires Central MinIO object storage"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "files.central_file_metadata",
    "inventoryIds": [
      293
    ],
    "type": "runtime",
    "domain": "files",
    "name": "Central file metadata",
    "description": "Migration 010 створює files metadata: tenant/user/company/chat/message ownership, private bucket/object key, filename/MIME/size/checksum/category/status, scanner hook, idempotency key, soft-delete timestamps, indexes та FK. Binary у PostgreSQL не зберігається.",
    "useWhen": [
      "Internal system execution requires Central file metadata"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "files.chat_files_migrated_to_minio",
    "inventoryIds": [
      294
    ],
    "type": "runtime",
    "domain": "files",
    "name": "Chat files migrated to MinIO",
    "description": "Усі chat attachments (images, audio, PDF/documents та supported files) переведені з local Docker volume у central private MinIO. PostgreSQL files metadata зберігає workspace/user/business/chat/message ownership, checksum і idempotency; UI підтримує upload, paste/drop та reopen через private backend proxy. Legacy .bin/.json мігруються зі збереженням UUID і видаляються локально тільки після успішного upload.",
    "useWhen": [
      "Internal system execution requires Chat files migrated to MinIO"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "files.private_permission-checked_file_access",
    "inventoryIds": [
      295
    ],
    "type": "security_ops",
    "domain": "files",
    "name": "Private permission-checked file access",
    "description": "Private backend proxy з auth та workspace/user/business ownership checks, no-store/nosniff, MIME/signature/size validation і download audit. Distributed Redis Lua rate limits окремо для upload/download/delete, tenant-hashed shared keys, HTTP 429 + Retry-After. MinIO operation deadline, HTTP(S) socket timeout, download/list idle та total stream timeout.",
    "useWhen": [
      "Internal system execution requires Private permission-checked file access"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "files.file_delete_and_orphan_cleanup",
    "inventoryIds": [
      296
    ],
    "type": "runtime",
    "domain": "files",
    "name": "File delete and orphan cleanup",
    "description": "Periodic двосторонній PostgreSQL↔MinIO reconciler під distributed Redis lease. Paginated DB scan і batched object lookup; 24h configurable grace перед MinIO-only delete; повторна DB перевірка перед delete; PostgreSQL-only ready records стають failed зі storage_missing_at; pending deletes завершуються; усі результати у storage_reconciliation_audit. Migration 013.",
    "useWhen": [
      "Internal system execution requires File delete and orphan cleanup"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "critical",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.company_knowledge_ui",
    "inventoryIds": [
      297
    ],
    "type": "configuration",
    "domain": "storage",
    "name": "Company Knowledge UI",
    "description": "Company Knowledge UI у CompanyPage: upload, list, status/error/chunk count, private download, delete, failed-document Retry/reprocess та Company Memory create/list/delete. Production Web build і Docker deploy пройшли; live lifecycle перевірено.",
    "useWhen": [
      "Internal system execution requires Company Knowledge UI"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "files.company_documents_lifecycle",
    "inventoryIds": [
      298
    ],
    "type": "runtime",
    "domain": "files",
    "name": "Company documents lifecycle",
    "description": "Company documents lifecycle завершено: private MinIO originals, PostgreSQL ownership/metadata, upload/list/download/reprocess/delete, Excel extraction, UUID keys, MIME/size validation, idempotency. DELETE транзакційно блокує document row; processing worker не може воскресити deleted document.",
    "useWhen": [
      "Internal system execution requires Company documents lifecycle"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.company_memory",
    "inventoryIds": [
      299
    ],
    "type": "tool",
    "domain": "storage",
    "name": "Company memory",
    "description": "Company Memory з tenant/company/user scope інтегрована в Company Agent runtime. Memory додається лише у fail-closed Knowledge-authorized workflow; live Main Agent -> specialist pipeline повернув точний memory fact разом із document fact.",
    "useWhen": [
      "Agent needs to recall, store, or query persistent company memory facts and operational rules"
    ],
    "doNotUseWhen": [
      "User request does not involve company memory recall or update"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.omniroute_embeddings_integration",
    "inventoryIds": [
      300
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "OmniRoute Embeddings integration",
    "description": "OmniRoute adapter інтегрує native POST /api/v1/embeddings; live OpenAI text-embedding-3-small через OmniRoute v3.8.50 повернув 1536-d vector, document processing завершився ready. Модель задається environment config, не hardcode frontend.",
    "useWhen": [
      "Internal system execution requires OmniRoute Embeddings integration"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "files.postgresql_pgvector_storage",
    "inventoryIds": [
      301
    ],
    "type": "runtime",
    "domain": "files",
    "name": "PostgreSQL pgvector storage",
    "description": "Migration 014 виправлена відповідно до існуючої схеми: tenant IDs workspace/company/user мають тип text, document/file IDs - uuid. pgvector 0.8.6 і таблиці knowledge успішно застосовані. Контрольний PostgreSQL restart на persistent volume пройдено без втрати записів; API reconnect і health ok.",
    "useWhen": [
      "Internal system execution requires PostgreSQL pgvector storage"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.omniroute_rerank_integration",
    "inventoryIds": [
      302
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "OmniRoute Rerank integration",
    "description": "Native OmniRoute POST /api/v1/rerank adapter має validation/timeout/cancellation. Discovery виправлено: rerank model шукається через unified /api/v1/models за apiFormat/supportedEndpoints, а не неіснуючий GET /rerank. Environment wiring додано для Jina/Cohere/Voyage. Runtime безпечно використовує bounded pgvector fallback.",
    "useWhen": [
      "Internal system execution requires OmniRoute Rerank integration"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.agent_knowledge_retrieval",
    "inventoryIds": [
      303
    ],
    "type": "tool",
    "domain": "storage",
    "name": "Agent knowledge retrieval",
    "description": "Agent knowledge retrieval завершено: scoped pgvector retrieval + Company Memory, Knowledge tool runtime adapter, authoritative grounding та Main Agent final verification. Fail-closed: shared OmniRoute workflow отримує Knowledge лише коли кожний учасник має explicit permission.",
    "useWhen": [
      "Agent needs to retrieve company knowledge documents, procedures, or domain manuals via vector search"
    ],
    "doNotUseWhen": [
      "General conversation not requiring internal document knowledge retrieval"
    ],
    "agentCallable": true,
    "userVisible": true,
    "risk": "high",
    "requiresConfirmation": true,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "security.knowledge_tenantcompany_isolation",
    "inventoryIds": [
      304
    ],
    "type": "security_ops",
    "domain": "security",
    "name": "Knowledge tenant/company isolation",
    "description": "Tenant/company isolation та per-agent Knowledge enforcement завершено. Document/memory/vector queries scoped workspace_id + company_id + user_id; private MinIO access permission-checked. Shared Pipeline/Fusion context використовує fail-closed all-participants policy.",
    "useWhen": [
      "Internal system execution requires Knowledge tenant/company isolation"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": true,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "files.background_document_processing",
    "inventoryIds": [
      305
    ],
    "type": "runtime",
    "domain": "files",
    "name": "Background document processing",
    "description": "Redis background processing має status/attempts/lease/retry/recovery, transactional chunk replacement і delete-vs-worker row locking. API/Redis/worker restart та duplicate-message recovery пройшли; queued Company run cancellation terminal.",
    "useWhen": [
      "Internal system execution requires Background document processing"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  },
  {
    "id": "storage.npati-004_end-to-end_production_validati",
    "inventoryIds": [
      306
    ],
    "type": "runtime",
    "domain": "storage",
    "name": "NPATI-004 end-to-end production validation",
    "description": "NPATI-004 production validation оновлена: Excel extraction, document delete race fix, cross-tenant/cross-company negatives, restart/recovery/cancellation, fail-closed Knowledge policy та повний Main Agent E2E завершені.",
    "useWhen": [
      "Internal system execution requires NPATI-004 end-to-end production validation"
    ],
    "doNotUseWhen": [
      "Not directly callable by LLM agents; internal runtime only"
    ],
    "agentCallable": false,
    "userVisible": false,
    "risk": "low",
    "requiresConfirmation": false,
    "requiredConnections": [],
    "requiredPermissions": [],
    "version": 1
  }
];
