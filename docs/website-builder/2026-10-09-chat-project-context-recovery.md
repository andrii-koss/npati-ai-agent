# Chat blocked by previous Project and sandbox memory admission

## Evidence

The screenshot reports `Project not found or does not belong to company: 7b54458a-f557-4d4b-b7ab-a6d4b9b05fb4` for an explicit request to create a new Next.js store. The supplied 08:42 runner log shows successful image builds followed by four sandbox creation refusals: free memory 12.8–13.2%, below the configured default minimum of 15%. The runner replaced those policy refusals with a generic HTTP 503 `runner_failure`.

## Changes

- Chat used an ASCII `\b` expression around Ukrainian words to decide whether to omit the previous Project. This does not recognize the reported Ukrainian prompt. The frontend now uses the shared Project intent classifier.
- Session storage tracked the active Project globally for the browser tab. It now records the conversation ID and reuses the Project only in that conversation. New Chat clears the record; legacy records without a conversation ID are not reused.
- Both `/chat` and `/chat/stream` now discard the previous Project context for explicit new Project/site creation before attempting to resolve that Project. They still authorize the requested company. Edit requests retain strict Project ownership validation, including missing and cross-workspace Projects.
- The runner preserves `SandboxQuotaError` code, message, HTTP status and retryability across the remote API. Memory admission is now reported as `host_overloaded` with its measured value.
- The runner now applies `resolveHostAdmissionLimits(process.env)`. Both runner Compose definitions forward the three documented host admission variables. Defaults remain 80% CPU and 15% free memory.

## Deployment limits

Deploy the frontend, agent API and sandbox runner. Recreate the runner to apply environment changes and inspect `[sandbox-quota]` for effective thresholds. A new chat request should not carry a previous conversation's Project ID. A stale client explicitly creating a new site is also handled server-side.

These code changes do not increase VPS memory. Build and Live Preview still require sufficient host resources. The supplied log does not show a model-provider error in this incident. `runner_store_not_configured` is a separate warning about persistent image revocations.

Regression checks cover the exact Ukrainian prompt, a deleted Project ID, streamed and non-streamed creation, follow-up editing, cross-workspace refusal, and memory-refusal propagation through the remote runner client. A production replay and live Docker sandbox check are unavailable from this workspace.

Local checks passed: 40 targeted tests; TypeScript checks for agent API, web and tests; lint; agent API and web production builds.
