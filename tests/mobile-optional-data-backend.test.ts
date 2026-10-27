import { expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import type { DataBackendService } from "../apps/agent-api/src/data-studio/service";
import { resolveMobileDataBackend } from "../apps/agent-api/src/project-orchestrator-scaffold";

const auth: AuthContext = { userId: "mobile-test", workspaceId: "mobile-workspace", permissions: ["business:manage"] };
const service = (backends: unknown[]) => ({ list: vi.fn(async () => backends) }) as unknown as DataBackendService;

it("allows a standalone mobile project when the company has no server database", async () => {
  const backends = service([]);
  await expect(resolveMobileDataBackend(backends, auth, "owned-company", { prompt: "Create an Expo task list with local persistence" })).resolves.toEqual({ backendId: undefined });
  expect(backends.list).toHaveBeenCalledWith(auth, "owned-company");
});

it("rejects an explicit backend outside the company's available ready backends", async () => {
  await expect(resolveMobileDataBackend(service([]), auth, "owned-company", { dataBackendId: "foreign-backend" })).rejects.toMatchObject({ code: "DATA_BACKEND_NOT_FOUND" });
});

it("preserves selection of the company's existing ready shared backend", async () => {
  await expect(resolveMobileDataBackend(service([{ id: "shared", status: "ready" }]), auth, "owned-company", {})).resolves.toEqual({ backendId: "shared" });
  await expect(resolveMobileDataBackend(service([{ id: "one", name: "One", status: "ready" }, { id: "two", name: "Two", status: "ready" }]), auth, "owned-company", {})).resolves.toEqual({ choices: [{ id: "one", name: "One" }, { id: "two", name: "Two" }] });
});
