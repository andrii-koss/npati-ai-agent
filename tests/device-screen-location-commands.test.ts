import { describe, expect, it } from "vitest";
import {
  ScreenRecordingController,
  LocationAccessManager,
  DeviceCommandDispatcher,
} from "../apps/agent-api/src/device-screen-location-commands";

describe("Screen Recording Controller (Screen recording)", () => {
  it("manages screen recording sessions and completes with video artifact", () => {
    const controller = new ScreenRecordingController();
    const deviceId = "macbook_pro_node";

    const session = controller.startRecording(deviceId, { fps: 60, maxDurationSeconds: 120 });
    expect(session.status).toBe("recording");
    expect(session.fps).toBe(60);

    const completed = controller.stopRecording(
      session.recordingId,
      "https://cdn.npati.io/artifacts/screen/rec_demo_1.mp4"
    );

    expect(completed.status).toBe("completed");
    expect(completed.videoArtifactUrl).toContain(".mp4");
  });
});

describe("Location Access Manager (Location access)", () => {
  it("provides device location and applies privacy coordinate fuzzing", () => {
    const manager = new LocationAccessManager();

    // High accuracy -> precise coordinates
    const precise = manager.getLocation("pixel_9", { highAccuracy: true });
    expect(precise.fuzzed).toBe(false);
    expect(precise.accuracyMeters).toBe(15);
    expect(precise.city).toBe("Kyiv");

    // Standard / fuzzed -> rounded coordinates for privacy
    const fuzzed = manager.getLocation("pixel_9", { fuzzCoordinates: true });
    expect(fuzzed.fuzzed).toBe(true);
    expect(fuzzed.accuracyMeters).toBe(1500);
    expect(fuzzed.latitude.toString().split(".")[1]?.length).toBeLessThanOrEqual(2);
  });
});

describe("Device Command Dispatcher (Device commands)", () => {
  it("dispatches native hardware actions to connected devices", () => {
    const dispatcher = new DeviceCommandDispatcher();
    const deviceId = "iphone_16";

    // 1. Battery status
    const battery = dispatcher.dispatch(deviceId, "get_battery");
    expect(battery.success).toBe(true);
    expect(battery.payload.levelPercent).toBe(88);

    // 2. Volume control
    const volume = dispatcher.dispatch(deviceId, "set_volume", { level: 50 });
    expect(volume.success).toBe(true);
    expect(volume.payload.volumeLevel).toBe(50);

    // 3. Open app
    const app = dispatcher.dispatch(deviceId, "open_app", { bundleId: "com.apple.shortcuts" });
    expect(app.success).toBe(true);
    expect(app.payload.launched).toBe(true);
  });
});
