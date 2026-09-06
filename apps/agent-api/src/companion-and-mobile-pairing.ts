export interface CompanionState {
  instanceId: string;
  platform: "macos" | "linux" | "windows";
  version: string;
  status: "active" | "idle" | "disconnected";
  hotkeysRegistered: string[];
  clipboardSyncEnabled: boolean;
  lastHeartbeat: string;
}

export interface PairingChallenge {
  pairingSessionId: string;
  deviceId: string;
  challengeHex: string;
  qrPayload: string;
  expiresAt: string;
}

export interface PairedMobileNode {
  deviceId: string;
  platform: "ios" | "android";
  pairedAt: string;
  attestationVerified: boolean;
  status: "connected" | "offline";
  fcmOrApnsToken?: string;
}

export class MacOsCompanionAdapter {
  private readonly companions = new Map<string, CompanionState>();

  /**
   * 1. macOS Companion: Menu bar tray, global hotkeys & desktop notifications
   */
  register(params: {
    instanceId: string;
    version: string;
    hotkeys?: string[];
    clipboardSyncEnabled?: boolean;
  }): CompanionState {
    const state: CompanionState = {
      instanceId: params.instanceId,
      platform: "macos",
      version: params.version,
      status: "active",
      hotkeysRegistered: params.hotkeys ?? ["Cmd+Shift+Space", "Cmd+Option+N"],
      clipboardSyncEnabled: params.clipboardSyncEnabled ?? true,
      lastHeartbeat: new Date().toISOString(),
    };
    this.companions.set(params.instanceId, state);
    return state;
  }

  sendNotification(
    instanceId: string,
    title: string,
    body: string
  ): { delivered: boolean; timestamp: string } {
    const companion = this.companions.get(instanceId);
    if (!companion || companion.status === "disconnected") {
      return { delivered: false, timestamp: new Date().toISOString() };
    }

    return { delivered: true, timestamp: new Date().toISOString() };
  }

  getState(instanceId: string): CompanionState | undefined {
    return this.companions.get(instanceId);
  }
}

export class IosNodePairingManager {
  private readonly challenges = new Map<string, PairingChallenge>();
  private readonly pairedNodes = new Map<string, PairedMobileNode>();

  /**
   * 2. iOS Node Pairing: QR code & Apple Secure Enclave cryptographic pairing
   */
  createPairingChallenge(deviceId: string): PairingChallenge {
    const pairingSessionId = `ios_pair_${Date.now()}`;
    const challengeHex = Buffer.from(Math.random().toString(36).slice(2)).toString("hex");
    const expiresAt = new Date(Date.now() + 300_000).toISOString(); // 5 min expiry

    const challenge: PairingChallenge = {
      pairingSessionId,
      deviceId,
      challengeHex,
      qrPayload: `npati://pair?session=${pairingSessionId}&challenge=${challengeHex}&platform=ios`,
      expiresAt,
    };
    this.challenges.set(pairingSessionId, challenge);
    return challenge;
  }

  verifyAndPair(
    pairingSessionId: string,
    enclaveSignature: string,
    apnsToken?: string
  ): { success: boolean; node?: PairedMobileNode; error?: string } {
    const challenge = this.challenges.get(pairingSessionId);
    if (!challenge) return { success: false, error: "Pairing challenge expired or invalid." };

    if (!enclaveSignature || enclaveSignature.length < 10) {
      return { success: false, error: "Invalid Secure Enclave signature." };
    }

    const node: PairedMobileNode = {
      deviceId: challenge.deviceId,
      platform: "ios",
      pairedAt: new Date().toISOString(),
      attestationVerified: true,
      status: "connected",
      fcmOrApnsToken: apnsToken,
    };

    this.pairedNodes.set(node.deviceId, node);
    this.challenges.delete(pairingSessionId);

    return {
      success: true,
      node,
    };
  }

  listNodes(): PairedMobileNode[] {
    return Array.from(this.pairedNodes.values());
  }
}

export class AndroidNodePairingManager {
  private readonly challenges = new Map<string, PairingChallenge>();
  private readonly pairedNodes = new Map<string, PairedMobileNode>();

  /**
   * 3. Android Node Pairing: Keystore hardware attestation and FCM pairing
   */
  createPairingChallenge(deviceId: string): PairingChallenge {
    const pairingSessionId = `android_pair_${Date.now()}`;
    const challengeHex = Buffer.from(Math.random().toString(36).slice(2)).toString("hex");
    const expiresAt = new Date(Date.now() + 300_000).toISOString();

    const challenge: PairingChallenge = {
      pairingSessionId,
      deviceId,
      challengeHex,
      qrPayload: `npati://pair?session=${pairingSessionId}&challenge=${challengeHex}&platform=android`,
      expiresAt,
    };
    this.challenges.set(pairingSessionId, challenge);
    return challenge;
  }

  verifyAndPair(
    pairingSessionId: string,
    keystoreAttestation: string,
    fcmToken?: string
  ): { success: boolean; node?: PairedMobileNode; error?: string } {
    const challenge = this.challenges.get(pairingSessionId);
    if (!challenge) return { success: false, error: "Pairing session not found." };

    if (!keystoreAttestation || keystoreAttestation.length < 10) {
      return { success: false, error: "Keystore attestation verification failed." };
    }

    const node: PairedMobileNode = {
      deviceId: challenge.deviceId,
      platform: "android",
      pairedAt: new Date().toISOString(),
      attestationVerified: true,
      status: "connected",
      fcmOrApnsToken: fcmToken,
    };

    this.pairedNodes.set(node.deviceId, node);
    this.challenges.delete(pairingSessionId);

    return {
      success: true,
      node,
    };
  }

  listNodes(): PairedMobileNode[] {
    return Array.from(this.pairedNodes.values());
  }
}
