import { describe, expect, it } from "vitest";
import { CryptoVault, type AuthContext } from "@npati/workspace";
import { MessagingIntegrationsRepository, PAIRING_MAX_FAILED_ATTEMPTS } from "../apps/agent-api/src/messaging-integrations-repository";
import { telegramPairingLink } from "../apps/agent-api/src/messaging-integrations-routes";

/**
 * Security audit 2026-11-24, L8: the 6-digit pairing code could be guessed without limit for 15 minutes. Pairing now
 * prefers a deep link with a 128-bit token; the 6-digit code stays as a fallback that 5 wrong guesses void.
 */
const owner: AuthContext = { userId: "owner", workspaceId: "workspace:owner", externalSubject: "s", permissions: ["business:manage"] };
const vault = new CryptoVault("test-master-key-that-is-at-least-thirty-two-characters");
const peer = { externalUserId: "tg-user", externalChatId: "tg-chat" };
async function pending() {
  const repo = new MessagingIntegrationsRepository(undefined, undefined, vault);
  const created = await repo.createTelegram(owner, "company-a", { displayName: "Bot", botToken: "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH" });
  const item = (await repo.getOwned(owner, created.connection.id))!;
  return { repo, created, item };
}

describe("L8: messaging pairing", () => {
  it("issues an unguessable deep-link token alongside the 6-digit code, and the link pairs", async () => {
    const { repo, created, item } = await pending();
    expect(created.pairingLinkToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(created.connection)).not.toContain("pairingLinkHash");
    expect(await repo.bind(item, { ...peer, pairingLinkToken: created.pairingLinkToken })).toBe(true);
    expect((await repo.getOwned(owner, item.id))?.status).toBe("connected");
  });

  it(`voids the 6-digit code after ${PAIRING_MAX_FAILED_ATTEMPTS} wrong guesses, even if the right one follows`, async () => {
    const { repo, created, item } = await pending();
    const wrong = created.pairingCode === "000000" ? "000001" : "000000";
    for (let i = 0; i < PAIRING_MAX_FAILED_ATTEMPTS; i += 1) expect(await repo.bind(item, { ...peer, pairingCode: wrong })).toBe(false);
    expect(await repo.bind(item, { ...peer, pairingCode: created.pairingCode })).toBe(false);
  });

  it("wrong guesses cannot burn the deep link: the owner can still pair", async () => {
    const { repo, created, item } = await pending();
    for (let i = 0; i < PAIRING_MAX_FAILED_ATTEMPTS + 3; i += 1) await repo.bind(item, { ...peer, pairingCode: "123123" });
    expect(await repo.bind(item, { ...peer, pairingLinkToken: "A".repeat(22) })).toBe(false);
    expect(await repo.bind(item, { ...peer, pairingLinkToken: created.pairingLinkToken })).toBe(true);
  });

  it("a re-issued pairing resets the counter and replaces both secrets", async () => {
    const { repo, created, item } = await pending();
    for (let i = 0; i < PAIRING_MAX_FAILED_ATTEMPTS; i += 1) await repo.bind(item, { ...peer, pairingCode: "999999" });
    const again = await repo.issuePairing(item, true);
    expect(again.pairingLinkToken).not.toBe(created.pairingLinkToken);
    expect(await repo.bind(item, { ...peer, pairingLinkToken: created.pairingLinkToken })).toBe(false);
    expect(await repo.bind(item, { ...peer, pairingCode: again.pairingCode })).toBe(true);
  });

  it("builds the t.me link only for a valid bot username", () => {
    expect(telegramPairingLink("@npati_test_bot", "tok_ABCDEFGHIJKLMNOPQR")).toBe("https://t.me/npati_test_bot?start=tok_ABCDEFGHIJKLMNOPQR");
    expect(telegramPairingLink("Display Name", "x".repeat(22))).toBeUndefined();
    expect(telegramPairingLink(undefined, "x".repeat(22))).toBeUndefined();
  });
});
