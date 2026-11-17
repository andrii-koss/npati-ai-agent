import { statfs } from "node:fs/promises";

/**
 * Keeps an agent from filling the disk the whole installation runs on (V6 step 17, owner decision O17-05). It is a
 * safety guard, not a work quota: nothing is counted per project, and work continues as long as the disk has room.
 * Only when the disk is nearly full does an agent's next write or command stop with a plain reason, so the database
 * and every other service keep the room they need to stay consistent.
 *
 * Every Docker volume of the stand lives on one filesystem, so the API's own folder shows the space projects,
 * sandboxes and databases share. On Docker Desktop that filesystem is a virtual disk (about 1 TB) whose file grows on
 * the host drive, so "free space" inside says nothing about the host. `NPATI_DISK_MAX_USED_BYTES` therefore caps the
 * space in use as well: set it below the host drive's room for the virtual disk file.
 */
const DEFAULT_RESERVE_BYTES = 5 * 1024 ** 3;
const CACHE_MS = 10_000;

const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;

export class DiskSpaceLowError extends Error {
  readonly code = "disk_space_low";
  constructor(readonly freeBytes: number, readonly reserveBytes: number, readonly usedBytes?: number, readonly maxUsedBytes?: number) {
    super((maxUsedBytes !== undefined && usedBytes !== undefined && usedBytes >= maxUsedBytes
      ? `The server disk is at its limit (${formatBytes(usedBytes)} used of ${formatBytes(maxUsedBytes)} allowed). `
      : `The server disk is almost full (${formatBytes(freeBytes)} free, ${formatBytes(reserveBytes)} kept in reserve). `)
      + "New files and commands are paused so the system keeps working; free disk space and try again.");
    this.name = "DiskSpaceLowError";
  }
}

export interface DiskUsage { free: number; used: number }

export interface DiskSpaceGuardOptions {
  path?: string;
  reserveBytes?: number;
  maxUsedBytes?: number;
  usage?: (path: string) => Promise<DiskUsage>;
  now?: () => number;
}

const fromEnv = (name: string): number | undefined => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(value) && value >= 0 ? value : undefined;
};

export class DiskSpaceGuard {
  private readonly path: string;
  private readonly reserveBytes: number;
  private readonly maxUsedBytes?: number;
  private readonly usage: (path: string) => Promise<DiskUsage>;
  private readonly now: () => number;
  private last: { at: number; usage: DiskUsage } | null = null;

  constructor(options: DiskSpaceGuardOptions = {}) {
    this.path = options.path ?? process.env.NPATI_DISK_GUARD_PATH ?? process.cwd();
    this.reserveBytes = options.reserveBytes ?? fromEnv("NPATI_DISK_RESERVE_BYTES") ?? DEFAULT_RESERVE_BYTES;
    const maxUsed = options.maxUsedBytes ?? fromEnv("NPATI_DISK_MAX_USED_BYTES");
    if (maxUsed) this.maxUsedBytes = maxUsed;
    this.usage = options.usage ?? (async (path) => {
      const stats = await statfs(path);
      const size = Number(stats.bsize);
      return { free: Number(stats.bavail) * size, used: (Number(stats.blocks) - Number(stats.bfree)) * size };
    });
    this.now = options.now ?? Date.now;
  }

  /** Throws when the disk is below its reserve or above its allowed use; a disk that cannot be read never blocks work. */
  async assertRoom(): Promise<void> {
    if (this.reserveBytes === 0 && this.maxUsedBytes === undefined) return;
    if (!this.last || this.now() - this.last.at >= CACHE_MS) {
      try { this.last = { at: this.now(), usage: await this.usage(this.path) }; } catch { return; }
    }
    const { free, used } = this.last.usage;
    if ((this.reserveBytes > 0 && free < this.reserveBytes) || (this.maxUsedBytes !== undefined && used >= this.maxUsedBytes)) {
      throw new DiskSpaceLowError(free, this.reserveBytes, used, this.maxUsedBytes);
    }
  }
}
