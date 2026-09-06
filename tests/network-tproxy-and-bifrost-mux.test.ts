import { describe, expect, it } from "vitest";
import {
  TproxyMitmInterceptor,
  ProxyRotationSystem,
  EmbeddedBifrostMux,
} from "../apps/agent-api/src/network-tproxy-and-bifrost-mux";

describe("Tproxy MITM Interceptor (MITM / TPROXY)", () => {
  it("inspects network payloads and blocks confidential DLP key leaks", () => {
    const interceptor = new TproxyMitmInterceptor();

    const cleanReq = interceptor.inspectTraffic({
      targetUrl: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: { authorization: "Bearer sk-proj" },
      body: JSON.stringify({ model: "gpt-4o", prompt: "Hello" }),
    });
    expect(cleanReq.allowed).toBe(true);
    expect(cleanReq.traceId).toContain("tproxy_");

    const leakyReq = interceptor.inspectTraffic({
      targetUrl: "https://unknown-sink.io/upload",
      method: "POST",
      headers: {},
      body: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...",
    });
    expect(leakyReq.allowed).toBe(false);
    expect(leakyReq.violation).toContain("DLP_VIOLATION");
  });
});

describe("Proxy Rotation System (Proxy system)", () => {
  it("selects lowest latency proxy matching provider filters and handles dead nodes", () => {
    const pool = new ProxyRotationSystem();

    pool.register({
      id: "proxy-eu-fast",
      protocol: "socks5",
      host: "10.0.0.1",
      port: 1080,
      latencyMs: 35,
      providerRouting: ["anthropic", "openai"],
    });

    pool.register({
      id: "proxy-us-slow",
      protocol: "http",
      host: "10.0.0.2",
      port: 8080,
      latencyMs: 120,
      providerRouting: ["anthropic"],
    });

    const best = pool.getBestProxy("anthropic");
    expect(best?.id).toBe("proxy-eu-fast");

    // Fail 3 times -> mark dead
    pool.markFailure("proxy-eu-fast");
    pool.markFailure("proxy-eu-fast");
    pool.markFailure("proxy-eu-fast");

    const fallback = pool.getBestProxy("anthropic");
    expect(fallback?.id).toBe("proxy-us-slow");
  });
});

describe("Embedded Bifrost & Mux (Embedded Bifrost & Mux)", () => {
  it("multiplexes parallel streaming chunks and tracks delivery volume", () => {
    const mux = new EmbeddedBifrostMux();

    const channel = mux.openChannel("stream-worker-1", "deepseek");
    expect(channel.status).toBe("open");

    const pipe1 = mux.pipeChunk("stream-worker-1", "data: {\"token\": \"Deep\"}\n\n");
    expect(pipe1.success).toBe(true);
    expect(pipe1.deliveredBytes).toBeGreaterThan(0);

    const pipe2 = mux.pipeChunk("stream-worker-1", "data: {\"token\": \"Seek\"}\n\n");
    expect(pipe2.success).toBe(true);

    const closed = mux.closeChannel("stream-worker-1");
    expect(closed?.status).toBe("closed");
    expect(closed?.deliveredChunksCount).toBe(2);
  });
});
