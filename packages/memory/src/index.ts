export type MemoryKind =
  | "business_profile"
  | "brand"
  | "product"
  | "customer"
  | "goal"
  | "preference"
  | "sales_channel"
  | "decision"
  | "experiment"
  | "performance"
  | "recommendation";

export interface MemoryRecord<T = unknown> {
  id: string;
  kind: MemoryKind;
  content: T;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryProvider {
  remember<T>(kind: MemoryKind, content: T): Promise<MemoryRecord<T>>;
  search(query: string): Promise<MemoryRecord[]>;
  forget(id: string): Promise<boolean>;
  update<T>(id: string, content: T): Promise<MemoryRecord<T> | undefined>;
  list(kind?: MemoryKind): Promise<MemoryRecord[]>;
}

const secretKeys = /api[_-]?key|oauth|password|access[_-]?token|refresh[_-]?token/i;
const secretValues = /(?:sk-[a-z0-9]{16,}|bearer\s+[a-z0-9._-]{12,})/i;

export function assertNoSecrets(value: unknown): void {
  if (typeof value === "string" && secretValues.test(value)) {
    throw new Error("Secrets must not be stored in business memory");
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (secretKeys.test(key)) throw new Error(`Secrets must not be stored in business memory: ${key}`);
      assertNoSecrets(nested);
    }
  }
}

export interface BusinessMemoryScope {
  workspaceId: string;
  businessId: string;
  userId: string;
}

export class InMemoryProvider implements MemoryProvider {
  private readonly records = new Map<string, MemoryRecord>();

  async remember<T>(kind: MemoryKind, content: T): Promise<MemoryRecord<T>> {
    assertNoSecrets(content);
    const now = new Date().toISOString();
    const record: MemoryRecord<T> = { id: crypto.randomUUID(), kind, content, createdAt: now, updatedAt: now };
    this.records.set(record.id, record);
    return record;
  }

  async search(query: string): Promise<MemoryRecord[]> {
    const needle = query.toLocaleLowerCase();
    return [...this.records.values()].filter((record) =>
      JSON.stringify(record.content).toLocaleLowerCase().includes(needle),
    );
  }

  async forget(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async update<T>(id: string, content: T): Promise<MemoryRecord<T> | undefined> {
    assertNoSecrets(content);
    const existing = this.records.get(id);
    if (!existing) return undefined;
    const updated: MemoryRecord<T> = { ...existing, content, updatedAt: new Date().toISOString() };
    this.records.set(id, updated);
    return updated;
  }

  async list(kind?: MemoryKind): Promise<MemoryRecord[]> {
    return [...this.records.values()].filter((record) => !kind || record.kind === kind);
  }
}
