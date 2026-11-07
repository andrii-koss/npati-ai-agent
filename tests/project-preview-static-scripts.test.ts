import { describe, expect, it } from "vitest";
import { detectProjectStack } from "../apps/agent-api/src/project-preview-stack";

const detect = (files: Record<string, string>) => detectProjectStack(Object.keys(files).map((path) => ({ path })), async (path) => files[path] ?? "");

describe("Preview of a plain HTML page with a package.json", () => {
  it("serves the files itself when the scripts only run a static server (E2E G5)", async () => {
    const stack = await detect({ "index.html": "<canvas></canvas>", "game.js": "", "package.json": JSON.stringify({ scripts: { start: "npx --yes serve@14 -l 3000 .", dev: "npx --yes serve@14 -l 3000 ." } }) });
    expect(stack).toMatchObject({ framework: "static", command: "python3 -m http.server $PORT --bind 0.0.0.0" });
  });
  it("keeps a real dev script", async () => {
    const stack = await detect({ "index.html": "", "server.js": "", "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }) });
    expect(stack).toMatchObject({ framework: "custom", command: "npm run dev" });
  });
  it("keeps http-server in a project without index.html in the root", async () => {
    const stack = await detect({ "public/index.html": "", "package.json": JSON.stringify({ scripts: { start: "http-server public" } }) });
    expect(stack.framework).toBe("custom");
  });
});
