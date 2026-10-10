import type { ChatRequest, ChatToolCall } from "./types";

/** Provider aliases exist only on the wire. Canonical NPATI tool IDs stay unchanged. */
export async function providerToolNames(request: ChatRequest) {
  const names = new Set<string>();
  for (const tool of request.tools ?? []) names.add(tool.function.name);
  for (const message of request.messages) {
    if (message.name) names.add(message.name);
    for (const call of message.tool_calls ?? []) names.add(call.function.name);
  }
  if (typeof request.toolChoice === "object") names.add(request.toolChoice.function.name);
  const valid = (name: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(name);
  const reserved = new Set([...names].filter(valid));
  const outgoing = new Map<string, string>(), incoming = new Map<string, string>();
  for (const name of [...names].sort()) {
    if (valid(name)) continue;
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const base = `npati_${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32)}_${hash.slice(0, 16)}`;
    let alias = base, suffix = 0;
    while (reserved.has(alias)) alias = `${base}_${++suffix}`;
    reserved.add(alias); outgoing.set(name, alias); incoming.set(alias, name);
  }
  const encode = (name: string) => outgoing.get(name) ?? name;
  const messages = request.messages.map(message => ({ ...message,
    ...(message.name ? { name: encode(message.name) } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function, name: encode(call.function.name) } })) } : {}),
  }));
  const tools = request.tools?.map(tool => ({ ...tool, function: { ...tool.function,
    name: encode(tool.function.name),
    ...(outgoing.has(tool.function.name) ? { description: `NPATI tool ${tool.function.name}. ${tool.function.description}` } : {}),
  } }));
  const toolChoice = typeof request.toolChoice === "object"
    ? { ...request.toolChoice, function: { name: encode(request.toolChoice.function.name) } } : request.toolChoice;
  const decode = (calls: ChatToolCall[]) => calls.map(call => ({ ...call, function: { ...call.function, name: incoming.get(call.function.name) ?? call.function.name } }));
  return { messages, tools, toolChoice, decode };
}
