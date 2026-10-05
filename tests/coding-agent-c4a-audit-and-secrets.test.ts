import { describe, expect, it, vi } from "vitest";
import {
  AuditUnavailableError,
  auditCommandFor,
  parseAuditReport,
  runDependencyAudit,
  shouldBlockCommit,
  type AuditRunner,
} from "../apps/agent-api/src/code-deps-audit";
import {
  SecretInDiffError,
  assertNoSecretsInDiff,
  redactSecretValue,
  scanDiffForSecrets,
  scanTextForSecrets,
  summarizeSecretFindings,
} from "../apps/agent-api/src/code-secret-scanner";

const NPM_AUDIT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    minimist: {
      name: "minimist",
      severity: "critical",
      via: [{ source: "GHSA-vh95-rmgr-6w4m", name: "minimist", title: "Prototype Pollution", severity: "critical", url: "https://github.com/advisories/GHSA-vh95-rmgr-6w4m" }],
      fixAvailable: { name: "minimist", version: "1.2.6", isSemVerMajor: false },
    },
    lodash: {
      name: "lodash",
      severity: "high",
      via: [{ source: "GHSA-35jh-r3h4-6jhm", name: "lodash", title: "Command Injection", severity: "high" }],
      fixAvailable: false,
    },
    "left-pad": { name: "left-pad", severity: "moderate", via: ["depends on a vulnerable package"] },
  },
});

const NPM_LEGACY = JSON.stringify({
  advisories: {
    "1001": { id: 1001, module_name: "axios", severity: "high", title: "SSRF", patched_versions: ">=0.21.2" },
  },
});

const PIP_AUDIT = JSON.stringify({
  dependencies: [
    { name: "jinja2", version: "2.11.2", vulns: [{ id: "PYSEC-2020-10", fix_versions: ["2.11.3"], description: "Sandbox escape" }] },
  ],
});

const COMPOSER_AUDIT = JSON.stringify({
  advisories: {
    "symfony/http-kernel": [
      { advisoryId: "CVE-2021-21424", title: "Information disclosure", severity: "high", affectedVersions: ">=2.0,<5.4.0" },
    ],
  },
});

const CARGO_AUDIT = JSON.stringify({
  vulnerabilities: {
    found: true,
    list: [
      { advisory: { id: "RUSTSEC-2020-0159", title: "Potential segfault", severity: "high" }, package: { name: "chrono", version: "0.4.19" }, versions: { patched: [">=0.4.20"] } },
    ],
  },
});

const OSV_JSON = JSON.stringify({
  results: [
    {
      source: { path: "/workspace" },
      packages: [
        {
          package: { name: "golang.org/x/text", ecosystem: "Go" },
          vulnerabilities: [{ id: "GO-2021-0113", summary: "Panic in language.Parse", database_specific: { severity: "HIGH" } }],
        },
      ],
    },
  ],
});

describe("security-gate: C4a dependency audit parsing and commit gate", () => {
  it("parses an npm/pnpm audit report and blocks the commit on critical and high", () => {
    const report = parseAuditReport("npm", NPM_AUDIT, 1);
    expect(report.parsed).toBe(true);
    expect(report.critical).toBe(1);
    expect(report.high).toBe(1);
    expect(report.moderate).toBe(1);
    // The fixture declares exactly three vulnerable packages (minimist, lodash, left-pad), so the
    // advisory list must mirror it one-to-one rather than a hardcoded number.
    expect(report.advisories).toHaveLength(report.critical + report.high + report.moderate + report.low);
    expect(report.advisories).toHaveLength(3);
    expect(report.advisories.find((advisory) => advisory.package === "minimist")).toMatchObject({ severity: "critical", fixedIn: "1.2.6" });

    const gate = shouldBlockCommit(report);
    expect(gate.blocked).toBe(true);
    expect(gate.reason).toContain("critical=1");
    expect(gate.reason).toContain("minimist");
  });

  it("parses the legacy npm advisories shape and applies a custom blockOn policy", () => {
    const report = parseAuditReport("npm", NPM_LEGACY, 1);
    expect(report.parsed).toBe(true);
    expect(report.high).toBe(1);
    expect(report.advisories[0]).toMatchObject({ package: "axios", severity: "high", fixedIn: ">=0.21.2" });
    expect(shouldBlockCommit(report, { blockOn: ["critical"] }).blocked).toBe(false);
    expect(shouldBlockCommit(report, { blockOn: ["high"] }).blocked).toBe(true);
  });

  it("parses pip-audit, composer, cargo and osv-scanner reports", () => {
    const pip = parseAuditReport("pip", PIP_AUDIT, 1);
    expect(pip.advisories[0]).toMatchObject({ id: "PYSEC-2020-10", package: "jinja2", fixedIn: "2.11.3" });

    const composer = parseAuditReport("composer", COMPOSER_AUDIT, 1);
    expect(composer.high).toBe(1);
    expect(composer.advisories[0]?.package).toBe("symfony/http-kernel");

    const cargo = parseAuditReport("cargo", CARGO_AUDIT, 1);
    expect(cargo.advisories[0]).toMatchObject({ id: "RUSTSEC-2020-0159", package: "chrono", fixedIn: ">=0.4.20" });

    const osv = parseAuditReport("go", OSV_JSON, 1);
    expect(osv.high).toBe(1);
    expect(osv.advisories[0]?.package).toBe("golang.org/x/text");
  });

  it("degrades safely on an unknown format instead of claiming the tree is clean", () => {
    const report = parseAuditReport("npm", "not json at all\nsome tool noise", 1);
    expect(report.parsed).toBe(false);
    expect(report.advisories).toEqual([]);
    expect(report.raw).toContain("some tool noise");
    expect(shouldBlockCommit(report)).toMatchObject({ blocked: true, reason: "audit_output_unparsed:npm" });

    const huge = parseAuditReport("npm", "x".repeat(20_000), 1);
    expect((huge.raw ?? "").length).toBeLessThanOrEqual(4000);

    expect(parseAuditReport("npm", "", 0)).toMatchObject({ parsed: false, advisories: [] });
    expect(parseAuditReport("pnpm", "{}", 0).parsed).toBe(true);
  });

  it("fails closed when the sandbox audit runner is not configured", async () => {
    await expect(runDependencyAudit({ manager: "npm", lockfilePath: "package-lock.json" }))
      .rejects.toBeInstanceOf(AuditUnavailableError);
    await expect(runDependencyAudit({ manager: "npm", lockfilePath: "package-lock.json" }))
      .rejects.toMatchObject({ code: "audit_unavailable", status: 503, retryable: true });
  });

  it("runs the audit through the injected sandbox runner and picks the right command", async () => {
    const runner = vi.fn(async () => ({ exitCode: 1, stdout: NPM_AUDIT })) as unknown as AuditRunner;
    const report = await runDependencyAudit({ manager: "npm", lockfilePath: "package-lock.json", auditRunner: runner });
    expect(report.critical).toBe(1);
    expect((runner as unknown as { mock: { calls: Array<[{ command: string }]> } }).mock.calls[0]![0].command).toBe("npm audit --json");

    expect(auditCommandFor("pnpm")).toBe("pnpm audit --json");
    expect(auditCommandFor("poetry")).toContain("pip-audit");
    expect(auditCommandFor("composer")).toContain("composer audit");
    expect(auditCommandFor("cargo")).toBe("cargo audit --json");
    expect(auditCommandFor("go")).toContain("osv-scanner");
  });
});

describe("security-gate: C4a secret scanning", () => {
  const samples: Array<{ kind: string; text: string }> = [
    { kind: "aws_access_key", text: "aws_key = AKIAIOSFODNN7EXAMPLE" },
    { kind: "github_token", text: "token: ghp_0123456789abcdefghijklmnopqrstuvwxyz" },
    { kind: "private_key", text: "-----BEGIN RSA PRIVATE KEY-----" },
    { kind: "jwt", text: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" },
    { kind: "database_url", text: "DATABASE_URL=postgres://npati:hunter2secret@db.internal:5432/npati" },
    { kind: "api_key", text: "stripe = sk_live_51Habcdefghijklmnopqrstuv" },
    { kind: "slack_webhook", text: "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX" },
    { kind: "discord_webhook", text: "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEF" },
  ];

  it("finds every documented secret kind without returning the value", () => {
    for (const sample of samples) {
      const result = scanTextForSecrets(sample.text);
      expect(result.clean).toBe(false);
      expect(result.findings.map((finding) => finding.kind)).toContain(sample.kind);
      for (const finding of result.findings) {
        expect(finding.preview).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(finding.preview).not.toContain("hunter2secret");
        expect(finding.preview).not.toContain("sk_live_51Habcdefghijklmnopqrstuv");
        expect(finding.preview).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
      }
    }
  });

  it("finds .env style assignments and ignores placeholders", () => {
    const env = scanTextForSecrets("API_TOKEN=supersecretvalue123\nAPI_TOKEN=changeme\nPASSWORD=${DB_PASSWORD}\nSTRIPE_KEY=placeholder");
    expect(env.findings).toHaveLength(1);
    expect(env.findings[0]).toMatchObject({ kind: "env_secret", line: 1 });
    expect(env.findings[0]!.preview).not.toContain("supersecretvalue123");

    const clean = scanTextForSecrets("NODE_ENV=production\nPORT=3000\n# no secrets here");
    expect(clean.clean).toBe(true);
    expect(clean.findings).toEqual([]);
    expect(redactSecretValue("short")).toBe("[REDACTED]");
    expect(redactSecretValue("AKIAIOSFODNN7EXAMPLE")).not.toContain("IOSFODNN7EXAMPLE");
  });

  it("reports secrets only from added diff lines, with the new file path and line number", () => {
    const diff = [
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1,4 +1,5 @@",
      " export const config = {",
      "-  token: undefined,",
      "+  token: \"ghp_0123456789abcdefghijklmnopqrstuvwxyz\",",
      "+  safe: true,",
      " };",
    ].join("\n");
    const result = scanDiffForSecrets(diff);
    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "github_token", path: "src/config.ts", line: 2 });
    expect(result.findings[0]!.preview).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
  });

  it("does not report removed lines or context lines as new leaks", () => {
    const diff = [
      "--- a/.env",
      "+++ b/.env",
      "@@ -1,2 +1,2 @@",
      "-OLD_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      " CONTEXT_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "+NEW_VALUE=plain",
    ].join("\n");
    const result = scanDiffForSecrets(diff);
    expect(result.findings).toEqual([]);
    expect(result.clean).toBe(true);
  });

  it("blocks a diff that introduces a secret and stays silent for a clean diff", () => {
    const dirty = ["+++ b/app.py", "@@ -0,0 +1,1 @@", "+AWS_SECRET_ACCESS_KEY=abcdefghijklmnop123456"].join("\n");
    let thrown: unknown;
    try {
      assertNoSecretsInDiff(dirty);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SecretInDiffError);
    expect(thrown).toMatchObject({ code: "secret_in_diff", status: 403, retryable: false });
    const details = (thrown as SecretInDiffError).details;
    expect(details.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(details)).not.toContain("abcdefghijklmnop123456");

    expect(() => assertNoSecretsInDiff(["+++ b/app.py", "@@ -0,0 +1,1 @@", "+print('hello')"].join("\n"))).not.toThrow();
  });

  it("summarises findings without previews for Activity and approval payloads", () => {
    const { findings } = scanTextForSecrets("AKIAIOSFODNN7EXAMPLE");
    const summary = summarizeSecretFindings(findings);
    expect(summary[0]).toMatchObject({ kind: "aws_access_key", line: 1 });
    expect(JSON.stringify(summary)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(JSON.stringify(summary)).not.toContain("preview");
  });
});
