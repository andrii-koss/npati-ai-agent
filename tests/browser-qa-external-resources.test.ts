import { describe, expect, it } from "vitest";
import { isBlockedExternalResource } from "../apps/agent-api/browser-qa-diagnostics.mjs";

const origin = "http://127.0.0.1:4000";
const failed = "Failed to load resource: net::ERR_FAILED";

describe("browser check and outside hosts it blocks itself", () => {
  it("ignores a photo or stylesheet from another site", () => {
    expect(isBlockedExternalResource(failed, { url: "https://images.unsplash.com/p.jpg" }, origin)).toBe(true);
  });
  it("still reports a missing file of the site itself", () => {
    expect(isBlockedExternalResource(failed, { url: origin + "/styles.css" }, origin)).toBe(false);
  });
  it("still reports a script error and an unknown location", () => {
    expect(isBlockedExternalResource("ReferenceError: a is not defined", { url: "https://cdn.example/a.js" }, origin)).toBe(false);
    expect(isBlockedExternalResource(failed, undefined, origin)).toBe(false);
  });
});
