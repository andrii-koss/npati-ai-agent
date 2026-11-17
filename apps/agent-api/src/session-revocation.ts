import { createHash } from "node:crypto";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";

/**
 * Sign-out that the API honours (V6 step 17, owner decision O17-04). An access token is checked against NPATI by
 * signature and expiry only, so after "Sign out" the token the page held kept opening the API until it expired
 * (15 min). Now:
 *   - "Sign out" revokes the token that signed out, until it would have expired;
 *   - "Sign out everywhere" revokes every token of the person issued up to that moment.
 * The list lives in the person's own settings (PostgreSQL), so a restart does not forget it; reads are cached briefly
 * and a revocation made by this process is visible at once.
 */
const KEY = "auth.session-revocations";
const CACHE_MS = 5_000;

interface Revocations { tokens: Array<{ hash: string; exp: number }>; allBefore: number }
type Store = Pick<WorkspaceStore, "getUserSetting" | "setUserSetting">;

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export class SessionRevocations {
  private readonly cache = new Map<string, { at: number; value: Revocations; revision: number }>();
  private lastReadFailureAt = -Infinity;

  constructor(private readonly store: Store, private readonly now: () => number = () => Date.now()) {}

  private cacheKey(ctx: Pick<AuthContext, "workspaceId" | "userId">) { return `${ctx.workspaceId}:${ctx.userId}`; }

  private async read(ctx: AuthContext, fresh = false) {
    const cached = this.cache.get(this.cacheKey(ctx));
    if (!fresh && cached && this.now() - cached.at < CACHE_MS) return cached;
    const row = await this.store.getUserSetting(ctx, KEY);
    const raw = (row?.value ?? {}) as Partial<Revocations>;
    const entry = { at: this.now(), revision: row?.revision ?? 0,
      value: { tokens: Array.isArray(raw.tokens) ? raw.tokens.filter((t) => typeof t?.hash === "string" && typeof t?.exp === "number") : [], allBefore: Number(raw.allBefore) || 0 } };
    this.cache.set(this.cacheKey(ctx), entry);
    return entry;
  }

  /** True when this token was signed out, or issued before the person signed out everywhere. */
  async isRevoked(ctx: AuthContext, token: string, issuedAt: number | undefined): Promise<boolean> {
    // A store that cannot be read does not lock everyone out: sign-in must keep working when workspace storage is down
    // (security gate G1). The token is still bounded by its own expiry; the failure is reported once per minute.
    let value: Revocations;
    try { ({ value } = await this.read(ctx)); }
    catch (error) {
      if (this.now() - this.lastReadFailureAt > 60_000) {
        this.lastReadFailureAt = this.now();
        console.error(`[auth] sign-out list could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    }
    // Strictly before: a sign-in right after "everywhere" in the same second stays valid; the token that signed out is
    // refused by its hash anyway.
    if (value.allBefore && (issuedAt ?? 0) < value.allBefore) return true;
    if (!value.tokens.length) return false;
    const hash = tokenHash(token);
    return value.tokens.some((entry) => entry.hash === hash);
  }

  async revoke(ctx: AuthContext, token: string, expiresAt: number, everywhere: boolean): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.read(ctx, true);
      const nowSec = Math.floor(this.now() / 1000);
      const next: Revocations = {
        // Entries past their token's expiry are dropped: such a token is refused by its expiry alone.
        tokens: [...current.value.tokens.filter((entry) => entry.exp > nowSec), { hash: tokenHash(token), exp: expiresAt }],
        allBefore: everywhere ? nowSec : current.value.allBefore,
      };
      const saved = await this.store.setUserSetting(ctx, KEY, next, current.revision);
      if (saved) {
        this.cache.set(this.cacheKey(ctx), { at: this.now(), value: next, revision: saved.revision });
        return;
      }
    }
    throw new Error("Sign-out could not be saved; try again");
  }
}
