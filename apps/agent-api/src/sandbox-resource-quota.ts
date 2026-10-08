/**
 * R1 (section A, items 1, 4 and 5) — the sandbox's own resource ceilings, the **aggregate** ceiling for one
 * Company, and admission control on the host's own load.
 *
 * Three limits, one module, because they answer one question three ways: "may this container exist at all?"
 *
 *  1. **Per sandbox** (`SandboxResourceLimits`). The values were already enforced by
 *     `DockerSandboxProvider`/`buildSandboxCreateArgs` (`--cpus`, `--memory`, `--tmpfs …,size=`, `--pids-limit`)
 *     — what R1 changes is the *start values* (2 vCPU / 4 GB / 10 GB / 512 pids instead of 1 / 1.5 GB / 1.5 GB
 *     / 128) and, more importantly, that they are readable from the environment as first-class settings rather
 *     than as an undocumented override of the runner's literals.
 *  2. **Per Company, aggregated** (`SandboxCompanyQuota`). A per-container ceiling bounds one runaway process;
 *     it does not bound a Company that starts twenty containers. The aggregate is what makes a Company quota a
 *     quota: five sandboxes, and no more than 10 vCPU / 20 GB / 50 GB / 2560 pids in total by default.
 *  3. **Per host** (`HostAdmissionController`). Every ceiling above is a promise about a container; this one is
 *     a statement about the machine that would run it. If the host is already above 80 % CPU or below 15 % free
 *     memory, a new sandbox is not started — the container would not fail loudly, it would make everything
 *     already running (including the Company runs that share the host) slower and less reliable.
 *
 * **What this module must never gate.** It gates *sandbox creation* and nothing else. The Company run queue in
 * `app.ts` (`resilience-admission-queue.ts`, the `admissionGate` port) is a different limit with a different
 * failure mode: a Company run that is refused does no work at all, while a sandbox that is refused only means
 * the agent waits or falls back. Wiring this host verdict into that gate would let "the browser-qa container
 * pushed CPU to 85 %" stop the whole Company product — which is why the module is imported by the sandbox
 * provider and by the sandbox runner only, and why `tests/coding-agent-r1a-sandbox-quotas.test.ts` asserts
 * that the Company-run modules never reference it.
 *
 * All values are configuration; nonsense falls back to the documented default rather than to "unlimited",
 * because a limiter that disappears on a typo is not a limiter.
 */

import os from "node:os";

/** Per-sandbox ceilings, in the units the provider needs. */
export interface SandboxResourceLimits {
  /** vCPU, an integer ≥ 1: Docker's `--cpus` accepts fractions, a quota should not. */
  cpu: number;
  memoryMb: number;
  diskBytes: number;
  pids: number;
}

/** Aggregate ceilings for one Company, plus the parallel-sandbox cap (R1 A.1: 5 per Company). */
export interface SandboxCompanyQuotaConfig {
  maxSandboxesPerCompany: number;
  maxCpuPerCompany: number;
  maxMemoryMbPerCompany: number;
  maxDiskBytesPerCompany: number;
  maxPidsPerCompany: number;
}

/** R1 start values: 2 vCPU, 4 GB RAM, 10 GB disk, 512 pids per sandbox. */
export const DEFAULT_SANDBOX_RESOURCE_LIMITS: SandboxResourceLimits = {
  cpu: 2,
  memoryMb: 4_096,
  diskBytes: 10 * 1024 * 1024 * 1024,
  pids: 512,
};

/** R1 start values: five parallel sandboxes per Company and the aggregate of five of them. */
export const DEFAULT_SANDBOX_COMPANY_QUOTA: SandboxCompanyQuotaConfig = {
  maxSandboxesPerCompany: 5,
  maxCpuPerCompany: 5 * DEFAULT_SANDBOX_RESOURCE_LIMITS.cpu,
  maxMemoryMbPerCompany: 5 * DEFAULT_SANDBOX_RESOURCE_LIMITS.memoryMb,
  maxDiskBytesPerCompany: 5 * DEFAULT_SANDBOX_RESOURCE_LIMITS.diskBytes,
  maxPidsPerCompany: 5 * DEFAULT_SANDBOX_RESOURCE_LIMITS.pids,
};

/** Hard ceilings: configuration may lower these, never raise them past what one node can serve. */
export const SANDBOX_QUOTA_MAX_SANDBOXES_PER_COMPANY = 64;
export const SANDBOX_QUOTA_MAX_CPU_PER_COMPANY = 512;
export const SANDBOX_QUOTA_MAX_MEMORY_MB_PER_COMPANY = 1_048_576;
export const SANDBOX_QUOTA_MAX_DISK_BYTES_PER_COMPANY = 1024 * 1024 * 1024 * 1024;
export const SANDBOX_QUOTA_MAX_PIDS_PER_COMPANY = 65_536;

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/**
 * Docker's memory syntax, parsed into megabytes. `4096m` → 4096, `4g` → 4096, `512k` → 1 (rounded up, so a
 * container is never described as using less memory than it was given). Anything unparseable yields the
 * fallback: the provider must never receive `NaN` as a memory ceiling.
 */
export function parseSandboxMemoryMb(value: string | number | undefined, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kmg])?\s*$/i.exec(String(value ?? ""));
  if (!match) return fallback;
  const amount = Number.parseFloat(match[1]!);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;
  const unit = (match[2] ?? "m").toLowerCase();
  const mb = unit === "g" ? amount * 1024 : unit === "k" ? amount / 1024 : amount;
  return Math.max(1, Math.ceil(mb));
}

/** The Docker `--memory` argument for a megabyte ceiling, so one number drives both the flag and the quota. */
export function sandboxMemoryArg(memoryMb: number): string {
  return `${Math.max(1, Math.trunc(memoryMb))}m`;
}

/** Reads the per-sandbox ceilings from the environment, clamping every value. */
export function resolveSandboxResourceLimits(env: NodeJS.ProcessEnv = process.env): SandboxResourceLimits {
  const memoryMb = env.NPATI_SANDBOX_MEMORY_MB !== undefined && env.NPATI_SANDBOX_MEMORY_MB !== ""
    ? positiveInt(env.NPATI_SANDBOX_MEMORY_MB, DEFAULT_SANDBOX_RESOURCE_LIMITS.memoryMb)
    : parseSandboxMemoryMb(env.NPATI_SANDBOX_MEMORY, DEFAULT_SANDBOX_RESOURCE_LIMITS.memoryMb);
  return {
    cpu: Math.min(positiveInt(env.NPATI_SANDBOX_CPU, DEFAULT_SANDBOX_RESOURCE_LIMITS.cpu), 64),
    memoryMb: Math.min(memoryMb, 262_144),
    diskBytes: Math.min(positiveInt(env.NPATI_SANDBOX_DISK_BYTES, DEFAULT_SANDBOX_RESOURCE_LIMITS.diskBytes), 1024 * 1024 * 1024 * 1024),
    pids: Math.min(positiveInt(env.NPATI_SANDBOX_PIDS, DEFAULT_SANDBOX_RESOURCE_LIMITS.pids), 32_768),
  };
}

/** Reads the per-Company aggregate ceilings from the environment, clamping every value to its hard ceiling. */
export function resolveSandboxCompanyQuota(env: NodeJS.ProcessEnv = process.env): SandboxCompanyQuotaConfig {
  return {
    maxSandboxesPerCompany: Math.min(
      positiveInt(env.NPATI_SANDBOX_MAX_PER_COMPANY, DEFAULT_SANDBOX_COMPANY_QUOTA.maxSandboxesPerCompany),
      SANDBOX_QUOTA_MAX_SANDBOXES_PER_COMPANY,
    ),
    maxCpuPerCompany: Math.min(
      positiveInt(env.NPATI_SANDBOX_MAX_CPU_PER_COMPANY, DEFAULT_SANDBOX_COMPANY_QUOTA.maxCpuPerCompany),
      SANDBOX_QUOTA_MAX_CPU_PER_COMPANY,
    ),
    maxMemoryMbPerCompany: Math.min(
      positiveInt(env.NPATI_SANDBOX_MAX_MEMORY_MB_PER_COMPANY, DEFAULT_SANDBOX_COMPANY_QUOTA.maxMemoryMbPerCompany),
      SANDBOX_QUOTA_MAX_MEMORY_MB_PER_COMPANY,
    ),
    maxDiskBytesPerCompany: Math.min(
      positiveInt(env.NPATI_SANDBOX_MAX_DISK_BYTES_PER_COMPANY, DEFAULT_SANDBOX_COMPANY_QUOTA.maxDiskBytesPerCompany),
      SANDBOX_QUOTA_MAX_DISK_BYTES_PER_COMPANY,
    ),
    maxPidsPerCompany: Math.min(
      positiveInt(env.NPATI_SANDBOX_MAX_PIDS_PER_COMPANY, DEFAULT_SANDBOX_COMPANY_QUOTA.maxPidsPerCompany),
      SANDBOX_QUOTA_MAX_PIDS_PER_COMPANY,
    ),
  };
}

export type SandboxQuotaErrorCode =
  | "sandbox_company_quota_exceeded"
  | "sandbox_company_resource_quota_exceeded"
  | "host_overloaded";

/** A refusal to create a sandbox. Distinct from `SandboxProviderError` so the quota cannot be mistaken for a
 * Docker failure: one is a policy decision with a retry-after, the other is an incident. */
export class SandboxQuotaError extends Error {
  constructor(
    readonly code: SandboxQuotaErrorCode,
    message: string,
    readonly status = 429,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "SandboxQuotaError";
  }
}

interface CompanyUsage {
  projects: Set<string>;
  cpu: number;
  memoryMb: number;
  diskBytes: number;
  pids: number;
}

/**
 * The aggregate Company quota. Admission is per (Company, project) and **idempotent**: `ensure()` in
 * `ProjectSandboxService` retries the same project, and counting that retry twice would refuse a Company its
 * own sandbox. Release is idempotent too — a `destroy` for something already gone is a no-op, not an error.
 */
export class SandboxCompanyQuota {
  readonly config: SandboxCompanyQuotaConfig;
  readonly limits: SandboxResourceLimits;
  private readonly companies = new Map<string, CompanyUsage>();

  constructor(config: Partial<SandboxCompanyQuotaConfig> = {}, limits: Partial<SandboxResourceLimits> = {}) {
    const mergedConfig = { ...DEFAULT_SANDBOX_COMPANY_QUOTA, ...config };
    const mergedLimits = { ...DEFAULT_SANDBOX_RESOURCE_LIMITS, ...limits };
    this.limits = {
      cpu: Math.max(1, Math.min(Math.trunc(mergedLimits.cpu), 64)),
      memoryMb: Math.max(1, Math.min(Math.trunc(mergedLimits.memoryMb), 262_144)),
      diskBytes: Math.max(16_000_000, Math.min(Math.trunc(mergedLimits.diskBytes), 1024 * 1024 * 1024 * 1024)),
      pids: Math.max(16, Math.min(Math.trunc(mergedLimits.pids), 32_768)),
    };
    this.config = {
      maxSandboxesPerCompany: Math.max(1, Math.min(Math.trunc(mergedConfig.maxSandboxesPerCompany), SANDBOX_QUOTA_MAX_SANDBOXES_PER_COMPANY)),
      maxCpuPerCompany: Math.max(1, Math.min(Math.trunc(mergedConfig.maxCpuPerCompany), SANDBOX_QUOTA_MAX_CPU_PER_COMPANY)),
      maxMemoryMbPerCompany: Math.max(1, Math.min(Math.trunc(mergedConfig.maxMemoryMbPerCompany), SANDBOX_QUOTA_MAX_MEMORY_MB_PER_COMPANY)),
      maxDiskBytesPerCompany: Math.max(1, Math.min(Math.trunc(mergedConfig.maxDiskBytesPerCompany), SANDBOX_QUOTA_MAX_DISK_BYTES_PER_COMPANY)),
      maxPidsPerCompany: Math.max(1, Math.min(Math.trunc(mergedConfig.maxPidsPerCompany), SANDBOX_QUOTA_MAX_PIDS_PER_COMPANY)),
    };
  }

  /** Throws `SandboxQuotaError` when this Company cannot take one more sandbox. */
  admit(scope: { companyId: string; projectId: string }): void {
    const existing = this.companies.get(scope.companyId);
    if (existing?.projects.has(scope.projectId)) return;
    const usage: CompanyUsage = existing ?? { projects: new Set<string>(), cpu: 0, memoryMb: 0, diskBytes: 0, pids: 0 };
    if (usage.projects.size + 1 > this.config.maxSandboxesPerCompany) {
      throw new SandboxQuotaError(
        "sandbox_company_quota_exceeded",
        `The Company already runs ${usage.projects.size} of its ${this.config.maxSandboxesPerCompany} parallel sandboxes; the new sandbox was not created. ` +
          `The limit is configurable with NPATI_SANDBOX_MAX_PER_COMPANY.`,
      );
    }
    const over: string[] = [];
    if (usage.cpu + this.limits.cpu > this.config.maxCpuPerCompany) over.push(`cpu ${usage.cpu + this.limits.cpu}/${this.config.maxCpuPerCompany}`);
    if (usage.memoryMb + this.limits.memoryMb > this.config.maxMemoryMbPerCompany) over.push(`memory ${usage.memoryMb + this.limits.memoryMb}MB/${this.config.maxMemoryMbPerCompany}MB`);
    if (usage.diskBytes + this.limits.diskBytes > this.config.maxDiskBytesPerCompany) over.push(`disk ${usage.diskBytes + this.limits.diskBytes}/${this.config.maxDiskBytesPerCompany} bytes`);
    if (usage.pids + this.limits.pids > this.config.maxPidsPerCompany) over.push(`pids ${usage.pids + this.limits.pids}/${this.config.maxPidsPerCompany}`);
    if (over.length > 0) {
      throw new SandboxQuotaError(
        "sandbox_company_resource_quota_exceeded",
        `The new sandbox would exceed this Company's aggregate sandbox quota (${over.join(", ")}); it was not created. ` +
          `The aggregate limits are configurable with NPATI_SANDBOX_MAX_CPU_PER_COMPANY, NPATI_SANDBOX_MAX_MEMORY_MB_PER_COMPANY, ` +
          `NPATI_SANDBOX_MAX_DISK_BYTES_PER_COMPANY and NPATI_SANDBOX_MAX_PIDS_PER_COMPANY.`,
      );
    }
    usage.projects.add(scope.projectId);
    usage.cpu += this.limits.cpu;
    usage.memoryMb += this.limits.memoryMb;
    usage.diskBytes += this.limits.diskBytes;
    usage.pids += this.limits.pids;
    this.companies.set(scope.companyId, usage);
  }

  /** Gives one sandbox back. Idempotent: releasing something never admitted is a no-op. */
  release(scope: { companyId: string; projectId: string }): void {
    const usage = this.companies.get(scope.companyId);
    if (!usage || !usage.projects.delete(scope.projectId)) return;
    usage.cpu = Math.max(0, usage.cpu - this.limits.cpu);
    usage.memoryMb = Math.max(0, usage.memoryMb - this.limits.memoryMb);
    usage.diskBytes = Math.max(0, usage.diskBytes - this.limits.diskBytes);
    usage.pids = Math.max(0, usage.pids - this.limits.pids);
    if (usage.projects.size === 0) this.companies.delete(scope.companyId);
  }

  /** What is currently admitted, so a status surface can render the quota without a second registry. */
  state(): {
    maxSandboxesPerCompany: number;
    companies: Array<{ companyId: string; sandboxes: number; projectIds: string[]; cpu: number; memoryMb: number; diskBytes: number; pids: number; limit: SandboxCompanyQuotaConfig }>;
  } {
    return {
      maxSandboxesPerCompany: this.config.maxSandboxesPerCompany,
      companies: [...this.companies.entries()]
        .map(([companyId, usage]) => ({
          companyId,
          sandboxes: usage.projects.size,
          projectIds: [...usage.projects].sort(),
          cpu: usage.cpu,
          memoryMb: usage.memoryMb,
          diskBytes: usage.diskBytes,
          pids: usage.pids,
          limit: { ...this.config },
        }))
        .sort((a, b) => b.sandboxes - a.sandboxes || a.companyId.localeCompare(b.companyId)),
    };
  }
}

export interface HostLoadSample {
  /** 0..1, where 1 is every core busy. */
  cpuUsageRatio: number;
  /** 0..1, where 0 is "no free memory left". */
  freeMemoryRatio: number;
  /** Sampling instant; set by the sampler so a cached reading can expire. */
  at?: number;
}

export interface HostAdmissionLimits {
  maxCpuUsageRatio: number;
  minFreeMemoryRatio: number;
  sampleTtlMs: number;
}

/** R1 start values: refuse new sandboxes above 80 % CPU or below 15 % free memory. */
export const DEFAULT_HOST_ADMISSION_LIMITS: HostAdmissionLimits = {
  maxCpuUsageRatio: 0.8,
  minFreeMemoryRatio: 0.15,
  sampleTtlMs: 5_000,
};

const HOST_ADMISSION_MAX_SAMPLE_TTL_MS = 60_000;

/** Reads the host-admission thresholds from the environment, as percentages. 0 is a legal (strictest) value. */
export function resolveHostAdmissionLimits(env: NodeJS.ProcessEnv = process.env): HostAdmissionLimits {
  const percent = (raw: string | undefined, fallbackRatio: number): number => {
    if (raw === undefined || raw.trim() === "") return fallbackRatio;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return fallbackRatio;
    return parsed / 100;
  };
  const ttl = Number.parseInt(env.NPATI_HOST_ADMISSION_SAMPLE_TTL_MS ?? "", 10);
  return {
    maxCpuUsageRatio: percent(env.NPATI_HOST_ADMISSION_MAX_CPU_PERCENT, DEFAULT_HOST_ADMISSION_LIMITS.maxCpuUsageRatio),
    minFreeMemoryRatio: percent(env.NPATI_HOST_ADMISSION_MIN_FREE_MEMORY_PERCENT, DEFAULT_HOST_ADMISSION_LIMITS.minFreeMemoryRatio),
    // 0 means "sample afresh every time", which is a legal operational choice, so it is not treated as nonsense.
    sampleTtlMs: Number.isFinite(ttl) && ttl >= 0 ? Math.min(ttl, HOST_ADMISSION_MAX_SAMPLE_TTL_MS) : DEFAULT_HOST_ADMISSION_LIMITS.sampleTtlMs,
  };
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1);

/**
 * The real host reading. CPU is a **delta** between two cumulative `os.cpus()` snapshots, because a single
 * snapshot's `times.idle` is cumulative since boot and says nothing about the present; with no usable previous
 * snapshot the one-minute load average is the honest fallback. Memory needs no history.
 *
 * Honest limit: on a platform without `os.cpus()` entries the CPU ratio is reported as 0 rather than as an
 * overload, so the memory signal still decides. Refusing every sandbox on a machine that merely cannot report
 * its CPU would turn a missing measurement into an outage, and a false "overloaded" is exactly the failure this
 * module must not have.
 */
export function sampleHostLoad(previous?: { idle: number; total: number }): {
  sample: HostLoadSample;
  cpu: { idle: number; total: number };
} {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }
  let cpuUsageRatio: number;
  if (previous && total > previous.total) {
    const totalDelta = total - previous.total;
    const idleDelta = Math.max(0, idle - previous.idle);
    cpuUsageRatio = clamp01(1 - idleDelta / totalDelta);
  } else {
    const load = os.loadavg()[0] ?? 0;
    cpuUsageRatio = cpus.length > 0 && Number.isFinite(load) ? clamp01(load / cpus.length) : 0;
  }
  const totalMemory = os.totalmem();
  return {
    sample: {
      cpuUsageRatio,
      freeMemoryRatio: totalMemory > 0 ? clamp01(os.freemem() / totalMemory) : 1,
      at: Date.now(),
    },
    cpu: { idle, total },
  };
}

/**
 * Admission control on the host. `evaluate()` is pure with respect to the sample it is given and never throws;
 * `assertAdmitted()` is the form the provider uses, and its error carries `host_overloaded`.
 */
export class HostAdmissionController {
  readonly limits: HostAdmissionLimits;
  private lastCpu?: { idle: number; total: number };
  private cached?: HostLoadSample;

  constructor(
    private readonly options: {
      limits?: Partial<HostAdmissionLimits>;
      sample?: () => HostLoadSample;
      now?: () => number;
    } = {},
  ) {
    const merged = { ...DEFAULT_HOST_ADMISSION_LIMITS, ...options.limits };
    this.limits = {
      maxCpuUsageRatio: clamp01(merged.maxCpuUsageRatio),
      minFreeMemoryRatio: clamp01(merged.minFreeMemoryRatio),
      sampleTtlMs: Math.max(0, Math.min(Math.trunc(merged.sampleTtlMs), HOST_ADMISSION_MAX_SAMPLE_TTL_MS)),
    };
  }

  evaluate(): { admitted: boolean; reason?: "cpu_overloaded" | "memory_pressure"; sample: HostLoadSample } {
    const sample = this.readSample();
    if (sample.cpuUsageRatio > this.limits.maxCpuUsageRatio) return { admitted: false, reason: "cpu_overloaded", sample };
    if (sample.freeMemoryRatio < this.limits.minFreeMemoryRatio) return { admitted: false, reason: "memory_pressure", sample };
    return { admitted: true, sample };
  }

  /** Throws when the host may not take another sandbox. */
  assertAdmitted(): void {
    const verdict = this.evaluate();
    if (verdict.admitted) return;
    const detail = verdict.reason === "cpu_overloaded"
      ? `CPU usage is ${(verdict.sample.cpuUsageRatio * 100).toFixed(1)}% (limit ${(this.limits.maxCpuUsageRatio * 100).toFixed(1)}%)`
      : `free memory is ${(verdict.sample.freeMemoryRatio * 100).toFixed(1)}% (minimum ${(this.limits.minFreeMemoryRatio * 100).toFixed(1)}%)`;
    throw new SandboxQuotaError(
      "host_overloaded",
      `The host is overloaded (${detail}), so no new sandbox was created. The thresholds are configurable with ` +
        `NPATI_HOST_ADMISSION_MAX_CPU_PERCENT and NPATI_HOST_ADMISSION_MIN_FREE_MEMORY_PERCENT.`,
    );
  }

  private readSample(): HostLoadSample {
    const now = this.options.now ? this.options.now() : Date.now();
    if (this.cached && this.limits.sampleTtlMs > 0 && now - (this.cached.at ?? 0) < this.limits.sampleTtlMs) {
      return this.cached;
    }
    if (this.options.sample) {
      /**
       * An injected sampler is read once per refresh and its ratios are clamped like any other reading. The
       * cumulative snapshot is deliberately **not** taken from it: it returns ratios, not counters, and keeping
       * one would silently corrupt the next real delta if the two were ever mixed.
       */
      const injected = this.options.sample();
      this.cached = { cpuUsageRatio: clamp01(injected.cpuUsageRatio), freeMemoryRatio: clamp01(injected.freeMemoryRatio), at: injected.at ?? now };
      return this.cached;
    }
    const reading = sampleHostLoad(this.lastCpu);
    this.lastCpu = reading.cpu;
    this.cached = { ...reading.sample, at: reading.sample.at ?? now };
    return this.cached;
  }
}
