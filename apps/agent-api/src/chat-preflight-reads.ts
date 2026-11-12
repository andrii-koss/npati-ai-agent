import type { AuthContext, WorkspaceStore } from "@npati/workspace";

/** Read-only routing snapshot. Never used for execution or reads after a write. */
export function chatPreflightReads(store: WorkspaceStore): WorkspaceStore {
  const reads = new Map<string, unknown>();
  return new Proxy(store, {
    get(target, property) {
      if (property === "getNeutralConversation" || property === "getConversation") {
        return (ctx: AuthContext, ...ids: string[]) => {
          const key = JSON.stringify([property, ctx.workspaceId, ctx.userId, ctx.companyId, ctx.permissions, ...ids]);
          if (!reads.has(key)) {
            const read = target[property] as (context: AuthContext, ...keys: string[]) => unknown;
            reads.set(key, read.call(target, ctx, ...ids));
          }
          return reads.get(key);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
