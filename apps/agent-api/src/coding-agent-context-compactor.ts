import type { ChatMessage, ChatToolDefinition } from "@npati/omniroute-adapter";
import type { CodeSession } from "@npati/workspace";
import type { CodeAgentLimits } from "./code-agent-config";
import type { CodeModelProfile } from "./code-model-profiles";
import { compactWrittenArguments } from "./code-write-receipt";
import { createHash } from "node:crypto";
import { resolveModelRequestPressure, type ModelRequestPressure } from "./code-context-budget";
import {
  COMPACTION_SCHEMA_VERSION,
  assertNoLeaseValuesInSummary,
  compactConversation,
  renderSummaryMessage,
} from "./code-conversation-compaction";
import {
  type CodeRunActivityEvent,
  type CodingAgentRunnerPorts,
  type CodingAgentRunInput,
  chatContentText,
} from "./coding-agent-runner-contracts";

export interface CompactContextArgs {
  ports: CodingAgentRunnerPorts;
  limits: CodeAgentLimits;
  input: CodingAgentRunInput;
  session: CodeSession;
  companyId: string;
  projectId: string;
  sessionId: string;
  stateRunId: string | undefined;
  snapshotId: string;
  steps: number;
  systemPrompt: string;
  definitions: ChatToolDefinition[];
  messages: ChatMessage[];
  profile: CodeModelProfile;
  quotaRemaining?: number;
  estimatedTokensPerCall: number;
  compressionArtifacts: Record<string, unknown>[];
  record: (event: CodeRunActivityEvent) => Promise<void>;
}

export async function compactConversationContextIfNeeded(args: CompactContextArgs): Promise<{
  lastBudget: ModelRequestPressure;
  compacted: boolean;
}> {
  const {
    ports,
    limits,
    input,
    session,
    companyId,
    projectId,
    sessionId,
    stateRunId,
    snapshotId,
    steps,
    systemPrompt,
    definitions,
    messages,
    profile,
    quotaRemaining,
    estimatedTokensPerCall,
    compressionArtifacts,
    record,
  } = args;

  const lastBudget = resolveModelRequestPressure({
    systemPrompt,
    toolSchemas: JSON.stringify(definitions),
    messages: messages.slice(1).map((message) => ({
      role: message.role,
      content: chatContentText(message.content) + (message.tool_calls ? JSON.stringify(message.tool_calls) : "") + (message.reasoning_content ?? "") + (message.reasoning_text ?? ""),
    })),
    contextWindow: profile.contextWindow,
    compressionRatio: Math.min(limits.contextCompressionRatio, (limits.modelInputTokens ?? 16_384) / profile.contextWindow),
  });

  let compacted = false;

  if (lastBudget.actionRequired || quotaRemaining !== undefined && lastBudget.currentTokens + estimatedTokensPerCall > quotaRemaining) {
    const compactable = messages.map((message) => {
      const carrier = message as unknown as { toolCallId?: string; name?: string; toolVersion?: number };
      return {
        role: message.role as string,
        content: chatContentText(message.content),
        ...(message.tool_call_id ?? carrier.toolCallId ? { toolCallId: message.tool_call_id ?? carrier.toolCallId } : {}),
        ...(carrier.name ? { toolName: carrier.name } : {}),
        ...(carrier.toolVersion !== undefined ? { toolVersion: carrier.toolVersion } : {}),
      };
    });

    try {
      // Keep the last two turns whole and the newest unchanged reads (within 30 % of the budget), so compaction
      // does not force the model to re-read files it has not changed (audit F-01).
      const compaction = compactConversation({
        messages: compactable, keepRecentAssistantTurns: 2,
        preserveLatestReadsChars: Math.floor(lastBudget.thresholdTokens * 4 * 0.3),
      });
      const summaryText = renderSummaryMessage(compaction.summary);

      if (ports.providerDataGuard) {
        await ports.providerDataGuard.guardProviderBoundText(summaryText, {
          model: input.model,
          policyContext: {
            companyId,
            projectId,
            sessionId,
            dataClassification: session.dataClassification,
          },
        });
      }

      if (ports.secretLeaseValues) {
        const values = await ports.secretLeaseValues({ sessionId, companyId, projectId });
        assertNoLeaseValuesInSummary(summaryText, values ?? []);
      }

      const contentCompacted: ChatMessage[] = compaction.messages.map((message, index) => ({
        ...messages[index]!,
        content: message.content,
      }));
      // Tool-output stubs alone do not remove the code in assistant.tool_calls.
      // Run against the original successful receipts, before replacing any output.
      const argumentCompaction = compactWrittenArguments(contentCompacted, messages);
      const rebuilt = argumentCompaction.messages;

      if (compaction.stubbed > 0 || argumentCompaction.references.length > 0) {
        messages.length = 0;
        messages.push(...rebuilt);

        const summaryIndex = messages.findIndex(
          (message) => message.role === "system" && typeof message.content === "string" && message.content.startsWith("Context summary of the earlier part of this session"),
        );
        if (summaryIndex >= 0) messages[summaryIndex] = { role: "system", content: summaryText };
        else messages.splice(2, 0, { role: "system", content: summaryText });

        compacted = true;
        compressionArtifacts.push({ ...compaction.artifact,
          ...(argumentCompaction.references.length ? {prunedToolArguments:argumentCompaction.references,
            modelRequestHash:"sha256:"+createHash("sha256").update(JSON.stringify(messages)).digest("hex")} : {}),
        } as unknown as Record<string, unknown>);

        await record({
          kind: "turn",
          companyId,
          projectId,
          sessionId,
          ...(stateRunId ?? input.runId ? { runId: stateRunId ?? input.runId } : {}),
          turn: steps,
          ok: true,
          errorCode: "context_compacted",
          reason: `stubbed=${compaction.stubbed} tokens=${compaction.tokensBefore}->${compaction.tokensAfter} hash=${compaction.contentHash}`,
        });

        if (ports.contextSummaryStore) {
          try {
            await ports.contextSummaryStore.persist({
              companyId,
              projectId,
              sessionId,
              runId: stateRunId ?? input.runId ?? "",
              snapshotId,
              turnIndex: steps,
              schemaVersion: COMPACTION_SCHEMA_VERSION,
              summary: compaction.summary,
              summaryText,
              contentHash: compaction.contentHash,
              dataClassification: session.dataClassification,
              retentionClass: session.retentionClass,
            });
          } catch {
            // Ignored
          }
        }
      }
    } catch (error) {
      await record({
        kind: "turn",
        companyId,
        projectId,
        sessionId,
        ...(stateRunId ?? input.runId ? { runId: stateRunId ?? input.runId } : {}),
        turn: steps,
        ok: false,
        errorCode: "context_compaction_refused",
        reason: String((error as { code?: string })?.code ?? "context_compaction_failed"),
      });
    }
  }

  return { lastBudget, compacted };
}
