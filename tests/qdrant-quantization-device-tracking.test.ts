import { describe, expect, it } from "vitest";
import {
  QdrantVectorClient,
  Int8VectorQuantizer,
  DeviceTrackingManager,
} from "../apps/agent-api/src/qdrant-quantization-device-tracking";

describe("Qdrant Vector Client (Qdrant support)", () => {
  it("indexes vectors and performs filtered vector similarity search", () => {
    const client = new QdrantVectorClient();

    client.upsert("npati_docs", [
      {
        id: "p1",
        vector: [1.0, 0.0, 0.0],
        payload: { tenantId: "tenant-a", title: "Doc 1" },
      },
      {
        id: "p2",
        vector: [0.0, 1.0, 0.0],
        payload: { tenantId: "tenant-b", title: "Doc 2" },
      },
      {
        id: "p3",
        vector: [0.9, 0.1, 0.0],
        payload: { tenantId: "tenant-a", title: "Doc 3" },
      },
    ]);

    // Search for vector similar to [1, 0, 0] with tenant-a filter
    const hits = client.search("npati_docs", [1.0, 0.0, 0.0], { tenantId: "tenant-a" });
    expect(hits.length).toBe(2);
    expect(hits[0]!.id).toBe("p1");
    expect(hits[0]!.score).toBe(1);
    expect(hits[1]!.id).toBe("p3");
  });
});

describe("Int8 Vector Quantizer (int8 vector quantization)", () => {
  it("compresses float vectors to int8 with 4x memory savings", () => {
    const originalFloat = [0.12, -0.45, 0.89, -0.99, 0.33, 0.0];

    const quantized = Int8VectorQuantizer.quantize(originalFloat);
    expect(quantized.data.byteLength).toBe(originalFloat.length); // 6 bytes instead of 24 bytes (4x less)
    expect(quantized.data[0]).toBeTypeOf("number");

    const dequantized = Int8VectorQuantizer.dequantize(quantized);
    expect(dequantized.length).toBe(originalFloat.length);
  });
});

describe("Device Tracking Manager (Device tracking per API key)", () => {
  it("tracks active devices and flags sharing anomalies", () => {
    const tracker = new DeviceTrackingManager();
    const apiKey = "sk_prod_live_789";

    // 1st device
    const r1 = tracker.recordAccess(apiKey, {
      ip: "1.1.1.1",
      userAgent: "Mozilla/5.0 Mac",
      platform: "macOS",
    });
    expect(r1.totalDevicesForKey).toBe(1);
    expect(r1.isAnomalous).toBe(false);

    // Add 5 more distinct devices to exceed threshold
    for (let i = 2; i <= 7; i++) {
      tracker.recordAccess(apiKey, {
        ip: `${i}.${i}.${i}.${i}`,
        userAgent: `Browser ${i}`,
        platform: "Linux",
      });
    }

    const devices = tracker.listDevices(apiKey);
    expect(devices.length).toBe(7);

    const check = tracker.recordAccess(apiKey, {
      ip: "9.9.9.9",
      userAgent: "Browser 9",
    });
    expect(check.isAnomalous).toBe(true);
  });
});
