import { expect, it } from "vitest";
import { captureNativeThumbnail, needsNativeThumbnail } from "../apps/agent-api/src/native-project-thumbnail";

// V6 step 09: mobile apps and Pygame games never got a Projects thumbnail; only websites had a post-run screenshot.
const done = { status: "completed", summary: { filesChanged: ["App.tsx"] } };
it("photographs a changed mobile app or Pygame game, and nothing else", () => {
  expect(needsNativeThumbnail({ type: "mobile_app", framework: "Expo" }, done)).toBe(true);
  expect(needsNativeThumbnail({ kind: "mobile_app", framework: "Flutter" }, done)).toBe(true);
  expect(needsNativeThumbnail({ type: "code_project", kind: "game", framework: "Pygame" }, done)).toBe(true);
  expect(needsNativeThumbnail({ type: "code_project", kind: "website", framework: "React + Vite" }, done)).toBe(false);
  expect(needsNativeThumbnail({ type: "mobile_app" }, { status: "failed", summary: { filesChanged: ["a"] } })).toBe(false);
  expect(needsNativeThumbnail({ type: "mobile_app" }, { status: "completed", summary: { filesChanged: [] } })).toBe(false);
});

it("starts a stopped Preview before the screenshot, reuses a running one, and never throws", async () => {
  const calls: string[] = [];
  await captureNativeThumbnail({ project: { status: "ready" }, startPreview: async () => { calls.push("start"); }, screenshot: async () => { calls.push("shot"); }, warn: () => calls.push("warn") });
  await captureNativeThumbnail({ project: { status: "previewing" }, startPreview: async () => { calls.push("start"); }, screenshot: async () => { calls.push("shot"); }, warn: () => calls.push("warn") });
  await captureNativeThumbnail({ project: { status: "ready" }, startPreview: async () => { throw new Error("503"); }, screenshot: async () => { calls.push("shot"); }, warn: () => calls.push("warn") });
  expect(calls).toEqual(["start", "shot", "shot", "warn"]);
});
