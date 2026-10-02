// Auto-generated Capability Matrix covering all 306 inventory items with evidence ownership
export interface CapabilityMatrixEntry {
  id: number;
  capabilityId: string;
  name: string;
  type: "runtime" | "tool" | "orchestration" | "security_ops" | "configuration";
  domain: string;
  agentCallable: boolean;
  risk: "low" | "medium" | "high" | "critical";
  testType: "unit" | "integration" | "e2e" | "manual" | "blocked_external";
  testFiles: string[];
  status: "VERIFIED_EXISTING" | "PARTIALLY_IMPLEMENTED" | "NOT_IMPLEMENTED" | "BLOCKED_EXTERNAL";
}

export const CAPABILITY_MATRIX: CapabilityMatrixEntry[] = [
  {
    "id": 1,
    "capabilityId": "ai.352_ai_providers",
    "name": "352 AI providers",
    "type": "runtime",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/human-approvals.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 2,
    "capabilityId": "system.openai_chat_completions",
    "name": "OpenAI Chat Completions",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/network-tproxy-and-bifrost-mux.test.ts",
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 3,
    "capabilityId": "system.openai_responses_api",
    "name": "OpenAI Responses API",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/audit-and-usage-analytics.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/omniroute-embeddings-resilience.test.ts",
      "tests/sandboxing-and-format-translation.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 4,
    "capabilityId": "ai.models_catalog_endpoint",
    "name": "Models catalog endpoint",
    "type": "configuration",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/freetier-dedicated-routes-and-ccr.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/telemetry-cache-compaction.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 5,
    "capabilityId": "orchestration.auto",
    "name": "auto",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/acp-claude-code-and-priority-routing.test.ts",
      "tests/agent-api.test.ts",
      "tests/ai-preferences.test.ts",
      "tests/auto-combo-profiles.test.ts",
      "tests/auto-fusion-pipeline-routing.test.ts",
      "tests/auto-offline-lkgp-and-a2a.test.ts",
      "tests/auto-reviewer-and-fts-memory.test.ts",
      "tests/automation-flows-and-email.test.ts",
      "tests/automation-reminders-heartbeat-hooks.test.ts",
      "tests/automation-scheduler.test.ts",
      "tests/browser-tab-click-drag-automation.test.ts",
      "tests/company-runtime.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/output-styles-eval-and-cache.test.ts",
      "tests/versioning-xsearch-channel-plugins.test.ts",
      "tests/web-research.test.ts",
      "tests/workspace-store.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 6,
    "capabilityId": "orchestration.autosmart",
    "name": "auto/smart",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/ai-preferences.test.ts",
      "tests/company-runtime.test.ts",
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 7,
    "capabilityId": "research.websearch_provider_routing",
    "name": "Web/search provider routing",
    "type": "runtime",
    "domain": "research",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/agent-api.test.ts",
      "tests/auto-offline-lkgp-and-a2a.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 8,
    "capabilityId": "system.webchat",
    "name": "WebChat",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/agent-api.test.ts",
      "tests/runtime-compat-capabilities.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 9,
    "capabilityId": "security.35_model_providers",
    "name": "OmniRoute provider catalog",
    "type": "configuration",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/acp-claude-code-and-priority-routing.test.ts",
      "tests/agent-api.test.ts",
      "tests/ai-marketplace-normalization.test.ts",
      "tests/auto-offline-lkgp-and-a2a.test.ts",
      "tests/company-runtime.test.ts",
      "tests/fill-first-weighted-round-robin.test.ts",
      "tests/freetier-dedicated-routes-and-ccr.test.ts",
      "tests/omniroute-marketplace-client.test.ts",
      "tests/p2c-least-used-random-routing.test.ts",
      "tests/strict-random-headroom-reset-window.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 10,
    "capabilityId": "research.web_search",
    "name": "Web search",
    "type": "tool",
    "domain": "research",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 11,
    "capabilityId": "browser.web_fetch",
    "name": "Web fetch",
    "type": "tool",
    "domain": "browser",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 12,
    "capabilityId": "communications.webchat_channel",
    "name": "WebChat transport channel",
    "type": "runtime",
    "domain": "communications",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/runtime-compat-capabilities.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 13,
    "capabilityId": "system.dashboard",
    "name": "Connected Services",
    "type": "configuration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/runtime-compat-capabilities.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 14,
    "capabilityId": "system.ollama-compatible_api",
    "name": "Ollama-compatible API",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/runtime-compat-capabilities.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 15,
    "capabilityId": "system.text-to-speech",
    "name": "Text-to-Speech",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/runtime-compat-capabilities.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 16,
    "capabilityId": "system.speech-to-text",
    "name": "Speech-to-Text",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 17,
    "capabilityId": "system.local_redis",
    "name": "Local Redis",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 18,
    "capabilityId": "communications.text-to-speech",
    "name": "Text-to-Speech",
    "type": "runtime",
    "domain": "communications",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/swarm-audio-translation-video.test.ts",
      "tests/telegram-ollama-tts.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 19,
    "capabilityId": "ai.provider_circuit_breaker",
    "name": "Provider circuit breaker",
    "type": "runtime",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/circuit-breaker-and-retry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 20,
    "capabilityId": "system.cooldown_lockout",
    "name": "Cooldown / lockout",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/agent-api.test.ts",
      "tests/circuit-breaker-and-retry.test.ts",
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 21,
    "capabilityId": "system.retry_backoff",
    "name": "Retry / backoff",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/circuit-breaker-and-retry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 22,
    "capabilityId": "system.adaptive_admission_queue",
    "name": "Adaptive admission / queue",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/admission-queue-and-conversation-memory.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/production-p03-reliability-scale.test.ts",
      "tests/production-admission-self-healing.test.ts",
      "scripts/verify-production-admission-self-healing.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 23,
    "capabilityId": "system.self-healing_auto-combo",
    "name": "Self-healing Auto-Combo",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/admission-queue-and-conversation-memory.test.ts",
      "tests/production-p03-reliability-scale.test.ts",
      "tests/production-admission-self-healing.test.ts",
      "scripts/verify-production-admission-self-healing.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 24,
    "capabilityId": "security.live_quota_telemetry",
    "name": "Live quota telemetry",
    "type": "runtime",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/memory-md-quota-and-channel-auth.test.ts",
      "tests/telemetry-cache-compaction.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 25,
    "capabilityId": "system.cost_telemetry_headers",
    "name": "Cost telemetry headers",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/company-runtime.test.ts",
      "scripts/verify-unified-telemetry.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 26,
    "capabilityId": "security.per-key_usd_spend_quotas",
    "name": "Per-key USD spend quotas",
    "type": "runtime",
    "domain": "security",
    "agentCallable": false,
    "risk": "critical",
    "testType": "unit",
    "testFiles": [
      "tests/telemetry-cache-compaction.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 27,
    "capabilityId": "system.usage_analytics",
    "name": "Usage analytics",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/audit-and-usage-analytics.test.ts",
      "tests/company-runtime.test.ts",
      "scripts/verify-unified-telemetry.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 28,
    "capabilityId": "security.quota_tracking",
    "name": "Quota tracking",
    "type": "runtime",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/audit-and-usage-analytics.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 29,
    "capabilityId": "system.audit_trail",
    "name": "Audit trail",
    "type": "security_ops",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/audit-and-usage-analytics.test.ts",
      "tests/company-runtime.test.ts",
      "scripts/verify-unified-telemetry.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 30,
    "capabilityId": "system.health_diagnostics",
    "name": "Health / diagnostics",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 31,
    "capabilityId": "security.prompt-injection_guard",
    "name": "Prompt-injection guard",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/production-security-guardrails.test.ts",
      "scripts/verify-production-security-guardrails.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 32,
    "capabilityId": "security.pii_masker",
    "name": "PII masker",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/production-security-guardrails.test.ts",
      "tests/pii-and-subagents.test.ts",
      "scripts/verify-production-security-guardrails.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 33,
    "capabilityId": "security.credential_masking",
    "name": "Credential masking",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/production-security-guardrails.test.ts",
      "tests/integrations-and-security.test.ts",
      "scripts/verify-production-security-guardrails.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 34,
    "capabilityId": "security.custom_guardrails",
    "name": "Custom guardrails",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/production-security-guardrails.test.ts",
      "scripts/verify-production-security-guardrails.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 35,
    "capabilityId": "security.api_key_auth",
    "name": "API key auth",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "critical",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/security-auth-vault-scopes.test.ts",
      "tests/production-p01-security.test.ts",
      "scripts/verify-production-api-key-auth.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 36,
    "capabilityId": "security.oauth_20_pkce",
    "name": "OAuth 2.0 + PKCE",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/auto-reviewer-and-fts-memory.test.ts",
      "tests/company-knowledge-hub-e2e.test.ts",
      "tests/memory-decay-rerank-and-journal.test.ts",
      "tests/oauth-tokens-and-route-tiers.test.ts",
      "tests/webhooks-documents-and-plugins.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 37,
    "capabilityId": "security.automatic_token_refresh",
    "name": "Automatic token refresh",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "critical",
    "testType": "integration",
    "testFiles": [
      "tests/oauth-tokens-and-route-tiers.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 38,
    "capabilityId": "security.aes-256-gcm_at_rest",
    "name": "AES-256-GCM at rest",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/capability-registry.test.ts",
      "tests/security-auth-vault-scopes.test.ts",
      "tests/production-p01-security.test.ts",
      "scripts/verify-production-api-key-auth.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 39,
    "capabilityId": "security.route_guard_tiers",
    "name": "Route guard tiers",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/oauth-tokens-and-route-tiers.test.ts",
      "tests/pii-and-subagents.test.ts",
      "tests/production-durable-approvals.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 40,
    "capabilityId": "security.mcp_authorization_scopes",
    "name": "MCP authorization scopes",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/oauth-tokens-and-route-tiers.test.ts",
      "tests/security-auth-vault-scopes.test.ts",
      "tests/production-mcp-policy.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 41,
    "capabilityId": "system.gateway",
    "name": "Gateway",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/channel-groups-and-mentions.test.ts",
      "tests/file-tools-and-coding-cli.test.ts",
      "tests/mobile-chat-voice-camera.test.ts",
      "tests/omniroute-embeddings-resilience.test.ts",
      "tests/telegram-ollama-tts.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 42,
    "capabilityId": "system.streaming_responses",
    "name": "Streaming responses",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/agent-api.test.ts",
      "tests/company-runtime.test.ts",
      "tests/web-chat-stream-client.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 43,
    "capabilityId": "system.main_session",
    "name": "Main session",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/admission-queue-and-conversation-memory.test.ts",
      "tests/modality-bridge-image-editing-browser.test.ts",
      "tests/scoped-memory-and-user-model.test.ts",
      "tests/web-research.test.ts",
      "tests/workspace-store.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 44,
    "capabilityId": "system.isolated_group_sessions",
    "name": "Isolated group sessions",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/group-sessions-and-tool-policy.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 45,
    "capabilityId": "system.multi-user_mode",
    "name": "Multi-user mode",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/admission-queue-and-conversation-memory.test.ts",
      "tests/company-knowledge-concurrency.test.ts",
      "tests/inference-and-memory-injection.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/scoped-memory-and-user-model.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 46,
    "capabilityId": "system.session_tools",
    "name": "Session tools",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/group-sessions-and-tool-policy.test.ts",
      "tests/multi-user-dm-pairing-subagents.test.ts",
      "tests/workspace-store.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 47,
    "capabilityId": "security.sandboxing",
    "name": "Sandboxing",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/sandboxing-and-format-translation.test.ts",
      "tests/production-wasm-exec.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 48,
    "capabilityId": "security.tool_allowdeny_policy",
    "name": "Tool allow/deny policy",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/group-sessions-and-tool-policy.test.ts",
      "tests/multi-user-dm-pairing-subagents.test.ts",
      "tests/production-mcp-policy.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 49,
    "capabilityId": "security.exec_approvals",
    "name": "Exec approvals",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "high",
    "testType": "integration",
    "testFiles": [
      "tests/human-approvals.test.ts",
      "tests/production-durable-approvals.test.ts",
      "tests/production-wasm-exec.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 50,
    "capabilityId": "communications.dm_allowlists_pairing",
    "name": "DM allowlists & pairing",
    "type": "configuration",
    "domain": "communications",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 51,
    "capabilityId": "security.per-agent_tool_policy",
    "name": "Per-agent tool policy",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/company-runtime.test.ts",
      "tests/group-sessions-and-tool-policy.test.ts",
      "tests/memory-import-codemode-clawhub.test.ts",
      "tests/multi-user-dm-pairing-subagents.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 52,
    "capabilityId": "security.per-subagent_tool_policy",
    "name": "Per-subagent tool policy",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/multi-user-dm-pairing-subagents.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 53,
    "capabilityId": "security.sandbox_host_separation",
    "name": "Sandbox + host separation",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/sandboxing-and-format-translation.test.ts",
      "tests/production-wasm-exec.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 54,
    "capabilityId": "security.human_approvals",
    "name": "Human approvals",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/human-approvals.test.ts",
      "tests/production-durable-approvals.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 55,
    "capabilityId": "communications.channel_sender_authorization",
    "name": "Channel sender authorization",
    "type": "security_ops",
    "domain": "communications",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/memory-md-quota-and-channel-auth.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 56,
    "capabilityId": "browser.background_task_auditability",
    "name": "Background task auditability",
    "type": "security_ops",
    "domain": "browser",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/background-run-reporting.test.ts",
      "scripts/verify-background-reporting.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 57,
    "capabilityId": "ai.moderations",
    "name": "Moderations",
    "type": "runtime",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/telemetry-cache-compaction.test.ts",
      "tests/multimodal-inference-and-moderation.test.ts",
      "tests/production-p01-security.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 58,
    "capabilityId": "system.image_generation",
    "name": "Image generation",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/a2a-capabilities-eval-and-dlq.test.ts",
      "tests/agent-api.test.ts",
      "tests/modality-bridge-image-editing-browser.test.ts",
      "tests/multimodal-inference-and-moderation.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 59,
    "capabilityId": "system.ocr",
    "name": "OCR",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/modality-bridge-image-editing-browser.test.ts",
      "tests/multimodal-inference-and-moderation.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 60,
    "capabilityId": "security.vision_bridge_guardrail",
    "name": "Vision bridge guardrail",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/vision-guardrail-oidc-and-remote-tokens.test.ts",
      "tests/production-p01-security.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 61,
    "capabilityId": "security.oidc_dashboard_gate",
    "name": "OIDC dashboard gate",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/vision-guardrail-oidc-and-remote-tokens.test.ts",
      "tests/production-p01-security.test.ts",
      "scripts/verify-production-oidc.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 62,
    "capabilityId": "security.scoped_remote_access_tokens",
    "name": "Scoped remote access tokens",
    "type": "runtime",
    "domain": "security",
    "agentCallable": false,
    "risk": "critical",
    "testType": "e2e",
    "testFiles": [
      "tests/vision-guardrail-oidc-and-remote-tokens.test.ts",
      "tests/production-p01-security.test.ts",
      "scripts/verify-production-api-key-auth.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 63,
    "capabilityId": "security.auto_reviewer_for_exec",
    "name": "Auto reviewer for exec",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "high",
    "testType": "integration",
    "testFiles": [
      "tests/auto-reviewer-and-fts-memory.test.ts",
      "tests/company-runtime.test.ts",
      "tests/production-wasm-exec.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 64,
    "capabilityId": "storage.embeddings",
    "name": "Embeddings",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/inference-and-memory-injection.test.ts",
      "tests/omniroute-embeddings-resilience.test.ts",
      "tests/production-p02-knowledge-memory.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 65,
    "capabilityId": "ai.rerank",
    "name": "Rerank",
    "type": "runtime",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/company-knowledge-hub-e2e.test.ts",
      "tests/inference-and-memory-injection.test.ts",
      "tests/memory-decay-rerank-and-journal.test.ts",
      "tests/production-p02-knowledge-memory.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 66,
    "capabilityId": "storage.persistent_conversational_memory",
    "name": "Persistent conversational memory",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 67,
    "capabilityId": "storage.memory_scoped_by_api_key",
    "name": "Memory scoped by API key",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "critical",
    "testType": "e2e",
    "testFiles": [
      "tests/production-scoped-memory.test.ts",
      "tests/scoped-memory-and-user-model.test.ts",
      "scripts/verify-production-scoped-memory.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 68,
    "capabilityId": "storage.optional_sessionid_scoping",
    "name": "Optional sessionId scoping",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/production-scoped-memory.test.ts",
      "scripts/verify-production-scoped-memory.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 69,
    "capabilityId": "storage.memory_injection",
    "name": "Memory injection",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/production-scoped-memory.test.ts",
      "tests/per-request-no-memory-and-rtk.test.ts",
      "scripts/verify-production-scoped-memory.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 70,
    "capabilityId": "research.vector_semantic_search",
    "name": "Vector semantic search",
    "type": "runtime",
    "domain": "research",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/company-hybrid-retrieval.test.ts",
      "tests/company-knowledge.test.ts",
      "scripts/verify-company-hybrid-retrieval.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 71,
    "capabilityId": "storage.hybrid_memory_retrieval",
    "name": "Hybrid memory retrieval",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "high",
    "testType": "e2e",
    "testFiles": [
      "tests/company-hybrid-retrieval.test.ts",
      "tests/company-knowledge.test.ts",
      "scripts/verify-company-hybrid-retrieval.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 72,
    "capabilityId": "system.context_compaction",
    "name": "Context compaction",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/admission-queue-and-conversation-memory.test.ts",
      "tests/telemetry-cache-compaction.test.ts",
      "tests/production-p02-knowledge-memory.test.ts",
      "scripts/verify-production-p02-knowledge-memory.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 73,
    "capabilityId": "storage.usermd_user_model",
    "name": "USER.md user model",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/inference-and-memory-injection.test.ts",
      "tests/scoped-memory-and-user-model.test.ts",
      "tests/production-memory-documents.test.ts",
      "scripts/verify-production-memory-documents.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 74,
    "capabilityId": "storage.memorymd_long-term_memory",
    "name": "MEMORY.md long-term memory",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/inference-and-memory-injection.test.ts",
      "tests/memory-md-quota-and-channel-auth.test.ts",
      "tests/production-memory-documents.test.ts",
      "scripts/verify-production-memory-documents.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 75,
    "capabilityId": "research.semantic_memory_search",
    "name": "Semantic memory search",
    "type": "runtime",
    "domain": "research",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/company-hybrid-retrieval.test.ts",
      "tests/company-knowledge.test.ts",
      "scripts/verify-company-hybrid-retrieval.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 76,
    "capabilityId": "research.hybrid_keyword_vector_search",
    "name": "Hybrid keyword + vector search",
    "type": "runtime",
    "domain": "research",
    "agentCallable": false,
    "risk": "critical",
    "testType": "e2e",
    "testFiles": [
      "tests/company-hybrid-retrieval.test.ts",
      "tests/company-knowledge.test.ts",
      "scripts/verify-company-hybrid-retrieval.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 77,
    "capabilityId": "storage.automatic_memory_flush",
    "name": "Automatic memory flush",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/durable-memory-features.test.ts",
      "scripts/verify-production-durable-memory-features.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 78,
    "capabilityId": "storage.automatic_memory_extraction",
    "name": "Automatic memory extraction",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/capability-registry.test.ts",
      "tests/production-p02-knowledge-memory.test.ts",
      "scripts/verify-production-p02-knowledge-memory.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 79,
    "capabilityId": "research.fts5_keyword_search",
    "name": "FTS5 keyword search",
    "type": "runtime",
    "domain": "research",
    "agentCallable": false,
    "risk": "critical",
    "testType": "e2e",
    "testFiles": [
      "tests/memory-engines-import-production.test.ts",
      "scripts/verify-production-memory-engines-import.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 80,
    "capabilityId": "storage.memory_rerank",
    "name": "Memory rerank",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/company-knowledge.test.ts",
      "tests/inference-and-memory-injection.test.ts",
      "tests/memory-decay-rerank-and-journal.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/production-p02-knowledge-memory.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 81,
    "capabilityId": "storage.typed_decay",
    "name": "Typed decay",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/durable-memory-features.test.ts",
      "scripts/verify-production-durable-memory-features.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 82,
    "capabilityId": "storage.per-request_no-memory",
    "name": "Per-request no-memory",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/action-sensitive-memory-and-compat-apis.test.ts",
      "tests/agent-api.test.ts",
      "tests/agent.test.ts",
      "tests/channel-groups-and-mentions.test.ts",
      "tests/company-runtime.test.ts",
      "tests/inference-and-memory-injection.test.ts",
      "tests/memory-decay-rerank-and-journal.test.ts",
      "tests/memory-md-quota-and-channel-auth.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/per-request-no-memory-and-rtk.test.ts",
      "tests/per-request-no-memory-production.test.ts",
      "tests/scoped-memory-and-user-model.test.ts",
      "tests/web-research.test.ts",
      "tests/workspace-store.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 83,
    "capabilityId": "storage.daily_memory_notes",
    "name": "Daily memory notes",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/durable-memory-features.test.ts",
      "scripts/verify-production-durable-memory-features.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 84,
    "capabilityId": "storage.memory_get",
    "name": "Memory get",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/company-tool-runtime.test.ts",
      "tests/company-runtime.test.ts",
      "scripts/verify-npati-004-e2e.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 85,
    "capabilityId": "storage.standing_intents",
    "name": "Standing intents",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/durable-memory-features.test.ts",
      "scripts/verify-production-durable-memory-features.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 86,
    "capabilityId": "storage.memory_wiki",
    "name": "Memory Wiki",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/advanced-memory-production.test.ts",
      "scripts/verify-production-advanced-memory.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 87,
    "capabilityId": "storage.dreaming",
    "name": "Dreaming",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/advanced-memory-production.test.ts",
      "scripts/verify-production-advanced-memory.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 88,
    "capabilityId": "storage.action-sensitive_memory",
    "name": "Action-sensitive memory",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/advanced-memory-production.test.ts",
      "scripts/verify-production-advanced-memory.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 89,
    "capabilityId": "system.format_translation",
    "name": "Format translation",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/pii-and-subagents.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 90,
    "capabilityId": "orchestration.autocoding",
    "name": "auto/coding",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/acp-claude-code-and-priority-routing.test.ts",
      "tests/auto-combo-profiles.test.ts",
      "tests/auto-fusion-pipeline-routing.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 91,
    "capabilityId": "orchestration.autofast",
    "name": "auto/fast",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/auto-combo-profiles.test.ts",
      "tests/auto-offline-lkgp-and-a2a.test.ts",
      "tests/auto-reviewer-and-fts-memory.test.ts",
      "tests/human-approvals.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 92,
    "capabilityId": "orchestration.autocheap",
    "name": "auto/cheap",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/auto-combo-profiles.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 93,
    "capabilityId": "orchestration.autooffline",
    "name": "auto/offline",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/auto-offline-lkgp-and-a2a.test.ts",
      "tests/web-research.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 94,
    "capabilityId": "orchestration.cost-optimized",
    "name": "cost-optimized",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/quota-share-transparency-session-dedup.test.ts",
      "tests/routing-strategies.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 95,
    "capabilityId": "orchestration.context-optimized",
    "name": "context-optimized",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/compression-presets-adaptive-budget.test.ts",
      "tests/routing-strategies.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 96,
    "capabilityId": "orchestration.cache-optimized",
    "name": "cache-optimized",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/quota-share-transparency-session-dedup.test.ts",
      "tests/routing-strategies.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 97,
    "capabilityId": "orchestration.lkgp",
    "name": "lkgp",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/auto-offline-lkgp-and-a2a.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 98,
    "capabilityId": "orchestration.auto_98",
    "name": "auto",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/acp-claude-code-and-priority-routing.test.ts",
      "tests/agent-api.test.ts",
      "tests/ai-preferences.test.ts",
      "tests/auto-combo-profiles.test.ts",
      "tests/auto-fusion-pipeline-routing.test.ts",
      "tests/auto-offline-lkgp-and-a2a.test.ts",
      "tests/auto-reviewer-and-fts-memory.test.ts",
      "tests/automation-flows-and-email.test.ts",
      "tests/automation-reminders-heartbeat-hooks.test.ts",
      "tests/automation-scheduler.test.ts",
      "tests/browser-tab-click-drag-automation.test.ts",
      "tests/company-runtime.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/output-styles-eval-and-cache.test.ts",
      "tests/versioning-xsearch-channel-plugins.test.ts",
      "tests/web-research.test.ts",
      "tests/workspace-store.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 99,
    "capabilityId": "orchestration.fusion",
    "name": "fusion",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/auto-fusion-pipeline-routing.test.ts",
      "tests/company-runtime.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 100,
    "capabilityId": "orchestration.pipeline",
    "name": "pipeline",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/auto-fusion-pipeline-routing.test.ts",
      "tests/channel-docking-and-hooks.test.ts",
      "tests/company-runtime.test.ts",
      "tests/inference-and-memory-injection.test.ts",
      "tests/memory-import-codemode-clawhub.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/radar-videogen-remote-cli.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 101,
    "capabilityId": "system.mcp_server",
    "name": "MCP server",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/integrations-and-security.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 102,
    "capabilityId": "system.mcp_scoped_permissions",
    "name": "MCP scoped permissions",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/background-jobs-and-mcp-server.test.ts",
      "tests/company-knowledge.test.ts",
      "tests/storage-protection.test.ts",
      "tests/production-mcp-policy.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 103,
    "capabilityId": "orchestration.a2a_protocol_v03",
    "name": "A2A protocol v0.3",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/auto-offline-lkgp-and-a2a.test.ts",
      "tests/pii-and-subagents.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 104,
    "capabilityId": "orchestration.a2a_smart_routing",
    "name": "A2A: Smart Routing",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/capability-registry.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 105,
    "capabilityId": "orchestration.a2a_health_report",
    "name": "A2A: Health Report",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/capability-registry.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 106,
    "capabilityId": "system.omniconductor",
    "name": "OmniConductor",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/a2a-smart-conductor.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 107,
    "capabilityId": "system.skills_framework",
    "name": "Skills framework",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 108,
    "capabilityId": "security.per-agent_model_choice",
    "name": "Per-agent model choice",
    "type": "configuration",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/multi-agent-messaging.test.ts",
      "tests/p2c-least-used-random-routing.test.ts",
      "tests/sandboxing-and-format-translation.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 109,
    "capabilityId": "orchestration.multi-agent_routing",
    "name": "Multi-agent routing",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/a2a-smart-conductor.test.ts",
      "tests/auto-fusion-pipeline-routing.test.ts",
      "tests/network-tproxy-and-bifrost-mux.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 110,
    "capabilityId": "system.sub-agents",
    "name": "Sub-agents",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 111,
    "capabilityId": "system.parallel_sub-agents",
    "name": "Parallel sub-agents",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/a2a-smart-conductor.test.ts",
      "tests/company-runtime.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 112,
    "capabilityId": "system.isolated_vs_forked_context",
    "name": "Isolated vs forked context",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 113,
    "capabilityId": "system.agent_send_session_messaging",
    "name": "Agent send / session messaging",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/multi-agent-messaging.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 114,
    "capabilityId": "system.background_completion_reporting",
    "name": "Background completion reporting",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/background-run-reporting.test.ts",
      "tests/background-jobs-and-context-safety.test.ts",
      "scripts/verify-background-reporting.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 115,
    "capabilityId": "system.skills",
    "name": "Skills",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 116,
    "capabilityId": "system.mcp_server_116",
    "name": "MCP server",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/integrations-and-security.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 117,
    "capabilityId": "system.mcp_client_registry",
    "name": "MCP client registry",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "high",
    "testType": "unit",
    "testFiles": [
      "tests/integrations-and-security.test.ts",
      "tests/memory-import-codemode-clawhub.test.ts",
      "tests/workspace-store.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 118,
    "capabilityId": "system.anthropic_messages_api",
    "name": "Anthropic Messages API",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/action-sensitive-memory-and-compat-apis.test.ts",
      "tests/admission-queue-and-conversation-memory.test.ts",
      "tests/cache-savings-backups-session-search.test.ts",
      "tests/multi-agent-messaging.test.ts",
      "tests/quota-share-transparency-session-dedup.test.ts",
      "tests/sandboxing-and-format-translation.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 119,
    "capabilityId": "system.gemini-compatible_api",
    "name": "Gemini-compatible API",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/pii-and-subagents.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 120,
    "capabilityId": "security.a2a_quota_management",
    "name": "A2A: Quota Management",
    "type": "orchestration",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 121,
    "capabilityId": "orchestration.a2a_provider_discovery",
    "name": "A2A: Provider Discovery",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 122,
    "capabilityId": "orchestration.a2a_cost_analysis",
    "name": "A2A: Cost Analysis",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 123,
    "capabilityId": "orchestration.a2a_list_capabilities",
    "name": "A2A: List Capabilities",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 124,
    "capabilityId": "system.evaluation_framework",
    "name": "Evaluation framework",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "high",
    "testType": "unit",
    "testFiles": [
      "tests/a2a-capabilities-eval-and-dlq.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 125,
    "capabilityId": "system.nested_sub-agents",
    "name": "Nested sub-agents",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/telemetry-cache-compaction.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 126,
    "capabilityId": "business.goal_management",
    "name": "Goal management",
    "type": "orchestration",
    "domain": "business",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 127,
    "capabilityId": "system.swarm",
    "name": "Swarm",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/swarm-audio-translation-video.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 128,
    "capabilityId": "system.webhooks",
    "name": "Webhooks",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/integrations-and-security.test.ts",
      "tests/webhooks-documents-and-plugins.test.ts",
      "tests/production-p13-automations.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 129,
    "capabilityId": "system.automations_scheduler",
    "name": "Automations scheduler",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/automation-scheduler.test.ts",
      "tests/production-p13-automations.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 130,
    "capabilityId": "system.cron_jobs",
    "name": "Cron jobs",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/production-p13-automations.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 131,
    "capabilityId": "system.background_tasks_ledger",
    "name": "Background Tasks ledger",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/production-p13-automations.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 132,
    "capabilityId": "system.task_audit",
    "name": "Task audit",
    "type": "security_ops",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/company-runtime.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 133,
    "capabilityId": "system.task_flow",
    "name": "Task Flow",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/a2a-smart-conductor.test.ts",
      "tests/automation-flows-and-email.test.ts",
      "tests/company-runtime.test.ts",
      "tests/production-p13-automations.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 134,
    "capabilityId": "system.standing_orders",
    "name": "Standing Orders",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/automation-flows-and-email.test.ts",
      "tests/production-p13-automations.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 135,
    "capabilityId": "system.webhooks_ingress",
    "name": "Webhooks ingress",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/integrations-and-security.test.ts",
      "tests/production-p13-automations.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 136,
    "capabilityId": "communications.imap_email_trigger",
    "name": "IMAP email trigger",
    "type": "tool",
    "domain": "communications",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/automation-flows-and-email.test.ts",
      "tests/production-p13-automations.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 137,
    "capabilityId": "system.webhook_retries",
    "name": "Webhook retries",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/a2a-capabilities-eval-and-dlq.test.ts",
      "tests/production-p13-automations.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 138,
    "capabilityId": "system.one-shot_reminders",
    "name": "One-shot reminders",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/automation-reminders-heartbeat-hooks.test.ts",
      "tests/production-p13-automations.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 139,
    "capabilityId": "system.heartbeat",
    "name": "Heartbeat",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/a2a-smart-conductor.test.ts",
      "tests/automation-reminders-heartbeat-hooks.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 140,
    "capabilityId": "system.lifecycle_hooks",
    "name": "Lifecycle hooks",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/automation-reminders-heartbeat-hooks.test.ts",
      "tests/background-jobs-and-mcp-server.test.ts",
      "tests/channel-docking-and-hooks.test.ts",
      "tests/webhooks-documents-and-plugins.test.ts",
      "tests/production-p13-automations.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 141,
    "capabilityId": "communications.image_understanding",
    "name": "Image understanding",
    "type": "tool",
    "domain": "communications",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 142,
    "capabilityId": "files.document_inputoutput",
    "name": "Document input/output",
    "type": "tool",
    "domain": "files",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/a2a-quota-discovery-and-cost.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/webhooks-documents-and-plugins.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 143,
    "capabilityId": "system.modality_bridge",
    "name": "Modality bridge",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/modality-bridge-image-editing-browser.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 144,
    "capabilityId": "communications.audio_understanding",
    "name": "Audio understanding",
    "type": "tool",
    "domain": "communications",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/swarm-audio-translation-video.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 145,
    "capabilityId": "communications.image_generationediting",
    "name": "Image generation/editing",
    "type": "tool",
    "domain": "communications",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/modality-bridge-image-editing-browser.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 146,
    "capabilityId": "communications.voice-note_transcription",
    "name": "Voice-note transcription",
    "type": "runtime",
    "domain": "communications",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 147,
    "capabilityId": "communications.audio_translation",
    "name": "Audio translation",
    "type": "tool",
    "domain": "communications",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/swarm-audio-translation-video.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 148,
    "capabilityId": "communications.video_understanding",
    "name": "Video understanding",
    "type": "tool",
    "domain": "communications",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/swarm-audio-translation-video.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 149,
    "capabilityId": "browser.managed_browser_profile",
    "name": "Managed browser profile",
    "type": "runtime",
    "domain": "browser",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/modality-bridge-image-editing-browser.test.ts",
      "tests/production-p11-browser-automation.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 150,
    "capabilityId": "browser.browser_tab_control",
    "name": "Browser tab control",
    "type": "tool",
    "domain": "browser",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/browser-tab-click-drag-automation.test.ts",
      "tests/tools-exec-process-search.test.ts",
      "tests/production-p11-browser-automation.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 151,
    "capabilityId": "browser.browser_clicktype",
    "name": "Browser click/type",
    "type": "tool",
    "domain": "browser",
    "agentCallable": true,
    "risk": "high",
    "testType": "integration",
    "testFiles": [
      "tests/browser-tab-click-drag-automation.test.ts",
      "tests/production-p11-browser-automation.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 152,
    "capabilityId": "browser.browser_dragselect",
    "name": "Browser drag/select",
    "type": "runtime",
    "domain": "browser",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/browser-tab-click-drag-automation.test.ts",
      "tests/production-p11-browser-automation.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 153,
    "capabilityId": "browser.browser_snapshots",
    "name": "Browser snapshots",
    "type": "runtime",
    "domain": "browser",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/capability-registry.test.ts",
      "tests/production-p11-browser-automation.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 154,
    "capabilityId": "browser.browser_screenshots",
    "name": "Browser screenshots",
    "type": "tool",
    "domain": "browser",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/browser-dom-screenshot-and-pdf.test.ts",
      "tests/production-p11-browser-automation.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 155,
    "capabilityId": "browser.browser_pdf_capture",
    "name": "Browser PDF capture",
    "type": "tool",
    "domain": "browser",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/browser-dom-screenshot-and-pdf.test.ts",
      "tests/tools-exec-process-search.test.ts",
      "tests/production-p11-browser-automation.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 156,
    "capabilityId": "browser.browser_downloads",
    "name": "Browser downloads",
    "type": "tool",
    "domain": "browser",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/browser-downloads-multiprofile-cdp.test.ts",
      "tests/production-p11-browser-automation.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 157,
    "capabilityId": "browser.multi-profile_browser",
    "name": "Multi-profile browser",
    "type": "runtime",
    "domain": "browser",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/browser-downloads-multiprofile-cdp.test.ts",
      "tests/modality-bridge-image-editing-browser.test.ts",
      "tests/production-p11-browser-automation.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 158,
    "capabilityId": "browser.attach_real_chrome",
    "name": "Attach real Chrome",
    "type": "runtime",
    "domain": "browser",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/browser-downloads-multiprofile-cdp.test.ts",
      "tests/production-p11-browser-automation.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 159,
    "capabilityId": "security.exec",
    "name": "Exec",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "high",
    "testType": "integration",
    "testFiles": [
      "tests/auto-reviewer-and-fts-memory.test.ts",
      "tests/automation-scheduler.test.ts",
      "tests/human-approvals.test.ts",
      "tests/memory-import-codemode-clawhub.test.ts",
      "tests/tools-exec-process-search.test.ts",
      "tests/production-wasm-exec.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 160,
    "capabilityId": "security.process_control",
    "name": "Process control",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/memory-import-codemode-clawhub.test.ts",
      "tests/tools-exec-process-search.test.ts",
      "tests/production-wasm-exec.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 161,
    "capabilityId": "research.tool_search",
    "name": "Tool Search",
    "type": "security_ops",
    "domain": "research",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/a2a-capabilities-eval-and-dlq.test.ts",
      "tests/agent-api.test.ts",
      "tests/agent.test.ts",
      "tests/company-runtime.test.ts",
      "tests/group-sessions-and-tool-policy.test.ts",
      "tests/memory-import-codemode-clawhub.test.ts",
      "tests/multi-user-dm-pairing-subagents.test.ts",
      "tests/tools-exec-process-search.test.ts",
      "tests/workspace-store.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 162,
    "capabilityId": "files.file_tools",
    "name": "File tools",
    "type": "security_ops",
    "domain": "files",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/agent-api.test.ts",
      "tests/browser-downloads-multiprofile-cdp.test.ts",
      "tests/company-tool-runtime.test.ts",
      "tests/file-tools-and-coding-cli.test.ts",
      "tests/multi-user-dm-pairing-subagents.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 163,
    "capabilityId": "system.coding_cli_gateway",
    "name": "Coding CLI gateway",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "high",
    "testType": "integration",
    "testFiles": [
      "tests/file-tools-and-coding-cli.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 164,
    "capabilityId": "ai.omniroute_run",
    "name": "omniroute run",
    "type": "orchestration",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 165,
    "capabilityId": "ai.cloud-agent_providers",
    "name": "Cloud-agent providers",
    "type": "runtime",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 166,
    "capabilityId": "security.oauth_subscription_auth",
    "name": "OAuth subscription auth",
    "type": "configuration",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/cloud-agents-oauth-and-codex.test.ts",
      "tests/webhooks-documents-and-plugins.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 167,
    "capabilityId": "system.native_codex_runtime",
    "name": "Native Codex runtime",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/cloud-agents-oauth-and-codex.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 168,
    "capabilityId": "system.acp_sessions",
    "name": "ACP sessions",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/acp-claude-code-and-priority-routing.test.ts",
      "tests/cli-configure-and-acp-editors.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 169,
    "capabilityId": "system.claude_code_via_acp",
    "name": "Claude Code via ACP",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/a2a-quota-discovery-and-cost.test.ts",
      "tests/acp-claude-code-and-priority-routing.test.ts",
      "tests/action-sensitive-memory-and-compat-apis.test.ts",
      "tests/ai-marketplace-normalization.test.ts",
      "tests/auto-combo-profiles.test.ts",
      "tests/auto-fusion-pipeline-routing.test.ts",
      "tests/modality-bridge-image-editing-browser.test.ts",
      "tests/multi-agent-messaging.test.ts",
      "tests/radar-videogen-remote-cli.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 170,
    "capabilityId": "ai.omniroute_configure",
    "name": "omniroute configure",
    "type": "configuration",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/agent-api.test.ts",
      "tests/agent.test.ts",
      "tests/cli-configure-and-acp-editors.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/web-research.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 171,
    "capabilityId": "system.cursor_via_acp",
    "name": "Cursor via ACP",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/cli-configure-and-acp-editors.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 172,
    "capabilityId": "system.github_copilot_via_acp",
    "name": "GitHub Copilot via ACP",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/cli-configure-and-acp-editors.test.ts",
      "tests/cloud-agents-oauth-and-codex.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 173,
    "capabilityId": "system.gemini_cli_via_acp",
    "name": "Gemini CLI via ACP",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "high",
    "testType": "integration",
    "testFiles": [
      "tests/acp-harnesses-and-drivers.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 174,
    "capabilityId": "system.opencode_via_acp",
    "name": "OpenCode via ACP",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/acp-harnesses-and-drivers.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 175,
    "capabilityId": "system.other_acp_harnesses",
    "name": "Other ACP harnesses",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/acp-harnesses-and-drivers.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 176,
    "capabilityId": "system.semantic_cache",
    "name": "Semantic cache",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/telemetry-cache-compaction.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 177,
    "capabilityId": "orchestration.priority",
    "name": "priority",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/acp-claude-code-and-priority-routing.test.ts",
      "tests/admission-queue-and-conversation-memory.test.ts",
      "tests/agent.test.ts",
      "tests/automation-reminders-heartbeat-hooks.test.ts",
      "tests/channel-docking-and-hooks.test.ts",
      "tests/company-runtime.test.ts",
      "tests/group-sessions-and-tool-policy.test.ts",
      "tests/multi-user-dm-pairing-subagents.test.ts",
      "tests/workspace-store.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 178,
    "capabilityId": "orchestration.fill-first",
    "name": "fill-first",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/fill-first-weighted-round-robin.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 179,
    "capabilityId": "orchestration.weighted",
    "name": "weighted",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/fill-first-weighted-round-robin.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 180,
    "capabilityId": "orchestration.round-robin",
    "name": "round-robin",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/fill-first-weighted-round-robin.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 181,
    "capabilityId": "orchestration.p2c",
    "name": "p2c",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/p2c-least-used-random-routing.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 182,
    "capabilityId": "orchestration.least-used",
    "name": "least-used",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/p2c-least-used-random-routing.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 183,
    "capabilityId": "browser.random",
    "name": "random",
    "type": "orchestration",
    "domain": "browser",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/chat-file-service.test.ts",
      "tests/p2c-least-used-random-routing.test.ts",
      "tests/pgvector-benchmark.test.ts",
      "tests/storage-protection.test.ts",
      "tests/strict-random-headroom-reset-window.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 184,
    "capabilityId": "browser.strict-random",
    "name": "strict-random",
    "type": "orchestration",
    "domain": "browser",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/channel-groups-and-mentions.test.ts",
      "tests/p2c-least-used-random-routing.test.ts",
      "tests/strict-random-headroom-reset-window.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 185,
    "capabilityId": "orchestration.headroom",
    "name": "headroom",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/compression-lite-tool-headroom.test.ts",
      "tests/strict-random-headroom-reset-window.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 186,
    "capabilityId": "orchestration.reset-window",
    "name": "reset-window",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/reset-aware-context-relay-rolling-leases.test.ts",
      "tests/strict-random-headroom-reset-window.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 187,
    "capabilityId": "orchestration.reset-aware",
    "name": "reset-aware",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/reset-aware-context-relay-rolling-leases.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 188,
    "capabilityId": "orchestration.context-relay",
    "name": "context-relay",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/reset-aware-context-relay-rolling-leases.test.ts",
      "tests/production-p14-orchestration-a2a.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 189,
    "capabilityId": "system.atomic_rpm_rolling_leases",
    "name": "Atomic RPM rolling leases",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/reset-aware-context-relay-rolling-leases.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 190,
    "capabilityId": "security.quota-share_routing",
    "name": "Quota-Share routing",
    "type": "runtime",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/quota-share-transparency-session-dedup.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 191,
    "capabilityId": "orchestration.routing_transparency",
    "name": "Routing transparency",
    "type": "runtime",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/company-runtime.test.ts",
      "scripts/verify-unified-telemetry.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 192,
    "capabilityId": "system.session-dedup",
    "name": "Session-Dedup",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/distributed-session-registry.test.ts",
      "tests/session-stream-routes.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 193,
    "capabilityId": "system.rtk",
    "name": "RTK",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/per-request-no-memory-and-rtk.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 194,
    "capabilityId": "system.relevance",
    "name": "Relevance",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/relevance-aggressive-llmlingua2-compression.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 195,
    "capabilityId": "system.aggressive",
    "name": "Aggressive",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/relevance-aggressive-llmlingua2-compression.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 196,
    "capabilityId": "system.llmlingua-2",
    "name": "LLMLingua-2",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/relevance-aggressive-llmlingua2-compression.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 197,
    "capabilityId": "system.compression_presets",
    "name": "Compression presets",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/compression-presets-adaptive-budget.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 198,
    "capabilityId": "system.adaptive_context_budget",
    "name": "Adaptive context budget",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/compression-presets-adaptive-budget.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 199,
    "capabilityId": "system.per-request_compression_override",
    "name": "Per-request compression override",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/compression-presets-adaptive-budget.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 200,
    "capabilityId": "system.output_styles",
    "name": "Output Styles",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/output-styles-eval-and-cache.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 201,
    "capabilityId": "system.compression_eval_harness",
    "name": "Compression eval harness",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "high",
    "testType": "unit",
    "testFiles": [
      "tests/output-styles-eval-and-cache.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 202,
    "capabilityId": "system.cache_stats_flush",
    "name": "Cache stats / flush",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/output-styles-eval-and-cache.test.ts",
      "tests/telemetry-cache-compaction.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 203,
    "capabilityId": "system.cache-hit_savings_telemetry",
    "name": "Cache-hit savings telemetry",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/audit-and-usage-analytics.test.ts",
      "scripts/verify-unified-telemetry.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 204,
    "capabilityId": "ai.model_catalog_sync",
    "name": "Model catalog sync",
    "type": "configuration",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts",
      "tests/omniroute-marketplace-client.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 205,
    "capabilityId": "browser.database_backups",
    "name": "Database backups",
    "type": "runtime",
    "domain": "browser",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/cache-savings-backups-session-search.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 206,
    "capabilityId": "system.control_ui",
    "name": "Control UI",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 207,
    "capabilityId": "research.session_search",
    "name": "Session search",
    "type": "runtime",
    "domain": "research",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/cache-savings-backups-session-search.test.ts",
      "tests/group-sessions-and-tool-policy.test.ts",
      "tests/mobile-chat-voice-camera.test.ts",
      "tests/multi-user-dm-pairing-subagents.test.ts",
      "tests/scoped-memory-and-user-model.test.ts",
      "tests/web-research.test.ts",
      "tests/workspace-store.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 208,
    "capabilityId": "system.session_pruning",
    "name": "Session pruning",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/sessions-custom-models-chunking.test.ts",
      "tests/production-p03-reliability-scale.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 209,
    "capabilityId": "security.customself-hosted_models",
    "name": "Custom/self-hosted models",
    "type": "configuration",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/sessions-custom-models-chunking.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 210,
    "capabilityId": "system.free-tier_catalog",
    "name": "Free-tier catalog",
    "type": "configuration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/freetier-dedicated-routes-and-ccr.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 211,
    "capabilityId": "ai.dedicated_provider_routes",
    "name": "Dedicated provider routes",
    "type": "runtime",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/audit-and-usage-analytics.test.ts",
      "tests/freetier-dedicated-routes-and-ccr.test.ts",
      "tests/telemetry-cache-compaction.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 212,
    "capabilityId": "system.ccr",
    "name": "CCR",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/freetier-dedicated-routes-and-ccr.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 213,
    "capabilityId": "system.lite",
    "name": "Lite",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/compression-lite-tool-headroom.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 214,
    "capabilityId": "system.responses_tool_output",
    "name": "Responses Tool Output",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/compression-lite-tool-headroom.test.ts",
      "tests/sandboxing-and-format-translation.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 215,
    "capabilityId": "system.headroom",
    "name": "Headroom",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/compression-lite-tool-headroom.test.ts",
      "tests/strict-random-headroom-reset-window.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 216,
    "capabilityId": "system.caveman",
    "name": "Caveman",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/compression-caveman-ultra-omniglyph.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 217,
    "capabilityId": "system.ultra",
    "name": "Ultra",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/audit-and-usage-analytics.test.ts",
      "tests/compression-caveman-ultra-omniglyph.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 218,
    "capabilityId": "system.omniglyph",
    "name": "OmniGlyph",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/compression-caveman-ultra-omniglyph.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 219,
    "capabilityId": "storage.qdrant_support",
    "name": "Qdrant support",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/advanced-memory-production.test.ts",
      "scripts/verify-production-advanced-memory.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 220,
    "capabilityId": "storage.int8_vector_quantization",
    "name": "int8 vector quantization",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/memory-engines-import-production.test.ts",
      "scripts/verify-production-memory-engines-import.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 221,
    "capabilityId": "system.device_tracking_per_api_key",
    "name": "Device tracking per API key",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "critical",
    "testType": "e2e",
    "testFiles": [
      "tests/production-p01-security.test.ts",
      "tests/security-auth-vault-scopes.test.ts",
      "scripts/verify-production-api-key-auth.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 222,
    "capabilityId": "system.version_manager",
    "name": "Version manager",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/auto-offline-lkgp-and-a2a.test.ts",
      "tests/browser-downloads-multiprofile-cdp.test.ts",
      "tests/channel-groups-and-mentions.test.ts",
      "tests/companion-and-mobile-pairing.test.ts",
      "tests/versioning-xsearch-channel-plugins.test.ts",
      "tests/webhooks-documents-and-plugins.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 223,
    "capabilityId": "system.plugins",
    "name": "Plugins",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/channel-groups-and-mentions.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 224,
    "capabilityId": "system.response_chunking",
    "name": "Response chunking",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/sessions-custom-models-chunking.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/agent-api.test.ts",
      "tests/web-chat-stream-client.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 225,
    "capabilityId": "communications.channel_docking_thread_binding",
    "name": "Channel docking / thread binding",
    "type": "runtime",
    "domain": "communications",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/channel-docking-and-hooks.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 226,
    "capabilityId": "system.plugin_hooks",
    "name": "Plugin hooks",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/channel-docking-and-hooks.test.ts",
      "tests/webhooks-documents-and-plugins.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 227,
    "capabilityId": "system.internal_hooks",
    "name": "Internal hooks",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/channel-docking-and-hooks.test.ts",
      "tests/integrations-and-security.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 228,
    "capabilityId": "communications.telegram",
    "name": "Telegram",
    "type": "tool",
    "domain": "communications",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/multi-user-dm-pairing-subagents.test.ts",
      "tests/telegram-ollama-tts.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 229,
    "capabilityId": "research.x_search",
    "name": "X search",
    "type": "tool",
    "domain": "research",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/versioning-xsearch-channel-plugins.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 230,
    "capabilityId": "communications.official_channel_plugins",
    "name": "Official channel plugins",
    "type": "runtime",
    "domain": "communications",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/versioning-xsearch-channel-plugins.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 231,
    "capabilityId": "communications.external_channel_plugins",
    "name": "External channel plugins",
    "type": "runtime",
    "domain": "communications",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/channel-groups-and-mentions.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 232,
    "capabilityId": "communications.group_chat",
    "name": "Group chat",
    "type": "orchestration",
    "domain": "communications",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/channel-docking-and-hooks.test.ts",
      "tests/channel-groups-and-mentions.test.ts",
      "tests/telegram-ollama-tts.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 233,
    "capabilityId": "communications.mention_activation",
    "name": "Mention activation",
    "type": "orchestration",
    "domain": "communications",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/channel-groups-and-mentions.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 234,
    "capabilityId": "ai.omniroute_radar",
    "name": "OmniRoute Radar",
    "type": "runtime",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/memory-import-codemode-clawhub.test.ts",
      "tests/radar-videogen-remote-cli.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 235,
    "capabilityId": "system.video_generation",
    "name": "Video generation",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/radar-videogen-remote-cli.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 236,
    "capabilityId": "system.remote_cli_contexts",
    "name": "Remote CLI contexts",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "high",
    "testType": "unit",
    "testFiles": [
      "tests/radar-videogen-remote-cli.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 237,
    "capabilityId": "system.mitm_tproxy",
    "name": "MITM / TPROXY",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/network-tproxy-and-bifrost-mux.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 238,
    "capabilityId": "system.proxy_system",
    "name": "Proxy system",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/network-tproxy-and-bifrost-mux.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 239,
    "capabilityId": "system.embedded_bifrost_mux",
    "name": "Embedded Bifrost & Mux",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/network-tproxy-and-bifrost-mux.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 240,
    "capabilityId": "system.relay_deployers",
    "name": "Relay deployers",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/infrastructure-deployers-and-memory-engines.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 241,
    "capabilityId": "system.docker_podman_bun_nix",
    "name": "Docker / Podman / Bun / Nix",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/infrastructure-deployers-and-memory-engines.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 242,
    "capabilityId": "storage.multiple_memory_engines",
    "name": "Multiple memory engines",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/memory-engines-import-production.test.ts",
      "scripts/verify-production-memory-engines-import.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 243,
    "capabilityId": "storage.memory_import",
    "name": "Memory import",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/memory-engines-import-production.test.ts",
      "scripts/verify-production-memory-engines-import.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 244,
    "capabilityId": "security.code_mode",
    "name": "Code Mode",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/a2a-quota-discovery-and-cost.test.ts",
      "tests/acp-claude-code-and-priority-routing.test.ts",
      "tests/acp-harnesses-and-drivers.test.ts",
      "tests/action-sensitive-memory-and-compat-apis.test.ts",
      "tests/agent-api.test.ts",
      "tests/ai-marketplace-normalization.test.ts",
      "tests/auto-combo-profiles.test.ts",
      "tests/auto-fusion-pipeline-routing.test.ts",
      "tests/company-runtime.test.ts",
      "tests/memory-import-codemode-clawhub.test.ts",
      "tests/mobile-chat-voice-camera.test.ts",
      "tests/modality-bridge-image-editing-browser.test.ts",
      "tests/multi-agent-messaging.test.ts",
      "tests/omniroute-adapter.test.ts",
      "tests/omniroute-marketplace-client.test.ts",
      "tests/radar-videogen-remote-cli.test.ts",
      "tests/sandboxing-and-format-translation.test.ts",
      "tests/scoped-memory-and-user-model.test.ts",
      "tests/web-research.test.ts",
      "tests/production-wasm-exec.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 245,
    "capabilityId": "system.clawhub",
    "name": "ClawHub",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/memory-import-codemode-clawhub.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 246,
    "capabilityId": "communications.video_generation",
    "name": "Video generation",
    "type": "runtime",
    "domain": "communications",
    "agentCallable": false,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/radar-videogen-remote-cli.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 247,
    "capabilityId": "communications.music_generation",
    "name": "Music generation",
    "type": "tool",
    "domain": "communications",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/voice-music-and-calls.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 248,
    "capabilityId": "communications.talk_realtime_speech",
    "name": "Talk / realtime speech",
    "type": "tool",
    "domain": "communications",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/voice-music-and-calls.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 249,
    "capabilityId": "communications.voice_call",
    "name": "Voice Call",
    "type": "tool",
    "domain": "communications",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/voice-music-and-calls.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 250,
    "capabilityId": "system.macos_companion",
    "name": "macOS companion",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/companion-and-mobile-pairing.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 251,
    "capabilityId": "system.ios_node_pairing",
    "name": "iOS node pairing",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/companion-and-mobile-pairing.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 252,
    "capabilityId": "system.android_node_pairing",
    "name": "Android node pairing",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/companion-and-mobile-pairing.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 253,
    "capabilityId": "system.mobile_chat",
    "name": "Mobile chat",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/mobile-chat-voice-camera.test.ts",
      "tests/oauth-tokens-and-route-tiers.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 254,
    "capabilityId": "communications.mobile_voice",
    "name": "Mobile voice",
    "type": "tool",
    "domain": "communications",
    "agentCallable": true,
    "risk": "medium",
    "testType": "integration",
    "testFiles": [
      "tests/mobile-chat-voice-camera.test.ts",
      "tests/production-p12-multimodal.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 255,
    "capabilityId": "system.camera_access",
    "name": "Camera access",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/mobile-chat-voice-camera.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 256,
    "capabilityId": "system.screen_recording",
    "name": "Screen recording",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/device-screen-location-commands.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 257,
    "capabilityId": "system.location_access",
    "name": "Location access",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/device-screen-location-commands.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 258,
    "capabilityId": "system.device_commands",
    "name": "Device commands",
    "type": "tool",
    "domain": "system",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/device-screen-location-commands.test.ts"
    ],
    "status": "NOT_IMPLEMENTED"
  },
  {
    "id": 259,
    "capabilityId": "system.linux_companion_inline_media",
    "name": "Linux companion / inline media",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/linux-companion-and-inline-media.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 260,
    "capabilityId": "security.tenant-scoped_ai_modelrouting_preference",
    "name": "Tenant-scoped AI model/routing preferences",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/capability-registry.test.ts",
      "tests/ai-preferences.test.ts",
      "tests/production-p01-security.test.ts",
      "scripts/verify-production-api-key-auth.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 261,
    "capabilityId": "browser.business_company_separation_separate_com",
    "name": "Business / Company separation + separate companies table",
    "type": "runtime",
    "domain": "browser",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 262,
    "capabilityId": "business.company_context_fields",
    "name": "Company context fields",
    "type": "runtime",
    "domain": "business",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/agent-api.test.ts",
      "tests/integrations-and-security.test.ts",
      "tests/pii-and-subagents.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 263,
    "capabilityId": "files.company_knowledge_documents_memory",
    "name": "Company knowledge / documents / memory",
    "type": "runtime",
    "domain": "files",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/company-knowledge-ui.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 264,
    "capabilityId": "system.extensible_agent_definitions_crud",
    "name": "Extensible Agent definitions + CRUD",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 265,
    "capabilityId": "system.agent_role_instructions_enabled_state",
    "name": "Agent role + instructions + enabled state",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 266,
    "capabilityId": "ai.per-agent_model_fallback_auto",
    "name": "Per-agent model + fallback + Auto",
    "type": "runtime",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/agent-api.test.ts",
      "tests/ai-preferences.test.ts",
      "tests/auto-combo-profiles.test.ts",
      "tests/auto-offline-lkgp-and-a2a.test.ts",
      "tests/company-runtime.test.ts",
      "tests/scoped-memory-and-user-model.test.ts",
      "tests/workspace-store.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 267,
    "capabilityId": "system.per-agent_tool_allowlist",
    "name": "Per-agent tool allowlist",
    "type": "configuration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/multi-user-dm-pairing-subagents.test.ts",
      "tests/vision-guardrail-oidc-and-remote-tokens.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 268,
    "capabilityId": "orchestration.manager_delegation_a2a_pipeline_fusion",
    "name": "Manager delegation через A2A / Pipeline / Fusion",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 269,
    "capabilityId": "business.company_agents_models_cards_responsive_g",
    "name": "Company / Agents / Models cards у responsive grid",
    "type": "configuration",
    "domain": "business",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 270,
    "capabilityId": "business.business_company_separation",
    "name": "Business / Company separation",
    "type": "runtime",
    "domain": "business",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 271,
    "capabilityId": "browser.companies_table",
    "name": "companies table",
    "type": "runtime",
    "domain": "browser",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/agent-api.test.ts",
      "tests/web-research.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 272,
    "capabilityId": "browser.company_agents_table",
    "name": "company_agents table",
    "type": "runtime",
    "domain": "browser",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/agent-api.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 273,
    "capabilityId": "browser.company_agent_edges",
    "name": "company_agent_edges",
    "type": "runtime",
    "domain": "browser",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/agent-api.test.ts",
      "tests/workspace-store.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 274,
    "capabilityId": "business.separate_company_page",
    "name": "Separate Company page",
    "type": "configuration",
    "domain": "business",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/agent-api.test.ts",
      "tests/workspace-store.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 275,
    "capabilityId": "business.visual_agent_org_chart",
    "name": "Visual Agent Org Chart",
    "type": "configuration",
    "domain": "business",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 276,
    "capabilityId": "system.agent_editor",
    "name": "Agent Editor",
    "type": "configuration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/acp-harnesses-and-drivers.test.ts",
      "tests/cli-configure-and-acp-editors.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 277,
    "capabilityId": "system.main_agent_configuration",
    "name": "Main Agent configuration",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/agent-api.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 278,
    "capabilityId": "ai.per-agent_model",
    "name": "Per-agent Model",
    "type": "runtime",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/a2a-quota-discovery-and-cost.test.ts",
      "tests/acp-claude-code-and-priority-routing.test.ts",
      "tests/acp-harnesses-and-drivers.test.ts",
      "tests/action-sensitive-memory-and-compat-apis.test.ts",
      "tests/admission-queue-and-conversation-memory.test.ts",
      "tests/agent-api.test.ts",
      "tests/agent.test.ts",
      "tests/ai-preferences.test.ts",
      "tests/audit-and-usage-analytics.test.ts",
      "tests/auto-combo-profiles.test.ts",
      "tests/auto-fusion-pipeline-routing.test.ts",
      "tests/auto-offline-lkgp-and-a2a.test.ts",
      "tests/background-jobs-and-mcp-server.test.ts",
      "tests/browser-tab-click-drag-automation.test.ts",
      "tests/cache-savings-backups-session-search.test.ts",
      "tests/company-knowledge-concurrency.test.ts",
      "tests/company-knowledge.test.ts",
      "tests/company-runtime.test.ts",
      "tests/fill-first-weighted-round-robin.test.ts",
      "tests/freetier-dedicated-routes-and-ccr.test.ts",
      "tests/inference-and-memory-injection.test.ts",
      "tests/modality-bridge-image-editing-browser.test.ts",
      "tests/multi-agent-messaging.test.ts",
      "tests/network-tproxy-and-bifrost-mux.test.ts",
      "tests/p2c-least-used-random-routing.test.ts",
      "tests/quota-share-transparency-session-dedup.test.ts",
      "tests/radar-videogen-remote-cli.test.ts",
      "tests/reset-aware-context-relay-rolling-leases.test.ts",
      "tests/routing-strategies.test.ts",
      "tests/sandboxing-and-format-translation.test.ts",
      "tests/scoped-memory-and-user-model.test.ts",
      "tests/sessions-custom-models-chunking.test.ts",
      "tests/strict-random-headroom-reset-window.test.ts",
      "tests/telegram-ollama-tts.test.ts",
      "tests/telemetry-cache-compaction.test.ts",
      "tests/workspace-store.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 279,
    "capabilityId": "ai.per-agent_fallback_model",
    "name": "Per-agent Fallback Model",
    "type": "runtime",
    "domain": "ai",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/agent-api.test.ts",
      "tests/ai-preferences.test.ts",
      "tests/auto-combo-profiles.test.ts",
      "tests/auto-offline-lkgp-and-a2a.test.ts",
      "tests/company-runtime.test.ts",
      "tests/multi-agent-messaging.test.ts",
      "tests/network-tproxy-and-bifrost-mux.test.ts",
      "tests/scoped-memory-and-user-model.test.ts",
      "tests/workspace-store.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 280,
    "capabilityId": "system.per-agent_instructions",
    "name": "Per-agent Instructions",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/a2a-capabilities-eval-and-dlq.test.ts",
      "tests/compression-lite-tool-headroom.test.ts",
      "tests/compression-presets-adaptive-budget.test.ts",
      "tests/integrations-and-security.test.ts",
      "tests/multimodal-inference-and-moderation.test.ts",
      "tests/quota-share-transparency-session-dedup.test.ts",
      "tests/relevance-aggressive-llmlingua2-compression.test.ts",
      "tests/sessions-custom-models-chunking.test.ts",
      "tests/swarm-audio-translation-video.test.ts",
      "tests/vision-guardrail-oidc-and-remote-tokens.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 281,
    "capabilityId": "system.per-agent_tools_configuration",
    "name": "Per-agent Tools configuration",
    "type": "configuration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/agent-api.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 282,
    "capabilityId": "business.manual_agent_scheme",
    "name": "Manual Agent Scheme",
    "type": "configuration",
    "domain": "business",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 283,
    "capabilityId": "orchestration.omniroute_orchestration_integration",
    "name": "OmniRoute orchestration integration",
    "type": "orchestration",
    "domain": "orchestration",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 284,
    "capabilityId": "system.runtime_tool_enforcement_audit",
    "name": "Runtime tool enforcement + audit",
    "type": "security_ops",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/company-runtime.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 285,
    "capabilityId": "system.agent_run_reliability_and_cancellation",
    "name": "Agent run reliability and cancellation",
    "type": "orchestration",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 286,
    "capabilityId": "business.company_agents_pagination_bounded_org_ch",
    "name": "Company agents pagination + bounded Org Chart",
    "type": "runtime",
    "domain": "business",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/company-org-chart-pagination.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 287,
    "capabilityId": "research.crawler_mcp_files_runtime_adapters",
    "name": "Crawler / MCP / Files runtime adapters",
    "type": "runtime",
    "domain": "research",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/company-tool-runtime.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 288,
    "capabilityId": "business.redis_background_company_execution",
    "name": "Redis background Company execution",
    "type": "runtime",
    "domain": "business",
    "agentCallable": false,
    "risk": "high",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 289,
    "capabilityId": "business.crashrestart_recovery",
    "name": "Crash/restart recovery",
    "type": "runtime",
    "domain": "business",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 290,
    "capabilityId": "system.10_000_concurrent_session_capacity",
    "name": "10 000 concurrent session capacity",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "low",
    "testType": "e2e",
    "testFiles": [
      "tests/distributed-session-registry.test.ts",
      "tests/session-stream-routes.test.ts",
      "scripts/run-scale-certification.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 291,
    "capabilityId": "system.transactional_agent_delete_non-duplicate",
    "name": "Transactional Agent delete + non-duplicated Settings navigation",
    "type": "runtime",
    "domain": "system",
    "agentCallable": false,
    "risk": "critical",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 292,
    "capabilityId": "files.central_minio_object_storage",
    "name": "Central MinIO object storage",
    "type": "runtime",
    "domain": "files",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 293,
    "capabilityId": "files.central_file_metadata",
    "name": "Central file metadata",
    "type": "runtime",
    "domain": "files",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 294,
    "capabilityId": "files.chat_files_migrated_to_minio",
    "name": "Chat files migrated to MinIO",
    "type": "runtime",
    "domain": "files",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 295,
    "capabilityId": "files.private_permission-checked_file_access",
    "name": "Private permission-checked file access",
    "type": "security_ops",
    "domain": "files",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 296,
    "capabilityId": "files.file_delete_and_orphan_cleanup",
    "name": "File delete and orphan cleanup",
    "type": "runtime",
    "domain": "files",
    "agentCallable": false,
    "risk": "critical",
    "testType": "integration",
    "testFiles": [
      "tests/chat-file-service.test.ts",
      "tests/storage-protection.test.ts",
      "scripts/verify-file-delete-recovery.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 297,
    "capabilityId": "storage.company_knowledge_ui",
    "name": "Company Knowledge UI",
    "type": "configuration",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/company-knowledge-concurrency.test.ts",
      "tests/company-knowledge-hub-e2e.test.ts",
      "tests/company-knowledge-ui.test.ts",
      "tests/company-knowledge.test.ts",
      "tests/company-runtime.test.ts",
      "tests/company-tool-runtime.test.ts",
      "tests/object-storage.test.ts",
      "tests/pii-and-subagents.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 298,
    "capabilityId": "files.company_documents_lifecycle",
    "name": "Company documents lifecycle",
    "type": "runtime",
    "domain": "files",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/company-knowledge-ui.test.ts",
      "tests/webhooks-documents-and-plugins.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 299,
    "capabilityId": "storage.company_memory",
    "name": "Company memory",
    "type": "tool",
    "domain": "storage",
    "agentCallable": true,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/action-sensitive-memory-and-compat-apis.test.ts",
      "tests/admission-queue-and-conversation-memory.test.ts",
      "tests/agent-api.test.ts",
      "tests/architecture.test.ts",
      "tests/company-knowledge-concurrency.test.ts",
      "tests/company-knowledge-ui.test.ts",
      "tests/company-knowledge.test.ts",
      "tests/company-runtime.test.ts",
      "tests/company-tool-runtime.test.ts",
      "tests/concurrent-session-capacity.test.ts",
      "tests/group-sessions-and-tool-policy.test.ts",
      "tests/inference-and-memory-injection.test.ts",
      "tests/memory-decay-rerank-and-journal.test.ts",
      "tests/memory-md-quota-and-channel-auth.test.ts",
      "tests/pii-and-subagents.test.ts",
      "tests/scoped-memory-and-user-model.test.ts",
      "tests/standing-intents-wiki-and-dreaming.test.ts",
      "tests/workspace-store.test.ts",
      "scripts/verify-npati-004-e2e.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 300,
    "capabilityId": "storage.omniroute_embeddings_integration",
    "name": "OmniRoute Embeddings integration",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/omniroute-adapter.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 301,
    "capabilityId": "files.postgresql_pgvector_storage",
    "name": "PostgreSQL pgvector storage",
    "type": "runtime",
    "domain": "files",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 302,
    "capabilityId": "storage.omniroute_rerank_integration",
    "name": "OmniRoute Rerank integration",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts",
      "tests/production-p02-knowledge-memory.test.ts"
    ],
    "status": "PARTIALLY_IMPLEMENTED"
  },
  {
    "id": 303,
    "capabilityId": "storage.agent_knowledge_retrieval",
    "name": "Agent knowledge retrieval",
    "type": "tool",
    "domain": "storage",
    "agentCallable": true,
    "risk": "high",
    "testType": "unit",
    "testFiles": [
      "tests/capability-registry.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 304,
    "capabilityId": "security.knowledge_tenantcompany_isolation",
    "name": "Knowledge tenant/company isolation",
    "type": "security_ops",
    "domain": "security",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/company-knowledge-hub-e2e.test.ts",
      "tests/pii-and-subagents.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 305,
    "capabilityId": "files.background_document_processing",
    "name": "Background document processing",
    "type": "runtime",
    "domain": "files",
    "agentCallable": false,
    "risk": "low",
    "testType": "unit",
    "testFiles": [
      "tests/company-knowledge-concurrency.test.ts"
    ],
    "status": "VERIFIED_EXISTING"
  },
  {
    "id": 306,
    "capabilityId": "storage.npati-004_end-to-end_production_validati",
    "name": "NPATI-004 end-to-end production validation",
    "type": "runtime",
    "domain": "storage",
    "agentCallable": false,
    "risk": "low",
    "testType": "integration",
    "testFiles": [
      "tests/company-knowledge-concurrency.test.ts",
      "tests/company-knowledge-hub-e2e.test.ts",
      "tests/company-knowledge-ui.test.ts",
      "scripts/verify-npati-004.mjs",
      "scripts/verify-npati-004-e2e.mjs"
    ],
    "status": "VERIFIED_EXISTING"
  }
];

import { PROJECT_FILE_MATRIX } from "./project-file-capabilities";
CAPABILITY_MATRIX.push(...PROJECT_FILE_MATRIX);

import { PROJECT_TERMINAL_MATRIX } from "./project-terminal-capabilities";
CAPABILITY_MATRIX.push(...PROJECT_TERMINAL_MATRIX);

import { PROJECT_PREVIEW_MATRIX } from './project-preview-capabilities';
CAPABILITY_MATRIX.push(...PROJECT_PREVIEW_MATRIX);
