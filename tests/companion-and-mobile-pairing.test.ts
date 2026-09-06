import { describe, expect, it } from "vitest";
import {
  MacOsCompanionAdapter,
  IosNodePairingManager,
  AndroidNodePairingManager,
} from "../apps/agent-api/src/companion-and-mobile-pairing";

describe("macOS Companion Adapter (macOS companion)", () => {
  it("registers desktop companion app and delivers system notifications", () => {
    const adapter = new MacOsCompanionAdapter();

    const state = adapter.register({
      instanceId: "macbook_pro_m3",
      version: "2.5.0",
      hotkeys: ["Cmd+Shift+Space"],
      clipboardSyncEnabled: true,
    });

    expect(state.status).toBe("active");
    expect(state.platform).toBe("macos");
    expect(state.hotkeysRegistered).toContain("Cmd+Shift+Space");

    const notify = adapter.sendNotification(
      "macbook_pro_m3",
      "Agent Completed",
      "Benchmark test finished."
    );
    expect(notify.delivered).toBe(true);
  });
});

describe("iOS Node Pairing Manager (iOS node pairing)", () => {
  it("generates challenge QR and validates Secure Enclave handshake", () => {
    const manager = new IosNodePairingManager();

    const challenge = manager.createPairingChallenge("iphone_16_pro");
    expect(challenge.qrPayload).toContain("platform=ios");
    expect(challenge.deviceId).toBe("iphone_16_pro");

    const pairResult = manager.verifyAndPair(
      challenge.pairingSessionId,
      "sec_enclave_sig_9876543210abcdef",
      "apns_push_token_sample"
    );

    expect(pairResult.success).toBe(true);
    expect(pairResult.node?.platform).toBe("ios");
    expect(pairResult.node?.attestationVerified).toBe(true);
    expect(manager.listNodes().length).toBe(1);
  });
});

describe("Android Node Pairing Manager (Android node pairing)", () => {
  it("creates pairing challenge and pairs Android device with Keystore attestation", () => {
    const manager = new AndroidNodePairingManager();

    const challenge = manager.createPairingChallenge("pixel_9_pro");
    expect(challenge.qrPayload).toContain("platform=android");

    const pairResult = manager.verifyAndPair(
      challenge.pairingSessionId,
      "android_keystore_attest_token_xyz123",
      "fcm_token_sample"
    );

    expect(pairResult.success).toBe(true);
    expect(pairResult.node?.platform).toBe("android");
    expect(pairResult.node?.status).toBe("connected");
    expect(manager.listNodes().length).toBe(1);
  });
});
