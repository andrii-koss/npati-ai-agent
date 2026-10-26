import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { once } from "node:events";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(require.resolve("minio")), "../..");

describe("patched MinIO notification JSONL transport", () => {
  for (const entry of ["dist/main/minio.js", "dist/esm/minio.mjs"]) {
    it(`serializes versioned S3 reads with the security-patched query-string in ${entry}`, async () => {
      const { Client } = await import(path.join(root, entry));
      const client = new Client({ endPoint: "localhost", port: 9000, useSSL: false, accessKey: "fixture", secretKey: "fixture-secret" });
      const request = vi.spyOn(client, "makeRequestAsync").mockResolvedValue(Readable.from(["verified object"]));
      const stream = await client.getObject("sdk-regression", "probe.txt", { versionId: "version-1" });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("verified object");
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", bucketName: "sdk-regression", objectName: "probe.txt", query: "versionId=version-1" }), "", [200]);
    });
  }
  for (const entry of ["dist/main/notification.js", "dist/esm/notification.mjs"]) {
    it(`delivers fragmented and multiple S3 events through ${entry}`, async () => {
      const { NotificationPoller } = await import(path.join(root, entry));
      const response = Readable.from(['{"Records":[{"eventName":"s3:Object', 'Created:Put"}]}\n', '{"Records":null}\n', '{"Records":[{"eventName":"s3:ObjectRemoved:Delete"}]}\n']);
      const poller = new NotificationPoller({ region: "us-east-1", makeRequestAsync: async () => response }, "regression-bucket", "", "", []);
      const records: unknown[] = [];
      const finished = once(poller, "notification");
      poller.on("notification", (record: unknown) => { records.push(record); if (records.length === 2) poller.stop(); });
      poller.start();
      await finished;
      await new Promise<void>(resolve => response.on("close", resolve));
      expect(records).toEqual([{ eventName: "s3:ObjectCreated:Put" }, { eventName: "s3:ObjectRemoved:Delete" }]);
    });
  }
});
