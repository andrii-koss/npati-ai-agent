// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSettingsSnapshots, readSettingsSnapshot, requestSettingsRead, writeSettingsSnapshot } from "./settings-page-cache";
import { loadCompanyScopes } from "./company-scope";
const auth = vi.hoisted(() => ({ token: "settings-user-a" }));
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => auth.token }));
beforeEach(() => { auth.token = "settings-user-a"; clearSettingsSnapshots(); sessionStorage.clear(); });
afterEach(() => clearSettingsSnapshots());
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

it("shows a ready company before another company finishes and keeps the concurrency bound", async () => {
  const slow = deferred<string>();
  const frames: string[][] = [];
  const load = loadCompanyScopes(["slow", "fast"], id => id === "slow" ? slow.promise : Promise.resolve("fast"), { onProgress: rows => frames.push([...rows]) });
  await vi.waitFor(() => expect(frames.some(frame => frame.includes("fast"))).toBe(true));
  expect(frames.every(frame => !frame.includes("slow"))).toBe(true);
  slow.resolve("slow");
  expect(await load).toEqual(["slow", "fast"]);
  let active = 0, peak = 0;
  await loadCompanyScopes(Array.from({ length: 12 }, (_, index) => String(index)), async id => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return id;
  });
  expect(peak).toBe(4);
});

it("keeps all cached records visible throughout a partial refresh", async () => {
  const slow = deferred<string>(); const frames: string[][] = [];
  const load = loadCompanyScopes(["slow", "fast"], id => id === "slow" ? slow.promise : Promise.resolve("new-fast"), {
    key: "records", initial: ["cached-slow", "cached-fast"], onProgress: rows => frames.push([...rows]),
  });
  await vi.waitFor(() => expect(frames.some(frame => frame.includes("new-fast"))).toBe(true));
  expect(frames.every(frame => frame.length === 2 && frame.includes("cached-slow"))).toBe(true);
  slow.resolve("new-slow"); await load;
  expect(frames.at(-1)).toEqual(["new-slow", "new-fast"]);
});

it("deduplicates in-flight reads, exposes the cached snapshot synchronously and still refreshes later", async () => {
  const response = deferred<string[]>(); const fetcher = vi.fn(() => response.promise);
  const first = requestSettingsRead("code:all", fetcher), second = requestSettingsRead("code:all", fetcher);
  response.resolve(["project"]); await Promise.all([first, second]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(readSettingsSnapshot("code:all")).toEqual(["project"]);
  await requestSettingsRead("code:all", async () => ["fresh"]);
  expect(readSettingsSnapshot("code:all")).toEqual(["fresh"]);
});

it("isolates account snapshots and rejects responses from an obsolete cache generation", async () => {
  writeSettingsSnapshot("email:all", ["private-a"]);
  auth.token = "settings-user-b";
  expect(readSettingsSnapshot("email:all")).toBeUndefined();
  const response = deferred<string[]>(); const old = requestSettingsRead("email:all", () => response.promise);
  clearSettingsSnapshots();
  response.resolve(["obsolete"]); await old;
  expect(readSettingsSnapshot("email:all")).toBeUndefined();
});

it("stops scheduling companies when the page is left", async () => {
  let active = true; const response = deferred<string>(); const fetcher = vi.fn(() => response.promise);
  const load = loadCompanyScopes(["1", "2", "3", "4", "5", "6"], fetcher, { isActive: () => active });
  active = false; response.resolve("finished"); await load;
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("does not publish a previous account's late company records", async () => {
  const response = deferred<string>(); const publish = vi.fn();
  const load = loadCompanyScopes(["company-a"], () => response.promise, { key: "private", onProgress: publish });
  auth.token = "settings-user-b";
  response.resolve("private-record-a");
  await expect(load).rejects.toMatchObject({ name: "AbortError" });
  expect(publish).not.toHaveBeenCalled();
});
