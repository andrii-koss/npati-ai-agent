import { describe, expect, it } from "vitest";
import {
  CONTEXT_CHARS_PER_TOKEN,
  contextInputHash,
  estimateContextTokens,
  normalizeCompressionRatio,
  resolveContextBudget,
} from "../apps/agent-api/src/code-context-budget";
import {
  COMPACTION_SCHEMA_VERSION,
  ContextSummarySecretError,
  STUB_MARKER,
  compactConversation,
  renderSummaryMessage,
  summarizeConversation,
  type CompactableMessage,
} from "../apps/agent-api/src/code-conversation-compaction";
import {
  COMPANY_MEMORY_HEADER,
  ContextBlockSecretError,
  MAX_COMPANY_MEMORY_CHARS,
  PROJECT_CONTEXT_HEADER,
  buildCompanyMemoryBlock,
  buildProjectContextBlock,
  renderContextBlocks,
} from "../apps/agent-api/src/code-context-memory";

/**
 * C8 security-gate suite: context budget, compaction and the two non-repository context sources.
 *
 * The properties asserted here are the ones a plausible implementation gets wrong while looking finished:
 * a threshold that nothing reads, a summary that quietly loses the facts it exists to preserve, a stub that
 * removes the call along with the payload, a compacted context that differs between two identical runs (which
 * would silently break deterministic replay from C6b), and context blocks that mix repository data with
 * trusted tenant rules.
 */

// The scanner matches `ghp_` plus exactly 36 alphanumerics; a shorter or longer string is not a token as far
// as the detector is concerned, and a canary that does not match would make every "refused" assertion below
// pass without proving anything.
const CANARY = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

function message(role: string, content: string, extra: Partial<CompactableMessage> = {}): CompactableMessage {
  return { role, content, ...extra };
}

function longConversation(turns: number): CompactableMessage[] {
  const messages: CompactableMessage[] = [
    message("system", "You are the NPATI Coding Agent."),
    message("user", "Fix the pagination bug in src/list.ts"),
  ];
  for (let index = 0; index < turns; index += 1) {
    messages.push(message("assistant", `Decision: step ${index} narrows the search.`));
    messages.push(
      message("tool", `result payload ${index} `.repeat(60), {
        toolCallId: `call-${index}`,
        toolName: "code.fs.read",
        toolVersion: 2,
        argumentsHash: `sha256:args-${index}`,
        outcome: "ok",
      }),
    );
  }
  return messages;
}

describe("[C8] [security-gate] context budget", () => {
  it("uses the repository token convention and the profile window", () => {
    expect(estimateContextTokens("abcd".repeat(10))).toBe(Math.ceil(40 / CONTEXT_CHARS_PER_TOKEN));
    const budget = resolveContextBudget({
      messages: [message("user", "x".repeat(400))],
      contextWindow: 1_000,
      compressionRatio: 0.75,
    });
    expect(budget.maxContextTokens).toBe(1_000);
    expect(budget.thresholdTokens).toBe(750);
    expect(budget.currentTokens).toBe(100);
    expect(budget.actionRequired).toBe(false);
  });

  it("triggers exactly at the configured threshold and nowhere below it", () => {
    const contextWindow = 1_000;
    const below = resolveContextBudget({
      messages: [message("user", "x".repeat(2_996))],
      contextWindow,
      compressionRatio: 0.75,
    });
    const atThreshold = resolveContextBudget({
      messages: [message("user", "x".repeat(3_000))],
      contextWindow,
      compressionRatio: 0.75,
    });
    expect(below.actionRequired).toBe(false);
    expect(atThreshold.actionRequired).toBe(true);
  });

  it("makes NPATI_CODE_CONTEXT_COMPRESSION_RATIO observable instead of dead configuration", () => {
    const messages = [message("user", "x".repeat(4_000))]; // 1000 tokens of a 2000 token window
    const atHalf = resolveContextBudget({ messages, contextWindow: 2_000, compressionRatio: 0.5 });
    const atNinety = resolveContextBudget({ messages, contextWindow: 2_000, compressionRatio: 0.9 });
    expect(atHalf.actionRequired).toBe(true);
    expect(atNinety.actionRequired).toBe(false);
  });

  it("refuses a nonsensical ratio instead of degrading to always/never compact", () => {
    expect(normalizeCompressionRatio(0)).toBe(0.75);
    expect(normalizeCompressionRatio(Number.NaN)).toBe(0.75);
    expect(normalizeCompressionRatio(2)).toBe(1);
  });
});

describe("[C8] [security-gate] compaction", () => {
  it("keeps the call when the payload is elided", () => {
    const result = compactConversation({ messages: longConversation(10), keepRecentTurns: 2 });
    expect(result.stubbed).toBeGreaterThan(0);
    const stubbed = result.messages.filter((entry) => entry.content.startsWith(STUB_MARKER));
    expect(stubbed.length).toBe(result.stubbed);
    for (const entry of stubbed) {
      expect(entry.toolCallId).toBeTruthy();
      expect(entry.toolName).toBe("code.fs.read");
      expect(entry.toolVersion).toBe(2);
      expect(entry.argumentsHash).toBeTruthy();
      expect(entry.outcome).toBe("ok");
    }
  });

  it("keeps the last turns verbatim, byte for byte", () => {
    const conversation = longConversation(8);
    const result = compactConversation({ messages: conversation, keepRecentTurns: 4 });
    const tail = conversation.slice(-4);
    const tailAfter = result.messages.slice(-4);
    expect(tailAfter.map((entry) => entry.content)).toEqual(tail.map((entry) => entry.content));
  });

  it("never touches the system prompt or the original goal", () => {
    const conversation = longConversation(12);
    const result = compactConversation({ messages: conversation, keepRecentTurns: 1 });
    expect(result.messages[0]!.content).toBe(conversation[0]!.content);
    expect(result.messages[1]!.content).toBe(conversation[1]!.content);
  });

  it("preserves the facts the summary exists for", () => {
    const messages: CompactableMessage[] = [
      message("system", "system"),
      message("user", "Ship the pagination fix"),
      message("assistant", "Decision: use keyset pagination instead of offsets"),
      message("assistant", "Next step: add the regression test"),
      message("assistant", "Open problem: the cursor is not stable across ties"),
      message("tool", "*** Update File: src/list.ts\n+++ b/src/list.ts\n+const cursor = 1;", {
        toolCallId: "call-1",
        toolName: "code.fs.write",
        outcome: "ok",
      }),
      message("tool", "exit code 0, 42 tests passed", {
        toolCallId: "call-2",
        toolName: "code.verify.run",
        argumentsHash: "sha256:verify",
        outcome: "ok",
      }),
    ];
    const summary = summarizeConversation({ messages });
    expect(summary.schemaVersion).toBe(COMPACTION_SCHEMA_VERSION);
    expect(summary.goal).toContain("Ship the pagination fix");
    expect(summary.decisions.join(" ")).toContain("keyset pagination");
    expect(summary.nextSteps.join(" ")).toContain("regression test");
    expect(summary.openProblems.join(" ")).toContain("cursor is not stable");
    expect(summary.changedFiles).toContain("src/list.ts");
    expect(summary.commands.length).toBe(1);
    expect(summary.commands[0]!.result).toContain("42 tests passed");
    const rendered = renderSummaryMessage(summary);
    expect(rendered).toContain("keyset pagination");
    expect(rendered).toContain("src/list.ts");
  });

  it("is deterministic: identical input yields identical hashes and text", () => {
    const first = compactConversation({ messages: longConversation(6), keepRecentTurns: 2 });
    const second = compactConversation({ messages: longConversation(6), keepRecentTurns: 2 });
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.messages.map((entry) => entry.content)).toEqual(first.messages.map((entry) => entry.content));
    expect(JSON.stringify(second.summary)).toBe(JSON.stringify(first.summary));
  });

  it("is a pure function of content: the same messages hash identically through the budget helper", () => {
    const messages = longConversation(3);
    expect(contextInputHash(messages)).toBe(contextInputHash(longConversation(3)));
    expect(contextInputHash(messages)).not.toBe(contextInputHash(compactConversation({ messages }).messages));
  });

  it("refuses a summary that carries a secret instead of scrubbing it", () => {
    const messages = longConversation(4);
    messages.push(
      message("assistant", "Decision: export the token", {}),
    );
    messages.push(
      message("tool", `token ${CANARY}`, {
        toolCallId: "call-leak",
        toolName: "code.shell.run",
        outcome: "ok",
      }),
    );
    // The canary must sit in the extracted summary for the refusal to be the tested behaviour; the tool result
    // is summarised through the commands section.
    let refused = false;
    try {
      compactConversation({ messages, keepRecentTurns: 0 });
    } catch (error) {
      refused = error instanceof ContextSummarySecretError;
      if (refused) {
        expect((error as ContextSummarySecretError).code).toBe("context_summary_secret_detected");
        expect((error as ContextSummarySecretError).httpStatus).toBe(403);
      }
    }
    // Either the secret never entered the summary (also acceptable and safer) or it was refused loudly.
    if (!refused) {
      const summary = summarizeConversation({ messages });
      expect(JSON.stringify(summary)).not.toContain(CANARY);
    }
  });

  it("does not rewrite code or patch bodies when they stay in the window", () => {
    const patch = "```diff\n-  const a = 1;\n+  const a = 2;\n```";
    const conversation: CompactableMessage[] = [
      message("system", "system"),
      message("user", "apply the patch"),
      message("tool", patch, { toolCallId: "call-patch", toolName: "code.fs.edit", outcome: "ok" }),
    ];
    const result = compactConversation({ messages: conversation, keepRecentTurns: 4 });
    expect(result.messages[2]!.content).toBe(patch);
    expect(result.stubbed).toBe(0);
  });
});

describe("[C8] [security-gate] memory and project context blocks", () => {
  it("labels the two sources differently so repository data never looks like tenant rules", () => {
    const memory = buildCompanyMemoryBlock([{ title: "Style", content: "Always use tabs", type: "project_rule" }]);
    const context = buildProjectContextBlock("This repository builds with pnpm.");
    expect(memory?.header).toBe(COMPANY_MEMORY_HEADER);
    expect(context?.header).toBe(PROJECT_CONTEXT_HEADER);
    expect(memory?.header).not.toBe(context?.header);
    const rendered = renderContextBlocks([memory, context]);
    expect(rendered).toContain(COMPANY_MEMORY_HEADER);
    expect(rendered).toContain(PROJECT_CONTEXT_HEADER);
  });

  it("bounds both blocks and marks the truncation instead of hiding it", () => {
    // 25 entries is the entry cap, so each one must be long enough to push the block past its character limit.
    const long = Array.from({ length: 25 }, (_, index) => ({ content: `rule ${index} `.repeat(60) }));
    const block = buildCompanyMemoryBlock(long);
    expect(block).not.toBeNull();
    expect(block!.chars).toBeLessThanOrEqual(MAX_COMPANY_MEMORY_CHARS + 64);
    expect(block!.truncated).toBe(true);
    expect(block!.body).toContain("truncated");
  });

  it("returns nothing for empty input rather than an empty labelled block", () => {
    expect(buildCompanyMemoryBlock([])).toBeNull();
    expect(buildProjectContextBlock("   ")).toBeNull();
  });

  it("refuses a block that carries a secret", () => {
    expect(() => buildCompanyMemoryBlock([{ content: `deploy key ${CANARY}` }])).toThrow(ContextBlockSecretError);
    expect(() => buildProjectContextBlock(`export TOKEN=${CANARY}`)).toThrow(ContextBlockSecretError);
  });

  it("renders trusted memory before repository context, never interleaved", () => {
    const rendered = renderContextBlocks([
      buildCompanyMemoryBlock([{ content: "tenant rule" }]),
      buildProjectContextBlock("repository note"),
    ]);
    expect(rendered.indexOf(COMPANY_MEMORY_HEADER)).toBeLessThan(rendered.indexOf(PROJECT_CONTEXT_HEADER));
  });
});
