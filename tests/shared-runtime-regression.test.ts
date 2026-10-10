import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProjectRuntimeProvider, projectRuntimeMode, RemoteSandboxProvider } from "../apps/agent-api/src/sandbox-provider";
import { DockerSandboxProvider } from "../apps/agent-api/src/docker-sandbox-provider";
import { ProjectSandboxService } from "../apps/agent-api/src/project-sandbox-service";
import type { ProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import type { ProjectTerminalEventsRepository } from "../apps/agent-api/src/project-terminal-events";
import type { AuthContext, Project } from "@npati/workspace";
import type { SandboxProvider } from "../apps/agent-api/src/sandbox-provider";

const scope = { workspaceId: "ws", userId: "user", companyId: "company", projectId: "project" };
afterEach(() => vi.unstubAllEnvs());
describe("frozen shared local runtime", () => {
  it("retains all five shared project scopes after repeated main/child run cleanup, and deletes only explicitly", async () => {
    const projects = Array.from({ length: 5 }, (_, index) => ({ id: `project-${index}`, companyId: "company", sandboxId: `scope-${index}` }) as Project);
    const destroySandbox = vi.fn(async () => undefined), stopSandbox = vi.fn(), setProjectSandbox = vi.fn();
    const get = vi.fn(async (_ctx: AuthContext, _company: string, id: string) => projects.find(project => project.id === id)!);
    const service = new ProjectSandboxService({ get }, { getCompanyAgent: vi.fn(), setProjectSandbox },
      {} as ProjectWorkspace, { executionMode: "shared", destroySandbox, stopSandbox } as unknown as SandboxProvider, {} as ProjectTerminalEventsRepository);
    const ctx = { userId: "user", workspaceId: "ws", permissions: ["workspace:write"] } as AuthContext;
    for (let run = 0; run < 4; run++) for (const project of projects) await service.releaseAfterRun(ctx, project);
    expect(get).toHaveBeenCalledTimes(20);
    expect(destroySandbox).not.toHaveBeenCalled(); expect(stopSandbox).not.toHaveBeenCalled(); expect(setProjectSandbox).not.toHaveBeenCalled();
    await service.destroy(ctx, projects[0]!);
    expect(destroySandbox).toHaveBeenCalledOnce();
    expect(destroySandbox.mock.calls[0]).toEqual([expect.objectContaining({ projectId: "project-0" }), "scope-0"]);
  });
  it("defaults local/self-hosted to shared and keeps explicitly isolated deployments", () => {
    expect(projectRuntimeMode({ NPATI_DEPLOYMENT_TYPE: "self_hosted" })).toBe("shared");
    expect(projectRuntimeMode({ NPATI_SANDBOX_RUNNER_MODE: "local" })).toBe("shared");
    expect(projectRuntimeMode({ NPATI_DEPLOYMENT_TYPE: "npati_hosted" })).toBe("isolated");
    expect(projectRuntimeMode({ NPATI_PROJECT_RUNTIME_MODE: "isolated", NPATI_DEPLOYMENT_TYPE: "self_hosted" })).toBe("isolated");
    expect(() => projectRuntimeMode({ NPATI_PROJECT_RUNTIME_MODE: "shared", NPATI_DEPLOYMENT_TYPE: "npati_hosted" })).toThrow("Hosted");
    expect(() => projectRuntimeMode({ NPATI_PROJECT_RUNTIME_MODE: "typo" })).toThrow("Invalid");
  });
  it("refuses Docker creation immediately in shared mode, before image admission or Docker", async () => {
    vi.stubEnv("NPATI_PROJECT_RUNTIME_MODE", "shared");
    const admit = vi.fn();
    const provider = new DockerSandboxProvider({}, { admit });
    await expect(provider.createSandbox(scope)).rejects.toMatchObject({ code: "runtime_architecture_violation" });
    expect(admit).not.toHaveBeenCalled();
    expect(() => assertProjectRuntimeProvider("shared")).not.toThrow();
    vi.stubEnv("NPATI_PROJECT_RUNTIME_MODE", "isolated");
    expect(() => assertProjectRuntimeProvider("isolated")).not.toThrow();
  });
  it("rejects a substituted isolated runner on creation, execution and recovery without a sandbox call", async () => {
    vi.stubEnv("NPATI_PROJECT_RUNTIME_MODE", "shared");
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ overall_ready: true, details: { runtimeMode: "isolated" } })));
    const provider = new RemoteSandboxProvider("https://runner.example", "x".repeat(32), transport);
    for (const operation of [() => provider.createSandbox(scope), () => provider.getStatus(scope, "old"),
      () => provider.executeCommand(scope, "old", "pwd", { timeoutMs: 1000, outputLimitBytes: 1000 })]) {
      await expect(operation()).rejects.toMatchObject({ code: "runtime_architecture_violation" });
    }
    expect(transport.mock.calls).toHaveLength(3);
    expect(transport.mock.calls.every(args => String(args[0]).endsWith("/v1/readiness"))).toBe(true);
  });
  it("admits authenticated ready shared runtime and does not fall back if it becomes unready", async () => {
    vi.stubEnv("NPATI_PROJECT_RUNTIME_MODE", "shared");
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ overall_ready: true, details: { runtimeMode: "shared" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: "logical-workspace" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ overall_ready: false, details: { runtimeMode: "shared" } })));
    const provider = new RemoteSandboxProvider("https://runner.example", "x".repeat(32), transport);
    expect(await provider.createSandbox(scope)).toEqual({ id: "logical-workspace" });
    await expect(provider.getStatus(scope, "logical-workspace")).rejects.toMatchObject({ code: "runtime_architecture_violation" });
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it("does not let an explicitly isolated deployment use the shared backend", async () => {
    vi.stubEnv("NPATI_PROJECT_RUNTIME_MODE", "isolated");
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ overall_ready: true, details: { runtimeMode: "shared" } })));
    const provider = new RemoteSandboxProvider("https://runner.example", "x".repeat(32), transport);
    await expect(provider.createSandbox(scope)).rejects.toMatchObject({ code: "runtime_architecture_violation" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("reports unavailable shared readiness and sends no project operation", async () => {
    vi.stubEnv("NPATI_PROJECT_RUNTIME_MODE", "shared");
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const provider = new RemoteSandboxProvider("https://runner.example", "x".repeat(32), transport);
    await expect(provider.getStatus(scope, "existing")).rejects.toMatchObject({ code: "runner_unavailable", step: "provider_selection" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
