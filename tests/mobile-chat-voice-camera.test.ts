import { describe, expect, it } from "vitest";
import {
  MobileChatSyncGateway,
  MobileVoiceAudioAdapter,
  CameraAccessController,
} from "../apps/agent-api/src/mobile-chat-voice-camera";

describe("Mobile Chat Sync Gateway (Mobile chat)", () => {
  it("enqueues offline messages and synchronizes them with confirmation tokens", () => {
    const gateway = new MobileChatSyncGateway();
    const deviceId = "iphone-16-pro";

    gateway.enqueueOfflineMessage(deviceId, {
      tempId: "tmp_1",
      text: "Show current token usage.",
      sentAt: new Date().toISOString(),
    });

    gateway.enqueueOfflineMessage(deviceId, {
      tempId: "tmp_2",
      text: "Start background research.",
      sentAt: new Date().toISOString(),
    });

    expect(gateway.getPendingCount(deviceId)).toBe(2);

    const syncRes = gateway.sync(deviceId);
    expect(syncRes.syncedCount).toBe(2);
    expect(syncRes.confirmedMessages[0]!.status).toBe("synced");
    expect(syncRes.confirmedMessages[0]!.serverId).toBeDefined();
    expect(gateway.getPendingCount(deviceId)).toBe(0);
  });
});

describe("Mobile Voice Audio Adapter (Mobile voice)", () => {
  it("manages push-to-talk session and buffers audio frames", () => {
    const adapter = new MobileVoiceAudioAdapter();
    const deviceId = "pixel-9-pro";

    const session = adapter.startSession(deviceId, {
      codec: "opus",
      sampleRate: 24000,
      channels: 1,
    });

    expect(session.active).toBe(true);
    expect(session.codec).toBe("opus");

    const feed1 = adapter.feedFrame(deviceId, "b3B1c19hdWRpb19mcmFtZV8x");
    expect(feed1.success).toBe(true);
    expect(feed1.totalFrames).toBe(1);

    const stopped = adapter.stopSession(deviceId);
    expect(stopped?.active).toBe(false);
  });
});

describe("Camera Access Controller (Camera access)", () => {
  it("captures snapshot from device camera and strips EXIF privacy metadata", () => {
    const controller = new CameraAccessController();
    const deviceId = "ipad-pro-m4";

    const snapshot = controller.submitSnapshot(
      deviceId,
      "environment",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    );

    expect(snapshot.deviceId).toBe("ipad-pro-m4");
    expect(snapshot.facingMode).toBe("environment");
    expect(snapshot.exifStripped).toBe(true);
    expect(snapshot.sanitizedPhotoUrl).toContain(".jpg");

    const fetched = controller.getSnapshot(snapshot.snapshotId);
    expect(fetched?.snapshotId).toBe(snapshot.snapshotId);
  });
});
