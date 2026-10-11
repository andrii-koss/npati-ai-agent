import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { MinioObjectStorage, NPATI_BUCKETS } from "../apps/agent-api/src/object-storage";

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

async function storage(headStatus: number, getCode?: string) {
  const requests: string[] = [];
  server = createServer((request, response) => {
    requests.push(request.method + " " + request.url);
    response.setHeader("Connection", "close");
    response.setHeader("Content-Type", "application/xml");
    if (request.method === "HEAD") {
      response.writeHead(headStatus, { "x-minio-error-code": "SignatureDoesNotMatch" });
      response.end();
    } else if (getCode) {
      response.writeHead(403);
      // The diagnostic response body must never be included in the thrown error.
      response.end(`<Error><Code>${getCode}</Code><Message>credential-secret-do-not-log</Message></Error>`);
    } else {
      response.writeHead(200);
      response.end("<ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  return {
    requests,
    client: new MinioObjectStorage({
      endPoint: "127.0.0.1", port: address.port, useSSL: false,
      accessKey: "test-user", secretKey: "credential-secret-do-not-log", region: "us-east-1",
    }),
  };
}

describe("MinIO startup diagnostics with the real SDK", () => {
  it.each(["InvalidAccessKeyId", "SignatureDoesNotMatch", "RequestTimeTooSkewed", "AccessDenied"])(
    "reports %s from the authenticated GET after a generic HEAD 403", async code => {
      const { client, requests } = await storage(403, code);
      const error = await client.initialize().catch(error => error);
      expect(error).toMatchObject({ code: "AccessDenied", diagnosticCode: code, bucket: NPATI_BUCKETS.chat, operation: "bucket check" });
      expect(error.message).toContain(code);
      expect(error.message).not.toContain("credential-secret-do-not-log");
      expect(JSON.stringify(error)).not.toContain("credential-secret-do-not-log");
      expect(requests).toEqual(["HEAD /" + NPATI_BUCKETS.chat, "GET /"]);
    },
  );
  it("distinguishes accepted credentials from a denied bucket operation", async () => {
    const { client } = await storage(403);
    await expect(client.initialize()).rejects.toMatchObject({ diagnosticCode: "ListBucketsSucceeded" });
  });
  it("leaves successful initialization unchanged and makes no diagnostic requests", async () => {
    const { client, requests } = await storage(200);
    await client.initialize();
    expect(requests).toEqual(Object.values(NPATI_BUCKETS).map(bucket => "HEAD /" + bucket));
  });
  it("still creates missing buckets without diagnostic requests", async () => {
    const { client, requests } = await storage(404);
    // A missing bucket proceeds to creation, whose mocked response is not an S3 error.
    await client.initialize();
    expect(requests.some(request => request === "GET /")).toBe(false);
    expect(requests.filter(request => request.startsWith("PUT "))).toHaveLength(4);
  });
  it("preserves non-authorization errors without extra requests", async () => {
    const { client, requests } = await storage(400);
    await expect(client.initialize()).rejects.toMatchObject({ name: "S3Error", code: "" });
    expect(requests).toEqual(["HEAD /" + NPATI_BUCKETS.chat]);
  });
});
