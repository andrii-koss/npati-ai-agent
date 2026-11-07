
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "./app";
import { createCodeCommandRegistry } from "./code-command-registry";
import { runDependencyAudit, shouldBlockCommit } from "./code-deps-audit";
import { classifyDependencySource, findTyposquatTarget, isRegistryAllowed, resolveDepsGuardPolicy, sourceRequiresApproval } from "./code-deps-guard";
import { buildInstallPlan, packageAddCommand, registryFromConfig, runInstallPlan } from "./code-deps-policy";
import { sessionBranchName } from "./code-git-workflow";
import { createCodeInstructionsLoader } from "./code-instructions-loader";
import { buildPullRequestDescription } from "./code-pr-description";
import { CodeProtectedBranchService } from "./code-protected-branches";
import { activitySinkForKind, createCodeRunActivitySink } from "./code-run-activity-sink";
import { createCodeSkillsService } from "./code-skills-instructions";
import { CodeToolError } from "./code-tool-runtime";
import { CodeWorkspaceRevisionGuard } from "./code-workspace-revision";
import { FeatureFlagService } from "./feature-flags";
import { createProviderDataGuard } from "./provider-data-guard";
import { defaultSkillRegistry } from "@npati/skills";
import { AuthContext } from "@npati/workspace";
import { CodeShellSandboxPort } from "./code-shell-runtime";
import { createCodeRunEnvironmentHolder } from "./coding-agent-runner";

export interface CodeToolWiringDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  CODE_DEPS_MANIFESTS: ReadonlyArray<{ manager: string; manifest: string; lockfile: string | null }>;
  codeActivitySink: ReturnType<typeof createCodeRunActivitySink>;
  codeCommandIds: readonly ["review", "explain", "test", "fix"];
  codeInstructionsLoader: ReturnType<typeof createCodeInstructionsLoader>;
  getCodeRunEnvironment: () => ReturnType<typeof createCodeRunEnvironmentHolder>;
  codeShellRuntimePort: { exec(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId?: string; turnId?: string; command: string; cwd?: string; env?: Record<string, string>; timeoutMs: number; secretRefs?: string[]; approved: boolean }): Promise<{ exitCode?: number | null; stdout: string; stderr: string }> } | undefined;
  featureFlagService: FeatureFlagService;
  providerDataGuardInstance: ReturnType<typeof createProviderDataGuard> | undefined;
  readWorkspaceText: (ctx: AuthContext, companyId: string, projectId: string, file: string) => Promise<string | null>;
}

export function createCodeToolWiring(deps: CodeToolWiringDeps) {
  const { log, getCodeRunEnvironment, CODE_DEPS_MANIFESTS, codeActivitySink, codeCommandIds, codeInstructionsLoader, codeShellRuntimePort, config, featureFlagService, providerDataGuardInstance, readWorkspaceText } = deps;
  const codeCommandRegistry = createCodeCommandRegistry({
    loader: {
      collectCommands: (input) => codeInstructionsLoader.collectCommands(input),
    },
    flags: featureFlagService,
    knownCommandIds: () => [...codeCommandIds],
    systemCommands: [
      {
        declaration: {
          id: "review",
          version: 1,
          description: "Review the current change for correctness, security and missing tests.",
          allowedTools: ["code.fs.read", "code.fs.grep", "code.git.diff", "code.symbols.outline"],
          args: [
            { name: "focus", type: "enum", required: false, values: ["correctness", "security", "tests", "all"], description: "What to look at first" },
          ],
        },
        template: [
          "Review the work in progress as a careful reviewer.",
          "",
          "Read the current diff and the files it touches, then report:",
          "1. defects that would change behaviour, with the file and line;",
          "2. security problems (injection, path traversal, secret handling, unsafe shell);",
          "3. missing or weakened tests;",
          "4. anything you could not verify.",
          "",
          "Do not change any file in this pass, and do not report a check you did not run.",
        ].join("\n"),
      },
      {
        declaration: {
          id: "explain",
          version: 1,
          description: "Explain how the current code works, with the call path and the data it handles.",
          allowedTools: ["code.fs.read", "code.fs.grep", "code.fs.tree", "code.symbols.outline", "code.project.info"],
          args: [{ name: "target", type: "string", required: true, description: "The file, symbol or area to explain" }],
        },
        template: [
          "Explain the target below for a new team member.",
          "",
          "Describe what it does, where it is called from, what it reads and writes, and which invariants a change must not break. Cite the files and line numbers you used.",
        ].join("\n"),
      },
      {
        declaration: {
          id: "test",
          version: 1,
          description: "Run the project's test command for a target and report the real result.",
          allowedTools: ["code.fs.read", "code.shell.exec", "code.fs.grep"],
          forbiddenTools: ["code.git.push", "code.git.commit"],
          args: [{ name: "target", type: "string", required: false, description: "A test file, suite name or pattern" }],
        },
        template: [
          "Run the project's test command for the target below, using the same command the project already documents.",
          "",
          "Report the exact command, its exit code and the failing output verbatim. If the suite cannot run, say so and why — never report a result you did not observe.",
        ].join("\n"),
      },
      {
        declaration: {
          id: "fix",
          version: 1,
          description: "Fix a described defect with the smallest correct change.",
          allowedTools: ["code.fs.read", "code.fs.write", "code.fs.grep", "code.verify.run"],
          args: [{ name: "problem", type: "string", required: true, description: "The defect to fix" }],
        },
        template: [
          "Fix the defect below with the smallest change that is actually correct.",
          "",
          "Read the code first, change only what the fix needs, then run the project's checks and report what they said. Do not refactor around the fix and do not disable a failing check.",
        ].join("\n"),
      },
    ],
    activity: {
      record: async (event) => {
        const sink = event.kind === "run_activity"
          ? activitySinkForKind(codeActivitySink, "run_activity")
          : activitySinkForKind(codeActivitySink, "code_tool_activity");
        await sink.record(event);
      },
    },
    logger: { warn: (payload, message) => { log.warn(payload, message); } },
  });

  const skillPinnedVersion = (version: string): number => {
    let hash = 2_166_136_261;
    for (let index = 0; index < version.length; index += 1) {
      hash ^= version.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash % 1_000_000_000;
  };
  const codeSkillsService = createCodeSkillsService({
    flags: featureFlagService,
    listMetadata: async () =>
      defaultSkillRegistry.list().map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        version: skillPinnedVersion(skill.version),
        source: "builtin" as const,

        trusted: true,
        capabilities: [...skill.capabilities],
      })),
    readBody: async ({ id }) => {
      const skill = defaultSkillRegistry.get(id);
      if (!skill) return null;
      const result = await skill.run({ userMessage: "" });
      const lines = [
        `Skill: ${skill.name} (${skill.id}@${skill.version})`,
        `Purpose: ${skill.purpose ?? skill.description}`,
        skill.requiredTools?.length ? `Required tools: ${skill.requiredTools.join(", ")}` : null,
        skill.optionalTools?.length ? `Optional tools: ${skill.optionalTools.join(", ")}` : null,
        skill.forbiddenTools?.length ? `Forbidden tools: ${skill.forbiddenTools.join(", ")}` : null,
        "",
        result.message,
        result.suggestedActions.length ? `Suggested actions: ${result.suggestedActions.join("; ")}` : null,
      ].filter((line): line is string => line !== null);
      return { body: lines.join("\n"), version: skillPinnedVersion(skill.version), source: "builtin" as const, trusted: true };
    },

    ...(providerDataGuardInstance ? { providerDataGuard: providerDataGuardInstance.providerDataGuard } : {}),
    activity: {
      record: async (event) => {
        await activitySinkForKind(codeActivitySink, "run_activity").record(event as never);
      },
    },
    logger: { warn: (payload, message) => { log.warn(payload, message); } },
  });
  const parseDeclaredDependencies = (manager: string, text: string): Array<{ name: string; version: string | null; scope: string }> => {
    if (manager === "npm" || manager === "pnpm" || manager === "yarn" || manager === "composer") {
      try {
        const parsed = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; require?: Record<string, string>; "require-dev"?: Record<string, string> };
        const groups: Array<[Record<string, string> | undefined, string]> = [
          [parsed.dependencies ?? parsed.require, "runtime"],
          [parsed.devDependencies ?? parsed["require-dev"], "dev"],
          [parsed.peerDependencies, "peer"],
          [parsed.optionalDependencies, "optional"],
        ];
        return groups.flatMap(([group, scope]) => Object.entries(group ?? {}).map(([name, version]) => ({ name, version: String(version), scope })));
      } catch { return []; }
    }
    const declared: Array<{ name: string; version: string | null; scope: string }> = [];
    let section = "";
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      const sectionMatch = /^\[(.+)\]$/.exec(line);
      if (sectionMatch) { section = sectionMatch[1]!.toLowerCase(); continue; }
      if (manager === "pip") {
        const match = /^([A-Za-z0-9._-]+)\s*(?:[=<>!~]=?\s*([^\s;#]+))?/.exec(line);
        if (match) declared.push({ name: match[1]!, version: match[2] ?? null, scope: "runtime" });
        continue;
      }
      if (manager === "go") {
        const match = /^([^\s]+)\s+v?([^\s]+)/.exec(line);
        if (match && !line.startsWith("module") && !line.startsWith("go ")) declared.push({ name: match[1]!, version: match[2]!, scope: line.includes("// indirect") ? "optional" : "runtime" });
        continue;
      }
      const scoped = section === "dependencies" || section === "dev-dependencies" || section === "tool.poetry.dependencies" || section === "tool.poetry.group.dev.dependencies";
      if (!scoped) continue;
      const match = /^"?([A-Za-z0-9._-]+)"?\s*=\s*"?([^"\s]+)"?/.exec(line);
      if (match) declared.push({ name: match[1]!, version: match[2]!, scope: section.includes("dev") ? "dev" : "runtime" });
    }
    return declared;
  };
  const resolveDepsTarget = async (ctx: AuthContext, companyId: string, projectId: string, requestedManager?: string, requestedPath?: string) => {
    const candidates = requestedManager ? CODE_DEPS_MANIFESTS.filter((entry) => entry.manager === requestedManager) : CODE_DEPS_MANIFESTS;
    let withoutLockfile: { manager: string; manifestPath: string; manifestText: string; lockfile: null } | null = null;
    for (const candidate of candidates) {
      const manifestPath = requestedPath ?? candidate.manifest;
      const text = await readWorkspaceText(ctx, companyId, projectId, manifestPath);
      if (text === null) continue;
      const lockfileText = candidate.lockfile ? await readWorkspaceText(ctx, companyId, projectId, candidate.lockfile) : null;
      if (candidate.lockfile && lockfileText !== null) return { manager: candidate.manager, manifestPath, manifestText: text, lockfile: candidate.lockfile };
      if (!withoutLockfile || candidate.manager === "npm") withoutLockfile = { manager: candidate.manager, manifestPath, manifestText: text, lockfile: null };
    }
    return withoutLockfile;
  };
  const codeDepsPort = {
    inspect: async ({ ctx, companyId, projectId, path: requestedPath, manager: requestedManager }: { ctx: AuthContext; companyId: string; projectId: string; path?: string; manager?: string }) => {
      const target = await resolveDepsTarget(ctx, companyId, projectId, requestedManager, requestedPath);
      if (!target) throw new CodeToolError("package_not_found", "No dependency manifest was found in the project workspace", 404, "resolve", false, "code.deps.inspect");
      return {
        manager: target.manager,
        lockfile: target.lockfile,
        declared: parseDeclaredDependencies(target.manager, target.manifestText),
        metadata: { manifest: target.manifestPath },
      };
    },
    audit: async ({ ctx, companyId, projectId, manager: requestedManager, lockfilePath, blockOn, sessionId, sessionMode }: { sessionId?: string; sessionMode?: string; ctx: AuthContext; companyId: string; projectId: string; manager?: string; lockfilePath?: string; blockOn?: string[] }) => {
      const target = await resolveDepsTarget(ctx, companyId, projectId, requestedManager, lockfilePath);
      if (!target) throw new CodeToolError("package_not_found", "No dependency manifest was found in the project workspace", 404, "resolve", false, "code.deps.audit");
      if (target.manager === "yarn" || target.manager === "pnpm" || target.manager === "npm" || target.manager === "pip" || target.manager === "poetry" || target.manager === "composer" || target.manager === "cargo" || target.manager === "go") {
        const auditRunner = async ({ command }: { command: string }) => {
          if (!codeShellRuntimePort) throw new CodeToolError("audit_unavailable", "Dependency audit needs the sandbox shell runtime", 503, "configure", true, "code.deps.audit");
          const executed = await codeShellRuntimePort.exec({ ctx, companyId, projectId, ...(sessionId ? { sessionId } : {}), ...(sessionMode ? { sessionMode } : {}), command, timeoutMs: config.codeAgentLimits?.installBuildTimeoutMs ?? 600_000, approved: false });
          return { exitCode: executed.exitCode ?? 1, stdout: executed.stdout, stderr: executed.stderr };
        };
        const report = await runDependencyAudit({
          manager: target.manager as Parameters<typeof runDependencyAudit>[0]["manager"],
          lockfilePath: target.lockfile ?? target.manifestPath,
          auditRunner,
        });
        const gate = shouldBlockCommit(report, blockOn?.length ? { blockOn: blockOn as never } : {});
        return {
          report: { ...report, advisories: report.advisories.map((advisory) => ({ ...advisory })) },
          blocked: gate.blocked,
          ...(gate.reason ? { reason: gate.reason } : {}),
        };
      }
      throw new CodeToolError("audit_unavailable", `No audit command is known for ${target.manager}`, 503, "configure", false, "code.deps.audit");
    },
    add: async ({ ctx, companyId, projectId, name, version, manager: requestedManager, dev, source, approved, sessionId }: { ctx: AuthContext; companyId: string; projectId: string; name: string; version?: string; manager?: string; dev?: boolean; source?: string; approved: boolean; sessionId?: string }) => {
      const target = await resolveDepsTarget(ctx, companyId, projectId, requestedManager);
      const manager = (requestedManager ?? target?.manager ?? "npm") as Parameters<typeof classifyDependencySource>[0]["manager"];
      const spec = version ? `${name}@${version.replace(/^[\^~]/, "")}` : name;
      const resolvedSource = (source ?? classifyDependencySource({ manager, spec })) as Parameters<typeof sourceRequiresApproval>[0];
      const reasons: string[] = [];
      if (sourceRequiresApproval(resolvedSource) && !approved) reasons.push("deps:source_requires_approval");
      const registryHost = manager === "pip" ? "pypi.org" : registryFromConfig({}).registryHosts[0] ?? "registry.npmjs.org";
      if (!isRegistryAllowed(registryHost, resolveDepsGuardPolicy().allowedRegistries)) reasons.push("deps:registry_not_allowed");
      const typosquat = findTyposquatTarget(name, resolveDepsGuardPolicy().popularPackages, 2);
      if (typosquat) reasons.push(`deps:typosquat_suspected:${typosquat}`);
      if (reasons.length && !approved) {
        return { manager, name, version: version ?? null, source: resolvedSource, verdict: "require_approval" as const, reasons, metadata: { registryHost, lockfile: target?.lockfile ?? null } };
      }
      const plan = buildInstallPlan({
        manager: manager as Parameters<typeof buildInstallPlan>[0]["manager"],
        args: [dev ? "add-dev" : "add", spec],
        lockfilePresent: true,
        registryHost,
      });
      // pip installs from requirements.txt; every other manager adds the named package.
      if (manager !== "pip") {
        const addCommand = packageAddCommand(manager, spec, dev === true);
        if (!addCommand) throw new CodeToolError("install_unavailable", `code.deps.add cannot add "${spec}" with ${manager}; use code.shell.exec`, 400, "validate_arguments", false, "code.deps.add");
        plan.phaseCommands.fetch = [addCommand];
      }
      if (!codeShellRuntimePort) throw new CodeToolError("install_unavailable", "Dependency install needs the sandbox shell runtime", 503, "configure", true, "code.deps.add");
      // The install runs in the project root. With no package.json there but one in a subfolder, it would start a
      // second npm project in the root and leave package.json, a lockfile and node_modules the user never asked for.
      if (["npm", "pnpm", "yarn"].includes(manager) && await readWorkspaceText(ctx, companyId, projectId, "package.json") === null) {
        const found = await codeShellRuntimePort.exec({ ctx, companyId, projectId, sessionId, command: "find . -mindepth 2 -maxdepth 4 -name package.json -not -path '*/node_modules/*' -not -path '*/.npati-runtime/*'", cwd: ".", timeoutMs: 30_000, approved }).catch(() => null);
        const folders = (found?.stdout ?? "").split("\n").map((line) => line.trim().replace(/^\.\//, "").replace(/\/?package\.json$/, "")).filter(Boolean);
        if (folders.length) {
          return { manager, name, version: version ?? null, source: resolvedSource, verdict: "denied" as const, reasons: ["deps:no_root_manifest", `The project root has no package.json; ${folders.slice(0, 5).join(", ")} ${folders.length === 1 ? "has" : "have"} one. To add ${spec} there, run \`${packageAddCommand(manager, spec, dev === true)}\` with code.shell.exec and cwd set to that folder.`], metadata: { registryHost, lockfile: null, subfolders: folders.slice(0, 5) } };
        }
      }
      const runner = {
        supportsNetworkIsolation: false,
        run: async (command: string) => {
          if (manager === "pip") command = command.replace(/^pip /,".venv/bin/python -m pip ");
          const executed = await codeShellRuntimePort!.exec({ ctx, companyId, projectId, sessionId, command, timeoutMs: config.codeAgentLimits?.installBuildTimeoutMs ?? 600_000, approved });
          return { exitCode: executed.exitCode ?? 1, stdout: executed.stdout, stderr: executed.stderr };
        },
      };
      const result = await runInstallPlan(plan, runner, { approved: approved === true });
      // "added" is a fact about the manifest, not about the exit code.
      const manifest = result.ok && manager !== "pip" ? await readWorkspaceText(ctx, companyId, projectId, "package.json") : null;
      if (result.ok && manager !== "pip" && !manifest?.includes(`"${name}"`)) {
        return { manager, name, version: version ?? null, source: resolvedSource, verdict: "denied" as const, reasons: ["deps:not_in_manifest"], metadata: { commands: result.phases.map((phase) => phase.command), registryHost, lockfile: target?.lockfile ?? null } };
      }
      return {
        manager,
        name,
        version: version ?? null,
        source: resolvedSource,
        verdict: result.ok ? ("added" as const) : (result.code === "approval_required" ? ("require_approval" as const) : ("denied" as const)),
        reasons: result.ok ? ["deps:installed"] : [result.code ?? "deps:install_failed", ...(result.message ? [result.message] : [])],
        metadata: { commands: result.phases.map((phase) => phase.command), registryHost, lockfile: target?.lockfile ?? null },
      };
    },
  };
  /**
   * C11 (owner decisions 2, 7, 8, 10 and 13): the `code.git.*` executors' ports.
   *
   *  - `revisions` is the single `CodeWorkspaceRevisionGuard` built above, next to the git boundary: the
   *    runtime captures the canonical revision it authorises a call against and the executors re-check it
   *    before a commit or a push (owner decision 7);
   *  - `assertProtectedBranch` is `CodeProtectedBranchService.assertGitWriteAllowed` — the **same** decision
   *    phase 4b and the git boundary make. A git tool therefore cannot reach a branch decision that the other
   *    two checks would not have made;
   *  - `sessionBranch` is `sessionBranchName(sessionId)` (`npati/<session-short-id>`), so a commit or a push
   *    asserts it is on the branch the session was told to work on (owner decision 8);
   *  - `describeRun` reuses the run's own `CodingAgentRunSummary` for a pull-request body (owner decision 11).
   *    It reads the live summary the runner publishes, and a call outside a run answers `null` — the tool then
   *    says `descriptionSource: "unavailable"` rather than inventing a description.
   */
  /**
   * Owner decision 11: the pull-request description is generated from the run's **own**
   * `CodingAgentRunSummary` — the live one the runner publishes — and never from a second format. A tool call
   * outside a run (or a run whose summary is not published) answers `null`, which the executor reports as
   * `descriptionSource: "unavailable"` instead of inventing prose that reads like a verified summary.
   */
  const describeCodeRunForPullRequest = async (): Promise<{ title: string; body: string } | null> => {
    const summary = getCodeRunEnvironment().runSummary();
    if (!summary) return null;
    const description = buildPullRequestDescription({ summary });
    return { title: description.title, body: description.body };
  };

  return {
    codeCommandRegistry,
    codeSkillsService,
    codeDepsPort,
    describeCodeRunForPullRequest,
  };
}
