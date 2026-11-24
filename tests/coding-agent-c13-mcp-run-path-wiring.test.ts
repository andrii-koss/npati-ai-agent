import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import { buildApp } from "../apps/agent-api/src/app";
import { readApiSource, readApiSources } from "./lib/api-source";

/**
 * C13 (owner requirement: **fresh-process MCP acceptance**) — the wiring that makes the run path discover.
 *
 * The behaviour of discovery is pinned by `coding-agent-c13-mcp-run-path.test.ts`. This suite pins the two
 * things a per-module suite structurally cannot see, because it is about the **composed** application:
 *
 *  1. the run path is the discovery entry point. `app.ts` hands the **same** object to the runner
 *     (`runtimeCapabilities`) and to the Capability Inspector route (`discoverRuntimeMcpCapabilities`), so one
 *     discovery system serves both and neither depends on the other. The Inspector route is re-pointed, not
 *     duplicated: it no longer calls `discoverMcpRuntimeCapabilities` directly.
 *  2. the ordering inside the runner is the owner's acceptance order — discovery happens **before** the
 *     model-visible tool list is built and **before** the ExecutionSnapshot that pins the runtime manifest, and
 *     neither the runner nor the MCP run-path module can reach the Inspector at all.
 *
 * The negative control for the source guards is built in: a regex that matched nothing would make them vacuous,
 * so each guard asserts its anchor exists and only then asserts the ordering.
 */

const appSource = readApiSources();
/** app.ts alone: some guards are about what the entry point itself no longer does. */
const appOnly = readApiSource("app.ts");
const runnerSource = readFileSync(new URL("../apps/agent-api/src/coding-agent-runner.ts", import.meta.url), "utf8");
const runPathSource = readFileSync(new URL("../apps/agent-api/src/mcp-run-path.ts", import.meta.url), "utf8");

const context = (): AuthContext => ({
  workspaceId: "workspace-context",
  userId: "user-context",
  permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"],
});

/** One real application, composed exactly the way `coding-agent-c10-route-auth-wiring.test.ts` composes it. */
function realApp(extraPermissions: string[] = []) {
  const authProvider: AuthProvider = { authenticate: async () => { const base = context(); return { ...base, permissions: [...base.permissions, ...extraPermissions] }; } };
  const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
  const aiEngine = {
    chat: async () => ({ content: "ok" }),
    stream: async function* () { yield "ok"; },
    listModels: async () => [],
    getModel: async () => undefined,
    executeTool: async () => ({}),
    searchMemory: async () => [],
    saveMemory: async () => undefined,
    getCapabilities: async () => ["chat"],
    healthCheck: async () => ({ status: "ok" as const }),
  } as unknown as AIEngine;
  return buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider, marketplace, aiEngine });
}

describe("security-gate: C13 MCP run path wiring — one discovery system, reachable by a run", () => {
  it("hands the runner the same discovery object the Inspector route uses", () => {
    // The run path is constructed once — a second construction would be a second discovery system. (The call site is matched through its assignment so that the module's own declaration is not counted.)
    const constructions = [...readApiSource("app-code-engine-wiring.ts").matchAll(/createMcpRuntimeRunPath\(/g)];
    expect(constructions).toHaveLength(1);

    // The runner receives it as its runtime provider port …
    const runnerWiring = /runtimeCapabilities:\s*mcpRunPath\s*,/.test(appSource);
    expect(runnerWiring).toBe(true);

    // … and the Inspector route's function **is** that object's `discover` (re-pointed, not re-implemented).
    expect(/const discoverRuntimeMcpCapabilities = \(ctx: AuthContext, companyId: string\) =>\s*\n\s*mcpRunPath\.discover\(ctx, companyId\)/.test(appSource)).toBe(true);
    // The route's own discovery call is gone: `discoverMcpRuntimeCapabilities(...)` is no longer invoked in
    // `app.ts` (the import was removed with it), so the two entry points cannot drift apart.
    expect(/discoverMcpRuntimeCapabilities\(/.test(appOnly)).toBe(false);
    // …while the Inspector surface itself is untouched and still offers the combined view.
    expect(appSource).toContain('request.query.includeRuntime === "true"');
    expect(appSource).toContain("buildCombinedCapabilityView(mcpRuntimeCapabilities.overlayFor(tenant), capabilityInspector)");
  });

  it("discovers before the model-visible tool list and before the ExecutionSnapshot", () => {
    const discovery = runnerSource.indexOf("this.ports.runtimeCapabilities.prepareForRun(");
    const toolList = runnerSource.indexOf("const tools = this.toolDescriptors(");
    const snapshot = runnerSource.indexOf("const snapshot = await this.snapshot.create({");
    /**
     * The loop's own model call, not the file's first one: the self-review pass (`runSelfReview`) also calls the
     * engine and its method is defined earlier in the file. The search therefore starts at the loop.
     */
    const loopStart = runnerSource.indexOf("for (;;) {");
    const firstModelCall = runnerSource.indexOf("result = await this.ports.engine.chat({", loopStart);
    // Every anchor must exist, otherwise the ordering below would be comparing -1 with -1.
    expect(discovery).toBeGreaterThan(0);
    expect(toolList).toBeGreaterThan(0);
    expect(snapshot).toBeGreaterThan(0);
    expect(loopStart).toBeGreaterThan(snapshot);
    expect(firstModelCall).toBeGreaterThan(loopStart);

    expect(discovery).toBeLessThan(toolList);
    expect(toolList).toBeLessThan(snapshot);
    expect(snapshot).toBeLessThan(firstModelCall);
    // The discovery happens exactly once per run: no second call site, and no call inside the tool loop.
    expect([...runnerSource.matchAll(/runtimeCapabilities\.prepareForRun\(/g)]).toHaveLength(1);
    expect([...runnerSource.matchAll(/const tools = this\.toolDescriptors\(session, toolOptions\)/g)]).toHaveLength(1);
  });

  it("keeps discovery independent of the Inspector, in both the runner and the MCP run path", () => {
    for (const source of [runnerSource, runPathSource]) {
      expect(source.includes("capabilities/inspect")).toBe(false);
      expect(source.includes("CapabilityInspectorService")).toBe(false);
      expect(source.includes("capabilityInspector")).toBe(false);
    }
    // Non-vacuity: the same check on `app.ts` (which legitimately registers the Inspector) does find it, so the
    // scan above is a real measurement rather than a broken pattern.
    expect(appSource.includes("capabilities/inspect")).toBe(true);
    expect(appSource.includes("CapabilityInspectorService")).toBe(true);
  });

  it("pins the runtime manifest into the recorded bundle (the writer the recorder member never had)", () => {
    // The recorder's `runtimeMcpManifest` member existed with no writer, so the replay guard could only pass.
    expect(/runtimeMcpManifest:\s*readRuntimeMcpManifest\(\{/.test(appSource)).toBe(true);
    // One definition of the pinned manifest, shared by the snapshot source, the bundle and the replay route.
    expect([...appSource.matchAll(/readRuntimeMcpManifest\(/g)].length).toBeGreaterThanOrEqual(3);
  });

  it("composes a fresh application whose Inspector still answers over the shared discovery", async () => {
    // The Inspector is an administrator tool (ordinary accounts get 403, see developer-capability-inspector.test.ts).
    const app = realApp(["admin:all"]);
    try {
      // The static report is unchanged …
      const staticReport = await app.inject({ method: "GET", url: "/capabilities/inspect" });
      expect(staticReport.statusCode).toBe(200);
      expect(staticReport.json().counts.all).toBeGreaterThan(0);

      // … and `includeRuntime=true` runs the **shared** discovery for the tenant. With no Integration configured
      // in this fresh process the answer is the honest empty report, not an error and not stale data.
      const combined = await app.inject({
        method: "GET",
        url: "/capabilities/inspect?includeRuntime=true&companyId=company-1",
      });
      expect(combined.statusCode).toBe(200);
      const runtime = combined.json().runtime as Record<string, unknown>;
      expect(runtime).toBeDefined();
      const discovery = runtime.discovery as Record<string, unknown>;
      // The composed app binds its existing integration repository; an empty repository publishes no tools.
      expect(discovery).not.toHaveProperty("error");
      expect(discovery).toMatchObject({ publishedTools: 0, connections: [] });
      expect((runtime.items as unknown[]).length).toBe(0);
      // The static numbers the combined view reports are the Inspector's own, untouched by the runtime source.
      const counts = runtime.counts as Record<string, number>;
      expect(counts.overlayTotal).toBe(0);
      expect(counts.combinedTotal).toBe(counts.staticTotal);
    } finally {
      await app.close();
    }
  });
});
