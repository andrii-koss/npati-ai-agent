import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DockerSandboxProvider } from "../apps/agent-api/src/docker-sandbox-provider";
import { RemoteSandboxProvider } from "../apps/agent-api/src/sandbox-provider";

const scope = { workspaceId: "workspace-a", userId: "user-a", companyId: "company-a", projectId: "project-a" };
describe("Remote sandbox provider", () => {
  it("signs each request with body, timestamp, and nonce", async () => {
    const secret = "sandbox-test-secret-12345678901234567890";
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? ""), headers = new Headers(init?.headers);
      const timestamp = headers.get("x-npati-timestamp")!;
      const nonce = headers.get("x-npati-nonce")!;
      expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
      expect(headers.get("x-npati-signature")).toBe(createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("hex"));
      expect(JSON.parse(body)).toMatchObject({ operation: "getStatus", payload: { scope, sandboxId: "sandbox-a" } });
      return new Response(JSON.stringify({ result: { id: "sandbox-a", state: "running", createdAt: "", lastActivityAt: "" } }), { status: 200 });
    });
    const provider = new RemoteSandboxProvider("https://runner.example", secret, transport as typeof fetch);
    expect((await provider.getStatus(scope, "sandbox-a")).state).toBe("running");
    expect(transport).toHaveBeenCalledOnce();
  });
  it("rejects non-TLS external endpoints and weak signing secrets", () => {
    expect(() => new RemoteSandboxProvider("http://runner.example", "a".repeat(40))).toThrow("HTTPS");
    expect(() => new RemoteSandboxProvider("https://runner.example", "short")).toThrow("32 characters");
  });
  it("rejects resource limits that would disable containment", () => {
    expect(() => new DockerSandboxProvider({ cpu: "0" })).toThrow("resource limits");
    expect(() => new DockerSandboxProvider({ memory: "0" })).toThrow("resource limits");
    expect(() => new DockerSandboxProvider({ pids: 0 })).toThrow("resource limits");
    expect(() => new DockerSandboxProvider({ diskBytes: 0 })).toThrow("resource limits");
  });
});