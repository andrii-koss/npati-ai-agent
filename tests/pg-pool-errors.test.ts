import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type pg from "pg";
import { keepPoolErrorsFromCrashing } from "../apps/agent-api/src/pg-pool-errors";

describe("keepPoolErrorsFromCrashing", () => {
  class FakePool extends EventEmitter {}
  keepPoolErrorsFromCrashing(FakePool as unknown as typeof pg.Pool, (message) => warnings(message));
  const warnings = vi.fn();

  it("does not throw when an idle connection breaks and nobody listens", () => {
    expect(() => new FakePool().emit("error", new Error("terminating connection"))).not.toThrow();
    expect(warnings).toHaveBeenCalledWith("postgres_idle_connection_lost: terminating connection");
  });

  it("still hands the error to a listener", () => {
    const pool = new FakePool();
    const listener = vi.fn();
    pool.on("error", listener);
    pool.emit("error", new Error("x"));
    expect(listener).toHaveBeenCalledOnce();
  });
});
