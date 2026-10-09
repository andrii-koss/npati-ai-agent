import { SandboxProviderError } from "./sandbox-provider";

/**
 * C4b: readiness proof for sandbox egress enforcement.
 *
 * The owner's decision is explicit: `NPATI_SANDBOX_EGRESS_ENFORCED=true` does **not** by itself prove
 * that the sandbox is isolated. The provider must actually verify that (a) the egress proxy is alive,
 * (b) a sandbox on the run network cannot reach the internet directly, and (c) DNS does not bypass the
 * proxy. Only then may a container be created; otherwise the caller gets
 * `network_enforcement_unavailable` (503) before anything runs.
 *
 * The flag keeps one meaning: `false` never claims enforcement (it is the operator's kill switch for
 * the feature), while `true` still requires a passing probe.
 */
export type EgressEnforcementReason =
  | "proxy_unreachable"
  | "proxy_unhealthy"
  | "direct_egress_open"
  | "dns_bypass_open"
  | "probe_unavailable"
  | "probe_not_configured"
  | "disabled_by_configuration";

export interface EgressEnforcementChecks {
  proxy: { ok: boolean; detail?: string };
  direct: { blocked: boolean; detail?: string };
  dns: { blocked: boolean; detail?: string };
}

export interface EgressEnforcementReport {
  enforced: boolean;
  reason?: EgressEnforcementReason;
  details: Record<string, unknown>;
  checkedAt: number;
  fromCache: boolean;
  /**
   * C4b: the individual facts behind `enforced`, so the runner readiness endpoint can report
   * `egress_proxy_ready` / `network_policy_ready` / `dns_policy_ready` separately without a second probe.
   * A check that never ran stays `false` (fail closed).
   */
  checks?: EgressEnforcementChecks;
}

export interface EgressProbePort {
  /** The proxy answers its own health endpoint from inside the run network. */
  proxyHealth(input: { proxy: string; network: string }): Promise<{ ok: boolean; detail?: string }>;
  /** A container on the run network must NOT be able to open a public connection. */
  directEgressBlocked(input: { network: string }): Promise<{ blocked: boolean; detail?: string }>;
  /** Name resolution must not succeed outside the proxy. */
  dnsBypassBlocked(input: { network: string }): Promise<{ blocked: boolean; detail?: string }>;
}

/** Structured failure raised when enforcement cannot be proven. */
export class EgressEnforcementError extends SandboxProviderError {
  readonly details: Record<string, unknown>;
  constructor(report: EgressEnforcementReport) {
    super("network_enforcement_unavailable",
      `Sandbox egress enforcement is not verified: ${report.reason ?? "unknown"}`,
      503, "sandbox", "code.shell.exec", true);
    this.details = { ...report.details, reason: report.reason, checkedAt: report.checkedAt };
  }
}

export interface EgressEnforcementOptions {
  probe?: EgressProbePort;
  /** Short cache: enforcement is re-proven regularly, not once at boot. */
  ttlMs?: number;
  enabled?: boolean;
  now?: () => number;
  log?: (event: string, details: Record<string, unknown>) => void;
}

function positiveInt(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class EgressEnforcement {
  private readonly probe?: EgressProbePort;
  private readonly ttlMs: number;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly log: (event: string, details: Record<string, unknown>) => void;
  private cached?: EgressEnforcementReport;
  private cachedScope?: string;

  constructor(options: EgressEnforcementOptions = {}) {
    this.probe = options.probe;
    this.ttlMs = positiveInt(options.ttlMs, 60_000);
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
  }

  lastReport(): EgressEnforcementReport | undefined { return this.cached; }
  invalidate(): void { this.cached = undefined; }

  /** Re-proves enforcement when the cache expired; never throws. */
  async verify(force = false): Promise<EgressEnforcementReport> {
    const scope = { ...this.scope };
    const scopeKey = JSON.stringify(scope);
    if (!force && this.cached && this.cachedScope === scopeKey && this.cached.checkedAt + this.ttlMs > this.now()) {
      return { ...this.cached, fromCache: true };
    }
    const report = await this.probeOnce(scope);
    this.cached = report;
    this.cachedScope = scopeKey;
    if (!report.enforced) this.log("egress_enforcement_failed", { reason: report.reason, ...report.details });
    return report;
  }

  async isEnforced(): Promise<boolean> {
    return (await this.verify()).enforced;
  }

  /** Gate for container creation: throws unless enforcement is currently proven. */
  async assertEnforced(): Promise<EgressEnforcementReport> {
    const report = await this.verify();
    if (!report.enforced) throw new EgressEnforcementError(report);
    return report;
  }

  private async probeOnce(scope: {proxy:string;network:string}): Promise<EgressEnforcementReport> {
    const checkedAt = this.now();
    const checks: EgressEnforcementChecks = {
      proxy: { ok: false },
      direct: { blocked: false },
      dns: { blocked: false },
    };
    const fail = (reason: EgressEnforcementReason, details: Record<string, unknown> = {}): EgressEnforcementReport =>
      ({ enforced: false, reason, details, checkedAt, fromCache: false, checks });
    if (!this.enabled) return fail("disabled_by_configuration");
    if (!this.probe) return fail("probe_not_configured");
    try {
      const health = await this.probe.proxyHealth(scope);
      checks.proxy = { ok: health.ok, detail: health.detail };
      if (!health.ok) return fail("proxy_unhealthy", { detail: health.detail ?? null });
      const direct = await this.probe.directEgressBlocked({ network: scope.network });
      checks.direct = { blocked: direct.blocked, detail: direct.detail };
      if (!direct.blocked) return fail("direct_egress_open", { detail: direct.detail ?? null });
      const dns = await this.probe.dnsBypassBlocked({ network: scope.network });
      checks.dns = { blocked: dns.blocked, detail: dns.detail };
      if (!dns.blocked) return fail("dns_bypass_open", { detail: dns.detail ?? null });
      return { enforced: true, details: { direct: direct.detail ?? "blocked", dns: dns.detail ?? "blocked" }, checkedAt, fromCache: false, checks };
    } catch (error) {
      return fail("probe_unavailable", { detail: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Set by the caller (provider/runner) for the run currently being created. */
  scope: { proxy: string; network: string } = { proxy: "npati-egress", network: "npati-sandbox-control" };
}

export interface DockerEgressProbeOptions {
  /** Executes a docker command; returns whether it succeeded and its combined output. */
  docker: (args: string[], timeoutMs?: number) => Promise<{ ok: boolean; output: string }>;
  /** Image used for the isolation probes; defaults to the project sandbox image. */
  sandboxImage?: string;
}

const NODE_CONNECT_PROBE = "const net=require('net');const s=net.connect(443,'1.1.1.1');s.setTimeout(4000);" +
  "s.on('connect',()=>{console.log('CONNECTED');process.exit(3);});" +
  "s.on('error',(e)=>{console.log('BLOCKED:'+e.code);process.exit(0);});" +
  "s.on('timeout',()=>{console.log('BLOCKED:timeout');process.exit(0);});";

const NODE_DNS_PROBE = "require('dns').lookup('example.com',(e,a)=>{if(e){console.log('BLOCKED:'+e.code);process.exit(0);}" +
  "console.log('RESOLVED:'+a);process.exit(3);});";

const PROBE_CONTAINER_ARGS = ["run", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--read-only", "--tmpfs", "/tmp:rw,size=16m", "--network"];

/**
 * Real probe implementation. Each check runs something inside the sandbox network and interprets the
 * exit status; any unexpected outcome counts as "not blocked" so the caller fails closed.
 */
export function dockerEgressProbe(options: DockerEgressProbeOptions): EgressProbePort {
  const image = options.sandboxImage ?? "npati/project-sandbox:local";
  return {
    async proxyHealth({ proxy }) {
      const result = await options.docker(["exec", proxy, "node", "-e",
        "const http=require('http');let attempts=0;function probe(){const r=http.get('http://127.0.0.1:8080/_npati/health',(res)=>{let b='';res.on('data',(c)=>b+=c);res.on('end',()=>{console.log(res.statusCode+' '+b);process.exit(res.statusCode===200?0:3);});});r.setTimeout(1000,()=>r.destroy());r.on('error',(e)=>{if(++attempts<10)setTimeout(probe,200);else{console.log('ERR:'+e.code);process.exit(3);}});}probe();",
      ], 15_000);
      const healthy = result.ok && /"ok"\s*:\s*true/.test(result.output);
      return { ok: healthy, detail: result.output.slice(-400) };
    },
    async directEgressBlocked({ network }) {
      const result = await options.docker([...PROBE_CONTAINER_ARGS, network, image, "node", "-e", NODE_CONNECT_PROBE], 30_000)
        .catch(() => ({ ok: false, output: "probe_failed" }));
      const blocked = result.ok && /BLOCKED/.test(result.output);
      return { blocked, detail: result.output.slice(-400) };
    },
    async dnsBypassBlocked({ network }) {
      const result = await options.docker([...PROBE_CONTAINER_ARGS, network, image, "node", "-e", NODE_DNS_PROBE], 30_000)
        .catch(() => ({ ok: false, output: "probe_failed" }));
      const blocked = result.ok && /BLOCKED/.test(result.output);
      return { blocked, detail: result.output.slice(-400) };
    },
  };
}

export function resolveEgressEnforcement(
  env: NodeJS.ProcessEnv = process.env,
  deps: { probe?: EgressProbePort; log?: (event: string, details: Record<string, unknown>) => void } = {},
): EgressEnforcement {
  return new EgressEnforcement({
    probe: deps.probe,
    ttlMs: positiveInt(env.NPATI_SANDBOX_EGRESS_PROBE_TTL_MS, 60_000),
    // The flag is advisory: "false" refuses to claim enforcement, "true" still requires the probe.
    enabled: env.NPATI_SANDBOX_EGRESS_ENFORCED !== "false",
    log: deps.log,
  });
}
