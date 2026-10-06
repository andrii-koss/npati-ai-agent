import { describe, expect, it, vi } from "vitest";
import {
  SsrfPolicyError, canonicalIp, isForbiddenIp, isHostnameAllowed, normalizeHostInput,
  parseIpv4Literal, parseIpv6Literal,
} from "../apps/agent-api/src/ssrf-policy";
import { ssrfSafeFetch, type SsrfTransportRequest, type SsrfTransportResponse } from "../apps/agent-api/src/ssrf-safe-http";

const ALLOW = ["api.example.com", "*.example.com", "registry.npmjs.org"];

function stream(body: string | Uint8Array = ""): AsyncIterable<Uint8Array> {
  const buffer = typeof body === "string" ? Buffer.from(body) : body;
  return { async *[Symbol.asyncIterator]() { yield buffer; } };
}

/** Transport double: records every request and replays a scripted list of responses. */
function fakeTransport(responses: Array<Partial<SsrfTransportResponse> & { delayMs?: number }>) {
  const calls: SsrfTransportRequest[] = [];
  const transport = async (request: SsrfTransportRequest): Promise<SsrfTransportResponse> => {
    calls.push(request);
    const scripted = responses[Math.min(calls.length - 1, responses.length - 1)] ?? {};
    if (scripted.delayMs) await new Promise((resolve) => setTimeout(resolve, scripted.delayMs));
    return { status: scripted.status ?? 200, headers: scripted.headers ?? {}, body: scripted.body ?? stream("ok") };
  };
  return { transport, calls };
}

function resolverFor(map: Record<string, string[]>) {
  const calls: string[] = [];
  const resolve = async (host: string) => {
    calls.push(host);
    const value = map[host];
    if (!value) throw new Error(`ENOTFOUND ${host}`);
    return value;
  };
  return { resolve, calls };
}

describe("security-gate: C4b SSRF policy — IP classification", () => {
  it("blocks loopback, RFC1918, link-local, CGNAT, reserved and multicast ranges", () => {
    for (const address of [
      "127.0.0.1", "127.1", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "198.18.0.1", "198.19.1.1", "192.0.0.1", "192.0.2.5", "203.0.113.9", "192.88.99.1",
    ]) {
      expect(isForbiddenIp(address), address).toBe(true);
    }
    expect(isForbiddenIp("93.184.216.34")).toBe(false);
    expect(isForbiddenIp("8.8.8.8")).toBe(false);
  });

  it("blocks every alternative encoding of a private IPv4 literal", () => {
    // Unambiguous encodings: denied *and* canonicalizable for tooling.
    for (const encoded of ["2130706433", "0x7f000001", "0x7f.0.0.1"]) {
      expect(isForbiddenIp(encoded), encoded).toBe(true);
      expect(canonicalIp(encoded), encoded).toBe("127.0.0.1");
    }
    // Leading-zero (octal-looking) encodings are ambiguous: different resolvers read `010` as octal 8
    // (public) or decimal 10 (private). They are denied outright and never canonicalized.
    for (const encoded of ["0177.0.0.1", "017700000001", "010.0.0.1", "08.0.0.1"]) {
      expect(isForbiddenIp(encoded), encoded).toBe(true);
      expect(canonicalIp(encoded), encoded).toBeUndefined();
    }
    expect(parseIpv4Literal("2130706433")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4Literal("0x7f000001")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4Literal("0177.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4Literal("127.1")).toEqual([127, 0, 0, 1]);
  });

  it("blocks IPv6 loopback, unique-local, link-local, multicast and IPv4-mapped private addresses", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1"]) {
      expect(isForbiddenIp(address), address).toBe(true);
    }
    expect(isForbiddenIp("2606:4700:4700::1111")).toBe(false);
    expect(parseIpv6Literal("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
    expect(canonicalIp("::ffff:7f00:1")).toBe("127.0.0.1");
  });

  it("treats unparseable or ambiguous literals as forbidden", () => {
    for (const value of ["", "   ", "999.999.999.999", "1.2.3.4.5", "abc", "127.0.0.1.5", "0x", "08.0.0.1"]) {
      expect(isForbiddenIp(value), value).toBe(true);
    }
  });
});

describe("security-gate: C4b SSRF policy — host allowlist", () => {
  it("applies strict wildcard semantics", () => {
    expect(isHostnameAllowed("api.example.com", ALLOW)).toBe(true); // exact entry
    expect(isHostnameAllowed("a.example.com", ALLOW)).toBe(true); // single-label wildcard
    expect(isHostnameAllowed("example.com", ALLOW)).toBe(false); // wildcard does not match the apex
    expect(isHostnameAllowed("a.b.example.com", ALLOW)).toBe(false); // wildcard matches one label only
    expect(isHostnameAllowed("example.com.attacker.net", ALLOW)).toBe(false);
    expect(isHostnameAllowed("evil.example.com.attacker.net", ALLOW)).toBe(false);
    expect(isHostnameAllowed("npmjs.org.attacker.net", ALLOW)).toBe(false);
    expect(isHostnameAllowed("evil.npmjs.org.attacker.com", ALLOW)).toBe(false);
    expect(isHostnameAllowed("registry.npmjs.org", ["*"])).toBe(false); // bare wildcard is rejected
  });

  it("normalizes hosts (case, trailing dot, IDN, control characters)", () => {
    expect(normalizeHostInput("API.Example.COM.")).toBe("api.example.com");
    expect(normalizeHostInput("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    expect(normalizeHostInput("bücher.example")).toBe("xn--bcher-kva.example");
    expect(() => normalizeHostInput("exa mple.com")).toThrow(SsrfPolicyError);
    expect(() => normalizeHostInput("example.com\u0000")).toThrow(SsrfPolicyError);
    expect(() => normalizeHostInput("")).toThrow(SsrfPolicyError);
  });
});

describe("security-gate: C4b SSRF-safe client", () => {
  it("blocks private destinations, blocked schemes and non-standard ports before any connection", async () => {
    const { transport, calls } = fakeTransport([{}]);
    for (const url of [
      "http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/", "http://[::ffff:127.0.0.1]/",
      // Ambiguous leading-zero literals are refused *before* the URL parser normalizes them.
      "http://08.0.0.1/", "http://010.0.0.1/", "http://0177.0.0.1/",
    ]) {
      await expect(ssrfSafeFetch(url, { allowlist: ALLOW, transport }), url).rejects.toMatchObject({ code: "ssrf_blocked_private_ip" });
    }
    await expect(ssrfSafeFetch("file:///etc/passwd", { allowlist: ALLOW, transport })).rejects.toMatchObject({ code: "ssrf_blocked_scheme" });
    await expect(ssrfSafeFetch("gopher://example.com/", { allowlist: ALLOW, transport })).rejects.toMatchObject({ code: "ssrf_blocked_scheme" });
    await expect(ssrfSafeFetch("http://api.example.com:8080/", { allowlist: ALLOW, transport })).rejects.toMatchObject({ code: "ssrf_blocked_port" });
    await expect(ssrfSafeFetch("http://user:pass@api.example.com/", { allowlist: ALLOW, transport })).rejects.toMatchObject({ code: "ssrf_blocked_credentials" });
    expect(calls).toHaveLength(0);
  });

  it("rejects hosts outside the allowlist, including lookalike suffixes", async () => {
    const { transport, calls } = fakeTransport([{}]);
    for (const url of ["http://evil.npmjs.org.attacker.com/", "http://npmjs.org.attacker.net/", "http://example.com.attacker.net/"]) {
      await expect(ssrfSafeFetch(url, { allowlist: ALLOW, transport })).rejects.toMatchObject({ code: "host_not_allowed" });
    }
    await expect(ssrfSafeFetch("http://api.example.com/", { allowlist: [], transport })).rejects.toMatchObject({ code: "host_not_allowed" });
    expect(calls).toHaveLength(0);
  });

  it("resolves DNS itself and blocks a hostname that resolves to a private address", async () => {
    const { resolve } = resolverFor({ "api.example.com": ["169.254.169.254"] });
    const { transport, calls } = fakeTransport([{}]);
    await expect(ssrfSafeFetch("http://api.example.com/", { allowlist: ALLOW, resolve, transport })).rejects.toMatchObject({ code: "ssrf_blocked_private_ip" });
    expect(calls).toHaveLength(0);
  });

  it("pins the validated address so a later private answer cannot be swapped in (DNS rebinding)", async () => {
    const publicThenPrivate = vi.fn()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValue(["127.0.0.1"]);
    const { transport, calls } = fakeTransport([{}]);
    const result = await ssrfSafeFetch("http://api.example.com/", { allowlist: ALLOW, resolve: publicThenPrivate, transport });
    expect(result.resolvedIp).toBe("93.184.216.34");
    expect(calls[0]!.ip).toBe("93.184.216.34");
    expect(calls[0]!.servername).toBe("api.example.com");
    // The transport received the pinned IP; a rebinding answer after the check is never used.
    expect(calls[0]!.ip).not.toBe("127.0.0.1");
    expect(publicThenPrivate).toHaveBeenCalledTimes(1);
  });

  it("re-validates every redirect: metadata, loopback and non-http targets are refused", async () => {
    for (const location of ["http://169.254.169.254/latest/meta-data/", "http://localhost/", "http://127.0.0.1/", "file:///etc/passwd", "http://10.0.0.5/"]) {
      const { transport, calls } = fakeTransport([{ status: 302, headers: { location } }]);
      // The first hop must resolve through the injected resolver, otherwise the suite would test
      // real DNS instead of the redirect policy.
      const { resolve } = resolverFor({ "api.example.com": ["93.184.216.34"] });
      await expect(ssrfSafeFetch("http://api.example.com/", { allowlist: ALLOW, resolve, transport })).rejects.toMatchObject({
        code: expect.stringMatching(/^ssrf_blocked_|host_not_allowed$/),
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("follows a redirect to another allowed public host and records the hop", async () => {
    const { resolve } = resolverFor({ "api.example.com": ["93.184.216.34"], "cdn.example.com": ["93.184.216.35"] });
    const { transport, calls } = fakeTransport([
      { status: 302, headers: { location: "https://cdn.example.com/page" } },
      { status: 200, body: stream("hello") },
    ]);
    const result = await ssrfSafeFetch("http://api.example.com/", { allowlist: ALLOW, resolve, transport });
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe("hello");
    expect(result.redirects).toEqual([{ from: "http://api.example.com/", to: "https://cdn.example.com/page", status: 302 }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.servername).toBe("cdn.example.com");
    expect(calls[1]!.ip).toBe("93.184.216.35");
  });

  it("stops after the configured redirect budget", async () => {
    const { resolve } = resolverFor({ "api.example.com": ["93.184.216.34"], "a.example.com": ["93.184.216.34"] });
    const { transport } = fakeTransport([{ status: 302, headers: { location: "https://a.example.com/next" } }]);
    await expect(ssrfSafeFetch("http://api.example.com/", { allowlist: ALLOW, resolve, transport, maxRedirects: 5 }))
      .rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("drops Authorization and cookies when a redirect leaves the host", async () => {
    const { resolve } = resolverFor({ "api.example.com": ["93.184.216.34"], "cdn.example.com": ["93.184.216.35"] });
    const cross = fakeTransport([{ status: 302, headers: { location: "https://cdn.example.com/x" } }, { status: 200, body: stream("ok") }]);
    await ssrfSafeFetch("http://api.example.com/", {
      allowlist: ALLOW, resolve, transport: cross.transport,
      headers: { authorization: "Bearer secret", cookie: "a=b", accept: "text/plain" },
    });
    expect(cross.calls[1]!.headers.authorization).toBeUndefined();
    expect(cross.calls[1]!.headers.cookie).toBeUndefined();
    expect(cross.calls[1]!.headers.accept).toBe("text/plain");

    const same = fakeTransport([{ status: 302, headers: { location: "https://api.example.com/other" } }, { status: 200, body: stream("ok") }]);
    await ssrfSafeFetch("http://api.example.com/", { allowlist: ALLOW, resolve, transport: same.transport, headers: { authorization: "Bearer secret" } });
    expect(same.calls[1]!.headers.authorization).toBe("Bearer secret");
  });

  it("bounds the response size and the request time", async () => {
    const { resolve } = resolverFor({ "api.example.com": ["93.184.216.34"] });
    const large = fakeTransport([{ status: 200, body: stream(Buffer.alloc(64, 1)) }]);
    await expect(ssrfSafeFetch("http://api.example.com/", { allowlist: ALLOW, resolve, transport: large.transport, maxBytes: 16 }))
      .rejects.toMatchObject({ code: "response_too_large" });

    const slow = fakeTransport([{ status: 200, body: stream("late"), delayMs: 60 }]);
    await expect(ssrfSafeFetch("http://api.example.com/", { allowlist: ALLOW, resolve, transport: slow.transport, timeoutMs: 10 }))
      .rejects.toMatchObject({ code: "request_timeout" });
  });

  it("reports DNS failures as retryable instead of connecting", async () => {
    const { resolve } = resolverFor({});
    const { transport, calls } = fakeTransport([{}]);
    await expect(ssrfSafeFetch("http://api.example.com/", { allowlist: ALLOW, resolve, transport }))
      .rejects.toMatchObject({ code: "dns_resolution_failed", retryable: true });
    expect(calls).toHaveLength(0);
  });

  it("is never more permissive than the sandbox egress proxy", async () => {
    // The proxy enforces inside the sandbox image and cannot import application code, so the two
    // implementations must be checked against each other. The security-relevant invariant is one-way:
    // anything the proxy refuses, the shared client must refuse as well. The shared policy may be
    // *stricter* (it also refuses AS112 192.175.48.0/24 and the 6to4/NAT64 IPv6 ranges).
    const { publicAddress } = await import("../apps/agent-api/src/sandbox-egress-proxy.mjs");
    const seen: string[] = [];
    const permissive: string[] = [];
    for (const a of ["0", "1", "10", "100", "126", "127", "169", "172", "192", "198", "203", "224", "255"]) {
      for (const b of ["0", "1", "16", "31", "48", "64", "88", "100", "127", "168", "175", "254", "255"]) {
        for (const c of ["0", "2", "18", "19", "48", "51", "99", "113", "168"]) {
          const address = `${a}.${b}.${c}.7`;
          seen.push(address);
          const proxyAllows = publicAddress(address);
          const policyAllows = !isForbiddenIp(address);
          if (policyAllows && !proxyAllows) permissive.push(address);
        }
      }
    }
    expect(seen.length).toBeGreaterThan(1000);
    expect(permissive).toEqual([]);
    // The one intentional difference: the shared policy also refuses AS112 (192.175.48.0/24).
    expect(isForbiddenIp("192.175.48.7")).toBe(true);
    expect(publicAddress("192.175.48.7")).toBe(true);
  });
});
