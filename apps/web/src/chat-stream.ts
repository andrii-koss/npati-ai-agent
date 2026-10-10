import type { ChatProgressEvent } from "./ResearchProgress";
import type { ChatAttachmentInput } from "./ChatAttachments";
import type { CodeChatSession } from "./code-inbox-client";

type StreamEnvelope<T> =
  | { event: "progress"; data: ChatProgressEvent }
  | { event: "delta"; data: { delta: string } }
  | { event: "code_session"; data: CodeChatSession }
  | { event: "code_inbox"; data: { sessionId: string; revision: number } }
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
  body: {
    message: string;
    conversationId?: string;
    attachments?: ChatAttachmentInput[];
    contextType?: "none" | "business" | "company" | "project";
    businessId?: string;
    companyId?: string;
    projectId?: string;
    noMemory?: boolean;
    ephemeral?: boolean;
    streamId?:string;
  },
  onProgress: (event: ChatProgressEvent) => void,
  options: { onDelta?: (delta:string)=>void; signal?:AbortSignal;
    onCodeSession?: (session: CodeChatSession) => void;
    onCodeInbox?: (sessionId: string, revision: number) => void } = {},
): Promise<T> {
  const token = localStorage.getItem("npati_agent_access_token");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event("npati:unauthorized"));
  }
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
      if (envelope.event === "delta") options.onDelta?.(envelope.data.delta);
      if (envelope.event === "code_session") options.onCodeSession?.(envelope.data);
      if (envelope.event === "code_inbox") options.onCodeInbox?.(envelope.data.sessionId, envelope.data.revision);
      if (envelope.event === "result") result = envelope.data;
      if (envelope.event === "error") {
        const error = new Error(envelope.data.error?.message ?? "The agent stream failed.");
        Object.assign(error, { code: envelope.data.error?.code });
        throw error;
      }
    }
    if (done) break;
  }
  if(buffer.trim()){
    const envelope=parseBlock<T>(buffer);
    if(envelope?.event==="progress")onProgress(envelope.data);
    if(envelope?.event==="delta")options.onDelta?.(envelope.data.delta);
    if(envelope?.event==="code_session")options.onCodeSession?.(envelope.data);
    if(envelope?.event==="code_inbox")options.onCodeInbox?.(envelope.data.sessionId,envelope.data.revision);
    if(envelope?.event==="result")result=envelope.data;
    if(envelope?.event==="error")throw new Error(envelope.data.error?.message??"The agent stream failed.");
  }
  if (result === undefined) throw new Error("The agent stream ended before returning a response.");
  return result;
}

export async function cancelChatStream(streamId:string){
  const token=localStorage.getItem("npati_agent_access_token");
  try{
    const response=await fetch("/api/chat/streams/"+encodeURIComponent(streamId)+"/cancel",{method:"POST",headers:{...(token?{authorization:`Bearer ${token}`}:{})},keepalive:true});
    const payload=await response.json().catch(()=>null) as {cancelled?:boolean}|null;
    return response.ok&&payload?.cancelled===true;
  }catch{return false;}
}
