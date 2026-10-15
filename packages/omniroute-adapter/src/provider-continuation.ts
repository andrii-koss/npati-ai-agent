import type { ChatMessage, ChatResult } from "./types";

// Symbols survive object spreads in resilience wrappers, but JSON serialization
// of public chat results never exposes provider continuation state.
const continuation = Symbol("provider-continuation");
type State = Pick<ChatMessage, "reasoning_content" | "reasoning_text">;
export function retainProviderContinuation<T extends ChatResult>(result: T, message: State | undefined): T {
  const state: State = {};
  for (const key of ["reasoning_content", "reasoning_text"] as const) {
    if (typeof message?.[key] === "string") state[key] = message[key];
  }
  return Object.keys(state).length ? Object.assign(result, {[continuation]:state}) : result;
}
export function providerContinuationFor(result: ChatResult): State {
  return (result as ChatResult & {[continuation]?:State})[continuation] ?? {};
}
