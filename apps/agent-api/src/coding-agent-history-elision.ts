/**
 * The text of a file the agent has just written successfully is replaced in the conversation history by a short note.
 * Every later turn re-sent the whole file as part of the earlier call: in E2E G1 the second turn grew from 5.5k to
 * 12.5k input tokens only because of that. The model can read the file again when it needs the text.
 *
 * Only the new assistant message is changed, right after its tools ran, so the provider's prompt cache (built on the
 * earlier messages) stays valid. Small writes stay as they are: the gain is small and the model often edits them next.
 */
export const WRITTEN_CONTENT_NOTE = "[file content omitted from history after a successful write";
const MIN_CHARS = 2_000;

type HistoryCall = { id: string; function: { name: string; arguments: string } };
type HistoryMessage = { role: string; content?: unknown; tool_call_id?: string };

export function elideWrittenContent(calls: readonly HistoryCall[], messages: readonly HistoryMessage[]): number {
  let saved = 0;
  for (const call of calls) {
    if (!/(?:^|_)code[._]fs[._]write$/.test(call.function.name)) continue;
    let args: Record<string, unknown>;
    try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { continue; }
    const content = typeof args.content === "string" ? args.content : undefined;
    if (!content || content.length < MIN_CHARS) continue;
    const result = messages.find((message) => message.role === "tool" && message.tool_call_id === call.id);
    if (!result || typeof result.content !== "string" || !wroteSuccessfully(result.content)) continue;
    const lines = content.split("\n").length;
    args.content = `${WRITTEN_CONTENT_NOTE}: ${lines} lines, ${content.length} characters were written to ${String(args.path ?? "the file")}. Read the file if you need its text; never write this note as file content]`;
    call.function.arguments = JSON.stringify(args);
    saved += content.length;
  }
  return saved;
}

function wroteSuccessfully(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; error?: unknown };
    return parsed.ok !== false && !parsed.error;
  } catch {
    // A long receipt can be cut to the output limit; its start still says whether the write succeeded.
    return text.startsWith('{"ok":true');
  }
}
