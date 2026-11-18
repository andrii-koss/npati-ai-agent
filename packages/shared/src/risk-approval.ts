import crypto from "node:crypto";
// Read Node-only members when the server invokes them. The chat imports the shared
// catalogue in Vite too; eager property reads crash its browser module loader.
const createHash = (...args: Parameters<typeof crypto.createHash>) => crypto.createHash(...args);
const createHmac = (...args: Parameters<typeof crypto.createHmac>) => crypto.createHmac(...args);
const randomUUID = (...args: Parameters<typeof crypto.randomUUID>) => crypto.randomUUID(...args);
const randomBytes = (size: number): Buffer => crypto.randomBytes(size);

import type { CapabilityRisk } from "./capabilities";

export type RiskLevel = CapabilityRisk; // "low" | "moderate" | "high" | "critical"

export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  companyId: string;
  userId: string;
  runId: string;
  agentId: string;
  toolName: string;
  riskLevel: RiskLevel;
  inputPayload: Record<string, unknown>;
  payloadHash: string;
  createdAt: string;
  expiresAt: string;
  token: string;
}

export interface TokenVerificationResult {
  valid: boolean;
  reason?: string;
  reasonCode?: "expired" | "payload_mismatch" | "cross_user" | "already_consumed" | "invalid_signature" | "context_mismatch";
}

// No built-in key: the source is public. Without an explicit secret, one random key is made on first use and
// shared by every service in this process (created lazily, so the browser bundle never calls Node crypto).
let processSecret: string | undefined;
const defaultSecret = () => (processSecret ??= randomBytes(32).toString("hex"));
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class RiskApprovalService {
  private readonly explicitSecret?: string;
  private readonly consumedTokens = new Set<string>();

  constructor(secret?: string) {
    this.explicitSecret = secret;
  }

  private get secret(): string {
    return this.explicitSecret ?? defaultSecret();
  }

  classifyRisk(toolName: string): RiskLevel {
    const raw = toolName.trim().toLowerCase();
    const key = raw.replace(/[ _-]+/g, ".");

    // Critical destructive / host / bulk operations
    if (
      /delete|destroy|purge|truncate|rmdir|unlink|drop|shell|bash|exec|terminal|system\.eval/i.test(key) ||
      /email\.bulk|broadcast|publish\.live|payment|billing|credentials/i.test(key)
    ) {
      return "critical";
    }

    // High risk write / send / update operations
    if (
      /send|write|create|update|modify|patch|post|upload|publish|dispatch|trigger/i.test(key) ||
      /files\.write|files\.upload|db\.mutate/i.test(key) ||
      /browser\..*(?:clicktype|downloads|resume)/i.test(key)
    ) {
      return "high";
    }

    // Medium crawl / external multi-fetch
    if (/crawl|spider|scrape|network/i.test(key)) {
      return "medium";
    }

    // Low risk read / research / inspect
    return "low";
  }

  requiresApproval(toolName: string, riskOverride?: RiskLevel): boolean {
    const level = riskOverride ?? this.classifyRisk(toolName);
    return level === "high" || level === "critical";
  }

  computePayloadHash(payload: unknown): string {
    const canonical = this.canonicalize(payload);
    return createHash("sha256").update(canonical).digest("hex");
  }

  private canonicalize(val: unknown): string {
    if (val === null || typeof val !== "object") {
      return JSON.stringify(val);
    }
    if (Array.isArray(val)) {
      return `[${val.map((item) => this.canonicalize(item)).join(",")}]`;
    }
    const record = val as Record<string, unknown>;
    // Exclude internal _approvalToken from payload hash
    const keys = Object.keys(record)
      .filter((k) => k !== "_approvalToken")
      .sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${this.canonicalize(record[k])}`);
    return `{${entries.join(",")}}`;
  }

  createApprovalRequest(
    auth: { workspaceId: string; userId: string },
    companyId: string,
    runId: string,
    agentId: string,
    toolName: string,
    inputPayload: Record<string, unknown>,
    ttlMs = DEFAULT_TTL_MS
  ): ApprovalRequest {
    const id = randomUUID();
    const riskLevel = this.classifyRisk(toolName);
    const payloadHash = this.computePayloadHash(inputPayload);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();

    const signaturePayload = `${id}:${auth.workspaceId}:${companyId}:${auth.userId}:${runId}:${agentId}:${toolName}:${payloadHash}:${expiresAt}`;
    const signature = createHmac("sha256", this.secret).update(signaturePayload).digest("hex");

    const token = Buffer.from(
      JSON.stringify({
        id,
        ws: auth.workspaceId,
        cmp: companyId,
        u: auth.userId,
        r: runId,
        ag: agentId,
        t: toolName,
        h: payloadHash,
        exp: expiresAt,
        sig: signature,
      })
    ).toString("base64url");

    return {
      id,
      workspaceId: auth.workspaceId,
      companyId,
      userId: auth.userId,
      runId,
      agentId,
      toolName,
      riskLevel,
      inputPayload,
      payloadHash,
      createdAt,
      expiresAt,
      token,
    };
  }

  verifyApprovalToken(
    tokenString: string,
    auth: { workspaceId: string; userId: string },
    companyId: string,
    runId: string,
    toolName: string,
    currentPayload: Record<string, unknown>
  ): TokenVerificationResult {
    let parsed: {
      id: string;
      ws: string;
      cmp: string;
      u: string;
      r: string;
      ag: string;
      t: string;
      h: string;
      exp: string;
      sig: string;
    };

    try {
      const decoded = Buffer.from(tokenString, "base64url").toString("utf-8");
      parsed = JSON.parse(decoded);
    } catch {
      return { valid: false, reason: "Invalid approval token format", reasonCode: "invalid_signature" };
    }

    // 1. Signature Verification
    const expectedSigPayload = `${parsed.id}:${parsed.ws}:${parsed.cmp}:${parsed.u}:${parsed.r}:${parsed.ag}:${parsed.t}:${parsed.h}:${parsed.exp}`;
    const expectedSig = createHmac("sha256", this.secret).update(expectedSigPayload).digest("hex");
    if (parsed.sig !== expectedSig) {
      return { valid: false, reason: "Approval token signature verification failed", reasonCode: "invalid_signature" };
    }

    // 2. Replay / Idempotency Check
    if (this.consumedTokens.has(tokenString)) {
      return { valid: false, reason: "Approval token has already been consumed", reasonCode: "already_consumed" };
    }

    // 3. Expiry / TTL Check
    const expiryTime = new Date(parsed.exp).getTime();
    if (Date.now() > expiryTime) {
      return { valid: false, reason: "Approval token has expired", reasonCode: "expired" };
    }

    // 4. Cross-User Check
    if (parsed.u !== auth.userId || parsed.ws !== auth.workspaceId) {
      return { valid: false, reason: "Approval token belongs to a different user or workspace", reasonCode: "cross_user" };
    }

    // 5. Context / Company / Run Mismatch Check
    if (parsed.cmp !== companyId || parsed.r !== runId) {
      return { valid: false, reason: "Approval token company or run context mismatch", reasonCode: "context_mismatch" };
    }

    // 6. Tool Name Check
    if (parsed.t !== toolName) {
      return { valid: false, reason: `Approval token tool mismatch (token: ${parsed.t}, request: ${toolName})`, reasonCode: "context_mismatch" };
    }

    // 7. Tampering Protection: Payload Hash Check
    const currentHash = this.computePayloadHash(currentPayload);
    if (parsed.h !== currentHash) {
      return {
        valid: false,
        reason: "Input payload has been modified since human approval was granted (tampering detected)",
        reasonCode: "payload_mismatch",
      };
    }

    return { valid: true };
  }

  consumeToken(tokenString: string): boolean {
    if (this.consumedTokens.has(tokenString)) {
      return false;
    }
    this.consumedTokens.add(tokenString);
    return true;
  }
}

export const defaultRiskApprovalService = new RiskApprovalService();
