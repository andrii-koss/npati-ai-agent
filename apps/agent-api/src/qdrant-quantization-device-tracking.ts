export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface QuantizedVector {
  data: Int8Array;
  scale: number;
  zeroPoint: number;
  originalDimension: number;
}

export interface DeviceAccessRecord {
  deviceId: string;
  ip: string;
  userAgent: string;
  platform: string;
  firstSeenAt: string;
  lastSeenAt: string;
  requestsCount: number;
}

export class QdrantVectorClient {
  private readonly collections = new Map<string, QdrantPoint[]>();

  /**
   * 1. Qdrant Support: High-performance vector storage and filtered similarity search
   */
  upsert(collectionName: string, points: QdrantPoint[]): void {
    const list = this.collections.get(collectionName) ?? [];
    for (const p of points) {
      const idx = list.findIndex((item) => item.id === p.id);
      if (idx >= 0) list[idx] = p;
      else list.push(p);
    }
    this.collections.set(collectionName, list);
  }

  search(
    collectionName: string,
    queryVector: number[],
    filter?: Record<string, unknown>,
    limit = 5
  ): QdrantSearchResult[] {
    const list = this.collections.get(collectionName) ?? [];
    const results: QdrantSearchResult[] = [];

    for (const point of list) {
      // Apply payload filter
      if (filter) {
        let match = true;
        for (const [k, v] of Object.entries(filter)) {
          if (point.payload[k] !== v) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }

      // Cosine similarity
      let dot = 0;
      let magA = 0;
      let magB = 0;
      for (let i = 0; i < queryVector.length; i++) {
        const a = queryVector[i] || 0;
        const b = point.vector[i] || 0;
        dot += a * b;
        magA += a * a;
        magB += b * b;
      }
      const score =
        magA > 0 && magB > 0
          ? Number((dot / (Math.sqrt(magA) * Math.sqrt(magB))).toFixed(4))
          : 0;

      results.push({
        id: point.id,
        score,
        payload: point.payload,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

export class Int8VectorQuantizer {
  /**
   * 2. int8 Vector Quantization: Compresses float32 vectors to int8 with scalar scaling
   */
  static quantize(vector: number[]): QuantizedVector {
    let min = Infinity;
    let max = -Infinity;
    for (const val of vector) {
      if (val < min) min = val;
      if (val > max) max = val;
    }

    // Map range [min, max] to [-128, 127]
    const range = max - min || 1;
    const scale = 255 / range;
    const zeroPoint = Math.round(-min * scale - 128);

    const int8Data = new Int8Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
      const q = Math.round((vector[i]! - min) * (255 / range) - 128);
      int8Data[i] = Math.max(-128, Math.min(127, q));
    }

    return {
      data: int8Data,
      scale,
      zeroPoint,
      originalDimension: vector.length,
    };
  }

  static dequantize(quantized: QuantizedVector): number[] {
    const result: number[] = new Array(quantized.data.length);
    for (let i = 0; i < quantized.data.length; i++) {
      result[i] = Number(((quantized.data[i]! + 128) / quantized.scale).toFixed(4));
    }
    return result;
  }
}

export class DeviceTrackingManager {
  private readonly devicesByApiKey = new Map<string, Map<string, DeviceAccessRecord>>();

  /**
   * 3. Device Tracking per API Key: Monitors active devices and flags sharing anomalies
   */
  recordAccess(
    apiKey: string,
    device: { ip: string; userAgent: string; deviceId?: string; platform?: string }
  ): { deviceId: string; totalDevicesForKey: number; isAnomalous: boolean } {
    const deviceId =
      device.deviceId ||
      `${device.ip}_${Buffer.from(device.userAgent).toString("base64").slice(0, 12)}`;

    let deviceMap = this.devicesByApiKey.get(apiKey);
    if (!deviceMap) {
      deviceMap = new Map();
      this.devicesByApiKey.set(apiKey, deviceMap);
    }

    const existing = deviceMap.get(deviceId);
    const now = new Date().toISOString();

    if (existing) {
      existing.requestsCount++;
      existing.lastSeenAt = now;
      existing.ip = device.ip;
    } else {
      deviceMap.set(deviceId, {
        deviceId,
        ip: device.ip,
        userAgent: device.userAgent,
        platform: device.platform ?? "unknown",
        firstSeenAt: now,
        lastSeenAt: now,
        requestsCount: 1,
      });
    }

    const totalDevices = deviceMap.size;
    // Anomaly threshold: more than 5 distinct devices for a single API key
    const isAnomalous = totalDevices > 5;

    return {
      deviceId,
      totalDevicesForKey: totalDevices,
      isAnomalous,
    };
  }

  listDevices(apiKey: string): DeviceAccessRecord[] {
    return Array.from(this.devicesByApiKey.get(apiKey)?.values() ?? []);
  }
}
