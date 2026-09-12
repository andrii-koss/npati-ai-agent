import { createHmac } from "node:crypto";

const base = process.env.NPATI_API_URL ?? "http://localhost:3001";
const secret = process.env.OIDC_SHARED_SECRET;
if (!secret) throw new Error("OIDC_SHARED_SECRET is required for this verification.");

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(payload, key = secret, header = { alg: "HS256", typ: "JWT" }) {
  const encodedHeader = encode(header);
  const encodedPayload = encode(payload);
  const signature = createHmac("sha256", key).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}
async function login(idToken) {
  const response = await fetch(`${base}/auth/oidc/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  return { status: response.status, body: await response.json() };
}
function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(detail)}`);
  console.log(`✓ ${message}`);
}

const now = Math.floor(Date.now() / 1000);
const claims = {
  sub: "docker-oidc-user", email: "oidc@example.test", roles: ["admin"], tenantId: "docker-tenant",
  iss: process.env.OIDC_ISSUER ?? "https://auth.npati.ai",
  aud: process.env.OIDC_AUDIENCE ?? "npati-dashboard", iat: now, exp: now + 300,
};
const validToken = token(claims);
const valid = await login(validToken);
assert(valid.status === 200 && Boolean(valid.body?.tokens?.accessToken), "signed OIDC token accepted", valid);

const segments = validToken.split(".");
const forgedPayload = encode({ ...claims, sub: "attacker", roles: ["admin"], exp: now + 3600 });
const forged = await login(`${segments[0]}.${forgedPayload}.${segments[2]}`);
assert(forged.status === 401, "tampered claims rejected", forged);

const wrongIssuer = await login(token({ ...claims, iss: "https://attacker.invalid" }));
assert(wrongIssuer.status === 401, "wrong issuer rejected", wrongIssuer);

const expired = await login(token({ ...claims, exp: now - 1 }));
assert(expired.status === 401, "expired token rejected", expired);

const unsigned = await login(`${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`);
assert(unsigned.status === 401, "alg=none token rejected", unsigned);
console.log("OIDC Docker E2E: 5/5 passed");