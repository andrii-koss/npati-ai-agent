import net from "node:net";
import http from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const allowed = new Set((process.env.ALLOWED_HOSTS ?? "registry.npmjs.org,registry.yarnpkg.com,pypi.org,files.pythonhosted.org,repo.packagist.org,packagist.org,github.com,codeload.github.com,api.github.com,objects.githubusercontent.com").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
export function publicAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 168) || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) return false;
  if (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}
async function destination(host, port) {
  const clean = host.toLowerCase().replace(/\.$/, "");
  if (!allowed.has(clean) || ![80, 443].includes(Number(port))) throw new Error("host_not_allowed");
  const addresses = await lookup(clean, { all: true, family: 4 });
  const address = addresses.find((item) => publicAddress(item.address));
  if (!address) throw new Error("address_not_allowed");
  return address.address;
}
export function clientHelloServerName(buffer) { try {
  if (buffer.length < 5) return undefined;
  if (buffer[0] !== 22 || buffer[1] !== 3) return null;
  const recordEnd = 5 + buffer.readUInt16BE(3);
  if (recordEnd > 16_384) return null;
  if (buffer.length < recordEnd) return undefined;
  if (buffer[5] !== 1) return null;
  let index = 9 + 2 + 32;
  if (index >= recordEnd) return null;
  index += 1 + buffer[index];
  if (index + 2 > recordEnd) return null;
  index += 2 + buffer.readUInt16BE(index);
  if (index >= recordEnd) return null;
  index += 1 + buffer[index];
  if (index + 2 > recordEnd) return null;
  const extensionsEnd = index + 2 + buffer.readUInt16BE(index);
  index += 2;
  if (extensionsEnd > recordEnd) return null;
  while (index + 4 <= extensionsEnd) {
    const type = buffer.readUInt16BE(index), length = buffer.readUInt16BE(index + 2);
    index += 4;
    if (index + length > extensionsEnd) return null;
    if (type === 0) {
      if (length < 5 || buffer[index + 2] !== 0) return null;
      const nameLength = buffer.readUInt16BE(index + 3);
      if (nameLength < 1 || 5 + nameLength > length) return null;
      return buffer.toString("utf8", index + 5, index + 5 + nameLength).toLowerCase();
    }
    index += length;
  }
  return null;
  } catch { return null; }
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url);
    if (url.protocol !== "http:") throw new Error("invalid_scheme");
    const address = await destination(url.hostname, url.port || 80);
    const outgoing = http.request({ hostname: address, port: 80, method: req.method, path: url.pathname + url.search, headers: { ...req.headers, host: url.hostname } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    outgoing.on("error", (err) => { console.warn(`[egress-proxy] http outgoing error for ${url.hostname}:`, err.message); if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(outgoing);
  } catch (err) {
    console.warn(`[egress-proxy] http rejected: ${req.url} - ${err instanceof Error ? err.message : String(err)}`);
    res.writeHead(403); res.end();
  }
});
server.on("connect", async (req, client, head) => {
  client.pause();
  try {
    const parts = req.url.split(":");
    if (parts.length !== 2 || Number(parts[1]) !== 443) throw new Error("invalid_host");
    const host = parts[0].toLowerCase();
    const address = await destination(host, 443);
    const upstream = net.connect(443, address);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      let buffered = Buffer.from(head);
      const timer = setTimeout(() => {
        console.warn(`[egress-proxy] SNI timeout for host: ${host}`);
        client.destroy(); upstream.destroy();
      }, 5_000);
      const onData = (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > 16_384) {
          console.warn(`[egress-proxy] ClientHello exceeded buffer limit for host: ${host}`);
          client.destroy(); upstream.destroy(); return;
        }
        const serverName = clientHelloServerName(buffered);
        if (serverName === undefined) return;
        clearTimeout(timer);
        client.off("data", onData);
        if (serverName !== host) {
          console.warn(`[egress-proxy] SNI mismatch: requested ${host} but got ${serverName}`);
          client.destroy(); upstream.destroy(); return;
        }
        upstream.write(buffered);
        client.pipe(upstream);
        upstream.pipe(client);
      };
      client.on("data", onData);
      client.resume();
      if (buffered.length) onData(Buffer.alloc(0));
    });
    upstream.on("error", (err) => {
      console.warn(`[egress-proxy] upstream connection error to ${host} (${address}):`, err.message);
      client.destroy();
    });
    client.on("error", () => upstream.destroy());
  } catch (err) {
    console.warn(`[egress-proxy] CONNECT rejected for ${req.url}:`, err instanceof Error ? err.message : String(err));
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
});
if (process.env.NPATI_EGRESS_TEST !== "true") server.listen(8080, "0.0.0.0");