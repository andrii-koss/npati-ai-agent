import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The OmniRoute API key an inference request is made with.
 *
 * On a hosted (SaaS) installation every account has its own OmniRoute key whose `allowedConnections` lists only that
 * account's provider connections, so OmniRoute itself refuses any other account's credentials — for named models,
 * `auto` routing, combos and fallbacks alike. The key is carried through the async call chain instead of through every
 * `ChatRequest`, so no call site can forget it: an inference made outside a scope is refused when the engine requires
 * one (see `OmniRouteConfig.requireScopedCredential`).
 */
export interface OmniRouteCredential {
  /** The account's OmniRoute key; set once the account is known (a request scope starts before authentication). */
  apiKey?: string;
  /** The account's own model for a request that names none or asks for `auto` (the shared catalog is never used). */
  resolveAutoModel?: () => Promise<string | undefined>;
}

const scope = new AsyncLocalStorage<OmniRouteCredential | null>();

/** Runs `fn` with `credential` as the OmniRoute key for every inference request made inside it. */
export function withOmniRouteCredential<T>(credential: OmniRouteCredential | null, fn: () => T): T {
  return scope.run(credential, fn);
}

/** The key set by the innermost `withOmniRouteCredential`, `null` when it set none, `undefined` outside any scope. */
export function currentOmniRouteCredential(): OmniRouteCredential | null | undefined {
  return scope.getStore();
}
