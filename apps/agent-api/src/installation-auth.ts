import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface PersistedInstallationAuth {
  installationId: string;
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
  private readonly filePath: string;

  constructor(dataDirectory?: string) {
    const directory = dataDirectory || process.env.NPATI_DATA_DIR || path.join(process.cwd(), ".npati-data");
    this.filePath = path.join(directory, "installation-auth.json");
  }

  private async persist() {
    if (!this.state) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  async load(): Promise<PersistedInstallationAuth> {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as PersistedInstallationAuth;
      this.state = { ...parsed, installationId: parsed.installationId || randomUUID() };
    } catch {
      this.state = { installationId: randomUUID() };
      await this.persist();
    }
    return this.state;
  }

  async authorize(installationToken: string, expiresAt: string) {
    const state = await this.load();
    const browserSessions = Object.fromEntries(Object.keys(state.browserSessions ?? {}).map((sessionHash) => [
      sessionHash,
      { installationToken, installationTokenExpiresAt: expiresAt },
    ]));
    this.state = {
      ...state,
      installationToken,
      installationTokenExpiresAt: expiresAt,
      browserSessions,
    };
    await this.persist();
  }

  async createBrowserSession(installationToken: string, installationTokenExpiresAt: string): Promise<string> {
    const value = randomBytes(32).toString("base64url");
    const state = await this.load();
    const now = Date.now();
    const browserSessions = Object.fromEntries(Object.entries(state.browserSessions ?? {})
      .filter(([, session]) => Date.parse(session.installationTokenExpiresAt) > now));
    browserSessions[hash(value)] = { installationToken, installationTokenExpiresAt };
    this.state = { ...state, browserSessions };
    await this.persist();
    return value;
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
    const state = await this.load();
    const browserSessions = { ...(state.browserSessions ?? {}) };
    if (value) delete browserSessions[hash(value)];
    this.state = {
      ...state,
      browserSessionHash: value ? state.browserSessionHash : undefined,
      browserSessions: value ? browserSessions : {},
    };
    await this.persist();
  }

  async clearAuthorization() {
    const state = await this.load();
    this.state = { installationId: state.installationId, browserSessions: {} };
    await this.persist();
  }
}
