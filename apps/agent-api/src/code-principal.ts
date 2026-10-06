/**
 * C5a — the single principal classifier for every `code.*` surface.
 *
 * It lives in its own leaf module because both halves of the people-side authorization need it and they
 * import one another for the role matrix (`code-rbac.ts` reads `DEFAULT_COMPANY_ROLE_MATRIX` from
 * `code-membership.ts`), so sharing the function *from* `code-rbac.ts` would make that a cycle: the
 * classification of a principal is a primitive fact about the token, not an RBAC decision.
 *
 * Conservative by construction: any `agent:` / `service:` marker wins, so an agent token cannot present
 * itself as a user. `code-rbac.ts` re-exports it, so existing importers are unaffected.
 */
export type CodePrincipalKind = "user" | "agent" | "service";

/** Prefixes that identify a non-human principal. They are exact prefixes, never substrings (C5a D10). */
export const CODE_AGENT_PRINCIPAL_PREFIXES = ["agent:", "service:"] as const;

/**
 * Structural view of the principal. Deliberately accepts `null`/`undefined` user ids: the people-side
 * modules carry an unauthenticated actor as `userId: null`, and classification must answer for it
 * (`"user"` with no id is still refused where an id is required) instead of forcing a cast at the call
 * site.
 */
export interface CodePrincipalSubject {
  userId?: string | null;
  externalSubject?: string | null;
}

export function classifyPrincipal(ctx: CodePrincipalSubject): CodePrincipalKind {
  const subject = String(ctx.externalSubject ?? "");
  const userId = String(ctx.userId ?? "");
  if (subject.startsWith("service:") || userId.startsWith("service:")) return "service";
  if (subject.startsWith("agent:") || userId.startsWith("agent:")) return "agent";
  return "user";
}

/** True for anything that is not a human user: the fail-closed direction for every administrative path. */
export function isNonHumanPrincipal(ctx: CodePrincipalSubject): boolean {
  return classifyPrincipal(ctx) !== "user";
}
