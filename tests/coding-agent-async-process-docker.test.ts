import { describe, expect, it } from "vitest";
import { DockerSandboxProvider } from "../apps/agent-api/src/docker-sandbox-provider";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";

describe.skipIf(process.env.NPATI_PROCESS_DOCKER_TESTS !== "1")("Step 3 real Docker producer", () => {
  it("uses one stable identity, bounded output, real exit, and a cancellation tombstone", async () => {
    const docker = (args: string[]) => promisify(execFile)("docker", args, { windowsHide: true, timeout: 30000, maxBuffer: 1000000 });
    const id = randomUUID(), name = `npati-sb-${id}`;
    const scope = { workspaceId: "step3-test", userId: "step3-test", companyId: "step3-test", projectId: "step3-test" };
    const hash = createHash("sha256").update([scope.workspaceId, scope.userId, scope.companyId, scope.projectId].join(":")).digest("hex");
    await docker(["run", "--detach", "--name", name, "--network", "none", "--tmpfs", "/workspace:rw,mode=1777", "--label", `npati.scope=${hash}`, "--label", `npati.sandbox=${id}`, "--entrypoint", "sh", process.env.NPATI_STEP3_TEST_IMAGE ?? "npati-agent-agent-api:latest", "-c", "mkdir -p /workspace; sleep infinity"]);
    try {
      await docker(["exec", name, "sh", "-c", "command -v node && command -v setsid && command -v flock && command -v timeout"]);
      const provider = new DockerSandboxProvider(); const processId = randomUUID();
      const options = { processId, timeoutMs: 10000, outputLimitBytes: 64000 };
      const command = "node -e 'require(\"fs\").appendFileSync(\"count\",\"1\");process.stdout.write(\"a\".repeat(70000));setTimeout(()=>process.exit(7),500)'";
      const first = await provider.startProcess(scope, id, command, options);
      const second = await provider.startProcess(scope, id, command, options);
      expect(first.processId).toBe(processId); expect(second.processId).toBe(processId);
      let result = await provider.getProcessStatus(scope, id, processId);
      for (let attempt = 0; result.status === "running" && attempt < 30; attempt++) { await new Promise((resolve) => setTimeout(resolve, 100)); result = await provider.getProcessStatus(scope, id, processId); }
      expect(result).toMatchObject({ status: "failed", exitCode: 7 });
      const output = await provider.getProcessOutput(scope, id, processId);
      expect(output).toMatchObject({ earliestOffset: 6000, nextOffset: 70000 }); expect(output.output).toHaveLength(64000);
      expect((await docker(["exec", name, "cat", "/workspace/count"])).stdout).toBe("1");
      const cancelled = randomUUID(); expect(await provider.stopProcess(scope, id, cancelled)).toMatchObject({ status: "stopped", exitCode: null });
      expect(await provider.startProcess(scope, id, "node -e 'require(\"fs\").writeFileSync(\"phantom\",\"bad\")'", { ...options, processId: cancelled })).toMatchObject({ status: "stopped", exitCode: null });
      await docker(["exec", name, "test", "!", "-e", "/workspace/phantom"]);
      const live = randomUUID(); await provider.startProcess(scope, id, "node -e 'setInterval(()=>{},1000)'", { ...options, processId: live });
      const stopped = await provider.stopProcess(scope, id, live);
      expect(stopped).toMatchObject({ status: "stopped", exitCode: null });
      expect(await provider.getProcessStatus(scope, id, live)).toMatchObject({ status: "stopped", exitCode: null });
      await expect(provider.getProcessStatus({ ...scope, projectId: "foreign" }, id, live)).rejects.toMatchObject({ code: "sandbox_scope_denied" });
    } finally { await docker(["rm", "--force", name]); }
  }, 60000);
});

