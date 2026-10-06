import { describe, expect, it } from "vitest";
import {
  resolveModelRequestPressure,
} from "../apps/agent-api/src/code-context-budget";
import {
  STUB_MARKER,
  compactConversation,
  type CompactableMessage,
} from "../apps/agent-api/src/code-conversation-compaction";

/**
 * C8 acceptance suite: a long session (100+ turns) must survive automatic compaction without losing the goal,
 * the decisions or the open problems, must not break the tool history, and must produce a **recorded**
 * compression artifact that a deterministic replay can feed back instead of recomputing a summary.
 *
 * The session is scripted with artificial but decisive facts rather than empty turns, because a compaction
 * test built from empty turns passes for the wrong reason: there is nothing to lose.
 */

const GOAL = "Fix the keyset pagination cursor so ties do not repeat rows";
const DECISIONS = [
  "Decision: use keyset pagination instead of offsets",
  "Decision: carry (created_at, id) as the cursor pair",
  "Decision: keep the old offset path behind a flag for one release",
];
const OPEN_PROBLEMS = [
  "Open problem: the cursor is not stable when created_at collides",
  "Open problem: the migration for the composite index is not written yet",
];
const NEXT_STEPS = [
  "Next step: add the composite index migration",
  "Next step: extend the regression test to equal timestamps",
];
const CHANGED_FILE = "src/list.ts";
const DIFF = "*** Update File: src/list.ts\n+++ b/src/list.ts\n@@\n-  const cursor = offset;\n+  const cursor = [createdAt, id];";

function longSession(turns: number): CompactableMessage[] {
  const messages: CompactableMessage[] = [
    { role: "system", content: "You are the NPATI Coding Agent operating inside a sandboxed workspace." },
    { role: "user", content: GOAL },
  ];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({
      role: "assistant",
      content: [
        DECISIONS[turn % DECISIONS.length]!,
        PLAN_LINE(turn),
        OPEN_PROBLEMS[turn % OPEN_PROBLEMS.length]!,
        NEXT_STEPS[turn % NEXT_STEPS.length]!,
      ].join("\n"),
    });
    // Each tool result is long enough that the session is genuinely under pressure, and old ones are exactly
    // what should be pruned.
    messages.push({
      role: "tool",
      content: turn === turns - 1
        ? `42 tests passed\n${DIFF}`
        : `read ${turn}: ${"payload ".repeat(120)}`,
      toolCallId: `call-${turn}`,
      toolName: turn % 3 === 0 ? "code.shell.run" : "code.fs.read",
      toolVersion: 2,
      argumentsHash: `sha256:args-${turn}`,
      outcome: "ok",
    });
  }
  return messages;
}

function PLAN_LINE(turn: number): string {
  return `Plan step ${turn}: inspect and narrow the failing case`;
}

describe("[C8] [security-gate] long session (100+ turns)", () => {
  it("triggers compaction around the configured share of the whole model request", () => {
    const messages = longSession(120);
    const pressure = resolveModelRequestPressure({
      systemPrompt: "You are the NPATI Coding Agent operating inside a sandboxed workspace.",
      toolSchemas: "code.fs.read, code.fs.edit, code.shell.run, code.verify.run",
      projectInstructions: "PROJECT INSTRUCTIONS (trusted, stylistic only)",
      contextBlocks: "COMPANY MEMORY (trusted, persistent rules)",
      messages,
      contextWindow: 32_000,
      compressionRatio: 0.75,
    });
    expect(pressure.actionRequired).toBe(true);
    // The conversation is only part of the pressure; the permanent part (system, schemas, instructions,
    // memory/context) is counted too, which is the point of measuring the whole request.
    expect(pressure.currentTokens).toBe(
      pressure.systemTokens + pressure.toolSchemaTokens + pressure.instructionTokens + pressure.contextBlockTokens + pressure.conversationTokens,
    );
  });

  it("keeps goal, decisions and open problems after compaction", () => {
    const result = compactConversation({ messages: longSession(120), keepRecentTurns: 6 });
    const pinned = result.artifact.pinnedEvidence;
    expect(pinned.goal).toContain("keyset pagination cursor");
    expect(pinned.decisions.length).toBeGreaterThan(0);
    expect(pinned.decisions.join(" ")).toContain("keyset pagination instead of offsets");
    expect(pinned.unresolvedErrors.join(" ")).toContain("cursor is not stable");
    expect(pinned.plan.length).toBeGreaterThan(0);
    expect(pinned.currentFiles).toContain(CHANGED_FILE);
    expect(pinned.latestResults.join(" ")).toContain("42 tests passed");
    // The summary the model receives carries the same decisive facts.
    expect(result.summary.goal).toContain("keyset pagination cursor");
    expect(result.summary.decisions.join(" ")).toContain("keyset pagination instead of offsets");
    expect(result.summary.openProblems.join(" ")).toContain("cursor is not stable");
    expect(result.summary.nextSteps.join(" ")).toContain("composite index migration");
  });

  it("prunes old tool outputs without breaking the tool history", () => {
    const messages = longSession(120);
    const result = compactConversation({ messages, keepRecentTurns: 6 });
    expect(result.stubbed).toBeGreaterThan(50);
    // Every call survives: count and order of tool messages are unchanged.
    const toolsBefore = messages.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    const toolsAfter = result.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    expect(toolsAfter).toEqual(toolsBefore);
    // Pruned payloads are referenced by the artifact, not lost silently.
    expect(result.artifact.prunedToolResultRefs.length).toBe(result.stubbed);
    for (const ref of result.artifact.prunedToolResultRefs) {
      expect(ref.toolCallId).toBeTruthy();
      expect(ref.toolName).toBeTruthy();
      expect(ref.argumentsHash).toBeTruthy();
    }
    expect(result.artifact.modelVisiblePlaceholders.every((text) => text.startsWith(STUB_MARKER))).toBe(true);
    // The pinned diff and the latest test result are still visible to the model.
    const visible = result.messages.map((m) => m.content).join("\n");
    expect(visible).toContain("42 tests passed");
    expect(visible).toContain("src/list.ts");
  });

  it("produces a recorded artifact a replay can feed back: identical on a second identical run", () => {
    const first = compactConversation({ messages: longSession(120), keepRecentTurns: 6 });
    const second = compactConversation({ messages: longSession(120), keepRecentTurns: 6 });
    expect(second.artifact.contentHash).toBe(first.artifact.contentHash);
    expect(second.artifact).toEqual(first.artifact);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("records the source range, hashes and retained turns of what it compacted", () => {
    const result = compactConversation({ messages: longSession(120), keepRecentTurns: 6 });
    const artifact = result.artifact;
    expect(artifact.sourceTurnRange.from).toBeLessThan(artifact.sourceTurnRange.to);
    expect(artifact.sourceHashes.length).toBe(artifact.sourceTurnRange.to - artifact.sourceTurnRange.from + 1);
    expect(artifact.retainedTurnIds.length).toBeGreaterThan(0);
    expect(artifact.summaryText.length).toBeGreaterThan(0);
    expect(artifact.schemaVersion).toBe(1);
  });

  it("reduces the request while the pinned evidence survives", () => {
    const result = compactConversation({ messages: longSession(120), keepRecentTurns: 6 });
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.artifact.pinnedEvidence.goal.length).toBeGreaterThan(10);
  });
});
