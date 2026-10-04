import { describe, expect, it, vi } from "vitest";
import { dockerFailure, safeDockerStderr } from "../apps/agent-api/src/sandbox-runner-diagnostics";
import { RemoteSandboxProvider, SandboxProviderError } from "../apps/agent-api/src/sandbox-provider";

const secret = "a".repeat(40);
const scope = { workspaceId: "workspace", userId: "user", companyId: "company", projectId: "project" };

describe("sandbox runner diagnostics", () => {
  it.each([
    ["permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock", "docker_socket_permission_denied", "Docker socket permission denied"],
    ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock", "docker_daemon_unavailable", "Docker daemon unavailable"],
    ["Error response from daemon: No such image: npati/project-sandbox:local", "sandbox_image_not_found", "Sandbox image not found"],
    ["Error response from daemon: network npati-net-1 not found", "sandbox_network_not_found", "Sandbox Docker network not found"],
    ["OCI runtime create failed: container failed to start", "sandbox_container_start_failed", "Sandbox container failed to start"],
    ["no space left on device", "sandbox_storage_full", "Sandbox storage is full"],
  ])("preserves a specific safe reason for %s", (stderr, code, message) => {
    const error = dockerFailure("create", stderr);
    expect(error).toMatchObject({ code, message, status: 503, step: "create" });
    expect(error.diagnostics?.dockerStderr).toContain(stderr);
  });
  it("reports missing Docker CLI and timeouts", () => {
    expect(dockerFailure("network.create", "spawn docker ENOENT", false, "ENOENT").code).toBe("docker_cli_missing");
    expect(dockerFailure("create", "", true)).toMatchObject({ code: "docker_timeout", status: 504 });
  });
  it("redacts secrets and URLs from Docker stderr", () => {
    const output = safeDockerStderr("token=secret-value https://user:password@example.com/path --env SECRET=secret-value");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("example.com");
    expect(output).toContain("[REDACTED]");
  });
  it("returns runner error code, message, operation and HTTP status to agent-api", async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ error: { code: "sandbox_image_not_found", message: "Sandbox image not found" } }), { status: 503 }));
    const provider = new RemoteSandboxProvider("http://sandbox-runner:7865", secret, transport as typeof fetch, "local");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(provider.createSandbox(scope)).rejects.toMatchObject<SandboxProviderError>({ code: "sandbox_image_not_found", message: "Sandbox image not found", status: 503, step: "createSandbox" });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('"httpStatus":503'));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('"projectId":"project"'));
    } finally { spy.mockRestore(); }
  });
});
