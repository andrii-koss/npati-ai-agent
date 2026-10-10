import { applyCodeInbox, emptyCodeInbox, type CodeInboxScope, type CodeInboxCommand, type CodeInboxStore, type CodeInboxState, type CodeInboxLease } from "./code-session-inbox";

export class MemoryCodeInboxStore implements CodeInboxStore {
  private readonly states = new Map<string, CodeInboxState>();
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly leases: (scope: CodeInboxScope) => Promise<CodeInboxLease[]>) {}
  async transact(scope: CodeInboxScope, command: CodeInboxCommand) {
    const key = JSON.stringify([scope.companyId, scope.sessionId]);
    const before = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, done);
    await before;
    try {
      const result = applyCodeInbox(this.states.get(key) ?? emptyCodeInbox(), command, await this.leases(scope), new Date());
      this.states.set(key, result.state);
      return structuredClone(result);
    } finally {
      release();
      if (this.locks.get(key) === done) this.locks.delete(key);
    }
  }
}
