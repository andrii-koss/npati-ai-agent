import { describe, expect, it } from "vitest";
import {
  PerRequestNoMemoryGate,
  RtkCompressionAdapter,
} from "../apps/agent-api/src/ephemeral-no-memory-and-rtk";

describe("Per-Request No-Memory Gate (Per-request no-memory)", () => {
  it("enforces zero-retention mode when header or payload flag is set", () => {
    // Normal request
    const normal = PerRequestNoMemoryGate.evaluate({}, { noMemory: false });
    expect(normal.noMemoryActive).toBe(false);
    expect(normal.readAllowed).toBe(true);
    expect(normal.writeAllowed).toBe(true);

    // Payload flag set
    const payloadActive = PerRequestNoMemoryGate.evaluate({}, { noMemory: true });
    expect(payloadActive.noMemoryActive).toBe(true);
    expect(payloadActive.readAllowed).toBe(false);
    expect(payloadActive.writeAllowed).toBe(false);

    // Header flag set
    const headerActive = PerRequestNoMemoryGate.evaluate({
      "x-npati-no-memory": "true",
    });
    expect(headerActive.noMemoryActive).toBe(true);

    // Strips memory injections
    const memories = ["User lives in Kyiv", "Prefers TypeScript"];
    const filtered = PerRequestNoMemoryGate.filterInjections(memories, true);
    expect(filtered).toEqual([]);

    expect(PerRequestNoMemoryGate.canPersist(true)).toBe(false);
    expect(PerRequestNoMemoryGate.canPersist(false)).toBe(true);
  });
});

describe("RTK Compression Adapter (RTK)", () => {
  it("builds and validates OmniRoute native RTK compression headers", () => {
    const headers = RtkCompressionAdapter.buildRtkHeaders({
      enabled: true,
      targetRatio: 0.65,
    });

    expect(headers["x-omniroute-compression"]).toBe("rtk");
    expect(headers["x-omniroute-rtk-ratio"]).toBe("0.65");
    expect(headers["x-omniroute-rtk-mode"]).toBe("adaptive-realtime");

    const isValid = RtkCompressionAdapter.validateRtkHeaders(headers);
    expect(isValid).toBe(true);
  });
});
