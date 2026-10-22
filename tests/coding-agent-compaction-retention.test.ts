import { describe, expect, it } from "vitest";
import { compactConversation, STUB_MARKER, type CompactableMessage } from "../apps/agent-api/src/code-conversation-compaction";

const read = (id: string, path: string, body = "x".repeat(400)): CompactableMessage => ({
  role: "tool", toolCallId: id, toolName: "code.fs.read",
  content: JSON.stringify({ ok: true, tool: "code.fs.read", result: { data: { path, lines: [{ n: 1, text: body }] } } }),
});
const edit = (id: string, path: string): CompactableMessage => ({
  role: "tool", toolCallId: id, toolName: "code.fs.edit",
  content: JSON.stringify({ ok: true, tool: "code.fs.edit", result: { data: { path, replacements: 1, diff: "-a\n+b".repeat(80) } } }),
});
const assistant = (text: string): CompactableMessage => ({ role: "assistant", content: text });

/** A long run in which the model read three files early, edited one of them, and kept working. */
function conversation(): CompactableMessage[] {
  return [
    { role: "system", content: "system" }, { role: "user", content: "change the button colour" },
    assistant("reading"), read("r1", "app/page.tsx"), read("r2", "app/globals.css"), read("r3", "components/Header.tsx"),
    assistant("editing"), edit("e1", "app/globals.css"),
    assistant("more"), read("r4", "app/layout.tsx", "y".repeat(300)),
    assistant("next"), read("r5", "lib/a.ts"), read("r6", "lib/b.ts"),
    assistant("last"), read("r7", "lib/c.ts"),
  ];
}
const stubbedIds = (messages: CompactableMessage[]) => messages.filter((m) => m.content.startsWith(STUB_MARKER)).map((m) => m.toolCallId);

describe("compaction keeps what the model would otherwise re-read (audit F-01)", () => {
  it("without the new options it behaves exactly as before", () => {
    const result = compactConversation({ messages: conversation() });
    expect(stubbedIds(result.messages)).toEqual(["r1", "r2", "r3", "e1", "r4"]);
  });

  it("keeps whole recent turns and the newest unchanged reads within the budget", () => {
    const result = compactConversation({ messages: conversation(), keepRecentAssistantTurns: 2, preserveLatestReadsChars: 2_000 });
    const stubbed = stubbedIds(result.messages);
    // The edited file's earlier read is stale and may go; the edit receipt itself is old history.
    expect(stubbed).toContain("r2");
    expect(stubbed).toContain("e1");
    // Unchanged files the model read stay readable instead of forcing another code.fs.read.
    expect(stubbed).not.toContain("r1");
    expect(stubbed).not.toContain("r4");
    // The last two turns are never split, even when one has several tool results.
    expect(stubbed).not.toContain("r5");
    expect(stubbed).not.toContain("r6");
    expect(stubbed).not.toContain("r7");
  });

  it("respects the budget and stays deterministic", () => {
    const tight = compactConversation({ messages: conversation(), keepRecentAssistantTurns: 2, preserveLatestReadsChars: 700 });
    const again = compactConversation({ messages: conversation(), keepRecentAssistantTurns: 2, preserveLatestReadsChars: 700 });
    expect(tight.contentHash).toBe(again.contentHash);
    const preserved = ["r1", "r3", "r4"].filter((id) => !stubbedIds(tight.messages).includes(id));
    expect(preserved.length).toBeLessThan(3);
    expect(tight.tokensAfter).toBeLessThan(tight.tokensBefore);
  });
});
