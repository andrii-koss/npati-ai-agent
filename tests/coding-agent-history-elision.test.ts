import { describe, expect, it } from "vitest";
import { elideWrittenContent, WRITTEN_CONTENT_NOTE } from "../apps/agent-api/src/coding-agent-history-elision";

const call = (id: string, name: string, content: string) => ({ id, function: { name, arguments: JSON.stringify({ path: "index.html", content }) } });
const big = "<div>x</div>\n".repeat(400);

describe("written file text in the history", () => {
  it("replaces the text of a large successful write with a note", () => {
    const calls = [call("a", "code.fs.write", big)];
    const saved = elideWrittenContent(calls, [{ role: "tool", tool_call_id: "a", content: JSON.stringify({ ok: true, tool: "code.fs.write" }) }]);
    expect(saved).toBe(big.length);
    const args = JSON.parse(calls[0]!.function.arguments);
    expect(args.content.startsWith(WRITTEN_CONTENT_NOTE)).toBe(true);
    expect(args.path).toBe("index.html");
  });
  it("keeps small writes, failed writes and other tools as they are", () => {
    const calls = [call("s", "code.fs.write", "small"), call("f", "code.fs.write", big), call("e", "code.fs.edit", big)];
    elideWrittenContent(calls, [
      { role: "tool", tool_call_id: "s", content: '{"ok":true}' },
      { role: "tool", tool_call_id: "f", content: JSON.stringify({ ok: false, error: { code: "stale" } }) },
      { role: "tool", tool_call_id: "e", content: '{"ok":true}' },
    ]);
    expect(JSON.parse(calls[0]!.function.arguments).content).toBe("small");
    expect(JSON.parse(calls[1]!.function.arguments).content).toBe(big);
    expect(JSON.parse(calls[2]!.function.arguments).content).toBe(big);
  });
  it("treats a receipt cut to the output limit as a success when it starts with ok", () => {
    const calls = [call("a", "npati_code_fs_write", big)];
    elideWrittenContent(calls, [{ role: "tool", tool_call_id: "a", content: '{"ok":true,"tool":"code.fs.write","result":{"diff":"…' }]);
    expect(JSON.parse(calls[0]!.function.arguments).content.startsWith(WRITTEN_CONTENT_NOTE)).toBe(true);
  });
});
