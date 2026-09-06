import { describe, expect, it } from "vitest";
import {
  RelayDeployerOrchestrator,
  MultiRuntimeContainerManager,
  MultiEngineMemoryOrchestrator,
} from "../apps/agent-api/src/infrastructure-deployers-and-memory-engines";

describe("Relay Deployer Orchestrator (Relay deployers)", () => {
  it("provisions edge relays with mTLS and manages active lifecycle", () => {
    const orchestrator = new RelayDeployerOrchestrator();

    const deployment = orchestrator.deploy("flyio", {
      region: "ams",
      relayName: "relay-eu-central",
      enableMtls: true,
    });

    expect(deployment.status).toBe("deployed");
    expect(deployment.endpointUrl).toContain("flyio.npati.net");
    expect(deployment.mtlsFingerprint).toContain("sha256_");

    expect(orchestrator.listDeployments().length).toBe(1);

    const deleted = orchestrator.teardown(deployment.relayId);
    expect(deleted).toBe(true);
    expect(orchestrator.listDeployments().length).toBe(0);
  });
});

describe("Multi-Runtime Container Manager (Docker / Podman / Bun / Nix)", () => {
  it("executes code in isolated multi-runtime environments", () => {
    const manager = new MultiRuntimeContainerManager();

    const dockerRes = manager.execute("docker", "npm run build", { image: "node:22-alpine" });
    expect(dockerRes.output).toContain("[docker:node:22-alpine]");
    expect(dockerRes.exitCode).toBe(0);

    const podmanRes = manager.execute("podman", "cargo test", { rootless: true });
    expect(podmanRes.output).toContain("[podman:rootless=true]");

    const bunRes = manager.execute("bun", "bun index.ts");
    expect(bunRes.output).toContain("[bun-runtime");

    const nixRes = manager.execute("nix", "nix develop");
    expect(nixRes.output).toContain("[nix-shell:flake]");
  });
});

describe("Multi-Engine Memory Orchestrator (Multiple memory engines)", () => {
  it("manages multi-backend vector stores with replica synchronization", () => {
    const orchestrator = new MultiEngineMemoryOrchestrator();

    expect(orchestrator.listEngines()).toEqual(["pgvector", "qdrant", "inmemory"]);

    const saveRes = orchestrator.store({
      id: "doc_vector_1",
      content: "Architecture design guidelines",
      embedding: [0.1, 0.2, 0.3],
    }, "pgvector");

    expect(saveRes.storedEngines).toContain("pgvector");
    expect(saveRes.storedEngines).toContain("inmemory"); // replica synced

    // Query pgvector
    const q1 = orchestrator.query("pgvector");
    expect(q1.engineUsed).toBe("pgvector");
    expect(q1.resultsCount).toBe(1);

    // Query inmemory
    const q2 = orchestrator.query("inmemory");
    expect(q2.engineUsed).toBe("inmemory");
    expect(q2.resultsCount).toBe(1);
  });
});
