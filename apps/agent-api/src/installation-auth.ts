import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface PersistedInstallationAuth {
  installationId: string;
  ownerUserId?: string;
  installationToken?: string;
  installationTokenExpiresAt?: string;
  browserSessionHash?: string;
  browserSessions?: Record<string, {
    installationToken: string;
    installationTokenExpiresAt: string;
  }>;
}

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export class InstallationAuthStore {
  private state?: PersistedInstallationAuth;
  private loading?: Promise<PersistedInstallationAuth>;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(dataDirectory?: string) {
    const directory = dataDirectory || process.env.NPATI_DATA_DIR || path.join(process.cwd(), ".npati-data");
    this.filePath = path.join(directory, "installation-auth.json");
  }

  private async persist(state: PersistedInstallationAuth) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async load(): Promise<PersistedInstallationAuth> {
    if (this.state) return this.state;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as PersistedInstallationAuth;
          this.state = { ...parsed, installationId: parsed.installationId || randomUUID() };
        } catch {
          const initial = { installationId: randomUUID() };
          await this.persist(initial);
          this.state = initial;
        }
        return this.state;
      })().finally(() => { this.loading = undefined; });
    }
    return this.loading;
  }

  async authorize(installationToken: string, expiresAt: string) {
    return this.mutate(async () => {
      const state = await this.load();
      const browserSessions = Object.fromEntries(Object.keys(state.browserSessions ?? {}).map((sessionHash) => [
        sessionHash,
        { installationToken, installationTokenExpiresAt: expiresAt },
      ]));
      const next = { ...state, installationToken, installationTokenExpiresAt: expiresAt, browserSessions };
      await this.persist(next);
      this.state = next;
    });
  }

  async createBrowserSession(installationToken: string, installationTokenExpiresAt: string): Promise<string> {
    return this.mutate(async () => {
      const value = randomBytes(32).toString("base64url");
      const state = await this.load();
      const now = Date.now();
      const browserSessions = Object.fromEntries(Object.entries(state.browserSessions ?? {})
        .filter(([, session]) => Date.parse(session.installationTokenExpiresAt) > now));
      browserSessions[hash(value)] = { installationToken, installationTokenExpiresAt };
      const next = { ...state, browserSessions };
      await this.persist(next);
      this.state = next;
      return value;
    });
  }

  /** Identity comes from the verified central installation session, never a browser body. */
  async bindOwner(userId: string): Promise<string> {
    if (!userId) throw new Error("Installation session has no owner identity");
    return this.mutate(async () => {
      const state = await this.load();
      if (state.ownerUserId) return state.ownerUserId;
      const next = { ...state, ownerUserId: userId };
      await this.persist(next);
      this.state = next;
      return userId;
    });
  }

  async getBrowserSession(value?: string): Promise<{ installationToken: string; installationTokenExpiresAt: string } | null> {
    if (!value) return null;
    const state = await this.load();
    const session = state.browserSessions?.[hash(value)];
    if (session && Date.parse(session.installationTokenExpiresAt) > Date.now()) return session;

    // Backwards compatibility for installations connected before per-browser sessions.
    const expected = state.browserSessionHash;
    if (!expected || !state.installationToken || !state.installationTokenExpiresAt) return null;
    const actualBuffer = Buffer.from(hash(value));
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    return {
      installationToken: state.installationToken,
      installationTokenExpiresAt: state.installationTokenExpiresAt,
    };
  }

  async clearBrowserSession(value?: string) {
    if (!value) return;
    return this.mutate(async () => {
      const state = await this.load();
      const browserSessions = { ...(state.browserSessions ?? {}) };
      delete browserSessions[hash(value)];
      const next = { ...state, browserSessions };
      await this.persist(next);
      this.state = next;
    });
  }

  async clearAuthorization() {
    return this.mutate(async () => {
      const state = await this.load();
      const next = { installationId: state.installationId, ownerUserId: state.ownerUserId, browserSessions: {} };
      await this.persist(next);
      this.state = next;
    });
  }
}
