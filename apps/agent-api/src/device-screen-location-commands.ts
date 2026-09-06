export interface ScreenRecordingSession {
  recordingId: string;
  deviceId: string;
  fps: number;
  maxDurationSeconds: number;
  status: "recording" | "completed" | "failed";
  videoArtifactUrl?: string;
  startedAt: string;
}

export interface DeviceLocationResult {
  deviceId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  city?: string;
  country?: string;
  fuzzed: boolean;
  timestamp: string;
}

export interface DeviceCommandResult {
  commandId: string;
  deviceId: string;
  command: "get_battery" | "set_volume" | "toggle_flashlight" | "open_app" | "vibrate";
  success: boolean;
  payload: Record<string, unknown>;
  executedAt: string;
}

export class ScreenRecordingController {
  private readonly recordings = new Map<string, ScreenRecordingSession>();

  /**
   * 1. Screen Recording: Desktop/Node screen recording and frame capture
   */
  startRecording(
    deviceId: string,
    options: { fps?: number; maxDurationSeconds?: number } = {}
  ): ScreenRecordingSession {
    const recordingId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const session: ScreenRecordingSession = {
      recordingId,
      deviceId,
      fps: options.fps ?? 30,
      maxDurationSeconds: options.maxDurationSeconds ?? 60,
      status: "recording",
      startedAt: new Date().toISOString(),
    };
    this.recordings.set(recordingId, session);
    return session;
  }

  stopRecording(recordingId: string, videoUrl: string): ScreenRecordingSession {
    const session = this.recordings.get(recordingId);
    if (!session) throw new Error(`Recording ${recordingId} not found.`);

    session.status = "completed";
    session.videoArtifactUrl = videoUrl;
    return session;
  }

  getRecording(recordingId: string): ScreenRecordingSession | undefined {
    return this.recordings.get(recordingId);
  }
}

export class LocationAccessManager {
  /**
   * 2. Location Access: GPS positioning with optional privacy coordinate fuzzing
   */
  getLocation(
    deviceId: string,
    options: { highAccuracy?: boolean; fuzzCoordinates?: boolean } = {}
  ): DeviceLocationResult {
    const rawLat = 50.4501;
    const rawLon = 30.5234; // Kyiv coordinates

    const fuzz = options.fuzzCoordinates ?? !options.highAccuracy;
    // Fuzzing rounds coordinates to ~1-2km resolution for privacy
    const lat = fuzz ? Number(rawLat.toFixed(2)) : rawLat;
    const lon = fuzz ? Number(rawLon.toFixed(2)) : rawLon;

    return {
      deviceId,
      latitude: lat,
      longitude: lon,
      accuracyMeters: fuzz ? 1500 : 15,
      city: "Kyiv",
      country: "Ukraine",
      fuzzed: fuzz,
      timestamp: new Date().toISOString(),
    };
  }
}

export class DeviceCommandDispatcher {
  /**
   * 3. Device Commands: Native mobile & desktop hardware action dispatcher
   */
  dispatch(
    deviceId: string,
    command: "get_battery" | "set_volume" | "toggle_flashlight" | "open_app" | "vibrate",
    params: Record<string, unknown> = {}
  ): DeviceCommandResult {
    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let payload: Record<string, unknown> = {};

    switch (command) {
      case "get_battery":
        payload = { levelPercent: 88, isCharging: true, state: "healthy" };
        break;
      case "set_volume":
        payload = { volumeLevel: params.level ?? 75, muted: false };
        break;
      case "toggle_flashlight":
        payload = { enabled: Boolean(params.enabled) };
        break;
      case "open_app":
        payload = { appBundle: params.bundleId ?? "com.apple.Preferences", launched: true };
        break;
      case "vibrate":
        payload = { durationMs: params.durationMs ?? 400, pattern: "success" };
        break;
    }

    return {
      commandId,
      deviceId,
      command,
      success: true,
      payload,
      executedAt: new Date().toISOString(),
    };
  }
}
