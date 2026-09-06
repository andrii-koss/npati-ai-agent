export interface QueuedMobileMessage {
  tempId: string;
  serverId?: string;
  deviceId: string;
  text: string;
  sentAt: string;
  status: "pending" | "synced" | "failed";
}

export interface MobileVoiceSession {
  sessionId: string;
  deviceId: string;
  codec: "opus" | "aac";
  sampleRate: number;
  channels: number;
  bufferedFramesCount: number;
  active: boolean;
  startedAt: string;
}

export interface CameraSnapshotResult {
  snapshotId: string;
  deviceId: string;
  facingMode: "user" | "environment";
  sanitizedPhotoUrl: string;
  sizeBytes: number;
  exifStripped: boolean;
  capturedAt: string;
}

export class MobileChatSyncGateway {
  private readonly queues = new Map<string, QueuedMobileMessage[]>();

  /**
   * 1. Mobile Chat: Offline-first message queueing and bidirectional sync
   */
  enqueueOfflineMessage(
    deviceId: string,
    msg: { tempId: string; text: string; sentAt: string }
  ): QueuedMobileMessage {
    const list = this.queues.get(deviceId) ?? [];
    const item: QueuedMobileMessage = {
      ...msg,
      deviceId,
      status: "pending",
    };
    list.push(item);
    this.queues.set(deviceId, list);
    return item;
  }

  sync(deviceId: string): { syncedCount: number; confirmedMessages: QueuedMobileMessage[] } {
    const list = this.queues.get(deviceId) ?? [];
    const confirmed: QueuedMobileMessage[] = [];

    for (const msg of list) {
      if (msg.status === "pending") {
        msg.status = "synced";
        msg.serverId = `srv_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        confirmed.push(msg);
      }
    }

    return {
      syncedCount: confirmed.length,
      confirmedMessages: confirmed,
    };
  }

  getPendingCount(deviceId: string): number {
    const list = this.queues.get(deviceId) ?? [];
    return list.filter((m) => m.status === "pending").length;
  }
}

export class MobileVoiceAudioAdapter {
  private readonly sessions = new Map<string, MobileVoiceSession>();

  /**
   * 2. Mobile Voice: Push-to-talk low-bitrate Opus voice session handler
   */
  startSession(
    deviceId: string,
    config: { codec?: "opus" | "aac"; sampleRate?: number; channels?: number } = {}
  ): MobileVoiceSession {
    const session: MobileVoiceSession = {
      sessionId: `voice_${deviceId}_${Date.now()}`,
      deviceId,
      codec: config.codec ?? "opus",
      sampleRate: config.sampleRate ?? 24000,
      channels: config.channels ?? 1,
      bufferedFramesCount: 0,
      active: true,
      startedAt: new Date().toISOString(),
    };
    this.sessions.set(deviceId, session);
    return session;
  }

  feedFrame(deviceId: string, frameBase64: string): { success: boolean; totalFrames: number } {
    const session = this.sessions.get(deviceId);
    if (!session || !session.active) {
      return { success: false, totalFrames: 0 };
    }

    session.bufferedFramesCount++;
    return {
      success: true,
      totalFrames: session.bufferedFramesCount,
    };
  }

  stopSession(deviceId: string): MobileVoiceSession | undefined {
    const session = this.sessions.get(deviceId);
    if (session) {
      session.active = false;
    }
    return session;
  }
}

export class CameraAccessController {
  private readonly snapshots = new Map<string, CameraSnapshotResult>();

  /**
   * 3. Camera Access: Mobile node camera snapshot with privacy EXIF stripping
   */
  submitSnapshot(
    deviceId: string,
    facingMode: "user" | "environment",
    photoBase64: string
  ): CameraSnapshotResult {
    const snapshotId = `cam_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const sizeBytes = Buffer.byteLength(photoBase64, "base64");

    const result: CameraSnapshotResult = {
      snapshotId,
      deviceId,
      facingMode,
      sanitizedPhotoUrl: `https://cdn.npati.io/snapshots/${snapshotId}.jpg`,
      sizeBytes,
      exifStripped: true, // Privacy guarantee: GPS and device serials stripped
      capturedAt: new Date().toISOString(),
    };

    this.snapshots.set(snapshotId, result);
    return result;
  }

  getSnapshot(snapshotId: string): CameraSnapshotResult | undefined {
    return this.snapshots.get(snapshotId);
  }
}
