import { applyCodeProcess, type CodeProcessScope, type CodeProcessCommand, type CodeProcessStore, type CodeProcessProjectState, type ProcessRunLease } from "./code-process-store";
export class MemoryCodeProcessStore implements CodeProcessStore {
  private readonly states = new Map<string, CodeProcessProjectState>();
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly leases: (scope: CodeProcessScope) => Promise<ProcessRunLease[]>) {}
  async transact(scope: CodeProcessScope, command: CodeProcessCommand) {
    const key = JSON.stringify([scope.companyId, scope.projectId]);
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; }); this.locks.set(key, done);
    await prior;
    try {
      const result = applyCodeProcess(this.states.get(key) ?? { operations: [], cleanupToken: null }, scope, command, await this.leases(scope), new Date());
      this.states.set(key, result.state); return result.result;
    } finally { release(); if (this.locks.get(key) === done) this.locks.delete(key); }
  }
}
