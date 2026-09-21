import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForPairingCompletion } from "../apps/web/src/auth-pairing";

describe("hosted NPATI pairing", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps polling while approval is pending and accepts the completed session", async () => {
    vi.useFakeTimers();
    const poll = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const completion = waitForPairingCompletion(poll, 500, 2_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(completion).resolves.toBe(true);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("stops waiting when approval never completes", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(false);
    const completion = waitForPairingCompletion(poll, 200, 450);

    await vi.advanceTimersByTimeAsync(450);

    await expect(completion).resolves.toBe(false);
    expect(poll).toHaveBeenCalledTimes(4);
  });
});
