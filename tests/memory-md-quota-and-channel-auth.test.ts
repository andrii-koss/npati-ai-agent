import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { MemoryMdManager } from "../apps/agent-api/src/memory-md-manager";
import { ChannelAuthorizer } from "../apps/agent-api/src/channel-authorizer";
import { LiveQuotaTelemetry } from "../apps/agent-api/src/live-quota-telemetry";

describe("MEMORY.md Long-Term Memory (MemoryMdManager)", () => {
  it("synthesizes, parses, and upserts facts in MEMORY.md format", () => {
    const manager = new MemoryMdManager();
    const companyId = "company-101";

    manager.upsertFact(companyId, "context", "B2B SaaS product for AI workflows.");
    manager.upsertFact(companyId, "architecture", "Event-driven microservices on Node.js.");
    manager.upsertFact(companyId, "rules", "Require human approval for financial operations.");

    const markdown = manager.getMemoryMarkdown(companyId);

    expect(markdown).toContain("# Long-Term Memory: Company company-101");
    expect(markdown).toContain("B2B SaaS product for AI workflows.");
    expect(markdown).toContain("Event-driven microservices on Node.js.");
    expect(markdown).toContain("Require human approval for financial operations.");

    // Parse back
    const parsed = MemoryMdManager.parse(companyId, markdown);
    expect(parsed.coreBusinessContext).toContain("B2B SaaS product for AI workflows.");
    expect(parsed.architecturalDecisions).toContain("Event-driven microservices on Node.js.");
    expect(parsed.operationalRules).toContain("Require human approval for financial operations.");
  });
});

describe("Channel Sender Authorization (ChannelAuthorizer)", () => {
  it("authorizes requests with valid HMAC-SHA256 signature and timestamp", () => {
    const payload = JSON.stringify({ event: "order_created", amount: 150 });
    const secret = "whsec_super_secret_test_key_12345";
    const signature = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    const nowSec = Math.floor(Date.now() / 1000);

    const result = ChannelAuthorizer.authorizeRequest({
      channelType: "webhook",
      senderId: "stripe_webhook_service",
      payload,
      signature,
      secretKey: secret,
      timestampHeader: nowSec,
    });

    expect(result.authorized).toBe(true);
    expect(result.senderId).toBe("stripe_webhook_service");
  });

  it("rejects requests with invalid signature or expired timestamp", () => {
    const payload = JSON.stringify({ event: "malicious_spoof" });
    const secret = "whsec_secret";

    // Invalid signature
    const badSig = ChannelAuthorizer.authorizeRequest({
      channelType: "webhook",
      senderId: "attacker",
      payload,
      signature: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      secretKey: secret,
    });
    expect(badSig.authorized).toBe(false);
    expect(badSig.reason).toContain("INVALID_HMAC_SIGNATURE");

    // Old replay timestamp (1 hour old)
    const oldTimestamp = Math.floor(Date.now() / 1000) - 3600;
    const replaySig = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    const replay = ChannelAuthorizer.authorizeRequest({
      channelType: "webhook",
      senderId: "sender",
      payload,
      signature: replaySig,
      secretKey: secret,
      timestampHeader: oldTimestamp,
    });
    expect(replay.authorized).toBe(false);
    expect(replay.reason).toContain("TIMESTAMP_OUT_OF_BOUNDS");
  });
});

describe("Live Quota Telemetry (LiveQuotaTelemetry)", () => {
  it("tracks RPM, TPM, and detects saturation thresholds", () => {
    const telemetry = new LiveQuotaTelemetry();
    telemetry.setLimits("openai:gpt-4o", {
      maxRpm: 10,
      maxTpm: 10_000,
    });

    // Record 5 calls with 1,000 tokens each (50% RPM, 50% TPM)
    for (let i = 0; i < 5; i++) {
      telemetry.recordUsage("openai", "gpt-4o", 1000);
    }

    const snap1 = telemetry.getSnapshot("openai", "gpt-4o");
    expect(snap1.currentRpm).toBe(5);
    expect(snap1.currentTpm).toBe(5000);
    expect(snap1.status).toBe("healthy");
    expect(snap1.recommendFallback).toBe(false);

    // Record 5 more calls to reach 100% saturation
    for (let i = 0; i < 5; i++) {
      telemetry.recordUsage("openai", "gpt-4o", 1000);
    }

    const snap2 = telemetry.getSnapshot("openai", "gpt-4o");
    expect(snap2.currentRpm).toBe(10);
    expect(snap2.rpmSaturationPercent).toBe(100);
    expect(snap2.status).toBe("saturated");
    expect(snap2.recommendFallback).toBe(true);
  });
});
