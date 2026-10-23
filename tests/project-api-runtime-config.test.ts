import { describe, expect, it } from "vitest";
import { assertSandboxProjectApiUrl } from "../apps/agent-api/src/project-api-runtime-config";

describe("Project API sandbox static preflight", () => {
  it.each(["http://127.0.0.1:13001", "http://localhost:3001", "http://agent-api:3001", "http://[::1]", "http://postgres-projects", "https://metadata.google.internal", "http://api.example.com:13001", "https://user:password@api.example.com", "file:///tmp/api"])("rejects incompatible configuration %s", value => {
    expect(() => assertSandboxProjectApiUrl(value)).toThrow(expect.objectContaining({ code: "PROJECT_API_UNREACHABLE_CONFIGURATION" }));
  });
  it("accepts a hostname for subsequent existing proxy DNS and IP enforcement", () => {
    expect(() => assertSandboxProjectApiUrl("https://api.example.com")).not.toThrow();
  });
});
