import { describe, expect, it } from "vitest";

process.env.NPATI_EGRESS_TEST = "true";
const { publicAddress, clientHelloServerName } = await import("../apps/agent-api/src/sandbox-egress-proxy.mjs");

function hello(host: string) {
  const name = Buffer.from(host);
  const serverName = Buffer.concat([Buffer.from([0, name.length + 3, 0, 0, name.length]), name]);
  const extension = Buffer.concat([Buffer.from([0, 0, 0, serverName.length]), serverName]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0, 0, 2, 0x13, 1, 1, 0, 0, extension.length]), extension]);
  const handshake = Buffer.concat([Buffer.from([1, 0, 0, body.length]), body]);
  return Buffer.concat([Buffer.from([22, 3, 3, handshake.length >> 8, handshake.length & 255]), handshake]);
}
describe("Sandbox egress proxy", () => {
  it("rejects private, loopback, link-local, and reserved addresses", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.18.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "198.18.0.1", "192.0.2.1", "203.0.113.1", "::1"]) expect(publicAddress(address)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
  });
  it("extracts TLS SNI and rejects non-TLS or incomplete client hello", () => {
    const clientHello = hello("registry.npmjs.org");
    expect(clientHelloServerName(clientHello)).toBe("registry.npmjs.org");
    expect(clientHelloServerName(clientHello.subarray(0, 10))).toBeUndefined();
    expect(clientHelloServerName(Buffer.from("GET / HTTP/1.1"))).toBeNull();
  });
});