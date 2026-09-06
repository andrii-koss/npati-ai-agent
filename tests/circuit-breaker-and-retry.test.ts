import { describe, expect, it } from "vitest";
import {
  ProviderCircuitBreaker,
  RetryBackoffRunner,
} from "../apps/agent-api/src/resilience-circuit-breaker";

describe("Provider Circuit Breaker & Lockout Cooldown (ProviderCircuitBreaker)", () => {
  it("trips circuit to OPEN after failure threshold and enters cooldown lockout", () => {
    const cb = new ProviderCircuitBreaker({
      failureThreshold: 3,
      initialCooldownMs: 200,
    });

    const provider = "openai";

    // Initial state: CLOSED
    expect(cb.canAttempt(provider).allowed).toBe(true);
    expect(cb.canAttempt(provider).state).toBe("CLOSED");

    // Record 2 failures (threshold is 3)
    cb.recordFailure(provider);
    cb.recordFailure(provider);
    expect(cb.canAttempt(provider).allowed).toBe(true);
    expect(cb.canAttempt(provider).state).toBe("CLOSED");

    // 3rd failure trips the breaker to OPEN
    cb.recordFailure(provider);
    const openCheck = cb.canAttempt(provider);
    expect(openCheck.allowed).toBe(false);
    expect(openCheck.state).toBe("OPEN");
    expect(openCheck.cooldownRemainingMs).toBeGreaterThan(0);
  });

  it("transitions to HALF_OPEN after cooldown and CLOSED on canary success", async () => {
    const cb = new ProviderCircuitBreaker({
      failureThreshold: 2,
      initialCooldownMs: 50, // Short cooldown for fast test
    });

    const provider = "anthropic";

    cb.recordFailure(provider);
    cb.recordFailure(provider); // Tripped to OPEN
    expect(cb.canAttempt(provider).allowed).toBe(false);

    // Wait for cooldown expiry
    await new Promise((r) => setTimeout(r, 60));

    // Next check should allow probe in HALF_OPEN state
    const probeCheck = cb.canAttempt(provider);
    expect(probeCheck.allowed).toBe(true);
    expect(probeCheck.state).toBe("HALF_OPEN");

    // Successful canary resets circuit to CLOSED
    cb.recordSuccess(provider);
    expect(cb.canAttempt(provider).state).toBe("CLOSED");
    expect(cb.canAttempt(provider).allowed).toBe(true);
  });
});

describe("Retry with Exponential Backoff (RetryBackoffRunner)", () => {
  it("retries transient failures and returns result on success", async () => {
    let callCount = 0;

    const result = await RetryBackoffRunner.executeWithRetry(
      async (attempt) => {
        callCount++;
        if (attempt < 3) {
          throw new Error("429 Too Many Requests");
        }
        return "Success on attempt 3";
      },
      { maxRetries: 3, baseDelayMs: 10, jitter: false }
    );

    expect(result.result).toBe("Success on attempt 3");
    expect(result.attemptsCount).toBe(3);
    expect(callCount).toBe(3);
  });

  it("throws error when max retries are exhausted", async () => {
    await expect(
      RetryBackoffRunner.executeWithRetry(
        async () => {
          throw new Error("500 Internal Server Error");
        },
        { maxRetries: 2, baseDelayMs: 10, jitter: false }
      )
    ).rejects.toThrow("500 Internal Server Error");
  });
});
