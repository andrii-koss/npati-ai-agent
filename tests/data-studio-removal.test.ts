import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { DataBackendRepository } from "../apps/agent-api/src/data-studio/repository";
import { DataBackendService } from "../apps/agent-api/src/data-studio/service";
import { registerDataBackendRoutes } from "../apps/agent-api/src/data-studio/routes";

const owner: AuthContext = {workspaceId:"workspace-a",userId:"owner-a",permissions:["business:manage","workspace:read"]};

function harness(failAfterDetach = false) {
  let attached = 2;
  const backend: any = {id:"backend-a",companyId:"company-a",workspaceId:"workspace-a",createdBy:"owner-a",name:"Store DB",status:"ready",removeAfter:null};
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("SELECT id FROM data_backends")) return {rowCount:1,rows:[{id:backend.id}]};
    if (sql.includes("count(*)")) return {rowCount:1,rows:[{count:String(attached)}]};
    if (sql.startsWith("UPDATE projects SET data_backend_id=NULL")) attached = 0;
    if (sql.startsWith("UPDATE data_backends SET status='deleting'")) {
      if (failAfterDetach) throw new Error("injected metadata failure");
      backend.status = "deleting";
      backend.removeAfter ??= (params[1] as Date | undefined)?.toISOString() ?? null;
    }
    return {rowCount:1,rows:[]};
  });
  const release = vi.fn();
  const repository = Object.create(DataBackendRepository.prototype) as DataBackendRepository;
  Object.defineProperty(repository,"pool",{value:{connect:async()=>({query,release})}});
  repository.get = async () => backend;
  repository.environment = async () => ({status:"unavailable"}) as any;
  repository.setRemovalDeadline = vi.fn(async (_ctx, _company, _id, deadline) => {backend.removeAfter = deadline.toISOString();});
  repository.setEnvironment = vi.fn(async () => {});
  repository.deleteSecrets = vi.fn(async () => {});
  repository.remove = vi.fn(async () => {backend.status="deleted";});
  const provisioner = {deprovisionDatabase:vi.fn(async (_backend: unknown, _environment: string) => {})};
  const service = new DataBackendService({getCompany:async()=>({id:"company-a"})} as any,repository,provisioner as any);
  return {repository,service,query,release,backend,provisioner};
}

describe("Data Studio database removal", () => {
  it("keeps the active-project guard without explicit detach authorization", async () => {
    const {repository,query} = harness();
    await expect(repository.beginRemoval(owner,"company-a","backend-a")).rejects.toMatchObject({code:"BACKEND_IN_USE"});
    expect(query.mock.calls.some(([sql])=>sql.startsWith("UPDATE projects"))).toBe(false);
    expect(query.mock.calls.map(([sql])=>sql)).toContain("ROLLBACK");
  });
  it("detaches only this tenant's projects and schedules deletion in the same transaction", async () => {
    const {repository,query,release} = harness();
    const deadline = new Date("2026-11-09T00:00:00Z");
    await repository.beginRemoval(owner,"company-a","backend-a",{detachProjects:true,removeAfter:deadline});
    const calls = query.mock.calls;
    const detachIndex = calls.findIndex(([sql])=>sql.startsWith("UPDATE projects"));
    const removalIndex = calls.findIndex(([sql])=>sql.startsWith("UPDATE data_backends"));
    expect(calls[detachIndex]![1]).toEqual(["workspace-a","company-a","backend-a"]);
    expect(calls[detachIndex]![0]).toContain("company_id=$2 AND data_backend_id=$3");
    expect(detachIndex).toBeLessThan(removalIndex);
    expect(calls[removalIndex]![1]).toEqual(["backend-a",deadline]);
    expect(calls.at(-1)![0]).toBe("COMMIT");
    expect(release).toHaveBeenCalled();
  });
  it("rolls back the detachment when scheduling deletion fails", async () => {
    const {repository,query} = harness(true);
    await expect(repository.beginRemoval(owner,"company-a","backend-a",{detachProjects:true})).rejects.toThrow("injected metadata failure");
    const sql = query.mock.calls.map(([statement])=>statement);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
  });
  it("accepts the confirmed Settings request and detaches before deferred removal", async () => {
    const {service,backend,query} = harness();
    const app = Fastify();
    registerDataBackendRoutes(app,{authenticate:async()=>owner},service);
    try {
      const response = await app.inject({method:"DELETE",url:"/companies/company-a/data-backends/backend-a",payload:{confirmName:"Store DB",detachProjects:true}});
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({deleted:false,deferred:true});
      expect(backend.status).toBe("deleting");
      expect(backend.removeAfter).toBeTruthy();
      expect(query.mock.calls.some(([sql])=>sql.startsWith("UPDATE projects"))).toBe(true);
    } finally {await app.close();}
  });
  it("does not detach any projects when the confirmation name is wrong", async () => {
    const {service,query} = harness();
    await expect(service.remove(owner,"company-a","backend-a","wrong",{detachProjects:true})).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
    expect(query).not.toHaveBeenCalled();
  });
  it("repeated removal preserves the original retention deadline", async () => {
    const {service,backend,query,repository} = harness();
    backend.status="deleting";
    backend.removeAfter="2026-11-09T00:00:00.000Z";
    expect(await service.remove(owner,"company-a","backend-a","Store DB",{detachProjects:true})).toMatchObject({deferred:true,removeAfter:backend.removeAfter});
    expect(query).not.toHaveBeenCalled();
    expect(repository.setRemovalDeadline).not.toHaveBeenCalled();
  });
  it("deletes an already pending database immediately through the Settings API", async () => {
    const {service,backend,repository,provisioner} = harness();
    backend.status="deleting";
    backend.removeAfter="2026-11-09T00:00:00.000Z";
    const app=Fastify();
    registerDataBackendRoutes(app,{authenticate:async()=>owner},service);
    try {
      const response=await app.inject({method:"DELETE",url:"/companies/company-a/data-backends/backend-a",payload:{confirmName:"Store DB",detachProjects:true,immediate:true}});
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({id:"backend-a",deleted:true,deferred:false});
      expect(provisioner.deprovisionDatabase.mock.calls.map(([,env])=>env)).toEqual(["dev","prod"]);
      expect(repository.deleteSecrets).toHaveBeenCalledWith("backend-a");
      expect(repository.remove).toHaveBeenCalledWith(owner,"company-a","backend-a");
      expect(repository.setRemovalDeadline).not.toHaveBeenCalled();
    } finally {await app.close();}
  });
  it("keeps metadata and credentials on a failed physical deletion and allows retry", async () => {
    const {service,backend,repository,provisioner} = harness();
    provisioner.deprovisionDatabase.mockImplementationOnce(async()=>{}).mockImplementationOnce(async()=>{throw new Error("prod database is busy");});
    await expect(service.remove(owner,"company-a","backend-a","Store DB",{immediate:true,detachProjects:true})).rejects.toThrow("prod database is busy");
    expect(backend.status).toBe("deleting");
    expect(repository.deleteSecrets).not.toHaveBeenCalled();
    expect(repository.remove).not.toHaveBeenCalled();
    await expect(service.remove(owner,"company-a","backend-a","Store DB",{immediate:true,detachProjects:true})).resolves.toMatchObject({deleted:true,deferred:false});
    expect(provisioner.deprovisionDatabase.mock.calls.map(([,env])=>env)).toEqual(["dev","prod","dev","prod"]);
    expect(repository.remove).toHaveBeenCalledTimes(1);
  });
});
