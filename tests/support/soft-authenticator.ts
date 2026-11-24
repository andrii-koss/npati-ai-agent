import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";

/**
 * A software WebAuthn authenticator for tests: P-256 key, "none" attestation, user presence + verification flags.
 * It produces the same JSON a browser returns from navigator.credentials.create/get.
 */
const b64url = (data: Uint8Array | Buffer) => Buffer.from(data).toString("base64url");

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  private counter = 0;

  constructor(private readonly origin: string, private readonly rpID = new URL(origin).hostname) {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.x = Buffer.from(jwk.x, "base64url");
    this.y = Buffer.from(jwk.y, "base64url");
  }

  get id(): string { return b64url(this.credentialId); }

  private authData(attested: boolean, flags = 0x01 | 0x04): Buffer {
    const rpIdHash = createHash("sha256").update(this.rpID).digest();
    const count = Buffer.alloc(4); count.writeUInt32BE(++this.counter);
    if (!attested) return Buffer.concat([rpIdHash, Buffer.from([flags]), count]);
    const cose = encodeCBOR(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(this.x)], [-3, new Uint8Array(this.y)]]) as never);
    const length = Buffer.alloc(2); length.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([rpIdHash, Buffer.from([flags | 0x40]), count, Buffer.alloc(16), length, this.credentialId, Buffer.from(cose)]);
  }

  private clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** What navigator.credentials.create() returns, as RegistrationResponseJSON. */
  register(options: { challenge: string }, origin?: string) {
    const attestationObject = encodeCBOR(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(this.authData(true))]]) as never);
    return {
      id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge, origin)), attestationObject: b64url(attestationObject), transports: ["internal"] },
    };
  }

  /** What navigator.credentials.get() returns, as AuthenticationResponseJSON. `userVerified: false` drops the UV flag. */
  assert(options: { challenge: string }, extra: { origin?: string; userVerified?: boolean } = {}) {
    const authenticatorData = this.authData(false, extra.userVerified === false ? 0x01 : 0x01 | 0x04);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, extra.origin);
    const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), this.privateKey);
    return {
      id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authenticatorData), signature: b64url(signature) },
    };
  }
}
