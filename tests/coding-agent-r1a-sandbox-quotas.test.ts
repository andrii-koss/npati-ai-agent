import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_ADMISSION_LIMITS,
  DEFAULT_SANDBOX_COMPANY_QUOTA,
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  HostAdmissionController,
  SANDBOX_QUOTA_MAX_MEMORY_MB_PER_COMPANY,
  SANDBOX_QUOTA_MAX_SANDBOXES_PER_COMPANY,
  SandboxCompanyQuota,
  SandboxQuotaError,
  parseSandboxMemoryMb,
  resolveHostAdmissionLimits,
  resolveSandboxCompanyQuota,
  resolveSandboxResourceLimits,
  sampleHostLoad,
  sandboxMemoryArg,
} from "../apps/agent-api/src/sandbox-resource-quota";
import { buildSandboxCreateArgs, DockerSandboxProvider } from "../apps/agent-api/src/docker-sandbox-provider";

/**
 * R1 (section A, items 1 (sandbox concurrency), 4 and 5) — the sandbox resource ceilings, the aggregate
 * Company quota and host admission control.
 *
 * Hermetic: no Docker daemon is contacted, because every refusal under test happens **before** the first Docker
 * call. The one provider call that gets far enough to need Docker is used only to observe which refusal comes
 * first, and the image-admission refusal it reaches is raised without touching Docker either.
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(workspaceRoot, relative), "utf8");
const scope = { workspaceId: "ws-1", userId: "user-1", companyId: "company-1", projectId: "project-1" };

/** Runs a refusing call and returns the error, so an assertion can name its structured `code`. */
function syncRefusal(run: () => void): Error & { code?: string } {
  try {
    run();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected the call to be refused, but it was admitted");
}

/** The async form of `syncRefusal`, for the provider's promises. */
async function asyncRefusal(run: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await run;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected the call to be refused, but it was admitted");
}

describe("security-gate: R1 A.4 — the sandbox ceilings are configuration with documented start values", () => {
  it("defaults to the R1 start values and moves the container flags with them", () => {
    expect(DEFAULT_SANDBOX_RESOURCE_LIMITS).toEqual({ cpu: 2, memoryMb: 4_096, diskBytes: 10 * 1024 * 1024 * 1024, pids: 512 });
    const limits = resolveSandboxResourceLimits({} as NodeJS.ProcessEnv);
    expect(limits).toEqual(DEFAULT_SANDBOX_RESOURCE_LIMITS);
    /**
     * The pin that matters: the flags a container is really created with follow the *effective* settings, so a
     * default that changed here and not in the provider would fail this line. The previous defaults were
     * 1 vCPU / 1536m / 1536 MiB / 128 pids; R1 section A item 4 raises them deliberately.
     */
    const line = buildSandboxCreateArgs({
      sandboxName: "npati-sb-r1", sandboxId: "r1", network: "npati-net-r1", scope, image: "npati/project-sandbox:local",
      cpus: String(limits.cpu), memory: sandboxMemoryArg(limits.memoryMb), pids: limits.pids, diskBytes: limits.diskBytes,
    }).join(" ");
    expect(line).toContain("--cpus 2");
    expect(line).toContain("--memory 4096m");
    expect(line).toContain("--pids-limit 512");
    expect(line).toContain(`size=${10 * 1024 * 1024 * 1024}`);
    // The provider accepts them (its validation has a floor, so this is not a tautology).
    expect(() => new DockerSandboxProvider({})).not.toThrow();
  });

  it("reads the ceilings from the environment, parses Docker memory syntax and clamps everything", () => {
    const configured = resolveSandboxResourceLimits({
      NPATI_SANDBOX_CPU: "4",
      NPATI_SANDBOX_MEMORY: "8g",
      NPATI_SANDBOX_DISK_BYTES: "20000000000",
      NPATI_SANDBOX_PIDS: "1024",
    } as NodeJS.ProcessEnv);
    expect(configured).toEqual({ cpu: 4, memoryMb: 8_192, diskBytes: 20_000_000_000, pids: 1_024 });
    // The integer-megabyte key wins over the Docker string, so one number can drive flag and quota together.
    expect(resolveSandboxResourceLimits({ NPATI_SANDBOX_MEMORY: "8g", NPATI_SANDBOX_MEMORY_MB: "3072" } as NodeJS.ProcessEnv).memoryMb).toBe(3_072);
    expect(parseSandboxMemoryMb("1536m", 1)).toBe(1_536);
    expect(parseSandboxMemoryMb("4g", 1)).toBe(4_096);
    expect(parseSandboxMemoryMb("nonsense", 7)).toBe(7);
    expect(sandboxMemoryArg(4_096)).toBe("4096m");
    // Nonsense falls back to the default rather than to "unlimited", and an enormous value is clamped.
    expect(resolveSandboxResourceLimits({ NPATI_SANDBOX_CPU: "not-a-number", NPATI_SANDBOX_PIDS: "-4" } as NodeJS.ProcessEnv)).toEqual(DEFAULT_SANDBOX_RESOURCE_LIMITS);
    const enormous = resolveSandboxResourceLimits({ NPATI_SANDBOX_CPU: "9999", NPATI_SANDBOX_PIDS: "99999999" } as NodeJS.ProcessEnv);
    expect(enormous.cpu).toBe(64);
    expect(enormous.pids).toBe(32_768);
  });

  it("defaults the Company quota to five sandboxes and their aggregate, and clamps it", () => {
    expect(DEFAULT_SANDBOX_COMPANY_QUOTA).toEqual({
      maxSandboxesPerCompany: 5,
      maxCpuPerCompany: 10,
      maxMemoryMbPerCompany: 20_480,
      maxDiskBytesPerCompany: 5 * 10 * 1024 * 1024 * 1024,
      maxPidsPerCompany: 2_560,
    });
    expect(resolveSandboxCompanyQuota({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_SANDBOX_COMPANY_QUOTA);
    expect(resolveSandboxCompanyQuota({ NPATI_SANDBOX_MAX_PER_COMPANY: "nonsense" } as NodeJS.ProcessEnv).maxSandboxesPerCompany).toBe(5);
    expect(resolveSandboxCompanyQuota({ NPATI_SANDBOX_MAX_PER_COMPANY: "100000" } as NodeJS.ProcessEnv).maxSandboxesPerCompany).toBe(SANDBOX_QUOTA_MAX_SANDBOXES_PER_COMPANY);
    expect(resolveSandboxCompanyQuota({ NPATI_SANDBOX_MAX_MEMORY_MB_PER_COMPANY: "999999999999" } as NodeJS.ProcessEnv).maxMemoryMbPerCompany).toBe(SANDBOX_QUOTA_MAX_MEMORY_MB_PER_COMPANY);
  });
});

describe("security-gate: R1 A.1/A.4 — the aggregate Company sandbox quota", () => {
  it("refuses the sandbox past the parallel cap, isolates Companies and is idempotent per project", () => {
    const quota = new SandboxCompanyQuota({ maxSandboxesPerCompany: 2, maxCpuPerCompany: 100, maxMemoryMbPerCompany: 100_000, maxDiskBytesPerCompany: 10 ** 12, maxPidsPerCompany: 10_000 });
    quota.admit({ companyId: "company-1", projectId: "p1" });
    quota.admit({ companyId: "company-1", projectId: "p2" });
    // Idempotent: `ProjectSandboxService.ensure` retries the same project and must not spend a second slot.
    quota.admit({ companyId: "company-1", projectId: "p1" });
    expect(quota.state().companies[0]!.sandboxes).toBe(2);

    const capRefusal = syncRefusal(() => quota.admit({ companyId: "company-1", projectId: "p3" }));
    expect(capRefusal).toBeInstanceOf(SandboxQuotaError);
    expect(capRefusal.code).toBe("sandbox_company_quota_exceeded");
    expect(capRefusal.message).toContain("2 of its 2 parallel sandboxes");
    // Tenant isolation: another Company has its own five (here: two).
    expect(() => quota.admit({ companyId: "company-2", projectId: "p3" })).not.toThrow();

    // A release frees exactly one slot and is idempotent.
    quota.release({ companyId: "company-1", projectId: "p1" });
    quota.release({ companyId: "company-1", projectId: "p1" });
    expect(quota.state().companies.find((row) => row.companyId === "company-1")!.sandboxes).toBe(1);
    expect(() => quota.admit({ companyId: "company-1", projectId: "p3" })).not.toThrow();
  });

  it("refuses a sandbox that would exceed the Company's summed CPU, memory, disk or pids", () => {
    const boundary = new SandboxCompanyQuota(
      { maxSandboxesPerCompany: 10, maxCpuPerCompany: 6, maxMemoryMbPerCompany: 12_288, maxDiskBytesPerCompany: 100 * 1024 * 1024 * 1024, maxPidsPerCompany: 1_536 },
      { cpu: 2, memoryMb: 4_096, diskBytes: 10 * 1024 * 1024 * 1024, pids: 512 },
    );
    boundary.admit({ companyId: "company-1", projectId: "p1" });
    boundary.admit({ companyId: "company-1", projectId: "p2" });
    // A third sandbox reaches 6 vCPU and 12288 MB exactly: at the limit, so admitted (exclusive comparison).
    boundary.admit({ companyId: "company-1", projectId: "p3" });
    expect(boundary.state().companies[0]!.memoryMb).toBe(12_288);

    const tight = new SandboxCompanyQuota(
      { maxSandboxesPerCompany: 10, maxCpuPerCompany: 6, maxMemoryMbPerCompany: 12_000, maxDiskBytesPerCompany: 100 * 1024 * 1024 * 1024, maxPidsPerCompany: 1_536 },
      { cpu: 2, memoryMb: 4_096, diskBytes: 10 * 1024 * 1024 * 1024, pids: 512 },
    );
    tight.admit({ companyId: "company-1", projectId: "p1" });
    tight.admit({ companyId: "company-1", projectId: "p2" });
    const refusal = syncRefusal(() => tight.admit({ companyId: "company-1", projectId: "p3" }));
    expect(refusal.code).toBe("sandbox_company_resource_quota_exceeded");
    expect(refusal.message).toContain("memory 12288MB/12000MB");
    expect(tight.state().companies[0]!.memoryMb).toBe(8_192);
    // Another Company's aggregate is untouched by the first one's usage.
    expect(() => tight.admit({ companyId: "company-2", projectId: "p9" })).not.toThrow();
  });

  it("is not vacuous: a Company quota with room admits the project the default refuses", () => {
    const strict = new SandboxCompanyQuota({ maxSandboxesPerCompany: 1 });
    strict.admit({ companyId: "company-1", projectId: "p1" });
    expect(syncRefusal(() => strict.admit({ companyId: "company-1", projectId: "p2" })).code).toBe("sandbox_company_quota_exceeded");

    const relaxed = new SandboxCompanyQuota({ maxSandboxesPerCompany: 2 });
    relaxed.admit({ companyId: "company-1", projectId: "p1" });
    expect(() => relaxed.admit({ companyId: "company-1", projectId: "p2" })).not.toThrow();
    // And the guard is still live after the neutralisation.
    expect(syncRefusal(() => relaxed.admit({ companyId: "company-1", projectId: "p3" })).code).toBe("sandbox_company_quota_exceeded");
  });
});

describe("security-gate: R1 A.4 — host admission control", () => {
  const overloaded = { cpuUsageRatio: 0.95, freeMemoryRatio: 0.5 };
  const heavyMemory = { cpuUsageRatio: 0.1, freeMemoryRatio: 0.14 };

  it("refuses above 80 % CPU, refuses below 15 % free memory, and admits exactly at both boundaries", () => {
    expect(new HostAdmissionController({ sample: () => overloaded }).evaluate()).toMatchObject({ admitted: false, reason: "cpu_overloaded" });
    expect(new HostAdmissionController({ sample: () => heavyMemory }).evaluate()).toMatchObject({ admitted: false, reason: "memory_pressure" });
    /**
     * The negative control: a host at exactly the configured thresholds is admitted, so the guard is a
     * threshold and not a blanket refusal. A guard that refused everything would pass every test above.
     */
    const boundary = new HostAdmissionController({ sample: () => ({ cpuUsageRatio: 0.8, freeMemoryRatio: 0.15 }) });
    expect(boundary.evaluate().admitted).toBe(true);
    expect(new HostAdmissionController({ sample: () => ({ cpuUsageRatio: 0.2, freeMemoryRatio: 0.9 }) }).evaluate().admitted).toBe(true);
  });

  it("throws the structured refusal with the numbers that decided it", () => {
    try {
      new HostAdmissionController({ sample: () => overloaded }).assertAdmitted();
      throw new Error("expected host admission to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxQuotaError);
      expect((error as SandboxQuotaError).code).toBe("host_overloaded");
      expect((error as Error).message).toContain("CPU usage is 95.0%");
      expect((error as Error).message).toContain("NPATI_HOST_ADMISSION_MAX_CPU_PERCENT");
    }
  });

  it("reads the thresholds from the environment as percentages, and treats 0 as the strictest legal value", () => {
    expect(DEFAULT_HOST_ADMISSION_LIMITS).toEqual({ maxCpuUsageRatio: 0.8, minFreeMemoryRatio: 0.15, sampleTtlMs: 5_000 });
    expect(resolveHostAdmissionLimits({
      NPATI_HOST_ADMISSION_MAX_CPU_PERCENT: "50",
      NPATI_HOST_ADMISSION_MIN_FREE_MEMORY_PERCENT: "5",
      NPATI_HOST_ADMISSION_SAMPLE_TTL_MS: "0",
    } as NodeJS.ProcessEnv)).toEqual({ maxCpuUsageRatio: 0.5, minFreeMemoryRatio: 0.05, sampleTtlMs: 0 });
    // Nonsense and out-of-range values fall back rather than removing the limit.
    expect(resolveHostAdmissionLimits({ NPATI_HOST_ADMISSION_MAX_CPU_PERCENT: "nonsense" } as NodeJS.ProcessEnv).maxCpuUsageRatio).toBe(0.8);
    expect(resolveHostAdmissionLimits({ NPATI_HOST_ADMISSION_MAX_CPU_PERCENT: "140" } as NodeJS.ProcessEnv).maxCpuUsageRatio).toBe(0.8);
    expect(resolveHostAdmissionLimits({ NPATI_HOST_ADMISSION_SAMPLE_TTL_MS: "-5" } as NodeJS.ProcessEnv).sampleTtlMs).toBe(5_000);
    // 0 % CPU is a legal (absurd, strictest) setting and refuses everything — it must not silently become 80 %.
    const refuseAll = new HostAdmissionController({ limits: { maxCpuUsageRatio: 0 }, sample: () => ({ cpuUsageRatio: 0.01, freeMemoryRatio: 0.9 }) });
    expect(refuseAll.evaluate().reason).toBe("cpu_overloaded");
  });

  it("reuses a reading for the configured TTL and samples again afterwards", () => {
    let now = 1_000;
    let samples = 0;
    const controller = new HostAdmissionController({
      limits: { sampleTtlMs: 5_000 },
      now: () => now,
      sample: () => { samples += 1; return { cpuUsageRatio: 0.1, freeMemoryRatio: 0.9, at: now }; },
    });
    controller.evaluate();
    controller.evaluate();
    expect(samples).toBe(1);
    now += 5_001;
    controller.evaluate();
    expect(samples).toBe(2);
  });

  it("is not vacuous: a controller whose ceiling cannot be crossed admits the sample the default refuses", () => {
    const strict = new HostAdmissionController({ sample: () => overloaded });
    expect(strict.evaluate().admitted).toBe(false);
    const relaxed = new HostAdmissionController({ limits: { maxCpuUsageRatio: 1 }, sample: () => overloaded });
    expect(relaxed.evaluate().admitted).toBe(true);
    // The real guard is unchanged by the neutralisation.
    expect(new HostAdmissionController({ sample: () => overloaded }).evaluate().admitted).toBe(false);
  });

  it("samples the real host within its documented ranges", () => {
    const first = sampleHostLoad();
    expect(first.sample.cpuUsageRatio).toBeGreaterThanOrEqual(0);
    expect(first.sample.cpuUsageRatio).toBeLessThanOrEqual(1);
    expect(first.sample.freeMemoryRatio).toBeGreaterThanOrEqual(0);
    expect(first.sample.freeMemoryRatio).toBeLessThanOrEqual(1);
    expect(first.cpu.total).toBeGreaterThanOrEqual(first.cpu.idle);
    // A second reading is a delta against the first, which is what makes the CPU number mean "now".
    const second = sampleHostLoad(first.cpu);
    expect(second.cpu.total).toBeGreaterThanOrEqual(first.cpu.total);
    expect(second.sample.cpuUsageRatio).toBeGreaterThanOrEqual(0);
    // The default controller is usable against the real host without throwing.
    expect(typeof new HostAdmissionController().evaluate().admitted).toBe("boolean");
  });
});

describe("security-gate: R1 A.4/A.5 — the provider applies the quotas, and only to sandboxes", () => {
  it("refuses an overloaded host before any Docker work, and only for that reason", async () => {
    const overloadedProvider = new DockerSandboxProvider({}, undefined, undefined, undefined, undefined, new HostAdmissionController({ sample: () => ({ cpuUsageRatio: 0.95, freeMemoryRatio: 0.5 }) }));
    // The refusal is the host verdict, not the image policy the same provider would otherwise reach: that is
    // what proves the host check really runs first and is not merely present.
    expect((await asyncRefusal(overloadedProvider.createSandbox(scope))).code).toBe("host_overloaded");

    const healthyProvider = new DockerSandboxProvider({}, undefined, undefined, undefined, undefined, new HostAdmissionController({ sample: () => ({ cpuUsageRatio: 0.1, freeMemoryRatio: 0.9 }) }));
    expect((await asyncRefusal(healthyProvider.createSandbox(scope))).code).toBe("sandbox_image_policy_unavailable");
  });

  it("refuses a Company over its quota before any Docker work", async () => {
    const quota = new SandboxCompanyQuota({ maxSandboxesPerCompany: 1, maxCpuPerCompany: 100, maxMemoryMbPerCompany: 100_000, maxDiskBytesPerCompany: 10 ** 12, maxPidsPerCompany: 10_000 });
    quota.admit({ companyId: scope.companyId, projectId: "another-project" });
    const provider = new DockerSandboxProvider({}, undefined, undefined, undefined, quota);
    expect((await asyncRefusal(provider.createSandbox(scope))).code).toBe("sandbox_company_quota_exceeded");
    // A Company with room reaches the next refusal, so the quota is a limit and not a blanket denial.
    const openProvider = new DockerSandboxProvider({}, undefined, undefined, undefined, new SandboxCompanyQuota());
    expect((await asyncRefusal(openProvider.createSandbox(scope))).code).toBe("sandbox_image_policy_unavailable");
  });

  it("releases the Company's capacity when a creation fails, so a failed attempt is not a permanent loss", async () => {
    const quota = new SandboxCompanyQuota({ maxSandboxesPerCompany: 1 });
    const provider = new DockerSandboxProvider({}, undefined, undefined, undefined, quota);
    expect((await asyncRefusal(provider.createSandbox(scope))).code).toBe("sandbox_image_policy_unavailable");
    // The slot was admitted and then released: the Company is not permanently at its cap because a run failed.
    expect(quota.state().companies).toEqual([]);
    expect(() => quota.admit({ companyId: scope.companyId, projectId: scope.projectId })).not.toThrow();
  });

  it("releases the slot when a sandbox is destroyed", () => {
    /**
     * `destroySandbox` needs Docker, so the wiring is pinned structurally and precisely: the release must sit
     * inside that method's own body, not merely appear in the file.
     */
    const provider = read(path.join("apps", "agent-api", "src", "docker-sandbox-provider.ts"));
    const method = /async destroySandbox\([^)]*\)\s*\{([\s\S]*?)\n  \}/.exec(provider);
    expect(method).not.toBeNull();
    expect(method![1]).toContain("this.companyQuota?.release(");
    expect(method![1]).toContain("projectId: scope.projectId");
    // The admission side is in `createSandbox`, before the image policy, and its failure path releases.
    const create = /async createSandbox\([\s\S]*?\n  \}/.exec(provider);
    expect(create).not.toBeNull();
    expect(create![0]!.indexOf("this.hostAdmission?.assertAdmitted()")).toBeLessThan(create![0]!.indexOf("this.admitImage(scope)"));
    expect(create![0]!.indexOf("this.companyQuota.admit(")).toBeLessThan(create![0]!.indexOf("this.admitImage(scope)"));
    expect(create![0]).toContain("this.companyQuota?.release(");
    // The provider defaults come from the one module that also owns the aggregate quota.
    expect(provider).toContain("DEFAULT_SANDBOX_RESOURCE_LIMITS.cpu");
    expect(provider).toContain("sandboxMemoryArg(DEFAULT_SANDBOX_RESOURCE_LIMITS.memoryMb)");
  });

  it("keeps host admission out of the Company-run path, which has its own gate", () => {
    /**
     * The risk this step must not take: `admissionGate` (read by the Company queues) is a different limit, and
     * widening it to include host load would let a busy browser-qa container stop every Company run. The
     * modules on that path must therefore not know this module exists, and the composition root must still wire
     * the gate to the reaper alone.
     */
    const app = read(path.join("apps", "agent-api", "src", "app.ts"));
    expect(app).toContain("admissionGate: { isRefusingNewRuns: () => codeReaper.isRefusingNewRuns() },");
    expect(app).not.toContain("HostAdmissionController");
    expect(app).not.toContain("hostAdmission");
    expect(app).not.toContain("SandboxCompanyQuota");
    for (const relative of [
      path.join("apps", "agent-api", "src", "resilience-admission-queue.ts"),
      path.join("apps", "agent-api", "src", "company-runtime.ts"),
    ]) {
      const source = read(relative);
      expect(source).not.toContain("host_admission");
      expect(source).not.toContain("HostAdmissionController");
      expect(source).not.toContain("sandbox-resource-quota");
    }
    // The one production caller is the sandbox runner, where containers are actually created.
    const runner = read(path.join("apps", "agent-api", "src", "sandbox-runner-server.ts"));
    expect(runner).toContain("new HostAdmissionController({ limits: resolveHostAdmissionLimits(process.env) })");
    expect(runner).toContain("runnerMountGate, sandboxCompanyQuota, hostAdmission);");
  });

  it("documents every environment key it reads in .env.example", () => {
    /**
     * The four per-sandbox keys existed before R1 and were read by the runner while being documented nowhere,
     * which is how a deployment ends up running the defaults and believing it configured them. This assertion is
     * the guard against that regression.
     */
    const env = read(".env.example");
    for (const key of [
      "NPATI_SANDBOX_CPU",
      "NPATI_SANDBOX_MEMORY",
      "NPATI_SANDBOX_MEMORY_MB",
      "NPATI_SANDBOX_DISK_BYTES",
      "NPATI_SANDBOX_PIDS",
      "NPATI_SANDBOX_MAX_PER_COMPANY",
      "NPATI_SANDBOX_MAX_CPU_PER_COMPANY",
      "NPATI_SANDBOX_MAX_MEMORY_MB_PER_COMPANY",
      "NPATI_SANDBOX_MAX_DISK_BYTES_PER_COMPANY",
      "NPATI_SANDBOX_MAX_PIDS_PER_COMPANY",
      "NPATI_HOST_ADMISSION_MAX_CPU_PERCENT",
      "NPATI_HOST_ADMISSION_MIN_FREE_MEMORY_PERCENT",
      "NPATI_HOST_ADMISSION_SAMPLE_TTL_MS",
      "NPATI_CODE_RUN_RATE_LIMIT_PER_USER_PER_PERIOD",
      "NPATI_CODE_RUN_RATE_LIMIT_PER_COMPANY_PER_PERIOD",
      "NPATI_CODE_RUN_RATE_LIMIT_PERIOD_MS",
      "NPATI_CODE_RUN_DAILY_MAX_TOKENS_PER_USER",
      "NPATI_CODE_RUN_DAILY_MAX_COST_USD_PER_COMPANY",
    ]) {
      expect(env).toContain(`${key}=`);
    }
  });
});
