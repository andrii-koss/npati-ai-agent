import { randomUUID } from "node:crypto";

export interface ProjectFileLease {
  id: string;
  projectId: string;
  agentId: string;
  taskId?: string;
  paths: string[];
  acquiredAt: number;
  expiresAt: number;
}

export interface ProjectFileLeaseOptions {
  taskId?: string;
  ttlMs?: number;
  timeoutMs?: number;
}

export class ProjectFileLockError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(`[${code}] ${message}`);
    this.name = "ProjectFileLockError";
  }
}

export function normalizeLockPath(scope: string): string {
  if (typeof scope !== "string" || !scope.trim()) return "";
  const cleaned = scope.replace(/\\/g, "/").trim();
  if (cleaned.includes("\0") || cleaned.startsWith("/") || /^[a-z]:/i.test(cleaned)) {
    throw new ProjectFileLockError("invalid_scope", "Invalid file lock scope: absolute paths forbidden", 400);
  }
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.startsWith(".npati-"))) {
    throw new ProjectFileLockError("invalid_scope", "Invalid file lock scope: directory traversal forbidden", 400);
  }
  return parts.join("/");
}

export function pathsConflict(pathA: string, pathB: string): boolean {
  const a = normalizeLockPath(pathA);
  const b = normalizeLockPath(pathB);
  if (!a || !b) return true; // Empty / root scope conflicts with everything
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

export function pathSetsConflict(setA: string[], setB: string[]): boolean {
  if (!setA.length || !setB.length) return true;
  return setA.some((a) => setB.some((b) => pathsConflict(a, b)));
}

interface QueuedWaiter {
  id: string;
  projectId: string;
  agentId: string;
  paths: string[];
  options: ProjectFileLeaseOptions;
  resolve: (lease: ProjectFileLease) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class ProjectFileLeaseManager {
  private readonly activeLeases = new Map<string, ProjectFileLease>();
  private readonly projectLeases = new Map<string, Set<string>>();
  private readonly waiters: QueuedWaiter[] = [];
  private readonly waitGraph = new Map<string, Set<string>>(); // waitingAgentId -> Set<holdingAgentIds>
  private readonly defaultTtlMs: number;
  private readonly defaultTimeoutMs: number;

  constructor(options?: { defaultTtlMs?: number; defaultTimeoutMs?: number }) {
    const envTtl = Number(process.env.NPATI_FILE_LOCK_TTL_MS);
    this.defaultTtlMs = options?.defaultTtlMs ?? (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : 30_000);
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 5_000;
  }

  purgeExpired(now = Date.now()): void {
    for (const [leaseId, lease] of this.activeLeases.entries()) {
      if (lease.expiresAt <= now) {
        this.activeLeases.delete(leaseId);
        const set = this.projectLeases.get(lease.projectId);
        if (set) {
          set.delete(leaseId);
          if (set.size === 0) this.projectLeases.delete(lease.projectId);
        }
      }
    }
  }

  private detectCycle(startAgentId: string, currentAgentId: string, visited = new Set<string>()): boolean {
    if (visited.has(currentAgentId)) return false;
    visited.add(currentAgentId);
    const dependencies = this.waitGraph.get(currentAgentId);
    if (!dependencies) return false;
    if (dependencies.has(startAgentId)) return true;
    for (const next of dependencies) {
      if (this.detectCycle(startAgentId, next, visited)) return true;
    }
    return false;
  }

  private findConflictingHolders(projectId: string, agentId: string, normalizedPaths: string[]): ProjectFileLease[] {
    const leaseIds = this.projectLeases.get(projectId);
    if (!leaseIds) return [];
    const holders: ProjectFileLease[] = [];
    const now = Date.now();
    for (const leaseId of leaseIds) {
      const lease = this.activeLeases.get(leaseId);
      if (!lease || lease.expiresAt <= now) continue;
      if (lease.agentId === agentId) continue; // Same agent can re-enter / expand
      if (normalizedPaths.length === 0 || lease.paths.length === 0) {
        holders.push(lease);
      } else if (normalizedPaths.some((p) => lease.paths.some((lp) => pathsConflict(p, lp)))) {
        holders.push(lease);
      }
    }
    return holders;
  }

  async acquire(
    projectId: string,
    agentId: string,
    paths: string[],
    options: ProjectFileLeaseOptions = {},
  ): Promise<ProjectFileLease> {
    this.purgeExpired();
    // Canonical lexicographical sort of unique normalized paths prevents lock-ordering deadlocks
    const normalizedPaths = [...new Set(paths.map(normalizeLockPath))].sort();
    const ttl = Math.max(1, options.ttlMs ?? this.defaultTtlMs);
    const timeout = Math.max(10, options.timeoutMs ?? this.defaultTimeoutMs);

    const conflictingHolders = this.findConflictingHolders(projectId, agentId, normalizedPaths);
    if (conflictingHolders.length === 0) {
      return this.createLease(projectId, agentId, normalizedPaths, options.taskId, ttl);
    }

    // Deadlock detection: check if any of the holders is directly or transitively waiting on this agent
    const holdingAgentIds = new Set(conflictingHolders.map((h) => h.agentId));
    for (const holderId of holdingAgentIds) {
      if (this.detectCycle(agentId, holderId)) {
        throw new ProjectFileLockError(
          "deadlock_detected",
          `Deadlock detected between agent ${agentId} and ${holderId} across file locks`,
          409,
        );
      }
    }

    // Register waiting dependency
    const currentWait = this.waitGraph.get(agentId) ?? new Set<string>();
    for (const holderId of holdingAgentIds) currentWait.add(holderId);
    this.waitGraph.set(agentId, currentWait);

    return new Promise<ProjectFileLease>((resolve, reject) => {
      const waiterId = randomUUID();
      const timer = setTimeout(() => {
        this.removeWaiter(waiterId);
        this.cleanWaitGraph(agentId);
        reject(
          new ProjectFileLockError(
            "lock_timeout",
            `Timeout (${timeout}ms) waiting for file lock on [${normalizedPaths.join(", ") || "*"}]`,
            408,
          ),
        );
      }, timeout);
      timer.unref?.();

      this.waiters.push({
        id: waiterId,
        projectId,
        agentId,
        paths: normalizedPaths,
        options: { ...options, ttlMs: ttl },
        resolve: (lease) => {
          clearTimeout(timer);
          this.cleanWaitGraph(agentId);
          resolve(lease);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.cleanWaitGraph(agentId);
          reject(err);
        },
        timer,
      });
    });
  }

  private createLease(
    projectId: string,
    agentId: string,
    paths: string[],
    taskId: string | undefined,
    ttlMs: number,
  ): ProjectFileLease {
    const now = Date.now();
    const lease: ProjectFileLease = {
      id: randomUUID(),
      projectId,
      agentId,
      taskId,
      paths,
      acquiredAt: now,
      expiresAt: now + ttlMs,
    };
    this.activeLeases.set(lease.id, lease);
    let projectSet = this.projectLeases.get(projectId);
    if (!projectSet) {
      projectSet = new Set();
      this.projectLeases.set(projectId, projectSet);
    }
    projectSet.add(lease.id);
    return lease;
  }

  private removeWaiter(waiterId: string): void {
    const index = this.waiters.findIndex((w) => w.id === waiterId);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private cleanWaitGraph(agentId: string): void {
    this.waitGraph.delete(agentId);
  }

  release(leaseId: string): boolean {
    const lease = this.activeLeases.get(leaseId);
    if (!lease) return false;
    this.activeLeases.delete(leaseId);
    const set = this.projectLeases.get(lease.projectId);
    if (set) {
      set.delete(leaseId);
      if (set.size === 0) this.projectLeases.delete(lease.projectId);
    }
    this.processWaiters();
    return true;
  }

  releaseAgentLeases(projectId: string, agentId: string): number {
    this.purgeExpired();
    const leaseIds = this.projectLeases.get(projectId);
    if (!leaseIds) return 0;
    let released = 0;
    for (const leaseId of [...leaseIds]) {
      const lease = this.activeLeases.get(leaseId);
      if (lease && lease.agentId === agentId) {
        this.activeLeases.delete(leaseId);
        leaseIds.delete(leaseId);
        released++;
      }
    }
    if (leaseIds.size === 0) this.projectLeases.delete(projectId);
    this.cleanWaitGraph(agentId);
    if (released > 0) this.processWaiters();
    return released;
  }

  releaseTaskLeases(projectId: string, taskId: string): number {
    this.purgeExpired();
    const leaseIds = this.projectLeases.get(projectId);
    if (!leaseIds) return 0;
    let released = 0;
    for (const leaseId of [...leaseIds]) {
      const lease = this.activeLeases.get(leaseId);
      if (lease && lease.taskId === taskId) {
        this.activeLeases.delete(leaseId);
        leaseIds.delete(leaseId);
        released++;
      }
    }
    if (leaseIds.size === 0) this.projectLeases.delete(projectId);
    if (released > 0) this.processWaiters();
    return released;
  }

  private processWaiters(): void {
    this.purgeExpired();
    for (let i = 0; i < this.waiters.length; i++) {
      const waiter = this.waiters[i];
      if (!waiter) continue;
      const conflicting = this.findConflictingHolders(waiter.projectId, waiter.agentId, waiter.paths);
      if (conflicting.length === 0) {
        this.waiters.splice(i, 1);
        i--;
        const lease = this.createLease(
          waiter.projectId,
          waiter.agentId,
          waiter.paths,
          waiter.options.taskId,
          waiter.options.ttlMs ?? this.defaultTtlMs,
        );
        waiter.resolve(lease);
      }
    }
  }

  isLocked(
    projectId: string,
    filePath: string,
    excludeAgentId?: string,
  ): { locked: boolean; ownerAgentId?: string; leaseId?: string } {
    this.purgeExpired();
    const normalized = normalizeLockPath(filePath);
    const leaseIds = this.projectLeases.get(projectId);
    if (!leaseIds) return { locked: false };
    const now = Date.now();
    for (const leaseId of leaseIds) {
      const lease = this.activeLeases.get(leaseId);
      if (!lease || lease.expiresAt <= now) continue;
      if (excludeAgentId && lease.agentId === excludeAgentId) continue;
      if (lease.paths.length === 0 || lease.paths.some((p) => pathsConflict(normalized, p))) {
        return { locked: true, ownerAgentId: lease.agentId, leaseId: lease.id };
      }
    }
    return { locked: false };
  }

  getActiveLeases(projectId?: string): ProjectFileLease[] {
    this.purgeExpired();
    const all = [...this.activeLeases.values()];
    if (!projectId) return all;
    return all.filter((l) => l.projectId === projectId);
  }

  clear(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new ProjectFileLockError("lock_cleared", "File lock manager cleared", 409));
    }
    this.waiters.length = 0;
    this.activeLeases.clear();
    this.projectLeases.clear();
    this.waitGraph.clear();
  }
}
