import { describe, expect, it, vi } from "vitest";
import { createSharedRuntimeReadiness } from "../apps/agent-api/src/shared-runtime-readiness";

function fixture() {
  let time = 0;
  const isolation = vi.fn(async (): Promise<string | null> => "namespaces:verified");
  const proxy = vi.fn(async () => true), network = vi.fn(async () => true);
  return { isolation, proxy, network, advance: (ms: number) => { time += ms; },
    runner: createSharedRuntimeReadiness({ isolation, proxy, network }, () => time) };
}
describe("shared runner readiness cache", () => {
  it("caches only the isolation proof for two seconds and checks live network/proxy each time", async () => {
    const f = fixture();
    await f.runner.check(); f.advance(1999); await f.runner.check();
    expect(f.isolation).toHaveBeenCalledTimes(1);
    expect(f.network).toHaveBeenCalledTimes(2); expect(f.proxy).toHaveBeenCalledTimes(2);
    f.advance(1); await f.runner.check(); expect(f.isolation).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent checks, including expired probes", async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 20 }, () => f.runner.check()));
    expect(f.isolation).toHaveBeenCalledTimes(1); expect(f.network).toHaveBeenCalledTimes(1);
    f.advance(2000);
    await Promise.all(Array.from({ length: 20 }, () => f.runner.check()));
    expect(f.isolation).toHaveBeenCalledTimes(2); expect(f.network).toHaveBeenCalledTimes(2);
  });
  it("does not cache failed probes or thrown errors", async () => {
    const f = fixture();
    f.isolation.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("blocked"));
    expect((await f.runner.check()).isolation).toBeNull();
    expect((await f.runner.check()).isolation).toBeNull();
    expect((await f.runner.check()).isolation).toBe("namespaces:verified");
    expect(f.isolation).toHaveBeenCalledTimes(3);
  });
  it.each(["proxy", "network"] as const)("discards cached isolation immediately after a %s failure", async key => {
    const f = fixture(); await f.runner.check();
    f[key].mockResolvedValueOnce(false);
    expect((await f.runner.check())[key]).toBe(false);
    await f.runner.check(); expect(f.isolation).toHaveBeenCalledTimes(2);
  });
  it("discards an in-flight proof after a command failure and cannot repopulate its cache", async () => {
    const f = fixture(); let resolve!: (value: string) => void;
    f.isolation.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    const old = f.runner.check(); f.runner.invalidate();
    await f.runner.check(); resolve("namespaces:stale");
    expect((await old).isolation).toBe("namespaces:verified");
    expect((await f.runner.check()).isolation).toBe("namespaces:verified");
    expect(f.isolation).toHaveBeenCalledTimes(2);
  });
  it("starts cold in a new runner instance", async () => {
    const f = fixture(); await f.runner.check();
    const restarted = createSharedRuntimeReadiness(f);
    await restarted.check(); expect(f.isolation).toHaveBeenCalledTimes(2);
  });
});
