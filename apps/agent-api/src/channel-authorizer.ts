import { createHmac, timingSafeEqual } from "node:crypto";

export interface ChannelAuthRequest {
  channelType: "webhook" | "telegram" | "slack" | "discord" | "direct" | string;
  senderId: string;
  payload: string | Buffer;
  signature?: string;
  secretKey?: string;
  timestampHeader?: string | number;
  maxTimestampDriftSec?: number;
}

export interface ChannelAuthResult {
  authorized: boolean;
  reason?: string;
  senderId?: string;
}

export class ChannelAuthorizer {
  /**
   * Verify HMAC-SHA256 signature with constant-time equality
   */
  static verifyHmacSignature(payload: string | Buffer, secret: string, signature: string): boolean {
    const cleanSignature = signature.replace(/^sha256=/i, "").trim();
    const expected = createHmac("sha256", secret).update(payload).digest("hex");

    const bExpected = Buffer.from(expected, "hex");
    const bSignature = Buffer.from(cleanSignature, "hex");

    if (bExpected.length !== bSignature.length) {
      return false;
    }

    return timingSafeEqual(bExpected, bSignature);
  }

  /**
   * Verify incoming channel message/webhook request
   */
  static authorizeRequest(req: ChannelAuthRequest): ChannelAuthResult {
    // 1. Check Anti-Replay Timestamp if supplied
    if (req.timestampHeader !== undefined) {
      const ts = typeof req.timestampHeader === "string" ? parseInt(req.timestampHeader, 10) : req.timestampHeader;
      if (!isNaN(ts)) {
        const nowSec = Math.floor(Date.now() / 1000);
        const maxDrift = req.maxTimestampDriftSec ?? 300; // 5 minutes
        if (Math.abs(nowSec - ts) > maxDrift) {
          return {
            authorized: false,
            reason: `TIMESTAMP_OUT_OF_BOUNDS: Request timestamp is older or newer than ${maxDrift}s drift tolerance.`,
          };
        }
      }
    }

    // 2. If secretKey and signature are configured, verify HMAC
    if (req.secretKey && req.signature) {
      const isValidSig = this.verifyHmacSignature(req.payload, req.secretKey, req.signature);
      if (!isValidSig) {
        return {
          authorized: false,
          reason: "INVALID_HMAC_SIGNATURE: Payload signature does not match expected HMAC.",
        };
      }
    }

    // 3. If secretKey is required but signature missing
    if (req.secretKey && !req.signature) {
      return {
        authorized: false,
        reason: "MISSING_SIGNATURE: Channel requires HMAC signature verification.",
      };
    }

    // 4. Validate senderId
    if (!req.senderId || req.senderId.trim() === "") {
      return {
        authorized: false,
        reason: "MISSING_SENDER_ID: Message does not contain a valid sender identifier.",
      };
    }

    return {
      authorized: true,
      senderId: req.senderId.trim(),
    };
  }
}
