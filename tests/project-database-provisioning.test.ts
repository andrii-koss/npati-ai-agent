import { describe, expect, it, vi } from "vitest";
import { DataBackendService } from "../apps/agent-api/src/data-studio/service";
import type { AuthContext } from "@npati/workspace";
const locks=vi.hoisted(()=>new Set<string>());
vi.mock("pg",()=>({Client:class {
 async connect(){} async end(){}
 async query(sql:string,args:string[]){const key=args[0]!;if(sql.includes("try_advisory_lock")){const locked=!locks.has(key);if(locked)locks.add(key);return {rows:[{locked}]};}locks.delete(key);return {rows:[]};}
}}));
const ctx:AuthContext={workspaceId:"tenant",userId:"owner",permissions:["workspace:read","workspace:write"]};
function fixture(){
 const project={id:"project",status:"ready",dataBackendId:null as string|null};
 const backend={id:"backend",name:"Orders",status:"provisioning",secret:"never return this"};
 const environments={dev:{status:"provisioning"},prod:{status:"provisioning"}};
 const store={getProject:vi.fn(async()=>project),getCompany:vi.fn(async()=>({id:"company"}))};
 const repository={pool:{options:{connectionString:"postgres://test"}},reserveForProject:vi.fn(async()=>{project.dataBackendId=backend.id;return backend;}),get:vi.fn(async()=>backend),environment:vi.fn(async(_a,_b,_c,env:"dev"|"prod")=>environments[env]),setEnvironment:vi.fn(async(_a,_b,_c,env:"dev"|"prod",patch:object)=>Object.assign(environments[env],patch)),setStatus:vi.fn(async(_a,_b,_c,status:string)=>{backend.status=status;})};
 const provisioner={provisionDatabase:vi.fn(async(_backend:unknown,env:"dev"|"prod")=>{environments[env].status="ready";}),resumeRuntime:vi.fn(async()=>{})};
 const service=new DataBackendService(store as never,repository as never,provisioner as never);
 return {service,store,repository,provisioner,project};
}
describe("on-demand database provisioning",()=>{
 it("creates only on demand, reuses its reservation and never returns credentials",async()=>{
  const f=fixture();expect(f.repository.reserveForProject).not.toHaveBeenCalled();
  expect(await f.service.ensureForProject(ctx,"company","project","Orders")).toEqual({created:true,backend:{id:"backend",name:"Orders",status:"ready"}});
  expect((await f.service.ensureForProject(ctx,"company","project","Another name")).created).toBe(false);
  expect(f.repository.reserveForProject).toHaveBeenCalledTimes(1);expect(f.provisioner.provisionDatabase).toHaveBeenCalledTimes(2);
 });
 it("resumes an interrupted reservation instead of creating a second database",async()=>{
  const f=fixture();f.provisioner.provisionDatabase.mockRejectedValueOnce(Error("provisioning interrupted"));
  await expect(f.service.ensureForProject(ctx,"company","project","Orders")).rejects.toThrow("interrupted");
  expect((await f.service.ensureForProject(ctx,"company","project","Orders")).created).toBe(true);
  expect(f.repository.reserveForProject).toHaveBeenCalledTimes(1);expect(f.provisioner.provisionDatabase).toHaveBeenCalledTimes(3);
 });
 it("refuses concurrent provisioning, then permits retries after the owner finishes",async()=>{
  const f=fixture();let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>release=resolve);
  f.provisioner.provisionDatabase.mockImplementationOnce(async()=>{await gate;});
  const first=f.service.ensureForProject(ctx,"company","project","Orders");
  await vi.waitFor(()=>expect(f.repository.reserveForProject).toHaveBeenCalledTimes(1));
  await expect(f.service.ensureForProject(ctx,"company","project","Orders")).rejects.toMatchObject({code:"DATABASE_CREATION_BUSY"});
  release();await first;
  expect((await f.service.ensureForProject(ctx,"company","project","Orders")).created).toBe(false);
  expect(f.repository.reserveForProject).toHaveBeenCalledTimes(1);
 });
 it("authorizes before creating a connection or reserving anything",async()=>{
  const f=fixture();f.store.getProject.mockRejectedValue(Error("Project not found"));
  await expect(f.service.ensureForProject({...ctx,userId:"foreign"},"company","project","Orders")).rejects.toThrow();
  expect(f.repository.reserveForProject).not.toHaveBeenCalled();expect(f.provisioner.provisionDatabase).not.toHaveBeenCalled();
 });
});
