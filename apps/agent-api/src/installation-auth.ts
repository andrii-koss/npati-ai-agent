import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface PersistedInstallationAuth {
  installationId: string;
  installationToken?: string;
  installationTokenExpiresAt?: string;
  browserSessionHash?: string;
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
    this.state = { ...state, installationToken, installationTokenExpiresAt: expiresAt };
    await this.persist();
  }

  async createBrowserSession(): Promise<string> {
    const value = randomBytes(32).toString("base64url");
    const state = await this.load();
    this.state = { ...state, browserSessionHash: hash(value) };
    await this.persist();
    return value;
  }

  async verifyBrowserSession(value?: string): Promise<boolean> {
    if (!value) return false;
    const expected = (await this.load()).browserSessionHash;
    if (!expected) return false;
    const actualBuffer = Buffer.from(hash(value));
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  }

  async clearBrowserSession() {
    const state = await this.load();
    this.state = { ...state, browserSessionHash: undefined };
    await this.persist();
  }

  async clearAuthorization() {
    const state = await this.load();
    this.state = { installationId: state.installationId };
    await this.persist();
  }
}
