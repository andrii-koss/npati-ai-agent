import { describe, expect, it } from "vitest";
import {
  OmnirouteRadar,
  VideoGenerationPipeline,
  RemoteCliContextManager,
} from "../apps/agent-api/src/radar-videogen-remote-cli";

describe("OmniRoute Radar (OmniRoute Radar)", () => {
  it("computes provider health, average latency, and detects outages", () => {
    const radar = new OmnirouteRadar();

    // Provider 1: Healthy
    for (let i = 0; i < 10; i++) {
      radar.recordProbe("anthropic", "claude-3-7-sonnet", 250, true);
    }

    // Provider 2: Outage (< 50% success)
    for (let i = 0; i < 10; i++) {
      radar.recordProbe("unstable-provider", "model-x", 1500, i < 3); // 30% success
    }

    const matrix = radar.getHealthMatrix();
    expect(matrix.length).toBe(2);

    const anthropic = matrix.find((m) => m.provider === "anthropic");
    expect(anthropic?.status).toBe("healthy");
    expect(anthropic?.successRate).toBe(1.0);
    expect(anthropic?.averageLatencyMs).toBe(250);

    const unstable = matrix.find((m) => m.provider === "unstable-provider");
    expect(unstable?.status).toBe("outage");
    expect(unstable?.successRate).toBe(0.3);
  });
});

describe("Video Generation Pipeline (Video generation)", () => {
  it("manages video generation job lifecycle from pending to completion", () => {
    const pipeline = new VideoGenerationPipeline();

    const job = pipeline.createJob({
      prompt: "Cinematic flythrough of a futuristic server room with green neon lights",
      durationSeconds: 10,
      resolution: "1080p",
      engine: "runway-gen-3",
    });

    expect(job.status).toBe("processing");
    expect(job.resolution).toBe("1080p");

    const completed = pipeline.completeJob(
      job.jobId,
      "https://cdn.npati.io/artifacts/videos/server_room_future.mp4"
    );

    expect(completed.status).toBe("completed");
    expect(completed.videoUrl).toContain(".mp4");
  });
});

describe("Remote CLI Context Manager (Remote CLI contexts)", () => {
  it("connects remote server context and executes commands remotely", () => {
    const manager = new RemoteCliContextManager();

    const host = manager.connectHost({
      hostId: "prod-db-node-01",
      hostname: "192.168.1.150",
      user: "ubuntu",
      port: 2222,
    });

    expect(host.status).toBe("active");
    expect(manager.listHosts().length).toBe(1);

    const exec = manager.execute("prod-db-node-01", "docker ps");
    expect(exec.exitCode).toBe(0);
    expect(exec.stdout).toContain("[ubuntu@192.168.1.150]$ docker ps");
  });
});
