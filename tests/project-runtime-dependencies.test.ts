import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { NextJsAdapter, ViteAdapter } from "../packages/shared/src/website-renderer";
import { createDefaultWebsiteDocument } from "../packages/shared/src/website-schema";
import { createMobileAppScaffold } from "../packages/shared/src/mobile-app-template";

const require = createRequire(import.meta.url);
const { prepareWorkspace, dependencySet } = require("../apps/agent-api/prepare-project-dependencies.cjs");
const profiles = require("../apps/agent-api/project-runtime-profiles.json");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "npati-prepared-deps-")); roots.push(root);
  const toolchain = path.join(root, "toolchain"), workspace = path.join(root, "project");
  await mkdir(path.join(toolchain, "next", "node_modules", "next"), { recursive: true });
  await mkdir(workspace);
  const dependencies = { dependencies: { next: "14.2.35" } };
  const lock = { name: "prepared", version: "0.1.0", lockfileVersion: 3, packages: { "": { name: "prepared", version: "0.1.0", ...dependencies }, "node_modules/next": { version: "14.2.35", integrity: "fixed-profile-integrity" } } };
  await writeFile(path.join(toolchain, "profiles.json"), JSON.stringify({ next: dependencies }));
  await writeFile(path.join(toolchain, "next", "package-lock.json"), JSON.stringify(lock));
  await writeFile(path.join(toolchain, "next", "node_modules", "next", "index.js"), "prepared-module");
  const manifest = { name: "my-project", version: "1.0.0", ...dependencies, scripts: { build: "next build" } };
  await writeFile(path.join(workspace, "package.json"), JSON.stringify(manifest));
  return { toolchain, workspace, manifest, lock };
}
describe("prepared project dependencies", () => {
  it("matches real Website Builder manifests", () => {
    const document = createDefaultWebsiteDocument("Store");
    expect(dependencySet(JSON.parse(new NextJsAdapter().scaffoldProject(document)["package.json"]!))).toEqual(dependencySet(profiles.next));
    expect(dependencySet(JSON.parse(new ViteAdapter().scaffoldProject(document)["package.json"]!))).toEqual(dependencySet(profiles["vite-react"]));
    const mobile = createMobileAppScaffold({ name: "Mobile", slug: "mobile", scheme: "mobile" });
    expect(dependencySet(JSON.parse(mobile.files["package.json"]!))).toEqual(dependencySet(profiles["expo-web"]));
  });
  it("copies prepared modules and lock into project-owned files; ci restores only that project", async () => {
    const { workspace, toolchain } = await fixture();
    expect(await prepareWorkspace(workspace, toolchain, "install")).toBe("next");
    const file = path.join(workspace, "node_modules", "next", "index.js");
    await writeFile(file, "project-modification");
    expect(await readFile(path.join(toolchain, "next", "node_modules", "next", "index.js"), "utf8")).toBe("prepared-module");
    const lock = JSON.parse(await readFile(path.join(workspace, "package-lock.json"), "utf8"));
    expect(lock.name).toBe("my-project"); expect(lock.packages[""].version).toBe("1.0.0");
    expect(await prepareWorkspace(workspace, toolchain, "ci")).toBe("next");
    expect(await readFile(file, "utf8")).toBe("prepared-module");
  });
  it("does not replace an explicit different lockfile or repair a missing ci lockfile", async () => {
    const { workspace, toolchain, lock } = await fixture();
    expect(await prepareWorkspace(workspace, toolchain, "ci")).toBeNull();
    lock.packages["node_modules/next"].version = "14.2.34";
    const content = JSON.stringify(lock);
    await writeFile(path.join(workspace, "package-lock.json"), content);
    expect(await prepareWorkspace(workspace, toolchain, "install")).toBeNull();
    expect(await readFile(path.join(workspace, "package-lock.json"), "utf8")).toBe(content);
  });
  it.each([{ scripts: { postinstall: "node project-install.cjs" } }, { dependencies: { next: "15.0.0" } }, { overrides: { next: "14.2.34" } }, { workspaces: ["packages/*"] }])("uses npm fallback for custom dependency semantics: %j", async (override) => {
    const { workspace, toolchain, manifest } = await fixture();
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ ...manifest, ...override }));
    expect(await prepareWorkspace(workspace, toolchain, "install")).toBeNull();
  });
});
