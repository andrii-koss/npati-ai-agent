import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { assertOAuthTokenEndpoint, postOAuthTokenRequest, privateMailHostsAllowed, resolveMailDestination } from "../apps/agent-api/src/email-destination-policy";
import { EmailConnectionTester } from "../apps/agent-api/src/email-connection-tester";

/**
 * Security audit 2026-11-24.
 * M1: the OAuth token URL was checked as a string only (https://127.0.0.1, metadata IPs and private DNS answers passed),
 *     and the refresh followed redirects to internal plain-HTTP services.
 * M2: IMAP/SMTP host:port from the request made the connection test an internal port scanner.
 */
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });
const resolverTo = (...addresses: string[]) => async () => addresses;

describe("M2: mail destinations", () => {
  it.each([
    ["127.0.0.1", 25], ["10.0.0.5", 587], ["169.254.169.254", 465], ["[::1]", 993], ["172.18.0.3", 143],
  ])("refuses private address %s:%d", async (host, port) => {
    delete process.env.NPATI_MAIL_ALLOW_PRIVATE_HOSTS;
    await expect(resolveMailDestination(host, port)).rejects.toMatchObject({ code: "ssrf_blocked_private_ip" });
  });

  it("refuses a public name that resolves to a private address (Docker service / DNS trick)", async () => {
    delete process.env.NPATI_MAIL_ALLOW_PRIVATE_HOSTS;
    await expect(resolveMailDestination("mail.attacker.example", 587, { resolve: resolverTo("93.184.216.34", "10.1.2.3") }))
      .rejects.toMatchObject({ code: "ssrf_blocked_private_ip" });
  });

  it("refuses non-mail ports and single-label internal names", async () => {
    delete process.env.NPATI_MAIL_ALLOW_PRIVATE_HOSTS;
    await expect(resolveMailDestination("mail.example.com", 5432, { resolve: resolverTo("93.184.216.34") })).rejects.toMatchObject({ code: "ssrf_blocked_port" });
    await expect(resolveMailDestination("postgres", 587)).rejects.toMatchObject({ code: "host_not_allowed" });
  });

  it("returns the validated public address to connect to", async () => {
    await expect(resolveMailDestination("smtp.example.com", 587, { resolve: resolverTo("93.184.216.34") })).resolves.toBe("93.184.216.34");
  });

  it("the private-network opt-in is never honoured on an NPATI-hosted installation", () => {
    process.env.NPATI_MAIL_ALLOW_PRIVATE_HOSTS = "true";
    process.env.NPATI_DEPLOYMENT_TYPE = "self_hosted";
    expect(privateMailHostsAllowed()).toBe(true);
    process.env.NPATI_DEPLOYMENT_TYPE = "npati_hosted";
    expect(privateMailHostsAllowed()).toBe(false);
  });

  it("the connection tester refuses before opening any socket", async () => {
    delete process.env.NPATI_MAIL_ALLOW_PRIVATE_HOSTS;
    const connect = vi.spyOn(net, "connect");
    const result = await EmailConnectionTester.testSmtp({ host: "127.0.0.1", port: 5432 } as never);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("refused");
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("M1: OAuth token endpoint", () => {
  it.each([
    "https://127.0.0.1/token", "https://169.254.169.254/latest/meta-data", "https://localhost/token",
    "http://oauth.example.com/token", "https://oauth.example.com:8443/token", "https://[::ffff:10.0.0.1]/token",
  ])("refuses %s", async (url) => {
    await expect(assertOAuthTokenEndpoint(url, resolverTo("93.184.216.34"))).rejects.toBeTruthy();
  });

  it("refuses a public name resolving to a private address", async () => {
    await expect(assertOAuthTokenEndpoint("https://oauth.attacker.example/token", resolverTo("10.0.0.7"))).rejects.toMatchObject({ code: "ssrf_blocked_private_ip" });
  });

  it("posts without following redirects and does not echo the response text", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 307, headers: {}, body: Buffer.from("{}"), bytes: 2, redirects: [], resolvedIp: "93.184.216.34", finalUrl: "", decision: { allowed: true as const, host: "" } }));
    vi.spyOn(await import("../apps/agent-api/src/ssrf-policy"), "resolveAndValidate").mockResolvedValue({ addresses: ["93.184.216.34"], ip: "93.184.216.34" });
    const result = await postOAuthTokenRequest("https://oauth.example.com/token", new URLSearchParams({ a: "b" }), { fetch: fetch as never });
    expect(result).toMatchObject({ ok: false, status: 307 });
    expect(fetch).toHaveBeenCalledWith("https://oauth.example.com/token", expect.objectContaining({ maxRedirects: 0, allowedPorts: [443] }));
  });
});
