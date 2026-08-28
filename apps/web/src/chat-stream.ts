import type { ChatProgressEvent } from "./ResearchProgress";

type StreamEnvelope<T> =
  | { event: "progress"; data: ChatProgressEvent }
  | { event: "result"; data: T }
  | { event: "error"; data: { error?: { code?: string; message?: string } } };

function parseBlock<T>(block: string): StreamEnvelope<T> | null {
  let event = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!event || data.length === 0) return null;
  return { event, data: JSON.parse(data.join("\n")) } as StreamEnvelope<T>;
}

export async function streamChat<T>(
  body: { message: string; conversationId?: string },
  onProgress: (event: ChatProgressEvent) => void,
): Promise<T> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    const error = new Error(payload?.error?.message ?? `Request failed with HTTP ${response.status}`);
    Object.assign(error, { code: payload?.error?.code, status: response.status });
    throw error;
  }
  if (!response.body) throw new Error("The server did not provide a chat event stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: T | undefined;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const envelope = parseBlock<T>(block);
      if (!envelope) continue;
      if (envelope.event === "progress") onProgress(envelope.data);
      if (envelope.event === "result") result = envelope.data;
      if (envelope.event === "error") {
        const error = new Error(envelope.data.error?.message ?? "The agent stream failed.");
        Object.assign(error, { code: envelope.data.error?.code });
        throw error;
      }
    }
    if (done) break;
  }
  if (result === undefined) throw new Error("The agent stream ended before returning a response.");
  return result;
}
